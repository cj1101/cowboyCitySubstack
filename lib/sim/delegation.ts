/**
 * Auto-delegation rules — evaluation and guardrails (Phase 5 brief
 * §7; Dana §3.7 shapes and evaluation order; Petra spec §3.5 composer
 * guardrails). The pure layer: the rule shape + version hashing, the
 * matcher, Dana's five-step evaluation, the narrower-of (rule,
 * mandate) authority resolution, the rule-fire payload + its plan
 * composition, and the composer validator that the settings UI (W4)
 * and the rules tests (W1/W6) SHARE — one implementation, so a rule
 * the composer refuses is a rule the evaluator would refuse to fire,
 * and vice versa.
 *
 * THE ORDER (§7.2, verbatim in substance — also the surface's help
 * text):
 *   1. Explicit `alwaysWait` / wait-for-owner matches.
 *   2. More specific matches (city + kind + counterparty) before
 *      broad ones.
 *   3. Lower `priority` within the same specificity.
 *   4. The handler's mandate caps and Tier B escalation override
 *      every rule.
 *   5. No match → the situation stays `open` for the human.
 * Steps 1–3 SELECT the single candidate fire; step 4 then judges THAT
 * fire. A blocked candidate does not cascade to a lesser match:
 * Petra's no-silent-fall-through rule for dead mandates (§7.2) is the
 * named case, and this module generalizes it — an owner whose most
 * specific instruction cannot lawfully fire gets their card back
 * with the reason, not a quieter rule firing underneath it.
 *
 * EVALUATION IS A PASS, NOT A SCAN (assembly plan §2.2): the wake's
 * step-4 pass calls the evaluator once per Situation created or
 * updated in that wake and still `open`, over the rules the CALLER
 * resolved for the situation's CURRENT audience owner. A fire never
 * recurses inside its creating transaction, and a situation created
 * by a rule fire is not re-evaluated until a later wake (§1.4) —
 * both are the wake's discipline; this module's part is that
 * evaluation is a pure function of (situation, rules, authority
 * views) with no hidden state to chain on.
 *
 * A rule can route work; it can never expand a mandate (§7.3). The
 * evaluator enforces it mechanically (narrower-of, step 4) and the
 * composer refuses to save a draft that even purports to (wider caps
 * than the cited mandate, a foreign NPC, shared-city routing across
 * office authority, act-for-me over a Tier B kind).
 */

import { narrowestMode } from "../authority/modes";
import { classifyTierB, type TierClassification } from "../authority/classify";
import type { DelegatedActionAttempt, PermissionMode } from "../authority/types";
import { canonicalJson, sha256HexOfText } from "./canonical";
import { planWrite, ruleEffectDraft } from "./rules/planHelpers";
import type { MandateCaps, SimMandateVersion } from "../npcs/types";
import {
  applySilenceCommit,
  recordDelegation,
  situationPath,
  type SimSituation,
} from "./situations";
import type { LogEntryDraft, ResolutionPlan, SimSnapshot } from "./state";

// ---------------------------------------------------------------------------
// Shape (brief §7.1 [FINAL], Dana §3.7)
// ---------------------------------------------------------------------------

export type DelegationRuleMode = PermissionMode | "wait-for-owner";

export interface DelegationRuleMatch {
  situationKinds: string[];
  sourceKinds: string[];
  cityIds: string[] | null;
  counterpartyCityIds: string[] | null;
  minRubars: number | null;
  maxRubars: number | null;
  tags: string[];
}

export interface DelegationRuleHandler {
  npcId: string | null;
  mode: DelegationRuleMode;
  mandateId: string | null;
}

/** Named integer caps relevant to the handler (Dana §3.7). Values are
 *  integers or null (null = the rule sets no cap under that name). */
export type DelegationRuleCaps = Record<string, number | null>;

export type DelegationRuleStatus = "pending" | "active" | "disabled" | "superseded";

/** `sim_delegation_rules/{ruleId}` — the materialized current version
 *  (the root carries the version's payload, mirroring mandates). */
export interface SimDelegationRule {
  ruleId: string;
  ownerUid: string;
  cityId: string;
  version: number;
  enabled: boolean;
  priority: number;
  match: DelegationRuleMatch;
  handler: DelegationRuleHandler;
  caps: DelegationRuleCaps;
  alwaysWait: boolean;
  ruleHash: string;
  effectiveSeq: number | null;
  status: DelegationRuleStatus;
  createdAt: unknown;
  updatedAt: unknown;
}

/** The immutable version payload at `sim_delegation_rules/{ruleId}/
 *  versions/{version}` — the authoring fields only; status/effective
 *  fields live on the root and are excluded from the hash (§2.7). */
