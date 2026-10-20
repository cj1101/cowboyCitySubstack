/**
 * Catalogue I — structures & city (Phase 4 brief §4.1, step 5).
 *
 * The R-05 spine (start/advance a project), the completion rules that
 * fire inside the completing Resolution Event in table order (R-01,
 * R-02, R-03, R-04, R-38), and the standing-structure rules R-16
 * (demolish uninhabited), R-19 (mothball), R-24 (maintain/repair).
 * Rule content is systems-spec-v2 §3 as amended by the structures
 * system design (§7.1 trigger amendment: kind OR `profile.supports`;
 * §5 function predicate; §6 housing derivation) — this file fixes the
 * build shape only.
 *
 * Discipline (landed Phase 2 §5.3 + Step 0): handlers are pure
 * (snapshot, action) → plan; they never invent content, never read a
 * clock (the snapshot's `now` is the only time), return rejection plans
 * for domain refusals, and compose every write through `plannedDoc` so
 * the plan's changes chain snapshot → folded write (F-02). Index
 * deltas skip-and-log on a `null` index (the engine never invents an
 * index value); GDP percentages skip-and-log on `null` GDP (§2.4).
 * Treasury never goes below 0: R-05 phase payments are budget-class
 * (finance §2.2) — a phase paid in part does not complete, and the
 * shortfall is logged.
 *
 * Function is DERIVED, never stored (brief §4.1, design §5): no write
 * in this file puts a stored function-availability flag on any record.
 * `isStructureFunctioning` below is the one predicate every consumer
 * reads. Natural geography is fixed ground truth (CJ §6.7.4): a
 * structure record carrying `profile.geography: "natural"` is refused
 * by every handler here — no Phase 4 handler creates, edits, or
 * deletes a natural feature. Man-made features are ordinary records
 * and flow through R-05 like any project.
 *
 * This file is NOT registered in `registry.ts` — the Build Lead makes
 * the single assembly edit (register STRUCTURE_DESCRIPTORS). Local
 * copies of the registry's small helpers (authority, citations) keep
 * this module free of an import cycle with the registry that will
 * import it.
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
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Record vocabulary (structures-system-design §2)
// ---------------------------------------------------------------------------

export type StructureKind =
  | "civic"
  | "cultural"
  | "commercial"
  | "industrial"
  | "housing"
  | "transport"
  | "infrastructure"
  | "military"
  | "other";

export type StructureStatus =
  | "planned"
  | "under-construction"
  | "complete"
  | "mothballed"
  | "demolished"
  | "ruined";

/** CJ's lifecycle vocabulary, derived from Dana's stored enum +
 * condition + repair state (design §4.1). Never stored. */
export type StructureLifecycle =
  | "planned"
  | "under-construction"
  | "existing"
  | "damaged"
  | "repairing"
  | "rebuilt"
  | "mothballed"
  | "destroyed"
  | "demolished";

export const STRUCTURE_KINDS: readonly StructureKind[] = [
  "civic",
  "cultural",
  "commercial",
  "industrial",
  "housing",
  "transport",
  "infrastructure",
  "military",
  "other",
];

/** R-05 size classes [Proposal in v2]: work units by size class, used
 * when a planned record carries a size class but no explicit
 * `workUnitsRequired`. */
export const SIZE_CLASS_WORK_UNITS: Record<string, number> = {
  landmark: 4,
  large: 3,
  standard: 2,
  small: 1,
};

/** The marker convention for natural-geography records (design §4 /
 * brief §4.1 geography posture): a structure record whose profile
 * declares `geography: "natural"` is fixed ground truth. */
export const NATURAL_GEOGRAPHY_MARKER = "natural";

export function structurePath(cityId: string, structureId: string): string {
  return `sim_cities/${cityId}/structures/${structureId}`;
}

export function householdsPath(cityId: string, householdId: string): string {
  return `sim_cities/${cityId}/households/${householdId}`;
}

// ---------------------------------------------------------------------------
// The derived function predicate (design §5.1 — locked strict reading
// of CJ S-6: ANY damage stops function; R-24's binary repair restores
// exactly the one value at which function exists).
// ---------------------------------------------------------------------------

export function isStructureFunctioning(
  structure: Record<string, unknown> | null
): boolean {
  if (!structure) return false;
  return structure.status === "complete" && structure.condition === 100;
}

/** Why a structure is out of function (design §5.1: every surface and
 * Log entry that reports an outage names which outage it is). Returns
 * "functioning" when the predicate holds. */
export function functionStateReason(
  structure: Record<string, unknown> | null
): string {
  if (!structure) return "missing";
  if (isStructureFunctioning(structure)) return "functioning";
  const status = structure.status;
  if (status === "complete") return "damaged";
  if (typeof status === "string") return status;
  return "unknown";
}

export function deriveLifecycle(
  structure: Record<string, unknown> | null
): StructureLifecycle | "missing" {
  if (!structure) return "missing";
  // Repairing is an overlay (design §4.1): an open repair/rebuild
  // project on the record, whatever the base state underneath.
  if (structure.openProject != null && typeof structure.openProject === "object") {
    return "repairing";
  }
  switch (structure.status as StructureStatus) {
    case "planned":
      return "planned";
    case "under-construction":
      return "under-construction";
    case "complete":
      if (structure.condition === 100) {
        // Rebuilt is a provenance badge on existing (design §4.1):
        // R-24's ruined → complete restoration stamps the record.
        return typeof structure.rebuiltAtResolutionId === "string"
          ? "rebuilt"
          : "existing";
      }
      return "damaged";
    case "mothballed":
      return "mothballed";
    case "ruined":
      return "destroyed";
    case "demolished":
      return "demolished";
    default:
      return "missing";
  }
}

