/**
 * Genesis procedure (Phase 1 brief §2) — scripted, idempotent, and
 * emulator-guarded. Creates `sim_counters/log`, `sim_world/current`, and
 * the genesis Log entry in one transaction, then verifies its own work.
 *
 * Genesis is NOT a Resolution Event and writes no `sim_resolutions`
 * manifest (brief §1.5). It is the one pre-resolver commit.
 *
 * Baseline stamp (runbook §3.3, go-live fix B-1): if the Baseline
 * registry carries a ratified version, genesis stamps its version +
 * docHash on the world doc at creation and asserts the stamp
 * post-commit; if none is ratified, no stamp fields are written.
 *
 * Pristine sweep vs the Step 2 smoke doc: the post-commit sweep
 * tolerates exactly one pre-genesis document — the runbook §2.4
 * check-4 smoke record at `sim_fabric_status/current`, identified by
 * its exact sanctioned shape (see isStep2SmokeStatusDoc). The smoke
 * runs BEFORE genesis by runbook design, so the Phase 1-era "every
 * swept collection empty" expectation could never hold on a correctly
 * sequenced chain: the 2026-10-30 production genesis committed a
 * correct world and then failed this sweep on that doc (production
 * log §3). Any other pre-genesis state still fails the sweep.
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
import {
  PRODUCTION_BASELINE_REGISTRY,
  ratifiedBaselineForGenesis,
  type BaselineRegistry,
} from "./baseline/registry";

export interface GenesisOptions {
  /** Must be true AND SIM_GENESIS_ALLOW_PRODUCTION=1 set to run off-emulator. */
  allowProduction?: boolean;
  /** Injectable clock for tests; defaults to the current time. */
  now?: Date;
  /**
   * The Baseline registry genesis stamps from (runbook §3.3). Defaults
   * to the production registry; injectable so the unratified case is
   * exercisable in tests.
   */
  baselineRegistry?: BaselineRegistry;
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

/** The `source` tag the runbook §2.4 smoke writes on its status doc. */
export const STEP2_SMOKE_STATUS_SOURCE = "step2-smoke";

/**
 * The one pre-genesis document the pristine sweep tolerates: the
 * Step 2 §2.4 check-4 smoke record. The runbook designates
 * `sim_fabric_status/current` as the fabric smoke target — the
 * committer identity writes it during Step 2, BEFORE Step 3 genesis
 * runs — so a correctly sequenced chain always has it in place when
 * the sweep executes. Only the fabric committer can write the
 * collection at all (the landed rules grant `sim_fabric_status`
 * writes to `isFabricService()`), and the smoke's content is fully
 * determined by the runbook procedure: `source: "step2-smoke"` plus
 * `rulesDeployedFrom` carrying the deploying tree's commit id.
 *
 * The tolerance is shape-exact, NOT a collection exemption: the doc
 * must sit at id `current` and carry EXACTLY those two fields, with
 * `rulesDeployedFrom` a git commit id (hex, short or full). Any other
 * doc in the collection — and any deviation in this doc's shape —
 * fails the sweep exactly as before. If the runbook's smoke shape
 * ever changes, this predicate changes in the same PR, deliberately.
 */
export function isStep2SmokeStatusDoc(
  docId: string,
  data: Record<string, unknown>
): boolean {
  if (docId !== "current") return false;
  if (Object.keys(data).length !== 2) return false;
  if (data.source !== STEP2_SMOKE_STATUS_SOURCE) return false;
  const deployedFrom = data.rulesDeployedFrom;
  return (
    typeof deployedFrom === "string" && /^[0-9a-f]{7,40}$/.test(deployedFrom)
  );
}

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
  // The ratified-Baseline stamp (runbook §3.3; go-live blocker B-1):
  // when the registry carries a ratified version, genesis stamps its
  // version + docHash on sim_world/current at creation — the stamp is
  // what later makes the version citable from the genesis seq via
  // projectBaselineStamp. When nothing is ratified, NO stamp fields
  // are written at all: the world doc is exactly the pre-stamp shape,
  // the resolver keeps failing closed, and the projection can only
  // arrive later via a logged Resolution Event (never a script).
  const stampVersion = ratifiedBaselineForGenesis(
    opts.baselineRegistry ?? PRODUCTION_BASELINE_REGISTRY
  );
  const worldDoc = {
    ...buildSimWorldDoc(now),
    ...(stampVersion
      ? {
          baselineVersion: stampVersion.version,
          baselineDocHash: stampVersion.docHash,
        }
      : {}),
  };
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
  // Post-commit Baseline-stamp assertion (B-1 fix item 3): when the
  // registry carries a ratified version, the stored world doc must
  // carry its stamp verbatim; in the unratified case it must carry no
  // stamp fields at all. A silent omission here is the failure this
  // fix exists to prevent — genesis fails loudly instead.
  if (stampVersion) {
    if (
      worldData.baselineVersion !== stampVersion.version ||
      worldData.baselineDocHash !== stampVersion.docHash
    ) {
      throw new Error(
        `genesis verification: Baseline stamp mismatch (stored version ${String(worldData.baselineVersion)}, hash ${String(worldData.baselineDocHash)}; registry ratified ${stampVersion.version} / ${stampVersion.docHash})`
      );
    }
  } else if (
    worldData.baselineVersion !== undefined ||
    worldData.baselineDocHash !== undefined
  ) {
    throw new Error(
      "genesis verification: world doc carries a Baseline stamp but the registry has no ratified version"
    );
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
    if (name === "sim_fabric_status") {
      // The designated Step 2 smoke doc (isStep2SmokeStatusDoc) is
      // expected pre-genesis state, not contamination — genesis never
      // writes this collection, so anything in it pre-dates the run.
      // Tolerate exactly that doc; fail on anything else.
      const unexpected = snap.docs.filter(
        (docSnap) =>
          !isStep2SmokeStatusDoc(
            docSnap.id,
            docSnap.data() as Record<string, unknown>
          )
      );
      if (unexpected.length > 0) {
        throw new Error(
          `genesis verification: expected 0 doc(s) in ${name} besides the designated Step 2 smoke doc, found unexpected doc(s): ${unexpected
            .map((docSnap) => docSnap.id)
            .join(", ")}`
        );
      }
      continue;
    }
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
