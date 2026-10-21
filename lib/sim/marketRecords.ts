/**
 * The market record shapes (Phase 4 step 7) — Cato's
 * market-systems-spec §10.1 shapes, fixed to their Phase 4 homes by
 * the landed Step 0 read contract (F-01). This module is shapes,
 * builders, and pure derivations only; handlers live in
 * `lib/sim/rules/market.ts`.
 *
 * Homes, and why:
 *  - Listing: `sim_market_listings/{corporationId}` — a ROOT doc
 *    (§10.1's stated lean). The corporation record stays city-rooted
 *    and keeps the founding figures; the listing record carries the
 *    market state (three prices, trading status, float counters), so
 *    index/book derivations read one collection, not every city.
 *  - Holding: `sim_holdings/{memberId}__{corporationId}` — a ROOT
 *    doc. §10.1 proposed a subcollection under the member account;
 *    the F-01 read plan is one-pass (query results cannot seed
 *    further doc reads, and the query reader executes plain
 *    collection paths), so a settlement event — which must read and
 *    write whichever members rest in the book — can only be served
 *    by a single queryable collection. The shape also matches what
 *    the conservation checker's standing-records supply consumes
 *    (docs carrying `corporationId` + `quantityShares`). Flagged for
 *    Dana/Lead ratification in the step-7 prep report; the member
 *    account doc (finance §1.2) is untouched.
 *  - Order: `sim_market_orders/{orderId}` (§10.1 as proposed).
 *  - Trade: `sim_market_trades/{tradeId}` (§10.1: the record is
 *    required; the Log entries remain the audit of record, the trade
 *    doc is the tape the index/digest derivations read).
 *  - Market Account: `sim_market_account/main` (finance §1.1's
 *    collection, singleton doc; path const lives in
 *    lib/finance/accounts.ts with the rest of the ledger grammar).
 *
 * Float accounting (custody model, P4-K21): a listing's index float
 * is `committedFloatShares + publicHeldShares` — the founder's
 * committed float (the remaining quantity of the standing float-offer
 * order) plus live shares currently held by non-founder members.
 * Both counters are maintained in-event by the only rules that can
 * move them (M-01/M-02 place/recall/issuance, M-04 executions,
 * M-09/M-10 retirements), so the index input is always derivable
 * from the standing record — never recomputed by scanning.
 */

import { MARKET_ACCOUNT_PATH } from "../finance/accounts";
import type { TradingStatus } from "../market/types";

export { MARKET_ACCOUNT_PATH };
export const MARKET_LISTINGS_COLLECTION = "sim_market_listings";
export const MARKET_ORDERS_COLLECTION = "sim_market_orders";
export const MARKET_TRADES_COLLECTION = "sim_market_trades";
export const HOLDINGS_COLLECTION = "sim_holdings";

export function listingPath(corporationId: string): string {
  return `${MARKET_LISTINGS_COLLECTION}/${corporationId}`;
}

export function holdingId(memberId: string, corporationId: string): string {
  return `${memberId}__${corporationId}`;
}

export function holdingPath(memberId: string, corporationId: string): string {
  return `${HOLDINGS_COLLECTION}/${holdingId(memberId, corporationId)}`;
}

export function orderPath(orderId: string): string {
  return `${MARKET_ORDERS_COLLECTION}/${orderId}`;
}

export function tradePath(tradeId: string): string {
  return `${MARKET_TRADES_COLLECTION}/${tradeId}`;
}

/** The standing float-offer order's id — deterministic per listing so
 * place/recall/repricing read plans name it directly (P4-K21: the
 * float IS this order; recall is its cancellation). */
export function floatOfferOrderId(corporationId: string): string {
  return `float_${corporationId}`;
}

// ---------------------------------------------------------------------------
// Listing record.
// ---------------------------------------------------------------------------

