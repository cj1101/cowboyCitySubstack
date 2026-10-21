/**
 * The Phase 5 banking workbook builders (banking amendment §7.5):
 * Bank book — deposits, Bank book — loans, Bank verified sheet,
 * and the Failure statement. Pure: bundles + context →
 * PlannedWorkbook, through the same SheetSpec contract and
 * packaging caps as every export since Phase 3.
 *
 * Every figure is verified-tier (resolver/Log-derived records).
 * The bank book builders re-assert their §7.5 scope in the pure
 * layer (fail-closed) — see bankingData.ts for the matrix.
 *
 * Labeling (guardrail G4): the verified sheet's cash figure is
 * headed `tracked_cash_rubars` and defined as tracked cash; the
 * credit-created figure is headed `created_supply_rubars` and
 * defined as Σ principal outstanding over this bank's
 * credit-created deposit records — the two stand side by side,
 * labeled, never conflated, and no heading in this module uses an
 * unqualified "money supply".
 */

import {
  assembleWorkbook,
  exportFilenameBase,
  provenanceDefinitions,
  provenanceValues,
  withProvenance,
  type ColumnDefinition,
  type PlannedWorkbook,
  type SheetColumn,
  type SheetSpec,
} from "../sheetSpec";
import type { ExportContext } from "./cityData";
import {
  assertBankBookDepositsScope,
  assertBankBookLoansScope,
  type BankBookDepositsBundle,
  type BankBookLoansBundle,
  type BankVerifiedSheetBundle,
  type FailureStatementBundle,
} from "./bankingData";

function defs(tab: string, rows: [string, string, string | null][]): ColumnDefinition[] {
  return rows.map(([column, meaning, unit]) => ({
    tab,
    column,
    meaning,
    unit,
    trustTier: "verified",
    source: "sim state (resolver/Log)",
  }));
}

const DEPOSIT_COLUMNS: SheetColumn[] = [
  { key: "deposit_id", header: "deposit_id", width: 20, type: "string" },
  { key: "depositor", header: "depositor", width: 22, type: "string" },
  { key: "principal_rubars", header: "principal_rubars", width: 16, type: "number" },
  { key: "credited_interest_rubars", header: "credited_interest_rubars", width: 22, type: "number" },
  { key: "claim_basis_rubars", header: "claim_basis_rubars", width: 18, type: "number" },
  { key: "origin", header: "origin", width: 15, type: "string" },
  { key: "rate_bps_per_kseq", header: "rate_bps_per_kseq", width: 17, type: "number" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "opened_at_seq", header: "opened_at_seq", width: 14, type: "number" },
];

const LOAN_COLUMNS: SheetColumn[] = [
  { key: "loan_id", header: "loan_id", width: 20, type: "string" },
  { key: "borrower", header: "borrower", width: 22, type: "string" },
  { key: "principal_rubars", header: "principal_rubars", width: 16, type: "number" },
  { key: "outstanding_rubars", header: "outstanding_rubars", width: 18, type: "number" },
  { key: "rate_bps_per_kseq", header: "rate_bps_per_kseq", width: 17, type: "number" },
  { key: "funding_source", header: "funding_source", width: 14, type: "string" },
  { key: "insider", header: "insider", width: 9, type: "string" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "total_interest_paid_rubars", header: "total_interest_paid_rubars", width: 24, type: "number" },
  { key: "originated_at_seq", header: "originated_at_seq", width: 16, type: "number" },
];

const VERIFIED_COLUMNS: SheetColumn[] = [
  { key: "figure", header: "figure", width: 30, type: "string" },
  { key: "value", header: "value", width: 20, type: "string" },
];

const FAILURE_COLUMNS: SheetColumn[] = [
  { key: "deposit_id", header: "deposit_id", width: 20, type: "string" },
  { key: "depositor", header: "depositor", width: 22, type: "string" },
  { key: "frozen_claim_rubars", header: "frozen_claim_rubars", width: 19, type: "number" },
  { key: "covered_rubars", header: "covered_rubars", width: 15, type: "number" },
  { key: "uninsured_rubars", header: "uninsured_rubars", width: 17, type: "number" },
  { key: "setoff_rubars", header: "setoff_rubars", width: 14, type: "number" },
  { key: "estate_paid_rubars", header: "estate_paid_rubars", width: 18, type: "number" },
  { key: "fund_paid_rubars", header: "fund_paid_rubars", width: 16, type: "number" },
  { key: "fund_shortfall_rubars", header: "fund_shortfall_rubars", width: 20, type: "number" },
  { key: "pool_distributed_rubars", header: "pool_distributed_rubars", width: 22, type: "number" },
];

