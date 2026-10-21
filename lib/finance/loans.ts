/**
 * Loans — the Phase 5 activation of the reserved shape (banking
 * amendment §3, as conformed by Banking Rider 1 / Addendum v2).
 * Pure derivations and record builders only; handlers live in
 * lib/sim/rules/finance.ts (B-05..B-11), and the conservation checker
 * (./conservation.ts) asserts the aggregates these records feed.
 *
 * The disciplines this module encodes:
 *  - Overdue and default are DERIVED, never stored (§3.7): pure
 *    functions of the loan record + the standing seq, computed
 *    identically at preview, at read, and in validation.
 *  - Interest is the one formula (§4.1, ./banking.ts
 *    interestForPeriod) over outstanding principal from the
 *    record's watermark; a stated default rate replaces the rate
 *    only for the post-due portion of a span (§3.7). Loan interest
 *    NEVER capitalizes into principal (M14): unsettled interest is
 *    a computed figure until a settlement event makes it a transfer.
 *  - Repayment allocation is fixed (§3.5): unsettled interest
 *    first, then principal, oldest installment first. Netting
 *    (V2-§2.3) applies against the principal portion only, and only
 *    against the loan's own created deposit.
 *  - The waterfall and pool distributions are integer pro-rata
 *    with floors; remainders are DUST that stays in the dissolved
 *    bank's frozen cash record (§5.6) — never redistributed by
 *    rounding, never deleted.
 */

import { interestForPeriod, type BankDepositRecord } from "./banking";
import type { LedgerRef } from "./accounts";

// ---------------------------------------------------------------------------
// The loan record (§3.1 as conformed) — live shape. The Phase 4
// reservation (BankLoanRecordReserved in ./banking.ts) is the subset
// Phase 4's checker read; this is the full record B-05 creates and
// B-06 activates.
// ---------------------------------------------------------------------------

export type LoanCollateral =
  | { kind: "none" }
  | { kind: "shares"; corporationId: string; cityId: string; quantityShares: number }
  | { kind: "structure"; structureId: string; cityId: string };

export interface BankLoanRecord {
  loanId: string;
  bankCorporationId: string;
  bankCityId: string;
  borrower: LedgerRef; // personal | company | treasury — never market/exterior
  principalRubars: number;
  outstandingRubars: number;
  /** The offer's stated branch (V2-§2.1); may not switch after the
   * offer. Absent on legacy reads ≡ "cash" (fundingSourceOf). */
  fundingSource: "cash" | "credit";
  /** Stamped at B-06 funding from the offer's branch (RIDER-5). */
  fundingMode: "cash-funded" | "credit-created";
  /** Credit branch: the deposit issued as proceeds (§3.1). */
  proceedsDepositId: string | null;
  /** Cash branch: the borrower ledger the funding line paid. */
  proceedsLedger: LedgerRef | null;
  rateBpsPerKseq: number;
  /** Credit branch: the created deposit's rate (BNK-D14, default 0),
   * stated at offer, bounded by the charter deposit ceiling. */
  createdDepositRateBpsPerKseq: number | null;
  /** Optional default rate replacing the rate for post-due
   * computation (§3.7); null = none stated. */
  defaultRateBpsPerKseq: number | null;
  /** Optional flat prepayment fee, part of the full-payoff figure
   * when stated (§3.5); null = none. */
  prepaymentFeeRubars: number | null;
  originatedAtSeq: number | null; // null while offered
  installmentCount: number;
  installmentsSettled: number;
  /** Derived at funding: ceil(principal / installmentCount); the
   * final installment takes the remainder (§3.1). */
  installmentPrincipalRubars: number | null;
  nextDueSeq: number | null;
  dueIntervalSeqs: number;
  /** Missed installments constituting default (§3.7). */
  defaultMissedCount: number;
  collateral: LoanCollateral;
  /** Derived at offer (§3.3), stored so the cap and the Log never
   * recompute differently. */
  insider: boolean;
  status: "offered" | "active" | "repaid" | "seized" | "written-off" | "assigned";
  /** Interest watermark (§3.6) — the funding seq at activation. */
  lastSettledSeq: number;
  /** Σ interest settled through B-07 over the loan's life (§3.9's
   * credit record reads these totals from the Log; the record
   * carries the running figure its closing entry states). */
  totalInterestPaidRubars: number;
  /** Σ principal extinguished by B-07 netting (Appendix C). */
  nettedPrincipalRubars: number;
  /** Outstanding extinguished by B-11 write-off (the equity-bridge
   * "credit loss" figure, REC-2 — a bridge line, never a burn). */
  writtenOffRubars: number;
  /** Setoff applied at liquidation (BNK-D16), borrower-depositor
   * loans only. */
  setoffAppliedRubars: number;
  assignee: string | null; // "depositor-pool:{bankCorporationId}" at assignment
  assignedAtSeq: number | null;
  /** B-08 seizure record, when seizure has executed against this
   * loan (bank branch or pool branch). */
  seizure: {
    atSeq: number;
    byActorMemberId: string;
    forPool: boolean;
    satisfactionValueRubars: number;
    excessReturnedRubars: number;
    remainderRubars: number;
  } | null;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: unknown; // committer-stamped
  updatedAt: unknown;
}

