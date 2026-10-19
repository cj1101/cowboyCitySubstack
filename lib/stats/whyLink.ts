/**
 * Why-link target building + anchor arithmetic (Phase 3 brief §6.2/§6.3).
 *
 * Every verified figure on a Phase 3 surface links to the Log page with
 * query state — there is no bespoke popover and no second explanation
 * surface. This module is the pure half of that pattern:
 *
 *  - the href contract (`/log?city=…&field=…&anchor=…`),
 *  - the field/city predicates the field-filtered paging runs on
 *    (Firestore cannot query inside `changes[]`, and Phase 1 excludes
 *    `changes` from indexing — a field-exact query does not exist, so
 *    filtering is client-side over fetched pages, per P3-D10),
 *  - click-time anchor resolution against the standing Log (an anchor
 *    seq erased by a lawful undo resolves to the nearest standing entry
 *    at or below it — no error, no tombstone, no gap annotation),
 *  - "since" anchor clamping: seq can DECREASE after an undo, so a
 *    per-user since-anchor above the current head clamps silently to
 *    the head ("You're caught up") and never implies missing entries.
 *
 * Pure: no I/O, no Firestore, no clock.
 */

/** Phase 2 §11.1 pagination: the Log is read in finite pages of 50. */
export const LOG_PAGE_SIZE = 50;

/** The figure fields a why-link can name, as landed `changes[].field`
 * dot-paths (Phase 1 template + Phase 2 rules: `stats.<key>`). */
export function statFieldPath(statKey: string): string {
  return `stats.${statKey}`;
}

export interface WhyLinkRequest {
  /** The city whose Log view the link opens (a factionId). */
  cityId: string;
  /** The `changes[].field` dot-path the figure answers to, e.g.
   * `stats.treasuryRubars`. Null for a city-level (unfielded) link. */
  fieldPath: string | null;
  /** The state doc's `lastChangedSeq` pointer at render time. The link
   * carries it as a REQUEST; resolution against the standing Log
   * happens at click time (see `resolveAnchorSeq`), because a lawful
   * undo may have erased that entry in between. Null ⇒ no anchor
   * (figure never changed by a resolution; nothing to anchor to). */
  anchorSeq: number | null;
  /** Entity scope where the entry's references support it (a structure
   * or corporation id inside the city). Optional and additive. */
  entityRef?: string | null;
}

export interface WhyLinkQueryState {
  cityId: string | null;
  fieldPath: string | null;
  anchorSeq: number | null;
  entityRef: string | null;
}

/** Build the `/log` href for a why-link. Null parts are omitted, never
 * serialized as placeholders. */
export function buildWhyLinkHref(request: WhyLinkRequest): string {
  const params = new URLSearchParams();
  params.set("city", request.cityId);
  if (request.fieldPath) params.set("field", request.fieldPath);
  if (request.anchorSeq !== null && request.anchorSeq !== undefined) {
    params.set("anchor", String(request.anchorSeq));
  }
  if (request.entityRef) params.set("entity", request.entityRef);
  return `/log?${params.toString()}`;
}

/** Tolerant parse of why-link query state (from `URLSearchParams` or a
 * Next `searchParams` record). A malformed anchor is treated as absent
 * — an anchor is presentation state and must degrade silently (§6.3). */
export function parseWhyLinkQuery(
  params: URLSearchParams | Record<string, string | string[] | undefined>
): WhyLinkQueryState {
  const get = (key: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(key);
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };
  const rawAnchor = get("anchor");
  const anchorSeq =
    rawAnchor !== null && /^\d+$/.test(rawAnchor)
      ? Number.parseInt(rawAnchor, 10)
      : null;
  return {
    cityId: get("city"),
    fieldPath: get("field"),
    anchorSeq,
    entityRef: get("entity"),
  };
}

