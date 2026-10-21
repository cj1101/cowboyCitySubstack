/**
 * Log actor forms for delegated activity (brief §3; character design
 * §6; P5-K13). Builders produce the LANDED `SimActor` shape — no new
 * actor type exists or may be invented ("no `character` actor type,
 * ever"): a character is a voice, never an authority.
 *
 * The one additive field the phase adopts is `characterId` on the
 * MEMBER form (P5-K13: absent ≡ null, hash version unchanged). It lands
 * in `lib/sim/state.ts` with the phase's rules diff (Dana's surface);
 * until then this module carries it as a local extension type so the
 * shape is fixed and harness-provable here.
 */

import type { SimActor } from "../sim/state";
import type { NpcRecord } from "./types";

/** Landed SimActor + the P5-K13 additive field (member form only). */
export type SimActorP5 = SimActor & { characterId?: string | null };

/** Standing delegation: the NPC acts under its mandate (§3.1). The
 * mandate pair is the authority root; envelopeId is null. */
export function npcActorStanding(
  npc: NpcRecord,
  mandateId: string,
  mandateVersion: number
): SimActor {
  return {
    type: "npc",
    memberId: null,
    npcId: npc.npcId,
    onBehalfOfMemberId: npc.ownerUid,
    mandateId,
    mandateVersion,
    envelopeId: null,
  };
}

/** Envelope tasking: the NPC works a one-off envelope (§3.1). The
 * envelope id is the authority root; the mandate pair is null. Entries
 * under this actor carry `changes: []` — envelope output is advisory by
 * construction (invariant 2). */
export function npcActorEnvelope(npc: NpcRecord, envelopeId: string): SimActor {
  return {
    type: "npc",
    memberId: null,
    npcId: npc.npcId,
    onBehalfOfMemberId: npc.ownerUid,
    mandateId: null,
    mandateVersion: null,
    envelopeId,
  };
}

/** Member acting in character (P5-K13 / character §6 rule 2): the
 * member remains the actor of record — legally, mechanically, and for
 * undo/dependency purposes the MEMBER acted; the character is the
 * voice. In-character Situation handling is this shape, never the NPC
 * shape (character §6 rule 4). */
export function memberInCharacterActor(
  memberUid: string,
  characterId: string
): SimActorP5 {
  return {
    type: "member",
    memberId: memberUid,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
    office: null,
    characterId,
  };
}

export interface ActorFormResult {
  ok: boolean;
  violations: string[];
}

/**
 * The §3.2 traceability triple, enforced as a form check: an NPC actor
 * cites its NPC, its owner (creator = city owner at the root), and
 * EXACTLY ONE authority root — (mandateId + mandateVersion) XOR
 * envelopeId. An actor with neither root is an orphan; with both, it is
 * ambiguous. Either fails, on every path, before any rule runs.
 */
export function validateNpcActorForm(actor: SimActor): ActorFormResult {
  const violations: string[] = [];
  if (actor.type !== "npc") {
    violations.push(`actor type is "${actor.type}", not "npc"`);
    return { ok: false, violations };
  }
  if (actor.memberId !== null) {
    violations.push("npc actor carries a memberId (the member is not the actor)");
  }
  if (!actor.npcId) violations.push("npc actor cites no npcId");
  if (!actor.onBehalfOfMemberId) {
    violations.push("npc actor cites no onBehalfOfMemberId (no owner at the root)");
  }
  const hasMandate = actor.mandateId !== null;
  const hasMandateVersion = actor.mandateVersion !== null;
  const hasEnvelope = actor.envelopeId !== null;
  if (hasMandate !== hasMandateVersion) {
    violations.push("mandate root is half-cited (mandateId without version or vice versa)");
  }
  if (hasMandate && hasEnvelope) {
    violations.push("actor cites BOTH a mandate root and an envelope root (exactly one is required)");
  }
  if (!hasMandate && !hasEnvelope) {
    violations.push("actor cites NO authority root (orphan — §3.2 fails it)");
  }
  return { ok: violations.length === 0, violations };
}

/** Which root an NPC actor cites, when its form is valid. */
export function actorAuthorityRoot(
  actor: SimActor
): { kind: "mandate"; mandateId: string; mandateVersion: number } | { kind: "envelope"; envelopeId: string } | null {
  if (actor.type !== "npc") return null;
  if (actor.mandateId !== null && actor.mandateVersion !== null && actor.envelopeId === null) {
    return { kind: "mandate", mandateId: actor.mandateId, mandateVersion: actor.mandateVersion };
  }
  if (actor.envelopeId !== null && actor.mandateId === null && actor.mandateVersion === null) {
    return { kind: "envelope", envelopeId: actor.envelopeId };
  }
  return null;
}
