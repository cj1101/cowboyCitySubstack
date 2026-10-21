/**
 * The Realm Deposit Insurance Fund (DIF) — pure layer (banking
 * amendment §5.7 as conformed by REC-3/REC-5/REC-7, Addendum
 * V2-§1). The institution record, coverage derivations, premium
 * formula, delinquency ladder, deficiency derivation, and the B-14
 * supplemental assessment arithmetic. Handlers live in
 * lib/sim/rules/finance.ts (B-12/B-13/B-14 + the founding
 * composition); the conservation checker asserts A-B6 over these
 * derivations.
 *
 * Postures held throughout:
 *  - The fund is NOT an actor, NOT the Market Account, NOT a
 *    treasury, NOT a lender of last resort (V2-§1.1). Its account
 *    is the fifth tracked account class (REC-3): the institution
 *    record's own `fundCashRubars` (./accounts.ts institution ref).
 *  - Coverage is a DERIVATION, never a stored flag (V2-§1.4):
 *    per-deposit, by open date, against fund existence and the
 *    bank's suspension intervals. Grandfathering exists only as a
 *    founding-act election; this build's act elects NONE (M12).
 *  - The guarantee's three-state life (REC-7): contingent coverage
 *    (memo exposure only — never an asset) → recognized claim (the
 *    queued unpaid shortfall inside/after B-10) → paid claim.
 *  - Premiums are a published formula whose risk band reads the
 *    bank's latest §6 assessment grade as an INPUT (V2-§1.3): the
 *    AI sets no premium; the bands are constants.
 */

import {
  COVERAGE_CAP_RUBARS,
  PREMIUM_BASE_BPS_PER_KSEQ,
  PREMIUM_PERIOD_SEQS,
  TARGET_FUND_RATIO_BPS,
  accruedUnsettledRubars,
  bankBlockOf,
  type BankDepositRecord,
  type InsurancePosture,
} from "./banking";
import { INSURANCE_FUND_PATH } from "./accounts";

export { INSURANCE_FUND_PATH };

// ---------------------------------------------------------------------------
// The institution record (V2-§1.2) — singleton
// sim_deposit_insurance_fund/main, created by the founding event.
// ---------------------------------------------------------------------------

export interface DepositInsuranceFundRecord {
  institutionId: "dif";
  establishedAtSeq: number;
  establishingEntryId: string;
  /** Committer-maintained aggregate == the segregated account's
   * balance (A-B6 asserts it against the derivation). */
  fundCashRubars: number;
  /** Aggregate over eligible banks' covered-class non-insider
   * claim-basis liabilities; verifier-checked (A-B6). Maintained by
   * the events that move insured liabilities (B-02/B-04/B-06/B-10)
   * through the shared insured-liabilities derivation below. */
  totalInsuredLiabilitiesRubars: number;
  /** The founding act's grandfathering election (BNK-D18): this
   * build's act elects NONE — deposits opened before founding
   * derive uninsured for their whole lives (V2-§1.4). */
  grandfathering: "none" | { assumedInsuredLiabilitiesRubars: number };
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: unknown; // committer-stamped
  updatedAt: unknown;
}

export function fundRecordOf(doc: Record<string, unknown> | null): DepositInsuranceFundRecord | null {
  if (!doc || doc.institutionId !== "dif") return null;
  return doc as unknown as DepositInsuranceFundRecord;
}

