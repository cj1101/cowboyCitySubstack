/**
 * Log actor attribution — NPC actors in the standing chain (brief §3;
 * Vera, character-system-design §6).
 *
 * No entry-schema change: the landed `SimActor` type already names every
 * field Phase 5 needs. Phase 5 populates previously-null fields; the
 * entry hash version does not change (brief §3.1, P5-K2).
 *
 * The one additive field is Vera's C-1, adopted as P5-K13: an optional
 * `characterId` on the MEMBER actor form (a member acting in character).
 * There is no `character` actor type and never will be — a character is
 * not an authority (Vera §6 rule 2). `characterId` is absent ≡ null in
 * canonical form (prep P5-K13 hash discipline); `canonicalActorForm`
 * performs that normalization for hash-input comparisons.
 */

import type { SimActor } from "../sim/state";
import { NpcCoreError, type NpcTriggerCitation } from "./types";

/** The landed actor forms plus Vera's one additive field (P5-K13). */
export type SimActorWithCharacter = SimActor & { characterId?: string | null };

function baseActor(partial: Partial<SimActor>): SimActor {
  return {
    type: "member",
    memberId: null,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
    ...partial,
  };
}

/** Vera §6 rule 1: member acting as themselves. */
export function memberActor(memberId: string): SimActorWithCharacter {
  return baseActor({ type: "member", memberId });
}

/**
 * Vera §6 rule 2 / P5-K13: member acting IN CHARACTER — used by the
 * in-character Situation handling of brief §6.3 ("delegate to a
 * character" is the member performing the handling while wearing the
 * persona; Vera §6 rule 4). Attribution stays `type: "member"` with the
 * member as actor of record; the character is the voice. Renders
 * "〈member name〉 as 〈character name〉". NEVER NPC attribution: no
 * mandate exists and no delegation occurred.
 */
export function memberInCharacterActor(
  memberId: string,
  characterId: string
): SimActorWithCharacter {
  if (!characterId) {
    throw new NpcCoreError("MISSING_CHARACTER", "in-character attribution requires a characterId");
  }
  return { ...baseActor({ type: "member", memberId }), characterId };
}

/**
 * Vera §6 rule 3 / brief §3.2, standing path: NPC acting under a
 * mandate. Exactly one authority root — the mandate citation.
 * `memberId` stays null: the owner is carried by `onBehalfOfMemberId`,
 * and the entry cites `npcId` because the mandate — not the persona —
 * authorized the act.
 */
export function npcActorStanding(input: {
  npcId: string;
  ownerUid: string;
  mandateId: string;
  mandateVersion: number;
}): SimActorWithCharacter {
  return baseActor({
    type: "npc",
    npcId: input.npcId,
    onBehalfOfMemberId: input.ownerUid,
    mandateId: input.mandateId,
    mandateVersion: input.mandateVersion,
  });
}

/** Brief §3.2, envelope path: NPC acting under a spawned envelope.
 * Exactly one authority root — the envelope citation. */
export function npcActorEnvelope(input: {
  npcId: string;
  ownerUid: string;
  envelopeId: string;
}): SimActorWithCharacter {
  return baseActor({
    type: "npc",
    npcId: input.npcId,
    onBehalfOfMemberId: input.ownerUid,
    envelopeId: input.envelopeId,
  });
}

/** The C-1 derived actor class (P5-K13): "in-character" is a view over
 * the stored form, never a stored class. */
export function isInCharacterActor(actor: SimActorWithCharacter): boolean {
  return actor.type === "member" && (actor.characterId ?? null) !== null;
}

/** Canonical comparison form: `characterId` absent ≡ null (P5-K13 — the
 * hashed field list is unchanged; older entries lack the key). */
export function canonicalActorForm(actor: SimActorWithCharacter): Record<string, unknown> {
  return {
    type: actor.type,
    memberId: actor.memberId ?? null,
    npcId: actor.npcId ?? null,
    onBehalfOfMemberId: actor.onBehalfOfMemberId ?? null,
    mandateId: actor.mandateId ?? null,
    mandateVersion: actor.mandateVersion ?? null,
    envelopeId: actor.envelopeId ?? null,
    office: actor.office ?? null,
    characterId: actor.characterId ?? null,
  };
}

/**
 * The committer/verifier-side NPC attribution contract (brief §3.2,
 * TC-N02c/N21). Returns the list of violations; empty = valid. An entry
 * failing any link of the traceability triple is an orphan change.
 */
export function validateNpcAttribution(actor: SimActorWithCharacter): string[] {
  const violations: string[] = [];
  if (actor.type !== "npc") {
    violations.push(`actor.type must be "npc" for NPC attribution, got "${actor.type}"`);
    return violations;
  }
  if (!actor.npcId) violations.push("npc actor requires npcId");
  if (!actor.onBehalfOfMemberId) {
    violations.push("npc actor requires onBehalfOfMemberId (the accountable owner)");
  }
  if (actor.memberId !== null && actor.memberId !== undefined) {
    violations.push("npc actor must not carry memberId (the owner rides onBehalfOfMemberId)");
  }
  if ((actor.characterId ?? null) !== null) {
    violations.push("npc actor must not carry characterId (that field is the member in-character form only)");
  }
  const hasMandate = actor.mandateId !== null && actor.mandateId !== undefined;
  const hasEnvelope = actor.envelopeId !== null && actor.envelopeId !== undefined;
  if (hasMandate === hasEnvelope) {
    violations.push(
      "exactly one authority root per action: mandateId+mandateVersion XOR envelopeId (brief §3.2)"
    );
  }
  if (hasMandate && (actor.mandateVersion === null || actor.mandateVersion === undefined)) {
    violations.push("mandate citation requires mandateVersion alongside mandateId");
  }
  if (!hasMandate && actor.mandateVersion !== null && actor.mandateVersion !== undefined) {
    violations.push("mandateVersion without mandateId is not a citation");
  }
  return violations;
}

/** Build a trigger citation (brief §3.2). For `log-event` and
 * `mandate-routine` triggers the causing seq is mandatory — a routine
 * with no causing event is autonomy, and it does not ship (TC-N03). */
export function triggerCitation(
  kind: NpcTriggerCitation["kind"],
  sourceSeq: number | null,
  sourceId: string | null
): NpcTriggerCitation {
  if ((kind === "log-event" || kind === "mandate-routine") && sourceSeq === null) {
    throw new NpcCoreError(
      "TRIGGER_WITHOUT_CAUSE",
      `a "${kind}" trigger requires the seq of the event that caused it (TC-N03)`
    );
  }
  return { kind, sourceSeq, sourceId };
}
