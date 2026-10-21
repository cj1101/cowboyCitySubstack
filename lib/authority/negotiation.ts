/**
 * Negotiation bounds diff (spec v2 §8.4 layer 2; brief §5.2 check 7).
 *
 * The engine mechanically diffs proposed terms against the cited bounds
 * BEFORE the output may be labeled "within mandate". Out-of-bounds terms
 * are flagged OUT OF BOUNDS, the negotiation output fails with that
 * reason, and the terms carry no mandate label — the owner may still
 * pursue them as their own new action.
 *
 * The diff is deliberately only as mechanical as the records allow:
 * Rubar amounts are range-checked against same-kind mayOffer/mayAccept
 * entries; a term whose kind the bounds never mention is out of bounds;
 * a `walkAwayIf` entry fires on an exact text match (a free-text
 * condition has no other honest mechanical reading — anything fuzzier
 * would be a model judgment wearing a mechanical costume); the turn
 * budget is a count. Nothing here interprets prose.
 */

import type { NegotiationBounds, ProposedTerm } from "./types";

export interface NegotiationDiff {
  withinBounds: boolean;
  violations: string[];
}

function amountFits(
  entries: NegotiationBounds["mayOffer"],
  term: ProposedTerm
): boolean {
  const amount = term.amountRubars ?? null;
  for (const entry of entries) {
    if (entry.kind !== term.kind) continue;
    if (amount === null) {
      // A non-Rubar term fits a same-kind entry declared without amounts.
      if (entry.minAmount == null && entry.maxAmount == null) return true;
      continue;
    }
    if (entry.maxAmount != null && amount > entry.maxAmount) continue;
    if (entry.minAmount != null && amount < entry.minAmount) continue;
    return true;
  }
  return false;
}

export function diffNegotiationTerms(
  bounds: NegotiationBounds,
  proposedTerms: ProposedTerm[],
  turnsUsed: number
): NegotiationDiff {
  const violations: string[] = [];

  if (turnsUsed > bounds.maxTurns) {
    violations.push(
      `turn budget exceeded: ${turnsUsed} turns used, bounds allow ${bounds.maxTurns}`
    );
  }

  for (const term of proposedTerms) {
    if (term.text != null && bounds.walkAwayIf.includes(term.text)) {
      violations.push(
        `walk-away condition present in proposed terms: "${term.text}"`
      );
      continue;
    }
    const entries = term.side === "offer" ? bounds.mayOffer : bounds.mayAccept;
    if (!amountFits(entries, term)) {
      violations.push(
        `OUT OF BOUNDS: ${term.side} term of kind "${term.kind}"` +
          (term.amountRubars != null ? ` at ${term.amountRubars} Rubars` : "") +
          ` is outside the cited bounds`
      );
    }
  }

  return { withinBounds: violations.length === 0, violations };
}

/**
 * Subset test for the envelope fairness fence (brief §4.4/§2.5): an
 * envelope's negotiation bounds may never exceed the cited mandate
 * version's — narrower or equal on turns, and every Rubar ceiling the
 * envelope claims must exist in the mandate's bounds at a ceiling at
 * least as high. Returns the excesses (empty = within the fence).
 */
export function negotiationBoundsExcess(
  envelopeBounds: NegotiationBounds,
  mandateBounds: NegotiationBounds
): string[] {
  const excess: string[] = [];
  if (envelopeBounds.maxTurns > mandateBounds.maxTurns) {
    excess.push(
      `maxTurns ${envelopeBounds.maxTurns} exceeds the mandate's ${mandateBounds.maxTurns}`
    );
  }
  const checkSide = (
    envEntries: NegotiationBounds["mayOffer"],
    mandateEntries: NegotiationBounds["mayOffer"],
    side: string
  ): void => {
    for (const entry of envEntries) {
      if (entry.maxAmount == null) continue;
      const ceiling = mandateEntries
        .filter((m) => m.kind === entry.kind && m.maxAmount != null)
        .reduce<number | null>(
          (acc, m) => (acc === null ? m.maxAmount! : Math.max(acc, m.maxAmount!)),
          null
        );
      if (ceiling === null || entry.maxAmount > ceiling) {
        excess.push(
          `${side} ceiling for kind "${entry.kind}" (${entry.maxAmount}) exceeds the mandate's bounds`
        );
      }
    }
  };
  checkSide(envelopeBounds.mayOffer, mandateBounds.mayOffer, "mayOffer");
  checkSide(envelopeBounds.mayAccept, mandateBounds.mayAccept, "mayAccept");
  return excess;
}
