"use client";

/**
 * Contest board (brief §4.2 #6; spec §5.2.6) — ships HONESTLY EMPTY in
 * Phase 3: the snapshot's openContestCards is [] because no contest
 * records exist until Phase 7 creates them. The empty state is the
 * honest default, and the declare affordance is disabled AND labeled
 * Phase 7 — not a fake button (spec §8.1).
 *
 * Phase 7 contract (brief §4.3, carried here so the flip is data-only):
 * standings compute from sim_log_entries only — never from a stored
 * standings field — each row why-linked to its contributing seq range;
 * a contest whose end condition is met shows "End condition met —
 * awaiting close", because closure is a logged member action, never
 * this panel's inference. Contest standings are CITY standings; there
 * is no member-leaderboard variant (TC-F01).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type {
  DashboardContestCard,
  PanelLoadState,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface ContestsData {
  contests: DashboardContestCard[];
}

export function ContestsPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<ContestsData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  return (
    <PanelShell title="Contest board" state={state} footer={footer}>
      {data ? (
        data.contests.length === 0 ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="font-bold">No contest is currently declared.</p>
            <p className="text-text-muted">
              The group declares contests in the moment — a metric, an end
              condition, a prize — and standings track from the Log.
            </p>
            <button type="button" className="btn text-sm px-4 py-2 min-h-11" disabled>
              Declare a contest — arrives in Phase 7
            </button>
          </div>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.contests.map((contest) => (
              <li key={contest.contestId}>
                <Link href={contest.href} className="font-bold underline">
                  {contest.title}
                </Link>
                <span className="text-text-muted">
                  {" "}
                  · {contest.statusLabel}
                  {variant !== "compact" ? ` · Ends: ${contest.endConditionLabel}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </PanelShell>
  );
}
