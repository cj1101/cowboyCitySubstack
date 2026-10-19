/**
 * The library-agnostic workbook contract (Rafe, excel-export-design.md
 * §2.3) plus the shared normalization every Phase 3 export runs through.
 *
 * Every dataset builder produces `SheetSpec`s; the .xlsx renderer
 * (workbook.ts) and the CSV serializer (csv.ts) both consume the SAME
 * normalized cell matrix, so the two formats can never drift apart
 * (QA TC-X08 parity). Values are always literal values — no cell ever
 * contains a formula — and user-authored strings that could become a
 * spreadsheet formula are defused here, once, for both formats.
 *
 * Provenance discipline (Rafe §3.2, Dana addendum §1.4): every data tab
 * carries the fixed trailing provenance block, in this order, never
 * omitted (empty where genuinely not applicable — never dropped). A
 * figure's trust tier is conferred by which collection it came from,
 * never by a flag a writer can set.
 */

export type CellValue = string | number | boolean | Date | null;

export type FlatCell = string | number | null;

export interface SheetColumn {
  key: string;
  header: string;
  width?: number;
  type: "string" | "number" | "date" | "boolean";
  format?: string;
}

export interface SheetSpec {
  /** ≤ 31 chars (Excel limit); may not contain : \ / ? * [ ] */
  name: string;
  columns: SheetColumn[];
  rows: Record<string, CellValue>[];
}

export type TrustTier = "verified" | "owner_published" | "intel_survey";

export type SourceType =
  | "resolver"
  | "log"
  | "owner_publication"
  | "intel_survey"
  | "lore_reference"
  | "legacy_social";

/** Packaging caps (Rafe §4.2 [Proposal] numbers, Phase 2 P2-K14 adopted). */
export const MAX_ROWS_PER_TAB = 50_000;
export const MAX_ROWS_PER_WORKBOOK = 100_000;

/**
 * Defuse spreadsheet formula injection: a text cell beginning with
 * `=`, `+`, `-`, or `@` is prefixed with an apostrophe so no recipient's
 * Excel/Sheets can execute user-authored text as a formula (Rafe §2.3).
 * Applied identically to .xlsx and CSV.
 */
export function defuseCellText(text: string): string {
  if (text.length === 0) return text;
  const first = text.charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@") {
    return `'${text}`;
  }
  return text;
}

/** Coerce an arbitrary read value into the contract's cell types. */
export function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => normalizeCell(item))
      .filter((item): item is string | number | boolean | Date => item !== null)
      .map((item) => (item instanceof Date ? item.toISOString() : String(item)));
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return JSON.stringify(value);
}

/**
 * The one normalization pass both renderers share: rows aligned to the
 * sheet's columns, strings defused, missing keys → null (null-honesty:
 * an empty cell, never 0, never "unknown").
 */
export function specCellMatrix(
  spec: SheetSpec
): (string | number | boolean | Date | null)[][] {
  return spec.rows.map((row) =>
    spec.columns.map((column) => {
      const value = normalizeCell(row[column.key]);
      return typeof value === "string" ? defuseCellText(value) : value;
    })
  );
}

/** Flat matrix for CSV: Dates → ISO-8601, booleans → "true"/"false". */
export function flatCellMatrix(spec: SheetSpec): FlatCell[][] {
  return specCellMatrix(spec).map((row) =>
    row.map((cell) => {
      if (cell === null) return null;
      if (cell instanceof Date) return cell.toISOString();
      if (typeof cell === "boolean") return cell ? "true" : "false";
      return cell;
    })
  );
}

export function sheetHeaderRow(spec: SheetSpec): string[] {
  return spec.columns.map((column) => column.header);
}

// ---------------------------------------------------------------------------
// The provenance block (Rafe §3.2) — fixed trailing columns, fixed order.
// ---------------------------------------------------------------------------

export const PROVENANCE_COLUMNS: SheetColumn[] = [
  { key: "city_id", header: "city_id", width: 18, type: "string" },
  { key: "city_name", header: "city_name", width: 20, type: "string" },
  { key: "entity_id", header: "entity_id", width: 18, type: "string" },
  { key: "entity_name", header: "entity_name", width: 22, type: "string" },
  { key: "trust_tier", header: "trust_tier", width: 16, type: "string" },
  { key: "source_type", header: "source_type", width: 16, type: "string" },
  { key: "source_ref", header: "source_ref", width: 18, type: "string" },
  { key: "as_of_seq", header: "as_of_seq", width: 11, type: "number" },
  { key: "rules_version", header: "rules_version", width: 20, type: "string" },
  { key: "state_version", header: "state_version", width: 13, type: "number" },
  { key: "collected_by", header: "collected_by", width: 16, type: "string" },
  { key: "published_by", header: "published_by", width: 16, type: "string" },
  { key: "notes", header: "notes", width: 30, type: "string" },
];

