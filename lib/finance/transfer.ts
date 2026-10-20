/**
 * The transfer primitive (finance-system-design.md §2.1) — the ONE
 * place money movement is validated and applied. Every Rubar movement
 * in every rule (F-rules here; M-rules and R-spends as they land) is
 * composed of transfer lines through this module; handlers never move a
 * balance by hand.
 *
 * A line is data inside a rule's plan, never a player action:
 *   { from, to, amountRubars, ruleId, memo }
 *
 * Validation (§2.1, implemented once):
 *  1. amountRubars is a positive integer. Zero-amount lines are
 *     dropped with a logged skip note (see `droppedLines`), never
 *     written as movements.
 *  2. Both endpoints resolve to existing accounts. Personal accounts
 *     lazy-open BEFORE the action's own lines validate (accounts.ts
 *     composeLazyOpen, run by handlers as step 0), so existence here is
 *     a hard fact, not a hope.
 *  3. from ≠ to for tracked ledgers (a self-line is a plan defect);
 *     Exterior→Exterior lines are forbidden outright.
 *  4. Sufficient funds, netted per tracked account across the event's
 *     lines. The primitive computes; whether a shortfall rejects or
 *     partially funds is the authorizing rule's shortfall CLASS (§2.2,
 *     FIN-C2 — `transfer` refuses in full, `budget` partially funds a
 *     caller-trimmed line set, `custodial` refuses in full against
 *     UNENCUMBERED cash). Undeclared = transfer (§2.2).
 *  5. Every line lands in the event's Log entries as changes[] records
 *     with before/after for tracked endpoints and the Exterior scope
 *     named for exterior endpoints (§2.1.5). The change grammar:
 *       tracked personal  → `memberAccounts/<id>.cashRubars` (null-city entry)
 *       tracked treasury  → `stats.treasuryRubars` (city entry)
 *       tracked company   → `corporations/<id>.companyCashRubars` (city entry)
 *       exterior leg      → `exterior:<scope>` (null-city entry;
 *                           before 0, after = signed net flow INTO the
 *                           tracked system from that scope in this event)
 *       mint leg          → `mint:<ruleId>` (before 0, after = minted)
 *       burn leg          → `burn:<ruleId>` (before 0, after = burned)
 *     The conservation checker (./conservation.ts) balances events from
 *     exactly these records plus the manifest writeSet.
 *
 * Banking branch (§2.5 of the banking amendment, FIN-C2's custodial
 * class): a chartered bank's spends validate against UNENCUMBERED cash
 * (cash − deposit liabilities − liquid reserve), never the raw
 * balance. That is one branch here, keyed on the charter block's
 * presence — not a per-handler habit. An unchartered company is
 * untouched by it.
 */

import {
  docField,
  withDocField,
  type ResolutionPlan,
  type SimChange,
  type SimSnapshot,
} from "../sim/state";
import { planMutate, plannedDoc } from "../sim/rules/planHelpers";
import {
  ledgerBalance,
  ledgerBalanceField,
  ledgerChangeField,
  ledgerDocPath,
  ledgerEntryCityId,
  ledgerLabel,
  type LedgerRef,
  type TrackedLedgerRef,
} from "./accounts";
import { bankBlockOf, unencumberedCash } from "./banking";

export type ShortfallClass = "transfer" | "budget" | "custodial";

/** Descriptor metadata finance adds to the Phase 2 registry contract
 * (§2.4): carried in FINANCE_DESCRIPTOR_META (rules/finance.ts) since
 * the registry's RuleDescriptor type is the Lead's to extend. */
export interface FinanceDescriptorMeta {
  shortfallClass: ShortfallClass | "none";
  ledgersTouched: string[];
  invokesRules: string[];
}

export interface TransferLine {
  from: LedgerRef;
  to: LedgerRef;
  amountRubars: number;
  ruleId: string;
  memo: string;
}

export interface TaggedChange {
  /** Entry cityId the change rides on (null = top-level-doc entry). */
  entryCityId: string | null;
  change: SimChange;
}

export type TransferValidation =
  | { ok: true; changes: TaggedChange[]; droppedLines: TransferLine[] }
  | {
      ok: false;
      code: string;
      /** The ledger whose spendable balance fell short, when the
       * failure is a shortfall (drives the rejection's stated figure). */
      shortfall?: {
        ref: TrackedLedgerRef;
        availableRubars: number;
        requiredRubars: number;
        surface: "balance" | "unencumbered";
      };
      message: string;
    };

