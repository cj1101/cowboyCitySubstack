/**
 * Pendings at runtime (Phase 2 brief §7): the Action-Gated Ripening
 * predicate, the claim/release bookkeeping, and the per-wake ripeness
 * scan.
 *
 * THE CAUSALITY INVARIANT lives here as much as in the rules: the scan
 * exists only as `scanRipeness`, called only from the dispatcher, inside
 * a wake a player action caused (P2-G2 asserts both by construction and
 * by import-graph check). Nothing in this module is reachable from a
 * timer, and the wall clock is only ever a FLOOR: `eligibleAt` can make
 * a pending wait, never make anything happen.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  where,
  type Firestore,
} from "firebase/firestore";
import {
  PENDING_MAX_ATTEMPTS,
  SCAN_EVALUATE_CAP,
  SCAN_RIPEN_CAP,
  type PreparedPayload,
} from "./state";
import { evaluatePrecondition, type StructuredPrecondition } from "./rules/pendingRules";
import {
  buildSnapshot,
  collectRipeningReadPaths,
  resolveRipening,
  resolveVoiding,
  type DocReader,
} from "./resolver";
import { CommitError, commitResolution } from "./committer";
import type { BaselineRegistry } from "./baseline/registry";

// ---------------------------------------------------------------------------
// The AGR predicate (Felix N1, §7.3) — pure.
// ---------------------------------------------------------------------------

export interface RipenessView {
  currentSeq: number;
  nowIso: string;
  /** cityId -> the city's standing activity seq (its doc's lastChangedSeq;
   * the per-city "something happened here" marker in Phase 2 data). */
  cityActivitySeq: ReadonlyMap<string, number>;
  docByPath: (path: string) => Record<string, unknown> | null;
}

export type RipenessVerdict =
  | { state: "ripe" }
  | { state: "waiting"; blockers: string[] }
  | { state: "void"; reason: string };

export function evaluateRipeness(
  pending: Record<string, unknown>,
  view: RipenessView
): RipenessVerdict {
  const condition = pending.ripenCondition as Record<string, unknown>;
  const blockers: string[] = [];

  // (a) realm sequence condition — the stored requiredSeq, never recomputed.
  const requiredSeq = condition.requiredSeq as number;
  if (view.currentSeq < requiredSeq) {
    blockers.push(`Log at seq ${view.currentSeq}, needs ${requiredSeq}`);
  }
  // (b) wall-clock floor only — passage of time alone never ripens.
  const eligibleAt = condition.eligibleAt as
    | { toDate?: () => Date }
    | string
    | Date
    | null;
  const eligibleIso =
    typeof eligibleAt === "string"
      ? eligibleAt
      : eligibleAt instanceof Date
        ? eligibleAt.toISOString()
        : eligibleAt && typeof eligibleAt.toDate === "function"
          ? eligibleAt.toDate().toISOString()
          : null;
  if (eligibleIso && view.nowIso < eligibleIso) {
    blockers.push(`wall floor ${eligibleIso} not reached`);
  }
  // (c) required action: activity in one of the listed cities SINCE the
  // pending was created (its createdAtSeq).
  const cities = (condition.requiresActionInCities as string[] | undefined) ?? [];
  const createdAtSeq = pending.createdAtSeq as number;
  if (cities.length > 0) {
    const acted = cities.some(
      (cityId) => (view.cityActivitySeq.get(cityId) ?? 0) > createdAtSeq
    );
    if (!acted) blockers.push(`no action yet in any of: ${cities.join(", ")}`);
  }
  // (d) structured preconditions — a false "void" clause ends the pending
  // as a logged world outcome, not an error.
  const preconditions = (condition.preconditions as StructuredPrecondition[] | undefined) ?? [];
  for (const pc of preconditions) {
    const result = evaluatePrecondition(pc, view.docByPath(pc.path));
    if (result === "void") {
      return {
        state: "void",
        reason: `precondition on ${pc.path}${pc.field ? `#${pc.field}` : ""} no longer holds (onFalse: void)`,
      };
    }
    if (result === false) {
      blockers.push(`precondition unmet: ${pc.path}${pc.field ? `#${pc.field}` : ""}`);
    }
  }
  return blockers.length > 0 ? { state: "waiting", blockers } : { state: "ripe" };
}

// ---------------------------------------------------------------------------
// Claims (bookkeeping only — no seq, no Log entry; brief §7.4). The claim
// is owned by the committer identity, so claims run through the modular
// SDK under its rules-bound writes.
// ---------------------------------------------------------------------------

function pendingRef(db: Firestore, pendingId: string) {
  return doc(db, "sim_pending_consequences", pendingId);
}

export async function claimPending(
  db: Firestore,
  pendingId: string,
  opts: { cycleId: string; leaseId: string; now: string; leaseMinutes?: number }
): Promise<Record<string, unknown> | null> {
  const leaseMinutes = opts.leaseMinutes ?? 10;
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(pendingRef(db, pendingId));
    if (!snap.exists()) return null;
    const pending = snap.data() as Record<string, unknown>;
    const claim = pending.claim as { leaseExpiresAt?: { toDate?: () => Date } } | null;
    if (pending.status === "ripening-claimed") {
      const leaseLive =
        claim?.leaseExpiresAt &&
        typeof claim.leaseExpiresAt.toDate === "function" &&
        claim.leaseExpiresAt.toDate().getTime() > Date.parse(opts.now);
      if (leaseLive) return null; // a live lease is held elsewhere
      // An expired claim is claimable again at this wake (§7.4.1).
    } else if (pending.status !== "pending") {
      return null;
    }
    const claimed: Record<string, unknown> = {
      ...pending,
      status: "ripening-claimed",
      claim: {
        cycleId: opts.cycleId,
        leaseId: opts.leaseId,
        claimedAt: new Date(opts.now),
        leaseExpiresAt: new Date(Date.parse(opts.now) + leaseMinutes * 60_000),
      },
      stateVersion: (pending.stateVersion as number) + 1,
      updatedAt: new Date(opts.now),
    };
    tx.set(pendingRef(db, pendingId), claimed);
    return claimed;
  });
}

