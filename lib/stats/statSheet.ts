/**
 * The per-city sim stat sheet model (Phase 3 brief §6.1).
 *
 * One model builder for every city — no city-slug conditionals anywhere
 * in this module (parity invariant, brief §0.1.6 / TC-D02). The same
 * model backs the city page's Sim sheet section and the dashboard
 * my-city panel's sheet variant, so the identical-component requirement
 * (TC-D01) holds by construction.
 *
 * Honesty rules (brief §6.1, even-start ruling, V03 null-honesty):
 *  - `null` figures render as `—` with a one-line caption — never an
 *    invented number, never a fabricated zero.
 *  - A city with no `sim_cities` doc is NOT in the sim: the model says
 *    so and carries no figures at all (an unowned or not-yet-switched-on
 *    city must not render a table of template values as if it were
 *    being simulated).
 *  - Only verified figures live here. Owner-published claims are a
 *    separate block (§7.2) fed by `sim_publications`; corpus/lore
 *    figures never enter this model (TC-D04's frontend corollary).
 *
 * Pure: doc-shaped inputs in, render model out. No I/O.
 */

import { statFieldPath, type WhyLinkRequest } from "./whyLink";

/** The eight allocatable indices, in sheet order (Phase 1 template). */
export const SIM_INDEX_KEYS = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "military",
  "defense",
] as const;

/** The stock figures, in sheet order after the indices (§6.1). */
export const SIM_STOCK_KEYS = [
  "treasuryRubars",
  "gdpRubars",
  "population",
  "households",
  "housingUnits",
] as const;

export type SimStatKey =
  | (typeof SIM_INDEX_KEYS)[number]
  | (typeof SIM_STOCK_KEYS)[number];

const STAT_LABELS: Record<SimStatKey, string> = {
  spirit: "Spirit",
  culture: "Culture",
  infrastructure: "Infrastructure",
  stability: "Stability",
  law: "Law",
  influence: "Influence",
  military: "Military",
  defense: "Defense",
  treasuryRubars: "Treasury",
  gdpRubars: "GDP",
  population: "Population",
  households: "Households",
  housingUnits: "Housing units",
};

const STAT_UNITS: Partial<Record<SimStatKey, string>> = {
  treasuryRubars: "Rubar",
  gdpRubars: "Rubar",
};

/** Why a figure is null, in the sheet's honest captions (§6.1). */
export type NullCaptionKind = "not-allocated" | "no-figure";

export const NULL_CAPTIONS: Record<NullCaptionKind, string> = {
  "not-allocated": "Not yet allocated",
  "no-figure":
    "No figure recorded — the corpus gives none and none has been set in play",
};

export interface StatFigure {
  key: SimStatKey;
  label: string;
  unit: string | null;
  /** The landed `changes[].field` dot-path this figure answers to. */
  fieldPath: string;
  /** The verified value, `null` exactly as stored — never coerced. */
  value: number | null;
  /** Display string: grouped number, or `—` for null. */
  display: string;
  /** True when the value still equals the even-start baseline value. */
  atBaselineValue: boolean;
  /** The value the owner allocated to this figure, from the allocation
   * doc's `allocations` map; null until an allocation commits (Phase 4
   * data — Phase 3 data never populates it). */
  allocatedValue: number | null;
  /** Growth since allocation: current value minus the allocated value,
   * when both exist (§6.1's growth-since-allocation summary, doc-level
   * form — the Log-derived form arrives with Phase 4 allocation data).
   * Null whenever either side is missing; never fabricated. */
  growthSinceAllocation: number | null;
  /** The why-link for this figure, or null when there is nothing to
   * explain: a null figure (the caption explains instead), or a figure
   * no resolution has ever changed (the doc carries no anchor).
   * Anchor choice (§6.2): a figure still at its committed allocation
   * value anchors the allocation entry; any other figure anchors the
   * state doc's `lastChangedSeq` pointer. */
  whyLink: WhyLinkRequest | null;
  /** Caption kind when the figure is null; null otherwise. */
  nullCaption: NullCaptionKind | null;
}

export type AllocationState = "unallocated" | "allocated";

export interface StatSheetModel {
  factionId: string;
  /** "active" = a `sim_cities` doc exists; "not-in-sim" = none does. */
  state: "active" | "not-in-sim";
  figures: StatFigure[];
  allocationState: AllocationState | null;
  /** Raw allocation status as stored (Phase 4 owns its lifecycle);
   * rendered honestly, never reinterpreted. */
  allocationStatus: string | null;
  /** The allocation doc's `committedSeq` — the Log anchor for the
   * allocation entry (§6.1). Null until an allocation commits. */
  allocationCommittedSeq: number | null;
  /** The doc-level pointers the why-links anchor to (§6.2). */
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  lastActionSeq: number | null;
}

