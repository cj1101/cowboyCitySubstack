"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { uploadUserAvatar } from "@/lib/storage/uploads";
import { buildRealmExport, downloadBlob } from "@/lib/export/realm";

export default function SettingsPage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    setDisplayName(profile?.displayName || "");
    setBio(profile?.bio || "");
  }, [profile]);

  if (!user) return null;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-xl mx-auto glass-panel p-6 space-y-5">
        <h1 className="text-3xl font-bold text-accent-gold">Your profile</h1>
        <p className="text-text-muted text-sm">This is you, the person. Cities are separate accounts you post as.</p>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            try {
              await updateDoc(doc(getClientDb(), "users", user.uid), {
                displayName: displayName.trim(),
                bio: bio.trim(),
              });
              setMessage("Profile saved.");
            } catch (err) {
              setMessage(err instanceof Error ? err.message : "Could not save.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div>
            <label className="form-label" htmlFor="name">Display name</label>
            <input id="name" className="form-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
          <div>
            <label className="form-label" htmlFor="bio">Bio</label>
            <textarea id="bio" className="form-input" rows={4} value={bio} onChange={(e) => setBio(e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="avatar">Avatar</label>
            <input id="avatar" type="file" accept="image/*" className="form-input" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const url = await uploadUserAvatar(user.uid, file);
              await updateDoc(doc(getClientDb(), "users", user.uid), { avatarUrl: url });
              setMessage("Avatar updated.");
            }} />
          </div>
          <button className="btn" disabled={busy} type="submit">Save profile</button>
          {message && <p className="text-sm text-accent-gold">{message}</p>}
        </form>
        <div className="border-t border-accent-gold/30 pt-4 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Export</h2>
          <p className="text-sm text-text-muted">Download the cities you belong to, their wiki entries, and your posts.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={async () => {
              const result = await buildRealmExport(user.uid);
              downloadBlob(new Blob([result.json], { type: "application/json" }), "cowboy-city-realm.json");
            }}>Download JSON</button>
            <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={async () => {
              const result = await buildRealmExport(user.uid);
              downloadBlob(result.zip, "cowboy-city-realm.zip");
            }}>Download zip</button>
          </div>
          <Link href="/drafts" className="text-accent-gold text-sm block">Drafts and scheduled posts</Link>
        </div>
      </div>
    </div>
  );
}
