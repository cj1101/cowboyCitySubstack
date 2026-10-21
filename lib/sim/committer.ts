/**
 * The committer (Phase 2 brief §4) — the only write path for resolutions.
 *
 * One Firestore transaction per Resolution Event carries: the state
 * writes, the Log entries, the resolution manifest, the seq counter, and
 * the source action's terminal state (brief §1.2/§4.4). The committer
 * re-derives the plan from its own in-transaction snapshot and compares
 * it against the previewed plan — a commit never trusts a plan computed
 * elsewhere — then validates head continuity, allocates seqs, chains
 * hashes, stamps manifests, and enforces the ceilings, all before the
 * first write lands.
 *
 * Failure taxonomy (§4.6): deterministic domain rejection ⇒ a committed
 * `rejected` Resolution Event; infrastructure failure ⇒ NO Log entry;
 * integrity failure (head mismatch, input-hash mismatch) ⇒ abort with
 * an integrity flag, never a repair.
 *
 * Rules posture: this module runs as the committer identity (claims
 * `fabric: true, fabricRole: "committer"`) through the modular client
 * SDK, so every write below is rules-bound (brief §1.2).
 */

import {
  doc,
  runTransaction,
  type Firestore,
  type Transaction,
} from "firebase/firestore";
import { canonicalJson, sha256Hex } from "./canonical";
import { buildLogEntry, headHashOf, projectFirestoreValue, refKey } from "./log";
import {
  COMMITTER_VERSION,
  MAX_MANIFEST_BYTES,
  MAX_WRITES_PER_RESOLUTION,
  RESOLVER_RULES_VERSION,
  snapshotDoc,
  type ResolutionPlan,
  type SimAction,
  type SimSnapshot,
  type SnapshotHead,
} from "./state";
import { citableBaselineVersion, type BaselineRegistry } from "./baseline/registry";
import { RULE_DESCRIPTORS } from "./rules/registry";
import { ruleEffectDraft } from "./rules/planHelpers";
import {
  buildRipenessView,
  evaluateRipeness,
  type RipenessVerdict,
} from "./rules/pendingRules";
import {
  buildChronicleDraftDoc,
  chronicleDraftIdForResolution,
} from "./rules/lore";
import {
  PlanValidationError,
  finalizePlan,
  resolveAction,
  resolveRipening,
  resolveVoiding,
  snapshotFromDocs,
  validatePlan,
} from "./resolver";
import { resolveWakePassStep, type WakePassStep } from "./wakeSteps";

export class CommitError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export type CommitOutcome =
  | { status: "committed"; manifest: Record<string, unknown> }
  | { status: "already-committed"; manifest: Record<string, unknown> }
  | { status: "stale-preview" }
  | { status: "aborted"; code: string; message: string }
  /** P4-K20 (Phase 4 close-out, E2): the in-transaction AGR guard
   * re-evaluated the pending's ripeness on this transaction's snapshot
   * and the verdict FLIPPED against the dispatched source kind —
   * nothing was written. The scan executes the flipped outcome
   * (ripen <-> void <-> wait) in a fresh commit; a stale verdict is
   * never committed. */
  | { status: "verdict-flip"; verdict: RipenessVerdict };

export interface CommitRequest {
  resolutionId: string;
  sourceKind: "action" | "pending-ripening" | "pending-voiding" | "wake-pass";
  /** sourceKind "wake-pass" (Phase 5 PR-4): the pass step spec. A spec
   *  is an ADDRESS, not a payload — Step 4 re-derives the plan from it
   *  on the transaction's snapshot and the recomputed plan governs
   *  (the P4-K20 doctrine), so no planHash parity is required of the
   *  executor's pre-computation. */
  passStep?: WakePassStep;
  /** The wake cycle a wake-pass step belongs to (id derivation). */
  cycleId?: string;
  /** Injected instant for the whole event (F3 — every Phase 2 timestamp
   * derives from it, deterministically). */
  now: string;
  committerVersion?: string;
  /** The dispatcher's plan (previewed for actions; freshly resolved for
   * wake resolutions) + the heads of the snapshot it was computed from. */
  plan: ResolutionPlan;
  expectedHeads: SnapshotHead[];
  snapshotPaths: string[];
  /** The read plan's materialized collection queries (F-01), if any.
   * Every result doc rides `snapshotPaths`, so the transaction re-reads
   * and head-compares each one exactly like a declared doc read, and
   * the records land in the manifest's input set (`queryInputs`) for
   * the undo closure and audit. Set MEMBERSHIP is bound at the
   * dispatcher's materialization in the same wake step: this pinned
   * SDK's Transaction has no typed query read, so in-transaction
   * re-execution of the query itself waits for the client-SDK upgrade
   * (PR-F) — noted as the one residual F-01 gap in the Step 0 report. */
  queryRecords?: import("./state").SnapshotQueryRecord[];
  /** sourceKind "action": the claimed action doc as dispatched. */
  action?: SimAction;
  claimLeaseId?: string | null;
  /** The prepared payload the dispatcher's plan was computed with, if
   * any — the in-transaction recompute must see the same payload or a
   * generative ripening could never match its own plan. */
  prepared?: import("./state").PreparedPayload;
  preparedInputHash?: string | null;
  /** sourceKind pending-*: the claimed pending doc as dispatched. */
  pending?: Record<string, unknown>;
  /** Wake occasion for ripening/voiding (occasion, never cause). */
  wakeActionId?: string | null;
  executedDuringSeq?: number | null;
  voidReason?: string;
}

