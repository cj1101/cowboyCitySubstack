/**
 * Unit harness for lib/sim/rules/allocation.ts — pure logic only, no
 * Firebase, no emulator. Run: npx tsx lib/sim/rules/allocation.test.ts
 *
 * Drives the REAL resolver (resolveAction → handler → validatePlan →
 * finalizePlan) over hand-built snapshots, with the R-35 descriptor
 * patched into the registry — simulating the Build Lead's one assembly
 * edit, which is the only integration this module waits on. The
 * emulator battery (P4-G1-C3 against the real preview path, H-P45-3)
 * runs in the play-core suite at assembly; the cases here are the same
 * seven refusals plus the state/authority/staleness battery, proven
 * against the pure contract.
 *
 * Pins:
 * - the commit plan's exact write set (city stats, allocation commit
 *   fields, first version record) and the TC-D04 anchor entry pair;
 * - preview/commit plan parity (identical planHash in both modes);
 * - P4-K2's locks (pool 400, bounds 0–80, sum exactly 400, eight
 *   indices only, stocks never allocatable);
 * - one-commit-ever, the stale-draft binding (§3.4), authority (§3.1).
 */

import assert from "node:assert/strict";

import { ALLOCATABLE_STATS } from "../../allocation/stats";
import { buildAllocationCommitAction } from "../../allocation/commitAction";
import { PRODUCTION_BASELINE_REGISTRY } from "../baseline/registry";
import { sha256Hex } from "../canonical";
import { buildActionDoc } from "../intake";
import { resolveAction } from "../resolver";
import {
  templateStats,
  buildSimCityDoc,
  buildSimStatAllocationsDoc,
} from "../template";
import type { ResolutionPlan, SimAction, SimActor, SimSnapshot } from "../state";
import {
  ACTION_KIND_INDEX,
  RULE_DESCRIPTORS,
  type RuleDescriptor,
} from "./registry";
import {
  ALLOCATABLE_INDEX_KEYS,
  STOCK_KEYS,
  allocationDescriptor,
  allocationReadPlan,
  validateAllocationCommitMap,
} from "./allocation";

// Simulate the Lead's registry assembly edit (this module's PR does not
// touch registry.ts; the play-core CI battery runs against the real one).
(RULE_DESCRIPTORS as Record<string, RuleDescriptor>)["R-35"] = allocationDescriptor;
ACTION_KIND_INDEX["allocate_season0"] = "R-35";

const CITY = "cityA";
const OWNER = "ownerA";
const NOW = "2026-10-19T12:00:00.000Z";
const AT = new Date("2026-10-19T00:00:00.000Z");

const NEUTRAL: Record<string, number> = {
  spirit: 50, culture: 50, infrastructure: 50, stability: 50,
  law: 50, influence: 50, military: 50, defense: 50,
};
const SPECIALIST: Record<string, number> = {
  spirit: 20, culture: 20, infrastructure: 80, stability: 40,
  law: 40, influence: 40, military: 80, defense: 80,
};

function hashOf(map: Record<string, number>): string {
  const sum = Object.values(map).reduce((a, b) => a + b, 0);
  return sha256Hex({ allocations: map, spentPoints: sum });
}

function cityDoc(shared = false): Record<string, unknown> {
  return buildSimCityDoc({
    factionId: CITY,
    faction: { slug: "city-a", name: "City A" },
    seedCityId: null,
    sharedCityId: shared ? CITY : null,
    createdAtSeq: 2,
    now: AT,
  });
}

function allocDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...buildSimStatAllocationsDoc(CITY, AT),
    status: "draft",
    allocations: { ...SPECIALIST },
    spentPoints: 400,
    draftVersion: 3,
    draftHash: hashOf(SPECIALIST),
    authorUid: OWNER,
    ...overrides,
  };
}

function snapshot(
  docs: Record<string, Record<string, unknown> | null>,
  lastSeq = 41
): SimSnapshot {
  return {
    docs: new Map(Object.entries(docs)),
    heads: [],
    queries: [],
    counterHead: { lastSeq, lastEntryHash: "f".repeat(64) },
    now: NOW,
  };
}

