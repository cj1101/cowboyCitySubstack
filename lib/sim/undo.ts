/**
 * Undo (Phase 2 brief §8) — LIFO unwinding of the standing Log by whole
 * Resolution Event, with snapshot restore from resolution manifests.
 *
 * Undo is not an inverse operation and not a compensating entry: the
 * target Resolution Event is ERASED — its Log entries deleted, its state
 * changes restored exactly from the manifest's before-snapshots, its
 * manifest and source action deleted, the counter restored to
 * `counterBefore`, the world head restored. What survives is the
 * content-free proof in `sim_undo_operations` (§2.5): the fact that a
 * lawful undo occurred, never what was undone.
 *
 * A target is refused — never partially unwound — when it is not the
 * suffix (structural) or when anything later RELIED on it (semantic
 * blockers S1–S7, computed as closure over manifest ref keys). Genesis
 * is never a target; ripening/voiding resolutions are not Phase 2
 * targets (P2-K5).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import { sha256Hex } from "./canonical";
import { headHashOf, projectFirestoreValue } from "./log";

export class UndoError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export interface SemanticBlocker {
  kind: "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "untracked-change";
  refKey: string;
  label: string;
}

export interface DependencyReport {
  checkedHeadSeq: number;
  semanticBlockers: SemanticBlocker[];
  structuralSuccessor: { resolutionId: string; firstSeq: number } | null;
  proofDigest: string;
}

interface ManifestShape {
  resolutionId: string;
  sourceKind: string;
  actionId: string | null;
  originActionId: string | null;
  originSeq: number | null;
  firstSeq: number;
  lastSeq: number;
  dependencyRefKeys: string[];
  outputRefKeys: string[];
  writeSet: {
    path: string;
    op: string;
    recordClass: string;
    beforeDoc: Record<string, unknown> | null;
    afterDoc: Record<string, unknown> | null;
  }[];
  counterBefore: { lastSeq: number; lastEntryHash: string; lastResolutionId: string | null };
  planHash: string;
  [key: string]: unknown;
}

function manifestRef(db: Firestore, resolutionId: string) {
  return doc(db, "sim_resolutions", resolutionId);
}

function refFor(db: Firestore, path: string) {
  const segments = path.split("/");
  return doc(db, segments[0], ...segments.slice(1));
}

async function readManifest(
  db: Firestore,
  resolutionId: string
): Promise<ManifestShape | null> {
  const snap = await getDoc(manifestRef(db, resolutionId));
  return snap.exists() ? (snap.data() as ManifestShape) : null;
}

async function entryActor(
  db: Firestore,
  resolutionId: string,
  lastSeq: number
): Promise<Record<string, unknown> | null> {
  const snap = await getDoc(doc(db, "sim_log_entries", String(lastSeq).padStart(12, "0")));
  if (!snap.exists()) return null;
  return (snap.data() as Record<string, unknown>).actor as Record<string, unknown>;
}

function seqKeyInRange(key: string, firstSeq: number, lastSeq: number): boolean {
  const match = /^seq:(\d+)$/.exec(key);
  if (!match) return false;
  const n = Number(match[1]);
  return n >= firstSeq && n <= lastSeq;
}

/**
 * Build the dependency report for a target (§8.3): structural suffix
 * check, then closure over manifests with firstSeq > target.firstSeq
 * whose dependencyRefKeys intersect the running frontier, classified
 * into the S-kinds, plus the target-created pendings' own state (S6),
 * plus the current-head cross-check for untracked change.
 */
