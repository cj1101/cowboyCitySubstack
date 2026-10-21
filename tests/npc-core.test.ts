/**
 * NPC core suite (Phase 5) — Osei's gate checks P5-G1..P5-G13 against
 * the Firestore + Auth emulators, per the gate countersign
 * (workstreams/qa-phase5-gate-countersign.md, COUNTERSIGNED WITH
 * ADDENDUM A-1–A-8). Per A-1 this suite runs inside the EXISTING
 * "Sim core tests (non-required)" CI job's emulators:exec segment,
 * chained at the end of `npm run test:sim` — no new job, no new
 * protection context. The sandbox emulator is a known defect (it
 * rejects its own rules upload), so this suite's venue is CI.
 *
 * The scenario is one continuous world (the sim-core/play-core
 * pattern): genesis + two fixture cities, then the Phase 5 train
 * exercised end-to-end through the dispatcher — NPC creation,
 * mandates, delegation rules, a rule fire executing a delegated
 * action, an ask-first fire spawning an envelope a worker completes,
 * owner-direct envelopes, the needsAttention conversion with its
 * trigger/silence postures, a revocation boundary, undos, the
 * novel-title NPC, and the §11.4 export builders over the standing
 * state the scenario produced.
 *
 * Venue division (countersign §1 + A-2): every row closes on CI
 * evidence in BUILT form. The pure batteries carry what they carry
 * (governance / situations / wake / banking harnesses); this suite
 * carries the emulator-venue legs named in the countersign's venue
 * column. A-7 / P5-D6: the deletion-inside-restore assertion stays
 * HELD OUT here exactly as in PR-1's rules matrix — P5-D6 is PENDING
 * Koda ratification; see the N9 section and the gate record.
 */

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  initializeTestEnvironment,
  type RulesTestContext,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore as getAdminFirestore, type Firestore as AdminFirestore } from "firebase-admin/firestore";
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
import { verifyStandingLog, type StandingWorld } from "../lib/sim/verify";
import { RULE_DESCRIPTORS } from "../lib/sim/rules/registry";
import { RESOLVER_RULES_VERSION } from "../lib/sim/state";
import { buildSituationDoc } from "../lib/sim/situations";
import { computeRuleHash } from "../lib/sim/delegation";
import { mandateHash as storedMandateHash } from "../lib/npcs";
import type { SimMandateVersion } from "../lib/npcs";
import { envelopeTaskId } from "../lib/envelopes";
import {
  delegatedActionId,
  wakeStepResolutionId,
  type EnvelopeWorkerOutcome,
} from "../lib/sim/wakeSteps";
import type { EnvelopeWorker } from "../lib/sim/wakePasses";
import type { TaskEnvelopeRecord } from "../lib/envelopes";
import {
  buildNpcRegisterWorkbook,
  buildSituationsWorkbook,
} from "../lib/export/datasets/phase5Workbook";
import type {
  NpcRegisterBundle,
  Phase5ExportContext,
  SituationsHistoryBundle,
} from "../lib/export/datasets/phase5Data";
import type { SimActor } from "../lib/sim/state";

const PROJECT_ID = "cowboycityrealm";

// ---------------------------------------------------------------------------
// Harness (the sim-core frame, extended for the Phase 5 collections)
// ---------------------------------------------------------------------------

