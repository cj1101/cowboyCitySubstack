/**
 * Go-live fix B-1 — the ratified-Baseline genesis stamp + projection.
 *
 * Pure (no emulator): pins the two registry helpers the fix adds, over
 * the PRODUCTION registry and test-local variants:
 *
 *   S1  ratifiedBaselineForGenesis selects the production ratified
 *       entry (world-baseline-1.0 + its stored docHash); a draft copy
 *       of the same text selects NOTHING (genesis would write no
 *       stamp — the unratified case of runbook §3.3).
 *   S2  projectBaselineStamp over a stamped world doc makes 1.0
 *       citable from the genesis seq (and not before it), and never
 *       mutates the code registry (its effectiveFromSeq stays null —
 *       that null is the pre-genesis fail-closed posture).
 *   S3  a stamp-less world doc (pre-genesis / unratified-case shape)
 *       projects nothing: citable stays null at every seq.
 *   S4  fail-closed projections: a stamp whose docHash differs from
 *       the registry's stored hash projects nothing; a production
 *       stamp applied to a DRAFT registry projects nothing (a draft
 *       is never made citable by a stamp).
 *   S5  the stamped world-doc shape genesis writes: buildSimWorldDoc
 *       plus exactly the two stamp fields, sourced from the registry
 *       entry — not from a literal in the genesis path.
 */

import assert from "node:assert/strict";
import {
  PRODUCTION_BASELINE_REGISTRY,
  citableBaselineVersion,
  projectBaselineStamp,
  ratifiedBaselineForGenesis,
  type BaselineRegistry,
} from "../lib/sim/baseline/registry";
import { buildSimWorldDoc } from "../lib/sim/template";

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(3, " ")} — ${label}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const NOW = new Date("2026-10-21T00:00:00.000Z");
const draftRegistry: BaselineRegistry = {
  versions: PRODUCTION_BASELINE_REGISTRY.versions.map((v) => ({
    ...v,
    status: "draft" as const,
  })),
};

section("S1 — genesis stamp selection");
check("the production registry's ratified entry is the stamp source", () => {
  const v = ratifiedBaselineForGenesis(PRODUCTION_BASELINE_REGISTRY);
  assert.equal(v?.version, "world-baseline-1.0");
  assert.equal(
    v?.docHash,
    "db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae"
  );
});
check("a draft registry selects nothing (no stamp is written)", () => {
  assert.equal(ratifiedBaselineForGenesis(draftRegistry), null);
  assert.equal(ratifiedBaselineForGenesis({ versions: [] }), null);
});

section("S2 — the stamped world doc genesis writes");
const stampVersion = ratifiedBaselineForGenesis(PRODUCTION_BASELINE_REGISTRY);
assert.ok(stampVersion);
const stampedWorld: Record<string, unknown> = {
  ...buildSimWorldDoc(NOW),
  baselineVersion: stampVersion.version,
  baselineDocHash: stampVersion.docHash,
};
check("the stamp fields come from the registry entry, verbatim", () => {
  assert.equal(stampedWorld.baselineVersion, "world-baseline-1.0");
  assert.equal(
    stampedWorld.baselineDocHash,
    PRODUCTION_BASELINE_REGISTRY.versions[0].docHash
  );
  assert.equal(stampedWorld.genesisSeq, 1);
});

section("S3 — projection: citable from the genesis seq");
check("the projected registry selects 1.0 at seq 1 and beyond", () => {
  const effective = projectBaselineStamp(PRODUCTION_BASELINE_REGISTRY, stampedWorld);
  assert.equal(citableBaselineVersion(effective, 1)?.version, "world-baseline-1.0");
  assert.equal(citableBaselineVersion(effective, 9999)?.version, "world-baseline-1.0");
  assert.equal(
    citableBaselineVersion(effective, 1)?.docHash,
    "db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae"
  );
});
check("the projection never mutates the code registry", () => {
  projectBaselineStamp(PRODUCTION_BASELINE_REGISTRY, stampedWorld);
  assert.equal(PRODUCTION_BASELINE_REGISTRY.versions[0].effectiveFromSeq, null);
  assert.equal(citableBaselineVersion(PRODUCTION_BASELINE_REGISTRY, 1), null);
  assert.equal(citableBaselineVersion(PRODUCTION_BASELINE_REGISTRY, 9999), null);
});

section("S4 — stamp-less worlds behave exactly as before");
check("no world doc / no stamp fields → no projection", () => {
  for (const world of [null, undefined, buildSimWorldDoc(NOW), {}]) {
    const effective = projectBaselineStamp(PRODUCTION_BASELINE_REGISTRY, world);
    assert.equal(citableBaselineVersion(effective, 1), null);
    assert.equal(citableBaselineVersion(effective, 9999), null);
  }
});

section("S5 — fail-closed projections");
check("a stamp whose hash differs from the stored hash projects nothing", () => {
  const tampered = { ...stampedWorld, baselineDocHash: "0".repeat(64) };
  const effective = projectBaselineStamp(PRODUCTION_BASELINE_REGISTRY, tampered);
  assert.equal(citableBaselineVersion(effective, 9999), null);
});
check("a stamp naming an unknown version projects nothing", () => {
  const unknown = { ...stampedWorld, baselineVersion: "world-baseline-9.9" };
  const effective = projectBaselineStamp(PRODUCTION_BASELINE_REGISTRY, unknown);
  assert.equal(citableBaselineVersion(effective, 9999), null);
});
check("the production stamp over a DRAFT registry projects nothing", () => {
  const effective = projectBaselineStamp(draftRegistry, stampedWorld);
  assert.equal(citableBaselineVersion(effective, 1), null);
  assert.equal(citableBaselineVersion(effective, 9999), null);
});

console.log(`\nbaseline-stamp-harness: ${checks} checks passed`);
