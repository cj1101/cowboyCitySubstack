/**
 * Authority stage — standalone node assertion harness.
 *
 * Run:  npx tsx lib/authority/harness/authority-harness.ts
 *
 * No Firestore, no emulator, no network: the module is pure, so the
 * harness feeds it plain record fixtures and asserts on verdicts.
 * Cases:
 *
 *   A1  Grant evaluation: act-for-me inside scope/caps resolves with a
 *       mandate citation (the §3.1 traceability root)
 *   A2  Cap excess escalates (per-action money refuses the whole act;
 *       period excess honors allowPartialExecution)
 *   A3  Scope excess escalates: unlisted type / record / counterparty
 *   A4  Revocation & currency: revoked, superseded-citation, seq
 *       expiry, horizon expiry all reject; execution-time
 *       revalidation terminates authority_changed (TC-N09)
 *   A5  Modes: silent → silence; ask-first → draft-only; delegation-
 *       rule narrowing wins over an act-for-me version (P5-D3)
 *   A6  Tier B escalates even when the mandate lists the act (R-12,
 *       ballot class, alwaysEscalate) — there is no "full authority"
 *   A7  Fairness fence: foreign state change blocked; read-collection
 *       is not alteration; same-owner second city is not foreign
 *   A8  Shared city (CJ round 3): mayor's NPC resolves Tier A; vice
 *       mayor draft-only; faction co-owner (the landed
 *       checkCityAuthority trap) draft-only; mayor's NPC Tier B still
 *       escalates
 *   A9  Never-bind roots: envelope-cited actor cannot resolve; orphan
 *       actor (no root) fails the form check
 *   A10 Revocation boundary (Nadia F-11): reaches actions, NOT
 *       ripenings / pending effects / resolved entries
 *   A11 Mandate hash: lifecycle stamps don't move it; scope tampering
 *       does — and fails evaluation closed
 *   A12 Negotiation check 7: within-bounds resolves; OUT OF BOUNDS,
 *       walk-away, and turn-budget excess all escalate labeled
 *   A13 View assembly from a SimSnapshot: terms record drives the
 *       shared-city branch end-to-end
 */

import assert from "node:assert/strict";
import type { SimSnapshot } from "../../sim/state";
import { npcActorEnvelope, npcActorStanding } from "../actor";
import { computeMandateHash } from "../mandate";
import { evaluateDelegatedAction } from "../evaluate";
import {
  REVOCATION_COVERAGE,
  evaluateRevocationImpact,
  executionTimeRevalidation,
  revocationReaches,
} from "../revocation";
import { authorityViewFromSnapshot } from "../view";
import type {
  AuthorityTrigger,
  AuthorityView,
  CityAuthorityContext,
  DelegatedActionAttempt,
  MandateRootRecord,
  MandateScope,
  MandateVersionRecord,
  NpcRecord,
  PermissionMode,
} from "../types";

// ---------------------------------------------------------------------------
// Fixtures — three owners, three cities, one shared city whose faction
// doc lists EVERYONE as co-owner (the landed trap: only terms decide).
// ---------------------------------------------------------------------------

const MAYOR = "uid-c";
const VICE = "uid-d";
const OWNER_A = "uid-a";
const OWNER_B = "uid-b";

function city(
  cityId: string,
  ownerUids: string[],
  extra?: Partial<CityAuthorityContext>
): CityAuthorityContext {
  return { cityId, ownerUids, isSharedCity: false, mayorUid: null, viceMayorUid: null, ...extra };
}

const CITIES = new Map<string, CityAuthorityContext>([
  ["cascadia", city("cascadia", [OWNER_A])],
  ["evan-city", city("evan-city", [OWNER_B])],
  ["a-second-city", city("a-second-city", [OWNER_A])],
  [
    "cowboy-city",
    city("cowboy-city", [OWNER_A, OWNER_B, MAYOR, VICE], {
      isSharedCity: true,
      mayorUid: MAYOR,
      viceMayorUid: VICE,
    }),
  ],
]);

