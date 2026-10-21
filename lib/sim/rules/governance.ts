/**
 * Phase 5 governance — registration + engine core (Phase 5 train
 * PR-1 substrate; PR-2 engine core; assembly plan W1/W2, brief §3.3,
 * decisions P5-K6).
 *
 * PR-2 state: `npc.create` (activation composition), `npc.edit`,
 * `npc.retire`, `npc.setMode`, `mandate.set`, `mandate.revoke`,
 * `delegationRule.set`, `envelope.spawn`, and `envelope.cancel` are
 * LIVE handlers composed over the ahead-built modules (`lib/npcs`,
 * `lib/envelopes`, `lib/authority` for the Tier B authoring fence).
 * The `situation.*` kinds keep their PR-1 deferral handlers naming
 * PR-3 — registered, logged, never silent (R-29 idiom).
 *
 * Adapter discipline (PR-1's, carried): BUILDER_EPOCH is handed to the
 * module builders; plans stay clock-free — CREATE writes null
 * createdAt/updatedAt for the committer's in-transaction stamps, and
 * UPDATE writes preserve the stored createdAt and null only updatedAt.
 * Module `NpcCoreError` codes pass through as rejection codes. Entry
 * `changes` stay [] for these top-level collections (the F-02
 * reconciliation only resolves change fields inside the city doc
 * tree); effects are claimed by recordsCreated/recordsUpdated.
 *
 * Seq stamping follows the landed precedent: a plan's seq-carrying
 * doc fields (activationSeq, retiredSeq, effectiveSeq, createdSeq)
 * take `summarySeq = snapshot.counterHead.lastSeq + plan.entries.length`,
 * with each handler's entry count fixed by construction (one summary
 * entry per governance resolution).
 *
 * Roster-affecting kinds (npc.create / npc.retire) require the city
 * to be named on the action (structuredAction.cityId or
 * targetCityIds): the roster query and team doc are read-plan reads,
 * and a handler never derives a roster from a partial snapshot.
 */

import {
  emptyPlan,
  snapshotDoc,
  type CollectionQuerySpec,
  type ResolutionPlan,
  type SimAction,
  type SimCitations,
  type SimSnapshot,
} from "../state";
import { canonicalJson, sha256HexOfText } from "../canonical";
import { planWrite, rejectedPlan, summaryDraft } from "./planHelpers";
import {
  descriptorForActionKind,
  requireAuthority,
  type DescriptorReadPlan,
  type HandlerContext,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";
import {
  NpcCoreError,
  buildMandateRoot,
  buildMandateVersion,
  buildNpcActivation,
  buildNpcCreate,
  buildNpcEdit,
  buildNpcMandateSnapshot,
  buildNpcRetirement,
  buildNpcSetMode,
  deriveTeamRoster,
  isPermissionMode,
  mandateHash,
  type MandateVersionInput,
  type NpcCreateInput,
  type PermissionMode,
  type SimMandateRoot,
  type SimMandateVersion,
  type SimNpc,
  type SimTeam,
} from "../../npcs";
import { TIER_B_RULE_IDS } from "../../authority";
import { cityContextFromDocs, type MandateVersionRecord, type NpcRecord } from "../../authority";
import {
  EnvelopeValidationError,
  buildTaskEnvelope,
  envelopeTaskId,
  validateEnvelopeSpawn,
  type EnvelopeSpawnSource,
  type TaskEnvelopeRecord,
} from "../../envelopes";

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const num = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

function actorCitations(plan: ResolutionPlan, citations: SimCitations, resolutionId: string): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

/** The fixed instant handed to module builders; its value never
 * reaches a stored doc (timestamps are nulled for the committer). */
const BUILDER_EPOCH = new Date(0);

export const NPC_ROSTER_QUERY_ID = "npc-roster";

function summarySeqFor(ctx: HandlerContext, entryCount = 1): number {
  return ctx.snapshot.counterHead.lastSeq + entryCount;
}

/** Clock-free stamps: CREATE writes null both timestamps; UPDATE
 * writes preserve the stored createdAt and null only updatedAt. */
function nullStamps(plan: ResolutionPlan): void {
  for (const write of plan.writes) {
    if (!write.afterDoc) continue;
    if ("updatedAt" in write.afterDoc) write.afterDoc.updatedAt = null;
    if (write.op === "create" && "createdAt" in write.afterDoc) {
      write.afterDoc.createdAt = null;
    }
  }
}

function asNpc(doc: Record<string, unknown>): SimNpc {
  return doc as unknown as SimNpc;
}
function asRoot(doc: Record<string, unknown>): SimMandateRoot {
  return doc as unknown as SimMandateRoot;
}
function asVersion(doc: Record<string, unknown>): SimMandateVersion {
  return doc as unknown as SimMandateVersion;
}
function asTeam(doc: Record<string, unknown> | null): SimTeam | null {
  return doc as unknown as SimTeam | null;
}

/** The city's NPC records materialized by the roster query. */
function rosterNpcs(snapshot: SimSnapshot): SimNpc[] {
  const record = snapshot.queries.find((q) => q.spec.id === NPC_ROSTER_QUERY_ID);
  if (!record) return [];
  const out: SimNpc[] = [];
  for (const path of record.resultPaths) {
    const doc = snapshotDoc(snapshot, path);
    if (doc) out.push(asNpc(doc));
  }
  return out;
}

function moduleRejection(
  descriptorId: string,
  error: unknown,
  verb: string
): ResolutionPlan | null {
  if (error instanceof NpcCoreError) {
    return rejectedPlan(descriptorId, error.code, [descriptorId], `${verb} refused: ${error.message}`);
  }
  if (error instanceof EnvelopeValidationError) {
    return rejectedPlan(descriptorId, "ENVELOPE_INVALID", [descriptorId], `${verb} refused: ${error.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The owner gate for governance handlers (brief §2.1 write rule):
// member actor AND (the NPC's city faction ownerUids include the actor
// OR the NPC's ownerUid is the actor) — co-owner support. Creation's
// owner-of-record stays the acting member (PR-1).
// ---------------------------------------------------------------------------

type GovernanceGate =
  | { ok: true; npcDoc: Record<string, unknown>; npc: SimNpc }
  | { ok: false; plan: ResolutionPlan };

function requireNpcGovernance(
  ctx: HandlerContext,
  descriptorId: string,
  npcId: string
): GovernanceGate {
  const actor = ctx.action.actor;
  if (actor.type !== "member" || !actor.memberId) {
    return {
      ok: false,
      plan: rejectedPlan(
        descriptorId,
        "ACTOR_NOT_MEMBER",
        [descriptorId],
        "governance is an owner act: the actor must be the owning member."
      ),
    };
  }
  const npcDoc = snapshotDoc(ctx.snapshot, `sim_npcs/${npcId}`);
  if (!npcDoc) {
    return {
      ok: false,
      plan: rejectedPlan(
        descriptorId,
        "NPC_NOT_FOUND",
        [descriptorId],
        `No NPC record stands at sim_npcs/${npcId}.`
      ),
    };
  }
  const faction = snapshotDoc(ctx.snapshot, `factions/${str(npcDoc.cityId) ?? ""}`);
  const owners = faction?.ownerUids;
  const isCoOwner = Array.isArray(owners) && owners.includes(actor.memberId);
  if (npcDoc.ownerUid !== actor.memberId && !isCoOwner) {
    return {
      ok: false,
      plan: rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        [descriptorId],
        `Authority revoked for ${actor.memberId} over NPC ${npcId}: neither the NPC's owner nor a current owner of ${String(npcDoc.cityId)}.`
      ),
    };
  }
  return { ok: true, npcDoc, npc: asNpc(npcDoc) };
}

