/**
 * Catalogue I — laws & the governor's money levers (Phase 4 brief
 * §4.2 + step 5; finance-system-design §2.3/§2.4/§5.1).
 *
 * R-08 (pass a law/decree, own city) with finance's F-08 tax-policy
 * vocabulary riding inside it — a tax schedule is law-shaped data,
 * set by the governor's unilateral act; there is no council inside a
 * member's city (CJ ruling), and there is no separate tax-policy
 * write path (F-08 as written in the finance design). R-09 (repeal)
 * marks the record `repealed` — never deleted — and never undoes
 * passage effects retroactively. The F-09/F-10/F-11 handlers
 * (budget authorizations, service-contract payments, payroll) ride
 * in this file per the brief's step 5.
 *
 * The tax schedule is DERIVED from in-force law records, never stored
 * (§5.1): `deriveTaxScheduleFromLaws` is the one derivation, used by
 * the F-08 schedule-delta print, by F-11 withholding, and (when it
 * lands) by Catalogue II's F-06 assessment. `null` component = unset
 * = not assessed, logged as skipped — there is no hidden default rate
 * and no component inherits from another.
 *
 * Handler discipline is the landed Phase 2/Step 0 discipline (see
 * structures.ts header): pure handlers, planned-doc composition
 * (F-02), rejection plans for domain refusals, budget-class partial
 * funding with logged shortfalls for F-10/F-11 (finance §2.2), and
 * no money movement without a Log line.
 *
 * Not registered in `registry.ts` — the Build Lead's assembly edit
 * registers LAW_DESCRIPTORS and merges LAW_FINANCE_ADDITIONS (the
 * finance §2.4 descriptor additions the landed RuleDescriptor type
 * does not yet carry).
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
import { corporationPath } from "../corporations";
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — see structures.ts header note)
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
  planWrite(plan, snapshot, path, withDocField(current, `stats.${stat}`, after), "state", [`stats.${stat}`]);
  return { applied: true, change: fieldChange(`stats.${stat}`, before, after, formula) };
}

function applyCountDelta(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  field: string,
  delta: number,
  formula: string
): StatOutcome {
  const path = `sim_cities/${cityId}`;
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return { applied: false, note: `skipped: no city record for ${cityId}` };
  const before = num(current, field);
  if (before === null) {
    return { applied: false, note: `skipped: ${field} unset (null)` };
  }
  const after = Math.max(0, before + delta);
  planWrite(plan, snapshot, path, withDocField(current, field, after), "state", [field]);
  return { applied: true, change: fieldChange(field, before, after, formula) };
}

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

function outcomeNote(outcome: StatOutcome, notes: string[]): LogEntryDraft["changes"][number] | null {
  if (outcome.applied) return outcome.change;
  notes.push(outcome.note);
  return null;
}

// ---------------------------------------------------------------------------
// The law record + the R-08 effect vocabulary (systems-spec-v2 R-08:
// the Judge applies ONLY effects expressible in the rule table's
// vocabulary, verbatim, once; anything else is narrative-only text).
// ---------------------------------------------------------------------------

export function lawPath(cityId: string, lawId: string): string {
  return `sim_cities/${cityId}/laws/${lawId}`;
}

export function budgetPath(cityId: string, budgetId: string): string {
  return `sim_cities/${cityId}/budgets/${budgetId}`;
}

export interface LawEffectItem {
  field: string;
  operation: string;
  value: unknown;
  condition?: unknown;
  scope?: unknown;
}

/** The eight allocatable indices — delta-expressible, clamped [0,100],
 * skipped-and-logged while unset (null). */
export const LAW_INDEX_STATS: readonly string[] = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "military",
  "defense",
];

/** Finance §5.1 schedule components, set through the F-08 vocabulary
 * inside an R-08 law's structuredEffects. Basis points, integers
 * 0–10000; `null` = unset = not assessed. No component defaults from
 * another. */
export const TAX_COMPONENT_FIELDS: Record<string, "operatingReceiptsBps" | "payrollWithholdingBps" | "contractPaymentsBps"> = {
  "tax.operatingReceiptsBps": "operatingReceiptsBps",
  "tax.payrollWithholdingBps": "payrollWithholdingBps",
  "tax.contractPaymentsBps": "contractPaymentsBps",
};

export interface TaxSchedule {
  operatingReceiptsBps: number | null;
  payrollWithholdingBps: number | null;
  contractPaymentsBps: number | null;
  /** The in-force laws the schedule derives from, in application
   * order — the citation F-06 entries carry ({ lawIds[], asOfSeq }). */
  lawIds: string[];
}

const EMPTY_SCHEDULE: TaxSchedule = {
  operatingReceiptsBps: null,
  payrollWithholdingBps: null,
  contractPaymentsBps: null,
  lawIds: [],
};

type TaxComponent = "operatingReceiptsBps" | "payrollWithholdingBps" | "contractPaymentsBps";

function taxItemsOf(law: Record<string, unknown>): { component: TaxComponent; value: number | null }[] {
  const items: { component: TaxComponent; value: number | null }[] = [];
  const effects = Array.isArray(law.structuredEffects) ? law.structuredEffects : [];
  for (const raw of effects) {
    const item = (raw ?? {}) as LawEffectItem;
    const component = TAX_COMPONENT_FIELDS[item.field];
    if (!component || item.operation !== "set") continue;
    if (item.value === null) items.push({ component, value: null });
    else if (typeof item.value === "number" && Number.isInteger(item.value) && item.value >= 0 && item.value <= 10000) {
      items.push({ component, value: item.value });
    }
  }
  return items;
}

/** The §5.1 derivation: a city's current schedule from its in-force
 * laws. Later laws (by sourceSeq, then lawId for determinism) win per
 * component; a repealed law contributes nothing — repeal changes the
 * schedule from the repealing event forward, never retroactively. */
