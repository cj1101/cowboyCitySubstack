/**
 * Valuation — spec §4.4/§4.5/§4.7. Pure functions, ported unchanged
 * from the market engine build (7167162).
 *
 *   fundamental = cash + structureValue + earningsTerm − caseDiscount
 *   earningsTerm = round(earningsProxy × 3), skipped (0) when proxy is
 *                  null, and forced to 0 while downtimeFlag is set
 *   caseDiscount = tier1 10% / tier2 25% of (cash + structureValue)
 *   referenceMarketCap = round(fundamental × judgmentMultiplier)
 *   referencePrice = max(1, round(cap / sharesOutstanding))
 *   judgmentMultiplier = 0.50 + 1.50 × (mean(Quality,Scale,Importance)/100)
 *
 * The multiplier is bounded [0.50, 2.00] BY CONSTRUCTION from scores in
 * [0,100]; `clampJudgmentMultiplier` additionally clamps a raw
 * externally supplied multiplier into the band and reports that it did
 * so (a clamp is logged, never silent — §4.7 step 3 logs uncapped vs
 * applied).
 */

import {
  CASE_DISCOUNT_TIER1,
  CASE_DISCOUNT_TIER2,
  CodedValuationInputs,
  EARNINGS_MULTIPLE,
  JUDGMENT_MULTIPLIER_MAX,
  JUDGMENT_MULTIPLIER_MIN,
  JudgmentScores,
  PRICE_FLOOR_RUBARS,
  STEP_CAP_RATE,
  assertIntegerRubars,
  roundHalfUp,
} from "./types";

export function validateJudgmentScores(scores: JudgmentScores): void {
  for (const key of ["quality", "scale", "importance"] as const) {
    const v = scores[key];
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      throw new Error(`market: judgment score ${key} must be an integer 0..100, got ${v}`);
    }
  }
}

/** Multiplier derived from scores (§4.4). Always inside [0.50, 2.00]. */
export function judgmentMultiplierFromScores(scores: JudgmentScores): number {
  validateJudgmentScores(scores);
  const mean = (scores.quality + scores.scale + scores.importance) / 3;
  const raw = JUDGMENT_MULTIPLIER_MIN +
    (JUDGMENT_MULTIPLIER_MAX - JUDGMENT_MULTIPLIER_MIN) * (mean / 100);
  return clampJudgmentMultiplier(raw).multiplier;
}

/** Clamp any supplied multiplier into [0.50, 2.00]; `clamped` tells the
 * caller the band bit, so the Log can say so. */
export function clampJudgmentMultiplier(raw: number): { multiplier: number; clamped: boolean } {
  if (!Number.isFinite(raw)) throw new Error(`market: judgment multiplier must be finite, got ${raw}`);
  const multiplier = Math.min(JUDGMENT_MULTIPLIER_MAX, Math.max(JUDGMENT_MULTIPLIER_MIN, raw));
  return { multiplier, clamped: multiplier !== raw };
}

export interface ValuationResult {
  fundamentalRubars: number;
  earningsTermRubars: number;
  openCaseDiscountRubars: number;
  judgmentMultiplier: number;
  /** Uncapped formula outputs — carried verbatim for the M-06 Log entry
   * even when the step cap binds (§4.7 step 3). */
  uncappedReferenceMarketCapRubars: number;
  uncappedReferencePriceRubars: number;
  skippedInputs: string[];
  atFloor: boolean;
}

export function computeValuation(
  inputs: CodedValuationInputs,
  scores: JudgmentScores,
): ValuationResult {
  assertIntegerRubars(inputs.companyCashRubars, "companyCashRubars");
  assertIntegerRubars(inputs.operatingStructureValueRubars, "operatingStructureValueRubars");
  if (inputs.sharesOutstanding <= 0) {
    throw new Error("market: sharesOutstanding must be > 0 to price");
  }
  const skippedInputs: string[] = [];

  let earningsTermRubars = 0;
  if (inputs.downtimeFlag) {
    earningsTermRubars = 0; // §4.3: downtime zeroes the earnings term
  } else if (inputs.earningsProxyRubars === null) {
    skippedInputs.push("earningsProxyRubars: unset");
  } else {
    assertIntegerRubars(inputs.earningsProxyRubars, "earningsProxyRubars");
    earningsTermRubars = roundHalfUp(inputs.earningsProxyRubars * EARNINGS_MULTIPLE);
  }

  const assetBase = inputs.companyCashRubars + inputs.operatingStructureValueRubars;
  const openCaseDiscountRubars =
    inputs.legalExposureTier === 2
      ? roundHalfUp(CASE_DISCOUNT_TIER2 * assetBase)
      : inputs.legalExposureTier === 1
        ? roundHalfUp(CASE_DISCOUNT_TIER1 * assetBase)
        : 0;

  const fundamentalRubars = assetBase + earningsTermRubars - openCaseDiscountRubars;
  const judgmentMultiplier = judgmentMultiplierFromScores(scores);

  if (fundamentalRubars <= 0) {
    // §4.4: priced at the 1 R floor, displayed as floored — never 0/negative.
    return {
      fundamentalRubars,
      earningsTermRubars,
      openCaseDiscountRubars,
      judgmentMultiplier,
      uncappedReferenceMarketCapRubars: fundamentalRubars,
      uncappedReferencePriceRubars: PRICE_FLOOR_RUBARS,
      skippedInputs,
      atFloor: true,
    };
  }

  const uncappedReferenceMarketCapRubars = roundHalfUp(fundamentalRubars * judgmentMultiplier);
  const uncappedReferencePriceRubars = Math.max(
    PRICE_FLOOR_RUBARS,
    roundHalfUp(uncappedReferenceMarketCapRubars / inputs.sharesOutstanding),
  );
  return {
    fundamentalRubars,
    earningsTermRubars,
    openCaseDiscountRubars,
    judgmentMultiplier,
    uncappedReferenceMarketCapRubars,
    uncappedReferencePriceRubars,
    skippedInputs,
    atFloor: false,
  };
}

