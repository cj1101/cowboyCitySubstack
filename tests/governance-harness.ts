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
  digestQueryResults,
  resolveAction,
  snapshotFromDocs,
} from "../lib/sim/resolver";
// (stage query ids are materialized generically by runAction)
import type { SnapshotQueryRecord } from "../lib/sim/state";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildActionDoc } from "../lib/sim/intake";
import { buildLogEntry, computeEntryHash, entryActorForm, headHashOf } from "../lib/sim/log";
import { summaryDraft } from "../lib/sim/rules/planHelpers";
import {
  ACTION_KIND_INDEX,
  RULE_DESCRIPTORS,
  descriptorForActionKind,
} from "../lib/sim/rules/registry";
import { GOVERNANCE_DESCRIPTORS } from "../lib/sim/rules/governance";
import {
  DEFAULT_PERMISSION_MODE,
  buildMandateVersion,
  memberActor,
  memberInCharacterActor,
  npcActorStanding,
} from "../lib/npcs";
import { buildTaskOutput, envelopeTaskId } from "../lib/envelopes";
import { computeDelegationRuleHash } from "../lib/sim/rules/governance";
import { verifyStandingLog } from "../lib/sim/verify";
import { ruleEffectDraft } from "../lib/sim/rules/planHelpers";
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
  // Governance DESCRIPTORS declare no collection queries; the only
  // query a governance-adjacent resolution may carry is the authority
  // stage's period-usage Log query (PR-2), present only for npc actors
  // citing a mandate. Materialize it from the fixture docs (equality
  // filters over sim_log_entries) exactly as the dispatcher would.
  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of readPlan.queries) {
    // Any descriptor may declare queries (the Tier B stage test's
    // R-11 lore descriptor does); the harness materializes them all
    // generically from the fixture docs. (PR-1's assertion that
    // governance descriptors declare none was superseded by PR-2's
    // roster + period queries.)
    void spec;
    const results: { path: string; doc: Record<string, unknown> }[] = [];
    for (const [path, doc] of docs) {
      if (!path.startsWith(`${spec.collectionPath}/`) || doc === null) continue;
      const matches = spec.filters.every((f) => {
        const fieldValue = f.field
          .split(".")
          .reduce<unknown>((acc, part) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), doc);
        return fieldValue === f.value;
      });
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
section("G2 — npc.create is live (PR-2: activation composition)");
check("create resolves: ACTIVE record + roster write, ask-first default, clock-free plan", () => {
  const action = memberAction(OWNER, "ownerA", "npc.create", CREATE_INPUT, "req-create-1");
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.descriptorId, "npc.create");
  // PR-2 CHANGE (named in the prep report): PR-1's G2 asserted the
  // substrate's pending_activation write. The engine core composes
  // create + activation into ONE resolution (brief §1.2), so the net
  // write is the ACTIVE record plus the derived team roster.
  assert.equal(plan.writes.length, 2);
  const write = plan.writes.find((w) => w.path === "sim_npcs/charA1");
  assert.ok(write);
  assert.equal(write.op, "create");
  assert.equal(write.recordClass, "state");
  const doc = write.afterDoc as Record<string, unknown>;
  assert.equal(doc.status, "active", "same-resolution activation composition");
  assert.equal(doc.activationSeq, 1, "summarySeq = lastSeq(0) + entries(1)");
  assert.equal(doc.permissionMode, "ask-first", "P5-K3 default from the builder (A-4)");
  assert.equal(doc.characterId, "charA1", "P5-K13 item 1: the NPC->character link");
  assert.equal(doc.ownerUid, "ownerA");
  assert.equal(doc.createdAt, null, "clock-free: the committer stamps createdAt");
  assert.equal(doc.updatedAt, null, "clock-free: the committer stamps updatedAt");
  const team = plan.writes.find((w) => w.path === "sim_teams/cityA");
  assert.ok(team, "the roster write rides the same resolution");
  assert.deepEqual((team.afterDoc as Record<string, unknown>).npcIds, ["charA1"]);
  assert.equal(plan.entries.length, 1);
  const summary = plan.entries[0];
  assert.equal(summary.summary, true);
  assert.deepEqual(summary.ruleIds, ["npc.create"]);
  assert.deepEqual(summary.recordsCreated, ["sim_npcs/charA1", "sim_teams/cityA"]);
  assert.deepEqual(summary.changes, [], "creation claimed by recordsCreated (F-02 grammar)");
  assert.ok(summary.summaryText.includes("created and activated"), "one summary: created and activated");
  assert.ok(plan.planHash.length > 0, "finalizePlan filled the hash");
  // Clock-freedom: a different wake instant yields the identical plan.
  const again = runAction(worldDocs(), action, NOW_B);
  assert.equal(again.planHash, plan.planHash, "planHash is instant-independent");
});

