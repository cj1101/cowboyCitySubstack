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

// ---------------------------------------------------------------------------
// Field setting with change accumulation (skip-if-equal: an unchanged
// field produces neither a write nor a change record).
// ---------------------------------------------------------------------------

function setField(
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
  if (before === args.value) return;
  planMutate(plan, snapshot, args.path, "state", [args.docField], (doc) => {
    if (!doc) return doc;
    return { ...doc, [args.docField]: args.value };
  });
  accChange(acc, args.entryCityId, args.field, before ?? null, args.value, args.formula);
}

const corpField = (corporationId: string, field: string): string =>
  `corporations/${corporationId}.${field}`;
const listingField = (corporationId: string, field: string): string =>
  `marketListings/${corporationId}.${field}`;
const holdingField = (memberId: string, corporationId: string, field: string): string =>
  `holdings/${memberId}__${corporationId}.${field}`;
const orderField = (orderId: string, field: string): string =>
  `marketOrders/${orderId}.${field}`;

/** Fold a patch into an order record (planned-aware), accumulating one
 * change per touched field under the null-city `marketOrders/…`
 * spelling. Returns the after-state. */
function patchOrder(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  acc: ChangeAcc,
  orderId: string,
  patch: Partial<MarketOrderRecord>,
  formula: string
): MarketOrderRecord | null {
  const path = orderPath(orderId);
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return null;
  const after: Record<string, unknown> = { ...current };
  const changedFields: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (current[field] === value) continue;
    accChange(acc, null, orderField(orderId, field), current[field] ?? null, value, formula);
    after[field] = value;
    changedFields.push(field);
  }
  if (changedFields.length > 0) planWrite(plan, snapshot, path, after, "state", changedFields);
  return after as unknown as MarketOrderRecord;
}

/** Fold share deltas into a holding record (planned-aware), creating
 * it when `create` is set (first acquisition / issuance / backfill).
 * Cost basis moves only on acquisitions (§5.4: Σ trade price × qty
 * over acquisitions; sales never reduce it). Returns the after-state,
 * or null when the holding does not stand and may not be created. */
function mutateHolding(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  acc: ChangeAcc,
  args: {
    memberId: string;
    corporationId: string;
    homeCityId: string;
    deltaQuantity: number;
    deltaCommitted: number;
    deltaCostBasis: number;
    create: boolean;
    seq: number;
    resolutionId: string;
    now: Date;
    formula: string;
  }
): ShareHoldingRecord | null {
  const path = holdingPath(args.memberId, args.corporationId);
  const current = plannedDoc(plan, snapshot, path);
  if (!current && !args.create) return null;
  const base: Record<string, unknown> =
    current ??
    buildHoldingDoc({
      memberId: args.memberId,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      quantityShares: 0,
      committedShares: 0,
      costBasisRubars: 0,
      sourceActionId: args.resolutionId,
      sourceSeq: args.seq,
      lastResolutionId: args.resolutionId,
      now: args.now,
    });
  const beforeQty = intOr(base, "quantityShares", 0);
  const beforeCommitted = intOr(base, "committedShares", 0);
  const beforeBasis = intOr(base, "costBasisRubars", 0);
  const after: Record<string, unknown> = {
    ...base,
    quantityShares: beforeQty + args.deltaQuantity,
    committedShares: beforeCommitted + args.deltaCommitted,
    costBasisRubars: beforeBasis + args.deltaCostBasis,
    lastChangedSeq: args.seq,
    lastResolutionId: args.resolutionId,
    updatedAt: args.now,
  };
  planWrite(plan, snapshot, path, after, "state", [
    "quantityShares",
    "committedShares",
    "costBasisRubars",
  ]);
  if (args.deltaQuantity !== 0) {
    accChange(acc, null, holdingField(args.memberId, args.corporationId, "quantityShares"), current ? beforeQty : null, after.quantityShares, args.formula);
  }
  if (args.deltaCommitted !== 0) {
    accChange(acc, null, holdingField(args.memberId, args.corporationId, "committedShares"), current ? beforeCommitted : null, after.committedShares, args.formula);
  }
  if (args.deltaCostBasis !== 0) {
    accChange(acc, null, holdingField(args.memberId, args.corporationId, "costBasisRubars"), current ? beforeBasis : null, after.costBasisRubars, args.formula);
  }
  return after as unknown as ShareHoldingRecord;
}

// ---------------------------------------------------------------------------
// M-06 coded inputs — the CLOSED list (§4.3). Assembled from the
// PLANNED corporation doc (post the invoking event's own writes) and
// the home city's structure records. `legacyBookRubars` is never read
// here — it is structurally absent from CodedValuationInputs (P4-G6),
// and the harness proves the absence against this assembly.
// ---------------------------------------------------------------------------

export function assembleCodedInputs(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  corp: Record<string, unknown>,
  homeCityId: string
): { inputs: CodedValuationInputs; notes: string[] } {
  const notes: string[] = [];
  const linkedIds = strList(corp.linkedStructureIds);
  const structuresById = new Map<string, Record<string, unknown>>();
  for (const { path, doc } of structureDocs(snapshot, homeCityId)) {
    const planned = plannedDoc(plan, snapshot, path) ?? doc;
    if (planned && typeof planned.structureId === "string") {
      structuresById.set(planned.structureId, planned);
    }
  }
  let operatingStructureValueRubars = 0;
  let functioningCount = 0;
  for (const structureId of linkedIds) {
    const structure = structuresById.get(structureId);
    if (!structure) {
      notes.push(`linked structure ${structureId} not readable in this event's read plan — contributes 0`);
      continue;
    }
    if (isStructureFunctioning(structure)) {
      functioningCount += 1;
      const budget = num(structure, "totalBudgetRubars");
      if (budget === null || !Number.isInteger(budget)) {
        notes.push(`structure ${structureId} carries no recorded totalBudgetRubars — contributes 0`);
      } else {
        operatingStructureValueRubars += budget;
      }
    }
  }
  const downtimeFlag = linkedIds.length > 0 && functioningCount === 0;
  const earningsRaw = num(corp, "earningsProxyRubars");
  const earningsProxyRubars =
    earningsRaw !== null && Number.isInteger(earningsRaw) ? earningsRaw : null;
  const tierRaw = num(corp, "legalExposureTier");
  const legalExposureTier = (tierRaw === 0 || tierRaw === 1 || tierRaw === 2
    ? tierRaw
    : 0) as 0 | 1 | 2;
  const inputs: CodedValuationInputs = {
    companyCashRubars: intOr(corp, "companyCashRubars", 0),
    operatingStructureValueRubars,
    earningsProxyRubars,
    legalExposureTier,
    downtimeFlag,
    sharesOutstanding: liveShares(corp),
    operatingCitiesCount: strList(corp.marketCityIds).length + 1,
  };
  return { inputs, notes };
}

// ---------------------------------------------------------------------------
// Realm index (derived, never stored — §3). The divisor anchor is the
// one stored input, written once by the first positive-float listing.
// ---------------------------------------------------------------------------

function indexConstituents(
  plan: ResolutionPlan,
  snapshot: SimSnapshot
): { corporationId: string; officialPriceRubars: number; floatShares: number; tradingStatus: MarketListingRecord["tradingStatus"] }[] {
  const out = [];
  for (const { doc } of allListingDocs(snapshot)) {
    const planned = plannedDoc(plan, snapshot, listingPath(String(doc.corporationId))) ?? doc;
    const listing = planned as unknown as MarketListingRecord;
    out.push({
      corporationId: listing.corporationId,
      officialPriceRubars: listing.officialPriceRubars,
      floatShares: listingFloatShares(listing),
      tradingStatus: listing.tradingStatus,
    });
  }
  return out;
}

