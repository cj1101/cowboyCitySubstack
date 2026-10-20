/**
 * R-35 — the Season-0 allocation commit handler (Phase 4 brief §3,
 * build-prep P4-K2/P4-K14; stat-model amendment §3, Vera's lock).
 *
 * Action kind `allocate_season0`: an ordinary action through the whole
 * play loop (§2) — submit → preview → hash-bound confirm → wake →
 * commit transaction. The handler is pure, like every handler: it reads
 * only the snapshot (the allocation doc arrives via this descriptor's
 * F-01 read-plan hook — the base read paths deliberately exclude
 * `sim_stat_allocations`, a Phase 2 posture this phase's first consumer
 * extends by declaration, never by improvisation inside the handler).
 *
 * Commit-grade validation (brief §3.2) runs here, at preview and again
 * inside the commit transaction: keys ⊆ the eight allocatable indices,
 * every value an integer in [0, 80], sum EXACTLY the 400 pool. Unspent
 * points are a refusal surfaced in the preview, never a silent loss.
 * Stocks are never allocatable; a stock key in the map is its own
 * refusal, distinct from a merely foreign key.
 *
 * The commit plan writes, atomically (committer's one transaction):
 *   - the eight index values into `sim_cities/{cityId}.stats`;
 *   - the allocation doc's commit fields (status "committed",
 *     allocations = final map, spentPoints 400, commitActionId,
 *     committedSeq, committedByUid);
 *   - the first versions record (`versions/v1`, source "first_login");
 *   - the city's first Log entries (Phase 1 decision K-4): one
 *     rule-effect entry carrying the eight stat changes — the full map,
 *     with pool / sum-check / baselineHash in its text — and the
 *     action-summary entry (TC-D04's anchor pair).
 *
 * Refusals (rejected plans; the resolver logs them as rejected):
 *   - a second commit for the city (status already "committed") —
 *     there is no override, no admin path, no respec (§3.4/§5.1);
 *   - a non-owner actor — or, for the shared city, a non-mayor actor
 *     (CJ round 3, §3.1; authority is revalidated here, Phase 2 §4
 *     step 3, so a revoked authority between preview and wake commits
 *     as a rejection, not a stale preview);
 *   - a stale draft: the payload binds the draft by version + hash
 *     (§3.3 step 1); if the saved draft has moved, the plan this
 *     handler returns differs from the previewed plan, so at wake the
 *     dispatcher takes the STALE_PREVIEW path (fresh preview, back to
 *     awaiting_confirmation, NO Log entry — §3.4). At preview time the
 *     same mismatch previews as the rejection it would become if the
 *     member confirmed against the moved draft anyway.
 *
 * committedSeq: the resolution's summary seq, derived the way
 * preview.ts derives originSeqIfCommitted — snapshot.counterHead
 * .lastSeq + the plan's entry count. It is a pure function of the
 * snapshot the plan binds, so preview and commit compute it
 * identically; if the counter moved, the heads moved and the wake goes
 * stale before this value can be wrong.
 *
 * previewHash on the version record is null IN THE PLAN: the confirmed
 * preview's hash is a committer-known value (the committer records it
 * in the resolution manifest from the action's stored preview), and a
 * handler that read it from the action doc would break preview/commit
 * parity — the action's lifecycle fields differ between the two runs
 * by design. The Lead's assembly notes carry the stamp option; the
 * manifest is the authoritative record either way.
 */

import { sha256Hex } from "../canonical";
import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
  type SimSnapshot,
} from "../state";
import { fieldChange, planWrite, rejectedPlan, ruleEffectDraft, summaryDraft } from "./planHelpers";
import type {
  DescriptorReadPlan,
  HandlerContext,
  ReadPlanSeeds,
  RuleDescriptor,
} from "./registry";

export const ALLOCATION_DESCRIPTOR_ID = "R-35";
export const ALLOCATE_SEASON0_KIND = "allocate_season0";

/** The Season-0 pool (Vera's lock; INITIAL_POINT_BUDGET in template.ts,
 * POINT_BUDGET in lib/allocation — one number, three citations). */