check("a stored pending_activation record owned by the actor is activated, not refused", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", {
    npcId: "charA1", characterId: "charA1", cityId: "cityA", ownerUid: "ownerA",
    displayNameSnapshot: "Ada Archivist", titleFreeform: "Chief Archivist",
    roleTemplate: "steward",
    personality: { traits: ["meticulous"], voiceNotes: null, characterNotes: null },
    scopeFreeform: "Keep the rolls.", permissionMode: "ask-first",
    status: "pending_activation", currentMandateId: null, currentMandateVersion: null,
    activationSeq: null, retiredSeq: null, stateVersion: 1, createdAt: null, updatedAt: null,
  });
  const action = memberAction(OWNER, "ownerA", "npc.create", CREATE_INPUT, "req-create-pending");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const write = plan.writes.find((w) => w.path === "sim_npcs/charA1");
  assert.equal(write?.op, "update");
  assert.equal((write?.afterDoc as Record<string, unknown>).status, "active");
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

check("an NPC actor cannot perform governance (stage refuses first, PR-2)", () => {
  const npc = npcActorStanding({
    npcId: "charA1",
    ownerUid: "ownerA",
    mandateId: "mandate-1",
    mandateVersion: 1,
  });
  const action = memberAction(npc as SimActor, "ownerA", "npc.create", CREATE_INPUT, "req-create-8");
  const plan = runAction(worldDocs(), action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  // PR-2: the authority stage runs before descriptor dispatch for EVERY
  // npc-actor action, so this fixture (no standing NPC record) is
  // refused by the stage with NPC_NOT_FOUND. The handler's own
  // ACTOR_NOT_MEMBER gate still stands behind the stage for an NPC
  // whose mandate passes.
  assert.equal(plan.rejection?.code, "NPC_NOT_FOUND");
});

// ---------------------------------------------------------------------------
section("G4 — the remaining deferrals state themselves (R-29 idiom)");
check("each deferred kind resolves narrative-only, zero writes, deferral named", () => {
  // PR-2: the eight engine-core kinds are LIVE (sections G7–G9); only
  // the situation.* kinds still defer, naming PR-3.
  const deferred: Record<string, string> = {
    "situation.handle": "phase-5-situations",
    "situation.delegate": "phase-5-situations",
    "situation.silence": "phase-5-situations",
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

// ---------------------------------------------------------------------------
// PR-2 fixtures: an active NPC + standing mandate world.
// ---------------------------------------------------------------------------

function npcDocFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    npcId: "charA1", characterId: "charA1", cityId: "cityA", ownerUid: "ownerA",
    displayNameSnapshot: "Ada Archivist", titleFreeform: "Chief Archivist",
    roleTemplate: "steward",
    personality: { traits: ["meticulous"], voiceNotes: null, characterNotes: null },
    scopeFreeform: "Keep the city rolls; run routine funds.",
    permissionMode: "act-for-me", status: "active",
    currentMandateId: null, currentMandateVersion: null,
    activationSeq: 1, retiredSeq: null, stateVersion: 1,
    createdAt: null, updatedAt: null,
    ...overrides,
  };
}

function mandateRootFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mandateId: "mand-1", npcId: "charA1", cityId: "cityA", ownerUid: "ownerA",
    currentVersion: 1, status: "active",
    currentVersionRef: "sim_mandates/mand-1/versions/1",
    createdSeq: 1, revokedSeq: null, expiresAtSeq: null,
    createdAt: null, updatedAt: null,
    ...overrides,
  };
}

function mandateVersionFixture(
  mode: string,
  scopeOverrides: Record<string, unknown> = {},
  capsOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const v = buildMandateVersion(
    {
      version: 1, npcId: "charA1", cityId: "cityA", ownerUid: "ownerA",
      permissionMode: mode as never,
      scopeFreeform: "fixture mandate",
      structuredScope: {
        triggerKinds: ["log-event"], allowedActionTypes: ["fixture_fund"],
        namedRecordIds: [], counterpartyCityIds: null, ...scopeOverrides,
      } as never,
      caps: {
        perActionRubars: 1000, perResolutionPeriodRubars: 10000,
        periodDefinition: null, maxProjectPhase: null,
        allowPartialExecution: false, ...capsOverrides,
      } as never,
      negotiationBounds: null, alwaysEscalate: [], responseStyle: null,
      expiresAtSeq: null, horizonActions: null, sourceActionId: "act-fixture-mandate",
    },
    new Date(0)
  );
  return { ...(v as unknown as Record<string, unknown>), effectiveSeq: 1 };
}

function stageWorld(
  mode = "act-for-me",
  scopeOverrides: Record<string, unknown> = {},
  capsOverrides: Record<string, unknown> = {}
): Map<string, Record<string, unknown> | null> {
  const docs = worldDocs();
  docs.set("sim_cities/cityA", { cityId: "cityA", stats: { treasuryRubars: 5000 }, stateVersion: 1 });
  docs.set("sim_npcs/charA1", npcDocFixture({ permissionMode: mode, currentMandateId: "mand-1", currentMandateVersion: 1 }));
  docs.set("sim_mandates/mand-1", mandateRootFixture());
  docs.set("sim_mandates/mand-1/versions/1", mandateVersionFixture(mode, scopeOverrides, capsOverrides));
  return docs;
}