function world(overrides: {
  city?: Record<string, unknown> | null;
  alloc?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
  lastSeq?: number;
} = {}): SimSnapshot {
  const docs: Record<string, Record<string, unknown> | null> = {
    [`sim_cities/${CITY}`]: overrides.city === undefined ? cityDoc() : overrides.city,
    [`factions/${CITY}`]: { ownerUids: [OWNER], slug: "city-a", name: "City A" },
    [`sim_stat_allocations/${CITY}`]:
      overrides.alloc === undefined ? allocDoc() : overrides.alloc,
    [`sim_stat_allocations/${CITY}/versions/v1`]: overrides.version ?? null,
  };
  return snapshot(docs, overrides.lastSeq);
}

function memberActor(uid: string): SimActor {
  return {
    type: "member", memberId: uid, npcId: null, onBehalfOfMemberId: null,
    mandateId: null, mandateVersion: null, envelopeId: null,
  };
}

/** A raw action with a hand-built payload (forged shapes included) —
 * the fabric validator exists for payloads the client builder refuses
 * to construct, so the battery builds them directly. */
function rawAction(payload: Record<string, unknown>, actor: SimActor = memberActor(OWNER)): SimAction {
  const { doc } = buildActionDoc({
    actorUid: actor.memberId ?? "actor",
    clientRequestId: `harness-${Math.random().toString(36).slice(2)}`,
    actor,
    actionType: "allocate_season0",
    actionText: "harness action",
    structuredAction: payload,
    targetCityIds: [CITY],
    now: NOW,
  });
  return doc;
}

function validPayload(map: Record<string, number> = SPECIALIST, draftVersion = 3): Record<string, unknown> {
  return { cityId: CITY, allocations: { ...map }, draftVersion, draftHash: hashOf(map) };
}

function resolve(action: SimAction, snap: SimSnapshot, mode: "preview" | "commit" = "preview"): ResolutionPlan {
  return resolveAction(snap, action, { baselineRegistry: PRODUCTION_BASELINE_REGISTRY, mode });
}

function expectReject(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
}

