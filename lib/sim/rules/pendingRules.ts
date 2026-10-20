/**
 * Pending-consequence machinery — R-32 (creation), R-33 (ripening
 * application), R-34 (trickle-down evaluation) — Phase 2 brief §7.
 *
 * R-32: every pending is created by a rule, inside the origin resolution's
 * single transaction, citing R-32 on a `rule-effect` entry (there is no
 * `pending-created` entry kind, P2-D6). The delay is DERIVED here from
 * the action's parameters and the target city's stored state by Felix's
 * §2.3 formula — never set directly, never rolled.
 *
 * R-33: ripening applies the payload the origin action committed to, or
 * validates a worker's prepared payload against the bounds stored at
 * creation. It never re-derives content.
 *
 * R-34: trickle-down evaluation finds propagation paths (connection
 * traits, shared records) and records findings. Phase 2 findings are
 * information-only entries; effect-bearing trickle-down rules are later
 * phases' handlers.
 */

import {
  docField,
  snapshotDoc,
  withDocField,
  type PendingDraft,
  type PreparedPayload,
  type ResolutionPlan,
  type SimActor,
  type SimChange,
  type SimSnapshot,
} from "../state";
import { deriveDelay, hasLiveConnection, type DelayDerivation } from "./arithmetic";
import { fieldChange, planWrite, plannedDoc } from "./planHelpers";

export class PendingSpecError extends Error {
  code = "PENDING_SPEC_INVALID";
}

export class RipeningPreparationError extends Error {
  code = "RIPENING_PREPARATION";
}

// ---------------------------------------------------------------------------
// Pending kinds (R-32's creation contract). baseHours feeds the delay
// formula; modes say whether creation may be determinate, generative
// (worker-prepared at ripening, bounds-checked), or both.
// ---------------------------------------------------------------------------

export interface PendingKindConfig {
  kind: string;
  baseHours: number;
  modes: ("determinate" | "generative")[];
  ruleIdsOnRipen: string[];
  /** Reference fund size for the fund-scale factor; null for kinds whose
   * delay does not scale with a fund. */
  referenceFund: number | null;
}

export const PENDING_KINDS: Record<string, PendingKindConfig> = {
  "innovation-breakthrough": {
    kind: "innovation-breakthrough",
    baseHours: 48,
    modes: ["determinate", "generative"],
    ruleIdsOnRipen: ["R-33", "R-34"],
    referenceFund: 1_500_000,
  },
  "delayed-stat-effect": {
    kind: "delayed-stat-effect",
    baseHours: 6,
    modes: ["determinate"],
    ruleIdsOnRipen: ["R-33"],
    referenceFund: null,
  },
  "instant-effect": {
    kind: "instant-effect",
    baseHours: 1,
    modes: ["determinate"],
    ruleIdsOnRipen: ["R-33"],
    referenceFund: null,
  },
  // Data acquisition delivery kinds (Phase 4 step 9 assembly; design
  // C-8 verbatim). A commission (R-25/R-27/R-28) debits and freezes
  // its grading into one of these pendings; ripening dispatches to
  // the acquisition family's delivery builder (resolver.ts), never to
  // the stat path — the payloadSpec carries a `delivery` block, and
  // the builder re-validates the prepared findings against the
  // delivery snapshot before anything is written.
  "survey-delivery": {
    kind: "survey-delivery",
    baseHours: 48,
    modes: ["generative"],
    ruleIdsOnRipen: ["R-25"],
    referenceFund: null,
  },
  "collection-delivery": {
    kind: "collection-delivery",
    baseHours: 48,
    modes: ["generative"],
    ruleIdsOnRipen: ["R-27"],
    referenceFund: null,
  },
  "insider-delivery": {
    kind: "insider-delivery",
    baseHours: 1,
    modes: ["generative"],
    ruleIdsOnRipen: ["R-28"],
    referenceFund: null,
  },
};

export function pendingKindConfig(kind: string): PendingKindConfig {
  const config = PENDING_KINDS[kind];
  if (!config) throw new PendingSpecError(`unknown pending kind: ${kind}`);
  return config;
}

// ---------------------------------------------------------------------------
// Structured preconditions (Felix N2 as amended: typed clauses evaluated
// mechanically, never prose strings — brief §7.2).
// ---------------------------------------------------------------------------

