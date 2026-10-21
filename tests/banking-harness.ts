/**
 * Banking harness (Phase 5 PR-6) — a pure-logic battery over the
 * banking family (lib/sim/rules/finance.ts B-01..B-14 + the pure
 * layer lib/finance/{banking,loans,insurance,conservation}.ts),
 * driven through the REAL resolver (resolveAction in commit mode,
 * validatePlan + F-02 reconciliation included) with a mini-commit
 * that materializes writes, Log entries, and pending creates into
 * a fixture world — the governance-harness pattern, extended so
 * the standing Log is a real input to later resolutions (the
 * premium ladder, the controller bar, and the failed-payment
 * derivation all read it).
 *
 * Every committed banking event is ALSO checked through
 * lib/finance/conservation.ts (checkConservation: per-event
 * paired-posting + the standing A-B assertions) at each world's
 * close — the pair discipline is proven on the standing book, not
 * asserted per handler.
 *
 * Sections: W1 charter/deposits/interest/founding/ladder · W2
 * failure fixture v1 (cash-funded) · W3 failure fixture v2
 * (credit-created, setoff, pool recovery) + the two-failure
 * senior queue · W4 verb-level batteries (B-05..B-11 boundaries,
 * A-8 NPC Tier B, M9, B-09 cure boundary) · W5 sound-bank owner
 * dissolution · X tamper negatives + frozen world + exports.
 *
 * Run: npx tsx tests/banking-harness.ts
 */

import assert from "node:assert/strict";
import {
  collectActionReadPaths,
  collectActionReadPlan,
  digestQueryResults,
  resolveAction,
  snapshotFromDocs,
} from "../lib/sim/resolver";
import { buildActionDoc } from "../lib/sim/intake";
import { headHashOf } from "../lib/sim/log";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { buildCorporationDoc } from "../lib/sim/corporations";
import { buildListingDoc, buildHoldingDoc, listingPath, holdingPath } from "../lib/sim/marketRecords";
import {
  FINANCE_DESCRIPTORS,
  buildDifFoundingPlan,
  buildScheduleRipeningPlan,
} from "../lib/sim/rules/finance";
import {
  checkConservation,
  type ConservationEvent,
  type ConservationRecords,
} from "../lib/finance/conservation";
import {
  accruedUnsettledRubars,
  bankBalanceSheet,
  deriveBankHealth,
  deriveFailedPayment,
  type BankDepositRecord,
  type BankLogEventView,
} from "../lib/finance/banking";
import { INSURANCE_FUND_PATH } from "../lib/finance/accounts";
import {
  deriveLoanStanding,
  loanRecordOf,
  poolUnpaidRubars,
  type BankLoanRecord,
} from "../lib/finance/loans";
import {
  depositCoveredClass,
  derivePremiumLadder,
  fundRecordOf,
  insurancePostureFromFund,
  premiumDueRubars,
  type PremiumMarkerView,
  type PremiumSettlementView,
} from "../lib/finance/insurance";
import { npcActorStanding } from "../lib/npcs";

/** Deposit records are plain documents; the harness reads them by
 * cast (the family parser is module-private to the rules file). */
function depositRecordOf(doc: Record<string, unknown> | null): BankDepositRecord | null {
  if (!doc || typeof doc.depositId !== "string" || typeof doc.bankCorporationId !== "string") return null;
  return doc as unknown as BankDepositRecord;
}
import { buildBankBookDepositsWorkbook } from "../lib/export/datasets/bankingWorkbook";
import { ExportError } from "../lib/export/sheetSpec";
import type { HandlerContext } from "../lib/sim/rules/registry";
import type { ResolutionPlan, SimAction, SimActor, SimSnapshot, SnapshotQueryRecord } from "../lib/sim/state";

const NOW = "2026-10-20T12:00:00.000Z";
const registry = buildFixtureBaselineRegistry();

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
// World scaffolding
// ---------------------------------------------------------------------------

type World = Map<string, Record<string, unknown> | null>;

const CITY = "cityA";
const CITY_B = "cityB";
const OWNER_A = "ownerA";
const OWNER_F = "ownerF";
const OWNER_G = "ownerG";
const MEMBER_B = "memberB";
const MEMBER_C = "memberC";
const MEMBER_D = "memberD";
const MEMBER_E = "memberE";

