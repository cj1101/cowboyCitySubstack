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
  collectRipeningReadPaths,
  collectRipeningReadQueries,
  digestQueryResults,
  resolveAction,
  resolveRipening,
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
import { buildMandateVersion, npcActorStanding } from "../lib/npcs";

/** Deposit records are plain documents; the harness reads them by
 * cast (the family parser is module-private to the rules file). */
function depositRecordOf(doc: Record<string, unknown> | null): BankDepositRecord | null {
  if (!doc || typeof doc.depositId !== "string" || typeof doc.bankCorporationId !== "string") return null;
  return doc as unknown as BankDepositRecord;
}
import {
  buildBankBookDepositsWorkbook,
  buildBankVerifiedSheetWorkbook,
} from "../lib/export/datasets/bankingWorkbook";
import type { ExportContext } from "../lib/export/datasets/cityData";
import { ExportError } from "../lib/export/sheetSpec";
import { descriptorForActionKind, RULE_DESCRIPTORS, type HandlerContext } from "../lib/sim/rules/registry";
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

// ---------------------------------------------------------------------------
// W1b — DIF founding ROUTE (B2.3 route A): item 11 proved the
// builder; this section proves the DISPATCH — adopt_dif_founding
// driven through run()/runAction() (the real resolver, the real
// read plan), under the wiring's admin-member gate. The builder is
// driven directly exactly once, for plan parity on identical state.
// ---------------------------------------------------------------------------

section("W1b — DIF founding dispatcher route (B-12 adopt_dif_founding)");

const ADMIN_UID = "adminUid";
const FABRIC_UID = "fabricCommitterUid";

const wRoute = seedWorld();
const wRouteEvents: ConservationEvent[] = [];
wRoute.set(`users/${ADMIN_UID}`, { email: "admin@fixture.test", status: "approved", isAdmin: true });
wRoute.set(`users/${OWNER_A}`, { email: "owner-a@fixture.test", status: "approved", isAdmin: false });
// The fabric committer's Step 1 profile shape, posture verbatim: an
// approved minimal doc — isAdmin false.
wRoute.set(`users/${FABRIC_UID}`, { email: "fabric@fixture.test", status: "approved", isAdmin: false });
seedAccount(wRoute, OWNER_A, 500000);
seedAccount(wRoute, MEMBER_C, 100000);
seedCorp(wRoute, { homeCityId: CITY, corporationId: "bankR", ownerMemberId: OWNER_A, companyCashRubars: 200000 });
charter(wRoute, wRouteEvents, OWNER_A, CITY, "bankR");
deposit(wRoute, wRouteEvents, MEMBER_C, CITY, "bankR", 50000);

check("route: descriptorForActionKind binds adopt_dif_founding to B-12; the census stays 79 (a kind binding, not a new descriptor)", () => {
  assert.equal(descriptorForActionKind("adopt_dif_founding")?.id, "B-12");
  assert.equal(typeof FINANCE_DESCRIPTORS["B-12"].handlers.adopt_dif_founding, "function");
  assert.ok(FINANCE_DESCRIPTORS["B-12"].actionKinds.includes("adopt_dif_founding"));
  assert.equal(Object.keys(RULE_DESCRIPTORS).length, 79);
});

check("route gate: a non-admin member's founding attempt rejects not-admin-member; no fund stands", () => {
  const { plan } = run(wRoute, action(memberActor(OWNER_A), OWNER_A, "adopt_dif_founding", {}));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "not-admin-member");
  assert.equal(maybeDoc(wRoute, INSURANCE_FUND_PATH), null);
});

check("route gate: the fabric committer identity is refused — this is a member act, not a fabric one", () => {
  const { plan } = run(wRoute, action(memberActor(FABRIC_UID), FABRIC_UID, "adopt_dif_founding", {}));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "not-admin-member");
  assert.equal(maybeDoc(wRoute, INSURANCE_FUND_PATH), null);
});

check("route gate: a system actor is refused — no member principal holds the admin posture", () => {
  const systemActor: SimActor = {
    type: "system", memberId: null, npcId: null, onBehalfOfMemberId: null,
    mandateId: null, mandateVersion: null, envelopeId: null,
  };
  const { plan } = run(wRoute, action(systemActor, "system", "adopt_dif_founding", {}));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "not-admin-member");
  assert.equal(maybeDoc(wRoute, INSURANCE_FUND_PATH), null);
});

check("route: an admin member's founding act resolves through the dispatcher — and the plan is the builder's plan", () => {
  const act = action(memberActor(ADMIN_UID), ADMIN_UID, "adopt_dif_founding", {});
  // Builder parity on the identical pre-state (item 11's direct
  // drive): same fund write, same seeded chains, same founding
  // classification.
  const snapshotDocs: World = new Map(wRoute);
  const queryRecords = materializeQueries(wRoute, [{ id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] }], snapshotDocs);
  const directCtx: HandlerContext = {
    snapshot: snapshotFromDocs(snapshotDocs, NOW, queryRecords), action: act, resolutionId: act.actionId,
    baselineRegistry: registry, citableBaseline: null, citations: {} as HandlerContext["citations"],
  };
  const direct = buildDifFoundingPlan(directCtx);
  assert.equal(direct.outcome, "resolved", direct.rejection?.summaryText ?? "");
  const { plan, event } = run(wRoute, act);
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  assert.ok(event);
  if (event) wRouteEvents.push(event);
  const fundWrite = (p: ResolutionPlan) => p.writes.find((w) => w.path === INSURANCE_FUND_PATH)?.afterDoc;
  assert.deepEqual(fundWrite(plan), fundWrite(direct), "the routed fund write is the builder's fund write");
  const pendingIds = (p: ResolutionPlan) =>
    p.pendingCreates.map((d) => (d.doc as Record<string, unknown>).pendingId as string).sort();
  assert.deepEqual(pendingIds(plan), pendingIds(direct), "the routed plan seeds the builder's premium chains");
  const summaryOf = (p: ResolutionPlan) => p.entries[p.entries.length - 1];
  assert.deepEqual(
    (summaryOf(plan).classification as Record<string, unknown>).difFounding,
    (summaryOf(direct).classification as Record<string, unknown>).difFounding,
    "the routed summary carries the builder's difFounding classification"
  );
  // The committed state: fund standing, election NONE, the
  // pre-founding deposit uninsured for life (aggregate derives 0),
  // bankR's period-0 chain seeded off the founding summary seq.
  const fund = fundRecordOf(doc(wRoute, INSURANCE_FUND_PATH));
  assert.ok(fund);
  assert.equal(fund?.grandfathering, "none");
  assert.equal(fund?.fundCashRubars, 0);
  assert.equal(fund?.totalInsuredLiabilitiesRubars, 0);
  const seeded = doc(wRoute, "sim_pending_consequences/prem_bankR_0");
  assert.equal((seeded.ripenCondition as Record<string, unknown>).requiredSeq, counterSeq(wRoute) + 1000, "requiredSeq = founding summary seq + 1000");
});

check("route: a second founding act rejects fund-exists through the dispatcher (once-ever, BNK-D18)", () => {
  const { plan } = run(wRoute, action(memberActor(ADMIN_UID), ADMIN_UID, "adopt_dif_founding", {}));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "fund-exists");
});

check("route: B-12's premium read plan is unchanged by the branch (byte-stable paths + query ids)", () => {
  const premiumAct = action(memberActor(OWNER_A), OWNER_A, "pay_insurance_premium", {
    cityId: CITY, corporationId: "bankR",
  });
  const seedDocs: World = new Map();
  for (const path of collectActionReadPaths(premiumAct)) seedDocs.set(path, wRoute.get(path) ?? null);
  const shape = collectActionReadPlan(premiumAct, seedDocs);
  const expectedPaths = new Set([
    ...collectActionReadPaths(premiumAct),
    INSURANCE_FUND_PATH,
    `sim_cities/${CITY}/corporations/bankR`,
  ]);
  assert.deepEqual(new Set(shape.paths), expectedPaths);
  assert.deepEqual(
    shape.queries.map((q) => q.id),
    ["premiumMarkers", "premiumSettlements", "situationsByKey0", "assessmentMarkers"]
  );
});

check("W1b conservation: paired posting + standing A-B assertions clean over the route world", () => {
  assertConservationClean(wRoute, wRouteEvents, "W1b");
});

// ---------------------------------------------------------------------------
// Shared helpers for the failure worlds
// ---------------------------------------------------------------------------

function foundDif(world: World, actor: SimActor, uid: string): void {
  const snapshotDocs: World = new Map(world);
  const queryRecords = materializeQueries(world, [{ id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] }], snapshotDocs);
  const snapshot = snapshotFromDocs(snapshotDocs, NOW, queryRecords);
  const act = action(actor, uid, "adopt_dif_founding", {});
  const ctx: HandlerContext = {
    snapshot, action: act, resolutionId: `res_founding_${counterSeq(world)}`,
    baselineRegistry: registry, citableBaseline: null, citations: {} as HandlerContext["citations"],
  };
  const plan = buildDifFoundingPlan(ctx);
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  commitPlan(world, plan, ctx.resolutionId);
}

