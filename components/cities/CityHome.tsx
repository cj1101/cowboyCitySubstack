"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CityPanel } from "@/components/cities/CityPanel";
import { CityMapCard } from "@/components/cities/CityMapCard";
import { CityTreaties } from "@/components/treaties/CityTreaties";
import { PostCard } from "@/components/posts/PostCard";
import { CameraRollInput } from "@/components/media/CameraRollInput";
import { Lightbox } from "@/components/media/Lightbox";
import { StoredImage } from "@/components/media/StoredImage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { updateFaction } from "@/lib/firestore/factions";
import { uploadFactionImage, uploadCityGalleryPhoto } from "@/lib/firestore/storage";
import { formatFoundingDate, formatPopulation, parsePopulation } from "@/lib/cities/record";
import { actionError, withTimeout } from "@/lib/async";
import type { Character, Faction, Post } from "@/lib/types";

function useObjectUrl(file: File | null): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

export function CityHome({
  faction,
  isOwner,
  characters = [],
  posts = [],
  feedLoading = false,
  factionsMap,
  charactersMap,
  uploadFailed = false,
  layout = "page",
}: {
  faction: Faction;
  isOwner: boolean;
  characters?: Character[];
  posts?: Post[];
  feedLoading?: boolean;
  factionsMap?: Map<string, Faction>;
  charactersMap?: Map<string, Character>;
  uploadFailed?: boolean;
  layout?: "page" | "embedded";
}) {
  const [city, setCity] = useState(faction);
  const [editing, setEditing] = useState(false);
  const [motto, setMotto] = useState(faction.motto || "");
  const [population, setPopulation] = useState(faction.population != null ? String(faction.population) : "");
  const [foundedOn, setFoundedOn] = useState(faction.foundedOn || "");
  const [gallery, setGallery] = useState<string[]>(faction.gallery || []);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [crestFile, setCrestFile] = useState<File | null>(null);
  const [newPhotos, setNewPhotos] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [showAllPosts, setShowAllPosts] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const bannerPreview = useObjectUrl(bannerFile);
  const crestPreview = useObjectUrl(crestFile);

  useEffect(() => {
    if (editingRef.current) return;
    setCity(faction);
    setMotto(faction.motto || "");
    setPopulation(faction.population != null ? String(faction.population) : "");
    setFoundedOn(faction.foundedOn || "");
    setGallery(faction.gallery || []);
  }, [faction]);

  const primary = city.colors?.primary ?? "#169C9C";
  const secondary = city.colors?.secondary ?? "#FED83D";
  const bannerSrc = bannerPreview || city.bannerUrl || "";
  const crestSrc = crestPreview || city.sigilUrl || "";
  const latest = showAllPosts ? posts : posts.slice(0, 4);

  const beginEdit = () => {
    setMotto(city.motto || "");
    setPopulation(city.population != null ? String(city.population) : "");
    setFoundedOn(city.foundedOn || "");
    setGallery(city.gallery || []);
    setBannerFile(null);
    setCrestFile(null);
    setNewPhotos([]);
    setError("");
    setMessage("");
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const nextPopulation = parsePopulation(population);
      if (motto.trim().length > 180) throw new Error("Motto has to be 180 characters or fewer.");
      if (gallery.length + newPhotos.length > 24) throw new Error("A city gallery holds up to 24 photos.");
      let bannerUrl = city.bannerUrl;
      let sigilUrl = city.sigilUrl;
      if (bannerFile) {
        bannerUrl = await withTimeout(uploadFactionImage(city.id, bannerFile, "banner"), 30000);
      }
      if (crestFile) {
        sigilUrl = await withTimeout(uploadFactionImage(city.id, crestFile, "sigil"), 30000);
      }
      const uploaded: string[] = [];
      for (let index = 0; index < newPhotos.length; index += 1) {
        uploaded.push(await withTimeout(uploadCityGalleryPhoto(city.id, newPhotos[index], index), 30000));
      }
      const nextGallery = [...gallery, ...uploaded];
      await withTimeout(updateFaction(city.id, {
        motto: motto.trim(),
        population: nextPopulation,
        foundedOn: foundedOn.trim() || null,
        gallery: nextGallery,
        bannerUrl,
        sigilUrl,
      }), 12000);
      const next: Faction = {
        ...city,
        motto: motto.trim() || undefined,
        population: nextPopulation,
        foundedOn: foundedOn.trim() || undefined,
        gallery: nextGallery,
        bannerUrl: bannerUrl || undefined,
        sigilUrl: sigilUrl || undefined,
      };
      setCity(next);
      setMotto(next.motto || "");
      setPopulation(next.population != null ? String(next.population) : "");
      setFoundedOn(next.foundedOn || "");
      setGallery(nextGallery);
      setBannerFile(null);
      setCrestFile(null);
      setNewPhotos([]);
      setEditing(false);
      setMessage("City record saved.");
    } catch (err) {
      setError(actionError(err, "Could not save the city record."));
    } finally {
      setBusy(false);
    }
  };

  const record = (
    <div className="space-y-6">
      {layout === "page" && (
        <div className="relative h-52 md:h-72 border-4 border-ink overflow-hidden bg-white">
          {bannerSrc ? (
            <StoredImage src={bannerSrc} alt={`${city.name} banner`} fill sizes="100vw" className="object-cover" />
          ) : (
            <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)` }} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-white via-white/20 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-4 md:p-8 flex items-end gap-4">
            {crestSrc ? (
              <StoredImage
                src={crestSrc}
                alt={`${city.name} flag`}
                width={112}
                height={112}
                sizes="112px"
                className="w-20 h-20 md:w-28 md:h-28 border-4 border-ink object-cover bg-white pixel-image shrink-0"
              />
            ) : (
              <div
                className="w-20 h-20 md:w-28 md:h-28 border-4 border-ink flex items-center justify-center text-3xl font-bold shrink-0"
                style={{ background: primary, color: "#1c1917" }}
              >
                {city.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0 pb-1">
              <p className="text-xs font-bold uppercase tracking-wide text-text-muted">Flag / crest</p>
              <h1 className="text-2xl md:text-4xl font-bold truncate">{city.name}</h1>
              {city.motto && <p className="text-sm md:text-base italic mt-1">{city.motto}</p>}
            </div>
          </div>
        </div>
      )}

      <section className="glass-panel p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold text-accent-gold">City record</h2>
            {layout === "embedded" && city.motto && <p className="italic mt-2">{city.motto}</p>}
          </div>
          {isOwner && !editing && (
            <button type="button" className="btn text-sm px-4 py-2" onClick={beginEdit}>
              Edit city record
            </button>
          )}
        </div>

        {message && <p className="text-sm font-bold text-accent-gold" role="status">{message}</p>}
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        {uploadFailed && (
          <p className="text-sm font-bold" role="alert">Upload failed. The image was not stored. The city was still created.</p>
        )}

        {!editing && (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-xs font-bold uppercase text-text-muted">Motto</dt>
              <dd>{city.motto || "No motto yet."}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase text-text-muted">Population</dt>
              <dd>{city.population != null ? formatPopulation(city.population) : "Unrecorded"}</dd>
            </div>
            <div>
              <dt className="text-xs font-bold uppercase text-text-muted">Founded</dt>
              <dd>{city.foundedOn ? formatFoundingDate(city.foundedOn) : "Unrecorded"}</dd>
            </div>
          </dl>
        )}

        {editing && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div>
              <label className="form-label" htmlFor="city-motto">Motto</label>
              <input id="city-motto" className="form-input" maxLength={180} value={motto} onChange={(event) => setMotto(event.target.value)} />
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <label className="form-label" htmlFor="city-population">Population</label>
                <input id="city-population" className="form-input" inputMode="numeric" value={population} onChange={(event) => setPopulation(event.target.value)} placeholder="900" />
              </div>
              <div>
                <label className="form-label" htmlFor="city-founded">Founding date</label>
                <input id="city-founded" type="date" className="form-input" value={foundedOn} onChange={(event) => setFoundedOn(event.target.value)} />
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <p className="form-label">Banner image</p>
                <CameraRollInput accept="image/*" multiple={false} label="Choose banner" onFiles={(files) => setBannerFile(files[0] || null)} />
                {bannerFile && <p className="text-xs text-text-muted mt-2 truncate">{bannerFile.name}</p>}
              </div>
              <div>
                <p className="form-label">Flag / crest</p>
                <CameraRollInput accept="image/*" multiple={false} label="Choose flag" onFiles={(files) => setCrestFile(files[0] || null)} />
                {crestFile && <p className="text-xs text-text-muted mt-2 truncate">{crestFile.name}</p>}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <SubmitButton busy={busy} busyLabel="Saving…">Save city record</SubmitButton>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setError("");
                  setBannerFile(null);
                  setCrestFile(null);
                  setNewPhotos([]);
                  setGallery(city.gallery || []);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="glass-panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-xl font-bold text-accent-gold">Build gallery</h2>
          {editing && (
            <CameraRollInput
              accept="image/*"
              label="Add photos"
              onFiles={(files) => {
                setNewPhotos((current) => [...current, ...files].slice(0, Math.max(0, 24 - gallery.length)));
                setError("");
              }}
            />
          )}
        </div>
        {gallery.length === 0 && newPhotos.length === 0 ? (
          <p className="text-text-muted">No build photos yet.</p>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {gallery.map((url, index) => (
              <li key={`${url}-${index}`} className="space-y-2">
                <button type="button" className="relative block w-full aspect-square border-2 border-ink overflow-hidden" onClick={() => setLightbox(index)} aria-label={`Open build photo ${index + 1}`}>
                  <StoredImage src={url} alt={`${city.name} build ${index + 1}`} fill sizes="(max-width: 640px) 50vw, 240px" className="object-cover pixel-image" />
                </button>
                {editing && (
                  <button
                    type="button"
                    className="text-sm text-accent-gold min-h-11"
                    disabled={busy}
                    onClick={() => setGallery((current) => current.filter((_, item) => item !== index))}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
            {newPhotos.map((file, index) => (
              <li key={`${file.name}-${index}`} className="space-y-2">
                <div className="relative aspect-square border-2 border-dashed border-ink overflow-hidden">
                  <GalleryPreview file={file} />
                </div>
                <button type="button" className="text-sm text-accent-gold min-h-11" disabled={busy} onClick={() => setNewPhotos((current) => current.filter((_, item) => item !== index))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-muted mt-3">{gallery.length + newPhotos.length} / 24 photos. On a phone, swipe post photos and tap one to open it.</p>
      </section>

      <CityTreaties cityId={city.id} />

      {lightbox != null && (
        <Lightbox
          media={gallery.map((url) => ({ url, type: "image" as const }))}
          index={lightbox}
          title={`${city.name} builds`}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
        />
      )}
    </div>
  );

  if (layout === "embedded") return record;

  return (
    <div className="min-h-[calc(100vh-4rem)]">
      <div className="wood-texture p-4 md:p-10">
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <Link href="/cities" className="text-accent-gold hover:text-accent-gold-hover text-sm">← All cities</Link>
            <div className="flex gap-2">
              <Link href={`/cities/${city.slug}`} className="btn text-sm px-4 py-2">Profile</Link>
              <Link href={`/cities/${city.slug}?tab=wiki`} className="btn text-sm px-4 py-2 btn-secondary">Wiki</Link>
            </div>
          </div>
          {record}
          <CityPanel faction={city} isOwner={isOwner} />
          {(city.description || city.bio) && (
            <section className="glass-panel p-6">
              <h2 className="text-xl font-bold text-accent-gold mb-3">About</h2>
              <p className="whitespace-pre-wrap">{city.description || city.bio}</p>
            </section>
          )}
          {city.lore && (
            <section className="glass-panel p-6">
              <h2 className="text-xl font-bold text-accent-gold mb-3">Lore</h2>
              <p className="whitespace-pre-wrap">{city.lore}</p>
            </section>
          )}
          <section className="glass-panel p-6">
            <h2 className="text-xl font-bold text-accent-gold mb-4">Known voices</h2>
            {characters.length === 0 ? (
              <p className="text-text-muted">No active characters yet.</p>
            ) : (
              <ul className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {characters.map((character) => (
                  <li key={character.id} className="flex items-center gap-3 p-3 border border-primary-brown">
                    {character.avatarUrl ? (
                      <StoredImage src={character.avatarUrl} alt="" width={48} height={48} sizes="48px" className="w-12 h-12 border border-ink object-cover" />
                    ) : (
                      <div className="w-12 h-12 border border-ink flex items-center justify-center font-bold" style={{ background: secondary, color: "#1c1917" }}>
                        {character.name.charAt(0)}
                      </div>
                    )}
                    <div>
                      <p className="font-bold">{character.name}</p>
                      {character.title && <p className="text-text-muted text-sm">{character.title}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <CityMapCard city={city} />
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-accent-gold">Latest posts</h2>
            {feedLoading ? (
              <p className="text-text-muted">Loading posts…</p>
            ) : posts.length === 0 ? (
              <p className="text-text-muted">No posts yet.</p>
            ) : (
              <div className="space-y-4">
                {latest.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    faction={factionsMap?.get(post.factionId) ?? city}
                    character={charactersMap?.get(post.characterId)}
                  />
                ))}
                {posts.length > 4 && (
                  <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={() => setShowAllPosts((current) => !current)}>
                    {showAllPosts ? "Show latest" : `Show all ${posts.length} posts`}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function GalleryPreview({ file }: { file: File }) {
  const url = useObjectUrl(file);
  if (!url) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="absolute inset-0 h-full w-full object-cover" />
  );
}