function memberActor(memberId: string): SimActor {
  return {
    type: "member",
    memberId,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
  };
}

function cityDoc(treasuryRubars: number): Record<string, unknown> {
  return {
    stats: {
      spirit: 50, culture: 40, infrastructure: 50, stability: 60, law: 30,
      influence: 20, military: 40, defense: 35,
      households: 0, housingUnits: 0, treasuryRubars,
      population: 100, gdpRubars: 1000000,
    },
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1, lastChangedSeq: null, lastResolutionId: null,
  };
}

function seedWorld(): World {
  const world: World = new Map();
  world.set("sim_counters/log", { lastSeq: 100, lastResolvedSeq: 100, lastEntryHash: "ab".repeat(32) });
  world.set("sim_world/current", { lastCommittedSeq: 100 });
  world.set(`factions/${CITY}`, { name: "Fixture City A", slug: "fixture-a", ownerUids: [OWNER_A] });
  world.set(`factions/${CITY_B}`, { name: "Fixture City B", slug: "fixture-b", ownerUids: ["ownerB"] });
  world.set(`sim_cities/${CITY}`, { factionId: CITY, ...cityDoc(100000) });
  world.set(`sim_cities/${CITY_B}`, { factionId: CITY_B, ...cityDoc(5000) });
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
  args: { homeCityId: string; corporationId: string; ownerMemberId: string; companyCashRubars?: number; sharesOutstanding?: number }
): string {
  const path = `sim_cities/${args.homeCityId}/corporations/${args.corporationId}`;
  world.set(path, {
    ...buildCorporationDoc({
      corporationId: args.corporationId,
      name: `${args.corporationId} Co`,
      industry: "industrial",
      ownerMemberId: args.ownerMemberId,
      founderFigureId: null,
      homeCityId: args.homeCityId,
      marketCityIds: [],
      valuationRubars: 0,
      legacyBookRubars: null,
      sourceActionId: "seed",
      sourceSeq: 1,
      lastResolutionId: "seed",
      now: new Date(NOW),
    }),
    listed: false,
    status: "active",
    companyCashRubars: args.companyCashRubars ?? 0,
    taxPayables: {},
    linkedStructureIds: [],
    paidInCapitalRubars: args.companyCashRubars ?? 0,
    sharesOutstanding: args.sharesOutstanding ?? 0,
    retiredShares: 0,
    openingReferencePriceRubars: null,
    lastJudgment: null,
  });
  return path;
}

let requestCounter = 0;
function action(
  actor: SimActor,
  actorUid: string,
  actionType: string,
  structuredAction: Record<string, unknown>,
  targetCityIds: string[] = [CITY]
): SimAction {
  requestCounter += 1;
  const { doc } = buildActionDoc({
    actorUid,
    clientRequestId: `bnk-req-${requestCounter}`,
    actor,
    actionType,
    structuredAction,
    targetCityIds,
    now: NOW,
  });
  return { ...doc, status: "confirmed" };
}

/** Generic query materialization (the governance-harness pattern,
 * with dot-path filter evaluation for the classification queries). */
function materializeQueries(
  docs: World,
  specs: { id: string; collectionPath: string; filters: { field: string; op: string; value: unknown }[] }[],
  snapshotDocs: World
): SnapshotQueryRecord[] {
  const records: SnapshotQueryRecord[] = [];
  for (const spec of specs) {
    const results: { path: string; doc: Record<string, unknown> }[] = [];
    for (const [path, doc] of docs) {
      if (!path.startsWith(`${spec.collectionPath}/`) || doc === null) continue;
      // Collection-group paths (sim_cities/<city>/corporations) are
      // single-segment under the collection path too.
      const rest = path.slice(spec.collectionPath.length + 1);
      if (spec.collectionPath === "sim_log_entries" && rest.includes("/")) continue;
      const matches = spec.filters.every((f) => {
        const fieldValue = f.field
          .split(".")
          .reduce<unknown>((acc, part) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), doc);
        return fieldValue === f.value;
      });
      if (matches) results.push({ path, doc });
    }
    for (const r of results) snapshotDocs.set(r.path, r.doc);
    records.push({
      spec: spec as SnapshotQueryRecord["spec"],
      resultPaths: results.map((r) => r.path),
      digest: digestQueryResults(spec as SnapshotQueryRecord["spec"], results.map((r) => ({ path: r.path, hash: headHashOf(r.doc) }))),
    });
  }
  return records;
}

