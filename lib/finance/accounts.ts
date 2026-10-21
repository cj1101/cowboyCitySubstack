/**
 * The finance account model (finance-system-design.md §1) — the tracked
 * ledgers every Phase 4 money movement reads and writes, over the shapes
 * Module 0 landed (corporation record: `lib/sim/corporations.ts`).
 *
 * Four tracked account classes (§1.1) and no fifth: characters and NPCs
 * hold no accounts (FIN-C7), guests hold none, households are the
 * Exterior (§1.3) — a flow counterparty with named scopes and NO stored
 * balance, so no Exterior stock is ever seeded from an uncounted
 * population. Tracked-cash figures in this module are always labeled as
 * tracked: the realm's money also exists as Exterior flows, and no
 * surface built on these types may present a tracked sum as "all the
 * money there is" (guardrail: tracked-cash labeling).
 *
 * This module owns: the LedgerRef grammar, the personal account record
 * (F-01, §1.2), and the lazy-open composer (§1.4) every money-touching
 * handler runs as step 0. Handlers live in `lib/sim/rules/finance.ts`;
 * movement validation lives in `./transfer.ts`.
 */

import {
  docField,
  snapshotDoc,
  type ResolutionPlan,
  type SimActor,
  type SimSnapshot,
} from "../sim/state";
import { fieldChange, planWrite, ruleEffectDraft } from "../sim/rules/planHelpers";

/** The locked genesis grant (market N-1, finance §3.3's closed mint
 * list): identical for every member, whenever they join. */
export const GENESIS_GRANT_RUBARS = 250_000;

/** finance §2.1's LedgerRef, with one additive field: a company ref
 * carries its home `cityId` because the corporation record's path is
 * city-rooted (`sim_cities/{cityId}/corporations/{corporationId}`) and
 * a ref that cannot resolve to its record cannot be validated. */
export type LedgerRef =
  | { kind: "personal"; memberId: string }
  | { kind: "treasury"; cityId: string }
  | { kind: "company"; corporationId: string; cityId: string }
  | { kind: "market" }
  | { kind: "exterior"; scope: string };

export type TrackedLedgerRef = Exclude<LedgerRef, { kind: "exterior" }>;

/** Exterior scopes (§1.3): a city's resident economy, realm-level
 * public works, or trade beyond the realm where a rule names it. */
export function householdsScope(cityId: string): string {
  return `households:${cityId}`;
}
export const EXTERIOR_REALM_PUBLIC = "realm-public";
export const EXTERIOR_OUTSIDE_REALM = "outside-realm";

export function isExteriorScope(scope: string): boolean {
  return (
    scope === EXTERIOR_REALM_PUBLIC ||
    scope === EXTERIOR_OUTSIDE_REALM ||
    /^households:[^:]+$/.test(scope)
  );
}

// ---------------------------------------------------------------------------
// Paths and field spellings — the one grammar finance changes[] use.
// City-rooted changes (`stats.treasuryRubars`,
// `corporations/<id>.companyCashRubars`) chain through validatePlan /
// TC-E02 against the city doc's subcollections. Personal-account and
// bank-deposit docs are top-level collections, so their changes ride
// entries with `cityId: null` (validatePlan and TC-E02 skip null-city
// entries by design); their evidence is the conservation checker
// (./conservation.ts) plus the manifest writeSet before/after docs.
// ---------------------------------------------------------------------------

export function memberAccountPath(memberId: string): string {
  return `sim_member_accounts/${memberId}`;
}

export function cityPath(cityId: string): string {
  return `sim_cities/${cityId}`;
}

export function bankDepositPath(depositId: string): string {
  return `sim_bank_deposits/${depositId}`;
}

/** The Market Account's record: the singleton doc of finance §1.1's
 * `sim_market_account` collection. The Market module (Phase 4 step 7)
 * owns the record's shape and its founding act (M-00); this const is
 * its path, landed here because the ledger grammar lives here. */
export const MARKET_ACCOUNT_PATH = "sim_market_account/main";

/** The doc path a tracked ref resolves to. The Market Account resolved
 * to null until step 7 landed its record (finance never wrote it);
 * with the record standing at MARKET_ACCOUNT_PATH, market refs
 * resolve like every other tracked ledger. */
export function ledgerDocPath(ref: TrackedLedgerRef): string | null {
  switch (ref.kind) {
    case "personal":
      return memberAccountPath(ref.memberId);
    case "treasury":
      return cityPath(ref.cityId);
    case "company":
      return `sim_cities/${ref.cityId}/corporations/${ref.corporationId}`;
    case "market":
      return MARKET_ACCOUNT_PATH;
  }
}

