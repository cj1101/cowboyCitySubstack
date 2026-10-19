/**
 * Download delivery for planned workbooks (Rafe §5.3): a single file
 * downloads bare; a multi-file bundle (xlsx + CSV companions, or a
 * multi-tab CSV set) is delivered together in one ZIP via the existing
 * hand-rolled `zipStore` — no new dependency. `downloadBlob` itself is
 * the realm substrate's, re-exported so export callers import one place.
 */

import { downloadBlob } from "./realm";
import { zipStore } from "./zip";
import { workbookToCsvFiles } from "./csv";
import { renderWorkbookBlob } from "./workbook";
import type { PlannedWorkbook } from "./sheetSpec";

export { downloadBlob };

export interface DeliveredFile {
  filename: string;
}

/**
 * Build and download one planned workbook in the chosen format.
 * Throws (fail-closed) before any file exists if rendering fails —
 * callers surface the error and no partial file is produced.
 */
export async function downloadPlannedWorkbook(
  workbook: PlannedWorkbook,
  format: "xlsx" | "csv"
): Promise<DeliveredFile> {
  if (format === "xlsx") {
    const blob = await renderWorkbookBlob(workbook.sheets);
    const filename = `${workbook.filenameBase}.xlsx`;
    downloadBlob(blob, filename);
    return { filename };
  }
  const csvFiles = workbookToCsvFiles(workbook);
  if (csvFiles.length === 1) {
    const file = csvFiles[0];
    downloadBlob(
      new Blob([file.content], { type: "text/csv;charset=utf-8" }),
      file.filename
    );
    return { filename: file.filename };
  }
  const bundle = zipStore(
    csvFiles.map((file) => ({
      name: file.filename,
      data: new TextEncoder().encode(file.content),
    }))
  );
  const filename = `${workbook.filenameBase}-csv.zip`;
  downloadBlob(bundle, filename);
  return { filename };
}

export type ExportFormat = "xlsx" | "csv" | "both";

/** Deliver a planned workbook in the requested format. */
export async function deliverWorkbook(
  workbook: PlannedWorkbook,
  format: ExportFormat
): Promise<DeliveredFile> {
  if (format === "both") return downloadPlannedWorkbookBoth(workbook);
  return downloadPlannedWorkbook(workbook, format);
}

/** Both formats together (xlsx + the CSV bundle) in one ZIP. */
export async function downloadPlannedWorkbookBoth(
  workbook: PlannedWorkbook
): Promise<DeliveredFile> {
  const xlsxBlob = await renderWorkbookBlob(workbook.sheets);
  const files: { name: string; data: Uint8Array }[] = [
    {
      name: `${workbook.filenameBase}.xlsx`,
      data: new Uint8Array(await xlsxBlob.arrayBuffer()),
    },
    ...workbookToCsvFiles(workbook).map((file) => ({
      name: file.filename,
      data: new TextEncoder().encode(file.content),
    })),
  ];
  const filename = `${workbook.filenameBase}.zip`;
  downloadBlob(zipStore(files), filename);
  return { filename };
}
