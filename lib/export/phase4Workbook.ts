/**
 * One-call Phase 4 export runners (the downloadCityWorkbook idiom):
 * resolve the requester, enforce the export fence (members only —
 * guests are view-only, OPEN-1 default / TC-X02), read the world
 * context, fetch the requester-scoped bundle, build the workbook,
 * and deliver it as a download. Any failure throws (an honest error
 * state in the calling UI) and produces no file.
 */

import { deliverWorkbook, type ExportFormat } from "./download";
import { assertExportAllowed, fetchWorldContext, loadExportRequester } from "./fetchCityExport";
import {
  fetchCityLedgerBundle,
  fetchPortfolioBundle,
  fetchSurveyRecords,
} from "./fetchPhase4Export";
import {
  buildCityLedgerWorkbook,
  buildPortfolioWorkbook,
  buildSurveyWorkbook,
} from "./datasets/phase4Workbook";
import type { ExportContext } from "./datasets/cityData";

async function contextFor(uid: string): Promise<{ ctx: ExportContext; label: string }> {
  const requester = await loadExportRequester(uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  return {
    label: requester.label,
    ctx: {
      asOfSeq: world.asOfSeq,
      rulesVersion: world.rulesVersion,
      exportedAtIso: new Date().toISOString(),
      exportedByLabel: requester.label,
    },
  };
}

export async function downloadPortfolioWorkbook(input: {
  uid: string;
  format: ExportFormat;
}): Promise<void> {
  const { ctx, label } = await contextFor(input.uid);
  const bundle = await fetchPortfolioBundle(input.uid, label);
  const workbook = buildPortfolioWorkbook(bundle, ctx, input.uid);
  await deliverWorkbook(workbook, input.format);
}

export async function downloadCityLedgerWorkbook(input: {
  uid: string;
  cityId: string;
  format: ExportFormat;
}): Promise<void> {
  const { ctx } = await contextFor(input.uid);
  const bundle = await fetchCityLedgerBundle(input.cityId);
  const workbook = buildCityLedgerWorkbook(bundle, ctx);
  await deliverWorkbook(workbook, input.format);
}

export async function downloadSurveyWorkbook(input: {
  uid: string;
  format: ExportFormat;
}): Promise<void> {
  const { ctx } = await contextFor(input.uid);
  const records = await fetchSurveyRecords(input.uid);
  const workbook = buildSurveyWorkbook(records, ctx, input.uid);
  await deliverWorkbook(workbook, input.format);
}
