/**
 * Phase 5 PR-4 (wake completion) — the wake-pass executor.
 *
 * Runs brief §1.3 steps 4–6 (plus the §6.7 needsAttention conversion
 * and the §8 silence pass) as passes over THIS wake's commits, after
 * the action phase and the undo phase, in the dispatcher's wake:
 *
 *   3½. attention conversions (flagged pendings → system Situations;
 *       the same mechanism is the steady state and the first-Phase-5
 *       -wake backfill — conversion is idempotent, so every wake's
 *       pass is a no-op once a pending is stamped);
 *   4.  delegation evaluation over the situations this wake's action +
 *       scan commits created or updated (each evaluated ONCE);
 *   5.  the standing-team trigger pass over the cards step 4 left at
 *       no-match, then delegated-action follow-ups;
 *   5½. the §8 silence pass over the cards still standing open;
 *   6.  the envelope claim pass (a QUEUE pass over live QUEUED state
 *       as it runs — same-wake spawns are claimable — cap 5/wake).
 *
 * Every pass product commits through the committer as sourceKind
 * "wake-pass" (wakeSteps.ts re-derives each step in-transaction).
 * Passes never run a ripeness scan, never evaluate a situation a step
 * of this same wake created (step products are next-wake business),
 * and never fire on a clock: this module runs only inside a wake,
 * and a wake exists only because a player caused it (§1.4).
 *
 * P5-K5 budgets are enforced HERE, at the caller (the modules are
 * pure): envelope claims 5/wake (the claim planner), delegated
 * resolutions 5/wake/city and rule fires 10/wake (this executor) —
 * cap-reached is wake-summary bookkeeping, never a world outcome.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore";
import {
  COMMITTER_VERSION,
  type SimAction,
  type SimSnapshot,
} from "./state";
import {
  buildSnapshot,
  collectActionReadPaths,
  collectActionReadPlan,
  materializeSnapshot,
  type QueryReader,
} from "./resolver";
import { firestoreQueryReader, firestoreReader } from "./readers";
import { computePreview } from "./preview";
import { CommitError, commitResolution, type CommitOutcome } from "./committer";
import {
  delegatedActionId,
  evaluateDelegationStep,
  evaluateTriggerPosture,
  planEnvelopeClaims,
  resolveWakePassStep,
  wakeStepDerivedPaths,
  wakeStepResolutionId,
  wakeStepSeedPaths,
  wakeStepSeedQueries,
  type EnvelopeWorkerOutcome,
  type WakePassStep,
} from "./wakeSteps";
import { situationFromSnapshot } from "./situations";
import { readSituationActionSpec } from "./delegation";
import { npcFromDoc } from "../authority/view";
import { npcActorStanding } from "../authority/actor";
import {
  claimEnvelope,
  failureOutcome,
  type TaskEnvelopeRecord,
} from "../envelopes";
import type { DelegatedActionSpec } from "./delegation";
import type { BaselineRegistry } from "./baseline/registry";

/** The fabric cycle's envelope worker seam (§4.2): claims an envelope,
 *  does the (advisory, never-binding) work elsewhere, and returns the
 *  outcome the terminal transaction lands. Returning null — or
 *  throwing — is a worker failure (§4.2 attempt accounting). */
export type EnvelopeWorker = (
  env: TaskEnvelopeRecord
) => Promise<EnvelopeWorkerOutcome | null>;

export interface WakePassDeps {
  fabricDb: Firestore;
  committerDb: Firestore;
  baselineRegistry: BaselineRegistry;
  queryReader?: QueryReader;
  envelopeWorker?: EnvelopeWorker;
  now: string;
  cycleId: string;
}

