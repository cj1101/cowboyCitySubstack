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
  PENDING_FANOUT_CAP,
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
  /** The ripening effect path (Phase 4 close-out, E6): "stat" kinds
   * ripen through applyRipeningEffect (frozen determinate effects /
   * bounds-checked generative credits); "delivery" kinds ripen through
   * the owning family's delivery builder (the resolver dispatches on
   * this declaration, never on payload sniffing alone). A delivery
   * kind's payloadSpec MUST carry a `delivery` block and a stat kind's
   * MUST NOT — validatePayloadSpec fences both directions. */
  effectPath: "stat" | "delivery";
  /** Positive floor for the derived minWallElapsedHours (P4-K19): the
   * §2.3 formula's factors can round a small derivation to zero, which
   * would make a pending seq-ripe the moment it exists — a rounding
   * accident, not a design. buildPendingDraft raises a sub-floor
   * derivation to the floor and records the raise on the derivation.
   * Floors are set below every derivation the current factor ranges
   * can produce for the kind, so the floor binds only future kinds /
   * future factor ranges — it is a contract guard, not a retiming. */
  minWallHoursFloor?: number;
  /** Named exemption from the wall floor (P4-K19): kinds whose design
   * IS immediacy are exempted here, by name — never by a floor of 0
   * smuggled into the config. */
  zeroDelayExempt?: boolean;
}

export const PENDING_KINDS: Record<string, PendingKindConfig> = {
  "innovation-breakthrough": {
    kind: "innovation-breakthrough",
    baseHours: 48,
    modes: ["determinate", "generative"],
    ruleIdsOnRipen: ["R-33", "R-34"],
    referenceFund: 1_500_000,
    effectPath: "stat",
    minWallHoursFloor: 6,
  },
  "delayed-stat-effect": {
    kind: "delayed-stat-effect",
    baseHours: 6,
    modes: ["determinate"],
    ruleIdsOnRipen: ["R-33"],
    referenceFund: null,
    effectPath: "stat",
    minWallHoursFloor: 1,
  },
  "instant-effect": {
    kind: "instant-effect",
    baseHours: 1,
    modes: ["determinate"],
    ruleIdsOnRipen: ["R-33"],
    referenceFund: null,
    effectPath: "stat",
    // P4-K19's named exemption: this kind's contract is a same-wake
    // effect gated only by its seq advance; it is exempt from the
    // wall floor BY NAME.
    zeroDelayExempt: true,
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
    effectPath: "delivery",
    minWallHoursFloor: 6,
  },
  "collection-delivery": {
    kind: "collection-delivery",
    baseHours: 48,
    modes: ["generative"],
    ruleIdsOnRipen: ["R-27"],
    referenceFund: null,
    effectPath: "delivery",
    minWallHoursFloor: 6,
  },
  "insider-delivery": {
    kind: "insider-delivery",
    baseHours: 1,
    modes: ["generative"],
    ruleIdsOnRipen: ["R-28"],
    referenceFund: null,
    effectPath: "delivery",
    minWallHoursFloor: 1,
  },
};

export function pendingKindConfig(kind: string): PendingKindConfig {
  const config = PENDING_KINDS[kind];
  if (!config) throw new PendingSpecError(`unknown pending kind: ${kind}`);
  return config;
}

// ---------------------------------------------------------------------------
// The AGR predicate (Felix N1, §7.3) — pure. Moved here from pending.ts
// at the Phase 4 close-out so the committer-side P4-K20 guard can
// evaluate it without a pending.ts <-> committer.ts import cycle;
// pending.ts re-exports it for its existing importers.
//
// Seq currency is P4-K24's: the view's `currentSeq` is the RESOLVED-seq
// progress tally — the seq of the most recent resolved (non-rejected)
// resolution — NOT the Log head. A rejected resolution is fully
// logged but mints no delay progress; read the tally with
// resolvedSeqOf so the rule lives in exactly one place.
// ---------------------------------------------------------------------------

export interface RipenessView {
  currentSeq: number;
  nowIso: string;
  /** cityId -> the city's standing activity seq (its doc's lastChangedSeq;
   * the per-city "something happened here" marker in Phase 2 data). */
  cityActivitySeq: ReadonlyMap<string, number>;
  docByPath: (path: string) => Record<string, unknown> | null;
}