function charter(world: World, events: ConservationEvent[], owner: string, cityId: string, corporationId: string): void {
  const { plan, event } = run(world, action(memberActor(owner), owner, "charter_bank", {
    cityId, corporationId, reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(plan.outcome, "resolved", `charter ${corporationId}: ${plan.rejection?.summaryText ?? ""}`);
  if (event) events.push(event);
}

function deposit(world: World, events: ConservationEvent[], member: string, cityId: string, corporationId: string, amount: number, rate = 500): BankDepositRecord {
  const { plan, event } = run(world, action(memberActor(member), member, "deposit_funds", {
    cityId, corporationId, depositor: { kind: "personal", memberId: member }, amountRubars: amount, rateBpsPerKseq: rate,
  }));
  assert.equal(plan.outcome, "resolved", `deposit at ${corporationId}: ${plan.rejection?.summaryText ?? ""}`);
  if (event) events.push(event);
  const rows = depositsOf(world, corporationId).filter((d) => d.depositor.kind === "personal" && d.depositor.memberId === member);
  return rows[rows.length - 1];
}

function offerLoan(
  world: World, events: ConservationEvent[], owner: string, cityId: string, corporationId: string,
  terms: Record<string, unknown>
): BankLoanRecord {
  const { plan, event } = run(world, action(memberActor(owner), owner, "offer_loan", {
    cityId, corporationId, ...terms,
  }));
  assert.equal(plan.outcome, "resolved", `offer at ${corporationId}: ${plan.rejection?.summaryText ?? ""}`);
  if (event) events.push(event);
  const loans = loansOf(world, corporationId).filter((l) => l.status === "offered");
  return loans[loans.length - 1];
}

function acceptLoan(world: World, events: ConservationEvent[], borrower: SimActor, borrowerUid: string, cityId: string, loan: BankLoanRecord): ResolutionPlan {
  const { plan, event } = run(world, action(borrower, borrowerUid, "accept_loan", {
    cityId, corporationId: loan.bankCorporationId, loanId: loan.loanId,
    borrower: loan.borrower, collateral: loan.collateral,
  }));
  if (event) events.push(event);
  return plan;
}

function openSituations(world: World, needle: string): Record<string, unknown>[] {
  return [...world.entries()]
    .filter(([path, d]) => path.startsWith("sim_situations/") && d !== null)
    .map(([, d]) => d as Record<string, unknown>)
    .filter((d) => d.status === "open" && JSON.stringify(d).includes(needle));
}

// ---------------------------------------------------------------------------
section("W2 — failure fixture v1 (cash-funded): charter → deposits → loans → default → write-off → failure → waterfall → pool recovery");

const wF = seedWorld();
const wFEvents: ConservationEvent[] = [];
for (const m of [OWNER_F, OWNER_G, MEMBER_B, MEMBER_C, MEMBER_D, MEMBER_E]) seedAccount(wF, m, 900000);
seedCorp(wF, { homeCityId: CITY, corporationId: "bankF", ownerMemberId: OWNER_F, companyCashRubars: 150000 });
seedCorp(wF, { homeCityId: CITY, corporationId: "bankG", ownerMemberId: OWNER_G, companyCashRubars: 121100 });
foundDif(wF, memberActor(OWNER_F), OWNER_F);
charter(wF, wFEvents, OWNER_F, CITY, "bankF");

const depFB = deposit(wF, wFEvents, MEMBER_B, CITY, "bankF", 300000);
const depFC = deposit(wF, wFEvents, MEMBER_C, CITY, "bankF", 100000);

check("W2 premium: ripened due recomputes from insured liabilities; B-12 pays it into the fund", () => {
  advanceSeqs(wF, 1100);
  ripen(wF, "prem_bankF_0");
  const expected = premiumDueRubars({ insuredLiabilitiesRubars: 400000, riskMultiplier: 2, periodSeqs: 1000 });
  assert.equal(expected, 800);
  const { plan, event } = run(wF, action(memberActor(OWNER_F), OWNER_F, "pay_insurance_premium", {
    cityId: CITY, corporationId: "bankF", amountRubars: expected,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  assert.equal(fundRecordOf(doc(wF, INSURANCE_FUND_PATH))?.fundCashRubars, 800);
});

const loanFD = offerLoan(wF, wFEvents, OWNER_F, CITY, "bankF", {
  borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 440000, rateBpsPerKseq: 1000,
  installmentCount: 2, dueIntervalSeqs: 50, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
});
const loanFE = offerLoan(wF, wFEvents, OWNER_F, CITY, "bankF", {
  borrower: { kind: "personal", memberId: MEMBER_E }, principalRubars: 25000, rateBpsPerKseq: 0,
  installmentCount: 2, dueIntervalSeqs: 10000, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
});

check("W2 loans fund (cash branch); pendings == installmentCount at exact due seqs", () => {
  const acceptD = acceptLoan(wF, wFEvents, memberActor(MEMBER_D), MEMBER_D, CITY, loanFD);
  assert.equal(acceptD.outcome, "resolved", acceptD.rejection?.summaryText ?? "");
  const acceptE = acceptLoan(wF, wFEvents, memberActor(MEMBER_E), MEMBER_E, CITY, loanFE);
  assert.equal(acceptE.outcome, "resolved", acceptE.rejection?.summaryText ?? "");
  const funded = loansOf(wF, "bankF").find((l) => l.loanId === loanFD.loanId) as BankLoanRecord;
  assert.equal(funded.status, "active");
  for (let k = 1; k <= 2; k += 1) {
    const pending = doc(wF, `sim_pending_consequences/inst_${loanFD.loanId}_${k}`);
    assert.equal(
      (pending.ripenCondition as Record<string, unknown>).requiredSeq,
      (funded.originatedAtSeq as number) + k * 50
    );
  }
  assert.equal(bankBlock(wF, CITY, "bankF").loanBookRubars, 465000);
});

check("W2 default derives at the crossing ripening (B2 card + remedies-armed K1); seizure of an unsecured loan refuses no-collateral", () => {
  advanceSeqs(wF, 60);
  ripen(wF, `inst_${loanFD.loanId}_1`);
  const loan = loansOf(wF, "bankF").find((l) => l.loanId === loanFD.loanId) as BankLoanRecord;
  assert.equal(deriveLoanStanding(loan, counterSeq(wF)).inDefault, true);
  assert.ok(openSituations(wF, loanFD.loanId).length >= 2, "borrower B2 card + bank K1 card stand open");
  const seize = run(wF, action(memberActor(OWNER_F), OWNER_F, "seize_collateral", {
    cityId: CITY, corporationId: "bankF", loanId: loanFD.loanId, borrower: loan.borrower, collateral: { kind: "none" },
  }));
  assert.equal(seize.plan.outcome, "rejected");
  assert.equal(seize.plan.rejection?.code, "no-collateral");
});

let w2FundShortfalls = { b: 0, c: 0 };
check("W2 write-off drives derived failure; B-10 waterfall + B-13 + assignment land exactly as recomputed", () => {
  const writeOff = run(wF, action(memberActor(OWNER_F), OWNER_F, "write_off_loan", {
    cityId: CITY, corporationId: "bankF", loanId: loanFD.loanId, borrower: loanFD.borrower, amountRubars: 440000,
  }));
  assert.equal(writeOff.plan.outcome, "resolved", writeOff.plan.rejection?.summaryText ?? "");
  if (writeOff.event) wFEvents.push(writeOff.event);
  assert.equal(deriveBankHealth(doc(wF, corpPath(CITY, "bankF"))), "insolvent");

  // Recompute the waterfall from the standing records (REC-5 basis).
  const corp = doc(wF, corpPath(CITY, "bankF"));
  const cash = corp.companyCashRubars as number;
  const freezeSeq = counterSeq(wF) + 1;
  const claims = [depFB, depFC].map((d) => {
    const live = depositsOf(wF, "bankF").find((x) => x.depositId === d.depositId) as BankDepositRecord;
    return { deposit: live, frozen: live.principalRubars + live.creditedInterestRubars + accruedUnsettledRubars(live, freezeSeq) };
  });
  const totalClaims = claims.reduce((s, c) => s + c.frozen, 0);
  const estateFor = (frozen: number) => Math.floor((cash * frozen) / totalClaims);
  const { plan, event } = run(wF, action(memberActor(OWNER_F), OWNER_F, "liquidate_bank", {
    cityId: CITY, corporationId: "bankF", trigger: "owner",
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  let fundPaidTotal = 0;
  for (const { deposit: live, frozen } of claims) {
    const after = depositsOf(wF, "bankF").find((x) => x.depositId === live.depositId) as BankDepositRecord;
    assert.equal(after.status, "assigned");
    const block = after.liquidation as unknown as Record<string, number>;
    assert.equal(block.frozenClaimRubars, frozen, "REC-5 frozen claim");
    const covered = Math.min(frozen, 250000);
    assert.equal(block.coveredRubars, covered);
    const estate = estateFor(frozen);
    assert.equal(block.estatePaidRubars, estate, "tier (c) pro-rata on the full frozen claim");
    const estateOnCovered = Math.floor((estate * covered) / frozen);
    const due = covered - estateOnCovered;
    assert.ok(block.fundPaidRubars <= due, "B-13 pays at most the covered shortfall");
    assert.equal(block.fundPaidRubars + block.fundShortfallRubars, due, "paid + queued == due (REC-7 three-state)");
    fundPaidTotal += block.fundPaidRubars;
    if (live.depositor.kind === "personal" && live.depositor.memberId === MEMBER_B) w2FundShortfalls.b = block.fundShortfallRubars;
    if (live.depositor.kind === "personal" && live.depositor.memberId === MEMBER_C) w2FundShortfalls.c = block.fundShortfallRubars;
  }
  assert.equal(fundRecordOf(doc(wF, INSURANCE_FUND_PATH))?.fundCashRubars, 800 - fundPaidTotal, "the fund paid only inside B-10");
  const assignedE = loansOf(wF, "bankF").find((l) => l.loanId === loanFE.loanId) as BankLoanRecord;
  assert.equal(assignedE.status, "assigned");
  assert.equal(assignedE.outstandingRubars, 25000);
  const writtenOff = loansOf(wF, "bankF").find((l) => l.loanId === loanFD.loanId) as BankLoanRecord;
  assert.equal(writtenOff.status, "written-off", "a written-off loan is not the pool's — it was already forgiven");
  assert.equal(doc(wF, corpPath(CITY, "bankF")).status, "dissolved");
  assert.equal(bankBlock(wF, CITY, "bankF").status, "surrendered");
  const allSituations = [...wF.entries()].filter(([path]) => path.startsWith("sim_situations/"));
  assert.ok(openSituations(wF, "has been liquidated").length >= 2, "D1 cards stand for both depositors");
});

check("W2 pool recovery: E's pool-form repayment distributes across claims, subrogation routes the fund's share first", () => {
  const unpaidB = poolUnpaidRubars(depositsOf(wF, "bankF").find((d) => d.depositId === depFB.depositId) as BankDepositRecord);
  const unpaidC = poolUnpaidRubars(depositsOf(wF, "bankF").find((d) => d.depositId === depFC.depositId) as BankDepositRecord);
  const fundBefore = fundRecordOf(doc(wF, INSURANCE_FUND_PATH))?.fundCashRubars as number;
  const cashBBefore = (doc(wF, `sim_member_accounts/${MEMBER_B}`).cashRubars as number);
  const frozenCashBefore = doc(wF, corpPath(CITY, "bankF")).companyCashRubars as number;
  const cashEBefore = (doc(wF, `sim_member_accounts/${MEMBER_E}`).cashRubars as number);
  const { plan, event } = run(wF, action(memberActor(MEMBER_E), MEMBER_E, "repay_loan", {
    cityId: CITY, corporationId: "bankF", loanId: loanFE.loanId, borrower: { kind: "personal", memberId: MEMBER_E },
    amountRubars: 20000, collateral: { kind: "none" },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  const total = unpaidB + unpaidC;
  // §5.6 integer rules: each claim's share is floored; the remainder
  // is dust to the dissolved bank's frozen cash record — it is NOT
  // rounded into anyone's distribution.
  const shareB = Math.floor((20000 * unpaidB) / total);
  const shareC = Math.floor((20000 * unpaidC) / total);
  const dust = 20000 - shareB - shareC;
  const afterB = depositsOf(wF, "bankF").find((d) => d.depositId === depFB.depositId) as BankDepositRecord;
  const afterC = depositsOf(wF, "bankF").find((d) => d.depositId === depFC.depositId) as BankDepositRecord;
  assert.equal(afterB.liquidation?.poolDistributedRubars, shareB, "B's distribution is its floored pro-rata share");
  assert.equal(afterC.liquidation?.poolDistributedRubars, shareC, "C's distribution is its floored pro-rata share");
  assert.equal((doc(wF, corpPath(CITY, "bankF")).companyCashRubars as number) - frozenCashBefore, dust, "the floor remainder sits in the dissolved bank's frozen cash record (§5.6 dust)");
  assert.equal(cashEBefore - (doc(wF, `sim_member_accounts/${MEMBER_E}`).cashRubars as number), 20000, "the borrower paid the full filed amount — dust is the pool's remainder, not a borrower rebate");
  const fundAfter = fundRecordOf(doc(wF, INSURANCE_FUND_PATH))?.fundCashRubars as number;
  const recoveredTotal = (afterB.liquidation?.fundRecoveredRubars ?? 0) + (afterC.liquidation?.fundRecoveredRubars ?? 0);
  assert.equal(fundAfter - fundBefore, recoveredTotal, "subrogated recoveries are a fund inflow (derived routing, M10's closed set)");
  assert.ok(recoveredTotal > 0, "the fund recovers before depositors see pool money on claims it topped up");
  assert.equal((doc(wF, `sim_member_accounts/${MEMBER_B}`).cashRubars as number) - cashBBefore, shareB - (afterB.liquidation?.fundRecoveredRubars ?? 0));
});

check("W2 conservation clean (v1 failure fixture, every transition from the standing Log)", () => {
  assertConservationClean(wF, wFEvents, "W2");
});

// ---------------------------------------------------------------------------
section("W3 — failure fixture v2 (credit-created): creation pair, setoff, senior queue, pool recovery");

charter(wF, wFEvents, OWNER_G, CITY, "bankG");
const depGB = deposit(wF, wFEvents, MEMBER_B, CITY, "bankG", 500000);
const depGC = deposit(wF, wFEvents, MEMBER_C, CITY, "bankG", 50000);

check("W3 premium for bankG lands in the (drained) fund", () => {
  advanceSeqs(wF, 1100);
  ripen(wF, "prem_bankG_0");
  const due = premiumDueRubars({ insuredLiabilitiesRubars: 550000, riskMultiplier: 2, periodSeqs: 1000 });
  assert.equal(due, 1100);
  const { plan, event } = run(wF, action(memberActor(OWNER_G), OWNER_G, "pay_insurance_premium", {
    cityId: CITY, corporationId: "bankG", amountRubars: due,
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
});

const loanGC = offerLoan(wF, wFEvents, OWNER_G, CITY, "bankG", {
  borrower: { kind: "personal", memberId: MEMBER_C }, principalRubars: 300000, rateBpsPerKseq: 1000,
  installmentCount: 3, dueIntervalSeqs: 40, defaultMissedCount: 2, collateral: { kind: "none" },
  fundingSource: "credit", createdDepositRateBpsPerKseq: 0,
});
const loanGD = offerLoan(wF, wFEvents, OWNER_G, CITY, "bankG", {
  borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 500000, rateBpsPerKseq: 1000,
  installmentCount: 2, dueIntervalSeqs: 40, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
});

check("item 5: B-06 credit branch — ΔCash 0, ΔAssets = ΔLiabilities = P, pair stamped (G1's positive proof)", () => {
  const cashBefore = (doc(wF, corpPath(CITY, "bankG")).companyCashRubars as number);
  const plan = acceptLoan(wF, wFEvents, memberActor(MEMBER_C), MEMBER_C, CITY, loanGC);
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  const corpAfter = doc(wF, corpPath(CITY, "bankG"));
  assert.equal(corpAfter.companyCashRubars, cashBefore, "creation moves no cash");
  const block = bankBlock(wF, CITY, "bankG");
  assert.equal(block.loanBookRubars, 300000);
  assert.equal(block.depositLiabilitiesRubars, 850000);
  const created = depositsOf(wF, "bankG").find((d) => d.origin === "credit-created") as BankDepositRecord;
  assert.ok(created);
  assert.equal(created.principalRubars, 300000);
  assert.equal(created.fundingLoanId, loanGC.loanId);
  const fundedLoan = loansOf(wF, "bankG").find((l) => l.loanId === loanGC.loanId) as BankLoanRecord;
  assert.equal(fundedLoan.proceedsDepositId, created.depositId);
});

check("item 5 boundary: cash funding at exactly lendable passes", () => {
  const plan = acceptLoan(wF, wFEvents, memberActor(MEMBER_D), MEMBER_D, CITY, loanGD);
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  assert.equal((doc(wF, corpPath(CITY, "bankG")).companyCashRubars as number), 170000);
});

check("item 6: B-07 netting — principal nets against the loan's own created deposit; interest pays in cash only", () => {
  const createdBefore = depositsOf(wF, "bankG").find((d) => d.origin === "credit-created") as BankDepositRecord;
  const cashCBefore = (doc(wF, `sim_member_accounts/${MEMBER_C}`).cashRubars as number);
  const { plan, event } = run(wF, action(memberActor(MEMBER_C), MEMBER_C, "repay_loan", {
    cityId: CITY, corporationId: "bankG", loanId: loanGC.loanId, borrower: { kind: "personal", memberId: MEMBER_C },
    amountRubars: 100000, netting: true, collateral: { kind: "none" },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  const summary = plan.entries[plan.entries.length - 1];
  const loanClass = (summary.classification as Record<string, unknown>).loan as Record<string, unknown>;
  const netted = loanClass.nettedPrincipalRubars as number;
  assert.ok(netted > 0, "some principal netted");
  const createdAfter = depositsOf(wF, "bankG").find((d) => d.depositId === createdBefore.depositId) as BankDepositRecord;
  assert.equal(createdBefore.principalRubars - createdAfter.principalRubars, netted, "the deposit fell by exactly the netted principal");
  assert.equal(cashCBefore - (doc(wF, `sim_member_accounts/${MEMBER_C}`).cashRubars as number), 100000 - netted, "cash moved only for the un-netted portion (interest + remaining principal)");
});

check("W3 failure derives (write-off of D's cash loan); B-10 pays the SENIOR queue before its own top-ups", () => {
  advanceSeqs(wF, 50);
  ripen(wF, `inst_${loanGD.loanId}_1`);
  const writeOff = run(wF, action(memberActor(OWNER_G), OWNER_G, "write_off_loan", {
    cityId: CITY, corporationId: "bankG", loanId: loanGD.loanId, borrower: loanGD.borrower, amountRubars: 200000,
  }));
  assert.equal(writeOff.plan.outcome, "resolved", writeOff.plan.rejection?.summaryText ?? "");
  if (writeOff.event) wFEvents.push(writeOff.event);
  assert.equal(deriveBankHealth(doc(wF, corpPath(CITY, "bankG"))), "insolvent");

  const fundBefore = fundRecordOf(doc(wF, INSURANCE_FUND_PATH))?.fundCashRubars as number;
  const shortfallsBefore = {
    b: (depositsOf(wF, "bankF").find((d) => d.depositId === depFB.depositId) as BankDepositRecord).liquidation?.fundShortfallRubars ?? 0,
    c: (depositsOf(wF, "bankF").find((d) => d.depositId === depFC.depositId) as BankDepositRecord).liquidation?.fundShortfallRubars ?? 0,
  };
  assert.equal(shortfallsBefore.b, w2FundShortfalls.b);
  const { plan, event } = run(wF, action(memberActor(OWNER_G), OWNER_G, "liquidate_bank", {
    cityId: CITY, corporationId: "bankG", trigger: "owner",
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  const shortfallsAfter = {
    b: (depositsOf(wF, "bankF").find((d) => d.depositId === depFB.depositId) as BankDepositRecord).liquidation?.fundShortfallRubars ?? 0,
    c: (depositsOf(wF, "bankF").find((d) => d.depositId === depFC.depositId) as BankDepositRecord).liquidation?.fundShortfallRubars ?? 0,
  };
  const seniorPaidTotal = (shortfallsBefore.b - shortfallsAfter.b) + (shortfallsBefore.c - shortfallsAfter.c);
  assert.ok(seniorPaidTotal > 0, "failure 1's queued shortfalls settled inside failure 2's liquidation");
  assert.equal(seniorPaidTotal, Math.min(fundBefore, shortfallsBefore.b + shortfallsBefore.c), "the senior queue consumed the fund before any new top-up");
  // bankG's own depositors: their top-ups could only come after the
  // senior queue — with the fund exhausted by it, they queue in full.
  const gTopUps = depositsOf(wF, "bankG").reduce((s, d) => s + (d.liquidation?.fundPaidRubars ?? 0), 0);
  const seniorFirst = seniorPaidTotal >= Math.min(fundBefore, shortfallsBefore.b);
  assert.ok(seniorFirst);
  if (fundBefore - seniorPaidTotal <= 0) assert.equal(gTopUps, 0, "no top-up leapfrogged the senior queue");
  // Setoff: C's assigned loan carries setoff; D's assigns whole.
  const loanCAfter = loansOf(wF, "bankG").find((l) => l.loanId === loanGC.loanId) as BankLoanRecord;
  assert.equal(loanCAfter.status, "assigned");
  assert.ok((loanCAfter.setoffAppliedRubars ?? 0) > 0, "setoff applied in-event (BNK-D16)");
  assert.equal(loanCAfter.outstandingRubars + (loanCAfter.setoffAppliedRubars ?? 0), 300000 - nettedPrincipalTotal(wF, loanGC.loanId));
  const loanDAfter = loansOf(wF, "bankG").find((l) => l.loanId === loanGD.loanId) as BankLoanRecord;
  assert.equal(loanDAfter.status, "assigned");
  assert.equal(loanDAfter.outstandingRubars, 300000);
});

function nettedPrincipalTotal(world: World, loanId: string): number {
  const loan = loansOf(world, "bankG").find((l) => l.loanId === loanId) as BankLoanRecord;
  return loan.nettedPrincipalRubars ?? 0;
}

check("W3 pool recovery: D's pool-form repayment distributes to B and C by unpaid claim", () => {
  const before = depositsOf(wF, "bankG").map((d) => ({ id: d.depositId, distributed: d.liquidation?.poolDistributedRubars ?? 0 }));
  const frozenBefore = doc(wF, corpPath(CITY, "bankG")).companyCashRubars as number;
  const { plan, event } = run(wF, action(memberActor(MEMBER_D), MEMBER_D, "repay_loan", {
    cityId: CITY, corporationId: "bankG", loanId: loanGD.loanId, borrower: { kind: "personal", memberId: MEMBER_D },
    amountRubars: 50000, collateral: { kind: "none" },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) wFEvents.push(event);
  const gained = depositsOf(wF, "bankG").reduce((s, d) => {
    const prior = before.find((b) => b.id === d.depositId)?.distributed ?? 0;
    return s + ((d.liquidation?.poolDistributedRubars ?? 0) - prior);
  }, 0);
  // §5.6: distributions are integer floors; the remainder is dust
  // in the dissolved bank's frozen cash record. Distributed + dust
  // is the whole repayment — nothing vanishes, nothing rounds up.
  const dustDelta = (doc(wF, corpPath(CITY, "bankG")).companyCashRubars as number) - frozenBefore;
  assert.equal(gained + dustDelta, 50000, "distributed + dust == the repayment (interest portion first, then principal)");
  assert.ok(gained > 0 && gained <= 50000);
});

check("item 14: the controller bar — barred while seqs short OR obligations stand; lifts only when both pass", () => {
  seedCorp(wF, { homeCityId: CITY, corporationId: "bankF2", ownerMemberId: OWNER_F, companyCashRubars: 150000 });
  const barred = run(wF, action(memberActor(OWNER_F), OWNER_F, "charter_bank", {
    cityId: CITY, corporationId: "bankF2", reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(barred.plan.outcome, "rejected");
  assert.equal(barred.plan.rejection?.code, "controller-barred");
  // C controlled no bank, but C OWES the bankG pool: C is not a
  // controller — the bar names controllers only. C charters freely
  // (their obligation is a debt, not a bar) — asserted here so the
  // bar's scope stays exactly BNK-D15's.
  seedCorp(wF, { homeCityId: CITY, corporationId: "bankC1", ownerMemberId: MEMBER_C, companyCashRubars: 150000 });
  const cCharters = run(wF, action(memberActor(MEMBER_C), MEMBER_C, "charter_bank", {
    cityId: CITY, corporationId: "bankC1", reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(cCharters.plan.outcome, "resolved", cCharters.plan.rejection?.summaryText ?? "");
  if (cCharters.event) wFEvents.push(cCharters.event);
  // ownerG is bankG's controller: barred now; after 2,000 seqs AND
  // with no personal obligations at bankG (G borrowed nothing),
  // the bar lifts on seqs alone.
  seedCorp(wF, { homeCityId: CITY, corporationId: "bankG2", ownerMemberId: OWNER_G, companyCashRubars: 150000 });
  const gBarred = run(wF, action(memberActor(OWNER_G), OWNER_G, "charter_bank", {
    cityId: CITY, corporationId: "bankG2", reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(gBarred.plan.rejection?.code, "controller-barred");
  advanceSeqs(wF, 2100);
  const gFree = run(wF, action(memberActor(OWNER_G), OWNER_G, "charter_bank", {
    cityId: CITY, corporationId: "bankG2", reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
  }));
  assert.equal(gFree.plan.outcome, "resolved", gFree.plan.rejection?.summaryText ?? "");
  if (gFree.event) wFEvents.push(gFree.event);
});

check("M9: the pool's book is not the old owner's — B-11 on an assigned loan refuses", () => {
  const attempt = run(wF, action(memberActor(OWNER_G), OWNER_G, "write_off_loan", {
    cityId: CITY, corporationId: "bankG", loanId: loanGD.loanId, borrower: loanGD.borrower, amountRubars: 1000,
  }));
  assert.equal(attempt.plan.outcome, "rejected");
  assert.equal(attempt.plan.rejection?.code, "loan-not-active");
});

check("W3 conservation clean (v2 fixture + senior queue + pool recovery, standing Log)", () => {
  assertConservationClean(wF, wFEvents, "W3");
});

// ---------------------------------------------------------------------------
section("W4 — verb batteries: B-06 boundaries, insider cap, pledges, B-08 excess/cure, netting scope, A-8 NPC Tier B");

const w4 = seedWorld();
const w4Events: ConservationEvent[] = [];
const OWNER_W = "ownerW";
for (const m of [OWNER_W, OWNER_A, MEMBER_B, MEMBER_C, MEMBER_D, MEMBER_E]) seedAccount(w4, m, 900000);
seedCorp(w4, { homeCityId: CITY, corporationId: "bankW", ownerMemberId: OWNER_W, companyCashRubars: 400000 });
charter(w4, w4Events, OWNER_W, CITY, "bankW");
deposit(w4, w4Events, MEMBER_B, CITY, "bankW", 300000);
// bankW: cash 700,000 · liabilities 300,000 · reserve 60,000 ·
// lendable 640,000 · unencumbered 340,000 · net worth 400,000.

check("B-06 boundary: cash funding at lendable + 1 rejects in full — and the RECORD's cash branch governs (no silent switch to credit creation)", () => {
  const offer = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 640001, rateBpsPerKseq: 1000,
    installmentCount: 2, dueIntervalSeqs: 50, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
  });
  const plan = acceptLoan(w4, w4Events, memberActor(MEMBER_D), MEMBER_D, CITY, offer);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "insufficient-lendable-cash");
  const after = loansOf(w4, "bankW").find((l) => l.loanId === offer.loanId) as BankLoanRecord;
  assert.equal(after.status, "offered", "the offer rests, unfunded");
  assert.equal(
    depositsOf(w4, "bankW").filter((d) => d.origin === "credit-created").length,
    0,
    "no created deposit appeared — the record's funding branch governs, never the convenient one"
  );
});

let insiderLoan: BankLoanRecord;
check("B-06 insider cap (BNK-D3): funding AT 25% of net worth passes; 1 R over rejects", () => {
  insiderLoan = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: OWNER_W }, principalRubars: 100000, rateBpsPerKseq: 1000,
    installmentCount: 2, dueIntervalSeqs: 10000, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
  });
  const atCap = acceptLoan(w4, w4Events, memberActor(OWNER_W), OWNER_W, CITY, insiderLoan);
  assert.equal(atCap.outcome, "resolved", atCap.rejection?.summaryText ?? "");
  assert.equal(bankBlock(w4, CITY, "bankW").insiderLoansRubars, 100000);
  const over = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: OWNER_W }, principalRubars: 1, rateBpsPerKseq: 1000,
    installmentCount: 1, dueIntervalSeqs: 10000, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
  });
  const plan = acceptLoan(w4, w4Events, memberActor(OWNER_W), OWNER_W, CITY, over);
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "insider-cap-exceeded");
});

check("B-07 netting scope: netting against a CASH-funded loan rejects netting-not-available (V2-§2.3)", () => {
  const { plan } = run(w4, action(memberActor(OWNER_W), OWNER_W, "repay_loan", {
    cityId: CITY, corporationId: "bankW", loanId: insiderLoan.loanId, borrower: { kind: "personal", memberId: OWNER_W },
    amountRubars: 1000, netting: true, collateral: { kind: "none" },
  }));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "netting-not-available");
});

function seedListing(world: World, corporationId: string, price: number): void {
  world.set(listingPath(corporationId), buildListingDoc({
    corporationId, homeCityId: CITY, ownerMemberId: MEMBER_D, openingPriceRubars: price,
    committedFloatShares: 0, listedAtSeq: 1, sourceActionId: "seed", lastResolutionId: "seed", now: new Date(NOW),
  }));
}
function seedHolding(world: World, memberId: string, corporationId: string, quantity: number): void {
  world.set(holdingPath(memberId, corporationId), {
    ...buildHoldingDoc({
      memberId, corporationId, homeCityId: CITY, quantityShares: quantity, committedShares: 0,
      costBasisRubars: quantity * 1000, sourceActionId: "seed", sourceSeq: 1, lastResolutionId: "seed", now: new Date(NOW),
    }),
    pledgedShares: 0,
  });
}
seedListing(w4, "shareCo", 1000);
seedHolding(w4, MEMBER_D, "shareCo", 10);
seedHolding(w4, MEMBER_E, "shareCo", 10);

let shareLoanD: BankLoanRecord;
check("B-06 pledge validation: pledging more shares than free rejects insufficient-free-shares; at free it funds and the pledge marks", () => {
  const tooMany = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 8000, rateBpsPerKseq: 0,
    installmentCount: 2, dueIntervalSeqs: 40, defaultMissedCount: 1,
    collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 11 }, fundingSource: "cash",
  });
  const short = acceptLoan(w4, w4Events, memberActor(MEMBER_D), MEMBER_D, CITY, tooMany);
  assert.equal(short.outcome, "rejected");
  assert.equal(short.rejection?.code, "insufficient-free-shares");
  shareLoanD = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 8000, rateBpsPerKseq: 0,
    installmentCount: 2, dueIntervalSeqs: 40, defaultMissedCount: 1,
    collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 10 }, fundingSource: "cash",
  });
  const funded = acceptLoan(w4, w4Events, memberActor(MEMBER_D), MEMBER_D, CITY, shareLoanD);
  assert.equal(funded.outcome, "resolved", funded.rejection?.summaryText ?? "");
  assert.equal(doc(w4, holdingPath(MEMBER_D, "shareCo")).pledgedShares, 10);
});

check("B-08: seizure lands the mandatory excess-value return line in the same event (a plan without it does not validate)", () => {
  advanceSeqs(w4, 50);
  ripen(w4, `inst_${shareLoanD.loanId}_1`);
  const loan = loansOf(w4, "bankW").find((l) => l.loanId === shareLoanD.loanId) as BankLoanRecord;
  assert.equal(deriveLoanStanding(loan, counterSeq(w4)).inDefault, true);
  const cashDBefore = (doc(w4, `sim_member_accounts/${MEMBER_D}`).cashRubars as number);
  const { plan, event } = run(w4, action(memberActor(OWNER_W), OWNER_W, "seize_collateral", {
    cityId: CITY, corporationId: "bankW", loanId: shareLoanD.loanId, borrower: { kind: "personal", memberId: MEMBER_D },
    collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 10 },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w4Events.push(event);
  // Value 10 × 1,000 = 10,000 against a debt of 8,000: 8,000 of
  // satisfaction to the bank's seized assets, 2,000 of excess back
  // to the borrower IN CASH, in this event's Log changes.
  assert.equal((doc(w4, `sim_member_accounts/${MEMBER_D}`).cashRubars as number) - cashDBefore, 2000, "the excess return line moved 2,000 R to the borrower");
  const returnLine = event?.entries.flatMap((e) => e.changes).find((c) => c.field === `memberAccounts/${MEMBER_D}.cashRubars`);
  assert.ok(returnLine, "the standing Log carries the return as a change record");
  assert.equal(bankBlock(w4, CITY, "bankW").seizedAssetsRubars, 8000);
  const seized = loansOf(w4, "bankW").find((l) => l.loanId === shareLoanD.loanId) as BankLoanRecord;
  assert.equal(seized.outstandingRubars, 0);
  assert.equal(doc(w4, holdingPath(MEMBER_D, "shareCo")).quantityShares, 0, "the pledged shares left the pledgor");
});

check("B-08: a loan cured before commit does not seize — the commit-time derivation governs", () => {
  const loanE = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: MEMBER_E }, principalRubars: 8000, rateBpsPerKseq: 0,
    installmentCount: 2, dueIntervalSeqs: 40, defaultMissedCount: 1,
    collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 10 }, fundingSource: "cash",
  });
  const funded = acceptLoan(w4, w4Events, memberActor(MEMBER_E), MEMBER_E, CITY, loanE);
  assert.equal(funded.outcome, "resolved", funded.rejection?.summaryText ?? "");
  advanceSeqs(w4, 50);
  ripen(w4, `inst_${loanE.loanId}_1`);
  const defaulted = loansOf(w4, "bankW").find((l) => l.loanId === loanE.loanId) as BankLoanRecord;
  assert.equal(deriveLoanStanding(defaulted, counterSeq(w4)).inDefault, true, "default derived at the crossing");
  const cure = run(w4, action(memberActor(MEMBER_E), MEMBER_E, "repay_loan", {
    cityId: CITY, corporationId: "bankW", loanId: loanE.loanId, borrower: { kind: "personal", memberId: MEMBER_E },
    amountRubars: 4000, collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 10 },
  }));
  assert.equal(cure.plan.outcome, "resolved", cure.plan.rejection?.summaryText ?? "");
  if (cure.event) w4Events.push(cure.event);
  const cured = loansOf(w4, "bankW").find((l) => l.loanId === loanE.loanId) as BankLoanRecord;
  assert.equal(deriveLoanStanding(cured, counterSeq(w4)).inDefault, false, "the cure un-happens the default");
  const seize = run(w4, action(memberActor(OWNER_W), OWNER_W, "seize_collateral", {
    cityId: CITY, corporationId: "bankW", loanId: loanE.loanId, borrower: { kind: "personal", memberId: MEMBER_E },
    collateral: { kind: "shares", corporationId: "shareCo", cityId: CITY, quantityShares: 10 },
  }));
  assert.equal(seize.plan.outcome, "rejected");
  assert.equal(seize.plan.rejection?.code, "loan-not-in-default");
});

check("B-08 structure form: a company borrower's pledged structure seizes to the bank (lien consumed, link moves, excess returned)", () => {
  seedCorp(w4, { homeCityId: CITY, corporationId: "buildCo", ownerMemberId: MEMBER_C, companyCashRubars: 50000 });
  const buildCoPath = corpPath(CITY, "buildCo");
  w4.set(buildCoPath, { ...doc(w4, buildCoPath), linkedStructureIds: ["struct1"] });
  w4.set(`sim_cities/${CITY}/structures/struct1`, {
    structureId: "struct1", cityId: CITY, paidRubars: 30000, bankLien: null,
  });
  const offer = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "company", cityId: CITY, corporationId: "buildCo" }, principalRubars: 20000, rateBpsPerKseq: 0,
    installmentCount: 2, dueIntervalSeqs: 40, defaultMissedCount: 1,
    collateral: { kind: "structure", structureId: "struct1", cityId: CITY }, fundingSource: "cash",
  });
  const funded = acceptLoan(w4, w4Events, memberActor(MEMBER_C), MEMBER_C, CITY, offer);
  assert.equal(funded.outcome, "resolved", funded.rejection?.summaryText ?? "");
  assert.ok((doc(w4, `sim_cities/${CITY}/structures/struct1`).bankLien as Record<string, unknown> | null)?.bankCorporationId === "bankW", "the lien marked at funding");
  advanceSeqs(w4, 50);
  ripen(w4, `inst_${offer.loanId}_1`);
  const { plan, event } = run(w4, action(memberActor(OWNER_W), OWNER_W, "seize_collateral", {
    cityId: CITY, corporationId: "bankW", loanId: offer.loanId, borrower: { kind: "company", cityId: CITY, corporationId: "buildCo" },
    collateral: { kind: "structure", structureId: "struct1", cityId: CITY },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w4Events.push(event);
  const structure = doc(w4, `sim_cities/${CITY}/structures/struct1`);
  assert.equal(structure.bankLien, null, "the lien is consumed by the seizure");
  assert.equal((structure.seizedForBank as Record<string, unknown>).bankCorporationId, "bankW");
  assert.equal(doc(w4, buildCoPath).companyCashRubars, 80000, "disbursement 20,000 in, excess 10,000 (30,000 value − 20,000 debt) returned");
  assert.deepEqual(doc(w4, buildCoPath).linkedStructureIds, [], "the link leaves the borrower");
  assert.deepEqual(bankBlock(w4, CITY, "bankW") && doc(w4, corpPath(CITY, "bankW")).linkedStructureIds, ["struct1"], "the link lands on the bank");
  assert.equal(bankBlock(w4, CITY, "bankW").seizedAssetsRubars, 28000, "8,000 shares + 20,000 structure of recorded satisfaction");
});

check("A-8 (F-E11 closes): an NPC attempt at B-06 is a structural refusal — npc-tier-b-refused, zero writes, the offer untouched", () => {
  const npcId = "npcB1";
  const mandateId = "mand-b1";
  // The stage re-reads city ownership at evaluation: the NPC's
  // owner must own the principal city (the fixture faction's
  // ownerUids name ownerA), so the NPC is ownerA's — attempting to
  // accept a loan on its principal's behalf.
  w4.set(`sim_npcs/${npcId}`, {
    npcId, characterId: npcId, cityId: CITY, ownerUid: OWNER_A,
    displayNameSnapshot: "Fixture Steward", titleFreeform: "Steward", roleTemplate: "steward",
    personality: { traits: ["calm"], voiceNotes: null, characterNotes: null },
    scopeFreeform: "fixture", permissionMode: "act-for-me", status: "active",
    currentMandateId: mandateId, currentMandateVersion: 1,
    activationSeq: 1, retiredSeq: null, stateVersion: 1, createdAt: null, updatedAt: null,
  });
  w4.set(`sim_mandates/${mandateId}`, {
    mandateId, npcId, cityId: CITY, ownerUid: OWNER_A, currentVersion: 1, status: "active",
    currentVersionRef: `sim_mandates/${mandateId}/versions/1`,
    createdSeq: 1, revokedSeq: null, expiresAtSeq: null, createdAt: null, updatedAt: null,
  });
  const version = buildMandateVersion({
    version: 1, npcId, cityId: CITY, ownerUid: OWNER_A, permissionMode: "act-for-me",
    scopeFreeform: "fixture mandate",
    structuredScope: {
      triggerKinds: ["log-event"], allowedActionTypes: ["accept_loan"],
      namedRecordIds: [], counterpartyCityIds: null,
    } as never,
    caps: {
      perActionRubars: 10000000, perResolutionPeriodRubars: 100000000,
      periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false,
    } as never,
    negotiationBounds: null, alwaysEscalate: [], responseStyle: null,
    expiresAtSeq: null, horizonActions: null, sourceActionId: "act-fixture",
  }, new Date(NOW));
  w4.set(`sim_mandates/${mandateId}/versions/1`, { ...(version as unknown as Record<string, unknown>), effectiveSeq: 1 });
  const offer = offerLoan(w4, w4Events, OWNER_W, CITY, "bankW", {
    borrower: { kind: "personal", memberId: OWNER_A }, principalRubars: 5000, rateBpsPerKseq: 500,
    installmentCount: 1, dueIntervalSeqs: 1000, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
  });
  const npc = npcActorStanding({ npcId, ownerUid: OWNER_A, mandateId, mandateVersion: 1 });
  const plan = runAction(w4, action(npc as SimActor, OWNER_A, "accept_loan", {
    cityId: CITY, corporationId: "bankW", loanId: offer.loanId,
    borrower: { kind: "personal", memberId: OWNER_A }, collateral: { kind: "none" },
    // The stage's causality check: a trigger rooted in a committed
    // record (sourceSeq 0 < the world's head), of a kind the
    // mandate contemplates.
    trigger: { kind: "log-event", sourceId: "evt-1", sourceSeq: 0 },
  }));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "npc-tier-b-refused", `the handler's Tier B gate is the refusal (got ${plan.rejection?.code})`);
  assert.equal(plan.writes.length, 0, "zero writes — a structural refusal moves nothing");
  const after = loansOf(w4, "bankW").find((l) => l.loanId === offer.loanId) as BankLoanRecord;
  assert.equal(after.status, "offered");
});

check("W4 conservation clean (verb batteries over a live book)", () => {
  assertConservationClean(w4, w4Events, "W4");
});

// ---------------------------------------------------------------------------
section("W9 — failed-payment derivation (§5.1's second form) + B-09 exact-boundary cure");

const w9 = seedWorld();
const w9Events: ConservationEvent[] = [];
const OWNER_H = "ownerH";
for (const m of [OWNER_H, MEMBER_B, MEMBER_D]) seedAccount(w9, m, 900000);
seedCorp(w9, { homeCityId: CITY, corporationId: "bankH", ownerMemberId: OWNER_H, companyCashRubars: 150000 });
charter(w9, w9Events, OWNER_H, CITY, "bankH");
const depH = deposit(w9, w9Events, MEMBER_B, CITY, "bankH", 200000);
// bankH: cash 350,000 · liabilities 200,000 · reserve 40,000 ·
// unencumbered 110,000 · lendable 310,000 · net worth 150,000.

const w9Views: BankLogEventView[] = [];
function commitRejection(world: World, act: SimAction, bankCorporationId: string): ResolutionPlan {
  const plan = runAction(world, act);
  assert.equal(plan.outcome, "rejected", "expected a rejection to commit");
  const event = commitPlan(world, plan, act.actionId);
  w9Events.push(event);
  w9Views.push({
    seq: counterSeq(world),
    kind: "rejected",
    ruleIds: plan.rejection?.ruleIds ?? [],
    rejectionCode: plan.rejection?.code ?? null,
    bankCorporationId,
  });
  return plan;
}

check("failed-payment: two uncured B-03 insufficient-unencumbered rejections derive failure from the standing Log alone", () => {
  const first = commitRejection(w9, action(memberActor(MEMBER_B), MEMBER_B, "withdraw_deposit", {
    cityId: CITY, corporationId: "bankH", depositId: depH.depositId,
    depositor: { kind: "personal", memberId: MEMBER_B }, amountRubars: 150000,
  }), "bankH");
  assert.equal(first.rejection?.code, "insufficient-unencumbered");
  const second = commitRejection(w9, action(memberActor(MEMBER_B), MEMBER_B, "withdraw_deposit", {
    cityId: CITY, corporationId: "bankH", depositId: depH.depositId,
    depositor: { kind: "personal", memberId: MEMBER_B }, amountRubars: 140000,
  }), "bankH");
  assert.equal(second.rejection?.code, "insufficient-unencumbered");
  const derivation = deriveFailedPayment(w9Views, "bankH");
  assert.equal(derivation.failed, true);
  assert.equal(derivation.uncuredRejectionSeqs.length, 2);
  assert.equal(derivation.firstUncuredRejectionSeq, w9Views[0].seq);
  assert.equal(derivation.curedAtSeq, null);
  // The arithmetic form still reads sound — the two forms of
  // failure are distinct derivations, and this bank is the proof.
  assert.equal(deriveBankHealth(doc(w9, corpPath(CITY, "bankH"))), "sound");
});

check("B-09 cure boundary: an injection 1 R short does not cure; the exact figure cures (inclusive) and clears the derivation", () => {
  const loan = offerLoan(w9, w9Events, OWNER_H, CITY, "bankH", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 310000, rateBpsPerKseq: 0,
    installmentCount: 2, dueIntervalSeqs: 10000, defaultMissedCount: 1, collateral: { kind: "none" }, fundingSource: "cash",
  });
  const funded = acceptLoan(w9, w9Events, memberActor(MEMBER_D), MEMBER_D, CITY, loan);
  assert.equal(funded.outcome, "resolved", funded.rejection?.summaryText ?? "");
  const writeOff = run(w9, action(memberActor(OWNER_H), OWNER_H, "write_off_loan", {
    cityId: CITY, corporationId: "bankH", loanId: loan.loanId, borrower: loan.borrower, amountRubars: 200000,
  }));
  assert.equal(writeOff.plan.outcome, "resolved", writeOff.plan.rejection?.summaryText ?? "");
  if (writeOff.event) w9Events.push(writeOff.event);
  assert.equal(deriveBankHealth(doc(w9, corpPath(CITY, "bankH"))), "insolvent", "net worth −50,000 after the write-off");
  // Failure freezes the book: B-04 settles nothing post-failure in
  // either branch (§5.3 fixes claim figures at the failure seq),
  // and B-11 may not forgive debt out of a failed bank (§5.4).
  for (const mode of ["credited", "cash"] as const) {
    const settle = run(w9, action(memberActor(OWNER_H), OWNER_H, "settle_deposit_interest", {
      cityId: CITY, corporationId: "bankH", depositId: depH.depositId, settlementMode: mode,
      depositor: { kind: "personal", memberId: MEMBER_B },
    }));
    assert.equal(settle.plan.outcome, "rejected");
    assert.equal(settle.plan.rejection?.code, "bank-failed", `B-04 ${mode} branch rejects against a failed bank`);
  }
  const forgive = run(w9, action(memberActor(OWNER_H), OWNER_H, "write_off_loan", {
    cityId: CITY, corporationId: "bankH", loanId: loan.loanId, borrower: loan.borrower, amountRubars: 1000,
  }));
  assert.equal(forgive.plan.outcome, "rejected");
  assert.equal(forgive.plan.rejection?.code, "write-off-in-failure");
  const inject = (amount: number): { plan: ResolutionPlan; stamp: Record<string, unknown> } => {
    const { plan, event } = run(w9, action(memberActor(OWNER_H), OWNER_H, "recapitalize_bank", {
      cityId: CITY, corporationId: "bankH", from: { kind: "personal", memberId: OWNER_H }, amountRubars: amount,
    }));
    assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
    if (event) w9Events.push(event);
    const summary = plan.entries[plan.entries.length - 1];
    const stamp = (summary.classification as Record<string, unknown>).recapitalization as Record<string, unknown>;
    w9Views.push({
      seq: counterSeq(w9), kind: "rule-effect", ruleIds: ["B-09"], rejectionCode: null,
      bankCorporationId: "bankH", curesFailedPayment: stamp.curesFailedPayment === true,
    });
    return { plan, stamp };
  };
  const short = inject(49999);
  assert.equal(short.stamp.cured, false, "net worth −1: no cure, and the entry says so");
  assert.equal(short.stamp.curesFailedPayment, false);
  assert.equal(deriveFailedPayment(w9Views, "bankH").failed, true, "the failed-payment episode stands through a non-cure");
  const exact = inject(1);
  assert.equal(exact.stamp.cured, true, "net worth exactly 0 with cash ≥ reserve: the boundary is inclusive");
  assert.equal(exact.stamp.curesFailedPayment, true);
  const derivation = deriveFailedPayment(w9Views, "bankH");
  assert.equal(derivation.failed, false, "the cure clears every uncured rejection standing before it");
  assert.equal(derivation.curedAtSeq, w9Views[w9Views.length - 1].seq);
  assert.equal(derivation.uncuredRejectionSeqs.length, 0);
});

check("W9 conservation clean (rejections carry no movements; the cure is a plain transfer pair)", () => {
  assertConservationClean(w9, w9Events, "W9");
});

// ---------------------------------------------------------------------------
section("W5 — sound-bank exit: charter surrender at zero claims; live claims bar it");

const w5 = seedWorld();
const w5Events: ConservationEvent[] = [];
const OWNER_S = "ownerS";
for (const m of [OWNER_S, MEMBER_B]) seedAccount(w5, m, 900000);
seedCorp(w5, { homeCityId: CITY, corporationId: "bankS", ownerMemberId: OWNER_S, companyCashRubars: 200000 });
seedCorp(w5, { homeCityId: CITY, corporationId: "bankT", ownerMemberId: OWNER_S, companyCashRubars: 200000 });
charter(w5, w5Events, OWNER_S, CITY, "bankS");
charter(w5, w5Events, OWNER_S, CITY, "bankT");

check("B-01 surrender: a sound bank with no live claims surrenders its charter and continues as an ordinary company", () => {
  const { plan, event } = run(w5, action(memberActor(OWNER_S), OWNER_S, "surrender_charter", {
    cityId: CITY, corporationId: "bankS",
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w5Events.push(event);
  const corp = doc(w5, corpPath(CITY, "bankS"));
  const block = corp.bank as Record<string, unknown> | undefined;
  assert.ok(!block || block.status !== "active", "the charter no longer stands active");
  assert.equal(corp.status, "active", "the company itself continues — surrender ends banking powers, not the company");
});

check("B-01 surrender barred with live claims: the bank exits by ceasing to owe and be owed first (§1.4)", () => {
  deposit(w5, w5Events, MEMBER_B, CITY, "bankT", 10000);
  const { plan } = run(w5, action(memberActor(OWNER_S), OWNER_S, "surrender_charter", {
    cityId: CITY, corporationId: "bankT",
  }));
  assert.equal(plan.outcome, "rejected");
  assert.equal(plan.rejection?.code, "charter-has-live-claims");
});

check("W5 conservation clean", () => {
  assertConservationClean(w5, w5Events, "W5");
});


// ---------------------------------------------------------------------------
section("W6 — creation tests at their boundaries, the premium ladder walk, REC-6 per-term identity, B-10 trigger branches");

const w6 = seedWorld();
const w6Events: ConservationEvent[] = [];
const OWNER_L = "ownerL";
for (const m of [OWNER_L, MEMBER_B, MEMBER_C, MEMBER_D, MEMBER_E]) seedAccount(w6, m, 900000);
foundDif(w6, memberActor(OWNER_L), OWNER_L);
seedCorp(w6, { homeCityId: CITY, corporationId: "bankL", ownerMemberId: OWNER_L, companyCashRubars: 400000 });
charter(w6, w6Events, OWNER_L, CITY, "bankL");
deposit(w6, w6Events, MEMBER_B, CITY, "bankL", 100000);

function ladderOf(world: World, bankCorporationId: string) {
  const markers: PremiumMarkerView[] = [];
  const settlements: PremiumSettlementView[] = [];
  for (const entry of entriesOf(world)) {
    const classification = (entry.classification ?? {}) as Record<string, unknown>;
    const due = classification.premiumDue as { bankCorporationId?: string; pendingId?: string; dueRubars?: number } | undefined;
    if (due?.bankCorporationId === bankCorporationId) {
      markers.push({ pendingId: due.pendingId ?? "", seq: entry.seq as number, dueRubars: due.dueRubars ?? 0, periodIndex: 0 });
    }
    const settlement = classification.premiumSettlement as { bankCorporationId?: string; settledPendingIds?: string[] } | undefined;
    if (settlement?.bankCorporationId === bankCorporationId) {
      settlements.push({ seq: entry.seq as number, settledPendingIds: settlement.settledPendingIds ?? [] });
    }
  }
  return derivePremiumLadder({ markers, settlements });
}

check("item 12 ladder walk: one unsettled period delinques, two suspend (B-02 rejects), arrears paid in full cure — all derived from the standing Log", () => {
  assert.ok(maybeDoc(w6, "sim_pending_consequences/prem_bankL_0"), "the post-founding charter seeded the premium chain (B-01's additive branch)");
  assert.equal(ladderOf(w6, "bankL").state, "current");
  advanceSeqs(w6, 1000);
  ripen(w6, "prem_bankL_0");
  const afterOne = ladderOf(w6, "bankL");
  assert.equal(afterOne.state, "delinquent");
  assert.equal(afterOne.arrearsRubars, premiumDueRubars({ insuredLiabilitiesRubars: 100000, riskMultiplier: 2, periodSeqs: 1000 }));
  advanceSeqs(w6, 1000);
  ripen(w6, "prem_bankL_1");
  const afterTwo = ladderOf(w6, "bankL");
  assert.equal(afterTwo.state, "suspended", "two consecutive unsettled periods suspend (V2-§1.3)");
  assert.equal(afterTwo.arrearsRubars, 400);
  assert.equal(afterTwo.suspensionIntervals.length, 1);
  assert.equal(afterTwo.suspensionIntervals[0].toSeq, null, "the suspension interval stands open");
  const blocked = run(w6, action(memberActor(MEMBER_C), MEMBER_C, "deposit_funds", {
    cityId: CITY, corporationId: "bankL", depositor: { kind: "personal", memberId: MEMBER_C }, amountRubars: 1000, rateBpsPerKseq: 500,
  }));
  assert.equal(blocked.plan.outcome, "rejected");
  assert.equal(blocked.plan.rejection?.code, "premium-delinquent-suspended");
  const cure = run(w6, action(memberActor(OWNER_L), OWNER_L, "pay_insurance_premium", {
    cityId: CITY, corporationId: "bankL", amountRubars: 400,
  }));
  assert.equal(cure.plan.outcome, "resolved", cure.plan.rejection?.summaryText ?? "");
  if (cure.event) w6Events.push(cure.event);
  const cured = ladderOf(w6, "bankL");
  assert.equal(cured.state, "current", "paying arrears in full cures by derivation — no flag flips");
  assert.equal(cured.arrearsRubars, 0);
  assert.equal(cured.suspensionIntervals[0].toSeq !== null, true, "the interval closes at the cure");
  const again = deposit(w6, w6Events, MEMBER_C, CITY, "bankL", 1000);
  assert.ok(again.depositId, "deposits flow again after the cure");
});

check("item 5 creation tests at their boundaries: reserve test and equity floor reject independently; the floor's exact boundary funds", () => {
  seedCorp(w6, { homeCityId: CITY, corporationId: "bankR", ownerMemberId: OWNER_L, companyCashRubars: 150000 });
  charter(w6, w6Events, OWNER_L, CITY, "bankR");
  deposit(w6, w6Events, MEMBER_E, CITY, "bankR", 10000);
  // bankR: cash 160,000 · liabilities 10,000. A created 800,000
  // takes liabilities to 810,000 → reserve 162,000 > cash 160,000.
  const reserveOffer = offerLoan(w6, w6Events, OWNER_L, CITY, "bankR", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 800000, rateBpsPerKseq: 1000,
    installmentCount: 2, dueIntervalSeqs: 100, defaultMissedCount: 1, collateral: { kind: "none" },
    fundingSource: "credit", createdDepositRateBpsPerKseq: 0,
  });
  const reservePlan = acceptLoan(w6, w6Events, memberActor(MEMBER_D), MEMBER_D, CITY, reserveOffer);
  assert.equal(reservePlan.outcome, "rejected");
  assert.equal(reservePlan.rejection?.code, "creation-reserve-shortfall");
  seedCorp(w6, { homeCityId: CITY, corporationId: "bankK", ownerMemberId: OWNER_L, companyCashRubars: 150000 });
  charter(w6, w6Events, OWNER_L, CITY, "bankK");
  deposit(w6, w6Events, MEMBER_E, CITY, "bankK", 500000);
  // bankK: cash 650,000 · liabilities 500,000 · net worth 150,000.
  // Creation of 900,000: reserve passes (280,000 ≤ 650,000) but the
  // equity floor fails (150,000 < 10% × 1,550,000 assets).
  const floorOffer = offerLoan(w6, w6Events, OWNER_L, CITY, "bankK", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 900000, rateBpsPerKseq: 1000,
    installmentCount: 2, dueIntervalSeqs: 100, defaultMissedCount: 1, collateral: { kind: "none" },
    fundingSource: "credit", createdDepositRateBpsPerKseq: 0,
  });
  const floorPlan = acceptLoan(w6, w6Events, memberActor(MEMBER_D), MEMBER_D, CITY, floorOffer);
  assert.equal(floorPlan.outcome, "rejected");
  assert.equal(floorPlan.rejection?.code, "creation-capital-floor");
  // At exactly 850,000 the floor is met exactly (150,000 == 10% of
  // 1,500,000) — the boundary is inclusive and the pair books.
  const edgeOffer = offerLoan(w6, w6Events, OWNER_L, CITY, "bankK", {
    borrower: { kind: "personal", memberId: MEMBER_D }, principalRubars: 850000, rateBpsPerKseq: 1000,
    installmentCount: 2, dueIntervalSeqs: 100, defaultMissedCount: 1, collateral: { kind: "none" },
    fundingSource: "credit", createdDepositRateBpsPerKseq: 0,
  });
  const cashBefore = (doc(w6, corpPath(CITY, "bankK")).companyCashRubars as number);
  const edgePlan = acceptLoan(w6, w6Events, memberActor(MEMBER_D), MEMBER_D, CITY, edgeOffer);
  assert.equal(edgePlan.outcome, "resolved", edgePlan.rejection?.summaryText ?? "");
  assert.equal((doc(w6, corpPath(CITY, "bankK")).companyCashRubars as number), cashBefore, "creation at the boundary still moves no cash");
});

check("item 2: the REC-6 identity is per-term real — an adjudicated-payables term tips a slice-solvent bank to insolvent; receivables default to zero (M3)", () => {
  const base = doc(w1, corpPath(CITY, "bankA"));
  const sheet = bankBalanceSheet(base);
  assert.ok(sheet);
  assert.equal(sheet.recognizedInsuranceReceivablesRubars, 0, "no recognition stands → the term is zero, never contingent coverage (M3)");
  assert.ok(sheet.netWorthRubars > 0, "bankA is solvent on its standing sheet");
  const taxed = { ...base, taxPayables: { [CITY]: 7000 } };
  assert.equal(bankBalanceSheet(taxed)?.taxPayablesRubars, 7000, "the tax term reads the record's payables map");
  assert.equal(bankBalanceSheet(taxed)?.netWorthRubars, sheet.netWorthRubars - 7000);
  const tipped = { ...base, adjudicatedPayablesRubars: sheet.netWorthRubars + 1 };
  assert.equal(bankBalanceSheet(tipped)?.netWorthRubars, -1);
  assert.equal(deriveBankHealth(tipped), "insolvent", "solvent under the Phase 4 slice form (cash − deposits), insolvent under REC-6 — the swap is not cosmetic");
  const recognized = bankBalanceSheet(base, { recognizedInsuranceReceivablesRubars: 123 });
  assert.equal(recognized?.totalAssetsRubars, sheet.totalAssetsRubars + 123, "receivables enter only as an explicit post-recognition input");
});

check("item 9 branches: a depositor trigger against a sound bank rejects bank-not-failed; the owner's voluntary dissolution of a sound bank runs the waterfall and pays claims in full", () => {
  seedCorp(w6, { homeCityId: CITY, corporationId: "bankV", ownerMemberId: OWNER_L, companyCashRubars: 300000 });
  charter(w6, w6Events, OWNER_L, CITY, "bankV");
  const depV = deposit(w6, w6Events, MEMBER_C, CITY, "bankV", 100000);
  const triggerAttempt = run(w6, action(memberActor(MEMBER_C), MEMBER_C, "liquidate_bank", {
    cityId: CITY, corporationId: "bankV", trigger: "depositor", depositId: depV.depositId,
  }));
  assert.equal(triggerAttempt.plan.outcome, "rejected");
  assert.equal(triggerAttempt.plan.rejection?.code, "bank-not-failed");
  const live = depositsOf(w6, "bankV").find((d) => d.depositId === depV.depositId) as BankDepositRecord;
  const frozen = live.principalRubars + live.creditedInterestRubars + accruedUnsettledRubars(live, counterSeq(w6) + 1);
  const cashCBefore = (doc(w6, `sim_member_accounts/${MEMBER_C}`).cashRubars as number);
  const { plan, event } = run(w6, action(memberActor(OWNER_L), OWNER_L, "liquidate_bank", {
    cityId: CITY, corporationId: "bankV", trigger: "owner",
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w6Events.push(event);
  assert.equal(doc(w6, corpPath(CITY, "bankV")).status, "dissolved");
  assert.equal((doc(w6, `sim_member_accounts/${MEMBER_C}`).cashRubars as number) - cashCBefore, frozen, "the estate paid the full frozen claim — no failure precondition on the owner branch (§5.5)");
  const after = depositsOf(w6, "bankV").find((d) => d.depositId === depV.depositId) as BankDepositRecord;
  assert.equal(poolUnpaidRubars(after), 0, "nothing stands as a pool claim — the position closed whole");
});

check("W6 conservation clean (ladder, creation boundaries, sound-bank dissolution)", () => {
  assertConservationClean(w6, w6Events, "W6");
});

// ---------------------------------------------------------------------------
section("X — tamper negatives (falsifiability), §4.1 loan interest from the Log, frozen world, export scope");

check("§4.1 extended to loan interest: the settled figure recomputes from the record + the settlement entry's seq alone", () => {
  const loan = loansOf(w4, "bankW").find((l) => l.loanId === insiderLoan.loanId) as BankLoanRecord;
  advanceSeqs(w4, 500);
  const counterBefore = counterSeq(w4);
  const cashBefore = (doc(w4, `sim_member_accounts/${OWNER_W}`).cashRubars as number);
  const { plan, event } = run(w4, action(memberActor(OWNER_W), OWNER_W, "repay_loan", {
    cityId: CITY, corporationId: "bankW", loanId: loan.loanId, borrower: { kind: "personal", memberId: OWNER_W },
    amountRubars: 50000, collateral: { kind: "none" },
  }));
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  if (event) w4Events.push(event);
  const settleIdx = plan.entries.findIndex((e) =>
    e.changes.some((c) => c.field === `bankLoans/${loan.loanId}.lastSettledSeq`)
  );
  assert.ok(settleIdx >= 0, "the settlement entry advances the loan's watermark");
  const settleSeq = counterBefore + settleIdx + 1;
  // The §4.1 formula, recomputed from first principles off the
  // record: floor(outstanding × rate × Δseq / 10^7).
  const expected = Math.floor((loan.outstandingRubars * loan.rateBpsPerKseq * (settleSeq - loan.lastSettledSeq)) / 10_000_000);
  assert.equal(deriveLoanStanding(loan, settleSeq).accruedInterestRubars, expected, "the pure derivation IS the formula");
  const summary = plan.entries[plan.entries.length - 1];
  const loanClass = (summary.classification as Record<string, unknown>).loan as Record<string, unknown>;
  assert.equal(loanClass.interestRubars, expected, "the event settled exactly the recomputed figure");
  const after = loansOf(w4, "bankW").find((l) => l.loanId === loan.loanId) as BankLoanRecord;
  assert.equal(after.totalInterestPaidRubars, expected);
  assert.equal(cashBefore - (doc(w4, `sim_member_accounts/${OWNER_W}`).cashRubars as number), 50000);
});

function cloneWorld(world: World): World {
  return new Map([...world.entries()].map(([k, v]) => [k, v ? structuredClone(v) : v] as [string, Record<string, unknown> | null]));
}

check("tamper negative A-B2: a +1 R edit to a loan record's outstanding (no event) is CAUGHT by the standing assertion", () => {
  const clean = checkConservation(w4Events, conservationRecords(w4));
  assert.equal(clean.ok, true, "the untampered book is clean first (the negative is falsifiable, not vacuous)");
  const tampered = cloneWorld(w4);
  const loan = loansOf(tampered, "bankW").find((l) => l.status === "active") as BankLoanRecord;
  const path = `sim_bank_loans/${loan.loanId}`;
  tampered.set(path, { ...doc(tampered, path), outstandingRubars: loan.outstandingRubars + 1 });
  const result = checkConservation(w4Events, conservationRecords(tampered));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "A_B2_LOAN_BOOK_AGGREGATE"), `expected A_B2_LOAN_BOOK_AGGREGATE, got ${result.findings.map((f) => f.code).join(", ")}`);
});

check("tamper negative A-B4: repointing a created deposit's fundingLoanId at no loan is CAUGHT (unpaired issuance is visible)", () => {
  const tampered = cloneWorld(wF);
  const created = depositsOf(tampered, "bankG").find((d) => d.origin === "credit-created") as BankDepositRecord;
  const path = `sim_bank_deposits/${created.depositId}`;
  tampered.set(path, { ...doc(tampered, path), fundingLoanId: "loan_does_not_exist" });
  const result = checkConservation(wFEvents, conservationRecords(tampered));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "A_B4_CREATION_PAIRING"), `expected A_B4_CREATION_PAIRING, got ${result.findings.map((f) => f.code).join(", ")}`);
});

check("tamper negative CLAIM_UNEXPLAINED: a claim increase with no settlement cash in the event is CAUGHT", () => {
  const synthetic: ConservationEvent = {
    resolutionId: "tamper-claim",
    entries: [{ seq: 999999, cityId: null, ruleIds: ["B-02"], changes: [] }],
    writeSet: [{
      path: "sim_bank_deposits/dep_tamper",
      op: "update",
      beforeDoc: { depositId: "dep_tamper", bankCorporationId: "bankA", origin: "cash-funded", principalRubars: 100000, creditedInterestRubars: 0 },
      afterDoc: { depositId: "dep_tamper", bankCorporationId: "bankA", origin: "cash-funded", principalRubars: 150000, creditedInterestRubars: 0 },
    }],
  };
  const result = checkConservation([synthetic], conservationRecords(w1));
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((f) => f.code === "CLAIM_UNEXPLAINED"), `expected CLAIM_UNEXPLAINED, got ${result.findings.map((f) => f.code).join(", ")}`);
});

check("frozen world: 10,000 seqs of other realms' traffic change no banking state (no clock, no auto-debit, no ripening without a cause)", () => {
  const before = new Map(
    [...wF.entries()].filter(([path]) => !path.startsWith("sim_counters/") && path !== "sim_world/current")
  );
  advanceSeqs(wF, 10000);
  for (const [path, docBefore] of before) {
    assert.deepEqual(wF.get(path), docBefore, `frozen: ${path} unchanged`);
  }
});

check("item 13 evidence: a B-14 supplemental assessment obligation arose for the surviving bankG at its premium ripening after failure 1 drained the fund", () => {
  const summaries = entriesOf(wF).map((e) => String(e.summaryText ?? ""));
  assert.ok(
    summaries.some((t) => t.includes("B-14 assessment obligation") && t.includes("bankG")),
    "bankG's premium ripening entry states the B-14 obligation it created (fund deficient after bankF)"
  );
  const asm = [...wF.keys()].filter((path) => path.startsWith("sim_pending_consequences/asm_bankG_"));
  assert.ok(asm.length >= 1, "the assessment pending stands as its own obligation (asm_bankG_*)");
});

check("item 15 exports: §7.5 scope is fail-closed in the pure layer; the verified sheet labels tracked cash and created supply separately (G4)", () => {
  const ctx: ExportContext = { asOfSeq: counterSeq(w4), rulesVersion: null, exportedAtIso: NOW, exportedByLabel: "harness" };
  const row = {
    depositId: "dep_x", bankCorporationId: "bankW", depositorLabel: MEMBER_B, depositorMemberId: MEMBER_B,
    principalRubars: 100, creditedInterestRubars: 0, origin: "cash", rateBpsPerKseq: 500,
    status: "active", openedAtSeq: 1, lastChangedSeq: 1, stateVersion: 1,
  };
  assert.throws(
    () => buildBankBookDepositsWorkbook(
      { bankCorporationId: "bankW", bankCityId: CITY, bankLabel: "bankW", bankOwnerMemberId: OWNER_W, view: "bank-owner", deposits: [row] },
      ctx, MEMBER_D
    ),
    ExportError,
    "a non-owner asking for the owner's book throws"
  );
  assert.throws(
    () => buildBankBookDepositsWorkbook(
      { bankCorporationId: "bankW", bankCityId: CITY, bankLabel: "bankW", bankOwnerMemberId: OWNER_W, view: "depositor", deposits: [row] },
      ctx, MEMBER_C
    ),
    ExportError,
    "a depositor view containing someone else's row throws"
  );
  const lawful = buildBankBookDepositsWorkbook(
    { bankCorporationId: "bankW", bankCityId: CITY, bankLabel: "bankW", bankOwnerMemberId: OWNER_W, view: "depositor", deposits: [row] },
    ctx, MEMBER_B
  );
  assert.ok(lawful.sheets.length >= 1, "the lawful view builds");
  const sheet = buildBankVerifiedSheetWorkbook({
    bankCorporationId: "bankW", bankCityId: CITY, bankLabel: "bankW", charterStatus: "active",
    reserveRatioBps: 2000, depositRateCeilingBpsPerKseq: 2000, loanRateCeilingBpsPerKseq: 3000,
    trackedCashRubars: 592000, loanBookRubars: 100000, seizedAssetsRubars: 28000,
    depositLiabilitiesRubars: 300000, netWorthRubars: 400000, liquidReserveRubars: 60000,
    health: "sound", createdSupplyRubars: 0, insurancePosture: "no-institution", asOfSeq: counterSeq(w4), stateVersion: 1,
  }, ctx);
  const rendered = JSON.stringify(sheet);
  assert.ok(rendered.includes("tracked_cash_rubars"), "tracked cash is labeled as tracked cash");
  assert.ok(rendered.includes("created_supply_rubars"), "created supply is labeled as created supply");
  assert.ok(!rendered.includes("money_supply"), "no unqualified money-supply label anywhere (G4)");
});

// ---------------------------------------------------------------------------
section("A1 (PR-6 assembly) — the resolver's schedule branch drives a premium ripening end-to-end");

const wA = seedWorld();
const wAEvents: ConservationEvent[] = [];
seedAccount(wA, OWNER_A, 900000);
seedAccount(wA, MEMBER_B, 900000);
seedCorp(wA, { homeCityId: CITY, corporationId: "bankA1", ownerMemberId: OWNER_A, companyCashRubars: 150000 });
foundDif(wA, memberActor(OWNER_A), OWNER_A);
charter(wA, wAEvents, OWNER_A, CITY, "bankA1");
deposit(wA, wAEvents, MEMBER_B, CITY, "bankA1", 100000);
advanceSeqs(wA, 1100);

function driveScheduleRipening(world: World, pendingId: string) {
  const pending = doc(world, `sim_pending_consequences/${pendingId}`);
  const paths = collectRipeningReadPaths(pending);
  const queries = collectRipeningReadQueries(pending);
  const snapshotDocs: World = new Map();
  for (const path of paths) snapshotDocs.set(path, world.get(path) ?? null);
  const queryRecords = materializeQueries(world, queries as never[], snapshotDocs);
  const snapshot = snapshotFromDocs(snapshotDocs, NOW, queryRecords);
  return { pending, paths, queries, plan: resolveRipening(snapshot, pending, { baselineRegistry: registry }) };
}

check("A1: collectors declare the banking read set from the frozen schedule spec", () => {
  const pending = doc(wA, "sim_pending_consequences/prem_bankA1_0");
  const paths = collectRipeningReadPaths(pending);
  assert.ok(paths.includes(INSURANCE_FUND_PATH), "the fund singleton is a declared read path");
  assert.ok(paths.includes(corpPath(CITY, "bankA1")), "the bank corporation doc is a declared read path");
  const queryIds = collectRipeningReadQueries(pending).map((q) => q.id);
  for (const id of ["bankDeposits", "bankLoans", "premiumMarkers", "premiumSettlements", "assessmentMarkers", "standingSchedulePendings"]) {
    assert.ok(queryIds.includes(id), `query ${id} declared`);
  }
  assert.ok(queryIds.some((id) => id.startsWith("situationsByKey")), "the bank city's Situation query is declared");
});

check("A1: resolveRipening lands the premium ripening + the Lead-owned transition + the successor", () => {
  const { plan } = driveScheduleRipening(wA, "prem_bankA1_0");
  assert.equal(plan.outcome, "resolved", plan.rejection?.summaryText ?? "");
  assert.ok(
    plan.pendingTransitions.some((t) => t.pendingId === "prem_bankA1_0" && t.toStatus === "ripened"),
    "the branch transitions the driven pending to ripened"
  );
  assert.ok(
    plan.entries.some((e) => e.ruleIds.includes("B-12")),
    "the premium marker entry lands under B-12"
  );
  assert.ok(
    plan.pendingCreates.some((c) => c.doc.pendingId === "prem_bankA1_1"),
    "the successor premium pending is created in-event (SPEC-1 perpetuation)"
  );
});

check("A1: a schedule ripening whose declared reads are absent refuses through the preparation channel", () => {
  const wBroken = new Map(wA);
  wBroken.delete(INSURANCE_FUND_PATH);
  assert.throws(
    () => driveScheduleRipening(wBroken, "prem_bankA1_0"),
    /refused \(ripening-read-incomplete\)/,
    "nothing ripens blind: the composition's refusal surfaces as a ripening preparation failure, never a committed rejection"
  );
});

console.log(`\nbanking harness: ${checks} checks passed`);