const NPC_ACTOR = npcActorStanding({
  npcId: "charA1", ownerUid: "ownerA", mandateId: "mand-1", mandateVersion: 1,
});

const TRIGGER = { kind: "log-event", sourceId: "evt-1", sourceSeq: 0 };

function delegatedAction(
  actionType: string,
  structuredAction: Record<string, unknown>,
  requestId: string,
  targetCityIds?: string[]
): SimAction {
  const action = memberAction(NPC_ACTOR as SimActor, "ownerA", actionType, structuredAction, requestId);
  if (targetCityIds) action.targetCityIds = targetCityIds;
  return action;
}

function applyPlan(docs: Map<string, Record<string, unknown> | null>, plan: ResolutionPlan): void {
  for (const w of plan.writes) {
    if (w.op === "delete") docs.delete(w.path);
    else if (w.afterDoc) docs.set(w.path, w.afterDoc);
  }
  const counter = docs.get("sim_counters/log");
  if (counter) {
    docs.set("sim_counters/log", {
      ...counter,
      lastSeq: (counter.lastSeq as number) + plan.entries.length,
    });
  }
}

// ---------------------------------------------------------------------------
section("G6 — authority stage verdict routing (PR-2)");
check("A-4: the P5-K3 default literal is ask-first, read from the builder", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "ask-first");
});

check("resolve: a mandated Tier A action dispatches and stamps citation + trigger", () => {
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, fundName: "Library fund", trigger: TRIGGER,
  }, "req-stage-resolve");
  const plan = runAction(stageWorld(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.ok(plan.writes.length > 0, "the underlying rule actually dispatched");
  const summary = plan.entries[plan.entries.length - 1];
  const classification = summary.classification as Record<string, unknown>;
  assert.deepEqual(classification.mandate, { mandateId: "mand-1", mandateVersion: 1, mode: "act-for-me" });
  assert.equal((classification.trigger as Record<string, unknown>).kind, "log-event");
});

check("reject: a revoked mandate refuses with the module's verbatim AUTHORITY_REVOKED", () => {
  const docs = stageWorld();
  docs.set("sim_mandates/mand-1", mandateRootFixture({ status: "revoked", revokedSeq: 5 }));
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-revoked");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  // The committer's recompute carve-out compares this code literally:
  // a preview computed while the mandate stood, recomputed after
  // revocation, must commit as this rejection, not stale-preview.
  assert.equal(plan.rejection?.code, "AUTHORITY_REVOKED");
  assert.equal(plan.writes.length, 0);
});

check("reject: a tampered stored version fails the stage's stored-hash check", () => {
  const docs = stageWorld();
  const version = docs.get("sim_mandates/mand-1/versions/1") as Record<string, unknown>;
  docs.set("sim_mandates/mand-1/versions/1", { ...version, scopeFreeform: "tampered prose" });
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-hash");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "MANDATE_HASH_MISMATCH");
});

check("reject: a pending_activation NPC is refused NPC_NOT_ACTIVE (status never coerced)", () => {
  const docs = stageWorld();
  docs.set("sim_npcs/charA1", npcDocFixture({ status: "pending_activation", currentMandateId: "mand-1", currentMandateVersion: 1 }));
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-pending");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "NPC_NOT_ACTIVE");
});

check("escalate: an out-of-scope action resolves as an escalation plan, changes []", () => {
  const docs = stageWorld("act-for-me", { allowedActionTypes: ["some_other_kind"] });
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-escalate");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  const summary = plan.entries[plan.entries.length - 1];
  assert.deepEqual(summary.changes, []);
  const classification = summary.classification as Record<string, unknown>;
  assert.equal(classification.producer, "escalation");
  assert.equal(
    (classification.escalation as Record<string, unknown>).failedCheck,
    "scope/caps (§5.3)"
  );
});

check("A-8 Tier B: an NPC attempt at a Tier B verb escalates whole, never resolves", () => {
  // The battery's Tier B refusal case: canon adoption (R-11 adopt kind,
  // class canon-adoption) under an act-for-me mandate that purports to
  // allow it. PR-6's B-06 loan-acceptance verb joins this same battery
  // when it lands (assembly plan §5.5 / A-8).
  const docs = stageWorld("act-for-me", { allowedActionTypes: ["adopt_lore_draft"] });
  const action = delegatedAction("adopt_lore_draft", {
    cityId: "cityA", trigger: TRIGGER,
  }, "req-stage-tierb");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  const classification = plan.entries[plan.entries.length - 1].classification as Record<string, unknown>;
  assert.equal(classification.producer, "escalation");
  assert.equal((classification.escalation as Record<string, unknown>).failedCheck, "tier (check 6)");
});