export type RipenessVerdict =
  | { state: "ripe" }
  | { state: "waiting"; blockers: string[] }
  | { state: "void"; reason: string };

/** The P4-K24 tally as stored on `sim_counters/log`: the seq of the
 * most recent RESOLVED resolution (`lastResolvedSeq`). Worlds whose
 * counter predates the tally fall back to the head seq — the pre-E4
 * reading — so an unstamped counter never accelerates a pending. */
export function resolvedSeqOf(counter: Record<string, unknown> | null): number {
  if (!counter) return 0;
  if (typeof counter.lastResolvedSeq === "number") return counter.lastResolvedSeq;
  return typeof counter.lastSeq === "number" ? counter.lastSeq : 0;
}

/** Build a one-pending RipenessView from a doc source (a materialized
 * snapshot): the claimed/in-transaction re-evaluation view for the
 * P4-K20 guard. Activity for a required city whose doc the source
 * does not carry falls back to `activityFallback` (the scan's
 * pass-start readings) and then to 0 — unproven activity never
 * fabricates ripeness. */
export function buildRipenessView(
  pending: Record<string, unknown>,
  sources: {
    counter: Record<string, unknown> | null;
    nowIso: string;
    docByPath: (path: string) => Record<string, unknown> | null;
    activityFallback?: ReadonlyMap<string, number>;
  }
): RipenessView {
  const condition = pending.ripenCondition as Record<string, unknown>;
  const cities = (condition.requiresActionInCities as string[] | undefined) ?? [];
  const cityActivitySeq = new Map<string, number>();
  for (const cityId of cities) {
    const city = sources.docByPath(`sim_cities/${cityId}`);
    if (city && typeof city.lastChangedSeq === "number") {
      cityActivitySeq.set(cityId, city.lastChangedSeq);
    } else if (sources.activityFallback?.has(cityId)) {
      cityActivitySeq.set(cityId, sources.activityFallback.get(cityId) as number);
    } else {
      cityActivitySeq.set(cityId, 0);
    }
  }
  return {
    currentSeq: resolvedSeqOf(sources.counter),
    nowIso: sources.nowIso,
    cityActivitySeq,
    docByPath: sources.docByPath,
  };
}

