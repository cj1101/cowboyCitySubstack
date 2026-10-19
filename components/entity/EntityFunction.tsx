"use client";

/**
 * Function — the sim-facing statement (spec §6.2.2) and the derived
 * live function state (brief §8.3). Function availability is derived
 * from status/condition at render time; it is never a stored flag.
 * Recorded effects render actively, or struck-through as suspended
 * when the building is out of function — the page shows what the city
 * lost, honestly (spec §6.2.5).
 */

import Link from "next/link";
import type { Faction } from "@/lib/types";
import {
  deriveCorporationFunction,
  deriveStructureFunction,
  PUBLISHED_DAMAGE_THRESHOLD,
  type DerivedFunction,
} from "@/lib/entity/functionState";
import { logLink } from "@/lib/entity/logLink";
import type { EntityPageData } from "@/lib/entity/types";
import { EntitySection, FactRow, HonestEmpty, NotInSimNote } from "./EntitySections";

interface RecordedEffect {
  label: string;
  value: string;
}

function structureEffects(data: EntityPageData): RecordedEffect[] {
  const s = data.structure;
  if (!s) return [];
  const effects: RecordedEffect[] = [];
  if (s.units !== null && s.units > 0) effects.push({ label: "Homes provided", value: String(s.units) });
  if (s.capacity !== null) effects.push({ label: "Capacity", value: String(s.capacity) });
  if (s.staffSlots !== null && s.staffSlots > 0)
    effects.push({ label: "Staff places", value: String(s.staffSlots) });
  if (s.prestige !== null) effects.push({ label: "Prestige", value: String(s.prestige) });
  return effects;
}

function FunctionStateBlock({
  derived,
  whyHref,
}: {
  derived: DerivedFunction;
  whyHref: string | null;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm">
        <span
          className={
            derived.state === "in-function"
              ? "font-bold text-green-300"
              : derived.state === "gone"
                ? "font-bold text-red-300"
                : "font-bold text-amber-200"
          }
        >
          {derived.label}
        </span>
        {whyHref ? (
          <>
            {" — "}
            <Link href={whyHref} className="text-accent-gold hover:underline">
              why? (the Log entry that last changed it)
            </Link>
          </>
        ) : null}
      </p>
      <p className="text-sm text-text-muted">{derived.detail}</p>
    </div>
  );
}

export function EntityFunction({ faction, data }: { faction: Faction; data: EntityPageData }) {
  if (data.posture === "presentation" || (!data.structure && !data.corporation)) {
    return (
      <EntitySection title="Function">
        <NotInSimNote cityName={faction.name} claimed={data.cityClaimed} />
        {data.presentation?.note ? (
          <p className="text-sm text-text-light">{data.presentation.note}</p>
        ) : null}
      </EntitySection>
    );
  }

  if (data.structure) {
    const s = data.structure;
    const derived = deriveStructureFunction(s, PUBLISHED_DAMAGE_THRESHOLD);
    const planned = s.status === "planned";
    const effects = structureEffects(data);
    const whyHref =
      s.lastChangedSeq !== null
        ? logLink({ cityId: faction.id, anchorSeq: s.lastChangedSeq, entityRef: s.id })
        : null;
    return (
      <EntitySection title="Function">
        <FunctionStateBlock derived={derived} whyHref={whyHref} />
        {s.profile.purpose || s.profile.description ? (
          <p className="text-sm text-text-light">
            {planned ? "Planned as: " : ""}
            {s.profile.purpose ?? s.profile.description}
          </p>
        ) : (
          <HonestEmpty>
            {planned
              ? "No function statement recorded yet — its owner describes what this building is planned to do."
              : "No function statement recorded yet — its owner describes what this building does."}
          </HonestEmpty>
        )}
        {effects.length > 0 ? (
          <div className="space-y-1">
            <p className="text-sm font-bold text-text-light">
              {derived.effectsActive ? "Recorded effects" : "Effects — suspended"}
            </p>
            {effects.map((effect) => (
              <div key={effect.label} className="text-sm">
                <span className={derived.effectsActive ? "" : "line-through text-text-muted"}>
                  {effect.label}: {effect.value}
                </span>
                {!derived.effectsActive ? (
                  <span className="text-text-muted"> (suspended while out of function)</span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <HonestEmpty>
            No sim effects recorded yet — this building&apos;s function is recorded; effects land
            when play touches it (Phase 4).
          </HonestEmpty>
        )}
      </EntitySection>
    );
  }

  const c = data.corporation!;
  const derived = deriveCorporationFunction(c);
  const whyHref =
    c.lastChangedSeq !== null
      ? logLink({ cityId: faction.id, anchorSeq: c.lastChangedSeq, entityRef: c.id })
      : null;
  return (
    <EntitySection title="Function">
      <FunctionStateBlock derived={derived} whyHref={whyHref} />
      {c.industry ? (
        <FactRow label="Industry">{c.industry}</FactRow>
      ) : (
        <HonestEmpty>No industry recorded for this business yet.</HonestEmpty>
      )}
    </EntitySection>
  );
}
