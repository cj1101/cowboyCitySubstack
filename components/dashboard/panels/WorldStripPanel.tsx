"use client";

/**
 * World strip (brief §4.2 #1; spec §5.2.1) — a single row of world facts,
 * identical data for every viewer, plus the freshness line.
 *
 * Freshness is a SEQ comparison, never a clock (brief §3.3): current iff
 * asOfSeq == world head; the stale/missing copy is brief §3.5 verbatim.
 * Realm GDP renders in exactly one register per cell — a cited lore
 * figure OR a verified sim figure with a why-link, never both (R-10/R-23).
 * The term cells read the snapshot's townHallCard only: in Phase 3 it is
 * null (no sim_terms exist until Phase 7) and the cells say so plainly —
 * lore mayors are never promoted into a sim office (brief §4.3, P3-D7).
 * The fabric cell renders sim_fabric_status absence as the truth
 * (brief §2.4): Phase 3 ships no writer for that doc.
 */

import type { ReactNode } from "react";
import type {
  DashboardFigure,
  DashboardTownHallCard,
  PanelLoadState,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";
import { StatFigure } from "../StatFigure";

export type RealmGdpCell =
  | { kind: "sim"; figure: DashboardFigure }
  | { kind: "lore"; valueLabel: string; citation: string };

export interface WorldStripData {
  /** Snapshot's asOfSeq; null when the snapshot is missing/pre-genesis. */
  asOfSeq: number | null;
  /** sim_world/current.lastCommittedSeq as the read path observed it. */
  worldHeadSeq: number | null;
  snapshotMissing: boolean;
  /** Count of live member city-states (live factions — never hardcoded). */
  liveCityCount: number | null;
  townHallCard: DashboardTownHallCard | null;
  realmGdp: RealmGdpCell | null;
  /** sim_fabric_status/current as read; null = the doc does not exist. */
  fabricStatus: {
    statusLabel: string;
    lastCycleCompletedLabel: string | null;
  } | null;
}

export function freshnessLine(data: WorldStripData): string {
  if (data.asOfSeq === null && data.worldHeadSeq === null) {
    return "The sim hasn’t started — no Log yet.";
  }
  if (data.snapshotMissing) {
    return `World as of Log #${data.worldHeadSeq ?? "—"} (live read — snapshot not built yet)`;
  }
  if (data.worldHeadSeq !== null && data.asOfSeq !== data.worldHeadSeq) {
    return `World as of Log #${data.asOfSeq} — the world has moved to #${data.worldHeadSeq}; showing last projected state. It rebuilds when the fabric next runs.`;
  }
  return `World as of Log #${data.asOfSeq}`;
}

export function WorldStripPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<WorldStripData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  return (
    <PanelShell title="World strip" state={state} footer={footer}>
      {data ? (
        variant === "compact" ? (
          <p className="text-sm">
            <span className="font-bold">{data.liveCityCount ?? "—"}</span>{" "}
            <span className="text-text-muted">live city-states · </span>
            {freshnessLine(data)}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-text-muted">Mayor of Cowboy City</dt>
                <dd className="font-bold">
                  {data.townHallCard?.mayorDisplay ?? "No term recorded yet"}
                </dd>
                {data.townHallCard?.termStateLabel ? (
                  <dd className="text-xs text-text-muted">
                    {data.townHallCard.termStateLabel}
                  </dd>
                ) : null}
                {data.townHallCard?.electionDue ? (
                  <dd className="text-xs">Election DUE — not yet called</dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs text-text-muted">Vice Mayor</dt>
                <dd className="font-bold">
                  {data.townHallCard?.viceMayorDisplay ?? "No term recorded yet"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">United Realms</dt>
                <dd className="font-bold">
                  {data.liveCityCount === null
                    ? "—"
                    : `${data.liveCityCount} live city-states`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-text-muted">Realm GDP</dt>
                {data.realmGdp === null ? (
                  <dd className="font-bold">—</dd>
                ) : data.realmGdp.kind === "lore" ? (
                  <dd>
                    <span className="font-bold">{data.realmGdp.valueLabel}</span>{" "}
                    <span className="text-xs text-text-muted">
                      Lore reference — {data.realmGdp.citation}
                    </span>
                  </dd>
                ) : (
                  <dd>
                    <StatFigure figure={data.realmGdp.figure} />
                    <span className="text-xs text-text-muted"> Rubars (sim)</span>
                  </dd>
                )}
              </div>
              <div>
                <dt className="text-xs text-text-muted">World state</dt>
                {data.fabricStatus === null ? (
                  <dd className="font-bold">The fabric hasn’t run a cycle yet</dd>
                ) : (
                  <>
                    <dd className="font-bold">{data.fabricStatus.statusLabel}</dd>
                    {data.fabricStatus.lastCycleCompletedLabel ? (
                      <dd className="text-xs text-text-muted">
                        Last completed cycle: {data.fabricStatus.lastCycleCompletedLabel}
                      </dd>
                    ) : null}
                  </>
                )}
              </div>
            </dl>
            <p className="text-xs text-text-muted">{freshnessLine(data)}</p>
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
