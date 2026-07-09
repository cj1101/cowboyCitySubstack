"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { useFactionContext } from "@/components/factions/FactionContext";
import { FactionForm } from "@/components/factions/FactionForm";
import { CharacterForm, CharacterList } from "@/components/factions/CharacterManager";
import {
  getFactionBySlug,
  isFactionOwner,
  updateFaction,
  isSlugTaken,
  addFactionOwner,
  removeFactionOwner,
  getFactionMembers,
  submitFactionHtml,
} from "@/lib/firestore/factions";
import {
  getCharactersForFaction,
  createCharacter,
  updateCharacter,
  deleteCharacter,
} from "@/lib/firestore/characters";
import { uploadFactionImage, uploadCharacterAvatar } from "@/lib/firestore/storage";
import type { FactionFormData } from "@/components/factions/FactionForm";
import type { CharacterFormData } from "@/components/factions/CharacterManager";
import { CustomHtmlEditor } from "@/components/factions/CustomHtmlEditor";
import type { Character, Faction, FactionMember } from "@/lib/types";

export default function FactionEditPage() {
  const params = useParams();
  const slug = params.slug as string;
  const { user, loading: authLoading } = useAuth();
  const { refresh: refreshFactionContext } = useFactionContext();
  const router = useRouter();

  const [faction, setFaction] = useState<Faction | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [members, setMembers] = useState<FactionMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingCharacter, setEditingCharacter] = useState<Character | null>(null);
  const [showCharacterForm, setShowCharacterForm] = useState(false);
  const [ownerUid, setOwnerUid] = useState("");

  const loadFaction = async () => {
    const f = await getFactionBySlug(slug);
    if (!f) {
      setError("Faction not found");
      return;
    }
    setFaction(f);
    setCharacters(await getCharactersForFaction(f.id));
    setMembers(await getFactionMembers(f.id));
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }

    async function init() {
      try {
        const f = await getFactionBySlug(slug);
        if (!f) {
          setError("Faction not found");
          return;
        }
        const owner = await isFactionOwner(f.id, user!.uid);
        if (!owner) {
          router.replace(`/factions/${slug}`);
          return;
        }
        setFaction(f);
        setCharacters(await getCharactersForFaction(f.id));
        setMembers(await getFactionMembers(f.id));
      } catch {
        setError("Failed to load faction");
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [slug, user, authLoading, router]);

  const handleFactionSubmit = async (data: FactionFormData) => {
    if (!faction) return;

    if (data.slug !== faction.slug && (await isSlugTaken(data.slug, faction.id))) {
      throw new Error("That slug is already taken.");
    }

    let bannerUrl = faction.bannerUrl;
    let sigilUrl = faction.sigilUrl;

    if (data.bannerFile) {
      bannerUrl = await uploadFactionImage(faction.id, data.bannerFile, "banner");
    }
    if (data.sigilFile) {
      sigilUrl = await uploadFactionImage(faction.id, data.sigilFile, "sigil");
    }

    await updateFaction(faction.id, {
      name: data.name,
      slug: data.slug,
      colors: data.colors,
      bio: data.bio,
      bannerUrl,
      sigilUrl,
    });

    await refreshFactionContext();
    if (data.slug !== slug) {
      router.replace(`/factions/${data.slug}/edit`);
    } else {
      await loadFaction();
    }
  };

  const handleCharacterSubmit = async (data: CharacterFormData) => {
    if (!faction) return;

    if (editingCharacter) {
      let avatarUrl = editingCharacter.avatarUrl;
      if (data.avatarFile) {
        avatarUrl = await uploadCharacterAvatar(editingCharacter.id, data.avatarFile);
      }
      await updateCharacter(editingCharacter.id, {
        name: data.name,
        title: data.title || undefined,
        isActive: data.isActive,
        avatarUrl,
      });
    } else {
      const character = await createCharacter(faction.id, {
        name: data.name,
        title: data.title || undefined,
        isActive: data.isActive,
      });
      if (data.avatarFile) {
        const avatarUrl = await uploadCharacterAvatar(character.id, data.avatarFile);
        await updateCharacter(character.id, { avatarUrl });
      }
    }

    setEditingCharacter(null);
    setShowCharacterForm(false);
    setCharacters(await getCharactersForFaction(faction.id));
    await refreshFactionContext();
  };

  const handleAddOwner = async () => {
    if (!faction || !ownerUid.trim()) return;
    try {
      await addFactionOwner(faction.id, ownerUid.trim());
      setOwnerUid("");
      setMembers(await getFactionMembers(faction.id));
      const updated = await getFactionBySlug(slug);
      if (updated) setFaction(updated);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to add owner");
    }
  };

  const handleRemoveOwner = async (uid: string) => {
    if (!faction) return;
    if (!confirm("Remove this owner?")) return;
    try {
      await removeFactionOwner(faction.id, uid);
      setMembers(await getFactionMembers(faction.id));
      const updated = await getFactionBySlug(slug);
      if (updated) setFaction(updated);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove owner");
    }
  };

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
          <Link href="/factions" className="btn btn-secondary">Back to Factions</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6 md:p-10">
      <div className="max-w-2xl mx-auto space-y-10">
        <div>
          <Link href={`/factions/${faction.slug}`} className="text-accent-gold hover:text-accent-gold-hover text-sm">
            ← View Profile
          </Link>
          <h1 className="text-3xl font-bold text-accent-gold mt-2">Edit {faction.name}</h1>
        </div>

        <section className="glass-panel p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-6">Faction Details</h2>
          <FactionForm
            initial={{
              name: faction.name,
              slug: faction.slug,
              colors: faction.colors,
              bio: faction.bio,
              bannerUrl: faction.bannerUrl,
              sigilUrl: faction.sigilUrl,
            }}
            onSubmit={handleFactionSubmit}
          />
        </section>

        <section className="glass-panel p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-6">Custom Page HTML</h2>
          <CustomHtmlEditor
            faction={faction}
            onSubmit={async (html) => {
              await submitFactionHtml(faction.id, html);
              await loadFaction();
              alert("Sent to the Sheriff for review.");
            }}
          />
        </section>

        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-accent-gold">Characters</h2>
            {!showCharacterForm && !editingCharacter && (
              <button
                type="button"
                onClick={() => setShowCharacterForm(true)}
                className="btn text-sm px-4 py-2"
              >
                Add Character
              </button>
            )}
          </div>

          {(showCharacterForm || editingCharacter) && (
            <div className="mb-6">
              <CharacterForm
                initial={editingCharacter ?? undefined}
                submitLabel={editingCharacter ? "Update Character" : "Add Character"}
                onSubmit={handleCharacterSubmit}
                onCancel={() => {
                  setShowCharacterForm(false);
                  setEditingCharacter(null);
                }}
              />
            </div>
          )}

          <CharacterList
            characters={characters}
            onEdit={(c) => {
              setEditingCharacter(c);
              setShowCharacterForm(false);
            }}
            onDelete={async (id) => {
              await deleteCharacter(id);
              setCharacters(await getCharactersForFaction(faction.id));
              await refreshFactionContext();
            }}
          />
        </section>

        <section className="glass-panel p-8">
          <h2 className="text-xl font-bold text-accent-gold mb-4">Faction Owners</h2>
          <p className="text-text-muted text-sm mb-4">
            Owners can edit this faction, manage characters, and post on its behalf.
          </p>
          <ul className="space-y-2 mb-6">
            {members
              .filter((m) => m.role === "owner")
              .map((m) => (
                <li key={m.id} className="flex items-center justify-between p-3 rounded border border-primary-brown">
                  <span className="text-text-light font-mono text-sm">{m.uid}</span>
                  {m.uid !== user?.uid && (
                    <button
                      type="button"
                      onClick={() => handleRemoveOwner(m.uid)}
                      className="btn btn-danger text-xs px-3 py-1"
                    >
                      Remove
                    </button>
                  )}
                  {m.uid === user?.uid && (
                    <span className="text-text-muted text-xs">(you)</span>
                  )}
                </li>
              ))}
          </ul>
          <div className="flex gap-2">
            <input
              type="text"
              value={ownerUid}
              onChange={(e) => setOwnerUid(e.target.value)}
              placeholder="User UID to add as owner"
              className="form-input flex-1 text-sm"
            />
            <button type="button" onClick={handleAddOwner} className="btn text-sm px-4 py-2 shrink-0">
              Add Owner
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
