/**
 * The dispatcher (Phase 2 brief §4.1) — the wake cycle.
 *
 * A wake exists ONLY because a player caused it (the runner is invoked
 * on a player-caused occasion; nothing here is scheduled). Each wake:
 *
 *   1. For each confirmed action, in submission order: claim → commit
 *      (the committer re-derives everything in its transaction) → run
 *      ONE ripeness scan pass. Ripenings inside the pass trigger no
 *      further passes.
 *   2. Process queued undo operations (§8.4): a wake picks them up
 *      AFTER the actions it carried have committed, so an op's
 *      execution-time revalidation sees everything that landed in its
 *      wake (TC-U07). Processing an op never triggers a scan.
 *   3. Terminal snapshot refresh (Phase 3 brief §3.2; the writer Phase
 *      2's P2-D9 deferred): if the wake changed the world, run the
 *      dashboard snapshot projection once and write it in its own
 *      transaction. Failure-isolated — a failed refresh never fails a
 *      resolution, and an empty wake writes nothing.
 *
 * The dispatcher itself performs no domain writes: action claim/preview
 * bookkeeping goes through the fabric identity's rules-bound updates;
 * every world/Log write goes through the committer.
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
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import {
  COMMITTER_VERSION,
  type PreparedPayload,
  type SimAction,
} from "./state";
import { computePreview, type PreviewComputation } from "./preview";
import {
  buildSnapshot,
  collectActionReadPaths,
  collectActionReadPlan,
  materializeSnapshot,
  resolveAction,
  type QueryReader,
} from "./resolver";
import { firestoreQueryReader, firestoreReader } from "./readers";
import { CommitError, commitResolution, type CommitOutcome } from "./committer";
import { scanRipeness, WakeScanState, type ScanSummary } from "./pending";
import { processUndoOperation } from "./undo";
import { wakeChangedWorld } from "./snapshot";
import { refreshSnapshotAfterWake } from "./snapshotRefresh";
import type { BaselineRegistry } from "./baseline/registry";

export { firestoreReader } from "./readers";

export interface DispatcherDeps {
  /** Identity for worker-class action bookkeeping (rules: isFabricService). */
  fabricDb: Firestore;
  /** Identity for commits + snapshot reads (rules: committer). */
  committerDb: Firestore;
  baselineRegistry: BaselineRegistry;
  /** Executes read-plan collection queries (F-01); defaults to a
   * reader over `committerDb` — the same identity that reads docs. */
  queryReader?: QueryReader;
}

function queryReaderOf(deps: DispatcherDeps): QueryReader {
  return deps.queryReader ?? firestoreQueryReader(deps.committerDb);
}

/** The snapshot an action resolves against (F-01): the base doc paths
 * are read first (the seed docs), the classifying descriptor's
 * read-plan hook derives any further doc paths + collection queries
 * from the action and those stored records, and the whole plan is
 * materialized — query results bound into the snapshot exactly like
 * doc reads. Returns the snapshot and the full path list (base +
 * declared + query results) the committer must re-read in-transaction. */
async function snapshotForAction(
  deps: DispatcherDeps,
  action: SimAction,
  now: string
): Promise<{ snapshot: Awaited<ReturnType<typeof materializeSnapshot>>; paths: string[] }> {
  const reader = firestoreReader(deps.committerDb);
  const seed = await buildSnapshot(reader, collectActionReadPaths(action), now);
  const readPlan = collectActionReadPlan(action, seed.docs);
  const snapshot = await materializeSnapshot(reader, queryReaderOf(deps), readPlan, now);
  const paths = [
    ...new Set([
      ...readPlan.paths,
      ...snapshot.queries.flatMap((q) => q.resultPaths),
    ]),
  ];
  return { snapshot, paths };
}

export interface WakeSummary {
  undoOpsProcessed: number;
  actionsCommitted: string[];
  actionsRejected: string[];
  actionsStale: string[];
  actionsFailed: { actionId: string; code: string }[];
  scans: ScanSummary[];
  aborted?: string;
}

async function storePreview(
  deps: DispatcherDeps,
  action: SimAction,
  computation: PreviewComputation,
  now: string,
  prepared?: PreparedPayload
): Promise<void> {
  await updateDoc(doc(deps.fabricDb, "sim_actions", action.actionId), {
    preview: { ...computation.preview, previewHash: computation.previewHash },
    previewPlanHash: computation.plan.planHash,
    audienceUids: computation.audienceUids,
    // F-07: the payload this preview was computed with is stored on the
    // action doc, so the wake commits with the SAME payload the member
    // confirmed against — never a fresh worker call at commit time.
    ...(prepared
      ? {
          preparedPayload: { ...prepared },
          preparedInputHash: prepared.inputHash,
        }
      : {}),
    status: "awaiting_confirmation",
    claim: null,
    updatedAt: new Date(now),
  });
}

/** Worker step (§4.2): compute + store the preview for a received action.
 * `opts.prepared` is the worker-prepared payload for judgment-bearing
 * action kinds (F-07); when given, it is bound into the preview hash
 * and stored on the action doc for the commit. */