function main(): void {
  // --- Cross-module pins --------------------------------------------------
  assert.deepEqual([...ALLOCATABLE_INDEX_KEYS], [...ALLOCATABLE_STATS],
    "handler index list == client module list == Vera's eight");
  const templateKeys = Object.keys(templateStats());
  for (const key of ALLOCATABLE_INDEX_KEYS) assert.ok(templateKeys.includes(key));
  for (const key of STOCK_KEYS) {
    assert.ok(templateKeys.includes(key), `stock ${key} is a real template stat`);
    assert.ok(!(ALLOCATABLE_INDEX_KEYS as readonly string[]).includes(key), "stocks disjoint from indices");
  }
  assert.equal(validateAllocationCommitMap(null).ok, false);
  assert.equal(validateAllocationCommitMap([1, 2]).ok, false);

  // --- Read plan ----------------------------------------------------------
  const plan0 = allocationReadPlan({ action: rawAction(validPayload()), seedDocs: new Map() });
  assert.deepEqual(plan0.paths, [
    `sim_stat_allocations/${CITY}`,
    `sim_stat_allocations/${CITY}/versions/v1`,
  ]);

  // --- The valid commit, built by the REAL client builder -----------------
  const built = buildAllocationCommitAction({
    cityId: CITY,
    values: {
      spirit: 20, culture: 20, infrastructure: 80, stability: 40,
      law: 40, influence: 40, military: 80, defense: 80,
    },
    authorUid: OWNER, draftVersion: 3, now: NOW,
  });
  const snap = world();
  const preview = resolve(built.doc, snap, "preview");
  assert.equal(preview.outcome, "resolved");
  const commit = resolve(built.doc, snap, "commit");
  assert.equal(commit.planHash, preview.planHash, "preview/commit parity: identical plan, identical hash");
  assert.ok(preview.planHash.length === 64);

  const writes = new Map(preview.writes.map((w) => [w.path, w]));
  assert.equal(preview.writes.length, 3, "city + allocation + version, nothing else");
  const cityAfter = writes.get(`sim_cities/${CITY}`)?.afterDoc as Record<string, unknown>;
  assert.deepEqual(cityAfter.stats, { ...templateStats(), ...SPECIALIST },
    "the eight values land in sim_cities.stats; stocks stay untouched (nulls and zeroes)");
  const allocAfter = writes.get(`sim_stat_allocations/${CITY}`)?.afterDoc as Record<string, unknown>;
  assert.equal(allocAfter.status, "committed");
  assert.deepEqual(allocAfter.allocations, SPECIALIST);
  assert.equal(allocAfter.spentPoints, 400);
  assert.equal(allocAfter.commitActionId, built.doc.actionId);
  assert.equal(allocAfter.committedSeq, 43, "summary seq = counter head 41 + 2 entries");
  assert.equal(allocAfter.committedByUid, OWNER);
  const versionWrite = writes.get(`sim_stat_allocations/${CITY}/versions/v1`);
  assert.equal(versionWrite?.op, "create");
  const versionAfter = versionWrite?.afterDoc as Record<string, unknown>;
  assert.equal(versionAfter.cityId, CITY);
  assert.equal(versionAfter.source, "first_login");
  assert.deepEqual(versionAfter.allocations, SPECIALIST);
  assert.equal(versionAfter.spentPoints, 400);
  assert.equal(versionAfter.draftVersion, 3);
  assert.equal(versionAfter.draftHash, hashOf(SPECIALIST));
  assert.equal(versionAfter.authorUid, OWNER);
  assert.equal(versionAfter.commitSeq, 43);
  assert.equal(versionAfter.previewHash, null, "null in the plan by design (manifest carries the bound hash)");

  assert.equal(preview.entries.length, 2, "the TC-D04 anchor pair: rule-effect + summary");
  const [effect, summary] = preview.entries;
  assert.equal(effect.kind, "rule-effect");
  assert.equal(effect.changes.length, 8);
  assert.ok(effect.changes.every((c) => c.before === null), "pre-allocation indices are null (K-4)");
  assert.deepEqual(
    effect.changes.map((c) => c.field),
    ALLOCATABLE_INDEX_KEYS.map((k) => `stats.${k}`)
  );
  assert.deepEqual(effect.recordsCreated, [`sim_stat_allocations/${CITY}/versions/v1`]);
  assert.equal(summary.kind, "action-summary");
  assert.equal(summary.summary, true);
  assert.match(effect.summaryText, /sum exactly 400/);

  // commit_requested is a valid pre-state (the committer queued it).
  const queued = resolve(built.doc, world({ alloc: allocDoc({ status: "commit_requested" }) }));
  assert.equal(queued.outcome, "resolved");

  // --- P4-G1-C3: the seven-case commit battery (forged payloads) ----------
  // Each world carries the SAME map as a properly bound draft, so the
  // refusal under test is the map validation itself, not staleness.
  const worldForMap = (map: Record<string, number>): SimSnapshot => {
    const sum = Object.values(map).reduce((a, b) => a + b, 0);
    return world({
      alloc: allocDoc({ allocations: { ...map }, spentPoints: sum, draftHash: hashOf(map) }),
    });
  };
  const case399 = { ...NEUTRAL, spirit: 49 };
  expectReject(resolve(rawAction(validPayload(case399)), worldForMap(case399)), "SUM_NOT_EXACT");
  const case401 = { ...NEUTRAL, spirit: 51 };
  expectReject(resolve(rawAction(validPayload(case401)), worldForMap(case401)), "SUM_NOT_EXACT");
  const case81 = { ...NEUTRAL, spirit: 81 };
  expectReject(resolve(rawAction(validPayload(case81)), worldForMap(case81)), "VALUE_OUT_OF_BOUNDS");
  const caseNeg = { ...NEUTRAL, culture: -1 };
  expectReject(resolve(rawAction(validPayload(caseNeg)), worldForMap(caseNeg)), "VALUE_OUT_OF_BOUNDS");
  const caseFrac = { ...NEUTRAL, law: 50.5 };
  expectReject(resolve(rawAction(validPayload(caseFrac)), worldForMap(caseFrac)), "NON_INTEGER_VALUE");
  const caseStock = { ...NEUTRAL, treasuryRubars: 0 };
  expectReject(resolve(rawAction(validPayload(caseStock)), worldForMap(caseStock)), "STOCK_NOT_ALLOCATABLE");
  const caseForeign = { ...NEUTRAL, charisma: 10 };
  expectReject(resolve(rawAction(validPayload(caseForeign)), worldForMap(caseForeign)), "UNKNOWN_STAT_KEY");

  // Completeness: a 7-key map summing to 400 still refuses (§3.3 writes all eight).
  const sevenKeys: Record<string, number> = {
    spirit: 80, culture: 80, infrastructure: 80, stability: 80, law: 80, influence: 0, military: 0,
  };
  expectReject(resolve(rawAction(validPayload(sevenKeys)), worldForMap(sevenKeys)), "MISSING_STAT");

  // --- State, staleness, authority ---------------------------------------
  expectReject(resolve(rawAction(validPayload()), world({
    alloc: allocDoc({ status: "committed", committedSeq: 9 }),
  })), "ALREADY_COMMITTED");
  expectReject(resolve(rawAction(validPayload()), world({
    alloc: allocDoc({ status: "superseded" }),
  })), "ALLOCATION_SUPERSEDED");
  expectReject(resolve(rawAction(validPayload()), world({ alloc: null })), "NO_ALLOCATION_DOC");
  expectReject(resolve(rawAction(validPayload()), world({ city: null })), "NO_CITY");
  expectReject(resolve(rawAction(validPayload()), world({
    alloc: allocDoc({ pointBudget: null }),
  })), "POOL_NOT_STAMPED");

  // Stale draft: the saved draft moved to v4 after the action was built.
  expectReject(resolve(rawAction(validPayload(SPECIALIST, 3)), world({
    alloc: allocDoc({ draftVersion: 4 }),
  })), "STALE_DRAFT");
  // Same version, different hash — also a moved draft.
  expectReject(resolve(rawAction(validPayload(SPECIALIST, 3)), world({
    alloc: allocDoc({ draftHash: hashOf(NEUTRAL) }),
  })), "STALE_DRAFT");
  // Bound reference, wrong map: the payload map does not hash to the draft.
  expectReject(resolve(rawAction({
    cityId: CITY, allocations: { ...NEUTRAL }, draftVersion: 3, draftHash: hashOf(SPECIALIST),
  }), world()), "DRAFT_HASH_MISMATCH");
  // Unsaved map against the pristine doc (v0 / empty-draft hash over
  // spentPoints null): the binding matches the empty draft, the map is
  // not the empty draft's map — cannot commit an unsaved build.
  const EMPTY_HASH = sha256Hex({ allocations: {}, spentPoints: null });
  expectReject(resolve(rawAction({
    cityId: CITY, allocations: { ...SPECIALIST }, draftVersion: 0, draftHash: EMPTY_HASH,
  }), world({
    alloc: allocDoc({ status: "not_started", allocations: {}, spentPoints: null, draftVersion: 0, draftHash: EMPTY_HASH, authorUid: null }),
  })), "DRAFT_HASH_MISMATCH");

  // Non-owner.
  expectReject(resolve(rawAction(validPayload(), memberActor("mallory")), world()), "AUTHORITY_REVOKED");

  // Shared city: a member/owner actor is not enough; the mayor's
  // shared-office actor commits, and is recorded as the committer.
  const sharedSnap = world({ city: cityDoc(true) });
  expectReject(resolve(rawAction(validPayload()), sharedSnap), "AUTHORITY_REVOKED");
  const mayorActor: SimActor = {
    type: "shared-office", office: "mayor", memberId: "mayor1", npcId: null,
    onBehalfOfMemberId: null, mandateId: null, mandateVersion: null, envelopeId: null,
  };
  const mayorPlan = resolve(rawAction(validPayload(), mayorActor), sharedSnap);
  assert.equal(mayorPlan.outcome, "resolved");
  const mayorAlloc = mayorPlan.writes.find((w) => w.path === `sim_stat_allocations/${CITY}`)?.afterDoc as Record<string, unknown>;
  assert.equal(mayorAlloc.committedByUid, "mayor1");

  // A version record already standing over an uncommitted control doc
  // is an inconsistency, not a commit waiting to happen.
  expectReject(resolve(rawAction(validPayload()), world({
    version: { cityId: CITY, source: "first_login", commitSeq: 9 },
  })), "VERSION_EXISTS");

  console.log("lib/sim/rules/allocation: all assertions passed");
}

main();
