/**
 * Sim core suite (Phase 2) — Osei's gate checks P2-G1..G12 against the
 * Firestore + Auth emulators, in the rules suite's style (plain asserts,
 * sectioned console lines). Run via `npm run test:sim`
 * (emulators:exec --only firestore,auth). The sandbox emulator is a known
 * defect (it rejects its own rules upload), so this suite's venue is CI —
 * the "Sim core tests (non-required)" job.
 *
 * The scenario is one continuous world: genesis + two fixture cities,
 * then resolutions, ripenings, and undos in dependency order. Fixtures in
 * sim_* collections are seeded AFTER genesis (the Phase 1 ordering
 * lesson: genesis verifies a pristine world).
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, type Firestore as AdminFirestore } from "firebase-admin/firestore";
import { runGenesis } from "../lib/sim/genesis";
import { ensureSimCity } from "../lib/sim/ensureSimCity";
import { BASELINE_HASH, logEntryDocId } from "../lib/sim/template";
import { sha256Hex } from "../lib/sim/canonical";
import { computeEntryHash } from "../lib/sim/log";
import { buildActionDoc } from "../lib/sim/intake";
import {
  firestoreReader,
  previewAction,
  runWake,
  type DispatcherDeps,
  type WakeSummary,
} from "../lib/sim/dispatcher";
import { commitResolution } from "../lib/sim/committer";
import {
  PlanValidationError,
  buildSnapshot,
  collectActionReadPaths,
  collectActionReadPlan,
  materializeSnapshot,
  resolveAction,
  resolveVoiding,
  snapshotFromDocs,
  validatePlan,
  type DocReader,
  type QueryReader,
} from "../lib/sim/resolver";
import {
  PRODUCTION_BASELINE_REGISTRY,
  citableBaselineVersion,
  computeBaselineDocHash,
} from "../lib/sim/baseline/registry";
import {
  buildFixtureBaselineRegistry,
  FIXTURE_BASELINE_TEXTS,
} from "../lib/sim/baseline/fixtures";
import { verifyStandingLog, hashWorldStateSlices, type StandingWorld } from "../lib/sim/verify";
import { planLogWorkbooks, type ExportEntry } from "../lib/export/logWorkbook";
import type { CollectionQuerySpec, PreparedPayload, SimActor } from "../lib/sim/state";

const PROJECT_ID = "cowboycityrealm";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let clockIso = "2026-10-18T00:00:00.000Z";
let wakeCounter = 0;
const nowIso = () => clockIso;
function advanceHours(hours: number) {
  clockIso = new Date(Date.parse(clockIso) + hours * 3_600_000).toISOString();
}

const memberActor = (uid: string): SimActor => ({
  type: "member",
  memberId: uid,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

async function main() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error("sim-core suite requires FIRESTORE_EMULATOR_HOST — run via `npm run test:sim`");
  }
  const adminApp =
    getApps().length > 0 ? getApps()[0] : initializeApp({ projectId: PROJECT_ID }, "sim-phase2");
  const adminDb: AdminFirestore = getAdminFirestore(adminApp);

  const seedUser = async (uid: string, data: Record<string, unknown>) => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), "users", uid), data);
    });
  };

  await env.clearFirestore();
  await seedUser("ownerA", { email: "a@realm.test", status: "approved", isAdmin: false });
  await seedUser("ownerB", { email: "b@realm.test", status: "approved", isAdmin: false });
  await seedUser("memberC", { email: "c@realm.test", status: "approved", isAdmin: false });
  await seedUser("adminD", { email: "d@realm.test", status: "approved", isAdmin: true });
  // The fabric service users carry user docs so viewer-gated reads
  // (factions, cities, the Log) work under their claim-bearing contexts;
  // their authority comes from the claims, exactly as in production.
  await seedUser("fabricSvc", { email: "fabric@realm.test", status: "approved", isAdmin: false });
  await seedUser("fabricWkr", { email: "worker@realm.test", status: "approved", isAdmin: false });
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

  const genesisResult = await runGenesis(adminDb, {});
  assert.equal(genesisResult.status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityA")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityB")).status, "created");

  // Fixture initial conditions (seeded after genesis, rules-disabled like
  // the Phase 1 fixtures): treasuries, infrastructure bands, and a live
  // connection trait cityA -> cityB (WB-7.2 as data).
  await env.withSecurityRulesDisabled(async (context) => {
    const fs = context.firestore();
    const cityA = (await getDoc(doc(fs, "sim_cities", "cityA"))).data() as Record<string, unknown>;
    await setDoc(doc(fs, "sim_cities", "cityA"), {
      ...cityA,
      traits: ["connection:cityB:live"],
      stats: {
        ...(cityA.stats as Record<string, unknown>),
        treasuryRubars: 1_000_000,
        infrastructure: 50,
        population: 1000,
      },
    });
    const cityB = (await getDoc(doc(fs, "sim_cities", "cityB"))).data() as Record<string, unknown>;
    await setDoc(doc(fs, "sim_cities", "cityB"), {
      ...cityB,
      stats: {
        ...(cityB.stats as Record<string, unknown>),
        treasuryRubars: 500_000,
        infrastructure: 80,
        population: 800,
      },
    });
  });

  const ownerA = env.authenticatedContext("ownerA", { email: "a@realm.test" });
  const ownerB = env.authenticatedContext("ownerB", { email: "b@realm.test" });
  const memberC = env.authenticatedContext("memberC", { email: "c@realm.test" });
  const fabricCommitter = env.authenticatedContext("fabricSvc", {
    email: "fabric@realm.test",
    fabric: true,
    fabricRole: "committer",
  });
  // The rules-unit-testing context's firestore() is typed as the compat
  // Firestore; it IS the modular instance at runtime — one cast aligns it
  // with the engine modules' modular types.
  const committerFs = fabricCommitter.firestore() as unknown as import("firebase/firestore").Firestore;

  const deps = (registry = PRODUCTION_BASELINE_REGISTRY): DispatcherDeps => ({
    fabricDb: committerFs,
    committerDb: committerFs,
    baselineRegistry: registry,
  });

  async function wake(extra?: {
    preparedPayloads?: ReadonlyMap<string, PreparedPayload>;
    registry?: import("../lib/sim/baseline/registry").BaselineRegistry;
  }): Promise<WakeSummary> {
    wakeCounter += 1;
    return runWake(deps(extra?.registry), {
      now: nowIso(),
      cycleId: `cycle-${wakeCounter}`,
      preparedPayloads: extra?.preparedPayloads,
    });
  }

  const adminDoc = async (path: string) => {
    const segments = path.split("/");
    const snap = await adminDb.doc(path).get();
    void segments;
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  };
  const counter = async () =>
    (await adminDoc("sim_counters/log")) as Record<string, unknown>;
  const headSeq = async () => (await counter()).lastSeq as number;
  const cityStats = async (cityId: string) => {
    const city = await adminDoc(`sim_cities/${cityId}`);
    return (city?.stats ?? {}) as Record<string, unknown>;
  };
  const treasury = async (cityId: string) =>
    (await cityStats(cityId)).treasuryRubars as number;
  const entriesOf = async (resolutionId: string) => {
    const snap = await adminDb
      .collection("sim_log_entries")
      .where("resolutionId", "==", resolutionId)
      .get();
    return snap.docs
      .map((d) => d.data() as Record<string, unknown>)
      .sort((a, b) => (a.seq as number) - (b.seq as number));
  };
  const allEntries = async () => {
    const snap = await adminDb.collection("sim_log_entries").orderBy("seq", "asc").get();
    return snap.docs.map((d) => d.data() as Record<string, unknown>);
  };

  async function assembleWorld(
    registry: StandingWorld["baselineRegistry"]
  ): Promise<StandingWorld> {
    const entries = await allEntries();
    const manifestsSnap = await adminDb.collection("sim_resolutions").get();
    const manifests = new Map<string, Record<string, unknown>>();
    for (const d of manifestsSnap.docs) manifests.set(d.id, d.data() as Record<string, unknown>);
    const stateDocs = new Map<string, Record<string, unknown>>();
    const addCollection = async (path: string) => {
      const snap = await adminDb.collection(path).get();
      for (const d of snap.docs) stateDocs.set(`${path}/${d.id}`, d.data() as Record<string, unknown>);
      return snap.docs.map((d) => d.id);
    };
    const cityIds = await addCollection("sim_cities");
    for (const cityId of cityIds) {
      for (const sub of ["structures", "households", "figures", "corporations", "laws"]) {
        await addCollection(`sim_cities/${cityId}/${sub}`);
      }
    }
    await addCollection("sim_stat_allocations");
    await addCollection("sim_pending_consequences");
    await addCollection("sim_publications");
    await addCollection("sim_intel_records");
    await addCollection("sim_character_extensions");
    return {
      entries,
      manifests,
      counter: (await adminDoc("sim_counters/log")) as Record<string, unknown>,
      world: (await adminDoc("sim_world/current")) as Record<string, unknown>,
      stateDocs,
      baselineRegistry: registry,
    };
  }
  const f2 = async () => {
    const world = await assembleWorld(PRODUCTION_BASELINE_REGISTRY);
    return hashWorldStateSlices(world);
  };
  const verifyOk = async (registry = PRODUCTION_BASELINE_REGISTRY) => {
    const world = await assembleWorld(registry);
    const result = verifyStandingLog(world);
    assert.deepEqual(
      result.findings,
      [],
      `standing Log must verify clean: ${JSON.stringify(result.findings, null, 2)}`
    );
  };

  let requestCounter = 0;
  async function submitAction(
    ctx: RulesTestContext,
    uid: string,
    actionType: string,
    structuredAction: Record<string, unknown> | null,
    opts?: { actionText?: string | null; targetCityIds?: string[] }
  ): Promise<string> {
    requestCounter += 1;
    const { actionId, doc: actionDocData } = buildActionDoc({
      actorUid: uid,
      clientRequestId: `req-${requestCounter}`,
      actor: memberActor(uid),
      actionType,
      actionText: opts?.actionText ?? null,
      structuredAction,
      targetCityIds: opts?.targetCityIds ?? [],
      now: nowIso(),
    });
    await setDoc(doc(ctx.firestore(), "sim_actions", actionId), actionDocData);
    return actionId;
  }

  async function previewAndConfirm(
    ctx: RulesTestContext,
    uid: string,
    actionId: string,
    registry?: import("../lib/sim/baseline/registry").BaselineRegistry
  ) {
    await previewAction(deps(registry), actionId, { now: nowIso() });
    const snap = await getDoc(doc(ctx.firestore(), "sim_actions", actionId));
    const action = snap.data() as Record<string, unknown>;
    assert.equal(action.status, "awaiting_confirmation");
    const preview = action.preview as Record<string, unknown>;
    await updateDoc(doc(ctx.firestore(), "sim_actions", actionId), {
      confirmation: {
        confirmedByUid: uid,
        confirmedAt: Timestamp.now(),
        previewHash: preview.previewHash,
        authorityType: "owner",
      },
      status: "confirmed",
      updatedAt: Timestamp.now(),
    });
    return action;
  }

  async function submitConfirmWake(
    ctx: RulesTestContext,
    uid: string,
    actionType: string,
    structuredAction: Record<string, unknown> | null,
    opts?: { actionText?: string | null; targetCityIds?: string[]; registry?: import("../lib/sim/baseline/registry").BaselineRegistry }
  ): Promise<{ actionId: string; summary: WakeSummary }> {
    const actionId = await submitAction(ctx, uid, actionType, structuredAction, opts);
    await previewAndConfirm(ctx, uid, actionId, opts?.registry);
    const summary = await wake({ registry: opts?.registry });
    return { actionId, summary };
  }

  // ======================================================================
  // CK1 — P2-G12 regression + P2-G5: genesis (v1) intact under the v2
  // regime; the template hash unchanged; genesis alone carries `system`.
  // ======================================================================
  {
    const genesisEntry = await adminDoc(`sim_log_entries/${logEntryDocId(1)}`);
    assert.ok(genesisEntry);
    assert.equal(genesisEntry.hashVersion, "cowboy-canonical-json-v1");
    assert.equal(computeEntryHash(genesisEntry), genesisEntry.entryHash);
    assert.equal((genesisEntry.actor as Record<string, unknown>).type, "system");
    const world = await adminDoc("sim_world/current");
    assert.equal(world?.evenStartTemplateHash, BASELINE_HASH);
    assert.equal(world?.rulesVersion, "sim-rules-0.1.0-phase1");
    assert.equal(await headSeq(), 1);
  }
  console.log("ok genesis v1 intact, template hash stable (P2-G12/G5)");

  // ======================================================================
  // CK2 — the canonical fund lifecycle (P2-G3 preview/commit parity,
  // P2-G1 manifest shape): preview -> hash-bound confirm -> one
  // transaction carrying state + entries + manifest + counter + action.
  // ======================================================================
  let fundActionId = "";
  let fundPendingId = "";
  {
    fundActionId = await submitAction(ownerA, "ownerA", "fixture_fund", {
      cityId: "cityA",
      fundName: "Innovation Fund",
      fundId: "fund1",
      amountRubars: 100_000,
      mode: "determinate",
      effectField: "stats.treasuryRubars",
      effectDelta: 30_000,
      disbursementRubars: 100_000,
    });
    const actionBefore = await previewAndConfirm(ownerA, "ownerA", fundActionId);
    const preview = actionBefore.preview as Record<string, unknown>;
    // Felix derivation, disclosed in the preview: 48h x 1.4667 (fund
    // scale) x 1.0 (infra 50) x 0.9 (live connection) = 63h; seq 11.
    const disclosures = preview.pendingDisclosures as Record<string, unknown>[];
    assert.equal(disclosures.length, 1);
    const derivation = disclosures[0].delayDerivation as Record<string, unknown>;
    assert.equal(derivation.minWallElapsedHours, 63);
    assert.equal(derivation.minSeqAdvance, 11);

    const summary = await wake();
    assert.deepEqual(summary.actionsCommitted, [fundActionId]);
    assert.equal(await headSeq(), 4);

    const action = await adminDoc(`sim_actions/${fundActionId}`);
    assert.equal(action?.status, "resolved");
    assert.equal(action?.firstLogSeq, 2);
    assert.equal(action?.lastLogSeq, 4);

    const entries = await entriesOf(fundActionId);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].kind, "rule-effect");
    assert.deepEqual(entries[0].ruleIds, ["R-32"]);
    assert.equal(entries[1].kind, "rule-effect");
    assert.ok(entries[1].pendingId);
    assert.deepEqual(entries[1].changes, []);
    assert.equal(entries[2].kind, "action-summary");
    for (const entry of entries) {
      assert.equal(entry.hashVersion, "cowboy-canonical-json-v2");
      assert.equal(entry.rulesVersion, "sim-rules-0.2.0-phase2");
      assert.equal(entry.baseline, null);
      assert.equal(computeEntryHash(entry), entry.entryHash);
    }
    fundPendingId = entries[1].pendingId as string;
    assert.equal(fundPendingId, `pend_${fundActionId}_01`);
    assert.equal(await treasury("cityA"), 900_000);

    const fund = await adminDoc("sim_cities/cityA/structures/fund1");
    assert.equal(fund?.remainingRubars, 100_000);
    assert.equal(fund?.status, "active");

    const pending = await adminDoc(`sim_pending_consequences/${fundPendingId}`);
    assert.equal(pending?.status, "pending");
    assert.equal(pending?.originSeq, 4);
    const condition = pending?.ripenCondition as Record<string, unknown>;
    assert.equal(condition.requiredSeq, 15); // originSeq 4 + minSeqAdvance 11
    assert.equal(condition.scope, "realm");
    assert.ok((pending?.audienceUids as string[]).includes("ownerA"));
    // Delay derivation stored in full; creation snapshot carries NO odds.
    const snapshotFields = pending?.creationSnapshot as Record<string, unknown>;
    assert.ok(!("odds" in snapshotFields) && !("probability" in snapshotFields));

    const manifest = await adminDoc(`sim_resolutions/${fundActionId}`);
    assert.equal(manifest?.schemaVersion, 2);
    assert.equal(manifest?.planHash, actionBefore.previewPlanHash);
    assert.equal((manifest?.counterBefore as Record<string, unknown>).lastSeq, 1);
    const writeSet = manifest?.writeSet as Record<string, unknown>[];
    const cityWrite = writeSet.find((w) => w.path === "sim_cities/cityA");
    assert.ok(cityWrite?.beforeDoc && cityWrite?.afterDoc, "manifest carries full snapshots");
    assert.ok(
      writeSet.some((w) => w.path === `sim_pending_consequences/${fundPendingId}`),
      "pending creation is in the manifest write set"
    );
    await verifyOk();
  }
  console.log("ok fund lifecycle: preview parity, one transaction, manifest v2 (P2-G1/G3)");

  // ======================================================================
  // CK3 — P2-G2 causality: with a pending outstanding, an empty wake and
  // a 30-day clock jump change NOTHING (byte-identical F2 slices). Plus
  // the mechanical guards: no scheduler anywhere; the scan is reachable
  // only from the dispatcher.
  // ======================================================================
  {
    const before = await f2();
    advanceHours(24 * 30);
    const summary = await wake();
    assert.equal(summary.actionsCommitted.length, 0);
    assert.equal(summary.undoOpsProcessed, 0);
    const after = await f2();
    assert.deepEqual(after, before, "empty wake + time passage must not move the world");
    assert.equal(await headSeq(), 4);

    const simFiles = [
      "lib/sim/state.ts", "lib/sim/log.ts", "lib/sim/resolver.ts", "lib/sim/preview.ts",
      "lib/sim/committer.ts", "lib/sim/dispatcher.ts", "lib/sim/readers.ts", "lib/sim/pending.ts",
      "lib/sim/undo.ts", "lib/sim/verify.ts", "lib/sim/intake.ts",
      "lib/sim/rules/registry.ts", "lib/sim/rules/arithmetic.ts",
      "lib/sim/rules/pendingRules.ts", "lib/sim/rules/planHelpers.ts",
      "lib/sim/baseline/registry.ts", "lib/sim/baseline/fixtures.ts",
    ];
    for (const file of simFiles) {
      const source = readFileSync(file, "utf8");
      assert.ok(!/setInterval|setTimeout|node-cron|scheduleJob/.test(source), `${file} contains a scheduler primitive`);
      assert.ok(!/from\s+["']firebase-admin/.test(source), `${file} imports the Admin SDK (P2-G9 grep)`);
      if (!file.endsWith("dispatcher.ts") && !file.endsWith("pending.ts")) {
        assert.ok(!source.includes("scanRipeness"), `${file} reaches the ripeness scan — only the dispatcher may`);
      }
    }
  }
  console.log("ok causality: empty wake byte-identical; no scheduler; scan fenced (P2-G2)");

  // ======================================================================
  // CK4 — P2-G6 Baseline fail-closed (draft registry) + F10 fixture
  // registry citation behavior (while head seq < 100 -> fixture v0.1).
  // ======================================================================
  const fixtureRegistry = buildFixtureBaselineRegistry("cityB");
  {
    // The draft is never citable, at any seq.
    assert.equal(citableBaselineVersion(PRODUCTION_BASELINE_REGISTRY, 1), null);
    assert.equal(citableBaselineVersion(PRODUCTION_BASELINE_REGISTRY, 9999), null);
    assert.equal(PRODUCTION_BASELINE_REGISTRY.versions[0].status, "draft");

    // A Baseline-dependent judgment rejects BASELINE_UNRATIFIED and the
    // rejection is a proper logged Resolution Event citing NOTHING.
    const { actionId } = await submitConfirmWake(ownerA, "ownerA", "fixture_market_judgment", {
      cityId: "cityA",
      sections: ["WB-4.3"],
      judgment: "fixture judgment that must never land pre-ratification",
    });
    const action = await adminDoc(`sim_actions/${actionId}`);
    assert.equal(action?.status, "rejected");
    assert.equal((action?.failure as Record<string, unknown>)?.code, "BASELINE_UNRATIFIED");
    const entries = await entriesOf(actionId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "rejected");
    assert.equal(entries[0].baseline, null);

    // A narrative action resolves unruled: logged, flagged, no citation.
    const narrative = await submitConfirmWake(
      ownerA,
      "ownerA",
      "freeform_note",
      null,
      { actionText: "The harbor bell rang twice at dusk.", targetCityIds: ["cityA"] }
    );
    const narrativeEntries = await entriesOf(narrative.actionId);
    assert.equal(narrativeEntries.length, 1);
    const classification = narrativeEntries[0].classification as Record<string, unknown>;
    assert.equal(classification.unruled, true);
    assert.equal(narrativeEntries[0].baseline, null);
    assert.deepEqual(narrativeEntries[0].changes, []);

    // No entry anywhere cites the draft production text.
    for (const entry of await allEntries()) {
      const baseline = entry.baseline as Record<string, unknown> | null;
      assert.ok(baseline === null || baseline.version !== "world-baseline-1.0");
    }

    // F10 mechanics: docHash is recomputable from the fixture texts, and
    // the amendment changes exactly one section's textHash.
    const v01Text = Object.values(FIXTURE_BASELINE_TEXTS.v01).join("\n\n");
    assert.equal(fixtureRegistry.versions[0].docHash, computeBaselineDocHash(v01Text));
    const v01 = fixtureRegistry.versions[0];
    const v02 = fixtureRegistry.versions[1];
    const hashOf = (v: typeof v01, id: string) => v.sections.find((s) => s.id === id)?.textHash;
    assert.notEqual(hashOf(v01, "WB-FIX-1"), hashOf(v02, "WB-FIX-1"));
    assert.equal(hashOf(v01, "WB-FIX-2"), hashOf(v02, "WB-FIX-2"));
    assert.equal(hashOf(v01, "WB-FIX-3"), hashOf(v02, "WB-FIX-3"));
    assert.equal(citableBaselineVersion(fixtureRegistry, 50)?.version, "baseline-fixture-0.1");
    assert.equal(citableBaselineVersion(fixtureRegistry, 100)?.version, "baseline-fixture-0.2");

    // Fixture judgments resolve and cite the CITED (fixture) version.
    const headBefore = await headSeq();
    const expectedVersion = headBefore + 1 >= 100 ? "baseline-fixture-0.2" : "baseline-fixture-0.1";
    const judged = await submitConfirmWake(
      ownerA,
      "ownerA",
      "fixture_market_judgment",
      { cityId: "cityA", sections: ["WB-FIX-1"], judgment: "fixture ruling" },
      { registry: fixtureRegistry }
    );
    const judgedEntries = await entriesOf(judged.actionId);
    const cited = judgedEntries[0].baseline as Record<string, unknown>;
    assert.equal(cited.version, expectedVersion);
    assert.deepEqual(cited.sections, ["WB-FIX-1"]);

    // Scoped exception: citable in its home city (cityB), refused outside.
    const scoped = await submitConfirmWake(
      ownerB,
      "ownerB",
      "fixture_market_judgment",
      { cityId: "cityB", sections: ["WB-FIX-2"], judgment: "home-city exception applies" },
      { registry: fixtureRegistry }
    );
    const scopedEntries = await entriesOf(scoped.actionId);
    assert.deepEqual((scopedEntries[0].baseline as Record<string, unknown>).sections, ["WB-FIX-2"]);
    const outOfScope = await submitConfirmWake(
      ownerA,
      "ownerA",
      "fixture_market_judgment",
      { cityId: "cityA", sections: ["WB-FIX-2"], judgment: "must refuse" },
      { registry: fixtureRegistry }
    );
    const oosAction = await adminDoc(`sim_actions/${outOfScope.actionId}`);
    assert.equal(oosAction?.status, "rejected");
    assert.equal(
      (oosAction?.failure as Record<string, unknown>)?.code,
      "BASELINE_SECTION_NOT_APPLICABLE"
    );
    await verifyOk(fixtureRegistry);
  }
  console.log("ok Baseline fail-closed + fixture citations, scoped exception (P2-G6)");

  // ======================================================================
  // CK5 — P2-G3: STALE_PREVIEW. A resolution landing between preview and
  // confirmation voids the confirmation's plan: fresh preview, back to
  // awaiting_confirmation, NO Log entry; re-confirmation then commits.
  // ======================================================================
  {
    const staleId = await submitAction(ownerA, "ownerA", "fixture_adjust", {
      cityId: "cityA",
      field: "stats.treasuryRubars",
      delta: 5_000,
    });
    await previewAction(deps(), staleId, { now: nowIso() });
    const firstPreview = (await adminDoc(`sim_actions/${staleId}`))?.preview as Record<string, unknown>;

    await submitConfirmWake(ownerA, "ownerA", "fixture_adjust", {
      cityId: "cityA",
      field: "stats.treasuryRubars",
      delta: 7_000,
    });
    const seqAfterMove = await headSeq();
    const treasuryAfterMove = await treasury("cityA");

    // Confirm the stale action against its (old, stored) preview hash —
    // rules-lawful — and wake: the fabric must NOT commit it.
    const staleActionDoc = await getDoc(doc(ownerA.firestore(), "sim_actions", staleId));
    const stalePreview = (staleActionDoc.data() as Record<string, unknown>).preview as Record<string, unknown>;
    await updateDoc(doc(ownerA.firestore(), "sim_actions", staleId), {
      confirmation: {
        confirmedByUid: "ownerA",
        confirmedAt: Timestamp.now(),
        previewHash: stalePreview.previewHash,
        authorityType: "owner",
      },
      status: "confirmed",
      updatedAt: Timestamp.now(),
    });
    const summary = await wake();
    assert.ok(summary.actionsStale.includes(staleId));
    assert.equal(await headSeq(), seqAfterMove, "a stale preview writes no Log entry");
    assert.equal(await treasury("cityA"), treasuryAfterMove);
    const refreshed = await adminDoc(`sim_actions/${staleId}`);
    assert.equal(refreshed?.status, "awaiting_confirmation");
    assert.notEqual(
      (refreshed?.preview as Record<string, unknown>).previewHash,
      firstPreview.previewHash,
      "the member is shown a FRESH preview"
    );

    // Re-confirm against the fresh preview: commits — the FRESH plan,
    // hash-pinned below. (previewAction is idempotent here — same state,
    // same plan, same stored preview the dispatcher just refreshed; the
    // first assertion proves that identity rather than assuming it.)
    const confirmed = await previewAndConfirm(ownerA, "ownerA", staleId);
    const confirmedPreview = confirmed.preview as Record<string, unknown>;
    assert.equal(
      confirmedPreview.previewHash,
      (refreshed?.preview as Record<string, unknown>).previewHash,
      "the re-confirmation binds to the dispatcher's refreshed preview"
    );
    const summary2 = await wake();
    assert.ok(
      summary2.actionsCommitted.includes(staleId) ||
        (await adminDoc(`sim_actions/${staleId}`))?.status === "resolved"
    );
    // P2-G3 parity, pinned to THIS preview: the committed manifest must
    // carry the fresh preview's planHash + previewHash. Without this
    // pin, a commit of the stale plan would pass whenever its treasury
    // effect happened to coincide with the fresh plan's (here both
    // clamp to 1000) — the treasury assertion below cannot tell the
    // two plans apart.
    const manifest = await adminDoc(`sim_resolutions/${staleId}`);
    assert.equal(manifest?.planHash, confirmed.previewPlanHash);
    assert.equal(manifest?.previewHash, confirmedPreview.previewHash);
    // Treasury expectation — corrected (fix round, PR #21): NOT
    // treasuryAfterMove + 5_000. fixture_adjust plans are absolute,
    // clamped writes (FIXTURE-ADJUST handler: after = clamp(before +
    // delta, 0, 1000)) computed against the preview's snapshot, and
    // the commit reproduces the previewed plan (brief §4.4 step 4;
    // P2-G3 parity) — the nominal delta is never re-applied at commit
    // time. The intervening +7,000 saturated the treasury at the clamp
    // ceiling (treasuryAfterMove = 1000), so the fresh plan is
    // 1000 -> 1000 and committing it leaves the treasury exactly
    // where the move left it. 6000 is unreachable under the fixture
    // semantics at any head in this sequence: every plan here —
    // stale, move, and fresh — writes a clamped value <= 1000.
    assert.equal(await treasury("cityA"), treasuryAfterMove);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok stale preview: no entry, fresh preview, re-confirm commits (P2-G3)");

  // ======================================================================
  // CK7 — P2-G7 pendings + Action-Gated Ripening.
  // ======================================================================
  async function driveActions(n: number) {
    for (let i = 0; i < n; i += 1) {
      await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
        cityId: "cityB",
        field: "stats.treasuryRubars",
        delta: 1,
      });
    }
  }

  // ---- CK7a: the CK2 fund ripens inside a player-caused wake, with
  // origin-actor attribution and the wake recorded as occasion, not cause.
  {
    // cityA's treasury entering this checkpoint is 1,000 — NOT the
    // 900,000 CK2 left behind. The CK6 stale-preview checkpoint's
    // fixture_adjust writes are absolute and clamped to [0, 1000], and
    // its +7,000 move saturated the treasury at that ceiling (see the
    // fix-round note at the CK6 treasury assertion). Pinned here so the
    // ripening derivation below starts from a stated, checked base.
    const treasuryBeforeRipen = await treasury("cityA");
    assert.equal(treasuryBeforeRipen, 1_000);
    const trigger = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    const scan = trigger.summary.scans[0];
    assert.ok(scan?.ripened.includes(fundPendingId), "fund pending ripens in the trigger's wake");
    const pending = await adminDoc(`sim_pending_consequences/${fundPendingId}`);
    assert.equal(pending?.status, "ripened");
    const ripenId = `ripen_${fundPendingId}`;
    const entries = await entriesOf(ripenId);
    assert.ok(entries.length >= 3, "R-33 entry + R-34 entry + summary");
    const triggerAction = await adminDoc(`sim_actions/${trigger.actionId}`);
    for (const entry of entries) {
      assert.equal((entry.actor as Record<string, unknown>).memberId, "ownerA", "origin actor, never 'system'");
      assert.equal(entry.causedBySeq, 4, "cause chain points at the origin, not the wake");
      assert.equal(entry.wakeActionId, trigger.actionId);
      assert.equal(entry.executedDuringSeq, triggerAction?.lastLogSeq);
      assert.equal(entry.pendingId, fundPendingId);
    }
    const r34 = entries.find((e) => (e.ruleIds as string[]).includes("R-34"));
    assert.ok(r34, "R-34 trickle-down entry present");
    const findings = (r34.classification as Record<string, unknown>).trickleDownFindings as unknown[];
    assert.equal(findings.length, 1, "one live-connection path cityA -> cityB");
    // Treasury expectation — corrected (fix round 3, PR #21): NOT
    // 942,000. That figure assumed (i) the treasury still held CK2's
    // 900,000 — it does not; the CK6 clamp legacy pinned above leaves
    // 1,000 — and (ii) a +42,000 ripening yield that no governing text
    // prescribes. Felix §3's canonical fund is GENERATIVE: the gross
    // is prepared payload content inside a published band, not a
    // formula, and Felix's only formulas are the §2.3 delay derivation.
    // His ripening rule (R-26, renumbered R-33) credits NO treasury at
    // all — fund disbursedRubars += payload disbursement; the value
    // lands in inventor/corp receipts and GDP. This fixture is the
    // brief's determinate variant (P2-G7): brief §7.1 — a determinate
    // pending "carries its full effect in payloadSpec" and "ripening
    // is pure resolver arithmetic" on it. The committed payload is
    // CK2's effectDelta of +30,000, applied to the standing balance:
    // 1,000 + 30,000 = 31,000. The fund assertions below are the R-33
    // disbursement contract itself: fundDisbursementRubars (CK2's
    // disbursementRubars, 100,000) moves remaining -> disbursed.
    assert.equal(await treasury("cityA"), treasuryBeforeRipen + 30_000);
    const fund = await adminDoc("sim_cities/cityA/structures/fund1");
    assert.equal(fund?.disbursedRubars, 100_000);
    assert.equal(fund?.remainingRubars, 0);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok ripening: origin attribution, wake fields, R-33/R-34 (P2-G7a)");

  // ======================================================================
  // CK6 — P2-G11 ceilings: WRITE_SET_TOO_LARGE is a logged rejection with
  // zero state change; MANIFEST_TOO_LARGE is a preflight abort, zero writes.
  // ======================================================================
  {
    const structuresCount = async () =>
      (await adminDb.collection("sim_cities/cityA/structures").get()).size;
    const before = await structuresCount();
    const seqBefore = await headSeq();

    const tooLarge = await submitConfirmWake(ownerA, "ownerA", "fixture_scatter", {
      cityId: "cityA",
      count: 445,
    });
    const tooLargeAction = await adminDoc(`sim_actions/${tooLarge.actionId}`);
    assert.equal(tooLargeAction?.status, "rejected");
    assert.equal(
      (tooLargeAction?.failure as Record<string, unknown>)?.code,
      "WRITE_SET_TOO_LARGE"
    );
    assert.equal(await structuresCount(), before, "zero state change on ceiling rejection");
    assert.equal(await headSeq(), seqBefore + 1, "exactly one rejected entry");
    const rejectedEntries = await entriesOf(tooLarge.actionId);
    assert.equal(rejectedEntries.length, 1);
    assert.equal(rejectedEntries[0].kind, "rejected");

    const fits = await submitConfirmWake(ownerA, "ownerA", "fixture_scatter", {
      cityId: "cityA",
      count: 440,
    });
    assert.equal((await adminDoc(`sim_actions/${fits.actionId}`))?.status, "resolved");
    assert.equal(await structuresCount(), before + 440);

    const seqBeforeManifest = await headSeq();
    const huge = await submitAction(ownerA, "ownerA", "fixture_scatter", {
      cityId: "cityA",
      count: 200,
      noteBytes: 6000,
    });
    await previewAndConfirm(ownerA, "ownerA", huge);
    const hugeSummary = await wake();
    assert.ok(hugeSummary.actionsFailed.some((f) => f.actionId === huge && f.code === "MANIFEST_TOO_LARGE"));
    assert.equal((await adminDoc(`sim_actions/${huge}`))?.status, "failed");
    assert.equal(await structuresCount(), before + 440, "manifest preflight writes nothing");
    assert.equal(await headSeq(), seqBeforeManifest, "manifest preflight writes no entries");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok ceilings: WRITE_SET_TOO_LARGE rejected event; MANIFEST_TOO_LARGE abort (P2-G11)");

  // ---- CK7b: child pendings are NOT evaluated in the pass that creates
  // them (one generation per wake); they ripen at the NEXT wake.
  let fund2PendingId = "";
  let childPendingId = "";
  {
    // Fixture economy (fix round 4): every fixture_adjust write clamps
    // to [0, 1000], and CK7a's trigger + driveActions run on cityB's
    // treasury — so entering this checkpoint cityB holds exactly
    // 1,000 R, whatever the seed said. The fund below is sized to that
    // real balance (1,000 R): at 10,000 R it was correctly rejected
    // INSUFFICIENT_TREASURY and no parent pending was created. (An
    // earlier round-4 attempt restored the seed balance with a direct
    // off-Log write; the standing verifier rightly refused it —
    // FIELD_CHAIN_BREAK — because mid-scenario state changes must flow
    // through the Log. The delay derivation is fund-size-insensitive at
    // this scale: fundScale clamps identically, 61 h / 10 seq either
    // way, so no timing assertion moves.)
    const fund2 = await submitConfirmWake(ownerB, "ownerB", "fixture_fund", {
      cityId: "cityB",
      fundName: "Child-bearing fund",
      fundId: "fund2",
      amountRubars: 1_000,
      mode: "determinate",
      effectField: "stats.treasuryRubars",
      effectDelta: 500,
      disbursementRubars: 1_000,
      childPendings: [
        {
          kind: "instant-effect",
          targetCityId: "cityB",
          payloadSpec: {
            mode: "determinate",
            effect: { type: "stat-delta", cityId: "cityB", field: "stats.treasuryRubars", delta: 5 },
            summaryOnRipen: "child effect lands",
          },
        },
      ],
    });
    // Guard (fix round 4): never read a resolution's outputs before
    // asserting the resolution itself landed — a silent rejection here is
    // what masked the CK7b failure as a downstream TypeError.
    assert.equal(
      (await adminDoc(`sim_actions/${fund2.actionId}`))?.status,
      "resolved",
      "fund2's fund action must resolve (its pending is read below)"
    );
    fund2PendingId = `pend_${fund2.actionId}_01`;
    const parent = await adminDoc(`sim_pending_consequences/${fund2PendingId}`);
    const requiredSeq = (parent?.ripenCondition as Record<string, unknown>).requiredSeq as number;
    advanceHours(70);
    while ((await headSeq()) < requiredSeq) await driveActions(1);
    // The wake that crossed requiredSeq ripened the parent (assert via state).
    const parentAfter = await adminDoc(`sim_pending_consequences/${fund2PendingId}`);
    assert.equal(parentAfter?.status, "ripened");
    childPendingId = `pend_ripen_${fund2PendingId}_01`;
    const child = await adminDoc(`sim_pending_consequences/${childPendingId}`);
    assert.ok(child, "child pending was created by the ripening");
    assert.equal(child?.generation, 2);
    assert.equal(child?.chainRootPendingId, fund2PendingId);
    assert.equal(child?.status, "pending", "child NOT ripened in its creating pass");
    advanceHours(2);
    const treasuryBeforeChild = await treasury("cityB");
    const wakeSummary = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    assert.ok(wakeSummary.summary.scans[0]?.ripened.includes(childPendingId));
    assert.equal((await adminDoc(`sim_pending_consequences/${childPendingId}`))?.status, "ripened");
    // The trigger's +1 passes through the fixture clamp ([0, 1000] —
    // registry.ts fixture handler), so from 3,000 it lands at 1,000, not
    // 3,001; the child's ripening delta (+5) is resolver arithmetic and
    // unclamped. Expected: clamp(before + 1) + 5 (fix round 4).
    assert.equal(
      await treasury("cityB"),
      Math.min(Math.max(treasuryBeforeChild + 1, 0), 1000) + 5
    );
    await verifyOk(fixtureRegistry);
  }
  console.log("ok one generation per wake; child ripens next wake (P2-G7b)");

  // ---- CK7c: caps — at most 5 ripenings per wake; the excess waits.
  {
    const pendingIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const scheduled = await submitConfirmWake(ownerA, "ownerA", "fixture_schedule", {
        cityId: "cityA",
        pendingKind: "instant-effect",
        effectField: "stats.treasuryRubars",
        effectDelta: 10,
      });
      pendingIds.push(`pend_${scheduled.actionId}_01`);
    }
    advanceHours(2);
    const first = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    assert.equal(first.summary.scans[0]?.ripened.length, 5, "cap: exactly 5 ripen in one wake");
    const stillPending = [];
    for (const id of pendingIds) {
      const docData = await adminDoc(`sim_pending_consequences/${id}`);
      if (docData?.status === "pending") stillPending.push(id);
    }
    assert.equal(stillPending.length, 1);
    const second = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    assert.deepEqual(second.summary.scans[0]?.ripened, stillPending);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok ripening caps: 5 per wake, excess waits (P2-G7c)");

  // ---- CK7d: voiding — a precondition that ceases to hold ends the
  // pending as a logged world outcome (not an error).
  {
    await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "vault1",
      status: "active",
      name: "Vault One",
    });
    const scheduled = await submitConfirmWake(ownerA, "ownerA", "fixture_schedule", {
      cityId: "cityA",
      pendingKind: "instant-effect",
      effectField: "stats.treasuryRubars",
      effectDelta: 999,
      preconditions: [
        {
          type: "record-status",
          path: "sim_cities/cityA/structures/vault1",
          field: null,
          operator: "==",
          value: "active",
          onFalse: "void",
        },
      ],
      voidEffects: [
        { type: "stat-delta", cityId: "cityA", field: "stats.treasuryRubars", delta: 77 },
      ],
    });
    const voidPendingId = `pend_${scheduled.actionId}_01`;
    advanceHours(2);
    const treasuryBefore = await treasury("cityA");
    const dissolve = await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "vault1",
      status: "dissolved",
    });
    assert.ok(dissolve.summary.scans[0]?.voided.includes(voidPendingId));
    const pending = await adminDoc(`sim_pending_consequences/${voidPendingId}`);
    assert.equal(pending?.status, "voided");
    assert.ok(String(pending?.voidReason).includes("precondition"));
    const voidEntries = await entriesOf(`void_${voidPendingId}`);
    assert.ok(voidEntries.length >= 2);
    assert.equal(voidEntries[0].causedBySeq, pending?.originSeq);
    assert.equal(await treasury("cityA"), treasuryBefore + 77, "voiding terms applied; the 999 effect never lands");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok voiding: precondition loss -> logged void, terms applied (P2-G7d)");

  // ---- CK7e: generative ripening — unprepared waits silently; invalid
  // payloads count attempts (needsAttention at 3); a valid payload ripens
  // with its generation record on the entries.
  {
    const treasuryAtStart = await treasury("cityA");
    const fund3 = await submitConfirmWake(ownerA, "ownerA", "fixture_fund", {
      cityId: "cityA",
      fundName: "Generative fund",
      fundId: "fund3",
      amountRubars: 10_000,
      mode: "generative",
      bounds: { minRubars: 1_000, maxRubars: 5_000 },
    });
    const genPendingId = `pend_${fund3.actionId}_01`;
    const created = await adminDoc(`sim_pending_consequences/${genPendingId}`);
    const requiredSeq = (created?.ripenCondition as Record<string, unknown>).requiredSeq as number;
    advanceHours(70);
    while ((await headSeq()) < requiredSeq) await driveActions(1);

    // Ripe but unprepared: skipped silently, no attempt recorded.
    const unprepared = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    assert.ok(unprepared.summary.scans[0]?.skippedUnprepared.includes(genPendingId));
    assert.equal((await adminDoc(`sim_pending_consequences/${genPendingId}`))?.attempts, 0);

    // Three invalid preparations, each riding an action wake (an empty
    // wake runs no scan — causality): attempts accumulate, no Log entries.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const actionId = await submitAction(ownerB, "ownerB", "fixture_adjust", {
        cityId: "cityB",
        field: "stats.treasuryRubars",
        delta: 1,
      });
      await previewAndConfirm(ownerB, "ownerB", actionId);
      const summary = await wake({
        preparedPayloads: new Map([
          [genPendingId, { generatedContent: { creditRubars: 999_999, summaryText: "too big" }, inputHash: `genhash-bad-${attempt}` }],
        ]),
      });
      assert.ok(
        summary.scans[0]?.failed.some((f) => f.pendingId === genPendingId),
        `attempt ${attempt} records a generation failure`
      );
      const pendingNow = await adminDoc(`sim_pending_consequences/${genPendingId}`);
      assert.equal(pendingNow?.attempts, attempt);
      assert.equal(pendingNow?.status, "pending");
      assert.equal(await adminDoc(`sim_resolutions/ripen_${genPendingId}`), null, "failures write no Log entries");
    }
    assert.equal((await adminDoc(`sim_pending_consequences/${genPendingId}`))?.needsAttention, true);

    // A valid payload ripens with the generation record bound by hash.
    const actionId = await submitAction(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    await previewAndConfirm(ownerB, "ownerB", actionId);
    const summary = await wake({
      preparedPayloads: new Map([
        [genPendingId, { generatedContent: { creditRubars: 3_000, summaryText: "Breakthrough: +3,000 R", seed: null }, inputHash: "genhash-valid" }],
      ]),
    });
    assert.ok(summary.scans[0]?.ripened.includes(genPendingId));
    const ripenEntries = await entriesOf(`ripen_${genPendingId}`);
    const summaryEntry = ripenEntries[ripenEntries.length - 1];
    const generation = summaryEntry.generation as Record<string, unknown>;
    assert.equal(generation.preparedBy, "worker");
    assert.equal(generation.preparedInputHash, "genhash-valid");
    assert.equal(generation.boundsChecked, true);
    assert.equal(await treasury("cityA"), treasuryAtStart - 10_000 + 3_000);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok generative ripening: skip/fail/ripen with generation record (P2-G7e)");

  // ======================================================================
  // CK8 — P2-G8: the undo battery (TC-U01–U11 + N-1).
  // ======================================================================
  let opCounter = 0;
  const createUndoOp = async (
    ctx: RulesTestContext,
    uid: string,
    targetResolutionId: string
  ): Promise<string> => {
    opCounter += 1;
    const opId = sha256Hex(`${uid}:undo-${opCounter}`);
    await setDoc(doc(ctx.firestore(), "sim_undo_operations", opId), {
      opId,
      requesterUid: uid,
      targetResolutionId,
      status: "requested",
      dependencyReport: null,
      completion: null,
      failure: null,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    return opId;
  };
  const readOp = async (opId: string) => adminDoc(`sim_undo_operations/${opId}`);
  const adjust = (
    ctx: RulesTestContext,
    uid: string,
    cityId: string,
    delta: number,
    extra?: Record<string, unknown>
  ) =>
    submitConfirmWake(ctx, uid, "fixture_adjust", {
      cityId,
      field: "stats.treasuryRubars",
      delta,
      ...(extra ?? {}),
    });

  // ---- TC-U01/U02: leaf undo erases totally; the world hash returns.
  {
    const before = await f2();
    const { actionId } = await adjust(ownerB, "ownerB", "cityB", 111);
    const treasuryAfter = await treasury("cityB");
    const opId = await createUndoOp(ownerB, "ownerB", actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "completed");
    const completion = op?.completion as Record<string, unknown>;
    assert.equal(completion.erasedEntryCount, 2);
    assert.equal(completion.erasedResolutionId, actionId);
    assert.equal(op?.targetResolutionId, null, "proof is content-free: target nulled at completion");
    assert.equal(await treasury("cityB"), treasuryAfter - 111);
    assert.equal((await entriesOf(actionId)).length, 0, "entries erased");
    assert.equal(await adminDoc(`sim_resolutions/${actionId}`), null, "manifest erased");
    assert.equal(await adminDoc(`sim_actions/${actionId}`), null, "source action erased");
    assert.deepEqual(await f2(), before, "F2 slices return to the pre-action hash (U02)");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok undo leaf: total erasure, hash restoration (TC-U01/U02)");

  // ---- TC-U03: suffix-only — refusal names the first structural
  // successor; LIFO unwinding then succeeds one by one.
  {
    const a1 = await adjust(ownerA, "ownerA", "cityA", 10);
    const a2 = await adjust(ownerA, "ownerA", "cityA", 20);
    const before = await f2();
    const opId = await createUndoOp(ownerA, "ownerA", a1.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    const report = op?.dependencyReport as Record<string, unknown>;
    assert.equal(
      (report.structuralSuccessor as Record<string, unknown>).resolutionId,
      a2.actionId,
      "refusal names the first structural successor"
    );
    assert.deepEqual(await f2(), before, "a refused undo changes nothing (TC-U08)");
    const op2 = await createUndoOp(ownerA, "ownerA", a2.actionId);
    await wake();
    assert.equal((await readOp(op2))?.status, "completed");
    const op3 = await createUndoOp(ownerA, "ownerA", a1.actionId);
    await wake();
    assert.equal((await readOp(op3))?.status, "completed");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok undo suffix rule + LIFO unwinding (TC-U03)");

  // ---- TC-U04/S6: a pending's existence + a check-in reference lock the
  // origin absolutely.
  {
    const fund4 = await submitConfirmWake(ownerA, "ownerA", "fixture_fund", {
      cityId: "cityA",
      fundName: "Locked fund",
      fundId: "fund4",
      amountRubars: 5_000,
      mode: "determinate",
      effectField: "stats.treasuryRubars",
      effectDelta: 1_000,
      disbursementRubars: 5_000,
    });
    const pendingId = `pend_${fund4.actionId}_01`;
    await submitConfirmWake(memberC, "memberC", "fixture_check_in", { pendingId });
    const opId = await createUndoOp(ownerA, "ownerA", fund4.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    const blockers = (op?.dependencyReport as Record<string, unknown>)
      .semanticBlockers as Record<string, unknown>[];
    assert.ok(
      blockers.some((b) => b.kind === "S6" && b.refKey === `pending:${pendingId}`),
      `S6 blocker naming the referenced pending; got ${JSON.stringify(blockers)}`
    );
  }
  console.log("ok undo S6: referenced pending locks origin (TC-U04)");

  // ---- S3: another member's responding resolution blocks.
  {
    const x = await adjust(ownerA, "ownerA", "cityA", 3);
    const y = await adjust(ownerB, "ownerB", "cityB", 4, {
      citations: { resolutionIds: [x.actionId] },
    });
    const opId = await createUndoOp(ownerA, "ownerA", x.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    const blockers = (op?.dependencyReport as Record<string, unknown>)
      .semanticBlockers as Record<string, unknown>[];
    assert.ok(
      blockers.some((b) => b.kind === "S3" && b.refKey === `resolution:${y.actionId}`),
      `S3 blocker naming the responder; got ${JSON.stringify(blockers)}`
    );
  }
  console.log("ok undo S3: member response blocks (TC-U04)");

  // ---- S4: a verification resolution relying on a publication that
  // stands on the target blocks (publications themselves never delete).
  {
    const x = await adjust(ownerA, "ownerA", "cityA", 5);
    await assertSucceeds(
      setDoc(doc(ownerA.firestore(), "sim_publications", "pubVerify"), {
        cityId: "cityA",
        businessId: null,
        publisherUid: "ownerA",
        version: 1,
        supersedesPublicationId: null,
        status: "published",
        publishedAtSeq: await headSeq(),
        claims: [],
        visibility: "members",
      })
    );
    const verify = await submitConfirmWake(ownerB, "ownerB", "fixture_verify_publication", {
      publicationPath: "sim_publications/pubVerify",
      targetResolutionId: x.actionId,
    });
    const opId = await createUndoOp(ownerA, "ownerA", x.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    const blockers = (op?.dependencyReport as Record<string, unknown>)
      .semanticBlockers as Record<string, unknown>[];
    assert.ok(
      blockers.some((b) => b.kind === "S4" && b.refKey === `resolution:${verify.actionId}`),
      `S4 blocker naming the relying verification; got ${JSON.stringify(blockers)}`
    );
  }
  console.log("ok undo S4: publication reliance blocks (TC-U04)");

  // ---- TC-U06: authority — a non-actor's request is refused.
  {
    const x = await adjust(ownerA, "ownerA", "cityA", 6);
    const opId = await createUndoOp(ownerB, "ownerB", x.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    assert.equal((op?.failure as Record<string, unknown>)?.code, "UNDO_NOT_AUTHORIZED");
  }
  console.log("ok undo authority (TC-U06)");

  // ---- TC-U07: the race — a dependent landing between request and
  // execution voids the proof; nothing is erased.
  {
    const x = await adjust(ownerA, "ownerA", "cityA", 7);
    const opId = await createUndoOp(ownerA, "ownerA", x.actionId);
    const y = await adjust(ownerA, "ownerA", "cityA", 8);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused", "revalidation at execution refuses the now-non-suffix target");
    assert.equal((await entriesOf(x.actionId)).length, 2, "target intact");
    // Unwind cleanly for the next checks.
    for (const target of [y.actionId, x.actionId]) {
      const cleanupOp = await createUndoOp(ownerA, "ownerA", target);
      await wake();
      assert.equal((await readOp(cleanupOp))?.status, "completed");
    }
  }
  console.log("ok undo race: stale proof refuses, nothing erased (TC-U07)");

  // ---- TC-U11: double-undo fails clean; recreating the content lands
  // as a NEW resolution at the reused seqs (P2-K4).
  {
    const x = await adjust(ownerA, "ownerA", "cityA", 9);
    const xAction = await adminDoc(`sim_actions/${x.actionId}`);
    const xFirstSeq = xAction?.firstLogSeq as number;
    const op1 = await createUndoOp(ownerA, "ownerA", x.actionId);
    await wake();
    assert.equal((await readOp(op1))?.status, "completed");
    const op2 = await createUndoOp(ownerA, "ownerA", x.actionId);
    await wake();
    const second = await readOp(op2);
    assert.equal(second?.status, "failed");
    assert.equal((second?.failure as Record<string, unknown>)?.code, "TARGET_NOT_FOUND");
    const recreated = await adjust(ownerA, "ownerA", "cityA", 9);
    const recreatedAction = await adminDoc(`sim_actions/${recreated.actionId}`);
    assert.equal(recreatedAction?.firstLogSeq, xFirstSeq, "seqs are coordinates in the standing Log: reused after erasure");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok double-undo clean fail; seq reuse (TC-U11, P2-K4)");

  // ---- N-1: undiscovered covert activity undoes cleanly (including
  // from the actor's own view); discovered activity is locked, and the
  // refusal names the discovery only to the requester.
  {
    const covert = await submitConfirmWake(ownerA, "ownerA", "fixture_covert_note", {
      cityId: "cityA",
      note: "watch the docks",
    });
    // Guard (fix round 4): assert the resolution landed before reading
    // its entries — a silent commit failure here surfaced as a bare
    // TypeError on the summary entry's seq.
    assert.equal(
      (await adminDoc(`sim_actions/${covert.actionId}`))?.status,
      "resolved",
      "the covert collection action must resolve (its entries are read below)"
    );
    const covertEntries = await entriesOf(covert.actionId);
    assert.ok(covertEntries.every((e) => e.visibility === "actor-private"));
    const summaryEntry = covertEntries[covertEntries.length - 1];
    await assertSucceeds(
      getDoc(doc(ownerA.firestore(), "sim_log_entries", logEntryDocId(summaryEntry.seq as number)))
    );
    await assertFails(
      getDoc(doc(ownerB.firestore(), "sim_log_entries", logEntryDocId(summaryEntry.seq as number)))
    );
    assert.ok(await adminDoc(`sim_intel_records/covert_${covert.actionId}`));
    const opId = await createUndoOp(ownerA, "ownerA", covert.actionId);
    await wake();
    assert.equal((await readOp(opId))?.status, "completed", "undiscovered covert undo is ordinary");
    assert.equal(await adminDoc(`sim_intel_records/covert_${covert.actionId}`), null);
    assert.equal((await entriesOf(covert.actionId)).length, 0, "gone from the actor's own view too");

    const covert2 = await submitConfirmWake(ownerA, "ownerA", "fixture_covert_note", {
      cityId: "cityA",
      note: "watch the granary",
    });
    const covert2Entries = await entriesOf(covert2.actionId);
    const covert2SummarySeq = covert2Entries[covert2Entries.length - 1].seq as number;
    const discovery = await submitConfirmWake(ownerB, "ownerB", "fixture_discover", {
      targetResolutionId: covert2.actionId,
      discoveredSeq: covert2SummarySeq,
    });
    const op2 = await createUndoOp(ownerA, "ownerA", covert2.actionId);
    await wake();
    const refused = await readOp(op2);
    assert.equal(refused?.status, "refused");
    const blockers = (refused?.dependencyReport as Record<string, unknown>)
      .semanticBlockers as Record<string, unknown>[];
    assert.ok(
      blockers.some((b) => b.kind === "S7" && b.refKey === `resolution:${discovery.actionId}`),
      `S7 blocker naming the discovery; got ${JSON.stringify(blockers)}`
    );
    // The naming stays requester-only: ownerB cannot read ownerA's op.
    await assertSucceeds(getDoc(doc(ownerA.firestore(), "sim_undo_operations", op2)));
    await assertFails(getDoc(doc(ownerB.firestore(), "sim_undo_operations", op2)));
    await verifyOk(fixtureRegistry);
  }
  console.log("ok N-1: covert undo clean; discovered locked, named to requester only");

  // ---- TC-U09/S5: destruction with repairs begun is locked.
  {
    await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "tower1",
      status: "built",
      name: "Tower One",
    });
    const destroy = await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "tower1",
      status: "demolished",
    });
    const repair = await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "tower1",
      status: "under-repair",
      citations: { resolutionIds: [destroy.actionId] },
    });
    const opId = await createUndoOp(ownerA, "ownerA", destroy.actionId);
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "refused");
    const blockers = (op?.dependencyReport as Record<string, unknown>)
      .semanticBlockers as Record<string, unknown>[];
    assert.ok(
      blockers.some((b) => b.kind === "S5" && b.refKey === `resolution:${repair.actionId}`),
      `S5 blocker naming the repair; got ${JSON.stringify(blockers)}`
    );
    const tower = await adminDoc("sim_cities/cityA/structures/tower1");
    assert.equal(tower?.status, "under-repair", "destruction stays permanent; repair is the only way back");
  }
  console.log("ok undo S5: destruction under repair locked (TC-U09)");

  // ---- Genesis is never a target.
  {
    const opId = await createUndoOp(ownerA, "ownerA", "genesis");
    await wake();
    const op = await readOp(opId);
    assert.equal(op?.status, "failed");
    assert.equal((op?.failure as Record<string, unknown>)?.code, "TARGET_NOT_FOUND");
    assert.equal(await headSeq(), (await counter()).lastSeq as number);
    assert.ok(await adminDoc(`sim_log_entries/${logEntryDocId(1)}`), "genesis stands");
  }
  console.log("ok genesis never undoable");

  // ======================================================================
  // CK9 — P2-G1: concurrent commits serialize on the counter; a retried
  // commit step returns the stored manifest (TC-A04 idempotency).
  // ======================================================================
  {
    const a = await submitAction(ownerA, "ownerA", "fixture_adjust", {
      cityId: "cityA",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    await previewAndConfirm(ownerA, "ownerA", a);
    const b = await submitAction(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 2,
    });
    await previewAndConfirm(ownerB, "ownerB", b);
    const seqBefore = await headSeq();
    await Promise.all([wake(), wake()]);
    assert.equal((await adminDoc(`sim_actions/${a}`))?.status, "resolved");
    assert.equal((await adminDoc(`sim_actions/${b}`))?.status, "resolved");
    assert.equal(await headSeq(), seqBefore + 4, "two resolutions, contiguous seqs, exactly once each");
    await verifyOk(fixtureRegistry);

    // Same-request retry: build one commit request and fire it twice.
    const c = await submitAction(ownerA, "ownerA", "fixture_adjust", {
      cityId: "cityA",
      field: "stats.treasuryRubars",
      delta: 3,
    });
    await previewAndConfirm(ownerA, "ownerA", c);
    await updateDoc(doc(committerFs, "sim_actions", c), {
      status: "resolving",
      claim: {
        cycleId: "manual-cycle",
        leaseId: "lease-manual",
        attempt: 1,
        claimedAt: Timestamp.now(),
        leaseExpiresAt: Timestamp.fromMillis(Date.now() + 600_000),
      },
      updatedAt: Timestamp.now(),
    });
    const actionDocData = (await adminDoc(`sim_actions/${c}`)) as unknown as Parameters<
      typeof resolveAction
    >[1];
    const paths = collectActionReadPaths(actionDocData);
    const snapshot = await buildSnapshot(firestoreReader(committerFs), paths, nowIso());
    const plan = resolveAction(snapshot, actionDocData, {
      baselineRegistry: PRODUCTION_BASELINE_REGISTRY,
      mode: "commit",
    });
    const req = {
      resolutionId: c,
      sourceKind: "action" as const,
      now: nowIso(),
      plan,
      expectedHeads: snapshot.heads,
      snapshotPaths: paths,
      action: actionDocData,
      claimLeaseId: "lease-manual",
    };
    const first = await commitResolution({ db: committerFs, baselineRegistry: PRODUCTION_BASELINE_REGISTRY }, req);
    assert.equal(first.status, "committed");
    const seqAfterFirst = await headSeq();
    const second = await commitResolution({ db: committerFs, baselineRegistry: PRODUCTION_BASELINE_REGISTRY }, req);
    assert.equal(second.status, "already-committed", "retry returns the stored manifest, writes nothing");
    assert.equal(await headSeq(), seqAfterFirst);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok concurrency serialization + commit idempotency (P2-G1, TC-A04)");

  // ======================================================================
  // CK10 — P2-G10 surfaces (pure parts): workbook split-first packaging,
  // -PARTIAL only on explicit limit, CSV parity; read-path merge.
  // ======================================================================
  {
    const fab = (seq: number, changes = 0): ExportEntry => ({
      seq,
      entryHash: "a".repeat(64),
      prevHash: "b".repeat(64),
      resolutionId: `r${seq}`,
      kind: "action-summary",
      resolvedAt: "2026-10-18T00:00:00.000Z",
      rulesVersion: "sim-rules-0.2.0-phase2",
      hashVersion: "cowboy-canonical-json-v2",
      actorLabel: "member ownerA",
      actorUid: "ownerA",
      cityId: "cityA",
      cityIds: ["cityA"],
      ruleIds: [],
      visibility: "public",
      baselineVersion: null,
      summaryText: `entry ${seq}`,
      writeSetDigest: "c".repeat(64),
      changes: Array.from({ length: changes }, (_, i) => ({
        field: `f${i}`,
        before: i,
        after: i + 1,
        formula: "fixture",
      })),
    });
    const small = planLogWorkbooks({
      entries: [fab(1), fab(2, 2), fab(3)],
      requesterLabel: "ownerA",
      asOfSeq: 3,
      exportedAtIso: "2026-10-18T00:00:00.000Z",
    });
    assert.equal(small.length, 1);
    assert.equal(small[0].partial, false);
    assert.ok(!small[0].filename.includes("PARTIAL"));
    assert.equal(small[0].sheets.find((s) => s.name === "Changes")?.rows.length, 1 + 2);
    const limited = planLogWorkbooks({
      entries: [fab(1), fab(2), fab(3)],
      requesterLabel: "ownerA",
      asOfSeq: 3,
      exportedAtIso: "2026-10-18T00:00:00.000Z",
      explicitLimit: 2,
    });
    assert.equal(limited[0].partial, true);
    assert.ok(limited[0].filename.includes("-PARTIAL"));
    assert.equal(limited[0].fromSeq, 2);
    const coverText = JSON.stringify(limited[0].sheets[0].rows);
    assert.ok(coverText.includes("PARTIAL EXPORT"), "partiality is declared on the Cover");
    // Split-first: 60k entries exceed the per-tab cap, so the export
    // splits by contiguous seq range instead of truncating.
    const many = Array.from({ length: 60_000 }, (_, i) => fab(i + 1));
    const parts = planLogWorkbooks({
      entries: many,
      requesterLabel: "ownerA",
      asOfSeq: 60_000,
      exportedAtIso: "2026-10-18T00:00:00.000Z",
    });
    assert.ok(parts.length >= 2, "caps split, never truncate");
    assert.equal(parts[0].toSeq + 1, parts[1].fromSeq, "contiguous ranges");
    for (const part of parts) {
      const entryRows = part.sheets.find((s) => s.name === "Log Entries")?.rows.length ?? 0;
      assert.ok(entryRows - 1 <= 50_000, "per-tab cap respected");
    }
    const csvHeader = small[0].csv.content.split("\n")[0];
    assert.ok(csvHeader.startsWith("seq,entry_hash,prev_hash"), "CSV mirrors the tab columns");
  }
  console.log("ok export packaging: split-first, -PARTIAL discipline (P2-G10)");

  // ======================================================================
  // Step 0 (Phase 4) — engine-hardening fixtures (prep §4.0): F-02
  // planWrite folding + changes↔writes reconciliation; F-01 contracted
  // read plans; F-07 prepared-payload binding; the wake-order lock.
  // ======================================================================

  // ---- S0-F02 (pure): a voiding with two effects on the SAME field of
  // the same doc — the landed replacement flaw — now lands both,
  // chained; a plan whose changes cannot chain fails validatePlan.
  {
    const snap = snapshotFromDocs(
      new Map<string, Record<string, unknown> | null>([
        ["sim_counters/log", { lastSeq: 3, lastEntryHash: "ab".repeat(32) }],
        ["sim_world/current", { lastCommittedSeq: 3 }],
        ["sim_cities/cityA", { cityId: "cityA", stats: { treasuryRubars: 100, culture: 40 } }],
      ]),
      nowIso()
    );
    const pendingDoc: Record<string, unknown> = {
      pendingId: "pend_s0_pure",
      originActor: memberActor("ownerA"),
      originSeq: 2,
      originResolutionId: "act_s0_origin",
      targetCityId: "cityA",
      payloadSpec: {
        voidEffects: [
          { type: "stat-delta", cityId: "cityA", field: "stats.treasuryRubars", delta: 30 },
          { type: "stat-delta", cityId: "cityA", field: "stats.treasuryRubars", delta: 12 },
          { type: "stat-delta", cityId: "cityA", field: "stats.culture", delta: 1 },
        ],
      },
    };
    const plan = resolveVoiding(snap, pendingDoc, {
      baselineRegistry: fixtureRegistry,
      voidReason: "s0 fixture: precondition ceased",
    });
    const cityWrite = plan.writes.find((w) => w.path === "sim_cities/cityA");
    assert.ok(cityWrite?.afterDoc, "one folded write for the city doc");
    const foldedStats = (cityWrite.afterDoc as Record<string, unknown>).stats as Record<string, number>;
    assert.equal(foldedStats.treasuryRubars, 142, "both treasury effects landed (30 + 12)");
    assert.equal(foldedStats.culture, 41);
    const effectEntry = plan.entries[0];
    assert.deepEqual(
      effectEntry.changes.map((c) => [c.field, c.before, c.after]),
      [
        ["stats.treasuryRubars", 100, 130],
        ["stats.treasuryRubars", 130, 142],
        ["stats.culture", 40, 41],
      ],
      "changes chain off each other, not off the snapshot"
    );
    validatePlan(plan, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot: snap });
    const tampered = structuredClone(plan);
    tampered.entries[0].changes.push({ field: "stats.treasuryRubars", before: 999999, after: 1, formula: "tampered" });
    assert.throws(
      () => validatePlan(tampered, { baselineRegistry: fixtureRegistry, covertEntriesAllowed: false, snapshot: snap }),
      (e: unknown) => e instanceof PlanValidationError && /F-02/.test((e as Error).message),
      "a change that cannot chain to the folded write must fail validation"
    );
  }
  console.log("ok S0-F02 pure: voiding folds multi-effect writes; reconciliation catches stale changes");

  // ---- S0-F02 (e2e): two-effect voiding through the full stack. The
  // second effect targets stats.households — NOT an allocatable index:
  // at genesis every index (stats.culture included) is null under the
  // K-3 template and stays null until Phase 4 allocation, and a
  // stat-delta against a null field is skipped by design (the engine
  // never invents an index value; null-honesty). households is a true
  // bookkeeping zero, numeric from genesis, on the same city doc — so
  // both effects can and must land. (Fix round 1: the original fixture
  // used stats.culture +1 and asserted null + 1 === 1 against an actual
  // null — a test bug; the engine folded correctly throughout. The
  // same-field chaining case is covered by the pure fixture above.)
  {
    await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "vault2",
      status: "active",
      name: "Vault Two",
    });
    const householdsBefore = (await cityStats("cityA")).households as number;
    assert.equal(typeof householdsBefore, "number", "households is numeric from genesis (template zero)");
    const scheduled = await submitConfirmWake(ownerA, "ownerA", "fixture_schedule", {
      cityId: "cityA",
      pendingKind: "instant-effect",
      effectField: "stats.treasuryRubars",
      effectDelta: 555,
      preconditions: [
        {
          type: "record-status",
          path: "sim_cities/cityA/structures/vault2",
          field: null,
          operator: "==",
          value: "active",
          onFalse: "void",
        },
      ],
      voidEffects: [
        { type: "stat-delta", cityId: "cityA", field: "stats.treasuryRubars", delta: 30 },
        { type: "stat-delta", cityId: "cityA", field: "stats.households", delta: 1 },
      ],
    });
    const voidPendingId = `pend_${scheduled.actionId}_01`;
    advanceHours(2);
    const treasuryBefore = await treasury("cityA");
    const dissolve = await submitConfirmWake(ownerA, "ownerA", "fixture_structure", {
      cityId: "cityA",
      structureId: "vault2",
      status: "dissolved",
    });
    assert.ok(dissolve.summary.scans[0]?.voided.includes(voidPendingId));
    assert.equal(await treasury("cityA"), treasuryBefore + 30, "first void effect landed");
    assert.equal((await cityStats("cityA")).households, householdsBefore + 1, "second void effect on the same doc landed too (F-02)");
    assert.equal((await cityStats("cityA")).culture, null, "unallocated index stays null — a stat-delta never invents a value");
    const voidEntries = await entriesOf(`void_${voidPendingId}`);
    assert.ok(voidEntries.length >= 2);
    const effectFields = (voidEntries[0].changes as Record<string, unknown>[]).map((c) => c.field);
    assert.deepEqual(effectFields, ["stats.treasuryRubars", "stats.households"]);
    await verifyOk(fixtureRegistry);
  }
  console.log("ok S0-F02 e2e: two effects, one doc, both land (prep §4.0 F-02 fixture)");

  // ---- S0-F01 (pure): the committer recompute contract. The
  // committer re-derives the plan in-transaction over snapshotFromDocs;
  // the F-01 query records the dispatcher's plan was computed from must
  // ride into that snapshot or the recompute finds no materialized set
  // and every query-plan resolution falls out as a spurious stale
  // preview (fix round 2: this is the exact shape CI caught in the
  // e2e below — READ_PLAN_MISSING on recompute, action never commits).
  {
    const store = new Map<string, Record<string, unknown> | null>([
      ["sim_counters/log", { lastSeq: 57, lastEntryHash: "cd".repeat(32) }],
      ["sim_world/current", { lastCommittedSeq: 57 }],
      ["sim_cities/cityA", { cityId: "cityA", stats: { treasuryRubars: 1000, households: 0 } }],
      ["factions/cityA", { factionId: "cityA", ownerUids: ["ownerA"] }],
      ["sim_cities/cityA/structures/ob1", { structureId: "ob1", status: "resting", priceRubars: 100 }],
      ["sim_cities/cityA/structures/ob2", { structureId: "ob2", status: "resting", priceRubars: 250 }],
      ["sim_cities/cityA/structures/ob3", { structureId: "ob3", status: "built", priceRubars: 999 }],
    ]);
    const { actionId: pureObId, doc: pureObDoc } = buildActionDoc({
      actorUid: "ownerA",
      clientRequestId: "req-s0-f01-pure",
      actor: memberActor("ownerA"),
      actionType: "fixture_orderbook",
      actionText: null,
      structuredAction: {
        cityId: "cityA",
        citations: { recordPaths: ["sim_cities/cityA/structures/ob1"] },
      },
      targetCityIds: [],
      now: nowIso(),
    });
    store.set(`sim_actions/${pureObId}`, pureObDoc as unknown as Record<string, unknown>);
    const pureObAction = pureObDoc as unknown as import("../lib/sim/state").SimAction;
    const memReader: DocReader = { get: async (p) => store.get(p) ?? null };
    const memQuery: QueryReader = {
      query: async (spec: CollectionQuerySpec) => {
        const prefix = `${spec.collectionPath}/`;
        let rows = [...store.entries()]
          .filter(([p, d]) => d && p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map(([path, doc]) => ({ path, doc: doc as Record<string, unknown> }));
        for (const f of spec.filters) rows = rows.filter((r) => r.doc[f.field] === f.value);
        for (const o of [...(spec.orderBy ?? [])].reverse()) {
          rows.sort((a, b) =>
            o.direction === "desc"
              ? (b.doc[o.field] as number) - (a.doc[o.field] as number)
              : (a.doc[o.field] as number) - (b.doc[o.field] as number)
          );
        }
        return typeof spec.limit === "number" ? rows.slice(0, spec.limit) : rows;
      },
    };
    const seedSnap = await buildSnapshot(memReader, collectActionReadPaths(pureObAction), nowIso());
    const purePlan = collectActionReadPlan(pureObAction, seedSnap.docs);
    const materialized = await materializeSnapshot(memReader, memQuery, purePlan, nowIso());
    const dispatchedPlan = resolveAction(materialized, pureObAction, {
      baselineRegistry: fixtureRegistry,
      mode: "commit",
    });
    assert.equal(dispatchedPlan.outcome, "resolved", "materialized plan resolves");
    const txPaths = [
      ...new Set([
        "sim_counters/log",
        "sim_world/current",
        `sim_resolutions/${pureObId}`,
        `sim_actions/${pureObId}`,
        ...purePlan.paths,
        ...materialized.queries.flatMap((q) => q.resultPaths),
      ]),
    ];
    const txDocs = new Map(txPaths.map((p) => [p, store.get(p) ?? null]));
    const bareRecompute = resolveAction(snapshotFromDocs(txDocs, nowIso()), pureObAction, {
      baselineRegistry: fixtureRegistry,
      mode: "commit",
    });
    assert.equal(bareRecompute.outcome, "rejected", "no records re-attached: recompute cannot resolve");
    assert.equal(bareRecompute.rejection?.code, "READ_PLAN_MISSING");
    assert.notEqual(bareRecompute.planHash, dispatchedPlan.planHash);
    const boundRecompute = resolveAction(
      snapshotFromDocs(txDocs, nowIso(), materialized.queries),
      pureObAction,
      { baselineRegistry: fixtureRegistry, mode: "commit" }
    );
    assert.equal(boundRecompute.outcome, "resolved", "records re-attached: recompute resolves");
    assert.equal(
      boundRecompute.planHash,
      dispatchedPlan.planHash,
      "the committer recompute reproduces the previewed plan exactly (F-01 parity)"
    );
  }
  console.log("ok S0-F01 pure: committer recompute needs the query records re-attached — parity with them, READ_PLAN_MISSING without");

  // ---- S0-F01 (e2e): the order-book read plan. Structures are seeded
  // directly (the suite's fixture pattern) and removed afterwards; the
  // action cites only ONE resting order — the descriptor's read plan
  // must still read the whole resting set.
  {
    await env.withSecurityRulesDisabled(async (context) => {
      const fs = context.firestore();
      await setDoc(doc(fs, "sim_cities/cityA/structures", "ob1"), { structureId: "ob1", status: "resting", priceRubars: 100 });
      await setDoc(doc(fs, "sim_cities/cityA/structures", "ob2"), { structureId: "ob2", status: "resting", priceRubars: 250 });
      await setDoc(doc(fs, "sim_cities/cityA/structures", "ob3"), { structureId: "ob3", status: "built", priceRubars: 999 });
    });
    const confirmStoredPreview = async (actionId: string) => {
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

    const obAction = await submitAction(ownerA, "ownerA", "fixture_orderbook", {
      cityId: "cityA",
      citations: { recordPaths: ["sim_cities/cityA/structures/ob1"] },
    });
    await previewAndConfirm(ownerA, "ownerA", obAction, fixtureRegistry);
    const obSummary = await wake({ registry: fixtureRegistry });
    assert.ok(obSummary.actionsCommitted.includes(obAction), "orderbook action committed");
    assert.equal((await cityStats("cityA")).fixtureRestingOrders, 2, "both resting orders counted — the uncited ob2 was read");
    assert.equal((await cityStats("cityA")).fixtureOrderBookRubars, 350, "100 + 250; the built ob3 is excluded");
    const obManifest = await adminDoc(`sim_resolutions/${obAction}`);
    const queryInputs = (obManifest?.queryInputs ?? []) as Record<string, unknown>[];
    assert.equal(queryInputs.length, 1, "the manifest's input set binds the query read");
    assert.deepEqual(queryInputs[0].resultPaths, [
      "sim_cities/cityA/structures/ob1",
      "sim_cities/cityA/structures/ob2",
    ]);
    assert.match(queryInputs[0].digest as string, /^[0-9a-f]{64}$/);

    // Membership moves between preview and wake -> stale, no entry.
    const ob2Action = await submitAction(ownerA, "ownerA", "fixture_orderbook", { cityId: "cityA" });
    await previewAction(deps(fixtureRegistry), ob2Action, { now: nowIso() });
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "sim_cities/cityA/structures", "ob2"), { status: "built" });
    });
    await confirmStoredPreview(ob2Action);
    const staleSummary = await wake({ registry: fixtureRegistry });
    assert.ok(staleSummary.actionsStale.includes(ob2Action), "a moved result set is a stale preview");
    assert.equal((await entriesOf(ob2Action)).length, 0, "stale: no Log entry");
    assert.equal((await cityStats("cityA")).fixtureRestingOrders, 2, "state untouched by the stale action");
    await previewAndConfirm(ownerA, "ownerA", ob2Action, fixtureRegistry);
    const ob2Summary = await wake({ registry: fixtureRegistry });
    assert.ok(ob2Summary.actionsCommitted.includes(ob2Action));
    assert.equal((await cityStats("cityA")).fixtureRestingOrders, 1);
    assert.equal((await cityStats("cityA")).fixtureOrderBookRubars, 100);

    for (const id of ["ob1", "ob2", "ob3"]) {
      await adminDb.doc(`sim_cities/cityA/structures/${id}`).delete();
    }
    await verifyOk(fixtureRegistry);
  }
  console.log("ok S0-F01: read plan binds the full query set; citations cannot narrow a money read; membership change goes stale");

  // ---- S0-F07 (e2e): prepared payloads bound at preview, stored on
  // the action, committed verbatim; a swapped payload goes stale.
  {
    const previewWithPrepared = async (actionId: string, prepared: PreparedPayload) => {
      await previewAction(deps(fixtureRegistry), actionId, { now: nowIso(), prepared });
    };
    const confirmStored = async (actionId: string) => {
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
      return action;
    };

    // No payload: the judgment refuses — even though the member's own
    // action text begs for one (the handler never reads it).
    const treasuryJ0 = await treasury("cityA");
    const noPayload = await submitConfirmWake(ownerA, "ownerA", "fixture_judgment", { cityId: "cityA" });
    const noPayloadAction = await adminDoc(`sim_actions/${noPayload.actionId}`);
    assert.equal(noPayloadAction?.status, "rejected");
    assert.equal((noPayloadAction?.failure as Record<string, unknown>)?.code, "PREPARED_PAYLOAD_REQUIRED");
    assert.equal(await treasury("cityA"), treasuryJ0);

    // Payload A: preview binds it, the doc stores it, the commit uses
    // it, the manifest records it.
    const payloadA: PreparedPayload = { classification: { creditRubars: 1200 }, inputHash: "s0-judg-a" };
    const jA = await submitAction(ownerA, "ownerA", "fixture_judgment", { cityId: "cityA" });
    await previewWithPrepared(jA, payloadA);
    const storedA = await confirmStored(jA);
    assert.equal(storedA.preparedInputHash, "s0-judg-a", "payload hash stored on the action at preview time");
    assert.equal((storedA.preview as Record<string, unknown>).preparedInputHash, "s0-judg-a", "preview binds the payload");
    const wakeA = await wake({ registry: fixtureRegistry });
    assert.ok(wakeA.actionsCommitted.includes(jA));
    assert.equal(await treasury("cityA"), treasuryJ0 + 1200, "exactly payload A's credit landed");
    const manifestA = await adminDoc(`sim_resolutions/${jA}`);
    const recordedA = manifestA?.preparedPayload as Record<string, unknown>;
    assert.equal(recordedA?.inputHash, "s0-judg-a", "manifest stores the payload — replay needs no worker call");
    assert.equal((recordedA?.classification as Record<string, unknown>)?.creditRubars, 1200);

    // Swapped payload: previewed with A2, stored payload replaced by B2
    // before the wake -> the plan no longer matches the confirmed
    // preview -> stale, nothing lands. Re-preview with B2 commits B2.
    const payloadA2: PreparedPayload = { classification: { creditRubars: 700 }, inputHash: "s0-judg-a2" };
    const payloadB2: PreparedPayload = { classification: { creditRubars: 800 }, inputHash: "s0-judg-b2" };
    const jSwap = await submitAction(ownerA, "ownerA", "fixture_judgment", { cityId: "cityA" });
    await previewWithPrepared(jSwap, payloadA2);
    await confirmStored(jSwap);
    await env.withSecurityRulesDisabled(async (context) => {
      await updateDoc(doc(context.firestore(), "sim_actions", jSwap), {
        preparedPayload: { ...payloadB2 },
        preparedInputHash: payloadB2.inputHash,
      });
    });
    const treasurySwap0 = await treasury("cityA");
    const wakeSwap = await wake({ registry: fixtureRegistry });
    assert.ok(wakeSwap.actionsStale.includes(jSwap), "a swapped payload cannot commit under the confirmed preview");
    assert.equal(await treasury("cityA"), treasurySwap0, "nothing landed from the swapped payload");
    await previewWithPrepared(jSwap, payloadB2);
    await confirmStored(jSwap);
    const wakeB2 = await wake({ registry: fixtureRegistry });
    assert.ok(wakeB2.actionsCommitted.includes(jSwap));
    assert.equal(await treasury("cityA"), treasurySwap0 + 800, "re-previewed payload B2 commits exactly its own credit");
    await verifyOk(fixtureRegistry);
  }
  console.log("ok S0-F07: payload bound at preview, stored, committed verbatim, recorded in the manifest; swap goes stale");

  // ---- S0-ORDER: the wake-order lock (P4-K24 rider). A dependent
  // action and an undo of its target are queued for the SAME wake: the
  // actions phase must commit the dependent FIRST, and the ops phase
  // must then refuse the undo (the target is no longer a suffix). If
  // the phases ever swap back, the undo erases the target and this
  // section fails. The terminal snapshot refresh runs after both.
  {
    // Clamp derivation (fix round 3, PR #25): cityB's treasury entering
    // this section is 530, and fixture_adjust writes are absolute,
    // clamped writes (FIXTURE-ADJUST handler: after = clamp(before +
    // delta, 0, 1000)) — the +500/+5 below would saturate at the
    // ceiling (530 -> clamp(1030) = 1000 -> clamp(1005) = 1000), so a
    // naive base + 505 expectation is unreachable AND the saturated
    // value cannot discriminate "both stand" from "a1 alone stands".
    // De-saturate to the clamp floor first: from base 0 the sequence
    // resolves with no clamp interference (500, then 505 — both under
    // the ceiling), and the closing value discriminates all three
    // outcomes — both stand: 505; undo executed (a1 erased): 0 or 5;
    // dependent missing: 500. Same lesson as the CK6/CK7 fix rounds.
    let treasuryB0 = await treasury("cityB");
    if (treasuryB0 > 0) {
      await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
        cityId: "cityB",
        field: "stats.treasuryRubars",
        delta: -treasuryB0,
      }, { registry: fixtureRegistry });
      treasuryB0 = await treasury("cityB");
      assert.equal(treasuryB0, 0, "the de-saturating adjust lands exactly on the clamp floor");
    }
    const a1 = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 500,
    }, { registry: fixtureRegistry });
    const opId = await createUndoOp(ownerB, "ownerB", a1.actionId);
    const a2Id = await submitAction(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 5,
      citations: { resolutionIds: [a1.actionId] },
    });
    await previewAndConfirm(ownerB, "ownerB", a2Id, fixtureRegistry);
    const orderSummary = await wake({ registry: fixtureRegistry });
    assert.ok(orderSummary.actionsCommitted.includes(a2Id), "the dependent action commits in the shared wake");
    assert.equal(orderSummary.undoOpsProcessed, 1);
    assert.equal(
      (await readOp(opId))?.status,
      "refused",
      "the undo is refused BECAUSE the dependent landed first — actions before ops (brief §1.3, P4-K24)"
    );
    // treasuryB0 is 0 here (de-saturated above), so this is 505 with no
    // clamp step in between — see the derivation at the section top.
    assert.equal(await treasury("cityB"), treasuryB0 + 505, "both actions stand; nothing was erased");
    const snapshotDocNow = await adminDoc("sim_dashboard_snapshots/current");
    assert.equal(
      snapshotDocNow?.asOfSeq,
      await headSeq(),
      "the Phase 3 terminal snapshot refresh ran last in the wake, after actions and ops"
    );
    await verifyOk(fixtureRegistry);
  }
  console.log("ok S0-ORDER: wake order locked — actions commit, per-action scans, ops after; snapshot refresh terminal");

  // ======================================================================
  // Final: the whole standing world verifies under the fixture registry
  // (every citation in this scenario is a fixture citation), the draft
  // was never cited, and genesis still verifies under v1 (P2-G12).
  // ======================================================================
  {
    await verifyOk(fixtureRegistry);
    for (const entry of await allEntries()) {
      const baseline = entry.baseline as Record<string, unknown> | null;
      assert.ok(baseline === null || String(baseline.version).startsWith("baseline-fixture-"));
    }
    const genesisEntry = await adminDoc(`sim_log_entries/${logEntryDocId(1)}`);
    assert.equal(computeEntryHash(genesisEntry as Record<string, unknown>), genesisEntry?.entryHash);
    const worldNow = await adminDoc("sim_world/current");
    assert.equal(worldNow?.rulesVersion, "sim-rules-0.1.0-phase1", "genesis label never rewritten");
  }
  console.log("ok final standing-world verification (P2-G4/G6/G12)");

  await env.cleanup();
  assert.ok(true);
  console.log("sim core tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
