/**
 * Phase 5 PR-4 (wake completion) — the wake-pass step resolvers.
 *
 * Brief §1.3 steps 4–6 run as PASSES OVER THIS WAKE'S COMMITS, and every
 * pass product lands as its own Resolution Event through the committer
 * under sourceKind "wake-pass". This module is the pure half: given a
 * snapshot and a step SPEC, it re-derives the step's plan. A spec is an
 * ADDRESS, not a payload — it names the subject (a situation, a pending,
 * an envelope) and the few facts only the pass could know (the wake
 * cycle, a claim lease, a worker's returned outcome). Everything else
 * is re-derived from stored state, in the executor's materialized
 * snapshot before the commit and again inside the committer's
 * transaction (the P4-K20 doctrine: the transaction's derivation is
 * the decision; a pass pre-computation never forces a stale outcome).
 *
 * A step whose re-derivation finds nothing to do resolves to a
 * ZERO-ENTRY plan: the executor skips it, and the committer refuses it
 * (PASS_STEP_NOOP) if the world moved between the two derivations.
 * Zero-entry plans are never finalized and never committed.
 *
 * §1.4 bars honored by construction: no step reads a clock (the only
 * instant is snapshot.now, injected by the wake); no step scans the
 * ripeness machinery (passes never trigger scans); no step evaluates
 * delegation recursively (a situation a step creates is next-wake
 * business); no step spawns an envelope except as a delegation fire's
 * recorded product.
 */

import {
  emptyPlan,
  snapshotDoc,
  type CollectionQuerySpec,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
} from "./state";
import { planWrite, summaryDraft } from "./rules/planHelpers";
import { finalizePlan } from "./resolver";
import { canonicalJson, sha256HexOfText } from "./canonical";
import {
  applySilenceCommit,
  buildSituationDoc,
  markSituationHandled,
  planAttentionConversion,
  planSituationUpsert,
  applySituationUpsert,
  recordDelegation,
  returnSituationToOpen,
  situationFromSnapshot,
  type AttentionPendingView,
  type SimSituation,
} from "./situations";
import {
  applyDelegationFire,
  buildDelegationEvaluationEntry,
  evaluateDelegation,
  readSituationActionSpec,
  resolveDelegationAuthority,
  situationTierB,
  type DelegatedActionSpec,
  type DelegationEvaluation,
  type HandlerAuthorityView,
  type SimDelegationRule,
} from "./delegation";
import { planEnvelopeSpawn } from "./rules/governance";
import type { HandlerContext } from "./rules/registry";
import type { BaselineRegistry } from "./baseline/registry";
import {
  buildEnvelopeOutcomeEntryDraft,
  buildTaskOutput,
  claimEnvelope,
  envelopeTaskId,
  failureOutcome,
  revalidateEnvelopeAtExecution,
  terminalEnvelopePatch,
  validateTerminalPreconditions,
  type TaskEnvelopeRecord,
} from "../envelopes";
import { npcFromDoc } from "../authority/view";
import type { MandateVersionRecord, NpcRecord } from "../authority/types";
import { deriveAttempt, projectAuthorityView } from "./authorityStage";
import { npcActorEnvelope, npcActorStanding } from "../authority/actor";
import type { PermissionMode, SimMandateVersion } from "../npcs/types";

// ---------------------------------------------------------------------------
// Small readers (the governance.ts idiom, kept local so this module
// stands alone).
// ---------------------------------------------------------------------------

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function strArr(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
}

export function memberActor(uid: string): SimActor {
  return {
    type: "member",
    memberId: uid,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
  };
}

/** Every step plan carries exactly one summary entry, so a step's own
 *  summary seq is always head + 1 (the summarySeqFor idiom). */
function summarySeqOf(snapshot: SimSnapshot): number {
  return snapshot.counterHead.lastSeq + 1;
}

function cityNameOf(snapshot: SimSnapshot, cityId: string | null): string {
  if (!cityId) return "the city";
  const faction = snapshotDoc(snapshot, `factions/${cityId}`);
  return str(faction?.name) ?? cityId;
}

/** The audience city's current owners (factions doc), sorted. */
function cityOwnerUids(snapshot: SimSnapshot, cityId: string | null): string[] {
  if (!cityId) return [];
  const faction = snapshotDoc(snapshot, `factions/${cityId}`);
  return strArr(faction?.ownerUids).sort();
}

// ---------------------------------------------------------------------------
// Step specs + deterministic ids.
// ---------------------------------------------------------------------------

/** The worker outcome a completed envelope execution returns (the
 *  fabric cycle's seam; scripts/sim-run-wake.ts feeds it from a
 *  fixture, the production worker from the model runtime). Mirrors
 *  buildTaskOutput's input — an envelope NEVER commits; its output is
 *  advisory, delivered to the envelope's thread. */
export interface EnvelopeWorkerOutcome {
  outcome: "DONE" | "NEED-INFO" | "FAILED";
  outputText: string;
  summary: string;
  proposedTerms?: Record<string, unknown> | null;
  questions?: string[];
  findings?: Record<string, unknown>[];
}

export type WakePassStep =
  | { kind: "delegation"; situationId: string }
  | { kind: "trigger"; situationId: string }
  | {
      kind: "silence";
      situationId: string;
      /** The NPC whose evaluated posture produced the non-response, or
       *  null for the no-permission posture (P5-K9: the city-owner
       *  member record answers). The resolver VERIFIES the claim
       *  against stored state; it never trusts it. */
      npcId: string | null;
      mandateId: string | null;
      mandateVersion: number | null;
    }
  | { kind: "attention"; pendingId: string }
  | {
      kind: "envelope-terminal";
      taskId: string;
      /** The claim lease this completion executes under — re-checked
       *  inside the terminal transaction (TC-N09). */
      leaseId: string;
      outcome: EnvelopeWorkerOutcome;
    }
  | {
      kind: "envelope-failure";
      taskId: string;
      leaseId: string;
      error: { code: string; message: string };
    }
  | { kind: "situation-followup"; situationId: string; actionId: string };

function hashKey(parts: Record<string, unknown>): string {
  return sha256HexOfText(canonicalJson(parts)).slice(0, 20);
}

/** The deterministic resolution id for a step in a wake. The manifest
 *  at this id is the step's idempotency record: a re-driven wake never
 *  lands the same step twice. */
export function wakeStepResolutionId(step: WakePassStep, cycleId: string): string {
  switch (step.kind) {
    case "delegation":
      return `wake_delegation_${hashKey({ cycleId, situationId: step.situationId })}`;
    case "trigger":
      return `wake_trigger_${hashKey({ cycleId, situationId: step.situationId })}`;
    case "silence":
      return `wake_silence_${hashKey({ cycleId, situationId: step.situationId })}`;
    case "attention":
      return `wake_attention_${hashKey({ cycleId, pendingId: step.pendingId })}`;
    case "envelope-terminal":
      return `wake_envterm_${hashKey({ taskId: step.taskId, leaseId: step.leaseId })}`;
    case "envelope-failure":
      return `wake_envfail_${hashKey({ taskId: step.taskId, leaseId: step.leaseId })}`;
    case "situation-followup":
      return `wake_followup_${hashKey({ situationId: step.situationId, actionId: step.actionId })}`;
  }
}

/** The delegated action a fire creates: deterministic per (situation,
 *  route, NPC, wake cycle) so the fire step's citation and the pass's
 *  later document creation name the same action. */
