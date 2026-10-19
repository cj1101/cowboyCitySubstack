"use client";

/**
 * PanelShell — the shared frame every dashboard panel renders inside
 * (spec §5.9: one interaction-state set, no panel invents its own).
 *
 * Handles: loading skeleton (final layout dimensions, text-first, no
 * spinner-dependent content), the panel-alone error line (other panels
 * are unaffected; no query details leak — TC-G06 hygiene), and the stale
 * note. Data and empty states belong to the panel itself.
 *
 * `footer` is the slot for the per-panel export affordance (brief §10.2:
 * exactly what the panel shows that user) — wired by the composition,
 * absent where a panel carries no export (situations-peek, action-box)
 * and for guests.
 */

import type { ReactNode } from "react";
import type { PanelLoadState } from "@/lib/dashboard/registry";

interface PanelShellProps {
  title: string;
  /** Header subline — e.g. which city a panel resolved to, and why. */
  subline?: string | null;
  state: PanelLoadState<unknown>;
  /** Quiet stale note shown under the header when data renders stale. */
  staleNote?: string | null;
  footer?: ReactNode;
  children: ReactNode;
}

export function PanelShell({
  title,
  subline,
  state,
  staleNote,
  footer,
  children,
}: PanelShellProps) {
  return (
    <section className="glass-panel p-5 flex flex-col gap-3" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {subline ? <p className="text-xs text-text-muted mt-1">{subline}</p> : null}
      </header>

      {state.status === "loading" ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <div className="h-4 w-3/4 bg-darker-brown rounded" />
          <div className="h-4 w-1/2 bg-darker-brown rounded" />
          <div className="h-4 w-2/3 bg-darker-brown rounded" />
          <p className="text-xs text-text-muted">Loading…</p>
        </div>
      ) : state.status === "error" ? (
        <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
          <p className="text-sm font-bold">Couldn’t load this panel.</p>
          {state.onRetry ? (
            <button
              type="button"
              className="btn text-sm px-4 py-2 min-h-11"
              onClick={state.onRetry}
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {state.stale && staleNote ? (
            <p className="text-xs text-text-muted">{staleNote}</p>
          ) : null}
          {children}
          {footer ? <footer className="pt-1">{footer}</footer> : null}
        </>
      )}
    </section>
  );
}
