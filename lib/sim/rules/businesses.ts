/**
 * Catalogue II — businesses & tax (Phase 4 step 6): R-06 (found a
 * corporation), R-07 (corporation action: Expand / Contract / Relocate /
 * Dissolve) in both the unlisted and listed branches, F-06 (assess and
 * collect business tax — a resolver step other rules invoke), and F-07
 * (pay a tax payable), over Module 0's corporation record
 * (`lib/sim/corporations.ts`), Finance's ledgers and transfer primitive
 * (`lib/finance/*`), and Catalogue I's law-derived tax schedule
 * (`deriveTaxScheduleFromLaws` in ./laws.ts).
 *
 * Governing texts: systems-spec v2 R-06/R-07 (as amended by the market
 * stat-model ruling — the unlisted text is Vera's verbatim; the listed
 * branch is market-systems-spec §§4–5 composed by P4-K18/P4-K22),
 * finance-system-design §§2.2–2.4, 3, 5 (transfer classes, the schedule,
 * the closed taxable-facts list, payables), and the Phase 4 build-prep
 * adoptions P4-K18 (listed valuation has exactly one writer — M-06,
 * invoked inside the event; this module writes coded inputs only),
 * P4-K21 (treasury-sourced paid-in capital suspended in Phase 4;
 * share conservation) and P4-K22 (a listed Contract's cash leg routes
 * through M-08/M-09 — never a bare company -> owner line).
 *
 * The Build Lead registers BUSINESS_DESCRIPTORS into RULE_DESCRIPTORS
 * and folds BUSINESS_FINANCE_ADDITIONS onto them (finance §2.4) — the
 * single assembly edit; this file never edits the registry. Like the
 * Finance and Catalogue I families it keeps local copies of the small
 * shared helpers (planHelpers.ts is the shared home; per-family copies
 * of `sa` / field readers / entry finishers are the landed convention).
 *
 * Discipline (inherited from Finance, binding here):
 *  - Read plans derive only from the action's own seeds (actor +
 *    structuredAction fields); citations are never the sole source of
 *    a money, tax, or authority read (Step 0).
 *  - Every money movement composes through applyTransferLines, so every
 *    event this module produces is conservation-checkable under the
 *    finance checker's grammar unchanged — including the dotted
 *    per-city payables spelling (corporations/<id>.taxPayables.<cityId>)
 *    its Log/writeSet bijection resolves.
 *  - Authority reads stored records: `ownerMemberId` is the one
 *    ownership fact validation may read (A-7); `founderFigureId` is a
 *    lore link and is never consulted. City governance reads go through
 *    checkCityAuthority.
 *  - A judgment (the listed branch's opening multiplier) is read ONLY
 *    from the worker-prepared payload bound at preview (ctx.prepared).
 *    The action's structuredAction is never read for a judgment: the
 *    AI-as-market judges; members never supply the judgment of their
 *    own company.
 *  - Rejection codes are kebab-case (the finance-family convention,
 *    ratified at PR #29).
 *  - GDP-percentage effects follow §2.4 exactly: `gdp += round(gdp ×
 *    pct/100)` on the CURRENT figure; a `null` GDP skips the effect
 *    and the Log notes `skipped: gdp unset` — the engine never invents
 *    a GDP figure, a tax figure, or a valuation.
 *
 * Step-boundary honesty (prep report flags F1/F3/F5): the M-01/M-02
 * issuance ledger, M-06 repricing, M-08/M-09, and M-10 belong to the
 * Market slice (step 7). This module composes the record effects
 * R-06's own text specifies for a founding that bundles listing, writes
 * only coded inputs for listed ripenings and declares the M-06
 * invocation, and refuses — fail-closed, in the open — the two acts
 * whose lawful execution needs step 7's records (a listed Contract
 * cash leg; a listed Dissolve). F-06 lands as a descriptor plus the
 * exported composer below; Catalogue I's F-10 records its taxable fact
 * and declares the invocation, and wiring that invocation into the
 * F-10 event is Lead assembly (this module may not edit laws.ts).
 */

