"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { getAllFactions } from "@/lib/firestore/factions";
import { TREATY_TYPE_LABELS } from "@/lib/treaties/machine";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import type { Faction } from "@/lib/types";

export default function TreatiesPage() {
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);

  useEffect(() => {
    Promise.all([listActiveTreaties(), getAllFactions()])
      .then(([items, factions]) => {
        setTreaties(items);
        setCities(factions);
      })
      .catch(() => undefined);
  }, []);

  const nameOf = (id: string) => cities.find((city) => city.id === id)?.name || "City";

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex flex-wrap justify-between gap-3 items-end">
          <div>
            <h1 className="text-3xl font-bold text-accent-gold">Treaties</h1>
            <p className="text-text-muted">Active alliances, trade pacts, and other agreements. Negotiations stay private until at least two cities ratify.</p>
          </div>
          <div className="flex gap-2">
            <Link href="/treaties/negotiations" className="btn btn-secondary text-sm px-4 py-2">Treaty negotiations</Link>
            <Link href="/treaties/new" className="btn text-sm px-4 py-2">Propose</Link>
          </div>
        </div>
        {treaties.length === 0 ? (
          <p className="text-text-muted">No active treaties yet.</p>
        ) : (
          treaties.map((treaty) => (
            <article key={treaty.id} className="glass-panel p-5">
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 h-3 rounded-full" style={{ background: treaty.color }} />
                <Link href={`/treaties/${treaty.id}`} className="text-xl font-bold text-accent-gold">{treaty.name}</Link>
              </div>
              <p className="text-sm text-text-muted mt-1">{TREATY_TYPE_LABELS[treaty.type]} · {treaty.partyCityIds.map(nameOf).join(", ")}</p>
              <p className="mt-2">{treaty.purpose}</p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