export interface StructuredPrecondition {
  type: "record-field-equals" | "record-field-gt" | "record-exists" | "record-status";
  path: string;
  field: string | null;
  operator: "==" | "!=" | ">" | ">=" | "<" | "<=" | "exists" | "absent";
  value: unknown;
  onFalse: "wait" | "void";
}

export function validatePreconditions(raw: unknown): StructuredPrecondition[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PendingSpecError("preconditions must be an array");
  return raw.map((entry, i) => {
    const pc = entry as Record<string, unknown>;
    const types = ["record-field-equals", "record-field-gt", "record-exists", "record-status"];
    if (!types.includes(pc.type as string)) {
      throw new PendingSpecError(`preconditions[${i}].type is not a structured clause type`);
    }
    if (typeof pc.path !== "string" || pc.path.length === 0) {
      throw new PendingSpecError(`preconditions[${i}].path must be a record path`);
    }
    if (pc.onFalse !== "wait" && pc.onFalse !== "void") {
      throw new PendingSpecError(`preconditions[${i}].onFalse must be "wait" or "void"`);
    }
    return {
      type: pc.type as StructuredPrecondition["type"],
      path: pc.path,
      field: typeof pc.field === "string" ? pc.field : null,
      operator: (pc.operator as StructuredPrecondition["operator"]) ?? "==",
      value: pc.value ?? null,
      onFalse: pc.onFalse,
    };
  });
}

/** Evaluate one clause against a doc lookup. Returns true/false, or
 * "void" when the clause fails with onFalse: "void". */
export function evaluatePrecondition(
  pc: StructuredPrecondition,
  doc: Record<string, unknown> | null
): boolean | "void" {
  let ok: boolean;
  switch (pc.type) {
    case "record-exists":
      ok = doc !== null;
      break;
    case "record-status":
      ok = doc !== null && doc.status === pc.value;
      break;
    case "record-field-equals": {
      const actual = pc.field ? docField(doc, pc.field) : undefined;
      ok = pc.operator === "!=" ? actual !== pc.value : actual === pc.value;
      break;
    }
    case "record-field-gt": {
      const actual = pc.field ? docField(doc, pc.field) : undefined;
      ok = typeof actual === "number" && typeof pc.value === "number" && actual > pc.value;
      break;
    }
    default:
      ok = false;
  }
  if (ok) return true;
  return pc.onFalse === "void" ? "void" : false;
}

// ---------------------------------------------------------------------------
// Payload spec validation (creation time) — R-32 refuses to store a
// pending whose ripening could not be applied mechanically.
// ---------------------------------------------------------------------------

export interface DeterminateEffect {
  type: "stat-delta";
  cityId: string;
  field: string;
  delta: number;
}

export interface PendingTemplate {
  kind: string;
  targetCityId: string;
  payloadSpec: Record<string, unknown>;
  summaryText?: string;
}

export function validatePayloadSpec(kind: string, spec: Record<string, unknown>): void {
  const config = pendingKindConfig(kind);
  const mode = spec.mode;
  if (mode !== "determinate" && mode !== "generative") {
    throw new PendingSpecError(`pending ${kind}: payloadSpec.mode must be determinate|generative`);
  }
  if (!config.modes.includes(mode)) {
    throw new PendingSpecError(`pending ${kind} does not support ${mode} creation`);
  }
  if (mode === "determinate") {
    const effect = spec.effect as DeterminateEffect | undefined;
    if (
      !effect ||
      effect.type !== "stat-delta" ||
      typeof effect.cityId !== "string" ||
      typeof effect.field !== "string" ||
      typeof effect.delta !== "number"
    ) {
      throw new PendingSpecError(`pending ${kind}: determinate payloadSpec needs effect {type:"stat-delta", cityId, field, delta}`);
    }
  } else {
    const bounds = spec.bounds as { minRubars?: unknown; maxRubars?: unknown } | undefined;
    if (
      !bounds ||
      typeof bounds.minRubars !== "number" ||
      typeof bounds.maxRubars !== "number" ||
      bounds.minRubars > bounds.maxRubars
    ) {
      throw new PendingSpecError(`pending ${kind}: generative payloadSpec needs bounds {minRubars <= maxRubars}`);
    }
  }
  if (spec.childPendings !== undefined) {
    if (!Array.isArray(spec.childPendings)) {
      throw new PendingSpecError("childPendings must be an array of templates");
    }
    for (const child of spec.childPendings as PendingTemplate[]) {
      validatePayloadSpec(child.kind, child.payloadSpec);
    }
  }
  if (spec.preconditions !== undefined) validatePreconditions(spec.preconditions);
}

