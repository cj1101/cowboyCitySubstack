"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { deletePost } from "@/lib/firestore/admin";
import { getPosts, getFactionsMap, getCharactersMap } from "@/lib/firestore/posts";
import { PostTypeBadge } from "@/components/posts/PostTypeBadge";
import type { Character, Faction, Post } from "@/lib/types";

export function PostModeration() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [factions, setFactions] = useState<Map<string, Faction>>(new Map());
  const [characters, setCharacters] = useState<Map<string, Character>>(new Map());
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const allPosts = await getPosts();
      setPosts(allPosts.slice(0, 50));
      const factionIds = allPosts.map((p) => p.factionId);
      const characterIds = allPosts.map((p) => p.characterId);
      setFactions(await getFactionsMap(factionIds));
      setCharacters(await getCharactersMap(characterIds));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (postId: string, title: string) => {
    if (!confirm(`Delete post "${title}"? This cannot be undone.`)) return;
    setDeletingId(postId);
    try {
      await deletePost(postId);
      setPosts((prev) => prev.filter((p) => p.id !== postId));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete post");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return <p className="text-text-muted">Loading posts…</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted border-b border-primary-brown">
            <th className="py-2 pr-4">Type</th>
            <th className="py-2 pr-4">Title</th>
            <th className="py-2 pr-4 hidden md:table-cell">Faction</th>
            <th className="py-2 pr-4 hidden lg:table-cell">Character</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {posts.map((post) => {
            const faction = factions.get(post.factionId);
            const character = characters.get(post.characterId);
            return (
              <tr key={post.id} className="border-b border-primary-brown/50">
                <td className="py-3 pr-4">
                  <PostTypeBadge type={post.type} />
                </td>
                <td className="py-3 pr-4">
                  <Link
                    href={`/posts/${post.id}`}
                    className="text-accent-gold hover:underline line-clamp-1"
                  >
                    {post.title || "(untitled)"}
                  </Link>
                </td>
                <td className="py-3 pr-4 hidden md:table-cell text-text-muted">
                  {faction?.name ?? post.factionId}
                </td>
                <td className="py-3 pr-4 hidden lg:table-cell text-text-muted">
                  {character?.name ?? post.characterId}
                </td>
                <td className="py-3">
                  <button
                    type="button"
                    onClick={() => handleDelete(post.id, post.title)}
                    disabled={deletingId === post.id}
                    className="btn btn-danger text-xs px-3 py-1 disabled:opacity-50"
                  >
                    {deletingId === post.id ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {posts.length === 0 && (
        <p className="text-text-muted text-center py-8">No posts found.</p>
      )}
    </div>
  );
}
