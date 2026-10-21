/**
 * The authority stage (brief §5.2/§5.3/§5.5) — the phase's security
 * core. Pure and deterministic: same records in, same verdict out, on
 * preview, forged-record, regression, and live paths alike. No check is
 * worker-discretionary and none is re-asked of the owner per occurrence;
 * failures route exactly where the brief routes them:
 *
 *   structural invalidity → "reject" (the queued thing terminates;
 *   at execution time this is the `authority_changed` family, TC-N09)
 *   mode posture          → "draft-only" / "silence"
 *   scope / caps / tier / → "escalate" (one Situation + Log entry,
 *   trigger / bounds        naming the failed check, §5.4)
 *   fairness fence        → "blocked-fairness" (a wall, not a question)
 *
 * The shared city is evaluated against the TERMS record, never the
 * faction owner list: the landed `checkCityAuthority` accepts any
 * co-owner for any city (its own comment defers the mayor path), and
 * reusing it here would leave CJ's round-3 ruling unenforced while
 * appearing enforced (Nadia F-11). Sitting mayor only acts
 * operationally; the vice mayor leads Town Hall intervention and gains
 * NO operational authority; every other member's NPCs are draft-only
 * on the shared city.
 */

import type { SimActor } from "../sim/state";
import { actorAuthorityRoot, validateNpcActorForm } from "./actor";
import { classifyTierB } from "./classify";
import { mandateVersionState } from "./mandate";
import { narrowestMode } from "./modes";
import { diffNegotiationTerms } from "./negotiation";
import type {
  AuthorityCheckTrace,
  AuthorityTrigger,
  AuthorityVerdict,
  AuthorityView,
  CityAuthorityContext,
  DelegatedActionAttempt,
  MandateVersionRecord,
  NpcRecord,
} from "./types";

function trace(
  check: number,
  name: string,
  outcome: AuthorityCheckTrace["outcome"],
  detail: string
): AuthorityCheckTrace {
  return { check, name, outcome, detail };
}

