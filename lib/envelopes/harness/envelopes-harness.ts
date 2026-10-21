/**
 * Task envelopes — standalone node assertion harness.
 *
 * Run:  npx tsx lib/envelopes/harness/envelopes-harness.ts
 *
 * Cases:
 *
 *   E1  Builder never-bind: mayCommit:true throws; a built envelope is
 *       QUEUED, mayCommit false, with a deterministic task id
 *   E2  Negotiation envelope without bounds throws (§8.4 layer 1)
 *   E3  P5-K4 tasking: silent NPC is owner-taskable (advisory only);
 *       a delegation rule cannot task a silent NPC; retired NPCs
 *       cannot be tasked at all
 *   E4  Spawn fences: non-owner requester refused; rule spawn without
 *       a mandate refused; rule spawn exceeding the mandate refused;
 *       foreign state-change intent refused (canon fence); foreign
 *       collection intent is not alteration
 *   E5  Mandate labeling (§4.4): "within-mandate" only when a cited
 *       version's bounds cover the envelope
 *   E6  Claim/lease fencing: claim consumes an attempt; a live lease
 *       refuses a second claim; an expired lease reclaims; terminal
 *       envelopes refuse claims; stale fencing tokens and duplicate
 *       outputs fail terminal preconditions
 *   E7  Attempt budget: third failure is terminal FAILED + a system
 *       Situation signal
 *   E8  Output discipline: output id = task id, mayCommit forced
 *       false, tampered outputs fail validation; terminal records
 *       validate exactly-one-output
 *   E9  Execution-time revalidation (TC-N09): a mandate revoked
 *       between queue and run terminates authority_changed; an
 *       owner-direct envelope survives a later flip to silent
 *       (P5-K4) but a rule-spawned one does not
 *   E10 Outcome entry: one summary entry, envelope actor root,
 *       changes [] — the audit proof that output changed nothing
 *   E11 Context hash: stable for identical context, moves when the
 *       mandate version moves
 */

import assert from "node:assert/strict";
import { validateNpcActorForm, actorAuthorityRoot } from "../../authority/actor";
import { computeMandateHash } from "../../authority/mandate";
import type {
  AuthorityView,
  CityAuthorityContext,
  MandateScope,
  MandateVersionRecord,
  NpcRecord,
} from "../../authority/types";
import {
  EnvelopeValidationError,
  buildTaskEnvelope,
  envelopeMandateLabel,
  evaluateEnvelopeTasking,
  validateEnvelopeRecord,
  validateEnvelopeSpawn,
} from "../envelopes";
import {
  buildEnvelopeOutcomeEntryDraft,
  buildTaskOutput,
  claimEnvelope,
  envelopeContextHash,
  failureOutcome,
  leaseIsLive,
  revalidateEnvelopeAtExecution,
  terminalEnvelopePatch,
  validateTaskOutput,
  validateTerminalPreconditions,
} from "../lifecycle";
import type { EnvelopeSpawnInput, TaskEnvelopeRecord } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER = "uid-a";
const OTHER = "uid-b";

const CITIES = new Map<string, CityAuthorityContext>([
  ["cascadia", { cityId: "cascadia", ownerUids: [OWNER], isSharedCity: false, mayorUid: null, viceMayorUid: null }],
  ["evan-city", { cityId: "evan-city", ownerUids: [OTHER], isSharedCity: false, mayorUid: null, viceMayorUid: null }],
]);

function makeNpc(overrides?: Partial<NpcRecord>): NpcRecord {
  return {
    npcId: "npc-envoy",
    characterId: "char-envoy",
    cityId: "cascadia",
    ownerUid: OWNER,
    permissionMode: "act-for-me",
    status: "active",
    currentMandateId: "m-envoy",
    currentMandateVersion: 1,
    activationSeq: 5,
    retiredSeq: null,
    ...overrides,
  };
}

const BOUNDS = {
  subject: "trade-agreement",
  mayOffer: [{ kind: "rubars", maxAmount: 1000 }],
  mayAccept: [{ kind: "rubars", minAmount: 0, maxAmount: 2000 }],
  walkAwayIf: [],
  maxTurns: 4,
};

