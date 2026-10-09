"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { followCity, getFollowedCityIds, unfollowCity } from "@/lib/firestore/follows";
import type { Faction } from "@/lib/types";

export function CityPanel({ faction, isOwner }: { faction: Faction; isOwner: boolean }) {
  const { user } = useAuth();
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    if (!user) return;
    getFollowedCityIds(user.uid)
      .then((ids) => setFollowing(ids.includes(faction.id)))
      .catch(() => setFollowing(false));
  }, [user, faction.id]);

  const toggleFollow = async () => {
    if (!user) return;
    if (following) {
      await unfollowCity(user.uid, faction.id);
      setFollowing(false);
    } else {
      await followCity(user.uid, faction.id);
      setFollowing(true);
    }
  };

  return (
    <section className="glass-panel p-6 space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={toggleFollow}>
          {following ? "Following" : "Follow city"}
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
