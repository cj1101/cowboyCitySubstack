"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { buildTimeline, type TimelineEntry } from "@/lib/mentions";

const TYPE_COLORS: Record<string, string> = {
  announcement: "bg-accent-gold text-darker-brown",
  build: "bg-primary-brown text-text-light",
  lore: "bg-dark-brown text-text-light border border-accent-gold",
  debate: "bg-danger text-text-light",
  event: "bg-accent-gold-hover text-darker-brown",
  wiki: "bg-primary-brown text-text-light",
};

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function TimelinePage() {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await buildTimeline();
        setEntries(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load timeline");
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const groupedByMonth = entries.reduce<Record<string, TimelineEntry[]>>((acc, entry) => {
    const key = entry.date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    if (!acc[key]) acc[key] = [];
    acc[key].push(entry);
    return acc;
  }, {});

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="glass-panel p-6">
          <h1 className="text-3xl font-bold text-accent-gold mb-2">Realm Timeline</h1>
          <p className="text-text-muted">
            Catch up on world events — a condensed chronicle of posts across all factions.
          </p>
        </div>

        {loading && (
          <div className="glass-panel p-8 text-center text-text-muted">Loading timeline…</div>
        )}

        {error && (
          <div className="glass-panel p-8 text-center text-danger">{error}</div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="glass-panel p-8 text-center text-text-muted">
            No timeline entries yet. Posts will appear here as factions share lore.
          </div>
        )}

        {!loading &&
          !error &&
          Object.entries(groupedByMonth).map(([month, monthEntries]) => (
            <section key={month}>
              <h2 className="text-accent-gold font-bold text-lg mb-3 px-2">{month}</h2>
              <div className="space-y-3">
                {monthEntries.map((entry) => (
                  <article key={entry.id} className="glass-panel p-4 flex flex-col sm:flex-row gap-2 sm:gap-4">
                    <div className="text-text-muted text-sm sm:w-24 shrink-0 sm:pt-1">
                      {formatDate(entry.date)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span
                          className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                            TYPE_COLORS[entry.postType ?? "lore"] ?? TYPE_COLORS.lore
                          }`}
                        >
                          {entry.postType ?? entry.type}
                        </span>
                        {entry.factionName && (
                          <span className="text-text-muted text-xs">{entry.factionName}</span>
                        )}
                      </div>
                      <Link
                        href={`/posts/${entry.id}`}
                        className="font-bold text-text-light hover:text-accent-gold transition-colors"
                      >
                        {entry.title}
                      </Link>
                      {entry.summary && (
                        <p className="text-text-muted text-sm mt-1 line-clamp-2">{entry.summary}</p>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}