/** The balance field inside the ref's doc. */
export function ledgerBalanceField(ref: TrackedLedgerRef): string {
  switch (ref.kind) {
    case "personal":
      return "cashRubars";
    case "treasury":
      return "stats.treasuryRubars";
    case "company":
      return "companyCashRubars";
    case "market":
      return "cashRubars";
  }
}

/** The `changes[]` field spelling for a ref's balance, relative to the
 * entry that carries it (see the grammar note above). */
export function ledgerChangeField(ref: TrackedLedgerRef): string {
  switch (ref.kind) {
    case "personal":
      return `memberAccounts/${ref.memberId}.cashRubars`;
    case "treasury":
      return "stats.treasuryRubars";
    case "company":
      return `corporations/${ref.corporationId}.companyCashRubars`;
    case "market":
      return "marketAccount.cashRubars";
  }
}

/** The entry `cityId` a ref's balance change rides on: city-rooted
 * ledgers carry their city; personal/market changes ride null-city
 * entries (top-level docs, outside TC-E02's city chaining). */
export function ledgerEntryCityId(ref: TrackedLedgerRef): string | null {
  switch (ref.kind) {
    case "treasury":
      return ref.cityId;
    case "company":
      return ref.cityId;
    default:
      return null;
  }
}

export function ledgerLabel(ref: LedgerRef): string {
  switch (ref.kind) {
    case "personal":
      return `personal account of ${ref.memberId}`;
    case "treasury":
      return `treasury of ${ref.cityId}`;
    case "company":
      return `company ${ref.corporationId}`;
    case "market":
      return "the Market Account";
    case "exterior":
      return `the Exterior (${ref.scope})`;
  }
}

/** Current tracked balance of a ref in a doc source (snapshot or a
 * planned after-doc): a finite number, or null when the ledger does
 * not stand / carries no balance figure. */
