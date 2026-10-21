/**
 * lib/market — pure market core types (Cato, market-systems-spec.md v1),
 * ported from the ahead-of-phase market engine build (commit 7167162)
 * and adapted to the landed Phase 4 contracts.
 *
 * Types and constants only in this file. NO Firestore, NO I/O, NO
 * lib/sim imports: the resolver family (lib/sim/rules/market.ts)
 * adapts these pure functions into ResolutionPlans.
 *
 * Custody adaptation (build-prep P4-K21(i), ADOPTED — it supersedes
 * the engine build's Market-Maker inventory model and the spec §9
 * worked-example arithmetic): float shares remain in the founder's
 * holding as COMMITTED — mechanically a resting limit sell (the float
 * offer). The Market Maker holds NO share inventory of its own, ever;
 * it executes against committed float under a standing mandate; float
 * sales credit the founder's account; fees accrue to the Market
 * Account. Share conservation therefore reads: Σ member holdings +
 * retired == sharesOutstanding, with any market-maker inventory term
 * identically zero.
 *
 * Governing invariants (spec §0.2): integer Rubars at rest; the only
 * clock is the Log `seq`; no price moves without a player-caused
 * Resolution Event; published (owner-claimed) figures are NEVER
 * pricing inputs.
 */

/** §4.7 / stat-model lock: one event moves a reference price at most
 * ±25%. Exported so no caller hard-codes the number. */
export const STEP_CAP_RATE = 0.25;
export const JUDGMENT_MULTIPLIER_MIN = 0.5;
export const JUDGMENT_MULTIPLIER_MAX = 2.0;
export const EARNINGS_MULTIPLE = 3; // N-7
export const CASE_DISCOUNT_TIER1 = 0.1; // N-8
export const CASE_DISCOUNT_TIER2 = 0.25; // N-8
export const EXCHANGE_FEE_RATE = 0.0025; // N-3, per side, min 1 R
export const MARKET_MAKER_SPREAD_RATE = 0.02; // N-4, per side of reference
export const INDEX_BASE_LEVEL = 1000; // N-9 — RCI reads 1000.00 at first listing
export const CONCENTRATION_WARN_THRESHOLD = 0.5; // N-9 — warns, never trades
export const PRICE_FLOOR_RUBARS = 1;

/** N-2 issuance bounds at listing (standard issuance when unstated). */
export const STANDARD_ISSUANCE_SHARES = 10_000;
export const MIN_ISSUANCE_SHARES = 1_000;
export const MAX_ISSUANCE_SHARES = 1_000_000;

/** N-5 lock proposal (Cato, this build): the Market Account's genesis
 * seed, minted by the M-00 founding act under finance §3.3's closed
 * list. Under custody the account never trades in v1; the seed is the
 * operator's float for fee/escrow custody headroom (finance FN-5),
 * sized at 4× the genesis grant. Flagged in the step-7 prep report. */
export const MARKET_ACCOUNT_SEED_RUBARS = 1_000_000;

export type TradingStatus = "open" | "halted" | "suspended" | "delisted";

/** §4.5 judgment scores — integers 0..100, produced by the fabric inside
 * a triggering event only (arriving via the F-07 prepared payload);
 * validated by code (valuation.ts), never clamped silently
 * (out-of-range is a rejection, per spec §10.3 QA asks). A member's own
 * action NEVER carries scores — an action naming its own company's
 * judgment is a fairness breach, not an input. */
export interface JudgmentScores {
  quality: number;
  scale: number;
  importance: number;
}

/** §4.3 coded inputs — deterministic, recomputable from verified
 * records. Assembled by the resolver family from a CLOSED field list:
 * `legacyBookRubars` is provenance only and is structurally absent
 * here (P4-G6: recorded, provably not an M-06 input).
 * `earningsProxyRubars: null` is null-honesty: the term is skipped and
 * the skip is reported, never back-filled. */
export interface CodedValuationInputs {
  companyCashRubars: number;
  operatingStructureValueRubars: number;
  earningsProxyRubars: number | null;
  legalExposureTier: 0 | 1 | 2;
  downtimeFlag: boolean;
  /** LIVE shares (issued − retired) — the per-share divisor. */
  sharesOutstanding: number;
  operatingCitiesCount?: number; // evidence only (§4.3) — never a formula term
  tradeEdgesCount?: number; // evidence only
}

/** The listing facts the pure functions consume (the resolver family
 * projects the standing listing record into this shape). */
export interface ListingSnapshot {
  corporationId: string;
  ownerMemberId: string;
  /** Live shares (issued − retired). */
  sharesOutstanding: number;
  /** Index float input: committed founder float + publicly held shares. */
  floatShares: number;
  referencePriceRubars: number;
  lastTradePriceRubars: number | null;
  officialPriceRubars: number;
  tradingStatus: TradingStatus;
}

/** Half-up rounding, the spec §4.4 convention, applied once per
 * formula step. */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function assertIntegerRubars(value: number, field: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`market: ${field} must be integer Rubars, got ${value}`);
  }
}
