"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { getAllFactions } from "@/lib/firestore/factions";
import { TREATY_TYPE_LABELS } from "@/lib/treaties/machine";
import { TreatyBadge } from "@/components/treaties/TreatyBadge";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import type { Faction } from "@/lib/types";
import { actionError } from "@/lib/async";

export default function TreatiesPage() {
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    Promise.all([listActiveTreaties(), getAllFactions()])
      .then(([items, factions]) => {
        setTreaties(items);
        setCities(factions);
      })
      .catch((err) => setError(actionError(err, "Could not load treaties.")))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const nameOf = (id: string) => cities.find((city) => city.id === id)?.name || "City";

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex flex-wrap justify-between gap-3 items-end">
          <div>
            <h1 className="text-3xl font-bold text-accent-gold">Treaties</h1>
            <p className="text-text-muted">Active alliances, trade pacts, and other agreements. Negotiations stay private until at least two cities ratify.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/treaties/negotiations" className="btn btn-secondary text-sm px-4 py-2 min-h-11">Treaty negotiations</Link>
            <Link href="/treaties/new" className="btn text-sm px-4 py-2 min-h-11">Propose</Link>
          </div>
        </div>
        {loading && <p className="text-text-muted" role="status">Loading treaties…</p>}
        {error && (
          <p className="text-sm font-bold" role="alert">
            {error}{" "}
            <button type="button" className="btn btn-secondary text-sm px-3 py-1.5 min-h-11" onClick={load} disabled={loading}>
              {loading ? "Loading…" : "Try again"}
            </button>
          </p>
        )}
        {!loading && !error && treaties.length === 0 ? (
          <p className="text-text-muted">No active treaties yet.</p>
        ) : null}
        {!loading && !error && treaties.map((treaty) => (
            <article key={treaty.id} className="glass-panel p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: treaty.color }} />
                <Link href={`/treaties/${treaty.id}`} className="text-xl font-bold text-accent-gold">{treaty.name}</Link>
                <TreatyBadge status={treaty.status} expiresOn={treaty.expiresOn} />
              </div>
              <p className="text-sm text-text-muted mt-1">
                {TREATY_TYPE_LABELS[treaty.type]} · {treaty.partyCityIds.map(nameOf).join(", ")}
                {treaty.expiresOn ? ` · expires ${treaty.expiresOn}` : ""}
              </p>
              <p className="mt-2">{treaty.purpose}</p>
            </article>
        ))}
      </div>
    </div>
  );
}
