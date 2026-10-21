/**
 * Revocation semantics — what withdrawing authority does, and, just as
 * importantly, what it does NOT do.
 *
 * Revocation is effective from its Log seq. From that seq:
 *  - the revoked version is no longer current; the authority stage
 *    fails check 3 for anything citing it (evaluate.ts);
 *  - queued-but-unresolved delegated actions and claimed-but-unrun
 *    envelopes re-validate at execution time and terminate
 *    `authority_changed` (TC-N09) — see `executionTimeRevalidation`;
 *  - standing triggers stop matching: every wake's passes evaluate
 *    against current records, so there is nothing stale to fire.
 *
 * THE BOUNDARY (Nadia F-11, recorded — not papered over): revocation
 * reaches ACTIONS only. The landed committer's one authority re-check
 * (the `AUTHORITY_REVOKED` deterministic rejection, committer step 4)
 * exists only for member actions; ripenings copy their origin actor
 * VERBATIM (P2-K7, deliberate) — including mandate citations and
 * shared-office attribution — and apply their payloads with no
 * authority re-evaluation. That is correct for the EFFECT under Felix's
 * pre-commitment test (the commitment was made lawfully), and nothing
 * in this module changes it: `revocationReaches` returns false for
 * ripenings and pending effects, as a fact of the landed system.
 * Whether creating rules should attach an `origin-mandate-in-force`
 * precondition to high-value pendings is F-11's recommendation (2) — a
 * spec decision for the Phase 5/7 briefs. This module records the
 * boundary so no builder mistakes the action-path coverage for total
 * coverage; it does not invent the missing coverage.
 */

import type { SimActor } from "../sim/state";
import { actorAuthorityRoot } from "./actor";
import { mandateCurrencyFailure, npcIdentityFailure, type AuthorityFailure } from "./evaluate";
import type { AuthorityView } from "./types";

export type RevocationSubject =
  | "queued-action" // confirmed/queued, not yet resolved
  | "claimed-envelope" // claimed by a worker, not yet run
  | "standing-trigger" // a trigger that would match on a future wake
  | "ripening" // a pending ripening under a verbatim origin actor
  | "pending-effect" // any other not-yet-applied pending payload
  | "resolved-entry"; // already in the Log

/** Executable form of the boundary above. Actions: reached. Ripenings,
 * pending effects, resolved entries: NOT reached — by design of the
 * landed contracts (P2-K7 + committer step 4), restated in F-11. */
export const REVOCATION_COVERAGE: Readonly<Record<RevocationSubject, boolean>> = {
  "queued-action": true,
  "claimed-envelope": true,
  "standing-trigger": true,
  ripening: false,
  "pending-effect": false,
  "resolved-entry": false,
};

export function revocationReaches(subject: RevocationSubject): boolean {
  return REVOCATION_COVERAGE[subject];
}

export interface RevocationImpact {
  subject: RevocationSubject;
  reached: boolean;
  effect:
    | "terminate-authority-changed" // queued action / claimed envelope dies at revalidation
    | "stops-matching" // standing triggers simply never match again
    | "stands-verbatim"; // ripening/pending/resolved: applies as committed, origin attribution intact
  note: string;
}

export function evaluateRevocationImpact(subject: RevocationSubject): RevocationImpact {
  switch (subject) {
    case "queued-action":
    case "claimed-envelope":
      return {
        subject,
        reached: true,
        effect: "terminate-authority-changed",
        note: "execution-time revalidation (brief §4.2/§5.2) fails check 1–3 against post-revocation records; the item terminates authority_changed and the owner is told why",
      };
    case "standing-trigger":
      return {
        subject,
        reached: true,
        effect: "stops-matching",
        note: "wake passes evaluate current records each time; a revoked mandate matches nothing",
      };
    default:
      return {
        subject,
        reached: false,
        effect: "stands-verbatim",
        note:
          "AUTHORITY_REVOKED covers actions only (Nadia F-11): ripenings and pending effects carry their origin actor verbatim (P2-K7) and are not re-evaluated; " +
          "voiding one is a precondition/undo question for the creating rule and the Phase 7 brief, not a revocation effect",
      };
  }
}

// ---------------------------------------------------------------------------
// Execution-time revalidation (brief §4.2, TC-N09): the exact checks a
// queued action or claimed envelope re-runs against CURRENT records
// before it may proceed. A mandate revoked, a mode-relevant version
// superseded, an NPC retired, or an ownership change between queue and
// run lands here as `authority_changed` — never as a silent ride on
// stale terms.
// ---------------------------------------------------------------------------

export type RevalidationResult =
  | { ok: true }
  | { ok: false; code: "authority_changed"; failure: AuthorityFailure };

export function executionTimeRevalidation(
  view: AuthorityView,
  actor: SimActor,
  principalCityId: string
): RevalidationResult {
  const identity = npcIdentityFailure(view, actor, principalCityId, "either");
  if (identity !== null) return { ok: false, code: "authority_changed", failure: identity };
  const root = actorAuthorityRoot(actor);
  if (root !== null && root.kind === "mandate") {
    const currency = mandateCurrencyFailure(view, actor);
    if (currency !== null) return { ok: false, code: "authority_changed", failure: currency };
  }
  return { ok: true };
}
