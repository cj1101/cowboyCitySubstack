"use client";

/**
 * What Happened digest (brief §4.2 #3; spec §5.2.4) — a FINITE projection
 * of the snapshot's latestSummaries (public tier only), plus, in the
 * viewing member's own view, their own actor-private entries merged in
 * by the read path and flagged isOwnPrivate. Private entries of anyone
 * else can never appear here: the snapshot is identical for every viewer
 * and the merge runs under the viewer's own identity (brief §3.4).
 *
 * Finite by construction (TC-F02): at most 10 entries (standard) or 5
 * (brief), no load-more, no mid-read injection, and the terminator line
 * always closes the panel. The "since" anchor is presentation state
 * only; an anchor above the current head (post-undo) clamps silently to
 * "You're caught up" (brief §6.3). Copy is neutral — the urgency
 * phrasing on the P3-G7 denylist appears nowhere in this file,
 * comments included (TC-F03).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type {
  DashboardLatestSummary,
  PanelLoadState,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface DigestEntry extends DashboardLatestSummary {
  /** True only for the viewing member's OWN actor-private entries,
   *  merged client-side by the read path (Phase 2 §11.1 discipline).
   *  Rendered with a visible "Only you can see this" badge. */
  isOwnPrivate?: boolean;
  /** Set when the actor is an NPC acting on a member's behalf — renders
   *  as NPC-on-behalf, never as the owner personally acting (TC-N07). */
  npcOnBehalf?: { npcName: string; ownerDisplay: string } | null;
  ruleIds?: string[];
  /** Deep link to this entry on the Log page. */
  href?: string;
}

export interface DigestData {
  entries: DigestEntry[];
  /** The viewer's stored "since" anchor (client-side only), if any. */
  sinceSeq: number | null;
  /** Current Log head the read path observed — used only to clamp the
   *  anchor after a lawful undo (brief §6.3). */
  headSeq: number | null;
  logHref: string;
}

function sinceLabel(data: DigestData): string | null {
  if (data.sinceSeq === null) return "Latest entries.";
  if (data.headSeq !== null && data.sinceSeq >= data.headSeq) {
    return "You’re caught up.";
  }
  const count = data.entries.filter((entry) => entry.seq > (data.sinceSeq ?? 0)).length;
  if (count === 0) return "You’re caught up.";
  return `${count} ${count === 1 ? "entry" : "entries"} since Log #${data.sinceSeq}.`;
}

export function DigestPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<DigestData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const cap = variant === "brief" ? 5 : 10;
  const entries = data ? data.entries.slice(0, cap) : [];
  const subline = data ? sinceLabel(data) : null;
  return (
    <PanelShell title="What Happened" subline={subline} state={state} footer={footer}>
      {data ? (
        entries.length === 0 ? (
          <p className="text-sm">Nothing has happened — the world is waiting.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <ol className="flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={`${entry.seq}-${entry.isOwnPrivate ? "own" : "pub"}`} className="text-sm">
                  <p>
                    <span className="text-text-muted">#{entry.seq} · </span>
                    {entry.npcOnBehalf ? (
                      <span className="font-bold">
                        {entry.npcOnBehalf.npcName} (NPC, for {entry.npcOnBehalf.ownerDisplay})
                      </span>
                    ) : (
                      <span className="font-bold">{entry.actorDisplay}</span>
                    )}
                    {entry.major ? <span className="text-xs"> · major</span> : null}
                    {entry.isOwnPrivate ? (
                      <span className="text-xs"> · Only you can see this</span>
                    ) : null}
                  </p>
                  <p>{entry.summaryText}</p>
                  {entry.ruleIds && entry.ruleIds.length > 0 ? (
                    <p className="text-xs text-text-muted">
                      Rules: {entry.ruleIds.join(", ")}
                    </p>
                  ) : null}
                  {entry.href ? (
                    <Link href={entry.href} className="text-xs underline">
                      Full Log entry
                    </Link>
                  ) : null}
                </li>
              ))}
            </ol>
            <p className="text-xs text-text-muted">
              — END OF DIGEST — You’re caught up; nothing else has happened.
            </p>
            <Link href={data.logHref} className="text-sm underline">
              Open the full Log
            </Link>
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