// ---------------------------------------------------------------------------
// R-32 — pending creation. Returns the draft doc; the committer stamps
// createdAt/createdAtSeq and the ripen condition's requiredSeq/eligibleAt
// (they depend on the origin event's seq + instant).
// ---------------------------------------------------------------------------

export interface CreatePendingArgs {
  pendingId: string;
  kind: string;
  originResolutionId: string;
  originActionId: string | null;
  originActor: SimActor;
  originCityId: string | null;
  originSummaryText: string;
  targetCityId: string;
  sourceKind: "action" | "ripening";
  generation: number;
  chainId: string;
  chainRootPendingId: string | null;
  createdByResolutionId: string | null;
  payloadSpec: Record<string, unknown>;
  /** Fund size feeding the delay formula (fund actions); null otherwise. */
  fundSize: number | null;
  extraAudienceUids?: string[];
}

export function buildPendingDraft(
  snapshot: SimSnapshot,
  args: CreatePendingArgs
): { draft: PendingDraft; derivation: DelayDerivation } {
  const config = pendingKindConfig(args.kind);
  validatePayloadSpec(args.kind, args.payloadSpec);

  const targetCity = snapshotDoc(snapshot, `sim_cities/${args.targetCityId}`);
  const infrastructure = docField(targetCity, "stats.infrastructure");
  const derivation = deriveDelay({
    baseHours: config.baseHours,
    fundSize: args.fundSize,
    referenceFund: config.referenceFund,
    infrastructure: typeof infrastructure === "number" ? infrastructure : null,
    connected: hasLiveConnection(targetCity?.traits),
  });

  const audience = new Set<string>(args.extraAudienceUids ?? []);
  const actorUid = args.originActor.memberId ?? args.originActor.onBehalfOfMemberId;
  if (actorUid) audience.add(actorUid);
  for (const cityId of [args.originCityId, args.targetCityId]) {
    if (!cityId) continue;
    const faction = snapshotDoc(snapshot, `factions/${cityId}`);
    const owners = faction?.ownerUids;
    if (Array.isArray(owners)) {
      for (const uid of owners) if (typeof uid === "string") audience.add(uid);
    }
  }

  const preconditions = validatePreconditions(args.payloadSpec.preconditions);
  const requiresActionInCities = Array.isArray(args.payloadSpec.requiresActionInCities)
    ? (args.payloadSpec.requiresActionInCities as string[]).filter(
        (c) => typeof c === "string"
      )
    : [];

  const doc: Record<string, unknown> = {
    pendingId: args.pendingId,
    schemaVersion: 2,
    kind: args.kind,
    status: "pending",
    originResolutionId: args.originResolutionId,
    originActionId: args.originActionId,
    originActor: args.originActor,
    originCityId: args.originCityId,
    originSummaryText: args.originSummaryText,
    targetCityId: args.targetCityId,
    sourceKind: args.sourceKind,
    generation: args.generation,
    chainId: args.chainId,
    chainRootPendingId: args.chainRootPendingId,
    createdByResolutionId: args.createdByResolutionId,
    createdBySeq: null, // committer: creating event's head seq (children only semantics — see below)
    createdAtSeq: null, // committer: creating event's summary seq
    createdAt: null, // committer: creating event's instant
    originSeq: null, // committer for generation-1 (== createdAtSeq); resolver sets for children
    ripenCondition: {
      scope: "realm",
      minSeqAdvance: derivation.minSeqAdvance,
      requiredSeq: null, // committer: originSeq + minSeqAdvance
      minWallElapsedHours: derivation.minWallElapsedHours,
      eligibleAt: null, // committer: floor only — never a trigger
      requiresActionInCities,
      preconditions,
    },
    delayDerivation: derivation,
    payloadSpec: args.payloadSpec,
    // Felix's snapshot MINUS the odds fields (CJ §7.7 — brief §7.2):
    // state and citations only, never chances.
    creationSnapshot: {
      targetStats: (targetCity?.stats as Record<string, unknown> | undefined) ?? null,
      ruleInputs: { kind: args.kind, targetCityId: args.targetCityId },
    },
    audienceUids: [...audience].sort(),
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
    updatedAt: null, // committer
  };
  if (args.sourceKind === "ripening") {
    // Children know their chain origin at build time (resolver passes it
    // via payloadSpec-independent args); originSeq is stamped by the
    // caller through doc mutation before returning the draft.
    doc.createdBySeq = null;
  }
  return { draft: { doc }, derivation };
}