export async function previewAction(
  deps: DispatcherDeps,
  actionId: string,
  opts: { now: string; prepared?: PreparedPayload }
): Promise<PreviewComputation> {
  const snap = await getDoc(doc(deps.fabricDb, "sim_actions", actionId));
  if (!snap.exists()) throw new Error(`action ${actionId} does not exist`);
  const action = snap.data() as SimAction;
  const { snapshot } = await snapshotForAction(deps, action, opts.now);
  const computation = computePreview(snapshot, action, {
    baselineRegistry: deps.baselineRegistry,
    mode: "preview",
    prepared: opts.prepared,
  });
  await storePreview(deps, action, computation, opts.now, opts.prepared);
  return computation;
}

async function claimAction(
  deps: DispatcherDeps,
  action: SimAction,
  opts: { cycleId: string; leaseId: string; now: string }
): Promise<SimAction | null> {
  const ref = doc(deps.fabricDb, "sim_actions", action.actionId);
  return runTransaction(deps.fabricDb, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const current = snap.data() as SimAction;
    if (current.status !== "confirmed") return null;
    const claimed: SimAction = {
      ...current,
      status: "resolving",
      claim: {
        cycleId: opts.cycleId,
        leaseId: opts.leaseId,
        attempt: (current.claim?.attempt ?? 0) + 1,
        claimedAt: new Date(opts.now),
        leaseExpiresAt: new Date(Date.parse(opts.now) + 10 * 60_000),
      },
      updatedAt: new Date(opts.now),
    };
    tx.set(ref, claimed as unknown as Record<string, unknown>);
    return claimed;
  });
}

async function releaseAction(
  deps: DispatcherDeps,
  actionId: string,
  leaseId: string,
  patch: Record<string, unknown>,
  now: string
): Promise<void> {
  const ref = doc(deps.fabricDb, "sim_actions", actionId);
  await runTransaction(deps.fabricDb, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const current = snap.data() as SimAction;
    if (current.claim?.leaseId !== leaseId) return;
    tx.update(ref, { ...patch, claim: null, updatedAt: new Date(now) });
  });
}