function makeMandateVersion(overrides?: Partial<MandateVersionRecord>): MandateVersionRecord {
  const scope: MandateScope = {
    allowedActionTypes: ["negotiation.propose"],
    namedRecordIds: [],
    counterpartyCityIds: ["evan-city"],
    perActionRubars: null,
    perPeriodRubars: null,
    perPeriodActions: null,
    periodDefinition: "per 100 seq",
    maxProjectPhase: null,
    triggerKinds: ["log-event"],
    negotiationBounds: BOUNDS,
    alwaysEscalate: [],
    allowPartialExecution: false,
  };
  const v: MandateVersionRecord = {
    mandateId: "m-envoy",
    version: 1,
    status: "active",
    mode: "act-for-me",
    scope,
    expiresAtSeq: null,
    horizonActions: null,
    effectiveSeq: 10,
    revokedSeq: null,
    mandateHash: "",
    createdByUid: OWNER,
    ...overrides,
  };
  v.mandateHash = computeMandateHash(v);
  return v;
}

function spawnInput(overrides?: Partial<EnvelopeSpawnInput>): EnvelopeSpawnInput {
  return {
    requestingMemberId: OWNER,
    npcId: "npc-envoy",
    cityId: "cascadia",
    threadRef: { kind: "deal-room", id: "thread-1" },
    taskType: "negotiation",
    task: "Work the trade terms with Evan City inside the bounds.",
    structuredIntent: null,
    bounds: { counterpartyCityIds: ["evan-city"], negotiationBounds: BOUNDS },
    spawnActionId: "act-spawn-1",
    clientRequestId: "req-1",
    availableAt: "2026-10-18T00:00:00.000Z",
    nowIso: "2026-10-18T00:00:00.000Z",
    createdSeq: 60,
    ...overrides,
  };
}

// E1 — builder never-bind + deterministic id.
{
  assert.throws(
    () => buildTaskEnvelope(spawnInput({ bounds: { mayCommit: true } })),
    EnvelopeValidationError
  );
  const env = buildTaskEnvelope(spawnInput());
  assert.equal(env.status, "QUEUED");
  assert.equal(env.bounds.mayCommit, false);
  assert.equal(env.outputId, null);
  const again = buildTaskEnvelope(spawnInput());
  assert.equal(again.taskId, env.taskId); // retried spawn re-derives the same envelope
  const other = buildTaskEnvelope(spawnInput({ clientRequestId: "req-2" }));
  assert.notEqual(other.taskId, env.taskId);
  assert.deepEqual(validateEnvelopeRecord(env), []);
  console.log("E1 ok — mayCommit:true throws at the builder; ids deterministic per requester+clientRequestId");
}

// E2 — negotiation without bounds throws.
{
  assert.throws(
    () => buildTaskEnvelope(spawnInput({ bounds: { negotiationBounds: null } })),
    /negotiationBounds/
  );
  console.log("E2 ok — a negotiation envelope without bounds is unbuildable");
}

// E3 — P5-K4 tasking.
{
  const silent = makeNpc({ permissionMode: "silent" });
  const direct = evaluateEnvelopeTasking(silent, "owner-direct");
  assert.equal(direct.taskable, true);
  assert.equal(direct.advisoryOnly, true);
  const ruled = evaluateEnvelopeTasking(silent, "delegation-rule");
  assert.equal(ruled.taskable, false);
  const active = evaluateEnvelopeTasking(makeNpc(), "delegation-rule");
  assert.equal(active.taskable, true);
  const retired = evaluateEnvelopeTasking(makeNpc({ status: "retired", retiredSeq: 70 }), "owner-direct");
  assert.equal(retired.taskable, false);
  console.log("E3 ok — silent NPC: owner-direct tasks (advisory), rules cannot; retired NPCs untaskable");
}

// E4 — spawn fences.
{
  const npc = makeNpc();
  const env = buildTaskEnvelope(spawnInput());
  assert.deepEqual(
    validateEnvelopeSpawn(npc, env, { source: "owner-direct", mandateVersion: null, cities: CITIES }),
    []
  );
  const foreignRequester = buildTaskEnvelope(spawnInput({ requestingMemberId: OTHER }));
  assert.ok(
    validateEnvelopeSpawn(npc, foreignRequester, { source: "owner-direct", mandateVersion: null, cities: CITIES })
      .some((v) => v.includes("not the NPC's owner"))
  );
  assert.ok(
    validateEnvelopeSpawn(npc, env, { source: "delegation-rule", mandateVersion: null, cities: CITIES })
      .some((v) => v.includes("mandate context"))
  );
  const fatBounds = { ...BOUNDS, mayOffer: [{ kind: "rubars", maxAmount: 999999 }] };
  const fat = buildTaskEnvelope(spawnInput({ bounds: { counterpartyCityIds: ["evan-city"], negotiationBounds: fatBounds } }));
  assert.ok(
    validateEnvelopeSpawn(npc, fat, { source: "delegation-rule", mandateVersion: makeMandateVersion(), cities: CITIES })
      .some((v) => v.includes("exceeds the mandate"))
  );
  const canonAttack = buildTaskEnvelope(
    spawnInput({
      taskType: "errand",
      bounds: {},
      structuredIntent: { effectClass: "state-change", targetCityIds: ["evan-city"] },
    })
  );
  assert.ok(
    validateEnvelopeSpawn(npc, canonAttack, { source: "owner-direct", mandateVersion: null, cities: CITIES })
      .some((v) => v.includes("sovereign canon"))
  );
  const collection = buildTaskEnvelope(
    spawnInput({
      taskType: "collection",
      bounds: {},
      structuredIntent: { effectClass: "read-collection", targetCityIds: ["evan-city"] },
    })
  );
  assert.deepEqual(
    validateEnvelopeSpawn(npc, collection, { source: "owner-direct", mandateVersion: null, cities: CITIES }),
    []
  );
  console.log("E4 ok — owner-only tasking, rule spawns bounded by their mandate, canon fence refuses foreign state change");
}

