"use client";

/**
 * Lore highlights (brief §4.2 #10; spec §5.2.10) — recent wiki
 * entries, layer-badged and cited, in chronological order ONLY.
 * There is no ranking here — no popularity, no engagement order;
 * the read path hands entries newest-first by record and the panel
 * renders them in exactly that order (TC-F discipline: lore is the
 * group's core content, not a feed to optimize).
 *
 * Two canon layers stay labeled (the project's standing rule): each
 * entry carries its layer badge verbatim from the read path —
 * realm canon vs. a city's own lore — and its source citation.
 * Variants: "recent" (the latest entries) and "intertwined"
 * (entries whose lore crosses city lines — the collisions where
 * the politics comes from); the intertwined rows name the other
 * cities the entry touches.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import type { PanelLoadState } from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface LoreHighlight {
  id: string;
  title: string;
  href: string;
  /** Canon-layer badge, verbatim (e.g. "Realm canon", "Cascadia
   *  lore") — the two layers are never blurred. */
  layerLabel: string;
  /** The city this entry belongs to, when it is a city-layer entry. */
  cityName: string | null;
  /** Other cities the entry's lore touches (intertwined variant). */
  linkedCityNames: string[];
  /** Source citation for the entry (document/corpus reference). */
  citationLabel: string | null;
  excerpt: string | null;
}

export interface LoreHighlightsData {
  entries: LoreHighlight[];
}

export function LoreHighlightsPanel({
  state,
  variant,
  footer,
}: {
  state: PanelLoadState<LoreHighlightsData>;
  variant: string;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const intertwined = variant === "intertwined";
  return (
    <PanelShell title="Lore highlights" state={state} footer={footer}>
      {data ? (
        data.entries.length === 0 ? (
          <p className="text-sm">
            {intertwined
              ? "No intertwined lore yet — when one city's story crosses into another's, it shows up here."
              : "No lore entries yet. Uploaded lore becomes wiki entries here once it's adopted."}
          </p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {data.entries.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1">
                <p>
                  <Link href={entry.href} className="font-bold underline">
                    {entry.title}
                  </Link>{" "}
                  <span className="text-xs text-text-muted border border-darker-brown rounded px-1">
                    {entry.layerLabel}
                  </span>
                </p>
                {entry.excerpt ? <p>{entry.excerpt}</p> : null}
                <p className="text-xs text-text-muted">
                  {entry.cityName ? `${entry.cityName}` : null}
                  {intertwined && entry.linkedCityNames.length > 0
                    ? `${entry.cityName ? " · " : ""}crosses into ${entry.linkedCityNames.join(", ")}`
                    : ""}
                  {entry.citationLabel
                    ? `${entry.cityName || (intertwined && entry.linkedCityNames.length > 0) ? " · " : ""}Source: ${entry.citationLabel}`
                    : ""}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </PanelShell>
  );
}