check("draft-only: ask-first drafts via chronicle, summary carries the city (badging-safe)", () => {
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-draft");
  action.actionText = "Draft: establish the library fund for 100 R.";
  const plan = runAction(stageWorld("ask-first"), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  assert.deepEqual(plan.narrativeOutputs, [{ kind: "chronicle", text: "Draft: establish the library fund for 100 R." }]);
  const summary = plan.entries[plan.entries.length - 1];
  assert.equal(summary.cityId, "cityA", "the badging never throws CHRONICLE_UNBADGEABLE");
  const classification = summary.classification as Record<string, unknown>;
  assert.equal(classification.producer, "draft-only");
  assert.equal((classification.draftOnly as Record<string, unknown>).reason, "mode-ask-first");
});

check("silence: silent mode resolves as the §8 silence entry shape", () => {
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-silence");
  const plan = runAction(stageWorld("silent"), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  const summary = plan.entries[plan.entries.length - 1];
  assert.deepEqual(summary.changes, []);
  const classification = summary.classification as Record<string, unknown>;
  assert.equal(classification.silence, true);
  assert.equal(classification.producingMode, "silent");
  const trigger = classification.trigger as Record<string, unknown>;
  assert.equal(trigger.sourceKind, "log-event");
  assert.equal(trigger.sourceId, "evt-1");
  assert.equal(trigger.sourceSeq, 0);
});

check("blocked-fairness: a direct state change at a foreign city is a wall, not a question", () => {
  const action = delegatedAction("fixture_fund", {
    cityId: "cityA", amountRubars: 100, trigger: TRIGGER,
  }, "req-stage-fence", ["cityB"]);
  const plan = runAction(stageWorld(), action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  const classification = plan.entries[plan.entries.length - 1].classification as Record<string, unknown>;
  assert.equal(classification.producer, "blocked-fairness");
});

// ---------------------------------------------------------------------------
section("G7 — governance handlers end-to-end (PR-2)");
check("npc.edit edits definition fields under the owner gate", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "npc.edit", {
    npcId: "charA1", cityId: "cityA", titleFreeform: "Grand Archivist",
  }, "req-edit-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const write = plan.writes.find((w) => w.path === "sim_npcs/charA1");
  assert.equal((write?.afterDoc as Record<string, unknown>).titleFreeform, "Grand Archivist");
  assert.equal((write?.afterDoc as Record<string, unknown>).updatedAt, null, "update writes null only updatedAt");
});

check("npc.retire retires at summarySeq and re-derives the roster", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  docs.set("sim_teams/cityA", {
    cityId: "cityA", npcIds: ["charA1"], leadNpcId: null, displayNote: null,
    stateVersion: 1, lastChangedSeq: 1, createdAt: null, updatedAt: null,
  });
  const action = memberAction(OWNER, "ownerA", "npc.retire", {
    npcId: "charA1", cityId: "cityA",
  }, "req-retire-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const npc = plan.writes.find((w) => w.path === "sim_npcs/charA1")?.afterDoc as Record<string, unknown>;
  assert.equal(npc.status, "retired");
  assert.equal(npc.retiredSeq, 1);
  const team = plan.writes.find((w) => w.path === "sim_teams/cityA")?.afterDoc as Record<string, unknown>;
  assert.deepEqual(team.npcIds, []);
});

check("npc.setMode without a mandate moves only the snapshot", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "npc.setMode", {
    npcId: "charA1", cityId: "cityA", permissionMode: "silent",
  }, "req-mode-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 1);
  assert.equal((plan.writes[0].afterDoc as Record<string, unknown>).permissionMode, "silent");
});

check("npc.setMode with a mandate in force rolls the version (P5-D3)", () => {
  const docs = stageWorld();
  const action = memberAction(OWNER, "ownerA", "npc.setMode", {
    npcId: "charA1", cityId: "cityA", permissionMode: "silent",
    citations: { recordPaths: ["sim_mandates/mand-1"] },
  }, "req-mode-2");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const v2 = plan.writes.find((w) => w.path === "sim_mandates/mand-1/versions/2")?.afterDoc as Record<string, unknown>;
  assert.ok(v2, "version 2 written");
  assert.equal(v2.permissionMode, "silent");
  assert.equal(v2.effectiveSeq, 1);
  const v1 = plan.writes.find((w) => w.path === "sim_mandates/mand-1/versions/1")?.afterDoc as Record<string, unknown>;
  assert.equal(v1.supersededSeq, 1);
  const root = plan.writes.find((w) => w.path === "sim_mandates/mand-1")?.afterDoc as Record<string, unknown>;
  assert.equal(root.currentVersion, 2);
  const npc = plan.writes.find((w) => w.path === "sim_npcs/charA1")?.afterDoc as Record<string, unknown>;
  assert.equal(npc.currentMandateVersion, 2);
  assert.equal(npc.permissionMode, "silent");
});

section("G8 — mandate.set / mandate.revoke / delegationRule.set (PR-2)");
check("mandate.set (new root) stamps effectiveness in-resolution + NPC snapshot", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "mandate.set", {
    mandateId: "mand-1", npcId: "charA1", cityId: "cityA",
    permissionMode: "act-for-me", scopeFreeform: "Run routine funds.",
    structuredScope: { triggerKinds: ["log-event"], allowedActionTypes: ["fixture_fund"], namedRecordIds: [], counterpartyCityIds: null },
    caps: { perActionRubars: 1000, perResolutionPeriodRubars: 10000, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false },
  }, "req-mandate-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const root = plan.writes.find((w) => w.path === "sim_mandates/mand-1")?.afterDoc as Record<string, unknown>;
  assert.equal(root.status, "active");
  assert.equal(root.createdSeq, 1);
  assert.equal(root.currentVersion, 1);
  const version = plan.writes.find((w) => w.path === "sim_mandates/mand-1/versions/1")?.afterDoc as Record<string, unknown>;
  assert.equal(version.effectiveSeq, 1);
  assert.ok(typeof version.mandateHash === "string" && (version.mandateHash as string).length === 64);
  const npc = plan.writes.find((w) => w.path === "sim_npcs/charA1")?.afterDoc as Record<string, unknown>;
  assert.equal(npc.currentMandateId, "mand-1");
  assert.equal(npc.currentMandateVersion, 1);
});

