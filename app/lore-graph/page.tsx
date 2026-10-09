"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildLoreGraph, type LoreGraphEdge } from "@/lib/mentions";

function targetHref(edge: LoreGraphEdge): string {
  if (edge.targetType === "faction") {
    return `/cities/${edge.targetSlug ?? edge.targetId}`;
  }
  if (edge.targetType === "post") {
    return `/posts/${edge.targetId}`;
  }
  return "#";
}

function sourceHref(edge: LoreGraphEdge): string {
  if (edge.sourceType === "post") {
    return `/posts/${edge.sourceId}`;
  }
  return "#";
}

export default function LoreGraphPage() {
  const [edges, setEdges] = useState<LoreGraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "faction" | "character" | "post">("all");

  useEffect(() => {
    async function load() {
      try {
        const data = await buildLoreGraph();
        setEdges(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load lore graph");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const filtered = edges.filter((edge) => filter === "all" || edge.targetType === filter);

  const grouped = filtered.reduce<Record<string, LoreGraphEdge[]>>((acc, edge) => {
    const key = `${edge.sourceType}:${edge.sourceId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(edge);
    return acc;
  }, {});

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="glass-panel p-6">
          <h1 className="text-3xl font-bold text-accent-gold mb-2">Lore Graph</h1>
          <p className="text-text-muted">
            Browse @mention links between posts, factions, and characters across the realm.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {(["all", "faction", "character", "post"] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setFilter(type)}
              className={`btn text-sm px-4 py-2 ${
                filter === type ? "" : "btn-secondary"
              }`}
            >
              {type === "all" ? "All Links" : `${type}s`}
            </button>
          ))}
        </div>

        {loading && (
          <div className="glass-panel p-8 text-center text-text-muted">Loading lore links…</div>
        )}

        {error && (
          <div className="glass-panel p-8 text-center text-danger">{error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="glass-panel p-8 text-center text-text-muted">
            <p>No @mention links found yet.</p>
            <p className="text-sm mt-2">
              Use <code className="text-accent-gold">@faction:slug</code>,{" "}
              <code className="text-accent-gold">@character:id</code>, or{" "}
              <code className="text-accent-gold">@post:id</code> in posts and wiki sections.
            </p>
          </div>
        )}

        {!loading && !error && Object.entries(grouped).map(([sourceKey, sourceEdges]) => {
          const first = sourceEdges[0];
          return (
            <div key={sourceKey} className="glass-panel p-6">
              <h2 className="text-lg font-bold text-accent-gold mb-3">
                <Link href={sourceHref(first)} className="hover:text-accent-gold-hover">
                  {first.sourceLabel}
                </Link>
                <span className="text-text-muted text-sm font-normal ml-2">
                  ({first.sourceType})
                </span>
              </h2>
              <ul className="space-y-2">
                {sourceEdges.map((edge, index) => (
                  <li key={`${edge.targetType}-${edge.targetId}-${index}`} className="flex items-center gap-2 text-sm">
                    <span className="text-text-muted">→</span>
                    <span className="text-xs uppercase text-accent-gold w-16">{edge.targetType}</span>
                    {edge.targetType === "character" ? (
                      <span>{edge.targetLabel}</span>
                    ) : (
                      <Link
                        href={targetHref(edge)}
                        className="text-text-light hover:text-accent-gold underline"
                      >
                        {edge.targetLabel}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
