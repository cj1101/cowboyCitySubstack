/**
 * Situations + delegation harness (Phase 5 W3) — a pure-logic
 * battery over lib/sim/situations.ts and lib/sim/delegation.ts,
 * riding the REAL landed machinery where the engine is reachable:
 * every plan composed here passes through the resolver's
 * validatePlan + finalizePlan (F-02 change↔write reconciliation
 * included), Tier B classification comes from lib/authority's
 * classifyTierB via the modules under test, and mode arithmetic is
 * lib/authority's narrowestMode. No emulator: Firestore-bound
 * pieces (the wake passes that call these functions) are W2's
 * wiring; this battery proves the module contracts those passes
 * compose.
 *
 * Sections: S1 dedupe/upsert · S2 needsAttention conversion
 * (P5-K8) · S3 narrower-of · S4 composer guardrails · S5 silence
 * (§8/P5-K9) · S6 rule fires + evaluation order · S7 ripening
 * occasions (GAP-1) · S8 episode cards + corporation spillover
 * (Pattern X / GAP-2).
 *
 * Run: npx tsx tests/situations-harness.ts
 */

import assert from "node:assert/strict";
import {
  buildRipeningOccasionSituation,
  buildEscalationSituation,
  buildIncidentSituation,
  buildProposalSituation,
  buildSilenceCommit,
  applySilenceCommit,
  applySituationUpsert,
  dedupeKeyFor,
  deterministicSituationId,
  markSituationHandled,
  occasionSpecFromPending,
  planAttentionBackfill,
  planAttentionConversion,
  planSituationUpsert,
  recordDelegation,
  recordSelfHandling,
  returnSituationToOpen,
  silenceSummaryText,
  SituationError,
  silencePlanWritesOnlySituation,
  type AttentionPendingView,
  type SimSituation,
  type SituationCreateInput,
} from "../lib/sim/situations";
import {
  applyDelegationFire,
  buildDelegationRuleVersion,
  computeRuleHash,
  evaluateDelegation,
  resolveDelegationAuthority,
  situationTierB,
  validateDelegationRuleDraft,
  type DelegationRuleDraft,
  type HandlerAuthorityView,
  type SimDelegationRule,
} from "../lib/sim/delegation";
import { finalizePlan, snapshotFromDocs, validatePlan } from "../lib/sim/resolver";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { emptyPlan, type ResolutionPlan, type SimSnapshot } from "../lib/sim/state";
import { summaryDraft } from "../lib/sim/rules/planHelpers";
import type { SimMandateVersion } from "../lib/npcs/types";

const NOW = "2026-10-20T12:00:00.000Z";
const NOW2 = "2026-10-20T13:00:00.000Z";
const OWNER = "uid-owner-cascadia";
const OTHER_OWNER = "uid-owner-evan";
const CITY = "cascadia";
const OTHER_CITY = "evan-city";
const NPC = "npc-steward";

const registry = buildFixtureBaselineRegistry();

let checks = 0;
function check(name: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
  } catch (err) {
    console.error(`FAIL [${checks}] ${name}`);
    throw err;
  }
}

function snap(docs: Record<string, Record<string, unknown> | null> = {}): SimSnapshot {
  const map = new Map<string, Record<string, unknown> | null>(Object.entries(docs));
  if (!map.has("sim_counters/log")) {
    map.set("sim_counters/log", { lastSeq: 1000, lastResolvedSeq: 1000, lastEntryHash: "seed" });
  }
  if (!map.has("sim_world/current")) map.set("sim_world/current", { lastCommittedSeq: 1000 });
  return snapshotFromDocs(map, NOW);
}

function validate(plan: ResolutionPlan, snapshot: SimSnapshot): ResolutionPlan {
  validatePlan(plan, { baselineRegistry: registry, covertEntriesAllowed: false, snapshot });
  return finalizePlan(plan);
}

const memberActor = {
  type: "member" as const,
  memberId: OWNER,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
};

// ---------------------------------------------------------------------------
// S1 — dedupe under repeated producer fire (§6.1/§2.6)
// ---------------------------------------------------------------------------

const proposalInput = (over: Partial<SituationCreateInput> = {}): SituationCreateInput => ({
  cityId: CITY,
  audienceCityId: CITY,
  audienceOwnerUidsSnapshot: [OWNER],
  recipientUid: null,
  kind: "proposal",
  severity: "routine",
  title: "Trade proposal from Evan City",
  summary: "Evan City proposes a grain agreement.",
  detail: { counterpartyCityId: OTHER_CITY, amountRubars: 4000 },
  source: { kind: "treaty", sourceId: "treaty-prop-1", sourceSeq: 40, sourceResolutionId: "res-40" },
  createdSeq: 41,
  now: NOW,
  ...over,
});

check("S1a identical re-fire refreshes — same doc, no duplicate", () => {
  const first = planSituationUpsert(null, proposalInput());
  assert.equal(first.action, "create");
  if (first.action !== "create") return;
  const second = planSituationUpsert(first.doc, proposalInput({ now: NOW2 }));
  assert.equal(second.action, "refresh");
  if (second.action !== "refresh") return;
  assert.equal(second.doc.situationId, first.doc.situationId);
  assert.equal(second.doc.status, "open");
  assert.equal(second.doc.title, first.doc.title);
});

check("S1b deterministic ID: same key + same source seq, byte-stable", () => {
  const a = planSituationUpsert(null, proposalInput());
  const b = planSituationUpsert(null, proposalInput());
  assert.equal(a.action, "create");
  assert.equal(b.action, "create");
  if (a.action !== "create" || b.action !== "create") return;
  assert.equal(a.doc.situationId, b.doc.situationId);
  assert.equal(a.doc.dedupeKey, b.doc.dedupeKey);
  assert.equal(
    a.doc.dedupeKey,
    dedupeKeyFor({ sourceKind: "treaty", sourceId: "treaty-prop-1", situationKind: "proposal", audienceKey: CITY })
  );
  assert.equal(a.doc.situationId, deterministicSituationId(a.doc.dedupeKey, 40));
});

