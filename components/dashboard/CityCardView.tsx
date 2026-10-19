"use client";

/**
 * CityCardView — the compact city card, shared by the city grid (cards
 * variant) and the my-city panel (card variant) so both render the same
 * component (spec §5.2.2/§5.2.3).
 *
 * Parity + honesty rules baked in:
 * - One template for every city; no city-slug conditionals (TC-D02).
 * - A card with hasSimState false renders as a plain lore/profile card:
 *   no stats block, no activity line, and no shaming status vocabulary —
 *   the sim section is simply absent (brief §2.1, TC-N01/N07).
 * - Null stats render `—`; corpus figures never appear in stat position.
 */

import Link from "next/link";
import {
  SIM_INDEX_LABELS,
  type DashboardCityCard,
  type SimIndexKey,
} from "@/lib/dashboard/registry";
import { formatFigureValue } from "./StatFigure";

const CARD_INDEX_KEYS: SimIndexKey[] = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
];

export function CityCardView({ card }: { card: DashboardCityCard }) {
  const stats = card.hasSimState ? card.compactStats : null;
  return (
    <article className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-2">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3>
          <Link href={card.links.city} className="underline">
            {card.name}
          </Link>
        </h3>
        <Link href={card.links.map} className="text-xs underline">
          City map
        </Link>
      </header>

      {card.ownerDisplay ? (
        <p className="text-xs text-text-muted">Owner: {card.ownerDisplay}</p>
      ) : null}

      {stats ? (
        <>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
            {CARD_INDEX_KEYS.map((key) => (
              <div key={key}>
                <dt className="text-xs text-text-muted">{SIM_INDEX_LABELS[key]}</dt>
                <dd className="font-bold">
                  {stats[key] === null || stats[key] === undefined
                    ? "—"
                    : formatFigureValue(stats[key] as number)}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-sm">
            <span className="text-text-muted">Treasury: </span>
            <span className="font-bold">
              {stats.treasuryRubars === null
                ? "—"
                : `${formatFigureValue(stats.treasuryRubars)} Rubars`}
            </span>
            {" · "}
            <span className="text-text-muted">GDP: </span>
            <span className="font-bold">
              {stats.gdpRubars === null ? "—" : formatFigureValue(stats.gdpRubars)}
            </span>
            {" · "}
            <span className="text-text-muted">Population: </span>
            <span className="font-bold">
              {stats.population === null ? "—" : formatFigureValue(stats.population)}
            </span>
          </p>
        </>
      ) : null}

      {card.latestHeadline ? (
        <p className="text-sm italic">{card.latestHeadline}</p>
      ) : null}
    </article>
  );
}
