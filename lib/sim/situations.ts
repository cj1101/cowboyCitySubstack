/**
 * Situations — the per-owner queue (Phase 5 brief §6; Dana §3.7 shapes;
 * Petra spec §3 presentation contract). This module is the pure layer:
 * doc builders, the dedupe/supersede discipline, handling-decision
 * payloads, terminal transitions, the §6.5 producer builders, the §6.4
 * `needsAttention` conversion, and the §8 silence commit shape. It owns
 * NO Firestore access and NO registry entries — the dispatcher/wake
 * (W2/W4) and the situation action handlers (W1/W2) compose these
 * pieces into Resolution Events; `firestore.rules` postures (W1) and
 * the gate suite (W6) consume the same shapes.
 *
 * INVARIANTS this module exists to hold:
 *  - Situations mint ONLY from occasions — a Resolution Event, or
 *    the ripening of a pending an earlier confirmed act created.
 *    Derived states (overdue, default-as-a-state, bank health,
 *    ladder states) never mint cards by themselves; where a derived
 *    state must reach a human it rides the card of the occasion
 *    that made it true, or waits for the next occasion and is
 *    stated in that card's detail, derived at creation from
 *    standing state. (Felix's governing distinction, banking
 *    addendum §1.0 — adopted verbatim as the producer discipline
 *    for every family, not only banking.)
 *  - A Situation is created ONLY inside a Resolution Event, by a
 *    producer (§6.5 + the ripening-occasion class below) or the
 *    §6.4 conversion — never from a clock, a view, or an age. No
 *    `overdue`/`expired`/age-escalated status exists in the status
 *    set, by construction (§6.1).
 *  - Duplicate source events update/supersede by `dedupeKey` rather
 *    than duplicating (§2.6): one open card per key, superseded cards
 *    remain in history, badged, not actionable.
 *  - Handling a Situation is a look and a decision, never the
 *    underlying act (§6.3): "handle myself" deep-links into the
 *    authoritative flow and the card is marked `handled` only by the
 *    transaction that logs that flow's resolution.
 *  - The §6.4 conversion is LINKED, NOT FUSED (P5-K8): it stamps
 *    exactly one field on the pending (`attentionSituationId`) and
 *    never touches `needsAttention`; handling the Situation never
 *    writes the pending at all. The flag clears only when the pending
 *    ripens, voids, or is otherwise lawfully resolved.
 *  - Silence is a logged outcome ONLY where a response was actually
 *    solicited (§8.2) — which is why the silence builder requires an
 *    existing Situation: a city that received no situation produces
 *    no entry, and non-events are not logged into existence.
 *
 * DETAIL CONVENTIONS (producer-stamped, read defensively here and in
 * delegation.ts): `detail` is the situation's structured payload. The
 * keys the Phase 5 machinery reads are `amountRubars` (integer|null),
 * `counterpartyCityId` (string|null), `tags` (string[]), `ruleIds`
 * (string[]) and `classes` (string[]) — the underlying act's Tier B
 * evidence, classified by lib/authority's single source — and
 * `delegatedAction` ({ actionType, structuredAction, targetCityIds }),
 * the concrete action an act-for-me fire resolves. Producers stamp
 * what they know; absence means "not applicable", never zero.
 *
 * SEQ STAMPING: docs created inside a Resolution Event carry
 * `createdSeq` = the creating event's summary seq. Plan-time builders
 * cannot know it, so callers pass it in, computed by the landed idiom
 * (lore.ts/defensive.ts): `snapshot.counterHead.lastSeq +
 * plan.entries.length` at the point the summary entry's position is
 * fixed. Pure previews pass null; a committed doc never carries null.
 */

import { canonicalJson, sha256HexOfText } from "./canonical";
import { ripeningFailureClass } from "./rules/pendingRules";
import { planWrite, ruleEffectDraft } from "./rules/planHelpers";
import {
  snapshotDoc,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimActor,
  type SimSnapshot,
} from "./state";

// ---------------------------------------------------------------------------
// Shape (brief §6.1 [FINAL], Dana §3.7)
// ---------------------------------------------------------------------------

export type SituationStatus =
  | "open"
  | "delegated"
  | "awaiting_owner"
  | "handled"
  | "silent"
  | "superseded";

export type SituationSeverity = "routine" | "important" | "major";

export type SituationSourceKind =
  | "log"
  | "treaty"
  | "task"
  | "ingestion"
  | "contest"
  | "manual-action"
  | "system";

export interface SituationSource {
  kind: SituationSourceKind;
  sourceId: string | null;
  sourceSeq: number | null;
  sourceResolutionId: string | null;
}

export interface SituationHandling {
  mode: "self" | "delegated" | "auto-delegated" | "silent" | null;
  decidedByUid: string | null;
  delegationRuleId: string | null;
  delegationRuleVersion: number | null;
  npcId: string | null;
  mandateId: string | null;
  mandateVersion: number | null;
  taskId: string | null;
  actionId: string | null;
  decidedAt: unknown;
  decisionNote: string | null;
  /** The §3.3/§6.1 outcome verb the decision carries, when it
   *  carries one ("declined" is wired today: handled-by-declining —
   *  the decision IS the flow's resolution). Null on every other
   *  handling record (absent ≡ null in stored pre-PR-4 docs). */
  outcomeVerb: string | null;
}

export interface SimSituation {
  situationId: string;
  /** The subject city the situation is about (null for person-scoped). */
  cityId: string | null;
  /** The durable audience key when ownership may change. */
  audienceCityId: string | null;
  /** Owners of the audience city at creation (display/routing only —
   *  read access follows CURRENT ownership, brief §6.1 reads). */
  audienceOwnerUidsSnapshot: string[];
  recipientUid: string | null;
  /** Bounded string, NOT a closed enum (§6.1): new kinds arrive from
   *  producing systems without schema migration. */
  kind: string;
  status: SituationStatus;
  severity: SituationSeverity;
  title: string;
  summary: string;
  detail: Record<string, unknown> | null;
  source: SituationSource;
  dedupeKey: string;
  createdSeq: number | null;
  createdAt: unknown;
  updatedAt: unknown;
  handling: SituationHandling | null;
  /** Incremented each time a delegate escalation returns the card to
   *  `open` (Petra spec §3.4B — the cycle is visible, never silent). */
  delegationCycleCount: number;
  resolvedSeq: number | null;
  resolvedByResolutionId: string | null;
}

