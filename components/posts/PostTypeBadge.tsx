"use client";

import type { PostType } from "@/lib/types";
import { POST_TYPE_LABELS } from "@/lib/types";

const TYPE_STYLES: Record<PostType, string> = {
  announcement: "bg-accent-gold text-darker-brown",
  build: "bg-primary-brown text-text-light border border-accent-gold",
  lore: "bg-dark-brown text-accent-gold border border-accent-gold/50",
  debate: "bg-danger/80 text-text-light",
  event: "bg-accent-gold/20 text-accent-gold border border-accent-gold",
  wiki: "bg-primary-brown/60 text-text-muted border border-text-muted/30",
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
