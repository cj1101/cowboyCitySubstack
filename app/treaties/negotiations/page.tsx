"use client";

import { useCallback, useEffect, useState } from "react";
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
  const [loadingList, setLoadingList] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (!user) return;
    setLoadingList(true);
    setError("");
    getAllFactions().then(async (cities) => {
      const owned = cities.filter((city) => city.ownerUids.includes(user.uid));
      if (owned[0]) await ensureCityOwnerClaim(user.uid, owned[0].id).catch(() => undefined);
      const pending = await listReadablePending(user.uid, owned.length > 0);
      setTreaties(pending);
    }).catch((err) => setError(err instanceof Error ? err.message : "Could not load negotiations."))
      .finally(() => setLoadingList(false));
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to see treaty negotiations.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href="/treaties" className="text-accent-gold text-sm">← Active treaties</Link>
        <h1 className="text-3xl font-bold text-accent-gold">Treaty negotiations</h1>
        <p className="text-text-muted">Pending agreements are visible here to the cities involved, and to every city owner when a treaty is open. They are not on the map.</p>
        {loadingList && <p className="text-text-muted" role="status">Loading negotiations…</p>}
        {error && (
          <p className="text-sm font-bold" role="alert">
            {error}{" "}
            <button type="button" className="btn btn-secondary text-sm px-3 py-1.5 min-h-11" disabled={loadingList} onClick={load}>
              {loadingList ? "Loading…" : "Try again"}
            </button>
          </p>
        )}
        {!loadingList && !error && treaties.length === 0 ? (
          <p className="text-text-muted">Nothing is waiting on you.</p>
        ) : null}
        {!loadingList && !error && treaties.length > 0 ? (
          treaties.map((treaty) => (
            <article key={treaty.id} className="glass-panel p-5">
              <Link href={`/treaties/${treaty.id}`} className="text-xl font-bold text-accent-gold">{treaty.name}</Link>
              <p className="text-sm text-text-muted">{TREATY_TYPE_LABELS[treaty.type]} · revision {treaty.currentRevision} · pending</p>
              <p className="mt-2">{treaty.purpose}</p>
            </article>
          ))
        ) : null}
      </div>
    </div>
  );
}
