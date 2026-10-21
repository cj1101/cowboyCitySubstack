/**
 * Authority model — public surface (Phase 5 authority stage, built
 * ahead of the phase from the Phase 5 implementation brief §5).
 *
 * What is NOT here is as important as what is: no Firestore, no
 * scheduler, no worker, no commit path. This module evaluates records
 * and returns verdicts. The resolver's authority stage (at assembly)
 * reads current committed records into a view, calls
 * `evaluateDelegatedAction`, and routes the verdict — resolve, draft,
 * silence, escalate, blocked, reject — exactly as the brief routes it.
 * If no member acts, nothing here ever runs (CJ's causality rule).
 *
 * Revocation coverage is stated, not implied: it reaches actions,
 * queued items (via execution-time revalidation), and standing
 * triggers — and NOT ripenings or pending effects (Nadia F-11; see
 * revocation.ts). The boundary is executable (`revocationReaches`) so
 * no consumer has to guess.
 */

export type {
  AuthorityCheckTrace,
  AuthorityTrigger,
  AuthorityVerdict,
  AuthorityView,
  CityAuthorityContext,
  DelegatedActionAttempt,
  MandateCitation,
  MandateRootRecord,
  MandateScope,
  MandateVersionRecord,
  NegotiationBoundEntry,
  NegotiationBounds,
  NpcRecord,
  PeriodUsage,
  PermissionMode,
  ProposedTerm,
  TriggerKind,
} from "./types";

export { DEFAULT_PERMISSION_MODE, MODE_POWER, isPermissionMode, narrowestMode } from "./modes";

export { TIER_B_CLASSES, TIER_B_RULE_IDS, classifyTierB, type TierClassification } from "./classify";

export {
  diffNegotiationTerms,
  negotiationBoundsExcess,
  type NegotiationDiff,
} from "./negotiation";

export {
  computeMandateHash,
  mandateAuthorityPayload,
  mandateVersionState,
  verifyMandateHash,
  type MandateVersionState,
} from "./mandate";

export {
  actorAuthorityRoot,
  memberInCharacterActor,
  npcActorEnvelope,
  npcActorStanding,
  validateNpcActorForm,
  type ActorFormResult,
  type SimActorP5,
} from "./actor";

export {
  evaluateDelegatedAction,
  fairnessFenceFailure,
  mandateCurrencyFailure,
  npcIdentityFailure,
  ownershipOutcome,
  scopeCapFailures,
  type AuthorityFailure,
  type OwnershipOutcome,
} from "./evaluate";

export {
  REVOCATION_COVERAGE,
  evaluateRevocationImpact,
  executionTimeRevalidation,
  revocationReaches,
  type RevalidationResult,
  type RevocationImpact,
  type RevocationSubject,
} from "./revocation";

export {
  authorityViewFromSnapshot,
  cityContextFromDocs,
  mandateRootFromDoc,
  mandateVersionFromDoc,
  npcFromDoc,
  type AuthorityViewRefs,
} from "./view";