function provenance(
  ctx: ExportContext,
  bundle: { bankCityId: string; bankCorporationId: string; bankLabel: string },
  notes: string,
  asOfSeq: number | null
) {
  return provenanceValues({
    cityId: bundle.bankCityId,
    cityName: null,
    entityId: bundle.bankCorporationId,
    entityName: bundle.bankLabel,
    trustTier: "verified",
    sourceType: "resolver",
    sourceRef: asOfSeq ? `seq ${asOfSeq}` : null,
    asOfSeq: ctx.asOfSeq,
    rulesVersion: ctx.rulesVersion,
    stateVersion: null,
    notes,
  });
}

// ---------------------------------------------------------------------------
// Bank book — deposits
// ---------------------------------------------------------------------------

export function buildBankBookDepositsWorkbook(
  bundle: BankBookDepositsBundle,
  ctx: ExportContext,
  requesterUid: string
): PlannedWorkbook {
  assertBankBookDepositsScope(bundle, requesterUid);
  const sheet: SheetSpec = {
    name: "Deposits",
    columns: withProvenance(DEPOSIT_COLUMNS),
    rows: bundle.deposits.map((row) => ({
      deposit_id: row.depositId,
      depositor: row.depositorLabel,
      principal_rubars: row.principalRubars,
      credited_interest_rubars: row.creditedInterestRubars,
      claim_basis_rubars: row.principalRubars + row.creditedInterestRubars,
      origin: row.origin,
      rate_bps_per_kseq: row.rateBpsPerKseq,
      status: row.status,
      opened_at_seq: row.openedAtSeq,
      ...provenance(
        ctx,
        bundle,
        bundle.view === "bank-owner"
          ? "The bank owner's full deposit book (§7.5). Personal deposit rows appear in no other member's export."
          : "The requester's own deposit claims at this bank only (§7.5/§2.7).",
        row.lastChangedSeq
      ),
    })),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase(`bank-book-deposits-${bundle.bankCorporationId}`, ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Bank book — deposits — ${bundle.bankLabel}`,
      scopeLabel:
        bundle.view === "bank-owner"
          ? `${bundle.bankLabel} (bank owner's full book)`
          : `${bundle.bankLabel} (requester's own claims only)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions: [
      ...defs("Deposits", [
        ["claim_basis_rubars", "principal + credited interest — the claim basis (REC-5) before computable unsettled interest, which derives from the Log at any stated seq.", "Rubar"],
        ["origin", "cash | credit-created: a credit-created deposit was issued as loan proceeds under B-06's paired posting (Appendix A); its claim is identical in rank to a cash deposit's.", null],
      ]),
      ...provenanceDefinitions("Deposits"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Bank book — loans
// ---------------------------------------------------------------------------

export function buildBankBookLoansWorkbook(
  bundle: BankBookLoansBundle,
  ctx: ExportContext,
  requesterUid: string
): PlannedWorkbook {
  assertBankBookLoansScope(bundle, requesterUid);
  const sheet: SheetSpec = {
    name: "Loans",
    columns: withProvenance(LOAN_COLUMNS),
    rows: bundle.loans.map((row) => ({
      loan_id: row.loanId,
      borrower: row.borrowerLabel,
      principal_rubars: row.principalRubars,
      outstanding_rubars: row.outstandingRubars,
      rate_bps_per_kseq: row.rateBpsPerKseq,
      funding_source: row.fundingSource,
      insider: row.insider ? "yes" : "no",
      status: row.status,
      total_interest_paid_rubars: row.totalInterestPaidRubars,
      originated_at_seq: row.originatedAtSeq,
      ...provenance(
        ctx,
        bundle,
        bundle.view === "bank-owner"
          ? "The bank owner's full loan book (§7.5)."
          : "The requester's own loans at this bank only (§7.5).",
        row.lastChangedSeq
      ),
    })),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase(`bank-book-loans-${bundle.bankCorporationId}`, ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Bank book — loans — ${bundle.bankLabel}`,
      scopeLabel:
        bundle.view === "bank-owner"
          ? `${bundle.bankLabel} (bank owner's full book)`
          : `${bundle.bankLabel} (requester's own loans only)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions: [
      ...defs("Loans", [
        ["funding_source", "cash | credit: fixed at offer (B-05) and stated on the record; a credit-funded loan's proceeds deposit stands in the deposit book with origin credit-created.", null],
        ["insider", "Derived at funding from the charter's insider set (§3.3) and stored on the record; the insider cap is A-B3's standing check.", null],
      ]),
      ...provenanceDefinitions("Loans"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Bank verified sheet (any member)
// ---------------------------------------------------------------------------

export function buildBankVerifiedSheetWorkbook(
  bundle: BankVerifiedSheetBundle,
  ctx: ExportContext
): PlannedWorkbook {
  const figures: [string, number | string | null][] = [
    ["charter_status", bundle.charterStatus],
    ["reserve_ratio_bps", bundle.reserveRatioBps],
    ["deposit_rate_ceiling_bps_per_kseq", bundle.depositRateCeilingBpsPerKseq],
    ["loan_rate_ceiling_bps_per_kseq", bundle.loanRateCeilingBpsPerKseq],
    ["tracked_cash_rubars", bundle.trackedCashRubars],
    ["loan_book_rubars", bundle.loanBookRubars],
    ["seized_assets_rubars", bundle.seizedAssetsRubars],
    ["deposit_liabilities_rubars", bundle.depositLiabilitiesRubars],
    ["net_worth_rubars", bundle.netWorthRubars],
    ["liquid_reserve_rubars", bundle.liquidReserveRubars],
    ["health", bundle.health],
    ["created_supply_rubars", bundle.createdSupplyRubars],
    ["insurance_posture", bundle.insurancePosture],
  ];
  const sheet: SheetSpec = {
    name: "Verified sheet",
    columns: withProvenance(VERIFIED_COLUMNS),
    rows: figures.map(([figure, value]) => ({
      figure,
      value: value === null ? null : String(value),
      ...provenance(
        ctx,
        bundle,
        "Verified figures derived from the standing records (REC-6 identity) — not owner-published claims. tracked_cash_rubars is the bank's tracked cash; created_supply_rubars is Σ principal outstanding over this bank's credit-created deposit records. The two are different quantities and are never added together on this sheet.",
        bundle.asOfSeq
      ),
    })),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase(`bank-sheet-${bundle.bankCorporationId}`, ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Bank verified sheet — ${bundle.bankLabel}`,
      scopeLabel: `${bundle.bankLabel} (public verified sheet)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions: [
      ...defs("Verified sheet", [
        ["tracked_cash_rubars", "The bank corporation's tracked cash (its company ledger balance). 'Tracked' is the label: the realm's money also exists as Exterior flows.", "Rubar"],
        ["created_supply_rubars", "Σ principal outstanding over this bank's credit-created deposit records — the supply the bank created by lending (Appendix A/C). A different quantity from tracked cash; the two are never conflated.", "Rubar"],
        ["net_worth_rubars", "Assets − liabilities on the REC-6 identity: (tracked cash + loan book + seized assets at recorded satisfaction value + recognized insurance receivables) − (deposit liabilities + tax payables + adjudicated payables + other recognized liabilities).", "Rubar"],
        ["insurance_posture", "Generated from derived fund state by the one posture path (§7.6/G5) — the same text the site shows.", null],
      ]),
      ...provenanceDefinitions("Verified sheet"),
    ],
  });
}

// ---------------------------------------------------------------------------
// Failure statement (any member, per liquidation)
// ---------------------------------------------------------------------------

export function buildFailureStatementWorkbook(
  bundle: FailureStatementBundle,
  ctx: ExportContext
): PlannedWorkbook {
  const sheet: SheetSpec = {
    name: "Failure statement",
    columns: withProvenance(FAILURE_COLUMNS),
    rows: bundle.rows.map((row) => ({
      deposit_id: row.depositId,
      depositor: row.depositorLabel,
      frozen_claim_rubars: row.frozenClaimRubars,
      covered_rubars: row.coveredRubars,
      uninsured_rubars: row.uninsuredRubars,
      setoff_rubars: row.setoffRubars,
      estate_paid_rubars: row.estatePaidRubars,
      fund_paid_rubars: row.fundPaidRubars,
      fund_shortfall_rubars: row.fundShortfallRubars,
      pool_distributed_rubars: row.poolDistributedRubars,
      ...provenance(
        ctx,
        bundle,
        `Liquidation ${bundle.liquidationId} (${bundle.trigger ?? "unknown"} trigger). Frozen figures are the REC-5 basis the waterfall published; live balances are never in a failure statement.`,
        bundle.liquidatedAtSeq
      ),
    })),
  };
  return assembleWorkbook({
    filenameBase: exportFilenameBase(`failure-${bundle.bankCorporationId}`, ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Failure statement — ${bundle.bankLabel}`,
      scopeLabel: `${bundle.bankLabel} liquidation ${bundle.liquidationId} (public)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions: [
      ...defs("Failure statement", [
        ["frozen_claim_rubars", "Principal + credited + computable unsettled interest at the failure seq (REC-5) — the one basis for tier (c), coverage, and setoff.", "Rubar"],
        ["covered_rubars", "The insured portion: min(combined net claims, 250,000 R) per depositor per bank, eligible deposits only; insiders excluded.", "Rubar"],
        ["fund_shortfall_rubars", "Covered amount the fund could not pay inside the liquidation — queued senior unpaid (REC-7), settled before later failures' top-ups.", "Rubar"],
      ]),
      ...provenanceDefinitions("Failure statement"),
    ],
  });
}
