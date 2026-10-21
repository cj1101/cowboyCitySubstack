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
import { bankBlockOf } from "../../finance/banking";
import {
  MARKET_ACCOUNT_SEED_RUBARS,
  applyStepCap,
  blockProtectionCapRubars,
  computeValuation,
  deriveRealmIndex,
  divisorBaseForGenesis,
  exchangeFeeRubars,
  marketMakerQuote,
  matchIncomingOrder,
  officialPriceRubars,
  roundHalfUp,
  type CodedValuationInputs,
  type Execution,
  type JudgmentScores,
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
  type SimActor,
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
  ctx: { action: { actor: SimActor } },
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
const allListingDocs = (snapshot: SimSnapshot) =>
  queryDocs(snapshot, LISTINGS_QUERY_ID, "sim_market_listings");
const structureDocs = (snapshot: SimSnapshot, cityId: string) =>
  queryDocs(snapshot, STRUCTURES_QUERY_ID, `sim_cities/${cityId}/structures`);

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
  const byId = new Map<string, MarketListingRecord>();
  for (const { doc } of allListingDocs(snapshot)) {
    const planned = plannedDoc(plan, snapshot, listingPath(String(doc.corporationId))) ?? doc;
    const listing = planned as unknown as MarketListingRecord;
    byId.set(listing.corporationId, listing);
  }
  // A listing created by THIS event is not in the snapshot's query
  // results yet — the planned writes are the truth for it.
  for (const write of plan.writes) {
    if (write.path.startsWith("sim_market_listings/") && write.afterDoc) {
      const listing = write.afterDoc as unknown as MarketListingRecord;
      if (typeof listing.corporationId === "string") byId.set(listing.corporationId, listing);
    }
  }
  const out = [];
  for (const listing of byId.values()) {
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
    // The resting order's figures are read from the PLANNED doc: one
    // resting order can fill in two match rounds of the same event
    // (a cancelled-insufficient-cash interruption between them).
    const restingPlanned = plannedDoc(plan, snapshot, orderPath(resting.orderId));
    const restingQtyAfter =
      intOr(restingPlanned, "quantityShares", 0) - execution.quantityShares;
    patchOrder(plan, snapshot, execAcc, resting.orderId, {
      quantityShares: restingQtyAfter,
      filledShares: intOr(restingPlanned, "filledShares", 0) + execution.quantityShares,
      status: restingQtyAfter <= 0 ? "filled" : "resting",
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

/** Flush accumulated changes for one entry city: returns them and
 * clears them from the accumulator, so a long event can distribute
 * its changes across entries without duplicating any (a field that
 * changes again later starts a fresh record from its then-current
 * planned value — setField/mutateHolding read planned state). */
function accFlush(acc: ChangeAcc, entryCityId: string | null): SimChange[] {
  const prefix = `${entryCityId ?? ""}|`;
  const out: SimChange[] = [];
  for (const [key, change] of acc) {
    if (key.startsWith(prefix)) {
      out.push(change);
      acc.delete(key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// M-02 — issue shares / inject capital / place or recall float.
// ---------------------------------------------------------------------------

function marketIssueHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-02";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  const branch = stringField(ctx.action, "branch");
  if (!corporationId || !homeCityId || !branch) {
    return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], "M-02: market_issue requires corporationId, homeCityId and branch (issue | inject | place-float | recall-float).");
  }
  if (!["issue", "inject", "place-float", "recall-float"].includes(branch)) {
    return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], `M-02: branch "${branch}" is not one of issue | inject | place-float | recall-float.`);
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const ownerGate = requireOwner(ctx, descriptorId, gate.corp, corporationId);
  if (isPlan(ownerGate)) return ownerGate;
  const ownerId = ownerGate;
  const { corp, corpPath, listing } = gate;

  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();
  const judgment = judgmentFromPrepared(ctx);
  const reprice = (invokedBy: string): void => {
    composeMarketRepricing({
      plan,
      snapshot: ctx.snapshot,
      actor: ctx.action.actor,
      corporationId,
      homeCityId,
      judgment,
      judgmentRationale: judgmentRationaleFromPrepared(ctx),
      judgmentInputHash: ctx.prepared?.inputHash ?? null,
      stepCapException: null,
      invokedByRuleId: invokedBy,
    });
  };

  if (branch === "issue") {
    const newShares = positiveAmount(ctx.action, "newShares");
    if (newShares === null) {
      return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], "M-02 issue: newShares must be a positive integer.");
    }
    const destination = stringField(ctx.action, "destination") ?? "founder";
    if (destination !== "founder" && destination !== "float") {
      return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], `M-02 issue: destination "${destination}" is not founder | float.`);
    }
    const liveBefore = liveShares(corp);
    const holdersBefore = holdingDocs(ctx.snapshot)
      .map(({ doc }) => doc as unknown as ShareHoldingRecord)
      .filter((h) => h.corporationId === corporationId && h.quantityShares > 0);
    mutateHolding(plan, ctx.snapshot, acc, {
      memberId: ownerId,
      corporationId,
      homeCityId,
      deltaQuantity: newShares,
      deltaCommitted: destination === "float" ? newShares : 0,
      deltaCostBasis: 0,
      create: true,
      seq,
      resolutionId: ctx.resolutionId,
      now,
      formula: "M-02 issuance: new shares are issued to the founder (unpaid — cost basis unchanged); destination float commits them behind the float offer",
    });
    if (destination === "float") {
      const price = positiveAmount(ctx.action, "limitPriceRubars") ?? listing.referencePriceRubars;
      placeOrGrowFloatOffer({
        plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
        founderMemberId: ownerId, addQuantity: newShares, priceRubars: price,
        seq, resolutionId: ctx.resolutionId, now,
        formula: "M-02 issuance direct to float: the new shares join the standing float offer",
      });
      setField(plan, ctx.snapshot, acc, {
        path: listingPath(corporationId), docField: "committedFloatShares", entryCityId: null,
        field: listingField(corporationId, "committedFloatShares"),
        value: listing.committedFloatShares + newShares,
        formula: "M-02 issuance to float: committed float grows by the issued quantity",
      });
    }
    setField(plan, ctx.snapshot, acc, {
      path: corpPath, docField: "sharesOutstanding", entryCityId: homeCityId,
      field: corpField(corporationId, "sharesOutstanding"),
      value: issuedShares(corp) + newShares,
      formula: "M-02 issuance: sharesOutstanding (cumulative issued) grows by the new issuance",
    });
    const pct = (qty: number, total: number): string =>
      total > 0 ? `${((qty / total) * 100).toFixed(2)}%` : "—";
    const dilution = holdersBefore
      .map((h) => {
        const afterQty = h.quantityShares + (h.memberId === ownerId ? newShares : 0);
        return `${h.memberId}: ${pct(h.quantityShares, liveBefore)} → ${pct(afterQty, liveBefore + newShares)} (${h.quantityShares} → ${afterQty} shares)`;
      })
      .join("; ");
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: accFlush(acc, null),
        recordsUpdated: [holdingPath(ownerId, corporationId), listingPath(corporationId)],
        summaryText: `M-02 issuance for ${corporationId}: ${newShares} new shares issued to the founder (destination: ${destination}); live shares ${liveBefore} → ${liveBefore + newShares}. Dilution disclosed exactly (percentages are derived; existing holders' share counts do not move): ${dilution || "no other holders"}. Minority holders cannot block an issuance in v1 — their protection is this disclosure at this seq, before any later trade can occur (M-02 spillover note).`,
      })
    );
    const corpChanges = accFlush(acc, homeCityId);
    if (corpChanges.length > 0) {
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: homeCityId,
          cityIds: [homeCityId],
          ruleIds: [descriptorId],
          changes: corpChanges,
          recordsUpdated: [corpPath],
          summaryText: `M-02 issuance: ${corporationId}'s issued share count now stands at ${issuedShares(corp) + newShares}.`,
        })
      );
    }
    reprice(descriptorId);
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "issue-shares",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Issued ${newShares} new shares of ${corporationId} to the founder (destination: ${destination}); repricing ran in-event (M-06).`,
      major: true,
      extraClassification: { marketIssue: { branch, newShares, destination }, invokesRules: ["M-06"] },
    });
  }

  if (branch === "inject") {
    const amount = positiveAmount(ctx.action, "amountRubars");
    if (amount === null) {
      return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], "M-02 inject: amountRubars must be a positive integer.");
    }
    const fundingSource = stringField(ctx.action, "fundingSource") ?? "personal";
    if (fundingSource === "treasury") {
      return rejectedPlan(descriptorId, "treasury-source-suspended", [descriptorId, "P4-K21"], "M-02 inject: capital sourced from a city treasury is suspended in Phase 4 (P4-K21(ii)).");
    }
    if (fundingSource !== "personal") {
      return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], `M-02 inject: fundingSource "${fundingSource}" is not a lawful capital source (personal is the Phase 4 source).`);
    }
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: ownerId, viaActionKind: "market_issue" });
    const line: TransferLine = {
      from: personalRef(ownerId),
      to: companyRef(homeCityId, corporationId),
      amountRubars: amount,
      ruleId: descriptorId,
      memo: `capital injection into ${corporationId} (M-02)`,
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
    if (!applied.ok) {
      return rejectedPlan(
        descriptorId,
        applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
        [descriptorId],
        `M-02 inject: the injection of ${amount} R refused in full (transfer class): ${applied.message}`
      );
    }
    pushMovementEntries(plan, ctx, [descriptorId], applied.changes, (entryCityId) =>
      entryCityId === null
        ? `M-02 inject: ${ownerId}'s personal account paid ${amount} R into ${corporationId} (funding source: founder's personal account, recorded distinctly).`
        : `M-02 inject: ${corporationId}'s company cash received ${amount} R. The injection is a coded M-06 input — no multiplier touches valuation; repricing runs in this event.`
    );
    setField(plan, ctx.snapshot, acc, {
      path: corpPath, docField: "paidInCapitalRubars", entryCityId: homeCityId,
      field: corpField(corporationId, "paidInCapitalRubars"),
      value: intOr(corp, "paidInCapitalRubars", 0) + amount,
      formula: "M-02 inject: paid-in capital accumulates the injection (the step-7 composition maintains the figure F-03 leaves standing)",
    });
    const corpChanges = accFlush(acc, homeCityId);
    if (corpChanges.length > 0) {
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: homeCityId,
          cityIds: [homeCityId],
          ruleIds: [descriptorId],
          changes: corpChanges,
          recordsUpdated: [corpPath],
          summaryText: `M-02 inject: ${corporationId}'s paid-in capital now stands at ${intOr(corp, "paidInCapitalRubars", 0) + amount} R.`,
        })
      );
    }
    reprice(descriptorId);
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "inject-capital",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Injected ${amount} R of personal capital into ${corporationId}; repricing ran in-event (M-06).`,
      extraClassification: { marketIssue: { branch, amountRubars: amount, fundingSource }, invokesRules: ["M-06"] },
    });
  }

  if (branch === "place-float") {
    const quantity = positiveAmount(ctx.action, "quantityShares");
    if (quantity === null) {
      return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], "M-02 place-float: quantityShares must be a positive integer.");
    }
    const holding = plannedHolding(plan, ctx.snapshot, ownerId, corporationId);
    if (freeShares(holding) < quantity) {
      return rejectedPlan(descriptorId, "insufficient-free-shares", [descriptorId], `M-02 place-float: the founder holds ${freeShares(holding)} free shares of ${corporationId}; ${quantity} cannot be committed to the float.`);
    }
    const price = positiveAmount(ctx.action, "limitPriceRubars") ?? listing.referencePriceRubars;
    mutateHolding(plan, ctx.snapshot, acc, {
      memberId: ownerId,
      corporationId,
      homeCityId,
      deltaQuantity: 0,
      deltaCommitted: quantity,
      deltaCostBasis: 0,
      create: false,
      seq,
      resolutionId: ctx.resolutionId,
      now,
      formula: "M-02 place-float: founder shares commit behind the float offer (custody, P4-K21 — the shares do not move)",
    });
    placeOrGrowFloatOffer({
      plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
      founderMemberId: ownerId, addQuantity: quantity, priceRubars: price,
      seq, resolutionId: ctx.resolutionId, now,
      formula: "M-02 place-float: the standing float offer grows at the stated price",
    });
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "committedFloatShares", entryCityId: null,
      field: listingField(corporationId, "committedFloatShares"),
      value: listing.committedFloatShares + quantity,
      formula: "M-02 place-float: committed float grows by the placed quantity",
    });
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: accFlush(acc, null),
        recordsUpdated: [holdingPath(ownerId, corporationId), orderPath(floatOfferOrderId(corporationId)), listingPath(corporationId)],
        summaryText: `M-02 place-float for ${corporationId}: ${quantity} founder shares committed to the float at ${price} R (the float offer now stands at ${listing.committedFloatShares + quantity}). No §4.3 coded input changed, so no repricing runs — the index float inputs update in this event (§3.3). ${indexNote(plan, ctx.snapshot)}`,
      })
    );
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "place-float",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Placed ${quantity} shares of ${corporationId} into the float at ${price} R.`,
      extraClassification: { marketIssue: { branch, quantityShares: quantity, priceRubars: price } },
    });
  }

  // branch === "recall-float"
  const quantity = positiveAmount(ctx.action, "quantityShares");
  if (quantity === null) {
    return rejectedPlan(descriptorId, "malformed-issue", [descriptorId], "M-02 recall-float: quantityShares must be a positive integer.");
  }
  const offerPath = orderPath(floatOfferOrderId(corporationId));
  const offerDoc = plannedDoc(plan, ctx.snapshot, offerPath);
  const offer = offerDoc ? (offerDoc as unknown as MarketOrderRecord) : null;
  if (!offer || offer.status !== "resting") {
    return rejectedPlan(descriptorId, "no-float-offer", [descriptorId], `M-02 recall-float: no standing float offer rests for ${corporationId} — there is no committed float to recall.`);
  }
  if (quantity > offer.quantityShares) {
    return rejectedPlan(descriptorId, "float-recall-exceeds-offer", [descriptorId], `M-02 recall-float: the float offer for ${corporationId} stands at ${offer.quantityShares} shares; a recall of ${quantity} exceeds it and is refused whole (no silent trim).`);
  }
  const remainingOffer = offer.quantityShares - quantity;
  patchOrder(plan, ctx.snapshot, acc, offer.orderId, {
    quantityShares: remainingOffer,
    originalQuantityShares: offer.originalQuantityShares - quantity,
    ...(remainingOffer <= 0 ? { status: "cancelled" as const, cancelReason: "float-recall" } : {}),
  }, "M-02 recall-float: the standing float offer shrinks by the recalled quantity (custody release, P4-K21)");
  mutateHolding(plan, ctx.snapshot, acc, {
    memberId: ownerId,
    corporationId,
    homeCityId,
    deltaQuantity: 0,
    deltaCommitted: -quantity,
    deltaCostBasis: 0,
    create: false,
    seq,
    resolutionId: ctx.resolutionId,
    now,
    formula: "M-02 recall-float: the commitment releases — the shares never moved (custody, P4-K21)",
  });
  setField(plan, ctx.snapshot, acc, {
    path: listingPath(corporationId), docField: "committedFloatShares", entryCityId: null,
    field: listingField(corporationId, "committedFloatShares"),
    value: listing.committedFloatShares - quantity,
    formula: "M-02 recall-float: committed float falls by the recalled quantity",
  });
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: accFlush(acc, null),
      recordsUpdated: [offerPath, holdingPath(ownerId, corporationId), listingPath(corporationId)],
      summaryText: `M-02 recall-float for ${corporationId}: ${quantity} shares released from the float offer (${remainingOffer} remain committed). Under custody the shares never left the founder's holding — recall is the release of a commitment, not a transfer (P4-K21). No §4.3 coded input changed, so no repricing runs. ${indexNote(plan, ctx.snapshot)}`,
    })
  );
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "recall-float",
    scope: "company",
    cityId: homeCityId,
    summaryText: `Recalled ${quantity} shares of ${corporationId} from the float (${remainingOffer} remain offered).`,
    extraClassification: { marketIssue: { branch, quantityShares: quantity } },
  });
}

