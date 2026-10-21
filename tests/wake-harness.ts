/**
 * Phase 5 PR-4 (wake completion) — the wake-pass harness.
 *
 * Pure (no emulator): drives the REAL wake-step resolvers
 * (lib/sim/wakeSteps.ts) and the claim planner against fixture
 * snapshots, and asserts the pass contract the dispatcher wires:
 *
 *   W1–W4   the delegation pass inside a wake (fire delegated-action,
 *           fire envelope, wait writes nothing, Tier B escalates);
 *   W5–W8   the standing-team trigger pass (act, ask-first draft,
 *           Tier B escalate, first-contemplated-candidate governance);
 *   W9–W11  the §8 silence pass (teamless no-permission, teamed
 *           silent NPC, and the verification bites: rules win, stale
 *           posture claims refuse);
 *   W12     the needsAttention conversion + backfill idempotence
 *           across two wakes (P5-K8: the pending patch is one key);
 *   W13     the claim planner (cap 5, lease fencing, availability
 *           floor, attempt budget, F-E8 terminal-without-output);
 *   W14–W18 the terminal + failure steps (DONE bijection, the
 *           revalidation bite — revoke between queue and claim
 *           refuses at claim, the E9 owner-direct/rule-spawned pair,
 *           FAILED returns the delegated card, budget-death raises
 *           the system Situation with NO output);
 *   W19     delegated-action follow-ups (handled / returned);
 *   W20     F-E9: envelope.spawn preview/commit parity after the fix;
 *   W21     WakeScanState: mid-wake-created pendings wait (the
 *           candidate snapshot is wake-start-bound);
 *   W22     the spawn-refusal fallback inside a fire step;
 *   W23     the step read-plan contract: every step kind's seed paths
 *           carry sim_counters/log (the mandatory snapshot input —
 *           PR-4 fix round 1's regression pin).
 *   W24     the executor's delegated-action construction
 *           (buildDelegatedActionDoc) carries the §3.2 situation
 *           trigger citation — the stage resolves the built action;
 *           the same action unstamped rejects NO_TRIGGER_ROOT
 *           (PR #45 fix round 6's regression pin).
 *
 * Every composed plan runs the real validatePlan (the committer's
 * §5.6/§6.3 guards incl. F-02 reconciliation) before assertions.
 *
 * Run: npx tsx tests/wake-harness.ts
 */

import assert from "node:assert/strict";
import {
  collectActionReadPaths,
  collectActionReadPlan,
  digestQueryResults,
  resolveAction,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { WakeScanState } from "../lib/sim/pending";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildActionDoc } from "../lib/sim/intake";
import { buildLogEntry, headHashOf } from "../lib/sim/log";
import { summaryDraft } from "../lib/sim/rules/planHelpers";
import type {
  ResolutionPlan,
  SimAction,
  SimActor,
  SimSnapshot,
  SnapshotQueryRecord,
} from "../lib/sim/state";
import {
  buildSituationDoc,
  silencePlanWritesOnlySituation,
  type SimSituation,
} from "../lib/sim/situations";
import {
  WAKE_RULES_QUERY_ID,
  buildDelegatedActionDoc,
  delegatedActionId,
  evaluateDelegationStep,
  evaluateTriggerPosture,
  isTerminalWithoutOutput,
  planEnvelopeClaims,
  resolveAttentionStep,
  resolveEnvelopeFailureStep,
  resolveEnvelopeTerminalStep,
  resolveSilenceStep,
  resolveSituationFollowupStep,
  resolveTriggerStep,
  wakeStepResolutionId,
  wakeStepSeedPaths,
  type WakePassStep,
} from "../lib/sim/wakeSteps";
import { buildTaskEnvelope, envelopeTaskId, type TaskEnvelopeRecord } from "../lib/envelopes";
import { buildMandateVersion } from "../lib/npcs";
import { npcFromDoc } from "../lib/authority/view";
import { readSituationActionSpec } from "../lib/sim/delegation";
import { validateNpcActorForm } from "../lib/authority/actor";

const registry = buildFixtureBaselineRegistry();
const NOW = "2026-10-20T15:00:00.000Z";
const NOW_LATER = "2026-10-21T09:30:00.000Z";
const CYCLE = "cycle-wake-1";
const HEAD_SEQ = 40;

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(3, " ")} — ${label}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const OWNER: SimActor = {
  type: "member", memberId: "ownerA", npcId: null, onBehalfOfMemberId: null,
  mandateId: null, mandateVersion: null, envelopeId: null,
};

// ---------------------------------------------------------------------------
// Fixture world.
// ---------------------------------------------------------------------------

function baseDocs(): Map<string, Record<string, unknown> | null> {
  const docs = new Map<string, Record<string, unknown> | null>();
  docs.set("sim_world/current", { schemaVersion: 2 });
  docs.set("sim_counters/log", { lastSeq: HEAD_SEQ, lastEntryHash: "hash40" });
  docs.set("factions/cityA", { name: "Fixture City A", ownerUids: ["ownerA"] });
  docs.set("factions/cityB", { name: "Fixture City B", ownerUids: ["ownerB"] });
  return docs;
}

function npcDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    npcId: "npc1", characterId: "charA1", cityId: "cityA", ownerUid: "ownerA",
    permissionMode: "act-for-me", status: "active",
    currentMandateId: "mandate1", currentMandateVersion: 1,
    activationSeq: 5, retiredSeq: null,
    ...overrides,
  };
}

function mandateRoot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mandateId: "mandate1", npcId: "npc1", ownerUid: "ownerA", cityId: "cityA",
    status: "active", currentVersion: 1, revokedSeq: null,
    ...overrides,
  };
}

function mandateVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Built with the real builder so the stored doc's mandateHash
  // recomputes — the stage's projection verifies it and fails closed.
  const built = buildMandateVersion(
    {
      version: 1,
      npcId: "npc1",
      cityId: "cityA",
      ownerUid: "ownerA",
      permissionMode: "act-for-me",
      scopeFreeform: "Handle the city's routine business.",
      structuredScope: {
        triggerKinds: ["situation", "log-event"],
        allowedActionTypes: [],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: {},
      negotiationBounds: null,
      alwaysEscalate: [],
      responseStyle: null,
      expiresAtSeq: null,
      horizonActions: null,
      sourceActionId: "act-mandate-1",
      ...overrides,
    } as never,
    new Date(NOW)
  );
  return { ...built, effectiveSeq: 6 } as unknown as Record<string, unknown>;
}

function ruleDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ruleId: "rule1", ownerUid: "ownerA", cityId: "cityA", version: 1,
    enabled: true, priority: 10,
    match: {
      situationKinds: ["proposal"], sourceKinds: [], cityIds: null,
      counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [],
    },
    handler: { npcId: "npc1", mode: "act-for-me", mandateId: "mandate1" },
    caps: {}, alwaysWait: false, ruleHash: "rulehash1",
    effectiveSeq: 8, status: "active", createdAt: null, updatedAt: null,
  };
  const out = { ...base, ...overrides };
  if (overrides.match) out.match = { ...(base.match as object), ...(overrides.match as object) };
  if (overrides.handler) out.handler = { ...(base.handler as object), ...(overrides.handler as object) };
  return out;
}

function teamDoc(npcIds: string[]): Record<string, unknown> {
  return { cityId: "cityA", npcIds };
}

function standingNpc(docs: Map<string, Record<string, unknown> | null>, overrides: {
  npc?: Record<string, unknown>;
  root?: Record<string, unknown>;
  version?: Record<string, unknown>;
  rule?: Record<string, unknown> | null;
  team?: string[] | null;
} = {}): void {
  docs.set("sim_npcs/npc1", npcDoc(overrides.npc));
  docs.set("sim_mandates/mandate1", mandateRoot(overrides.root));
  docs.set("sim_mandates/mandate1/versions/1", mandateVersion(overrides.version));
  if (overrides.rule !== null) docs.set("sim_delegation_rules/rule1", ruleDoc(overrides.rule));
  if (overrides.team !== null) docs.set("sim_teams/cityA", teamDoc(overrides.team ?? ["npc1"]));
}

function makeSituation(input: {
  kind: string;
  cityId?: string;
  detail?: Record<string, unknown>;
  sourceSeq?: number;
}): SimSituation {
  const cityId = input.cityId ?? "cityA";
  return buildSituationDoc({
    cityId,
    audienceCityId: cityId,
    audienceOwnerUidsSnapshot: [cityId === "cityA" ? "ownerA" : "ownerB"],
    recipientUid: null,
    kind: input.kind as never,
    severity: "routine",
    title: `Fixture ${input.kind}`,
    summary: `A fixture ${input.kind} card.`,
    detail: input.detail ?? {},
    source: {
      kind: "log",
      sourceId: "evt-fixture",
      sourceSeq: input.sourceSeq ?? 39,
      sourceResolutionId: "res-fixture",
    },
    createdSeq: input.sourceSeq ?? 39,
    now: NOW,
  });
}

function snapshotOf(
  docs: Map<string, Record<string, unknown> | null>,
  now: string = NOW,
  ruleCityId: string | null = "cityA"
): SimSnapshot {
  const queryRecords: SnapshotQueryRecord[] = [];
  if (ruleCityId) {
    const spec = {
      id: WAKE_RULES_QUERY_ID,
      collectionPath: "sim_delegation_rules",
      filters: [{ field: "cityId", op: "==" as const, value: ruleCityId }],
    };
    const results: { path: string; doc: Record<string, unknown> }[] = [];
    for (const [path, doc] of docs) {
      if (path.startsWith("sim_delegation_rules/") && doc && doc.cityId === ruleCityId) {
        results.push({ path, doc });
      }
    }
    queryRecords.push({
      spec,
      resultPaths: results.map((r) => r.path),
      digest: digestQueryResults(spec, results.map((r) => ({ path: r.path, hash: headHashOf(r.doc) }))),
    });
  }
  return snapshotFromDocs(docs, now, queryRecords);
}

function putSituation(docs: Map<string, Record<string, unknown> | null>, sit: SimSituation): void {
  docs.set(`sim_situations/${sit.situationId}`, sit as unknown as Record<string, unknown>);
}

function assertPlanValid(plan: ResolutionPlan, snapshot: SimSnapshot): void {
  validatePlan(plan, { baselineRegistry: registry, covertEntriesAllowed: false, snapshot });
}

function planWriteFor(plan: ResolutionPlan, path: string) {
  return plan.writes.find((w) => w.path === path);
}

// ---------------------------------------------------------------------------
section("W1–W4 — the delegation pass");