export function deriveTaxScheduleFromLaws(
  lawDocs: readonly (Record<string, unknown> | null)[]
): TaxSchedule {
  const inForce = lawDocs.filter(
    (doc): doc is Record<string, unknown> => doc !== null && doc.status === "in-force"
  );
  const ordered = [...inForce].sort((a, b) => {
    const seqA = typeof a.sourceSeq === "number" ? a.sourceSeq : 0;
    const seqB = typeof b.sourceSeq === "number" ? b.sourceSeq : 0;
    if (seqA !== seqB) return seqA - seqB;
    return String(a.lawId ?? "").localeCompare(String(b.lawId ?? ""));
  });
  const schedule: TaxSchedule = { ...EMPTY_SCHEDULE, lawIds: [] };
  for (const law of ordered) {
    const items = taxItemsOf(law);
    if (items.length === 0) continue;
    schedule.lawIds.push(typeof law.lawId === "string" ? law.lawId : "");
    for (const item of items) {
      schedule[item.component] = item.value;
    }
  }
  return schedule;
}

export function formatSchedule(schedule: TaxSchedule): string {
  const fmt = (value: number | null) => (value === null ? "unset" : `${value} bps`);
  return `operatingReceipts ${fmt(schedule.operatingReceiptsBps)}, payrollWithholding ${fmt(schedule.payrollWithholdingBps)}, contractPayments ${fmt(schedule.contractPaymentsBps)}`;
}

// ---------------------------------------------------------------------------
// Read plans (F-01)
// ---------------------------------------------------------------------------

const LAWS_QUERY_ID = "cat1-laws";

function lawsQuery(cityId: string): CollectionQuerySpec {
  return { id: LAWS_QUERY_ID, collectionPath: `sim_cities/${cityId}/laws`, filters: [] };
}

function lawDocsFromSnapshot(
  snapshot: SimSnapshot,
  cityId: string
): (Record<string, unknown> | null)[] | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === LAWS_QUERY_ID && q.spec.collectionPath === `sim_cities/${cityId}/laws`
  );
  if (!record) return null;
  return record.resultPaths.map((path) => snapshotDoc(snapshot, path));
}

function actionLawId(action: SimAction): string {
  const params = sa(action);
  if (typeof params.lawId === "string" && params.lawId) return params.lawId;
  return `law_${action.actionId}`;
}

function passLawReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const cityId =
    (typeof sa(seeds.action).cityId === "string" ? (sa(seeds.action).cityId as string) : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  if (!cityId) return {};
  const paths: string[] = [lawPath(cityId, actionLawId(seeds.action))];
  for (const other of strList(sa(seeds.action).affectedCityIds)) {
    if (other !== cityId) paths.push(`sim_cities/${other}`);
  }
  return { paths, queries: [lawsQuery(cityId)] };
}

function repealLawReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const cityId =
    (typeof sa(seeds.action).cityId === "string" ? (sa(seeds.action).cityId as string) : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  if (!cityId) return {};
  return { paths: [lawPath(cityId, actionLawId(seeds.action))], queries: [lawsQuery(cityId)] };
}

// ---------------------------------------------------------------------------
// R-08 — pass a law / decree (own city), with the F-08 vocabulary.
// `set_tax_policy` is the same handler restricted to a law carrying
// at least one tax-vocabulary item (F-08 as written: no separate
// tax-policy write path exists).
// ---------------------------------------------------------------------------

interface PartitionedEffects {
  statEffects: { item: LawEffectItem; kind: "index" | "count" | "gdpPercent"; stat: string }[];
  taxItems: LawEffectItem[];
  narrativeOnly: LawEffectItem[];
}

function partitionEffects(items: LawEffectItem[]): PartitionedEffects {
  const out: PartitionedEffects = { statEffects: [], taxItems: [], narrativeOnly: [] };
  for (const item of items) {
    if (TAX_COMPONENT_FIELDS[item.field] !== undefined) {
      const valid =
        item.operation === "set" &&
        (item.value === null ||
          (typeof item.value === "number" && Number.isInteger(item.value) && item.value >= 0 && item.value <= 10000));
      if (valid) out.taxItems.push(item);
      else out.narrativeOnly.push(item);
      continue;
    }
    const statMatch = /^stats\.([A-Za-z]+)$/.exec(item.field) ?? /^([a-z]+)$/.exec(item.field);
    const stat = statMatch?.[1] ?? "";
    if (LAW_INDEX_STATS.includes(stat) && item.operation === "delta" && typeof item.value === "number" && Number.isInteger(item.value)) {
      out.statEffects.push({ item, kind: "index", stat });
      continue;
    }
    if ((stat === "treasuryRubars" || stat === "population") && item.operation === "delta" && typeof item.value === "number" && Number.isInteger(item.value)) {
      out.statEffects.push({ item, kind: "count", stat });
      continue;
    }
    if (stat === "gdpRubars" && item.operation === "percent" && typeof item.value === "number" && Number.isFinite(item.value)) {
      out.statEffects.push({ item, kind: "gdpPercent", stat });
      continue;
    }
    // households/housingUnits are derived-stored record counts — a
    // law cannot delta them into existence; GDP moves only by
    // percentage in the table's vocabulary. Everything else the
    // author wrote is narrative-only text, recorded verbatim.
    out.narrativeOnly.push(item);
  }
  return out;
}

