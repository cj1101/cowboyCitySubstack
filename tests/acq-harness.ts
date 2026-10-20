/**
 * Acquisition harness (Phase 4 step 9) — a pure (snapshot, action) →
 * plan battery over lib/sim/rules/acquisition.ts, in the cat1/cat2
 * mold: handlers are pure, so the battery fabricates snapshots, calls
 * the handlers through their descriptors' read plans (the F-01
 * contract, materialized here against an in-memory world), and runs
 * every resolved plan through the REAL validatePlan — with the
 * acquisition descriptors registered into RULE_DESCRIPTORS in-process,
 * exactly the merge the Build Lead's assembly edit will perform in
 * registry.ts.
 *
 * Deliveries are driven through the module's exported delivery plan
 * builder (`buildDeliveryPlan`) — the reference implementation the
 * Lead wires into the ripening path (design C-8; prep report §5) —
 * and those plans ALSO pass the real validatePlan unchanged.
 *
 * The battery proves, end to end:
 *  - a no-means survey refuses with NO data written (CJ: means
 *    before data — the refusal is the mechanic);
 *  - a means-backed survey produces a provenance-carrying intel
 *    record (methodRef, frozen grading, coverage, per-question
 *    findings with null reasons), grading equal across commission
 *    and delivery (P4-G8-C2);
 *  - a covert collection writes NO public entry and an actor-private
 *    own-log entry; its delivery pending's audience excludes the
 *    target's owners (P4-G8-C5);
 *  - the caught case produces the PUBLIC discovery entry, burns the
 *    means a step, records the Phase 7 stat costs as DUE (not
 *    applied), and opens NO case (CJ round 2);
 *  - a published-false claim whose consequence scales with lie
 *    strength (minor < material < wholesale), with TC-P13(ii)'s
 *    ordering mechanical: the wholesale lie is provable at band C,
 *    the marginal spin is NOT — and band D proves nothing, ever;
 *  - the gate battery: one failing method per gate resolves rejected
 *    (gate named) or narrative-only — never with data (P4-G8-C4).
 *
 * Run: npx tsx tests/acq-harness.ts
 */

