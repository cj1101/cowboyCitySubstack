/**
 * Phase 5 substrate (PR-1) — governance registration harness.
 *
 * Pure (no emulator): drives the REAL resolver (resolveAction, which
 * runs validatePlan incl. the F-02 reconciliation) against the landed
 * registry and asserts the substrate contract:
 *
 *   G1  Registration totality — the twelve brief §3.3 governance kinds
 *       classify to the five governance descriptors; the registry
 *       holds 70 descriptors; every registered kind has a handler.
 *   G2  npc.create is live — the lib/npcs adapter writes the record in
 *       pending_activation, the P5-K3 default (ask-first) comes from
 *       the builder, the plan is clock-free (timestamps nulled for the
 *       committer; identical planHash across instants).
 *   G3  npc.create refusals — non-owner (AUTHORITY_REVOKED), dangling
 *       character link (NO_CHARACTER), duplicate record
 *       (NPC_ALREADY_EXISTS), numeric personality (the module's
 *       NUMERIC_PERSONALITY code, passed through), NPC actor
 *       (ACTOR_NOT_MEMBER: governance is an owner act).
 *   G4  The eleven deferred kinds resolve narrative-only with the
 *       deferral stated in the entry (R-29 idiom) and zero writes.
 *   G5  P5-K13 canonical half — buildLogEntry stores characterId only
 *       when it carries a value (absent ≡ null): a null-key actor
 *       stores byte-identically to a no-key actor and hashes the same;
 *       an in-character actor stores the ID, stays type "member", and
 *       its hash verifies under computeEntryHash.
 *
 * Run: npx tsx tests/governance-harness.ts
 */

import assert from "node:assert/strict";
import {
  collectActionReadPaths,
  collectActionReadPlan,
  resolveAction,
  snapshotFromDocs,
} from "../lib/sim/resolver";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildActionDoc } from "../lib/sim/intake";
import { buildLogEntry, computeEntryHash, entryActorForm } from "../lib/sim/log";
import { summaryDraft } from "../lib/sim/rules/planHelpers";
import {
  ACTION_KIND_INDEX,
  RULE_DESCRIPTORS,
  descriptorForActionKind,
} from "../lib/sim/rules/registry";
import { GOVERNANCE_DESCRIPTORS } from "../lib/sim/rules/governance";
import {
  memberActor,
  memberInCharacterActor,
  npcActorStanding,
} from "../lib/npcs";
import type { ResolutionPlan, SimAction, SimActor } from "../lib/sim/state";

const fixtureRegistry = buildFixtureBaselineRegistry();
const NOW_A = "2026-10-20T12:00:00.000Z";
const NOW_B = "2026-10-21T09:30:00.000Z";

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(3, " ")} — ${label}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// Fixture world: cityA owned by ownerA; one standing character.
// ---------------------------------------------------------------------------

function worldDocs(): Map<string, Record<string, unknown> | null> {
  const docs = new Map<string, Record<string, unknown> | null>();
  docs.set("sim_world/current", { schemaVersion: 2 });
  docs.set("sim_counters/log", { lastSeq: 0, lastEntryHash: "genesis" });
  docs.set("factions/cityA", { name: "Fixture City A", ownerUids: ["ownerA"] });
  docs.set("factions/cityB", { name: "Fixture City B", ownerUids: ["ownerB"] });
  docs.set("characters/charA1", { factionId: "cityA", name: "Ada Archivist" });
  docs.set("characters/charB1", { factionId: "cityB", name: "Bo Broker" });
  return docs;
}

function memberAction(
  actor: SimActor,
  actorUid: string,
  actionType: string,
  structuredAction: Record<string, unknown>,
  requestId: string
): SimAction {
  const { doc } = buildActionDoc({
    actorUid,
    clientRequestId: requestId,
    actor,
    actionType,
    structuredAction,
    targetCityIds: ["cityA"],
    now: NOW_A,
  });
  return { ...doc, status: "confirmed" };
}

function runAction(
  docs: Map<string, Record<string, unknown> | null>,
  action: SimAction,
  nowIso: string
): ResolutionPlan {
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of collectActionReadPaths(action)) {
    seedDocs.set(path, docs.get(path) ?? null);
  }
  const readPlan = collectActionReadPlan(action, seedDocs);
  const snapshotDocs = new Map(seedDocs);
  for (const path of readPlan.paths) {
    if (!snapshotDocs.has(path)) snapshotDocs.set(path, docs.get(path) ?? null);
  }
  assert.equal(readPlan.queries.length, 0, "governance descriptors declare no collection queries");
  const snapshot = snapshotFromDocs(snapshotDocs, nowIso);
  return resolveAction(snapshot, action, { baselineRegistry: fixtureRegistry, mode: "commit" });
}

const OWNER: SimActor = {
  type: "member",
  memberId: "ownerA",
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
};

const CREATE_INPUT = {
  characterId: "charA1",
  cityId: "cityA",
  displayNameSnapshot: "Ada Archivist",
  titleFreeform: "Chief Archivist & Keeper of the Rolls",
  roleTemplate: "steward",
  personality: { traits: ["meticulous"], voiceNotes: null, characterNotes: null },
  scopeFreeform: "Keep the city rolls; draft the weekly digest.",
};