// ---------------------------------------------------------------------------
// R-33 — ripening application. Mutates `plan` with the effect's writes and
// changes; returns the child drafts + outcome text + generation record.
// Throws RipeningPreparationError when a generative payload is missing or
// out of bounds (a generation failure — silent, retried; brief §7.4).
// ---------------------------------------------------------------------------

export interface RipeningApplication {
  changes: SimChange[];
  childSpecs: { kind: string; targetCityId: string; payloadSpec: Record<string, unknown>; summaryText?: string }[];
  outcomeSummary: string;
  generation: {
    preparedBy: "worker";
    preparedInputHash: string;
    seed: string | null;
    boundsChecked: true;
  } | null;
}

export function applyRipeningEffect(
  snapshot: SimSnapshot,
  plan: ResolutionPlan,
  pending: Record<string, unknown>,
  prepared?: PreparedPayload
): RipeningApplication {
  const spec = pending.payloadSpec as Record<string, unknown>;
  const changes: SimChange[] = [];
  const childSpecs: RipeningApplication["childSpecs"] = [];

  const applyStatDelta = (effect: DeterminateEffect) => {
    const path = `sim_cities/${effect.cityId}`;
    const city = snapshotDoc(snapshot, path);
    if (!city) throw new RipeningPreparationError(`ripening target city doc missing: ${path}`);
    // Compose against the PLANNED doc (F-02): a second effect on the
    // same doc in this plan chains off the first effect's after-state,
    // so the folded write and the changes[] agree.
    const current = plannedDoc(plan, snapshot, path) ?? city;
    const before = docField(current, effect.field);
    if (typeof before !== "number") {
      throw new RipeningPreparationError(`ripening field is not numeric: ${effect.field}`);
    }
    const afterDoc = withDocField(current, effect.field, before + effect.delta);
    planWrite(plan, snapshot, path, afterDoc, "state", [effect.field]);
    changes.push(
      fieldChange(effect.field, before, before + effect.delta, `ripening payloadSpec effect (${pending.pendingId as string})`)
    );
    return path;
  };

  if (spec.mode === "determinate") {
    applyStatDelta(spec.effect as DeterminateEffect);
    if (typeof spec.fundPath === "string" && typeof spec.fundDisbursementRubars === "number") {
      const fund = snapshotDoc(snapshot, spec.fundPath);
      if (fund) {
        // Planned-doc read (F-02), as in applyStatDelta above.
        const fundCurrent = plannedDoc(plan, snapshot, spec.fundPath) ?? fund;
        const disbursed = (fundCurrent.disbursedRubars as number) + spec.fundDisbursementRubars;
        const remaining = (fundCurrent.remainingRubars as number) - spec.fundDisbursementRubars;
        planWrite(
          plan,
          snapshot,
          spec.fundPath,
          { ...fundCurrent, disbursedRubars: disbursed, remainingRubars: remaining },
          "state",
          ["disbursedRubars", "remainingRubars"]
        );
        // Target-qualified change fields (TC-E02 chains over
        // (target, field) pairs): bare fund field names would chain
        // every fund's disbursements in the city into one sequence.
        const fundFieldBase = spec.fundPath.split("/").slice(2).join("/");
        changes.push(
          fieldChange(`${fundFieldBase}.disbursedRubars`, fundCurrent.disbursedRubars, disbursed, "fund disbursement at ripening (R-33)"),
          fieldChange(`${fundFieldBase}.remainingRubars`, fundCurrent.remainingRubars, remaining, "fund disbursement at ripening (R-33)")
        );
      }
    }
    for (const child of (spec.childPendings as PendingTemplate[] | undefined) ?? []) {
      childSpecs.push(child);
    }
    return {
      changes,
      childSpecs,
      outcomeSummary:
        (spec.summaryOnRipen as string | undefined) ??
        `Pending ${pending.pendingId as string} ripened (determinate).`,
      generation: null,
    };
  }

  // Generative: content arrives prepared; the resolver VALIDATES it
  // against the bounds stored at creation and applies it mechanically.
  const bounds = spec.bounds as { minRubars: number; maxRubars: number; field?: string; cityId?: string };
  const content = prepared?.generatedContent as
    | { creditRubars?: unknown; summaryText?: unknown; seed?: unknown; childBriefs?: unknown }
    | undefined;
  if (!prepared || !content) {
    throw new RipeningPreparationError("generative ripening requires a prepared payload");
  }
  if (
    typeof content.creditRubars !== "number" ||
    content.creditRubars < bounds.minRubars ||
    content.creditRubars > bounds.maxRubars
  ) {
    throw new RipeningPreparationError(
      `prepared creditRubars outside stored bounds [${bounds.minRubars}, ${bounds.maxRubars}]`
    );
  }
  const cityId = bounds.cityId ?? (pending.targetCityId as string);
  const field = bounds.field ?? "stats.treasuryRubars";
  applyStatDelta({ type: "stat-delta", cityId, field, delta: content.creditRubars });
  if (Array.isArray(content.childBriefs)) {
    for (const brief of content.childBriefs as Record<string, unknown>[]) {
      if (typeof brief.kind !== "string" || typeof brief.payloadSpec !== "object" || brief.payloadSpec === null) {
        throw new RipeningPreparationError("child brief lacks kind/payloadSpec");
      }
      validatePayloadSpec(brief.kind, brief.payloadSpec as Record<string, unknown>);
      childSpecs.push({
        kind: brief.kind,
        targetCityId:
          typeof brief.targetCityId === "string" ? brief.targetCityId : (pending.targetCityId as string),
        payloadSpec: brief.payloadSpec as Record<string, unknown>,
        summaryText: typeof brief.summaryText === "string" ? brief.summaryText : undefined,
      });
    }
  }
  return {
    changes,
    childSpecs,
    outcomeSummary:
      typeof content.summaryText === "string"
        ? content.summaryText
        : `Pending ${pending.pendingId as string} ripened (generative).`,
    generation: {
      preparedBy: "worker",
      preparedInputHash: prepared.inputHash,
      seed: typeof content.seed === "string" ? content.seed : null,
      boundsChecked: true,
    },
  };
}

