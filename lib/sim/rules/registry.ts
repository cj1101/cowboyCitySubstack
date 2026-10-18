/**
 * The rule registry (Phase 2 brief §5.2).
 *
 * Phase 2 ships the engine contract, the pending machinery's three rule
 * descriptors (R-32 creation, R-33 ripening application, R-34 trickle-down
 * evaluation), and the fixture rules the gate's tests run through. R-33
 * and R-34 never classify an action — they run inside ripening — so they
 * have no action kinds. R-01…R-31, R-35…R-38 product handlers are NOT
 * Phase 2 (decision P2-K12): they land with their Phase 4/5/7 action
 * surfaces, each one carrying its own rule table rows here.
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
import { fieldChange, planWrite, rejectedPlan, ruleEffectDraft, summaryDraft } from "./planHelpers";

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

export interface RuleDescriptor {
  id: string;
  actionKinds: string[];
  visibility: "public" | "covert";
  requiresBaseline: boolean;
  defaultBaselineSections: string[];
  mayCreatePendings: boolean;
  handlers: Record<string, HandlerFn>;
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
      summaryText: t.summaryText,
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
      summaryText: t.summaryText,
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
      changes: [fieldChange("status", before, status, `${descriptorId} fixture state machine`)],
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
    collectorUid: ctx.action.actor.memberId,
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
// Registry + indexes
// ---------------------------------------------------------------------------

export const RULE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-32": {
    id: "R-32",
    actionKinds: ["fixture_fund", "fixture_schedule"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: true,
    handlers: { fixture_fund: fundHandler, fixture_schedule: scheduleHandler },
    summary: "Creation of a pending consequence (determinate or generative) inside an origin resolution.",
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
