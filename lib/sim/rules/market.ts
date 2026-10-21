/**
 * The Market family (Phase 4 step 7): M-00 … M-12 — listing, issuance
 * and float, order placement, in-event matching + settlement (M-04),
 * cancel/expiry, repricing (M-06), suspend/resume, distributions,
 * buybacks, liquidation, the fail-closed correction path, and the
 * publication stub — over the pure engine in `lib/market/*`, the
 * record shapes in `lib/sim/marketRecords.ts`, Module 0's corporation
 * record, and Finance's ledgers + transfer primitive.
 *
 * Governing texts: market-systems-spec.md (M-01–M-12, §§1.5–1.8, 2.2,
 * 3, 4, 5), phase4-implementation-brief.md §7.3,
 * phase4-build-prep-report.md (P4-K18 valuation discipline, P4-K21
 * custody + share conservation, P4-K22 listed cash-leg routing,
 * P4-K25 undo lock classes), finance-system-design.md (§§1–3, 5).
 * Design record: workstreams/p4-market-prep-report.md (D-1…D-8).
 *
 * The Build Lead registers MARKET_DESCRIPTORS into RULE_DESCRIPTORS
 * and folds MARKET_FINANCE_ADDITIONS onto them (finance §2.4) — the
 * Finance/Catalogue assembly pattern; this file never edits the
 * registry. MARKET_UNDO_CLASSES ships beside them for Phase 7's undo
 * pass (P4-K25: the descriptors carry the class from day one; the
 * registry's RuleDescriptor type gains the field at assembly).
 *
 * Discipline (inherited from Finance/Catalogue II, binding here):
 *  - The market is the NYSE-like operator, not a participant with
 *    opinions: mechanics are published code; the only judgment is the
 *    M-06 Quality/Scale/Importance scoring, which arrives ONLY via
 *    the worker-prepared payload bound at preview (F-07 pattern) or
 *    is carried from the corporation record's `lastJudgment`. An
 *    action naming its own scores is a fairness breach, never an
 *    input — score fields in structuredAction are never read.
 *  - Custody float (P4-K21(i)): float shares stay in the founder's
 *    holding as committed shares behind a standing float-offer order;
 *    the Market Maker holds NO share inventory; float sales credit
 *    the founder; only fees reach the Market Account.
 *  - Every money movement composes through applyTransferLines, so
 *    every event this module produces is conservation-checkable under
 *    the finance checker's grammar unchanged. Change grammar: cash
 *    legs ride the entries finance's grammar assigns them (personal /
 *    market legs on null-city entries, company legs on the home-city
 *    entry, treasury legs on the creditor city's entry); market
 *    record changes (listings/holdings/orders/trades) ride null-city
 *    entries under `marketListings/…`, `holdings/…`, `marketOrders/…`,
 *    `marketTrades/…` spellings.
 *  - Shares are economic-only (OPEN-5 default): a holding confers
 *    distributions and liquidation proceeds pro-rata and the right to
 *    sell — never operating control. Owner-only verbs read
 *    `ownerMemberId` (A-7) and nothing else; a 90% holder who is not
 *    the owner is refused exactly like any other non-owner.
 *  - Valuation discipline (P4-K18): M-06 is the only writer of a
 *    listed company's reference price and of the `valuationRubars`
 *    market-cap cache. Its inputs are a CLOSED list assembled by
 *    `assembleCodedInputs`; `legacyBookRubars` is structurally absent
 *    from that list (P4-G6) — it is provenance, never an input.
 *  - The step cap is LOCKED at ±25% per Resolution Event (Vera's
 *    stat-model lock, §4.7), with exactly two exceptions: dissolution
 *    and a tier-2 case opening against the company itself. Capped
 *    moves log the uncapped figure beside the applied one; the
 *    difference is never carried forward (no shadow prices).
 *  - No invented figures: an unset earnings proxy skips its term and
 *    the skip is logged; an unjudged company is never repriced; a
 *    halt whose coded condition still holds never resumes.
 */

