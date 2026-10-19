/**
 * lib/dashboard/registry.ts — the dashboard panel registry (Phase 3).
 *
 * Frontend-owned (Dana A.5). This module is pure data + types: no I/O, no
 * Firestore, no React. It carries two contracts:
 *
 *   1. The panel registry itself (phase3-implementation-brief.md §4.2):
 *      all 14 panel IDs registered from day one so prefs stay
 *      forward-compatible; 11 ship in Phase 3, 3 are reserve-hidden
 *      (`deal-spawn`, `market-index`, `portfolio`) and render nothing.
 *
 *   2. The snapshot prop contract (brief §2.1, Dana §3.1): the shapes the
 *      dashboard read path (lib/dashboard/snapshotRead.ts, Build Lead) hands
 *      to the panel components under components/dashboard/panels/. Panels
 *      consume these props only — they never read collections themselves.
 *
 * Tier discipline (brief §0.1 / CJ §7.4): everything in the snapshot contract
 * is the PUBLIC-tier projection. Actor-private Log entries contribute
 * nothing to these shapes — not a summary, not a count, not a gap. A
 * member's own private entries reach the digest only as the separately
 * flagged DigestEntry.isOwnPrivate layer the read path merges in
 * client-side; they are never part of DashboardSnapshot.
 */

// ---------------------------------------------------------------------------
// Panel registry
// ---------------------------------------------------------------------------

export type PanelId =
  | "world-strip"
  | "my-city"
  | "digest"
  | "situations-peek"
  | "city-grid"
  | "contests"
  | "town-hall"
  | "npc-team"
  | "sports"
  | "lore-highlights"
  | "action-box"
  | "deal-spawn"
  | "market-index"
  | "portfolio";

export interface PanelVariantDef {
  id: string;
  /** Plain-language name for the Customize editor's variant picker. */
  label: string;
}

export interface PanelRegistryEntry {
  panelId: PanelId;
  title: string;
  variants: PanelVariantDef[];
  /** Variant used when prefs name none (or an unknown one). Null = none. */
  defaultVariant: string | null;
  defaultVisible: boolean;
  defaultOrder: number;
  /** Phase in which the panel first renders. Reserve panels keep their
   *  entry (prefs referencing them are inert, never an error) but render
   *  nothing until their phase. */
  shipsInPhase: 3 | 4 | 5 | 7;
  reserve: boolean;
  /** "members" panels are absent for guests — not disabled-looking,
   *  absent (spec §5.2, TC-G03). */
  audience: "all" | "members";
  guestVisible: boolean;
}