export function ledgerBalance(
  doc: Record<string, unknown> | null,
  ref: TrackedLedgerRef
): number | null {
  if (!doc) return null;
  const value = docField(doc, ledgerBalanceField(ref));
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The personal account record (finance §1.2) — F-01's shape.
// ---------------------------------------------------------------------------

export interface GenesisGrantBlock {
  amountRubars: number;
  /** Seq of this account's genesis entry (prospective at plan time:
   * `counterHead.lastSeq + 1 + entryIndex`, the preview.ts parity
   * convention — preview and commit allocate identical seqs). */
  grantedAtSeq: number;
  /** Path of the Log entry that minted the grant — the audit anchor. */
  grantEntryId: string;
}

export interface MemberAccountRecord {
  memberId: string;
  cashRubars: number;
  status: "open" | "closed";
  genesisGrant: GenesisGrantBlock | null;
  openedAtSeq: number;
  openedVia: string; // "explicit" | "lazy:<actionKind>"
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: unknown; // committer-stamped (plans are clock-free)
  updatedAt: unknown;
}

export function memberAccountOf(
  doc: Record<string, unknown> | null
): MemberAccountRecord | null {
  if (!doc || typeof doc.memberId !== "string") return null;
  return doc as unknown as MemberAccountRecord;
}

/** The entry doc path the committer will give seq `seq`
 * (`sim_log_entries/{seq zero-padded to 12}` — committer.ts). */
export function logEntryPath(seq: number): string {
  return `sim_log_entries/${String(seq).padStart(12, "0")}`;
}

/**
 * The F-01 opening doc (§1.2 shape). The grant is written in the same
 * transaction as the account — `genesisGrant` is never observable null
 * on an open account. `createdAt`/`updatedAt` are null placeholders:
 * the committer stamps both inside the transaction (plans are
 * clock-free so preview and commit hash identically).
 */
export function buildMemberAccountDoc(args: {
  memberId: string;
  openedVia: string;
  openedAtSeq: number;
  grantEntryId: string;
}): Record<string, unknown> {
  const record: MemberAccountRecord = {
    memberId: args.memberId,
    cashRubars: GENESIS_GRANT_RUBARS,
    status: "open",
    genesisGrant: {
      amountRubars: GENESIS_GRANT_RUBARS,
      grantedAtSeq: args.openedAtSeq,
      grantEntryId: args.grantEntryId,
    },
    openedAtSeq: args.openedAtSeq,
    openedVia: args.openedVia,
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdAt: null,
    updatedAt: null,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Lazy open (finance §1.4) — step 0 of every money-touching action.
// ---------------------------------------------------------------------------

export interface LazyOpenOutcome {
  /** True when this plan opened (or reopened) the account. */
  opened: boolean;
  /** True when the genesis grant was minted by this opening. A reopen
   * of a closed account never re-grants (§1.4). */
  granted: boolean;
  accountPath: string;
}

/**
 * Compose F-01 into `plan` for `memberId` if the account does not stand
 * open: creates the account doc with its genesis grant (a mint line
 * from §3.3's closed list — the grant is a mint event, NOT a transfer
 * from the Exterior) or reopens a closed account without a second
 * grant. The genesis entry is pushed onto `plan.entries` at call time,
 * so callers invoke this BEFORE composing the action's own entries —
 * the grant is ordered before the action's own lines (§1.4), and the
 * entry's prospective seq (`counterHead.lastSeq + 1 + index`) is exact
 * because entries allocate seqs in plan order at commit.
 *
 * Exactly-once is the account doc's existence + `genesisGrant` block:
 * an open account composes nothing. Callers validate the rest of the
 * action against the PLANNED doc (planHelpers.plannedDoc) and simply
 * discard the plan if the action rejects — a rejected plan commits
 * nothing, grant included.
 */
export function composeLazyOpen(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  actor: SimActor;
  memberId: string;
  /** The action kind whose step 0 this is ("explicit" for the F-01
   * action itself). */
  viaActionKind: string;
}): LazyOpenOutcome {
  const { plan, snapshot, memberId } = args;
  const accountPath = memberAccountPath(memberId);
  const existing = snapshotDoc(snapshot, accountPath);
  if (existing) {
    const account = memberAccountOf(existing);
    if (account && account.status === "open") {
      return { opened: false, granted: false, accountPath };
    }
    if (account && account.status === "closed") {
      // Reopen without a second grant: the doc (and its genesisGrant
      // block) persists; only the status flips (§1.4).
      planWrite(
        plan,
        snapshot,
        accountPath,
        { ...existing, status: "open" },
        "state",
        ["status"]
      );
      plan.entries.push(
        ruleEffectDraft({
          actor: args.actor,
          ruleIds: ["F-01"],
          changes: [
            fieldChange(
              `memberAccounts/${memberId}.status`,
              "closed",
              "open",
              "F-01 reopen (no second genesis grant — §1.4)"
            ),
          ],
          recordsUpdated: [accountPath],
          summaryText: `F-01: personal account of ${memberId} reopened; the original genesis grant stands — no second grant.`,
        })
      );
      return { opened: true, granted: false, accountPath };
    }
  }

  const entryIndex = plan.entries.length;
  const openedAtSeq = snapshot.counterHead.lastSeq + 1 + entryIndex;
  const grantEntryId = logEntryPath(openedAtSeq);
  const openedVia =
    args.viaActionKind === "explicit" ? "explicit" : `lazy:${args.viaActionKind}`;
  const doc = buildMemberAccountDoc({
    memberId,
    openedVia,
    openedAtSeq,
    grantEntryId,
  });
  planWrite(plan, snapshot, accountPath, doc, "state", [
    "cashRubars",
    "genesisGrant",
    "status",
    "openedVia",
  ]);
  plan.entries.push(
    ruleEffectDraft({
      kind: "genesis",
      actor: args.actor,
      ruleIds: ["F-01"],
      changes: [
        fieldChange(
          `memberAccounts/${memberId}.cashRubars`,
          null,
          GENESIS_GRANT_RUBARS,
          "F-01 genesis grant (mint, finance §3.3 closed list)"
        ),
        // The mint leg the conservation checker balances the cash
        // change against (grammar in ./transfer.ts).
        fieldChange("mint:F-01", 0, GENESIS_GRANT_RUBARS, "mint leg — genesis grant"),
      ],
      recordsCreated: [accountPath],
      summaryText: `F-01: personal account opened for ${memberId} (${openedVia}); genesis grant of ${GENESIS_GRANT_RUBARS} R minted under finance §3.3's closed list.`,
    })
  );
  return { opened: true, granted: true, accountPath };
}

/** The member id an actor acts as (themselves, or their principal for
 * delegated actors). Money/authority reads key off this — never off
 * citations (Step 0 discipline). */
export function actorMemberId(actor: SimActor): string | null {
  return actor.memberId ?? actor.onBehalfOfMemberId ?? null;
}
