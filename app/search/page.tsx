"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getAllFactions, getPosts } from "@/lib/firestore/posts";
import { getAllWikiEntries } from "@/lib/firestore/wikiEntries";
import type { Faction, Post, WikiEntry } from "@/lib/types";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [entries, setEntries] = useState<WikiEntry[]>([]);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQ(initial);
    Promise.all([getPosts(), getAllFactions(), getAllWikiEntries()])
      .then(([postList, cityList, entryList]) => {
        setPosts(postList);
        setCities(cityList);
        setEntries(entryList);
      })
      .catch(() => undefined);
  }, []);

  const needle = q.trim().toLowerCase();
  const match = (value?: string | null) => (value || "").toLowerCase().includes(needle);
  const postHits = needle ? posts.filter((post) => match(post.title) || match(post.body) || match(post.era)) : [];
  const cityHits = needle ? cities.filter((city) => match(city.name) || match(city.bio) || match(city.lore) || match(city.slug)) : [];
  const wikiHits = needle ? entries.filter((entry) => match(entry.title) || match(entry.summary) || match(entry.body) || match(entry.slug)) : [];

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold text-accent-gold">Search the realm</h1>
        <input className="form-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Posts, cities, wiki" />
        {needle && (
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
