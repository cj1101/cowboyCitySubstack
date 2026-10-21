/**
 * Phase 5 governance registration — the substrate (Phase 5 train PR-1;
 * assembly plan W1, brief §3.3, decisions P5-K6).
 *
 * What registration means here: the twelve governance action kinds of
 * brief §3.3 resolve through the registry (classification is total — no
 * governance kind falls through to the unruled narrative path), each
 * descriptor carries its published mechanics, and each kind's handler
 * is exactly as live as its landing step:
 *
 * - `npc.create` is LIVE at the substrate: its handler adapts the NPC
 *   core's `planNpcCreate` (lib/npcs, adopted home per plan §2.1) into
 *   the registry contract. The resolution writes the `sim_npcs` record
 *   in `pending_activation` and logs it; the fabric activation flip
 *   rides this same descriptor when the engine-core step (PR-2) wires
 *   the committer effectiveness flips (Cato flag 5, carried to PR
 *   review undecided — p5-npc-core-prep-report.md §3).
 * - The other eleven kinds carry DEFERRAL handlers in the R-29 idiom
 *   (Phase 4, P4-K8): a resolved, logged, narrative-only summary entry
 *   that states the deferral IN THE OPEN and names the landing step —
 *   never a silent no-op, never a fake success. `npc.edit` /
 *   `npc.retire` / `npc.setMode` / `mandate.*` / `delegationRule.set` /
 *   `envelope.*` land with the engine core (PR-2); the `situation.*`
 *   kinds land with Situations + delegation (PR-3).
 *
 * Descriptor ids: a governance descriptor's id is its primary action
 * kind ("npc.create", "mandate.set", …) — the form the ahead-built
 * modules already use (`emptyPlan("npc.create")` in lib/npcs) and the
 * form the Log cites, so a governance entry's ruleIds name the act
 * itself. Ratified at PR review under P5-K6 like every registry name.
 *
 * Handler discipline is the registry's (brief §5.3): pure, clock-free,
 * rejection plans for domain refusals, never a throw. The adapter's
 * three adjustments to the module plan are wiring, not module edits
 * (each is flagged for the module author at PR review):
 *  1. Timestamps: the module stamps `createdAt`/`updatedAt` from its
 *     `now` argument; registry plans are clock-free (a preview and its
 *     commit must hash identically), so the adapter passes a fixed
 *     epoch and nulls both fields on the planned write — the committer
 *     stamps them inside the transaction, as for every landed family.
 *  2. Entry changes: the module's two field changes use a pre-F-02
 *     grammar ("sim_npcs.status") that the landed changes↔writes
 *     reconciliation cannot resolve for a top-level collection (its
 *     targets are the city doc and its subcollections). The adapter
 *     drops them; the creation is claimed by `recordsCreated`, the
 *     fund-handler precedent (R-32's fund doc).
 *  3. Bookkeeping: the adapter completes the summary draft the module
 *     left minimal (actionId/actionText/classification/ruleIds) and
 *     folds the actor's citations into readRefKeys, as every
 *     registry-native handler does.
 */

