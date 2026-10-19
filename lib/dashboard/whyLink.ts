/**
 * Why-link target builder (Phase 3 brief §6.2). Pure.
 *
 * Every verified figure on the dashboard, city sheets, and entity pages
 * links to the Log page — there is no bespoke popover and no second
 * explanation surface. The link carries query state:
 *
 *   /log?city=<factionId>[&field=<fieldPath>][&anchor=<seq>][&entity=<ref>]
 *
 * Semantics (brief §6.2/§6.3):
 * - `anchor` is the figure's state-doc pointer (lastChangedSeq): the
 *   entry at that seq contains the changes[] line that last set the
 *   figure. Anchors resolve AT CLICK TIME against the standing Log: an
 *   anchor erased by a lawful undo lands on the filtered view at the
 *   nearest standing entry ≤ the anchor — no error, no "broken link"
 *   state, no tombstone (Phase 2's undo leaves none, by CJ's ruling).
 * - `field` drives the Log page's field-filtered browsing (client-side
 *   filter over fetched pages + explicit "Search older entries" —
 *   finite, user-driven, never auto-loading; TC-F01/F02).
 * - A figure with no anchor (a pre-allocation null, a figure that has
 *   never moved) has NO why-link: buildWhyLink returns null, and the
 *   caption next to the figure says why instead. Nothing to explain is
 *   not a broken link.
 *
 * Consumer note: the Phase 2 /log page as landed reads no query params
 * yet; consuming `city`/`field`/`anchor` is the brief §6.2 additive
 * amendment to that page, tracked in the Phase 3 prep report. This
 * module is the contract both sides build against.
 */

export interface WhyLinkArgs {
  /** Faction id (the Log entries' cityIds member). */
  cityId: string;
  /** Dotted field path as it appears in entries' changes[], e.g. "stats.treasuryRubars". */
  fieldPath?: string;
  /** The figure's lastChangedSeq anchor; null ⇒ no link. */
  anchorSeq?: number | null;
  /** Entity reference for entity-page figures (structure/corporation id). */
  entityRef?: string;
}

export function buildWhyLink(args: WhyLinkArgs): string | null {
  if (args.anchorSeq === null || args.anchorSeq === undefined) return null;
  const params = new URLSearchParams();
  params.set("city", args.cityId);
  if (args.fieldPath) params.set("field", args.fieldPath);
  params.set("anchor", String(args.anchorSeq));
  if (args.entityRef) params.set("entity", args.entityRef);
  return `/log?${params.toString()}`;
}

/**
 * Why-link for a single verified figure from its state doc pointers
 * (Dana §3.2 pattern, landed for sim_cities): the doc's lastChangedSeq
 * anchors the link; a doc that has never changed (null) yields null.
 */
export function whyLinkForStateDoc(args: {
  cityId: string;
  fieldPath: string;
  stateDoc: Record<string, unknown> | null;
  entityRef?: string;
}): string | null {
  const anchor = args.stateDoc?.lastChangedSeq;
  return buildWhyLink({
    cityId: args.cityId,
    fieldPath: args.fieldPath,
    anchorSeq: typeof anchor === "number" ? anchor : null,
    entityRef: args.entityRef,
  });
}

/**
 * Snapshot-level values (world-strip aggregates, grid compact stats)
 * why-link via the snapshot's resolution + seq (brief §6.2 last bullet):
 * the Log view for the resolution that produced the head.
 */
export function whyLinkForSnapshot(args: {
  resolutionId: string | null;
  asOfSeq: number | null;
}): string | null {
  if (!args.resolutionId || args.asOfSeq === null) return null;
  const params = new URLSearchParams();
  params.set("resolution", args.resolutionId);
  params.set("anchor", String(args.asOfSeq));
  return `/log?${params.toString()}`;
}