export interface ProvenanceInput {
  cityId: string | null;
  cityName: string | null;
  entityId?: string | null;
  entityName?: string | null;
  trustTier: TrustTier;
  sourceType: SourceType;
  /** Log seq / resolution ID / publication ID + version — the concrete
   * pointer a reader can use to check the row. */
  sourceRef: string | null;
  asOfSeq: number;
  rulesVersion: string | null;
  /** stateVersion for state datasets, or baselineHash carried in notes. */
  stateVersion?: number | null;
  collectedBy?: string | null;
  publishedBy?: string | null;
  notes?: string | null;
}

export function provenanceValues(input: ProvenanceInput): Record<string, CellValue> {
  return {
    city_id: input.cityId,
    city_name: input.cityName,
    entity_id: input.entityId ?? null,
    entity_name: input.entityName ?? null,
    trust_tier: input.trustTier,
    source_type: input.sourceType,
    source_ref: input.sourceRef,
    as_of_seq: input.asOfSeq,
    rules_version: input.rulesVersion,
    state_version: input.stateVersion ?? null,
    collected_by: input.collectedBy ?? null,
    published_by: input.publishedBy ?? null,
    notes: input.notes ?? null,
  };
}

/** Dataset columns + the provenance block, in sheet order. */
export function withProvenance(columns: SheetColumn[]): SheetColumn[] {
  return [...columns, ...PROVENANCE_COLUMNS];
}

// ---------------------------------------------------------------------------
// Workbook assembly: Cover → Summary → data tabs → Definitions (Rafe §3.1).
// ---------------------------------------------------------------------------

export interface ColumnDefinition {
  tab: string;
  column: string;
  meaning: string;
  unit: string | null;
  trustTier: string;
  source: string;
}

export interface WorkbookTruncation {
  requested: string;
  included: string;
  omittedCount: number;
  reason: string;
}

export interface WorkbookMeta {
  title: string;
  scopeLabel: string;
  exportedAtIso: string;
  /** Display label only — never a uid or email (TC-X10 metadata hygiene
   * beyond what the Cover itself declares). */
  exportedByLabel: string;
  /** The one Log head the whole workbook is consistent with. */
  asOfSeq: number;
  rulesVersion: string | null;
  containsOwnerPublished: boolean;
  truncation?: WorkbookTruncation | null;
  /** "Part k of K — seq range A–B of A–Z requested" when split. */
  partLabel?: string | null;
}

export interface PlannedWorkbook {
  /** Filename without extension, per Rafe §5.2 convention. */
  filenameBase: string;
  /** True only when the user explicitly limited the export. */
  partial: boolean;
  meta: WorkbookMeta;
  sheets: SheetSpec[];
}

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportError";
  }
}

/** The two sentences the addendum fixes verbatim for every Cover. */
export const TRUST_LEGEND_LINE =
  "Owner-published figures are claims by their publisher and are not verified by the sim. Verified figures are derived from sim records / the Log.";
export const CONVENIENCE_COPY_LINE =
  "An exported file is a convenience copy, not evidence; disputes are settled against the Log.";
export const SHEETS_COPY_LINE =
  "Downloads an Excel file. To use it in Google Sheets, download and import it there yourself.";

const KEY_VALUE_COLUMNS: SheetColumn[] = [
  { key: "key", header: "key", width: 24, type: "string" },
  { key: "value", header: "value", width: 110, type: "string" },
];

function keyValueSheet(
  name: string,
  pairs: [string, string | number | null][]
): SheetSpec {
  return {
    name,
    columns: KEY_VALUE_COLUMNS,
    rows: pairs.map(([key, value]) => ({ key, value })),
  };
}

export function buildCoverSheet(
  meta: WorkbookMeta,
  dataSheets: SheetSpec[]
): SheetSpec {
  const pairs: [string, string | number | null][] = [
    ["title", meta.title],
    ["scope", meta.scopeLabel],
    ["exported_at", meta.exportedAtIso],
    ["exported_by", meta.exportedByLabel],
    ["as_of_seq", meta.asOfSeq],
    ["rules_version", meta.rulesVersion],
    [
      "tabs",
      dataSheets.map((sheet) => `${sheet.name} (${sheet.rows.length} rows)`).join("; "),
    ],
    [
      "contains_owner_published",
      meta.containsOwnerPublished
        ? "YES — this workbook contains owner-published claims, on their own tab(s), labeled as claims."
        : "No — every figure in this workbook is verified sim data.",
    ],
    ["trust_legend", TRUST_LEGEND_LINE],
    ["convenience_copy", CONVENIENCE_COPY_LINE],
    ["google_sheets", SHEETS_COPY_LINE],
    [
      "point_in_time",
      "Visibility is evaluated at export time, under the exporter's own permissions. A file already downloaded cannot be recalled.",
    ],
  ];
  if (meta.partLabel) pairs.push(["part", meta.partLabel]);
  if (meta.truncation) {
    pairs.push([
      "TRUNCATED",
      `Requested: ${meta.truncation.requested}. Included: ${meta.truncation.included}. Omitted: ${meta.truncation.omittedCount} rows. Reason: ${meta.truncation.reason}.`,
    ]);
  }
  return keyValueSheet("Cover", pairs);
}