export async function buildDependencyReport(
  db: Firestore,
  target: ManifestShape,
  counter: Record<string, unknown>
): Promise<DependencyReport> {
  const blockers: SemanticBlocker[] = [];
  const seenBlockers = new Set<string>();
  const push = (blocker: SemanticBlocker) => {
    const key = `${blocker.kind}|${blocker.refKey}`;
    if (seenBlockers.has(key)) return;
    seenBlockers.add(key);
    blockers.push(blocker);
  };

  // Structural: the target must be the tail.
  let structuralSuccessor: DependencyReport["structuralSuccessor"] = null;
  if (counter.lastSeq !== target.lastSeq) {
    const successorSnap = await getDocs(
      query(
        collection(db, "sim_resolutions"),
        where("firstSeq", "==", target.lastSeq + 1)
      )
    );
    if (!successorSnap.empty) {
      const successor = successorSnap.docs[0].data() as ManifestShape;
      structuralSuccessor = {
        resolutionId: successor.resolutionId,
        firstSeq: successor.firstSeq,
      };
    } else {
      structuralSuccessor = { resolutionId: "(unknown)", firstSeq: target.lastSeq + 1 };
    }
  }

  // Closure over later manifests (in-memory over the emulator-scale Log;
  // the §10 indexes support the same walk by array-contains queries at
  // production scale).
  const laterSnap = await getDocs(
    query(
      collection(db, "sim_resolutions"),
      where("firstSeq", ">", target.firstSeq),
      orderBy("firstSeq", "asc")
    )
  );
  const later = laterSnap.docs.map((d) => d.data() as ManifestShape);
  const targetActor = await entryActor(db, target.resolutionId, target.lastSeq);
  const createdPendingIds = target.writeSet
    .filter((w) => w.recordClass === "pending" && w.op === "create")
    .map((w) => w.path.split("/")[1]);
  const explainedPaths = new Set<string>();
  const frontier = new Set<string>(target.outputRefKeys);
  const closure: ManifestShape[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const candidate of later) {
      if (closure.includes(candidate)) continue;
      const hits = candidate.dependencyRefKeys.filter(
        (key) => frontier.has(key) || seqKeyInRange(key, target.firstSeq, target.lastSeq)
      );
      if (hits.length === 0) continue;
      closure.push(candidate);
      for (const key of candidate.outputRefKeys) {
        if (!frontier.has(key)) {
          frontier.add(key);
          grew = true;
        }
      }
      for (const w of candidate.writeSet) explainedPaths.add(w.path);
    }
  }

  for (const dependent of closure) {
    const depKeys = dependent.dependencyRefKeys;
    const citesTargetResolution = depKeys.includes(`resolution:${target.resolutionId}`);
    const citesTargetSeq = depKeys.some((k) =>
      seqKeyInRange(k, target.firstSeq, target.lastSeq)
    );
    const citesTargetPending = createdPendingIds.some((id) =>
      depKeys.includes(`pending:${id}`)
    );
    const citesPublication = depKeys.some((k) => k.startsWith("record:sim_publications/"));
    const citesIntel = depKeys.some((k) => k.startsWith("record:sim_intel_records/"));
    const depActor = await entryActor(db, dependent.resolutionId, dependent.lastSeq);
    const differentActor =
      JSON.stringify(depActor ?? null) !== JSON.stringify(targetActor ?? null);

    let kind: SemanticBlocker["kind"] = "S1";
    let label = `Resolution ${dependent.resolutionId} consumed outputs of ${target.resolutionId}.`;
    if (citesTargetSeq && citesTargetResolution && dependent.planHash !== undefined && depKeys.some((k) => k.startsWith("seq:"))) {
      // A discovery resolution cites both the covert resolution and its
      // seq (FIXTURE-DISCOVER's shape): externalization, S7.
      const discovery = await getDoc(
        doc(db, "sim_log_entries", String(dependent.firstSeq).padStart(12, "0"))
      );
      const classification = discovery.exists()
        ? ((discovery.data() as Record<string, unknown>).classification as Record<string, unknown> | null)
        : null;
      if (classification?.discovery === true) {
        kind = "S7";
        label = `Discovery resolution ${dependent.resolutionId} externalized ${target.resolutionId} (N-1 lock).`;
      }
    }
    if (kind === "S1" && citesTargetPending) {
      kind = "S6";
      label = `Resolution ${dependent.resolutionId} depends on a pending created by ${target.resolutionId}.`;
    } else if (kind === "S1" && (dependent.sourceKind === "pending-ripening" || dependent.sourceKind === "pending-voiding")) {
      kind = "S6";
      label = `Ripening/voiding ${dependent.resolutionId} descends from ${target.resolutionId}'s chain.`;
    } else if (
      kind === "S1" &&
      dependent.writeSet.some(
        (w) =>
          w.path.includes("/structures/") &&
          target.writeSet.some((tw) => tw.path === w.path)
      )
    ) {
      // S5: the dependent wrote to a structure record the target also
      // wrote — the fixture realization of "repairs begun on what the
      // target destroyed" (the repair action cites the destruction).
      kind = "S5";
      label = `Resolution ${dependent.resolutionId} acted on a structure ${target.resolutionId} destroyed or altered — repair/repricing has begun.`;
    } else if (kind === "S1" && citesPublication) {
      kind = "S4";
      label = `Resolution ${dependent.resolutionId} relied on a publication standing on ${target.resolutionId}.`;
    } else if (kind === "S1" && citesIntel) {
      kind = "S4";
      label = `Resolution ${dependent.resolutionId} relied on intel records standing on ${target.resolutionId}.`;
    } else if (kind === "S1" && differentActor) {
      kind = "S3";
      label = `Another member's resolution ${dependent.resolutionId} responded to ${target.resolutionId}.`;
    }
    push({ kind, refKey: `resolution:${dependent.resolutionId}`, label });
  }

  // S6 direct: the target's own pendings have moved or been referenced.
  for (const pendingId of createdPendingIds) {
    const snap = await getDoc(doc(db, "sim_pending_consequences", pendingId));
    if (!snap.exists()) continue;
    const pending = snap.data() as Record<string, unknown>;
    if (pending.status !== "pending" && pending.status !== "ripening-claimed") {
      push({
        kind: "S6",
        refKey: `pending:${pendingId}`,
        label: `Pending ${pendingId} has already ${pending.status === "ripened" ? "ripened" : "been voided"} — the origin's meaning has already operated.`,
      });
    }
    const referencedBy = (pending.referencedByRefKeys as string[] | undefined) ?? [];
    if (referencedBy.length > 0) {
      push({
        kind: "S6",
        refKey: `pending:${pendingId}`,
        label: `Pending ${pendingId} is referenced by standing resolutions: ${referencedBy.join(", ")}.`,
      });
    }
    if ((pending.preconditionsReferenced as boolean | undefined) === true) {
      push({
        kind: "S6",
        refKey: `pending:${pendingId}`,
        label: `Pending ${pendingId}'s state was read as a precondition input.`,
      });
    }
  }

  // Current-head cross-check: every standing after-state of the target
  // must either still hold or be explained by a closure member's write.
  for (const write of target.writeSet) {
    if (write.recordClass !== "state" && write.recordClass !== "pending") continue;
    const snap = await getDoc(refFor(db, write.path));
    const current = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    if (headHashOf(current) !== headHashOf(write.afterDoc)) {
      if (!explainedPaths.has(write.path)) {
        push({
          kind: "untracked-change",
          refKey: `record:${write.path}`,
          label: `${write.path} no longer matches ${target.resolutionId}'s after-state and no standing manifest explains the change.`,
        });
      }
    }
  }

  blockers.sort((a, b) => `${a.kind}|${a.refKey}`.localeCompare(`${b.kind}|${b.refKey}`));
  const proofDigest = sha256Hex(
    projectFirestoreValue({
      target: target.resolutionId,
      checkedHeadSeq: counter.lastSeq,
      blockers,
      structuralSuccessor,
    }) as Record<string, unknown>
  );
  return {
    checkedHeadSeq: counter.lastSeq as number,
    semanticBlockers: blockers,
    structuralSuccessor,
    proofDigest,
  };
}

