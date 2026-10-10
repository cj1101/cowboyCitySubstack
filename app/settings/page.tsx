"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { uploadUserAvatar } from "@/lib/storage/uploads";
import { buildRealmExport, downloadBlob } from "@/lib/export/realm";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { PersonName } from "@/components/profile/PersonName";
import { rememberMember } from "@/lib/profile/members";
import { normalizeMinecraftUsername } from "@/lib/profile/identity";
import { actionError } from "@/lib/async";
import { SubmitButton } from "@/components/ui/SubmitButton";

export default function SettingsPage() {
  const { user, profile, loading } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [minecraftUsername, setMinecraftUsername] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    setDisplayName(profile?.displayName || "");
    setBio(profile?.bio || "");
    setMinecraftUsername(profile?.minecraftUsername || "");
  }, [profile]);

  if (!user) return <ScreenStatus>Sign in to edit your profile.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-xl mx-auto glass-panel p-6 space-y-5">
        <h1 className="text-3xl font-bold text-accent-gold">Your profile</h1>
        <p className="text-text-muted text-sm">This is you, the person. Cities are separate accounts you post as.</p>
        <PersonName
          uid={user.uid}
          name={displayName || profile?.displayName || "Member"}
          email={profile?.email || user.email}
          minecraftUsername={minecraftUsername}
          avatarUrl={profile?.avatarUrl}
          isAdmin={profile?.isAdmin}
          ownsCity={profile?.ownsCity}
          size="md"
        />
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            setError("");
            try {
              const name = normalizeMinecraftUsername(minecraftUsername);
              await updateDoc(doc(getClientDb(), "users", user.uid), {
                displayName: displayName.trim(),
                bio: bio.trim(),
                minecraftUsername: name,
              });
              rememberMember({
                uid: user.uid,
                displayName: displayName.trim(),
                email: profile?.email || user.email || "",
                avatarUrl: profile?.avatarUrl || "",
                minecraftUsername: name,
                isAdmin: profile?.isAdmin === true,
                ownsCity: profile?.ownsCity === true,
              });
              setMessage("Profile saved.");
            } catch (err) {
              setError(actionError(err, "Could not save."));
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
            <label className="form-label" htmlFor="minecraft">Minecraft username</label>
            <input
              id="minecraft"
              className="form-input"
              value={minecraftUsername}
              maxLength={16}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Notch"
              onChange={(e) => setMinecraftUsername(e.target.value)}
            />
            <p className="text-xs text-text-muted mt-2">Your head is drawn from mc-heads.net. If that skin cannot load, the uploaded photo is used instead.</p>
          </div>
          <div>
            <label className="form-label" htmlFor="bio">Bio</label>
            <textarea id="bio" className="form-input" rows={4} value={bio} onChange={(e) => setBio(e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="avatar">Fallback photo</label>
            <input id="avatar" type="file" accept="image/*" className="form-input" disabled={avatarBusy} onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file || !user) return;
              setAvatarBusy(true);
              setMessage("");
              setError("");
              try {
                const url = await uploadUserAvatar(user.uid, file);
                await updateDoc(doc(getClientDb(), "users", user.uid), { avatarUrl: url });
                rememberMember({
                  uid: user.uid,
                  displayName: displayName.trim() || profile?.displayName || "",
                  email: profile?.email || user.email || "",
                  avatarUrl: url,
                  minecraftUsername: profile?.minecraftUsername || "",
                  isAdmin: profile?.isAdmin === true,
                  ownsCity: profile?.ownsCity === true,
                });
                setMessage("Avatar updated.");
              } catch (err) {
                setError(actionError(err, "Upload failed. The image was not stored."));
              } finally {
                setAvatarBusy(false);
              }
            }} />
            {avatarBusy && <p className="text-sm font-bold mt-2" role="status">Uploading avatar…</p>}
          </div>
          <SubmitButton busy={busy} busyLabel="Saving…">Save profile</SubmitButton>
          {message && <p className="text-sm font-bold text-accent-gold" role="status">{message}</p>}
          {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        </form>
        <div className="border-t border-primary-brown pt-4 space-y-3">
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