function runAction(world: World, act: SimAction): ResolutionPlan {
  const seedDocs: World = new Map();
  for (const path of collectActionReadPaths(act)) seedDocs.set(path, world.get(path) ?? null);
  const readPlan = collectActionReadPlan(act, seedDocs);
  const snapshotDocs: World = new Map(seedDocs);
  for (const path of readPlan.paths) {
    if (!snapshotDocs.has(path)) snapshotDocs.set(path, world.get(path) ?? null);
  }
  const queryRecords = materializeQueries(world, readPlan.queries as never[], snapshotDocs);
  const snapshot = snapshotFromDocs(snapshotDocs, NOW, queryRecords);
  return resolveAction(snapshot, act, { baselineRegistry: registry, mode: "commit" });
}

/** Mini-commit: writes + Log entry docs + pending creates with the
 * committer's stamps; returns the conservation event for the plan. */
function commitPlan(world: World, plan: ResolutionPlan, resolutionId: string): ConservationEvent {
  const writeSet = plan.writes.map((w) => ({
    path: w.path,
    op: w.op,
    beforeDoc: (world.get(w.path) ?? null) as Record<string, unknown> | null,
    afterDoc: (w.afterDoc ?? null) as Record<string, unknown> | null,
  }));
  for (const w of plan.writes) {
    if (w.op === "delete") world.delete(w.path);
    else if (w.afterDoc) world.set(w.path, w.afterDoc);
  }
  const counter = world.get("sim_counters/log") as Record<string, unknown>;
  let seq = counter.lastSeq as number;
  const entries: ConservationEvent["entries"] = [];
  const entryDocs: Record<string, unknown>[] = [];
  for (const draft of plan.entries) {
    seq += 1;
    const entryDoc: Record<string, unknown> = {
      ...draft,
      seq,
      entryId: `sim_log_entries/${String(seq).padStart(12, "0")}`,
      resolutionId,
    };
    world.set(entryDoc.entryId as string, entryDoc);
    entryDocs.push(entryDoc);
    entries.push({
      seq,
      cityId: draft.cityId,
      ruleIds: draft.ruleIds,
      changes: draft.changes.map((c) => ({ field: c.field, before: c.before, after: c.after })),
    });
  }
  const summarySeq = seq;
  for (const pending of plan.pendingCreates) {
    const doc = pending.doc as Record<string, unknown>;
    const ripen = (doc.ripenCondition ?? {}) as Record<string, unknown>;
    world.set(`sim_pending_consequences/${doc.pendingId as string}`, {
      ...doc,
      createdBySeq: summarySeq,
      createdAtSeq: summarySeq,
      originSeq: summarySeq,
      ripenCondition: {
        ...ripen,
        requiredSeq: summarySeq + (typeof ripen.minSeqAdvance === "number" ? ripen.minSeqAdvance : 0),
      },
    });
  }
  world.set("sim_counters/log", { ...counter, lastSeq: seq, lastResolvedSeq: seq });
  world.set("sim_world/current", { lastCommittedSeq: seq });
  return { resolutionId, entries, writeSet };
}

function run(world: World, act: SimAction): { plan: ResolutionPlan; event: ConservationEvent | null } {
  const plan = runAction(world, act);
  if (plan.outcome !== "resolved") return { plan, event: null };
  return { plan, event: commitPlan(world, plan, act.actionId) };
}

/** Advance the world clock without actions (other realms' traffic):
 * the Log counter moves; no banking state changes (frozen world). */
function advanceSeqs(world: World, n: number): void {
  const counter = world.get("sim_counters/log") as Record<string, unknown>;
  world.set("sim_counters/log", { ...counter, lastSeq: (counter.lastSeq as number) + n });
  world.set("sim_world/current", { lastCommittedSeq: (counter.lastSeq as number) + n });
}

