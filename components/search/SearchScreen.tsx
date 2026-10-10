"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAllFactions } from "@/lib/firestore/factions";
import { backfillSearchTokens } from "@/lib/firestore/searchBackfill";
import { searchRealm, type SearchHit, type SearchResults } from "@/lib/firestore/search";
import { queryWords } from "@/lib/search/tokens";
import { isSheriff } from "@/lib/membership";
import { actionError } from "@/lib/async";

const GROUPS: { key: keyof SearchResults; label: string }[] = [
  { key: "cities", label: "Cities" },
  { key: "posts", label: "Posts" },
  { key: "treaties", label: "Treaties" },
  { key: "threads", label: "Forum" },
  { key: "wiki", label: "Wiki" },
];

function HitList({ hits }: { hits: SearchHit[] }) {
  if (hits.length === 0) return <p className="text-text-muted text-sm">Nothing in this group.</p>;
  return (
    <ul className="space-y-2">
      {hits.map((hit) => (
        <li key={`${hit.kind}-${hit.id}`}>
          <Link href={hit.href} className="block glass-panel p-4 hover:border-accent-cyan">
            <span className="font-bold text-accent-gold">{hit.title}</span>
            {hit.snippet && <span className="block text-sm text-text-muted mt-1">{hit.snippet}</span>}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SearchScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, profile } = useAuth();
  const initial = params.get("q") || "";
  const [q, setQ] = useState(initial);
  const [ownsCity, setOwnsCity] = useState(false);
  const [accessReady, setAccessReady] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [indexMessage, setIndexMessage] = useState("");
  const [indexing, setIndexing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sheriff = isSheriff(profile, user?.email);

  useEffect(() => {
    setQ(initial);
  }, [initial]);

  useEffect(() => {
    if (!user) {
      setAccessReady(true);
      return;
    }
    getAllFactions()
      .then((cities) => setOwnsCity(cities.some((city) => city.ownerUids?.includes(user.uid))))
      .catch(() => setOwnsCity(false))
      .finally(() => setAccessReady(true));
  }, [user]);

  useEffect(() => {
    if (!accessReady || !user) return;
    const needle = q.trim();
    if (queryWords(needle).length === 0) {
      setResults(null);
      setLoading(false);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      searchRealm(needle, { uid: user.uid, ownsCity })
        .then((found) => {
          if (!cancelled) setResults(found);
        })
        .catch((err) => {
          if (!cancelled) {
            const message = actionError(err, "Search failed.");
            setError(/index/i.test(message)
              ? "Search needs a Firestore index on treaties (status + searchTokens). A sheriff still has to deploy that index."
              : message);
            setResults(null);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, user, ownsCity, accessReady, attempt]);

  const runBackfill = useCallback(async () => {
    setIndexing(true);
    setIndexMessage("");
    setError("");
    try {
      const result = await backfillSearchTokens();
      const message = result.updated === 0
        ? "Search index is already up to date."
        : `Indexed ${result.updated} older record${result.updated === 1 ? "" : "s"} for search.`;
      setIndexMessage(message);
      sessionStorage.setItem("realm-search-backfill-v1", "done");
    } catch (err) {
      setError(actionError(err, "Could not index older records."));
    } finally {
      setIndexing(false);
    }
  }, []);

  useEffect(() => {
    if (!sheriff || !user) return;
    if (sessionStorage.getItem("realm-search-backfill-v1") === "done") return;
    void runBackfill();
  }, [sheriff, user, runBackfill]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const needle = q.trim();
    router.replace(needle ? `/search?q=${encodeURIComponent(needle)}` : "/search");
  };

  const total = results
    ? GROUPS.reduce((sum, group) => sum + results[group.key].length, 0)
    : 0;
  const short = q.trim().length > 0 && queryWords(q).length === 0;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header>
          <h1 className="text-3xl font-bold text-accent-gold">Search the realm</h1>
          <p className="text-text-muted text-sm mt-2">
            Finds cities, posts, treaties, and forum threads from keywords saved with each record. There is no separate search server.
          </p>
        </header>
        <form onSubmit={submit} className="flex flex-col sm:flex-row gap-2" role="search">
          <label className="sr-only" htmlFor="realm-search-page">Search</label>
          <input
            id="realm-search-page"
            className="form-input min-h-11 flex-1"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Try a city, treaty, or thread"
            autoComplete="off"
          />
          <button className="btn min-h-11" type="submit" disabled={loading} aria-busy={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
        {short && <p className="text-sm text-text-muted">Type at least two letters.</p>}
        {loading && <p className="text-text-muted" role="status">Searching…</p>}
        {error && (
          <p className="text-sm font-bold" role="alert">
            {error}{" "}
            <button type="button" className="btn btn-secondary text-sm px-3 py-1.5 ml-2 min-h-11" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>
              {loading ? "Searching…" : "Try again"}
            </button>
          </p>
        )}
        {indexMessage && <p className="text-sm font-bold text-accent-gold" role="status">{indexMessage}</p>}
        {sheriff && (
          <button type="button" className="btn btn-secondary text-sm px-3 py-1.5 min-h-11" disabled={indexing} onClick={runBackfill}>
            {indexing ? "Indexing…" : "Index older records"}
          </button>
        )}
        {results && !loading && total === 0 && (
          <p className="text-text-muted">No matches. A sheriff can index older records that were saved before search keywords existed.</p>
        )}
        {results && GROUPS.map((group) => (
          results[group.key].length > 0 ? (
            <section key={group.key}>
              <h2 className="text-accent-gold font-bold mb-2">{group.label}</h2>
              <HitList hits={results[group.key]} />
            </section>
          ) : null
        ))}
      </div>
    </div>
  );
}