// ---------------------------------------------------------------------------
// Entry predicates — the field-filtered browsing of §6.2 runs on these.
// Entries are consumed in the Phase 2 landed shape (`lib/sim/log.ts`):
// `cityIds` carries every touched city, `changes[]` lines carry
// { field, before, after, formula }.
// ---------------------------------------------------------------------------

export interface WhyLinkEntryLike {
  seq: number;
  cityId?: string | null;
  cityIds?: readonly string[] | null;
  changes?: readonly { field: string }[] | null;
  [key: string]: unknown;
}

/** Does this entry touch the city at all? */
export function entryTouchesCity(entry: WhyLinkEntryLike, cityId: string): boolean {
  if (entry.cityId === cityId) return true;
  return (entry.cityIds ?? []).includes(cityId);
}

/** Does this entry's `changes[]` set the named field? */
export function entryTouchesField(
  entry: WhyLinkEntryLike,
  fieldPath: string
): boolean {
  return (entry.changes ?? []).some((change) => change.field === fieldPath);
}

// ---------------------------------------------------------------------------
// Anchor resolution (§6.3) — click time, against the standing Log.
// ---------------------------------------------------------------------------

/**
 * Resolve a requested anchor seq against the standing seqs known so far
 * (descending). Returns the nearest standing seq at or below the anchor
 * — the entry the Log view should land on — or null when every standing
 * entry is newer than the anchor (nothing at-or-below exists yet in the
 * scanned range). An erased anchor seq is not an error and leaves no
 * trace: it simply resolves to its standing predecessor.
 */
export function resolveAnchorSeq(
  standingSeqsDesc: readonly number[],
  anchorSeq: number
): number | null {
  for (const seq of standingSeqsDesc) {
    if (seq <= anchorSeq) return seq;
  }
  return null;
}

/**
 * Whether anchor resolution is FINAL for a scanned range: once the
 * smallest scanned seq is at or below the anchor, the largest scanned
 * seq at or below the anchor is the true standing predecessor — no
 * older page can change it. Before that, resolution is provisional.
 */
export function anchorResolutionIsFinal(
  standingSeqsDesc: readonly number[],
  anchorSeq: number
): boolean {
  if (standingSeqsDesc.length === 0) return false;
  return standingSeqsDesc[standingSeqsDesc.length - 1] <= anchorSeq;
}

// ---------------------------------------------------------------------------
// "Since" anchors (§6.3) — per-user presentation state, seq-decrease-safe.
// ---------------------------------------------------------------------------

export interface SinceAnchorState {
  /** The effective since-anchor after clamping (never above the head). */
  sinceSeq: number | null;
  /** True when the anchor met or passed the head — "You're caught up". */
  caughtUp: boolean;
  /** True when the stored anchor exceeded the head and was clamped
   * (the signature of a lawful undo lowering the head). Degrades
   * silently by contract; the flag exists for tests and honest copy. */
  clamped: boolean;
}

/**
 * Clamp a stored per-user "since" anchor against the current Log head.
 * Seq can decrease after an undo (Phase 2 §8.7), so an anchor above the
 * head is presentation state outliving the world it pointed at: clamp
 * to the head and report caught-up. Never throws, never implies that
 * entries are missing.
 */
export function clampSinceAnchor(
  sinceSeq: number | null,
  headSeq: number
): SinceAnchorState {
  if (sinceSeq === null) {
    return { sinceSeq: null, caughtUp: false, clamped: false };
  }
  if (sinceSeq > headSeq) {
    return { sinceSeq: headSeq, caughtUp: true, clamped: true };
  }
  return { sinceSeq, caughtUp: sinceSeq >= headSeq, clamped: false };
}

/** Count of standing entries newer than a (clamped) since-anchor —
 * the digest's "N new" figure, computed only from entries actually
 * fetched, never from seq arithmetic across a possible undo gap. */
export function countNewerThan(
  standingSeqsDesc: readonly number[],
  sinceSeq: number | null
): number {
  if (sinceSeq === null) return standingSeqsDesc.length;
  return standingSeqsDesc.filter((seq) => seq > sinceSeq).length;
}