function doc(world: World, path: string): Record<string, unknown> {
  const found = world.get(path);
  assert.ok(found, `expected doc at ${path}`);
  return found as Record<string, unknown>;
}
function maybeDoc(world: World, path: string): Record<string, unknown> | null {
  return (world.get(path) ?? null) as Record<string, unknown> | null;
}
function counterSeq(world: World): number {
  return (world.get("sim_counters/log") as Record<string, unknown>).lastSeq as number;
}
function corpPath(cityId: string, corporationId: string): string {
  return `sim_cities/${cityId}/corporations/${corporationId}`;
}
function bankBlock(world: World, cityId: string, corporationId: string): Record<string, unknown> {
  const corp = doc(world, corpPath(cityId, corporationId));
  return corp.bank as Record<string, unknown>;
}
function depositsOf(world: World, bankCorporationId: string): BankDepositRecord[] {
  const out: BankDepositRecord[] = [];
  for (const [path, d] of world) {
    if (!path.startsWith("sim_bank_deposits/") || !d) continue;
    const record = depositRecordOf(d);
    if (record && record.bankCorporationId === bankCorporationId) out.push(record);
  }
  return out;
}
function loansOf(world: World, bankCorporationId: string): BankLoanRecord[] {
  const out: BankLoanRecord[] = [];
  for (const [path, d] of world) {
    if (!path.startsWith("sim_bank_loans/") || !d) continue;
    const record = loanRecordOf(d);
    if (record && record.bankCorporationId === bankCorporationId) out.push(record);
  }
  return out;
}
function entriesOf(world: World): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [path, d] of world) {
    if (path.startsWith("sim_log_entries/") && d) out.push(d);
  }
  return out.sort((a, b) => (a.seq as number) - (b.seq as number));
}
function conservationRecords(world: World): ConservationRecords {
  const byPrefix = (prefix: string, include?: (path: string) => boolean) =>
    [...world.entries()]
      .filter(([path, d]) => path.startsWith(prefix) && d !== null && (include ? include(path) : true))
      .map(([, d]) => d as Record<string, unknown>);
  const intervals = new Map<string, readonly { fromSeq: number; toSeq: number | null }[]>();
  const bankIds = new Set<string>();
  for (const d of byPrefix("sim_bank_deposits/")) bankIds.add(d.bankCorporationId as string);
  for (const bankId of bankIds) {
    const markers: PremiumMarkerView[] = [];
    const settlements: PremiumSettlementView[] = [];
    for (const entry of entriesOf(world)) {
      const classification = (entry.classification ?? {}) as Record<string, unknown>;
      const due = classification.premiumDue as { bankCorporationId?: string; pendingId?: string; dueRubars?: number } | undefined;
      if (due?.bankCorporationId === bankId) {
        markers.push({ pendingId: due.pendingId ?? "", seq: entry.seq as number, dueRubars: due.dueRubars ?? 0, periodIndex: 0 });
      }
      const settlement = classification.premiumSettlement as { bankCorporationId?: string; settledPendingIds?: string[] } | undefined;
      if (settlement?.bankCorporationId === bankId) {
        settlements.push({ seq: entry.seq as number, settledPendingIds: settlement.settledPendingIds ?? [] });
      }
    }
    intervals.set(bankId, derivePremiumLadder({ markers, settlements }).suspensionIntervals);
  }
  return {
    corporations: [...world.entries()]
      .filter(([path, d]) => path.includes("/corporations/") && d !== null)
      .map(([, d]) => d as Record<string, unknown>),
    deposits: byPrefix("sim_bank_deposits/"),
    loans: byPrefix("sim_bank_loans/"),
    memberAccounts: byPrefix("sim_member_accounts/"),
    cities: byPrefix("sim_cities/").filter((d) => (d as Record<string, unknown>).stats !== undefined),
    holdings: byPrefix("sim_holdings/"),
    fund: maybeDoc(world, INSURANCE_FUND_PATH),
    suspensionIntervalsByBank: intervals,
  };
}
function assertConservationClean(world: World, events: ConservationEvent[], label: string): void {
  const result = checkConservation(events.filter((e): e is ConservationEvent => e !== null), conservationRecords(world));
  assert.ok(
    result.ok,
    `${label}: conservation findings: ${result.findings.map((f) => `${f.code} (${f.path ?? ""}) ${f.message}`).join(" | ")}`
  );
}

/** Drive a schedule ripening through the exported composition,
 * exactly as the Lead's resolver dispatch will: build the wake
 * snapshot (family reads materialized), call the composition,
 * commit, and transition the pending. */
