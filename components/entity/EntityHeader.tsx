"use client";

/**
 * Entity page header (spec §6.2.1; business facts per §6.6).
 * For businesses, Owner / Based in / Operates in are three distinct
 * facts and are never conflated.
 */

import Link from "next/link";
import type { Faction } from "@/lib/types";
import { cityMapPinPath, cityPath } from "@/lib/entity/paths";
import {
  CORPORATION_STATUS_LABELS,
  STRUCTURE_STATUS_LABELS,
} from "@/lib/entity/functionState";
import { STRUCTURE_KIND_LABELS, type EntityPageData } from "@/lib/entity/types";

export function EntityHeader({
  faction,
  data,
  homeCity,
  marketCities,
}: {
  faction: Faction;
  data: EntityPageData;
  homeCity: Faction | null;
  marketCities: Faction[];
}) {
  const name =
    data.structure?.name ?? data.corporation?.name ?? data.presentation?.name ?? "Untitled";
  const pinId = data.structure?.linkedPinId ?? data.presentation?.pinId ?? null;

  return (
    <header className="glass-panel p-5 space-y-3">
      <nav className="text-sm text-text-muted">
        <Link href="/maps" className="text-accent-gold hover:underline">
          Realm map
        </Link>{" "}
        →{" "}
        <Link href={cityPath(faction.slug)} className="text-accent-gold hover:underline">
          {faction.name}
        </Link>{" "}
        → <span className="text-text-light">{name}</span>
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold text-accent-gold">{name}</h1>
        {data.kind === "building" && data.structure ? (
          <>
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
              {STRUCTURE_KIND_LABELS[data.structure.kind]}
              {data.structure.profile.subtype ? ` · ${data.structure.profile.subtype}` : ""}
            </span>
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
              {STRUCTURE_STATUS_LABELS[data.structure.status]}
            </span>
          </>
        ) : null}
        {data.kind === "business" && data.corporation ? (
          <>
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
              Business
              {data.corporation.industry ? ` · ${data.corporation.industry}` : ""}
            </span>
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
              {CORPORATION_STATUS_LABELS[data.corporation.status]}
            </span>
          </>
        ) : null}
        {data.posture === "presentation" ? (
          <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
            {data.kind === "building" ? "Building" : "Business"} · from the city&apos;s map &amp; lore
          </span>
        ) : null}
      </div>

      <div className="text-sm space-y-1">
        <p className="text-text-light">
          Host city:{" "}
          <Link href={cityPath(faction.slug)} className="text-accent-gold hover:underline">
            {faction.name}
          </Link>
          {data.structure?.profile.district ? (
            <span className="text-text-muted"> · {data.structure.profile.district} district</span>
          ) : null}
        </p>

        {data.kind === "building" && data.structure ? (
          <p className="text-text-light">
            Owner:{" "}
            {data.structure.profile.ownerDisplay ??
              (data.structure.profile.ownerUid
                ? "Recorded member"
                : "The host city (no separate controller recorded)")}
          </p>
        ) : null}

        {data.kind === "business" && data.corporation ? (
          <>
            <p className="text-text-light">
              Owner:{" "}
              {data.corporation.ownerDisplay ??
                (data.corporation.ownerUid
                  ? "Recorded member"
                  : data.corporation.founderFigureId
                    ? "Its founder (recorded figure)"
                    : "Not recorded")}
            </p>
            <p className="text-text-light">
              Based in:{" "}
              {homeCity ? (
                <Link href={cityPath(homeCity.slug)} className="text-accent-gold hover:underline">
                  {homeCity.name}
                </Link>
              ) : (
                faction.name
              )}
            </p>
            <p className="text-text-light">
              Operates in:{" "}
              {marketCities.length > 0
                ? marketCities.map((city, i) => (
                    <span key={city.id}>
                      {i > 0 ? ", " : ""}
                      <Link href={cityPath(city.slug)} className="text-accent-gold hover:underline">
                        {city.name}
                      </Link>
                    </span>
                  ))
                : "No other cities recorded"}
            </p>
          </>
        ) : null}

        {pinId ? (
          <p>
            <Link
              href={cityMapPinPath(faction.slug, pinId)}
              className="text-accent-gold hover:underline text-sm"
            >
              View on the {faction.name} map
            </Link>
          </p>
        ) : null}
      </div>
    </header>
  );
}
