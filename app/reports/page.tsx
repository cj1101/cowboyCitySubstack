"use client";

/**
 * Your Reports (Phase 3 brief §9; bug-reporting design §3.4) — the
 * reporter's side of the loop. Lists the signed-in member's own
 * bug_reports (rules fence the read to their own records), each with
 * its plain-language status (BUG_STATUS_LABELS), the sheriff's note
 * when one is addressed to them, and — for duplicates — the canonical
 * report's STATUS only (mirrored onto their record by triage; never
 * its text, reporter, or attachments, RPT-h).
 *
 * While a report is `new` or `needs-info` the reporter can edit the
 * typed fields; answering a needs-info question returns it to `new`
 * (lib/bugs/reports.ts owns that transition). No other member's
 * report ever renders here, and nothing on this page pings anyone —
 * the only two notifications in the system fire on the transitions
 * into needs-info and shipped, from the triage side.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import {
  bugScreenshotUrl,
  listMyReports,
  updateReporterReport,
} from "@/lib/bugs/reports";
import {
  BUG_STATUS_LABELS,
  KIND_OPTIONS,
  SEVERITY_OPTIONS,
  type BugReport,
} from "@/lib/bugs/types";

function ReportCard({ report, onSaved }: { report: BugReport; onSaved: () => void }) {
  const editable = report.status === "new" || report.status === "needs-info";
  const [editing, setEditing] = useState(false);
  const [tryingToDo, setTryingToDo] = useState(report.tryingToDo);
  const [whatHappened, setWhatHappened] = useState(report.whatHappened);
  const [expected, setExpected] = useState(report.expected ?? "");
  const [severity, setSeverity] = useState(report.severity);
  const [kind, setKind] = useState(report.kind);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);

  useEffect(() => {
    if (!report.screenshotPath) return;
    let cancelled = false;
    bugScreenshotUrl(report.screenshotPath)
      .then((url) => {
        if (!cancelled) setScreenshot(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [report.screenshotPath]);

  return (
    <article className="glass-panel p-5 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold">{report.tryingToDo}</h2>
        <span className="text-sm text-text-muted">
          {BUG_STATUS_LABELS[report.status]}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{report.whatHappened}</p>
      {report.expected ? (
        <p className="text-sm text-text-muted">
          Expected: {report.expected}
        </p>
      ) : null}
      <p className="text-xs text-text-muted">
        Severity: {SEVERITY_OPTIONS.find((s) => s.value === report.severity)?.label ?? report.severity}
        {" · "}
        Kind: {KIND_OPTIONS.find((k) => k.value === report.kind)?.label ?? report.kind}
        {report.route ? ` · On: ${report.route}` : ""}
      </p>
      {screenshot ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={screenshot} alt="Screenshot attached to this report" className="max-w-full rounded border border-black/10" />
      ) : null}
      {report.triageNote ? (
        <div className="border-l-4 border-accent-gold/60 pl-3 py-1">
          <p className="text-xs uppercase tracking-wide text-text-muted">From the Sheriff&apos;s office</p>
          <p className="text-sm whitespace-pre-wrap">{report.triageNote}</p>
        </div>
      ) : null}
      {report.status === "duplicate" ? (
        <p className="text-sm text-text-muted">
          This was a duplicate of another report.
          {report.canonicalStatus
            ? ` That report's status: ${BUG_STATUS_LABELS[report.canonicalStatus]}.`
            : ""}
        </p>
      ) : null}
      {report.status === "shipped" ? (
        <p className="text-sm">
          Fixed{report.shippedInBuild ? ` in build ${report.shippedInBuild}` : ""}.
          {report.fixPrUrl ? (
            <>
              {" "}
              <a href={report.fixPrUrl} className="text-accent-gold hover:text-accent-gold-hover" target="_blank" rel="noreferrer">
                See the fix
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {editable && !editing ? (
        <button type="button" className="btn btn-secondary text-sm px-3 py-1" onClick={() => setEditing(true)}>
          {report.status === "needs-info" ? "Answer / update" : "Edit"}
        </button>
      ) : null}
      {editing ? (
        <form
          className="space-y-2 pt-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await updateReporterReport(report, {
                tryingToDo,
                whatHappened,
                expected: expected || undefined,
                severity,
                kind,
              });
              setEditing(false);
              onSaved();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Saving failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="block text-sm">
            What were you trying to do?
            <input className="form-input w-full mt-1" value={tryingToDo} maxLength={200} onChange={(e) => setTryingToDo(e.target.value)} required />
          </label>
          <label className="block text-sm">
            What happened instead?
            <textarea className="form-input w-full mt-1" rows={4} value={whatHappened} maxLength={4000} onChange={(e) => setWhatHappened(e.target.value)} required />
          </label>
          <label className="block text-sm">
            What did you expect? (optional)
            <textarea className="form-input w-full mt-1" rows={2} value={expected} maxLength={2000} onChange={(e) => setExpected(e.target.value)} />
          </label>
          <div className="flex gap-3 flex-wrap">
            <label className="text-sm">
              Severity{" "}
              <select className="form-input w-auto" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
                {SEVERITY_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Kind{" "}
              <select className="form-input w-auto" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>
          </div>
          {error ? <p className="text-sm" style={{ color: "#a33" }}>{error}</p> : null}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-sm px-4 py-2" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

export default function YourReportsPage() {
  const { user, loading } = useAuth();
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      setReports(await listMyReports(user.uid));
    } catch {
      setFailed(true);
    }
  }, [user]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to see your reports.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <header>
          <Link href="/" className="text-accent-gold hover:text-accent-gold-hover text-sm">
            ← Back to the dashboard
          </Link>
          <h1 className="text-3xl font-bold text-accent-gold mt-2">Your Reports</h1>
          <p className="text-text-muted mt-1">
            Everything you&apos;ve reported, and where each one stands. You&apos;ll
            get exactly two kinds of ping from a report: when the Sheriff&apos;s
            office needs more from you, and when a fix ships.
          </p>
        </header>
        {failed ? (
          <p>Your reports couldn&apos;t be read just now.</p>
        ) : reports === null ? (
          <p className="text-text-muted">Loading your reports…</p>
        ) : reports.length === 0 ? (
          <p className="text-text-muted">
            You haven&apos;t reported anything yet. The “Report a bug” link at the
            bottom of every page is the door.
          </p>
        ) : (
          reports.map((report) => (
            <ReportCard key={report.id} report={report} onSaved={() => void load()} />
          ))
        )}
      </div>
    </div>
  );
}
