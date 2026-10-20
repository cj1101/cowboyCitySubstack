/**
 * Banking — the Phase 4 slice (banking-amendment-design.md §7.1, as
 * conformed by Banking Rider 1 / Addendum v2): B-01 charter + surrender,
 * B-02 deposits, B-03 withdrawals, B-04 cash-paid interest settlement.
 * Loans, credit creation, the DIF, and the failure waterfall are Phase
 * 5/7 — their record shapes are RESERVED here (types only, no handlers)
 * so Phase 5 extends live data instead of migrating it.
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

import { docField } from "../sim/state";
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
    origin: "cash",
    fundingLoanId: null,
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
// never stored. Phase 4 slice form: the loan book is empty by
// construction, so net worth reads cash + loanBook(0) − deposit
// liabilities − tax payables. The failed-payment form of failure (a
// standing custodial rejection in the Log) is a Log-reading derivation
// the standing verifier owns; it is unreachable-by-construction in
// this slice (§7.1) and is NOT approximated here from state.
// ---------------------------------------------------------------------------

export type BankHealth = "sound" | "liquidity-impaired" | "insolvent";

export function deriveBankHealth(
  corporationDoc: Record<string, unknown> | null
): BankHealth | null {
  const bank = bankBlockOf(corporationDoc);
  if (!bank || bank.status !== "active") return null;
  const cash = bankCashRubars(corporationDoc);
  const payables = docField(corporationDoc, "taxPayables");
  const payablesTotal =
    typeof payables === "object" && payables !== null
      ? Object.values(payables as Record<string, unknown>).reduce<number>(
          (sum, v) => sum + integerOrZero(v),
          0
        )
      : 0;
  const netWorth =
    cash + bank.loanBookRubars - bank.depositLiabilitiesRubars - payablesTotal;
  if (netWorth < 0) return "insolvent";
  if (cash < liquidReserveRubars(corporationDoc)) return "liquidity-impaired";
  return "sound";
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