check("S1c newer source event supersedes — old card in history, new card actionable, distinct ids", () => {
  const first = planSituationUpsert(null, proposalInput());
  assert.equal(first.action, "create");
  if (first.action !== "create") return;
  const updated = proposalInput({
    summary: "Evan City revised the grain agreement (price lowered).",
    detail: { counterpartyCityId: OTHER_CITY, amountRubars: 3500 },
    source: { kind: "treaty", sourceId: "treaty-prop-1", sourceSeq: 55, sourceResolutionId: "res-55" },
    createdSeq: 56,
    now: NOW2,
  });
  const second = planSituationUpsert(first.doc, updated);
  assert.equal(second.action, "supersede-and-create");
  if (second.action !== "supersede-and-create") return;
  assert.notEqual(second.doc.situationId, first.doc.situationId);
  assert.equal(second.supersededDoc.situationId, first.doc.situationId);
  assert.equal(second.supersededDoc.status, "superseded");
  assert.equal(second.supersededDoc.resolvedByResolutionId, "res-55");
  assert.equal(second.doc.status, "open");
  // Both writes land at distinct paths in one validated plan.
  const snapshot = snap({ [`sim_situations/${first.doc.situationId}`]: first.doc as unknown as Record<string, unknown> });
  const plan = emptyPlan(null);
  const applied = applySituationUpsert(plan, snapshot, second);
  assert.deepEqual(applied.created, [second.doc.situationId]);
  assert.deepEqual(applied.superseded, [first.doc.situationId]);
  plan.entries.push(summaryDraft({
    actor: memberActor,
    summaryText: "proposal revised",
    recordsCreated: applied.created.map((id) => `sim_situations/${id}`),
    recordsUpdated: applied.superseded.map((id) => `sim_situations/${id}`),
  }));
  assert.equal(plan.writes.length, 2);
  validate(plan, snapshot);
});

check("S1d stale re-fire (older source seq) is ignored", () => {
  const first = planSituationUpsert(null, proposalInput());
  if (first.action !== "create") throw new Error("setup");
  const stale = planSituationUpsert(
    first.doc,
    proposalInput({
      summary: "an out-of-order older revision",
      source: { kind: "treaty", sourceId: "treaty-prop-1", sourceSeq: 39, sourceResolutionId: "res-39" },
    })
  );
  assert.equal(stale.action, "ignore");
});

check("S1e a terminal namesake is history — re-fire ignored, never clobbered", () => {
  const first = planSituationUpsert(null, proposalInput());
  if (first.action !== "create") throw new Error("setup");
  const handled = markSituationHandled(first.doc, { resolvedSeq: 60, resolvedByResolutionId: "res-60", decidedAt: NOW2 }).doc;
  const again = planSituationUpsert(handled, proposalInput({ now: NOW2 }));
  assert.equal(again.action, "ignore");
});

check("S1f transitions: self-handling keeps the card open; handled is terminal; delegation cycle counts", () => {
  const created = planSituationUpsert(null, proposalInput());
  if (created.action !== "create") throw new Error("setup");
  const self = recordSelfHandling(created.doc, { decidedByUid: OWNER, decidedAt: NOW });
  assert.equal(self.doc.status, "open");
  assert.equal(self.doc.handling?.mode, "self");
  const delegated = recordDelegation(created.doc, {
    decidedByUid: OWNER, decidedAt: NOW, npcId: NPC, mandateId: "mand-1", mandateVersion: 2,
    effectiveMode: "act-for-me",
  });
  assert.equal(delegated.doc.status, "delegated");
  const back = returnSituationToOpen(delegated.doc, { decidedAt: NOW2, reason: "Tier B surfaced mid-handling", failedCheck: "tier-b" });
  assert.equal(back.doc.status, "open");
  assert.equal(back.doc.delegationCycleCount, 1);
  assert.match(back.doc.handling?.decisionNote ?? "", /tier-b/);
  const handledDoc = markSituationHandled(back.doc, { resolvedSeq: 70, resolvedByResolutionId: "res-70", decidedAt: NOW2 }).doc;
  assert.throws(
    () => returnSituationToOpen(handledDoc, { decidedAt: NOW2, reason: "again" }),
    (err: unknown) => err instanceof SituationError && err.code === "SITUATION_TERMINAL"
  );
  // Delegating to a silent-mode NPC refuses (§6.3B).
  assert.throws(
    () => recordDelegation(created.doc, { decidedByUid: OWNER, decidedAt: NOW, npcId: NPC, mandateId: null, mandateVersion: null, effectiveMode: "silent" }),
    (err: unknown) => err instanceof SituationError && err.code === "DELEGATE_TO_SILENT_NPC"
  );
});

// ---------------------------------------------------------------------------
// S2 — needsAttention conversion (P5-K8: linked, not fused)
// ---------------------------------------------------------------------------

const flaggedPending = (over: Partial<AttentionPendingView> = {}): AttentionPendingView => ({
  pendingId: "pend-77",
  kind: "fund-innovation",
  originCityId: CITY,
  originSeq: 120,
  originResolutionId: "res-120",
  attempts: 3,
  needsAttention: true,
  lastFailure: { code: "GENERATION_UNPREPARED" },
  attentionSituationId: null,
  ...over,
});