// ---------------------------------------------------------------------------
// M-03 — place an order (matching + settlement compose in-event as
// M-04; expiry evaluates first as M-05). Any member may trade (§1.9);
// shares are economic-only and no city authority is involved.
// ---------------------------------------------------------------------------

function placeOrderHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-03";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "M-03: orders are always a named member's — the actor carries no member identity.");
  }
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  if (!corporationId || !homeCityId) {
    return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: place_order requires corporationId and homeCityId.");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const { listing } = gate;
  if (listing.tradingStatus === "halted") {
    return rejectedPlan(descriptorId, "listing-halted", [descriptorId], `M-03: trading in ${corporationId} is halted (${listing.haltReason ?? "coded condition"}) — orders are rejected while the halt stands (§1.8). Resting orders remain and may be cancelled.`);
  }
  if (listing.tradingStatus === "suspended") {
    return rejectedPlan(descriptorId, "listing-suspended", [descriptorId], `M-03: trading in ${corporationId} is suspended by its owner (M-07) — orders are rejected while the suspension stands.`);
  }
  if (!snapshotDoc(ctx.snapshot, MARKET_ACCOUNT_PATH)) {
    return rejectedPlan(descriptorId, "market-account-missing", [descriptorId], "M-03: the Market Account does not stand — the exchange's founding act (M-00) is a named gate item, and fee legs cannot settle without it. It is never lazy-invented inside a trade.");
  }
  const side = stringField(ctx.action, "side");
  if (side !== "buy" && side !== "sell") {
    return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: side must be buy | sell.");
  }
  const orderType = stringField(ctx.action, "orderType");
  if (orderType !== "market" && orderType !== "limit" && orderType !== "block") {
    return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: orderType must be market | limit | block (§1.5).");
  }
  const quantity = positiveAmount(ctx.action, "quantityShares");
  if (quantity === null) {
    return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: quantityShares must be a positive integer.");
  }
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const expiresAtSeq = sa(ctx.action).expiresAtSeq;
  if (expiresAtSeq !== undefined && expiresAtSeq !== null) {
    if (typeof expiresAtSeq !== "number" || !Number.isInteger(expiresAtSeq) || expiresAtSeq <= seq) {
      return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: expiresAtSeq, when stated, must be a future seq horizon (expiry is a seq, never a wall-clock timer, §1.5).");
    }
  }
  let effectiveCap: number;
  if (orderType === "limit") {
    const limit = positiveAmount(ctx.action, "limitPriceRubars");
    if (limit === null) {
      return rejectedPlan(descriptorId, "malformed-order", [descriptorId], "M-03: a limit order states limitPriceRubars (a positive integer).");
    }
    effectiveCap = limit;
  } else if (orderType === "market") {
    const cap = positiveAmount(ctx.action, "limitPriceRubars") ?? positiveAmount(ctx.action, "protectionPriceRubars");
    if (cap === null) {
      return rejectedPlan(descriptorId, "protection-cap-required", [descriptorId], "M-03: a market order carries a mandatory protection cap (maximum price for a buy, minimum for a sell, §1.5) — an unprotected market order in a thin book is a blank cheque and is never accepted.");
    }
    effectiveCap = cap;
  } else {
    effectiveCap = blockProtectionCapRubars(side, listing.referencePriceRubars);
  }

  const plan = emptyPlan(descriptorId);
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();

  // Step 0 (§1.4): the actor's account lazy-opens before any line.
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: actorId, viaActionKind: "place_order" });

  // Expiry evaluates first (M-05 mechanism, in-event).
  const expired = expirySweep({
    plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
    seq, resolutionId: ctx.resolutionId, now,
  });
  if (expired.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId, "M-05"],
        changes: accFlush(acc, null),
        recordsUpdated: expired.map((o) => orderPath(o.orderId)),
        summaryText: `M-05 expiry evaluated in this event: ${expired.map((o) => `${o.orderId} (${o.side} ${o.originalQuantityShares} by ${o.memberId}, expiresAtSeq ${o.expiresAtSeq})`).join("; ")} — status expired; committed shares released. Expiry is evaluated when an event touches the listing, never by a timer.`,
      })
    );
  }

  const { book, docsById, malformed } = buildEngineBook(plan, ctx.snapshot, corporationId);

  // Placement validation (§1.6 step 7): sells against free shares;
  // buys against worst-case cash (cap value + per-execution fee
  // headroom: each crossing execution's fee rounds up, so the bound
  // adds one Rubar of rounding per crossing resting order).
  if (side === "sell") {
    const holding = plannedHolding(plan, ctx.snapshot, actorId, corporationId);
    if (freeShares(holding) < quantity) {
      return rejectedPlan(descriptorId, "insufficient-free-shares", [descriptorId], `M-03: ${actorId} holds ${freeShares(holding)} free shares of ${corporationId} (quantity minus committed); a sell of ${quantity} is rejected at validation, never partially settled into a negative (§1.6 step 7). Short selling is out of v1 (§1.5).`);
    }
  } else {
    const crossing = book.filter(
      (o) => o.side === "sell" && o.limitPriceRubars <= effectiveCap && o.memberId !== actorId
    ).length;
    const worstValue = quantity * effectiveCap;
    const worstTotal = worstValue + Math.ceil(worstValue * 0.0025) + crossing;
    const cash = plannedBalance(plan, ctx.snapshot, personalRef(actorId));
    if (cash === null || cash < worstTotal) {
      return rejectedPlan(descriptorId, "insufficient-cash", [descriptorId], `M-03: a ${side} of ${quantity} shares at a cap of ${effectiveCap} R needs up to ${worstTotal} R (value + fee headroom); ${actorId}'s account holds ${cash ?? 0} R. The order is rejected at validation, never partially settled into a negative (§1.6 step 7). Resting buys carry no cash reservation in v1 — sufficiency is re-validated at crossing (prep report D-5).`);
    }
  }

  // Counterparties settle in this event: their accounts stand ready
  // (step 0 for the book — a resting order's owner opened theirs at
  // placement; this covers any record gap defensively).
  const bookOwners = [...new Set(book.map((o) => o.memberId))].sort();
  for (const owner of bookOwners) {
    if (owner !== actorId) {
      composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: owner, viaActionKind: "place_order" });
    }
  }

  // Matching (§1.6), with D-5's crossing re-validation: a resting
  // buyer who cannot cover an execution is cancelled in-event and
  // matching continues against the reduced book.
  const incomingOrderId = `ord_${ctx.resolutionId}`;
  const runningCash = new Map<string, number>();
  const cashOf = (memberId: string): number => {
    const cached = runningCash.get(memberId);
    if (cached !== undefined) return cached;
    const value = plannedBalance(plan, ctx.snapshot, personalRef(memberId)) ?? 0;
    runningCash.set(memberId, value);
    return value;
  };
  const accepted: { execution: Execution; resting: MarketOrderRecord }[] = [];
  const cancelledResting: MarketOrderRecord[] = [];
  let bookState = book.map((o) => ({ ...o }));
  let remaining = quantity;
  let selfMatchSkipped = false;
  while (remaining > 0) {
    const result = matchIncomingOrder(
      {
        orderId: incomingOrderId,
        listingId: corporationId,
        memberId: actorId,
        side,
        type: orderType === "limit" ? "limit" : "market",
        quantityShares: remaining,
        limitPriceRubars: effectiveCap,
      },
      bookState,
      "open"
    );
    selfMatchSkipped = selfMatchSkipped || result.selfMatchSkipped;
    if (result.executions.length === 0) break;
    let failedOrderId: string | null = null;
    for (const execution of result.executions) {
      if (side === "sell") {
        const value = execution.quantityShares * execution.priceRubars;
        const cost = value + exchangeFeeRubars(value);
        if (cashOf(execution.buyerMemberId) < cost) {
          failedOrderId = execution.restingOrderId;
          break;
        }
        runningCash.set(execution.buyerMemberId, cashOf(execution.buyerMemberId) - cost);
      }
      const resting = docsById.get(execution.restingOrderId);
      if (!resting) continue;
      accepted.push({ execution, resting });
      remaining -= execution.quantityShares;
      bookState = bookState
        .map((o) =>
          o.orderId === execution.restingOrderId
            ? { ...o, quantityShares: o.quantityShares - execution.quantityShares }
            : o
        )
        .filter((o) => o.quantityShares > 0);
    }
    if (failedOrderId) {
      const failed = docsById.get(failedOrderId);
      if (failed) cancelledResting.push(failed);
      bookState = bookState.filter((o) => o.orderId !== failedOrderId);
      continue;
    }
    break;
  }

  if (accepted.length > 0) {
    const settledResult = settleMemberExecutions({
      plan,
      snapshot: ctx.snapshot,
      acc,
      actor: ctx.action.actor,
      resolutionId: ctx.resolutionId,
      corporationId,
      homeCityId,
      founderMemberId: listing.ownerMemberId,
      incomingOrderId,
      accepted,
      seq,
      now,
    });
    if (!settledResult.ok) {
      return rejectedPlan(
        descriptorId,
        settledResult.code === "INSUFFICIENT_FUNDS" ? "insufficient-cash" : settledResult.code.toLowerCase().replace(/_/g, "-"),
        [descriptorId, "M-04"],
        `M-03/M-04: settlement refused in full: ${settledResult.message}`
      );
    }
  }

  // Resting buyers cancelled at crossing (D-5): commitments were cash
  // (unreserved), so cancellation is a bookkeeping act only.
  if (cancelledResting.length > 0) {
    const cancelAcc: ChangeAcc = new Map();
    for (const order of cancelledResting) {
      patchOrder(plan, ctx.snapshot, cancelAcc, order.orderId, {
        status: "cancelled",
        cancelReason: "insufficient-cash-at-settlement",
      }, "M-05/D-5: a resting buy is re-validated at crossing; insufficient cash cancels it in-event and matching continues");
    }
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId, "M-05"],
        changes: accFlush(cancelAcc, null),
        recordsUpdated: cancelledResting.map((o) => orderPath(o.orderId)),
        summaryText: `M-05 in-event cancellation: ${cancelledResting.map((o) => `${o.orderId} (buy ${o.quantityShares} at ${o.limitPriceRubars} R by ${o.memberId})`).join("; ")} — cancelled-insufficient-cash: a resting buy carries no cash reservation in v1, so crossing re-validates the buyer; their cash could not cover the execution and the order was cancelled rather than settled into a negative (§1.6 step 7).`,
      })
    );
  }

  // The incoming order's own record: placed in full, with its final
  // disposition (filled | resting remainder | cancelled remainder).
  const filled = quantity - remaining;
  const finalStatus =
    remaining === 0 ? "filled" : orderType === "limit" ? "resting" : "cancelled";
  const incomingDoc: Record<string, unknown> = {
    ...buildOrderDoc({
      orderId: incomingOrderId,
      corporationId,
      homeCityId,
      memberId: actorId,
      side,
      type: orderType,
      kind: "standard",
      quantityShares: quantity,
      limitPriceRubars: effectiveCap,
      placedAtSeq: seq,
      expiresAtSeq: typeof expiresAtSeq === "number" ? expiresAtSeq : null,
      sourceActionId: ctx.action.actionId,
      lastResolutionId: ctx.resolutionId,
      now,
    }),
    quantityShares: remaining,
    filledShares: filled,
    status: finalStatus,
    cancelReason: finalStatus === "cancelled" ? "unfilled-market-remainder" : null,
  };
  planWrite(plan, ctx.snapshot, orderPath(incomingOrderId), incomingDoc, "state", [
    "quantityShares",
    "filledShares",
    "status",
    "limitPriceRubars",
  ]);
  accChange(acc, null, orderField(incomingOrderId, "status"), null, finalStatus, "M-03: the order as placed and finally disposed in this event");
  if (finalStatus === "resting" && side === "sell" && remaining > 0) {
    mutateHolding(plan, ctx.snapshot, acc, {
      memberId: actorId,
      corporationId,
      homeCityId,
      deltaQuantity: 0,
      deltaCommitted: remaining,
      deltaCostBasis: 0,
      create: false,
      seq,
      resolutionId: ctx.resolutionId,
      now,
      formula: "M-03: the resting remainder's shares commit at placement (only free shares can ever be sold or transferred, §5.4)",
    });
  }
  const placementChanges = accFlush(acc, null);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: placementChanges,
      recordsCreated: [orderPath(incomingOrderId)],
      recordsUpdated: [listingPath(corporationId), holdingPath(actorId, corporationId)],
      summaryText:
        `M-03 order ${incomingOrderId}: ${actorId} ${side} ${quantity} shares of ${corporationId}, type ${orderType}, cap/limit ${effectiveCap} R — filled ${filled}, remainder ${remaining} ${finalStatus === "resting" ? "rests in the book" : finalStatus === "cancelled" ? "cancelled (market/block remainders never rest, §1.6 step 6)" : ""}.` +
        (selfMatchSkipped ? " Self-match skipped: the incoming order never executes against the same member's resting orders (§1.6 step 5)." : "") +
        (malformed.length > 0 ? ` Book note: resting order(s) ${malformed.join(", ")} carry no price and were skipped by matching (corrupt record — cancellable by their owner; remedy is M-11).` : "") +
        ` Market Maker quote at placement (reference ± half-spread, §1.7): bid ${marketMakerQuote(listing.referencePriceRubars).bidRubars} R / ask ${marketMakerQuote(listing.referencePriceRubars).askRubars} R — the quote is display and block-cap input only; under custody the Maker holds no inventory and executions run against the book (P4-K21).`,
    })
  );
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "place-order",
    scope: "market",
    cityId: homeCityId,
    summaryText: `${actorId} placed a ${orderType} ${side} for ${quantity} shares of ${corporationId} at cap/limit ${effectiveCap} R: filled ${filled}, remainder ${remaining} ${finalStatus}.`,
    extraClassification: {
      marketOrder: {
        orderId: incomingOrderId,
        side,
        orderType,
        quantityShares: quantity,
        filledShares: filled,
        remainderShares: remaining,
        disposition: finalStatus,
        effectiveCapRubars: effectiveCap,
        selfMatchSkipped,
        expiredOrderIds: expired.map((o) => o.orderId),
        cancelledInsufficientCashOrderIds: cancelledResting.map((o) => o.orderId),
      },
      ...(accepted.length > 0 ? { invokesRules: ["M-04"] } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// M-04 (transfer path) — a zero-price member-to-member transfer of
// shares, confirmed as its own action so the ledger and Log stay
// complete (§1.6 step 8: there are no off-Log transfers). Fees are
// zero — and the fee line is still stated in the entry (§5.3). The
// execution path of M-04 composes inside M-03/M-09 events
// (settleMemberExecutions); this handler is the transfer path only.
// ---------------------------------------------------------------------------

function transferSharesHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-04";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "M-04: a transfer is a named member's act.");
  }
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  const toMemberId = stringField(ctx.action, "toMemberId");
  const quantity = positiveAmount(ctx.action, "quantityShares");
  if (!corporationId || !homeCityId || !toMemberId || quantity === null) {
    return rejectedPlan(descriptorId, "malformed-transfer", [descriptorId], "M-04: transfer_shares requires corporationId, homeCityId, toMemberId and a positive quantityShares.");
  }
  if (toMemberId === actorId) {
    return rejectedPlan(descriptorId, "self-transfer", [descriptorId], "M-04: a transfer to oneself moves nothing and is not an event.");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const { listing } = gate;
  const sellerHolding = readHolding(ctx.snapshot, actorId, corporationId);
  if (freeShares(sellerHolding) < quantity) {
    return rejectedPlan(descriptorId, "insufficient-free-shares", [descriptorId], `M-04: ${actorId} holds ${freeShares(sellerHolding)} free shares of ${corporationId}; only free shares can be transferred (§5.4).`);
  }
  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();
  mutateHolding(plan, ctx.snapshot, acc, {
    memberId: actorId,
    corporationId,
    homeCityId,
    deltaQuantity: -quantity,
    deltaCommitted: 0,
    deltaCostBasis: 0,
    create: false,
    seq,
    resolutionId: ctx.resolutionId,
    now,
    formula: "M-04 transfer: the transferor delivers free shares at a zero price",
  });
  mutateHolding(plan, ctx.snapshot, acc, {
    memberId: toMemberId,
    corporationId,
    homeCityId,
    deltaQuantity: quantity,
    deltaCommitted: 0,
    deltaCostBasis: 0,
    create: true,
    seq,
    resolutionId: ctx.resolutionId,
    now,
    formula: "M-04 transfer: the recipient's holding gains the shares; a zero-price acquisition adds zero cost basis (§5.4)",
  });
  let publicDelta = 0;
  if (toMemberId !== listing.ownerMemberId) publicDelta += quantity;
  if (actorId !== listing.ownerMemberId) publicDelta -= quantity;
  if (publicDelta !== 0) {
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "publicHeldShares", entryCityId: null,
      field: listingField(corporationId, "publicHeldShares"),
      value: listing.publicHeldShares + publicDelta,
      formula: "M-04 transfer: shares moving between founder and public hands re-count the public float",
    });
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: accFlush(acc, null),
      recordsUpdated: [
        holdingPath(actorId, corporationId),
        holdingPath(toMemberId, corporationId),
        listingPath(corporationId),
      ],
      summaryText: `M-04 transfer: ${actorId} transferred ${quantity} shares of ${corporationId} to ${toMemberId} at a zero price — value 0 R; buyer fee 0 R; seller fee 0 R (the fee line stands in every trade entry even at zero, §5.3). No price prints: the listing's last-trade and official prices do not move on a transfer. Trading status stands ${listing.tradingStatus} — a transfer is an ownership record, not an execution, and a halt does not freeze gifts.`,
    })
  );
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "transfer-shares",
    scope: "market",
    cityId: homeCityId,
    summaryText: `Transferred ${quantity} shares of ${corporationId} from ${actorId} to ${toMemberId} at a zero price (fees 0 R).`,
    extraClassification: { marketTransfer: { fromMemberId: actorId, toMemberId, quantityShares: quantity, priceRubars: 0 } },
  });
}