function requireMember(ctx: HandlerContext, descriptorId: string): ResolutionPlan | null {
  const actor = ctx.action.actor;
  if (actor.type !== "member" || !actor.memberId) {
    return rejectedPlan(
      descriptorId,
      "ACTOR_NOT_MEMBER",
      [descriptorId],
      "governance is an owner act: the actor must be the owning member."
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Read plans — per-descriptor unions over the descriptor's kinds
// (F-01: every read a handler needs is declared here, from the action
// plus stored seed docs; the mandate version path derives two-phase
// via the root doc, which the action cites in citations.recordPaths
// and the mandate read plan also declares directly).
// ---------------------------------------------------------------------------

function actionCityId(seeds: ReadPlanSeeds): string | null {
  return str(sa(seeds.action).cityId) ?? seeds.action.targetCityIds[0] ?? null;
}

function npcReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  const queries: CollectionQuerySpec[] = [];
  const kind = seeds.action.actionType;
  const characterId = str(params.characterId);
  const npcId =
    str(params.npcId) ?? characterId ?? str(params.mintedCharacterId);
  if (npcId) paths.push(`sim_npcs/${npcId}`);
  if (characterId) paths.push(`characters/${characterId}`);
  const cityId = actionCityId(seeds);
  if (cityId) {
    paths.push(`factions/${cityId}`, `sim_teams/${cityId}`);
    if (kind === "npc.create" || kind === "npc.retire") {
      queries.push({
        id: NPC_ROSTER_QUERY_ID,
        collectionPath: "sim_npcs",
        filters: [{ field: "cityId", op: "==", value: cityId }],
      });
    }
  }
  // npc.setMode with a mandate in force (P5-D3 version roll) reads the
  // mandate root + its current version. Two-phase (F-01): the action
  // cites the root in citations.recordPaths (a base read, hence a seed
  // doc here), and the version path derives from the STORED root —
  // never from actor nomination.
  for (const [path, doc] of seeds.seedDocs) {
    if (!path.startsWith("sim_mandates/") || path.includes("/versions/") || !doc) continue;
    const currentVersion = num(doc.currentVersion);
    if (currentVersion !== null) paths.push(`${path}/versions/${currentVersion}`);
    const rootNpcId = str(doc.npcId);
    if (rootNpcId) paths.push(`sim_npcs/${rootNpcId}`);
  }
  return { paths, queries };
}

function mandateReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  const mandateId = str(params.mandateId);
  if (mandateId) {
    const rootPath = `sim_mandates/${mandateId}`;
    paths.push(rootPath);
    const root = seeds.seedDocs.get(rootPath) ?? null;
    const currentVersion = num(root?.currentVersion);
    if (currentVersion !== null) {
      paths.push(`sim_mandates/${mandateId}/versions/${currentVersion}`);
    }
    const citedVersion = num(params.version);
    if (citedVersion !== null) {
      paths.push(`sim_mandates/${mandateId}/versions/${citedVersion}`);
    }
    const npcId = str(params.npcId) ?? str(root?.npcId);
    if (npcId) paths.push(`sim_npcs/${npcId}`);
    const cityId = str(params.cityId) ?? str(root?.cityId) ?? actionCityId(seeds);
    if (cityId) paths.push(`factions/${cityId}`);
  } else {
    const npcId = str(params.npcId);
    if (npcId) paths.push(`sim_npcs/${npcId}`);
    const cityId = actionCityId(seeds);
    if (cityId) paths.push(`factions/${cityId}`);
  }
  return { paths };
}

function delegationRuleReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  const ruleId = str(params.ruleId);
  if (ruleId) {
    const rootPath = `sim_delegation_rules/${ruleId}`;
    paths.push(rootPath);
    const root = seeds.seedDocs.get(rootPath) ?? null;
    const citedVersion = num(params.version);
    if (citedVersion !== null) {
      paths.push(`sim_delegation_rules/${ruleId}/versions/${citedVersion}`);
    }
    const rootVersion = num(root?.version);
    if (rootVersion !== null) {
      paths.push(`sim_delegation_rules/${ruleId}/versions/${rootVersion + 1}`);
    }
  }
  const handler = (params.handler ?? {}) as Record<string, unknown>;
  const handlerNpcId = str(handler.npcId);
  if (handlerNpcId) paths.push(`sim_npcs/${handlerNpcId}`);
  const cityId = actionCityId(seeds);
  if (cityId) paths.push(`factions/${cityId}`);
  return { paths };
}

function envelopeReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const paths: string[] = [];
  const requester = seeds.action.actor.memberId;
  const clientRequestId = str(params.clientRequestId) ?? seeds.action.actionId;
  if (requester) {
    paths.push(`sim_task_envelopes/${envelopeTaskId(requester, clientRequestId)}`);
  }
  const taskId = str(params.taskId);
  if (taskId) paths.push(`sim_task_envelopes/${taskId}`);
  const npcId = str(params.npcId);
  if (npcId) paths.push(`sim_npcs/${npcId}`);
  const bounds = (params.bounds ?? {}) as Record<string, unknown>;
  const counterparties = Array.isArray(bounds.counterpartyCityIds)
    ? bounds.counterpartyCityIds
    : params.counterpartyCityIds;
  if (Array.isArray(counterparties)) {
    for (const c of counterparties) {
      if (typeof c === "string") paths.push(`factions/${c}`);
    }
  }
  return { paths };
}

// ---------------------------------------------------------------------------
// Deferral handlers (R-29 idiom) — retained for the situation.* kinds.
// ---------------------------------------------------------------------------

function deferralHandler(
  descriptorId: string,
  kind: string,
  landing: { step: string; label: string }
): (ctx: HandlerContext) => ResolutionPlan {
  return (ctx: HandlerContext): ResolutionPlan => {
    const plan = emptyPlan(descriptorId);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: ctx.action.targetCityIds[0] ?? null,
        cityIds: ctx.action.targetCityIds,
        ruleIds: [descriptorId],
        classification: {
          verb: kind,
          scope: "governance",
          ruleIds: [descriptorId],
          unruled: false,
          narrativeOnly: true,
          deferral: landing.step,
        },
        summaryText:
          `${kind} is REGISTERED but its engine lands with ${landing.label}: ` +
          `the Phase 5 substrate (PR-1) registers the governance surface and its rules/index fences only, ` +
          `so this action resolves narrative-only by design — no record is written, no state changes. ` +
          `Stated in the open, never silently (the R-29 discipline).`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  };
}

// ---------------------------------------------------------------------------
// npc.create — activation composition (Cato flag 5 resolved as
// same-resolution composition, brief §1.2): the module doc builders
// compose into ONE plan whose folded net write is the ACTIVE record +
// the roster write. A stored pending_activation record owned by the
// actor (the rules-level client-authored flow) is activated instead
// of refused.
// ---------------------------------------------------------------------------

function rosterWrite(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  cityId: string,
  ownerUid: string,
  npcs: SimNpc[],
  changedSeq: number
): string {
  const teamPath = `sim_teams/${cityId}`;
  const previous = asTeam(snapshotDoc(ctx.snapshot, teamPath));
  const { team } = deriveTeamRoster(cityId, ownerUid, npcs, previous, changedSeq, BUILDER_EPOCH);
  planWrite(plan, ctx.snapshot, teamPath, { ...team }, "state", ["npcIds", "lastChangedSeq"]);
  return teamPath;
}

function npcCreateHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "npc.create";
  const denied = requireAuthority(ctx, descriptorId, descriptorId);
  if (denied) return denied;
  const actor = ctx.action.actor;
  if (actor.type !== "member" || !actor.memberId) {
    return rejectedPlan(
      descriptorId,
      "ACTOR_NOT_MEMBER",
      [descriptorId],
      "npc.create is an owner governance act: the actor must be the owning member."
    );
  }
  const params = sa(ctx.action);
  const cityId = str(params.cityId) ?? ctx.action.targetCityIds[0] ?? "";
  const characterId = str(params.characterId);
  if (characterId && !snapshotDoc(ctx.snapshot, `characters/${characterId}`)) {
    return rejectedPlan(
      descriptorId,
      "NO_CHARACTER",
      [descriptorId],
      `npc.create links character ${characterId}, which does not stand.`
    );
  }
  const npcId = characterId ?? str(params.mintedCharacterId) ?? "";
  const npcPath = `sim_npcs/${npcId}`;
  const existing = npcId ? snapshotDoc(ctx.snapshot, npcPath) : null;

  // Client-authored posture: a pending_activation record the actor owns
  // is activated in this resolution instead of refused.
  if (existing && existing.status === "pending_activation") {
    const gate = requireNpcGovernance(ctx, descriptorId, npcId);
    if (!gate.ok) return gate.plan;
    const summarySeq = summarySeqFor(ctx);
    try {
      const activated = buildNpcActivation(gate.npc, summarySeq, BUILDER_EPOCH);
      const plan = emptyPlan(descriptorId);
      planWrite(plan, ctx.snapshot, npcPath, { ...activated }, "state", ["status", "activationSeq"]);
      const roster = rosterNpcs(ctx.snapshot).map((n) =>
        n.npcId === npcId ? activated : n
      );
      if (!roster.some((n) => n.npcId === npcId)) roster.push(activated);
      const teamPath = rosterWrite(plan, ctx, gate.npc.cityId, gate.npc.ownerUid, roster, summarySeq);
      nullStamps(plan);
      plan.entries.push(
        summaryDraft({
          actor: ctx.action.actor,
          actionId: ctx.action.actionId,
          actionText: ctx.action.actionText,
          cityId: gate.npc.cityId,
          cityIds: [gate.npc.cityId],
          ruleIds: [descriptorId],
          classification: { verb: "npc.create", scope: "city", ruleIds: [descriptorId], unruled: false },
          recordsUpdated: [npcPath, teamPath],
          summaryText: `${gate.npc.displayNameSnapshot} activated as an NPC for city ${gate.npc.cityId} (the pending record the owner authored is now effective).`,
        })
      );
      actorCitations(plan, ctx.citations, ctx.resolutionId);
      return plan;
    } catch (error) {
      const rejection = moduleRejection(descriptorId, error, "npc.create");
      if (rejection) return rejection;
      throw error;
    }
  }
  if (existing) {
    return rejectedPlan(
      descriptorId,
      "NPC_ALREADY_EXISTS",
      [descriptorId],
      `An NPC record already stands at sim_npcs/${npcId}; creation does not overwrite it.`
    );
  }

  const input: NpcCreateInput = {
    characterId,
    mintedCharacterId: str(params.mintedCharacterId),
    cityId,
    // The owner of record is the acting member — never a payload field.
    ownerUid: actor.memberId,
    displayNameSnapshot: params.displayNameSnapshot as string,
    titleFreeform: params.titleFreeform as string,
    roleTemplate: typeof params.roleTemplate === "string" ? params.roleTemplate : null,
    personality: params.personality as NpcCreateInput["personality"],
    scopeFreeform: params.scopeFreeform as string,
    permissionMode:
      typeof params.permissionMode === "string"
        ? (params.permissionMode as PermissionMode)
        : null,
  };
  try {
    const summarySeq = summarySeqFor(ctx);
    const pending = buildNpcCreate(input, BUILDER_EPOCH);
    const activated = buildNpcActivation(pending, summarySeq, BUILDER_EPOCH);
    const plan = emptyPlan(descriptorId);
    planWrite(plan, ctx.snapshot, npcPath, { ...activated }, "state", [
      "status",
      "activationSeq",
      "permissionMode",
      "characterId",
    ]);
    const roster = [...rosterNpcs(ctx.snapshot), activated];
    const teamPath = rosterWrite(plan, ctx, cityId, actor.memberId, roster, summarySeq);
    nullStamps(plan);
    const teamWrite = plan.writes.find((w) => w.path === teamPath);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId,
        cityIds: [cityId],
        ruleIds: [descriptorId],
        classification: { verb: "npc.create", scope: "city", ruleIds: [descriptorId], unruled: false },
        recordsCreated: teamWrite?.op === "create" ? [npcPath, teamPath] : [npcPath],
        recordsUpdated: teamWrite?.op === "update" ? [teamPath] : [],
        summaryText: `${activated.displayNameSnapshot} created and activated as an NPC for city ${cityId}.`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "npc.create");
    if (rejection) return rejection;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// npc.edit / npc.retire / npc.setMode
// ---------------------------------------------------------------------------

function npcEditHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "npc.create";
  const params = sa(ctx.action);
  const npcId = str(params.npcId) ?? str(params.characterId) ?? "";
  const gate = requireNpcGovernance(ctx, descriptorId, npcId);
  if (!gate.ok) return gate.plan;
  const edit: Parameters<typeof buildNpcEdit>[1] = {};
  if (params.displayNameSnapshot !== undefined) edit.displayNameSnapshot = params.displayNameSnapshot as string;
  if (params.titleFreeform !== undefined) edit.titleFreeform = params.titleFreeform as string;
  if (params.roleTemplate !== undefined) edit.roleTemplate = params.roleTemplate as string | null;
  if (params.scopeFreeform !== undefined) edit.scopeFreeform = params.scopeFreeform as string;
  if (params.personality !== undefined) edit.personality = params.personality as never;
  try {
    const edited = buildNpcEdit(gate.npc, edit, BUILDER_EPOCH);
    const plan = emptyPlan(descriptorId);
    const npcPath = `sim_npcs/${npcId}`;
    planWrite(plan, ctx.snapshot, npcPath, { ...edited }, "state", [
      "displayNameSnapshot",
      "titleFreeform",
      "roleTemplate",
      "scopeFreeform",
      "personality",
    ]);
    nullStamps(plan);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: gate.npc.cityId,
        cityIds: [gate.npc.cityId],
        ruleIds: [descriptorId],
        classification: { verb: "npc.edit", scope: "city", ruleIds: [descriptorId], unruled: false },
        recordsUpdated: [npcPath],
        summaryText: `${edited.displayNameSnapshot} (NPC for ${gate.npc.cityId}) edited by its owner.`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "npc.edit");
    if (rejection) return rejection;
    throw error;
  }
}

function npcRetireHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "npc.create";
  const params = sa(ctx.action);
  const npcId = str(params.npcId) ?? str(params.characterId) ?? "";
  const gate = requireNpcGovernance(ctx, descriptorId, npcId);
  if (!gate.ok) return gate.plan;
  try {
    const summarySeq = summarySeqFor(ctx);
    // Retiring a pending_activation NPC is allowed (the builder refuses
    // only already-retired).
    const retired = buildNpcRetirement(gate.npc, summarySeq, BUILDER_EPOCH);
    const plan = emptyPlan(descriptorId);
    const npcPath = `sim_npcs/${npcId}`;
    planWrite(plan, ctx.snapshot, npcPath, { ...retired }, "state", ["status", "retiredSeq"]);
    const roster = rosterNpcs(ctx.snapshot).map((n) => (n.npcId === npcId ? retired : n));
    if (!roster.some((n) => n.npcId === npcId)) roster.push(retired);
    const teamPath = rosterWrite(plan, ctx, gate.npc.cityId, gate.npc.ownerUid, roster, summarySeq);
    nullStamps(plan);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: gate.npc.cityId,
        cityIds: [gate.npc.cityId],
        ruleIds: [descriptorId],
        classification: { verb: "npc.retire", scope: "city", ruleIds: [descriptorId], unruled: false },
        recordsUpdated: [npcPath, teamPath],
        summaryText: `${retired.displayNameSnapshot} retired as an NPC for city ${gate.npc.cityId}; the team roster no longer lists it.`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "npc.retire");
    if (rejection) return rejection;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Mandate helpers shared by npc.setMode and mandate.set.
