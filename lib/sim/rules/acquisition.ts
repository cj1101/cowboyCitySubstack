/**
 * Data acquisition (Phase 4 brief §8, step 9) — R-25–R-31.
 *
 * CJ's bindings, as built (War Room rulings, plan v1.2 §§7–8; prep
 * report §0):
 *  - MEANS BEFORE DATA. An owner may survey or collect on anything
 *    GIVEN they have the means to collect it. Means are RECORDS
 *    (`sim_collection_means`, R-26) created by prior player actions or
 *    built inside the commissioning action at full cost and delay.
 *    No means = no data: the refusal is the mechanic, and the engine
 *    never fabricates a number (null-honesty — an unanswerable
 *    question delivers `null` + a reason code, never a guess).
 *  - NO TEMPLATES. Every method is a concrete in-world capability —
 *    infrastructure, a network, an insider — recorded on the action
 *    and graded by the published tables below. The five rationality
 *    gates (design §6) run as a coded pipeline; a method whose assets
 *    cannot be enumerated fails Specificity BY CONSTRUCTION, and a
 *    question aimed at another owner's private tier is refused
 *    BY CONSTRUCTION (`BOUNDARY_PRIVATE_TIER`) — the read plan never
 *    contains those paths, so the resolver never sees them.
 *  - VISIBILITY SPLIT (CJ round 2 + N-1). Covert collection (R-27/R-28)
 *    writes actor-private Log entries only; the public Log learns of a
 *    run ONLY on discovery, via a public discovery entry that CITES
 *    the covert resolutions (surfacing by citation, never by mutating
 *    the covert entries — landed committer discipline). Undiscovered
 *    entries undo under normal logic, from the actor's own view too.
 *  - CASES ARE THE TARGET'S ACT (CJ round 2). Discovery opens NO case,
 *    ever. A case exists only when a target-side member action creates
 *    it (Phase 7 track); this module composes with Defensive's
 *    `sim_cases` shape only where v2 itself names a case (the R-30
 *    wholesale+binding tier, opened by the adopting member's own
 *    election inside the consequence action).
 *  - REACHABILITY, NOT CONSENT (CJ round 2, R-28). An insider is gated
 *    by whether the asker can get ahold of them — a channel record —
 *    never by their owner's permission. Consent governs R-29 grants
 *    only, and R-29's handler is Phase 5 substrate: its descriptor
 *    registers here and resolves narrative-only with the deferral
 *    stated in the open (P4-K8), export under a grant OFF unless the
 *    deal terms say so (CJ round 3).
 *  - PUBLISHED STATS MAY BE BULLSHIT (CJ round 2, R-30/R-31). The
 *    published layer is owner claims, stamped `owner-published ·
 *    unverified`, distinct from resolver ground truth forever; the
 *    platform ships no truth verdict and auto-flags nothing. Proof is
 *    a play act: an R-31 verification report establishes falsity
 *    against privately held intel (weak means return
 *    `cannot-determine`, never a manufactured debunking), and the
 *    mechanical consequences — scaled by lie strength (v2's tiers) —
 *    land only as a Resolution Event citing the report: the member
 *    adoption action `adopt_verification_report` in this file.
 *
 * THE DELIVERY SHAPE (design §§3.4/7.2/8.3 + C-8): commission is an
 * action Resolution Event; DELIVERY is a ripening of a delivery
 * pending (`survey-delivery` / `collection-delivery` /
 * `insider-delivery` — new pending kinds) under Action-Gated
 * Ripening. The landed ripening applier (`applyRipeningEffect`)
 * expresses stat deltas and fund disbursements only — a delivery's
 * effect is writing an intel record, which no landed branch can
 * express. This file therefore exports the delivery plan builder
 * (`buildDeliveryPlan`) and its effect core (`applyDeliveryEffect`)
 * as the module's reference implementation: the harness proves them
 * end-to-end, and the Build Lead wires them into the ripening path
 * at assembly (the exact engine items are enumerated in the prep
 * report §5 — pending-kind registration per design C-8, a kind-keyed
 * dispatch in the applier, and the covert-visibility flag for
 * ripening plans, which the landed resolver currently hardcodes off).
 * Commission handlers build their pending drafts directly in the
 * landed doc shape (mirroring `buildPendingDraft` field-for-field)
 * because `buildPendingDraft`'s audience default would seat the
 * TARGET's owners in a covert pending's `audienceUids` — and pending
 * reads are audience-fenced in the landed rules, so that default
 * would leak a covert run's existence to its target. Covert delivery
 * pendings seat the actor and the actor's city owners only.
 *
 * Grading equality (P4-G8): one grading function (`gradeCollection`)
 * is computed at commission, frozen into the pending's spec, shown at
 * preview, cited in the Log, and re-validated at delivery. Grading
 * never improves without a new logged action; delivery may come in
 * under the frozen cap, never over it.
 */

import { canonicalJson, sha256Hex } from "../canonical";
import { projectFirestoreValue } from "../log";
import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  type CollectionQuerySpec,
  type LogEntryDraft,
  type PendingDraft,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
} from "../state";
import { clampNumber } from "./arithmetic";
import {
  fieldChange as engineFieldChange,
  planWrite as enginePlanWrite,
  rejectedPlan,
  ruleEffectDraft as engineRuleEffectDraft,
  summaryDraft as engineSummaryDraft,
} from "./planHelpers";
import { RipeningPreparationError, type StructuredPrecondition } from "./pendingRules";
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

// ---------------------------------------------------------------------------
// Published tables (design §5 — transcribed as data so QA can diff code
// against the design line by line)
// ---------------------------------------------------------------------------

export type DataKind = "count" | "money" | "share" | "attitude" | "condition" | "identity-of";

export const DATA_KINDS: readonly DataKind[] = [
  "count",
  "money",
  "share",
  "attitude",
  "condition",
  "identity-of",
];

export type ObservationClass =
  | "enumeration"
  | "records-access"
  | "panel-interview"
  | "observation"
  | "single-source"
  | "signals";

export const OBSERVATION_CLASSES: readonly ObservationClass[] = [
  "enumeration",
  "records-access",
  "panel-interview",
  "observation",
  "single-source",
  "signals",
];

/** Design §5.3 — the Granularity/Knowability matrix. Rows: the means'
 * observation class. Columns: question dataKind. Cell 0 ⇒ the question
 * returns `null` + reason at delivery (rule G-1); per-question cells
 * cap findings per question (rule G-2); `identity-of` never scores 3
 * (rule G-3 — a fairness property, not an oversight). */
export const GRANULARITY_MATRIX: Record<ObservationClass, Record<DataKind, number>> = {
  enumeration: { count: 3, money: 2, share: 3, attitude: 1, condition: 2, "identity-of": 2 },
  "records-access": { count: 3, money: 3, share: 2, attitude: 0, condition: 2, "identity-of": 2 },
  "panel-interview": { count: 1, money: 1, share: 2, attitude: 3, condition: 2, "identity-of": 0 },
  observation: { count: 2, money: 0, share: 1, attitude: 0, condition: 3, "identity-of": 1 },
  "single-source": { count: 1, money: 1, share: 1, attitude: 2, condition: 1, "identity-of": 2 },
  signals: { count: 2, money: 1, share: 1, attitude: 0, condition: 1, "identity-of": 0 },
};

/** Design §6 gate 4 — intrusiveness class by observation class. The
 * exposure band is COMPUTED from this + the target's posture + the
 * run's duration; an action payload field claiming an exposure is a
 * schema error (the intake schemas in this file have no such field). */
export const INTRUSIVENESS_CLASS: Record<ObservationClass, number> = {
  signals: 1,
  "panel-interview": 2,
  observation: 2,
  "records-access": 3,
  "single-source": 3,
  enumeration: 4,
};

export type ReliabilityBand = "A" | "B" | "C" | "D";

/** Design §5.4 — axis sum → disposition / coverage cap / band. The
 * addendum §1.3 table, locked verbatim. Sum 0–2 rejects. */
export const BAND_TABLE: readonly {
  minSum: number;
  maxSum: number;
  coverageCapPct: number;
  band: ReliabilityBand;
}[] = [
  { minSum: 3, maxSum: 5, coverageCapPct: 25, band: "D" },
  { minSum: 6, maxSum: 8, coverageCapPct: 60, band: "C" },
  { minSum: 9, maxSum: 10, coverageCapPct: 85, band: "B" },
  { minSum: 11, maxSum: 12, coverageCapPct: 100, band: "A" },
];

/** Design §5.4 H-3 — operating cost scales with target scope from the
 * means record's reference cost. Published factors; preview-computed. */
export const SCOPE_COST_FACTORS = {
  "whole-city": 1.0,
  "structure-type": 0.6,
  "named-structures": 0.1, // per structure, min total factor 0.2
  "business-staff": 0.4,
  "business-customers": 0.4,
} as const;

/** Design §5.6 — delay derivation (published formula, stored on the
 * pending, disclosed at preview). */
export const DELAY_BASE_HOURS: Record<string, number> = {
  "whole-city": 48,
  "structure-type": 24,
  "named-structures": 8,
  "business-staff": 12,
  "business-customers": 12,
};
export const BAND_DELAY_FACTOR: Record<ReliabilityBand, number> = {
  A: 2.0,
  B: 1.0,
  C: 0.6,
  D: 0.35,
};
export const FRESHNESS_DELAY_FACTOR: Record<string, number> = {
  standing: 0.75,
  dispatch: 1.5,
};

/** Design §9.4 — the closed null-reason vocabulary. A finding with
 * `value: null` and no reason is a shape violation; reasons are data,
 * rendered in UI and export verbatim. (The design proposed a separate
 * `nullReasons.ts`; the family keeps one file — the Lead may split.) */
export const NULL_REASONS = [
  "NOT_OBSERVABLE_BY_MEANS",
  "NOT_KNOWABLE_FROM_SOURCE",
  "OUT_OF_COVERAGE",
  "STATE_UNSET",
  "BASELINE_UNRATIFIED_SOURCE",
  "SOURCE_REFUSED",
  "SOURCE_REPORTED",
  "NO_RETURN_PATH",
  "SPAN_UNVERIFIABLE",
] as const;
export type NullReason = (typeof NULL_REASONS)[number];

/** The three delivery pending kinds (design C-8: additive registry
 * entries with ruleIdsOnRipen R-25/R-27/R-28 — Lead assembly). */
