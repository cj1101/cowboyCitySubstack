"use client";

/**
 * Take an action — DISPLAY-ONLY SHELL (brief §4.2 #11, §4.3 [FINAL]).
 * Phase 3 ships the furniture of the play loop and none of its
 * machinery: an acting-city selector (the viewer's cities; the
 * shared city routes to Mayor/Town Hall copy), a free-text input,
 * and a disabled preview region labeled exactly "Preview arrives
 * with the play loop — Phase 4".
 *
 * The shell submits nothing and writes nothing — there is no submit
 * control at all, and the draft text lives only in this component's
 * local state. The preview region carries the prototype's layout
 * (parsed action · kind · predicted effects · other cities touched ·
 * confirmation path) as labeled, empty slots: that is the shape
 * Phase 4 fills. Phase 3 ships NONE of the prototype's keyword
 * heuristics or invented numbers (spec §4.2.12), and the disabled
 * state is labeled, never styled as live (spec §8.1). No export
 * affordance exists on this panel (brief §10.2) — it takes no
 * footer.
 *
 * Members only (registry): guests never receive this panel.
 */

import { useState } from "react";
import type { PanelLoadState } from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";

export interface ActionBoxCity {
  factionId: string;
  name: string;
  /** The shared city (Cowboy City): acting there routes through the
   *  Mayor / Town Hall, not a sole owner (brief §4.3). */
  isShared: boolean;
}

export interface ActionBoxData {
  /** The viewer's own cities first, then the shared city. */
  cities: ActionBoxCity[];
}

const PREVIEW_SLOTS = [
  "Parsed action",
  "Kind",
  "Predicted effects",
  "Other cities touched",
  "Confirmation path",
] as const;

export function ActionBoxPanel({
  state,
}: {
  state: PanelLoadState<ActionBoxData>;
}) {
  const data = state.status === "ready" ? state.data : null;
  const [selectedCityId, setSelectedCityId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const selectedCity =
    data?.cities.find((city) => city.factionId === selectedCityId) ??
    data?.cities[0] ??
    null;
  return (
    <PanelShell title="Take an action" state={state}>
      {data ? (
        data.cities.length === 0 ? (
          <p className="text-sm">
            You haven&rsquo;t created or claimed a city yet — once you
            have one, this is where you&rsquo;ll act on its behalf when
            the play loop arrives in Phase 4.
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">Acting city</span>
              <select
                className="min-h-11"
                value={selectedCity?.factionId ?? ""}
                onChange={(event) => setSelectedCityId(event.target.value)}
              >
                {data.cities.map((city) => (
                  <option key={city.factionId} value={city.factionId}>
                    {city.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedCity?.isShared ? (
              <p className="text-text-muted">
                {selectedCity.name} is the shared city — actions there
                run through the sitting Mayor, with Town Hall able to
                intervene.
              </p>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">What do you want to do?</span>
              <textarea
                className="min-h-24"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Describe the action in your own words…"
              />
            </label>
            <p className="text-xs text-text-muted">
              Draft only — nothing is submitted or saved. Acting on a
              draft arrives with the play loop in Phase 4.
            </p>
            <fieldset
              disabled
              className="rounded border border-darker-brown bg-glass-bg p-4 flex flex-col gap-2"
              aria-label="Action preview"
            >
              <legend className="font-bold px-1">
                Preview arrives with the play loop — Phase 4
              </legend>
              {PREVIEW_SLOTS.map((slot) => (
                <p key={slot} className="flex justify-between gap-3">
                  <span className="text-text-muted">{slot}</span>
                  <span aria-hidden="true">—</span>
                </p>
              ))}
            </fieldset>
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
