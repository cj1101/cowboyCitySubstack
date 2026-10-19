/**
 * The Phase 3 city + realm workbook builders (Rafe §§3.3/3.6; June
 * phase3 brief §10.2/§10.3). Pure: CityExportBundle[] + context →
 * PlannedWorkbook. Tab names and columns are Rafe §3's, the interim
 * workbook dictionary until Marlowe's lands (June P3-D12).
 *
 * Tier discipline (CJ §7.4): verified figures and owner-published
 * claims NEVER share a tab or a column. Published Claims is always
 * its own tab, and the workbook says so on its Cover.
 */

import {
  assembleWorkbook,
  exportFilenameBase,
  provenanceDefinitions,
  provenanceValues,
  withProvenance,
  type ColumnDefinition,
  type PlannedWorkbook,
  type SheetColumn,
  type SheetSpec,
} from "../sheetSpec";
import {
  STAT_DEFINITIONS,
  deriveDowntimeSinceSeq,
  deriveFunctionAvailable,
  resolvePublicationChains,
  type CityExportBundle,
  type ExportContext,
} from "./cityData";

const CITY_STATS_COLUMNS: SheetColumn[] = [
  { key: "stat_key", header: "stat_key", width: 18, type: "string" },
  { key: "stat_label", header: "stat_label", width: 18, type: "string" },
  { key: "value", header: "value", width: 14, type: "number" },
  { key: "unit", header: "unit", width: 14, type: "string" },
  { key: "allocated_points", header: "allocated_points", width: 16, type: "number" },
  { key: "last_changed_seq", header: "last_changed_seq", width: 16, type: "number" },
];

const PUBLISHED_CLAIMS_COLUMNS: SheetColumn[] = [
  { key: "metric", header: "metric", width: 20, type: "string" },
  { key: "claimed_value", header: "claimed_value", width: 16, type: "string" },
  { key: "unit", header: "unit", width: 12, type: "string" },
  { key: "period_label", header: "period_label", width: 16, type: "string" },
  { key: "claim_note", header: "claim_note", width: 36, type: "string" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "version", header: "version", width: 10, type: "number" },
  { key: "supersedes_id", header: "supersedes_id", width: 18, type: "string" },
  { key: "publication_id", header: "publication_id", width: 18, type: "string" },
  { key: "published_at", header: "published_at", width: 20, type: "string" },
  { key: "published_at_seq", header: "published_at_seq", width: 16, type: "number" },
];

const STRUCTURES_COLUMNS: SheetColumn[] = [
  { key: "structure_id", header: "structure_id", width: 18, type: "string" },
  { key: "structure_name", header: "structure_name", width: 24, type: "string" },
  { key: "owner_id", header: "owner_id", width: 16, type: "string" },
  { key: "function_label", header: "function_label", width: 18, type: "string" },
  { key: "status", header: "status", width: 16, type: "string" },
  { key: "condition", header: "condition", width: 11, type: "number" },
  { key: "function_available", header: "function_available", width: 17, type: "boolean" },
  { key: "downtime_since_seq", header: "downtime_since_seq", width: 17, type: "number" },
  { key: "capacity", header: "capacity", width: 11, type: "number" },
  { key: "linked_pin_id", header: "linked_pin_id", width: 16, type: "string" },
  { key: "linked_wiki_entry_id", header: "linked_wiki_entry_id", width: 18, type: "string" },
];

const BUSINESSES_COLUMNS: SheetColumn[] = [
  { key: "business_id", header: "business_id", width: 18, type: "string" },
  { key: "business_name", header: "business_name", width: 24, type: "string" },
  { key: "owner_id", header: "owner_id", width: 16, type: "string" },
  { key: "owner_name", header: "owner_name", width: 18, type: "string" },
  { key: "home_city_id", header: "home_city_id", width: 16, type: "string" },
  { key: "operating_city_ids", header: "operating_city_ids", width: 24, type: "string" },
  { key: "status", header: "status", width: 13, type: "string" },
  { key: "industry", header: "industry", width: 16, type: "string" },
  { key: "valuation_rubars", header: "valuation_rubars", width: 16, type: "number" },
  // Tax columns arrive with Vera's Phase 4 cross-city tax model —
  // absent columns until then, never zero-filled fictions (June §10.3).
];

const GEOGRAPHY_COLUMNS: SheetColumn[] = [
  { key: "feature_id", header: "feature_id", width: 18, type: "string" },
  { key: "feature_name", header: "feature_name", width: 24, type: "string" },
  { key: "feature_kind", header: "feature_kind", width: 14, type: "string" },
  { key: "status", header: "status", width: 14, type: "string" },
  { key: "last_changed_seq", header: "last_changed_seq", width: 16, type: "number" },
  { key: "rule_cited", header: "rule_cited", width: 16, type: "string" },
];

