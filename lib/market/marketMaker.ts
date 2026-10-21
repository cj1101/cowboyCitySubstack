/**
 * The Market Maker function — spec §1.7, as re-founded on the custody
 * model (build-prep P4-K21(i), ADOPTED).
 *
 * What survives of §1.7: the QUOTE. For each listed, non-halted
 * listing the Operator stands ready at reference − halfSpread (bid)
 * and reference + halfSpread (ask), the half-spread being the
 * published schedule (N-4: 2% of reference, rounded to whole Rubars,
 * minimum 1 R). The quote is derived from the current reference price —
 * recomputed when the reference changes, otherwise inert. It prices
 * the block order type's derived protection cap (§1.5) and is what
 * display surfaces show; it sets no price itself.
 *
 * What P4-K21 supersedes: the engine build's inventory fills. The
 * Market Maker holds NO share inventory of its own — executions run
 * against committed float (the founder's resting float-offer order)
 * and the member book under the standing mandate, float sales credit
 * the FOUNDER's account, and the only money that ever reaches the
 * Market Account is fees (plus its genesis seed). A buy that finds no
 * committed float and no crossing book order simply does not fill:
 * the mandate creates no shares and spends no cash of its own. This
 * is why there is deliberately no fill function in this file — the
 * matching engine (matching.ts) over the unified book IS the mandate
 * execution, and any future "market maker takes the other side"
 * proposal must first amend P4-K21's share-conservation identity,
 * under which MM inventory is identically zero.
 */

import { MARKET_MAKER_SPREAD_RATE, roundHalfUp } from "./types";

export interface MarketMakerQuote {
  bidRubars: number;
  askRubars: number;
  halfSpreadRubars: number;
  referencePriceRubars: number;
}

/** Quote derived from the current reference price; recomputed when the
 * reference changes, otherwise inert. Half-spread: published % of
 * reference, rounded to whole Rubars, minimum 1 R (§1.7). */
export function marketMakerQuote(
  referencePriceRubars: number,
  spreadRate: number = MARKET_MAKER_SPREAD_RATE,
): MarketMakerQuote {
  const halfSpreadRubars = Math.max(1, roundHalfUp(referencePriceRubars * spreadRate));
  return {
    bidRubars: Math.max(1, referencePriceRubars - halfSpreadRubars),
    askRubars: referencePriceRubars + halfSpreadRubars,
    halfSpreadRubars,
    referencePriceRubars,
  };
}

/** The block order type's derived protection cap (§1.5, custody
 * reading): a block buy may cross resting supply up to reference +
 * halfSpread; a block sell may cross resting demand down to
 * reference − halfSpread. Executions still price at the RESTING
 * order's price (§1.6 step 4) — the cap bounds the sweep, it does
 * not set the print. Flagged in the step-7 prep report: the spec's
 * block text assumed an inventory counterparty; under custody the
 * block is a market order whose cap is derived rather than stated. */
export function blockProtectionCapRubars(
  side: "buy" | "sell",
  referencePriceRubars: number,
): number {
  const quote = marketMakerQuote(referencePriceRubars);
  return side === "buy" ? quote.askRubars : quote.bidRubars;
}
