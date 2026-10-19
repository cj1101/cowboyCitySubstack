/**
 * Runner: the realm/dashboard-scope workbook download (June §10.2) —
 * "Export the dashboard (Excel)". One tab per dataset visible to the
 * requester, assembled at one as_of_seq, with zero rows from any other
 * member's private sets (counts are of visible rows only, TC-X01).
 * Per-panel exports are the same builders over a narrower bundle set;
 * customization arranges panels — it never changes entitlement.
 */

import { buildRealmWorkbook } from "./datasets/cityWorkbook";
import { buildCityWorkbook } from "./datasets/cityWorkbook";
import { deliverWorkbook, type DeliveredFile, type ExportFormat } from "./download";
import {
  assertExportAllowed,
  fetchCityExportBundle,
  fetchRealmExportBundles,
  fetchWorldContext,
  loadExportRequester,
} from "./fetchCityExport";

export type { ExportFormat };

export async function downloadRealmWorkbook(args: {
  uid: string;
  format: ExportFormat;
}): Promise<DeliveredFile> {
  const requester = await loadExportRequester(args.uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  const bundles = await fetchRealmExportBundles();
  const workbook = buildRealmWorkbook(bundles, {
    asOfSeq: world.asOfSeq,
    rulesVersion: world.rulesVersion,
    exportedAtIso: new Date().toISOString(),
    exportedByLabel: requester.label,
  });
  return deliverWorkbook(workbook, args.format);
}

/** Per-panel scope: exactly the cities that panel shows this user —
 * the city workbook over the panel's visible bundle set. */
export async function downloadPanelWorkbook(args: {
  uid: string;
  cityIds: string[];
  format: ExportFormat;
}): Promise<DeliveredFile> {
  const requester = await loadExportRequester(args.uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  const bundles = [];
  for (const cityId of args.cityIds) {
    bundles.push(await fetchCityExportBundle(cityId));
  }
  const ctx = {
    asOfSeq: world.asOfSeq,
    rulesVersion: world.rulesVersion,
    exportedAtIso: new Date().toISOString(),
    exportedByLabel: requester.label,
  };
  const workbook =
    bundles.length === 1
      ? buildCityWorkbook(bundles[0], ctx)
      : buildRealmWorkbook(bundles, ctx);
  return deliverWorkbook(workbook, args.format);
}
