/**
 * Phase 4 Module 0 data step (brief §3.6): stamps `pointBudget: 400` on
 * every existing `sim_stat_allocations` doc and adds the `defensePosture`
 * default to every existing `sim_cities` doc, in one run — idempotent,
 * re-runnable, and verified by the step's own assertion pass (every doc
 * stamped; no other field touched; byte-compare outside the two
 * targets). See lib/sim/phase4DataStep.ts for the step itself.
 *
 * Emulator only in Phase 4: this script refuses to run without
 * FIRESTORE_EMULATOR_HOST. Production execution belongs to the
 * production chain (P2-K15 / production-steps-runbook.md), never to a
 * Phase 4 build step (brief §3.6, §14 prohibition 1).
 *
 * Usage (emulator only):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx tsx scripts/sim-phase4-data-step.ts
 */

import { applyPhase4DataStep } from "../lib/sim/phase4DataStep";
import { getSimDb, requireEmulator } from "./sim-admin";

async function main() {
  requireEmulator("run the Phase 4 data step");
  const db = getSimDb();
  const report = await applyPhase4DataStep(db);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
