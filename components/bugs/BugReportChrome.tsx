"use client";

import type { ReactNode } from "react";
import { getBuildId } from "@/lib/bugs/build-info";
import { BugReportProvider, useBugReport } from "@/components/bugs/BugReportProvider";

/**
 * The site-wide bug-report mount (design §2.1): the Build Lead wraps the
 * root layout's content in this component. It hosts the one dialog (via
 * BugReportProvider) and renders the global footer — a quiet text link,
 * "Report a bug," beside the build stamp. No floating button, no badge,
 * no count (design §1.3 / RPT-g).
 *
 * The build stamp renders for everyone (a member can quote it in a Discord
 * message when the site itself won't load, §2.3); the report link renders
 * only for signed-in members — guests get no filing affordance [CJ ruling].
 */
function BugReportFooter() {
  const { canFile, openBugReport } = useBugReport();
  return (
    <footer className="px-6 py-4 flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
      <span>{getBuildId()}</span>
      {canFile && (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-accent-gold"
          onClick={() => openBugReport()}
        >
          Report a bug
        </button>
      )}
    </footer>
  );
}

export function BugReportChrome({ children }: { children: ReactNode }) {
  return (
    <BugReportProvider>
      {children}
      <BugReportFooter />
    </BugReportProvider>
  );
}
