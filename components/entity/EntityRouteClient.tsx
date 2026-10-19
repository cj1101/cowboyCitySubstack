"use client";

/**
 * The entity page route host (Phase 3 brief §8.1) — Build Lead wiring
 * for Petra's entities module. Both additive routes
 * (buildings/[structureSlug], businesses/[corporationSlug]) render
 * this one host with their kind; the host:
 *
 *   1. resolves the city by slug, then the entity via
 *      lib/entity/resolve.ts (sim record first, then the pin/wiki
 *      presentation entity — one template, two postures, TC-D01);
 *   2. redirects to the canonical slug when a rename moved the page
 *      (URLs get pasted into Discord — they must keep working);
 *   3. fetches the connection context (same-city structures +
 *      corporations, the realm's factions) and the linked wiki entry;
 *   4. renders Petra's EntityPageSections composer (all six §8.2
 *      sections, in order), then — for business pages — the shared
 *      §7.2 published-claims block fenced to that business, and the
 *      §10.4 entity workbook affordance (sim posture only: the
 *      workbook describes the sim record).
 *
 * A slug that resolves to nothing renders an honest not-found state
 * with the design's error-state "Report this" door — never a
 * fabricated entity.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAllFactions, getFactionBySlug } from "@/lib/firestore/factions";
import type { Faction, WikiEntry } from "@/lib/types";
import {
  listCityCorporations,
  listCityStructures,
  resolveEntityPage,
  type EntityPageData,
} from "@/lib/entity/resolve";
import {
  corporationConnections,
  structureConnections,
  type ConnectionContext,
} from "@/lib/entity/connections";
import { buildingPath, businessPath } from "@/lib/entity/paths";
import type { EntityKind } from "@/lib/entity/types";
import { EntityPageSections } from "./EntityPageSections";
import { PublishedClaimsBlock } from "@/components/city/PublishedClaimsBlock";
import { ReportThisLink } from "@/components/bugs/ReportThisLink";
import { downloadEntityWorkbook } from "@/lib/export/entityWorkbook";

async function fetchWikiEntry(id: string | null): Promise<WikiEntry | null> {
  if (!id) return null;
  try {
    const snap = await getDoc(doc(getClientDb(), "wiki_entries", id));
    if (!snap.exists()) return null;
    const data = snap.data();
    return {
      id: snap.id,
      cityId: (data.cityId as string) ?? "",
      citySlug: (data.citySlug as string) ?? "",
      kind: data.kind as WikiEntry["kind"],
      title: (data.title as string) ?? "",
      slug: (data.slug as string) ?? "",
      summary: (data.summary as string | undefined) ?? undefined,
      body: (data.body as string) ?? "",
      stats: (data.stats as WikiEntry["stats"]) ?? null,
      updatedAt: data.updatedAt as WikiEntry["updatedAt"],
    };
  } catch {
    return null;
  }
}

function EntityExportButton({
  cityId,
  entityKind,
  entityId,
}: {
  cityId: string;
  entityKind: "structure" | "business";
  entityId: string;
}) {
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
            await downloadEntityWorkbook({
              uid: user.uid,
              cityId,
              entityKind,
              entityId,
              format: "xlsx",
            });
            setNote("Workbook downloaded.");
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Export failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : "Download Excel — entity workbook"}
      </button>
      {note ? <span className="text-sm text-text-muted">{note}</span> : null}
    </span>
  );
}

export function EntityRouteClient({ kind }: { kind: EntityKind }) {
  const params = useParams();
  const router = useRouter();
  const { user, profile } = useAuth();
  const citySlug = params.slug as string;
  const entitySlug = (kind === "building"
    ? params.structureSlug
    : params.corporationSlug) as string;

  const [faction, setFaction] = useState<Faction | null>(null);
  const [data, setData] = useState<EntityPageData | null>(null);
  const [context, setContext] = useState<ConnectionContext | null>(null);
  const [wikiEntry, setWikiEntry] = useState<WikiEntry | null>(null);
  const [homeCity, setHomeCity] = useState<Faction | null>(null);
  const [marketCities, setMarketCities] = useState<Faction[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const city = await getFactionBySlug(citySlug);
        if (cancelled) return;
        if (!city) {
          setNotFound(true);
          return;
        }
        setFaction(city);
        const resolved = await resolveEntityPage(city, kind, entitySlug);
        if (cancelled) return;
        if (!resolved) {
          setNotFound(true);
          return;
        }
        if (resolved.canonicalSlug !== entitySlug) {
          // Slug rename: move to the canonical URL (spec §6.1).
          const target =
            kind === "building"
              ? buildingPath(city.slug, resolved.canonicalSlug)
              : businessPath(city.slug, resolved.canonicalSlug);
          router.replace(target);
          return;
        }
        setData(resolved);
        const [structures, corporations, factions] = await Promise.all([
          listCityStructures(city.id),
          listCityCorporations(city.id),
          getAllFactions().catch(() => [] as Faction[]),
        ]);
        if (cancelled) return;
        const factionsById = new Map(factions.map((f) => [f.id, f]));
        setContext({ structures, corporations, factionsById });
        const linkedWikiId =
          resolved.posture === "presentation"
            ? resolved.presentation?.wikiEntryId ?? null
            : kind === "building"
              ? resolved.structure?.linkedWikiEntryId ?? null
              : null;
        setWikiEntry(await fetchWikiEntry(linkedWikiId));
        if (kind === "business" && resolved.corporation) {
          const corp = resolved.corporation;
          setHomeCity(
            corp.homeCityId ? (factionsById.get(corp.homeCityId) ?? null) : null
          );
          setMarketCities(
            corp.marketCityIds
              .map((id) => factionsById.get(id))
              .filter((f): f is Faction => Boolean(f))
          );
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [citySlug, entitySlug, kind, router]);

  if (notFound) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
        <div className="max-w-4xl mx-auto glass-panel p-6">
          <h1 className="text-2xl font-bold text-accent-gold">
            No such {kind === "building" ? "building" : "business"} here
          </h1>
          <p className="text-text-muted mt-2">
            Nothing in this city answers to that address — no sim record
            and no pin or wiki page carries it. If the name changed, the
            city&apos;s map and wiki hold the current one.
          </p>
          <p className="mt-3">
            <Link href={`/factions/${citySlug}`} className="text-accent-gold hover:text-accent-gold-hover">
              ← Back to the city
            </Link>{" "}
            · <ReportThisLink message={`Entity page not found: ${kind} "${entitySlug}" in city "${citySlug}".`} />
          </p>
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
        <div className="max-w-4xl mx-auto glass-panel p-6">
          <p>
            This page couldn&apos;t be read just now. Nothing is shown
            rather than something wrong.{" "}
            <ReportThisLink message={`Entity page failed to load: ${kind} "${entitySlug}" in city "${citySlug}".`} />
          </p>
        </div>
      </div>
    );
  }

  if (!faction || !data || !context) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
        <p className="text-text-muted max-w-4xl mx-auto">Loading…</p>
      </div>
    );
  }

  const connections =
    kind === "building" && data.structure
      ? structureConnections(faction, data.structure, context)
      : kind === "business" && data.corporation
        ? corporationConnections(faction, data.corporation, context)
        : [];

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        <p>
          <Link
            href={`/factions/${faction.slug}`}
            className="text-accent-gold hover:text-accent-gold-hover text-sm"
          >
            ← {faction.name}
          </Link>
        </p>
        <EntityPageSections
          faction={faction}
          data={data}
          homeCity={homeCity}
          marketCities={marketCities}
          connections={connections}
          wikiEntry={wikiEntry}
          viewerUid={user?.uid ?? null}
          viewerDisplay={profile?.displayName ?? null}
        />
        {kind === "business" && data.corporation ? (
          <PublishedClaimsBlock
            cityId={faction.id}
            businessId={data.corporation.id}
            publisherLabel={`the owner of ${data.corporation.name}`}
          />
        ) : null}
        {data.posture === "sim" ? (
          <div>
            <EntityExportButton
              cityId={faction.id}
              entityKind={kind === "building" ? "structure" : "business"}
              entityId={
                kind === "building" ? data.structure!.id : data.corporation!.id
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