function definitionsFor(tab: string, entries: [string, string, string | null][]): ColumnDefinition[] {
  return entries.map(([column, meaning, unit]) => ({
    tab,
    column,
    meaning,
    unit,
    trustTier: tab === "Published Claims" ? "owner_published" : "verified",
    source: tab === "Published Claims" ? "sim_publications" : "sim state (resolver/Log)",
  }));
}

export function buildCityStatsSheet(
  bundles: CityExportBundle[],
  ctx: ExportContext
): SheetSpec {
  const rows: SheetSpec["rows"] = [];
  for (const bundle of bundles) {
    for (const stat of STAT_DEFINITIONS) {
      rows.push({
        stat_key: stat.key,
        stat_label: stat.label,
        value: bundle.stats ? (bundle.stats[stat.key] ?? null) : null,
        unit: stat.unit,
        allocated_points:
          stat.allocatable && bundle.allocations
            ? (bundle.allocations[stat.key] ?? null)
            : null,
        last_changed_seq: bundle.lastChangedSeq,
        ...provenanceValues({
          cityId: bundle.cityId,
          cityName: bundle.cityName,
          trustTier: "verified",
          sourceType: "resolver",
          sourceRef:
            bundle.lastChangedSeq !== null ? String(bundle.lastChangedSeq) : null,
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          stateVersion: bundle.stateVersion,
          notes: [
            bundle.hasSimState ? null : "City is not in the sim yet — no sim state exists.",
            bundle.baselineHash ? `baseline_hash ${bundle.baselineHash}` : null,
          ]
            .filter(Boolean)
            .join(" ") || null,
        }),
      });
    }
  }
  return { name: "City Stats", columns: withProvenance(CITY_STATS_COLUMNS), rows };
}

export function buildPublishedClaimsSheet(
  bundles: CityExportBundle[],
  ctx: ExportContext
): SheetSpec {
  const rows: SheetSpec["rows"] = [];
  for (const bundle of bundles) {
    for (const pub of resolvePublicationChains(bundle.publications)) {
      const provenance = provenanceValues({
        cityId: bundle.cityId,
        cityName: bundle.cityName,
        entityId: pub.businessId,
        trustTier: "owner_published",
        sourceType: "owner_publication",
        sourceRef: `${pub.publicationId} v${pub.version}`,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        publishedBy: pub.publisherLabel ?? pub.publisherUid,
        notes:
          "Owner-published claim — NOT verified by the sim. See the Cover trust legend.",
      });
      if (pub.claims.length === 0) {
        rows.push({
          metric: null,
          claimed_value: null,
          unit: null,
          period_label: null,
          claim_note:
            pub.chainStatus === "retracted"
              ? "Version retracted by its publisher; no claims carried."
              : "Version carries no claims.",
          status: pub.chainStatus,
          version: pub.version,
          supersedes_id: pub.supersedesPublicationId,
          publication_id: pub.publicationId,
          published_at: pub.publishedAtIso,
          published_at_seq: pub.publishedAtSeq,
          ...provenance,
        });
        continue;
      }
      for (const claim of pub.claims) {
        rows.push({
          metric: claim.metric,
          claimed_value:
            claim.claimedValue === null ? null : String(claim.claimedValue),
          unit: claim.unit,
          period_label: claim.periodLabel,
          claim_note: claim.note,
          status: pub.chainStatus,
          version: pub.version,
          supersedes_id: pub.supersedesPublicationId,
          publication_id: pub.publicationId,
          published_at: pub.publishedAtIso,
          published_at_seq: pub.publishedAtSeq,
          ...provenance,
        });
      }
    }
  }
  return {
    name: "Published Claims",
    columns: withProvenance(PUBLISHED_CLAIMS_COLUMNS),
    rows,
  };
}

