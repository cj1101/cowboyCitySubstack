/**
 * Tier classification (brief §5.2 check 6; spec v2 §8.5).
 *
 * Tier B ALWAYS escalates — even when the action type also appears in a
 * mandate's allowed list, even when the mandate's prose claims "full
 * authority" (there is no such scope value; §8.5's classes are
 * structural). Tier A is whatever is not Tier B and survives scope/caps.
 *
 * Two inputs, both resolver-supplied, neither model-supplied:
 *  - the rule ids the attempt was classified under (registry truth), and
 *  - descriptor-assigned classes for the distinctions a rule id alone
 *    cannot carry (R-07 dissolve vs. expand; R-11 adopt vs. draft; R-19
 *    inhabited vs. not).
 */

import type { DelegatedActionAttempt } from "./types";

/** Descriptor classes that are Tier B by construction. */
export const TIER_B_CLASSES: ReadonlySet<string> = new Set([
  "binding-act", // signing/accepting agreements, treaties, verdicts, settlements
  "canon-adoption", // adopting canon or lore (R-11's adopt half)
  "contest-binding", // contest declarations/entries in the city's name
  "ballot", // casting ballots (R-22E) — personal acts, OPEN-4
  "destruction", // demolitions, R-18-class acts, inhabited mothballing
  "law-office", // passing/repealing law, taking/yielding office, tribunal positions
  "corporate-lifecycle", // founding/dissolving corporations (R-06, R-07-dissolve)
  "undo-execution", // executing an undo (TC-U06) — the owner undoes, personally
  "permission-grant", // granting R-29 permissions
]);

/**
 * Rule ids that are Tier B in every form the registry gives them.
 * Deliberately absent (form-dependent, carried by classes instead):
 * R-07 (only dissolution), R-11 (only adoption), R-19 (only inhabited),
 * R-27 (only initiation against a target the mandate does not name —
 * that is a scope failure, §5.3, and surfaces there).
 */
export const TIER_B_RULE_IDS: ReadonlySet<string> = new Set([
  "R-08", // pass a law / decree
  "R-09", // repeal a law
  "R-12", // sign a trade agreement
  "R-13", // break / let lapse a trade agreement (binding either way)
  "R-15", // Town Hall resolution (the shared city's binding acts)
  "R-16", // demolish an uninhabited structure
  "R-17", // demolish/damage an inhabited structure
  "R-18", // damage or attack another city
  "R-20", // declare / enter a contest
  "R-22E", // mayoral election & certification acts
  "R-23", // tribunal / Town Hall verdict
]);

export interface TierClassification {
  tierB: boolean;
  /** What made it Tier B (rule ids and/or classes), for the escalation. */
  via: string[];
}

export function classifyTierB(attempt: DelegatedActionAttempt): TierClassification {
  const via: string[] = [];
  for (const ruleId of attempt.ruleIds) {
    if (TIER_B_RULE_IDS.has(ruleId)) via.push(`rule ${ruleId}`);
  }
  for (const cls of attempt.classes) {
    if (TIER_B_CLASSES.has(cls)) via.push(`class ${cls}`);
  }
  return { tierB: via.length > 0, via };
}
