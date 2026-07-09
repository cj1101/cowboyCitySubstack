"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { FactionCard } from "@/components/factions/FactionCard";
import { getAllFactions } from "@/lib/firestore/factions";
import type { Faction } from "@/lib/types";

export default function FactionsPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [factions, setFactions] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }

    getAllFactions()
      .then(setFactions)
      .catch(() => setError("Failed to load factions"))
      .finally(() => setLoading(false));
  }, [user, authLoading, router]);

  if (authLoading || loading) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex items-center justify-center">
        <p className="text-text-muted text-lg">Loading factions…</p>
      </div>
    );
  }

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6 md:p-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-accent-gold">Factions of the Realm</h1>
            <p className="text-text-muted mt-2">Cities, guilds, and powers across Cowboy City.</p>
          </div>
          <Link href="/factions/new" className="btn text-sm px-6 py-2.5 shrink-0 self-start">
            Found a Faction
          </Link>
        </div>

        {error && <p className="text-red-400 mb-6">{error}</p>}

        {factions.length === 0 ? (
          <div className="glass-panel p-10 text-center">
            <p className="text-text-muted text-lg mb-4">No factions have been founded yet.</p>
            <Link href="/factions/new" className="btn">
              Be the First
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {factions.map((faction) => (
              <FactionCard key={faction.id} faction={faction} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
