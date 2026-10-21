/**
 * Client reads + decision submissions for the Situations surfaces
 * (Phase 5 brief §11.1). Reads run AS THE REQUESTER under the §9
 * fences: the queue is fetched with the two query shapes the
 * `sim_situations` read rule can prove — addressed to me
 * (`recipientUid == uid`), or addressed to a city I own
 * (`audienceCityId == cityId`, one query per owned city) — and
 * sorted client-side, so no composite index is load-bearing for
 * the §6.2 order. Delegation rules are author-private (§9.7):
 * `ownerUid == uid` only.
 *
 * Every write goes through the play intake (`lib/play/intake.ts`) —
 * the one client write path. A decision here submits a governance
 * action (`situation.handle` / `situation.delegate` /
 * `situation.silence` / `delegationRule.set` / `envelope.spawn`);
 * the fabric previews it and only the owner's hash-bound
 * confirmation puts it in motion, exactly like any other action.
 * No surface writes `sim_*` collections directly.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { newClientRequestId, submitPlayAction } from "@/lib/play/intake";
import type {
  SimSituation,
  SituationHandling,
  SituationSource,
} from "@/lib/sim/situations";
import type { SimDelegationRule } from "@/lib/sim/delegation";
import type { TaskEnvelopeRecord, TaskOutputRecord } from "@/lib/envelopes/types";

const QUEUE_LIMIT = 200;
const RULES_LIMIT = 100;

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function asRecord(value: unknown): DocumentData {
  return value && typeof value === "object" ? (value as DocumentData) : {};
}

/** Coerce a stored `sim_situations` doc into Vera's shape. Absent
 * fields coerce to the module's neutral values — the surface never
 * invents content the record does not carry. */
