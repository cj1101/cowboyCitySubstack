/**
 * lib/dashboard/panelData.ts — the dashboard host's data assembly
 * (Phase 3 Build Lead wiring).
 *
 * The panel components (June's module) consume props only and never
 * read collections themselves (registry contract). This module is the
 * host side of that contract: it adapts the snapshot core data
 * (lib/dashboard/snapshotRead) into the registry's snapshot prop
 * shapes and performs the small per-panel reads the snapshot does not
 * carry:
 *
 *   - world-strip: `sim_fabric_status/current` (brief §2.4 read
 *     posture — no writer ships in Phase 3; absence renders as the
 *     truth, the panel owns that copy).
 *   - digest: the viewing member's OWN actor-private Log entries,
 *     merged client-side under Phase 2 §11.1 discipline (the snapshot
 *     projection is public-tier only; private entries arrive flagged
 *     `isOwnPrivate` and are badged by the panel).
 *   - situations-peek: the viewer's notifications substrate (brief
 *     §4.2 — the dedicated Situations queue is Phase 5).
 *   - town-hall: the realm's treaty state (pending → open motions;
 *     active/broken → recent resolutions). The term card itself comes
 *     from the snapshot and stays null until Phase 7 term records
 *     exist — lore officeholders are never promoted into sim office.
 *   - npc-team: the brief §4.3 single selector over `characters`. In
 *     Phase 3 no record can carry NPC management semantics (no writer
 *     exists; NPC creation is Phase 5), so the selector honestly
 *     reports unstaffed teams — a city responds only when its owner
 *     acts. Vera's Phase 5 discriminator-vs-collection decision
 *     changes this one function, not the panel.
 *   - lore-highlights: recent wiki entries in chronological order.
 *     The wiki substrate records no canon-layer field, so entries are
 *     labeled exactly what they are — city wiki records; the layer
 *     badges (Realm canon / deep lore / …) land with lore ingestion
 *     in Phase 6 rather than being fabricated here.
 *   - my-city detail: the verified figures for one city, derived from
 *     Ines' stat-sheet model so the card variant and the SimSheet
 *     never disagree (TC-D01).
 *
 * Discipline: one-time reads only — no listeners, no polling.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  type Firestore,
} from "firebase/firestore";
import {
  type DashboardCityCard,
  type DashboardFigure,
  type DashboardSnapshot,
  type DashboardTownHallCard,
  SIM_INDEX_LABELS,
  type SimIndexKey,
} from "./registry";
import type { DashboardCoreData } from "./snapshotRead";
import type { CityCard } from "@/lib/sim/snapshot";
import { isActorPrivate } from "@/lib/sim/log";
import {
  notificationHref,
  notificationLabel,
  notificationsQuery,
  toNotification,
} from "@/lib/firestore/notifications";
import { toStoredTreaty } from "@/lib/firestore/treaties";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import { wikiEntryPath } from "@/lib/entity/paths";
import {
  buildStatSheetModel,
  NULL_CAPTIONS,
  type StatFigure,
} from "@/lib/stats/statSheet";
import { buildWhyLinkHref } from "@/lib/stats/whyLink";
import type { WorldStripData } from "@/components/dashboard/panels/WorldStripPanel";
import type { DigestEntry } from "@/components/dashboard/panels/DigestPanel";
import type { SituationsPeekData } from "@/components/dashboard/panels/SituationsPeekPanel";
import type {
  TownHallMotion,
  TownHallResolution,
} from "@/components/dashboard/panels/TownHallPanel";
import type { NpcTeamData } from "@/components/dashboard/panels/NpcTeamPanel";
import type { LoreHighlightsData } from "@/components/dashboard/panels/LoreHighlightsPanel";
import type { MyCityDetail } from "@/components/dashboard/panels/MyCityPanel";

// ---------------------------------------------------------------------------
// Snapshot adaptation (writer shape → registry contract)
// ---------------------------------------------------------------------------

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The snapshot writer emits `links.cityPage`; the panel contract
 *  names it `links.city`. The adapter is the one place that knows. */
export function adaptCityCard(card: CityCard): DashboardCityCard {
  const stats = card.compactStats;
  return {
    factionId: card.factionId,
    slug: card.slug,
    name: card.name,
    ownerUid: card.ownerUid,
    ownerDisplay: card.ownerDisplay,
    hasSimState: card.hasSimState,
    compactStats: stats
      ? {
          spirit: asNumber(stats.spirit),
          culture: asNumber(stats.culture),
          infrastructure: asNumber(stats.infrastructure),
          stability: asNumber(stats.stability),
          law: asNumber(stats.law),
          influence: asNumber(stats.influence),
          ...(asNumber(stats.military) !== null
            ? { military: asNumber(stats.military) }
            : {}),
          ...(asNumber(stats.defense) !== null
            ? { defense: asNumber(stats.defense) }
            : {}),
          treasuryRubars: asNumber(stats.treasuryRubars),
          gdpRubars: asNumber(stats.gdpRubars),
          population: asNumber(stats.population),
        }
      : null,
    activity: card.activity,
    latestHeadline: card.latestHeadline,
    links: { city: card.links.cityPage, map: card.links.map },
  };
}