const clockIso = "2026-10-18T00:00:00.000Z";
let wakeCounter = 0;
const nowIso = () => clockIso;

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
    throw new Error("npc-core suite requires FIRESTORE_EMULATOR_HOST — run via `npm run test:sim`");
  }
  const adminApp =
    getApps().length > 0 ? getApps()[0] : initializeApp({ projectId: PROJECT_ID }, "sim-phase5");
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
  await seedUser("adminD", { email: "d@realm.test", status: "approved", isAdmin: false });
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
    // The character records the NPCs link to (P5-K13: the NPC record
    // cites characterId; the character is a lore record, never an
    // authority).
    await setDoc(doc(fs, "characters", "charA1"), { name: "Petra Quill", factionId: "cityA" });
    await setDoc(doc(fs, "characters", "charA2"), { name: "Steffan Rook", factionId: "cityA" });
    await setDoc(doc(fs, "characters", "charA3"), { name: "Una Vail", factionId: "cityA" });
    await setDoc(doc(fs, "characters", "charB1"), { name: "Bram Holt", factionId: "cityB" });
  });

  const genesisResult = await runGenesis(adminDb, {});
  assert.equal(genesisResult.status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityA")).status, "created");
  assert.equal((await ensureSimCity(adminDb, "cityB")).status, "created");

  // Fixture initial conditions (seeded after genesis, rules-disabled
  // like the Phase 1 fixtures): treasuries, bands, a live connection.
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
  const committerFs = fabricCommitter.firestore() as unknown as import("firebase/firestore").Firestore;

  const deps = (): DispatcherDeps => ({
    fabricDb: committerFs,
    committerDb: committerFs,
    baselineRegistry: PRODUCTION_BASELINE_REGISTRY,
  });

  // The deterministic envelope worker (the fabric host's seam, played
  // by the suite — §4.2: the work is advisory, the outcome lands via
  // the terminal transaction). Records every claimed envelope so the
  // sections can assert the claim leg (status RUNNING at claim time).
  const claimedEnvelopes: { taskId: string; status: string; npcId: string }[] = [];
  const testWorker: EnvelopeWorker = async (envRec: TaskEnvelopeRecord) => {
    claimedEnvelopes.push({
      taskId: envRec.taskId,
      status: envRec.status,
      npcId: envRec.npcId,
    });
    const outcome: EnvelopeWorkerOutcome = {
      outcome: "DONE",
      outputText: `Draft prepared for task ${envRec.taskId}: ${envRec.task}`,
      summary: "Deterministic gate-fixture draft.",
      proposedTerms: { draftOnly: true },
    };
    return outcome;
  };

  async function wake(extra?: { worker?: boolean }): Promise<WakeSummary> {
    wakeCounter += 1;
    return runWake(deps(), {
      now: nowIso(),
      cycleId: `cycle-${wakeCounter}`,
      ...(extra?.worker ? { envelopeWorker: testWorker } : {}),
    });
  }

  const adminDoc = async (path: string) => {
    const snap = await adminDb.doc(path).get();
    return snap.exists ? (snap.data() as Record<string, unknown>) : null;
  };
  const headSeq = async () =>
    ((await adminDoc("sim_counters/log")) as Record<string, unknown>).lastSeq as number;
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
  const situationsWhere = async (field: string, value: unknown) => {
    const snap = await adminDb
      .collection("sim_situations")
      .where(field, "==", value)
      .get();
    return snap.docs.map((d) => d.data() as Record<string, unknown>);
  };

  async function assembleWorld(): Promise<StandingWorld> {
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
    await addCollection("sim_situations");
    // Phase 5 collections (the standing-state venue sim-core's
    // assembleWorld comment names: this suite).
    await addCollection("sim_npcs");
    await addCollection("sim_teams");
    const mandateIds = await addCollection("sim_mandates");
    for (const id of mandateIds) await addCollection(`sim_mandates/${id}/versions`);
    const ruleIds = await addCollection("sim_delegation_rules");
    for (const id of ruleIds) await addCollection(`sim_delegation_rules/${id}/versions`);
    await addCollection("sim_task_envelopes");
    await addCollection("sim_task_outputs");
    return {
      entries,
      manifests,
      counter: (await adminDoc("sim_counters/log")) as Record<string, unknown>,
      world: (await adminDoc("sim_world/current")) as Record<string, unknown>,
      stateDocs,
      baselineRegistry: PRODUCTION_BASELINE_REGISTRY,
    };
  }
  const verifyOk = async () => {
    const world = await assembleWorld();
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

  async function previewAndConfirm(ctx: RulesTestContext, uid: string, actionId: string) {
    await previewAction(deps(), actionId, { now: nowIso() });
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
    opts?: { actionText?: string | null; targetCityIds?: string[]; worker?: boolean }
  ): Promise<{ actionId: string; summary: WakeSummary }> {
    const actionId = await submitAction(ctx, uid, actionType, structuredAction, opts);
    await previewAndConfirm(ctx, uid, actionId);
    const summary = await wake({ worker: opts?.worker });
    return { actionId, summary };
  }

  const actionStatus = async (actionId: string) =>
    (await adminDoc(`sim_actions/${actionId}`))?.status as string;
  const actionFailureCode = async (actionId: string) =>
    ((await adminDoc(`sim_actions/${actionId}`))?.failure as Record<string, unknown> | null)
      ?.code as string;

  // ======================================================================
  // N0 — genesis + the Phase 5 census (P5-G13's registry leg; the
  // resolver stamp F-S3 resolved at PR-2).
  // ======================================================================
  {
    assert.equal(await headSeq(), 1);
    assert.equal(
      Object.keys(RULE_DESCRIPTORS).length,
      79,
      "registry census: 79 descriptors on master (65 Phase 4 + 5 governance + 9 banking)"
    );
    assert.equal(RESOLVER_RULES_VERSION, "sim-rules-0.5.0-phase5");
    await verifyOk();
  }
  console.log("ok N0 genesis + census 79 + rules stamp sim-rules-0.5.0-phase5");

  // ======================================================================
  // N1 — NPC creation through the dispatcher (P5-G3 substrate half,
  // P5-G4 roster half, P5-G5's A-4 literal): create + activation +
  // roster in ONE resolution; a fresh NPC's default mode is the
  // adopted literal `ask-first`; a non-owner create is refused.
  // ======================================================================
  {
    const envoy = await submitConfirmWake(ownerA, "ownerA", "npc.create", {
      characterId: "charA1",
      cityId: "cityA",
      displayNameSnapshot: "Petra Quill",
      titleFreeform: "Envoy of the Harbor Bell",
      roleTemplate: null,
      personality: { traits: ["patient", "precise"], voiceNotes: null, characterNotes: null },
      scopeFreeform: "Carry the city's questions; draft, never bind.",
      // NOTE: no permissionMode — the A-4 default is what is asserted.
    });
    assert.equal(await actionStatus(envoy.actionId), "resolved");
    const envoyDoc = await adminDoc("sim_npcs/charA1");
    assert.ok(envoyDoc, "the NPC record stands");
    assert.equal(envoyDoc.status, "active", "create + activation land in one resolution");
    assert.equal(
      envoyDoc.permissionMode,
      "ask-first",
      "A-4: a fresh NPC's default mode is the adopted literal ask-first (P5-K3)"
    );
    assert.equal(envoyDoc.currentMandateId, null);
    assert.equal(envoyDoc.currentMandateVersion, null);
    assert.equal(envoyDoc.characterId, "charA1", "P5-K13: the character link stands on the record");
    assert.equal(envoyDoc.ownerUid, "ownerA");
    assert.equal(envoyDoc.cityId, "cityA");

    const steward = await submitConfirmWake(ownerA, "ownerA", "npc.create", {
      characterId: "charA2",
      cityId: "cityA",
      displayNameSnapshot: "Steffan Rook",
      titleFreeform: "Harbor Steward",
      roleTemplate: null,
      personality: { traits: ["decisive"], voiceNotes: null, characterNotes: null },
      scopeFreeform: "Run routine harbor funds under mandate.",
      permissionMode: "act-for-me",
    });
    assert.equal(await actionStatus(steward.actionId), "resolved");
    assert.equal((await adminDoc("sim_npcs/charA2"))?.permissionMode, "act-for-me");

    const keeper = await submitConfirmWake(ownerB, "ownerB", "npc.create", {
      characterId: "charB1",
      cityId: "cityB",
      displayNameSnapshot: "Bram Holt",
      titleFreeform: "Night Keeper",
      roleTemplate: null,
      personality: { traits: ["quiet"], voiceNotes: null, characterNotes: null },
      scopeFreeform: "Watch the night stores; say nothing unbidden.",
      permissionMode: "silent",
    });
    assert.equal(await actionStatus(keeper.actionId), "resolved");
    assert.equal((await adminDoc("sim_npcs/charB1"))?.permissionMode, "silent");

    const teamA = await adminDoc("sim_teams/cityA");
    assert.deepEqual(
      (teamA?.npcIds as string[]).slice().sort(),
      ["charA1", "charA2"],
      "the roster write rides the creation resolutions"
    );
    const teamB = await adminDoc("sim_teams/cityB");
    assert.deepEqual(teamB?.npcIds, ["charB1"]);

    // A non-owner cannot create an NPC in someone else's city.
    const foreign = await submitConfirmWake(memberC, "memberC", "npc.create", {
      characterId: "charA3",
      cityId: "cityA",
      displayNameSnapshot: "Una Vail",
      titleFreeform: "Keeper of the Third Bell",
      roleTemplate: null,
      personality: { traits: ["solemn"], voiceNotes: null, characterNotes: null },
      scopeFreeform: "Tend the harbor bell.",
    });
    assert.equal(await actionStatus(foreign.actionId), "rejected");
    assert.ok(await actionFailureCode(foreign.actionId), "the refusal names its code");
    assert.equal((await entriesOf(foreign.actionId)).length, 1, "exactly one rejected entry");
    assert.equal((await entriesOf(foreign.actionId))[0].kind, "rejected");
    assert.equal(await adminDoc("sim_npcs/charA3"), null, "no record stands for the refused create");
    await verifyOk();
  }
  console.log("ok N1 npc.create x3 (A-4 ask-first default on the standing doc) + roster + non-owner refusal");

  // ======================================================================
  // N2 — Mandates (P5-G4): mandate.set stamps root + version + the
  // NPC snapshot in ONE resolution; the standing version's mandateHash
  // recomputes from its own fields under the STORED regime (lib/npcs
  // mandateHash — the recompute the authority stage and the
  // standing-Log verifier perform over snapshot docs; the
  // countersign's in-suite hash equality); a Tier B allowedActionType
  // is refused at authoring.
  // ======================================================================
  const MANDATE_CAPS = {
    perActionRubars: 100_000,
    perResolutionPeriodRubars: 1_000_000,
    periodDefinition: null,
    maxProjectPhase: null,
    allowPartialExecution: false,
  };
  {
    const setSteward = await submitConfirmWake(ownerA, "ownerA", "mandate.set", {
      mandateId: "mand-steward-1",
      npcId: "charA2",
      cityId: "cityA",
      permissionMode: "act-for-me",
      scopeFreeform: "Run routine harbor funds when a situation calls.",
      structuredScope: {
        triggerKinds: ["situation"],
        allowedActionTypes: ["fixture_adjust"],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: MANDATE_CAPS,
    });
    assert.equal(await actionStatus(setSteward.actionId), "resolved");
    const root = await adminDoc("sim_mandates/mand-steward-1");
    assert.equal(root?.status, "active");
    assert.equal(root?.currentVersion, 1);
    const version = await adminDoc("sim_mandates/mand-steward-1/versions/1");
    assert.ok(version, "the version doc stands");
    assert.equal(version.effectiveSeq, (await entriesOf(setSteward.actionId))[0]?.seq ?? version.effectiveSeq);
    assert.ok(
      typeof version.mandateHash === "string" && (version.mandateHash as string).length === 64,
      "the version carries its mandateHash"
    );
    // The hash regime of a STANDING doc is the stored regime: lib/npcs
    // mandateHash over MANDATE_HASH_FIELDS, recomputed over the doc as
    // read — exactly the integrity check the authority stage
    // (lib/sim/authorityStage.ts) and the standing-Log verifier
    // (lib/sim/verify.ts) run. The authority dialect's
    // computeMandateHash must never be applied to a stored doc: it
    // hashes the stage's PROJECTION (mandateId/mode/scope/
    // createdByUid), fields the stored shape does not carry (it
    // carries permissionMode/scopeFreeform/structuredScope/caps/
    // ownerUid and no mandateId), so over a raw doc it digests a
    // near-empty payload — PR #45 CI round 1 failed on exactly that:
    // the "recomputed" digest fbb085a3… is the canonical hash of
    // {version, expiresAtSeq, horizonActions} alone, identical for
    // every mandate (proven in the fix round's pure probe).
    assert.equal(
      storedMandateHash(version as unknown as SimMandateVersion),
      version.mandateHash,
      "mandateHash equality: the standing version recomputes to its own hash (P5-G2's in-suite half)"
    );
    const stewardDoc = await adminDoc("sim_npcs/charA2");
    assert.equal(stewardDoc?.currentMandateId, "mand-steward-1", "the NPC snapshot moved in the same resolution");
    assert.equal(stewardDoc?.currentMandateVersion, 1);

    const setEnvoy = await submitConfirmWake(ownerA, "ownerA", "mandate.set", {
      mandateId: "mand-envoy-1",
      npcId: "charA1",
      cityId: "cityA",
      permissionMode: "ask-first",
      scopeFreeform: "Draft answers to the city's questions; bind nothing.",
      structuredScope: {
        triggerKinds: ["situation"],
        allowedActionTypes: ["fixture_adjust"],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: { ...MANDATE_CAPS, perActionRubars: 50_000 },
    });
    assert.equal(await actionStatus(setEnvoy.actionId), "resolved");
    assert.equal((await adminDoc("sim_npcs/charA1"))?.currentMandateId, "mand-envoy-1");

    const setKeeper = await submitConfirmWake(ownerB, "ownerB", "mandate.set", {
      mandateId: "mand-keeper-1",
      npcId: "charB1",
      cityId: "cityB",
      permissionMode: "silent",
      scopeFreeform: "Hold the night watch in silence.",
      structuredScope: {
        triggerKinds: ["situation"],
        allowedActionTypes: [],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: {
        perActionRubars: null,
        perResolutionPeriodRubars: null,
        periodDefinition: null,
        maxProjectPhase: null,
        allowPartialExecution: false,
      },
    });
    assert.equal(await actionStatus(setKeeper.actionId), "resolved");

    // Tier B at authoring: a mandate may never authorize a
    // binding-by-nature act, whatever its text says (§5.4).
    const tierB = await submitConfirmWake(ownerA, "ownerA", "mandate.set", {
      mandateId: "mand-tierb-1",
      npcId: "charA2",
      cityId: "cityA",
      permissionMode: "act-for-me",
      scopeFreeform: "Demolish things.",
      structuredScope: {
        triggerKinds: ["situation"],
        allowedActionTypes: ["demolish_structure"],
        namedRecordIds: [],
        counterpartyCityIds: null,
      },
      caps: MANDATE_CAPS,
    });
    assert.equal(await actionStatus(tierB.actionId), "rejected");
    assert.equal(await actionFailureCode(tierB.actionId), "MANDATE_AUTHORIZES_TIER_B");
    assert.equal(await adminDoc("sim_mandates/mand-tierb-1"), null, "no root stands for the refused mandate");
    await verifyOk();
  }
  console.log("ok N2 mandate.set x3 (root+version+snapshot in one resolution, hash recomputes) + Tier B authoring refusal");

  // ======================================================================
  // N3 — Delegation rules (P5-G7 substrate half): delegationRule.set
  // writes root + version; the standing ruleHash equals the module's
  // computeRuleHash over the same field set (the parity PR-3 confirmed
  // against Vera's vectors, here in the emulator venue).
  // ======================================================================
  const RULE_MATCH_BASE = {
    sourceKinds: [] as string[],
    cityIds: null,
    counterpartyCityIds: null,
    minRubars: null,
    maxRubars: null,
    tags: [] as string[],
  };
  {
    const fireRule = {
      ruleId: "rule-fire-1",
      cityId: "cityA",
      priority: 1,
      match: { ...RULE_MATCH_BASE, situationKinds: ["proposal"] },
      handler: { npcId: "charA2", mode: "act-for-me" as const, mandateId: null },
      caps: {},
      alwaysWait: false,
    };
    const setFire = await submitConfirmWake(ownerA, "ownerA", "delegationRule.set", fireRule);
    assert.equal(await actionStatus(setFire.actionId), "resolved");
    const root = await adminDoc("sim_delegation_rules/rule-fire-1");
    assert.equal(root?.status, "active");
    assert.equal(root?.version, 1);
    assert.equal(
      root?.ruleHash,
      computeRuleHash({
        ruleId: "rule-fire-1",
        ownerUid: "ownerA",
        cityId: "cityA",
        version: 1,
        priority: 1,
        match: fireRule.match,
        handler: fireRule.handler,
        caps: {},
        alwaysWait: false,
        enabled: true,
      }),
      "ruleHash parity on the standing root"
    );
    const ruleVersion = await adminDoc("sim_delegation_rules/rule-fire-1/versions/1");
    assert.equal(ruleVersion?.ruleHash, root?.ruleHash, "root and version carry the same hash");

    const askRule = {
      ruleId: "rule-ask-1",
      cityId: "cityA",
      priority: 2,
      match: { ...RULE_MATCH_BASE, situationKinds: ["question"] },
      handler: { npcId: "charA1", mode: "ask-first" as const, mandateId: null },
      caps: {},
      alwaysWait: false,
    };
    const setAsk = await submitConfirmWake(ownerA, "ownerA", "delegationRule.set", askRule);
    assert.equal(await actionStatus(setAsk.actionId), "resolved");
    assert.equal((await adminDoc("sim_delegation_rules/rule-ask-1"))?.status, "active");
    await verifyOk();
  }
  console.log("ok N3 delegationRule.set x2 (root+version, ruleHash parity in the emulator venue)");

  // ======================================================================
  // DIAG (PR #45 fix round 4 — TEMPORARY, remove with the fix): THE
  // FULL QUERY CENSUS. Round 3's seed-query hypothesis is REFUTED: its
  // Q1 (sim_delegation_rules where cityId==cityA as fabricSvc) returned
  // ALLOWED (size 2), controls Q2/Q3/Q4 ALLOWED, and the suite still
  // died in N4's touch + wake on the uncaught "No matching allow
  // statements". So the failing operation is another member of the
  // wake's operation set. This block replicates EVERY query the
  // touch + wake cycle performs (dispatcher, scan, passes, and the
  // failure-isolated snapshot refresh), plus the materialization GET
  // set no query probe can see, standalone, as the SAME identity the
  // wake uses (committerFs — the fabricSvc committer context deps()
  // hands to both fabricDb and committerDb), against the standing
  // world right before N4's wake. Probes catch and log; the suite
  // proceeds to the real failure either way. Companion bisection:
  // DIAG STEP labels inside lib/sim/{resolver,dispatcher,wakePasses}.ts
  // name the failing operation in situ if the census all-alloweds.
  // ======================================================================
  {
    const probeQuery = async (label: string, run: () => Promise<{ size: number }>) => {
      try {
        const result = await run();
        console.log(`DIAG Q-${label}: ALLOWED (size ${result.size})`);
      } catch (error) {
        console.log(
          `DIAG Q-${label}: DENIED (${(error as { code?: string }).code ?? "?"}) ${(error as Error).message}`
        );
      }
    };
    const probeGet = async (label: string, run: () => Promise<{ exists: () => boolean }>) => {
      try {
        const snap = await run();
        console.log(`DIAG Q-${label}: ALLOWED (exists ${snap.exists()})`);
      } catch (error) {
        console.log(
          `DIAG Q-${label}: DENIED (${(error as { code?: string }).code ?? "?"}) ${(error as Error).message}`
        );
      }
    };
    const C = (name: string) => collection(committerFs, name);

    // -- The dispatcher's own queries (runWake, in wake order) --------
    await probeQuery("actions-status-confirmed", () =>
      getDocs(query(C("sim_actions"), where("status", "==", "confirmed"), orderBy("createdAt", "asc"), limit(10)))
    );
    await probeQuery("undo_operations-status-in", () =>
      getDocs(
        query(
          C("sim_undo_operations"),
          where("status", "in", ["requested", "checking"]),
          orderBy("createdAt", "asc"),
          limit(10)
        )
      )
    );
    // -- The ripeness scan's candidate queries (scanRipeness) ---------
    await probeQuery("pending_consequences-status-pending", () =>
      getDocs(
        query(
          C("sim_pending_consequences"),
          where("status", "==", "pending"),
          orderBy("createdAtSeq", "asc"),
          orderBy("pendingId", "asc"),
          limit(25)
        )
      )
    );
    await probeQuery("pending_consequences-status-ripening-claimed", () =>
      getDocs(query(C("sim_pending_consequences"), where("status", "==", "ripening-claimed"), limit(25)))
    );
    // -- The wake passes' direct queries (runWakePasses) --------------
    await probeQuery("pending_consequences-needsAttention", () =>
      getDocs(query(C("sim_pending_consequences"), where("needsAttention", "==", true), limit(25)))
    );
    await probeQuery("task_envelopes-status-QUEUED", () =>
      getDocs(query(C("sim_task_envelopes"), where("status", "==", "QUEUED"), limit(50)))
    );
    await probeQuery("task_envelopes-status-RUNNING", () =>
      getDocs(query(C("sim_task_envelopes"), where("status", "==", "RUNNING"), limit(50)))
    );
    // -- Read-plan queries materialized inside snapshots --------------
    // The delegation/silence step seed query (WAKE_RULES_QUERY_ID) —
    // round 3's Q1, folded in.
    await probeQuery("delegation_rules-cityId", () =>
      getDocs(query(C("sim_delegation_rules"), where("cityId", "==", "cityA")))
    );
    // The NPC authority stage's period-usage query (NPC_PERIOD_QUERY_ID)
    // — declared for EVERY npc-actor action's read plan; the N4
    // delegated action is the first npc-actor materialization in this
    // venue. The filter field (actor.mandateId) is NOT the field the
    // collection's member read branch keys on (actor.memberId).
    await probeQuery("log_entries-actor.mandateId", () =>
      getDocs(query(C("sim_log_entries"), where("actor.mandateId", "==", "mand-steward-1")))
    );
    // -- The snapshot refresh's queries (failure-isolated by design: --
    // -- refreshSnapshotAfterWake never throws; censused for completeness)
    await probeQuery("log_entries-recent", () =>
      getDocs(query(C("sim_log_entries"), orderBy("seq", "desc"), limit(30)))
    );
    await probeQuery("log_entries-headline-cityA", () =>
      getDocs(
        query(
          C("sim_log_entries"),
          where("cityIds", "array-contains", "cityA"),
          where("visibility", "==", "public"),
          orderBy("seq", "desc"),
          limit(1)
        )
      )
    );
    await probeQuery("factions-scan", () => getDocs(C("factions")));
    await probeQuery("sim_cities-scan", () => getDocs(C("sim_cities")));

    // -- The materialization GET set (doc reads the funnel performs) --
    await probeGet("world-get-current", () => getDoc(doc(committerFs, "sim_world", "current")));
    await probeGet("counters-get-log", () => getDoc(doc(committerFs, "sim_counters", "log")));
    await probeGet("factions-get-cityA", () => getDoc(doc(committerFs, "factions", "cityA")));
    await probeGet("sim_cities-get-cityA", () => getDoc(doc(committerFs, "sim_cities", "cityA")));
    await probeGet("npcs-get-charA2", () => getDoc(doc(committerFs, "sim_npcs", "charA2")));
    await probeGet("teams-get-cityA", () => getDoc(doc(committerFs, "sim_teams", "cityA")));
    await probeGet("mandates-get-mand-steward-1", () =>
      getDoc(doc(committerFs, "sim_mandates", "mand-steward-1"))
    );
    await probeGet("mandates-get-mand-steward-1-v1", () =>
      getDoc(doc(committerFs, "sim_mandates", "mand-steward-1", "versions", "1"))
    );
    // The authority stage's terms read (TERMS_PATH): firestore.rules
    // carries NO match block for sim_terms at all — there is no allow
    // statement any identity can match. First read in this venue by
    // the first npc-actor action (the N4 delegated action).
    await probeGet("terms-get-current", () => getDoc(doc(committerFs, "sim_terms", "current")));
    // Posture probes over absent docs (the paths the funnel forms for
    // records that do not stand yet — an absent doc still needs a
    // matching allow statement).
    await probeGet("situations-get-absent", () =>
      getDoc(doc(committerFs, "sim_situations", "diag-absent"))
    );
    await probeGet("actions-get-absent", () => getDoc(doc(committerFs, "sim_actions", "diag-absent")));
    await probeGet("resolutions-get-absent", () =>
      getDoc(doc(committerFs, "sim_resolutions", "diag-absent"))
    );
  }

  // ======================================================================
  // N4 — The rule fire (P5-G1's trigger leg, P5-G2, P5-G7): a proposal
  // card carrying a delegated action spec is touched by its owner's
  // own situation.handle; the same wake's delegation pass fires
  // rule-fire-1, the delegated action executes under the steward's
  // mandate (NPC-attributed entries), and the follow-up completes the
  // card. The fixture card is seeded with the module's own builder —
  // an initial condition, like sim-core's seeded treasuries; every
  // transition after the seed is the engine's.
  // ======================================================================
  let fireSituationId = "";
  let fireActionId = "";
  {
    const card = buildSituationDoc({
      cityId: "cityA",
      audienceCityId: "cityA",
      audienceOwnerUidsSnapshot: ["ownerA"],
      recipientUid: null,
      kind: "proposal",
      severity: "routine",
      title: "Proposal: adjust the harbor treasury by 5,000 R",
      summary:
        "A proposal card carrying a delegated action spec (fixture_adjust +5000 on cityA's treasury), seeded as an initial condition for the gate scenario.",
      detail: {
        delegatedAction: {
          actionType: "fixture_adjust",
          structuredAction: {
            cityId: "cityA",
            field: "stats.treasuryRubars",
            delta: 5000,
          },
          targetCityIds: ["cityA"],
        },
      },
      source: { kind: "manual-action", sourceId: "npc-core-fire-1", sourceSeq: null, sourceResolutionId: null },
      createdSeq: await headSeq(),
      now: nowIso(),
    });
    fireSituationId = card.situationId;
    console.log("DIAG N4 stage: seeding the fixture card (Admin SDK)");
    await adminDb.doc(`sim_situations/${fireSituationId}`).set(card);
    console.log("DIAG N4 stage: card seeded; submitting the owner's touch + wake");

    const treasuryBefore = await treasury("cityA");
    const cycle = wakeCounter + 1;
    fireActionId = delegatedActionId({
      situationId: fireSituationId,
      via: "rule-fire-1",
      npcId: "charA2",
      cycleId: `cycle-${cycle}`,
    });
    // Production submission form (SituationCard -> lib/situations/
    // client submitSituationHandle): a situation decision carries the
    // card's city (audienceCityId ?? cityId) in targetCityIds. That
    // is what puts the LIVE faction doc among the resolver's base-path
    // seeds — the §9.6 audience gate reads current owners from it,
    // and the situation doc itself only enters the read plan via the
    // descriptor hook, so it can never seed its own faction. A
    // city-less submission lawfully refuses AUTHORITY_REVOKED (the
    // gate-record PR #45 fix round 2 probe: the plan then contains
    // no factions/ path at all). Every situation.handle submission
    // in this suite uses this form.
    const fireCityId = card.audienceCityId ?? card.cityId;
    const touch = await submitConfirmWake(
      ownerA,
      "ownerA",
      "situation.handle",
      {
        situationId: fireSituationId,
        decisionNote: "Take it in hand — and let the standing rule do its work.",
      },
      { targetCityIds: fireCityId ? [fireCityId] : [] }
    );
    console.log("DIAG N4 stage: touch + wake returned");
    assert.equal(await actionStatus(touch.actionId), "resolved");
    const passes = touch.summary.passes;
    assert.ok(passes, "the wake ran its passes");
    assert.ok(
      passes.delegation.fired.some((f) => f.situationId === fireSituationId && f.kind === "delegated-action"),
      "rule-fire-1 fired as a delegated action"
    );
    assert.ok(
      passes.delegatedActions.some((d) => d.actionId === fireActionId && d.outcome === "resolved"),
      "the delegated action resolved in the same wake"
    );
    assert.ok(
      passes.followups.some(
        (f) => f.situationId === fireSituationId && f.actionId === fireActionId && f.outcome === "committed"
      ),
      "the follow-up completed the card in the same wake"
    );

    const cardAfter = await adminDoc(`sim_situations/${fireSituationId}`);
    assert.equal(cardAfter?.status, "handled");
    const handling = cardAfter?.handling as Record<string, unknown>;
    assert.equal(handling.mode, "auto-delegated");
    assert.equal(handling.delegationRuleId, "rule-fire-1");
    assert.equal(handling.delegationRuleVersion, 1);
    assert.equal(handling.npcId, "charA2");
    assert.equal(handling.actionId, fireActionId);
    assert.equal(
      cardAfter?.resolvedSeq,
      (await adminDoc(`sim_actions/${fireActionId}`))?.lastLogSeq,
      "the card's resolvedSeq is the delegated action's last seq"
    );
    assert.equal(await treasury("cityA"), treasuryBefore + 5000, "the delegated act landed exactly once");

    const delegatedAction = await adminDoc(`sim_actions/${fireActionId}`);
    assert.equal(delegatedAction?.status, "resolved");
    assert.equal((delegatedAction?.actor as Record<string, unknown>)?.type, "npc");
    assert.equal((delegatedAction?.actor as Record<string, unknown>)?.npcId, "charA2");

    const entries = await allEntries();
    const fireEntry = entries.find(
      (e) => (e.classification as Record<string, unknown>)?.delegationFire === true
    );
    assert.ok(fireEntry, "the fire entry stands in the Log");
    const fireClass = fireEntry.classification as Record<string, unknown>;
    assert.equal(fireClass.delegationRuleId, "rule-fire-1", "the fire entry cites the rule");
    assert.equal(fireClass.delegationRuleVersion, 1, "… and its version");
    assert.equal(fireClass.fireKind, "delegated-action");
    assert.equal((fireEntry.actor as Record<string, unknown>)?.type, "npc");
    assert.equal((fireEntry.actor as Record<string, unknown>)?.mandateId, "mand-steward-1");

    // P5-G2 in-suite: every NPC-attributed entry in the world so far
    // traces to a standing NPC whose creator owns its city, citing the
    // mandate version in force — and the standing verifier (below)
    // walks the same entries with its three-way traceability.
    const npcEntries = entries.filter(
      (e) => (e.actor as Record<string, unknown>)?.type === "npc"
    );
    assert.ok(npcEntries.length >= 2, "the fire produced NPC-attributed entries (fire + delegated action)");
    for (const entry of npcEntries) {
      const actor = entry.actor as Record<string, unknown>;
      const npc = await adminDoc(`sim_npcs/${actor.npcId as string}`);
      assert.ok(npc, `entry seq ${entry.seq}: the cited NPC stands`);
      assert.equal(npc.status, "active");
      if (actor.mandateId) {
        const version = await adminDoc(
          `sim_mandates/${actor.mandateId as string}/versions/${actor.mandateVersion as number}`
        );
        assert.ok(version, `entry seq ${entry.seq}: the cited mandate version stands`);
      }
    }
    await verifyOk();
  }
  console.log("ok N4 rule fire -> delegated action under mandate (NPC entries traced) -> card handled; verifier clean");

  // ======================================================================
  // N5 — Ask-first fire (P5-G7) + envelope completion (P5-G6): a
  // question card fires rule-ask-1 as an ENVELOPE (an ask-first handler
  // never auto-executes); the claim pass claims it in the same wake,
  // the worker's draft lands as exactly one output record, and the
  // card rests at awaiting_owner — the draft binds nothing.
  // ======================================================================
  let askSituationId = "";
  let askTaskId = "";
  {
    const card = buildSituationDoc({
      cityId: "cityA",
      audienceCityId: "cityA",
      audienceOwnerUidsSnapshot: ["ownerA"],
      recipientUid: null,
      kind: "question",
      severity: "routine",
      title: "Question: what should the harbor watch rotation be?",
      summary:
        "A question card with no delegated action spec, seeded as an initial condition; the ask-first rule answers it with a drafted envelope task.",
      detail: {},
      source: { kind: "manual-action", sourceId: "npc-core-ask-1", sourceSeq: null, sourceResolutionId: null },
      createdSeq: await headSeq(),
      now: nowIso(),
    });
    askSituationId = card.situationId;
    await adminDb.doc(`sim_situations/${askSituationId}`).set(card);

    const cycle = wakeCounter + 1;
    const stepResolutionId = wakeStepResolutionId(
      { kind: "delegation", situationId: askSituationId },
      `cycle-${cycle}`
    );
    askTaskId = envelopeTaskId("ownerA", stepResolutionId);
    const treasuryBefore = await treasury("cityA");
    const askCityId = card.audienceCityId ?? card.cityId;
    const touch = await submitConfirmWake(
      ownerA,
      "ownerA",
      "situation.handle",
      { situationId: askSituationId, decisionNote: "In hand." },
      { worker: true, targetCityIds: askCityId ? [askCityId] : [] }
    );
    assert.equal(await actionStatus(touch.actionId), "resolved");
    const passes = touch.summary.passes;
    assert.ok(passes);
    assert.ok(
      passes.delegation.fired.some((f) => f.situationId === askSituationId && f.kind === "envelope"),
      "the ask-first rule fired as an envelope, not an execution"
    );
    assert.ok(
      passes.claims.completed.some((c) => c.taskId === askTaskId && c.outcome === "DONE"),
      "the claim pass completed the envelope in the same wake"
    );
    const claim = claimedEnvelopes.find((c) => c.taskId === askTaskId);
    assert.ok(claim, "the worker saw the claim");
    assert.equal(claim.status, "RUNNING", "the claim leg: the envelope stood RUNNING at claim time");
    assert.equal(claim.npcId, "charA1");

    const envelope = await adminDoc(`sim_task_envelopes/${askTaskId}`);
    assert.equal(envelope?.status, "DONE");
    const outputs = await adminDb.collection("sim_task_outputs").where("taskId", "==", askTaskId).get();
    assert.equal(outputs.size, 1, "exactly one output record stands");
    assert.equal(outputs.docs[0].data().outcome, "DONE");

    const cardAfter = await adminDoc(`sim_situations/${askSituationId}`);
    assert.equal(cardAfter?.status, "awaiting_owner", "the draft rests with the owner (ask-first)");
    assert.equal((cardAfter?.handling as Record<string, unknown>)?.taskId, askTaskId);
    assert.equal(await treasury("cityA"), treasuryBefore, "a draft moves no state");

    const outcomeEntry = (await allEntries()).find(
      (e) =>
        (e.classification as Record<string, unknown>)?.source === "envelope" &&
        (e.classification as Record<string, unknown>)?.envelopeId === askTaskId
    );
    assert.ok(outcomeEntry, "the envelope outcome entry stands");
    assert.equal((outcomeEntry.actor as Record<string, unknown>)?.type, "npc");
    assert.equal((outcomeEntry.actor as Record<string, unknown>)?.npcId, "charA1");
    await verifyOk();
  }
  console.log("ok N5 ask-first fire -> envelope -> claim (RUNNING) -> exactly one output; card awaiting_owner; no state moved");

  // ======================================================================
  // N6 — Owner-direct envelopes (P5-G6): spawn stands QUEUED; with no
  // worker in the wake the claim pass defers (it never claims without
  // an execution seam); a duplicate spawn refuses; cancel-before-claim
  // is terminal-without-output (F-E8). Then P5-K4: an owner may task
  // their own SILENT NPC directly — the instruction is the permission;
  // the output is advisory and binds nothing.
  // ======================================================================
  {
    const spawn = await submitConfirmWake(ownerA, "ownerA", "envelope.spawn", {
      npcId: "charA2",
      cityId: "cityA",
      taskType: "one-off",
      task: "Draft the harbor report.",
      clientRequestId: "npc-core-g6a",
      bounds: { counterpartyCityIds: [] },
    });
    assert.equal(await actionStatus(spawn.actionId), "resolved");
    const taskId = envelopeTaskId("ownerA", "npc-core-g6a");
    const envelope = await adminDoc(`sim_task_envelopes/${taskId}`);
    assert.equal(envelope?.status, "QUEUED");
    assert.equal(envelope?.requestingMemberId, "ownerA", "F-S1 field name on the standing doc");
    assert.equal(
      spawn.summary.passes?.claims.deferredNoWorker,
      1,
      "no worker in the wake: the claim pass defers, claiming nothing"
    );

    const duplicate = await submitConfirmWake(ownerA, "ownerA", "envelope.spawn", {
      npcId: "charA2",
      cityId: "cityA",
      taskType: "one-off",
      task: "Draft the harbor report.",
      clientRequestId: "npc-core-g6a",
      bounds: { counterpartyCityIds: [] },
    });
    assert.equal(await actionStatus(duplicate.actionId), "rejected");
    assert.equal(await actionFailureCode(duplicate.actionId), "ENVELOPE_ALREADY_EXISTS");

    const cancel = await submitConfirmWake(ownerA, "ownerA", "envelope.cancel", { taskId });
    assert.equal(await actionStatus(cancel.actionId), "resolved");
    const cancelled = await adminDoc(`sim_task_envelopes/${taskId}`);
    assert.equal(cancelled?.status, "FAILED");
    assert.equal(
      (cancelled?.lastError as Record<string, unknown>)?.code,
      "cancelled_before_claim",
      "F-E8: cancelled-before-claim is terminal-without-output"
    );
    assert.equal(cancelled?.outputId, null);

    // A later worker wake does not resurrect it.
    const drive = await submitConfirmWake(
      ownerB,
      "ownerB",
      "fixture_adjust",
      { cityId: "cityB", field: "stats.treasuryRubars", delta: 1 },
      { worker: true }
    );
    assert.ok(
      !drive.summary.passes?.claims.completed.some((c) => c.taskId === taskId),
      "the cancelled envelope never completes"
    );
    assert.equal(
      (await adminDb.collection("sim_task_outputs").where("taskId", "==", taskId).get()).size,
      0,
      "no output ever stands for it"
    );

    // P5-K4: owner-direct tasking of a silent NPC is permitted.
    const treasuryBBefore = await treasury("cityB");
    const spawnSilent = await submitConfirmWake(
      ownerB,
      "ownerB",
      "envelope.spawn",
      {
        npcId: "charB1",
        cityId: "cityB",
        taskType: "one-off",
        task: "Note the night stores and report at dawn.",
        clientRequestId: "npc-core-g6b",
        bounds: { counterpartyCityIds: [] },
      },
      { worker: true }
    );
    assert.equal(await actionStatus(spawnSilent.actionId), "resolved");
    const silentTaskId = envelopeTaskId("ownerB", "npc-core-g6b");
    assert.ok(
      spawnSilent.summary.passes?.claims.completed.some(
        (c) => c.taskId === silentTaskId && c.outcome === "DONE"
      ),
      "the silent NPC's directly-tasked envelope completes"
    );
    assert.equal(claimedEnvelopes.find((c) => c.taskId === silentTaskId)?.npcId, "charB1");
    assert.equal(
      (await adminDb.collection("sim_task_outputs").where("taskId", "==", silentTaskId).get()).size,
      1,
      "its output stands as a draft in the thread"
    );
    assert.equal(
      await treasury("cityB"),
      treasuryBBefore,
      "the output is advisory: nothing binds, nothing moves"
    );
    await verifyOk();
  }
  console.log("ok N6 owner-direct envelopes (QUEUED/defer/dup-refusal/cancel-terminal) + P5-K4 silent direct tasking");

  // ======================================================================
  // N7 — needsAttention conversion (P5-G12) + postures (P5-G5): two
  // real pendings (fixture funds) are patched to the countersign's
  // fixture state — 3 attempts, flag set, no Situation — the
  // pre-Phase-5 condition. The first wake converts each exactly
  // once; the pendings stay pending throughout; cityA's card meets
  // the ask-first envoy first and rests as a draft (awaiting_owner,
  // no state moved); cityB's card meets only the silent keeper and
  // closes as ONE silence commit. Handling the converted card never
  // clears the pending's flag (P5-K8).
  // ======================================================================
  let pendingA = "";
  let pendingB = "";
  let cardAId = "";
  let cardBId = "";
  {
    const fundA = await submitConfirmWake(ownerA, "ownerA", "fixture_fund", {
      cityId: "cityA",
      fundName: "Attention Fund A",
      fundId: "fundAttnA",
      amountRubars: 10_000,
      mode: "determinate",
      effectField: "stats.treasuryRubars",
      effectDelta: 1,
      disbursementRubars: 10_000,
    });
    pendingA = `pend_${fundA.actionId}_01`;
    const fundB = await submitConfirmWake(ownerB, "ownerB", "fixture_fund", {
      cityId: "cityB",
      fundName: "Attention Fund B",
      fundId: "fundAttnB",
      amountRubars: 10_000,
      mode: "determinate",
      effectField: "stats.treasuryRubars",
      effectDelta: 1,
      disbursementRubars: 10_000,
    });
    pendingB = `pend_${fundB.actionId}_01`;
    assert.ok(await adminDoc(`sim_pending_consequences/${pendingA}`), "pending A stands");
    assert.ok(await adminDoc(`sim_pending_consequences/${pendingB}`), "pending B stands");

    // The countersign's G12 fixture state, applied to the real
    // pendings: 3 failed attempts, the flag set, no Situation yet —
    // and a ripe seq far in the future so the scan never ripens them
    // mid-scenario (they must remain pending throughout).
    for (const pendingId of [pendingA, pendingB]) {
      await adminDb.doc(`sim_pending_consequences/${pendingId}`).update({
        attempts: 3,
        needsAttention: true,
        lastFailure: { at: new Date(nowIso()), code: "GENERATION_INVALID" },
        "ripeCondition.requiredSeq": 999_999_999,
      });
      assert.equal(
        (await situationsWhere("source.sourceId", pendingId)).length,
        0,
        "no Situation exists for the flagged pending yet"
      );
    }

    const notificationsBefore = (await adminDb.collection("notifications").get()).size;
    const treasuryABefore = await treasury("cityA");
    const actionsBefore = (await adminDb.collection("sim_actions").get()).size;
    const drive = await submitConfirmWake(ownerB, "ownerB", "fixture_adjust", {
      cityId: "cityB",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    const passes = drive.summary.passes;
    assert.ok(passes);
    assert.ok(passes.attention.converted.includes(pendingA), "pending A converted");
    assert.ok(passes.attention.converted.includes(pendingB), "pending B converted");

    const cardsA = await situationsWhere("source.sourceId", pendingA);
    assert.equal(cardsA.length, 1, "exactly one system Situation for pending A");
    cardAId = cardsA[0].situationId as string;
    assert.equal(cardsA[0].kind, "system");
    assert.equal(
      cardsA[0].status,
      "awaiting_owner",
      "G5 draft posture: the ask-first envoy governs the card — a draft rests, nothing executes"
    );
    assert.ok(
      passes.triggers.routed.some((t) => t.situationId === cardAId && t.outcome === "draft"),
      "the trigger pass routed the card as a draft"
    );
    assert.equal(
      (await adminDb.collection("sim_actions").get()).size,
      actionsBefore + 1,
      "a draft spawns no action (only the drive action was added)"
    );
    assert.equal(await treasury("cityA"), treasuryABefore, "the draft moved no cityA state");

    const cardsB = await situationsWhere("source.sourceId", pendingB);
    assert.equal(cardsB.length, 1, "exactly one system Situation for pending B");
    cardBId = cardsB[0].situationId as string;
    assert.equal(cardsB[0].status, "silent", "G5 silent posture: the card closes as a non-response");
    assert.ok(
      passes.silence.committed.some(
        (s) => s.situationId === cardBId && s.producingMode === "npc-silent-mode"
      ),
      "the silence pass committed it under the keeper's contemplation"
    );
    const silenceEntries = (await allEntries()).filter(
      (e) => (e.classification as Record<string, unknown>)?.silence === true
    );
    assert.equal(silenceEntries.length, 1, "exactly one silence entry in the Log");
    assert.equal(
      (silenceEntries[0].classification as Record<string, unknown>)?.producingMode,
      "npc-silent-mode"
    );
    assert.equal((silenceEntries[0].actor as Record<string, unknown>)?.type, "npc");
    assert.equal((silenceEntries[0].actor as Record<string, unknown>)?.npcId, "charB1");
    assert.equal(
      (silenceEntries[0].actor as Record<string, unknown>)?.mandateId,
      "mand-keeper-1",
      "P5-K9: the silence commit cites the contemplating NPC + mandate"
    );
    assert.equal(
      (await adminDb.collection("notifications").get()).size,
      notificationsBefore,
      "no notification exists for a non-major situation"
    );

    for (const [pendingId, cardId] of [
      [pendingA, cardAId],
      [pendingB, cardBId],
    ] as const) {
      const pending = await adminDoc(`sim_pending_consequences/${pendingId}`);
      assert.equal(pending?.status, "pending", "the pending itself is unchanged and still pending");
      assert.equal(pending?.needsAttention, true);
      assert.equal(pending?.attentionSituationId, cardId, "the dedupe stamp names the one card");
    }
    await verifyOk();

    // Dedupe across wakes: repeated wakes never mint a second card.
    await submitConfirmWake(ownerA, "ownerA", "fixture_adjust", {
      cityId: "cityA",
      field: "stats.treasuryRubars",
      delta: 1,
    });
    assert.equal((await situationsWhere("source.sourceId", pendingA)).length, 1);
    assert.equal((await situationsWhere("source.sourceId", pendingB)).length, 1);
    assert.equal((await adminDoc(`sim_pending_consequences/${pendingA}`))?.status, "pending");

    // P5-K8: handling the Situation does not clear the flag. The
    // owner declines the awaiting draft (the F3/G12 payload shape) —
    // the card completes as handled-by-declining; the pending is
    // untouched by any of it.
    const cardADoc = await adminDoc(`sim_situations/${cardAId}`);
    const cardACityId =
      (cardADoc?.audienceCityId as string | null) ?? (cardADoc?.cityId as string | null);
    const decline = await submitConfirmWake(
      ownerA,
      "ownerA",
      "situation.handle",
      {
        situationId: cardAId,
        outcome: "declined",
        decisionNote: "Declined at the gate fixture; the pending is its own affair.",
      },
      { targetCityIds: cardACityId ? [cardACityId] : [] }
    );
    assert.equal(await actionStatus(decline.actionId), "resolved");
    assert.equal((await adminDoc(`sim_situations/${cardAId}`))?.status, "handled");
    const declineEntries = await entriesOf(decline.actionId);
    assert.ok(
      declineEntries.some(
        (e) => (e.classification as Record<string, unknown>)?.outcome === "declined"
      ),
      "the decline is on the record with its outcome verb (§6.1 handled-by-declining)"
    );
    const pendingAfter = await adminDoc(`sim_pending_consequences/${pendingA}`);
    assert.equal(pendingAfter?.status, "pending", "handling never touches the pending");
    assert.equal(pendingAfter?.needsAttention, true, "… and never clears its flag (P5-K8)");
    await verifyOk();
  }
  console.log("ok N7 conversion x2 (draft + silence postures), dedupe across wakes, P5-K8 flag survives handling");

  // ======================================================================
  // N8 — Revocation boundary (P5-G8): mandate.revoke clears the NPC
  // snapshot in the same resolution; a later matching card is BLOCKED
  // at the boundary (the §7.3 evaluation entry + the card rests open),
  // never silently re-authorized. A non-owner mode change is refused.
  // ======================================================================
  {
    const revoke = await submitConfirmWake(ownerA, "ownerA", "mandate.revoke", {
      mandateId: "mand-steward-1",
      citations: { recordPaths: ["sim_mandates/mand-steward-1"] },
    });
    assert.equal(await actionStatus(revoke.actionId), "resolved");
    const root = await adminDoc("sim_mandates/mand-steward-1");
    assert.equal(root?.status, "revoked");
    assert.ok(typeof root?.revokedSeq === "number", "the revocation is seq-stamped");
    const stewardDoc = await adminDoc("sim_npcs/charA2");
    assert.equal(stewardDoc?.currentMandateId, null, "revocation clears the snapshot");
    assert.equal(stewardDoc?.currentMandateVersion, null);
    assert.equal(
      stewardDoc?.permissionMode,
      "act-for-me",
      "the mode value itself is left as-is (the mandate is what died)"
    );

    const card = buildSituationDoc({
      cityId: "cityA",
      audienceCityId: "cityA",
      audienceOwnerUidsSnapshot: ["ownerA"],
      recipientUid: null,
      kind: "proposal",
      severity: "routine",
      title: "Proposal: a second treasury adjustment",
      summary:
        "Seeded after the steward's mandate was revoked: the matching rule must block at the authority boundary, not fire.",
      detail: {
        delegatedAction: {
          actionType: "fixture_adjust",
          structuredAction: { cityId: "cityA", field: "stats.treasuryRubars", delta: 7000 },
          targetCityIds: ["cityA"],
        },
      },
      source: { kind: "manual-action", sourceId: "npc-core-fire-2", sourceSeq: null, sourceResolutionId: null },
      createdSeq: await headSeq(),
      now: nowIso(),
    });
    await adminDb.doc(`sim_situations/${card.situationId}`).set(card);
    const treasuryBefore = await treasury("cityA");
    const blockedCityId = card.audienceCityId ?? card.cityId;
    const touch = await submitConfirmWake(
      ownerA,
      "ownerA",
      "situation.handle",
      { situationId: card.situationId },
      { targetCityIds: blockedCityId ? [blockedCityId] : [] }
    );
    assert.equal(
      await actionStatus(touch.actionId),
      "resolved",
      "the trigger touch itself commits — its manifest is what makes the card a delegation-pass candidate"
    );
    assert.ok(
      touch.summary.passes?.delegation.blocked.includes(card.situationId),
      "the fire is blocked: the handler's authority changed (revoked) since the rule was written"
    );
    assert.ok(
      !touch.summary.passes?.delegation.fired.some((f) => f.situationId === card.situationId),
      "nothing fired"
    );
    assert.equal(
      (await adminDoc(`sim_situations/${card.situationId}`))?.status,
      "open",
      "the card rests open with its owner"
    );
    assert.equal(await treasury("cityA"), treasuryBefore, "a blocked fire moves nothing");

    const foreignMode = await submitConfirmWake(memberC, "memberC", "npc.setMode", {
      npcId: "charA2",
      permissionMode: "silent",
    });
    assert.equal(await actionStatus(foreignMode.actionId), "rejected");
    assert.equal(
      (await adminDoc("sim_npcs/charA2"))?.permissionMode,
      "act-for-me",
      "a non-owner cannot move the mode"
    );
    await verifyOk();
  }
  console.log("ok N8 mandate.revoke -> snapshot cleared; later fire blocked at the boundary; non-owner setMode refused");

  // ======================================================================
  // N9 — Undo (P5-G9, the non-D6 half): a leaf governance resolution
  // (npc.setMode with no mandate in force) undoes totally — entries
  // and manifest erased, the doc restored. A resolution whose effects
  // cascaded (the steward's mandate.set, consumed by N4's fire)
  // refuses with DEPENDENTS_EXIST.
  //
  // A-7 HOLDOUT — PRESERVED, NOT ASSERTED: the P5-G9 assertion that
  // turns on P5-D6 (what happens to an EFFECTIVE mandate version
  // inside an undo restore transaction — deletion vs pointer-restore
  // + status flip) is deliberately absent from this suite, exactly as
  // the deletion-inside-restore assertion is held out of PR-1's rules
  // matrix. P5-D6 remains PENDING Koda ratification; the recommended
  // reading (Petra, phase5-decisions.md: adopt brief §9.8 as written —
  // inside a restore transaction only, fabric restores the root's
  // version pointer and flips the superseded version's status; the
  // version payload is never edited) is stated in the gate PR body as
  // PENDING. This suite does not ride the §9.8 default and does not
  // claim the assertion. G9's row stays OPEN on that one named item.
  // ======================================================================
  {
    const { sha256Hex } = await import("../lib/sim/canonical");
    let opCounter = 0;
    const createUndoOp = async (uid: string, targetResolutionId: string) => {
      opCounter += 1;
      const opId = sha256Hex(`${uid}:undo-npc-${opCounter}`);
      await setDoc(doc(ownerA.firestore(), "sim_undo_operations", opId), {
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

    // (a) Leaf undo of a governance write erases totally.
    const setMode = await submitConfirmWake(ownerA, "ownerA", "npc.setMode", {
      npcId: "charA2",
      permissionMode: "ask-first",
    });
    assert.equal(await actionStatus(setMode.actionId), "resolved");
    assert.equal((await adminDoc("sim_npcs/charA2"))?.permissionMode, "ask-first");
    const opId = await createUndoOp("ownerA", setMode.actionId);
    await wake();
    const op = await adminDoc(`sim_undo_operations/${opId}`);
    assert.equal(op?.status, "completed");
    assert.equal(
      (await adminDoc("sim_npcs/charA2"))?.permissionMode,
      "act-for-me",
      "the mode is restored to its pre-resolution value"
    );
    assert.equal((await entriesOf(setMode.actionId)).length, 0, "the resolution's entries are erased");
    assert.equal(await adminDoc(`sim_resolutions/${setMode.actionId}`), null, "its manifest is erased");
    assert.equal(await adminDoc(`sim_actions/${setMode.actionId}`), null, "its source action is erased");

    // (b) Cascaded resolutions refuse: the fire consumed the mandate.
    const versionDoc = await adminDoc("sim_mandates/mand-steward-1/versions/1");
    const mandateSetActionId = versionDoc?.sourceActionId as string;
    assert.ok(mandateSetActionId, "the version names its authoring action");
    const treasuryBefore = await treasury("cityA");
    const blockedOpId = await createUndoOp("ownerA", mandateSetActionId);
    await wake();
    const blockedOp = await adminDoc(`sim_undo_operations/${blockedOpId}`);
    assert.equal(blockedOp?.status, "failed");
    assert.equal(
      (blockedOp?.failure as Record<string, unknown>)?.code,
      "DEPENDENTS_EXIST",
      "the mandate's effects cascaded (N4's fire) — undo is refused, per CJ's dependency limit"
    );
    assert.equal(
      (await adminDoc("sim_mandates/mand-steward-1"))?.status,
      "revoked",
      "the refused undo changed nothing"
    );
    assert.equal(await treasury("cityA"), treasuryBefore);
    await verifyOk();
  }
  console.log("ok N9 undo: leaf governance write erases totally; cascaded mandate.set refuses DEPENDENTS_EXIST (A-7/D6 assertion held out)");

  // ======================================================================
  // N10 — The novel-title NPC (P5-G13's engine half): an NPC whose
  // title and scope are pure prose — no template, no closed enum —
  // creates, validates, is tasked, and resolves end-to-end through
  // the dispatcher. (The GREP half and the rendered sweep are gate
  // evidence in the PR, per A-6.)
  // ======================================================================
  {
    const create = await submitConfirmWake(ownerA, "ownerA", "npc.create", {
      characterId: "charA3",
      cityId: "cityA",
      displayNameSnapshot: "Una Vail",
      titleFreeform: "Keeper of the Third Bell",
      roleTemplate: null,
      personality: { traits: ["solemn", "unhurried"], voiceNotes: null, characterNotes: null },
      scopeFreeform:
        "Tend the harbor bell; answer any keeper's question in prose, at whatever length the question deserves.",
    });
    assert.equal(await actionStatus(create.actionId), "resolved");
    const doc3 = await adminDoc("sim_npcs/charA3");
    assert.equal(doc3?.titleFreeform, "Keeper of the Third Bell", "the prose title stands verbatim");
    assert.equal(
      doc3?.scopeFreeform,
      "Tend the harbor bell; answer any keeper's question in prose, at whatever length the question deserves.",
      "the prose scope stands verbatim"
    );
    assert.equal(doc3?.permissionMode, "ask-first");

    const task = await submitConfirmWake(
      ownerA,
      "ownerA",
      "envelope.spawn",
      {
        npcId: "charA3",
        cityId: "cityA",
        taskType: "one-off",
        task: "Ring the third bell at dusk and note the weather.",
        clientRequestId: "npc-core-g13",
        bounds: { counterpartyCityIds: [] },
      },
      { worker: true }
    );
    assert.equal(await actionStatus(task.actionId), "resolved");
    const taskId = envelopeTaskId("ownerA", "npc-core-g13");
    assert.equal((await adminDoc(`sim_task_envelopes/${taskId}`))?.status, "DONE");
    assert.equal(
      (await adminDb.collection("sim_task_outputs").where("taskId", "==", taskId).get()).size,
      1,
      "the novel NPC's task resolves with its output standing"
    );
    await verifyOk();
  }
  console.log("ok N10 novel-title NPC (prose title/scope verbatim) creates, is tasked, resolves");

  // ======================================================================
  // N11 — Exports (P5-G10's export half): the §11.4 pure builders over
  // bundles mapped from this scenario's standing state (the fetchers'
  // own mapping, applied to Admin-read docs). In-scope builds stand;
  // a foreign requester fails closed — no partial file, ever.
  // ======================================================================
  {
    const exportCtx: Phase5ExportContext = {
      asOfSeq: await headSeq(),
      rulesVersion: RESOLVER_RULES_VERSION,
      exportedAtIso: nowIso(),
      exportedByLabel: "the requesting member",
    };
    const allSituations = (await adminDb.collection("sim_situations").get()).docs.map(
      (d) => d.data() as Record<string, unknown>
    );
    const cityACards = allSituations.filter((s) => s.audienceCityId === "cityA");
    assert.ok(cityACards.length >= 4, "the scenario produced its cityA cards");
    const situationsBundle: SituationsHistoryBundle = {
      requesterUid: "ownerA",
      ownedCityIds: ["cityA"],
      cityNames: { cityA: "Fixture City A", cityB: "Fixture City B" },
      situations: cityACards.map((s) => {
        const handling = (s.handling ?? null) as Record<string, unknown> | null;
        return {
          situationId: s.situationId as string,
          kind: s.kind as string,
          status: s.status as string,
          severity: s.severity as string,
          title: s.title as string,
          summary: s.summary as string,
          cityId: s.cityId as string | null,
          audienceCityId: s.audienceCityId as string | null,
          recipientUid: s.recipientUid as string | null,
          createdSeq: s.createdSeq as number | null,
          resolvedSeq: s.resolvedSeq as number | null,
          handlingMode: (handling?.mode as string) ?? null,
          handlingNpcId: (handling?.npcId as string) ?? null,
          handlingMandateId: (handling?.mandateId as string) ?? null,
          handlingMandateVersion: (handling?.mandateVersion as number) ?? null,
          delegationRuleId: (handling?.delegationRuleId as string) ?? null,
          delegationCycleCount: s.delegationCycleCount as number,
          sourceKind: (s.source as Record<string, unknown>).kind as string,
          sourceSeq: (s.source as Record<string, unknown>).sourceSeq as number | null,
        };
      }),
    };
    const situationsBook = buildSituationsWorkbook(situationsBundle, exportCtx, "ownerA");
    const dataSheets = situationsBook.sheets.filter(
      (s) => s.name === "Waiting" || s.name === "History"
    );
    assert.deepEqual(
      dataSheets.map((s) => s.name),
      ["Waiting", "History"],
      "the workbook carries the Waiting + History data sheets (plus cover/summary/definitions)"
    );
    assert.equal(
      dataSheets.reduce((n, s) => n + s.rows.length, 0),
      cityACards.length,
      "every in-scope card is exported, none invented"
    );
    assert.throws(
      () => buildSituationsWorkbook(situationsBundle, exportCtx, "memberC"),
      "a foreign requester fails closed"
    );

    const npcDocs = (await adminDb.collection("sim_npcs").get()).docs.map(
      (d) => d.data() as Record<string, unknown>
    );
    const registerBundle: NpcRegisterBundle = {
      requesterUid: "ownerA",
      cityNames: { cityA: "Fixture City A", cityB: "Fixture City B" },
      npcs: npcDocs
        .filter((n) => n.ownerUid === "ownerA")
        .map((n) => ({
          npcId: n.npcId as string,
          ownerUid: n.ownerUid as string,
          cityId: n.cityId as string,
          displayName: n.displayNameSnapshot as string,
          title: n.titleFreeform as string,
          permissionMode: n.permissionMode as string,
          status: n.status as string,
          currentMandateId: n.currentMandateId as string | null,
          currentMandateVersion: n.currentMandateVersion as number | null,
          activationSeq: n.activationSeq as number | null,
          retiredSeq: n.retiredSeq as number | null,
        })),
      mandates: [],
      rules: [],
    };
    for (const mandateId of ["mand-steward-1", "mand-envoy-1"]) {
      const root = await adminDoc(`sim_mandates/${mandateId}`);
      const version = await adminDoc(`sim_mandates/${mandateId}/versions/1`);
      assert.ok(root && version);
      const scope = version.structuredScope as Record<string, unknown>;
      const caps = version.caps as Record<string, unknown>;
      registerBundle.mandates.push({
        mandateId,
        ownerUid: root.ownerUid as string,
        npcId: root.npcId as string,
        cityId: root.cityId as string,
        rootStatus: root.status as string,
        version: 1,
        permissionMode: version.permissionMode as string,
        scopeFreeform: version.scopeFreeform as string,
        triggerKinds: (scope.triggerKinds as string[]).join(", "),
        allowedActionTypes: (scope.allowedActionTypes as string[]).join(", "),
        namedRecordIds: (scope.namedRecordIds as string[]).join(", "),
        perActionRubars: caps.perActionRubars as number | null,
        perResolutionPeriodRubars: caps.perResolutionPeriodRubars as number | null,
        periodDefinition: caps.periodDefinition as string | null,
        allowPartialExecution: caps.allowPartialExecution as boolean,
        alwaysEscalate: ((version.alwaysEscalate as string[]) ?? []).join(", "),
        mandateHash: version.mandateHash as string,
        effectiveSeq: version.effectiveSeq as number | null,
        supersededSeq: version.supersededSeq as number | null,
      });
    }
    for (const ruleId of ["rule-fire-1", "rule-ask-1"]) {
      const root = await adminDoc(`sim_delegation_rules/${ruleId}`);
      const version = await adminDoc(`sim_delegation_rules/${ruleId}/versions/1`);
      assert.ok(root && version);
      const match = version.match as Record<string, unknown>;
      const handler = version.handler as Record<string, unknown>;
      registerBundle.rules.push({
        ruleId,
        ownerUid: root.ownerUid as string,
        cityId: root.cityId as string,
        version: 1,
        enabled: root.enabled as boolean,
        status: root.status as string,
        alwaysWait: version.alwaysWait as boolean,
        situationKinds: (match.situationKinds as string[]).join(", "),
        handlerNpcId: handler.npcId as string | null,
        handlerMode: handler.mode as string,
        handlerMandateId: handler.mandateId as string | null,
        perActionRubars: null,
        ruleHash: root.ruleHash as string,
        effectiveSeq: root.effectiveSeq as number | null,
      });
    }
    const registerBook = buildNpcRegisterWorkbook(registerBundle, exportCtx, "ownerA");
    const registerData = registerBook.sheets.filter((s) =>
      ["NPCs", "Mandates", "Delegation rules"].includes(s.name)
    );
    assert.equal(registerData.length, 3, "the register workbook stands (NPCs, Mandates, Delegation rules)");
    const registerRows = registerData.reduce((n, s) => n + s.rows.length, 0);
    assert.equal(registerRows, 3 + 2 + 2, "the register exports exactly the scenario's own records");
    assert.throws(
      () => buildNpcRegisterWorkbook(registerBundle, exportCtx, "memberC"),
      "the register also fails closed for a foreign requester"
    );
  }
  console.log("ok N11 §11.4 export builders over the standing state; foreign requester fails closed");

  // ======================================================================
  // Final — the whole accumulated world verifies (P5-G13's standing
  // half): every resolution above, NPC-attributed entries included,
  // under the F5 verifier.
  // ======================================================================
  await verifyOk();
  console.log("ok npc-core: full standing world verifies clean");
  console.log("NPC CORE SUITE PASSED (Phase 5 gate evidence, built form — A-2)");

  await env.cleanup();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
