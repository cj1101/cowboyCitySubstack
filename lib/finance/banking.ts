/**
 * Banking — the Phase 4 slice (banking-amendment-design.md §7.1, as
 * conformed by Banking Rider 1 / Addendum v2): B-01 charter + surrender,
 * B-02 deposits, B-03 withdrawals, B-04 cash-paid interest settlement.
 * Phase 5 (PR-6) activates the reserved half: loans (./loans.ts), the
 * full REC-6 balance-sheet identity below, the failed-payment
 * derivation, credit creation, and the DIF (./insurance.ts) — record
 * shapes extend additively, so no Phase 4 record migrates.
 *
 * The five must-not-hardcode guardrails, as they bind this module:
 *  1. No no-creation invariant is asserted anywhere: conservation is
 *     the paired-posting identity + the two money bridges
 *     (./conservation.ts); this module's arithmetic (unencumbered,
 *     lendableCredit) prices BOTH origination surfaces — cash spends
 *     and the Phase 5 credit surface — without presuming either away.
 *  2. Deposit records are additively extensible: `origin` classifies
 *     how a claim came to exist, creation is a committer plan effect
 *     (a record write inside a Resolution Event), and the credit branch
 *     (Phase 5 B-06) will write `origin: "credit-created"` records with
 *     `fundingLoanId` through the same builder family — no Phase 4
 *     code path treats "cash" as the only lawful provenance.
 *  3. No undifferentiated tier-(c) distribution helper exists here or
 *     is implied: payouts are per-rule (B-03/B-04 custodial lines), and
 *     the Phase 5 waterfall (B-10) is a rule of its own, not a helper
 *     this slice pre-builds.
 *  4. Tracked-cash figures are labeled as tracked wherever this module
 *     names them (see accounts.ts) — a bank's cash is its tracked
 *     settlement cash; the module never calls it "the money supply".
 *  5. Charter/insurance posture copy is GENERATED from derived state
 *     (describeInsurancePosture below reads a posture object derived
 *     from records) — never a hardcoded sentence about whether
 *     insurance or credit creation "exists" as a system truth.
 */

import {
  docField,
  snapshotDoc,
  type PendingDraft,
  type SimActor,
  type SimSnapshot,
} from "../sim/state";
import type { LedgerRef } from "./accounts";

// ---------------------------------------------------------------------------
// Published rule constants (BNK-D1 / BNK-D2 — Town Hall-amendable rule
// numbers, never engine-hidden).
// ---------------------------------------------------------------------------

/** B-01 validation: minimum company cash to charter (BNK-D1). */
export const CHARTER_MIN_CAPITAL_RUBARS = 100_000;
/** Reserve floor: 20% of deposit liabilities must stay liquid (BNK-D2). */
export const RESERVE_FLOOR_BPS = 2_000;
/** Hard cap on deposit and loan rates, bps per kseq (BNK-D2). */
export const RATE_CAP_BPS_PER_KSEQ = 5_000;
/** Insider lending cap: aggregate insider outstanding may not exceed
 * this share of the bank's net worth at funding (BNK-D3, §3.3). */
export const INSIDER_CAP_BPS = 2_500;
/** Credit-creation capital test: post-funding derived equity must be
 * at least this share of TOTAL RECOGNIZED ASSETS (BNK-D13 as amended
 * by REC-1 — Vera's base, Felix's constant). */
export const EQUITY_FLOOR_BPS = 1_000;
/** DIF coverage cap per depositor per bank (BNK-D10). */
export const COVERAGE_CAP_RUBARS = 250_000;
/** DIF premium base rate (BNK-D11). */
export const PREMIUM_BASE_BPS_PER_KSEQ = 10;
/** DIF premium period, in resolved seqs (BNK-D11). */
export const PREMIUM_PERIOD_SEQS = 1_000;
/** DIF target fund ratio against realm insured liabilities (BNK-D12). */
export const TARGET_FUND_RATIO_BPS = 500;
/** Controller bar length after a liquidation, in resolved seqs
 * (BNK-D15 — owner only, as built). */
export const RECHARTER_BAR_SEQS = 2_000;