export function buildStructuresSheet(
  bundles: CityExportBundle[],
  ctx: ExportContext
): SheetSpec {
  const rows: SheetSpec["rows"] = [];
  for (const bundle of bundles) {
    for (const structure of bundle.structures) {
      rows.push({
        structure_id: structure.structureId,
        structure_name: structure.name,
        owner_id: structure.ownerId,
        function_label: structure.functionLabel,
        status: structure.status,
        condition: structure.condition,
        function_available: deriveFunctionAvailable(structure),
        downtime_since_seq: deriveDowntimeSinceSeq(structure),
        capacity: structure.capacity,
        linked_pin_id: structure.linkedPinId,
        linked_wiki_entry_id: structure.linkedWikiEntryId,
        ...provenanceValues({
          cityId: bundle.cityId,
          cityName: bundle.cityName,
          entityId: structure.structureId,
          entityName: structure.name,
          trustTier: "verified",
          sourceType: "resolver",
          sourceRef:
            structure.lastResolutionId ??
            (structure.lastChangedSeq !== null
              ? String(structure.lastChangedSeq)
              : null),
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          stateVersion: structure.stateVersion,
          notes:
            "function_available is derived from status/condition at export time (damage = out of function); it is not a stored flag.",
        }),
      });
    }
  }
  return { name: "Structures", columns: withProvenance(STRUCTURES_COLUMNS), rows };
}

export function buildBusinessesSheet(
  bundles: CityExportBundle[],
  ctx: ExportContext
): SheetSpec {
  const rows: SheetSpec["rows"] = [];
  for (const bundle of bundles) {
    for (const business of bundle.businesses) {
      rows.push({
        business_id: business.businessId,
        business_name: business.name,
        owner_id: business.ownerId,
        owner_name: business.ownerName,
        home_city_id: business.homeCityId ?? bundle.cityId,
        operating_city_ids:
          business.operatingCityIds.length > 0
            ? business.operatingCityIds.join(", ")
            : null,
        status: business.status,
        industry: business.industry,
        valuation_rubars: business.valuationRubars,
        ...provenanceValues({
          cityId: bundle.cityId,
          cityName: bundle.cityName,
          entityId: business.businessId,
          entityName: business.name,
          trustTier: "verified",
          sourceType: "resolver",
          sourceRef:
            business.lastChangedSeq !== null
              ? String(business.lastChangedSeq)
              : null,
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          stateVersion: business.stateVersion,
          notes:
            "Owner is distinct from host city. Tax columns arrive with the Phase 4 cross-city tax model.",
        }),
      });
    }
  }
  return { name: "Businesses", columns: withProvenance(BUSINESSES_COLUMNS), rows };
}

export function buildGeographySheet(
  bundles: CityExportBundle[],
  ctx: ExportContext
): SheetSpec {
  const rows: SheetSpec["rows"] = [];
  for (const bundle of bundles) {
    for (const feature of bundle.geography) {
      rows.push({
        feature_id: feature.featureId,
        feature_name: feature.name,
        feature_kind: feature.kind,
        status: feature.status,
        last_changed_seq: feature.lastChangedSeq,
        rule_cited: feature.ruleCited,
        ...provenanceValues({
          cityId: bundle.cityId,
          cityName: bundle.cityName,
          entityId: feature.featureId,
          entityName: feature.name,
          trustTier: "verified",
          sourceType: "lore_reference",
          sourceRef:
            feature.lastChangedSeq !== null
              ? String(feature.lastChangedSeq)
              : null,
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          notes:
            feature.lastChangedSeq === null
              ? "Fixed natural ground truth — unchanged; changes only via a deliberate man-made project (CJ's corrected §6.7.4)."
              : "Changed by a deliberate man-made project; see the cited Log seq.",
        }),
      });
    }
  }
  return { name: "Geography", columns: withProvenance(GEOGRAPHY_COLUMNS), rows };
}

