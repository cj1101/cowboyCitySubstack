"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Timestamp } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { TipTapEditor } from "@/components/editor/TipTapEditor";
import { PostTypeBadge } from "@/components/posts/PostTypeBadge";
import { fanOutNewPost } from "@/lib/firestore/postFanout";
import {
  createPost,
  getCharactersByFaction,
  getPosts,
  getUserFactions,
  updatePostMedia,
} from "@/lib/firestore/posts";
import { uploadPostGallery } from "@/lib/storage/uploads";
import type { Character, Faction, Post, PostStatus, PostType } from "@/lib/types";
import { POST_TYPES, POST_TYPE_LABELS } from "@/lib/types";
import { actionError, withTimeout } from "@/lib/async";

export default function NewPostPage() {
  const { user, profile, loading: authLoading } = useAuth();
  const router = useRouter();
  const [type, setType] = useState<PostType>("lore");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [factionId, setFactionId] = useState("");
  const [characterId, setCharacterId] = useState("");
  const [tagged, setTagged] = useState<string[]>([]);
  const [referenced, setReferenced] = useState<string[]>([]);
  const [refQuery, setRefQuery] = useState("");
  const [recent, setRecent] = useState<Post[]>([]);
  const [pinned, setPinned] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [settlementYear, setSettlementYear] = useState("");
  const [era, setEra] = useState("");
  const [contentWarning, setContentWarning] = useState("");
  const [spoiler, setSpoiler] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [factions, setFactions] = useState<Faction[]>([]);
  const [allCities, setAllCities] = useState<Faction[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getUserFactions(user.uid)
      .then((list) => {
        setFactions(list);
        setAllCities(list);
        if (list.length === 1) setFactionId(list[0].id);
      })
      .catch(() => setFactions([]));
    getPosts()
      .then((posts) => {
        setRecent(posts.slice(0, 40));
        const ids = [...new Set(posts.flatMap((post) => post.cityIds ?? [post.factionId]))];
        if (ids.length) {
          import("@/lib/firestore/posts").then(({ getAllFactions }) =>
            getAllFactions().then(setAllCities).catch(() => undefined)
          );
        }
      })
      .catch(() => setRecent([]));
  }, [user]);

  useEffect(() => {
    if (!factionId) {
      setCharacters([]);
      setCharacterId("");
      return;
    }
    getCharactersByFaction(factionId)
      .then(setCharacters)
      .catch(() => setCharacters([]));
  }, [factionId]);

  const visibleRefs = useMemo(() => {
    const q = refQuery.trim().toLowerCase();
    return recent.filter((post) => !q || post.title.toLowerCase().includes(q)).slice(0, 8);
  }, [recent, refQuery]);

  const addFiles = useCallback((list: FileList | null) => {
    const next = Array.from(list ?? []);
    if (next.length === 0) return;
    setFiles((current) => [...current, ...next].slice(0, 10));
  }, []);

  const publish = async (status: PostStatus) => {
    if (!user) return;
    if (!factionId) {
      setError("Choose which city you are posting as.");
      return;
    }
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    if (status === "scheduled" && !scheduleAt) {
      setError("Pick a date and time to schedule this post.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const year = settlementYear ? Number(settlementYear) : null;
      const postId = await withTimeout(createPost(
        {
          type,
          factionId,
          characterId,
          title: title.trim(),
          body,
          images: [],
          media: [],
          pinned: profile?.isAdmin && type === "announcement" ? pinned : false,
          cityIds: [factionId, ...tagged.filter((id) => id !== factionId)],
          referencedPostIds: referenced,
          status,
          publishAt: status === "scheduled" ? Timestamp.fromDate(new Date(scheduleAt)) : null,
          settlementYear: year && year > 0 ? year : null,
          era: era.trim() || null,
          contentWarning: contentWarning.trim() || null,
          spoiler: spoiler || Boolean(contentWarning.trim()),
        },
        user.uid
      ), 15000);
      if (files.length > 0) {
        const media = await withTimeout(uploadPostGallery(postId, files), 60000);
        await withTimeout(updatePostMedia(postId, media), 10000);
      }
      router.push(status === "published" ? `/posts/${postId}` : "/drafts");
      if (status === "published") {
        void fanOutNewPost({
          id: postId,
          title: title.trim(),
          body,
          factionId,
          cityIds: [factionId, ...tagged.filter((id) => id !== factionId)],
          referencedPostIds: referenced,
          authorUid: user.uid,
        });
      }
    } catch (err) {
      console.error(err);
      setError(actionError(err, "Failed to save the post."));
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading) return <div className="text-center py-16 text-text-muted">Loading…</div>;
  if (!user) {
    return (
      <div className="max-w-lg mx-auto py-16 px-4 text-center">
        <p className="text-text-muted mb-4">Sign in to create a post.</p>
        <Link href="/login" className="btn">Sign In</Link>
      </div>
    );
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <Link href="/" className="text-accent-gold text-sm">← Back to feed</Link>
        <h1 className="text-3xl font-bold text-accent-gold mb-6">New Post</h1>
        <form
          className="glass-panel p-6 space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            void publish("published");
          }}
        >
          {error && <div className="p-3 rounded bg-danger/20 border border-danger text-sm">{error}</div>}
          <fieldset>
            <legend className="form-label">Post type</legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {POST_TYPES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setType(item)}
                  className={`p-3 rounded border text-left ${type === item ? "border-accent-gold bg-accent-gold/10" : "border-primary-brown"}`}
                >
                  <PostTypeBadge type={item} />
                  <span className="block text-xs text-text-muted mt-1">{POST_TYPE_LABELS[item]}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div>
            <label className="form-label" htmlFor="city">Posting as city</label>
            <select id="city" className="form-input" value={factionId} required onChange={(e) => setFactionId(e.target.value)}>
              <option value="">Select a city…</option>
              {factions.map((city) => (
                <option key={city.id} value={city.id}>{city.name}</option>
              ))}
            </select>
            {factions.length === 0 && <p className="text-sm text-text-muted mt-2">Found a city before you post.</p>}
          </div>
          {characters.length > 0 && (
            <div>
              <label className="form-label" htmlFor="voice">Character voice (optional)</label>
              <select id="voice" className="form-input" value={characterId} onChange={(e) => setCharacterId(e.target.value)}>
                <option value="">The city itself</option>
                {characters.map((character) => (
                  <option key={character.id} value={character.id}>{character.name}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <p className="form-label">Tag other cities</p>
            <div className="flex flex-wrap gap-2">
              {allCities.filter((city) => city.id !== factionId).map((city) => (
                <label key={city.id} className="text-sm flex items-center gap-2 border border-primary-brown rounded px-2 py-1">
                  <input
                    type="checkbox"
                    checked={tagged.includes(city.id)}
                    onChange={(e) => setTagged((current) => e.target.checked ? [...current, city.id] : current.filter((id) => id !== city.id))}
                  />
                  {city.name}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="form-label" htmlFor="title">Title</label>
            <input id="title" className="form-input" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
          </div>
          <div>
            <label className="form-label">Body</label>
            <p className="text-xs text-text-muted mb-2">Use [[wiki-slug]] or [[city-slug/entry|label]] for wiki links. @faction:slug still works.</p>
            <TipTapEditor content={body} onChange={setBody} />
          </div>
          <div>
            <label className="form-label">Photos and videos</label>
            <input type="file" accept="image/*,video/*" multiple className="form-input" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <p className="text-xs text-text-muted mt-1">Up to 10 items. Images are compressed. Videos stay under 80 MB and get a thumbnail.</p>
            {files.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex justify-between gap-2">
                    <span>{file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name) ? "Video" : "Photo"} · {file.name}</span>
                    <button type="button" className="text-accent-gold" onClick={() => {
                      setFiles((current) => current.filter((_, i) => i !== index));
                    }}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label className="form-label" htmlFor="refs">Reference other posts</label>
            <input id="refs" className="form-input" value={refQuery} onChange={(e) => setRefQuery(e.target.value)} placeholder="Search recent posts" />
            <div className="mt-2 space-y-1">
              {visibleRefs.map((post) => (
                <label key={post.id} className="flex gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={referenced.includes(post.id)}
                    onChange={(e) => setReferenced((current) => e.target.checked ? [...current, post.id] : current.filter((id) => id !== post.id))}
                  />
                  {post.title}
                </label>
              ))}
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="form-label" htmlFor="year">Settlement Year</label>
              <input id="year" type="number" min={1} className="form-input" value={settlementYear} onChange={(e) => setSettlementYear(e.target.value)} placeholder="391" />
            </div>
            <div>
              <label className="form-label" htmlFor="era">Era</label>
              <input id="era" className="form-input" value={era} onChange={(e) => setEra(e.target.value)} placeholder="The Compact" list="era-suggestions" />
              <datalist id="era-suggestions">
                <option value="Founding" />
                <option value="Expansion" />
                <option value="The Compact" />
                <option value="Present Age" />
              </datalist>
            </div>
          </div>
          <div>
            <label className="form-label" htmlFor="warning">Content warning</label>
            <input id="warning" className="form-input" value={contentWarning} onChange={(e) => setContentWarning(e.target.value)} placeholder="Dark Cascadia lore" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={spoiler} onChange={(e) => setSpoiler(e.target.checked)} />
            Blur this post until a reader chooses to show it
          </label>
          <div>
            <label className="form-label" htmlFor="schedule">Schedule (optional)</label>
            <input id="schedule" type="datetime-local" className="form-input" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          </div>
          {profile?.isAdmin && type === "announcement" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              Pin this announcement
            </label>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn" disabled={submitting} aria-busy={submitting}>{submitting ? "Publishing…" : "Publish"}</button>
            <button type="button" className="btn btn-secondary" disabled={submitting} onClick={() => publish("draft")}>Save draft</button>
            <button type="button" className="btn btn-secondary" disabled={submitting || !scheduleAt} onClick={() => publish("scheduled")}>Schedule</button>
          </div>
        </form>
      </div>
    </div>
  );
}
