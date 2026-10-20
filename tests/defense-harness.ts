/**
 * Defensive harness (Phase 4 step 8) — a pure (snapshot, action) →
 * plan battery over lib/sim/rules/defensive.ts, in the cat1-harness
 * style. No emulator: handlers are pure, so the battery fabricates
 * snapshots, calls the handlers through their descriptors' read plans
 * (the F-01 contract, materialized here against an in-memory world),
 * and runs every resolved plan through the REAL validatePlan —
 * including the F-02 changes↔writes reconciliation — with the
 * defensive descriptors registered into RULE_DESCRIPTORS in-process,
 * exactly the merge the Build Lead's assembly edit will perform in
 * registry.ts.
 *
 * Run: ./node_modules/.bin/tsx tests/defense-harness.ts
 */

import assert from "node:assert/strict";
import {
  collectActionReadPaths,
  finalizePlan,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { RULE_DESCRIPTORS, type HandlerContext, type RuleDescriptor } from "../lib/sim/rules/registry";
import {
  DEFENSIVE_DESCRIPTORS,
  PHASE4_POSTURE_DAMAGE_FACTOR,
  caseIdForResolution,
} from "../lib/sim/rules/defensive";
import { isStructureFunctioning } from "../lib/sim/rules/structures";
import type {
  ResolutionPlan,
  SimAction,
  SimActor,
  SimSnapshot,
  SnapshotQueryRecord,
} from "../lib/sim/state";

Object.assign(RULE_DESCRIPTORS, DEFENSIVE_DESCRIPTORS);

const KIND_TO_DESCRIPTOR: Record<string, RuleDescriptor> = {};
for (const descriptor of Object.values(DEFENSIVE_DESCRIPTORS)) {
  for (const kind of descriptor.actionKinds) KIND_TO_DESCRIPTOR[kind] = descriptor;
}

const fixtureRegistry = buildFixtureBaselineRegistry();
const NOW = "2026-10-20T12:00:00.000Z";

const memberActor = (uid: string): SimActor => ({
  type: "member",
  memberId: uid,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

let actionCounter = 0;
function act(
  actionType: string,
  uid: string,
  structuredAction: Record<string, unknown>
): SimAction {
  actionCounter += 1;
  const actionId = `act_def_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "defense-harness",
    actor: memberActor(uid),
    actionType,
    actionText: `${actionType} (harness)`,
    structuredAction,
    targetCityIds: typeof structuredAction.cityId === "string" ? [structuredAction.cityId] : [],
    threadRef: null,
    audienceUids: [],
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
}

// ---------------------------------------------------------------------------
// World + snapshot materialization (the dispatcher's job, in miniature)
// ---------------------------------------------------------------------------

type World = Map<string, Record<string, unknown>>;

function runAction(world: World, action: SimAction): ResolutionPlan {
  const descriptor = KIND_TO_DESCRIPTOR[action.actionType];
  assert.ok(descriptor, `no defensive descriptor classifies ${action.actionType}`);
  const handler = descriptor.handlers[action.actionType];
  assert.ok(handler, `descriptor ${descriptor.id} has no handler for ${action.actionType}`);

  const basePaths = collectActionReadPaths(action);
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of basePaths) seedDocs.set(path, world.get(path) ?? null);
  const extra = descriptor.readPlan?.({ action, seedDocs }) ?? {};
  const docs = new Map(seedDocs);
  for (const path of extra.paths ?? []) docs.set(path, world.get(path) ?? null);

  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of extra.queries ?? []) {
    const prefix = `${spec.collectionPath}/`;
    const resultPaths = [...world.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .filter((key) => {
        const doc = world.get(key) as Record<string, unknown>;
        return spec.filters.every((f) => doc[f.field] === f.value);
      })
      .sort();
    for (const path of resultPaths) docs.set(path, world.get(path) ?? null);
    queryRecords.push({ spec, resultPaths, digest: "defense-harness" });
  }

  const snapshot: SimSnapshot = snapshotFromDocs(docs, NOW, queryRecords);
  const ctx: HandlerContext = {
    snapshot,
    action,
    resolutionId: action.actionId,
    prepared: undefined,
    baselineRegistry: fixtureRegistry,
    citableBaseline: null,
    citations: {},
  };
  const plan = handler(ctx);
  plan.descriptorId = descriptor.id;
  if (plan.outcome === "resolved") {
    validatePlan(plan, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot });
    finalizePlan(plan);
    assert.ok(plan.planHash.length > 0, "finalized plan carries a hash");
    for (const write of plan.writes) {
      if (write.op === "delete") world.delete(write.path);
      else world.set(write.path, write.afterDoc as Record<string, unknown>);
    }
  }
  return plan;
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code, `expected rejection code ${code}, got ${plan.rejection?.code}`);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
}

const cityStats = (world: World, cityId: string): Record<string, unknown> =>
  (world.get(`sim_cities/${cityId}`)?.stats ?? {}) as Record<string, unknown>;
const cityDoc = (world: World, cityId: string) => world.get(`sim_cities/${cityId}`);
const structureDoc = (world: World, cityId: string, structureId: string) =>
  world.get(`sim_cities/${cityId}/structures/${structureId}`);
const entryTexts = (plan: ResolutionPlan): string => plan.entries.map((e) => e.summaryText).join("\n");
const changeFields = (plan: ResolutionPlan): string[] =>
  plan.entries.flatMap((e) => e.changes.map((c) => c.field));

// ---------------------------------------------------------------------------
// Fixture world — lastSeq 100. cityA: allocated attacker (ownerA).
// cityB: allocated target (ownerB) with structures + households.
// cityC: the even-start template — every index null, GDP null (ownerC).
// ---------------------------------------------------------------------------

function seedWorld(): World {
  const world: World = new Map();
  world.set("sim_counters/log", { lastSeq: 100, lastEntryHash: "ab".repeat(32) });
  world.set("sim_world/current", { lastCommittedSeq: 100 });
  world.set("factions/cityA", { name: "Fixture City A", slug: "fixture-a", ownerUids: ["ownerA"] });
  world.set("factions/cityB", { name: "Fixture City B", slug: "fixture-b", ownerUids: ["ownerB"] });
  world.set("factions/cityC", { name: "Fixture City C", slug: "fixture-c", ownerUids: ["ownerC"] });
  world.set("sim_cities/cityA", {
    factionId: "cityA",
    stats: {
      spirit: 50, culture: 40, infrastructure: 50, stability: 60, law: 30,
      influence: 20, military: 40, defense: 35,
      households: 0, housingUnits: 0, treasuryRubars: 100000,
      population: 100, gdpRubars: 1000000,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  });
  world.set("sim_cities/cityB", {
    factionId: "cityB",
    stats: {
      spirit: 50, culture: 10, infrastructure: 20, stability: 60, law: 30,
      influence: 20, military: 40, defense: 35,
      households: 2, housingUnits: 6, treasuryRubars: 5000,
      population: 50, gdpRubars: 500000,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  });
  world.set("sim_cities/cityC", {
    factionId: "cityC",
    stats: {
      spirit: null, culture: null, infrastructure: null, stability: null, law: null,
      influence: null, military: null, defense: null,
      households: 0, housingUnits: 0, treasuryRubars: 0,
      population: null, gdpRubars: null,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  });
  const structure = (
    structureId: string,
    fields: Record<string, unknown>
  ): void => {
    world.set(`sim_cities/cityB/structures/${structureId}`, {
      name: structureId, kind: "civic", status: "complete", condition: 100,
      profile: {}, sourceActionId: "seed", ...fields,
    });
  };
  structure("keepB", { kind: "military" });
  structure("houseB", { kind: "housing", units: 4 });
  structure("houseB2", { kind: "housing", units: 2 });
  structure("oldB", { condition: 30 });
  structure("fallsB", { kind: "other", profile: { geography: "natural" } });
  structure("goneB", { status: "demolished", condition: 0 });
  const household = (householdId: string, fields: Record<string, unknown>): void => {
    world.set(`sim_cities/cityB/households/${householdId}`, {
      name: householdId, size: 2, memberFigureIds: [], homeStructureId: null,
      status: "housed", originCityId: "cityB", sourceActionId: "seed", ...fields,
    });
  };
  household("hh_b1", { size: 3, homeStructureId: "houseB2" });
  household("hh_b2", { size: 1, homeStructureId: "houseB2" });
  household("hh_far", { size: 5, homeStructureId: "keepB" });
  return world;
}

const attack = (
  uid: string,
  cityId: string,
  targetCityId: string,
  damageClass: string,
  structureIds?: string[]
): SimAction =>
  act("attack_city", uid, {
    cityId,
    targetCityId,
    damageClass,
    ...(structureIds ? { structureIds } : {}),
  });

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

let passed = 0;
function scenario(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`ok ${name}`);
}

scenario("S1 property attack, unpostured target: fixed class lands, actor pays, tier-2 case opens", () => {
  const world = seedWorld();
  const action = attack("ownerA", "cityA", "cityB", "property", ["keepB"]);
  const plan = runAction(world, action);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.entries.length, 4);
  assert.deepEqual(plan.entries.map((e) => e.kind), ["rule-effect", "rule-effect", "case", "action-summary"]);
  assert.equal(structureDoc(world, "cityB", "keepB")?.condition, 60);
  assert.equal(cityStats(world, "cityB").infrastructure, 17);
  assert.equal(cityStats(world, "cityA").law, 25);
  assert.equal(cityStats(world, "cityA").stability, 58);
  assert.equal(cityStats(world, "cityA").influence, 17);
  const caseId = caseIdForResolution(action.actionId);
  const caseDoc = world.get(`sim_cases/${caseId}`);
  assert.ok(caseDoc, "case record created");
  assert.equal(caseDoc.tier, 2);
  assert.equal(caseDoc.status, "open");
  assert.equal(caseDoc.accusedCityId, "cityA");
  assert.deepEqual(caseDoc.injuredCityIds, ["cityB"]);
  assert.equal(caseDoc.ruleId, "R-18");
  assert.equal(caseDoc.openedAtSeq, 104, "openedAtSeq = counter head 100 + 4 entries (allocation commitSeq precedent)");
  const exposure = cityDoc(world, "cityA")?.legalExposure as Record<string, unknown>;
  assert.equal(exposure.open, true);
  assert.deepEqual(exposure.caseIds, [caseId]);
  assert.equal(exposure.tier, 2);
  assert.ok(entryTexts(plan).includes("no consent record"), "consent check output is logged");
});

scenario("S2 R-37 prepare: treasury-paid, record set, >10% flag; re-prepare pays again and replaces", () => {
  const world = seedWorld();
  const first = runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 2000 }));
  assert.equal(first.outcome, "resolved");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 3000);
  assert.deepEqual(cityDoc(world, "cityB")?.defensePosture, {
    prepared: true, setAtSeq: 102, treasuryPaidRubars: 2000,
  });
  assert.ok(entryTexts(first).includes("exceeds 10% of the city's treasury"), "2000 > 10% of 5000 — proposal flag present");
  const second = runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 200 }));
  assert.equal(cityStats(world, "cityB").treasuryRubars, 2800);
  assert.deepEqual(cityDoc(world, "cityB")?.defensePosture, {
    prepared: true, setAtSeq: 102, treasuryPaidRubars: 200,
  });
  assert.ok(entryTexts(second).includes("prior posture is replaced"), "re-prepare is a replacement, not a stack");
  assert.ok(!entryTexts(second).includes("exceeds 10%"), "200 ≤ 10% of the pre-payment treasury (3000) — no proposal flag");
});

scenario("S3 postured target: posture consumed, Phase 4 damage unscaled (factor pinned at 1)", () => {
  assert.equal(PHASE4_POSTURE_DAMAGE_FACTOR, 1, "the flagged constant: v2 publishes no fixed-class reduction");
  const world = seedWorld();
  runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 1000 }));
  const plan = runAction(world, attack("ownerA", "cityA", "cityB", "property", ["keepB"]));
  assert.equal(structureDoc(world, "cityB", "keepB")?.condition, 60, "full −40 lands on a postured target in the Phase 4 form");
  const posture = cityDoc(world, "cityB")?.defensePosture as Record<string, unknown>;
  assert.equal(posture.prepared, false, "posture consumed by the hostile resolution");
  assert.equal(posture.treasuryPaidRubars, 1000, "consumption keeps the payment as history");
  assert.ok(changeFields(plan).includes("defensePosture"), "consumption is a Log change line");
  assert.ok(entryTexts(plan).includes("posture is consumed"), "consumption is stated in the target entry");
  // Second attack: no posture left to consume — no defensePosture line.
  const plan2 = runAction(world, attack("ownerA", "cityA", "cityB", "property", ["keepB"]));
  assert.ok(!changeFields(plan2).includes("defensePosture"), "no double consumption");
  assert.equal(structureDoc(world, "cityB", "keepB")?.condition, 20);
});

scenario("S4 stand down: ends the posture, no refund, provenance kept; nothing standing → rejected", () => {
  const world = seedWorld();
  expectRejected(
    runAction(world, act("stand_down_defenses", "ownerB", { cityId: "cityB" })),
    "NOTHING_TO_STAND_DOWN"
  );
  runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 1000 }));
  const plan = runAction(world, act("stand_down_defenses", "ownerB", { cityId: "cityB" }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 4000, "no refund — treasury stays where the preparation left it");
  const posture = cityDoc(world, "cityB")?.defensePosture as Record<string, unknown>;
  assert.equal(posture.prepared, false);
  assert.equal(posture.treasuryPaidRubars, 1000, "the last preparation's payment stays on the record as history");
});

scenario("S5 R-37 rejections: zero amount, over-treasury, non-owner", () => {
  const world = seedWorld();
  expectRejected(runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 0 })), "INVALID_AMOUNT");
  expectRejected(runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 2.5 })), "INVALID_AMOUNT");
  expectRejected(runAction(world, act("prepare_defenses", "ownerB", { cityId: "cityB", amountRubars: 999999 })), "INSUFFICIENT_TREASURY");
  expectRejected(runAction(world, act("prepare_defenses", "ownerA", { cityId: "cityB", amountRubars: 100 })), "AUTHORITY_REVOKED");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5000, "rejections write nothing");
});

scenario("S6 damage to ruin: status flips, function derived-stops, housingUnits recomputed", () => {
  const world = seedWorld();
  runAction(world, attack("ownerA", "cityA", "cityB", "property", ["oldB"]));
  const oldB = structureDoc(world, "cityB", "oldB");
  assert.equal(oldB?.condition, 0);
  assert.equal(oldB?.status, "ruined");
  assert.equal(isStructureFunctioning(oldB), false, "a ruined structure does not function (Catalogue I predicate)");
  runAction(world, attack("ownerA", "cityA", "cityB", "property", ["houseB"]));
  const houseB = structureDoc(world, "cityB", "houseB");
  assert.equal(houseB?.condition, 60);
  assert.equal(houseB?.status, "complete");
  assert.equal(isStructureFunctioning(houseB), false, "ANY damage stops function (CJ) — condition 60 is not functioning");
  assert.equal(cityStats(world, "cityB").housingUnits, 2, "damaged housing leaves the functioning-units count until repaired (only houseB2's 2 units still function)");
});

scenario("S7 inhabited attack: residents displaced (never deleted), population and spirit land", () => {
  const world = seedWorld();
  const plan = runAction(world, attack("ownerA", "cityA", "cityB", "inhabited", ["houseB2"]));
  assert.equal(plan.outcome, "resolved");
  assert.equal(structureDoc(world, "cityB", "houseB2")?.condition, 60);
  for (const hid of ["hh_b1", "hh_b2"]) {
    const doc = world.get(`sim_cities/cityB/households/${hid}`);
    assert.ok(doc, `${hid} persists — fictional people are never deleted by fiat`);
    assert.equal(doc.status, "displaced");
    assert.equal(doc.homeStructureId, "houseB2", "the record of where they lived is kept");
  }
  assert.equal(world.get("sim_cities/cityB/households/hh_far")?.status, "housed", "households of unnamed structures are untouched");
  assert.equal(cityStats(world, "cityB").population, 46, "50 − (3 + 1) displaced persons");
  assert.equal(cityStats(world, "cityB").spirit, 46);
  assert.equal(cityStats(world, "cityB").infrastructure, 17);
  assert.ok(entryTexts(plan).includes("2 household(s), 4 person(s)"), "displacement counts are in the Log text");
});

scenario("S8 economic attack: GDP −1.5% and the GDP-derived treasury skim", () => {
  const world = seedWorld();
  runAction(world, attack("ownerA", "cityA", "cityB", "economic"));
  assert.equal(cityStats(world, "cityB").gdpRubars, 492500, "500000 − round(1.5%) = 492500");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 2500, "skim = min(5000, round(0.5% of 500000) = 2500)");
  assert.equal(cityStats(world, "cityB").infrastructure, 20, "the economic class carries no infrastructure delta");
});

scenario("S9 economic attack on a null-GDP city: percentages skip-and-log, case still opens", () => {
  const world = seedWorld();
  const action = attack("ownerA", "cityA", "cityC", "economic");
  const plan = runAction(world, action);
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityC").gdpRubars, null, "null stays null — the engine invents no value");
  assert.equal(cityStats(world, "cityC").treasuryRubars, 0);
  assert.ok(entryTexts(plan).includes("gdp unset"), "the GDP skip is logged");
  assert.ok(entryTexts(plan).includes("treasury skim"), "the skim skip is logged");
  assert.ok(world.get(`sim_cases/${caseIdForResolution(action.actionId)}`), "the tier-2 case opens regardless of skipped percentages");
  assert.equal(cityStats(world, "cityA").law, 25, "actor costs land in full even when target percentages skip");
});

scenario("S10 null-military attacker: rejected with the unbuilt reason, nothing written (P4-G1-C7)", () => {
  const world = seedWorld();
  const plan = runAction(world, attack("ownerC", "cityC", "cityB", "property", ["keepB"]));
  expectRejected(plan, "MILITARY_UNBUILT");
  assert.ok(plan.rejection?.summaryText.includes("military = null"), "the rejection states the unbuilt reason verbatim");
  assert.equal(cityStats(world, "cityC").military, null, "the stored value stays null");
  assert.equal(structureDoc(world, "cityB", "keepB")?.condition, 100, "the target is untouched");
});

scenario("S11 R-18 rejection battery: targets, classes, structures", () => {
  const world = seedWorld();
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityA", "property", ["keepB"])), "TARGET_IS_OWN_CITY");
  expectRejected(runAction(world, attack("ownerB", "cityA", "cityB", "property", ["keepB"])), "AUTHORITY_REVOKED");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityZ", "economic")), "TARGET_NOT_IN_SIM");
  expectRejected(runAction(world, act("attack_city", "ownerA", { cityId: "cityA", damageClass: "economic" })), "NO_TARGET_CITY");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityB", "siege", ["keepB"])), "INVALID_DAMAGE_CLASS");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityB", "property", [])), "NO_STRUCTURES_NAMED");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityB", "property", ["nope"])), "STRUCTURE_NOT_FOUND");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityB", "property", ["fallsB"])), "GEOGRAPHY_FIXED");
  expectRejected(runAction(world, attack("ownerA", "cityA", "cityB", "property", ["goneB"])), "STRUCTURE_DEMOLISHED");
  assert.equal([...world.keys()].filter((k) => k.startsWith("sim_cases/")).length, 0, "no case opens on a rejected attack");
});

scenario("S12 the carve-out is stated, and R-18's case is automatic anyway (CJ round 2)", () => {
  const world = seedWorld();
  const plan = runAction(world, attack("ownerA", "cityA", "cityB", "property", ["keepB"]));
  const caseEntry = plan.entries.find((e) => e.kind === "case");
  assert.ok(caseEntry, "a case-kind entry is emitted");
  assert.ok(caseEntry.summaryText.includes("espionage"), "the carve-out is named in the case entry");
  assert.ok(caseEntry.summaryText.includes("does not apply here"), "open attack keeps its automatic case");
  assert.equal(caseEntry.legal?.tier, 2);
  assert.equal(DEFENSIVE_DESCRIPTORS["R-18"].visibility, "public", "R-18 is an open act — nothing covert exists in this family");
  assert.equal(DEFENSIVE_DESCRIPTORS["R-37"].finance?.shortfallClass, "transfer", "posture payment refuses in full on shortfall");
});

console.log(`\nDefensive harness: ${passed} scenarios passed (every resolved plan passed validatePlan incl. F-02 reconciliation).`);