// ---------------------------------------------------------------------------

/** The Tier B authoring fence (resolver half): any allowedActionType
 * whose classifying descriptor id ∈ TIER_B_RULE_IDS refuses the
 * version. Prose-side/free-string kinds are the composer/UI fence's
 * half, not mechanically classifiable — recorded as the seam. */
function tierBAuthoringRejection(
  descriptorId: string,
  allowedActionTypes: string[]
): ResolutionPlan | null {
  for (const actionType of allowedActionTypes) {
    const descriptor = descriptorForActionKind(actionType);
    if (descriptor && TIER_B_RULE_IDS.has(descriptor.id)) {
      return rejectedPlan(
        descriptorId,
        "MANDATE_AUTHORIZES_TIER_B",
        [descriptorId],
        `mandate.set refused: allowedActionType "${actionType}" classifies under ${descriptor.id}, a Tier B rule — Tier B can never be delegated (brief §5.4).`
      );
    }
  }
  return null;
}

function mandateVersionInputFromAction(
  ctx: HandlerContext,
  npc: SimNpc,
  mandateId: string,
  version: number
): MandateVersionInput {
  const params = sa(ctx.action);
  return {
    version,
    npcId: npc.npcId,
    cityId: npc.cityId,
    ownerUid: npc.ownerUid,
    permissionMode: params.permissionMode as PermissionMode,
    scopeFreeform: params.scopeFreeform as string,
    structuredScope: params.structuredScope as MandateVersionInput["structuredScope"],
    caps: params.caps as MandateVersionInput["caps"],
    negotiationBounds:
      (params.negotiationBounds as MandateVersionInput["negotiationBounds"]) ?? null,
    alwaysEscalate: Array.isArray(params.alwaysEscalate)
      ? (params.alwaysEscalate as string[])
      : [],
    responseStyle: (params.responseStyle as string | null) ?? null,
    expiresAtSeq: num(params.expiresAtSeq),
    horizonActions: num(params.horizonActions),
    sourceActionId: ctx.action.actionId,
  };
}

/** Roll writes for making `versionAfter` (already built, with
 * effectiveSeq stamped) the current version of an existing root:
 * old-version supersede + root pointer + NPC snapshot. */
function planMandateEffectiveness(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    mandateId: string;
    rootDoc: Record<string, unknown>;
    npc: SimNpc;
    versionAfter: SimMandateVersion;
    previousVersionDoc: Record<string, unknown> | null;
    summarySeq: number;
    rootStatus: string;
  }
): { rootPath: string; versionPath: string; previousVersionPath: string | null; npcPath: string } {
  const rootPath = `sim_mandates/${args.mandateId}`;
  const versionPath = `${rootPath}/versions/${args.versionAfter.version}`;
  const rootAfter: Record<string, unknown> = {
    ...args.rootDoc,
    currentVersion: args.versionAfter.version,
    currentVersionRef: versionPath,
    status: args.rootStatus,
    expiresAtSeq: args.versionAfter.expiresAtSeq,
    updatedAt: null,
  };
  const npcAfter = buildNpcMandateSnapshot(
    args.npc,
    asRoot(rootAfter),
    args.versionAfter,
    BUILDER_EPOCH
  );
  let previousVersionPath: string | null = null;
  if (args.previousVersionDoc) {
    previousVersionPath = `${rootPath}/versions/${String(args.previousVersionDoc.version)}`;
    if (previousVersionPath !== versionPath) {
      planWrite(
        plan,
        ctx.snapshot,
        previousVersionPath,
        { ...args.previousVersionDoc, supersededSeq: args.summarySeq },
        "state",
        ["supersededSeq"]
      );
    }
  }
  planWrite(plan, ctx.snapshot, versionPath, { ...args.versionAfter }, "state", [
    "effectiveSeq",
    "mandateHash",
  ]);
  planWrite(plan, ctx.snapshot, rootPath, rootAfter, "state", [
    "currentVersion",
    "currentVersionRef",
    "status",
    "expiresAtSeq",
  ]);
  const npcPath = `sim_npcs/${args.npc.npcId}`;
  planWrite(plan, ctx.snapshot, npcPath, { ...npcAfter }, "state", [
    "currentMandateId",
    "currentMandateVersion",
    "permissionMode",
  ]);
  return { rootPath, versionPath, previousVersionPath, npcPath };
}

function npcSetModeHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "npc.create";
  const params = sa(ctx.action);
  const npcId = str(params.npcId) ?? str(params.characterId) ?? "";
  const gate = requireNpcGovernance(ctx, descriptorId, npcId);
  if (!gate.ok) return gate.plan;
  const mode = params.permissionMode;
  if (!isPermissionMode(mode)) {
    return rejectedPlan(
      descriptorId,
      "INVALID_MODE",
      [descriptorId],
      `npc.setMode names an unknown permission mode: ${String(mode)}.`
    );
  }
  const npcPath = `sim_npcs/${npcId}`;
  try {
    // P5-D3: WITH a mandate in force, the mode change rolls the
    // version (copy payload, replace permissionMode + sourceActionId);
    // WITHOUT one, the snapshot alone moves.
    if (gate.npc.currentMandateId) {
      const mandateId = gate.npc.currentMandateId;
      const rootPath = `sim_mandates/${mandateId}`;
      const rootDoc = snapshotDoc(ctx.snapshot, rootPath);
      if (!rootDoc) {
        return rejectedPlan(descriptorId, "MANDATE_NOT_FOUND", [descriptorId], `No mandate root stands at ${rootPath}.`);
      }
      const root = asRoot(rootDoc);
      const currentPath = `${rootPath}/versions/${root.currentVersion}`;
      const currentDoc = snapshotDoc(ctx.snapshot, currentPath);
      if (!currentDoc) {
        return rejectedPlan(descriptorId, "MANDATE_VERSION_NOT_FOUND", [descriptorId], `The current version doc ${currentPath} does not stand.`);
      }
      const current = asVersion(currentDoc);
      const summarySeq = summarySeqFor(ctx);
      const rolled = buildMandateVersion(
        {
          version: root.currentVersion + 1,
          npcId: gate.npc.npcId,
          cityId: gate.npc.cityId,
          ownerUid: gate.npc.ownerUid,
          permissionMode: mode,
          scopeFreeform: current.scopeFreeform,
          structuredScope: current.structuredScope,
          caps: current.caps,
          negotiationBounds: current.negotiationBounds,
          alwaysEscalate: current.alwaysEscalate,
          responseStyle: current.responseStyle,
          expiresAtSeq: current.expiresAtSeq,
          horizonActions: current.horizonActions,
          sourceActionId: ctx.action.actionId,
        },
        BUILDER_EPOCH
      );
      const versionAfter: SimMandateVersion = { ...rolled, effectiveSeq: summarySeq };
      const plan = emptyPlan(descriptorId);
      const paths = planMandateEffectiveness(plan, ctx, {
        mandateId,
        rootDoc,
        npc: gate.npc,
        versionAfter,
        previousVersionDoc: currentDoc,
        summarySeq,
        rootStatus: root.status === "pending" ? "active" : root.status,
      });
      nullStamps(plan);
      plan.entries.push(
        summaryDraft({
          actor: ctx.action.actor,
          actionId: ctx.action.actionId,
          actionText: ctx.action.actionText,
          cityId: gate.npc.cityId,
          cityIds: [gate.npc.cityId],
          ruleIds: [descriptorId],
          classification: { verb: "npc.setMode", scope: "city", ruleIds: [descriptorId], unruled: false },
          recordsCreated: [paths.versionPath],
          recordsUpdated: [paths.rootPath, paths.npcPath, ...(paths.previousVersionPath ? [paths.previousVersionPath] : [])],
          summaryText: `${gate.npc.displayNameSnapshot}'s permission mode set to ${mode}; mandate ${mandateId} rolled to version ${versionAfter.version} in the same resolution (P5-D3).`,
        })
      );
      actorCitations(plan, ctx.citations, ctx.resolutionId);
      return plan;
    }
    const after = buildNpcSetMode(gate.npc, mode, BUILDER_EPOCH);
    const plan = emptyPlan(descriptorId);
    planWrite(plan, ctx.snapshot, npcPath, { ...after }, "state", ["permissionMode"]);
    nullStamps(plan);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: gate.npc.cityId,
        cityIds: [gate.npc.cityId],
        ruleIds: [descriptorId],
        classification: { verb: "npc.setMode", scope: "city", ruleIds: [descriptorId], unruled: false },
        recordsUpdated: [npcPath],
        summaryText: `${gate.npc.displayNameSnapshot}'s permission mode set to ${mode} (no mandate in force — snapshot only).`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "npc.setMode");
    if (rejection) return rejection;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// mandate.set / mandate.revoke
