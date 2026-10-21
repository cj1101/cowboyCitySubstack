/**
 * The conservation checker (finance-system-design.md §3.1 as
 * generalized by FIN-C1/P4-K13, banking amendment Appendix A as
 * REPLACED by REC-2/RIDER-3) — a pure function over Resolution Event
 * records (entries' changes[] + the manifest writeSet) and standing
 * records. The Build Lead wires it into the standing verifier
 * (lib/sim/verify.ts) and QA's H-P45-4 harness; it shares no code path
 * with the handlers it checks.
 *
 * What it proves, per event:
 *  1. Settlement-cash bridge (finance §3.1's equation, surviving as
 *     the first of the two money bridges):
 *       Σ Δtracked + exteriorOut − exteriorIn − minted + burned = 0
 *     computed over SETTLEMENT CASH only (personal cash, treasuries,
 *     company cash). Governed by the closed mint/burn list (§3.3):
 *     mint/burn legs are lawful only under a ruleId on that list.
 *  2. Paired-posting balance (V-B1 analogue), computed independently
 *     from the Log side: every cash leg, claim leg, Exterior leg and
 *     mint/burn leg in the entries' changes[] sums to zero — no
 *     balance, claim, or liability changes unless the same event's
 *     lines explain both sides or name the lawful external source.
 *  3. Log/writeSet bijection for finance fields: the changes[] deltas
 *     per ledger equal the manifest writeSet's before/after deltas —
 *     a Log line with no movement, or a movement with no Log line, is
 *     a failure (finance §2.1.5).
 *  4. Claim-money bridge with SOURCE-CLASSIFIED ΔM (V-B5): every
 *     deposit-claim delta is classified by its record's provenance
 *     (cash-funded / credit-created / interest-capitalized /
 *     insurance-paid). Unexplained ΔM is a failure. In the Phase 4
 *     slice the only lawful claim source is cash funding, so a
 *     cash-origin claim increase must be matched by settlement cash
 *     entering the same bank in the same event.
 *  5. A-B4 creation pairing (any phase): a deposit record with
 *     origin "credit-created" whose fundingLoanId names no loan
 *     record on the same bank is a failure — a created claim with no
 *     loan record, ever, is what A-B4 forbids.
 *
 * Standing stock assertions over supplied records:
 *  - A-B1: bank.depositLiabilitiesRubars == Σ (principal + credited
 *    interest) over the bank's active deposits.
 *  - A-B2: bank.loanBookRubars == Σ outstanding over its active loans
 *    (asserts trivially against the Phase 4 slice's empty loan book —
 *    asserted from the start so Phase 5 activates a watched
 *    invariant, not a new one). Phase 5 (PR-6) adds the per-event
 *    pair discipline: every event moving a loan record moves the
 *    aggregate by the same delta in the same event (and likewise
 *    A-B3's insider aggregate and A-B7's seized-assets aggregate).
 *  - A-B3: bank.insiderLoansRubars == Σ outstanding over its active
 *    insider loans.
 *  - A-B5 (Phase 5): created claims never exceed their backing —
 *    per funding loan, Σ principal over its non-closed
 *    credit-created deposits ≤ the loan's funded principal.
 *  - A-B6 (Phase 5, at DIF founding): the fund's
 *    totalInsuredLiabilitiesRubars == the insured-liabilities
 *    derivation over supplied records (its fundCashRubars IS the
 *    segregated account's balance — one doc, one balance; the
 *    aggregate-vs-ledger discipline for fund cash discharges
 *    per-event through the bridge + bijection over
 *    institutionAccount lines, wired with the institution's
 *    tracked class below).
 *  - A-B7 (Phase 5): bank.seizedAssetsRubars == Σ recorded
 *    satisfaction values over the bank's loans carrying a seizure
 *    record (the REC-6 other-recognized-assets term's truth).
 *  - Share conservation (P4-K21): Σ holdings + retired ==
 *    sharesOutstanding, asserted for every supplied corporation
 *    record that carries share figures.
 *  - Non-negativity: no tracked cash balance below zero.
 *
 * Honest scope: V-B6 (atomic pair survival under undo) and V-B7
 * (preview parity) are verifier/undo-venue properties, not per-event
 * record properties — they are follow-ups for the Lead's verify.ts
 * wiring, named here so this module's coverage is never overstated.
 * NO no-creation invariant is asserted anywhere in this module
 * (guardrail 1): claim money may lawfully grow by the classified
 * sources above; what is forbidden is growth no line explains.
 */

// ---------------------------------------------------------------------------
// Inputs — minimal structural views over committed records.
// ---------------------------------------------------------------------------

