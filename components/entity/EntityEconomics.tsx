"use client";

/**
 * Economics & connections (spec §6.2.6; brief §8.2.5).
 *
 * Connections are links to the connected entity's own page — never
 * embedded copies (brief §8.1). A business's valuation is a verified
 * sim figure and carries its why-link like every verified figure
 * (§6.2 pattern). AI-as-market judgments render as *assessments* —
 * labeled as the market's judgment, with the Log entry that produced
 * them linked — never as settled fact. Until Phase 4 data exists the
 * section says so; it invents no numbers.
 */

import Link from "next/link";
import type { Faction } from "@/lib/types";
import type { EntityConnection } from "@/lib/entity/connections";
import { logLink } from "@/lib/entity/logLink";
import type { EntityPageData } from "@/lib/entity/types";
import { EntitySection, FactRow, HonestEmpty, NotInSimNote } from "./EntitySections";

function formatRubars(value: number): string {
  return `${value.toLocaleString()} Rubars`;
}

function ConnectionList({ connections }: { connections: EntityConnection[] }) {
  if (connections.length === 0) {
    return (
      <HonestEmpty>
        No connections recorded yet — linked businesses, premises, households, staff, and endpoint
        cities appear here as play records them.
      </HonestEmpty>
    );
  }
  return (
    <div className="space-y-1">
      {connections.map((connection, i) => (
        <FactRow key={`${connection.label}-${connection.name}-${i}`} label={connection.label}>
          {connection.href ? (
            <Link href={connection.href} className="text-accent-gold hover:underline">
              {connection.name}
            </Link>
          ) : (
            connection.name
          )}
        </FactRow>
      ))}
    </div>
  );
}

export function EntityEconomics({
  faction,
  data,
  connections,
}: {
  faction: Faction;
  data: EntityPageData;
  connections: EntityConnection[];
}) {
  if (data.posture === "presentation" || (!data.structure && !data.corporation)) {
    return (
      <EntitySection title="Economics & connections">
        <NotInSimNote cityName={faction.name} claimed={data.cityClaimed} />
      </EntitySection>
    );
  }

  if (data.structure) {
    return (
      <EntitySection title="Economics & connections">
        <ConnectionList connections={connections} />
        <HonestEmpty>
          A building&apos;s economics flow through the businesses and households connected to it
          and through its city — assessments of this building itself land with Phase 4 market data.
        </HonestEmpty>
      </EntitySection>
    );
  }

  const c = data.corporation!;
  const hasAssessment = [c.quality, c.scale, c.importance].some(
    (v) => v !== null && v !== undefined
  );

  return (
    <EntitySection title="Economics & connections">
      {c.valuationRubars !== null ? (
        <FactRow label="Valuation">
          {formatRubars(c.valuationRubars)}
          {c.lastChangedSeq !== null ? (
            <>
              {" — "}
              <Link
                href={logLink({ cityId: faction.id, anchorSeq: c.lastChangedSeq, entityRef: c.id, field: "valuationRubars" })}
                className="text-accent-gold hover:underline"
              >
                why? (the Log entry that last set it)
              </Link>
            </>
          ) : null}
        </FactRow>
      ) : (
        <HonestEmpty>
          No valuation recorded yet — the market values a business as play touches it (Phase 4).
        </HonestEmpty>
      )}

      {hasAssessment ? (
        <div className="space-y-1">
          <p className="text-sm font-bold text-text-light">Market assessment</p>
          <p className="text-sm text-text-muted">
            The market&apos;s judgment of this business — an assessment, not a settled fact. Its
            reasoning is in the Log entry that produced it.
          </p>
          {c.quality !== null && c.quality !== undefined ? (
            <FactRow label="Quality">{c.quality}</FactRow>
          ) : null}
          {c.scale !== null && c.scale !== undefined ? (
            <FactRow label="Scale">{c.scale}</FactRow>
          ) : null}
          {c.importance !== null && c.importance !== undefined ? (
            <FactRow label="Importance">{c.importance}</FactRow>
          ) : null}
          {c.assessmentSeq !== null && c.assessmentSeq !== undefined ? (
            <p className="text-sm">
              <Link
                href={logLink({ cityId: faction.id, anchorSeq: c.assessmentSeq, entityRef: c.id })}
                className="text-accent-gold hover:underline"
              >
                The assessment&apos;s Log entry
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <HonestEmpty>
          No market assessment yet — the AI-as-market judges quality, scale, and importance when
          Phase 4 market play reaches this business, and its judgment will be logged like
          everything else.
        </HonestEmpty>
      )}

      <ConnectionList connections={connections} />
    </EntitySection>
  );
}