function passLaw(ctx: HandlerContext, mode: "law" | "tax-policy"): ResolutionPlan {
  const descriptorId = "R-08";
  const denied = requireAuthority(ctx, descriptorId, "R-08");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", ["R-08"], `City ${cityId} does not stand.`);
  const lawId = actionLawId(ctx.action);
  const path = lawPath(cityId, lawId);
  if (snapshotDoc(ctx.snapshot, path)) {
    return rejectedPlan(
      descriptorId,
      "LAW_EXISTS",
      ["R-08"],
      `Law ${lawId} already stands in ${cityId}'s library — laws are amended by passing a new law (a new record), never by mutating the standing one.`
    );
  }
  const existingLaws = lawDocsFromSnapshot(ctx.snapshot, cityId);
  if (!existingLaws) {
    return rejectedPlan(descriptorId, "READ_PLAN_MISSING", ["R-08"], "The laws collection read was not materialized into the snapshot — a handler never improvises a read outside its declared read plan (F-01).");
  }

  const rawEffects = Array.isArray(params.structuredEffects) ? params.structuredEffects : [];
  const items: LawEffectItem[] = rawEffects.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      field: typeof item.field === "string" ? item.field : "",
      operation: typeof item.operation === "string" ? item.operation : "",
      value: item.value,
      ...(item.condition !== undefined ? { condition: item.condition } : {}),
      ...(item.scope !== undefined ? { scope: item.scope } : {}),
    };
  });
  const { statEffects, taxItems, narrativeOnly } = partitionEffects(items);
  if (mode === "tax-policy" && taxItems.length === 0) {
    return rejectedPlan(
      descriptorId,
      "NO_TAX_EFFECTS",
      ["R-08"],
      "set_tax_policy carries no valid tax-vocabulary effect (tax.operatingReceiptsBps / tax.payrollWithholdingBps / tax.contractPaymentsBps, operation \"set\", integer 0–10000 or null). F-08 is an R-08 law whose structuredEffects use the tax vocabulary — there is no separate tax write path."
    );
  }

  const scheduleBefore = deriveTaxScheduleFromLaws(existingLaws);
  const affectedCityIds = strList(params.affectedCityIds).filter((id) => id !== cityId);
  const title =
    typeof params.title === "string" && params.title
      ? params.title
      : mode === "tax-policy"
        ? `Tax policy ${lawId}`
        : `Law ${lawId}`;

  const lawDoc: Record<string, unknown> = {
    schemaVersion: 2,
    lawId,
    cityId,
    title,
    text: typeof params.text === "string" ? params.text : null,
    status: "in-force",
    structuredEffects: items,
    narrativeOnlyEffects: narrativeOnly,
    affectedCityIds,
    sourceActionId: ctx.action.actionId,
    sourceSeq: null, // committer-stamped at commit (keeps plans clock-free)
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdByResolutionId: ctx.resolutionId,
  };

  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, path, lawDoc, "state", ["status", "structuredEffects"]);

  const changes: LogEntryDraft["changes"] = [];
  const notes: string[] = [];
  // Author effects, verbatim, once, in authored order.
  for (const effect of statEffects) {
    const formula = `R-08 law ${lawId} effect as authored: ${effect.item.field} ${effect.item.operation} ${String(effect.item.value)} (applied verbatim, once)`;
    if (effect.kind === "index") {
      const change = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, effect.stat, effect.item.value as number, formula), notes);
      if (change) changes.push(change);
    } else if (effect.kind === "count") {
      const change = outcomeNote(applyCountDelta(plan, ctx.snapshot, cityId, `stats.${effect.stat}`, effect.item.value as number, formula), notes);
      if (change) changes.push(change);
    } else {
      // GDP by percentage of current (§2.4), skip-and-log on null.
      const current = plannedDoc(plan, ctx.snapshot, cityPath);
      const before = num(current, "stats.gdpRubars");
      if (before === null) {
        notes.push("skipped: gdp unset (law's percentage effect)");
      } else {
        const pct = effect.item.value as number;
        const delta = Math.round((before * pct) / 100);
        planWrite(plan, ctx.snapshot, cityPath, withDocField(current ?? {}, "stats.gdpRubars", before + delta), "state", ["stats.gdpRubars"]);
        changes.push(fieldChange("stats.gdpRubars", before, before + delta, `${formula}: round(${before} × ${pct}/100) = ${delta}`));
      }
    }
  }
  // The standing effect of lawmaking itself (v2 R-08): law +2,
  // stability +1 — whether or not the law carried expressible effects.
  const lawDelta = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "law", 2, "R-08 standing effect of lawmaking: law +2"), notes);
  if (lawDelta) changes.push(lawDelta);
  const stabilityDelta = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "stability", 1, "R-08 standing effect of lawmaking: stability +1"), notes);
  if (stabilityDelta) changes.push(stabilityDelta);

  const scheduleAfter = deriveTaxScheduleFromLaws([...existingLaws, lawDoc]);
  const taxNote =
    taxItems.length > 0
      ? ` Tax schedule (F-08, derived from in-force laws): ${formatSchedule(scheduleBefore)} → ${formatSchedule(scheduleAfter)}. The change is prospective from this event's seq; facts resolved under the earlier schedule keep it.`
      : "";

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId, ...affectedCityIds],
      ruleIds: ["R-08"],
      changes,
      recordsCreated: [path],
      recordsUpdated: [cityPath],
      classification:
        taxItems.length > 0
          ? { f08TaxPolicy: true, taxScheduleBefore: { ...scheduleBefore }, taxScheduleAfter: { ...scheduleAfter }, ruleIds: ["R-08"] }
          : null,
      summaryText:
        `R-08: law "${title}" (${lawId}) entered ${cityId}'s library in force. ${statEffects.length} structured effect(s) applied verbatim; ${narrativeOnly.length} recorded narrative-only (not expressible in the table's vocabulary, never applied). Standing effect: law +2, stability +1.${taxNote}` +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );
  // Spillover posture (v2 R-08): a law regulating an inter-city matter
  // names the affected cities; each gets a notification entry — the
  // engine never applies one city's law inside another's stats.
  for (const otherCity of affectedCityIds) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: otherCity,
        cityIds: [otherCity],
        ruleIds: ["R-08"],
        changes: [],
        summaryText: `R-08 notification: ${cityId}'s law "${title}" (${lawId}) names ${otherCity} in an inter-city matter. No effect is applied here — ${otherCity} may answer with its own law, as its own action.`,
      })
    );
  }
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: mode === "tax-policy" ? "set-tax-policy" : "pass-law", scope: "city", ruleIds: ["R-08"], unruled: false },
      cityId,
      cityIds: [cityId, ...affectedCityIds],
      ruleIds: ["R-08"],
      summaryText: `${mode === "tax-policy" ? "Tax policy" : "Law"} "${title}" passed in ${cityId} (law +2, stability +1${taxItems.length > 0 ? "; tax schedule updated per F-08" : ""}).`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function passLawHandler(ctx: HandlerContext): ResolutionPlan {
  return passLaw(ctx, "law");
}