/** The starting kind strings (§6.1). Informational only — membership
 *  is never a validity condition. */
export const STARTING_SITUATION_KINDS: readonly string[] = [
  "escalation",
  "proposal",
  "contest",
  "ingestion-review",
  "election-due",
  "incident",
  "question",
  "legal",
  "system",
];

/** "Bounded string" (§6.1) made concrete: a kind is 1–80 chars. The
 *  number is this module's build choice, cited for W1's rules caps. */
export const SITUATION_KIND_MAX_LENGTH = 80;

export function situationPath(situationId: string): string {
  return `sim_situations/${situationId}`;
}

export const TERMINAL_SITUATION_STATUSES: ReadonlySet<SituationStatus> = new Set([
  "handled",
  "silent",
  "superseded",
]);

export function isTerminalSituation(doc: Pick<SimSituation, "status">): boolean {
  return TERMINAL_SITUATION_STATUSES.has(doc.status);
}

export class SituationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SituationError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Dedupe (§2.6 / §6.1): hash of source kind + source ID + situation
// kind + city/recipient, over the canonical JSON regime (§2.7).
// ---------------------------------------------------------------------------

export interface DedupeKeyInput {
  sourceKind: SituationSourceKind;
  sourceId: string | null;
  situationKind: string;
  /** The audience key: audience city when present, else the subject
   *  city, else the recipient uid — "city/recipient" in Dana's order. */
  audienceKey: string | null;
}

export function dedupeKeyFor(input: DedupeKeyInput): string {
  return sha256HexOfText(
    canonicalJson({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      situationKind: input.situationKind,
      audienceKey: input.audienceKey,
    })
  );
}

/** The deterministic dedupe ID for a single-event source (§6.1): the
 *  same source event, re-fired, lands on the same doc ID — the
 *  structural half of the no-duplicates discipline (the upsert below
 *  is the behavioral half). The ID incorporates the source event's
 *  seq: a SUPERSEDING event for the same key (a Pattern X episode's
 *  next qualifying event; a source update) is a distinct event and
 *  must mint a distinct doc, or the supersede would fold into the
 *  old card's path and the history card would never land. With a
 *  null source seq the ID falls back to the key alone (degenerate:
 *  supersede then collides — planSituationUpsert refuses it loudly
 *  rather than folding silently). */
export function deterministicSituationId(
  dedupeKey: string,
  sourceSeq?: number | null
): string {
  return sourceSeq != null
    ? `sit_${dedupeKey.slice(0, 28)}_${sourceSeq}`
    : `sit_${dedupeKey.slice(0, 32)}`;
}

function audienceKeyOf(input: {
  audienceCityId: string | null;
  cityId: string | null;
  recipientUid: string | null;
}): string | null {
  return input.audienceCityId ?? input.cityId ?? input.recipientUid;
}

// ---------------------------------------------------------------------------
// The generic builder. Producer helpers (§6.5) fix the kind and the
// detail conventions; everything funnels through here so validation
// and the dedupe discipline exist exactly once.
// ---------------------------------------------------------------------------

export interface SituationCreateInput {
  /** Omit for a deterministic dedupe ID (single-event sources). */
  situationId?: string;
  cityId: string | null;
  audienceCityId: string | null;
  audienceOwnerUidsSnapshot: string[];
  recipientUid: string | null;
  kind: string;
  severity: SituationSeverity;
  title: string;
  summary: string;
  detail: Record<string, unknown> | null;
  source: SituationSource;
  /** The creating event's summary seq (see the header's seq idiom);
   *  null only in pure previews. */
  createdSeq: number | null;
  now: string;
}

function validateCreateInput(input: SituationCreateInput): void {
  if (typeof input.kind !== "string" || input.kind.length === 0) {
    throw new SituationError("SITUATION_KIND_REQUIRED", "a situation needs a non-empty kind string");
  }
  if (input.kind.length > SITUATION_KIND_MAX_LENGTH) {
    throw new SituationError(
      "SITUATION_KIND_TOO_LONG",
      `situation kind exceeds the ${SITUATION_KIND_MAX_LENGTH}-char bound (§6.1 bounded string)`
    );
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new SituationError("SITUATION_TITLE_REQUIRED", "a situation needs a title");
  }
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    throw new SituationError("SITUATION_SUMMARY_REQUIRED", "a situation needs a summary");
  }
  if (
    input.audienceCityId === null &&
    input.cityId === null &&
    input.recipientUid === null
  ) {
    throw new SituationError(
      "SITUATION_AUDIENCE_REQUIRED",
      "a situation needs an audience: a city (subject or audience) or a recipient uid — an unaudienced card is a card no one may read or handle"
    );
  }
}

export function buildSituationDoc(input: SituationCreateInput): SimSituation {
  validateCreateInput(input);
  const dedupeKey = dedupeKeyFor({
    sourceKind: input.source.kind,
    sourceId: input.source.sourceId,
    situationKind: input.kind,
    audienceKey: audienceKeyOf(input),
  });
  return {
    situationId:
      input.situationId ?? deterministicSituationId(dedupeKey, input.source.sourceSeq),
    cityId: input.cityId,
    audienceCityId: input.audienceCityId,
    audienceOwnerUidsSnapshot: [...input.audienceOwnerUidsSnapshot],
    recipientUid: input.recipientUid,
    kind: input.kind,
    status: "open",
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    detail: input.detail,
    source: { ...input.source },
    dedupeKey,
    createdSeq: input.createdSeq,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
    handling: null,
    delegationCycleCount: 0,
    resolvedSeq: null,
    resolvedByResolutionId: null,
  };
}