export interface AuthorityFailure {
  code: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Reusable primitives (checks 1–3) — the envelope lifecycle's execution-
// time revalidation (brief §4.2) composes the same functions, so a
// revocation means the same thing at queue time and at run time.
// ---------------------------------------------------------------------------

/**
 * Check 1 (+ the §3.2 actor form): the NPC exists in the view, is the
 * actor the record claims, is active, and belongs to the principal
 * city. `requireRoot` pins the traceability root: standing/delegated
 * resolutions require the mandate root; envelope work requires either.
 */
export function npcIdentityFailure(
  view: AuthorityView,
  actor: SimActor,
  principalCityId: string,
  requireRoot: "mandate" | "either"
): AuthorityFailure | null {
  const form = validateNpcActorForm(actor);
  if (!form.ok) {
    return { code: "ACTOR_FORM_INVALID", reason: form.violations.join("; ") };
  }
  const root = actorAuthorityRoot(actor);
  if (root === null) {
    return { code: "ACTOR_FORM_INVALID", reason: "actor cites no usable authority root" };
  }
  if (requireRoot === "mandate" && root.kind !== "mandate") {
    return {
      code: "ENVELOPE_ROOT_CANNOT_RESOLVE",
      reason:
        "an envelope root can never authorize a resolution (never-bind, invariant 2): " +
        "envelope output is advisory until the owner or a binding act confirms it as a new action",
    };
  }
  const npc = view.npc;
  if (npc === null) return { code: "NPC_NOT_FOUND", reason: "no NPC record in the evaluation view" };
  if (npc.npcId !== actor.npcId) {
    return { code: "NPC_MISMATCH", reason: `actor cites ${actor.npcId}, view holds ${npc.npcId}` };
  }
  if (actor.onBehalfOfMemberId !== npc.ownerUid) {
    return {
      code: "ACTOR_OWNER_MISMATCH",
      reason: `actor acts on behalf of ${actor.onBehalfOfMemberId}, but the NPC's owner is ${npc.ownerUid}`,
    };
  }
  if (npc.status !== "active") {
    return { code: "NPC_NOT_ACTIVE", reason: `NPC ${npc.npcId} is ${npc.status}` };
  }
  if (npc.cityId !== principalCityId) {
    return {
      code: "NPC_CITY_MISMATCH",
      reason: `NPC belongs to ${npc.cityId}, the attempt's principal city is ${principalCityId}`,
    };
  }
  return null;
}

export type OwnershipOutcome =
  | { kind: "ok" }
  | { kind: "reject"; failure: AuthorityFailure }
  | { kind: "draft-only"; reason: "shared-city-non-mayor" | "shared-city-vice-mayor"; detail: string };

/**
 * Check 2: current ownership still authorizes this NPC's owner.
 * Ordinary city: faction `ownerUids`. Shared city: the terms record —
 * mayor passes operationally, vice mayor and everyone else are
 * draft-only (their NPCs may explain and draft, never act).
 */
export function ownershipOutcome(
  npc: NpcRecord,
  principal: CityAuthorityContext | undefined
): OwnershipOutcome {
  if (principal === undefined) {
    return {
      kind: "reject",
      failure: { code: "CITY_NOT_IN_VIEW", reason: "principal city is absent from the evaluation view" },
    };
  }
  if (principal.isSharedCity) {
    if (principal.mayorUid === null) {
      return {
        kind: "reject",
        failure: {
          code: "SHARED_CITY_NO_TERMS",
          reason: "the shared city has no current terms record in the view — no operational authority exists to evaluate against",
        },
      };
    }
    if (npc.ownerUid === principal.mayorUid) return { kind: "ok" };
    if (principal.viceMayorUid !== null && npc.ownerUid === principal.viceMayorUid) {
      return {
        kind: "draft-only",
        reason: "shared-city-vice-mayor",
        detail:
          "the vice mayor leads Town Hall intervention and gains no operational authority (CJ round-3 ruling)",
      };
    }
    return {
      kind: "draft-only",
      reason: "shared-city-non-mayor",
      detail:
        "only the sitting mayor acts operationally for the shared city; other members' NPC activity there is explanatory/draft-only (brief §5.5)",
    };
  }
  if (!principal.ownerUids.includes(npc.ownerUid)) {
    return {
      kind: "reject",
      failure: {
        code: "OWNER_NO_LONGER_AUTHORIZES",
        reason: `${npc.ownerUid} no longer owns ${principal.cityId} (TC-N02a/N08: ownership is re-read at evaluation, never cached from the mandate)`,
      },
    };
  }
  return { kind: "ok" };
}

/**
 * Check 3: the cited mandate version is the root's current version and
 * is in force at `view.atSeq` — status, hash, effect, and both expiry
 * predicates (mandate.ts). Any failure is structural: the citation is
 * dead, and a queued thing citing it terminates `authority_changed`.
 */
export function mandateCurrencyFailure(
  view: AuthorityView,
  actor: SimActor
): AuthorityFailure | null {
  const root = actorAuthorityRoot(actor);
  if (root === null || root.kind !== "mandate") {
    return { code: "NO_MANDATE_ROOT", reason: "actor cites no mandate root" };
  }
  const mandateRoot = view.mandateRoot;
  if (mandateRoot === null) {
    return { code: "MANDATE_NOT_FOUND", reason: `no mandate root record for ${root.mandateId}` };
  }
  if (mandateRoot.mandateId !== root.mandateId) {
    return { code: "MANDATE_MISMATCH", reason: "view holds a different mandate root than the actor cites" };
  }
  if (view.npc !== null && mandateRoot.npcId !== view.npc.npcId) {
    return { code: "MANDATE_NPC_MISMATCH", reason: "the mandate belongs to a different NPC" };
  }
  if (mandateRoot.currentVersion !== root.mandateVersion) {
    return {
      code: "MANDATE_NOT_CURRENT",
      reason:
        `actor cites version ${root.mandateVersion}, the root's current version is ${mandateRoot.currentVersion} ` +
        "(a mode flip or scope change is a new version, P5-D3 — queued work never silently rides the new terms)",
    };
  }
  const version = view.mandateVersion;
  if (version === null) {
    return { code: "MANDATE_VERSION_NOT_FOUND", reason: "the cited version doc is absent from the view" };
  }
  if (version.mandateId !== root.mandateId || version.version !== root.mandateVersion) {
    return { code: "MANDATE_VERSION_MISMATCH", reason: "the version doc in the view is not the cited version" };
  }
  const state = mandateVersionState(version, view.atSeq, view.periodUsage);
  if (state !== "in-force") {
    const code =
      state === "revoked"
        ? "AUTHORITY_REVOKED"
        : state === "expired-seq" || state === "expired-horizon"
          ? "MANDATE_EXPIRED"
          : state === "hash-mismatch"
            ? "MANDATE_HASH_MISMATCH"
            : state === "superseded"
              ? "MANDATE_NOT_CURRENT"
              : "MANDATE_NOT_EFFECTIVE";
    return { code, reason: `cited mandate version is ${state} at seq ${view.atSeq}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// §5.3 scope & caps — evaluated under act-for-me only. Returns the named
// failures (empty = within scope) plus whether the failure includes a
// single-action money-cap excess (which refuses the whole action even
// when partial execution is otherwise allowed).
// ---------------------------------------------------------------------------

export function scopeCapFailures(
  version: MandateVersionRecord,
  attempt: DelegatedActionAttempt,
  view: AuthorityView
): { failures: string[]; singleActionMoneyExcess: boolean } {
  const scope = version.scope;
  const failures: string[] = [];
  let singleActionMoneyExcess = false;

  // (a) action type listed.
  if (!scope.allowedActionTypes.includes(attempt.actionType)) {
    failures.push(`actionType "${attempt.actionType}" is not in allowedActionTypes`);
  }
  // (b) named records and counterparties within the lists (subset semantics).
  for (const id of attempt.namedRecordIds) {
    if (!scope.namedRecordIds.includes(id)) {
      failures.push(`record "${id}" is not in namedRecordIds`);
    }
  }
  for (const id of attempt.counterpartyCityIds) {
    if (!scope.counterpartyCityIds.includes(id)) {
      failures.push(`counterparty city "${id}" is not in counterpartyCityIds`);
    }
  }
  // (c) per-action Rubar cap. No cap granted + movement = unlisted money.
  if (attempt.rubarMovement > 0) {
    if (scope.perActionRubars === null) {
      failures.push("Rubar movement with no per-action cap granted (unlisted money is never in scope)");
      singleActionMoneyExcess = true;
    } else if (attempt.rubarMovement > scope.perActionRubars) {
      failures.push(
        `per-action Rubar movement ${attempt.rubarMovement} exceeds the cap ${scope.perActionRubars}`
      );
      singleActionMoneyExcess = true;
    }
    // (d) per-period Rubar cap, counted from the Log by citation.
    if (scope.perPeriodRubars === null) {
      failures.push("Rubar movement with no per-period cap granted");
    } else if (view.periodUsage.delegatedRubars + attempt.rubarMovement > scope.perPeriodRubars) {
      failures.push(
        `period Rubar usage ${view.periodUsage.delegatedRubars} + ${attempt.rubarMovement} exceeds the period cap ${scope.perPeriodRubars}`
      );
    }
  }
  if (
    scope.perPeriodActions !== null &&
    view.periodUsage.delegatedResolutions + 1 > scope.perPeriodActions
  ) {
    failures.push(
      `period action count ${view.periodUsage.delegatedResolutions} already at the cap ${scope.perPeriodActions}`
    );
  }
  // (e) project phase ceiling.
  if (attempt.projectPhase !== null) {
    if (scope.maxProjectPhase === null) {
      failures.push("project advancement with no maxProjectPhase granted");
    } else if (attempt.projectPhase > scope.maxProjectPhase) {
      failures.push(
        `project phase ${attempt.projectPhase} exceeds maxProjectPhase ${scope.maxProjectPhase}`
      );
    }
  }
  // (f) negotiation output requires bounds on the mandate (spec §8.4 layer 1).
  if (attempt.negotiation !== null && scope.negotiationBounds === null) {
    failures.push("negotiation output with no negotiationBounds on the cited mandate version");
  }
  return { failures, singleActionMoneyExcess };
}

// ---------------------------------------------------------------------------
// The fairness fence (invariant 3; check slot 8 in the trace). A direct
// state change to a city the NPC's owner does not own is refused — no
// mandate scope can widen this, because an envelope/mandate can only
// ever carry its issuer's own authority. Read-collection is not
// alteration and never trips the fence.
// ---------------------------------------------------------------------------

export function fairnessFenceFailure(
  view: AuthorityView,
  npc: NpcRecord,
  attempt: DelegatedActionAttempt
): string | null {
  if (attempt.effectClass !== "state-change") return null;
  for (const targetCityId of attempt.targetCityIds) {
    if (targetCityId === attempt.cityId) continue;
    const target = view.cities.get(targetCityId);
    if (target === undefined) {
      return `target city "${targetCityId}" is absent from the evaluation view — its ownership cannot be proven, so the fence fails closed`;
    }
    if (target.isSharedCity) {
      return `direct state change to the shared city from another principal — shared-city acts run under the sitting mayor's authority only`;
    }
    if (!target.ownerUids.includes(npc.ownerUid)) {
      return `direct state change to "${targetCityId}", owned by ${target.ownerUids.join(", ") || "no one in the view"} — not by the NPC's owner ${npc.ownerUid} (sovereign canon is unreachable by delegation)`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The stage itself.
// ---------------------------------------------------------------------------

export function evaluateDelegatedAction(
  view: AuthorityView,
  actor: SimActor,
  attempt: DelegatedActionAttempt,
  trigger: AuthorityTrigger | null
): AuthorityVerdict {
  const checks: AuthorityCheckTrace[] = [];

  // -- Check 1: NPC identity + actor form --------------------------------
  const identity = npcIdentityFailure(view, actor, attempt.cityId, "mandate");
  if (identity !== null) {
    checks.push(trace(1, "npc-identity", "fail", identity.reason));
    return { disposition: "reject", code: identity.code, reason: identity.reason, checks };
  }
  checks.push(trace(1, "npc-identity", "pass", "NPC active, actor form valid, mandate root cited"));
  const npc = view.npc as NpcRecord;

  // -- Check 2: ownership / shared-city posture ---------------------------
  const ownership = ownershipOutcome(npc, view.cities.get(attempt.cityId));
  if (ownership.kind === "reject") {
    checks.push(trace(2, "ownership", "fail", ownership.failure.reason));
    return { disposition: "reject", code: ownership.failure.code, reason: ownership.failure.reason, checks };
  }
  if (ownership.kind === "draft-only") {
    checks.push(trace(2, "ownership", "fail", ownership.detail));
    return { disposition: "draft-only", reason: ownership.reason, detail: ownership.detail, checks };
  }
  checks.push(trace(2, "ownership", "pass", "current ownership authorizes the NPC's owner"));

  // -- Check 3: mandate currency ------------------------------------------
  const currency = mandateCurrencyFailure(view, actor);
  if (currency !== null) {
    checks.push(trace(3, "mandate-currency", "fail", currency.reason));
    return { disposition: "reject", code: currency.code, reason: currency.reason, checks };
  }
  checks.push(trace(3, "mandate-currency", "pass", "cited version is current, effective, unrevoked, unexpired"));
  const version = view.mandateVersion as MandateVersionRecord;

  // -- Fairness fence (invariant 3) ---------------------------------------
  const fence = fairnessFenceFailure(view, npc, attempt);
  if (fence !== null) {
    checks.push(trace(8, "fairness-fence", "fail", fence));
    return { disposition: "blocked-fairness", reason: fence, checks };
  }
  checks.push(
    trace(8, "fairness-fence", attempt.effectClass === "state-change" ? "pass" : "not-applicable",
      attempt.effectClass === "state-change" ? "no foreign state is directly altered" : "read-collection is not alteration")
  );

  // -- Check 4: mode, then scope/caps under act-for-me ---------------------
  const effectiveMode = narrowestMode(npc.permissionMode, version.mode, view.ruleMode);
  checks.push(
    trace(4, "mode", "pass",
      `effective mode ${effectiveMode} (npc snapshot ${npc.permissionMode}, version ${version.mode}` +
        (view.ruleMode !== null ? `, delegation rule ${view.ruleMode}` : "") +
        ") — narrowest wins (P5-D3)")
  );
  if (effectiveMode === "silent") {
    for (const n of [5, 6, 7]) checks.push(trace(n, "—", "not-applicable", "silent mode: no action to authorize"));
    return { disposition: "silence", checks };
  }
  if (effectiveMode === "ask-first") {
    for (const n of [5, 6, 7]) checks.push(trace(n, "—", "not-applicable", "ask-first: drafts and outputs only"));
    return {
      disposition: "draft-only",
      reason: "mode-ask-first",
      detail: "ask-first mode: the NPC drafts and outputs; the owner confirms any act personally",
      checks,
    };
  }
  const scopeResult = scopeCapFailures(version, attempt, view);
  if (scopeResult.failures.length > 0) {
    checks.push(trace(4, "scope-caps", "fail", scopeResult.failures.join("; ")));
    return {
      disposition: "escalate",
      failedCheck: "scope/caps (§5.3)",
      reason: `outside the cited mandate version's scope: ${scopeResult.failures.join("; ")}`,
      scopeFailures: scopeResult.failures,
      allowPartialExecution:
        version.scope.allowPartialExecution && !scopeResult.singleActionMoneyExcess,
      outOfBounds: [],
      checks,
    };
  }
  checks.push(trace(4, "scope-caps", "pass", "action type, targets, counterparties, caps, and phase all within the cited version"));

  // -- Check 5: trigger present and contemplated ---------------------------
  const rooted =
    trigger !== null &&
    ((trigger.kind === "owner-envelope" && trigger.envelopeId !== null) ||
      (trigger.kind === "delegated-action" && attempt.ownerConfirmedDelegated) ||
      (trigger.kind === "standing-routine" && trigger.routineName !== null) ||
      (trigger.sourceSeq !== null && trigger.sourceSeq < view.atSeq));
  if (!rooted) {
    checks.push(trace(5, "trigger", "fail", "no trigger rooted in a committed record, an envelope, or an owner-confirmed delegation"));
    return {
      disposition: "reject",
      code: "NO_TRIGGER_ROOT",
      reason: "the attempt cites no rooted trigger — nothing in the committed world asked for this act (causality rule)",
      checks,
    };
  }
  const triggerKind = (trigger as AuthorityTrigger).kind;
  if (!version.scope.triggerKinds.includes(triggerKind)) {
    checks.push(trace(5, "trigger", "fail", `trigger kind "${triggerKind}" is not in the mandate's triggerKinds`));
    return {
      disposition: "escalate",
      failedCheck: "trigger (check 5)",
      reason: `the mandate does not contemplate trigger kind "${triggerKind}"`,
      scopeFailures: [],
      allowPartialExecution: false,
      outOfBounds: [],
      checks,
    };
  }
  checks.push(trace(5, "trigger", "pass", `trigger kind "${triggerKind}" rooted and contemplated`));

  // P5-D5: prose/structured disagreement escalates, conflict named.
  if (attempt.proseStructuredConflict !== null) {
    return {
      disposition: "escalate",
      failedCheck: "prose/structured agreement (P5-D5)",
      reason: `generated prose disagrees with the structured action: ${attempt.proseStructuredConflict} — the structured form wins and nothing resolves until the owner sees the conflict`,
      scopeFailures: [],
      allowPartialExecution: false,
      outOfBounds: [],
      checks,
    };
  }

  // -- Check 6: Tier B / alwaysEscalate ------------------------------------
  const tier = classifyTierB(attempt);
  const escalateListed = version.scope.alwaysEscalate.includes(attempt.actionType);
  if (tier.tierB || escalateListed) {
    const via = [...tier.via, ...(escalateListed ? [`alwaysEscalate lists "${attempt.actionType}"`] : [])];
    checks.push(trace(6, "tier", "fail", `Tier B by ${via.join(", ")}`));
    return {
      disposition: "escalate",
      failedCheck: "tier (check 6)",
      reason: `Tier B always escalates (${via.join(", ")}) — the NPC prepares everything and stops`,
      scopeFailures: [],
      allowPartialExecution: false,
      outOfBounds: [],
      checks,
    };
  }
  checks.push(trace(6, "tier", "pass", "Tier A act, not in alwaysEscalate"));

  // -- Check 7: negotiation bounds diff -------------------------------------
  if (attempt.negotiation !== null && version.scope.negotiationBounds !== null) {
    const diff = diffNegotiationTerms(
      version.scope.negotiationBounds,
      attempt.negotiation.proposedTerms,
      attempt.negotiation.turnsUsed
    );
    if (!diff.withinBounds) {
      checks.push(trace(7, "negotiation-bounds", "fail", diff.violations.join("; ")));
      return {
        disposition: "escalate",
        failedCheck: "negotiation bounds (check 7)",
        reason: `proposed terms fail the mechanical bounds diff — they carry no mandate label (spec §8.4 layer 2)`,
        scopeFailures: [],
        allowPartialExecution: false,
        outOfBounds: diff.violations,
        checks,
      };
    }
    checks.push(trace(7, "negotiation-bounds", "pass", "proposed terms within the cited bounds"));
  } else {
    checks.push(trace(7, "negotiation-bounds", "not-applicable", "no negotiation output in this attempt"));
  }

  return {
    disposition: "resolve",
    citation: {
      kind: "mandate",
      mandateId: version.mandateId,
      mandateVersion: version.version,
      mode: effectiveMode,
    },
    checks,
  };
}