export function isNaturalFeature(
  structure: Record<string, unknown> | null
): boolean {
  if (!structure) return false;
  const profile = structure.profile as Record<string, unknown> | undefined;
  return profile?.geography === NATURAL_GEOGRAPHY_MARKER;
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

/** Member authority over a city (mirrors registry.checkCityAuthority):
 * the actor's member uid (or on-behalf-of uid) must be in the faction's
 * ownerUids. */
function requireAuthority(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string
): ResolutionPlan | null {
  const cityId = actionCityId(ctx.action);
  if (!cityId) {
    return rejectedPlan(descriptorId, "NO_TARGET_CITY", [ruleId], "Action names no target city.");
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

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

const profileOf = (structure: Record<string, unknown>): Record<string, unknown> =>
  (structure.profile as Record<string, unknown> | undefined) ?? {};

const supportsOf = (structure: Record<string, unknown>): string[] =>
  strList(profileOf(structure).supports);

const functionTagsOf = (structure: Record<string, unknown>): string[] => {
  const fn = profileOf(structure).function as Record<string, unknown> | undefined;
  return strList(fn?.tags);
};

/** Prestige set at completion from the profile (R-01/R-38; default 3,
 * clamped to the §2.5 0–10 range). */
function profilePrestige(structure: Record<string, unknown>): number {
  const raw = profileOf(structure).prestige;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return clampNumber(Math.round(raw), 0, 10);
  }
  return 3;
}

// ---------------------------------------------------------------------------
// City-stat application against the PLANNED doc (F-02 discipline).
// Each helper returns the change to record, or a skip note when the
// §2.4 null discipline applies (index unset / GDP unset).
// ---------------------------------------------------------------------------

type StatOutcome =
  | { applied: true; change: LogEntryDraft["changes"][number] }
  | { applied: false; note: string };

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

/** Treasury movement computed by the caller (amount already bounded so
 * the balance cannot go below 0). Returns the change, or null when the
 * amount is 0 (no movement, no change line — finance §2.1). */
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

// ---------------------------------------------------------------------------
// Derived-stored counts (spec §2.1): housingUnits counts units of
// FUNCTIONING housing only (design §5.2/§6.2); households counts the
// city's household records. Both are recomputed from the planned state
// at every structures-touching event and written as bookkeeping inside
// the event's own Log entry — never on their own.
// ---------------------------------------------------------------------------

const STRUCTURES_QUERY_ID = "cat1-structures";
const HOUSEHOLDS_QUERY_ID = "cat1-households";

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

/** The final state of a collection inside this plan: the materialized
 * query docs overlaid with the plan's own writes to that collection. */
function plannedCollection(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): Map<string, Record<string, unknown> | null> | null {
  const docs = queryDocs(snapshot, queryId, collectionPath);
  if (!docs) return null;
  for (const write of plan.writes) {
    if (write.path.startsWith(`${collectionPath}/`)) {
      docs.set(write.path, write.op === "delete" ? null : (write.afterDoc ?? null));
    }
  }
  return docs;
}

export function isHousingStructure(structure: Record<string, unknown>): boolean {
  return structure.kind === "housing" || supportsOf(structure).includes("housing");
}

/** Units of functioning housing in a set of structure docs (design
 * §6.2): a damaged, mothballed, ruined, or demolished housing
 * structure contributes 0 until it functions again. */
export function functioningHousingUnits(
  structures: Iterable<Record<string, unknown> | null>
): number {
  let total = 0;
  for (const structure of structures) {
    if (!structure) continue;
    if (!isHousingStructure(structure)) continue;
    if (!isStructureFunctioning(structure)) continue;
    const units = num(structure, "units");
    if (units !== null && units > 0) total += units;
  }
  return total;
}

interface DerivedCounts {
  housingUnitsBefore: number | null;
  housingUnitsAfter: number | null;
  householdsBefore: number | null;
  householdsAfter: number | null;
  changes: LogEntryDraft["changes"];
}

/** Recompute the derived-stored counts from planned state and fold any
 * movement into the city doc. The returned changes carry BEFORE =
 * snapshot value, AFTER = final value, so they chain against the
 * folded write (F-02). */
function recomputeDerivedCounts(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  includeHouseholds: boolean
): DerivedCounts {
  const cityPath = `sim_cities/${cityId}`;
  const city = plannedDoc(plan, snapshot, cityPath);
  const out: DerivedCounts = {
    housingUnitsBefore: num(city, "stats.housingUnits"),
    housingUnitsAfter: null,
    householdsBefore: num(city, "stats.households"),
    householdsAfter: null,
    changes: [],
  };
  if (!city) return out;

  const structures = plannedCollection(plan, snapshot, STRUCTURES_QUERY_ID, `${cityPath}/structures`);
  if (structures) {
    const after = functioningHousingUnits(structures.values());
    out.housingUnitsAfter = after;
    const before = out.housingUnitsBefore ?? 0;
    if (after !== before) {
      const current = plannedDoc(plan, snapshot, cityPath) ?? city;
      planWrite(plan, snapshot, cityPath, withDocField(current, "stats.housingUnits", after), "state", ["stats.housingUnits"]);
      out.changes.push(
        fieldChange("stats.housingUnits", before, after, "housingUnits recomputed: units of functioning housing only (derived-stored, §2.1)")
      );
    }
  }

  if (includeHouseholds) {
    const households = plannedCollection(plan, snapshot, HOUSEHOLDS_QUERY_ID, `${cityPath}/households`);
    if (households) {
      let count = 0;
      for (const doc of households.values()) if (doc) count += 1;
      out.householdsAfter = count;
      const before = out.householdsBefore ?? 0;
      if (count !== before) {
        const current = plannedDoc(plan, snapshot, cityPath) ?? city;
        planWrite(plan, snapshot, cityPath, withDocField(current, "stats.households", count), "state", ["stats.households"]);
        out.changes.push(
          fieldChange("stats.households", before, count, "households recomputed: count of the city's household records (derived-stored, §2.1)")
        );
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// R-05 phase arithmetic (v2 R-05 + §2.4): phase cost =
// totalBudget / workUnitsRequired, rounded; the last phase takes the
// remainder. Per-phase payment progress derives from the landed
// `paidRubars` audit field — no extra bookkeeping field is needed.
// ---------------------------------------------------------------------------

export function phaseCostRubars(
  totalBudget: number,
  workUnitsRequired: number,
  phase: number
): number {
  const base = Math.round(totalBudget / workUnitsRequired);
  if (phase < workUnitsRequired) return base;
  return totalBudget - base * (workUnitsRequired - 1);
}

export function workUnitsRequiredOf(structure: Record<string, unknown>): number | null {
  const explicit = num(structure, "workUnitsRequired");
  if (explicit !== null && Number.isInteger(explicit) && explicit > 0) return explicit;
  const sizeClass = structure.sizeClass;
  if (typeof sizeClass === "string" && SIZE_CLASS_WORK_UNITS[sizeClass] !== undefined) {
    return SIZE_CLASS_WORK_UNITS[sizeClass];
  }
  return null;
}

/** Amount already paid toward the CURRENT (next unpaid) phase. */
export function paidTowardCurrentPhase(structure: Record<string, unknown>): number {
  const total = num(structure, "totalBudgetRubars") ?? 0;
  const required = workUnitsRequiredOf(structure) ?? 0;
  const done = num(structure, "workUnitsDone") ?? 0;
  const paid = num(structure, "paidRubars") ?? 0;
  if (required <= 0) return 0;
  let paidBefore = 0;
  for (let phase = 1; phase <= Math.min(done, required); phase += 1) {
    paidBefore += phaseCostRubars(total, required, phase);
  }
  return Math.max(0, paid - paidBefore);
}

// ---------------------------------------------------------------------------
// Completion rules R-01–R-04 + R-38 — fired inside the completing
// Resolution Event, in table order (design §7.1: kind OR supports;
// each matching rule fires once). Every effect composes against the
// planned doc; every skip is a Log line, never a silent zero.
// ---------------------------------------------------------------------------

interface CompletionOutcome {
  entries: LogEntryDraft[];
  firedRuleIds: string[];
  citiesTouched: string[];
}

function outcomeNote(outcome: StatOutcome, notes: string[]): LogEntryDraft["changes"][number] | null {
  if (outcome.applied) return outcome.change;
  notes.push(outcome.note);
  return null;
}

function applyCompletions(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  cityId: string,
  structureId: string
): CompletionOutcome {
  const snapshot = ctx.snapshot;
  const actor = ctx.action.actor;
  const sPath = structurePath(cityId, structureId);
  const structure = plannedDoc(plan, snapshot, sPath) ?? {};
  const kind = structure.kind as string | undefined;
  const supports = supportsOf(structure);
  const tags = functionTagsOf(structure);
  const profile = profileOf(structure);
  const entries: LogEntryDraft[] = [];
  const fired: string[] = [];
  const cities = new Set<string>([cityId]);
  const name = (structure.name as string | undefined) ?? structureId;

  const setPrestige = (ruleId: string, changes: LogEntryDraft["changes"]): void => {
    const current = plannedDoc(plan, snapshot, sPath) ?? structure;
    const before = num(current, "prestige");
    const prestige = profilePrestige(current);
    if (before !== prestige) {
      planWrite(plan, snapshot, sPath, withDocField(current, "prestige", prestige), "state", ["prestige"]);
      changes.push(
        fieldChange(`structures/${structureId}.prestige`, before, prestige, `prestige set from profile at completion (default 3) (${ruleId})`)
      );
    }
  };

  // ---- R-01 — civic / cultural completion (design §7.1: kind civic|
  // cultural, or supports culture|infrastructure) --------------------
  if (
    kind === "civic" ||
    kind === "cultural" ||
    supports.includes("culture") ||
    supports.includes("infrastructure")
  ) {
    fired.push("R-01");
    const notes: string[] = [];
    const changes: LogEntryDraft["changes"] = [];
    const culture = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "culture", 2, "R-01 completion: culture +2"), notes);
    if (culture) changes.push(culture);
    const infra = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "infrastructure", 1, "R-01 completion: infrastructure +1"), notes);
    if (infra) changes.push(infra);
    const gdp = outcomeNote(applyGdpPercent(plan, snapshot, cityId, 0.2, "R-01 completion: gdp +0.2%"), notes);
    if (gdp) changes.push(gdp);
    setPrestige("R-01", changes);
    entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds: ["R-01"],
        changes,
        recordsUpdated: [sPath, `sim_cities/${cityId}`],
        summaryText:
          `R-01: "${name}" (${kind ?? "other"}) completed in ${cityId} — culture +2, infrastructure +1, gdp +0.2%, prestige ${profilePrestige(structure)}.` +
          (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      })
    );
    // Spillover (v2 R-01 + design §3.2 tag registry): the profile
    // names another city AND the function tags mark this a shared /
    // memorial reference (shrine|memorial) — the named city gets
    // culture +1. The function field is what a rule reads here:
    // change the tags and this branch does not fire (P4-G5-C1).
    const namedCities = strList(profile.namedCityIds);
    const isSharedReference = tags.includes("shrine") || tags.includes("memorial");
    if (namedCities.length > 0 && isSharedReference) {
      for (const otherCity of namedCities) {
        if (otherCity === cityId) continue;
        const otherDoc = plannedDoc(plan, snapshot, `sim_cities/${otherCity}`);
        if (!otherDoc) {
          entries.push(
            ruleEffectDraft({
              actor,
              cityId: otherCity,
              cityIds: [otherCity],
              ruleIds: ["R-01"],
              changes: [],
              summaryText: `R-01 spillover: ${otherCity} is named by "${name}" as a shared reference, but no city record stands for it — spillover skipped and logged.`,
            })
          );
          continue;
        }
        cities.add(otherCity);
        const spillNotes: string[] = [];
        const spillChanges: LogEntryDraft["changes"] = [];
        const spill = outcomeNote(
          applyIndexDelta(plan, snapshot, otherCity, "culture", 1, "R-01 spillover: named shared/memorial reference, culture +1"),
          spillNotes
        );
        if (spill) spillChanges.push(spill);
        entries.push(
          ruleEffectDraft({
            actor,
            cityId: otherCity,
            cityIds: [otherCity],
            ruleIds: ["R-01"],
            changes: spillChanges,
            recordsUpdated: [`sim_cities/${otherCity}`],
            summaryText:
              `R-01 spillover: "${name}" in ${cityId} names ${otherCity} (function tags: ${tags.join(", ")}) — culture +1.` +
              (spillNotes.length > 0 ? ` ${spillNotes.join("; ")}.` : ""),
          })
        );
      }
    }
  }

  // ---- R-02 — commercial / industrial completion (kind or supports
  // economy) ----------------------------------------------------------
  if (kind === "commercial" || kind === "industrial" || supports.includes("economy")) {
    fired.push("R-02");
    const notes: string[] = [];
    const changes: LogEntryDraft["changes"] = [];
    const branch = kind === "industrial" ? "industrial" : "commercial";
    const pct = branch === "industrial" ? 0.9 : 0.6;
    const gdp = outcomeNote(
      applyGdpPercent(plan, snapshot, cityId, pct, `R-02 completion (${branch} branch): gdp +${pct}%`),
      notes
    );
    if (gdp) changes.push(gdp);
    // Founding dividend: treasury += round(0.5% of GDP), computed on
    // the GDP this completion leaves standing (the formula is printed
    // on the change line so the Log re-derives it exactly).
    const gdpNow = num(plannedDoc(plan, snapshot, `sim_cities/${cityId}`), "stats.gdpRubars");
    if (gdpNow === null) {
      notes.push("skipped: founding dividend — gdp unset");
    } else {
      const dividend = Math.round(gdpNow * 0.005);
      const treasuryChange = applyTreasuryDelta(
        plan, snapshot, cityId, dividend,
        `R-02 founding dividend: round(0.5% × gdp ${gdpNow}) = ${dividend}`
      );
      if (treasuryChange) changes.push(treasuryChange);
    }
    if (branch === "industrial") {
      const infra = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "infrastructure", 1, "R-02 completion (industrial): infrastructure +1"), notes);
      if (infra) changes.push(infra);
    }
    entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds: ["R-02"],
        changes,
        recordsUpdated: [`sim_cities/${cityId}`],
        summaryText:
          `R-02: "${name}" completed in ${cityId} on the ${branch} branch — gdp +${pct}%, founding dividend,${branch === "industrial" ? " infrastructure +1," : ""} per the table.` +
          (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      })
    );
    // Supplier spillover: each profile-named supplier city +0.2% GDP.
    for (const supplierCity of strList(profile.supplierCityIds)) {
      if (supplierCity === cityId) continue;
      const supplierDoc = plannedDoc(plan, snapshot, `sim_cities/${supplierCity}`);
      if (!supplierDoc) continue;
      cities.add(supplierCity);
      const spillNotes: string[] = [];
      const spillChanges: LogEntryDraft["changes"] = [];
      const spill = outcomeNote(
        applyGdpPercent(plan, snapshot, supplierCity, 0.2, "R-02 supplier spillover: gdp +0.2%"),
        spillNotes
      );
      if (spill) spillChanges.push(spill);
      entries.push(
        ruleEffectDraft({
          actor,
          cityId: supplierCity,
          cityIds: [supplierCity],
          ruleIds: ["R-02"],
          changes: spillChanges,
          recordsUpdated: [`sim_cities/${supplierCity}`],
          summaryText:
            `R-02 spillover: "${name}" in ${cityId} names ${supplierCity} as an input supplier — gdp +0.2%.` +
            (spillNotes.length > 0 ? ` ${spillNotes.join("; ")}.` : ""),
        })
      );
    }
  }

  // ---- R-03 — housing completion (kind housing, or supports housing,
  // with units > 0): households form BY THIS ACTION ------------------
  const units = num(structure, "units");
  if ((kind === "housing" || supports.includes("housing")) && units !== null && units > 0) {
    fired.push("R-03");
    const params = sa(ctx.action);
    const changes: LogEntryDraft["changes"] = [];
    const createdPaths: string[] = [];
    const updatedPaths: string[] = [sPath];
    const housedIds: string[] = [];
    let housedSizeTotal = 0;

    // Housing candidates, in the action's own order of naming:
    // (1) immigrating households named from an origin city, (2) new
    // household records this action creates, (3) the city's queued
    // unhoused households (the v2 default).
    interface Candidate {
      householdId: string;
      size: number;
      apply: (
        originChanges: LogEntryDraft["changes"],
        originUpdatedPaths: string[]
      ) => void;
    }
    const candidates: Candidate[] = [];

    const originCityId = typeof params.originCityId === "string" ? params.originCityId : null;
    if (originCityId && originCityId !== cityId) {
      for (const householdId of strList(params.householdIds)) {
        const originPath = householdsPath(originCityId, householdId);
        const originDoc = snapshotDoc(snapshot, originPath);
        if (!originDoc) continue;
        const size = num(originDoc, "size") ?? 0;
        candidates.push({
          householdId,
          size,
          apply: (originChanges, originUpdatedPaths) => {
            const destPath = householdsPath(cityId, householdId);
            planWrite(plan, snapshot, originPath, null, "state", ["status", "homeStructureId"]);
            originUpdatedPaths.push(originPath, `sim_cities/${originCityId}`);
            originChanges.push(fieldChange(`households/${householdId}.status`, originDoc.status ?? null, null, "R-03 immigration: household record leaves the origin city (zero-sum, both sides logged)"));
            planWrite(plan, snapshot, destPath, {
              ...originDoc,
              homeStructureId: structureId,
              status: "housed",
              originCityId,
              sourceActionId: ctx.action.actionId,
              lastResolutionId: null,
              lastChangedSeq: null,
            }, "state", ["status", "homeStructureId"]);
            createdPaths.push(destPath);
            changes.push(fieldChange(`households/${householdId}.status`, null, "housed", "R-03 immigration: household record arrives housed in the completing city"));
            // Origin city loses the household and its people, by the
            // same amounts (v2 R-03 spillover, zero-sum).
            const origin = plannedDoc(plan, snapshot, `sim_cities/${originCityId}`);
            if (origin) {
              const beforeCount = num(origin, "stats.households") ?? 0;
              const afterCount = Math.max(0, beforeCount - 1);
              planWrite(plan, snapshot, `sim_cities/${originCityId}`, withDocField(origin, "stats.households", afterCount), "state", ["stats.households"]);
              originChanges.push(fieldChange("stats.households", beforeCount, afterCount, "R-03 immigration: origin city loses the household record"));
              const originPop = num(origin, "stats.population");
              if (originPop !== null && size > 0) {
                const current = plannedDoc(plan, snapshot, `sim_cities/${originCityId}`) ?? origin;
                const afterPop = Math.max(0, originPop - size);
                planWrite(plan, snapshot, `sim_cities/${originCityId}`, withDocField(current, "stats.population", afterPop), "state", ["stats.population"]);
                originChanges.push(fieldChange("stats.population", originPop, afterPop, "R-03 immigration: origin population -= the household's size (population is set)"));
              }
            }
            cities.add(originCityId);
          },
        });
      }
    }

    const newHouseholds = Array.isArray(params.newHouseholds) ? params.newHouseholds : [];
    newHouseholds.forEach((raw, index) => {
      const spec = (raw ?? {}) as Record<string, unknown>;
      const householdId =
        typeof spec.householdId === "string" && spec.householdId
          ? spec.householdId
          : `household_${ctx.resolutionId}_${String(index + 1).padStart(2, "0")}`;
      const size = typeof spec.size === "number" && spec.size > 0 ? Math.round(spec.size) : 1;
      candidates.push({
        householdId,
        size,
        apply: () => {
          const path = householdsPath(cityId, householdId);
          planWrite(plan, snapshot, path, {
            schemaVersion: 2,
            name: typeof spec.name === "string" ? spec.name : householdId,
            size,
            memberFigureIds: strList(spec.memberFigureIds),
            homeStructureId: structureId,
            status: "housed",
            originCityId: originCityId ?? cityId,
            sourceActionId: ctx.action.actionId,
            sourceSeq: null,
            stateVersion: 1,
            lastChangedSeq: null,
            lastResolutionId: null,
          }, "state", ["status", "homeStructureId"]);
          createdPaths.push(path);
          changes.push(fieldChange(`households/${householdId}.status`, null, "housed", "R-03: household formed by the completion action and housed"));
        },
      });
    });

    const queued = queryDocs(snapshot, HOUSEHOLDS_QUERY_ID, `sim_cities/${cityId}/households`);
    if (queued) {
      for (const [path, doc] of queued) {
        if (!doc) continue;
        const status = doc.status as string | undefined;
        const home = doc.homeStructureId;
        if ((status === "unhoused" || status === "queued" || status === "displaced") && (home === null || home === undefined)) {
          const householdId = path.split("/").pop() as string;
          if (candidates.some((c) => c.householdId === householdId)) continue;
          const size = num(doc, "size") ?? 0;
          candidates.push({
            householdId,
            size,
            apply: () => {
              const current = plannedDoc(plan, snapshot, path) ?? doc;
              planWrite(plan, snapshot, path, {
                ...current,
                homeStructureId: structureId,
                status: "housed",
                lastResolutionId: null,
                lastChangedSeq: null,
              }, "state", ["status", "homeStructureId"]);
              updatedPaths.push(path);
              changes.push(fieldChange(`households/${householdId}.status`, status ?? null, "housed", "R-03: queued household housed by the completion"));
              changes.push(fieldChange(`households/${householdId}.homeStructureId`, home ?? null, structureId, "R-03: home structure set at housing"));
            },
          });
        }
      }
    }

    const originChanges: LogEntryDraft["changes"] = [];
    const originUpdatedPaths: string[] = [];
    const housed = candidates.slice(0, units);
    for (const candidate of housed) {
      candidate.apply(originChanges, originUpdatedPaths);
      housedIds.push(candidate.householdId);
      housedSizeTotal += candidate.size;
    }

    // The structure's resident list gains the housed households.
    if (housedIds.length > 0) {
      const current = plannedDoc(plan, snapshot, sPath) ?? structure;
      const beforeResidents = strList(current.residentHouseholdIds);
      const afterResidents = [...new Set([...beforeResidents, ...housedIds])];
      planWrite(plan, snapshot, sPath, withDocField(current, "residentHouseholdIds", afterResidents), "state", ["residentHouseholdIds"]);
      changes.push(fieldChange(`structures/${structureId}.residentHouseholdIds`, beforeResidents, afterResidents, "R-03: resident households recorded on the structure"));
    }

    // Population: only where set (§2.3 — never substituted).
    const notes: string[] = [];
    const cityNow = plannedDoc(plan, snapshot, `sim_cities/${cityId}`);
    const population = num(cityNow, "stats.population");
    if (population !== null && housedSizeTotal > 0) {
      const popChange = (() => {
        const current = plannedDoc(plan, snapshot, `sim_cities/${cityId}`) ?? {};
        planWrite(plan, snapshot, `sim_cities/${cityId}`, withDocField(current, "stats.population", population + housedSizeTotal), "state", ["stats.population"]);
        return fieldChange("stats.population", population, population + housedSizeTotal, "R-03: population += sizes of housed households (population is set)");
      })();
      changes.push(popChange);
    } else if (population === null && housedSizeTotal > 0) {
      notes.push("population unset — housed sizes recorded on the household records only (§2.3 fallback)");
    }

    // The housedRatio crossing (v2 R-03): spirit +1 when THIS
    // completion moves the city from shortage (< 1) to housed (>= 1).
    // Read from the derived counts before/after this plan's writes —
    // the reward fires on completions only, never on a repair that
    // restores units (design §6.2).
    const structuresBefore = queryDocs(snapshot, STRUCTURES_QUERY_ID, `sim_cities/${cityId}/structures`);
    const householdsBeforeDocs = queryDocs(snapshot, HOUSEHOLDS_QUERY_ID, `sim_cities/${cityId}/households`);
    const unitsBefore = structuresBefore ? functioningHousingUnits(structuresBefore.values()) : 0;
    const householdsBefore = householdsBeforeDocs
      ? [...householdsBeforeDocs.values()].filter((d) => d !== null).length
      : 0;
    const structuresAfter = plannedCollection(plan, snapshot, STRUCTURES_QUERY_ID, `sim_cities/${cityId}/structures`);
    const householdsAfterDocs = plannedCollection(plan, snapshot, HOUSEHOLDS_QUERY_ID, `sim_cities/${cityId}/households`);
    const unitsAfter = structuresAfter ? functioningHousingUnits(structuresAfter.values()) : unitsBefore;
    const householdsAfter = householdsAfterDocs
      ? [...householdsAfterDocs.values()].filter((d) => d !== null).length
      : householdsBefore;
    const ratioBefore = householdsBefore > 0 && unitsBefore > 0 ? Math.min(1, unitsBefore / Math.max(1, householdsBefore)) : null;
    const ratioAfter = householdsAfter > 0 && unitsAfter > 0 ? Math.min(1, unitsAfter / Math.max(1, householdsAfter)) : null;
    let spiritNote = "";
    if (householdsBefore > 0 && ratioBefore !== null && ratioBefore < 1 && ratioAfter !== null && ratioAfter >= 1) {
      const spirit = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "spirit", 1, "R-03: housedRatio crossed to >= 1 — shortage relieved, spirit +1"), notes);
      if (spirit) changes.push(spirit);
      spiritNote = " housedRatio crossed from < 1 to >= 1 (spirit +1).";
    }

    entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [...cities],
        ruleIds: ["R-03"],
        changes,
        recordsCreated: createdPaths,
        recordsUpdated: updatedPaths,
        summaryText:
          `R-03: "${name}" completed in ${cityId} with ${units} unit(s); ${housedIds.length} household(s) housed by this action (${housedIds.join(", ") || "none"})` +
          (originCityId ? `, origin city ${originCityId}` : "") +
          `; housedRatio ${ratioBefore === null ? "—" : ratioBefore.toFixed(2)} → ${ratioAfter === null ? "—" : ratioAfter.toFixed(2)}.${spiritNote}` +
          (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      })
    );
    if (originCityId && housedIds.length > 0) {
      entries.push(
        ruleEffectDraft({
          actor,
          cityId: originCityId,
          cityIds: [originCityId],
          ruleIds: ["R-03"],
          changes: originChanges,
          recordsUpdated: [...new Set(originUpdatedPaths)],
          summaryText: `R-03 spillover: ${originCityId} loses the immigrating household record(s) (${housedIds.join(", ")}) to ${cityId} — zero-sum, logged on both sides. Its household count and population (where set) move on its own doc in this same event.`,
        })
      );
    }
  }

  // ---- R-04 — transport / infrastructure completion (kind transport|
  // infrastructure, supports transport, or civic tagged infrastructure)
  if (
    kind === "transport" ||
    kind === "infrastructure" ||
    supports.includes("transport") ||
    (kind === "civic" && tags.includes("infrastructure"))
  ) {
    fired.push("R-04");
    const notes: string[] = [];
    const changes: LogEntryDraft["changes"] = [];
    const infra = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "infrastructure", 3, "R-04 completion: infrastructure +3"), notes);
    if (infra) changes.push(infra);
    const gdp = outcomeNote(applyGdpPercent(plan, snapshot, cityId, 0.3, "R-04 completion: gdp +0.3%"), notes);
    if (gdp) changes.push(gdp);
    const r04OwnEntry = ruleEffectDraft({
      actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-04"],
      changes,
      recordsUpdated: [`sim_cities/${cityId}`],
      summaryText:
        `R-04: "${name}" completed in ${cityId} — infrastructure +3, gdp +0.3%.` +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
    });
    entries.push(r04OwnEntry);
    // Endpoints: each named city gets infrastructure +1 and the
    // standing connection record — recorded on both city docs as the
    // landed trait spelling `connection:<cityId>:live` (WB-7.2, the
    // form the engine's connectivity reads consume). Endpoint owners
    // are notified through this entry on their city's slice.
    const endpoints = [...new Set([...strList(profile.endpointCityIds), ...strList(sa(ctx.action).endpointCityIds)])];
    for (const endpointCity of endpoints) {
      if (endpointCity === cityId) continue;
      const endpointDoc = plannedDoc(plan, snapshot, `sim_cities/${endpointCity}`);
      if (!endpointDoc) {
        entries.push(
          ruleEffectDraft({
            actor,
            cityId: endpointCity,
            cityIds: [endpointCity],
            ruleIds: ["R-04"],
            changes: [],
            summaryText: `R-04 endpoint: ${endpointCity} is named as a connected endpoint of "${name}", but no city record stands for it — connection skipped and logged.`,
          })
        );
        continue;
      }
      cities.add(endpointCity);
      const endNotes: string[] = [];
      const endChanges: LogEntryDraft["changes"] = [];
      const endInfra = outcomeNote(
        applyIndexDelta(plan, snapshot, endpointCity, "infrastructure", 1, "R-04 endpoint: infrastructure +1"),
        endNotes
      );
      if (endInfra) endChanges.push(endInfra);
      const trait = `connection:${cityId}:live`;
      const beforeTraits = strList(endpointDoc.traits);
      if (!beforeTraits.includes(trait)) {
        const current = plannedDoc(plan, snapshot, `sim_cities/${endpointCity}`) ?? endpointDoc;
        const afterTraits = [...strList(current.traits), trait];
        planWrite(plan, snapshot, `sim_cities/${endpointCity}`, withDocField(current, "traits", afterTraits), "state", ["traits"]);
        endChanges.push(fieldChange("traits", beforeTraits, afterTraits, `R-04: standing connection record to ${cityId} (connection trait, WB-7.2)`));
      }
      entries.push(
        ruleEffectDraft({
          actor,
          cityId: endpointCity,
          cityIds: [endpointCity],
          ruleIds: ["R-04"],
          changes: endChanges,
          recordsUpdated: [`sim_cities/${endpointCity}`],
          summaryText:
            `R-04 endpoint: ${endpointCity} is now connected to ${cityId} by "${name}" — infrastructure +1 and a standing connection record; the endpoint owner is notified by this entry.` +
            (endNotes.length > 0 ? ` ${endNotes.join("; ")}.` : ""),
        })
      );
      // The completing city's own connection trait to the endpoint.
      const ownTrait = `connection:${endpointCity}:live`;
      const ownDoc = plannedDoc(plan, snapshot, `sim_cities/${cityId}`);
      if (ownDoc && !strList(ownDoc.traits).includes(ownTrait)) {
        const beforeOwn = strList(ownDoc.traits);
        const afterOwn = [...beforeOwn, ownTrait];
        planWrite(plan, snapshot, `sim_cities/${cityId}`, withDocField(ownDoc, "traits", afterOwn), "state", ["traits"]);
        r04OwnEntry.changes.push(fieldChange("traits", beforeOwn, afterOwn, `R-04: standing connection record to ${endpointCity} (connection trait, WB-7.2)`));
      }
    }
  }

  // ---- R-38 — military completion (kind military; the profile's
  // supports declaration names the stat — the engine never guesses) ---
  if (kind === "military") {
    fired.push("R-38");
    const notes: string[] = [];
    const changes: LogEntryDraft["changes"] = [];
    const branches: string[] = [];
    if (supports.includes("military")) {
      branches.push("military");
      const delta = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "military", 2, "R-38 completion (supports: military): military +2"), notes);
      if (delta) changes.push(delta);
    }
    if (supports.includes("defense")) {
      branches.push("defense");
      const delta = outcomeNote(applyIndexDelta(plan, snapshot, cityId, "defense", 2, "R-38 completion (supports: defense): defense +2"), notes);
      if (delta) changes.push(delta);
    }
    setPrestige("R-38", changes);
    entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds: ["R-38"],
        changes,
        recordsUpdated: [sPath, `sim_cities/${cityId}`],
        summaryText:
          `R-38: "${name}" completed in ${cityId} on the supports branch(es) ${branches.join(" + ") || "none"} — the named index +2, prestige ${profilePrestige(structure)}. The +2 is banked history: later damage stops this structure's function but never claws it back.` +
          (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
        major: true,
      })
    );
  }

  return { entries, firedRuleIds: fired, citiesTouched: [...cities] };
}