function sameLedger(a: LedgerRef, b: LedgerRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "personal":
      return a.memberId === (b as { memberId: string }).memberId;
    case "treasury":
      return a.cityId === (b as { cityId: string }).cityId;
    case "company":
      return a.corporationId === (b as { corporationId: string }).corporationId;
    case "market":
      return true;
    case "exterior":
      return a.scope === (b as { scope: string }).scope;
  }
}

/** The spendable surface for a tracked source ledger, read from the
 * PLANNED doc: raw balance normally; unencumbered cash for a chartered
 * bank's company ledger (banking §2.5's one branch). */
export function spendableSurface(
  doc: Record<string, unknown> | null,
  ref: TrackedLedgerRef
): { available: number | null; surface: "balance" | "unencumbered" } {
  const balance = ledgerBalance(doc, ref);
  if (balance === null) return { available: null, surface: "balance" };
  if (ref.kind === "company") {
    const bank = bankBlockOf(doc);
    if (bank && bank.status === "active") {
      return { available: unencumberedCash(doc), surface: "unencumbered" };
    }
  }
  return { available: balance, surface: "balance" };
}

/**
 * Validate a set of lines as ONE event and, when valid, fold their
 * balance writes into the plan, returning the changes[] records (with
 * entry-city tags) for the handler to distribute across its entries.
 *
 * Funds are checked on NET per-account deltas (§2.1.4) against the
 * spendable surface, but a custodial-class event additionally requires
 * each custodial source's GROSS outflow to fit its surface: custodial
 * money is other people's, and netting a withdrawal against a same-
 * event inflow would spend a claim before it settles. (In the Phase 4
 * slice every custodial event is a single line; the gross rule is the
 * conservative reading and costs nothing.)
 *
 * On failure nothing is written — the caller returns the rejection and
 * discards the plan (any step-0 lazy-open writes included).
 */