export function delegatedActionId(input: {
  situationId: string;
  via: string;
  npcId: string;
  cycleId: string;
}): string {
  return `dlg_${hashKey(input)}`;
}

/** The delegated action document a fire creates, built whole — the
 *  executor (wakePasses.ts executeDelegatedAction) persists exactly
 *  this shape, and the wake harness pins the construction (W24).
 *  Born `confirmed`: the mandate IS the confirmation (the executor's
 *  preview/confirm update stamps authorityType "mandate").
 *
 *  The §3.2 trigger citation rides `structuredAction.trigger`: kind
 *  "situation", sourceId the card, sourceSeq the card's createdSeq —
 *  the creating event's summary seq (situations.ts), the committed
 *  record that asked for this act. The authority stage's check 5
 *  refuses an unrooted attempt (NO_TRIGGER_ROOT: a delegated action
 *  with no resolvable trigger is an orphan, TC-N03), so a
 *  construction without the citation can never resolve. PR #45 CI
 *  round 6 convicted exactly that: the executor built the action
 *  with delegatedVia only, every act-for-me fire rejected at the
 *  stage, and the pure venues stayed green because their fixtures
 *  hand-stamp the citation. A null createdSeq stamps as null and
 *  the stage's fail-closed verdict governs — the citation is never
 *  fabricated. */
export function buildDelegatedActionDoc(input: {
  situationId: string;
  situationCreatedSeq: number | null;
  ownerUid: string;
  npc: NpcRecord;
  mandateId: string;
  mandateVersion: number;
  spec: DelegatedActionSpec;
  audienceCityId: string | null;
  via: string;
  cycleId: string;
  nowIso: string;
}): SimAction {
  const actionId = delegatedActionId({
    situationId: input.situationId,
    via: input.via,
    npcId: input.npc.npcId,
    cycleId: input.cycleId,
  });
  const action: SimAction = {
    actionId,
    schemaVersion: 2,
    clientRequestId: actionId,
    idempotencyKey: actionId,
    source: "wake-pass",
    actor: npcActorStanding(input.npc, input.mandateId, input.mandateVersion),
    actionType: input.spec.actionType,
    actionText: null,
    structuredAction: {
      ...input.spec.structuredAction,
      delegatedVia: {
        situationId: input.situationId,
        via: input.via,
        mandateId: input.mandateId,
        mandateVersion: input.mandateVersion,
      },
      trigger: {
        kind: "situation",
        sourceId: input.situationId,
        sourceSeq: input.situationCreatedSeq,
        deliberation: null,
      },
    },
    targetCityIds:
      input.spec.targetCityIds.length > 0
        ? input.spec.targetCityIds
        : [input.audienceCityId ?? input.npc.cityId],
    threadRef: { kind: "situation", id: input.situationId },
    audienceUids: [input.ownerUid],
    preview: null,
    previewPlanHash: null,
    confirmation: null,
    claim: null,
    lastAttempt: null,
    status: "confirmed",
    resolutionId: null,
    firstLogSeq: null,
    lastLogSeq: null,
    failure: null,
    createdAt: new Date(input.nowIso),
    updatedAt: new Date(input.nowIso),
  };
  return action;
}

// ---------------------------------------------------------------------------
// Read plans. The executor materializes a snapshot by iterating these
// derivations over freshly read docs until the path set is closed; the
// committer re-reads the SAME final path set inside its transaction.
// ---------------------------------------------------------------------------

export const WAKE_RULES_QUERY_ID = "wake-delegation-rules";

export function wakeStepSeedPaths(step: WakePassStep): string[] {
  // The Log counter is a mandatory input of EVERY snapshot:
  // assembleSnapshot refuses a doc map that lacks sim_counters/log,
  // and every other read plan in the resolver (action, ripening)
  // carries it. The step plans bind the head they resolve against,
  // so the counter rides the seed set from round zero — there is no
  // sim_counters/head doc anywhere in the system. (PR-4 fix round 1:
  // seeding the phantom head path instead made the FIRST step of any
  // wake throw LOG_NOT_INITIALIZED in materializeStepSnapshot —
  // CI sim-core, CK7e's first needsAttention conversion.)
  const paths = ["sim_world/current", "sim_counters/log"];
  switch (step.kind) {
    case "delegation":
    case "trigger":
    case "silence":
    case "situation-followup":
      paths.push(`sim_situations/${step.situationId}`);
      break;
    case "attention":
      paths.push(`sim_pending_consequences/${step.pendingId}`);
      break;
    case "envelope-terminal":
    case "envelope-failure":
      paths.push(`sim_task_envelopes/${step.taskId}`, `sim_task_outputs/${step.taskId}`);
      break;
  }
  if (step.kind === "situation-followup") paths.push(`sim_actions/${step.actionId}`);
  return paths;
}

export function wakeStepSeedQueries(
  step: WakePassStep,
  docs: ReadonlyMap<string, Record<string, unknown> | null>
): CollectionQuerySpec[] {
  if (step.kind !== "delegation" && step.kind !== "silence") return [];
  const sit = docs.get(`sim_situations/${step.situationId}`) ?? null;
  const cityId = str(sit?.audienceCityId);
  if (!cityId) return [];
  return [
    {
      id: WAKE_RULES_QUERY_ID,
      collectionPath: "sim_delegation_rules",
      filters: [{ field: "cityId", op: "==", value: cityId }],
    },
  ];
}

/** Derive the next round of paths from the docs read so far. Pure over
 *  the doc map so the executor and the harness walk the same closure. */