import {
  emptyPlan,
  snapshotDoc,
  type ResolutionPlan,
  type SimAction,
  type SimCitations,
} from "../state";
import { rejectedPlan, summaryDraft } from "./planHelpers";
import {
  requireAuthority,
  type DescriptorReadPlan,
  type HandlerContext,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";
import {
  NpcCoreError,
  planNpcCreate,
  type NpcCreateInput,
  type PermissionMode,
} from "../../npcs";

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function actorCitations(plan: ResolutionPlan, citations: SimCitations, resolutionId: string): void {
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

// ---------------------------------------------------------------------------
// Deferral handlers (R-29 idiom): the kind is registered, the deferral
// is stated in the Log itself, and the landing step is named.
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
// npc.create — the one live substrate handler (adapter over lib/npcs).
// ---------------------------------------------------------------------------

/** The fixed instant handed to the module builder; its value never
 * reaches a stored doc (adjustment 1 in the header). */
const BUILDER_EPOCH = new Date(0);

function npcCreateReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = sa(seeds.action);
  const characterId = str(params.characterId);
  const mintedCharacterId = str(params.mintedCharacterId);
  const npcId = characterId ?? mintedCharacterId;
  const paths: string[] = [];
  if (npcId) paths.push(`sim_npcs/${npcId}`);
  // An existing-character link is read so the handler can refuse a
  // dangling one (the resolver-side mirror of rules §9.1's fence). A
  // minted ID has no doc yet by definition and is not read.
  if (characterId) paths.push(`characters/${characterId}`);
  return { paths };
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
  let plan: ResolutionPlan;
  try {
    plan = planNpcCreate(ctx.snapshot, input, BUILDER_EPOCH);
  } catch (error) {
    if (error instanceof NpcCoreError) {
      return rejectedPlan(
        descriptorId,
        error.code,
        [descriptorId],
        `npc.create refused: ${error.message}`
      );
    }
    throw error;
  }
  const npcId = characterId ?? input.mintedCharacterId ?? "";
  if (snapshotDoc(ctx.snapshot, `sim_npcs/${npcId}`)) {
    return rejectedPlan(
      descriptorId,
      "NPC_ALREADY_EXISTS",
      [descriptorId],
      `An NPC record already stands at sim_npcs/${npcId}; creation does not overwrite it.`
    );
  }
  // Adjustment 1 — clock-free plans: the committer stamps both fields.
  for (const write of plan.writes) {
    if (write.afterDoc && "createdAt" in write.afterDoc) write.afterDoc.createdAt = null;
    if (write.afterDoc && "updatedAt" in write.afterDoc) write.afterDoc.updatedAt = null;
  }
  // Adjustments 2 + 3 — entry bookkeeping (see header).
  const summary = plan.entries[plan.entries.length - 1];
  summary.actionId = ctx.action.actionId;
  summary.actionText = ctx.action.actionText;
  summary.ruleIds = [descriptorId];
  summary.classification = {
    verb: "npc.create",
    scope: "city",
    ruleIds: [descriptorId],
    unruled: false,
  };
  summary.changes = [];
  actorCitations(plan, ctx.citations, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// The governance descriptors (registered in registry.ts by the Lead).
// ---------------------------------------------------------------------------

const ENGINE_CORE = { step: "phase-5-engine-core", label: "the Phase 5 engine core (PR-2)" };
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
      "npc.edit": deferralHandler("npc.create", "npc.edit", ENGINE_CORE),
      "npc.retire": deferralHandler("npc.create", "npc.retire", ENGINE_CORE),
      "npc.setMode": deferralHandler("npc.create", "npc.setMode", ENGINE_CORE),
    },
    readPlan: npcCreateReadPlan,
    summary:
      "Owner governance of NPC records (brief §3.3): npc.create writes the sim_npcs record in pending_activation through the NPC core's plan builder (default mode ask-first, P5-K3 — the default lives in the builder, nowhere else) and the fabric activation flip rides this descriptor with the engine core (PR-2); npc.edit / npc.retire / npc.setMode are registered with stated deferrals to PR-2.",
  },
  "mandate.set": {
    id: "mandate.set",
    actionKinds: ["mandate.set", "mandate.revoke"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "mandate.set": deferralHandler("mandate.set", "mandate.set", ENGINE_CORE),
      "mandate.revoke": deferralHandler("mandate.set", "mandate.revoke", ENGINE_CORE),
    },
    summary:
      "Mandate authoring (brief §2.3/§3.3): per-NPC mandate roots + immutable versions, mandateHash over the canonical authority payload (lib/npcs). Registered at the substrate with stated deferrals — the effectiveness flips (pointer, version, mode snapshot) land with the engine core (PR-2); owners author pending roots/versions under the rules §9.3 fences from this PR.",
  },
  "delegationRule.set": {
    id: "delegationRule.set",
    actionKinds: ["delegationRule.set"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "delegationRule.set": deferralHandler("delegationRule.set", "delegationRule.set", ENGINE_CORE),
    },
    summary:
      "Auto-delegation rule authoring (brief §7): versioned rules over sim_delegation_rules, evaluated in Dana's five-step order by the delegation pass. Registered at the substrate with a stated deferral — activation and evaluation land with the engine core and Situations (PR-2/PR-3); the §9.7 authoring fences are live from this PR.",
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
      "The three owner decisions on a Situation card (brief §6.3): handle it myself, delegate it, or stay silent (the §8 non-response commit). Registered at the substrate with stated deferrals — the handling flow lands with Situations + delegation (PR-3); the §9.6 decision-field fence is live from this PR.",
  },
  "envelope.spawn": {
    id: "envelope.spawn",
    actionKinds: ["envelope.spawn", "envelope.cancel"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: {
      "envelope.spawn": deferralHandler("envelope.spawn", "envelope.spawn", ENGINE_CORE),
      "envelope.cancel": deferralHandler("envelope.spawn", "envelope.cancel", ENGINE_CORE),
    },
    summary:
      "Envelope tasking (brief §2.5/§4): an owner spawns a task envelope for an NPC (a silent NPC may be tasked — the instruction is the permission, P5-K4); outputs are advisory, never binding (mayCommit is false three-deep). Registered at the substrate with stated deferrals — the claim/execution lifecycle lands with the engine core (PR-2) over lib/envelopes; the §9.4 spawn fences are live from this PR.",
  },
};