check("S2a attempt-3 conversion: one system Situation + a link-only patch", () => {
  const pending = flaggedPending();
  const conversion = planAttentionConversion(pending, { originOwnerUids: [OWNER], createdSeq: 200, now: NOW });
  assert.ok(conversion);
  assert.equal(conversion.situation.kind, "system");
  assert.equal(conversion.situation.status, "open");
  assert.equal(conversion.situation.audienceCityId, CITY);
  assert.deepEqual(conversion.situation.audienceOwnerUidsSnapshot, [OWNER]);
  const detail = conversion.situation.detail as Record<string, unknown>;
  assert.equal(detail.pendingId, "pend-77");
  assert.equal(detail.originSeq, 120);
  assert.equal(detail.attempts, 3);
  assert.equal(detail.failureCode, "GENERATION_UNPREPARED");
  assert.equal(detail.failureClass, "attempts");
  // P5-K8, mechanically: the patch carries ONLY the link stamp.
  assert.deepEqual(Object.keys(conversion.pendingPatch), ["attentionSituationId"]);
  assert.equal(conversion.pendingPatch.attentionSituationId, conversion.situation.situationId);
  assert.ok(!("needsAttention" in conversion.pendingPatch));
});

check("S2b conversion is idempotent and flag-gated", () => {
  const pending = flaggedPending();
  const first = planAttentionConversion(pending, { originOwnerUids: [OWNER], createdSeq: 200, now: NOW });
  assert.ok(first);
  const stamped: AttentionPendingView = { ...pending, attentionSituationId: first.pendingPatch.attentionSituationId };
  assert.equal(planAttentionConversion(stamped, { originOwnerUids: [OWNER], createdSeq: 201, now: NOW2 }), null);
  assert.equal(planAttentionConversion(flaggedPending({ needsAttention: false }), { originOwnerUids: [OWNER], createdSeq: 201, now: NOW2 }), null);
  // The flag is the conversion's gate — not the attempt count.
  assert.ok(planAttentionConversion(flaggedPending({ attempts: 1, lastFailure: null }), { originOwnerUids: [OWNER], createdSeq: 201, now: NOW2 }) !== null);
});

check("S2c backfill planner converts exactly the flagged + unstamped", () => {
  const list: AttentionPendingView[] = [
    flaggedPending(),
    flaggedPending({ pendingId: "pend-78", attentionSituationId: "sit_x" }),
    flaggedPending({ pendingId: "pend-79", needsAttention: false }),
    flaggedPending({ pendingId: "pend-80", originSeq: 121 }),
  ];
  const out = planAttentionBackfill(list, () => ({ originOwnerUids: [OWNER], createdSeq: 300, now: NOW }));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => (c.situation.detail as Record<string, unknown>).pendingId), ["pend-77", "pend-80"]);
  // Deterministic ids: the two pendings' cards differ; a re-run over the stamped world yields none.
  const stamped = list.map((p) => {
    const c = out.find((o) => (o.situation.detail as Record<string, unknown>).pendingId === p.pendingId);
    return c ? { ...p, attentionSituationId: c.pendingPatch.attentionSituationId } : p;
  });
  assert.equal(planAttentionBackfill(stamped, () => ({ originOwnerUids: [OWNER], createdSeq: 301, now: NOW2 })).length, 0);
});

check("S2d handling the Situation never touches the pending (P5-K8, both halves)", () => {
  const pending = flaggedPending();
  const before = JSON.parse(JSON.stringify(pending)) as unknown;
  const conversion = planAttentionConversion(pending, { originOwnerUids: [OWNER], createdSeq: 200, now: NOW });
  assert.ok(conversion);
  const handled = markSituationHandled(conversion.situation, { resolvedSeq: 400, resolvedByResolutionId: "res-400", decidedAt: NOW2 });
  assert.equal(handled.doc.status, "handled");
  // The pending object that went in is byte-identical after the whole
  // lifecycle — the flag clears only when the pending itself resolves.
  assert.deepEqual(JSON.parse(JSON.stringify(pending)), before);
  assert.equal(pending.needsAttention, true);
});

// ---------------------------------------------------------------------------
// Shared factories for S3–S6
// ---------------------------------------------------------------------------

function mandateVersion(over: Partial<SimMandateVersion> = {}): SimMandateVersion {
  return {
    version: 2,
    npcId: NPC,
    cityId: CITY,
    ownerUid: OWNER,
    permissionMode: "act-for-me",
    scopeFreeform: "Handle routine city business.",
    structuredScope: { triggerKinds: [], allowedActionTypes: [], namedRecordIds: [], counterpartyCityIds: null },
    caps: {
      perActionRubars: 1000,
      perResolutionPeriodRubars: null,
      periodDefinition: null,
      maxProjectPhase: null,
      allowPartialExecution: false,
    },
    negotiationBounds: null,
    alwaysEscalate: [],
    responseStyle: null,
    expiresAtSeq: null,
    horizonActions: null,
    sourceActionId: "act-mandate-2",
    effectiveSeq: 90,
    supersededSeq: null,
    mandateHash: "hash-mand-2",
    createdAt: new Date(NOW),
    ...over,
  };
}

type RuleOver = Omit<Partial<SimDelegationRule>, "match" | "handler"> & {
  match?: Partial<SimDelegationRule["match"]>;
  handler?: Partial<SimDelegationRule["handler"]>;
};

