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
  memberAccountPath,
  type LedgerRef,
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

function lawsQuery(cityId: string): CollectionQuerySpec {
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
    planMutate(plan, snapshot, corpPath, "state", ["taxPayables"], (current) => {
      if (!current) return current;
      const next = { ...current };
      const map = { ...payablesOf(current) };
      map[fact.operatingCityId] = (map[fact.operatingCityId] ?? 0) + payableDelta;
      next.taxPayables = map;
      return next;
    });
    payablesChange = fieldChange(
      `corporations/${fact.corporationId}.taxPayables.${fact.operatingCityId}`,
      payableBeforeForCity,
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
  planMutate(plan, ctx.snapshot, corpPath, "state", ["taxPayables"], (current) => {
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
    payableAfter,
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

// ---------------------------------------------------------------------------
// Descriptors + finance additions (finance §2.4). The Build Lead
// registers BUSINESS_DESCRIPTORS into RULE_DESCRIPTORS and folds
// BUSINESS_FINANCE_ADDITIONS onto each descriptor's `finance` field —
// the Finance/Catalogue I assembly pattern, unchanged.
// ---------------------------------------------------------------------------

export const BUSINESS_DESCRIPTORS: Record<string, RuleDescriptor> = {
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
  "F-06": { shortfallClass: "none", ledgersTouched: ["company", "treasury"], invokesRules: [] },
  "F-07": { shortfallClass: "transfer", ledgersTouched: ["company", "treasury"], invokesRules: [] },
};
