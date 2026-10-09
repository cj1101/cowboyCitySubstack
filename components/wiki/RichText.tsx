"use client";

import { useState } from "react";
import Link from "next/link";
import { resolveWikiLink } from "@/lib/firestore/wikiEntries";
import type { WikiEntry } from "@/lib/types";

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function linkifyWiki(html: string): string {
  return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => {
    const ref = target.trim();
    const text = escapeText((label || ref).trim());
    const href = `/search?q=${encodeURIComponent(ref)}`;
    return `<a class="wiki-link" data-wiki="${escapeText(ref)}" href="${href}">${text}</a>`;
  });
}

export function RichText({ html }: { html: string }) {
  const [preview, setPreview] = useState<(WikiEntry & { top: number; left: number }) | null>(null);

  return (
    <div
      className="prose prose-invert max-w-none text-text-light [&_a]:text-accent-gold [&_blockquote]:border-accent-gold/40 [&_.wiki-link]:underline"
      onMouseOver={async (event) => {
        const target = (event.target as HTMLElement).closest("a.wiki-link");
        if (!target) return;
        const ref = target.getAttribute("data-wiki");
        if (!ref) return;
        const entry = await resolveWikiLink(ref);
        if (!entry) return;
        const rect = target.getBoundingClientRect();
        setPreview({ ...entry, top: rect.bottom + 8, left: rect.left });
      }}
      onMouseLeave={() => setPreview(null)}
    >
      <div dangerouslySetInnerHTML={{ __html: linkifyWiki(html) }} />
      {preview && (
        <div
          className="fixed z-50 w-72 glass-panel p-3 text-sm shadow-xl"
          style={{ top: preview.top, left: preview.left }}
        >
          <p className="text-accent-gold font-bold">{preview.title}</p>
          <p className="text-text-muted text-xs uppercase">{preview.kind}</p>
          <p className="text-text-light mt-1 line-clamp-4">{preview.summary || preview.body.replace(/<[^>]+>/g, " ")}</p>
          <Link href={`/cities/${preview.citySlug}/wiki#${preview.slug}`} className="text-accent-gold text-xs">
            Open entry
          </Link>
        </div>
      )}
    </div>
  );
}