// ---------------------------------------------------------------------------
// Dedupe upsert (§6.1): "Duplicate source events update/supersede the
// existing OPEN situation for the key." The decision is pure; the
// caller materialized `existingOpen` (the open doc for the key, via
// its read plan) and applies the result with applySituationUpsert.
//
//  - no existing open doc            -> create
//  - existing, stale source seq      -> ignore (an out-of-order
//    re-fire must not rewind the card the owner may already hold)
//  - existing, same source seq and materially identical payload
//                                    -> refresh (updatedAt only — a
//    true duplicate fire changes nothing else, §6.2's "opening a
//    card changes nothing" discipline applied to producers)
//  - existing, newer source seq or materially changed payload
//                                    -> supersede-and-create: the old
//    card stays in history badged `superseded`; the new card is the
//    actionable one. Materiality is judged over title/summary/
//    detail/severity by canonical equality.
// ---------------------------------------------------------------------------

export type SituationUpsertDecision =
  | { action: "create"; doc: SimSituation }
  | { action: "refresh"; doc: SimSituation }
  | { action: "supersede-and-create"; doc: SimSituation; supersededDoc: SimSituation }
  | { action: "ignore"; existing: SimSituation };

function materiallyEqual(a: SimSituation, b: SimSituation): boolean {
  const projection = (s: SimSituation) => ({
    title: s.title,
    summary: s.summary,
    detail: s.detail,
    severity: s.severity,
  });
  return canonicalJson(projection(a)) === canonicalJson(projection(b));
}

export function planSituationUpsert(
  existingForKey: SimSituation | null,
  input: SituationCreateInput
): SituationUpsertDecision {
  const fresh = buildSituationDoc(input);
  if (existingForKey === null) return { action: "create", doc: fresh };
  if (existingForKey.dedupeKey !== fresh.dedupeKey) {
    throw new SituationError(
      "DEDUPE_KEY_MISMATCH",
      "planSituationUpsert was handed an existing doc whose dedupeKey differs from the input's — the caller's read plan materialized the wrong card"
    );
  }
  if (existingForKey.status !== "open") {
    // A terminal namesake is HISTORY for the same source event. The
    // fresh doc would carry the same deterministic ID, so "creating"
    // it would clobber the history card — the source event already
    // produced its card and the re-fire is a duplicate, full stop.
    return { action: "ignore", existing: existingForKey };
  }
  const existingOpen = existingForKey;
  const existingSeq = existingOpen.source.sourceSeq;
  const freshSeq = fresh.source.sourceSeq;
  if (existingSeq !== null && freshSeq !== null && freshSeq < existingSeq) {
    return { action: "ignore", existing: existingOpen };
  }
  if (materiallyEqual(existingOpen, fresh) && existingSeq === freshSeq) {
    return {
      action: "refresh",
      doc: { ...existingOpen, updatedAt: new Date(input.now) },
    };
  }
  if (fresh.situationId === existingOpen.situationId) {
    // Same deterministic ID but a different payload: the source
    // event re-fired with corrected content and no seq to
    // distinguish the correction (null source seqs). Folding this
    // into one path would silently rewrite the open card and lose
    // the superseded history — refuse loudly instead; the producer
    // must stamp a source seq or an explicit situation id.
    throw new SituationError(
      "DEDUPE_SUPERSEDE_COLLISION",
      "a superseding situation would land on the existing card's deterministic ID — the producer must stamp a source seq (or an explicit situationId) so the superseded card remains in history"
    );
  }
  return {
    action: "supersede-and-create",
    doc: fresh,
    supersededDoc: {
      ...existingOpen,
      status: "superseded",
      resolvedSeq: input.createdSeq,
      resolvedByResolutionId: input.source.sourceResolutionId,
      updatedAt: new Date(input.now),
    },
  };
}

/** Fold an upsert decision into a plan (one write per path, F-02
 *  discipline via planWrite). Situation effects are claimed the
 *  landed way for top-level records — recordsCreated/recordsUpdated
 *  on the event's entries + the manifest write set — NOT via
 *  changes[]: validatePlan's F-02 grammar resolves change fields
 *  only inside the entry city's doc tree, so a change claiming a
 *  `sim_situations` field would reconcile with no write (the lore
 *  module's wiki-entry entries are the precedent). The returned id
 *  lists are exactly what the caller's entry should claim. */
export function applySituationUpsert(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  decision: SituationUpsertDecision
): { created: string[]; updated: string[]; superseded: string[] } {
  const out = { created: [] as string[], updated: [] as string[], superseded: [] as string[] };
  if (decision.action === "ignore") return out;
  if (decision.action === "supersede-and-create") {
    const old = decision.supersededDoc;
    planWrite(plan, snapshot, situationPath(old.situationId), old as unknown as Record<string, unknown>, "state", ["status", "resolvedSeq", "resolvedByResolutionId", "updatedAt"]);
    out.superseded.push(old.situationId);
  }
  const doc = decision.doc;
  const isCreate = decision.action === "create" || decision.action === "supersede-and-create";
  planWrite(plan, snapshot, situationPath(doc.situationId), doc as unknown as Record<string, unknown>, "state",
    isCreate ? ["status", "kind", "source", "dedupeKey"] : ["updatedAt"]);
  if (isCreate) out.created.push(doc.situationId);
  else out.updated.push(doc.situationId);
  return out;
}

// ---------------------------------------------------------------------------
// Handling decisions (§6.3) and transitions. The three owner decisions
// are payloads + doc transitions here; the AUTHORITATIVE acts they
// point at live in their own flows (deal room, adoption preview,
// election flow) and in the resolver — a transition in this module
// never performs an underlying act.
// ---------------------------------------------------------------------------

function assertActionable(doc: SimSituation, what: string): void {
  if (isTerminalSituation(doc)) {
    throw new SituationError(
      "SITUATION_TERMINAL",
      `${what}: situation ${doc.situationId} is already ${doc.status} — terminal cards never return (§6.2)`
    );
  }
}

export interface HandlingTransition {
  doc: SimSituation;
  /** The top-level fields the transition wrote — the caller's
   *  planWrite changedFields (see applySituationUpsert's note on
   *  why situation effects are not entry changes[]). */
  changedFields: string[];
}