export function loanRecordOf(doc: Record<string, unknown> | null): BankLoanRecord | null {
  if (!doc || typeof doc.loanId !== "string") return null;
  return doc as unknown as BankLoanRecord;
}

export function fundingSourceOf(record: Pick<BankLoanRecord, "fundingSource">): "cash" | "credit" {
  return record.fundingSource === "credit" ? "credit" : "cash";
}

export function buildLoanOfferDoc(args: {
  loanId: string;
  bankCorporationId: string;
  bankCityId: string;
  borrower: LedgerRef;
  principalRubars: number;
  fundingSource: "cash" | "credit";
  rateBpsPerKseq: number;
  createdDepositRateBpsPerKseq: number | null;
  defaultRateBpsPerKseq: number | null;
  prepaymentFeeRubars: number | null;
  installmentCount: number;
  dueIntervalSeqs: number;
  defaultMissedCount: number;
  collateral: LoanCollateral;
  insider: boolean;
}): Record<string, unknown> {
  const record: BankLoanRecord = {
    loanId: args.loanId,
    bankCorporationId: args.bankCorporationId,
    bankCityId: args.bankCityId,
    borrower: args.borrower,
    principalRubars: args.principalRubars,
    outstandingRubars: args.principalRubars,
    fundingSource: args.fundingSource,
    fundingMode: args.fundingSource === "credit" ? "credit-created" : "cash-funded",
    proceedsDepositId: null,
    proceedsLedger: null,
    rateBpsPerKseq: args.rateBpsPerKseq,
    createdDepositRateBpsPerKseq: args.createdDepositRateBpsPerKseq,
    defaultRateBpsPerKseq: args.defaultRateBpsPerKseq,
    prepaymentFeeRubars: args.prepaymentFeeRubars,
    originatedAtSeq: null,
    installmentCount: args.installmentCount,
    installmentsSettled: 0,
    installmentPrincipalRubars: null,
    nextDueSeq: null,
    dueIntervalSeqs: args.dueIntervalSeqs,
    defaultMissedCount: args.defaultMissedCount,
    collateral: args.collateral,
    insider: args.insider,
    status: "offered",
    lastSettledSeq: 0,
    totalInterestPaidRubars: 0,
    nettedPrincipalRubars: 0,
    writtenOffRubars: 0,
    setoffAppliedRubars: 0,
    assignee: null,
    assignedAtSeq: null,
    seizure: null,
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdAt: null,
    updatedAt: null,
  };
  return { ...record };
}

/** Insider derivation (§3.3): the borrower is the bank's owner, a
 * company that owner owns, or the bank itself. Owner ids are
 * resolved by the caller from stored records — never inferred. */