// ---------------------------------------------------------------------------

function mandateSetHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "mandate.set";
  const notMember = requireMember(ctx, descriptorId);
  if (notMember) return notMember;
  const params = sa(ctx.action);
  const mandateId = str(params.mandateId);
  if (!mandateId) {
    return rejectedPlan(
      descriptorId,
      "MANDATE_ID_REQUIRED",
      [descriptorId],
      "mandate.set requires structuredAction.mandateId — no silent derivation."
    );
  }
  const rootPath = `sim_mandates/${mandateId}`;
  const rootDoc = snapshotDoc(ctx.snapshot, rootPath);
  const summarySeq = summarySeqFor(ctx);

  try {
    if (!rootDoc) {
      // ---- New root --------------------------------------------------
      const npcId = str(params.npcId) ?? "";
      const gate = requireNpcGovernance(ctx, descriptorId, npcId);
      if (!gate.ok) return gate.plan;
      const versionNumber = num(params.version) ?? 1;
      const input = mandateVersionInputFromAction(ctx, gate.npc, mandateId, versionNumber);
      const tierB = tierBAuthoringRejection(
        descriptorId,
        input.structuredScope?.allowedActionTypes ?? []
      );
      if (tierB) return tierB;
      const version = buildMandateVersion(input, BUILDER_EPOCH);
      const root = buildMandateRoot(mandateId, version, BUILDER_EPOCH);
      const versionAfter: SimMandateVersion = { ...version, effectiveSeq: summarySeq };
      const rootAfter: Record<string, unknown> = {
        ...root,
        status: "active",
        createdSeq: summarySeq,
        expiresAtSeq: version.expiresAtSeq,
      };
      const plan = emptyPlan(descriptorId);
      const paths = planMandateEffectiveness(plan, ctx, {
        mandateId,
        rootDoc: rootAfter,
        npc: gate.npc,
        versionAfter,
        previousVersionDoc: null,
        summarySeq,
        rootStatus: "active",
      });
      // planMandateEffectiveness wrote the root as an update against a
      // null snapshot doc — planWrite derives create from the snapshot,
      // so the op is already correct; createdSeq rides as a field.
      const rootWrite = plan.writes.find((w) => w.path === rootPath);
      if (rootWrite?.afterDoc) {
        rootWrite.afterDoc.createdSeq = summarySeq;
        rootWrite.changedFields = [...new Set([...rootWrite.changedFields, "createdSeq"])];
      }
      nullStamps(plan);
      plan.entries.push(
        summaryDraft({
          actor: ctx.action.actor,
          actionId: ctx.action.actionId,
          actionText: ctx.action.actionText,
          cityId: gate.npc.cityId,
          cityIds: [gate.npc.cityId],
          ruleIds: [descriptorId],
          classification: { verb: "mandate.set", scope: "city", ruleIds: [descriptorId], unruled: false },
          recordsCreated: [paths.rootPath, paths.versionPath],
          recordsUpdated: [paths.npcPath],
          summaryText: `Mandate ${mandateId} created for ${gate.npc.displayNameSnapshot} and effective at version ${version.version} in this resolution.`,
        })
      );
      actorCitations(plan, ctx.citations, ctx.resolutionId);
      return plan;
    }

    // ---- Existing root ------------------------------------------------
    const root = asRoot(rootDoc);
    if (root.status === "revoked") {
      return rejectedPlan(
        descriptorId,
        "MANDATE_REVOKED",
        [descriptorId],
        `Mandate ${mandateId} is revoked; a revoked root takes no new versions — author a new mandate.`
      );
    }
    const gate = requireNpcGovernance(ctx, descriptorId, root.npcId);
    if (!gate.ok) return gate.plan;
    const versionNumber = root.currentVersion + 1;
    if (num(params.version) !== null && num(params.version) !== versionNumber) {
      return rejectedPlan(
        descriptorId,
        "VERSION_CONFLICT",
        [descriptorId],
        `mandate.set payload names version ${String(params.version)} but the root's next version is ${versionNumber}.`
      );
    }
    const currentPath = `${rootPath}/versions/${root.currentVersion}`;
    const currentDoc = snapshotDoc(ctx.snapshot, currentPath);
    const citedPath = `${rootPath}/versions/${versionNumber}`;
    const citedDoc = snapshotDoc(ctx.snapshot, citedPath);

    // Client-authored posture: a pending version doc already in the
    // snapshot (authored under the §9.3 rules fence) is validated and
    // flipped effective instead of rebuilt.
    if (citedDoc && citedDoc.effectiveSeq === null) {
      let hashOk = false;
      try {
        hashOk = mandateHash(asVersion(citedDoc)) === citedDoc.mandateHash;
      } catch {
        hashOk = false;
      }
      if (!hashOk) {
        return rejectedPlan(descriptorId, "MANDATE_HASH_MISMATCH", [descriptorId], `The pending version at ${citedPath} fails its mandateHash check — it is not flipped effective.`);
      }
      if (citedDoc.npcId !== root.npcId || citedDoc.ownerUid !== root.ownerUid) {
        return rejectedPlan(descriptorId, "VERSION_CONFLICT", [descriptorId], `The pending version at ${citedPath} does not belong to this mandate root.`);
      }
      const tierB = tierBAuthoringRejection(
        descriptorId,
        ((citedDoc.structuredScope as Record<string, unknown> | undefined)?.allowedActionTypes as string[] | undefined) ?? []
      );
      if (tierB) return tierB;
      const versionAfter: SimMandateVersion = {
        ...asVersion(citedDoc),
        effectiveSeq: summarySeq,
      };
      const plan = emptyPlan(descriptorId);
      const paths = planMandateEffectiveness(plan, ctx, {
        mandateId,
        rootDoc,
        npc: gate.npc,
        versionAfter,
        previousVersionDoc: currentDoc,
        summarySeq,
        rootStatus: root.status === "pending" ? "active" : root.status,
      });
      nullStamps(plan);
      plan.entries.push(
        summaryDraft({
          actor: ctx.action.actor,
          actionId: ctx.action.actionId,
          actionText: ctx.action.actionText,
          cityId: gate.npc.cityId,
          cityIds: [gate.npc.cityId],
          ruleIds: [descriptorId],
          classification: { verb: "mandate.set", scope: "city", ruleIds: [descriptorId], unruled: false },
          recordsCreated: [],
          recordsUpdated: [paths.rootPath, paths.versionPath, paths.npcPath, ...(paths.previousVersionPath ? [paths.previousVersionPath] : [])],
          summaryText: `Mandate ${mandateId}: the owner-authored pending version ${versionNumber} was validated (hash + fields) and flipped effective in this resolution.`,
        })
      );
      actorCitations(plan, ctx.citations, ctx.resolutionId);
      return plan;
    }

    const input = mandateVersionInputFromAction(ctx, gate.npc, mandateId, versionNumber);
    const tierB = tierBAuthoringRejection(
      descriptorId,
      input.structuredScope?.allowedActionTypes ?? []
    );
    if (tierB) return tierB;
    const version = buildMandateVersion(input, BUILDER_EPOCH);
    const versionAfter: SimMandateVersion = { ...version, effectiveSeq: summarySeq };
    const plan = emptyPlan(descriptorId);
    const paths = planMandateEffectiveness(plan, ctx, {
      mandateId,
      rootDoc,
      npc: gate.npc,
      versionAfter,
      previousVersionDoc: currentDoc,
      summarySeq,
      rootStatus: root.status === "pending" ? "active" : root.status,
    });
    nullStamps(plan);
    plan.entries.push(
      summaryDraft({
        actor: ctx.action.actor,
        actionId: ctx.action.actionId,
        actionText: ctx.action.actionText,
        cityId: gate.npc.cityId,
        cityIds: [gate.npc.cityId],
        ruleIds: [descriptorId],
        classification: { verb: "mandate.set", scope: "city", ruleIds: [descriptorId], unruled: false },
        recordsCreated: [paths.versionPath],
        recordsUpdated: [paths.rootPath, paths.npcPath, ...(paths.previousVersionPath ? [paths.previousVersionPath] : [])],
        summaryText: `Mandate ${mandateId} rolled to version ${versionNumber} for ${gate.npc.displayNameSnapshot}, effective in this resolution; version ${root.currentVersion} is superseded.`,
      })
    );
    actorCitations(plan, ctx.citations, ctx.resolutionId);
    return plan;
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "mandate.set");
    if (rejection) return rejection;
    throw error;
  }
}

function mandateRevokeHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "mandate.set";
  const notMember = requireMember(ctx, descriptorId);
  if (notMember) return notMember;
  const params = sa(ctx.action);
  const mandateId = str(params.mandateId);
  if (!mandateId) {
    return rejectedPlan(descriptorId, "MANDATE_ID_REQUIRED", [descriptorId], "mandate.revoke requires structuredAction.mandateId.");
  }
  const rootPath = `sim_mandates/${mandateId}`;
  const rootDoc = snapshotDoc(ctx.snapshot, rootPath);
  if (!rootDoc) {
    return rejectedPlan(descriptorId, "MANDATE_NOT_FOUND", [descriptorId], `No mandate root stands at ${rootPath}.`);
  }
  const root = asRoot(rootDoc);
  const gate = requireNpcGovernance(ctx, descriptorId, root.npcId);
  if (!gate.ok) return gate.plan;
  if (root.status === "revoked") {
    return rejectedPlan(descriptorId, "MANDATE_ALREADY_REVOKED", [descriptorId], `Mandate ${mandateId} is already revoked.`);
  }
  const summarySeq = summarySeqFor(ctx);
  const plan = emptyPlan(descriptorId);
  planWrite(
    plan,
    ctx.snapshot,
    rootPath,
    { ...rootDoc, status: "revoked", revokedSeq: summarySeq },
    "state",
    ["status", "revokedSeq"]
  );
  // The NPC snapshot clears its mandate pointer; the mode VALUE is
  // left as-is (it is the owner's posture, not the mandate's). The
  // current version doc is NOT written — revocation rides the root's
  // revokedSeq in both regimes.
  const npcPath = `sim_npcs/${root.npcId}`;
  planWrite(
    plan,
    ctx.snapshot,
    npcPath,
    { ...gate.npcDoc, currentMandateId: null, currentMandateVersion: null },
    "state",
    ["currentMandateId", "currentMandateVersion"]
  );
  nullStamps(plan);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      cityId: root.cityId,
      cityIds: [root.cityId],
      ruleIds: [descriptorId],
      classification: { verb: "mandate.revoke", scope: "city", ruleIds: [descriptorId], unruled: false },
      recordsUpdated: [rootPath, npcPath],
      summaryText: `Mandate ${mandateId} revoked at seq ${summarySeq}; queued work citing it fails authority revalidation from here (TC-N09).`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// delegationRule.set — versioned authoring mirroring mandate.set over
// sim_delegation_rules. ruleHash is copied EXACTLY from Vera's
// computeRuleHash (lib/sim/delegation.ts, PR-3): same canonical
// function, same field set {ruleId, ownerUid, cityId, version,
// priority, match, handler, caps, alwaysWait, enabled} via
// sha256HexOfText(canonicalJson(...)). PR-3 assembly confirms handler/
// module hash parity against her harness vectors.
// ---------------------------------------------------------------------------

export function computeDelegationRuleHash(payload: {
  ruleId: string;
  ownerUid: string;
  cityId: string;
  version: number;
  priority: number;
  match: Record<string, unknown>;
  handler: Record<string, unknown>;
  caps: Record<string, unknown>;
  alwaysWait: boolean;
  enabled: boolean;
}): string {
  return sha256HexOfText(
    canonicalJson({
      ruleId: payload.ruleId,
      ownerUid: payload.ownerUid,
      cityId: payload.cityId,
      version: payload.version,
      priority: payload.priority,
      match: payload.match,
      handler: payload.handler,
      caps: payload.caps,
      alwaysWait: payload.alwaysWait,
      enabled: payload.enabled,
    })
  );
}

function delegationRuleSetHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "delegationRule.set";
  const notMember = requireMember(ctx, descriptorId);
  if (notMember) return notMember;
  const actor = ctx.action.actor;
  const params = sa(ctx.action);
  const ruleId = str(params.ruleId);
  if (!ruleId) {
    return rejectedPlan(descriptorId, "RULE_ID_REQUIRED", [descriptorId], "delegationRule.set requires structuredAction.ruleId.");
  }
  const cityId = str(params.cityId) ?? ctx.action.targetCityIds[0] ?? "";
  const match = (params.match ?? {}) as Record<string, unknown>;
  const handler = (params.handler ?? {}) as Record<string, unknown>;
  const caps = (params.caps ?? {}) as Record<string, unknown>;
  const alwaysWait = params.alwaysWait === true;
  const enabled = params.enabled !== false;
  const priority = num(params.priority) ?? 0;

  // Composer-side fences (handler half): the handler's NPC must be the
  // author's own and serve the rule's city; a rule may NOT delegate to
  // another owner's NPC; alwaysWait requires the wait-for-owner mode.
  const handlerNpcId = str(handler.npcId);
  if (handlerNpcId) {
    const npcDoc = snapshotDoc(ctx.snapshot, `sim_npcs/${handlerNpcId}`);
    if (!npcDoc) {
      return rejectedPlan(descriptorId, "NPC_NOT_FOUND", [descriptorId], `delegationRule.set cites handler NPC ${handlerNpcId}, which does not stand.`);
    }
    if (npcDoc.ownerUid !== actor.memberId) {
      return rejectedPlan(descriptorId, "DELEGATION_NPC_NOT_OWNED", [descriptorId], `delegationRule.set may not delegate to another owner's NPC (${handlerNpcId} belongs to ${String(npcDoc.ownerUid)}).`);
    }
    if (npcDoc.cityId !== cityId) {
      return rejectedPlan(descriptorId, "DELEGATION_NPC_CITY_MISMATCH", [descriptorId], `Handler NPC ${handlerNpcId} serves ${String(npcDoc.cityId)}, not the rule's city ${cityId}.`);
    }
  }
  if (alwaysWait && handler.mode !== "wait-for-owner") {
    return rejectedPlan(descriptorId, "ALWAYS_WAIT_REQUIRES_WAIT_MODE", [descriptorId], "an alwaysWait rule's handler mode must be \"wait-for-owner\" (the §9.7 fence).");
  }
  // NOTE (seam, recorded): shared-city situations may not be routed
  // across office authority, and the Tier B kind guardrail belongs to
  // the shared composer validator (Vera's validateDelegationRuleDraft,
  // PR-3) — this handler enforces only the resolver-side fences above
  // and does NOT re-implement the composer guardrail.

  const rootPath = `sim_delegation_rules/${ruleId}`;
  const rootDoc = snapshotDoc(ctx.snapshot, rootPath);
  const version = rootDoc ? (num(rootDoc.version) ?? 0) + 1 : 1;
  if (num(params.version) !== null && num(params.version) !== version) {
    return rejectedPlan(descriptorId, "VERSION_CONFLICT", [descriptorId], `delegationRule.set payload names version ${String(params.version)} but the next version is ${version}.`);
  }
  if (rootDoc && rootDoc.ownerUid !== actor.memberId) {
    return rejectedPlan(descriptorId, "AUTHORITY_REVOKED", [descriptorId], `Delegation rule ${ruleId} belongs to ${String(rootDoc.ownerUid)}.`);
  }
  const summarySeq = summarySeqFor(ctx);
  const ruleHash = computeDelegationRuleHash({
    ruleId,
    ownerUid: actor.memberId as string,
    cityId,
    version,
    priority,
    match,
    handler,
    caps,
    alwaysWait,
    enabled,
  });
  const versionDoc: Record<string, unknown> = {
    ruleId,
    version,
    ownerUid: actor.memberId,
    cityId,
    priority,
    match,
    handler,
    caps,
    alwaysWait,
    enabled,
    ruleHash,
    createdAt: null,
  };
  const rootAfter: Record<string, unknown> = {
    ruleId,
    ownerUid: actor.memberId,
    cityId,
    version,
    enabled,
    priority,
    match,
    handler,
    caps,
    alwaysWait,
    ruleHash,
    effectiveSeq: summarySeq,
    // disable = a new version with enabled=false ⇒ root status disabled.
    status: enabled ? "active" : "disabled",
    createdAt: rootDoc?.createdAt ?? null,
    updatedAt: null,
  };
  const plan = emptyPlan(descriptorId);
  const versionPath = `${rootPath}/versions/${version}`;
  planWrite(plan, ctx.snapshot, versionPath, versionDoc, "state", ["ruleHash", "enabled"]);
  planWrite(plan, ctx.snapshot, rootPath, rootAfter, "state", [
    "version",
    "enabled",
    "status",
    "ruleHash",
    "effectiveSeq",
  ]);
  nullStamps(plan);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      cityId,
      cityIds: cityId ? [cityId] : [],
      ruleIds: [descriptorId],
      classification: { verb: "delegationRule.set", scope: "city", ruleIds: [descriptorId], unruled: false },
      recordsCreated: rootDoc ? [versionPath] : [rootPath, versionPath],
      recordsUpdated: rootDoc ? [rootPath] : [],
      summaryText: enabled
        ? `Delegation rule ${ruleId} version ${version} authored and effective in this resolution.`
        : `Delegation rule ${ruleId} disabled by version ${version} (enabled=false ⇒ root status "disabled").`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// envelope.spawn / envelope.cancel
// ---------------------------------------------------------------------------

export interface PlanEnvelopeSpawnOptions {
  source: EnvelopeSpawnSource;
  /** The requesting member — never a payload field. For owner-direct
   * spawns this is the acting member; PR-4's rule-spawned completion
   * passes the rule owner's id (the fire's requester = owner). */
  requestingMemberId: string;
  npcId: string;
  clientRequestId: string;
  /** The mandate version (authority dialect) a rule spawn claims as
   * its context, for the issuer-subset fence; null for owner-direct. */
  mandateVersion: MandateVersionRecord | null;
  availableAt?: string;
}

/**
 * The spawn core, exported for PR-4's rule-spawned completion (Vera
 * §3: a fire kind `envelope` carries the spawn input minus the
 * spawn-action fields — this core completes it). Completion
 * convention: clientRequestId ← the completing action's id;
 * requester = the owner; the "rule-spawned" source (the module's
 * `delegation-rule` literal) skips the owner-authoring branch in
 * validateEnvelopeSpawn and instead faces the issuer-subset fence.
 */
