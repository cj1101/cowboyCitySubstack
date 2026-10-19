/**
 * Input shapes for the Phase 3 city datasets (Rafe §§3.3/3.6, June
 * phase3 brief §10.3). These are PURE inputs: the fetch layer
 * (../fetchCityExport.ts) fills them from rules-governed reads executed
 * as the requester, and the builders in ./cityWorkbook.ts turn them
 * into SheetSpecs. A builder can therefore only ever contain what the
 * requester was allowed to read — visibility is inherited, never
 * re-implemented (Dana addendum §2.1).
 */

export interface StatDefinition {
  key: string;
  label: string;
  unit: string;
  /** True for the eight Season-0 allocatable indices (Vera's lock). */
  allocatable: boolean;
}

export const STAT_DEFINITIONS: StatDefinition[] = [
  { key: "spirit", label: "Spirit", unit: "index (0-100)", allocatable: true },
  { key: "culture", label: "Culture", unit: "index (0-100)", allocatable: true },
  { key: "infrastructure", label: "Infrastructure", unit: "index (0-100)", allocatable: true },
  { key: "stability", label: "Stability", unit: "index (0-100)", allocatable: true },
  { key: "law", label: "Law", unit: "index (0-100)", allocatable: true },
  { key: "influence", label: "Influence", unit: "index (0-100)", allocatable: true },
  { key: "military", label: "Military", unit: "index (0-100)", allocatable: true },
  { key: "defense", label: "Defense", unit: "index (0-100)", allocatable: true },
  { key: "households", label: "Households", unit: "count", allocatable: false },
  { key: "housingUnits", label: "Housing units", unit: "count", allocatable: false },
  { key: "treasuryRubars", label: "Treasury", unit: "Rubar", allocatable: false },
  { key: "population", label: "Population", unit: "people", allocatable: false },
  { key: "gdpRubars", label: "GDP", unit: "Rubar", allocatable: false },
];

export interface StructureExportData {
  structureId: string;
  name: string | null;
  /** Structured function data, not flavor (Rafe §3.6): the kind enum,
   * or a rule-readable function label where the record carries one. */
  functionLabel: string | null;
  status: string | null;
  condition: number | null;
  capacity: number | null;
  ownerId: string | null;
  linkedPinId: string | null;
  linkedWikiEntryId: string | null;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
  stateVersion: number | null;
}

export interface BusinessExportData {
  businessId: string;
  name: string | null;
  ownerId: string | null;
  ownerName: string | null;
  homeCityId: string | null;
  operatingCityIds: string[];
  status: string | null;
  industry: string | null;
  valuationRubars: number | null;
  lastChangedSeq: number | null;
  stateVersion: number | null;
}

export interface GeographyExportData {
  featureId: string;
  name: string | null;
  kind: string | null;
  status: string | null;
  /** Seq of the deliberate man-made project that last changed this
   * record; null for fixed natural ground truth (CJ's corrected
   * §6.7.4 — natural geography does NOT change by owner action). */
  lastChangedSeq: number | null;
  ruleCited: string | null;
}

export interface PublicationClaimData {
  metric: string;
  claimedValue: string | number | null;
  unit: string | null;
  periodLabel: string | null;
  note: string | null;
}

export interface PublicationExportData {
  publicationId: string;
  version: number;
  supersedesPublicationId: string | null;
  /** Status ON this version doc: "published" | "retracted" (Phase 1
   * shape — supersession is derived from the chain, never stored). */
  storedStatus: string;
  publisherUid: string;
  publisherLabel: string | null;
  publishedAtIso: string | null;
  publishedAtSeq: number | null;
  visibility: string | null;
  businessId: string | null;
  claims: PublicationClaimData[];
}

export type PublicationChainStatus = "published" | "superseded" | "retracted";

export interface ResolvedPublication extends PublicationExportData {
  chainStatus: PublicationChainStatus;
}

/**
 * Resolve version chains (June §7.2 / TC-X06): the chain head is the
 * version no other version supersedes; non-head versions are
 * "superseded"; the head carries its stored status. A retracted claim
 * therefore never exports as a current claim, and the chain stays
 * visible in the export exactly as it does in-app.
 */
export function resolvePublicationChains(
  publications: PublicationExportData[]
): ResolvedPublication[] {
  const supersededIds = new Set(
    publications
      .map((pub) => pub.supersedesPublicationId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  return publications.map((pub) => {
    const isHead = !supersededIds.has(pub.publicationId);
    const chainStatus: PublicationChainStatus = !isHead
      ? "superseded"
      : pub.storedStatus === "retracted"
        ? "retracted"
        : "published";
    return { ...pub, chainStatus };
  });
}

/** One city's full exportable bundle, as read by one requester. */
export interface CityExportBundle {
  cityId: string;
  cityName: string;
  slug: string | null;
  /** False when the faction has no sim_cities doc (unclaimed / sim not
   * switched on): stats render as honest nulls, never invented zeros. */
  hasSimState: boolean;
  stats: Record<string, number | null> | null;
  baselineHash: string | null;
  stateVersion: number | null;
  lastChangedSeq: number | null;
  /** The city's Season-0 allocation, ONLY when the requester may read
   * it (owner/admin per the landed rules); null otherwise — the column
   * renders empty rather than failing a realm export over a dataset
   * the requester was never entitled to. */
  allocations: Record<string, number> | null;
  structures: StructureExportData[];
  businesses: BusinessExportData[];
  geography: GeographyExportData[];
  publications: PublicationExportData[];
}

export interface ExportContext {
  asOfSeq: number;
  rulesVersion: string | null;
  exportedAtIso: string;
  exportedByLabel: string;
}

/**
 * Derived function availability (June §8.3): derived, never a stored
 * flag. Damage = out of function (CJ). Vera's condition threshold is a
 * Phase 4 lock, so Phase 3 derives from status/condition as recorded
 * and invents no threshold: a structure is in function only when it is
 * complete and not recorded at condition 0 (destroyed-in-place).
 */
export function deriveFunctionAvailable(structure: StructureExportData): boolean {
  if (structure.status !== "complete") return false;
  if (structure.condition !== null && structure.condition <= 0) return false;
  return true;
}

export function deriveDowntimeSinceSeq(
  structure: StructureExportData
): number | null {
  if (deriveFunctionAvailable(structure)) return null;
  if (structure.status === "planned" || structure.status === "under-construction") {
    return null; // not yet in function is not downtime
  }
  return structure.lastChangedSeq;
}