function cityDefinitions(): ColumnDefinition[] {
  return [
    ...definitionsFor("City Stats", [
      ["stat_key", "Stat identifier from the sim template.", null],
      ["stat_label", "Human-readable stat name.", null],
      ["value", "Verified sim value. Empty when null — never an invented default (unallocated indices and unrecorded stocks are null).", "per stat"],
      ["unit", "Unit of the stat.", null],
      ["allocated_points", "Season-0 allocated value for the eight allocatable indices, present only when the exporter may read the allocation record.", "points"],
      ["last_changed_seq", "Log seq that last changed this city's state.", "seq"],
    ]),
    ...definitionsFor("Published Claims", [
      ["metric", "Metric the claim is about, as named by its publisher.", null],
      ["claimed_value", "The publisher's claimed figure. A claim, not a verified value.", null],
      ["unit", "Unit as stated by the publisher.", null],
      ["period_label", "Period the claim describes, as stated by the publisher.", null],
      ["claim_note", "Publisher's note on the claim.", null],
      ["status", "published | superseded | retracted — the version chain's current reading; a retracted claim never exports as current.", null],
      ["version", "Publication version number.", null],
      ["supersedes_id", "Publication ID this version supersedes, if any.", null],
      ["publication_id", "Publication document ID.", null],
      ["published_at", "Publish timestamp (ISO-8601).", null],
      ["published_at_seq", "Log head at publish time (publisher-asserted metadata until the Phase 4 publish path stamps it).", "seq"],
    ]),
    ...definitionsFor("Structures", [
      ["structure_id", "Structure document ID.", null],
      ["structure_name", "Structure name.", null],
      ["owner_id", "Owning member ID where the record carries one; distinct from host city.", null],
      ["function_label", "Structured, rule-readable function (kind/function) — not flavor text.", null],
      ["status", "planned | under-construction | complete | mothballed | demolished | ruined.", null],
      ["condition", "Condition 0-100 where recorded.", "0-100"],
      ["function_available", "DERIVED at export time: complete and not recorded at condition 0. Damage = out of function. Vera's condition threshold is a Phase 4 lock; no threshold is invented here.", "boolean"],
      ["downtime_since_seq", "Log seq since which the structure has been out of function, where applicable.", "seq"],
      ["capacity", "Capacity where the record sets one.", null],
      ["linked_pin_id", "Map pin linked to this structure.", null],
      ["linked_wiki_entry_id", "Wiki entry linked to this structure.", null],
    ]),
    ...definitionsFor("Businesses", [
      ["business_id", "Corporation document ID.", null],
      ["business_name", "Business name.", null],
      ["owner_id", "Owning member ID — distinct from the host city (CJ §6.7).", null],
      ["owner_name", "Owner display name where recorded.", null],
      ["home_city_id", "City the business is based in.", null],
      ["operating_city_ids", "Cities the business operates in.", null],
      ["status", "active | contracted | relocated | dissolved.", null],
      ["industry", "Industry label.", null],
      ["valuation_rubars", "Verified valuation from the sim record. Published claims about value live on Published Claims, never here.", "Rubar"],
    ]),
    ...definitionsFor("Geography", [
      ["feature_id", "Geographic feature record ID.", null],
      ["feature_name", "Feature name.", null],
      ["feature_kind", "lake | river | coast | … — the feature's kind.", null],
      ["status", "Feature status as recorded.", null],
      ["last_changed_seq", "Log seq of the man-made project that last changed this record; empty for fixed natural ground truth.", "seq"],
      ["rule_cited", "Rule cited by the changing resolution, where applicable.", null],
    ]),
    ...provenanceDefinitions("City Stats"),
    ...provenanceDefinitions("Published Claims"),
    ...provenanceDefinitions("Structures"),
    ...provenanceDefinitions("Businesses"),
    ...provenanceDefinitions("Geography"),
  ];
}

/** The per-city workbook (June §10.3). Stat Allocation is a Phase 4
 * tab — allocations don't exist yet; its absence is a decision. */
export function buildCityWorkbook(bundle: CityExportBundle, ctx: ExportContext): PlannedWorkbook {
  const dataSheets = [
    buildCityStatsSheet([bundle], ctx),
    buildPublishedClaimsSheet([bundle], ctx),
    buildStructuresSheet([bundle], ctx),
    buildBusinessesSheet([bundle], ctx),
    buildGeographySheet([bundle], ctx),
  ];
  return assembleWorkbook({
    filenameBase: exportFilenameBase(bundle.slug ?? bundle.cityName, ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Cowboy City — ${bundle.cityName} export`,
      scopeLabel: `One city: ${bundle.cityName} (${bundle.cityId})`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: dataSheets[1].rows.length > 0,
    },
    dataSheets,
    definitions: cityDefinitions(),
  });
}

/** The realm/dashboard-scope workbook (June §10.2): one tab per
 * dataset visible to the requester, assembled at one as_of_seq,
 * containing zero rows from any other member's private sets. */
export function buildRealmWorkbook(bundles: CityExportBundle[], ctx: ExportContext): PlannedWorkbook {
  const dataSheets = [
    buildCityStatsSheet(bundles, ctx),
    buildPublishedClaimsSheet(bundles, ctx),
    buildStructuresSheet(bundles, ctx),
    buildBusinessesSheet(bundles, ctx),
    buildGeographySheet(bundles, ctx),
  ];
  return assembleWorkbook({
    filenameBase: exportFilenameBase("realm", ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: "Cowboy City — realm export",
      scopeLabel: `Realm-wide, as visible to the exporter (${bundles.length} cities)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: dataSheets[1].rows.length > 0,
    },
    dataSheets,
    definitions: cityDefinitions(),
  });
}