// ---------------------------------------------------------------------------
// M-05 — cancel / expire an order. Cancellation is free and instant;
// the anti-manipulation control is transparency (§1.5). Expiry is the
// sweep (above), evaluated by every book-touching event.
// ---------------------------------------------------------------------------

function cancelOrderHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-05";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "M-05: a cancel is the order owner's act.");
  }
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  if (!corporationId || !homeCityId) {
    return rejectedPlan(descriptorId, "malformed-cancel", [descriptorId], "M-05: cancel_order requires corporationId and homeCityId.");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const orderId = stringField(ctx.action, "orderId");
  const allForListing = sa(ctx.action).allForListing === true;
  if (!orderId && !allForListing) {
    return rejectedPlan(descriptorId, "malformed-cancel", [descriptorId], "M-05: cancel_order names an orderId, or allForListing: true to cancel all of the actor's resting orders on the listing (§1.5).");
  }
  if (orderId) {
    const targetDoc = snapshotDoc(ctx.snapshot, orderPath(orderId));
    if (!targetDoc) {
      return rejectedPlan(descriptorId, "order-not-found", [descriptorId], `M-05: no order record ${orderId} stands.`);
    }
    const target = targetDoc as unknown as MarketOrderRecord;
    if (target.corporationId !== corporationId) {
      return rejectedPlan(descriptorId, "order-not-found", [descriptorId], `M-05: order ${orderId} belongs to ${target.corporationId}, not ${corporationId}.`);
    }
    if (target.memberId !== actorId) {
      return rejectedPlan(descriptorId, "not-order-owner", [descriptorId], `M-05: order ${orderId} belongs to ${target.memberId} — a member cancels only their own orders.`);
    }
  }

  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();
  const expired = expirySweep({
    plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
    seq, resolutionId: ctx.resolutionId, now,
  });
  if (expired.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: accFlush(acc, null),
        recordsUpdated: expired.map((o) => orderPath(o.orderId)),
        summaryText: `M-05 expiry evaluated in this event: ${expired.map((o) => o.orderId).join(", ")} — status expired; committed shares released.`,
      })
    );
  }

  // Targets after the sweep (an order the sweep just expired is done —
  // the cancel's intent is achieved and the plan says so).
  const targets: MarketOrderRecord[] = [];
  if (orderId) {
    const planned = plannedDoc(plan, ctx.snapshot, orderPath(orderId));
    const order = planned ? (planned as unknown as MarketOrderRecord) : null;
    if (order && order.status === "resting") {
      targets.push(order);
    } else if (order && expired.some((o) => o.orderId === orderId)) {
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: null,
          cityIds: [],
          ruleIds: [descriptorId],
          changes: [],
          summaryText: `M-05: order ${orderId} expired in this event's sweep before the cancel landed — it no longer rests, which is what the cancel asked for.`,
        })
      );
      pruneRecordClaims(plan);
      return finishPlan(plan, ctx, {
        ruleId: descriptorId,
        verb: "cancel-order",
        scope: "market",
        cityId: homeCityId,
        summaryText: `Order ${orderId} expired at this event's evaluation; the cancel is satisfied by the expiry.`,
        extraClassification: { marketCancel: { orderId, disposition: "expired-in-event" } },
      });
    } else {
      return rejectedPlan(descriptorId, "order-not-resting", [descriptorId], `M-05: order ${orderId} stands "${order?.status ?? "unknown"}" — only a resting order can be cancelled.`);
    }
  } else {
    for (const { doc } of bookDocs(ctx.snapshot)) {
      const planned = plannedDoc(plan, ctx.snapshot, orderPath(String(doc.orderId))) ?? doc;
      const order = planned as unknown as MarketOrderRecord;
      if (order.status === "resting" && order.memberId === actorId && order.corporationId === corporationId) {
        targets.push(order);
      }
    }
    if (targets.length === 0) {
      return rejectedPlan(descriptorId, "no-resting-orders", [descriptorId], `M-05: ${actorId} has no resting orders on ${corporationId} to cancel.`);
    }
  }

  const listing = plannedListing(plan, ctx.snapshot, corporationId) ?? gate.listing;
  for (const order of targets) {
    patchOrder(plan, ctx.snapshot, acc, order.orderId, {
      status: "cancelled",
      cancelReason: "owner-cancel",
    }, "M-05: owner cancel — free and instant (§1.5)");
    if (order.side === "sell" && order.quantityShares > 0) {
      mutateHolding(plan, ctx.snapshot, acc, {
        memberId: order.memberId,
        corporationId,
        homeCityId,
        deltaQuantity: 0,
        deltaCommitted: -order.quantityShares,
        deltaCostBasis: 0,
        create: false,
        seq,
        resolutionId: ctx.resolutionId,
        now,
        formula: "M-05: cancellation releases the order's committed shares",
      });
      if (order.kind === "float-offer") {
        const current = plannedListing(plan, ctx.snapshot, corporationId);
        if (current) {
          setField(plan, ctx.snapshot, acc, {
            path: listingPath(corporationId), docField: "committedFloatShares", entryCityId: null,
            field: listingField(corporationId, "committedFloatShares"),
            value: current.committedFloatShares - order.quantityShares,
            formula: "M-05: cancelling the float offer releases the committed float (equivalent to an M-02 recall)",
          });
        }
      }
    }
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: accFlush(acc, null),
      recordsUpdated: [
        ...targets.map((o) => orderPath(o.orderId)),
        holdingPath(actorId, corporationId),
        listingPath(corporationId),
      ],
      summaryText: `M-05 cancel: ${targets.map((o) => `${o.orderId} (${o.side} ${o.quantityShares} at ${o.limitPriceRubars} R${o.kind === "float-offer" ? ", the float offer" : ""})`).join("; ")} — cancelled by the owner; committed shares released. The listing's trading status stands ${listing.tradingStatus} — cancellation is lawful in any status.`,
    })
  );
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "cancel-order",
    scope: "market",
    cityId: homeCityId,
    summaryText: `Cancelled ${targets.length} resting order(s) on ${corporationId}: ${targets.map((o) => o.orderId).join(", ")}.`,
    extraClassification: { marketCancel: { orderIds: targets.map((o) => o.orderId), disposition: "owner-cancel" } },
  });
}