/** §6.3A — "handle myself": records the owner's decision and links
 *  the authoritative flow (via decisionNote / the caller's deep-link
 *  context). The card stays `open`: it is marked `handled` only by
 *  markSituationHandled inside the transaction that logs the flow's
 *  own resolution. */
export function recordSelfHandling(
  doc: SimSituation,
  decision: {
    decidedByUid: string;
    decidedAt: string;
    decisionNote?: string | null;
    outcomeVerb?: string | null;
  }
): HandlingTransition {
  assertActionable(doc, "record self-handling");
  const after: SimSituation = {
    ...doc,
    handling: {
      mode: "self",
      decidedByUid: decision.decidedByUid,
      delegationRuleId: null,
      delegationRuleVersion: null,
      npcId: null,
      mandateId: null,
      mandateVersion: null,
      taskId: null,
      actionId: null,
      decidedAt: new Date(decision.decidedAt),
      decisionNote: decision.decisionNote ?? null,
      outcomeVerb: decision.outcomeVerb ?? null,
    },
    updatedAt: new Date(decision.decidedAt),
  };
  // §6.3A: the owner takes the card into the authoritative flow; the
  // situation completes only when that flow's resolution lands
  // (markSituationHandled).
  return { doc: after, changedFields: ["handling", "updatedAt"] };
}

/** §6.3B — delegate to a character or NPC, owner-directed (the
 *  auto-delegated form is delegation.ts's rule fire). `effectiveMode`
 *  is the narrower-of resolution the caller computed (delegation.ts's
 *  resolveDelegationAuthority): act-for-me proceeds (`delegated`);
 *  ask-first drafts and stops (`awaiting_owner`); silent refuses —
 *  the UI states the reason, and the action flow surfaces this error
 *  rather than recording a delegation that cannot act. */
export function recordDelegation(
  doc: SimSituation,
  decision: {
    decidedByUid: string;
    decidedAt: string;
    npcId: string;
    mandateId: string | null;
    mandateVersion: number | null;
    effectiveMode: "act-for-me" | "ask-first" | "silent";
    /** The one-off envelope, when the owner tasks instead of citing
     *  a standing mandate (§6.3B). */
    taskId?: string | null;
    /** The delegated action, once the fire step creates it. */
    actionId?: string | null;
    autoDelegated?: boolean;
    delegationRuleId?: string | null;
    delegationRuleVersion?: number | null;
    decisionNote?: string | null;
  }
): HandlingTransition {
  assertActionable(doc, "record delegation");
  if (decision.effectiveMode === "silent") {
    throw new SituationError(
      "DELEGATE_TO_SILENT_NPC",
      `NPC ${decision.npcId} is in silent mode — delegation to it is refused (§6.3B); the owner handles the card or picks another handler`
    );
  }
  const mode = decision.autoDelegated ? "auto-delegated" : "delegated";
  const status: SituationStatus =
    decision.effectiveMode === "ask-first" ? "awaiting_owner" : "delegated";
  const after: SimSituation = {
    ...doc,
    status,
    handling: {
      mode,
      decidedByUid: decision.decidedByUid,
      delegationRuleId: decision.delegationRuleId ?? null,
      delegationRuleVersion: decision.delegationRuleVersion ?? null,
      npcId: decision.npcId,
      mandateId: decision.mandateId,
      mandateVersion: decision.mandateVersion,
      taskId: decision.taskId ?? null,
      actionId: decision.actionId ?? null,
      decidedAt: new Date(decision.decidedAt),
      decisionNote: decision.decisionNote ?? null,
      outcomeVerb: null,
    },
    updatedAt: new Date(decision.decidedAt),
  };
  // §2.4/§6.3B: an ask-first delegate drafts and stops (the card
  // awaits the owner's confirmation); an act-for-me delegate holds
  // the card inside the cited mandate, and Tier B mid-handling
  // returns it as an escalation (returnSituationToOpen).
  return { doc: after, changedFields: ["status", "handling", "updatedAt"] };
}

/** A delegate escalation returns the SAME card to `open` (§6.2/§6.3B):
 *  the prepared work stays attached (the caller names it in
 *  `decisionNote`/detail via the escalation producer), the cycle
 *  count increments — visible, never a silent loop (Petra §3.4B). */
export function returnSituationToOpen(
  doc: SimSituation,
  opts: { decidedAt: string; reason: string; failedCheck?: string | null }
): HandlingTransition {
  assertActionable(doc, "return to open");
  if (doc.status !== "delegated" && doc.status !== "awaiting_owner") {
    throw new SituationError(
      "SITUATION_NOT_DELEGATED",
      `return-to-open applies to a delegated card; situation ${doc.situationId} is ${doc.status}`
    );
  }
  const after: SimSituation = {
    ...doc,
    status: "open",
    delegationCycleCount: doc.delegationCycleCount + 1,
    handling: {
      ...(doc.handling ?? {
        mode: null,
        decidedByUid: null,
        delegationRuleId: null,
        delegationRuleVersion: null,
        npcId: null,
        mandateId: null,
        mandateVersion: null,
        taskId: null,
        actionId: null,
        decidedAt: null,
        decisionNote: null,
        outcomeVerb: null,
      }),
      // A returned card carries no outcome verb: it was not decided,
      // it came back (a stale verb would misread as a decision).
      outcomeVerb: null,
      decidedAt: new Date(opts.decidedAt),
      decisionNote: opts.failedCheck
        ? `Escalated back to the owner (${opts.failedCheck}): ${opts.reason}`
        : `Escalated back to the owner: ${opts.reason}`,
    },
    updatedAt: new Date(opts.decidedAt),
  };
  // §6.3B/§5.5 + Petra §3.4B: the same card returns to the owner
  // and the cycle is counted on it, never a silent loop.
  return {
    doc: after,
    changedFields: ["status", "delegationCycleCount", "handling", "updatedAt"],
  };
}

