/**
 * Settlement arithmetic — spec §1.6/§5.3/§5.6. T+0, atomic, in-event.
 *
 * The pure half: fee schedule and per-execution delta computation.
 * The resolver family (lib/sim/rules/market.ts) turns these deltas
 * into finance transfer-primitive lines (member ↔ member for value,
 * each side → Market Account for its fee) and holding writes, so every
 * settled event is conservation-checkable under the finance grammar
 * unchanged. An event either settles completely as previewed or is
 * rejected; there is no pending/failed-settlement state.
 *
 * Fees (§5.3): 0.25% of trade value, rounded UP to whole Rubars,
 * minimum 1 R, charged to BOTH sides and credited to the Market
 * Account. The fee line exists in every trade's Log entry even when 0
 * (zero-price transfers, §1.6 step 8, carry a 0 fee — the primitive
 * drops the zero line, the entry still states it).
 */

import { EXCHANGE_FEE_RATE } from "./types";

export function exchangeFeeRubars(tradeValueRubars: number): number {
  if (tradeValueRubars <= 0) return 0;
  return Math.max(1, Math.ceil(tradeValueRubars * EXCHANGE_FEE_RATE));
}

export interface ExecutionSettlement {
  tradeValueRubars: number;
  buyerFeeRubars: number;
  sellerFeeRubars: number;
  /** Signed cash deltas the caller folds into transfer lines. */
  buyerCashDeltaRubars: number; // −(value + buyer fee)
  sellerCashDeltaRubars: number; // +(value − seller fee)
  marketAccountDeltaRubars: number; // +(both fees)
}

/** The money shape of one execution at a stated price. Cash-side
 * sufficiency is the caller's validation (against planned docs);
 * share-side sufficiency is guaranteed for resting sells by the
 * placement-time commitment and validated for incoming sells at
 * placement. */
export function settleExecution(args: {
  quantityShares: number;
  priceRubars: number;
}): ExecutionSettlement {
  const tradeValueRubars = args.quantityShares * args.priceRubars;
  const buyerFeeRubars = exchangeFeeRubars(tradeValueRubars);
  const sellerFeeRubars = exchangeFeeRubars(tradeValueRubars);
  return {
    tradeValueRubars,
    buyerFeeRubars,
    sellerFeeRubars,
    buyerCashDeltaRubars: -(tradeValueRubars + buyerFeeRubars),
    sellerCashDeltaRubars: tradeValueRubars - sellerFeeRubars,
    marketAccountDeltaRubars: buyerFeeRubars + sellerFeeRubars,
  };
}
