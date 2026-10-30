/**
 * Market harness (Phase 4 step 7) — a pure (snapshot, action) → plan
 * battery over lib/sim/rules/market.ts, in the cat1/cat2 mold:
 * handlers are pure, so the battery fabricates snapshots, calls the
 * handlers through their descriptors' read plans (the F-01 contract,
 * materialized here against an in-memory world), and runs every
 * resolved plan through the REAL validatePlan — with the market
 * (and finance + business) descriptors registered into
 * RULE_DESCRIPTORS in-process, exactly the merge the Build Lead's
 * assembly edit will perform in registry.ts.
 *
 * Beyond plan validity, every resolved money event is ALSO run
 * through the REAL finance conservation checker
 * (lib/finance/conservation.ts) over the plan's entries + writeSet,
 * and the standing records (corporations + holdings + accounts +
 * cities) are re-asserted with checkStandingRecords after each phase
 * — including P4-K21 share conservation (Σ holdings + retired ==
 * sharesOutstanding), wired here with the holdings supply that M-01/
 * M-02 now make lawful. The closing section proves the same supply
 * as wired into verify.ts itself (B2.1 §3d): verifyStandingLog
 * collects sim_holdings from the standing state and activates the
 * assertion inside the standing verifier.
 *
 * The world's seq advances as the committer's would: each applied
 * plan consumes one seq per Log entry, so placedAtSeq/expiresAtSeq
 * horizons behave as they will in production.
 *
 * Run: npx tsx tests/market-harness.ts
 */