/** The derived index as a Log note — level, float cap, concentration
 * warnings (§3.4: warns, never trades). Null when no divisor anchor
 * stands (the level is then not a number anyone may quote). */
function indexNote(plan: ResolutionPlan, snapshot: SimSnapshot): string {
  const marketDoc = plannedDoc(plan, snapshot, MARKET_ACCOUNT_PATH);
  const anchor = num(marketDoc, "indexDivisorBaseRubars");
  if (anchor === null || anchor <= 0) {
    return "RCI: divisor unanchored (no positive-float listing has anchored the index) — no level is quoted.";
  }
  const constituents = indexConstituents(plan, snapshot).map((c) => ({
    corporationId: c.corporationId,
    officialPriceRubars: c.officialPriceRubars,
    floatShares: c.floatShares,
    tradingStatus: c.tradingStatus,
  }));
  const index = deriveRealmIndex(constituents, anchor);
  const warnings =
    index.concentrationWarnings.length > 0
      ? ` Concentration warning (>50% weight): ${index.concentrationWarnings.map((w) => `${w.corporationId} at ${(w.weight * 100).toFixed(1)}%`).join(", ")} — the cap warns; it does not trade, trim, or reweight (§3.4).`
      : "";
  return `RCI ${index.level.toFixed(2)} (total float market cap ${index.totalFloatMarketCapRubars} R over divisor base ${anchor} R).${warnings}`;
}

/** Anchor the index divisor on the first listing whose float makes the
 * total float market cap positive (§3.2: the genesis float cap IS the
 * divisor base, so the index reads exactly 1000.00 at that seq).
 * Returns a Log note when the anchor was set or deferred, else null. */
function maybeAnchorIndexDivisor(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  acc: ChangeAcc,
  genesisCorporationId: string
): string | null {
  const marketDoc = plannedDoc(plan, snapshot, MARKET_ACCOUNT_PATH);
  if (!marketDoc) {
    return "Index divisor not anchored: the Market Account does not stand (M-00 has not founded it) — the anchor waits for the first listing after it does.";
  }
  const existing = num(marketDoc, "indexDivisorBaseRubars");
  if (existing !== null && existing > 0) return null;
  const constituents = indexConstituents(plan, snapshot).filter(
    (c) => c.tradingStatus !== "delisted"
  );
  const total = constituents.reduce((sum, c) => sum + c.officialPriceRubars * c.floatShares, 0);
  if (total <= 0) {
    return "Index divisor not anchored: total float market cap is 0 (no positive float yet) — the anchor waits for the first positive-float listing (§3.2).";
  }
  const base = divisorBaseForGenesis(
    constituents.map((c) => ({
      corporationId: c.corporationId,
      officialPriceRubars: c.officialPriceRubars,
      floatShares: c.floatShares,
      tradingStatus: c.tradingStatus,
    }))
  );
  setField(plan, snapshot, acc, {
    path: MARKET_ACCOUNT_PATH,
    docField: "indexDivisorBaseRubars",
    entryCityId: null,
    field: "marketAccount.indexDivisorBaseRubars",
    value: base,
    formula: "M-01/§3.2: the genesis float market cap becomes the RCI divisor base",
  });
  setField(plan, snapshot, acc, {
    path: MARKET_ACCOUNT_PATH,
    docField: "genesisListingCorporationId",
    entryCityId: null,
    field: "marketAccount.genesisListingCorporationId",
    value: genesisCorporationId,
    formula: "M-01/§3.2: the listing whose event anchored the index divisor",
  });
  return `RCI divisor anchored at ${base} R (the genesis float market cap, §3.2) — the index reads 1000.00 at this seq.`;
}

// ---------------------------------------------------------------------------
// M-06 — repricing (resolver step; no action kinds). Composed in-event
// by the rules that change a listed company's coded inputs or invoke
// judgment: M-01 (opening), M-02, M-08, M-09 in this family, and — by
// Lead wiring — R-07's listed branches and structure/case events.
// Valuation discipline (P4-K18): this composer is the ONLY writer of
// a listed company's reference price and `valuationRubars` cache.
// ---------------------------------------------------------------------------

export interface MarketRepricingOutcome {
  status: "repriced" | "skipped";
  note: string;
  /** The closed coded-input list the formula consumed (null when
   * skipped before assembly). `legacyBookRubars` is structurally
   * absent from this object (P4-G6). */
  inputs: CodedValuationInputs | null;
  scoresUsed: JudgmentScores | null;
  judgmentSource: "prepared" | "carried" | null;
  uncappedPriceRubars: number | null;
  appliedPriceRubars: number | null;
  capApplied: boolean;
  officialPriceRubars: number | null;
  haltTransition: "halted-downtime" | "resumed" | null;
}