export function toSituation(data: DocumentData): SimSituation {
  const source = asRecord(data.source);
  const handlingRaw = data.handling as DocumentData | null | undefined;
  const handling: SituationHandling | null =
    handlingRaw && typeof handlingRaw === "object"
      ? {
          mode:
            handlingRaw.mode === "self" ||
            handlingRaw.mode === "delegated" ||
            handlingRaw.mode === "auto-delegated" ||
            handlingRaw.mode === "silent"
              ? handlingRaw.mode
              : null,
          decidedByUid: asNullableString(handlingRaw.decidedByUid),
          delegationRuleId: asNullableString(handlingRaw.delegationRuleId),
          delegationRuleVersion: asNullableNumber(handlingRaw.delegationRuleVersion),
          npcId: asNullableString(handlingRaw.npcId),
          mandateId: asNullableString(handlingRaw.mandateId),
          mandateVersion: asNullableNumber(handlingRaw.mandateVersion),
          taskId: asNullableString(handlingRaw.taskId),
          actionId: asNullableString(handlingRaw.actionId),
          decidedAt: handlingRaw.decidedAt ?? null,
          decisionNote: asNullableString(handlingRaw.decisionNote),
          outcomeVerb: asNullableString(handlingRaw.outcomeVerb),
        }
      : null;
  const sourceKinds = [
    "log",
    "treaty",
    "task",
    "ingestion",
    "contest",
    "manual-action",
    "system",
  ] as const;
  const sourceRef: SituationSource = {
    kind: (sourceKinds as readonly string[]).includes(source.kind as string)
      ? (source.kind as SituationSource["kind"])
      : "log",
    sourceId: asNullableString(source.sourceId),
    sourceSeq: asNullableNumber(source.sourceSeq),
    sourceResolutionId: asNullableString(source.sourceResolutionId),
  };
  const severity =
    data.severity === "important" || data.severity === "major"
      ? data.severity
      : "routine";
  const status =
    data.status === "delegated" ||
    data.status === "awaiting_owner" ||
    data.status === "handled" ||
    data.status === "silent" ||
    data.status === "superseded"
      ? data.status
      : "open";
  return {
    situationId: asString(data.situationId),
    cityId: asNullableString(data.cityId),
    audienceCityId: asNullableString(data.audienceCityId),
    audienceOwnerUidsSnapshot: asStringList(data.audienceOwnerUidsSnapshot),
    recipientUid: asNullableString(data.recipientUid),
    kind: asString(data.kind, "situation"),
    status,
    severity,
    title: asString(data.title),
    summary: asString(data.summary),
    detail:
      data.detail && typeof data.detail === "object"
        ? (data.detail as Record<string, unknown>)
        : null,
    source: sourceRef,
    dedupeKey: asString(data.dedupeKey),
    createdSeq: asNullableNumber(data.createdSeq),
    handling,
    delegationCycleCount: asNumber(data.delegationCycleCount),
    resolvedSeq: asNullableNumber(data.resolvedSeq),
    resolvedByResolutionId: asNullableString(data.resolvedByResolutionId),
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/** Coerce a stored `sim_delegation_rules` root into Vera's shape. */
export function toDelegationRule(data: DocumentData): SimDelegationRule {
  const match = asRecord(data.match);
  const handler = asRecord(data.handler);
  const caps = asRecord(data.caps);
  const mode =
    handler.mode === "act-for-me" ||
    handler.mode === "silent" ||
    handler.mode === "wait-for-owner"
      ? handler.mode
      : "ask-first";
  return {
    ruleId: asString(data.ruleId),
    ownerUid: asString(data.ownerUid),
    cityId: asString(data.cityId),
    version: asNumber(data.version, 1),
    enabled: data.enabled !== false,
    priority: asNumber(data.priority),
    match: {
      situationKinds: asStringList(match.situationKinds),
      sourceKinds: asStringList(match.sourceKinds),
      cityIds: Array.isArray(match.cityIds) ? asStringList(match.cityIds) : null,
      counterpartyCityIds: Array.isArray(match.counterpartyCityIds)
        ? asStringList(match.counterpartyCityIds)
        : null,
      minRubars: asNullableNumber(match.minRubars),
      maxRubars: asNullableNumber(match.maxRubars),
      tags: asStringList(match.tags),
    },
    handler: {
      npcId: asNullableString(handler.npcId),
      mode,
      mandateId: asNullableString(handler.mandateId),
    },
    caps: Object.fromEntries(
      Object.entries(caps).map(([k, v]) => [k, asNullableNumber(v)])
    ),
    alwaysWait: data.alwaysWait === true,
    ruleHash: asString(data.ruleHash),
    effectiveSeq: asNullableNumber(data.effectiveSeq),
    status:
      data.status === "active" ||
      data.status === "disabled" ||
      data.status === "superseded"
        ? data.status
        : "pending",
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/**
 * The viewer's queue: everything addressed to them personally plus
 * everything addressed to a city they own, de-duplicated. Bounded
 * (QUEUE_LIMIT per query shape) and unordered at the Firestore
 * layer — `sortQueue` applies the §6.2 order.
 */
export async function loadQueue(
  uid: string,
  ownedCityIds: readonly string[]
): Promise<SimSituation[]> {
  const db = getClientDb();
  const byId = new Map<string, SimSituation>();
  const personal = await getDocs(
    query(
      collection(db, "sim_situations"),
      where("recipientUid", "==", uid),
      limit(QUEUE_LIMIT)
    )
  );
  for (const d of personal.docs) {
    const s = toSituation(d.data());
    if (s.situationId) byId.set(s.situationId, s);
  }
  for (const cityId of ownedCityIds) {
    const citySnap = await getDocs(
      query(
        collection(db, "sim_situations"),
        where("audienceCityId", "==", cityId),
        limit(QUEUE_LIMIT)
      )
    );
    for (const d of citySnap.docs) {
      const s = toSituation(d.data());
      if (s.situationId) byId.set(s.situationId, s);
    }
  }
  return [...byId.values()];
}

/** The viewer's own delegation rules (author-private reads, §9.7). */
export async function loadDelegationRules(
  uid: string
): Promise<SimDelegationRule[]> {
  const db = getClientDb();
  const snap = await getDocs(
    query(
      collection(db, "sim_delegation_rules"),
      where("ownerUid", "==", uid),
      limit(RULES_LIMIT)
    )
  );
  return snap.docs
    .map((d) => toDelegationRule(d.data()))
    .filter((r) => r.ruleId !== "");
}

export interface RuleFireStats {
  /** Count of fire entries found (capped at the read limit). */
  count: number;
  /** The newest fire's Log seq, or null when none was found. */
  lastSeq: number | null;
}

/**
 * Best-effort fire history for one rule (§7.4's "last-fired seq (Log
 * link), fire count"): fire entries cite the rule in their Log
 * classification (`buildRuleFireEntry`). A failed read renders as
 * absence — the panel simply shows no fire line — never as a
 * fabricated zero presented with confidence.
 */
export async function loadRuleFireStats(
  ruleId: string
): Promise<RuleFireStats | null> {
  try {
    const db = getClientDb();
    const snap = await getDocs(
      query(
        collection(db, "sim_log_entries"),
        where("classification.delegationRuleId", "==", ruleId),
        limit(50)
      )
    );
    let lastSeq: number | null = null;
    for (const d of snap.docs) {
      const seq = asNullableNumber(d.data().seq);
      if (seq !== null && (lastSeq === null || seq > lastSeq)) lastSeq = seq;
    }
    return { count: snap.size, lastSeq };
  } catch {
    return null;
  }
}

/** One envelope + its output (the spawn marker's reads). The §9.4 /
 * §9.5 fences decide readability; an unreadable doc reads as null. */
export async function loadEnvelope(
  taskId: string
): Promise<TaskEnvelopeRecord | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_task_envelopes", taskId));
    if (!snap.exists()) return null;
    return snap.data() as TaskEnvelopeRecord;
  } catch {
    return null;
  }
}

export async function loadTaskOutput(
  taskId: string
): Promise<TaskOutputRecord | null> {
  try {
    const snap = await getDoc(doc(getClientDb(), "sim_task_outputs", taskId));
    if (!snap.exists()) return null;
    return snap.data() as TaskOutputRecord;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Decision submissions — one governance action each, through the
// play intake. The caller (ActionRunner) owns the lifecycle UI.
// ---------------------------------------------------------------------

export interface DecisionSubmission {
  actionId: string;
}

async function submitGovernance(
  uid: string,
  actionType: string,
  structuredAction: Record<string, unknown>,
  targetCityIds: string[],
  threadRef?: { kind: string; id: string }
): Promise<DecisionSubmission> {
  const { actionId } = await submitPlayAction({
    uid,
    clientRequestId: newClientRequestId(),
    actionType,
    actionText: null,
    structuredAction,
    targetCityIds,
    ...(threadRef ? { threadRef } : {}),
  });
  return { actionId };
}

/** §6.3A — "I am handling this myself." Records the decision; the
 * handling flow itself is the deep-linked authoritative surface.
 * With `outcome: "declined"` (PR-4's F3 completion wiring) the
 * same submission closes an `awaiting_owner` card as
 * handled-by-declining in its own resolution — declining a
 * delegate's draft is a complete outcome (§6.1), and the verb
 * lands on the card (`handling.outcomeVerb`) and in the Log. */
export function submitSituationHandle(
  uid: string,
  args: {
    situationId: string;
    cityId: string | null;
    decisionNote?: string;
    outcome?: "declined";
  }
): Promise<DecisionSubmission> {
  return submitGovernance(
    uid,
    "situation.handle",
    {
      situationId: args.situationId,
      ...(args.decisionNote ? { decisionNote: args.decisionNote } : {}),
      ...(args.outcome ? { outcome: args.outcome } : {}),
    },
    args.cityId ? [args.cityId] : []
  );
}

/** §6.3B — delegate to an NPC under its standing mandate (the
 * handler reads the mandate's current version from the stored root;
 * the surface never nominates a version). */
export function submitSituationDelegate(
  uid: string,
  args: {
    situationId: string;
    cityId: string | null;
    npcId: string;
    mandateId?: string | null;
    decisionNote?: string;
  }
): Promise<DecisionSubmission> {
  return submitGovernance(
    uid,
    "situation.delegate",
    {
      situationId: args.situationId,
      npcId: args.npcId,
      ...(args.mandateId ? { mandateId: args.mandateId } : {}),
      ...(args.decisionNote ? { decisionNote: args.decisionNote } : {}),
    },
    args.cityId ? [args.cityId] : []
  );
}

/** §6.3C — stay silent: an explicit owner action whose outcome is
 * the recorded non-response. Not a dismissal; a decision. */
export function submitSituationSilence(
  uid: string,
  args: { situationId: string; cityId: string | null }
): Promise<DecisionSubmission> {
  return submitGovernance(
    uid,
    "situation.silence",
    { situationId: args.situationId },
    args.cityId ? [args.cityId] : []
  );
}

/** Author or revise a delegation rule (§7.4 panel). One submission
 * authors one new version; `enabled: false` disables the rule. */
export function submitDelegationRuleSet(
  uid: string,
  args: { cityId: string; rule: Record<string, unknown> }
): Promise<DecisionSubmission> {
  return submitGovernance(uid, "delegationRule.set", args.rule, [args.cityId]);
}

/**
 * Spawn an NPC envelope (brief §11.2). The envelope's own
 * `clientRequestId` rides inside the payload so the deterministic
 * envelope id (`envelopeTaskId`) is computable by the surface once
 * the spawn resolves.
 */
export function submitEnvelopeSpawn(
  uid: string,
  args: {
    cityId: string;
    payload: Record<string, unknown>;
    envelopeClientRequestId: string;
    threadRef?: { kind: string; id: string };
  }
): Promise<DecisionSubmission> {
  return submitGovernance(
    uid,
    "envelope.spawn",
    { ...args.payload, clientRequestId: args.envelopeClientRequestId },
    [args.cityId],
    args.threadRef
  );
}
