/**
 * Defensive + posture (Phase 4 brief §4.3/§4.4, step 8).
 *
 * R-18's Phase 4 form (DECISION-5 split; build-prep P4-K4 ADOPTED):
 * defensive resolution of a hostile action against another city under
 * the FIXED damage classes (property / inhabited / economic), full
 * actor costs, and an automatic tier-2 legal case — with CJ's round-2
 * carve-out preserved (the espionage class R-27 opens a case only if
 * the target users say so; R-18's open attack is not espionage and
 * keeps its automatic case). The stat-contest computation (ATK/DEF,
 * margin tiers, the f scaling law) is Phase 7: nothing here computes
 * it, stores its terms, or presupposes its outcome — the class values
 * below are v2 R-18's stated Phase 4 form, applied as written.
 *
 * R-37 posture (P4-K5 ADOPTED): the `defensePosture` record Module 0
 * stamps on every city — owner-set, treasury-paid, public (deterrence
 * only works if it can be seen), consumed by the first hostile
 * resolution targeting the city, stood down by owner action (no
 * refund), never expiring on a clock. One record serves Phase 4's
 * resolution and Phase 7's contest +10 term — no migration.
 *
 * CJ's bindings, as built:
 *  - Rule-based harm is IN the game: defenses are published mechanics
 *    with real costs, never immunity. An attack always lands its
 *    class effects and always pays its actor costs in full — the
 *    attempt is paid for whether or not it was wise.
 *  - A damaged building's function stops until repaired: damage writes
 *    `condition` (and `ruined` at zero) on the structure record, and
 *    function stays DERIVED via Catalogue I's `isStructureFunctioning`
 *    — no stored function flag is written anywhere in this file.
 *  - Outcomes never rewrite a victim's canon: this module writes sim
 *    state and Log entries only; the target's lore layer is untouched.
 *  - Consent: a consensual joint action classifies under its actual
 *    verbs (other rules), never as `attack_city` — so by the time an
 *    action reaches this handler it is hostile by classification, and
 *    the consent check's output ("no consent record; hostile by
 *    classification") is stated in the Log. An attacker-supplied
 *    consent claim is never read here: that would be a fairness hole.
 *  - Null discipline (§2.1/§2.4): a city with `military = null` cannot
 *    initiate (rejected, logged — P4-G1-C7); index deltas skip-and-log
 *    on null indices; GDP-percentage and GDP-derived effects
 *    skip-and-log on null GDP. The engine invents no value.
 *
 * THE POSTURE FACTOR (flagged for ratification — see the step-8 prep
 * report): brief §4.4 says a postured target "takes the published
 * posture reduction stated in v2's Phase 4 form", but v2's R-18
 * Phase 4 form states the class values "apply as written" and
 * publishes no numeric reduction (the +10 DEF term belongs to the
 * Phase 7 contest form). Rather than invent a number, this build
 * applies the class values unscaled whether or not the target is
 * postured (PHASE4_POSTURE_DAMAGE_FACTOR = 1), consumes the posture
 * exactly as R-37/v2 require, and logs the posture's presence and
 * consumption in full. If Vera/Theo ratify a reduction, it lands as a
 * rule-table amendment changing the one constant below.
 *
 * Discipline (landed Phase 2 §5.3 + Step 0): handlers are pure
 * (snapshot, action) → plan; writes compose through `plannedDoc`
 * (F-02); reads arrive only via the descriptor's declared read plan
 * (F-01); seq-bearing record fields derive from the snapshot's
 * counter head the way allocation's commitSeq does (lastSeq + the
 * plan's entry count). Local copies of the registry's small helpers
 * keep this module free of an import cycle with the registry that
 * will import it (the structures.ts precedent).
 *
 * This file is NOT registered in `registry.ts` — the Build Lead makes
 * the single assembly edit (register DEFENSIVE_DESCRIPTORS).
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  type CollectionQuerySpec,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimCitations,
  type SimSnapshot,
} from "../state";
import { clampNumber } from "./arithmetic";
import {
  fieldChange,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import { functioningHousingUnits } from "./structures";
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Published constants (systems-spec-v2 §3 R-18 Phase 4 form + R-37)
// ---------------------------------------------------------------------------

/** Property/inhabited class: condition damage per named structure. */
export const PHASE4_CONDITION_DAMAGE = 40;
/** Property/inhabited class: target infrastructure delta. */
export const PHASE4_INFRASTRUCTURE_DELTA = -3;
/** Inhabited class: target spirit delta. */
export const PHASE4_SPIRIT_DELTA = -4;
/** Economic class: target GDP percentage. */
export const PHASE4_GDP_PERCENT = -1.5;
/** Economic class: treasury skim, as a percentage of GDP (bounded by
 * the treasury itself). */