export interface WakePassSummary {
  attention: { converted: string[] };
  delegation: {
    evaluated: number;
    fired: { situationId: string; kind: string }[];
    escalated: string[];
    blocked: string[];
    waits: string[];
    noMatch: string[];
    cappedCities: string[];
  };
  triggers: { routed: { situationId: string; outcome: string }[] };
  followups: { situationId: string; actionId: string; outcome: string }[];
  silence: { committed: { situationId: string; producingMode: string }[] };
  claims: {
    claimed: string[];
    completed: { taskId: string; outcome: string }[];
    failed: string[];
    requeued: string[];
    deferredNoWorker: number;
    skipped: { taskId: string; reason: string }[];
  };
  delegatedActions: { actionId: string; situationId: string; outcome: string }[];
  passStepsCommitted: number;
  notes: string[];
  aborted?: string;
}

const DELEGATED_RESOLUTIONS_PER_WAKE_CITY = 5;
const RULE_FIRES_PER_WAKE = 10;
const ATTENTION_QUERY_LIMIT = 25;
const ENVELOPE_QUERY_LIMIT = 50;

function emptySummary(): WakePassSummary {
  return {
    attention: { converted: [] },
    delegation: { evaluated: 0, fired: [], escalated: [], blocked: [], waits: [], noMatch: [], cappedCities: [] },
    triggers: { routed: [] },
    followups: [],
    silence: { committed: [] },
    claims: { claimed: [], completed: [], failed: [], requeued: [], deferredNoWorker: 0, skipped: [] },
    delegatedActions: [],
    passStepsCommitted: 0,
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Step materialization + commit plumbing.
// ---------------------------------------------------------------------------

async function materializeStepSnapshot(
  deps: WakePassDeps,
  step: WakePassStep
): Promise<{ snapshot: SimSnapshot; paths: string[] } | null> {
  const reader = firestoreReader(deps.committerDb);
  const queryReader = deps.queryReader ?? firestoreQueryReader(deps.committerDb);
  let paths = new Set(wakeStepSeedPaths(step));
  for (let round = 0; round < 5; round++) {
    const seed = await buildSnapshot(reader, [...paths], deps.now);
    const queries = wakeStepSeedQueries(step, seed.docs);
    const snapshot = await materializeSnapshot(
      reader,
      queryReader,
      { paths: [...paths], queries },
      deps.now
    );
    const allPaths = new Set([
      ...paths,
      ...snapshot.queries.flatMap((q) => q.resultPaths),
    ]);
    const fresh = wakeStepDerivedPaths(step, snapshot.docs).filter((p) => !allPaths.has(p));
    if (fresh.length === 0) {
      return { snapshot, paths: [...allPaths] };
    }
    paths = allPaths;
    for (const p of fresh) paths.add(p);
  }
  return null;
}

async function commitStep(
  deps: WakePassDeps,
  summary: WakePassSummary,
  step: WakePassStep
): Promise<boolean> {
  const materialized = await materializeStepSnapshot(deps, step);
  if (!materialized) {
    summary.notes.push(`step ${step.kind}: read plan did not close — skipped`);
    return false;
  }
  const resolutionId = wakeStepResolutionId(step, deps.cycleId);
  const plan = resolveWakePassStep(materialized.snapshot, step, {
    resolutionId,
    cycleId: deps.cycleId,
    baselineRegistry: deps.baselineRegistry,
  });
  if (plan.entries.length === 0) return false;
  let outcome: CommitOutcome;
  try {
    outcome = await commitResolution(
      { db: deps.committerDb, baselineRegistry: deps.baselineRegistry },
      {
        resolutionId,
        sourceKind: "wake-pass",
        passStep: step,
        cycleId: deps.cycleId,
        now: deps.now,
        committerVersion: COMMITTER_VERSION,
        plan,
        expectedHeads: materialized.snapshot.heads,
        snapshotPaths: materialized.paths,
        queryRecords: materialized.snapshot.queries,
      }
    );
  } catch (error) {
    const code = error instanceof CommitError ? error.code : "COMMIT_FAILED";
    summary.notes.push(`step ${step.kind} (${resolutionId}) failed: ${code}: ${(error as Error).message}`);
    if (code === "LOG_HEAD_MISMATCH" || code.startsWith("INTEGRITY")) {
      summary.aborted = code;
    }
    return false;
  }
  if (outcome.status === "committed" || outcome.status === "already-committed") {
    summary.passStepsCommitted += 1;
    return true;
  }
  if (outcome.status === "aborted") {
    summary.notes.push(`step ${step.kind} (${resolutionId}) aborted in transaction: ${outcome.code}`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The delegated-action pipeline: a fire's action is a REAL action —
// created by the fabric (rules-fenced to this provenance), previewed,
// confirmed BY THE MANDATE (the standing instruction is the
// confirmation; authorityType "mandate"), claimed, and committed
// through the ordinary action path, so the authority stage re-runs
// inside its transaction (TC-N09's bite). Passes run no scan after it.
// ---------------------------------------------------------------------------

async function snapshotForActionLike(
  deps: WakePassDeps,
  action: SimAction
): Promise<{ snapshot: SimSnapshot; paths: string[] }> {
  const reader = firestoreReader(deps.committerDb);
  const queryReader = deps.queryReader ?? firestoreQueryReader(deps.committerDb);
  const seed = await buildSnapshot(reader, collectActionReadPaths(action), deps.now);
  const readPlan = collectActionReadPlan(action, seed.docs);
  const snapshot = await materializeSnapshot(reader, queryReader, readPlan, deps.now);
  const paths = [
    ...new Set([...readPlan.paths, ...snapshot.queries.flatMap((q) => q.resultPaths)]),
  ];
  return { snapshot, paths };
}

async function executeDelegatedAction(
  deps: WakePassDeps,
  summary: WakePassSummary,
  input: {
    situationId: string;
    ownerUid: string;
    npcId: string;
    mandateId: string | null;
    mandateVersion: number | null;
    spec: DelegatedActionSpec;
    audienceCityId: string | null;
    via: string;
  }
): Promise<"resolved" | "rejected" | "deferred" | "failed"> {
  const actionId = delegatedActionId({
    situationId: input.situationId,
    via: input.via,
    npcId: input.npcId,
    cycleId: deps.cycleId,
  });
  const finish = (outcome: "resolved" | "rejected" | "deferred" | "failed") => {
    summary.delegatedActions.push({ actionId, situationId: input.situationId, outcome });
    return outcome;
  };
  const npcSnap = await getDoc(doc(deps.committerDb, "sim_npcs", input.npcId));
  const npc = npcFromDoc(npcSnap.exists() ? (npcSnap.data() as Record<string, unknown>) : null);
  if (!npc) {
    summary.notes.push(`delegated action ${actionId}: handler NPC ${input.npcId} not readable — deferred`);
    return finish("deferred");
  }
  const mandateId = input.mandateId ?? npc.currentMandateId;
  const mandateVersion = input.mandateVersion ?? npc.currentMandateVersion;
  if (!mandateId || mandateVersion === null) {
    summary.notes.push(`delegated action ${actionId}: NPC ${input.npcId} holds no current mandate — deferred`);
    return finish("deferred");
  }
  const action: SimAction = {
    actionId,
    schemaVersion: 2,
    clientRequestId: actionId,
    idempotencyKey: actionId,
    source: "wake-pass",
    actor: npcActorStanding(npc, mandateId, mandateVersion),
    actionType: input.spec.actionType,
    actionText: null,
    structuredAction: {
      ...input.spec.structuredAction,
      delegatedVia: {
        situationId: input.situationId,
        via: input.via,
        mandateId,
        mandateVersion,
      },
    },
    targetCityIds:
      input.spec.targetCityIds.length > 0
        ? input.spec.targetCityIds
        : [input.audienceCityId ?? npc.cityId],
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
    createdAt: new Date(deps.now),
    updatedAt: new Date(deps.now),
  };
  const actionRef = doc(deps.committerDb, "sim_actions", actionId);
  const existing = await getDoc(actionRef);
  if (!existing.exists()) {
    await setDoc(actionRef, action as unknown as Record<string, unknown>);
  } else if ((existing.data() as SimAction).status === "resolved") {
    return finish("resolved");
  } else if ((existing.data() as SimAction).status === "rejected") {
    return finish("rejected");
  }

  const leaseId = `lease_${deps.cycleId}_${actionId.slice(0, 16)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { snapshot, paths } = await snapshotForActionLike(deps, action);
    const computation = computePreview(snapshot, action, {
      baselineRegistry: deps.baselineRegistry,
      mode: "commit",
    });
    // Preview + confirm-by-mandate in one fabric update (the mandate
    // IS the confirmation — no member confirmation step exists for a
    // delegated action, and the rules' member-confirmation clause is
    // not what carries this: the fabric update branch does).
    await updateDoc(doc(deps.fabricDb, "sim_actions", actionId), {
      preview: { ...computation.preview, previewHash: computation.previewHash },
      previewPlanHash: computation.plan.planHash,
      audienceUids: computation.audienceUids,
      confirmation: {
        confirmedByUid: input.ownerUid,
        confirmedAt: new Date(deps.now),
        previewHash: computation.previewHash,
        authorityType: "mandate",
      },
      status: "confirmed",
      updatedAt: new Date(deps.now),
    });
    const claimed = await runTransaction(deps.fabricDb, async (tx) => {
      const ref = doc(deps.fabricDb, "sim_actions", actionId);
      const snap = await tx.get(ref);
      if (!snap.exists()) return null;
      const current = snap.data() as SimAction;
      if (current.status !== "confirmed") return null;
      const claimedDoc: SimAction = {
        ...current,
        status: "resolving",
        claim: {
          cycleId: deps.cycleId,
          leaseId,
          attempt: (current.claim?.attempt ?? 0) + 1,
          claimedAt: new Date(deps.now),
          leaseExpiresAt: new Date(Date.parse(deps.now) + 10 * 60_000),
        },
        updatedAt: new Date(deps.now),
      };
      tx.set(ref, claimedDoc as unknown as Record<string, unknown>);
      return claimedDoc;
    });
    if (!claimed) return finish("deferred");
    let outcome: CommitOutcome;
    try {
      outcome = await commitResolution(
        { db: deps.committerDb, baselineRegistry: deps.baselineRegistry },
        {
          resolutionId: actionId,
          sourceKind: "action",
          now: deps.now,
          committerVersion: COMMITTER_VERSION,
          plan: computation.plan,
          expectedHeads: snapshot.heads,
          snapshotPaths: paths,
          queryRecords: snapshot.queries,
          action: claimed,
          claimLeaseId: leaseId,
        }
      );
    } catch (error) {
      const code = error instanceof CommitError ? error.code : "COMMIT_FAILED";
      summary.notes.push(`delegated action ${actionId} commit failed: ${code}`);
      if (code === "LOG_HEAD_MISMATCH" || code.startsWith("INTEGRITY")) summary.aborted = code;
      await runTransaction(deps.fabricDb, async (tx) => {
        const ref = doc(deps.fabricDb, "sim_actions", actionId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const current = snap.data() as SimAction;
        if (current.claim?.leaseId !== leaseId) return;
        tx.update(ref, {
          status: "confirmed",
          claim: null,
          lastAttempt: { at: new Date(deps.now), code, message: (error as Error).message },
          updatedAt: new Date(deps.now),
        });
      });
      return finish("failed");
    }
    if (outcome.status === "committed" || outcome.status === "already-committed") {
      const finalSnap = await getDoc(doc(deps.fabricDb, "sim_actions", actionId));
      const finalStatus = (finalSnap.data() as SimAction | undefined)?.status;
      return finish(finalStatus === "rejected" ? "rejected" : "resolved");
    }
    if (outcome.status === "stale-preview") {
      // One re-preview + retry (the dispatcher's discipline); a
      // second stale leaves the action confirmed for the next wake,
      // whose action phase commits it like any confirmed action.
      await runTransaction(deps.fabricDb, async (tx) => {
        const ref = doc(deps.fabricDb, "sim_actions", actionId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const current = snap.data() as SimAction;
        if (current.claim?.leaseId !== leaseId) return;
        tx.update(ref, { status: "confirmed", claim: null, updatedAt: new Date(deps.now) });
      });
      continue;
    }
    return finish("deferred"); // claim lost in transaction
  }
  return finish("deferred");
}

async function runFollowup(
  deps: WakePassDeps,
  summary: WakePassSummary,
  situationId: string,
  actionId: string
): Promise<void> {
  const step: WakePassStep = { kind: "situation-followup", situationId, actionId };
  const committed = await commitStep(deps, summary, step);
  summary.followups.push({
    situationId,
    actionId,
    outcome: committed ? "committed" : "noop",
  });
}

// ---------------------------------------------------------------------------
// The claim pass's transactions.
// ---------------------------------------------------------------------------

async function claimEnvelopeTx(
  deps: WakePassDeps,
  taskId: string,
  leaseId: string
): Promise<TaskEnvelopeRecord | null> {
  const leaseExpiresAt = new Date(Date.parse(deps.now) + 15 * 60_000).toISOString();
  return runTransaction(deps.committerDb, async (tx) => {
    const ref = doc(deps.committerDb, "sim_task_envelopes", taskId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return null;
    const current = snap.data() as TaskEnvelopeRecord;
    const result = claimEnvelope(current, {
      cycleId: deps.cycleId,
      leaseId,
      nowIso: deps.now,
      leaseExpiresAt,
    });
    if (!result.ok) return null;
    tx.update(ref, {
      status: "RUNNING",
      claim: {
        cycleId: deps.cycleId,
        leaseId,
        claimedAt: new Date(deps.now),
        leaseExpiresAt: new Date(leaseExpiresAt),
      },
      attempts: result.envelope.attempts,
      updatedAt: new Date(deps.now),
    });
    return result.envelope;
  });
}

async function requeueEnvelopeTx(
  deps: WakePassDeps,
  taskId: string,
  leaseId: string
): Promise<void> {
  await runTransaction(deps.committerDb, async (tx) => {
    const ref = doc(deps.committerDb, "sim_task_envelopes", taskId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const current = snap.data() as TaskEnvelopeRecord;
    if (current.claim?.leaseId !== leaseId) return;
    tx.update(ref, {
      status: "QUEUED",
      claim: null,
      updatedAt: new Date(deps.now),
    });
  });
}

// ---------------------------------------------------------------------------
// The passes.
// ---------------------------------------------------------------------------

export async function runWakePasses(
  deps: WakePassDeps,
  input: {
    /** Situations this wake's action + scan commits created or
     *  updated, in first-touch order (the dispatcher's manifest
     *  collection — passes run over the wake's commits, never a live
     *  scan of the collection). */
    situationIds: readonly string[];
    /** Wake-pass actions that resolved in this wake's ACTION phase
     *  (created by an earlier wake, resolved now): their cards get
     *  their follow-up here. */
    followups: readonly { situationId: string; actionId: string }[];
  }
): Promise<WakePassSummary> {
  const summary = emptySummary();
  const delegatedResolutionsByCity = new Map<string, number>();
  let ruleFires = 0;

  // -- 3½. Attention conversions -------------------------------------
  const flaggedSnap = await getDocs(
    query(
      collection(deps.committerDb, "sim_pending_consequences"),
      where("needsAttention", "==", true),
      limit(ATTENTION_QUERY_LIMIT)
    )
  );
  const flaggedIds = flaggedSnap.docs.map((d) => d.id).sort();
  const attentionSituationIds: string[] = [];
  for (const pendingId of flaggedIds) {
    if (summary.aborted) break;
    const before = summary.passStepsCommitted;
    const step: WakePassStep = { kind: "attention", pendingId };
    const committed = await commitStep(deps, summary, step);
    if (committed && summary.passStepsCommitted > before) {
      summary.attention.converted.push(pendingId);
      // The conversion's card is itself a this-wake creation: it joins
      // the delegation candidate set below (deterministic id from the
      // pending's stamp — re-derived from the committed step's plan).
      const materialized = await materializeStepSnapshot(deps, step);
      const sitId = materialized
        ? (situationIdFromAttention(materialized.snapshot, pendingId) ?? null)
        : null;
      if (sitId) attentionSituationIds.push(sitId);
    }
  }

  // -- 4. Delegation pass ---------------------------------------------
  const candidates = [...new Set([...input.situationIds, ...attentionSituationIds])];
  const delegationOutcome = new Map<string, string>();
  for (const situationId of candidates) {
    if (summary.aborted) break;
    const step: WakePassStep = { kind: "delegation", situationId };
    const materialized = await materializeStepSnapshot(deps, step);
    if (!materialized) continue;
    const { situation, evaluation, plan } = evaluateDelegationStep(materialized.snapshot, situationId, {
      resolutionId: wakeStepResolutionId(step, deps.cycleId),
      cycleId: deps.cycleId,
      baselineRegistry: deps.baselineRegistry,
    });
    if (!situation) continue;
    summary.delegation.evaluated += 1;
    if (!evaluation) {
      delegationOutcome.set(situationId, "gone");
      continue;
    }
    if (evaluation.outcome === "wait") {
      summary.delegation.waits.push(situationId);
      delegationOutcome.set(situationId, "wait");
      continue;
    }
    if (evaluation.outcome === "no-match") {
      summary.delegation.noMatch.push(situationId);
      delegationOutcome.set(situationId, "no-match");
      continue;
    }
    if (evaluation.outcome === "escalate") {
      if (plan.entries.length > 0) await commitStep(deps, summary, step);
      summary.delegation.escalated.push(situationId);
      delegationOutcome.set(situationId, "escalated");
      continue;
    }
    if (evaluation.outcome === "blocked-handler-authority-changed") {
      if (plan.entries.length > 0) await commitStep(deps, summary, step);
      summary.delegation.blocked.push(situationId);
      delegationOutcome.set(situationId, "blocked");
      continue;
    }
    // fire — budgets first (P5-K5): the caps bind the PASS, and a
    // capped fire simply does not happen this wake (the card rests
    // open; nothing is written).
    const cityId = situation.audienceCityId;
    const cityCount = cityId ? (delegatedResolutionsByCity.get(cityId) ?? 0) : 0;
    if (ruleFires >= RULE_FIRES_PER_WAKE || (cityId !== null && cityCount >= DELEGATED_RESOLUTIONS_PER_WAKE_CITY)) {
      if (cityId && !summary.delegation.cappedCities.includes(cityId)) {
        summary.delegation.cappedCities.push(cityId);
      }
      summary.notes.push(
        `delegation fire for ${situationId} deferred by the P5-K5 wake budgets (rule fires ${ruleFires}/${RULE_FIRES_PER_WAKE}, city resolutions ${cityCount}/${DELEGATED_RESOLUTIONS_PER_WAKE_CITY})`
      );
      delegationOutcome.set(situationId, "capped");
      continue;
    }
    const committed = await commitStep(deps, summary, step);
    if (!committed) {
      delegationOutcome.set(situationId, "noop");
      continue;
    }
    ruleFires += 1;
    if (cityId) delegatedResolutionsByCity.set(cityId, cityCount + 1);
    summary.delegation.fired.push({ situationId, kind: evaluation.fire.kind });
    delegationOutcome.set(situationId, "fired");
    if (evaluation.fire.kind === "delegated-action" && evaluation.fire.actionSpec && evaluation.fire.npcId) {
      const outcome = await executeDelegatedAction(deps, summary, {
        situationId,
        ownerUid: evaluation.fire.ownerUid,
        npcId: evaluation.fire.npcId,
        mandateId: evaluation.fire.mandateId,
        mandateVersion: evaluation.fire.mandateVersion,
        spec: evaluation.fire.actionSpec,
        audienceCityId: situation.audienceCityId,
        via: evaluation.fire.ruleId,
      });
      if (outcome === "resolved" || outcome === "rejected") {
        const actionId = delegatedActionId({
          situationId,
          via: evaluation.fire.ruleId,
          npcId: evaluation.fire.npcId,
          cycleId: deps.cycleId,
        });
        await runFollowup(deps, summary, situationId, actionId);
      }
    }
  }

  // -- 5. Standing-team trigger pass (step-4 no-match cards only) -----
  const postureBySituation = new Map<string, ReturnType<typeof evaluateTriggerPosture>>();
  for (const situationId of candidates) {
    if (summary.aborted) break;
    if (delegationOutcome.get(situationId) !== "no-match") continue;
    const step: WakePassStep = { kind: "trigger", situationId };
    const materialized = await materializeStepSnapshot(deps, step);
    if (!materialized) continue;
    const situation = situationFromSnapshot(materialized.snapshot, situationId);
    if (!situation) continue;
    const posture = evaluateTriggerPosture(materialized.snapshot, situation);
    postureBySituation.set(situationId, posture);
    if (posture.outcome !== "act" && posture.outcome !== "draft" && posture.outcome !== "escalate-tier-b") {
      continue;
    }
    const cityId = situation.audienceCityId;
    const cityCount = cityId ? (delegatedResolutionsByCity.get(cityId) ?? 0) : 0;
    if (posture.outcome === "act" && cityId !== null && cityCount >= DELEGATED_RESOLUTIONS_PER_WAKE_CITY) {
      summary.notes.push(`trigger act for ${situationId} deferred by the P5-K5 per-city budget`);
      continue;
    }
    const committed = await commitStep(deps, summary, step);
    if (!committed) continue;
    if (cityId && posture.outcome === "act") {
      delegatedResolutionsByCity.set(cityId, cityCount + 1);
    }
    summary.triggers.routed.push({ situationId, outcome: posture.outcome });
    if (posture.outcome === "act") {
      const spec = readSituationActionSpec(situation);
      if (spec) {
        const outcome = await executeDelegatedAction(deps, summary, {
          situationId,
          ownerUid: posture.ownerUid,
          npcId: posture.npcId,
          mandateId: posture.mandateId,
          mandateVersion: posture.mandateVersion,
          spec,
          audienceCityId: situation.audienceCityId,
          via: "trigger",
        });
        if (outcome === "resolved" || outcome === "rejected") {
          const actionId = delegatedActionId({
            situationId,
            via: "trigger",
            npcId: posture.npcId,
            cycleId: deps.cycleId,
          });
          await runFollowup(deps, summary, situationId, actionId);
        }
      }
    }
  }

  // -- Follow-ups for wake-pass actions resolved in the action phase --
  for (const followup of input.followups) {
    if (summary.aborted) break;
    await runFollowup(deps, summary, followup.situationId, followup.actionId);
  }

  // -- 5½. Silence pass ------------------------------------------------
  for (const situationId of candidates) {
    if (summary.aborted) break;
    if (delegationOutcome.get(situationId) !== "no-match") continue;
    const posture = postureBySituation.get(situationId);
    if (!posture) continue;
    if (posture.outcome === "silent") {
      const step: WakePassStep = {
        kind: "silence",
        situationId,
        npcId: posture.npcId,
        mandateId: posture.mandateId,
        mandateVersion: posture.mandateVersion,
      };
      if (await commitStep(deps, summary, step)) {
        summary.silence.committed.push({ situationId, producingMode: "npc-silent-mode" });
      }
    } else if (posture.outcome === "unempowered") {
      const step: WakePassStep = {
        kind: "silence",
        situationId,
        npcId: null,
        mandateId: null,
        mandateVersion: null,
      };
      if (await commitStep(deps, summary, step)) {
        summary.silence.committed.push({ situationId, producingMode: "no-permission" });
      }
    }
    // act/draft/escalate/no-act postures are not silence (named in the
    // prep report): the card rests open without a §8 entry.
  }

  // -- 6. Envelope claim pass ------------------------------------------
  if (!summary.aborted) {
    const records: TaskEnvelopeRecord[] = [];
    for (const status of ["QUEUED", "RUNNING"] as const) {
      const snap = await getDocs(
        query(
          collection(deps.committerDb, "sim_task_envelopes"),
          where("status", "==", status),
          limit(ENVELOPE_QUERY_LIMIT)
        )
      );
      for (const d of snap.docs) records.push(d.data() as TaskEnvelopeRecord);
    }
    const decisions = planEnvelopeClaims(records, { nowIso: deps.now });
    summary.claims.skipped = decisions.skipped;
    if (!deps.envelopeWorker) {
      // No execution seam in this wake: claiming without executing
      // would burn attempts and strand envelopes RUNNING until lease
      // expiry — the pass claims nothing and reports the deferral.
      summary.claims.deferredNoWorker = decisions.claims.length;
    } else {
      for (const claim of decisions.claims) {
        if (summary.aborted) break;
        const leaseId = `lease_${deps.cycleId}_${claim.taskId.slice(0, 20)}`;
        const claimed = await claimEnvelopeTx(deps, claim.taskId, leaseId);
        if (!claimed) continue;
        summary.claims.claimed.push(claim.taskId);
        let workerOutcome: EnvelopeWorkerOutcome | null = null;
        let workerError: { code: string; message: string } | null = null;
        try {
          workerOutcome = await deps.envelopeWorker(claimed);
        } catch (error) {
          workerError = {
            code: "worker_failed",
            message: (error as Error).message ?? String(error),
          };
        }
        if (workerOutcome) {
          const step: WakePassStep = {
            kind: "envelope-terminal",
            taskId: claim.taskId,
            leaseId,
            outcome: workerOutcome,
          };
          if (await commitStep(deps, summary, step)) {
            summary.claims.completed.push({ taskId: claim.taskId, outcome: workerOutcome.outcome });
          }
        } else {
          const freshSnap = await getDoc(doc(deps.committerDb, "sim_task_envelopes", claim.taskId));
          const fresh = freshSnap.data() as TaskEnvelopeRecord;
          if (!failureOutcome(fresh).raiseSystemSituation) {
            await requeueEnvelopeTx(deps, claim.taskId, leaseId);
            summary.claims.requeued.push(claim.taskId);
          } else {
            const step: WakePassStep = {
              kind: "envelope-failure",
              taskId: claim.taskId,
              leaseId,
              error: workerError ?? { code: "worker_failed", message: "the worker returned no outcome" },
            };
            if (await commitStep(deps, summary, step)) {
              summary.claims.failed.push(claim.taskId);
            }
          }
        }
      }
    }
  }

  return summary;
}

/** The attention conversion's card id, read back from the pending's
 *  stamp on the materialized (post-commit) snapshot. */
function situationIdFromAttention(snapshot: SimSnapshot, pendingId: string): string | null {
  const pending = snapshot.docs.get(`sim_pending_consequences/${pendingId}`) ?? null;
  const stamp = pending?.attentionSituationId;
  return typeof stamp === "string" && stamp.length > 0 ? stamp : null;
}