check("mandate.set without a mandateId refuses MANDATE_ID_REQUIRED (no silent derivation)", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "mandate.set", { npcId: "charA1", cityId: "cityA" }, "req-mandate-2");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "MANDATE_ID_REQUIRED");
});

check("mandate.set authoring fence refuses a Tier B allowedActionType", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "mandate.set", {
    mandateId: "mand-9", npcId: "charA1", cityId: "cityA",
    permissionMode: "act-for-me", scopeFreeform: "Demolish things.",
    structuredScope: { triggerKinds: ["log-event"], allowedActionTypes: ["demolish_structure"], namedRecordIds: [], counterpartyCityIds: null },
    caps: { perActionRubars: null, perResolutionPeriodRubars: null, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false },
  }, "req-mandate-3");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "MANDATE_AUTHORIZES_TIER_B");
});

check("mandate.set flips a validated client-authored pending version instead of rebuilding", () => {
  const docs = stageWorld();
  const pending = buildMandateVersion(
    {
      version: 2, npcId: "charA1", cityId: "cityA", ownerUid: "ownerA",
      permissionMode: "act-for-me", scopeFreeform: "Wider routine.",
      structuredScope: { triggerKinds: ["log-event"], allowedActionTypes: ["fixture_fund"], namedRecordIds: [], counterpartyCityIds: null } as never,
      caps: { perActionRubars: 2000, perResolutionPeriodRubars: 10000, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false } as never,
      negotiationBounds: null, alwaysEscalate: [], responseStyle: null,
      expiresAtSeq: null, horizonActions: null, sourceActionId: "act-client-v2",
    },
    new Date(0)
  );
  docs.set("sim_mandates/mand-1/versions/2", { ...(pending as unknown as Record<string, unknown>) });
  const action = memberAction(OWNER, "ownerA", "mandate.set", {
    mandateId: "mand-1", version: 2,
    citations: { recordPaths: ["sim_mandates/mand-1"] },
  }, "req-mandate-4");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const v2 = plan.writes.find((w) => w.path === "sim_mandates/mand-1/versions/2")?.afterDoc as Record<string, unknown>;
  assert.equal(v2.effectiveSeq, 1);
  assert.equal(v2.scopeFreeform, "Wider routine.", "the authored payload is flipped, not rebuilt");
  const root = plan.writes.find((w) => w.path === "sim_mandates/mand-1")?.afterDoc as Record<string, unknown>;
  assert.equal(root.currentVersion, 2);
});

