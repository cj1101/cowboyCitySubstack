/**
 * NPC core — standalone node assertion harness.
 *
 * Run:  npx tsx lib/npcs/harness/npc-core-harness.ts
 *
 * No Firestore, no emulator, no network: the module is pure, so the
 * harness feeds it plain fixtures and asserts on the records, hashes,
 * and plans that come back. Cases:
 *
 *   N1  Default-mode assignment (P5-K3: fresh NPC = ask-first)
 *   N2  Mandate hash stability + golden vectors (canonical cross-check
 *       against node:crypto, an independent digest path)
 *   N3  Freeform-definition acceptance (CJ openness; TC-N14/N17) and
 *       the one content rule (no numeric personality, Vera §8.2)
 *   N4  Attribution shape (brief §3.2; Vera §6; exactly one authority
 *       root; in-character is member + characterId; NO "character"
 *       actor type ever)
 *   N5  Narrowest-wins mode precedence + the §2.4 semantics table
 *   N6  Negotiation-bounds requirement (Vera §8.4 layer 1)
 *   N7  Expiry / horizon / version-in-force — pure seq predicates
 *   N8  Roster derivation (TC-N08) + plan byte-shape parity
 *   N9  The NPC-to-character link (P5-K13 item 1; brief §2.1)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../../sim/canonical";
import type { SimSnapshot } from "../../sim/state";
import {
  DEFAULT_PERMISSION_MODE,
  MANDATE_GOLDEN_VECTORS,
  NpcCoreError,
  buildMandateRoot,
  buildMandateVersion,
  buildNpcCreate,
  canonicalActorForm,
  deriveTeamActivity,
  deriveTeamRoster,
  isInCharacterActor,
  mandateHash,
  memberActor,
  memberInCharacterActor,
  narrowestMode,
  npcActorEnvelope,
  npcActorStanding,
  planNpcActivate,
  planNpcCreate,
  resolveVersionInForce,
  triggerCitation,
  validateNpcAttribution,
  type MandateVersionInput,
  type NpcCreateInput,
  type SimNpc,
} from "../index";

const NOW = new Date("2026-10-18T12:00:00.000Z");

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof NpcCoreError && err.code === code);
}

const PERSONALITY = {
  traits: ["unflappable", "keeps immaculate ledgers"],
  voiceNotes: "dry, precise",
  characterNotes: null,
};

function npcInput(overrides: Partial<NpcCreateInput> = {}): NpcCreateInput {
  return {
    characterId: "char-steward-1",
    cityId: "cascadia",
    ownerUid: "uid-owner-1",
    displayNameSnapshot: "Mabel Okafor",
    titleFreeform: "Steward",
    personality: PERSONALITY,
    scopeFreeform: "Keep the granary accounts tidy.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// N1 — default-mode assignment
// ---------------------------------------------------------------------------

console.log("N1 default-mode assignment (P5-K3)");
check("adopted default is ask-first", () => {
  assert.equal(DEFAULT_PERMISSION_MODE, "ask-first");
});
check("omitted mode at creation defaults to ask-first", () => {
  assert.equal(buildNpcCreate(npcInput(), NOW).permissionMode, "ask-first");
  assert.equal(buildNpcCreate(npcInput({ permissionMode: null }), NOW).permissionMode, "ask-first");
});
check("explicit modes are preserved verbatim", () => {
  assert.equal(buildNpcCreate(npcInput({ permissionMode: "act-for-me" }), NOW).permissionMode, "act-for-me");
  assert.equal(buildNpcCreate(npcInput({ permissionMode: "silent" }), NOW).permissionMode, "silent");
});
check("fresh record posture: pending_activation, no mandate, stateVersion 1", () => {
  const npc = buildNpcCreate(npcInput(), NOW);
  assert.equal(npc.status, "pending_activation");
  assert.equal(npc.currentMandateId, null);
  assert.equal(npc.currentMandateVersion, null);
  assert.equal(npc.activationSeq, null);
  assert.equal(npc.stateVersion, 1);
});

// ---------------------------------------------------------------------------
// N2 — mandate hash stability + golden vectors
// ---------------------------------------------------------------------------

console.log("N2 mandate hash stability + golden vectors");
for (const vector of MANDATE_GOLDEN_VECTORS) {
  check(`golden vector: ${vector.name}`, () => {
    // The fabric's canonical hash over the fixed payload…
    assert.equal(sha256Hex(vector.payload), vector.sha256);
    // …cross-checked against node:crypto, an independent digest of the
    // same canonical string (canonical.ts claims byte-identity; the
    // golden vectors make any breakage loud).
    const independent = createHash("sha256").update(canonicalJson(vector.payload)).digest("hex");
    assert.equal(independent, vector.sha256);
  });
}
check("builder-produced version hashes to the golden digest (vector 1)", () => {
  const payload = MANDATE_GOLDEN_VECTORS[0].payload;
  const built = buildMandateVersion(payload as unknown as MandateVersionInput, NOW);
  assert.equal(built.mandateHash, MANDATE_GOLDEN_VECTORS[0].sha256);
});
check("builder-produced version hashes to the golden digest (vector 2, named extra cap)", () => {
  const payload = MANDATE_GOLDEN_VECTORS[1].payload;
  const built = buildMandateVersion(payload as unknown as MandateVersionInput, NOW);
  assert.equal(built.mandateHash, MANDATE_GOLDEN_VECTORS[1].sha256);
});
check("key order is irrelevant (canonical form sorts)", () => {
  const payload = MANDATE_GOLDEN_VECTORS[0].payload;
  const reversed: Record<string, unknown> = {};
  for (const key of Object.keys(payload).reverse()) reversed[key] = payload[key];
  assert.equal(mandateHash(reversed as unknown as MandateVersionInput), MANDATE_GOLDEN_VECTORS[0].sha256);
});
check("status/effective fields are excluded from the hash", () => {
  const pending = buildMandateVersion(MANDATE_GOLDEN_VECTORS[0].payload as unknown as MandateVersionInput, NOW);
  const effective = { ...pending, effectiveSeq: 42, supersededSeq: 99 };
  assert.equal(mandateHash(effective), pending.mandateHash);
});
check("mutating any authority field changes the hash", () => {
  const base = MANDATE_GOLDEN_VECTORS[0].payload;
  const mutated = { ...base, scopeFreeform: "Keep the granary accounts tidy. Also, everything else." };
  assert.notEqual(sha256Hex(mutated), MANDATE_GOLDEN_VECTORS[0].sha256);
  const mutatedCap = {
    ...base,
    caps: { ...(base.caps as Record<string, unknown>), perActionRubars: 1 },
  };
  assert.notEqual(sha256Hex(mutatedCap), MANDATE_GOLDEN_VECTORS[0].sha256);
});

// ---------------------------------------------------------------------------
// N3 — freeform-definition acceptance
// ---------------------------------------------------------------------------

console.log("N3 freeform-definition acceptance (CJ openness)");
check("an unheard-of title, template, and scope pass verbatim (TC-N14/N17)", () => {
  const npc = buildNpcCreate(
    npcInput({
      titleFreeform: "Grand Vizier of Absolutely Everything (Unpaid) — 3rd of Her Name 🌾",
      roleTemplate: "not-a-real-template-xyz",
      scopeFreeform: "Line one.\nLine two — whatever the owner wrote, unicode ✓ and all.",
    }),
    NOW
  );
  assert.equal(npc.titleFreeform, "Grand Vizier of Absolutely Everything (Unpaid) — 3rd of Her Name 🌾");
  assert.equal(npc.roleTemplate, "not-a-real-template-xyz");
  assert.ok(npc.scopeFreeform.startsWith("Line one.\nLine two"));
});
check("a numeric anywhere inside personality is rejected (Vera §8.2)", () => {
  const bad = {
    traits: ["calm"],
    voiceNotes: null,
    characterNotes: null,
    patience: 9,
  } as unknown as NpcCreateInput["personality"];
  throwsCode(() => buildNpcCreate(npcInput({ personality: bad }), NOW), "NUMERIC_PERSONALITY");
});
check("non-string traits are rejected", () => {
  const bad = { traits: ["calm", 7], voiceNotes: null, characterNotes: null } as unknown as NpcCreateInput["personality"];
  throwsCode(() => buildNpcCreate(npcInput({ personality: bad }), NOW), "INVALID_PERSONALITY");
});

// ---------------------------------------------------------------------------
// N4 — attribution shape
// ---------------------------------------------------------------------------

console.log("N4 attribution shape (brief §3.2; Vera §6)");
check("standing-path actor carries exactly the mandate citation", () => {
  const actor = npcActorStanding({
    npcId: "char-steward-1",
    ownerUid: "uid-owner-1",
    mandateId: "mandate-1",
    mandateVersion: 2,
  });
  assert.equal(actor.type, "npc");
  assert.equal(actor.npcId, "char-steward-1");
  assert.equal(actor.onBehalfOfMemberId, "uid-owner-1");
  assert.equal(actor.mandateId, "mandate-1");
  assert.equal(actor.mandateVersion, 2);
  assert.equal(actor.envelopeId, null);
  assert.equal(actor.memberId, null);
  assert.deepEqual(validateNpcAttribution(actor), []);
});
check("envelope-path actor carries exactly the envelope citation", () => {
  const actor = npcActorEnvelope({ npcId: "char-envoy-7", ownerUid: "uid-owner-2", envelopeId: "task-9" });
  assert.equal(actor.mandateId, null);
  assert.equal(actor.mandateVersion, null);
  assert.equal(actor.envelopeId, "task-9");
  assert.deepEqual(validateNpcAttribution(actor), []);
});
check("both authority roots — or neither — fails validation", () => {
  const both = { ...npcActorStanding({ npcId: "n", ownerUid: "u", mandateId: "m", mandateVersion: 1 }), envelopeId: "t" };
  assert.ok(validateNpcAttribution(both).length > 0);
  const neither = { ...npcActorEnvelope({ npcId: "n", ownerUid: "u", envelopeId: "t" }), envelopeId: null };
  assert.ok(validateNpcAttribution(neither).length > 0);
  const versionless = { ...npcActorStanding({ npcId: "n", ownerUid: "u", mandateId: "m", mandateVersion: 1 }), mandateVersion: null };
  assert.ok(validateNpcAttribution(versionless).length > 0);
});
check("in-character handling is member + characterId, never NPC (Vera §6 rule 4)", () => {
  const actor = memberInCharacterActor("uid-owner-1", "char-steward-1");
  assert.equal(actor.type, "member");
  assert.equal(actor.memberId, "uid-owner-1");
  assert.equal(actor.characterId, "char-steward-1");
  assert.equal(actor.npcId, null);
  assert.ok(isInCharacterActor(actor));
  assert.ok(!isInCharacterActor(memberActor("uid-owner-1")));
});
check("characterId absent ≡ null in canonical form (P5-K13)", () => {
  const absent = canonicalActorForm(memberActor("uid-owner-1"));
  const presentNull = canonicalActorForm({ ...memberActor("uid-owner-1"), characterId: null });
  assert.deepEqual(absent, presentNull);
  assert.equal(absent.characterId, null);
});
check("no builder ever emits a \"character\" actor type (Vera §6 rule 2)", () => {
  const types = [
    memberActor("u").type,
    memberInCharacterActor("u", "c").type,
    npcActorStanding({ npcId: "n", ownerUid: "u", mandateId: "m", mandateVersion: 1 }).type,
    npcActorEnvelope({ npcId: "n", ownerUid: "u", envelopeId: "t" }).type,
  ];
  for (const t of types) {
    assert.ok(["member", "npc", "shared-office", "contest", "system"].includes(t), `landed enum only, got ${t}`);
    assert.notEqual(t, "character");
  }
});
check("a routine without a causing event is refused (TC-N03)", () => {
  throwsCode(() => triggerCitation("mandate-routine", null, null), "TRIGGER_WITHOUT_CAUSE");
  const ok = triggerCitation("mandate-routine", 123, null);
  assert.equal(ok.sourceSeq, 123);
});

// ---------------------------------------------------------------------------
// N5 — narrowest-wins + mode semantics
// ---------------------------------------------------------------------------

console.log("N5 narrowest-wins (brief §2.4; P5-D3)");
check("the narrowest source governs", () => {
  assert.equal(narrowestMode(["act-for-me", "ask-first"]), "ask-first");
  assert.equal(narrowestMode(["act-for-me", "silent"]), "silent");
  assert.equal(narrowestMode(["ask-first", null, undefined]), "ask-first");
  assert.equal(narrowestMode(["act-for-me"]), "act-for-me");
});
check("no source anywhere is silent, not an error", () => {
  assert.equal(narrowestMode([]), "silent");
  assert.equal(narrowestMode([null, undefined]), "silent");
});

// ---------------------------------------------------------------------------
// N6 — negotiation bounds (Vera §8.4)
// ---------------------------------------------------------------------------

console.log("N6 negotiation-bounds requirement");
const ENVOY_INPUT: MandateVersionInput = {
  version: 1,
  npcId: "char-envoy-7",
  cityId: "chess-city",
  ownerUid: "uid-owner-2",
  permissionMode: "act-for-me",
  scopeFreeform: "Carry routine trade talk.",
  structuredScope: {
    triggerKinds: ["situation"],
    allowedActionTypes: ["envoy.negotiate"],
    namedRecordIds: [],
    counterpartyCityIds: [],
  },
  caps: {
    perActionRubars: null,
    perResolutionPeriodRubars: null,
    periodDefinition: null,
    maxProjectPhase: null,
    allowPartialExecution: false,
  },
  sourceActionId: "act-envoy-1",
};
check("negotiation work without bounds is rejected at build (layer 1)", () => {
  throwsCode(() => buildMandateVersion(ENVOY_INPUT, NOW), "NEGOTIATION_BOUNDS_REQUIRED");
});
check("negotiation work with bounds builds; non-negotiation work needs none", () => {
  const withBounds = buildMandateVersion(
    { ...ENVOY_INPUT, negotiationBounds: { mayOffer: "up to the line", mayAccept: false, walkAwayIf: null, maxTurns: 3 } },
    NOW
  );
  assert.equal(withBounds.negotiationBounds?.maxTurns, 3);
  const plain = buildMandateVersion(
    { ...ENVOY_INPUT, structuredScope: { ...ENVOY_INPUT.structuredScope, allowedActionTypes: ["R-05"] } },
    NOW
  );
  assert.equal(plain.negotiationBounds, null);
});
check("over-cap partial execution defaults to refused-whole (TC-N05)", () => {
  const built = buildMandateVersion(
    { ...ENVOY_INPUT, structuredScope: { ...ENVOY_INPUT.structuredScope, allowedActionTypes: ["R-05"] } },
    NOW
  );
  assert.equal(built.caps.allowPartialExecution, false);
});

// ---------------------------------------------------------------------------
// N7 — expiry / horizon / version-in-force (pure seq predicates)
// ---------------------------------------------------------------------------

console.log("N7 seq predicates (brief §2.3)");
function versionFixture(version: number, effectiveSeq: number, supersededSeq: number | null, extra: Partial<MandateVersionInput> = {}) {
  const built = buildMandateVersion(
    {
      version,
      npcId: "char-steward-1",
      cityId: "cascadia",
      ownerUid: "uid-owner-1",
      permissionMode: "ask-first",
      scopeFreeform: "Steward the granary.",
      structuredScope: { triggerKinds: ["log-event"], allowedActionTypes: ["R-11"], namedRecordIds: [], counterpartyCityIds: null },
      caps: { perActionRubars: null, perResolutionPeriodRubars: null, periodDefinition: null, maxProjectPhase: null, allowPartialExecution: false },
      sourceActionId: `act-v${version}`,
      ...extra,
    },
    NOW
  );
  return { ...built, effectiveSeq, supersededSeq };
}
check("the version in force at a seq is the one whose window covers it", () => {
  const v1 = versionFixture(1, 10, 50);
  const v2 = versionFixture(2, 50, null);
  const root = { ...buildMandateRoot("mandate-1", v1, NOW), status: "active" as const, createdSeq: 10 };
  assert.equal(resolveVersionInForce(root, [v1, v2], 30).version?.version, 1);
  assert.equal(resolveVersionInForce(root, [v1, v2], 60).version?.version, 2);
  assert.equal(resolveVersionInForce(root, [v1, v2], 5).reason, "no-version-effective");
});
check("revocation and expiry are derived from seq, and inputs are not mutated", () => {
  const v1 = versionFixture(1, 10, null, { expiresAtSeq: 900 });
  const root = { ...buildMandateRoot("mandate-1", v1, NOW), status: "active" as const, createdSeq: 10, revokedSeq: 800 };
  const before = JSON.stringify([root, v1]);
  assert.equal(resolveVersionInForce(root, [v1], 850).reason, "revoked");
  const rootUnrevoked = { ...root, revokedSeq: null };
  assert.equal(resolveVersionInForce(rootUnrevoked, [v1], 899).reason, "current");
  assert.equal(resolveVersionInForce(rootUnrevoked, [v1], 900).reason, "expired");
  assert.equal(JSON.stringify([root, v1]), before);
});
check("horizon exhaustion is a count predicate", () => {
  const v1 = versionFixture(1, 10, null, { horizonActions: 2 });
  const root = { ...buildMandateRoot("mandate-1", v1, NOW), status: "active" as const, createdSeq: 10 };
  assert.equal(resolveVersionInForce(root, [v1], 20, 1).reason, "current");
  assert.equal(resolveVersionInForce(root, [v1], 20, 2).reason, "horizon-exhausted");
});

// ---------------------------------------------------------------------------
// N8 — roster derivation + plan byte-shape parity
// ---------------------------------------------------------------------------

console.log("N8 roster derivation + plan shape");
check("roster holds one owner's non-retired NPCs; foreign records reported (TC-N08)", () => {
  const mine = { ...buildNpcCreate(npcInput(), NOW), status: "active" as const, activationSeq: 10 };
  const retired = { ...buildNpcCreate(npcInput({ characterId: "char-old-1" }), NOW), status: "retired" as const };
  const foreign = { ...buildNpcCreate(npcInput({ characterId: "char-foreign-1", ownerUid: "uid-other" }), NOW), status: "active" as const };
  const { team, foreignRecords } = deriveTeamRoster("cascadia", "uid-owner-1", [mine, retired, foreign], null, 20, NOW);
  assert.deepEqual(team.npcIds, ["char-steward-1"]);
  assert.equal(foreignRecords.length, 1);
  assert.equal(team.stateVersion, 1);
});
check("team activity derives: resting / staffed / active", () => {
  const active = { ...buildNpcCreate(npcInput(), NOW), status: "active" as const, activationSeq: 10 };
  const byId = new Map<string, SimNpc>([[active.npcId, active]]);
  const { team } = deriveTeamRoster("cascadia", "uid-owner-1", [active], null, 20, NOW);
  assert.equal(deriveTeamActivity(team, byId), "staffed");
  const mandated = { ...active, currentMandateId: "mandate-1", currentMandateVersion: 1 };
  byId.set(mandated.npcId, mandated);
  assert.equal(deriveTeamActivity(team, byId), "active");
  assert.equal(deriveTeamActivity(null, byId), "resting");
});
function emptySnapshot(): SimSnapshot {
  return {
    docs: new Map(),
    heads: [],
    counterHead: { lastSeq: 0, lastEntryHash: "" },
    now: NOW.toISOString(),
  };
}
check("npc.create plan is byte-shaped like a resolver plan", () => {
  const plan = planNpcCreate(emptySnapshot(), npcInput(), NOW);
  assert.equal(plan.outcome, "resolved");
  assert.equal(plan.planHash, ""); // committer's finalizePlan fills it
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].path, "sim_npcs/char-steward-1");
  assert.equal(plan.writes[0].op, "create");
  assert.equal(plan.writes[0].recordClass, "state");
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0].summary, true);
  assert.equal(plan.entries[0].kind, "action-summary");
  assert.equal(plan.entries[0].actor.type, "member");
});
check("activation plan flips the record and derives the roster in one plan", () => {
  const pending = buildNpcCreate(npcInput(), NOW);
  const docs = new Map<string, Record<string, unknown> | null>();
  docs.set("sim_npcs/char-steward-1", { ...pending });
  const snapshot: SimSnapshot = { ...emptySnapshot(), docs };
  const plan = planNpcActivate(snapshot, pending, [pending], 42, NOW);
  assert.equal(plan.writes.length, 2);
  const npcWrite = plan.writes.find((w) => w.path === "sim_npcs/char-steward-1");
  const teamWrite = plan.writes.find((w) => w.path === "sim_teams/cascadia");
  assert.equal(npcWrite?.op, "update");
  assert.equal((npcWrite?.afterDoc as unknown as SimNpc).status, "active");
  assert.equal((npcWrite?.afterDoc as unknown as SimNpc).activationSeq, 42);
  assert.equal(teamWrite?.op, "create");
  assert.deepEqual((teamWrite?.afterDoc as { npcIds: string[] }).npcIds, ["char-steward-1"]);
});

// ---------------------------------------------------------------------------
// N9 — the NPC-to-character link (P5-K13; brief §2.1)
// ---------------------------------------------------------------------------

console.log("N9 NPC-to-character link");
check("doc id is the linked character's id; the record cites it", () => {
  const npc = buildNpcCreate(npcInput({ characterId: "char-existing-9" }), NOW);
  assert.equal(npc.npcId, "char-existing-9");
  assert.equal(npc.characterId, "char-existing-9");
});
check("a characterless creation mints one id used in both places", () => {
  const npc = buildNpcCreate(npcInput({ characterId: null, mintedCharacterId: "char-minted-3" }), NOW);
  assert.equal(npc.npcId, "char-minted-3");
  assert.equal(npc.characterId, "char-minted-3");
});
check("both-or-neither link inputs are refused", () => {
  throwsCode(() => buildNpcCreate(npcInput({ mintedCharacterId: "char-x" }), NOW), "AMBIGUOUS_CHARACTER_LINK");
  throwsCode(() => buildNpcCreate(npcInput({ characterId: null, mintedCharacterId: null }), NOW), "MISSING_CHARACTER_LINK");
});

console.log(`\nNPC core harness: ${passed} checks passed.`);
