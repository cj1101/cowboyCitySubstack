/**
 * Sim wake runner (Phase 2 brief §1.1/§4.1) — runs ONE dispatcher wake
 * against the Firestore emulator.
 *
 * Usage:
 *   firebase emulators:exec --only firestore,auth --project cowboycityrealm \
 *     "tsx scripts/sim-run-wake.ts [--now <ISO>] [--prepared <payloads.json>]"
 *
 * Emulator-only, doubly: the script refuses unless BOTH emulator hosts
 * are set, and the only Admin SDK use is minting a custom token for the
 * emulator's fictional `fabric-service` user (claims fabric: true,
 * fabricRole: "committer"). Every sim read/write then flows through the
 * client SDK signed in as that user — i.e. through the security rules,
 * exactly as production fabric would. No service user is provisioned
 * anywhere real by this script; nothing here touches production.
 *
 * The wake exists because this script is invoked on a player-caused
 * occasion. Phase 2 ships no scheduler; Phase 4/5 runners invoke the
 * same `runWake` on their own player-caused triggers.
 */

import { readFileSync } from "node:fs";
import { initializeApp as initializeAdminApp, getApps as getAdminApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth as getClientAuth, signInWithCustomToken } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { getSimDb, requireEmulator, SIM_PROJECT_ID } from "./sim-admin";
import { runWake } from "../lib/sim/dispatcher";
import { PRODUCTION_BASELINE_REGISTRY } from "../lib/sim/baseline/registry";
import type { PreparedPayload } from "../lib/sim/state";

async function main() {
  requireEmulator("run a sim wake");
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "REFUSING to run a sim wake: FIREBASE_AUTH_EMULATOR_HOST is not set. " +
        "The wake runner mints its committer token against the Auth emulator only."
    );
  }
  // Touch the Admin bootstrap so emulator configuration errors surface
  // here, not inside the token mint.
  void getSimDb();
  if (getAdminApps().length === 0) initializeAdminApp({ projectId: SIM_PROJECT_ID });

  const args = process.argv.slice(2);
  const nowIdx = args.indexOf("--now");
  const now = nowIdx >= 0 ? args[nowIdx + 1] : new Date().toISOString();
  const preparedIdx = args.indexOf("--prepared");
  let preparedPayloads: Map<string, PreparedPayload> | undefined;
  if (preparedIdx >= 0) {
    const parsed = JSON.parse(readFileSync(args[preparedIdx + 1], "utf8")) as Record<
      string,
      PreparedPayload
    >;
    preparedPayloads = new Map(Object.entries(parsed));
  }

  const token = await getAuth().createCustomToken("fabric-service", {
    fabric: true,
    fabricRole: "committer",
  });
  const app = initializeApp(
    { projectId: SIM_PROJECT_ID, apiKey: "emulator" },
    "sim-wake-runner"
  );
  const auth = getClientAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, {
    disableWarnings: true,
  });
  await signInWithCustomToken(auth, token);
  const db = getFirestore(app);
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST as string).split(":");
  connectFirestoreEmulator(db, host, Number(port));

  const summary = await runWake(
    { fabricDb: db, committerDb: db, baselineRegistry: PRODUCTION_BASELINE_REGISTRY },
    { now, cycleId: `cycle-${now}`, preparedPayloads }
  );
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