function rule(over: RuleOver = {}): SimDelegationRule {
  const base: SimDelegationRule = {
    ruleId: "rule-1",
    ownerUid: OWNER,
    cityId: CITY,
    version: 1,
    enabled: true,
    priority: 10,
    match: { situationKinds: [], sourceKinds: [], cityIds: null, counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [] },
    handler: { npcId: NPC, mode: "act-for-me", mandateId: "mand-1" },
    caps: {},
    alwaysWait: false,
    ruleHash: "hash-rule-1",
    effectiveSeq: 95,
    status: "active",
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  return { ...base, ...over, match: { ...base.match, ...(over.match ?? {}) }, handler: { ...base.handler, ...(over.handler ?? {}) } };
}

function authority(over: Partial<HandlerAuthorityView> = {}): HandlerAuthorityView {
  return {
    npc: { npcId: NPC, ownerUid: OWNER, permissionMode: "act-for-me", status: "active" },
    mandate: { found: true, rootStatus: "active", version: mandateVersion() },
    ...over,
  };
}

const questionSituation = (over: Partial<SituationCreateInput> = {}): SimSituation => {
  const created = planSituationUpsert(null, {
    cityId: CITY,
    audienceCityId: CITY,
    audienceOwnerUidsSnapshot: [OWNER],
    recipientUid: null,
    kind: "question",
    severity: "routine",
    title: "A resident asks about the market hall hours",
    summary: "A question routed to the city office.",
    detail: {},
    source: { kind: "manual-action", sourceId: "q-1", sourceSeq: 500, sourceResolutionId: "res-500" },
    createdSeq: 501,
    now: NOW,
    ...over,
  });
  if (created.action !== "create") throw new Error("setup");
  return created.doc;
};

// ---------------------------------------------------------------------------
// S3 — narrower-of (rule, mandate), both directions (§7.2 step 4/§7.3)
// ---------------------------------------------------------------------------

check("S3a mandate narrower than rule: mode and cap both bind from the mandate", () => {
  const res = resolveDelegationAuthority({
    npcMode: "act-for-me",
    mandateVersion: mandateVersion({ permissionMode: "ask-first", caps: { perActionRubars: 300, perResolutionPeriodRubars: null, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false } }),
    ruleMode: "act-for-me",
    ruleCaps: { perActionRubars: 500 },
  });
  assert.equal(res.effectiveMode, "ask-first");
  assert.equal(res.effectiveCaps.perActionRubars, 300);
  assert.equal(res.capBindings.perActionRubars, "mandate");
});

check("S3b rule narrower than mandate: the rule's silence and cap bind", () => {
  const res = resolveDelegationAuthority({
    npcMode: "act-for-me",
    mandateVersion: mandateVersion({ permissionMode: "act-for-me" }),
    ruleMode: "silent",
    ruleCaps: { perActionRubars: 200 },
  });
  assert.equal(res.effectiveMode, "silent");
  assert.equal(res.modeBinding, "rule");
  assert.equal(res.effectiveCaps.perActionRubars, 200);
  assert.equal(res.capBindings.perActionRubars, "rule");
});

check("S3c one-sided caps bind from their side; the NPC's mode is a full participant", () => {
  const res = resolveDelegationAuthority({
    npcMode: "silent",
    mandateVersion: mandateVersion({ caps: { perActionRubars: null, perResolutionPeriodRubars: null, periodDefinition: null, maxProjectPhase: 3, allowPartialExecution: false } }),
    ruleMode: "act-for-me",
    ruleCaps: { surveyBudgetRubars: 50 },
  });
  assert.equal(res.effectiveMode, "silent");
  assert.equal(res.modeBinding, "npc");
  assert.equal(res.effectiveCaps.surveyBudgetRubars, 50);
  assert.equal(res.capBindings.surveyBudgetRubars, "rule-only");
  assert.equal(res.effectiveCaps.maxProjectPhase, 3);
  assert.equal(res.capBindings.maxProjectPhase, "mandate-only");
});

// ---------------------------------------------------------------------------
// S4 — the composer guardrail (§7.3 / Petra §3.5), shared validator
// ---------------------------------------------------------------------------

type DraftOver = Omit<Partial<DelegationRuleDraft>, "match" | "handler"> & {
  match?: Partial<DelegationRuleDraft["match"]>;
  handler?: Partial<DelegationRuleDraft["handler"]>;
};

const draft = (over: DraftOver = {}): DelegationRuleDraft => ({
  ownerUid: OWNER,
  cityId: CITY,
  caps: {},
  alwaysWait: false,
  ...over,
  match: { situationKinds: ["question"], sourceKinds: [], cityIds: null, counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [], ...(over.match ?? {}) },
  handler: { npcId: NPC, mode: "ask-first", mandateId: null, ...(over.handler ?? {}) },
});
const composerCtx = (over: Partial<Parameters<typeof validateDelegationRuleDraft>[1]> = {}) => ({
  handlerNpc: { npcId: NPC, ownerUid: OWNER },
  mandate: null,
  isSharedCity: false,
  authorIsSittingMayor: false,
  ...over,
});

check("S4a act-for-me over a Tier B kind is refused, in one sentence", () => {
  const out = validateDelegationRuleDraft(
    draft({ match: { situationKinds: ["contest"] }, handler: { mode: "act-for-me" } }),
    composerCtx()
  );
  assert.equal(out.ok, false);
  assert.equal(out.violations.length, 1);
  assert.equal(out.violations[0].code, "TIER_B_ACT_FOR_ME");
  assert.ok(out.violations[0].message.endsWith("."));
  assert.equal(out.violations[0].message.split(".").length - 1, 1);
});

check("S4b a wildcard kind set with act-for-me is refused (it would match Tier B kinds)", () => {
  const out = validateDelegationRuleDraft(
    draft({ match: { situationKinds: [] }, handler: { mode: "act-for-me" } }),
    composerCtx()
  );
  assert.equal(out.ok, false);
  assert.equal(out.violations[0].code, "TIER_B_ACT_FOR_ME");
});

check("S4c ask-first over a Tier B kind saves (drafts never bind); a fence saves over anything", () => {
  assert.equal(validateDelegationRuleDraft(draft({ match: { situationKinds: ["legal"] }, handler: { mode: "ask-first" } }), composerCtx()).ok, true);
  assert.equal(validateDelegationRuleDraft(draft({ alwaysWait: true, match: { situationKinds: ["contest"] }, handler: { mode: "act-for-me" } }), composerCtx()).ok, true);
  assert.equal(validateDelegationRuleDraft(draft({ handler: { mode: "silent", npcId: null } }), composerCtx()).ok, true);
});

check("S4d foreign NPC, shared-city office, mandate expansion, missing handler — each refused by name", () => {
  assert.equal(
    validateDelegationRuleDraft(draft(), composerCtx({ handlerNpc: { npcId: NPC, ownerUid: OTHER_OWNER } })).violations[0]?.code,
    "FOREIGN_HANDLER"
  );
  assert.equal(
    validateDelegationRuleDraft(draft(), composerCtx({ isSharedCity: true, authorIsSittingMayor: false })).violations.some((v) => v.code === "SHARED_CITY_OFFICE"),
    true
  );
  assert.equal(
    validateDelegationRuleDraft(draft(), composerCtx({ isSharedCity: true, authorIsSittingMayor: true })).ok,
    true
  );
  const expanding = validateDelegationRuleDraft(
    draft({ handler: { mandateId: "mand-1" }, caps: { perActionRubars: 5000 } }),
    composerCtx({ mandate: { mandateId: "mand-1", npcId: NPC, caps: mandateVersion().caps } })
  );
  assert.equal(expanding.violations.some((v) => v.code === "MANDATE_EXPANSION"), true);
  assert.equal(
    validateDelegationRuleDraft(draft({ handler: { npcId: null, mode: "act-for-me", mandateId: null }, match: { situationKinds: ["question"] } }), composerCtx({ handlerNpc: null })).violations.some((v) => v.code === "HANDLER_REQUIRED"),
    true
  );
});

check("S4e ruleHash: version payloads hash deterministically; the hash binds the payload", () => {
  const v1 = buildDelegationRuleVersion({
    ruleId: "rule-9", version: 1, ownerUid: OWNER, cityId: CITY, priority: 5,
    match: { situationKinds: ["question"], sourceKinds: [], cityIds: null, counterpartyCityIds: null, minRubars: null, maxRubars: null, tags: [] },
    handler: { npcId: NPC, mode: "ask-first", mandateId: null }, caps: {}, alwaysWait: false, now: NOW,
  });
  assert.equal(v1.ruleHash, computeRuleHash(v1));
  const v2 = buildDelegationRuleVersion({ ...v1, version: 2, now: NOW2, handler: { npcId: NPC, mode: "silent", mandateId: null } });
  assert.notEqual(v1.ruleHash, v2.ruleHash);
});

// ---------------------------------------------------------------------------
// S5 — silence (§8): commit shape + actor, teamless vs teamed
// ---------------------------------------------------------------------------

check("S5a teamless city: the owner member record is the actor (P5-K9); the entry changes nothing", () => {
  const situation = questionSituation();
  const commit = buildSilenceCommit({
    situation,
    producingMode: "no-permission",
    ownerUid: OWNER,
    cityName: "Cascadia",
    resolvedSeq: 640,
    resolvedByResolutionId: "res-640",
    now: NOW2,
  });
  assert.equal(commit.entry.actor.type, "member");
  assert.equal(commit.entry.actor.memberId, OWNER);
  assert.equal(commit.entry.actor.npcId, null);
  assert.deepEqual(commit.entry.changes, []);
  assert.equal(commit.entry.classification?.producingMode, "no-permission");
  assert.equal(commit.situationAfter.status, "silent");
  assert.equal(commit.situationAfter.handling?.mode, "silent");
  assert.equal(commit.situationAfter.resolvedSeq, 640);
  assert.equal(commit.entry.summaryText, "No response — Cascadia's leader didn't say anything (seq 500)");
  for (const banned of ["ignored", "missed", "overdue", "failed to respond"]) {
    assert.ok(!commit.entry.summaryText.toLowerCase().includes(banned), `banned copy: ${banned}`);
  }
});

check("S5b an NPC's silent mode: the NPC is the actor, with its mandate citation", () => {
  const situation = questionSituation();
  const commit = buildSilenceCommit({
    situation,
    producingMode: "npc-silent-mode",
    ownerUid: OWNER,
    npcId: NPC,
    mandateId: "mand-1",
    mandateVersion: 2,
    cityName: "Cascadia",
    resolvedSeq: 641,
    resolvedByResolutionId: "res-641",
    now: NOW2,
  });
  assert.equal(commit.entry.actor.type, "npc");
  assert.equal(commit.entry.actor.npcId, NPC);
  assert.equal(commit.entry.actor.onBehalfOfMemberId, OWNER);
  assert.equal(commit.entry.actor.mandateId, "mand-1");
  assert.equal(commit.entry.actor.mandateVersion, 2);
});

check("S5c the silence plan validates and writes ONLY its situation doc (§8.1(3))", () => {
  const situation = questionSituation();
  const snapshot = snap({ [`sim_situations/${situation.situationId}`]: situation as unknown as Record<string, unknown> });
  const plan = emptyPlan(null);
  const commit = applySilenceCommit(plan, snapshot, {
    situation,
    producingMode: "owner-explicit",
    ownerUid: OWNER,
    cityName: "Cascadia",
    resolvedSeq: 642,
    resolvedByResolutionId: "res-642",
    now: NOW2,
  });
  assert.equal(silencePlanWritesOnlySituation(plan, situation.situationId), true);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].summary, true);
  validate(plan, snapshot);
  assert.equal(commit.situationAfter.status, "silent");
  assert.equal(silenceSummaryText("Cascadia", null), "No response — Cascadia's leader didn't say anything (seq ?)");
});

