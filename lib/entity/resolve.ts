/**
 * Entity resolution (Phase 3 brief §8.1).
 *
 * Resolution order for an entity page:
 *   1. The sim record — `sim_cities/{factionId}/structures|corporations`
 *      matched by doc id, then by its recorded `slug` (structures), then
 *      by slugified name (corporations carry no slug field in Dana §3.2).
 *   2. The pin/wiki-backed presentation entity — a `place` wiki entry in
 *      the host city with the requested slug, and/or a city pin linked
 *      to that entry (or whose title slugifies to the requested slug).
 *
 * Both postures render on the one template (brief §8.1, TC-D01). Reads
 * run as the signed-in viewer under the landed rules (structures and
 * corporations are viewer-readable; pins/wiki are member substrate) —
 * any read failure degrades to the next posture, never to a fabricated
 * record.
 */

import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { getCityPins } from "@/lib/firestore/maps";
import { getWikiEntriesForCity } from "@/lib/firestore/wikiEntries";
import type { Faction, MapPin, WikiEntry } from "@/lib/types";
import { slugify } from "./paths";
import type {
  CorporationStatus,
  EntityKind,
  EntityPageData,
  PresentationEntity,
  SimCorporation,
  SimStructure,
  StructureKind,
  StructureStatus,
} from "./types";
import { STRUCTURE_KINDS } from "./types";

const STRUCTURE_STATUSES: StructureStatus[] = [
  "planned",
  "under-construction",
  "complete",
  "mothballed",
  "demolished",
  "ruined",
];
const CORPORATION_STATUSES: CorporationStatus[] = ["active", "contracted", "relocated", "dissolved"];

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function docToStructure(id: string, data: Record<string, unknown>): SimStructure {
  const profileRaw = (data.profile as Record<string, unknown> | undefined) ?? {};
  const kindRaw = data.kind as StructureKind;
  const statusRaw = data.status as StructureStatus;
  const sourceRaw = (data.source as Record<string, unknown> | undefined) ?? null;
  return {
    id,
    name: str(data.name) ?? "Unnamed building",
    slug: str(data.slug) ?? id,
    kind: STRUCTURE_KINDS.includes(kindRaw) ? kindRaw : "other",
    status: STRUCTURE_STATUSES.includes(statusRaw) ? statusRaw : "complete",
    profile: {
      description: str(profileRaw.description),
      district: str(profileRaw.district),
      purpose: str(profileRaw.purpose),
      subtype: str(profileRaw.subtype),
      ownerUid: str(profileRaw.ownerUid),
      ownerDisplay: str(profileRaw.ownerDisplay),
      controllerUid: str(profileRaw.controllerUid),
      endpointCityIds: Array.isArray(profileRaw.endpointCityIds)
        ? strList(profileRaw.endpointCityIds)
        : null,
      endpointLabels: Array.isArray(profileRaw.endpointLabels)
        ? strList(profileRaw.endpointLabels)
        : null,
    },
    capacity: num(data.capacity),
    staffSlots: num(data.staffSlots),
    prestige: num(data.prestige),
    condition: num(data.condition),
    units: num(data.units),
    workUnitsRequired: num(data.workUnitsRequired),
    workUnitsDone: num(data.workUnitsDone) ?? 0,
    totalBudgetRubars: num(data.totalBudgetRubars),
    paidRubars: num(data.paidRubars) ?? 0,
    residentHouseholdIds: strList(data.residentHouseholdIds),
    staffFigureIds: strList(data.staffFigureIds),
    staffCorporationIds: strList(data.staffCorporationIds),
    linkedWikiEntryId: str(data.linkedWikiEntryId),
    linkedPinId: str(data.linkedPinId),
    source: sourceRaw
      ? {
          type: str(sourceRaw.type),
          id: str(sourceRaw.id),
          seq: num(sourceRaw.seq),
          actionId: str(sourceRaw.actionId),
        }
      : null,
    stateVersion: num(data.stateVersion),
    lastChangedSeq: num(data.lastChangedSeq),
    lastResolutionId: str(data.lastResolutionId),
  };
}

export function docToCorporation(id: string, data: Record<string, unknown>): SimCorporation {
  const statusRaw = data.status as CorporationStatus;
  const name = str(data.name) ?? "Unnamed business";
  return {
    id,
    name,
    slug: str(data.slug) ?? slugify(name) ?? id,
    industry: str(data.industry),
    status: CORPORATION_STATUSES.includes(statusRaw) ? statusRaw : "active",
    valuationRubars: num(data.valuationRubars),
    founderFigureId: str(data.founderFigureId),
    ownerUid: str(data.ownerUid),
    ownerDisplay: str(data.ownerDisplay),
    homeCityId: str(data.homeCityId),
    marketCityIds: strList(data.marketCityIds),
    linkedStructureIds: strList(data.linkedStructureIds),
    quality: num(data.quality),
    scale: num(data.scale),
    importance: num(data.importance),
    assessmentSeq: num(data.assessmentSeq),
    sourceActionId: str(data.sourceActionId),
    sourceSeq: num(data.sourceSeq),
    stateVersion: num(data.stateVersion),
    lastChangedSeq: num(data.lastChangedSeq),
    lastResolutionId: str(data.lastResolutionId),
  };
}