export interface MarketListingRecord {
  corporationId: string;
  homeCityId: string;
  ownerMemberId: string;
  status: "listed" | "delisted";
  tradingStatus: TradingStatus;
  /** The coded halt cause while `tradingStatus === "halted"` in v1:
   * "downtime" (§1.8's derived-function trigger). Null otherwise. */
  haltReason: string | null;
  referencePriceRubars: number;
  lastTradePriceRubars: number | null;
  officialPriceRubars: number;
  tradedSinceLastRepricing: boolean;
  committedFloatShares: number;
  publicHeldShares: number;
  earningsWindowStartSeq: number;
  listedAtSeq: number;
  delistedAtSeq: number | null;
  /** M-10's per-share distributable, recorded at delisting (the final
   * liquidation reference); null while listed. */
  finalLiquidationPriceRubars: number | null;
  sourceActionId: string;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The index float input (§3.2): tradable supply = committed founder
 * float + shares in public hands. */
export function listingFloatShares(
  listing: Pick<MarketListingRecord, "committedFloatShares" | "publicHeldShares">
): number {
  return listing.committedFloatShares + listing.publicHeldShares;
}

export function buildListingDoc(args: {
  corporationId: string;
  homeCityId: string;
  ownerMemberId: string;
  openingPriceRubars: number;
  committedFloatShares: number;
  listedAtSeq: number;
  sourceActionId: string;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: MarketListingRecord = {
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    ownerMemberId: args.ownerMemberId,
    status: "listed",
    tradingStatus: "open",
    haltReason: null,
    referencePriceRubars: args.openingPriceRubars,
    lastTradePriceRubars: null,
    officialPriceRubars: args.openingPriceRubars,
    tradedSinceLastRepricing: false,
    committedFloatShares: args.committedFloatShares,
    publicHeldShares: 0,
    earningsWindowStartSeq: args.listedAtSeq,
    listedAtSeq: args.listedAtSeq,
    delistedAtSeq: null,
    finalLiquidationPriceRubars: null,
    sourceActionId: args.sourceActionId,
    stateVersion: 1,
    lastChangedSeq: args.listedAtSeq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Holding record.
// ---------------------------------------------------------------------------

export interface ShareHoldingRecord {
  holdingId: string;
  memberId: string;
  corporationId: string;
  homeCityId: string;
  quantityShares: number;
  /** Shares committed to this member's resting sell orders (including
   * the founder's float offer). Only FREE shares can be sold or
   * transferred (§5.4). */
  committedShares: number;
  /** Σ (trade price × quantity) over acquisitions, from trade Log
   * entries (coded, §5.4). Fees are not cost basis. Founding shares
   * enter at their paid-in basis (paid-in capital ÷ issued shares is
   * NOT assumed — the founder's basis is the capital they paid in,
   * recorded whole on the founding holding). */
  costBasisRubars: number;
  sourceActionId: string;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function freeShares(
  holding: Pick<ShareHoldingRecord, "quantityShares" | "committedShares"> | null
): number {
  if (!holding) return 0;
  return holding.quantityShares - holding.committedShares;
}

export function buildHoldingDoc(args: {
  memberId: string;
  corporationId: string;
  homeCityId: string;
  quantityShares: number;
  committedShares: number;
  costBasisRubars: number;
  sourceActionId: string;
  sourceSeq: number;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: ShareHoldingRecord = {
    holdingId: holdingId(args.memberId, args.corporationId),
    memberId: args.memberId,
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    quantityShares: args.quantityShares,
    committedShares: args.committedShares,
    costBasisRubars: args.costBasisRubars,
    sourceActionId: args.sourceActionId,
    stateVersion: 1,
    lastChangedSeq: args.sourceSeq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Order record.
// ---------------------------------------------------------------------------

export type MarketOrderType = "market" | "limit" | "block";
export type MarketOrderKind = "standard" | "float-offer";
export type MarketOrderStatus = "resting" | "filled" | "cancelled" | "expired";

export interface MarketOrderRecord {
  orderId: string;
  corporationId: string; // the listing (§1.5's listingId)
  homeCityId: string;
  memberId: string;
  side: "buy" | "sell";
  type: MarketOrderType;
  kind: MarketOrderKind;
  /** Remaining unfilled quantity — matching consumes this figure. */
  quantityShares: number;
  originalQuantityShares: number;
  filledShares: number;
  /** Limit price for limit orders; the protection cap/floor for market
   * orders; the derived cap for block orders (reference ± halfSpread,
   * §1.5 custody reading). Null only on the standing float offer when
   * it was placed without a stated price — in practice M-01/M-02
   * always state one (defaulting to the reference price). */
  limitPriceRubars: number | null;
  status: MarketOrderStatus;
  /** owner-cancel | seq-expiry | insufficient-cash-at-settlement |
   * listing-liquidated | float-recall | unfilled-market-remainder.
   * Null while resting/filled. */
  cancelReason: string | null;
  placedAtSeq: number;
  expiresAtSeq: number | null;
  sourceActionId: string;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildOrderDoc(args: {
  orderId: string;
  corporationId: string;
  homeCityId: string;
  memberId: string;
  side: "buy" | "sell";
  type: MarketOrderType;
  kind: MarketOrderKind;
  quantityShares: number;
  limitPriceRubars: number | null;
  placedAtSeq: number;
  expiresAtSeq: number | null;
  sourceActionId: string;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: MarketOrderRecord = {
    orderId: args.orderId,
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    memberId: args.memberId,
    side: args.side,
    type: args.type,
    kind: args.kind,
    quantityShares: args.quantityShares,
    originalQuantityShares: args.quantityShares,
    filledShares: 0,
    limitPriceRubars: args.limitPriceRubars,
    status: "resting",
    cancelReason: null,
    placedAtSeq: args.placedAtSeq,
    expiresAtSeq: args.expiresAtSeq,
    sourceActionId: args.sourceActionId,
    stateVersion: 1,
    lastChangedSeq: args.placedAtSeq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Trade record (the tape).
// ---------------------------------------------------------------------------

export interface MarketTradeRecord {
  tradeId: string;
  corporationId: string;
  homeCityId: string;
  buyerMemberId: string;
  sellerMemberId: string;
  quantityShares: number;
  priceRubars: number;
  buyerFeeRubars: number;
  sellerFeeRubars: number;
  incomingOrderId: string;
  restingOrderId: string;
  seq: number;
  sourceActionId: string;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildTradeDoc(args: {
  tradeId: string;
  corporationId: string;
  homeCityId: string;
  buyerMemberId: string;
  sellerMemberId: string;
  quantityShares: number;
  priceRubars: number;
  buyerFeeRubars: number;
  sellerFeeRubars: number;
  incomingOrderId: string;
  restingOrderId: string;
  seq: number;
  sourceActionId: string;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: MarketTradeRecord = {
    tradeId: args.tradeId,
    corporationId: args.corporationId,
    homeCityId: args.homeCityId,
    buyerMemberId: args.buyerMemberId,
    sellerMemberId: args.sellerMemberId,
    quantityShares: args.quantityShares,
    priceRubars: args.priceRubars,
    buyerFeeRubars: args.buyerFeeRubars,
    sellerFeeRubars: args.sellerFeeRubars,
    incomingOrderId: args.incomingOrderId,
    restingOrderId: args.restingOrderId,
    seq: args.seq,
    sourceActionId: args.sourceActionId,
    stateVersion: 1,
    lastChangedSeq: args.seq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Market Account record.
// ---------------------------------------------------------------------------

export interface MarketAccountRecord {
  accountId: "main";
  cashRubars: number;
  status: "open";
  /** The M-00 founding act's mint (finance §3.3 closed list). */
  seedRubars: number;
  seededAtSeq: number;
  seedRuleId: "M-00";
  /** The RCI divisor anchor (§3.2): the genesis listing's float
   * market cap, set by the first listing whose float is positive.
   * An INPUT to the derived index, stored once; the level itself is
   * never stored anywhere. */
  indexDivisorBaseRubars: number | null;
  genesisListingCorporationId: string | null;
  stateVersion: number;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function buildMarketAccountDoc(args: {
  seedRubars: number;
  seededAtSeq: number;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: MarketAccountRecord = {
    accountId: "main",
    cashRubars: args.seedRubars,
    status: "open",
    seedRubars: args.seedRubars,
    seededAtSeq: args.seededAtSeq,
    seedRuleId: "M-00",
    indexDivisorBaseRubars: null,
    genesisListingCorporationId: null,
    stateVersion: 1,
    lastChangedSeq: args.seededAtSeq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}

// ---------------------------------------------------------------------------
// Corporation share figures + the founder-holding backfill planner.
// ---------------------------------------------------------------------------

/** Shares ever issued (the corporation record's `sharesOutstanding`,
 * in the conservation checker's grammar — see prep report D-4). */
export function issuedShares(corp: Record<string, unknown> | null): number {
  const v = corp?.sharesOutstanding;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

export function retiredShares(corp: Record<string, unknown> | null): number {
  const v = corp?.retiredShares;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : 0;
}

/** Live shares: issued − retired. The per-share divisor everywhere. */
export function liveShares(corp: Record<string, unknown> | null): number {
  return issuedShares(corp) - retiredShares(corp);
}

export interface FounderHoldingGap {
  corporationId: string;
  homeCityId: string;
  ownerMemberId: string;
  /** Live shares the founder must hold when no listing record stands
   * (no market event could have moved any — orders require one). */
  expectedFounderShares: number;
  /** The founder holding's standing quantity (0 when missing). */
  standingFounderShares: number;
  missingShares: number;
  listingRecordStands: boolean;
  openingReferencePriceRubars: number | null;
}

/**
 * The M-01/M-02 backfill planner (PR #33 obligation, pure): given
 * corporation docs and holding docs as plain views, list every
 * corporation that Catalogue II's listed founding left in the
 * pre-market state — `listed: true` with issued shares but no listing
 * record and/or a missing-or-short founder holding. Before this
 * module landed, such a corporation could not trade (no listing
 * record → no book), so when no listing record stands the founder
 * lawfully holds ALL live shares, and the repair is exact: create
 * the founder holding for the shortfall and the listing record at
 * the recorded opening reference price. The M-01 completion branch
 * executes exactly this repair in-event (owner's act); the operated
 * data step consumes the same computation for its report. Corpora
 * with a standing listing record are maintained by market events
 * themselves and are never gaps.
 */
export function planFounderHoldingBackfill(
  corporations: readonly Record<string, unknown>[],
  holdings: readonly Record<string, unknown>[],
  listings: readonly Record<string, unknown>[]
): FounderHoldingGap[] {
  const listingIds = new Set(
    listings.map((l) => l.corporationId).filter((v): v is string => typeof v === "string")
  );
  const gaps: FounderHoldingGap[] = [];
  for (const corp of corporations) {
    if (corp.listed !== true) continue;
    const corporationId = corp.corporationId;
    if (typeof corporationId !== "string") continue;
    const live = liveShares(corp);
    if (live <= 0) continue;
    const listingStands = listingIds.has(corporationId);
    const ownerMemberId = typeof corp.ownerMemberId === "string" ? corp.ownerMemberId : "";
    const founderHolding = holdings.find(
      (h) => h.corporationId === corporationId && h.memberId === ownerMemberId
    );
    const standing =
      founderHolding && typeof founderHolding.quantityShares === "number"
        ? founderHolding.quantityShares
        : 0;
    if (listingStands) continue; // maintained by market events; not a founding gap
    gaps.push({
      corporationId,
      homeCityId: typeof corp.homeCityId === "string" ? corp.homeCityId : "",
      ownerMemberId,
      expectedFounderShares: live,
      standingFounderShares: standing,
      missingShares: live - standing,
      listingRecordStands: false,
      openingReferencePriceRubars:
        typeof corp.openingReferencePriceRubars === "number"
          ? corp.openingReferencePriceRubars
          : null,
    });
  }
  return gaps;
}