export interface CommitterDeps {
  db: Firestore;
  baselineRegistry: BaselineRegistry;
}

const COUNTER_PATH = "sim_counters/log";
const WORLD_PATH = "sim_world/current";

function ref(db: Firestore, path: string) {
  const segments = path.split("/");
  return doc(db, segments[0], ...segments.slice(1));
}

function logEntryPath(seq: number): string {
  return `sim_log_entries/${String(seq).padStart(12, "0")}`;
}

/** The commit's identity hash (§2.2/§4.4): over the REQUEST — the action
 * payload, the prepared payload's hash, and the input heads the plan was
 * computed from. A retry of the same commit step recomputes the same
 * hash; a different plan for the same resolutionId cannot. */
export function computeCommitInputHash(req: CommitRequest): string {
  return sha256Hex(
    projectFirestoreValue({
      sourceKind: req.sourceKind,
      resolutionId: req.resolutionId,
      actionPayload: req.action
        ? {
            actionId: req.action.actionId,
            actor: req.action.actor,
            actionType: req.action.actionType,
            actionText: req.action.actionText,
            structuredAction: req.action.structuredAction,
            targetCityIds: req.action.targetCityIds,
          }
        : null,
      pendingId: (req.pending?.pendingId as string | undefined) ?? null,
      pendingStateVersion:
        typeof req.pending?.stateVersion === "number" ? req.pending.stateVersion : null,
      passStep: req.passStep ?? null,
      inputHeads: req.expectedHeads,
      preparedInputHash: req.preparedInputHash ?? null,
    }) as Record<string, unknown>
  );
}

interface TxReads {
  docs: Map<string, Record<string, unknown> | null>;
}

async function readAll(
  tx: Transaction,
  db: Firestore,
  paths: readonly string[]
): Promise<TxReads> {
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of paths) {
    const snap = await tx.get(ref(db, path));
    docs.set(path, snap.exists() ? (snap.data() as Record<string, unknown>) : null);
  }
  return { docs };
}

function stateHeadsOf(snapshot: SimSnapshot, exclude: Set<string>): SnapshotHead[] {
  return snapshot.heads.filter((h) => !exclude.has(h.path));
}

/** Chronicle-draft badging derivation (Phase 4 step 11 assembly —
 * prep report §4(b)). A RESOLVED plan's chronicle outputs become one
 * sim-badged draft in the existing `drafts` collection, deterministic
 * in the resolution: the id is Wren's `chronicle_<id>` form, the title
 * is the telling's first non-empty line capped at 120 chars, the body
 * carries every chronicle output's text in plan order (a resolution
 * gets exactly one draft — the id leaves no room for a second), and
 * the provenance rules are the summary entry's. Rejected plans badge
 * nothing (a rejection changes no state). A chronicle output whose
 * plan has no summary entry naming a subject city fails the commit
 * closed: a chronicle without a city is unbadgeable. Pure and
 * exported so the harness exercises the shipped derivation, not a
 * copy. */
export function deriveChronicleBadging(
  plan: ResolutionPlan,
  resolutionId: string
): { draftId: string; path: string; doc: Record<string, unknown> } | null {
  if (plan.outcome !== "resolved") return null;
  const outputs = plan.narrativeOutputs.filter((o) => o.kind === "chronicle");
  if (outputs.length === 0) return null;
  const summary = plan.entries.find((e) => e.summary);
  if (!summary || summary.cityId === null) {
    throw new CommitError(
      "CHRONICLE_UNBADGEABLE",
      `resolution ${resolutionId} emits a chronicle output but its summary entry names no subject city — a chronicle without a city is unbadgeable.`
    );
  }
  const titleLine =
    outputs[0].text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "Chronicle";
  const draftId = chronicleDraftIdForResolution(resolutionId);
  return {
    draftId,
    path: `drafts/${draftId}`,
    doc: buildChronicleDraftDoc({
      resolutionId,
      cityId: summary.cityId,
      title: titleLine.slice(0, 120),
      body: outputs.map((o) => o.text).join("\n\n"),
      sourceRuleIds: [...summary.ruleIds],
    }),
  };
}