/** §8.4 authority: the target's own actor; for NPC-origin targets, the
 * on-behalf member; for shared-office targets, the sitting Mayor (mayor
 * identity is Phase 7 terms data — Phase 2 has no standing terms record
 * to check against, so shared-office targets refuse with that reason). */
export function checkUndoAuthority(
  targetActor: Record<string, unknown> | null,
  requesterUid: string
): { ok: boolean; reason: string } {
  if (!targetActor) return { ok: false, reason: "target actor unknown" };
  const type = targetActor.type as string;
  if (type === "member" && targetActor.memberId === requesterUid) {
    return { ok: true, reason: "requester is the target's actor" };
  }
  if (type === "npc" && targetActor.onBehalfOfMemberId === requesterUid) {
    return { ok: true, reason: "requester is the NPC's on-behalf member" };
  }
  if (type === "shared-office") {
    return {
      ok: false,
      reason: "shared-office targets require the sitting Mayor; Phase 2 keeps no terms record to verify against",
    };
  }
  return { ok: false, reason: "requester is not the target's actor (nor its on-behalf member)" };
}

// ---------------------------------------------------------------------------
// Processing — one operation, end to end (brief §8.5). Called by the
// dispatcher inside a player-caused wake, AFTER that wake's queued
// actions have committed (brief §1.3 wake order, §8.4 step 2), so a
// dependent landing in the same wake is visible to the revalidation
// below (TC-U07). Undo processing never triggers a ripeness scan.
// ---------------------------------------------------------------------------

