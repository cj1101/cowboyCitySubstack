/**
 * Action intake (Phase 2 brief §2.3) — the builder every client surface
 * (and every test fixture) uses to construct a `sim_actions` doc.
 *
 * `actionId = sha256(actorUid + ":" + clientRequestId)`: a client retry
 * with the same request ID maps onto the same doc (intake idempotency,
 * TC-A04's first half). The doc is born in status `received` with every
 * lifecycle field null — the tightened §9.4 create clause enforces
 * exactly this shape in rules.
 */

import { sha256Hex } from "./canonical";
import type { SimAction, SimActor } from "./state";

export function buildActionId(actorUid: string, clientRequestId: string): string {
  return sha256Hex(`${actorUid}:${clientRequestId}`);
}

export interface ActionIntakeInput {
  actorUid: string;
  clientRequestId: string;
  actor: SimActor;
  actionType: string;
  actionText?: string | null;
  structuredAction?: Record<string, unknown> | null;
  targetCityIds?: string[];
  source?: string;
  threadRef?: { kind: string; id: string } | null;
  /** Injected instant (fixtures + tests control the clock, F3). */
  now: string;
}

export function buildActionDoc(input: ActionIntakeInput): { actionId: string; doc: SimAction } {
  const actionId = buildActionId(input.actorUid, input.clientRequestId);
  const at = new Date(input.now);
  const doc: SimAction = {
    actionId,
    schemaVersion: 2,
    clientRequestId: input.clientRequestId,
    idempotencyKey: input.clientRequestId,
    source: input.source ?? "web",
    actor: input.actor,
    actionType: input.actionType,
    actionText: input.actionText ?? null,
    structuredAction: input.structuredAction ?? null,
    targetCityIds: input.targetCityIds ?? [],
    threadRef: input.threadRef ?? null,
    audienceUids: [input.actorUid],
    preview: null,
    previewPlanHash: null,
    confirmation: null,
    claim: null,
    lastAttempt: null,
    status: "received",
    resolutionId: null,
    firstLogSeq: null,
    lastLogSeq: null,
    failure: null,
    createdAt: at,
    updatedAt: at,
  };
  return { actionId, doc };
}
