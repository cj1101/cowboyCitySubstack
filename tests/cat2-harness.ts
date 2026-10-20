/**
 * Catalogue II harness (Phase 4 step 6) — a pure (snapshot, action) →
 * plan battery over lib/sim/rules/businesses.ts, in the cat1-harness
 * mold: handlers are pure, so the battery fabricates snapshots, calls
 * the handlers through their descriptors' read plans (the F-01
 * contract, materialized here against an in-memory world), and runs
 * every resolved plan through the REAL validatePlan — with the
 * business (and finance) descriptors registered into RULE_DESCRIPTORS
 * in-process, exactly the merge the Build Lead's assembly edit will
 * perform in registry.ts.
 *
 * Beyond plan validity, resolved money events are ALSO run through
 * the REAL finance conservation checker (lib/finance/conservation.ts)
 * over the plan's entries + writeSet — the module's claim is that its
 * events are conservation-checkable unchanged, and this battery proves
 * it rather than asserting it.
 *
 * Run: npx tsx tests/cat2-harness.ts
 */

import assert from "node:assert/strict";
import { checkConservationEvent, type ConservationEvent } from "../lib/finance/conservation";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildCorporationDoc } from "../lib/sim/corporations";
import {
  collectActionReadPaths,
  finalizePlan,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { RULE_DESCRIPTORS, type RuleDescriptor } from "../lib/sim/rules/registry";
import { FINANCE_DESCRIPTORS } from "../lib/sim/rules/finance";
import {
  BUSINESS_DESCRIPTORS,
  composeTaxAssessment,
  type TaxableFact,
} from "../lib/sim/rules/businesses";
import {
  emptyPlan,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
  type SnapshotQueryRecord,
} from "../lib/sim/state";

// The Lead's assembly, simulated: register both family maps.
Object.assign(RULE_DESCRIPTORS, FINANCE_DESCRIPTORS, BUSINESS_DESCRIPTORS);

const ALL_DESCRIPTORS: Record<string, RuleDescriptor> = {
  ...FINANCE_DESCRIPTORS,
  ...BUSINESS_DESCRIPTORS,
};
const KIND_TO_DESCRIPTOR: Record<string, RuleDescriptor> = {};
for (const descriptor of Object.values(ALL_DESCRIPTORS)) {
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
  const actionId = `act_cat2_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "cat2-harness",
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

function materialize(
  world: World,
  action: SimAction,
  descriptor: RuleDescriptor
): SimSnapshot {
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
    queryRecords.push({ spec, resultPaths, digest: "cat2-harness" });
  }
  return snapshotFromDocs(docs, NOW, queryRecords);
}

function applyPlan(world: World, plan: ResolutionPlan): void {
  for (const write of plan.writes) {
    if (write.op === "delete") world.delete(write.path);
    else world.set(write.path, write.afterDoc as Record<string, unknown>);
  }
}

/** Run an action through its descriptor's handler; validate resolved
 * plans with the real validatePlan; apply writes to the world; and
 * prove the event conservation-clean with the real checker. */
function runAction(world: World, action: SimAction, prepared?: PreparedPayload): ResolutionPlan {
  const descriptor = KIND_TO_DESCRIPTOR[action.actionType];
  assert.ok(descriptor, `no business/finance descriptor classifies ${action.actionType}`);
  const handler = descriptor.handlers[action.actionType];
  assert.ok(handler, `descriptor ${descriptor.id} has no handler for ${action.actionType}`);
  const beforeWorld: World = new Map(world);
  const snapshot = materialize(world, action, descriptor);
  const plan = handler({
    snapshot,
    action,
    resolutionId: action.actionId,
    prepared,
    baselineRegistry: fixtureRegistry,
    citableBaseline: null,
    citations: {},
  });
  plan.descriptorId = descriptor.id;
  if (plan.outcome === "resolved") {
    validatePlan(plan, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot });
    finalizePlan(plan);
    assert.ok(plan.planHash.length > 0, "finalized plan carries a hash");
    assertConservation(beforeWorld, plan, action.actionId);
    applyPlan(world, plan);
  }
  return plan;
}

/** The conservation proof: the plan's entries + writeSet, checked by
 * the finance checker exactly as the standing verifier runs it. */
function assertConservation(beforeWorld: World, plan: ResolutionPlan, resolutionId: string): void {
  const event: ConservationEvent = {
    resolutionId,
    entries: plan.entries.map((entry) => ({
      seq: undefined,
      cityId: entry.cityId,
      ruleIds: entry.ruleIds,
      changes: entry.changes.map((c) => ({ field: c.field, before: c.before, after: c.after })),
    })),
    writeSet: plan.writes.map((write) => ({
      path: write.path,
      op: write.op,
      beforeDoc: beforeWorld.get(write.path) ?? null,
      afterDoc: write.afterDoc ?? null,
    })),
  };
  const result = checkConservationEvent(event, { loans: [] });
  assert.ok(
    result.ok,
    `conservation findings for ${resolutionId}: ${result.findings.map((f) => `${f.code}: ${f.message}`).join(" | ")}`
  );
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code, `expected rejection code ${code}, got ${plan.rejection?.code}`);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
}

const entryTexts = (plan: ResolutionPlan): string => plan.entries.map((e) => e.summaryText).join("\n");

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------

function cityDoc(stats: Record<string, unknown>): Record<string, unknown> {
  return {
    stats: {
      spirit: 50, culture: 40, infrastructure: 50, stability: 60, law: 30,
      influence: 20, military: 40, defense: 35,
      households: 0, housingUnits: 0, treasuryRubars: 100000,
      population: 100, gdpRubars: 1000000,
      ...stats,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  };
}

function seedWorld(): World {
  const world: World = new Map();
  world.set("sim_counters/log", { lastSeq: 100, lastEntryHash: "ab".repeat(32) });
  world.set("sim_world/current", { lastCommittedSeq: 100 });
  world.set("factions/cityA", { name: "Fixture City A", slug: "fixture-a", ownerUids: ["ownerA"] });
  world.set("factions/cityB", { name: "Fixture City B", slug: "fixture-b", ownerUids: ["ownerB"] });
  world.set("factions/cityC", { name: "Fixture City C", slug: "fixture-c", ownerUids: ["ownerC"] });
  // City A: ownerA's city — GDP 1,000,000, treasury 100,000.
  world.set("sim_cities/cityA", { factionId: "cityA", ...cityDoc({}) });
  // City B: ownerB's city — GDP 500,000, treasury 5,000.
  world.set("sim_cities/cityB", { factionId: "cityB", ...cityDoc({ gdpRubars: 500000, treasuryRubars: 5000, population: 50 }) });
  // City C: the even-start template — indices and GDP null.
  world.set("sim_cities/cityC", {
    factionId: "cityC",
    ...cityDoc({
      spirit: null, culture: null, infrastructure: null, stability: null, law: null,
      influence: null, military: null, defense: null,
      treasuryRubars: 0, population: null, gdpRubars: null,
    }),
  });
  return world;
}

function seedAccount(world: World, memberId: string, cashRubars: number): void {
  world.set(`sim_member_accounts/${memberId}`, {
    memberId,
    cashRubars,
    status: "open",
    genesisGrant: { amountRubars: 250000, grantedAtSeq: 1, grantEntryId: "sim_log_entries/000000000001" },
    openedAtSeq: 1,
    openedVia: "explicit",
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdAt: null,
    updatedAt: null,
  });
}

function seedCorp(
  world: World,
  args: {
    homeCityId: string;
    corporationId: string;
    ownerMemberId: string;
    valuationRubars?: number;
    listed?: boolean;
    companyCashRubars?: number;
    taxPayables?: Record<string, number>;
    marketCityIds?: string[];
    linkedStructureIds?: string[];
    industry?: string;
    status?: string;
  }
): string {
  const path = `sim_cities/${args.homeCityId}/corporations/${args.corporationId}`;
  const doc: Record<string, unknown> = {
    ...buildCorporationDoc({
      corporationId: args.corporationId,
      name: `${args.corporationId} Co`,
      industry: args.industry ?? "industrial",
      ownerMemberId: args.ownerMemberId,
      founderFigureId: null,
      homeCityId: args.homeCityId,
      marketCityIds: args.marketCityIds ?? [],
      valuationRubars: args.valuationRubars ?? 20080,
      legacyBookRubars: args.valuationRubars ?? 20080,
      sourceActionId: "seed",
      sourceSeq: 1,
      lastResolutionId: "seed",
      now: new Date(NOW),
    }),
    listed: args.listed ?? false,
    status: args.status ?? "active",
    companyCashRubars: args.companyCashRubars ?? 0,
    taxPayables: args.taxPayables ?? {},
    linkedStructureIds: args.linkedStructureIds ?? [],
    paidInCapitalRubars: args.listed ? 100000 : 0,
    sharesOutstanding: args.listed ? 1000 : 0,
    openingReferencePriceRubars: args.listed ? 140 : null,
    lastJudgment: args.listed ? { quality: 80, scale: 60, importance: 40, inputHash: "seed" } : null,
  };
  world.set(path, doc);
  return path;
}

function seedStructure(
  world: World,
  cityId: string,
  structureId: string,
  args: { kind: string; status?: string; condition?: number; supports?: string[] }
): void {
  world.set(`sim_cities/${cityId}/structures/${structureId}`, {
    structureId,
    name: structureId,
    kind: args.kind,
    status: args.status ?? "complete",
    condition: args.condition ?? 100,
    profile: { supports: args.supports ?? [] },
    sourceActionId: "seed",
    sourceSeq: 1,
  });
}

function seedLaw(
  world: World,
  cityId: string,
  lawId: string,
  sourceSeq: number,
  effects: { field: string; value: number | null }[]
): void {
  world.set(`sim_cities/${cityId}/laws/${lawId}`, {
    lawId,
    cityId,
    status: "in-force",
    sourceSeq,
    structuredEffects: effects.map((e) => ({ field: e.field, operation: "set", value: e.value })),
  });
}

function cityStats(world: World, cityId: string): Record<string, unknown> {
  return world.get(`sim_cities/${cityId}`)?.stats as Record<string, unknown>;
}

function corpDoc(world: World, homeCityId: string, corporationId: string): Record<string, unknown> {
  const doc = world.get(`sim_cities/${homeCityId}/corporations/${corporationId}`);
  assert.ok(doc, `corporation ${corporationId} stands in ${homeCityId}`);
  return doc;
}

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

// ---------------------------------------------------------------------------
// R-06 — founding, unlisted branch
// ---------------------------------------------------------------------------

check("R-06 unlisted: GDP +0.4% applies first, book = round(2% of the new GDP)", () => {
  const world = seedWorld();
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corp1", name: "Anvil Works", industry: "industrial",
  }));
  assert.equal(plan.outcome, "resolved");
  // 1,000,000 -> +0.4% -> 1,004,000; book = round(2% x 1,004,000) = 20,080.
  assert.equal(cityStats(world, "cityA").gdpRubars, 1004000);
  const corp = corpDoc(world, "cityA", "corp1");
  assert.equal(corp.valuationRubars, 20080);
  assert.equal(corp.legacyBookRubars, 20080);
  assert.equal(corp.listed, false);
  assert.equal(corp.ownerMemberId, "ownerA");
  assert.equal(corp.companyCashRubars, 0);
});

check("R-06 unlisted, GDP null: every GDP-derived figure skips and logs; book null, valuation 0", () => {
  const world = seedWorld();
  const plan = runAction(world, act("found_corporation", "ownerC", {
    cityId: "cityC", corporationId: "corpNull", name: "Null Co", industry: "services",
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityC").gdpRubars, null);
  const corp = corpDoc(world, "cityC", "corpNull");
  assert.equal(corp.valuationRubars, 0);
  assert.equal(corp.legacyBookRubars, null);
  assert.ok(entryTexts(plan).includes("skipped: gdp unset"), "the skip is stated in the Log");
});

check("R-06 synergy: a completed structure matching the industry adds +0.2%, stated separately, after the book", () => {
  const world = seedWorld();
  seedStructure(world, "cityA", "factory1", { kind: "industrial" });
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpSyn", name: "Synergy Co", industry: "industrial",
  }));
  assert.equal(plan.outcome, "resolved");
  // 1,000,000 -> 1,004,000 (+0.4%) -> book 20,080 -> +0.2% synergy -> 1,006,008.
  assert.equal(cityStats(world, "cityA").gdpRubars, 1006008);
  assert.equal(corpDoc(world, "cityA", "corpSyn").valuationRubars, 20080);
  const founding = plan.entries.find((e) => e.recordsCreated.length > 0);
  const gdpChanges = founding?.changes.filter((c) => c.field === "stats.gdpRubars") ?? [];
  assert.equal(gdpChanges.length, 2, "the synergy is a separate change line, not folded into the base effect");
  assert.ok(entryTexts(plan).includes("industry synergy"), "the synergy is stated separately in the Log");
});

check("R-06 synergy: a non-functioning structure (damaged) matches nothing", () => {
  const world = seedWorld();
  seedStructure(world, "cityA", "factoryHurt", { kind: "industrial", condition: 40 });
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpNoSyn", name: "No Synergy Co", industry: "industrial",
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityA").gdpRubars, 1004000, "base +0.4% only");
});

check("R-06 second city: confirmed naming takes +0.2% there and joins marketCityIds; unconfirmed takes no effect", () => {
  const world = seedWorld();
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpHQ2", name: "Two City Co", industry: "trade",
    secondCityId: "cityB", secondCityConfirmationRef: "res_conf_1",
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityB").gdpRubars, 501000); // 500,000 + 0.2%
  assert.deepEqual(corpDoc(world, "cityA", "corpHQ2").marketCityIds, ["cityB"]);

  const world2 = seedWorld();
  const plan2 = runAction(world2, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpHQ2x", name: "Two City Co", industry: "trade",
    secondCityId: "cityB",
  }));
  assert.equal(plan2.outcome, "resolved");
  assert.equal(cityStats(world2, "cityB").gdpRubars, 500000, "no effect without the other owner's confirmation");
  assert.deepEqual(corpDoc(world2, "cityA", "corpHQ2x").marketCityIds, []);
  assert.ok(entryTexts(plan2).includes("cross-city draft rule"), "the non-effect is explained in the Log");
});

check("R-06: a duplicate founding rejects; a founding by a non-member rejects", () => {
  const world = seedWorld();
  runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpDup", name: "Dup Co", industry: "trade",
  }));
  expectRejected(
    runAction(world, act("found_corporation", "ownerA", {
      cityId: "cityA", corporationId: "corpDup", name: "Dup Co", industry: "trade",
    })),
    "corporation-already-exists"
  );
});

// ---------------------------------------------------------------------------
// R-06 — founding, listed branch (bundled M-01)
// ---------------------------------------------------------------------------

const judgmentPayload = (quality: number, scale: number, importance: number): PreparedPayload => ({
  classification: { judgment: { quality, scale, importance } },
  inputHash: "harness-judgment-1",
});

check("R-06 listed: book skipped (legacyBook is provenance), cap = round(paid-in x multiplier), cash moves, judgment from the payload only", () => {
  const world = seedWorld();
  seedAccount(world, "ownerA", 300000);
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpList", name: "Listed Co", industry: "industrial",
    listAtFounding: true, paidInCapitalRubars: 100000, sharesIssued: 1000, fundingSource: "personal",
  }), judgmentPayload(80, 60, 40));
  assert.equal(plan.outcome, "resolved");
  const corp = corpDoc(world, "cityA", "corpList");
  assert.equal(corp.listed, true);
  // legacyBook: the unlisted formula's result (GDP after +0.4%: 1,004,000 -> 20,080) — provenance only.
  assert.equal(corp.legacyBookRubars, 20080);
  // multiplier = 0.5 + (80+60+40)/200 = 1.4; cap = round(100,000 x 1.4) = 140,000; price = round(140,000/1,000) = 140.
  assert.equal(corp.valuationRubars, 140000);
  assert.equal(corp.openingReferencePriceRubars, 140);
  assert.equal(corp.sharesOutstanding, 1000);
  assert.equal(corp.paidInCapitalRubars, 100000);
  assert.equal(corp.companyCashRubars, 100000);
  assert.equal(world.get("sim_member_accounts/ownerA")?.cashRubars, 200000);
  assert.notEqual(corp.valuationRubars, corp.legacyBookRubars, "the listed valuation never comes from the book formula");
});

check("R-06 listed: no prepared payload -> judgment-required, even if the ACTION names scores (the action is never read for judgment)", () => {
  const world = seedWorld();
  seedAccount(world, "ownerA", 300000);
  expectRejected(
    runAction(world, act("found_corporation", "ownerA", {
      cityId: "cityA", corporationId: "corpNoJ", name: "No Judgment Co", industry: "industrial",
      listAtFounding: true, paidInCapitalRubars: 100000, sharesIssued: 1000,
      judgment: { quality: 100, scale: 100, importance: 100 },
    })),
    "judgment-required"
  );
  assert.equal(world.get("sim_cities/cityA/corporations/corpNoJ"), undefined, "no half-founded shell stands");
});

check("R-06 listed: treasury-sourced paid-in capital rejects under P4-K21(ii)", () => {
  const world = seedWorld();
  seedAccount(world, "ownerA", 300000);
  expectRejected(
    runAction(world, act("found_corporation", "ownerA", {
      cityId: "cityA", corporationId: "corpTreas", name: "Treasury Co", industry: "industrial",
      listAtFounding: true, paidInCapitalRubars: 100000, sharesIssued: 1000, fundingSource: "treasury",
    }), judgmentPayload(50, 50, 50)),
    "treasury-source-suspended"
  );
});

check("R-06 listed with a fresh founder: the genesis grant lazy-opens first and the event stays conservation-clean", () => {
  const world = seedWorld();
  const plan = runAction(world, act("found_corporation", "newMember", {
    cityId: "cityA", corporationId: "corpFresh", name: "Fresh Co", industry: "trade",
    listAtFounding: true, paidInCapitalRubars: 50000, sharesIssued: 500, fundingSource: "personal",
  }), judgmentPayload(50, 50, 50));
  assert.equal(plan.outcome, "resolved");
  // Grant 250,000 minted (F-01), then 50,000 of paid-in capital moves.
  assert.equal(world.get("sim_member_accounts/newMember")?.cashRubars, 200000);
  assert.equal(corpDoc(world, "cityA", "corpFresh").companyCashRubars, 50000);
  // runAction already ran the real conservation checker over this event (mint leg included).
});

// ---------------------------------------------------------------------------
// R-07 — unlisted verbs
// ---------------------------------------------------------------------------

check("R-07 Expand unlisted, fully funded: valuation x1.25, GDP +0.2%, treasury pays the budget", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", valuationRubars: 20080 });
  const plan = runAction(world, act("expand_corporation", "ownerA", {
    corporationId: "corpU", homeCityId: "cityA", expansionBudgetRubars: 10000,
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(corpDoc(world, "cityA", "corpU").valuationRubars, 25100); // round(20,080 x 1.25)
  assert.equal(cityStats(world, "cityA").treasuryRubars, 90000);
  assert.equal(cityStats(world, "cityA").gdpRubars, 1002000); // +0.2%
});

check("R-07 Expand unlisted, shortfall: the paid portion moves, the step does NOT fire, the shortfall logs (R-05 funded-gate)", () => {
  const world = seedWorld();
  // City B's treasury holds 5,000; the budget is 10,000.
  seedCorp(world, { homeCityId: "cityB", corporationId: "corpB1", ownerMemberId: "ownerB", valuationRubars: 10000 });
  const plan = runAction(world, act("expand_corporation", "ownerB", {
    corporationId: "corpB1", homeCityId: "cityB", expansionBudgetRubars: 10000,
  }));
  assert.equal(plan.outcome, "resolved", "a budget-class shortfall resolves partially funded — it is not a rejection");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 0);
  assert.equal(corpDoc(world, "cityB", "corpB1").valuationRubars, 10000, "no multiplier on a partially funded expansion");
  assert.equal(cityStats(world, "cityB").gdpRubars, 500000, "no GDP effect on a partially funded expansion");
  assert.ok(entryTexts(plan).includes("SHORTFALL 5000"), "the shortfall is stated in the Log");
});

check("R-07 Expand unlisted (corpCrossB): an owner who does not govern the home city cannot spend its treasury", () => {
  const world = seedWorld();
  // corpCrossB: owner member = ownerA; home city = cityB (ownerB's); operating elsewhere.
  seedCorp(world, { homeCityId: "cityB", corporationId: "corpCrossB", ownerMemberId: "ownerA", valuationRubars: 10000 });
  expectRejected(
    runAction(world, act("expand_corporation", "ownerA", {
      corporationId: "corpCrossB", homeCityId: "cityB", expansionBudgetRubars: 1000,
    })),
    "not-city-governor"
  );
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5000, "the foreign treasury is untouched");
});

check("R-07 Contract unlisted: valuation x0.8, GDP -0.2%, status contracted", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", valuationRubars: 20080 });
  const plan = runAction(world, act("contract_corporation", "ownerA", {
    corporationId: "corpU", homeCityId: "cityA",
  }));
  assert.equal(plan.outcome, "resolved");
  const corp = corpDoc(world, "cityA", "corpU");
  assert.equal(corp.valuationRubars, 16064); // round(20,080 x 0.8)
  assert.equal(corp.status, "contracted");
  assert.equal(cityStats(world, "cityA").gdpRubars, 998000);
});

check("R-07 Relocate unlisted: record moves, x1.1 after the move, home -0.2% / destination +0.1%; unconfirmed rejects", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", valuationRubars: 20080 });
  expectRejected(
    runAction(world, act("relocate_corporation", "ownerA", {
      corporationId: "corpU", homeCityId: "cityA", destinationCityId: "cityB",
    })),
    "destination-unconfirmed"
  );
  const plan = runAction(world, act("relocate_corporation", "ownerA", {
    corporationId: "corpU", homeCityId: "cityA", destinationCityId: "cityB", destinationConfirmationRef: "res_conf_9",
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(world.get("sim_cities/cityA/corporations/corpU"), undefined, "the record leaves the old home's subcollection");
  const moved = corpDoc(world, "cityB", "corpU");
  assert.equal(moved.homeCityId, "cityB");
  assert.equal(moved.valuationRubars, 22088); // round(20,080 x 1.1)
  assert.equal(moved.status, "relocated");
  assert.equal(cityStats(world, "cityA").gdpRubars, 998000);
  assert.equal(cityStats(world, "cityB").gdpRubars, 500500); // +0.1% (half rate)
});

check("R-07 Dissolve unlisted: valuation -> 0, GDP -0.3%, spirit -1 at home and in each named third city", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", valuationRubars: 20080 });
  const plan = runAction(world, act("dissolve_corporation", "ownerA", {
    corporationId: "corpU", homeCityId: "cityA", affectedCityIds: ["cityB"],
  }));
  assert.equal(plan.outcome, "resolved");
  const corp = corpDoc(world, "cityA", "corpU");
  assert.equal(corp.valuationRubars, 0);
  assert.equal(corp.status, "dissolved");
  assert.equal(cityStats(world, "cityA").gdpRubars, 997000);
  assert.equal(cityStats(world, "cityA").spirit, 49);
  assert.equal(cityStats(world, "cityB").spirit, 49, "the third city named in the action record takes spirit -1");
});

check("R-07: a non-owner cannot act on a corporation; a dissolved corporation takes no action", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA" });
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpDead", ownerMemberId: "ownerA", status: "dissolved", valuationRubars: 0 });
  expectRejected(
    runAction(world, act("contract_corporation", "ownerB", { corporationId: "corpU", homeCityId: "cityA" })),
    "not-company-owner"
  );
  expectRejected(
    runAction(world, act("contract_corporation", "ownerA", { corporationId: "corpDead", homeCityId: "cityA" })),
    "company-dissolved"
  );
});

// ---------------------------------------------------------------------------
// R-07 — listed branch (P4-K18/K22)
// ---------------------------------------------------------------------------

check("R-07 Expand listed: the budget lands in company cash, footprint inputs land, valuation is NEVER touched", () => {
  const world = seedWorld();
  seedAccount(world, "ownerA", 300000);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA",
    listed: true, valuationRubars: 140000, companyCashRubars: 5000,
  });
  seedStructure(world, "cityA", "plant1", { kind: "industrial" });
  const plan = runAction(world, act("expand_corporation", "ownerA", {
    corporationId: "corpL", homeCityId: "cityA", expansionBudgetRubars: 20000,
    fundingSource: "personal", addMarketCityIds: ["cityB"], addLinkedStructureIds: ["plant1"],
  }));
  assert.equal(plan.outcome, "resolved");
  const corp = corpDoc(world, "cityA", "corpL");
  assert.equal(corp.companyCashRubars, 25000);
  assert.equal(corp.valuationRubars, 140000, "no multiplier, no repricing — M-06 is the only valuation writer, invoked in-event");
  assert.deepEqual(corp.marketCityIds, ["cityB"]);
  assert.deepEqual(corp.linkedStructureIds, ["plant1"]);
  const verb = plan.entries.find((e) => e.classification && typeof e.classification === "object" && "corporationAction" in e.classification);
  assert.deepEqual((verb?.classification as Record<string, unknown>).invokesRules, ["M-06"]);
  assert.equal(world.get("sim_member_accounts/ownerA")?.cashRubars, 280000);
});

check("R-07 Contract listed, contentless: rejected and logged as contentless", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA", listed: true, valuationRubars: 140000 });
  expectRejected(
    runAction(world, act("contract_corporation", "ownerA", { corporationId: "corpL", homeCityId: "cityA" })),
    "contentless-contract"
  );
});

check("R-07 Contract listed with input changes: records land, GDP -0.2%, valuation untouched", () => {
  const world = seedWorld();
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA",
    listed: true, valuationRubars: 140000, marketCityIds: ["cityB"], linkedStructureIds: ["plant1"],
  });
  const plan = runAction(world, act("contract_corporation", "ownerA", {
    corporationId: "corpL", homeCityId: "cityA", exitMarketCityIds: ["cityB"], unlinkStructureIds: ["plant1"],
  }));
  assert.equal(plan.outcome, "resolved");
  const corp = corpDoc(world, "cityA", "corpL");
  assert.deepEqual(corp.marketCityIds, []);
  assert.deepEqual(corp.linkedStructureIds, []);
  assert.equal(corp.valuationRubars, 140000);
  assert.equal(cityStats(world, "cityA").gdpRubars, 998000);
});

check("R-07 Contract listed with a cash leg: rejects whole — the leg routes through M-08/M-09 (P4-K22), never a bare withdrawal", () => {
  const world = seedWorld();
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA",
    listed: true, valuationRubars: 140000, companyCashRubars: 50000, marketCityIds: ["cityB"],
  });
  expectRejected(
    runAction(world, act("contract_corporation", "ownerA", {
      corporationId: "corpL", homeCityId: "cityA", exitMarketCityIds: ["cityB"], cashWithdrawalRubars: 10000,
    })),
    "cash-leg-requires-market-module"
  );
  const corp = corpDoc(world, "cityA", "corpL");
  assert.equal(corp.companyCashRubars, 50000, "no cash moved — and no disguised withdrawal occurred");
  assert.deepEqual(corp.marketCityIds, ["cityB"], "the action rejected whole; its other legs did not half-land");
});

check("R-07 Dissolve listed: rejects whole — dissolution is M-10 liquidation, never the x0 book path", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA", listed: true, valuationRubars: 140000 });
  expectRejected(
    runAction(world, act("dissolve_corporation", "ownerA", { corporationId: "corpL", homeCityId: "cityA" })),
    "liquidation-requires-market-module"
  );
  assert.equal(corpDoc(world, "cityA", "corpL").status, "active");
  assert.equal(corpDoc(world, "cityA", "corpL").valuationRubars, 140000);
});

check("R-07 Relocate listed: the record moves and city effects land; no x1.1 exists in the listed branch", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA", listed: true, valuationRubars: 140000 });
  const plan = runAction(world, act("relocate_corporation", "ownerA", {
    corporationId: "corpL", homeCityId: "cityA", destinationCityId: "cityB", destinationConfirmationRef: "res_conf_2",
  }));
  assert.equal(plan.outcome, "resolved");
  const moved = corpDoc(world, "cityB", "corpL");
  assert.equal(moved.valuationRubars, 140000, "unchanged — no multiplier and no in-module repricing");
  assert.equal(moved.homeCityId, "cityB");
});

// ---------------------------------------------------------------------------
// F-06 — the assessment composer, driven directly (it is a resolver
// step: citing rules compose it into their own events; the Lead wires
// Catalogue I's F-10 invocation — flag F5). The drive below plays the
// citing handler: it composes the assessment, finishes the plan with
// a summary, and runs the same validatePlan + conservation proof.
// ---------------------------------------------------------------------------

function snapshotForFact(world: World, lawCityIds: string[]): SimSnapshot {
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const [path, doc] of world) docs.set(path, doc);
  const queryRecords: SnapshotQueryRecord[] = lawCityIds.map((cityId) => {
    const prefix = `sim_cities/${cityId}/laws/`;
    const resultPaths = [...world.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .sort();
    return {
      spec: { id: "cat2-laws", collectionPath: `sim_cities/${cityId}/laws`, filters: [] },
      resultPaths,
      digest: "cat2-harness",
    };
  });
  return snapshotFromDocs(docs, NOW, queryRecords);
}

function runAssessment(
  world: World,
  fact: TaxableFact,
  lawCityIds?: string[]
): { outcome: ReturnType<typeof composeTaxAssessment>; plan: ResolutionPlan } {
  const snapshot = snapshotForFact(world, lawCityIds ?? [fact.operatingCityId]);
  const beforeWorld: World = new Map(world);
  const plan = emptyPlan("F-06");
  const outcome = composeTaxAssessment({
    plan,
    snapshot,
    actor: memberActor("ownerA"),
    citingRuleId: "F-10",
    fact,
  });
  if (plan.entries.length > 0) {
    plan.entries.push({
      kind: "action-summary",
      summary: true,
      actor: memberActor("ownerA"),
      actionId: "act_f06_drive",
      actionText: "F-06 drive (harness)",
      classification: { verb: "service-contract", scope: "city", ruleIds: ["F-10"], unruled: false },
      cityId: fact.homeCityId,
      cityIds: [fact.homeCityId, fact.operatingCityId],
      ruleIds: ["F-10"],
      changes: [],
      spilloverFromSeq: null,
      causedBySeq: null,
      correctsSeq: null,
      recordsCreated: [],
      recordsUpdated: [],
      legal: null,
      chronicleDraftId: null,
      major: false,
      summaryText: "F-06 drive summary (harness).",
      visibility: "public",
      baseline: null,
      pendingId: null,
      generation: null,
    });
    plan.descriptorId = "F-06";
    validatePlan(plan, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot });
    finalizePlan(plan);
    assertConservation(beforeWorld, plan, "f06-drive");
    applyPlan(world, plan);
  }
  return { outcome, plan };
}

check("F-06 operating-credit, cross-city (corpCrossB): the OPERATING city's schedule governs, its treasury is paid, the remainder becomes its payable", () => {
  const world = seedWorld();
  // Home cityA (ownerA's corp), operating cityB with a 5% receipts law.
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpCrossB", ownerMemberId: "ownerA", companyCashRubars: 300 });
  seedLaw(world, "cityB", "law_b_tax", 1, [{ field: "tax.operatingReceiptsBps", value: 500 }]);
  const { outcome } = runAssessment(world, {
    kind: "operating-credit", corporationId: "corpCrossB", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000,
  });
  assert.equal(outcome.status, "assessed");
  assert.equal(outcome.assessedRubars, 500); // round(10,000 x 500/10,000)
  assert.equal(outcome.collectedRubars, 300, "collection never takes company cash below zero");
  assert.equal(outcome.payableDeltaRubars, 200);
  const corp = corpDoc(world, "cityA", "corpCrossB");
  assert.equal(corp.companyCashRubars, 0);
  assert.deepEqual(corp.taxPayables, { cityB: 200 }, "the payable is keyed to the operating (creditor) city, not the home city");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5300);
  assert.equal(cityStats(world, "cityA").treasuryRubars, 100000, "the home city's treasury is not involved in an operating-city fact");
});

check("F-06: a second assessment against an empty till collects nothing and the payable accumulates — never forgiven, never aged", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpCrossB", ownerMemberId: "ownerA", companyCashRubars: 300 });
  seedLaw(world, "cityB", "law_b_tax", 1, [{ field: "tax.operatingReceiptsBps", value: 500 }]);
  runAssessment(world, { kind: "operating-credit", corporationId: "corpCrossB", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000 });
  const { outcome } = runAssessment(world, {
    kind: "operating-credit", corporationId: "corpCrossB", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000,
  });
  assert.equal(outcome.collectedRubars, 0);
  assert.equal(outcome.payableAfterRubars, 700);
  assert.deepEqual(corpDoc(world, "cityA", "corpCrossB").taxPayables, { cityB: 700 });
});

check("F-06 schedule unset: skipped and logged honestly — nothing assessed, nothing written", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", companyCashRubars: 1000 });
  const { outcome, plan } = runAssessment(world, {
    kind: "operating-credit", corporationId: "corpU", homeCityId: "cityA", operatingCityId: "cityC", baseAmountRubars: 10000,
  });
  assert.equal(outcome.status, "skipped-unset");
  assert.equal(outcome.note, "skipped: tax schedule unset");
  assert.equal(plan.writes.length, 0);
  assert.ok(entryTexts(plan).includes("skipped: tax schedule unset"));
  assert.equal(corpDoc(world, "cityA", "corpU").companyCashRubars, 1000);
});

check("F-06 at a 0 rate: assessed 0 is a stated figure, not a skip", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", companyCashRubars: 1000 });
  seedLaw(world, "cityB", "law_b_zero", 1, [{ field: "tax.operatingReceiptsBps", value: 0 }]);
  const { outcome } = runAssessment(world, {
    kind: "operating-credit", corporationId: "corpU", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000,
  });
  assert.equal(outcome.status, "assessed");
  assert.equal(outcome.assessedRubars, 0);
  assert.equal(outcome.rateBps, 0);
});

check("F-06 contract-payment facts read the contractPaymentsBps component (the F-10-shaped fact, composed as the Lead wiring will)", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", companyCashRubars: 10000 });
  seedLaw(world, "cityB", "law_b_contract", 1, [
    { field: "tax.operatingReceiptsBps", value: 500 },
    { field: "tax.contractPaymentsBps", value: 1000 },
  ]);
  const { outcome } = runAssessment(world, {
    kind: "contract-payment", corporationId: "corpU", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 4000,
  });
  assert.equal(outcome.assessedRubars, 400, "10% contract-payments component — not the 5% receipts component");
  assert.equal(outcome.collectedRubars, 400);
  assert.equal(outcome.payableDeltaRubars, 0);
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5400);
});

check("F-06 payroll facts read the payrollWithholdingBps component", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", companyCashRubars: 10000 });
  seedLaw(world, "cityA", "law_a_payroll", 1, [{ field: "tax.payrollWithholdingBps", value: 250 }]);
  const { outcome } = runAssessment(world, {
    kind: "payroll", corporationId: "corpU", homeCityId: "cityA", operatingCityId: "cityA", baseAmountRubars: 20000,
  });
  assert.equal(outcome.assessedRubars, 500);
  assert.equal(outcome.collectedRubars, 500);
  assert.equal(cityStats(world, "cityA").treasuryRubars, 100500);
});

check("F-06 with the operating city's laws never materialized: unreadable — an unread schedule is never reported as an unset one", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA", companyCashRubars: 1000 });
  const { outcome, plan } = runAssessment(world, {
    kind: "operating-credit", corporationId: "corpU", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000,
  }, []);
  assert.equal(outcome.status, "unreadable");
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.entries.length, 0, "no Log entry pretends an assessment happened");
});

// ---------------------------------------------------------------------------
// F-07 — pay a tax payable
// ---------------------------------------------------------------------------

check("F-07: partial payment reduces the payable; full payment removes the key and lifts the blocks in the same event", () => {
  const world = seedWorld();
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpTax", ownerMemberId: "ownerA",
    companyCashRubars: 1000, taxPayables: { cityB: 200 },
  });
  const plan1 = runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityB", amountRubars: 120,
  }));
  assert.equal(plan1.outcome, "resolved");
  let corp = corpDoc(world, "cityA", "corpTax");
  assert.equal(corp.companyCashRubars, 880);
  assert.deepEqual(corp.taxPayables, { cityB: 80 });
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5120);

  const plan2 = runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityB", amountRubars: 80,
  }));
  assert.equal(plan2.outcome, "resolved");
  corp = corpDoc(world, "cityA", "corpTax");
  assert.deepEqual(corp.taxPayables, {}, "the key is removed at zero — absent and zero never differ");
  assert.ok(entryTexts(plan2).includes("blocks"), "the Log states the §5.3 blocks lift in this same event");
});

check("F-07: overpayment, a nonexistent payable, a non-owner, and short cash each reject with the payable standing", () => {
  const world = seedWorld();
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpTax", ownerMemberId: "ownerA",
    companyCashRubars: 50, taxPayables: { cityB: 200 },
  });
  expectRejected(runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityB", amountRubars: 201,
  })), "exceeds-payable");
  expectRejected(runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityC", amountRubars: 10,
  })), "no-such-payable");
  expectRejected(runAction(world, act("pay_tax_arrears", "ownerB", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityB", amountRubars: 10,
  })), "not-company-owner");
  expectRejected(runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpTax", homeCityId: "cityA", cityId: "cityB", amountRubars: 120,
  })), "insufficient-funds");
  const corp = corpDoc(world, "cityA", "corpTax");
  assert.deepEqual(corp.taxPayables, { cityB: 200 }, "the payable stands, unforgiven, after every refusal");
  assert.equal(corp.companyCashRubars, 50);
});

check("F-07 (corpCrossB): owner, home city, and creditor city are three separate facts and each is read in its own role", () => {
  const world = seedWorld();
  // Record stands in cityB; owner is ownerA; the payable is owed to cityA.
  seedCorp(world, {
    homeCityId: "cityB", corporationId: "corpCrossB", ownerMemberId: "ownerA",
    companyCashRubars: 500, taxPayables: { cityA: 300 },
  });
  const plan = runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpCrossB", homeCityId: "cityB", cityId: "cityA", amountRubars: 300,
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(cityStats(world, "cityA").treasuryRubars, 100300, "the creditor city's treasury is paid");
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5000, "the home city's treasury is not the creditor here");
  assert.deepEqual(corpDoc(world, "cityB", "corpCrossB").taxPayables, {});
});

check("the end-to-end arrears story: assessment in cityB -> payable -> owner pays it down under F-07", () => {
  const world = seedWorld();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpStory", ownerMemberId: "ownerA", companyCashRubars: 300 });
  seedLaw(world, "cityB", "law_b_tax", 1, [{ field: "tax.operatingReceiptsBps", value: 500 }]);
  runAssessment(world, { kind: "operating-credit", corporationId: "corpStory", homeCityId: "cityA", operatingCityId: "cityB", baseAmountRubars: 10000 });
  assert.deepEqual(corpDoc(world, "cityA", "corpStory").taxPayables, { cityB: 200 });
  // The owner later funds the company (a seeded cash position stands in
  // for the F-03 event) and pays the arrears off.
  const corp = corpDoc(world, "cityA", "corpStory");
  world.set("sim_cities/cityA/corporations/corpStory", { ...corp, companyCashRubars: 1000 });
  const plan = runAction(world, act("pay_tax_arrears", "ownerA", {
    corporationId: "corpStory", homeCityId: "cityA", cityId: "cityB", amountRubars: 200,
  }));
  assert.equal(plan.outcome, "resolved");
  assert.deepEqual(corpDoc(world, "cityA", "corpStory").taxPayables, {});
  assert.equal(cityStats(world, "cityB").treasuryRubars, 5500, "300 collected at assessment + 200 paid under F-07");
});

console.log(`\nCAT2 HARNESS: all ${checks} checks passed (every resolved plan validated by the real validatePlan and conservation-checked by the real finance checker).`);