// ---------------------------------------------------------------------------
section("G1 — registration totality (brief §3.3, P5-K6)");
check("the twelve governance kinds classify to the five descriptors", () => {
  const expected: Record<string, string> = {
    "npc.create": "npc.create",
    "npc.edit": "npc.create",
    "npc.retire": "npc.create",
    "npc.setMode": "npc.create",
    "mandate.set": "mandate.set",
    "mandate.revoke": "mandate.set",
    "delegationRule.set": "delegationRule.set",
    "situation.handle": "situation.handle",
    "situation.delegate": "situation.handle",
    "situation.silence": "situation.handle",
    "envelope.spawn": "envelope.spawn",
    "envelope.cancel": "envelope.spawn",
  };
  for (const [kind, descriptorId] of Object.entries(expected)) {
    assert.equal(ACTION_KIND_INDEX[kind], descriptorId, `${kind} index`);
    assert.equal(descriptorForActionKind(kind)?.id, descriptorId, `${kind} descriptor`);
  }
  assert.equal(Object.keys(GOVERNANCE_DESCRIPTORS).length, 5);
  assert.equal(Object.keys(RULE_DESCRIPTORS).length, 70, "65 landed + 5 governance");
});

check("every registered governance kind has a handler", () => {
  for (const descriptor of Object.values(GOVERNANCE_DESCRIPTORS)) {
    for (const kind of descriptor.actionKinds) {
      assert.equal(typeof descriptor.handlers[kind], "function", `${kind} handler`);
    }
    assert.equal(descriptor.visibility, "public");
    assert.equal(descriptor.mayCreatePendings, false);
  }
});

// ---------------------------------------------------------------------------
section("G2 — npc.create is live (adapter over lib/npcs)");
check("create resolves: pending record, ask-first default, clock-free plan", () => {
  const action = memberAction(OWNER, "ownerA", "npc.create", CREATE_INPUT, "req-create-1");
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.descriptorId, "npc.create");
  assert.equal(plan.writes.length, 1);
  const write = plan.writes[0];
  assert.equal(write.path, "sim_npcs/charA1");
  assert.equal(write.op, "create");
  assert.equal(write.recordClass, "state");
  const doc = write.afterDoc as Record<string, unknown>;
  assert.equal(doc.status, "pending_activation");
  assert.equal(doc.permissionMode, "ask-first", "P5-K3 default from the builder (A-4)");
  assert.equal(doc.characterId, "charA1", "P5-K13 item 1: the NPC->character link");
  assert.equal(doc.ownerUid, "ownerA");
  assert.equal(doc.createdAt, null, "clock-free: the committer stamps createdAt");
  assert.equal(doc.updatedAt, null, "clock-free: the committer stamps updatedAt");
  assert.equal(plan.entries.length, 1);
  const summary = plan.entries[0];
  assert.equal(summary.summary, true);
  assert.deepEqual(summary.ruleIds, ["npc.create"]);
  assert.deepEqual(summary.recordsCreated, ["sim_npcs/charA1"]);
  assert.deepEqual(summary.changes, [], "creation claimed by recordsCreated (F-02 grammar)");
  assert.ok(plan.planHash.length > 0, "finalizePlan filled the hash");
  // Clock-freedom: a different wake instant yields the identical plan.
  const again = runAction(worldDocs(), action, NOW_B);
  assert.equal(again.planHash, plan.planHash, "planHash is instant-independent");
});

check("an explicit mode is honored; the default applies only when omitted", () => {
  const action = memberAction(
    OWNER,
    "ownerA",
    "npc.create",
    { ...CREATE_INPUT, permissionMode: "silent" },
    "req-create-2"
  );
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal((plan.writes[0].afterDoc as Record<string, unknown>).permissionMode, "silent");
});

check("a minted character ID creates the record under that ID", () => {
  const action = memberAction(
    OWNER,
    "ownerA",
    "npc.create",
    { ...CREATE_INPUT, characterId: null, mintedCharacterId: "charNew" },
    "req-create-3"
  );
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes[0].path, "sim_npcs/charNew");
  assert.equal((plan.writes[0].afterDoc as Record<string, unknown>).characterId, "charNew");
});

// ---------------------------------------------------------------------------
section("G3 — npc.create refusals");
check("a non-owner is refused AUTHORITY_REVOKED", () => {
  const stranger: SimActor = { ...OWNER, memberId: "memberC" };
  const action = memberAction(stranger, "memberC", "npc.create", CREATE_INPUT, "req-create-4");
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "AUTHORITY_REVOKED");
  assert.equal(plan.writes.length, 0);
});

check("a dangling character link is refused NO_CHARACTER", () => {
  const action = memberAction(
    OWNER,
    "ownerA",
    "npc.create",
    { ...CREATE_INPUT, characterId: "charGhost" },
    "req-create-5"
  );
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "NO_CHARACTER");
});