export const SURVEY_DELIVERY_KIND = "survey-delivery";
export const COLLECTION_DELIVERY_KIND = "collection-delivery";
export const INSIDER_DELIVERY_KIND = "insider-delivery";
export const DELIVERY_PENDING_KINDS: Record<string, string> = {
  [SURVEY_DELIVERY_KIND]: "R-25",
  [COLLECTION_DELIVERY_KIND]: "R-27",
  [INSIDER_DELIVERY_KIND]: "R-28",
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ScopeKind = keyof typeof SCOPE_COST_FACTORS;

export interface QuestionSpec {
  questionId: string;
  text: string;
  dataKind: DataKind;
  /** What the question proposes to read. `private-records` (another
   * owner's raw intel, Situations, drafts, mandate text, unpublished
   * allocations) is refused BY CONSTRUCTION at the boundary gate —
   * the read plan never contains those paths (§6 gate 5). */
  sourceScope: "public-state" | "published-layer" | "private-records";
}

export interface SurveyTargetSpec {
  scopeKind: ScopeKind;
  structureType: string | null;
  structureIds: string[];
  businessId: string | null;
  businessHomeCityId: string | null;
}

export interface MeansProfile {
  observationClass: ObservationClass;
  /** Axis grades against a GENERIC target, fixed at establishment. */
  reach: number;
  access: number;
  granularityKinds: DataKind[];
  freshnessClass: "standing" | "dispatch" | "none";
}

export interface PerQuestionGrade {
  cell: number;
  knowable: boolean;
  verdict: "answerable" | "null-at-delivery";
  reason: NullReason | null;
}

export interface GradingResult {
  axisScores: { reach: number; access: number; granularity: number; freshness: number };
  axisSum: number;
  band: ReliabilityBand | null; // null when the sum rejects (0–2)
  coverageCapPct: number;
  perQuestion: Record<string, PerQuestionGrade>;
  /** H-1 record-span fraction (0–1) where computable from records;
   * null where it is not (the cap is then the band cap, and the
   * unspanned segments are named qualitatively in knownUnknowns). */
  spanFraction: number | null;
  basisRows: string[];
}

// ---------------------------------------------------------------------------
// Small shared helpers (local copies — the family-file discipline)
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

/** The acting city (defensive/laws idiom): the payload's cityId,
 * falling back to the action's first target city. */
const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

// Entry/change builders in this family's call shape, translated onto
// the landed planHelpers signatures. `visibility` rides INSIDE the
// classification object at call sites for readability; it is lifted
// to the entry's own visibility field here (the landed shape), so
// actor-private entries are actor-private in fact, not just in prose.
interface ChangeArgs {
  cityId?: string;
  field: string;
  before: unknown;
  after: unknown;
  unit?: string;
  note?: string;
}

function fieldChange(args: ChangeArgs): { field: string; before: unknown; after: unknown; formula: string } {
  const formula = [args.note ?? "", args.unit ? `(${args.unit})` : ""].filter((s) => s.length > 0).join(" ");
  return engineFieldChange(args.field, args.before, args.after, formula);
}

interface EntryArgs {
  actor: SimActor;
  cityId: string | null;
  ruleIds: string[];
  summaryText: string;
  changes?: ReturnType<typeof engineFieldChange>[];
  recordsCreated?: string[];
  recordsUpdated?: string[];
  classification?: Record<string, unknown> | null;
}

function toEntryDraft(args: EntryArgs, summary: boolean) {
  const classification: Record<string, unknown> = { ...(args.classification ?? {}) };
  let visibility: "public" | "actor-private" = "public";
  if (classification.visibility === "actor-private") {
    visibility = "actor-private";
    delete classification.visibility;
  }
  const partial = {
    actor: args.actor,
    cityId: args.cityId,
    cityIds: args.cityId ? [args.cityId] : [],
    ruleIds: args.ruleIds,
    changes: args.changes ?? [],
    recordsCreated: args.recordsCreated ?? [],
    recordsUpdated: args.recordsUpdated ?? [],
    classification: Object.keys(classification).length > 0 ? classification : null,
    summaryText: args.summaryText,
    visibility,
  };
  return summary ? engineSummaryDraft(partial) : engineRuleEffectDraft(partial);
}

function ruleEffectDraft(args: EntryArgs) {
  return toEntryDraft(args, false);
}

function summaryDraft(args: EntryArgs) {
  return toEntryDraft(args, true);
}

/** This family's write helper over the landed planWrite: recordClass
 * is always "state" here (pendings travel via pendingCreates), and
 * changedFields are computed exactly — the DOTTED LEAF paths whose
 * values differ between the snapshot doc and the after-doc (every
 * leaf on a create), which is the granularity F-02 reconciles
 * changes against. Handlers that fold several writes to one path get
 * the engine's union semantics for free. */
function planWrite(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  path: string,
  afterDoc: Record<string, unknown> | null
): void {
  const before = snapshotDoc(snapshot, path);
  const changedFields: string[] = [];
  const walk = (b: unknown, a: unknown, prefix: string): void => {
    if (JSON.stringify(b) === JSON.stringify(a)) return;
    const bothObjects =
      typeof b === "object" && b !== null && !Array.isArray(b) &&
      typeof a === "object" && a !== null && !Array.isArray(a);
    if (bothObjects) {
      const keys = new Set([
        ...Object.keys(b as Record<string, unknown>),
        ...Object.keys(a as Record<string, unknown>),
      ]);
      for (const key of keys) {
        walk(
          (b as Record<string, unknown>)[key],
          (a as Record<string, unknown>)[key],
          prefix ? `${prefix}.${key}` : key
        );
      }
      return;
    }
    if (prefix) changedFields.push(prefix);
  };
  walk(before, afterDoc, "");
  enginePlanWrite(plan, snapshot, path, afterDoc, "state", changedFields);
}

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const strList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

function actorCitations(
  plan: ResolutionPlan,
  citations: HandlerContext["citations"],
  resolutionId: string
): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

/** Read a materialized collection query's docs from the snapshot (the
 * structures/defensive local idiom). Returns null when the snapshot
 * carries no such query — handlers treat that as a read-plan breach,
 * never as an empty result. */
function queryDocs(
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): [string, Record<string, unknown>][] | null {
  const record = snapshot.queries.find(
    (q) => q.spec.id === queryId && q.spec.collectionPath === collectionPath
  );
  if (!record) return null;
  const out: [string, Record<string, unknown>][] = [];
  for (const path of record.resultPaths) {
    const doc = snapshotDoc(snapshot, path);
    if (doc) out.push([path, doc]);
  }
  return out;
}

/** Authority over the ACTING city (defensive's requireActingAuthority
 * pattern): the shared city acts only through a sitting-mayor
 * shared-office actor (CJ round 3); any other city through its
 * faction's ownerUids. Verifying the memberId IS the sitting mayor
 * awaits Phase 7 terms data — the allocation/defensive posture. */
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
    return rejectedPlan(descriptorId, "NO_CITY", [ruleId], `City ${cityId} does not stand in the sim.`);
  }
  if (city.isSharedCity === true) {
    if (
      ctx.action.actor.type !== "shared-office" ||
      ctx.action.actor.office !== "mayor" ||
      !ctx.action.actor.memberId
    ) {
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
  const owners = faction?.ownerUids;
  if (!Array.isArray(owners) || !owners.includes(uid)) {
    return rejectedPlan(
      descriptorId,
      "AUTHORITY_REVOKED",
      [ruleId],
      `${uid} is not an owner of ${cityId}; collection is a governor's act over their own apparatus.`
    );
  }
  return null;
}

/** NPC actors need mandate data (Phase 5) that does not exist in
 * Phase 4 — a named refusal, never a silent gap (design §3.6/C-9). */
function rejectNpcActor(ctx: HandlerContext, descriptorId: string, ruleId: string): ResolutionPlan | null {
  if (ctx.action.actor.type === "npc") {
    return rejectedPlan(
      descriptorId,
      "MANDATE_DATA_ABSENT",
      [ruleId],
      "NPC-commissioned collection validates against mandate records (Phase 5 data) that do not exist yet; the action is refused by name rather than waved through. The owner-actor path is complete."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Means records — `sim_collection_means/{meansId}` (design §5.1)
// ---------------------------------------------------------------------------

export function meansPath(meansId: string): string {
  return `sim_collection_means/${meansId}`;
}

export function posturePath(cityId: string): string {
  return `sim_collection_posture/${cityId}`;
}

export function meansProfileOf(means: Record<string, unknown>): MeansProfile {
  const profile = (means.profile ?? {}) as Record<string, unknown>;
  const observationClass = OBSERVATION_CLASSES.includes(profile.observationClass as ObservationClass)
    ? (profile.observationClass as ObservationClass)
    : "observation";
  return {
    observationClass,
    reach: typeof profile.reach === "number" ? profile.reach : 0,
    access: typeof profile.access === "number" ? profile.access : 0,
    granularityKinds: strList(profile.granularityKinds).filter((k): k is DataKind =>
      (DATA_KINDS as readonly string[]).includes(k)
    ),
    freshnessClass:
      profile.freshnessClass === "standing" || profile.freshnessClass === "dispatch"
        ? profile.freshnessClass
        : "none",
  };
}

/** The vehicle completion predicate (design §5.1: status `building`
 * until the vehicle's own completion rule fires). Graders read the
 * EFFECTIVE status — derived from records, never from the stored
 * field alone — so no timer and no second writer is needed: an R-05
 * vehicle's structures stand `complete`, an R-06 corporation stands
 * founded and not dissolved, an R-08 law stands enacted and not
 * repealed. A means created inside a commission (buildMeans) matures
 * at its stored `activatesAtSeq` (seq advance is player-caused by
 * construction — the world must move for the office to finish). */
export function vehicleComplete(
  snapshot: SimSnapshot,
  means: Record<string, unknown>
): boolean {
  const activatesAtSeq = num(means, "activatesAtSeq");
  if (activatesAtSeq !== null) {
    return snapshot.counterHead.lastSeq >= activatesAtSeq;
  }
  const vehicle = (means.vehicle ?? {}) as Record<string, unknown>;
  const recordPaths = strList(vehicle.recordIds);
  if (recordPaths.length === 0) return false;
  switch (vehicle.ruleId) {
    case "R-05":
      return recordPaths.every((path) => {
        const doc = snapshotDoc(snapshot, path);
        return doc !== null && doc.status === "complete";
      });
    case "R-06":
      return recordPaths.every((path) => {
        const doc = snapshotDoc(snapshot, path);
        return doc !== null && doc.status !== "dissolved";
      });
    case "R-08":
      return recordPaths.every((path) => {
        const doc = snapshotDoc(snapshot, path);
        return doc !== null && doc.status !== "repealed";
      });
    default:
      return false; // mandate vehicles are Phase 5 data
  }
}

export type MeansStatus = "building" | "active" | "compromised" | "burned" | "dissolved";

export function effectiveMeansStatus(
  snapshot: SimSnapshot,
  means: Record<string, unknown>
): MeansStatus {
  const stored = means.status as MeansStatus;
  if (stored === "compromised" || stored === "burned" || stored === "dissolved") return stored;
  if (stored === "active") return "active";
  return vehicleComplete(snapshot, means) ? "active" : "building";
}

/** A live connection trait between two cities, either direction
 * (WB-7.2 connectivity as data: `connection:<cityId>:live`). */
export function hasLiveConnectionBetween(
  snapshot: SimSnapshot,
  cityA: string,
  cityB: string
): boolean {
  const a = snapshotDoc(snapshot, `sim_cities/${cityA}`);
  const b = snapshotDoc(snapshot, `sim_cities/${cityB}`);
  const traitsA = Array.isArray(a?.traits) ? (a.traits as unknown[]) : [];
  const traitsB = Array.isArray(b?.traits) ? (b.traits as unknown[]) : [];
  return traitsA.includes(`connection:${cityB}:live`) || traitsB.includes(`connection:${cityA}:live`);
}

// ---------------------------------------------------------------------------
// Grading (design §5.2–§5.4) — one function, computed at commission,
// frozen into the pending, re-validated at delivery (P4-G8-C2)
// ---------------------------------------------------------------------------

export interface GradingInputs {
  means: Record<string, unknown>;
  /** The city being collected over. */
  targetCityId: string;
  foreign: boolean;
  questions: QuestionSpec[];
  /** Structures of the target city from the read plan's query, for
   * segment existence + the H-1 span fraction. Null when the snapshot
   * carries no structures query (span then uncomputable). */
  targetStructures: [string, Record<string, unknown>][] | null;
  target: SurveyTargetSpec;
  /** An active counter-means of the target city exists (its own R-26
   * record, foreign/both scope, naming the acquirer's city). */
  counterMeansActive: boolean;
  /** Insider asks: the source is one person — band caps at C (§8.2). */
  singleSourceClamp: boolean;
}

export function gradeCollection(snapshot: SimSnapshot, inputs: GradingInputs): GradingResult {
  const profile = meansProfileOf(inputs.means);
  const basisRows: string[] = [];
  const hostCityId = str(inputs.means.hostCityId) ?? str(inputs.means.ownerCityId) ?? "";
  const resident = hostCityId === inputs.targetCityId;
  const connected = inputs.foreign
    ? hasLiveConnectionBetween(snapshot, str(inputs.means.ownerCityId) ?? "", inputs.targetCityId)
    : true;

  // Reach (§5.2): the stored generic grade, modulated by the coded
  // target facts a record can decide.
  let reach = profile.reach;
  if (inputs.foreign && !resident && !connected) {
    reach = Math.min(reach, 1);
    basisRows.push(
      "Reach: no live connection record and no resident presence joins the means to the target — capped at 1 (indirect/partial channel)."
    );
  } else if (resident) {
    basisRows.push("Reach: the means is resident in the target city (hostCityId == target).");
  } else if (inputs.foreign && connected) {
    basisRows.push("Reach: a live connection record joins the means' city to the target.");
  } else {
    basisRows.push("Reach: domestic apparatus over its own city (stored generic grade stands).");
  }

  // Access (§5.2): closed-target row and hostile/indifferent row are
  // the coded modulations; the stored grade carries the rest.
  let access = profile.access;
  const targetCity = snapshotDoc(snapshot, `sim_cities/${inputs.targetCityId}`);
  const targetLaw = num(targetCity, "stats.law");
  if (inputs.foreign && targetLaw !== null && targetLaw >= 75 && inputs.counterMeansActive) {
    access = 0;
    basisRows.push(
      `Access 0: target law ${targetLaw} ≥ 75 and an active counter-means names the acquirer's city — the target is closed to this means (§5.2 row 0).`
    );
  } else if (inputs.foreign && !connected && !resident && access > 1) {
    access = 1;
    basisRows.push(
      "Access 1: foreign target with no relationship records (no connection, no residency) — hostile/indifferent (§5.2 row 1)."
    );
  } else {
    basisRows.push(`Access ${access}: stored generic grade stands (no coded modulation fired).`);
  }

  // Granularity (§5.3): per-question cells bind; the axis is the
  // median cell (rule G-2).
  const perQuestion: Record<string, PerQuestionGrade> = {};
  const cells: number[] = [];
  for (const question of inputs.questions) {
    const cell = GRANULARITY_MATRIX[profile.observationClass][question.dataKind];
    cells.push(cell);
    const knowable = cell > 0;
    perQuestion[question.questionId] = {
      cell,
      knowable,
      verdict: knowable ? "answerable" : "null-at-delivery",
      reason: knowable ? null : inputs.foreign ? "NOT_KNOWABLE_FROM_SOURCE" : "NOT_OBSERVABLE_BY_MEANS",
    };
  }
  const sorted = [...cells].sort((a, b) => a - b);
  const granularity = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  basisRows.push(
    `Granularity ${granularity}: median cell of the ${profile.observationClass} row over ${cells.length} question(s); per-question cells bind at delivery (G-2).`
  );

  // Freshness (§5.2): the return path decides.
  const returnPath = !inputs.foreign || resident || connected;
  let freshness = 0;
  if (!returnPath || profile.freshnessClass === "none") {
    freshness = 0;
    basisRows.push("Freshness 0: no return path (one-way channel / no reporting line) — results cannot come back.");
  } else if (profile.freshnessClass === "standing") {
    freshness = 3;
    basisRows.push("Freshness 3: standing reporting line — the apparatus reports as a matter of routine.");
  } else {
    freshness = 1;
    basisRows.push("Freshness 1: return path is a single dispatch.");
  }

  // H-1 span fraction, where records can compute it.
  let spanFraction: number | null = null;
  if (inputs.target.scopeKind === "business-staff" || inputs.target.scopeKind === "business-customers") {
    spanFraction = 1;
    basisRows.push("Span: the segment is the named business itself — the means' records span it wholly (H-1).");
  } else if (inputs.targetStructures !== null) {
    const total = inputs.targetStructures.length;
    if (total > 0) {
      if (inputs.target.scopeKind === "named-structures") {
        spanFraction = clampNumber(inputs.target.structureIds.length / total, 0, 1);
      } else if (inputs.target.scopeKind === "structure-type") {
        const ofType = inputs.targetStructures.filter(
          ([, doc]) => doc.kind === inputs.target.structureType
        ).length;
        spanFraction = clampNumber(ofType / total, 0, 1);
      }
      if (spanFraction !== null) {
        basisRows.push(
          `Span: the means' segment covers ${(spanFraction * 100).toFixed(0)}% of the target's structure records (H-1).`
        );
      }
    }
  }
  if (spanFraction === null && inputs.target.scopeKind !== "business-staff" && inputs.target.scopeKind !== "business-customers") {
    basisRows.push(
      "Span: not computable from records — the cap is the band cap and unspanned segments are named qualitatively in knownUnknowns (H-1 fallback)."
    );
  }

  const axisScores = { reach, access, granularity, freshness };
  const axisSum = reach + access + granularity + freshness;
  let band: ReliabilityBand | null = null;
  let coverageCapPct = 0;
  for (const row of BAND_TABLE) {
    if (axisSum >= row.minSum && axisSum <= row.maxSum) {
      band = row.band;
      coverageCapPct = row.coverageCapPct;
    }
  }
  if (inputs.singleSourceClamp && (band === "A" || band === "B")) {
    band = "C";
    coverageCapPct = Math.min(coverageCapPct, 60);
    basisRows.push("Band clamped to C: a single source caps the band by construction (§8.2).");
  }
  if (spanFraction !== null) {
    coverageCapPct = Math.min(coverageCapPct, Math.floor(spanFraction * 100));
  }

  return { axisScores, axisSum, band, coverageCapPct, perQuestion, spanFraction, basisRows };
}

/** Design §5.4 H-3 — the operating cost at the commissioned scope. */
export function operatingCostForScope(
  referenceCostRubars: number,
  target: SurveyTargetSpec
): number {
  const factor =
    target.scopeKind === "named-structures"
      ? Math.max(0.2, SCOPE_COST_FACTORS["named-structures"] * target.structureIds.length)
      : SCOPE_COST_FACTORS[target.scopeKind];
  return Math.max(0, Math.round(referenceCostRubars * factor));
}

/** Design §5.6 — the delay derivation, stored on the pending and
 * disclosed at preview. Both floors are floors: delivery happens
 * inside a later player-caused wake, never on the clock. */
export function deriveCollectionDelay(args: {
  scopeKind: ScopeKind;
  band: ReliabilityBand;
  freshnessClass: string;
  foreign: boolean;
  connected: boolean;
}): {
  baseHours: number;
  bandFactor: number;
  freshnessFactor: number;
  distanceFactor: number;
  minWallElapsedHours: number;
  minSeqAdvance: number;
} {
  const baseHours = DELAY_BASE_HOURS[args.scopeKind] ?? 48;
  const bandFactor = BAND_DELAY_FACTOR[args.band];
  const freshnessFactor = FRESHNESS_DELAY_FACTOR[args.freshnessClass] ?? 1.5;
  const distanceFactor = args.foreign ? (args.connected ? 1.0 : 1.5) : 1.0;
  const minWallElapsedHours = Math.ceil(baseHours * bandFactor * freshnessFactor * distanceFactor);
  return {
    baseHours,
    bandFactor,
    freshnessFactor,
    distanceFactor,
    minWallElapsedHours,
    minSeqAdvance: Math.round(minWallElapsedHours / 6),
  };
}

// ---------------------------------------------------------------------------
// Exposure + discovery (design §§6 gate 4, 7.3) — deterministic, no dice
// ---------------------------------------------------------------------------

export type ExposureBand = "low" | "guarded" | "high" | "severe";
export type CounterPosture = "none" | "passive" | "active" | "alerted";
export type DiscoveryOutcome = "undiscovered" | "suspected" | "discovered";

const EXPOSURE_STEPS: readonly ExposureBand[] = ["low", "guarded", "high", "severe"];

/** Gate 4: the exposure band is computed from published state —
 * intrusiveness of the means' class, the target's counter-posture
 * facts, and the run's duration class. Never asserted by the actor. */
export function computeExposureBand(args: {
  observationClass: ObservationClass;
  targetLaw: number | null;
  counterMeansActive: boolean;
  delayHours: number;
}): { band: ExposureBand; basis: string[] } {
  const basis: string[] = [];
  let step = INTRUSIVENESS_CLASS[args.observationClass] - 1; // 1→low … 4→severe
  basis.push(
    `Intrusiveness ${INTRUSIVENESS_CLASS[args.observationClass]} (${args.observationClass}) sets the base band ${EXPOSURE_STEPS[step]}.`
  );
  if (args.targetLaw !== null && args.targetLaw >= 50 && args.counterMeansActive) {
    step = Math.min(step + 1, 3);
    basis.push(`Target law ${args.targetLaw} ≥ 50 with an active counter-means: +1 step.`);
  }
  if (args.delayHours > 48) {
    step = Math.min(step + 1, 3);
    basis.push(`Run duration ${args.delayHours}h is the long class (> 48h): +1 step.`);
  }
  return { band: EXPOSURE_STEPS[step], basis };
}

export function counterPostureBand(args: {
  targetLaw: number | null;
  counterMeansActive: boolean;
  priorSuspected: boolean;
}): CounterPosture {
  const active = (args.targetLaw !== null && args.targetLaw >= 50) || args.counterMeansActive;
  if (active && args.priorSuspected) return "alerted";
  if (active) return "active";
  if (args.targetLaw !== null) return "passive";
  return "none";
}

/** Design §7.3 — the discovery table, verbatim. Same published inputs
 * ⇒ same outcome (TC-E06 replay): the table is preview-computable,
 * so the preview shows the owner their exact cell. */
export const DISCOVERY_TABLE: Record<ExposureBand, Record<CounterPosture, DiscoveryOutcome>> = {
  low: { none: "undiscovered", passive: "undiscovered", active: "undiscovered", alerted: "suspected" },
  guarded: { none: "undiscovered", passive: "undiscovered", active: "suspected", alerted: "discovered" },
  high: { none: "undiscovered", passive: "suspected", active: "discovered", alerted: "discovered" },
  severe: { none: "suspected", passive: "discovered", active: "discovered", alerted: "discovered" },
};

export function evaluateDiscovery(exposure: ExposureBand, posture: CounterPosture): DiscoveryOutcome {
  return DISCOVERY_TABLE[exposure][posture];
}

/** Is there an active counter-means of `targetCityId` against the
 * acquirer, among the snapshot's materialized means query? */
export function counterMeansActiveIn(
  snapshot: SimSnapshot,
  targetCityId: string,
  acquirerCityId: string
): boolean {
  const docs = queryDocs(snapshot, COUNTER_MEANS_QUERY_ID, "sim_collection_means");
  if (!docs) return false;
  return docs.some(([, doc]) => {
    if (doc.ownerCityId !== targetCityId) return false;
    if (doc.scopeKind !== "foreign" && doc.scopeKind !== "both") return false;
    if (!strList(doc.namedTargetCityIds).includes(acquirerCityId)) return false;
    const status = doc.status as MeansStatus;
    return status === "active" || status === "building";
  });
}

export const STRUCTURES_QUERY_ID = "acq-structures";
export const COUNTER_MEANS_QUERY_ID = "acq-counter-means";
export const LAWS_QUERY_ID_ACQ = "acq-laws";

// ---------------------------------------------------------------------------
// Delivery validation + the intel record (design §§9–10)
//
// Delivery runs inside a later player-caused wake. It re-validates the
// prepared payload against the delivery snapshot: findings are
// recomputed where the record can be recomputed (G-2), nulled where
// the grade or the world demands a null (G-1 + the closed reason
// vocabulary), and the intel record is built by THIS code — never by
// trusting a payload. The findings validators below are the P4-G8-C2
// evidence: a delivery can come in UNDER the frozen cap, never over.
// ---------------------------------------------------------------------------

export interface FrozenDeliveryGrading {
  band: ReliabilityBand;
  coverageCapPct: number;
  fundedCapPct: number;
  perQuestion: Record<string, PerQuestionGrade>;
  axisScores: { reach: number; access: number; granularity: number; freshness: number };
  axisSum: number;
  spanFractionAtCommission: number | null;
  /** The basis rows as stated at commission (grading equality:
   * preview == commission Log == delivery — P4-G8-C2). */
  basisRows: string[];
}

/** The delivery block of a delivery pending's payloadSpec — the frozen
 * commission state the delivery re-validates against. */
export interface DeliverySpec {
  ruleId: "R-25" | "R-27" | "R-28";
  visibilityClass: "public" | "actor-private";
  /** Survey questions / run questions / the ask's question (one). */
  questions: QuestionSpec[];
  targetCityId: string;
  targetBusinessId: string | null;
  targetBusinessHomeCityId: string | null;
  scopeKind: ScopeKind;
  structureType: string | null;
  structureIds: string[];
  foreign: boolean;
  meansId: string | null;
  meansSnapshotHash: string;
  grading: FrozenDeliveryGrading;
  collectorUid: string;
  collectorCityId: string;
  methodRef: string;
  kindLabel: string;
  commissionSeq: number | null;
  singleSourceClamp: boolean;
  /** The query/result paths the delivery snapshot must materialize. */
  readPaths: string[];
  buildMeans: boolean;
  /** Voiding refund (design §3.5): debit minus committed vehicle
   * costs; existing-means commissions commit their operating cost to
   * the attempt and refund nothing. */
  voidRefundRubars: number;
  insider: {
    personRef: string;
    channelKind: string;
    offerRubars: number;
    personCityId: string;
    personBusinessId: string | null;
    personBusinessHomeCityId: string | null;
  } | null;
}

export interface IntelFinding {
  metric: string;
  value: number | string | null;
  unit: string;
  /** Compact JSON basis, per design §9.2 encoding. */
  note: string;
  nullReason: NullReason | null;
}

/** Round a truth to the grade's stated precision (§5.3 rules G-2/G-3):
 * grade 3 = exact figure; grade 2 = nearest-10 (count/money),
 * nearest-5 (share/condition); grade 1 = the 25%-bucket
 * (count/money) or nearest-25 (share/condition). */
export function snapToPrecision(
  dataKind: DataKind,
  grade: number,
  truth: number
): number {
  if (grade >= 3) return truth;
  if (dataKind === "count" || dataKind === "money") {
    if (grade === 2) return Math.round(truth / 10) * 10;
    const bucket = Math.max(10, Math.round(Math.abs(truth) * 0.25));
    return Math.round(truth / bucket) * bucket;
  }
  if (grade === 2) return Math.round(truth / 5) * 5;
  return Math.round(truth / 25) * 25;
}

/**
 * Validate one state-bound finding against the delivery snapshot.
 * The TRUTH is read from the record the finding cites
 * (`basisField` on `basisPaths[0]`); the payload's value must equal
 * the grade-snapped truth, or the whole payload fails (design §9.2:
 * a payload value that disagrees with recomputation is rejected —
 * there is no partial delivery, only generation failure).
 *
 * `null` is lawful only when a reason fires: the grade's verdict is
 * null-at-delivery (G-1), the state is unset (null-honesty), or the
 * cited segment vanished (OUT_OF_COVERAGE). `attitude` shares are
 * baseline evidence: pre-ratification they are ALWAYS null with
 * `BASELINE_UNRATIFIED_SOURCE` — the fabric reports no public pulse
 * it cannot cite (design §4.2/§11.4; F-A8 flag).
 */
export function validateStateFinding(
  snapshot: SimSnapshot,
  question: QuestionSpec,
  grade: PerQuestionGrade,
  payload: { value: number | string | null; basisPaths: string[]; basisField: string },
  citableBaseline: string | null
): IntelFinding {
  const unit = question.dataKind;
  if (question.dataKind === "attitude" && citableBaseline === null) {
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "baseline", citableBaseline }),
      nullReason: "BASELINE_UNRATIFIED_SOURCE",
    };
  }
  if (!grade.knowable) {
    if (payload.value !== null) {
      throw new RipeningPreparationError(
        `Question ${question.questionId} is ${grade.reason} (grade ${grade.cell}): the payload asserts a value where none is observable.`
      );
    }
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "grade", cell: grade.cell }),
      nullReason: grade.reason,
    };
  }
  const truthDoc = snapshotDoc(snapshot, payload.basisPaths[0]);
  if (!truthDoc) {
    if (payload.value !== null) {
      throw new RipeningPreparationError(
        `Question ${question.questionId}: the cited record ${payload.basisPaths[0]} no longer stands in the world; the payload asserts a value for a vanished segment.`
      );
    }
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "segment", basisPath: payload.basisPaths[0] }),
      nullReason: "OUT_OF_COVERAGE",
    };
  }
  const truth = docField(truthDoc, payload.basisField);
  if (question.dataKind === "identity-of") {
    if (typeof payload.value !== "string" || payload.value.length === 0) {
      throw new RipeningPreparationError(
        `Question ${question.questionId}: identity findings must name a record id.`
      );
    }
    return {
      metric: question.questionId,
      value: payload.value,
      unit,
      note: JSON.stringify({ basis: "record-id", basisPath: payload.basisPaths[0] }),
      nullReason: null,
    };
  }
  if (typeof truth !== "number" || !Number.isFinite(truth)) {
    // The state is unset: only null + STATE_UNSET is lawful.
    if (payload.value !== null) {
      throw new RipeningPreparationError(
        `Question ${question.questionId}: the cited state field ${payload.basisField} is unset — a value here would be fabrication.`
      );
    }
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "state-unset", basisPath: payload.basisPaths[0], basisField: payload.basisField }),
      nullReason: "STATE_UNSET",
    };
  }
  if (typeof payload.value !== "number" || !Number.isFinite(payload.value)) {
    throw new RipeningPreparationError(
      `Question ${question.questionId}: a numeric finding is required against ${payload.basisField}.`
    );
  }
  const expected = snapToPrecision(question.dataKind, grade.cell, truth);
  if (payload.value !== expected) {
    throw new RipeningPreparationError(
      `Question ${question.questionId}: payload ${payload.value} disagrees with the grade-${grade.cell} recomputation ${expected} of ${payload.basisField} (truth ${truth}).`
    );
  }
  return {
    metric: question.questionId,
    value: payload.value,
    unit,
    note: JSON.stringify({ basis: "state", basisPath: payload.basisPaths[0], basisField: payload.basisField, grade: grade.cell }),
    nullReason: null,
  };
}

