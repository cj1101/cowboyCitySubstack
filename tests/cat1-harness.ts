/**
 * Catalogue I harness (Phase 4 step 5) — a pure (snapshot, action) →
 * plan battery over lib/sim/rules/structures.ts and laws.ts, in the
 * sim-core suite's plain-assert style. No emulator: handlers are pure,
 * so the battery fabricates snapshots, calls the handlers through
 * their descriptors' read plans (the F-01 contract, materialized here
 * against an in-memory world), and runs every resolved plan through
 * the REAL validatePlan — including the F-02 changes↔writes
 * reconciliation — with the catalogue's descriptors registered into
 * RULE_DESCRIPTORS in-process, exactly the merge the Build Lead's
 * assembly edit will perform in registry.ts.
 *
 * Run: npx tsx tests/cat1-harness.ts
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
  STRUCTURE_DESCRIPTORS,
  deriveLifecycle,
  functioningHousingUnits,
  isStructureFunctioning,
  functionStateReason,
  paidTowardCurrentPhase,
  phaseCostRubars,
} from "../lib/sim/rules/structures";
import {
  LAW_DESCRIPTORS,
  deriveTaxScheduleFromLaws,
} from "../lib/sim/rules/laws";
import { hasLiveConnection } from "../lib/sim/rules/arithmetic";
import type {
  ResolutionPlan,
  SimAction,
  SimActor,
  SimSnapshot,
  SnapshotQueryRecord,
} from "../lib/sim/state";

// The Lead's assembly, simulated: register both family maps.
Object.assign(RULE_DESCRIPTORS, STRUCTURE_DESCRIPTORS, LAW_DESCRIPTORS);

const ALL_DESCRIPTORS: Record<string, RuleDescriptor> = {
  ...STRUCTURE_DESCRIPTORS,
  ...LAW_DESCRIPTORS,
};
const KIND_TO_DESCRIPTOR: Record<string, RuleDescriptor> = {};
for (const descriptor of Object.values(ALL_DESCRIPTORS)) {
  for (const kind of descriptor.actionKinds) KIND_TO_DESCRIPTOR[kind] = descriptor;
}

const fixtureRegistry = buildFixtureBaselineRegistry();
const NOW = "2026-10-19T12:00:00.000Z";

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
  const actionId = `act_cat1_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "cat1-harness",
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
  assert.ok(descriptor, `no catalogue descriptor classifies ${action.actionType}`);
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
    queryRecords.push({ spec, resultPaths, digest: "cat1-harness" });
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
    // Apply the folded writes to the world for the next step.
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
const structureDoc = (world: World, cityId: string, structureId: string) =>
  world.get(`sim_cities/${cityId}/structures/${structureId}`);
const entryTexts = (plan: ResolutionPlan): string => plan.entries.map((e) => e.summaryText).join("\n");
const ruleIdsOf = (plan: ResolutionPlan): string[][] => plan.entries.map((e) => e.ruleIds);

// ---------------------------------------------------------------------------
// Fixture world
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
      households: 2, housingUnits: 0, treasuryRubars: 5000,
      population: 50, gdpRubars: 500000,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  });
  // City C: the even-start template — every index null, GDP null.
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
  // City B households: one housed, one awaiting a move (immigration source).
  world.set("sim_cities/cityB/households/hh_b1", {
    name: "B1 household", size: 2, memberFigureIds: [], homeStructureId: "seedhouseB",
    status: "housed", originCityId: "cityB", sourceActionId: "seed", sourceSeq: 1,
  });
  world.set("sim_cities/cityB/households/hh_migrant", {
    name: "Migrant household", size: 2, memberFigureIds: [], homeStructureId: null,
    status: "unhoused", originCityId: "cityB", sourceActionId: "seed", sourceSeq: 1,
  });
  return world;
}

function seedStructure(
  world: World,
  cityId: string,
  structureId: string,
  doc: Record<string, unknown>
): void {
  world.set(`sim_cities/${cityId}/structures/${structureId}`, {
    schemaVersion: 2,
    cityId,
    workUnitsDone: 0,
    paidRubars: 0,
    residentHouseholdIds: [],
    staffFigureIds: [],
    staffCorporationIds: [],
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    ...doc,
  });
}

// ===========================================================================
// S1 — R-05 spine: two-phase civic build, R-01 completion in table order
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "libA", {
    name: "Grand Library", kind: "civic", status: "planned", sizeClass: "standard",
    totalBudgetRubars: 10000, condition: null, units: null,
    profile: { function: { statement: "City library and archive", tags: ["archive"] }, supports: ["culture"], prestige: 5 },
  });

  const phase1 = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "libA" }));
  assert.equal(phase1.outcome, "resolved");
  assert.deepEqual(ruleIdsOf(phase1), [["R-05"], ["R-05"]], "no completion on phase 1");
  assert.equal(cityStats(world, "cityA").treasuryRubars, 95000, "phase 1 pays round(10000/2) = 5000");
  assert.equal(structureDoc(world, "cityA", "libA")?.status, "under-construction");
  assert.equal(structureDoc(world, "cityA", "libA")?.workUnitsDone, 1);

  const phase2 = runAction(world, act("advance_project", "ownerA", { cityId: "cityA", structureId: "libA" }));
  assert.equal(phase2.outcome, "resolved");
  assert.deepEqual(ruleIdsOf(phase2), [["R-05"], ["R-01"], ["R-05", "R-01"]], "completion fires inside the same event, table order, summary last");
  const done = structureDoc(world, "cityA", "libA");
  assert.equal(done?.status, "complete");
  assert.equal(done?.condition, 100, "condition is 100 on completion");
  assert.equal(done?.prestige, 5, "prestige set from profile");
  assert.equal(done?.paidRubars, 10000, "last phase takes the remainder: 5000 + 5000");
  const stats = cityStats(world, "cityA");
  assert.equal(stats.treasuryRubars, 90000);
  assert.equal(stats.culture, 42, "R-01 culture +2");
  assert.equal(stats.infrastructure, 51, "R-01 infrastructure +1");
  assert.equal(stats.gdpRubars, 1002000, "R-01 gdp +0.2% = +2000");
  assert.ok(isStructureFunctioning(done as Record<string, unknown>), "a fresh completion functions");
  console.log("ok S1: R-05 two-phase build; R-01 completion inside the completing event");
}

// ===========================================================================
// S2 — R-05 budget class: partial phase funding, then catch-up
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "annexA", {
    name: "Records Annex", kind: "other", status: "planned", sizeClass: "standard",
    totalBudgetRubars: 10000, condition: null, units: null,
    profile: { function: { statement: "Overflow records storage", tags: [] }, supports: [] },
  });
  // Fixture: the treasury is nearly empty when work starts.
  const cityA = world.get("sim_cities/cityA") as Record<string, unknown>;
  world.set("sim_cities/cityA", { ...cityA, stats: { ...(cityA.stats as object), treasuryRubars: 3000 } });

  const p1 = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "annexA" }));
  assert.equal(p1.outcome, "resolved");
  assert.ok(entryTexts(p1).includes("SHORTFALL 2000 R"), "shortfall is logged, not silent");
  const afterP1 = structureDoc(world, "cityA", "annexA");
  assert.equal(afterP1?.status, "under-construction", "break-ground happened on the owner's act");
  assert.equal(afterP1?.workUnitsDone, 0, "a part-paid phase does NOT complete (budget class)");
  assert.equal(afterP1?.paidRubars, 3000);
  assert.equal(paidTowardCurrentPhase(afterP1 as Record<string, unknown>), 3000, "per-phase progress derives from paidRubars");

  // Fixture: funds arrive (some other event); the owner continues work.
  const cityA2 = world.get("sim_cities/cityA") as Record<string, unknown>;
  world.set("sim_cities/cityA", { ...cityA2, stats: { ...(cityA2.stats as object), treasuryRubars: 100000 } });
  runAction(world, act("advance_project", "ownerA", { cityId: "cityA", structureId: "annexA" }));
  const afterP2 = structureDoc(world, "cityA", "annexA");
  assert.equal(afterP2?.workUnitsDone, 1, "paying the phase remainder completes the phase");
  assert.equal(afterP2?.paidRubars, 5000);
  assert.equal(cityStats(world, "cityA").treasuryRubars, 98000, "only the 2000 remainder was due");

  const p3 = runAction(world, act("advance_project", "ownerA", { cityId: "cityA", structureId: "annexA" }));
  assert.equal(structureDoc(world, "cityA", "annexA")?.status, "complete");
  assert.deepEqual(ruleIdsOf(p3), [["R-05"], ["R-05"]], "kind other with no supports: completion is narrative-only, no rule fires");
  assert.ok(entryTexts(p3).includes("no completion rule matches"), "the narrative-only completion is stated, not silent");
  console.log("ok S2: R-05 partial funding — shortfall logged, phase completes only when fully paid");
}

// ===========================================================================
// S3 — R-02 industrial completion: GDP branch, founding dividend, supplier
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "factoryA", {
    name: "Kelp Works", kind: "industrial", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "Kelp processing plant", tags: ["plant"] }, supports: ["economy"], supplierCityIds: ["cityB"] },
  });
  const plan = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "factoryA" }));
  assert.deepEqual(ruleIdsOf(plan), [["R-05"], ["R-02"], ["R-02"], ["R-05", "R-02"]], "R-02 entry + supplier spillover entry");
  const stats = cityStats(world, "cityA");
  assert.equal(stats.gdpRubars, 1009000, "industrial branch: gdp +0.9% of 1000000 = +9000");
  assert.equal(stats.treasuryRubars, 100000 + 5045, "founding dividend round(0.5% × 1009000) = 5045");
  assert.equal(stats.infrastructure, 51, "industrial only: infrastructure +1");
  assert.equal(cityStats(world, "cityB").gdpRubars, 501000, "supplier spillover: cityB gdp +0.2% = +1000");
  console.log("ok S3: R-02 industrial branch, founding dividend, supplier spillover");
}

// ===========================================================================
// S4 — R-03 housing: households form by the action; the ratio crossing
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "homesA", {
    name: "Meridian Homes", kind: "housing", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: 2,
    profile: { function: { statement: "Two family apartments", tags: ["residence"] }, supports: ["housing"] },
    housing: { unitMix: [{ type: "family", count: 2 }], tenure: "rental", rentBandRubars: null, occupancyPolicy: "open", amenities: [], qualityNote: null },
  });
  const p1 = runAction(world, act("start_project", "ownerA", {
    cityId: "cityA", structureId: "homesA",
    newHouseholds: [
      { name: "Aldana family", size: 3 },
      { name: "Boro household", size: 2 },
    ],
  }));
  assert.deepEqual(ruleIdsOf(p1), [["R-05"], ["R-03"], ["R-05", "R-03"]]);
  let stats = cityStats(world, "cityA");
  assert.equal(stats.housingUnits, 2, "housingUnits += U at completion (functioning units)");
  assert.equal(stats.households, 2, "two household records formed by the action");
  assert.equal(stats.population, 105, "population += housed sizes (3 + 2) where set");
  assert.equal(stats.spirit, 50, "no crossing reward: there was no standing shortage (households were 0)");
  const residents = structureDoc(world, "cityA", "homesA")?.residentHouseholdIds as string[];
  assert.equal(residents.length, 2);
  const housedDoc = world.get(`sim_cities/cityA/households/${residents[0]}`);
  assert.equal(housedDoc?.status, "housed");
  assert.equal(housedDoc?.homeStructureId, "homesA");

  // A queued household now waits unhoused: ratio 2 units / 3 households < 1.
  world.set("sim_cities/cityA/households/hh_q", {
    name: "Queued household", size: 1, memberFigureIds: [], homeStructureId: null,
    status: "unhoused", originCityId: "cityA", sourceActionId: "seed", sourceSeq: 1,
  });
  seedStructure(world, "cityA", "homesB", {
    name: "Annex Flats", kind: "housing", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: 2,
    profile: { function: { statement: "Two more flats", tags: ["residence"] }, supports: ["housing"] },
  });
  const p2 = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "homesB" }));
  stats = cityStats(world, "cityA");
  assert.equal(stats.housingUnits, 4);
  assert.equal(stats.households, 3, "the queued household was already a record; the count stands at 3");
  assert.equal(stats.spirit, 51, "housedRatio crossed < 1 → >= 1: spirit +1, once, at the crossing");
  assert.ok(entryTexts(p2).includes("housedRatio 0.67 → 1.00"), "the crossing math is on the entry");
  assert.equal(world.get("sim_cities/cityA/households/hh_q")?.status, "housed");
  assert.equal(world.get("sim_cities/cityA/households/hh_q")?.homeStructureId, "homesB");
  console.log("ok S4: R-03 household formation by action + housedRatio spirit crossing");
}

// ===========================================================================
// S5 — R-03 immigration: zero-sum, both sides logged
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "homesC", {
    name: "Harbor Homes", kind: "housing", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: 3,
    profile: { function: { statement: "Harbor-side housing", tags: ["residence"] }, supports: ["housing"] },
  });
  const plan = runAction(world, act("start_project", "ownerA", {
    cityId: "cityA", structureId: "homesC", originCityId: "cityB", householdIds: ["hh_migrant"],
  }));
  assert.equal(world.get("sim_cities/cityB/households/hh_migrant"), undefined, "origin loses the record");
  const arrived = world.get("sim_cities/cityA/households/hh_migrant");
  assert.equal(arrived?.status, "housed");
  assert.equal(arrived?.homeStructureId, "homesC");
  assert.equal(arrived?.originCityId, "cityB");
  assert.equal(cityStats(world, "cityB").households, 1, "origin households 2 → 1");
  assert.equal(cityStats(world, "cityB").population, 48, "origin population −2 (set, so it moves)");
  assert.equal(cityStats(world, "cityA").population, 102, "destination population +2");
  assert.equal(cityStats(world, "cityA").households, 1);
  assert.ok(plan.entries.some((e) => e.cityId === "cityB" && e.ruleIds.includes("R-03")), "the origin side is logged in the same event");
  console.log("ok S5: R-03 immigration is zero-sum and logged on both cities");
}

// ===========================================================================
// S6 — R-04 transport completion: endpoints + standing connection records
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "railA", {
    name: "North Line", kind: "transport", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "Rail line to cityB", tags: ["railhead"] }, supports: ["transport"], endpointCityIds: ["cityB"] },
  });
  const plan = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "railA" }));
  assert.deepEqual(ruleIdsOf(plan), [["R-05"], ["R-04"], ["R-04"], ["R-05", "R-04"]]);
  assert.equal(cityStats(world, "cityA").infrastructure, 53, "R-04 infrastructure +3");
  assert.equal(cityStats(world, "cityA").gdpRubars, 1003000, "R-04 gdp +0.3%");
  assert.equal(cityStats(world, "cityB").infrastructure, 21, "endpoint infrastructure +1");
  const traitsA = (world.get("sim_cities/cityA")?.traits ?? []) as string[];
  const traitsB = (world.get("sim_cities/cityB")?.traits ?? []) as string[];
  assert.ok(traitsA.includes("connection:cityB:live"), "standing connection record on the builder's doc");
  assert.ok(traitsB.includes("connection:cityA:live"), "standing connection record on the endpoint's doc");
  assert.ok(hasLiveConnection(traitsA), "the engine's own connectivity read sees the connection (WB-7.2)");
  console.log("ok S6: R-04 endpoints gain infrastructure +1 and the standing connection record");
}

// ===========================================================================
// S7 — R-38 military completion + the no-branch rejection (P4-G7-C4)
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "fortA", {
    name: "Fort Meridan", kind: "military", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "Border fortification", tags: ["fortification"] }, supports: ["defense"] },
  });
  const plan = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "fortA" }));
  assert.deepEqual(ruleIdsOf(plan), [["R-05"], ["R-38"], ["R-05", "R-38"]]);
  assert.equal(cityStats(world, "cityA").defense, 37, "supports branch defense: +2");
  assert.equal(cityStats(world, "cityA").military, 40, "the unnamed branch does not move");
  assert.equal(structureDoc(world, "cityA", "fortA")?.prestige, 3, "prestige defaults to 3");
  assert.ok(entryTexts(plan).includes("supports branch(es) defense"), "the branch taken is named in the Log");

  seedStructure(world, "cityA", "fortB", {
    name: "Undeclared Barracks", kind: "military", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "Barracks", tags: ["barracks"] }, supports: [] },
  });
  const rejected = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "fortB" }));
  expectRejected(rejected, "R38_SUPPORTS_MISSING");
  assert.equal(structureDoc(world, "cityA", "fortB")?.status, "planned", "nothing moved: the engine never guesses");
  console.log("ok S7: R-38 defense branch +2; a branchless military profile is rejected at proposal");
}

// ===========================================================================
// S8 — P4-G5-C1: function is data. Two completions identical except the
// profile.function tags: the memorial tag is what R-01's spillover reads.
// ===========================================================================
{
  const world = seedWorld();
  const baseProfile = {
    statement: "Memorial to the shared expedition",
    supports: ["culture"],
    namedCityIds: ["cityB"],
  };
  seedStructure(world, "cityA", "memorialA", {
    name: "Expedition Memorial", kind: "civic", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { ...baseProfile, function: { statement: baseProfile.statement, tags: ["memorial"] } },
  });
  seedStructure(world, "cityA", "memorialB", {
    name: "Expedition Venue", kind: "civic", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { ...baseProfile, function: { statement: baseProfile.statement, tags: ["venue"] } },
  });
  const withMemorialTag = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "memorialA" }));
  assert.equal(cityStats(world, "cityB").culture, 11, "memorial function + named city: spillover culture +1 lands");
  assert.ok(withMemorialTag.entries.some((e) => e.cityId === "cityB" && e.ruleIds.includes("R-01")), "a spillover entry exists for the named city");
  const withoutTag = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "memorialB" }));
  assert.equal(cityStats(world, "cityB").culture, 11, "same profile, function tags changed to venue: NO spillover — the function field is what the rule reads");
  assert.ok(!withoutTag.entries.some((e) => e.cityId === "cityB"), "no cross-city entry in the variant");
  console.log("ok S8: P4-G5-C1 — a rule's output differs when only profile.function changes");
}

// ===========================================================================
// S9 — R-16 demolition: uninhabited passes; inhabited refuses toward R-17
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "hallA", {
    name: "Old Hall", kind: "civic", status: "complete", condition: 100, units: null,
    totalBudgetRubars: 4000,
    profile: { function: { statement: "Assembly hall", tags: ["venue"] }, supports: ["culture"] },
  });
  const plan = runAction(world, act("demolish_structure", "ownerA", { cityId: "cityA", structureId: "hallA", demolitionCostRubars: 100 }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(structureDoc(world, "cityA", "hallA")?.status, "demolished");
  assert.equal(cityStats(world, "cityA").infrastructure, 49, "infrastructure −1 (the built fabric shrinks)");
  assert.equal(cityStats(world, "cityA").treasuryRubars, 99900, "demolition cost paid");
  assert.equal(cityStats(world, "cityA").culture, 40, "banked completion gains are NOT clawed back");
  assert.ok(entryTexts(plan).includes("precondition check: residentHouseholds=0"), "the uninhabited check output is logged");

  seedStructure(world, "cityA", "homesZ", {
    name: "Occupied Homes", kind: "housing", status: "complete", condition: 100, units: 2,
    totalBudgetRubars: 4000, residentHouseholdIds: ["hh_someone"],
    profile: { function: { statement: "Homes", tags: ["residence"] }, supports: ["housing"] },
  });
  const refused = runAction(world, act("demolish_structure", "ownerA", { cityId: "cityA", structureId: "homesZ" }));
  expectRejected(refused, "INHABITED_REDIRECT_R17");
  assert.equal(structureDoc(world, "cityA", "homesZ")?.status, "complete", "an inhabited structure is untouched by R-16");
  console.log("ok S9: R-16 uninhabited demolition; inhabited refuses with the R-17 redirect (P4-D2)");
}

// ===========================================================================
// S10 — R-19 mothball: refused branch, confirmed branch, R-05 reactivation
// ===========================================================================
{
  const world = seedWorld();
  world.set("sim_cities/cityA/households/hh_res", {
    name: "Resident household", size: 2, memberFigureIds: [], homeStructureId: "homesM",
    status: "housed", originCityId: "cityA", sourceActionId: "seed", sourceSeq: 1,
  });
  seedStructure(world, "cityA", "homesM", {
    name: "Mothball Flats", kind: "housing", status: "complete", condition: 100, units: 2,
    totalBudgetRubars: 4000, residentHouseholdIds: ["hh_res"],
    profile: { function: { statement: "Flats", tags: ["residence"] }, supports: ["housing"] },
  });
  // Align the stored count with the seeded records for the recompute.
  const cityA = world.get("sim_cities/cityA") as Record<string, unknown>;
  world.set("sim_cities/cityA", { ...cityA, stats: { ...(cityA.stats as object), housingUnits: 2, households: 1 } });

  const refused = runAction(world, act("mothball_structure", "ownerA", { cityId: "cityA", structureId: "homesM" }));
  expectRejected(refused, "INHABITED_REDIRECT_R17");
  assert.equal(structureDoc(world, "cityA", "homesM")?.status, "complete");

  const plan = runAction(world, act("mothball_structure", "ownerA", { cityId: "cityA", structureId: "homesM", confirmDisplacement: true }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(structureDoc(world, "cityA", "homesM")?.status, "mothballed");
  assert.deepEqual(structureDoc(world, "cityA", "homesM")?.residentHouseholdIds, []);
  const displaced = world.get("sim_cities/cityA/households/hh_res");
  assert.equal(displaced?.status, "displaced", "the household record persists — people are not deleted by fiat");
  assert.equal(displaced?.homeStructureId, null);
  assert.equal(cityStats(world, "cityA").spirit, 49, "spirit −1");
  assert.equal(cityStats(world, "cityA").housingUnits, 0, "mothballed units leave housingUnits by recompute");
  assert.ok(entryTexts(plan).includes("branch: inhabited-confirmed"), "the branch taken is logged");

  const back = runAction(world, act("advance_project", "ownerA", { cityId: "cityA", structureId: "homesM" }));
  assert.equal(back.outcome, "resolved");
  assert.equal(structureDoc(world, "cityA", "homesM")?.status, "complete", "reactivation is an R-05 advance on the same record");
  assert.equal(cityStats(world, "cityA").housingUnits, 2, "units return on reactivation (the structure functions again)");
  assert.equal(world.get("sim_cities/cityA/households/hh_res")?.status, "displaced", "reactivation does NOT restore displaced households — people move by housing actions");
  console.log("ok S10: R-19 branches (refused / confirmed displacement) + R-05 reactivation");
}

// ===========================================================================
// S11 — R-24 repair: damaged → function returns; ruined → complete + infra;
// demolished is never repaired (P4-G5-C2's repair half)
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "damagedA", {
    name: "Cracked Market Hall", kind: "commercial", status: "complete", condition: 40, units: null,
    totalBudgetRubars: 20000,
    profile: { function: { statement: "Market hall", tags: ["market"] }, supports: ["economy"] },
  });
  const damaged = structureDoc(world, "cityA", "damagedA") as Record<string, unknown>;
  assert.equal(isStructureFunctioning(damaged), false, "any damage stops function (derived, CJ S-6)");
  assert.equal(functionStateReason(damaged), "damaged");
  assert.equal(deriveLifecycle(damaged), "damaged");

  const plan = runAction(world, act("repair_structure", "ownerA", { cityId: "cityA", structureId: "damagedA" }));
  assert.equal(plan.outcome, "resolved");
  const repaired = structureDoc(world, "cityA", "damagedA") as Record<string, unknown>;
  assert.equal(repaired.condition, 100, "condition := 100 (binary repair)");
  assert.equal(isStructureFunctioning(repaired), true, "function resumes — derived at read time, no stored flag flipped");
  assert.equal(deriveLifecycle(repaired), "existing");
  assert.equal(cityStats(world, "cityA").treasuryRubars, 100000 - 12000, "cost = round(20000 × 60/100) from the record's own budget basis");
  assert.ok(entryTexts(plan).includes("Function was stopped (damaged) and now resumes"), "the outage and the return are both on the record");

  seedStructure(world, "cityA", "ruinA", {
    name: "Ruined Theater", kind: "cultural", status: "ruined", condition: 0, units: null,
    totalBudgetRubars: 10000,
    profile: { function: { statement: "Theater", tags: ["venue"] }, supports: ["culture"] },
  });
  assert.equal(deriveLifecycle(structureDoc(world, "cityA", "ruinA") as Record<string, unknown>), "destroyed");
  const rebuild = runAction(world, act("repair_structure", "ownerA", { cityId: "cityA", structureId: "ruinA" }));
  assert.equal(rebuild.outcome, "resolved");
  const restored = structureDoc(world, "cityA", "ruinA") as Record<string, unknown>;
  assert.equal(restored.status, "complete", "ruined returns to complete under R-24 as written in v2");
  assert.equal(restored.condition, 100);
  assert.equal(deriveLifecycle(restored), "rebuilt", "the rebuilt badge derives from the restoration stamp");
  assert.equal(cityStats(world, "cityA").infrastructure, 52, "infrastructure +2 on a ruined structure's return");

  seedStructure(world, "cityA", "goneA", {
    name: "Demolished Mill", kind: "industrial", status: "demolished", condition: 0, units: null,
    totalBudgetRubars: 10000,
    profile: { function: { statement: "Mill", tags: ["plant"] }, supports: ["economy"] },
  });
  expectRejected(runAction(world, act("repair_structure", "ownerA", { cityId: "cityA", structureId: "goneA" })), "STRUCTURE_DEMOLISHED");
  expectRejected(runAction(world, act("repair_structure", "ownerA", { cityId: "cityA", structureId: "damagedA" })), "NOTHING_TO_REPAIR");
  console.log("ok S11: R-24 damaged/ruined repair restores derived function; demolished never resurrects");
}

// ===========================================================================
// S12 — P4-G5-C3 geography: natural records refuse every handler; a
// man-made feature is an ordinary R-05 record
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "lakeA", {
    name: "Mirror Lake", kind: "other", status: "complete", condition: 100, units: null,
    totalBudgetRubars: null,
    profile: { geography: "natural", function: { statement: "A natural lake", tags: [] }, supports: [] },
  });
  const before = structuredClone(structureDoc(world, "cityA", "lakeA"));
  expectRejected(runAction(world, act("advance_project", "ownerA", { cityId: "cityA", structureId: "lakeA" })), "GEOGRAPHY_FIXED");
  expectRejected(runAction(world, act("demolish_structure", "ownerA", { cityId: "cityA", structureId: "lakeA" })), "GEOGRAPHY_FIXED");
  expectRejected(runAction(world, act("mothball_structure", "ownerA", { cityId: "cityA", structureId: "lakeA" })), "GEOGRAPHY_FIXED");
  expectRejected(runAction(world, act("repair_structure", "ownerA", { cityId: "cityA", structureId: "lakeA" })), "GEOGRAPHY_FIXED");
  assert.deepEqual(structureDoc(world, "cityA", "lakeA"), before, "the natural record is byte-identical after the battery");

  seedStructure(world, "cityA", "canalA", {
    name: "Dug Canal", kind: "infrastructure", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "A man-made canal", tags: [] }, supports: ["infrastructure"] },
  });
  const canal = runAction(world, act("start_project", "ownerA", { cityId: "cityA", structureId: "canalA" }));
  assert.equal(canal.outcome, "resolved", "a man-made feature is an ordinary project outcome under R-05");
  assert.equal(structureDoc(world, "cityA", "canalA")?.status, "complete");
  console.log("ok S12: geography posture — natural features fixed, man-made features ordinary records");
}

// ===========================================================================
// S13 — R-08 laws: vocabulary discipline, standing effects; F-08 schedule
// derivation and repeal (R-09)
// ===========================================================================
{
  const world = seedWorld();
  const law = runAction(world, act("pass_law", "ownerA", {
    cityId: "cityA", lawId: "law_housing_code", title: "Housing Code",
    structuredEffects: [
      { field: "stats.spirit", operation: "delta", value: 1 },
      { field: "stats.housingUnits", operation: "delta", value: 10 },
      { field: "mayorTermYears", operation: "set", value: 2 },
    ],
  }));
  assert.equal(law.outcome, "resolved");
  const stats = cityStats(world, "cityA");
  assert.equal(stats.spirit, 51, "the expressible effect applies verbatim, once");
  assert.equal(stats.housingUnits, 0, "housingUnits is a derived-stored count — not a lawful direct effect");
  assert.equal(stats.law, 32, "standing effect: law +2");
  assert.equal(stats.stability, 61, "standing effect: stability +1");
  const lawDoc = world.get("sim_cities/cityA/laws/law_housing_code");
  assert.equal(lawDoc?.status, "in-force");
  assert.equal((lawDoc?.narrativeOnlyEffects as unknown[]).length, 2, "non-expressible effects are recorded narrative-only, never applied");
  assert.ok(entryTexts(law).includes("2 recorded narrative-only"), "the narrative-only count is on the entry");

  const tax = runAction(world, act("set_tax_policy", "ownerA", {
    cityId: "cityA", lawId: "law_tax_1", title: "Business Tax Act",
    structuredEffects: [
      { field: "tax.payrollWithholdingBps", operation: "set", value: 250 },
      { field: "tax.operatingReceiptsBps", operation: "set", value: 500 },
    ],
  }));
  assert.equal(tax.outcome, "resolved");
  assert.ok(entryTexts(tax).includes("operatingReceipts 500 bps"), "the schedule delta is printed in full (F-08)");
  const allLaws = [...world.keys()].filter((k) => k.startsWith("sim_cities/cityA/laws/")).map((k) => world.get(k) as Record<string, unknown>);
  const schedule = deriveTaxScheduleFromLaws(allLaws);
  assert.deepEqual(
    { o: schedule.operatingReceiptsBps, p: schedule.payrollWithholdingBps, c: schedule.contractPaymentsBps },
    { o: 500, p: 250, c: null },
    "the schedule derives from in-force laws; unset components stay unset (no inheritance)"
  );
  assert.deepEqual(schedule.lawIds, ["law_tax_1"]);

  expectRejected(runAction(world, act("set_tax_policy", "ownerA", {
    cityId: "cityA", lawId: "law_tax_empty",
    structuredEffects: [{ field: "stats.spirit", operation: "delta", value: 1 }],
  })), "NO_TAX_EFFECTS");

  const repeal = runAction(world, act("repeal_law", "ownerA", { cityId: "cityA", lawId: "law_tax_1", reason: "Replaced next session." }));
  assert.equal(repeal.outcome, "resolved");
  assert.equal(world.get("sim_cities/cityA/laws/law_tax_1")?.status, "repealed", "marked, never deleted");
  assert.equal(cityStats(world, "cityA").stability, 61, "repeal: stability −1 (62 after both passages' standing +1s, −1 at repeal)");
  assert.equal(cityStats(world, "cityA").law, 34, "law unchanged by repeal (30 + 2 + 2 standing; repealing through process is lawful)");
  const afterRepeal = deriveTaxScheduleFromLaws(
    [...world.keys()].filter((k) => k.startsWith("sim_cities/cityA/laws/")).map((k) => world.get(k) as Record<string, unknown>)
  );
  assert.equal(afterRepeal.payrollWithholdingBps, null, "repeal removes the component from the derived schedule, prospectively");
  expectRejected(runAction(world, act("repeal_law", "ownerA", { cityId: "cityA", lawId: "law_tax_1" })), "ALREADY_REPEALED");

  // A fresh payroll tax for the F-11 scenarios.
  runAction(world, act("set_tax_policy", "ownerA", {
    cityId: "cityA", lawId: "law_tax_2", title: "Payroll Withholding Act",
    structuredEffects: [{ field: "tax.payrollWithholdingBps", operation: "set", value: 1000 }],
  }));
  console.log("ok S13: R-08 vocabulary + standing effects; F-08 schedule derives and un-derives on repeal (R-09)");

  // =========================================================================
  // S14 — F-09 budget authorizations: versioned, never mutated, no movement
  // =========================================================================
  const treasuryBefore = cityStats(world, "cityA").treasuryRubars;
  const v1 = runAction(world, act("set_budget_authorization", "ownerA", { cityId: "cityA", category: "services", capRubars: 5000 }));
  assert.equal(v1.outcome, "resolved");
  const v1Id = (v1.entries[0].classification?.budgetAuthorization as Record<string, unknown>).budgetId as string;
  const v1Doc = world.get(`sim_cities/cityA/budgets/${v1Id}`);
  assert.equal(v1Doc?.version, 1);
  assert.equal(v1Doc?.supersedes, null);
  const v1Snapshot = structuredClone(v1Doc);

  const v2 = runAction(world, act("set_budget_authorization", "ownerA", { cityId: "cityA", supersedesBudgetId: v1Id, capRubars: 8000 }));
  const v2Id = (v2.entries[0].classification?.budgetAuthorization as Record<string, unknown>).budgetId as string;
  assert.notEqual(v2Id, v1Id, "an amendment is a NEW version doc");
  assert.equal(world.get(`sim_cities/cityA/budgets/${v2Id}`)?.version, 2);
  assert.equal(world.get(`sim_cities/cityA/budgets/${v2Id}`)?.supersedes, v1Id);
  assert.deepEqual(world.get(`sim_cities/cityA/budgets/${v1Id}`), v1Snapshot, "the prior version is never mutated in place");

  const retire = runAction(world, act("set_budget_authorization", "ownerA", { cityId: "cityA", retireBudgetId: v2Id }));
  assert.equal(retire.outcome, "resolved");
  const v3Id = (retire.entries[0].classification?.budgetAuthorization as Record<string, unknown>).budgetId as string;
  assert.equal(world.get(`sim_cities/cityA/budgets/${v3Id}`)?.status, "retired");
  assert.equal(cityStats(world, "cityA").treasuryRubars, treasuryBefore, "F-09 moves no Rubars, ever");
  console.log("ok S14: F-09 versioned authorizations (create / amend / retire), record-only");

  // =========================================================================
  // S15 — F-10 service contract payment: legs, taxable fact, shortfall
  // =========================================================================
  world.set("sim_cities/cityA/corporations/corpA", {
    corporationId: "corpA", name: "Meridian Ferry Co", industry: "transport", status: "active",
    valuationRubars: 0, listed: false, legacyBookRubars: null, founderFigureId: null,
    ownerMemberId: "ownerA", companyCashRubars: 1000, taxPayables: {},
    homeCityId: "cityA", marketCityIds: [], linkedStructureIds: [],
    sourceActionId: "seed", sourceSeq: 1, stateVersion: 1, lastChangedSeq: 1, lastResolutionId: "seed",
  });
  const pay = runAction(world, act("service_contract_pay", "ownerA", {
    cityId: "cityA", corporationId: "corpA", amountRubars: 2000, serviceRef: "ferry route operation", budgetId: v2Id,
  }));
  assert.equal(pay.outcome, "resolved");
  assert.equal(cityStats(world, "cityA").treasuryRubars, (treasuryBefore as number) - 2000, "treasury → company");
  assert.equal(world.get("sim_cities/cityA/corporations/corpA")?.companyCashRubars, 3000);
  const factEntry = pay.entries.find((e) => (e.classification as Record<string, unknown> | null)?.taxableFact);
  const fact = (factEntry?.classification as Record<string, unknown>).taxableFact as Record<string, unknown>;
  assert.equal(fact.kind, "contract-payment", "the taxable fact is recorded for F-06 (Catalogue II)");
  assert.equal(fact.baseAmountRubars, 2000);
  assert.equal(fact.operatingCityId, "cityA");
  assert.ok(entryTexts(pay).includes("Budget authorization"), "the governor's spend cites the authorization as an advisory annotation");

  const treasuryNow = cityStats(world, "cityA").treasuryRubars as number;
  const big = runAction(world, act("service_contract_pay", "ownerA", {
    cityId: "cityA", corporationId: "corpA", amountRubars: treasuryNow + 500000, serviceRef: "harbor dredging",
  }));
  assert.equal(big.outcome, "resolved", "budget class: a shortfall resolves partially, not as a rejection");
  assert.equal(cityStats(world, "cityA").treasuryRubars, 0, "the treasury pays up to its balance and never below 0");
  assert.ok(entryTexts(big).includes("SHORTFALL"), "the unfunded remainder is logged");

  world.set("sim_cities/cityA/corporations/corpDead", {
    corporationId: "corpDead", name: "Dead Co", industry: "retail", status: "dissolved",
    valuationRubars: 0, listed: false, legacyBookRubars: null, founderFigureId: null,
    ownerMemberId: "ownerA", companyCashRubars: 0, taxPayables: {},
    homeCityId: "cityA", marketCityIds: [], linkedStructureIds: [],
    sourceActionId: "seed", sourceSeq: 1, stateVersion: 1, lastChangedSeq: 1, lastResolutionId: "seed",
  });
  expectRejected(runAction(world, act("service_contract_pay", "ownerA", {
    cityId: "cityA", corporationId: "corpDead", amountRubars: 10, serviceRef: "anything",
  })), "CORPORATION_DISSOLVED");
  console.log("ok S15: F-10 payment legs, contract-payment fact for F-06, budget-class shortfall");

  // =========================================================================
  // S16 — F-11 payroll: withholding from the derived schedule, the Exterior
  // net leg, payrollShortfall, owner-only company payroll
  // =========================================================================
  const corpCashBefore = world.get("sim_cities/cityA/corporations/corpA")?.companyCashRubars as number;
  const treasuryBeforePayroll = cityStats(world, "cityA").treasuryRubars as number;
  const payroll = runAction(world, act("run_payroll", "ownerA", {
    cityId: "cityA", corporationId: "corpA", amountRubars: 1000,
  }));
  assert.equal(payroll.outcome, "resolved");
  assert.equal(world.get("sim_cities/cityA/corporations/corpA")?.companyCashRubars, corpCashBefore - 1000, "the company pays the gross");
  assert.equal(cityStats(world, "cityA").treasuryRubars, treasuryBeforePayroll + 100, "withholding 10% (law_tax_2, 1000 bps) lands in the schedule city's treasury");
  const payrollInfo = (payroll.entries[0].classification?.payroll ?? {}) as Record<string, unknown>;
  assert.equal(payrollInfo.netRubars, 900, "net = gross − withholding");
  assert.equal(payrollInfo.exteriorAccount, "exterior:households:cityA", "the net leg names its Exterior scope — a Log line, not a doc write");
  assert.equal(payrollInfo.payrollShortfall, false);
  assert.deepEqual(payrollInfo.scheduleLawIds, ["law_tax_2"], "the schedule citation names its laws");

  const civicTreasury = cityStats(world, "cityA").treasuryRubars as number;
  const civic = runAction(world, act("run_payroll", "ownerA", {
    cityId: "cityA", payerRef: { kind: "treasury" }, amountRubars: civicTreasury + 5000,
  }));
  assert.equal(civic.outcome, "resolved");
  const civicInfo = (civic.entries[0].classification?.payroll ?? {}) as Record<string, unknown>;
  assert.equal(civicInfo.payrollShortfall, true, "a partially paid payroll is flagged in the open");
  assert.equal(civicInfo.paidGrossRubars, civicTreasury, "budget class: pays up to the balance");
  assert.equal(
    cityStats(world, "cityA").treasuryRubars,
    Math.round(civicTreasury * 0.1),
    "civic payroll nets on one doc: −gross +withholding leaves exactly the withholding"
  );

  expectRejected(runAction(world, act("run_payroll", "ownerB", {
    cityId: "cityA", corporationId: "corpA", amountRubars: 100,
  })), "NOT_COMPANY_OWNER");

  world.set("sim_cities/cityB/corporations/corpB", {
    corporationId: "corpB", name: "B Shipping", industry: "transport", status: "active",
    valuationRubars: 0, listed: false, legacyBookRubars: null, founderFigureId: null,
    ownerMemberId: "ownerB", companyCashRubars: 500, taxPayables: {},
    homeCityId: "cityB", marketCityIds: [], linkedStructureIds: [],
    sourceActionId: "seed", sourceSeq: 1, stateVersion: 1, lastChangedSeq: 1, lastResolutionId: "seed",
  });
  const noTax = runAction(world, act("run_payroll", "ownerB", {
    cityId: "cityB", corporationId: "corpB", amountRubars: 200,
  }));
  assert.equal(noTax.outcome, "resolved");
  assert.equal(world.get("sim_cities/cityB/corporations/corpB")?.companyCashRubars, 300);
  assert.ok(entryTexts(noTax).includes("skipped — cityB's schedule sets no payrollWithholding"), "unset withholding is skipped-and-logged, never a hidden default");
  console.log("ok S16: F-11 withholding from the law-derived schedule, Exterior net leg, payrollShortfall");
}

// ===========================================================================
// S17 — derived-function + phase arithmetic unit checks
// ===========================================================================
{
  assert.equal(phaseCostRubars(10000, 3, 1), 3333);
  assert.equal(phaseCostRubars(10000, 3, 2), 3333);
  assert.equal(phaseCostRubars(10000, 3, 3), 3334, "the last phase takes the remainder");
  assert.equal(phaseCostRubars(10000, 3, 1) + phaseCostRubars(10000, 3, 2) + phaseCostRubars(10000, 3, 3), 10000);
  assert.equal(isStructureFunctioning({ status: "complete", condition: 100 }), true);
  assert.equal(isStructureFunctioning({ status: "complete", condition: 99 }), false, "one point of damage stops function");
  assert.equal(isStructureFunctioning({ status: "mothballed", condition: 100 }), false);
  assert.equal(isStructureFunctioning({ status: "ruined", condition: 0 }), false);
  assert.equal(deriveLifecycle({ status: "planned" }), "planned");
  assert.equal(deriveLifecycle({ status: "under-construction" }), "under-construction");
  assert.equal(deriveLifecycle({ status: "complete", condition: 100 }), "existing");
  assert.equal(deriveLifecycle({ status: "complete", condition: 100, openProject: { projectKind: "repair" } }), "repairing", "repairing is an overlay, not a status");
  assert.equal(deriveLifecycle({ status: "demolished" }), "demolished");
  assert.equal(
    functioningHousingUnits([
      { kind: "housing", status: "complete", condition: 100, units: 5 },
      { kind: "housing", status: "complete", condition: 80, units: 3 },
      { kind: "housing", status: "mothballed", condition: 100, units: 2 },
      { kind: "commercial", status: "complete", condition: 100, units: 9 },
      { kind: "commercial", status: "complete", condition: 100, units: 4, profile: { supports: ["housing"] } },
    ]),
    9,
    "only functioning housing counts: damaged and mothballed contribute 0; mixed-use counts by supports"
  );
  console.log("ok S17: derived lifecycle/function predicate + R-05 phase arithmetic");
}

// ===========================================================================
// S18 — authority: another city's owner cannot drive these handlers
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityA", "libA", {
    name: "Grand Library", kind: "civic", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "Library", tags: [] }, supports: ["culture"] },
  });
  expectRejected(runAction(world, act("start_project", "ownerB", { cityId: "cityA", structureId: "libA" })), "AUTHORITY_REVOKED");
  expectRejected(runAction(world, act("pass_law", "ownerB", { cityId: "cityA", lawId: "law_x", structuredEffects: [] })), "AUTHORITY_REVOKED");
  assert.equal(structureDoc(world, "cityA", "libA")?.status, "planned");
  console.log("ok S18: owner authority is checked on every catalogue handler");
}

// ===========================================================================
// S19 — null discipline: an unallocated city completes with skip-and-log,
// never an invented index value (§2.4)
// ===========================================================================
{
  const world = seedWorld();
  seedStructure(world, "cityC", "shrineC", {
    name: "First Shrine", kind: "civic", status: "planned", sizeClass: "small",
    totalBudgetRubars: 0, condition: null, units: null,
    profile: { function: { statement: "A small shrine", tags: ["shrine"] }, supports: ["culture"] },
  });
  const plan = runAction(world, act("start_project", "ownerC", { cityId: "cityC", structureId: "shrineC" }));
  assert.equal(plan.outcome, "resolved", "the completion resolves; the null stats skip-and-log");
  const texts = entryTexts(plan);
  assert.ok(texts.includes("skipped: culture unset"), "index deltas skip on null, in the open");
  assert.ok(texts.includes("skipped: gdp unset"), "GDP percentages skip on null, in the open");
  const stats = cityStats(world, "cityC");
  assert.equal(stats.culture, null, "no index value was invented");
  assert.equal(stats.gdpRubars, null, "no GDP was invented");
  assert.equal(structureDoc(world, "cityC", "shrineC")?.status, "complete");
  console.log("ok S19: null-honesty — skips are Log lines, values are never invented");
}

console.log("\nCatalogue I harness: all scenarios passed (every resolved plan passed validatePlan incl. F-02 reconciliation).");