check("mandate.revoke rides the root's revokedSeq; the version doc is never written", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const setAction = memberAction(OWNER, "ownerA", "mandate.set", {
    mandateId: "mand-1", npcId: "charA1", cityId: "cityA",
    permissionMode: "act-for-me", scopeFreeform: "Run routine funds.",
    structuredScope: { triggerKinds: ["log-event"], allowedActionTypes: ["fixture_fund"], namedRecordIds: [], counterpartyCityIds: null },
    caps: { perActionRubars: 1000, perResolutionPeriodRubars: 10000, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false },
  }, "req-revoke-1");
  applyPlan(docs, runAction(docs, setAction, NOW_A));
  const revokeAction = memberAction(OWNER, "ownerA", "mandate.revoke", {
    mandateId: "mand-1",
    citations: { recordPaths: ["sim_mandates/mand-1"] },
  }, "req-revoke-2");
  const plan = runAction(docs, revokeAction, NOW_A);
  assert.equal(plan.outcome, "resolved");
  assert.ok(!plan.writes.some((w) => w.path.includes("/versions/")), "revocation never writes a version doc");
  const root = plan.writes.find((w) => w.path === "sim_mandates/mand-1")?.afterDoc as Record<string, unknown>;
  assert.equal(root.status, "revoked");
  assert.equal(root.revokedSeq, 2);
  const npc = plan.writes.find((w) => w.path === "sim_npcs/charA1")?.afterDoc as Record<string, unknown>;
  assert.equal(npc.currentMandateId, null);
  assert.equal(npc.currentMandateVersion, null);
  assert.equal(npc.permissionMode, "act-for-me", "the mode value is left as-is");
});

check("delegationRule.set writes root + version with Vera's ruleHash (copied vector)", () => {
  const docs = worldDocs();
  docs.set("factions/cascadia", { name: "Cascadia", ownerUids: ["uid-owner-cascadia"] });
  docs.set("sim_npcs/npc-steward", npcDocFixture({
    npcId: "npc-steward", characterId: "npc-steward", cityId: "cascadia", ownerUid: "uid-owner-cascadia",
  }));
  const cascadiaOwner: SimActor = { ...OWNER, memberId: "uid-owner-cascadia" };
  const action = memberAction(cascadiaOwner, "uid-owner-cascadia", "delegationRule.set", {
    ruleId: "rule-9", cityId: "cascadia", priority: 5,
    match: { situationKinds: ["question"], sourceKinds: [], cityIds: null, counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [] },
    handler: { npcId: "npc-steward", mode: "ask-first", mandateId: null },
    caps: {}, alwaysWait: false,
  }, "req-rule-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  // Hash parity: this digest is the value of Vera's computeRuleHash
  // field set over her situations-harness S4e payload (rule-9 /
  // uid-owner-cascadia / cascadia), computed with the function copied
  // verbatim into governance.ts. PR-3 assembly confirms parity
  // against her harness itself.
  const expected = "0b37d446b087f88be09adbb5cb193cae6c666eff775011ee6fc790725c434520";
  const root = plan.writes.find((w) => w.path === "sim_delegation_rules/rule-9")?.afterDoc as Record<string, unknown>;
  assert.equal(root.ruleHash, expected);
  assert.equal(root.status, "active");
  assert.equal(root.effectiveSeq, 1);
  const version = plan.writes.find((w) => w.path === "sim_delegation_rules/rule-9/versions/1")?.afterDoc as Record<string, unknown>;
  assert.equal(version.ruleHash, expected);
  assert.equal(
    computeDelegationRuleHash({
      ruleId: "rule-9", ownerUid: "uid-owner-cascadia", cityId: "cascadia", version: 1, priority: 5,
      match: { situationKinds: ["question"], sourceKinds: [], cityIds: null, counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [] },
      handler: { npcId: "npc-steward", mode: "ask-first", mandateId: null },
      caps: {}, alwaysWait: false, enabled: true,
    }),
    expected
  );
});

check("delegationRule.set fences: foreign NPC refused; alwaysWait requires wait-for-owner; disable flips status", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charB1", npcDocFixture({ npcId: "charB1", characterId: "charB1", cityId: "cityA", ownerUid: "ownerB" }));
  const foreign = memberAction(OWNER, "ownerA", "delegationRule.set", {
    ruleId: "rule-x", cityId: "cityA", priority: 1,
    match: {}, handler: { npcId: "charB1", mode: "ask-first", mandateId: null }, caps: {}, alwaysWait: false,
  }, "req-rule-2");
  const foreignPlan = runAction(docs, foreign, NOW_A);
  assert.equal(foreignPlan.outcome, "rejected");
  assert.equal(foreignPlan.rejection?.code, "DELEGATION_NPC_NOT_OWNED");

  const wait = memberAction(OWNER, "ownerA", "delegationRule.set", {
    ruleId: "rule-y", cityId: "cityA", priority: 1,
    match: {}, handler: { npcId: null, mode: "act-for-me", mandateId: null }, caps: {}, alwaysWait: true,
  }, "req-rule-3");
  const waitPlan = runAction(docs, wait, NOW_A);
  assert.equal(waitPlan.outcome, "rejected");
  assert.equal(waitPlan.rejection?.code, "ALWAYS_WAIT_REQUIRES_WAIT_MODE");

  const docs2 = worldDocs();
  docs2.set("sim_npcs/charA1", npcDocFixture());
  const setRule = memberAction(OWNER, "ownerA", "delegationRule.set", {
    ruleId: "rule-z", cityId: "cityA", priority: 1,
    match: {}, handler: { npcId: "charA1", mode: "ask-first", mandateId: null }, caps: {}, alwaysWait: false,
  }, "req-rule-4");
  applyPlan(docs2, runAction(docs2, setRule, NOW_A));
  const disable = memberAction(OWNER, "ownerA", "delegationRule.set", {
    ruleId: "rule-z", cityId: "cityA", priority: 1, enabled: false,
    match: {}, handler: { npcId: "charA1", mode: "ask-first", mandateId: null }, caps: {}, alwaysWait: false,
  }, "req-rule-5");
  const disablePlan = runAction(docs2, disable, NOW_A);
  assert.equal(disablePlan.outcome, "resolved");
  const root = disablePlan.writes.find((w) => w.path === "sim_delegation_rules/rule-z")?.afterDoc as Record<string, unknown>;
  assert.equal(root.status, "disabled");
  assert.equal(root.version, 2);
});

