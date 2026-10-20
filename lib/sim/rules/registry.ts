/**
 * The rule registry (Phase 2 brief §5.2).
 *
 * Phase 2 ships the engine contract, the pending machinery's three rule
 * descriptors (R-32 creation, R-33 ripening application, R-34 trickle-down
 * evaluation), and the fixture rules the gate's tests run through. R-33
 * and R-34 never classify an action — they run inside ripening — so they
 * have no action kinds. R-01…R-31, R-36…R-38 product handlers are NOT
 * Phase 2 (decision P2-K12): they land with their Phase 4/5/7 action
 * surfaces, each one carrying its own rule table rows here. R-35
 * (Season-0 allocation) landed with Phase 4 step 3: its descriptor
 * lives in ./allocation and is registered below. R-18/R-37 (Defensive)
 * landed with Phase 4 step 8: their descriptors live in ./defensive
 * and are spread below. R-32's product fund verbs and R-36 (Chains +
 * growth) landed with Phase 4 step 10: the product handlers live in
 * ./chains and ./growth; the R-32 entry below is the union merge (the
 * Phase 2 fixture kinds stay; the chains read plan is gated to the
 * product kinds so fixture manifests gain no funds-path read).
 *
 * Handler discipline (brief §5.3): handlers are pure — (snapshot, action,
 * prepared) → plan contributions. They never invent content, never read
 * the clock except the snapshot's injected `now`, and return
 * rejection plans (never throw) for domain-level refusals.
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  RESOLVER_RULES_VERSION,
  type CollectionQuerySpec,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimCitations,
  type SimSnapshot,
} from "../state";
import {
  citableBaselineVersion,
  sectionScopeCovers,
  type BaselineRegistry,
  type BaselineVersion,
} from "../baseline/registry";
import { buildPendingDraft, type PendingTemplate } from "./pendingRules";
import { fieldChange, planWrite, plannedDoc, rejectedPlan, ruleEffectDraft, summaryDraft } from "./planHelpers";
import { allocationDescriptor } from "./allocation";
import { FINANCE_DESCRIPTOR_META, FINANCE_DESCRIPTORS } from "./finance";
import { STRUCTURE_DESCRIPTORS, STRUCTURE_FINANCE_ADDITIONS } from "./structures";
import { LAW_DESCRIPTORS } from "./laws";
import { DEFENSIVE_DESCRIPTORS } from "./defensive";
import { CHAINS_DESCRIPTORS, R32_PRODUCT_HANDLERS } from "./chains";
import { GROWTH_DESCRIPTORS } from "./growth";

export interface HandlerContext {
  snapshot: SimSnapshot;
  action: SimAction;
  /** The resolution this plan will become (== actionId for member
   * actions; ripen_<pendingId>/void_<pendingId> for wake resolutions). */
  resolutionId: string;
  prepared?: PreparedPayload;
  baselineRegistry: BaselineRegistry;
  /** The version citable at the head seq + 1 — null pre-ratification. */
  citableBaseline: BaselineVersion | null;
  citations: SimCitations;
}

export type HandlerFn = (ctx: HandlerContext) => ResolutionPlan;

/** Seeds for a descriptor's read-plan hook (Phase 4 Step 0, F-01): the
 * action itself plus the docs already read for the plan's base paths —
 * stored records, so a hook can derive further reads (a listing's
 * corporation doc, an election record) from server-side state. Seeds
 * NEVER come from actor-supplied citations: citations may add reads to
 * the base set, but the hook is resolver-side code and its reads cannot
 * be narrowed or replaced by the actor's nominations. */
export interface ReadPlanSeeds {
  action: SimAction;
  seedDocs: ReadonlyMap<string, Record<string, unknown> | null>;
}

/** What a read-plan hook declares beyond the base doc paths: extra doc
 * paths and/or collection queries, materialized into the snapshot and
 * bound into the manifest's input set (see resolver.materializeSnapshot). */
export interface DescriptorReadPlan {
  paths?: string[];
  queries?: CollectionQuerySpec[];
}

/** Finance §2.4 descriptor additions (Phase 4 Finance assembly): the
 * shortfall discipline a money-moving descriptor's lines compose
 * under, the ledgers it touches, and the rules it invokes. Carried on
 * the descriptor as data — FINANCE_DESCRIPTOR_META and the catalogue
 * families' addition maps fold in at registration. No validation
 * depends on these fields today; they are the published mechanics
 * record (and the seam a later gate can assert against). */
export interface FinanceDescriptorAdditions {
  shortfallClass: "transfer" | "budget" | "custodial" | "none";
  ledgersTouched: string[];
  invokesRules: string[];
}

