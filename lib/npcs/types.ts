/**
 * NPC core — record shapes (Phase 5 brief §2, Dana §§3.5–3.7 verbatim in
 * structure).
 *
 * An NPC is a *delegation state of a persona*, not a species of person
 * (Vera, character-system-design §1): the `sim_npcs` record carries the
 * delegation machinery and links by `characterId` to the public
 * `characters` persona record, which stays free of authority fields
 * (Vera §9 C-5, prep P5-K1). Definition fields are freeform by CJ's
 * openness ruling — any title, any scope, any template label; nothing in
 * this module validates a definition against a closed list.
 */

export type PermissionMode = "act-for-me" | "ask-first" | "silent";

export type NpcStatus = "pending_activation" | "active" | "retired";

/**
 * Flavor/proposal guidance only (brief §2.1). No numeric field may exist
 * anywhere inside this object — personality is character, not math
 * (Vera §8.2); `validatePersonality` enforces that mechanically.
 */
export interface NpcPersonality {
  traits: string[];
  voiceNotes: string | null;
  characterNotes: string | null;
}

/** `sim_npcs/{npcId}` — the NPC delegation record (brief §2.1 [FINAL]). */
export interface SimNpc {
  /** Doc id is the npcId: the linked character's ID where a social
   * character exists, else the ID minted in the creation resolution. */
  npcId: string;
  /** Link to `characters/{characterId}` (public persona; never authority). */
  characterId: string;
  /** The one faction this record serves (TC-N08 scope discipline). */
  cityId: string;
  /** Accountable creator/controller snapshot. */
  ownerUid: string;
  displayNameSnapshot: string;
  /** Any title, per CJ's openness rule. No enum, no whitelist. */
  titleFreeform: string;
  /** Optional starting template label (`steward`, `treasurer`, … as
   * examples); a free string, never validated against a list (TC-N14). */
  roleTemplate: string | null;
  personality: NpcPersonality;
  /** The owner's words for what this NPC is for. */
  scopeFreeform: string;
  /** Fabric-maintained snapshot of the current mandate version's mode
   * (P5-D3); the solo authority for envelope-tasking posture and
   * situation-routing refusals when no mandate exists. */
  permissionMode: PermissionMode;
  status: NpcStatus;
  currentMandateId: string | null;
  currentMandateVersion: number | null;
  activationSeq: number | null;
  retiredSeq: number | null;
  stateVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

/** What an owner supplies to `npc.create` (brief §3.3 governance action). */
export interface NpcCreateInput {
  /** Existing persona to link, or null to mint one in the same resolution. */
  characterId: string | null;
  /** Required iff `characterId` is null: the one ID used in both places. */
  mintedCharacterId?: string | null;
  cityId: string;
  ownerUid: string;
  displayNameSnapshot: string;
  titleFreeform: string;
  roleTemplate?: string | null;
  personality: NpcPersonality;
  scopeFreeform: string;
  /** Omitted → the adopted default (`ask-first`, P5-K3). */
  permissionMode?: PermissionMode | null;
}

/** `sim_teams/{cityId}` — management team roster (brief §2.2 [FINAL]).
 * Pure roster + lead pointer; never a mandate holder (P5-K1). */
export interface SimTeam {
  cityId: string;
  npcIds: string[];
  leadNpcId: string | null;
  displayNote: string | null;
  stateVersion: number;
  lastChangedSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MandateStatus = "pending" | "active" | "superseded" | "revoked" | "expired";

/** `sim_mandates/{mandateId}` — root record (brief §2.3 [FINAL]). The
 * current-version pointer changes only inside a fabric resolution. */
export interface SimMandateRoot {
  mandateId: string;
  npcId: string;
  cityId: string;
  ownerUid: string;
  currentVersion: number;
  status: MandateStatus;
  currentVersionRef: string;
  createdSeq: number | null;
  revokedSeq: number | null;
  expiresAtSeq: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The structured half of a freeform mandate (brief §2.3). Free strings
 * inside arrays — not closed enums (CJ openness); interpretation of novel
 * routines happens at resolution time and is logged (TC-E09 pattern). */
export interface StructuredScope {
  triggerKinds: string[];
  allowedActionTypes: string[];
  namedRecordIds: string[];
  /** null = no counterparty restriction beyond fairness/sovereignty;
   * [] = no counterparties allowed. */
  counterpartyCityIds: string[] | null;
}

/** "Period" is defined by the mandate in seq/action-count terms,
 * never by an autonomous clock (brief §2.3). */
export interface PeriodDefinition {
  kind: "actions" | "seqWindow";
  count: number;
}

/** Brief §2.3 caps. Additional named integer caps ride in the same
 * object (`additionalCaps` at build input, spread into the stored
 * object); every cap value is an integer or null. */
export interface MandateCaps {
  perActionRubars: number | null;
  perResolutionPeriodRubars: number | null;
  periodDefinition: PeriodDefinition | null;
  maxProjectPhase: number | null;
  /** Defaults false: an over-cap attempt is refused whole and escalated,
   * never executed up to the cap, unless the owner wrote partial
   * execution into the mandate (TC-N05). */
  allowPartialExecution: boolean;
  [namedCap: string]: number | PeriodDefinition | boolean | null;
}

/** Vera §8.4 negotiation bounds. Required non-null for any mandate
 * version whose `allowedActionTypes` includes negotiation/envoy work;
 * validation rejects the version without it (layer 1). */
export interface NegotiationBounds {
  mayOffer: string | boolean | null;
  mayAccept: string | boolean | null;
  walkAwayIf: string | null;
  maxTurns: number | null;
}

/** `sim_mandates/{mandateId}/versions/{version}` — immutable version doc
 * (brief §2.3 [FINAL]). ID = version integer as string. */
export interface SimMandateVersion {
  version: number;
  npcId: string;
  cityId: string;
  ownerUid: string;
  /** The operative mode for actions under this version (P5-D3). */
  permissionMode: PermissionMode;
  scopeFreeform: string;
  structuredScope: StructuredScope;
  caps: MandateCaps;
  negotiationBounds: NegotiationBounds | null;
  /** Action types/topics that escalate even if otherwise allowed. The
   * Tier B classes (brief §5.4) are always-escalate by construction
   * whether listed or not; this list is the owner's additional fences. */
  alwaysEscalate: string[];
  responseStyle: string | null;
  expiresAtSeq: number | null;
  /** Delegated-resolution count after which renewal is required. */
  horizonActions: number | null;
  sourceActionId: string;
  effectiveSeq: number | null;
  supersededSeq: number | null;
  /** Canonical hash (§2.7) of the immutable authority payload —
   * status/effective fields excluded. See `mandates.ts`. */
  mandateHash: string;
  createdAt: Date;
}

/** What an owner supplies to `mandate.set` for a new version. */
export interface MandateVersionInput {
  version: number;
  npcId: string;
  cityId: string;
  ownerUid: string;
  permissionMode: PermissionMode;
  scopeFreeform: string;
  structuredScope: StructuredScope;
  caps: MandateCaps;
  negotiationBounds?: NegotiationBounds | null;
  alwaysEscalate?: string[];
  responseStyle?: string | null;
  expiresAtSeq?: number | null;
  horizonActions?: number | null;
  sourceActionId: string;
}

/** The trigger citation every delegated entry must carry (brief §3.2).
 * A delegated action with no resolvable trigger is an orphan (TC-N03);
 * for mandate routines, `sourceSeq` is the seq of the event that made
 * the routine due — if a routine has no causing event, it is not a
 * routine, it is autonomy, and it does not ship. */
export interface NpcTriggerCitation {
  kind: "log-event" | "envelope" | "mandate-routine" | "situation";
  sourceSeq: number | null;
  sourceId: string | null;
}

/** Typed build refusal. Doc builders throw this (the brief's own
 * envelope-builder discipline: "the builder throws before any write");
 * plan builders return `rejectedPlan` outcomes instead. */
export class NpcCoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NpcCoreError";
    this.code = code;
  }
}