import assert from "node:assert/strict";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import {
  collectActionReadPlan,
  collectActionReadPaths,
  finalizePlan,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { ACTION_KIND_INDEX, RULE_DESCRIPTORS, type RuleDescriptor } from "../lib/sim/rules/registry";
import {
  ACQUISITION_DESCRIPTORS,
  buildDeliveryPlan,
  COUNTER_MEANS_QUERY_ID,
  type DeliverySpec,
} from "../lib/sim/rules/acquisition";
import { RipeningPreparationError } from "../lib/sim/rules/pendingRules";
import {
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
  type SnapshotQueryRecord,
} from "../lib/sim/state";

// The Lead's assembly, simulated: register the family map — and the
// kind index, which is a load-time derivation over RULE_DESCRIPTORS
// (the chains-harness idiom for exactly this).
const ACQ_BY_ID: Record<string, RuleDescriptor> = {};
for (const descriptor of ACQUISITION_DESCRIPTORS) ACQ_BY_ID[descriptor.id] = descriptor;
Object.assign(RULE_DESCRIPTORS, ACQ_BY_ID);
for (const descriptor of ACQUISITION_DESCRIPTORS) {
  for (const kind of descriptor.actionKinds) ACTION_KIND_INDEX[kind] = descriptor.id;
}

const KIND_TO_DESCRIPTOR: Record<string, RuleDescriptor> = {};
for (const descriptor of ACQUISITION_DESCRIPTORS) {
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
function act(actionType: string, uid: string, structuredAction: Record<string, unknown>): SimAction {
  actionCounter += 1;
  const actionId = `act_acq_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "acq-harness",
    actor: memberActor(uid),
    actionType,
    actionText: `${actionType} (harness)`,
    structuredAction,
    targetCityIds: [
      ...new Set(
        [structuredAction.cityId, structuredAction.targetCityId].filter(
          (v): v is string => typeof v === "string"
        )
      ),
    ],
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
  } as SimAction;
}

type World = Map<string, Record<string, unknown>>;

function materialize(world: World, action: SimAction): SimSnapshot {
  // The dispatcher's own path (snapshotForAction in miniature): base
  // paths first as seed docs, then the REAL collectActionReadPlan —
  // which resolves the descriptor from RULE_DESCRIPTORS (registered
  // above, as the Lead's assembly will) and runs its read-plan hook.
  const basePaths = collectActionReadPaths(action);
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of basePaths) seedDocs.set(path, world.get(path) ?? null);
  const readPlan = collectActionReadPlan(action, seedDocs);
  const docs = new Map(seedDocs);
  for (const path of readPlan.paths) docs.set(path, world.get(path) ?? null);
  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of readPlan.queries) {
    const prefix = `${spec.collectionPath}/`;
    const resultPaths = [...world.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .sort();
    for (const path of resultPaths) docs.set(path, world.get(path) ?? null);
    queryRecords.push({ spec, resultPaths, digest: "acq-harness" });
  }
  return snapshotFromDocs(docs, NOW, queryRecords);
}

function applyPlan(world: World, plan: ResolutionPlan): void {
  for (const write of plan.writes) {
    if (write.op === "delete") world.delete(write.path);
    else world.set(write.path, write.afterDoc as Record<string, unknown>);
  }
  for (const create of plan.pendingCreates) {
    world.set(`sim_pending_consequences/${create.doc.pendingId as string}`, create.doc);
  }
  // A commit advances the Log head by its entry count — the seqs the
  // resolution's records cite (createdAtSeq, collectedAtSeq) only
  // make sense against a head that moved. The real committer does
  // this inside the commit transaction; the harness mirrors it here.
  if (plan.entries.length > 0) {
    const counter = world.get("sim_counters/log") as Record<string, unknown>;
    const lastSeq = (counter.lastSeq as number) + plan.entries.length;
    world.set("sim_counters/log", { ...counter, lastSeq });
    const worldDoc = world.get("sim_world/current") as Record<string, unknown>;
    world.set("sim_world/current", { ...worldDoc, lastCommittedSeq: lastSeq });
  }
}

function runAction(world: World, action: SimAction): ResolutionPlan {
  const descriptor = KIND_TO_DESCRIPTOR[action.actionType];
  assert.ok(descriptor, `no acquisition descriptor classifies ${action.actionType}`);
  const handler = descriptor.handlers[action.actionType];
  assert.ok(handler, `descriptor ${descriptor.id} has no handler for ${action.actionType}`);
  const snapshot = materialize(world, action);
  const plan = handler({
    snapshot,
    action,
    resolutionId: action.actionId,
    prepared: undefined,
    baselineRegistry: fixtureRegistry,
    citableBaseline: null,
    citations: {},
  });
  plan.descriptorId = descriptor.id;
  if (plan.outcome === "rejected" && process.env.ACQ_DEBUG) {
    console.error(`  [debug] ${action.actionType} rejected: ${plan.rejection?.code} — ${plan.rejection?.summaryText}`);
  }
  if (plan.outcome === "resolved") {
    validatePlan(plan, {
      baselineRegistry: fixtureRegistry,
      covertEntriesAllowed: descriptor.visibility === "covert",
      snapshot,
    });
    finalizePlan(plan);
    assert.ok(plan.planHash.length > 0, "finalized plan carries a hash");
    applyPlan(world, plan);
  }
  return plan;
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code, `expected rejection code ${code}, got ${plan.rejection?.code}`);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
  assert.equal(plan.pendingCreates.length, 0, "a rejected plan creates no pendings");
}

/** Materialize a delivery snapshot for a pending doc: its spec's
 * read paths, the pending itself, the log counter, and the
 * counter-means query the discovery evaluation reads. */
function materializeDelivery(world: World, pendingDoc: Record<string, unknown>): SimSnapshot {
  const spec = (pendingDoc.payloadSpec as Record<string, unknown>).delivery as DeliverySpec;
  const docs = new Map<string, Record<string, unknown> | null>();
  const put = (path: string) => docs.set(path, world.get(path) ?? null);
  put("sim_counters/log");
  put(`sim_pending_consequences/${pendingDoc.pendingId as string}`);
  for (const path of spec.readPaths) put(path);
  if (spec.meansId) put(`sim_collection_means/${spec.meansId}`);
  put(`sim_cities/${spec.targetCityId}`);
  put(`sim_cities/${spec.collectorCityId}`);
  const counterPaths = [...world.keys()].filter((key) => key.startsWith("sim_collection_means/")).sort();
  for (const path of counterPaths) put(path);
  const queryRecords: SnapshotQueryRecord[] = [
    {
      spec: { id: COUNTER_MEANS_QUERY_ID, collectionPath: "sim_collection_means", filters: [] },
      resultPaths: counterPaths,
      digest: "acq-harness",
    },
  ];
  return snapshotFromDocs(docs, NOW, queryRecords);
}

function runDelivery(
  world: World,
  pendingDoc: Record<string, unknown>,
  generatedContent: Record<string, unknown>
): ResolutionPlan {
  const snapshot = materializeDelivery(world, pendingDoc);
  const prepared: PreparedPayload = { inputHash: "acq-harness", generatedContent };
  const spec = (pendingDoc.payloadSpec as Record<string, unknown>).delivery as DeliverySpec;
  const plan = buildDeliveryPlan(snapshot, pendingDoc, { prepared, citableBaseline: null });
  validatePlan(plan, {
    baselineRegistry: fixtureRegistry,
    covertEntriesAllowed: spec.visibilityClass === "actor-private",
    snapshot,
  });
  finalizePlan(plan);
  applyPlan(world, plan);
  return plan;
}

function advanceSeq(world: World, by: number): void {
  const counter = world.get("sim_counters/log") as Record<string, unknown>;
  world.set("sim_counters/log", { ...counter, lastSeq: (counter.lastSeq as number) + by });
}

function statsOf(world: World, cityId: string): Record<string, unknown> {
  return (world.get(`sim_cities/${cityId}`) as Record<string, unknown>).stats as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixture world
// ---------------------------------------------------------------------------

function cityDoc(stats: Record<string, unknown>, traits: string[] = []): Record<string, unknown> {
  return {
    stats: {
      spirit: 50, culture: 40, infrastructure: 62, stability: 60, law: 30,
      influence: 20, military: 40, defense: 35,
      households: 1200, housingUnits: 900, treasuryRubars: 100000,
      population: 800, gdpRubars: 1000000,
      ...stats,
    },
    traits,
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  };
}

function seedWorld(): World {
  const world: World = new Map();
  world.set("sim_counters/log", { lastSeq: 100, lastEntryHash: "ab".repeat(32) });
  world.set("sim_world/current", { lastCommittedSeq: 100 });
  world.set("factions/cascadia", { name: "Cascadia", slug: "cascadia", ownerUids: ["cj"] });
  world.set("factions/evanston", { name: "Evanston", slug: "evanston", ownerUids: ["evan"] });
  world.set("factions/chesscity", { name: "Chess City", slug: "chesscity", ownerUids: ["keaton"] });
  world.set("sim_cities/cascadia", { factionId: "cascadia", ...cityDoc({}) });
  world.set("sim_cities/evanston", { factionId: "evanston", ...cityDoc({}) });
  // Chess City: hardened — law 80, and it will hold a counter-means.
  world.set("sim_cities/chesscity", { factionId: "chesscity", ...cityDoc({ law: 80, population: 500 }) });
  // A corporation standing in Cascadia (the R-06 vehicle for a means).
  world.set("sim_cities/cascadia/corporations/corp-survey", {
    corporationId: "corp-survey",
    ownerMemberId: "cj",
    status: "active",
    companyCashRubars: 5000,
    marketCityIds: ["cascadia"],
  });
  // Structures standing in Cascadia (the R-05 vehicle for a means).
  world.set("sim_cities/cascadia/structures/st-office", {
    structureId: "st-office", kind: "office", status: "complete",
  });
  // Evanston structures (span fixtures).
  world.set("sim_cities/evanston/structures/ev-1", { structureId: "ev-1", kind: "warehouse", status: "complete" });
  world.set("sim_cities/evanston/structures/ev-2", { structureId: "ev-2", kind: "warehouse", status: "complete" });
  world.set("sim_cities/evanston/structures/ev-3", { structureId: "ev-3", kind: "depot", status: "complete" });
  return world;
}

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${checks} — ${label}`);
}

// ---------------------------------------------------------------------------
// 0. Registration shape
// ---------------------------------------------------------------------------

check("seven descriptors register (R-25…R-31); R-29 is a stub with one kind", () => {
  assert.equal(ACQUISITION_DESCRIPTORS.length, 7);
  assert.deepEqual(
    ACQUISITION_DESCRIPTORS.map((d) => d.id),
    ["R-25", "R-26", "R-27", "R-28", "R-29", "R-30", "R-31"]
  );
  const r29 = ACQ_BY_ID["R-29"];
  assert.deepEqual(r29.actionKinds, ["request_access"]);
  assert.equal(Object.keys(r29.handlers).length, 1, "the stub's only handler states the deferral");
  assert.equal(ACQ_BY_ID["R-27"].visibility, "covert");
  assert.equal(ACQ_BY_ID["R-28"].visibility, "covert");
});

// ---------------------------------------------------------------------------
// 1. No means = refusal, and NO data written (the mandated scenario)
// ---------------------------------------------------------------------------

check("no-means survey refuses NO_MEANS and writes nothing at all", () => {
  const world = seedWorld();
  const before = JSON.stringify([...world.entries()]);
  const plan = runAction(
    world,
    act("survey_commission", "cj", {
      cityId: "cascadia",
      questions: [{ questionId: "q1", text: "How many households?", dataKind: "count", sourceScope: "public-state" }],
      target: { scopeKind: "whole-city" },
      budgetRubars: 500,
    })
  );
  expectRejected(plan, "NO_MEANS");
  assert.equal(JSON.stringify([...world.entries()]), before, "the world is byte-identical after the refusal");
  assert.ok(![...world.keys()].some((k) => k.startsWith("sim_intel_records/")), "no intel record exists");
});

// ---------------------------------------------------------------------------
// 2. Means-backed survey: provenance-carrying results (mandated)
// ---------------------------------------------------------------------------

check("establish_means stands a record up before any data exists", () => {
  const world = seedWorld();
  const plan = runAction(
    world,
    act("establish_means", "cj", {
      cityId: "cascadia",
      vehicle: { ruleId: "R-06", recordIds: ["sim_cities/cascadia/corporations/corp-survey"], completionText: "the survey office trades" },
      profile: { observationClass: "records-access", reach: 3, access: 3, granularityKinds: ["count", "money", "condition"], freshnessClass: "standing" },
      scopeKind: "domestic",
      operatingCostRubars: 400,
    })
  );
  assert.equal(plan.outcome, "resolved");
  const means = [...world.keys()].filter((k) => k.startsWith("sim_collection_means/"));
  assert.equal(means.length, 1);
  const doc = world.get(means[0]) as Record<string, unknown>;
  assert.equal(doc.status, "active", "an R-06 vehicle that stands founded makes the means active at once");
  assert.ok(String(doc.createdByResolutionId).startsWith("act_acq_"), "the means carries its creating resolution — provenance from birth");
});

check("means-backed survey commissions, debits, and delivers a provenance record", () => {
  const world = seedWorld();
  runAction(
    world,
    act("establish_means", "cj", {
      cityId: "cascadia",
      vehicle: { ruleId: "R-06", recordIds: ["sim_cities/cascadia/corporations/corp-survey"], completionText: "the survey office trades" },
      profile: { observationClass: "records-access", reach: 3, access: 3, granularityKinds: ["count", "money", "condition"], freshnessClass: "standing" },
      scopeKind: "domestic",
      operatingCostRubars: 400,
    })
  );
  const meansId = [...world.keys()].find((k) => k.startsWith("sim_collection_means/"))!.split("/")[1];

  const commission = runAction(
    world,
    act("survey_commission", "cj", {
      cityId: "cascadia",
      meansId,
      questions: [
        { questionId: "q-households", text: "How many households?", dataKind: "count", sourceScope: "public-state" },
        { questionId: "q-gdp", text: "What is GDP?", dataKind: "money", sourceScope: "public-state" },
        { questionId: "q-infra", text: "How sound is the infrastructure?", dataKind: "condition", sourceScope: "public-state" },
        { questionId: "q-mood", text: "How do people feel?", dataKind: "attitude", sourceScope: "public-state" },
      ],
      target: { scopeKind: "whole-city" },
      budgetRubars: 400,
    })
  );
  assert.equal(commission.outcome, "resolved");
  assert.equal(statsOf(world, "cascadia").treasuryRubars, 100000 - 400, "the treasury paid the operating cost");
  const classification = commission.entries[0].classification as Record<string, unknown>;
  assert.equal(classification.band, "A", "3+3+3+3 = 12 grades band A");
  assert.equal(classification.fundedCapPct, 100);
  assert.equal(commission.pendingCreates.length, 1);
  const pendingDoc = commission.pendingCreates[0].doc;
  assert.equal(pendingDoc.kind, "survey-delivery");
  const spec = (pendingDoc.payloadSpec as Record<string, unknown>).delivery as DeliverySpec;
  assert.equal(spec.methodRef, `means:${meansId}@${(world.get(`sim_collection_means/${meansId}`) as Record<string, unknown>).createdByResolutionId as string}`);

  advanceSeq(world, 12);
  const delivery = runDelivery(world, pendingDoc, {
    findings: [
      { questionId: "q-households", value: 1200, basisPaths: ["sim_cities/cascadia"], basisField: "stats.households" },
      { questionId: "q-gdp", value: 1000000, basisPaths: ["sim_cities/cascadia"], basisField: "stats.gdpRubars" },
      { questionId: "q-infra", value: 60, basisPaths: ["sim_cities/cascadia"], basisField: "stats.infrastructure" },
      { questionId: "q-mood", value: null, basisPaths: [], basisField: "" },
    ],
  });
  assert.equal(delivery.outcome, "resolved");
  const intelPath = `sim_intel_records/intel_ripen_${pendingDoc.pendingId as string}`;
  const intel = world.get(intelPath) as Record<string, unknown>;
  assert.ok(intel, "the results record landed in sim_intel_records");
  assert.equal(intel.collectorCityId, "cascadia");
  assert.equal((intel.method as Record<string, unknown>).methodRef, spec.methodRef, "provenance: the methodRef names the means and its creating resolution");
  const reliability = intel.reliability as Record<string, unknown>;
  assert.equal(reliability.band, "A");
  assert.deepEqual(reliability.axisScores, spec.grading.axisScores, "grading equality: delivery cites the commission's frozen grading (P4-G8-C2)");
  const coverage = intel.coverage as Record<string, unknown>;
  assert.equal(coverage.achievedPct, 100);
  const findings = intel.findings as Record<string, unknown>[];
  const byMetric = Object.fromEntries(findings.map((f) => [f.metric, f]));
  assert.equal(byMetric["q-households"].value, 1200, "grade-3 count is exact");
  assert.equal(byMetric["q-infra"].value, 60, "grade-2 condition snaps 62 to the nearest 5");
  assert.equal(byMetric["q-mood"].value, null, "attitude pre-ratification is null — never a fabricated pulse");
  assert.ok((intel.nullReasons as string[]).some((r) => r.startsWith("q-mood:")), "the null carries its reason");
  assert.equal(delivery.pendingTransitions.length, 1);
  assert.equal(delivery.pendingTransitions[0].toStatus, "ripened");
});

check("a delivery payload that disagrees with recomputation fails — no partial delivery", () => {
  const world = seedWorld();
  runAction(
    world,
    act("establish_means", "cj", {
      cityId: "cascadia",
      vehicle: { ruleId: "R-06", recordIds: ["sim_cities/cascadia/corporations/corp-survey"], completionText: "" },
      profile: { observationClass: "records-access", reach: 3, access: 3, granularityKinds: ["count"], freshnessClass: "standing" },
      scopeKind: "domestic",
      operatingCostRubars: 400,
    })
  );
  const meansId = [...world.keys()].find((k) => k.startsWith("sim_collection_means/"))!.split("/")[1];
  const commission = runAction(
    world,
    act("survey_commission", "cj", {
      cityId: "cascadia",
      meansId,
      questions: [{ questionId: "q1", text: "Households?", dataKind: "count", sourceScope: "public-state" }],
      target: { scopeKind: "whole-city" },
      budgetRubars: 400,
    })
  );
  const pendingDoc = commission.pendingCreates[0].doc;
  advanceSeq(world, 12);
  assert.throws(
    () =>
      runDelivery(world, pendingDoc, {
        findings: [{ questionId: "q1", value: 9999, basisPaths: ["sim_cities/cascadia"], basisField: "stats.households" }],
      }),
    (err: unknown) => err instanceof RipeningPreparationError,
    "a fabricated figure is a generation failure, not a finding"
  );
  assert.ok(![...world.keys()].some((k) => k.startsWith("sim_intel_records/")), "nothing was delivered");
});

// ---------------------------------------------------------------------------
// 3. Covert collection, undiscovered: no public entry (mandated)
// ---------------------------------------------------------------------------

function seedForeignMeans(world: World): string {
  runAction(
    world,
    act("establish_means", "cj", {
      cityId: "cascadia",
      vehicle: { ruleId: "R-05", recordIds: ["sim_cities/cascadia/structures/st-office"], completionText: "the office stands complete" },
      profile: { observationClass: "signals", reach: 2, access: 2, granularityKinds: ["count"], freshnessClass: "dispatch" },
      scopeKind: "foreign",
      namedTargetCityIds: ["evanston"],
      hostCityId: "evanston", // resident apparatus — the return path exists
      operatingCostRubars: 300,
    })
  );
  return [...world.keys()].find((k) => k.startsWith("sim_collection_means/"))!.split("/")[1];
}

check("covert run: actor-private entries only, audience excludes the target, delivery stays invisible", () => {
  const world = seedWorld();
  const meansId = seedForeignMeans(world);
  const commission = runAction(
    world,
    act("collection_run", "cj", {
      cityId: "cascadia",
      targetCityId: "evanston",
      meansId,
      questions: [{ questionId: "q-pop", text: "Population of Evanston?", dataKind: "count", sourceScope: "public-state" }],
      target: { scopeKind: "whole-city" },
      budgetRubars: 300,
    })
  );
  assert.equal(commission.outcome, "resolved");
  assert.ok(
    commission.entries.every((e) => e.visibility === "actor-private"),
    "every commission entry is actor-private — the public Log sees nothing"
  );
  const pendingDoc = commission.pendingCreates[0].doc;
  const audience = pendingDoc.audienceUids as string[];
  assert.ok(audience.includes("cj"));
  assert.ok(!audience.includes("evan"), "the target's owner is NOT in the covert pending's audience (the leak the manual draft exists to prevent)");
  const classification = commission.entries[0].classification as Record<string, unknown>;
  assert.equal((classification.exposurePreview as Record<string, unknown>).outcome, "undiscovered");

  advanceSeq(world, 12);
  const delivery = runDelivery(world, pendingDoc, {
    findings: [{ questionId: "q-pop", value: 800, basisPaths: ["sim_cities/evanston"], basisField: "stats.population" }],
  });
  assert.ok(
    delivery.entries.every((e) => e.visibility === "actor-private"),
    "undiscovered delivery: still no public entry, not even a metadata stub (P4-G8-C5)"
  );
  const intel = world.get(`sim_intel_records/intel_ripen_${pendingDoc.pendingId as string}`) as Record<string, unknown>;
  assert.ok(intel, "the actor's own record landed");
  assert.equal((intel.findings as Record<string, unknown>[])[0].value, 800);
  assert.ok(![...world.keys()].some((k) => k.startsWith("sim_cases/")), "no case exists");
});

// ---------------------------------------------------------------------------
// 4. The caught case: public discovery, no automatic case (mandated)
// ---------------------------------------------------------------------------

check("discovered run: public discovery entry, means burned (severe), costs DUE not applied, NO case", () => {
  const world = seedWorld();
  // Chess City's counter-means + prior suspicion (posture record).
  world.set("sim_collection_means/means_counter", {
    meansId: "means_counter",
    ownerCityId: "chesscity",
    ownerUid: "keaton",
    vehicle: { ruleId: "R-08", recordIds: ["sim_cities/chesscity/laws/law-watch"], completionText: "" },
    profile: { observationClass: "observation", reach: 2, access: 2, granularityKinds: [], freshnessClass: "standing" },
    scopeKind: "foreign",
    namedTargetCityIds: ["cascadia"],
    hostCityId: "chesscity",
    operatingCostRubars: 100,
    status: "active",
    createdByResolutionId: "act_seed",
    createdAtSeq: 10,
    stateVersion: 1, createdAt: null, lastChangedSeq: null, lastResolutionId: null,
  });
  world.set("sim_cities/chesscity/laws/law-watch", { lawId: "law-watch", status: "enacted" });
  world.set("sim_collection_posture/chesscity", {
    schemaVersion: 2, cityId: "chesscity", priorSuspected: true, suspicionCount: 1, burnedContactRefs: [],
  });
  // Cascadia's resident enumeration apparatus inside Chess City.
  runAction(
    world,
    act("establish_means", "cj", {
      cityId: "cascadia",
      vehicle: { ruleId: "R-05", recordIds: ["sim_cities/cascadia/structures/st-office"], completionText: "" },
      profile: { observationClass: "enumeration", reach: 3, access: 2, granularityKinds: ["count"], freshnessClass: "dispatch" },
      scopeKind: "foreign",
      namedTargetCityIds: ["chesscity"],
      hostCityId: "chesscity",
      operatingCostRubars: 500,
    })
  );
  const meansId = [...world.keys()]
    .filter((k) => k.startsWith("sim_collection_means/") && k !== "sim_collection_means/means_counter")
    .pop()!
    .split("/")[1];
  const lawBefore = statsOf(world, "chesscity").law;

  const commission = runAction(
    world,
    act("collection_run", "cj", {
      cityId: "cascadia",
      targetCityId: "chesscity",
      meansId,
      questions: [{ questionId: "q-pop", text: "Population?", dataKind: "count", sourceScope: "public-state" }],
      target: { scopeKind: "whole-city" },
      budgetRubars: 500,
    })
  );
  assert.equal(commission.outcome, "resolved");
  const preview = (commission.entries[0].classification as Record<string, unknown>).exposurePreview as Record<string, unknown>;
  assert.equal(preview.outcome, "discovered", "severe exposure vs alerted posture — the preview states the cell honestly");

  const pendingDoc = commission.pendingCreates[0].doc;
  advanceSeq(world, 12);
  const delivery = runDelivery(world, pendingDoc, {
    findings: [{ questionId: "q-pop", value: 500, basisPaths: ["sim_cities/chesscity"], basisField: "stats.population" }],
  });
  const publicEntries = delivery.entries.filter((e) => e.visibility === "public");
  assert.equal(publicEntries.length, 1, "exactly one public entry: the discovery");
  const discovery = publicEntries[0].classification as Record<string, unknown>;
  assert.equal(discovery.discovery, true);
  assert.equal(discovery.outcome, "discovered");
  assert.deepEqual(discovery.consequencesDue, { law: -2, influence: -1, appliedBy: "phase-7-consequence-track" });
  assert.equal(statsOf(world, "chesscity").law, lawBefore, "discovery stat costs are DUE, not applied in Phase 4 (design §7.4)");
  const meansAfter = world.get(`sim_collection_means/${meansId}`) as Record<string, unknown>;
  assert.equal(meansAfter.status, "burned", "discovery at SEVERE exposure burns the means outright (design §7.3); a lesser exposure would compromise it first");
  assert.ok(world.get(`sim_intel_records/intel_ripen_${pendingDoc.pendingId as string}`), "the intel already delivered stays delivered");
  assert.ok(![...world.keys()].some((k) => k.startsWith("sim_cases/")), "NO case opens automatically — a case is the target users' own act (CJ round 2)");
  const posture = world.get("sim_collection_posture/chesscity") as Record<string, unknown>;
  assert.equal(posture.lastDiscoveryResolutionId, `ripen_${pendingDoc.pendingId as string}`);
});

// ---------------------------------------------------------------------------
// 5. Published-false claims: consequence scales with lie strength
// ---------------------------------------------------------------------------

interface LieFixture {
  claimValue: number;
  band: "A" | "B" | "C" | "D";
}

function seedClaimAndReport(world: World, claimId: string, fixture: LieFixture): void {
  world.set(`sim_publications/${claimId}`, {
    cityId: "evanston",
    businessId: null,
    publisherUid: "evan",
    version: 1,
    supersedesPublicationId: null,
    status: "published",
    publishedAt: null,
    publishedAtSeq: 90,
    claims: [
      {
        metric: "gdp",
        claimedValue: fixture.claimValue,
        unit: "rubars",
        periodLabel: "season 0",
        note: JSON.stringify({ sourceRef: "sim_cities/evanston" }),
      },
    ],
    visibility: "members",
  });
  world.set(`sim_intel_records/intel_evidence_${claimId}`, {
    schemaVersion: 2,
    collectorUid: "cj",
    collectorCityId: "cascadia",
    targetCityId: "evanston",
    targetBusinessId: null,
    method: { kindLabel: "survey", methodRef: "means:means_fixture@act_seed" },
    collectionResolutionId: "act_seed",
    collectedAtSeq: 95,
    coverage: null,
    reliability: { band: fixture.band },
    findings: [{ metric: "gdp", value: 1000000, unit: "money", note: "{}" }],
    stateVersion: 1, createdByResolutionId: "act_seed", createdAt: null, lastChangedSeq: null, lastResolutionId: null,
  });
  world.set(`sim_publications/report_${claimId}`, {
    cityId: "cascadia",
    businessId: null,
    publisherUid: "cj",
    version: 1,
    supersedesPublicationId: null,
    status: "published",
    publishedAt: null,
    publishedAtSeq: 96,
    claims: [
      {
        metric: "gdp",
        claimedValue: 1000000,
        unit: "rubars",
        periodLabel: "season 0",
        note: JSON.stringify({
          claimRef: claimId,
          evidenceRefs: [`sim_intel_records/intel_evidence_${claimId}`],
          evidenceBand: fixture.band,
        }),
      },
    ],
    visibility: "members",
  });
}

function verifyAndAdopt(world: World, claimId: string): { verify: ResolutionPlan; adopt: ResolutionPlan } {
  const steers = {
    cityId: "cascadia",
    reportPublicationId: `report_${claimId}`,
    publicationPath: `sim_publications/report_${claimId}`,
    claimPublicationId: claimId,
    publisherCityId: "evanston",
  };
  const verify = runAction(world, act("publish_verification", "cj", { ...steers }));
  const adopt = runAction(world, act("adopt_verification_report", "cj", { ...steers }));
  return { verify, adopt };
}

check("lie tiers land scaled consequences: minor −1/−1, material −3/−2, wholesale −5/−3", () => {
  const cases: { claimValue: number; tier: string; law: number; influence: number }[] = [
    { claimValue: 1050000, tier: "minor", law: -1, influence: -1 }, // 5% spin
    { claimValue: 1300000, tier: "material", law: -3, influence: -2 }, // 30% lie
    { claimValue: 2200000, tier: "wholesale", law: -5, influence: -3 }, // 120% fabrication
  ];
  for (const c of cases) {
    const world = seedWorld();
    const claimId = `claim_${c.tier}`;
    seedClaimAndReport(world, claimId, { claimValue: c.claimValue, band: "B" });
    const claimBefore = JSON.stringify(world.get(`sim_publications/${claimId}`));
    const { verify, adopt } = verifyAndAdopt(world, claimId);
    assert.equal(verify.outcome, "resolved");
    const vClass = verify.entries[0].classification as Record<string, unknown>;
    assert.equal(vClass.established, true, `${c.tier}: falsity established at band B`);
    assert.equal(vClass.tier, c.tier);
    assert.equal(adopt.outcome, "resolved");
    assert.equal(statsOf(world, "evanston").law, 30 + c.law, `${c.tier}: law ${c.law}`);
    assert.equal(statsOf(world, "evanston").influence, 20 + c.influence, `${c.tier}: influence ${c.influence}`);
    assert.equal(
      JSON.stringify(world.get(`sim_publications/${claimId}`)),
      claimBefore,
      "the original claim is never edited"
    );
    // Second adoption of the same report refuses — consequences land once.
    const again = runAction(
      world,
      act("adopt_verification_report", "cj", {
        cityId: "cascadia",
        reportPublicationId: `report_${claimId}`,
        publicationPath: `sim_publications/report_${claimId}`,
        claimPublicationId: claimId,
        publisherCityId: "evanston",
      })
    );
    expectRejected(again, "ALREADY_ADOPTED");
  }
});

check("TC-P13(ii): the wholesale lie is provable at band C; the marginal spin is not; band D proves nothing", () => {
  // Wholesale at band C: 120% divergence > 10% threshold → established.
  const worldW = seedWorld();
  seedClaimAndReport(worldW, "claim_wc", { claimValue: 2200000, band: "C" });
  const w = verifyAndAdopt(worldW, "claim_wc");
  assert.equal((w.verify.entries[0].classification as Record<string, unknown>).established, true);
  assert.equal(w.adopt.outcome, "resolved");

  // Minor spin at band C: 5% ≤ 10% → cannot-determine → adoption refuses.
  const worldM = seedWorld();
  seedClaimAndReport(worldM, "claim_mc", { claimValue: 1050000, band: "C" });
  const m = verifyAndAdopt(worldM, "claim_mc");
  assert.equal((m.verify.entries[0].classification as Record<string, unknown>).established, false);
  expectRejected(m.adopt, "NO_PROOF_ESTABLISHED");
  assert.equal(statsOf(worldM, "evanston").law, 30, "no consequence without proof");

  // Wholesale at band D: D never establishes — no manufactured debunking.
  const worldD = seedWorld();
  seedClaimAndReport(worldD, "claim_wd", { claimValue: 2200000, band: "D" });
  const d = verifyAndAdopt(worldD, "claim_wd");
  assert.equal((d.verify.entries[0].classification as Record<string, unknown>).established, false);
  expectRejected(d.adopt, "NO_PROOF_ESTABLISHED");
});

check("wholesale + binding + elected opens the tier-1 case (the module's one case)", () => {
  const world = seedWorld();
  seedClaimAndReport(world, "claim_case", { claimValue: 2200000, band: "A" });
  const claim = world.get("sim_publications/claim_case") as Record<string, unknown>;
  world.set("sim_publications/claim_case", { ...claim, bindingAgreementRef: "treaty://evanston-cascadia/trade-1" });
  const steers = {
    cityId: "cascadia",
    reportPublicationId: "report_claim_case",
    publicationPath: "sim_publications/report_claim_case",
    claimPublicationId: "claim_case",
    publisherCityId: "evanston",
  };
  runAction(world, act("publish_verification", "cj", { ...steers }));
  const adopt = runAction(
    world,
    act("adopt_verification_report", "cj", { ...steers, openCase: true })
  );
  assert.equal(adopt.outcome, "resolved");
  const caseKeys = [...world.keys()].filter((k) => k.startsWith("sim_cases/"));
  assert.equal(caseKeys.length, 1);
  const caseDoc = world.get(caseKeys[0]) as Record<string, unknown>;
  assert.equal(caseDoc.ruleId, "R-30");
  assert.equal(caseDoc.tier, 1);
  assert.equal(caseDoc.accusedCityId, "evanston");
});

// ---------------------------------------------------------------------------
// 6. Publish stamp + the verdict-field refusal (P4-G8-C7)
// ---------------------------------------------------------------------------

check("publish_claim stamps owner-published · unverified and moves nothing verified", () => {
  const world = seedWorld();
  world.set("sim_publications/claim_stamp", {
    cityId: "cascadia", businessId: null, publisherUid: "cj", version: 1,
    supersedesPublicationId: null, status: "published", publishedAt: null, publishedAtSeq: 90,
    claims: [{ metric: "gdp", claimedValue: 1000000, unit: "rubars", periodLabel: "s0", note: "" }],
    visibility: "members",
  });
  const cityBefore = JSON.stringify(world.get("sim_cities/cascadia"));
  const plan = runAction(world, act("publish_claim", "cj", { cityId: "cascadia", publicationId: "claim_stamp" }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0, "publication is speech: the stamp writes nothing");
  assert.equal(JSON.stringify(world.get("sim_cities/cascadia")), cityBefore, "verified state byte-identical (P4-G8-C7)");
  assert.equal((plan.entries[0].classification as Record<string, unknown>).stamp, "owner-published · unverified");

  const world2 = seedWorld();
  world2.set("sim_publications/claim_bad", {
    cityId: "cascadia", businessId: null, publisherUid: "cj", version: 1,
    supersedesPublicationId: null, status: "published", publishedAt: null, publishedAtSeq: 90,
    claims: [{ metric: "gdp", claimedValue: 1, unit: "rubars", periodLabel: "s0", note: "" }],
    verified: true,
    visibility: "members",
  });
  const bad = runAction(world2, act("publish_claim", "cj", { cityId: "cascadia", publicationId: "claim_bad" }));
  expectRejected(bad, "CLAIM_CARRIES_VERDICT_FIELD");
});

// ---------------------------------------------------------------------------
// 7. The gate battery (P4-G8-C4): one failing method per gate
// ---------------------------------------------------------------------------

check("gate battery: boundary, specificity, investment, reachability, narrative-only", () => {
  // Boundary: a private-tier question refuses BY CONSTRUCTION.
  {
    const world = seedWorld();
    const meansId = seedForeignMeans(world);
    const plan = runAction(
      world,
      act("collection_run", "cj", {
        cityId: "cascadia", targetCityId: "evanston", meansId,
        questions: [{ questionId: "q", text: "Their raw intel?", dataKind: "count", sourceScope: "private-records" }],
        target: { scopeKind: "whole-city" }, budgetRubars: 300,
      })
    );
    expectRejected(plan, "BOUNDARY_PRIVATE_TIER");
  }
  // Specificity: a named structure that does not stand.
  {
    const world = seedWorld();
    const meansId = seedForeignMeans(world);
    const plan = runAction(
      world,
      act("collection_run", "cj", {
        cityId: "cascadia", targetCityId: "evanston", meansId,
        questions: [{ questionId: "q", text: "?", dataKind: "count", sourceScope: "public-state" }],
        target: { scopeKind: "named-structures", structureIds: ["ev-nope"] }, budgetRubars: 300,
      })
    );
    expectRejected(plan, "GATE_SPECIFICITY");
  }
  // Investment: a free means (operating cost 0) fails at establishment.
  {
    const world = seedWorld();
    const plan = runAction(
      world,
      act("establish_means", "cj", {
        cityId: "cascadia",
        vehicle: { ruleId: "R-06", recordIds: ["sim_cities/cascadia/corporations/corp-survey"], completionText: "" },
        profile: { observationClass: "observation", reach: 1, access: 1, granularityKinds: [], freshnessClass: "dispatch" },
        scopeKind: "domestic",
        operatingCostRubars: 0,
      })
    );
    expectRejected(plan, "GATE_INVESTMENT");
  }
  // Investment: another owner's means is not yours to run.
  {
    const world = seedWorld();
    seedForeignMeans(world);
    const meansId = [...world.keys()].find((k) => k.startsWith("sim_collection_means/"))!.split("/")[1];
    const plan = runAction(
      world,
      act("survey_commission", "evan", {
        cityId: "evanston", meansId,
        questions: [{ questionId: "q", text: "?", dataKind: "count", sourceScope: "public-state" }],
        target: { scopeKind: "whole-city" }, budgetRubars: 100,
      })
    );
    expectRejected(plan, "MEANS_NOT_OWNED");
  }
  // Zero budget: refused, not run for free.
  {
    const world = seedWorld();
    const meansId = seedForeignMeans(world);
    const plan = runAction(
      world,
      act("collection_run", "cj", {
        cityId: "cascadia", targetCityId: "evanston", meansId,
        questions: [{ questionId: "q", text: "?", dataKind: "count", sourceScope: "public-state" }],
        target: { scopeKind: "whole-city" }, budgetRubars: 0,
      })
    );
    expectRejected(plan, "INSUFFICIENT_BUDGET");
  }
  // Narrative-only: declared at intake, a failing commission resolves
  // as story — with NO results record and NO pending (P4-G8-C1).
  {
    const world = seedWorld();
    const plan = runAction(
      world,
      act("survey_commission", "cj", {
        cityId: "cascadia", intent: "narrative-only",
        questions: [{ questionId: "q", text: "?", dataKind: "count", sourceScope: "public-state" }],
        target: { scopeKind: "whole-city" }, budgetRubars: 100,
      })
    );
    assert.equal(plan.outcome, "resolved");
    assert.equal(plan.pendingCreates.length, 0);
    assert.ok(![...world.keys()].some((k) => k.startsWith("sim_intel_records/")));
  }
  // Novel observation class without a classification: refused by name.
  {
    const world = seedWorld();
    const plan = runAction(
      world,
      act("establish_means", "cj", {
        cityId: "cascadia",
        vehicle: { ruleId: "R-06", recordIds: ["sim_cities/cascadia/corporations/corp-survey"], completionText: "" },
        profile: { observationClass: "dream-reading", reach: 3, access: 3, granularityKinds: [], freshnessClass: "standing" },
        scopeKind: "domestic",
        operatingCostRubars: 100,
      })
    );
    expectRejected(plan, "NOVEL_CLASS_UNCLASSIFIED");
  }
});

// ---------------------------------------------------------------------------
// 8. Insider ask: reachability, disposition, the pay leg
// ---------------------------------------------------------------------------

function seedPerson(world: World): void {
  const evanston = world.get("sim_cities/evanston") as Record<string, unknown>;
  world.set("sim_cities/evanston", { ...evanston, traits: ["connection:cascadia:live"] });
  world.set("characters/person-ledger", {
    personId: "person-ledger",
    cityId: "evanston",
    roleRecord: "keeps the harbor ledger books for the port authority",
    businessId: "corp-port",
    businessHomeCityId: "evanston",
  });
  world.set("sim_cities/evanston/corporations/corp-port", {
    corporationId: "corp-port",
    ownerMemberId: "evan",
    status: "active",
    companyCashRubars: 200,
    marketCityIds: ["evanston"],
  });
}

check("insider ask: unestablished person and unreachable person refuse; the reached ask delivers + pays on answers", () => {
  // Unestablished person.
  {
    const world = seedWorld();
    const plan = runAction(
      world,
      act("insider_ask", "cj", {
        cityId: "cascadia", personRef: "person-ghost", personCityId: "evanston",
        question: { questionId: "q", text: "?", dataKind: "money", sourceScope: "public-state" },
        channel: { kind: "connection", recordPath: "sim_cities/evanston" },
      })
    );
    expectRejected(plan, "PERSON_NOT_ESTABLISHED");
  }
  // Established but unreachable (no channel facts).
  {
    const world = seedWorld();
    world.set("characters/person-far", { personId: "person-far", cityId: "evanston", roleRecord: "a fisher" });
    const plan = runAction(
      world,
      act("insider_ask", "cj", {
        cityId: "cascadia", personRef: "person-far", personCityId: "evanston",
        question: { questionId: "q", text: "?", dataKind: "count", sourceScope: "public-state" },
        channel: { kind: "connection", recordPath: "sim_cities/evanston" },
      })
    );
    expectRejected(plan, "GATE_REACHABILITY");
  }
  // Reached: books-keeper via a live connection; answers pay the offer.
  {
    const world = seedWorld();
    seedPerson(world);
    const commission = runAction(
      world,
      act("insider_ask", "cj", {
        cityId: "cascadia", personRef: "person-ledger", personCityId: "evanston",
        question: { questionId: "q-dues", text: "What did the port take in dues?", dataKind: "money", sourceScope: "public-state" },
        channel: { kind: "connection", recordPath: "sim_cities/evanston" },
        offerRubars: 100,
      })
    );
    assert.equal(commission.outcome, "resolved");
    assert.ok(commission.entries.every((e) => e.visibility === "actor-private"), "the ask is covert");
    const pendingDoc = commission.pendingCreates[0].doc;
    assert.equal(pendingDoc.kind, "insider-delivery");
    advanceSeq(world, 12);
    const delivery = runDelivery(world, pendingDoc, {
      branch: "answers",
      dispositionCitations: ["characters/person-ledger"],
      findings: [{ questionId: "q-dues", value: 4200 }],
    });
    assert.equal(delivery.outcome, "resolved");
    assert.equal(statsOf(world, "cascadia").treasuryRubars, 100000 - 100, "the offer left the treasury at delivery");
    const corp = world.get("sim_cities/evanston/corporations/corp-port") as Record<string, unknown>;
    assert.equal(corp.companyCashRubars, 300, "and landed in the person's business — answers only");
    const intel = world.get(`sim_intel_records/intel_ripen_${pendingDoc.pendingId as string}`) as Record<string, unknown>;
    assert.ok(
      String((intel.method as Record<string, unknown>).methodRef).startsWith("contact:person-ledger@act_acq_"),
      "the methodRef names the person and the approach resolution (Phase 1 grammar)"
    );
  }
  // Refuses: findings null with SOURCE_REFUSED, and NO payment.
  {
    const world = seedWorld();
    seedPerson(world);
    const commission = runAction(
      world,
      act("insider_ask", "cj", {
        cityId: "cascadia", personRef: "person-ledger", personCityId: "evanston",
        question: { questionId: "q-dues", text: "Dues?", dataKind: "money", sourceScope: "public-state" },
        channel: { kind: "connection", recordPath: "sim_cities/evanston" },
        offerRubars: 100,
      })
    );
    const pendingDoc = commission.pendingCreates[0].doc;
    advanceSeq(world, 12);
    runDelivery(world, pendingDoc, {
      branch: "refuses",
      dispositionCitations: ["characters/person-ledger"],
      findings: [{ questionId: "q-dues", value: null }],
    });
    assert.equal(statsOf(world, "cascadia").treasuryRubars, 100000, "a refusal pays nothing");
    const intel = world.get(`sim_intel_records/intel_ripen_${pendingDoc.pendingId as string}`) as Record<string, unknown>;
    assert.ok((intel.nullReasons as string[]).some((r) => r.includes("SOURCE_REFUSED")));
  }
});

// ---------------------------------------------------------------------------
// 9. R-29 stub: the deferral is stated in the open
// ---------------------------------------------------------------------------

check("request_access resolves narrative-only with the deferral + export-OFF clause in the plan", () => {
  const world = seedWorld();
  const plan = runAction(world, act("request_access", "cj", { cityId: "cascadia", grantRef: "grant://deal/1" }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.pendingCreates.length, 0);
  const classification = plan.entries[0].classification as Record<string, unknown>;
  assert.equal(classification.deferral, "phase-5-grant-substrate");
  assert.equal(classification.exportUnderGrant, "off-unless-deal-terms");
  assert.ok(plan.entries[0].summaryText.includes("DEFERRED"), "the deferral is stated, never silent");
});

console.log(`\nacq-harness: ${checks} checks passed.`);
