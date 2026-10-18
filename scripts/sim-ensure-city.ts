/**
 * Lazy city creation for one faction (Phase 1 brief §3), manual/emulator
 * use in Phase 1: the Phase 4 fabric runner is the ongoing trigger.
 *
 * Usage (emulator only):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/sim-ensure-city.ts <factionId>
 *
 * Unowned factions abort as `unclaimed` and create nothing; a second run
 * for a created city is a no-op. No Log entry is written (decision L-1).
 */

import { ensureSimCity } from "../lib/sim/ensureSimCity";
import { getSimDb, requireEmulator } from "./sim-admin";

async function main() {
  const factionId = process.argv[2];
  if (!factionId) {
    throw new Error("usage: sim-ensure-city.ts <factionId>");
  }
  requireEmulator("run lazy creation");
  const db = getSimDb();
  const result = await ensureSimCity(db, factionId);
  console.log(`ensureSimCity(${factionId}): ${result.status}`);
  if (result.status === "no_faction" || result.status === "unclaimed") {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