import {
  MARKET_ACCOUNT_PATH,
  actorMemberId,
  cityPath,
  composeLazyOpen,
  ledgerBalance,
  ledgerDocPath,
  memberAccountPath,
  type LedgerRef,
} from "../../finance/accounts";
import {
  applyTransferLines,
  groupChangesByEntryCity,
  type TaggedChange,
  type TransferLine,
} from "../../finance/transfer";
import {
  MARKET_ACCOUNT_SEED_RUBARS,
  PRICE_FLOOR_RUBARS,
  applyStepCap,
  computeValuation,
  constituentFromListing,
  deriveRealmIndex,
  divisorBaseForGenesis,
  exchangeFeeRubars,
  marketMakerQuote,
  matchIncomingOrder,
  officialPriceRubars,
  roundHalfUp,
  type CodedValuationInputs,
  type Execution,
  type IncomingOrder,
  type JudgmentScores,
  type ListingSnapshot,
  type RestingOrder,
  type StepCapException,
} from "../../market";
import { corporationPath } from "../corporations";
import {
  buildHoldingDoc,
  buildListingDoc,
  buildMarketAccountDoc,
  buildOrderDoc,
  buildTradeDoc,
  floatOfferOrderId,
  freeShares,
  holdingPath,
  issuedShares,
  listingFloatShares,
  listingPath,
  liveShares,
  orderPath,
  retiredShares,
  tradePath,
  type MarketListingRecord,
  type MarketOrderRecord,
  type ShareHoldingRecord,
} from "../marketRecords";
import {
  docField,
  emptyPlan,
  snapshotDoc,
  type CollectionQuerySpec,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimAction,
  type SimChange,
  type SimSnapshot,
} from "../state";
import {
  fieldChange,
  planMutate,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import {
  type DescriptorReadPlan,
  type FinanceDescriptorAdditions,
  type HandlerContext,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";
import { isStructureFunctioning } from "./structures";

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — the family convention)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

function stringField(action: SimAction, field: string): string | null {
  const value = sa(action)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveAmount(action: SimAction, field: string): number | null {
  const value = sa(action)[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonNegativeAmount(action: SimAction, field: string): number | null {
  const value = sa(action)[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const intOr = (doc: Record<string, unknown> | null, field: string, fallback: number): number => {
  const value = num(doc, field);
  return value !== null && Number.isInteger(value) ? value : fallback;
};

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function actorCitations(plan: ResolutionPlan, ctx: HandlerContext): void {
  const citations = ctx.citations;
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${ctx.resolutionId}`);
}

/** NPC actors reject across the module in Phase 4: §1.9 lets a
 * mandated NPC trade inside its mandate's caps, but mandate fields
 * are Phase 5 machinery — until they land, a member confirms every
 * market act (the Finance posture, market spelling). */
function rejectNpc(ctx: HandlerContext, descriptorId: string): ResolutionPlan | null {
  if (ctx.action.actor.type !== "npc") return null;
  return rejectedPlan(
    descriptorId,
    "npc-mandate-unavailable",
    [descriptorId],
    `${descriptorId}: NPC market activity runs under Phase 5 mandate machinery (market-systems-spec §1.9 — mandate-named listings and Rubar caps), which has not landed; a member must confirm this act in Phase 4.`
  );
}

function finishPlan(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    ruleId: string;
    verb: string;
    scope: string;
    cityId: string | null;
    cityIds?: string[];
    summaryText: string;
    major?: boolean;
    extraClassification?: Record<string, unknown>;
  }
): ResolutionPlan {
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: args.verb,
        scope: args.scope,
        cityId: args.cityId,
        ruleIds: [args.ruleId],
        unruled: false,
        ...(args.extraClassification ?? {}),
      },
      cityId: args.cityId,
      cityIds: args.cityIds ?? (args.cityId ? [args.cityId] : []),
      ruleIds: [args.ruleId],
      summaryText: args.summaryText,
      major: args.major ?? false,
    })
  );
  actorCitations(plan, ctx);
  return plan;
}

/** Reconcile entries' record claims against the plan's actual write
 * ops (the Catalogue I/II convention). */
function pruneRecordClaims(plan: ResolutionPlan): void {
  const ops = new Map(plan.writes.map((w) => [w.path, w.op]));
  for (const entry of plan.entries) {
    const created = new Set<string>();
    const updated = new Set<string>();
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      const op = ops.get(path);
      if (op === "create") created.add(path);
      else if (op !== undefined) updated.add(path);
    }
    entry.recordsCreated = [...created];
    entry.recordsUpdated = [...updated];
  }
}

/** Push transfer-primitive changes as movement entries, grouped by
 * entry city (the Catalogue II idiom): cash legs land on the entries
 * finance's change grammar assigns them. */
function pushMovementEntries(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  ruleIds: string[],
  tagged: TaggedChange[],
  summaryFor: (entryCityId: string | null) => string,
  records?: { created?: string[]; updated?: string[] }
): void {
  const grouped = groupChangesByEntryCity(tagged);
  let first = true;
  for (const [entryCityId, changes] of grouped) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: entryCityId,
        cityIds: entryCityId ? [entryCityId] : [],
        ruleIds,
        changes,
        recordsCreated: first ? (records?.created ?? []) : [],
        recordsUpdated: first ? (records?.updated ?? []) : [],
        summaryText: summaryFor(entryCityId),
      })
    );
    first = false;
  }
}

// ---------------------------------------------------------------------------
// Change accumulation — one change record per (entry city, field
// spelling) per event, chained: `before` is the snapshot value at
// first touch, `after` tracks the final planned value. Market-record
// changes ride null-city entries (top-level docs, outside validatePlan's
// city chaining and the conservation checker's doc grammar — their
// evidence is the manifest writeSet); corporation changes ride the
// home-city entry under `corporations/<id>.<field>` spellings, where
// both validators DO chain them.
// ---------------------------------------------------------------------------

type ChangeAcc = Map<string, SimChange>;

function accChange(
  acc: ChangeAcc,
  entryCityId: string | null,
  field: string,
  before: unknown,
  after: unknown,
  formula: string
): void {
  const key = `${entryCityId ?? ""}|${field}`;
  const existing = acc.get(key);
  if (existing) {
    existing.after = after;
    return;
  }
  acc.set(key, fieldChange(field, before, after, formula));
}

function accChangesFor(acc: ChangeAcc, entryCityId: string | null): SimChange[] {
  const prefix = `${entryCityId ?? ""}|`;
  const out: SimChange[] = [];
  for (const [key, change] of acc) {
    if (key.startsWith(prefix)) out.push(change);
  }
  return out;
}

/** Record the planned mutation of one doc field into the accumulator:
 * reads the field's CURRENT planned value, applies the folded write,
 * and records the chained change. `entryCityId`/`field` are the Log
 * spelling; `path`/`docField` locate the write. */
function mutateField(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  acc: ChangeAcc,
  args: {
    path: string;
    docField: string;
    entryCityId: string | null;
    field: string;
    value: unknown;
    formula: string;
  }
): void {
  const current = plannedDoc(plan, snapshot, args.path);
  const before = current ? docField(current, args.docField) : null;
  planMutate(plan, snapshot, args.path, "state", [args.docField], (doc) => {
    if (!doc) return doc;
    return { ...doc, [args.docField]: args.value };
  });
  accChange(acc, args.entryCityId, args.field, before ?? null, args.value, args.formula);
}

// ---------------------------------------------------------------------------
// Snapshot query readers (F-01 materializations). Query ids are this
// family's; readers fall back to prefix enumeration over the snapshot's
// doc map, and return null where "no read was materialized" must be
// distinguishable from "the read was empty".
// ---------------------------------------------------------------------------

const BOOK_QUERY_ID = "market-book";
const HOLDINGS_QUERY_ID = "market-holdings";
const ACCOUNTS_QUERY_ID = "market-accounts";
const LISTINGS_QUERY_ID = "market-listings";
const STRUCTURES_QUERY_ID = "market-structures";
const CITIES_QUERY_ID = "market-cities";

function queryResultPaths(
  snapshot: SimSnapshot,
  id: string,
  collectionPath: string
): string[] | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === id && q.spec.collectionPath === collectionPath
  );
  if (record) return record.resultPaths;
  const prefix = `${collectionPath}/`;
  const paths = [...snapshot.docs.keys()].filter(
    (key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")
  );
  if (paths.length === 0) return null;
  return paths.sort();
}

function queryDocs(
  snapshot: SimSnapshot,
  id: string,
  collectionPath: string
): { path: string; doc: Record<string, unknown> }[] {
  const paths = queryResultPaths(snapshot, id, collectionPath) ?? [];
  const out: { path: string; doc: Record<string, unknown> }[] = [];
  for (const path of paths) {
    const doc = snapshotDoc(snapshot, path);
    if (doc) out.push({ path, doc });
  }
  return out;
}

const bookDocs = (snapshot: SimSnapshot) => queryDocs(snapshot, BOOK_QUERY_ID, "sim_market_orders");
const holdingDocs = (snapshot: SimSnapshot) => queryDocs(snapshot, HOLDINGS_QUERY_ID, "sim_holdings");
const accountDocs = (snapshot: SimSnapshot) =>
  queryDocs(snapshot, ACCOUNTS_QUERY_ID, "sim_member_accounts");
const allListingDocs = (snapshot: SimSnapshot) =>
  queryDocs(snapshot, LISTINGS_QUERY_ID, "sim_market_listings");
const structureDocs = (snapshot: SimSnapshot, cityId: string) =>
  queryDocs(snapshot, STRUCTURES_QUERY_ID, `sim_cities/${cityId}/structures`);
const cityDocs = (snapshot: SimSnapshot) => queryDocs(snapshot, CITIES_QUERY_ID, "sim_cities");

function bookQuery(corporationId: string): CollectionQuerySpec {
  return {
    id: BOOK_QUERY_ID,
    collectionPath: "sim_market_orders",
    filters: [
      { field: "corporationId", op: "==", value: corporationId },
      { field: "status", op: "==", value: "resting" },
    ],
  };
}

function holdingsQuery(corporationId: string): CollectionQuerySpec {
  return {
    id: HOLDINGS_QUERY_ID,
    collectionPath: "sim_holdings",
    filters: [{ field: "corporationId", op: "==", value: corporationId }],
  };
}

function accountsQuery(): CollectionQuerySpec {
  return { id: ACCOUNTS_QUERY_ID, collectionPath: "sim_member_accounts", filters: [] };
}

function listingsQuery(): CollectionQuerySpec {
  return { id: LISTINGS_QUERY_ID, collectionPath: "sim_market_listings", filters: [] };
}

function structuresQuery(cityId: string): CollectionQuerySpec {
  return { id: STRUCTURES_QUERY_ID, collectionPath: `sim_cities/${cityId}/structures`, filters: [] };
}

function citiesQuery(): CollectionQuerySpec {
  return { id: CITIES_QUERY_ID, collectionPath: "sim_cities", filters: [] };
}

// ---------------------------------------------------------------------------
// Standing-record readers (planned-aware where composition needs them)
// ---------------------------------------------------------------------------

function readListing(
  snapshot: SimSnapshot,
  corporationId: string
): MarketListingRecord | null {
  const doc = snapshotDoc(snapshot, listingPath(corporationId));
  if (!doc || typeof doc.corporationId !== "string") return null;
  return doc as unknown as MarketListingRecord;
}

function plannedListing(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  corporationId: string
): MarketListingRecord | null {
  const doc = plannedDoc(plan, snapshot, listingPath(corporationId));
  if (!doc || typeof doc.corporationId !== "string") return null;
  return doc as unknown as MarketListingRecord;
}

function readHolding(
  snapshot: SimSnapshot,
  memberId: string,
  corporationId: string
): ShareHoldingRecord | null {
  const doc = snapshotDoc(snapshot, holdingPath(memberId, corporationId));
  if (!doc || typeof doc.memberId !== "string") return null;
  return doc as unknown as ShareHoldingRecord;
}

function plannedHolding(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  memberId: string,
  corporationId: string
): ShareHoldingRecord | null {
  const doc = plannedDoc(plan, snapshot, holdingPath(memberId, corporationId));
  if (!doc || typeof doc.memberId !== "string") return null;
  return doc as unknown as ShareHoldingRecord;
}

/** The common listing-side gate: corporation + listing stand, the
 * corporation is listed and not dissolved, and the listing is not
 * delisted. Returns the records or a rejection plan. */
function requireListedCompany(
  ctx: HandlerContext,
  descriptorId: string,
  homeCityId: string,
  corporationId: string
): { corp: Record<string, unknown>; corpPath: string; listing: MarketListingRecord } | ResolutionPlan {
  const corpPath = corporationPath(homeCityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "company-not-found", [descriptorId], `${descriptorId}: no corporation record for ${corporationId} in ${homeCityId}.`);
  }
  if (corp.status === "dissolved") {
    return rejectedPlan(descriptorId, "company-dissolved", [descriptorId], `${descriptorId}: ${corporationId} is dissolved — no market act remains for it.`);
  }
  const listing = readListing(ctx.snapshot, corporationId);
  if (!listing || corp.listed !== true) {
    return rejectedPlan(descriptorId, "not-listed", [descriptorId], `${descriptorId}: ${corporationId} is not listed — listing is an M-01 act by its owner.`);
  }
  if (listing.status === "delisted" || listing.tradingStatus === "delisted") {
    return rejectedPlan(descriptorId, "listing-delisted", [descriptorId], `${descriptorId}: ${corporationId}'s listing was delisted at seq ${listing.delistedAtSeq ?? "unknown"} — its record and history stand, its market does not.`);
  }
  return { corp, corpPath, listing };
}

function isPlan(value: unknown): value is ResolutionPlan {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as ResolutionPlan).outcome !== undefined &&
    Array.isArray((value as ResolutionPlan).entries)
  );
}

/** The owner gate for listing-side verbs (A-7: `ownerMemberId` is the
 * one ownership fact validation may read). Shares confer no control
 * (OPEN-5): a non-owner holding 90% of the float is refused exactly
 * like any other non-owner. */
function requireOwner(
  ctx: HandlerContext,
  descriptorId: string,
  corp: Record<string, unknown>,
  corporationId: string
): string | ResolutionPlan {
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], `${descriptorId}: the actor carries no member identity — market acts are a named member's.`);
  }
  const ownerId = typeof corp.ownerMemberId === "string" ? corp.ownerMemberId : null;
  if (ownerId !== actorId) {
    return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `${descriptorId}: ${actorId} is not the owner of ${corporationId} — ownership is the record's ownerMemberId fact, and shareholdings confer economic rights only, never operating control (OPEN-5).`);
  }
  return actorId;
}

