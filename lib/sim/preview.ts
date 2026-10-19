/**
 * Preview (Phase 2 brief §4.2) — resolve the action in `preview` mode
 * against an explicit snapshot and produce the member-facing preview
 * document the confirmation binds to.
 *
 * The previewHash commits to: the action payload, the exact input heads,
 * the resolver's rules version, the citable Baseline version + docHash
 * (or nulls pre-ratification), and the planHash. Confirmation is
 * hash-bound to the stored preview (the §9.4 rules clause), and the
 * committer re-derives everything inside the transaction — a preview is
 * a promise about a snapshot, never an authority.
 *
 * Determinism invariant: preview computation on identical world state +
 * identical action payload yields an identical previewHash, at any
 * injected clock, in any mode. To that end the hashed inputHeads EXCLUDE
 * the source action doc's own head (see computePreviewHash): the action
 * is bound by the actionPayload component, and its doc's lifecycle
 * bookkeeping (status, claim, stored preview, confirmation, updatedAt)
 * is fabric control state — the same exclusion the committer applies to
 * its state-head comparison (controlPaths in commitResolution). The
 * volatile `computedAt` display field is likewise never hashed.
 */

import { sha256Hex } from "./canonical";
import { projectFirestoreValue } from "./log";
import { describeRipenCondition } from "./rules/pendingRules";
import {
  RESOLVER_RULES_VERSION,
  type ResolutionPlan,
  type SimAction,
  type SimSnapshot,
} from "./state";
import {
  citableBaselineVersion,
  type BaselineRegistry,
} from "./baseline/registry";
import { resolveAction, type ResolveOptions } from "./resolver";

export interface PreviewComputation {
  plan: ResolutionPlan;
  preview: Record<string, unknown>;
  previewHash: string;
  audienceUids: string[];
}

export function actionPayloadForHash(action: SimAction): Record<string, unknown> {
  return projectFirestoreValue({
    actionId: action.actionId,
    actor: action.actor,
    actionType: action.actionType,
    actionText: action.actionText,
    structuredAction: action.structuredAction,
    targetCityIds: action.targetCityIds,
  }) as Record<string, unknown>;
}

export function computePreviewHash(input: {
  action: SimAction;
  snapshot: SimSnapshot;
  plan: ResolutionPlan;
  baselineRegistry: BaselineRegistry;
  /** The prepared payload's self-declared hash, when the resolution
   * consumed one (F-07): the preview binds the payload's identity, so
   * a swapped payload at commit time cannot reproduce the confirmed
   * preview hash — parity is structural, not conventional. */
  preparedInputHash?: string | null;
}): string {
  const citable = citableBaselineVersion(
    input.baselineRegistry,
    input.snapshot.counterHead.lastSeq + 1
  );
  // The source action doc is a snapshot input (the resolver reads it),
  // but its head is a full-doc hash over fabric lifecycle bookkeeping —
  // claim, status, the stored preview itself, updatedAt. Hashing it
  // would make every fabric bookkeeping write change the next preview's
  // hash on identical world state (preview computation would not be
  // idempotent, and a dispatcher's refreshed preview could never
  // hash-equal a re-computation). Exclude it, exactly as the committer
  // excludes the action path from its state-head comparison; the action
  // payload component above binds the action's identity and content.
  const actionPath = `sim_actions/${input.action.actionId}`;
  const inputHeads = input.snapshot.heads.filter((h) => h.path !== actionPath);
  return sha256Hex(
    projectFirestoreValue({
      actionPayload: actionPayloadForHash(input.action),
      inputHeads,
      rulesVersion: RESOLVER_RULES_VERSION,
      baselineVersion: citable?.version ?? null,
      baselineDocHash: citable?.docHash ?? null,
      planHash: input.plan.planHash,
      preparedInputHash: input.preparedInputHash ?? null,
    }) as Record<string, unknown>
  );
}