export function composeMarketRepricing(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  actor: HandlerContext["action"]["actor"];
  corporationId: string;
  homeCityId: string;
  /** Fresh judgment from the citing event's prepared payload, already
   * validated by the caller (integers 0..100). Null = not invoked:
   * carried scores stand (§4.7 step 2). */
  judgment: JudgmentScores | null;
  judgmentRationale: string | null;
  judgmentInputHash: string | null;
  stepCapException: StepCapException;
  invokedByRuleId: string;
}): MarketRepricingOutcome {
  const { plan, snapshot } = args;
  const corpPath = corporationPath(args.homeCityId, args.corporationId);
  const skipped = (note: string): MarketRepricingOutcome => {
    plan.entries.push(
      ruleEffectDraft({
        actor: args.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [args.invokedByRuleId, "M-06"],
        changes: [],
        summaryText: `M-06 repricing for ${args.corporationId} skipped: ${note}`,
      })
    );
    return {
      status: "skipped",
      note,
      inputs: null,
      scoresUsed: null,
      judgmentSource: null,
      uncappedPriceRubars: null,
      appliedPriceRubars: null,
      capApplied: false,
      officialPriceRubars: null,
      haltTransition: null,
    };
  };

  const corp = plannedDoc(plan, snapshot, corpPath);
  const listing = plannedListing(plan, snapshot, args.corporationId);
  if (!corp || corp.listed !== true || !listing || listing.status === "delisted") {
    return skipped("no standing listing record — repricing has nothing to price (never invented).");
  }
  const live = liveShares(corp);
  if (live <= 0) {
    return skipped("no live shares stand (issued − retired ≤ 0) — a per-share price cannot be computed.");
  }
  const carried = carriedJudgment(corp);
  const scores = args.judgment ?? carried;
  if (!scores) {
    return skipped("no judgment stands for this company (no prepared-payload judgment in the invoking event and no carried lastJudgment on the record) — the AI-as-market has never scored it, and scores are never invented.");
  }
  const judgmentSource: "prepared" | "carried" = args.judgment ? "prepared" : "carried";

  const { inputs, notes: inputNotes } = assembleCodedInputs(plan, snapshot, corp, args.homeCityId);
  const valuation = computeValuation(inputs, scores);
  const priorReference = listing.referencePriceRubars;
  const cap = applyStepCap(priorReference, valuation.uncappedReferencePriceRubars, args.stepCapException);
  const newReference = cap.appliedPriceRubars;
  const newOfficial = officialPriceRubars({
    referencePriceRubars: newReference,
    lastTradePriceRubars: listing.lastTradePriceRubars,
    tradedSinceLastRepricing: listing.tradedSinceLastRepricing,
  });

  const acc: ChangeAcc = new Map();
  const formula = `M-06 repricing invoked by ${args.invokedByRuleId} (§4.4 formula, §4.7 step cap ±25%)`;
  setField(plan, snapshot, acc, {
    path: listingPath(args.corporationId),
    docField: "referencePriceRubars",
    entryCityId: null,
    field: listingField(args.corporationId, "referencePriceRubars"),
    value: newReference,
    formula,
  });
  setField(plan, snapshot, acc, {
    path: listingPath(args.corporationId),
    docField: "officialPriceRubars",
    entryCityId: null,
    field: listingField(args.corporationId, "officialPriceRubars"),
    value: newOfficial,
    formula: "M-06/§4.1: official = last trade price if a trade occurred since the last repricing (a print in the invoking event supersedes), else the reference price",
  });
  if (listing.tradedSinceLastRepricing) {
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId),
      docField: "tradedSinceLastRepricing",
      entryCityId: null,
      field: listingField(args.corporationId, "tradedSinceLastRepricing"),
      value: false,
      formula: "M-06: the repricing consumes the trade flag — the next official-price evaluation measures trades from this event",
    });
  }

  // Halt evaluation (§1.8): downtime halts; its clearing resumes. A
  // suspended listing is the owner's choice and is never auto-moved.
  let haltTransition: MarketRepricingOutcome["haltTransition"] = null;
  if (listing.tradingStatus === "open" && inputs.downtimeFlag) {
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId),
      docField: "tradingStatus",
      entryCityId: null,
      field: listingField(args.corporationId, "tradingStatus"),
      value: "halted",
      formula: "M-06/§1.8: downtime — the company has linked structures and none is functioning",
    });
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId),
      docField: "haltReason",
      entryCityId: null,
      field: listingField(args.corporationId, "haltReason"),
      value: "downtime",
      formula: "M-06/§1.8: coded halt cause",
    });
    haltTransition = "halted-downtime";
  } else if (
    listing.tradingStatus === "halted" &&
    listing.haltReason === "downtime" &&
    !inputs.downtimeFlag
  ) {
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId),
      docField: "tradingStatus",
      entryCityId: null,
      field: listingField(args.corporationId, "tradingStatus"),
      value: "open",
      formula: "M-06/§1.8: the downtime condition has cleared (a linked structure functions again)",
    });
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId),
      docField: "haltReason",
      entryCityId: null,
      field: listingField(args.corporationId, "haltReason"),
      value: null,
      formula: "M-06/§1.8: halt cause cleared",
    });
    haltTransition = "resumed";
  }

  // The corporation-side cache + carried judgment (home-city entry).
  setField(plan, snapshot, acc, {
    path: corpPath,
    docField: "valuationRubars",
    entryCityId: args.homeCityId,
    field: corpField(args.corporationId, "valuationRubars"),
    value: newOfficial * live,
    formula: "M-06/§4.1: valuationRubars cache = official price × live shares (issued − retired)",
  });
  if (args.judgment) {
    const beforeJudgment = (corp.lastJudgment as Record<string, unknown> | null) ?? null;
    const afterJudgment = {
      quality: args.judgment.quality,
      scale: args.judgment.scale,
      importance: args.judgment.importance,
      inputHash: args.judgmentInputHash,
    };
    planMutate(plan, snapshot, corpPath, "state", ["lastJudgment"], (doc) =>
      doc ? { ...doc, lastJudgment: afterJudgment } : doc
    );
    accChange(
      acc,
      args.homeCityId,
      corpField(args.corporationId, "lastJudgment"),
      beforeJudgment,
      afterJudgment,
      "M-06/§4.5: the invoking event's prepared-payload judgment becomes the carried scores"
    );
  }

  // Disclosure (§6 M-06 Log line: every input, scores moved/held,
  // uncapped beside applied, official before/after, halt, index).
  const scoreLine = (name: keyof JudgmentScores): string => {
    if (!args.judgment) return `${name} ${scores[name]} (held — judgment not invoked; carried scores stand)`;
    const before = carried ? carried[name] : null;
    const moved = before === null || before !== args.judgment[name];
    return `${name} ${before ?? "—"} → ${args.judgment[name]} (${moved ? "moved" : "held"})`;
  };
  const disclosure = [
    `M-06 repricing for ${args.corporationId} (invoked by ${args.invokedByRuleId}): coded inputs — companyCash ${inputs.companyCashRubars} R; operatingStructureValue ${inputs.operatingStructureValueRubars} R; earningsProxy ${inputs.earningsProxyRubars === null ? "skipped: unset (term skipped, §4.3 null-honesty)" : `${inputs.earningsProxyRubars} R`}; legalExposureTier ${inputs.legalExposureTier}; downtime ${inputs.downtimeFlag ? "set (earnings term zeroed)" : "clear"}; live shares ${live} (issued ${issuedShares(corp)} − retired ${retiredShares(corp)}); operatingCities ${inputs.operatingCitiesCount ?? 1} (evidence only).`,
    `Judgment (${judgmentSource}): ${scoreLine("quality")}; ${scoreLine("scale")}; ${scoreLine("importance")} — multiplier ${valuation.judgmentMultiplier.toFixed(4)}.${args.judgment ? ` Rationale: ${args.judgmentRationale ?? "not supplied with the prepared payload"}.` : ""}`,
    `Formula: fundamental ${valuation.fundamentalRubars} R (earnings term ${valuation.earningsTermRubars} R; open-case discount ${valuation.openCaseDiscountRubars} R) → uncapped reference ${valuation.uncappedReferencePriceRubars} R/share${valuation.atFloor ? " (fundamental ≤ 0 — priced at the 1 R floor, §4.4)" : ""}; step cap ${cap.capApplied ? `APPLIED (±25% of prior reference ${priorReference} R)` : "not binding"}${cap.exceptionApplied ? ` (exception: ${cap.exceptionApplied} — the formula result stands, §4.7)` : ""} → reference ${priorReference} → ${newReference} R; official ${listing.officialPriceRubars} → ${newOfficial} R (§4.1).`,
    `legacyBookRubars is not an input to this repricing (P4-G6 — provenance only, never priced from).${inputNotes.length > 0 ? ` Input notes: ${inputNotes.join("; ")}.` : ""}${valuation.skippedInputs.length > 0 ? ` Skipped inputs: ${valuation.skippedInputs.join("; ")}.` : ""}`,
    haltTransition === "halted-downtime"
      ? "Trading HALTED in this event (§1.8): downtime — no linked structure is functioning. Resting orders remain, unexecutable, and their owners may cancel them."
      : haltTransition === "resumed"
        ? "Trading RESUMED in this event (§1.8): the downtime condition cleared."
        : `Trading status stands: ${plannedListing(plan, snapshot, args.corporationId)?.tradingStatus ?? listing.tradingStatus}.`,
    indexNote(plan, snapshot),
  ].join(" ");

  const marketChanges = accChangesFor(acc, null);
  const corpChanges = accChangesFor(acc, args.homeCityId);
  plan.entries.push(
    ruleEffectDraft({
      actor: args.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [args.invokedByRuleId, "M-06"],
      changes: marketChanges,
      recordsUpdated: marketChanges.length > 0 ? [listingPath(args.corporationId)] : [],
      summaryText: disclosure,
    })
  );
  if (corpChanges.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: args.actor,
        cityId: args.homeCityId,
        cityIds: [args.homeCityId],
        ruleIds: [args.invokedByRuleId, "M-06"],
        changes: corpChanges,
        recordsUpdated: [corpPath],
        summaryText: `M-06: ${args.corporationId}'s valuationRubars cache now ${newOfficial * live} R (official ${newOfficial} R × ${live} live shares)${args.judgment ? "; the invoking event's judgment is recorded as lastJudgment" : ""}.`,
      })
    );
  }
  return {
    status: "repriced",
    note: disclosure,
    inputs,
    scoresUsed: scores,
    judgmentSource,
    uncappedPriceRubars: valuation.uncappedReferencePriceRubars,
    appliedPriceRubars: newReference,
    capApplied: cap.capApplied,
    officialPriceRubars: newOfficial,
    haltTransition,
  };
}