/**
 * Validate one person-sourced finding (R-28). The person is not the
 * state: there is no truth to recompute against, so findings are
 * shape-checked (type + range by dataKind) and grade-capped only —
 * the record marks single-source. On the `lies` branch the values
 * are disposition-computed and shape-identical to `answers` by
 * construction; the engine never labels them false (§8.2).
 */
export function validatePersonFinding(
  question: QuestionSpec,
  grade: PerQuestionGrade,
  payload: { value: number | string | null; personRef: string },
  citableBaseline: string | null
): IntelFinding {
  const unit = question.dataKind;
  if (question.dataKind === "attitude" && citableBaseline === null) {
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "baseline", personRef: payload.personRef, citableBaseline }),
      nullReason: "BASELINE_UNRATIFIED_SOURCE",
    };
  }
  if (!grade.knowable) {
    if (payload.value !== null) {
      throw new RipeningPreparationError(
        `Question ${question.questionId} is ${grade.reason} (grade ${grade.cell}): the payload asserts a value where none is knowable from this source.`
      );
    }
    return {
      metric: question.questionId,
      value: null,
      unit,
      note: JSON.stringify({ basis: "grade", cell: grade.cell, personRef: payload.personRef }),
      nullReason: grade.reason,
    };
  }
  const value = payload.value;
  switch (question.dataKind) {
    case "count":
    case "money":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new RipeningPreparationError(`Question ${question.questionId}: a non-negative number is required.`);
      }
      break;
    case "share":
    case "condition":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        throw new RipeningPreparationError(`Question ${question.questionId}: a 0–100 number is required.`);
      }
      break;
    case "identity-of":
      if (typeof value !== "string" || value.length === 0) {
        throw new RipeningPreparationError(`Question ${question.questionId}: an identity-of finding names a record id.`);
      }
      break;
    case "attitude":
      break;
  }
  return {
    metric: question.questionId,
    value,
    unit,
    note: JSON.stringify({ basis: "person", personRef: payload.personRef, grade: grade.cell }),
    nullReason: null,
  };
}

/**
 * Validate the full generated payload of a delivery. Fails LOUD
 * (RipeningPreparationError → the generation-failure path: NO
 * partial delivery, the pending's attempts increment, the matter
 * stays pending for attention) on: a question count mismatch, an
 * undeclared question, a value where a null is required, a
 * recomputation disagreement, a missing insider disposition citation,
 * or an insider finding asserted on a `refuses`/`reports` branch.
 * §9.2: a payload that cannot be validated has no lawful content to
 * write — failure is the mechanic.
 */
export function validateDeliveryFindings(
  snapshot: SimSnapshot,
  spec: DeliverySpec,
  prepared: PreparedPayload,
  citableBaseline: string | null
): { findings: IntelFinding[]; branch: "answers" | "refuses" | "lies" | "reports" | null } {
  const content = prepared.generatedContent as Record<string, unknown> | null;
  if (!content || typeof content !== "object") {
    throw new RipeningPreparationError("Delivery generation produced no payload.");
  }
  const rawFindings = content.findings;
  if (!Array.isArray(rawFindings)) {
    throw new RipeningPreparationError("Delivery payload has no findings array.");
  }
  if (rawFindings.length !== spec.questions.length) {
    throw new RipeningPreparationError(
      `Delivery payload covers ${rawFindings.length} findings for ${spec.questions.length} commissioned questions — exactly one finding per question is required.`
    );
  }

  let branch: "answers" | "refuses" | "lies" | "reports" | null = null;
  if (spec.insider !== null) {
    const asserted = content.branch;
    if (asserted !== "answers" && asserted !== "refuses" && asserted !== "lies" && asserted !== "reports") {
      throw new RipeningPreparationError("Insider delivery carries no disposition branch (answers/refuses/lies/reports).");
    }
    branch = asserted;
    const dispositionCitations = strList(content.dispositionCitations);
    if (dispositionCitations.length === 0) {
      throw new RipeningPreparationError(
        "Insider disposition branches resolve from established interests/loyalties — the payload names no record of any."
      );
    }
    if (branch === "refuses" || branch === "reports") {
      for (const raw of rawFindings) {
        const item = raw as Record<string, unknown>;
        if (item.value !== null && item.value !== undefined) {
          throw new RipeningPreparationError(
            `Insider disposition ${branch}: every finding must be null — the source gave nothing.`
          );
        }
      }
      const findings = spec.questions.map((question) => ({
        metric: question.questionId,
        value: null as number | string | null,
        unit: question.dataKind,
        note: JSON.stringify({ basis: "disposition", branch, personRef: spec.insider!.personRef }),
        nullReason: (branch === "refuses" ? "SOURCE_REFUSED" : "SOURCE_REPORTED") as NullReason,
      }));
      return { findings, branch };
    }
  }

  const findings = spec.questions.map((question) => {
    const grade = spec.grading.perQuestion[question.questionId];
    if (!grade) {
      throw new RipeningPreparationError(`No frozen grade for question ${question.questionId}.`);
    }
    const raw = rawFindings.find(
      (item) => (item as Record<string, unknown>).questionId === question.questionId
    ) as Record<string, unknown> | undefined;
    if (!raw) {
      throw new RipeningPreparationError(`No finding for commissioned question ${question.questionId}.`);
    }
    if (spec.insider !== null) {
      return validatePersonFinding(
        question,
        grade,
        { value: (raw.value as number | string | null) ?? null, personRef: spec.insider.personRef },
        citableBaseline
      );
    }
    return validateStateFinding(
      snapshot,
      question,
      grade,
      {
        value: (raw.value as number | string | null) ?? null,
        basisPaths: strList(raw.basisPaths),
        basisField: str(raw.basisField) ?? "",
      },
      citableBaseline
    );
  });
  return { findings, branch };
}

/**
 * Build the intel record (design §10.1): the survey/run record maps
 * onto the landed `sim_intel_records` shape. `reliability` is the
 * provenance the deal-portal export rule (CJ round 3) later keys on —
 * which means was used, what it was when, and the frozen grading.
 */
export function buildIntelRecord(args: {
  deliveryResolutionId: string;
  collectedAtSeq: number;
  spec: DeliverySpec;
  findings: IntelFinding[];
  coverage: { achievedPct: number; capPct: number; fundedCapPct: number; targetPopulationText: string; knownUnknowns: string[] } | null;
  spanUnverifiable: boolean;
  bandDroppedAtDelivery: boolean;
  meansSnapshot: Record<string, unknown> | null;
  reliabilityNotes: string[];
}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    collectorUid: args.spec.collectorUid,
    collectorCityId: args.spec.collectorCityId,
    targetCityId: args.spec.targetCityId,
    targetBusinessId: args.spec.targetBusinessId,
    method: {
      kindLabel: args.spec.kindLabel,
      methodRef: args.spec.methodRef,
    },
    collectionResolutionId: args.deliveryResolutionId,
    collectedAtSeq: args.collectedAtSeq,
    coverage: args.coverage,
    reliability: {
      band: args.spec.grading.band,
      bandDroppedAtDelivery: args.bandDroppedAtDelivery,
      axisScores: args.spec.grading.axisScores,
      axisSum: args.spec.grading.axisSum,
      gradingBasisRows: args.spec.grading.basisRows,
      commissionSeq: args.spec.commissionSeq,
      meansSnapshot: args.meansSnapshot,
      meansSnapshotHash: args.spec.meansSnapshotHash,
      spanUnverifiable: args.spanUnverifiable,
      notes: args.reliabilityNotes,
    },
    findings: args.findings.map((finding) => ({
      metric: finding.metric,
      value: finding.value,
      unit: finding.unit,
      note: finding.note,
    })),
    nullReasons: args.findings
      .filter((finding) => finding.nullReason !== null)
      .map((finding) => `${finding.metric}:${finding.nullReason}`),
    // Firestore-doc discipline (fixtures carry these; the committer
    // stamps the nulls).
    stateVersion: 1,
    createdByResolutionId: args.deliveryResolutionId,
    createdAt: null,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
}

/**
 * The delivery effect — the applier reference implementation. Given a
 * validated delivery it produces the entry plan for the ripening
 * resolution: the intel record write, the means-status write when
 * discovery burns it, the posture record write, the discovery's
 * public entry, the insider offer's pay leg, and the narrative
 * intents. The Lead's ripening branch dispatches delivery kinds to
 * this function (prep report §5).
 */
export function applyDeliveryEffect(
  snapshot: SimSnapshot,
  spec: DeliverySpec,
  pendingId: string,
  actor: SimActor,
  intelDoc: Record<string, unknown>,
  intelPath: string,
  discovery: {
    outcome: DiscoveryOutcome;
    exposureBand: ExposureBand;
    counterPosture: CounterPosture;
  } | null,
  extra: {
    findings: IntelFinding[];
    branch: "answers" | "refuses" | "lies" | "reports" | null;
  }
): {
  planEntries: LogEntryDraft[];
  writes: { path: string; doc: Record<string, unknown> | null }[];
  pendingTransition: "ripens" | "voids";
  voidReason: string | null;
} {
  const planEntries: LogEntryDraft[] = [];
  const writes: { path: string; doc: Record<string, unknown> | null }[] = [];
  const deliveryResolutionId = `ripen_${pendingId}`;
  const covert = spec.visibilityClass === "actor-private";

  writes.push({ path: intelPath, doc: intelDoc });

  // The means may be burned/retired by the delivery's own discovery.
  if (discovery !== null && discovery.outcome === "discovered" && spec.meansId !== null) {
    const means = snapshotDoc(snapshot, meansPath(spec.meansId));
    if (means !== null) {
      const current = means.status as MeansStatus;
      const exposure = spec.foreign && discovery.exposureBand === "severe";
      const next: MeansStatus = exposure || current === "compromised" ? "burned" : "compromised";
      const updated = withDocField(withDocField(means, "status", next), "statusResolutionId", deliveryResolutionId);
      writes.push({ path: meansPath(spec.meansId), doc: updated });
    }
  }

  // The posture record keeps prior suspicion + burned contacts
  // (§7.4/C-6): fabric-only, never client-readable. Created or folded
  // here, never left half-written.
  const posture = spec.foreign ? snapshotDoc(snapshot, posturePath(spec.targetCityId)) : null;
  if (posture !== null || (discovery !== null && discovery.outcome !== "undiscovered")) {
    const base: Record<string, unknown> =
      posture !== null
        ? { ...posture }
        : { schemaVersion: 2, cityId: spec.targetCityId, priorSuspected: false, suspicionCount: 0, burnedContactRefs: [] };
    const burned = strList(base.burnedContactRefs);
    if (discovery !== null && discovery.outcome === "suspected") {
      base.priorSuspected = true;
      base.suspicionCount = (base.suspicionCount as number) + 1;
      base.lastSuspectedByResolutionId = deliveryResolutionId;
    }
    if (discovery !== null && discovery.outcome === "discovered") {
      base.priorSuspected = true;
      base.suspicionCount = (base.suspicionCount as number) + 1;
      base.lastDiscoveryResolutionId = deliveryResolutionId;
    }
    if (extra.branch === "reports" && spec.insider !== null) {
      if (!burned.includes(spec.insider.personRef)) burned.push(spec.insider.personRef);
      base.burnedContactRefs = burned;
    }
    base.updatedByResolutionId = deliveryResolutionId;
    writes.push({ path: posturePath(spec.targetCityId), doc: base });
  }

  // (The insider offer's money leg is assembled by buildDeliveryPlan
  // — city-doc writes need their change lines, and `changes[]` for a
  // city doc is the builder's to reconcile.)

  // The covert/own-log entry: what the intel is, how it was got, and
  // why the grade says what it says — always for the actor.
  const ruleEffect = ruleEffectDraft({
    cityId: spec.foreign ? spec.targetCityId : spec.collectorCityId,
    actor,
    ruleIds: [spec.ruleId],
    summaryText: spec.insider !== null
      ? `Insider ask delivered (${spec.insider.personRef}, disposition ${extra.branch}): ${extra.findings.filter((f) => f.value !== null).length}/${extra.findings.length} questions returned.`
      : `${spec.foreign ? "Cross-city collection" : "Survey"} delivered: ${extra.findings.filter((f) => f.value !== null).length}/${extra.findings.length} questions returned at band ${spec.grading.band}.`,
    changes: [],
    recordsCreated: [intelPath],
    recordsUpdated: [],
    classification: covert
      ? {
          visibility: "actor-private",
          delivery: true,
          ruleId: spec.ruleId,
          deliveryResolutionId,
          commissionSeq: spec.commissionSeq,
        }
      : { delivery: true, ruleId: spec.ruleId, deliveryResolutionId, commissionSeq: spec.commissionSeq },
  });
  planEntries.push(ruleEffect);

  // Discovery surfaces the covert run as a discovery — by citation
  // (the public entry carries the resolution ids; the covert entries
  // are never mutated). CJ round 2: the public Log learns of the run
  // ONLY here.
  if (discovery !== null && discovery.outcome === "discovered") {
    planEntries.push(
      ruleEffectDraft({
        cityId: spec.targetCityId,
        actor,
        ruleIds: [spec.ruleId],
        summaryText: `Discovery: a covert collection against ${spec.targetCityId} was caught. The acting city is ${spec.collectorCityId}; the means record (${spec.meansId ?? "none"}) stands adjusted by this delivery. Consequences, if any, follow the target users' own actions — no case opens automatically (CJ round 2). Discovery stat costs (law −2, influence −1) are Phase 7 resolutions that cite this entry; the world ledger records them as DUE, not as applied (design §7.4).`,
        changes: [],
        recordsCreated: [],
        recordsUpdated: spec.meansId !== null ? [meansPath(spec.meansId), posturePath(spec.targetCityId)] : [posturePath(spec.targetCityId)],
        classification: {
          visibility: "public",
          discovery: true,
          outcome: "discovered",
          exposureBand: discovery.exposureBand,
          counterPosture: discovery.counterPosture,
          commissionSeq: spec.commissionSeq,
          deliveryResolutionId,
          meansId: spec.meansId,
          consequencesDue: { law: -2, influence: -1, appliedBy: "phase-7-consequence-track" },
        },
      })
    );
  }

  return {
    planEntries,
    writes,
    pendingTransition: "ripens",
    voidReason: null,
  };
}

/**
 * The full delivery plan builder — the reference implementation the
 * Lead's ripening branch produces per delivery (design §§8–10,
 * prep report §5). Runs entirely off the landed machinery: the plan
 * it returns passes the real `validatePlan` unchanged (proven by the
 * harness — no special ripening entrypoints anywhere).
 */
