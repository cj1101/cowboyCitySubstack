/**
 * The fetch layer for Phase 3 exports: every read executes CLIENT-SIDE
 * as the requesting user, through the same Firestore-rules-governed
 * queries the UI uses — so export visibility and UI visibility cannot
 * drift apart (Dana addendum §2.1; June §10). No Admin SDK, no fabric
 * identity, no privileged reader is ever involved in assembling a user
 * export: a query for data the requester may not read is denied by
 * Firestore, and the export fails closed (no file) rather than
 * producing a partial workbook that looks complete (TC-X03).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { ExportError } from "./sheetSpec";
import type {
  BusinessExportData,
  CityExportBundle,
  GeographyExportData,
  PublicationClaimData,
  PublicationExportData,
  StructureExportData,
} from "./datasets/cityData";

export interface ExportRequester {
  uid: string;
  /** Display label for the Cover — never an email or raw uid. */
  label: string;
  isGuest: boolean;
  isFullMember: boolean;
  blocked: boolean;
}

/**
 * Load the requester's export posture from their own user doc — the
 * same `accessLevel` field the rules' isGuestViewer()/isFullMember()
 * helpers read (default "member" when absent, exactly as in rules).
 */
export async function loadExportRequester(uid: string): Promise<ExportRequester> {
  const snap = await getDoc(doc(getClientDb(), "users", uid));
  if (!snap.exists()) {
    throw new ExportError("Your member record could not be read, so no export was produced.");
  }
  const data = snap.data();
  const accessLevel = (data.accessLevel as string | undefined) ?? "member";
  const status = (data.status as string | undefined) ?? "approved";
  return {
    uid,
    label:
      (typeof data.displayName === "string" && data.displayName.trim()) ||
      "Member",
    isGuest: accessLevel === "guest",
    isFullMember: accessLevel !== "guest",
    blocked: status === "suspended" || status === "removed",
  };
}

/**
 * The guest fence (June §10.6, plan OPEN-1 carried default): guests
 * are view-only and get NO export — enforced here, in the library, so
 * a hand-crafted client affordance cannot widen it. Callers must also
 * hide the affordance for guests; this is the fail-closed backstop.
 */
export function assertExportAllowed(requester: ExportRequester): void {
  if (requester.blocked) {
    throw new ExportError("This account cannot export. No file was produced.");
  }
  if (requester.isGuest || !requester.isFullMember) {
    throw new ExportError(
      "Guests are view-only and cannot download exports. No file was produced."
    );
  }
}

export interface WorldExportContext {
  asOfSeq: number;
  rulesVersion: string | null;
}

/** The single as_of_seq the whole workbook is consistent with: the
 * world head at fetch time (TC-X07). Pre-genesis → seq 0, honestly. */
export async function fetchWorldContext(): Promise<WorldExportContext> {
  const snap = await getDoc(doc(getClientDb(), "sim_world", "current"));
  if (!snap.exists()) return { asOfSeq: 0, rulesVersion: null };
  const data = snap.data();
  return {
    asOfSeq:
      typeof data.lastCommittedSeq === "number" ? data.lastCommittedSeq : 0,
    rulesVersion:
      typeof data.rulesVersion === "string" ? data.rulesVersion : null,
  };
}

function isoOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const maybe = value as { toDate?: unknown };
  if (typeof maybe.toDate === "function") {
    return (maybe.toDate as () => Date)().toISOString();
  }
  return null;
}

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapStructure(id: string, data: DocumentData): StructureExportData {
  const profile = (data.profile as DocumentData | undefined) ?? {};
  return {
    structureId: id,
    name: strOf(data.name),
    functionLabel: strOf(profile.functionLabel) ?? strOf(data.kind),
    status: strOf(data.status),
    condition: numOf(data.condition),
    capacity: numOf(data.capacity),
    ownerId: strOf(data.ownerUid) ?? strOf(data.ownerId),
    linkedPinId: strOf(data.linkedPinId),
    linkedWikiEntryId: strOf(data.linkedWikiEntryId),
    lastChangedSeq: numOf(data.lastChangedSeq),
    lastResolutionId: strOf(data.lastResolutionId),
    stateVersion: numOf(data.stateVersion),
  };
}

function mapBusiness(id: string, data: DocumentData): BusinessExportData {
  return {
    businessId: id,
    name: strOf(data.name),
    // Phase 1 shape carries founderFigureId; the Phase 4 corporation
    // ownership pass (P1 K-6) adds ownerUid — read it when present.
    ownerId: strOf(data.ownerUid) ?? strOf(data.founderFigureId),
    ownerName: strOf(data.ownerName),
    homeCityId: strOf(data.homeCityId),
    operatingCityIds: Array.isArray(data.marketCityIds)
      ? data.marketCityIds.filter((v): v is string => typeof v === "string")
      : [],
    status: strOf(data.status),
    industry: strOf(data.industry),
    valuationRubars: numOf(data.valuationRubars),
    lastChangedSeq: numOf(data.lastChangedSeq),
    stateVersion: numOf(data.stateVersion),
  };
}

