"use client";

/**
 * Town Hall (brief §4.2 #7, §4.3; spec §5.2.7) — the realm's shared
 * business at a glance: open motions and latest resolutions from the
 * existing forum/treaty state (resolved into props by the read path),
 * plus the sim term block from the snapshot's townHallCard.
 *
 * The term block renders ONLY when a term record exists (Phase 7).
 * Until then there is no mayor/vice-mayor sim block at all — the
 * group's lore mayor is a lore fact and renders on lore surfaces;
 * Phase 3 does not promote lore into a sim office (P3-D7). In Phase 3
 * the snapshot always carries townHallCard: null, so the block is
 * absent and the panel is motions/resolutions only. When Phase 7
 * lands, an election that is due is a STATUS ("Election DUE — not yet
 * called") — never a countdown that fires anything (brief §4.3).
 *
 * Authority shape (CJ's round-3 ruling, context for the Phase 7 flip):
 * the sitting mayor acts operationally in the shared city; the Town
 * Hall, led by the vice mayor, is where the realm intervenes. This
 * panel renders that state; it decides nothing.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type {
  DashboardTownHallCard,
  PanelLoadState,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface TownHallMotion {
  id: string;
  title: string;
  href: string;
  /** What kind of business it is (motion, debate, treaty…) — a
   *  read-path label, rendered verbatim. */
  kindLabel: string;
  /** Where it stands (open, in debate, awaiting votes…) — verbatim. */
  statusLabel: string;
}

export interface TownHallResolution {
  id: string;
  title: string;
  href: string;
  /** How it landed (passed, rejected, ratified…) — verbatim. */
  outcomeLabel: string;
}

export interface TownHallData {
  /** From the snapshot; null until Phase 7 term records exist. */
  termCard: DashboardTownHallCard | null;
  openMotions: TownHallMotion[];
  recentResolutions: TownHallResolution[];
}

export function TownHallPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<TownHallData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const compact = variant === "compact";
  return (
    <PanelShell title="Town Hall" state={state} footer={footer}>
      {data ? (
        <div className="flex flex-col gap-3 text-sm">
          {data.termCard ? (
            <div className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-1">
              {data.termCard.mayorDisplay ? (
                <p>
                  <span className="text-text-muted">Mayor: </span>
                  <span className="font-bold">{data.termCard.mayorDisplay}</span>
                </p>
              ) : null}
              {data.termCard.viceMayorDisplay ? (
                <p>
                  <span className="text-text-muted">Vice Mayor: </span>
                  {data.termCard.viceMayorDisplay}
                </p>
              ) : null}
              {data.termCard.termStateLabel ? (
                <p className="text-text-muted">{data.termCard.termStateLabel}</p>
              ) : null}
              {data.termCard.electionDue ? (
                <p className="font-bold">Election DUE — not yet called</p>
              ) : null}
            </div>
          ) : null}

          {data.openMotions.length === 0 && data.recentResolutions.length === 0 ? (
            <p>
              No open motions and no recent resolutions. Town Hall is
              where the realm&rsquo;s shared business is proposed and
              decided.
            </p>
          ) : compact ? (
            <>
              <p>
                {data.openMotions.length}{" "}
                {data.openMotions.length === 1 ? "open motion" : "open motions"}
                {data.recentResolutions.length > 0
                  ? ` · latest: ${data.recentResolutions[0].title} (${data.recentResolutions[0].outcomeLabel})`
                  : ""}
              </p>
              {data.openMotions.length > 0 ? (
                <p>
                  <Link href={data.openMotions[0].href} className="underline">
                    {data.openMotions[0].title}
                  </Link>
                  <span className="text-text-muted"> · {data.openMotions[0].statusLabel}</span>
                </p>
              ) : null}
            </>
          ) : (
            <>
              {data.openMotions.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-bold">Open motions</p>
                  <ul className="flex flex-col gap-1">
                    {data.openMotions.map((motion) => (
                      <li key={motion.id}>
                        <Link href={motion.href} className="underline">
                          {motion.title}
                        </Link>
                        <span className="text-text-muted">
                          {" "}
                          · {motion.kindLabel} · {motion.statusLabel}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {data.recentResolutions.length > 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="font-bold">Latest resolutions</p>
                  <ul className="flex flex-col gap-1">
                    {data.recentResolutions.map((resolution) => (
                      <li key={resolution.id}>
                        <Link href={resolution.href} className="underline">
                          {resolution.title}
                        </Link>
                        <span className="text-text-muted"> · {resolution.outcomeLabel}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </PanelShell>
  );
}
