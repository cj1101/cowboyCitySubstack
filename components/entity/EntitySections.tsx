"use client";

/**
 * Shared section scaffolding for the entity template (spec §6.2).
 * Every section exists on every entity page; a section with no data
 * renders its honest empty state and never disappears (TC-D01).
 */

import type { ReactNode } from "react";

export function EntitySection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="glass-panel p-5 space-y-3">
      <h2 className="text-lg font-bold text-accent-gold">{title}</h2>
      {children}
    </section>
  );
}

export function HonestEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-text-muted">{children}</p>;
}

/**
 * The not-in-sim state for an entity in a city with no sim presence
 * (brief §8.5). Plain terms, no "inactive/frozen" vocabulary.
 */
export function NotInSimNote({ cityName, claimed }: { cityName: string; claimed: boolean }) {
  return (
    <HonestEmpty>
      {claimed
        ? `${cityName} is in the sim, but no sim record exists for this place yet — it exists in the city's lore and on its map, and its sim record is created when play touches it.`
        : `This city isn't in the sim yet — its owner hasn't claimed it. The lore, wiki, gallery, and map content here is complete; sim sections fill in when the city joins the sim.`}
    </HonestEmpty>
  );
}

export function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
      <span className="text-text-muted min-w-32">{label}</span>
      <span className="text-text-light">{children}</span>
    </div>
  );
}
