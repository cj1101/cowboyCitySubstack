"use client";

import Link from "next/link";
import type { Faction, Post } from "@/lib/types";

function foundedLabel(value?: string | null): string {
  if (!value) return "Unknown";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export function CityShowcase({ faction, posts }: { faction: Faction; posts: Post[] }) {
  const builds = posts.filter((post) => post.type === "build");
  const latest = posts.slice(0, 4);
  const primary = faction.colors?.primary ?? "#169C9C";

  return (
    <>
      <section className="glass-panel p-6">
        <h2 className="text-xl font-bold text-accent-gold mb-4">City record</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-muted">Population</dt>
            <dd className="text-lg font-bold">{typeof faction.population === "number" ? faction.population.toLocaleString() : "Uncounted"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-muted">Founded</dt>
            <dd className="text-lg font-bold">{foundedLabel(faction.foundedOn)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-muted">Flag</dt>
            <dd className="mt-1">
              {faction.sigilUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={faction.sigilUrl} alt={`${faction.name} flag`} className="w-16 h-16 max-w-full object-contain border-2 border-ink bg-white" />
              ) : (
                <span className="inline-block w-16 h-10 border-2 border-ink" style={{ background: primary }} aria-label={`${faction.name} colors`} />
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="glass-panel p-6">
        <h2 className="text-xl font-bold text-accent-gold mb-4">Builds</h2>
        {builds.length === 0 ? (
          <p className="text-text-muted">No builds posted yet.</p>
        ) : (
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {builds.map((post) => {
              const shot = post.media?.find((item) => item.type === "image")?.url || post.images?.[0];
              return (
                <li key={post.id}>
                  <Link href={`/posts/${post.id}`} className="block border-2 border-ink bg-white">
                    {shot ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={shot} alt="" className="w-full h-36 sm:h-40 object-contain bg-[#f7f6f3]" />
                    ) : (
                      <span className="flex h-36 items-center justify-center text-sm text-text-muted">No photo</span>
                    )}
                    <span className="block px-2 py-2 text-sm font-bold truncate">{post.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="glass-panel p-6">
        <h2 className="text-xl font-bold text-accent-gold mb-3">Latest posts</h2>
        {latest.length === 0 ? (
          <p className="text-text-muted">No posts yet.</p>
        ) : (
          <ul className="space-y-2">
            {latest.map((post) => (
              <li key={post.id}>
                <Link href={`/posts/${post.id}`} className="text-accent-gold font-bold">{post.title}</Link>
                <span className="text-text-muted text-sm"> · {post.type}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
