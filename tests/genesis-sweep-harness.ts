/**
 * Genesis pristine-sweep fix — the Step 2 smoke-doc tolerance.
 *
 * Pure (no emulator): pins `isStep2SmokeStatusDoc`, the shape-exact
 * predicate the post-commit sweep in `lib/sim/genesis.ts` uses to
 * tolerate the one pre-genesis document the runbook designs into the
 * chain — the §2.4 check-4 smoke record at `sim_fabric_status/current`
 * (written by the Step 2 smoke BEFORE Step 3 genesis runs; the
 * 2026-10-30 production genesis committed a correct world and then
 * failed the sweep on exactly this doc — production log §3).
 *
 *   T1  the exact production smoke shape is tolerated (short SHA, as
 *       written by ops-tools/smoke-step2.mjs against the c8cff80
 *       deploy), and a full-length SHA is tolerated too.
 *   T2  location is pinned: the same content at any other doc id is
 *       NOT the designated doc.
 *   T3  content is pinned: wrong/missing source tag, a missing or
 *       extra field, and any non-commit `rulesDeployedFrom` (non-hex,
 *       uppercase, too short, too long, non-string) are all rejected.
 *
 * The end-to-end half — genesis verifies clean with the sanctioned
 * doc pre-seeded, and the sweep still fails on unsanctioned state —
 * lives in tests/genesis-sweep.test.ts (emulator, inside `test:sim`).
 */

import assert from "node:assert/strict";
import {
  STEP2_SMOKE_STATUS_SOURCE,
  isStep2SmokeStatusDoc,
} from "../lib/sim/genesis";

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(3, " ")} — ${label}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// The exact document the Step 2 smoke wrote in production (production
// log §2.3 check 4): POST/PATCH by the committer identity, doc id
// `current`, two fields, rulesDeployedFrom = the deployed tree's SHA.
const PRODUCTION_SMOKE_DOC: Record<string, unknown> = {
  source: "step2-smoke",
  rulesDeployedFrom: "c8cff80",
};

section("T1 — the sanctioned shape is tolerated");
check("the source tag constant is the runbook's tag", () => {
  assert.equal(STEP2_SMOKE_STATUS_SOURCE, "step2-smoke");
});
check("the exact production smoke doc is tolerated", () => {
  assert.equal(isStep2SmokeStatusDoc("current", PRODUCTION_SMOKE_DOC), true);
});
check("a full-length (40-hex) commit id is tolerated", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", {
      source: "step2-smoke",
      rulesDeployedFrom: "c8cff80aa7a81a5cc27589f4338deabc67c10474",
    }),
    true
  );
});

section("T2 — location is pinned to the designated doc");
check("identical content at another doc id is NOT tolerated", () => {
  assert.equal(isStep2SmokeStatusDoc("other", PRODUCTION_SMOKE_DOC), false);
  assert.equal(isStep2SmokeStatusDoc("current2", PRODUCTION_SMOKE_DOC), false);
});

section("T3 — content deviations are all rejected");
check("a spoofed status doc (no smoke fields) is rejected", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", { note: "spoofed status" }),
    false
  );
});
check("a wrong source tag is rejected", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", {
      source: "step3-smoke",
      rulesDeployedFrom: "c8cff80",
    }),
    false
  );
});
check("a missing rulesDeployedFrom is rejected", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", { source: "step2-smoke" }),
    false
  );
});
check("an extra field is rejected (shape is exact, not a subset)", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", {
      ...PRODUCTION_SMOKE_DOC,
      note: "extra",
    }),
    false
  );
});
check("a non-commit rulesDeployedFrom is rejected", () => {
  for (const bad of [
    "not-a-sha", // non-hex characters
    "C8CFF80", // uppercase — git ids are lowercase hex
    "abc123", // 6 chars — below the short-SHA floor
    "c8cff80aa7a81a5cc27589f4338deabc67c10474ff", // 41 chars — past a full SHA
    "", // empty
  ]) {
    assert.equal(
      isStep2SmokeStatusDoc("current", {
        source: "step2-smoke",
        rulesDeployedFrom: bad,
      }),
      false,
      `expected rejection for ${JSON.stringify(bad)}`
    );
  }
});
check("a non-string rulesDeployedFrom is rejected", () => {
  assert.equal(
    isStep2SmokeStatusDoc("current", {
      source: "step2-smoke",
      rulesDeployedFrom: 1234567,
    }),
    false
  );
});
check("an empty doc is rejected", () => {
  assert.equal(isStep2SmokeStatusDoc("current", {}), false);
});

console.log(`\ngenesis-sweep-harness: ${checks} checks passed`);
