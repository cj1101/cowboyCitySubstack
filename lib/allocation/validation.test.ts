/**
 * Unit tests for lib/allocation — pure logic only, no Firebase, no DOM.
 * Run: npx tsx lib/allocation/validation.test.ts
 *
 * Pins:
 * - Vera's locks (pool 400, bounds 0..80, exact-sum commit rule, R-35);
 * - the draft payload fitting the Phase 1 rules fence exactly;
 * - the browser canonical port reproducing the Phase 1 fabric hash
 *   (golden vector: EMPTY_DRAFT_HASH from lib/sim/template.ts).
 */

import assert from "node:assert/strict";

import { canonicalJson, computeDraftHash } from "./canonical";
import {
  DRAFT_WRITABLE_FIELDS,
  buildCommitRequestFields,
  buildDraftSaveFields,
  buildVersionSnapshotFields,
} from "./draft";
import { ALLOCATION_MAX, POINT_BUDGET } from "./stats";
import {
  emptyAllocation,
  isCommittable,
  neutralAllocation,
  normalizeAllocation,
  remainingPoints,
  sumPoints,
  validateAllocation,
  validateAllocationMap,
} from "./validation";

async function main(): Promise<void> {
  // --- Pool arithmetic -------------------------------------------------
  assert.equal(POINT_BUDGET, 400);
  assert.equal(sumPoints(emptyAllocation()), 0);
  assert.equal(sumPoints(neutralAllocation()), 400, "neutral city = 8 x 50 = pool");
  assert.equal(remainingPoints(neutralAllocation()), 0);
  assert.equal(remainingPoints(emptyAllocation()), 400);

  // --- Commit validation (R-35) ----------------------------------------
  assert.equal(isCommittable(neutralAllocation()), true);
  assert.equal(isCommittable(emptyAllocation()), false);

  const specialist = {
    ...emptyAllocation(),
    military: 80,
    defense: 80,
    infrastructure: 80,
    stability: 40,
    law: 40,
    influence: 40,
    culture: 20,
    spirit: 20,
  };
  assert.equal(sumPoints(specialist), 400);
  assert.equal(isCommittable(specialist), true, "lopsided-but-exact build commits");

  const maxed = { ...neutralAllocation(), spirit: 100 };
  assert.ok(
    validateAllocation(maxed).some((i) => i.code === "above-max"),
    "a starting 100 is refused: top fifth is earned space"
  );

  const fractional = { ...neutralAllocation(), law: 50.5 };
  assert.ok(validateAllocation(fractional).some((i) => i.code === "non-integer"));

  const unspent = validateAllocation(emptyAllocation(), { requireExactSum: true });
  assert.equal(unspent.length, 1);
  assert.equal(unspent[0].code, "sum-under");
  assert.match(unspent[0].message, /400 unspent points/);
  assert.match(unspent[0].message, /not banked/);

  const overspentValues = { ...neutralAllocation(), spirit: 80, culture: 80 };
  const overIssues = validateAllocation(overspentValues, { requireExactSum: true });
  assert.ok(overIssues.some((i) => i.code === "sum-over" && /60 points over/.test(i.message)));

  // Draft-grade validation (no exact sum) accepts partial drafts.
  assert.equal(validateAllocation(emptyAllocation()).length, 0);

  // --- Raw map validation ----------------------------------------------
  const unknown = validateAllocationMap({ spirit: 10, gdpRubars: 50 });
  assert.ok(unknown.some((i) => i.code === "unknown-key" && i.stat === "gdpRubars"),
    "stocks are never allocatable and are named as such");
  assert.deepEqual(normalizeAllocation({ spirit: 10 }), {
    ...emptyAllocation(),
    spirit: 10,
  });
  assert.ok(Number.isNaN(normalizeAllocation({ spirit: "lots" }).spirit));

  // --- Draft payload fits the Phase 1 rules fence exactly ---------------
  const draft = buildDraftSaveFields({
    values: neutralAllocation(),
    authorUid: "uid-owner",
    previousDraftVersion: 0,
    draftHash: "deadbeef",
  });
  assert.equal(draft.status, "draft");
  assert.equal(draft.draftVersion, 1);
  assert.equal(draft.spentPoints, 400);
  const fence = new Set<string>(DRAFT_WRITABLE_FIELDS);
  for (const key of Object.keys(draft)) {
    assert.ok(fence.has(key), `draft field ${key} is inside the rules fence`);
  }
  for (const forbidden of [
    "baselineHash",
    "baselineStats",
    "pointBudget",
    "commitActionId",
    "committedSeq",
    "committedByUid",
    "cityId",
  ]) {
    assert.ok(!(forbidden in draft), `draft payload never carries ${forbidden}`);
  }
  assert.throws(
    () =>
      buildDraftSaveFields({
        values: { ...neutralAllocation(), defense: ALLOCATION_MAX + 1 },
        authorUid: "uid-owner",
        previousDraftVersion: 0,
        draftHash: "deadbeef",
      }),
    /Invalid allocation draft/
  );

  // --- Commit request builder -------------------------------------------
  const commit = buildCommitRequestFields({
    values: specialist,
    authorUid: "uid-owner",
    previousDraftVersion: 3,
    draftHash: "cafef00d",
  });
  assert.equal(commit.status, "commit_requested");
  assert.equal(commit.draftVersion, 4);
  assert.throws(
    () =>
      buildCommitRequestFields({
        values: emptyAllocation(),
        authorUid: "uid-owner",
        previousDraftVersion: 0,
        draftHash: "cafef00d",
      }),
    /not committable/
  );

  // --- Version snapshot shape -------------------------------------------
  const version = buildVersionSnapshotFields({
    values: neutralAllocation(),
    authorUid: "uid-owner",
    draftVersion: 1,
    draftHash: "deadbeef",
  });
  assert.equal(version.source, "first_login");
  assert.equal(version.commitSeq, null);
  assert.equal(version.previewHash, null);

  // --- Canonical port == fabric hashes ----------------------------------
  assert.equal(
    canonicalJson({ allocations: {}, spentPoints: null }),
    '{"allocations":{},"spentPoints":null}'
  );
  assert.equal(
    canonicalJson({ b: 1, a: { d: [1, 2], c: null } }),
    '{"a":{"c":null,"d":[1,2]},"b":1}',
    "keys sort recursively; arrays keep order"
  );
  const emptyDraftHash = await computeDraftHash({}, null);
  assert.equal(
    emptyDraftHash,
    "a57492f80041da4a56253deb01eb2ef4075c1468df0c498bf407e3b7be4603fe",
    "golden vector: Phase 1 EMPTY_DRAFT_HASH (lib/sim/template.ts)"
  );

  console.log("lib/allocation: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