export const ALLOCATION_POOL = 400;
export const ALLOCATION_MIN = 0;
export const ALLOCATION_MAX = 80;

/** The eight allocatable indices, in the template's canonical order.
 * Final index values are allocated; stocks never are. The module
 * harness (allocation.test.ts) pins this list against both the sim
 * template's stat keys and the client module's ALLOCATABLE_STATS. */
export const ALLOCATABLE_INDEX_KEYS = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "military",
  "defense",
] as const;

/** Stock keys: real city stats that are NEVER allocatable (§3.2 of the
 * amendment). A map carrying one is refused as a stock allocation,
 * distinctly from a foreign key. */
export const STOCK_KEYS = [
  "population",
  "gdpRubars",
  "treasuryRubars",
  "households",
  "housingUnits",
] as const;

/** The first (and, absent a reallocation event, only) version doc id. */
export const FIRST_VERSION_ID = "v1";

export function allocationDocPath(cityId: string): string {
  return `sim_stat_allocations/${cityId}`;
}

export function allocationVersionPath(cityId: string, version: string): string {
  return `${allocationDocPath(cityId)}/versions/${version}`;
}

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  (sa(action).cityId as string | undefined) ?? action.targetCityIds[0] ?? "";

/**
 * The descriptor's read-plan hook (F-01): the allocation control doc
 * and the first-version doc are this handler's declared reads, derived
 * from the action itself (a stored-record seed — never from actor
 * citations, which may add reliance but cannot narrow this plan).
 */
export function allocationReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const cityId = actionCityId(seeds.action);
  if (!cityId) return {};
  return {
    paths: [allocationDocPath(cityId), allocationVersionPath(cityId, FIRST_VERSION_ID)],
  };
}

/** Owner authority over a city, mirroring the registry's
 * checkCityAuthority semantics (the registry's helper is not imported:
 * handler-family modules never runtime-import the registry — the
 * pendingRules precedent — so the descriptor drops into the registry
 * without an import cycle). The member uid, or the on-behalf-of uid
 * for delegated actors, must be in the faction's ownerUids. */
export function checkAllocationAuthority(
  snapshot: SimSnapshot,
  cityId: string,
  actor: SimActor
): { ok: true; uid: string } | { ok: false; reason: string } {
  const uid = actor.memberId ?? actor.onBehalfOfMemberId;
  if (!uid) return { ok: false, reason: "actor carries no member identity" };
  const faction = snapshotDoc(snapshot, `factions/${cityId}`);
  if (!faction) return { ok: false, reason: `no faction record for ${cityId}` };
  const owners = faction.ownerUids;
  if (!Array.isArray(owners) || !owners.includes(uid)) {
    return { ok: false, reason: `${uid} is not an owner of ${cityId}` };
  }
  return { ok: true, uid };
}

const shortHash = (hash: unknown): string =>
  typeof hash === "string" ? `${hash.slice(0, 12)}…` : String(hash);

/**
 * Commit-grade validation of a raw payload map (brief §3.2 + §3.4).
 * Returns the first refusal, in a deterministic order (shape → stock /
 * foreign keys → completeness → per-value integer/bounds in canonical
 * index order → exact sum), or the normalized final map.
 */
