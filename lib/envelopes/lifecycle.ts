/**
 * Envelope lifecycle mechanics (brief §4): claim/lease fencing, the
 * three-attempt budget, terminal preconditions, the output record, and
 * execution-time authority revalidation.
 *
 * Everything pure: the wake's envelope pass and the fabric's completion
 * path (assembly) read records, call these functions, and commit the
 * results inside the terminal transaction (§4.3 — output write +
 * envelope terminal patch + Log outcome entry, one transaction, with
 * the preconditions re-checked there; these functions are the same
 * checks, run early, so a doomed claim never starts a worker).
 *
 * Lease instants are fabric bookkeeping (worker fencing), NOT world
 * time: they arrive as injected ISO strings. The world's only clock
 * remains the Log; nothing here derives a world fact from a lease.
 */

import { npcActorEnvelope, npcActorStanding } from "../authority/actor";
import {
  executionTimeRevalidation,
  type RevalidationResult,
} from "../authority/revocation";
import { sha256Hex } from "../sim/canonical";
import { summaryDraft } from "../sim/rules/planHelpers";
import type { LogEntryDraft } from "../sim/state";
import { evaluateEnvelopeTasking } from "./envelopes";
import type {
  EnvelopeSpawnSource,
  EnvelopeStatus,
  TaskEnvelopeRecord,
  TaskOutputRecord,
} from "./types";
import type { AuthorityView, NpcRecord } from "../authority/types";

/** Total worker attempts per envelope before FAILED (brief §4.2). */
export const MAX_ENVELOPE_ATTEMPTS = 3;

/** Lease expiry is the ONLY recovery from a dead worker: no heartbeats,
 * no lease stealing (§4.2). Expiry is computed by the claiming caller
 * and stored on the claim; this helper only reads it. */
export function leaseIsLive(env: TaskEnvelopeRecord, nowIso: string): boolean {
  if (env.claim === null) return false;
  const expires = env.claim.leaseExpiresAt;
  if (typeof expires !== "string") return false;
  return Date.parse(expires) > Date.parse(nowIso);
}

export type ClaimResult =
  | { ok: true; envelope: TaskEnvelopeRecord }
  | { ok: false; reason: string };

/**
 * Claim an envelope for a worker (§4.1/§4.2): status QUEUED, or RUNNING
 * with an expired lease (the previous worker is presumed dead; its
 * fencing token is now stale and its terminal write will be rejected).
 * A live lease refuses — fencing is the whole point. Each successful
 * claim consumes one attempt.
 */
export function claimEnvelope(
  env: TaskEnvelopeRecord,
  opts: { cycleId: string; leaseId: string; nowIso: string; leaseExpiresAt: string }
): ClaimResult {
  if (env.status === "DONE" || env.status === "NEED-INFO" || env.status === "FAILED") {
    return { ok: false, reason: `envelope is terminal (${env.status}) — terminal is final, no deletes, no re-runs` };
  }
  if (env.status === "RUNNING" && leaseIsLive(env, opts.nowIso)) {
    return { ok: false, reason: "a live lease fences this envelope to another worker" };
  }
  if (env.attempts >= MAX_ENVELOPE_ATTEMPTS) {
    return { ok: false, reason: `attempt budget exhausted (${MAX_ENVELOPE_ATTEMPTS})` };
  }
  return {
    ok: true,
    envelope: {
      ...env,
      status: "RUNNING",
      claim: {
        cycleId: opts.cycleId,
        leaseId: opts.leaseId,
        claimedAt: opts.nowIso,
        leaseExpiresAt: opts.leaseExpiresAt,
      },
      attempts: env.attempts + 1,
      updatedAt: opts.nowIso,
    },
  };
}

/** After a worker failure (§4.2): attempts remain → back to QUEUED for
 * a later wake (fresh worker; worker memory never carries between
 * attempts); budget spent → FAILED, and the caller raises the system
 * Situation that tells the owner their task died. */