export function buildDeliveryPlan(
  snapshot: SimSnapshot,
  pending: Record<string, unknown>,
  opts: {
    prepared: PreparedPayload;
    citableBaseline: string | null;
  }
): ResolutionPlan {
  const pendingId = str(pending.pendingId) ?? "";
  const payloadSpec = (pending.payloadSpec ?? {}) as Record<string, unknown>;
  const spec = payloadSpec.delivery as DeliverySpec | undefined;
  if (!spec) {
    throw new RipeningPreparationError("Delivery pending carries no delivery spec.");
  }
  const ruleId = spec.ruleId;
  const descriptorId = ruleId;
  const deliveryResolutionId = `ripen_${pendingId}`;
  const originActor = (pending.originActor ?? { type: "member", memberId: spec.collectorUid }) as SimActor;
  const plan = emptyPlan(descriptorId);

  // Means re-check at delivery: a means dissolved, burned, or built
  // out from under the run cannot deliver under a grade it no longer
  // holds (§9.1 source 1; H-1's "window changed" reading). Existing-
  // means commissions with a terminal means still deliver — the
  // record notes the terminal status in reliability.notes.
  let means: Record<string, unknown> | null = null;
  if (spec.meansId !== null) {
    means = snapshotDoc(snapshot, meansPath(spec.meansId));
    if (means === null) {
      throw new RipeningPreparationError(
        "The means record no longer stands — the delivery has nothing to grade against."
      );
    }
  }

  const { findings, branch } = validateDeliveryFindings(snapshot, spec, opts.prepared, opts.citableBaseline);

  // H-1 delivery span: named structures still standing / named count.
  let spanAtDelivery: number | null = null;
  let spanUnverifiable = false;
  if (spec.scopeKind === "named-structures" && spec.structureIds.length > 0) {
    const standing = spec.structureIds.filter((id) => {
      const doc = snapshotDoc(snapshot, `sim_cities/${spec.targetCityId}/structures/${id}`);
      return doc !== null && doc.status !== "demolished";
    }).length;
    spanAtDelivery = standing / spec.structureIds.length;
  }
  if (spec.grading.spanFractionAtCommission !== null && spanAtDelivery === null && spec.scopeKind === "named-structures") {
    spanUnverifiable = true;
  }

  // Coverage: min(fundedCap, delivery-span coverage), floored; null
  // span ⇒ coverage null + the reason vocabulary (§9.3/H-1).
  let coverage: { achievedPct: number; capPct: number; fundedCapPct: number; targetPopulationText: string; knownUnknowns: string[] } | null = null;
  let bandDroppedAtDelivery = false;
  const reliabilityNotes: string[] = [];
  if (spanUnverifiable) {
    bandDroppedAtDelivery = true;
    reliabilityNotes.push(
      `SPAN_UNVERIFIABLE: the commissioned segment could not be recomputed at delivery — coverage null, band drops one step (${spec.grading.band} → ${oneBandLower(spec.grading.band)}).`
    );
  } else {
    const fundedCap = spec.grading.fundedCapPct;
    const spanPct = spanAtDelivery === null ? 100 : Math.floor(spanAtDelivery * 100);
    const achievedPct = Math.min(fundedCap, spanPct);
    coverage = {
      achievedPct,
      capPct: spec.grading.coverageCapPct,
      fundedCapPct: fundedCap,
      targetPopulationText:
        spec.scopeKind === "whole-city"
          ? `all of ${spec.targetCityId}`
          : spec.scopeKind === "structure-type"
            ? `${spec.structureType ?? "the"} structures of ${spec.targetCityId}`
            : spec.scopeKind === "named-structures"
              ? `${spanAtDelivery === null ? spec.structureIds.length : spec.structureIds.length} named structures of ${spec.targetCityId}`
              : `the ${spec.targetBusinessId ?? "named"} business of ${spec.targetCityId}`,
      knownUnknowns: buildKnownUnknowns(spec, findings, spanAtDelivery),
    };
  }

  // Means terminal-status note.
  if (means !== null) {
    const status = effectiveMeansStatus(snapshot, means);
    if (status === "compromised" || status === "burned" || status === "dissolved") {
      reliabilityNotes.push(`Means status at delivery: ${status} — the record notes the terminal status it was collected under.`);
    }
  }

  // No-return-path at delivery nulls the whole payload with a reason
  // (design §9.4: the delivery still lands). The return path is the
  // commission grading's own test: resident apparatus, or a live
  // connection home.
  const residentAtDelivery =
    means !== null && (str(means.hostCityId) ?? str(means.ownerCityId)) === spec.targetCityId;
  const returnPath =
    !spec.foreign || residentAtDelivery || hasLiveConnectionBetween(snapshot, spec.collectorCityId, spec.targetCityId);
  let finalFindings = findings;
  if (spec.foreign && !returnPath) {
    finalFindings = spec.questions.map((question) => ({
      metric: question.questionId,
      value: null as number | string | null,
      unit: question.dataKind,
      note: JSON.stringify({ basis: "freshness", at: "delivery" }),
      nullReason: "NO_RETURN_PATH" as NullReason,
    }));
    reliabilityNotes.push("NO_RETURN_PATH: the means' return path was gone at delivery — every finding is null.");
  }

  // Discovery, recomputed against the delivery world's facts (design
  // §7.3: the table is deterministic — replay shows the same cell).
  let discovery: { outcome: DiscoveryOutcome; exposureBand: ExposureBand; counterPosture: CounterPosture } | null = null;
  if (spec.visibilityClass === "actor-private") {
    const profile = means !== null ? meansProfileOf(means) : null;
    const targetCity = snapshotDoc(snapshot, `sim_cities/${spec.targetCityId}`);
    const targetLaw = num(targetCity, "stats.law");
    const counterActive = counterMeansActiveIn(snapshot, spec.targetCityId, spec.collectorCityId);
    const posture = snapshotDoc(snapshot, posturePath(spec.targetCityId));
    const storedDelay = (pending.delayDerivation ?? {}) as Record<string, unknown>;
    const delayHours = typeof storedDelay.minWallElapsedHours === "number" ? storedDelay.minWallElapsedHours : 0;
    const exposure = computeExposureBand({
      observationClass: profile?.observationClass ?? "observation",
      targetLaw,
      counterMeansActive: counterActive,
      delayHours,
    });
    const postureBand = counterPostureBand({
      targetLaw,
      counterMeansActive: counterActive,
      priorSuspected: posture?.priorSuspected === true,
    });
    const outcome = evaluateDiscovery(exposure.band, postureBand);
    discovery = { outcome, exposureBand: exposure.band, counterPosture: postureBand };
  }

  // The offer's pay leg: paid only on the `answers` branch.
  const offerRubars = spec.insider !== null && branch === "answers" ? spec.insider.offerRubars : 0;
  const payLeg = offerRubars > 0;

  // The intel record's collectedAtSeq is the delivery resolution's own
  // summary seq: head + entries, where the entry layout is [rule
  // effect] + [pay entry iff an offer is paid] + [discovery entry iff
  // discovered] + [summary]. The intel path is deterministic from the
  // pending id (design §10.1).
  const summarySeq =
    snapshot.counterHead.lastSeq +
    2 +
    (payLeg ? 1 : 0) +
    (discovery !== null && discovery.outcome === "discovered" ? 1 : 0);
  const intelPath = `sim_intel_records/intel_${deliveryResolutionId}`;
  const intelDoc = buildIntelRecord({
    deliveryResolutionId,
    collectedAtSeq: summarySeq,
    spec,
    findings: finalFindings,
    coverage,
    spanUnverifiable,
    bandDroppedAtDelivery,
    meansSnapshot: means !== null ? { ...means } : null,
    reliabilityNotes,
  });

  const effect = applyDeliveryEffect(snapshot, spec, pendingId, originActor, intelDoc, intelPath, discovery, {
    findings: finalFindings,
    branch,
  });

  // Entry assembly: the covert/own-log rule effect first, the pay
  // entry (insider offer paid), the public discovery entry
  // (discovered only), the summary LAST — so the summary's seq
  // (counterHead + entries) matches the collectedAtSeq the intel
  // record asserts. The harness pins this layout.
  for (const entry of effect.planEntries) plan.entries.push(entry);
  if (payLeg && spec.insider !== null) {
    const payeeCityId = spec.insider.personBusinessHomeCityId ?? spec.insider.personCityId;
    const corpPath = `sim_cities/${payeeCityId}/corporations/${spec.insider.personBusinessId ?? ""}`;
    const actorCityDoc = snapshotDoc(snapshot, `sim_cities/${spec.collectorCityId}`);
    const actorTreasury = num(actorCityDoc, "stats.treasuryRubars") ?? 0;
    const corpDoc = snapshotDoc(snapshot, corpPath);
    const corpCash = corpDoc !== null ? (num(corpDoc, "companyCashRubars") ?? 0) : null;
    if (actorCityDoc === null || corpDoc === null) {
      // An owed payment whose records are absent from the delivery
      // snapshot is an assembly breach — fail loud (generation
      // failure), never skip a payment silently.
      throw new RipeningPreparationError(
        "Insider offer is owed (answers branch) but the treasury or payee record is absent from the delivery snapshot."
      );
    }
    if (corpCash !== null) {
      planWrite(plan, snapshot, `sim_cities/${spec.collectorCityId}`, withDocField(actorCityDoc, "stats.treasuryRubars", actorTreasury - offerRubars));
      planWrite(plan, snapshot, corpPath, withDocField(corpDoc, "companyCashRubars", corpCash + offerRubars));
      plan.entries.push(
        ruleEffectDraft({
          cityId: spec.collectorCityId,
          actor: originActor,
          ruleIds: [ruleId],
          summaryText: `Insider offer paid: ${offerRubars} Rubar from ${spec.collectorCityId}'s treasury to the person of record's business (${corpPath}) — paid only because the disposition was answers; the offer is refused/lost on every other branch.`,
          changes: [
            fieldChange({ cityId: spec.collectorCityId, field: "stats.treasuryRubars", before: actorTreasury, after: actorTreasury - offerRubars, unit: "rubars", note: "insider offer paid (answers branch)" }),
          ],
          recordsCreated: [],
          recordsUpdated: [corpPath],
          classification: { visibility: "actor-private", payLeg: true, ruleId, deliveryResolutionId },
        })
      );
    }
  }
  if (discovery !== null && discovery.outcome === "suspected") {
    plan.narrativeOutputs.push({
      kind: "note",
      text: `situation-intent: the ${spec.collectorCityId} apparatus notes unattributed foreign contact near ${spec.targetCityId} (exposure ${discovery.exposureBand}, posture ${discovery.counterPosture}). For the target's Situations inbox via the Phase 5 consumer; this is NOT a discovery.`,
    });
  }
  if (discovery !== null && discovery.outcome === "discovered") {
    plan.narrativeOutputs.push({
      kind: "note",
      text: `situation-intent: public discovery of covert collection against ${spec.targetCityId} (attributed to ${spec.collectorCityId}; exposure ${discovery.exposureBand}). For the target's Situations inbox via the Phase 5 consumer; case creation remains the target users' own action.`,
    });
  }
  plan.entries.push(
    summaryDraft({
      cityId: spec.foreign ? spec.targetCityId : spec.collectorCityId,
      actor: originActor,
      ruleIds: [ruleId],
      summaryText: spec.insider !== null
        ? `Insider ask delivery against ${spec.targetCityId} (disposition ${branch}): ${finalFindings.filter((f) => f.value !== null).length}/${finalFindings.length} answered. ${discovery !== null ? `Discovery: ${discovery.outcome}.` : ""}`
        : `${spec.foreign ? "Cross-city collection" : "Survey"} delivery against ${spec.targetCityId}: ${finalFindings.filter((f) => f.value !== null).length}/${finalFindings.length} answered at band ${spec.grading.band}${bandDroppedAtDelivery ? " (dropped one step: span unverifiable)" : ""}. ${discovery !== null ? `Discovery: ${discovery.outcome}.` : ""}`,
      classification: spec.visibilityClass === "actor-private"
        ? {
            visibility: "actor-private",
            summary: true,
            ruleId,
            deliveryResolutionId,
            discovery: discovery?.outcome ?? "none",
            commissionSeq: spec.commissionSeq,
          }
        : { summary: true, ruleId, deliveryResolutionId, discovery: discovery?.outcome ?? "none", commissionSeq: spec.commissionSeq },
    })
  );

  for (const write of effect.writes) planWrite(plan, snapshot, write.path, write.doc);

  // The pending transitions to ripened. The committer's generic
  // stamp writes the ripened markers onto the pending doc.
  plan.pendingTransitions.push({
    pendingId,
    toStatus: "ripened",
    outcomeSummary: `${ruleId} delivery: ${finalFindings.filter((f) => f.value !== null).length}/${finalFindings.length} findings at band ${spec.grading.band}; discovery ${discovery?.outcome ?? "n/a"}.`,
  });

  // F-02: the entries touch the intel record, the posture record, the
  // means record, and (insider) the payee corporation — all non-city
  // paths, so `changes[]` stays empty and the records claims carry
  // the reconciliation. validatePlan agrees (proven in the harness).
  return plan;
}

function oneBandLower(band: ReliabilityBand): ReliabilityBand {
  const order: ReliabilityBand[] = ["A", "B", "C", "D"];
  return order[Math.min(order.indexOf(band) + 1, 3)];
}