export function buildDifFundDoc(args: {
  establishedAtSeq: number;
  establishingEntryId: string;
  totalInsuredLiabilitiesRubars: number;
}): Record<string, unknown> {
  const record: DepositInsuranceFundRecord = {
    institutionId: "dif",
    establishedAtSeq: args.establishedAtSeq,
    establishingEntryId: args.establishingEntryId,
    fundCashRubars: 0,
    totalInsuredLiabilitiesRubars: args.totalInsuredLiabilitiesRubars,
    grandfathering: "none",
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdAt: null,
    updatedAt: null,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Coverage derivation (V2-§1.4) — per-deposit, by open date.
// `suspensionIntervals` for the deposit's bank are derived from the
// standing Log (premium markers + settlements) by the caller with
// Log access; this module defines the interval shape and the test.
// ---------------------------------------------------------------------------

export interface SuspensionInterval {
  /** The seq from which deposits opened are uninsured (the second
   * consecutive unsettled period's ripening seq). */
  fromSeq: number;
  /** The cure seq that ended the suspension, or null while open. */
  toSeq: number | null;
}

export function depositOpenedDuringSuspension(
  openedAtSeq: number,
  intervals: readonly SuspensionInterval[]
): boolean {
  return intervals.some(
    (i) => openedAtSeq >= i.fromSeq && (i.toSeq === null || openedAtSeq < i.toSeq)
  );
}

/** Insider deposits are excluded from coverage AND from the premium
 * base (V2-§1.4): the depositor is the bank's ownerMemberId. */
export function isInsiderDeposit(
  deposit: Pick<BankDepositRecord, "depositor">,
  bankOwnerMemberId: string
): boolean {
  return deposit.depositor.kind === "personal" && deposit.depositor.memberId === bankOwnerMemberId;
}

export interface CoverageContext {
  fund: DepositInsuranceFundRecord | null;
  /** Suspension intervals of THIS deposit's bank (Log-derived). */
  suspensionIntervals: readonly SuspensionInterval[];
  bankOwnerMemberId: string;
}

/** A deposit is covered-class iff: the fund existed at its open
 * seq (or the founding act grandfathered it — not this build), it
 * was not opened during a suspension of its bank, and it is not an
 * insider deposit. Classes (member/company/treasury) are covered on
 * identical terms (V2-§1.4) — LedgerRef kind does not gate here
 * because only those three kinds can hold deposits at all (§2.3). */
export function depositCoveredClass(
  deposit: BankDepositRecord,
  ctx: CoverageContext
): boolean {
  if (!ctx.fund) return false;
  if (isInsiderDeposit(deposit, ctx.bankOwnerMemberId)) return false;
  if (deposit.openedAtSeq < ctx.fund.establishedAtSeq) {
    // Pre-founding deposits derive uninsured for their whole lives
    // unless the founding act grandfathered them (this build: none).
    if (ctx.fund.grandfathering === "none") return false;
  }
  if (depositOpenedDuringSuspension(deposit.openedAtSeq, ctx.suspensionIntervals)) return false;
  return true;
}

/** The claim basis (REC-5): principal + credited + computable
 * unsettled interest at the reading seq — one basis for tier (c),
 * coverage, and setoff. */
export function claimBasisRubars(deposit: BankDepositRecord, atSeq: number): number {
  return (
    deposit.principalRubars +
    deposit.creditedInterestRubars +
    accruedUnsettledRubars(deposit, atSeq)
  );
}

/** Per-depositor-per-bank coverage (V2-§1.4): the cap reads the
 * depositor's COMBINED claim at the bank, not per record. Given
 * the depositor's covered-class claims (frozen figures at the
 * failure seq), the covered total is min(Σ claims, CAP); the split
 * back onto records is pro-rata by claim so Σ covered over the
 * depositor's records equals the covered total exactly. */
export function coveredSplitForDepositor(
  claims: readonly number[]
): { coveredTotal: number; coveredByIndex: number[] } {
  const total = claims.reduce((sum, c) => sum + c, 0);
  const coveredTotal = Math.min(total, COVERAGE_CAP_RUBARS);
  if (total <= 0) return { coveredTotal: 0, coveredByIndex: claims.map(() => 0) };
  const coveredByIndex = claims.map((c) => Math.floor((coveredTotal * c) / total));
  // Floor dust goes to the largest claim (ties: earliest) so the
  // split sums EXACTLY to the covered total.
  let assigned = coveredByIndex.reduce((sum, c) => sum + c, 0);
  if (assigned < coveredTotal && claims.length > 0) {
    let largest = 0;
    for (let i = 1; i < claims.length; i += 1) {
      if (claims[i] > claims[largest]) largest = i;
    }
    coveredByIndex[largest] += coveredTotal - assigned;
    assigned = coveredTotal;
  }
  return { coveredTotal, coveredByIndex };
}

// ---------------------------------------------------------------------------
// Insured liabilities (the premium base + A-B6's aggregate) —
// Σ claim-basis (principal + credited) over a bank's covered-class,
// non-insider, ACTIVE deposits. Created deposits are included
// (V2-§2.7: a bank that manufactures liabilities pays to insure
// them). Computed identically by handlers (aggregate maintenance),
// the premium derivation, and the checker (A-B6).
// ---------------------------------------------------------------------------

export function insuredLiabilitiesForBank(args: {
  deposits: readonly BankDepositRecord[];
  bankCorporationId: string;
  fund: DepositInsuranceFundRecord | null;
  suspensionIntervals: readonly SuspensionInterval[];
  bankOwnerMemberId: string;
}): number {
  if (!args.fund) return 0;
  let total = 0;
  for (const deposit of args.deposits) {
    if (deposit.bankCorporationId !== args.bankCorporationId) continue;
    if (deposit.status !== "active") continue;
    const covered = depositCoveredClass(deposit, {
      fund: args.fund,
      suspensionIntervals: args.suspensionIntervals,
      bankOwnerMemberId: args.bankOwnerMemberId,
    });
    if (!covered) continue;
    total += deposit.principalRubars + deposit.creditedInterestRubars;
  }
  return total;
}

export function totalInsuredLiabilities(args: {
  deposits: readonly BankDepositRecord[];
  banks: readonly { corporationId: string; ownerMemberId: string }[];
  fund: DepositInsuranceFundRecord | null;
  suspensionIntervalsByBank: ReadonlyMap<string, readonly SuspensionInterval[]>;
}): number {
  let total = 0;
  for (const bank of args.banks) {
    total += insuredLiabilitiesForBank({
      deposits: args.deposits,
      bankCorporationId: bank.corporationId,
      fund: args.fund,
      suspensionIntervals: args.suspensionIntervalsByBank.get(bank.corporationId) ?? [],
      bankOwnerMemberId: bank.ownerMemberId,
    });
  }
  return total;
}

// ---------------------------------------------------------------------------
// Premiums (V2-§1.3, BNK-D11) — the published formula. The risk
// multiplier reads the bank's latest §6 risk grade into published
// bands: sound 1× · watch 2× · elevated 4×; unassessed = 2× (the
// unknown is priced as a watch, never as a sound).
// ---------------------------------------------------------------------------

export type BankRiskGrade = "sound" | "watch" | "elevated";

export function premiumRiskMultiplier(grade: BankRiskGrade | null): number {
  switch (grade) {
    case "sound":
      return 1;
    case "elevated":
      return 4;
    case "watch":
    case null:
      return 2;
  }
}

/** The bank's latest §6 risk grade, read from the corp doc's
 * assessment seam: an additive `bankAssessment` block a §6
 * assessment writer stamps. Nothing in PR-6 writes it (§6
 * assessments are judgment events, not banking mechanics), so
 * every bank reads unassessed (2×) until one lands — the honest
 * default the formula publishes. */
export function bankRiskGradeOf(
  corporationDoc: Record<string, unknown> | null
): BankRiskGrade | null {
  const block = bankBlockOf(corporationDoc);
  if (!block) return null;
  const assessment = (corporationDoc as Record<string, unknown>)?.bankAssessment as
    | { riskGrade?: unknown }
    | undefined;
  const grade = assessment?.riskGrade;
  return grade === "sound" || grade === "watch" || grade === "elevated" ? grade : null;
}

/** premiumDue = ceil(insuredLiabilities × BASE_BPS × multiplier ×
 * periodKseqs / 10,000) — every figure reproducible from Log inputs
 * alone (§7.7's bar, extended to premiums). */
export function premiumDueRubars(args: {
  insuredLiabilitiesRubars: number;
  riskMultiplier: number;
  periodSeqs?: number;
}): number {
  const periodKseqs = (args.periodSeqs ?? PREMIUM_PERIOD_SEQS) / 1_000;
  if (args.insuredLiabilitiesRubars <= 0) return 0;
  return Math.ceil(
    (args.insuredLiabilitiesRubars *
      PREMIUM_BASE_BPS_PER_KSEQ *
      args.riskMultiplier *
      periodKseqs) /
      10_000
  );
}

// ---------------------------------------------------------------------------
// The delinquency ladder (V2-§1.3) — derived from the standing Log:
// premium marker entries (each ripened period's due figure) minus
// settlement entries. `current` → `delinquent` (one due period
// unsettled) → `suspended` (two consecutive periods unsettled).
// Suspension derives the suspension INTERVALS coverage reads: an
// interval opens at the ripening seq of the second consecutive
// unsettled period and closes at the cure (arrears paid in full).
// ---------------------------------------------------------------------------

export interface PremiumMarkerView {
  pendingId: string;
  seq: number;
  dueRubars: number;
  periodIndex: number;
}

export interface PremiumSettlementView {
  seq: number;
  settledPendingIds: string[];
}

export interface PremiumLadder {
  state: "current" | "delinquent" | "suspended";
  /** Ripened periods with due > 0 not yet settled, oldest first. */
  unsettled: PremiumMarkerView[];
  arrearsRubars: number;
  suspensionIntervals: SuspensionInterval[];
}

export function derivePremiumLadder(args: {
  markers: readonly PremiumMarkerView[];
  settlements: readonly PremiumSettlementView[];
}): PremiumLadder {
  const settledIds = new Set<string>();
  for (const settlement of args.settlements) {
    for (const id of settlement.settledPendingIds) settledIds.add(id);
  }
  const markers = args.markers.slice().sort((a, b) => a.seq - b.seq);
  const unsettled = markers.filter((m) => m.dueRubars > 0 && !settledIds.has(m.pendingId));
  const arrears = unsettled.reduce((sum, m) => sum + m.dueRubars, 0);

  // Suspension intervals: walk the bank's premium events in seq
  // order, tracking the set of due-and-unsettled periods standing
  // at each point (a marker adds its period; a settlement removes
  // the periods it paid). The interval opens at the marker whose
  // ripening made the set reach two, and closes at the settlement
  // that brought it back below two (the cure, V2-§1.3).
  const intervals: SuspensionInterval[] = [];
  const standing = new Set<string>();
  let openFrom: number | null = null;
  const events: (
    | { seq: number; kind: "marker"; marker: PremiumMarkerView }
    | { seq: number; kind: "settlement"; ids: string[] }
  )[] = [
    ...markers.map((m) => ({ seq: m.seq, kind: "marker" as const, marker: m })),
    ...args.settlements.map((s) => ({
      seq: s.seq,
      kind: "settlement" as const,
      ids: s.settledPendingIds,
    })),
  ].sort((a, b) => a.seq - b.seq);
  for (const event of events) {
    if (event.kind === "marker") {
      if (event.marker.dueRubars <= 0) continue; // a zero-due period owes nothing and cannot delinque
      standing.add(event.marker.pendingId);
      if (standing.size >= 2 && openFrom === null) openFrom = event.seq;
    } else {
      for (const id of event.ids) standing.delete(id);
      if (standing.size < 2 && openFrom !== null) {
        intervals.push({ fromSeq: openFrom, toSeq: event.seq });
        openFrom = null;
      }
    }
  }
  if (openFrom !== null) intervals.push({ fromSeq: openFrom, toSeq: null });

  const state: PremiumLadder["state"] =
    unsettled.length >= 2 ? "suspended" : unsettled.length === 1 ? "delinquent" : "current";
  return { state, unsettled, arrearsRubars: arrears, suspensionIntervals: intervals };
}

// ---------------------------------------------------------------------------
// Fund deficiency + B-14 supplemental assessments (V2-§1.6,
// BNK-D12). Deficiency derives after one full premium period of
// grace for a newborn fund; the target is TARGET_FUND_RATIO_BPS of
// realm insured liabilities.
// ---------------------------------------------------------------------------

export function fundRatioBps(fundCashRubars: number, insuredLiabilitiesRubars: number): number | null {
  if (insuredLiabilitiesRubars <= 0) return null;
  return Math.floor((fundCashRubars * 10_000) / insuredLiabilitiesRubars);
}

export function fundTargetBalanceRubars(insuredLiabilitiesRubars: number): number {
  return Math.floor((TARGET_FUND_RATIO_BPS * insuredLiabilitiesRubars) / 10_000);
}

export function fundDeficient(args: {
  fund: DepositInsuranceFundRecord;
  insuredLiabilitiesRubars: number;
  atSeq: number;
}): boolean {
  // One full premium period of grace: a newborn fund is not born
  // "deficient" (V2-§1.2).
  if (args.atSeq < args.fund.establishedAtSeq + PREMIUM_PERIOD_SEQS) return false;
  const ratio = fundRatioBps(args.fund.fundCashRubars, args.insuredLiabilitiesRubars);
  if (ratio === null) return false;
  return ratio < TARGET_FUND_RATIO_BPS;
}

/** supplementalDue(bank) = ceil(DEFICIT × insuredLiab(bank) /
 * Σ insuredLiab(surviving)) — pro-rata by insured liabilities
 * toward the target balance (V2-§1.6). */
export function supplementalAssessments(args: {
  fundCashRubars: number;
  insuredLiabilitiesRubars: number;
  survivingBanks: readonly { bankCorporationId: string; insuredLiabilitiesRubars: number }[];
}): Map<string, number> {
  const out = new Map<string, number>();
  const deficit = Math.max(
    0,
    fundTargetBalanceRubars(args.insuredLiabilitiesRubars) - args.fundCashRubars
  );
  const total = args.survivingBanks.reduce((sum, b) => sum + b.insuredLiabilitiesRubars, 0);
  for (const bank of args.survivingBanks) {
    if (deficit <= 0 || total <= 0 || bank.insuredLiabilitiesRubars <= 0) {
      out.set(bank.bankCorporationId, 0);
      continue;
    }
    out.set(
      bank.bankCorporationId,
      Math.ceil((deficit * bank.insuredLiabilitiesRubars) / total)
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// The senior queue (REC-7's recognized-unpaid state): unpaid covered
// shortfalls from EARLIER liquidations settle before any later
// failure's top-ups. The queue is derived from the deposit records'
// liquidation blocks, ordered by liquidation seq.
// ---------------------------------------------------------------------------

export interface QueuedShortfall {
  depositId: string;
  bankCorporationId: string;
  depositor: BankDepositRecord["depositor"];
  shortfallRubars: number;
  liquidatedAtSeq: number;
}

export function queuedShortfallsOf(
  deposits: readonly BankDepositRecord[]
): QueuedShortfall[] {
  const out: QueuedShortfall[] = [];
  for (const deposit of deposits) {
    const block = deposit.liquidation;
    if (!block || block.fundShortfallRubars <= 0) continue;
    out.push({
      depositId: deposit.depositId,
      bankCorporationId: block.bankCorporationId,
      depositor: deposit.depositor,
      shortfallRubars: block.fundShortfallRubars,
      liquidatedAtSeq: block.liquidatedAtSeq,
    });
  }
  return out.sort((a, b) => a.liquidatedAtSeq - b.liquidatedAtSeq);
}

// ---------------------------------------------------------------------------
// The verified fund sheet + the posture derivation (guardrail 5:
// the founding flips the derived posture through
// describeInsurancePosture with NO copy change).
// ---------------------------------------------------------------------------

export interface FundSheet {
  fundCashRubars: number;
  totalInsuredLiabilitiesRubars: number;
  fundRatioBps: number | null;
  deficient: boolean;
  queuedShortfallRubars: number;
  threeState: { contingentRubars: number; recognizedUnpaidRubars: number };
}

export function deriveFundSheet(args: {
  fund: DepositInsuranceFundRecord;
  insuredLiabilitiesRubars: number;
  deposits: readonly BankDepositRecord[];
  /** Bank owner ids by corporation, for the insider exclusion. */
  bankOwnerByCorporation: ReadonlyMap<string, string>;
  suspensionIntervalsByBank: ReadonlyMap<string, readonly SuspensionInterval[]>;
  atSeq: number;
}): FundSheet {
  const queued = queuedShortfallsOf(args.deposits).reduce(
    (sum, q) => sum + q.shortfallRubars,
    0
  );
  // Contingent coverage (memo exposure only, REC-7): Σ over
  // (bank, depositor) groups of covered-class active deposits of
  // min(combined claim basis, cap) — the fund's maximum exposure
  // if every insured bank failed at this seq.
  const groups = new Map<string, number>();
  for (const deposit of args.deposits) {
    if (deposit.status !== "active") continue;
    const owner = args.bankOwnerByCorporation.get(deposit.bankCorporationId);
    if (owner === undefined) continue;
    const covered = depositCoveredClass(deposit, {
      fund: args.fund,
      suspensionIntervals: args.suspensionIntervalsByBank.get(deposit.bankCorporationId) ?? [],
      bankOwnerMemberId: owner,
    });
    if (!covered) continue;
    const d = deposit.depositor;
    const key = `${deposit.bankCorporationId}|${d.kind}|${d.kind === "personal" ? d.memberId : d.kind === "company" ? d.corporationId : d.cityId}`;
    groups.set(key, (groups.get(key) ?? 0) + deposit.principalRubars + deposit.creditedInterestRubars);
  }
  let contingent = 0;
  for (const groupTotal of groups.values()) {
    contingent += Math.min(groupTotal, COVERAGE_CAP_RUBARS);
  }
  return {
    fundCashRubars: args.fund.fundCashRubars,
    totalInsuredLiabilitiesRubars: args.insuredLiabilitiesRubars,
    fundRatioBps: fundRatioBps(args.fund.fundCashRubars, args.insuredLiabilitiesRubars),
    deficient: fundDeficient({
      fund: args.fund,
      insuredLiabilitiesRubars: args.insuredLiabilitiesRubars,
      atSeq: args.atSeq,
    }),
    queuedShortfallRubars: queued,
    threeState: {
      contingentRubars: contingent,
      recognizedUnpaidRubars: queued,
    },
  };
}

/** The InsurancePosture for a bank, derived from the fund record +
 * the bank's coverage facts (./banking.ts posture seam). */
export function insurancePostureFromFund(args: {
  fund: DepositInsuranceFundRecord | null;
  bankEligible: boolean | null;
}): InsurancePosture {
  if (!args.fund) {
    return {
      institutionExists: false,
      coverageCapRubars: null,
      insiderExcluded: null,
      bankEligible: null,
    };
  }
  return {
    institutionExists: true,
    coverageCapRubars: COVERAGE_CAP_RUBARS,
    insiderExcluded: true,
    bankEligible: args.bankEligible,
  };
}
