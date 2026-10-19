"use client";

import { useBugReport } from "@/components/bugs/BugReportProvider";

/**
 * The error-state door (design §2.1): a quiet inline "Report this" link
 * that an error/empty surface renders beside its message — LoadNotice,
 * ScreenStatus, the dashboard's honest-empty states. The highest-value
 * reports are filed at the moment of failure, so the link pre-fills
 * "What happened?" with the message the surface is already showing the
 * member (never a stack trace — the client has none worth sending).
 *
 * User-initiated only: rendering the link files nothing, and the dialog
 * still opens for the member to edit, consent, and send. For anyone who
 * cannot file (guests, signed-out visitors — filing is members only
 * [CJ]) the link renders nothing at all.
 */
export function ReportThisLink({
  message,
  label = "Report this",
  className = "",
}: {
  /** The surface's displayed error/empty message, carried into the dialog as prefill. */
  message?: string;
  label?: string;
  className?: string;
}) {
  const { canFile, openBugReport } = useBugReport();
  if (!canFile) return null;
  return (
    <button
      type="button"
      className={`underline underline-offset-2 text-sm hover:text-accent-gold ${className}`}
      onClick={() =>
        openBugReport(message ? { whatHappened: message.slice(0, 500) } : undefined)
      }
    >
      {label}
    </button>
  );
}
