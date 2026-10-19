"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { CameraRollInput } from "@/components/media/CameraRollInput";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { actionError } from "@/lib/async";
import { captureBugContext, type CapturedBugContext } from "@/lib/bugs/context";
import { getBuildId } from "@/lib/bugs/build-info";
import {
  createBugReport,
  newBugReportId,
  uploadBugScreenshot,
} from "@/lib/bugs/reports";
import {
  BUG_FIELD_LIMITS,
  KIND_OPTIONS,
  SEVERITY_OPTIONS,
  type BugReportKind,
  type BugReportSeverity,
} from "@/lib/bugs/types";
import type { BugReportPrefill } from "@/components/bugs/BugReportProvider";

/**
 * The one bug-report form (design §2.2): five plain-language questions, an
 * optional screenshot the reporter picks themselves, and a technical-details
 * consent block whose contents are listed, readable, before submitting.
 * No jargon: "version", "repro steps", and "severity" never appear.
 *
 * Privacy by construction (design §2.4): the auto-context is references only
 * (route, surface, entity slug, Log position, build) — never sim data, never
 * other members' content, never anything from storage or cookies. With the
 * consent box unticked, none of it is written at all (RPT-f).
 */
export function ReportBugDialog({
  prefill,
  onClose,
}: {
  prefill?: BugReportPrefill;
  onClose: () => void;
}) {
  const { user, profile } = useAuth();
  const pathname = usePathname();
  // Captured once, when the dialog opens, so it reflects the page as the
  // reporter saw it (design §2.3).
  const [context] = useState<CapturedBugContext>(() => captureBugContext(pathname || "/"));
  const reportId = useRef<string>(newBugReportId());

  const [tryingToDo, setTryingToDo] = useState("");
  const [whatHappened, setWhatHappened] = useState(prefill?.whatHappened || "");
  const [expected, setExpected] = useState("");
  const [severity, setSeverity] = useState<BugReportSeverity>("annoying");
  const [kind, setKind] = useState<BugReportKind>("not-sure");
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const detailRows = useMemo(() => {
    const rows: [string, string][] = [
      ["Page you were on", context.route],
      ["Build", getBuildId()],
      ["Browser", `${context.browserFamily} · ${context.osFamily}`],
      ["Screen size", `${context.viewport.w} × ${context.viewport.h}`],
      ["Your clock", `${context.clientAt.toLocaleString()}${context.timezone ? ` (${context.timezone})` : ""}`],
    ];
    if (context.entityRef) rows.push(["About", context.entityRef]);
    if (typeof context.asOfSeq === "number") {
      rows.push(["World position (Log)", `#${context.asOfSeq}`]);
    }
    return rows;
  }, [context]);

  if (!user || !profile) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let screenshotPath: string | undefined;
      if (screenshot) {
        screenshotPath = await uploadBugScreenshot(user.uid, reportId.current, screenshot);
      }
      await createBugReport(
        { uid: user.uid, displayName: profile.displayName || "Member" },
        reportId.current,
        {
          tryingToDo,
          whatHappened,
          expected: expected || undefined,
          severity,
          kind,
          screenshotPath,
          includeContext: includeDetails,
          context,
        }
      );
      setDone(true);
    } catch (err) {
      setError(actionError(err, "Could not send your report. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] bg-ink/70 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Report a bug"
      onClick={onClose}
    >
      <div
        className="glass-panel w-full max-w-xl max-h-[92vh] overflow-y-auto p-6 space-y-5"
        onClick={(event) => event.stopPropagation()}
      >
        {done ? (
          <div className="space-y-4">
            <h2 className="text-2xl font-bold text-accent-gold">Got it — thanks.</h2>
            <p className="text-sm">
              You can follow what happens with it under{" "}
              <Link href="/reports" className="text-accent-gold font-bold" onClick={onClose}>
                Your reports
              </Link>
              .
            </p>
            <button type="button" className="btn px-5 py-2" onClick={onClose}>
              Close
            </button>
          </div>
        ) : (
          <form className="space-y-5" onSubmit={submit}>
            <div>
              <h2 className="text-2xl font-bold text-accent-gold">Report a bug</h2>
              <p className="text-text-muted text-sm mt-1">
                Tell us in your own words. A person on the team reads every report.
              </p>
            </div>

            <div>
              <label className="form-label" htmlFor="bug-trying">
                What were you trying to do?
              </label>
              <input
                id="bug-trying"
                className="form-input"
                value={tryingToDo}
                maxLength={BUG_FIELD_LIMITS.tryingToDo}
                onChange={(e) => setTryingToDo(e.target.value)}
                placeholder="e.g. open Chess City's page, post in the forum"
                required
              />
            </div>

            <div>
              <label className="form-label" htmlFor="bug-happened">
                What happened?
              </label>
              <textarea
                id="bug-happened"
                className="form-input"
                rows={4}
                value={whatHappened}
                maxLength={BUG_FIELD_LIMITS.whatHappened}
                onChange={(e) => setWhatHappened(e.target.value)}
                placeholder="What did you see? Anything that looked wrong, missing, or stuck?"
                required
              />
            </div>

            <div>
              <label className="form-label" htmlFor="bug-expected">
                What did you expect to happen? <span className="text-text-muted">(if you know)</span>
              </label>
              <textarea
                id="bug-expected"
                className="form-input"
                rows={2}
                value={expected}
                maxLength={BUG_FIELD_LIMITS.expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder="What should it have done instead?"
              />
            </div>

            <fieldset>
              <legend className="form-label">How much does it get in your way?</legend>
              <div className="space-y-2 mt-1">
                {SEVERITY_OPTIONS.map((option) => (
                  <label key={option.value} className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name="bug-severity"
                      value={option.value}
                      checked={severity === option.value}
                      onChange={() => setSeverity(option.value)}
                      className="mt-1"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <label className="form-label" htmlFor="bug-kind">
                What kind of thing is it? <span className="text-text-muted">(if you know)</span>
              </label>
              <select
                id="bug-kind"
                className="form-input"
                value={kind}
                onChange={(e) => setKind(e.target.value as BugReportKind)}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <span className="form-label">Picture (only if you want)</span>
              <CameraRollInput
                accept="image/*"
                multiple={false}
                label={screenshot ? `Picture chosen: ${screenshot.name}` : "Attach a picture"}
                onFiles={(files) => setScreenshot(files[0] ?? null)}
              />
              <p className="text-xs text-text-muted mt-2">
                Only attach a picture you&apos;re fine with the team seeing — it goes in exactly
                as you send it.
              </p>
            </div>

            <div className="border-t border-primary-brown pt-4">
              <label className="flex items-start gap-2 text-sm font-bold cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDetails}
                  onChange={(e) => setIncludeDetails(e.target.checked)}
                  className="mt-1"
                />
                <span>Include the technical details listed below — they help us find the exact same problem.</span>
              </label>
              <dl className="mt-3 space-y-1 text-sm text-text-muted">
                {detailRows.map(([label, value]) => (
                  <div key={label} className="flex flex-wrap gap-x-2">
                    <dt className="font-bold">{label}:</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-text-muted mt-2">
                Nothing else is attached — no page contents, no messages, nothing about other
                people&apos;s cities. Unticking sends only what you typed above.
              </p>
            </div>

            {error && (
              <p className="text-sm font-bold" role="alert">
                {error}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <SubmitButton busy={busy} busyLabel="Sending…">
                Send report
              </SubmitButton>
              <button type="button" className="btn btn-secondary px-5 py-2" onClick={onClose}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