section("G9 — envelope spawn / cancel (PR-2, F-S1 rename live)");
check("envelope.spawn writes a QUEUED envelope under the brief's field names", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const action = memberAction(OWNER, "ownerA", "envelope.spawn", {
    npcId: "charA1", cityId: "cityA", taskType: "one-off",
    task: "Draft the weekly digest.", clientRequestId: "req-env-1",
    bounds: { counterpartyCityIds: [] },
  }, "req-env-spawn-1");
  const plan = runAction(docs, action, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const taskId = envelopeTaskId("ownerA", "req-env-1");
  const write = plan.writes.find((w) => w.path === `sim_task_envelopes/${taskId}`);
  assert.ok(write, "deterministic envelope id from requester + clientRequestId");
  const doc = write.afterDoc as Record<string, unknown>;
  assert.equal(doc.status, "QUEUED");
  assert.equal(doc.requestingMemberId, "ownerA", "F-S1: the brief's name, not requesterUid");
  assert.equal(doc.task, "Draft the weekly digest.", "F-S1: the brief's name, not intentText");
  assert.ok(!("requesterUid" in doc) && !("intentText" in doc));
  assert.equal(doc.createdSeq, 1);
});

check("envelope.spawn duplicate (same clientRequestId) refuses ENVELOPE_ALREADY_EXISTS", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const spawn = () =>
    memberAction(OWNER, "ownerA", "envelope.spawn", {
      npcId: "charA1", cityId: "cityA", taskType: "one-off",
      task: "Draft the weekly digest.", clientRequestId: "req-env-1",
      bounds: { counterpartyCityIds: [] },
    }, "req-env-spawn-2");
  applyPlan(docs, runAction(docs, spawn(), NOW_A));
  const plan = runAction(docs, spawn(), NOW_A);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "ENVELOPE_ALREADY_EXISTS");
});

check("envelope.cancel: QUEUED → FAILED + cancelled_before_claim; RUNNING and non-requester refused", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const spawn = memberAction(OWNER, "ownerA", "envelope.spawn", {
    npcId: "charA1", cityId: "cityA", taskType: "one-off",
    task: "Draft the weekly digest.", clientRequestId: "req-env-1",
    bounds: { counterpartyCityIds: [] },
  }, "req-env-spawn-3");
  applyPlan(docs, runAction(docs, spawn, NOW_A));
  const taskId = envelopeTaskId("ownerA", "req-env-1");

  const stranger: SimActor = { ...OWNER, memberId: "memberC" };
  const foreignCancel = memberAction(stranger, "memberC", "envelope.cancel", { taskId }, "req-env-cancel-0");
  const foreignPlan = runAction(docs, foreignCancel, NOW_A);
  assert.equal(foreignPlan.outcome, "rejected");
  assert.equal(foreignPlan.rejection?.code, "AUTHORITY_REVOKED");

  const cancel = memberAction(OWNER, "ownerA", "envelope.cancel", { taskId }, "req-env-cancel-1");
  const plan = runAction(docs, cancel, NOW_A);
  assert.equal(plan.outcome, "resolved");
  const doc = plan.writes.find((w) => w.path === `sim_task_envelopes/${taskId}`)?.afterDoc as Record<string, unknown>;
  assert.equal(doc.status, "FAILED");
  assert.equal((doc.lastError as Record<string, unknown>).code, "cancelled_before_claim");
  assert.equal(doc.outputId, null, "cancelled-before-claim leaves outputId null (flag F-E)");
  assert.equal(doc.completionOutcome, null);

  const envDoc = docs.get(`sim_task_envelopes/${taskId}`) as Record<string, unknown>;
  docs.set(`sim_task_envelopes/${taskId}`, {
    ...envDoc, status: "RUNNING",
    claim: { cycleId: "wake-1", leaseId: "lease-1", claimedAt: NOW_A, leaseExpiresAt: NOW_B },
  });
  const cancelRunning = memberAction(OWNER, "ownerA", "envelope.cancel", { taskId }, "req-env-cancel-2");
  const runningPlan = runAction(docs, cancelRunning, NOW_A);
  assert.equal(runningPlan.outcome, "rejected");
  assert.equal(runningPlan.rejection?.code, "ENVELOPE_ALREADY_CLAIMED");
});