// ---------------------------------------------------------------------------
// R-34 — trickle-down evaluation. Finds propagation paths out of the
// origin city: live connection traits (WB-7.2) and shared records.
// Phase 2 findings are information-only (no writes); the canonical fund
// example's three-layer shape is preserved in the finding records.
// ---------------------------------------------------------------------------

export interface TrickleFinding {
  path: string;
  basis: string;
  layers: string[];
  finding: string;
}

export function evaluateTrickleDown(
  snapshot: SimSnapshot,
  pending: Record<string, unknown>
): TrickleFinding[] {
  const findings: TrickleFinding[] = [];
  const originCityId = pending.originCityId as string | null;
  if (!originCityId) return findings;
  const origin = snapshotDoc(snapshot, `sim_cities/${originCityId}`);
  const traits = origin?.traits;
  if (Array.isArray(traits)) {
    for (const trait of traits) {
      if (typeof trait !== "string") continue;
      const match = /^connection:(.+):live$/.exec(trait);
      if (!match) continue;
      const other = match[1];
      findings.push({
        path: `${originCityId} -> ${other} (live connection)`,
        basis: "WB-7.2 connectivity makes the neighbor a plausible audience",
        layers: ["households learn of it", "firms reprice exposure", "public narrative forms"],
        finding: `News of ${pending.originSummaryText as string} plausibly reaches ${other}; no mechanical effect in Phase 2 (information-only finding, R-34).`,
      });
    }
  }
  return findings;
}

/** Plain-language ripen-condition disclosure for previews (§7.2): the
 * pending's condition at human granularity — no seed, no odds. */
export function describeRipenCondition(pending: Record<string, unknown>): string {
  const rc = pending.ripenCondition as Record<string, unknown>;
  const parts = [
    `ripens once the Log reaches seq ${rc.requiredSeq as number} (realm scope)`,
    `and at least ${rc.minWallElapsedHours as number} hours have passed since creation`,
  ];
  const cities = rc.requiresActionInCities as string[];
  if (Array.isArray(cities) && cities.length > 0) {
    parts.push(`and action has occurred in one of: ${cities.join(", ")}`);
  }
  const pcs = rc.preconditions as StructuredPrecondition[];
  if (Array.isArray(pcs) && pcs.length > 0) {
    parts.push(`and ${pcs.length} standing condition(s) still hold`);
  }
  return parts.join(", ") + ".";
}
