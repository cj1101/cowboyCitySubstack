"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { createThread } from "@/lib/firestore/forum";
import { getAllFactions } from "@/lib/firestore/factions";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import type { Faction } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

export default function NewThreadPage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [cityId, setCityId] = useState("");
  const [treatyId, setTreatyId] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([getAllFactions(), listActiveTreaties()])
      .then(([factions, active]) => {
        setCities(factions);
        setTreaties(active);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      const id = await createThread({
        title,
        body,
        authorUid: user.uid,
        authorName: profile?.displayName || "Member",
        cityId: cityId || null,
        treatyId: treatyId || null,
        files,
      });
      router.push(`/forum/${id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : UPLOAD_FAILED_MESSAGE;
      setError(message === UPLOAD_FAILED_MESSAGE || /storage|upload/i.test(message) ? UPLOAD_FAILED_MESSAGE : message);
      setBusy(false);
    }
  };

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to start a thread.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <form onSubmit={submit} className="max-w-2xl mx-auto glass-panel p-6 space-y-4">
        <Link href="/forum" className="text-accent-gold text-sm">← Forum</Link>
        <h1 className="text-3xl font-bold text-accent-gold">New thread</h1>
        <input className="form-input" placeholder="Title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        <textarea className="form-input" rows={8} placeholder="Body" value={body} onChange={(event) => setBody(event.target.value)} required />
        <div>
          <label className="form-label" htmlFor="images">Images</label>
          <input id="images" className="form-input" type="file" accept="image/*" multiple onChange={(event) => setFiles([...(event.target.files || [])])} />
        </div>
        <select className="form-input" value={cityId} onChange={(event) => setCityId(event.target.value)}>
          <option value="">Tag a city (optional)</option>
          {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
        </select>
        <select className="form-input" value={treatyId} onChange={(event) => setTreatyId(event.target.value)}>
          <option value="">Tag a treaty (optional)</option>
          {treaties.map((treaty) => <option key={treaty.id} value={treaty.id}>{treaty.name}</option>)}
        </select>
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        <button className="btn" disabled={busy} type="submit">{busy ? "Posting…" : "Post thread"}</button>
      </form>
    </div>
  );
}
