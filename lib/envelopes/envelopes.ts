/**
 * Envelope builders, shape validation, tasking evaluation, and the
 * spawn-time fairness fences (brief §2.5/§4.4; prep P5-K4).
 *
 * The fences, stated once:
 *  1. NEVER-BIND: `mayCommit` is false by type, thrown on by the
 *     builder, and rejected by validation — three-deep with the rules
 *     and the committer (which has no envelope confirm path at all).
 *  2. ISSUER SUBSET: an envelope can never authorize what its issuer
 *     couldn't do. A delegation-rule spawn is bounded by the rule's
 *     mandate version — counterparties and negotiation bounds must be
 *     subsets, or the spawn is refused. An owner-direct spawn is the
 *     owner's own instruction: the owner may ASK anything, because the
 *     output is advisory — but it may never be LABELED "within mandate"
 *     without a mandate whose bounds actually cover it (§4.4).
 *  3. SOVEREIGN CANON: an envelope whose declared intent is a state
 *     change against another owner's city is refused at spawn. (Reads
 *     and negotiation in shared threads are not alteration.)
 */

import { negotiationBoundsExcess } from "../authority/negotiation";
import type {
  CityAuthorityContext,
  MandateVersionRecord,
  NpcRecord,
} from "../authority/types";
import { sha256Hex } from "../sim/canonical";
import type {
  EnvelopeSpawnInput,
  EnvelopeSpawnSource,
  EnvelopeStatus,
  TaskEnvelopeRecord,
} from "./types";

export class EnvelopeValidationError extends Error {}

/** Deterministic task id from requester + client request id (§2.5):
 * a retried spawn re-derives the same id and collides harmlessly. */
export function envelopeTaskId(requesterUid: string, clientRequestId: string): string {
  return `env_${sha256Hex({ requesterUid, clientRequestId }).slice(0, 32)}`;
}

const TASK_TYPES: ReadonlySet<string> = new Set([
  "one-off",
  "negotiation",
  "collection",
  "report",
  "errand",
]);

/**
 * Build the QUEUED envelope record. Throws `EnvelopeValidationError`
 * on any fence violation that is knowable at build time — a builder
 * that throws is layer 2 of the never-bind enforcement, and spawn
 * surfaces turn the throw into a rejected spawn (logged), never a
 * half-written record.
 */
