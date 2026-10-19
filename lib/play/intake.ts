/**
 * Client intake helpers for the play loop (Phase 4 brief §2.1–§2.3).
 *
 * The browser's entire write surface for play is exactly two writes,
 * both fenced by the landed `sim_actions` rules clause (Phase 1
 * posture as amended by Phase 2 §9.4):
 *
 * 1. **Create** — a `sim_actions` doc built by the landed
 *    `buildActionDoc` builder: born `received`, every lifecycle field
 *    null, `actor.memberId` = the writer's uid. Nothing else about
 *    the doc is negotiable, and these helpers do not negotiate.
 * 2. **Confirm** — from `awaiting_confirmation` only, touching only
 *    `confirmation` / `status` / `updatedAt`, with the confirmation
 *    bound to the stored preview's hash. The rules diff-check the
 *    key set, so this helper sends exactly those keys.
 *
 * Everything else in the loop — translation, preview, the wake,
 * resolution, the Log — is the fabric's. There is no client write
 * path to sim state (TC-H02 as amended; gate row P4-G12), and no
 * helper here pretends otherwise: a submitted action sits at
 * `received` until the fabric's runner picks it up.
 */

import {
  doc,
  onSnapshot,
  setDoc,
  Timestamp,
  updateDoc,
  type Unsubscribe,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { buildActionDoc } from "@/lib/sim/intake";
import type { ActionStatus, SimActor } from "@/lib/sim/state";
import type {
  PlayActionView,
  PlayDelta,
  PlayPendingDisclosure,
  PlayPreview,
} from "./types";

export const SIM_ACTIONS_COLLECTION = "sim_actions";

/** The actor record for a member acting as themselves — the exact
 * shape the Phase 2 suite's `memberActor` established and the create
 * fence checks (`actor.memberId == auth.uid`). NPC and delegated
 * actors are Phase 5's business and are never minted here. */
export function memberActor(uid: string): SimActor {
  return {
    type: "member",
    memberId: uid,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
  };
}

/**
 * A fresh client request id for a new draft. The id is the intake
 * idempotency key (TC-A04): the component mints one per draft and
 * reuses it across retries of *that* draft's submission, so a
 * double-click or a retried network call maps onto the same
 * `sim_actions` doc (`actionId = sha256(actorUid + ":" +
 * clientRequestId)`) instead of double-applying. A new draft gets a
 * new id.
 */
export function newClientRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export interface SubmitPlayActionInput {
  uid: string;
  /** The draft's idempotency key — see newClientRequestId. */
  clientRequestId: string;
  /** A registered kind id, or FREE_TEXT_KIND for prose. */
  actionType: string;
  actionText?: string | null;
  structuredAction?: Record<string, unknown> | null;
  targetCityIds: string[];
  threadRef?: { kind: string; id: string } | null;
}

/**
 * Submit an action: build the doc with the landed builder and write
 * it under its derived id. `setDoc` (not `addDoc`) is the point —
 * resubmitting the same draft overwrites the same born-`received`
 * doc rather than creating a second action.
 */
export async function submitPlayAction(
  input: SubmitPlayActionInput
): Promise<{ actionId: string }> {
  const { actionId, doc: actionDoc } = buildActionDoc({
    actorUid: input.uid,
    clientRequestId: input.clientRequestId,
    actor: memberActor(input.uid),
    actionType: input.actionType,
    actionText: input.actionText ?? null,
    structuredAction: input.structuredAction ?? null,
    targetCityIds: input.targetCityIds,
    threadRef: input.threadRef ?? null,
    now: new Date().toISOString(),
  });
  await setDoc(doc(getClientDb(), SIM_ACTIONS_COLLECTION, actionId), actionDoc);
  return { actionId };
}

export interface ConfirmPlayActionInput {
  actionId: string;
  uid: string;
  /** Must equal the stored preview's `previewHash` exactly — the
   * rules fence compares it against the record, and a mismatch is a
   * refused write, not a stale-confirm. */
  previewHash: string;
  /** The authority the member confirms under. Every landed exercise
   * of this clause uses "owner" (the member confirming their own
   * action); the value is recorded on the doc, and per-kind labels
   * are the registry's concern at assembly. */
  authorityType?: string;
}

/**
 * Confirm a previewed action — the member's deliberate second act
 * (brief §2.3, never-bind). Sends exactly the three keys the §9.4
 * clause permits a member to touch, nothing more.
 */
export async function confirmPlayAction(input: ConfirmPlayActionInput): Promise<void> {
  await updateDoc(doc(getClientDb(), SIM_ACTIONS_COLLECTION, input.actionId), {
    confirmation: {
      confirmedByUid: input.uid,
      confirmedAt: Timestamp.now(),
      previewHash: input.previewHash,
      authorityType: input.authorityType ?? "owner",
    },
    status: "confirmed",
    updatedAt: Timestamp.now(),
  });
}

// ---------------------------------------------------------------------------
// Reading the action back — the lifecycle subscription
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseDelta(value: unknown): PlayDelta | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.cityId !== "string" || typeof record.field !== "string") return null;
  return {
    cityId: record.cityId,
    field: record.field,
    before: record.before ?? null,
    after: record.after ?? null,
  };
}