function buildKnownUnknowns(
  spec: DeliverySpec,
  findings: IntelFinding[],
  spanAtDelivery: number | null
): string[] {
  const notes: string[] = [];
  if (spanAtDelivery !== null && spanAtDelivery < 1) {
    notes.push(
      `Segments beyond the means' recorded span (${Math.floor(spanAtDelivery * 100)}% standing at delivery) are not observed.`
    );
  } else if (spanAtDelivery === null && spec.scopeKind === "whole-city") {
    notes.push("Whole-city collection: unspanned segments are named here as whole districts, not records.");
  }
  for (const finding of findings) {
    if (finding.nullReason !== null) {
      notes.push(`${finding.metric}: ${finding.nullReason}.`);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Commission machinery (design §§3–8)
//
// Commission handlers build their delivery pending drafts directly in
// the landed doc shape (mirroring buildPendingDraft field-for-field),
// because buildPendingDraft's audience default seats the TARGET's
// owners in audienceUids — and pending reads are audience-fenced in
// the landed rules, so that default would leak a covert run to its
// target. Covert pendings seat the actor + the actor's city owners
// only. The committed stamps (createdBySeq / originSeq /
// ripenCondition.requiredSeq / eligibleAt) are the committer's, as
// with every pending — the drafts carry them null.
// ---------------------------------------------------------------------------

function deterministicPendingId(resolutionId: string, kind: string, index: number): string {
  return `pend_${sha256Hex(`${resolutionId}:${kind}:${index}`).slice(0, 16)}`;
}

function draftPendingId(draft: PendingDraft): string {
  return draft.doc.pendingId as string;
}

interface DeliveryPendingArgs {
  kind: string;
  resolutionId: string;
  action: SimAction;
  actorCityId: string;
  targetCityId: string;
  spec: DeliverySpec;
  delay: { minWallElapsedHours: number; minSeqAdvance: number };
  delayDerivation: Record<string, unknown>;
  preconditions: StructuredPrecondition[];
  voidEffects: { type: "stat-delta"; cityId: string; field: string; delta: number }[];
  audienceUids: string[];
  summaryText: string;
}

function buildDeliveryPendingDraft(args: DeliveryPendingArgs): PendingDraft {
  const pendingId = deterministicPendingId(args.resolutionId, args.kind, 0);
  const payloadSpec: Record<string, unknown> = {
    mode: "generative",
    ruleId: args.spec.ruleId,
    delivery: args.spec as unknown as Record<string, unknown>,
    voidEffects: args.voidEffects,
  };
  return {
    doc: {
      pendingId,
      schemaVersion: 2,
      kind: args.kind,
      status: "pending",
      originResolutionId: args.resolutionId,
      originActionId: args.action.actionId,
      originActor: args.action.actor,
      originCityId: args.actorCityId,
      originSummaryText: args.summaryText,
      targetCityId: args.targetCityId,
      sourceKind: "action",
      generation: 1,
      chainId: pendingId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      createdBySeq: null,
      createdAtSeq: null,
      createdAt: null,
      originSeq: null,
      ripenCondition: {
        type: "player-action",
        requiredActionKinds: [],
        minSeqAdvance: args.delay.minSeqAdvance,
        minWallElapsedHours: args.delay.minWallElapsedHours,
        requiredSeq: null, // committer-stamped: originSeq + minSeqAdvance
        eligibleAt: null, // committer-stamped: commit time + minWallElapsedHours
        preconditions: args.preconditions,
      },
      delayDerivation: args.delayDerivation,
      payloadSpec,
      creationSnapshot: {
        targetStats: {},
        ruleInputs: { kind: args.kind, targetCityId: args.targetCityId },
      },
      audienceUids: args.audienceUids,
      claim: null,
      attempts: 0,
      needsAttention: false,
      referencedByRefKeys: [],
      stateVersion: 1,
      ripenedAtSeq: null,
      ripenedAt: null,
      ripensInResolutionId: null,
      voidedAtSeq: null,
      voidReason: null,
      outcomeSummary: null,
      updatedAt: null,
    } as unknown as PendingDraft["doc"],
  };
}

function parseQuestions(raw: unknown, max: number): { questions: QuestionSpec[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "The action names no questions." };
  if (raw.length > max) return { error: `At most ${max} questions per commission (got ${raw.length}).` };
  const seen = new Set<string>();
  const questions: QuestionSpec[] = [];
  for (const item of raw) {
    const q = item as Record<string, unknown>;
    const questionId = str(q.questionId);
    const text = str(q.text);
    const dataKind = q.dataKind as DataKind;
    if (!questionId || !text || !(DATA_KINDS as readonly string[]).includes(dataKind)) {
      return { error: "Every question needs a questionId, a text, and a dataKind from the published set." };
    }
    if (seen.has(questionId)) return { error: `Duplicate questionId ${questionId}.` };
    seen.add(questionId);
    const sourceScope = q.sourceScope === "private-records" ? "private-records" : q.sourceScope === "published-layer" ? "published-layer" : "public-state";
    questions.push({ questionId, text, dataKind, sourceScope });
  }
  return { questions };
}

function parseTarget(raw: unknown): { target: SurveyTargetSpec } | { error: string } {
  const t = (raw ?? {}) as Record<string, unknown>;
  const scopeKind = t.scopeKind as ScopeKind;
  if (!(scopeKind in SCOPE_COST_FACTORS)) {
    return { error: "target.scopeKind must be one of whole-city / structure-type / named-structures / business-staff / business-customers." };
  }
  return {
    target: {
      scopeKind,
      structureType: str(t.structureType),
      structureIds: strList(t.structureIds),
      businessId: str(t.businessId),
      businessHomeCityId: str(t.businessHomeCityId),
    },
  };
}

/** Segment existence (gate 2, Specificity): the commissioned segment
 * must resolve to records — a segment that does not stand cannot be
 * collected over, and the refusal names it. */
function checkSegmentExists(
  ctx: HandlerContext,
  targetCityId: string,
  target: SurveyTargetSpec
): string | null {
  if (target.scopeKind === "named-structures") {
    if (target.structureIds.length === 0) return "named-structures scope names no structures.";
    for (const id of target.structureIds) {
      const doc = snapshotDoc(ctx.snapshot, `sim_cities/${targetCityId}/structures/${id}`);
      if (!doc) return `Structure ${id} does not stand in ${targetCityId}.`;
    }
  }
  if (target.scopeKind === "structure-type") {
    if (!target.structureType) return "structure-type scope names no structure kind.";
    const docs = queryDocs(ctx.snapshot, STRUCTURES_QUERY_ID, `sim_cities/${targetCityId}/structures`);
    if (docs === null) return "READ_PLAN_MISSING: the target structures query was not materialized.";
    if (!docs.some(([, doc]) => doc.kind === target.structureType)) {
      return `No structure of kind ${target.structureType} stands in ${targetCityId}.`;
    }
  }
  if (target.scopeKind === "business-staff" || target.scopeKind === "business-customers") {
    if (!target.businessId || !target.businessHomeCityId) {
      return "business scope needs businessId + businessHomeCityId.";
    }
    const corp = snapshotDoc(
      ctx.snapshot,
      `sim_cities/${target.businessHomeCityId}/corporations/${target.businessId}`
    );
    if (!corp) return `Corporation ${target.businessId} does not stand in ${target.businessHomeCityId}.`;
    const markets = strList(corp.marketCityIds);
    if (target.businessHomeCityId !== targetCityId && !markets.includes(targetCityId)) {
      return `Corporation ${target.businessId} does not operate in ${targetCityId} (its marketCityIds do not name it).`;
    }
  }
  return null;
}

interface CommissionOutcome {
  plan: ResolutionPlan;
}

/**
 * The shared commission core for R-25 (domestic survey) and R-27
 * (cross-city run): means resolution (existing or buildMeans), the
 * five gates in the design's order (2 → 3 → 5 → 1 → 4 — Specificity,
 * Investment, Knowability+Boundary, Plausibility, Exposure), grading,
 * the §2.4 budget-class funding arithmetic, the delay derivation, the
 * delivery pending, and the entries. The narrative-only escape is
 * available ONLY when the intake payload declared
 * `intent: "narrative-only"` before preview (§3.4) — a gate failure
 * otherwise rejects, loudly, with the gate named.
 */
function runCommission(
  ctx: HandlerContext,
  args: {
    descriptorId: string;
    ruleId: "R-25" | "R-27";
    foreign: boolean;
  }
): CommissionOutcome {
  const { descriptorId, ruleId } = args;
  const foreign = args.foreign;
  const covert = ruleId === "R-27";
  const action = ctx.action;
  const payload = sa(action);
  const actorCityId = actionCityId(action);
  const intent = str(payload.intent);
  const narrativeEscape = (): ResolutionPlan | null => {
    if (intent !== "narrative-only") return null;
    const plan = emptyPlan(descriptorId);
    plan.entries.push(
      summaryDraft({
        cityId: actorCityId,
        actor: ctx.action.actor,
        ruleIds: [ruleId],
        summaryText: `Narrative-only ${ruleId} commission (declared at intake): the attempt is recorded; no data is collected, no record is written, nothing ripens.`,
        classification: covert
          ? { visibility: "actor-private", narrativeOnly: true, ruleId }
          : { narrativeOnly: true, ruleId },
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  };
  const gateFailure = (code: string, summaryText: string): ResolutionPlan => {
    const escape = narrativeEscape();
    if (escape) return escape;
    return rejectedPlan(descriptorId, code, [ruleId], summaryText);
  };

  // Authority + actor form.
  const authorityFailure = requireActingAuthority(ctx, descriptorId, ruleId, actorCityId);
  if (authorityFailure) return { plan: authorityFailure };
  const npcFailure = rejectNpcActor(ctx, descriptorId, ruleId);
  if (npcFailure) return { plan: npcFailure };

  // Payload shape.
  const parsedQuestions = parseQuestions(payload.questions, foreign ? 8 : 12);
  if ("error" in parsedQuestions) {
    return { plan: rejectedPlan(descriptorId, "QUESTION_SET_INVALID", [ruleId], parsedQuestions.error) };
  }
  const questions = parsedQuestions.questions;
  const parsedTarget = parseTarget(payload.target);
  if ("error" in parsedTarget) {
    return { plan: rejectedPlan(descriptorId, "TARGET_INVALID", [ruleId], parsedTarget.error) };
  }
  const target = parsedTarget.target;
  const targetCityId = foreign ? str(payload.targetCityId) ?? "" : actorCityId;
  if (foreign && !targetCityId) {
    return { plan: rejectedPlan(descriptorId, "NO_TARGET_CITY", [ruleId], "A collection run names its target city.") };
  }
  if (foreign && targetCityId === actorCityId) {
    return { plan: rejectedPlan(descriptorId, "DOMESTIC_USE_SURVEY", [ruleId], "A run against your own city is a survey (R-25), not a collection run.") };
  }
  if (!foreign && str(payload.targetCityId) !== null && str(payload.targetCityId) !== actorCityId) {
    return { plan: rejectedPlan(descriptorId, "CROSS_CITY_USE_COLLECTION_RUN", [ruleId], "A survey of another city is a collection run (R-27).") };
  }
  const targetCity = snapshotDoc(ctx.snapshot, `sim_cities/${targetCityId}`);
  if (!targetCity) {
    return { plan: rejectedPlan(descriptorId, "NO_CITY", [ruleId], `Target city ${targetCityId} does not stand in the sim.`) };
  }

  // Gate 5 (Knowability boundary) runs before any grading: a question
  // aimed at the private tier is refused BY CONSTRUCTION — the read
  // plan never contained those paths.
  const boundaryQuestion = questions.find((q) => q.sourceScope === "private-records");
  if (boundaryQuestion) {
    return {
      plan: gateFailure(
        "BOUNDARY_PRIVATE_TIER",
        `Question ${boundaryQuestion.questionId} targets owner-private records (raw intel, Situations, drafts, mandate text, unpublished allocations). That tier is not a collection target: it is reachable, if at all, through a granted record (R-29) or a person (R-28) — never by grading. Refused by construction.`
      ),
    };
  }

  // Gate 2 (Specificity): the segment must resolve to records.
  const segmentError = checkSegmentExists(ctx, targetCityId, target);
  if (segmentError) {
    return { plan: gateFailure("GATE_SPECIFICITY", `Specificity: ${segmentError}`) };
  }

  // Means resolution (gate 3, Investment, begins here).
  let means: Record<string, unknown> | null = null;
  let meansId: string | null = null;
  let buildMeansDoc: Record<string, unknown> | null = null;
  let buildCostRubars = 0;
  const buildRaw = payload.buildMeans as Record<string, unknown> | undefined;
  const existingMeansId = str(payload.meansId);
  if (buildRaw && typeof buildRaw === "object") {
    const validated = validateVehicleAndProfile(ctx, descriptorId, ruleId, actorCityId, buildRaw);
    if ("plan" in validated) return { plan: validated.plan };
    meansId = `means_${ctx.resolutionId}`;
    buildCostRubars = validated.operatingCostRubars;
    buildMeansDoc = {
      schemaVersion: 2,
      meansId,
      ownerCityId: actorCityId,
      ownerUid: action.actor.memberId ?? action.actor.onBehalfOfMemberId ?? "",
      vehicle: validated.vehicle,
      profile: validated.profile,
      scopeKind: foreign ? "foreign" : "domestic",
      namedTargetCityIds: foreign ? [targetCityId] : [],
      hostCityId: actorCityId,
      operatingCostRubars: validated.operatingCostRubars,
      status: "building",
      activatesAtSeq: null, // set below, once the delay is derived
      createdByResolutionId: ctx.resolutionId,
      createdAtSeq: null, // set below (the resolution's summary seq)
      stateVersion: 1,
      createdAt: null,
      lastChangedSeq: null,
      lastResolutionId: null,
    };
    means = buildMeansDoc;
  } else if (existingMeansId !== null) {
    meansId = existingMeansId;
    means = snapshotDoc(ctx.snapshot, meansPath(existingMeansId));
    if (means === null) {
      return {
        plan: gateFailure(
          "NO_MEANS",
          `No means: the named means record ${existingMeansId} does not stand. Without a means there is no collection — no data is fabricated to fill the gap (CJ: means before data).`
        ),
      };
    }
    if (means.ownerCityId !== actorCityId) {
      return {
        plan: gateFailure(
          "MEANS_NOT_OWNED",
          `Means ${existingMeansId} belongs to ${String(means.ownerCityId)} — another city's apparatus is not yours to run. (Use of a shared means rides an R-29 grant; grants are Phase 5 substrate.)`
        ),
      };
    }
    const createdBy = str(means.createdByResolutionId);
    const createdAtSeq = num(means, "createdAtSeq");
    if (!createdBy || createdAtSeq === null || createdAtSeq > ctx.snapshot.counterHead.lastSeq) {
      return {
        plan: gateFailure(
          "GATE_INVESTMENT",
          `Means ${existingMeansId} carries no lawful provenance (createdByResolutionId ${createdBy ?? "absent"}, createdAtSeq ${createdAtSeq ?? "absent"}) — a retroactive or future-dated means fails the Investment gate: the investment must precede the data.`
        ),
      };
    }
    const status = effectiveMeansStatus(ctx.snapshot, means);
    if (status === "dissolved") {
      return { plan: gateFailure("MEANS_DISSOLVED", `Means ${existingMeansId} stands dissolved; a dissolved apparatus collects nothing.`) };
    }
    if (status === "burned") {
      return { plan: gateFailure("MEANS_BURNED", `Means ${existingMeansId} stands burned; it collects nothing ever again.`) };
    }
    if (status === "building") {
      return { plan: gateFailure("MEANS_NOT_ACTIVE", `Means ${existingMeansId} is still building — its vehicle has not completed. The data waits for the apparatus.`) };
    }
  } else {
    return {
      plan: gateFailure(
        "NO_MEANS",
        "No means: the action names neither an existing means record nor a buildMeans apparatus to stand up. Without a means there is no collection — no data is fabricated to fill the gap (CJ: means before data)."
      ),
    };
  }
  if (means === null || meansId === null) {
    return { plan: rejectedPlan(descriptorId, "NO_MEANS", [ruleId], "Means resolution failed.") };
  }

  // Gate 3 (Investment): the apparatus must cost something real, and
  // a foreign-named means inside a domestic commission (or the
  // reverse) is a scope mismatch, not a shortcut.
  const referenceCost = num(means, "operatingCostRubars") ?? 0;
  if (referenceCost <= 0) {
    return {
      plan: gateFailure(
        "GATE_INVESTMENT",
        `Means ${meansId} declares an operating cost of ${referenceCost} — a means that costs nothing is not an apparatus. The Investment gate requires a real, recorded cost (the F9 free-means fixture fails here by construction).`
      ),
    };
  }
  const operatingCost = operatingCostForScope(referenceCost, target);
  if (operatingCost <= 0) {
    return { plan: gateFailure("GATE_INVESTMENT", "The commissioned scope prices to zero — no lawful collection is free.") };
  }

  // Grading (one function; frozen into the pending below).
  const structures = queryDocs(ctx.snapshot, STRUCTURES_QUERY_ID, `sim_cities/${targetCityId}/structures`);
  const counterActive = foreign ? counterMeansActiveIn(ctx.snapshot, targetCityId, actorCityId) : false;
  const grading = gradeCollection(ctx.snapshot, {
    means,
    targetCityId,
    foreign,
    questions,
    targetStructures: structures,
    target,
    counterMeansActive: counterActive,
    singleSourceClamp: false,
  });
  if (grading.band === null) {
    return {
      plan: gateFailure(
        "REJECTED_GRADE_SUM",
        `Grading rejects: axis sum ${grading.axisSum} (reach ${grading.axisScores.reach} + access ${grading.axisScores.access} + granularity ${grading.axisScores.granularity} + freshness ${grading.axisScores.freshness}) is below the band table's floor of 3. The refusal is logged with the grading and its basis; no data exists to deliver.`
      ),
    };
  }
  if (grading.axisScores.freshness === 0) {
    return {
      plan: gateFailure(
        "NO_RETURN_PATH",
        "Freshness 0: the means has no return path — results cannot come back, so the collection is unreachable by construction (design §5.6)."
      ),
    };
  }

  // Gate 1 (Plausibility): the approach must fit the world's physical
  // and legal facts. The coded rows decidable from the lawful read
  // set: a means' declared scope must reach the commissioned target —
  // a domestic-scoped apparatus does not run foreign collections, and
  // a foreign apparatus naming other targets does not survey home.
  // (The vehicle's own records ride the delivery spec's readPaths, so
  // a vehicle that vanishes mid-window is named in the delivery's
  // reliability notes — the commission snapshot cannot lawfully
  // contain them under the one-pass seed contract.)
  const vehicle = (means.vehicle ?? {}) as Record<string, unknown>;
  const vehiclePaths = strList(vehicle.recordIds);
  const meansScope = str(means.scopeKind) ?? "domestic";
  const namedTargets = strList(means.namedTargetCityIds);
  if (foreign && meansScope === "domestic") {
    return {
      plan: gateFailure(
        "GATE_PLAUSIBILITY",
        `Plausibility: means ${meansId} is domestic-scoped — its apparatus does not reach ${targetCityId}. A foreign run needs a foreign/both-scoped means.`
      ),
    };
  }
  if (foreign && namedTargets.length > 0 && !namedTargets.includes(targetCityId)) {
    return {
      plan: gateFailure(
        "GATE_PLAUSIBILITY",
        `Plausibility: means ${meansId} names target(s) [${namedTargets.join(", ")}] — ${targetCityId} is not among them. The apparatus was built for somewhere else.`
      ),
    };
  }
  if (!foreign && meansScope === "foreign" && namedTargets.length > 0 && !namedTargets.includes(actorCityId)) {
    return {
      plan: gateFailure(
        "GATE_PLAUSIBILITY",
        `Plausibility: means ${meansId} is a foreign apparatus aimed at [${namedTargets.join(", ")}] — it does not survey ${actorCityId}.`
      ),
    };
  }

  // Gate 4 (Exposure) — cross-city only; the preview states the cell.
  const profile = meansProfileOf(means);
  const connected = foreign
    ? hasLiveConnectionBetween(ctx.snapshot, actorCityId, targetCityId)
    : true;
  const delay = deriveCollectionDelay({
    scopeKind: target.scopeKind,
    band: grading.band,
    freshnessClass: profile.freshnessClass,
    foreign,
    connected,
  });
  let exposurePreview: { band: ExposureBand; posture: CounterPosture; outcome: DiscoveryOutcome } | null = null;
  if (foreign) {
    const targetLaw = num(targetCity, "stats.law");
    const postureDoc = snapshotDoc(ctx.snapshot, posturePath(targetCityId));
    const exposure = computeExposureBand({
      observationClass: profile.observationClass,
      targetLaw,
      counterMeansActive: counterActive,
      delayHours: delay.minWallElapsedHours,
    });
    const postureBand = counterPostureBand({
      targetLaw,
      counterMeansActive: counterActive,
      priorSuspected: postureDoc?.priorSuspected === true,
    });
    exposurePreview = {
      band: exposure.band,
      posture: postureBand,
      outcome: evaluateDiscovery(exposure.band, postureBand),
    };
  }

  // Funding (§2.4 budget class): budget caps coverage pro-rata; the
  // TREASURY refuses in full on shortfall — never a partial debit.
  const budget = payload.budgetRubars;
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0 || !Number.isInteger(budget)) {
    return { plan: rejectedPlan(descriptorId, "BUDGET_INVALID", [ruleId], "budgetRubars must be a non-negative whole-Rubar figure.") };
  }
  if (budget === 0) {
    return {
      plan: gateFailure(
        "INSUFFICIENT_BUDGET",
        "A zero budget funds zero coverage — the commission is refused rather than run for free (a free collection would be fabrication's cousin)."
      ),
    };
  }
  const fundedCapPct =
    budget >= operatingCost
      ? grading.coverageCapPct
      : Math.floor(grading.coverageCapPct * (budget / operatingCost));
  const totalDebit = buildCostRubars + operatingCost;
  const actorCity = snapshotDoc(ctx.snapshot, `sim_cities/${actorCityId}`);
  const treasury = num(actorCity, "stats.treasuryRubars");
  if (treasury === null || treasury < totalDebit) {
    return {
      plan: rejectedPlan(
        descriptorId,
        "INSUFFICIENT_TREASURY",
        [ruleId],
        `Treasury shortfall (budget class, §2.4): the commission debits ${totalDebit} Rubar (build ${buildCostRubars} + operating ${operatingCost}) against a treasury of ${treasury ?? "unset"}. Refused in full — no partial debit, no negative treasury.`
      ),
    };
  }

  // The delivery pending.
  const summarySeq = ctx.snapshot.counterHead.lastSeq + 2; // [rule-effect, summary]
  if (buildMeansDoc !== null) {
    buildMeansDoc.activatesAtSeq = ctx.snapshot.counterHead.lastSeq + delay.minSeqAdvance;
    buildMeansDoc.createdAtSeq = summarySeq;
  }
  const meansSnapshotHash = sha256Hex(canonicalJson(projectFirestoreValue(means)));
  const spec: DeliverySpec = {
    ruleId,
    visibilityClass: covert ? "actor-private" : "public",
    questions,
    targetCityId,
    targetBusinessId: target.businessId,
    targetBusinessHomeCityId: target.businessHomeCityId,
    scopeKind: target.scopeKind,
    structureType: target.structureType,
    structureIds: target.structureIds,
    foreign,
    meansId,
    meansSnapshotHash,
    grading: {
      band: grading.band,
      coverageCapPct: grading.coverageCapPct,
      fundedCapPct,
      perQuestion: grading.perQuestion,
      axisScores: grading.axisScores,
      axisSum: grading.axisSum,
      spanFractionAtCommission: grading.spanFraction,
      basisRows: grading.basisRows,
    },
    collectorUid: action.actor.memberId ?? action.actor.onBehalfOfMemberId ?? "",
    collectorCityId: actorCityId,
    methodRef: `means:${meansId}@${str(means.createdByResolutionId) ?? ctx.resolutionId}`,
    kindLabel: ruleId === "R-25" ? "survey" : "collection-run",
    commissionSeq: summarySeq,
    singleSourceClamp: false,
    readPaths: [
      meansPath(meansId),
      ...vehiclePaths,
      `sim_cities/${targetCityId}`,
      ...(foreign ? [posturePath(targetCityId)] : []),
      ...target.structureIds.map((id) => `sim_cities/${targetCityId}/structures/${id}`),
      ...(target.businessId && target.businessHomeCityId
        ? [`sim_cities/${target.businessHomeCityId}/corporations/${target.businessId}`]
        : []),
    ],
    buildMeans: buildMeansDoc !== null,
    voidRefundRubars: Math.max(0, totalDebit - buildCostRubars),
    insider: null,
  };
  const preconditions: StructuredPrecondition[] = [];
  if (buildMeansDoc !== null) {
    const activatesAtSeq = buildMeansDoc.activatesAtSeq as number;
    preconditions.push(
      {
        // The apparatus record was erased (its commission undone)
        // before the survey matured — the delivery voids with it.
        type: "record-exists",
        path: meansPath(meansId),
        field: null,
        operator: "exists",
        value: null,
        onFalse: "void",
      },
      {
        // The apparatus was dissolved before its first delivery —
        // the survey it was built for voids (§3.4).
        type: "record-field-equals",
        path: meansPath(meansId),
        field: "status",
        operator: "!=",
        value: "dissolved",
        onFalse: "void",
      },
      {
        type: "record-field-gt",
        path: "sim_counters/log",
        field: "lastSeq",
        operator: ">",
        value: activatesAtSeq - 1,
        onFalse: "wait",
      }
    );
  }
  const voidEffects =
    spec.voidRefundRubars > 0
      ? [{ type: "stat-delta" as const, cityId: actorCityId, field: "stats.treasuryRubars", delta: spec.voidRefundRubars }]
      : [];
  const faction = snapshotDoc(ctx.snapshot, `factions/${actorCityId}`);
  const ownerUids = Array.isArray(faction?.ownerUids) ? (faction.ownerUids as string[]) : [];
  const audienceUids = covert
    ? [...new Set([spec.collectorUid, ...ownerUids].filter((u) => u.length > 0))]
    : [...new Set([spec.collectorUid, ...ownerUids, ...(Array.isArray(snapshotDoc(ctx.snapshot, `factions/${targetCityId}`)?.ownerUids) ? (snapshotDoc(ctx.snapshot, `factions/${targetCityId}`)!.ownerUids as string[]) : [])].filter((u) => u.length > 0))];
  const draft = buildDeliveryPendingDraft({
    kind: ruleId === "R-25" ? SURVEY_DELIVERY_KIND : COLLECTION_DELIVERY_KIND,
    resolutionId: ctx.resolutionId,
    action,
    actorCityId,
    targetCityId,
    spec,
    delay,
    delayDerivation: {
      baseHours: delay.baseHours,
      bandFactor: delay.bandFactor,
      freshnessFactor: delay.freshnessFactor,
      distanceFactor: delay.distanceFactor,
      minWallElapsedHours: delay.minWallElapsedHours,
      minSeqAdvance: delay.minSeqAdvance,
    },
    preconditions,
    voidEffects,
    audienceUids,
    summaryText: `${ruleId} commission by ${actorCityId} over ${targetCityId} (band ${grading.band}, funded cap ${fundedCapPct}%).`,
  });

  // Entries + writes.
  const plan = emptyPlan(descriptorId);
  const afterTreasury = treasury - totalDebit;
  planWrite(plan, ctx.snapshot, `sim_cities/${actorCityId}`, withDocField(actorCity as Record<string, unknown>, "stats.treasuryRubars", afterTreasury));
  if (buildMeansDoc !== null) {
    planWrite(plan, ctx.snapshot, meansPath(meansId), buildMeansDoc);
  }
  plan.pendingCreates.push(draft);
  const classification: Record<string, unknown> = {
    commission: true,
    ruleId,
    meansId,
    buildMeans: buildMeansDoc !== null,
    band: grading.band,
    axisScores: grading.axisScores,
    axisSum: grading.axisSum,
    coverageCapPct: grading.coverageCapPct,
    fundedCapPct,
    operatingCostRubars: operatingCost,
    buildCostRubars,
    budgetRubars: budget,
    delay: { minWallElapsedHours: delay.minWallElapsedHours, minSeqAdvance: delay.minSeqAdvance },
    deliveryPendingId: draftPendingId(draft),
    questions: questions.map((q) => ({ questionId: q.questionId, verdict: grading.perQuestion[q.questionId]?.verdict, reason: grading.perQuestion[q.questionId]?.reason })),
  };
  if (covert) classification.visibility = "actor-private";
  if (exposurePreview !== null) {
    classification.exposurePreview = exposurePreview;
  }
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: [ruleId],
      summaryText:
        `${ruleId === "R-25" ? "Survey" : "Collection run"} commissioned over ${targetCityId}: band ${grading.band} (sum ${grading.axisSum}), funded coverage cap ${fundedCapPct}% of a ${grading.coverageCapPct}% band cap; debited ${totalDebit} Rubar (build ${buildCostRubars} + operating ${operatingCost}). Delivery ripens after ≥${delay.minSeqAdvance} seqs and ≥${delay.minWallElapsedHours}h in a player-caused wake.` +
        (exposurePreview !== null
          ? ` Exposure preview: ${exposurePreview.band} vs posture ${exposurePreview.posture} → ${exposurePreview.outcome} (recomputed at delivery).`
          : ""),
      changes: [
        fieldChange({ cityId: actorCityId, field: "stats.treasuryRubars", before: treasury, after: afterTreasury, unit: "rubars", note: `${ruleId} commission debit` }),
      ],
      recordsCreated: buildMeansDoc !== null ? [meansPath(meansId)] : [],
      recordsUpdated: [],
      classification,
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: [ruleId],
      summaryText: `${ruleId} commission stands: delivery pending ${draftPendingId(draft)} will ripen into the results record — owner-private on delivery${covert ? ", invisible to the public Log unless discovered" : ""}.`,
      classification: covert
        ? { visibility: "actor-private", summary: true, ruleId, deliveryPendingId: draftPendingId(draft) }
        : { summary: true, ruleId, deliveryPendingId: draftPendingId(draft) },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return { plan };
}

/** Vehicle + profile validation shared by establish_means and the
 * commission's buildMeans path (design §5.1 + gates 2/3 at
 * establishment: the vehicle's assets must be enumerable records of
 * the actor's own city, and the apparatus must cost something). */
function validateVehicleAndProfile(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string,
  actorCityId: string,
  raw: Record<string, unknown>
): { vehicle: Record<string, unknown>; profile: Record<string, unknown>; operatingCostRubars: number } | { plan: ResolutionPlan } {
  const vehicleRaw = (raw.vehicle ?? {}) as Record<string, unknown>;
  const vehicleRuleId = str(vehicleRaw.ruleId);
  if (vehicleRuleId !== "R-05" && vehicleRuleId !== "R-06" && vehicleRuleId !== "R-08") {
    return {
      plan: rejectedPlan(
        descriptorId,
        vehicleRuleId === "mandate" ? "MANDATE_DATA_ABSENT" : "VEHICLE_INVALID",
        [ruleId],
        `A means stands on a vehicle record: an R-05 project, an R-06 corporation, or an R-08 law. ${vehicleRuleId ?? "No vehicle"} is none of those${vehicleRuleId === "mandate" ? " — mandate vehicles are Phase 5 data" : ""}.`
      ),
    };
  }
  const recordIds = strList(vehicleRaw.recordIds);
  if (recordIds.length === 0) {
    return {
      plan: rejectedPlan(descriptorId, "GATE_SPECIFICITY", [ruleId], "Specificity: the vehicle's assets must be enumerable record paths — an apparatus that cannot be enumerated does not exist."),
    };
  }
  for (const path of recordIds) {
    if (!path.startsWith(`sim_cities/${actorCityId}/`)) {
      return {
        plan: rejectedPlan(descriptorId, "VEHICLE_NOT_OWNED", [ruleId], `Vehicle record ${path} is not a record of ${actorCityId} — you cannot build your apparatus out of another city's assets.`),
      };
    }
    if (snapshotDoc(ctx.snapshot, path) === null) {
      return {
        plan: rejectedPlan(descriptorId, "VEHICLE_RECORD_ABSENT", [ruleId], `Vehicle record ${path} does not stand in the world.`),
      };
    }
  }
  const profileRaw = (raw.profile ?? {}) as Record<string, unknown>;
  let observationClass = str(profileRaw.observationClass);
  if (observationClass !== null && !(OBSERVATION_CLASSES as readonly string[]).includes(observationClass)) {
    // A novel class is lawful ONLY with a prepared classification
    // assigning it to a coded class (design §5.1); unclassifiable
    // novelty carries no grade and is refused by name.
    const classified = str(profileRaw.classifiedClass);
    if (classified === null || !(OBSERVATION_CLASSES as readonly string[]).includes(classified)) {
      return {
        plan: rejectedPlan(
          descriptorId,
          "NOVEL_CLASS_UNCLASSIFIED",
          [ruleId],
          `Observation class "${observationClass}" is not one of the six coded classes, and the payload carries no prepared classification assigning it to one. An unclassifiable method carries no grade — refused, not waved through. (Baseline-dependent classification with no citable Baseline refuses as BASELINE_UNRATIFIED.)`
        ),
      };
    }
    observationClass = classified;
  }
  if (observationClass === null) {
    return { plan: rejectedPlan(descriptorId, "PROFILE_INVALID", [ruleId], "The means profile names no observation class.") };
  }
  const axis = (value: unknown): number | null =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  const reach = axis(profileRaw.reach);
  const access = axis(profileRaw.access);
  if (reach === null || access === null) {
    return { plan: rejectedPlan(descriptorId, "PROFILE_INVALID", [ruleId], "Profile reach/access must be whole grades 0–3.") };
  }
  const granularityKinds = strList(profileRaw.granularityKinds).filter((k) =>
    (DATA_KINDS as readonly string[]).includes(k)
  );
  const freshnessClass = profileRaw.freshnessClass;
  if (freshnessClass !== "standing" && freshnessClass !== "dispatch" && freshnessClass !== "none") {
    return { plan: rejectedPlan(descriptorId, "PROFILE_INVALID", [ruleId], "Profile freshnessClass must be standing / dispatch / none.") };
  }
  const operatingCostRubars = raw.operatingCostRubars;
  if (typeof operatingCostRubars !== "number" || !Number.isInteger(operatingCostRubars) || operatingCostRubars <= 0) {
    return {
      plan: rejectedPlan(descriptorId, "GATE_INVESTMENT", [ruleId], "Investment: a means must declare a positive whole-Rubar operating cost — an apparatus that costs nothing is not an apparatus."),
    };
  }
  return {
    vehicle: {
      ruleId: vehicleRuleId,
      recordIds,
      completionText: str(vehicleRaw.completionText) ?? "",
    },
    profile: {
      observationClass,
      reach,
      access,
      granularityKinds,
      freshnessClass,
    },
    operatingCostRubars,
  };
}

// ---------------------------------------------------------------------------
// R-26 — establish / dissolve a means (design §5.1)
// ---------------------------------------------------------------------------

function establishMeans(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-26";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, "R-26", actorCityId);
  if (authorityFailure) return authorityFailure;
  const npcFailure = rejectNpcActor(ctx, descriptorId, "R-26");
  if (npcFailure) return npcFailure;
  const validated = validateVehicleAndProfile(ctx, descriptorId, "R-26", actorCityId, payload);
  if ("plan" in validated) return validated.plan;

  const meansId = `means_${ctx.resolutionId}`;
  const scopeKind = payload.scopeKind === "foreign" || payload.scopeKind === "both" ? payload.scopeKind : "domestic";
  const namedTargetCityIds = strList(payload.namedTargetCityIds);
  const hostCityId = str(payload.hostCityId) ?? actorCityId;
  const meansDoc: Record<string, unknown> = {
    schemaVersion: 2,
    meansId,
    ownerCityId: actorCityId,
    ownerUid: ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "",
    vehicle: validated.vehicle,
    profile: validated.profile,
    scopeKind,
    namedTargetCityIds,
    hostCityId,
    operatingCostRubars: validated.operatingCostRubars,
    status: "building", // effective status is derived; set below
    activatesAtSeq: null,
    createdByResolutionId: ctx.resolutionId,
    createdAtSeq: ctx.snapshot.counterHead.lastSeq + 2,
    stateVersion: 1,
    createdAt: null,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
  meansDoc.status = effectiveMeansStatus(ctx.snapshot, meansDoc) === "active" ? "active" : "building";
  const crosses = scopeKind !== "domestic" && namedTargetCityIds.length > 0;

  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, meansPath(meansId), meansDoc);
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: crosses ? ["R-26", "R-27"] : ["R-26"],
      summaryText: `Means established: ${meansId} (${String(validated.profile.observationClass)} apparatus on ${String(validated.vehicle.ruleId)} vehicle records [${(validated.vehicle.recordIds as string[]).join(", ")}]), operating cost ${validated.operatingCostRubars} Rubar, status ${String(meansDoc.status)}.` +
        (crosses
          ? ` The means names foreign target(s) [${namedTargetCityIds.join(", ")}] — classified under R-27 at establishment (gates 2 Specificity + 3 Investment passed on the vehicle records); the full five-gate pipeline runs at every commission.`
          : ""),
      changes: [],
      recordsCreated: [meansPath(meansId)],
      recordsUpdated: [],
      classification: { meansId, status: meansDoc.status, scopeKind, crosses },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-26"],
      summaryText: `Means record ${meansId} stands (${String(meansDoc.status)}). Data may now be commissioned against it — never before it.`,
      classification: { summary: true, meansId },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function dissolveMeans(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-26";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, "R-26", actorCityId);
  if (authorityFailure) return authorityFailure;
  const meansId = str(payload.meansId);
  if (meansId === null) {
    return rejectedPlan(descriptorId, "NO_MEANS_ID", ["R-26"], "dissolve_means names no meansId.");
  }
  const means = snapshotDoc(ctx.snapshot, meansPath(meansId));
  if (means === null) {
    return rejectedPlan(descriptorId, "NO_MEANS", ["R-26"], `Means ${meansId} does not stand.`);
  }
  if (means.ownerCityId !== actorCityId) {
    return rejectedPlan(descriptorId, "MEANS_NOT_OWNED", ["R-26"], `Means ${meansId} belongs to ${String(means.ownerCityId)}.`);
  }
  if (means.status === "dissolved") {
    return rejectedPlan(descriptorId, "ALREADY_DISSOLVED", ["R-26"], `Means ${meansId} already stands dissolved.`);
  }
  const plan = emptyPlan(descriptorId);
  planWrite(
    plan,
    ctx.snapshot,
    meansPath(meansId),
    withDocField(withDocField(means, "status", "dissolved"), "statusResolutionId", ctx.resolutionId)
  );
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-26"],
      summaryText: `Means dissolved: ${meansId} stands dissolved by its owner's act. It collects nothing from here; deliveries already commissioned against it note the terminal status (existing-means commissions carry no status precondition — design §3.4).`,
      changes: [],
      recordsCreated: [],
      recordsUpdated: [meansPath(meansId)],
      classification: { meansId, dissolved: true },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-26"],
      summaryText: `Means ${meansId} dissolved.`,
      classification: { summary: true, meansId },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-28 — insider ask (design §8). Reachability, not consent.
// ---------------------------------------------------------------------------

const BOOKS_ROLE_PATTERN = /book|ledger|account|clerk|treasur|financ|record/i;

function insiderAsk(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-28";
  const ruleId = "R-28";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const intent = str(payload.intent);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, ruleId, actorCityId);
  if (authorityFailure) return authorityFailure;
  const npcFailure = rejectNpcActor(ctx, descriptorId, ruleId);
  if (npcFailure) return npcFailure;

  const narrativeOr = (code: string, text: string): ResolutionPlan => {
    if (intent === "narrative-only") {
      const plan = emptyPlan(descriptorId);
      plan.entries.push(
        summaryDraft({
          cityId: actorCityId,
          actor: ctx.action.actor,
          ruleIds: [ruleId],
          summaryText: `Narrative-only insider approach (declared at intake): ${text} The attempt is recorded; no answer exists.`,
          classification: { visibility: "actor-private", narrativeOnly: true, ruleId },
        })
      );
      actorCitations(plan, ctx.citations, ctx.resolutionId);
      return plan;
    }
    return rejectedPlan(descriptorId, code, [ruleId], text);
  };

  const personRef = str(payload.personRef);
  if (personRef === null) {
    return rejectedPlan(descriptorId, "NO_PERSON_REF", [ruleId], "insider_ask names no personRef.");
  }
  const personPath = `characters/${personRef}`;
  const person = snapshotDoc(ctx.snapshot, personPath);
  if (person === null) {
    return narrativeOr(
      "PERSON_NOT_ESTABLISHED",
      `Person ${personRef} is not an established record. An ask of an unestablished person has no one to ask: it resolves, if declared, as narrative color — a contact proposal, never a data source.`
    );
  }
  const personCityId = str(person.cityId) ?? "";
  if (!personCityId) {
    return rejectedPlan(descriptorId, "PERSON_RECORD_INCOMPLETE", [ruleId], `Person ${personRef} carries no cityId — the record cannot place them.`);
  }
  const citySteer = str(payload.personCityId);
  if (citySteer === null) {
    return rejectedPlan(descriptorId, "PAYLOAD_INCOMPLETE", [ruleId], "insider_ask names no personCityId — you cannot reach a person you cannot place (the read plan steers from it; the record validates it).");
  }
  if (citySteer !== personCityId) {
    return rejectedPlan(descriptorId, "PERSON_CITY_MISMATCH", [ruleId], `The payload places ${personRef} in ${citySteer}; the record places them in ${personCityId}. The steer is refused, not followed.`);
  }
  const parsedQuestion = parseQuestions([payload.question], 1);
  if ("error" in parsedQuestion) {
    return rejectedPlan(descriptorId, "QUESTION_SET_INVALID", [ruleId], `An insider ask carries exactly one question. ${parsedQuestion.error}`);
  }
  const question = parsedQuestion.questions[0];
  if (question.sourceScope === "private-records") {
    return rejectedPlan(
      descriptorId,
      "BOUNDARY_PRIVATE_TIER",
      [ruleId],
      "The question targets owner-private records by construction. A person may know things — they may not be a query interface into another owner's private tier."
    );
  }

  // The reachability gate (CJ round 2): a channel RECORD joins the
  // asker to the person. The owner's consent is never consulted.
  const channel = (payload.channel ?? {}) as Record<string, unknown>;
  const channelKind = str(channel.kind) ?? "";
  const channelPath = str(channel.recordPath) ?? "";
  let observationClass: ObservationClass = "single-source";
  let reachGrade = 1;
  let channelOk = false;
  let channelBasis = "";
  if (channelKind === "connection" && channelPath.length > 0) {
    channelOk = hasLiveConnectionBetween(ctx.snapshot, actorCityId, personCityId);
    reachGrade = 2;
    channelBasis = "a live connection record joins the two cities";
  } else if (channelKind === "presence" && channelPath.length > 0) {
    const means = snapshotDoc(ctx.snapshot, channelPath);
    if (means !== null && means.ownerCityId === actorCityId && str(means.hostCityId) === personCityId) {
      const status = effectiveMeansStatus(ctx.snapshot, means);
      channelOk = status === "active" || status === "compromised";
      reachGrade = 2;
      channelBasis = `the asker's apparatus ${channelPath} is resident in ${personCityId} (status ${status})`;
    }
  } else if (channelKind === "business" && channelPath.length > 0) {
    const corp = snapshotDoc(ctx.snapshot, channelPath);
    const uid = ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "";
    if (corp !== null && corp.ownerMemberId === uid) {
      channelOk = true;
      reachGrade = 1;
      channelBasis = `the asker's own business record ${channelPath} reaches the person`;
    }
  }
  if (!channelOk) {
    return narrativeOr(
      "GATE_REACHABILITY",
      `Reachability: no channel record joins ${actorCityId} to ${personRef} in ${personCityId}. Contact is gated by whether you can get ahold of them — not by anyone's consent — and here you cannot.`
    );
  }
  const posture = snapshotDoc(ctx.snapshot, posturePath(personCityId));
  if (posture !== null && strList(posture.burnedContactRefs).includes(personRef)) {
    return narrativeOr(
      "GATE_REACHABILITY",
      `Reachability: ${personRef} is a burned contact — they reported a prior approach, and the channel is closed. Asking again is refused by name.`
    );
  }

  // The grade comes from the person's role record (§8.2): a person
  // whose established role keeps the books grades records-access for
  // records questions; everyone else is a single source.
  const roleText = str(person.roleRecord) ?? str(person.role) ?? "";
  if (BOOKS_ROLE_PATTERN.test(roleText)) {
    observationClass = "records-access";
  }

  // The offer (design §8.1): payable only against a business record
  // resolvable from the person; paid at delivery, answers only.
  const offerRubars = typeof payload.offerRubars === "number" ? payload.offerRubars : 0;
  if (!Number.isInteger(offerRubars) || offerRubars < 0) {
    return rejectedPlan(descriptorId, "OFFER_INVALID", [ruleId], "offerRubars must be a non-negative whole-Rubar figure.");
  }
  const personBusinessId = str(person.businessId);
  const personBusinessHomeCityId = str(person.businessHomeCityId) ?? personCityId;
  if (offerRubars > 0 && personBusinessId === null) {
    return rejectedPlan(
      descriptorId,
      "OFFER_NOT_PAYABLE",
      [ruleId],
      `An offer of ${offerRubars} Rubar names no payable record on ${personRef} — the person's record carries no business to pay. The offer is refused, not escrowed into fog.`
    );
  }
  const actorCity = snapshotDoc(ctx.snapshot, `sim_cities/${actorCityId}`);
  const treasury = num(actorCity, "stats.treasuryRubars") ?? 0;
  if (offerRubars > treasury) {
    return rejectedPlan(descriptorId, "INSUFFICIENT_TREASURY", [ruleId], `The offer (${offerRubars}) exceeds the treasury (${treasury}); it is refused in full at commission, never clamped silently.`);
  }

  // Grading: the pseudo-means carries the channel's profile; the
  // single-source clamp binds by construction (§8.2).
  const pseudoMeans: Record<string, unknown> = {
    profile: {
      observationClass,
      reach: reachGrade,
      access: 2,
      granularityKinds: DATA_KINDS,
      freshnessClass: "dispatch",
    },
    hostCityId: personCityId,
    ownerCityId: actorCityId,
  };
  const grading = gradeCollection(ctx.snapshot, {
    means: pseudoMeans,
    targetCityId: personCityId,
    foreign: personCityId !== actorCityId,
    questions: [question],
    targetStructures: null,
    target: { scopeKind: "named-structures", structureType: null, structureIds: [], businessId: null, businessHomeCityId: null },
    counterMeansActive: false,
    singleSourceClamp: true,
  });
  if (grading.band === null) {
    return narrativeOr(
      "REJECTED_GRADE_SUM",
      `Grading rejects the ask: axis sum ${grading.axisSum} is below the band floor. The channel (${channelBasis}) cannot carry this question.`
    );
  }
  const delay = deriveCollectionDelay({
    scopeKind: "named-structures", // base 8h — an approach, not a census
    band: grading.band,
    freshnessClass: "dispatch",
    foreign: personCityId !== actorCityId,
    connected: channelKind === "connection",
  });
  const summarySeq = ctx.snapshot.counterHead.lastSeq + 2;
  const spec: DeliverySpec = {
    ruleId: "R-28",
    visibilityClass: "actor-private",
    questions: [question],
    targetCityId: personCityId,
    targetBusinessId: personBusinessId,
    targetBusinessHomeCityId: personBusinessHomeCityId,
    scopeKind: "named-structures",
    structureType: null,
    structureIds: [],
    foreign: personCityId !== actorCityId,
    meansId: null,
    meansSnapshotHash: sha256Hex(canonicalJson(projectFirestoreValue(person))),
    grading: {
      band: grading.band,
      coverageCapPct: grading.coverageCapPct,
      fundedCapPct: grading.coverageCapPct,
      perQuestion: grading.perQuestion,
      axisScores: grading.axisScores,
      axisSum: grading.axisSum,
      spanFractionAtCommission: null,
      basisRows: [...grading.basisRows, `Channel: ${channelBasis}. Role record: ${roleText || "(none stated)"}.`],
    },
    collectorUid: ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "",
    collectorCityId: actorCityId,
    methodRef: `contact:${personRef}@${ctx.resolutionId}`,
    kindLabel: "insider-ask",
    commissionSeq: summarySeq,
    singleSourceClamp: true,
    readPaths: [
      personPath,
      `sim_cities/${personCityId}`,
      posturePath(personCityId),
      ...(personBusinessId !== null
        ? [`sim_cities/${personBusinessHomeCityId}/corporations/${personBusinessId}`]
        : []),
    ],
    buildMeans: false,
    voidRefundRubars: 0,
    insider: {
      personRef,
      channelKind,
      offerRubars,
      personCityId,
      personBusinessId,
      personBusinessHomeCityId,
    },
  };
  const faction = snapshotDoc(ctx.snapshot, `factions/${actorCityId}`);
  const ownerUids = Array.isArray(faction?.ownerUids) ? (faction.ownerUids as string[]) : [];
  const draft = buildDeliveryPendingDraft({
    kind: INSIDER_DELIVERY_KIND,
    resolutionId: ctx.resolutionId,
    action: ctx.action,
    actorCityId,
    targetCityId: personCityId,
    spec,
    delay,
    delayDerivation: {
      baseHours: delay.baseHours,
      bandFactor: delay.bandFactor,
      freshnessFactor: delay.freshnessFactor,
      distanceFactor: delay.distanceFactor,
      minWallElapsedHours: delay.minWallElapsedHours,
      minSeqAdvance: delay.minSeqAdvance,
    },
    preconditions: [],
    voidEffects: [],
    audienceUids: [...new Set([spec.collectorUid, ...ownerUids].filter((u) => u.length > 0))],
    summaryText: `R-28 insider ask of ${personRef} by ${actorCityId} (band ${grading.band}, single-source clamp).`,
  });
  const plan = emptyPlan(descriptorId);
  plan.pendingCreates.push(draft);
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: [ruleId],
      summaryText: `Insider ask commissioned: ${personRef} in ${personCityId}, reached because ${channelBasis}. Consent was not asked — reachability is the gate (CJ round 2). Question grade ${grading.perQuestion[question.questionId]?.cell} (${observationClass}); band ${grading.band} after the single-source clamp. The disposition (answers / refuses / lies / reports) resolves at delivery from the person's established interests and loyalties — never from the asker's say-so.`,
      changes: [],
      recordsCreated: [],
      recordsUpdated: [],
      classification: {
        visibility: "actor-private",
        commission: true,
        ruleId,
        personRef,
        channelKind,
        band: grading.band,
        offerRubars,
        deliveryPendingId: draftPendingId(draft),
      },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: [ruleId],
      summaryText: `R-28 ask stands: delivery pending ${draftPendingId(draft)}. Invisible to the public Log unless the approach is reported and the run discovered.`,
      classification: { visibility: "actor-private", summary: true, ruleId, deliveryPendingId: draftPendingId(draft) },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-29 — descriptor-only stub (P4-K8). The grant substrate is Phase 5;
// the descriptor registers so classification is total, and the one
// handler exists solely to state the deferral IN THE OPEN — a silent
// narrative-only would be the failure this stub exists to prevent.
// ---------------------------------------------------------------------------

function requestAccessDeferral(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-29";
  const payload = sa(ctx.action);
  const plan = emptyPlan(descriptorId);
  plan.entries.push(
    summaryDraft({
      cityId: actionCityId(ctx.action),
      actor: ctx.action.actor,
      ruleIds: [descriptorId],
      summaryText:
        `R-29 grant-based access is DEFERRED: grant records are Phase 5 substrate and do not exist in Phase 4, so this request resolves narrative-only by design (P4-K8) — no record is read, no access is granted, nothing is collected. Stated in the open, never silently.` +
        ` Grant reference named: ${str(payload.grantRef) ?? "(none)"}. Export under a grant is OFF unless the deal terms say so (CJ round 3) — and no deal terms exist to say so yet.`,
      classification: {
        narrativeOnly: true,
        deferral: "phase-5-grant-substrate",
        exportUnderGrant: "off-unless-deal-terms",
        grantRef: str(payload.grantRef),
      },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-30 / R-31 — publish + verify (design §11). The published layer is
// speech; verification is comparison; consequences are adoption.
// ---------------------------------------------------------------------------

interface ClaimItem {
  metric: string;
  claimedValue: number | string;
  unit: string;
  sourceRef: string | null;
}

function claimItemsOf(publication: Record<string, unknown>): ClaimItem[] {
  const claims = Array.isArray(publication.claims) ? publication.claims : [];
  const items: ClaimItem[] = [];
  for (const raw of claims) {
    const item = raw as Record<string, unknown>;
    const metric = str(item.metric);
    if (metric === null) continue;
    let sourceRef = str(item.sourceRef);
    if (sourceRef === null && typeof item.note === "string") {
      try {
        const parsed = JSON.parse(item.note) as Record<string, unknown>;
        sourceRef = str(parsed.sourceRef);
      } catch {
        /* a non-JSON note carries no sourceRef — the claim stands uncited */
      }
    }
    items.push({
      metric,
      claimedValue: (item.claimedValue as number | string) ?? "",
      unit: str(item.unit) ?? "",
      sourceRef,
    });
  }
  return items;
}

/** Deep-scan for a writer-set verdict field (P4-G8-C7: there is no
 * `verified` the writer can set — the attempt itself is refused). */
function carriesVerdictField(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(carriesVerdictField);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "verified" || key === "trustTier" || key === "truthTier" || key === "verdict") return true;
    if (carriesVerdictField(child)) return true;
  }
  return false;
}

function publishClaim(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-30";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, "R-30", actorCityId);
  if (authorityFailure) return authorityFailure;
  const publicationId = str(payload.publicationId);
  if (publicationId === null) {
    return rejectedPlan(descriptorId, "NO_PUBLICATION_ID", ["R-30"], "publish_claim names no publicationId.");
  }
  const publication = snapshotDoc(ctx.snapshot, `sim_publications/${publicationId}`);
  if (publication === null) {
    return rejectedPlan(descriptorId, "NO_PUBLICATION", ["R-30"], `Publication ${publicationId} does not stand. The publication itself is the member's own create under the Phase 1 fence; this action is the fabric's logged stamp over it.`);
  }
  const uid = ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "";
  if (publication.publisherUid !== uid) {
    return rejectedPlan(descriptorId, "NOT_YOUR_PUBLICATION", ["R-30"], `Publication ${publicationId} belongs to ${String(publication.publisherUid)} — a member stamps their own claims, no one else's.`);
  }
  if (publication.cityId !== actorCityId) {
    return rejectedPlan(descriptorId, "PUBLICATION_CITY_MISMATCH", ["R-30"], `Publication ${publicationId} is filed under ${String(publication.cityId)}, not ${actorCityId}.`);
  }
  if (carriesVerdictField(publication)) {
    return rejectedPlan(
      descriptorId,
      "CLAIM_CARRIES_VERDICT_FIELD",
      ["R-30"],
      `Publication ${publicationId} carries a writer-set verdict field (verified / trustTier / truthTier / verdict). There is no such field a writer may set — tier is conferred by which collection a figure lives in, never by assertion (P4-G8-C7).`
    );
  }
  const items = claimItemsOf(publication);
  if (items.length === 0) {
    return rejectedPlan(descriptorId, "CLAIM_EMPTY", ["R-30"], `Publication ${publicationId} carries no well-formed claims.`);
  }
  const summarySeq = ctx.snapshot.counterHead.lastSeq + 2;
  const plan = emptyPlan(descriptorId);
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-30"],
      summaryText: `Claim published (stamp: owner-published · unverified): ${publicationId} v${String(publication.version ?? 1)} asserts ${items.length} figure(s) [${items.map((i) => `${i.metric}=${String(i.claimedValue)}`).join(", ")}]. Publication is speech: nothing verified moved, no ground truth changed — the claim stands open to verification (R-31) and to the consequences proof brings (scaled by lie strength).`,
      changes: [],
      recordsCreated: [],
      recordsUpdated: [],
      classification: {
        stamp: "owner-published · unverified",
        publicationId,
        version: publication.version ?? 1,
        status: publication.status ?? "published",
        claimsCount: items.length,
        claims: items.map((i) => ({ metric: i.metric, claimedValue: i.claimedValue, sourceRef: i.sourceRef })),
        publishedAtSeq: summarySeq,
      },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-30"],
      summaryText: `Publication ${publicationId} stamped owner-published · unverified at seq ${summarySeq}.`,
      classification: { summary: true, publicationId },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

export type Verdict = "agrees" | "disagrees" | "cannot-determine";
export type LieTier = "minor" | "material" | "wholesale" | null;

export interface VerificationItem {
  metric: string;
  claimedValue: number | string;
  foundValue: number | string | null;
  verdict: Verdict;
  divergencePct: number | null;
  evidenceBand: ReliabilityBand | null;
}

export interface VerificationResult {
  items: VerificationItem[];
  established: boolean;
  tier: LieTier;
  disagreesCount: number;
  cannotDetermineCount: number;
}

/** The detection threshold (design §11.2 + TC-P13(ii)): falsity is
 * ESTABLISHED only when the evidence strength suffices for the size
 * of the divergence — band D never establishes (the design's forced
 * cannot-determine); band C establishes only a divergence over the
 * minor tier's 10% line; band B/A establish any numeric divergence.
 * This is what makes the stronger lie detectable at a LOWER grade
 * than the weaker one, mechanically (P4-G8-C8). */
export function detectionEstablishes(
  band: ReliabilityBand | null,
  divergencePct: number | null
): boolean {
  if (band === null || band === "D") return false;
  if (divergencePct === null) return band === "A" || band === "B";
  if (band === "C") return divergencePct > 10;
  return divergencePct > 0;
}

/**
 * The shared verification computation (design §11.2): compare a
 * claim's figures against found figures with their evidence bands.
 * Used by R-31 (found figures from privately held intel) and by
 * adoption (found figures as declared by the report — the report is
 * itself a publication, and adoption re-derives verdicts and tier
 * from figures + bands, never adopting the report's own conclusions
 * upward). The original claim is never edited by any of this.
 */
export function computeVerification(
  claimItems: ClaimItem[],
  evidence: { metric: string; foundValue: number | string | null; band: ReliabilityBand | null }[]
): VerificationResult {
  const items: VerificationItem[] = [];
  for (const claim of claimItems) {
    const found = evidence.find((e) => e.metric === claim.metric);
    if (!found || found.foundValue === null) {
      items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: null, verdict: "cannot-determine", divergencePct: null, evidenceBand: found?.band ?? null });
      continue;
    }
    if (typeof claim.claimedValue === "number" && typeof found.foundValue === "number") {
      const divergencePct =
        Math.abs(claim.claimedValue - found.foundValue) / Math.max(1, Math.abs(found.foundValue)) * 100;
      if (divergencePct === 0) {
        items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "agrees", divergencePct: 0, evidenceBand: found.band });
      } else if (detectionEstablishes(found.band, divergencePct)) {
        items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "disagrees", divergencePct, evidenceBand: found.band });
      } else {
        items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "cannot-determine", divergencePct, evidenceBand: found.band });
      }
      continue;
    }
    const equal = claim.claimedValue === found.foundValue;
    if (equal) {
      items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "agrees", divergencePct: 0, evidenceBand: found.band });
    } else if (detectionEstablishes(found.band, null)) {
      items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "disagrees", divergencePct: null, evidenceBand: found.band });
    } else {
      items.push({ metric: claim.metric, claimedValue: claim.claimedValue, foundValue: found.foundValue, verdict: "cannot-determine", divergencePct: null, evidenceBand: found.band });
    }
  }
  const disagrees = items.filter((i) => i.verdict === "disagrees");
  const cannotDetermineCount = items.filter((i) => i.verdict === "cannot-determine").length;
  let tier: LieTier = null;
  if (disagrees.length > 0) {
    const maxDivergence = Math.max(0, ...disagrees.map((i) => i.divergencePct ?? 0));
    const noUnderlyingRecords = claimItems.every((i) => i.sourceRef === null);
    if (maxDivergence > 50 || noUnderlyingRecords) {
      tier = "wholesale";
    } else if (disagrees.length > 1 || maxDivergence > 10 || disagrees.some((i) => i.divergencePct === null)) {
      tier = "material";
    } else {
      tier = "minor";
    }
  }
  return {
    items,
    established: disagrees.length > 0,
    tier,
    disagreesCount: disagrees.length,
    cannotDetermineCount,
  };
}