// ---------------------------------------------------------------------------
// Book maintenance + settlement core (M-03/M-04/M-05 machinery).
// ---------------------------------------------------------------------------

/** M-05's expiry mechanism, run in-event by every rule that touches a
 * listing's book (§1.5: expiry is evaluated when a later event touches
 * the listing, and the evaluation is logged in that event — never by a
 * timer). Expired sells release their share commitment; an expired
 * float offer releases the listing's committed float with it. */
function expirySweep(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  acc: ChangeAcc;
  corporationId: string;
  homeCityId: string;
  seq: number;
  resolutionId: string;
  now: Date;
}): MarketOrderRecord[] {
  const expired: MarketOrderRecord[] = [];
  for (const { doc } of bookDocs(args.snapshot)) {
    const planned = plannedDoc(args.plan, args.snapshot, orderPath(String(doc.orderId))) ?? doc;
    const order = planned as unknown as MarketOrderRecord;
    if (order.status !== "resting") continue;
    if (order.expiresAtSeq === null || order.expiresAtSeq > args.seq) continue;
    const after = patchOrder(
      args.plan,
      args.snapshot,
      args.acc,
      order.orderId,
      { status: "expired" },
      `M-05: expiry evaluated in this event — expiresAtSeq ${order.expiresAtSeq} has passed at seq ${args.seq}`
    );
    if (!after) continue;
    expired.push(after);
    if (order.side === "sell" && order.quantityShares > 0) {
      mutateHolding(args.plan, args.snapshot, args.acc, {
        memberId: order.memberId,
        corporationId: args.corporationId,
        homeCityId: args.homeCityId,
        deltaQuantity: 0,
        deltaCommitted: -order.quantityShares,
        deltaCostBasis: 0,
        create: false,
        seq: args.seq,
        resolutionId: args.resolutionId,
        now: args.now,
        formula: "M-05: expiry releases the order's committed shares",
      });
      if (order.kind === "float-offer") {
        const listing = plannedListing(args.plan, args.snapshot, args.corporationId);
        if (listing) {
          setField(args.plan, args.snapshot, args.acc, {
            path: listingPath(args.corporationId),
            docField: "committedFloatShares",
            entryCityId: null,
            field: listingField(args.corporationId, "committedFloatShares"),
            value: listing.committedFloatShares - order.quantityShares,
            formula: "M-05: the expired float offer's shares leave the committed float",
          });
        }
      }
    }
  }
  return expired;
}

/** The engine's book for a listing: resting orders from the read
 * plan's materialization, planned-aware, in placement order. Resting
 * orders always carry a price (placement invariant); a priceless
 * resting order is a corrupt record — skipped here, cancellable by
 * its owner, and noted by the caller via `malformed`. */
function buildEngineBook(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  corporationId: string
): { book: RestingOrder[]; docsById: Map<string, MarketOrderRecord>; malformed: string[] } {
  const book: RestingOrder[] = [];
  const docsById = new Map<string, MarketOrderRecord>();
  const malformed: string[] = [];
  for (const { doc } of bookDocs(snapshot)) {
    const planned = plannedDoc(plan, snapshot, orderPath(String(doc.orderId))) ?? doc;
    const order = planned as unknown as MarketOrderRecord;
    if (order.status !== "resting" || order.corporationId !== corporationId) continue;
    docsById.set(order.orderId, order);
    if (typeof order.limitPriceRubars !== "number") {
      malformed.push(order.orderId);
      continue;
    }
    book.push({
      orderId: order.orderId,
      listingId: corporationId,
      memberId: order.memberId,
      side: order.side,
      quantityShares: order.quantityShares,
      limitPriceRubars: order.limitPriceRubars,
      placedAtSeq: order.placedAtSeq,
      expiresAtSeq: order.expiresAtSeq,
    });
  }
  book.sort((a, b) => a.placedAtSeq - b.placedAtSeq);
  return { book, docsById, malformed };
}

export interface SettledExecution {
  execution: Execution;
  tradeId: string;
  tradeValueRubars: number;
  buyerFeeRubars: number;
  sellerFeeRubars: number;
}

/** Settle accepted member-vs-member executions (M-04): one transfer
 * call for the whole event (the primitive nets per ledger; the
 * placement/crossing pre-checks have already proven every leg), then
 * the share-side writes — holdings, resting order consumption, trade
 * records — and one Log entry per execution carrying that execution's
 * own cash legs (chained on running balances) and share changes.
 * Listing price/counter updates accumulate into the caller's `acc`. */