function parsePendingDisclosure(value: unknown): PlayPendingDisclosure | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.pendingId !== "string") return null;
  return {
    pendingId: record.pendingId,
    kind: asString(record.kind, "pending"),
    targetCityId: asNullableString(record.targetCityId),
    generation: asNullableNumber(record.generation),
    delayDerivation:
      record.delayDerivation && typeof record.delayDerivation === "object"
        ? (record.delayDerivation as Record<string, unknown>)
        : null,
    conditionSummary: asString(record.conditionSummary),
  };
}

/** Parse the stored preview record into the member-facing view.
 * Returns null when there is no preview or the record carries no
 * hash to bind a confirmation to — a preview without a hash is not
 * confirmable, and the UI must not offer one. */
export function parsePreview(raw: unknown): PlayPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const previewHash = asNullableString(record.previewHash);
  if (!previewHash) return null;
  return {
    outcome: asString(record.outcome, "resolved"),
    summaryText: asString(record.summaryText),
    deltas: Array.isArray(record.deltas)
      ? record.deltas.map(parseDelta).filter((d): d is PlayDelta => d !== null)
      : [],
    spillover: asStringArray(record.spillover),
    pendingDisclosures: Array.isArray(record.pendingDisclosures)
      ? record.pendingDisclosures
          .map(parsePendingDisclosure)
          .filter((p): p is PlayPendingDisclosure => p !== null)
      : [],
    recordsAffected: asStringArray(record.recordsAffected),
    warnings: asStringArray(record.warnings),
    baselineVersion: asNullableString(record.baselineVersion),
    rulesVersion: asNullableString(record.rulesVersion),
    computedAt: asNullableString(record.computedAt),
    previewHash,
  };
}

/** Parse one `sim_actions` doc into the lifecycle view. */
export function toPlayActionView(
  actionId: string,
  data: Record<string, unknown>
): PlayActionView {
  const failure =
    data.failure && typeof data.failure === "object"
      ? {
          code: asString((data.failure as Record<string, unknown>).code, "FAILED"),
          message: asString(
            (data.failure as Record<string, unknown>).message,
            "The fabric recorded a failure without a message."
          ),
        }
      : null;
  return {
    actionId,
    status: asString(data.status, "received") as ActionStatus,
    actionType: asString(data.actionType),
    actionText: asNullableString(data.actionText),
    targetCityIds: asStringArray(data.targetCityIds),
    preview: parsePreview(data.preview),
    failure,
    resolutionId: asNullableString(data.resolutionId),
    firstLogSeq: asNullableNumber(data.firstLogSeq),
    lastLogSeq: asNullableNumber(data.lastLogSeq),
  };
}

/**
 * Follow one action through its lifecycle. The callback receives
 * null when the doc does not exist — including after a lawful undo
 * erases the action with its resolution (CJ's undo ruling: removed
 * as if it never happened), which the surface reports as exactly
 * that, not as an error.
 */
export function subscribePlayAction(
  actionId: string,
  onData: (view: PlayActionView | null) => void,
  onError?: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    doc(getClientDb(), SIM_ACTIONS_COLLECTION, actionId),
    (snapshot) => {
      onData(snapshot.exists() ? toPlayActionView(snapshot.id, snapshot.data()) : null);
    },
    (error) => {
      if (onError) onError(error);
    }
  );
}