/** Parse a verification report publication's comparisons (design
 * §11.2 encoded per C-5: comparisons ride the landed claims[] shape;
 * note carries compact JSON { claimRef, evidenceRefs, evidenceBand }).
 */
function reportComparisons(report: Record<string, unknown>): {
  claimPublicationId: string | null;
  evidenceRefs: string[];
  items: { metric: string; foundValue: number | string; band: ReliabilityBand | null }[];
} {
  const claims = Array.isArray(report.claims) ? report.claims : [];
  let claimPublicationId: string | null = null;
  const evidenceRefs: string[] = [];
  const items: { metric: string; foundValue: number | string; band: ReliabilityBand | null }[] = [];
  for (const raw of claims) {
    const item = raw as Record<string, unknown>;
    const metric = str(item.metric);
    if (metric === null) continue;
    let noteJson: Record<string, unknown> = {};
    if (typeof item.note === "string") {
      try {
        noteJson = JSON.parse(item.note) as Record<string, unknown>;
      } catch {
        /* free-text note — no comparison data */
      }
    }
    const claimRef = str(noteJson.claimRef) ?? str(item.sourceRef);
    if (claimRef !== null) claimPublicationId = claimRef;
    for (const ref of strList(noteJson.evidenceRefs)) {
      if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);
    }
    const bandRaw = str(noteJson.evidenceBand);
    const band = bandRaw === "A" || bandRaw === "B" || bandRaw === "C" || bandRaw === "D" ? bandRaw : null;
    items.push({ metric, foundValue: (item.claimedValue as number | string) ?? "", band });
  }
  return { claimPublicationId, evidenceRefs, items };
}

