import {
  collection,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { getClientDb, getClientStorage } from "@/lib/firebase";
import { notify } from "@/lib/firestore/notifications";
import type { NotificationType } from "@/lib/types";
import { searchTokensFrom } from "@/lib/search/tokens";
import { compressImage } from "@/lib/storage/media";
import { getBuildId } from "@/lib/bugs/build-info";
import type { CapturedBugContext } from "@/lib/bugs/context";
import {
  BUG_FIELD_LIMITS,
  type BugReport,
  type BugReportKind,
  type BugReportSeverity,
  type BugReportStatus,
} from "@/lib/bugs/types";

const COLLECTION = "bug_reports";

export function toBugReport(id: string, data: Record<string, unknown>): BugReport {
  return {
    id,
    tryingToDo: (data.tryingToDo as string) || "",
    whatHappened: (data.whatHappened as string) || "",
    expected: (data.expected as string) || undefined,
    severity: (data.severity as BugReportSeverity) || "annoying",
    kind: (data.kind as BugReportKind) || "not-sure",
    screenshotPath: (data.screenshotPath as string) || undefined,
    route: (data.route as string) || undefined,
    surface: (data.surface as BugReport["surface"]) || undefined,
    entityRef: (data.entityRef as string) || undefined,
    buildId: (data.buildId as string) || undefined,
    asOfSeq: typeof data.asOfSeq === "number" ? data.asOfSeq : undefined,
    browserFamily: (data.browserFamily as string) || undefined,
    osFamily: (data.osFamily as string) || undefined,
    viewport: (data.viewport as BugReport["viewport"]) || undefined,
    reporterUid: (data.reporterUid as string) || "",
    reporterName: (data.reporterName as string) || "",
    createdAt: data.createdAt as Timestamp | undefined,
    clientAt: data.clientAt as Timestamp | undefined,
    status: (data.status as BugReportStatus) || "new",
    triageNote: (data.triageNote as string) || undefined,
    duplicateOf: (data.duplicateOf as string) || undefined,
    canonicalStatus: (data.canonicalStatus as BugReportStatus) || undefined,
    searchTokens: Array.isArray(data.searchTokens) ? (data.searchTokens as string[]) : [],
    fixBranch: (data.fixBranch as string) || undefined,
    fixPrUrl: (data.fixPrUrl as string) || undefined,
    previewUrl: (data.previewUrl as string) || undefined,
    shippedInBuild: (data.shippedInBuild as string) || undefined,
    updatedAt: data.updatedAt as Timestamp | undefined,
  };
}

/** Pre-generate a report id so a screenshot can be uploaded before the record exists. */
export function newBugReportId(): string {
  return doc(collection(getClientDb(), COLLECTION)).id;
}

/**
 * Upload the reporter's optional screenshot. Stored under the design's
 * Storage family `bug-reports/{uid}/{reportId}/…`; the record keeps the
 * path, never a URL. Never auto-captured — the file exists only because the
 * reporter picked it in the dialog.
 */
export async function uploadBugScreenshot(
  uid: string,
  reportId: string,
  file: File
): Promise<string> {
  const prepared = await compressImage(file);
  const path = `bug-reports/${uid}/${reportId}/screenshot.jpg`;
  await uploadBytes(storageRef(getClientStorage(), path), prepared, {
    contentType: prepared.type || "image/jpeg",
  });
  return path;
}

/** Resolve a stored screenshot path to a viewable URL (reporter/triage views only). */
export async function bugScreenshotUrl(path: string): Promise<string> {
  return getDownloadURL(storageRef(getClientStorage(), path));
}

export interface NewBugReportInput {
  tryingToDo: string;
  whatHappened: string;
  expected?: string;
  severity: BugReportSeverity;
  kind: BugReportKind;
  screenshotPath?: string;
  /** The dialog's technical-details consent. When false, NO context fields are written at all (RPT-f). */
  includeContext: boolean;
  context: CapturedBugContext;
}

/**
 * Create a report. The reporter is taken from the caller's authenticated
 * identity — rules require reporterUid == request.auth.uid, status "new",
 * and the Appendix B field allowlist, so anything extra here fails closed.
 */
export async function createBugReport(
  reporter: { uid: string; displayName: string },
  reportId: string,
  input: NewBugReportInput
): Promise<void> {
  const payload: Record<string, unknown> = {
    tryingToDo: input.tryingToDo.trim().slice(0, BUG_FIELD_LIMITS.tryingToDo),
    whatHappened: input.whatHappened.trim().slice(0, BUG_FIELD_LIMITS.whatHappened),
    severity: input.severity,
    kind: input.kind,
    reporterUid: reporter.uid,
    reporterName: reporter.displayName.slice(0, BUG_FIELD_LIMITS.reporterName),
    status: "new",
    searchTokens: searchTokensFrom({
      title: input.tryingToDo,
      body: input.includeContext ? input.context.route : "",
    }),
    createdAt: serverTimestamp(),
  };
  const expected = input.expected?.trim();
  if (expected) payload.expected = expected.slice(0, BUG_FIELD_LIMITS.expected);
  if (input.screenshotPath) payload.screenshotPath = input.screenshotPath;

  if (input.includeContext) {
    const context = input.context;
    payload.route = context.route;
    payload.surface = context.surface;
    if (context.entityRef) payload.entityRef = context.entityRef;
    payload.buildId = getBuildId().slice(0, BUG_FIELD_LIMITS.buildId);
    if (typeof context.asOfSeq === "number") payload.asOfSeq = context.asOfSeq;
    payload.browserFamily = context.browserFamily;
    payload.osFamily = context.osFamily;
    payload.viewport = context.viewport;
    payload.clientAt = Timestamp.fromDate(context.clientAt);
  }

  await setDoc(doc(getClientDb(), COLLECTION, reportId), payload);
}

/** The reporter's own reports, newest first ("Your reports", design §3.5). */
export async function listMyReports(uid: string): Promise<BugReport[]> {
  const snap = await getDocs(
    query(
      collection(getClientDb(), COLLECTION),
      where("reporterUid", "==", uid),
      orderBy("createdAt", "desc"),
      limit(100)
    )
  );
  return snap.docs.map((item) => toBugReport(item.id, item.data()));
}

/** Sheriff triage queue: most recent reports across all statuses. */
export async function listTriageReports(max = 200): Promise<BugReport[]> {
  const snap = await getDocs(
    query(collection(getClientDb(), COLLECTION), orderBy("createdAt", "desc"), limit(max))
  );
  return snap.docs.map((item) => toBugReport(item.id, item.data()));
}

export async function listReportsByStatus(status: BugReportStatus): Promise<BugReport[]> {
  const snap = await getDocs(
    query(
      collection(getClientDb(), COLLECTION),
      where("status", "==", status),
      orderBy("createdAt", "desc"),
      limit(200)
    )
  );
  return snap.docs.map((item) => toBugReport(item.id, item.data()));
}

/**
 * Reporter edit: typed fields only, and only while the report is in
 * new / needs-info (rules enforce the same fence). Answering a needs-info
 * question returns the report to "new" so it re-enters the queue — which is
 * also what makes a later needs-info transition a new cycle for the
 * notification rule (RPT-d: at most one needs-info ping per cycle).
 */
export async function updateReporterReport(
  report: BugReport,
  fields: {
    tryingToDo: string;
    whatHappened: string;
    expected?: string;
    severity: BugReportSeverity;
    kind: BugReportKind;
  }
): Promise<void> {
  const payload: Record<string, unknown> = {
    tryingToDo: fields.tryingToDo.trim().slice(0, BUG_FIELD_LIMITS.tryingToDo),
    whatHappened: fields.whatHappened.trim().slice(0, BUG_FIELD_LIMITS.whatHappened),
    severity: fields.severity,
    kind: fields.kind,
    searchTokens: searchTokensFrom({
      title: fields.tryingToDo,
      body: report.route || "",
    }),
  };
  const expected = fields.expected?.trim();
  if (expected) payload.expected = expected.slice(0, BUG_FIELD_LIMITS.expected);
  if (report.status === "needs-info") payload.status = "new";
  await updateDoc(doc(getClientDb(), COLLECTION, report.id), payload);
}

export interface SheriffReportPatch {
  status?: BugReportStatus;
  triageNote?: string;
  severity?: BugReportSeverity;
  duplicateOf?: string | null;
  canonicalStatus?: BugReportStatus | null;
  fixBranch?: string;
  fixPrUrl?: string;
  previewUrl?: string;
  shippedInBuild?: string;
}

/**
 * The ONLY two push events a report may ever produce (design §3.5, RPT-d):
 * needs-info (the reporter must act) and shipped (the loop closes). Both go
 * through the existing notify() substrate with the design's new report kind:
 * type "report", kind "needs-info" | "shipped", href "/reports". Every other
 * transition is pull-only — the reporter sees it on /reports, unpinged.
 *
 * NOTE for the Build Lead: "report" joins the NotificationType union in
 * lib/types.ts and the type allowlist in the firestore.rules notifications
 * block — both are one-line amendments carried in the rules snippet file.
 * Until they land, this cast keeps the call type-safe against the old union
 * and the fallback label in the notifications UI reads "Notice".
 */
async function notifyReporter(report: BugReport, kind: "needs-info" | "shipped"): Promise<void> {
  await notify({
    recipientUid: report.reporterUid,
    type: "report" as NotificationType,
    kind,
    summary:
      kind === "needs-info"
        ? "We need a bit more from you about something you reported."
        : "Fixed — something you reported has been fixed.",
    href: "/reports",
  }).catch(() => undefined);
}

/**
 * Sheriff triage write: status, notes, fix links, duplicate linkage.
 * Fires a notification ONLY when the status transitions INTO needs-info or
 * INTO shipped from a different status — each entry into the state is one
 * event, so a report's whole lifecycle stays enumerable (RPT-d).
 * Fix references are repo facts recorded ON the report; report content is
 * never written anywhere else [CJ no-mirror ruling].
 */
export async function sheriffUpdateReport(
  report: BugReport,
  patch: SheriffReportPatch,
  sheriffUid: string
): Promise<void> {
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (patch.status) payload.status = patch.status;
  if (patch.triageNote !== undefined) {
    payload.triageNote = patch.triageNote.slice(0, BUG_FIELD_LIMITS.triageNote);
  }
  if (patch.severity) payload.severity = patch.severity;
  if (patch.duplicateOf !== undefined) {
    if (patch.duplicateOf) payload.duplicateOf = patch.duplicateOf;
  }
  if (patch.canonicalStatus !== undefined) {
    if (patch.canonicalStatus) payload.canonicalStatus = patch.canonicalStatus;
  }
  if (patch.fixBranch !== undefined) payload.fixBranch = patch.fixBranch.slice(0, BUG_FIELD_LIMITS.fixBranch);
  if (patch.fixPrUrl !== undefined) payload.fixPrUrl = patch.fixPrUrl.slice(0, BUG_FIELD_LIMITS.url);
  if (patch.previewUrl !== undefined) payload.previewUrl = patch.previewUrl.slice(0, BUG_FIELD_LIMITS.url);
  if (patch.shippedInBuild !== undefined) {
    payload.shippedInBuild = patch.shippedInBuild.slice(0, BUG_FIELD_LIMITS.buildId);
  }
  void sheriffUid; // Actor identity is enforced by rules (isAdmin); kept for call-site clarity.

  await updateDoc(doc(getClientDb(), COLLECTION, report.id), payload);

  const nextStatus = patch.status;
  if (nextStatus && nextStatus !== report.status) {
    if (nextStatus === "needs-info") await notifyReporter(report, "needs-info");
    if (nextStatus === "shipped") await notifyReporter(report, "shipped");
    // Keep duplicates' mirrored canonical status fresh (best effort): the
    // duplicate's reporter may read only the duplicate record (RPT-h).
    try {
      const dupes = await getDocs(
        query(collection(getClientDb(), COLLECTION), where("duplicateOf", "==", report.id))
      );
      if (!dupes.empty) {
        const batch = writeBatch(getClientDb());
        dupes.docs.forEach((dupe) =>
          batch.update(dupe.ref, { canonicalStatus: nextStatus, updatedAt: serverTimestamp() })
        );
        await batch.commit();
      }
    } catch {
      // Mirror refresh is a courtesy; the triage write above already landed.
    }
  }
}