export async function releasePendingClaim(
  db: Firestore,
  pendingId: string,
  opts: { leaseId: string; now: string; failureCode?: string }
): Promise<void> {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pendingRef(db, pendingId));
    if (!snap.exists()) return;
    const pending = snap.data() as Record<string, unknown>;
    const claim = pending.claim as { leaseId?: string } | null;
    if (pending.status !== "ripening-claimed" || claim?.leaseId !== opts.leaseId) return;
    const attempts = (pending.attempts as number) + (opts.failureCode ? 1 : 0);
    tx.set(pendingRef(db, pendingId), {
      ...pending,
      status: "pending",
      claim: null,
      attempts,
      needsAttention: attempts >= PENDING_MAX_ATTEMPTS ? true : pending.needsAttention,
      ...(opts.failureCode
        ? { lastFailure: { at: new Date(opts.now), code: opts.failureCode } }
        : {}),
      stateVersion: (pending.stateVersion as number) + 1,
      updatedAt: new Date(opts.now),
    });
  });
}

// ---------------------------------------------------------------------------
// The ripeness scan — one pass per committed player action (brief §7.3).
// A RIPENING never triggers another scan pass: the candidate set is a
// snapshot taken at pass start, so children created during the pass are
// evaluated at the NEXT player-caused wake, never this one.
// ---------------------------------------------------------------------------

export interface ScanDeps {
  committerDb: Firestore;
  baselineRegistry: BaselineRegistry;
  reader: DocReader;
}

export interface ScanSummary {
  evaluated: number;
  ripened: string[];
  voided: string[];
  failed: { pendingId: string; code: string }[];
  skippedUnprepared: string[];
}

