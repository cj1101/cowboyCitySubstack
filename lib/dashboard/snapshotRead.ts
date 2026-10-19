/**
 * The dashboard's read path (Phase 3 brief §3.5/§5.1): snapshot + world
 * head + per-panel fallback reads, returning the per-panel states the
 * spec defines (loading / data / empty / stale / error).
 *
 * Read budget (§13): 1 snapshot + 1 world (+ 1 prefs for members, in
 * prefs.ts's caller). Fallback reads happen ONLY when the snapshot is
 * missing — never as a supplement to a present snapshot. No listeners,
 * no polling, no auto-refetch anywhere in this module: one-time reads
 * plus explicit reload, and a stale world is displayed as stale.
 *
 * The snapshot is a disposable cache (Dana §3.1): this module never
 * treats it as truth, it only reports its freshness honestly — a seq
 * comparison against sim_world/current (§3.3), never a clock.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type Firestore,
} from "firebase/firestore";
import {
  buildCityCard,
  projectLatestSummaries,
  snapshotIsCurrent,
  type CityCard,
  type LatestSummary,
} from "../sim/snapshot";

export type PanelStatus = "loading" | "data" | "empty" | "stale" | "error";

export interface PanelState<T> {
  status: PanelStatus;
  data?: T;
  error?: string;
}

export type Freshness = "current" | "stale" | "missing";

export interface DashboardCoreData {
  freshness: Freshness;
  /** The snapshot's seq; null when the snapshot doc is missing. */
  asOfSeq: number | null;
  /** sim_world/current's lastCommittedSeq; null pre-genesis. */
  worldSeq: number | null;
  snapshot: Record<string, unknown> | null;
  generatedByResolutionId: string | null;
  cityCards: CityCard[];
  latestSummaries: LatestSummary[];
}

/** Wrap core data in a panel state: empty beats stale beats data. */
export function stateFor<T>(
  core: DashboardCoreData,
  data: T | null | undefined,
  isEmpty: (data: T) => boolean
): PanelState<T> {
  if (data === null || data === undefined || isEmpty(data)) return { status: "empty" };
  if (core.freshness === "stale") return { status: "stale", data };
  return { status: "data", data };
}

/** The freshness line copy (brief §3.5) — honest, seq-based, no clocks. */
export function freshnessLine(core: DashboardCoreData): string {
  if (core.freshness === "current") {
    return `World as of Log #${core.asOfSeq}`;
  }
  if (core.freshness === "stale") {
    return (
      `World as of Log #${core.asOfSeq} — the world has moved to #${core.worldSeq}; ` +
      "showing last projected state. It rebuilds when the fabric next runs."
    );
  }
  return `World as of Log #${core.worldSeq ?? 0} (live read — snapshot not built yet)`;
}

async function readDoc(
  db: Firestore,
  path: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const snap = await getDoc(doc(db, path, id));
  return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
}

/**
 * Fallback card assembly (§3.5): authoritative reads shaped by the same
 * buildCityCard the projection uses, so fallback and projected cards
 * cannot drift. Headlines derive from the recent public window only.
 */
async function fallbackCards(
  db: Firestore,
  recentPublic: Record<string, unknown>[]
): Promise<CityCard[]> {
  const [factionsSnap, citiesSnap] = await Promise.all([
    getDocs(collection(db, "factions")),
    getDocs(collection(db, "sim_cities")),
  ]);
  const simById = new Map(
    citiesSnap.docs.map((d) => [d.id, d.data() as Record<string, unknown>])
  );
  const headlineByCity = new Map<string, Record<string, unknown>>();
  for (const entry of recentPublic) {
    const cityIds = Array.isArray(entry.cityIds) ? (entry.cityIds as string[]) : [];
    for (const cityId of cityIds) {
      if (!headlineByCity.has(cityId)) headlineByCity.set(cityId, entry);
    }
  }
  return factionsSnap.docs
    .map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((faction) =>
      buildCityCard({
        faction,
        simCity: simById.get(faction.id) ?? null,
        headlineEntry: headlineByCity.get(faction.id) ?? null,
      })
    );
}

export async function loadDashboardCore(db: Firestore): Promise<DashboardCoreData> {
  const [snapshot, world] = await Promise.all([
    readDoc(db, "sim_dashboard_snapshots", "current"),
    readDoc(db, "sim_world", "current"),
  ]);
  const worldSeq =
    typeof world?.lastCommittedSeq === "number" ? world.lastCommittedSeq : null;

  if (snapshot) {
    return {
      freshness: snapshotIsCurrent(snapshot, world) ? "current" : "stale",
      asOfSeq: typeof snapshot.asOfSeq === "number" ? snapshot.asOfSeq : null,
      worldSeq,
      snapshot,
      generatedByResolutionId:
        typeof snapshot.generatedByResolutionId === "string"
          ? snapshot.generatedByResolutionId
          : null,
      cityCards: Array.isArray(snapshot.cityCards)
        ? (snapshot.cityCards as CityCard[])
        : [],
      latestSummaries: Array.isArray(snapshot.latestSummaries)
        ? (snapshot.latestSummaries as LatestSummary[])
        : [],
    };
  }

  // Missing snapshot (pre-first-wake, deleted, rebuild pending): the
  // dashboard is fully readable from authoritative docs (TC-H06). The
  // digest fallback queries public entries only — rules are not filters,
  // so the visibility equality is part of the query, never a post-filter.
  let recentPublic: Record<string, unknown>[] = [];
  try {
    const snap = await getDocs(
      query(
        collection(db, "sim_log_entries"),
        where("visibility", "==", "public"),
        orderBy("seq", "desc"),
        limit(30)
      )
    );
    recentPublic = snap.docs.map((d) => d.data() as Record<string, unknown>);
  } catch {
    recentPublic = [];
  }
  return {
    freshness: "missing",
    asOfSeq: null,
    worldSeq,
    snapshot: null,
    generatedByResolutionId: null,
    cityCards: await fallbackCards(db, recentPublic),
    latestSummaries: projectLatestSummaries(recentPublic),
  };
}