// ---------------------------------------------------------------------------
// S6 — evaluation order + rule fires (§7.2, §1.3 step 4)
// ---------------------------------------------------------------------------

check("S6a Dana step 1: a broad always-wait fence beats a specific act-for-me rule", () => {
  const situation = questionSituation();
  const fence = rule({ ruleId: "rule-fence", priority: 99, alwaysWait: true, handler: { npcId: null, mode: "wait-for-owner", mandateId: null } });
  const specific = rule({ ruleId: "rule-specific", priority: 1, match: { situationKinds: ["question"] } });
  const out = evaluateDelegation({ situation, rules: [specific, fence], authorityFor: () => authority() });
  assert.equal(out.outcome, "wait");
  if (out.outcome === "wait") assert.equal(out.rule.ruleId, "rule-fence");
});

check("S6b steps 2–3: specificity beats priority; priority breaks specificity ties", () => {
  const created = planSituationUpsert(null, proposalInput({ detail: { counterpartyCityId: OTHER_CITY, amountRubars: 500 } }));
  if (created.action !== "create") throw new Error("setup");
  const situation = created.doc;
  const broad = rule({ ruleId: "rule-broad", priority: 1, match: { situationKinds: ["proposal"] } });
  const narrow = rule({ ruleId: "rule-narrow", priority: 50, match: { situationKinds: ["proposal"], counterpartyCityIds: [OTHER_CITY] } });
  const out = evaluateDelegation({ situation, rules: [broad, narrow], authorityFor: () => authority() });
  assert.equal(out.outcome, "fire");
  if (out.outcome === "fire") assert.equal(out.rule.ruleId, "rule-narrow");
  const tieA = rule({ ruleId: "rule-tie-a", priority: 5, match: { situationKinds: ["proposal"] } });
  const tieB = rule({ ruleId: "rule-tie-b", priority: 2, match: { situationKinds: ["proposal"] } });
  const tie = evaluateDelegation({ situation, rules: [tieA, tieB], authorityFor: () => authority() });
  assert.equal(tie.outcome, "fire");
  if (tie.outcome === "fire") assert.equal(tie.rule.ruleId, "rule-tie-b");
});

