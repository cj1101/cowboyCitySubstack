"use client";

/**
 * Sports (brief §4.2 #9; spec §5.2.9) — standings and results from
 * seed/lore sports data and RECORDED results only. Nothing here
 * auto-resolves, sims a fixture, or projects a table from thin air:
 * the causality rule binds sports exactly like everything else —
 * a result exists because someone recorded one. Phase 3 receives
 * whatever the realm has actually recorded (the read path resolves
 * it into the shapes below); an unrecorded season renders as the
 * honest empty state, not a generated table.
 *
 * Variants: "standard" shows standings (when recorded) plus recent
 * results; "scores-only" shows results only.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type { PanelLoadState } from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface SportsStandingRow {
  /** Team/side name, verbatim from the record. */
  label: string;
  /** Record as recorded (e.g. "4–1") — a display string resolved by
   *  the read path, never computed in the panel. */
  recordLabel: string;
}

export interface SportsResult {
  id: string;
  /** What was played (fixture/competition line), verbatim. */
  label: string;
  /** The recorded outcome line (score/result), verbatim. */
  outcomeLabel: string;
  href?: string;
}

export interface SportsCompetition {
  id: string;
  name: string;
  /** Season/competition status as recorded — verbatim label. */
  statusLabel: string | null;
  standings: SportsStandingRow[];
  recentResults: SportsResult[];
}

export interface SportsData {
  competitions: SportsCompetition[];
}

export function SportsPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<SportsData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const scoresOnly = variant === "scores-only";
  return (
    <PanelShell title="Sports" state={state} footer={footer}>
      {data ? (
        data.competitions.length === 0 ? (
          <p className="text-sm">
            No recorded results yet. Sports here run on what the realm
            has actually played and recorded — nothing is simulated in
            the background, and no table appears until results exist.
          </p>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {data.competitions.map((competition) => (
              <div key={competition.id} className="flex flex-col gap-2">
                <p>
                  <span className="font-bold">{competition.name}</span>
                  {competition.statusLabel ? (
                    <span className="text-text-muted"> · {competition.statusLabel}</span>
                  ) : null}
                </p>
                {!scoresOnly && competition.standings.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {competition.standings.map((row) => (
                      <li key={row.label} className="flex justify-between gap-3">
                        <span>{row.label}</span>
                        <span className="text-text-muted">{row.recordLabel}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {competition.recentResults.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {competition.recentResults.map((result) => (
                      <li key={result.id}>
                        {result.href ? (
                          <Link href={result.href} className="underline">
                            {result.label}
                          </Link>
                        ) : (
                          result.label
                        )}
                        <span className="text-text-muted"> · {result.outcomeLabel}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {!scoresOnly &&
                competition.standings.length === 0 &&
                competition.recentResults.length === 0 ? (
                  <p className="text-text-muted">Nothing recorded yet.</p>
                ) : null}
              </div>
            ))}
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