// ---------------------------------------------------------------------------
// Plan hygiene: an entry may only claim records the plan actually
// writes (validatePlan enforces it). Claims are pruned to the folded
// write set, with create/update assigned from the write's net op.
// ---------------------------------------------------------------------------

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
// Read plans (F-01): the structures collection read backs the
// derived-count recompute in EVERY structures event; the households
// read backs R-03 formation and R-19 displacement; cross-city docs
// (spillover targets, endpoints, immigration origins) are derived
// from the seed structure record and the action — resolver-side,
// never from actor citations alone.
// ---------------------------------------------------------------------------

function seedStructure(seeds: ReadPlanSeeds): {
  cityId: string;
  structureId: string;
  doc: Record<string, unknown> | null;
} {
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  const structureId = typeof params.structureId === "string" ? params.structureId : "";
  const doc =
    cityId && structureId ? (seeds.seedDocs.get(structurePath(cityId, structureId)) ?? null) : null;
  return { cityId, structureId, doc };
}

function projectReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const { cityId, doc } = seedStructure(seeds);
  if (!cityId) return {};
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  const profile = doc ? profileOf(doc) : {};
  for (const key of ["namedCityIds", "supplierCityIds", "endpointCityIds"] as const) {
    for (const other of strList(profile[key])) {
      if (other !== cityId) paths.push(`sim_cities/${other}`);
    }
  }
  for (const other of strList(params.endpointCityIds)) {
    if (other !== cityId) paths.push(`sim_cities/${other}`);
  }
  if (typeof params.originCityId === "string" && params.originCityId !== cityId) {
    paths.push(`sim_cities/${params.originCityId}`);
    for (const householdId of strList(params.householdIds)) {
      paths.push(householdsPath(params.originCityId, householdId));
    }
  }
  return { paths, queries: [structuresQuery(cityId), householdsQuery(cityId)] };
}

function structuresOnlyReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const { cityId } = seedStructure(seeds);
  if (!cityId) return {};
  return { queries: [structuresQuery(cityId)] };
}

function mothballReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const { cityId, doc } = seedStructure(seeds);
  if (!cityId) return {};
  const paths: string[] = [];
  if (doc) {
    for (const householdId of strList(doc.residentHouseholdIds)) {
      paths.push(householdsPath(cityId, householdId));
    }
  }
  return { paths, queries: [structuresQuery(cityId), householdsQuery(cityId)] };
}

// ---------------------------------------------------------------------------
// Shared handler prologue for the standing-structure rules.
// ---------------------------------------------------------------------------

function loadStructure(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string
): { cityId: string; structureId: string; structure: Record<string, unknown> } | ResolutionPlan {
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const city = snapshotDoc(ctx.snapshot, `sim_cities/${cityId}`);
  if (!city) {
    return rejectedPlan(descriptorId, "NO_CITY", [ruleId], `City ${cityId} does not stand.`);
  }
  const structureId = typeof params.structureId === "string" ? params.structureId : "";
  if (!structureId) {
    return rejectedPlan(descriptorId, "NO_STRUCTURE", [ruleId], "The action names no structureId.");
  }
  const structure = snapshotDoc(ctx.snapshot, structurePath(cityId, structureId));
  if (!structure) {
    return rejectedPlan(descriptorId, "NO_STRUCTURE", [ruleId], `Structure ${structureId} does not stand in ${cityId}.`);
  }
  if (isNaturalFeature(structure)) {
    return rejectedPlan(
      descriptorId,
      "GEOGRAPHY_FIXED",
      [ruleId],
      `${structureId} is a natural feature — fixed ground truth (CJ §6.7.4). No Phase 4 handler creates, edits, or deletes a natural feature; only a deliberate man-made project changes geography, and it lands as a new ordinary record.`
    );
  }
  return { cityId, structureId, structure };
}