export async function scanRipeness(
  deps: ScanDeps,
  opts: {
    now: string;
    cycleId: string;
    wakeActionId: string;
    executedDuringSeq: number;
    preparedPayloads?: ReadonlyMap<string, PreparedPayload>;
  }
): Promise<ScanSummary> {
  const { committerDb: db } = deps;
  const summary: ScanSummary = {
    evaluated: 0,
    ripened: [],
    voided: [],
    failed: [],
    skippedUnprepared: [],
  };

  // Candidate snapshot: pending, in creation order (the §10 index order),
  // plus expired claims (claimable again at this wake, §7.4.1).
  const pendingSnap = await getDocs(
    query(
      collection(db, "sim_pending_consequences"),
      where("status", "==", "pending"),
      orderBy("createdAtSeq", "asc"),
      orderBy("pendingId", "asc"),
      limit(SCAN_EVALUATE_CAP)
    )
  );
  const claimedSnap = await getDocs(
    query(
      collection(db, "sim_pending_consequences"),
      where("status", "==", "ripening-claimed"),
      limit(SCAN_EVALUATE_CAP)
    )
  );
  const candidates: Record<string, unknown>[] = [];
  for (const d of pendingSnap.docs) candidates.push(d.data() as Record<string, unknown>);
  for (const d of claimedSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const claim = data.claim as { leaseExpiresAt?: { toDate?: () => Date } } | null;
    const expired =
      claim?.leaseExpiresAt &&
      typeof claim.leaseExpiresAt.toDate === "function" &&
      claim.leaseExpiresAt.toDate().getTime() <= Date.parse(opts.now);
    if (expired) candidates.push(data);
  }
  candidates.sort((a, b) => {
    const bySeq = (a.createdAtSeq as number) - (b.createdAtSeq as number);
    if (bySeq !== 0) return bySeq;
    return String(a.pendingId).localeCompare(String(b.pendingId));
  });

  // Scan-time world view: counter + city activity + precondition docs.
  const counterSnap = await getDoc(doc(db, "sim_counters", "log"));
  const counter = counterSnap.exists() ? (counterSnap.data() as Record<string, unknown>) : null;
  if (!counter) return summary;
  let currentSeq = counter.lastSeq as number;

  const cityActivitySeq = new Map<string, number>();
  const preconditionDocs = new Map<string, Record<string, unknown> | null>();
  for (const pending of candidates.slice(0, SCAN_EVALUATE_CAP)) {
    const condition = pending.ripenCondition as Record<string, unknown>;
    for (const cityId of (condition.requiresActionInCities as string[] | undefined) ?? []) {
      if (!cityActivitySeq.has(cityId)) {
        const citySnap = await getDoc(doc(db, "sim_cities", cityId));
        const city = citySnap.exists() ? (citySnap.data() as Record<string, unknown>) : null;
        cityActivitySeq.set(
          cityId,
          typeof city?.lastChangedSeq === "number" ? (city.lastChangedSeq as number) : 0
        );
      }
    }
    for (const pc of (condition.preconditions as StructuredPrecondition[] | undefined) ?? []) {
      if (!preconditionDocs.has(pc.path)) {
        preconditionDocs.set(pc.path, await deps.reader.get(pc.path));
      }
    }
  }
  const view: RipenessView = {
    currentSeq,
    nowIso: opts.now,
    cityActivitySeq,
    docByPath: (path) => preconditionDocs.get(path) ?? null,
  };

  let eventsCommitted = 0;
  for (const candidate of candidates.slice(0, SCAN_EVALUATE_CAP)) {
    summary.evaluated += 1;
    const pendingId = candidate.pendingId as string;
    const verdict = evaluateRipeness(candidate, view);
    if (verdict.state === "waiting") continue;
    if (eventsCommitted >= SCAN_RIPEN_CAP) break;

    const spec = candidate.payloadSpec as Record<string, unknown>;
    if (
      verdict.state === "ripe" &&
      spec.mode === "generative" &&
      !opts.preparedPayloads?.has(pendingId)
    ) {
      // Ripeness without a prepared payload: the worker layer has not
      // produced content yet. Not a failure; the pending simply waits.
      summary.skippedUnprepared.push(pendingId);
      continue;
    }

    const leaseId = `lease_${opts.cycleId}_${pendingId}`;
    const claimed = await claimPending(db, pendingId, {
      cycleId: opts.cycleId,
      leaseId,
      now: opts.now,
    });
    if (!claimed) continue;

    try {
      const paths = collectRipeningReadPaths(claimed);
      const snapshot = await buildSnapshot(deps.reader, paths, opts.now);
      const prepared = opts.preparedPayloads?.get(pendingId);
      const plan =
        verdict.state === "void"
          ? resolveVoiding(snapshot, claimed, {
              baselineRegistry: deps.baselineRegistry,
              voidReason: verdict.reason,
            })
          : resolveRipening(snapshot, claimed, {
              baselineRegistry: deps.baselineRegistry,
              prepared,
            });
      const outcome = await commitResolution(
        { db, baselineRegistry: deps.baselineRegistry },
        {
          resolutionId:
            verdict.state === "void" ? `void_${pendingId}` : `ripen_${pendingId}`,
          sourceKind: verdict.state === "void" ? "pending-voiding" : "pending-ripening",
          now: opts.now,
          plan,
          expectedHeads: snapshot.heads,
          snapshotPaths: paths,
          pending: claimed,
          claimLeaseId: leaseId,
          prepared,
          preparedInputHash: prepared?.inputHash ?? null,
          wakeActionId: opts.wakeActionId,
          executedDuringSeq: opts.executedDuringSeq,
          voidReason: verdict.state === "void" ? verdict.reason : undefined,
        }
      );
      if (outcome.status === "committed" || outcome.status === "already-committed") {
        eventsCommitted += 1;
        if (verdict.state === "void") summary.voided.push(pendingId);
        else summary.ripened.push(pendingId);
        if (outcome.status === "committed") {
          currentSeq = outcome.manifest.lastSeq as number;
          view.currentSeq = currentSeq;
        }
      } else if (outcome.status === "stale-preview") {
        // The world moved mid-pass; release and let the next wake retry.
        await releasePendingClaim(db, pendingId, { leaseId, now: opts.now });
      }
      // "aborted" (claim lost) needs no bookkeeping: someone else owns it.
    } catch (error) {
      const code =
        error instanceof CommitError ? error.code : "RIPENING_PREPARATION";
      await releasePendingClaim(db, pendingId, {
        leaseId,
        now: opts.now,
        failureCode: code,
      });
      summary.failed.push({ pendingId, code });
    }
  }
  return summary;
}
