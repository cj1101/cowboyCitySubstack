/**
 * Display formatting for preview records (Phase 4 brief §2.2).
 *
 * Pure functions over the stored preview's values — the same honesty
 * discipline as the Phase 3 stat surfaces: a null renders as "—"
 * (the value is *unknown/not yet real*, never a fabricated 0), and
 * numbers render in the house figure style. Nothing here derives a
 * number the preview did not state.
 */

import type { PlayDelta } from "./types";

/** The house empty-value marker (Phase 3 stat surfaces). */
export const EMPTY_VALUE = "—";

export function formatFigureValue(value: number): string {
  return value.toLocaleString("en-US");
}

/** Render any preview value the way a member should read it. */
export function formatSimValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_VALUE;
  if (typeof value === "number") {
    return Number.isFinite(value) ? formatFigureValue(value) : String(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value === "" ? EMPTY_VALUE : value;
  if (Array.isArray(value)) {
    return value.length === 0 ? EMPTY_VALUE : value.map(formatSimValue).join(", ");
  }
  return JSON.stringify(value);
}

/** A delta field is Rubar-denominated when its (possibly
 * target-qualified) leaf name says so: `treasuryRubars`,
 * `structures/<id>.valueRubars`, … */
export function isRubarField(field: string): boolean {
  const leaf = field.split(".").pop() ?? field;
  return /rubars$/i.test(leaf);
}

/** Format a value in the context of its field: Rubar amounts carry
 * the currency word, in the Phase 3 house style ("1,000 Rubars"). */
export function formatFieldValue(field: string, value: unknown): string {
  const rendered = formatSimValue(value);
  if (rendered === EMPTY_VALUE) return rendered;
  return isRubarField(field) ? `${rendered} Rubars` : rendered;
}

/**
 * A readable label for a preview field path. Fields are
 * target-qualified where the target matters (the Phase 2 verifier's
 * convention): `structures/<id>.status` reads "Structure <id> ·
 * status"; a plain stat field reads as its humanized name.
 */
export function fieldLabel(field: string): string {
  const segments = field.split(".");
  const humanize = (segment: string) =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/^./, (c) => c.toUpperCase());
  if (segments.length >= 3) {
    const [collection, id, ...rest] = segments;
    const singular = collection.endsWith("s") ? collection.slice(0, -1) : collection;
    return `${humanize(singular)} ${id} · ${rest.map(humanize).join(" · ").toLowerCase()}`;
  }
  return segments.map(humanize).join(" · ");
}

/** Group a preview's deltas by the city they land on, preserving the
 * preview's own order (the resolver's order is the record's order). */
export function groupDeltasByCity(deltas: PlayDelta[]): { cityId: string; deltas: PlayDelta[] }[] {
  const groups: { cityId: string; deltas: PlayDelta[] }[] = [];
  const byCity = new Map<string, PlayDelta[]>();
  for (const delta of deltas) {
    let bucket = byCity.get(delta.cityId);
    if (!bucket) {
      bucket = [];
      byCity.set(delta.cityId, bucket);
      groups.push({ cityId: delta.cityId, deltas: bucket });
    }
    bucket.push(delta);
  }
  return groups;
}

/** The money lines of a preview: Rubar-denominated deltas with two
 * numeric endpoints, as net movement per field — the confirmation
 * card's "what it costs" is exactly these, nothing inferred. */
export function rubarMovements(
  deltas: PlayDelta[]
): { cityId: string; field: string; amount: number }[] {
  const movements: { cityId: string; field: string; amount: number }[] = [];
  for (const delta of deltas) {
    if (!isRubarField(delta.field)) continue;
    if (typeof delta.before !== "number" || typeof delta.after !== "number") continue;
    const amount = delta.after - delta.before;
    if (amount !== 0) movements.push({ cityId: delta.cityId, field: delta.field, amount });
  }
  return movements;
}

/** Signed figure for movement lines: "+500 Rubars" / "−500 Rubars". */
export function formatSignedRubars(amount: number): string {
  const sign = amount > 0 ? "+" : "−";
  return `${sign}${formatFigureValue(Math.abs(amount))} Rubars`;
}

/** A short, recognizable prefix of a hash for display. The full hash
 * stays on the record; the card shows enough to tell two previews
 * apart, never a truncated thing a member could mistake for the
 * binding value itself. */
export function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 12)}…`;
}