import assert from "node:assert/strict";
import {
  checkConservationEvent,
  checkStandingRecords,
  type ConservationEvent,
} from "../lib/finance/conservation";
import { deriveRealmIndex } from "../lib/market/realmIndex";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildCorporationDoc } from "../lib/sim/corporations";
import { buildLogEntry } from "../lib/sim/log";
import {
  buildHoldingDoc,
  buildListingDoc,
  buildOrderDoc,
  holdingPath,
  listingPath,
  orderPath,
  planFounderHoldingBackfill,
} from "../lib/sim/marketRecords";
import {
  collectActionReadPaths,
  finalizePlan,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { RULE_DESCRIPTORS, type RuleDescriptor } from "../lib/sim/rules/registry";
import { FINANCE_DESCRIPTORS } from "../lib/sim/rules/finance";
import { BUSINESS_DESCRIPTORS } from "../lib/sim/rules/businesses";
import {
  MARKET_DESCRIPTORS,
  composeMarketRepricing,
} from "../lib/sim/rules/market";
import { ruleEffectDraft } from "../lib/sim/rules/planHelpers";
import { verifyStandingLog, type StandingWorld } from "../lib/sim/verify";
import {
  emptyPlan,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
  type SnapshotQueryRecord,
} from "../lib/sim/state";

// The Lead's assembly, simulated: register all three family maps.
Object.assign(RULE_DESCRIPTORS, FINANCE_DESCRIPTORS, BUSINESS_DESCRIPTORS, MARKET_DESCRIPTORS);

const ALL_DESCRIPTORS: Record<string, RuleDescriptor> = {
  ...FINANCE_DESCRIPTORS,
  ...BUSINESS_DESCRIPTORS,
  ...MARKET_DESCRIPTORS,
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
  const actionId = `act_mkt_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "market-harness",
    actor: memberActor(uid),
    actionType,
    actionText: `${actionType} (harness)`,
    structuredAction,
    targetCityIds: typeof structuredAction.homeCityId === "string" ? [structuredAction.homeCityId] : [],
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
    queryRecords.push({ spec, resultPaths, digest: "market-harness" });
  }
  return snapshotFromDocs(docs, NOW, queryRecords);
}

function applyPlan(world: World, plan: ResolutionPlan): void {
  for (const write of plan.writes) {
    if (write.op === "delete") world.delete(write.path);
    else world.set(write.path, write.afterDoc as Record<string, unknown>);
  }
  // The committer allocates one seq per Log entry; the world's head
  // advances exactly that far.
  const counters = world.get("sim_counters/log");
  if (counters) {
    const lastSeq = (counters.lastSeq as number) + plan.entries.length;
    world.set("sim_counters/log", { ...counters, lastSeq });
    const worldDoc = world.get("sim_world/current");
    if (worldDoc) world.set("sim_world/current", { ...worldDoc, lastCommittedSeq: lastSeq });
  }
}

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

/** Standing-stock proof over the whole world: bank aggregates
 * (vacuous here), non-negativity, and P4-K21 share conservation with
 * the holdings supply wired — the assertion PR #33 said may only be
 * wired after M-01/M-02 exist. It exists now; here is the wire. */
function assertStanding(world: World): void {
  const byPrefix = (prefix: string): Record<string, unknown>[] =>
    [...world.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([, doc]) => doc);
  const result = checkStandingRecords({
    corporations: [...world.entries()]
      .filter(([path]) => path.includes("/corporations/"))
      .map(([, doc]) => doc),
    deposits: [],
    loans: [],
    memberAccounts: byPrefix("sim_member_accounts/"),
    cities: [...world.entries()]
      .filter(([path]) => /^sim_cities\/[^/]+$/.test(path))
      .map(([, doc]) => doc),
    holdings: byPrefix("sim_holdings/"),
  });
  assert.ok(
    result.ok,
    `standing-records findings: ${result.findings.map((f) => `${f.code}: ${f.message}`).join(" | ")}`
  );
}

function runAction(world: World, action: SimAction, prepared?: PreparedPayload): ResolutionPlan {
  const descriptor = KIND_TO_DESCRIPTOR[action.actionType];
  assert.ok(descriptor, `no descriptor classifies ${action.actionType}`);
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

/** Drive the M-06 composer directly (it is a resolver step, like
 * cat2's F-06 drive): compose into an empty plan, finish with a
 * summary, and run the same validatePlan + conservation proof. */
function runRepricing(
  world: World,
  args: {
    corporationId: string;
    homeCityId: string;
    judgment?: { quality: number; scale: number; importance: number } | null;
    stepCapException?: "dissolution" | "tier2-case-against-company" | null;
  }
): ReturnType<typeof composeMarketRepricing> {
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const [path, doc] of world) docs.set(path, doc);
  const snapshot = snapshotFromDocs(docs, NOW, []);
  const beforeWorld: World = new Map(world);
  const plan = emptyPlan("M-06");
  const outcome = composeMarketRepricing({
    plan,
    snapshot,
    actor: memberActor("ownerA"),
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    judgment: args.judgment ?? null,
    judgmentRationale: null,
    judgmentInputHash: null,
    stepCapException: args.stepCapException ?? null,
    invokedByRuleId: "M-02",
  });
  if (plan.entries.length > 0) {
    plan.entries.push({
      kind: "action-summary",
      summary: true,
      actor: memberActor("ownerA"),
      actionId: "act_m06_drive",
      actionText: "M-06 drive (harness)",
      classification: { verb: "reprice", scope: "company", ruleIds: ["M-06"], unruled: false },
      cityId: args.homeCityId,
      cityIds: [args.homeCityId],
      ruleIds: ["M-06"],
      changes: [],
      spilloverFromSeq: null,
      causedBySeq: null,
      correctsSeq: null,
      recordsCreated: [],
      recordsUpdated: [],
      legal: null,
      chronicleDraftId: null,
      major: false,
      summaryText: "M-06 drive summary (harness).",
      visibility: "public",
      baseline: null,
      pendingId: null,
      generation: null,
    });
    validatePlan(plan, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot });
    finalizePlan(plan);
    assertConservation(beforeWorld, plan, "m06-drive");
    applyPlan(world, plan);
  }
  return outcome;
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code, `expected rejection code ${code}, got ${plan.rejection?.code}`);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
}

const entryTexts = (plan: ResolutionPlan): string => plan.entries.map((e) => e.summaryText).join("\n");

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`ok ${checks} - ${label}`);
}

// ---------------------------------------------------------------------------
// Fixture world + seed helpers
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
  world.set("sim_cities/cityA", { factionId: "cityA", ...cityDoc({}) });
  world.set("sim_cities/cityB", { factionId: "cityB", ...cityDoc({ gdpRubars: 500000, treasuryRubars: 5000, population: 50 }) });
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
    listed?: boolean;
    status?: string;
    companyCashRubars?: number;
    taxPayables?: Record<string, number>;
    linkedStructureIds?: string[];
    marketCityIds?: string[];
    paidInCapitalRubars?: number;
    sharesOutstanding?: number;
    openingReferencePriceRubars?: number | null;
    lastJudgment?: { quality: number; scale: number; importance: number; inputHash: string | null } | null;
    legacyBookRubars?: number | null;
    earningsProxyRubars?: number;
  }
): string {
  const path = `sim_cities/${args.homeCityId}/corporations/${args.corporationId}`;
  const doc: Record<string, unknown> = {
    ...buildCorporationDoc({
      corporationId: args.corporationId,
      name: `${args.corporationId} Co`,
      industry: "industrial",
      ownerMemberId: args.ownerMemberId,
      founderFigureId: null,
      homeCityId: args.homeCityId,
      marketCityIds: args.marketCityIds ?? [],
      valuationRubars: 0,
      legacyBookRubars: args.legacyBookRubars ?? null,
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
    paidInCapitalRubars: args.paidInCapitalRubars ?? 0,
    sharesOutstanding: args.sharesOutstanding ?? 0,
    openingReferencePriceRubars: args.openingReferencePriceRubars ?? null,
    lastJudgment: args.lastJudgment ?? null,
    ...(args.earningsProxyRubars !== undefined ? { earningsProxyRubars: args.earningsProxyRubars } : {}),
  };
  world.set(path, doc);
  return path;
}

function seedListing(
  world: World,
  args: {
    corporationId: string;
    homeCityId: string;
    ownerMemberId: string;
    openingPriceRubars: number;
    committedFloatShares?: number;
    publicHeldShares?: number;
  }
): void {
  world.set(
    listingPath(args.corporationId),
    buildListingDoc({
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      ownerMemberId: args.ownerMemberId,
      openingPriceRubars: args.openingPriceRubars,
      committedFloatShares: args.committedFloatShares ?? 0,
      listedAtSeq: 1,
      sourceActionId: "seed",
      lastResolutionId: "seed",
      now: new Date(NOW),
    })
  );
  if (args.publicHeldShares) {
    const doc = world.get(listingPath(args.corporationId)) as Record<string, unknown>;
    world.set(listingPath(args.corporationId), { ...doc, publicHeldShares: args.publicHeldShares });
  }
}

function seedHolding(
  world: World,
  args: {
    memberId: string;
    corporationId: string;
    homeCityId: string;
    quantityShares: number;
    committedShares?: number;
    costBasisRubars?: number;
  }
): void {
  world.set(
    holdingPath(args.memberId, args.corporationId),
    buildHoldingDoc({
      memberId: args.memberId,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      quantityShares: args.quantityShares,
      committedShares: args.committedShares ?? 0,
      costBasisRubars: args.costBasisRubars ?? 0,
      sourceActionId: "seed",
      sourceSeq: 1,
      lastResolutionId: "seed",
      now: new Date(NOW),
    })
  );
}

function seedFloatOffer(
  world: World,
  args: { corporationId: string; homeCityId: string; founderMemberId: string; quantityShares: number; priceRubars: number; placedAtSeq?: number }
): void {
  world.set(
    orderPath(`float_${args.corporationId}`),
    buildOrderDoc({
      orderId: `float_${args.corporationId}`,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      memberId: args.founderMemberId,
      side: "sell",
      type: "limit",
      kind: "float-offer",
      quantityShares: args.quantityShares,
      limitPriceRubars: args.priceRubars,
      placedAtSeq: args.placedAtSeq ?? 1,
      expiresAtSeq: null,
      sourceActionId: "seed",
      lastResolutionId: "seed",
      now: new Date(NOW),
    })
  );
}

function seedStructure(
  world: World,
  cityId: string,
  structureId: string,
  args: { status?: string; condition?: number; totalBudgetRubars?: number }
): void {
  world.set(`sim_cities/${cityId}/structures/${structureId}`, {
    structureId,
    name: structureId,
    kind: "industrial",
    status: args.status ?? "complete",
    condition: args.condition ?? 100,
    totalBudgetRubars: args.totalBudgetRubars ?? 5000,
    profile: { supports: [] },
    sourceActionId: "seed",
    sourceSeq: 1,
  });
}

const judgmentPayload = (quality: number, scale: number, importance: number): PreparedPayload => ({
  classification: { judgment: { quality, scale, importance } },
  inputHash: "harness-judgment-1",
});

const accountCash = (world: World, memberId: string): number =>
  world.get(`sim_member_accounts/${memberId}`)?.cashRubars as number;
const marketCash = (world: World): number =>
  world.get("sim_market_account/main")?.cashRubars as number;
const corpDoc = (world: World, homeCityId: string, corporationId: string): Record<string, unknown> => {
  const doc = world.get(`sim_cities/${homeCityId}/corporations/${corporationId}`);
  assert.ok(doc, `corporation ${corporationId} stands in ${homeCityId}`);
  return doc;
};
const listingDoc = (world: World, corporationId: string): Record<string, unknown> => {
  const doc = world.get(listingPath(corporationId));
  assert.ok(doc, `listing ${corporationId} stands`);
  return doc;
};
const holdingDoc = (world: World, memberId: string, corporationId: string): Record<string, unknown> => {
  const doc = world.get(holdingPath(memberId, corporationId));
  assert.ok(doc, `holding ${memberId}/${corporationId} stands`);
  return doc;
};
const orderDoc = (world: World, orderId: string): Record<string, unknown> => {
  const doc = world.get(orderPath(orderId));
  assert.ok(doc, `order ${orderId} stands`);
  return doc;
};

// ---------------------------------------------------------------------------
// M-00 — the Market Account's founding act
// ---------------------------------------------------------------------------

check("M-00: the Market Account founds once, seeded by a closed-list mint; a second founding rejects", () => {
  const world = seedWorld();
  const plan = runAction(world, act("found_market_account", "ownerA", {}));
  assert.equal(plan.outcome, "resolved");
  assert.equal(marketCash(world), 1000000);
  assert.equal(world.get("sim_market_account/main")?.seedRuleId, "M-00");
  // runAction already ran the real conservation checker over the event
  // (mint leg M-00 balanced against the account's creation delta).
  expectRejected(runAction(world, act("found_market_account", "ownerA", {})), "market-already-founded");
  assert.equal(marketCash(world), 1000000, "no second seed was minted");
});

// ---------------------------------------------------------------------------
// World A — the PR #33 storyline: R-06 lists at founding (no market
// records exist), the backfill planner names the gap, M-01 completes
// it, and the completed market trades.
// ---------------------------------------------------------------------------

function worldA(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 300000);
  seedAccount(world, "memberB", 250000);
  const plan = runAction(world, act("found_corporation", "ownerA", {
    cityId: "cityA", corporationId: "corpF", name: "Founding Listed Co", industry: "industrial",
    listAtFounding: true, paidInCapitalRubars: 100000, sharesIssued: 1000, fundingSource: "personal",
  }), judgmentPayload(80, 60, 40));
  assert.equal(plan.outcome, "resolved");
  return world;
}

check("M-01 founder-holding case: an R-06 listed founding stands with NO market records; the planner names the exact gap", () => {
  const world = worldA();
  const corp = corpDoc(world, "cityA", "corpF");
  assert.equal(corp.listed, true);
  assert.equal(corp.openingReferencePriceRubars, 140); // round(100,000 x 1.4 / 1,000)
  assert.equal(world.get(listingPath("corpF")), undefined, "no listing record stands before step 7 acts");
  assert.equal(world.get(holdingPath("ownerA", "corpF")), undefined, "no founder holding stands before step 7 acts");
  const gaps = planFounderHoldingBackfill([corp], [], []);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].corporationId, "corpF");
  assert.equal(gaps[0].expectedFounderShares, 1000);
  assert.equal(gaps[0].standingFounderShares, 0);
  assert.equal(gaps[0].missingShares, 1000);
  // And trading is impossible until completion: no listing record.
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpF", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 1, limitPriceRubars: 140,
    })),
    "not-listed"
  );
});

check("M-01 completion branch: listing record + founder holding are created from the founding figures (the planner's repair, as the owner's act)", () => {
  const world = worldA();
  const plan = runAction(world, act("list_company", "ownerA", {
    corporationId: "corpF", homeCityId: "cityA", floatShares: 200,
  }));
  assert.equal(plan.outcome, "resolved");
  const listing = listingDoc(world, "corpF");
  assert.equal(listing.referencePriceRubars, 140);
  assert.equal(listing.officialPriceRubars, 140);
  assert.equal(listing.tradingStatus, "open");
  assert.equal(listing.committedFloatShares, 200);
  const holding = holdingDoc(world, "ownerA", "corpF");
  assert.equal(holding.quantityShares, 1000);
  assert.equal(holding.committedShares, 200);
  assert.equal(holding.costBasisRubars, 100000, "founding shares enter at their paid-in basis");
  const offer = orderDoc(world, "float_corpF");
  assert.equal(offer.status, "resting");
  assert.equal(offer.quantityShares, 200);
  assert.equal(offer.limitPriceRubars, 140);
  assert.equal(offer.kind, "float-offer");
  // The first positive-float listing anchors the index divisor (§3.2).
  assert.equal(world.get("sim_market_account/main")?.indexDivisorBaseRubars, 28000); // 140 x 200
  assert.equal(world.get("sim_market_account/main")?.genesisListingCorporationId, "corpF");
  // The planner now reports no gap, and standing share conservation holds.
  assert.deepEqual(planFounderHoldingBackfill([corpDoc(world, "cityA", "corpF")], [holding], [listing]), []);
  assertStanding(world);
});

check("M-03/M-04: a market buy executes against the founder's float offer at the resting price; fees reach the Market Account, proceeds reach the founder (custody, P4-K21)", () => {
  const world = worldA();
  runAction(world, act("list_company", "ownerA", { corporationId: "corpF", homeCityId: "cityA", floatShares: 200 }));
  const plan = runAction(world, act("place_order", "memberB", {
    corporationId: "corpF", homeCityId: "cityA", side: "buy", orderType: "market",
    quantityShares: 10, protectionPriceRubars: 200,
  }));
  assert.equal(plan.outcome, "resolved");
  // Value 10 x 140 = 1,400; fee ceil(1,400 x 0.25%) = 4 per side.
  assert.equal(accountCash(world, "memberB"), 250000 - 1404);
  assert.equal(accountCash(world, "ownerA"), 200000 + 1396, "float sales credit the FOUNDER, never an MM inventory (P4-K21)");
  assert.equal(marketCash(world), 1000000 + 8);
  const buyerHolding = holdingDoc(world, "memberB", "corpF");
  assert.equal(buyerHolding.quantityShares, 10);
  assert.equal(buyerHolding.costBasisRubars, 1400, "cost basis is price x qty; fees are not basis");
  const founderHolding = holdingDoc(world, "ownerA", "corpF");
  assert.equal(founderHolding.quantityShares, 990);
  assert.equal(founderHolding.committedShares, 190);
  assert.equal(orderDoc(world, "float_corpF").quantityShares, 190);
  const listing = listingDoc(world, "corpF");
  assert.equal(listing.lastTradePriceRubars, 140);
  assert.equal(listing.officialPriceRubars, 140);
  assert.equal(listing.committedFloatShares, 190);
  assert.equal(listing.publicHeldShares, 10);
  const trade = [...world.values()].find((d) => typeof d.tradeId === "string");
  assert.ok(trade, "a trade record stands on the tape");
  assert.equal(trade?.priceRubars, 140);
  assertStanding(world);
});

check("M-03: a limit sell rests with its shares committed; selling beyond free shares rejects at validation", () => {
  const world = worldA();
  runAction(world, act("list_company", "ownerA", { corporationId: "corpF", homeCityId: "cityA", floatShares: 200 }));
  runAction(world, act("place_order", "memberB", {
    corporationId: "corpF", homeCityId: "cityA", side: "buy", orderType: "market", quantityShares: 10, protectionPriceRubars: 200,
  }));
  const plan = runAction(world, act("place_order", "memberB", {
    corporationId: "corpF", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 4, limitPriceRubars: 150,
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(holdingDoc(world, "memberB", "corpF").committedShares, 4);
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpF", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 7, limitPriceRubars: 150,
    })),
    "insufficient-free-shares"
  );
});

check("M-03/M-04: self-match is prevented — the founder's buy crosses another member's sell and skips the founder's own float offer", () => {
  const world = worldA();
  runAction(world, act("list_company", "ownerA", { corporationId: "corpF", homeCityId: "cityA", floatShares: 200 }));
  runAction(world, act("place_order", "memberB", {
    corporationId: "corpF", homeCityId: "cityA", side: "buy", orderType: "market", quantityShares: 10, protectionPriceRubars: 200,
  }));
  runAction(world, act("place_order", "memberB", {
    corporationId: "corpF", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 4, limitPriceRubars: 150,
  }));
  const plan = runAction(world, act("place_order", "ownerA", {
    corporationId: "corpF", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 5, limitPriceRubars: 200,
  }));
  assert.equal(plan.outcome, "resolved");
  const classification = plan.entries[plan.entries.length - 1].classification as Record<string, unknown>;
  const marketOrder = classification.marketOrder as Record<string, unknown>;
  assert.equal(marketOrder.selfMatchSkipped, true, "the founder's own float offer was skipped, and the skip is on the record");
  assert.equal(marketOrder.filledShares, 4, "filled against memberB's sell at ITS resting price of 150, not the founder's 140 offer");
  // 4 x 150 = 600; fee ceil(600 x 0.25%) = 2 per side.
  assert.equal(accountCash(world, "ownerA"), 200000 + 1396 - 602);
  assert.equal(accountCash(world, "memberB"), 250000 - 1404 + 598);
  assert.equal(holdingDoc(world, "memberB", "corpF").quantityShares, 6);
  assert.equal(holdingDoc(world, "ownerA", "corpF").quantityShares, 994);
  assert.equal(listingDoc(world, "corpF").publicHeldShares, 6);
  assert.equal(listingDoc(world, "corpF").lastTradePriceRubars, 150);
  assertStanding(world);
});

// ---------------------------------------------------------------------------
// World B — transfers, D-5 crossing re-validation, cancels, expiry
// ---------------------------------------------------------------------------

function worldB(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 200000);
  seedAccount(world, "memberC", 1010);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpT", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 100000, paidInCapitalRubars: 100000, sharesOutstanding: 1000,
    openingReferencePriceRubars: 140, lastJudgment: { quality: 80, scale: 60, importance: 40, inputHash: "seed" },
  });
  seedListing(world, { corporationId: "corpT", homeCityId: "cityA", ownerMemberId: "ownerA", openingPriceRubars: 140 });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpT", homeCityId: "cityA", quantityShares: 1000, costBasisRubars: 100000 });
  return world;
}

check("M-04 transfer path: zero-price, zero-fee (fee line stated), no price prints", () => {
  const world = worldB();
  const plan = runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpT", homeCityId: "cityA", toMemberId: "memberD", quantityShares: 20,
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(holdingDoc(world, "memberD", "corpT").quantityShares, 20);
  assert.equal(holdingDoc(world, "ownerA", "corpT").quantityShares, 980);
  assert.ok(entryTexts(plan).includes("buyer fee 0 R; seller fee 0 R"), "the fee line stands in the entry even at zero (§5.3)");
  assert.equal(listingDoc(world, "corpT").lastTradePriceRubars, null, "a transfer never prints a price");
  assert.equal(accountCash(world, "ownerA"), 200000, "no cash moves on a zero-price transfer");
  assertStanding(world);
});

check("M-03/D-5: a resting buyer who cannot cover at crossing is cancelled in-event (cancelled-insufficient-cash) and the incoming sell cancels its remainder", () => {
  const world = worldB();
  runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpT", homeCityId: "cityA", toMemberId: "memberD", quantityShares: 20,
  }));
  const buyPlan = runAction(world, act("place_order", "memberC", {
    corporationId: "corpT", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 10, limitPriceRubars: 100,
  }));
  assert.equal(buyPlan.outcome, "resolved");
  const buyClassification = buyPlan.entries[buyPlan.entries.length - 1].classification as Record<string, unknown>;
  const restingBuyId = (buyClassification.marketOrder as Record<string, unknown>).orderId as string;
  assert.equal(orderDoc(world, restingBuyId).status, "resting");
  // memberC lawfully spends most of the cash elsewhere (an F-02-class
  // spend this harness world-edits, as cat2 world-edits funding): the
  // resting buy carries NO reservation (D-5), so crossing re-validates.
  const account = world.get("sim_member_accounts/memberC") as Record<string, unknown>;
  world.set("sim_member_accounts/memberC", { ...account, cashRubars: 500 });
  const sellPlan = runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "sell", orderType: "market", quantityShares: 10, protectionPriceRubars: 90,
  }));
  assert.equal(sellPlan.outcome, "resolved");
  const cancelled = orderDoc(world, restingBuyId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelReason, "insufficient-cash-at-settlement");
  assert.ok(entryTexts(sellPlan).includes("cancelled-insufficient-cash"), "the cancellation and its reason are logged in the crossing event");
  assert.equal(holdingDoc(world, "memberD", "corpT").quantityShares, 20, "no shares moved — the execution was discarded, not settled into a negative");
  assert.equal(accountCash(world, "memberC"), 500, "the resting buyer's cash is untouched");
  assert.equal([...world.keys()].filter((k) => k.startsWith("sim_market_trades/")).length, 0, "no trade printed");
  assertStanding(world);
});

check("M-05: owner-only cancels release commitments; cancel-all sweeps the actor's book on the listing", () => {
  const world = worldB();
  runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpT", homeCityId: "cityA", toMemberId: "memberD", quantityShares: 20,
  }));
  const sellPlan = runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 5, limitPriceRubars: 130,
  }));
  const sellClassification = sellPlan.entries[sellPlan.entries.length - 1].classification as Record<string, unknown>;
  const sellOrderId = (sellClassification.marketOrder as Record<string, unknown>).orderId as string;
  assert.equal(holdingDoc(world, "memberD", "corpT").committedShares, 5);
  expectRejected(
    runAction(world, act("cancel_order", "ownerA", { corporationId: "corpT", homeCityId: "cityA", orderId: sellOrderId })),
    "not-order-owner"
  );
  const cancelPlan = runAction(world, act("cancel_order", "memberD", { corporationId: "corpT", homeCityId: "cityA", orderId: sellOrderId }));
  assert.equal(cancelPlan.outcome, "resolved");
  assert.equal(orderDoc(world, sellOrderId).status, "cancelled");
  assert.equal(holdingDoc(world, "memberD", "corpT").committedShares, 0, "the commitment released");
  runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 3, limitPriceRubars: 130,
  }));
  runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "sell", orderType: "limit", quantityShares: 2, limitPriceRubars: 135,
  }));
  const allPlan = runAction(world, act("cancel_order", "memberD", { corporationId: "corpT", homeCityId: "cityA", allForListing: true }));
  assert.equal(allPlan.outcome, "resolved");
  const resting = [...world.values()].filter((d) => d.status === "resting" && d.corporationId === "corpT");
  assert.equal(resting.length, 0, "cancel-all left nothing of memberD's resting");
  assert.equal(holdingDoc(world, "memberD", "corpT").committedShares, 0);
  assertStanding(world);
});

check("M-05 expiry: a resting order whose expiresAtSeq passes is expired by the next event that touches the listing — never by a timer", () => {
  const world = worldB();
  runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpT", homeCityId: "cityA", toMemberId: "memberD", quantityShares: 20,
  }));
  const head = world.get("sim_counters/log")?.lastSeq as number;
  const expiring = runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "buy", orderType: "limit",
    quantityShares: 2, limitPriceRubars: 50, expiresAtSeq: head + 2,
  }));
  assert.equal(expiring.outcome, "resolved");
  const classification = expiring.entries[expiring.entries.length - 1].classification as Record<string, unknown>;
  const expiringId = (classification.marketOrder as Record<string, unknown>).orderId as string;
  assert.equal(orderDoc(world, expiringId).status, "resting", "it rests until a later event evaluates it");
  const touching = runAction(world, act("place_order", "memberD", {
    corporationId: "corpT", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 1, limitPriceRubars: 50,
  }));
  assert.equal(touching.outcome, "resolved");
  assert.ok(entryTexts(touching).includes("M-05 expiry evaluated in this event"), "the expiry is logged in the touching event");
  assert.equal(orderDoc(world, expiringId).status, "expired");
  assertStanding(world);
});

// ---------------------------------------------------------------------------
// World C — M-01 full listing: judgment discipline + eligibility
// ---------------------------------------------------------------------------

check("M-01 full listing: judgment comes only from the prepared payload (action-carried scores are never read); eligibility refuses honestly", () => {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 300000);
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA" });
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpDead", ownerMemberId: "ownerA", status: "dissolved" });
  // No payload — even though the ACTION names perfect scores.
  expectRejected(
    runAction(world, act("list_company", "ownerA", {
      corporationId: "corpU", homeCityId: "cityA", paidInCapitalRubars: 50000, sharesIssued: 500, floatShares: 100,
      judgment: { quality: 100, scale: 100, importance: 100 },
    })),
    "judgment-required"
  );
  expectRejected(
    runAction(world, act("list_company", "ownerB", {
      corporationId: "corpU", homeCityId: "cityA", paidInCapitalRubars: 50000, sharesIssued: 500,
    }), judgmentPayload(60, 60, 60)),
    "not-company-owner"
  );
  expectRejected(
    runAction(world, act("list_company", "ownerA", {
      corporationId: "corpU", homeCityId: "cityA", paidInCapitalRubars: 0, sharesIssued: 500,
    }), judgmentPayload(60, 60, 60)),
    "listing-unpriced"
  );
  expectRejected(
    runAction(world, act("list_company", "ownerA", {
      corporationId: "corpDead", homeCityId: "cityA", paidInCapitalRubars: 50000, sharesIssued: 500,
    }), judgmentPayload(60, 60, 60)),
    "company-dissolved"
  );
  assert.equal(world.get(listingPath("corpU")), undefined, "every refusal left no half-listed shell");
});

check("M-01 full listing: capital moves, shares issue, the opening price is the §4.4 formula over post-money inputs, the index anchors", () => {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 300000);
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU", ownerMemberId: "ownerA" });
  const plan = runAction(world, act("list_company", "ownerA", {
    corporationId: "corpU", homeCityId: "cityA", paidInCapitalRubars: 50000, sharesIssued: 500, floatShares: 100,
  }), judgmentPayload(60, 60, 60));
  assert.equal(plan.outcome, "resolved");
  // Fundamental = post-money cash 50,000; multiplier 1.4 (mean 60) ->
  // cap 70,000 -> opening price round(70,000 / 500) = 140.
  const corp = corpDoc(world, "cityA", "corpU");
  assert.equal(corp.listed, true);
  assert.equal(corp.sharesOutstanding, 500);
  assert.equal(corp.paidInCapitalRubars, 50000);
  assert.equal(corp.companyCashRubars, 50000);
  assert.equal(corp.openingReferencePriceRubars, 140);
  assert.equal(corp.valuationRubars, 70000);
  assert.deepEqual(
    { q: (corp.lastJudgment as Record<string, unknown>).quality, s: (corp.lastJudgment as Record<string, unknown>).scale, i: (corp.lastJudgment as Record<string, unknown>).importance },
    { q: 60, s: 60, i: 60 }
  );
  assert.equal(accountCash(world, "ownerA"), 250000);
  const listing = listingDoc(world, "corpU");
  assert.equal(listing.referencePriceRubars, 140);
  assert.equal(listing.officialPriceRubars, 140);
  assert.equal(listing.committedFloatShares, 100);
  const holding = holdingDoc(world, "ownerA", "corpU");
  assert.equal(holding.quantityShares, 500);
  assert.equal(holding.committedShares, 100);
  assert.equal(holding.costBasisRubars, 50000);
  assert.equal(world.get("sim_market_account/main")?.indexDivisorBaseRubars, 14000); // 140 x float 100
  expectRejected(
    runAction(world, act("list_company", "ownerA", {
      corporationId: "corpU", homeCityId: "cityA", paidInCapitalRubars: 1000, sharesIssued: 10,
    }), judgmentPayload(60, 60, 60)),
    "already-listed"
  );
  assertStanding(world);
});

// ---------------------------------------------------------------------------
// World D — M-06 driven directly: the closed input list, the ±25%
// boundary, and no shadow prices
// ---------------------------------------------------------------------------

function worldD(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpV", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 10000, sharesOutstanding: 100, openingReferencePriceRubars: 100,
    lastJudgment: { quality: 50, scale: 50, importance: 50, inputHash: "seed" },
    legacyBookRubars: 999999999,
  });
  seedListing(world, { corporationId: "corpV", homeCityId: "cityA", ownerMemberId: "ownerA", openingPriceRubars: 100 });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpV", homeCityId: "cityA", quantityShares: 100, costBasisRubars: 10000 });
  return world;
}

check("M-06: legacyBookRubars is provably absent from the repricing inputs (P4-G6) — the price derives from coded inputs alone", () => {
  const world = worldD();
  const outcome = runRepricing(world, { corporationId: "corpV", homeCityId: "cityA" });
  assert.equal(outcome.status, "repriced");
  assert.ok(outcome.inputs, "inputs were assembled");
  assert.ok(!("legacyBookRubars" in outcome.inputs), "the closed input list has no legacyBookRubars key — structurally absent, not merely unused");
  assert.deepEqual(
    Object.keys(outcome.inputs).sort(),
    ["companyCashRubars", "downtimeFlag", "earningsProxyRubars", "legalExposureTier", "operatingCitiesCount", "operatingStructureValueRubars", "sharesOutstanding"]
  );
  assert.equal(outcome.inputs.companyCashRubars, 10000);
  // Fundamental 10,000 x multiplier 1.25 (scores 50/50/50) = 12,500
  // over 100 shares -> uncapped 125. The record's legacyBookRubars of
  // 999,999,999 plays no part: priced from cash, it would be absurd.
  assert.equal(outcome.uncappedPriceRubars, 125);
  assert.equal(corpDoc(world, "cityA", "corpV").legacyBookRubars, 999999999, "the book figure stands as provenance, untouched and unused");
  assert.equal(corpDoc(world, "cityA", "corpV").valuationRubars, 12500);
});

check("M-06 step cap at the exact boundary: +25.0% applies in full; +26% is capped with the uncapped figure logged; no shadow price carries forward", () => {
  const world = worldD();
  const first = runRepricing(world, { corporationId: "corpV", homeCityId: "cityA" });
  assert.equal(first.appliedPriceRubars, 125, "exactly +25% from the prior reference of 100 — the boundary applies in full");
  assert.equal(first.capApplied, false);
  // Re-price from a prior of 100 again (world-edited reference stands
  // in for a second company's prior state) with cash for +26%.
  const corp = corpDoc(world, "cityA", "corpV");
  world.set("sim_cities/cityA/corporations/corpV", { ...corp, companyCashRubars: 10080 });
  const listing = listingDoc(world, "corpV");
  world.set(listingPath("corpV"), { ...listing, referencePriceRubars: 100, officialPriceRubars: 100 });
  const second = runRepricing(world, { corporationId: "corpV", homeCityId: "cityA" });
  assert.equal(second.uncappedPriceRubars, 126, "10,080 x 1.25 / 100 = 126 — +26% uncapped");
  assert.equal(second.appliedPriceRubars, 125, "capped at exactly +25%");
  assert.equal(second.capApplied, true);
  // No shadow prices: from the capped 125, the SAME inputs now apply
  // their full formula result (126 is within +25% of 125) — the
  // capped difference was never carried forward as an adjustment.
  const third = runRepricing(world, { corporationId: "corpV", homeCityId: "cityA" });
  assert.equal(third.appliedPriceRubars, 126);
  assert.equal(third.capApplied, false);
  // And repricing is idempotent on unchanged inputs: no drift.
  const fourth = runRepricing(world, { corporationId: "corpV", homeCityId: "cityA" });
  assert.equal(fourth.appliedPriceRubars, 126);
  assert.equal(fourth.uncappedPriceRubars, 126);
});

check("M-06: a prepared-payload judgment replaces the carried scores and is recorded as lastJudgment; carried scores are the default", () => {
  const world = worldD();
  const outcome = runRepricing(world, {
    corporationId: "corpV", homeCityId: "cityA",
    judgment: { quality: 100, scale: 100, importance: 100 },
  });
  assert.equal(outcome.judgmentSource, "prepared");
  assert.equal(outcome.scoresUsed?.quality, 100);
  const corp = corpDoc(world, "cityA", "corpV");
  assert.equal((corp.lastJudgment as Record<string, unknown>).quality, 100);
  // Multiplier 2.0: fundamental 10,000 -> cap 20,000 -> uncapped 200;
  // prior reference 100 -> capped at 125.
  assert.equal(outcome.uncappedPriceRubars, 200);
  assert.equal(outcome.appliedPriceRubars, 125);
  assertStanding(world);
});

// ---------------------------------------------------------------------------
// World E — the P4-K22 seam: R-07's listed Contract cash leg refuses,
// M-08 is the lawful leg; then M-09 retires shares through the book
// ---------------------------------------------------------------------------

function worldE(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 200000);
  seedAccount(world, "memberB", 250000);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpD", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 50000, paidInCapitalRubars: 100000, sharesOutstanding: 500,
    openingReferencePriceRubars: 140, lastJudgment: { quality: 60, scale: 60, importance: 60, inputHash: "seed" },
  });
  seedListing(world, {
    corporationId: "corpD", homeCityId: "cityA", ownerMemberId: "ownerA",
    openingPriceRubars: 140, committedFloatShares: 90, publicHeldShares: 10,
  });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpD", homeCityId: "cityA", quantityShares: 490, committedShares: 90, costBasisRubars: 100000 });
  seedHolding(world, { memberId: "memberB", corporationId: "corpD", homeCityId: "cityA", quantityShares: 10, costBasisRubars: 1400 });
  seedFloatOffer(world, { corporationId: "corpD", homeCityId: "cityA", founderMemberId: "ownerA", quantityShares: 90, priceRubars: 140 });
  return world;
}

check("M-08 cash-leg un-block: R-07's listed Contract withdrawal still refuses at the seam (Lead wiring is specified, not taken) — and M-08 pays the same cash out lawfully, pro-rata", () => {
  const world = worldE();
  expectRejected(
    runAction(world, act("contract_corporation", "ownerA", {
      corporationId: "corpD", homeCityId: "cityA", cashWithdrawalRubars: 10000,
    })),
    "cash-leg-requires-market-module"
  );
  assert.equal(corpDoc(world, "cityA", "corpD").companyCashRubars, 50000, "the refusal moved nothing");
  const plan = runAction(world, act("declare_distribution", "ownerA", {
    corporationId: "corpD", homeCityId: "cityA", totalRubars: 10000,
  }));
  assert.equal(plan.outcome, "resolved");
  // Pro-rata over 500 live shares: founder 490 -> 9,800; memberB 10 -> 200.
  assert.equal(accountCash(world, "ownerA"), 200000 + 9800);
  assert.equal(accountCash(world, "memberB"), 250000 + 200);
  assert.equal(corpDoc(world, "cityA", "corpD").companyCashRubars, 40000);
  // In-event M-06: fundamental 40,000 x 1.4 = 56,000 -> price 112;
  // no trade has printed, so the official price is the reference.
  assert.equal(listingDoc(world, "corpD").referencePriceRubars, 112);
  assert.equal(listingDoc(world, "corpD").officialPriceRubars, 112);
  assert.equal(corpDoc(world, "cityA", "corpD").valuationRubars, 56000);
  assertStanding(world);
});

check("M-08: a distribution beyond company cash refuses in full — never trimmed silently", () => {
  const world = worldE();
  expectRejected(
    runAction(world, act("declare_distribution", "ownerA", {
      corporationId: "corpD", homeCityId: "cityA", totalRubars: 50001,
    })),
    "distribution-exceeds-cash"
  );
  assert.equal(corpDoc(world, "cityA", "corpD").companyCashRubars, 50000);
  assert.equal(accountCash(world, "ownerA"), 200000);
});

check("M-09: the buyback executes through the book against the float offer, retires the shares, and the in-event print supersedes the repriced reference for the official price (§4.1)", () => {
  const world = worldE();
  runAction(world, act("declare_distribution", "ownerA", {
    corporationId: "corpD", homeCityId: "cityA", totalRubars: 10000,
  }));
  const plan = runAction(world, act("buy_back_shares", "ownerA", {
    corporationId: "corpD", homeCityId: "cityA", maxQuantityShares: 10, capPriceRubars: 150,
  }));
  assert.equal(plan.outcome, "resolved");
  // Fill: 10 @ 140 = 1,400 value; fees 4 company / 4 founder.
  assert.equal(corpDoc(world, "cityA", "corpD").companyCashRubars, 40000 - 1404);
  assert.equal(accountCash(world, "ownerA"), 200000 + 9800 + 1396);
  assert.equal(marketCash(world), 1000000 + 8);
  const corp = corpDoc(world, "cityA", "corpD");
  assert.equal(corp.retiredShares, 10);
  assert.equal(corp.sharesOutstanding, 500, "cumulative issued stands — retirements accumulate in retiredShares (D-4)");
  assert.equal(holdingDoc(world, "ownerA", "corpD").quantityShares, 480);
  assert.equal(holdingDoc(world, "ownerA", "corpD").committedShares, 80);
  assert.equal(listingDoc(world, "corpD").committedFloatShares, 80);
  // M-06 in-event: cash 38,596 x 1.4 = 54,034 over 490 live -> 110.
  assert.equal(listingDoc(world, "corpD").referencePriceRubars, 110);
  // But a trade printed in the same event: official = the print (§4.1).
  assert.equal(listingDoc(world, "corpD").officialPriceRubars, 140);
  assert.equal(corp.valuationRubars, 140 * 490);
  assertStanding(world); // 480 + 10 held + 10 retired == 500 issued
});

// ---------------------------------------------------------------------------
// World F — M-10 liquidation waterfall
// ---------------------------------------------------------------------------

check("M-10: the waterfall pays payables to treasuries first, then holders pro-rata; salvage is disclosed, never paid; shares retire and the listing delists", () => {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 100000);
  seedAccount(world, "memberB", 50000);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpL", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 10000, taxPayables: { cityB: 1000 }, sharesOutstanding: 500,
    paidInCapitalRubars: 20000, openingReferencePriceRubars: 40,
    lastJudgment: { quality: 50, scale: 50, importance: 50, inputHash: "seed" },
    linkedStructureIds: ["plant1"],
  });
  seedStructure(world, "cityA", "plant1", { totalBudgetRubars: 7000 });
  seedListing(world, { corporationId: "corpL", homeCityId: "cityA", ownerMemberId: "ownerA", openingPriceRubars: 40 });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpL", homeCityId: "cityA", quantityShares: 300, costBasisRubars: 20000 });
  seedHolding(world, { memberId: "memberB", corporationId: "corpL", homeCityId: "cityA", quantityShares: 200, committedShares: 50, costBasisRubars: 8000 });
  world.set(orderPath("ord_seed_1"), buildOrderDoc({
    orderId: "ord_seed_1", corporationId: "corpL", homeCityId: "cityA", memberId: "memberB",
    side: "sell", type: "limit", kind: "standard", quantityShares: 50, limitPriceRubars: 45,
    placedAtSeq: 1, expiresAtSeq: null, sourceActionId: "seed", lastResolutionId: "seed", now: new Date(NOW),
  }));
  expectRejected(
    runAction(world, act("liquidate_company", "ownerB", { corporationId: "corpL", homeCityId: "cityA" })),
    "not-company-owner"
  );
  const plan = runAction(world, act("liquidate_company", "ownerA", { corporationId: "corpL", homeCityId: "cityA" }));
  assert.equal(plan.outcome, "resolved");
  // Payables first: cityB treasury 5,000 + 1,000.
  assert.equal((world.get("sim_cities/cityB")?.stats as Record<string, unknown>).treasuryRubars, 6000);
  // Distributable 9,000 over 500 shares: founder 300 -> 5,400; memberB 200 -> 3,600; dust 0.
  assert.equal(accountCash(world, "ownerA"), 100000 + 5400);
  assert.equal(accountCash(world, "memberB"), 50000 + 3600);
  const corp = corpDoc(world, "cityA", "corpL");
  assert.equal(corp.companyCashRubars, 0);
  assert.equal(corp.status, "dissolved");
  assert.equal(corp.valuationRubars, 0);
  assert.equal(corp.retiredShares, 500);
  assert.deepEqual(corp.taxPayables, {});
  assert.equal(world.get(holdingPath("ownerA", "corpL")), undefined, "holdings are deleted in the liquidation event");
  assert.equal(world.get(holdingPath("memberB", "corpL")), undefined);
  const listing = listingDoc(world, "corpL");
  assert.equal(listing.status, "delisted");
  assert.equal(listing.tradingStatus, "delisted");
  assert.equal(listing.finalLiquidationPriceRubars, 18); // round(9,000 / 500)
  const cancelled = orderDoc(world, "ord_seed_1");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelReason, "listing-liquidated");
  assert.ok(entryTexts(plan).includes("DISCLOSED at 7000 R"), "the salvage line is printed as a disclosure (D-7) — and the payments above prove it was not paid");
  assertStanding(world); // 0 held + 500 retired == 500 issued
  expectRejected(
    runAction(world, act("liquidate_company", "ownerA", { corporationId: "corpL", homeCityId: "cityA" })),
    "company-dissolved"
  );
});

// ---------------------------------------------------------------------------
// World G — M-02 branches
// ---------------------------------------------------------------------------

function worldG(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 300000);
  seedAccount(world, "memberB", 250000);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpI", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 20000, paidInCapitalRubars: 20000, sharesOutstanding: 200,
    openingReferencePriceRubars: 125, lastJudgment: { quality: 50, scale: 50, importance: 50, inputHash: "seed" },
  });
  seedListing(world, { corporationId: "corpI", homeCityId: "cityA", ownerMemberId: "ownerA", openingPriceRubars: 125 });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpI", homeCityId: "cityA", quantityShares: 200, costBasisRubars: 20000 });
  return world;
}

check("M-02 float branches: placement commits behind the standing float offer; recall releases the commitment — shares never move (custody)", () => {
  const world = worldG();
  const place = runAction(world, act("market_issue", "ownerA", {
    corporationId: "corpI", homeCityId: "cityA", branch: "place-float", quantityShares: 50, limitPriceRubars: 130,
  }));
  assert.equal(place.outcome, "resolved");
  assert.equal(orderDoc(world, "float_corpI").quantityShares, 50);
  assert.equal(orderDoc(world, "float_corpI").limitPriceRubars, 130);
  assert.equal(holdingDoc(world, "ownerA", "corpI").committedShares, 50);
  assert.equal(holdingDoc(world, "ownerA", "corpI").quantityShares, 200, "placement moved no shares");
  assert.equal(listingDoc(world, "corpI").committedFloatShares, 50);
  const recall = runAction(world, act("market_issue", "ownerA", {
    corporationId: "corpI", homeCityId: "cityA", branch: "recall-float", quantityShares: 20,
  }));
  assert.equal(recall.outcome, "resolved");
  assert.equal(orderDoc(world, "float_corpI").quantityShares, 30);
  assert.equal(holdingDoc(world, "ownerA", "corpI").committedShares, 30);
  assert.equal(listingDoc(world, "corpI").committedFloatShares, 30);
  expectRejected(
    runAction(world, act("market_issue", "ownerA", {
      corporationId: "corpI", homeCityId: "cityA", branch: "recall-float", quantityShares: 31,
    })),
    "float-recall-exceeds-offer"
  );
  assertStanding(world);
});

check("M-02 issuance: dilution is disclosed exactly per holder, and repricing runs in-event under the step cap", () => {
  const world = worldG();
  runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpI", homeCityId: "cityA", toMemberId: "memberB", quantityShares: 50,
  }));
  const plan = runAction(world, act("market_issue", "ownerA", {
    corporationId: "corpI", homeCityId: "cityA", branch: "issue", newShares: 100, destination: "founder",
  }));
  assert.equal(plan.outcome, "resolved");
  // Before: founder 150/200 = 75.00%, memberB 50/200 = 25.00%.
  // After: founder 250/300 = 83.33%, memberB 50/300 = 16.67%.
  assert.ok(entryTexts(plan).includes("75.00% → 83.33%"), "the founder's dilution line is printed exactly");
  assert.ok(entryTexts(plan).includes("25.00% → 16.67%"), "the minority holder's dilution is printed exactly — disclosure is their protection");
  assert.equal(corpDoc(world, "cityA", "corpI").sharesOutstanding, 300);
  assert.equal(holdingDoc(world, "ownerA", "corpI").quantityShares, 250);
  // Repricing: fundamental 20,000 x 1.25 = 25,000 over 300 -> uncapped
  // 83; prior reference 125 -> the -25% down-cap binds at 94.
  assert.equal(listingDoc(world, "corpI").referencePriceRubars, 94);
  assertStanding(world);
});

check("M-02 inject: personal capital lands in company cash, paid-in capital is maintained, repricing follows; treasury sourcing rejects (P4-K21(ii))", () => {
  const world = worldG();
  expectRejected(
    runAction(world, act("market_issue", "ownerA", {
      corporationId: "corpI", homeCityId: "cityA", branch: "inject", amountRubars: 5000, fundingSource: "treasury",
    })),
    "treasury-source-suspended"
  );
  const plan = runAction(world, act("market_issue", "ownerA", {
    corporationId: "corpI", homeCityId: "cityA", branch: "inject", amountRubars: 5000, fundingSource: "personal",
  }));
  assert.equal(plan.outcome, "resolved");
  assert.equal(corpDoc(world, "cityA", "corpI").companyCashRubars, 25000);
  assert.equal(corpDoc(world, "cityA", "corpI").paidInCapitalRubars, 25000);
  assert.equal(accountCash(world, "ownerA"), 295000);
  // Repricing: 25,000 x 1.25 = 31,250 over 200 -> round = 156; prior
  // reference 125 -> within the cap (max 156) -> 156 applies.
  assert.equal(listingDoc(world, "corpI").referencePriceRubars, 156);
  expectRejected(
    runAction(world, act("market_issue", "memberB", {
      corporationId: "corpI", homeCityId: "cityA", branch: "inject", amountRubars: 100,
    })),
    "not-company-owner"
  );
  assertStanding(world);
});

// ---------------------------------------------------------------------------
// World H — halts, suspension, the economic-only share rule, M-11
// ---------------------------------------------------------------------------

function worldH(): World {
  const world = seedWorld();
  runAction(world, act("found_market_account", "ownerA", {}));
  seedAccount(world, "ownerA", 300000);
  seedAccount(world, "memberB", 250000);
  seedCorp(world, {
    homeCityId: "cityA", corporationId: "corpH", ownerMemberId: "ownerA", listed: true,
    companyCashRubars: 10000, paidInCapitalRubars: 10000, sharesOutstanding: 100,
    openingReferencePriceRubars: 100, lastJudgment: { quality: 50, scale: 50, importance: 50, inputHash: "seed" },
    linkedStructureIds: ["plant1"],
  });
  seedStructure(world, "cityA", "plant1", { totalBudgetRubars: 5000, condition: 100 });
  seedListing(world, { corporationId: "corpH", homeCityId: "cityA", ownerMemberId: "ownerA", openingPriceRubars: 100 });
  seedHolding(world, { memberId: "ownerA", corporationId: "corpH", homeCityId: "cityA", quantityShares: 100, costBasisRubars: 10000 });
  return world;
}

check("M-07: owner suspension blocks orders as listing-suspended; resume reopens", () => {
  const world = worldH();
  const suspend = runAction(world, act("suspend_listing", "ownerA", {
    corporationId: "corpH", homeCityId: "cityA", reason: "going dormant for the season",
  }));
  assert.equal(suspend.outcome, "resolved");
  assert.equal(listingDoc(world, "corpH").tradingStatus, "suspended");
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpH", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 1, limitPriceRubars: 100,
    })),
    "listing-suspended"
  );
  const resume = runAction(world, act("resume_listing", "ownerA", { corporationId: "corpH", homeCityId: "cityA" }));
  assert.equal(resume.outcome, "resolved");
  assert.equal(listingDoc(world, "corpH").tradingStatus, "open");
});

check("M-06/M-07: downtime halts trading in the repricing event; resume refuses while the coded condition holds and lands once it clears", () => {
  const world = worldH();
  // A damaging event's record state (the R-18/R-05 outcome this
  // harness world-edits): the only linked structure stops functioning.
  const plant = world.get("sim_cities/cityA/structures/plant1") as Record<string, unknown>;
  world.set("sim_cities/cityA/structures/plant1", { ...plant, condition: 40 });
  const inject = runAction(world, act("market_issue", "ownerA", {
    corporationId: "corpH", homeCityId: "cityA", branch: "inject", amountRubars: 100, fundingSource: "personal",
  }));
  assert.equal(inject.outcome, "resolved");
  assert.equal(listingDoc(world, "corpH").tradingStatus, "halted");
  assert.equal(listingDoc(world, "corpH").haltReason, "downtime");
  // Repricing still ran (cash 10,100, structures 0, x1.25 -> uncapped
  // 126, capped at +25% -> 125) — a halt never changes a price itself.
  assert.equal(listingDoc(world, "corpH").referencePriceRubars, 125);
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpH", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 1, limitPriceRubars: 100,
    })),
    "listing-halted"
  );
  expectRejected(
    runAction(world, act("resume_listing", "ownerA", { corporationId: "corpH", homeCityId: "cityA" })),
    "halt-condition-holds"
  );
  // The repair event's record state: function restored.
  world.set("sim_cities/cityA/structures/plant1", { ...plant, condition: 100 });
  const resume = runAction(world, act("resume_listing", "ownerA", { corporationId: "corpH", homeCityId: "cityA" }));
  assert.equal(resume.outcome, "resolved");
  assert.equal(listingDoc(world, "corpH").tradingStatus, "open");
  assert.equal(listingDoc(world, "corpH").haltReason, null);
  assertStanding(world);
});

check("Shares are economic-only (OPEN-5): a 90% holder is refused every owner verb exactly like any non-owner", () => {
  const world = worldH();
  runAction(world, act("transfer_shares", "ownerA", {
    corporationId: "corpH", homeCityId: "cityA", toMemberId: "memberB", quantityShares: 90,
  }));
  assert.equal(holdingDoc(world, "memberB", "corpH").quantityShares, 90);
  expectRejected(
    runAction(world, act("declare_distribution", "memberB", { corporationId: "corpH", homeCityId: "cityA", totalRubars: 100 })),
    "not-company-owner"
  );
  expectRejected(
    runAction(world, act("suspend_listing", "memberB", { corporationId: "corpH", homeCityId: "cityA" })),
    "not-company-owner"
  );
  expectRejected(
    runAction(world, act("liquidate_company", "memberB", { corporationId: "corpH", homeCityId: "cityA" })),
    "not-company-owner"
  );
  assertStanding(world);
});

check("M-11 fails closed, M-03 guards stand: corrections need a verdict; unlisted companies take no orders; market orders need a protection cap", () => {
  const world = worldH();
  seedCorp(world, { homeCityId: "cityA", corporationId: "corpU2", ownerMemberId: "ownerA" });
  expectRejected(
    runAction(world, act("correct_market_record", "ownerA", { corporationId: "corpH", homeCityId: "cityA" })),
    "correction-requires-verdict"
  );
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpU2", homeCityId: "cityA", side: "buy", orderType: "limit", quantityShares: 1, limitPriceRubars: 10,
    })),
    "not-listed"
  );
  expectRejected(
    runAction(world, act("place_order", "memberB", {
      corporationId: "corpH", homeCityId: "cityA", side: "buy", orderType: "market", quantityShares: 1,
    })),
    "protection-cap-required"
  );
});

check("Realm index (pure derivation): float-honest labels, the level from the anchored divisor, and the concentration cap that warns but never trades", () => {
  const zeroFloat = deriveRealmIndex(
    [{ corporationId: "corpZ", officialPriceRubars: 100, floatShares: 0, tradingStatus: "open" }],
    14000
  );
  assert.equal(zeroFloat.weights[0].floatLabel, "float: 0 — no tradable supply");
  assert.equal(zeroFloat.totalFloatMarketCapRubars, 0);
  const index = deriveRealmIndex(
    [
      { corporationId: "corpAa", officialPriceRubars: 140, floatShares: 100, tradingStatus: "open" },
      { corporationId: "corpBb", officialPriceRubars: 50, floatShares: 100, tradingStatus: "open" },
      { corporationId: "corpGone", officialPriceRubars: 999, floatShares: 500, tradingStatus: "delisted" },
    ],
    14000
  );
  // (14,000 + 5,000) / 14,000 x 1000 = 1357.14; the delisted company is out (§3.3).
  assert.equal(index.level, 1357.14);
  assert.equal(index.weights.length, 2, "delisted companies exit the composition");
  assert.equal(index.concentrationWarnings.length, 1);
  assert.equal(index.concentrationWarnings[0].corporationId, "corpAa");
});

// ---------------------------------------------------------------------------
// Standing-Log verifier venue (B2.1 §3d): the verify.ts wiring itself.
// The sections above prove the conservation checker's share assertion
// with a hand-fed holdings supply; these checks prove the WIRING —
// that verifyStandingLog collects sim_holdings from the standing
// state and activates the assertion (P4-K21) on its own. Synthetic
// world in the governance harness's mold: a genesis-only Log with no
// manifests (the per-event pass is inert) and standing docs carrying
// lastChangedSeq null (no manifest writer can be claimed for them,
// so no UNLOGGED_STATE fires) — the only findings the standing pass
// can produce here are the ones under test.
// ---------------------------------------------------------------------------

function verifierWorld(args: {
  sharesOutstanding: number;
  retiredShares: number;
  holdings: { memberId: string; quantityShares: number }[];
}): StandingWorld {
  const genesisDraft = {
    ...ruleEffectDraft({
      actor: {
        type: "system", memberId: null, npcId: null, onBehalfOfMemberId: null,
        mandateId: null, mandateVersion: null, envelopeId: null,
      } as SimActor,
      summaryText: "genesis",
    }),
    kind: "genesis" as const,
    summary: true,
  };
  const genesis = buildLogEntry(genesisDraft, {
    seq: 1, resolutionSeq: 1, resolutionId: "genesis", entryIndexWithinResolution: 0,
    resolvedAt: NOW, rulesVersion: "sim-rules-0.5.0-phase5",
    prevHash: "0".repeat(64), wakeActionId: null, executedDuringSeq: null,
  });
  const stateDocs = new Map<string, Record<string, unknown>>();
  stateDocs.set("sim_cities/cityA", { factionId: "cityA", ...cityDoc({}) });
  stateDocs.set("sim_cities/cityA/corporations/corpV", {
    ...buildCorporationDoc({
      corporationId: "corpV", name: "CorpV Co", industry: "industrial",
      ownerMemberId: "ownerA", founderFigureId: null, homeCityId: "cityA",
      valuationRubars: 0, legacyBookRubars: null, sourceActionId: "seed",
      sourceSeq: 1, lastResolutionId: "seed", now: new Date(NOW),
    }),
    listed: true,
    sharesOutstanding: args.sharesOutstanding,
    retiredShares: args.retiredShares,
    lastChangedSeq: null,
  });
  for (const holding of args.holdings) {
    stateDocs.set(holdingPath(holding.memberId, "corpV"), {
      ...buildHoldingDoc({
        memberId: holding.memberId, corporationId: "corpV", homeCityId: "cityA",
        quantityShares: holding.quantityShares, committedShares: 0, costBasisRubars: 0,
        sourceActionId: "seed", sourceSeq: 1, lastResolutionId: "seed", now: new Date(NOW),
      }),
      lastChangedSeq: null,
    });
  }
  return {
    entries: [genesis],
    manifests: new Map<string, Record<string, unknown>>(),
    counter: { lastSeq: 1, lastEntryHash: genesis.entryHash as string },
    world: { lastCommittedSeq: 1 },
    stateDocs,
    baselineRegistry: fixtureRegistry,
  };
}

check("§3d wiring: a listed company whose holdings under-count sharesOutstanding FAILS standing verification (SHARE_CONSERVATION through verifyStandingLog)", () => {
  const world = verifierWorld({
    sharesOutstanding: 1000, retiredShares: 0,
    holdings: [{ memberId: "ownerA", quantityShares: 600 }],
  });
  // Control: the raw checker, given the same corporation WITHOUT the
  // holdings supply, stays silent — the assertion is the wiring's,
  // not the record's.
  const corpDoc = world.stateDocs.get("sim_cities/cityA/corporations/corpV") as Record<string, unknown>;
  const unwired = checkStandingRecords({ corporations: [corpDoc], deposits: [], loans: [] });
  assert.ok(
    !unwired.findings.some((f) => f.code === "SHARE_CONSERVATION"),
    "without the holdings supply the share assertion stays inert"
  );
  const result = verifyStandingLog(world);
  assert.equal(result.ok, false);
  assert.ok(
    result.findings.some((f) => f.code === "SHARE_CONSERVATION"),
    `expected a SHARE_CONSERVATION finding, got: ${JSON.stringify(result.findings)}`
  );
});

check("§3d wiring: holdings + retired == sharesOutstanding verifies clean through verifyStandingLog", () => {
  const result = verifyStandingLog(verifierWorld({
    sharesOutstanding: 1000, retiredShares: 300,
    holdings: [
      { memberId: "ownerA", quantityShares: 650 },
      { memberId: "memberB", quantityShares: 50 },
    ],
  }));
  assert.deepEqual(result.findings, []);
  assert.equal(result.ok, true);
});

console.log(`\nMARKET HARNESS: all ${checks} checks passed (every resolved plan validated by the real validatePlan, conservation-checked by the real finance checker, and standing share conservation asserted with the holdings supply wired).`);