function setTaxPolicyHandler(ctx: HandlerContext): ResolutionPlan {
  return passLaw(ctx, "tax-policy");
}

// ---------------------------------------------------------------------------
// R-09 — repeal a law
// ---------------------------------------------------------------------------

function repealLawHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-09";
  const denied = requireAuthority(ctx, descriptorId, "R-09");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const lawId = actionLawId(ctx.action);
  const path = lawPath(cityId, lawId);
  const law = snapshotDoc(ctx.snapshot, path);
  if (!law) {
    return rejectedPlan(descriptorId, "NO_LAW", ["R-09"], `Law ${lawId} does not stand in ${cityId}'s library.`);
  }
  if (law.status === "repealed") {
    return rejectedPlan(descriptorId, "ALREADY_REPEALED", ["R-09"], `Law ${lawId} is already repealed — the record stands as history and is never deleted.`);
  }
  const allLaws = lawDocsFromSnapshot(ctx.snapshot, cityId);
  if (!allLaws) {
    return rejectedPlan(descriptorId, "READ_PLAN_MISSING", ["R-09"], "The laws collection read was not materialized into the snapshot (F-01).");
  }
  const hadTaxItems = taxItemsOf(law).length > 0;
  const scheduleBefore = deriveTaxScheduleFromLaws(allLaws);
  const scheduleAfter = deriveTaxScheduleFromLaws(
    allLaws.map((doc) => (doc && doc.lawId === lawId ? { ...doc, status: "repealed" } : doc))
  );

  const plan = emptyPlan(descriptorId);
  const current = plannedDoc(plan, ctx.snapshot, path) ?? law;
  planWrite(plan, ctx.snapshot, path, {
    ...current,
    status: "repealed",
    repealedByResolutionId: ctx.resolutionId,
    repealReason: typeof params.reason === "string" ? params.reason : null,
  }, "state", ["status"]);
  const changes: LogEntryDraft["changes"] = [
    fieldChange(`laws/${lawId}.status`, law.status ?? null, "repealed", "R-09: law marked repealed (never deleted — the library is history)"),
  ];
  const notes: string[] = [];
  const stability = outcomeNote(applyIndexDelta(plan, ctx.snapshot, cityId, "stability", -1, "R-09: stability −1 (change is unsettling, once); law unchanged — repealing through process is lawful"), notes);
  if (stability) changes.push(stability);

  const affectedCityIds = strList(law.affectedCityIds).filter((id) => id !== cityId);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId, ...affectedCityIds],
      ruleIds: ["R-09"],
      changes,
      recordsUpdated: [path, cityPath],
      classification: hadTaxItems
        ? { f08TaxPolicy: true, taxScheduleBefore: { ...scheduleBefore }, taxScheduleAfter: { ...scheduleAfter }, ruleIds: ["R-09"] }
        : null,
      summaryText:
        `R-09: law ${lawId} ("${(law.title as string | undefined) ?? lawId}") repealed in ${cityId}${typeof params.reason === "string" ? ` — reason as authored: ${params.reason}` : ""}. stability −1. The law's one-time passage effects are NOT retroactively undone (history happened); the record stands marked repealed.` +
        (hadTaxItems ? ` Tax schedule (derived): ${formatSchedule(scheduleBefore)} → ${formatSchedule(scheduleAfter)}, prospective from this event.` : "") +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );
  for (const otherCity of affectedCityIds) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: otherCity,
        cityIds: [otherCity],
        ruleIds: ["R-09"],
        changes: [],
        summaryText: `R-09 notification: ${cityId} repealed law ${lawId}, which had named ${otherCity} in an inter-city matter. No effect is applied here.`,
      })
    );
  }
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "repeal-law", scope: "city", ruleIds: ["R-09"], unruled: false },
      cityId,
      cityIds: [cityId, ...affectedCityIds],
      ruleIds: ["R-09"],
      summaryText: `Repealed law ${lawId} in ${cityId} (stability −1; passage effects stand as history).`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// F-09 — set a budget authorization (record-only; no movement)
// ---------------------------------------------------------------------------

function budgetReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  if (!cityId) return {};
  const paths: string[] = [];
  for (const key of ["supersedesBudgetId", "retireBudgetId"] as const) {
    if (typeof params[key] === "string") paths.push(budgetPath(cityId, params[key] as string));
  }
  return { paths };
}

function setBudgetAuthorizationHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-09";
  const denied = requireAuthority(ctx, descriptorId, "F-09");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const city = snapshotDoc(ctx.snapshot, `sim_cities/${cityId}`);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", ["F-09"], `City ${cityId} does not stand.`);

  const retireId = typeof params.retireBudgetId === "string" ? params.retireBudgetId : null;
  const supersedesId = typeof params.supersedesBudgetId === "string" ? params.supersedesBudgetId : null;
  const targetId = retireId ?? supersedesId;
  const target = targetId ? snapshotDoc(ctx.snapshot, budgetPath(cityId, targetId)) : null;
  if (targetId && !target) {
    return rejectedPlan(descriptorId, "NO_BUDGET", ["F-09"], `Budget authorization ${targetId} does not stand in ${cityId}.`);
  }
  if (target && target.status !== "in-force") {
    return rejectedPlan(descriptorId, "BUDGET_NOT_IN_FORCE", ["F-09"], `Budget authorization ${targetId} is ${String(target.status)} — only an in-force authorization can be amended or retired (amendments are new versions; nothing is mutated in place).`);
  }
  const retiring = retireId !== null;
  const category =
    typeof params.category === "string" && params.category
      ? params.category
      : (target?.category as string | undefined);
  if (!category) {
    return rejectedPlan(descriptorId, "MALFORMED_BUDGET", ["F-09"], "set_budget_authorization requires a category (an opaque tag; conventions: projects | services | payroll | events | defense).");
  }
  const cap =
    typeof params.capRubars === "number" && Number.isInteger(params.capRubars) && params.capRubars > 0
      ? params.capRubars
      : num(target, "capRubars");
  if (!retiring && cap === null) {
    return rejectedPlan(descriptorId, "MALFORMED_BUDGET", ["F-09"], "set_budget_authorization requires capRubars (integer > 0) — an authorization permits and bounds; it never spends.");
  }
  const scope =
    params.scope !== undefined
      ? params.scope
      : (target?.scope ?? { actorKinds: ["npc", "governor"] });

  const budgetId = `budget_${ctx.resolutionId}`;
  const version = target ? (num(target, "version") ?? 1) + 1 : 1;
  const doc: Record<string, unknown> = {
    schemaVersion: 2,
    budgetId,
    cityId,
    category,
    capRubars: cap,
    // Derived cache (§4.2): fabric-written, displayed, NEVER an input
    // to validation. A new version starts its own cache at 0.
    spentRubars: 0,
    scope,
    status: retiring ? "retired" : "in-force",
    version,
    supersedes: targetId,
    sourceActionId: ctx.action.actionId,
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    createdByResolutionId: ctx.resolutionId,
  };
  const path = budgetPath(cityId, budgetId);
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, path, doc, "state", ["status", "capRubars", "version"]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["F-09"],
      changes: [],
      recordsCreated: [path],
      classification: { budgetAuthorization: { budgetId, category, capRubars: cap, version, supersedes: targetId, status: doc.status }, ruleIds: ["F-09"] },
      summaryText: retiring
        ? `F-09: budget authorization for category "${category}" in ${cityId} retired (version ${version}, superseding ${targetId}). No Rubars move — authorizations permit and bound; they never spend.`
        : `F-09: budget authorization ${budgetId} written for ${cityId}: category "${category}", cap ${cap} R, version ${version}${targetId ? ` (supersedes ${targetId} — the prior version stands unmutated as history)` : ""}. No Rubars move. NPC spends check the cap as hard validation; the governor's own spends cite it as an advisory annotation.`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "set-budget-authorization", scope: "city", ruleIds: ["F-09"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["F-09"],
      summaryText: `${retiring ? "Retired" : "Set"} budget authorization (${category}, ${cap} R cap, v${version}) in ${cityId}. Record-only; no movement.`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// F-10 — government service contract payment (budget class)
// ---------------------------------------------------------------------------

function contractPayReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  const paths: string[] = [];
  if (cityId && typeof params.corporationId === "string") {
    const corpCity =
      typeof params.corporationCityId === "string" ? params.corporationCityId : cityId;
    paths.push(corporationPath(corpCity, params.corporationId));
  }
  if (cityId && typeof params.budgetId === "string") {
    paths.push(budgetPath(cityId, params.budgetId));
  }
  return { paths };
}

function serviceContractPayHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-10";
  const denied = requireAuthority(ctx, descriptorId, "F-10");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", ["F-10"], `City ${cityId} does not stand.`);

  const corporationId = typeof params.corporationId === "string" ? params.corporationId : "";
  if (!corporationId) {
    return rejectedPlan(descriptorId, "NO_CORPORATION", ["F-10"], "service_contract_pay names no corporationId.");
  }
  const corpCity = typeof params.corporationCityId === "string" ? params.corporationCityId : cityId;
  const corpPath = corporationPath(corpCity, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "NO_CORPORATION", ["F-10"], `Corporation ${corporationId} does not stand in ${corpCity}.`);
  }
  if (corp.status === "dissolved") {
    return rejectedPlan(descriptorId, "CORPORATION_DISSOLVED", ["F-10"], `Corporation ${corporationId} is dissolved — a dissolved company cannot be paid under a service contract.`);
  }
  const amount = params.amountRubars;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return rejectedPlan(descriptorId, "MALFORMED_AMOUNT", ["F-10"], "service_contract_pay requires amountRubars (positive integer).");
  }
  const serviceRef = typeof params.serviceRef === "string" ? params.serviceRef : "";
  if (!serviceRef) {
    return rejectedPlan(descriptorId, "MISSING_SERVICE_REF", ["F-10"], "service_contract_pay requires a serviceRef naming the thing bought (a structure's upkeep, a route's operation, a survey) — the payment's purpose is part of the act.");
  }

  // Budget class (finance §2.2): the payment executes up to the
  // available treasury; the unfunded remainder is logged as
  // shortfallRubars and no service effect beyond the funded part is
  // claimed. The preview states the balance and the shortfall range.
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  const pay = Math.min(amount, treasury);
  const shortfall = amount - pay;

  const plan = emptyPlan(descriptorId);
  const payerChanges: LogEntryDraft["changes"] = [];
  if (pay > 0) {
    const change = applyTreasuryDelta(plan, ctx.snapshot, cityId, -pay, `F-10 service contract payment to ${corporationId} for "${serviceRef}" (treasury → company)`);
    if (change) payerChanges.push(change);
  }
  const budgetNote = (() => {
    if (typeof params.budgetId !== "string") return "";
    const budget = snapshotDoc(ctx.snapshot, budgetPath(cityId, params.budgetId));
    if (!budget) return ` Budget authorization ${params.budgetId} was cited but does not stand — noted, not enforced (the governor's own spend cites authorizations as advisory annotations).`;
    const cap = num(budget, "capRubars") ?? 0;
    const spentCache = num(budget, "spentRubars") ?? 0;
    return ` Budget authorization ${params.budgetId} cited (category ${String(budget.category)}, cap ${cap} R, cached spent ${spentCache} R — advisory for the governor's own spend${pay > Math.max(0, cap - spentCache) ? "; this payment exceeds the authorization's remaining cap, recorded as an annotation, not a block" : ""}).`;
  })();

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [...new Set([cityId, corpCity])],
      ruleIds: ["F-10"],
      changes: payerChanges,
      recordsUpdated: [cityPath],
      classification: {
        serviceContract: { corporationId, serviceRef, amountRubars: amount, paidRubars: pay, shortfallRubars: shortfall },
        ...(typeof params.memo === "string" ? { memo: params.memo } : {}),
        ruleIds: ["F-10"],
      },
      summaryText:
        `F-10: ${cityId} pays ${pay} R to corporation ${corporationId} for "${serviceRef}" (treasury → company, budget class).` +
        (shortfall > 0 ? ` SHORTFALL: ${shortfall} R of the ${amount} R contract is unfunded and does not execute — the service act is funded only to ${pay} R.` : "") +
        budgetNote,
    })
  );

  if (pay > 0) {
    const cashBefore = num(corp, "companyCashRubars") ?? 0;
    const current = plannedDoc(plan, ctx.snapshot, corpPath) ?? corp;
    planWrite(plan, ctx.snapshot, corpPath, withDocField(current, "companyCashRubars", cashBefore + pay), "state", ["companyCashRubars"]);
    // The taxable fact (§5.2): a contract payment is F-06's business
    // in the operating city — the paying city unless the action names
    // another — when that city is one of the company's operating
    // cities. F-06 itself is Catalogue II's rule; this event records
    // the fact in full and declares the invocation.
    const operatingCity = typeof params.serviceCityId === "string" ? params.serviceCityId : cityId;
    const operatingCities = new Set([corp.homeCityId as string, ...strList(corp.marketCityIds)]);
    const factApplies = operatingCities.has(operatingCity);
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: corpCity,
        cityIds: [corpCity],
        ruleIds: ["F-10"],
        changes: [
          fieldChange(`corporations/${corporationId}.companyCashRubars`, cashBefore, cashBefore + pay, "F-10: company cash receives the contract payment (treasury → company)"),
        ],
        recordsUpdated: [corpPath],
        classification: factApplies
          ? {
              taxableFact: { kind: "contract-payment", corporationId, operatingCityId: operatingCity, payerCityId: cityId, baseAmountRubars: pay, serviceRef },
              invokesRules: ["F-06"],
              ruleIds: ["F-10"],
            }
          : {
              taxableFact: null,
              taxableFactNote: `operating city ${operatingCity} is not among ${corporationId}'s operating cities — no contract-payment fact arises for F-06`,
              ruleIds: ["F-10"],
            },
        summaryText: factApplies
          ? `F-10: ${corporationId} books ${pay} R of contract revenue; taxable fact "contract-payment" recorded (operating city ${operatingCity}, base ${pay} R) for F-06 assessment by Catalogue II's rule.`
          : `F-10: ${corporationId} books ${pay} R of contract revenue. No F-06 fact arises (operating city ${operatingCity} is not one of the company's operating cities).`,
      })
    );
  }

  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "service-contract-pay", scope: "city", ruleIds: ["F-10"], unruled: false },
      cityId,
      cityIds: [...new Set([cityId, corpCity])],
      ruleIds: ["F-10"],
      summaryText: `Service contract: ${cityId} → ${corporationId}, ${pay} R paid${shortfall > 0 ? `, ${shortfall} R shortfall logged` : ""} for "${serviceRef}".`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// F-11 — payroll run (budget class)
// ---------------------------------------------------------------------------

function payrollReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  const paths: string[] = [];
  const payerRef = (params.payerRef ?? {}) as Record<string, unknown>;
  const corporationId =
    typeof payerRef.corporationId === "string"
      ? payerRef.corporationId
      : typeof params.corporationId === "string"
        ? params.corporationId
        : null;
  if (corporationId) {
    const corpCity =
      (typeof payerRef.corporationCityId === "string" ? payerRef.corporationCityId : undefined) ??
      (typeof params.corporationCityId === "string" ? params.corporationCityId : undefined) ??
      cityId;
    if (corpCity) paths.push(corporationPath(corpCity, corporationId));
  }
  // The withholding schedule derives from the payroll city's laws.
  if (cityId) return { paths, queries: [lawsQuery(cityId)] };
  return { paths };
}

function runPayrollHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-11";
  const params = sa(ctx.action);
  const payerRef = (params.payerRef ?? {}) as Record<string, unknown>;
  const corporationId =
    typeof payerRef.corporationId === "string"
      ? payerRef.corporationId
      : typeof params.corporationId === "string"
        ? params.corporationId
        : null;
  const payerKind = corporationId ? "company" : "treasury";

  let payerCityId = "";
  let payerCorp: Record<string, unknown> | null = null;
  let payerCorpPath = "";
  if (payerKind === "company") {
    const corpCityGuess =
      (typeof payerRef.corporationCityId === "string" ? payerRef.corporationCityId : undefined) ??
      (typeof params.corporationCityId === "string" ? params.corporationCityId : undefined) ??
      actionCityId(ctx.action);
    payerCorpPath = corporationPath(corpCityGuess, corporationId as string);
    payerCorp = snapshotDoc(ctx.snapshot, payerCorpPath);
    if (!payerCorp) {
      return rejectedPlan(descriptorId, "NO_CORPORATION", ["F-11"], `Corporation ${corporationId} does not stand in ${corpCityGuess}.`);
    }
    if (payerCorp.status === "dissolved") {
      return rejectedPlan(descriptorId, "CORPORATION_DISSOLVED", ["F-11"], `Corporation ${corporationId} is dissolved — it runs no payroll.`);
    }
    // The company's owner confirms its payroll (F-11 trigger): the
    // A-7 ownerMemberId is the one ownership fact validation reads.
    const uid = ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId;
    if (!uid || uid !== payerCorp.ownerMemberId) {
      return rejectedPlan(descriptorId, "NOT_COMPANY_OWNER", ["F-11"], `Payroll for ${corporationId} is confirmed by its owner (ownerMemberId) — ${uid ?? "the actor"} is not that owner.`);
    }
    payerCityId = (payerCorp.homeCityId as string | undefined) ?? corpCityGuess;
  } else {
    const denied = requireAuthority(ctx, descriptorId, "F-11");
    if (denied) return denied;
    payerCityId =
      (typeof payerRef.cityId === "string" ? payerRef.cityId : undefined) ?? actionCityId(ctx.action);
    if (!snapshotDoc(ctx.snapshot, `sim_cities/${payerCityId}`)) {
      return rejectedPlan(descriptorId, "NO_CITY", ["F-11"], `City ${payerCityId} does not stand.`);
    }
  }

  // The city the payroll is paid in — its laws set the withholding
  // schedule (§5.1). Defaults to the payer's own city.
  const scheduleCityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ?? payerCityId;
  const lawDocs = lawDocsFromSnapshot(ctx.snapshot, scheduleCityId);
  if (!lawDocs) {
    return rejectedPlan(descriptorId, "READ_PLAN_MISSING", ["F-11"], "The laws collection read for the payroll city was not materialized into the snapshot (F-01) — withholding is never computed from an improvisation.");
  }
  const schedule = deriveTaxScheduleFromLaws(lawDocs);

  const gross = params.amountRubars;
  if (typeof gross !== "number" || !Number.isInteger(gross) || gross <= 0) {
    return rejectedPlan(descriptorId, "MALFORMED_AMOUNT", ["F-11"], "run_payroll requires amountRubars (the gross wage bill, a positive integer). v1 takes the gross as a stated amount — per-employee wage computation awaits per-slot wage records (§6.2 upgrade path).");
  }

  const available =
    payerKind === "company"
      ? (num(payerCorp, "companyCashRubars") ?? 0)
      : (num(snapshotDoc(ctx.snapshot, `sim_cities/${payerCityId}`), "stats.treasuryRubars") ?? 0);
  // Budget class: a partially paid payroll is a loud world fact.
  const paidGross = Math.min(gross, available);
  const shortfall = gross - paidGross;
  const payrollShortfall = shortfall > 0;
  const bps = schedule.payrollWithholdingBps;
  const withholding = bps === null ? 0 : Math.round((paidGross * bps) / 10000);
  const net = paidGross - withholding;
  const exteriorAccount = `exterior:households:{cityId}`.replace("{cityId}", scheduleCityId);

  const plan = emptyPlan(descriptorId);
  // Changes are bucketed by the city whose doc they describe (the
  // F-02 target-qualification convention), one entry per bucket.
  const buckets = new Map<string, { changes: LogEntryDraft["changes"]; recordsUpdated: string[] }>();
  const bucketFor = (city: string) => {
    const existing = buckets.get(city);
    if (existing) return existing;
    const created = { changes: [] as LogEntryDraft["changes"], recordsUpdated: [] as string[] };
    buckets.set(city, created);
    return created;
  };

  const payrollClassification = {
    payroll: {
      payerKind,
      payerCityId,
      scheduleCityId,
      grossRubars: gross,
      paidGrossRubars: paidGross,
      withholdingBps: bps,
      withholdingRubars: withholding,
      netRubars: net,
      exteriorAccount,
      payrollShortfall,
      shortfallRubars: shortfall,
      scheduleLawIds: schedule.lawIds,
    },
    taxableFact: { kind: "payroll", operatingCityId: scheduleCityId, baseAmountRubars: paidGross },
    ruleIds: ["F-11"],
  };

  if (paidGross > 0) {
    if (payerKind === "company") {
      const before = num(payerCorp, "companyCashRubars") ?? 0;
      const current = plannedDoc(plan, ctx.snapshot, payerCorpPath) ?? payerCorp ?? {};
      planWrite(plan, ctx.snapshot, payerCorpPath, withDocField(current, "companyCashRubars", before - paidGross), "state", ["companyCashRubars"]);
      bucketFor(payerCityId).changes.push(
        fieldChange(`corporations/${corporationId}.companyCashRubars`, before, before - paidGross, "F-11: company cash pays the gross wage bill")
      );
      bucketFor(payerCityId).recordsUpdated.push(payerCorpPath);
    } else {
      const change = applyTreasuryDelta(plan, ctx.snapshot, payerCityId, -paidGross, "F-11: city treasury pays the gross civic wage bill");
      if (change) {
        bucketFor(payerCityId).changes.push(change);
        bucketFor(payerCityId).recordsUpdated.push(`sim_cities/${payerCityId}`);
      }
    }
    if (withholding > 0) {
      // The withholding line lands in the schedule city's treasury —
      // composed against the planned doc, so a civic payroll in its
      // own city nets correctly on the one doc.
      const change = applyTreasuryDelta(plan, ctx.snapshot, scheduleCityId, withholding, `F-11: payroll withholding at ${bps} bps under ${scheduleCityId}'s schedule (laws: ${schedule.lawIds.join(", ") || "none"}) — payer → treasury(${scheduleCityId})`);
      if (change) {
        bucketFor(scheduleCityId).changes.push(change);
        bucketFor(scheduleCityId).recordsUpdated.push(`sim_cities/${scheduleCityId}`);
      }
    }
  }

  const withholdingNote =
    bps === null
      ? ` Withholding: skipped — ${scheduleCityId}'s schedule sets no payrollWithholding component (unset means not assessed, §5.1).`
      : ` Withholding ${withholding} R at ${bps} bps under ${scheduleCityId}'s schedule.`;
  const bucketCities = [...buckets.keys()];
  if (bucketCities.length === 0) bucketCities.push(payerCityId);
  bucketCities.forEach((city, index) => {
    const bucket = buckets.get(city) ?? { changes: [], recordsUpdated: [] };
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: city,
        cityIds: bucketCities,
        ruleIds: ["F-11"],
        changes: bucket.changes,
        recordsUpdated: bucket.recordsUpdated,
        classification: index === 0 ? payrollClassification : null,
        summaryText:
          index === 0
            ? `F-11 payroll: gross ${gross} R, paid ${paidGross} R by ${payerKind === "company" ? `company ${corporationId}` : `${payerCityId} treasury`}; net ${net} R to ${exteriorAccount} (an Exterior accounting line — the Log is its record; no sim doc is written for it).${withholdingNote}` +
              (payrollShortfall ? ` payrollShortfall: true — ${shortfall} R of wages UNPAID (budget class). Unpaid workers are a consequence with a paper trail.` : "")
            : `F-11 payroll (withholding leg): ${withholding} R into ${city}'s treasury under its payroll schedule.`,
      })
    );
  });
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "run-payroll", scope: "city", ruleIds: ["F-11"], unruled: false },
      cityId: payerCityId,
      cityIds: bucketCities,
      ruleIds: ["F-11"],
      summaryText: `Payroll run: gross ${gross} R, withholding ${withholding} R, net ${net} R to households of ${scheduleCityId}${payrollShortfall ? `; SHORTFALL ${shortfall} R unpaid (payrollShortfall)` : ""}.`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Descriptors + the finance §2.4 additions (Lead assembly merges both)
