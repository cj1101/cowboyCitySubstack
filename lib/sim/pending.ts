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
  snapshotDoc,
  type PreparedPayload,
} from "./state";
import {
  buildRipenessView,
  evaluateRipeness,
  resolvedSeqOf,
  ripeningFailureClass,
  type RipenessVerdict,
  type RipenessView,
  type StructuredPrecondition,
} from "./rules/pendingRules";

export { evaluateRipeness } from "./rules/pendingRules";
export type { RipenessVerdict, RipenessView } from "./rules/pendingRules";
import {
  buildSnapshot,
  collectRipeningReadPaths,
  collectRipeningReadQueries,
  materializeSnapshot,
  resolveRipening,
  resolveVoiding,
  type DocReader,
  type QueryReader,
} from "./resolver";
import { firestoreQueryReader } from "./readers";
import { CommitError, commitResolution } from "./committer";
import type { BaselineRegistry } from "./baseline/registry";

// ---------------------------------------------------------------------------
// The AGR predicate (Felix N1, §7.3) lives in rules/pendingRules.ts
// (moved at the Phase 4 close-out so the committer's P4-K20 guard can
// evaluate it without an import cycle) and is re-exported above.
// ---------------------------------------------------------------------------

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
  opts: {
    leaseId: string;
    now: string;
    failureCode?: string;
    /** P4-K23 (Phase 4 close-out, E3): a deterministic size failure
     * moves the pending to the named `blocked-oversize` attention
     * state instead of back to `pending` — and burns NO attempts. The
     * failure code is still recorded (lastFailure), and
     * needsAttention is set: a human (or a later surface) owns the
     * unblock; the scan never retries a blocked pending. */
    attentionState?: "blocked-oversize";
  }
): Promise<void> {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(pendingRef(db, pendingId));
    if (!snap.exists()) return;
    const pending = snap.data() as Record<string, unknown>;
    const claim = pending.claim as { leaseId?: string } | null;
    if (pending.status !== "ripening-claimed" || claim?.leaseId !== opts.leaseId) return;
    const blocked = opts.attentionState === "blocked-oversize";
    const attempts = (pending.attempts as number) + (opts.failureCode && !blocked ? 1 : 0);
    tx.set(pendingRef(db, pendingId), {
      ...pending,
      status: blocked ? "blocked-oversize" : "pending",
      claim: null,
      attempts,
      needsAttention: blocked
        ? true
        : attempts >= PENDING_MAX_ATTEMPTS
          ? true
          : pending.needsAttention,
      ...(opts.failureCode
        ? { lastFailure: { at: new Date(opts.now), code: opts.failureCode } }
        : {}),
      stateVersion: (pending.stateVersion as number) + 1,
      updatedAt: new Date(opts.now),
    });
  });
}

// ---------------------------------------------------------------------------
// Wake-scoped scan state (P4-K19, Phase 4 close-out E1). The caps are
// per WAKE, not per pass: one evaluation budget (25) and one event
// budget (5) shared across every scan the wake runs, and the
// candidate set is snapshotted ONCE, at wake start — a pending
// created mid-wake (a ripening's child) is not eligible until the
// next wake, which is also the structural form of one-generation-
// per-wake. The dispatcher owns one instance per wake; a scan called
// without one behaves as a single-scan wake (today's semantics).
// ---------------------------------------------------------------------------

export class WakeScanState {
  /** Evaluations consumed across the wake's scans so far. */
  evaluatedBudget = 0;
  /** Ripening/voiding events committed across the wake's scans. */
  eventBudget = 0;
  /** The wake-start candidate snapshot; null until the first scan. */
  candidates: Record<string, unknown>[] | null = null;
  /** Pendings that reached a terminal scan outcome this wake
   * (ripened / voided / blocked) — later scans skip them: their
   * stored docs moved, and re-evaluating a stale copy would be
   * deciding on a world that no longer exists. */
  readonly terminal = new Set<string>();

  get evaluationsLeft(): number {
    return SCAN_EVALUATE_CAP - this.evaluatedBudget;
  }
  get eventsLeft(): number {
    return SCAN_RIPEN_CAP - this.eventBudget;
  }
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
  /** Query executor for ripening read plans that declare collection
   * queries (Phase 4 step 9: delivery pendings' counter-means query).
   * Defaults to the Firestore query reader over the committer db. */
  queryReader?: QueryReader;
}

