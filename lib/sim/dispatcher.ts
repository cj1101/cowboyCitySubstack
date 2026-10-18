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
  resolveAction,
  type DocReader,
} from "./resolver";
import { CommitError, commitResolution, type CommitOutcome } from "./committer";
import { scanRipeness, type ScanSummary } from "./pending";
import { processUndoOperation } from "./undo";
import type { BaselineRegistry } from "./baseline/registry";

export function firestoreReader(db: Firestore): DocReader {
  return {
    async get(path: string) {
      const segments = path.split("/");
      const snap = await getDoc(doc(db, segments[0], ...segments.slice(1)));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },
  };
}

export interface DispatcherDeps {
  /** Identity for worker-class action bookkeeping (rules: isFabricService). */
  fabricDb: Firestore;
  /** Identity for commits + snapshot reads (rules: committer). */
  committerDb: Firestore;
  baselineRegistry: BaselineRegistry;
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
  now: string
): Promise<void> {
  await updateDoc(doc(deps.fabricDb, "sim_actions", action.actionId), {
    preview: { ...computation.preview, previewHash: computation.previewHash },
    previewPlanHash: computation.plan.planHash,
    audienceUids: computation.audienceUids,
    status: "awaiting_confirmation",
    claim: null,
    updatedAt: new Date(now),
  });
}

/** Worker step (§4.2): compute + store the preview for a received action. */
export async function previewAction(
  deps: DispatcherDeps,
  actionId: string,
  opts: { now: string }
): Promise<PreviewComputation> {
  const snap = await getDoc(doc(deps.fabricDb, "sim_actions", actionId));
  if (!snap.exists()) throw new Error(`action ${actionId} does not exist`);
  const action = snap.data() as SimAction;
  const snapshot = await buildSnapshot(
    firestoreReader(deps.committerDb),
    collectActionReadPaths(action),
    opts.now
  );
  const computation = computePreview(snapshot, action, {
    baselineRegistry: deps.baselineRegistry,
    mode: "preview",
  });
  await storePreview(deps, action, computation, opts.now);
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

    const paths = collectActionReadPaths(claimed);
    const snapshot = await buildSnapshot(reader, paths, opts.now);
    const plan = resolveAction(snapshot, claimed, {
      baselineRegistry: deps.baselineRegistry,
      mode: "commit",
    });

    if (plan.planHash !== claimed.previewPlanHash) {
      // State moved since preview: fresh preview, back to
      // awaiting_confirmation, NO Log entry (§4.4 step 4).
      const computation = computePreview(snapshot, claimed, {
        baselineRegistry: deps.baselineRegistry,
        mode: "commit",
      });
      await storePreview(deps, claimed, computation, opts.now);
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
        }
      );
      summary.scans.push(scan);
    } else if (outcome.status === "stale-preview") {
      const freshSnapshot = await buildSnapshot(reader, paths, opts.now);
      const computation = computePreview(freshSnapshot, claimed, {
        baselineRegistry: deps.baselineRegistry,
        mode: "commit",
      });
      await storePreview(deps, claimed, computation, opts.now);
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

  return summary;
}
