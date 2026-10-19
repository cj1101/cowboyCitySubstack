/**
 * The personal audit export (Phase 2 brief §11.2): the standing Log as a
 * spreadsheet, produced CLIENT-SIDE as the requesting user — every read
 * behind it is rules-governed, so the export can contain nothing the
 * requester could not already see, and it structurally excludes
 * publications/intel content (a personal audit is not a publication).
 *
 * Discipline (QA TC-X): values, never formulas — every cell is a literal
 * value (the write-excel-file cells are typed String/Number, never
 * Formula); provenance is preserved, not summarized (seq + entryHash +
 * prevHash on every row); the row caps are PACKAGING caps — larger
 * exports split into multiple workbooks by contiguous seq range, each
 * complete for its range, and `-PARTIAL` appears only when the user
 * explicitly limited the export, declared on the Cover.
 */

export const MAX_ROWS_PER_TAB = 50_000;
export const MAX_ROWS_PER_WORKBOOK = 100_000;

export interface ExportEntry {
  seq: number;
  entryHash: string;
  prevHash: string;
  resolutionId: string;
  kind: string;
  resolvedAt: string;
  rulesVersion: string;
  hashVersion: string;
  actorLabel: string;
  actorUid: string | null;
  cityId: string | null;
  cityIds: string[];
  ruleIds: string[];
  visibility: string;
  baselineVersion: string | null;
  summaryText: string;
  writeSetDigest: string | null;
  changes: { field: string; before: unknown; after: unknown; formula: string }[];
}

export interface WorkbookPart {
  filename: string;
  partial: boolean;
  fromSeq: number;
  toSeq: number;
  sheets: { name: string; rows: (string | number | null)[][] }[];
  csv: { filename: string; content: string };
}

function cellValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

const ENTRIES_HEADER = [
  "seq",
  "entry_hash",
  "prev_hash",
  "resolution_id",
  "kind",
  "resolved_at",
  "actor",
  "city_ids",
  "rule_ids",
  "baseline_version",
  "visibility",
  "summary",
];
const CHANGES_HEADER = ["seq", "entry_hash", "city_id", "field", "before", "after", "ruling"];
const PROVENANCE_HEADER = [
  "seq",
  "entry_hash",
  "prev_hash",
  "resolution_id",
  "write_set_digest",
  "rules_version",
  "hash_version",
];

function entryRow(entry: ExportEntry): (string | number | null)[] {
  return [
    entry.seq,
    entry.entryHash,
    entry.prevHash,
    entry.resolutionId,
    entry.kind,
    entry.resolvedAt,
    entry.actorLabel,
    entry.cityIds.join(", "),
    entry.ruleIds.join(", "),
    entry.baselineVersion,
    entry.visibility,
    entry.summaryText,
  ];
}

