/**
 * Sim genesis — one-shot operations script (Phase 1 brief §2).
 *
 * Usage (emulator, the only Phase 1 path):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/sim-genesis.ts
 *
 * Production genesis is a separate, explicit Koda/CJ operations decision:
 * it requires BOTH the --production flag here AND the environment variable
 * SIM_GENESIS_ALLOW_PRODUCTION=1 (the guard lives in lib/sim/genesis.ts).
 * Phase 1 never passes them. Idempotent: if genesis already exists, the
 * script reports it and changes nothing.
 */

import { runGenesis } from "../lib/sim/genesis";
import { getSimDb } from "./sim-admin";

async function main() {
  const allowProduction = process.argv.includes("--production");
  const db = getSimDb();
  const result = await runGenesis(db, { allowProduction });
  if (result.status === "already-present") {
    console.log("genesis already present — no writes made (idempotent refusal)");
  } else {
    console.log(`genesis created: baselineHash ${result.baselineHash}`);
    console.log(`genesis entryHash: ${result.entryHash}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
