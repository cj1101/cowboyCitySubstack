"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { ensureCityOwnerClaim, getAllFactions } from "@/lib/firestore/factions";
import { listReadablePending } from "@/lib/firestore/treaties";
import { TREATY_TYPE_LABELS } from "@/lib/treaties/machine";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

export default function NegotiationsPage() {
  const { user, loading } = useAuth();
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);

  useEffect(() => {
    if (!user) return;
    getAllFactions().then(async (cities) => {
      const owned = cities.filter((city) => city.ownerUids.includes(user.uid));
      if (owned[0]) await ensureCityOwnerClaim(user.uid, owned[0].id).catch(() => undefined);
      const pending = await listReadablePending(user.uid, owned.length > 0);
      setTreaties(pending);
    }).catch(() => setTreaties([]));
  }, [user]);

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to see treaty negotiations.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href="/treaties" className="text-accent-gold text-sm">← Active treaties</Link>
        <h1 className="text-3xl font-bold text-accent-gold">Treaty negotiations</h1>
        <p className="text-text-muted">Pending agreements are visible here to the cities involved, and to every city owner when a treaty is open. They are not on the map.</p>
        {treaties.length === 0 ? (
          <p className="text-text-muted">Nothing is waiting on you.</p>
        ) : (
          treaties.map((treaty) => (
            <article key={treaty.id} className="glass-panel p-5">
              <Link href={`/treaties/${treaty.id}`} className="text-xl font-bold text-accent-gold">{treaty.name}</Link>
              <p className="text-sm text-text-muted">{TREATY_TYPE_LABELS[treaty.type]} · revision {treaty.currentRevision} · pending</p>
              <p className="mt-2">{treaty.purpose}</p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
