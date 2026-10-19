/**
 * Runner: the per-entity workbook download (June §10.4). Gallery
 * metadata comes from the entity record's `gallery` array where the
 * Phase 3 gallery path has written one; connections are the entity's
 * own links (pin/wiki/premises/staff) — every connection is a link to
 * that entity's own page in-app, never an embedded copy.
 */

import {
  buildEntityWorkbook,
  type ConnectionExportData,
  type GalleryItemExportData,
} from "./datasets/entityWorkbook";
import { deliverWorkbook, type DeliveredFile, type ExportFormat } from "./download";
import {
  assertExportAllowed,
  fetchBusinessExportData,
  fetchCityExportBundle,
  fetchStructureExportData,
  fetchWorldContext,
  isoOf,
  loadExportRequester,
} from "./fetchCityExport";
import type { DocumentData } from "firebase/firestore";

export type { ExportFormat };

function galleryFrom(raw: DocumentData): GalleryItemExportData[] {
  const items = raw.gallery;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is DocumentData => !!item && typeof item === "object")
    .map((item, index) => ({
      imageId: typeof item.id === "string" ? item.id : `image-${index + 1}`,
      uploaderLabel:
        typeof item.uploaderLabel === "string" ? item.uploaderLabel : null,
      uploadedAtIso: isoOf(item.uploadedAt) ??
        (typeof item.uploadedAtIso === "string" ? item.uploadedAtIso : null),
      kind: typeof item.kind === "string" ? item.kind : null,
      caption: typeof item.caption === "string" ? item.caption : null,
      acceptanceState:
        typeof item.acceptanceState === "string" ? item.acceptanceState : null,
      isShowcase: item.isShowcase === true,
    }));
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

export async function downloadEntityWorkbook(args: {
  uid: string;
  cityId: string;
  entityKind: "structure" | "business";
  entityId: string;
  format: ExportFormat;
}): Promise<DeliveredFile> {
  const requester = await loadExportRequester(args.uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  const bundle = await fetchCityExportBundle(args.cityId);
  const connections: ConnectionExportData[] = [];
  let gallery: GalleryItemExportData[] = [];
  let structure;
  let business;

  if (args.entityKind === "structure") {
    const fetched = await fetchStructureExportData(args.cityId, args.entityId);
    structure = fetched.structure;
    gallery = galleryFrom(fetched.raw);
    if (structure.linkedPinId) {
      connections.push({ connectionLabel: "map pin", targetId: structure.linkedPinId, targetName: null, targetKind: "pin" });
    }
    if (structure.linkedWikiEntryId) {
      connections.push({ connectionLabel: "wiki entry", targetId: structure.linkedWikiEntryId, targetName: null, targetKind: "wiki_entry" });
    }
    for (const corpId of strList(fetched.raw.staffCorporationIds)) {
      connections.push({ connectionLabel: "staff business", targetId: corpId, targetName: null, targetKind: "business" });
    }
  } else {
    const fetched = await fetchBusinessExportData(args.cityId, args.entityId);
    business = fetched.business;
    gallery = galleryFrom(fetched.raw);
    for (const structureId of strList(fetched.raw.linkedStructureIds)) {
      connections.push({ connectionLabel: "premises", targetId: structureId, targetName: null, targetKind: "structure" });
    }
    for (const cityId of business.operatingCityIds) {
      connections.push({ connectionLabel: "operates in", targetId: cityId, targetName: null, targetKind: "city" });
    }
  }

  const workbook = buildEntityWorkbook(
    {
      cityId: args.cityId,
      cityName: bundle.cityName,
      entityKind: args.entityKind,
      structure,
      business,
      gallery,
      connections,
    },
    {
      asOfSeq: world.asOfSeq,
      rulesVersion: world.rulesVersion,
      exportedAtIso: new Date().toISOString(),
      exportedByLabel: requester.label,
    }
  );
  return deliverWorkbook(workbook, args.format);
}