function loadReportAndClaim(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string,
  reportPublicationId: string | null
): { report: Record<string, unknown>; claim: Record<string, unknown>; claimPublicationId: string; comparisons: ReturnType<typeof reportComparisons> } | { plan: ResolutionPlan } {
  if (reportPublicationId === null) {
    return { plan: rejectedPlan(descriptorId, "NO_REPORT_ID", [ruleId], "The action names no reportPublicationId.") };
  }
  const report = snapshotDoc(ctx.snapshot, `sim_publications/${reportPublicationId}`);
  if (report === null) {
    return { plan: rejectedPlan(descriptorId, "NO_REPORT", [ruleId], `Verification report ${reportPublicationId} does not stand. The report itself is a member publication (Phase 1 fence); this action is the fabric's logged comparison over it.`) };
  }
  const comparisons = reportComparisons(report);
  if (comparisons.claimPublicationId === null) {
    return { plan: rejectedPlan(descriptorId, "REPORT_NAMES_NO_CLAIM", [ruleId], `Report ${reportPublicationId} cites no claim publication — a verification report must name the claim it verifies.`) };
  }
  const claimSteer = str(sa(ctx.action).claimPublicationId);
  if (claimSteer !== null && claimSteer !== comparisons.claimPublicationId) {
    return { plan: rejectedPlan(descriptorId, "REPORT_CLAIM_MISMATCH", [ruleId], `The payload steers to claim ${claimSteer}; the report cites ${comparisons.claimPublicationId}. The steer is refused, not followed.`) };
  }
  const claim = snapshotDoc(ctx.snapshot, `sim_publications/${comparisons.claimPublicationId}`);
  if (claim === null) {
    return { plan: rejectedPlan(descriptorId, "CLAIM_NOT_FOUND", [ruleId], `Claim publication ${comparisons.claimPublicationId} does not stand.`) };
  }
  return { report, claim, claimPublicationId: comparisons.claimPublicationId, comparisons };
}

