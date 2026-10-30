/**
 * Seed the P3-FIX fixture world for the P3-G1-C4 capture sitting.
 *
 * The fixture definitions live in lib/sim/fixtures/p3fix.ts — the single
 * source of truth shared with tests/sim-core.test.ts (which seeds the
 * same user/faction/stat pieces inline for its CI scenario). This script
 * is only the runnable wrapper: guards, Admin bootstrap, the seed call,
 * and a printed summary with the fixture sign-ins and surface URLs.
 * The sitting itself is scripted in workstreams/
 * a9-p3g1c4-preview-evidence-pack.md §3 (follow-on note).
 *
 * Emulator only — the script refuses unless BOTH emulator hosts are set
 * (the sim-rebuild-snapshot posture, Phase 3 brief §3.2): with the hosts
 * set, the Admin SDK can only reach the emulators, so this script can
 * never seed production. Re-running converges the identical fixture
 * world (see seedP3Fix's idempotency note); it deletes nothing.
 *
 * Usage (emulators already running — e.g. `firebase emulators:start`
 * for the dev-server sitting):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *     npx tsx scripts/seed-p3fix.ts
 * Or one-shot:
 *   firebase emulators:exec --only firestore,auth --project cowboycityrealm \
 *     "npx tsx scripts/seed-p3fix.ts"
 */

import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  P3FIX_CITIES,
  P3FIX_OWNER_B,
  P3FIX_USERS,
  seedP3Fix,
} from "../lib/sim/fixtures/p3fix";
import { getSimDb, requireEmulator } from "./sim-admin";

async function main() {
  requireEmulator("seed the P3-FIX fixture world");
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "REFUSING to seed the P3-FIX fixture world: FIREBASE_AUTH_EMULATOR_HOST " +
        "is not set. The seed creates fixture Auth users for the capture " +
        "sign-ins, and sim procedures run against the emulators only " +
        "(Phase 3 brief §3.2/§15)."
    );
  }
  const db = getSimDb();
  const auth = getAuth(getApps()[0]);
  const report = await seedP3Fix(db, auth);

  console.log("P3-FIX fixture world seeded:");
  console.log(`  genesis: ${report.genesis}`);
  for (const city of P3FIX_CITIES) {
    console.log(
      `  sim city ${city.factionId}: ${report.simCities[city.factionId]} (sheet /factions/${city.factionDoc.slug})`
    );
  }
  console.log(`  cityB structures: ${report.structures.join(", ")}`);
  console.log(`  cityB pin: ${report.pinId}; citySparse wiki section: ${report.wikiSectionId}`);
  console.log(`  dashboard snapshot rebuilt at asOfSeq ${report.snapshotAsOfSeq}`);
  console.log("Fixture sign-ins (emulator Auth only — not real credentials):");
  for (const user of P3FIX_USERS) {
    console.log(`  ${user.uid}: ${user.email} / ${user.password}`);
  }
  console.log(
    `Start the dev server (npm run dev) against the same emulators and capture per the A9 pack §3, starting as ${P3FIX_OWNER_B.uid} on the dashboard (/).`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