check("S6c no match (and inactive/disabled/foreign-city rules never apply) leaves the card open", () => {
  const situation = questionSituation();
  const other = rule({ ruleId: "rule-incident", match: { situationKinds: ["incident"] } });
  assert.equal(evaluateDelegation({ situation, rules: [other], authorityFor: () => authority() }).outcome, "no-match");
  const disabled = rule({ status: "disabled" });
  const pendingVersion = rule({ status: "pending" });
  const foreignCity = rule({ cityId: OTHER_CITY });
  assert.equal(evaluateDelegation({ situation, rules: [disabled, pendingVersion, foreignCity], authorityFor: () => authority() }).outcome, "no-match");
});

check("S6d fire citations are complete: rule, mandate, NPC — on the fire, the handling, and the entry", () => {
  const created = planSituationUpsert(null, proposalInput({
    detail: {
      counterpartyCityId: OTHER_CITY,
      amountRubars: 500,
      delegatedAction: { actionType: "advance_project", structuredAction: { projectId: "proj-1" }, targetCityIds: [CITY] },
    },
  }));
  if (created.action !== "create") throw new Error("setup");
  const situation = created.doc;
  const theRule = rule({ caps: { perActionRubars: 1000 } });
  const out = evaluateDelegation({ situation, rules: [theRule], authorityFor: () => authority() });
  assert.equal(out.outcome, "fire");
  if (out.outcome !== "fire") return;
  assert.equal(out.fire.kind, "delegated-action");
  assert.equal(out.fire.ruleId, "rule-1");
  assert.equal(out.fire.ruleVersion, 1);
  assert.equal(out.fire.mandateId, "mand-1");
  assert.equal(out.fire.mandateVersion, 2);
  assert.equal(out.fire.npcId, NPC);
  const snapshot = snap({ [`sim_situations/${situation.situationId}`]: situation as unknown as Record<string, unknown> });
  const plan = emptyPlan(null);
  const applied = applyDelegationFire(plan, snapshot, situation, out.fire, {
    now: NOW2, cityName: "Cascadia", resolvedSeq: 700, resolvedByResolutionId: "res-700", actionId: "act-700",
  });
  assert.equal(applied.situationAfter.status, "delegated");
  const handling = applied.situationAfter.handling;
  assert.equal(handling?.mode, "auto-delegated");
  assert.equal(handling?.delegationRuleId, "rule-1");
  assert.equal(handling?.delegationRuleVersion, 1);
  assert.equal(handling?.mandateId, "mand-1");
  assert.equal(handling?.mandateVersion, 2);
  assert.equal(handling?.npcId, NPC);
  assert.equal(handling?.actionId, "act-700");
  const cls = applied.entry.classification as Record<string, unknown>;
  assert.equal(cls.delegationRuleId, "rule-1");
  assert.equal(cls.delegationRuleVersion, 1);
  assert.equal(cls.fireKind, "delegated-action");
  assert.equal(applied.entry.actor.type, "npc");
  assert.equal(applied.entry.actor.mandateId, "mand-1");
  validate(plan, snapshot);
});

check("S6e ask-first narrows the fire to a draft: envelope out, card awaiting_owner", () => {
  const situation = questionSituation();
  const askRule = rule({ handler: { npcId: NPC, mode: "ask-first", mandateId: "mand-1" } });
  const out = evaluateDelegation({
    situation,
    rules: [askRule],
    authorityFor: () => authority({ mandate: { found: true, rootStatus: "active", version: mandateVersion({ permissionMode: "ask-first" }) } }),
  });
  assert.equal(out.outcome, "fire");
  if (out.outcome !== "fire") return;
  assert.equal(out.fire.kind, "envelope");
  assert.equal(out.fire.envelopeSpec?.threadRef.id, situation.situationId);
  const snapshot = snap({ [`sim_situations/${situation.situationId}`]: situation as unknown as Record<string, unknown> });
  const plan = emptyPlan(null);
  const applied = applyDelegationFire(plan, snapshot, situation, out.fire, {
    now: NOW2, cityName: "Cascadia", resolvedSeq: 701, resolvedByResolutionId: "res-701", taskId: "task-701",
  });
  assert.equal(applied.situationAfter.status, "awaiting_owner");
  assert.equal(applied.situationAfter.handling?.taskId, "task-701");
  validate(plan, snapshot);
});

