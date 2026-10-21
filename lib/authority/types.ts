/**
 * Authority model — vocabulary (Phase 5 brief §2.3/§2.4/§5; spec v2 §8).
 *
 * Types only — no logic, no I/O. The authority stage is the phase's
 * security core: every NPC resolution attempt passes it, against current
 * committed records, deterministically, identically on preview, live, and
 * replay paths (brief §5.2). This module never reads Firestore, never
 * calls a model, and never commits anything: it evaluates records a
 * caller has already read (see `view.ts`) and returns a verdict.
 *
 * Record shapes below restate the brief's FINAL shapes (§2.3/§2.5, Dana
 * §3.2 as reconciled by the brief) so the evaluation logic is typed
 * against the same fields the rules and the fabric will enforce.
 */

import type { SimActor } from "../sim/state";

// ---------------------------------------------------------------------------
// Permission modes (brief §2.4, P5-K3/P5-D3)
// ---------------------------------------------------------------------------

/**
 * The owner's permission posture for an NPC. The mode lives ONLY on the
 * mandate version (P5-D3); the NPC doc's `permissionMode` is a fabric-
 * maintained snapshot of the current version's mode, and `ruleMode` on
 * the evaluation view is a fired delegation rule's narrower posture.
 * Effective mode at any evaluation = the NARROWEST of the three
 * (§2.4 table, §7.2): silent < ask-first < act-for-me.
 */
export type PermissionMode = "act-for-me" | "ask-first" | "silent";

// ---------------------------------------------------------------------------
// Records (brief §2.3)
// ---------------------------------------------------------------------------

/** `sim_npcs/{npcId}` — doc id (generated) is the id everywhere. One NPC,
 * one owner, one city, always (brief §2.3; re-homing is retire + create). */
export interface NpcRecord {
  npcId: string;
  /** The persona this NPC plays (characters/{characterId}); resolved from
   * the NPC record at render time, never cited in the Log (P5-K13). */
  characterId: string;
  cityId: string;
  ownerUid: string;
  /** Snapshot of the current mandate version's mode (fabric-maintained). */
  permissionMode: PermissionMode;
  status: "active" | "retired";
  currentMandateId: string | null;
  currentMandateVersion: number | null;
  activationSeq: number;
  retiredSeq: number | null;
}

/** Trigger kinds a mandate version may declare (brief §2.3
 * `scope.triggerKinds`; §7.1's situation-routing kinds plus the
 * instruction/delegation kinds of §5.2 check 5). */
export type TriggerKind =
  | "owner-envelope"
  | "delegated-action"
  | "log-event"
  | "situation"
  | "meeting-request"
  | "case-filed"
  | "standing-routine";

/**
 * Negotiation bounds (spec v2 §8.4 — the four enforcement layers). An
 * entry constrains terms of one `kind`: Rubar terms carry amounts,
 * textual terms carry `text`. `walkAwayIf` entries are exact term texts
 * whose presence in a proposal is an automatic out-of-bounds hit — the
 * only mechanical reading of a free-text condition (see negotiation.ts).
 */
export interface NegotiationBoundEntry {
  kind: string;
  minAmount?: number | null;
  maxAmount?: number | null;
  text?: string | null;
}

export interface NegotiationBounds {
  subject: string;
  mayOffer: NegotiationBoundEntry[];
  mayAccept: NegotiationBoundEntry[];
  walkAwayIf: string[];
  maxTurns: number;
}

/** The structured half of a mandate version (brief §2.3 `scope`). Scope
 * fields are read ONLY from the cited version doc — no prose source, no
 * client echo (TC-N05). */
export interface MandateScope {
  allowedActionTypes: string[];
  namedRecordIds: string[];
  counterpartyCityIds: string[];
  perActionRubars: number | null;
  perPeriodRubars: number | null;
  perPeriodActions: number | null;
  /** Free-text period definition; periods are seq/action-count terms,
   * never clock terms (§2.3). Counting itself is by mandate citation
   * over the Log (§5.3) and arrives here as `PeriodUsage`. */
  periodDefinition: string;
  maxProjectPhase: number | null;
  triggerKinds: TriggerKind[];
  negotiationBounds: NegotiationBounds | null;
  alwaysEscalate: string[];
  allowPartialExecution: boolean;
}