check("buildTaskOutput stores the caller-supplied audienceUids (§9.5 branch)", () => {
  const docs = worldDocs();
  docs.set("sim_npcs/charA1", npcDocFixture());
  const spawn = memberAction(OWNER, "ownerA", "envelope.spawn", {
    npcId: "charA1", cityId: "cityA", taskType: "one-off",
    task: "Draft the weekly digest.", clientRequestId: "req-env-9",
    bounds: { counterpartyCityIds: [] },
  }, "req-env-spawn-9");
  const plan = runAction(docs, spawn, NOW_A);
  const env = plan.writes[0].afterDoc as never;
  const output = buildTaskOutput(env, {
    outcome: "DONE", outputText: "Digest drafted.", summary: "Draft complete.",
    audienceUids: ["ownerA", "ownerB"],
  });
  assert.deepEqual(output.audienceUids, ["ownerA", "ownerB"]);
});

section("G10 — verifier NPC checks (PR-2): traceability triple, inert pre-Phase-5");
function verifyWorld(npcOverrides: Record<string, unknown> = {}) {
  const genesisDraft = {
    ...ruleEffectDraft({
      actor: { type: "system", memberId: null, npcId: null, onBehalfOfMemberId: null, mandateId: null, mandateVersion: null, envelopeId: null } as SimActor,
      summaryText: "genesis",
    }),
    kind: "genesis" as const,
    summary: true,
  };
  const genesis = buildLogEntry(genesisDraft, {
    seq: 1, resolutionSeq: 1, resolutionId: "genesis", entryIndexWithinResolution: 0,
    resolvedAt: NOW_A, rulesVersion: "sim-rules-0.5.0-phase5",
    prevHash: "0".repeat(64), wakeActionId: null, executedDuringSeq: null,
  });
  const npcDraft = summaryDraft({
    actor: NPC_ACTOR as SimActor,
    actionId: "act-npc-1",
    cityId: "cityA",
    cityIds: ["cityA"],
    ruleIds: [],
    classification: {
      mandate: { mandateId: "mand-1", mandateVersion: 1, mode: "act-for-me" },
      trigger: { kind: "log-event", sourceId: "evt-1", sourceSeq: 1, deliberation: null },
    },
    summaryText: "NPC acted under mandate.",
  });
  const npcEntry = buildLogEntry(npcDraft, {
    seq: 2, resolutionSeq: 2, resolutionId: "res-npc-1", entryIndexWithinResolution: 0,
    resolvedAt: NOW_A, rulesVersion: "sim-rules-0.5.0-phase5",
    prevHash: genesis.entryHash as string, wakeActionId: null, executedDuringSeq: null,
  });
  const stateDocs = new Map<string, Record<string, unknown>>();
  stateDocs.set("sim_npcs/charA1", npcDocFixture({
    currentMandateId: "mand-1", currentMandateVersion: 1, ...npcOverrides,
  }));
  stateDocs.set("sim_mandates/mand-1", mandateRootFixture());
  stateDocs.set("sim_mandates/mand-1/versions/1", mandateVersionFixture("act-for-me"));
  const manifests = new Map<string, Record<string, unknown>>([
    ["res-npc-1", { writeSet: [], lastSeq: 2 }],
  ]);
  return {
    entries: [genesis, npcEntry],
    manifests,
    counter: { lastSeq: 2, lastEntryHash: npcEntry.entryHash as string },
    world: { lastCommittedSeq: 2 },
    stateDocs,
    baselineRegistry: fixtureRegistry,
  };
}

check("a fully-traced NPC entry verifies clean", () => {
  const result = verifyStandingLog(verifyWorld());
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

check("an owner mismatch in the traceability triple is a finding", () => {
  const result = verifyStandingLog(verifyWorld({ ownerUid: "ownerB" }));
  assert.ok(result.findings.some((f) => f.code === "NPC_TRACE_OWNER_MISMATCH"));
  assert.equal(result.ok, false);
});

check("characterId on an NPC actor is flagged (P5-K13); absent key never is", () => {
  const world = verifyWorld();
  const tampered = {
    ...world,
    entries: world.entries.map((e) =>
      e.seq === 2 ? { ...e, actor: { ...(e.actor as Record<string, unknown>), characterId: "charA1" } } : e
    ),
  };
  // The tampered actor changes the entry hash too — recompute so only
  // the P5-K13 finding (and its hash consequence) can appear; assert
  // the specific code is present.
  const result = verifyStandingLog(tampered as never);
  assert.ok(result.findings.some((f) => f.code === "CHARACTER_ID_ON_NON_MEMBER"));
});

console.log(`\ngovernance harness: ${checks} checks passed`);