import {
  actorMemberId,
  cityPath,
  composeLazyOpen,
  householdsScope,
  memberAccountPath,
} from "../../finance/accounts";
import {
  applyTransferLines,
  groupChangesByEntryCity,
  spendableSurface,
  type TaggedChange,
  type TransferLine,
} from "../../finance/transfer";
import { buildCorporationDoc, corporationPath } from "../corporations";
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
  type SimSnapshot,
} from "../state";
import { clampNumber } from "./arithmetic";
import { deriveTaxScheduleFromLaws, type TaxSchedule } from "./laws";
import { isStructureFunctioning } from "./structures";
import {
  fieldChange,
  planMutate,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import {
  checkCityAuthority,
  type DescriptorReadPlan,
  type FinanceDescriptorAdditions,
  type HandlerContext,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — the family convention)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

function stringField(action: SimAction, field: string): string | null {
  const value = sa(action)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveAmount(action: SimAction, field = "amountRubars"): number | null {
  const value = sa(action)[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function actorCitations(plan: ResolutionPlan, ctx: HandlerContext): void {
  const citations = ctx.citations;
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${ctx.resolutionId}`);
}

/** NPC actors reject across the module: an NPC acts under a mandate,
 * and mandate fields are Phase 5 machinery (the Finance posture,
 * carried verbatim). The rejection names the deferral rather than
 * pretending the act resolved. */
function rejectNpc(ctx: HandlerContext, descriptorId: string): ResolutionPlan | null {
  if (ctx.action.actor.type !== "npc") return null;
  return rejectedPlan(
    descriptorId,
    "npc-mandates-deferred",
    [descriptorId],
    `${descriptorId}: NPC actors resolve under Phase 5 mandate machinery, which has not landed; a member must confirm this act in Phase 4.`
  );
}

function finishPlan(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    ruleId: string;
    verb: string;
    scope: string;
    cityId: string | null;
    cityIds?: string[];
    summaryText: string;
    major?: boolean;
    extraClassification?: Record<string, unknown>;
  }
): ResolutionPlan {
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: args.verb,
        scope: args.scope,
        cityId: args.cityId,
        ruleIds: [args.ruleId],
        unruled: false,
        ...(args.extraClassification ?? {}),
      },
      cityId: args.cityId,
      cityIds: args.cityIds ?? (args.cityId ? [args.cityId] : []),
      ruleIds: [args.ruleId],
      summaryText: args.summaryText,
      major: args.major ?? false,
    })
  );
  actorCitations(plan, ctx);
  return plan;
}

function pushMovementEntries(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  ruleId: string,
  tagged: TaggedChange[],
  summaryFor: (entryCityId: string | null) => string,
  records?: { created?: string[]; updated?: string[] }
): void {
  const grouped = groupChangesByEntryCity(tagged);
  let first = true;
  for (const [entryCityId, changes] of grouped) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: entryCityId,
        cityIds: entryCityId ? [entryCityId] : [],
        ruleIds: [ruleId],
        changes,
        recordsCreated: first ? (records?.created ?? []) : [],
        recordsUpdated: first ? (records?.updated ?? []) : [],
        summaryText: summaryFor(entryCityId),
      })
    );
    first = false;
  }
}

function companyRef(
  cityId: string,
  corporationId: string
): { kind: "company"; corporationId: string; cityId: string } {
  return { kind: "company", corporationId, cityId };
}

/** The corporation doc an action names, read from its home city's
 * subcollection — the record's path IS the home-city fact (P4-G6:
 * owner member, home city, and operating city are three separate
 * facts; the home city comes from the action's record-location field,
 * the owner from the record, the operating city from the fact). */
function readCorporation(
  ctx: HandlerContext,
  homeCityId: string,
  corporationId: string
): Record<string, unknown> | null {
  return snapshotDoc(ctx.snapshot, corporationPath(homeCityId, corporationId));
}

// ---------------------------------------------------------------------------
// City-stat helpers (§2.4 discipline; local copies of the Catalogue I
// shapes so the skip notes read identically across families)
// ---------------------------------------------------------------------------

type StatOutcome =
  | { applied: true; change: LogEntryDraft["changes"][number] }
  | { applied: false; note: string };

function outcomeNote(outcome: StatOutcome, notes: string[]): LogEntryDraft["changes"][number] | null {
  if (outcome.applied) return outcome.change;
  notes.push(outcome.note);
  return null;
}

/** A GDP percentage effect (§2.4): `gdp += round(gdp × pct/100)` on the
 * current figure, composed against the PLANNED city doc. A null GDP
 * skips the effect — the caller logs the note verbatim. */
function applyGdpPercent(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  pct: number,
  formula: string
): StatOutcome {
  const path = cityPath(cityId);
  const current = plannedDoc(plan, snapshot, path);
  if (!current) return { applied: false, note: `skipped: no city record for ${cityId}` };
  const before = num(current, "stats.gdpRubars");
  if (before === null) return { applied: false, note: "skipped: gdp unset" };
  const delta = Math.round((before * pct) / 100);
  const after = before + delta;
  planWrite(plan, snapshot, path, withDocField(current, "stats.gdpRubars", after), "state", ["stats.gdpRubars"]);
  return {
    applied: true,
    change: fieldChange("stats.gdpRubars", before, after, `${formula}: gdp += round(${before} × ${pct}/100) = ${delta}`),
  };
}

/** An index delta (0–100 clamped; Vera's step text). An unset index
 * skips — the engine never invents an index value. */
function applyIndexDelta(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  cityId: string,
  stat: string,
  delta: number,
  formula: string
): StatOutcome {
  const path = cityPath(cityId);
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

// ---------------------------------------------------------------------------
// Laws access for the tax schedule (the Catalogue I query pattern, under
// this family's own query id: invoking descriptors declare the operating
// city's laws query in their read plans — the F-01 contract)
// ---------------------------------------------------------------------------

const LAWS_QUERY_ID = "cat2-laws";
const STRUCTURES_QUERY_ID = "cat2-structures";

/** The laws read any F-06-invoking descriptor must declare for each
 * city a fact can name (exported for the Lead's F-10 wiring — flag
 * F5): the composer reads the operating city's schedule from this
 * query's materialization, or from the same docs in the snapshot's
 * doc map when another family's query already materialized them. */
export function businessLawsQuery(cityId: string): CollectionQuerySpec {
  return { id: LAWS_QUERY_ID, collectionPath: `sim_cities/${cityId}/laws`, filters: [] };
}

function structuresQuery(cityId: string): CollectionQuerySpec {
  return { id: STRUCTURES_QUERY_ID, collectionPath: `sim_cities/${cityId}/structures`, filters: [] };
}

function lawDocsFromSnapshot(
  snapshot: SimSnapshot,
  cityId: string
): (Record<string, unknown> | null)[] | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === LAWS_QUERY_ID && q.spec.collectionPath === `sim_cities/${cityId}/laws`
  );
  if (record) return record.resultPaths.map((path) => snapshotDoc(snapshot, path));
  // Fallback for snapshots that materialized the docs without a query
  // record: enumerate the collection prefix in the doc map. An empty
  // result here is NOT evidence of an empty law set — the caller
  // distinguishes "no read was materialized" via this null.
  const prefix = `sim_cities/${cityId}/laws/`;
  const paths = [...snapshot.docs.keys()].filter(
    (key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/")
  );
  if (paths.length === 0) return null;
  return paths.sort().map((path) => snapshotDoc(snapshot, path));
}

function structureDocsFromSnapshot(
  snapshot: SimSnapshot,
  cityId: string
): (Record<string, unknown> | null)[] {
  const record = snapshot.queries.find(
    (q) => q.spec.id === STRUCTURES_QUERY_ID && q.spec.collectionPath === `sim_cities/${cityId}/structures`
  );
  if (record) return record.resultPaths.map((path) => snapshotDoc(snapshot, path));
  const prefix = `sim_cities/${cityId}/structures/`;
  return [...snapshot.docs.keys()]
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .sort()
    .map((path) => snapshotDoc(snapshot, path));
}

// ---------------------------------------------------------------------------
// F-06 — assess and collect business tax (finance §2.3 F-06, §5).
//
// A RESOLVER STEP, not a submitted action: the descriptor carries no
// action kinds. Rules that resolve a taxable fact compose
// composeTaxAssessment into their own event; the composer writes the
// collection + payable and pushes the F-06 entries onto the caller's
// plan, returning the figures for the caller's summary/classification.
//
// The closed v1 fact list (§5.2) maps to schedule components:
//   operating-credit  -> operatingReceiptsBps  (base: the credit)
//   contract-payment  -> contractPaymentsBps   (base: the F-10 payment)
//   payroll           -> payrollWithholdingBps (base: the gross bill)
// Capital movements (F-03 funding, M-08 distributions, paid-in capital)
// are NOT taxable facts and never reach this composer.
// ---------------------------------------------------------------------------

export type TaxableFactKind = "operating-credit" | "contract-payment" | "payroll";

export interface TaxableFact {
  kind: TaxableFactKind;
  corporationId: string;
  /** Where the corporation record stands (its home city's
   * subcollection) — a record-location fact, not the tax fact. */
  homeCityId: string;
  /** The city whose schedule governs and whose treasury is paid: the
   * city the fact arises in (per-rule attribution; the published
   * fallback is the home city). */
  operatingCityId: string;
  baseAmountRubars: number;
}

const TAX_COMPONENT: Record<TaxableFactKind, "operatingReceiptsBps" | "contractPaymentsBps" | "payrollWithholdingBps"> = {
  "operating-credit": "operatingReceiptsBps",
  "contract-payment": "contractPaymentsBps",
  payroll: "payrollWithholdingBps",
};

export interface TaxAssessmentOutcome {
  status: "assessed" | "skipped-unset" | "unreadable";
  assessedRubars: number;
  collectedRubars: number;
  /** The increase in the operating city's payable (0 when the
   * assessment collected in full). */
  payableDeltaRubars: number;
  /** The corporation's total payable to the operating city after this
   * assessment. */
  payableAfterRubars: number;
  rateBps: number | null;
  lawIds: string[];
  /** The skip/unreadable note, verbatim for the caller's Log. */
  note: string | null;
}

const unreadable = (note: string): TaxAssessmentOutcome => ({
  status: "unreadable",
  assessedRubars: 0,
  collectedRubars: 0,
  payableDeltaRubars: 0,
  payableAfterRubars: 0,
  rateBps: null,
  lawIds: [],
  note,
});

export function composeTaxAssessment(args: {
  plan: ResolutionPlan;
  snapshot: SimSnapshot;
  actor: SimActor;
  citingRuleId: string;
  fact: TaxableFact;
}): TaxAssessmentOutcome {
  const { plan, snapshot, actor, fact } = args;
  const citingRuleId = args.citingRuleId;
  const corpPath = corporationPath(fact.homeCityId, fact.corporationId);
  const corp = plannedDoc(plan, snapshot, corpPath);
  if (!corp) {
    return unreadable(`F-06: no corporation record at ${corpPath} — the taxable fact names a company that does not stand.`);
  }
  if (!Number.isInteger(fact.baseAmountRubars) || fact.baseAmountRubars <= 0) {
    return unreadable(`F-06: the ${fact.kind} fact's base amount (${fact.baseAmountRubars}) is not a positive integer — no assessment is composed over a malformed fact.`);
  }
  const lawDocs = lawDocsFromSnapshot(snapshot, fact.operatingCityId);
  if (lawDocs === null) {
    return unreadable(
      `F-06: the laws of ${fact.operatingCityId} were not materialized into this snapshot — the invoking descriptor's read plan must declare the operating city's laws query (cat2-laws). No assessment is composed over an unread schedule; an unread schedule is never reported as an unset one.`
    );
  }
  const schedule: TaxSchedule = deriveTaxScheduleFromLaws(
    lawDocs.filter((d): d is Record<string, unknown> => d !== null)
  );
  const component = TAX_COMPONENT[fact.kind];
  const rateBps = schedule[component];
  const asOfSeq = snapshot.counterHead.lastSeq;
  const ruleIds = [...new Set([citingRuleId, "F-06"])];

  if (rateBps === null) {
    plan.entries.push(
      ruleEffectDraft({
        actor,
        cityId: fact.homeCityId,
        cityIds: [...new Set([fact.homeCityId, fact.operatingCityId])],
        ruleIds,
        changes: [],
        recordsUpdated: [],
        classification: {
          taxableFact: { ...fact },
          assessment: { status: "skipped-unset", component, lawIds: schedule.lawIds, asOfSeq },
          invokesRules: [] as string[],
        },
        summaryText: `F-06 (cited by ${citingRuleId}): ${fact.kind} fact for ${fact.corporationId} in ${fact.operatingCityId}, base ${fact.baseAmountRubars} R — skipped: tax schedule unset (the ${component} component is named by no in-force law of ${fact.operatingCityId}); nothing is assessed and nothing is forgiven — the schedule simply does not speak.`,
      })
    );
    return {
      status: "skipped-unset",
      assessedRubars: 0,
      collectedRubars: 0,
      payableDeltaRubars: 0,
      payableAfterRubars: 0,
      rateBps: null,
      lawIds: schedule.lawIds,
      note: "skipped: tax schedule unset",
    };
  }

  // Tax rounding (prep report flag F4): Math.round, the engine's
  // universal rounding — no spec text settles F-06's convention.
  const assessed = Math.round((fact.baseAmountRubars * rateBps) / 10000);
  // Collectible: the lesser of the assessment and the company's
  // SPENDABLE surface (the transfer primitive's own definition — for
  // a chartered bank that is unencumbered cash, so an assessment never
  // reaches depositor-encumbered funds; the remainder is the payable).
  const ref = companyRef(fact.homeCityId, fact.corporationId);
  const surface = spendableSurface(plannedDoc(plan, snapshot, corpPath), ref);
  const collected = Math.min(assessed, Math.max(0, surface.available ?? 0));
  const payableDelta = assessed - collected;

  let tagged: TaggedChange[] = [];
  if (collected > 0) {
    const line: TransferLine = {
      from: ref,
      to: { kind: "treasury", cityId: fact.operatingCityId },
      amountRubars: collected,
      ruleId: "F-06",
      memo: `business tax (${fact.kind}) collected for ${fact.operatingCityId}`,
    };
    const applied = applyTransferLines({ plan, snapshot, lines: [line], shortfallClass: "transfer" });
    if (!applied.ok) {
      // The line was sized against the primitive's own surface, so a
      // refusal here is a composition defect, not a world fact —
      // surface it as unreadable rather than half-assessing.
      return unreadable(`F-06: the collection line refused (${applied.code}: ${applied.message}) after sizing against the spendable surface — no assessment is composed.`);
    }
    tagged = applied.changes;
  }

  const payablesBefore = payablesOf(corp);
  const payableBeforeForCity = payablesBefore[fact.operatingCityId] ?? 0;
  const payableAfter = payableBeforeForCity + payableDelta;
  let payablesChange: LogEntryDraft["changes"][number] | null = null;
  if (payableDelta > 0) {
    planMutate(plan, snapshot, corpPath, "state", [`taxPayables.${fact.operatingCityId}`], (current) => {
      if (!current) return current;
      const next = { ...current };
      const map = { ...payablesOf(current) };
      map[fact.operatingCityId] = (map[fact.operatingCityId] ?? 0) + payableDelta;
      next.taxPayables = map;
      return next;
    });
    payablesChange = fieldChange(
      `corporations/${fact.corporationId}.taxPayables.${fact.operatingCityId}`,
      // The Log chain is literal: an absent key claims null, a standing
      // key its number (§5.3's "absent and zero never differ" is the
      // semantic reading; the chain spells the record as it stands).
      rawPayable(corp, fact.operatingCityId),
      payableAfter,
      `F-06: uncollectible remainder of the ${fact.kind} assessment becomes a recorded payable to ${fact.operatingCityId} (§5.3 — accrues nothing, forgiven never silently)`
    );
  }

  const grouped = groupChangesByEntryCity(tagged);
  const homeChanges = [...(grouped.get(fact.homeCityId) ?? [])];
  if (payablesChange) homeChanges.push(payablesChange);
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId: fact.homeCityId,
      cityIds: [...new Set([fact.homeCityId, fact.operatingCityId])],
      ruleIds,
      changes: homeChanges,
      recordsUpdated: tagged.length > 0 || payablesChange ? [corpPath] : [],
      classification: {
        taxableFact: { ...fact },
        assessment: {
          status: "assessed",
          component,
          rateBps,
          lawIds: schedule.lawIds,
          asOfSeq,
          assessedRubars: assessed,
          collectedRubars: collected,
          payableDeltaRubars: payableDelta,
          payableAfterRubars: payableAfter,
        },
        invokesRules: [] as string[],
      },
      summaryText:
        `F-06 (cited by ${citingRuleId}): ${fact.kind} fact for ${fact.corporationId} — base ${fact.baseAmountRubars} R under ${fact.operatingCityId}'s schedule (${component} ${rateBps} bps; laws ${schedule.lawIds.join(", ") || "none"}; as of seq ${asOfSeq}): assessed ${assessed} R, collected ${collected} R` +
        (payableDelta > 0
          ? `, uncollectible remainder ${payableDelta} R recorded as a payable to ${fact.operatingCityId} (payable now ${payableAfter} R — §5.3: while it stands, M-08 distributions are blocked and voluntary liquidation must pay it ahead of shareholders).`
          : " — collected in full; no payable arises."),
    })
  );
  if (fact.operatingCityId !== fact.homeCityId) {
    const hostChanges = grouped.get(fact.operatingCityId) ?? [];
    if (hostChanges.length > 0) {
      plan.entries.push(
        ruleEffectDraft({
          actor,
          cityId: fact.operatingCityId,
          cityIds: [fact.operatingCityId],
          ruleIds,
          changes: hostChanges,
          recordsUpdated: [cityPath(fact.operatingCityId)],
          summaryText: `F-06: the treasury of ${fact.operatingCityId} received ${collected} R of business tax from ${fact.corporationId} (${fact.kind} fact, assessed under its own schedule — the operating city taxes, wherever the company is at home).`,
        })
      );
    }
  }

  return {
    status: "assessed",
    assessedRubars: assessed,
    collectedRubars: collected,
    payableDeltaRubars: payableDelta,
    payableAfterRubars: payableAfter,
    rateBps,
    lawIds: schedule.lawIds,
    note: null,
  };
}