export interface RuleDescriptor {
  id: string;
  actionKinds: string[];
  visibility: "public" | "covert";
  requiresBaseline: boolean;
  defaultBaselineSections: string[];
  mayCreatePendings: boolean;
  handlers: Record<string, HandlerFn>;
  /** Finance §2.4 additions (see FinanceDescriptorAdditions). */
  finance?: FinanceDescriptorAdditions;
  /** F-01 read-plan hook: declares the collection/graph reads this
   * descriptor's handlers need, beyond the base doc-path derivation.
   * Absent = doc-path reads only (the Phase 2 contract). */
  readPlan?: (seeds: ReadPlanSeeds) => DescriptorReadPlan;
  summary: string;
}

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

/** Member authority over a city in the fixture world: the actor's member
 * uid (or on-behalf-of uid for delegated actors) must be in the faction's
 * ownerUids. The sitting-Mayor shared-office path is Phase 7 machinery;
 * no fixture exercises it. */
export function checkCityAuthority(
  snapshot: SimSnapshot,
  cityId: string,
  actor: SimActor
): { ok: true } | { ok: false; reason: string } {
  const uid = actor.memberId ?? actor.onBehalfOfMemberId;
  if (!uid) return { ok: false, reason: "actor carries no member identity" };
  const faction = snapshotDoc(snapshot, `factions/${cityId}`);
  if (!faction) return { ok: false, reason: `no faction record for ${cityId}` };
  const owners = faction.ownerUids;
  if (!Array.isArray(owners) || !owners.includes(uid)) {
    return { ok: false, reason: `${uid} is not an owner of ${cityId}` };
  }
  return { ok: true };
}

export function requireAuthority(
  ctx: HandlerContext,
  descriptorId: string,
  ruleId: string
): ResolutionPlan | null {
  const cityId = actionCityId(ctx.action);
  if (!cityId) {
    return rejectedPlan(descriptorId, "NO_TARGET_CITY", [ruleId], "Action names no target city.");
  }
  const authority = checkCityAuthority(ctx.snapshot, cityId, ctx.action.actor);
  if (!authority.ok) {
    return rejectedPlan(
      descriptorId,
      "AUTHORITY_REVOKED",
      [ruleId],
      `Authority revoked for ${ctx.action.actor.memberId ?? "actor"} over ${cityId}: ${authority.reason}.`
    );
  }
  return null;
}

function actorCitations(plan: ResolutionPlan, citations: SimCitations, resolutionId: string): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

// ---------------------------------------------------------------------------
// R-32 — fund establishment (handler for action kind "fixture_fund") and
// the fixture scheduler ("fixture_schedule"): pending creation machinery.
// ---------------------------------------------------------------------------

function fundHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-32";
  const denied = requireAuthority(ctx, descriptorId, "R-32");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", ["R-32"], `City ${cityId} does not stand.`);

  const amount = params.amountRubars;
  if (typeof amount !== "number" || amount <= 0) {
    return rejectedPlan(descriptorId, "MALFORMED_FUND", ["R-32"], "fixture_fund requires amountRubars > 0.");
  }
  const treasury = docField(city, "stats.treasuryRubars");
  if (typeof treasury !== "number") {
    return rejectedPlan(descriptorId, "NO_TREASURY", ["R-32"], `${cityId} has no treasury figure.`);
  }
  if (amount > treasury) {
    return rejectedPlan(
      descriptorId,
      "INSUFFICIENT_TREASURY",
      ["R-32"],
      `${cityId} treasury holds ${treasury} R; the fund of ${amount} R cannot be established.`
    );
  }

  const fundId = typeof params.fundId === "string" && params.fundId ? params.fundId : `fund_${ctx.resolutionId}`;
  const fundPath = `${cityPath}/structures/${fundId}`;
  const mode = params.mode === "generative" ? "generative" : "determinate";
  const payloadSpec: Record<string, unknown> = {
    mode,
    trickleDown: params.trickleDown !== false,
    summaryOnRipen: params.summaryOnRipen ?? null,
    fundPath,
    fundDisbursementRubars: typeof params.disbursementRubars === "number" ? params.disbursementRubars : amount,
  };
  if (mode === "determinate") {
    payloadSpec.effect = {
      type: "stat-delta",
      cityId,
      field: (params.effectField as string | undefined) ?? "stats.treasuryRubars",
      delta: typeof params.effectDelta === "number" ? params.effectDelta : amount,
    };
  } else {
    const bounds = params.bounds as { minRubars?: unknown; maxRubars?: unknown } | undefined;
    payloadSpec.bounds = {
      minRubars: typeof bounds?.minRubars === "number" ? bounds.minRubars : 0,
      maxRubars: typeof bounds?.maxRubars === "number" ? bounds.maxRubars : amount,
    };
  }
  if (params.preconditions !== undefined) payloadSpec.preconditions = params.preconditions;
  if (Array.isArray(params.childPendings)) {
    payloadSpec.childPendings = (params.childPendings as PendingTemplate[]).map((t) => ({
      kind: t.kind,
      targetCityId: t.targetCityId,
      payloadSpec: t.payloadSpec,
      // summaryText is optional on the template: omit the key entirely
      // when absent — an explicit undefined is not a Firestore value and
      // the committer's transaction would refuse the whole commit.
      ...(t.summaryText !== undefined ? { summaryText: t.summaryText } : {}),
    }));
  }

  const plan = emptyPlan(descriptorId);

  // The fund's money leaves the treasury now, inside this one event.
  const afterCity = withDocField(city, "stats.treasuryRubars", treasury - amount);
  planWrite(plan, ctx.snapshot, cityPath, afterCity, "state", ["stats.treasuryRubars"]);

  const fundDoc: Record<string, unknown> = {
    schemaVersion: 2,
    name: (params.fundName as string | undefined) ?? "unnamed fund",
    kind: "fund",
    cityId,
    initialRubars: amount,
    remainingRubars: amount,
    disbursedRubars: 0,
    status: "active",
    createdByResolutionId: ctx.resolutionId,
    createdAt: null, // committer-stamped at commit (keeps plans clock-free)
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
  planWrite(plan, ctx.snapshot, fundPath, fundDoc, "state", ["initialRubars"]);

  const pendingId = `pend_${ctx.resolutionId}_01`;
  const { draft } = buildPendingDraft(ctx.snapshot, {
    pendingId,
    kind: (params.payloadKind as string | undefined) ?? "innovation-breakthrough",
    originResolutionId: ctx.resolutionId,
    originActionId: ctx.action.actionId,
    originActor: ctx.action.actor,
    originCityId: cityId,
    originSummaryText: `Fund "${fundDoc.name as string}" established with ${amount} R in ${cityId}.`,
    targetCityId: cityId,
    sourceKind: "action",
    generation: 1,
    chainId: pendingId,
    chainRootPendingId: null,
    createdByResolutionId: null,
    payloadSpec,
    fundSize: amount,
  });
  plan.pendingCreates.push(draft);
  plan.readRefKeys.push(`pending:${pendingId}`);

  const fundEntry = ruleEffectDraft({
    actor: ctx.action.actor,
    cityId,
    cityIds: [cityId],
    ruleIds: ["R-32"],
    changes: [
      fieldChange("stats.treasuryRubars", treasury, treasury - amount, "fund establishment (R-32)"),
    ],
    recordsCreated: [fundPath],
    summaryText: `R-32: fund "${fundDoc.name as string}" established in ${cityId} for ${amount} R.`,
  });
  const pendingEntry = ruleEffectDraft({
    actor: ctx.action.actor,
    cityId,
    cityIds: [cityId],
    ruleIds: ["R-32"],
    pendingId,
    changes: [],
    summaryText: `R-32: pending consequence ${pendingId} committed to: ${ctx.action.actionText ?? "fund consequence"}.`,
  });
  plan.entries.push(fundEntry, pendingEntry);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "establish-fund", scope: "city", ruleIds: ["R-32"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-32"],
      summaryText: `Established fund "${fundDoc.name as string}" (${amount} R) in ${cityId}; consequence ${pendingId} now pending.`,
      major: true,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function scheduleHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-32";
  const denied = requireAuthority(ctx, descriptorId, "R-32");
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const plan = emptyPlan(descriptorId);
  const pendingId = `pend_${ctx.resolutionId}_01`;
  const payloadSpec: Record<string, unknown> = {
    mode: "determinate",
    effect: {
      type: "stat-delta",
      cityId,
      field: (params.effectField as string | undefined) ?? "stats.treasuryRubars",
      delta: typeof params.effectDelta === "number" ? params.effectDelta : 0,
    },
    summaryOnRipen: params.summaryOnRipen ?? null,
  };
  if (params.preconditions !== undefined) payloadSpec.preconditions = params.preconditions;
  if (Array.isArray(params.requiresActionInCities)) {
    payloadSpec.requiresActionInCities = params.requiresActionInCities;
  }
  if (Array.isArray(params.childPendings)) {
    payloadSpec.childPendings = (params.childPendings as PendingTemplate[]).map((t) => ({
      kind: t.kind,
      targetCityId: t.targetCityId,
      payloadSpec: t.payloadSpec,
      // summaryText is optional on the template: omit the key entirely
      // when absent — an explicit undefined is not a Firestore value and
      // the committer's transaction would refuse the whole commit.
      ...(t.summaryText !== undefined ? { summaryText: t.summaryText } : {}),
    }));
  }
  if (Array.isArray(params.voidEffects)) payloadSpec.voidEffects = params.voidEffects;
  if (params.trickleDown !== undefined) payloadSpec.trickleDown = params.trickleDown;
  const { draft } = buildPendingDraft(ctx.snapshot, {
    pendingId,
    kind: (params.pendingKind as string | undefined) ?? "delayed-stat-effect",
    originResolutionId: ctx.resolutionId,
    originActionId: ctx.action.actionId,
    originActor: ctx.action.actor,
    originCityId: cityId,
    originSummaryText: ctx.action.actionText ?? "scheduled consequence",
    targetCityId: cityId,
    sourceKind: "action",
    generation: 1,
    chainId: pendingId,
    chainRootPendingId: null,
    createdByResolutionId: null,
    payloadSpec,
    fundSize: null,
  });
  plan.pendingCreates.push(draft);
  plan.readRefKeys.push(`pending:${pendingId}`);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-32"],
      pendingId,
      changes: [],
      summaryText: `R-32: pending consequence ${pendingId} scheduled: ${ctx.action.actionText ?? ""}.`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "schedule-consequence", scope: "city", ruleIds: ["R-32"], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: ["R-32"],
      summaryText: `Scheduled a delayed consequence (${pendingId}) in ${cityId}.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Fixture rules (tests only). Named fixtures so the audit trail never
// confuses them with product rule handlers.
// ---------------------------------------------------------------------------

function adjustHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-ADJUST";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const field = (params.field as string | undefined) ?? "stats.treasuryRubars";
  const delta = params.delta;
  if (typeof delta !== "number") {
    return rejectedPlan(descriptorId, "MALFORMED_DELTA", [descriptorId], "fixture_adjust requires a numeric delta.");
  }
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", [descriptorId], `City ${cityId} does not stand.`);
  const before = docField(city, field);
  if (typeof before !== "number") {
    return rejectedPlan(descriptorId, "NON_NUMERIC_FIELD", [descriptorId], `${field} is not numeric on ${cityId}.`);
  }
  // The fixture clamp: stats are bounded at 0 below and 1000 above.
  const after = Math.min(1000, Math.max(0, before + delta));
  const afterCity = withDocField(city, field, after);
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, cityPath, afterCity, "state", [field]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [fieldChange(field, before, after, `fixture adjust, clamped to [0,1000] (${descriptorId})`)],
      recordsUpdated: [cityPath],
      summaryText: `${descriptorId}: ${cityId} ${field} ${before} → ${after}.`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "adjust-stat", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      summaryText: `Adjusted ${cityId} ${field} by ${delta} (clamped): ${before} → ${after}.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function structureHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-STRUCTURE";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const structureId =
    (params.structureId as string | undefined) ?? `structure_${ctx.resolutionId}`;
  const path = `sim_cities/${cityId}/structures/${structureId}`;
  const existing = snapshotDoc(ctx.snapshot, path);
  const status = (params.status as string | undefined) ?? "built";
  const doc: Record<string, unknown> = {
    ...(existing ?? {}),
    schemaVersion: 2,
    name: (params.name as string | undefined) ?? structureId,
    kind: "structure",
    cityId,
    status,
    updatedByResolutionId: ctx.resolutionId,
    updatedAt: null, // committer-stamped at commit
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, path, doc, "state", ["status"]);
  const before = (existing?.status as string | undefined) ?? null;
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      // The change field names its TARGET (TC-E02 chains run over
      // (target, field) pairs): a bare "status" would chain every
      // structure's status in the city into one false sequence.
      changes: [fieldChange(`structures/${structureId}.status`, before, status, `${descriptorId} fixture state machine`)],
      recordsCreated: existing ? [] : [path],
      recordsUpdated: existing ? [path] : [],
      summaryText: `${descriptorId}: structure ${structureId} status → ${status}.`,
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "structure", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      summaryText: `Structure ${structureId} in ${cityId}: ${before ?? "none"} → ${status}.`,
      major: true,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function checkInHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-CHECKIN";
  const params = sa(ctx.action);
  const pendingId = params.pendingId;
  if (typeof pendingId !== "string") {
    return rejectedPlan(descriptorId, "NO_PENDING_ID", [descriptorId], "fixture_check_in requires pendingId.");
  }
  const pending = snapshotDoc(ctx.snapshot, `sim_pending_consequences/${pendingId}`);
  if (!pending) {
    return rejectedPlan(descriptorId, "NO_PENDING", [descriptorId], `Pending ${pendingId} does not stand.`);
  }
  const plan = emptyPlan(descriptorId);
  // The check-in changes no state; it registers the citation so the
  // dependency graph sees the reliance (committer-maintained
  // referencedByRefKeys, brief §8.3).
  plan.pendingReferenceWrites.push({ pendingId });
  plan.readRefKeys.push(`pending:${pendingId}`);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "check-in", scope: "pending", ruleIds: [descriptorId], unruled: false },
      cityId: (pending.targetCityId as string | undefined) ?? null,
      cityIds: [],
      ruleIds: [descriptorId],
      pendingId,
      summaryText: `Checked in on pending ${pendingId}: ${typeof params.note === "string" ? params.note : "noted."}`,
    })
  );
  return plan;
}

function covertNoteHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-COVERT";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const path = `sim_intel_records/covert_${ctx.resolutionId}`;
  const doc: Record<string, unknown> = {
    schemaVersion: 2,
    kind: "covert-note",
    subjectCityId: cityId,
    collectorCityId: cityId,
    collectorUid: ctx.action.actor.memberId,
    // The means contract (Phase 1 rules posture, CJ's means doctrine):
    // an intel record exists only with a logged means behind it. The
    // collection action itself is this fixture's means — the same
    // methodRef shape the Phase 1 rules tests use for survey intel.
    method: {
      kindLabel: "covert-note",
      methodRef:
        typeof params.methodRef === "string" && params.methodRef.length > 0
          ? params.methodRef
          : `sim_actions:${ctx.action.actionId}`,
    },
    collectionResolutionId: ctx.resolutionId,
    summary: typeof params.note === "string" ? params.note : "covert note",
    status: "held",
    createdByResolutionId: ctx.resolutionId,
    createdAt: null, // committer-stamped at commit (keeps plans clock-free)
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, path, doc, "state", ["summary"]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [],
      recordsCreated: [path],
      visibility: "actor-private",
      summaryText: `${descriptorId}: a covert note was collected (actor-private entry).`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "covert-note", scope: "covert", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      visibility: "actor-private",
      summaryText: `Covert note collected regarding ${cityId} (actor-private).`,
    })
  );
  return plan;
}

function discoverHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-DISCOVER";
  const params = sa(ctx.action);
  const targetResolutionId = params.targetResolutionId;
  const discoveredSeq = params.discoveredSeq;
  if (typeof targetResolutionId !== "string" || typeof discoveredSeq !== "number") {
    return rejectedPlan(descriptorId, "MALFORMED_DISCOVERY", [descriptorId], "fixture_discover requires targetResolutionId and discoveredSeq.");
  }
  const plan = emptyPlan(descriptorId);
  plan.readRefKeys.push(`resolution:${targetResolutionId}`, `seq:${discoveredSeq}`);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [],
      classification: {
        discovery: true,
        discoveredResolutionId: targetResolutionId,
        discoveredSeq,
        ruleIds: [descriptorId],
      },
      summaryText: `${descriptorId}: covert activity at seq ${discoveredSeq} (${targetResolutionId}) was discovered — it is now public.`,
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "discover", scope: "realm", ruleIds: [descriptorId], unruled: false },
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      summaryText: `Discovery of covert activity (seq ${discoveredSeq}) published to the public Log.`,
      major: true,
    })
  );
  return plan;
}

function marketJudgmentHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-MARKET";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const citable = ctx.citableBaseline;

  if (!citable) {
    return rejectedPlan(
      descriptorId,
      "BASELINE_UNRATIFIED",
      [descriptorId],
      "Market judgment refused: the Baseline is not ratified, and a Baseline-dependent judgment may not cite a draft (fail-closed, brief §6.4)."
    );
  }
  const requestedSections = (
    (params.sections as string[] | undefined) ?? RULE_DESCRIPTORS[descriptorId].defaultBaselineSections
  ).filter((s) => typeof s === "string");
  const applicable = requestedSections.filter((sectionId) => {
    const section = citable.sections.find((s) => s.id === sectionId);
    return section !== undefined && sectionScopeCovers(section, [cityId]);
  });
  if (applicable.length === 0) {
    return rejectedPlan(
      descriptorId,
      "BASELINE_SECTION_NOT_APPLICABLE",
      [descriptorId],
      `No requested Baseline section is citable for ${cityId} (unknown or out-of-scope sections: ${requestedSections.join(", ")}).`
    );
  }
  const judgment = typeof params.judgment === "string" ? params.judgment : null;
  const citation = {
    version: citable.version,
    docHash: citable.docHash,
    sections: applicable,
    interpretation: judgment,
    interpretationId: null,
  };
  const plan = emptyPlan(descriptorId);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "market-judgment", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      baseline: citation,
      summaryText: `Market judgment for ${cityId} citing Baseline ${citable.version} §${applicable.join(", §")}${judgment ? `: ${judgment}` : "."}`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function scatterHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-SCATTER";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const count = params.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 2000) {
    return rejectedPlan(descriptorId, "MALFORMED_COUNT", [descriptorId], "fixture_scatter requires an integer count in [1, 2000].");
  }
  const noteBytes = typeof params.noteBytes === "number" && params.noteBytes > 0 ? params.noteBytes : 0;
  const note = noteBytes > 0 ? "x".repeat(noteBytes) : "";
  const plan = emptyPlan(descriptorId);
  const created: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = `sim_cities/${cityId}/structures/scatter_${ctx.resolutionId}_${String(i).padStart(4, "0")}`;
    planWrite(
      plan,
      ctx.snapshot,
      path,
      {
        schemaVersion: 2,
        name: `scatter ${i}`,
        kind: "structure",
        cityId,
        status: "built",
        note,
        createdByResolutionId: ctx.resolutionId,
        createdAt: null, // committer-stamped at commit (keeps plans clock-free)
        stateVersion: 1,
        lastChangedSeq: null,
        lastResolutionId: null,
      },
      "state",
      ["status"]
    );
    created.push(path);
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [],
      recordsCreated: created,
      summaryText: `${descriptorId}: scattered ${count} structures across ${cityId} (ceiling test).`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "scatter", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      summaryText: `Scatter: ${count} structures in ${cityId}.`,
    })
  );
  return plan;
}

function verifyPublicationHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-VERIFY";
  const params = sa(ctx.action);
  const publicationPath = params.publicationPath;
  const targetResolutionId = params.targetResolutionId;
  if (typeof publicationPath !== "string" || typeof targetResolutionId !== "string") {
    return rejectedPlan(descriptorId, "MALFORMED_VERIFY", [descriptorId], "fixture_verify_publication requires publicationPath and targetResolutionId.");
  }
  const publication = snapshotDoc(ctx.snapshot, publicationPath);
  if (!publication) {
    return rejectedPlan(descriptorId, "NO_PUBLICATION", [descriptorId], `Publication ${publicationPath} does not stand.`);
  }
  const plan = emptyPlan(descriptorId);
  // The reliance is detectable only because this act is itself a
  // resolution citing both the record and the resolution (the S4
  // realization — see the build prep report): publications have no
  // citation field of their own.
  plan.readRefKeys.push(`record:${publicationPath}`, `resolution:${targetResolutionId}`);
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [],
      classification: {
        verification: true,
        publicationPath,
        reliesOnResolution: targetResolutionId,
        ruleIds: [descriptorId],
      },
      summaryText: `${descriptorId}: publication ${publicationPath} was verified against resolution ${targetResolutionId}; the verification relied on it.`,
      major: true,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "verify-publication", scope: "realm", ruleIds: [descriptorId], unruled: false },
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      summaryText: `Verification of ${publicationPath} (relies on ${targetResolutionId}).`,
      major: true,
    })
  );
  return plan;
}

// ---------------------------------------------------------------------------
// FIXTURE-ORDERBOOK (Phase 4 Step 0, F-01) — the engine fixture for the
// read-plan contract: an order-book-shaped collection read. The read
// plan (descriptor code, resolver-side) declares the resting-orders
// query; the handler reads ONLY the materialized result set from the
// snapshot and derives the city's resting-order count/total from it.
// Actor citations play no part in sourcing the read — an actor who
// cites a subset of the book still gets the whole book read (the F-01
// negative fixture in the Sim core suite proves it).
// ---------------------------------------------------------------------------

function orderbookReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  return {
    queries: [
      {
        id: "resting-orders",
        collectionPath: `sim_cities/${cityId}/structures`,
        filters: [{ field: "status", op: "==", value: "resting" }],
        orderBy: [{ field: "priceRubars", direction: "asc" }],
        limit: 50,
      },
    ],
  };
}

function orderbookHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-ORDERBOOK";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const record = ctx.snapshot.queries.find(
    (q) => q.spec.id === "resting-orders" && q.spec.collectionPath === `${cityPath}/structures`
  );
  if (!record) {
    return rejectedPlan(
      descriptorId,
      "READ_PLAN_MISSING",
      [descriptorId],
      "The resting-orders collection read was not materialized into the snapshot — a handler never improvises a read outside its declared read plan (F-01)."
    );
  }
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) {
    return rejectedPlan(descriptorId, "CITY_NOT_FOUND", [descriptorId], `no sim city record for ${cityId}`);
  }
  let total = 0;
  for (const path of record.resultPaths) {
    const doc = snapshotDoc(ctx.snapshot, path);
    if (doc && typeof doc.priceRubars === "number") total += doc.priceRubars as number;
  }
  const count = record.resultPaths.length;
  const beforeCount = docField(city, "stats.fixtureRestingOrders") ?? null;
  const beforeTotal = docField(city, "stats.fixtureOrderBookRubars") ?? null;
  let afterCity = withDocField(city, "stats.fixtureRestingOrders", count);
  afterCity = withDocField(afterCity, "stats.fixtureOrderBookRubars", total);
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, cityPath, afterCity, "state", [
    "stats.fixtureRestingOrders",
    "stats.fixtureOrderBookRubars",
  ]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [
        fieldChange("stats.fixtureRestingOrders", beforeCount, count, "resting-order count, derived from the bound collection read (F-01)"),
        fieldChange("stats.fixtureOrderBookRubars", beforeTotal, total, "resting-order total, derived from the bound collection read (F-01)"),
      ],
      recordsUpdated: [cityPath],
      summaryText: `${descriptorId}: ${count} resting order(s) in ${cityId}, ${total} R total — read from the materialized order-book query, not from actor citations.`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "orderbook-read", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      summaryText: `Order-book read for ${cityId}: ${count} resting, ${total} R.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// FIXTURE-JUDGMENT (Phase 4 Step 0, F-07) — the engine fixture for the
// prepared-payload contract: a market-style judgment whose value comes
// ONLY from the worker-prepared payload bound at preview time. The
// handler reads `ctx.prepared` and NOTHING from the action's
// structuredAction — the FIXTURE-MARKET `params.judgment` pattern
// (member supplies the judgment input) is acceptable in a fixture and
// a fairness breach as a product path: the AI-as-market judges;
// members never supply the judgment of their own company. The payload
// binding is source-agnostic (Vera's acceptance instruction): nothing
// here assumes the credited funds' source — cash, credit, or otherwise.
// ---------------------------------------------------------------------------

const JUDGMENT_CREDIT_FLOOR = 1;
const JUDGMENT_CREDIT_CEILING = 5000;

function judgmentHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "FIXTURE-JUDGMENT";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) {
    return rejectedPlan(descriptorId, "CITY_NOT_FOUND", [descriptorId], `no sim city record for ${cityId}`);
  }
  if (!ctx.prepared) {
    return rejectedPlan(
      descriptorId,
      "PREPARED_PAYLOAD_REQUIRED",
      [descriptorId],
      "This judgment resolves only from a worker-prepared payload bound at preview time (F-07); the action carries none."
    );
  }
  const credit = (ctx.prepared.classification as Record<string, unknown> | undefined)?.creditRubars;
  if (
    typeof credit !== "number" ||
    !Number.isFinite(credit) ||
    credit < JUDGMENT_CREDIT_FLOOR ||
    credit > JUDGMENT_CREDIT_CEILING
  ) {
    return rejectedPlan(
      descriptorId,
      "PREPARED_PAYLOAD_OUT_OF_BOUNDS",
      [descriptorId],
      `prepared classification.creditRubars must be a number in [${JUDGMENT_CREDIT_FLOOR}, ${JUDGMENT_CREDIT_CEILING}]`
    );
  }
  const plan = emptyPlan(descriptorId);
  const current = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
  const beforeTreasury = docField(current, "stats.treasuryRubars");
  const next = withDocField(current, "stats.treasuryRubars", (beforeTreasury as number) + credit);
  planWrite(plan, ctx.snapshot, cityPath, next, "state", ["stats.treasuryRubars"]);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(
          "stats.treasuryRubars",
          beforeTreasury,
          (beforeTreasury as number) + credit,
          `prepared judgment credit (inputHash ${ctx.prepared.inputHash})`
        ),
      ],
      recordsUpdated: [cityPath],
      summaryText: `${descriptorId}: prepared judgment credited ${credit} R to ${cityId} (payload ${ctx.prepared.inputHash}).`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: { verb: "judgment", scope: "city", ruleIds: [descriptorId], unruled: false },
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      summaryText: `Prepared-payload judgment for ${cityId}: +${credit} R.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Registry + indexes
// ---------------------------------------------------------------------------

/** Finance descriptors with their §2.4 META folded onto the registered
 * descriptor (Phase 4 Finance assembly). finance.ts value-imports
 * checkCityAuthority from this module; the registry is the evaluation
 * entry in every consuming graph (dispatcher, resolver, verifier,
 * suites), and finance.ts's top level only defines descriptors whose
 * handlers close over the import — nothing is called at module-eval
 * time, so the fold below reads a fully-evaluated FINANCE_DESCRIPTORS. */
const FINANCE_REGISTERED: Record<string, RuleDescriptor> = Object.fromEntries(
  Object.entries(FINANCE_DESCRIPTORS).map(([id, descriptor]) => [
    id,
    FINANCE_DESCRIPTOR_META[id]
      ? { ...descriptor, finance: FINANCE_DESCRIPTOR_META[id] }
      : descriptor,
  ])
);


/** Catalogue I descriptors with finance's §2.4 additions folded in
 * (Phase 4 Catalogue I assembly): structures' R-05 addition attaches
 * from STRUCTURE_FINANCE_ADDITIONS (its arrays are const-asserted in
 * the family file, so they are copied into the registered shape);
 * the law descriptors carry their additions inline already
 * (LAW_FINANCE_ADDITIONS, including F-08's, which rides R-08). */
const STRUCTURE_REGISTERED: Record<string, RuleDescriptor> = {
  ...STRUCTURE_DESCRIPTORS,
  "R-05": {
    ...STRUCTURE_DESCRIPTORS["R-05"],
    finance: {
      shortfallClass: STRUCTURE_FINANCE_ADDITIONS["R-05"].shortfallClass,
      ledgersTouched: [...STRUCTURE_FINANCE_ADDITIONS["R-05"].ledgersTouched],
      invokesRules: [...STRUCTURE_FINANCE_ADDITIONS["R-05"].invokesRules],
    },
  },
};

