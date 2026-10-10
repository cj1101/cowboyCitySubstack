"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listThreads, type ForumThread } from "@/lib/firestore/forum";
import { getAllFactions, getPosts } from "@/lib/firestore/posts";
import { listSearchableTreaties, type StoredTreaty } from "@/lib/firestore/treaties";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import type { Faction, Post, WikiEntry } from "@/lib/types";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQ(initial);
    Promise.all([getPosts(), getAllFactions(), getAllWikiEntries(), listSearchableTreaties(), listThreads()])
      .then(([postList, cityList, entryList, treatyList, threadList]) => {
        setPosts(postList);
        setCities(cityList);
        setEntries(entryList);
        setTreaties(treatyList);
        setThreads(threadList);
      })
      .catch(() => setError("Search could not load the realm. Try again."))
      .finally(() => setLoading(false));
  }, []);

  const needle = q.trim().toLowerCase();
  const match = (value?: string | null) => (value || "").toLowerCase().includes(needle);
  const postHits = needle ? posts.filter((post) => match(post.title) || match(post.body) || match(post.era)) : [];
  const cityHits = needle ? cities.filter((city) => match(city.name) || match(city.bio) || match(city.lore) || match(city.slug)) : [];
  const wikiHits = needle ? entries.filter((entry) => match(entry.title) || match(entry.summary) || match(entry.body) || match(entry.slug)) : [];
  const treatyHits = needle ? treaties.filter((treaty) => match(treaty.name) || match(treaty.purpose) || match(treaty.terms) || match(treaty.nature)) : [];
  const threadHits = needle ? threads.filter((thread) => match(thread.title) || match(thread.body)) : [];

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-accent-gold">Search the realm</h1>
        <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cities, posts, treaties, forum" aria-label="Search" />
        {loading && <p className="text-text-muted text-sm">Loading the realm…</p>}
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        {needle && !loading && (
          <>
            <section>
              <h2 className="text-accent-gold font-bold mb-2">Cities</h2>
              {cityHits.map((city) => <Link key={city.id} href={`/cities/${city.slug}`} className="block py-1 hover:text-accent-gold">{city.name}</Link>)}
              {cityHits.length === 0 && <p className="text-text-muted text-sm">No cities.</p>}
            </section>
            <section>
              <h2 className="text-accent-gold font-bold mb-2">Posts</h2>
              {postHits.map((post) => <Link key={post.id} href={`/posts/${post.id}`} className="block py-1 hover:text-accent-gold">{post.title}</Link>)}
              {postHits.length === 0 && <p className="text-text-muted text-sm">No posts.</p>}
            </section>
            <section>
              <h2 className="text-accent-gold font-bold mb-2">Treaties</h2>
              {treatyHits.map((treaty) => (
                <Link key={treaty.id} href={`/treaties/${treaty.id}`} className="block py-1 hover:text-accent-gold">
                  {treaty.name} <span className="text-text-muted text-xs">{treaty.status}</span>
                </Link>
              ))}
              {treatyHits.length === 0 && <p className="text-text-muted text-sm">No treaties.</p>}
            </section>
            <section>
              <h2 className="text-accent-gold font-bold mb-2">Forum</h2>
              {threadHits.map((thread) => <Link key={thread.id} href={`/forum/${thread.id}`} className="block py-1 hover:text-accent-gold">{thread.title}</Link>)}
              {threadHits.length === 0 && <p className="text-text-muted text-sm">No threads.</p>}
            </section>
            <section>
              <h2 className="text-accent-gold font-bold mb-2">Wiki</h2>
              {wikiHits.map((entry) => (
                <Link key={entry.id} href={`/cities/${entry.citySlug}/wiki#${entry.slug}`} className="block py-1 hover:text-accent-gold">
                  {entry.title} <span className="text-text-muted text-xs">{entry.kind}</span>
                </Link>
              ))}
              {wikiHits.length === 0 && <p className="text-text-muted text-sm">No entries.</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