/** One city's payable as the record literally stands: the number when
 * the key is present, null when absent (the Log chain's spelling). */
function rawPayable(doc: Record<string, unknown> | null, cityId: string): number | null {
  const raw = doc?.taxPayables;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>)[cityId];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The corporation record's payables map, tolerantly read: absent or
 * malformed reads as empty (absent and zero never differ, §5.3). */
function payablesOf(doc: Record<string, unknown> | null): Record<string, number> {
  const raw = doc?.taxPayables;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// F-07 — pay_tax_arrears (transfer class; finance §2.3, §5.3).
// The company owner confirms corporationId, the record's home city, the
// creditor city (the payable's key and the treasury paid) and an
// amount. A partial payment toward a bill is permitted — the confirmed
// amount itself is the act, and it moves in full or not at all.
// ---------------------------------------------------------------------------

function payTaxArrearsHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-07";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const ownerId = actorMemberId(ctx.action.actor);
  if (!ownerId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "F-07: the actor carries no member identity.");
  }
  const corporationId = stringField(ctx.action, "corporationId");
  const homeCityId = stringField(ctx.action, "homeCityId");
  const creditorCityId = stringField(ctx.action, "cityId");
  if (!corporationId || !homeCityId || !creditorCityId) {
    return rejectedPlan(descriptorId, "malformed-payment", [descriptorId], "F-07: pay_tax_arrears requires corporationId, homeCityId (the record's home city) and cityId (the creditor city the payable is owed to).");
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-payment", [descriptorId], "F-07: amountRubars must be a positive integer.");
  }
  const corpPath = corporationPath(homeCityId, corporationId);
  const corp = readCorporation(ctx, homeCityId, corporationId);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `F-07: no corporation record at ${corpPath}.`);
  }
  if (corp.ownerMemberId !== ownerId) {
    return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `F-07: ${ownerId} is not the ownerMemberId of ${corporationId} — paying a company's tax arrears is its owner's act.`);
  }
  const payables = payablesOf(corp);
  const payableBefore = payables[creditorCityId] ?? 0;
  if (payableBefore <= 0) {
    return rejectedPlan(descriptorId, "no-such-payable", [descriptorId], `F-07: ${corporationId} carries no tax payable to ${creditorCityId} — there is no bill to pay.`);
  }
  if (amount > payableBefore) {
    return rejectedPlan(descriptorId, "exceeds-payable", [descriptorId], `F-07: the confirmed amount ${amount} R exceeds the payable to ${creditorCityId} (${payableBefore} R) — paying more than the bill is not a tax payment.`);
  }

  const plan = emptyPlan(descriptorId);
  const line: TransferLine = {
    from: companyRef(homeCityId, corporationId),
    to: { kind: "treasury", cityId: creditorCityId },
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `tax payable payment to ${creditorCityId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId],
      `F-07: payment of ${amount} R toward ${corporationId}'s payable to ${creditorCityId} refused in full (transfer class): ${applied.message} The payable stands at ${payableBefore} R, unforgiven.`
    );
  }

  const payableAfter = payableBefore - amount;
  const remainingPayables = Object.keys(payables).filter((k) => k !== creditorCityId).length;
  const allCleared = payableAfter === 0 && remainingPayables === 0;
  planMutate(plan, ctx.snapshot, corpPath, "state", [`taxPayables.${creditorCityId}`], (current) => {
    if (!current) return current;
    const next = { ...current };
    const map = { ...payablesOf(current) };
    if (payableAfter === 0) delete map[creditorCityId];
    else map[creditorCityId] = payableAfter;
    next.taxPayables = map;
    return next;
  });

  pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
    entryCityId === homeCityId
      ? `F-07: ${corporationId} paid ${amount} R toward its tax payable to ${creditorCityId}: payable ${payableBefore} R -> ${payableAfter} R${payableAfter === 0 ? " — the payable to this city is cleared and its key removed (absent and zero never differ, §5.3)" : ""}${allCleared ? "; the company's last payable is cleared, so the §5.3 blocks (M-08 distributions barred; voluntary liquidation gated) lift in this same event" : ""}.`
      : `F-07: the treasury of ${creditorCityId} received ${amount} R from ${corporationId} against its recorded tax payable (payable ${payableBefore} R -> ${payableAfter} R) — a payable credits its treasury only when cash actually moves (§5.3).`
  );
  // The payables change rides its own statement on the corporation's
  // home-city entry set: append it to the LAST entry if that entry is
  // the home city's, else push a dedicated record entry. (validatePlan
  // reconciles changes against the folded write either way.)
  const payablesChange = fieldChange(
    `corporations/${corporationId}.taxPayables.${creditorCityId}`,
    payableBefore,
    // At zero the key is removed: the chain claims null, the record's
    // literal after-state (absent and zero never differ, §5.3).
    payableAfter === 0 ? null : payableAfter,
    `F-07: payable to ${creditorCityId} reduced by the confirmed payment of ${amount} R`
  );
  const homeEntry = [...plan.entries].reverse().find((e) => e.cityId === homeCityId);
  if (homeEntry) {
    homeEntry.changes.push(payablesChange);
    if (!homeEntry.recordsUpdated.includes(corpPath)) homeEntry.recordsUpdated.push(corpPath);
  } else {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: homeCityId,
        cityIds: [homeCityId],
        ruleIds: [descriptorId],
        changes: [payablesChange],
        recordsUpdated: [corpPath],
        summaryText: `F-07: ${corporationId}'s payable to ${creditorCityId}: ${payableBefore} R -> ${payableAfter} R.`,
      })
    );
  }

  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "pay-tax-arrears",
    scope: "company",
    cityId: homeCityId,
    cityIds: [...new Set([homeCityId, creditorCityId])],
    summaryText: `Paid ${amount} R of ${corporationId}'s tax payable to ${creditorCityId} (payable ${payableBefore} R -> ${payableAfter} R), company cash to the creditor city's treasury, transfer class.${allCleared ? " All payables cleared — the §5.3 blocks lift in this same event." : ""}`,
  });
}

function payTaxArrearsReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const homeCityId = seeds.action.structuredAction?.homeCityId;
  const corporationId = seeds.action.structuredAction?.corporationId;
  const creditorCityId = seeds.action.structuredAction?.cityId;
  if (typeof homeCityId === "string" && typeof corporationId === "string") {
    paths.push(corporationPath(homeCityId, corporationId));
  }
  if (typeof creditorCityId === "string") paths.push(cityPath(creditorCityId));
  if (typeof homeCityId === "string") paths.push(cityPath(homeCityId));
  return { paths };
}

/** Reconcile entries' record claims against the plan's actual write
 * ops (the Catalogue I convention): a claim for a path the plan does
 * not write is pruned, so the Log never claims a record the event did
 * not touch. */
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
// R-06 — found a corporation (systems-spec v2 R-06, both branches).
//
// Unlisted (Vera's text verbatim): home GDP +0.4%; the corporation is
// created with valuationRubars = round(2% of city GDP) as its opening
// book value; an industry match with a completed structure in the city
// adds a separate +0.2% GDP synergy, stated separately. Percentage
// rows apply in listed order against the current figure (§2.4), so the
// book reads the GDP after the +0.4% row and before the synergy row.
// A null GDP skips every GDP-derived figure and the Log says so —
// the book is then uncomputable: legacyBookRubars null, valuation 0.
//
// Listed (the founding bundles M-01): the book assignment is SKIPPED,
// not computed and replaced; legacyBookRubars records the unlisted
// formula's result (or null) as provenance and is never an input to
// any valuation. Paid-in capital moves from the founder's personal
// account (Phase 4: personal only — P4-K21(ii)); the opening reference
// cap is round(paidIn × judgmentMultiplier) with cap-first rounding,
// the multiplier derived ONLY from the prepared payload's judgment
// scores (§4.4). Share issuance records are step 7's (flag F1).
//
// Either branch: a named second city (market/HQ2) with a confirmation
// reference in the action record takes GDP +0.2% and joins
// marketCityIds; named without one it takes no effect (flag F7).
// ---------------------------------------------------------------------------

interface JudgmentScores {
  quality: number;
  scale: number;
  importance: number;
}

/** The prepared payload's market judgment for a listing founding:
 * `ctx.prepared.classification.judgment = { quality, scale,
 * importance }`, integers in [0, 100] (§4.5). Read from nowhere else —
 * a judgment in the action itself is a fairness breach, not an input. */
function judgmentFromPrepared(ctx: HandlerContext): JudgmentScores | null {
  const classification = ctx.prepared?.classification as Record<string, unknown> | undefined;
  const judgment = classification?.judgment as Record<string, unknown> | undefined;
  if (!judgment) return null;
  const { quality, scale, importance } = judgment;
  const valid = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100;
  if (!valid(quality) || !valid(scale) || !valid(importance)) return null;
  return { quality, scale, importance };
}

function foundCorporationHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-06";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const founderId = actorMemberId(ctx.action.actor);
  if (!founderId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "R-06: the actor carries no member identity — a corporation is founded by a member.");
  }
  const cityId = stringField(ctx.action, "cityId");
  const name = stringField(ctx.action, "name");
  const industry = stringField(ctx.action, "industry");
  if (!cityId || !name || !industry) {
    return rejectedPlan(descriptorId, "malformed-founding", [descriptorId], "R-06: found_corporation requires cityId (the home city), name and industry.");
  }
  const corporationId = stringField(ctx.action, "corporationId") ?? `corp_${ctx.action.actionId}`;
  const homeCity = snapshotDoc(ctx.snapshot, cityPath(cityId));
  if (!homeCity) {
    return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `R-06: no city record for ${cityId}.`);
  }
  const corpPath = corporationPath(cityId, corporationId);
  if (snapshotDoc(ctx.snapshot, corpPath)) {
    return rejectedPlan(descriptorId, "corporation-already-exists", [descriptorId], `R-06: a corporation record already stands at ${corpPath} — a founding never overwrites a standing record.`);
  }
  const secondCityId = stringField(ctx.action, "secondCityId");
  const secondConfirmationRef = stringField(ctx.action, "secondCityConfirmationRef");
  if (secondCityId && !snapshotDoc(ctx.snapshot, cityPath(secondCityId))) {
    return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `R-06: the named second city ${secondCityId} has no city record.`);
  }
  const listAtFounding = sa(ctx.action).listAtFounding === true;

  // Listed-branch inputs are validated before any effect composes, so
  // a defective listing founding rejects whole (no half-founded shell).
  let paidInCapital = 0;
  let sharesIssued = 0;
  let judgment: JudgmentScores | null = null;
  if (listAtFounding) {
    const fundingSource = stringField(ctx.action, "fundingSource") ?? "personal";
    if (fundingSource === "treasury") {
      return rejectedPlan(descriptorId, "treasury-source-suspended", [descriptorId, "P4-K21"], "R-06: paid-in capital sourced from a city treasury is suspended in Phase 4 (P4-K21(ii)) — founding capital is the founder's personal funds in this slice.");
    }
    if (fundingSource !== "personal") {
      return rejectedPlan(descriptorId, "malformed-founding", [descriptorId], `R-06: fundingSource "${fundingSource}" is not a lawful paid-in capital source (personal is the Phase 4 source).`);
    }
    const paid = positiveAmount(ctx.action, "paidInCapitalRubars");
    const shares = positiveAmount(ctx.action, "sharesIssued");
    if (paid === null || shares === null) {
      return rejectedPlan(descriptorId, "malformed-founding", [descriptorId], "R-06: a founding that lists (listAtFounding) must state paidInCapitalRubars and sharesIssued as positive integers — the opening valuation derives from them (M-01).");
    }
    paidInCapital = paid;
    sharesIssued = shares;
    judgment = judgmentFromPrepared(ctx);
    if (!judgment) {
      return rejectedPlan(descriptorId, "judgment-required", [descriptorId], "R-06: a listing founding prices from the market's judgment (quality / scale / importance scores), which arrives only in the worker-prepared payload bound at preview. The action carries no lawful judgment — the founder never supplies the judgment of their own company — so the founding cannot resolve.");
    }
  }

  const plan = emptyPlan(descriptorId);
  const notes: string[] = [];
  const homeChanges: LogEntryDraft["changes"] = [];

  // Step 0 for the money leg (§1.4): the founder's account lazy-opens
  // before the capital line, the grant ordered first. (The capital
  // line itself composes AFTER the corporation write below, so the
  // transfer primitive folds the cash into the created record.)
  if (listAtFounding) {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: founderId, viaActionKind: "found_corporation" });
  }

  // City effects, in Vera's listed order (§2.4 sequential reading).
  const gdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, cityId, 0.4, "R-06 founding: gdp +0.4%"), notes);
  if (gdp) homeChanges.push(gdp);
  const gdpNow = num(plannedDoc(plan, ctx.snapshot, cityPath(cityId)), "stats.gdpRubars");
  const legacyBook = gdpNow === null ? null : Math.round(gdpNow * 0.02);
  if (gdpNow === null) notes.push("skipped: gdp unset — the opening book value is uncomputable and is not invented");

  // Industry synergy: a completed, functioning structure in the home
  // city whose kind is the corporation's industry, or whose profile
  // supports name it (prep report flag F6 — the deterministic match).
  const synergyStructure = structureDocsFromSnapshot(ctx.snapshot, cityId).find((doc) => {
    if (!doc || !isStructureFunctioning(doc)) return false;
    if (doc.kind === industry) return true;
    const profile = (doc.profile ?? {}) as Record<string, unknown>;
    return strList(profile.supports).includes(industry);
  });
  let synergyStructureId: string | null = null;
  if (synergyStructure) {
    synergyStructureId = typeof synergyStructure.structureId === "string" ? synergyStructure.structureId : null;
    const synergy = outcomeNote(
      applyGdpPercent(plan, ctx.snapshot, cityId, 0.2, `R-06 industry synergy (${industry} matches completed structure ${synergyStructureId ?? "?"}): gdp +0.2%`),
      notes
    );
    if (synergy) homeChanges.push(synergy);
  }

  // Valuation + branch records.
  let valuation = 0;
  let openingReferencePrice: number | null = null;
  let judgmentMultiplier: number | null = null;
  if (listAtFounding && judgment) {
    // Cap-first rounding (§4.2/A-3): multiplier =
    // 0.50 + 1.50 × (mean/100) = 0.5 + (q+s+i)/200, applied to the
    // paid-in capital as one rational so the cap rounds once.
    judgmentMultiplier = 0.5 + (judgment.quality + judgment.scale + judgment.importance) / 200;
    valuation = Math.round((paidInCapital * (100 + judgment.quality + judgment.scale + judgment.importance)) / 200);
    openingReferencePrice = Math.max(1, Math.round(valuation / sharesIssued));
  } else {
    valuation = legacyBook ?? 0;
  }

  const marketCityIds: string[] = [];
  const secondConfirmed = Boolean(secondCityId && secondConfirmationRef);
  if (secondCityId && secondConfirmed) marketCityIds.push(secondCityId);
  if (secondCityId && !secondConfirmed) {
    notes.push(`second city ${secondCityId} named without a confirmation reference — no effect there and no market listing on its page (cross-city draft rule: the other owner's confirmation is the act that makes it real)`);
  }

  // The founding entry's prospective seq (the lazy-open convention:
  // counterHead.lastSeq + 1 + the entry's index in plan order — the
  // entries standing now, plus the capital movement's one entry group
  // on the listed branch, precede it). Preview and commit allocate
  // identical seqs, so the record's sourceSeq is exact at plan time.
  const foundingEntryIndex = plan.entries.length + (listAtFounding ? 1 : 0);
  const corpDoc: Record<string, unknown> = {
    ...buildCorporationDoc({
      corporationId,
      name,
      industry,
      valuationRubars: valuation,
      legacyBookRubars: legacyBook,
      founderFigureId: stringField(ctx.action, "founderFigureId"),
      ownerMemberId: founderId,
      homeCityId: cityId,
      marketCityIds,
      sourceActionId: ctx.action.actionId,
      sourceSeq: ctx.snapshot.counterHead.lastSeq + 1 + foundingEntryIndex,
      lastResolutionId: ctx.resolutionId,
      now: new Date(ctx.snapshot.now),
    }),
    listed: listAtFounding,
    // Corporation-record deltas beyond Module 0's fields (prep report
    // §5 — the Lead folds these into the builder/type at assembly).
    paidInCapitalRubars: listAtFounding ? paidInCapital : 0,
    sharesOutstanding: listAtFounding ? sharesIssued : 0,
    openingReferencePriceRubars: openingReferencePrice,
    lastJudgment:
      listAtFounding && judgment
        ? { quality: judgment.quality, scale: judgment.scale, importance: judgment.importance, inputHash: ctx.prepared?.inputHash ?? null }
        : null,
  };
  planWrite(plan, ctx.snapshot, corpPath, corpDoc, "state", [
    "name", "industry", "status", "valuationRubars", "listed", "legacyBookRubars",
    "ownerMemberId", "homeCityId", "marketCityIds", "paidInCapitalRubars",
    "sharesOutstanding", "openingReferencePriceRubars", "lastJudgment",
  ]);

  // The listed branch's capital leg: founder personal -> company cash,
  // transfer class, composed through the primitive for validation and
  // folding (it folds the cash into the just-created record). The
  // company leg's Log change is then stated as what it is — a
  // CREATION change (before null): the record is born holding its
  // paid-in capital, exactly as an F-01 account is born holding its
  // genesis grant, and validatePlan's chain for a created doc starts
  // at null. The primitive's own company change (chained off the
  // planned doc's 0) is therefore replaced by the creation change on
  // the founding entry; the founder's debit change rides the movement
  // entries unchanged.
  let foundingCashChange: LogEntryDraft["changes"][number] | null = null;
  if (listAtFounding) {
    const line: TransferLine = {
      from: { kind: "personal", memberId: founderId },
      to: companyRef(cityId, corporationId),
      amountRubars: paidInCapital,
      ruleId: descriptorId,
      memo: `paid-in capital at founding of ${corporationId}`,
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
    if (!applied.ok) {
      return rejectedPlan(
        descriptorId,
        applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
        [descriptorId],
        `R-06: the paid-in capital of ${paidInCapital} R refused in full (transfer class): ${applied.message} No corporation is founded on unfunded capital.`
      );
    }
    const debitChanges = applied.changes.filter(
      (t) => !t.change.field.startsWith(`corporations/${corporationId}.`)
    );
    foundingCashChange = fieldChange(
      `corporations/${corporationId}.companyCashRubars`,
      null,
      paidInCapital,
      "R-06: paid-in capital held at creation — the record is born funded (the M-01 capital act, bundled into the founding)"
    );
    pushMovementEntries(plan, ctx, descriptorId, debitChanges, () =>
      `R-06: ${founderId}'s personal account committed ${paidInCapital} R of paid-in capital to ${corporationId} at its founding (the M-01 capital act, bundled into the founding).`
    );
  }

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: secondConfirmed && secondCityId ? [cityId, secondCityId] : [cityId],
      ruleIds: [descriptorId],
      changes: foundingCashChange ? [...homeChanges, foundingCashChange] : homeChanges,
      recordsCreated: [corpPath],
      recordsUpdated: [cityPath(cityId)],
      classification: {
        founding: {
          corporationId,
          industry,
          branch: listAtFounding ? "listed" : "unlisted",
          legacyBookRubars: legacyBook,
          ...(listAtFounding
            ? {
                paidInCapitalRubars: paidInCapital,
                sharesIssued,
                judgment: { ...judgment },
                judgmentMultiplier,
                openingReferenceCapRubars: valuation,
                openingReferencePriceRubars: openingReferencePrice,
                preparedInputHash: ctx.prepared?.inputHash ?? null,
              }
            : {}),
          synergyStructureId,
          secondCity: secondCityId ? { cityId: secondCityId, confirmed: secondConfirmed, confirmationRef: secondConfirmationRef } : null,
        },
        invokesRules: listAtFounding ? ["M-01", "M-06"] : [],
      },
      summaryText:
        `R-06: ${founderId} founded "${name}" (${corporationId}, ${industry}) in ${cityId} — ${listAtFounding ? "LISTED at founding" : "unlisted"}. Home GDP +0.4%${synergyStructureId ? `; industry synergy +0.2% (completed structure ${synergyStructureId}), stated separately` : ""}. ` +
        (listAtFounding
          ? `The unlisted book assignment is skipped, not computed and replaced: legacyBookRubars ${legacyBook === null ? "null (gdp unset)" : `${legacyBook} R`} stands as provenance only and is no input to valuation. Opening valuation from paid-in capital × judgment: ${paidInCapital} R × ${judgmentMultiplier} = ${valuation} R reference cap; opening reference price ${openingReferencePrice} R over ${sharesIssued} shares (M-01/M-02 issuance records and M-06 repricing are the Market module's; this founding composes the record effects R-06's text specifies).`
          : `Opening book value ${legacyBook === null ? "uncomputable (gdp unset) — valuation 0, legacyBookRubars null" : `${legacyBook} R = round(2% of GDP)`}.`) +
        (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
      major: true,
    })
  );

  if (secondCityId && secondConfirmed) {
    const spillNotes: string[] = [];
    const spillChanges: LogEntryDraft["changes"] = [];
    const spill = outcomeNote(applyGdpPercent(plan, ctx.snapshot, secondCityId, 0.2, "R-06 second-city (market/HQ2) founding effect: gdp +0.2%"), spillNotes);
    if (spill) spillChanges.push(spill);
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: secondCityId,
        cityIds: [secondCityId],
        ruleIds: [descriptorId],
        changes: spillChanges,
        recordsUpdated: [cityPath(secondCityId)],
        classification: { foundingSpillover: { corporationId, homeCityId: cityId, confirmationRef: secondConfirmationRef } },
        summaryText: `R-06 spillover: "${name}" (${corporationId}) named ${secondCityId} as its market/HQ2 city at founding, confirmed by that city's owner (confirmation ${secondConfirmationRef}) — GDP +0.2% here, and the corporation appears on both city pages.${spillNotes.length > 0 ? ` ${spillNotes.join("; ")}.` : ""}`,
      })
    );
  }

  pruneRecordClaims(plan);
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "found-corporation",
    scope: "company",
    cityId,
    cityIds: secondConfirmed && secondCityId ? [cityId, secondCityId] : [cityId],
    summaryText: `Founded "${name}" (${industry}) in ${cityId}${listAtFounding ? `, listed at founding at a ${valuation} R opening reference cap` : ` with an opening book value of ${legacyBook === null ? "0 (gdp unset)" : `${legacyBook} R`}`}${secondConfirmed && secondCityId ? `; ${secondCityId} named as market/HQ2 under its owner's confirmation` : ""}.`,
    major: true,
  });
}

function foundCorporationReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const queries: CollectionQuerySpec[] = [];
  const founderId = actorMemberId(seeds.action.actor);
  if (founderId) paths.push(memberAccountPath(founderId));
  const cityId = seeds.action.structuredAction?.cityId;
  const corporationId = seeds.action.structuredAction?.corporationId;
  if (typeof cityId === "string") {
    paths.push(cityPath(cityId));
    paths.push(corporationPath(cityId, typeof corporationId === "string" ? corporationId : `corp_${seeds.action.actionId}`));
    queries.push(structuresQuery(cityId));
  }
  const secondCityId = seeds.action.structuredAction?.secondCityId;
  if (typeof secondCityId === "string") paths.push(cityPath(secondCityId));
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// R-07 — corporation action (systems-spec v2 R-07, both branches).
// Verbs: Expand, Contract, Relocate, Dissolve — one descriptor, one
// action kind per verb.
//
// Unlisted (Vera's text verbatim): Expand valuation ×1.25 + home GDP
// +0.2% + the home treasury pays the recorded expansion budget;
// Contract ×0.8, GDP −0.2%; Relocate = home Contract + destination
// Expand at half rate + valuation ×1.1 after the move, destination
// owner confirming; Dissolve valuation -> 0, GDP −0.3%, spirit −1,
// with spirit −1 also in each third city the action record names.
//
// Listed (P4-K18): NO multiplier ever touches valuation — a ripening
// writes coded inputs only (cash, footprint, links) and declares the
// M-06 invocation for the same event; M-06 is the only valuation
// writer and lands with step 7. Expand pays the budget INTO company
// cash from the founder's personal account (P4-K21(ii): no treasury
// source in Phase 4). Contract must name input changes or reject as
// contentless. The two legs whose lawful execution needs step 7's
// records reject fail-closed (flag F3): a listed Contract's cash leg
// (P4-K22 routes it through M-08/M-09 — never a bare withdrawal) and a
// listed Dissolve (M-10's waterfall pays shareholders of record; no
// holdings records stand in the world yet).
// ---------------------------------------------------------------------------

