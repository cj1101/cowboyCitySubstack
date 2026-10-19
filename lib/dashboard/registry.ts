/**
 * The dashboard panel registry (Phase 3 brief §4.2). Frontend-owned
 * (Dana A.5): the single source of panel identity, variants, shipped
 * defaults, and phase gating. All 14 entries exist from day one —
 * registry completeness is what makes stored prefs forward-compatible:
 * a prefs doc referencing a reserved panel is inert, never an error.
 *
 * "Ship" = renders with real data or its honest empty state in Phase 3.
 * "Reserve" = registered, default hidden, renders nothing until its
 * phase; flipping one live later is a registry-default change, not a
 * rebuild (P3-D3/D5).
 */

export interface PanelVariant {
  id: string;
  /** Plain-language name for the Customize editor (brief §5.2). */
  label: string;
}

export interface PanelDefinition {
  panelId: string;
  title: string;
  variants: PanelVariant[];
  defaultVariant: string | null;
  defaultVisible: boolean;
  defaultOrder: number;
  /** The phase in which the panel starts rendering. */
  shipsInPhase: 3 | 4 | 5 | 7;
  /** Guests see the shipped default set only (brief §4.2/§5.4). */
  guestVisible: boolean;
  /** Panels with tabular data offer a per-panel Excel export (§10.2). */
  exportable: boolean;
}

function v(id: string, label: string): PanelVariant {
  return { id, label };
}

export const PANEL_REGISTRY: PanelDefinition[] = [
  {
    panelId: "world-strip",
    title: "World strip",
    variants: [v("full", "Full strip"), v("compact", "Compact")],
    defaultVariant: "full",
    defaultVisible: true,
    defaultOrder: 0,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: false,
  },
  {
    panelId: "my-city",
    title: "My city",
    variants: [v("sheet", "Full stat sheet"), v("card", "Compact card")],
    defaultVariant: "sheet",
    defaultVisible: true,
    defaultOrder: 1,
    shipsInPhase: 3,
    // Guests get the Featured-city form of this panel (brief §5.3).
    guestVisible: true,
    exportable: true,
  },
  {
    panelId: "digest",
    title: "Realm digest",
    variants: [v("standard", "Standard (up to 10)"), v("brief", "Brief (up to 5)")],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 2,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: true,
  },
  {
    panelId: "situations-peek",
    title: "Situations",
    variants: [v("standard", "Standard"), v("count-only", "Count only")],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 3,
    shipsInPhase: 3,
    guestVisible: false,
    // No export affordance, ever (brief §4.2/§10.2) — the audience-owner
    // export arrives inside the Phase 5 queue.
    exportable: false,
  },
  {
    panelId: "city-grid",
    title: "Cities",
    variants: [v("cards", "Cards"), v("table", "Table")],
    defaultVariant: "cards",
    defaultVisible: true,
    defaultOrder: 4,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: true,
  },
  {
    panelId: "contests",
    title: "Contests",
    variants: [v("standard", "Standard"), v("compact", "Compact")],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 5,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: false,
  },
  {
    panelId: "town-hall",
    title: "Town Hall",
    variants: [v("standard", "Standard"), v("compact", "Compact")],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 6,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: true,
  },
  {
    panelId: "npc-team",
    title: "NPC team",
    variants: [v("mine", "My team"), v("realm", "Realm teams")],
    defaultVariant: "mine",
    defaultVisible: true,
    defaultOrder: 7,
    shipsInPhase: 3,
    guestVisible: false,
    exportable: false,
  },
  {
    panelId: "sports",
    title: "Sports",
    variants: [v("standard", "Standard"), v("scores-only", "Scores only")],
    defaultVariant: "standard",
    defaultVisible: true,
    defaultOrder: 8,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: true,
  },
  {
    panelId: "lore-highlights",
    title: "Lore highlights",
    variants: [v("recent", "Recent"), v("intertwined", "Intertwined")],
    defaultVariant: "recent",
    defaultVisible: true,
    defaultOrder: 9,
    shipsInPhase: 3,
    guestVisible: true,
    exportable: false,
  },
  {
    panelId: "action-box",
    title: "Act",
    variants: [],
    defaultVariant: null,
    defaultVisible: true,
    defaultOrder: 10,
    shipsInPhase: 3,
    guestVisible: false,
    exportable: false,
  },
  {
    // Reserved (P3-D3): the deal portal and its spawn contract are
    // Phase 5; a visible spawn panel with nothing behind it would be a
    // hollow control.
    panelId: "deal-spawn",
    title: "Deal portal",
    variants: [],
    defaultVariant: null,
    defaultVisible: false,
    defaultOrder: 11,
    shipsInPhase: 5,
    guestVisible: false,
    exportable: false,
  },
  {
    // Reserved (P3-D5): no listings exist until Phase 4's market slice.
    panelId: "market-index",
    title: "Market index",
    variants: [v("standard", "Standard"), v("compact", "Compact")],
    defaultVariant: "standard",
    defaultVisible: false,
    defaultOrder: 12,
    shipsInPhase: 4,
    guestVisible: false,
    exportable: true,
  },
  {
    // Reserved (P3-D5): holdings are requester-only data and arrive
    // with the market slice.
    panelId: "portfolio",
    title: "Portfolio",
    variants: [],
    defaultVariant: null,
    defaultVisible: false,
    defaultOrder: 13,
    shipsInPhase: 4,
    guestVisible: false,
    exportable: true,
  },
];

export const PANELS_BY_ID: ReadonlyMap<string, PanelDefinition> = new Map(
  PANEL_REGISTRY.map((p) => [p.panelId, p])
);

export function getPanel(panelId: string): PanelDefinition | null {
  return PANELS_BY_ID.get(panelId) ?? null;
}

/** Panels that render in Phase 3 (ship or honest-empty), registry order. */
export function shippedPanels(): PanelDefinition[] {
  return PANEL_REGISTRY.filter((p) => p.shipsInPhase <= 3);
}

/** The guest panel set (brief §4.2): shipped defaults, no prefs. */
export function guestPanels(): PanelDefinition[] {
  return shippedPanels().filter((p) => p.guestVisible);
}
