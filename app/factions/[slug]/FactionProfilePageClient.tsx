"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { FactionPageLayers } from "@/components/factions/FactionPageLayers";
import { WikiTab } from "@/components/wiki/WikiTab";
import { CityHome } from "@/components/cities/CityHome";
import { StoredImage } from "@/components/media/StoredImage";
import { getFactionBySlug, isFactionOwner } from "@/lib/firestore/factions";
import { getCharactersForFaction } from "@/lib/firestore/characters";
import { getWikiSections } from "@/lib/firestore/wiki";
import { getCharactersMap, getFactionsMap, getPosts } from "@/lib/firestore/posts";
import type { WikiSection } from "@/lib/firestore/wiki";
import type { Character, Faction, Post } from "@/lib/types";

export default function FactionProfilePageClient() {
  const params = useParams();
  const searchParams = useSearchParams();
  const slug = params.slug as string;
  const activeTab = searchParams.get("tab") === "wiki" ? "wiki" : "profile";
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [faction, setFaction] = useState<Faction | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [wikiSections, setWikiSections] = useState<WikiSection[]>([]);
  const [factionPosts, setFactionPosts] = useState<Post[]>([]);
  const [factionsMap, setFactionsMap] = useState<Map<string, Faction>>(new Map());
  const [charactersMap, setCharactersMap] = useState<Map<string, Character>>(new Map());
  const [isOwner, setIsOwner] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedLoading, setFeedLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadFailed, setUploadFailed] = useState(false);

  useEffect(() => {
    setUploadFailed(new URLSearchParams(window.location.search).get("upload") === "failed");
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }

    async function load() {
      try {
        const f = await getFactionBySlug(slug);
        if (!f) {
          setError("Faction not found");
          return;
        }
        setFaction(f);
        const chars = await getCharactersForFaction(f.id);
        setCharacters(chars.filter((c) => c.isActive));
        const sections = await getWikiSections(f.id);
        setWikiSections(sections);
        if (user) setIsOwner(await isFactionOwner(f.id, user.uid));
      } catch {
        setError("Failed to load faction");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [slug, user, authLoading, router]);

  useEffect(() => {
    if (!faction || activeTab !== "profile" || faction.liveHtml) return;
    setFeedLoading(true);
    getPosts({ factionId: faction.id })
      .then(async (fetched) => {
        setFactionPosts(fetched);
        const fMap = await getFactionsMap(fetched.map((p) => p.factionId));
        const cMap = await getCharactersMap(fetched.map((p) => p.characterId));
        setFactionsMap(fMap);
        setCharactersMap(cMap);
      })
      .catch(() => setFactionPosts([]))
      .finally(() => setFeedLoading(false));
  }, [faction, activeTab]);

  if (authLoading || loading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading…</p>
      </div>
    );
  }

  if (error || !faction) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center p-8">
        <div className="glass-panel p-10 text-center">
          <p className="text-red-400 mb-4">{error || "Faction not found"}</p>
          <Link href="/cities" className="btn btn-secondary">Back to Factions</Link>
        </div>
      </div>
    );
  }

  const primary = faction.colors?.primary ?? "#169C9C";
  const secondary = faction.colors?.secondary ?? "#FED83D";

  if (activeTab === "wiki") {
    return (
      <div className="min-h-[calc(100vh-4rem)]">
        <div
          className="relative h-48 md:h-64"
          style={{
            background: faction.bannerUrl
              ? `url("${faction.bannerUrl.replace(/"/g, "")}") center/cover`
              : `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`,
          }}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-white/90 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-6 md:p-10 max-w-4xl mx-auto flex items-end gap-5">
            {faction.sigilUrl ? (
              <StoredImage
                src={faction.sigilUrl}
                alt={`${faction.name} sigil`}
                width={112}
                height={112}
                sizes="112px"
                className="w-20 h-20 md:w-28 md:h-28 border-4 border-ink object-cover bg-white shrink-0 pixel-image"
              />
            ) : (
              <div
                className="w-20 h-20 md:w-28 md:h-28 border-4 border-ink flex items-center justify-center text-3xl font-bold shrink-0"
                style={{ background: primary, color: "#1c1917" }}
              >
                {faction.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0 pb-1">
              <h1 className="text-3xl md:text-5xl font-bold truncate">{faction.name}</h1>
            </div>
          </div>
        </div>
        <div className="wood-texture p-6 md:p-10">
          <div className="max-w-4xl mx-auto space-y-8">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <Link href="/cities" className="text-accent-gold hover:text-accent-gold-hover text-sm">← All cities</Link>
              <div className="flex gap-2">
                <Link href={`/cities/${faction.slug}`} className="btn text-sm px-4 py-2 btn-secondary">Profile</Link>
                <Link href={`/cities/${faction.slug}?tab=wiki`} className="btn text-sm px-4 py-2">Wiki</Link>
              </div>
            </div>
            <WikiTab
              factionId={faction.id}
              factionSlug={faction.slug}
              factionName={faction.name}
              sections={wikiSections}
              canEdit={isOwner}
            />
          </div>
        </div>
      </div>
    );
  }

  if (faction.liveHtml) {
    return (
      <FactionPageLayers
        faction={faction}
        liveHtml={faction.liveHtml}
        isOwner={isOwner}
        activeTab="profile"
        header={
          <div className="flex items-center justify-between flex-wrap gap-3">
            <Link href="/cities" className="text-accent-gold hover:text-accent-gold-hover text-sm font-bold">
              ← All cities
            </Link>
            <span className="font-bold text-lg">{faction.name}</span>
          </div>
        }
      />
    );
  }

  return (
    <CityHome
      faction={faction}
      isOwner={isOwner}
      characters={characters}
      posts={factionPosts}
      feedLoading={feedLoading}
      factionsMap={factionsMap}
      charactersMap={charactersMap}
      uploadFailed={uploadFailed}
    />
  );
}