/** The terminal `handled` transition (§6.3A): called ONLY by the
 *  transaction that logs the handling flow's resolution — the seq and
 *  resolution id are that event's. */
export function markSituationHandled(
  doc: SimSituation,
  opts: { resolvedSeq: number; resolvedByResolutionId: string; decidedAt: string }
): HandlingTransition {
  assertActionable(doc, "mark handled");
  const after: SimSituation = {
    ...doc,
    status: "handled",
    resolvedSeq: opts.resolvedSeq,
    resolvedByResolutionId: opts.resolvedByResolutionId,
    updatedAt: new Date(opts.decidedAt),
  };
  // §6.3A (Dana §7 atomicity): the fabric marks the situation
  // handled in the same transaction that logs the resolution.
  return {
    doc: after,
    changedFields: ["status", "resolvedSeq", "resolvedByResolutionId", "updatedAt"],
  };
}

// ---------------------------------------------------------------------------
// §6.5 producers in scope at Phase 5 ship. Each fixes its kind and its
// detail conventions and funnels through buildSituationDoc. Severity
// is the producing event's class call (§6.1: assigned at creation
// from the causing event's class — the `major` flag twin), passed in
// explicitly by the producing handler, never derived from age/views.
// ---------------------------------------------------------------------------

interface ProducerBase {
  cityId: string | null;
  audienceCityId: string | null;
  audienceOwnerUidsSnapshot: string[];
  recipientUid?: string | null;
  severity: SituationSeverity;
  createdSeq: number | null;
  now: string;
  sourceSeq: number | null;
  sourceResolutionId: string | null;
}

/** NPC Tier B escalations + authority failures (§5.5). The detail
 *  carries the attempt's Tier B evidence (`ruleIds`/`classes`) so the
 *  card — and any later re-delegation — classifies off the same
 *  single source (lib/authority) as the stage that produced it. */
export function buildEscalationSituation(
  input: ProducerBase & {
    npcId: string;
    mandateId: string | null;
    mandateVersion: number | null;
    failedCheck: string;
    actionType: string;
    ruleIds: string[];
    classes: string[];
    via: string[];
    preparedDraftRef: string | null;
    title: string;
    summary: string;
  }
): SimSituation {
  return buildSituationDoc({
    cityId: input.cityId,
    audienceCityId: input.audienceCityId,
    audienceOwnerUidsSnapshot: input.audienceOwnerUidsSnapshot,
    recipientUid: input.recipientUid ?? null,
    kind: "escalation",
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    detail: {
      npcId: input.npcId,
      mandateId: input.mandateId,
      mandateVersion: input.mandateVersion,
      failedCheck: input.failedCheck,
      actionType: input.actionType,
      ruleIds: input.ruleIds,
      classes: input.classes,
      via: input.via,
      preparedDraftRef: input.preparedDraftRef,
    },
    source: {
      kind: "log",
      sourceId: input.sourceResolutionId,
      sourceSeq: input.sourceSeq,
      sourceResolutionId: input.sourceResolutionId,
    },
    createdSeq: input.createdSeq,
    now: input.now,
  });
}

/** The episode source ID for Pattern X cards (banking addendum
 *  §1.1): subject key + episode discriminator, e.g.
 *  `bank:<corporationId>:failed-payment`. The dedupeKey derived from
 *  it is what makes "never two open episode cards of one class for
 *  one subject" structural: every qualifying event for the episode
 *  keys to the same card, and the upsert accumulates. */
export function episodeSourceId(subjectKey: string, episodeClass: string): string {
  return `${subjectKey}:${episodeClass}`;
}

/** Resolver spillover (§6.5, GAP-2 widened): consequences stated as
 *  ALREADY RESOLVED, asks stated explicitly — the card informs and
 *  requests; it never re-opens the event that caused it. The class
 *  covers events naming a city OR a chartered bank/corporation and
 *  its counterparties (banking addendum GAP-2, ruled in W3): the
 *  subject is stamped in detail, and recipients are addressed per
 *  §6.1 (a member by recipientUid; a city by audienceCityId).
 *
 *  Two dedupe forms ride this builder (banking addendum §1.1):
 *  Pattern E (default) — one card per (event, recipient), source =
 *  the event's Log entry. Pattern X (`episode` given) — an episode
 *  card keyed to a standing condition's subject + discriminator;
 *  subsequent qualifying events update/supersede the open card with
 *  detail accumulated from standing state at creation, and the
 *  curing/closing event terminals it. */
export function buildIncidentSituation(
  input: ProducerBase & {
    title: string;
    summary: string;
    consequenceSummary: string;
    ask: string;
    amountRubars?: number | null;
    counterpartyCityId?: string | null;
    /** The event's subject when it is not simply the card's city —
     *  a chartered bank/corporation subject is stamped here. */
    subject?: { kind: "city" | "corporation"; id: string } | null;
    /** Pattern X keying (see above). */
    episode?: { subjectKey: string; episodeClass: string } | null;
  }
): SimSituation {
  return buildSituationDoc({
    cityId: input.cityId,
    audienceCityId: input.audienceCityId,
    audienceOwnerUidsSnapshot: input.audienceOwnerUidsSnapshot,
    recipientUid: input.recipientUid ?? null,
    kind: "incident",
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    detail: {
      consequenceSummary: input.consequenceSummary,
      ask: input.ask,
      amountRubars: input.amountRubars ?? null,
      counterpartyCityId: input.counterpartyCityId ?? null,
      subject: input.subject ?? null,
    },
    source: input.episode
      ? {
          kind: "system",
          sourceId: episodeSourceId(input.episode.subjectKey, input.episode.episodeClass),
          sourceSeq: input.sourceSeq,
          sourceResolutionId: input.sourceResolutionId,
        }
      : {
          kind: "log",
          sourceId: input.sourceResolutionId,
          sourceSeq: input.sourceSeq,
          sourceResolutionId: input.sourceResolutionId,
        },
    createdSeq: input.createdSeq,
    now: input.now,
  });
}

