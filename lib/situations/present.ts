/**
 * Presentation contract for the Situations surfaces (Phase 5 brief
 * §6.2 + Petra spec §3) — pure functions only, no Firestore, so the
 * queue page, the situation card, the dashboard peek, and the export
 * builders all render the SAME words from the SAME shapes (Vera's
 * `lib/sim/situations.ts` / `lib/sim/delegation.ts` records).
 *
 * The contract this file exists to keep:
 *  - One queue per owner, faceted per city; a card always names its
 *    city; person-scoped items are badged personal.
 *  - Ordering is severity, then oldest first. Secondary sorts are
 *    display preferences only — they never change what a card IS.
 *  - Severity is a plain label and never changes with age; a
 *    30-day-old card looks like a new one apart from its created seq.
 *  - Silence is a first-class outcome with approved vocabulary only.
 *    The forbidden words — ignored, missed, overdue, failed to
 *    respond — appear nowhere in this file's copy, by construction.
 *  - Unknown kinds render on a generic card with all three handling
 *    decisions; `kind` is a bounded string, never an enum here.
 */

import type { SimSituation, SituationSeverity, SituationStatus } from "@/lib/sim/situations";
import type { SimDelegationRule } from "@/lib/sim/delegation";

/** The viewer's queue, before facets: non-terminal cards wait on
 * someone; terminal cards are history. */
export const WAITING_STATUSES: readonly SituationStatus[] = [
  "open",
  "awaiting_owner",
  "delegated",
];

export const HISTORY_STATUSES: readonly SituationStatus[] = [
  "handled",
  "silent",
  "superseded",
];

export function isWaiting(situation: SimSituation): boolean {
  return (WAITING_STATUSES as readonly string[]).includes(situation.status);
}

export function isHistory(situation: SimSituation): boolean {
  return (HISTORY_STATUSES as readonly string[]).includes(situation.status);
}

/** "Waiting on you" for the peek and the queue's first facet: a card
 * the OWNER must move — open, or a delegate's draft awaiting the
 * owner. A delegated card waits on the delegate, not the owner. */
export function waitsOnOwner(situation: SimSituation): boolean {
  return situation.status === "open" || situation.status === "awaiting_owner";
}

const SEVERITY_RANK: Record<SituationSeverity, number> = {
  major: 0,
  important: 1,
  routine: 2,
};

export function severityLabel(severity: SituationSeverity): string {
  switch (severity) {
    case "major":
      return "Major";
    case "important":
      return "Important";
    default:
      return "Routine";
  }
}

export type QueueSort = "severity-oldest" | "newest" | "city" | "kind";

/** The §6.2 default order: severity, then oldest first. The other
 * orders are owner display preferences (§6.2: "owner-selectable
 * secondary sorts are display prefs"), stored client-side only. */
export function sortQueue(
  situations: readonly SimSituation[],
  sort: QueueSort,
  cityName: (cityId: string | null) => string
): SimSituation[] {
  const seq = (s: SimSituation) => s.createdSeq ?? 0;
  const list = [...situations];
  const bySeverityThenOldest = (a: SimSituation, b: SimSituation) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    seq(a) - seq(b);
  switch (sort) {
    case "newest":
      return list.sort((a, b) => seq(b) - seq(a));
    case "city":
      return list.sort(
        (a, b) =>
          cityName(a.audienceCityId ?? a.cityId).localeCompare(
            cityName(b.audienceCityId ?? b.cityId)
          ) || bySeverityThenOldest(a, b)
      );
    case "kind":
      return list.sort(
        (a, b) => a.kind.localeCompare(b.kind) || bySeverityThenOldest(a, b)
      );
    default:
      return list.sort(bySeverityThenOldest);
  }
}

/** Human labels for the starting kinds (brief §6.1). Kinds are a
 * bounded open string — anything not listed here renders as itself,
 * on the generic card, with all three decisions (brief §6.2). */