// E5 — mandate labeling.
{
  const env = buildTaskEnvelope(spawnInput());
  assert.equal(envelopeMandateLabel(env, makeMandateVersion()), "within-mandate");
  assert.equal(envelopeMandateLabel(env, null), "owner-one-off");
  const fatBounds = { ...BOUNDS, maxTurns: 40 };
  const fat = buildTaskEnvelope(spawnInput({ bounds: { counterpartyCityIds: ["evan-city"], negotiationBounds: fatBounds } }));
  assert.equal(envelopeMandateLabel(fat, makeMandateVersion()), "owner-one-off");
  console.log("E5 ok — \"within-mandate\" is earned by coverage, never claimed");
}

// E6 — claim/lease fencing.
{
  const env = buildTaskEnvelope(spawnInput());
  const claim1 = claimEnvelope(env, {
    cycleId: "wake-1", leaseId: "lease-1",
    nowIso: "2026-10-18T01:00:00.000Z", leaseExpiresAt: "2026-10-18T01:10:00.000Z",
  });
  assert.equal(claim1.ok, true);
  if (!claim1.ok) throw new Error("unreachable");
  assert.equal(claim1.envelope.status, "RUNNING");
  assert.equal(claim1.envelope.attempts, 1);
  assert.equal(leaseIsLive(claim1.envelope, "2026-10-18T01:05:00.000Z"), true);

  const claim2 = claimEnvelope(claim1.envelope, {
    cycleId: "wake-2", leaseId: "lease-2",
    nowIso: "2026-10-18T01:05:00.000Z", leaseExpiresAt: "2026-10-18T01:20:00.000Z",
  });
  assert.equal(claim2.ok, false); // live lease fences

  const claim3 = claimEnvelope(claim1.envelope, {
    cycleId: "wake-3", leaseId: "lease-3",
    nowIso: "2026-10-18T01:15:00.000Z", leaseExpiresAt: "2026-10-18T01:25:00.000Z",
  });
  assert.equal(claim3.ok, true); // lease expired at 01:10 — reclaimable
  if (!claim3.ok) throw new Error("unreachable");
  assert.equal(claim3.envelope.attempts, 2);
  assert.equal(claim3.envelope.claim?.leaseId, "lease-3");

  // Terminal preconditions: the stale worker (lease-1) cannot complete.
  assert.ok(
    validateTerminalPreconditions(claim3.envelope, { leaseId: "lease-1", outputExists: false })
      .some((v) => v.includes("stale fencing token"))
  );
  assert.ok(
    validateTerminalPreconditions(claim3.envelope, { leaseId: "lease-3", outputExists: true })
      .some((v) => v.includes("exactly one output"))
  );
  assert.deepEqual(
    validateTerminalPreconditions(claim3.envelope, { leaseId: "lease-3", outputExists: false }),
    []
  );
  console.log("E6 ok — leases fence, expiry reclaims, stale tokens and duplicate outputs are refused");
}

// E7 — attempt budget.
{
  const base = buildTaskEnvelope(spawnInput());
  assert.deepEqual(failureOutcome({ ...base, attempts: 1 }), { nextStatus: "QUEUED", raiseSystemSituation: false });
  assert.deepEqual(failureOutcome({ ...base, attempts: 3 }), { nextStatus: "FAILED", raiseSystemSituation: true });
  console.log("E7 ok — third failure is terminal FAILED with a system Situation signal");
}

