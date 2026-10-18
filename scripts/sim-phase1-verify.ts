/**
 * Phase 1 data-shape verification (Phase 1 brief §7 P1-G2/G3/G4, §8 step 4).
 *
 * Runs genesis + fixture lazy creations against the Firestore EMULATOR
 * and asserts the data-shape half of the Phase 1 QA gate over the
 * resulting documents. The rules half (P1-G1/G5/G6/G7) lives in
 * tests/rules.test.ts and runs via `npm run test:rules`.
 *
 * Usage:
 *   firebase emulators:start --only firestore --project cowboycityrealm
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/sim-phase1-verify.ts
 *
 * Emulator only — the script refuses to run without FIRESTORE_EMULATOR_HOST
 * and only ever touches its three fixture factions plus sim_* collections.
 */

import type { Firestore } from "firebase-admin/firestore";
import { canonicalJson } from "../lib/sim/canonical";
import { ensureSimCity } from "../lib/sim/ensureSimCity";
import { projectFirestoreValue, runGenesis } from "../lib/sim/genesis";
import {
  BASELINE_HASH,
  EVEN_START_TEMPLATE,
  INITIAL_POINT_BUDGET,
  logEntryDocId,
} from "../lib/sim/template";
import { getSimDb, requireEmulator } from "./sim-admin";

const FIXTURES = ["cityA", "cityB", "cityU"];
// A distinctive corpus-style figure planted ONLY in lore-layer fixtures.
// If it ever appears inside a sim_* document, the even start has leaked.
const CORPUS_TRIPWIRE = 987654321;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function wipe(db: Firestore) {
  for (const name of [
    "sim_world",
    "sim_counters",
    "sim_log_entries",
    "sim_cities",
    "sim_stat_allocations",
    "sim_actions",
    "sim_resolutions",
    "sim_publications",
    "sim_intel_records",
    "sim_fabric_status",
    "sim_character_extensions",
  ]) {
    const snap = await db.collection(name).get();
    for (const docSnap of snap.docs) await docSnap.ref.delete();
  }
  for (const id of FIXTURES) {
    await db.collection("factions").doc(id).delete();
    await db.collection("wiki_entries").doc(`lore-${id}`).delete();
  }
  const members = await db
    .collection("faction_members")
    .where("factionId", "in", FIXTURES)
    .get();
  for (const docSnap of members.docs) await docSnap.ref.delete();
}

async function seedFixtures(db: Firestore) {
  await db.collection("factions").doc("cityA").set({
    name: "Fixture City A",
    slug: "fixture-a",
    ownerUids: ["ownerA"],
  });
  await db.collection("faction_members").doc("ownerA_cityA").set({
    uid: "ownerA",
    factionId: "cityA",
    role: "owner",
  });
  // cityB: ownership proven by the faction_members row alone.
  await db.collection("factions").doc("cityB").set({
    name: "Fixture City B",
    slug: "fixture-b",
    ownerUids: [],
  });
  await db.collection("faction_members").doc("ownerB_cityB").set({
    uid: "ownerB",
    factionId: "cityB",
    role: "owner",
  });
  // cityU: exists, owned by nobody (the roster test's subject).
  await db.collection("factions").doc("cityU").set({
    name: "Fixture City U",
    slug: "fixture-u",
    ownerUids: [],
  });
  // Lore-layer fixture carrying the corpus tripwire WITH a citation —
  // the one place such a figure is allowed to exist.
  await db.collection("wiki_entries").doc("lore-cityA").set({
    cityId: "cityA",
    title: "Fixture lore",
    gdpRubars: CORPUS_TRIPWIRE,
    source: { citation: "fixture corpus doc, planted tripwire" },
  });
}

function serialized(docData: Record<string, unknown>): string {
  return canonicalJson(projectFirestoreValue(docData));
}

async function allSimDocs(db: Firestore) {
  const out: { path: string; data: Record<string, unknown> }[] = [];
  for (const name of [
    "sim_world",
    "sim_counters",
    "sim_log_entries",
    "sim_cities",
    "sim_stat_allocations",
    "sim_actions",
    "sim_resolutions",
    "sim_publications",
    "sim_intel_records",
    "sim_fabric_status",
    "sim_character_extensions",
  ]) {
    const snap = await db.collection(name).get();
    for (const docSnap of snap.docs) {
      out.push({
        path: `${name}/${docSnap.id}`,
        data: docSnap.data() as Record<string, unknown>,
      });
    }
  }
  return out;
}

