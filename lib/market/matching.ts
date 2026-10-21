/**
 * Matching — spec §1.5/§1.6. Deterministic code, price–time priority,
 * ported unchanged from the market engine build (7167162). The fabric
 * has no role in deciding who trades with whom or at what price.
 *
 * Execution price is the RESTING order's price. Self-match is prevented
 * (same member account is skipped and the skip is reported). A market
 * order's unfilled remainder is cancelled; a limit order's remainder
 * rests. Under the custody model (P4-K21) the founder's float offer is
 * simply a resting sell order in this book — there is no separate
 * market-maker inventory path.
 */

import { TradingStatus } from "./types";

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";

export interface RestingOrder {
  orderId: string;
  listingId: string;
  memberId: string;
  side: OrderSide;
  quantityShares: number; // remaining
  limitPriceRubars: number;
  placedAtSeq: number;
  expiresAtSeq: number | null;
}

export interface IncomingOrder {
  orderId: string;
  listingId: string;
  memberId: string;
  side: OrderSide;
  type: OrderType;
  quantityShares: number;
  /** Limit price for limit orders; the mandatory protection cap/floor
   * for market orders (§1.5). */
  limitPriceRubars: number;
}

export interface Execution {
  incomingOrderId: string;
  restingOrderId: string;
  buyerMemberId: string;
  sellerMemberId: string;
  quantityShares: number;
  /** Resting order's price (§1.6 step 4). */
  priceRubars: number;
}

export interface MatchResult {
  executions: Execution[];
  filledShares: number;
  remainderShares: number;
  /** Market order remainder is cancelled; limit remainder rests (§1.6.6). */
  remainderDisposition: "rest" | "cancel" | "none";
  selfMatchSkipped: boolean;
  /** Resting orders after fills (quantities reduced / filled removed). */
  bookAfter: RestingOrder[];
}

export function matchIncomingOrder(
  incoming: IncomingOrder,
  book: RestingOrder[],
  tradingStatus: TradingStatus,
): MatchResult {
  if (tradingStatus !== "open") {
    throw new Error(`market: no matching while listing is ${tradingStatus} (§1.8)`);
  }
  const opposite: OrderSide = incoming.side === "buy" ? "sell" : "buy";
  const crosses = (resting: RestingOrder): boolean =>
    incoming.side === "buy"
      ? resting.limitPriceRubars <= incoming.limitPriceRubars
      : resting.limitPriceRubars >= incoming.limitPriceRubars;

  const candidates = book
    .filter((o) => o.listingId === incoming.listingId && o.side === opposite)
    .sort((a, b) =>
      incoming.side === "buy"
        ? a.limitPriceRubars - b.limitPriceRubars || a.placedAtSeq - b.placedAtSeq
        : b.limitPriceRubars - a.limitPriceRubars || a.placedAtSeq - b.placedAtSeq,
    );

  let remaining = incoming.quantityShares;
  let selfMatchSkipped = false;
  const executions: Execution[] = [];
  const filledByOrder = new Map<string, number>();

  for (const resting of candidates) {
    if (remaining <= 0) break;
    if (resting.memberId === incoming.memberId) {
      selfMatchSkipped = true; // §1.6 step 5 — skip, never execute, log it
      continue;
    }
    if (!crosses(resting)) continue;
    const qty = Math.min(remaining, resting.quantityShares);
    executions.push({
      incomingOrderId: incoming.orderId,
      restingOrderId: resting.orderId,
      buyerMemberId: incoming.side === "buy" ? incoming.memberId : resting.memberId,
      sellerMemberId: incoming.side === "buy" ? resting.memberId : incoming.memberId,
      quantityShares: qty,
      priceRubars: resting.limitPriceRubars,
    });
    filledByOrder.set(resting.orderId, qty);
    remaining -= qty;
  }

  const bookAfter = book
    .map((o) => ({ ...o, quantityShares: o.quantityShares - (filledByOrder.get(o.orderId) ?? 0) }))
    .filter((o) => o.quantityShares > 0);

  return {
    executions,
    filledShares: incoming.quantityShares - remaining,
    remainderShares: remaining,
    remainderDisposition: remaining === 0 ? "none" : incoming.type === "limit" ? "rest" : "cancel",
    selfMatchSkipped,
    bookAfter,
  };
}
