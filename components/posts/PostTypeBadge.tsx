"use client";

import type { PostType } from "@/lib/types";
import { POST_TYPE_LABELS } from "@/lib/types";

const TYPE_STYLES: Record<PostType, string> = {
  announcement: "bg-accent-yellow text-on-yellow",
  build: "bg-white text-accent-gold border border-primary-brown",
  lore: "bg-dark-brown text-accent-gold border border-primary-brown",
  debate: "bg-white text-ink border border-primary-brown",
  event: "bg-white text-accent-gold border border-accent-cyan",
  wiki: "bg-dark-brown text-text-muted border border-primary-brown",
};

interface PostTypeBadgeProps {
  type: PostType;
  className?: string;
}

export function PostTypeBadge({ type, className = "" }: PostTypeBadgeProps) {
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded text-xs font-bold uppercase tracking-wide ${TYPE_STYLES[type]} ${className}`}
    >
      {POST_TYPE_LABELS[type]}
    </span>
  );
}