/** §4.2 opening price: paid-in capital priced through the same formula
 * shape (cash-only fundamental) so listing uses one valuation path.
 * The resolver family passes the company's POST-money cash position
 * when a later listing (M-01 on an operating company) prices the whole
 * business — the formula input is the cash term either way. */
export function openingReferencePriceRubars(
  paidInCapitalRubars: number,
  sharesIssued: number,
  scores: JudgmentScores,
): ValuationResult & { openingPriceRubars: number } {
  const result = computeValuation(
    {
      companyCashRubars: paidInCapitalRubars,
      operatingStructureValueRubars: 0,
      earningsProxyRubars: null,
      legalExposureTier: 0,
      downtimeFlag: false,
      sharesOutstanding: sharesIssued,
    },
    scores,
  );
  return { ...result, openingPriceRubars: result.uncappedReferencePriceRubars };
}

export type StepCapException = "dissolution" | "tier2-case-against-company" | null;

export interface StepCapResult {
  /** The price that actually applies after the cap. */
  appliedPriceRubars: number;
  /** The uncapped formula price — MUST be logged beside the applied one. */
  uncappedPriceRubars: number;
  capApplied: boolean;
  exceptionApplied: StepCapException;
}

/**
 * §4.7 step 3 + the stat-model lock: a single Resolution Event moves
 * the reference price at most ±25% of the prior reference price.
 * Exceptions (formula result stands): dissolution/liquidation, and a
 * tier-2 case opening against the company itself. The difference is
 * NOT carried forward — no shadow prices; the next event recomputes
 * from state.
 */
export function applyStepCap(
  priorReferencePriceRubars: number,
  uncappedPriceRubars: number,
  exceptionApplied: StepCapException = null,
): StepCapResult {
  if (priorReferencePriceRubars <= 0) {
    // No prior price (listing): the uncapped price is the opening price.
    return { appliedPriceRubars: uncappedPriceRubars, uncappedPriceRubars, capApplied: false, exceptionApplied };
  }
  if (exceptionApplied !== null) {
    return { appliedPriceRubars: uncappedPriceRubars, uncappedPriceRubars, capApplied: false, exceptionApplied };
  }
  // Cap bounds round TOWARD the prior price (up-bound floored, down-bound
  // ceiled) so a capped move never exceeds ±25%. This matches the spec §9
  // worked example, which applies the down-cap to 27 as "20.25 → 21" — a
  // deliberate deviation from §4.4's generic half-up note, flagged in the
  // engine prep report for Cato/Vera to confirm at merge.
  const maxUp = Math.floor(priorReferencePriceRubars * (1 + STEP_CAP_RATE));
  const maxDown = Math.max(PRICE_FLOOR_RUBARS, Math.ceil(priorReferencePriceRubars * (1 - STEP_CAP_RATE)));
  const appliedPriceRubars = Math.min(maxUp, Math.max(maxDown, uncappedPriceRubars));
  return {
    appliedPriceRubars,
    uncappedPriceRubars,
    capApplied: appliedPriceRubars !== uncappedPriceRubars,
    exceptionApplied: null,
  };
}

/** §4.1 official price: last trade price if a trade occurred since the
 * last repricing, otherwise the (possibly repriced) reference price.
 * Coded rule, never a judgment call. */
export function officialPriceRubars(args: {
  referencePriceRubars: number;
  lastTradePriceRubars: number | null;
  tradedSinceLastRepricing: boolean;
}): number {
  return args.tradedSinceLastRepricing && args.lastTradePriceRubars !== null
    ? args.lastTradePriceRubars
    : args.referencePriceRubars;
}