function makeScope(overrides?: Partial<MandateScope>): MandateScope {
  return {
    allowedActionTypes: ["project.advance", "report.file", "survey.run"],
    namedRecordIds: ["proj-1"],
    counterpartyCityIds: ["evan-city"],
    perActionRubars: 500,
    perPeriodRubars: 1000,
    perPeriodActions: 5,
    periodDefinition: "per 100 seq",
    maxProjectPhase: 3,
    triggerKinds: ["log-event", "standing-routine", "owner-envelope"],
    negotiationBounds: null,
    alwaysEscalate: [],
    allowPartialExecution: false,
    ...overrides,
  };
}

function makeVersion(overrides?: Partial<MandateVersionRecord>): MandateVersionRecord {
  const v: MandateVersionRecord = {
    mandateId: "m-steward",
    version: 1,
    status: "active",
    mode: "act-for-me",
    scope: makeScope(),
    expiresAtSeq: null,
    horizonActions: null,
    effectiveSeq: 10,
    revokedSeq: null,
    mandateHash: "",
    createdByUid: OWNER_A,
    ...overrides,
  };
  v.mandateHash = computeMandateHash(v);
  return v;
}

function makeNpc(overrides?: Partial<NpcRecord>): NpcRecord {
  return {
    npcId: "npc-steward",
    characterId: "char-steward",
    cityId: "cascadia",
    ownerUid: OWNER_A,
    permissionMode: "act-for-me",
    status: "active",
    currentMandateId: "m-steward",
    currentMandateVersion: 1,
    activationSeq: 5,
    retiredSeq: null,
    ...overrides,
  };
}

const ROOT: MandateRootRecord = {
  mandateId: "m-steward",
  npcId: "npc-steward",
  cityId: "cascadia",
  ownerUid: OWNER_A,
  currentVersion: 1,
};

function makeView(overrides?: Partial<AuthorityView>): AuthorityView {
  return {
    npc: makeNpc(),
    mandateRoot: ROOT,
    mandateVersion: makeVersion(),
    cities: CITIES,
    periodUsage: { delegatedResolutions: 0, delegatedRubars: 0 },
    ruleMode: null,
    atSeq: 50,
    ...overrides,
  };
}

function makeAttempt(overrides?: Partial<DelegatedActionAttempt>): DelegatedActionAttempt {
  return {
    actionType: "project.advance",
    ruleIds: ["R-05"],
    classes: [],
    cityId: "cascadia",
    targetCityIds: ["cascadia"],
    namedRecordIds: ["proj-1"],
    counterpartyCityIds: [],
    rubarMovement: 200,
    projectPhase: 2,
    effectClass: "state-change",
    ownerConfirmedDelegated: false,
    proseStructuredConflict: null,
    negotiation: null,
    ...overrides,
  };
}

const TRIGGER: AuthorityTrigger = {
  kind: "log-event",
  sourceSeq: 40,
  sourceId: "log-entry-40",
  routineName: null,
  envelopeId: null,
};

const actorFor = (npc: NpcRecord, version = 1) => npcActorStanding(npc, "m-steward", version);

