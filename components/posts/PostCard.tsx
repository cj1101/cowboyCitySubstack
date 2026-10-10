"use client";

import Link from "next/link";
import { useState } from "react";
import type { Timestamp } from "firebase/firestore";
import type { Character, Faction, Post } from "@/lib/types";
import { PostTypeBadge } from "./PostTypeBadge";
import { MediaCarousel } from "./MediaCarousel";
import { EmojiReactionBar } from "@/components/reactions/EmojiReactionBar";
import { PostComments } from "@/components/posts/PostComments";

function formatDate(ts: Timestamp | undefined): string {
  if (!ts?.toDate) return "";
  return ts.toDate().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function excerptFromHtml(html: string, maxLen = 180): string {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…`;
}

interface PostCardProps {
  post: Post;
  faction?: Faction | null;
  character?: Character | null;
  tagged?: Faction[];
  compact?: boolean;
}

export function PostCard({ post, faction, character, tagged = [], compact = false }: PostCardProps) {
  const [revealed, setRevealed] = useState(false);
  const hidden = Boolean(post.spoiler || post.contentWarning) && !revealed;
  const media = post.media?.length
    ? post.media
    : (post.images ?? []).map((url) => ({ url, type: "image" as const }));
  const others = tagged.filter((city) => city.id !== post.factionId);

  return (
    <article className="glass-panel overflow-hidden" style={{ borderTop: `3px solid ${faction?.colors?.primary ?? "#169C9C"}` }}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 min-w-0">
        {faction?.sigilUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={faction.sigilUrl} alt="" className="w-10 h-10 rounded-full border border-accent-gold object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-full border border-primary-brown flex items-center justify-center font-bold text-on-yellow" style={{ background: faction?.colors?.primary ?? "#169C9C" }}>
            {(faction?.name || "?").charAt(0)}
          </div>
        )}
        <div className="min-w-0">
          <p className="font-bold text-accent-gold truncate">
            <Link href={faction ? `/cities/${faction.slug}` : "/cities"}>{faction?.name ?? "Unknown city"}</Link>
            {character?.name ? <span className="text-text-muted font-normal"> · {character.name}</span> : null}
          </p>
          <p className="text-sm text-text-muted">
            {formatDate(post.createdAt)}
            {post.settlementYear ? ` · Year ${post.settlementYear}` : ""}
            {post.era ? ` · ${post.era}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {post.pinned && <span className="text-xs font-bold text-accent-gold uppercase">Pinned</span>}
          <PostTypeBadge type={post.type} />
        </div>
      </div>

      <div className="relative">
        {!compact && media.length > 0 && (
          <div className={hidden ? "blur-xl pointer-events-none select-none" : ""}>
            <MediaCarousel media={media} title={post.title} />
          </div>
        )}
        {hidden && (
          <button type="button" className="absolute inset-0 flex items-center justify-center bg-white/80" onClick={() => setRevealed(true)}>
            <span className="glass-panel px-4 py-3 text-sm">
              {post.contentWarning ? `Content warning: ${post.contentWarning}` : "Spoiler"} — show
            </span>
          </button>
        )}
      </div>

      <div className={`px-4 py-3 space-y-3 ${hidden ? "blur-md select-none" : ""}`}>
        <Link href={`/posts/${post.id}`} className="block">
          <h2 className="text-lg font-bold">{post.title}</h2>
          {post.body && <p className="text-text-muted text-sm mt-1">{excerptFromHtml(post.body)}</p>}
        </Link>
        {others.length > 0 && (
          <p className="text-xs text-text-muted">
            With {others.map((city) => city.name).join(", ")}
          </p>
        )}
        {(post.referencedPostIds?.length ?? 0) > 0 && (
          <p className="text-xs text-accent-gold">{post.referencedPostIds!.length} referenced post{post.referencedPostIds!.length > 1 ? "s" : ""}</p>
        )}
        <EmojiReactionBar target={{ kind: "post", postId: post.id, authorUid: post.authorUid, title: post.title }} />
        <PostComments postId={post.id} postAuthorUid={post.authorUid} postTitle={post.title} />
      </div>
    </article>
  );
}