function structuresCol(factionId: string) {
  return collection(getClientDb(), "sim_cities", factionId, "structures");
}
function corporationsCol(factionId: string) {
  return collection(getClientDb(), "sim_cities", factionId, "corporations");
}

export async function getStructureById(
  factionId: string,
  structureId: string
): Promise<SimStructure | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_cities", factionId, "structures", structureId));
    return snap.exists() ? docToStructure(snap.id, snap.data()) : null;
  } catch {
    return null;
  }
}

export async function getCorporationById(
  factionId: string,
  corporationId: string
): Promise<SimCorporation | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_cities", factionId, "corporations", corporationId));
    return snap.exists() ? docToCorporation(snap.id, snap.data()) : null;
  } catch {
    return null;
  }
}

export async function listCityStructures(factionId: string): Promise<SimStructure[]> {
  try {
    const snap = await getDocs(structuresCol(factionId));
    return snap.docs.map((d) => docToStructure(d.id, d.data()));
  } catch {
    return [];
  }
}

export async function listCityCorporations(factionId: string): Promise<SimCorporation[]> {
  try {
    const snap = await getDocs(corporationsCol(factionId));
    return snap.docs.map((d) => docToCorporation(d.id, d.data()));
  } catch {
    return [];
  }
}

async function findStructureBySlug(factionId: string, slug: string): Promise<SimStructure | null> {
  const byId = await getStructureById(factionId, slug);
  if (byId) return byId;
  try {
    const snap = await getDocs(query(structuresCol(factionId), where("slug", "==", slug)));
    if (!snap.empty) return docToStructure(snap.docs[0].id, snap.docs[0].data());
  } catch {
    /* fall through to the scan */
  }
  const all = await listCityStructures(factionId);
  return all.find((s) => s.slug === slug) ?? null;
}

async function findCorporationBySlug(
  factionId: string,
  slug: string
): Promise<SimCorporation | null> {
  const byId = await getCorporationById(factionId, slug);
  if (byId) return byId;
  const all = await listCityCorporations(factionId);
  return all.find((c) => c.slug === slug || slugify(c.name) === slug) ?? null;
}

async function presentationFallback(
  faction: Faction,
  slug: string
): Promise<PresentationEntity | null> {
  let entry: WikiEntry | null = null;
  try {
    const entries = await getWikiEntriesForCity(faction.id);
    entry = entries.find((e) => e.slug === slug) ?? null;
  } catch {
    entry = null;
  }
  let pin: MapPin | null = null;
  try {
    const pins = await getCityPins(faction.id);
    pin =
      pins.find(
        (p) =>
          (entry !== null && (p.wikiEntryId === entry.id || (p.wikiEntryIds ?? []).includes(entry.id))) ||
          slugify(p.title) === slug
      ) ?? null;
  } catch {
    pin = null;
  }
  if (!entry && !pin) return null;
  return {
    key: entry?.id ?? pin?.id ?? slug,
    name: entry?.title ?? pin?.title ?? slug,
    slug,
    pinId: pin?.id ?? null,
    wikiEntryId: entry?.id ?? pin?.wikiEntryId ?? null,
    note: pin?.note ? pin.note : null,
  };
}

/**
 * Resolve one entity page. `requestedSlug` is the URL segment; the
 * result's `canonicalSlug` is where the page canonically lives (the
 * route redirects when they differ — slug renames, spec §6.1).
 */
export async function resolveEntityPage(
  faction: Faction,
  kind: EntityKind,
  requestedSlug: string
): Promise<EntityPageData | null> {
  let cityHasSimState = false;
  try {
    const worldSnap = await getDoc(doc(getClientDb(), "sim_cities", faction.id));
    cityHasSimState = worldSnap.exists();
  } catch {
    cityHasSimState = false;
  }
  const base = { kind, cityHasSimState, cityClaimed: (faction.ownerUids ?? []).length > 0 };

  if (kind === "building") {
    const structure = await findStructureBySlug(faction.id, requestedSlug);
    if (structure) {
      return {
        ...base,
        posture: "sim",
        canonicalSlug: structure.slug,
        structure,
        corporation: null,
        presentation: null,
      };
    }
  } else {
    const corporation = await findCorporationBySlug(faction.id, requestedSlug);
    if (corporation) {
      return {
        ...base,
        posture: "sim",
        canonicalSlug: corporation.slug,
        structure: null,
        corporation,
        presentation: null,
      };
    }
  }

  const presentation = await presentationFallback(faction, requestedSlug);
  if (!presentation) return null;
  return {
    ...base,
    posture: "presentation",
    canonicalSlug: presentation.slug,
    structure: null,
    corporation: null,
    presentation,
  };
}

/**
 * Who may manage an entity's gallery and pin (brief §8.4): the
 * building's owner/controller, or the host city's owner. Other members
 * may only *propose* gallery images (they land pending).
 */
export function canManageEntity(
  viewerUid: string | null,
  faction: Faction,
  data: EntityPageData
): boolean {
  if (!viewerUid) return false;
  if ((faction.ownerUids ?? []).includes(viewerUid)) return true;
  const profile = data.structure?.profile;
  return profile?.ownerUid === viewerUid || profile?.controllerUid === viewerUid;
}
