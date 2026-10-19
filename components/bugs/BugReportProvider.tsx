"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { canUseRealm } from "@/lib/membership";
import { ReportBugDialog } from "@/components/bugs/ReportBugDialog";

export interface BugReportPrefill {
  /** Pre-typed text for "What happened?" — e.g. the message an error surface is already showing. */
  whatHappened?: string;
}

interface BugReportContextValue {
  /** True only for signed-in members. Guests and signed-out visitors get no affordance [CJ: members only]. */
  canFile: boolean;
  openBugReport: (prefill?: BugReportPrefill) => void;
}

const BugReportContext = createContext<BugReportContextValue | null>(null);

/**
 * Hosts the one ReportBugDialog for the whole site. Mounted once (the Build
 * Lead mounts BugReportChrome in app/layout.tsx — see the prep report); safe
 * to nest, the nearest provider wins. The dialog is a modal the user opens —
 * nothing here ever pops it up uninvited (design §2.1, TC-F06).
 */
export function BugReportProvider({ children }: { children: ReactNode }) {
  const { user, profile } = useAuth();
  const canFile = Boolean(user && profile && canUseRealm(profile));
  const [open, setOpen] = useState(false);
  const [prefill, setPrefill] = useState<BugReportPrefill | undefined>(undefined);

  const openBugReport = useCallback(
    (next?: BugReportPrefill) => {
      if (!canFile) return;
      setPrefill(next);
      setOpen(true);
    },
    [canFile]
  );

  const value = useMemo(() => ({ canFile, openBugReport }), [canFile, openBugReport]);

  return (
    <BugReportContext.Provider value={value}>
      {children}
      {open && canFile && (
        <ReportBugDialog prefill={prefill} onClose={() => setOpen(false)} />
      )}
    </BugReportContext.Provider>
  );
}

export function useBugReport(): BugReportContextValue {
  const context = useContext(BugReportContext);
  if (!context) {
    // Surfaces rendered outside the provider (e.g. before the layout mounts
    // it) simply get no affordance rather than an error.
    return { canFile: false, openBugReport: () => undefined };
  }
  return context;
}
