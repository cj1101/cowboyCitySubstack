/**
 * Play-core suite (Phase 4) — Osei's gate annex §4.0 names this file as
 * the Phase 4 CORE / LOGIC / DATA venue, run under the Firestore + Auth
 * emulators in the "Sim core tests (non-required)" CI job via
 * `npm run test:sim` (which runs sim-core first, then this file, in one
 * emulators:exec). Like the engine suite, the sandbox emulator is a
 * known defect, so CI is the venue; local evidence is typecheck/lint
 * plus pure-logic harnesses.
 *
 * Structure: one section per module, in integration order, each mapped
 * to its P4-G rows. Fixture discipline (Osei H-P45-1): fixtures are
 * seeded after genesis and world-changing state is produced through
 * the dispatcher only. The Module 0 section is the named exception that
 * proves the rule's boundary: the data step exists precisely for docs
 * the current builders never touched, so its fixtures seed pre-stamp
 * (Phase 1-shaped) docs directly through the Admin SDK. No resolution
 * state is fabricated anywhere in this suite.
 *
 * Module 0 (this landing): the data step (brief §3.6), the corporation
 * shape (build-prep P4-K11), and the builder half of P4-G1's data half.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from "firebase-admin/firestore";
import {
  buildSimCityDoc,
  buildSimStatAllocationsDoc,
  INITIAL_POINT_BUDGET,
  templateStats,
} from "../lib/sim/template";
import {
  buildCorporationDoc,
  corporationPath,
} from "../lib/sim/corporations";
import {
  applyPhase4DataStep,
  dataStepRemainderHash,
  defaultDefensePosture,
} from "../lib/sim/phase4DataStep";

const PROJECT_ID = "cowboycityrealm";

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "play-core suite requires FIRESTORE_EMULATOR_HOST — run via `npm run test:sim`"
    );
  }
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  const adminApp =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ projectId: PROJECT_ID }, "play-phase4");
  const adminDb: AdminFirestore = getAdminFirestore(adminApp);
  await env.clearFirestore();

  const now = new Date("2026-10-19T00:00:00.000Z");

  // ---- P4 Module 0 (pure): the template builders are born stamped.
  // Brief §12.3 / §3.6: the data step reconciles DATA with code; this is
  // the code half of P4-G1's data half, asserted rather than amended —
  // the Phase 1 build already applied Vera's lock to the builders.
  {
    const alloc = buildSimStatAllocationsDoc("cityA", now);
    assert.equal(alloc.pointBudget, INITIAL_POINT_BUDGET);
    assert.equal(alloc.pointBudget, 400);
    const city = buildSimCityDoc({
      factionId: "cityA",
      faction: { slug: "city-a", name: "City A" },
      seedCityId: null,
      sharedCityId: null,
      createdAtSeq: 0,
      now,
    });
    assert.deepEqual(city.defensePosture, defaultDefensePosture());
    // TC-D04 pre-state: pre-allocation, every index is null — the
    // template invents no value (null-honesty).
    const stats = templateStats() as unknown as Record<string, unknown>;
    for (const key of [
      "spirit",
      "culture",
      "infrastructure",
      "stability",
      "law",
      "influence",
      "military",
      "defense",
      "population",
      "gdpRubars",
    ]) {
      assert.equal(stats[key], null, `${key} must be null pre-allocation`);
    }
  }
  console.log("ok P4 Module 0: template builders stamp pool + posture (P4-G1 data half, builder side)");

  // ---- P4 Module 0 (pure): the corporation record shape (P4-K11).
  {
    const corp = buildCorporationDoc({
      corporationId: "corp1",
      name: "Acme Freight",
      industry: "logistics",
      ownerMemberId: "ownerA",
      founderFigureId: null,
      homeCityId: "cityA",
      valuationRubars: 125_000,
      legacyBookRubars: 125_000,
      sourceActionId: "act1",
      sourceSeq: 42,
      lastResolutionId: "act1",
      now,
    });
    // A-7 first-class fields, founding defaults exact.
    assert.equal(corp.ownerMemberId, "ownerA");
    assert.equal(corp.companyCashRubars, 0);
    assert.deepEqual(corp.taxPayables, {});
    // Brief §1.4: legacy book recorded; listing starts false (M-01/M-02
    // are later acts); the null-GDP skip is representable.
    assert.equal(corp.legacyBookRubars, 125_000);
    assert.equal(corp.listed, false);
    assert.equal(corp.status, "active");
    assert.equal(
      corporationPath("cityA", "corp1"),
      "sim_cities/cityA/corporations/corp1"
    );
    const skipped = buildCorporationDoc({
      corporationId: "corp2",
      name: "Null GDP Co",
      industry: "services",
      ownerMemberId: "ownerB",
      founderFigureId: "fig1",
      homeCityId: "cityB",
      valuationRubars: 0,
      legacyBookRubars: null,
      sourceActionId: "act2",
      sourceSeq: 43,
      lastResolutionId: "act2",
      now,
    });
    assert.equal(skipped.legacyBookRubars, null);
  }
  console.log("ok P4 Module 0: corporation record shape (P4-K11, brief §1.4)");

  // ---- P4 Module 0 (emulator): the data step end-to-end (brief §3.6).
  {
    const legacyAlloc = {
      ...buildSimStatAllocationsDoc("legacyA", now),
      pointBudget: null,
      legacyMarker: "keep-me",
    };
    const stampedAlloc = {
      ...buildSimStatAllocationsDoc("stampedB", now),
      legacyMarker: "keep-me-too",
    };
    const legacyCityRaw = buildSimCityDoc({
      factionId: "legacyA",
      faction: { slug: "legacy-a", name: "Legacy A" },
      seedCityId: null,
      sharedCityId: null,
      createdAtSeq: 2,
      now,
    });
    const legacyCity: Record<string, unknown> = {
      ...legacyCityRaw,
      legacyMarker: "keep-me",
    };
    delete legacyCity.defensePosture;
    const posturedCity = {
      ...buildSimCityDoc({
        factionId: "posturedB",
        faction: { slug: "postured-b", name: "Postured B" },
        seedCityId: null,
        sharedCityId: null,
        createdAtSeq: 2,
        now,
      }),
      defensePosture: { prepared: true, setAtSeq: 9, treasuryPaidRubars: 500 },
    };
    await adminDb.collection("sim_stat_allocations").doc("legacyA").set(legacyAlloc);
    await adminDb.collection("sim_stat_allocations").doc("stampedB").set(stampedAlloc);
    await adminDb.collection("sim_cities").doc("legacyA").set(legacyCity);
    await adminDb.collection("sim_cities").doc("posturedB").set(posturedCity);

    const readAlloc = async (id: string) =>
      (await adminDb.collection("sim_stat_allocations").doc(id).get()).data() as Record<string, unknown>;
    const readCity = async (id: string) =>
      (await adminDb.collection("sim_cities").doc(id).get()).data() as Record<string, unknown>;
    const preLegacyAlloc = await readAlloc("legacyA");
    const preStampedAlloc = await readAlloc("stampedB");
    const preLegacyCity = await readCity("legacyA");
    const prePosturedCity = await readCity("posturedB");

    const report = await applyPhase4DataStep(adminDb);
    assert.equal(report.allocationsScanned, 2);
    assert.equal(report.allocationsStamped, 1);
    assert.equal(report.citiesScanned, 2);
    assert.equal(report.citiesPostured, 1);
    assert.equal(report.writesApplied, 2);
    assert.equal(report.verified, true);

    const postLegacyAlloc = await readAlloc("legacyA");
    assert.equal(postLegacyAlloc.pointBudget, 400);
    assert.equal(postLegacyAlloc.legacyMarker, "keep-me");
    assert.equal(
      dataStepRemainderHash(postLegacyAlloc, "pointBudget"),
      dataStepRemainderHash(preLegacyAlloc, "pointBudget"),
      "nothing outside pointBudget may change"
    );
    const postStampedAlloc = await readAlloc("stampedB");
    assert.equal(postStampedAlloc.pointBudget, 400);
    assert.equal(
      dataStepRemainderHash(postStampedAlloc, "pointBudget"),
      dataStepRemainderHash(preStampedAlloc, "pointBudget")
    );

    const postLegacyCity = await readCity("legacyA");
    assert.deepEqual(postLegacyCity.defensePosture, defaultDefensePosture());
    assert.equal(postLegacyCity.legacyMarker, "keep-me");
    assert.equal(
      dataStepRemainderHash(postLegacyCity, "defensePosture"),
      dataStepRemainderHash(preLegacyCity, "defensePosture"),
      "nothing outside defensePosture may change"
    );
    // A present posture is live state: never overwritten by the step.
    const postPosturedCity = await readCity("posturedB");
    assert.deepEqual(postPosturedCity.defensePosture, {
      prepared: true,
      setAtSeq: 9,
      treasuryPaidRubars: 500,
    });
    assert.equal(
      dataStepRemainderHash(postPosturedCity, "defensePosture"),
      dataStepRemainderHash(prePosturedCity, "defensePosture")
    );

    // Idempotent: a second run plans and applies zero writes, and the
    // world is byte-identical outside (and inside) the targets.
    const report2 = await applyPhase4DataStep(adminDb);
    assert.equal(report2.writesApplied, 0);
    assert.equal(report2.allocationsStamped, 0);
    assert.equal(report2.citiesPostured, 0);
    assert.equal(
      dataStepRemainderHash(await readAlloc("legacyA"), "pointBudget"),
      dataStepRemainderHash(postLegacyAlloc, "pointBudget")
    );
    assert.equal(
      dataStepRemainderHash(await readCity("legacyA"), "defensePosture"),
      dataStepRemainderHash(postLegacyCity, "defensePosture")
    );
  }
  console.log("ok P4 Module 0: data step stamps pool + posture, byte-compare clean, idempotent (P4-G1 data half)");

  await env.cleanup();
  assert.ok(true);
  console.log("play core tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
