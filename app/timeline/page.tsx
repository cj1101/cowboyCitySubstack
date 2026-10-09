"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getAllFactions, getSettlementPosts } from "@/lib/firestore/posts";
import type { Faction, Post } from "@/lib/types";

export default function TimelinePage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [cityId, setCityId] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([getSettlementPosts(), getAllFactions()])
      .then(([dated, cityList]) => {
        setPosts(dated);
        setCities(cityList);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const names = new Map(cities.map((city) => [city.id, city]));
  const visible = posts.filter((post) => {
    if (!cityId) return true;
    return post.factionId === cityId || (post.cityIds ?? []).includes(cityId);
  });

  const groups = new Map<string, Post[]>();
  for (const post of visible) {
    const key = `${post.era || "Undated era"} · Year ${post.settlementYear}`;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="glass-panel p-6">
          <h1 className="text-3xl font-bold text-accent-gold">Settlement timeline</h1>
          <p className="text-text-muted mt-2">In-world dates, newest settlement years first, every city on one chronicle.</p>
          <select className="form-input mt-4" value={cityId} onChange={(e) => setCityId(e.target.value)} aria-label="Filter by city">
            <option value="">All cities</option>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
        </div>
        {loading && <p className="text-text-muted">Loading timeline…</p>}
        {!loading && visible.length === 0 && <p className="text-text-muted">No posts carry a Settlement Year yet.</p>}
        {[...groups.entries()].map(([label, items]) => (
          <section key={label}>
            <h2 className="text-accent-gold font-bold mb-2">{label}</h2>
            <div className="space-y-3">
              {items.map((post) => (
                <article key={post.id} className="glass-panel p-4">
                  <p className="text-xs text-text-muted">{names.get(post.factionId)?.name} · {post.type}</p>
                  <Link href={`/posts/${post.id}`} className="font-bold hover:text-accent-gold">{post.title}</Link>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
