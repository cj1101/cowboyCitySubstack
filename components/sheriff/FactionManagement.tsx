"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { deleteFaction, getAllFactions } from "@/lib/firestore/factions";
import type { Faction } from "@/lib/types";

export function FactionManagement() {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllFactions();
      all.sort((a, b) => a.name.localeCompare(b.name));
      setFactions(all);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (faction: Faction) => {
    if (
      !confirm(
        `Delete faction "${faction.name}"? This removes membership records but not posts or characters.`
      )
    ) {
      return;
    }
    setDeletingId(faction.id);
    try {
      await deleteFaction(faction.id);
      setFactions((prev) => prev.filter((f) => f.id !== faction.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete faction");
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return <p className="text-text-muted">Loading factions…</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-text-muted border-b border-primary-brown">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4 hidden sm:table-cell">Slug</th>
            <th className="py-2 pr-4 hidden md:table-cell">Owners</th>
            <th className="py-2 pr-4 hidden lg:table-cell">HTML Status</th>
            <th className="py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {factions.map((faction) => (
            <tr key={faction.id} className="border-b border-primary-brown/50">
              <td className="py-3 pr-4">
                <Link
                  href={`/factions/${faction.slug}`}
                  className="text-accent-gold hover:underline"
                >
                  {faction.name}
                </Link>
              </td>
              <td className="py-3 pr-4 hidden sm:table-cell text-text-muted">
                {faction.slug}
              </td>
              <td className="py-3 pr-4 hidden md:table-cell text-text-muted">
                {faction.ownerUids.length}
              </td>
              <td className="py-3 pr-4 hidden lg:table-cell text-text-muted">
                {faction.htmlStatus ?? "—"}
              </td>
              <td className="py-3 flex flex-wrap gap-2">
                <Link
                  href={`/factions/${faction.slug}/edit`}
                  className="btn btn-secondary text-xs px-3 py-1"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={() => handleDelete(faction)}
                  disabled={deletingId === faction.id}
                  className="btn btn-danger text-xs px-3 py-1 disabled:opacity-50"
                >
                  {deletingId === faction.id ? "Deleting…" : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {factions.length === 0 && (
        <p className="text-text-muted text-center py-8">No factions found.</p>
      )}
    </div>
  );
}
