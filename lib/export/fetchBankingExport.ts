/**
 * The fetch layer for the Phase 5 banking exports (amendment §7.5,
 * PR-6 assembly A8 — the runners for Felix's landed pure datasets in
 * ./datasets/bankingData.ts + ./bankingWorkbook.ts, in step 11's
 * pattern): every read executes CLIENT-SIDE as the requesting user,
 * through the same rules-governed queries the surfaces use —
 * visibility is inherited, never re-implemented. A denied or failed
 * read fails the export closed: no file, an honest error.
 *
 * Scope, per dataset (the §7.5 matrix, re-asserted in the pure
 * layer before any file exists):
 *  - Bank book — deposits / loans: the bank's OWNER reads the whole
 *    book through the corporation ownership fact in the rules; a
 *    DEPOSITOR / BORROWER reads only their own rows, via a query
 *    constrained to their own identity (rules are not filters — an
 *    unconstrained book query by a non-owner is denied whole, which
 *    is the posture working as designed).
 *  - Bank verified sheet: any member — the corporation record is
 *    public, the REC-6 sheet derives from it through the finance
 *    family's own bankBalanceSheet / deriveBankHealth, and the
 *    insurance posture line derives from the fund singleton (public
 *    state since the PR-6 assembly landed its rules block). The one
 *    figure the sheet cannot always derive is the per-bank created
 *    supply: it sums the bank's credit-created deposit records,
 *    which a non-owner may not read — on denial it stays null
 *    (never invented), exactly as the dataset's null discipline
 *    prescribes.
 *  - Failure statement: BANK-OWNER-scoped in this build. Felix's
 *    §7.5 matrix designs it as any-member (the waterfall's figures
 *    are public Log facts), but the per-depositor rows live on the
 *    deposit records, whose rules posture is holder-scoped — the
 *    B-10 Log event publishes the waterfall's totals, not the full
 *    per-row table. Until a posture decision (Vera) makes the
 *    liquidated records' liquidation blocks viewer-readable, the
 *    runner serves the one identity who may read every row and
 *    refuses the rest honestly. Named in the PR-6 body.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { ExportError } from "./sheetSpec";
import type { ExportContext } from "./datasets/cityData";
import {
  bankBalanceSheet,
  bankBlockOf,
  deriveBankHealth,
  describeInsurancePosture,
} from "@/lib/finance/banking";
import {
  fundRecordOf,
  insurancePostureFromFund,
  INSURANCE_FUND_PATH,
} from "@/lib/finance/insurance";
import { deliverWorkbook, type ExportFormat } from "./download";
import type {
  BankBookDepositsBundle,
  BankBookLoansBundle,
  BankDepositExportRow,
  BankLoanExportRow,
  BankVerifiedSheetBundle,
  FailureStatementBundle,
} from "./datasets/bankingData";
import {
  buildBankBookDepositsWorkbook,
  buildBankBookLoansWorkbook,
  buildBankVerifiedSheetWorkbook,
  buildFailureStatementWorkbook,
} from "./datasets/bankingWorkbook";

const READ_CAP = 5000;

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readOrFail<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new ExportError(
      `${what} could not be read as your account, so no export was produced.`
    );
  }
}

function refLabel(ref: DocumentData | undefined): {
  label: string;
  memberId: string | null;
} {
  if (!ref || typeof ref !== "object") return { label: "unknown", memberId: null };
  if (ref.kind === "personal") {
    const memberId = strOf(ref.memberId);
    return { label: memberId ?? "unknown", memberId };
  }
  if (ref.kind === "company") {
    return { label: `company:${strOf(ref.corporationId) ?? "unknown"}`, memberId: null };
  }
  if (ref.kind === "treasury") {
    return { label: `treasury:${strOf(ref.cityId) ?? "unknown"}`, memberId: null };
  }
  return { label: "unknown", memberId: null };
}

interface BankContext {
  corp: DocumentData;
  bankLabel: string;
  bankOwnerMemberId: string;
}

async function readBank(
  bankCityId: string,
  bankCorporationId: string
): Promise<BankContext> {
  const db = getClientDb();
  const snap = await readOrFail("The bank's corporation record", () =>
    getDoc(doc(db, "sim_cities", bankCityId, "corporations", bankCorporationId))
  );
  if (!snap.exists()) {
    throw new ExportError(
      `No corporation record stands at ${bankCityId}/${bankCorporationId}, so no export was produced.`
    );
  }
  const corp = snap.data();
  return {
    corp,
    bankLabel: strOf(corp.name) ?? bankCorporationId,
    bankOwnerMemberId: strOf(corp.ownerMemberId) ?? "",
  };
}

async function readBankDeposits(
  bankCorporationId: string,
  ownMemberId: string | null
): Promise<DocumentData[]> {
  const db = getClientDb();
  const constraints = [where("bankCorporationId", "==", bankCorporationId)];
  if (ownMemberId !== null) {
    constraints.push(where("depositor.memberId", "==", ownMemberId));
  }
  const snap = await readOrFail("The bank's deposit book", () =>
    getDocs(query(collection(db, "sim_bank_deposits"), ...constraints))
  );
  return snap.docs.slice(0, READ_CAP).map((d) => d.data());
}

async function readBankLoans(
  bankCorporationId: string,
  ownMemberId: string | null
): Promise<DocumentData[]> {
  const db = getClientDb();
  const constraints = [where("bankCorporationId", "==", bankCorporationId)];
  if (ownMemberId !== null) {
    constraints.push(where("borrower.memberId", "==", ownMemberId));
  }
  const snap = await readOrFail("The bank's loan book", () =>
    getDocs(query(collection(db, "sim_bank_loans"), ...constraints))
  );
  return snap.docs.slice(0, READ_CAP).map((d) => d.data());
}

function exportCtx(asOfSeq: number): ExportContext {
  return {
    asOfSeq,
    rulesVersion: null,
    exportedAtIso: new Date().toISOString(),
    exportedByLabel: "the requesting member",
  };
}

function depositRow(data: DocumentData): BankDepositExportRow {
  const { label, memberId } = refLabel(data.depositor as DocumentData);
  return {
    depositId: strOf(data.depositId) ?? "",
    bankCorporationId: strOf(data.bankCorporationId) ?? "",
    depositorLabel: label,
    depositorMemberId: memberId,
    principalRubars: numOf(data.principalRubars) ?? 0,
    creditedInterestRubars: numOf(data.creditedInterestRubars) ?? 0,
    origin: strOf(data.origin) ?? "cash",
    rateBpsPerKseq: numOf(data.rateBpsPerKseq),
    status: strOf(data.status) ?? "",
    openedAtSeq: numOf(data.openedAtSeq),
    lastChangedSeq: numOf(data.lastChangedSeq),
    stateVersion: numOf(data.stateVersion),
  };
}

function loanRow(data: DocumentData): BankLoanExportRow {
  const { label, memberId } = refLabel(data.borrower as DocumentData);
  return {
    loanId: strOf(data.loanId) ?? "",
    bankCorporationId: strOf(data.bankCorporationId) ?? "",
    borrowerLabel: label,
    borrowerMemberId: memberId,
    principalRubars: numOf(data.principalRubars) ?? 0,
    outstandingRubars: numOf(data.outstandingRubars) ?? 0,
    rateBpsPerKseq: numOf(data.rateBpsPerKseq),
    fundingSource: strOf(data.fundingSource) ?? "cash",
    insider: data.insider === true,
    status: strOf(data.status) ?? "",
    originatedAtSeq: numOf(data.originatedAtSeq),
    totalInterestPaidRubars: numOf(data.totalInterestPaidRubars),
    lastChangedSeq: numOf(data.lastChangedSeq),
    stateVersion: numOf(data.stateVersion),
  };
}

// ---------------------------------------------------------------------------
// Bank book — deposits
// ---------------------------------------------------------------------------

export async function fetchBankBookDeposits(
  uid: string,
  bankCityId: string,
  bankCorporationId: string
): Promise<{ bundle: BankBookDepositsBundle; ctx: ExportContext }> {
  const bank = await readBank(bankCityId, bankCorporationId);
  const isOwner = uid === bank.bankOwnerMemberId;
  const docs = await readBankDeposits(bankCorporationId, isOwner ? null : uid);
  const deposits = docs
    .map(depositRow)
    .filter(
      (row) => isOwner || row.depositorMemberId === uid
    );
  const asOfSeq = deposits.reduce(
    (max, r) => Math.max(max, r.lastChangedSeq ?? 0, r.openedAtSeq ?? 0),
    0
  );
  return {
    bundle: {
      bankCorporationId,
      bankCityId,
      bankLabel: bank.bankLabel,
      bankOwnerMemberId: bank.bankOwnerMemberId,
      view: isOwner ? "bank-owner" : "depositor",
      deposits,
    },
    ctx: exportCtx(asOfSeq),
  };
}

// ---------------------------------------------------------------------------
// Bank book — loans
// ---------------------------------------------------------------------------

export async function fetchBankBookLoans(
  uid: string,
  bankCityId: string,
  bankCorporationId: string
): Promise<{ bundle: BankBookLoansBundle; ctx: ExportContext }> {
  const bank = await readBank(bankCityId, bankCorporationId);
  const isOwner = uid === bank.bankOwnerMemberId;
  const docs = await readBankLoans(bankCorporationId, isOwner ? null : uid);
  const loans = docs
    .map(loanRow)
    .filter((row) => isOwner || row.borrowerMemberId === uid);
  const asOfSeq = loans.reduce(
    (max, r) => Math.max(max, r.lastChangedSeq ?? 0, r.originatedAtSeq ?? 0),
    0
  );
  return {
    bundle: {
      bankCorporationId,
      bankCityId,
      bankLabel: bank.bankLabel,
      bankOwnerMemberId: bank.bankOwnerMemberId,
      view: isOwner ? "bank-owner" : "borrower",
      loans,
    },
    ctx: exportCtx(asOfSeq),
  };
}

// ---------------------------------------------------------------------------
// Bank verified sheet (any member)
// ---------------------------------------------------------------------------

export async function fetchBankVerifiedSheet(
  bankCityId: string,
  bankCorporationId: string
): Promise<{ bundle: BankVerifiedSheetBundle; ctx: ExportContext }> {
  const bank = await readBank(bankCityId, bankCorporationId);
  const corp = bank.corp;
  const block = bankBlockOf(corp as Record<string, unknown>);
  const sheet = bankBalanceSheet(corp as Record<string, unknown>);

  // The per-bank created supply sums this bank's credit-created
  // deposit records — readable in full only by the bank's owner
  // (and per-row by each depositor). On any denial the figure
  // stays null: stated nowhere, invented nowhere.
  let createdSupplyRubars: number | null = null;
  try {
    const db = getClientDb();
    const snap = await getDocs(
      query(
        collection(db, "sim_bank_deposits"),
        where("bankCorporationId", "==", bankCorporationId)
      )
    );
    createdSupplyRubars = snap.docs.reduce((sum, d) => {
      const data = d.data();
      if (data.origin !== "credit-created" || data.status !== "active") {
        return sum;
      }
      const outstanding =
        (numOf(data.principalRubars) ?? 0) +
        (numOf(data.creditedInterestRubars) ?? 0) -
        (numOf(data.writtenDownRubars) ?? 0);
      return sum + Math.max(0, outstanding);
    }, 0);
  } catch {
    createdSupplyRubars = null;
  }

  // The insurance posture line: the fund singleton is public state
  // (PR-6 assembly rules block). Absence of the record IS the
  // pre-founding posture. Eligibility per bank derives from the
  // suspension ladder over Log markers — not recomputed in a fetch
  // (null stays null, per the dataset's discipline).
  let insurancePosture: string | null = null;
  try {
    const db = getClientDb();
    const fundSnap = await getDoc(doc(db, INSURANCE_FUND_PATH));
    const fund = fundSnap.exists()
      ? fundRecordOf(fundSnap.data() as Record<string, unknown>)
      : null;
    insurancePosture = describeInsurancePosture(
      insurancePostureFromFund({ fund, bankEligible: null })
    ).join(" ");
  } catch {
    insurancePosture = null;
  }

  const bundle: BankVerifiedSheetBundle = {
    bankCorporationId,
    bankCityId,
    bankLabel: bank.bankLabel,
    charterStatus: block?.status ?? null,
    reserveRatioBps: block?.reserveRatioBps ?? null,
    depositRateCeilingBpsPerKseq: block?.depositRateCeilingBpsPerKseq ?? null,
    loanRateCeilingBpsPerKseq: block?.loanRateCeilingBpsPerKseq ?? null,
    trackedCashRubars: sheet?.cashRubars ?? null,
    loanBookRubars: sheet?.loanBookRubars ?? null,
    seizedAssetsRubars: sheet?.seizedAssetsRubars ?? null,
    depositLiabilitiesRubars: sheet?.depositLiabilitiesRubars ?? null,
    netWorthRubars: sheet?.netWorthRubars ?? null,
    liquidReserveRubars: sheet?.liquidReserveRubars ?? null,
    health: sheet ? deriveBankHealth(corp as Record<string, unknown>) : null,
    createdSupplyRubars,
    insurancePosture,
    asOfSeq: numOf(corp.lastChangedSeq),
    stateVersion: numOf(corp.stateVersion),
  };
  return { bundle, ctx: exportCtx(bundle.asOfSeq ?? 0) };
}

// ---------------------------------------------------------------------------
// Failure statement (bank-owner-scoped in this build — see header)
// ---------------------------------------------------------------------------

export async function fetchFailureStatement(
  uid: string,
  bankCityId: string,
  bankCorporationId: string,
  liquidationId: string
): Promise<{ bundle: FailureStatementBundle; ctx: ExportContext }> {
  const bank = await readBank(bankCityId, bankCorporationId);
  if (uid !== bank.bankOwnerMemberId) {
    throw new ExportError(
      "The failure statement's per-depositor rows sit on the deposit records, which only the bank's owner may read in full under the current rules posture — the any-member venue named in the §7.5 matrix awaits the posture decision recorded in the PR-6 body, so no export was produced."
    );
  }
  const docs = await readBankDeposits(bankCorporationId, null);
  const rows: FailureStatementBundle["rows"] = [];
  let liquidatedAtSeq: number | null = null;
  for (const data of docs) {
    const liq = data.liquidation as DocumentData | null | undefined;
    if (!liq || typeof liq !== "object" || liq.liquidationId !== liquidationId) {
      continue;
    }
    const { label } = refLabel(data.depositor as DocumentData);
    rows.push({
      depositId: strOf(data.depositId) ?? "",
      depositorLabel: label,
      frozenClaimRubars: numOf(liq.frozenClaimRubars) ?? 0,
      coveredRubars: numOf(liq.coveredRubars) ?? 0,
      uninsuredRubars: numOf(liq.uninsuredRubars) ?? 0,
      setoffRubars: numOf(liq.setoffRubars) ?? 0,
      estatePaidRubars: numOf(liq.estatePaidRubars) ?? 0,
      fundPaidRubars: numOf(liq.fundPaidRubars) ?? 0,
      fundShortfallRubars: numOf(liq.fundShortfallRubars) ?? 0,
      poolDistributedRubars: numOf(liq.poolDistributedRubars) ?? 0,
    });
    liquidatedAtSeq = numOf(liq.liquidatedAtSeq) ?? liquidatedAtSeq;
  }
  if (rows.length === 0) {
    throw new ExportError(
      `No deposit records carry liquidation ${liquidationId} at this bank, so no export was produced.`
    );
  }
  rows.sort((a, b) => (a.depositId < b.depositId ? -1 : 1));
  return {
    bundle: {
      bankCorporationId,
      bankCityId,
      bankLabel: bank.bankLabel,
      liquidationId,
      liquidatedAtSeq,
      trigger: null,
      rows,
    },
    ctx: exportCtx(liquidatedAtSeq ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Download runners (fetch + build + deliver; a failed or
// out-of-scope read throws before any file exists)
// ---------------------------------------------------------------------------

export async function downloadBankBookDeposits(
  uid: string,
  bankCityId: string,
  bankCorporationId: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchBankBookDeposits(
    uid,
    bankCityId,
    bankCorporationId
  );
  await deliverWorkbook(buildBankBookDepositsWorkbook(bundle, ctx, uid), format);
}

export async function downloadBankBookLoans(
  uid: string,
  bankCityId: string,
  bankCorporationId: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchBankBookLoans(
    uid,
    bankCityId,
    bankCorporationId
  );
  await deliverWorkbook(buildBankBookLoansWorkbook(bundle, ctx, uid), format);
}

export async function downloadBankVerifiedSheet(
  bankCityId: string,
  bankCorporationId: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchBankVerifiedSheet(
    bankCityId,
    bankCorporationId
  );
  await deliverWorkbook(buildBankVerifiedSheetWorkbook(bundle, ctx), format);
}

export async function downloadFailureStatement(
  uid: string,
  bankCityId: string,
  bankCorporationId: string,
  liquidationId: string,
  format: ExportFormat
): Promise<void> {
  const { bundle, ctx } = await fetchFailureStatement(
    uid,
    bankCityId,
    bankCorporationId,
    liquidationId
  );
  await deliverWorkbook(buildFailureStatementWorkbook(bundle, ctx), format);
}
