/**
 * Standing-Log verification (Phase 2 brief §4.7) — recompute the chain,
 * the counter/world agreement, the Log⇄state bijection, the citations,
 * and per-field value chaining over the emulator's world, and report.
 *
 * Usage:
 *   firebase emulators:exec --only firestore --project cowboycityrealm \
 *     "tsx scripts/sim-verify-log.ts"
 *
 * Emulator-only (requireEmulator). Reads go through the Admin SDK as a
 * controlled verification op — the verifier itself shares no code path
 * with the committer beyond the canonical hash functions.
 */

import type { Firestore } from "firebase-admin/firestore";
import { verifyStandingLog, type StandingWorld } from "../lib/sim/verify";
import { PRODUCTION_BASELINE_REGISTRY } from "../lib/sim/baseline/registry";
import { getSimDb, requireEmulator } from "./sim-admin";

async function collectStateDocs(db: Firestore): Promise<Map<string, Record<string, unknown>>> {
  const stateDocs = new Map<string, Record<string, unknown>>();
  const addCollection = async (path: string) => {
    const snap = await db.collection(path).get();
    for (const docSnap of snap.docs) {
      stateDocs.set(`${path}/${docSnap.id}`, docSnap.data() as Record<string, unknown>);
    }
    return snap.docs;
  };
  const cities = await addCollection("sim_cities");
  for (const city of cities) {
    for (const sub of ["structures", "households", "figures", "corporations", "laws"]) {
      await addCollection(`sim_cities/${city.id}/${sub}`);
    }
  }
  await addCollection("sim_stat_allocations");
  for (const allocId of [...stateDocs.keys()]
    .filter((p) => p.startsWith("sim_stat_allocations/"))
    .map((p) => p.split("/")[1])) {
    await addCollection(`sim_stat_allocations/${allocId}/versions`);
  }
  await addCollection("sim_pending_consequences");
  await addCollection("sim_publications");
  await addCollection("sim_intel_records");
  await addCollection("sim_character_extensions");
  return stateDocs;
}

async function main() {
  requireEmulator("verify the standing Log");
  const db = getSimDb();

  const entriesSnap = await db.collection("sim_log_entries").orderBy("seq", "asc").get();
  const entries = entriesSnap.docs.map((d) => d.data() as Record<string, unknown>);
  const manifestsSnap = await db.collection("sim_resolutions").get();
  const manifests = new Map<string, Record<string, unknown>>();
  for (const d of manifestsSnap.docs) manifests.set(d.id, d.data() as Record<string, unknown>);
  const counter = (await db.doc("sim_counters/log").get()).data() as Record<string, unknown>;
  const world = (await db.doc("sim_world/current").get()).data() as Record<string, unknown>;
  const stateDocs = await collectStateDocs(db);

  const input: StandingWorld = {
    entries,
    manifests,
    counter,
    world,
    stateDocs,
    baselineRegistry: PRODUCTION_BASELINE_REGISTRY,
  };
  const result = verifyStandingLog(input);
  if (result.ok) {
    console.log(`standing Log verifies: ${entries.length} entries, head seq ${counter.lastSeq}.`);
  } else {
    console.error(`standing Log FAILED verification with ${result.findings.length} finding(s):`);
    for (const finding of result.findings) {
      console.error(`  [${finding.code}] ${finding.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