check("W1 a rule fire (delegated-action) composes transition + fire entry + the action citation", () => {
  const docs = baseDocs();
  standingNpc(docs);
  const sit = makeSituation({
    kind: "proposal",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-1" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const step: WakePassStep = { kind: "delegation", situationId: sit.situationId };
  const resolutionId = wakeStepResolutionId(step, CYCLE);
  const { evaluation, plan } = evaluateDelegationStep(snapshot, sit.situationId, {
    resolutionId, cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(evaluation?.outcome, "fire");
  if (evaluation?.outcome !== "fire") throw new Error("unreachable");
  assert.equal(evaluation.fire.kind, "delegated-action");
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].classification?.delegationFire, true);
  const expectedActionId = delegatedActionId({
    situationId: sit.situationId, via: "rule1", npcId: "npc1", cycleId: CYCLE,
  });
  const write = planWriteFor(plan, `sim_situations/${sit.situationId}`);
  assert.ok(write, "the fire writes the situation transition");
  const after = write.afterDoc as unknown as SimSituation;
  assert.equal(after.status, "delegated");
  assert.equal(after.handling?.actionId, expectedActionId);
  assert.equal(after.handling?.mode, "auto-delegated");
});

check("W2 a rule fire without an action spec spawns the envelope in the same step (same-wake claimable)", () => {
  const docs = baseDocs();
  standingNpc(docs);
  const sit = makeSituation({ kind: "proposal", detail: { question: "Should we fund the archive?" } });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const step: WakePassStep = { kind: "delegation", situationId: sit.situationId };
  const resolutionId = wakeStepResolutionId(step, CYCLE);
  const { evaluation, plan } = evaluateDelegationStep(snapshot, sit.situationId, {
    resolutionId, cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(evaluation?.outcome, "fire");
  if (evaluation?.outcome !== "fire") throw new Error("unreachable");
  assert.equal(evaluation.fire.kind, "envelope");
  assertPlanValid(plan, snapshot);
  const taskId = envelopeTaskId("ownerA", resolutionId);
  const envWrite = planWriteFor(plan, `sim_task_envelopes/${taskId}`);
  assert.ok(envWrite, "the fire step's plan carries the envelope document");
  const env = envWrite.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(env.status, "QUEUED");
  assert.equal(env.requestingMemberId, "ownerA");
  assert.equal(env.threadRef?.id, sit.situationId);
  // F-E9 discharged for pass spawns by construction: the step injects
  // the wake's instant explicitly, so preview and in-transaction
  // recompute (same injected now) build the identical envelope.
  assert.equal(env.availableAt, NOW);
  assert.equal(env.createdSeq, HEAD_SEQ + 1);
  const after = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after.handling?.taskId, taskId);
});

check("W3 a wait rule writes NOTHING — the card rests open and the step is a no-op", () => {
  const docs = baseDocs();
  standingNpc(docs, {
    rule: ruleDoc({ alwaysWait: true, handler: { npcId: "npc1", mode: "wait-for-owner", mandateId: "mandate1" } }),
  });
  const sit = makeSituation({ kind: "proposal" });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const { evaluation, plan } = evaluateDelegationStep(snapshot, sit.situationId, {
    resolutionId: "wake_delegation_x", cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(evaluation?.outcome, "wait");
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.writes.length, 0);
});

check("W4 a Tier B situation escalates: one audit entry, no transition, the card stays open", () => {
  const docs = baseDocs();
  standingNpc(docs, { rule: ruleDoc({ match: { situationKinds: ["legal"] } }) });
  const sit = makeSituation({ kind: "legal" });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const { evaluation, plan } = evaluateDelegationStep(snapshot, sit.situationId, {
    resolutionId: "wake_delegation_x", cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(evaluation?.outcome, "escalate");
  if (evaluation?.outcome !== "escalate") throw new Error("unreachable");
  assert.equal(evaluation.code, "tier-b");
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.writes.length, 0);
});

// ---------------------------------------------------------------------------
section("W5–W8 — the standing-team trigger pass");

check("W5 act-for-me trigger routes the card and allocates the delegated action", () => {
  const docs = baseDocs();
  standingNpc(docs, { rule: null });
  const sit = makeSituation({
    kind: "incident",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-9" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const plan = resolveTriggerStep(snapshot, sit.situationId, { resolutionId: "wake_trigger_x", cycleId: CYCLE });
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].classification?.triggerEvaluation, "delegated-action");
  const after = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after.status, "delegated");
  assert.equal(
    after.handling?.actionId,
    delegatedActionId({ situationId: sit.situationId, via: "trigger", npcId: "npc1", cycleId: CYCLE })
  );
});

check("W6 ask-first trigger drafts: the card lands awaiting_owner with no action allocated", () => {
  const docs = baseDocs();
  standingNpc(docs, {
    rule: null,
    npc: npcDoc({ permissionMode: "ask-first" }),
    version: mandateVersion({ permissionMode: "ask-first" }),
  });
  const sit = makeSituation({
    kind: "incident",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-9" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const plan = resolveTriggerStep(snapshot, sit.situationId, { resolutionId: "wake_trigger_x", cycleId: CYCLE });
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries[0].classification?.triggerEvaluation, "draft");
  const after = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after.status, "awaiting_owner");
  assert.equal(after.handling?.actionId, null);
});

check("W7 a Tier B card under an act-for-me trigger escalates — entry only, card untouched", () => {
  const docs = baseDocs();
  standingNpc(docs, { rule: null });
  const sit = makeSituation({ kind: "legal" });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const plan = resolveTriggerStep(snapshot, sit.situationId, { resolutionId: "wake_trigger_x", cycleId: CYCLE });
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].classification?.triggerEvaluation, "escalate");
  assert.equal(plan.writes.length, 0);
});

check("W8 the FIRST contemplated candidate governs: a silent first candidate yields silence posture even with an act-for-me second", () => {
  const docs = baseDocs();
  standingNpc(docs, { rule: null, team: ["npc0", "npc1"] });
  docs.set("sim_npcs/npc0", npcDoc({
    npcId: "npc0", permissionMode: "silent", currentMandateId: "mandate0", currentMandateVersion: 1,
  }));
  docs.set("sim_mandates/mandate0", mandateRoot({ mandateId: "mandate0", npcId: "npc0" }));
  docs.set("sim_mandates/mandate0/versions/1", mandateVersion({
    mandateId: "mandate0", npcId: "npc0", permissionMode: "silent",
  }));
  const sit = makeSituation({
    kind: "incident",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-9" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const posture = evaluateTriggerPosture(snapshot, sit);
  assert.equal(posture.outcome, "silent");
  const plan = resolveTriggerStep(snapshot, sit.situationId, { resolutionId: "wake_trigger_x", cycleId: CYCLE });
  assert.equal(plan.entries.length, 0);
});

// ---------------------------------------------------------------------------
section("W9–W11 — the §8 silence pass");

check("W9 a teamless city's unanswered card gets the no-permission silence commit (P5-K9 member actor)", () => {
  const docs = baseDocs();
  const sit = makeSituation({ kind: "incident", cityId: "cityB" });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs, NOW, null);
  const plan = resolveSilenceStep(
    snapshot,
    { kind: "silence", situationId: sit.situationId, npcId: null, mandateId: null, mandateVersion: null },
    { resolutionId: "wake_silence_x", baselineRegistry: registry }
  );
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.ok(silencePlanWritesOnlySituation(plan, sit.situationId));
  const entry = plan.entries[0];
  assert.equal(entry.actor.type, "member");
  assert.equal(entry.actor.memberId, "ownerB");
  assert.match(entry.summaryText, /didn't say anything/);
  assert.equal(entry.classification?.producingMode, "no-permission");
  const after = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after.status, "silent");
});

check("W10 a teamed city's silence is the silent NPC's, with its mandate citation", () => {
  const docs = baseDocs();
  standingNpc(docs, {
    rule: null,
    npc: npcDoc({ permissionMode: "silent" }),
    version: mandateVersion({ permissionMode: "silent" }),
  });
  const sit = makeSituation({ kind: "incident" });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const plan = resolveSilenceStep(
    snapshot,
    { kind: "silence", situationId: sit.situationId, npcId: "npc1", mandateId: "mandate1", mandateVersion: 1 },
    { resolutionId: "wake_silence_x", baselineRegistry: registry }
  );
  assertPlanValid(plan, snapshot);
  const entry = plan.entries[0];
  assert.equal(entry.actor.type, "npc");
  assert.equal(entry.actor.npcId, "npc1");
  assert.equal(entry.classification?.producingMode, "npc-silent-mode");
});

check("W11 silence verification bites: a rule-owned card and a stale posture claim both refuse", () => {
  const docs = baseDocs();
  standingNpc(docs);
  const sit = makeSituation({
    kind: "proposal",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-1" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const snapshot = snapshotOf(docs);
  const plan = resolveSilenceStep(
    snapshot,
    { kind: "silence", situationId: sit.situationId, npcId: null, mandateId: null, mandateVersion: null },
    { resolutionId: "wake_silence_x", baselineRegistry: registry }
  );
  assert.equal(plan.entries.length, 0, "a card a rule fires on never receives a silence commit");
  // Stale claim: the spec names a silent NPC, but the standing posture
  // is act-for-me with a spec — the step must refuse, not record.
  const docs2 = baseDocs();
  standingNpc(docs2, { rule: null });
  const sit2 = makeSituation({
    kind: "incident",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-1" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs2, sit2);
  const snapshot2 = snapshotOf(docs2);
  const plan2 = resolveSilenceStep(
    snapshot2,
    { kind: "silence", situationId: sit2.situationId, npcId: "npc1", mandateId: "mandate1", mandateVersion: 1 },
    { resolutionId: "wake_silence_y", baselineRegistry: registry }
  );
  assert.equal(plan2.entries.length, 0, "a posture claim the stored state contradicts is refused");
});

// ---------------------------------------------------------------------------
section("W12 — needsAttention conversion + backfill idempotence");

check("W12 the conversion stamps exactly one key (P5-K8) and a second wake converts nothing", () => {
  const docs = baseDocs();
  docs.set("factions/cityA", { name: "Fixture City A", ownerUids: ["ownerA"] });
  const pending = {
    pendingId: "pend-attn-1",
    kind: "innovation-ripening",
    status: "failed",
    originCityId: "cityA",
    originActor: OWNER,
    originSeq: 12,
    originResolutionId: "res-12",
    attempts: 3,
    needsAttention: true,
    lastFailure: { code: "GENERATION_FAILED", message: "the generator refused" },
    attentionSituationId: null,
    audienceUids: ["ownerA"],
  };
  docs.set("sim_pending_consequences/pend-attn-1", pending);
  const snapshot = snapshotOf(docs);
  const plan = resolveAttentionStep(snapshot, "pend-attn-1", { resolutionId: "wake_attention_x" });
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].classification?.attentionConversion, true);
  const pendingWrite = planWriteFor(plan, "sim_pending_consequences/pend-attn-1");
  assert.ok(pendingWrite);
  assert.deepEqual(pendingWrite.changedFields, ["attentionSituationId"]);
  const afterPending = pendingWrite.afterDoc as Record<string, unknown>;
  const sitId = afterPending.attentionSituationId as string;
  assert.ok(typeof sitId === "string" && sitId.length > 0);
  const restAfter = { ...afterPending };
  delete restAfter.attentionSituationId;
  const restBefore: Record<string, unknown> = { ...pending };
  delete restBefore.attentionSituationId;
  assert.deepEqual(restAfter, restBefore, "nothing but the stamp changed on the pending");
  assert.ok(planWriteFor(plan, `sim_situations/${sitId}`), "the conversion card is created");
  // Second wake: the stamp stands — the step is a no-op (this is what
  // makes the first-Phase-5-wake backfill safe to run every wake).
  const docs2 = new Map(docs);
  docs2.set("sim_pending_consequences/pend-attn-1", afterPending);
  const snapshot2 = snapshotOf(docs2);
  const plan2 = resolveAttentionStep(snapshot2, "pend-attn-1", { resolutionId: "wake_attention_y" });
  assert.equal(plan2.entries.length, 0);
  // And an unflagged pending never converts.
  const docs3 = new Map(docs);
  docs3.set("sim_pending_consequences/pend-attn-1", { ...pending, needsAttention: false });
  const plan3 = resolveAttentionStep(snapshotOf(docs3), "pend-attn-1", { resolutionId: "wake_attention_z" });
  assert.equal(plan3.entries.length, 0);
});

console.log(`\n(wake harness part 1 complete — ${checks} checks)`);

// ---------------------------------------------------------------------------
section("W13 — the claim planner");

function makeEnvelope(overrides: Partial<TaskEnvelopeRecord> = {}): TaskEnvelopeRecord {
  const env = buildTaskEnvelope({
    requestingMemberId: "ownerA",
    npcId: "npc1",
    cityId: "cityA",
    threadRef: null,
    taskType: "one-off",
    task: "Draft the weekly digest.",
    structuredIntent: null,
    bounds: {},
    spawnActionId: "act-spawn-fixture",
    clientRequestId: `req-${Math.random().toString(36).slice(2, 10)}`,
    availableAt: NOW,
    nowIso: NOW,
    createdSeq: 30,
  });
  return { ...env, ...overrides };
}

check("W13 cap 5 binds; leases fence; the availability floor defers; F-E8's class is never claimed", () => {
  const queued = Array.from({ length: 7 }, (_, i) =>
    makeEnvelope({ taskId: `env_q${i}`, createdSeq: 10 + i })
  );
  const liveLease = makeEnvelope({
    taskId: "env_live",
    createdSeq: 20,
    status: "RUNNING",
    attempts: 1,
    claim: { cycleId: "c0", leaseId: "lease-live", claimedAt: NOW, leaseExpiresAt: "2026-10-20T16:00:00.000Z" },
  });
  const expiredLease = makeEnvelope({
    taskId: "env_expired",
    createdSeq: 21,
    status: "RUNNING",
    attempts: 1,
    claim: { cycleId: "c0", leaseId: "lease-dead", claimedAt: NOW, leaseExpiresAt: "2026-10-20T14:00:00.000Z" },
  });
  const future = makeEnvelope({ taskId: "env_future", createdSeq: 22, availableAt: "2026-10-22T00:00:00.000Z" });
  const exhausted = makeEnvelope({ taskId: "env_spent", createdSeq: 23, attempts: 3 });
  const cancelled = makeEnvelope({
    taskId: "env_cancelled",
    createdSeq: 24,
    status: "FAILED",
    completionOutcome: "FAILED",
    outputId: null,
    lastError: { code: "cancelled_before_claim", message: "cancelled by the owner before any claim" },
  });
  const done = makeEnvelope({
    taskId: "env_done", createdSeq: 25, status: "DONE", completionOutcome: "DONE", outputId: "env_done",
  });
  const decisions = planEnvelopeClaims(
    [...queued, liveLease, expiredLease, future, exhausted, cancelled, done],
    { nowIso: NOW }
  );
  assert.equal(decisions.claims.length, 5, "the P5-K5 claim cap binds at 5");
  assert.deepEqual(
    decisions.claims.map((c) => c.taskId),
    ["env_q0", "env_q1", "env_q2", "env_q3", "env_q4"],
    "claims run in createdSeq order"
  );
  const skip = new Map(decisions.skipped.map((s) => [s.taskId, s.reason]));
  assert.equal(skip.get("env_q5"), "cap");
  assert.equal(skip.get("env_q6"), "cap");
  assert.equal(skip.get("env_live"), "live-lease");
  assert.equal(skip.get("env_future"), "not-yet-available");
  assert.equal(skip.get("env_spent"), "attempts-exhausted");
  assert.equal(skip.get("env_cancelled"), "terminal-without-output");
  assert.equal(skip.get("env_done"), "terminal");
  // The expired lease is recoverable by THIS claim pass (not a
  // scheduler): with cap room it would claim — verify on a small set.
  const small = planEnvelopeClaims([expiredLease], { nowIso: NOW });
  assert.deepEqual(small.claims, [{ taskId: "env_expired", recovered: true }]);
  assert.ok(isTerminalWithoutOutput(cancelled));
  assert.ok(!isTerminalWithoutOutput(done));
});

// ---------------------------------------------------------------------------
section("W14–W18 — envelope terminal + failure steps");

const LEASE = "lease-wake-1";

function runningEnvelope(overrides: Partial<TaskEnvelopeRecord> = {}): TaskEnvelopeRecord {
  return makeEnvelope({
    status: "RUNNING",
    attempts: 1,
    claim: { cycleId: CYCLE, leaseId: LEASE, claimedAt: NOW, leaseExpiresAt: "2026-10-20T15:30:00.000Z" },
    createdSeq: 30,
    ...overrides,
  });
}

function spawnEntryDoc(fire: boolean, seq: number): Record<string, unknown> {
  const draft = summaryDraft({
    actor: fire
      ? { type: "npc", memberId: null, npcId: "npc1", onBehalfOfMemberId: "ownerA", mandateId: "mandate1", mandateVersion: 1, envelopeId: null }
      : OWNER,
    actionId: "act-spawn-fixture",
    cityId: "cityA",
    cityIds: ["cityA"],
    classification: fire
      ? { delegationFire: true, delegationRuleId: "rule1", fireKind: "envelope" }
      : { verb: "envelope.spawn", scope: "city", ruleIds: ["envelope.spawn"], unruled: false },
    summaryText: fire ? "fixture fire entry" : "fixture spawn entry",
  });
  return buildLogEntry(draft, {
    seq,
    resolutionSeq: seq,
    resolutionId: "res-spawn-fixture",
    entryIndexWithinResolution: 1,
    resolvedAt: NOW,
    rulesVersion: "sim-rules-0.5.0-phase5",
    prevHash: "a".repeat(64),
    wakeActionId: null,
    executedDuringSeq: null,
  }) as unknown as Record<string, unknown>;
}

function terminalWorld(env: TaskEnvelopeRecord, opts: {
  npc?: Record<string, unknown>;
  root?: Record<string, unknown>;
  version?: Record<string, unknown>;
  fire?: boolean;
  sit?: SimSituation | null;
} = {}): Map<string, Record<string, unknown> | null> {
  const docs = baseDocs();
  docs.set("sim_npcs/npc1", npcDoc(opts.npc));
  docs.set("sim_mandates/mandate1", mandateRoot(opts.root));
  docs.set("sim_mandates/mandate1/versions/1", mandateVersion(opts.version));
  docs.set(`sim_task_envelopes/${env.taskId}`, env as unknown as Record<string, unknown>);
  docs.set(
    `sim_log_entries/${String(env.createdSeq).padStart(12, "0")}`,
    spawnEntryDoc(opts.fire ?? false, env.createdSeq)
  );
  if (opts.sit) putSituation(docs, opts.sit);
  return docs;
}

const DONE_OUTCOME = { outcome: "DONE" as const, outputText: "The digest is drafted.", summary: "Weekly digest drafted." };

check("W14 a DONE completion lands output + terminal patch + outcome entry as one bijection", () => {
  const env = runningEnvelope();
  const docs = terminalWorld(env);
  const snapshot = snapshotOf(docs);
  const plan = resolveEnvelopeTerminalStep(
    snapshot,
    { kind: "envelope-terminal", taskId: env.taskId, leaseId: LEASE, outcome: DONE_OUTCOME },
    { resolutionId: "wake_envterm_x" }
  );
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.deepEqual(plan.entries[0].recordsCreated, [`sim_task_outputs/${env.taskId}`]);
  assert.deepEqual(plan.entries[0].changes, []);
  const output = planWriteFor(plan, `sim_task_outputs/${env.taskId}`)?.afterDoc as unknown as {
    outcome: string; envelopeTaskId: string;
  };
  assert.equal(output.outcome, "DONE");
  assert.equal(output.envelopeTaskId, env.taskId);
  const after = planWriteFor(plan, `sim_task_envelopes/${env.taskId}`)?.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(after.status, "DONE");
  assert.equal(after.outputId, env.taskId);
  assert.equal(after.claim, null);
});

check("W15 the revalidation bite: a mandate revoked between queue and claim terminates authority_changed at claim", () => {
  const env = runningEnvelope();
  const docs = terminalWorld(env, { root: mandateRoot({ status: "revoked", revokedSeq: 35 }) });
  const snapshot = snapshotOf(docs);
  const plan = resolveEnvelopeTerminalStep(
    snapshot,
    { kind: "envelope-terminal", taskId: env.taskId, leaseId: LEASE, outcome: DONE_OUTCOME },
    { resolutionId: "wake_envterm_x" }
  );
  assertPlanValid(plan, snapshot);
  const after = planWriteFor(plan, `sim_task_envelopes/${env.taskId}`)?.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(after.status, "FAILED", "the worker's DONE never lands — revalidation governs");
  assert.equal(after.lastError?.code, "authority_changed");
  const output = planWriteFor(plan, `sim_task_outputs/${env.taskId}`)?.afterDoc as unknown as { outcome: string };
  assert.equal(output.outcome, "FAILED");
});

check("W16 E9 pair: rule-spawned dies on flip-to-silent; owner-direct survives it (the instruction is the permission)", () => {
  const silentNpc = { npc: npcDoc({ permissionMode: "silent" }) };
  const envRule = runningEnvelope();
  const docsRule = terminalWorld(envRule, { ...silentNpc, fire: true });
  const planRule = resolveEnvelopeTerminalStep(
    snapshotOf(docsRule),
    { kind: "envelope-terminal", taskId: envRule.taskId, leaseId: LEASE, outcome: DONE_OUTCOME },
    { resolutionId: "wake_envterm_x" }
  );
  const afterRule = planWriteFor(planRule, `sim_task_envelopes/${envRule.taskId}`)?.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(afterRule.status, "FAILED");
  assert.equal(afterRule.lastError?.code, "authority_changed");

  const envOwner = runningEnvelope();
  const docsOwner = terminalWorld(envOwner, { ...silentNpc, fire: false });
  const planOwner = resolveEnvelopeTerminalStep(
    snapshotOf(docsOwner),
    { kind: "envelope-terminal", taskId: envOwner.taskId, leaseId: LEASE, outcome: DONE_OUTCOME },
    { resolutionId: "wake_envterm_y" }
  );
  const afterOwner = planWriteFor(planOwner, `sim_task_envelopes/${envOwner.taskId}`)?.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(afterOwner.status, "DONE", "an owner-direct envelope survives a later flip to silent");
});

check("W17 a FAILED completion returns the delegated card to its owner in the same event", () => {
  const docs0 = baseDocs();
  standingNpc(docs0);
  const sit = makeSituation({ kind: "proposal" });
  const delegatedSit: SimSituation = {
    ...sit,
    status: "delegated",
    handling: {
      mode: "delegated", decidedByUid: "ownerA", delegationRuleId: null, delegationRuleVersion: null,
      npcId: "npc1", mandateId: "mandate1", mandateVersion: 1, taskId: null,
      actionId: null, decidedAt: new Date(NOW), decisionNote: null, outcomeVerb: null,
    },
  };
  const env = runningEnvelope({ threadRef: { kind: "situation", id: sit.situationId } });
  const withTask: SimSituation = {
    ...delegatedSit,
    handling: { ...(delegatedSit.handling as object), taskId: env.taskId } as SimSituation["handling"],
  };
  const docs = terminalWorld(env, { sit: withTask });
  const snapshot = snapshotOf(docs);
  const plan = resolveEnvelopeTerminalStep(
    snapshot,
    {
      kind: "envelope-terminal",
      taskId: env.taskId,
      leaseId: LEASE,
      outcome: { outcome: "FAILED", outputText: "The archive index is unreadable.", summary: "Task failed." },
    },
    { resolutionId: "wake_envterm_x" }
  );
  assertPlanValid(plan, snapshot);
  const afterSit = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.ok(afterSit, "the card's return rides the terminal plan");
  assert.equal(afterSit.status, "open");
  assert.equal(afterSit.delegationCycleCount, sit.delegationCycleCount + 1);
});

check("W18 budget-death terminates FAILED with NO output and raises the system Situation; attempts remaining refuses", () => {
  const env = runningEnvelope({ attempts: 3 });
  const docs = terminalWorld(env);
  const snapshot = snapshotOf(docs);
  const plan = resolveEnvelopeFailureStep(
    snapshot,
    { kind: "envelope-failure", taskId: env.taskId, leaseId: LEASE, error: { code: "worker_failed", message: "the worker crashed" } },
    { resolutionId: "wake_envfail_x" }
  );
  assertPlanValid(plan, snapshot);
  const after = planWriteFor(plan, `sim_task_envelopes/${env.taskId}`)?.afterDoc as unknown as TaskEnvelopeRecord;
  assert.equal(after.status, "FAILED");
  assert.equal(after.outputId, null, "no output exists — outputId must not fabricate the bijection");
  assert.equal(after.lastError?.code, "worker_failed");
  assert.equal(planWriteFor(plan, `sim_task_outputs/${env.taskId}`), undefined, "no output write");
  assert.equal(plan.entries[0].classification?.envelopeFailure, true);
  assert.equal(plan.entries[0].recordsCreated.length, 1, "the system Situation is created");
  // Attempts remaining: the step refuses (the executor requeues).
  const env2 = runningEnvelope({ attempts: 2 });
  const plan2 = resolveEnvelopeFailureStep(
    snapshotOf(terminalWorld(env2)),
    { kind: "envelope-failure", taskId: env2.taskId, leaseId: LEASE, error: { code: "worker_failed", message: "x" } },
    { resolutionId: "wake_envfail_y" }
  );
  assert.equal(plan2.entries.length, 0);
});

// ---------------------------------------------------------------------------
section("W19 — delegated-action follow-ups");

function followupWorld(actionStatus: string): { docs: Map<string, Record<string, unknown> | null>; sit: SimSituation } {
  const docs = baseDocs();
  standingNpc(docs);
  const sit = makeSituation({ kind: "proposal" });
  const actionId = delegatedActionId({ situationId: sit.situationId, via: "rule1", npcId: "npc1", cycleId: CYCLE });
  const delegated: SimSituation = {
    ...sit,
    status: "delegated",
    handling: {
      mode: "auto-delegated", decidedByUid: "ownerA", delegationRuleId: "rule1", delegationRuleVersion: 1,
      npcId: "npc1", mandateId: "mandate1", mandateVersion: 1, taskId: null,
      actionId, decidedAt: new Date(NOW), decisionNote: null, outcomeVerb: null,
    },
  };
  putSituation(docs, delegated);
  docs.set(`sim_actions/${actionId}`, {
    actionId,
    status: actionStatus,
    resolutionId: "res-action-1",
    lastLogSeq: 55,
    failure: actionStatus === "rejected" ? { code: "SOME_CODE", message: "refused on the merits" } : null,
  });
  return { docs, sit: delegated };
}

check("W19 a resolved delegated action marks its card handled at the action's seq; a rejected one returns it", () => {
  const { docs, sit } = followupWorld("resolved");
  const actionId = sit.handling?.actionId as string;
  const snapshot = snapshotOf(docs);
  const plan = resolveSituationFollowupStep(
    snapshot,
    { kind: "situation-followup", situationId: sit.situationId, actionId },
    { resolutionId: "wake_followup_x" }
  );
  assertPlanValid(plan, snapshot);
  const after = planWriteFor(plan, `sim_situations/${sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after.status, "handled");
  assert.equal(after.resolvedSeq, 55);
  assert.equal(after.resolvedByResolutionId, "res-action-1");

  const rejected = followupWorld("rejected");
  const plan2 = resolveSituationFollowupStep(
    snapshotOf(rejected.docs),
    { kind: "situation-followup", situationId: rejected.sit.situationId, actionId },
    { resolutionId: "wake_followup_y" }
  );
  const after2 = planWriteFor(plan2, `sim_situations/${rejected.sit.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(after2.status, "open");
  assert.equal(after2.delegationCycleCount, rejected.sit.delegationCycleCount + 1);
});

// ---------------------------------------------------------------------------
section("W20–W22 — F-E9 parity, WakeScanState, spawn-refusal fallback");

function runActionAt(
  docs: Map<string, Record<string, unknown> | null>,
  action: SimAction,
  nowIso: string
): ResolutionPlan {
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of collectActionReadPaths(action)) seedDocs.set(path, docs.get(path) ?? null);
  const readPlan = collectActionReadPlan(action, seedDocs);
  const snapshotDocs = new Map(seedDocs);
  for (const path of readPlan.paths) {
    if (!snapshotDocs.has(path)) snapshotDocs.set(path, docs.get(path) ?? null);
  }
  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of readPlan.queries) {
    const results: { path: string; doc: Record<string, unknown> }[] = [];
    for (const [path, doc] of docs) {
      if (!path.startsWith(`${spec.collectionPath}/`) || doc === null) continue;
      const matches = spec.filters.every((f) => doc[f.field] === f.value);
      if (matches) results.push({ path, doc });
    }
    for (const r of results) snapshotDocs.set(r.path, r.doc);
    queryRecords.push({
      spec,
      resultPaths: results.map((r) => r.path),
      digest: digestQueryResults(spec, results.map((r) => ({ path: r.path, hash: headHashOf(r.doc) }))),
    });
  }
  const snapshot = snapshotFromDocs(snapshotDocs, nowIso, queryRecords);
  return resolveAction(snapshot, action, { baselineRegistry: registry, mode: "commit" });
}

check("W20 F-E9: an owner-direct spawn without availableAt now previews and commits identically (parity)", () => {
  const docs = baseDocs();
  docs.set("sim_npcs/npc1", npcDoc({ currentMandateId: null, currentMandateVersion: null }));
  docs.set("characters/charA1", { factionId: "cityA", name: "Ada Archivist" });
  const { doc } = buildActionDoc({
    actorUid: "ownerA",
    clientRequestId: "req-spawn-1",
    actor: OWNER,
    actionType: "envelope.spawn",
    structuredAction: {
      npcId: "npc1",
      clientRequestId: "req-spawn-1",
      taskType: "one-off",
      task: "Draft the weekly digest.",
      bounds: { mayCommit: false },
    },
    targetCityIds: ["cityA"],
    now: NOW,
  });
  const action: SimAction = { ...doc, status: "confirmed" };
  const planA = runActionAt(docs, action, NOW);
  const planB = runActionAt(docs, action, NOW_LATER);
  assert.equal(planA.outcome, "resolved");
  assert.equal(planA.planHash, planB.planHash, "the plan is identical at both instants");
  const write = planA.writes.find((w) => w.path.startsWith("sim_task_envelopes/"));
  assert.equal(
    (write?.afterDoc as unknown as TaskEnvelopeRecord).availableAt,
    NOW,
    "the default is the action doc's stored createdAt, not the resolving instant"
  );
  // An explicit availableAt still wins over the default.
  const { doc: doc2 } = buildActionDoc({
    actorUid: "ownerA",
    clientRequestId: "req-spawn-2",
    actor: OWNER,
    actionType: "envelope.spawn",
    structuredAction: {
      npcId: "npc1",
      clientRequestId: "req-spawn-2",
      taskType: "one-off",
      task: "Draft the weekly digest.",
      bounds: { mayCommit: false },
      availableAt: "2026-12-01T00:00:00.000Z",
    },
    targetCityIds: ["cityA"],
    now: NOW,
  });
  const plan2 = runActionAt(docs, { ...doc2, status: "confirmed" }, NOW_LATER);
  const write2 = plan2.writes.find((w) => w.path.startsWith("sim_task_envelopes/"));
  assert.equal((write2?.afterDoc as unknown as TaskEnvelopeRecord).availableAt, "2026-12-01T00:00:00.000Z");
});

check("W21 WakeScanState: the candidate snapshot is wake-start-bound — mid-wake pendings wait", () => {
  const state = new WakeScanState();
  const wakeStartCandidates = [{ pendingId: "pend-old", status: "pending" }];
  state.candidates = wakeStartCandidates;
  // A pending created mid-wake (by a pass step's commit, say) is not
  // retroactively a candidate: the state hands back the SAME array.
  const midWakeCreated = { pendingId: "pend-new", status: "pending" };
  assert.equal(state.candidates, wakeStartCandidates);
  assert.ok(!state.candidates.some((c) => c.pendingId === midWakeCreated.pendingId));
});

check("W22 a fire whose spawn collides degrades to the blocked outcome — entry only, no transition, no envelope", () => {
  const docs = baseDocs();
  standingNpc(docs);
  const sit = makeSituation({ kind: "proposal", detail: { question: "Fund the archive?" } });
  putSituation(docs, sit);
  const step: WakePassStep = { kind: "delegation", situationId: sit.situationId };
  const resolutionId = wakeStepResolutionId(step, CYCLE);
  const taskId = envelopeTaskId("ownerA", resolutionId);
  docs.set(`sim_task_envelopes/${taskId}`, { taskId, status: "QUEUED" } as unknown as Record<string, unknown>);
  const snapshot = snapshotOf(docs);
  const { evaluation, plan } = evaluateDelegationStep(snapshot, sit.situationId, {
    resolutionId, cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(evaluation?.outcome, "fire", "evaluation still fires — the refusal is at composition");
  assertPlanValid(plan, snapshot);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.writes.length, 0, "no transition and no second envelope are written");
});

check("W23 every step kind's seed paths carry sim_counters/log — the snapshot-assembly contract (fix round 1)", () => {
  // assembleSnapshot (lib/sim/resolver.ts) refuses any doc map whose
  // sim_counters/log entry is absent or malformed: the counter is a
  // mandatory input of every snapshot, and the executor materializes
  // step snapshots from EXACTLY these seeds. A seed list without the
  // counter makes the first materialized step of a wake throw
  // LOG_NOT_INITIALIZED before any resolver runs (CI sim-core, CK7e).
  const steps: WakePassStep[] = [
    { kind: "delegation", situationId: "sit_x" },
    { kind: "trigger", situationId: "sit_x" },
    { kind: "silence", situationId: "sit_x", npcId: null, mandateId: null, mandateVersion: null },
    { kind: "attention", pendingId: "pend_x" },
    {
      kind: "envelope-terminal",
      taskId: "task_x",
      leaseId: "lease_x",
      outcome: { outcome: "DONE", outputText: "done", summary: "done" },
    },
    { kind: "envelope-failure", taskId: "task_x", leaseId: "lease_x", error: { code: "x", message: "x" } },
    { kind: "situation-followup", situationId: "sit_x", actionId: "act_x" },
  ];
  for (const step of steps) {
    const seeds = wakeStepSeedPaths(step);
    assert.ok(
      seeds.includes("sim_counters/log"),
      `${step.kind} seed paths must include sim_counters/log (got: ${seeds.join(", ")})`
    );
    assert.ok(
      !seeds.includes("sim_counters/head"),
      `${step.kind} seed paths name sim_counters/head, a doc that does not exist`
    );
  }
});

check("W24 the executor's delegated-action construction carries the §3.2 situation trigger — it resolves; the same action unstamped rejects NO_TRIGGER_ROOT; an uncited rule's fire cites the standing mandate (§7.1), and blocks when it is gone (round 7)", () => {
  // PR #45 CI round 6: executeDelegatedAction built the delegated
  // action with delegatedVia only — no trigger citation — so the
  // authority stage's check 5 refused every act-for-me fire
  // (NO_TRIGGER_ROOT) while the pure venues stayed green: their
  // fixtures hand-stamped the citation the engine was responsible
  // for. This check drives the REAL construction (the executor
  // persists buildDelegatedActionDoc's output verbatim) through the
  // real resolver, so the joint cannot silently unstamp again.
  const docs = baseDocs();
  standingNpc(docs, {
    version: {
      structuredScope: {
        triggerKinds: ["situation"],
        allowedActionTypes: ["fixture_adjust"],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
    },
  });
  docs.set("sim_cities/cityA", {
    cityId: "cityA",
    stats: { infrastructure: 50, treasuryRubars: 1_000_000 },
    stateVersion: 1,
  });
  const sit = makeSituation({
    kind: "proposal",
    detail: {
      delegatedAction: {
        actionType: "fixture_adjust",
        structuredAction: { cityId: "cityA", field: "stats.infrastructure", delta: 5 },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docs, sit);
  const npc = npcFromDoc(docs.get("sim_npcs/npc1") ?? null);
  assert.ok(npc, "the standing steward parses");
  const spec = readSituationActionSpec(sit);
  assert.ok(spec, "the card carries a readable delegated spec");
  const action = buildDelegatedActionDoc({
    situationId: sit.situationId,
    situationCreatedSeq: sit.createdSeq,
    ownerUid: "ownerA",
    npc,
    mandateId: "mandate1",
    mandateVersion: 1,
    spec,
    audienceCityId: "cityA",
    via: "rule1",
    cycleId: CYCLE,
    nowIso: NOW,
  });
  const trigger = (action.structuredAction as Record<string, unknown>).trigger as Record<string, unknown>;
  assert.equal(trigger?.kind, "situation");
  assert.equal(trigger?.sourceId, sit.situationId);
  assert.equal(trigger?.sourceSeq, sit.createdSeq, "rooted at the card's creating event, not the wake");
  const plan = runActionAt(docs, action, NOW);
  assert.equal(plan.outcome, "resolved");
  const summary = plan.entries[plan.entries.length - 1];
  const classification = summary?.classification as unknown as Record<string, unknown>;
  assert.deepEqual(classification?.trigger, {
    kind: "situation",
    sourceId: sit.situationId,
    sourceSeq: sit.createdSeq,
    deliberation: null,
  });
  assert.deepEqual(classification?.mandate, {
    mandateId: "mandate1",
    mandateVersion: 1,
    mode: "act-for-me",
  }, "the stage stamps its verified mandate citation beside the trigger");
  const cityWrite = plan.writes.find((w) => w.path === "sim_cities/cityA");
  assert.equal(
    ((cityWrite?.afterDoc as Record<string, unknown>)?.stats as Record<string, unknown>)?.infrastructure,
    55,
    "the delegated act lands"
  );
  // Falsifiability: the identical action with the citation stripped
  // — the executor's pre-fix shape — refuses at check 5.
  const unstamped: SimAction = {
    ...action,
    structuredAction: { ...(action.structuredAction as Record<string, unknown>) },
  };
  delete (unstamped.structuredAction as Record<string, unknown>).trigger;
  const plan2 = runActionAt(docs, unstamped, NOW);
  assert.equal(plan2.outcome, "rejected");
  assert.equal(plan2.rejection?.code, "NO_TRIGGER_ROOT");

  // Round 7 (the same joint, the fire's half): a rule whose handler
  // cites NO mandate fires under the handler NPC's STANDING mandate,
  // and the citation stands on the fire, the card's handling, and
  // the fire entry's actor — the three records the gate suite reads.
  // PR #45 CI round 7 convicted the pre-fix evaluator: it adopted
  // the authority view's resolved mandate only for cited rules, so
  // an uncited fire composed a ROOTLESS entry actor (mandateId and
  // envelopeId both null) — a §3.2 orphan the standing verifier
  // flags NPC_ACTOR_FORM. Every pure-venue fire fixture cited its
  // mandate (W1's ruleDoc, the situations harness's rule()); the
  // gate suite's rule-fire-1 was the first uncited fire exercised.
  const docsF = baseDocs();
  standingNpc(docsF, {
    rule: ruleDoc({ handler: { npcId: "npc1", mode: "act-for-me", mandateId: null } }),
  });
  const sitF = makeSituation({
    kind: "proposal",
    detail: {
      delegatedAction: {
        actionType: "advance_project",
        structuredAction: { projectId: "proj-1" },
        targetCityIds: ["cityA"],
      },
    },
  });
  putSituation(docsF, sitF);
  const snapshotF = snapshotOf(docsF);
  const stepF: WakePassStep = { kind: "delegation", situationId: sitF.situationId };
  const fired = evaluateDelegationStep(snapshotF, sitF.situationId, {
    resolutionId: wakeStepResolutionId(stepF, CYCLE), cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(fired.evaluation?.outcome, "fire");
  if (fired.evaluation?.outcome !== "fire") throw new Error("unreachable");
  assert.equal(fired.evaluation.fire.kind, "delegated-action");
  assert.equal(fired.evaluation.fire.mandateId, "mandate1", "the fire adopts the standing mandate the view resolved");
  assert.equal(fired.evaluation.fire.mandateVersion, 1);
  assertPlanValid(fired.plan, snapshotF);
  const fireEntry = fired.plan.entries.find(
    (e) => (e.classification as Record<string, unknown> | null)?.delegationFire === true
  );
  assert.ok(fireEntry, "the fire entry stands in the plan");
  assert.equal(fireEntry.actor.mandateId, "mandate1", "the fire entry's actor cites the standing mandate");
  assert.equal(fireEntry.actor.mandateVersion, 1);
  assert.equal(
    validateNpcActorForm(fireEntry.actor).ok,
    true,
    "the fire entry's actor passes the verifier's exactly-one-root form gate (§3.2)"
  );
  const afterF = planWriteFor(fired.plan, `sim_situations/${sitF.situationId}`)?.afterDoc as unknown as SimSituation;
  assert.equal(afterF?.handling?.mandateId, "mandate1", "the card's handling cites the standing mandate");
  assert.equal(afterF?.handling?.mandateVersion, 1);

  // Falsifiability: the same uncited rule with the standing mandate
  // revoked (the NPC holds none) blocks at evaluation — no fire, no
  // transition, no rootless entry (§7.2 handler-authority-changed).
  const docsB = baseDocs();
  standingNpc(docsB, {
    npc: { currentMandateId: null, currentMandateVersion: null },
    rule: ruleDoc({ handler: { npcId: "npc1", mode: "act-for-me", mandateId: null } }),
  });
  putSituation(docsB, sitF);
  const snapshotB = snapshotOf(docsB);
  const blockedFire = evaluateDelegationStep(snapshotB, sitF.situationId, {
    resolutionId: wakeStepResolutionId(stepF, CYCLE), cycleId: CYCLE, baselineRegistry: registry,
  });
  assert.equal(blockedFire.evaluation?.outcome, "blocked-handler-authority-changed");
  if (blockedFire.evaluation?.outcome === "blocked-handler-authority-changed") {
    assert.match(blockedFire.evaluation.reason, /no standing mandate/);
  }
  assert.equal(
    blockedFire.plan.entries.some(
      (e) => (e.classification as Record<string, unknown> | null)?.delegationFire === true
    ),
    false,
    "no fire entry is composed for the blocked rule"
  );
  assert.equal(planWriteFor(blockedFire.plan, `sim_situations/${sitF.situationId}`), undefined, "the card is not transitioned");
});

console.log(`\nwake-harness: ${checks} checks passed`);
