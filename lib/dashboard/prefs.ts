/**
 * Dashboard prefs: read / validate / normalize (Phase 3 brief §2.2/§5).
 *
 * `sim_dashboard_prefs/{uid}` is presentation state — Dana A.5's one
 * deliberate browser-writable sim-prefixed doc. It carries no world
 * state, is never read by the resolver/committer/snapshot writer, and
 * never appears in the Log. The normalization here is pure and total:
 * ANY stored doc — including docs written by future layout versions —
 * yields a renderable layout (§2.2 client obligations):
 *
 * - unknown panelIds are ignored (registry forward-compatibility),
 * - unknown variants fall back to the panel default,
 * - duplicate panel entries: the first wins,
 * - order is normalized deterministically (stable sort by stored order,
 *   ties broken by registry default order) and re-sequenced 0..n-1,
 * - panels missing from the doc render at their registry defaults,
 * - a non-string defaultCityId is treated as absent (the §5.3 fallback
 *   chain validates the faction reference at resolve time, not here).
 *
 * No prefs doc ⇒ the shipped default layout — byte-identical to a
 * reset-to-defaults render (brief §5.1; P3-G5).
 */

import { doc, serverTimestamp, setDoc, type Firestore } from "firebase/firestore";
import { PANEL_REGISTRY, getPanel } from "./registry";

export const PREFS_LAYOUT_VERSION = 1;

export interface ResolvedPanel {
  panelId: string;
  visible: boolean;
  /** Normalized sequential order (0..n-1) after resolution. */
  order: number;
  variant: string | null;
}

export interface DashboardLayout {
  layoutVersion: number;
  panels: ResolvedPanel[];
  defaultCityId: string | null;
}

/** The shipped default layout, from the registry alone. */
export function defaultLayout(): DashboardLayout {
  return {
    layoutVersion: PREFS_LAYOUT_VERSION,
    panels: PANEL_REGISTRY.map((p) => ({
      panelId: p.panelId,
      visible: p.defaultVisible,
      order: p.defaultOrder,
      variant: p.defaultVariant,
    })).sort((a, b) => a.order - b.order),
    defaultCityId: null,
  };
}

interface StoredPanel {
  panelId: string;
  visible: boolean;
  order: number;
  variant: string | null;
  registryOrder: number;
}

/** Pure normalization of a raw stored prefs doc (or null/garbage). */
export function normalizePrefs(raw: unknown): DashboardLayout {
  const defaults = defaultLayout();
  if (!raw || typeof raw !== "object") return defaults;
  const data = raw as Record<string, unknown>;

  const stored = new Map<string, StoredPanel>();
  if (Array.isArray(data.panels)) {
    for (const entry of data.panels) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.panelId !== "string") continue;
      const def = getPanel(e.panelId);
      if (!def) continue; // unknown panelId: ignored, never an error
      if (stored.has(def.panelId)) continue; // first occurrence wins
      const variant =
        typeof e.variant === "string" &&
        def.variants.some((variant) => variant.id === e.variant)
          ? e.variant
          : def.defaultVariant;
      stored.set(def.panelId, {
        panelId: def.panelId,
        visible: typeof e.visible === "boolean" ? e.visible : def.defaultVisible,
        order: typeof e.order === "number" && Number.isFinite(e.order) ? e.order : def.defaultOrder,
        variant,
        registryOrder: def.defaultOrder,
      });
    }
  }

  const merged: StoredPanel[] = PANEL_REGISTRY.map((def) => {
    const s = stored.get(def.panelId);
    if (s) return s;
    return {
      panelId: def.panelId,
      visible: def.defaultVisible,
      order: def.defaultOrder,
      variant: def.defaultVariant,
      registryOrder: def.defaultOrder,
    };
  });

  // Deterministic order normalization: stable sort by (stored order,
  // registry order), then re-sequence. Duplicate stored orders therefore
  // resolve identically on every client (brief §2.2).
  merged.sort((a, b) => a.order - b.order || a.registryOrder - b.registryOrder);
  const panels: ResolvedPanel[] = merged.map((p, index) => ({
    panelId: p.panelId,
    visible: p.visible,
    order: index,
    variant: p.variant,
  }));

  return {
    layoutVersion:
      typeof data.layoutVersion === "number" && data.layoutVersion >= 1
        ? Math.floor(data.layoutVersion)
        : PREFS_LAYOUT_VERSION,
    panels,
    defaultCityId: typeof data.defaultCityId === "string" ? data.defaultCityId : null,
  };
}

/** The stored-doc shape for a resolved layout (what the writer saves). */
export function buildPrefsDoc(layout: DashboardLayout): Record<string, unknown> {
  return {
    layoutVersion: layout.layoutVersion,
    panels: layout.panels.map((p) => {
      const entry: Record<string, unknown> = {
        panelId: p.panelId,
        visible: p.visible,
        order: p.order,
      };
      if (p.variant !== null) entry.variant = p.variant;
      return entry;
    }),
    defaultCityId: layout.defaultCityId,
  };
}

/**
 * The owning member's write helper — the ONLY write in this module, and
 * it writes presentation state only, as the member's own session, under
 * the §11.2 rules fence (full member, own uid, shape-validated).
 */
export async function saveDashboardPrefs(
  db: Firestore,
  uid: string,
  layout: DashboardLayout
): Promise<void> {
  await setDoc(doc(db, "sim_dashboard_prefs", uid), {
    ...buildPrefsDoc(layout),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Default-city fallback chain (brief §5.3): prefs defaultCityId if it
 * references a viewable faction → the member's own first claimed city →
 * the shared city → the alphabetically first live faction. Guests enter
 * at step (3) (the Featured-city form). No step ever defaults to any
 * particular city by name — the shared city comes from sim_world, and
 * TC-D05 parity holds by construction.
 */
export function resolveDefaultCity(args: {
  layout: DashboardLayout | null;
  /** Faction ids the viewer may view, with ownership + slug facts. */
  factions: { id: string; slug: string; ownerUids: string[] }[];
  viewerUid: string | null;
  sharedCityId: string | null;
}): { cityId: string; source: "prefs" | "own" | "shared" | "first" } | null {
  const { layout, factions, viewerUid, sharedCityId } = args;
  const byId = new Map(factions.map((f) => [f.id, f]));
  if (layout?.defaultCityId && byId.has(layout.defaultCityId)) {
    return { cityId: layout.defaultCityId, source: "prefs" };
  }
  if (viewerUid) {
    const own = factions
      .filter((f) => f.ownerUids.includes(viewerUid))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    if (own.length > 0) return { cityId: own[0].id, source: "own" };
  }
  if (sharedCityId && byId.has(sharedCityId)) {
    return { cityId: sharedCityId, source: "shared" };
  }
  const first = [...factions].sort((a, b) =>
    a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
  );
  return first.length > 0 ? { cityId: first[0].id, source: "first" } : null;
}