function publishVerification(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-31";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, "R-31", actorCityId);
  if (authorityFailure) return authorityFailure;
  const uid = ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "";
  const loaded = loadReportAndClaim(ctx, descriptorId, "R-31", str(payload.reportPublicationId));
  if ("plan" in loaded) return loaded.plan;
  const { report, claim, claimPublicationId, comparisons } = loaded;
  if (report.publisherUid !== uid) {
    return rejectedPlan(descriptorId, "NOT_YOUR_REPORT", ["R-31"], `Report belongs to ${String(report.publisherUid)} — the verifier logs their own comparison, no one else's.`);
  }
  // The evidence fence (the resolver-mirror of the rules read fence):
  // verification runs against intel the verifier HOLDS. Nothing here
  // reads another member's private records into a verdict.
  const evidence: { metric: string; foundValue: number | string | null; band: ReliabilityBand | null }[] = [];
  for (const ref of comparisons.evidenceRefs) {
    const intel = snapshotDoc(ctx.snapshot, ref);
    if (intel === null) {
      return rejectedPlan(descriptorId, "EVIDENCE_ABSENT", ["R-31"], `Cited evidence record ${ref} does not stand.`);
    }
    const collectorCityFaction = snapshotDoc(ctx.snapshot, `factions/${String(intel.collectorCityId)}`);
    const collectorOwners = Array.isArray(collectorCityFaction?.ownerUids) ? (collectorCityFaction.ownerUids as string[]) : [];
    if (intel.collectorUid !== uid && !collectorOwners.includes(uid)) {
      return rejectedPlan(
        descriptorId,
        "EVIDENCE_NOT_HELD",
        ["R-31"],
        `Evidence record ${ref} is not held by the verifier — verification compares against privately held intel, and another collector's raw records are not the verifier's to cite.`
      );
    }
    const bandRaw = (intel.reliability as Record<string, unknown> | undefined)?.band;
    const band = bandRaw === "A" || bandRaw === "B" || bandRaw === "C" || bandRaw === "D" ? bandRaw : null;
    const findings = Array.isArray(intel.findings) ? intel.findings : [];
    for (const raw of findings) {
      const finding = raw as Record<string, unknown>;
      const metric = str(finding.metric);
      if (metric === null) continue;
      evidence.push({ metric, foundValue: (finding.value as number | string | null) ?? null, band });
    }
  }
  // Declared found-values in the report are cross-checked against the
  // held intel; the COMPUTED comparison stands either way, and any
  // override is named in the entry (the report's own conclusions are
  // never adopted upward).
  const result = computeVerification(claimItemsOf(claim), evidence);
  const declaredMismatch: string[] = [];
  for (const declared of comparisons.items) {
    const computed = result.items.find((i) => i.metric === declared.metric);
    if (computed && computed.foundValue !== null && declared.foundValue !== computed.foundValue) {
      declaredMismatch.push(declared.metric);
    }
  }
  const plan = emptyPlan(descriptorId);
  plan.entries.push(
    ruleEffectDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-31"],
      summaryText:
        `Verification published against claim ${claimPublicationId}: ${result.items.map((i) => `${i.metric} ${i.verdict}${i.divergencePct !== null ? ` (${i.divergencePct.toFixed(1)}% divergence)` : ""}`).join("; ")}.` +
        (result.established
          ? ` Falsity ESTABLISHED at tier ${result.tier} — consequences do not move until a member adopts this report (R-30 adoption); the claim itself is never edited.`
          : ` No falsity established — weak evidence returns cannot-determine, never a manufactured debunking.`) +
        (declaredMismatch.length > 0
          ? ` The report's declared figures for [${declaredMismatch.join(", ")}] disagreed with the held intel; the computed comparison stands.`
          : ""),
      changes: [],
      recordsCreated: [],
      recordsUpdated: [],
      classification: {
        reportPublicationId: str(payload.reportPublicationId),
        claimPublicationId,
        verdicts: result.items,
        established: result.established,
        tier: result.tier,
        evidenceRefs: comparisons.evidenceRefs,
      },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-31"],
      summaryText: `Verification over ${claimPublicationId} stands in the Log: established=${result.established}${result.tier ? `, tier=${result.tier}` : ""}, cannot-determine=${result.cannotDetermineCount}. No state moved; the original claim is untouched.`,
      classification: { summary: true, claimPublicationId, established: result.established, tier: result.tier },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

/** v2 R-30's lie-strength tiers, applied at adoption (design §11.3). */
export const LIE_TIER_DELTAS: Record<Exclude<LieTier, null>, { law: number; influence: number }> = {
  minor: { law: -1, influence: -1 },
  material: { law: -3, influence: -2 },
  wholesale: { law: -5, influence: -3 },
};

function adoptVerificationReport(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-30";
  const payload = sa(ctx.action);
  const actorCityId = actionCityId(ctx.action);
  const authorityFailure = requireActingAuthority(ctx, descriptorId, "R-30", actorCityId);
  if (authorityFailure) return authorityFailure;
  const reportPublicationId = str(payload.reportPublicationId);
  const loaded = loadReportAndClaim(ctx, descriptorId, "R-30", reportPublicationId);
  if ("plan" in loaded) return loaded.plan;
  const { claim, claimPublicationId, comparisons } = loaded;
  if (reportPublicationId === null) {
    return rejectedPlan(descriptorId, "NO_REPORT_ID", ["R-30"], "The adoption names no report.");
  }
  const markerPath = `sim_verification_adoptions/adopt_${reportPublicationId}`;
  if (snapshotDoc(ctx.snapshot, markerPath) !== null) {
    return rejectedPlan(descriptorId, "ALREADY_ADOPTED", ["R-30"], `Report ${reportPublicationId} already stands adopted — consequences land once per report, never twice for the same lie.`);
  }
  // Re-derive, never adopt upward: verdicts and tier are recomputed
  // from the claim's figures and the report's declared found figures
  // + evidence bands, through the same detection thresholds.
  const evidence = comparisons.items.map((item) => ({
    metric: item.metric,
    foundValue: item.foundValue as number | string | null,
    band: item.band,
  }));
  const result = computeVerification(claimItemsOf(claim), evidence);
  if (!result.established || result.tier === null) {
    return rejectedPlan(
      descriptorId,
      "NO_PROOF_ESTABLISHED",
      ["R-30", "R-31"],
      `Adoption refused: the recomputed comparison establishes no falsity (disagrees=${result.disagreesCount}, cannot-determine=${result.cannotDetermineCount}). No verification ⇒ no consequence — the platform initiates nothing, and neither does an adoption over unproven ground.`
    );
  }
  const publisherCityId = str(claim.cityId) ?? "";
  const citySteer = str(payload.publisherCityId);
  if (citySteer === null) {
    return rejectedPlan(descriptorId, "PAYLOAD_INCOMPLETE", ["R-30"], "adopt_verification_report names no publisherCityId — the read plan steers from it; the claim record validates it.");
  }
  if (citySteer !== publisherCityId) {
    return rejectedPlan(descriptorId, "CLAIM_CITY_MISMATCH", ["R-30"], `The payload steers to publisher city ${citySteer}; the claim is filed under ${publisherCityId}. The steer is refused, not followed.`);
  }
  const publisherCity = snapshotDoc(ctx.snapshot, `sim_cities/${publisherCityId}`);
  if (publisherCity === null) {
    return rejectedPlan(descriptorId, "NO_CITY", ["R-30"], `The claim's city ${publisherCityId} does not stand.`);
  }
  const deltas = LIE_TIER_DELTAS[result.tier];
  const plan = emptyPlan(descriptorId);
  const summarySeq = ctx.snapshot.counterHead.lastSeq + 2;

  // Apply the tier deltas to the publisher's city (indices clamp
  // 0–100 by engine convention; a null index skips-and-logs — the
  // engine invents no value to punish).
  const changes: ReturnType<typeof fieldChange>[] = [];
  const skipped: string[] = [];
  let cityAfter: Record<string, unknown> = { ...publisherCity };
  for (const [field, delta] of [
    ["stats.law", deltas.law],
    ["stats.influence", deltas.influence],
  ] as const) {
    const before = num(publisherCity, field);
    if (before === null) {
      skipped.push(`${field} is unset on ${publisherCityId} — skipped, not invented`);
      continue;
    }
    const after = clampNumber(before + delta, 0, 100);
    cityAfter = withDocField(cityAfter, field, after);
    changes.push(fieldChange({ cityId: publisherCityId, field, before, after, unit: "points", note: `proven-false publication consequence (${result.tier})` }));
  }
  planWrite(plan, ctx.snapshot, `sim_cities/${publisherCityId}`, cityAfter);

  // The adoption marker (idempotence record).
  planWrite(plan, ctx.snapshot, markerPath, {
    schemaVersion: 2,
    reportPublicationId,
    claimPublicationId,
    publisherCityId,
    adoptedByUid: ctx.action.actor.memberId ?? ctx.action.actor.onBehalfOfMemberId ?? "",
    adopterCityId: actorCityId,
    tier: result.tier,
    createdByResolutionId: ctx.resolutionId,
    createdAtSeq: summarySeq,
    stateVersion: 1,
    createdAt: null,
    lastChangedSeq: null,
    lastResolutionId: null,
  });

  // The one case this module may open: wholesale + the claim was
  // binding + the adopting member elects it (v2 R-30 tier text; the
  // case shape is Defensive's, composed not rebuilt).
  const recordsCreated: string[] = [markerPath];
  let caseNote = "";
  const bindingRef = str(claim.bindingAgreementRef);
  if (result.tier === "wholesale" && bindingRef !== null && payload.openCase === true) {
    const caseId = `case_${ctx.resolutionId}`;
    const casePath = `sim_cases/${caseId}`;
    planWrite(plan, ctx.snapshot, casePath, {
      schemaVersion: 2,
      caseId,
      openedAtSeq: summarySeq,
      tier: 1,
      accusedCityId: publisherCityId,
      injuredCityIds: [actorCityId],
      ruleId: "R-30",
      status: "open",
      sourceActionId: ctx.action.actionId,
      openedByResolutionId: ctx.resolutionId,
      stateVersion: 1,
      createdAt: null,
      lastChangedSeq: null,
      lastResolutionId: null,
    });
    recordsCreated.push(casePath);
    caseNote = ` A tier-1 case (${caseId}) opens under R-23 because the claim was binding (${bindingRef}) and the adopting member elected to open it.`;
  }

  plan.entries.push(
    ruleEffectDraft({
      cityId: publisherCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-30", "R-31"],
      summaryText:
        `Proven-false publication consequence (${result.tier} tier), adopted from report ${reportPublicationId} against claim ${claimPublicationId}: law ${deltas.law}, influence ${deltas.influence} applied to ${publisherCityId}. The consequence cites the report and R-30's tier table; it is scaled by the strength of the lie (divergences: ${result.items.filter((i) => i.verdict === "disagrees").map((i) => `${i.metric} ${i.divergencePct !== null ? `${i.divergencePct.toFixed(1)}%` : "non-numeric"}`).join(", ")}).` +
        (skipped.length > 0 ? ` Skipped: ${skipped.join("; ")}.` : "") +
        caseNote +
        ` The original claim is never edited.`,
      changes,
      recordsCreated,
      recordsUpdated: [],
      classification: {
        adoption: true,
        reportPublicationId,
        claimPublicationId,
        tier: result.tier,
        verdicts: result.items,
        caseOpened: caseNote.length > 0,
      },
    })
  );
  plan.entries.push(
    summaryDraft({
      cityId: actorCityId,
      actor: ctx.action.actor,
      ruleIds: ["R-30"],
      summaryText: `Adoption stands: report ${reportPublicationId} carried its ${result.tier}-tier consequence onto ${publisherCityId}. The marker ${markerPath} prevents any second landing of the same report.`,
      classification: { summary: true, reportPublicationId, tier: result.tier },
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Read plans (F-01): payload paths + the materialized queries the
// handlers grade against. The counter-means query is whole-collection
// (the filter is applied in code) — the Lead registers the matching
// index posture (prep report §5).
// ---------------------------------------------------------------------------

function commissionReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const payload = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  const queries: CollectionQuerySpec[] = [];
  const actorCityId = actionCityId(seeds.action);
  const targetCityId = str(payload.targetCityId) ?? actorCityId;
  const meansId = str(payload.meansId);
  if (meansId !== null) paths.push(meansPath(meansId));
  const buildRaw = payload.buildMeans as Record<string, unknown> | undefined;
  if (buildRaw && typeof buildRaw === "object") {
    const vehicle = (buildRaw.vehicle ?? {}) as Record<string, unknown>;
    paths.push(...strList(vehicle.recordIds));
  }
  const target = (payload.target ?? {}) as Record<string, unknown>;
  if (target.scopeKind === "business-staff" || target.scopeKind === "business-customers") {
    const businessId = str(target.businessId);
    const home = str(target.businessHomeCityId);
    if (businessId !== null && home !== null) {
      paths.push(`sim_cities/${home}/corporations/${businessId}`);
    }
  }
  for (const id of strList(target.structureIds)) {
    paths.push(`sim_cities/${targetCityId}/structures/${id}`);
  }
  paths.push(posturePath(targetCityId));
  queries.push({
    id: STRUCTURES_QUERY_ID,
    collectionPath: `sim_cities/${targetCityId}/structures`,
    filters: [],
  });
  queries.push({
    id: COUNTER_MEANS_QUERY_ID,
    collectionPath: "sim_collection_means",
    filters: [],
  });
  return { paths, queries };
}

function establishReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const payload = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const vehicle = (payload.vehicle ?? {}) as Record<string, unknown>;
  return { paths: strList(vehicle.recordIds), queries: [] };
}

function insiderReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  // One-pass seed contract (F-01): paths derive from the PAYLOAD.
  // personCityId is a read STEER — the handler validates it against
  // the person record actually read, so a wrong steer can only cause
  // a rejection, never a wrong read of consequence.
  const payload = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const paths: string[] = [];
  const personRef = str(payload.personRef);
  if (personRef !== null) paths.push(`characters/${personRef}`);
  const channel = (payload.channel ?? {}) as Record<string, unknown>;
  const channelPath = str(channel.recordPath);
  if (channelPath !== null) paths.push(channelPath);
  const personCityId = str(payload.personCityId);
  if (personCityId !== null) {
    paths.push(`sim_cities/${personCityId}`, posturePath(personCityId));
  }
  return { paths, queries: [] };
}

function publicationReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const payload = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const publicationId = str(payload.publicationId);
  return { paths: publicationId !== null ? [`sim_publications/${publicationId}`] : [], queries: [] };
}

function reportReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  // One-pass seed contract (F-01): the report doc is a base seed when
  // the payload carries publicationPath (the landed convention —
  // collectActionReadPaths seeds it), so its cited claim + evidence
  // refs are derivable here. claimPublicationId / publisherCityId in
  // the payload are read STEERS the handlers cross-validate against
  // the documents actually read (a lying steer rejects, never writes).
  const payload = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const reportId = str(payload.reportPublicationId);
  const paths: string[] = [];
  if (reportId === null) return { paths, queries: [] };
  paths.push(`sim_publications/${reportId}`);
  const report = seeds.seedDocs.get(`sim_publications/${reportId}`) ?? null;
  if (report) {
    const comparisons = reportComparisons(report);
    if (comparisons.claimPublicationId !== null) {
      paths.push(`sim_publications/${comparisons.claimPublicationId}`);
    }
    paths.push(...comparisons.evidenceRefs);
  }
  const claimSteer = str(payload.claimPublicationId);
  if (claimSteer !== null) paths.push(`sim_publications/${claimSteer}`);
  const citySteer = str(payload.publisherCityId);
  if (citySteer !== null) paths.push(`sim_cities/${citySteer}`, `factions/${citySteer}`);
  paths.push(`sim_verification_adoptions/adopt_${reportId}`);
  return { paths, queries: [] };
}

// ---------------------------------------------------------------------------
// The family's descriptors (Lead registers ACQUISITION_DESCRIPTORS in
// registry.ts — prep report §5; expected registry total 44 + 7 = 51)
// ---------------------------------------------------------------------------

export const ACQUISITION_DESCRIPTORS: RuleDescriptor[] = [
  {
    id: "R-25",
    actionKinds: ["survey_commission"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: true,
    finance: { shortfallClass: "budget", ledgersTouched: ["treasury"], invokesRules: [] },
    readPlan: commissionReadPlan,
    summary:
      "Domestic survey: means-gated (R-26 records), five-gate pipeline, published grading tables, treasury-paid at commission under the budget shortfall class; delivery ripens into a sim_intel_records results record with provenance + coverage. No means = refusal, never fabrication.",
    handlers: {
      survey_commission: (ctx) => runCommission(ctx, { descriptorId: "R-25", ruleId: "R-25", foreign: false }).plan,
    },
  },
  {
    id: "R-26",
    actionKinds: ["establish_means", "dissolve_means"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: false,
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
    readPlan: establishReadPlan,
    summary:
      "Collection means as world records (sim_collection_means): a vehicle (R-05 project / R-06 corporation / R-08 law) + a graded profile + a positive operating cost. Status is derived from the vehicle's own completion rule. Establishment charges nothing; commissions pay.",
    handlers: { establish_means: establishMeans, dissolve_means: dissolveMeans },
  },
  {
    id: "R-27",
    actionKinds: ["collection_run"],
    visibility: "covert",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: true,
    finance: { shortfallClass: "budget", ledgersTouched: ["treasury"], invokesRules: [] },
    readPlan: commissionReadPlan,
    summary:
      "Cross-city collection: the domestic pipeline plus the Exposure gate and the deterministic discovery table. Actor-private entries only; the public Log learns of a run solely through a discovery entry that cites it. Private-tier questions refuse by construction. Discovery opens no case — the target users' say-so is a separate act.",
    handlers: {
      collection_run: (ctx) => runCommission(ctx, { descriptorId: "R-27", ruleId: "R-27", foreign: true }).plan,
    },
  },
  {
    id: "R-28",
    actionKinds: ["insider_ask"],
    visibility: "covert",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: true,
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
    readPlan: insiderReadPlan,
    summary:
      "Insider ask: reachability (a channel record), not consent. One question, single-source clamp (band ≤ C), disposition (answers/refuses/lies/reports) resolved at delivery from the person's established interests — the engine never labels a lie false. Offers pay at delivery, on answers only, against a payable record.",
    handlers: { insider_ask: insiderAsk },
  },
  {
    id: "R-29",
    actionKinds: ["request_access"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: false,
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
    summary:
      "DESCRIPTOR-ONLY STUB (P4-K8): grant-based access. Grant records are Phase 5 substrate; the descriptor registers so classification is total, and its single handler exists only to resolve narrative-only with the deferral stated in the open. Export under a grant is OFF unless deal terms say so (CJ round 3).",
    handlers: { request_access: requestAccessDeferral },
  },
  {
    id: "R-30",
    actionKinds: ["publish_claim", "adopt_verification_report"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: false,
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: ["R-31"] },
    readPlan: (seeds) =>
      seeds.action.actionType === "publish_claim" ? publicationReadPlan(seeds) : reportReadPlan(seeds),
    summary:
      "Publish + adopt: publish_claim stamps a member's own publication owner-published · unverified (publication is speech — nothing verified moves; a writer-set verdict field refuses the stamp). adopt_verification_report is the consequence uptake: it re-derives verdicts + lie tier from the report's figures and bands, refuses when nothing is established, lands the tier deltas on the publisher's city once (marker-guarded), and opens the wholesale+binding tier-1 case only when the adopting member elects it.",
    handlers: { publish_claim: publishClaim, adopt_verification_report: adoptVerificationReport },
  },
  {
    id: "R-31",
    actionKinds: ["publish_verification"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: ["world-model"],
    mayCreatePendings: false,
    finance: { shortfallClass: "none", ledgersTouched: [], invokesRules: [] },
    readPlan: reportReadPlan,
    summary:
      "Verification: compares a claim's figures against intel the verifier HOLDS (the evidence fence mirrors the rules read fence). Verdicts per question (agrees / disagrees / cannot-determine); weak means force cannot-determine; the detection threshold makes a stronger lie provable at a lower grade (TC-P13(ii)). No state changes; the original claim is never edited; consequences wait for adoption (R-30).",
    handlers: { publish_verification: publishVerification },
  },
];
