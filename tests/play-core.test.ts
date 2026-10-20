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
 *
 * Allocation assembly (this landing): the P4-G1 battery sections C1
 * (template pre-state), C3 (commit validation battery) and C5 (one
 * commit, ever), wired against the registered R-35 descriptor through
 * the real preview path, on a fresh genesis world seeded in sim-core's
 * idiom after the Module 0 sections complete.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestContext,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from "firebase-admin/firestore";
import {
  BASELINE_HASH,
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
import { runGenesis } from "../lib/sim/genesis";
import { ensureSimCity } from "../lib/sim/ensureSimCity";
import { buildActionDoc } from "../lib/sim/intake";
import {
  previewAction,
  runWake,
  type DispatcherDeps,
  type WakeSummary,
} from "../lib/sim/dispatcher";
import { PRODUCTION_BASELINE_REGISTRY } from "../lib/sim/baseline/registry";
import type { SimActor } from "../lib/sim/state";
import { computeDraftHash } from "../lib/allocation/draft";
import { ALLOCATABLE_STATS } from "../lib/allocation/stats";

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

  // ====================================================================
  // P4-G1 allocation battery (Allocation assembly, Lead): C1 template
  // pre-state, C3 commit validation battery, C5 one-commit-ever —
  // wired against the REGISTERED R-35 descriptor through the real
  // preview path (previewAction -> member confirm -> runWake ->
  // committer), on a fresh genesis world seeded in sim-core's idiom.
  // C1's cross-city hash claim (gate §2's F2 world-state slices) is
  // asserted here in doc-level form — the two unallocated cities'
  // stats and allocation control fields deep-equal each other and the
  // template; the whole-slice F2 form rides the gate-harness build,
  // as Phase 3's §2 harnesses did. The battery also exercises the
  // assembly's rules fix end-to-end: preview materializes the R-35
  // read-plan paths (allocation doc + versions/v1) under the
  // committer identity, which the landed read clauses did not admit
  // before the fabric branch.
  // ====================================================================
  {
    await env.clearFirestore();
    const seedUserAlloc = async (uid: string, data: Record<string, unknown>) => {
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), "users", uid), data);
      });
    };
    await seedUserAlloc("ownerA", { email: "a@realm.test", status: "approved", isAdmin: false });
    await seedUserAlloc("ownerB", { email: "b@realm.test", status: "approved", isAdmin: false });
    await seedUserAlloc("memberC", { email: "c@realm.test", status: "approved", isAdmin: false });
    await seedUserAlloc("fabricSvc", { email: "fabric@realm.test", status: "approved", isAdmin: false });
    await seedUserAlloc("fabricWkr", { email: "worker@realm.test", status: "approved", isAdmin: false });
    await env.withSecurityRulesDisabled(async (context) => {
      const fs = context.firestore();
      await setDoc(doc(fs, "factions", "cityA"), {
        name: "Fixture City A",
        slug: "fixture-a",
        ownerUids: ["ownerA"],
      });
      await setDoc(doc(fs, "faction_members", "ownerA_cityA"), {
        uid: "ownerA",
        factionId: "cityA",
        role: "owner",
      });
      await setDoc(doc(fs, "factions", "cityB"), {
        name: "Fixture City B",
        slug: "fixture-b",
        ownerUids: ["ownerB"],
      });
      await setDoc(doc(fs, "faction_members", "ownerB_cityB"), {
        uid: "ownerB",
        factionId: "cityB",
        role: "owner",
      });
    });
    assert.equal((await runGenesis(adminDb, {})).status, "created");
    assert.equal((await ensureSimCity(adminDb, "cityA")).status, "created");
    assert.equal((await ensureSimCity(adminDb, "cityB")).status, "created");

    const ownerA: RulesTestContext = env.authenticatedContext("ownerA", {
      email: "a@realm.test",
    });
    const fabricCommitter = env.authenticatedContext("fabricSvc", {
      email: "fabric@realm.test",
      fabric: true,
      fabricRole: "committer",
    });
    const committerFs = fabricCommitter.firestore() as unknown as import("firebase/firestore").Firestore;
    const allocDeps: DispatcherDeps = {
      fabricDb: committerFs,
      committerDb: committerFs,
      baselineRegistry: PRODUCTION_BASELINE_REGISTRY,
    };
    const nowIsoAlloc = "2026-10-19T12:00:00.000Z";
    let cycle = 0;
    const wakeAlloc = async (): Promise<WakeSummary> =>
      runWake(allocDeps, { now: nowIsoAlloc, cycleId: `alloc-cycle-${++cycle}` });
    const adminDocAlloc = async (path: string) => {
      const snap = await adminDb.doc(path).get();
      return snap.exists ? (snap.data() as Record<string, unknown>) : null;
    };
    const entriesOfAlloc = async (resolutionId: string) => {
      const snap = await adminDb
        .collection("sim_log_entries")
        .where("resolutionId", "==", resolutionId)
        .get();
      return snap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .sort((a, b) => (a.seq as number) - (b.seq as number));
    };
    const memberActorAlloc = (uid: string): SimActor => ({
      type: "member",
      memberId: uid,
      npcId: null,
      onBehalfOfMemberId: null,
      mandateId: null,
      mandateVersion: null,
      envelopeId: null,
    });
    let requestCounter = 0;
    const submitAllocAction = async (
      structuredAction: Record<string, unknown>
    ): Promise<string> => {
      requestCounter += 1;
      const { actionId, doc: actionDocData } = buildActionDoc({
        actorUid: "ownerA",
        clientRequestId: `alloc-req-${requestCounter}`,
        actor: memberActorAlloc("ownerA"),
        actionType: "allocate_season0",
        actionText: null,
        structuredAction,
        targetCityIds: ["cityA"],
        now: nowIsoAlloc,
      });
      await setDoc(doc(ownerA.firestore(), "sim_actions", actionId), actionDocData);
      return actionId;
    };
    const previewAlloc = async (actionId: string) => {
      await previewAction(allocDeps, actionId, { now: nowIsoAlloc });
      const snap = await getDoc(doc(ownerA.firestore(), "sim_actions", actionId));
      return snap.data() as Record<string, unknown>;
    };
    const confirmAlloc = async (actionId: string) => {
      const snap = await getDoc(doc(ownerA.firestore(), "sim_actions", actionId));
      const action = snap.data() as Record<string, unknown>;
      assert.equal(action.status, "awaiting_confirmation");
      const preview = action.preview as Record<string, unknown>;
      await updateDoc(doc(ownerA.firestore(), "sim_actions", actionId), {
        confirmation: {
          confirmedByUid: "ownerA",
          confirmedAt: Timestamp.now(),
          previewHash: preview.previewHash,
          authorityType: "owner",
        },
        status: "confirmed",
        updatedAt: Timestamp.now(),
      });
    };
    // The rules-level mirror of lib/allocation/draftSave's write: the
    // same field set through the same owner fence. Written directly
    // (saveAllocationDraft binds the browser's client db) so the
    // battery can also save drafts the client builder refuses — the
    // handler's refusals are the subject under test, and a crafted
    // client can write exactly these fields under the same fence.
    let draftVersionAlloc = 0;
    const saveDraftAlloc = async (map: Record<string, number>) => {
      draftVersionAlloc += 1;
      const spent = ALLOCATABLE_STATS.reduce(
        (total, key) => total + (map[key] ?? 0),
        0
      );
      const draftHash = computeDraftHash({ ...map }, spent);
      await updateDoc(doc(ownerA.firestore(), "sim_stat_allocations", "cityA"), {
        allocations: { ...map },
        spentPoints: spent,
        draftVersion: draftVersionAlloc,
        draftHash,
        authorUid: "ownerA",
        status: "draft",
        updatedAt: serverTimestamp(),
      });
      return { draftVersion: draftVersionAlloc, draftHash };
    };

    // ---- P4-G1-C1: template pre-state (TC-D04).
    const cityA0 = (await adminDocAlloc("sim_cities/cityA")) as Record<string, unknown>;
    const cityB0 = (await adminDocAlloc("sim_cities/cityB")) as Record<string, unknown>;
    const allocA0 = (await adminDocAlloc("sim_stat_allocations/cityA")) as Record<string, unknown>;
    const allocB0 = (await adminDocAlloc("sim_stat_allocations/cityB")) as Record<string, unknown>;
    assert.deepEqual(cityA0.stats, templateStats());
    const statsA0 = cityA0.stats as unknown as Record<string, unknown>;
    for (const key of ALLOCATABLE_STATS) {
      assert.equal(statsA0[key], null, `C1: ${key} starts null`);
    }
    assert.equal(statsA0.population, null);
    assert.equal(statsA0.gdpRubars, null);
    assert.equal(statsA0.households, 0);
    assert.equal(statsA0.housingUnits, 0);
    assert.equal(statsA0.treasuryRubars, 0);
    assert.equal((cityA0.baseline as Record<string, unknown>).baselineHash, BASELINE_HASH);
    assert.equal((cityB0.baseline as Record<string, unknown>).baselineHash, BASELINE_HASH);
    assert.equal(allocA0.baselineHash, BASELINE_HASH);
    // Cross-city equality, the doc-level form of C1's F2 claim: any
    // other unallocated claimed city is in the identical state.
    assert.deepEqual(cityB0.stats, cityA0.stats);
    assert.equal(allocA0.status, "not_started");
    assert.equal(allocB0.status, "not_started");
    assert.equal(allocA0.pointBudget, INITIAL_POINT_BUDGET);
    assert.equal(allocB0.pointBudget, INITIAL_POINT_BUDGET);
    assert.deepEqual(allocA0.allocations, allocB0.allocations);
    assert.deepEqual(allocA0.baselineStats, allocB0.baselineStats);
    console.log("ok play-core P4-G1-C1: template pre-state; cross-city equal (doc-level F2 form)");

    // ---- P4-G1-C3: the commit validation battery, real preview path.
    // Each case is submitted as a confirm against the real preview
    // path and refused before any write, the refusal logged as
    // rejected with the failed check named (preview warning +
    // action.failure.code + the single rejected Log entry).
    const evenMap: Record<string, number> = {
      spirit: 50,
      culture: 50,
      infrastructure: 50,
      stability: 50,
      law: 50,
      influence: 50,
      military: 50,
      defense: 50,
    };
    const cases: Array<{ name: string; map: Record<string, number>; code: string }> = [
      { name: "sum 399", map: { ...evenMap, spirit: 49 }, code: "SUM_NOT_EXACT" },
      { name: "sum 401", map: { ...evenMap, spirit: 51 }, code: "SUM_NOT_EXACT" },
      { name: "one stat 81", map: { ...evenMap, spirit: 81, culture: 19 }, code: "VALUE_OUT_OF_BOUNDS" },
      { name: "one stat -1", map: { ...evenMap, spirit: -1, culture: 51 }, code: "VALUE_OUT_OF_BOUNDS" },
      { name: "non-integer", map: { ...evenMap, spirit: 50.5, culture: 49.5 }, code: "NON_INTEGER_VALUE" },
      { name: "ninth key names a stock", map: { ...evenMap, population: 10 }, code: "STOCK_NOT_ALLOCATABLE" },
      { name: "key outside the eight", map: { ...evenMap, charisma: 10 }, code: "UNKNOWN_STAT_KEY" },
    ];
    for (const testCase of cases) {
      const binding = await saveDraftAlloc(testCase.map);
      const actionId = await submitAllocAction({
        cityId: "cityA",
        allocations: testCase.map,
        draftVersion: binding.draftVersion,
        draftHash: binding.draftHash,
      });
      const previewed = await previewAlloc(actionId);
      const preview = previewed.preview as Record<string, unknown>;
      assert.equal(preview.outcome, "rejected", `C3 ${testCase.name}: preview outcome`);
      const warnings = preview.warnings as string[];
      assert.ok(
        warnings.some((w) => w.includes(testCase.code)),
        `C3 ${testCase.name}: preview names ${testCase.code}`
      );
      await confirmAlloc(actionId);
      const summary = await wakeAlloc();
      assert.ok(summary.actionsRejected.includes(actionId), `C3 ${testCase.name}: wake rejects`);
      const actionAfter = (await adminDocAlloc(`sim_actions/${actionId}`)) as Record<string, unknown>;
      assert.equal(actionAfter.status, "rejected", `C3 ${testCase.name}: action rejected`);
      assert.equal(
        (actionAfter.failure as Record<string, unknown>).code,
        testCase.code,
        `C3 ${testCase.name}: failure code`
      );
      const entries = await entriesOfAlloc(actionId);
      assert.equal(entries.length, 1, `C3 ${testCase.name}: one rejection entry`);
      assert.equal(entries[0].kind, "rejected");
    }
    // After all seven: cityA is still in template state and nothing
    // has committed — the allocation doc holds only the last draft.
    const cityAAfterC3 = (await adminDocAlloc("sim_cities/cityA")) as Record<string, unknown>;
    assert.deepEqual(cityAAfterC3.stats, templateStats());
    const allocAfterC3 = (await adminDocAlloc("sim_stat_allocations/cityA")) as Record<string, unknown>;
    assert.equal(allocAfterC3.status, "draft");
    assert.equal(
      (await adminDb.collection("sim_stat_allocations/cityA/versions").get()).empty,
      true
    );
    console.log("ok play-core P4-G1-C3: seven refusals via the real preview path; cityA still template");

    // ---- Boundary commit (C3's boundary case; C5's setup): sum
    // exactly 400 with a stat at 80 and stats at 20 commits.
    const commitMap: Record<string, number> = {
      spirit: 80,
      culture: 80,
      infrastructure: 80,
      stability: 40,
      law: 40,
      influence: 40,
      military: 20,
      defense: 20,
    };
    const commitBinding = await saveDraftAlloc(commitMap);
    const commitActionId = await submitAllocAction({
      cityId: "cityA",
      allocations: commitMap,
      draftVersion: commitBinding.draftVersion,
      draftHash: commitBinding.draftHash,
    });
    const commitPreviewed = await previewAlloc(commitActionId);
    assert.equal(
      (commitPreviewed.preview as Record<string, unknown>).outcome,
      "resolved"
    );
    await confirmAlloc(commitActionId);
    const commitSummary = await wakeAlloc();
    assert.ok(commitSummary.actionsCommitted.includes(commitActionId));
    const committedAction = (await adminDocAlloc(`sim_actions/${commitActionId}`)) as Record<string, unknown>;
    assert.equal(committedAction.status, "resolved");
    const cityACommitted = (await adminDocAlloc("sim_cities/cityA")) as Record<string, unknown>;
    const committedStats = cityACommitted.stats as Record<string, unknown>;
    for (const key of ALLOCATABLE_STATS) {
      assert.equal(committedStats[key], commitMap[key], `commit: ${key}`);
    }
    assert.equal(committedStats.population, null);
    assert.equal(committedStats.gdpRubars, null);
    assert.equal(committedStats.treasuryRubars, 0);
    assert.equal(committedStats.households, 0);
    assert.equal(committedStats.housingUnits, 0);
    const allocCommitted = (await adminDocAlloc("sim_stat_allocations/cityA")) as Record<string, unknown>;
    assert.equal(allocCommitted.status, "committed");
    assert.deepEqual(allocCommitted.allocations, commitMap);
    assert.equal(allocCommitted.spentPoints, 400);
    assert.equal(allocCommitted.commitActionId, commitActionId);
    assert.equal(allocCommitted.committedByUid, "ownerA");
    const versionsSnap = await adminDb.collection("sim_stat_allocations/cityA/versions").get();
    assert.equal(versionsSnap.size, 1);
    assert.equal(versionsSnap.docs[0].id, "v1");
    const v1 = versionsSnap.docs[0].data() as Record<string, unknown>;
    assert.equal(v1.cityId, "cityA");
    assert.equal(v1.source, "first_login");
    assert.deepEqual(v1.allocations, commitMap);
    assert.equal(v1.spentPoints, 400);
    assert.equal(v1.draftVersion, commitBinding.draftVersion);
    assert.equal(v1.draftHash, commitBinding.draftHash);
    // Theo decision (a), pinned: the version record carries
    // previewHash null; the committer manifest is the record of the
    // true preview hash (the plan cannot contain its own hash).
    assert.equal(v1.previewHash, null);
    assert.equal(v1.commitSeq, allocCommitted.committedSeq);
    const commitEntries = await entriesOfAlloc(commitActionId);
    assert.equal(commitEntries.length, 2);
    assert.equal(commitEntries[0].kind, "rule-effect");
    assert.equal(commitEntries[1].kind, "action-summary");
    console.log("ok play-core P4-G1 boundary commit: extremes at sum 400 commit via R-35");

    // ---- P4-G1-C5: one commit, ever (DEP-4.1 closed — no
    // reallocation event exists in Phase 4).
    const allocBeforeC5 = (await adminDocAlloc("sim_stat_allocations/cityA")) as Record<string, unknown>;
    const secondId = await submitAllocAction({
      cityId: "cityA",
      allocations: commitMap,
      draftVersion: allocBeforeC5.draftVersion,
      draftHash: allocBeforeC5.draftHash,
    });
    const secondPreviewed = await previewAlloc(secondId);
    const secondPreview = secondPreviewed.preview as Record<string, unknown>;
    assert.equal(secondPreview.outcome, "rejected");
    assert.ok(
      (secondPreview.warnings as string[]).some((w) => w.includes("ALREADY_COMMITTED"))
    );
    await confirmAlloc(secondId);
    const secondSummary = await wakeAlloc();
    assert.ok(secondSummary.actionsRejected.includes(secondId));
    const secondAfter = (await adminDocAlloc(`sim_actions/${secondId}`)) as Record<string, unknown>;
    assert.equal(secondAfter.status, "rejected");
    assert.equal(
      (secondAfter.failure as Record<string, unknown>).code,
      "ALREADY_COMMITTED"
    );
    const secondEntries = await entriesOfAlloc(secondId);
    assert.equal(secondEntries.length, 1);
    assert.equal(secondEntries[0].kind, "rejected");
    // State and the commit's records are unchanged; still one version.
    const cityAAfterC5 = (await adminDocAlloc("sim_cities/cityA")) as Record<string, unknown>;
    assert.deepEqual(cityAAfterC5.stats, cityACommitted.stats);
    const allocAfterC5 = (await adminDocAlloc("sim_stat_allocations/cityA")) as Record<string, unknown>;
    assert.equal(allocAfterC5.status, "committed");
    assert.equal(allocAfterC5.commitActionId, commitActionId);
    assert.deepEqual(allocAfterC5.allocations, commitMap);
    assert.equal((await adminDb.collection("sim_stat_allocations/cityA/versions").get()).size, 1);
    // Rules leg (the GREP + RULES half of C5): no respec path — the
    // owner's own draft write against a committed doc is refused by
    // the fence, and version docs stay committer-only.
    await assertFails(
      updateDoc(doc(ownerA.firestore(), "sim_stat_allocations", "cityA"), {
        allocations: { ...evenMap },
        spentPoints: 400,
        draftVersion: 99,
        draftHash: computeDraftHash({ ...evenMap }, 400),
        authorUid: "ownerA",
        status: "draft",
        updatedAt: serverTimestamp(),
      })
    );
    await assertFails(
      setDoc(doc(ownerA.firestore(), "sim_stat_allocations", "cityA", "versions", "v2"), {
        cityId: "cityA",
        source: "first_login",
        allocations: { ...evenMap },
        spentPoints: 400,
        authorUid: "ownerA",
      })
    );
    console.log("ok play-core P4-G1-C5: second commit refused (ALREADY_COMMITTED); no respec path");
  }

  await env.cleanup();
  assert.ok(true);
  console.log("play core tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