export function failureOutcome(env: TaskEnvelopeRecord): {
  nextStatus: "QUEUED" | "FAILED";
  raiseSystemSituation: boolean;
} {
  if (env.attempts >= MAX_ENVELOPE_ATTEMPTS) {
    return { nextStatus: "FAILED", raiseSystemSituation: true };
  }
  return { nextStatus: "QUEUED", raiseSystemSituation: false };
}

/**
 * Terminal preconditions (§4.3) — the committer re-checks every one
 * inside the transaction; run them before starting completion work so
 * a stale worker fails cheaply instead of writing into a void:
 * envelope still RUNNING, the caller's lease is the live fencing
 * token, and NO output exists yet (exactly one output, ever — the
 * output's id is the task id, so this is an existence check, not a
 * query).
 */
export function validateTerminalPreconditions(
  env: TaskEnvelopeRecord,
  opts: { leaseId: string; outputExists: boolean }
): string[] {
  const violations: string[] = [];
  if (env.status !== "RUNNING") {
    violations.push(`envelope is ${env.status}, not RUNNING — no terminal write is possible`);
  }
  if (env.claim === null || env.claim.leaseId !== opts.leaseId) {
    violations.push("stale fencing token: the caller's leaseId is not the envelope's live claim");
  }
  if (opts.outputExists) {
    violations.push("an output already exists for this task — exactly one output, ever (§4.3)");
  }
  return violations;
}

/** The output doc (id = task id). `mayCommit` is forced false here as
 * it is everywhere — the value is not the caller's to choose. */
export function buildTaskOutput(
  env: TaskEnvelopeRecord,
  opts: {
    outcome: EnvelopeStatus;
    outputText: string;
    summary: string;
    proposedTerms?: unknown;
    questions?: string[];
    findings?: unknown;
    createdSeq?: number | null;
    /** The envelope's read audience at completion (§9.5 stored branch);
     * defaults to the requesting member alone when the caller supplies
     * nothing — the narrowest honest audience. */
    audienceUids?: string[];
  }
): TaskOutputRecord {
  return {
    outputId: env.taskId,
    npcId: env.npcId,
    envelopeTaskId: env.taskId,
    outcome: opts.outcome,
    outputText: opts.outputText,
    structuredOutput: {
      summary: opts.summary,
      ...(opts.proposedTerms !== undefined ? { proposedTerms: opts.proposedTerms } : {}),
      ...(opts.questions !== undefined ? { questions: opts.questions } : {}),
      ...(opts.findings !== undefined ? { findings: opts.findings } : {}),
      mayCommit: false,
    },
    createdSeq: opts.createdSeq ?? null,
    audienceUids: opts.audienceUids ?? [env.requestingMemberId],
  };
}

export function validateTaskOutput(output: TaskOutputRecord): string[] {
  const violations: string[] = [];
  if (output.outputId !== output.envelopeTaskId) {
    violations.push("outputId is not the envelope's taskId (exactly-one is provable only if the ids coincide)");
  }
  if ((output.structuredOutput.mayCommit as boolean) !== false) {
    violations.push("structuredOutput.mayCommit is not false — never-bind tripwire");
  }
  if (
    output.outcome !== "DONE" &&
    output.outcome !== "NEED-INFO" &&
    output.outcome !== "FAILED"
  ) {
    violations.push(`output outcome "${output.outcome}" is not a terminal outcome`);
  }
  return violations;
}

/** The envelope-side patch of the terminal transaction (§4.3 step 3):
 * status + outputId + completionOutcome land together, or the
 * transaction does not land at all. */
export function terminalEnvelopePatch(
  env: TaskEnvelopeRecord,
  opts: { outcome: EnvelopeStatus; nowIso: string; error?: { code: string; message: string } | null }
): Partial<TaskEnvelopeRecord> {
  return {
    status: opts.outcome,
    completionOutcome: opts.outcome,
    outputId: env.taskId,
    claim: null,
    ...(opts.error ? { lastError: opts.error } : {}),
    updatedAt: opts.nowIso,
  };
}