check("S6f a silence rule fires the §8 commit with the rule cited (producingMode silence-rule)", () => {
  const situation = questionSituation();
  const silentRule = rule({ handler: { npcId: NPC, mode: "silent", mandateId: "mand-1" } });
  const out = evaluateDelegation({ situation, rules: [silentRule], authorityFor: () => authority() });
  assert.equal(out.outcome, "fire");
  if (out.outcome !== "fire") return;
  assert.equal(out.fire.kind, "silence");
  const snapshot = snap({ [`sim_situations/${situation.situationId}`]: situation as unknown as Record<string, unknown> });
  const plan = emptyPlan(null);
  const applied = applyDelegationFire(plan, snapshot, situation, out.fire, {
    now: NOW2, cityName: "Cascadia", resolvedSeq: 702, resolvedByResolutionId: "res-702",
  });
  assert.equal(applied.situationAfter.status, "silent");
  assert.equal(applied.entry.classification?.producingMode, "silence-rule");
  assert.equal(applied.entry.classification?.delegationRuleId, "rule-1");
  assert.equal(applied.entry.actor.type, "npc");
  assert.deepEqual(applied.entry.changes, []);
  assert.equal(silencePlanWritesOnlySituation(plan, situation.situationId), true);
  validate(plan, snapshot);
});

check("S6g step 4: a dead mandate blocks the selected rule — no fall-through to a broader live rule", () => {
  const created = planSituationUpsert(null, proposalInput());
  if (created.action !== "create") throw new Error("setup");
  const situation = created.doc;
  const specificDead = rule({ ruleId: "rule-specific-dead", priority: 1, match: { situationKinds: ["proposal"], counterpartyCityIds: [OTHER_CITY] }, handler: { npcId: NPC, mode: "act-for-me", mandateId: "mand-dead" } });
  const broadLive = rule({ ruleId: "rule-broad-live", priority: 9, match: { situationKinds: ["proposal"] }, handler: { npcId: NPC, mode: "act-for-me", mandateId: "mand-1" } });
  const out = evaluateDelegation({
    situation,
    rules: [broadLive, specificDead],
    authorityFor: (r) =>
      r.ruleId === "rule-specific-dead"
        ? authority({ mandate: { found: true, rootStatus: "revoked", version: null } })
        : authority(),
  });
  assert.equal(out.outcome, "blocked-handler-authority-changed");
  if (out.outcome === "blocked-handler-authority-changed") {
    assert.equal(out.rule.ruleId, "rule-specific-dead");
    assert.match(out.reason, /revoked/);
  }
});

check("S6h step 4: over-cap escalates whole; Tier B escalates for act-for-me but drafts under ask-first", () => {
  const money = planSituationUpsert(null, proposalInput({ detail: { counterpartyCityId: OTHER_CITY, amountRubars: 5000 } }));
  if (money.action !== "create") throw new Error("setup");
  const capped = rule({ caps: { perActionRubars: 100 } });
  const overCap = evaluateDelegation({ situation: money.doc, rules: [capped], authorityFor: () => authority() });
  assert.equal(overCap.outcome, "escalate");
  if (overCap.outcome === "escalate") assert.equal(overCap.code, "over-cap");

  const binding = buildProposalSituation({
    cityId: CITY, audienceCityId: CITY, audienceOwnerUidsSnapshot: [OWNER], severity: "important",
    createdSeq: 800, now: NOW, sourceSeq: 799, sourceResolutionId: "res-799",
    sourceKind: "treaty", sourceId: "treaty-9", title: "Sign the grain treaty", summary: "Acceptance binds Cascadia.",
    counterpartyCityId: OTHER_CITY, ruleIds: ["R-12"], classes: ["binding-act"],
  });
  assert.equal(situationTierB(binding).tierB, true);
  assert.deepEqual(situationTierB(binding).via, ["rule R-12", "class binding-act"]);
  const actRule = rule({ match: { situationKinds: ["proposal"] } });
  const tierAct = evaluateDelegation({ situation: binding, rules: [actRule], authorityFor: () => authority() });
  assert.equal(tierAct.outcome, "escalate");
  if (tierAct.outcome === "escalate") assert.equal(tierAct.code, "tier-b");
  const askRule = rule({ handler: { npcId: NPC, mode: "ask-first", mandateId: "mand-1" } });
  const tierAsk = evaluateDelegation({ situation: binding, rules: [askRule], authorityFor: () => authority() });
  assert.equal(tierAsk.outcome, "fire");
  if (tierAsk.outcome === "fire") {
    assert.equal(tierAsk.fire.kind, "envelope");
    assert.equal(tierAsk.fire.tierB.tierB, true);
  }
  // Escalation cards carry their Tier B evidence in detail (§5.5 producer).
  const esc = buildEscalationSituation({
    cityId: CITY, audienceCityId: CITY, audienceOwnerUidsSnapshot: [OWNER], severity: "important",
    createdSeq: 801, now: NOW, sourceSeq: 799, sourceResolutionId: "res-799",
    npcId: NPC, mandateId: "mand-1", mandateVersion: 2, failedCheck: "tier-b", actionType: "sign_treaty",
    ruleIds: ["R-12"], classes: ["binding-act"], via: ["rule R-12"], preparedDraftRef: null,
    title: "Your steward could not sign the grain treaty", summary: "Signing is yours alone; the draft is attached.",
  });
  assert.equal(esc.kind, "escalation");
  assert.equal(situationTierB(esc).tierB, true);
});

// ---------------------------------------------------------------------------
// S7 — ripening occasions (GAP-1): the spec rides the pending; the
// ripening mints the card (Pattern P)
// ---------------------------------------------------------------------------

check("S7a the occasion spec reads off the pending's payloadSpec; malformed reads as none", () => {
  const pending = {
    payloadSpec: {
      occasion: {
        kind: "system", severity: "routine", title: "Installment 3 of loan L-1 is due",
        summary: "Installment 3 (250 R) of loan L-1 is due.", detail: { loanId: "L-1", installment: 3, amountRubars: 250 },
        cityId: CITY, audienceCityId: null, recipientUid: OWNER,
      },
    },
  };
  const spec = occasionSpecFromPending(pending);
  assert.ok(spec);
  assert.equal(spec.kind, "system");
  assert.equal(spec.recipientUid, OWNER);
  assert.equal(occasionSpecFromPending({ payloadSpec: {} }), null);
  assert.equal(occasionSpecFromPending({ payloadSpec: { occasion: { kind: "system", severity: "loud" } } }), null);
  assert.equal(occasionSpecFromPending({ payloadSpec: null }), null);
});