export function computePreview(
  snapshot: SimSnapshot,
  action: SimAction,
  opts: ResolveOptions & { baselineRegistry: BaselineRegistry }
): PreviewComputation {
  const plan = resolveAction(snapshot, action, opts);
  const previewHash = computePreviewHash({
    action,
    snapshot,
    plan,
    baselineRegistry: opts.baselineRegistry,
    preparedInputHash: opts.prepared?.inputHash ?? null,
  });

  const summary = plan.entries[plan.entries.length - 1];
  const targetCities = new Set(action.targetCityIds);
  const deltas: Record<string, unknown>[] = [];
  const spillover: string[] = [];
  for (const entry of plan.entries) {
    for (const change of entry.changes) {
      deltas.push({
        cityId: entry.cityId,
        field: change.field,
        before: change.before,
        after: change.after,
      });
    }
    for (const cityId of entry.cityIds) {
      if (!targetCities.has(cityId) && !spillover.includes(cityId)) spillover.push(cityId);
    }
  }

  // Pending disclosures (brief §7.2): the commitment and its derived
  // condition, at human granularity — derivation numbers included (they
  // are the disclosure), no seed, no odds (CJ §7.7 forecloses both).
  const originSeqIfCommitted = snapshot.counterHead.lastSeq + plan.entries.length;
  const pendingDisclosures = plan.pendingCreates.map((draft) => {
    const doc = draft.doc;
    const condition = doc.ripenCondition as Record<string, unknown>;
    const derivation = doc.delayDerivation as Record<string, unknown>;
    const wouldBe: Record<string, unknown> = {
      ...doc,
      originSeq: originSeqIfCommitted,
      ripenCondition: {
        ...condition,
        requiredSeq: originSeqIfCommitted + (condition.minSeqAdvance as number),
        eligibleAt: new Date(
          Date.parse(snapshot.now) + (condition.minWallElapsedHours as number) * 3_600_000
        ).toISOString(),
      },
    };
    return {
      pendingId: doc.pendingId,
      kind: doc.kind,
      targetCityId: doc.targetCityId,
      generation: doc.generation,
      delayDerivation: derivation,
      conditionSummary: describeRipenCondition(wouldBe),
    };
  });

  const warnings: string[] = [];
  if (plan.outcome === "rejected" && plan.rejection) {
    warnings.push(`This action will be REJECTED if confirmed: ${plan.rejection.code}.`);
  }
  const citable = citableBaselineVersion(opts.baselineRegistry, snapshot.counterHead.lastSeq + 1);
  if (!citable) {
    warnings.push(
      "The World Baseline is not yet ratified: Baseline-dependent judgments cannot resolve (fail-closed)."
    );
  }

  const audience = new Set<string>(action.audienceUids);
  const actorUid = action.actor.memberId ?? action.actor.onBehalfOfMemberId;
  if (actorUid) audience.add(actorUid);
  for (const cityId of action.targetCityIds) {
    const faction = snapshot.docs.get(`factions/${cityId}`);
    const owners = faction?.ownerUids;
    if (Array.isArray(owners)) {
      for (const uid of owners) if (typeof uid === "string") audience.add(uid);
    }
  }

  const preview: Record<string, unknown> = {
    outcome: plan.outcome,
    summaryText: summary?.summaryText ?? "",
    deltas,
    spillover,
    pendingDisclosures,
    uncitedEffects: [],
    recordsAffected: [...new Set(plan.writes.map((w) => w.path))].sort(),
    baselineVersion: citable?.version ?? null,
    baselineDocHash: citable?.docHash ?? null,
    requiredAuthority: plan.outcome === "rejected" ? null : "actor authority at submit time",
    warnings,
    computedAt: snapshot.now,
    planHash: plan.planHash,
    rulesVersion: RESOLVER_RULES_VERSION,
    preparedInputHash: opts.prepared?.inputHash ?? null,
  };

  return { plan, preview, previewHash, audienceUids: [...audience].sort() };
}