export function planEnvelopeSpawn(
  ctx: HandlerContext,
  opts: PlanEnvelopeSpawnOptions
): ResolutionPlan {
  const descriptorId = "envelope.spawn";
  const params = sa(ctx.action);
  const npcDoc = snapshotDoc(ctx.snapshot, `sim_npcs/${opts.npcId}`);
  if (!npcDoc) {
    return rejectedPlan(descriptorId, "NPC_NOT_FOUND", [descriptorId], `envelope.spawn cites NPC ${opts.npcId}, which does not stand.`);
  }
  if (npcDoc.status !== "active") {
    return rejectedPlan(descriptorId, "NPC_NOT_ACTIVE", [descriptorId], `NPC ${opts.npcId} is ${String(npcDoc.status)} — only an active NPC can be tasked.`);
  }
  const taskId = envelopeTaskId(opts.requestingMemberId, opts.clientRequestId);
  const envPath = `sim_task_envelopes/${taskId}`;
  if (snapshotDoc(ctx.snapshot, envPath)) {
    return rejectedPlan(descriptorId, "ENVELOPE_ALREADY_EXISTS", [descriptorId], `An envelope already stands at ${envPath} (deterministic id from requester + clientRequestId).`);
  }
  const summarySeq = summarySeqFor(ctx);
  let env: TaskEnvelopeRecord;
  try {
    env = buildTaskEnvelope({
      requestingMemberId: opts.requestingMemberId,
      npcId: opts.npcId,
      cityId: str(npcDoc.cityId) ?? "",
      threadRef: (params.threadRef as { kind: string; id: string } | null) ?? ctx.action.threadRef ?? null,
      taskType: params.taskType as never,
      task: params.task as string,
      structuredIntent: (params.structuredIntent as Record<string, unknown> | null) ?? null,
      bounds: (params.bounds as never) ?? {},
      spawnActionId: ctx.action.actionId,
      clientRequestId: opts.clientRequestId,
      availableAt: opts.availableAt ?? str(params.availableAt) ?? ctx.snapshot.now,
      nowIso: ctx.snapshot.now,
      createdSeq: summarySeq,
    });
  } catch (error) {
    const rejection = moduleRejection(descriptorId, error, "envelope.spawn");
    if (rejection) return rejection;
    throw error;
  }
  const npcRecord: NpcRecord = {
    npcId: str(npcDoc.npcId) ?? opts.npcId,
    characterId: str(npcDoc.characterId) ?? "",
    cityId: str(npcDoc.cityId) ?? "",
    ownerUid: str(npcDoc.ownerUid) ?? "",
    permissionMode: isPermissionMode(npcDoc.permissionMode) ? npcDoc.permissionMode : "ask-first",
    status: "active",
    currentMandateId: str(npcDoc.currentMandateId),
    currentMandateVersion: num(npcDoc.currentMandateVersion),
    activationSeq: num(npcDoc.activationSeq) ?? 0,
    retiredSeq: num(npcDoc.retiredSeq),
  };
  const world = snapshotDoc(ctx.snapshot, "sim_world/current");
  const sharedCityId = str(world?.sharedCityId);
  const cities = new Map<string, ReturnType<typeof cityContextFromDocs>>();
  const cityIds = new Set<string>([npcRecord.cityId, ...env.bounds.counterpartyCityIds]);
  for (const cityId of cityIds) {
    cities.set(
      cityId,
      cityContextFromDocs(cityId, snapshotDoc(ctx.snapshot, `factions/${cityId}`), sharedCityId, null)
    );
  }
  const violations = validateEnvelopeSpawn(npcRecord, env, {
    source: opts.source,
    mandateVersion: opts.mandateVersion,
    cities,
  });
  if (violations.length > 0) {
    return rejectedPlan(descriptorId, "ENVELOPE_SPAWN_REFUSED", [descriptorId], `envelope.spawn refused: ${violations.join("; ")}`);
  }
  const plan = emptyPlan(descriptorId);
  planWrite(plan, ctx.snapshot, envPath, { ...env, createdAt: null, updatedAt: null }, "state", [
    "status",
    "task",
  ]);
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      cityId: npcRecord.cityId,
      cityIds: [npcRecord.cityId],
      ruleIds: [descriptorId],
      classification: { verb: "envelope.spawn", scope: "city", ruleIds: [descriptorId], unruled: false },
      recordsCreated: [envPath],
      summaryText: `Task envelope ${taskId} spawned for ${npcRecord.npcId} (source ${opts.source}); output will be advisory — an envelope can never commit.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

function envelopeSpawnHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "envelope.spawn";
  const notMember = requireMember(ctx, descriptorId);
  if (notMember) return notMember;
  const params = sa(ctx.action);
  const npcId = str(params.npcId) ?? "";
  return planEnvelopeSpawn(ctx, {
    source: "owner-direct",
    requestingMemberId: ctx.action.actor.memberId as string,
    npcId,
    clientRequestId: str(params.clientRequestId) ?? ctx.action.actionId,
    mandateVersion: null,
  });
}

function envelopeCancelHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "envelope.spawn";
  const notMember = requireMember(ctx, descriptorId);
  if (notMember) return notMember;
  const actor = ctx.action.actor;
  const params = sa(ctx.action);
  const taskId =
    str(params.taskId) ??
    (str(params.clientRequestId)
      ? envelopeTaskId(actor.memberId as string, str(params.clientRequestId) as string)
      : null);
  if (!taskId) {
    return rejectedPlan(descriptorId, "ENVELOPE_ID_REQUIRED", [descriptorId], "envelope.cancel requires structuredAction.taskId (or clientRequestId to derive it).");
  }
  const envPath = `sim_task_envelopes/${taskId}`;
  const envDoc = snapshotDoc(ctx.snapshot, envPath);
  if (!envDoc) {
    return rejectedPlan(descriptorId, "ENVELOPE_NOT_FOUND", [descriptorId], `No envelope stands at ${envPath}.`);
  }
  if (envDoc.requestingMemberId !== actor.memberId) {
    return rejectedPlan(descriptorId, "AUTHORITY_REVOKED", [descriptorId], "envelope.cancel is requester-only.");
  }
  const status = str(envDoc.status);
  if (status === "RUNNING") {
    return rejectedPlan(descriptorId, "ENVELOPE_ALREADY_CLAIMED", [descriptorId], `Envelope ${taskId} is RUNNING — a claimed envelope cannot be cancelled.`);
  }
  if (status !== "QUEUED") {
    return rejectedPlan(descriptorId, "ENVELOPE_TERMINAL", [descriptorId], `Envelope ${taskId} is already terminal (${String(status)}).`);
  }
  // QUEUED (unclaimed) only: FAILED + cancelled_before_claim, with
  // completionOutcome/outputId left null — the brief's one terminal
  // truth (the UI renders "cancelled" from the code). FLAGGED TENSION
  // (F-E): validateEnvelopeRecord's terminal invariants assume
  // completion; PR-4's claim pass must treat FAILED +
  // cancelled_before_claim as terminal-without-output.
  const plan = emptyPlan(descriptorId);
  planWrite(
    plan,
    ctx.snapshot,
    envPath,
    {
      ...envDoc,
      status: "FAILED",
      lastError: { code: "cancelled_before_claim", message: "cancelled by the requester before claim" },
      updatedAt: null,
    },
    "state",
    ["status", "lastError"]
  );
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      cityId: str(envDoc.cityId),
      cityIds: str(envDoc.cityId) ? [str(envDoc.cityId) as string] : [],
      ruleIds: [descriptorId],
      classification: { verb: "envelope.cancel", scope: "city", ruleIds: [descriptorId], unruled: false },
      recordsUpdated: [envPath],
      summaryText: `Envelope ${taskId} cancelled before claim: status FAILED with code cancelled_before_claim; no output will ever exist for it.`,
    })
  );
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// The governance descriptors (registered in registry.ts by the Lead).
// ---------------------------------------------------------------------------

const SITUATIONS = { step: "phase-5-situations", label: "Situations + delegation (PR-3)" };

export const GOVERNANCE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "npc.create": {
    id: "npc.create",
    actionKinds: ["npc.create", "npc.edit", "npc.retire", "npc.setMode"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "npc.create": npcCreateHandler,
      "npc.edit": npcEditHandler,
      "npc.retire": npcRetireHandler,
      "npc.setMode": npcSetModeHandler,
    },
    readPlan: npcReadPlan,
    summary:
      "Owner governance of NPC records (brief §3.3): npc.create composes creation + activation into one resolution writing the ACTIVE record plus the derived team roster (PR-2, Cato flag 5 as same-resolution composition); a stored pending_activation record owned by the actor is activated instead. npc.edit edits definition fields only; npc.retire retires (pending_activation included) and re-derives the roster; npc.setMode rolls the mandate version when one is in force (P5-D3), else moves the snapshot.",
  },
  "mandate.set": {
    id: "mandate.set",
    actionKinds: ["mandate.set", "mandate.revoke"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "mandate.set": mandateSetHandler,
      "mandate.revoke": mandateRevokeHandler,
    },
    readPlan: mandateReadPlan,
    summary:
      "Mandate authoring (brief §2.3/§3.3): per-NPC mandate roots + immutable versions, mandateHash over the canonical authority payload (lib/npcs). mandate.set requires an explicit mandateId, stamps effectiveness in-resolution (root active + version effectiveSeq + NPC snapshot), flips validated client-authored pending versions instead of rebuilding them, and refuses Tier B allowedActionTypes (MANDATE_AUTHORIZES_TIER_B). mandate.revoke rides the root's revokedSeq; the version doc is never written by revocation.",
  },
  "delegationRule.set": {
    id: "delegationRule.set",
    actionKinds: ["delegationRule.set"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "delegationRule.set": delegationRuleSetHandler,
    },
    readPlan: delegationRuleReadPlan,
    summary:
      "Auto-delegation rule authoring (brief §7): versioned rules over sim_delegation_rules — root mirrors the current version's payload + status/effectiveSeq; disable is a new version with enabled=false (root status disabled). ruleHash is Vera's computeRuleHash field set, copied exactly (PR-3 confirms parity). Resolver-side fences: the handler NPC must be the author's own and serve the rule's city; alwaysWait requires wait-for-owner. Evaluation lands with Situations + delegation (PR-3).",
  },
  "situation.handle": {
    id: "situation.handle",
    actionKinds: ["situation.handle", "situation.delegate", "situation.silence"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "situation.handle": deferralHandler("situation.handle", "situation.handle", SITUATIONS),
      "situation.delegate": deferralHandler("situation.handle", "situation.delegate", SITUATIONS),
      "situation.silence": deferralHandler("situation.handle", "situation.silence", SITUATIONS),
    },
    summary:
      "The three owner decisions on a Situation card (brief §6.3): handle it myself, delegate it, or stay silent (the §8 non-response commit). Registered at the substrate with stated deferrals — the handling flow lands with Situations + delegation (PR-3); the §9.6 decision-field fence is live from PR-1.",
  },
  "envelope.spawn": {
    id: "envelope.spawn",
    actionKinds: ["envelope.spawn", "envelope.cancel"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "envelope.spawn": envelopeSpawnHandler,
      "envelope.cancel": envelopeCancelHandler,
    },
    readPlan: envelopeReadPlan,
    summary:
      "Envelope tasking (brief §2.5/§4): an owner spawns a task envelope for their own active NPC (a silent NPC may be tasked — the instruction is the permission, P5-K4); the deterministic id refuses duplicate spawns; outputs are advisory, never binding (mayCommit is false three-deep). envelope.cancel is requester-only and QUEUED-only (FAILED + cancelled_before_claim). The claim/execution lifecycle lands with the wake completion (PR-4) over lib/envelopes.",
  },
};