// ---------------------------------------------------------------------------
// The charter block (amendment §1.3) — written on the corporation record
// by B-01; validation for every B-rule reads this block, never the
// company's industry/profile text.
// ---------------------------------------------------------------------------

export interface BankCharterBlock {
  charteredAtSeq: number;
  charterEntryId: string;
  status: "active" | "surrendered";
  /** Self-imposed reserve ratio; >= RESERVE_FLOOR_BPS. */
  reserveRatioBps: number;
  depositRateCeilingBpsPerKseq: number;
  loanRateCeilingBpsPerKseq: number;
  /** Committer-maintained aggregate; verifier-asserted (A-B1). */
  depositLiabilitiesRubars: number;
  /** Committer-maintained aggregate of outstanding loan principal
   * (A-B2). Always 0 in the Phase 4 slice — no loan handlers exist. */
  loanBookRubars: number;
  /** Committer-maintained insider-loan aggregate (A-B3). */
  insiderLoansRubars: number;
  /** Committer-maintained aggregate (Phase 5, B-08): the recorded
   * satisfaction value of seized collateral currently held for the
   * bank — REC-6's "other recognized assets" term, sourced by the
   * seizure records and asserted against them (A-B7). Additive:
   * absent on Phase 4-era blocks, reads as 0 (seizedAssetsOf). */
  seizedAssetsRubars?: number;
}

