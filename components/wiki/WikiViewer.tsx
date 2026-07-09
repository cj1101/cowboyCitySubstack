"use client";

import { MentionRenderer } from "@/components/mentions/MentionRenderer";
import type { WikiSection } from "@/lib/firestore/wiki";

interface WikiViewerProps {
  sections: WikiSection[];
}

export function WikiViewer({ sections }: WikiViewerProps) {
  if (sections.length === 0) {
    return (
      <div className="glass-panel p-8 text-center text-text-muted">
        <p>No wiki sections yet. Faction owners can add lore here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <article key={section.id} className="glass-panel p-6">
          <h3 className="text-xl font-bold text-accent-gold mb-3">{section.title || "Untitled"}</h3>
          <MentionRenderer body={section.body} className="text-text-light" />
        </article>
      ))}
    </div>
  );
}