export function applyTransferLines(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  lines: TransferLine[];
  shortfallClass: ShortfallClass;
}): TransferValidation {
  const { plan, snapshot } = args;
  const droppedLines: TransferLine[] = [];
  const lines: TransferLine[] = [];
  for (const line of args.lines) {
    if (line.amountRubars === 0) {
      droppedLines.push(line);
      continue;
    }
    lines.push(line);
  }

  // -- Structural validation (§2.1.1–2.1.3) ------------------------------
  for (const line of lines) {
    if (!Number.isInteger(line.amountRubars) || line.amountRubars < 0) {
      return {
        ok: false,
        code: "MALFORMED_LINE",
        message: `transfer line under ${line.ruleId} carries amountRubars ${line.amountRubars} — a positive integer is required.`,
      };
    }
    if (line.from.kind === "exterior" && line.to.kind === "exterior") {
      return {
        ok: false,
        code: "EXTERIOR_TO_EXTERIOR",
        message: `transfer line under ${line.ruleId} moves money between two Exterior scopes — not a sim event (§2.1.3).`,
      };
    }
    if (line.from.kind !== "exterior" && line.to.kind !== "exterior" && sameLedger(line.from, line.to)) {
      return {
        ok: false,
        code: "SELF_TRANSFER",
        message: `transfer line under ${line.ruleId} names ${ledgerLabel(line.from)} as both endpoints — a plan defect (§2.1.3).`,
      };
    }
    for (const ref of [line.from, line.to]) {
      if (ref.kind === "market") {
        return {
          ok: false,
          code: "MARKET_LEDGER_UNAVAILABLE",
          message: `transfer line under ${line.ruleId} names the Market Account, whose ledger the Market module owns — finance Phase 4 lines never touch it.`,
        };
      }
    }
  }

  // -- Endpoint existence + netting (§2.1.2, §2.1.4) ----------------------
  interface LedgerWork {
    ref: TrackedLedgerRef;
    path: string;
    before: number;
    net: number;
    grossOut: number;
  }
  const work = new Map<string, LedgerWork>();
  const workFor = (ref: TrackedLedgerRef): LedgerWork | { error: TransferValidation } => {
    const path = ledgerDocPath(ref);
    if (!path) {
      return {
        error: {
          ok: false,
          code: "LEDGER_UNRESOLVABLE",
          message: `${ledgerLabel(ref)} does not resolve to a record.`,
        },
      };
    }
    const key = path;
    const existing = work.get(key);
    if (existing) return existing;
    const doc = plannedDoc(plan, snapshot, path);
    const before = ledgerBalance(doc, ref);
    if (before === null) {
      return {
        error: {
          ok: false,
          code: "LEDGER_NOT_FOUND",
          message: `${ledgerLabel(ref)} does not stand (no record at ${path}, or no balance figure on it).`,
        },
      };
    }
    const entry: LedgerWork = { ref, path, before, net: 0, grossOut: 0 };
    work.set(key, entry);
    return entry;
  };

  const exteriorFlows = new Map<string, number>(); // scope -> net INTO tracked
  for (const line of lines) {
    if (line.from.kind !== "exterior") {
      const w = workFor(line.from);
      if ("error" in w) return w.error;
      w.net -= line.amountRubars;
      w.grossOut += line.amountRubars;
    } else {
      // Exterior -> tracked: the flow runs INTO the tracked system.
      exteriorFlows.set(line.from.scope, (exteriorFlows.get(line.from.scope) ?? 0) + line.amountRubars);
    }
    if (line.to.kind !== "exterior") {
      const w = workFor(line.to);
      if ("error" in w) return w.error;
      w.net += line.amountRubars;
    } else {
      // Tracked -> Exterior: the flow runs OUT of the tracked system.
      exteriorFlows.set(line.to.scope, (exteriorFlows.get(line.to.scope) ?? 0) - line.amountRubars);
    }
  }

  // -- Funds (§2.1.4 + the class semantics of §2.2 / banking §2.5) --------
  for (const w of work.values()) {
    if (w.net >= 0) continue;
    const doc = plannedDoc(plan, snapshot, w.path);
    const { available, surface } = spendableSurface(doc, w.ref);
    if (available === null) {
      return {
        ok: false,
        code: "LEDGER_NOT_FOUND",
        message: `${ledgerLabel(w.ref)} does not stand.`,
      };
    }
    const required =
      args.shortfallClass === "custodial" ? w.grossOut : -w.net;
    // Even a net-creditor event may not drive the raw balance negative
    // mid-netting for a bank: the unencumbered surface is the bank's
    // spendable truth, and the net position must respect it too.
    const netRequired = -w.net;
    if (required > available || (surface === "unencumbered" && netRequired > available)) {
      return {
        ok: false,
        code:
          surface === "unencumbered" ? "INSUFFICIENT_UNENCUMBERED" : "INSUFFICIENT_FUNDS",
        shortfall: {
          ref: w.ref,
          availableRubars: available,
          requiredRubars: Math.max(required, netRequired),
          surface,
        },
        message:
          surface === "unencumbered"
            ? `${ledgerLabel(w.ref)} holds ${available} R of unencumbered cash (cash minus deposit liabilities minus liquid reserve); the movement requires ${Math.max(required, netRequired)} R.`
            : `${ledgerLabel(w.ref)} holds ${available} R; the movement requires ${Math.max(required, netRequired)} R.`,
      };
    }
  }

  // -- Apply: fold one write per ledger doc, changes chained off the
  //    planned doc (F-02 discipline) --------------------------------------
  const changes: TaggedChange[] = [];
  for (const w of work.values()) {
    if (w.net === 0) continue;
    const field = ledgerBalanceField(w.ref);
    const after = w.before + w.net;
    planMutate(plan, snapshot, w.path, "state", [field], (current) => {
      if (!current) return current;
      return withDocField(current, field, after);
    });
    changes.push({
      entryCityId: ledgerEntryCityId(w.ref),
      change: {
        field: ledgerChangeField(w.ref),
        before: w.before,
        after,
        formula: lineFormulaFor(args.lines, w.ref),
      },
    });
  }
  for (const [scope, netInto] of exteriorFlows) {
    if (netInto === 0) continue;
    changes.push({
      entryCityId: null,
      change: {
        field: `exterior:${scope}`,
        before: 0,
        after: netInto,
        formula: "Exterior flow leg (finance §1.3 — named scope, no stored balance)",
      },
    });
  }
  return { ok: true, changes, droppedLines };
}

function lineFormulaFor(lines: TransferLine[], ref: TrackedLedgerRef): string {
  const touching = lines.filter(
    (l) =>
      (l.from.kind !== "exterior" && sameLedger(l.from, ref)) ||
      (l.to.kind !== "exterior" && sameLedger(l.to, ref))
  );
  const parts = touching.map(
    (l) => `${l.ruleId}: ${l.memo} (${l.amountRubars} R)`
  );
  return parts.join("; ") || "transfer line";
}

/** Group tagged changes by entry city for handler entry assembly:
 * returns a map entryCityId ("" for null) -> SimChange[]. */
export function groupChangesByEntryCity(
  tagged: TaggedChange[]
): Map<string | null, SimChange[]> {
  const out = new Map<string | null, SimChange[]>();
  for (const t of tagged) {
    const list = out.get(t.entryCityId) ?? [];
    list.push(t.change);
    out.set(t.entryCityId, list);
  }
  return out;
}

/** Read a numeric doc field as an integer or null (validation helper
 * shared by the finance handlers). */
export function integerField(doc: Record<string, unknown> | null, field: string): number | null {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