/** The charter block's seized-assets aggregate, canonical-absent = 0. */
export function seizedAssetsOf(block: BankCharterBlock | null): number {
  const value = block?.seizedAssetsRubars;
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

export function bankBlockOf(
  corporationDoc: Record<string, unknown> | null
): BankCharterBlock | null {
  if (!corporationDoc) return null;
  const bank = docField(corporationDoc, "bank");
  if (typeof bank !== "object" || bank === null) return null;
  const block = bank as Record<string, unknown>;
  if (block.status !== "active" && block.status !== "surrendered") return null;
  return block as unknown as BankCharterBlock;
}

export function buildBankCharterBlock(args: {
  charteredAtSeq: number;
  charterEntryId: string;
  reserveRatioBps: number;
  depositRateCeilingBpsPerKseq: number;
  loanRateCeilingBpsPerKseq: number;
  /** Carried across a re-charter after surrender (must be 0/0/0 —
   * surrender is only valid at zero live claims, §1.4). */
  existing?: BankCharterBlock | null;
}): BankCharterBlock {
  return {
    charteredAtSeq: args.charteredAtSeq,
    charterEntryId: args.charterEntryId,
    status: "active",
    reserveRatioBps: args.reserveRatioBps,
    depositRateCeilingBpsPerKseq: args.depositRateCeilingBpsPerKseq,
    loanRateCeilingBpsPerKseq: args.loanRateCeilingBpsPerKseq,
    depositLiabilitiesRubars: args.existing?.depositLiabilitiesRubars ?? 0,
    loanBookRubars: args.existing?.loanBookRubars ?? 0,
    insiderLoansRubars: args.existing?.insiderLoansRubars ?? 0,
    seizedAssetsRubars: seizedAssetsOf(args.existing ?? null),
  };
}

// ---------------------------------------------------------------------------
// The deposit record (amendment §2.2) — a claim, recorded. Custody is
// not ownership: the cash is the bank's company cash; what the
// depositor owns is this claim.
// ---------------------------------------------------------------------------

/** Provenance classes (§2.1 as conformed): how the claim came to
 * exist. Phase 4's B-02 writes "cash" only; the remaining classes are
 * named now so no consumer treats provenance as decoration — an
 * unexplained provenance is a verifier failure (V-B0/V-B5), and the
 * conservation checker's claim bridge classifies by exactly this
 * field. Absent `origin` on a legacy record reads as "cash" (V2-§4.1
 * item 2) — see depositOrigin(). */
export type DepositOrigin =
  | "cash"
  | "credit-created"
  | "insurance-paid"
  | "transfer-reissued";

export interface BankDepositRecord {
  depositId: string;
  bankCorporationId: string;
  bankCityId: string;
  depositor: LedgerRef; // personal | company | treasury — never market/exterior
  principalRubars: number;
  /** Interest capitalized into the claim (B-04 credited branch, Phase
   * 5) — 0 throughout the Phase 4 slice. */
  creditedInterestRubars: number;
  rateBpsPerKseq: number;
  status: "active" | "closed" | "assigned";
  origin: DepositOrigin;
  /** The originating loan for a credit-created deposit (Phase 5 B-06);
   * null for every Phase 4 record. A-B4: a credit-created deposit
   * whose fundingLoanId names no same-bank loan is a verifier
   * failure in ANY phase. */
  fundingLoanId: string | null;
  openedAtSeq: number;
  openingEntryId: string;
  lastSettledSeq: number;
  /** Phase 5: created-claim principal extinguished by a pool
   * closing's realized-loss write-down (Appendix C's A-B5
   * bookkeeping). Absent ≡ 0; only ever stamped at pool closing. */
  writtenDownRubars?: number;
  /** Phase 5 (B-10): the liquidation block, stamped when the record
   * sweeps into a depositor pool (status "assigned"). The frozen
   * claim figure (REC-5) and everything the pool derivation needs
   * live here so the pool stays a derivation over records + Log —
   * no pool account doc exists (§5.6). Absent until liquidation. */
  liquidation?: {
    liquidationId: string;
    bankCorporationId: string;
    frozenClaimRubars: number;
    coveredRubars: number;
    uninsuredRubars: number;
    /** Setoff applied at liquidation (BNK-D16): the portion of the
     * claim netted against the depositor's debt to the pool. */
    setoffRubars: number;
    estatePaidRubars: number;
    fundPaidRubars: number;
    /** Unpaid covered balance queued against the fund (REC-7's
     * recognized-unpaid state), senior to later failures' payouts. */
    fundShortfallRubars: number;
    /** Σ pool distributions received on this record so far (cash
     * from assigned-loan repayments and pool seizures). */
    poolDistributedRubars: number;
    /** The fund's subrogated share of pool distributions received
     * (routed to the fund first, up to fundPaidRubars, V2-§1.5). */
    fundRecoveredRubars: number;
    liquidatedAtSeq: number;
  } | null;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: unknown; // committer-stamped
  updatedAt: unknown;
}

export function depositOrigin(record: Record<string, unknown>): DepositOrigin {
  const origin = record.origin;
  return origin === "credit-created" ||
    origin === "insurance-paid" ||
    origin === "transfer-reissued"
    ? origin
    : "cash";
}

export function buildBankDepositDoc(args: {
  depositId: string;
  bankCorporationId: string;
  bankCityId: string;
  depositor: LedgerRef;
  principalRubars: number;
  rateBpsPerKseq: number;
  openedAtSeq: number;
  openingEntryId: string;
  /** Provenance (guardrail 2): B-02 writes "cash" (the default);
   * B-06's credit branch writes "credit-created" through THIS SAME
   * builder with `fundingLoanId` naming the loan — creation is a
   * committer plan effect, never a second deposit-writing path. */
  origin?: DepositOrigin;
  fundingLoanId?: string | null;
}): Record<string, unknown> {
  const record: BankDepositRecord = {
    depositId: args.depositId,
    bankCorporationId: args.bankCorporationId,
    bankCityId: args.bankCityId,
    depositor: args.depositor,
    principalRubars: args.principalRubars,
    creditedInterestRubars: 0,
    rateBpsPerKseq: args.rateBpsPerKseq,
    status: "active",
    origin: args.origin ?? "cash",
    fundingLoanId: args.fundingLoanId ?? null,
    openedAtSeq: args.openedAtSeq,
    openingEntryId: args.openingEntryId,
    lastSettledSeq: args.openedAtSeq,
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdAt: null,
    updatedAt: null,
  };
  return { ...record };
}

/** A deposit's claim value is DERIVED, never stored (§2.2):
 * principal + credited interest + accrued-unsettled at `atSeq`. */
export function depositClaimRubars(
  record: Pick<BankDepositRecord, "principalRubars" | "creditedInterestRubars">,
  accruedUnsettledRubars: number
): number {
  return record.principalRubars + record.creditedInterestRubars + accruedUnsettledRubars;
}

// ---------------------------------------------------------------------------
// The loan record — RESERVED SHAPE ONLY (amendment §3.1 as conformed).
// No Phase 4 handler creates, reads for validation, or mutates a loan;
// the type is documented here so the conservation checker's A-B2/A-B3
// assertions and Phase 5's B-05/B-06 build against the standing shape.
// ---------------------------------------------------------------------------

export interface BankLoanRecordReserved {
  bankCorporationId: string;
  borrower: LedgerRef; // personal | company | treasury
  principalRubars: number;
  outstandingRubars: number;
  fundingMode: "cash-funded" | "credit-created";
  insider: boolean;
  status: "offered" | "active" | "repaid" | "written-off" | "assigned";
}

// ---------------------------------------------------------------------------
// Reserve / spendable surfaces (amendment §2.5) — defined once, used by
// the transfer primitive's bank branch and by B-03/B-04 validation.
// ---------------------------------------------------------------------------

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

export function bankCashRubars(corporationDoc: Record<string, unknown> | null): number {
  return integerOrZero(docField(corporationDoc, "companyCashRubars"));
}

/** ceil(max(chartered ratio, floor) × liabilities / 10000). */
export function liquidReserveRubars(corporationDoc: Record<string, unknown> | null): number {
  const bank = bankBlockOf(corporationDoc);
  if (!bank) return 0;
  const ratio = Math.max(bank.reserveRatioBps, RESERVE_FLOOR_BPS);
  return Math.ceil((ratio * bank.depositLiabilitiesRubars) / 10_000);
}

/** cash − deposit liabilities − liquid reserve. May be negative on
 * paper for an already-impaired bank; the floor at use sites is the
 * validation itself (a spend validates only if it fits). */
export function unencumberedCash(corporationDoc: Record<string, unknown> | null): number {
  const bank = bankBlockOf(corporationDoc);
  if (!bank) return bankCashRubars(corporationDoc);
  return (
    bankCashRubars(corporationDoc) -
    bank.depositLiabilitiesRubars -
    liquidReserveRubars(corporationDoc)
  );
}

/** The cash-spend / cash-funded-lending origination surface (§2.5):
 * cash above the liquid reserve. */
export function lendableCash(corporationDoc: Record<string, unknown> | null): number {
  return bankCashRubars(corporationDoc) - liquidReserveRubars(corporationDoc);
}

/** The credit-issuance surface (§2.5 as conformed by RIDER-6/REC-1) —
 * defined now so Phase 5 validates creation against the published
 * formula rather than inventing one; no Phase 4 handler calls it. A
 * bank may never count a deposit it is creating as its own settlement
 * cash, reserve cash, or capital (RIDER-5) — this formula reads only
 * standing cash and standing liabilities. */
export function lendableCredit(corporationDoc: Record<string, unknown> | null): number {
  const bank = bankBlockOf(corporationDoc);
  if (!bank) return 0;
  const ratio = Math.max(bank.reserveRatioBps, RESERVE_FLOOR_BPS);
  if (ratio <= 0) return 0;
  return Math.max(
    0,
    Math.floor((bankCashRubars(corporationDoc) * 10_000) / ratio) - bank.depositLiabilitiesRubars
  );
}

// ---------------------------------------------------------------------------
// Interest — the one formula (amendment §4.1). Seq-based, never
// wall-clock: a quiet world accrues nothing, because nothing happens
// in it (CJ's causality ruling expressed as arithmetic).
//   interest = floor(base × rateBpsPerKseq × Δseq / (10,000 × 1,000))
// Base for a deposit: principal + credited interest (§2.6). Rounding is
// floor; the discarded fraction is never routed anywhere — it is a
// part of a Rubar that was never owed (§4.1).
// ---------------------------------------------------------------------------

export function interestForPeriod(args: {
  baseRubars: number;
  rateBpsPerKseq: number;
  fromSeq: number;
  toSeq: number;
}): number {
  const deltaSeq = Math.max(0, args.toSeq - args.fromSeq);
  if (args.baseRubars <= 0 || args.rateBpsPerKseq <= 0 || deltaSeq === 0) return 0;
  return Math.floor(
    (args.baseRubars * args.rateBpsPerKseq * deltaSeq) / (10_000 * 1_000)
  );
}

/** Accrued-unsettled interest on a deposit record at `atSeq` — the
 * derived third term of the claim (§2.2). */
export function accruedUnsettledRubars(
  record: Pick<
    BankDepositRecord,
    "principalRubars" | "creditedInterestRubars" | "rateBpsPerKseq" | "lastSettledSeq"
  >,
  atSeq: number
): number {
  return interestForPeriod({
    baseRubars: record.principalRubars + record.creditedInterestRubars,
    rateBpsPerKseq: record.rateBpsPerKseq,
    fromSeq: record.lastSettledSeq,
    toSeq: atSeq,
  });
}

// ---------------------------------------------------------------------------
// Derived bank health (amendment §5.1) — computed from standing state,
// never stored. Phase 5 form (addendum item 2): the REC-6 full
// balance-sheet identity replaces the Phase 4 slice form — one
// identity, no divergent copies (Appendix A as replaced): validation,
// display, and the verifier read THIS derivation.
//   Assets      = settlement cash + outstanding loan principal
//               + other recognized assets (seized collateral at its
//                 recorded satisfaction value — B-08's records)
//               + recognized insurance receivables (post-recognition
//                 ONLY, REC-7 — contingent coverage is memo exposure,
//                 never an asset before the claim-recognition point)
//   Liabilities = deposit claims + tax payables + adjudicated
//                 payables (R-23 records are Phase 7; the term is
//                 wired and reads the corp-doc field, zero until
//                 cases exist) + other recognized liabilities
//   Equity      = Assets − Liabilities (derived; may be negative as
//                 a solvency fact; never stored or spendable)
// Terms a corp doc cannot carry (a premium payable derived from the
// premium chain, a recognized insurance receivable) enter through
// `extras` from the caller that derives them — the corp-doc-only
// call below passes none, which is exactly the Phase 4 call sites'
// behavior upgraded to the full identity over doc-carried terms.
// ---------------------------------------------------------------------------

export interface BankBalanceSheet {
  cashRubars: number;
  loanBookRubars: number;
  seizedAssetsRubars: number;
  recognizedInsuranceReceivablesRubars: number;
  totalAssetsRubars: number;
  depositLiabilitiesRubars: number;
  taxPayablesRubars: number;
  adjudicatedPayablesRubars: number;
  otherLiabilitiesRubars: number;
  totalLiabilitiesRubars: number;
  /** Derived equity (REC-6/RIDER-4): may be negative. */
  netWorthRubars: number;
  liquidReserveRubars: number;
}

export function bankBalanceSheet(
  corporationDoc: Record<string, unknown> | null,
  extras?: {
    recognizedInsuranceReceivablesRubars?: number;
    otherLiabilitiesRubars?: number;
  }
): BankBalanceSheet | null {
  const bank = bankBlockOf(corporationDoc);
  if (!bank || !corporationDoc) return null;
  const cash = bankCashRubars(corporationDoc);
  const payables = docField(corporationDoc, "taxPayables");
  const taxPayablesTotal =
    typeof payables === "object" && payables !== null
      ? Object.values(payables as Record<string, unknown>).reduce<number>(
          (sum, v) => sum + integerOrZero(v),
          0
        )
      : 0;
  const adjudicated = integerOrZero(docField(corporationDoc, "adjudicatedPayablesRubars"));
  const seized = seizedAssetsOf(bank);
  const insuranceReceivables = extras?.recognizedInsuranceReceivablesRubars ?? 0;
  const otherLiabilities = extras?.otherLiabilitiesRubars ?? 0;
  const totalAssets = cash + bank.loanBookRubars + seized + insuranceReceivables;
  const totalLiabilities =
    bank.depositLiabilitiesRubars + taxPayablesTotal + adjudicated + otherLiabilities;
  return {
    cashRubars: cash,
    loanBookRubars: bank.loanBookRubars,
    seizedAssetsRubars: seized,
    recognizedInsuranceReceivablesRubars: insuranceReceivables,
    totalAssetsRubars: totalAssets,
    depositLiabilitiesRubars: bank.depositLiabilitiesRubars,
    taxPayablesRubars: taxPayablesTotal,
    adjudicatedPayablesRubars: adjudicated,
    otherLiabilitiesRubars: otherLiabilities,
    totalLiabilitiesRubars: totalLiabilities,
    netWorthRubars: totalAssets - totalLiabilities,
    liquidReserveRubars: liquidReserveRubars(corporationDoc),
  };
}

export type BankHealth = "sound" | "liquidity-impaired" | "insolvent";

/** The arithmetic three-state derivation (§5.1): insolvent ⇔ net
 * worth < 0 under the REC-6 identity; liquidity-impaired ⇔ solvent
 * but cash below the liquid reserve. The FAILED-PAYMENT form of
 * failure is a separate Log-reading derivation (deriveFailedPayment
 * below) — §5.1's full "failed" state is insolvent OR failed-payment,
 * composed by the consumers that can read a Log slice (the standing
 * verifier's venue, finance prep §6); handler gates read this
 * arithmetic form, exactly as Phase 4's call sites did, now over the
 * full identity with no code change at those sites. */
export function deriveBankHealth(
  corporationDoc: Record<string, unknown> | null
): BankHealth | null {
  const bank = bankBlockOf(corporationDoc);
  if (!bank || bank.status !== "active") return null;
  const sheet = bankBalanceSheet(corporationDoc);
  if (!sheet) return null;
  if (sheet.netWorthRubars < 0) return "insolvent";
  if (sheet.cashRubars < sheet.liquidReserveRubars) return "liquidity-impaired";
  return "sound";
}

// ---------------------------------------------------------------------------
// The failed-payment derivation (§5.1's second form of failure) — a
// pure function over a bank's Log slice. A bank that has actually
// bounced a depositor is failed in fact whatever its paper net worth
// says; the derivation reads the Log because the Log is where the
// fact lives. Input contract: the caller projects standing entries
// into the view below — rejections are identified by (ruleIds ∋
// B-03|B-04, rejectionCode "insufficient-unencumbered") with the bank
// taken from the rejected ACTION's record (the resolver's rejection
// conversion carries no bank field; the action doc names the deposit,
// whose record names the bank — the projection is mechanical, and
// this module's venue is the standing verifier / QA harness per
// finance prep §6, deliberately NOT an approximation from state in
// the handler layer).
// ---------------------------------------------------------------------------

export interface BankLogEventView {
  seq: number;
  kind: string;
  ruleIds: string[];
  rejectionCode: string | null;
  bankCorporationId: string | null;
  /** B-09 entries stamp their cure determination here (the event's
   * own validation recomputed the derivation, §5.4): true only when
   * the injection cured the arithmetic state AND every
   * failure-deriving custodial claim became coverable. */
  curesFailedPayment?: boolean | null;
}

export interface FailedPaymentDerivation {
  failed: boolean;
  /** Seq of the earliest uncured custodial rejection, when failed. */
  firstUncuredRejectionSeq: number | null;
  /** Seq of the B-09 entry that cured the episode, when cured. */
  curedAtSeq: number | null;
  uncuredRejectionSeqs: number[];
}

export function deriveFailedPayment(
  events: readonly BankLogEventView[],
  bankCorporationId: string
): FailedPaymentDerivation {
  const mine = events
    .filter((e) => e.bankCorporationId === bankCorporationId)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  let curedAtSeq: number | null = null;
  const uncured: number[] = [];
  for (const event of mine) {
    const isRejection =
      event.kind === "rejected" &&
      event.rejectionCode === "insufficient-unencumbered" &&
      (event.ruleIds.includes("B-03") || event.ruleIds.includes("B-04"));
    if (isRejection) {
      uncured.push(event.seq);
      continue;
    }
    const isCure =
      event.ruleIds.includes("B-09") && event.curesFailedPayment === true;
    if (isCure) {
      // A cure answers every rejection standing before it (§5.4's
      // coverability condition is evaluated against those claims).
      for (const seq of uncured.splice(0)) {
        void seq;
      }
      curedAtSeq = event.seq;
    }
  }
  return {
    failed: uncured.length > 0,
    firstUncuredRejectionSeq: uncured.length > 0 ? uncured[0] : null,
    curedAtSeq,
    uncuredRejectionSeqs: uncured,
  };
}

// ---------------------------------------------------------------------------
// Insurance posture — DERIVED state and copy generated from it
// (guardrail 5; amendment §7.6 as conformed). The DIF is a Phase 5/7
// institution: whether it exists, its coverage cap, and a bank's
// eligibility are facts read off records at the consuming site. This
// slice ships the derivation seam with the honest Phase 4 input — no
// DIF institution record exists yet, so the derivation receives
// `institution: null` from callers until the fund's founding act lands
// — and the copy builder renders whatever posture it is GIVEN. No
// sentence here is a hardcoded system truth: change the derived
// posture and the copy changes with it.
// ---------------------------------------------------------------------------

export interface InsurancePosture {
  /** A deposit-insurance institution record stands (Phase 5/7 DIF). */
  institutionExists: boolean;
  /** Per-depositor coverage cap in Rubars, when the institution
   * publishes one; null when none stands. */
  coverageCapRubars: number | null;
  /** Insider deposits are excluded from coverage (V2-§1.4 posture,
   * read from the institution's terms when it exists). */
  insiderExcluded: boolean | null;
  /** This bank's own eligibility state, derived per bank. */
  bankEligible: boolean | null;
}

export const NO_INSTITUTION_POSTURE: InsurancePosture = {
  institutionExists: false,
  coverageCapRubars: null,
  insiderExcluded: null,
  bankEligible: null,
};

/** Charter-flow posture lines (§7.6), generated from derived state.
 * Surfaces call this with the posture they derived at preview; the
 * text is a rendering of that state, not a claim about the world. */
// ---------------------------------------------------------------------------
// Schedule pendings (amendment §3.4 + V2-§1.3) — banking's due
// occasions ride AGR pendings whose ripen condition is CONTRACTUAL,
// not delay-derived: installment k is due at originatedAtSeq +
// k × dueIntervalSeqs, and a premium period is due exactly
// PREMIUM_PERIOD_SEQS after its anchor. buildPendingDraft cannot
// express either (its requiredSeq derives from the delay formula
// over the target city's traits), so this builder mirrors its doc
// shape field-for-field — the acquisition family's precedent for a
// family-held draft shape — and sets the ripen condition's
// minSeqAdvance EXACTLY: the committer stamps requiredSeq =
// creation summary seq + minSeqAdvance (P4-K19 anchoring), which is
// the contractual due seq by construction. The wall floor is 0:
// these pendings are seq-scheduled, and the seq gate alone governs
// (eligibleAt = the creation instant). The payloadSpec is the
// family's own (schedule data + Vera's `occasion` spec, GAP-1); the
// ripening application is the family's composition
// (buildScheduleRipeningPlan in rules/finance.ts), dispatched on
// the kinds' declared effectPath "schedule".
// ---------------------------------------------------------------------------

export interface SchedulePendingArgs {
  pendingId: string;
  kind: "loan-installment-due" | "insurance-premium-due";
  originResolutionId: string;
  originActionId: string | null;
  originActor: SimActor;
  originCityId: string | null;
  originSummaryText: string;
  targetCityId: string;
  sourceKind: "action" | "ripening";
  generation: number;
  chainId: string;
  chainRootPendingId: string | null;
  createdByResolutionId: string | null;
  /** The exact seq advance to the contractual due seq. For
   * generation-1 schedule pendings created inside the origin event
   * this is (dueSeq − originEventSummarySeq); the successor
   * mechanics in the ripening composition anchor it to the ripened
   * pending's requiredSeq (SPEC-1 as confirmed by Vera). */
  minSeqAdvance: number;
  /** Recorded on the doc as the derivation of record (in place of a
   * delay derivation): the schedule arithmetic that produced
   * minSeqAdvance, so the due seq is recomputable from the record. */
  scheduleDerivation: Record<string, unknown>;
  payloadSpec: Record<string, unknown>;
  extraAudienceUids?: string[];
}

export function buildSchedulePendingDraft(
  snapshot: SimSnapshot,
  args: SchedulePendingArgs
): { draft: PendingDraft } {
  const audience = new Set<string>(args.extraAudienceUids ?? []);
  const actorUid = args.originActor.memberId ?? args.originActor.onBehalfOfMemberId;
  if (actorUid) audience.add(actorUid);
  for (const cityId of [args.originCityId, args.targetCityId]) {
    if (!cityId) continue;
    const faction = snapshotDoc(snapshot, `factions/${cityId}`);
    const owners = faction?.ownerUids;
    if (Array.isArray(owners)) {
      for (const uid of owners) if (typeof uid === "string") audience.add(uid);
    }
  }
  const targetCity = snapshotDoc(snapshot, `sim_cities/${args.targetCityId}`);
  const doc: Record<string, unknown> = {
    pendingId: args.pendingId,
    schemaVersion: 2,
    kind: args.kind,
    status: "pending",
    originResolutionId: args.originResolutionId,
    originActionId: args.originActionId,
    originActor: args.originActor,
    originCityId: args.originCityId,
    originSummaryText: args.originSummaryText,
    targetCityId: args.targetCityId,
    sourceKind: args.sourceKind,
    generation: args.generation,
    chainId: args.chainId,
    chainRootPendingId: args.chainRootPendingId,
    createdByResolutionId: args.createdByResolutionId,
    createdBySeq: null, // committer
    createdAtSeq: null, // committer
    createdAt: null, // committer
    originSeq: null, // committer (== createdAtSeq for generation-1)
    ripenCondition: {
      scope: "realm",
      minSeqAdvance: args.minSeqAdvance,
      requiredSeq: null, // committer: creation summary seq + minSeqAdvance
      minWallElapsedHours: 0,
      eligibleAt: null, // committer: creation instant + 0 (seq gate governs)
      requiresActionInCities: [],
      preconditions: [],
    },
    delayDerivation: { basis: "contractual-schedule", ...args.scheduleDerivation },
    payloadSpec: args.payloadSpec,
    creationSnapshot: {
      targetStats: (targetCity?.stats as Record<string, unknown> | undefined) ?? null,
      ruleInputs: { kind: args.kind, targetCityId: args.targetCityId },
    },
    audienceUids: [...audience].sort(),
    claim: null,
    attempts: 0,
    needsAttention: false,
    referencedByRefKeys: [],
    stateVersion: 1,
    ripenedAtSeq: null,
    ripenedAt: null,
    ripensInResolutionId: null,
    voidedAtSeq: null,
    voidReason: null,
    outcomeSummary: null,
    updatedAt: null, // committer
  };
  return { draft: { doc } };
}

export function describeInsurancePosture(posture: InsurancePosture): string[] {
  const lines: string[] = [];
  if (!posture.institutionExists) {
    lines.push(
      "Derived insurance posture at this preview: no deposit-insurance institution record stands, so deposits carry no insurance coverage in the current state of the world."
    );
    return lines;
  }
  lines.push(
    "Derived insurance posture at this preview: a deposit-insurance institution stands."
  );
  if (posture.coverageCapRubars !== null) {
    lines.push(
      `Its published coverage cap is ${posture.coverageCapRubars} R per depositor.`
    );
  }
  if (posture.insiderExcluded === true) {
    lines.push("Its published terms exclude insider deposits from coverage.");
  }
  if (posture.insiderExcluded === false) {
    lines.push("Its published terms do not exclude insider deposits from coverage.");
  }
  if (posture.bankEligible === true) {
    lines.push("This bank's derived eligibility state is: eligible.");
  }
  if (posture.bankEligible === false) {
    lines.push("This bank's derived eligibility state is: not eligible.");
  }
  return lines;
}