export async function processUndoOperation(
  db: Firestore,
  opId: string,
  opts: { now: string }
): Promise<Record<string, unknown>> {
  const opRef = doc(db, "sim_undo_operations", opId);
  const opSnap = await getDoc(opRef);
  if (!opSnap.exists()) throw new UndoError("OP_NOT_FOUND", `undo operation ${opId} does not exist.`);
  const op = opSnap.data() as Record<string, unknown>;
  if (["completed", "refused", "failed"].includes(op.status as string)) return op;

  const targetResolutionId = op.targetResolutionId as string | null;
  await updateDoc(opRef, { status: "checking", updatedAt: new Date(opts.now) });

  if (!targetResolutionId) {
    await updateDoc(opRef, {
      status: "failed",
      failure: { code: "TARGET_NOT_FOUND", message: "operation names no target resolution." },
      updatedAt: new Date(opts.now),
    });
    return { ...op, status: "failed" };
  }
  const target = await readManifest(db, targetResolutionId);
  if (!target || targetResolutionId === "genesis") {
    await updateDoc(opRef, {
      status: "failed",
      failure: {
        code: "TARGET_NOT_FOUND",
        message:
          targetResolutionId === "genesis"
            ? "genesis is never undoable."
            : `resolution ${targetResolutionId} does not stand (already undone or never existed).`,
      },
      updatedAt: new Date(opts.now),
    });
    return { ...op, status: "failed" };
  }
  if (target.sourceKind !== "action") {
    await updateDoc(opRef, {
      status: "refused",
      failure: {
        code: "TARGET_NOT_UNDOABLE",
        message: "ripening and voiding resolutions are not undoable in Phase 2 (P2-K5).",
      },
      updatedAt: new Date(opts.now),
    });
    return { ...op, status: "refused" };
  }

  const counterSnap = await getDoc(doc(db, "sim_counters", "log"));
  const counter = counterSnap.data() as Record<string, unknown>;
  const report = await buildDependencyReport(db, target, counter);
  const targetActor = await entryActor(db, target.resolutionId, target.lastSeq);
  const authority = checkUndoAuthority(targetActor, op.requesterUid as string);

  if (!authority.ok) {
    await updateDoc(opRef, {
      status: "refused",
      dependencyReport: report,
      failure: { code: "UNDO_NOT_AUTHORIZED", message: authority.reason },
      updatedAt: new Date(opts.now),
    });
    return { ...op, status: "refused" };
  }
  if (report.structuralSuccessor || report.semanticBlockers.length > 0) {
    await updateDoc(opRef, {
      status: "refused",
      dependencyReport: report,
      failure: {
        code: report.structuralSuccessor ? "NOT_SUFFIX" : "DEPENDENTS_EXIST",
        message: report.structuralSuccessor
          ? `Target is not the Log's tail; first structural successor is ${report.structuralSuccessor.resolutionId}. Undo unwinds LIFO: erase the successor first.`
          : `${report.semanticBlockers.length} semantic dependency blocker(s) — see dependencyReport.`,
      },
      updatedAt: new Date(opts.now),
    });
    return { ...op, status: "refused" };
  }

  // Execute: full revalidation inside the restore transaction (§8.5).
  await updateDoc(opRef, { status: "executing", dependencyReport: report, updatedAt: new Date(opts.now) });
  try {
    const completion = await runTransaction(db, async (tx) => {
      const stale = (message: string) => new UndoError("STALE_PROOF", message);
      const counterTxSnap = await tx.get(doc(db, "sim_counters", "log"));
      const counterTx = counterTxSnap.data() as Record<string, unknown>;
      if (counterTx.lastSeq !== report.checkedHeadSeq || counterTx.lastSeq !== target.lastSeq) {
        throw stale("the Log head moved after the dependency report was built.");
      }
      const opTxSnap = await tx.get(opRef);
      const opTx = opTxSnap.data() as Record<string, unknown>;
      if (opTx.status !== "executing") throw stale("the operation is no longer executing.");

      // Re-verify every standing after-state.
      let restoredDocCount = 0;
      for (const write of target.writeSet) {
        if (write.recordClass !== "state" && write.recordClass !== "pending") continue;
        const ref = refFor(db, write.path);
        const snap = await tx.get(ref);
        const current = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
        if (headHashOf(current) !== headHashOf(write.afterDoc)) {
          throw stale(`${write.path} no longer matches the target's after-state.`);
        }
        if (write.recordClass === "pending" && write.op === "create") {
          const referencedBy = (current?.referencedByRefKeys as string[] | undefined) ?? [];
          if (current?.status !== "pending" || referencedBy.length > 0) {
            throw stale(`pending ${write.path} ripened or was referenced after the report.`);
          }
        }
      }

      // Restore.
      let counterRestored = false;
      for (const write of target.writeSet) {
        const ref = refFor(db, write.path);
        if (write.recordClass === "log") continue;
        if (write.recordClass === "control") {
          if (write.path === "sim_counters/log") {
            // Counter restored EXACTLY from its manifest snapshot (not
            // merged): TC-U02's hash-restoration claim covers the whole
            // counter doc, updatedAt included.
            if (write.beforeDoc) {
              tx.set(ref, write.beforeDoc);
              counterRestored = true;
            }
            continue;
          }
          if (write.path === "sim_world/current") {
            if (write.beforeDoc) tx.set(ref, write.beforeDoc);
            continue;
          }
          if (write.path === (target.actionId ? `sim_actions/${target.actionId}` : "")) {
            tx.delete(ref); // the source action is erased with its resolution (§8.5)
            continue;
          }
          throw stale(`unknown control record in write set: ${write.path}`);
        }
        if (write.op === "create") {
          tx.delete(ref);
        } else if (write.beforeDoc) {
          tx.set(ref, write.beforeDoc);
        }
        restoredDocCount += 1;
      }
      if (!counterRestored) {
        // Fallback for manifests without a counter snapshot: the
        // counterBefore triple is the contract (§2.2).
        tx.set(doc(db, "sim_counters", "log"), {
          ...counterTx,
          lastSeq: target.counterBefore.lastSeq,
          lastEntryHash: target.counterBefore.lastEntryHash,
          lastResolutionId: target.counterBefore.lastResolutionId,
          updatedAt: new Date(opts.now),
        });
      }
      // Entries + manifest erased.
      for (let seq = target.firstSeq; seq <= target.lastSeq; seq += 1) {
        tx.delete(doc(db, "sim_log_entries", String(seq).padStart(12, "0")));
      }
      tx.delete(manifestRef(db, target.resolutionId));

      const completionProof = {
        oldHeadSeq: target.lastSeq,
        oldHeadHash: counterTx.lastEntryHash as string,
        newHeadSeq: target.counterBefore.lastSeq,
        newHeadHash: target.counterBefore.lastEntryHash,
        erasedEntryCount: target.lastSeq - target.firstSeq + 1,
        erasedResolutionId: target.resolutionId,
        restoredDocCount,
        dependencyProofDigest: report.proofDigest,
      };
      tx.update(opRef, {
        status: "completed",
        targetResolutionId: null,
        completion: completionProof,
        dependencyReport: report,
        failure: null,
        completedAt: new Date(opts.now),
        updatedAt: new Date(opts.now),
      });
      return completionProof;
    });
    return { ...op, status: "completed", completion };
  } catch (error) {
    if (error instanceof UndoError && error.code === "STALE_PROOF") {
      await updateDoc(opRef, {
        status: "checking",
        failure: { code: "STALE_PROOF", message: error.message },
        updatedAt: new Date(opts.now),
      });
      return { ...op, status: "checking" };
    }
    throw error;
  }
}
