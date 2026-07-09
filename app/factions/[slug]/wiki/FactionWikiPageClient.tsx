"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { WikiEditor } from "@/components/wiki/WikiEditor";
import { WikiViewer } from "@/components/wiki/WikiViewer";
import { getWikiSections, type WikiSection } from "@/lib/firestore/wiki";
import { getFactionBySlug, isFactionOwner } from "@/lib/mentions";

export default function FactionWikiPageClient() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const slug = params.slug;
  const editMode = searchParams.get("edit") === "1";

  const [factionName, setFactionName] = useState("");
  const [factionId, setFactionId] = useState<string | null>(null);
  const [sections, setSections] = useState<WikiSection[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadWiki = async () => {
    setLoading(true);
    setError(null);
    try {
      const faction = await getFactionBySlug(slug);
      if (!faction) {
        setError("Faction not found.");
        return;
      }

      setFactionId(faction.id);
      setFactionName(faction.name);

      const wikiSections = await getWikiSections(faction.id);
      setSections(wikiSections);

      if (user) {
        const owner = await isFactionOwner(user.uid, faction.id);
        setCanEdit(owner);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load wiki");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWiki();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, user?.uid]);

  if (loading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] p-8">
        <div className="max-w-4xl mx-auto glass-panel p-8 text-center text-text-muted">
          Loading wiki…
        </div>
      </div>
    );
  }

  if (error || !factionId) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] p-8">
        <div className="max-w-4xl mx-auto glass-panel p-8 text-center">
          <p className="text-danger mb-4">{error ?? "Faction not found."}</p>
          <Link href="/factions" className="btn btn-secondary">
            Back to Factions
          </Link>
        </div>
      </div>
    );
  }

  const showEditor = editMode && canEdit;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <Link
              href={`/factions/${slug}`}
              className="text-text-muted text-sm hover:text-accent-gold transition-colors"
            >
              ← Back to {factionName}
            </Link>
            <h1 className="text-3xl font-bold text-accent-gold mt-2">{factionName} Wiki</h1>
          </div>
          {canEdit && !showEditor && (
            <Link href={`/factions/${slug}/wiki?edit=1`} className="btn">
              Edit Wiki
            </Link>
          )}
          {showEditor && (
            <Link href={`/factions/${slug}/wiki`} className="btn btn-secondary">
              View Mode
            </Link>
          )}
        </div>

        {showEditor ? (
          <WikiEditor
            factionId={factionId}
            initialSections={sections}
            onSaved={() => void loadWiki()}
          />
        ) : (
          <WikiViewer sections={sections} />
        )}
      </div>
    </div>
  );
}
