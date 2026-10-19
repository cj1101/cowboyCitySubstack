/**
 * Runner: export of a member's OWN trust assessments (June §10.5).
 * The requester and the assessments' owner are the same person by
 * construction here — this runner takes one uid and reads that uid's
 * own doc. A view shared WITH the requester is deliberately not
 * exportable (P3-K9): for that path, use buildAssessmentsWorkbook
 * directly and it will refuse — the refusal is structural, tested,
 * and stays in the builder so no future caller can widen it.
 */

import { buildAssessmentsWorkbook } from "./datasets/assessmentsWorkbook";
import { deliverWorkbook, type DeliveredFile, type ExportFormat } from "./download";
import {
  assertExportAllowed,
  fetchWorldContext,
  loadExportRequester,
} from "./fetchCityExport";
import { attributedRows } from "@/lib/trust/assessments";
import { loadOwnTrustAssessments } from "@/lib/trust/store";

export type { ExportFormat };

export async function downloadOwnAssessmentsWorkbook(args: {
  uid: string;
  format: ExportFormat;
}): Promise<DeliveredFile> {
  const requester = await loadExportRequester(args.uid);
  assertExportAllowed(requester);
  const world = await fetchWorldContext();
  const docData = await loadOwnTrustAssessments(args.uid);
  const rows = attributedRows(docData, requester.label);
  const workbook = buildAssessmentsWorkbook({
    viewerUid: args.uid,
    ownerUid: args.uid,
    ownerLabel: requester.label,
    marks: rows.map((row) => ({
      publicationId: row.publicationId,
      stance: row.mark.stance,
      note: row.mark.note,
      subjectCityId: row.mark.subjectCityId,
      subjectCityName: null,
      updatedAtIso: row.mark.updatedAtIso,
    })),
    ctx: {
      asOfSeq: world.asOfSeq,
      rulesVersion: world.rulesVersion,
      exportedAtIso: new Date().toISOString(),
      exportedByLabel: requester.label,
    },
  });
  return deliverWorkbook(workbook, args.format);
}
