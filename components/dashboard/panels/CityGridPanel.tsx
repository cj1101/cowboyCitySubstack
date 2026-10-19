"use client";

/**
 * The Realm — city grid (brief §4.2 #5; spec §5.2.3).
 *
 * One card per live faction from the snapshot's cityCards. Sort options
 * are exactly: alphabetical, by GDP (TC-F05) — no engagement ordering,
 * no "trending", no activity ranking. GDP sort uses the verified sim
 * figure only; cards without one sort by name inside the no-figure
 * group and their figure cell shows `—`. Corpus GDP is never a sort
 * key and never renders in stat position.
 *
 * The table variant is the same data, denser: every compact stat as a
 * column. Unowned factions render as lore cards with no sim section
 * (CityCardView) — no stats block, no activity line, no shaming label.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  SIM_INDEX_LABELS,
  type DashboardCityCard,
  type PanelLoadState,
  type SimIndexKey,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";
import { CityCardView } from "../CityCardView";
import { formatFigureValue } from "../StatFigure";

export interface CityGridData {
  cards: DashboardCityCard[];
}

type GridSort = "alphabetical" | "gdp";

const TABLE_INDEX_KEYS: SimIndexKey[] = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
];

function sortCards(cards: DashboardCityCard[], sort: GridSort): DashboardCityCard[] {
  const byName = (a: DashboardCityCard, b: DashboardCityCard) =>
    a.name.localeCompare(b.name);
  if (sort === "alphabetical") return [...cards].sort(byName);
  return [...cards].sort((a, b) => {
    const ga = a.compactStats?.gdpRubars ?? null;
    const gb = b.compactStats?.gdpRubars ?? null;
    if (ga === null && gb === null) return byName(a, b);
    if (ga === null) return 1;
    if (gb === null) return -1;
    return gb - ga || byName(a, b);
  });
}

export function CityGridPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<CityGridData>;
  variant: string;
  footer?: ReactNode;
}) {
  const [sort, setSort] = useState<GridSort>("alphabetical");
  const data = state.status === "ready" ? state.data : null;
  const cards = useMemo(
    () => (data ? sortCards(data.cards, sort) : []),
    [data, sort],
  );
  return (
    <PanelShell title="The Realm" state={state} footer={footer}>
      {data ? (
        cards.length === 0 ? (
          <p className="text-sm">No cities yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="text-sm flex flex-wrap items-center gap-2">
              <span className="text-text-muted">Sort:</span>
              <select
                className="min-h-11 px-2"
                value={sort}
                onChange={(event) => setSort(event.target.value as GridSort)}
              >
                <option value="alphabetical">Alphabetical</option>
                <option value="gdp">By GDP</option>
              </select>
            </label>
            {variant === "table" ? (
              <div className="overflow-x-auto">
                <table className="text-sm w-full">
                  <thead>
                    <tr className="text-left text-xs text-text-muted">
                      <th className="pr-3 py-1">City</th>
                      <th className="pr-3 py-1">Owner</th>
                      {TABLE_INDEX_KEYS.map((key) => (
                        <th key={key} className="pr-3 py-1">
                          {SIM_INDEX_LABELS[key]}
                        </th>
                      ))}
                      <th className="pr-3 py-1">Treasury</th>
                      <th className="pr-3 py-1">GDP</th>
                      <th className="py-1">Population</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((card) => {
                      const stats = card.hasSimState ? card.compactStats : null;
                      const cell = (value: number | null | undefined) =>
                        value === null || value === undefined
                          ? "—"
                          : formatFigureValue(value);
                      return (
                        <tr key={card.factionId} className="border-t border-darker-brown">
                          <td className="pr-3 py-1 font-bold">{card.name}</td>
                          <td className="pr-3 py-1">{card.ownerDisplay ?? "—"}</td>
                          {stats ? (
                            <>
                              {TABLE_INDEX_KEYS.map((key) => (
                                <td key={key} className="pr-3 py-1">
                                  {cell(stats[key])}
                                </td>
                              ))}
                              <td className="pr-3 py-1">{cell(stats.treasuryRubars)}</td>
                              <td className="pr-3 py-1">{cell(stats.gdpRubars)}</td>
                              <td className="py-1">{cell(stats.population)}</td>
                            </>
                          ) : (
                            <td className="py-1 text-text-muted" colSpan={9}>
                              Lore city — not in the sim
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                {cards.map((card) => (
                  <CityCardView key={card.factionId} card={card} />
                ))}
              </div>
            )}
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
