/**
 * Why-links from entity surfaces to the Log (Phase 3 brief §6.2 pattern,
 * applied to entities per §8.2; spec §5.6).
 *
 * Every link targets the Phase 2 Log page with query state — city
 * filter, the anchor seq (the state doc's `lastChangedSeq`, whose entry's
 * `changes[]` contains the line that last set the figure), and optionally
 * the field the figure came from. Links resolve at click time against
 * the standing Log: an anchor erased by a lawful undo lands on the
 * filtered view at the nearest standing entry — no tombstones, no
 * error state (brief §6.3). A `null` seq means there is nothing to
 * explain yet, and callers render no link (pre-allocation honesty).
 */

export interface LogLinkOptions {
  cityId: string;
  anchorSeq?: number | null;
  field?: string | null;
  entityRef?: string | null;
}

export function logLink({ cityId, anchorSeq, field, entityRef }: LogLinkOptions): string {
  const params = new URLSearchParams();
  params.set("city", cityId);
  if (anchorSeq !== null && anchorSeq !== undefined) params.set("anchor", String(anchorSeq));
  if (field) params.set("field", field);
  if (entityRef) params.set("entity", entityRef);
  return `/log?${params.toString()}`;
}

/** "Everything that has happened to this building/business" (spec §6.2.7). */
export function entityLogLink(cityId: string, entityRef: string): string {
  return logLink({ cityId, entityRef });
}
