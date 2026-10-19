/**
 * Economics & connections — link resolution (Phase 3 brief §8.2.5;
 * spec §6.2.6).
 *
 * Every connection on an entity page is a link to that entity's own
 * page — never an embedded copy (brief §8.1). This module is pure: it
 * turns a resolved entity plus the caller's already-fetched city data
 * into link descriptors. References whose target has no page in
 * Phase 3 (resident households, staff characters — their page routes
 * land with later phases) resolve with `href: null` and render as the
 * recorded references they are; nothing is dressed up as a link to
 * nowhere, and no name is invented for an unresolved ID.
 */

import type { Faction } from "@/lib/types";
import { buildingPath, businessPath, cityPath } from "./paths";
import type { SimCorporation, SimStructure } from "./types";

export interface EntityConnection {
  /** The relationship, e.g. "Premises", "Staff business". */
  label: string;
  /** Display text: the target's recorded name, or its recorded ID
   * when the target record wasn't in the caller's read set. */
  name: string;
  /** The target entity's own page, or null when Phase 3 has no page
   * for that kind of record. */
  href: string | null;
}

export interface ConnectionContext {
  /** Same-city corporations, for resolving a structure's staff
   * businesses (corporation records live in one city's subcollection;
   * cross-city staff references resolve by ID only). */
  corporations: SimCorporation[];
  /** Same-city structures, for resolving a corporation's premises. */
  structures: SimStructure[];
  /** Every faction the caller loaded, keyed by faction id — resolves
   * home/market/endpoint city links. */
  factionsById: ReadonlyMap<string, Faction>;
}

function cityConnection(
  label: string,
  cityId: string,
  ctx: ConnectionContext,
  fallbackName?: string | null
): EntityConnection {
  const faction = ctx.factionsById.get(cityId);
  return {
    label,
    name: faction?.name ?? fallbackName ?? cityId,
    href: faction ? cityPath(faction.slug) : null,
  };
}

export function structureConnections(
  hostFaction: Faction,
  structure: SimStructure,
  ctx: ConnectionContext
): EntityConnection[] {
  const out: EntityConnection[] = [];

  for (const corpId of structure.staffCorporationIds) {
    const corp = ctx.corporations.find((c) => c.id === corpId);
    out.push({
      label: "Staff business",
      name: corp?.name ?? corpId,
      href: corp ? businessPath(hostFaction.slug, corp.slug) : null,
    });
  }

  for (const householdId of structure.residentHouseholdIds) {
    out.push({ label: "Resident household", name: householdId, href: null });
  }

  for (const figureId of structure.staffFigureIds) {
    out.push({ label: "Staff (character)", name: figureId, href: null });
  }

  const endpointIds = structure.profile.endpointCityIds ?? [];
  const endpointLabels = structure.profile.endpointLabels ?? [];
  endpointIds.forEach((cityId, i) => {
    out.push(cityConnection("Endpoint city", cityId, ctx, endpointLabels[i] ?? null));
  });

  return out;
}

export function corporationConnections(
  hostFaction: Faction,
  corporation: SimCorporation,
  ctx: ConnectionContext
): EntityConnection[] {
  const out: EntityConnection[] = [];

  for (const structureId of corporation.linkedStructureIds) {
    const structure = ctx.structures.find((s) => s.id === structureId);
    out.push({
      label: "Premises",
      name: structure?.name ?? structureId,
      href: structure ? buildingPath(hostFaction.slug, structure.slug) : null,
    });
  }

  if (corporation.homeCityId && corporation.homeCityId !== hostFaction.id) {
    out.push(cityConnection("Home city", corporation.homeCityId, ctx));
  }

  for (const cityId of corporation.marketCityIds) {
    if (cityId === hostFaction.id) continue;
    out.push(cityConnection("Operates in", cityId, ctx));
  }

  return out;
}