function settleMemberExecutions(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  acc: ChangeAcc;
  actor: HandlerContext["action"]["actor"];
  resolutionId: string;
  corporationId: string;
  homeCityId: string;
  founderMemberId: string;
  incomingOrderId: string;
  accepted: { execution: Execution; resting: MarketOrderRecord }[];
  seq: number;
  now: Date;
}): { ok: true; settled: SettledExecution[] } | { ok: false; code: string; message: string } {
  const { plan, snapshot } = args;
  const lines: TransferLine[] = [];
  const settlements = args.accepted.map(({ execution }) => {
    const tradeValueRubars = execution.quantityShares * execution.priceRubars;
    const buyerFeeRubars = exchangeFeeRubars(tradeValueRubars);
    const sellerFeeRubars = exchangeFeeRubars(tradeValueRubars);
    return { execution, tradeValueRubars, buyerFeeRubars, sellerFeeRubars };
  });
  for (const s of settlements) {
    lines.push({
      from: personalRef(s.execution.buyerMemberId),
      to: personalRef(s.execution.sellerMemberId),
      amountRubars: s.tradeValueRubars,
      ruleId: "M-04",
      memo: `trade value — ${s.execution.quantityShares} shares of ${args.corporationId} at ${s.execution.priceRubars} R`,
    });
    lines.push({
      from: personalRef(s.execution.buyerMemberId),
      to: MARKET_REF,
      amountRubars: s.buyerFeeRubars,
      ruleId: "M-04",
      memo: "exchange fee — buyer side (§5.3)",
    });
    lines.push({
      from: personalRef(s.execution.sellerMemberId),
      to: MARKET_REF,
      amountRubars: s.sellerFeeRubars,
      ruleId: "M-04",
      memo: "exchange fee — seller side (§5.3)",
    });
  }
  // Running balances for the per-execution Log legs, captured BEFORE
  // the primitive folds its writes (the legs chain off these).
  const running = new Map<string, number>();
  const balanceOf = (memberId: string): number => {
    const cached = running.get(memberId);
    if (cached !== undefined) return cached;
    const value = plannedBalance(plan, snapshot, personalRef(memberId)) ?? 0;
    running.set(memberId, value);
    return value;
  };
  let marketRunning = plannedBalance(plan, snapshot, MARKET_REF) ?? 0;

  const applied = applyTransferLines({ plan, snapshot, lines, shortfallClass: "transfer" });
  if (!applied.ok) return { ok: false, code: applied.code, message: applied.message };

  const settled: SettledExecution[] = [];
  settlements.forEach((s, index) => {
    const { execution } = s;
    const tradeId = `trade_${args.resolutionId}_${String(index + 1).padStart(2, "0")}`;
    const execAcc: ChangeAcc = new Map();
    const buyerBefore = balanceOf(execution.buyerMemberId);
    const buyerAfter = buyerBefore - (s.tradeValueRubars + s.buyerFeeRubars);
    running.set(execution.buyerMemberId, buyerAfter);
    const sellerBefore = balanceOf(execution.sellerMemberId);
    const sellerAfter = sellerBefore + (s.tradeValueRubars - s.sellerFeeRubars);
    running.set(execution.sellerMemberId, sellerAfter);
    const marketBefore = marketRunning;
    marketRunning += s.buyerFeeRubars + s.sellerFeeRubars;

    // Share side: a RESTING seller's shares were committed behind
    // their order (placement invariant) and the fill consumes the
    // commitment; an INCOMING seller delivers from free shares (they
    // were validated at placement and never committed). The buyer's
    // holding gains quantity and cost basis (price × qty — fees are
    // not basis).
    const resting = args.accepted[index].resting;
    const sellerWasResting = resting.side === "sell";
    mutateHolding(plan, snapshot, execAcc, {
      memberId: execution.sellerMemberId,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      deltaQuantity: -execution.quantityShares,
      deltaCommitted: sellerWasResting ? -execution.quantityShares : 0,
      deltaCostBasis: 0,
      create: false,
      seq: args.seq,
      resolutionId: args.resolutionId,
      now: args.now,
      formula: sellerWasResting
        ? `M-04 execution ${tradeId}: seller delivers ${execution.quantityShares} shares (committed behind resting order ${execution.restingOrderId})`
        : `M-04 execution ${tradeId}: incoming seller delivers ${execution.quantityShares} free shares`,
    });
    mutateHolding(plan, snapshot, execAcc, {
      memberId: execution.buyerMemberId,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      deltaQuantity: execution.quantityShares,
      deltaCommitted: 0,
      deltaCostBasis: s.tradeValueRubars,
      create: true,
      seq: args.seq,
      resolutionId: args.resolutionId,
      now: args.now,
      formula: `M-04 execution ${tradeId}: buyer receives ${execution.quantityShares} shares; cost basis += trade value ${s.tradeValueRubars} R (fees are not cost basis, §5.4)`,
    });
    patchOrder(plan, snapshot, execAcc, resting.orderId, {
      quantityShares: resting.quantityShares - execution.quantityShares,
      filledShares: resting.filledShares + execution.quantityShares,
      status:
        resting.quantityShares - execution.quantityShares <= 0 ? "filled" : "resting",
    }, `M-04 execution ${tradeId}: resting order consumed at its own price (§1.6 step 4)`);

    const tradeDoc = buildTradeDoc({
      tradeId,
      corporationId: args.corporationId,
      homeCityId: args.homeCityId,
      buyerMemberId: execution.buyerMemberId,
      sellerMemberId: execution.sellerMemberId,
      quantityShares: execution.quantityShares,
      priceRubars: execution.priceRubars,
      buyerFeeRubars: s.buyerFeeRubars,
      sellerFeeRubars: s.sellerFeeRubars,
      incomingOrderId: args.incomingOrderId,
      restingOrderId: execution.restingOrderId,
      seq: args.seq,
      sourceActionId: args.resolutionId,
      lastResolutionId: args.resolutionId,
      now: args.now,
    });
    planWrite(plan, snapshot, tradePath(tradeId), tradeDoc, "state", [
      "quantityShares",
      "priceRubars",
    ]);

    // Listing state: the print moves last-trade + official (§4.1);
    // float counters follow the parties (custody accounting).
    setField(plan, snapshot, args.acc, {
      path: listingPath(args.corporationId),
      docField: "lastTradePriceRubars",
      entryCityId: null,
      field: listingField(args.corporationId, "lastTradePriceRubars"),
      value: execution.priceRubars,
      formula: `M-04 execution ${tradeId}: trade print (§1.4 mechanism 1)`,
    });
    setField(plan, snapshot, args.acc, {
      path: listingPath(args.corporationId),
      docField: "officialPriceRubars",
      entryCityId: null,
      field: listingField(args.corporationId, "officialPriceRubars"),
      value: execution.priceRubars,
      formula: "M-04/§4.1: a trade print since the last repricing makes the last trade price the official price",
    });
    setField(plan, snapshot, args.acc, {
      path: listingPath(args.corporationId),
      docField: "tradedSinceLastRepricing",
      entryCityId: null,
      field: listingField(args.corporationId, "tradedSinceLastRepricing"),
      value: true,
      formula: "M-04: a trade occurred since the last repricing",
    });
    const listingNow = plannedListing(plan, snapshot, args.corporationId);
    if (listingNow) {
      let publicDelta = 0;
      if (execution.buyerMemberId !== args.founderMemberId) publicDelta += execution.quantityShares;
      if (execution.sellerMemberId !== args.founderMemberId) publicDelta -= execution.quantityShares;
      if (publicDelta !== 0) {
        setField(plan, snapshot, args.acc, {
          path: listingPath(args.corporationId),
          docField: "publicHeldShares",
          entryCityId: null,
          field: listingField(args.corporationId, "publicHeldShares"),
          value: listingNow.publicHeldShares + publicDelta,
          formula: `M-04 execution ${tradeId}: shares moving between founder and public hands re-count the public float`,
        });
      }
      if (resting.kind === "float-offer") {
        setField(plan, snapshot, args.acc, {
          path: listingPath(args.corporationId),
          docField: "committedFloatShares",
          entryCityId: null,
          field: listingField(args.corporationId, "committedFloatShares"),
          value: listingNow.committedFloatShares - execution.quantityShares,
          formula: `M-04 execution ${tradeId}: the float offer filled — committed float falls by the filled quantity (custody, P4-K21)`,
        });
      }
    }

    plan.entries.push(
      ruleEffectDraft({
        actor: args.actor,
        cityId: null,
        cityIds: [],
        ruleIds: ["M-03", "M-04"],
        changes: [
          fieldChange(
            `memberAccounts/${execution.buyerMemberId}.cashRubars`,
            buyerBefore,
            buyerAfter,
            `M-04 execution ${tradeId}: buyer pays value ${s.tradeValueRubars} R + buyer fee ${s.buyerFeeRubars} R`
          ),
          fieldChange(
            `memberAccounts/${execution.sellerMemberId}.cashRubars`,
            sellerBefore,
            sellerAfter,
            `M-04 execution ${tradeId}: seller receives value ${s.tradeValueRubars} R − seller fee ${s.sellerFeeRubars} R`
          ),
          fieldChange(
            "marketAccount.cashRubars",
            marketBefore,
            marketRunning,
            `M-04 execution ${tradeId}: exchange fees ${s.buyerFeeRubars} R (buyer) + ${s.sellerFeeRubars} R (seller) credit the Market Account (§5.3)`
          ),
          ...accChangesFor(execAcc, null),
          fieldChange(
            `marketTrades/${tradeId}.priceRubars`,
            null,
            execution.priceRubars,
            `M-04 execution ${tradeId}: the tape record — ${execution.quantityShares} shares at the resting order's price ${execution.priceRubars} R (§1.6 step 4)`
          ),
        ],
        recordsCreated: [tradePath(tradeId)],
        recordsUpdated: [
          orderPath(resting.orderId),
          holdingPath(execution.sellerMemberId, args.corporationId),
          holdingPath(execution.buyerMemberId, args.corporationId),
        ],
        summaryText: `M-04 execution ${tradeId}: ${execution.buyerMemberId} bought ${execution.quantityShares} shares of ${args.corporationId} from ${execution.sellerMemberId} at ${execution.priceRubars} R (resting order ${execution.restingOrderId} × incoming ${args.incomingOrderId}); value ${s.tradeValueRubars} R; fees ${s.buyerFeeRubars} R buyer / ${s.sellerFeeRubars} R seller to the Market Account. Official price now ${execution.priceRubars} R (trade print, §4.1).`,
      })
    );
    settled.push({
      execution,
      tradeId,
      tradeValueRubars: s.tradeValueRubars,
      buyerFeeRubars: s.buyerFeeRubars,
      sellerFeeRubars: s.sellerFeeRubars,
    });
  });
  return { ok: true, settled };
}

