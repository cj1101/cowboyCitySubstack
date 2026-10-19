"use client";

/**
 * Status & condition (spec §6.2.4). Construction figures come from the
 * record; a timeline statement renders only where the record carries
 * one — never a fake-precise countdown. Geography appears here as
 * fixed ground truth: named, linked, and with no edit affordance
 * anywhere on the page (brief §8.3).
 */

import Link from "next/link";
import type { Faction } from "@/lib/types";
import { cityMapPath } from "@/lib/entity/paths";
import {
  CORPORATION_STATUS_LABELS,
  STRUCTURE_STATUS_LABELS,
} from "@/lib/entity/functionState";
import type { EntityPageData } from "@/lib/entity/types";
import { EntitySection, FactRow, HonestEmpty, NotInSimNote } from "./EntitySections";

function formatRubars(value: number): string {
  return `${value.toLocaleString()} Rubars`;
}

export function EntityStatus({ faction, data }: { faction: Faction; data: EntityPageData }) {
  return (
    <EntitySection title="Status & condition">
      {data.structure ? (
        <StructureStatus data={data} />
      ) : data.corporation ? (
        <>
          <FactRow label="Status">{CORPORATION_STATUS_LABELS[data.corporation.status]}</FactRow>
          <FactRow label="Condition">
            Businesses don&apos;t carry a building condition — their standing is their market
            assessment and valuation (see Economics &amp; connections).
          </FactRow>
        </>
      ) : (
        <NotInSimNote cityName={faction.name} claimed={data.cityClaimed} />
      )}
      <div className="border-t border-white/10 pt-3 space-y-1">
        <p className="text-sm text-text-light">Geography</p>
        <p className="text-sm text-text-muted">
          The land, water, and natural features around this place are fixed ground truth. They
          change only through a deliberate, logged project — never by editing a page or a map.{" "}
          <Link href={cityMapPath(faction.slug)} className="text-accent-gold hover:underline">
            See the {faction.name} map
          </Link>
          .
        </p>
      </div>
    </EntitySection>
  );
}

function StructureStatus({ data }: { data: EntityPageData }) {
  const s = data.structure!;
  return (
    <div className="space-y-2">
      <FactRow label="Status">{STRUCTURE_STATUS_LABELS[s.status]}</FactRow>
      <FactRow label="Condition">
        {s.condition !== null ? `${s.condition} / 100, as last recorded` : "— (none recorded)"}
      </FactRow>

      {s.status === "under-construction" ? (
        <>
          <FactRow label="Progress">
            {s.workUnitsRequired !== null
              ? `${s.workUnitsDone} of ${s.workUnitsRequired} work units done`
              : `${s.workUnitsDone} work units done (total not recorded)`}
          </FactRow>
          <FactRow label="Budget">
            {s.totalBudgetRubars !== null
              ? `${formatRubars(s.paidRubars)} of ${formatRubars(s.totalBudgetRubars)} paid`
              : `${formatRubars(s.paidRubars)} paid (total budget not recorded)`}
          </FactRow>
          <HonestEmpty>
            No completion date is shown: where an owner chose a construction timeline, its current
            estimate is the one from the last resolution that moved it, in the Log — timelines move
            with the business&apos;s quality, size, and importance, and this page doesn&apos;t
            invent a countdown.
          </HonestEmpty>
        </>
      ) : null}

      {s.status === "planned" ? (
        <HonestEmpty>
          Not yet built. This building has no sim effects until it is built — what&apos;s here is
          lore, intention, and any plan images in the gallery (labeled as plans, never as
          screenshots).
        </HonestEmpty>
      ) : null}

      {s.status === "mothballed" ? (
        <HonestEmpty>
          Mothballed by owner action. Returning to function takes another owner action — nothing
          un-mothballs itself.
        </HonestEmpty>
      ) : null}

      {s.status === "demolished" || s.status === "ruined" ? (
        <HonestEmpty>
          Destroyed things are properly gone as functioning buildings. Rebuilding is a new action
          creating new state — it never edits this record to pretend the ruin didn&apos;t happen.
        </HonestEmpty>
      ) : null}
    </div>
  );
}
