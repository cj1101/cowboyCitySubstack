"use client";

/**
 * The entity page template (brief §8.2) — one composer so every
 * entity page carries every section, in the brief's order, whatever
 * its data posture (TC-D01):
 *
 *   1. Header · 2. Function · 3. Gallery · 4. Status & condition ·
 *   5. Economics & connections · 6. Wiki & provenance
 *
 * A section with no data renders its honest empty state; none ever
 * disappears. The route resolves the page data (lib/entity/resolve),
 * the connections (lib/entity/connections), and the linked wiki entry,
 * and hands them here.
 */

import type { Faction, WikiEntry } from "@/lib/types";
import type { EntityConnection } from "@/lib/entity/connections";
import type { EntityPageData } from "@/lib/entity/types";
import { EntityEconomics } from "./EntityEconomics";
import { EntityFunction } from "./EntityFunction";
import { EntityGallery } from "./EntityGallery";
import { EntityHeader } from "./EntityHeader";
import { EntityStatus } from "./EntityStatus";
import { EntityWiki } from "./EntityWiki";

export function EntityPageSections({
  faction,
  data,
  homeCity,
  marketCities,
  connections,
  wikiEntry,
  viewerUid,
  viewerDisplay,
}: {
  faction: Faction;
  data: EntityPageData;
  /** Business pages: the resolved home-city faction (else null). */
  homeCity: Faction | null;
  /** Business pages: resolved "operates in" factions. */
  marketCities: Faction[];
  connections: EntityConnection[];
  wikiEntry: WikiEntry | null;
  viewerUid: string | null;
  viewerDisplay: string | null;
}) {
  return (
    <div className="space-y-4">
      <EntityHeader faction={faction} data={data} homeCity={homeCity} marketCities={marketCities} />
      <EntityFunction faction={faction} data={data} />
      <EntityGallery faction={faction} data={data} viewerUid={viewerUid} viewerDisplay={viewerDisplay} />
      <EntityStatus faction={faction} data={data} />
      <EntityEconomics faction={faction} data={data} connections={connections} />
      <EntityWiki faction={faction} data={data} wikiEntry={wikiEntry} />
    </div>
  );
}