export const RULE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-32": {
    id: "R-32",
    actionKinds: ["fixture_fund", "fixture_schedule", ...CHAINS_DESCRIPTORS["R-32"].actionKinds],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: true,
    handlers: { fixture_fund: fundHandler, fixture_schedule: scheduleHandler, ...R32_PRODUCT_HANDLERS },
    // The chains read plan declares the fund record for the product
    // verbs only — gated here so a fixture fund/schedule manifest
    // never gains a spurious funds-path read (prep §5 A-1).
    readPlan: (seeds) =>
      seeds.action.actionType === "establish_fund" || seeds.action.actionType === "dissolve_fund"
        ? CHAINS_DESCRIPTORS["R-32"].readPlan!(seeds)
        : {},
    summary:
      "Pending consequences under Action-Gated Ripening: the Phase 2 fixture verbs (fixture_fund / fixture_schedule — creation of a determinate or generative pending inside an origin resolution) and the product fund verbs (establish_fund commits treasury Rubars into a named fund with published terms and schedules exactly one generation-1 pending, its delay derived by the landed formula and disclosed at creation; dissolve_fund returns unspent Rubars and ends the fund, its live pendings voiding at their next ripeness evaluation).",
  },
  "R-33": {
    id: "R-33",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: true,
    handlers: {},
    summary: "Ripening application (run inside ripening resolutions by the pending machinery, never by classification).",
  },
  "R-34": {
    id: "R-34",
    actionKinds: [],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {},
    summary: "Trickle-down propagation evaluation (information-only in Phase 2).",
  },
  "R-35": allocationDescriptor,
  ...FINANCE_REGISTERED,
  ...STRUCTURE_REGISTERED,
  ...LAW_DESCRIPTORS,
  ...DEFENSIVE_DESCRIPTORS,
  ...GROWTH_DESCRIPTORS,
  "FIXTURE-ADJUST": {
    id: "FIXTURE-ADJUST",
    actionKinds: ["fixture_adjust"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_adjust: adjustHandler },
    summary: "Fixture: clamped numeric adjustment of a city stat field.",
  },
  "FIXTURE-STRUCTURE": {
    id: "FIXTURE-STRUCTURE",
    actionKinds: ["fixture_structure"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_structure: structureHandler },
    summary: "Fixture: create or set the status of a structure record.",
  },
  "FIXTURE-CHECKIN": {
    id: "FIXTURE-CHECKIN",
    actionKinds: ["fixture_check_in"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_check_in: checkInHandler },
    summary: "Fixture: check in on a pending (registers the citation; no state change).",
  },
  "FIXTURE-COVERT": {
    id: "FIXTURE-COVERT",
    actionKinds: ["fixture_covert_note"],
    visibility: "covert",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_covert_note: covertNoteHandler },
    summary: "Fixture: covert collection — actor-private entries + an intel record.",
  },
  "FIXTURE-DISCOVER": {
    id: "FIXTURE-DISCOVER",
    actionKinds: ["fixture_discover"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_discover: discoverHandler },
    summary: "Fixture: publish the discovery of covert activity to the public Log.",
  },
  "FIXTURE-MARKET": {
    id: "FIXTURE-MARKET",
    actionKinds: ["fixture_market_judgment"],
    visibility: "public",
    requiresBaseline: true,
    defaultBaselineSections: ["WB-4.3"],
    mayCreatePendings: false,
    handlers: { fixture_market_judgment: marketJudgmentHandler },
    summary: "Fixture: a Baseline-dependent judgment (fails closed pre-ratification).",
  },
  "FIXTURE-SCATTER": {
    id: "FIXTURE-SCATTER",
    actionKinds: ["fixture_scatter"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_scatter: scatterHandler },
    summary: "Fixture: bulk structure creation for write-ceiling tests.",
  },
  "FIXTURE-VERIFY": {
    id: "FIXTURE-VERIFY",
    actionKinds: ["fixture_verify_publication"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_verify_publication: verifyPublicationHandler },
    summary: "Fixture: a resolution that relies on a publication record (S4 reliance realization).",
  },
  "FIXTURE-ORDERBOOK": {
    id: "FIXTURE-ORDERBOOK",
    actionKinds: ["fixture_orderbook"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_orderbook: orderbookHandler },
    readPlan: orderbookReadPlan,
    summary: "Fixture (Step 0, F-01): an order-book-shaped collection read, declared by the descriptor's read-plan hook and materialized into the snapshot.",
  },
  "FIXTURE-JUDGMENT": {
    id: "FIXTURE-JUDGMENT",
    actionKinds: ["fixture_judgment"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fixture_judgment: judgmentHandler },
    summary: "Fixture (Step 0, F-07): a judgment resolved only from the worker-prepared payload bound at preview time; the handler never reads judgment from the action itself.",
  },
};

export const ACTION_KIND_INDEX: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  for (const descriptor of Object.values(RULE_DESCRIPTORS)) {
    for (const kind of descriptor.actionKinds) index[kind] = descriptor.id;
  }
  return index;
})();

export function descriptorForActionKind(actionKind: string): RuleDescriptor | null {
  const id = ACTION_KIND_INDEX[actionKind];
  return id ? RULE_DESCRIPTORS[id] : null;
}

/** Build the handler context's citable Baseline (at the head seq + 1). */
export function baselineContextFor(
  baselineRegistry: BaselineRegistry,
  headSeq: number
): BaselineVersion | null {
  return citableBaselineVersion(baselineRegistry, headSeq + 1);
}

export { RESOLVER_RULES_VERSION };