export function wakeStepDerivedPaths(
  step: WakePassStep,
  docs: ReadonlyMap<string, Record<string, unknown> | null>
): string[] {
  const out = new Set<string>();
  const doc = (p: string) => docs.get(p) ?? null;
  const addNpcChain = (npcId: string | null) => {
    if (!npcId) return;
    out.add(`sim_npcs/${npcId}`);
    const npc = doc(`sim_npcs/${npcId}`);
    const mandateId = str(npc?.currentMandateId);
    if (mandateId) {
      out.add(`sim_mandates/${mandateId}`);
      const root = doc(`sim_mandates/${mandateId}`);
      const version = num(root?.currentVersion);
      if (version !== null) out.add(`sim_mandates/${mandateId}/versions/${version}`);
    }
  };
  const addCityFrame = (cityId: string | null) => {
    if (!cityId) return;
    out.add(`factions/${cityId}`);
    out.add(`sim_teams/${cityId}`);
    const team = doc(`sim_teams/${cityId}`);
    for (const npcId of strArr(team?.npcIds)) addNpcChain(npcId);
  };

  switch (step.kind) {
    case "delegation":
    case "trigger":
    case "silence": {
      const sit = doc(`sim_situations/${step.situationId}`);
      addCityFrame(str(sit?.audienceCityId));
      // Rules arrive via the seed query; their handler chains follow.
      for (const [path, rule] of docs) {
        if (!path.startsWith("sim_delegation_rules/") || !rule) continue;
        const handler = (rule.handler ?? {}) as Record<string, unknown>;
        addNpcChain(str(handler.npcId));
        const mandateId = str(handler.mandateId);
        if (mandateId) {
          out.add(`sim_mandates/${mandateId}`);
          const root = doc(`sim_mandates/${mandateId}`);
          const version = num(root?.currentVersion);
          if (version !== null) out.add(`sim_mandates/${mandateId}/versions/${version}`);
        }
      }
      break;
    }
    case "attention": {
      const pending = doc(`sim_pending_consequences/${step.pendingId}`);
      addCityFrame(str(pending?.originCityId));
      break;
    }
    case "envelope-terminal":
    case "envelope-failure": {
      const env = doc(`sim_task_envelopes/${step.taskId}`);
      addNpcChain(str(env?.npcId));
      addCityFrame(str(env?.cityId));
      // Spawn provenance (the terminal step's revalidation source):
      // the Log entry at the envelope's createdSeq — a fire entry
      // carries the delegation classification; an owner's spawn entry
      // carries the envelope.spawn verb.
      const createdSeq = num(env?.createdSeq);
      if (createdSeq !== null) {
        out.add(`sim_log_entries/${String(createdSeq).padStart(12, "0")}`);
      }
      const threadRef = (env?.threadRef ?? null) as { kind?: unknown; id?: unknown } | null;
      if (threadRef && threadRef.kind === "situation" && typeof threadRef.id === "string") {
        out.add(`sim_situations/${threadRef.id}`);
      }
      break;
    }
    case "situation-followup":
      break;
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Authority construction from stored docs.
// ---------------------------------------------------------------------------

/** The evaluator's authority view for one rule (the §6.3B
 *  cited-or-standing doctrine PR-3 landed: the rule's cited mandate
 *  when it cites one, else the handler NPC's standing mandate). */
export function handlerAuthorityView(
  snapshot: SimSnapshot,
  rule: SimDelegationRule
): HandlerAuthorityView {
  const npcId = rule.handler.npcId;
  if (!npcId) return { npc: null, mandate: null };
  const npcDoc = snapshotDoc(snapshot, `sim_npcs/${npcId}`);
  const npc = npcDoc
    ? {
        npcId,
        ownerUid: str(npcDoc.ownerUid) ?? "",
        permissionMode: npcDoc.permissionMode as PermissionMode,
        status: str(npcDoc.status) ?? "missing",
      }
    : null;
  const mandateId = rule.handler.mandateId ?? str(npcDoc?.currentMandateId);
  if (!mandateId) return { npc, mandate: null };
  const root = snapshotDoc(snapshot, `sim_mandates/${mandateId}`);
  if (!root) return { npc, mandate: { mandateId, found: false, rootStatus: null, version: null } };
  const currentVersion = num(root.currentVersion);
  const versionDoc =
    currentVersion !== null
      ? snapshotDoc(snapshot, `sim_mandates/${mandateId}/versions/${currentVersion}`)
      : null;
  return {
    npc,
    mandate: {
      mandateId,
      found: true,
      rootStatus: str(root.status),
      version: (versionDoc as unknown as SimMandateVersion | null) ?? null,
    },
  };
}

/** The NPC's current mandate version projected into the authority
 *  dialect by the stage's own projection (the stored docs are
 *  npcs-dialect; the envelope spawn fence and the lifecycle's
 *  revalidation both consume the authority record). Null when the NPC
 *  holds no mandate or the projection refuses the stored records. */
export function stageMandateVersionRecord(
  snapshot: SimSnapshot,
  npcId: string
): MandateVersionRecord | null {
  const npc = npcFromDoc(snapshotDoc(snapshot, `sim_npcs/${npcId}`));
  if (!npc || npc.currentMandateId === null || npc.currentMandateVersion === null) {
    return null;
  }
  const actor = npcActorStanding(npc, npc.currentMandateId, npc.currentMandateVersion);
  const action: SimAction = {
    actionId: `wake_projection_${npcId}`,
    schemaVersion: 2,
    clientRequestId: `wake_projection_${npcId}`,
    idempotencyKey: `wake_projection_${npcId}`,
    source: "wake-pass",
    actor,
    actionType: "envelope.spawn",
    actionText: null,
    structuredAction: {},
    targetCityIds: [npc.cityId],
    threadRef: null,
    audienceUids: [npc.ownerUid],
    preview: null,
    previewPlanHash: null,
    confirmation: null,
    claim: null,
    lastAttempt: null,
    status: "confirmed",
    resolutionId: null,
    firstLogSeq: null,
    lastLogSeq: null,
    failure: null,
    createdAt: null,
    updatedAt: null,
  };
  const { attempt } = deriveAttempt(snapshot, action);
  const projection = projectAuthorityView(snapshot, action, attempt, {
    delegatedResolutions: 0,
    delegatedRubars: 0,
  });
  return projection.kind === "view" ? projection.view.mandateVersion : null;
}

/** The audience city's delegation rules, read from the materialized
 *  query record (never a live scan — the snapshot IS the pass's
 *  world). Roots carry the current version's fields (§2.7). */
export function delegationRulesForCity(
  snapshot: SimSnapshot,
  cityId: string | null
): SimDelegationRule[] {
  if (!cityId) return [];
  const record = snapshot.queries.find((q) => q.spec.id === WAKE_RULES_QUERY_ID);
  if (!record) return [];
  const rules: SimDelegationRule[] = [];
  for (const path of record.resultPaths) {
    const doc = snapshotDoc(snapshot, path);
    if (doc && doc.cityId === cityId) rules.push(doc as unknown as SimDelegationRule);
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Step 4 — the delegation pass (brief §7.2, Vera §3 consumption points).
// ---------------------------------------------------------------------------

export interface DelegationStepResult {
  /** The card as it stood at evaluation (null when it is gone or no
   *  longer addressable by the pass). */
  situation: SimSituation | null;
  evaluation: DelegationEvaluation | null;
  plan: ResolutionPlan;
}

/** Evaluate one situation against its audience owner's rulebook. The
 *  executor uses the evaluation for bookkeeping and for the delegated
 *  -action pipeline; the committer re-derives the same plan from the
 *  same function inside its transaction. */
export function evaluateDelegationStep(
  snapshot: SimSnapshot,
  situationId: string,
  opts: { resolutionId: string; cycleId: string; baselineRegistry: BaselineRegistry }
): DelegationStepResult {
  const situation = situationFromSnapshot(snapshot, situationId);
  if (!situation || situation.status !== "open") {
    return { situation, evaluation: null, plan: emptyPlan(null) };
  }
  const rules = delegationRulesForCity(snapshot, situation.audienceCityId);
  const evaluation = evaluateDelegation({
    situation,
    rules,
    authorityFor: (rule) => handlerAuthorityView(snapshot, rule),
  });
  if (evaluation.outcome === "wait" || evaluation.outcome === "no-match") {
    // §7.2/§7.3: a wait is the owner's standing-or-rule instruction —
    // the card rests open and NOTHING is written (a wait is not an
    // event). A no-match falls through to the trigger pass.
    return { situation, evaluation, plan: emptyPlan(null) };
  }
  if (evaluation.outcome === "escalate" || evaluation.outcome === "blocked-handler-authority-changed") {
    const plan = emptyPlan(null);
    plan.entries.push(buildDelegationEvaluationEntry(evaluation, situation));
    return { situation, evaluation, plan: finalizePlan(plan) };
  }
  const plan = composeFirePlan(snapshot, situation, evaluation, opts);
  return { situation, evaluation, plan };
}

/** Compose a fire into a plan: Vera's applyDelegationFire carries the
 *  transition + fire entry; an envelope fire additionally merges the
 *  spawn core's document write (its own summary entry is dropped —
 *  the fire entry is the causing event's record, and the envelope's
 *  provenance is its spawnActionId = this step's resolution id). */
function composeFirePlan(
  snapshot: SimSnapshot,
  situation: SimSituation,
  evaluation: Extract<DelegationEvaluation, { outcome: "fire" }>,
  opts: { resolutionId: string; cycleId: string; baselineRegistry: BaselineRegistry }
): ResolutionPlan {
  const fire = evaluation.fire;
  const plan = emptyPlan(null);
  const taskId =
    fire.kind === "envelope" && fire.envelopeSpec
      ? envelopeTaskId(fire.ownerUid, opts.resolutionId)
      : null;
  const actionId =
    fire.kind === "delegated-action" && fire.npcId
      ? delegatedActionId({
          situationId: situation.situationId,
          via: fire.ruleId,
          npcId: fire.npcId,
          cycleId: opts.cycleId,
        })
      : null;
  applyDelegationFire(plan, snapshot, situation, fire, {
    now: snapshot.now,
    cityName: cityNameOf(snapshot, situation.audienceCityId),
    resolvedSeq: summarySeqOf(snapshot),
    resolvedByResolutionId: opts.resolutionId,
    taskId,
    actionId,
  });
  if (fire.kind === "envelope" && fire.envelopeSpec && taskId) {
    const spec = fire.envelopeSpec;
    const mandateVersion =
      fire.mandateId && fire.mandateVersion !== null
        ? stageMandateVersionRecord(snapshot, spec.npcId)
        : null;
    const syntheticAction: SimAction = {
      actionId: opts.resolutionId,
      schemaVersion: 2,
      clientRequestId: opts.resolutionId,
      idempotencyKey: opts.resolutionId,
      source: "wake-pass",
      actor: memberActor(fire.ownerUid),
      actionType: "envelope.spawn",
      actionText: null,
      structuredAction: {
        taskType: spec.taskType,
        task: spec.intentText,
        structuredIntent: spec.structuredIntent,
        threadRef: spec.threadRef,
        bounds: { mayCommit: false, counterpartyCityIds: spec.counterpartyCityIds },
      },
      targetCityIds: [spec.cityId ?? situation.audienceCityId ?? ""],
      threadRef: spec.threadRef,
      audienceUids: [fire.ownerUid],
      preview: null,
      previewPlanHash: null,
      confirmation: null,
      claim: null,
      lastAttempt: null,
      status: "confirmed",
      resolutionId: null,
      firstLogSeq: null,
      lastLogSeq: null,
      failure: null,
      createdAt: null,
      updatedAt: null,
    };
    const spawnCtx: HandlerContext = {
      snapshot,
      action: syntheticAction,
      resolutionId: opts.resolutionId,
      baselineRegistry: opts.baselineRegistry,
      citableBaseline: null,
      citations: {},
    };
    const spawnPlan = planEnvelopeSpawn(spawnCtx, {
      source: "delegation-rule",
      requestingMemberId: fire.ownerUid,
      npcId: spec.npcId,
      clientRequestId: opts.resolutionId,
      mandateVersion,
      availableAt: snapshot.now,
    });
    if (spawnPlan.outcome === "rejected" || spawnPlan.writes.length !== 1) {
      // The fire evaluated clean but the spawn core refuses on stored
      // state (e.g. the handler NPC retired between the rule's
      // authoring and this wake): the step degrades to the blocked
      // evaluation outcome — an entry, no transition, no envelope.
      const blocked: Extract<DelegationEvaluation, { outcome: "blocked-handler-authority-changed" }> = {
        outcome: "blocked-handler-authority-changed",
        rule: evaluation.rule,
        match: evaluation.match,
        reason:
          spawnPlan.rejection?.summaryText ??
          "the envelope spawn core refused the fire's spawn on stored state",
      };
      const fallback = emptyPlan(null);
      fallback.entries.push(buildDelegationEvaluationEntry(blocked, situation));
      return finalizePlan(fallback);
    }
    const write = spawnPlan.writes[0];
    planWrite(plan, snapshot, write.path, write.afterDoc ?? {}, "state", write.changedFields);
  }
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// Step 5 — the standing-team trigger pass (brief §2.15/§1.3 step 5).
// ---------------------------------------------------------------------------

export type TriggerPosture =
  | { outcome: "none"; reason: string }
  | {
      outcome: "silent";
      npcId: string;
      mandateId: string | null;
      mandateVersion: number | null;
    }
  | { outcome: "unempowered"; reason: string }
  | { outcome: "no-act"; npcId: string; reason: string }
  | {
      outcome: "escalate-tier-b";
      npcId: string;
      ownerUid: string;
      mandateId: string | null;
      mandateVersion: number | null;
    }
  | {
      outcome: "act" | "draft";
      npcId: string;
      ownerUid: string;
      mandateId: string | null;
      mandateVersion: number | null;
      modeBinding: string;
    };

interface TriggerCandidate {
  npcId: string;
  ownerUid: string;
  mandateId: string | null;
  mandateVersion: number | null;
  effectiveMode: PermissionMode | null;
  modeBinding: string;
}

/** Standing-team candidates for a card, in deterministic order: the
 *  audience city's active team members holding a CURRENT mandate whose
 *  scope contemplates this trigger (triggerKinds ∋ "situation" or
 *  "log-event" — the card's source is a Log event either way), each
 *  with its narrower-of effective mode. The FIRST contemplated
 *  candidate governs the routing (the F3 discipline: one judgment, on
 *  the selected handler — the pass never shops for a better answer). */
function triggerCandidates(snapshot: SimSnapshot, situation: SimSituation): TriggerCandidate[] {
  const cityId = situation.audienceCityId;
  if (!cityId) return [];
  const team = snapshotDoc(snapshot, `sim_teams/${cityId}`);
  const out: TriggerCandidate[] = [];
  for (const npcId of [...strArr(team?.npcIds)].sort()) {
    const npcDoc = snapshotDoc(snapshot, `sim_npcs/${npcId}`);
    if (!npcDoc || npcDoc.status !== "active" || npcDoc.cityId !== cityId) continue;
    const mandateId = str(npcDoc.currentMandateId);
    if (!mandateId) continue;
    const root = snapshotDoc(snapshot, `sim_mandates/${mandateId}`);
    if (!root || root.status !== "active" || num(root.revokedSeq) !== null) continue;
    const currentVersion = num(root.currentVersion);
    if (currentVersion === null) continue;
    const versionDoc = snapshotDoc(
      snapshot,
      `sim_mandates/${mandateId}/versions/${currentVersion}`
    ) as unknown as SimMandateVersion | null;
    if (!versionDoc) continue;
    const triggerKinds = strArr(versionDoc.structuredScope?.triggerKinds);
    if (!triggerKinds.includes("situation") && !triggerKinds.includes("log-event")) continue;
    const authority = resolveDelegationAuthority({
      npcMode: (npcDoc.permissionMode as PermissionMode | null) ?? null,
      mandateVersion: versionDoc,
      ruleMode: null,
      ruleCaps: null,
    });
    out.push({
      npcId,
      ownerUid: str(npcDoc.ownerUid) ?? "",
      mandateId,
      mandateVersion: currentVersion,
      effectiveMode: authority.effectiveMode,
      modeBinding: authority.modeBinding,
    });
  }
  return out;
}

/** The trigger pass's pure judgment over one card. Shared by the step
 *  resolver (act/draft/escalate compose plans; the rest are no-ops)
 *  and by the silence pass (whose step spec is built from the silent /
 *  unempowered postures and re-verified against this same function). */
export function evaluateTriggerPosture(
  snapshot: SimSnapshot,
  situation: SimSituation
): TriggerPosture {
  if (!situation.audienceCityId) {
    return { outcome: "none", reason: "person-scoped card — no city team answers for it" };
  }
  const candidates = triggerCandidates(snapshot, situation);
  if (candidates.length === 0) {
    return {
      outcome: "unempowered",
      reason: "no active team member holds a current mandate contemplating this trigger",
    };
  }
  const first = candidates[0];
  if (first.effectiveMode === "silent") {
    return {
      outcome: "silent",
      npcId: first.npcId,
      mandateId: first.mandateId,
      mandateVersion: first.mandateVersion,
    };
  }
  if (first.effectiveMode === "act-for-me") {
    if (situationTierB(situation).tierB) {
      return {
        outcome: "escalate-tier-b",
        npcId: first.npcId,
        ownerUid: first.ownerUid,
        mandateId: first.mandateId,
        mandateVersion: first.mandateVersion,
      };
    }
    if (!readSituationActionSpec(situation)) {
      return {
        outcome: "no-act",
        npcId: first.npcId,
        reason:
          "the empowered NPC's mandate contemplates the trigger but the card carries no delegated action spec — a trigger match is a permission fact, not an act generator",
      };
    }
    return {
      outcome: "act",
      npcId: first.npcId,
      ownerUid: first.ownerUid,
      mandateId: first.mandateId,
      mandateVersion: first.mandateVersion,
      modeBinding: first.modeBinding,
    };
  }
  if (first.effectiveMode === "ask-first") {
    return {
      outcome: "draft",
      npcId: first.npcId,
      ownerUid: first.ownerUid,
      mandateId: first.mandateId,
      mandateVersion: first.mandateVersion,
      modeBinding: first.modeBinding,
    };
  }
  return {
    outcome: "unempowered",
    reason: `the governing candidate's effective mode is ${String(first.effectiveMode)} — no act or draft is authorized`,
  };
}

export function resolveTriggerStep(
  snapshot: SimSnapshot,
  situationId: string,
  opts: { resolutionId: string; cycleId: string }
): ResolutionPlan {
  const situation = situationFromSnapshot(snapshot, situationId);
  if (!situation || situation.status !== "open" || situation.handling?.mode) {
    return emptyPlan(null);
  }
  const posture = evaluateTriggerPosture(snapshot, situation);
  if (
    posture.outcome === "none" ||
    posture.outcome === "silent" ||
    posture.outcome === "unempowered" ||
    posture.outcome === "no-act"
  ) {
    // Silence is the silence pass's step, not this one's; the rest
    // produced no authorized routing — the card rests open.
    return emptyPlan(null);
  }
  const plan = emptyPlan(null);
  const ownerUid = posture.ownerUid;
  if (posture.outcome === "escalate-tier-b") {
    plan.entries.push(
      summaryDraft({
        actor: memberActor(ownerUid),
        cityId: situation.audienceCityId,
        cityIds: situation.audienceCityId ? [situation.audienceCityId] : [],
        ruleIds: [],
        recordsUpdated: [],
        classification: {
          triggerEvaluation: "escalate",
          code: "tier-b",
          npcId: posture.npcId,
          mandateId: posture.mandateId,
          mandateVersion: posture.mandateVersion,
          situationId: situation.situationId,
          situationKind: situation.kind,
          trigger: {
            kind: "situation",
            sourceSeq: situation.source.sourceSeq ?? null,
            sourceId: situation.source.sourceId ?? null,
          },
        },
        summaryText: `A Tier B situation reached ${posture.npcId} under a standing mandate; Tier B never auto-acts, so the card stays with the owner (${situation.situationId}).`,
      })
    );
    return finalizePlan(plan);
  }
  // act | draft: route the card. act allocates the delegated action
  // the pass executes next; a draft cites no action — the card itself,
  // standing at awaiting_owner with the proposed spec on its detail
  // and in this entry, is the draft surface.
  const actionId =
    posture.outcome === "act"
      ? delegatedActionId({
          situationId: situation.situationId,
          via: "trigger",
          npcId: posture.npcId,
          cycleId: opts.cycleId,
        })
      : null;
  const transition = recordDelegation(situation, {
    decidedByUid: ownerUid,
    decidedAt: snapshot.now,
    npcId: posture.npcId,
    mandateId: posture.mandateId,
    mandateVersion: posture.mandateVersion,
    effectiveMode: posture.outcome === "act" ? "act-for-me" : "ask-first",
    actionId,
    autoDelegated: true,
    decisionNote:
      posture.outcome === "act"
        ? "Standing-team trigger: the cited mandate contemplates this situation; the delegated action resolves in this wake."
        : "Standing-team trigger (ask-first): drafted under the cited mandate — awaiting the owner's confirmation.",
  });
  planWrite(
    plan,
    snapshot,
    `sim_situations/${situation.situationId}`,
    transition.doc as unknown as Record<string, unknown>,
    "state",
    transition.changedFields
  );
  plan.entries.push(
    summaryDraft({
      actor: memberActor(ownerUid),
      cityId: situation.audienceCityId,
      cityIds: situation.audienceCityId ? [situation.audienceCityId] : [],
      ruleIds: [],
      recordsUpdated: [`sim_situations/${situation.situationId}`],
      classification: {
        triggerEvaluation: posture.outcome === "act" ? "delegated-action" : "draft",
        npcId: posture.npcId,
        mandateId: posture.mandateId,
        mandateVersion: posture.mandateVersion,
        modeBinding: posture.modeBinding,
        situationId: situation.situationId,
        situationKind: situation.kind,
        actionId,
        trigger: {
          kind: "situation",
          sourceSeq: situation.source.sourceSeq ?? null,
          sourceId: situation.source.sourceId ?? null,
        },
      },
      summaryText:
        posture.outcome === "act"
          ? `Standing-team trigger routed ${situation.situationId} to ${posture.npcId} under its mandate (narrower-of: ${posture.modeBinding}); delegated action ${actionId} resolves in this wake.`
          : `Standing-team trigger drafted ${situation.situationId} for ${posture.npcId} under ask-first; the card awaits the owner.`,
    })
  );
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// Step 5½ — the §8 silence commit pass (brief §8, P5-K9).
// ---------------------------------------------------------------------------

/** The silence step. The spec's posture claim (which NPC, or none) is
 *  VERIFIED against a fresh posture derivation and a fresh delegation
 *  evaluation — a card a rule would fire on, wait on, escalate, or
 *  block never receives a silence commit, and neither does a card an
 *  empowered candidate could act on or draft. */
export function resolveSilenceStep(
  snapshot: SimSnapshot,
  step: Extract<WakePassStep, { kind: "silence" }>,
  opts: { resolutionId: string; baselineRegistry: BaselineRegistry }
): ResolutionPlan {
  const situation = situationFromSnapshot(snapshot, step.situationId);
  if (!situation || situation.status !== "open" || situation.handling?.mode) {
    return emptyPlan(null);
  }
  if (!situation.audienceCityId) return emptyPlan(null);
  // A rulebook outcome other than no-match owns the card this wake.
  const rules = delegationRulesForCity(snapshot, situation.audienceCityId);
  const evaluation = evaluateDelegation({
    situation,
    rules,
    authorityFor: (rule) => handlerAuthorityView(snapshot, rule),
  });
  if (evaluation.outcome !== "no-match") return emptyPlan(null);
  const posture = evaluateTriggerPosture(snapshot, situation);
  const ownerUid =
    cityOwnerUids(snapshot, situation.audienceCityId)[0] ??
    situation.audienceOwnerUidsSnapshot[0] ??
    null;
  if (!ownerUid) return emptyPlan(null);
  const plan = emptyPlan(null);
  if (step.npcId !== null) {
    if (
      posture.outcome !== "silent" ||
      posture.npcId !== step.npcId ||
      posture.mandateId !== step.mandateId ||
      posture.mandateVersion !== step.mandateVersion
    ) {
      return emptyPlan(null);
    }
    applySilenceCommit(plan, snapshot, {
      situation,
      producingMode: "npc-silent-mode",
      ownerUid,
      npcId: step.npcId,
      mandateId: step.mandateId,
      mandateVersion: step.mandateVersion,
      cityName: cityNameOf(snapshot, situation.audienceCityId),
      resolvedSeq: summarySeqOf(snapshot),
      resolvedByResolutionId: opts.resolutionId,
      now: snapshot.now,
    });
  } else {
    if (posture.outcome !== "unempowered") return emptyPlan(null);
    applySilenceCommit(plan, snapshot, {
      situation,
      producingMode: "no-permission",
      ownerUid,
      cityName: cityNameOf(snapshot, situation.audienceCityId),
      resolvedSeq: summarySeqOf(snapshot),
      resolvedByResolutionId: opts.resolutionId,
      now: snapshot.now,
    });
  }
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// The needsAttention conversion (brief §6.7) — steady state and the
// first-Phase-5-wake backfill are the same mechanism: any flagged,
// unstamped pending converts exactly once.
// ---------------------------------------------------------------------------

export function resolveAttentionStep(
  snapshot: SimSnapshot,
  pendingId: string,
  opts: { resolutionId: string }
): ResolutionPlan {
  const pendingPath = `sim_pending_consequences/${pendingId}`;
  const pendingDoc = snapshotDoc(snapshot, pendingPath);
  if (!pendingDoc) return emptyPlan(null);
  const view = pendingDoc as unknown as AttentionPendingView;
  const originCityId = str(pendingDoc.originCityId);
  const conversion = planAttentionConversion(view, {
    originOwnerUids: cityOwnerUids(snapshot, originCityId),
    createdSeq: summarySeqOf(snapshot),
    now: snapshot.now,
  });
  if (!conversion) return emptyPlan(null);
  const situation = conversion.situation;
  const plan = emptyPlan(null);
  planWrite(
    plan,
    snapshot,
    `sim_situations/${situation.situationId}`,
    situation as unknown as Record<string, unknown>,
    "state",
    ["status"]
  );
  // P5-K8: the pending's patch contains exactly one key — handling
  // the Situation can never touch the pending, and the flag clears
  // only when the pending itself resolves.
  planWrite(
    plan,
    snapshot,
    pendingPath,
    { ...pendingDoc, ...conversion.pendingPatch },
    "state",
    Object.keys(conversion.pendingPatch)
  );
  const originActor = (pendingDoc.originActor as SimActor | null) ?? null;
  const fallbackOwner = cityOwnerUids(snapshot, originCityId)[0] ?? situation.audienceOwnerUidsSnapshot[0];
  const entryActor = originActor ?? (fallbackOwner ? memberActor(fallbackOwner) : memberActor(""));
  plan.entries.push(
    summaryDraft({
      actor: entryActor,
      cityId: originCityId,
      cityIds: originCityId ? [originCityId] : [],
      ruleIds: [],
      recordsCreated: [`sim_situations/${situation.situationId}`],
      recordsUpdated: [pendingPath],
      classification: {
        attentionConversion: true,
        pendingId,
        pendingKind: str(pendingDoc.kind),
        failureCode: view.lastFailure?.code ?? null,
        situationId: situation.situationId,
        // §3.2 trigger citation (PR #45 CI round 8): the conversion
        // entry carries the pending's ORIGIN actor — when that actor
        // is an NPC (a delegated action's pending that exhausted its
        // retries), the standing verifier's traceability requires
        // the citation: the pending itself, rooted at its origin
        // event. Member-origin conversions keep their landed shape.
        ...(entryActor.type === "npc"
          ? {
              trigger: {
                kind: "log-event",
                sourceId: pendingId,
                sourceSeq:
                  typeof pendingDoc.originSeq === "number" ? pendingDoc.originSeq : null,
                deliberation: null,
              },
            }
          : {}),
      },
      summaryText: `A delayed consequence (${pendingId}) exhausted its ripening retries; its needs-attention card ${situation.situationId} now stands in the owner's Situations.`,
    })
  );
  void opts;
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// Step 6 — the envelope claim pass's terminal + failure steps (§4.2/§4.3).
// ---------------------------------------------------------------------------

/** F-E8's terminal-without-output recognition: an envelope envelope
 *  .cancel landed as FAILED with `cancelled_before_claim` is COMPLETE
 *  — it is never claimed, never executed, and never produces an
 *  output. The claim planner classifies it here; the module's
 *  completion invariants are NOT rewritten to accommodate it. */
export function isTerminalWithoutOutput(env: TaskEnvelopeRecord): boolean {
  return env.status === "FAILED" && env.lastError?.code === "cancelled_before_claim";
}

export type EnvelopeClaimSkipReason =
  | "terminal"
  | "terminal-without-output"
  | "live-lease"
  | "attempts-exhausted"
  | "not-yet-available"
  | "cap";

export interface EnvelopeClaimDecision {
  claims: { taskId: string; recovered: boolean }[];
  skipped: { taskId: string; reason: EnvelopeClaimSkipReason }[];
}

/** The claim pass's pure planner (P5-K5 claim cap 5/wake). Input is
 *  the QUEUED/RUNNING population in deterministic order (createdSeq,
 *  then taskId); the pass claims from it as it runs — envelopes
 *  spawned earlier in the SAME wake are in the population the live
 *  query returns and are claimable like any other. `availableAt` is a
 *  floor only, never a trigger (§4.2). */
export function planEnvelopeClaims(
  envelopes: readonly TaskEnvelopeRecord[],
  opts: { nowIso: string; cap?: number }
): EnvelopeClaimDecision {
  const cap = opts.cap ?? 5;
  const nowMs = Date.parse(opts.nowIso);
  const sorted = [...envelopes].sort(
    (a, b) => (a.createdSeq ?? 0) - (b.createdSeq ?? 0) || a.taskId.localeCompare(b.taskId)
  );
  const claims: EnvelopeClaimDecision["claims"] = [];
  const skipped: EnvelopeClaimDecision["skipped"] = [];
  for (const env of sorted) {
    if (isTerminalWithoutOutput(env)) {
      skipped.push({ taskId: env.taskId, reason: "terminal-without-output" });
      continue;
    }
    const probe = claimEnvelope(env, {
      cycleId: "planner-probe",
      leaseId: "planner-probe",
      nowIso: opts.nowIso,
      leaseExpiresAt: opts.nowIso,
    });
    if (!probe.ok) {
      const reason: EnvelopeClaimSkipReason = probe.reason.includes("terminal")
        ? "terminal"
        : probe.reason.includes("attempt budget")
          ? "attempts-exhausted"
          : "live-lease";
      skipped.push({ taskId: env.taskId, reason });
      continue;
    }
    if (
      typeof env.availableAt === "string" &&
      env.availableAt.length > 0 &&
      Date.parse(env.availableAt) > nowMs
    ) {
      skipped.push({ taskId: env.taskId, reason: "not-yet-available" });
      continue;
    }
    if (claims.length >= cap) {
      skipped.push({ taskId: env.taskId, reason: "cap" });
      continue;
    }
    claims.push({ taskId: env.taskId, recovered: env.status === "RUNNING" });
  }
  return { claims, skipped };
}

/** The §4.3 terminal transaction as a step plan: execution-time
 *  revalidation (TC-N09) re-derived inside the step — a mandate
 *  revoked, or a rule-spawned envelope's mode flipped to silent,
 *  between queue and completion terminates the task
 *  `authority_changed` HERE, whatever the worker returned. */
export function resolveEnvelopeTerminalStep(
  snapshot: SimSnapshot,
  step: Extract<WakePassStep, { kind: "envelope-terminal" }>,
  opts: { resolutionId: string }
): ResolutionPlan {
  const envDoc = snapshotDoc(snapshot, `sim_task_envelopes/${step.taskId}`);
  if (!envDoc) return emptyPlan(null);
  const env = envDoc as unknown as TaskEnvelopeRecord;
  if (isTerminalWithoutOutput(env)) return emptyPlan(null);
  const outputExists = snapshotDoc(snapshot, `sim_task_outputs/${step.taskId}`) !== null;
  const violations = validateTerminalPreconditions(env, {
    leaseId: step.leaseId,
    outputExists,
  });
  if (violations.length > 0) return emptyPlan(null);
  const npc = npcFromDoc(snapshotDoc(snapshot, `sim_npcs/${env.npcId}`));
  if (!npc) return emptyPlan(null);
  // The revalidation view is the STAGE's own projection of the stored
  // (npcs-dialect) docs — the same projection the action stage uses,
  // so "mandate currency" means one thing in both places. The
  // synthetic completion action cites the NPC's STANDING mandate (the
  // completion judges the world as it stands); the lifecycle's
  // revalidation then runs its envelope-identity check and its
  // standing-mandate check against that view. A projection verdict
  // (malformed or integrity-failed records) is itself an
  // authority_changed termination.
  const standingActor =
    npc.currentMandateId !== null && npc.currentMandateVersion !== null
      ? npcActorStanding(npc, npc.currentMandateId, npc.currentMandateVersion)
      : npcActorEnvelope(npc, env.taskId);
  const completionAction: SimAction = {
    actionId: `env_completion_${env.taskId}`,
    schemaVersion: 2,
    clientRequestId: `env_completion_${env.taskId}`,
    idempotencyKey: `env_completion_${env.taskId}`,
    source: "wake-pass",
    actor: standingActor,
    actionType: "envelope.spawn",
    actionText: null,
    structuredAction: {},
    targetCityIds: [env.cityId],
    threadRef: env.threadRef,
    audienceUids: [env.requestingMemberId],
    preview: null,
    previewPlanHash: null,
    confirmation: null,
    claim: null,
    lastAttempt: null,
    status: "confirmed",
    resolutionId: null,
    firstLogSeq: null,
    lastLogSeq: null,
    failure: null,
    createdAt: null,
    updatedAt: null,
  };
  const { attempt } = deriveAttempt(snapshot, completionAction);
  const projection = projectAuthorityView(snapshot, completionAction, attempt, {
    delegatedResolutions: 0,
    delegatedRubars: 0,
  });
  // Provenance (F-E7's mapping, on the record that actually stands):
  // buildTaskEnvelope stores no spawnActionId — the spawn's provenance
  // is its Log entry at the envelope's createdSeq. A delegation fire
  // entry classifies the spawn as rule-spawned; anything else (an
  // owner's envelope.spawn summary, a situation.delegate completion)
  // is owner-direct: the owner's own instruction is the permission,
  // and it survives a later flip to silent (E9 semantics).
  const spawnEntry =
    typeof env.createdSeq === "number"
      ? snapshotDoc(snapshot, `sim_log_entries/${String(env.createdSeq).padStart(12, "0")}`)
      : null;
  const spawnClassification = (spawnEntry?.classification ?? null) as
    | Record<string, unknown>
    | null;
  const source =
    spawnClassification && "delegationFire" in spawnClassification
      ? "delegation-rule"
      : "owner-direct";
  const revalidation =
    projection.kind === "verdict"
      ? {
          ok: false as const,
          code: "authority_changed" as const,
          failure:
            projection.verdict.disposition === "reject"
              ? { code: projection.verdict.code, reason: projection.verdict.reason }
              : {
                  code: "AUTHORITY_PROJECTION_REFUSED",
                  reason: "the authority projection produced no view of the stored records",
                },
        }
      : revalidateEnvelopeAtExecution(projection.view, env, source);

  let outcome: EnvelopeWorkerOutcome;
  let terminalError: { code: string; message: string } | null = null;
  if (!revalidation.ok) {
    outcome = {
      outcome: "FAILED",
      outputText: revalidation.failure.reason,
      summary: "The task terminated at execution-time revalidation (authority changed).",
    };
    terminalError = { code: "authority_changed", message: revalidation.failure.reason };
  } else if (step.outcome.outcome === "FAILED" && step.outcome.outputText.trim().length === 0) {
    outcome = {
      outcome: "FAILED",
      outputText: "The worker reported failure without a reason.",
      summary: step.outcome.summary || "The task failed.",
    };
    terminalError = { code: "worker_failed", message: outcome.outputText };
  } else {
    outcome = step.outcome;
    if (outcome.outcome === "FAILED") {
      terminalError = { code: "worker_failed", message: outcome.outputText };
    }
  }
  const output = buildTaskOutput(env, {
    outcome: outcome.outcome,
    outputText: outcome.outputText,
    summary: outcome.summary,
    proposedTerms: outcome.proposedTerms ?? undefined,
    questions: outcome.questions,
    findings: outcome.findings,
    createdSeq: summarySeqOf(snapshot),
  });
  const patch = terminalEnvelopePatch(env, {
    outcome: outcome.outcome,
    nowIso: snapshot.now,
    error: terminalError,
  });
  const plan = emptyPlan(null);
  planWrite(
    plan,
    snapshot,
    `sim_task_outputs/${step.taskId}`,
    output as unknown as Record<string, unknown>,
    "state",
    ["outcome", "outputText"]
  );
  planWrite(
    plan,
    snapshot,
    `sim_task_envelopes/${step.taskId}`,
    { ...env, ...patch, updatedAt: null } as unknown as Record<string, unknown>,
    "state",
    Object.keys(patch)
  );
  const entry = buildEnvelopeOutcomeEntryDraft(env, output, npc);
  // A delegated card whose task FAILED returns to its owner in the
  // same event (§6.3B: the delegation did not complete; the cycle
  // count makes the loop visible, never silent).
  if (outcome.outcome === "FAILED" && env.threadRef?.kind === "situation") {
    const situation = situationFromSnapshot(snapshot, env.threadRef.id);
    if (situation && situation.status === "delegated" && situation.handling?.taskId === step.taskId) {
      const returned = returnSituationToOpen(situation, {
        decidedAt: snapshot.now,
        reason: `the delegated task ${step.taskId} ended FAILED (${terminalError?.code ?? "worker_failed"})`,
        failedCheck: terminalError?.code ?? null,
      });
      planWrite(
        plan,
        snapshot,
        `sim_situations/${situation.situationId}`,
        returned.doc as unknown as Record<string, unknown>,
        "state",
        returned.changedFields
      );
      entry.recordsUpdated = [...entry.recordsUpdated, `sim_situations/${situation.situationId}`];
    }
  }
  plan.entries.push(entry);
  void opts;
  return finalizePlan(plan);
}

/** The attempt budget died: the envelope terminates FAILED with NO
 *  output (the F-E8 class — outputId stays null; terminalEnvelopePatch
 *  is deliberately NOT used, since its outputId = taskId would
 *  fabricate the exactly-one-output bijection for an output that does
 *  not exist), and the owner is told via a system Situation (§4.2:
 *  "the caller raises the system Situation that tells the owner their
 *  task died"). */
export function resolveEnvelopeFailureStep(
  snapshot: SimSnapshot,
  step: Extract<WakePassStep, { kind: "envelope-failure" }>,
  opts: { resolutionId: string }
): ResolutionPlan {
  const envDoc = snapshotDoc(snapshot, `sim_task_envelopes/${step.taskId}`);
  if (!envDoc) return emptyPlan(null);
  const env = envDoc as unknown as TaskEnvelopeRecord;
  if (env.status !== "RUNNING" || env.claim?.leaseId !== step.leaseId) return emptyPlan(null);
  if (!failureOutcome(env).raiseSystemSituation) return emptyPlan(null);
  const situationInput = {
    cityId: env.cityId,
    audienceCityId: env.cityId,
    audienceOwnerUidsSnapshot: cityOwnerUids(snapshot, env.cityId),
    recipientUid: env.requestingMemberId,
    kind: "system" as const,
    severity: "important" as const,
    title: `A delegated task died — ${step.taskId}`,
    summary: `Task ${step.taskId} for NPC ${env.npcId} failed on its final attempt (${step.error.code}: ${step.error.message}). No output was produced.`,
    detail: { taskId: step.taskId, npcId: env.npcId, attempts: env.attempts, errorCode: step.error.code },
    source: { kind: "log" as const, sourceId: step.taskId, sourceSeq: env.createdSeq, sourceResolutionId: null },
    createdSeq: summarySeqOf(snapshot),
    now: snapshot.now,
  };
  const situationProbe = buildSituationDoc(situationInput);
  const upsert = planSituationUpsert(
    situationFromSnapshot(snapshot, situationProbe.situationId),
    situationInput
  );
  const situation = upsert.action === "ignore" ? upsert.existing : upsert.doc;
  const plan = emptyPlan(null);
  planWrite(
    plan,
    snapshot,
    `sim_task_envelopes/${step.taskId}`,
    {
      ...env,
      status: "FAILED",
      completionOutcome: "FAILED",
      claim: null,
      lastError: { code: step.error.code, message: step.error.message },
      updatedAt: null,
    } as unknown as Record<string, unknown>,
    "state",
    ["status", "completionOutcome", "claim", "lastError", "updatedAt"]
  );
  const upsertResult = applySituationUpsert(plan, snapshot, upsert);
  plan.entries.push(
    summaryDraft({
      actor: memberActor(env.requestingMemberId),
      cityId: env.cityId,
      cityIds: [env.cityId],
      ruleIds: [],
      recordsCreated: upsertResult.created.map((id) => `sim_situations/${id}`),
      recordsUpdated: [`sim_task_envelopes/${step.taskId}`],
      classification: {
        envelopeFailure: true,
        taskId: step.taskId,
        attempts: env.attempts,
        errorCode: step.error.code,
        situationId: situation.situationId,
      },
      summaryText: `Task ${step.taskId} exhausted its ${env.attempts} attempts and terminated FAILED with no output; system situation ${situation.situationId} tells the owner.`,
    })
  );
  void opts;
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// Delegated-action follow-up: the card completes (or returns) in the
// same wake its delegated action resolves — including when that
// resolution lands in a LATER wake's action phase (the dispatcher
// collects follow-ups from every committed wake-pass action).
// ---------------------------------------------------------------------------

export function resolveSituationFollowupStep(
  snapshot: SimSnapshot,
  step: Extract<WakePassStep, { kind: "situation-followup" }>,
  opts: { resolutionId: string }
): ResolutionPlan {
  const situation = situationFromSnapshot(snapshot, step.situationId);
  const actionDoc = snapshotDoc(snapshot, `sim_actions/${step.actionId}`);
  if (!situation || !actionDoc) return emptyPlan(null);
  if (situation.status !== "delegated" && situation.status !== "awaiting_owner") {
    return emptyPlan(null);
  }
  if (situation.handling?.actionId !== step.actionId) return emptyPlan(null);
  const status = str(actionDoc.status);
  if (status !== "resolved" && status !== "rejected") return emptyPlan(null);
  const ownerUid = situation.handling?.decidedByUid ?? situation.audienceOwnerUidsSnapshot[0] ?? "";
  const plan = emptyPlan(null);
  if (status === "resolved") {
    const transition = markSituationHandled(situation, {
      resolvedSeq: num(actionDoc.lastLogSeq) ?? summarySeqOf(snapshot),
      resolvedByResolutionId: str(actionDoc.resolutionId) ?? opts.resolutionId,
      decidedAt: snapshot.now,
    });
    planWrite(
      plan,
      snapshot,
      `sim_situations/${situation.situationId}`,
      transition.doc as unknown as Record<string, unknown>,
      "state",
      transition.changedFields
    );
    plan.entries.push(
      summaryDraft({
        actor: memberActor(ownerUid),
        cityId: situation.audienceCityId,
        cityIds: situation.audienceCityId ? [situation.audienceCityId] : [],
        ruleIds: [],
        recordsUpdated: [`sim_situations/${situation.situationId}`],
        classification: {
          situationFollowup: "handled",
          actionId: step.actionId,
          situationId: situation.situationId,
        },
        summaryText: `Delegated action ${step.actionId} resolved; situation ${situation.situationId} is handled.`,
      })
    );
  } else {
    const failure = (actionDoc.failure ?? null) as { code?: unknown; message?: unknown } | null;
    const transition = returnSituationToOpen(situation, {
      decidedAt: snapshot.now,
      reason: str(failure?.message) ?? "the delegated action was rejected",
      failedCheck: str(failure?.code),
    });
    planWrite(
      plan,
      snapshot,
      `sim_situations/${situation.situationId}`,
      transition.doc as unknown as Record<string, unknown>,
      "state",
      transition.changedFields
    );
    plan.entries.push(
      summaryDraft({
        actor: memberActor(ownerUid),
        cityId: situation.audienceCityId,
        cityIds: situation.audienceCityId ? [situation.audienceCityId] : [],
        ruleIds: [],
        recordsUpdated: [`sim_situations/${situation.situationId}`],
        classification: {
          situationFollowup: "returned",
          actionId: step.actionId,
          situationId: situation.situationId,
          failureCode: str(failure?.code),
        },
        summaryText: `Delegated action ${step.actionId} was rejected; situation ${situation.situationId} returns to the owner (cycle ${transition.doc.delegationCycleCount}).`,
      })
    );
  }
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// The step resolver the committer calls.
// ---------------------------------------------------------------------------

export function resolveWakePassStep(
  snapshot: SimSnapshot,
  step: WakePassStep,
  opts: { resolutionId: string; cycleId: string; baselineRegistry: BaselineRegistry }
): ResolutionPlan {
  switch (step.kind) {
    case "delegation":
      return evaluateDelegationStep(snapshot, step.situationId, opts).plan;
    case "trigger":
      return resolveTriggerStep(snapshot, step.situationId, opts);
    case "silence":
      return resolveSilenceStep(snapshot, step, opts);
    case "attention":
      return resolveAttentionStep(snapshot, step.pendingId, opts);
    case "envelope-terminal":
      return resolveEnvelopeTerminalStep(snapshot, step, opts);
    case "envelope-failure":
      return resolveEnvelopeFailureStep(snapshot, step, opts);
    case "situation-followup":
      return resolveSituationFollowupStep(snapshot, step, opts);
  }
}