export function evaluateRipeness(
  pending: Record<string, unknown>,
  view: RipenessView
): RipenessVerdict {
  const condition = pending.ripenCondition as Record<string, unknown>;
  const blockers: string[] = [];

  // (a) realm sequence condition — the stored requiredSeq, never recomputed.
  const requiredSeq = condition.requiredSeq as number;
  if (view.currentSeq < requiredSeq) {
    blockers.push(`Log at seq ${view.currentSeq}, needs ${requiredSeq}`);
  }
  // (b) wall-clock floor only — passage of time alone never ripens.
  const eligibleAt = condition.eligibleAt as
    | { toDate?: () => Date }
    | string
    | Date
    | null;
  const eligibleIso =
    typeof eligibleAt === "string"
      ? eligibleAt
      : eligibleAt instanceof Date
        ? eligibleAt.toISOString()
        : eligibleAt && typeof eligibleAt.toDate === "function"
          ? eligibleAt.toDate().toISOString()
          : null;
  if (eligibleIso && view.nowIso < eligibleIso) {
    blockers.push(`wall floor ${eligibleIso} not reached`);
  }
  // (c) required action: activity in one of the listed cities SINCE the
  // pending was created (its createdAtSeq).
  const cities = (condition.requiresActionInCities as string[] | undefined) ?? [];
  const createdAtSeq = pending.createdAtSeq as number;
  if (cities.length > 0) {
    const acted = cities.some(
      (cityId) => (view.cityActivitySeq.get(cityId) ?? 0) > createdAtSeq
    );
    if (!acted) blockers.push(`no action yet in any of: ${cities.join(", ")}`);
  }
  // (d) structured preconditions — a false "void" clause ends the pending
  // as a logged world outcome, not an error.
  const preconditions = (condition.preconditions as StructuredPrecondition[] | undefined) ?? [];
  for (const pc of preconditions) {
    const result = evaluatePrecondition(pc, view.docByPath(pc.path));
    if (result === "void") {
      return {
        state: "void",
        reason: `precondition on ${pc.path}${pc.field ? `#${pc.field}` : ""} no longer holds (onFalse: void)`,
      };
    }
    if (result === false) {
      blockers.push(`precondition unmet: ${pc.path}${pc.field ? `#${pc.field}` : ""}`);
    }
  }
  return blockers.length > 0 ? { state: "waiting", blockers } : { state: "ripe" };
}

// ---------------------------------------------------------------------------
// Ripening failure taxonomy (P4-K23, Phase 4 close-out E3). Deterministic
// size failures — the transactional write ceiling and the manifest-size
// preflight — are PLAN failures: the pending moves to the named
// `blocked-oversize` attention state in one logged step and burns NO
// attempts. The attempts/retry class is reserved for genuine
// generation/bounds/preparation failures.
// ---------------------------------------------------------------------------

export type RipeningFailureClass = "size-block" | "attempts";

export function ripeningFailureClass(code: string): RipeningFailureClass {
  return code === "WRITE_SET_TOO_LARGE" || code === "MANIFEST_TOO_LARGE"
    ? "size-block"
    : "attempts";
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
  // E6 effect-path fence (Phase 4 close-out): a delivery kind's spec
  // must carry its `delivery` block (the frozen delivery contract the
  // resolver's delivery builder re-validates against), and a stat
  // kind's spec must NOT — a delivery block on a stat kind would route
  // nowhere and read as intent the engine cannot honor. Fail-closed
  // in both directions, at creation.
  if (config.effectPath === "delivery") {
    if (!spec.delivery || typeof spec.delivery !== "object") {
      throw new PendingSpecError(
        `pending ${kind}: delivery-kind payloadSpec needs a delivery block`
      );
    }
  } else if (spec.delivery !== undefined) {
    throw new PendingSpecError(
      `pending ${kind}: stat-kind payloadSpec must not carry a delivery block`
    );
  }
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
  const rawDerivation = deriveDelay({
    baseHours: config.baseHours,
    fundSize: args.fundSize,
    referenceFund: config.referenceFund,
    infrastructure: typeof infrastructure === "number" ? infrastructure : null,
    connected: hasLiveConnection(targetCity?.traits),
  });
  // P4-K19 wall floor (Phase 4 close-out, E1): a derivation that
  // rounds below the kind's positive floor is raised to the floor,
  // and the raise is RECORDED on the stored derivation (the derived
  // value stays visible as derivedWallHours) — never silently
  // substituted. Kinds named zeroDelayExempt skip the floor by name.
  const derivation: DelayDerivation & { wallFloorHours?: number; derivedWallHours?: number } =
    !config.zeroDelayExempt &&
    typeof config.minWallHoursFloor === "number" &&
    rawDerivation.minWallElapsedHours < config.minWallHoursFloor
      ? {
          ...rawDerivation,
          derivedWallHours: rawDerivation.minWallElapsedHours,
          wallFloorHours: config.minWallHoursFloor,
          minWallElapsedHours: config.minWallHoursFloor,
          minSeqAdvance: Math.round(config.minWallHoursFloor / 6),
        }
      : rawDerivation;

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
  /** Child specs BEFORE the fan-out slice (P4-K23): the resolver's
   * cap entry rides on total > created. Generative briefs are sliced
   * to the cap BEFORE validation (below), so for generative ripenings
   * this is the brief count, not the validated count. */
  childSpecsTotal: number;
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

  // Fund bookkeeping, shared by both modes (Phase 4 close-out, E5):
  // a disbursement moves remaining -> disbursed on the fund record,
  // composed against the PLANNED doc (F-02), with target-qualified
  // change fields (TC-E02 chains over (target, field) pairs — bare
  // fund field names would chain every fund's disbursements in the
  // city into one sequence).
  const writeFundBooking = (
    fundPath: string,
    fundCurrent: Record<string, unknown>,
    amount: number
  ): void => {
    const disbursed = (fundCurrent.disbursedRubars as number) + amount;
    const remaining = (fundCurrent.remainingRubars as number) - amount;
    planWrite(
      plan,
      snapshot,
      fundPath,
      { ...fundCurrent, disbursedRubars: disbursed, remainingRubars: remaining },
      "state",
      ["disbursedRubars", "remainingRubars"]
    );
    const fundFieldBase = fundPath.split("/").slice(2).join("/");
    changes.push(
      fieldChange(`${fundFieldBase}.disbursedRubars`, fundCurrent.disbursedRubars, disbursed, "fund disbursement at ripening (R-33)"),
      fieldChange(`${fundFieldBase}.remainingRubars`, fundCurrent.remainingRubars, remaining, "fund disbursement at ripening (R-33)")
    );
  };

  if (spec.mode === "determinate") {
    applyStatDelta(spec.effect as DeterminateEffect);
    if (typeof spec.fundPath === "string" && typeof spec.fundDisbursementRubars === "number") {
      const fund = snapshotDoc(snapshot, spec.fundPath);
      if (fund) {
        // Planned-doc read (F-02), as in applyStatDelta above.
        const fundCurrent = plannedDoc(plan, snapshot, spec.fundPath) ?? fund;
        writeFundBooking(spec.fundPath, fundCurrent, spec.fundDisbursementRubars);
      }
    }
    for (const child of (spec.childPendings as PendingTemplate[] | undefined) ?? []) {
      childSpecs.push(child);
    }
    return {
      changes,
      childSpecs,
      childSpecsTotal: childSpecs.length,
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
  // E5 — generative fund bookkeeping (Phase 4 close-out): a fund-backed
  // generative pending books its disbursement exactly as the
  // determinate branch does. The figure's source, in order: (1) the
  // prepared payload's `generatedContent.disbursementRubars` — the
  // generation contract for product specs, which carry no committed
  // figure (chains' buildFundPayloadSpec stores one only for
  // determinate pendings); validated as a number, >= 0, and <= the
  // credited amount. (2) The spec's creation-committed
  // `fundDisbursementRubars` — the fixture shape, where the figure was
  // committed at creation exactly as the determinate branch reads it.
  // Either way the figure is validated <= the fund's remaining
  // balance on this snapshot. No figure anywhere is a
  // generation-contract failure (RipeningPreparationError — the
  // attempts class), never a silent skip: before this landed, the
  // canonical innovation shape left the fund's counters unmoved while
  // the treasury credit landed.
  if (typeof spec.fundPath === "string") {
    const payloadFigure = (content as { disbursementRubars?: unknown }).disbursementRubars;
    let disbursement: number;
    if (payloadFigure !== undefined) {
      if (
        typeof payloadFigure !== "number" ||
        !(payloadFigure >= 0) ||
        payloadFigure > content.creditRubars
      ) {
        throw new RipeningPreparationError(
          `prepared disbursementRubars must be a number in [0, creditRubars], got ${String(payloadFigure)}`
        );
      }
      disbursement = payloadFigure;
    } else if (typeof spec.fundDisbursementRubars === "number") {
      disbursement = spec.fundDisbursementRubars;
    } else {
      throw new RipeningPreparationError(
        "fund-backed generative ripening requires generatedContent.disbursementRubars (the generation contract carries the figure)"
      );
    }
    const fund = snapshotDoc(snapshot, spec.fundPath);
    if (!fund) {
      throw new RipeningPreparationError(`ripening fund doc missing: ${spec.fundPath}`);
    }
    const fundCurrent = plannedDoc(plan, snapshot, spec.fundPath) ?? fund;
    if (disbursement > (fundCurrent.remainingRubars as number)) {
      throw new RipeningPreparationError(
        `disbursementRubars ${disbursement} exceeds the fund's remaining ${String(fundCurrent.remainingRubars)}`
      );
    }
    writeFundBooking(spec.fundPath, fundCurrent, disbursement);
  }
  // P4-K23: child briefs are sliced to the fan-out cap BEFORE the
  // survivors are validated — a malformed brief beyond the cap is
  // trimmed consequence, not a generation failure.
  let childSpecsTotal = 0;
  if (Array.isArray(content.childBriefs)) {
    const briefs = content.childBriefs as Record<string, unknown>[];
    childSpecsTotal = briefs.length;
    for (const brief of briefs.slice(0, PENDING_FANOUT_CAP)) {
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
    childSpecsTotal,
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