export const PHASE4_TREASURY_SKIM_GDP_PERCENT = 0.5;
/** Actor costs (never scaled — the attempt is paid for in full). */
export const ACTOR_COSTS = { law: -5, stability: -2, influence: -3 } as const;
/** Damage multiplier for a postured target in the Phase 4 form. v2
 * publishes no reduction for the fixed-class form, so this is 1 (see
 * the header flag); it exists as one named constant so a ratified
 * reduction amends exactly one line. */
export const PHASE4_POSTURE_DAMAGE_FACTOR = 1;

export type DamageClass = "property" | "inhabited" | "economic";
export const DAMAGE_CLASSES: readonly DamageClass[] = ["property", "inhabited", "economic"];

export function structurePath(cityId: string, structureId: string): string {
  return `sim_cities/${cityId}/structures/${structureId}`;
}

export function householdsPath(cityId: string, householdId: string): string {
  return `sim_cities/${cityId}/households/${householdId}`;
}

export function casePath(caseId: string): string {
  return `sim_cases/${caseId}`;
}

/** The case id an R-18 resolution opens: deterministic in the
 * resolution, so preview and commit name the same record. */
export function caseIdForResolution(resolutionId: string): string {
  return `case_${resolutionId}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — see header note)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

function actorCitations(
  plan: ResolutionPlan,
  citations: SimCitations,
  resolutionId: string
): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

/** Authority over the ACTING city. Mirrors structures'
 * requireAuthority plus allocation's shared-city guard (CJ round 3):
 * for the shared city, the actor must be a shared-office mayor actor
 * (verifying the memberId IS the sitting mayor awaits Phase 7 terms
 * data — the allocation/undo posture); for any other city, the
 * actor's member uid (or on-behalf-of uid) must be in the faction's
 * ownerUids. */
function requireActingAuthority(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string,
  cityId: string
): ResolutionPlan | null {
  if (!cityId) {
    return rejectedPlan(descriptorId, "NO_TARGET_CITY", [ruleId], "Action names no acting city (cityId).");
  }
  const city = snapshotDoc(ctx.snapshot, `sim_cities/${cityId}`);
  if (!city) {
    return rejectedPlan(descriptorId, "NO_CITY", [ruleId], `City ${cityId} does not stand.`);
  }
  if (city.isSharedCity === true) {
    if (ctx.action.actor.type !== "shared-office" || ctx.action.actor.office !== "mayor" || !ctx.action.actor.memberId) {
      return rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        [ruleId],
        `${cityId} is the shared city: its acts are the sitting mayor's alone (CJ round 3), and this actor is not a shared-office mayor actor.`
      );
    }
    return null;
  }
  const uid = ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId;
  if (!uid) {
    return rejectedPlan(descriptorId, "AUTHORITY_REVOKED", [ruleId], "Actor carries no member identity.");
  }
  const faction = snapshotDoc(ctx.snapshot, `factions/${cityId}`);
  if (!faction) {
    return rejectedPlan(descriptorId, "AUTHORITY_REVOKED", [ruleId], `No faction record for ${cityId}.`);
  }
  const owners = faction.ownerUids;
  if (!Array.isArray(owners) || !owners.includes(uid)) {
    return rejectedPlan(
      descriptorId,
      "AUTHORITY_REVOKED",
      [ruleId],
      `Authority revoked for ${uid} over ${cityId}: not an owner of the city.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stat application against the PLANNED doc (F-02 discipline) — local
// copies of the structures.ts helpers, verbatim semantics.
// ---------------------------------------------------------------------------

type StatOutcome =
  | { applied: true; change: LogEntryDraft["changes"][number] }
  | { applied: false; note: string };

function outcomeNote(outcome: StatOutcome, notes: string[]): LogEntryDraft["changes"][number] | null {
  if (outcome.applied) return outcome.change;
  notes.push(outcome.note);
  return null;
}

function applyIndexDelta(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  stat: string,
  delta: number,
  formula: string
): StatOutcome {
  const path = `sim_cities/${cityId}`;
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return { applied: false, note: `skipped: no city record for ${cityId}` };
  const before = num(current, `stats.${stat}`);
  if (before === null) {
    return { applied: false, note: `skipped: ${stat} unset (null) — the engine never invents an index value` };
  }
  const after = clampNumber(before + delta, 0, 100);
  if (after === before) {
    return { applied: true, change: fieldChange(`stats.${stat}`, before, after, `${formula} (clamped at bound)`) };
  }
  planWrite(plan, snapshot, path, withDocField(current, `stats.${stat}`, after), "state", [`stats.${stat}`]);
  return { applied: true, change: fieldChange(`stats.${stat}`, before, after, formula) };
}

function applyGdpPercent(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  pct: number,
  formula: string
): StatOutcome {
  const path = `sim_cities/${cityId}`;
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return { applied: false, note: `skipped: no city record for ${cityId}` };
  const before = num(current, "stats.gdpRubars");
  if (before === null) {
    return { applied: false, note: "skipped: gdp unset" };
  }
  const delta = Math.round((before * pct) / 100);
  const after = before + delta;
  planWrite(plan, snapshot, path, withDocField(current, "stats.gdpRubars", after), "state", ["stats.gdpRubars"]);
  return {
    applied: true,
    change: fieldChange("stats.gdpRubars", before, after, `${formula}: round(${before} × ${pct}/100) = ${delta}`),
  };
}

/** Treasury movement; returns null when the amount is 0 (no movement,
 * no change line — finance §2.1). Caller bounds the amount so the
 * balance cannot go below 0. */
function applyTreasuryDelta(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  delta: number,
  formula: string
): LogEntryDraft["changes"][number] | null {
  if (delta === 0) return null;
  const path = `sim_cities/${cityId}`;
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return null;
  const before = num(current, "stats.treasuryRubars") ?? 0;
  const after = before + delta;
  planWrite(plan, snapshot, path, withDocField(current, "stats.treasuryRubars", after), "state", ["stats.treasuryRubars"]);
  return fieldChange("stats.treasuryRubars", before, after, formula);
}

/** housingUnits recompute for the target city after damage (derived-
 * stored, §2.1 — units of FUNCTIONING housing only, via Catalogue I's
 * predicate over the planned structures collection). Mirrors
 * structures.ts recomputeDerivedCounts' housing half. */
function recomputeHousingUnits(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string
): LogEntryDraft["changes"] {
  const cityPath = `sim_cities/${cityId}`;
  const record = snapshot.queries.find(
    (q) => q.spec.id === STRUCTURES_QUERY_ID && q.spec.collectionPath === `${cityPath}/structures`
  );
  if (!record) return [];
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of record.resultPaths) docs.set(path, snapshotDoc(snapshot, path));
  for (const write of plan.writes) {
    if (write.path.startsWith(`${cityPath}/structures/`)) {
      docs.set(write.path, write.op === "delete" ? null : (write.afterDoc ?? null));
    }
  }
  const after = functioningHousingUnits(docs.values());
  const city = plannedDoc(plan, snapshot, cityPath);
  const before = num(city, "stats.housingUnits") ?? 0;
  if (after === before || !city) return [];
  planWrite(plan, snapshot, cityPath, withDocField(city, "stats.housingUnits", after), "state", ["stats.housingUnits"]);
  return [
    fieldChange("stats.housingUnits", before, after, "housingUnits recomputed after damage: units of functioning housing only (derived-stored, §2.1)"),
  ];
}

/** Plan hygiene (structures.ts pruneRecordClaims, verbatim): an entry
 * may only claim records the plan actually writes. */
function pruneRecordClaims(plan: ResolutionPlan): void {
  const ops = new Map(plan.writes.map((w) => [w.path, w.op]));
  for (const entry of plan.entries) {
    const created = new Set<string>();
    const updated = new Set<string>();
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      const op = ops.get(path);
      if (op === "create") created.add(path);
      else if (op !== undefined) updated.add(path);
    }
    entry.recordsCreated = [...created];
    entry.recordsUpdated = [...updated];
  }
}

// ---------------------------------------------------------------------------
// Read plans (F-01)
// ---------------------------------------------------------------------------

const STRUCTURES_QUERY_ID = "defense-structures";
const HOUSEHOLDS_QUERY_ID = "defense-households";

function structuresQuery(cityId: string): CollectionQuerySpec {
  return { id: STRUCTURES_QUERY_ID, collectionPath: `sim_cities/${cityId}/structures`, filters: [] };
}

function householdsQuery(cityId: string): CollectionQuerySpec {
  return { id: HOUSEHOLDS_QUERY_ID, collectionPath: `sim_cities/${cityId}/households`, filters: [] };
}

function queryDocs(
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): Map<string, Record<string, unknown> | null> | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === queryId && q.spec.collectionPath === collectionPath
  );
  if (!record) return null;
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of record.resultPaths) docs.set(path, snapshotDoc(snapshot, path));
  return docs;
}

/** R-18's reads: the target city's doc + faction (the base derivation
 * covers the acting city; the target arrives via params, resolver-side
 * — never from actor citations alone), and the target's structures +
 * households collections (named-structure validation, displacement,
 * and the housingUnits recompute all read them). */
function attackReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const targetCityId = typeof params.targetCityId === "string" ? params.targetCityId : "";
  if (!targetCityId) return {};
  return {
    paths: [`sim_cities/${targetCityId}`, `factions/${targetCityId}`],
    queries: [structuresQuery(targetCityId), householdsQuery(targetCityId)],
  };
}

// ---------------------------------------------------------------------------
// R-18 — damage or attack another city (Phase 4 fixed-class form)
// ---------------------------------------------------------------------------

function attackHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-18";
  const params = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);

  const denied = requireActingAuthority(ctx, descriptorId, "R-18", actorCityId);
  if (denied) return denied;
  const actorCityPath = `sim_cities/${actorCityId}`;
  const actorCity = snapshotDoc(ctx.snapshot, actorCityPath) as Record<string, unknown>;

  const targetCityId = typeof params.targetCityId === "string" ? params.targetCityId : "";
  if (!targetCityId) {
    return rejectedPlan(descriptorId, "NO_TARGET_CITY", ["R-18"], "Action names no targetCityId — R-18 fires on another owner's city.");
  }
  if (targetCityId === actorCityId) {
    return rejectedPlan(
      descriptorId,
      "TARGET_IS_OWN_CITY",
      ["R-18"],
      `${targetCityId} is the acting city — R-18 is a grave act against ANOTHER city. Damage to one's own structures classifies under its actual verbs (R-16/R-19/R-24), never as an attack.`
    );
  }
  const damageClass = params.damageClass as DamageClass;
  if (!DAMAGE_CLASSES.includes(damageClass)) {
    return rejectedPlan(
      descriptorId,
      "INVALID_DAMAGE_CLASS",
      ["R-18"],
      `damageClass must be one of ${DAMAGE_CLASSES.join(" / ")} (got ${String(params.damageClass)}). The attacker declares the class; the class caps what kind of harm is on the table.`
    );
  }
  const targetCityPath = `sim_cities/${targetCityId}`;
  const targetCity = snapshotDoc(ctx.snapshot, targetCityPath);
  if (!targetCity) {
    return rejectedPlan(
      descriptorId,
      "TARGET_NOT_IN_SIM",
      ["R-18"],
      `${targetCityId} has no sim presence (unowned cities stay inactive until claimed; there is nothing standing to damage). The attempt is rejected and logged.`
    );
  }
  // §2.1 null handling (P4-G1-C7): a city whose military was never
  // built cannot initiate a hostile act — rejected, logged, and the
  // stored value stays null.
  if (num(actorCity, "stats.military") === null) {
    return rejectedPlan(
      descriptorId,
      "MILITARY_UNBUILT",
      ["R-18"],
      `${actorCityId} cannot initiate a hostile act: military = null (unbuilt — §2.1). An unallocated city has no military to attack with; the value stays null and the attempt is logged as rejected.`
    );
  }

  // Named structures (property / inhabited classes): validated against
  // the declared collection read — the preview must name exactly what
  // the commit will damage.
  const needsStructures = damageClass === "property" || damageClass === "inhabited";
  const structureIds = [...new Set(strList(params.structureIds))];
  const namedStructures: { structureId: string; doc: Record<string, unknown> }[] = [];
  let households: Map<string, Record<string, unknown> | null> | null = null;
  if (needsStructures) {
    if (structureIds.length === 0) {
      return rejectedPlan(
        descriptorId,
        "NO_STRUCTURES_NAMED",
        ["R-18"],
        `A ${damageClass} attack names the structures it damages — the class caps harm to named structures, and an attack naming none would preview as damage and land as nothing.`
      );
    }
    const structures = queryDocs(ctx.snapshot, STRUCTURES_QUERY_ID, `${targetCityPath}/structures`);
    if (!structures) {
      return rejectedPlan(descriptorId, "READ_PLAN_MISSING", ["R-18"], "The target structures collection read was not materialized into the snapshot — a handler never improvises a read outside its declared read plan (F-01).");
    }
    for (const structureId of structureIds) {
      const doc = structures.get(structurePath(targetCityId, structureId)) ?? null;
      if (!doc) {
        return rejectedPlan(descriptorId, "STRUCTURE_NOT_FOUND", ["R-18"], `Structure ${structureId} does not stand in ${targetCityId} — the confirmed preview must name exactly what the commit damages.`);
      }
      const profile = (doc.profile as Record<string, unknown> | undefined) ?? {};
      if (profile.geography === "natural") {
        return rejectedPlan(
          descriptorId,
          "GEOGRAPHY_FIXED",
          ["R-18"],
          `${structureId} is a natural feature — fixed ground truth (CJ §6.7.4). The damage classes act on built structures; geography changes only via a deliberate man-made project, never as attack damage.`
        );
      }
      if (doc.status === "demolished") {
        return rejectedPlan(
          descriptorId,
          "STRUCTURE_DEMOLISHED",
          ["R-18"],
          `Structure ${structureId} in ${targetCityId} is demolished — destroyed things are properly gone (CJ); there is nothing standing to damage.`
        );
      }
      if (num(doc, "condition") === null) {
        return rejectedPlan(
          descriptorId,
          "STRUCTURE_NOT_DAMAGEABLE",
          ["R-18"],
          `Structure ${structureId} in ${targetCityId} carries no condition (status ${String(doc.status ?? "unset")} — condition is set at completion, §2.5); the ${damageClass} class damages standing structures.`
        );
      }
      namedStructures.push({ structureId, doc });
    }
    if (damageClass === "inhabited") {
      households = queryDocs(ctx.snapshot, HOUSEHOLDS_QUERY_ID, `${targetCityPath}/households`);
      if (!households) {
        return rejectedPlan(descriptorId, "READ_PLAN_MISSING", ["R-18"], "The target households collection read was not materialized into the snapshot — a handler never improvises a read outside its declared read plan (F-01).");
      }
    }
  }

  const plan = emptyPlan(descriptorId);
  const notes: string[] = [];
  const caseId = caseIdForResolution(ctx.resolutionId);
  // The success path always builds exactly four entries (target
  // effect, actor effect, case, summary), so the case's openedAtSeq
  // derives from the counter head the way allocation's commitSeq does.
  const openedAtSeq = ctx.snapshot.counterHead.lastSeq + 4;

  // ---- Target-side effects (the class table, Phase 4 form) --------
  const targetChanges: LogEntryDraft["changes"] = [];
  const targetUpdated: string[] = [];
  const damagePerStructure = Math.round(PHASE4_CONDITION_DAMAGE * PHASE4_POSTURE_DAMAGE_FACTOR);
  const conditionLines: string[] = [];
  for (const { structureId, doc } of namedStructures) {
    const sPath = structurePath(targetCityId, structureId);
    const before = num(doc, "condition") as number;
    const after = clampNumber(before - damagePerStructure, 0, 100);
    const current = plannedDoc(plan, ctx.snapshot, sPath) ?? doc;
    let next = withDocField(current, "condition", after);
    const changedFields = ["condition"];
    targetChanges.push(
      fieldChange(`structures/${structureId}.condition`, before, after, `R-18 ${damageClass} (Phase 4 form): condition −${damagePerStructure}`)
    );
    if (after === 0 && doc.status === "complete") {
      next = withDocField(next, "status", "ruined");
      changedFields.push("status");
      targetChanges.push(
        fieldChange(`structures/${structureId}.status`, "complete", "ruined", "R-18: condition fell to 0 — the structure is ruined and its function stops until repaired (R-24); function is derived, never a stored flag")
      );
    }
    planWrite(plan, ctx.snapshot, sPath, next, "state", changedFields);
    targetUpdated.push(sPath);
    conditionLines.push(`${structureId} ${before} → ${after}`);
  }

  let displacedHouseholds = 0;
  let displacedPersons = 0;
  if (damageClass === "property" || damageClass === "inhabited") {
    const infra = outcomeNote(
      applyIndexDelta(plan, ctx.snapshot, targetCityId, "infrastructure", PHASE4_INFRASTRUCTURE_DELTA, `R-18 ${damageClass} (Phase 4 form): infrastructure ${PHASE4_INFRASTRUCTURE_DELTA}`),
      notes
    );
    if (infra) targetChanges.push(infra);
  }
  if (damageClass === "inhabited" && households) {
    // Displacement (R-18 inhabited, resolved under R-17's math):
    // every household resident in a named structure becomes
    // `displaced` — the records persist; fictional people are never
    // deleted by fiat. The household keeps its homeStructureId (the
    // record of where it lived); rehousing is R-03/R-17 business.
    for (const { structureId } of namedStructures) {
      for (const [hPath, hDoc] of households) {
        if (!hDoc) continue;
        if (hDoc.homeStructureId !== structureId || hDoc.status !== "housed") continue;
        const householdId = hPath.split("/").pop() as string;
        const current = plannedDoc(plan, ctx.snapshot, hPath) ?? hDoc;
        planWrite(plan, ctx.snapshot, hPath, withDocField(current, "status", "displaced"), "state", ["status"]);
        targetChanges.push(
          fieldChange(`households/${householdId}.status`, "housed", "displaced", `R-18 inhabited: resident of damaged "${structureId}" — displaced, never deleted (R-17 displacement math)`)
        );
        targetUpdated.push(hPath);
        displacedHouseholds += 1;
        displacedPersons += num(hDoc, "size") ?? 0;
      }
    }
    if (displacedPersons > 0) {
      const cityNow = plannedDoc(plan, ctx.snapshot, targetCityPath);
      const popBefore = num(cityNow, "stats.population");
      if (popBefore === null) {
        notes.push("skipped: population unset (null) — displaced persons are recorded on the household records; no population figure is invented");
      } else {
        const popAfter = Math.max(0, popBefore - displacedPersons);
        if (cityNow) {
          planWrite(plan, ctx.snapshot, targetCityPath, withDocField(cityNow, "stats.population", popAfter), "state", ["stats.population"]);
          targetChanges.push(
            fieldChange("stats.population", popBefore, popAfter, `R-18 inhabited: population −= displaced persons (${displacedPersons})`)
          );
        }
      }
    }
    const spirit = outcomeNote(
      applyIndexDelta(plan, ctx.snapshot, targetCityId, "spirit", PHASE4_SPIRIT_DELTA, `R-18 inhabited (Phase 4 form): spirit ${PHASE4_SPIRIT_DELTA}`),
      notes
    );
    if (spirit) targetChanges.push(spirit);
  }
  if (damageClass === "economic") {
    // The skim derives from GDP before this event's own percentage
    // applies (the published formula reads the standing figure).
    const gdpBefore = num(plannedDoc(plan, ctx.snapshot, targetCityPath), "stats.gdpRubars");
    const gdp = outcomeNote(
      applyGdpPercent(plan, ctx.snapshot, targetCityId, PHASE4_GDP_PERCENT, `R-18 economic (Phase 4 form): GDP ${PHASE4_GDP_PERCENT}%`),
      notes
    );
    if (gdp) targetChanges.push(gdp);
    if (gdpBefore === null) {
      notes.push("skipped: treasury skim — GDP unset (null), so the GDP-derived skim is skipped and logged (§2.4)");
    } else {
      const treasuryNow = num(plannedDoc(plan, ctx.snapshot, targetCityPath), "stats.treasuryRubars") ?? 0;
      const skim = Math.min(treasuryNow, Math.round((gdpBefore * PHASE4_TREASURY_SKIM_GDP_PERCENT) / 100));
      const skimChange = applyTreasuryDelta(
        plan,
        ctx.snapshot,
        targetCityId,
        -skim,
        `R-18 economic (Phase 4 form): treasury −min(treasury ${treasuryNow}, round(0.5% of GDP ${gdpBefore})) = −${skim}`
      );
      if (skimChange) targetChanges.push(skimChange);
    }
  }

  // Posture consumption (R-37): any hostile resolution against the
  // city consumes a standing posture, whatever its class.
  const postureBefore = (targetCity.defensePosture as Record<string, unknown> | undefined) ?? {
    prepared: false,
    setAtSeq: null,
    treasuryPaidRubars: null,
  };
  const wasPostured = postureBefore.prepared === true;
  if (wasPostured) {
    const cityNow = plannedDoc(plan, ctx.snapshot, targetCityPath) ?? targetCity;
    const postureAfter = { ...postureBefore, prepared: false };
    planWrite(plan, ctx.snapshot, targetCityPath, withDocField(cityNow, "defensePosture", postureAfter), "state", ["defensePosture"]);
    targetChanges.push(
      fieldChange("defensePosture", postureBefore, postureAfter, "R-37: posture consumed by the first hostile resolution targeting the city (R-18)")
    );
  }
  if (needsStructures) {
    targetChanges.push(...recomputeHousingUnits(plan, ctx.snapshot, targetCityId));
  }
  targetUpdated.push(targetCityPath);

  // ---- Actor-side costs (never scaled) + legal exposure -----------
  const actorChanges: LogEntryDraft["changes"] = [];
  const actorNotes: string[] = [];
  for (const [stat, delta] of Object.entries(ACTOR_COSTS)) {
    const change = outcomeNote(
      applyIndexDelta(plan, ctx.snapshot, actorCityId, stat, delta, `R-18 actor cost (never scaled): ${stat} ${delta}`),
      actorNotes
    );
    if (change) actorChanges.push(change);
  }
  const exposureBefore = (actorCity.legalExposure as Record<string, unknown> | undefined) ?? {
    open: false,
    caseIds: [],
    tier: 0,
  };
  const exposureAfter = {
    open: true,
    caseIds: [...strList(exposureBefore.caseIds), caseId],
    tier: Math.max(typeof exposureBefore.tier === "number" ? exposureBefore.tier : 0, 2),
  };
  {
    const cityNow = plannedDoc(plan, ctx.snapshot, actorCityPath) ?? actorCity;
    planWrite(plan, ctx.snapshot, actorCityPath, withDocField(cityNow, "legalExposure", exposureAfter), "state", ["legalExposure"]);
    actorChanges.push(
      fieldChange("legalExposure", exposureBefore, exposureAfter, `R-18: tier-2 case ${caseId} opened — realm law is engaged with ${actorCityId} (§4.5)`)
    );
  }

  // ---- The case record (§4.5) --------------------------------------
  const caseDoc: Record<string, unknown> = {
    caseId,
    openedAtSeq,
    tier: 2,
    accusedCityId: actorCityId,
    injuredCityIds: [targetCityId],
    ruleId: "R-18",
    status: "open",
    damageClass,
    sourceActionId: ctx.action.actionId,
    openedByResolutionId: ctx.resolutionId,
  };
  planWrite(plan, ctx.snapshot, casePath(caseId), caseDoc, "state", [
    "caseId",
    "openedAtSeq",
    "tier",
    "accusedCityId",
    "injuredCityIds",
    "ruleId",
    "status",
  ]);

  // ---- Entries ------------------------------------------------------
  const targetText =
    `R-18 ${damageClass} attack on ${targetCityId} (Phase 4 fixed-class form): ` +
    (conditionLines.length > 0 ? `condition ${conditionLines.join(", ")}. ` : "") +
    (damageClass === "inhabited" ? `Displacement: ${displacedHouseholds} household(s), ${displacedPersons} person(s) — records displaced, never deleted. ` : "") +
    (damageClass === "economic" ? "GDP and treasury per the economic class table. " : "") +
    (wasPostured
      ? `${targetCityId} was postured (R-37): the posture is consumed by this resolution. In the Phase 4 form the class values apply as written (posture damage factor ${PHASE4_POSTURE_DAMAGE_FACTOR} — v2 publishes no fixed-class reduction; flagged for ratification, see defensive.ts). `
      : `${targetCityId} held no posture. `) +
    `Consent check: no consent record — the action classified hostile by kind (consensual joint actions classify under their actual verbs, never as attack_city). Nothing cascades automatically: cities with a trade edge to ${targetCityId} are notified by this public entry and may act as their own actions.` +
    (notes.length > 0 ? ` Skips: ${notes.join("; ")}.` : "");
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: targetCityId,
      cityIds: [targetCityId],
      ruleIds: ["R-18"],
      changes: targetChanges,
      recordsUpdated: targetUpdated,
      summaryText: targetText,
      major: true,
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: actorCityId,
      cityIds: [actorCityId],
      ruleIds: ["R-18"],
      changes: actorChanges,
      recordsUpdated: [actorCityPath],
      summaryText:
        `R-18 actor costs on ${actorCityId}, paid in full, never scaled: law ${ACTOR_COSTS.law}, stability ${ACTOR_COSTS.stability}, influence ${ACTOR_COSTS.influence} (index discipline applies — a null index skips and logs). Tier-2 case ${caseId} is recorded on the city's legalExposure.` +
        (actorNotes.length > 0 ? ` Skips: ${actorNotes.join("; ")}.` : ""),
      major: true,
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      kind: "case",
      actor: ctx.action.actor,
      cityId: actorCityId,
      cityIds: [actorCityId, targetCityId],
      ruleIds: ["R-18"],
      changes: [],
      recordsCreated: [casePath(caseId)],
      legal: {
        caseId,
        tier: 2,
        status: "open",
        track: "ICTC-style tribunal (§4.5)",
        accusedCityId: actorCityId,
        injuredCityIds: [targetCityId],
        ruleId: "R-18",
      },
      summaryText:
        `Tier-2 legal case ${caseId} opened automatically by R-18's resolution: ${actorCityId} attacked ${targetCityId} (${damageClass} class). Open attack is not espionage — CJ's round-2 carve-out (a case only if the target users say so) governs the R-27 espionage class and does not apply here. The engine's role ends at opening and recording: charges and defense publish on the case record, and every sanction is a member action (verdicts via R-23) — the realm's response is politics, not automation.`,
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "attack-city", scope: "cross-city", ruleIds: ["R-18"], unruled: false, damageClass },
      cityId: actorCityId,
      cityIds: [actorCityId, targetCityId],
      ruleIds: ["R-18"],
      summaryText: `Attacked ${targetCityId} (${damageClass} class, Phase 4 fixed-class form) from ${actorCityId}. Actor costs paid in full; tier-2 case ${caseId} opened automatically.`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-37 — prepare defenses (posture) / stand down