/**
 * §4.2's context binding: the worker's context is a hash of the
 * envelope + the mandate version in force + the input heads it read.
 * Drift between claim and completion means the world moved — the
 * result is stale and the completion path must notice.
 */
export function envelopeContextHash(
  env: TaskEnvelopeRecord,
  mandateVersion: number | null,
  inputHeadHashes: string[]
): string {
  return sha256Hex({
    taskId: env.taskId,
    task: env.task,
    structuredIntent: env.structuredIntent,
    bounds: env.bounds,
    mandateVersion,
    inputHeadHashes,
  });
}

// ---------------------------------------------------------------------------
// Execution-time revalidation (brief §4.2, TC-N09): before a claimed
// envelope runs, authority is re-evaluated against CURRENT records.
// A revocation, a retirement, or an ownership change between queue and
// run terminates the task `authority_changed` — the envelope records it
// (status FAILED, lastError authority_changed, plus the Log entry) and
// the owner is told why. Mode is re-read too, reconciled with P5-K4:
// an owner-direct envelope's permission is the instruction itself, so a
// later flip TO silent does not kill it; a rule-spawned envelope whose
// mode flipped to silent does terminate (the rule's permission is
// gone). Where a mandate context is in the view, its currency is
// checked with the same primitive the action stage uses.
// ---------------------------------------------------------------------------

export function revalidateEnvelopeAtExecution(
  view: AuthorityView,
  env: TaskEnvelopeRecord,
  source: EnvelopeSpawnSource
): RevalidationResult {
  const npc = view.npc;
  if (npc === null || npc.npcId !== env.npcId) {
    return {
      ok: false,
      code: "authority_changed",
      failure: { code: "NPC_NOT_FOUND", reason: "the envelope's NPC record is absent or changed" },
    };
  }
  const actor = npcActorEnvelope(npc, env.taskId);
  const identity = executionTimeRevalidation(view, actor, env.cityId);
  if (!identity.ok) return identity;

  if (view.mandateRoot !== null && view.mandateVersion !== null) {
    const standingActor = npcActorStanding(
      npc,
      view.mandateRoot.mandateId,
      view.mandateRoot.currentVersion
    );
    const mandateCheck = executionTimeRevalidation(view, standingActor, env.cityId);
    if (!mandateCheck.ok) return mandateCheck;
  }

  const tasking = evaluateEnvelopeTasking(npc, source);
  if (!tasking.taskable) {
    return {
      ok: false,
      code: "authority_changed",
      failure: { code: "TASKING_NO_LONGER_PERMITTED", reason: tasking.reason },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The outcome entry (§4.3 step 4): the envelope's completion lands in
// the Log as ONE summary entry under the envelope actor — source
// "envelope", changes ALWAYS [] (the entry documents work product; it
// changes no world state, and the empty changes array is the audit
// surface's proof).
// ---------------------------------------------------------------------------

export function buildEnvelopeOutcomeEntryDraft(
  env: TaskEnvelopeRecord,
  output: TaskOutputRecord,
  npc: NpcRecord
): LogEntryDraft {
  return summaryDraft({
    actor: npcActorEnvelope(npc, env.taskId),
    actionId: null,
    cityId: env.cityId,
    cityIds: [env.cityId],
    changes: [],
    recordsCreated: [`sim_task_outputs/${env.taskId}`],
    classification: {
      source: "envelope",
      envelopeId: env.taskId,
      mandateId: null,
      mandateVersion: null,
      taskType: env.taskType,
      outcome: output.outcome,
      // §3.2 trigger citation (PR #45 CI round 8): the outcome entry's
      // actor is the envelope actor, so the standing verifier's
      // traceability requires the citation — the envelope itself,
      // rooted at its creating event, mirroring entryTriggerOf's
      // envelope fallback in the authority stage. Its absence made
      // every completed envelope's entry an orphan.
      trigger: {
        kind: "envelope",
        sourceId: env.taskId,
        sourceSeq: env.createdSeq ?? null,
        deliberation: null,
      },
    },
    summaryText: output.outputText,
  });
}
