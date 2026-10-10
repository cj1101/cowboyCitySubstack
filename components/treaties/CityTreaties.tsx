"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listActiveTreatiesForCity } from "@/lib/firestore/treaties";
import { TREATY_TYPE_LABELS } from "@/lib/treaties/machine";
import { TreatyBadge } from "@/components/treaties/TreatyBadge";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { actionError } from "@/lib/async";

export function CityTreaties({ cityId }: { cityId: string }) {
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    listActiveTreatiesForCity(cityId)
      .then(setTreaties)
      .catch((err) => setError(actionError(err, "Could not load this city's treaties.")))
      .finally(() => setLoading(false));
  }, [cityId]);

  return (
    <section className="glass-panel p-6">
      <h2 className="text-xl font-bold text-accent-gold mb-3">Treaties</h2>
      {loading && <p className="text-text-muted" role="status">Loading treaties…</p>}
      {error && <p className="text-sm font-bold" role="alert">{error}</p>}
      {!loading && !error && treaties.length === 0 ? (
        <p className="text-text-muted">No active treaties.</p>
      ) : null}
      {!loading && !error && treaties.length > 0 ? (
        <ul className="space-y-2">
          {treaties.map((treaty) => (
            <li key={treaty.id} className="flex flex-wrap items-center gap-2">
              <Link href={`/treaties/${treaty.id}`} className="text-accent-gold font-bold">
                {treaty.name}
              </Link>
              <span className="text-text-muted text-sm">{TREATY_TYPE_LABELS[treaty.type]}</span>
              <TreatyBadge status={treaty.status} expiresOn={treaty.expiresOn} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