export interface DelegationRuleVersion {
  ruleId: string;
  version: number;
  ownerUid: string;
  cityId: string;
  priority: number;
  match: DelegationRuleMatch;
  handler: DelegationRuleHandler;
  caps: DelegationRuleCaps;
  alwaysWait: boolean;
  enabled: boolean;
  ruleHash: string;
  createdAt: unknown;
}

export function delegationRulePath(ruleId: string): string {
  return `sim_delegation_rules/${ruleId}`;
}

/** ruleHash over the immutable authority payload (§2.7, canonical
 *  regime): everything the author wrote, excluding the fabric-stamped
 *  status/effective fields — mirroring mandateHash's discipline in
 *  lib/npcs. The exact field set is a ratification item (prep report),
 *  as Cato's was for mandates. */
export function computeRuleHash(payload: {
  ruleId: string;
  ownerUid: string;
  cityId: string;
  version: number;
  priority: number;
  match: DelegationRuleMatch;
  handler: DelegationRuleHandler;
  caps: DelegationRuleCaps;
  alwaysWait: boolean;
  enabled: boolean;
}): string {
  return sha256HexOfText(
    canonicalJson({
      ruleId: payload.ruleId,
      ownerUid: payload.ownerUid,
      cityId: payload.cityId,
      version: payload.version,
      priority: payload.priority,
      match: payload.match,
      handler: payload.handler,
      caps: payload.caps,
      alwaysWait: payload.alwaysWait,
      enabled: payload.enabled,
    })
  );
}

export function buildDelegationRuleVersion(input: {
  ruleId: string;
  version: number;
  ownerUid: string;
  cityId: string;
  priority: number;
  match: DelegationRuleMatch;
  handler: DelegationRuleHandler;
  caps: DelegationRuleCaps;
  alwaysWait: boolean;
  enabled?: boolean;
  now: string;
}): DelegationRuleVersion {
  const enabled = input.enabled ?? true;
  return {
    ruleId: input.ruleId,
    version: input.version,
    ownerUid: input.ownerUid,
    cityId: input.cityId,
    priority: input.priority,
    match: input.match,
    handler: input.handler,
    caps: input.caps,
    alwaysWait: input.alwaysWait,
    enabled,
    ruleHash: computeRuleHash({ ...input, enabled }),
    createdAt: new Date(input.now),
  };
}

// ---------------------------------------------------------------------------
// Tier B for situations. Two evidence sources, one classification:
//  (a) the KIND floor — kinds whose handling IS a §5.4 class by
//      nature: `contest` (contest-binding), `legal` (law-office /
//      binding-act), `election-due` (ballot / law-office),
//      `ingestion-review` (canon-adoption — the card's decision is
//      adopt-or-not, and adoption is Tier B by construction);
//  (b) the DETAIL evidence — the producer-stamped `ruleIds`/`classes`
//      of the underlying act, classified by lib/authority's
//      classifyTierB (the single source the authority stage uses).
// Kinds like `proposal` and `escalation` carry no floor: a proposal's
// Tier B-ness rides in its detail (acceptance is binding; drafting a
// response is Tier A), and an escalation already carries the failed
// attempt's ruleIds/classes in its detail.
// ---------------------------------------------------------------------------

export const TIER_B_SITUATION_KINDS: ReadonlySet<string> = new Set([
  "contest",
  "legal",
  "election-due",
  "ingestion-review",
]);