export function validateAllocationCommitMap(
  raw: unknown
): { ok: true; map: Record<string, number>; sum: number } | { ok: false; code: string; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      code: "MALFORMED_ALLOCATION",
      message: "allocate_season0 requires the final allocation map in the payload.",
    };
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input).sort()) {
    if ((STOCK_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: "STOCK_NOT_ALLOCATABLE",
        message: `"${key}" is a stock, not an index — stocks are never allocatable (amendment §3.2).`,
      };
    }
    if (!(ALLOCATABLE_INDEX_KEYS as readonly string[]).includes(key)) {
      return {
        ok: false,
        code: "UNKNOWN_STAT_KEY",
        message: `"${key}" is not an allocatable index. Only the eight indices (${ALLOCATABLE_INDEX_KEYS.join(", ")}) can be allocated.`,
      };
    }
  }
  const map: Record<string, number> = {};
  for (const key of ALLOCATABLE_INDEX_KEYS) {
    const value = input[key];
    if (value === undefined) {
      return {
        ok: false,
        code: "MISSING_STAT",
        message: `The commit map is missing "${key}" — a commit writes all eight index values (brief §3.3); a missing index would stay null in a committed city.`,
      };
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return {
        ok: false,
        code: "NON_INTEGER_VALUE",
        message: `${key} must be a whole number (got ${String(value)}).`,
      };
    }
    if (value < ALLOCATION_MIN || value > ALLOCATION_MAX) {
      return {
        ok: false,
        code: "VALUE_OUT_OF_BOUNDS",
        message: `${key} must be within [${ALLOCATION_MIN}, ${ALLOCATION_MAX}] at allocation (got ${value}). The top fifth of every index (81–100) is earned in play, never allocated.`,
      };
    }
    map[key] = value;
  }
  const sum = ALLOCATABLE_INDEX_KEYS.reduce((total, key) => total + map[key], 0);
  if (sum !== ALLOCATION_POOL) {
    return {
      ok: false,
      code: "SUM_NOT_EXACT",
      message:
        sum < ALLOCATION_POOL
          ? `${ALLOCATION_POOL - sum} unspent point${ALLOCATION_POOL - sum === 1 ? "" : "s"} — the commit will refuse until the map sums to exactly ${ALLOCATION_POOL}. Unspent points are not banked.`
          : `${sum - ALLOCATION_POOL} point${sum - ALLOCATION_POOL === 1 ? "" : "s"} over the pool — the map must sum to exactly ${ALLOCATION_POOL}.`,
    };
  }
  return { ok: true, map, sum };
}