export async function commitResolution(
  deps: CommitterDeps,
  req: CommitRequest
): Promise<CommitOutcome> {
  const { db } = deps;
  const now = req.now;
  const inputHash = computeCommitInputHash(req);
  const manifestPath = `sim_resolutions/${req.resolutionId}`;
  const actionPath = req.action ? `sim_actions/${req.action.actionId}` : null;
  const controlPaths = new Set<string>([
    COUNTER_PATH,
    WORLD_PATH,
    manifestPath,
    ...(actionPath ? [actionPath] : []),
  ]);

  return runTransaction(db, async (tx) => {
    // -- Step 2: existence + idempotency ---------------------------------
    const readPaths = [
      ...new Set([
        COUNTER_PATH,
        WORLD_PATH,
        manifestPath,
        ...(actionPath ? [actionPath] : []),
        ...req.snapshotPaths,
      ]),
    ];
    const { docs } = await readAll(tx, db, readPaths);
    const counter = docs.get(COUNTER_PATH) ?? null;
    if (!counter || typeof counter.lastSeq !== "number") {
      throw new CommitError(
        "LOG_NOT_INITIALIZED",
        "sim_counters/log is missing — genesis has not run in this world."
      );
    }
    const existingManifest = docs.get(manifestPath) ?? null;
    if (existingManifest) {
      if (existingManifest.inputHash === inputHash) {
        return { status: "already-committed", manifest: existingManifest } as CommitOutcome;
      }
      throw new CommitError(
        "INTEGRITY_INPUT_MISMATCH",
        `A manifest for ${req.resolutionId} exists with a different inputHash — possible replay with altered inputs. Aborting; nothing was written.`
      );
    }

    // -- Step 3: head validity + authority/claim currency ----------------
    const world = docs.get(WORLD_PATH) ?? null;
    if (!world) {
      throw new CommitError("LOG_HEAD_MISMATCH", "sim_world/current is missing.");
    }
    if (world.lastCommittedSeq !== counter.lastSeq) {
      throw new CommitError(
        "LOG_HEAD_MISMATCH",
        `world head (${String(world.lastCommittedSeq)}) disagrees with the counter (${counter.lastSeq}) — aborting; heads are never repaired silently.`
      );
    }
    if ((counter.lastSeq as number) > 0) {
      const headPath = logEntryPath(counter.lastSeq as number);
      const headSnap = await tx.get(ref(db, headPath));
      const head = headSnap.exists() ? (headSnap.data() as Record<string, unknown>) : null;
      if (!head || head.entryHash !== counter.lastEntryHash) {
        throw new CommitError(
          "LOG_HEAD_MISMATCH",
          `head entry at seq ${counter.lastSeq} does not match the counter's lastEntryHash — aborting.`
        );
      }
      docs.set(headPath, head);
    }

    let txAction: SimAction | null = null;
    if (req.sourceKind === "action") {
      txAction = (docs.get(actionPath as string) ?? null) as SimAction | null;
      if (!txAction) {
        throw new CommitError("ACTION_MISSING", `action ${req.action?.actionId} not found at commit.`);
      }
      if (txAction.status !== "resolving" || txAction.claim?.leaseId !== req.claimLeaseId) {
        return {
          status: "aborted",
          code: "CLAIM_LOST",
          message: "the action is no longer claimed by this committer (lease lost or status moved).",
        } as CommitOutcome;
      }
      if (
        txAction.confirmation &&
        txAction.preview &&
        txAction.confirmation.previewHash !==
          (txAction.preview as Record<string, unknown>).previewHash
      ) {
        throw new CommitError(
          "INTEGRITY_STATE",
          "confirmation is not bound to the stored preview hash."
        );
      }
    }
    let txPending: Record<string, unknown> | null = null;
    if (req.sourceKind === "pending-ripening" || req.sourceKind === "pending-voiding") {
      const pendingPath = `sim_pending_consequences/${req.pending?.pendingId as string}`;
      txPending = docs.get(pendingPath) ?? null;
      if (
        !txPending ||
        txPending.status !== "ripening-claimed" ||
        (txPending.claim as { leaseId?: string } | null)?.leaseId !== req.claimLeaseId
      ) {
        return {
          status: "aborted",
          code: "PENDING_CLAIM_LOST",
          message: "the pending is no longer claimed by this committer.",
        } as CommitOutcome;
      }
    }

    // -- Step 4: recompute the plan on the transaction's snapshot --------
    // The read plan's query records (F-01) re-attach here: the result
    // docs in `docs` are this transaction's re-reads, head-compared
    // below, and the recompute must see the same materialized set the
    // dispatcher's plan was computed from — dropping the records makes
    // every query-plan handler recompute to READ_PLAN_MISSING and the
    // resolution falls out as a spurious stale preview.
    const txSnapshot = snapshotFromDocs(docs, now, req.queryRecords ?? []);
    const stateExcluded = new Set([...controlPaths, logEntryPath(counter.lastSeq as number)]);
    const expectedStateHeads = stateHeadsOf(
      { ...txSnapshot, heads: req.expectedHeads },
      stateExcluded
    );
    const txStateHeads = stateHeadsOf(txSnapshot, stateExcluded);
    const headsDiffer =
      JSON.stringify(expectedStateHeads) !== JSON.stringify(txStateHeads);

    let plan: ResolutionPlan;
    if (req.sourceKind === "action") {
      plan = resolveAction(txSnapshot, txAction as SimAction, {
        baselineRegistry: deps.baselineRegistry,
        mode: "commit",
        prepared: req.prepared,
      });
    } else if (req.sourceKind === "pending-ripening") {
      plan = resolveRipening(txSnapshot, txPending as Record<string, unknown>, {
        baselineRegistry: deps.baselineRegistry,
        prepared: req.prepared,
      });
    } else if (req.sourceKind === "wake-pass") {
      plan = resolveWakePassStep(txSnapshot, req.passStep as WakePassStep, {
        resolutionId: req.resolutionId,
        cycleId: req.cycleId ?? "",
        baselineRegistry: deps.baselineRegistry,
      });
    } else {
      plan = resolveVoiding(txSnapshot, txPending as Record<string, unknown>, {
        baselineRegistry: deps.baselineRegistry,
        voidReason: req.voidReason ?? "a ripen precondition ceased to hold",
      });
    }

    // -- Step 4b: P4-K20 in-transaction AGR guard (Phase 4 close-out,
    // E2). For pending resolutions, the ripeness predicate is
    // re-evaluated HERE, on this transaction's snapshot — scan-time
    // evaluation was scheduling only, never the decision. A verdict
    // that flipped since the scan (a void-clause precondition died,
    // or revived) aborts this commit with the flipped verdict and
    // ZERO writes; the scan executes the flipped outcome instead.
    // This closes the resolve->commit window the scan-side
    // re-evaluation (pending.ts) cannot see.
    if (req.sourceKind !== "action" && txPending) {
      const guardView = buildRipenessView(txPending, {
        counter,
        nowIso: now,
        docByPath: (path) => snapshotDoc(txSnapshot, path),
      });
      const guardVerdict = evaluateRipeness(txPending, guardView);
      const expectedState = req.sourceKind === "pending-ripening" ? "ripe" : "void";
      if (guardVerdict.state !== expectedState) {
        return { status: "verdict-flip", verdict: guardVerdict } as CommitOutcome;
      }
    }

    if (req.sourceKind === "wake-pass") {
      // Wake-pass steps carry no previewed plan to be faithful to:
      // the spec is an address and the plan recomputed on THIS
      // transaction's snapshot governs wholesale — the same doctrine
      // as the AGR verdict-flip guard, generalized. A step that
      // re-derives to nothing (its subject was handled, returned, or
      // terminated by an earlier step of this same wake) is refused
      // here, before seq allocation: zero-entry plans never commit.
      if (plan.entries.length === 0) {
        return {
          status: "aborted",
          code: "PASS_STEP_NOOP",
          message:
            "the wake-pass step re-derived to a no-op on the transaction snapshot (its subject no longer stands as the spec addresses it) — nothing was written.",
        } as CommitOutcome;
      }
    } else {
      const authorityRejection =
        plan.outcome === "rejected" &&
        plan.rejection?.code === "AUTHORITY_REVOKED" &&
        req.plan.outcome !== "rejected";
      if (!authorityRejection && (plan.planHash !== req.plan.planHash || headsDiffer)) {
        // The world moved under the preview: no Log entry, no state change.
        // The dispatcher stores a fresh preview and the action returns to
        // awaiting_confirmation (TC-E01 parity is defined on previews).
        return { status: "stale-preview" } as CommitOutcome;
      }
      if (!authorityRejection) {
        // §4.4: authority revoked since confirmation is a deterministic
        // rejection event, not a stale preview — so only in the authority
        // case does the recomputed (rejection) plan replace the previewed
        // one; otherwise the previewed plan, now proven identical, commits.
        plan = req.plan;
      }
    }

    // -- Step 5: ceilings -------------------------------------------------
    const countWrites = (p: ResolutionPlan) =>
      2 + // counter + manifest
      1 + // world
      p.entries.length +
      p.writes.length +
      p.pendingCreates.length +
      p.pendingTransitions.length +
      p.pendingReferenceWrites.length +
      // The chronicle badge write (step 11 badging, §4(b)): one
      // drafts/ write per resolved plan carrying chronicle outputs,
      // counted here so the ceiling sees it before Step 6 derives it.
      (p.outcome === "resolved" &&
      p.narrativeOutputs.some((o) => o.kind === "chronicle")
        ? 1
        : 0) +
      (req.sourceKind === "action" ? 1 : 0);
    if (countWrites(plan) > MAX_WRITES_PER_RESOLUTION) {
      if (req.sourceKind !== "action") {
        throw new CommitError(
          "WRITE_SET_TOO_LARGE",
          `${req.sourceKind} plan for ${req.resolutionId} exceeds ${MAX_WRITES_PER_RESOLUTION} transactional writes — treated as a generation failure.`
        );
      }
      plan = writeSetTooLargePlan(req, txAction as SimAction);
    }

    // §5.6/§6.3 plan guards, re-run on the final plan — including the
    // F-02 changes↔writes reconciliation against this transaction's
    // snapshot (Phase 4 Step 0).
    try {
      validatePlan(plan, {
        baselineRegistry: deps.baselineRegistry,
        covertEntriesAllowed:
          plan.descriptorId !== null &&
          RULE_DESCRIPTORS[plan.descriptorId]?.visibility === "covert",
        snapshot: txSnapshot,
      });
    } catch (error) {
      if (error instanceof PlanValidationError) {
        throw new CommitError("PLAN_INVALID", error.message);
      }
      throw error;
    }

    // -- Step 6: allocate seqs, stamp docs, build entries + manifest -----
    const firstSeq = (counter.lastSeq as number) + 1;
    const lastSeq = firstSeq + plan.entries.length - 1;
    const summarySeq = lastSeq;

    // Finalize state/pending writes (committer stamps: stateVersion bump,
    // lastChangedSeq/lastResolutionId, updatedAt).
    interface FinalWrite {
      path: string;
      op: "create" | "update" | "delete";
      recordClass: string;
      beforeDoc: Record<string, unknown> | null;
      afterDoc: Record<string, unknown> | null;
      changedFields: string[];
    }
    const finalWrites: FinalWrite[] = [];
    const stampDoc = (
      before: Record<string, unknown> | null,
      after: Record<string, unknown>
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = { ...after };
      if (before && typeof before.stateVersion === "number") {
        out.stateVersion = (before.stateVersion as number) + 1;
      }
      if ("lastChangedSeq" in out) out.lastChangedSeq = summarySeq;
      if ("lastResolutionId" in out) out.lastResolutionId = req.resolutionId;
      if ("updatedAt" in out) out.updatedAt = new Date(now);
      // Plans are clock-free (a preview and its commit happen at
      // different instants yet must hash identically): creation
      // timestamps are stamped here, inside the transaction.
      if (before === null && "createdAt" in out) out.createdAt = new Date(now);
      return out;
    };
    for (const write of plan.writes) {
      const before = docs.get(write.path) ?? null;
      finalWrites.push({
        path: write.path,
        op: write.op,
        recordClass: write.recordClass,
        beforeDoc: before,
        afterDoc:
          write.op === "delete" || !write.afterDoc
            ? null
            : stampDoc(before, write.afterDoc),
        changedFields: write.changedFields,
      });
    }

    // Pending creates: stamp the committer-finalized fields (§2.4).
    for (const draft of plan.pendingCreates) {
      const docOut: Record<string, unknown> = { ...draft.doc };
      const originSeq =
        typeof docOut.originSeq === "number" ? (docOut.originSeq as number) : summarySeq;
      docOut.originSeq = originSeq;
      docOut.createdAtSeq = summarySeq;
      docOut.createdBySeq =
        docOut.sourceKind === "ripening" ? summarySeq : null;
      docOut.createdAt = new Date(now);
      docOut.updatedAt = new Date(now);
      const condition = { ...(docOut.ripenCondition as Record<string, unknown>) };
      // P4-K19 anchoring (Phase 4 close-out, E1): requiredSeq anchors
      // to the pending's CREATION seq (this event's summary seq) —
      // originSeq stays purely the attribution/cause field. Anchoring
      // a child to its chain origin let requiredSeq land at or before
      // the child's own createdAtSeq, so only its wall floor delayed
      // it; a generation-1 pending is unaffected (its originSeq IS
      // its creation seq).
      condition.requiredSeq =
        summarySeq + (condition.minSeqAdvance as number);
      condition.eligibleAt = new Date(
        Date.parse(now) + (condition.minWallElapsedHours as number) * 3_600_000
      );
      docOut.ripenCondition = condition;
      finalWrites.push({
        path: `sim_pending_consequences/${docOut.pendingId as string}`,
        op: "create",
        recordClass: "pending",
        beforeDoc: null,
        afterDoc: docOut,
        changedFields: ["status"],
      });
    }

    // Pending reference registrations + transitions (one working doc per
    // pending, stateVersion bumped once per commit per pending).
    const pendingFinal = new Map<string, { doc: Record<string, unknown>; fields: string[] }>();
    const pendingWorking = (pendingId: string) => {
      const path = `sim_pending_consequences/${pendingId}`;
      if (!pendingFinal.has(path)) {
        const before = docs.get(path) ?? null;
        if (!before) {
          throw new CommitError(
            "PENDING_MISSING",
            `pending ${pendingId} was not in the transaction's read set or does not exist.`
          );
        }
        pendingFinal.set(path, { doc: { ...before }, fields: [] });
      }
      return pendingFinal.get(path) as { doc: Record<string, unknown>; fields: string[] };
    };
    for (const reference of plan.pendingReferenceWrites) {
      const working = pendingWorking(reference.pendingId);
      const keys = (working.doc.referencedByRefKeys as string[] | undefined) ?? [];
      const key = refKey.resolution(req.resolutionId);
      if (!keys.includes(key)) working.doc.referencedByRefKeys = [...keys, key];
      working.fields.push("referencedByRefKeys");
    }
    for (const transition of plan.pendingTransitions) {
      const working = pendingWorking(transition.pendingId);
      working.doc.status = transition.toStatus;
      working.doc.claim = null;
      if (transition.toStatus === "ripened") {
        working.doc.ripenedAtSeq = summarySeq;
        working.doc.ripenedAt = new Date(now);
        working.doc.ripensInResolutionId = req.resolutionId;
        working.doc.outcomeSummary = transition.outcomeSummary ?? null;
        working.fields.push("status", "ripenedAtSeq", "ripensInResolutionId");
      } else {
        working.doc.voidedAtSeq = summarySeq;
        working.doc.voidReason = transition.voidReason ?? null;
        working.fields.push("status", "voidedAtSeq", "voidReason");
      }
    }
    for (const [path, working] of pendingFinal) {
      const before = docs.get(path) ?? null;
      const after = stampDoc(before, working.doc);
      finalWrites.push({
        path,
        op: "update",
        recordClass: "pending",
        beforeDoc: before,
        afterDoc: after,
        changedFields: [...new Set(working.fields)],
      });
    }

    // Chronicle badging (Phase 4 step 11 assembly — prep report
    // §4(b)): the plan's chronicle outputs become a sim-badged draft
    // write, derived here — after the plan's own writes are finalized,
    // before the Log entries are built — and stamped like every
    // plan-produced record (the helper emits null timestamp
    // placeholders for exactly this). As a finalWrites member with
    // recordClass "state", the draft is inside the manifest write set,
    // the write ceiling (counted at Step 5), and undo/erase
    // accounting. Preview parity needs no hash work: finalizePlan
    // hashes the whole plan, narrativeOutputs included (verified), so
    // the output a member confirmed is the output that badges.
    const badging = deriveChronicleBadging(plan, req.resolutionId);
    if (badging) {
      const before = docs.get(badging.path) ?? null;
      finalWrites.push({
        path: badging.path,
        op: before ? "update" : "create",
        recordClass: "state",
        beforeDoc: before,
        afterDoc: stampDoc(before, badging.doc),
        changedFields: ["badge", "canonLayer", "sourceResolutionId"],
      });
    }

    // Control records: world, counter, source action.
    const worldAfter: Record<string, unknown> = {
      ...world,
      lastCommittedSeq: lastSeq,
      updatedAt: new Date(now),
    };
    // P4-K24 tally (Phase 4 close-out, E4): lastResolvedSeq advances
    // ONLY on a resolved outcome — a rejected resolution is fully
    // logged but mints no delay progress. A counter predating the
    // tally bootstraps at 0 (conservative: ripenings wait for the
    // next resolved event rather than inheriting head-space credit).
    const resolvedSeqBefore =
      typeof counter.lastResolvedSeq === "number" ? (counter.lastResolvedSeq as number) : 0;
    const resolvedSeqAfter = plan.outcome === "resolved" ? lastSeq : resolvedSeqBefore;
    const counterAfter: Record<string, unknown> = {
      ...counter,
      lastSeq,
      lastResolvedSeq: resolvedSeqAfter,
      lastResolutionId: req.resolutionId,
      updatedAt: new Date(now),
    };
    // lastEntryHash is filled after the entries are built (below) — the
    // counter's afterDoc in the manifest carries it too.
    let actionAfter: Record<string, unknown> | null = null;
    if (txAction) {
      actionAfter = {
        ...(txAction as unknown as Record<string, unknown>),
        status: plan.outcome === "rejected" ? "rejected" : "resolved",
        resolutionId: req.resolutionId,
        firstLogSeq: firstSeq,
        lastLogSeq: lastSeq,
        failure:
          plan.outcome === "rejected" && plan.rejection
            ? { code: plan.rejection.code, message: plan.rejection.summaryText }
            : null,
        updatedAt: new Date(now),
      };
    }

    const writeSet = finalWrites.map((w) => ({
      path: w.path,
      op: w.op,
      recordClass: w.recordClass,
      beforeHash: headHashOf(w.beforeDoc),
      afterHash: headHashOf(w.afterDoc),
      beforeDoc: w.beforeDoc,
      afterDoc: w.afterDoc,
      stateVersionBefore:
        w.beforeDoc && typeof w.beforeDoc.stateVersion === "number"
          ? (w.beforeDoc.stateVersion as number)
          : null,
      stateVersionAfter:
        w.afterDoc && typeof w.afterDoc.stateVersion === "number"
          ? (w.afterDoc.stateVersion as number)
          : null,
    }));
    const stateHeadsAfter = finalWrites
      .filter((w) => w.recordClass === "state" || w.recordClass === "pending")
      .map((w) => ({
        path: w.path,
        afterHash: headHashOf(w.afterDoc),
        stateVersion:
          w.afterDoc && typeof w.afterDoc.stateVersion === "number"
            ? (w.afterDoc.stateVersion as number)
            : null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const writeSetDigest = sha256Hex(
      projectFirestoreValue({ writeSet }) as Record<string, unknown>
    );

    // Entries, chained. When the resolution badged a chronicle draft,
    // the Log names the draft it told (§4(b)(3)): the summary entry
    // carries the stamp, and so does every rule-effect entry whose
    // ruleIds produced the output — NarrativeIntent carries no
    // per-output rule linkage of its own, so the producing set is the
    // summary entry's ruleIds.
    const producingRuleIds = new Set(
      plan.entries.find((e) => e.summary)?.ruleIds ?? []
    );
    const entryDrafts = badging
      ? plan.entries.map((draft) =>
          draft.summary || draft.ruleIds.some((r) => producingRuleIds.has(r))
            ? { ...draft, chronicleDraftId: badging.draftId }
            : draft
        )
      : plan.entries;
    let prevHash = counter.lastEntryHash as string;
    const builtEntries: { path: string; entry: Record<string, unknown> }[] = [];
    entryDrafts.forEach((draft, index) => {
      const seq = firstSeq + index;
      const entry = buildLogEntry(draft, {
        seq,
        resolutionSeq: index + 1,
        resolutionId: req.resolutionId,
        entryIndexWithinResolution: index + 1,
        resolvedAt: now,
        rulesVersion: RESOLVER_RULES_VERSION,
        prevHash,
        wakeActionId: req.wakeActionId ?? null,
        executedDuringSeq: req.executedDuringSeq ?? null,
        ...(draft.summary ? { writeSetDigest, stateHeadsAfter } : {}),
      });
      prevHash = entry.entryHash as string;
      builtEntries.push({ path: logEntryPath(seq), entry });
    });
    const summaryHash = prevHash;
    counterAfter.lastEntryHash = summaryHash;

    // Manifest.
    const citable = citableBaselineVersion(deps.baselineRegistry, firstSeq);
    const inputHeads = txStateHeads;
    const inputRefKeys = inputHeads.map((h) =>
      refKey.recordVersion(h.path, h.stateVersion)
    );
    const dependencyRefKeys = [
      ...new Set([
        ...inputRefKeys,
        ...plan.readRefKeys,
        ...(req.action ? [refKey.action(req.action.actionId)] : []),
      ]),
    ].sort();
    const outputRefKeys = [
      ...new Set([
        refKey.resolution(req.resolutionId),
        refKey.seq(firstSeq),
        ...(lastSeq !== firstSeq ? [refKey.seq(lastSeq)] : []),
        ...finalWrites.map((w) =>
          refKey.recordVersion(
            w.path,
            w.afterDoc && typeof w.afterDoc.stateVersion === "number"
              ? (w.afterDoc.stateVersion as number)
              : null
          )
        ),
      ]),
    ].sort();
    const controlWriteSet = [
      {
        path: WORLD_PATH,
        op: "update",
        recordClass: "control",
        beforeHash: headHashOf(world),
        afterHash: headHashOf(worldAfter),
        beforeDoc: world,
        afterDoc: worldAfter,
        stateVersionBefore: null,
        stateVersionAfter: null,
      },
      {
        path: COUNTER_PATH,
        op: "update",
        recordClass: "control",
        beforeHash: headHashOf(counter),
        afterHash: headHashOf(counterAfter),
        beforeDoc: counter,
        afterDoc: counterAfter,
        stateVersionBefore: null,
        stateVersionAfter: null,
      },
      ...(actionAfter && txAction
        ? [
            {
              path: actionPath as string,
              op: "update",
              recordClass: "control",
              beforeHash: headHashOf(txAction as unknown as Record<string, unknown>),
              afterHash: headHashOf(actionAfter),
              beforeDoc: txAction as unknown as Record<string, unknown>,
              afterDoc: actionAfter,
              stateVersionBefore: null,
              stateVersionAfter: null,
            },
          ]
        : []),
    ];
    const manifest: Record<string, unknown> = {
      resolutionId: req.resolutionId,
      schemaVersion: 2,
      sourceKind: req.sourceKind,
      actionId: req.action?.actionId ?? null,
      originActionId:
        req.sourceKind === "action"
          ? null
          : ((req.pending?.originActionId as string | null) ?? null),
      originSeq:
        req.sourceKind === "action"
          ? null
          : ((req.pending?.originSeq as number | null) ?? null),
      causedBySeq:
        req.sourceKind === "action"
          ? null
          : ((req.pending?.originSeq as number | null) ?? null),
      firstSeq,
      lastSeq,
      resolvedAt: new Date(now),
      rulesVersion: RESOLVER_RULES_VERSION,
      committerVersion: req.committerVersion ?? COMMITTER_VERSION,
      planHash: plan.planHash,
      previewHash:
        req.sourceKind === "action"
          ? ((txAction?.preview as Record<string, unknown> | null)?.previewHash ?? null)
          : null,
      inputHash,
      inputHeads,
      queryInputs: req.queryRecords ?? [],
      // F-07: the prepared payload the resolution consumed, stored with
      // the manifest — a later replay re-runs the handler against this
      // record, never a fresh worker call (banking V-B7's requirement).
      preparedPayload: req.prepared ?? null,
      inputRefKeys,
      dependencyRefKeys,
      outputRefKeys,
      writeSet: [...writeSet, ...controlWriteSet],
      writeSetDigest,
      baselineVersion: citable?.version ?? null,
      baselineDocHash: citable?.docHash ?? null,
      counterBefore: {
        lastSeq: counter.lastSeq,
        lastResolvedSeq:
          typeof counter.lastResolvedSeq === "number"
            ? (counter.lastResolvedSeq as number)
            : null,
        lastEntryHash: counter.lastEntryHash,
        lastResolutionId: counter.lastResolutionId ?? null,
      },
      counterAfter: {
        lastSeq,
        lastResolvedSeq: resolvedSeqAfter,
        lastEntryHash: summaryHash,
        lastResolutionId: req.resolutionId,
      },
    };

    const manifestBytes = canonicalJson(
      projectFirestoreValue(manifest) as Record<string, unknown>
    ).length;
    if (manifestBytes > MAX_MANIFEST_BYTES) {
      throw new CommitError(
        "MANIFEST_TOO_LARGE",
        `manifest for ${req.resolutionId} serializes to ${manifestBytes} bytes (> ${MAX_MANIFEST_BYTES}) — preflight refusal, zero writes.`
      );
    }

    // -- Step 7: write everything, transactionally ------------------------
    for (const { path, entry } of builtEntries) tx.set(ref(db, path), entry);
    tx.set(ref(db, manifestPath), manifest);
    tx.set(ref(db, WORLD_PATH), worldAfter);
    tx.set(ref(db, COUNTER_PATH), counterAfter);
    if (actionAfter && actionPath) tx.set(ref(db, actionPath), actionAfter);
    for (const w of finalWrites) {
      if (w.op === "delete") tx.delete(ref(db, w.path));
      else tx.set(ref(db, w.path), w.afterDoc as Record<string, unknown>);
    }

    return { status: "committed", manifest } as CommitOutcome;
  });
}

/** The deterministic WRITE_SET_TOO_LARGE rejection (§4.4/§4.5): a single
 * `rejected` entry; the attempted plan's state writes are simply never
 * applied. */
function writeSetTooLargePlan(req: CommitRequest, action: SimAction): ResolutionPlan {
  const ruleIds = [
    ...new Set(req.plan.entries.flatMap((e) => e.ruleIds)),
  ];
  // §3.2 citation carry-over (PR #45 CI round 8): this fallback
  // rebuilds the rejection entry from the raw action, which would
  // strip the citation the authority stage stamped on the attempted
  // plan's summary — for an NPC-actor action the standing entry
  // would stand as an orphan. The attempted plan's own stamped
  // mandate + trigger carry over verbatim when present (they are
  // the citation the stage verified for this very attempt).
  const attemptedSummary = req.plan.entries[req.plan.entries.length - 1];
  const attemptedClassification =
    attemptedSummary?.classification !== null &&
    typeof attemptedSummary?.classification === "object"
      ? (attemptedSummary.classification as Record<string, unknown>)
      : {};
  const carriedCitation: Record<string, unknown> = {};
  if (attemptedClassification.mandate !== undefined) {
    carriedCitation.mandate = attemptedClassification.mandate;
  }
  const attemptedTrigger = attemptedClassification.trigger as
    | Record<string, unknown>
    | undefined;
  if (attemptedTrigger && typeof attemptedTrigger.kind === "string") {
    carriedCitation.trigger = attemptedTrigger;
  }
  const plan: ResolutionPlan = {
    outcome: "rejected",
    descriptorId: req.plan.descriptorId,
    entries: [
      {
        ...ruleEffectDraft({
          actor: action.actor,
          cityId: action.targetCityIds[0] ?? null,
          cityIds: action.targetCityIds,
          ruleIds,
          summaryText: `Resolution ${req.resolutionId} rejected: its plan exceeded the ${MAX_WRITES_PER_RESOLUTION}-write transactional ceiling (WRITE_SET_TOO_LARGE). No state changed.`,
        }),
        kind: "rejected",
        summary: true,
        actionId: action.actionId,
        actionText: action.actionText,
        classification: {
          verb: null,
          scope: null,
          ruleIds,
          unruled: false,
          rejectionCode: "WRITE_SET_TOO_LARGE",
          ...carriedCitation,
        },
      },
    ],
    writes: [],
    pendingCreates: [],
    pendingTransitions: [],
    pendingReferenceWrites: [],
    readRefKeys: req.plan.readRefKeys,
    narrativeOutputs: [],
    planHash: "",
    rejection: {
      code: "WRITE_SET_TOO_LARGE",
      ruleIds,
      summaryText: `Plan exceeded ${MAX_WRITES_PER_RESOLUTION} transactional writes.`,
    },
  };
  return finalizePlan(plan);
}