// ---------------------------------------------------------------------------
// M-07 — suspend / resume a listing (owner). Suspension is a choice,
// never a penalty (§1.8); resumption re-evaluates the coded halt
// condition — a halt whose condition still holds never resumes.
// ---------------------------------------------------------------------------

function suspendResumeHandler(mode: "suspend" | "resume") {
  return (ctx: HandlerContext): ResolutionPlan => {
    const descriptorId = "M-07";
    const npc = rejectNpc(ctx, descriptorId);
    if (npc) return npc;
    const corporationId = stringField(ctx.action, "corporationId");
    const homeCityId = stringField(ctx.action, "homeCityId");
    if (!corporationId || !homeCityId) {
      return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "M-07: the action requires corporationId and homeCityId.");
    }
    const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
    if (isPlan(gate)) return gate;
    const ownerGate = requireOwner(ctx, descriptorId, gate.corp, corporationId);
    if (isPlan(ownerGate)) return ownerGate;
    const { corp, listing } = gate;
    const reason = stringField(ctx.action, "reason") ?? "";
    const plan = emptyPlan(descriptorId);
    const acc: ChangeAcc = new Map();

    if (mode === "suspend") {
      if (listing.tradingStatus === "suspended") {
        return rejectedPlan(descriptorId, "already-suspended", [descriptorId], `M-07: ${corporationId} is already suspended.`);
      }
      setField(plan, ctx.snapshot, acc, {
        path: listingPath(corporationId), docField: "tradingStatus", entryCityId: null,
        field: listingField(corporationId, "tradingStatus"), value: "suspended",
        formula: "M-07: owner-confirmed suspension — the company goes deliberately dormant (§1.8)",
      });
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: null,
          cityIds: [],
          ruleIds: [descriptorId],
          changes: accFlush(acc, null),
          recordsUpdated: [listingPath(corporationId)],
          summaryText: `M-07 suspend: ${corporationId} is suspended by its owner (was ${listing.tradingStatus}). Owner's stated reason: ${reason === "" ? "(none stated)" : `"${reason}"`}. Shares remain held; resting orders persist, unexecutable; new orders reject as listing-suspended. Suspension changes no price.`,
        })
      );
      pruneRecordClaims(plan);
      return finishPlan(plan, ctx, {
        ruleId: descriptorId,
        verb: "suspend-listing",
        scope: "company",
        cityId: homeCityId,
        summaryText: `Suspended trading in ${corporationId} (owner's act, M-07).`,
        extraClassification: { listingStatus: { transition: `${listing.tradingStatus}->suspended`, reason } },
      });
    }

    // resume
    if (listing.tradingStatus !== "suspended" && listing.tradingStatus !== "halted") {
      return rejectedPlan(descriptorId, "not-suspended", [descriptorId], `M-07: ${corporationId} stands "${listing.tradingStatus}" — there is no suspension or halt to resume from.`);
    }
    const { inputs } = assembleCodedInputs(plan, ctx.snapshot, corp, homeCityId);
    if (inputs.downtimeFlag) {
      return rejectedPlan(descriptorId, "halt-condition-holds", [descriptorId], `M-07: ${corporationId} cannot resume — the coded downtime condition still holds (it has linked structures and none is functioning, §1.8). No unhalt exists for a halt whose condition stands; resumption lands in the event that clears it (a repair), or here once one has.`);
    }
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "tradingStatus", entryCityId: null,
      field: listingField(corporationId, "tradingStatus"), value: "open",
      formula: "M-07: owner resume with the coded halt condition verified clear",
    });
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "haltReason", entryCityId: null,
      field: listingField(corporationId, "haltReason"), value: null,
      formula: "M-07: halt cause cleared",
    });
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: accFlush(acc, null),
        recordsUpdated: [listingPath(corporationId)],
        summaryText: `M-07 resume: ${corporationId} trades again (was ${listing.tradingStatus}${listing.haltReason ? `, halt cause ${listing.haltReason}` : ""}). The coded downtime condition was re-evaluated in this event and does not hold. Owner's stated reason: ${reason === "" ? "(none stated)" : `"${reason}"`}.`,
      })
    );
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "resume-listing",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Resumed trading in ${corporationId} (owner's act, M-07; halt condition verified clear).`,
      extraClassification: { listingStatus: { transition: `${listing.tradingStatus}->open`, reason } },
    });
  };
}

// ---------------------------------------------------------------------------
// M-08 — declare a distribution (dividend). The exported composer is
// also the leg Catalogue II's listed Contract cash withdrawal routes
// through under P4-K22 (Lead wiring, prep report §5): a listed
// company's cash reaches its owner ONLY pro-rata through here (or
// retires shares through M-09) — never as a bare company -> owner
// line. Refuse-in-full discipline: a distribution the company's cash
// cannot cover is refused, never trimmed silently.
// ---------------------------------------------------------------------------

export type DistributionOutcome =
  | {
      status: "distributed";
      paidOutRubars: number;
      remainderRubars: number;
      perHolder: { memberId: string; quantityShares: number; amountRubars: number }[];
    }
  | { status: "refused"; code: string; message: string };

export function composeDistribution(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  actor: HandlerContext["action"]["actor"];
  corporationId: string;
  homeCityId: string;
  totalRubars: number;
  invokedByRuleId: string;
  entryRuleIds: string[];
}): DistributionOutcome {
  const { plan, snapshot } = args;
  const corpPath = corporationPath(args.homeCityId, args.corporationId);
  const corp = plannedDoc(plan, snapshot, corpPath);
  if (!corp) {
    return { status: "refused", code: "company-not-found", message: `no corporation record for ${args.corporationId} in ${args.homeCityId}` };
  }
  const holders = holdingDocs(snapshot)
    .map(({ doc }) => doc as unknown as ShareHoldingRecord)
    .filter((h) => h.corporationId === args.corporationId && h.quantityShares > 0)
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  const heldTotal = holders.reduce((sum, h) => sum + h.quantityShares, 0);
  const live = liveShares(corp);
  if (heldTotal !== live) {
    return {
      status: "refused",
      code: "share-ledger-inconsistent",
      message: `holdings sum to ${heldTotal} shares against ${live} live shares on the record — the market refuses to distribute against a ledger that disagrees with itself (§1.8 posture; remedy is the correction path, M-11)`,
    };
  }
  if (holders.length === 0) {
    return { status: "refused", code: "no-shareholders", message: `no shareholder of record holds shares of ${args.corporationId}` };
  }
  const cash = plannedBalance(plan, snapshot, companyRef(args.homeCityId, args.corporationId));
  if (cash === null || args.totalRubars > cash) {
    return {
      status: "refused",
      code: "distribution-exceeds-cash",
      message: `the declared distribution of ${args.totalRubars} R exceeds ${args.corporationId}'s company cash of ${cash ?? 0} R — refused in full, never trimmed silently (the owner may re-confirm the coverable maximum)`,
    };
  }
  // Recipients receive into personal accounts (step 0 for each, in
  // member order — a shareholder who never opened one is opened under
  // F-01 exactly like any first money touch).
  for (const holder of holders) {
    composeLazyOpen({ plan, snapshot, actor: args.actor, memberId: holder.memberId, viaActionKind: "declare_distribution" });
  }
  const perHolder = holders.map((h) => ({
    memberId: h.memberId,
    quantityShares: h.quantityShares,
    amountRubars: Math.floor((args.totalRubars * h.quantityShares) / live),
  }));
  const lines: TransferLine[] = perHolder
    .filter((p) => p.amountRubars > 0)
    .map((p) => ({
      from: companyRef(args.homeCityId, args.corporationId),
      to: personalRef(p.memberId),
      amountRubars: p.amountRubars,
      ruleId: "M-08",
      memo: `distribution from ${args.corporationId} — pro-rata on ${p.quantityShares} shares of record`,
    }));
  const applied = applyTransferLines({ plan, snapshot, lines, shortfallClass: "transfer" });
  if (!applied.ok) {
    return { status: "refused", code: applied.code.toLowerCase().replace(/_/g, "-"), message: applied.message };
  }
  const paidOutRubars = perHolder.reduce((sum, p) => sum + p.amountRubars, 0);
  const remainderRubars = args.totalRubars - paidOutRubars;
  pushMovementEntries(plan, { action: { actor: args.actor } }, args.entryRuleIds, applied.changes, (entryCityId) =>
    entryCityId === null
      ? `M-08 distribution from ${args.corporationId} (invoked by ${args.invokedByRuleId}): ${perHolder.map((p) => `${p.memberId} +${p.amountRubars} R (${p.quantityShares} shares)`).join("; ")}.`
      : `M-08 distribution: ${args.corporationId}'s company cash paid out ${paidOutRubars} R of the declared ${args.totalRubars} R; the ${remainderRubars} R integer-division remainder stays in company cash, logged — never rounded into anyone's pocket.`
  );
  return { status: "distributed", paidOutRubars, remainderRubars, perHolder };
}

function declareDistributionHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-08";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  const total = positiveAmount(ctx.action, "totalRubars") ?? positiveAmount(ctx.action, "amountRubars");
  if (!corporationId || !homeCityId || total === null) {
    return rejectedPlan(descriptorId, "malformed-distribution", [descriptorId], "M-08: declare_distribution requires corporationId, homeCityId and totalRubars (a positive integer — the gross amount declared).");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const ownerGate = requireOwner(ctx, descriptorId, gate.corp, corporationId);
  if (isPlan(ownerGate)) return ownerGate;
  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const outcome = composeDistribution({
    plan,
    snapshot: ctx.snapshot,
    actor: ctx.action.actor,
    corporationId,
    homeCityId,
    totalRubars: total,
    invokedByRuleId: descriptorId,
    entryRuleIds: [descriptorId],
  });
  if (outcome.status === "refused") {
    return rejectedPlan(descriptorId, outcome.code, [descriptorId], `M-08: ${outcome.message}.`);
  }
  composeMarketRepricing({
    plan,
    snapshot: ctx.snapshot,
    actor: ctx.action.actor,
    corporationId,
    homeCityId,
    judgment: judgmentFromPrepared(ctx),
    judgmentRationale: judgmentRationaleFromPrepared(ctx),
    judgmentInputHash: ctx.prepared?.inputHash ?? null,
    stepCapException: null,
    invokedByRuleId: descriptorId,
  });
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "declare-distribution",
    scope: "company",
    cityId: homeCityId,
    summaryText: `Declared a distribution of ${total} R from ${corporationId}: ${outcome.paidOutRubars} R paid pro-rata to ${outcome.perHolder.length} shareholder(s) of record at seq ${seq}; ${outcome.remainderRubars} R of integer-division remainder stays in company cash. Repricing ran in-event (M-06).`,
    major: true,
    extraClassification: {
      distribution: {
        totalRubars: total,
        paidOutRubars: outcome.paidOutRubars,
        remainderRubars: outcome.remainderRubars,
        recordSeq: seq,
        perHolder: outcome.perHolder,
      },
      invokesRules: ["M-06"],
    },
  });
}

// ---------------------------------------------------------------------------
// M-09 — buy back shares. The company buys through the book, in the
// open (never directly off-book from the founder — that would be a
// disguised cash withdrawal, §5.2 seam), funded from company cash at
// a stated cap; bought shares retire. Partial fills are lawful: the
// sweep stops when the quantity, the cap, or the cash binds. A
// zero-fill buyback resolves as a logged no-op, not a rejection.
// ---------------------------------------------------------------------------

function buyBackSharesHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-09";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  const maxQuantity = positiveAmount(ctx.action, "maxQuantityShares") ?? positiveAmount(ctx.action, "quantityShares");
  const capPrice = positiveAmount(ctx.action, "capPriceRubars") ?? positiveAmount(ctx.action, "limitPriceRubars");
  if (!corporationId || !homeCityId || maxQuantity === null || capPrice === null) {
    return rejectedPlan(descriptorId, "malformed-buyback", [descriptorId], "M-09: buy_back_shares requires corporationId, homeCityId, maxQuantityShares and capPriceRubars (positive integers).");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const ownerGate = requireOwner(ctx, descriptorId, gate.corp, corporationId);
  if (isPlan(ownerGate)) return ownerGate;
  const { corp, corpPath, listing } = gate;
  if (listing.tradingStatus === "halted") {
    return rejectedPlan(descriptorId, "listing-halted", [descriptorId], `M-09: trading in ${corporationId} is halted — a buyback executes through the book, and the book does not execute while halted (§1.8).`);
  }
  if (listing.tradingStatus === "suspended") {
    return rejectedPlan(descriptorId, "listing-suspended", [descriptorId], `M-09: trading in ${corporationId} is suspended — a buyback executes through the book, and the book does not execute while suspended.`);
  }
  if (!snapshotDoc(ctx.snapshot, MARKET_ACCOUNT_PATH)) {
    return rejectedPlan(descriptorId, "market-account-missing", [descriptorId], "M-09: the Market Account does not stand — execution fees cannot settle without it (M-00 founds it; it is never lazy-invented inside a trade).");
  }
  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const now = new Date(ctx.snapshot.now);
  const acc: ChangeAcc = new Map();
  const expired = expirySweep({
    plan, snapshot: ctx.snapshot, acc, corporationId, homeCityId,
    seq, resolutionId: ctx.resolutionId, now,
  });
  if (expired.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId, "M-05"],
        changes: accFlush(acc, null),
        recordsUpdated: expired.map((o) => orderPath(o.orderId)),
        summaryText: `M-05 expiry evaluated in this event: ${expired.map((o) => o.orderId).join(", ")} — status expired; committed shares released.`,
      })
    );
  }

  // Sellers settle in this event: their accounts stand ready (step 0).
  const { book, docsById } = buildEngineBook(plan, ctx.snapshot, corporationId);
  const sellOwners = [...new Set(book.filter((o) => o.side === "sell").map((o) => o.memberId))].sort();
  for (const owner of sellOwners) {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: owner, viaActionKind: "buy_back_shares" });
  }

  // The sweep: resting sells in price–time order, each fill bounded
  // by the remaining want, the order's quantity, and company cash
  // (value + buyer fee at that fill size).
  const restingSells = book
    .filter((o) => o.side === "sell")
    .sort((a, b) => a.limitPriceRubars - b.limitPriceRubars || a.placedAtSeq - b.placedAtSeq);
  let cashLeft = plannedBalance(plan, ctx.snapshot, companyRef(homeCityId, corporationId)) ?? 0;
  let want = maxQuantity;
  interface BuybackFill {
    order: MarketOrderRecord;
    quantityShares: number;
    priceRubars: number;
    tradeValueRubars: number;
    buyerFeeRubars: number;
    sellerFeeRubars: number;
  }
  const fills: BuybackFill[] = [];
  for (const resting of restingSells) {
    if (want <= 0) break;
    if (resting.limitPriceRubars > capPrice) break;
    const price = resting.limitPriceRubars;
    let q = Math.min(want, resting.quantityShares, Math.floor(cashLeft / price));
    while (q > 0 && q * price + exchangeFeeRubars(q * price) > cashLeft) q -= 1;
    while (
      q + 1 <= Math.min(want, resting.quantityShares) &&
      (q + 1) * price + exchangeFeeRubars((q + 1) * price) <= cashLeft
    ) {
      q += 1;
    }
    if (q <= 0) break; // dearer orders follow — cash binds here
    const tradeValueRubars = q * price;
    const buyerFeeRubars = exchangeFeeRubars(tradeValueRubars);
    const sellerFeeRubars = exchangeFeeRubars(tradeValueRubars);
    fills.push({
      order: docsById.get(resting.orderId) as MarketOrderRecord,
      quantityShares: q,
      priceRubars: price,
      tradeValueRubars,
      buyerFeeRubars,
      sellerFeeRubars,
    });
    cashLeft -= tradeValueRubars + buyerFeeRubars;
    want -= q;
  }

  if (fills.length === 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: [],
        summaryText: `M-09 buyback for ${corporationId}: zero fills — no resting sell within the cap of ${capPrice} R was coverable from company cash (${intOr(corp, "companyCashRubars", 0)} R standing). A zero-fill buyback resolves as a logged no-op, not a rejection; no cash moved, no shares retired, and no repricing runs (no coded input changed).`,
      })
    );
    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: "buy-back-shares",
      scope: "company",
      cityId: homeCityId,
      summaryText: `Buyback of ${corporationId} filled zero shares (cap ${capPrice} R, max ${maxQuantity}) — logged no-op.`,
      extraClassification: { buyback: { maxQuantityShares: maxQuantity, capPriceRubars: capPrice, filledShares: 0 } },
    });
  }

  const lines: TransferLine[] = [];
  for (const fill of fills) {
    lines.push(
      {
        from: companyRef(homeCityId, corporationId),
        to: personalRef(fill.order.memberId),
        amountRubars: fill.tradeValueRubars,
        ruleId: "M-09",
        memo: `buyback value — ${fill.quantityShares} shares of ${corporationId} at ${fill.priceRubars} R (resting order ${fill.order.orderId})`,
      },
      {
        from: companyRef(homeCityId, corporationId),
        to: MARKET_REF,
        amountRubars: fill.buyerFeeRubars,
        ruleId: "M-09",
        memo: "exchange fee — buyer side (the company as buyer, §5.3)",
      },
      {
        from: personalRef(fill.order.memberId),
        to: MARKET_REF,
        amountRubars: fill.sellerFeeRubars,
        ruleId: "M-09",
        memo: "exchange fee — seller side (§5.3)",
      }
    );
  }
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines, shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId, "M-04"],
      `M-09/M-04: buyback settlement refused in full: ${applied.message}`
    );
  }
  pushMovementEntries(plan, ctx, [descriptorId, "M-04"], applied.changes, (entryCityId) =>
    entryCityId === null
      ? `M-09/M-04 buyback settlement for ${corporationId}: sellers received their proceeds and both sides' fees credited the Market Account (per-execution lines are in the execution entries).`
      : `M-09/M-04 buyback settlement: ${corporationId}'s company cash funded the buyback (value + buyer-side fees).`
  );

  // Share side per fill: seller delivers committed shares; the bought
  // shares RETIRE (no company holding exists — the company is not a
  // shareholder of itself in v1; treasury shares are out, §6 M-09).
  const totalBought = fills.reduce((sum, f) => sum + f.quantityShares, 0);
  const totalCost = fills.reduce((sum, f) => sum + f.tradeValueRubars + f.buyerFeeRubars, 0);
  const fillEntries: LogEntryDraft[] = [];
  fills.forEach((fill, index) => {
    const tradeId = `trade_${ctx.resolutionId}_${String(index + 1).padStart(2, "0")}`;
    const execAcc: ChangeAcc = new Map();
    mutateHolding(plan, ctx.snapshot, execAcc, {
      memberId: fill.order.memberId,
      corporationId,
      homeCityId,
      deltaQuantity: -fill.quantityShares,
      deltaCommitted: -fill.quantityShares,
      deltaCostBasis: 0,
      create: false,
      seq,
      resolutionId: ctx.resolutionId,
      now,
      formula: `M-09 execution ${tradeId}: the seller delivers shares committed behind resting order ${fill.order.orderId}; the bought shares retire`,
    });
    const orderPlanned = plannedDoc(plan, ctx.snapshot, orderPath(fill.order.orderId));
    const qtyAfter = intOr(orderPlanned, "quantityShares", 0) - fill.quantityShares;
    patchOrder(plan, ctx.snapshot, execAcc, fill.order.orderId, {
      quantityShares: qtyAfter,
      filledShares: intOr(orderPlanned, "filledShares", 0) + fill.quantityShares,
      status: qtyAfter <= 0 ? "filled" : "resting",
    }, `M-09 execution ${tradeId}: resting sell consumed by the company's buyback at its own price`);
    const tradeDoc = buildTradeDoc({
      tradeId,
      corporationId,
      homeCityId,
      buyerMemberId: `company:${corporationId}`,
      sellerMemberId: fill.order.memberId,
      quantityShares: fill.quantityShares,
      priceRubars: fill.priceRubars,
      buyerFeeRubars: fill.buyerFeeRubars,
      sellerFeeRubars: fill.sellerFeeRubars,
      incomingOrderId: `buyback_${ctx.resolutionId}`,
      restingOrderId: fill.order.orderId,
      seq,
      sourceActionId: ctx.action.actionId,
      lastResolutionId: ctx.resolutionId,
      now,
    });
    planWrite(plan, ctx.snapshot, tradePath(tradeId), tradeDoc, "state", ["quantityShares", "priceRubars"]);
    // Listing counters + the print (buyback executions are M-04
    // executions: last-trade and official follow the print, §4.1).
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "lastTradePriceRubars", entryCityId: null,
      field: listingField(corporationId, "lastTradePriceRubars"), value: fill.priceRubars,
      formula: `M-09 execution ${tradeId}: trade print (§1.4 mechanism 1)`,
    });
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "officialPriceRubars", entryCityId: null,
      field: listingField(corporationId, "officialPriceRubars"), value: fill.priceRubars,
      formula: "M-09/§4.1: the print is the official price until a repricing supersedes it",
    });
    setField(plan, ctx.snapshot, acc, {
      path: listingPath(corporationId), docField: "tradedSinceLastRepricing", entryCityId: null,
      field: listingField(corporationId, "tradedSinceLastRepricing"), value: true,
      formula: "M-09: a trade occurred since the last repricing",
    });
    const listingNow = plannedListing(plan, ctx.snapshot, corporationId);
    if (listingNow) {
      if (fill.order.kind === "float-offer") {
        setField(plan, ctx.snapshot, acc, {
          path: listingPath(corporationId), docField: "committedFloatShares", entryCityId: null,
          field: listingField(corporationId, "committedFloatShares"),
          value: listingNow.committedFloatShares - fill.quantityShares,
          formula: `M-09 execution ${tradeId}: the float offer filled into the buyback — committed float falls`,
        });
      } else if (fill.order.memberId !== listing.ownerMemberId) {
        setField(plan, ctx.snapshot, acc, {
          path: listingPath(corporationId), docField: "publicHeldShares", entryCityId: null,
          field: listingField(corporationId, "publicHeldShares"),
          value: listingNow.publicHeldShares - fill.quantityShares,
          formula: `M-09 execution ${tradeId}: publicly held shares retired out of the float`,
        });
      }
    }
    fillEntries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId, "M-04"],
        changes: [
          ...accChangesFor(execAcc, null),
          fieldChange(`marketTrades/${tradeId}.priceRubars`, null, fill.priceRubars, `M-09 execution ${tradeId}: the tape record — the company bought ${fill.quantityShares} shares at the resting price ${fill.priceRubars} R`),
        ],
        recordsCreated: [tradePath(tradeId)],
        recordsUpdated: [orderPath(fill.order.orderId), holdingPath(fill.order.memberId, corporationId)],
        summaryText: `M-09 execution ${tradeId}: ${corporationId} bought back ${fill.quantityShares} shares from ${fill.order.memberId} at ${fill.priceRubars} R (resting order ${fill.order.orderId}); value ${fill.tradeValueRubars} R; fees ${fill.buyerFeeRubars} R buyer (company) / ${fill.sellerFeeRubars} R seller to the Market Account. The shares retire in this event.${fill.order.kind === "float-offer" ? " The fill consumed part of the founder's float offer — a book execution at the resting price, in the open, exactly as any member's fill (never an off-book purchase from the founder)." : ""}`,
      })
    );
  });
  // Retirement lands on the corporation record (cumulative issued
  // stands; retired accumulates — the checker's identity, D-4).
  setField(plan, ctx.snapshot, acc, {
    path: corpPath, docField: "retiredShares", entryCityId: homeCityId,
    field: corpField(corporationId, "retiredShares"),
    value: retiredShares(corp) + totalBought,
    formula: "M-09: bought-back shares retire — retiredShares accumulates; sharesOutstanding (cumulative issued) stands (D-4)",
  });
  // Listing-level changes ride the last execution entry; the corp
  // retirement change rides its own home-city entry.
  const listingChanges = accFlush(acc, null);
  if (listingChanges.length > 0 && fillEntries.length > 0) {
    fillEntries[fillEntries.length - 1].changes.push(...listingChanges);
    fillEntries[fillEntries.length - 1].recordsUpdated.push(listingPath(corporationId));
  }
  plan.entries.push(...fillEntries);
  const corpChanges = accFlush(acc, homeCityId);
  if (corpChanges.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: homeCityId,
        cityIds: [homeCityId],
        ruleIds: [descriptorId],
        changes: corpChanges,
        recordsUpdated: [corpPath],
        summaryText: `M-09: ${corporationId} retired ${totalBought} shares in this event; live shares ${liveShares(corp)} → ${liveShares(corp) - totalBought} (issued ${issuedShares(corp)} − retired ${retiredShares(corp) + totalBought}). Total buyback cost ${totalCost} R from company cash.`,
      })
    );
  }
  composeMarketRepricing({
    plan,
    snapshot: ctx.snapshot,
    actor: ctx.action.actor,
    corporationId,
    homeCityId,
    judgment: judgmentFromPrepared(ctx),
    judgmentRationale: judgmentRationaleFromPrepared(ctx),
    judgmentInputHash: ctx.prepared?.inputHash ?? null,
    stepCapException: null,
    invokedByRuleId: descriptorId,
  });
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "buy-back-shares",
    scope: "company",
    cityId: homeCityId,
    summaryText: `Bought back and retired ${totalBought} shares of ${corporationId} for ${totalCost} R of company cash (cap ${capPrice} R, max ${maxQuantity}); repricing ran in-event (M-06).`,
    major: true,
    extraClassification: {
      buyback: { maxQuantityShares: maxQuantity, capPriceRubars: capPrice, filledShares: totalBought, totalCostRubars: totalCost },
      invokesRules: ["M-04", "M-06"],
    },
  });
}