// ---------------------------------------------------------------------------
// The standing float offer (custody, P4-K21): the founder's committed
// float IS this resting limit sell. Placing/growing it moves no
// shares — it commits shares already in the founder's holding.
// ---------------------------------------------------------------------------

function placeOrGrowFloatOffer(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  acc: ChangeAcc;
  corporationId: string;
  homeCityId: string;
  founderMemberId: string;
  addQuantity: number;
  priceRubars: number | null;
  seq: number;
  resolutionId: string;
  now: Date;
  formula: string;
}): void {
  const orderId = floatOfferOrderId(args.corporationId);
  const existing = plannedDoc(args.plan, args.snapshot, orderPath(orderId));
  if (existing && existing.status === "resting") {
    const patch: Partial<MarketOrderRecord> = {
      quantityShares: intOr(existing, "quantityShares", 0) + args.addQuantity,
      originalQuantityShares: intOr(existing, "originalQuantityShares", 0) + args.addQuantity,
    };
    if (args.priceRubars !== null) patch.limitPriceRubars = args.priceRubars;
    patchOrder(args.plan, args.snapshot, args.acc, orderId, patch, args.formula);
    return;
  }
  const doc = buildOrderDoc({
    orderId,
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    memberId: args.founderMemberId,
    side: "sell",
    type: "limit",
    kind: "float-offer",
    quantityShares: args.addQuantity,
    limitPriceRubars: args.priceRubars,
    placedAtSeq: args.seq,
    expiresAtSeq: null,
    sourceActionId: args.resolutionId,
    lastResolutionId: args.resolutionId,
    now: args.now,
  });
  planWrite(args.plan, args.snapshot, orderPath(orderId), doc, "state", [
    "quantityShares",
    "limitPriceRubars",
    "status",
  ]);
  accChange(args.acc, null, orderField(orderId, "quantityShares"), null, args.addQuantity, args.formula);
  accChange(args.acc, null, orderField(orderId, "status"), null, "resting", args.formula);
}

// ---------------------------------------------------------------------------
// M-00 — found the Market Account (genesis-class founding act).
// ---------------------------------------------------------------------------

function foundMarketAccountHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-00";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "M-00: the Market Account's founding act is confirmed by a named member (the operator's act, run as the exchange's data step).");
  }
  if (snapshotDoc(ctx.snapshot, MARKET_ACCOUNT_PATH)) {
    return rejectedPlan(descriptorId, "market-already-founded", [descriptorId], "M-00: the Market Account already stands — it is founded exactly once, and its seed is never re-minted.");
  }
  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const doc = buildMarketAccountDoc({
    seedRubars: MARKET_ACCOUNT_SEED_RUBARS,
    seededAtSeq: seq,
    lastResolutionId: ctx.resolutionId,
    now,
  });
  planWrite(plan, ctx.snapshot, MARKET_ACCOUNT_PATH, doc, "state", [
    "cashRubars",
    "seedRubars",
    "status",
    "seedRuleId",
  ]);
  plan.entries.push(
    ruleEffectDraft({
      kind: "genesis",
      actor: ctx.action.actor,
      ruleIds: [descriptorId],
      changes: [
        fieldChange(
          "marketAccount.cashRubars",
          null,
          MARKET_ACCOUNT_SEED_RUBARS,
          "M-00 founding seed (mint, finance §3.3 closed list — the Market Account seed joins it with this act)"
        ),
        fieldChange("mint:M-00", 0, MARKET_ACCOUNT_SEED_RUBARS, "mint leg — Market Account seed"),
      ],
      recordsCreated: [MARKET_ACCOUNT_PATH],
      summaryText: `M-00: the Market Account is founded at sim_market_account/main with a seed of ${MARKET_ACCOUNT_SEED_RUBARS} R (mint under finance §3.3's closed list). The account is the exchange operator's float ledger (fees, §1.7 custody): it holds no shares, takes no positions, and moves only by published rule. Until this act stands, market money lines fail and trade handlers reject market-account-missing — the account is never lazy-invented inside a trade.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "found-market-account",
    scope: "market",
    cityId: null,
    summaryText: `Founded the Market Account with its ${MARKET_ACCOUNT_SEED_RUBARS} R seed (M-00, genesis-class).`,
    major: true,
  });
}

// ---------------------------------------------------------------------------
// M-01 — list a company. Two branches:
//  (a) completion: a corporation Catalogue II's listed founding left
//      flagged `listed` with founding figures standing but no listing
//      record and/or no founder holding (the PR #33 backfill
//      obligation) — the repair is exactly the founder-holding
//      backfill planner's output, executed as the owner's act.
//  (b) full listing of an unlisted company (§2.2 eligibility): paid-in
//      capital moves, shares issue to the founder, the opening price
//      is computed by the M-06 input assembly + formula with no prior
//      price (the step cap cannot bind a first price), judgment from
//      the prepared payload only.
// ---------------------------------------------------------------------------

function listCompanyHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-01";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "M-01: the actor carries no member identity — a listing is its owner member's act.");
  }
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  if (!corporationId || !homeCityId) {
    return rejectedPlan(descriptorId, "malformed-listing", [descriptorId], "M-01: list_company requires corporationId and homeCityId (the record's home).");
  }
  const corpPath = corporationPath(homeCityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "company-not-found", [descriptorId], `M-01: no corporation record for ${corporationId} in ${homeCityId}.`);
  }
  if (corp.status === "dissolved") {
    return rejectedPlan(descriptorId, "company-dissolved", [descriptorId], `M-01: ${corporationId} is dissolved — a dissolved company cannot list.`);
  }
  const ownerGate = requireOwner(ctx, descriptorId, corp, corporationId);
  if (isPlan(ownerGate)) return ownerGate;
  const ownerId = ownerGate;
  const listing = readListing(ctx.snapshot, corporationId);
  if (listing) {
    return rejectedPlan(descriptorId, "already-listed", [descriptorId], `M-01: ${corporationId} already has a standing listing record — listing is a once-only act (delisting is M-10).`);
  }

  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();

  // ---- Branch (a): completion of a founding-listed corporation. ----
  if (corp.listed === true) {
    const opening = num(corp, "openingReferencePriceRubars");
    if (opening === null || !Number.isInteger(opening) || opening <= 0) {
      return rejectedPlan(descriptorId, "opening-price-missing", [descriptorId], `M-01: ${corporationId} is flagged listed at founding but no openingReferencePriceRubars stands on its record — the completion branch repairs records from founding figures and invents no price. The figure must be restored by the correction path (M-11) before listing can complete.`);
    }
    const live = liveShares(corp);
    if (live <= 0) {
      return rejectedPlan(descriptorId, "no-shares-issued", [descriptorId], `M-01: ${corporationId} is flagged listed but no live shares stand on its record — there is nothing to hold or trade.`);
    }
    const standing = readHolding(ctx.snapshot, ownerId, corporationId);
    const standingQty = standing ? standing.quantityShares : 0;
    if (standingQty > live) {
      return rejectedPlan(descriptorId, "share-ledger-inconsistent", [descriptorId], `M-01: the founder holding for ${corporationId} stands at ${standingQty} shares against ${live} live shares — the records disagree and the market halts rather than papers over it (§1.8 ledger-inconsistency posture; remedy is the correction path, M-11).`);
    }
    const floatShares = nonNegativeAmount(ctx.action, "floatShares") ?? 0;
    if (floatShares > live) {
      return rejectedPlan(descriptorId, "float-exceeds-issued", [descriptorId], `M-01: float ${floatShares} exceeds the ${live} live shares of ${corporationId}.`);
    }
    const shortfall = live - standingQty;
    const listingDoc = buildListingDoc({
      corporationId,
      homeCityId,
      ownerMemberId: ownerId,
      openingPriceRubars: opening,
      committedFloatShares: floatShares,
      listedAtSeq: seq,
      sourceActionId: ctx.action.actionId,
      lastResolutionId: ctx.resolutionId,
      now,
    });
    planWrite(plan, ctx.snapshot, listingPath(corporationId), listingDoc, "state", [
      "referencePriceRubars",
      "officialPriceRubars",
      "tradingStatus",
      "committedFloatShares",
    ]);
    accChange(acc, null, listingField(corporationId, "referencePriceRubars"), null, opening, "M-01 completion: the listing record takes the founding opening reference price from the corporation record");
    accChange(acc, null, listingField(corporationId, "officialPriceRubars"), null, opening, "M-01 completion: official = reference until a trade prints (§4.1)");
    if (shortfall > 0 || floatShares > 0) {
      mutateHolding(plan, ctx.snapshot, acc, {
        memberId: ownerId,
        corporationId,
        homeCityId,
        deltaQuantity: shortfall,
        deltaCommitted: floatShares,
        deltaCostBasis: standing ? 0 : intOr(corp, "paidInCapitalRubars", 0),
        create: true,
        seq,
        resolutionId: ctx.resolutionId,
        now,
        formula: "M-01 completion (M-02 obligation): the founder holding is created for exactly the founding shortfall — the backfill planner's repair figures",
      });
    }
    if (floatShares > 0) {
      placeOrGrowFloatOffer({
        plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
        founderMemberId: ownerId, addQuantity: floatShares, priceRubars: opening,
        seq, resolutionId: ctx.resolutionId, now,
        formula: "M-01 completion: the founder's float is offered as the standing float-offer order at the opening price (custody, P4-K21)",
      });
    }
    const anchorNote = maybeAnchorIndexDivisor(plan, ctx.snapshot, acc, corporationId);
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: accChangesFor(acc, null),
        recordsCreated: [
          listingPath(corporationId),
          ...(shortfall > 0 || floatShares > 0 ? [holdingPath(ownerId, corporationId)] : []),
          ...(floatShares > 0 ? [orderPath(floatOfferOrderId(corporationId))] : []),
        ],
        summaryText: `M-01 completion for ${corporationId}: the corporation was listed at founding (R-06) before market records existed; this act creates the listing record at the founding opening price ${opening} R and the founder holding for the planner's exact shortfall (${standingQty} standing of ${live} live shares; ${shortfall} created now, cost basis = paid-in capital ${intOr(corp, "paidInCapitalRubars", 0)} R on a fresh holding). Float committed: ${floatShares} shares as the standing float offer. No new judgment, no repricing — founding figures stand as recorded.${anchorNote ? ` ${anchorNote}` : ""}`,
      })
    );
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "list-company",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Completed the listing of ${corporationId} from its founding figures: listing record and founder holding now stand (${live} live shares, opening ${opening} R, float ${floatShares}).`,
      major: true,
      extraClassification: { listing: { branch: "completion", openingPriceRubars: opening, liveShares: live, floatShares } },
    });
  }

  // ---- Branch (b): full listing of an unlisted company (§2.2). ----
  if (corp.status !== "active") {
    return rejectedPlan(descriptorId, "company-not-active", [descriptorId], `M-01: ${corporationId} stands "${String(corp.status)}" — §2.2 eligibility requires status "active".`);
  }
  if (!snapshotDoc(ctx.snapshot, cityPath(homeCityId))) {
    return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `M-01: no city record for the home city ${homeCityId} — an unclaimed/inactive city has no sim presence and can host no listing (§2.2).`);
  }
  const fundingSource = stringField(ctx.action, "fundingSource") ?? "personal";
  if (fundingSource === "treasury") {
    return rejectedPlan(descriptorId, "treasury-source-suspended", [descriptorId, "P4-K21"], "M-01: paid-in capital sourced from a city treasury is suspended in Phase 4 (P4-K21(ii)) — listing capital is the founder's personal funds in this slice.");
  }
  if (fundingSource !== "personal") {
    return rejectedPlan(descriptorId, "malformed-listing", [descriptorId], `M-01: fundingSource "${fundingSource}" is not a lawful paid-in capital source (personal is the Phase 4 source).`);
  }
  if (issuedShares(corp) > 0) {
    return rejectedPlan(descriptorId, "shares-already-issued", [descriptorId], `M-01: ${corporationId} already carries ${issuedShares(corp)} issued shares while unlisted — an anomalous record state; issuance belongs to listed companies (M-02) and founding (R-06).`);
  }
  const paidIn = nonNegativeAmount(ctx.action, "paidInCapitalRubars");
  const sharesIssued = positiveAmount(ctx.action, "sharesIssued");
  if (paidIn === null || sharesIssued === null) {
    return rejectedPlan(descriptorId, "malformed-listing", [descriptorId], "M-01: a full listing states paidInCapitalRubars (≥ 0; capital may already stand on the record) and sharesIssued (> 0) — the opening price derives from them (§4.2).");
  }
  const floatShares = nonNegativeAmount(ctx.action, "floatShares") ?? 0;
  if (floatShares > sharesIssued) {
    return rejectedPlan(descriptorId, "float-exceeds-issued", [descriptorId], `M-01: float ${floatShares} exceeds the ${sharesIssued} shares to issue.`);
  }
  const judgment = judgmentFromPrepared(ctx);
  if (!judgment) {
    return rejectedPlan(descriptorId, "judgment-required", [descriptorId], "M-01: a listing prices from the market's judgment (quality / scale / importance scores), which arrives only in the worker-prepared payload bound at preview. The action carries no lawful judgment — the founder never supplies the judgment of their own company — so the listing cannot resolve.");
  }

  // Step 0 (§1.4): the founder's account lazy-opens before the capital
  // line, the grant ordered first.
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: ownerId, viaActionKind: "list_company" });
  if (paidIn > 0) {
    const line: TransferLine = {
      from: personalRef(ownerId),
      to: companyRef(homeCityId, corporationId),
      amountRubars: paidIn,
      ruleId: descriptorId,
      memo: `paid-in capital at listing of ${corporationId}`,
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
    if (!applied.ok) {
      return rejectedPlan(
        descriptorId,
        applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
        [descriptorId],
        `M-01: the paid-in capital of ${paidIn} R refused in full (transfer class): ${applied.message}`
      );
    }
    pushMovementEntries(plan, ctx, [descriptorId], applied.changes, (entryCityId) =>
      entryCityId === null
        ? `M-01: ${ownerId}'s personal account paid ${paidIn} R of paid-in capital into ${corporationId} (funding source: founder's personal account, recorded distinctly).`
        : `M-01: ${corporationId}'s company cash received ${paidIn} R of paid-in capital at listing.`
    );
  }

  // Record the issuance on the corporation record, then price the
  // opening from the M-06 coded inputs over the PLANNED record (post
  // capital) — one valuation path for founding and later listings.
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "listed", entryCityId: homeCityId,
    field: corpField(corporationId, "listed"), value: true,
    formula: "M-01: the company lists in this event",
  });
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "sharesOutstanding", entryCityId: homeCityId,
    field: corpField(corporationId, "sharesOutstanding"), value: sharesIssued,
    formula: "M-01: shares issued at listing, all to the founder (§4.2)",
  });
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "paidInCapitalRubars", entryCityId: homeCityId,
    field: corpField(corporationId, "paidInCapitalRubars"),
    value: intOr(corp, "paidInCapitalRubars", 0) + paidIn,
    formula: "M-01: paid-in capital accumulates the listing payment",
  });
  const plannedCorp = plannedDoc(plan, ctx.snapshot, corpPath) ?? corp;
  const { inputs, notes: inputNotes } = assembleCodedInputs(plan, ctx.snapshot, plannedCorp, homeCityId);
  if (inputs.companyCashRubars + inputs.operatingStructureValueRubars <= 0) {
    return rejectedPlan(descriptorId, "listing-unpriced", [descriptorId], "M-01: a listing with zero capital and zero operating footprint has nothing to price and is refused (§2.2 check 4) — no opening price is invented. Commit paid-in capital in the action or build an operating footprint first.");
  }
  const valuation = computeValuation(inputs, judgment);
  const opening = applyStepCap(0, valuation.uncappedReferencePriceRubars).appliedPriceRubars;
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "openingReferencePriceRubars", entryCityId: homeCityId,
    field: corpField(corporationId, "openingReferencePriceRubars"), value: opening,
    formula: "M-01/§4.2: opening reference price from the §4.4 formula over post-money coded inputs (no prior price — the step cap cannot bind a first price)",
  });
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "valuationRubars", entryCityId: homeCityId,
    field: corpField(corporationId, "valuationRubars"), value: opening * sharesIssued,
    formula: "M-01/§4.1: valuationRubars cache at listing = opening official price × shares issued",
  });
  const afterJudgment = {
    quality: judgment.quality,
    scale: judgment.scale,
    importance: judgment.importance,
    inputHash: ctx.prepared?.inputHash ?? null,
  };
  planMutate(plan, ctx.snapshot, corpPath, "state", ["lastJudgment"], (doc) =>
    doc ? { ...doc, lastJudgment: afterJudgment } : doc
  );
  accChange(acc, homeCityId, corpField(corporationId, "lastJudgment"), (corp.lastJudgment as Record<string, unknown> | null) ?? null, afterJudgment, "M-01/§4.5: the listing judgment is recorded as the company's carried scores");

  const listingDoc = buildListingDoc({
    corporationId,
    homeCityId,
    ownerMemberId: ownerId,
    openingPriceRubars: opening,
    committedFloatShares: floatShares,
    listedAtSeq: seq,
    sourceActionId: ctx.action.actionId,
    lastResolutionId: ctx.resolutionId,
    now,
  });
  planWrite(plan, ctx.snapshot, listingPath(corporationId), listingDoc, "state", [
    "referencePriceRubars",
    "officialPriceRubars",
    "tradingStatus",
    "committedFloatShares",
    "earningsWindowStartSeq",
  ]);
  accChange(acc, null, listingField(corporationId, "referencePriceRubars"), null, opening, "M-01: opening reference price (§4.2)");
  accChange(acc, null, listingField(corporationId, "officialPriceRubars"), null, opening, "M-01: official = reference until a trade prints (§4.1)");
  mutateHolding(plan, ctx.snapshot, acc, {
    memberId: ownerId,
    corporationId,
    homeCityId,
    deltaQuantity: sharesIssued,
    deltaCommitted: floatShares,
    deltaCostBasis: intOr(plannedCorp, "paidInCapitalRubars", 0),
    create: true,
    seq,
    resolutionId: ctx.resolutionId,
    now,
    formula: "M-01: all issued shares to the founder (§4.2); the float portion is committed behind the float offer (custody, P4-K21)",
  });
  if (floatShares > 0) {
    placeOrGrowFloatOffer({
      plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
      founderMemberId: ownerId, addQuantity: floatShares, priceRubars: opening,
      seq, resolutionId: ctx.resolutionId, now,
      formula: "M-01: the founder's float is offered as the standing float-offer order at the opening price",
    });
  }
  const anchorNote = maybeAnchorIndexDivisor(plan, ctx.snapshot, acc, corporationId);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId, "M-06"],
      changes: accChangesFor(acc, null),
      recordsCreated: [
        listingPath(corporationId),
        holdingPath(ownerId, corporationId),
        ...(floatShares > 0 ? [orderPath(floatOfferOrderId(corporationId))] : []),
      ],
      summaryText: `M-01 listing of ${corporationId}: opening price ${opening} R/share from the §4.4 formula over coded inputs — companyCash ${inputs.companyCashRubars} R (post-money); operatingStructureValue ${inputs.operatingStructureValueRubars} R; earningsProxy ${inputs.earningsProxyRubars === null ? "skipped: unset" : `${inputs.earningsProxyRubars} R`}; tier ${inputs.legalExposureTier}; downtime ${inputs.downtimeFlag ? "set" : "clear"}; shares ${sharesIssued}. Judgment (prepared payload only): quality ${judgment.quality}, scale ${judgment.scale}, importance ${judgment.importance} — multiplier ${valuation.judgmentMultiplier.toFixed(4)}; rationale: ${judgmentRationaleFromPrepared(ctx) ?? "not supplied with the prepared payload"}. legacyBookRubars is not an input (P4-G6).${inputNotes.length > 0 ? ` Input notes: ${inputNotes.join("; ")}.` : ""}${anchorNote ? ` ${anchorNote}` : ""} ${indexNote(plan, ctx.snapshot)}`,
    })
  );
  const corpChanges = accChangesFor(acc, homeCityId);
  if (corpChanges.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: homeCityId,
        cityIds: [homeCityId],
        ruleIds: [descriptorId],
        changes: corpChanges,
        recordsUpdated: [corpPath],
        summaryText: `M-01: ${corporationId} is now listed — ${sharesIssued} shares issued to the founder, paid-in capital stands at ${intOr(plannedCorp, "paidInCapitalRubars", 0)} R, opening reference ${opening} R.`,
      })
    );
  }
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "list-company",
    scope: "company",
    cityId: homeCityId,
    summaryText: `Listed ${corporationId}: ${sharesIssued} shares issued to the founder at an opening reference of ${opening} R (paid-in ${paidIn} R from the founder's personal account; float ${floatShares} offered).`,
    major: true,
    extraClassification: {
      listing: { branch: "full", openingPriceRubars: opening, sharesIssued, floatShares, judgment: { ...judgment, source: "prepared-payload" } },
      invokesRules: ["M-06"],
    },
  });
}