function requireStructuresQuery(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string,
  cityId: string
): ResolutionPlan | null {
  if (!queryDocs(ctx.snapshot, STRUCTURES_QUERY_ID, `sim_cities/${cityId}/structures`)) {
    return rejectedPlan(
      descriptorId,
      "READ_PLAN_MISSING",
      [ruleId],
      "The structures collection read was not materialized into the snapshot — a handler never improvises a read outside its declared read plan (F-01)."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// R-05 — start or advance a project (the spine)
// ---------------------------------------------------------------------------

function advanceProjectHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-05";
  const denied = requireAuthority(ctx, descriptorId, "R-05");
  if (denied) return denied;
  const loaded = loadStructure(ctx, descriptorId, "R-05");
  if (!("structure" in loaded)) return loaded;
  const { cityId, structureId, structure } = loaded;
  const cityPath = `sim_cities/${cityId}`;
  const sPath = structurePath(cityId, structureId);
  const name = (structure.name as string | undefined) ?? structureId;
  const missing = requireStructuresQuery(ctx, descriptorId, "R-05", cityId);
  if (missing) return missing;

  const actor = ctx.action.actor;
  const status = structure.status as string | undefined;

  // Reactivation (R-19's closing line): an R-05 advance on a
  // mothballed record returns it to standing at the condition it was
  // mothballed at. No phase cost, no completion re-fire — the
  // completion was history, and history is not re-granted.
  if (status === "mothballed") {
    const plan = emptyPlan(descriptorId);
    const current = plannedDoc(plan, ctx.snapshot, sPath) ?? structure;
    planWrite(plan, ctx.snapshot, sPath, withDocField(current, "status", "complete"), "state", ["status"]);
    const derived = recomputeDerivedCounts(plan, ctx.snapshot, cityId, false);
    const changes: LogEntryDraft["changes"] = [
      fieldChange(`structures/${structureId}.status`, "mothballed", "complete", "R-19/R-05 reactivation: mothballed structure returns to standing on the same record"),
      ...derived.changes,
    ];
    plan.entries.push(
      ruleEffectDraft({
        actor,
        cityId,
        cityIds: [cityId],
        ruleIds: ["R-05", "R-19"],
        changes,
        recordsUpdated: [sPath, cityPath],
        summaryText: `R-05 reactivation: "${name}" in ${cityId} leaves mothballs and stands again at condition ${num(structure, "condition") ?? "unset"} — function state now: ${functionStateReason({ ...structure, status: "complete" })}. No completion effects re-fire.`,
      })
    );
    plan.entries.push(
      summaryDraft({
        actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        classification: { verb: "advance-project", scope: "city", ruleIds: ["R-05", "R-19"], unruled: false },
        cityId,
        cityIds: [cityId],
        ruleIds: ["R-05", "R-19"],
        summaryText: `Reactivated "${name}" in ${cityId} (R-05 advance on a mothballed record).`,
      })
    );
    pruneRecordClaims(plan);
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  }

  if (status === "complete") {
    return rejectedPlan(descriptorId, "NOTHING_TO_ADVANCE", ["R-05"], `"${name}" already stands complete in ${cityId}; there is no project phase to advance.`);
  }
  if (status === "demolished" || status === "ruined") {
    return rejectedPlan(
      descriptorId,
      "STRUCTURE_GONE",
      ["R-05"],
      `"${name}" is ${status} — destroyed is gone (CJ). A ${status === "ruined" ? "ruined structure returns through R-24 repair where it applies, or a real rebuild project" : "demolished structure is recovered only by building anew under a new project record"}; R-05 never advances a ${status} record.`
    );
  }
  if (status !== "planned" && status !== "under-construction") {
    return rejectedPlan(descriptorId, "INVALID_STATUS", ["R-05"], `"${name}" has status ${status ?? "unset"} — not a project state R-05 can advance.`);
  }

  const required = workUnitsRequiredOf(structure);
  const total = num(structure, "totalBudgetRubars");
  if (required === null || total === null || total < 0) {
    return rejectedPlan(
      descriptorId,
      "MALFORMED_PROJECT",
      ["R-05"],
      `"${name}" lacks a lawful project basis (workUnitsRequired from the record or its size class, and totalBudgetRubars). The record must be repaired by its creation flow before R-05 can advance it — the engine invents neither.`
    );
  }

  // R-38's discipline enforced at the R-05 touchpoint (P4-G7-C4): a
  // military structure whose profile names neither supports branch is
  // refused before any money moves — the engine never guesses.
  if (
    structure.kind === "military" &&
    !supportsOf(structure).includes("military") &&
    !supportsOf(structure).includes("defense")
  ) {
    return rejectedPlan(
      descriptorId,
      "R38_SUPPORTS_MISSING",
      ["R-38"],
      `"${name}" is kind military but its profile.supports names neither "military" nor "defense" — rejected at proposal (R-38): the author declares which stat a military structure feeds, in the open; the engine never guesses.`
    );
  }

  const done = num(structure, "workUnitsDone") ?? 0;
  const paid = num(structure, "paidRubars") ?? 0;
  const city = snapshotDoc(ctx.snapshot, cityPath) ?? {};
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  const phase = Math.min(done + 1, required);
  const phaseCost = phaseCostRubars(total, required, phase);
  const due = Math.max(0, phaseCost - paidTowardCurrentPhase(structure));
  // Budget class (finance §2.2): pay up to the available balance; a
  // phase paid in part does NOT complete, and the shortfall is logged.
  const pay = Math.min(due, treasury);
  const shortfall = due - pay;
  const phaseComplete = pay === due;
  const newDone = phaseComplete ? done + 1 : done;
  const completes = phaseComplete && newDone >= required;
  // The Judge's-proposal flag (§4.3 convention): a phase costing more
  // than 10% of the treasury is flagged in the open, on the entry.
  const costFlag = phaseCost > 0 && phaseCost > treasury * 0.1
    ? ` Flag: this phase's cost (${phaseCost} R) exceeds 10% of ${cityId}'s treasury (${treasury} R).`
    : "";

  const plan = emptyPlan(descriptorId);
  const r05Changes: LogEntryDraft["changes"] = [];

  if (pay > 0) {
    const treasuryChange = applyTreasuryDelta(
      plan, ctx.snapshot, cityId, -pay,
      `R-05 phase ${phase} of ${required} payment toward "${name}" (phase cost ${phaseCost} R, ${paidTowardCurrentPhase(structure)} R already toward this phase)`
    );
    if (treasuryChange) r05Changes.push(treasuryChange);
  }

  // The structure record: break-ground flips planned →
  // under-construction on the owner's confirming act itself;
  // workUnitsDone moves only when the phase is fully paid.
  let after = plannedDoc(plan, ctx.snapshot, sPath) ?? { ...structure };
  const structureChangedFields: string[] = [];
  const beforeStatus = status;
  const afterStatus = completes ? "complete" : status === "planned" ? "under-construction" : status;
  if (afterStatus !== beforeStatus) {
    after = withDocField(after, "status", afterStatus);
    structureChangedFields.push("status");
    r05Changes.push(fieldChange(`structures/${structureId}.status`, beforeStatus, afterStatus, completes ? "R-05: final phase paid — the project completes inside this Resolution Event" : "R-05: break ground — planned → under-construction"));
  }
  if (newDone !== done) {
    after = withDocField(after, "workUnitsDone", newDone);
    structureChangedFields.push("workUnitsDone");
    r05Changes.push(fieldChange(`structures/${structureId}.workUnitsDone`, done, newDone, `R-05: phase ${phase} fully funded — work unit ${newDone} of ${required} done`));
  }
  if (pay > 0) {
    after = withDocField(after, "paidRubars", paid + pay);
    structureChangedFields.push("paidRubars");
    r05Changes.push(fieldChange(`structures/${structureId}.paidRubars`, paid, paid + pay, "R-05: cumulative phase payments (the audit field)"));
  }
  if (completes) {
    const beforeCondition = num(structure, "condition");
    after = withDocField(after, "condition", 100);
    structureChangedFields.push("condition");
    r05Changes.push(fieldChange(`structures/${structureId}.condition`, beforeCondition, 100, "R-05: condition is 100 on completion (§2.5) — the structure stands in function"));
  }
  if (structureChangedFields.length > 0) {
    planWrite(plan, ctx.snapshot, sPath, after, "state", structureChangedFields);
  }

  const completion = completes ? applyCompletions(plan, ctx, cityId, structureId) : null;

  const derived = recomputeDerivedCounts(
    plan, ctx.snapshot, cityId,
    completion?.firedRuleIds.includes("R-03") ?? false
  );
  r05Changes.push(...derived.changes);

  const firedRuleIds = ["R-05", ...(completion?.firedRuleIds ?? [])];
  const citiesTouched = [...new Set([cityId, ...(completion?.citiesTouched ?? [])])];
  const phaseLabel = status === "planned" ? "break ground" : "continue work";

  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: citiesTouched,
      ruleIds: ["R-05"],
      changes: r05Changes,
      recordsUpdated: [sPath, cityPath],
      summaryText:
        `R-05 ${phaseLabel}: "${name}" in ${cityId}, phase ${phase} of ${required} (cost ${phaseCost} R; paid ${pay} R this event` +
        (shortfall > 0 ? `; SHORTFALL ${shortfall} R — the phase is partially funded and does not complete (budget class, §2.4)` : "") +
        `). workUnitsDone ${done} → ${newDone} of ${required}.` +
        (completes ? ` Completion fires inside this same Resolution Event, in table order: ${completion?.firedRuleIds.join(", ") || "no completion rule matches (narrative-only completion)"}.` : "") +
        costFlag,
      major: completes,
    })
  );
  if (completion) plan.entries.push(...completion.entries);
  plan.entries.push(
    summaryDraft({
      actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: ctx.action.actionType === "start_project" ? "start-project" : "advance-project",
        scope: "city",
        ruleIds: firedRuleIds,
        unruled: false,
      },
      cityId,
      cityIds: citiesTouched,
      ruleIds: firedRuleIds,
      summaryText: completes
        ? `"${name}" completed in ${cityId} (R-05${completion && completion.firedRuleIds.length > 0 ? ` + ${completion.firedRuleIds.join(", ")}` : ""}); total paid ${paid + pay} R of ${total} R budget.`
        : `"${name}" in ${cityId}: ${phaseLabel}, phase ${phase} of ${required}${shortfall > 0 ? `, shortfall ${shortfall} R logged` : ""}.`,
      major: completes,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-16 — demolish an uninhabited structure (own city)
// ---------------------------------------------------------------------------

function demolishHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-16";
  const denied = requireAuthority(ctx, descriptorId, "R-16");
  if (denied) return denied;
  const loaded = loadStructure(ctx, descriptorId, "R-16");
  if (!("structure" in loaded)) return loaded;
  const { cityId, structureId, structure } = loaded;
  const cityPath = `sim_cities/${cityId}`;
  const sPath = structurePath(cityId, structureId);
  const name = (structure.name as string | undefined) ?? structureId;
  const missing = requireStructuresQuery(ctx, descriptorId, "R-16", cityId);
  if (missing) return missing;

  const status = structure.status as string | undefined;
  if (status !== "complete" && status !== "mothballed") {
    return rejectedPlan(
      descriptorId,
      "INVALID_STATUS",
      ["R-16"],
      `"${name}" has status ${status ?? "unset"} — R-16 demolishes a standing (complete or mothballed) structure. ${status === "ruined" ? "Clearing ruins is the R-39 proposal, not adopted in the v1 subset; a ruined record is recovered by rebuild, not by this rule." : "A planned or under-construction project is cancelled through its own flow, not demolished."}`
    );
  }

  // The precondition check, logged verbatim (v2 R-16): no resident
  // households, no staffed corporation, no staffed citizens — an
  // inhabited demolition is R-17's damaging act, NOT in the v1 subset
  // (brief P4-D2), so this handler refuses and redirects.
  const residents = strList(structure.residentHouseholdIds);
  const staffFigures = strList(structure.staffFigureIds);
  const staffCorporations = strList(structure.staffCorporationIds);
  const checkText = `precondition check: residentHouseholds=${residents.length}, staffFigures=${staffFigures.length}, staffCorporations=${staffCorporations.length}`;
  if (residents.length > 0 || staffFigures.length > 0 || staffCorporations.length > 0) {
    return rejectedPlan(
      descriptorId,
      "INHABITED_REDIRECT_R17",
      ["R-16"],
      `"${name}" is inhabited or staffed (${checkText}) — demolition here is R-17's damaging act with its displacement safeguards, which is not in the Phase 4 v1 subset (P4-D2); it resolves under the §4.6 fallback with the damaging-act warning, never under R-16.`
    );
  }

  const params = sa(ctx.action);
  const rawCost = params.demolitionCostRubars;
  const cost = typeof rawCost === "number" && Number.isFinite(rawCost) ? Math.round(rawCost) : 0;
  if (cost < 0) {
    return rejectedPlan(descriptorId, "MALFORMED_COST", ["R-16"], "demolitionCostRubars may not be negative.");
  }
  const city = snapshotDoc(ctx.snapshot, cityPath) ?? {};
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  if (cost > treasury) {
    return rejectedPlan(
      descriptorId,
      "INSUFFICIENT_TREASURY",
      ["R-16"],
      `Demolition of "${name}" costs ${cost} R; ${cityId}'s treasury holds ${treasury} R. The demolition does not proceed unfunded — rejected and logged.`
    );
  }

  const plan = emptyPlan(descriptorId);
  const changes: LogEntryDraft["changes"] = [];
  const notes: string[] = [];
  if (cost > 0) {
    const treasuryChange = applyTreasuryDelta(plan, ctx.snapshot, cityId, -cost, `R-16 demolition cost for "${name}" (recorded in the action)`);
    if (treasuryChange) changes.push(treasuryChange);
  }
  const current = plannedDoc(plan, ctx.snapshot, sPath) ?? structure;
  planWrite(plan, ctx.snapshot, sPath, withDocField(current, "status", "demolished"), "state", ["status"]);
  changes.push(fieldChange(`structures/${structureId}.status`, status, "demolished", "R-16: structure demolished (record retained; the completion rule's index gains are NOT clawed back — history happened)"));
  const infra = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "infrastructure", -1, "R-16: infrastructure −1 (the built fabric shrinks)"), notes);
  if (infra) changes.push(infra);
  const derived = recomputeDerivedCounts(plan, ctx.snapshot, cityId, false);
  changes.push(...derived.changes);

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-16"],
      changes,
      recordsUpdated: [sPath, cityPath],
      summaryText:
        `R-16: "${name}" demolished in ${cityId} (${checkText} — uninhabited, check passed and logged). Demolition cost ${cost} R; infrastructure −1; banked completion gains stand.` +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "demolish-structure", scope: "city", ruleIds: ["R-16"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-16"],
      summaryText: `Demolished "${name}" in ${cityId} (uninhabited; cost ${cost} R). The record remains as history; the building is gone.`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-19 — mothball a structure (explicit neglect)
// ---------------------------------------------------------------------------

function mothballHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-19";
  const denied = requireAuthority(ctx, descriptorId, "R-19");
  if (denied) return denied;
  const loaded = loadStructure(ctx, descriptorId, "R-19");
  if (!("structure" in loaded)) return loaded;
  const { cityId, structureId, structure } = loaded;
  const cityPath = `sim_cities/${cityId}`;
  const sPath = structurePath(cityId, structureId);
  const name = (structure.name as string | undefined) ?? structureId;
  const missing = requireStructuresQuery(ctx, descriptorId, "R-19", cityId);
  if (missing) return missing;

  const status = structure.status as string | undefined;
  if (status !== "complete") {
    return rejectedPlan(
      descriptorId,
      "INVALID_STATUS",
      ["R-19"],
      `"${name}" has status ${status ?? "unset"} — only a standing (complete) structure can be mothballed.`
    );
  }

  const params = sa(ctx.action);
  const residents = strList(structure.residentHouseholdIds);
  const confirmDisplacement = params.confirmDisplacement === true;
  if (residents.length > 0 && !confirmDisplacement) {
    return rejectedPlan(
      descriptorId,
      "INHABITED_REDIRECT_R17",
      ["R-19"],
      `"${name}" houses ${residents.length} household(s) and the proposal does not confirm the displacement branch — mothballing an inhabited structure without that confirmation is refused and redirected to R-17's flow (v2 R-19).`
    );
  }

  const plan = emptyPlan(descriptorId);
  const changes: LogEntryDraft["changes"] = [];
  const notes: string[] = [];
  const displacedIds: string[] = [];
  let displacedSize = 0;

  if (residents.length > 0 && confirmDisplacement) {
    // The confirmed branch: resident households become displaced
    // (records persist — fictional people are not deleted by fiat).
    for (const householdId of residents) {
      const hPath = householdsPath(cityId, householdId);
      const household = snapshotDoc(ctx.snapshot, hPath);
      if (!household) {
        notes.push(`resident household ${householdId} has no standing record — nothing to displace`);
        continue;
      }
      displacedIds.push(householdId);
      displacedSize += num(household, "size") ?? 0;
      planWrite(plan, ctx.snapshot, hPath, {
        ...household,
        status: "displaced",
        homeStructureId: null,
        displacedFromStructureId: structureId,
        lastResolutionId: null,
        lastChangedSeq: null,
      }, "state", ["status", "homeStructureId", "displacedFromStructureId"]);
      changes.push(fieldChange(`households/${householdId}.status`, household.status ?? null, "displaced", "R-19 confirmed displacement branch: household displaced by mothballing"));
      changes.push(fieldChange(`households/${householdId}.homeStructureId`, household.homeStructureId ?? null, null, "R-19 confirmed displacement branch: home structure vacated"));
    }
    const current = plannedDoc(plan, ctx.snapshot, sPath) ?? structure;
    planWrite(plan, ctx.snapshot, sPath, withDocField(current, "residentHouseholdIds", []), "state", ["residentHouseholdIds"]);
    changes.push(fieldChange(`structures/${structureId}.residentHouseholdIds`, residents, [], "R-19: residents displaced under the confirmed branch"));
    const population = num(plannedDoc(plan, ctx.snapshot, cityPath), "stats.population");
    if (population !== null && displacedSize > 0) {
      const cityNow = plannedDoc(plan, ctx.snapshot, cityPath) ?? {};
      planWrite(plan, ctx.snapshot, cityPath, withDocField(cityNow, "stats.population", Math.max(0, population - displacedSize)), "state", ["stats.population"]);
      changes.push(fieldChange("stats.population", population, Math.max(0, population - displacedSize), "R-19 displacement: population -= displaced persons (population is set)"));
    }
  }

  const standing = plannedDoc(plan, ctx.snapshot, sPath) ?? structure;
  planWrite(plan, ctx.snapshot, sPath, withDocField(standing, "status", "mothballed"), "state", ["status"]);
  changes.push(fieldChange(`structures/${structureId}.status`, "complete", "mothballed", "R-19: structure mothballed by its owner's explicit act (neglect exists only as a chosen act)"));
  const spirit = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "spirit", -1, "R-19: spirit −1 (a shuttered landmark is a visible sadness, once)"), notes);
  if (spirit) changes.push(spirit);
  const derived = recomputeDerivedCounts(plan, ctx.snapshot, cityId, false);
  changes.push(...derived.changes);

  const branch = residents.length === 0 ? "empty" : "inhabited-confirmed";
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-19"],
      changes,
      recordsUpdated: [sPath, cityPath],
      summaryText:
        `R-19: "${name}" mothballed in ${cityId} (branch: ${branch}${displacedIds.length > 0 ? `; displaced households: ${displacedIds.join(", ")}` : ""}). spirit −1; completion index contributions are NOT removed; housing units leave housingUnits by recompute while mothballed. Reactivation is an R-05 advance on this same record.` +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "mothball-structure", scope: "city", ruleIds: ["R-19"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-19"],
      summaryText: `Mothballed "${name}" in ${cityId} (branch: ${branch}).`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-24 — maintain / repair a structure
// ---------------------------------------------------------------------------

function repairHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-24";
  const denied = requireAuthority(ctx, descriptorId, "R-24");
  if (denied) return denied;
  const loaded = loadStructure(ctx, descriptorId, "R-24");
  if (!("structure" in loaded)) return loaded;
  const { cityId, structureId, structure } = loaded;
  const cityPath = `sim_cities/${cityId}`;
  const sPath = structurePath(cityId, structureId);
  const name = (structure.name as string | undefined) ?? structureId;
  const missing = requireStructuresQuery(ctx, descriptorId, "R-24", cityId);
  if (missing) return missing;

  const status = structure.status as string | undefined;
  if (status === "demolished") {
    return rejectedPlan(
      descriptorId,
      "STRUCTURE_DEMOLISHED",
      ["R-24"],
      `"${name}" is demolished — destroyed things are properly gone (CJ): repair never resurrects a demolished record. Recovery is a real rebuild: a new project record advanced under R-05, with its costs and timeline.`
    );
  }
  if (status !== "complete" && status !== "ruined") {
    return rejectedPlan(
      descriptorId,
      "INVALID_STATUS",
      ["R-24"],
      `"${name}" has status ${status ?? "unset"} — R-24 maintains a standing or ruined structure. ${status === "mothballed" ? "A mothballed structure is reactivated by an R-05 advance first; it returns at the condition it was mothballed at." : ""}`
    );
  }
  const condition = num(structure, "condition") ?? (status === "ruined" ? 0 : null);
  if (condition === null) {
    return rejectedPlan(descriptorId, "MALFORMED_RECORD", ["R-24"], `"${name}" stands complete with no condition recorded — the record is malformed for R-24 (condition is set at completion, §2.5).`);
  }
  if (status === "complete" && condition >= 100) {
    return rejectedPlan(descriptorId, "NOTHING_TO_REPAIR", ["R-24"], `"${name}" is at condition 100 — R-24 triggers only on a structure with condition < 100.`);
  }

  // Cost: the repair cost recorded in the proposal, scaled by
  // (100 − condition); the basis falls back to the structure's own
  // recorded build budget (design §7.2 pricing).
  const params = sa(ctx.action);
  const basis =
    typeof params.repairCostRubars === "number" && Number.isFinite(params.repairCostRubars)
      ? Math.round(params.repairCostRubars)
      : num(structure, "totalBudgetRubars");
  if (basis === null || basis < 0) {
    return rejectedPlan(
      descriptorId,
      "COST_BASIS_MISSING",
      ["R-24"],
      `No repair cost basis for "${name}": the action records no repairCostRubars and the structure carries no totalBudgetRubars. The engine prices nothing by invention.`
    );
  }
  const charge = Math.round((basis * (100 - condition)) / 100);
  const city = snapshotDoc(ctx.snapshot, cityPath) ?? {};
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  if (charge > treasury) {
    return rejectedPlan(
      descriptorId,
      "INSUFFICIENT_TREASURY",
      ["R-24"],
      `Repairing "${name}" costs ${charge} R (basis ${basis} R scaled by ${100 - condition}% damage); ${cityId}'s treasury holds ${treasury} R. Repair is binary in v2 (condition := 100 or nothing) — a part-paid repair restores nothing, so the action rejects and logs rather than stranding a partial payment.`
    );
  }

  const wasRuined = status === "ruined";
  const outageReason = functionStateReason(structure);
  const plan = emptyPlan(descriptorId);
  const changes: LogEntryDraft["changes"] = [];
  const notes: string[] = [];
  if (charge > 0) {
    const treasuryChange = applyTreasuryDelta(plan, ctx.snapshot, cityId, -charge, `R-24 repair cost for "${name}": round(${basis} × ${100 - condition}/100) = ${charge}`);
    if (treasuryChange) changes.push(treasuryChange);
  }
  const current = plannedDoc(plan, ctx.snapshot, sPath) ?? structure;
  let after = withDocField(current, "condition", 100);
  const changedFields = ["condition"];
  changes.push(fieldChange(`structures/${structureId}.condition`, condition, 100, "R-24: condition := 100 (full repair — v2 keeps this binary and legible)"));
  if (wasRuined) {
    after = withDocField(after, "status", "complete");
    after = withDocField(after, "rebuiltAtResolutionId", ctx.resolutionId);
    changedFields.push("status", "rebuiltAtResolutionId");
    changes.push(fieldChange(`structures/${structureId}.status`, "ruined", "complete", "R-24: a ruined structure restored by repair returns to complete; its function resumes (§2.5)"));
  }
  planWrite(plan, ctx.snapshot, sPath, after, "state", changedFields);
  if (wasRuined) {
    const infra = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "infrastructure", 2, "R-24: infrastructure +2 (rebuilding is an achievement)"), notes);
    if (infra) changes.push(infra);
  }
  const derived = recomputeDerivedCounts(plan, ctx.snapshot, cityId, false);
  changes.push(...derived.changes);

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-24"],
      changes,
      recordsUpdated: [sPath, cityPath],
      summaryText:
        `R-24: "${name}" repaired in ${cityId} — condition ${condition} → 100, cost ${charge} R. Function was stopped (${outageReason}) and now resumes: function is derived from status/condition, and the record carries no stored function flag to flip. ${wasRuined ? "The structure was ruined: status returns to complete and the city gains infrastructure +2." : ""}` +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "repair-structure", scope: "city", ruleIds: ["R-24"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-24"],
      summaryText: `Repaired "${name}" in ${cityId} to condition 100 (cost ${charge} R)${wasRuined ? "; ruined → complete" : ""}.`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Descriptors — registered by the Build Lead's single assembly edit.
// R-01–R-04 and R-38 classify no action kinds of their own: they fire
// inside R-05's completing Resolution Event (the R-33/R-34 posture).
// ---------------------------------------------------------------------------

/** Finance §2.4 descriptor additions for this catalogue: R-05 phase
 * payments are budget class (finance §2.2 names them explicitly). The
 * Lead merges these alongside the descriptors when the registry's
 * descriptor type gains the finance fields. */
export const STRUCTURE_FINANCE_ADDITIONS = {
  "R-05": { shortfallClass: "budget", ledgersTouched: ["treasury"], invokesRules: [] },
} as const;

export const STRUCTURE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-05": {
    id: "R-05",
    actionKinds: ["start_project", "advance_project"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { start_project: advanceProjectHandler, advance_project: advanceProjectHandler },
    readPlan: projectReadPlan,
    summary: "Start or advance a project: phase costs treasury-paid under §2.4 budget-class discipline (a part-paid phase does not complete; shortfalls logged); completion rules R-01–R-04/R-38 fire inside the completing Resolution Event in table order; an advance on a mothballed record is its reactivation (R-19).",
  },
  "R-01": {
    id: "R-01",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Completion of a civic/cultural structure (kind or supports per design §7.1), fired inside R-05: culture +2, infrastructure +1, gdp +0.2%, prestige from profile; shrine/memorial function naming another city spills culture +1 there.",
  },
  "R-02": {
    id: "R-02",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Completion of a commercial/industrial structure (kind or supports economy), fired inside R-05: gdp +0.6%/+0.9% by branch, founding dividend round(0.5% of GDP) to treasury, infrastructure +1 (industrial), supplier-city gdp +0.2% spillover.",
  },
  "R-03": {
    id: "R-03",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Completion of a housing structure (kind or supports housing, units > 0), fired inside R-05: households form by the completion action itself (named/created/queued, immigration zero-sum), population moves where set, spirit +1 on the housedRatio crossing to >= 1.",
  },
  "R-04": {
    id: "R-04",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Completion of a transport/infrastructure structure, fired inside R-05: infrastructure +3, gdp +0.3%; each named endpoint city gets infrastructure +1 and the standing connection record (connection:<cityId>:live traits on both city docs).",
  },
  "R-38": {
    id: "R-38",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Completion of a military structure, fired inside R-05: the index named by profile.supports (military and/or defense) +2 per branch, prestige from profile. A military profile naming neither branch is rejected at the R-05 touchpoint — the engine never guesses.",
  },
  "R-16": {
    id: "R-16",
    actionKinds: ["demolish_structure"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { demolish_structure: demolishHandler },
    readPlan: structuresOnlyReadPlan,
    summary: "Demolish an uninhabited structure (own city): status → demolished, infrastructure −1, demolition cost paid; completion gains are not clawed back. Inhabited/staffed structures refuse with a redirect to R-17 (not in the v1 subset, P4-D2).",
  },
  "R-19": {
    id: "R-19",
    actionKinds: ["mothball_structure"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { mothball_structure: mothballHandler },
    readPlan: mothballReadPlan,
    summary: "Mothball a structure (explicit neglect): status → mothballed, spirit −1, housing units leave housingUnits by recompute; inhabited mothballing displaces only under the owner-confirmed branch, otherwise refuses toward R-17. Reactivation is an R-05 advance.",
  },
  "R-24": {
    id: "R-24",
    actionKinds: ["repair_structure"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { repair_structure: repairHandler },
    readPlan: structuresOnlyReadPlan,
    summary: "Maintain/repair a structure with condition < 100: condition := 100 at the proposal cost scaled by (100 − condition); a ruined structure returns to complete with infrastructure +2 and its function resumes (derived, never a stored flag). Demolished records are never repaired — recovery is a real rebuild.",
  },
};