/** Cross-city proposal cards (§6.5, from the proposal/adoption
 *  machinery): the counterparty and any money ride in detail (the
 *  delegation matcher's inputs), and where accepting the proposal is
 *  a binding act the producer stamps the Tier B evidence
 *  (`ruleIds`/`classes`) so an act-for-me rule can never quietly
 *  accept it — the composer guardrail and the evaluator read the
 *  same classification. */
export function buildProposalSituation(
  input: ProducerBase & {
    sourceKind: "treaty" | "log" | "manual-action";
    sourceId: string | null;
    title: string;
    summary: string;
    counterpartyCityId: string;
    amountRubars?: number | null;
    tags?: string[];
    ruleIds?: string[];
    classes?: string[];
    proposalRef?: string | null;
  }
): SimSituation {
  return buildSituationDoc({
    cityId: input.cityId,
    audienceCityId: input.audienceCityId,
    audienceOwnerUidsSnapshot: input.audienceOwnerUidsSnapshot,
    recipientUid: input.recipientUid ?? null,
    kind: "proposal",
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    detail: {
      counterpartyCityId: input.counterpartyCityId,
      amountRubars: input.amountRubars ?? null,
      tags: input.tags ?? [],
      ruleIds: input.ruleIds ?? [],
      classes: input.classes ?? [],
      proposalRef: input.proposalRef ?? null,
    },
    source: {
      kind: input.sourceKind,
      sourceId: input.sourceId,
      sourceSeq: input.sourceSeq,
      sourceResolutionId: input.sourceResolutionId,
    },
    createdSeq: input.createdSeq,
    now: input.now,
  });
}

// ---------------------------------------------------------------------------
// §6.4 — the `needsAttention` conversion (Phase 2 debt, discharged
// here). The pending doc fields read here are the landed Phase 2
// shape (rules/pendingRules.ts buildPendingDraft + pending.ts's
// claim-release bookkeeping): `pendingId`, `kind`, `originCityId`,
// `originSeq`, `originResolutionId`, `attempts`, `needsAttention`,
// `lastFailure { code }`, and the ONE additive field this conversion
// stamps, `attentionSituationId`.
// ---------------------------------------------------------------------------

/** The structural view of a pending doc this conversion reads. */
export interface AttentionPendingView {
  pendingId: string;
  kind: string;
  originCityId: string | null;
  originSeq: number | null;
  originResolutionId: string | null;
  attempts: number;
  needsAttention: boolean;
  lastFailure: { code: string } | null;
  attentionSituationId?: string | null;
}

export interface AttentionConversion {
  situation: SimSituation;
  /** The ONLY field the conversion writes on the pending (P5-K8 —
   *  linked, not fused): the link stamp. `needsAttention` is not a
   *  key of this object, by construction. */
  pendingPatch: { attentionSituationId: string };
}

/** Convert ONE flagged pending to its `system` Situation, or return
 *  null when there is nothing to convert (flag unset, or the link
 *  stamp already present — re-runs never duplicate, §6.4.1). Used by
 *  BOTH the first-wake backfill and the steady state (§6.4.2: the
 *  failure path calls this in the same step that sets the flag at
 *  attempt 3 — attempts 1–2 set no flag, so this returns null and
 *  nothing is created; the silent retry discipline is preserved by
 *  the flag itself, not by a counter here). */
export function planAttentionConversion(
  pending: AttentionPendingView,
  ctx: { originOwnerUids: string[]; createdSeq: number | null; now: string }
): AttentionConversion | null {
  if (pending.needsAttention !== true) return null;
  if (pending.attentionSituationId != null) return null;
  const failureCode = pending.lastFailure?.code ?? null;
  const failureClass = failureCode ? ripeningFailureClass(failureCode) : null;
  const situation = buildSituationDoc({
    cityId: pending.originCityId,
    audienceCityId: pending.originCityId,
    audienceOwnerUidsSnapshot: ctx.originOwnerUids,
    recipientUid: null,
    kind: "system",
    // A generation failure that exhausted its retries is the owner's
    // to look at, but it is not a `major` world event — major is the
    // causing event's Discord-eligible class (§6.1), and a pending's
    // failure is bookkeeping about a consequence, not the event.
    severity: "important",
    title: `A delayed consequence needs a look — ${pending.kind}`,
    summary:
      `Pending ${pending.pendingId} (kind ${pending.kind}, from seq ${pending.originSeq ?? "?"}) ` +
      `failed to ripen ${pending.attempts} time${pending.attempts === 1 ? "" : "s"}` +
      (failureClass ? ` — failure class ${failureClass}${failureCode ? ` (${failureCode})` : ""}` : "") +
      `. The pending itself is unchanged and still pending; resolving the underlying problem is its own later action.`,
    detail: {
      pendingId: pending.pendingId,
      pendingKind: pending.kind,
      originSeq: pending.originSeq,
      originResolutionId: pending.originResolutionId,
      attempts: pending.attempts,
      failureCode,
      failureClass,
    },
    source: {
      kind: "system",
      sourceId: pending.pendingId,
      sourceSeq: pending.originSeq,
      sourceResolutionId: pending.originResolutionId,
    },
    createdSeq: ctx.createdSeq,
    now: ctx.now,
  });
  // The link stamp is read off the built card — the deterministic ID
  // has exactly one computation (buildSituationDoc's), so the stamp
  // can never diverge from the doc it names.
  return { situation, pendingPatch: { attentionSituationId: situation.situationId } };
}

/** The first-wake backfill (§6.4.1) as a pure planner: the wake step
 *  materializes flagged pendings (`needsAttention == true &&
 *  attentionSituationId == null` — planAttentionConversion re-checks
 *  both) and applies what this returns. One Situation per flagged
 *  pending, audience = origin city/owner. */
export function planAttentionBackfill(
  pendings: AttentionPendingView[],
  ctxFor: (pending: AttentionPendingView) => {
    originOwnerUids: string[];
    createdSeq: number | null;
    now: string;
  }
): AttentionConversion[] {
  const out: AttentionConversion[] = [];
  for (const pending of pendings) {
    const conversion = planAttentionConversion(pending, ctxFor(pending));
    if (conversion) out.push(conversion);
  }
  return out;
}