export const PANEL_REGISTRY: PanelRegistryEntry[] = [
  {
    panelId: "world-strip",
    title: "World strip",
    variants: [
      { id: "full", label: "Full strip" },
      { id: "compact", label: "Compact strip" },
    ],
    defaultVariant: "full",
    defaultVisible: true,
    defaultOrder: 0,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "my-city",
    title: "My city",
    variants: [
      { id: "sheet", label: "Full sheet" },
      { id: "card", label: "Compact card" },
    ],
    defaultVariant: "sheet",
    defaultVisible: true,
    defaultOrder: 1,
    shipsInPhase: 3,
    reserve: false,
    audience: "all", // guests get the Featured city form (brief §5.3)
    guestVisible: true,
  },
  {
    panelId: "digest",
    title: "What Happened",
    variants: [
      { id: "standard", label: "Standard (up to 10)" },
      { id: "brief", label: "Brief (up to 5)" },
    ],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 2,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "situations-peek",
    title: "Situations",
    variants: [
      { id: "standard", label: "Count and top items" },
      { id: "count-only", label: "Count only" },
    ],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 3,
    shipsInPhase: 3,
    reserve: false,
    audience: "members", // owner-private data; no export affordance, ever
    guestVisible: false,
  },
  {
    panelId: "city-grid",
    title: "The Realm",
    variants: [
      { id: "cards", label: "Cards" },
      { id: "table", label: "Table (every figure)" },
    ],
    defaultVariant: "cards",
    defaultVisible: true,
    defaultOrder: 4,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "contests",
    title: "Contest board",
    variants: [
      { id: "standard", label: "Standard" },
      { id: "compact", label: "Compact" },
    ],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 5,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "town-hall",
    title: "Town Hall",
    variants: [
      { id: "standard", label: "Standard" },
      { id: "compact", label: "Compact" },
    ],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 6,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "npc-team",
    title: "NPC teams",
    variants: [
      { id: "mine", label: "My team" },
      { id: "realm", label: "Realm teams" },
    ],
    defaultVariant: "mine",
    defaultVisible: true,
    defaultOrder: 7,
    shipsInPhase: 3,
    reserve: false,
    audience: "all", // guests see the realm tab only; the mine tab is member data
    guestVisible: true,
  },
  {
    panelId: "sports",
    title: "Sports",
    variants: [
      { id: "standard", label: "Standings and results" },
      { id: "scores-only", label: "Scores only" },
    ],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 8,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "lore-highlights",
    title: "Lore highlights",
    variants: [
      { id: "recent", label: "Most recent" },
      { id: "intertwined", label: "Intertwined cities" },
    ],
    defaultVariant: "recent",
    defaultVisible: true,
    defaultOrder: 9,
    shipsInPhase: 3,
    reserve: false,
    audience: "all",
    guestVisible: true,
  },
  {
    panelId: "action-box",
    title: "Take an action",
    variants: [],
    defaultVariant: null,
    defaultVisible: true,
    defaultOrder: 10,
    shipsInPhase: 3, // display-only shell in Phase 3; the play loop is Phase 4
    reserve: false,
    audience: "members",
    guestVisible: false,
  },
  {
    // Reserve (brief P3-D3): the deal portal and its spawn contract are
    // Phase 5. A visible spawn panel with nothing behind it would be a
    // hollow control (spec §8.1). Flipping this to a visible panel in
    // Phase 5 is a registry-default change, not a rebuild.
    panelId: "deal-spawn",
    title: "Deal Room",
    variants: [],
    defaultVariant: null,
    defaultVisible: false,
    defaultOrder: 11,
    shipsInPhase: 5,
    reserve: true,
    audience: "members",
    guestVisible: false,
  },
  {
    // Reserve (brief P3-D5): no listings exist until Phase 4's market
    // slice. When it ships, Cato's "live to the Log" contract applies:
    // the index is derived from Log-priced events, never stored truth.
    panelId: "market-index",
    title: "Market index",
    variants: [
      { id: "standard", label: "Standard" },
      { id: "compact", label: "Compact" },
    ],
    defaultVariant: "standard",
    defaultVisible: false,
    defaultOrder: 12,
    shipsInPhase: 4,
    reserve: true,
    audience: "all",
    guestVisible: true,
  },
  {
    // Reserve (brief P3-D5): holdings are requester-only data; the panel
    // and its export arrive with the Phase 4 market slice.
    panelId: "portfolio",
    title: "Portfolio",
    variants: [],
    defaultVariant: null,
    defaultVisible: false,
    defaultOrder: 13,
    shipsInPhase: 4,
    reserve: true,
    audience: "members",
    guestVisible: false,
  },
];

export const PANEL_BY_ID: Readonly<Record<PanelId, PanelRegistryEntry>> =
  Object.fromEntries(PANEL_REGISTRY.map((entry) => [entry.panelId, entry])) as Record<
    PanelId,
    PanelRegistryEntry
  >;

/** Panels that render in Phase 3, in shipped default order. */
export const SHIPPED_PANELS: PanelRegistryEntry[] = PANEL_REGISTRY.filter(
  (entry) => !entry.reserve,
).sort((a, b) => a.defaultOrder - b.defaultOrder);

/** Guest panel set [FINAL — spec §5.2]: shipped defaults, no prefs, no
 *  participation panels. */
export const GUEST_PANEL_IDS: PanelId[] = SHIPPED_PANELS.filter(
  (entry) => entry.guestVisible,
).map((entry) => entry.panelId);

/** The shipped default layout, in the exact prefs-doc entry shape
 *  (brief §2.2). A member with no prefs doc and a member who resets to
 *  defaults render byte-identical DOM (brief §5.1 / spec §5.3.3). */
export function defaultLayoutPanels(): {
  panelId: string;
  visible: boolean;
  order: number;
  variant?: string;
}[] {
  return [...PANEL_REGISTRY]
    .sort((a, b) => a.defaultOrder - b.defaultOrder)
    .map((entry) => ({
      panelId: entry.panelId,
      visible: entry.defaultVisible,
      order: entry.defaultOrder,
      ...(entry.defaultVariant ? { variant: entry.defaultVariant } : {}),
    }));
}

// ---------------------------------------------------------------------------
// Per-panel load state (spec §5.9: one state set for every panel)
// ---------------------------------------------------------------------------

/**
 * What snapshotRead hands each panel. "empty" is not a separate status:
 * a ready panel with empty data renders its own honest empty state.
 * `stale` rides alongside data — the panel still renders (brief §3.5).
 */
export type PanelLoadState<T> =
  | { status: "loading" }
  | { status: "error"; onRetry?: () => void }
  | { status: "ready"; data: T; stale?: boolean };

