"use client";

import Link from "next/link";
import type { Timestamp } from "firebase/firestore";
import type { Character, Faction, Post } from "@/lib/types";
import { PostTypeBadge } from "./PostTypeBadge";
import { BuildCarousel } from "./BuildCarousel";

function formatDate(ts: Timestamp | undefined): string {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function excerptFromHtml(html: string, maxLen = 160): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

interface PostCardProps {
  post: Post;
  faction?: Faction | null;
  character?: Character | null;
  compact?: boolean;
}

export function PostCard({
  post,
  faction,
  character,
  compact = false,
}: PostCardProps) {
  const factionColor = faction?.colors?.primary ?? "#d4af37";
  const authorLabel = character?.name ?? "Unknown character";
  const factionLabel = faction?.name ?? "Unknown faction";

  return (
    <article
      className={`glass-panel overflow-hidden transition-transform hover:-translate-y-0.5 ${
        post.pinned ? "ring-2 ring-accent-gold" : ""
      }`}
      style={{ borderLeftColor: factionColor, borderLeftWidth: "4px" }}
    >
      <Link href={`/posts/${post.id}`} className="block p-5">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <PostTypeBadge type={post.type} />
          {post.pinned && (
            <span className="text-xs font-bold text-accent-gold uppercase tracking-wide">
              Pinned
            </span>
          )}
          <span className="text-text-muted text-sm ml-auto">
            {formatDate(post.createdAt)}
          </span>
        </div>

        <h2 className="text-xl font-bold text-text-light mb-2">{post.title}</h2>

        <p className="text-sm text-accent-gold mb-3">
          {authorLabel}
          <span className="text-text-muted"> · </span>
          {factionLabel}
        </p>

        {!compact && post.type === "build" && post.images && post.images.length > 0 && (
          <div className="mb-4" onClick={(e) => e.preventDefault()}>
            <BuildCarousel images={post.images.slice(0, 1)} title={post.title} />
            {post.images.length > 1 && (
              <p className="text-text-muted text-xs mt-2">
                +{post.images.length - 1} more image{post.images.length > 2 ? "s" : ""}
              </p>
            )}
          </div>
        )}

        {post.body && (
          <p className="text-text-muted text-sm leading-relaxed">
            {excerptFromHtml(post.body)}
          </p>
        )}
      </Link>
    </article>
  );
}