type CorpVerb = "expand" | "contract" | "relocate" | "dissolve";

/** Fold field updates into the corporation record's planned write and
 * return the field changes for the Log. Diffs are computed against the
 * PLANNED doc (never the raw snapshot — the F-02 discipline), and only
 * fields whose value actually changes produce a change line or a
 * changed-field registration. */
function mutateCorporation(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  corpPath: string,
  corporationId: string,
  updates: Record<string, unknown>,
  formula: string
): LogEntryDraft["changes"] {
  const current = plannedDoc(plan, snapshot, corpPath);
  if (!current) return [];
  const changes: LogEntryDraft["changes"] = [];
  const changedFields: string[] = [];
  const next = { ...current };
  for (const [field, value] of Object.entries(updates)) {
    const before = current[field];
    if (JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)) {
      next[field] = value;
      changedFields.push(field);
      changes.push(fieldChange(`corporations/${corporationId}.${field}`, before ?? null, value ?? null, formula));
    }
  }
  if (changedFields.length > 0) {
    planWrite(plan, snapshot, corpPath, next, "state", changedFields);
  }
  return changes;
}

function corporationActionHandler(verb: CorpVerb) {
  return (ctx: HandlerContext): ResolutionPlan => {
    const descriptorId = "R-07";
    const npc = rejectNpc(ctx, descriptorId);
    if (npc) return npc;
    const ownerId = actorMemberId(ctx.action.actor);
    if (!ownerId) {
      return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "R-07: the actor carries no member identity.");
    }
    const corporationId = stringField(ctx.action, "corporationId");
    const homeCityId = stringField(ctx.action, "homeCityId");
    if (!corporationId || !homeCityId) {
      return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "R-07: a corporation action requires corporationId and homeCityId (the record's home city).");
    }
    const corpPath = corporationPath(homeCityId, corporationId);
    const corp = readCorporation(ctx, homeCityId, corporationId);
    if (!corp) {
      return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `R-07: no corporation record at ${corpPath}.`);
    }
    if (corp.ownerMemberId !== ownerId) {
      return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `R-07: ${ownerId} is not the ownerMemberId of ${corporationId} — a corporation's acts are its owner's.`);
    }
    if (corp.status === "dissolved") {
      return rejectedPlan(descriptorId, "company-dissolved", [descriptorId], `R-07: ${corporationId} is dissolved; no corporation action resolves on a dissolved record.`);
    }
    const listed = corp.listed === true;
    const plan = emptyPlan(descriptorId);
    const notes: string[] = [];
    const changes: LogEntryDraft["changes"] = [];
    const citiesTouched = new Set<string>([homeCityId]);
    let classification: Record<string, unknown> = {};
    let summary = "";
    let major = false;
    // Relocate only: the destination city's GDP change rides the
    // destination's own entry, not the home entry's changes.
    let destGdpChange: LogEntryDraft["changes"][number] | null = null;

    if (verb === "expand") {
      const budget = positiveAmount(ctx.action, "expansionBudgetRubars");
      if (budget === null) {
        return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "R-07 Expand: the action must record expansionBudgetRubars (a positive integer) — the budget is part of the act's stated content in both branches.");
      }
      if (!listed) {
        // Unlisted: the home treasury pays the budget, budget class.
        // The funded-gate mirrors landed R-05 exactly (flag F2): the
        // paid portion moves to the Exterior (spent on the expansion —
        // paying it into company cash would double-count against the
        // book step), and the valuation/GDP effects fire only when the
        // budget is funded in full.
        //
        // Authority: the budget is the home city's money, and a
        // corporation's owner need not govern its home city (businesses
        // are separately owned and operate across cities). Spending a
        // treasury is its governor's act — an owner who does not
        // govern the home city has no lawful payer for the unlisted
        // budget and the action rejects, naming the seam (flag F9).
        const authority = checkCityAuthority(ctx.snapshot, homeCityId, ctx.action.actor);
        if (!authority.ok) {
          return rejectedPlan(descriptorId, "not-city-governor", [descriptorId], `R-07 Expand (unlisted): the expansion budget is paid by ${homeCityId}'s treasury, and the actor does not govern that city: ${authority.reason}. A foreign-owned corporation's unlisted expansion has no lawful treasury payer in v1; the listed branch (founder-funded) is its expansion path.`);
        }
        const city = plannedDoc(plan, ctx.snapshot, cityPath(homeCityId));
        const treasury = num(city, "stats.treasuryRubars");
        if (treasury === null) {
          return rejectedPlan(descriptorId, "no-treasury-figure", [descriptorId], `R-07 Expand: ${homeCityId} carries no treasury figure — the expansion budget cannot be paid.`);
        }
        const pay = Math.min(budget, treasury);
        const shortfall = budget - pay;
        const funded = shortfall === 0;
        if (pay > 0) {
          const line: TransferLine = {
            from: { kind: "treasury", cityId: homeCityId },
            to: { kind: "exterior", scope: householdsScope(homeCityId) },
            amountRubars: pay,
            ruleId: descriptorId,
            memo: `expansion budget for ${corporationId}`,
          };
          const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "budget" });
          if (!applied.ok) {
            return rejectedPlan(descriptorId, "insufficient-funds", [descriptorId], `R-07 Expand: the budget line refused: ${applied.message}`);
          }
          pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
            entryCityId === homeCityId
              ? `R-07 Expand: ${homeCityId}'s treasury paid ${pay} R of ${corporationId}'s recorded expansion budget (${budget} R)${funded ? "" : ` — SHORTFALL ${shortfall} R logged (budget class, §2.4)`}.`
              : `R-07 Expand: ${pay} R of expansion spending entered ${homeCityId}'s resident economy (the Exterior, households scope) — the budget is spent on the expansion, not held as company cash; the unlisted branch's substance is the book step.`
          );
        }
        if (funded) {
          changes.push(
            ...mutateCorporation(plan, ctx.snapshot, corpPath, corporationId,
              { valuationRubars: Math.round((num(corp, "valuationRubars") ?? 0) * 1.25), status: "active" },
              "R-07 Expand (unlisted): valuation × 1.25, rounded")
          );
          const gdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, homeCityId, 0.2, "R-07 Expand: home gdp +0.2%"), notes);
          if (gdp) changes.push(gdp);
        } else {
          notes.push(`expansion not effected — the budget funded ${pay} R of ${budget} R (shortfall ${shortfall} R); under the budget-class funded-gate the valuation step and GDP effect do not fire on a partially funded expansion`);
        }
        classification = { corporationAction: { verb, branch: "unlisted", expansionBudgetRubars: budget, paidRubars: pay, shortfallRubars: shortfall, funded } };
        summary = funded
          ? `Expanded ${corporationId}: valuation ×1.25 to ${num(plannedDoc(plan, ctx.snapshot, corpPath), "valuationRubars")} R, home GDP +0.2%, treasury paid the ${budget} R expansion budget in full.`
          : `Expand ${corporationId} resolved partially funded: treasury paid ${pay} R of the ${budget} R budget (shortfall ${shortfall} R) and the expansion did not take effect.`;
      } else {
        // Listed: the budget is paid INTO company cash from the
        // founder's personal account, transfer class, the funding
        // source recorded distinctly. Footprint changes land as
        // records. Valuation is never touched (P4-K18).
        const fundingSource = stringField(ctx.action, "fundingSource") ?? "personal";
        if (fundingSource === "treasury") {
          return rejectedPlan(descriptorId, "treasury-source-suspended", [descriptorId, "P4-K21"], "R-07 Expand (listed): a treasury-sourced capital injection is suspended in Phase 4 (P4-K21(ii)) — the founder's personal account is the Phase 4 source.");
        }
        if (fundingSource !== "personal") {
          return rejectedPlan(descriptorId, "malformed-action", [descriptorId], `R-07 Expand (listed): fundingSource "${fundingSource}" is not lawful (personal is the Phase 4 source).`);
        }
        const addMarketCityIds = strList(sa(ctx.action).addMarketCityIds);
        for (const marketCityId of addMarketCityIds) {
          if (!snapshotDoc(ctx.snapshot, cityPath(marketCityId))) {
            return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `R-07 Expand (listed): the named market city ${marketCityId} has no city record.`);
          }
          citiesTouched.add(marketCityId);
        }
        const addLinkedStructureIds = strList(sa(ctx.action).addLinkedStructureIds);
        if (addLinkedStructureIds.length > 0) {
          const standing = new Set(
            structureDocsFromSnapshot(ctx.snapshot, homeCityId)
              .map((d) => (typeof d?.structureId === "string" ? d.structureId : null))
              .filter((x): x is string => x !== null)
          );
          for (const structureId of addLinkedStructureIds) {
            if (!standing.has(structureId)) {
              return rejectedPlan(descriptorId, "structure-not-found", [descriptorId], `R-07 Expand (listed): structure ${structureId} does not stand in ${homeCityId} — a footprint link must name a real record.`);
            }
          }
        }
        composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: ownerId, viaActionKind: "expand_corporation" });
        const line: TransferLine = {
          from: { kind: "personal", memberId: ownerId },
          to: companyRef(homeCityId, corporationId),
          amountRubars: budget,
          ruleId: descriptorId,
          memo: `expansion capital injection into ${corporationId}`,
        };
        const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
        if (!applied.ok) {
          return rejectedPlan(
            descriptorId,
            applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
            [descriptorId],
            `R-07 Expand (listed): the capital injection of ${budget} R refused in full (transfer class): ${applied.message}`
          );
        }
        pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
          entryCityId === null
            ? `R-07 Expand (listed): ${ownerId}'s personal account injected ${budget} R into ${corporationId} (funding source: founder's personal account, recorded distinctly).`
            : `R-07 Expand (listed): ${corporationId}'s company cash received ${budget} R of expansion capital. No multiplier touches valuation in the listed branch — the injection is a coded M-06 input.`
        );
        const marketAfter = [...new Set([...strList(corp.marketCityIds), ...addMarketCityIds])].filter((c) => c !== homeCityId);
        const linksAfter = [...new Set([...strList(corp.linkedStructureIds), ...addLinkedStructureIds])];
        changes.push(
          ...mutateCorporation(plan, ctx.snapshot, corpPath, corporationId,
            { marketCityIds: marketAfter, linkedStructureIds: linksAfter, status: "active" },
            "R-07 Expand (listed): footprint input changes — market cities and structure links land as records for M-06")
        );
        const gdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, homeCityId, 0.2, "R-07 Expand: home gdp +0.2%"), notes);
        if (gdp) changes.push(gdp);
        classification = {
          corporationAction: { verb, branch: "listed", expansionBudgetRubars: budget, fundingSource, addMarketCityIds, addLinkedStructureIds },
          invokesRules: ["M-06"],
        };
        summary = `Expanded ${corporationId} (listed): ${budget} R paid into company cash from the founder's personal account; footprint inputs landed (market cities ${marketAfter.join(", ") || "unchanged"}; structure links ${linksAfter.length}); home GDP +0.2%. Valuation untouched — M-06 repricing is invoked inside this event (Market module, step 7) and derives value from these coded inputs alone.`;
      }
    }

    if (verb === "contract") {
      const exitMarketCityIds = strList(sa(ctx.action).exitMarketCityIds);
      const unlinkStructureIds = [
        ...strList(sa(ctx.action).unlinkStructureIds),
        ...strList(sa(ctx.action).mothballStructureIds),
      ];
      const withdrawal = positiveAmount(ctx.action, "cashWithdrawalRubars");
      const hasInputs = exitMarketCityIds.length > 0 || unlinkStructureIds.length > 0 || withdrawal !== null;
      if (listed && !hasInputs) {
        return rejectedPlan(descriptorId, "contentless-contract", [descriptorId], "R-07 Contract (listed): the action names no input change — no market-city exit, no structure unlink/mothball, no recorded cash withdrawal. A listed Contract's mechanical content IS its input changes; a contract naming none is contentless and is rejected and logged as such.");
      }
      if (listed && withdrawal !== null) {
        return rejectedPlan(descriptorId, "cash-leg-requires-market-module", [descriptorId, "M-08", "M-09"], `R-07 Contract (listed): the named cash withdrawal of ${withdrawal} R is a cash leg, and a listed Contract's cash leg routes through M-08 (pro-rata distribution to shareholders of record) or M-09 (buyback) under P4-K22 — never a bare company -> owner line. Those rules land with the Market module (step 7); until they do, the action rejects whole rather than severing one leg of a confirmed act. Re-submit without the cash leg to land the input changes now.`);
      }
      for (const exitCityId of exitMarketCityIds) {
        if (!strList(corp.marketCityIds).includes(exitCityId)) {
          return rejectedPlan(descriptorId, "not-a-market-city", [descriptorId], `R-07 Contract: ${exitCityId} is not among ${corporationId}'s market cities — an exit must name a market the company actually operates in.`);
        }
        citiesTouched.add(exitCityId);
      }
      for (const structureId of unlinkStructureIds) {
        if (!strList(corp.linkedStructureIds).includes(structureId)) {
          return rejectedPlan(descriptorId, "structure-not-linked", [descriptorId], `R-07 Contract: structure ${structureId} is not linked to ${corporationId} — an unlink must name a linked structure.`);
        }
      }
      if (!listed && withdrawal !== null) {
        notes.push(`a cash withdrawal of ${withdrawal} R was named on an unlisted Contract — it has no mechanical content in Vera's table (the unlisted verb's content is its multiplier and GDP effect) and no cash moved`);
      }
      const marketAfter = strList(corp.marketCityIds).filter((c) => !exitMarketCityIds.includes(c));
      const linksAfter = strList(corp.linkedStructureIds).filter((s) => !unlinkStructureIds.includes(s));
      const updates: Record<string, unknown> = { marketCityIds: marketAfter, linkedStructureIds: linksAfter, status: "contracted" };
      if (!listed) updates.valuationRubars = Math.round((num(corp, "valuationRubars") ?? 0) * 0.8);
      changes.push(
        ...mutateCorporation(plan, ctx.snapshot, corpPath, corporationId, updates,
          listed
            ? "R-07 Contract (listed): input changes land as records; valuation is never written in the listed branch"
            : "R-07 Contract (unlisted): valuation × 0.8, rounded")
      );
      const gdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, homeCityId, -0.2, "R-07 Contract: home gdp −0.2%"), notes);
      if (gdp) changes.push(gdp);
      classification = {
        corporationAction: { verb, branch: listed ? "listed" : "unlisted", exitMarketCityIds, unlinkStructureIds, cashWithdrawalRubars: withdrawal },
        ...(listed ? { invokesRules: ["M-06"] } : {}),
      };
      summary = listed
        ? `Contracted ${corporationId} (listed) on named input changes: exited markets [${exitMarketCityIds.join(", ") || "none"}], unlinked structures [${unlinkStructureIds.join(", ") || "none"}]; home GDP −0.2%. Valuation untouched — M-06 repricing is invoked inside this event (Market module, step 7).`
        : `Contracted ${corporationId}: valuation ×0.8 to ${num(plannedDoc(plan, ctx.snapshot, corpPath), "valuationRubars")} R, home GDP −0.2%${exitMarketCityIds.length + unlinkStructureIds.length > 0 ? "; the named footprint changes landed as records" : ""}.`;
    }

    if (verb === "relocate") {
      const destinationCityId = stringField(ctx.action, "destinationCityId");
      const confirmationRef = stringField(ctx.action, "destinationConfirmationRef");
      if (!destinationCityId) {
        return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "R-07 Relocate: the action requires destinationCityId.");
      }
      if (destinationCityId === homeCityId) {
        return rejectedPlan(descriptorId, "already-home", [descriptorId], `R-07 Relocate: ${corporationId} is already at home in ${homeCityId}.`);
      }
      if (!snapshotDoc(ctx.snapshot, cityPath(destinationCityId))) {
        return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `R-07 Relocate: no city record for the destination ${destinationCityId}.`);
      }
      if (!confirmationRef) {
        return rejectedPlan(descriptorId, "destination-unconfirmed", [descriptorId], "R-07 Relocate: the destination city's owner must confirm (cross-city draft rule) — the action record carries no destinationConfirmationRef, so the move does not resolve.");
      }
      const newCorpPath = corporationPath(destinationCityId, corporationId);
      if (snapshotDoc(ctx.snapshot, newCorpPath)) {
        return rejectedPlan(descriptorId, "corporation-already-exists", [descriptorId], `R-07 Relocate: a corporation record already stands at ${newCorpPath}.`);
      }
      citiesTouched.add(destinationCityId);
      // City effects: home takes Contract's GDP effect; the
      // destination takes Expand's at half rate (+0.1%).
      const homeGdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, homeCityId, -0.2, "R-07 Relocate: home (departing) gdp −0.2% — the Contract effect"), notes);
      if (homeGdp) changes.push(homeGdp);
      destGdpChange = outcomeNote(applyGdpPercent(plan, ctx.snapshot, destinationCityId, 0.1, "R-07 Relocate: destination gdp +0.1% — the Expand effect at half rate"), notes);
      // The record move: the corporation doc leaves the old home's
      // subcollection and stands in the destination's. Structures do
      // not move — links to old-home structures clear (logged); cash,
      // payables and (listed) share figures travel with the record.
      const keepOldHomeAsMarket = sa(ctx.action).keepOldHomeAsMarket === true;
      const marketAfter = strList(corp.marketCityIds).filter((c) => c !== destinationCityId);
      if (keepOldHomeAsMarket && !marketAfter.includes(homeCityId)) marketAfter.push(homeCityId);
      const movedDoc: Record<string, unknown> = {
        ...corp,
        homeCityId: destinationCityId,
        status: "relocated",
        marketCityIds: marketAfter,
        linkedStructureIds: [],
        valuationRubars: listed ? corp.valuationRubars : Math.round((num(corp, "valuationRubars") ?? 0) * 1.1),
        lastResolutionId: ctx.resolutionId,
      };
      planWrite(plan, ctx.snapshot, corpPath, null, "state", ["homeCityId", "status"]);
      planWrite(plan, ctx.snapshot, newCorpPath, movedDoc, "state", ["homeCityId", "status", "marketCityIds", "linkedStructureIds", ...(listed ? [] : ["valuationRubars"])]);
      classification = {
        corporationAction: { verb, branch: listed ? "listed" : "unlisted", fromCityId: homeCityId, toCityId: destinationCityId, confirmationRef, keepOldHomeAsMarket },
        ...(listed ? { invokesRules: ["M-06"] } : {}),
      };
      summary = `Relocated ${corporationId} from ${homeCityId} to ${destinationCityId} (destination owner confirmation ${confirmationRef}): home GDP −0.2%, destination GDP +0.1% (Expand at half rate)${listed ? "; valuation untouched in the listed branch — M-06 repricing is invoked inside this event (step 7)" : `; valuation ×1.1 after the move to ${movedDoc.valuationRubars} R`}. Structure links in ${homeCityId} cleared — buildings do not move; market cities now [${marketAfter.join(", ") || "none"}].`;
      major = true;
    }

    if (verb === "dissolve") {
      if (listed) {
        return rejectedPlan(descriptorId, "liquidation-requires-market-module", [descriptorId, "M-10"], "R-07 Dissolve (listed): a listed dissolution resolves as M-10 liquidation — the waterfall pays taxes/fees payable and adjudicated amounts ahead of shareholders of record, pro-rata, uncapped. The Market module (step 7) owns that waterfall and the holdings records it pays against; neither stands in the world yet. The dissolution rejects whole rather than half-liquidating (never the unlisted ×0 book path on a listed company).");
      }
      const affectedCityIds = strList(sa(ctx.action).affectedCityIds).filter((c) => c !== homeCityId);
      changes.push(
        ...mutateCorporation(plan, ctx.snapshot, corpPath, corporationId,
          { valuationRubars: 0, status: "dissolved" },
          "R-07 Dissolve (unlisted): valuation -> 0")
      );
      const gdp = outcomeNote(applyGdpPercent(plan, ctx.snapshot, homeCityId, -0.3, "R-07 Dissolve: home gdp −0.3%"), notes);
      if (gdp) changes.push(gdp);
      const spirit = outcomeNote(applyIndexDelta(plan, ctx.snapshot, homeCityId, "spirit", -1, "R-07 Dissolve: home spirit −1"), notes);
      if (spirit) changes.push(spirit);
      classification = { corporationAction: { verb, branch: "unlisted", affectedCityIds } };
      summary = `Dissolved ${corporationId}: valuation -> 0, home GDP −0.3%, home spirit −1${affectedCityIds.length > 0 ? `; spirit −1 also in each named third city [${affectedCityIds.join(", ")}] where the corporation held structures/staff` : ""}.`;
      major = true;
      // Third-city spirit effects ride their own spillover entries.
      for (const thirdCityId of affectedCityIds) {
        citiesTouched.add(thirdCityId);
        const thirdNotes: string[] = [];
        const thirdChanges: LogEntryDraft["changes"] = [];
        const thirdSpirit = outcomeNote(applyIndexDelta(plan, ctx.snapshot, thirdCityId, "spirit", -1, "R-07 Dissolve spillover: spirit −1 in a city where the dissolved corporation held structures/staff"), thirdNotes);
        if (thirdSpirit) thirdChanges.push(thirdSpirit);
        plan.entries.push(
          ruleEffectDraft({
            actor: ctx.action.actor,
            cityId: thirdCityId,
            cityIds: [thirdCityId],
            ruleIds: [descriptorId],
            changes: thirdChanges,
            recordsUpdated: [cityPath(thirdCityId)],
            summaryText: `R-07 Dissolve spillover: ${corporationId} (home ${homeCityId}) named ${thirdCityId} as a city where it held structures/staff — spirit −1 here on its dissolution.${thirdNotes.length > 0 ? ` ${thirdNotes.join("; ")}.` : ""}`,
          })
        );
      }
    }

    if (verb === "relocate") {
      const destinationCityId = stringField(ctx.action, "destinationCityId") as string;
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: homeCityId,
          cityIds: [...citiesTouched],
          ruleIds: [descriptorId],
          changes,
          recordsUpdated: [corpPath, cityPath(homeCityId)],
          classification,
          summaryText: summary + (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
          major,
        })
      );
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: destinationCityId,
          cityIds: [destinationCityId],
          ruleIds: [descriptorId],
          changes: destGdpChange ? [destGdpChange] : [],
          recordsCreated: [corporationPath(destinationCityId, corporationId)],
          recordsUpdated: [cityPath(destinationCityId)],
          summaryText: `R-07 Relocate: ${corporationId} now stands in ${destinationCityId} (its record moved from ${homeCityId}); GDP +0.1% here — the Expand effect at half rate.${notes.length > 0 ? ` ${notes.join("; ")}.` : ""}`,
        })
      );
    } else {
      plan.entries.push(
        ruleEffectDraft({
          actor: ctx.action.actor,
          cityId: homeCityId,
          cityIds: [...citiesTouched],
          ruleIds: [descriptorId],
          changes,
          recordsUpdated: [corpPath, cityPath(homeCityId)],
          classification,
          summaryText: summary + (notes.length > 0 ? ` ${notes.join("; ")}.` : ""),
          major,
        })
      );
    }

    pruneRecordClaims(plan);
    return finishPlan(plan, ctx, {
      ruleId: descriptorId,
      verb: `${verb}-corporation`,
      scope: "company",
      cityId: homeCityId,
      cityIds: [...citiesTouched],
      summaryText: summary,
      major,
    });
  };
}

function corporationActionReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const queries: CollectionQuerySpec[] = [];
  const actorId = actorMemberId(seeds.action.actor);
  if (actorId) paths.push(memberAccountPath(actorId));
  const params = seeds.action.structuredAction ?? {};
  const homeCityId = params.homeCityId;
  const corporationId = params.corporationId;
  if (typeof homeCityId === "string") {
    paths.push(cityPath(homeCityId));
    paths.push(`factions/${homeCityId}`);
    queries.push(structuresQuery(homeCityId));
    if (typeof corporationId === "string") paths.push(corporationPath(homeCityId, corporationId));
  }
  const destinationCityId = params.destinationCityId;
  if (typeof destinationCityId === "string") {
    paths.push(cityPath(destinationCityId));
    if (typeof corporationId === "string") paths.push(corporationPath(destinationCityId, corporationId));
  }
  for (const extra of [params.addMarketCityIds, params.affectedCityIds]) {
    for (const cityId of strList(extra)) paths.push(cityPath(cityId));
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// Descriptors + finance additions (finance §2.4). The Build Lead
// registers BUSINESS_DESCRIPTORS into RULE_DESCRIPTORS and folds
// BUSINESS_FINANCE_ADDITIONS onto each descriptor's `finance` field —
// the Finance/Catalogue I assembly pattern, unchanged.
// ---------------------------------------------------------------------------

export const BUSINESS_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-06": {
    id: "R-06",
    actionKinds: ["found_corporation"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { found_corporation: foundCorporationHandler },
    readPlan: foundCorporationReadPlan,
    summary: "Found a corporation: home GDP +0.4% and an industry-synergy +0.2% where a completed structure matches; unlisted opening book round(2% of GDP) with the §2.4 null-GDP skip; a founding bundling listing skips the book (legacyBookRubars is provenance only) and prices the opening reference cap from paid-in capital x the prepared payload's judgment (M-01 composed at founding; issuance records are the Market module's).",
  },
  "R-07": {
    id: "R-07",
    actionKinds: ["expand_corporation", "contract_corporation", "relocate_corporation", "dissolve_corporation"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      expand_corporation: corporationActionHandler("expand"),
      contract_corporation: corporationActionHandler("contract"),
      relocate_corporation: corporationActionHandler("relocate"),
      dissolve_corporation: corporationActionHandler("dissolve"),
    },
    readPlan: corporationActionReadPlan,
    summary: "Corporation action (Expand / Contract / Relocate / Dissolve). Unlisted: Vera's multipliers and city effects verbatim, the Expand budget treasury-paid under the budget-class funded-gate. Listed: no multiplier ever touches valuation — coded inputs only (Expand pays into company cash from the founder's personal account; a contentless Contract rejects; a cash leg routes through M-08/M-09 and a Dissolve is M-10, both fail-closed until the Market module lands), M-06 repricing invoked in-event.",
  },
  "F-06": {
    id: "F-06",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Assess and collect business tax (resolver step, no action kinds): computes tax from the operating city's law-derived schedule over a taxable fact, collects the collectible portion company -> host treasury, and records any uncollectible remainder as a tax payable on the corporation record (§5.3). Composed in-event by citing rules via composeTaxAssessment.",
  },
  "F-07": {
    id: "F-07",
    actionKinds: ["pay_tax_arrears"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { pay_tax_arrears: payTaxArrearsHandler },
    readPlan: payTaxArrearsReadPlan,
    summary: "Pay a tax payable: company owner pays a confirmed amount company -> creditor-city treasury (transfer class); the payable reduces, its key is removed at zero, and the §5.3 blocks lift in the same event when the last payable clears.",
  },
};

export const BUSINESS_FINANCE_ADDITIONS: Record<string, FinanceDescriptorAdditions> = {
  "R-06": { shortfallClass: "transfer", ledgersTouched: ["personal", "company"], invokesRules: ["M-01", "M-06"] },
  "R-07": { shortfallClass: "budget", ledgersTouched: ["personal", "company", "treasury", "exterior"], invokesRules: ["M-06"] },
  "F-06": { shortfallClass: "none", ledgersTouched: ["company", "treasury"], invokesRules: [] },
  "F-07": { shortfallClass: "transfer", ledgersTouched: ["company", "treasury"], invokesRules: [] },
};