const KIND_LABELS: Record<string, string> = {
  proposal: "Proposal",
  counteroffer: "Counter-offer",
  question: "Question",
  incident: "Incident",
  escalation: "Escalation",
  "ingestion-review": "Lore review",
  "election-due": "Election due",
  contest: "Contest event",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** The empty queue's whole message (§6.2, verbatim posture). */
export const EMPTY_QUEUE_MESSAGE = "Nothing is waiting on you.";

/**
 * The approved non-response record line (§6.2 / brief §8): a complete
 * outcome, stated plainly — "No response — 〈city〉's leader didn't
 * say anything (seq N)". Used on history cards and anywhere a silence
 * outcome is summarized.
 */
export function silenceRecordLine(cityName: string, seq: number | null): string {
  return seq !== null
    ? `No response — ${cityName}'s leader didn't say anything (seq ${seq}).`
    : `No response — ${cityName}'s leader didn't say anything.`;
}

/** Terminal-outcome line for a history card. */
export function outcomeLine(
  situation: SimSituation,
  cityName: (cityId: string | null) => string
): string {
  const city = cityName(situation.audienceCityId ?? situation.cityId);
  switch (situation.status) {
    case "silent":
      return `Closed as silent. ${silenceRecordLine(city, situation.resolvedSeq)}`;
    case "handled": {
      if (situation.handling?.outcomeVerb === "declined") {
        return "Closed as handled — declined by its owner. The draft binds nothing.";
      }
      const mode = situation.handling?.mode;
      if (mode === "delegated" || mode === "auto-delegated") {
        return "Closed as handled — by the NPC it was delegated to.";
      }
      return "Closed as handled — by its owner.";
    }
    case "superseded":
      return "Closed — a newer version of this matter replaced it.";
    default:
      return situation.status;
  }
}

/** Status chip text for a waiting card. Delegated and awaiting-owner
 * are postures of the same queue, not separate inboxes (§6.2). */
export function waitingStatusLine(situation: SimSituation): string | null {
  switch (situation.status) {
    case "awaiting_owner":
      return "A draft is waiting for your decision.";
    case "delegated":
      return situation.handling?.mode === "auto-delegated"
        ? "With an NPC, under one of your delegation rules."
        : "With an NPC you delegated it to.";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------
// Delegation rules (§7.4): every rule renders as a readable sentence.
// ---------------------------------------------------------------------

function listOrNone(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "any";
}

/**
 * The §7.4 rule sentence. Always-wait rules read as what they are —
 * a standing instruction that these matters wait for the owner —
 * and render FIRST in the panel (§7.4: "'Always wait for me'
 * rendered first and evaluated first").
 */
export function ruleSentence(
  rule: SimDelegationRule,
  names: {
    npcName?: (npcId: string) => string;
    cityName?: (cityId: string) => string;
  } = {}
): string {
  const kinds =
    rule.match.situationKinds.length > 0
      ? rule.match.situationKinds.map(kindLabel).join(", ")
      : "situations";
  if (rule.alwaysWait || rule.handler.mode === "wait-for-owner") {
    return `Always wait for me: ${kinds} in this city wait for my own decision.`;
  }
  const who = rule.handler.npcId
    ? (names.npcName?.(rule.handler.npcId) ?? `NPC ${rule.handler.npcId}`)
    : "one of my NPCs";
  const mode =
    rule.handler.mode === "act-for-me"
      ? "may act for me"
      : rule.handler.mode === "silent"
        ? "gives no response"
        : "drafts and waits for me";
  const parts = [`When a ${kinds} situation arrives`];
  if (rule.match.sourceKinds.length > 0) {
    parts.push(`from ${listOrNone(rule.match.sourceKinds)}`);
  }
  if (rule.match.counterpartyCityIds && rule.match.counterpartyCityIds.length > 0) {
    parts.push(
      `naming ${rule.match.counterpartyCityIds
        .map((id) => names.cityName?.(id) ?? id)
        .join(", ")}`
    );
  }
  if (rule.match.minRubars !== null || rule.match.maxRubars !== null) {
    const lo = rule.match.minRubars;
    const hi = rule.match.maxRubars;
    parts.push(
      lo !== null && hi !== null
        ? `between ${lo} and ${hi} Rubars`
        : lo !== null
          ? `of at least ${lo} Rubars`
          : `of at most ${hi} Rubars`
    );
  }
  if (typeof rule.caps.perActionRubars === "number") {
    parts.push(`capped at ${rule.caps.perActionRubars} Rubars per action`);
  }
  return `${parts.join(", ")} — ${who} ${mode}.`;
}

/** Panel ordering: always-wait rules first, then priority, then the
 * order they were authored (rule id as the stable tiebreak). */
export function sortRules(rules: readonly SimDelegationRule[]): SimDelegationRule[] {
  return [...rules].sort((a, b) => {
    const aw = Number(b.alwaysWait) - Number(a.alwaysWait);
    if (aw !== 0) return aw;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.ruleId.localeCompare(b.ruleId);
  });
}

/** The §7.2 evaluation order, as the panel's help text (§7.4: "§7.2
 * evaluation order displayed in help text"). */
export const RULE_EVALUATION_HELP =
  "How rules are matched, in order: 'Always wait for me' rules first; then a rule " +
  "that names this exact matter; then kind rules (an exact kind before a broader one); " +
  "then source rules; then the city default. The first match decides — a matter no rule " +
  "matches waits for you, and waiting is a complete outcome.";

/** A rule whose handler's mandate was revoked or superseded stops
 * matching and renders flagged (§7.4) — never a silent fall-through.
 * The surface checks the handler NPC's current mandate pointer
 * against the mandate the rule cites. */
export function ruleHandlerAuthorityChanged(
  rule: SimDelegationRule,
  handlerCurrentMandateId: string | null | undefined
): boolean {
  if (rule.alwaysWait || rule.handler.mode === "wait-for-owner") return false;
  if (!rule.handler.mandateId) return false;
  return handlerCurrentMandateId !== rule.handler.mandateId;
}

export const RULE_AUTHORITY_CHANGED_FLAG = "handler authority changed";
