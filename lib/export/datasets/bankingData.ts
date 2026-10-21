/**
 * Input shapes for the Phase 5 banking datasets (banking amendment
 * §7.5). Like the Phase 4 datasets, these are PURE inputs: a fetch
 * layer fills them from rules-governed reads executed as the
 * requester, and the builders in ./bankingWorkbook.ts turn them
 * into SheetSpecs — a builder can only ever contain what the
 * requester was allowed to read.
 *
 * Scope (the §7.5 matrix, enforced AGAIN in the pure layer,
 * fail-closed):
 *  - Bank book — deposits: the bank's OWNER sees the bank's whole
 *    book; a DEPOSITOR sees only their own claim rows at that bank.
 *    A personal deposit row exports to NO ONE else — not to other
 *    depositors, not to the borrower's other banks, not in any
 *    city bundle (§2.7).
 *  - Bank book — loans: the bank's owner sees the whole book; a
 *    BORROWER sees only their own loan rows.
 *  - Bank verified sheet: any member — the charter terms and the
 *    REC-6 derived sheet are public facts about a chartered bank
 *    (they gate other members' deposit decisions).
 *  - Failure statement: any member, per liquidation — the
 *    waterfall's figures are public Log facts (per-depositor rows
 *    in a failure statement carry the FROZEN CLAIM figures the
 *    waterfall itself published; a depositor's LIVE balances are
 *    never in it).
 *
 * Tier discipline: every figure here is resolver/Log-derived
 * (verified tier). Owner-published claims about a bank (a bank's
 * own marketing sheet) are a different dataset on a different tab
 * by the standing rule — none is defined here, deliberately.
 *
 * Labeling (guardrail G4): cash figures are TRACKED cash; the
 * credit-created supply figure travels under its own name
 * (`created_supply_rubars`), defined on the sheet, and is never
 * conflated with tracked cash. No column anywhere in this module
 * is named or headed with an unqualified "money supply".
 */

import { ExportError } from "../sheetSpec";

export interface BankDepositExportRow {
  depositId: string;
  bankCorporationId: string;
  /** Depositor identity in export form: a member id for personal
   * deposits, `company:{corporationId}` / `treasury:{cityId}` for
   * the others (the §7.5 matrix exports counterparty identity to
   * the bank owner; a depositor's own-rows view contains only
   * themselves). */
  depositorLabel: string;
  /** The member id when the depositor is personal, else null —
   * the scope assertion's key. */
  depositorMemberId: string | null;
  principalRubars: number;
  creditedInterestRubars: number;
  /** "cash" | "credit-created" (absent on legacy rows reads cash). */
  origin: string;
  rateBpsPerKseq: number | null;
  status: string;
  openedAtSeq: number | null;
  lastChangedSeq: number | null;
  stateVersion: number | null;
}

export interface BankBookDepositsBundle {
  bankCorporationId: string;
  bankCityId: string;
  bankLabel: string;
  /** The bank corporation owner's member id (the fetch reads it
   * from the corporation record; the owner view must match it). */
  bankOwnerMemberId: string;
  /** Which of the two lawful views this bundle is. */
  view: "bank-owner" | "depositor";
  deposits: BankDepositExportRow[];
}

export interface BankLoanExportRow {
  loanId: string;
  bankCorporationId: string;
  borrowerLabel: string;
  borrowerMemberId: string | null;
  principalRubars: number;
  outstandingRubars: number;
  rateBpsPerKseq: number | null;
  fundingSource: string;
  insider: boolean;
  status: string;
  originatedAtSeq: number | null;
  totalInterestPaidRubars: number | null;
  lastChangedSeq: number | null;
  stateVersion: number | null;
}

export interface BankBookLoansBundle {
  bankCorporationId: string;
  bankCityId: string;
  bankLabel: string;
  bankOwnerMemberId: string;
  view: "bank-owner" | "borrower";
  loans: BankLoanExportRow[];
}

export interface BankVerifiedSheetBundle {
  bankCorporationId: string;
  bankCityId: string;
  bankLabel: string;
  charterStatus: string | null;
  reserveRatioBps: number | null;
  depositRateCeilingBpsPerKseq: number | null;
  loanRateCeilingBpsPerKseq: number | null;
  /** REC-6 sheet, computed by the fetch from the standing records
   * (the pure layer formats; it does not recompute — nulls stay
   * null, never invented). */
  trackedCashRubars: number | null;
  loanBookRubars: number | null;
  seizedAssetsRubars: number | null;
  depositLiabilitiesRubars: number | null;
  netWorthRubars: number | null;
  liquidReserveRubars: number | null;
  health: string | null;
  /** Σ principal outstanding over credit-created deposit records
   * realm-wide is a REALM figure; this per-bank figure is the same
   * derivation restricted to this bank's created deposits. */
  createdSupplyRubars: number | null;
  insurancePosture: string | null;
  asOfSeq: number | null;
  stateVersion: number | null;
}

export interface FailureStatementRow {
  depositId: string;
  depositorLabel: string;
  frozenClaimRubars: number;
  coveredRubars: number;
  uninsuredRubars: number;
  setoffRubars: number;
  estatePaidRubars: number;
  fundPaidRubars: number;
  fundShortfallRubars: number;
  poolDistributedRubars: number;
}

export interface FailureStatementBundle {
  bankCorporationId: string;
  bankCityId: string;
  bankLabel: string;
  liquidationId: string;
  liquidatedAtSeq: number | null;
  trigger: string | null;
  rows: FailureStatementRow[];
}

// ---------------------------------------------------------------------------
// Scope assertions (fail-closed, pure layer — the TC-X discipline)
// ---------------------------------------------------------------------------

export function assertBankBookDepositsScope(
  bundle: BankBookDepositsBundle,
  requesterUid: string
): void {
  if (bundle.view === "bank-owner") {
    if (bundle.bankOwnerMemberId !== requesterUid) {
      throw new ExportError(
        "A bank's full deposit book exports only to the bank's owner. No file was produced."
      );
    }
    return;
  }
  for (const row of bundle.deposits) {
    if (row.depositorMemberId !== requesterUid) {
      throw new ExportError(
        "A depositor's bank-book export contains only their own claim rows (§7.5/§2.7). No file was produced."
      );
    }
  }
}

export function assertBankBookLoansScope(
  bundle: BankBookLoansBundle,
  requesterUid: string
): void {
  if (bundle.view === "bank-owner") {
    if (bundle.bankOwnerMemberId !== requesterUid) {
      throw new ExportError(
        "A bank's full loan book exports only to the bank's owner. No file was produced."
      );
    }
    return;
  }
  for (const row of bundle.loans) {
    if (row.borrowerMemberId !== requesterUid) {
      throw new ExportError(
        "A borrower's bank-book export contains only their own loan rows (§7.5). No file was produced."
      );
    }
  }
}
