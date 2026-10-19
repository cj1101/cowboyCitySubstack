/**
 * The .xlsx renderer: a single small adapter from `SheetSpec[]` to a
 * Blob over `write-excel-file` (Rafe §2.2 recommendation). The library
 * is loaded via dynamic `import()` ONLY when a user clicks an export
 * action, so it lands in a lazy chunk and never touches a route's
 * first load (Phase 2 pattern, lib/export/logWorkbook.ts).
 *
 * No library types leak past this file: everything upstream speaks
 * SheetSpec, so swapping or adding a renderer later touches only here.
 */

import {
  sheetHeaderRow,
  specCellMatrix,
  type SheetSpec,
} from "./sheetSpec";

/** Render planned sheets to an .xlsx Blob (browser only). */
export async function renderWorkbookBlob(sheets: SheetSpec[]): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  return writeXlsxFile(
    sheets.map((sheet) => {
      const matrix = specCellMatrix(sheet);
      return {
        sheet: sheet.name,
        columns: sheet.columns.map((column) => ({
          width: column.width ?? 16,
        })),
        // Frozen header row: headers stay visible while scrolling.
        stickyRowsCount: 1,
        data: [
          sheetHeaderRow(sheet).map((header) => ({
            value: header,
            fontWeight: "bold" as const,
          })),
          ...matrix.map((row) =>
            row.map((cell) => {
              if (cell instanceof Date) {
                return {
                  value: cell,
                  type: Date as unknown as DateConstructor,
                  format: "yyyy-mm-dd hh:mm:ss",
                };
              }
              return cell;
            })
          ),
        ],
      };
    })
  ).toBlob();
}