function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

export function adaptSnapshot(core: DashboardCoreData): DashboardSnapshot {
  const raw = core.snapshot ?? {};
  return {
    asOfSeq: core.asOfSeq ?? 0,
    generatedByResolutionId: core.generatedByResolutionId,
    cityCards: core.cityCards.map(adaptCityCard),
    latestSummaries: core.latestSummaries.map((s) => ({
      seq: s.seq,
      actorDisplay: s.actorDisplay,
      actorKind: s.actorKind,
      cityIds: s.cityIds,
      summaryText: s.summaryText,
      major: s.major,
    })),
    openContestCards: Array.isArray(raw.openContestCards)
      ? (raw.openContestCards as DashboardSnapshot["openContestCards"])
      : [],
    townHallCard:
      (raw.townHallCard as DashboardTownHallCard | null | undefined) ?? null,
    updatedAt: toDateOrNull(raw.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// World strip: fabric status (brief §2.4 read posture)
// ---------------------------------------------------------------------------

export async function loadFabricStatus(
  db: Firestore
): Promise<WorldStripData["fabricStatus"]> {
  const snap = await getDoc(doc(db, "sim_fabric_status", "current"));
  if (!snap.exists()) return null;
  const data = snap.data();
  const completed = toDateOrNull(data.lastCycleCompletedAt);
  return {
    statusLabel:
      typeof data.status === "string" ? data.status : "status unrecorded",
    lastCycleCompletedLabel: completed
      ? completed.toLocaleString()
      : null,
  };
}

// ---------------------------------------------------------------------------
// Digest: the member's own actor-private entries (Phase 2 §11.1 merge)
// ---------------------------------------------------------------------------

export function digestHref(seq: number, cityIds: readonly string[]): string {
  return cityIds.length > 0
    ? `/log?city=${encodeURIComponent(cityIds[0])}&anchor=${seq}`
    : `/log?anchor=${seq}`;
}

interface LogActor {
  type?: string;
  memberId?: string;
  npcId?: string;
  onBehalfOfMemberId?: string;
}

/**
 * The viewer's own actor-private entries from the newest Log page,
 * flagged for the panel's "Only you can see this" badge. Public
 * entries come from the snapshot; this merge is the only place a
 * private entry ever reaches the digest, and only its own actor's.
 */
export async function loadOwnPrivateDigest(
  db: Firestore,
  uid: string
): Promise<DigestEntry[]> {
  const snap = await getDocs(
    query(collection(db, "sim_log_entries"), orderBy("seq", "desc"), limit(50))
  );
  const entries: DigestEntry[] = [];
  for (const entryDoc of snap.docs) {
    const data = entryDoc.data();
    if (!isActorPrivate(data as { seq: number })) continue;
    const actor = (data.actor ?? {}) as LogActor;
    if (actor.memberId !== uid && actor.onBehalfOfMemberId !== uid) continue;
    const seq = typeof data.seq === "number" ? data.seq : 0;
    const cityIds = Array.isArray(data.cityIds)
      ? (data.cityIds as string[])
      : [];
    entries.push({
      seq,
      actorDisplay: actor.type === "npc" ? "Your NPC" : "You",
      actorKind: actor.type ?? "member",
      cityIds,
      summaryText: typeof data.summaryText === "string" ? data.summaryText : "",
      major: data.major === true,
      isOwnPrivate: true,
      npcOnBehalf:
        actor.type === "npc"
          ? { npcName: actor.npcId ?? "NPC", ownerDisplay: "you" }
          : null,
      ruleIds: Array.isArray(data.ruleIds) ? (data.ruleIds as string[]) : [],
      href: digestHref(seq, cityIds),
    });
  }
  return entries.sort((a, b) => b.seq - a.seq);
}

// ---------------------------------------------------------------------------
// Situations peek: the viewer's notifications (Phase 3 substrate)
// ---------------------------------------------------------------------------

export async function loadSituationsPeek(
  uid: string
): Promise<SituationsPeekData> {
  const snap = await getDocs(notificationsQuery(uid));
  const unread = snap.docs
    .map((d) => toNotification(d.id, d.data() as Record<string, unknown>))
    .filter((n) => !n.read);
  return {
    openCount: unread.length,
    topItems: unread.slice(0, 3).map((n) => ({
      id: n.id,
      title: n.summary,
      cityName: null,
      kindLabel: notificationLabel(n),
      href: notificationHref(n.href),
    })),
    queueHref: "/notifications",
  };
}

// ---------------------------------------------------------------------------
// Town Hall: treaty state as motions / resolutions (term card: Phase 7)
// ---------------------------------------------------------------------------

export async function loadTownHall(
  db: Firestore
): Promise<{
  openMotions: TownHallMotion[];
  recentResolutions: TownHallResolution[];
}> {
  const snap = await getDocs(
    query(collection(db, "treaties"), orderBy("updatedAt", "desc"), limit(20))
  );
  const openMotions: TownHallMotion[] = [];
  const recentResolutions: TownHallResolution[] = [];
  for (const treatyDoc of snap.docs) {
    const treaty = toStoredTreaty(
      treatyDoc.id,
      treatyDoc.data() as Record<string, unknown>
    );
    if (treaty.status === "pending") {
      openMotions.push({
        id: treaty.id,
        title: treaty.name,
        href: `/treaties/${treaty.id}`,
        kindLabel: "Treaty",
        statusLabel: "Awaiting response",
      });
    } else {
      recentResolutions.push({
        id: treaty.id,
        title: treaty.name,
        href: `/treaties/${treaty.id}`,
        outcomeLabel: treaty.status === "active" ? "Ratified" : "Broken",
      });
    }
  }
  return {
    openMotions: openMotions.slice(0, 5),
    recentResolutions: recentResolutions.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// NPC teams: the §4.3 selector (Phase 5 changes this one function)
// ---------------------------------------------------------------------------

export function selectNpcTeams(args: {
  cards: DashboardCityCard[];
  viewerUid: string | null;
  defaultCity: DashboardCityCard | null;
}): NpcTeamData {
  const { cards, viewerUid, defaultCity } = args;
  return {
    myTeam: viewerUid
      ? { cityName: defaultCity?.name ?? null, npcs: [] }
      : null,
    realmTeams: cards.map((card) => ({
      factionId: card.factionId,
      cityName: card.name,
      cityHref: card.links.city,
      // No NPC management records exist yet (Phase 5 creates them):
      // every city is honestly unstaffed — it responds when its
      // owner acts. TC-N07's two statuses are the whole vocabulary.
      teamSize: 0,
      staffed: false,
    })),
  };
}

// ---------------------------------------------------------------------------
// Lore highlights: recent wiki entries, chronological, honestly labeled
// ---------------------------------------------------------------------------

export async function loadLoreHighlights(
  cards: DashboardCityCard[]
): Promise<LoreHighlightsData> {
  const nameByCityId = new Map(cards.map((c) => [c.factionId, c.name]));
  const entries = await getAllWikiEntries();
  const sorted = [...entries].sort((a, b) => {
    const at = a.updatedAt?.toMillis?.() ?? 0;
    const bt = b.updatedAt?.toMillis?.() ?? 0;
    return bt - at;
  });
  return {
    entries: sorted.slice(0, 8).map((entry) => {
      const excerptSource = entry.summary ?? entry.body ?? "";
      return {
        id: entry.id,
        title: entry.title,
        href: wikiEntryPath(entry.citySlug, entry.slug),
        layerLabel: "City wiki record",
        cityName: nameByCityId.get(entry.cityId) ?? null,
        linkedCityNames: [],
        citationLabel: null,
        excerpt: excerptSource ? excerptSource.slice(0, 180) : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// My city: verified detail figures from the stat-sheet model (§6.1)
// ---------------------------------------------------------------------------

function toDashboardFigure(figure: StatFigure | undefined): DashboardFigure {
  if (!figure) {
    return { value: null, nullCaption: NULL_CAPTIONS["no-figure"] };
  }
  return {
    value: figure.value,
    ...(figure.whyLink
      ? { whyHref: buildWhyLinkHref(figure.whyLink) }
      : {}),
    ...(figure.nullCaption
      ? { nullCaption: NULL_CAPTIONS[figure.nullCaption] }
      : {}),
  };
}

export async function buildMyCityDetail(
  db: Firestore,
  factionId: string,
  viewerIsOwner: boolean
): Promise<MyCityDetail | null> {
  const [citySnap, allocationSnap] = await Promise.all([
    getDoc(doc(db, "sim_cities", factionId)),
    getDoc(doc(db, "sim_stat_allocations", factionId)),
  ]);
  if (!citySnap.exists()) return null;
  const model = buildStatSheetModel({
    factionId,
    simCity: citySnap.data() as Record<string, unknown>,
    allocation: allocationSnap.exists()
      ? (allocationSnap.data() as Record<string, unknown>)
      : null,
  });
  const byKey = new Map(model.figures.map((f) => [f.key, f]));
  const indices = {} as Record<SimIndexKey, DashboardFigure>;
  for (const key of Object.keys(SIM_INDEX_LABELS) as SimIndexKey[]) {
    indices[key] = toDashboardFigure(byKey.get(key));
  }
  return {
    indices,
    treasury: toDashboardFigure(byKey.get("treasuryRubars")),
    gdp: toDashboardFigure(byKey.get("gdpRubars")),
    population: toDashboardFigure(byKey.get("population")),
    households: toDashboardFigure(byKey.get("households")),
    housingUnits: toDashboardFigure(byKey.get("housingUnits")),
    allocation:
      model.allocationState === "allocated"
        ? {
            state: "allocated",
            ...(model.allocationCommittedSeq !== null
              ? {
                  entryHref: `/log?city=${encodeURIComponent(factionId)}&anchor=${model.allocationCommittedSeq}`,
                }
              : {}),
          }
        : model.allocationState === "unallocated"
          ? { state: "unallocated" }
          : null,
    viewerIsOwner,
  };
}
