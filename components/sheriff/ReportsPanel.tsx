"use client";

/**
 * Sheriff Reports panel (Phase 3 brief §9; bug-reporting design
 * §3.4/§3.6) — the triage side of the bug-report loop. Mounted on
 * the Sheriff's dashboard; the page's own gate (isSheriff) fences the
 * surface, and the §11.4 rules fence every write again server-side.
 *
 * Triage edits status / note-to-reporter / severity / duplicate
 * linkage / fix references via lib/bugs/reports.ts
 * (sheriffUpdateReport) — which is also where the system's ONLY two
 * notifications fire (transitions into needs-info and shipped). Fix
 * references are recorded ON the report; report content is never
 * written anywhere else (CJ's no-mirror ruling).
 *
 * BACKUP (§3.6): "Back up now" builds the design's on-demand archive
 * in the browser — the exact `bug-reports-backup/1` JSON the fabric
 * job writes (restore source of truth; IDs + timestamps preserved)
 * plus its manifest entry with the JSON's SHA-256 — and downloads
 * both as one zip for the Sheriff to drop into the Drive folder
 * "Cowboy City — Bug Report Backups", the store of record. The
 * panel states plainly that it cannot read that folder from here:
 * the last-backup time lives in the folder's manifest.json, and no
 * copy is claimed to exist until a run's files are in the folder.
 * The scheduled weekly fabric job is Phase 9-adjacent, not Phase 3.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  bugScreenshotUrl,
  listTriageReports,
  sheriffUpdateReport,
} from "@/lib/bugs/reports";
import {
  BUG_STATUSES,
  BUG_STATUS_LABELS,
  KIND_OPTIONS,
  SEVERITY_OPTIONS,
  type BugReport,
  type BugReportStatus,
} from "@/lib/bugs/types";
import { zipStore } from "@/lib/export/zip";

function TriageCard({
  report,
  allReports,
  onSaved,
}: {
  report: BugReport;
  allReports: BugReport[];
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [status, setStatus] = useState<BugReportStatus>(report.status);
  const [severity, setSeverity] = useState(report.severity);
  const [triageNote, setTriageNote] = useState(report.triageNote ?? "");
  const [duplicateOf, setDuplicateOf] = useState(report.duplicateOf ?? "");
  const [fixBranch, setFixBranch] = useState(report.fixBranch ?? "");
  const [fixPrUrl, setFixPrUrl] = useState(report.fixPrUrl ?? "");
  const [previewUrl, setPreviewUrl] = useState(report.previewUrl ?? "");
  const [shippedInBuild, setShippedInBuild] = useState(report.shippedInBuild ?? "");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
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

  const save = async () => {
    if (!user) return;
    setBusy(true);
    setNote("");
    try {
      const canonical = duplicateOf
        ? allReports.find((r) => r.id === duplicateOf)
        : undefined;
      await sheriffUpdateReport(
        report,
        {
          ...(status !== report.status ? { status } : {}),
          ...(severity !== report.severity ? { severity } : {}),
          ...(triageNote !== (report.triageNote ?? "") ? { triageNote } : {}),
          ...(duplicateOf !== (report.duplicateOf ?? "")
            ? {
                duplicateOf: duplicateOf || null,
                canonicalStatus: canonical ? canonical.status : null,
              }
            : {}),
          ...(fixBranch !== (report.fixBranch ?? "") ? { fixBranch } : {}),
          ...(fixPrUrl !== (report.fixPrUrl ?? "") ? { fixPrUrl } : {}),
          ...(previewUrl !== (report.previewUrl ?? "") ? { previewUrl } : {}),
          ...(shippedInBuild !== (report.shippedInBuild ?? "")
            ? { shippedInBuild }
            : {}),
        },
        user.uid
      );
      setNote("Saved.");
      onSaved();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Saving failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="glass-panel p-5 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-bold">{report.tryingToDo}</h3>
        <span className="text-sm text-text-muted">
          {BUG_STATUS_LABELS[report.status]} · reported by {report.reporterName}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{report.whatHappened}</p>
      {report.expected ? (
        <p className="text-sm text-text-muted">Expected: {report.expected}</p>
      ) : null}
      <p className="text-xs text-text-muted">
        {KIND_OPTIONS.find((k) => k.value === report.kind)?.label ?? report.kind}
        {report.route ? ` · route ${report.route}` : ""}
        {report.surface ? ` · surface ${report.surface}` : ""}
        {report.entityRef ? ` · entity ${report.entityRef}` : ""}
        {report.buildId ? ` · build ${report.buildId}` : ""}
        {typeof report.asOfSeq === "number" ? ` · as of Log #${report.asOfSeq}` : ""}
      </p>
      {screenshot ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={screenshot} alt="Screenshot attached to this report" className="max-w-full rounded border border-black/10" />
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <label className="text-sm">
          Status{" "}
          <select className="form-input w-auto" value={status} onChange={(e) => setStatus(e.target.value as BugReportStatus)}>
            {BUG_STATUSES.map((s) => (
              <option key={s} value={s}>{BUG_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Severity{" "}
          <select className="form-input w-auto" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </label>
        <label className="text-sm sm:col-span-2">
          Note to the reporter (the needs-info question, or why it closed)
          <textarea className="form-input w-full mt-1" rows={2} value={triageNote} maxLength={2000} onChange={(e) => setTriageNote(e.target.value)} />
        </label>
        <label className="text-sm sm:col-span-2">
          Duplicate of{" "}
          <select className="form-input w-auto" value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)}>
            <option value="">— not a duplicate —</option>
            {allReports
              .filter((r) => r.id !== report.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.tryingToDo.slice(0, 60)} ({BUG_STATUS_LABELS[r.status]})
                </option>
              ))}
          </select>
          <span className="text-xs text-text-muted ml-2">
            The reporter sees the canonical report&apos;s status only — never its text or reporter.
          </span>
        </label>
        <label className="text-sm">
          Fix branch
          <input className="form-input w-full mt-1" value={fixBranch} onChange={(e) => setFixBranch(e.target.value)} />
        </label>
        <label className="text-sm">
          Fix PR URL
          <input className="form-input w-full mt-1" value={fixPrUrl} onChange={(e) => setFixPrUrl(e.target.value)} />
        </label>
        <label className="text-sm">
          Preview URL
          <input className="form-input w-full mt-1" value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} />
        </label>
        <label className="text-sm">
          Shipped in build
          <input className="form-input w-full mt-1" value={shippedInBuild} onChange={(e) => setShippedInBuild(e.target.value)} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className="btn btn-primary text-sm px-4 py-2" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save triage"}
        </button>
        {note ? <span className="text-sm text-text-muted">{note}</span> : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// On-demand backup (design §3.6) — the fabric job's archive format,
// produced in the browser for hand-off to the Drive folder.
// ---------------------------------------------------------------------------

function serializeForArchive(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(serializeForArchive);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        serializeForArchive(v),
      ])
    );
  }
  return value;
}

function backupStem(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `bug-reports-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function BackupSection() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const runBackup = async () => {
    setBusy(true);
    setNote("");
    try {
      const snap = await getDocs(collection(getClientDb(), "bug_reports"));
      const reports = snap.docs
        .map((d) => ({
          id: d.id,
          data: serializeForArchive(d.data()) as Record<string, unknown>,
        }))
        .sort((a, b) => {
          const at = String(a.data.createdAt ?? "");
          const bt = String(b.data.createdAt ?? "");
          return at === bt ? a.id.localeCompare(b.id) : at.localeCompare(bt);
        });
      const now = new Date();
      const stem = backupStem(now);
      const archive = {
        schemaVersion: "bug-reports-backup/1",
        collection: "bug_reports",
        exportedAt: now.toISOString(),
        trigger: "on-demand",
        source: "in-app sheriff panel",
        reportCount: reports.length,
        reports,
      };
      const jsonBytes = new TextEncoder().encode(
        JSON.stringify(archive, null, 2)
      );
      const digest = await crypto.subtle.digest("SHA-256", jsonBytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const manifestEntry = {
        stem,
        exportedAt: archive.exportedAt,
        trigger: "on-demand",
        schemaVersion: archive.schemaVersion,
        reportCount: reports.length,
        jsonSha256: sha256,
        note: "Produced in-app; append this entry to the Drive folder's manifest.json runs[] when filing the archive.",
      };
      const blob = zipStore([
        { name: `${stem}.json`, data: jsonBytes },
        {
          name: "manifest-entry.json",
          data: new TextEncoder().encode(
            JSON.stringify(manifestEntry, null, 2)
          ),
        },
      ]);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${stem}-backup.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNote(
        `Archive downloaded: ${reports.length} report(s), SHA-256 ${sha256.slice(0, 12)}… Drop the JSON into the Drive folder “Cowboy City — Bug Report Backups” and append the manifest entry — the backup counts once it's in the folder.`
      );
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Backup failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-panel p-5 space-y-2" aria-label="Bug report backups">
      <h3 className="hud-title">Backups</h3>
      <p className="text-sm text-text-muted">
        Reports are backed up to the Drive folder “Cowboy City — Bug Report
        Backups” (JSON archive + manifest, design §3.6). This panel can&apos;t
        read that folder — the last successful backup&apos;s time lives in its
        manifest.json. “Back up now” builds the same archive here for you to
        drop into the folder; the scheduled weekly job arrives later, with
        the fabric batch.
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" className="btn btn-secondary text-sm px-4 py-2" disabled={busy} onClick={() => void runBackup()}>
          {busy ? "Building archive…" : "Back up now"}
        </button>
        {note ? <span className="text-sm text-text-muted">{note}</span> : null}
      </div>
    </section>
  );
}

export function ReportsPanel() {
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [filter, setFilter] = useState<BugReportStatus | "">("");
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setReports(await listTriageReports(200));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!reports) return [];
    return filter ? reports.filter((r) => r.status === filter) : reports;
  }, [reports, filter]);

  return (
    <section aria-label="Bug reports triage" className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-2xl font-bold text-accent-gold">Bug Reports</h2>
        <label className="text-sm">
          Status{" "}
          <select className="form-input w-auto" value={filter} onChange={(e) => setFilter(e.target.value as BugReportStatus | "")}>
            <option value="">All</option>
            {BUG_STATUSES.map((s) => (
              <option key={s} value={s}>{BUG_STATUS_LABELS[s]}</option>
            ))}
          </select>
        </label>
      </header>
      <BackupSection />
      {failed ? (
        <p>Bug reports couldn&apos;t be read just now.</p>
      ) : reports === null ? (
        <p className="text-text-muted">Loading reports…</p>
      ) : visible.length === 0 ? (
        <p className="text-text-muted">No reports in this state.</p>
      ) : (
        visible.map((report) => (
          <TriageCard
            key={report.id}
            report={report}
            allReports={reports}
            onSaved={() => void load()}
          />
        ))
      )}
    </section>
  );
}