async function main() {
  requireEmulator("verify Phase 1 data shapes");
  const db = getSimDb();

  await wipe(db);
  await seedFixtures(db);

  const genesis = await runGenesis(db, {});
  check("genesis created", genesis.status === "created");
  const a1 = await ensureSimCity(db, "cityA");
  const b1 = await ensureSimCity(db, "cityB");
  const u1 = await ensureSimCity(db, "cityU");
  check("ensureSimCity(cityA) created", a1.status === "created");
  check("ensureSimCity(cityB) created", b1.status === "created");
  check("ensureSimCity(cityU) unclaimed abort", u1.status === "unclaimed");

  console.log("P1-G2 — even start / TC-D04 rewritten");
  const world = (await db.collection("sim_world").doc("current").get()).data() ?? {};
  const cityA = (await db.collection("sim_cities").doc("cityA").get()).data() ?? {};
  const cityB = (await db.collection("sim_cities").doc("cityB").get()).data() ?? {};
  const allocA = (await db.collection("sim_stat_allocations").doc("cityA").get()).data() ?? {};
  const allocB = (await db.collection("sim_stat_allocations").doc("cityB").get()).data() ?? {};
  const baseA = (cityA.baseline ?? {}) as Record<string, unknown>;
  const baseB = (cityB.baseline ?? {}) as Record<string, unknown>;
  check(
    "baselineHash identical across world + both cities + both allocations",
    world.evenStartTemplateHash === BASELINE_HASH &&
      baseA.baselineHash === BASELINE_HASH &&
      baseB.baselineHash === BASELINE_HASH &&
      allocA.baselineHash === BASELINE_HASH &&
      allocB.baselineHash === BASELINE_HASH
  );
  const templateJson = canonicalJson(EVEN_START_TEMPLATE.baselineStats);
  check(
    "stats deep-equal the template for both cities",
    canonicalJson(projectFirestoreValue(cityA.stats)) === templateJson &&
      canonicalJson(projectFirestoreValue(cityB.stats)) === templateJson &&
      canonicalJson(projectFirestoreValue(baseA.baselineStats)) === templateJson
  );
  check(
    "allocations: status not_started, pointBudget == locked pool",
    allocA.status === "not_started" &&
      allocB.status === "not_started" &&
      allocA.pointBudget === INITIAL_POINT_BUDGET &&
      allocB.pointBudget === INITIAL_POINT_BUDGET,
    `pointBudget A=${String(allocA.pointBudget)} B=${String(allocB.pointBudget)} ` +
      "(brief §7's null assertion was the pre-lock posture; Vera's Q-B5 lock " +
      "landed at 400 — see phase1-decisions.md)"
  );
  const simDocs = await allSimDocs(db);
  check(
    "corpus tripwire appears in no sim_* document",
    simDocs.every((d) => !serialized(d.data).includes(String(CORPUS_TRIPWIRE)))
  );

  console.log("P1-G3 — roster (unowned = strongly inactive)");
  check(
    "no sim_cities/cityU and no sim_stat_allocations/cityU",
    !(await db.collection("sim_cities").doc("cityU").get()).exists &&
      !(await db.collection("sim_stat_allocations").doc("cityU").get()).exists
  );
  check(
    "no sim document references cityU",
    simDocs.every((d) => !serialized(d.data).includes('"cityU"'))
  );
  const before = serialized(
    (await db.collection("sim_cities").doc("cityA").get()).data() ?? {}
  );
  const a2 = await ensureSimCity(db, "cityA");
  const after = serialized(
    (await db.collection("sim_cities").doc("cityA").get()).data() ?? {}
  );
  check(
    "second ensureSimCity(cityA) is a no-op (doc identical, stateVersion 1)",
    a2.status === "already-exists" && before === after && cityA.stateVersion === 1
  );
  check(
    "lazy creation wrote no Log entries (only genesis exists)",
    (await db.collection("sim_log_entries").get()).size === 1
  );

  console.log("P1-G4 — null honesty");
  const stats = (cityA.stats ?? {}) as Record<string, unknown>;
  const hasNull = (obj: Record<string, unknown>, key: string) =>
    Object.prototype.hasOwnProperty.call(obj, key) && obj[key] === null;
  check(
    "military/defense/population/gdpRubars present-and-null in stats",
    hasNull(stats, "military") &&
      hasNull(stats, "defense") &&
      hasNull(stats, "population") &&
      hasNull(stats, "gdpRubars") &&
      stats.military !== 0 &&
      stats.military !== 50
  );
  check(
    "bookkeeping stocks are true zeroes",
    stats.households === 0 && stats.housingUnits === 0 && stats.treasuryRubars === 0
  );
  check(
    "lastChangedSeq / seedCityId present-and-null on the city doc",
    hasNull(cityA, "lastChangedSeq") && hasNull(cityA, "seedCityId")
  );
  const genesisEntry =
    (await db.collection("sim_log_entries").doc(logEntryDocId(1)).get()).data() ?? {};
  check(
    "genesis entry: baseline null, changes empty, visibility public",
    genesisEntry.baseline === null &&
      Array.isArray(genesisEntry.changes) &&
      (genesisEntry.changes as unknown[]).length === 0 &&
      genesisEntry.visibility === "public"
  );

  if (failures > 0) {
    console.log(`\nPhase 1 data-shape verification FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nPhase 1 data-shape verification passed (P1-G2/G3/G4)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