export interface ConservationChangeView {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ConservationEntryView {
  seq?: number;
  cityId: string | null;
  ruleIds: string[];
  changes: ConservationChangeView[];
}

export interface ConservationWriteView {
  path: string;
  op: "create" | "update" | "delete";
  beforeDoc: Record<string, unknown> | null;
  afterDoc: Record<string, unknown> | null;
}

export interface ConservationEvent {
  resolutionId: string;
  entries: ConservationEntryView[];
  writeSet: ConservationWriteView[];
}

export interface ConservationFinding {
  code: string;
  message: string;
  resolutionId?: string;
  path?: string;
}

export interface ConservationRecords {
  /** Corporation docs by path (or any iterable of docs carrying
   * `bank` blocks / share figures). */
  corporations: Record<string, unknown>[];
  deposits: Record<string, unknown>[];
  loans: Record<string, unknown>[];
  memberAccounts?: Record<string, unknown>[];
  cities?: Record<string, unknown>[];
  holdings?: Record<string, unknown>[];
  /** The DIF institution record (Phase 5), when the fund stands —
   * A-B6 asserts over it. */
  fund?: Record<string, unknown> | null;
  /** Log-derived suspension intervals per bank (coverage reads
   * them; A-B6's derivation consumes them). */
  suspensionIntervalsByBank?: ReadonlyMap<string, readonly { fromSeq: number; toSeq: number | null }[]>;
}

export interface EventConservationSummary {
  resolutionId: string;
  deltaTrackedCashRubars: number;
  exteriorNetIntoRubars: number;
  mintedRubars: number;
  burnedRubars: number;
  /** ΔM for the event, split by source class. */
  deltaClaimBySource: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Small readers.
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function docNum(doc: Record<string, unknown> | null, dottedField: string): number {
  if (!doc) return 0;
  let current: unknown = doc;
  for (const part of dottedField.split(".")) {
    if (typeof current !== "object" || current === null) return 0;
    current = (current as Record<string, unknown>)[part];
  }
  return num(current);
}

function changeDelta(change: ConservationChangeView): number {
  return num(change.after) - num(change.before);
}

const MINT_RULES = new Set(["F-01", "M-00"]); // finance §3.3 closed list (Phase 4 slice; M-00 = the Market Account seed, joined when the Market module landed its founding act in step 7)
const BURN_RULES = new Set<string>(); // no burn exists in v1 (§3.3)

// ---------------------------------------------------------------------------
// Ledger identification.
// ---------------------------------------------------------------------------

type CashLedgerKind = "personal" | "treasury" | "company" | "market" | "institution";

function cashDeltaOfWrite(write: ConservationWriteView): {
  kind: CashLedgerKind;
  key: string;
  delta: number;
} | null {
  if (write.path === "sim_deposit_insurance_fund/main") {
    // The DIF's segregated account (fifth tracked class, REC-3):
    // premiums in and payouts out are transfers within tracked
    // ledgers, so the fund's cash belongs inside Σ Δtracked.
    return {
      kind: "institution",
      key: write.path,
      delta: docNum(write.afterDoc, "fundCashRubars") - docNum(write.beforeDoc, "fundCashRubars"),
    };
  }
  if (write.path === "sim_market_account/main") {
    // The Market Account (finance §1.1 account class 4): §3.1's
    // generalized invariant names it inside Σ Δtracked; recognized
    // here when the Market module landed its record (step 7).
    return {
      kind: "market",
      key: write.path,
      delta: docNum(write.afterDoc, "cashRubars") - docNum(write.beforeDoc, "cashRubars"),
    };
  }
  const account = /^sim_member_accounts\/([^/]+)$/.exec(write.path);
  if (account) {
    return {
      kind: "personal",
      key: write.path,
      delta: docNum(write.afterDoc, "cashRubars") - docNum(write.beforeDoc, "cashRubars"),
    };
  }
  const corp = /^sim_cities\/([^/]+)\/corporations\/([^/]+)$/.exec(write.path);
  if (corp) {
    return {
      kind: "company",
      key: write.path,
      delta:
        docNum(write.afterDoc, "companyCashRubars") -
        docNum(write.beforeDoc, "companyCashRubars"),
    };
  }
  const city = /^sim_cities\/([^/]+)$/.exec(write.path);
  if (city) {
    return {
      kind: "treasury",
      key: write.path,
      delta:
        docNum(write.afterDoc, "stats.treasuryRubars") -
        docNum(write.beforeDoc, "stats.treasuryRubars"),
    };
  }
  return null;
}

/** Resolve an entry change to (doc path, doc field) under the finance
 * change grammar (accounts.ts). Returns null for legs with no doc
 * (exterior:, mint:, burn:). */
function resolveChangeTarget(
  entry: ConservationEntryView,
  change: ConservationChangeView
): { path: string; docField: string } | null {
  const personal = /^memberAccounts\/([^/.]+)\.(.+)$/.exec(change.field);
  if (personal) {
    return { path: `sim_member_accounts/${personal[1]}`, docField: personal[2] };
  }
  const deposit = /^bankDeposits\/([^/.]+)\.(.+)$/.exec(change.field);
  if (deposit) {
    return { path: `sim_bank_deposits/${deposit[1]}`, docField: deposit[2] };
  }
  const loan = /^bankLoans\/([^/.]+)\.(.+)$/.exec(change.field);
  if (loan) {
    return { path: `sim_bank_loans/${loan[1]}`, docField: loan[2] };
  }
  if (change.field === "institutionAccount.cashRubars") {
    // The DIF account's change spelling (accounts.ts grammar) — a
    // top-level doc riding null-city entries, like the Market
    // Account's.
    return { path: "sim_deposit_insurance_fund/main", docField: "fundCashRubars" };
  }
  if (change.field === "marketAccount.cashRubars") {
    // The Market Account's change spelling (accounts.ts grammar) —
    // a top-level doc like the personal accounts, riding null-city
    // entries; mapped so fee legs enter the paired-posting sum and
    // the Log/writeSet bijection instead of passing unseen.
    return { path: "sim_market_account/main", docField: "cashRubars" };
  }
  if (entry.cityId) {
    const corp = /^corporations\/([^/.]+)\.(.+)$/.exec(change.field);
    if (corp) {
      return {
        path: `sim_cities/${entry.cityId}/corporations/${corp[1]}`,
        docField: corp[2],
      };
    }
    return { path: `sim_cities/${entry.cityId}`, docField: change.field };
  }
  return null;
}

function depositClaimOf(doc: Record<string, unknown> | null): number {
  if (!doc) return 0;
  if (doc.status === "closed") return 0;
  return num(doc.principalRubars) + num(doc.creditedInterestRubars);
}

function depositOriginOf(doc: Record<string, unknown>): string {
  return typeof doc.origin === "string" ? doc.origin : "cash";
}

// ---------------------------------------------------------------------------
// Per-event checks.
// ---------------------------------------------------------------------------

export function checkConservationEvent(
  event: ConservationEvent,
  context?: { loans?: Record<string, unknown>[] }
): { ok: boolean; findings: ConservationFinding[]; summary: EventConservationSummary } {
  const findings: ConservationFinding[] = [];
  const push = (code: string, message: string, path?: string) =>
    findings.push({ code, message, resolutionId: event.resolutionId, ...(path ? { path } : {}) });

  // -- (1) Settlement-cash bridge over the writeSet ----------------------
  let deltaTracked = 0;
  const writeCashByKey = new Map<string, number>();
  for (const write of event.writeSet) {
    const cash = cashDeltaOfWrite(write);
    if (cash) {
      deltaTracked += cash.delta;
      writeCashByKey.set(cash.key, (writeCashByKey.get(cash.key) ?? 0) + cash.delta);
    }
  }

  let exteriorNetInto = 0;
  let minted = 0;
  let burned = 0;
  for (const entry of event.entries) {
    for (const change of entry.changes) {
      if (change.field.startsWith("exterior:")) {
        exteriorNetInto += num(change.after);
      } else if (change.field.startsWith("mint:")) {
        const ruleId = change.field.slice("mint:".length);
        if (!MINT_RULES.has(ruleId)) {
          push(
            "MINT_NOT_ON_CLOSED_LIST",
            `mint leg cites ${ruleId}, which is not on finance §3.3's closed mint list`
          );
        }
        minted += num(change.after);
      } else if (change.field.startsWith("burn:")) {
        const ruleId = change.field.slice("burn:".length);
        if (!BURN_RULES.has(ruleId)) {
          push(
            "BURN_NOT_ON_CLOSED_LIST",
            `burn leg cites ${ruleId}, but no burn exists in v1 (finance §3.3)`
          );
        }
        burned += num(change.after);
      }
    }
  }
  if (deltaTracked - exteriorNetInto - minted + burned !== 0) {
    push(
      "SETTLEMENT_CASH_BRIDGE",
      `settlement-cash bridge does not balance: Δtracked ${deltaTracked} − Exterior net-in ${exteriorNetInto} − minted ${minted} + burned ${burned} ≠ 0`
    );
  }

  // -- (3) Log/writeSet bijection for finance fields ---------------------
  const logDeltaByTarget = new Map<string, number>();
  for (const entry of event.entries) {
    for (const change of entry.changes) {
      const target = resolveChangeTarget(entry, change);
      if (!target) continue;
      const key = `${target.path}|${target.docField}`;
      logDeltaByTarget.set(key, (logDeltaByTarget.get(key) ?? 0) + changeDelta(change));
    }
  }
  const writeByPath = new Map(event.writeSet.map((w) => [w.path, w]));
  for (const [key, logDelta] of logDeltaByTarget) {
    const [path, docField] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    const write = writeByPath.get(path);
    if (!write) {
      push(
        "LOG_WRITE_DIVERGENCE",
        `Log claims a change to ${docField} on ${path} but the manifest writeSet writes no such doc`,
        path
      );
      continue;
    }
    const writeDelta = docNum(write.afterDoc, docField) - docNum(write.beforeDoc, docField);
    if (writeDelta !== logDelta) {
      push(
        "LOG_WRITE_DIVERGENCE",
        `Log changes for ${docField} on ${path} sum to ${logDelta} but the writeSet moves ${writeDelta}`,
        path
      );
    }
  }

  // -- (2)+(4) Paired posting + claim classification, from the Log side --
  let postingSum = 0;
  const claimDeltaByBankFromLog = new Map<string, number>();
  for (const entry of event.entries) {
    for (const change of entry.changes) {
      if (
        change.field.startsWith("exterior:") ||
        change.field.startsWith("mint:") ||
        change.field.startsWith("burn:")
      ) {
        // Balancing postings: an Exterior inflow / mint is the tracked
        // system's gain, posted negative against the cash legs.
        postingSum -= num(change.after);
        continue;
      }
      const target = resolveChangeTarget(entry, change);
      if (!target) continue;
      const delta = changeDelta(change);
      if (target.docField === "cashRubars" || target.docField === "stats.treasuryRubars" || target.docField === "companyCashRubars" || target.docField === "fundCashRubars") {
        postingSum += delta; // cash asset leg
      }
      if (
        target.path.startsWith("sim_bank_deposits/") &&
        (target.docField === "principalRubars" || target.docField === "creditedInterestRubars")
      ) {
        // Claim legs cancel pairwise: holder +Δ, bank liability −Δ in
        // signed-posting terms nets to zero — but the bank's aggregate
        // change must carry the same Δ (checked just below), which is
        // what makes the pair a pair in the Log.
        const depositWrite = writeByPath.get(target.path);
        const bankId = depositWrite?.afterDoc?.bankCorporationId ?? depositWrite?.beforeDoc?.bankCorporationId;
        if (typeof bankId === "string") {
          claimDeltaByBankFromLog.set(
            bankId,
            (claimDeltaByBankFromLog.get(bankId) ?? 0) + delta
          );
        }
      }
    }
  }
  if (postingSum !== 0) {
    push(
      "PAIRED_POSTING_IMBALANCE",
      `paired-posting identity fails over the event's Log lines: postings sum to ${postingSum}, not 0`
    );
  }
  // The bank aggregate's Log change must equal the sum of its deposits'
  // claim changes in the same event (the event-level form of A-B1).
  // Phase 5: the record side is STATUS-AWARE — a claim counts toward
  // the aggregate only while its record is active, so a liquidation
  // sweep (active → assigned, claim figure unchanged) lawfully
  // drops the aggregate in the same event. The record side is
  // therefore computed from the writeSet with countedClaim(); the
  // bijection check (3) has already proved the Log's deposit
  // principal/credited changes equal the writeSet's, so for events
  // without status transitions this is identical to the Log-side
  // accumulation (claimDeltaByBankFromLog above).
  {
    const countedClaim = (doc: Record<string, unknown> | null): number =>
      doc && doc.status === "active"
        ? num(doc.principalRubars) + num(doc.creditedInterestRubars)
        : 0;
    const claimDeltaByBankFromWrites = new Map<string, number>();
    for (const write of event.writeSet) {
      if (!/^sim_bank_deposits\/[^/]+$/.test(write.path)) continue;
      const doc = write.afterDoc ?? write.beforeDoc;
      const bankId = typeof doc?.bankCorporationId === "string" ? doc.bankCorporationId : "";
      if (!bankId) continue;
      const delta = countedClaim(write.afterDoc) - countedClaim(write.beforeDoc);
      if (delta !== 0) {
        claimDeltaByBankFromWrites.set(
          bankId,
          (claimDeltaByBankFromWrites.get(bankId) ?? 0) + delta
        );
      }
    }
    for (const entry of event.entries) {
      for (const change of entry.changes) {
        const target = resolveChangeTarget(entry, change);
        if (!target || target.docField !== "bank.depositLiabilitiesRubars") continue;
        const corpId = /^sim_cities\/[^/]+\/corporations\/([^/]+)$/.exec(target.path)?.[1];
        const expected = corpId ? claimDeltaByBankFromWrites.get(corpId) ?? 0 : 0;
        if (changeDelta(change) !== expected) {
          push(
            "AGGREGATE_PAIR_DIVERGENCE",
            `bank ${corpId ?? target.path} aggregate moved ${changeDelta(change)} but its deposit records' claims moved ${expected} in the same event`,
            target.path
          );
        }
      }
    }
  }

  // Phase 5: the same per-event pair discipline for the loan-side
  // aggregates (the event-level forms of A-B2, A-B3, A-B7). The
  // record side is computed from the writeSet (status-aware:
  // "active" loans count toward loanBook/insider; seizure values
  // count while the loan is unassigned); the bijection check (3)
  // already proved the Log's loan changes equal these writeSet
  // deltas, so comparing the aggregate's LOG change against the
  // writeSet's record sums is the same cross-side discipline as
  // the deposit pair above.
  {
    const loanDeltaByBank = new Map<string, number>();
    const insiderDeltaByBank = new Map<string, number>();
    const seizedDeltaByBank = new Map<string, number>();
    const countedOutstanding = (doc: Record<string, unknown> | null): number =>
      doc && doc.status === "active" ? num(doc.outstandingRubars) : 0;
    const countedSeizure = (doc: Record<string, unknown> | null): number => {
      if (!doc || doc.status === "assigned") return 0;
      const seizure = doc.seizure as { satisfactionValueRubars?: unknown } | null;
      return seizure && typeof seizure === "object" ? num(seizure.satisfactionValueRubars) : 0;
    };
    for (const write of event.writeSet) {
      if (!/^sim_bank_loans\/[^/]+$/.test(write.path)) continue;
      const doc = write.afterDoc ?? write.beforeDoc;
      const bankId = typeof doc?.bankCorporationId === "string" ? doc.bankCorporationId : "";
      if (!bankId) continue;
      const bookDelta = countedOutstanding(write.afterDoc) - countedOutstanding(write.beforeDoc);
      if (bookDelta !== 0) {
        loanDeltaByBank.set(bankId, (loanDeltaByBank.get(bankId) ?? 0) + bookDelta);
      }
      const insider = (write.afterDoc ?? write.beforeDoc)?.insider === true;
      if (insider && bookDelta !== 0) {
        insiderDeltaByBank.set(bankId, (insiderDeltaByBank.get(bankId) ?? 0) + bookDelta);
      }
      const seizedDelta = countedSeizure(write.afterDoc) - countedSeizure(write.beforeDoc);
      if (seizedDelta !== 0) {
        seizedDeltaByBank.set(bankId, (seizedDeltaByBank.get(bankId) ?? 0) + seizedDelta);
      }
    }
    const pairFields: {
      field: string;
      deltas: Map<string, number>;
      label: string;
    }[] = [
      { field: "bank.loanBookRubars", deltas: loanDeltaByBank, label: "loan records' outstanding" },
      { field: "bank.insiderLoansRubars", deltas: insiderDeltaByBank, label: "insider loan records' outstanding" },
      { field: "bank.seizedAssetsRubars", deltas: seizedDeltaByBank, label: "loans' recorded seizure values" },
    ];
    for (const { field, deltas, label } of pairFields) {
      for (const entry of event.entries) {
        for (const change of entry.changes) {
          const target = resolveChangeTarget(entry, change);
          if (!target || target.docField !== field) continue;
          const corpId = /^sim_cities\/[^/]+\/corporations\/([^/]+)$/.exec(target.path)?.[1];
          const expected = corpId ? deltas.get(corpId) ?? 0 : 0;
          if (changeDelta(change) !== expected) {
            push(
              "AGGREGATE_PAIR_DIVERGENCE",
              `bank ${corpId ?? target.path} aggregate ${field} moved ${changeDelta(change)} but its ${label} moved ${expected} in the same event`,
              target.path
            );
          }
        }
      }
      // A record-side movement with NO aggregate Log change anywhere
      // in the event is the same divergence (the tamper-negative
      // form: a loan moved and the aggregate never followed).
      for (const [bankId, delta] of deltas) {
        if (delta === 0) continue;
        const logged = event.entries.some((entry) =>
          entry.changes.some((change) => {
            const target = resolveChangeTarget(entry, change);
            return (
              target !== null &&
              target.docField === field &&
              /^sim_cities\/[^/]+\/corporations\/([^/]+)$/.exec(target.path)?.[1] === bankId
            );
          })
        );
        if (!logged) {
          push(
            "AGGREGATE_PAIR_DIVERGENCE",
            `bank ${bankId}: its ${label} moved ${delta} in this event but ${field} has no Log change in the event`,
            `sim_bank_loans`
          );
        }
      }
    }
  }

  // A-B4, plan-shape half (Phase 5): a credit-created deposit may
  // only be BORN inside an event that also activates exactly one
  // loan of equal principal at the same bank (the Appendix A pair).
  // Unpaired issuance — a deposit created with no matching loan
  // activation, or a credit-mode activation with no deposit — is a
  // must-not-build made checkable (M1). Cash-mode activations and
  // non-creation deposit writes are untouched by this check.
  {
    const createdDeposits: { bankId: string; principal: number }[] = [];
    const creditActivations: { bankId: string; principal: number }[] = [];
    for (const write of event.writeSet) {
      if (/^sim_bank_deposits\/[^/]+$/.test(write.path)) {
        const after = write.afterDoc;
        if (
          write.op === "create" &&
          after &&
          depositOriginOf(after) === "credit-created"
        ) {
          createdDeposits.push({
            bankId: typeof after.bankCorporationId === "string" ? after.bankCorporationId : "",
            principal: num(after.principalRubars),
          });
        }
      }
      if (/^sim_bank_loans\/[^/]+$/.test(write.path)) {
        const before = write.beforeDoc;
        const after = write.afterDoc;
        if (
          before &&
          after &&
          before.status === "offered" &&
          after.status === "active" &&
          after.fundingMode === "credit-created"
        ) {
          creditActivations.push({
            bankId: typeof after.bankCorporationId === "string" ? after.bankCorporationId : "",
            principal: num(after.principalRubars),
          });
        }
      }
    }
    if (createdDeposits.length > 0 || creditActivations.length > 0) {
      const paired =
        createdDeposits.length === 1 &&
        creditActivations.length === 1 &&
        createdDeposits[0].bankId === creditActivations[0].bankId &&
        createdDeposits[0].principal === creditActivations[0].principal;
      if (!paired) {
        push(
          "A_B4_CREATION_PAIRING",
          `credit creation must pair exactly one created deposit with exactly one credit-mode loan activation of equal principal at the same bank in one event (deposits created: ${createdDeposits.length}, credit activations: ${creditActivations.length})`
        );
      }
    }
  }

  // -- (4)+(5) Claim bridge classification + A-B4, from the writeSet -----
  const deltaClaimBySource: Record<string, number> = {};
  const bankCashDelta = new Map<string, number>();
  for (const write of event.writeSet) {
    const corp = /^sim_cities\/[^/]+\/corporations\/([^/]+)$/.exec(write.path);
    if (corp) {
      bankCashDelta.set(
        corp[1],
        (bankCashDelta.get(corp[1]) ?? 0) +
          (docNum(write.afterDoc, "companyCashRubars") - docNum(write.beforeDoc, "companyCashRubars"))
      );
    }
  }
  const loans = context?.loans ?? [];
  for (const write of event.writeSet) {
    if (!/^sim_bank_deposits\/[^/]+$/.test(write.path)) continue;
    const before = write.beforeDoc;
    const after = write.afterDoc;
    const claimDelta = depositClaimOf(after) - depositClaimOf(before);
    const creditedDelta =
      num(after?.creditedInterestRubars) - num(before?.creditedInterestRubars);
    if (claimDelta === 0 && creditedDelta === 0) continue;
    const doc = after ?? before;
    if (!doc) continue;
    const origin = depositOriginOf(doc);
    const bankId = typeof doc.bankCorporationId === "string" ? doc.bankCorporationId : "";
    if (creditedDelta > 0) {
      deltaClaimBySource["interest-capitalized"] =
        (deltaClaimBySource["interest-capitalized"] ?? 0) + creditedDelta;
    }
    const principalDelta = claimDelta - creditedDelta;
    if (principalDelta !== 0) {
      const source =
        origin === "credit-created"
          ? "credit-created"
          : origin === "insurance-paid"
            ? "insurance-paid"
            : origin === "transfer-reissued"
              ? "transfer-reissued"
              : "cash-funded";
      deltaClaimBySource[source] = (deltaClaimBySource[source] ?? 0) + principalDelta;
      if (source === "cash-funded" && principalDelta > 0) {
        // A cash-funded claim increase must be matched by settlement
        // cash entering the same bank in the same event — otherwise
        // the claim growth is unexplained ΔM (V-B5).
        const cashIn = bankCashDelta.get(bankId) ?? 0;
        if (cashIn < principalDelta) {
          push(
            "CLAIM_UNEXPLAINED",
            `deposit ${write.path} grew a cash-funded claim by ${principalDelta} R but bank ${bankId}'s tracked cash grew only ${cashIn} R in the event — unexplained ΔM`,
            write.path
          );
        }
      }
      if (origin === "credit-created") {
        const fundingLoanId = doc.fundingLoanId;
        const loan =
          typeof fundingLoanId === "string"
            ? loans.find((l) => l.loanId === fundingLoanId)
            : undefined;
        if (!loan || loan.bankCorporationId !== bankId) {
          push(
            "A_B4_CREATION_PAIRING",
            `deposit ${write.path} has origin "credit-created" but fundingLoanId ${JSON.stringify(fundingLoanId ?? null)} names no loan record on bank ${bankId} — a created claim with no loan record`,
            write.path
          );
        }
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    summary: {
      resolutionId: event.resolutionId,
      deltaTrackedCashRubars: deltaTracked,
      exteriorNetIntoRubars: exteriorNetInto,
      mintedRubars: minted,
      burnedRubars: burned,
      deltaClaimBySource,
    },
  };
}

// ---------------------------------------------------------------------------
// Standing stock assertions over supplied records.
// ---------------------------------------------------------------------------

export function checkStandingRecords(records: ConservationRecords): {
  ok: boolean;
  findings: ConservationFinding[];
} {
  const findings: ConservationFinding[] = [];
  const push = (code: string, message: string, path?: string) =>
    findings.push({ code, message, ...(path ? { path } : {}) });

  const activeDeposits = records.deposits.filter((d) => d.status === "active");
  const activeLoans = records.loans.filter((l) => l.status === "active");

  for (const corp of records.corporations) {
    const bank = corp.bank as Record<string, unknown> | undefined;
    const corporationId = typeof corp.corporationId === "string" ? corp.corporationId : "";
    if (bank && typeof bank === "object") {
      const claimSum = activeDeposits
        .filter((d) => d.bankCorporationId === corporationId)
        .reduce((sum, d) => sum + num(d.principalRubars) + num(d.creditedInterestRubars), 0);
      if (num(bank.depositLiabilitiesRubars) !== claimSum) {
        push(
          "A_B1_LIABILITY_AGGREGATE",
          `bank ${corporationId}: depositLiabilitiesRubars ${num(bank.depositLiabilitiesRubars)} != Σ claims over active deposits ${claimSum}`
        );
      }
      const loanSum = activeLoans
        .filter((l) => l.bankCorporationId === corporationId)
        .reduce((sum, l) => sum + num(l.outstandingRubars), 0);
      if (num(bank.loanBookRubars) !== loanSum) {
        push(
          "A_B2_LOAN_BOOK_AGGREGATE",
          `bank ${corporationId}: loanBookRubars ${num(bank.loanBookRubars)} != Σ outstanding over active loans ${loanSum}`
        );
      }
      const insiderSum = activeLoans
        .filter((l) => l.bankCorporationId === corporationId && l.insider === true)
        .reduce((sum, l) => sum + num(l.outstandingRubars), 0);
      if (num(bank.insiderLoansRubars) !== insiderSum) {
        push(
          "A_B3_INSIDER_AGGREGATE",
          `bank ${corporationId}: insiderLoansRubars ${num(bank.insiderLoansRubars)} != Σ outstanding over active insider loans ${insiderSum}`
        );
      }
    }
    if (num(corp.companyCashRubars) < 0) {
      push("NEGATIVE_BALANCE", `corporation ${corporationId} holds negative company cash`);
    }
    // Share conservation (P4-K21) — asserted wherever the supplied
    // record carries share figures; the Market module's records are
    // the source when they land.
    if (typeof corp.sharesOutstanding === "number" && records.holdings) {
      const held = records.holdings
        .filter((h) => h.corporationId === corporationId)
        .reduce((sum, h) => sum + num(h.quantityShares), 0);
      const retired = num(corp.retiredShares);
      if (held + retired !== corp.sharesOutstanding) {
        push(
          "SHARE_CONSERVATION",
          `corporation ${corporationId}: Σ holdings ${held} + retired ${retired} != sharesOutstanding ${corp.sharesOutstanding} (P4-K21)`
        );
      }
    }
  }
  for (const account of records.memberAccounts ?? []) {
    if (num(account.cashRubars) < 0) {
      push("NEGATIVE_BALANCE", `member account ${String(account.memberId)} holds negative cash`);
    }
  }
  for (const city of records.cities ?? []) {
    if (docNum(city, "stats.treasuryRubars") < 0) {
      push("NEGATIVE_BALANCE", `city ${String(city.cityId ?? "")} holds a negative treasury`);
    }
  }
  // A-B4 against standing records: no credit-created deposit may stand
  // without its same-bank loan record (any phase).
  for (const deposit of records.deposits) {
    if (depositOriginOf(deposit) !== "credit-created") continue;
    const fundingLoanId = deposit.fundingLoanId;
    const loan =
      typeof fundingLoanId === "string"
        ? records.loans.find((l) => l.loanId === fundingLoanId)
        : undefined;
    if (!loan || loan.bankCorporationId !== deposit.bankCorporationId) {
      push(
        "A_B4_CREATION_PAIRING",
        `deposit ${String(deposit.depositId)} is credit-created but fundingLoanId ${JSON.stringify(fundingLoanId ?? null)} names no loan on bank ${String(deposit.bankCorporationId)}`
      );
    }
  }

  // A-B5 (Phase 5, Appendix C): created claims never exceed their
  // backing — per funding loan, Σ principal over its non-closed
  // credit-created deposits ≤ the loan's funded principal. Born
  // equal at funding (B-06); the deposit's principal thereafter
  // only falls (netting lowers it, cash conversion keeps the record
  // whole), so any excess is a tamper or an unpaired issuance.
  {
    const createdByLoan = new Map<string, number>();
    for (const deposit of records.deposits) {
      if (deposit.status === "closed") continue;
      if (depositOriginOf(deposit) !== "credit-created") continue;
      const principal = num(deposit.principalRubars);
      const writtenDown = num(deposit.writtenDownRubars);
      if (writtenDown > principal) {
        push(
          "A_B5_CREATED_CLAIMS",
          `deposit ${String(deposit.depositId)}: writtenDownRubars ${writtenDown} exceeds principal ${principal} (A-B5)`
        );
      }
      if (typeof deposit.fundingLoanId === "string") {
        createdByLoan.set(
          deposit.fundingLoanId,
          (createdByLoan.get(deposit.fundingLoanId) ?? 0) + principal
        );
      }
    }
    for (const loan of records.loans) {
      if (typeof loan.loanId !== "string") continue;
      const created = createdByLoan.get(loan.loanId) ?? 0;
      if (created > num(loan.principalRubars)) {
        push(
          "A_B5_CREATED_CLAIMS",
          `loan ${loan.loanId}: credit-created deposit principal Σ ${created} exceeds the loan's funded principal ${num(loan.principalRubars)} (A-B5: created claims exceed their backing)`
        );
      }
    }
  }

  // A-B7 (Phase 5, REC-6's seized-assets term): each bank's
  // seizedAssetsRubars == Σ recorded satisfaction values over its
  // loans carrying a seizure record and not yet swept into a pool
  // (assignment moves the position into the pool derivation; the
  // closing bank's aggregate zeroes inside the liquidation event).
  for (const corp of records.corporations) {
    const bank = corp.bank as Record<string, unknown> | undefined;
    if (!bank || typeof bank !== "object") continue;
    const corporationId = typeof corp.corporationId === "string" ? corp.corporationId : "";
    const seizedSum = records.loans
      .filter((l) => l.bankCorporationId === corporationId && l.status !== "assigned")
      .reduce((sum, l) => {
        const seizure = l.seizure as { satisfactionValueRubars?: unknown } | null;
        return (
          sum +
          (seizure && typeof seizure === "object"
            ? num(seizure.satisfactionValueRubars)
            : 0)
        );
      }, 0);
    if (num(bank.seizedAssetsRubars) !== seizedSum) {
      push(
        "A_B7_SEIZED_AGGREGATE",
        `bank ${corporationId}: seizedAssetsRubars ${num(bank.seizedAssetsRubars)} != Σ recorded satisfaction values over its seized loans ${seizedSum} (A-B7)`
      );
    }
  }

  // A-B6 (Phase 5, V2-§1.2): when the fund record stands, its
  // maintained insured-liabilities aggregate equals the derivation
  // over the supplied records. (The fund's fundCashRubars IS the
  // segregated account's balance — one doc, one balance; the
  // aggregate-vs-ledger discipline for fund cash discharges
  // per-event through the settlement bridge + bijection over
  // institutionAccount lines.)
  if (records.fund) {
    // The insured-liabilities derivation, implemented HERE a second
    // time on purpose: this module shares no code path with the
    // handlers or the pure finance layer (that independence is the
    // check's value). Coverage: fund existed at the deposit's open
    // seq (grandfathering election "none" — pre-founding deposits
    // are never covered), depositor is not the bank's owner
    // (insider exclusion), deposit not opened inside one of the
    // bank's Log-derived suspension intervals, status active;
    // basis = principal + credited.
    const fund = records.fund;
    const establishedAtSeq = num(fund.establishedAtSeq);
    const ownerByBank = new Map<string, string>();
    for (const corp of records.corporations) {
      if (typeof corp.corporationId === "string" && typeof corp.ownerMemberId === "string") {
        ownerByBank.set(corp.corporationId, corp.ownerMemberId);
      }
    }
    let derived = 0;
    for (const deposit of records.deposits) {
      if (deposit.status !== "active") continue;
      const bankId = typeof deposit.bankCorporationId === "string" ? deposit.bankCorporationId : "";
      const owner = ownerByBank.get(bankId);
      if (owner === undefined) continue;
      const depositor = deposit.depositor as { kind?: unknown; memberId?: unknown } | undefined;
      if (depositor && depositor.kind === "personal" && depositor.memberId === owner) continue;
      if (num(deposit.openedAtSeq) < establishedAtSeq) continue;
      const intervals = records.suspensionIntervalsByBank?.get(bankId) ?? [];
      const openedAtSeq = num(deposit.openedAtSeq);
      const suspended = intervals.some(
        (i) => openedAtSeq >= i.fromSeq && (i.toSeq === null || openedAtSeq < i.toSeq)
      );
      if (suspended) continue;
      derived += num(deposit.principalRubars) + num(deposit.creditedInterestRubars);
    }
    if (num(records.fund.totalInsuredLiabilitiesRubars) !== derived) {
      push(
        "A_B6_INSURED_AGGREGATE",
        `deposit insurance fund: totalInsuredLiabilitiesRubars ${num(records.fund.totalInsuredLiabilitiesRubars)} != insured-liabilities derivation ${derived} (A-B6)`
      );
    }
    if (num(records.fund.fundCashRubars) < 0) {
      push("NEGATIVE_BALANCE", "deposit insurance fund holds negative fund cash");
    }
  }

  return { ok: findings.length === 0, findings };
}

/** Convenience: per-event checks + standing assertions in one call. */
export function checkConservation(
  events: ConservationEvent[],
  records: ConservationRecords
): { ok: boolean; findings: ConservationFinding[]; summaries: EventConservationSummary[] } {
  const findings: ConservationFinding[] = [];
  const summaries: EventConservationSummary[] = [];
  for (const event of events) {
    const result = checkConservationEvent(event, { loans: records.loans });
    findings.push(...result.findings);
    summaries.push(result.summary);
  }
  findings.push(...checkStandingRecords(records).findings);
  return { ok: findings.length === 0, findings, summaries };
}