function ripen(world: World, pendingId: string): ResolutionPlan {
  const pendingPath = `sim_pending_consequences/${pendingId}`;
  const pending = doc(world, pendingPath);
  const snapshotDocs: World = new Map(world);
  const specs = [
    { id: "bankDeposits", collectionPath: "sim_bank_deposits", filters: [] as { field: string; op: string; value: unknown }[] },
    { id: "bankLoans", collectionPath: "sim_bank_loans", filters: [] },
    { id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] },
    { id: "premiumMarkers", collectionPath: "sim_log_entries", filters: [] },
    { id: "premiumSettlements", collectionPath: "sim_log_entries", filters: [] },
    { id: "assessmentMarkers", collectionPath: "sim_log_entries", filters: [] },
    { id: "situationsByKey0", collectionPath: "sim_situations", filters: [] },
  ];
  const queryRecords = materializeQueries(world, specs, snapshotDocs);
  const snapshot = snapshotFromDocs(snapshotDocs, NOW, queryRecords);
  const originActor = (pending.originActor ?? memberActor("fabric")) as SimActor;
  const act = action(originActor, "fabric", "wake_ripening", {}, [CITY]);
  const ctx: HandlerContext = {
    snapshot,
    action: act,
    resolutionId: `ripen_${pendingId}`,
    baselineRegistry: registry,
    citableBaseline: null,
    citations: {} as HandlerContext["citations"],
  };
  const plan = buildScheduleRipeningPlan(ctx, pending);
  assert.equal(plan.outcome, "resolved", `ripening ${pendingId} resolves: ${plan.rejection?.code ?? ""} ${plan.rejection?.summaryText ?? ""}`);
  commitPlan(world, plan, ctx.resolutionId);
  const after = doc(world, pendingPath);
  world.set(pendingPath, { ...after, status: "ripened" });
  return plan;
}

// ---------------------------------------------------------------------------
section("W1 — charter, deposits, §4.1 interest (items 1-2), DIF founding, premium ladder (items 11-12)");

const w1 = seedWorld();
const w1Events: ConservationEvent[] = [];
seedAccount(w1, OWNER_A, 250000);
seedAccount(w1, MEMBER_B, 250000);
seedAccount(w1, MEMBER_C, 250000);
seedCorp(w1, { homeCityId: CITY, corporationId: "bankA", ownerMemberId: OWNER_A, companyCashRubars: 500000 });

check("descriptors: B-05..B-12/B-14 registered, B-13 deliberately absent (committer step)", () => {
  for (const id of ["B-05", "B-06", "B-07", "B-08", "B-09", "B-10", "B-11", "B-12", "B-14"]) {
    assert.ok(FINANCE_DESCRIPTORS[id], `${id} descriptor`);
  }
  assert.equal(FINANCE_DESCRIPTORS["B-13"], undefined);
});

