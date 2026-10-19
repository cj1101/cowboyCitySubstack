/**
 * Entity page data model (Phase 3 brief §8; dashboard-and-entity-pages
 * spec §6). One template, two data postures:
 *
 *  - "sim"          — the entity has a record in
 *                     `sim_cities/{factionId}/structures|c corporations`
 *                     (Dana backend-architecture §3.2 shapes).
 *  - "presentation" — no sim record exists; the entity is known to the
 *                     site through its map pin and/or wiki entry and
 *                     renders on the same template with its sim sections
 *                     in the not-in-sim state (brief §8.1/§8.5).
 *
 * Nothing in this module invents fields: raw shapes mirror Dana §3.2,
 * and every optional field renders its honest empty state when absent.
 */

export type EntityKind = "building" | "business";

export const STRUCTURE_KINDS = [
  "civic",
  "cultural",
  "commercial",
  "industrial",
  "housing",
  "transport",
  "infrastructure",
  "military",
  "other",
] as const;
export type StructureKind = (typeof STRUCTURE_KINDS)[number];

export const STRUCTURE_KIND_LABELS: Record<StructureKind, string> = {
  civic: "Civic",
  cultural: "Cultural",
  commercial: "Commercial",
  industrial: "Industrial",
  housing: "Housing",
  transport: "Transport",
  infrastructure: "Infrastructure",
  military: "Military",
  other: "Other",
};

export type StructureStatus =
  | "planned"
  | "under-construction"
  | "complete"
  | "mothballed"
  | "demolished"
  | "ruined";

export type CorporationStatus = "active" | "contracted" | "relocated" | "dissolved";

/** Provenance object as recorded by the fabric (Dana §3.2 `source`). */
export interface EntitySource {
  type?: string | null;
  id?: string | null;
  seq?: number | null;
  actionId?: string | null;
}

/** Raw sim structure record — Dana §3.2, field for field. */
export interface SimStructure {
  id: string;
  name: string;
  slug: string;
  kind: StructureKind;
  status: StructureStatus;
  profile: {
    description?: string | null;
    district?: string | null;
    purpose?: string | null;
    subtype?: string | null;
    /** Freeform controller/owner hints where a record carries them. */
    ownerUid?: string | null;
    ownerDisplay?: string | null;
    controllerUid?: string | null;
    endpointCityIds?: string[] | null;
    endpointLabels?: string[] | null;
    [key: string]: unknown;
  };
  capacity: number | null;
  staffSlots: number | null;
  prestige: number | null;
  condition: number | null;
  units: number | null;
  workUnitsRequired: number | null;
  workUnitsDone: number;
  totalBudgetRubars: number | null;
  paidRubars: number;
  residentHouseholdIds: string[];
  staffFigureIds: string[];
  staffCorporationIds: string[];
  linkedWikiEntryId: string | null;
  linkedPinId: string | null;
  source: EntitySource | null;
  stateVersion: number | null;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
}

/** Raw sim corporation record — Dana §3.2, field for field. */
export interface SimCorporation {
  id: string;
  name: string;
  /** Corporations carry no slug field in Dana §3.2; the page slug is the
   * doc id or the slugified name (see resolve.ts). */
  slug: string;
  industry: string | null;
  status: CorporationStatus;
  valuationRubars: number | null;
  founderFigureId: string | null;
  /** Phase 4 owner amendment fields (phase1-decisions K-6) — read when
   * present, never assumed. */
  ownerUid?: string | null;
  ownerDisplay?: string | null;
  homeCityId: string | null;
  marketCityIds: string[];
  linkedStructureIds: string[];
  /** AI-as-market judgment fields (Cato) — rendered as assessments with
   * their Log link when Phase 4 data exists; absent in Phase 3. */
  quality?: number | null;
  scale?: number | null;
  importance?: number | null;
  assessmentSeq?: number | null;
  sourceActionId: string | null;
  sourceSeq: number | null;
  stateVersion: number | null;
  lastChangedSeq: number | null;
  lastResolutionId: string | null;
}

/** A pin/wiki-backed presentation entity (brief §8.1 posture 2). */
export interface PresentationEntity {
  /** Stable key: the wiki entry id when one exists, else the pin id. */
  key: string;
  name: string;
  slug: string;
  pinId: string | null;
  wikiEntryId: string | null;
  note: string | null;
}

export type GalleryImageKind = "screenshot" | "plan" | "map";
export type GalleryAcceptance = "accepted" | "pending";

/**
 * Gallery metadata record. The image binary lives in Firebase Storage at
 * the brief §11.5 path (`factions/{factionId}/structures/{structureId}/…`
 * for buildings; the corporations twin for businesses); this record is
 * the metadata the client writes through the gallery record path
 * (brief §8.4). Acceptance state lives here, never in Storage.
 */
export interface GalleryItem {
  id: string;
  entityKind: EntityKind;
  /** Sim doc id, or the presentation entity key. */
  entityKey: string;
  url: string;
  storagePath: string;
  uploaderUid: string;
  uploaderDisplay: string | null;
  caption: string | null;
  kind: GalleryImageKind;
  acceptance: GalleryAcceptance;
  showcase: boolean;
  createdAtMillis: number | null;
}

/** Everything an entity page renders, resolved in one pass. */
export interface EntityPageData {
  kind: EntityKind;
  posture: "sim" | "presentation";
  /** The canonical slug the page should live at (redirect target when
   * the requested slug was a doc id or a stale slug). */
  canonicalSlug: string;
  structure: SimStructure | null;
  corporation: SimCorporation | null;
  presentation: PresentationEntity | null;
  /** Whether the host city itself has a sim_cities doc. */
  cityHasSimState: boolean;
  /** The host city is claimed (has at least one owner). */
  cityClaimed: boolean;
}