export function buildTaskEnvelope(input: EnvelopeSpawnInput): TaskEnvelopeRecord {
  if (input.bounds.mayCommit === true) {
    throw new EnvelopeValidationError(
      "mayCommit: an envelope can never commit — envelope output is advisory until the owner or a binding act confirms it as a new action (invariant 2)"
    );
  }
  if (!TASK_TYPES.has(input.taskType)) {
    throw new EnvelopeValidationError(`unknown taskType "${input.taskType}"`);
  }
  if (input.taskType === "negotiation" && (input.bounds.negotiationBounds ?? null) === null) {
    throw new EnvelopeValidationError(
      "a negotiation envelope requires negotiationBounds (spec §8.4 layer 1: no bounds, no envoy work)"
    );
  }
  if (!input.requesterUid || !input.npcId || !input.cityId) {
    throw new EnvelopeValidationError("envelope requires requesterUid, npcId, and cityId");
  }
  return {
    taskId: envelopeTaskId(input.requesterUid, input.clientRequestId),
    requesterUid: input.requesterUid,
    npcId: input.npcId,
    cityId: input.cityId,
    threadRef: input.threadRef,
    taskType: input.taskType,
    intentText: input.intentText,
    structuredIntent: input.structuredIntent,
    bounds: {
      mayCommit: false,
      counterpartyCityIds: input.bounds.counterpartyCityIds ?? [],
      negotiationBounds: input.bounds.negotiationBounds ?? null,
    },
    status: "QUEUED",
    claim: null,
    attempts: 0,
    outputId: null,
    completionOutcome: null,
    lastError: null,
    availableAt: input.availableAt,
    createdSeq: input.createdSeq,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

/** Shape validation for a stored envelope record (rules-parity checks
 * the phase's simTaskEnvelopes rules will mirror). Empty = valid. */
export function validateEnvelopeRecord(env: TaskEnvelopeRecord): string[] {
  const violations: string[] = [];
  if ((env.bounds.mayCommit as boolean) !== false) {
    violations.push("bounds.mayCommit is not false — never-bind violated at the record layer");
  }
  if (env.taskType === "negotiation" && env.bounds.negotiationBounds === null) {
    violations.push("negotiation envelope without negotiationBounds");
  }
  const terminal =
    env.status === "DONE" || env.status === "NEED-INFO" || env.status === "FAILED";
  if (terminal) {
    if (env.outputId !== env.taskId) {
      violations.push("terminal envelope's outputId is not its taskId (exactly-one-output, §4.3)");
    }
    if (env.completionOutcome !== env.status) {
      violations.push("terminal envelope's completionOutcome does not match its status");
    }
  } else {
    if (env.outputId !== null) violations.push("non-terminal envelope carries an outputId");
    if (env.completionOutcome !== null) {
      violations.push("non-terminal envelope carries a completionOutcome");
    }
  }
  if (env.status === "RUNNING" && env.claim === null) {
    violations.push("RUNNING envelope without a claim (lease fencing, §4.2)");
  }
  if (env.attempts < 0) violations.push("attempts is negative");
  return violations;
}

// ---------------------------------------------------------------------------
// Tasking evaluation — P5-K4 (ADOPTED in Petra's prep): a silent NPC MAY
// be envelope-tasked. The permission for envelope work is the spawn
// itself when the owner gives it directly; mode governs STANDING
// behavior, and a delegation rule is not the owner speaking.
// ---------------------------------------------------------------------------

export interface EnvelopeTaskingVerdict {
  taskable: boolean;
  /** Always true — envelope output is advisory under every mode and
   * every source; this field exists so callers must confront it. */
  advisoryOnly: true;
  reason: string;
}

export function evaluateEnvelopeTasking(
  npc: NpcRecord,
  source: EnvelopeSpawnSource
): EnvelopeTaskingVerdict {
  if (npc.status !== "active") {
    return {
      taskable: false,
      advisoryOnly: true,
      reason: `NPC ${npc.npcId} is ${npc.status} — a retired NPC cannot be tasked (existing QUEUED envelopes fail instead, §4.1)`,
    };
  }
  if (source === "owner-direct") {
    return {
      taskable: true,
      advisoryOnly: true,
      reason:
        npc.permissionMode === "silent"
          ? "silent NPC, owner-tasked directly: the owner's instruction is the permission (P5-K4); mode governs standing behavior, not the owner's own one-off instruction. Output remains advisory"
          : `owner-direct tasking under mode ${npc.permissionMode}: the owner's instruction is the permission; output remains advisory`,
    };
  }
  // delegation-rule spawn:
  if (npc.permissionMode === "silent") {
    return {
      taskable: false,
      advisoryOnly: true,
      reason:
        "a delegation rule is not the owner speaking: silent mode refuses rule-spawned tasking, and the refusal is the logged non-response (§7.3). Only a direct owner instruction tasks a silent NPC (P5-K4)",
    };
  }
  return {
    taskable: true,
    advisoryOnly: true,
    reason: `rule-spawned tasking under mode ${npc.permissionMode}; output remains advisory`,
  };
}

// ---------------------------------------------------------------------------
// Spawn fences.
// ---------------------------------------------------------------------------

/**
 * Everything that must hold for an envelope to exist against this NPC:
 * the requester is the NPC's owner (only the owner tasks their own
 * NPC — another member's instruction to my staff would reach into my
 * sovereign household), the tasking verdict permits it, the issuer-
 * subset fence holds for rule spawns, and the canon fence holds for
 * every spawn. Returns violations (empty = spawnable).
 */
export function validateEnvelopeSpawn(
  npc: NpcRecord,
  env: TaskEnvelopeRecord,
  opts: {
    source: EnvelopeSpawnSource;
    /** The mandate version a rule spawn claims as its context. */
    mandateVersion: MandateVersionRecord | null;
    cities: ReadonlyMap<string, CityAuthorityContext>;
  }
): string[] {
  const violations: string[] = [];
  violations.push(...validateEnvelopeRecord(env));

  if (env.npcId !== npc.npcId) violations.push("envelope's npcId does not match the NPC record");
  if (env.cityId !== npc.cityId) {
    violations.push(`envelope city ${env.cityId} is not the NPC's city ${npc.cityId}`);
  }
  if (env.requesterUid !== npc.ownerUid) {
    violations.push(
      `requester ${env.requesterUid} is not the NPC's owner ${npc.ownerUid} — only the owner tasks their own NPC`
    );
  }

  const tasking = evaluateEnvelopeTasking(npc, opts.source);
  if (!tasking.taskable) violations.push(tasking.reason);

  // Issuer-subset fence (rule spawns): bounds ⊆ the mandate's bounds.
  if (opts.source === "delegation-rule") {
    if (opts.mandateVersion === null) {
      violations.push("a delegation-rule spawn must cite its mandate context — a rule cannot manufacture authority it does not hold");
    } else {
      violations.push(...envelopeExceedsMandate(env, opts.mandateVersion));
    }
  }

  // Sovereign-canon fence (every spawn): a declared state-change intent
  // against a city the owner does not own is refused outright.
  const intent = env.structuredIntent;
  if (intent !== null && intent.effectClass === "state-change") {
    const targets = Array.isArray(intent.targetCityIds)
      ? intent.targetCityIds.filter((x): x is string => typeof x === "string")
      : [];
    for (const targetCityId of targets) {
      if (targetCityId === npc.cityId) continue;
      const target = opts.cities.get(targetCityId);
      if (target === undefined || target.isSharedCity || !target.ownerUids.includes(npc.ownerUid)) {
        violations.push(
          `envelope intent declares a state change against "${targetCityId}", which the issuer does not own — an envelope never reaches another owner's sovereign canon`
        );
      }
    }
  }
  return violations;
}

/**
 * The subset test proper: envelope bounds vs. the cited mandate
 * version's scope. Counterparties must be within the mandate's list
 * (when the mandate restricts them); negotiation bounds must exist on
 * the mandate and dominate the envelope's (negotiation.ts). Empty =
 * within the fence.
 */
export function envelopeExceedsMandate(
  env: TaskEnvelopeRecord,
  version: MandateVersionRecord
): string[] {
  const excess: string[] = [];
  const mandateCounterparties = version.scope.counterpartyCityIds;
  if (mandateCounterparties.length > 0) {
    for (const cityId of env.bounds.counterpartyCityIds) {
      if (!mandateCounterparties.includes(cityId)) {
        excess.push(
          `counterparty city "${cityId}" is outside the cited mandate version's counterpartyCityIds`
        );
      }
    }
  }
  if (env.bounds.negotiationBounds !== null) {
    if (version.scope.negotiationBounds === null) {
      excess.push("envelope carries negotiation bounds but the cited mandate version grants none");
    } else {
      excess.push(
        ...negotiationBoundsExcess(env.bounds.negotiationBounds, version.scope.negotiationBounds)
      );
    }
  }
  return excess;
}

/**
 * §4.4's labeling rule: negotiation output may be displayed as
 * "within mandate" ONLY with a mandate citation whose bounds cover the
 * envelope's. Otherwise the honest label is the owner's own one-off —
 * pursuable by the owner as their own action, never as delegated work.
 */
export function envelopeMandateLabel(
  env: TaskEnvelopeRecord,
  version: MandateVersionRecord | null
): "within-mandate" | "owner-one-off" {
  if (version === null) return "owner-one-off";
  return envelopeExceedsMandate(env, version).length === 0
    ? "within-mandate"
    : "owner-one-off";
}

export type { EnvelopeStatus };