// ---------------------------------------------------------------------------
// The snapshot contract (brief §2.1 — sim_dashboard_snapshots/current)
// ---------------------------------------------------------------------------

/** The eight allocatable indices (Vera's stat-model lock). */
export type SimIndexKey =
  | "spirit"
  | "culture"
  | "infrastructure"
  | "stability"
  | "law"
  | "influence"
  | "military"
  | "defense";

export const SIM_INDEX_LABELS: Record<SimIndexKey, string> = {
  spirit: "Spirit",
  culture: "Culture",
  infrastructure: "Infrastructure",
  stability: "Stability",
  law: "Law",
  influence: "Influence",
  military: "Military",
  defense: "Defense",
};

/**
 * Compact stats as carried on a city card (Dana §3.1 via brief §2.1: the
 * six indices + treasury/GDP/population, in their landed sim_cities forms,
 * nulls preserved). military/defense are optional here: the card contract
 * names six indices; the full sheet (SimSheet) carries all eight. A writer
 * that includes them loses nothing — the grid table renders what exists.
 */
export interface DashboardCompactStats {
  spirit: number | null;
  culture: number | null;
  infrastructure: number | null;
  stability: number | null;
  law: number | null;
  influence: number | null;
  military?: number | null;
  defense?: number | null;
  treasuryRubars: number | null;
  gdpRubars: number | null;
  population: number | null;
}

export interface DashboardCityCard {
  factionId: string;
  slug: string;
  name: string;
  ownerUid: string | null;
  ownerDisplay: string | null;
  /** False for unowned factions and for claimed cities whose sim doc does
   *  not exist yet — both render as lore cards with no sim section. */
  hasSimState: boolean;
  compactStats: DashboardCompactStats | null;
  activity: {
    lastChangedSeq: number | null;
    lastActionSeq: number | null;
  };
  /** The city's most recent PUBLIC Log summary line; null when none. */
  latestHeadline: string | null;
  links: {
    city: string;
    map: string;
  };
}

/** One projection of a PUBLIC Log entry (brief §2.1; cap 10). */
export interface DashboardLatestSummary {
  seq: number;
  actorDisplay: string;
  actorKind: string;
  cityIds: string[];
  summaryText: string;
  major: boolean;
}

/**
 * Contest card (brief §2.1). Phase 3 always receives `[]` — no contest
 * records exist until Phase 7. Standings are never carried here; they
 * compute from sim_log_entries only (Phase 7 contract, brief §4.3).
 */
export interface DashboardContestCard {
  contestId: string;
  title: string;
  statusLabel: string;
  endConditionLabel: string;
  href: string;
}

/**
 * Town Hall card (brief §2.1). Phase 3 always receives `null` — no
 * sim_terms records exist until Phase 7, and no panel may promote the
 * group's lore mayor into a sim office (brief §4.3, P3-D7). The shape is
 * the Phase 7 contract so the panels need no rework when it populates.
 */
export interface DashboardTownHallCard {
  mayorDisplay: string | null;
  viceMayorDisplay: string | null;
  /** Verbatim term state from the term record, e.g. "Term ends 2027-… ·
   *  election due" — a status, never a countdown (brief §4.3). */
  termStateLabel: string | null;
  electionDue: boolean;
  openMotionCount: number;
}

export interface DashboardSnapshot {
  asOfSeq: number;
  /** The resolution whose commit produced the head entry at asOfSeq;
   *  null only pre-genesis. An undo never names itself here (brief §2.1). */
  generatedByResolutionId: string | null;
  cityCards: DashboardCityCard[];
  latestSummaries: DashboardLatestSummary[];
  openContestCards: DashboardContestCard[];
  townHallCard: DashboardTownHallCard | null;
  /** Writer-stamped presentation metadata. Freshness is judged by
   *  asOfSeq vs. the world head, NEVER by this clock (brief §3.3). The
   *  read path normalizes the stored timestamp to a Date before props. */
  updatedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Shared figure contract (why-links, brief §6.2)
// ---------------------------------------------------------------------------

/**
 * A verified figure plus its why-link, precomputed by the read path via
 * lib/dashboard/whyLink.ts (anchor = the state doc's lastChangedSeq,
 * resolved against the standing Log at click time). Panels render the
 * link when present and never invent one: a null (pre-allocation) figure
 * has no why-link — there is nothing to explain, and its caption says so.
 */
export interface DashboardFigure {
  value: number | null;
  whyHref?: string;
  /** Honest caption for a null figure, e.g. "Not yet allocated". */
  nullCaption?: string;
}
