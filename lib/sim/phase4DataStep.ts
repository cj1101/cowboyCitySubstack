/**
 * Phase 4 Module 0 data step (brief §3.6) — the pool stamp + posture
 * backfill. One run, two targets, nothing else:
 *
 *  - every `sim_stat_allocations` doc whose `pointBudget` is not already
 *    Vera's locked 400 is stamped `pointBudget: 400`;
 *  - every `sim_cities` doc missing `defensePosture` gains the honest
 *    unbuilt default `{ prepared: false, setAtSeq: null,
 *    treasuryPaidRubars: null }` (brief §1.3). A present posture is live
 *    state and is never overwritten.
 *
 * Properties the brief requires, and where each is enforced:
 *  - **Idempotent / re-runnable:** the planner emits a write only where
 *    the target is unstamped; a second run plans zero writes (asserted
 *    in tests/play-core.test.ts).
 *  - **No other field touched:** each write is a single-field update,
 *    and the post-step assertion pass byte-compares every doc outside
 *    its target field (canonical hash over the stripped doc) against
 *    its pre-step image — a mismatch throws and the run reports
 *    failure, never success.
 *  - **Emulator-only in Phase 4:** the script wrapper refuses to run
 *    without FIRESTORE_EMULATOR_HOST; production execution belongs to
 *    the production chain (P2-K15), exactly as brief §3.6 states.
 *  - **No Log entries:** §3.6 defines the step as stamp + assertion
 *    pass. It backfills pre-existing docs; it is not a Resolution Event
 *    and writes nothing to the Log (genesis discipline — the step's own
 *    verification pass is its record).
 *
 * New cities never need this step: the template builders already stamp
 * both targets at creation (asserted in tests/play-core.test.ts). The
 * step is a backfill, not a permanent second path.
 */

import type { Firestore } from "firebase-admin/firestore";
import { sha256Hex } from "./canonical";
import { INITIAL_POINT_BUDGET } from "./template";

export const PHASE4_DATA_STEP_ID = "phase4-module0-data-step-v1";

/** The brief §1.3 default, in exactly the builder's shape. */
export const DEFENSE_POSTURE_DEFAULT = {
  prepared: false,
  setAtSeq: null,
  treasuryPaidRubars: null,
} as const;

export function defaultDefensePosture(): {
  prepared: boolean;
  setAtSeq: number | null;
  treasuryPaidRubars: number | null;
} {
  return { ...DEFENSE_POSTURE_DEFAULT };
}

/** Structural check used by the assertion pass: the three keys, typed. */
export function isDefensePostureShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.prepared === "boolean" &&
    (v.setAtSeq === null || typeof v.setAtSeq === "number") &&
    (v.treasuryPaidRubars === null || typeof v.treasuryPaidRubars === "number")
  );
}

export interface DataStepDoc {
  id: string;
  data: Record<string, unknown>;
}

export interface DataStepWrite {
  collection: "sim_stat_allocations" | "sim_cities";
  docId: string;
  field: "pointBudget" | "defensePosture";
  /** The pre-step value (`null` when the field was absent). */
  before: unknown;
  after: unknown;
}

/**
 * Pure planner: given the current docs, the exact write set. Anything
 * already stamped produces no write — that is the idempotency contract.
 */
export function planPhase4DataStep(input: {
  allocations: DataStepDoc[];
  cities: DataStepDoc[];
}): DataStepWrite[] {
  const writes: DataStepWrite[] = [];
  for (const doc of input.allocations) {
    if (doc.data.pointBudget !== INITIAL_POINT_BUDGET) {
      writes.push({
        collection: "sim_stat_allocations",
        docId: doc.id,
        field: "pointBudget",
        before: doc.data.pointBudget ?? null,
        after: INITIAL_POINT_BUDGET,
      });
    }
  }
  for (const doc of input.cities) {
    if (doc.data.defensePosture === undefined) {
      writes.push({
        collection: "sim_cities",
        docId: doc.id,
        field: "defensePosture",
        before: null,
        after: defaultDefensePosture(),
      });
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Byte-compare support. Admin SDK values (Timestamps) are normalized to
// the canonical layer's conventions (timestamps as ISO strings) before
// hashing, so a pre-image and a post-image of the same doc hash equal
// iff nothing outside the stripped field changed — the §3.6
// "byte-compare outside the two targets" check.
// ---------------------------------------------------------------------------

function normalizeForCompare(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForCompare);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const maybeTs = value as { toDate?: unknown };
    if (typeof maybeTs.toDate === "function") {
      return (maybeTs.toDate as () => Date).call(value).toISOString();
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) out[key] = normalizeForCompare(obj[key]);
    return out;
  }
  return value;
}

/** Canonical hash of a doc with one field removed. */
export function dataStepRemainderHash(
  data: Record<string, unknown>,
  fieldToStrip: string
): string {
  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    if (key !== fieldToStrip) stripped[key] = data[key];
  }
  return sha256Hex(normalizeForCompare(stripped));
}