check("an existing record is refused NPC_ALREADY_EXISTS (no overwrite)", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", { npcId: "charA1", status: "active" });
  const action = memberAction(OWNER, "ownerA", "npc.create", CREATE_INPUT, "req-create-6");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "NPC_ALREADY_EXISTS");
});

check("a numeric personality is refused with the module's own code", () => {
  const action = memberAction(
    OWNER,
    "ownerA",
    "npc.create",
    {
      ...CREATE_INPUT,
      personality: { traits: ["calm"], voiceNotes: null, characterNotes: null, patience: 7 },
    },
    "req-create-7"
  );
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "NUMERIC_PERSONALITY");
});

check("an NPC actor cannot perform governance (ACTOR_NOT_MEMBER)", () => {
  const npc = npcActorStanding({
    npcId: "charA1",
    ownerUid: "ownerA",
    mandateId: "mandate-1",
    mandateVersion: 1,
  });
  const action = memberAction(npc as SimActor, "ownerA", "npc.create", CREATE_INPUT, "req-create-8");
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "ACTOR_NOT_MEMBER");
});

// ---------------------------------------------------------------------------
section("G4 — the eleven deferrals state themselves (R-29 idiom)");
check("each deferred kind resolves narrative-only, zero writes, deferral named", () => {
  const deferred: Record<string, string> = {
    "npc.edit": "phase-5-engine-core",
    "npc.retire": "phase-5-engine-core",
    "npc.setMode": "phase-5-engine-core",
    "mandate.set": "phase-5-engine-core",
    "mandate.revoke": "phase-5-engine-core",
    "delegationRule.set": "phase-5-engine-core",
    "situation.handle": "phase-5-situations",
    "situation.delegate": "phase-5-situations",
    "situation.silence": "phase-5-situations",
    "envelope.spawn": "phase-5-engine-core",
    "envelope.cancel": "phase-5-engine-core",
  };
  for (const [kind, step] of Object.entries(deferred)) {
    const action = memberAction(OWNER, "ownerA", kind, { cityId: "cityA" }, `req-defer-${kind}`);
    const plan = runAction(worldDocs(), action, NOW_A);
    assert.equal(plan.outcome, "resolved", kind);
    assert.equal(plan.writes.length, 0, kind);
    assert.equal(plan.entries.length, 1, kind);
    const entry = plan.entries[0];
    const classification = entry.classification as Record<string, unknown>;
    assert.equal(classification.narrativeOnly, true, kind);
    assert.equal(classification.deferral, step, kind);
    assert.equal(classification.unruled, false, `${kind} is ruled — registered, deferred`);
    assert.ok(entry.summaryText.includes("REGISTERED"), `${kind} states the deferral`);
    assert.ok(entry.summaryText.includes("never silently"), `${kind} names the discipline`);
  }
});

// ---------------------------------------------------------------------------
section("G5 — P5-K13 canonical half (absent ≡ null)");
const ALLOC = {
  seq: 7,
  resolutionSeq: 7,
  resolutionId: "res_fixture",
  entryIndexWithinResolution: 0,
  resolvedAt: NOW_A,
  rulesVersion: "sim-rules-0.5.0-phase5",
  prevHash: "a".repeat(64),
  wakeActionId: null,
  executedDuringSeq: null,
};

function entryFor(actor: SimActor): Record<string, unknown> {
  const draft = summaryDraft({
    actor,
    actionId: "act_fixture",
    cityId: "cityA",
    cityIds: ["cityA"],
    summaryText: "fixture entry",
  });
  return buildLogEntry(draft, ALLOC);
}

check("a no-key member actor stores byte-identically and hash-verifies", () => {
  const entry = entryFor(memberActor("ownerA"));
  assert.deepEqual(entry.actor, memberActor("ownerA"));
  assert.equal(computeEntryHash(entry), entry.entryHash);
});

check("a null characterId stores identically to no key (same hash)", () => {
  const withNull = entryFor({ ...memberActor("ownerA"), characterId: null });
  const without = entryFor(memberActor("ownerA"));
  assert.ok(!("characterId" in (withNull.actor as Record<string, unknown>)));
  assert.deepEqual(withNull.actor, without.actor);
  assert.equal(withNull.entryHash, without.entryHash);
});

check("an in-character actor stores the ID, stays a member, hash verifies", () => {
  const actor = memberInCharacterActor("ownerA", "charA1");
  assert.equal(actor.type, "member", "no character actor type, ever (P5-K13)");
  const entry = entryFor(actor as SimActor);
  const stored = entry.actor as Record<string, unknown>;
  assert.equal(stored.characterId, "charA1");
  assert.equal(stored.type, "member");
  assert.equal(computeEntryHash(entry), entry.entryHash);
  const plain = entryFor(memberActor("ownerA"));
  assert.notEqual(entry.entryHash, plain.entryHash, "the persona is part of the act");
});

check("entryActorForm passes value-carrying and keyless actors through untouched", () => {
  const keyless = memberActor("ownerA");
  assert.equal(entryActorForm(keyless), keyless);
  const carrying = memberInCharacterActor("ownerA", "charA1") as SimActor;
  assert.equal(entryActorForm(carrying), carrying);
});

console.log(`\ngovernance harness: ${checks} checks passed`);
