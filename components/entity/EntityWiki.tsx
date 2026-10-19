"use client";

/**
 * Wiki & provenance (spec §6.2.7; brief §8.2.6).
 *
 * The linked wiki entry renders in this section and nowhere else on
 * the page: lore lives in the wiki layer, sim facts live in the sim
 * sections, and the two are never blended into one undifferentiated
 * text (TC-C08). The landed wiki substrate records no canon-layer
 * field yet — layer badges land with the lore-ingestion data (Phase
 * 6); this section fabricates none, and labels the entry for exactly
 * what it is: the city's wiki record.
 *
 * Provenance is rendered from the record's own source object (Dana
 * §3.2) — never reconstructed, never guessed. Where no source is
 * recorded, the block says so.
 */

import Link from "next/link";
import { MentionRenderer } from "@/components/mentions/MentionRenderer";
import type { Faction, WikiEntry } from "@/lib/types";
import { entityLogLink, logLink } from "@/lib/entity/logLink";
import { wikiEntryPath } from "@/lib/entity/paths";
import type { EntityPageData } from "@/lib/entity/types";
import { EntitySection, FactRow, HonestEmpty } from "./EntitySections";

const WIKI_KIND_LABELS: Record<WikiEntry["kind"], string> = {
  character: "Character",
  place: "Place",
  faction: "City / faction",
  law: "Law",
  species: "Species",
  team: "Team",
};

/** R-16's distinction, from the recorded source type — seed/existing
 * records entered the sim as already-standing; action records were
 * constructed through play. Anything else renders as recorded. */
function enteredAsLabel(sourceType: string | null | undefined): string | null {
  if (!sourceType) return null;
  if (sourceType === "existing" || sourceType === "seed") return "Entered as existing";
  if (sourceType === "action") return "Constructed through play";
  return `Recorded as: ${sourceType}`;
}

export function EntityWiki({
  faction,
  data,
  wikiEntry,
}: {
  faction: Faction;
  data: EntityPageData;
  wikiEntry: WikiEntry | null;
}) {
  const entityId = data.structure?.id ?? data.corporation?.id ?? data.presentation?.key ?? null;

  return (
    <EntitySection title="Wiki & provenance">
      {wikiEntry ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={wikiEntryPath(faction.slug, wikiEntry.slug)}
              className="text-accent-gold hover:underline font-bold"
            >
              {wikiEntry.title}
            </Link>
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-1 rounded">
              Wiki · {WIKI_KIND_LABELS[wikiEntry.kind]}
            </span>
          </div>
          {wikiEntry.summary ? (
            <p className="text-sm text-text-light">{wikiEntry.summary}</p>
          ) : null}
          {wikiEntry.body ? (
            <MentionRenderer body={wikiEntry.body} className="text-sm text-text-light" />
          ) : null}
          <p className="text-sm">
            <Link
              href={wikiEntryPath(faction.slug, wikiEntry.slug)}
              className="text-accent-gold hover:underline"
            >
              Open in the {faction.name} wiki
            </Link>
          </p>
        </div>
      ) : (
        <HonestEmpty>
          No wiki entry is linked to this place yet. When its owner writes or links one, the lore
          renders here — in the wiki layer, labeled as wiki, never blended into the sim facts
          above.
        </HonestEmpty>
      )}

      <div className="border-t border-white/10 pt-3 space-y-1">
        <p className="text-sm font-bold text-text-light">Provenance</p>
        {data.structure ? (
          <StructureProvenance faction={faction} data={data} />
        ) : data.corporation ? (
          <CorporationProvenance faction={faction} data={data} />
        ) : (
          <HonestEmpty>
            Known to the site through the {faction.name} wiki and map — member-written lore. No sim
            provenance exists for it: no sim record has been created yet.
          </HonestEmpty>
        )}
      </div>

      {data.posture === "sim" && entityId ? (
        <p className="text-sm">
          <Link
            href={entityLogLink(faction.id, entityId)}
            className="text-accent-gold hover:underline"
          >
            Everything that has happened to this {data.kind === "building" ? "building" : "business"}{" "}
            — the Log, filtered to it
          </Link>
        </p>
      ) : (
        <HonestEmpty>
          No Log entries exist for this place — the Log records sim resolutions, and this place
          isn&apos;t in the sim yet.
        </HonestEmpty>
      )}
    </EntitySection>
  );
}

function StructureProvenance({ faction, data }: { faction: Faction; data: EntityPageData }) {
  const source = data.structure!.source;
  if (!source || (!source.type && !source.id && source.seq == null && !source.actionId)) {
    return <HonestEmpty>Provenance is not recorded on this building&apos;s sim record.</HonestEmpty>;
  }
  const enteredAs = enteredAsLabel(source.type);
  return (
    <div className="space-y-1">
      {enteredAs ? <FactRow label="Entered as">{enteredAs}</FactRow> : null}
      {source.id ? <FactRow label="Source record">{source.id}</FactRow> : null}
      {source.seq !== null && source.seq !== undefined ? (
        <FactRow label="Source seq">
          {source.seq}{" "}
          <Link
            href={logLink({ cityId: faction.id, anchorSeq: source.seq })}
            className="text-accent-gold hover:underline"
          >
            (see it in the Log)
          </Link>
        </FactRow>
      ) : null}
      {source.actionId ? <FactRow label="Creating action">{source.actionId}</FactRow> : null}
    </div>
  );
}

function CorporationProvenance({ faction, data }: { faction: Faction; data: EntityPageData }) {
  const c = data.corporation!;
  if (c.sourceSeq === null && !c.sourceActionId) {
    return <HonestEmpty>Provenance is not recorded on this business&apos;s sim record.</HonestEmpty>;
  }
  return (
    <div className="space-y-1">
      {c.sourceSeq !== null ? (
        <FactRow label="Source seq">
          {c.sourceSeq}{" "}
          <Link
            href={logLink({ cityId: faction.id, anchorSeq: c.sourceSeq })}
            className="text-accent-gold hover:underline"
          >
            (see it in the Log)
          </Link>
        </FactRow>
      ) : null}
      {c.sourceActionId ? <FactRow label="Creating action">{c.sourceActionId}</FactRow> : null}
    </div>
  );
}