// ---------------------------------------------------------------------------

function postureOf(city: Record<string, unknown>): Record<string, unknown> {
  return (city.defensePosture as Record<string, unknown> | undefined) ?? {
    prepared: false,
    setAtSeq: null,
    treasuryPaidRubars: null,
  };
}

function prepareDefensesHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-37";
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const denied = requireActingAuthority(ctx, descriptorId, "R-37", cityId);
  if (denied) return denied;
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath) as Record<string, unknown>;

  const amount = params.amountRubars;
  if (typeof amount !== "number" || !Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
    return rejectedPlan(
      descriptorId,
      "INVALID_AMOUNT",
      ["R-37"],
      `prepare_defenses records the amount in the action (owner-authored): amountRubars must be a positive integer (got ${String(amount)}). A preparation with no cost is not a preparation — the posture is treasury-paid by the rule's shape.`
    );
  }
  const treasuryBefore = num(city, "stats.treasuryRubars") ?? 0;
  if (amount > treasuryBefore) {
    return rejectedPlan(
      descriptorId,
      "INSUFFICIENT_TREASURY",
      ["R-37"],
      `Preparing defenses costs ${amount} R; ${cityId}'s treasury holds ${treasuryBefore} R. The posture is never part-paid — the action rejects in full and logs.`
    );
  }

  const plan = emptyPlan(descriptorId);
  const changes: LogEntryDraft["changes"] = [];
  // Two entries (rule-effect + summary) — setAtSeq derives from the
  // counter head the way allocation's commitSeq does.
  const setAtSeq = ctx.snapshot.counterHead.lastSeq + 2;
  const treasuryChange = applyTreasuryDelta(plan, ctx.snapshot, cityId, -amount, `R-37 posture cost (owner-authored amount): −${amount}`);
  if (treasuryChange) changes.push(treasuryChange);
  const postureBefore = postureOf(city);
  const postureAfter = { prepared: true, setAtSeq, treasuryPaidRubars: amount };
  {
    const current = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
    planWrite(plan, ctx.snapshot, cityPath, withDocField(current, "defensePosture", postureAfter), "state", ["defensePosture"]);
    changes.push(
      fieldChange("defensePosture", postureBefore, postureAfter, "R-37: posture set (replacing any prior posture — re-preparing refreshes it and pays again)")
    );
  }
  const overTenth = amount * 10 > treasuryBefore;
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-37"],
      changes,
      recordsUpdated: [cityPath],
      summaryText:
        `R-37: ${cityId} prepares its defenses — posture set at seq ${setAtSeq} for ${amount} R from the treasury.` +
        (postureBefore.prepared === true ? " The prior posture is replaced; its payment is not refunded." : "") +
        (overTenth ? ` Proposal flag (§4.3 convention): the amount exceeds 10% of the city's treasury (${treasuryBefore} R) — confirmed with eyes open.` : "") +
        " The posture is public on the city page (deterrence only works if it can be seen), is consumed by the first hostile resolution targeting the city, can be stood down by owner action (no refund), and never expires on a clock.",
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "prepare-defenses", scope: "city", ruleIds: ["R-37"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-37"],
      summaryText: `Prepared defenses in ${cityId} for ${amount} R (posture set at seq ${setAtSeq}).`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function standDownDefensesHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-37";
  const cityId = actionCityId(ctx.action);
  const denied = requireActingAuthority(ctx, descriptorId, "R-37", cityId);
  if (denied) return denied;
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath) as Record<string, unknown>;
  const postureBefore = postureOf(city);
  if (postureBefore.prepared !== true) {
    return rejectedPlan(
      descriptorId,
      "NOTHING_TO_STAND_DOWN",
      ["R-37"],
      `${cityId} holds no standing posture — there is nothing to stand down. (A posture ends by being consumed by a hostile resolution or by this action; it never expires on a clock.)`
    );
  }

  const plan = emptyPlan(descriptorId);
  const postureAfter = { ...postureBefore, prepared: false };
  planWrite(plan, ctx.snapshot, cityPath, withDocField(city, "defensePosture", postureAfter), "state", ["defensePosture"]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-37"],
      changes: [
        fieldChange("defensePosture", postureBefore, postureAfter, "R-37: posture stood down by owner action — no refund; the last preparation's setAtSeq/payment stay on the record as history"),
      ],
      recordsUpdated: [cityPath],
      summaryText: `R-37: ${cityId} stands its defenses down. The posture (set at seq ${String(postureBefore.setAtSeq)}, paid ${String(postureBefore.treasuryPaidRubars)} R) ends unused; there is no refund.`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "stand-down-defenses", scope: "city", ruleIds: ["R-37"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-37"],
      summaryText: `Stood down the defense posture in ${cityId} (no refund).`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Descriptors — registered by the Build Lead's single assembly edit.
// Finance §2.4 additions ride inline on the descriptors (the landed
// RuleDescriptor type carries the finance field since the Finance
// assembly): R-18's treasury skim is bounded by construction (never
// a shortfall — class "none"); R-37's payment refuses in full on
// shortfall, the transfer-class discipline (F-12 precedent).
// ---------------------------------------------------------------------------

export const DEFENSIVE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-18": {
    id: "R-18",
    actionKinds: ["attack_city"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { attack_city: attackHandler },
    readPlan: attackReadPlan,
    finance: { shortfallClass: "none", ledgersTouched: ["treasury"], invokesRules: ["R-37"] },
    summary: "Damage or attack another city (Phase 4 fixed-class form, DECISION-5): property / inhabited / economic classes at v2's stated Phase 4 values, actor costs in full (law −5, stability −2, influence −3), an automatic tier-2 case (espionage carve-out preserved for R-27), and the target's R-37 posture consumed. The stat contest is Phase 7 — nothing here computes or presupposes it.",
  },
  "R-37": {
    id: "R-37",
    actionKinds: ["prepare_defenses", "stand_down_defenses"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { prepare_defenses: prepareDefensesHandler, stand_down_defenses: standDownDefensesHandler },
    finance: { shortfallClass: "transfer", ledgersTouched: ["treasury"], invokesRules: [] },
    summary: "Prepare defenses (posture): owner action, treasury-paid at the owner-authored amount (>10%-of-treasury flagged at proposal), sets the defensePosture record — public, consumed by the first hostile resolution, stood down by owner action with no refund, never expiring on a clock. The same record feeds Phase 7's contest +10 DEF term.",
  },
};