check("S7b the ripening mints a Pattern P card: source = the pending; citations unspoofable", () => {
  const spec = occasionSpecFromPending({
    payloadSpec: {
      occasion: {
        kind: "system", severity: "routine", title: "Installment 3 of loan L-1 is due",
        summary: "Installment 3 (250 R) of loan L-1 is due.",
        detail: { loanId: "L-1", pendingId: "SPOOF", originSeq: -1 },
        cityId: CITY, audienceCityId: null, recipientUid: OWNER,
      },
    },
  });
  assert.ok(spec);
  const card = buildRipeningOccasionSituation({
    pending: { pendingId: "pend-loan-3", originSeq: 900 },
    spec,
    ripeningSeq: 1500,
    ripeningResolutionId: "res-1500",
    audienceOwnerUidsSnapshot: [OWNER],
    createdSeq: 1500,
    now: NOW2,
  });
  assert.equal(card.kind, "system");
  assert.equal(card.source.kind, "system");
  assert.equal(card.source.sourceId, "pend-loan-3");
  assert.equal(card.source.sourceSeq, 1500);
  const detail = card.detail as Record<string, unknown>;
  assert.equal(detail.pendingId, "pend-loan-3");
  assert.equal(detail.originSeq, 900);
  assert.equal(detail.loanId, "L-1");
  // Re-fire of the same ripening lands on the same card (refresh);
  // the NEXT installment's pending mints a distinct card.
  const refire = planSituationUpsert(card, {
    cityId: spec.cityId, audienceCityId: spec.audienceCityId, audienceOwnerUidsSnapshot: [OWNER],
    recipientUid: spec.recipientUid, kind: spec.kind, severity: spec.severity, title: spec.title,
    summary: spec.summary, detail: card.detail, source: card.source, createdSeq: 1500, now: NOW2,
  });
  assert.equal(refire.action, "refresh");
  const next = buildRipeningOccasionSituation({
    pending: { pendingId: "pend-loan-4", originSeq: 900 },
    spec,
    ripeningSeq: 1600, ripeningResolutionId: "res-1600",
    audienceOwnerUidsSnapshot: [OWNER], createdSeq: 1600, now: NOW2,
  });
  assert.notEqual(next.situationId, card.situationId);
});

// ---------------------------------------------------------------------------
// S8 — Pattern X episode cards + corporation-subject spillover (GAP-2)
// ---------------------------------------------------------------------------

check("S8a episode keying: one open card per (subject, episode); accumulation supersedes", () => {
  const first = buildIncidentSituation({
    cityId: CITY, audienceCityId: CITY, audienceOwnerUidsSnapshot: [OWNER], severity: "major",
    createdSeq: 2000, now: NOW, sourceSeq: 1999, sourceResolutionId: "res-1999",
    title: "Your bank bounced a custodial payment",
    summary: "A withdrawal was rejected for insufficient unencumbered cash.",
    consequenceSummary: "The payment did not move; the claim stands.",
    ask: "Recapitalize (B-09) or face liquidation (B-10).",
    subject: { kind: "corporation", id: "bank-corp-1" },
    episode: { subjectKey: "bank:bank-corp-1", episodeClass: "failed-payment" },
  });
  assert.equal(first.source.kind, "system");
  assert.equal(first.source.sourceId, "bank:bank-corp-1:failed-payment");
  assert.deepEqual((first.detail as Record<string, unknown>).subject, { kind: "corporation", id: "bank-corp-1" });
  const second = buildIncidentSituation({
    cityId: CITY, audienceCityId: CITY, audienceOwnerUidsSnapshot: [OWNER], severity: "major",
    createdSeq: 2100, now: NOW2, sourceSeq: 2099, sourceResolutionId: "res-2099",
    title: "Your bank bounced a custodial payment",
    summary: "A second rejection while the episode stands.",
    consequenceSummary: "Two rejections now stand in this episode.",
    ask: "Recapitalize (B-09) or face liquidation (B-10).",
    subject: { kind: "corporation", id: "bank-corp-1" },
    episode: { subjectKey: "bank:bank-corp-1", episodeClass: "failed-payment" },
  });
  second.detail = { ...(second.detail as Record<string, unknown>), episodeCount: 2 };
  const upsert = planSituationUpsert(first, {
    cityId: second.cityId, audienceCityId: second.audienceCityId,
    audienceOwnerUidsSnapshot: second.audienceOwnerUidsSnapshot, recipientUid: second.recipientUid,
    kind: second.kind, severity: second.severity, title: second.title, summary: second.summary,
    detail: second.detail, source: second.source, createdSeq: 2100, now: NOW2,
  });
  // Same dedupeKey (episode identity), newer event: the open card is
  // superseded by the accumulated one — never two open episode cards.
  assert.equal(upsert.action, "supersede-and-create");
  if (upsert.action === "supersede-and-create") {
    assert.equal(upsert.supersededDoc.situationId, first.situationId);
    assert.notEqual(upsert.doc.situationId, first.situationId);
    assert.equal((upsert.doc.detail as Record<string, unknown>).episodeCount, 2);
    assert.equal(upsert.doc.dedupeKey, first.dedupeKey);
  }
  // The curing event terminals the open card as handled (§1.3 K2).
  if (upsert.action === "supersede-and-create") {
    const cured = markSituationHandled(upsert.doc, { resolvedSeq: 2200, resolvedByResolutionId: "res-cure", decidedAt: NOW2 });
    assert.equal(cured.doc.status, "handled");
  }
});

console.log(`situations-harness: all ${checks} checks passed`);