let bankADepositSeq = 0;
check("B-01 charter lands with terms verbatim; no premium chain before founding", () => {
  const { plan, event } = run(w1, action(memberActor(OWNER_A), OWNER_A, "charter_bank", {
    cityId: CITY, corporationId: "bankA", reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w1Events.push(event);
  const block = bankBlock(w1, CITY, "bankA");
  assert.equal(block.status, "active");
  assert.equal(maybeDoc(w1, "sim_pending_consequences/prem_bankA_0"), null);
});

check("B-02 deposit: claim record + liability aggregate in one event", () => {
  const { plan, event } = run(w1, action(memberActor(MEMBER_B), MEMBER_B, "deposit_funds", {
    cityId: CITY, corporationId: "bankA", depositor: { kind: "personal", memberId: MEMBER_B }, amountRubars: 100000, rateBpsPerKseq: 1000,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w1Events.push(event);
  bankADepositSeq = counterSeq(w1);
  const deposits = depositsOf(w1, "bankA");
  assert.equal(deposits.length, 1);
  assert.equal(deposits[0].principalRubars, 100000);
  assert.equal(bankBlock(w1, CITY, "bankA").depositLiabilitiesRubars, 100000);
});

check("item 1: B-04 credited branch — §4.1 exact figure 20,030 R at Δseq 2,003, zero cash movement", () => {
  const deposit = depositsOf(w1, "bankA")[0];
  // The settlement entry is the event's first entry; park the
  // counter so it lands exactly 2,003 seqs after the deposit
  // record's own settlement watermark.
  advanceSeqs(w1, deposit.lastSettledSeq + 2003 - 1 - counterSeq(w1));
  const cashBefore = (doc(w1, corpPath(CITY, "bankA")).companyCashRubars as number);
  const memberCashBefore = (doc(w1, `sim_member_accounts/${MEMBER_B}`).cashRubars as number);
  const { plan, event } = run(w1, action(memberActor(OWNER_A), OWNER_A, "settle_deposit_interest", {
    cityId: CITY, corporationId: "bankA", depositId: deposit.depositId, settlementMode: "credited", depositor: { kind: "personal", memberId: MEMBER_B },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w1Events.push(event);
  const after = depositsOf(w1, "bankA")[0];
  assert.equal(after.creditedInterestRubars, 20030, "floor(100000 × 1000 × 2003 / 10^7)");
  assert.equal(doc(w1, corpPath(CITY, "bankA")).companyCashRubars, cashBefore, "no cash moved");
  assert.equal(doc(w1, `sim_member_accounts/${MEMBER_B}`).cashRubars, memberCashBefore, "no cash moved");
  assert.equal(bankBlock(w1, CITY, "bankA").depositLiabilitiesRubars, 120030, "the claim grew by the credited figure (A-B1 pair)");
  const summary = plan.entries[plan.entries.length - 1];
  const settlement = (summary.classification as Record<string, unknown>).settlement as Record<string, unknown>;
  assert.equal(settlement.mode, "credited");
  assert.equal(settlement.bridgeClass, "interest-capitalized");
});

check("item 1 regression: B-04 cash-paid branch pays cash, claim unchanged but for the watermark", () => {
  const { plan, event } = run(w1, action(memberActor(MEMBER_C), MEMBER_C, "deposit_funds", {
    cityId: CITY, corporationId: "bankA", depositor: { kind: "personal", memberId: MEMBER_C }, amountRubars: 50000, rateBpsPerKseq: 1000,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w1Events.push(event);
  advanceSeqs(w1, 500);
  const deposit = depositsOf(w1, "bankA").find((d) => d.depositor.kind === "personal" && d.depositor.memberId === MEMBER_C) as BankDepositRecord;
  const counterBefore = counterSeq(w1);
  const memberCashBefore = (doc(w1, `sim_member_accounts/${MEMBER_C}`).cashRubars as number);
  const settled = run(w1, action(memberActor(OWNER_A), OWNER_A, "settle_deposit_interest", {
    cityId: CITY, corporationId: "bankA", depositId: deposit.depositId, settlementMode: "cash", depositor: { kind: "personal", memberId: MEMBER_C },
  }));
  assert.equal(settled.plan.outcome, "resolved", settled.plan.rejection?.summaryText ?? "");
  if (settled.event) w1Events.push(settled.event);
  // The paid figure must equal the §4.1 accrual at the settlement
  // entry's own seq (the entry that advances the watermark).
  const settleIdx = settled.plan.entries.findIndex((e) =>
    e.changes.some((c) => c.field === `bankDeposits/${deposit.depositId}.lastSettledSeq`)
  );
  assert.ok(settleIdx >= 0, "the settlement entry advances the watermark");
  const accrued = accruedUnsettledRubars(deposit, counterBefore + settleIdx + 1);
  assert.equal(doc(w1, `sim_member_accounts/${MEMBER_C}`).cashRubars, memberCashBefore + accrued);
  const after = depositsOf(w1, "bankA").find((d) => d.depositId === deposit.depositId) as BankDepositRecord;
  assert.equal(after.creditedInterestRubars, 0);
});

check("item 11/G5: DIF founding — singleton once, posture flips through the one derivation, no copy writes", () => {
  const postureBefore = insurancePostureFromFund({ fund: null, bankEligible: null });
  const snapshotDocs: World = new Map(w1);
  const queryRecords = materializeQueries(w1, [{ id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] }], snapshotDocs);
  const snapshot = snapshotFromDocs(snapshotDocs, NOW, queryRecords);
  const act = action(memberActor(OWNER_A), OWNER_A, "adopt_dif_founding", {});
  const ctx: HandlerContext = {
    snapshot, action: act, resolutionId: "res_founding_w1",
    baselineRegistry: registry, citableBaseline: null, citations: {} as HandlerContext["citations"],
  };
  const plan = buildDifFoundingPlan(ctx);
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  assert.ok(plan.writes.every((w) => w.path === INSURANCE_FUND_PATH || w.path.startsWith("sim_situations/")), "founding writes only the fund record (+ any situation claims) — no posture copy anywhere (G5)");
  w1Events.push(commitPlan(w1, plan, "res_founding_w1"));
  const fund = fundRecordOf(doc(w1, INSURANCE_FUND_PATH));
  assert.ok(fund);
  assert.equal(fund?.grandfathering, "none");
  assert.equal(fund?.fundCashRubars, 0);
  const postureAfter = insurancePostureFromFund({ fund, bankEligible: true });
  assert.equal(postureBefore.institutionExists, false);
  assert.equal(postureAfter.institutionExists, true);
  // The premium chain seeded for the already-chartered bankA.
  const seeded = doc(w1, "sim_pending_consequences/prem_bankA_0");
  assert.equal((seeded.ripenCondition as Record<string, unknown>).requiredSeq, counterSeq(w1) + 1000, "requiredSeq = founding summary seq + 1000");
  // Second founding rejects (fresh snapshot — the fund now stands).
  const snapshot2 = snapshotFromDocs(new Map(w1), NOW, []);
  const ctx2: HandlerContext = {
    snapshot: snapshot2, action: act, resolutionId: "res_founding_w1_again",
    baselineRegistry: registry, citableBaseline: null, citations: {} as HandlerContext["citations"],
  };
  const again = buildDifFoundingPlan(ctx2);
  assert.equal(again.outcome, "rejected");
  assert.equal(again.rejection?.code, "fund-exists");
});

check("item 11/M12: the pre-founding deposit derives uninsured for life; a post-founding deposit is covered-class", () => {
  const fund = fundRecordOf(doc(w1, INSURANCE_FUND_PATH));
  const old = depositsOf(w1, "bankA")[0];
  assert.equal(depositCoveredClass(old, { fund, bankOwnerMemberId: OWNER_A, suspensionIntervals: [] }), false);
  const { plan, event } = run(w1, action(memberActor(MEMBER_C), MEMBER_C, "deposit_funds", {
    cityId: CITY, corporationId: "bankA", depositor: { kind: "personal", memberId: MEMBER_C }, amountRubars: 10000, rateBpsPerKseq: 500,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w1Events.push(event);
  const fresh = depositsOf(w1, "bankA").find((d) => d.principalRubars === 10000) as BankDepositRecord;
  assert.equal(depositCoveredClass(fresh, { fund, bankOwnerMemberId: OWNER_A, suspensionIntervals: [] }), true);
});

check("item 12: premium ripening computes the due from Log inputs alone; zero-figure discipline holds", () => {
  // Insured liabilities at bankA: only covered-class deposits count
  // (the post-founding 10,000 R deposit; the pre-founding book is
  // uninsured under the none election).
  const expected = premiumDueRubars({ insuredLiabilitiesRubars: 10000, riskMultiplier: 2, periodSeqs: 1000 });
  const plan = ripen(w1, "prem_bankA_0");
  const summary = plan.entries[plan.entries.length - 1];
  const due = (summary.classification as Record<string, unknown>).premiumDue as Record<string, unknown>;
  assert.equal(due.dueRubars, expected);
  assert.equal(due.insuredLiabilitiesRubars, 10000);
  // Successor: generation-1 fresh chain, schedule-anchored.
  const successor = doc(w1, "sim_pending_consequences/prem_bankA_1");
  assert.equal(successor.generation, 1);
  assert.equal(successor.chainId, "prem_bankA_1");
  const seedRequired = (doc(w1, "sim_pending_consequences/prem_bankA_0").ripenCondition as Record<string, unknown>).requiredSeq as number;
  assert.equal((successor.ripenCondition as Record<string, unknown>).requiredSeq, seedRequired + 1000);
});

check("W1 conservation: paired posting + standing A-B assertions clean over the whole book", () => {
  assertConservationClean(w1, w1Events, "W1");
});
