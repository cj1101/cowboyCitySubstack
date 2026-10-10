"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { PostCard } from "@/components/posts/PostCard";
import {
  getAllFactions,
  getCharactersMap,
  getFactionsMap,
  getPosts,
  publishDueScheduledPosts,
} from "@/lib/firestore/posts";
import { getFollowedCityIds } from "@/lib/firestore/follows";
import type { Character, Faction, Post } from "@/lib/types";

export function GlobalFeed() {
  const { user, loading: authLoading } = useAuth();
  const [posts, setPosts] = useState<Post[]>([]);
  const [factions, setFactions] = useState<Faction[]>([]);
  const [factionsMap, setFactionsMap] = useState<Map<string, Faction>>(new Map());
  const [charactersMap, setCharactersMap] = useState<Map<string, Character>>(
    new Map()
  );
  const [factionFilter, setFactionFilter] = useState<string>("");
  const [followingOnly, setFollowingOnly] = useState(false);
  const [followed, setFollowed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getAllFactions()
      .then(setFactions)
      .catch(() => setFactions([]));
    publishDueScheduledPosts(user.uid).catch(() => undefined);
    getFollowedCityIds(user.uid).then(setFollowed).catch(() => setFollowed([]));
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getPosts({ factionId: factionFilter || null })
      .then(async (fetched) => {
        setPosts(fetched);
        const fMap = await getFactionsMap(fetched.map((p) => p.factionId));
        const cMap = await getCharactersMap(fetched.map((p) => p.characterId));
        setFactionsMap(fMap);
        setCharactersMap(cMap);
      })
      .catch((err) => {
        console.error(err);
        setError("Could not load the feed. Check your connection and try again.");
      })
      .finally(() => setLoading(false));
  }, [user, authLoading, factionFilter]);

  if (authLoading) {
    return (
      <div className="text-center py-16 text-text-muted">Loading…</div>
    );
  }

  if (!user) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center p-8">
        <div className="glass-panel p-6 sm:p-12 text-center max-w-2xl w-full">
          <h1 className="text-4xl md:text-5xl font-bold text-ink mb-4">
            Cowboy City & The Realm
          </h1>
          <p className="text-text-muted text-lg mb-8">
            A private chronicle of the realm&apos;s city-states. Ask to join, then a sheriff lets you in.
          </p>
          <div className="flex gap-4 justify-center flex-wrap">
            <Link href="/login" className="btn">
              Enter the Realm
            </Link>
            <Link href="/signup" className="btn btn-secondary">
              Join the Realm
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const pinnedCount = posts.filter((p) => p.pinned && p.type === "announcement").length;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] py-8 px-4">
      <div className="max-w-3xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-accent-gold">Realm Feed</h1>
            <p className="text-text-muted text-sm mt-1">
              Newest posts first, from every city
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              value={factionFilter}
              onChange={(e) => setFactionFilter(e.target.value)}
              className="form-input py-2 text-base w-full sm:w-auto sm:min-w-[160px] max-w-full"
              aria-label="Filter by city"
            >
              <option value="">All cities</option>
              {factions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={followingOnly} onChange={(e) => setFollowingOnly(e.target.checked)} />
              Following
            </label>
            <Link href="/posts/new" className="btn text-sm px-5 py-2">
              New Post
            </Link>
          </div>
        </header>

        {pinnedCount > 0 && (
          <p className="text-accent-gold text-sm mb-4 font-bold">
            {pinnedCount} pinned announcement{pinnedCount > 1 ? "s" : ""} at top
          </p>
        )}

        {loading && (
          <div className="text-center py-12 text-text-muted">Loading posts…</div>
        )}

        {error && (
          <div className="glass-panel p-6 text-danger text-center">{error}</div>
        )}

        {!loading && !error && posts.length === 0 && (
          <div className="glass-panel p-12 text-center">
            <p className="text-text-muted mb-4">No posts yet. Be the first to write lore.</p>
            <Link href="/posts/new" className="btn">
              Create Post
            </Link>
          </div>
        )}

        {!loading && !error && posts.length > 0 && (
          <div className="flex flex-col gap-5">
            {posts
              .filter((post) => !followingOnly || (post.cityIds ?? [post.factionId]).some((id) => followed.includes(id)))
              .map((post) => (
              <PostCard
                key={post.id}
                post={post}
                faction={factionsMap.get(post.factionId)}
                character={charactersMap.get(post.characterId)}
                tagged={factions.filter((city) => (post.cityIds ?? []).includes(city.id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
