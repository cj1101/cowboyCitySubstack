/**
 * The why-link field-filtered paging machine (Phase 3 brief §6.2).
 *
 * The Log page's landed read pattern is finite pages of 50, newest
 * first, cursor on seq (Phase 2 §11.1). A why-link view is narrower:
 * one city (served by the landed `cityIds` CONTAINS + `seq` DESC
 * index), then a client-side filter to entries whose `changes[]`
 * touch the figure's field — Firestore cannot query inside
 * `changes[]`, and Phase 1 excludes `changes` from indexing, so no
 * field-exact query exists and none is faked here (P3-D10).
 *
 * Paging is explicit and finite: the view fetches one page at a time,
 * only when the user asks ("Search older entries"). Nothing
 * auto-loads, polls, or scrolls infinitely (TC-F01/F02). The scan is
 * complete in the only sense that matters: every standing entry for
 * the city is reachable by repeated explicit paging, and the machine
 * never claims a total it has not fetched.
 *
 * Anchor resolution runs over the scanned range at click time
 * (§6.3): an anchor seq erased by a lawful undo resolves to the
 * nearest standing entry at or below it once the scan has passed it;
 * before that, resolution is provisional and the view says nothing
 * final. No tombstones, no gap annotations — erased entries are
 * simply absent from every page this machine consumes.
 *
 * Pure: pages in, view state out. No I/O, no clock.
 */

import {
  LOG_PAGE_SIZE,
  anchorResolutionIsFinal,
  entryTouchesCity,
  entryTouchesField,
  resolveAnchorSeq,
  type WhyLinkEntryLike,
} from "./whyLink";

export interface WhyLinkPagerState<Entry extends WhyLinkEntryLike = WhyLinkEntryLike> {
  /** The city this scan is scoped to. Entries outside it never enter. */
  cityId: string;
  /** The field the view filters to; null = every entry for the city. */
  fieldPath: string | null;
  /** Standing entries scanned so far, seq descending, deduped by seq. */
  scanned: Entry[];
  /** Pages consumed so far. */
  pagesFetched: number;
  /** True once a short page (< LOG_PAGE_SIZE) came back: the standing
   * Log for this city is fully scanned. */
  exhausted: boolean;
}

export function createWhyLinkPager<Entry extends WhyLinkEntryLike>(
  cityId: string,
  fieldPath: string | null
): WhyLinkPagerState<Entry> {
  return { cityId, fieldPath, scanned: [], pagesFetched: 0, exhausted: false };
}

/**
 * Fold one fetched page into the scan. The page is the fetcher's raw
 * result (city-scoped by query); entries are still re-checked against
 * the city predicate — a page is data, and the machine trusts its own
 * predicates, not the query. Out-of-order or duplicate seqs are
 * normalized away. A short page marks the scan exhausted; a full page
 * never does (one more fetch is the only way to learn).
 */
export function applyWhyLinkPage<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>,
  page: readonly Entry[]
): WhyLinkPagerState<Entry> {
  if (state.exhausted) return state;
  const bySeq = new Map<number, Entry>();
  for (const entry of state.scanned) bySeq.set(entry.seq, entry);
  for (const entry of page) {
    if (entryTouchesCity(entry, state.cityId)) bySeq.set(entry.seq, entry);
  }
  const scanned = [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  return {
    ...state,
    scanned,
    pagesFetched: state.pagesFetched + 1,
    exhausted: page.length < LOG_PAGE_SIZE,
  };
}

/** The entries the view renders: the scan, field-filtered when the
 * link named a field. Newest first, always. */
export function pagerMatches<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>
): Entry[] {
  if (state.fieldPath === null) return [...state.scanned];
  const fieldPath = state.fieldPath;
  return state.scanned.filter((entry) => entryTouchesField(entry, fieldPath));
}

/** The change lines of one entry that the view's field filter matched
 * (all lines when unfielded) — what the row expands to show. The
 * entry's own change-line type is preserved, so callers keep the
 * landed `before`/`after`/`formula` fields. */
export function matchedChangeLines<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>,
  entry: Entry
): readonly NonNullable<Entry["changes"]>[number][] {
  const changes = (entry.changes ?? []) as readonly NonNullable<
    Entry["changes"]
  >[number][];
  if (state.fieldPath === null) return changes;
  const fieldPath = state.fieldPath;
  return changes.filter((change) => change.field === fieldPath);
}

export interface PagerAnchorResolution {
  /** The standing seq the view lands on, or null when no scanned entry
   * sits at or below the anchor yet. */
  resolvedSeq: number | null;
  /** True when the scan has passed the anchor, so `resolvedSeq` is
   * the true standing predecessor and no older page can change it. */
  isFinal: boolean;
  /** True when the anchor seq itself is standing in the scan (the
   * common case: nothing was undone). False + final = the anchor was
   * erased and the view landed on its predecessor, silently (§6.3). */
  anchorStanding: boolean;
}

/** Resolve a why-link's requested anchor against the scan so far. */
export function pagerAnchor<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>,
  anchorSeq: number | null
): PagerAnchorResolution {
  if (anchorSeq === null) {
    return { resolvedSeq: null, isFinal: true, anchorStanding: false };
  }
  const seqsDesc = state.scanned.map((entry) => entry.seq);
  return {
    resolvedSeq: resolveAnchorSeq(seqsDesc, anchorSeq),
    isFinal: state.exhausted || anchorResolutionIsFinal(seqsDesc, anchorSeq),
    anchorStanding: seqsDesc.includes(anchorSeq),
  };
}

/** Can the user search further back? Only an unexhausted scan can. */
export function pagerCanSearchOlder<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>
): boolean {
  return !state.exhausted;
}

/**
 * Honest scan status copy (brief §6.2's labeling discipline). The
 * view labels itself; it never claims completeness it hasn't earned.
 */
export type PagerStatus =
  | "no-pages-yet"
  | "matches-found"
  | "no-matches-in-scan"
  | "scan-complete-no-matches"
  | "scan-complete";

export function pagerStatus<Entry extends WhyLinkEntryLike>(
  state: WhyLinkPagerState<Entry>
): PagerStatus {
  if (state.pagesFetched === 0) return "no-pages-yet";
  const hasMatches = pagerMatches(state).length > 0;
  if (state.exhausted) return hasMatches ? "scan-complete" : "scan-complete-no-matches";
  return hasMatches ? "matches-found" : "no-matches-in-scan";
}