function mapPublication(id: string, data: DocumentData): PublicationExportData {
  const claims: PublicationClaimData[] = Array.isArray(data.claims)
    ? data.claims.map((raw) => {
        const claim = (raw ?? {}) as DocumentData;
        return {
          metric: typeof claim.metric === "string" ? claim.metric : "",
          claimedValue:
            typeof claim.claimedValue === "number" ||
            typeof claim.claimedValue === "string"
              ? claim.claimedValue
              : null,
          unit: strOf(claim.unit),
          periodLabel: strOf(claim.periodLabel),
          note: strOf(claim.note),
        };
      })
    : [];
  return {
    publicationId: id,
    version: numOf(data.version) ?? 1,
    supersedesPublicationId: strOf(data.supersedesPublicationId),
    storedStatus: strOf(data.status) ?? "published",
    publisherUid: strOf(data.publisherUid) ?? "",
    publisherLabel: null, // resolved by callers that know member labels
    publishedAtIso: isoOf(data.publishedAt),
    publishedAtSeq: numOf(data.publishedAtSeq),
    visibility: strOf(data.visibility),
    businessId: strOf(data.businessId),
    claims,
  };
}

/**
 * Geography has no landed sim collection: natural features are named
 * records rendered on maps (June §8.3). Until a features source lands,
 * the fetch reads the faction doc's `geographyFeatures` presentation
 * array when present and otherwise exports an honest empty tab.
 */
function mapGeography(factionData: DocumentData): GeographyExportData[] {
  const raw = factionData.geographyFeatures;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is DocumentData => !!item && typeof item === "object")
    .map((item, index) => ({
      featureId: strOf(item.id) ?? `feature-${index + 1}`,
      name: strOf(item.name),
      kind: strOf(item.kind),
      status: strOf(item.status),
      lastChangedSeq: numOf(item.lastChangedSeq),
      ruleCited: strOf(item.ruleCited),
    }));
}

export async function fetchCityExportBundle(
  cityId: string
): Promise<CityExportBundle> {
  const db = getClientDb();
  const factionSnap = await getDoc(doc(db, "factions", cityId));
  if (!factionSnap.exists()) {
    throw new ExportError("That city could not be read as your account, so no export was produced.");
  }
  const faction = factionSnap.data();
  const cityName = strOf(faction.name) ?? cityId;

  const simSnap = await getDoc(doc(db, "sim_cities", cityId));
  const sim = simSnap.exists() ? simSnap.data() : null;

  const [structuresSnap, corporationsSnap, publicationsSnap] = await Promise.all([
    getDocs(collection(db, "sim_cities", cityId, "structures")),
    getDocs(collection(db, "sim_cities", cityId, "corporations")),
    getDocs(
      query(collection(db, "sim_publications"), where("cityId", "==", cityId))
    ),
  ]);

  // Optional, audience-fenced dataset: the allocation record is
  // owner/admin-readable only under the landed rules. A denial here
  // means "not yours to see" — the column renders empty — it does NOT
  // fail an export of data the requester may read (TC-X12 equivalence
  // with what the UI can show this user). Every other read above fails
  // the export closed on denial.
  let allocations: Record<string, number> | null = null;
  try {
    const allocSnap = await getDoc(doc(db, "sim_stat_allocations", cityId));
    if (allocSnap.exists()) {
      const raw = allocSnap.data().allocations;
      if (raw && typeof raw === "object") {
        allocations = {};
        for (const [key, value] of Object.entries(raw as DocumentData)) {
          const num = numOf(value);
          if (num !== null) allocations[key] = num;
        }
      }
    }
  } catch {
    allocations = null;
  }

  const statsRaw = sim?.stats as DocumentData | undefined;
  const stats: Record<string, number | null> | null = statsRaw
    ? Object.fromEntries(
        Object.entries(statsRaw).map(([key, value]) => [key, numOf(value)])
      )
    : null;

  return {
    cityId,
    cityName,
    slug: strOf(faction.slug),
    hasSimState: simSnap.exists(),
    stats,
    baselineHash:
      strOf((sim?.baseline as DocumentData | undefined)?.baselineHash) ?? null,
    stateVersion: numOf(sim?.stateVersion),
    lastChangedSeq: numOf(sim?.lastChangedSeq),
    allocations,
    structures: structuresSnap.docs.map((d) => mapStructure(d.id, d.data())),
    businesses: corporationsSnap.docs.map((d) => mapBusiness(d.id, d.data())),
    geography: mapGeography(faction),
    publications: publicationsSnap.docs.map((d) => mapPublication(d.id, d.data())),
  };
}

/** Every live faction's bundle, as visible to the requester. */
export async function fetchRealmExportBundles(): Promise<CityExportBundle[]> {
  const db = getClientDb();
  const factionsSnap = await getDocs(collection(db, "factions"));
  const bundles: CityExportBundle[] = [];
  for (const factionDoc of factionsSnap.docs) {
    bundles.push(await fetchCityExportBundle(factionDoc.id));
  }
  return bundles;
}

export async function fetchStructureExportData(
  cityId: string,
  structureId: string
): Promise<{ structure: StructureExportData; raw: DocumentData }> {
  const snap = await getDoc(
    doc(getClientDb(), "sim_cities", cityId, "structures", structureId)
  );
  if (!snap.exists()) {
    throw new ExportError("That building could not be read as your account, so no export was produced.");
  }
  return { structure: mapStructure(snap.id, snap.data()), raw: snap.data() };
}

export async function fetchBusinessExportData(
  cityId: string,
  businessId: string
): Promise<{ business: BusinessExportData; raw: DocumentData }> {
  const snap = await getDoc(
    doc(getClientDb(), "sim_cities", cityId, "corporations", businessId)
  );
  if (!snap.exists()) {
    throw new ExportError("That business could not be read as your account, so no export was produced.");
  }
  return { business: mapBusiness(snap.id, snap.data()), raw: snap.data() };
}

export { isoOf, mapPublication };