// ---------------------------------------------------------------------------
// §8 — Silence, the non-response commit (Dana §7.7). Module layer:
// the actor resolution and the commit shape. The committer appends
// the ONE entry and lands the situation's `silent` transition in the
// same transaction (§8.1); this builder produces exactly those two
// artifacts and nothing else — `changes: []` on the entry, and the
// situation doc is the plan's only write, so the §8.1(3) state-hash
// property (no authoritative state moves) holds by construction.
// ---------------------------------------------------------------------------

export type SilenceProducingMode =
  | "owner-explicit"
  | "npc-silent-mode"
  | "no-permission"
  | "silence-rule";

export interface SilenceCommitInput {
  situation: SimSituation;
  producingMode: SilenceProducingMode;
  /** The accountable owner of the situation's audience (the member
   *  whose non-response this is). */
  ownerUid: string;
  /** The responding NPC, where one was evaluated (silent mode / no
   *  permission / silence-rule handler). */
  npcId?: string | null;
  mandateId?: string | null;
  mandateVersion?: number | null;
  /** The rule that routed here, for `silence-rule`. */
  delegationRuleId?: string | null;
  delegationRuleVersion?: number | null;
  /** Display name for the approved phrasing (§6.2 copy rule). */
  cityName: string;
  /** The creating event's summary seq + resolution id (header idiom),
   *  stamped as the situation's resolved seq. */
  resolvedSeq: number;
  resolvedByResolutionId: string;
  now: string;
}

/** §8.1 actor resolution. Owner for explicit stay-silent; the NPC
 *  (with mandate citation) where an NPC's posture produced it; where
 *  NO team exists at all, the city-owner member record with
 *  `no-permission` (P5-K9 — there is no NPC to attribute to, and a
 *  `system` actor would misattribute a player's non-act to the
 *  platform). */
export function silenceActorFor(input: SilenceCommitInput): SimActor {
  const memberActor: SimActor = {
    type: "member",
    memberId: input.ownerUid,
    npcId: null,
    onBehalfOfMemberId: null,
    mandateId: null,
    mandateVersion: null,
    envelopeId: null,
  };
  if (input.producingMode === "owner-explicit") return memberActor;
  if (input.npcId) {
    return {
      type: "npc",
      memberId: null,
      npcId: input.npcId,
      onBehalfOfMemberId: input.ownerUid,
      mandateId: input.mandateId ?? null,
      mandateVersion: input.mandateVersion ?? null,
      envelopeId: null,
    };
  }
  // No NPC was evaluated — including the P5-K9 teamless case: the
  // non-response belongs to the owner member record.
  return memberActor;
}

/** The approved phrasing (§6.2): the words *ignored, missed, overdue,
 *  failed to respond* never appear for silence. */
export function silenceSummaryText(cityName: string, triggerSeq: number | null): string {
  return `No response — ${cityName}'s leader didn't say anything (seq ${triggerSeq ?? "?"})`;
}

export interface SilenceCommit {
  situationAfter: SimSituation;
  entry: LogEntryDraft;
  changedFields: string[];
}

export function buildSilenceCommit(input: SilenceCommitInput): SilenceCommit {
  const { situation } = input;
  assertActionable(situation, "silence commit");
  const actor = silenceActorFor(input);
  const triggerSeq = situation.source.sourceSeq ?? situation.createdSeq;
  const situationAfter: SimSituation = {
    ...situation,
    status: "silent",
    handling: {
      mode: "silent",
      decidedByUid: input.ownerUid,
      delegationRuleId: input.delegationRuleId ?? null,
      delegationRuleVersion: input.delegationRuleVersion ?? null,
      npcId: input.npcId ?? null,
      mandateId: input.mandateId ?? null,
      mandateVersion: input.mandateVersion ?? null,
      taskId: null,
      actionId: null,
      decidedAt: new Date(input.now),
      decisionNote: null,
      outcomeVerb: null,
    },
    resolvedSeq: input.resolvedSeq,
    resolvedByResolutionId: input.resolvedByResolutionId,
    updatedAt: new Date(input.now),
  };
  const entry = ruleEffectDraft({
    summary: true,
    actor,
    summaryText: silenceSummaryText(input.cityName, triggerSeq),
    cityId: situation.audienceCityId ?? situation.cityId,
    cityIds: [situation.audienceCityId ?? situation.cityId].filter(
      (c): c is string => typeof c === "string"
    ),
    classification: {
      silence: true,
      producingMode: input.producingMode,
      situationId: situation.situationId,
      situationKind: situation.kind,
      trigger: {
        sourceKind: situation.source.kind,
        sourceId: situation.source.sourceId,
        sourceSeq: situation.source.sourceSeq,
      },
      ...(input.delegationRuleId
        ? {
            delegationRuleId: input.delegationRuleId,
            delegationRuleVersion: input.delegationRuleVersion ?? null,
          }
        : {}),
    },
    changes: [],
    recordsUpdated: [situationPath(situation.situationId)],
    visibility: "public",
    major: false,
  });
  // §8.1: the non-response is recorded and the situation closes as
  // silent in the same transaction; no stats change — the entry's
  // changes are empty by construction (see the draft above).
  return {
    situationAfter,
    entry,
    changedFields: ["status", "handling", "resolvedSeq", "resolvedByResolutionId", "updatedAt"],
  };
}

/** Fold a silence commit into a plan: the situation write + the one
 *  entry, which is the plan's summary (a silence commit is its own
 *  Resolution Event, §8.1(2)). */
export function applySilenceCommit(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  input: SilenceCommitInput
): SilenceCommit {
  const commit = buildSilenceCommit(input);
  planWrite(
    plan,
    snapshot,
    situationPath(commit.situationAfter.situationId),
    commit.situationAfter as unknown as Record<string, unknown>,
    "state",
    commit.changedFields
  );
  plan.entries.push(commit.entry);
  return commit;
}

/** Read-side helper for the wake steps: the doc a snapshot holds for
 *  a situation path, typed — null when absent. */