// ---------------------------------------------------------------------------
// M-10 — liquidate / delist. The exported composer is also the path
// R-07's listed Dissolve routes through (Lead wiring, prep report
// §5). Waterfall (§5.5, D-7): trading halts in-event and every
// resting order cancels; company cash pays taxes/fees payable to
// their creditor treasuries first; the remainder divides pro-rata
// across ALL live shares (the founder's included — no founder
// preference) and pays to personal accounts in the same event; the
// integer-division dust stays on the dissolved record; shares retire;
// the listing exits the index at its final liquidation reference.
// The salvage line is DISCLOSED, never paid: paying it would mint
// unbacked cash (no structure-sale mechanism exists in Phase 4) and
// break the conservation invariant this slice exists to prove.
// ---------------------------------------------------------------------------

export type LiquidationOutcome =
  | {
      status: "liquidated";
      distributableRubars: number;
      finalLiquidationPriceRubars: number;
      paidToHoldersRubars: number;
      payablesPaidRubars: number;
      payablesWrittenOffRubars: number;
      salvageDisclosedRubars: number;
      dustRubars: number;
      perHolder: { memberId: string; quantityShares: number; amountRubars: number }[];
    }
  | { status: "refused"; code: string; message: string };

export function composeLiquidation(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  actor: HandlerContext["action"]["actor"];
  corporationId: string;
  homeCityId: string;
  invokedByRuleId: string;
  entryRuleIds: string[];
  seq: number;
  resolutionId: string;
  now: Date;
}): LiquidationOutcome {
  const { plan, snapshot } = args;
  const corpPath = corporationPath(args.homeCityId, args.corporationId);
  const corp = plannedDoc(plan, snapshot, corpPath);
  const listing = plannedListing(plan, snapshot, args.corporationId);
  if (!corp || !listing) {
    return { status: "refused", code: "not-listed", message: `no standing listing record for ${args.corporationId}` };
  }
  // Chartered banks (Phase 5 PR-6 assembly, A5): a company holding
  // an ACTIVE bank charter never liquidates through M-10's
  // shareholder waterfall — depositor claims stand ahead of it and
  // are B-10's business (frozen claims, setoff, the deposit
  // waterfall, the charter surrendered inside the event). The
  // refusal names the lawful path; unchartered mechanics are
  // untouched, and a surrendered charter restores them.
  const liquidationBank = bankBlockOf(corp);
  if (liquidationBank && liquidationBank.status === "active") {
    return {
      status: "refused",
      code: "bank-chartered",
      message: `${args.corporationId} holds an active bank charter — a chartered bank liquidates only through B-10 (liquidate_bank), where depositor claims are paid through the banking waterfall before shareholders; M-10's waterfall does not reach its deposit book`,
    };
  }
  const live = liveShares(corp);
  const holders = holdingDocs(snapshot)
    .map(({ doc }) => doc as unknown as ShareHoldingRecord)
    .filter((h) => h.corporationId === args.corporationId && h.quantityShares > 0)
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  const heldTotal = holders.reduce((sum, h) => sum + h.quantityShares, 0);
  if (heldTotal !== live) {
    return {
      status: "refused",
      code: "share-ledger-inconsistent",
      message: `holdings sum to ${heldTotal} shares against ${live} live shares — liquidation refuses to pay against a ledger that disagrees with itself (§1.8 posture; remedy is M-11 under a verdict)`,
    };
  }
  const acc: ChangeAcc = new Map();

  // 1) Halt in-event + every resting order cancels (the halt is a
  //    Log fact; the listing's one folded write lands delisted below).
  const resting = bookDocs(snapshot)
    .map(({ doc }) => doc as unknown as MarketOrderRecord)
    .filter((o) => o.corporationId === args.corporationId && o.status === "resting");
  for (const order of resting) {
    patchOrder(plan, snapshot, acc, order.orderId, {
      status: "cancelled",
      cancelReason: "listing-liquidated",
    }, "M-10: liquidation cancels every resting order in-event (their commitments die with the listing; no cash or shares move on a cancel)");
  }
  if (resting.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: args.actor,
        cityId: null,
        cityIds: [],
        ruleIds: args.entryRuleIds,
        changes: accFlush(acc, null),
        recordsUpdated: resting.map((o) => orderPath(o.orderId)),
        summaryText: `M-10: trading in ${args.corporationId} halts in this event and all ${resting.length} resting order(s) are cancelled (${resting.map((o) => o.orderId).join(", ")}).`,
      })
    );
  }

  // 2) Waterfall figures. Salvage is a disclosure (D-7): the recorded
  //    budgets of the company's linked structures that stand.
  const cash = intOr(corp, "companyCashRubars", 0);
  const linkedIds = strList(corp.linkedStructureIds);
  const structuresById = new Map(
    structureDocs(snapshot, args.homeCityId).map(({ doc }) => [String(doc.structureId), doc])
  );
  const salvageDisclosedRubars = linkedIds.reduce(
    (sum, id) => sum + (structuresById.get(id) ? intOr(structuresById.get(id) ?? null, "totalBudgetRubars", 0) : 0),
    0
  );
  const payablesMap = (corp.taxPayables as Record<string, unknown> | undefined) ?? {};
  const payables = Object.entries(payablesMap)
    .map(([cityId, amount]) => ({ cityId, amountRubars: typeof amount === "number" && amount > 0 ? amount : 0 }))
    .filter((p) => p.amountRubars > 0)
    .sort((a, b) => (a.cityId < b.cityId ? -1 : 1));
  const totalPayables = payables.reduce((sum, p) => sum + p.amountRubars, 0);
  const payablesPaid = payables.map((p) => ({
    ...p,
    paidRubars:
      totalPayables <= cash
        ? p.amountRubars
        : Math.floor((p.amountRubars * cash) / totalPayables),
  }));
  const payablesPaidRubars = payablesPaid.reduce((sum, p) => sum + p.paidRubars, 0);
  const payablesWrittenOffRubars = totalPayables - payablesPaidRubars;
  const distributableRubars = cash - payablesPaidRubars;
  const finalLiquidationPriceRubars =
    live > 0 ? roundHalfUp(distributableRubars / live) : 0;
  // Holders are paid into personal accounts (step 0 for each).
  for (const holder of holders) {
    composeLazyOpen({ plan, snapshot, actor: args.actor, memberId: holder.memberId, viaActionKind: "liquidate_company" });
  }
  const perHolder = holders.map((h) => ({
    memberId: h.memberId,
    quantityShares: h.quantityShares,
    amountRubars: live > 0 ? Math.floor((distributableRubars * h.quantityShares) / live) : 0,
  }));
  const paidToHoldersRubars = perHolder.reduce((sum, p) => sum + p.amountRubars, 0);
  const dustRubars = distributableRubars - paidToHoldersRubars;

  const lines: TransferLine[] = [];
  for (const p of payablesPaid) {
    if (p.paidRubars > 0) {
      lines.push({
        from: companyRef(args.homeCityId, args.corporationId),
        to: { kind: "treasury", cityId: p.cityId },
        amountRubars: p.paidRubars,
        ruleId: "M-10",
        memo: `liquidation waterfall — tax/fees payable to ${p.cityId} paid ahead of shareholders (§5.5)`,
      });
    }
  }
  for (const p of perHolder) {
    if (p.amountRubars > 0) {
      lines.push({
        from: companyRef(args.homeCityId, args.corporationId),
        to: personalRef(p.memberId),
        amountRubars: p.amountRubars,
        ruleId: "M-10",
        memo: `liquidation proceeds — pro-rata on ${p.quantityShares} shares of ${args.corporationId}`,
      });
    }
  }
  if (lines.length > 0) {
    const applied = applyTransferLines({ plan, snapshot, lines, shortfallClass: "transfer" });
    if (!applied.ok) {
      return { status: "refused", code: applied.code.toLowerCase().replace(/_/g, "-"), message: applied.message };
    }
    pushMovementEntries(plan, { action: { actor: args.actor } }, args.entryRuleIds, applied.changes, (entryCityId) => {
      if (entryCityId === null) {
        return `M-10 waterfall payments for ${args.corporationId} (invoked by ${args.invokedByRuleId}): ${perHolder.map((p) => `${p.memberId} +${p.amountRubars} R (${p.quantityShares} shares)`).join("; ") || "no holder payments"}.`;
      }
      if (entryCityId === args.homeCityId) {
        return `M-10 waterfall: ${args.corporationId}'s company cash paid payables first, then shareholders pro-rata; ${dustRubars} R of integer-division dust stays on the dissolved record (finance §3.3's stated dust posture).`;
      }
      return `M-10 waterfall: the payable owed to ${entryCityId} is paid from ${args.corporationId}'s cash ahead of shareholders (§5.5).`;
    });
  }

  // 3) Shares retire; holdings are deleted; the corporation closes.
  for (const { doc } of holdingDocs(snapshot)) {
    const holding = doc as unknown as ShareHoldingRecord;
    if (holding.corporationId !== args.corporationId) continue;
    planWrite(plan, snapshot, holdingPath(holding.memberId, args.corporationId), null, "state", ["quantityShares"]);
    accChange(acc, null, holdingField(holding.memberId, args.corporationId, "quantityShares"), holding.quantityShares, null, "M-10: the holding is retired and its record deleted in the liquidation event");
  }
  setField(plan, snapshot, acc, {
    path: corpPath, docField: "retiredShares", entryCityId: args.homeCityId,
    field: corpField(args.corporationId, "retiredShares"),
    value: retiredShares(corp) + live,
    formula: "M-10: all live shares retire — retired accumulates to the cumulative issued count (D-4 identity: Σ holdings 0 + retired = sharesOutstanding)",
  });
  setField(plan, snapshot, acc, {
    path: corpPath, docField: "status", entryCityId: args.homeCityId,
    field: corpField(args.corporationId, "status"), value: "dissolved",
    formula: "M-10: the corporation record closes as dissolved",
  });
  setField(plan, snapshot, acc, {
    path: corpPath, docField: "valuationRubars", entryCityId: args.homeCityId,
    field: corpField(args.corporationId, "valuationRubars"), value: 0,
    formula: "M-10/§4.4: a price of exactly 0 is reserved for liquidation",
  });
  setField(plan, snapshot, acc, {
    path: corpPath, docField: "taxPayables", entryCityId: args.homeCityId,
    field: corpField(args.corporationId, "taxPayables"), value: {},
    formula: "M-10: payables are paid or written off in the waterfall — the dissolved record carries none forward",
  });

  // 4) The listing delists at the final liquidation reference.
  const listingPatch: [string, unknown, string][] = [
    ["status", "delisted", "M-10: the listing delists in the liquidation event"],
    ["tradingStatus", "delisted", "M-10: trading ends at this event (§2.3)"],
    ["haltReason", null, "M-10: delisting supersedes the halt"],
    ["delistedAtSeq", args.seq, "M-10: delisting seq"],
    ["finalLiquidationPriceRubars", finalLiquidationPriceRubars, "M-10/§5.5: the final liquidation reference = distributable ÷ live shares (rounded half-up; payments floor)"],
    ["committedFloatShares", 0, "M-10: no float survives delisting"],
    ["publicHeldShares", 0, "M-10: no public holding survives delisting"],
  ];
  for (const [docField, value, formula] of listingPatch) {
    setField(plan, snapshot, acc, {
      path: listingPath(args.corporationId), docField, entryCityId: null,
      field: listingField(args.corporationId, docField), value, formula,
    });
  }

  plan.entries.push(
    ruleEffectDraft({
      actor: args.actor,
      cityId: null,
      cityIds: [],
      ruleIds: args.entryRuleIds,
      changes: accFlush(acc, null),
      recordsUpdated: [listingPath(args.corporationId)],
      summaryText: `M-10 liquidation waterfall for ${args.corporationId}, line by line (§5.5): company cash ${cash} R; salvage value of linked structures DISCLOSED at ${salvageDisclosedRubars} R — not paid (D-7: paying salvage would mint unbacked cash; the structures themselves are not transferred and their records stand as their own rules leave them); taxes/fees payable ${totalPayables} R — paid ${payablesPaidRubars} R to creditor treasuries ahead of shareholders${payablesWrittenOffRubars > 0 ? `, ${payablesWrittenOffRubars} R written off with the dissolution (cash bound the waterfall)` : ""}; adjudicated amounts 0 R (no verdict-attached amount stands against this company in v1); distributable ${distributableRubars} R over ${live} live shares = final liquidation price ${finalLiquidationPriceRubars} R/share; paid to holders ${paidToHoldersRubars} R; dust ${dustRubars} R stays on the dissolved record. Shares retire; the listing exits the index in this event (§3.3). ${indexNote(plan, snapshot)}`,
    })
  );
  const corpChanges = accFlush(acc, args.homeCityId);
  if (corpChanges.length > 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: args.actor,
        cityId: args.homeCityId,
        cityIds: [args.homeCityId],
        ruleIds: args.entryRuleIds,
        changes: corpChanges,
        recordsUpdated: [corpPath],
        summaryText: `M-10: ${args.corporationId} is dissolved; its record, trade history and Log entries remain permanently readable (§2.3).`,
      })
    );
  }
  return {
    status: "liquidated",
    distributableRubars,
    finalLiquidationPriceRubars,
    paidToHoldersRubars,
    payablesPaidRubars,
    payablesWrittenOffRubars,
    salvageDisclosedRubars,
    dustRubars,
    perHolder,
  };
}

function liquidateCompanyHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-10";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  if (!corporationId || !homeCityId) {
    return rejectedPlan(descriptorId, "malformed-liquidation", [descriptorId], "M-10: liquidate_company requires corporationId and homeCityId.");
  }
  const gate = requireListedCompany(ctx, descriptorId, homeCityId, corporationId);
  if (isPlan(gate)) return gate;
  const ownerGate = requireOwner(ctx, descriptorId, gate.corp, corporationId);
  if (isPlan(ownerGate)) return ownerGate;
  const plan = emptyPlan(descriptorId);
  const seq = ctx.snapshot.counterHead.lastSeq + 1;
  const outcome = composeLiquidation({
    plan,
    snapshot: ctx.snapshot,
    actor: ctx.action.actor,
    corporationId,
    homeCityId,
    invokedByRuleId: descriptorId,
    entryRuleIds: [descriptorId],
    seq,
    resolutionId: ctx.resolutionId,
    now: new Date(ctx.snapshot.now),
  });
  if (outcome.status === "refused") {
    return rejectedPlan(descriptorId, outcome.code, [descriptorId], `M-10: ${outcome.message}.`);
  }
  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "liquidate-company",
    scope: "company",
    cityId: homeCityId,
    summaryText: `Liquidated ${corporationId}: distributable ${outcome.distributableRubars} R at a final liquidation price of ${outcome.finalLiquidationPriceRubars} R/share; ${outcome.paidToHoldersRubars} R paid to shareholders, ${outcome.payablesPaidRubars} R of payables paid first, dust ${outcome.dustRubars} R on the dissolved record. The listing is delisted and exits the index.`,
    major: true,
    extraClassification: {
      liquidation: {
        distributableRubars: outcome.distributableRubars,
        finalLiquidationPriceRubars: outcome.finalLiquidationPriceRubars,
        paidToHoldersRubars: outcome.paidToHoldersRubars,
        payablesPaidRubars: outcome.payablesPaidRubars,
        payablesWrittenOffRubars: outcome.payablesWrittenOffRubars,
        salvageDisclosedRubars: outcome.salvageDisclosedRubars,
        dustRubars: outcome.dustRubars,
        perHolder: outcome.perHolder,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// M-11 — correct a market record (dispute path). FAIL-CLOSED in
// Phase 4: corrections apply only under a Town Hall motion / tribunal
// verdict (Phase 7 owns verdicts), and settled trades are
// locked-at-commit (P4-K25) — the remedy a verdict orders is a
// compensating event, never an edit of settled history. Until
// verdicts land, every correction action rejects with the path
// named, rather than improvising an authority this phase lacks.
// ---------------------------------------------------------------------------

function correctMarketRecordHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "M-11";
  const corporationId = stringField(ctx.action, "corporationId");
  return rejectedPlan(
    descriptorId,
    "correction-requires-verdict",
    [descriptorId],
    `M-11: a correction to a market record${corporationId ? ` for ${corporationId}` : ""} applies only under a Town Hall motion or tribunal verdict (§6 M-11), recorded by a member with the mandate — verdict machinery is Phase 7, and no verdict stands behind this action. Settled trades are locked-at-commit (P4-K25): the correction a verdict orders is a compensating transfer computed from the Log, never an unwinding of settled history or an edit of a standing record by fiat.`
  );
}

// ---------------------------------------------------------------------------
// Read plans (F-01). Seeds derive only from the action's own fields
// and the actor — never from citations. Settlement events read the
// whole member-account collection: the member universe is tiny and a
// settlement must read/write whichever members rest in the book (the
// build-prep §2.4 graph read, market instance).
// ---------------------------------------------------------------------------

function marketReadPlan(opts: {
  book?: boolean;
  holdings?: boolean;
  accounts?: boolean;
  listings?: boolean;
  structures?: boolean;
  cities?: boolean;
  actorHolding?: boolean;
  counterpartyHolding?: boolean;
  namedOrder?: boolean;
}): (seeds: ReadPlanSeeds) => DescriptorReadPlan {
  return (seeds: ReadPlanSeeds): DescriptorReadPlan => {
    const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
    const paths: string[] = [MARKET_ACCOUNT_PATH];
    const queries: CollectionQuerySpec[] = [];
    const actorId = actorMemberId(seeds.action.actor);
    if (actorId) paths.push(memberAccountPath(actorId));
    const corporationId = typeof params.corporationId === "string" ? params.corporationId : null;
    const homeCityId = typeof params.homeCityId === "string" ? params.homeCityId : null;
    if (homeCityId) paths.push(cityPath(homeCityId));
    if (corporationId && homeCityId) paths.push(corporationPath(homeCityId, corporationId));
    if (corporationId) {
      paths.push(listingPath(corporationId));
      paths.push(orderPath(floatOfferOrderId(corporationId)));
      if (opts.book) queries.push(bookQuery(corporationId));
      if (opts.holdings) queries.push(holdingsQuery(corporationId));
      if (opts.actorHolding && actorId) paths.push(holdingPath(actorId, corporationId));
      if (opts.counterpartyHolding && typeof params.toMemberId === "string") {
        paths.push(holdingPath(params.toMemberId, corporationId));
      }
    }
    if (opts.namedOrder && typeof params.orderId === "string") {
      paths.push(orderPath(params.orderId));
    }
    if (opts.accounts) queries.push(accountsQuery());
    if (opts.listings) queries.push(listingsQuery());
    if (opts.structures && homeCityId) queries.push(structuresQuery(homeCityId));
    if (opts.cities) queries.push(citiesQuery());
    return { paths, queries };
  };
}

// ---------------------------------------------------------------------------
// Descriptors + finance additions (finance §2.4) + undo classes
// (P4-K25). The Build Lead registers MARKET_DESCRIPTORS into
// RULE_DESCRIPTORS and folds MARKET_FINANCE_ADDITIONS onto each
// descriptor's `finance` field — the Finance/Catalogue assembly
// pattern, unchanged.
// ---------------------------------------------------------------------------

export const MARKET_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "M-00": {
    id: "M-00",
    actionKinds: ["found_market_account"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { found_market_account: foundMarketAccountHandler },
    readPlan: () => ({ paths: [MARKET_ACCOUNT_PATH] }),
    summary: "Found the Market Account (genesis-class): the exchange operator's singleton ledger at sim_market_account/main is created with its 1,000,000 R seed — a mint under finance §3.3's closed list — and the RCI divisor anchor slot. The account holds no shares, takes no positions, and moves only by published rule; until this act stands, trade handlers reject market-account-missing rather than inventing the account inside a trade.",
  },
  "M-01": {
    id: "M-01",
    actionKinds: ["list_company"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { list_company: listCompanyHandler },
    readPlan: marketReadPlan({ holdings: true, listings: true, structures: true }),
    summary: "List a company (owner only, §2.2 eligibility). Two branches: completion — a corporation listed at founding under R-06 gains its listing record and founder holding from its standing founding figures, exactly the founder-holding backfill planner's repair (PR #33 obligation); and full listing — paid-in capital moves founder-personal -> company (treasury sourcing suspended, P4-K21(ii)), shares issue to the founder, the float portion is committed as the standing float offer, and the opening price is computed by the M-06 coded-input assembly + §4.4 formula with the prepared payload's judgment (an action naming its own scores rejects judgment-required). Zero capital and zero operating footprint refuses listing-unpriced — no price is invented.",
  },
  "M-02": {
    id: "M-02",
    actionKinds: ["market_issue"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { market_issue: marketIssueHandler },
    readPlan: marketReadPlan({ book: true, holdings: true, listings: true, structures: true }),
    summary: "Issue shares / inject capital / place or recall float (owner only). Issuance creates shares to the founder (optionally direct to float) with per-holder dilution disclosed exactly in the Log; injection moves personal capital into company cash and maintains paidInCapitalRubars; both reprice in-event via M-06. Float placement commits founder shares behind the standing float offer and recall releases the commitment — under custody (P4-K21) float shares never leave the founder's holding, so neither branch moves shares and neither reprices (no §4.3 input changes); the index float inputs update in-event.",
  },
  "M-03": {
    id: "M-03",
    actionKinds: ["place_order"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { place_order: placeOrderHandler },
    readPlan: marketReadPlan({ book: true, holdings: true, accounts: true, actorHolding: true }),
    summary: "Place an order (any member; NPC mandates are Phase 5). Market orders require a protection cap; block orders derive their cap from the reference ± half-spread; limit orders rest. Placement validates free shares for sells and worst-case cash (cap value + per-execution fee headroom) for buys; expiry evaluates first (M-05 mechanism); matching is price–time priority at the resting order's price with self-match prevention (M-04 composed in-event); a resting buyer who cannot cover at crossing is cancelled in-event (cancelled-insufficient-cash, D-5 — resting buys carry no cash reservation in v1) and matching continues. Market/block remainders cancel; limit remainders rest with their shares committed.",
  },
  "M-04": {
    id: "M-04",
    actionKinds: ["transfer_shares"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { transfer_shares: transferSharesHandler },
    readPlan: marketReadPlan({ actorHolding: true, counterpartyHolding: true }),
    summary: "Execute a trade (matching + settlement). As an action kind it carries the zero-price member-to-member transfer path: free shares move between holdings, fees are 0 and the fee line is still stated, no price prints. Executions themselves are not submitted actions — they compose inside M-03 (incoming orders) and M-09 (buybacks) in the same event: per execution, seller shares -q, buyer shares +q, buyer cash -(value + buyer fee), seller cash +(value - seller fee), Market Account +fees (0.25% per side, rounded up, minimum 1 R), a trade record on the tape, and last-trade/official price updates per §4.1. Settlement is T+0 and atomic (§5.6).",
  },
  "M-05": {
    id: "M-05",
    actionKinds: ["cancel_order"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { cancel_order: cancelOrderHandler },
    readPlan: marketReadPlan({ book: true, namedOrder: true, actorHolding: true }),
    summary: "Cancel / expire an order. Owner cancels their own resting order(s) — one named order, or all of theirs on a listing — free and instant, in any trading status; committed shares release (cancelling the float offer is equivalent to an M-02 recall). Expiry is this rule's other half: no timer exists — every book-touching event first evaluates resting orders whose expiresAtSeq has passed and expires them in that event, logged.",
  },
  "M-06": {
    id: "M-06",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Repricing (resolver step, no action kinds): composed in-event by rules that change a listed company's §4.3 coded inputs or invoke judgment (M-01 opening, M-02 issue/inject, M-08, M-09, and — by Lead wiring — R-07's listed branches and structure/case events). The ONLY writer of a listed company's reference price and valuationRubars cache (P4-K18): coded inputs from a closed list (legacyBookRubars structurally absent, P4-G6), judgment from the prepared payload or carried lastJudgment (never from the action, never invented — an unjudged company is not repriced), the §4.4 formula, the locked ±25% step cap (exceptions: dissolution, tier-2 case against the company), official price per §4.1 (a same-event print supersedes), downtime halt/resume evaluation, and the full show-your-work Log entry.",
  },
  "M-07": {
    id: "M-07",
    actionKinds: ["suspend_listing", "resume_listing"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      suspend_listing: suspendResumeHandler("suspend"),
      resume_listing: suspendResumeHandler("resume"),
    },
    readPlan: marketReadPlan({ structures: true }),
    summary: "Suspend / resume a listing (owner only). Suspension is the owner's deliberate dormancy — shares remain held, resting orders persist unexecutable, no price changes. Resume re-evaluates the coded halt condition in-event: a downtime halt whose condition still holds rejects halt-condition-holds (no unhalt button exists for a standing condition, §1.8); with the condition clear, trading opens.",
  },
  "M-08": {
    id: "M-08",
    actionKinds: ["declare_distribution"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { declare_distribution: declareDistributionHandler },
    readPlan: marketReadPlan({ holdings: true, accounts: true, listings: true, structures: true }),
    summary: "Declare a distribution (owner only): a stated total from company cash, paid pro-rata across all shareholders of record at the event's seq (founder included; integer division; the remainder stays in company cash, logged). A distribution the cash cannot cover refuses in full (distribution-exceeds-cash) — never trimmed silently. Repricing follows in-event (M-06). This is also the only lawful cash-out leg for a listed company under P4-K22: R-07's listed Contract withdrawal routes here (or to M-09) by Lead wiring, never to a bare company -> owner line.",
  },
  "M-09": {
    id: "M-09",
    actionKinds: ["buy_back_shares"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { buy_back_shares: buyBackSharesHandler },
    readPlan: marketReadPlan({ book: true, holdings: true, accounts: true, listings: true, structures: true }),
    summary: "Buy back shares (owner only): the company buys through the book in the open — resting sells in price–time order up to a stated maximum quantity and cap price, funded from company cash (value + buyer fee per fill) — never directly off-book from the founder (a disguised withdrawal, §5.2). Partial fills are lawful (quantity, cap, or cash binds); a zero-fill buyback is a logged no-op, not a rejection. Bought shares retire: retiredShares accumulates while sharesOutstanding (cumulative issued) stands (D-4). Executions are M-04 executions (fees both sides, tape records, prints); repricing follows in-event (M-06).",
  },
  "M-10": {
    id: "M-10",
    actionKinds: ["liquidate_company"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { liquidate_company: liquidateCompanyHandler },
    readPlan: marketReadPlan({ book: true, holdings: true, accounts: true, listings: true, structures: true, cities: true }),
    summary: "Liquidate / delist (owner only; R-07's listed Dissolve routes here by Lead wiring). In one event: trading halts and every resting order cancels; the §5.5 waterfall pays taxes/fees payable to creditor treasuries first (pro-rata when cash binds, the unpaid remainder written off with the dissolution and disclosed), then divides the distributable remainder pro-rata across all live shares (founder included, no preference) into personal accounts; salvage is disclosed, never paid (D-7 — paying it would mint unbacked cash); integer-division dust stays on the dissolved record; shares retire, holdings are deleted, the corporation closes dissolved with valuation 0, and the listing delists at the final liquidation reference and exits the index. A holdings/record disagreement refuses share-ledger-inconsistent rather than paying against a broken ledger.",
  },
  "M-11": {
    id: "M-11",
    actionKinds: ["correct_market_record"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { correct_market_record: correctMarketRecordHandler },
    readPlan: marketReadPlan({}),
    summary: "Correct a market record (dispute path) — fail-closed in Phase 4: every correction action rejects correction-requires-verdict. Corrections apply only under a Town Hall motion / tribunal verdict (Phase 7 owns verdicts), as compensating transfers computed from the Log; settled trades are locked-at-commit (P4-K25) and are never unwound or edited by fiat. The descriptor stands now so the path is named, published, and refuses honestly instead of improvising an authority this phase lacks.",
  },
  "M-12": {
    id: "M-12",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Publish company figures (market-facing publication) — descriptor-only stub in this slice: the publication layer is step 9's R-30 (sim_publications records stamped owner-published · unverified), and M-12 is its market instance. No price, index, or state effect ever (§4.8): owner-published figures are claims, labeled as claims, and are never inputs to §4.3, §4.4, or the judgment evidence pack. The descriptor stands so the rule is published with the family; the verb lands with step 9's wiring.",
  },
};

export const MARKET_FINANCE_ADDITIONS: Record<string, FinanceDescriptorAdditions> = {
  "M-00": { shortfallClass: "none", ledgersTouched: ["market"], invokesRules: [] },
  "M-01": { shortfallClass: "transfer", ledgersTouched: ["personal", "company", "market"], invokesRules: ["M-02", "M-06"] },
  "M-02": { shortfallClass: "transfer", ledgersTouched: ["personal", "company"], invokesRules: ["M-06"] },
  "M-03": { shortfallClass: "transfer", ledgersTouched: ["personal", "market"], invokesRules: ["M-04", "M-05"] },
  "M-04": { shortfallClass: "transfer", ledgersTouched: ["personal", "market"], invokesRules: [] },
  "M-05": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "M-06": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "M-07": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "M-08": { shortfallClass: "transfer", ledgersTouched: ["company", "personal"], invokesRules: ["M-06"] },
  "M-09": { shortfallClass: "transfer", ledgersTouched: ["company", "personal", "market"], invokesRules: ["M-04", "M-06"] },
  "M-10": { shortfallClass: "transfer", ledgersTouched: ["company", "personal", "treasury"], invokesRules: [] },
  "M-11": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "M-12": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
};

/** P4-K25 lock classes, shipped with the descriptors from day one so
 * Phase 7's undo pass extends a populated field instead of
 * retrofitting one (the registry's RuleDescriptor type gains the
 * `undoClass` field at Lead assembly; until then the map is the
 * record). M-03 carries the class because its events settle M-04
 * executions; undo of such a target refuses with the class named,
 * and the remedy is the corrective-event path (M-11). */
export const MARKET_UNDO_CLASSES: Record<string, "locked-at-commit"> = {
  "M-03": "locked-at-commit",
  "M-04": "locked-at-commit",
  "M-10": "locked-at-commit",
};
