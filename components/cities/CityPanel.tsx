"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { followCity, getFollowedCityIds, unfollowCity } from "@/lib/firestore/follows";
import type { Faction } from "@/lib/types";

export function CityPanel({ faction, isOwner }: { faction: Faction; isOwner: boolean }) {
  const { user } = useAuth();
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [followError, setFollowError] = useState("");

  useEffect(() => {
    if (!user) return;
    getFollowedCityIds(user.uid)
      .then((ids) => setFollowing(ids.includes(faction.id)))
      .catch(() => setFollowing(false));
  }, [user, faction.id]);

  const toggleFollow = async () => {
    if (!user || busy) return;
    setBusy(true);
    setFollowError("");
    setNotice("");
    try {
      if (following) {
        await unfollowCity(user.uid, faction.id);
        setFollowing(false);
        setNotice("Unfollowed this city.");
      } else {
        await followCity(user.uid, faction.id);
        setFollowing(true);
        setNotice("Following this city.");
      }
    } catch (error) {
      setFollowError(error instanceof Error ? error.message : "Could not update follow.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass-panel p-6 space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={toggleFollow} disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : following ? "Following" : "Follow city"}
        </button>
        <Link href={`/cities/${faction.slug}/map`} className="btn btn-secondary text-sm px-4 py-2">
          Map
        </Link>
        <Link href={`/cities/${faction.slug}/wiki`} className="btn btn-secondary text-sm px-4 py-2">
          Lore wiki
        </Link>
        {isOwner && (
          <Link href={`/cities/${faction.slug}/edit`} className="btn text-sm px-4 py-2">
            Edit city
          </Link>
        )}
      </div>
      {notice && <p className="text-sm font-bold text-accent-gold" role="status">{notice}</p>}
      {followError && <p className="text-sm font-bold" role="alert">{followError}</p>}
      {(faction.description || faction.bio) && (
        <p className="text-text-light whitespace-pre-wrap">{faction.description || faction.bio}</p>
      )}
      {faction.lore && (
        <div>
          <h2 className="text-xl font-bold text-accent-gold mb-2">Lore</h2>
          <p className="text-text-light whitespace-pre-wrap">{faction.lore}</p>
        </div>
      )}
    </section>
  );
}
