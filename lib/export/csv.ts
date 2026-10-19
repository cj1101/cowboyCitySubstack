/**
 * The CSV companion (Rafe §5): one CSV per data tab — same rows, same
 * columns, same order, same provenance block as the .xlsx tab (parity
 * is a tested property, TC-X08). No dataset is CSV-only or Excel-only.
 *
 * Encoding: UTF-8 with BOM, CRLF line endings, RFC 4180 quoting — the
 * combination Excel and Google Sheets both import correctly. Dates
 * serialize as ISO-8601 strings (the .xlsx uses date cells; the values
 * are identical). Formula-injection defusing already happened in the
 * shared normalization pass (sheetSpec.ts), so CSV — the format most
 * likely to be opened carelessly — gets no weaker treatment.
 */

import {
  flatCellMatrix,
  sheetHeaderRow,
  type FlatCell,
  type PlannedWorkbook,
  type SheetSpec,
} from "./sheetSpec";

const BOM = "\uFEFF";

function csvEscape(value: FlatCell): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sheetToCsv(spec: SheetSpec): string {
  const lines = [
    sheetHeaderRow(spec),
    ...flatCellMatrix(spec).map((row) => row.map((cell) => cell ?? "")),
  ];
  return BOM + lines.map((row) => row.map(csvEscape).join(",")).join("\r\n") + "\r\n";
}

export interface CsvFile {
  filename: string;
  content: string;
}

/**
 * A workbook's CSV bundle: a `manifest.csv` carrying the Cover context
 * (scope, as_of_seq, exported-by, trust legend, truncation) in
 * key/value rows — so a CSV bundle is never context-free — plus one
 * CSV per data tab. Cover/Summary/Definitions are workbook concepts;
 * their essential context travels via the manifest and the in-row
 * provenance columns (Rafe §5.1).
 */
export function workbookToCsvFiles(workbook: PlannedWorkbook): CsvFile[] {
  const meta = workbook.meta;
  const manifestRows: [string, string | number | null][] = [
    ["title", meta.title],
    ["scope", meta.scopeLabel],
    ["exported_at", meta.exportedAtIso],
    ["exported_by", meta.exportedByLabel],
    ["as_of_seq", meta.asOfSeq],
    ["rules_version", meta.rulesVersion],
    [
      "contains_owner_published",
      meta.containsOwnerPublished ? "YES" : "No",
    ],
    [
      "trust_legend",
      "Owner-published figures are claims by their publisher and are not verified by the sim. Verified figures are derived from sim records / the Log.",
    ],
    [
      "convenience_copy",
      "An exported file is a convenience copy, not evidence; disputes are settled against the Log.",
    ],
    [
      "google_sheets",
      "Downloads an Excel file. To use it in Google Sheets, download and import it there yourself.",
    ],
  ];
  if (meta.partLabel) manifestRows.push(["part", meta.partLabel]);
  if (meta.truncation) {
    manifestRows.push([
      "TRUNCATED",
      `Requested: ${meta.truncation.requested}. Included: ${meta.truncation.included}. Omitted: ${meta.truncation.omittedCount} rows. Reason: ${meta.truncation.reason}.`,
    ]);
  }
  const manifest: SheetSpec = {
    name: "manifest",
    columns: [
      { key: "key", header: "key", type: "string" },
      { key: "value", header: "value", type: "string" },
    ],
    rows: manifestRows.map(([key, value]) => ({ key, value })),
  };
  const dataSheets = workbook.sheets.filter(
    (sheet) => !["Cover", "Summary", "Definitions"].includes(sheet.name)
  );
  return [
    { filename: "manifest.csv", content: sheetToCsv(manifest) },
    ...dataSheets.map((sheet) => ({
      filename: `${sheet.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`,
      content: sheetToCsv(sheet),
    })),
  ];
}