// A1 — grant evaluation resolves with the citation.
{
  const verdict = evaluateDelegatedAction(makeView(), actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(verdict.disposition, "resolve");
  if (verdict.disposition === "resolve") {
    assert.equal(verdict.citation.mandateId, "m-steward");
    assert.equal(verdict.citation.mandateVersion, 1);
    assert.equal(verdict.citation.mode, "act-for-me");
  }
  console.log("A1 ok — act-for-me inside scope/caps resolves under a mandate citation");
}

// A2 — cap excess escalates; single-action money excess refuses partial.
{
  const over = evaluateDelegatedAction(
    makeView(), actorFor(makeNpc()), makeAttempt({ rubarMovement: 600 }), TRIGGER
  );
  assert.equal(over.disposition, "escalate");
  if (over.disposition === "escalate") {
    assert.match(over.failedCheck, /scope\/caps/);
    assert.equal(over.allowPartialExecution, false); // §5.3(b): whole action refuses
  }
  const periodView = makeView({
    mandateVersion: makeVersion({ scope: makeScope({ allowPartialExecution: true }) }),
    periodUsage: { delegatedResolutions: 1, delegatedRubars: 950 },
  });
  const period = evaluateDelegatedAction(periodView, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(period.disposition, "escalate");
  if (period.disposition === "escalate") {
    assert.equal(period.allowPartialExecution, true); // version permits the in-scope remainder
    assert.ok(period.scopeFailures.some((f) => f.includes("period")));
  }
  console.log("A2 ok — cap excess escalates; money excess refuses partial, period excess honors the flag");
}

// A3 — scope excess escalates with the excess named.
{
  for (const attempt of [
    makeAttempt({ actionType: "structure.build" }),
    makeAttempt({ namedRecordIds: ["proj-9"] }),
    makeAttempt({ counterpartyCityIds: ["a-second-city"] }),
  ]) {
    const verdict = evaluateDelegatedAction(makeView(), actorFor(makeNpc()), attempt, TRIGGER);
    assert.equal(verdict.disposition, "escalate");
    if (verdict.disposition === "escalate") assert.ok(verdict.scopeFailures.length > 0);
  }
  console.log("A3 ok — unlisted type / record / counterparty each escalate, excess named");
}

// A4 — revocation and currency failures reject; revalidation agrees.
{
  const revoked = makeView({ mandateVersion: makeVersion({ status: "revoked", revokedSeq: 45 }) });
  const v1 = evaluateDelegatedAction(revoked, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(v1.disposition, "reject");
  if (v1.disposition === "reject") assert.equal(v1.code, "AUTHORITY_REVOKED");

  const superseded = makeView({ mandateRoot: { ...ROOT, currentVersion: 2 } });
  const v2 = evaluateDelegatedAction(superseded, actorFor(makeNpc(), 1), makeAttempt(), TRIGGER);
  assert.equal(v2.disposition, "reject");
  if (v2.disposition === "reject") assert.equal(v2.code, "MANDATE_NOT_CURRENT");

  const expired = makeView({ mandateVersion: makeVersion({ expiresAtSeq: 50 }) });
  const v3 = evaluateDelegatedAction(expired, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(v3.disposition, "reject");
  if (v3.disposition === "reject") assert.equal(v3.code, "MANDATE_EXPIRED");

  const horizon = makeView({
    mandateVersion: makeVersion({ horizonActions: 3 }),
    periodUsage: { delegatedResolutions: 3, delegatedRubars: 0 },
  });
  const v4 = evaluateDelegatedAction(horizon, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(v4.disposition, "reject");
  if (v4.disposition === "reject") assert.equal(v4.code, "MANDATE_EXPIRED");

  const reval = executionTimeRevalidation(revoked, actorFor(makeNpc()), "cascadia");
  assert.equal(reval.ok, false);
  if (!reval.ok) assert.equal(reval.code, "authority_changed");
  console.log("A4 ok — revoked / superseded / seq-expired / horizon-expired reject; revalidation terminates authority_changed");
}

// A5 — modes and narrowing.
{
  const silentView = makeView({
    npc: makeNpc({ permissionMode: "silent" }),
    mandateVersion: makeVersion({ mode: "silent" }),
  });
  assert.equal(
    evaluateDelegatedAction(silentView, actorFor(makeNpc()), makeAttempt(), TRIGGER).disposition,
    "silence"
  );
  const askView = makeView({
    npc: makeNpc({ permissionMode: "ask-first" }),
    mandateVersion: makeVersion({ mode: "ask-first" }),
  });
  const ask = evaluateDelegatedAction(askView, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(ask.disposition, "draft-only");
  if (ask.disposition === "draft-only") assert.equal(ask.reason, "mode-ask-first");

  // Version says act-for-me; a fired delegation rule narrows to silent.
  const narrowed = evaluateDelegatedAction(
    makeView({ ruleMode: "silent" }), actorFor(makeNpc()), makeAttempt(), TRIGGER
  );
  assert.equal(narrowed.disposition, "silence");
  const narrowedAsk = evaluateDelegatedAction(
    makeView({ ruleMode: "ask-first" }), actorFor(makeNpc()), makeAttempt(), TRIGGER
  );
  assert.equal(narrowedAsk.disposition, "draft-only");
  console.log("A5 ok — silent silences, ask-first drafts, rule narrowing wins (P5-D3)");
}

// A6 — Tier B escalates even inside a permissive mandate.
{
  const broad = makeView({
    mandateVersion: makeVersion({
      scope: makeScope({
        allowedActionTypes: ["treaty.sign", "vote.cast", "report.file"],
        alwaysEscalate: ["report.file"],
      }),
    }),
  });
  const treaty = evaluateDelegatedAction(
    broad, actorFor(makeNpc()),
    makeAttempt({ actionType: "treaty.sign", ruleIds: ["R-12"], namedRecordIds: [], rubarMovement: 0, projectPhase: null }),
    TRIGGER
  );
  assert.equal(treaty.disposition, "escalate");
  if (treaty.disposition === "escalate") assert.match(treaty.failedCheck, /tier/);

  const ballot = evaluateDelegatedAction(
    broad, actorFor(makeNpc()),
    makeAttempt({ actionType: "vote.cast", classes: ["ballot"], namedRecordIds: [], rubarMovement: 0, projectPhase: null }),
    TRIGGER
  );
  assert.equal(ballot.disposition, "escalate");

  const listed = evaluateDelegatedAction(
    broad, actorFor(makeNpc()),
    makeAttempt({ actionType: "report.file", namedRecordIds: [], rubarMovement: 0, projectPhase: null }),
    TRIGGER
  );
  assert.equal(listed.disposition, "escalate");
  console.log("A6 ok — treaty, ballot, and alwaysEscalate-listed acts escalate despite a broad mandate");
}

// A7 — fairness fence.
{
  const foreign = evaluateDelegatedAction(
    makeView(), actorFor(makeNpc()),
    makeAttempt({ targetCityIds: ["evan-city"] }), TRIGGER
  );
  assert.equal(foreign.disposition, "blocked-fairness");

  const collection = evaluateDelegatedAction(
    makeView(), actorFor(makeNpc()),
    makeAttempt({
      actionType: "survey.run", ruleIds: ["R-25"], effectClass: "read-collection",
      targetCityIds: ["evan-city"], namedRecordIds: [], rubarMovement: 0, projectPhase: null,
    }),
    TRIGGER
  );
  assert.equal(collection.disposition, "resolve");

  const ownSecond = evaluateDelegatedAction(
    makeView(), actorFor(makeNpc()),
    makeAttempt({ targetCityIds: ["a-second-city"] }), TRIGGER
  );
  assert.notEqual(ownSecond.disposition, "blocked-fairness");
  console.log("A7 ok — foreign state change blocked; collection reads and same-owner cities pass the fence");
}

// A8 — shared city.
{
  const mayorNpc = makeNpc({ npcId: "npc-mayor-steward", cityId: "cowboy-city", ownerUid: MAYOR });
  const mayorView = makeView({
    npc: mayorNpc,
    mandateRoot: { mandateId: "m-steward", npcId: "npc-mayor-steward", cityId: "cowboy-city", ownerUid: MAYOR, currentVersion: 1 },
    mandateVersion: makeVersion({ createdByUid: MAYOR }),
  });
  const mayorAttempt = makeAttempt({ cityId: "cowboy-city", targetCityIds: ["cowboy-city"] });
  const mayorActor = npcActorStanding(mayorNpc, "m-steward", 1);
  assert.equal(
    evaluateDelegatedAction(mayorView, mayorActor, mayorAttempt, TRIGGER).disposition,
    "resolve"
  );

  const viceNpc = makeNpc({ npcId: "npc-vice", cityId: "cowboy-city", ownerUid: VICE });
  const viceView = makeView({
    npc: viceNpc,
    mandateRoot: { mandateId: "m-steward", npcId: "npc-vice", cityId: "cowboy-city", ownerUid: VICE, currentVersion: 1 },
    mandateVersion: makeVersion({ createdByUid: VICE }),
  });
  const vice = evaluateDelegatedAction(
    viceView, npcActorStanding(viceNpc, "m-steward", 1), mayorAttempt, TRIGGER
  );
  assert.equal(vice.disposition, "draft-only");
  if (vice.disposition === "draft-only") assert.equal(vice.reason, "shared-city-vice-mayor");

  // uid-a IS in the shared city's faction ownerUids — the landed
  // checkCityAuthority would pass them. The terms record must not.
  const coNpc = makeNpc({ npcId: "npc-co", cityId: "cowboy-city", ownerUid: OWNER_A });
  const coView = makeView({
    npc: coNpc,
    mandateRoot: { mandateId: "m-steward", npcId: "npc-co", cityId: "cowboy-city", ownerUid: OWNER_A, currentVersion: 1 },
  });
  const co = evaluateDelegatedAction(
    coView, npcActorStanding(coNpc, "m-steward", 1), mayorAttempt, TRIGGER
  );
  assert.equal(co.disposition, "draft-only");
  if (co.disposition === "draft-only") assert.equal(co.reason, "shared-city-non-mayor");

  const mayorBinding = evaluateDelegatedAction(
    mayorView, mayorActor,
    makeAttempt({ cityId: "cowboy-city", targetCityIds: ["cowboy-city"], actionType: "project.advance", ruleIds: ["R-15"], classes: ["binding-act"] }),
    TRIGGER
  );
  assert.equal(mayorBinding.disposition, "escalate");
  console.log("A8 ok — mayor's NPC acts; vice mayor and co-owners draft-only; mayoral Tier B still escalates");
}

// A9 — never-bind roots.
{
  const envActor = npcActorEnvelope(makeNpc(), "env_123");
  const v = evaluateDelegatedAction(makeView(), envActor, makeAttempt(), TRIGGER);
  assert.equal(v.disposition, "reject");
  if (v.disposition === "reject") assert.equal(v.code, "ENVELOPE_ROOT_CANNOT_RESOLVE");

  const orphan = { ...npcActorStanding(makeNpc(), "m-steward", 1), mandateId: null, mandateVersion: null };
  const v2 = evaluateDelegatedAction(makeView(), orphan, makeAttempt(), TRIGGER);
  assert.equal(v2.disposition, "reject");
  if (v2.disposition === "reject") assert.equal(v2.code, "ACTOR_FORM_INVALID");
  console.log("A9 ok — envelope roots cannot resolve; orphan actors fail the form check");
}

// A10 — the F-11 boundary, as executable fact.
{
  assert.equal(REVOCATION_COVERAGE["queued-action"], true);
  assert.equal(revocationReaches("claimed-envelope"), true);
  assert.equal(revocationReaches("standing-trigger"), true);
  assert.equal(revocationReaches("ripening"), false);
  assert.equal(revocationReaches("pending-effect"), false);
  assert.equal(revocationReaches("resolved-entry"), false);
  assert.equal(evaluateRevocationImpact("ripening").effect, "stands-verbatim");
  console.log("A10 ok — revocation reaches actions only; ripenings stand verbatim (F-11 boundary)");
}

// A11 — mandate hash discipline.
{
  const v = makeVersion();
  const stamped = { ...v, status: "revoked" as const, revokedSeq: 99 };
  assert.equal(computeMandateHash(stamped), v.mandateHash); // lifecycle stamps excluded
  const tampered = makeVersion();
  tampered.scope = makeScope({ perActionRubars: 999999 }); // scope changed, hash NOT recomputed
  const view = makeView({ mandateVersion: tampered });
  const verdict = evaluateDelegatedAction(view, actorFor(makeNpc()), makeAttempt(), TRIGGER);
  assert.equal(verdict.disposition, "reject");
  if (verdict.disposition === "reject") assert.equal(verdict.code, "MANDATE_HASH_MISMATCH");
  console.log("A11 ok — hash ignores lifecycle stamps; tampered scope fails closed");
}

// A12 — negotiation bounds diff at check 7.
{
  const bounds = {
    subject: "trade-agreement",
    mayOffer: [{ kind: "rubars", maxAmount: 1000 }],
    mayAccept: [{ kind: "rubars", minAmount: 0, maxAmount: 2000 }],
    walkAwayIf: ["exclusive-dealing-forever"],
    maxTurns: 4,
  };
  const envoyView = makeView({
    mandateVersion: makeVersion({
      scope: makeScope({ allowedActionTypes: ["negotiation.propose"], negotiationBounds: bounds }),
    }),
  });
  const propose = (terms: unknown, turnsUsed: number) =>
    makeAttempt({
      actionType: "negotiation.propose", namedRecordIds: [], rubarMovement: 0, projectPhase: null,
      negotiation: { proposedTerms: terms as never, turnsUsed },
    });
  const within = evaluateDelegatedAction(
    envoyView, actorFor(makeNpc()),
    propose([{ kind: "rubars", side: "offer", amountRubars: 500 }], 2), TRIGGER
  );
  assert.equal(within.disposition, "resolve");
  for (const [terms, turns] of [
    [[{ kind: "rubars", side: "offer", amountRubars: 5000 }], 2],
    [[{ kind: "term", side: "accept", text: "exclusive-dealing-forever" }], 1],
    [[{ kind: "rubars", side: "offer", amountRubars: 500 }], 9],
  ] as const) {
    const out = evaluateDelegatedAction(envoyView, actorFor(makeNpc()), propose(terms, turns), TRIGGER);
    assert.equal(out.disposition, "escalate");
    if (out.disposition === "escalate") assert.ok(out.outOfBounds.length > 0);
  }
  console.log("A12 ok — bounds diff passes within-bounds terms and escalates OUT OF BOUNDS ones");
}

// A13 — view assembly from a snapshot, shared-city branch end to end.
{
  const version = makeVersion({ createdByUid: MAYOR });
  const docs = new Map<string, Record<string, unknown> | null>([
    ["sim_npcs/npc-mayor-steward", { npcId: "npc-mayor-steward", characterId: "char-m", cityId: "cowboy-city", ownerUid: MAYOR, permissionMode: "act-for-me", status: "active", currentMandateId: "m-steward", currentMandateVersion: 1, activationSeq: 5, retiredSeq: null }],
    ["sim_mandates/m-steward", { mandateId: "m-steward", npcId: "npc-mayor-steward", cityId: "cowboy-city", ownerUid: MAYOR, currentVersion: 1 }],
    ["sim_mandates/m-steward/versions/1", version as unknown as Record<string, unknown>],
    ["factions/cowboy-city", { ownerUids: [OWNER_A, OWNER_B, MAYOR, VICE] }],
    ["sim_terms/current", { mayorUid: MAYOR, viceMayorUid: VICE, status: "current" }],
  ]);
  const snapshot: SimSnapshot = {
    docs,
    heads: [],
    queries: [],
    counterHead: { lastSeq: 49, lastEntryHash: "" },
    now: "2026-10-18T00:00:00.000Z",
  };
  const view = authorityViewFromSnapshot(snapshot, {
    npcId: "npc-mayor-steward",
    cityId: "cowboy-city",
    sharedCityId: "cowboy-city",
    termsPath: "sim_terms/current",
    periodUsage: { delegatedResolutions: 0, delegatedRubars: 0 },
  });
  assert.equal(view.atSeq, 50); // lastSeq + 1
  assert.equal(view.cities.get("cowboy-city")?.mayorUid, MAYOR);
  const npc = view.npc as NpcRecord;
  const verdict = evaluateDelegatedAction(
    view,
    npcActorStanding(npc, "m-steward", 1),
    makeAttempt({ cityId: "cowboy-city", targetCityIds: ["cowboy-city"] }),
    TRIGGER
  );
  assert.equal(verdict.disposition, "resolve");
  console.log("A13 ok — snapshot view assembly drives the terms-based shared-city branch");
}

console.log("\nAuthority harness: all cases passed.");
