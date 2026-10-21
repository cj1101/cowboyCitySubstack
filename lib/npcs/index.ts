/**
 * NPC core — public surface (Phase 5 delegation substrate, built ahead
 * of the phase on the election/market pattern).
 *
 * What is NOT here is as important as what is: no dispatcher, no
 * resolver stage, no envelope execution, no scheduler or clock of any
 * kind. NPCs act only inside owner-created mandates or owner-spawned
 * envelopes, and only on triggers — this module builds the records,
 * the authority payloads, and the attribution shapes those paths
 * consume. If no member acts, nothing here does anything (CJ's
 * causality rule; brief §0.1.1).
 */

export type {
  MandateCaps,
  MandateStatus,
  MandateVersionInput,
  NegotiationBounds,
  NpcCreateInput,
  NpcPersonality,
  NpcStatus,
  NpcTriggerCitation,
  PeriodDefinition,
  PermissionMode,
  SimMandateRoot,
  SimMandateVersion,
  SimNpc,
  SimTeam,
  StructuredScope,
} from "./types";

export { NpcCoreError } from "./types";

export {
  DEFAULT_PERMISSION_MODE,
  MODE_POWER,
  MODE_SEMANTICS,
  PERMISSION_MODES,
  isPermissionMode,
  modeSemantics,
  narrowerMode,
  narrowestMode,
  type ModeSemantics,
  type SituationRoutingPosture,
  type StandingTriggerPosture,
} from "./modes";

export {
  MANDATE_GOLDEN_VECTORS,
  MANDATE_HASH_FIELDS,
  buildMandateRoot,
  buildMandateVersion,
  isHorizonExhausted,
  isMandateExpiredAt,
  isNegotiationActionType,
  mandateAuthorityPayload,
  mandateHash,
  requiresNegotiationBounds,
  resolveVersionInForce,
  type CurrentVersionReason,
  type CurrentVersionResolution,
  type MandateGoldenVector,
} from "./mandates";

export {
  canonicalActorForm,
  isInCharacterActor,
  memberActor,
  memberInCharacterActor,
  npcActorEnvelope,
  npcActorStanding,
  triggerCitation,
  validateNpcAttribution,
  type SimActorWithCharacter,
} from "./actors";

export {
  NPC_COLLECTION,
  TEAM_COLLECTION,
  buildNpcActivation,
  buildNpcCreate,
  buildNpcEdit,
  buildNpcMandateSnapshot,
  buildNpcRetirement,
  buildNpcSetMode,
  deriveTeamActivity,
  deriveTeamRoster,
  npcPath,
  planNpcActivate,
  planNpcCreate,
  teamPath,
  validatePersonality,
  type TeamActivityState,
} from "./npcs";
