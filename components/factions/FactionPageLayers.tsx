"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { PostCard } from "@/components/posts/PostCard";
import {
  getCharactersMap,
  getFactionsMap,
  getPosts,
} from "@/lib/firestore/posts";
import type { Character, Faction, Post } from "@/lib/types";

interface FactionPageLayersProps {
  faction: Faction;
  liveHtml: string;
  isOwner?: boolean;
  activeTab?: "profile" | "wiki";
  header?: ReactNode;
}

const DEFAULT_HTML = "<h1>Welcome to our Saloon</h1>";

export function FactionPageLayers({
  faction,
  liveHtml,
  isOwner = false,
  activeTab = "profile",
  header,
}: FactionPageLayersProps) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [factionsMap, setFactionsMap] = useState<Map<string, Faction>>(new Map());
  const [charactersMap, setCharactersMap] = useState<Map<string, Character>>(new Map());
  const [feedLoading, setFeedLoading] = useState(true);

  useEffect(() => {
    setFeedLoading(true);
    getPosts({ factionId: faction.id })
      .then(async (fetched) => {
        setPosts(fetched);
        const fMap = await getFactionsMap(fetched.map((p) => p.factionId));
        const cMap = await getCharactersMap(fetched.map((p) => p.characterId));
        setFactionsMap(fMap);
        setCharactersMap(cMap);
      })
      .catch(() => setPosts([]))
      .finally(() => setFeedLoading(false));
  }, [faction.id]);

  return (
    <div className="profile-container">
      <div
        className="design-layer"
        dangerouslySetInnerHTML={{ __html: liveHtml || DEFAULT_HTML }}
      />

      {header && (
        <div className="faction-layer-header">
          {header}
        </div>
      )}

      <div className="feed-layer">
        <div className="feed-container">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <h2 className="feed-title mb-0">The Feed</h2>
            <div className="flex gap-2 items-center">
              <Link
                href={`/factions/${faction.slug}`}
                className={`btn text-xs px-3 py-1.5 ${activeTab === "profile" ? "" : "btn-secondary"}`}
              >
                Profile
              </Link>
              <Link
                href={`/factions/${faction.slug}?tab=wiki`}
                className={`btn text-xs px-3 py-1.5 ${activeTab === "wiki" ? "" : "btn-secondary"}`}
              >
                Wiki
              </Link>
              {isOwner && (
                <Link
                  href={`/factions/${faction.slug}/edit`}
                  className="btn btn-secondary text-xs px-3 py-1.5"
                >
                  Edit Page
                </Link>
              )}
            </div>
          </div>

          {feedLoading ? (
            <p className="text-text-muted text-center py-8">Loading posts…</p>
          ) : posts.length === 0 ? (
            <p className="text-text-muted text-center py-8">No posts yet.</p>
          ) : (
            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  faction={factionsMap.get(post.factionId) ?? faction}
                  character={charactersMap.get(post.characterId)}
                  compact
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
