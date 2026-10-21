/**
 * Realm Composite Index (RCI) — spec §3. DERIVED, NEVER STORED.
 * Ported unchanged from the market engine build (7167162).
 *
 * This module intentionally exposes no storage shape and no writer:
 * the index is a pure function of verified constituents + a genesis
 * divisor. A cached display value may ride in a dashboard snapshot
 * elsewhere, labeled with its as_of_seq (spec §0.3 A-6); that cache is
 * not this module's concern and is never authoritative.
 *
 *   weight_i = (officialPrice_i × floatShares_i) / Σ_j (…)
 *   RCI = 1000 × (Σ_i officialPrice_i × floatShares_i) / DivisorBase
 *   DivisorBase is set at the genesis listing event so RCI = 1000.00 there.
 */

import {
  CONCENTRATION_WARN_THRESHOLD,
  INDEX_BASE_LEVEL,
  ListingSnapshot,
  roundHalfUp,
} from "./types";

export interface IndexConstituent {
  corporationId: string;
  officialPriceRubars: number;
  floatShares: number;
  tradingStatus: ListingSnapshot["tradingStatus"];
}

export interface IndexWeight extends IndexConstituent {
  floatMarketCapRubars: number;
  /** 0..1 share of total float market cap. */
  weight: number;
  floatLabel: string | null; // "float: 0 — no tradable supply" (§2.2)
}

export interface RealmIndex {
  /** Display level, rounded to 2 decimals (§3.2). Inputs are stored by
   * the caller; this rounded value never is (as authoritative state). */
  level: number;
  divisorBase: number;
  totalFloatMarketCapRubars: number;
  weights: IndexWeight[];
  concentrationWarnings: { corporationId: string; weight: number }[];
}

export function constituentFromListing(listing: ListingSnapshot): IndexConstituent {
  return {
    corporationId: listing.corporationId,
    officialPriceRubars: listing.officialPriceRubars,
    floatShares: listing.floatShares,
    tradingStatus: listing.tradingStatus,
  };
}

/** Set DivisorBase at the genesis listing event so the index reads
 * exactly 1000.00 at that seq (§3.2): DivisorBase IS the genesis float
 * market cap, used as RCI = 1000 × currentFloatCap / DivisorBase. */
export function divisorBaseForGenesis(constituents: IndexConstituent[]): number {
  const total = tradableFloatCap(constituents);
  if (total <= 0) throw new Error("market: genesis divisor needs a positive float market cap");
  return total;
}

function tradableFloatCap(constituents: IndexConstituent[]): number {
  // Delisted companies have exited (§3.3); halted/suspended stay in at
  // their last official price (§3.3 — no invented exit price).
  return constituents
    .filter((c) => c.tradingStatus !== "delisted")
    .reduce((sum, c) => sum + c.officialPriceRubars * c.floatShares, 0);
}

/**
 * Derive the index from current verified constituents. Reproducible by
 * hand from the Log; the same function computes the index as-of any
 * past seq when fed that seq's composition (§3.3).
 */
export function deriveRealmIndex(
  constituents: IndexConstituent[],
  divisorBase: number,
): RealmIndex {
  if (divisorBase <= 0) throw new Error("market: divisorBase must be > 0");
  const live = constituents.filter((c) => c.tradingStatus !== "delisted");
  const totalFloatMarketCapRubars = tradableFloatCap(constituents);
  const level =
    totalFloatMarketCapRubars === 0
      ? 0
      : roundHalfUp(((INDEX_BASE_LEVEL * totalFloatMarketCapRubars) / divisorBase) * 100) / 100;

  const weights: IndexWeight[] = live.map((c) => {
    const floatMarketCapRubars = c.officialPriceRubars * c.floatShares;
    return {
      ...c,
      floatMarketCapRubars,
      weight: totalFloatMarketCapRubars === 0 ? 0 : floatMarketCapRubars / totalFloatMarketCapRubars,
      floatLabel: c.floatShares === 0 ? "float: 0 — no tradable supply" : null,
    };
  });

  // §3.4: the cap WARNS — it never trades, trims, or reweights.
  const concentrationWarnings = weights
    .filter((w) => w.weight > CONCENTRATION_WARN_THRESHOLD)
    .map((w) => ({ corporationId: w.corporationId, weight: w.weight }));

  return { level, divisorBase, totalFloatMarketCapRubars, weights, concentrationWarnings };
}