/** The prepared payload's market judgment (F-07 pattern, Catalogue II
 * idiom): `ctx.prepared.classification.judgment = { quality, scale,
 * importance }`, integers in [0, 100]. Read from nowhere else — a
 * judgment in the action itself is a fairness breach, not an input,
 * and is never consulted. */
function judgmentFromPrepared(ctx: HandlerContext): JudgmentScores | null {
  const classification = ctx.prepared?.classification as Record<string, unknown> | undefined;
  const judgment = classification?.judgment as Record<string, unknown> | undefined;
  if (!judgment) return null;
  const { quality, scale, importance } = judgment;
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;
  if (!valid(quality) || !valid(scale) || !valid(importance)) return null;
  return { quality, scale, importance };
}

function judgmentRationaleFromPrepared(ctx: HandlerContext): string | null {
  const classification = ctx.prepared?.classification as Record<string, unknown> | undefined;
  const rationale = classification?.judgmentRationale;
  return typeof rationale === "string" && rationale.length > 0 ? rationale : null;
}

/** Carried scores from the corporation record's `lastJudgment`
 * (M-06's carried path — scores stand until a judgment-bearing event
 * replaces them). Null when no judgment has ever stood. */
function carriedJudgment(corp: Record<string, unknown> | null): JudgmentScores | null {
  const last = corp?.lastJudgment as Record<string, unknown> | null | undefined;
  if (!last || typeof last !== "object") return null;
  const { quality, scale, importance } = last;
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;
  if (!valid(quality) || !valid(scale) || !valid(importance)) return null;
  return { quality, scale, importance };
}

function companyRef(cityId: string, corporationId: string): LedgerRef {
  return { kind: "company", corporationId, cityId };
}

function personalRef(memberId: string): LedgerRef {
  return { kind: "personal", memberId };
}

const MARKET_REF: LedgerRef = { kind: "market" };

/** Planned cash balance of a tracked ref (null when the ledger does
 * not stand in the planned state). */
function plannedBalance(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  ref: LedgerRef
): number | null {
  if (ref.kind === "exterior") return null;
  const path = ledgerDocPath(ref);
  if (!path) return null;
  return ledgerBalance(plannedDoc(plan, snapshot, path), ref);
}
