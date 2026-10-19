"use client";

/**
 * The city page's sim section (Phase 3 brief §6.1) — Build Lead
 * wiring. Mounted under the faction profile on
 * app/factions/[slug]/page.tsx; renders, in order:
 *
 *   1. The Sim sheet — Ines' component via components/city/SimSheet
 *      (the identical component the dashboard my-city panel mounts;
 *      TC-D01). An unowned / not-in-sim city gets the sheet's own
 *      not-in-sim state; the lore profile above it renders in full
 *      regardless (§8.5's posture, applied to the city page).
 *   2. The live action intake (Phase 4 step 2, Build Lead assembly)
 *      — June's ActionBox locked to this city. The box mints only
 *      the member's own actor; whether that member holds authority
 *      over this city is the resolver's call, and the preview shows
 *      the answer (acceptance or refusal) before anything is
 *      confirmed.
 *   3. The lore reference block — the ONLY place corpus/lore figures
 *      appear on this page, labeled as lore reference and never in a
 *      sim-stat position (TC-D04). Its Phase 3 source is the faction
 *      record's own lore population; absent data means no block,
 *      never an invented figure.
 *   4. Published claims (brief §7.2) — the shared block.
 *   5. Structures & businesses summary counts, linking to the city
 *      map and to each entity's own page (§6.1) — links only, never
 *      embedded copies.
 *   6. The city workbook affordance (§10.3) — members only; Felix's
 *      runner re-fences the requester before any fetch.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { getFactionBySlug } from "@/lib/firestore/factions";
import { ActionBox } from "@/components/play/ActionBox";
import { offeredKinds } from "@/lib/play/kinds";
import { ACTION_KIND_INDEX } from "@/lib/sim/rules/registry";
import type { Faction } from "@/lib/types";
import SimSheet from "./SimSheet";
import { PublishedClaimsBlock } from "./PublishedClaimsBlock";
import {
  listCityCorporations,
  listCityStructures,
} from "@/lib/entity/resolve";
import { buildingPath, businessPath, cityMapPath } from "@/lib/entity/paths";
import { downloadCityWorkbook } from "@/lib/export/cityWorkbook";

function CityExportButton({ cityId }: { cityId: string }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  if (!user) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-secondary text-sm px-4 py-2"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote("");
          try {
            await downloadCityWorkbook({ uid: user.uid, cityId, format: "xlsx" });
            setNote("Workbook downloaded.");
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Export failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : "Download Excel — city workbook"}
      </button>
      {note ? <span className="text-sm text-text-muted">{note}</span> : null}
    </span>
  );
}

/**
 * The live action intake for this city (Phase 4 step 2, Build Lead
 * assembly): June's ActionBox locked to the page's city. The
 * acting-city option carries the sim record's own shared-city flag
 * (`buildSimCityDoc` stamps `isSharedCity` on `sim_cities/{id}`; the
 * read mirrors SimSheet's one-doc pattern and fails closed to "not
 * shared" — the flag drives the Mayor / Town Hall routing copy only,
 * never a fence). The box renders once the flag is known so the copy
 * never flips under the reader. Kinds are reconciled against the
 * fabric registry exactly as at the dashboard mount.
 */
function CityActionBox({ faction }: { faction: Faction }) {
  const [isShared, setIsShared] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDoc(doc(getClientDb(), "sim_cities", faction.id))
      .then((snap) => {
        if (!cancelled) {
          setIsShared(snap.exists() && snap.data()?.isSharedCity === true);
        }
      })
      .catch(() => {
        if (!cancelled) setIsShared(false);
      });
    return () => {
      cancelled = true;
    };
  }, [faction.id]);

  if (isShared === null) {
    return <p className="text-text-muted text-sm">Loading…</p>;
  }
  return (
    <ActionBox
      cities={[{ factionId: faction.id, name: faction.name, isShared }]}
      kinds={offeredKinds(Object.keys(ACTION_KIND_INDEX))}
      lockedCityId={faction.id}
    />
  );
}

export function SimCitySection({ faction }: { faction: Faction }) {
  const [structures, setStructures] = useState<
    Awaited<ReturnType<typeof listCityStructures>> | null
  >(null);
  const [corporations, setCorporations] = useState<
    Awaited<ReturnType<typeof listCityCorporations>> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listCityStructures(faction.id).catch(() => []),
      listCityCorporations(faction.id).catch(() => []),
    ]).then(([s, c]) => {
      if (!cancelled) {
        setStructures(s);
        setCorporations(c);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [faction.id]);

  return (
    <div className="wood-texture p-6 md:p-10 pt-0">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="glass-panel p-5">
          <SimSheet factionId={faction.id} />
        </div>

        <div className="glass-panel p-5">
          <CityActionBox faction={faction} />
        </div>

        {faction.population !== null && faction.population !== undefined ? (
          <section aria-label="Lore reference" className="glass-panel p-5">
            <h3 className="hud-title">Lore reference</h3>
            <p className="text-sm text-text-muted mt-1">
              From the city&apos;s lore record — reference only, not a sim
              figure.
            </p>
            <p className="mt-2">
              Population (lore):{" "}
              <strong>{faction.population.toLocaleString()}</strong>
            </p>
          </section>
        ) : null}

        <PublishedClaimsBlock
          cityId={faction.id}
          publisherLabel={`the owner of ${faction.name}`}
        />

        <section aria-label="Structures and businesses" className="glass-panel p-5">
          <h3 className="hud-title">Structures &amp; businesses</h3>
          {structures === null || corporations === null ? (
            <p className="text-text-muted text-sm mt-2">Loading…</p>
          ) : (
            <div className="mt-2 space-y-3 text-sm">
              <p>
                {structures.length} structure{structures.length === 1 ? "" : "s"} ·{" "}
                {corporations.length} business{corporations.length === 1 ? "" : "es"} ·{" "}
                <Link
                  href={cityMapPath(faction.slug)}
                  className="text-accent-gold hover:text-accent-gold-hover"
                >
                  City map
                </Link>
              </p>
              {structures.length > 0 ? (
                <ul className="space-y-1">
                  {structures.slice(0, 6).map((s) => (
                    <li key={s.id}>
                      <Link
                        href={buildingPath(faction.slug, s.slug)}
                        className="text-accent-gold hover:text-accent-gold-hover"
                      >
                        {s.name}
                      </Link>{" "}
                      <span className="text-text-muted">(building)</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {corporations.length > 0 ? (
                <ul className="space-y-1">
                  {corporations.slice(0, 6).map((c) => (
                    <li key={c.id}>
                      <Link
                        href={businessPath(faction.slug, c.slug)}
                        className="text-accent-gold hover:text-accent-gold-hover"
                      >
                        {c.name}
                      </Link>{" "}
                      <span className="text-text-muted">(business)</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          <div className="mt-4">
            <CityExportButton cityId={faction.id} />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Slug-resolving mount for the city page: the profile client owns the
 * not-found/loading states; this wrapper renders the sim section once
 * the faction resolves, and nothing before that.
 */
export function SimCitySectionForSlug() {
  const params = useParams();
  const slug = params.slug as string;
  const [faction, setFaction] = useState<Faction | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFactionBySlug(slug)
      .then((f) => {
        if (!cancelled) setFaction(f);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!faction) return null;
  return <SimCitySection faction={faction} />;
}