export function buildSummarySheet(dataSheets: SheetSpec[]): SheetSpec {
  return {
    name: "Summary",
    columns: [
      { key: "tab", header: "tab", width: 24, type: "string" },
      { key: "visible_rows", header: "visible_rows", width: 14, type: "number" },
      {
        key: "note",
        header: "note",
        width: 80,
        type: "string",
      },
    ],
    rows: dataSheets.map((sheet) => ({
      tab: sheet.name,
      visible_rows: sheet.rows.length,
      note: "Counts are of rows visible to the exporter only. Nothing hidden is counted.",
    })),
  };
}

export function buildDefinitionsSheet(
  definitions: ColumnDefinition[]
): SheetSpec {
  return {
    name: "Definitions",
    columns: [
      { key: "tab", header: "tab", width: 20, type: "string" },
      { key: "column", header: "column", width: 22, type: "string" },
      { key: "meaning", header: "meaning", width: 70, type: "string" },
      { key: "unit", header: "unit", width: 16, type: "string" },
      { key: "trust_tier", header: "trust_tier", width: 16, type: "string" },
      { key: "source", header: "source", width: 30, type: "string" },
    ],
    rows: definitions.map((definition) => ({
      tab: definition.tab,
      column: definition.column,
      meaning: definition.meaning,
      unit: definition.unit,
      trust_tier: definition.trustTier,
      source: definition.source,
    })),
  };
}

/** Provenance-block definitions, appended to every workbook's Definitions. */
export function provenanceDefinitions(tab: string): ColumnDefinition[] {
  const base: [string, string][] = [
    ["city_id", "Subject city (faction) ID the row belongs to."],
    ["city_name", "Subject city display name at export time."],
    ["entity_id", "Entity the row describes, where the row is entity-scoped."],
    ["entity_name", "Entity display name at export time."],
    ["trust_tier", "verified | owner_published | intel_survey — conferred by the source collection, never by a writer-set flag."],
    ["source_type", "resolver | log | owner_publication | intel_survey | lore_reference | legacy_social."],
    ["source_ref", "Concrete pointer to check the row: Log seq, resolution ID, or publication ID + version."],
    ["as_of_seq", "The Log head this workbook is consistent with."],
    ["rules_version", "Sim rules version stamped on the world at export time."],
    ["state_version", "State version of the source document, where the dataset is state."],
    ["collected_by", "Collector label, for intel/survey rows."],
    ["published_by", "Publisher label, for owner-published rows."],
    ["notes", "Row-level notes, including the baseline hash for state datasets."],
  ];
  return base.map(([column, meaning]) => ({
    tab,
    column,
    meaning,
    unit: null,
    trustTier: "all",
    source: "Rafe §3.2 provenance block",
  }));
}

/**
 * Assemble a complete workbook: Cover → Summary → data tabs →
 * Definitions. Also enforces the packaging caps (Rafe §4.2/§4.3):
 * an oversized data tab is split into contiguous `Name (k)` tabs —
 * never silently truncated — and a workbook still over the total cap
 * fails closed with an honest error instead of producing a file that
 * looks complete.
 */
export function assembleWorkbook(args: {
  filenameBase: string;
  partial?: boolean;
  meta: WorkbookMeta;
  dataSheets: SheetSpec[];
  definitions: ColumnDefinition[];
}): PlannedWorkbook {
  const splitSheets: SheetSpec[] = [];
  for (const sheet of args.dataSheets) {
    if (sheet.rows.length <= MAX_ROWS_PER_TAB) {
      splitSheets.push(sheet);
      continue;
    }
    const chunks = Math.ceil(sheet.rows.length / MAX_ROWS_PER_TAB);
    for (let i = 0; i < chunks; i += 1) {
      splitSheets.push({
        ...sheet,
        name: `${sheet.name.slice(0, 24)} (${i + 1})`,
        rows: sheet.rows.slice(i * MAX_ROWS_PER_TAB, (i + 1) * MAX_ROWS_PER_TAB),
      });
    }
  }
  const totalRows = splitSheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  if (totalRows > MAX_ROWS_PER_WORKBOOK) {
    throw new ExportError(
      `This export would contain ${totalRows} rows, over the ${MAX_ROWS_PER_WORKBOOK}-row workbook cap. Narrow the scope (one city instead of the realm) and try again — no file was produced.`
    );
  }
  return {
    filenameBase: args.filenameBase,
    partial: args.partial === true,
    meta: args.meta,
    sheets: [
      buildCoverSheet(args.meta, splitSheets),
      buildSummarySheet(splitSheets),
      ...splitSheets,
      buildDefinitionsSheet(args.definitions),
    ],
  };
}

/** `<scope>-export-seq<asOfSeq>-<yyyymmdd>` per Rafe §5.2. */
export function exportFilenameBase(
  scope: string,
  asOfSeq: number,
  exportedAtIso: string,
  partial = false
): string {
  const date = exportedAtIso.slice(0, 10).replace(/-/g, "");
  const safeScope = scope
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${safeScope}-export-seq${asOfSeq}-${date}${partial ? "-PARTIAL" : ""}`;
}
