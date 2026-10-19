"use client";

/**
 * The why-link results view (Phase 3 brief §6.2/§6.3).
 *
 * Where a why-link lands: the standing Log for one city, filtered
 * client-side to the entries whose `changes[]` touch the figure's
 * field. Firestore cannot query inside `changes[]` (Phase 1 excludes
 * it from indexing), so pages come from the landed `cityIds`
 * CONTAINS + `seq` DESC index in finite pages of 50 — and older
 * pages load ONLY when the user presses "Search older entries".
 * No auto-loading, no infinite scroll, no polling (TC-F01/F02).
 *
 * Anchor discipline (§6.3): the link's anchor seq is a request,
 * resolved HERE, at click time, against the standing entries this
 * view has actually scanned. An anchor erased by a lawful undo
 * lands on its nearest standing predecessor with no error, no
 * "broken link" state, and no editorializing; erased entries leave
 * no placeholder and seq gaps are never annotated. The visibility
 * merge mirrors the landed Log page exactly: public entries for
 * everyone, an actor-private entry only in its own actor's view
 * (badged private).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import { LOG_PAGE_SIZE, type WhyLinkQueryState } from "@/lib/stats/whyLink";
import {
  applyWhyLinkPage,
  createWhyLinkPager,
  matchedChangeLines,
  pagerAnchor,
  pagerCanSearchOlder,
  pagerMatches,
  pagerStatus,
  type WhyLinkPagerState,
} from "@/lib/stats/whyLinkPager";

/**
 * The actor-private badge test — the same predicate the landed Log
 * page uses (`lib/sim/log`'s `isActorPrivate`, Phase 2 §11.1): an
 * entry is actor-private iff its `visibility` is "actor-private"
 * (a Phase 1 landed value). Duplicated as one line, deliberately:
 * it keeps this module free of Phase-2-only imports at build time,
 * so the stat-sheets branch builds on Phase 1 master alone and
 * rebases cleanly whether or not PR #21 has landed yet.
 */
function isActorPrivate(entry: { visibility?: string }): boolean {
  return entry.visibility === "actor-private";
}

interface WhyEntry {
  seq: number;
  cityIds?: readonly string[] | null;
  changes?: readonly {
    field: string;
    before?: unknown;
    after?: unknown;
    formula?: string;
  }[] | null;
  summaryText?: string;
  kind?: string;
  visibility?: string;
  actorMemberId?: string | null;
  [key: string]: unknown;
}

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export default function WhyLinkResults({
  queryState,
  cityName,
}: {
  queryState: WhyLinkQueryState;
  cityName?: string;
}) {
  const { user } = useAuth();
  const cityId = queryState.cityId;
  const [pager, setPager] = useState<WhyLinkPagerState<WhyEntry> | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const cursorRef = useRef<QueryDocumentSnapshot<DocumentData> | null>(null);

  const fetchPage = useCallback(async (): Promise<WhyEntry[]> => {
    if (!cityId) return [];
    const db = getClientDb();
    const cursor = cursorRef.current;
    const snap = await getDocs(
      query(
        collection(db, "sim_log_entries"),
        where("cityIds", "array-contains", cityId),
        orderBy("seq", "desc"),
        ...(cursor ? [startAfter(cursor)] : []),
        limit(LOG_PAGE_SIZE)
      )
    );
    cursorRef.current = snap.docs[snap.docs.length - 1] ?? cursorRef.current;
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        ...(data as Record<string, unknown>),
        seq: (data.seq as number) ?? 0,
        actorMemberId:
          (data.actor as DocumentData | undefined)?.memberId ?? null,
      } as WhyEntry;
    });
  }, [cityId]);

  // First page on mount / when the link target changes. Resolution of
  // the anchor happens against THIS scan — click time, standing Log.
  useEffect(() => {
    let cancelled = false;
    cursorRef.current = null;
    setPager(null);
    setFailed(false);
    if (!cityId) return;
    setLoading(true);
    fetchPage()
      .then((page) => {
        if (cancelled) return;
        setPager(
          applyWhyLinkPage(
            createWhyLinkPager<WhyEntry>(cityId, queryState.fieldPath),
            page
          )
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cityId, queryState.fieldPath, fetchPage]);

  const searchOlder = async () => {
    if (!pager || !pagerCanSearchOlder(pager) || loading) return;
    setLoading(true);
    try {
      const page = await fetchPage();
      setPager((current) => (current ? applyWhyLinkPage(current, page) : current));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  // The landed page's merge discipline: public entries render for
  // everyone; an actor-private entry renders only for its own actor.
  const visiblePager = useMemo<WhyLinkPagerState<WhyEntry> | null>(() => {
    if (!pager) return null;
    return {
      ...pager,
      scanned: pager.scanned.filter(
        (entry) =>
          !isActorPrivate(entry) ||
          (user !== null && entry.actorMemberId === user.uid)
      ),
    };
  }, [pager, user]);

  if (!cityId) {
    return <p>No city was named for this why-link, so there is nothing to search.</p>;
  }
  if (failed && !visiblePager) {
    return <p>The Log couldn&apos;t be read just now. Nothing is shown rather than something wrong.</p>;
  }
  if (!visiblePager) {
    return <p>Searching the Log…</p>;
  }

  const matches = pagerMatches(visiblePager);
  // Anchor resolution lands in the FILTERED view (§6.2; P3-G6-C3):
  // with a field filter active, the anchor resolves over the matched
  // entries, so the landing entry is always one that actually changed
  // the figure — including when the requested anchor was erased and
  // the nearest standing match at or below it is the landing. With no
  // field filter, matches ARE the scan and this is the same state.
  const anchorPager: WhyLinkPagerState<WhyEntry> =
    queryState.fieldPath === null
      ? visiblePager
      : { ...visiblePager, scanned: matches };
  const anchor = pagerAnchor(anchorPager, queryState.anchorSeq);
  const status = pagerStatus(visiblePager);
  const fieldLabel = queryState.fieldPath ?? "any figure";
  const cityLabel = cityName ?? cityId;

  return (
    <section aria-label="Why this figure — Log entries">
      <h3 className="hud-title">
        Entries changing {fieldLabel} for {cityLabel} — searching newest first
      </h3>

      {matches.length === 0 ? (
        <p>
          {status === "scan-complete-no-matches"
            ? "No standing entries change this figure."
            : "No entries in the pages searched so far change this figure."}
        </p>
      ) : (
        <ol>
          {matches.map((entry) => (
            <li
              key={entry.seq}
              aria-current={anchor.resolvedSeq === entry.seq ? "true" : undefined}
              className={
                anchor.resolvedSeq === entry.seq
                  ? "border-2 border-ink bg-white"
                  : undefined
              }
            >
              <p>
                Log #{entry.seq}
                {isActorPrivate(entry) ? " · private to you" : ""}
                {entry.summaryText ? ` — ${entry.summaryText}` : ""}
              </p>
              <ul>
                {matchedChangeLines(visiblePager, entry).map((change, i) => (
                  <li key={`${change.field}-${i}`}>
                    {change.field}: {formatChangeValue(change.before)} →{" "}
                    {formatChangeValue(change.after)}
                    {change.formula ? ` (${change.formula})` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {pagerCanSearchOlder(visiblePager) ? (
        <button type="button" onClick={searchOlder} disabled={loading}>
          {loading ? "Searching…" : "Search older entries"}
        </button>
      ) : (
        <p>You&apos;ve reached the oldest standing entry for this city.</p>
      )}
      {failed ? <p>The last search didn&apos;t complete — what&apos;s shown above still stands.</p> : null}
    </section>
  );
}