// E8 — output discipline + terminal record validity.
{
  const env = buildTaskEnvelope(spawnInput());
  const running = claimEnvelope(env, {
    cycleId: "wake-1", leaseId: "lease-1",
    nowIso: "2026-10-18T01:00:00.000Z", leaseExpiresAt: "2026-10-18T01:10:00.000Z",
  });
  assert.equal(running.ok, true);
  if (!running.ok) throw new Error("unreachable");
  const output = buildTaskOutput(running.envelope, {
    outcome: "DONE",
    outputText: "Proposed terms attached; nothing signed.",
    summary: "Terms proposed within bounds.",
    proposedTerms: [{ kind: "rubars", side: "offer", amountRubars: 500 }],
  });
  assert.equal(output.outputId, env.taskId);
  assert.equal(output.structuredOutput.mayCommit, false);
  assert.deepEqual(validateTaskOutput(output), []);
  const tampered = { ...output, structuredOutput: { ...output.structuredOutput, mayCommit: true as never } };
  assert.ok(validateTaskOutput(tampered).some((v) => v.includes("never-bind")));

  const terminal: TaskEnvelopeRecord = {
    ...running.envelope,
    ...terminalEnvelopePatch(running.envelope, { outcome: "DONE", nowIso: "2026-10-18T01:06:00.000Z" }),
  };
  assert.deepEqual(validateEnvelopeRecord(terminal), []);
  assert.equal(claimEnvelope(terminal, {
    cycleId: "wake-9", leaseId: "lease-9",
    nowIso: "2026-10-18T02:00:00.000Z", leaseExpiresAt: "2026-10-18T02:10:00.000Z",
  }).ok, false); // terminal is final
  console.log("E8 ok — outputs are id-bound and commit-free; terminal records are exactly-one and final");
}

// E9 — execution-time revalidation.
{
  const npc = makeNpc();
  const env = buildTaskEnvelope(spawnInput());
  const healthyView: AuthorityView = {
    npc,
    mandateRoot: { mandateId: "m-envoy", npcId: "npc-envoy", cityId: "cascadia", ownerUid: OWNER, currentVersion: 1 },
    mandateVersion: makeMandateVersion(),
    cities: CITIES,
    periodUsage: { delegatedResolutions: 0, delegatedRubars: 0 },
    ruleMode: null,
    atSeq: 80,
  };
  assert.equal(revalidateEnvelopeAtExecution(healthyView, env, "owner-direct").ok, true);

  const revokedView: AuthorityView = {
    ...healthyView,
    mandateVersion: makeMandateVersion({ status: "revoked", revokedSeq: 75 }),
  };
  const dead = revalidateEnvelopeAtExecution(revokedView, env, "owner-direct");
  assert.equal(dead.ok, false);
  if (!dead.ok) assert.equal(dead.code, "authority_changed");

  // Mode flipped to silent after queueing: owner-direct survives (the
  // instruction was the permission); a rule spawn does not.
  const silentView: AuthorityView = { ...healthyView, npc: makeNpc({ permissionMode: "silent" }) };
  assert.equal(revalidateEnvelopeAtExecution(silentView, env, "owner-direct").ok, true);
  assert.equal(revalidateEnvelopeAtExecution(silentView, env, "delegation-rule").ok, false);
  console.log("E9 ok — mid-flight revocation terminates authority_changed; P5-K4 reconciles the silent flip");
}

// E10 — outcome entry is advisory in the Log itself.
{
  const npc = makeNpc();
  const env = buildTaskEnvelope(spawnInput());
  const output = buildTaskOutput(env, {
    outcome: "NEED-INFO",
    outputText: "Need the owner's call on the exclusivity clause.",
    summary: "One question for the owner.",
    questions: ["Accept exclusivity for one season?"],
  });
  const entry = buildEnvelopeOutcomeEntryDraft(env, output, npc);
  assert.equal(entry.kind, "action-summary");
  assert.deepEqual(entry.changes, []);
  assert.equal(validateNpcActorForm(entry.actor).ok, true);
  const root = actorAuthorityRoot(entry.actor);
  assert.equal(root?.kind, "envelope");
  assert.equal((entry.classification as { source?: string }).source, "envelope");
  assert.ok(entry.recordsCreated.includes(`sim_task_outputs/${env.taskId}`));
  console.log("E10 ok — outcome entry: envelope root, source \"envelope\", changes []");
}

// E11 — context hash binding.
{
  const env = buildTaskEnvelope(spawnInput());
  const h1 = envelopeContextHash(env, 1, ["head-a", "head-b"]);
  assert.equal(h1, envelopeContextHash(env, 1, ["head-a", "head-b"]));
  assert.notEqual(h1, envelopeContextHash(env, 2, ["head-a", "head-b"]));
  assert.notEqual(h1, envelopeContextHash(env, 1, ["head-a", "head-c"]));
  console.log("E11 ok — context hash binds envelope + mandate version + input heads");
}

console.log("\nEnvelopes harness: all cases passed.");
