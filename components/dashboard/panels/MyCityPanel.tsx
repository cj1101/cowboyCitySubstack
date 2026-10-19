"use client";

/**
 * My city / spotlight (brief §4.2 #2, §5.3; spec §5.2.2).
 *
 * The city is resolved by the read path through the §5.3.5 fallback
 * chain — (1) prefs defaultCityId → (2) the member's own first claimed
 * city → (3) the shared city → (4) alphabetically first live faction;
 * guests go straight to (3) as "Featured city". NO step ever defaults
 * to Cascadia (TC-D05, by construction). The panel header names the
 * city and, when the source isn't (1), why (resolutionNote).
 *
 * Variant `sheet` renders the injected SimSheet node (components/city/
 * SimSheet.tsx — the identical component the city page uses, TC-D01)
 * when the composition supplies one; without it, the panel renders its
 * own verified-figure table from the detail prop. Variant `card`
 * renders the shared CityCardView. A member with no city gets the
 * onboarding state — never another member's city presented as theirs.
 *
 * Pre-allocation figures render `—` with the honest caption; the
 * allocation affordance for the owner is a disabled, labeled Phase 4
 * placeholder (§5.7 honesty — no fake controls).
 */

import type { ReactNode } from "react";
import Link from "next/link";
import {
  SIM_INDEX_LABELS,
  type DashboardCityCard,
  type DashboardFigure,
  type PanelLoadState,
  type SimIndexKey,
} from "@/lib/dashboard/registry";
import { PanelShell } from "../PanelShell";
import { StatFigure } from "../StatFigure";
import { CityCardView } from "../CityCardView";

export interface MyCityDetail {
  /** All eight indices + stocks, as why-linkable figures. */
  indices: Record<SimIndexKey, DashboardFigure>;
  treasury: DashboardFigure;
  gdp: DashboardFigure;
  population: DashboardFigure;
  households: DashboardFigure;
  housingUnits: DashboardFigure;
  allocation:
    | { state: "unallocated" }
    | { state: "allocated"; entryHref?: string }
    | null;
  /** True when the viewer owns this city (allocation affordance). */
  viewerIsOwner: boolean;
}

export interface MyCityData {
  mode: "member" | "guest-featured" | "no-city";
  card: DashboardCityCard | null;
  detail: MyCityDetail | null;
  /** Header subline when the resolution source isn't prefs, e.g.
   *  "Your city — set a default in Customize" (brief §5.3). */
  resolutionNote: string | null;
  /** The viewer's own cities, for the in-panel switcher. */
  viewerCities: { factionId: string; name: string }[];
  /** Where a member with no city goes to create/claim one. */
  createCityHref: string;
}

const INDEX_KEYS = Object.keys(SIM_INDEX_LABELS) as SimIndexKey[];

export function MyCityPanel({
  state,
  variant,
  sheet,
  onSelectCity,
  footer,
}: {
  state: PanelLoadState<MyCityData>;
  variant: string;
  /** The SimSheet node for the resolved city, supplied by the
   *  composition (brief §6.1); used by the sheet variant when present. */
  sheet?: ReactNode;
  onSelectCity?: (factionId: string) => void;
  footer?: ReactNode;
}) {
  const data = state.status === "ready" ? state.data : null;
  const title =
    data?.mode === "guest-featured"
      ? "Featured city"
      : data?.card
        ? `My city — ${data.card.name}`
        : "My city";
  return (
    <PanelShell
      title={title}
      subline={data?.resolutionNote}
      state={state}
      footer={footer}
    >
      {data ? (
        data.mode === "no-city" || !data.card ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>You haven’t created or claimed a city yet.</p>
            <Link href={data.createCityHref} className="underline">
              Create or claim a city
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {data.viewerCities.length > 1 && onSelectCity ? (
              <label className="text-sm flex flex-wrap items-center gap-2">
                <span className="text-text-muted">Showing:</span>
                <select
                  className="min-h-11 px-2"
                  value={data.card.factionId}
                  onChange={(event) => onSelectCity(event.target.value)}
                >
                  {data.viewerCities.map((city) => (
                    <option key={city.factionId} value={city.factionId}>
                      {city.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {variant === "card" ? (
              <CityCardView card={data.card} />
            ) : sheet ? (
              sheet
            ) : data.detail ? (
              <div className="flex flex-col gap-3">
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                  {INDEX_KEYS.map((key) => (
                    <div key={key}>
                      <dt className="text-xs text-text-muted">
                        {SIM_INDEX_LABELS[key]}
                      </dt>
                      <dd>
                        <StatFigure figure={data.detail!.indices[key]} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-text-muted">Treasury (Rubars)</dt>
                    <dd>
                      <StatFigure figure={data.detail.treasury} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">GDP (Rubars)</dt>
                    <dd>
                      <StatFigure figure={data.detail.gdp} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Population</dt>
                    <dd>
                      <StatFigure figure={data.detail.population} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Households</dt>
                    <dd>
                      <StatFigure figure={data.detail.households} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-muted">Housing units</dt>
                    <dd>
                      <StatFigure figure={data.detail.housingUnits} />
                    </dd>
                  </div>
                </dl>
                {data.detail.allocation?.state === "unallocated" ? (
                  <div className="text-sm flex flex-col gap-1">
                    <p className="text-text-muted">
                      Season-0 points not yet allocated.
                    </p>
                    {data.detail.viewerIsOwner ? (
                      <button type="button" className="btn text-sm px-4 py-2 min-h-11" disabled>
                        Allocate your Season-0 points — arrives with the play loop (Phase 4)
                      </button>
                    ) : null}
                  </div>
                ) : data.detail.allocation?.state === "allocated" ? (
                  <p className="text-sm text-text-muted">
                    Season-0 allocation committed.
                    {data.detail.allocation.entryHref ? (
                      <>
                        {" "}
                        <Link href={data.detail.allocation.entryHref} className="underline">
                          Allocation Log entry
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            ) : (
              <CityCardView card={data.card} />
            )}
          </div>
        )
      ) : null}
    </PanelShell>
  );
}