export async function runWake(
  deps: DispatcherDeps,
  opts: {
    now: string;
    cycleId: string;
    preparedPayloads?: ReadonlyMap<string, PreparedPayload>;
    maxActions?: number;
  }
): Promise<WakeSummary> {
  const summary: WakeSummary = {
    undoOpsProcessed: 0,
    actionsCommitted: [],
    actionsRejected: [],
    actionsStale: [],
    actionsFailed: [],
    scans: [],
  };
  const reader = firestoreReader(deps.committerDb);
  // P4-K19 (Phase 4 close-out, E1): one scan state per wake — the
  // evaluation/event budgets and the candidate snapshot are wake-
  // scoped, shared by every scan pass this wake runs.
  const wakeScanState = new WakeScanState();

  // Confirmed actions first (brief §1.3's wake order: actions commit,
  // each followed by its scan; queued undo operations are picked up
  // after the action phase, §8.4 step 2, and never trigger a scan).
  // Processing ops BEFORE the queued actions would let an op execute
  // against a world the same wake is about to change: a dependent
  // action landing in the op's own wake must be visible to the op's
  // execution-time dependency revalidation (TC-U07's race).
  const actionsSnap = await getDocs(
    query(
      collection(deps.fabricDb, "sim_actions"),
      where("status", "==", "confirmed"),
      orderBy("createdAt", "asc"),
      limit(opts.maxActions ?? 10)
    )
  );

  for (const actionDoc of actionsSnap.docs) {
    const action = actionDoc.data() as SimAction;
    const leaseId = `lease_${opts.cycleId}_${action.actionId.slice(0, 16)}`;
    const claimed = await claimAction(deps, action, {
      cycleId: opts.cycleId,
      leaseId,
      now: opts.now,
    });
    if (!claimed) continue;

    if (!claimed.preview || !claimed.previewPlanHash) {
      await releaseAction(
        deps,
        action.actionId,
        leaseId,
        {
          status: "confirmed",
          lastAttempt: {
            at: new Date(opts.now),
            code: "PREVIEW_MISSING",
            message: "action was confirmed without a stored preview; re-preview required.",
          },
        },
        opts.now
      );
      continue;
    }

    // F-07: the payload stored at preview time rides the commit. A
    // stored hash that disagrees with the payload's own hash means the
    // doc was tampered with (or written by a buggy worker): refuse to
    // resolve under a payload nobody can vouch for.
    const prepared = claimed.preparedPayload ?? undefined;
    if (
      prepared &&
      typeof claimed.preparedInputHash === "string" &&
      claimed.preparedInputHash !== prepared.inputHash
    ) {
      await releaseAction(
        deps,
        action.actionId,
        leaseId,
        {
          status: "confirmed",
          lastAttempt: {
            at: new Date(opts.now),
            code: "PREPARED_HASH_MISMATCH",
            message:
              "the stored prepared payload's hash does not match the preview-bound hash; re-preview required.",
          },
        },
        opts.now
      );
      summary.actionsFailed.push({ actionId: action.actionId, code: "PREPARED_HASH_MISMATCH" });
      continue;
    }

    const { snapshot, paths } = await snapshotForAction(deps, claimed, opts.now);
    const plan = resolveAction(snapshot, claimed, {
      baselineRegistry: deps.baselineRegistry,
      mode: "commit",
      prepared,
    });

    if (plan.planHash !== claimed.previewPlanHash) {
      // State moved since preview: fresh preview, back to
      // awaiting_confirmation, NO Log entry (§4.4 step 4). The fresh
      // preview binds the SAME prepared payload (F-07) — the one the
      // member confirmed against.
      const computation = computePreview(snapshot, claimed, {
        baselineRegistry: deps.baselineRegistry,
        mode: "commit",
        prepared,
      });
      await storePreview(deps, claimed, computation, opts.now, prepared);
      summary.actionsStale.push(action.actionId);
      continue;
    }

    let outcome: CommitOutcome;
    try {
      outcome = await commitResolution(
        { db: deps.committerDb, baselineRegistry: deps.baselineRegistry },
        {
          resolutionId: action.actionId,
          sourceKind: "action",
          now: opts.now,
          committerVersion: COMMITTER_VERSION,
          plan,
          expectedHeads: snapshot.heads,
          snapshotPaths: paths,
          queryRecords: snapshot.queries,
          prepared,
          preparedInputHash: prepared?.inputHash ?? null,
          action: claimed,
          claimLeaseId: leaseId,
        }
      );
    } catch (error) {
      const code = error instanceof CommitError ? error.code : "COMMIT_FAILED";
      if (code === "MANIFEST_TOO_LARGE") {
        await releaseAction(
          deps,
          action.actionId,
          leaseId,
          {
            status: "failed",
            failure: { code, message: (error as Error).message },
          },
          opts.now
        );
        summary.actionsFailed.push({ actionId: action.actionId, code });
        continue;
      }
      await releaseAction(
        deps,
        action.actionId,
        leaseId,
        {
          status: "confirmed",
          lastAttempt: { at: new Date(opts.now), code, message: (error as Error).message },
        },
        opts.now
      );
      summary.actionsFailed.push({ actionId: action.actionId, code });
      if (code === "LOG_HEAD_MISMATCH" || code.startsWith("INTEGRITY")) {
        // Integrity failures stop the wake: nothing further commits
        // onto a suspect head (§4.6).
        summary.aborted = code;
        break;
      }
      continue;
    }

    if (outcome.status === "committed" || outcome.status === "already-committed") {
      const manifest = outcome.manifest;
      const finalSnap = await getDoc(doc(deps.fabricDb, "sim_actions", action.actionId));
      const finalStatus = (finalSnap.data() as SimAction | undefined)?.status;
      if (finalStatus === "rejected") summary.actionsRejected.push(action.actionId);
      else summary.actionsCommitted.push(action.actionId);
      // Exactly one ripeness scan pass per committed player action.
      const scan = await scanRipeness(
        { committerDb: deps.committerDb, baselineRegistry: deps.baselineRegistry, reader },
        {
          now: opts.now,
          cycleId: opts.cycleId,
          wakeActionId: action.actionId,
          executedDuringSeq: manifest.lastSeq as number,
          preparedPayloads: opts.preparedPayloads,
          wakeState: wakeScanState,
        }
      );
      summary.scans.push(scan);
    } else if (outcome.status === "stale-preview") {
      const { snapshot: freshSnapshot } = await snapshotForAction(deps, claimed, opts.now);
      const computation = computePreview(freshSnapshot, claimed, {
        baselineRegistry: deps.baselineRegistry,
        mode: "commit",
        prepared,
      });
      await storePreview(deps, claimed, computation, opts.now, prepared);
      summary.actionsStale.push(action.actionId);
    }
    // "aborted" (claim lost): another committer owns it now; nothing to do.
  }

  // Queued undo operations, after the action phase (§8.4 step 2).
  // Processing an op never triggers a ripeness scan (§1.3/§8.2).
  const opsSnap = await getDocs(
    query(
      collection(deps.committerDb, "sim_undo_operations"),
      where("status", "in", ["requested", "checking"]),
      orderBy("createdAt", "asc"),
      limit(10)
    )
  );
  for (const opDoc of opsSnap.docs) {
    await processUndoOperation(deps.committerDb, opDoc.id, { now: opts.now });
    summary.undoOpsProcessed += 1;
  }

  // Terminal snapshot refresh (Phase 3 brief §3.2): one projection per
  // world-changing wake, in its own transaction, failure-isolated (the
  // adapter never throws). An empty wake writes nothing — there is
  // nothing new to project, and §0.1.1 forbids implying otherwise.
  if (wakeChangedWorld(summary)) {
    await refreshSnapshotAfterWake(deps, opts.now);
  }

  return summary;
}