/** `sim_mandates/{mandateId}` — the root: identity and currency only. */
export interface MandateRootRecord {
  mandateId: string;
  npcId: string;
  cityId: string;
  ownerUid: string;
  currentVersion: number;
}

/**
 * `sim_mandates/{mandateId}/versions/{version}` — immutable once written
 * (the seq fields are the committer's/finalizer's stamps; a mode "change"
 * is a new version, P5-D3). `mandateHash` covers exactly the immutable
 * authority payload (see mandate.ts) — status and lifecycle stamps are
 * excluded, so a revocation stamp never moves the hash of what the owner
 * confirmed.
 */
export interface MandateVersionRecord {
  mandateId: string;
  version: number;
  status: "pending" | "active" | "superseded" | "revoked" | "expired";
  mode: PermissionMode;
  scope: MandateScope;
  expiresAtSeq: number | null;
  horizonActions: number | null;
  effectiveSeq: number | null;
  revokedSeq: number | null;
  mandateHash: string;
  createdByUid: string;
}

// ---------------------------------------------------------------------------
// The evaluation view — everything the stage reads, assembled by the
// caller from current committed records (view.ts builds it from a
// SimSnapshot). No field here is worker- or model-supplied.
// ---------------------------------------------------------------------------

/** Authority-relevant facts about one city. For ordinary cities,
 * `ownerUids` is the faction doc's list. For the SHARED city the faction
 * list is deliberately NOT authority: `isSharedCity` switches check 2 to
 * the terms record (CJ round-3 ruling; see evaluate.ts and Nadia F-11 —
 * the landed `checkCityAuthority` accepts any co-owner for any city and
 * must not be reused for the shared city). */
export interface CityAuthorityContext {
  cityId: string;
  ownerUids: string[];
  isSharedCity: boolean;
  /** From the current `sim_terms` record; shared city only. */
  mayorUid: string | null;
  viceMayorUid: string | null;
}

/** Delegated usage inside the cited version's current period, counted by
 * the caller from the Log by mandate citation (§5.3, TC-N21) — never
 * incremented speculatively, never read from a counter on the mandate. */
export interface PeriodUsage {
  delegatedResolutions: number;
  delegatedRubars: number;
}

export interface AuthorityView {
  npc: NpcRecord | null;
  mandateRoot: MandateRootRecord | null;
  /** The version doc the actor cites (actor.mandateVersion), if read. */
  mandateVersion: MandateVersionRecord | null;
  /** Principal city + every target city of the attempt, by id. */
  cities: ReadonlyMap<string, CityAuthorityContext>;
  periodUsage: PeriodUsage;
  /** A fired delegation rule's mode for this NPC, when the attempt
   * arrives via the delegation pass (§7.2 narrower-authority). */
  ruleMode: PermissionMode | null;
  /** The seq the resolution would consume (lastSeq + 1 at evaluation).
   * All expiry/effect predicates are evaluated against it — the sim's
   * only clock is the Log (§1.2). */
  atSeq: number;
}

// ---------------------------------------------------------------------------
// The attempt — what is being tried, as the resolver classified it.
// ---------------------------------------------------------------------------

export interface ProposedTerm {
  kind: string;
  /** "offer" = we give this; "accept" = we take this. */
  side: "offer" | "accept";
  amountRubars?: number | null;
  text?: string | null;
}