/** Grouped integer display (the sim's figures are integral Rubar /
 * counts / 0–100 indices). Non-integers render as stored, grouped. */
export function formatStatValue(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Build the sheet model from the landed doc shapes:
 *  - `simCity`: the `sim_cities/{factionId}` doc data, or null when the
 *    city has no sim state (unowned, or claimed but not switched on).
 *  - `allocation`: the `sim_stat_allocations/{factionId}` doc data, or
 *    null. Phase 1 lands it with `status: "not_started"`; the
 *    allocation commit itself is Phase 4, so "unallocated" is the only
 *    state Phase 3 data produces — the model still reads the doc
 *    honestly rather than assuming.
 */
export function buildStatSheetModel(input: {
  factionId: string;
  simCity: Record<string, unknown> | null;
  allocation: Record<string, unknown> | null;
}): StatSheetModel {
  const { factionId, simCity, allocation } = input;

  if (simCity === null) {
    return {
      factionId,
      state: "not-in-sim",
      figures: [],
      allocationState: null,
      allocationStatus: null,
      allocationCommittedSeq: null,
      lastChangedSeq: null,
      lastResolutionId: null,
      lastActionSeq: null,
    };
  }

  const stats = asRecord(simCity.stats) ?? {};
  const baselineStats = asRecord(asRecord(simCity.baseline)?.baselineStats) ?? {};
  const lastChangedSeq = asNumberOrNull(simCity.lastChangedSeq);
  const allocationStatus =
    typeof allocation?.status === "string" ? allocation.status : null;
  const allocationState: AllocationState =
    allocationStatus !== null && allocationStatus !== "not_started"
      ? "allocated"
      : "unallocated";

  const allocations = asRecord(allocation?.allocations) ?? {};
  const allocationCommittedSeq = asNumberOrNull(allocation?.committedSeq);
  const figures: StatFigure[] = (
    [...SIM_INDEX_KEYS, ...SIM_STOCK_KEYS] as SimStatKey[]
  ).map((key) => {
    const value = asNumberOrNull(stats[key]);
    const allocatedValue = asNumberOrNull(allocations[key]);
    // Null indices before allocation read "Not yet allocated"; a null
    // that survives allocation (population/GDP with no figure set in
    // play) reads as the no-figure caption. Bookkeeping stocks are true
    // zeroes in the landed template and never take a null caption in
    // practice; if one ever arrives null it gets the no-figure caption,
    // never an invented zero.
    const nullCaption: NullCaptionKind | null =
      value !== null
        ? null
        : (SIM_INDEX_KEYS as readonly string[]).includes(key) &&
            allocationState === "unallocated"
          ? "not-allocated"
          : "no-figure";
    return {
      key,
      label: STAT_LABELS[key],
      unit: STAT_UNITS[key] ?? null,
      fieldPath: statFieldPath(key),
      value,
      display: value === null ? "—" : formatStatValue(value),
      atBaselineValue:
        value !== null && value === asNumberOrNull(baselineStats[key]),
      allocatedValue,
      growthSinceAllocation:
        value !== null && allocatedValue !== null
          ? value - allocatedValue
          : null,
      // §6.2 anchors. A figure still at its committed allocation
      // value anchors the allocation entry — the entry whose
      // changes[] set it — even after later resolutions moved the
      // doc pointer past it. Any other figure anchors the state
      // doc's pointer pair. No anchor exists until a resolution has
      // actually changed this city (the pointer is null before
      // that), and null figures have no why-link — the caption is
      // the explanation. (In Phase 3 data no allocation has
      // committed, so the allocation branch is inert until Phase 4
      // data lands; the shape is read honestly either way.)
      whyLink:
        value === null
          ? null
          : allocationCommittedSeq !== null &&
              allocatedValue !== null &&
              value === allocatedValue
            ? {
                cityId: factionId,
                fieldPath: statFieldPath(key),
                anchorSeq: allocationCommittedSeq,
              }
            : lastChangedSeq !== null
              ? {
                  cityId: factionId,
                  fieldPath: statFieldPath(key),
                  anchorSeq: lastChangedSeq,
                }
              : null,
      nullCaption,
    };
  });

  return {
    factionId,
    state: "active",
    figures,
    allocationState,
    allocationStatus,
    allocationCommittedSeq,
    lastChangedSeq,
    lastResolutionId:
      typeof simCity.lastResolutionId === "string"
        ? simCity.lastResolutionId
        : null,
    lastActionSeq: asNumberOrNull(simCity.lastActionSeq),
  };
}
