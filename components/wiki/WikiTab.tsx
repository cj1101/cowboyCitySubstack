"use client";

import Link from "next/link";
import { WikiViewer } from "@/components/wiki/WikiViewer";
import { WikiEditor } from "@/components/wiki/WikiEditor";
import type { WikiSection } from "@/lib/firestore/wiki";

interface WikiTabProps {
  factionId: string;
  factionSlug: string;
  factionName: string;
  sections: WikiSection[];
  canEdit: boolean;
}

export function WikiTab({
  factionSlug,
  factionName,
  sections,
  canEdit,
}: WikiTabProps) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-2xl font-bold text-accent-gold">{factionName} Wiki</h2>
          <p className="text-text-muted text-sm">
            Faction lore encyclopedia — link to other factions, characters, and posts with @mentions.
          </p>
        </div>
        {canEdit && (
          <Link href={`/cities/${factionSlug}/wiki?edit=1`} className="btn btn-secondary text-sm">
            Edit Wiki
          </Link>
        )}
      </div>
      <WikiViewer sections={sections} />
    </div>
  );
}

export { WikiEditor, WikiViewer };
