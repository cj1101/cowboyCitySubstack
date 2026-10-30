/**
 * Genesis pristine-sweep regression suite — the Step 2 smoke doc.
 *
 * Emulator venue (inside `npm run test:sim`'s emulators:exec segment,
 * CI's "Sim core tests (non-required)" job — the sandbox emulator is
 * the known loopback defect, same posture as the other sim suites).
 *
 * The defect (production log §3, 2026-10-30): genesis's post-commit
 * pristine sweep expected `sim_fabric_status` empty, but runbook
 * §2.4 check 4 designates `sim_fabric_status/current` as the fabric
 * smoke target and the Step 2 smoke writes it BEFORE Step 3 genesis
 * runs. Production genesis committed a correct world and then exited
 * 1 on the sweep. The fix tolerates exactly the designated smoke doc
 * (shape-exact — see `isStep2SmokeStatusDoc` in lib/sim/genesis.ts,
 * pinned pure in tests/genesis-sweep-harness.ts); this suite proves
 * the behavior end-to-end through `runGenesis`:
 *
 *   G1  pristine world → genesis created (the original path).
 *   G2  the sanctioned smoke doc pre-seeded → genesis created, and
 *       the smoke doc is left exactly as the smoke wrote it.
 *   G3  an unsanctioned doc at `current` → genesis throws the sweep
 *       error naming the collection. (The throw is POST-commit by
 *       design — genesis verifies its own committed work and fails
 *       loudly; that is the production-observed semantics, pinned
 *       here so nobody mistakes the throw for "no world".)
 *   G4  the sanctioned doc PLUS a second, smoke-shaped doc at
 *       another id → genesis throws (tolerance is for the designated
 *       doc only, never a collection pass).
 *   G5  a smoke-shaped doc whose `rulesDeployedFrom` is not a commit
 *       id → genesis throws.
 */

import { getApps, initializeApp } from "firebase-admin/app";
import {
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from "firebase-admin/firestore";
import { runGenesis } from "../lib/sim/genesis";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error(
    "genesis-sweep suite requires FIRESTORE_EMULATOR_HOST — run via `npm run test:sim`"
  );
}

const PROJECT_ID = "cowboycityrealm";
const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({ projectId: PROJECT_ID }, "genesis-sweep");
const adminDb: AdminFirestore = getAdminFirestore(app);

const SIM_COLLECTIONS = [
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
];

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function wipe(db: AdminFirestore): Promise<void> {
  for (const name of SIM_COLLECTIONS) {
    const snap = await db.collection(name).get();
    for (const docSnap of snap.docs) await docSnap.ref.delete();
  }
}

async function genesisError(db: AdminFirestore): Promise<Error | null> {
  try {
    await runGenesis(db, {});
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

// The exact document the Step 2 smoke writes (production log §2.3
// check 4; ops-tools/smoke-step2.mjs): doc id `current`, two fields,
// rulesDeployedFrom = the deployed tree's commit id.
const SMOKE_DOC = { source: "step2-smoke", rulesDeployedFrom: "c8cff80" };

async function main(): Promise<void> {
  console.log("G1 — pristine world still verifies clean");
  await wipe(adminDb);
  {
    const result = await runGenesis(adminDb, {});
    check("pristine: genesis created", result.status === "created");
  }

  console.log("G2 — the designated Step 2 smoke doc is tolerated");
  await wipe(adminDb);
  await adminDb.collection("sim_fabric_status").doc("current").set(SMOKE_DOC);
  {
    const result = await runGenesis(adminDb, {});
    check("smoke doc present: genesis created", result.status === "created");
    const after = (
      await adminDb.collection("sim_fabric_status").doc("current").get()
    ).data();
    check(
      "genesis leaves the smoke doc exactly as written",
      after?.source === "step2-smoke" &&
        after?.rulesDeployedFrom === "c8cff80" &&
        Object.keys(after ?? {}).length === 2
    );
  }

  console.log("G3 — an unsanctioned doc still fails the sweep");
  await wipe(adminDb);
  await adminDb
    .collection("sim_fabric_status")
    .doc("current")
    .set({ note: "spoofed status" });
  {
    const error = await genesisError(adminDb);
    check("unsanctioned doc: genesis throws", error !== null);
    check(
      "the error names sim_fabric_status",
      (error?.message ?? "").includes("sim_fabric_status"),
      error?.message
    );
    const counter = await adminDb.collection("sim_counters").doc("log").get();
    check(
      "the throw is post-commit (world stands; fail-loud is the design)",
      counter.exists
    );
  }

  console.log("G4 — tolerance never extends past the designated doc");
  await wipe(adminDb);
  await adminDb.collection("sim_fabric_status").doc("current").set(SMOKE_DOC);
  await adminDb.collection("sim_fabric_status").doc("extra").set(SMOKE_DOC);
  {
    const error = await genesisError(adminDb);
    check("a second doc (even smoke-shaped): genesis throws", error !== null);
    check(
      "the error names the unexpected doc",
      (error?.message ?? "").includes("extra"),
      error?.message
    );
  }

  console.log("G5 — a smoke-shaped doc with a non-commit origin fails");
  await wipe(adminDb);
  await adminDb
    .collection("sim_fabric_status")
    .doc("current")
    .set({ source: "step2-smoke", rulesDeployedFrom: "not-a-commit" });
  {
    const error = await genesisError(adminDb);
    check("non-commit rulesDeployedFrom: genesis throws", error !== null);
    check(
      "the error names sim_fabric_status",
      (error?.message ?? "").includes("sim_fabric_status"),
      error?.message
    );
  }

  if (failures > 0) {
    console.log(`\nGenesis sweep regression suite FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nGenesis sweep regression suite passed (G1–G5)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