function csvEscape(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export interface LogWorkbookRequest {
  /** The requester's visible standing entries (rules-filtered by the
   * caller's reads, merged per the read-path rule), seq ascending. */
  entries: ExportEntry[];
  requesterLabel: string;
  asOfSeq: number;
  exportedAtIso: string;
  /** Explicit user limit (first-N newest entries). Only an explicit
   * limit makes the export PARTIAL. */
  explicitLimit?: number | null;
}

/**
 * Plan the workbook set: contiguous seq ranges, each part within both
 * caps, each complete for its range. Pure — the CI suite asserts the
 * split behavior without a browser.
 */
export function planLogWorkbooks(request: LogWorkbookRequest): WorkbookPart[] {
  const all = [...request.entries].sort((a, b) => a.seq - b.seq);
  const partial = typeof request.explicitLimit === "number" && request.explicitLimit > 0;
  const selected = partial
    ? all.slice(Math.max(0, all.length - (request.explicitLimit as number)))
    : all;

  interface Chunk {
    entries: ExportEntry[];
    entryRows: number;
    changeRows: number;
  }
  const chunks: Chunk[] = [];
  let current: Chunk = { entries: [], entryRows: 0, changeRows: 0 };
  for (const entry of selected) {
    const changeCount = entry.changes.length;
    const wouldExceed =
      current.entries.length > 0 &&
      (current.entryRows + 1 > MAX_ROWS_PER_TAB ||
        current.changeRows + changeCount > MAX_ROWS_PER_TAB ||
        current.entryRows + 1 + (current.changeRows + changeCount) + (current.entries.length + 1) >
          MAX_ROWS_PER_WORKBOOK);
    if (wouldExceed) {
      chunks.push(current);
      current = { entries: [], entryRows: 0, changeRows: 0 };
    }
    current.entries.push(entry);
    current.entryRows += 1;
    current.changeRows += changeCount;
  }
  if (current.entries.length > 0 || chunks.length === 0) chunks.push(current);

  return chunks.map((chunk, index) => {
    const fromSeq = chunk.entries.length > 0 ? chunk.entries[0].seq : 0;
    const toSeq = chunk.entries.length > 0 ? chunk.entries[chunk.entries.length - 1].seq : 0;
    const base = `cowboy-city-log-asof-${request.asOfSeq}-seq-${fromSeq}-${toSeq}`;
    const filename = `${base}${partial ? "-PARTIAL" : ""}${chunks.length > 1 ? `-part-${index + 1}-of-${chunks.length}` : ""}.xlsx`;
    const coverRows: (string | number | null)[][] = [
      ["Cowboy City — personal Log audit export"],
      ["as_of_seq", request.asOfSeq],
      ["exported_at", request.exportedAtIso],
      ["exported_by", request.requesterLabel],
      ["covers", `standing Log entries seq ${fromSeq}..${toSeq} (${chunk.entries.length} entries), complete for this range`],
      ...(partial
        ? [["PARTIAL EXPORT", `limited by explicit user request to the newest ${request.explicitLimit} entries; earlier entries are NOT included`]]
        : []),
      [
        "trust",
        "Every row carries its seq, entryHash and prevHash: the export can be re-verified against the standing Log entry-for-entry (hash-chaining is preserved, not summarized). Values only — no spreadsheet formulas. An undone resolution appears nowhere in this export: erasure is total, and this export is a view of the standing world, not an archive of removed ones.",
      ],
    ];
    const entryRows = [ENTRIES_HEADER, ...chunk.entries.map(entryRow)];
    const changeRows = [
      CHANGES_HEADER,
      ...chunk.entries.flatMap((entry) =>
        entry.changes.map((change) => [
          entry.seq,
          entry.entryHash,
          entry.cityId,
          change.field,
          cellValue(change.before),
          cellValue(change.after),
          change.formula,
        ])
      ),
    ];
    const provenanceRows = [
      PROVENANCE_HEADER,
      ...chunk.entries.map((entry) => [
        entry.seq,
        entry.entryHash,
        entry.prevHash,
        entry.resolutionId,
        entry.writeSetDigest,
        entry.rulesVersion,
        entry.hashVersion,
      ]),
    ];
    const csvContent = [ENTRIES_HEADER, ...chunk.entries.map(entryRow)]
      .map((row) => row.map(csvEscape).join(","))
      .join("\n");
    return {
      filename,
      partial,
      fromSeq,
      toSeq,
      sheets: [
        { name: "Cover", rows: coverRows },
        { name: "Log Entries", rows: entryRows },
        { name: "Changes", rows: changeRows },
        { name: "Provenance", rows: provenanceRows },
      ],
      csv: { filename: `${base}${partial ? "-PARTIAL" : ""}.csv`, content: csvContent },
    };
  });
}

/** Render one planned part to an .xlsx Blob (browser only — the library
 * is imported lazily so tests and SSR never touch its browser build). */
export async function renderLogWorkbookBlob(part: WorkbookPart): Promise<Blob> {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  return writeXlsxFile(
    part.sheets.map((sheet) => ({ sheet: sheet.name, data: sheet.rows }))
  ).toBlob();
}
