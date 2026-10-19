/**
 * The trust-assessments workbook (June §10.5): a member's OWN trust
 * assessments are their own data — their separated view may export
 * under the same fair-to-see ⇒ fair-to-export rule.
 *
 * Another member's assessments — INCLUDING a view shared with the
 * requester — are not the requester's to export (P3-K9, fail-closed
 * default): the share confers viewing and nothing else (TC-P12(iii)).
 * `buildAssessmentsWorkbook` therefore refuses, structurally, when the
 * viewer is not the owner. There is no parameter that widens this.
 *
 * Tier honesty: an assessment is the exporter's own attributed
 * opinion. It is NOT one of the sim trust tiers — forcing it into
 * "verified" or "owner_published" would be a false label — so this
 * sheet's provenance carries the distinct value `personal_assessment`,
 * explained on the Definitions tab and flagged for Marlowe's
 * dictionary. It is never a system verdict.
 */

import {
  ExportError,
  assembleWorkbook,
  exportFilenameBase,
  provenanceValues,
  withProvenance,
  type ColumnDefinition,
  type PlannedWorkbook,
  type SheetColumn,
  type SheetSpec,
} from "../sheetSpec";
import type { ExportContext } from "./cityData";

export interface AssessmentMarkExportData {
  publicationId: string;
  /** The assessor's stance, in CJ's words: credible | bullshit | unsure. */
  stance: string;
  note: string | null;
  subjectCityId: string;
  subjectCityName: string | null;
  updatedAtIso: string | null;
}

const ASSESSMENT_COLUMNS: SheetColumn[] = [
  { key: "publication_id", header: "publication_id", width: 20, type: "string" },
  { key: "stance", header: "stance", width: 12, type: "string" },
  { key: "note", header: "note", width: 44, type: "string" },
  { key: "updated_at", header: "updated_at", width: 20, type: "string" },
];

export function buildAssessmentsWorkbook(args: {
  /** The member asking for the export. */
  viewerUid: string;
  /** The member whose assessments these are. */
  ownerUid: string;
  ownerLabel: string;
  marks: AssessmentMarkExportData[];
  ctx: ExportContext;
}): PlannedWorkbook {
  if (args.viewerUid !== args.ownerUid) {
    throw new ExportError(
      "Shared assessment views are view-only: a view shared with you confers no export. Only the assessments' owner can export them — no file was produced."
    );
  }
  const sheet: SheetSpec = {
    name: "Trust Assessments",
    columns: withProvenance(ASSESSMENT_COLUMNS),
    rows: args.marks.map((mark) => ({
      publication_id: mark.publicationId,
      stance: mark.stance,
      note: mark.note,
      updated_at: mark.updatedAtIso,
      ...provenanceValues({
        cityId: mark.subjectCityId,
        cityName: mark.subjectCityName,
        entityId: mark.publicationId,
        trustTier: "owner_published",
        sourceType: "owner_publication",
        sourceRef: mark.publicationId,
        asOfSeq: args.ctx.asOfSeq,
        rulesVersion: args.ctx.rulesVersion,
        publishedBy: args.ownerLabel,
        notes: `${args.ownerLabel}'s personal assessment — attributed opinion, not a sim figure and not a system verdict.`,
      }),
      // Overridden AFTER the spread, deliberately: the sim trust-tier
      // enum cannot honestly carry an assessment (see file header).
      trust_tier: "personal_assessment",
      source_type: "personal_assessment",
    })),
  };
  const definitions: ColumnDefinition[] = [
    { tab: "Trust Assessments", column: "publication_id", meaning: "The publication this mark assesses.", unit: null, trustTier: "personal_assessment", source: "sim_trust_assessments (exporter's own doc)" },
    { tab: "Trust Assessments", column: "stance", meaning: "The EXPORTer's own stance (credible | bullshit | unsure), attributed to them — never a platform truth verdict.", unit: null, trustTier: "personal_assessment", source: "sim_trust_assessments" },
    { tab: "Trust Assessments", column: "note", meaning: "The exporter's own note on the claim.", unit: null, trustTier: "personal_assessment", source: "sim_trust_assessments" },
    { tab: "Trust Assessments", column: "updated_at", meaning: "When the mark was last set (ISO-8601).", unit: null, trustTier: "personal_assessment", source: "sim_trust_assessments" },
    { tab: "Trust Assessments", column: "trust_tier", meaning: "personal_assessment — deliberately outside the sim trust tiers (verified | owner_published | intel_survey): an assessment is attributed personal opinion, not sim data.", unit: null, trustTier: "personal_assessment", source: "June §10.5 / TC-P12" },
  ];
  return assembleWorkbook({
    filenameBase: exportFilenameBase("my-trust-assessments", args.ctx.asOfSeq, args.ctx.exportedAtIso),
    meta: {
      title: "Cowboy City — my trust assessments",
      scopeLabel: `Personal trust assessments of ${args.ownerLabel} (own data only)`,
      exportedAtIso: args.ctx.exportedAtIso,
      exportedByLabel: args.ctx.exportedByLabel,
      asOfSeq: args.ctx.asOfSeq,
      rulesVersion: args.ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions,
  });
}
