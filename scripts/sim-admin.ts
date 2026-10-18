/**
 * Shared Admin SDK bootstrap for the sim ops scripts.
 *
 * Emulator-first: when FIRESTORE_EMULATOR_HOST is set, the Admin SDK talks
 * to the emulator with no credentials — that is the only configuration
 * Phase 1 exercises. Without an emulator host, the genesis script may
 * still construct an app (its own production guard decides whether the
 * run proceeds); the ensure/verify scripts refuse outright.
 */

import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const SIM_PROJECT_ID = "cowboycityrealm";

export function getSimDb(): Firestore {
  let app: App;
  if (getApps().length > 0) {
    app = getApps()[0];
  } else if (process.env.FIRESTORE_EMULATOR_HOST) {
    app = initializeApp({ projectId: SIM_PROJECT_ID });
  } else {
    // Real-project path: default application credentials. Constructing the
    // app performs no network I/O; the genesis guard runs before any use.
    app = initializeApp({ projectId: SIM_PROJECT_ID });
  }
  return getFirestore(app);
}

export function requireEmulator(action: string): void {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      `REFUSING to ${action}: FIRESTORE_EMULATOR_HOST is not set. ` +
        "Phase 1 exercises sim procedures against the emulator only " +
        "(Phase 1 brief §8 hard list)."
    );
  }
}
