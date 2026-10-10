"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { doc, updateDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { uploadUserAvatar } from "@/lib/storage/uploads";
import { buildRealmExport, downloadBlob } from "@/lib/export/realm";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { PlayerAvatar, RoleBadges, minecraftAvatarUrl } from "@/components/profile/RoleBadges";
import { actionError } from "@/lib/async";

export default function SettingsPage() {
  const { user, profile, loading, refreshProfile } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [minecraftName, setMinecraftName] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"ok" | "error">("ok");
  const [busy, setBusy] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!profile || hydrated.current) return;
    hydrated.current = true;
    setDisplayName(profile.displayName || "");
    setBio(profile.bio || "");
    setMinecraftName(profile.minecraftName || "");
  }, [profile]);

  if (!user) return <ScreenStatus>Sign in to edit your profile.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-xl mx-auto glass-panel p-6 space-y-5">
        <h1 className="text-3xl font-bold text-accent-gold">Your profile</h1>
        <div className="flex items-center gap-3">
          <PlayerAvatar minecraftName={minecraftName || profile?.minecraftName} avatarUrl={profile?.avatarUrl} label={displayName || "You"} size={64} />
          <RoleBadges email={profile?.email || user.email} isAdmin={profile?.isAdmin} founder={profile?.ownsCity} />
        </div>
        <p className="text-text-muted text-sm">This is you, the person. Cities are separate accounts you post as.</p>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setMessage("");
            const skinName = minecraftName.trim();
            if (skinName && !minecraftAvatarUrl(skinName)) {
              setMessageTone("error");
              setMessage("Minecraft names use letters, numbers, and underscores, up to 16 characters.");
              setBusy(false);
              return;
            }
            try {
              await updateDoc(doc(getClientDb(), "users", user.uid), {
                displayName: displayName.trim(),
                bio: bio.trim(),
                minecraftName: skinName,
              });
              await refreshProfile();
              setMessageTone("ok");
              setMessage("Profile saved.");
            } catch (err) {
              setMessageTone("error");
              setMessage(actionError(err, "Could not save."));
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
            <label className="form-label" htmlFor="minecraft">Minecraft username</label>
            <input id="minecraft" className="form-input" value={minecraftName} onChange={(e) => setMinecraftName(e.target.value)} placeholder="Notch" maxLength={16} />
            <p className="text-text-muted text-xs mt-1">Shown as your skin from mc-heads.net. Leave blank to use an uploaded photo.</p>
          </div>
          <div>
            <label className="form-label" htmlFor="avatar">Uploaded photo</label>
            <input id="avatar" type="file" accept="image/*" className="form-input" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              try {
                const url = await uploadUserAvatar(user.uid, file);
                await updateDoc(doc(getClientDb(), "users", user.uid), { avatarUrl: url });
                await refreshProfile();
                setMessageTone("ok");
                setMessage("Avatar updated.");
              } catch (err) {
                setMessageTone("error");
                setMessage(actionError(err, "Upload failed. The image was not stored."));
              }
            }} />
          </div>
          <button className="btn" disabled={busy} type="submit">Save profile</button>
          {message && <p className={`text-sm font-bold ${messageTone === "error" ? "" : "text-accent-gold"}`} role={messageTone === "error" ? "alert" : "status"}>{message}</p>}
        </form>
        <div className="border-t border-primary-brown pt-4 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Export</h2>
          <p className="text-sm text-text-muted">Download the cities you belong to, their wiki entries, and your posts.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={async () => {
              try {
                const result = await buildRealmExport(user.uid);
                downloadBlob(new Blob([result.json], { type: "application/json" }), "cowboy-city-realm.json");
                setMessageTone("ok");
                setMessage("JSON download started.");
              } catch (err) {
                setMessageTone("error");
                setMessage(actionError(err, "Could not build that export."));
              }
            }}>Download JSON</button>
            <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={async () => {
              try {
                const result = await buildRealmExport(user.uid);
                downloadBlob(result.zip, "cowboy-city-realm.zip");
                setMessageTone("ok");
                setMessage("Zip download started.");
              } catch (err) {
                setMessageTone("error");
                setMessage(actionError(err, "Could not build that export."));
              }
            }}>Download zip</button>
          </div>
          <Link href="/drafts" className="text-accent-gold text-sm block">Drafts and scheduled posts</Link>
        </div>
      </div>
    </div>
  );
}
