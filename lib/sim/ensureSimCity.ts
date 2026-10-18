/**
 * Lazy creation (Phase 1 brief §3) — fabric-side function.
 *
 * Creates a claimed city's `sim_cities` doc + `sim_stat_allocations`
 * control doc from the even-start template, in one transaction. Creates
 * NOTHING else: no Log entry (decision L-1/K-4 — a city's first Log entry
 * is its owner's Phase 4 allocation resolution), no situations, no
 * subcollection docs, no seed-mapping record.
 *
 * An unowned faction aborts with `unclaimed` and creates nothing — the
 * strong inactivity the plan requires (no sim doc, no Log presence).
 * A second call for an already-created city is a no-op.
 *
 * In Phase 1 this is invoked manually, per fixture faction, by the
 * verification harness against the emulator. The ongoing trigger (fabric
 * observing ownership changes once the Phase 4 runner exists) is Phase 4
 * scope; nothing here polls anything.
 */

import type { Firestore } from "firebase-admin/firestore";
import { buildSimCityDoc, buildSimStatAllocationsDoc } from "./template";

export type EnsureSimCityResult =
  | { status: "created"; factionId: string }
  | { status: "already-exists"; factionId: string }
  | { status: "no_faction"; factionId: string }
  | { status: "unclaimed"; factionId: string };

export async function ensureSimCity(
  db: Firestore,
  factionId: string,
  opts: { now?: Date } = {}
): Promise<EnsureSimCityResult> {
  const now = opts.now ?? new Date();
  const factionRef = db.collection("factions").doc(factionId);
  const cityRef = db.collection("sim_cities").doc(factionId);
  const allocationsRef = db.collection("sim_stat_allocations").doc(factionId);

  const factionSnap = await factionRef.get();
  if (!factionSnap.exists) return { status: "no_faction", factionId };
  const faction = factionSnap.data() as Record<string, unknown>;

  // Ownership evidence, in the existing rules helpers' proof order:
  // a faction_members owner row first, factions.ownerUids as the fallback.
  const memberOwners = await db
    .collection("faction_members")
    .where("factionId", "==", factionId)
    .where("role", "==", "owner")
    .limit(1)
    .get();
  const ownerUids = Array.isArray(faction.ownerUids)
    ? (faction.ownerUids as unknown[])
    : [];
  if (memberOwners.empty && ownerUids.length === 0) {
    return { status: "unclaimed", factionId };
  }

  const existing = await cityRef.get();
  if (existing.exists) return { status: "already-exists", factionId };

  // Provenance only: the Log head at creation, recorded WITHOUT consuming
  // a seq (brief §3 step 3). If genesis has not run, there is no head;
  // record 0 — creation order still does not mint Log entries.
  const counterSnap = await db.collection("sim_counters").doc("log").get();
  const createdAtSeq =
    counterSnap.exists && typeof counterSnap.data()?.lastSeq === "number"
      ? (counterSnap.data()?.lastSeq as number)
      : 0;

  const worldSnap = await db.collection("sim_world").doc("current").get();
  const sharedCityId =
    worldSnap.exists && typeof worldSnap.data()?.sharedCityId === "string"
      ? (worldSnap.data()?.sharedCityId as string)
      : null;

  const cityDoc = buildSimCityDoc({
    factionId,
    faction: {
      slug: typeof faction.slug === "string" ? faction.slug : factionId,
      name: typeof faction.name === "string" ? faction.name : factionId,
    },
    // The world-seed crosswalk is optional provenance (A.2): Phase 1 has
    // no mapping source to consult, so this is null unless a future caller
    // supplies one. Never a gate on city existence.
    seedCityId: null,
    sharedCityId,
    createdAtSeq,
    now,
  });
  const allocationsDoc = buildSimStatAllocationsDoc(factionId, now);

  const outcome = await db.runTransaction(async (tx) => {
    const inside = await tx.get(cityRef);
    if (inside.exists) return "already-exists" as const;
    tx.set(cityRef, cityDoc);
    tx.set(allocationsRef, allocationsDoc);
    return "created" as const;
  });

  return { status: outcome, factionId };
}