export function allocateSeason0Handler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = ALLOCATION_DESCRIPTOR_ID;
  const ruleIds = [ALLOCATION_DESCRIPTOR_ID];
  const action = ctx.action;
  const params = sa(action);
  const cityId = actionCityId(action);
  if (!cityId) {
    return rejectedPlan(descriptorId, "NO_TARGET_CITY", ruleIds, "Action names no target city.");
  }
  const cityPath = `sim_cities/${cityId}`;
  const allocPath = allocationDocPath(cityId);
  const versionPath = allocationVersionPath(cityId, FIRST_VERSION_ID);

  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) return rejectedPlan(descriptorId, "NO_CITY", ruleIds, `City ${cityId} does not stand.`);
  const alloc = snapshotDoc(ctx.snapshot, allocPath);
  if (!alloc) {
    return rejectedPlan(
      descriptorId,
      "NO_ALLOCATION_DOC",
      ruleIds,
      `${cityId} has no allocation record — its sim city has not been lazily created, so there is no draft to commit.`
    );
  }

  // Authority (brief §3.1/§3.4): the owner — or, for the shared city,
  // the sitting mayor alone (CJ round 3). Mayor identity terms data is
  // Phase 7's; until then the guard enforces the shared-office actor
  // shape (office "mayor"), the same posture the undo engine takes
  // toward shared-office targets (undo.ts §8.4).
  let committedByUid: string;
  if (city.isSharedCity === true) {
    if (action.actor.type !== "shared-office" || action.actor.office !== "mayor" || !action.actor.memberId) {
      return rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        ruleIds,
        `${cityId} is the shared city: its Season-0 allocation is the sitting mayor's act alone (CJ round 3), and this actor is not a shared-office mayor actor.`
      );
    }
    committedByUid = action.actor.memberId;
  } else {
    const authority = checkAllocationAuthority(ctx.snapshot, cityId, action.actor);
    if (!authority.ok) {
      return rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        ruleIds,
        `Authority revoked for ${action.actor.memberId ?? "actor"} over ${cityId}: ${authority.reason}.`
      );
    }
    committedByUid = authority.uid;
  }

  // One commit ever (§3.4): a committed city refuses again, outright.
  const status = alloc.status;
  if (status === "committed") {
    return rejectedPlan(
      descriptorId,
      "ALREADY_COMMITTED",
      ruleIds,
      `${cityId}'s Season-0 allocation is already committed (seq ${String(alloc.committedSeq ?? "?")}). There is no second commit and no respec.`
    );
  }
  if (status === "superseded") {
    return rejectedPlan(
      descriptorId,
      "ALLOCATION_SUPERSEDED",
      ruleIds,
      `${cityId}'s allocation record is superseded; a superseded record cannot be committed.`
    );
  }
  if (status !== "not_started" && status !== "draft" && status !== "commit_requested") {
    return rejectedPlan(
      descriptorId,
      "ALLOCATION_NOT_COMMITTABLE",
      ruleIds,
      `${cityId}'s allocation record is in status ${String(status)}, which no commit path accepts.`
    );
  }

  // The pool is the Module 0 stamp (§3.6): an unstamped record means
  // the data step has not run for this city — refuse honestly rather
  // than invent the number.
  if (alloc.pointBudget !== ALLOCATION_POOL) {
    return rejectedPlan(
      descriptorId,
      "POOL_NOT_STAMPED",
      ruleIds,
      `${cityId}'s allocation record carries pointBudget ${String(alloc.pointBudget ?? null)} — the Season-0 pool (${ALLOCATION_POOL}) has not been stamped by the data step, so no commit can be validated against it.`
    );
  }

  // The payload binds the draft it commits (§3.3 step 1).
  const draftVersion = params.draftVersion;
  const draftHash = params.draftHash;
  if (!Number.isInteger(draftVersion) || typeof draftHash !== "string" || !/^[0-9a-f]{64}$/.test(draftHash)) {
    return rejectedPlan(
      descriptorId,
      "MALFORMED_ALLOCATION",
      ruleIds,
      "allocate_season0 payload must reference the draft it commits (draftVersion + draftHash, brief §3.3)."
    );
  }
  if (draftVersion !== alloc.draftVersion || draftHash !== alloc.draftHash) {
    return rejectedPlan(
      descriptorId,
      "STALE_DRAFT",
      ruleIds,
      `The saved draft has moved since this commit was submitted: the payload binds draft v${String(draftVersion)} (${shortHash(draftHash)}), the saved draft is v${String(alloc.draftVersion)} (${shortHash(alloc.draftHash)}). Nothing was committed; re-preview against the current draft.`
    );
  }

  // Commit-grade validation of the final map (brief §3.2).
  const validated = validateAllocationCommitMap(params.allocations);
  if (!validated.ok) {
    return rejectedPlan(descriptorId, validated.code, ruleIds, validated.message);
  }
  const finalMap = validated.map;

  // The payload's hash must be the saved draft's hash OF THIS MAP —
  // version + hash bind the draft record; this binds the map itself,
  // so a hand-built payload cannot ride a real draft reference with a
  // different map than the draft holds.
  const recomputed = sha256Hex({ allocations: finalMap, spentPoints: validated.sum });
  if (recomputed !== draftHash) {
    return rejectedPlan(
      descriptorId,
      "DRAFT_HASH_MISMATCH",
      ruleIds,
      "The payload map does not hash to the draft it references — the map in the payload is not the saved draft's map. Nothing was committed."
    );
  }

  const existingVersion = snapshotDoc(ctx.snapshot, versionPath);
  if (existingVersion) {
    return rejectedPlan(
      descriptorId,
      "VERSION_EXISTS",
      ruleIds,
      `${cityId} already holds a ${FIRST_VERSION_ID} allocation version record while its control doc reads ${String(status)} — an inconsistent state no commit may paper over.`
    );
  }

  // ---- The commit plan -------------------------------------------------
  const plan = emptyPlan(descriptorId);
  const statsBefore = (docField(city, "stats") ?? {}) as Record<string, unknown>;
  const mapText = ALLOCATABLE_INDEX_KEYS.map((key) => `${key} ${finalMap[key]}`).join(", ");

  const effectEntry = ruleEffectDraft({
    actor: action.actor,
    cityId,
    cityIds: [cityId],
    ruleIds,
    changes: ALLOCATABLE_INDEX_KEYS.map((key) =>
      fieldChange(
        `stats.${key}`,
        statsBefore[key] ?? null,
        finalMap[key],
        `R-35 Season-0 allocation: ${key} := ${finalMap[key]} (pool ${ALLOCATION_POOL}, sum exactly ${ALLOCATION_POOL}; baseline ${String(alloc.baselineHash)})`
      )
    ),
    recordsCreated: [versionPath],
    recordsUpdated: [cityPath, allocPath],
    summaryText:
      `R-35: Season-0 allocation committed for ${cityId} — ${mapText}. ` +
      `Pool ${ALLOCATION_POOL}, sum exactly ${validated.sum}; draft v${String(draftVersion)} (${shortHash(draftHash)}); baselineHash ${String(alloc.baselineHash)}.`,
    major: true,
  });
  const summaryEntry = summaryDraft({
    actor: action.actor,
    actionId: action.actionId,
    actionText: action.actionText,
    classification: { verb: "commit-allocation", scope: "city", ruleIds, unruled: false },
    cityId,
    cityIds: [cityId],
    ruleIds,
    summaryText:
      `Committed the Season-0 allocation for ${cityId}: ${mapText}. ` +
      "One-time; there is no respec — indices move from here only through play.",
    major: true,
  });
  plan.entries.push(effectEntry, summaryEntry);

  // The resolution's summary seq (see header): this value is stamped
  // onto both records the commit produces, so the version chain and
  // the control doc cite the same seq the manifest will carry.
  const commitSeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length;

  const afterCity = withDocField(city, "stats", { ...statsBefore, ...finalMap });
  planWrite(plan, ctx.snapshot, cityPath, afterCity, "state", [
    ...ALLOCATABLE_INDEX_KEYS.map((key) => `stats.${key}`),
  ]);

  const afterAlloc: Record<string, unknown> = {
    ...alloc,
    status: "committed",
    allocations: finalMap,
    spentPoints: validated.sum,
    commitActionId: ctx.resolutionId,
    committedSeq: commitSeq,
    committedByUid,
  };
  planWrite(plan, ctx.snapshot, allocPath, afterAlloc, "state", [
    "status",
    "allocations",
    "spentPoints",
    "commitActionId",
    "committedSeq",
    "committedByUid",
  ]);

  const versionDoc: Record<string, unknown> = {
    cityId,
    source: "first_login",
    allocations: finalMap,
    spentPoints: validated.sum,
    draftVersion,
    draftHash,
    authorUid: typeof alloc.authorUid === "string" ? alloc.authorUid : committedByUid,
    // Null in the plan by design (see header): the committer records
    // the confirmed preview's hash in the resolution manifest.
    previewHash: null,
    commitSeq,
    // Committer-stamped at commit (plans are clock-free).
    createdAt: null,
  };
  planWrite(plan, ctx.snapshot, versionPath, versionDoc, "state", [
    "cityId",
    "source",
    "allocations",
    "spentPoints",
    "draftVersion",
    "draftHash",
    "authorUid",
    "previewHash",
    "commitSeq",
    "createdAt",
  ]);

  for (const id of ctx.citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of ctx.citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of ctx.citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of ctx.citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${ctx.resolutionId}`);
  return plan;
}

/**
 * The R-35 descriptor. The Build Lead registers it in
 * lib/sim/rules/registry.ts (RULE_DESCRIPTORS + the ACTION_KIND_INDEX
 * picks the kind up from actionKinds) — this module deliberately does
 * not edit the registry (assembly ownership, prep §2.2).
 */
export const allocationDescriptor: RuleDescriptor = {
  id: ALLOCATION_DESCRIPTOR_ID,
  actionKinds: [ALLOCATE_SEASON0_KIND],
  visibility: "public",
  requiresBaseline: false,
  defaultBaselineSections: [],
  mayCreatePendings: false,
  handlers: { [ALLOCATE_SEASON0_KIND]: allocateSeason0Handler },
  readPlan: allocationReadPlan,
  summary:
    "Season-0 allocation commit (R-35): the founding build — 400 points across the eight indices as final values, sum exactly 400, one-time, no respec; the city's first Log entries.",
};