export interface ScanSummary {
  evaluated: number;
  ripened: string[];
  voided: string[];
  failed: { pendingId: string; code: string }[];
  skippedUnprepared: string[];
  /** P4-K23 (E3): pendings moved to the blocked-oversize attention
   * state by deterministic size failures in this pass. */
  blocked: string[];
}

export async function scanRipeness(
  deps: ScanDeps,
  opts: {
    now: string;
    cycleId: string;
    wakeActionId: string;
    executedDuringSeq: number;
    preparedPayloads?: ReadonlyMap<string, PreparedPayload>;
    /** The wake's shared scan state (P4-K19). The dispatcher passes
     * one per wake; omitted, the scan is its own wake (fresh budgets,
     * fresh candidate snapshot) — the pre-close-out semantics. */
    wakeState?: WakeScanState;
  }
): Promise<ScanSummary> {
  const { committerDb: db } = deps;
  const summary: ScanSummary = {
    evaluated: 0,
    ripened: [],
    voided: [],
    failed: [],
    skippedUnprepared: [],
    blocked: [],
  };
  const state = opts.wakeState ?? new WakeScanState();

  // Candidate snapshot (P4-K19): taken ONCE per wake, at its first
  // scan — pending, in creation order (the §10 index order), plus
  // expired claims (claimable again at this wake, §7.4.1). Later
  // scans in the wake continue over the same set: a pending created
  // mid-wake is next wake's business (one generation per wake).
  if (state.candidates === null) {
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
    state.candidates = candidates.slice(0, SCAN_EVALUATE_CAP);
  }
  const candidates = state.candidates;

  // Scan-time world view: counter + city activity + precondition docs.
  // Scan-time evaluation is SCHEDULING only (P4-K20): it decides which
  // candidates are worth claiming; the decision is re-made on the
  // claimed snapshot below, and again in the commit transaction.
  // Seq currency is the P4-K24 resolved tally (E4), not the Log head.
  const counterSnap = await getDoc(doc(db, "sim_counters", "log"));
  const counter = counterSnap.exists() ? (counterSnap.data() as Record<string, unknown>) : null;
  if (!counter) return summary;
  let currentSeq = resolvedSeqOf(counter);

  const cityActivitySeq = new Map<string, number>();
  const preconditionDocs = new Map<string, Record<string, unknown> | null>();
  for (const pending of candidates) {
    if (state.terminal.has(pending.pendingId as string)) continue;
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

  for (const candidate of candidates) {
    const pendingId = candidate.pendingId as string;
    if (state.terminal.has(pendingId)) continue;
    if (state.evaluationsLeft <= 0) break;
    state.evaluatedBudget += 1;
    summary.evaluated += 1;
    const verdict = evaluateRipeness(candidate, view);
    if (verdict.state === "waiting") continue;
    if (state.eventsLeft <= 0) break;

    const leaseId = `lease_${opts.cycleId}_${pendingId}`;
    const claimed = await claimPending(db, pendingId, {
      cycleId: opts.cycleId,
      leaseId,
      now: opts.now,
    });
    if (!claimed) continue;

    try {
      const paths = collectRipeningReadPaths(claimed);
      const queries = collectRipeningReadQueries(claimed);
      // Only delivery pendings declare ripening queries today; with
      // none declared the snapshot materializes exactly as before.
      // With queries, the materializer binds every result doc into
      // the snapshot (and its query records ride the commit, so the
      // in-transaction recompute finds the same materialized set).
      const snapshot =
        queries.length === 0
          ? await buildSnapshot(deps.reader, paths, opts.now)
          : await materializeSnapshot(
              deps.reader,
              deps.queryReader ?? firestoreQueryReader(db),
              { paths, queries },
              opts.now
            );
      const snapshotPaths =
        queries.length === 0
          ? paths
          : [
              ...new Set([
                ...paths,
                ...snapshot.queries.flatMap((q) => q.resultPaths),
              ]),
            ];
      const prepared = opts.preparedPayloads?.get(pendingId);

      // P4-K20 re-evaluation (Phase 4 close-out, E2): the AGR
      // predicates are re-run on the CLAIMED snapshot — the world as
      // it stands now, after every earlier commit in this pass — and
      // the CLAIMED verdict governs. A flip (ripen <-> void <-> wait)
      // produces the flipped outcome, never a commit of the stale
      // scan verdict.
      let finalVerdict: RipenessVerdict = evaluateRipeness(
        claimed,
        buildRipenessView(claimed, {
          counter: snapshotDoc(snapshot, "sim_counters/log"),
          nowIso: opts.now,
          docByPath: (path) => snapshotDoc(snapshot, path),
          activityFallback: cityActivitySeq,
        })
      );
      if (finalVerdict.state === "waiting") {
        // Not ripe after all — release without a failure record; the
        // pending simply waits for a later wake.
        await releasePendingClaim(db, pendingId, { leaseId, now: opts.now });
        continue;
      }
      const unpreparedGenerative = (v: RipenessVerdict): boolean =>
        v.state === "ripe" &&
        (claimed.payloadSpec as Record<string, unknown>).mode === "generative" &&
        !prepared;
      if (unpreparedGenerative(finalVerdict)) {
        // Ripeness without a prepared payload: the worker layer has
        // not produced content yet. Not a failure; release and wait.
        await releasePendingClaim(db, pendingId, { leaseId, now: opts.now });
        summary.skippedUnprepared.push(pendingId);
        continue;
      }

      // Drive the commit for the standing verdict; a committer-side
      // verdict flip (the world moved between materialization and
      // the commit transaction) re-drives ONCE with the flipped
      // verdict, still inside this pass and this claim.
      let outcome: Awaited<ReturnType<typeof commitResolution>> | null = null;
      for (let drive = 0; drive < 2; drive += 1) {
        const isVoid = finalVerdict.state === "void";
        const plan = isVoid
          ? resolveVoiding(snapshot, claimed, {
              baselineRegistry: deps.baselineRegistry,
              voidReason: (finalVerdict as { reason: string }).reason,
            })
          : resolveRipening(snapshot, claimed, {
              baselineRegistry: deps.baselineRegistry,
              prepared,
            });
        outcome = await commitResolution(
          { db, baselineRegistry: deps.baselineRegistry },
          {
            resolutionId: isVoid ? `void_${pendingId}` : `ripen_${pendingId}`,
            sourceKind: isVoid ? "pending-voiding" : "pending-ripening",
            now: opts.now,
            plan,
            expectedHeads: snapshot.heads,
            snapshotPaths,
            queryRecords: snapshot.queries,
            pending: claimed,
            claimLeaseId: leaseId,
            prepared,
            preparedInputHash: prepared?.inputHash ?? null,
            wakeActionId: opts.wakeActionId,
            executedDuringSeq: opts.executedDuringSeq,
            voidReason: isVoid ? (finalVerdict as { reason: string }).reason : undefined,
          }
        );
        if (outcome.status !== "verdict-flip") break;
        const flipped = outcome.verdict;
        if (flipped.state === "waiting" || drive === 1) {
          // Flip to wait (or a second flip): release and let the
          // next wake re-decide. Nothing was written by either drive.
          await releasePendingClaim(db, pendingId, { leaseId, now: opts.now });
          outcome = null;
          break;
        }
        if (unpreparedGenerative(flipped)) {
          await releasePendingClaim(db, pendingId, { leaseId, now: opts.now });
          summary.skippedUnprepared.push(pendingId);
          outcome = null;
          break;
        }
        finalVerdict = flipped;
        outcome = null; // re-drive with the flipped verdict
      }
      if (!outcome) continue;

      if (outcome.status === "committed" || outcome.status === "already-committed") {
        state.eventBudget += 1;
        state.terminal.add(pendingId);
        if (finalVerdict.state === "void") summary.voided.push(pendingId);
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
      // P4-K23 taxonomy (E3): deterministic size failures block the
      // pending by name and burn no attempts; everything else is the
      // attempts/retry class, as before.
      if (ripeningFailureClass(code) === "size-block") {
        await releasePendingClaim(db, pendingId, {
          leaseId,
          now: opts.now,
          failureCode: code,
          attentionState: "blocked-oversize",
        });
        state.terminal.add(pendingId);
        summary.blocked.push(pendingId);
      } else {
        await releasePendingClaim(db, pendingId, {
          leaseId,
          now: opts.now,
          failureCode: code,
        });
        summary.failed.push({ pendingId, code });
      }
    }
  }
  return summary;
}
