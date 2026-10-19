import type { Timestamp } from "firebase/firestore";

/**
 * Bug reports — site-operations data, not world data (bug-reporting design
 * §1.5). A report is never a Sim Log entry, never resolver input, and never
 * part of a member data export. Report content lives only in the
 * `bug_reports` Firestore collection and CJ's Drive backup — it is never
 * mirrored to GitHub in any form [CJ ruling, 2026-10-17].
 *
 * The record shape is Appendix B of workstreams/bug-reporting-and-cd-design.md,
 * with one flagged addition: `canonicalStatus` (see below).
 */

export type BugReportStatus =
  | "new"
  | "seen"
  | "needs-info"
  | "accepted"
  | "fixed-in-preview"
  | "shipped"
  | "duplicate"
  | "not-a-bug"
  | "wont-fix";

export type BugReportSeverity = "stops-me" | "its-wrong" | "annoying" | "tiny";

export type BugReportKind =
  | "looks-broken"
  | "number-wrong"
  | "didnt-save"
  | "wont-load"
  | "text"
  | "other"
  | "not-sure";

export type BugReportSurface =
  | "dashboard"
  | "city"
  | "log"
  | "forum"
  | "maps"
  | "market"
  | "wiki"
  | "other";

export interface BugReport {
  id: string;

  // Reporter-written (create; editable by reporter while status is new | needs-info)
  tryingToDo: string; // form field 1 (≤ 200 chars)
  whatHappened: string; // form field 2 (≤ 4000 chars)
  expected?: string; // form field 3 (≤ 2000 chars)
  severity: BugReportSeverity; // form field 4
  kind: BugReportKind; // form field 5
  screenshotPath?: string; // Storage path bug-reports/{uid}/{reportId}/… — path, not URL

  // Auto-context — PRESENT ONLY IF the reporter left technical details ON
  // (design §2.2/§2.3, QA hook RPT-f: absent, never nulled-and-kept)
  route?: string;
  surface?: BugReportSurface;
  entityRef?: string; // slug/id from route params — a reference, never content
  buildId?: string;
  asOfSeq?: number; // sim surfaces only
  browserFamily?: string; // "Safari" — parsed family, not raw UA
  osFamily?: string; // "iOS"
  viewport?: { w: number; h: number };

  // Identity & time (always present — a report with no reporter cannot close its loop)
  reporterUid: string;
  reporterName: string; // displayName snapshot at filing (never an email)
  createdAt?: Timestamp; // serverTimestamp()
  clientAt?: Timestamp; // reporter's device clock, diagnostic only

  // Triage-written (sheriff identities ONLY)
  status: BugReportStatus; // starts "new"
  triageNote?: string; // note addressed to the reporter (needs-info question, close reason)
  duplicateOf?: string; // canonical reportId, when status = "duplicate"
  /**
   * ADDITION beyond Appendix B, flagged for the Build Lead: the canonical
   * report's status, copied onto a duplicate by the triage panel. Rules deny
   * a reporter any read of another member's report, so the canonical's status
   * can only reach the duplicate's reporter (design §3.4 / RPT-h: "shows the
   * canonical report's status and none of its text, reporter identity, or
   * attachments") if it is mirrored onto the duplicate record itself. The
   * panel refreshes it whenever it touches either record. Triage-written only.
   */
  canonicalStatus?: BugReportStatus;
  searchTokens: string[]; // route + title tokens for the dedup strip (§3.4)

  // Fix links (triage-written by the team — repo references recorded ON the
  // report; nothing flows the other way [CJ no-mirror ruling])
  fixBranch?: string;
  fixPrUrl?: string;
  previewUrl?: string; // Vercel preview carrying the fix
  shippedInBuild?: string; // buildId of the production deploy that shipped the fix
  updatedAt?: Timestamp; // serverTimestamp() on any triage write
}

/** Reporter-visible plain language for each internal status (design §3.4). */
export const BUG_STATUS_LABELS: Record<BugReportStatus, string> = {
  new: "Received",
  seen: "We've seen it",
  "needs-info": "We need a bit more from you",
  accepted: "We're working on it",
  "fixed-in-preview": "Fixed — try it on the preview",
  shipped: "Fixed",
  duplicate: "Same as another report",
  "not-a-bug": "Closed — not a bug",
  "wont-fix": "Closed — not planned",
};

export const BUG_STATUSES: BugReportStatus[] = [
  "new",
  "seen",
  "needs-info",
  "accepted",
  "fixed-in-preview",
  "shipped",
  "duplicate",
  "not-a-bug",
  "wont-fix",
];

/**
 * Form field 4's plain-language options, in display order. The design's
 * default is the third ("annoying"). Reporters never see the word "severity"
 * or the triage tags these map to.
 */
export const SEVERITY_OPTIONS: { value: BugReportSeverity; label: string; triageTag: string }[] = [
  { value: "stops-me", label: "It stops me — I can't do what I came to do", triageTag: "sev: blocker" },
  { value: "its-wrong", label: "It's wrong — a number or text looks incorrect, but I can carry on", triageTag: "sev: major" },
  { value: "annoying", label: "It's annoying — I can work around it", triageTag: "sev: minor" },
  { value: "tiny", label: "It's tiny — a typo or a little glitch", triageTag: "sev: cosmetic" },
];

export const SEVERITY_TRIAGE_TAG: Record<BugReportSeverity, string> = Object.fromEntries(
  SEVERITY_OPTIONS.map((option) => [option.value, option.triageTag])
) as Record<BugReportSeverity, string>;

export const KIND_OPTIONS: { value: BugReportKind; label: string }[] = [
  { value: "looks-broken", label: "Page looks broken" },
  { value: "number-wrong", label: "A number looks wrong" },
  { value: "didnt-save", label: "Something I did didn't save" },
  { value: "wont-load", label: "Page won't load or is very slow" },
  { value: "text", label: "Text or spelling" },
  { value: "other", label: "Something else" },
  { value: "not-sure", label: "Not sure" },
];

/** Field caps, enforced in the dialog and again in firestore.rules. */
export const BUG_FIELD_LIMITS = {
  tryingToDo: 200,
  whatHappened: 4000,
  expected: 2000,
  triageNote: 2000,
  reporterName: 100,
  route: 300,
  buildId: 80,
  fixBranch: 200,
  url: 500,
} as const;
