/**
 * The per-entity workbook (June §10.4): the entity's exportable record
 * (identity, function, status/condition, connections, provenance) plus
 * gallery METADATA (uploader, date, kind, caption — never image
 * binaries), scoped to exactly what the requester may see.
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
  deriveDowntimeSinceSeq,
  deriveFunctionAvailable,
  type BusinessExportData,
  type ExportContext,
  type StructureExportData,
} from "./cityData";

export interface GalleryItemExportData {
  imageId: string;
  uploaderLabel: string | null;
  uploadedAtIso: string | null;
  /** screenshot | plan | map */
  kind: string | null;
  caption: string | null;
  /** accepted | pending — proposals land pending until the building
   * owner or host-city owner accepts (June §8.4). */
  acceptanceState: string | null;
  isShowcase: boolean;
}

export interface ConnectionExportData {
  connectionLabel: string;
  targetId: string | null;
  targetName: string | null;
  targetKind: string | null;
}

export interface EntityExportInput {
  cityId: string;
  cityName: string;
  entityKind: "structure" | "business";
  structure?: StructureExportData;
  business?: BusinessExportData;
  gallery: GalleryItemExportData[];
  connections: ConnectionExportData[];
}

const GALLERY_COLUMNS: SheetColumn[] = [
  { key: "image_id", header: "image_id", width: 18, type: "string" },
  { key: "kind", header: "kind", width: 12, type: "string" },
  { key: "caption", header: "caption", width: 40, type: "string" },
  { key: "uploaded_at", header: "uploaded_at", width: 20, type: "string" },
  { key: "acceptance_state", header: "acceptance_state", width: 15, type: "string" },
  { key: "is_showcase", header: "is_showcase", width: 12, type: "boolean" },
];

const CONNECTION_COLUMNS: SheetColumn[] = [
  { key: "connection", header: "connection", width: 22, type: "string" },
  { key: "target_id", header: "target_id", width: 18, type: "string" },
  { key: "target_name", header: "target_name", width: 24, type: "string" },
  { key: "target_kind", header: "target_kind", width: 16, type: "string" },
];

export function buildEntityWorkbook(
  input: EntityExportInput,
  ctx: ExportContext
): PlannedWorkbook {
  const entityId =
    input.entityKind === "structure"
      ? input.structure?.structureId
      : input.business?.businessId;
  const entityName =
    input.entityKind === "structure" ? input.structure?.name : input.business?.name;

  const detailRows: SheetSpec["rows"] = [];
  const detailColumns: SheetColumn[] = [
    { key: "field", header: "field", width: 24, type: "string" },
    { key: "value", header: "value", width: 60, type: "string" },
  ];
  const pushField = (field: string, value: string | number | boolean | null) =>
    detailRows.push({
      field,
      value: value === null ? null : String(value),
      ...provenanceValues({
        cityId: input.cityId,
        cityName: input.cityName,
        entityId: entityId ?? null,
        entityName: entityName ?? null,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
      }),
    });

  pushField("entity_kind", input.entityKind);
  pushField("entity_id", entityId ?? null);
  pushField("entity_name", entityName ?? null);
  pushField("host_city", `${input.cityName} (${input.cityId})`);
  if (input.entityKind === "structure" && input.structure) {
    const s = input.structure;
    pushField("function_label", s.functionLabel);
    pushField("status", s.status);
    pushField("condition", s.condition);
    pushField("function_available", deriveFunctionAvailable(s));
    pushField("downtime_since_seq", deriveDowntimeSinceSeq(s));
    pushField("capacity", s.capacity);
    pushField("owner_id", s.ownerId);
    pushField("linked_pin_id", s.linkedPinId);
    pushField("linked_wiki_entry_id", s.linkedWikiEntryId);
    pushField("last_changed_seq", s.lastChangedSeq);
    pushField("last_resolution_id", s.lastResolutionId);
  }
  if (input.entityKind === "business" && input.business) {
    const b = input.business;
    pushField("owner_id", b.ownerId);
    pushField("owner_name", b.ownerName);
    pushField("home_city_id", b.homeCityId);
    pushField("operating_city_ids", b.operatingCityIds.join(", ") || null);
    pushField("status", b.status);
    pushField("industry", b.industry);
    pushField("valuation_rubars", b.valuationRubars);
    pushField("last_changed_seq", b.lastChangedSeq);
  }

  const gallerySheet: SheetSpec = {
    name: "Gallery Metadata",
    columns: withProvenance(GALLERY_COLUMNS),
    rows: input.gallery.map((item) => ({
      image_id: item.imageId,
      kind: item.kind,
      caption: item.caption,
      uploaded_at: item.uploadedAtIso,
      acceptance_state: item.acceptanceState,
      is_showcase: item.isShowcase,
      ...provenanceValues({
        cityId: input.cityId,
        cityName: input.cityName,
        entityId: entityId ?? null,
        entityName: entityName ?? null,
        trustTier: "verified",
        sourceType: "legacy_social",
        sourceRef: item.imageId,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        publishedBy: item.uploaderLabel,
        notes: "Gallery metadata only — image binaries are ordinary file downloads under the same visibility, not part of the Excel pattern.",
      }),
    })),
  };

  const connectionsSheet: SheetSpec = {
    name: "Connections",
    columns: withProvenance(CONNECTION_COLUMNS),
    rows: input.connections.map((connection) => ({
      connection: connection.connectionLabel,
      target_id: connection.targetId,
      target_name: connection.targetName,
      target_kind: connection.targetKind,
      ...provenanceValues({
        cityId: input.cityId,
        cityName: input.cityName,
        entityId: entityId ?? null,
        entityName: entityName ?? null,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: connection.targetId,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
      }),
    })),
  };

  const definitions: ColumnDefinition[] = [
    { tab: "Entity", column: "field", meaning: "One attribute of the entity's exportable record per row.", unit: null, trustTier: "verified", source: "sim record" },
    { tab: "Entity", column: "value", meaning: "The attribute's value at export time. function_available is derived from status/condition, never a stored flag.", unit: null, trustTier: "verified", source: "sim record" },
    { tab: "Gallery Metadata", column: "kind", meaning: "screenshot | plan | map — plan images are never framed as screenshots.", unit: null, trustTier: "verified", source: "gallery record" },
    { tab: "Gallery Metadata", column: "acceptance_state", meaning: "accepted | pending — proposals from other members land pending until the owner/host accepts.", unit: null, trustTier: "verified", source: "gallery record" },
    { tab: "Connections", column: "connection", meaning: "How the target connects to this entity (premises, staff, endpoint city, …). Every connection is a link to that entity's own page in-app.", unit: null, trustTier: "verified", source: "sim record" },
    ...provenanceDefinitions("Entity"),
    ...provenanceDefinitions("Gallery Metadata"),
    ...provenanceDefinitions("Connections"),
  ];

  return assembleWorkbook({
    filenameBase: exportFilenameBase(
      entityName ?? entityId ?? "entity",
      ctx.asOfSeq,
      ctx.exportedAtIso
    ),
    meta: {
      title: `Cowboy City — ${entityName ?? "entity"} export`,
      scopeLabel: `One ${input.entityKind}: ${entityName ?? entityId} in ${input.cityName}`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [
      { name: "Entity", columns: withProvenance(detailColumns), rows: detailRows },
      gallerySheet,
      connectionsSheet,
    ],
    definitions,
  });
}