export function isInsiderBorrower(args: {
  borrower: LedgerRef;
  bankOwnerMemberId: string;
  bankCorporationId: string;
  borrowerCompanyOwnerMemberId: string | null;
}): boolean {
  const { borrower } = args;
  if (borrower.kind === "personal") return borrower.memberId === args.bankOwnerMemberId;
  if (borrower.kind === "company") {
    if (borrower.corporationId === args.bankCorporationId) return true;
    return args.borrowerCompanyOwnerMemberId === args.bankOwnerMemberId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The schedule — derived state (§3.4/§3.7). Installment k (1-based)
// falls due at originatedAtSeq + k × dueIntervalSeqs, measured in
// resolved seqs (P4-K24's currency).
// ---------------------------------------------------------------------------

export function installmentPrincipalOf(principalRubars: number, installmentCount: number): number {
  return Math.ceil(principalRubars / installmentCount);
}

/** Principal of installment k (1-based): the derived per-installment
 * figure, the final installment taking the remainder. */
export function installmentPrincipalAt(
  principalRubars: number,
  installmentCount: number,
  k: number
): number {
  const base = installmentPrincipalOf(principalRubars, installmentCount);
  if (k < installmentCount) return base;
  return principalRubars - base * (installmentCount - 1);
}

export function installmentDueSeq(loan: BankLoanRecord, k: number): number | null {
  if (loan.originatedAtSeq === null) return null;
  return loan.originatedAtSeq + k * loan.dueIntervalSeqs;
}

/** Installments whose due seq has been reached at `atSeq`. */
export function dueInstallmentCount(loan: BankLoanRecord, atSeq: number): number {
  if (loan.originatedAtSeq === null) return 0;
  let count = 0;
  for (let k = 1; k <= loan.installmentCount; k += 1) {
    const due = installmentDueSeq(loan, k);
    if (due !== null && atSeq >= due) count = k;
    else break;
  }
  return count;
}

/** Due-and-unsettled installments at `atSeq` (§3.7's missed count). */
export function missedInstallmentCount(loan: BankLoanRecord, atSeq: number): number {
  return Math.max(0, dueInstallmentCount(loan, atSeq) - loan.installmentsSettled);
}

export interface LoanStanding {
  overdue: boolean;
  inDefault: boolean;
  dueCount: number;
  missedCount: number;
  accruedInterestRubars: number;
  /** Full payoff figure at `atSeq`: outstanding + unsettled
   * interest (+ the stated prepayment fee, which is part of the
   * payoff figure only — partial repayments never owe it). */
  payoffRubars: number;
  payoffWithFeeRubars: number;
}

/** Unsettled loan interest at `atSeq` (§3.6/§4.1): the one formula
 * over outstanding principal from the watermark. A stated default
 * rate replaces the rate for the post-due portion of the span: the
 * span splits at the next unsettled installment's due seq (§3.7). */
export function loanAccruedInterest(loan: BankLoanRecord, atSeq: number): number {
  if (loan.outstandingRubars <= 0) return 0;
  const from = loan.lastSettledSeq;
  if (atSeq <= from) return 0;
  const defaultRate = loan.defaultRateBpsPerKseq;
  if (defaultRate === null || loan.nextDueSeq === null || atSeq <= loan.nextDueSeq) {
    return interestForPeriod({
      baseRubars: loan.outstandingRubars,
      rateBpsPerKseq: loan.rateBpsPerKseq,
      fromSeq: from,
      toSeq: atSeq,
    });
  }
  const split = Math.max(from, loan.nextDueSeq);
  return (
    interestForPeriod({
      baseRubars: loan.outstandingRubars,
      rateBpsPerKseq: loan.rateBpsPerKseq,
      fromSeq: from,
      toSeq: split,
    }) +
    interestForPeriod({
      baseRubars: loan.outstandingRubars,
      rateBpsPerKseq: defaultRate,
      fromSeq: split,
      toSeq: atSeq,
    })
  );
}

export function deriveLoanStanding(loan: BankLoanRecord, atSeq: number): LoanStanding {
  const missed = missedInstallmentCount(loan, atSeq);
  const accrued = loanAccruedInterest(loan, atSeq);
  const live = loan.status === "active" || loan.status === "assigned";
  return {
    overdue:
      live &&
      loan.outstandingRubars > 0 &&
      loan.nextDueSeq !== null &&
      atSeq > loan.nextDueSeq &&
      missed > 0,
    inDefault: live && loan.outstandingRubars > 0 && missed >= loan.defaultMissedCount,
    dueCount: dueInstallmentCount(loan, atSeq),
    missedCount: missed,
    accruedInterestRubars: accrued,
    payoffRubars: loan.outstandingRubars + accrued,
    payoffWithFeeRubars: loan.outstandingRubars + accrued + (loan.prepaymentFeeRubars ?? 0),
  };
}

/** nextDueSeq after `installmentsSettled` advances: the due seq of
 * the next unsettled installment, or null when all are settled. */
export function nextDueSeqFor(loan: BankLoanRecord, installmentsSettled: number): number | null {
  if (installmentsSettled >= loan.installmentCount) return null;
  return installmentDueSeq(loan, installmentsSettled + 1);
}

// ---------------------------------------------------------------------------
// Repayment allocation (§3.5) — fixed order: unsettled interest,
// then principal, oldest installment first within principal.
// ---------------------------------------------------------------------------

export interface RepaymentAllocation {
  interestRubars: number;
  principalRubars: number;
  feeRubars: number;
  /** Installments fully covered after this payment. */
  installmentsSettledAfter: number;
  nextDueSeqAfter: number | null;
  closesLoan: boolean;
}

export function allocateRepayment(
  loan: BankLoanRecord,
  amountRubars: number,
  atSeq: number
): RepaymentAllocation {
  const standing = deriveLoanStanding(loan, atSeq);
  const interest = Math.min(amountRubars, standing.accruedInterestRubars);
  let rest = amountRubars - interest;
  let fee = 0;
  // The prepayment fee is owed only as part of the FULL payoff
  // figure: an amount that reaches outstanding + interest + fee
  // closes the loan and collects the fee; anything less is a
  // partial (or principal-complete) payment with no fee.
  const fullFigure = standing.payoffWithFeeRubars;
  if (loan.prepaymentFeeRubars !== null && amountRubars >= fullFigure) {
    fee = loan.prepaymentFeeRubars;
    rest -= fee;
  }
  const principal = Math.min(rest, loan.outstandingRubars);
  // Settled count advances by the installments the principal portion
  // fully covers, oldest first: settled principal after = (principal
  // already settled) + this principal portion.
  const settledPrincipalBefore = loan.principalRubars - loan.outstandingRubars;
  const settledPrincipalAfter = settledPrincipalBefore + principal;
  let settled = 0;
  let covered = 0;
  for (let k = 1; k <= loan.installmentCount; k += 1) {
    covered += installmentPrincipalAt(loan.principalRubars, loan.installmentCount, k);
    if (settledPrincipalAfter >= covered) settled = k;
    else break;
  }
  const closesLoan = loan.outstandingRubars - principal === 0;
  return {
    interestRubars: interest,
    principalRubars: principal,
    feeRubars: fee,
    installmentsSettledAfter: Math.max(loan.installmentsSettled, settled),
    nextDueSeqAfter: closesLoan ? null : nextDueSeqFor(loan, Math.max(loan.installmentsSettled, settled)),
    closesLoan,
  };
}

// ---------------------------------------------------------------------------
// Setoff (BNK-D16) and the waterfall (§5.5) — pure arithmetic over
// frozen claim figures. One claim basis serves tier (c), coverage,
// and setoff (REC-5): principal + credited + computable unsettled
// interest fixed at the failure seq.
// ---------------------------------------------------------------------------

export function frozenClaimOf(
  deposit: Pick<BankDepositRecord, "principalRubars" | "creditedInterestRubars">,
  accruedUnsettledAtFreeze: number
): number {
  return deposit.principalRubars + deposit.creditedInterestRubars + accruedUnsettledAtFreeze;
}

/** netClaim = max(0, claim − outstandingOwedToPool); any excess owed
 * survives as an unsecured pool obligation (returned second). */
export function setoffFor(claimRubars: number, outstandingOwedRubars: number): {
  netClaimRubars: number;
  setoffRubars: number;
  survivingObligationRubars: number;
} {
  const setoff = Math.min(claimRubars, outstandingOwedRubars);
  return {
    netClaimRubars: claimRubars - setoff,
    setoffRubars: setoff,
    survivingObligationRubars: outstandingOwedRubars - setoff,
  };
}

export interface ProRataShare {
  key: string;
  weight: number;
  cap: number;
}

/** Integer pro-rata with caps and iterative redistribution: each
 * share is floored, capped at its cap, and amounts freed by caps
 * redistribute to the uncapped until the amount is exhausted or
 * every share is capped. The un-distributable remainder (all capped,
 * or pure floor dust) is returned as `dustRubars` — it stays in the
 * frozen cash record (§5.6), never redistributed by rounding. */
export function distributeProRata(
  amountRubars: number,
  shares: ProRataShare[]
): { payouts: Map<string, number>; dustRubars: number } {
  const payouts = new Map<string, number>();
  for (const s of shares) payouts.set(s.key, 0);
  let remaining = amountRubars;
  let open = shares.filter((s) => s.weight > 0 && s.cap > 0);
  while (remaining > 0 && open.length > 0) {
    const roundStart = remaining;
    const totalWeight = open.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight <= 0) break;
    let distributed = 0;
    const nextOpen: ProRataShare[] = [];
    for (const share of open) {
      const already = payouts.get(share.key) ?? 0;
      const room = share.cap - already;
      const raw = Math.floor((roundStart * share.weight) / totalWeight);
      const give = Math.min(room, Math.max(0, raw));
      if (give > 0) {
        payouts.set(share.key, already + give);
        distributed += give;
      }
      if (already + give < share.cap) nextOpen.push(share);
    }
    remaining -= distributed;
    if (distributed === 0) break; // only floor dust remains — it stays (§5.6)
    open = nextOpen;
  }
  return { payouts, dustRubars: remaining };
}

/** A pool claim's unpaid balance, derived from its record (§5.6:
 * the pool is a derivation, not a fifth ledger). */
export function poolUnpaidRubars(
  deposit: Pick<BankDepositRecord, "liquidation">
): number {
  const block = deposit.liquidation;
  if (!block) return 0;
  return Math.max(
    0,
    block.frozenClaimRubars -
      block.setoffRubars -
      block.estatePaidRubars -
      block.fundPaidRubars -
      block.poolDistributedRubars
  );
}

/** createdSupply (Appendix C / V2-§2.2): Σ principal outstanding
 * over deposit records with origin "credit-created" — displayed
 * beside tracked cash, labeled, never combined into a stored
 * figure (guardrail 4). A created deposit's outstanding principal
 * falls by netting and by cash conversion, tracked on the record;
 * a pool-closing write-down (writtenDownRubars) extinguishes the
 * rest. */
export function createdSupplyOf(
  deposits: readonly Record<string, unknown>[]
): number {
  let total = 0;
  for (const doc of deposits) {
    if (doc.status === "closed") continue;
    const origin = typeof doc.origin === "string" ? doc.origin : "cash";
    if (origin !== "credit-created") continue;
    const principal = typeof doc.principalRubars === "number" ? doc.principalRubars : 0;
    const writtenDown = typeof doc.writtenDownRubars === "number" ? doc.writtenDownRubars : 0;
    total += Math.max(0, principal - writtenDown);
  }
  return total;
}
