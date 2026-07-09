"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { TipTapEditor } from "@/components/editor/TipTapEditor";
import { PostTypeBadge } from "@/components/posts/PostTypeBadge";
import {
  createPost,
  getCharactersByFaction,
  getUserFactions,
  updatePostImages,
} from "@/lib/firestore/posts";
import { uploadPostImages } from "@/lib/storage/uploads";
import type { Character, Faction, PostType } from "@/lib/types";
import { POST_TYPES, POST_TYPE_LABELS } from "@/lib/types";

export default function NewPostPage() {
  const { user, profile, loading: authLoading } = useAuth();
  const router = useRouter();

  const [type, setType] = useState<PostType>("lore");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [factionId, setFactionId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [pinned, setPinned] = useState(false);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);

  const [factions, setFactions] = useState<Faction[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getUserFactions(user.uid)
      .then((list) => {
        setFactions(list);
        if (list.length === 1) setFactionId(list[0].id);
      })
      .catch(() => setFactions([]));
  }, [user]);

  useEffect(() => {
    if (!factionId) {
      setCharacters([]);
      setCharacterId("");
      return;
    }
    getCharactersByFaction(factionId)
      .then((list) => {
        setCharacters(list);
        if (list.length === 1) setCharacterId(list[0].id);
      })
      .catch(() => setCharacters([]));
  }, [factionId]);

  const handleImageChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;

      setImageFiles((prev) => [...prev, ...files]);
      files.forEach((file) => {
        const reader = new FileReader();
        reader.onload = () => {
          setImagePreviews((prev) => [...prev, reader.result as string]);
        };
        reader.readAsDataURL(file);
      });
      e.target.value = "";
    },
    []
  );

  const removeImage = useCallback((index: number) => {
    setImageFiles((prev) => prev.filter((_, i) => i !== index));
    setImagePreviews((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!factionId || !characterId) {
      setError("Select a faction and character to post as.");
      return;
    }
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const postId = await createPost({
        type,
        factionId,
        characterId,
        title: title.trim(),
        body,
        images: [],
        pinned: profile?.isAdmin && type === "announcement" ? pinned : false,
      });

      if (type === "build" && imageFiles.length > 0) {
        const urls = await uploadPostImages(postId, imageFiles);
        await updatePostImages(postId, urls);
      }

      router.push(`/posts/${postId}`);
    } catch (err) {
      console.error(err);
      setError("Failed to create post. Make sure you belong to the selected faction.");
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return <div className="text-center py-16 text-text-muted">Loading…</div>;
  }

  if (!user) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center">
        <p className="text-text-muted mb-4">Sign in to create a post.</p>
        <Link href="/login" className="btn">
          Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <header className="mb-8">
          <Link
            href="/"
            className="text-accent-gold text-sm hover:text-accent-gold-hover mb-2 inline-block"
          >
            ← Back to feed
          </Link>
          <h1 className="text-3xl font-bold text-accent-gold">New Post</h1>
        </header>

        <form onSubmit={handleSubmit} className="glass-panel p-6 space-y-6">
          {error && (
            <div className="p-3 rounded bg-danger/20 border border-danger text-text-light text-sm">
              {error}
            </div>
          )}

          <fieldset>
            <legend className="form-label">Post type</legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {POST_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`p-3 rounded border text-left transition-colors ${
                    type === t
                      ? "border-accent-gold bg-accent-gold/10"
                      : "border-accent-gold/30 hover:border-accent-gold/60"
                  }`}
                >
                  <PostTypeBadge type={t} />
                  <span className="block text-xs text-text-muted mt-1">
                    {POST_TYPE_LABELS[t]}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="faction" className="form-label">
              Faction
            </label>
            {factions.length === 0 ? (
              <p className="text-text-muted text-sm">
                No factions available. Ask a faction owner to add you as a member.
              </p>
            ) : (
              <select
                id="faction"
                value={factionId}
                onChange={(e) => {
                  setFactionId(e.target.value);
                  setCharacterId("");
                }}
                className="form-input"
                required
              >
                <option value="">Select faction…</option>
                {factions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="character" className="form-label">
              Character
            </label>
            {!factionId ? (
              <p className="text-text-muted text-sm">Select a faction first.</p>
            ) : characters.length === 0 ? (
              <p className="text-text-muted text-sm">
                No active characters for this faction.
              </p>
            ) : (
              <select
                id="character"
                value={characterId}
                onChange={(e) => setCharacterId(e.target.value)}
                className="form-input"
                required
              >
                <option value="">Select character…</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.title ? ` — ${c.title}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="title" className="form-label">
              Title
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="form-input"
              placeholder="Post title"
              required
              maxLength={200}
            />
          </div>

          <div>
            <label className="form-label">Body</label>
            <TipTapEditor content={body} onChange={setBody} />
          </div>

          {type === "build" && (
            <div>
              <label className="form-label">Build images (carousel)</label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handleImageChange}
                className="form-input py-2 file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:bg-accent-gold file:text-darker-brown file:font-bold"
              />
              {imagePreviews.length > 0 && (
                <div className="grid grid-cols-3 gap-2 mt-3">
                  {imagePreviews.map((src, i) => (
                    <div key={i} className="relative aspect-square rounded overflow-hidden border border-accent-gold/30">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt={`Preview ${i + 1}`} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeImage(i)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-danger text-text-light text-xs font-bold"
                        aria-label="Remove image"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {profile?.isAdmin && type === "announcement" && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={pinned}
                onChange={(e) => setPinned(e.target.checked)}
                className="w-4 h-4 accent-accent-gold"
              />
              <span className="text-text-light text-sm">Pin this announcement to top of feed</span>
            </label>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={submitting || factions.length === 0}
              className="btn disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Publishing…" : "Publish Post"}
            </button>
            <Link href="/" className="btn btn-secondary">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