// ---------------------------------------------------------------------------

export interface FinanceDescriptorAdditions {
  shortfallClass: "transfer" | "budget" | "none";
  ledgersTouched: string[];
  invokesRules: string[];
}

export type LawRuleDescriptor = RuleDescriptor & {
  finance?: FinanceDescriptorAdditions;
};

export const LAW_FINANCE_ADDITIONS: Record<string, FinanceDescriptorAdditions> = {
  // F-08 has no descriptor of its own — it rides R-08 (its handler is
  // R-08's set_tax_policy kind); the additions record its class here
  // so the Lead can carry them onto the assembled R-08 descriptor.
  "F-08": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "F-09": { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
  "F-10": { shortfallClass: "budget", ledgersTouched: ["treasury", "company"], invokesRules: ["F-06"] },
  "F-11": { shortfallClass: "budget", ledgersTouched: ["treasury", "company", "exterior"], invokesRules: ["F-06"] },
};

export const LAW_DESCRIPTORS: Record<string, LawRuleDescriptor> = {
  "R-08": {
    id: "R-08",
    actionKinds: ["pass_law", "set_tax_policy"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { pass_law: passLawHandler, set_tax_policy: setTaxPolicyHandler },
    readPlan: passLawReadPlan,
    finance: LAW_FINANCE_ADDITIONS["F-08"],
    summary: "Pass a law/decree (own city): the law enters the library in force; structured effects expressible in the table's vocabulary apply verbatim, once; the rest is narrative-only text. Standing effect: law +2, stability +1. set_tax_policy is this same act carrying the F-08 tax vocabulary — the schedule derives from in-force laws, prospectively, never retroactively.",
  },
  "R-09": {
    id: "R-09",
    actionKinds: ["repeal_law"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { repeal_law: repealLawHandler },
    readPlan: repealLawReadPlan,
    summary: "Repeal a law: the record is marked repealed (never deleted), stability −1, law unchanged; passage effects are not retroactively undone. A repealed tax law leaves the derived schedule from this event forward.",
  },
  "F-09": {
    id: "F-09",
    actionKinds: ["set_budget_authorization"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { set_budget_authorization: setBudgetAuthorizationHandler },
    readPlan: budgetReadPlan,
    finance: LAW_FINANCE_ADDITIONS["F-09"],
    summary: "Set a budget authorization (record-only, no movement): a versioned authorization doc; amendments and retirements are new versions superseding the old, never mutations. NPC spends check caps as hard validation; the governor's own spends cite it as an advisory annotation.",
  },
  "F-10": {
    id: "F-10",
    actionKinds: ["service_contract_pay"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { service_contract_pay: serviceContractPayHandler },
    readPlan: contractPayReadPlan,
    finance: LAW_FINANCE_ADDITIONS["F-10"],
    summary: "Government service contract payment (budget class): treasury(city) → company for a named serviceRef; partial payment executes up to the treasury with the shortfall logged. Records the contract-payment taxable fact for F-06 (Catalogue II) when the operating city is one of the company's operating cities.",
  },
  "F-11": {
    id: "F-11",
    actionKinds: ["run_payroll"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { run_payroll: runPayrollHandler },
    readPlan: payrollReadPlan,
    finance: LAW_FINANCE_ADDITIONS["F-11"],
    summary: "Payroll run (budget class): payer is a company (its owner confirms) or a city treasury (its governor confirms); withholding is computed under the payroll city's law-derived schedule and paid to that treasury; the net goes to exterior:households:{cityId} as a Log-only accounting line. Partial payment is flagged payrollShortfall in the open.",
  },
};
