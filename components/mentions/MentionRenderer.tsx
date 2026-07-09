"use client";

import type { ReactNode } from "react";
import Link from "next/link";

interface MentionRendererProps {
  body: string;
  className?: string;
}

function renderMentionLink(type: string, id: string, key: string) {
  const label = `@${type}:${id}`;

  if (type === "faction") {
    return (
      <Link
        key={key}
        href={`/factions/${id}`}
        className="text-accent-gold hover:text-accent-gold-hover underline"
      >
        {label}
      </Link>
    );
  }

  if (type === "character") {
    return (
      <span key={key} className="text-accent-gold">
        {label}
      </span>
    );
  }

  if (type === "post") {
    return (
      <Link
        key={key}
        href={`/posts/${id}`}
        className="text-accent-gold hover:text-accent-gold-hover underline"
      >
        {label}
      </Link>
    );
  }

  return <span key={key}>{label}</span>;
}

export function MentionRenderer({ body, className = "" }: MentionRendererProps) {
  const mentionPattern = /@(faction|character|post):([a-zA-Z0-9_-]+)/g;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    parts.push(renderMentionLink(match[1], match[2], `${match.index}-${match[2]}`));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }

  return (
    <div className={`whitespace-pre-wrap leading-relaxed ${className}`}>
      {parts.length > 0 ? parts : body}
    </div>
  );
}