export interface DelegatedActionAttempt {
  actionType: string;
  /** Registry rule ids the resolver classified this attempt under. */
  ruleIds: string[];
  /** Descriptor-assigned classes (Tier B inputs: "binding-act",
   * "destruction", "law-office", "undo-execution", "ballot", … —
   * classify.ts). */
  classes: string[];
  /** The principal city: the city acted FOR (the NPC's city). */
  cityId: string;
  /** Cities whose state this action would directly change (foreign-effect
   * targets for the fairness fence). Counterparties to a negotiation are
   * NOT targets — a proposal changes no foreign state. */
  targetCityIds: string[];
  /** Record ids the action touches (scope namedRecordIds check). */
  namedRecordIds: string[];
  counterpartyCityIds: string[];
  /** Absolute Rubar movement the resolver's preview math assigns to this
   * action (0 for non-money actions). */
  rubarMovement: number;
  /** Project phase this action would advance to, when it advances one. */
  projectPhase: number | null;
  /** "state-change" alters records; "read-collection" only reads (R-25
   * surveys, R-27 runs — collection reads are not alteration, brief
   * §5.3/#16, so the fairness fence does not fire on them). */
  effectClass: "state-change" | "read-collection";
  /** True when the owner personally confirmed/queued this delegated
   * action (check 5's "delegated-action" trigger source). */
  ownerConfirmedDelegated: boolean;
  /** P5-D5: generated prose disagreeing with the structured action is
   * named here by the composer; any non-null value escalates. */
  proseStructuredConflict: string | null;
  /** Negotiation output to bounds-diff (check 7), when present. */
  negotiation: { proposedTerms: ProposedTerm[]; turnsUsed: number } | null;
}

/** The trigger an attempt cites (check 5). At least one of sourceSeq /
 * envelopeId must root it in a committed record or a live envelope. */
export interface AuthorityTrigger {
  kind: TriggerKind;
  sourceSeq: number | null;
  sourceId: string | null;
  routineName: string | null;
  envelopeId: string | null;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** The traceability root a passing verdict certifies (§3.1): exactly one
 * authority root per NPC entry. Envelope-cited attempts never reach a
 * "resolve" verdict — envelopes are advisory by construction, so this
 * type has no envelope variant. */
export interface MandateCitation {
  kind: "mandate";
  mandateId: string;
  mandateVersion: number;
  mode: PermissionMode;
}

export interface AuthorityCheckTrace {
  /** 1..7 for the brief's checks; 0 = actor form; 8 = fairness fence. */
  check: number;
  name: string;
  outcome: "pass" | "fail" | "not-applicable";
  detail: string;
}

export type AuthorityVerdict =
  | {
      disposition: "resolve";
      citation: MandateCitation;
      checks: AuthorityCheckTrace[];
    }
  | {
      /** ask-first (drafts only) or shared-city non-mayor posture: the NPC
       * may produce advisory output; nothing resolves. */
      disposition: "draft-only";
      reason: "mode-ask-first" | "shared-city-non-mayor" | "shared-city-vice-mayor";
      detail: string;
      checks: AuthorityCheckTrace[];
    }
  | {
      /** silent: no action, no draft from the standing path. The caller
       * routes this to the §8 silence machinery (logged non-response). */
      disposition: "silence";
      checks: AuthorityCheckTrace[];
    }
  | {
      /** The owner is asked (one Situation + one Log entry, caller's job).
       * `failedCheck` names the check in the escalation, per §5.4. */
      disposition: "escalate";
      failedCheck: string;
      reason: string;
      /** Scope/cap components that failed, when the failure is §5.3's. */
      scopeFailures: string[];
      /** §5.3: partial execution of the in-scope remainder is permitted
       * only when the cited version allows it AND the failure is not a
       * single-action money-cap excess. */
      allowPartialExecution: boolean;
      /** Check-7 detail: the OUT OF BOUNDS violations (§8.4 layer 2). */
      outOfBounds: string[];
      checks: AuthorityCheckTrace[];
    }
  | {
      /** Fairness fence (invariant 3): a direct state change to another
       * owner's city/canon. Not an owner question — a wall. */
      disposition: "blocked-fairness";
      reason: string;
      checks: AuthorityCheckTrace[];
    }
  | {
      /** Structural invalidity: nothing here is the owner's to answer —
       * the queued thing terminates (execution-time `authority_changed`
       * is the envelope/action form of this verdict). */
      disposition: "reject";
      code: string;
      reason: string;
      checks: AuthorityCheckTrace[];
    };

export type { SimActor };
