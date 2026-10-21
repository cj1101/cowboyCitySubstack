/**
 * Envelope vocabulary (brief §2.5/§4). Types only.
 *
 * An envelope is a one-off task handed to an NPC, executed fresh by a
 * worker, producing exactly one structured output. The output is a
 * PROPOSAL artifact, forever: `mayCommit` is typed as the literal
 * `false` here, rejected by the builder at runtime, and has no commit
 * path in the committer — the never-bind guarantee enforced three-deep
 * (invariant 2). An envelope is never a seventh authority root for a
 * resolution; it is permission to WORK, not to act.
 */

import type { NegotiationBounds } from "../authority/types";

export type EnvelopeTaskType = "one-off" | "negotiation" | "collection" | "report" | "errand";

/** QUEUED → RUNNING → DONE | NEED-INFO | FAILED. Terminal is final. */
export type EnvelopeStatus = "QUEUED" | "RUNNING" | "DONE" | "NEED-INFO" | "FAILED";

export const TERMINAL_ENVELOPE_STATUSES: ReadonlySet<EnvelopeStatus> = new Set([
  "DONE",
  "NEED-INFO",
  "FAILED",
]);

export interface EnvelopeBounds {
  /** Literal false. Not a default — a structural fact (§4.4). */
  mayCommit: false;
  counterpartyCityIds: string[];
  /** Required when taskType is "negotiation" (spec §8.4 layer 1). */
  negotiationBounds: NegotiationBounds | null;
}

/** `sim_task_envelopes/{taskId}` (brief §2.5, FINAL shape). */
export interface TaskEnvelopeRecord {
  taskId: string;
  requesterUid: string;
  npcId: string;
  cityId: string;
  threadRef: { kind: string; id: string } | null;
  taskType: EnvelopeTaskType;
  intentText: string;
  structuredIntent: Record<string, unknown> | null;
  bounds: EnvelopeBounds;
  status: EnvelopeStatus;
  claim: {
    cycleId: string;
    leaseId: string;
    claimedAt: unknown;
    leaseExpiresAt: unknown;
  } | null;
  attempts: number;
  /** = taskId when terminal (the output doc's id IS the task id, §4.3). */
  outputId: string | null;
  completionOutcome: EnvelopeStatus | null;
  lastError: { code: string; message: string } | null;
  availableAt: unknown;
  createdSeq: number;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface EnvelopeStructuredOutput {
  summary: string;
  proposedTerms?: unknown;
  questions?: string[];
  findings?: unknown;
  /** Literal false — an output proposing `mayCommit: true` is the
   * never-bind tripwire and fails validation (lifecycle.ts). */
  mayCommit: false;
}

/** `sim_task_outputs/{taskId}` — exactly one per envelope, ever (§4.3). */
export interface TaskOutputRecord {
  outputId: string;
  npcId: string;
  envelopeTaskId: string;
  outcome: EnvelopeStatus;
  outputText: string;
  structuredOutput: EnvelopeStructuredOutput;
  createdSeq: number | null;
}

/** Who caused an envelope to exist. Owner-direct spawns carry the
 * owner's instruction as their permission (P5-K4); rule spawns carry
 * the delegation rule's — and the rule's mandate's — limits. */
export type EnvelopeSpawnSource = "owner-direct" | "delegation-rule";

export interface EnvelopeSpawnInput {
  requesterUid: string;
  npcId: string;
  cityId: string;
  threadRef: { kind: string; id: string } | null;
  taskType: EnvelopeTaskType;
  intentText: string;
  structuredIntent: Record<string, unknown> | null;
  /** Bounds as supplied; `mayCommit` is accepted only as false/absent —
   * the builder throws on true (three-deep, layer 2). */
  bounds: {
    mayCommit?: boolean;
    counterpartyCityIds?: string[];
    negotiationBounds?: NegotiationBounds | null;
  };
  /** The spawn action's ids — the task id derives deterministically
   * from requester + client request id (§2.5), so a retried spawn
   * action re-derives the same envelope instead of duplicating it. */
  spawnActionId: string;
  clientRequestId: string;
  /** Fabric bookkeeping instants (injected; never read from a clock
   * inside this module). `availableAt` expresses owner-set delay —
   * availability is data, not a schedule (§4.1). */
  availableAt: string;
  nowIso: string;
  createdSeq: number;
}