export function situationFromSnapshot(
  snapshot: SimSnapshot,
  situationId: string
): SimSituation | null {
  const doc = snapshotDoc(snapshot, situationPath(situationId));
  return doc ? (doc as unknown as SimSituation) : null;
}

/** The state-hash discipline's local half (§8.1(3)): a silence plan
 *  writes ONLY its situation doc. Exported for the gate suite and
 *  the verifier's silence assertions (W2/W6) to share one reading. */
export function silencePlanWritesOnlySituation(plan: ResolutionPlan, situationId: string): boolean {
  return (
    plan.writes.length === 1 &&
    plan.writes[0].path === situationPath(situationId) &&
    plan.entries.every((e) => e.changes.length === 0)
  );
}

// ---------------------------------------------------------------------------
// The ripening-occasion producer (GAP-1, banking addendum §1.6 —
// ruled in W3: the class is ADDED here). §6.5's five classes do not
// express banking's due occasions: scheduled consequences of
// earlier confirmed acts (a loan's installment schedule created at
// funding; a bank's premium chain), announced when their AGR
// pending ripens, with zero state effects beyond the ripening's own
// marker entry. A due marker is not spillover (nothing has resolved
// — the ask IS the recipient's next act) and not needsAttention
// (nothing has failed).
//
// The occasion rides the pending itself: the creating act stamps
// an `occasion` spec into the pending's payloadSpec (the schedule
// is a consequence of the origination action — Felix §1.0), and
// the ripening Resolution Event mints the Situation in its own
// transaction via this builder — the card's causedBy chain is the
// ripening event's, and its source names the pending. There is NO
// dispatcher post-pass: a card minted a wake later would break the
// atomicity every other producer keeps. Where the occasion's own
// condition says nothing is owed (the premium chain's zero-due
// period), the creating family simply does not call the builder —
// the ripening's marker entry still lands, and no card is minted
// (§6.2's empty-state honesty).
//
// Dedupe is Pattern P (banking addendum §1.1): source kind
// `system`, source ID = the pending's ID — one card per ripening,
// and a LATER pending (next installment, next period) is a distinct
// source minting a distinct card, never resurrecting a terminal
// one. The accumulation exception is the premium card (K3/K4): a
// bank never holds two open premium cards, so that family's wake
// composition routes a new period's occasion through the upsert
// against the bank's open premium card instead of a fresh mint —
// the upsert's supersede carries the accumulated arrears detail.
// ---------------------------------------------------------------------------

/** The spec a creating act stamps into a pending's payloadSpec
 *  under `occasion`. Addressing KEYS only: the owner snapshot is
 *  resolved at ripening (ownership may have changed since the act),
 *  and the recipient uid / cities named here are the durable keys
 *  (banking addendum §1.0 addressing). */
export interface RipeningOccasionSpec {
  /** Banking's due occasions: `system` (ruled in W3 for B2/B3/K1/
   *  K3/K4 — schedule markers from the world's own machinery). */
  kind: string;
  severity: SituationSeverity;
  title: string;
  summary: string;
  detail: Record<string, unknown> | null;
  /** Subject/facet city (the loan's or bank's home city). */
  cityId: string | null;
  audienceCityId: string | null;
  recipientUid: string | null;
}

const SEVERITIES: ReadonlySet<string> = new Set(["routine", "important", "major"]);

/** Read the occasion spec off a pending doc's payloadSpec —
 *  defensively, like every payloadSpec reader in the engine: a
 *  malformed spec reads as NO occasion (the ripening proceeds; a
 *  card is never minted from a shape the producer didn't write). */
export function occasionSpecFromPending(pending: {
  payloadSpec: Record<string, unknown> | null | undefined;
}): RipeningOccasionSpec | null {
  const raw = pending.payloadSpec?.occasion;
  if (typeof raw !== "object" || raw === null) return null;
  const spec = raw as Record<string, unknown>;
  if (typeof spec.kind !== "string" || spec.kind.length === 0) return null;
  if (typeof spec.severity !== "string" || !SEVERITIES.has(spec.severity)) return null;
  if (typeof spec.title !== "string" || spec.title.length === 0) return null;
  if (typeof spec.summary !== "string" || spec.summary.length === 0) return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    kind: spec.kind,
    severity: spec.severity as SituationSeverity,
    title: spec.title,
    summary: spec.summary,
    detail:
      typeof spec.detail === "object" && spec.detail !== null
        ? (spec.detail as Record<string, unknown>)
        : null,
    cityId: str(spec.cityId),
    audienceCityId: str(spec.audienceCityId),
    recipientUid: str(spec.recipientUid),
  };
}

export function buildRipeningOccasionSituation(input: {
  pending: { pendingId: string; originSeq: number | null };
  spec: RipeningOccasionSpec;
  /** The ripening event: its summary seq + resolution id. */
  ripeningSeq: number | null;
  ripeningResolutionId: string | null;
  /** Current owners of the audience, resolved at ripening. */
  audienceOwnerUidsSnapshot: string[];
  createdSeq: number | null;
  now: string;
}): SimSituation {
  const { spec } = input;
  return buildSituationDoc({
    cityId: spec.cityId,
    audienceCityId: spec.audienceCityId,
    audienceOwnerUidsSnapshot: input.audienceOwnerUidsSnapshot,
    recipientUid: spec.recipientUid,
    kind: spec.kind,
    severity: spec.severity,
    title: spec.title,
    summary: spec.summary,
    detail: {
      ...(spec.detail ?? {}),
      // Stamped after the spec's own detail: the card always names
      // its pending and the origination seq, unspoofably — this is
      // the traceability link (every card traceable to a causedBy
      // chain, Felix §1.0).
      pendingId: input.pending.pendingId,
      originSeq: input.pending.originSeq,
    },
    source: {
      kind: "system",
      sourceId: input.pending.pendingId,
      sourceSeq: input.ripeningSeq,
      sourceResolutionId: input.ripeningResolutionId,
    },
    createdSeq: input.createdSeq,
    now: input.now,
  });
}
