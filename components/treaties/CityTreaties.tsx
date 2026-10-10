"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listActiveTreatiesForCity } from "@/lib/firestore/treaties";
import { TREATY_TYPE_LABELS } from "@/lib/treaties/machine";
import type { StoredTreaty } from "@/lib/firestore/treaties";

export function CityTreaties({ cityId }: { cityId: string }) {
  const [treaties, setTreaties] = useState<StoredTreaty[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    listActiveTreatiesForCity(cityId)
      .then((items) => {
        setTreaties(items);
        setError("");
      })
      .catch(() => {
        setTreaties([]);
        setError("Could not load treaties.");
      });
  }, [cityId]);

  return (
    <section className="glass-panel p-6">
      <h2 className="text-xl font-bold text-accent-gold mb-3">Active treaties</h2>
      {error ? (
        <p className="text-sm font-bold" role="alert">{error}</p>
      ) : treaties.length === 0 ? (
        <p className="text-text-muted">No active treaties.</p>
      ) : (
        <ul className="space-y-2">
          {treaties.map((treaty) => (
            <li key={treaty.id}>
              <Link href={`/treaties/${treaty.id}`} className="text-accent-gold font-bold">
                {treaty.name}
              </Link>
              <span className="text-text-muted text-sm"> · {TREATY_TYPE_LABELS[treaty.type]}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
