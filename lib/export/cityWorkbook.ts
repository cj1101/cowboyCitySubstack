/**
 * Runner: the per-city workbook download (June §10.3). Generated
 * client-side as the requester from their own rules-governed reads;
 * fail-closed — any denied or failed read produces NO file and an
 * honest error (TC-X03). Export mutates nothing (TC-X13).
 */

import { buildCityWorkbook } from "./datasets/cityWorkbook";
import { deliverWorkbook, type DeliveredFile, type ExportFormat } from "./download";
import {
  assertExportAllowed,
  fetchCityExportBundle,
  fetchWorldContext,
  loadExportRequester,
} from "./fetchCityExport";

export type { ExportFormat };

export async function downloadCityWorkbook(args: {
  uid: string;
  cityId: string;
  format: ExportFormat;
}): Promise<DeliveredFile> {
  const requester = await loadExportRequester(args.uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  const bundle = await fetchCityExportBundle(args.cityId);
  const workbook = buildCityWorkbook(bundle, {
    asOfSeq: world.asOfSeq,
    rulesVersion: world.rulesVersion,
    exportedAtIso: new Date().toISOString(),
    exportedByLabel: requester.label,
  });
  return deliverWorkbook(workbook, args.format);
}
