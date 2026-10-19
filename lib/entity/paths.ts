/**
 * Entity URL paths (Phase 3 brief §8.1; spec §6.1).
 *
 * Canonical entity pages live under the host city — the city whose
 * structures/corporations subcollection holds the record:
 *   /factions/[slug]/buildings/[structureSlug]
 *   /factions/[slug]/businesses/[corporationSlug]
 * Slug renames redirect to the canonical slug (URLs get pasted into
 * Discord — spec §6.1 / TC-G06).
 */

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildingPath(citySlug: string, structureSlug: string): string {
  return `/factions/${citySlug}/buildings/${structureSlug}`;
}

export function businessPath(citySlug: string, corporationSlug: string): string {
  return `/factions/${citySlug}/businesses/${corporationSlug}`;
}

export function cityPath(citySlug: string): string {
  return `/factions/${citySlug}`;
}

export function cityMapPath(citySlug: string): string {
  return `/factions/${citySlug}/map`;
}

/** City map deep link with a pin highlighted/open (spec §6.5.5). */
export function cityMapPinPath(citySlug: string, pinId: string): string {
  return `${cityMapPath(citySlug)}?pin=${encodeURIComponent(pinId)}`;
}

/** Wiki entry page under its city (the third corner of the triangle). */
export function wikiEntryPath(citySlug: string, entrySlug: string): string {
  return `/factions/${citySlug}/wiki?entry=${encodeURIComponent(entrySlug)}`;
}