function fieldValueHash(value: unknown): string {
  return sha256Hex(normalizeForCompare(value ?? null));
}

export interface Phase4DataStepReport {
  step: string;
  allocationsScanned: number;
  allocationsStamped: number;
  citiesScanned: number;
  citiesPostured: number;
  writesApplied: number;
  verified: boolean;
}

/**
 * The step itself, against an Admin SDK Firestore. Applies the planned
 * single-field updates, then runs the §3.6 assertion pass and throws on
 * any failure (the caller reports failure; a partially-verified world is
 * never reported as stamped).
 */
export async function applyPhase4DataStep(
  db: Firestore
): Promise<Phase4DataStepReport> {
  const allocSnap = await db.collection("sim_stat_allocations").get();
  const citySnap = await db.collection("sim_cities").get();
  const allocations: DataStepDoc[] = allocSnap.docs.map((d) => ({
    id: d.id,
    data: d.data() as Record<string, unknown>,
  }));
  const cities: DataStepDoc[] = citySnap.docs.map((d) => ({
    id: d.id,
    data: d.data() as Record<string, unknown>,
  }));

  // Pre-images for the byte-compare: remainder hashes (target stripped)
  // and full field hashes for docs that will be written.
  const remainderBefore = new Map<string, string>();
  for (const doc of allocations) {
    remainderBefore.set(
      `sim_stat_allocations/${doc.id}`,
      dataStepRemainderHash(doc.data, "pointBudget")
    );
  }
  for (const doc of cities) {
    remainderBefore.set(
      `sim_cities/${doc.id}`,
      dataStepRemainderHash(doc.data, "defensePosture")
    );
  }

  const writes = planPhase4DataStep({ allocations, cities });
  for (const write of writes) {
    await db
      .collection(write.collection)
      .doc(write.docId)
      .update({ [write.field]: write.after });
  }

  // ---- Assertion pass -------------------------------------------------
  const allocAfter = await db.collection("sim_stat_allocations").get();
  const cityAfter = await db.collection("sim_cities").get();
  if (allocAfter.size !== allocations.length || cityAfter.size !== cities.length) {
    throw new Error(
      "phase4 data step verification: collection sizes changed during the step"
    );
  }
  const writtenKeys = new Set(
    writes.map((w) => `${w.collection}/${w.docId}/${w.field}`)
  );
  for (const d of allocAfter.docs) {
    const data = d.data() as Record<string, unknown>;
    if (data.pointBudget !== INITIAL_POINT_BUDGET) {
      throw new Error(
        `phase4 data step verification: sim_stat_allocations/${d.id} pointBudget is ${String(data.pointBudget)}, expected ${INITIAL_POINT_BUDGET}`
      );
    }
    if (
      dataStepRemainderHash(data, "pointBudget") !==
      remainderBefore.get(`sim_stat_allocations/${d.id}`)
    ) {
      throw new Error(
        `phase4 data step verification: sim_stat_allocations/${d.id} changed outside pointBudget`
      );
    }
    const key = `sim_stat_allocations/${d.id}/pointBudget`;
    if (writtenKeys.has(key) && fieldValueHash(data.pointBudget) !== fieldValueHash(INITIAL_POINT_BUDGET)) {
      throw new Error(
        `phase4 data step verification: sim_stat_allocations/${d.id} stamp did not land`
      );
    }
  }
  for (const d of cityAfter.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!isDefensePostureShape(data.defensePosture)) {
      throw new Error(
        `phase4 data step verification: sim_cities/${d.id} defensePosture missing or malformed`
      );
    }
    if (
      dataStepRemainderHash(data, "defensePosture") !==
      remainderBefore.get(`sim_cities/${d.id}`)
    ) {
      throw new Error(
        `phase4 data step verification: sim_cities/${d.id} changed outside defensePosture`
      );
    }
  }

  return {
    step: PHASE4_DATA_STEP_ID,
    allocationsScanned: allocations.length,
    allocationsStamped: writes.filter((w) => w.collection === "sim_stat_allocations").length,
    citiesScanned: cities.length,
    citiesPostured: writes.filter((w) => w.collection === "sim_cities").length,
    writesApplied: writes.length,
    verified: true,
  };
}
