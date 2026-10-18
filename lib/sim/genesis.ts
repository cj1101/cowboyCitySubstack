/**
 * Genesis procedure (Phase 1 brief §2) — scripted, idempotent, and
 * emulator-guarded. Creates `sim_counters/log`, `sim_world/current`, and
 * the genesis Log entry in one transaction, then verifies its own work.
 *
 * Genesis is NOT a Resolution Event and writes no `sim_resolutions`
 * manifest (brief §1.5). It is the one pre-resolver commit.
 *
 * PRODUCTION GUARD: genesis refuses to run unless FIRESTORE_EMULATOR_HOST
 * is set (the emulator), OR both an explicit `allowProduction` option AND
 * the `SIM_GENESIS_ALLOW_PRODUCTION=1` environment variable are present.
 * Phase 1 never passes them — production genesis is a separate, explicit
 * Koda/CJ operations decision (brief §8 hard list).
 */

import type { Firestore } from "firebase-admin/firestore";
import { sha256Hex } from "./canonical";
import {
  BASELINE_HASH,
  buildGenesisLogEntry,
  buildSimCountersDoc,
  buildSimWorldDoc,
  computeLogEntryHash,
  logEntryDocId,
} from "./template";

export interface GenesisOptions {
  /** Must be true AND SIM_GENESIS_ALLOW_PRODUCTION=1 set to run off-emulator. */
  allowProduction?: boolean;
  /** Injectable clock for tests; defaults to the current time. */
  now?: Date;
}

export interface GenesisResult {
  status: "created" | "already-present";
  baselineHash: string;
  entryHash: string | null;
}

export function assertGenesisEnvironment(opts: GenesisOptions): void {
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  const flag = opts.allowProduction === true;
  const env = process.env.SIM_GENESIS_ALLOW_PRODUCTION === "1";
  if (flag && env) return;
  throw new Error(
    "REFUSING to run genesis: FIRESTORE_EMULATOR_HOST is not set, and " +
      "production genesis requires both the explicit allowProduction " +
      "option and SIM_GENESIS_ALLOW_PRODUCTION=1. Phase 1 runs genesis " +
      "against the emulator only (Phase 1 brief §2/§8)."
  );
}

/**
 * Canonical projection of a Firestore document for hashing: Dates and
 * Firestore Timestamps become ISO strings, everything else passes through
 * (canonicalJson sorts keys and drops undefined members).
 */
export function projectFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { toDate?: unknown }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(projectFirestoreValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = projectFirestoreValue(member);
    }
    return out;
  }
  return value;
}

const SIM_COLLECTIONS_TO_SWEEP = [
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

export async function runGenesis(
  db: Firestore,
  opts: GenesisOptions = {}
): Promise<GenesisResult> {
  assertGenesisEnvironment(opts);

  const counterRef = db.collection("sim_counters").doc("log");
  const existing = await counterRef.get();
  if (existing.exists) {
    // Idempotency = refusal, not repair (brief §2 step 1).
    return { status: "already-present", baselineHash: BASELINE_HASH, entryHash: null };
  }

  const now = opts.now ?? new Date();
  const worldDoc = buildSimWorldDoc(now);
  const entryCore = buildGenesisLogEntry(now);
  const entryHash = computeLogEntryHash(entryCore);
  const counterDoc = buildSimCountersDoc(entryHash, now);

  // writeSetDigest / stateHeadsAfter are computed over the canonical
  // projections of exactly the two created docs (brief §2 step 4). They are
  // attached to the entry but are not part of the entryHash input (spec
  // §3.4), which is what breaks the counter<->entry circularity.
  const writeSet = {
    "sim_world/current": worldDoc,
    "sim_counters/log": counterDoc,
  };
  const entry = {
    ...entryCore,
    entryHash,
    writeSetDigest: sha256Hex(writeSet),
    stateHeadsAfter: [
      {
        path: "sim_world/current",
        afterHash: sha256Hex(worldDoc),
        stateVersion: null,
      },
      {
        path: "sim_counters/log",
        afterHash: sha256Hex(counterDoc),
        stateVersion: null,
      },
    ],
  };

  const entryRef = db.collection("sim_log_entries").doc(logEntryDocId(1));
  const worldRef = db.collection("sim_world").doc("current");

  await db.runTransaction(async (tx) => {
    const inside = await tx.get(counterRef);
    if (inside.exists) {
      throw new Error("genesis raced: sim_counters/log appeared during setup");
    }
    tx.set(counterRef, counterDoc);
    tx.set(worldRef, worldDoc);
    tx.set(entryRef, entry);
  });

  // Post-commit verification (brief §2 step 5): fail loudly on any mismatch.
  const [worldSnap, counterSnap, entrySnap] = await Promise.all([
    worldRef.get(),
    counterRef.get(),
    entryRef.get(),
  ]);
  if (!worldSnap.exists || !counterSnap.exists || !entrySnap.exists) {
    throw new Error("genesis verification: a genesis document is missing after commit");
  }
  const storedEntry = entrySnap.data() as Record<string, unknown>;
  const recomputed = computeLogEntryHash(storedEntry);
  if (recomputed !== storedEntry.entryHash) {
    throw new Error(
      `genesis verification: entryHash mismatch (stored ${String(storedEntry.entryHash)}, recomputed ${recomputed})`
    );
  }
  const worldData = worldSnap.data() as Record<string, unknown>;
  if (worldData.evenStartTemplateHash !== BASELINE_HASH) {
    throw new Error("genesis verification: sim_world evenStartTemplateHash != baselineHash");
  }
  const recomputedWriteSet = sha256Hex({
    "sim_world/current": projectFirestoreValue(worldSnap.data()),
    "sim_counters/log": projectFirestoreValue(counterSnap.data()),
  });
  if (recomputedWriteSet !== storedEntry.writeSetDigest) {
    throw new Error("genesis verification: writeSetDigest does not recompute from stored docs");
  }
  for (const name of SIM_COLLECTIONS_TO_SWEEP) {
    const snap = await db.collection(name).get();
    const expected =
      name === "sim_world" || name === "sim_counters" || name === "sim_log_entries"
        ? 1
        : 0;
    if (snap.size !== expected) {
      throw new Error(
        `genesis verification: expected ${expected} doc(s) in ${name}, found ${snap.size}`
      );
    }
  }

  return { status: "created", baselineHash: BASELINE_HASH, entryHash };
}