export function situationTierB(situation: SimSituation): TierClassification {
  const via: string[] = [];
  if (TIER_B_SITUATION_KINDS.has(situation.kind)) via.push(`kind ${situation.kind}`);
  const detail = situation.detail ?? {};
  const ruleIds = Array.isArray(detail.ruleIds)
    ? (detail.ruleIds as unknown[]).filter((r): r is string => typeof r === "string")
    : [];
  const classes = Array.isArray(detail.classes)
    ? (detail.classes as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (ruleIds.length > 0 || classes.length > 0) {
    // classifyTierB reads exactly `ruleIds` and `classes` from the
    // attempt (classify.ts) — the situation's stamped evidence is
    // presented in that shape so the classification has ONE
    // implementation, shared with the authority stage.
    const classified = classifyTierB({ ruleIds, classes } as DelegatedActionAttempt);
    via.push(...classified.via);
  }
  return { tierB: via.length > 0, via };
}

// ---------------------------------------------------------------------------
// The matcher. A rule matches when EVERY dimension it constrains is
// satisfied; an unconstrained dimension abstains. Bounds fail closed:
// a rubars bound cannot be satisfied by a situation carrying no
// amount, a counterparty list cannot be satisfied by a situation
// naming no counterparty — an unknown never widens a match.
// ---------------------------------------------------------------------------

export interface SituationMatchAttributes {
  kind: string;
  sourceKind: string;
  /** The situation's subject city (detail matching: rule.cityId is
   *  the rulebook's city and is checked against the AUDIENCE city in
   *  the evaluator; match.cityIds constrains the SUBJECT city). */
  subjectCityId: string | null;
  audienceCityId: string | null;
  counterpartyCityId: string | null;
  amountRubars: number | null;
  tags: string[];
}

function detailString(detail: Record<string, unknown> | null, key: string): string | null {
  const v = detail?.[key];
  return typeof v === "string" ? v : null;
}
function detailInteger(detail: Record<string, unknown> | null, key: string): number | null {
  const v = detail?.[key];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}
function detailStringList(detail: Record<string, unknown> | null, key: string): string[] {
  const v = detail?.[key];
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function situationMatchAttributes(situation: SimSituation): SituationMatchAttributes {
  return {
    kind: situation.kind,
    sourceKind: situation.source.kind,
    subjectCityId: situation.cityId,
    audienceCityId: situation.audienceCityId ?? situation.cityId,
    counterpartyCityId: detailString(situation.detail, "counterpartyCityId"),
    amountRubars: detailInteger(situation.detail, "amountRubars"),
    tags: detailStringList(situation.detail, "tags"),
  };
}

export interface RuleMatchResult {
  matched: boolean;
  /** Count of constraining dimensions the rule sets (and, when
   *  matched, satisfies) — Dana step 2's specificity, generalized
   *  from the named trio (city + kind + counterparty) to every
   *  dimension the shape carries. */
  specificity: number;
  failedDimensions: string[];
}

export function matchDelegationRule(
  rule: SimDelegationRule,
  attrs: SituationMatchAttributes
): RuleMatchResult {
  const failed: string[] = [];
  let specificity = 0;
  const m = rule.match;
  if (m.situationKinds.length > 0) {
    specificity += 1;
    if (!m.situationKinds.includes(attrs.kind)) failed.push("situationKinds");
  }
  if (m.sourceKinds.length > 0) {
    specificity += 1;
    if (!m.sourceKinds.includes(attrs.sourceKind)) failed.push("sourceKinds");
  }
  if (m.cityIds !== null) {
    specificity += 1;
    if (attrs.subjectCityId === null || !m.cityIds.includes(attrs.subjectCityId)) {
      failed.push("cityIds");
    }
  }
  if (m.counterpartyCityIds !== null) {
    specificity += 1;
    if (
      attrs.counterpartyCityId === null ||
      !m.counterpartyCityIds.includes(attrs.counterpartyCityId)
    ) {
      failed.push("counterpartyCityIds");
    }
  }
  if (m.minRubars !== null || m.maxRubars !== null) {
    specificity += 1;
    if (attrs.amountRubars === null) failed.push("rubars");
    else {
      if (m.minRubars !== null && attrs.amountRubars < m.minRubars) failed.push("minRubars");
      if (m.maxRubars !== null && attrs.amountRubars > m.maxRubars) failed.push("maxRubars");
    }
  }
  if (m.tags.length > 0) {
    specificity += 1;
    if (!m.tags.every((t) => attrs.tags.includes(t))) failed.push("tags");
  }
  return { matched: failed.length === 0, specificity, failedDimensions: failed };
}

function compareCandidates(
  a: { rule: SimDelegationRule; match: RuleMatchResult },
  b: { rule: SimDelegationRule; match: RuleMatchResult }
): number {
  if (a.match.specificity !== b.match.specificity) {
    return b.match.specificity - a.match.specificity; // more specific first
  }
  if (a.rule.priority !== b.rule.priority) return a.rule.priority - b.rule.priority;
  return a.rule.ruleId < b.rule.ruleId ? -1 : a.rule.ruleId > b.rule.ruleId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Narrower-of (rule, mandate) — §7.3's "can never expand a mandate"
// as arithmetic. Modes narrow by lib/authority's MODE_POWER; caps
// narrow per named cap (the smaller of the non-null values binds;
// a cap set on only one side binds from that side). `allowPartial-
// Execution` and the mandate's period definitions are NOT caps and
// never narrow here — they are read by the resolver's authority
// stage at action time (TC-N05 discipline).
// ---------------------------------------------------------------------------

export type CapBinding = "rule" | "mandate" | "both-equal" | "rule-only" | "mandate-only" | "none";

export interface DelegationAuthorityResolution {
  effectiveMode: PermissionMode;
  effectiveCaps: DelegationRuleCaps;
  capBindings: Record<string, CapBinding>;
  /** Which source supplied the effective mode, for the Log record. */
  modeBinding: "rule" | "mandate" | "npc" | "unconstrained";
}

export function resolveDelegationAuthority(input: {
  npcMode: PermissionMode | null;
  mandateVersion: SimMandateVersion | null;
  ruleMode: PermissionMode | null;
  ruleCaps: DelegationRuleCaps | null;
}): DelegationAuthorityResolution {
  const mandateMode = input.mandateVersion?.permissionMode ?? null;
  const effectiveMode = narrowestMode(input.npcMode, mandateMode, input.ruleMode);
  const modeBinding: DelegationAuthorityResolution["modeBinding"] =
    input.ruleMode !== null && effectiveMode === input.ruleMode && input.ruleMode !== mandateMode && input.ruleMode !== input.npcMode
      ? "rule"
      : mandateMode !== null && effectiveMode === mandateMode && mandateMode !== input.npcMode
        ? "mandate"
        : input.npcMode !== null && effectiveMode === input.npcMode
          ? "npc"
          : "unconstrained";
  const mandateCaps: MandateCaps | null = input.mandateVersion?.caps ?? null;
  const names = new Set<string>([
    ...Object.keys(input.ruleCaps ?? {}),
    ...Object.keys(mandateCaps ?? {}).filter(
      (k) => k !== "periodDefinition" && k !== "allowPartialExecution"
    ),
  ]);
  const effectiveCaps: DelegationRuleCaps = {};
  const capBindings: Record<string, CapBinding> = {};
  for (const name of names) {
    const ruleVal = input.ruleCaps?.[name] ?? null;
    const rawMandate = mandateCaps?.[name];
    const mandateVal = typeof rawMandate === "number" ? rawMandate : null;
    if (ruleVal === null && mandateVal === null) {
      effectiveCaps[name] = null;
      capBindings[name] = "none";
    } else if (ruleVal !== null && mandateVal !== null) {
      effectiveCaps[name] = Math.min(ruleVal, mandateVal);
      capBindings[name] = ruleVal === mandateVal ? "both-equal" : ruleVal < mandateVal ? "rule" : "mandate";
    } else if (ruleVal !== null) {
      effectiveCaps[name] = ruleVal;
      capBindings[name] = "rule-only";
    } else {
      effectiveCaps[name] = mandateVal;
      capBindings[name] = "mandate-only";
    }
  }
  return { effectiveMode, effectiveCaps, capBindings, modeBinding };
}

// ---------------------------------------------------------------------------
// The evaluator — Dana's five steps as one pure function.
// ---------------------------------------------------------------------------

/** The authority facts about a rule's handler, resolved by the
 *  caller (the pass reads current docs; this module judges). */
export interface HandlerAuthorityView {
  npc: {
    npcId: string;
    ownerUid: string;
    permissionMode: PermissionMode;
    status: string;
  } | null;
  /** The cited mandate: null when the rule cites none. `found:false`
   *  when it cites one that does not resolve. `version` is the
   *  mandate's CURRENT active version — the fire cites it (§7.1:
   *  the Log cites rule id/version and mandate id/version). */
  mandate: {
    found: boolean;
    rootStatus: string | null;
    version: SimMandateVersion | null;
  } | null;
}

export interface DelegatedActionSpec {
  actionType: string;
  structuredAction: Record<string, unknown>;
  targetCityIds: string[];
}

export interface DelegationFire {
  ruleId: string;
  ruleVersion: number;
  ruleHash: string;
  /** The accountable owner (the rule's author) — the fire's
   *  decidedByUid and the envelope's requester. */
  ownerUid: string;
  npcId: string | null;
  mandateId: string | null;
  mandateVersion: number | null;
  effectiveMode: PermissionMode;
  authority: DelegationAuthorityResolution;
  kind: "delegated-action" | "envelope" | "silence";
  actionSpec: DelegatedActionSpec | null;
  /** The spawn spec for lib/envelopes' builder (W2 fire step adds
   *  spawnActionId/clientRequestId/availableAt/createdSeq). */
  envelopeSpec: {
    npcId: string;
    cityId: string | null;
    threadRef: { kind: "situation"; id: string };
    taskType: "one-off";
    intentText: string;
    structuredIntent: Record<string, unknown>;
    counterpartyCityIds: string[];
    mandateId: string | null;
    mandateVersion: number | null;
  } | null;
  tierB: TierClassification;
  situationId: string;
}

export type DelegationEvaluation =
  | { outcome: "wait"; rule: SimDelegationRule; match: RuleMatchResult }
  | { outcome: "no-match" }
  | {
      outcome: "blocked-handler-authority-changed";
      rule: SimDelegationRule;
      match: RuleMatchResult;
      reason: string;
    }
  | {
      outcome: "escalate";
      rule: SimDelegationRule;
      match: RuleMatchResult;
      code: "tier-b" | "over-cap";
      via: string[];
      detail: string;
    }
  | { outcome: "fire"; rule: SimDelegationRule; match: RuleMatchResult; fire: DelegationFire };

function isWaitRule(rule: SimDelegationRule): boolean {
  return rule.alwaysWait === true || rule.handler.mode === "wait-for-owner";
}

function readActionSpec(situation: SimSituation): DelegatedActionSpec | null {
  const raw = situation.detail?.delegatedAction;
  if (typeof raw !== "object" || raw === null) return null;
  const spec = raw as Record<string, unknown>;
  if (typeof spec.actionType !== "string" || spec.actionType.length === 0) return null;
  if (typeof spec.structuredAction !== "object" || spec.structuredAction === null) return null;
  const targets = Array.isArray(spec.targetCityIds)
    ? (spec.targetCityIds as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return {
    actionType: spec.actionType,
    structuredAction: spec.structuredAction as Record<string, unknown>,
    targetCityIds: targets,
  };
}

/** PR-4 seam (Lead assembly): the wake's standing-team trigger pass
 *  reads the same defensively-parsed action spec the evaluator does
 *  (F8: malformed = absent). Exported under a situational name; the
 *  function itself is unchanged. */
export const readSituationActionSpec = readActionSpec;

export function evaluateDelegation(input: {
  situation: SimSituation;
  /** The CURRENT audience owner's rules (any status/enabled — the
   *  evaluator applies only active + enabled ones, §7.1). */
  rules: SimDelegationRule[];
  authorityFor: (rule: SimDelegationRule) => HandlerAuthorityView;
}): DelegationEvaluation {
  const { situation } = input;
  const attrs = situationMatchAttributes(situation);
  // Rules are a city's rulebook (§7.1: rule.cityId). A person-scoped
  // situation has no rulebook city — rules never apply to it.
  if (attrs.audienceCityId === null) return { outcome: "no-match" };
  const candidates = input.rules
    .filter(
      (r) => r.status === "active" && r.enabled === true && r.cityId === attrs.audienceCityId
    )
    .map((rule) => ({ rule, match: matchDelegationRule(rule, attrs) }))
    .filter((c) => c.match.matched);

  // Step 1 — explicit waits beat every delegation, however specific.
  const waits = candidates.filter((c) => isWaitRule(c.rule)).sort(compareCandidates);
  if (waits.length > 0) return { outcome: "wait", rule: waits[0].rule, match: waits[0].match };

  // Steps 2–3 — specificity, then priority, then rule id (stable).
  const delegates = candidates.filter((c) => !isWaitRule(c.rule)).sort(compareCandidates);
  if (delegates.length === 0) return { outcome: "no-match" };
  const { rule, match } = delegates[0];

  // Step 4 — the selected fire is judged. No cascade to lesser
  // matches (see the header): a blocked candidate returns the card
  // to the owner with its reason.
  const blocked = (reason: string): DelegationEvaluation => ({
    outcome: "blocked-handler-authority-changed",
    rule,
    match,
    reason,
  });
  const authority = input.authorityFor(rule);
  if (rule.handler.npcId !== null) {
    if (authority.npc === null) return blocked(`handler NPC ${rule.handler.npcId} no longer resolves`);
    if (authority.npc.ownerUid !== rule.ownerUid) {
      return blocked(`handler NPC ${rule.handler.npcId} is not the rule author's NPC`);
    }
    if (authority.npc.status !== "active") {
      return blocked(`handler NPC ${rule.handler.npcId} is ${authority.npc.status}, not active`);
    }
  } else if (rule.handler.mode !== "silent") {
    return blocked("the rule names no handler NPC for a mode that must do work");
  }
  let mandateVersion: SimMandateVersion | null = null;
  if (rule.handler.mandateId !== null) {
    if (authority.mandate === null || authority.mandate.found !== true) {
      return blocked(`cited mandate ${rule.handler.mandateId} no longer resolves`);
    }
    if (authority.mandate.rootStatus !== "active" || authority.mandate.version === null) {
      return blocked(
        `cited mandate ${rule.handler.mandateId} is ${authority.mandate.rootStatus ?? "unavailable"}, not active — the rule stops matching until the owner fixes it (§7.2)`
      );
    }
    mandateVersion = authority.mandate.version;
    if (rule.handler.npcId !== null && mandateVersion.npcId !== rule.handler.npcId) {
      return blocked(`cited mandate ${rule.handler.mandateId} belongs to NPC ${mandateVersion.npcId}, not the handler ${rule.handler.npcId}`);
    }
    if (mandateVersion.cityId !== rule.cityId) {
      return blocked(`cited mandate ${rule.handler.mandateId} is for city ${mandateVersion.cityId}, not this rule's city ${rule.cityId}`);
    }
  }

  const resolution = resolveDelegationAuthority({
    npcMode: authority.npc?.permissionMode ?? null,
    mandateVersion,
    ruleMode: rule.handler.mode === "wait-for-owner" ? null : rule.handler.mode,
    ruleCaps: rule.caps,
  });
  const tierB = situationTierB(situation);
  if (tierB.tierB && resolution.effectiveMode === "act-for-me") {
    return {
      outcome: "escalate",
      rule,
      match,
      code: "tier-b",
      via: tierB.via,
      detail:
        `Tier B (${tierB.via.join(", ")}) can never resolve under a mandate (§5.4) — ` +
        "the card stays with the owner; an ask-first routing would have produced a draft instead",
    };
  }
  const perActionCap = resolution.effectiveCaps.perActionRubars ?? null;
  if (attrs.amountRubars !== null && perActionCap !== null && attrs.amountRubars > perActionCap) {
    return {
      outcome: "escalate",
      rule,
      match,
      code: "over-cap",
      via: [],
      detail:
        `the situation's ${attrs.amountRubars} R exceeds the effective per-action cap of ${perActionCap} R ` +
        `(binding source: ${resolution.capBindings.perActionRubars ?? "none"}) — over-cap attempts are refused whole and escalated, never executed up to the cap (TC-N05 discipline)`,
    };
  }

  const actionSpec = resolution.effectiveMode === "act-for-me" ? readActionSpec(situation) : null;
  const kind: DelegationFire["kind"] =
    resolution.effectiveMode === "silent"
      ? "silence"
      : actionSpec !== null
        ? "delegated-action"
        : "envelope";
  const fire: DelegationFire = {
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    ruleHash: rule.ruleHash,
    ownerUid: rule.ownerUid,
    npcId: rule.handler.npcId,
    mandateId: rule.handler.mandateId,
    mandateVersion: mandateVersion?.version ?? null,
    effectiveMode: resolution.effectiveMode,
    authority: resolution,
    kind,
    actionSpec,
    envelopeSpec:
      kind === "envelope" && rule.handler.npcId !== null
        ? {
            npcId: rule.handler.npcId,
            cityId: attrs.audienceCityId,
            threadRef: { kind: "situation", id: situation.situationId },
            taskType: "one-off",
            intentText: `${situation.title} — ${situation.summary}`,
            structuredIntent: {
              situationId: situation.situationId,
              situationKind: situation.kind,
              delegationRuleId: rule.ruleId,
              delegationRuleVersion: rule.version,
              mandateId: rule.handler.mandateId,
              mandateVersion: mandateVersion?.version ?? null,
              tierB: tierB.tierB,
            },
            counterpartyCityIds: attrs.counterpartyCityId ? [attrs.counterpartyCityId] : [],
            mandateId: rule.handler.mandateId,
            mandateVersion: mandateVersion?.version ?? null,
          }
        : null,
    tierB,
    situationId: situation.situationId,
  };
  return { outcome: "fire", rule, match, fire };
}

// ---------------------------------------------------------------------------
// Fire composition — the wake step-4 step's plan pieces. The fire is
// its own committed step (§1.3): the situation transition + a Log
// entry citing rule id + version (§7.1) land together; the delegated
// action / envelope the fire names is created by the same step (W2
// wires the envelopes builder / resolver intake with the ids it
// allocates, passed back here as taskId/actionId).
// ---------------------------------------------------------------------------

export function buildRuleFireEntry(
  fire: DelegationFire,
  situation: SimSituation
): LogEntryDraft {
  return ruleEffectDraft({
    summary: true,
    actor: {
      type: "npc",
      memberId: null,
      npcId: fire.npcId,
      onBehalfOfMemberId: fire.ownerUid,
      mandateId: fire.mandateId,
      mandateVersion: fire.mandateVersion,
      envelopeId: null,
    },
    cityId: situation.audienceCityId ?? situation.cityId,
    cityIds: [situation.audienceCityId ?? situation.cityId].filter(
      (c): c is string => typeof c === "string"
    ),
    classification: {
      delegationFire: true,
      delegationRuleId: fire.ruleId,
      delegationRuleVersion: fire.ruleVersion,
      fireKind: fire.kind,
      effectiveMode: fire.effectiveMode,
      modeBinding: fire.authority.modeBinding,
      tierB: fire.tierB,
      situationId: situation.situationId,
      situationKind: situation.kind,
    },
    // The situation transition is a top-level record effect:
    // claimed via recordsUpdated + the manifest write set, not
    // changes[] (validatePlan's F-02 grammar is city-tree only —
    // see situations.ts's applySituationUpsert note).
    changes: [],
    recordsUpdated: [situationPath(situation.situationId)],
    summaryText:
      `Auto-delegation: rule ${fire.ruleId} (v${fire.ruleVersion}) fired on a ${situation.kind} situation — ` +
      (fire.kind === "silence"
        ? `pre-committed non-response under ${fire.npcId ? `NPC ${fire.npcId}` : "the owner's rule"} (see the silence entry for the §8 record)`
        : fire.kind === "delegated-action"
          ? `delegated action ${fire.actionSpec?.actionType ?? ""} to NPC ${fire.npcId} in act-for-me mode` +
            (fire.mandateId ? ` under mandate ${fire.mandateId} v${fire.mandateVersion}` : "")
          : `one-off envelope to NPC ${fire.npcId} in ${fire.effectiveMode} mode` +
            (fire.mandateId ? ` under mandate ${fire.mandateId} v${fire.mandateVersion}` : "")) +
      ".",
    visibility: "public",
    major: false,
  });
}

export function applyDelegationFire(
  plan: ResolutionPlan,
  snapshot: SimSnapshot,
  situation: SimSituation,
  fire: DelegationFire,
  ctx: {
    now: string;
    cityName: string;
    resolvedSeq: number;
    resolvedByResolutionId: string;
    taskId?: string | null;
    actionId?: string | null;
  }
): { situationAfter: SimSituation; entry: LogEntryDraft } {
  if (fire.kind === "silence") {
    const commit = applySilenceCommit(plan, snapshot, {
      situation,
      producingMode: "silence-rule",
      ownerUid: fire.ownerUid,
      npcId: fire.npcId,
      mandateId: fire.mandateId,
      mandateVersion: fire.mandateVersion,
      delegationRuleId: fire.ruleId,
      delegationRuleVersion: fire.ruleVersion,
      cityName: ctx.cityName,
      resolvedSeq: ctx.resolvedSeq,
      resolvedByResolutionId: ctx.resolvedByResolutionId,
      now: ctx.now,
    });
    return { situationAfter: commit.situationAfter, entry: commit.entry };
  }
  if (fire.npcId === null) {
    // The evaluator never builds a work fire without a handler; this
    // is the fail-closed seam for hand-constructed fires.
    throw new Error(
      `delegation fire for rule ${fire.ruleId} names no handler NPC — a ${fire.kind} fire cannot be composed`
    );
  }
  const transition = recordDelegation(situation, {
    decidedByUid: fire.ownerUid,
    decidedAt: ctx.now,
    npcId: fire.npcId,
    mandateId: fire.mandateId,
    mandateVersion: fire.mandateVersion,
    effectiveMode: fire.effectiveMode,
    taskId: ctx.taskId ?? null,
    actionId: ctx.actionId ?? null,
    autoDelegated: true,
    delegationRuleId: fire.ruleId,
    delegationRuleVersion: fire.ruleVersion,
  });
  planWrite(
    plan,
    snapshot,
    situationPath(transition.doc.situationId),
    transition.doc as unknown as Record<string, unknown>,
    "state",
    transition.changedFields
  );
  const entry = buildRuleFireEntry(fire, situation);
  plan.entries.push(entry);
  return { situationAfter: transition.doc, entry };
}

/** The audit entry for a step-4 judgment that did NOT fire
 *  (escalate / blocked) — the §5.5 pattern applied to the pass: the
 *  card stays open, and the reason is on the Log with the rule cited,
 *  never only in wake bookkeeping. The dispatcher lands it in the
 *  pass's step; `wait` and `no-match` produce no entry (nothing was
 *  decided about the card). */
export function buildDelegationEvaluationEntry(
  evaluation: Extract<DelegationEvaluation, { outcome: "escalate" | "blocked-handler-authority-changed" }>,
  situation: SimSituation
): LogEntryDraft {
  const isEscalate = evaluation.outcome === "escalate";
  return ruleEffectDraft({
    summary: true,
    actor: {
      type: "member",
      memberId: evaluation.rule.ownerUid,
      npcId: null,
      onBehalfOfMemberId: null,
      mandateId: null,
      mandateVersion: null,
      envelopeId: null,
    },
    cityId: situation.audienceCityId ?? situation.cityId,
    cityIds: [situation.audienceCityId ?? situation.cityId].filter(
      (c): c is string => typeof c === "string"
    ),
    classification: {
      delegationEvaluation: evaluation.outcome,
      delegationRuleId: evaluation.rule.ruleId,
      delegationRuleVersion: evaluation.rule.version,
      situationId: situation.situationId,
      situationKind: situation.kind,
      ...(isEscalate
        ? { code: evaluation.code, via: evaluation.via }
        : { reason: evaluation.reason }),
    },
    changes: [],
    recordsUpdated: [],
    summaryText: isEscalate
      ? `Auto-delegation: rule ${evaluation.rule.ruleId} (v${evaluation.rule.version}) matched a ${situation.kind} situation but did not fire — ${evaluation.detail} The card stays open for the owner.`
      : `Auto-delegation: rule ${evaluation.rule.ruleId} (v${evaluation.rule.version}) matched a ${situation.kind} situation but its handler authority has changed — ${evaluation.reason}. The rule stops matching until the owner fixes it; the card stays open.`,
    visibility: "public",
    major: false,
  });
}

// ---------------------------------------------------------------------------
// The composer validator (§7.3 + Petra spec §3.5) — SHARED by the
// settings UI (W4) and the rules tests (W1/W6). Every violation's
// message is exactly one sentence: the composer explains why, in
// one sentence, and refuses to save. An `alwaysWait` draft is a
// fence — its handler block is inert (§7.4 renders it "Always wait
// for me"), it routes nothing, binds nothing, and delegates to no
// one, so it is always saveable and short-circuits the checks.
// ---------------------------------------------------------------------------

export interface DelegationRuleDraft {
  ownerUid: string;
  cityId: string;
  match: DelegationRuleMatch;
  handler: DelegationRuleHandler;
  caps: DelegationRuleCaps;
  alwaysWait: boolean;
}

export interface ComposerContext {
  /** The resolved handler NPC, when the draft names one. */
  handlerNpc: { npcId: string; ownerUid: string } | null;
  /** The cited mandate's current-version facts, when one is cited. */
  mandate: { mandateId: string; npcId: string; caps: MandateCaps } | null;
  isSharedCity: boolean;
  authorIsSittingMayor: boolean;
}

export interface ComposerViolation {
  code: string;
  message: string;
}

export function validateDelegationRuleDraft(
  draft: DelegationRuleDraft,
  ctx: ComposerContext
): { ok: boolean; violations: ComposerViolation[] } {
  const violations: ComposerViolation[] = [];
  if (draft.alwaysWait) return { ok: true, violations };

  const { handler } = draft;
  if (
    handler.mode === "act-for-me" &&
    (draft.match.situationKinds.length === 0 ||
      draft.match.situationKinds.some((k) => TIER_B_SITUATION_KINDS.has(k)))
  ) {
    violations.push({
      code: "TIER_B_ACT_FOR_ME",
      message:
        "This rule would auto-handle a kind that always needs the owner's own decision (binding, damaging, law, office, or canon), so it cannot be saved with an act-for-me handler.",
    });
  }
  if (handler.npcId !== null) {
    if (ctx.handlerNpc === null) {
      violations.push({
        code: "HANDLER_NOT_FOUND",
        message: "The handler NPC named by this rule could not be found.",
      });
    } else if (ctx.handlerNpc.ownerUid !== draft.ownerUid) {
      violations.push({
        code: "FOREIGN_HANDLER",
        message:
          "A rule can only delegate to the owner's own NPCs and characters, never to another owner's.",
      });
    }
  } else if (handler.mode === "act-for-me" || handler.mode === "ask-first") {
    violations.push({
      code: "HANDLER_REQUIRED",
      message:
        "This mode needs a named handler NPC — someone has to do the work or make the draft.",
    });
  }
  if (ctx.isSharedCity && !ctx.authorIsSittingMayor) {
    violations.push({
      code: "SHARED_CITY_OFFICE",
      message: "Only the sitting mayor's own rules may route the shared city's situations.",
    });
  }
  if (handler.mandateId !== null) {
    if (ctx.mandate === null) {
      violations.push({
        code: "MANDATE_NOT_FOUND",
        message: "The mandate this rule cites could not be found.",
      });
    } else {
      if (handler.npcId !== null && ctx.mandate.npcId !== handler.npcId) {
        violations.push({
          code: "MANDATE_NPC_MISMATCH",
          message: "The cited mandate belongs to a different NPC than the handler this rule names.",
        });
      }
      for (const name of Object.keys(draft.caps)) {
        const ruleCap = draft.caps[name];
        const mandateCap = ctx.mandate.caps[name];
        if (
          typeof ruleCap === "number" &&
          typeof mandateCap === "number" &&
          ruleCap > mandateCap
        ) {
          violations.push({
            code: "MANDATE_EXPANSION",
            message:
              "A rule cannot widen the mandate it cites — raise the mandate first, or lower the rule's cap.",
          });
          break;
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
