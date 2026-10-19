/**
 * Ops rebuild of the dashboard snapshot (Phase 3 brief §3.2 situation 2).
 *
 * Recomputes sim_dashboard_snapshots/current from standing state via the
 * pure projection in lib/sim/snapshot.ts and writes it. This is the
 * recovery path if the doc is deleted or corrupted, and the fixture path
 * in tests. It is a CACHE REPAIR, not a world event: it writes no Log
 * entry and touches no other collection. Ongoing play refreshes the
 * snapshot from the dispatcher's terminal step instead (integration
 * point documented in lib/sim/snapshot.ts).
 *
 * Usage:
 *   firebase emulators:exec --only firestore,auth --project cowboycityrealm \
 *     "tsx scripts/sim-rebuild-snapshot.ts"
 *
 * Emulator only — the script refuses unless BOTH emulator hosts are set
 * (Phase 3 brief §3.2). The Admin SDK is used directly here; nothing in
 * this script provisions a service user or touches production.
 */

import type { Firestore } from "firebase-admin/firestore";
import { projectFirestoreValue } from "../lib/sim/genesis";
import {
  fetchSnapshotInputs,
  projectSnapshot,
  type SnapshotSource,
} from "../lib/sim/snapshot";
import { logEntryDocId } from "../lib/sim/template";
import { getSimDb, requireEmulator } from "./sim-admin";

function plain(data: Record<string, unknown>): Record<string, unknown> {
  return projectFirestoreValue(data) as Record<string, unknown>;
}

function adminSnapshotSource(db: Firestore): SnapshotSource {
  return {
    async getWorld() {
      const snap = await db.collection("sim_world").doc("current").get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async getCounters() {
      const snap = await db.collection("sim_counters").doc("log").get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async listFactions() {
      const snap = await db.collection("factions").get();
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async listSimCities() {
      const snap = await db.collection("sim_cities").get();
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async getLogEntry(seq: number) {
      const snap = await db.collection("sim_log_entries").doc(logEntryDocId(seq)).get();
      return snap.exists ? plain(snap.data() ?? {}) : null;
    },
    async listRecentEntries(limit: number) {
      const snap = await db
        .collection("sim_log_entries")
        .orderBy("seq", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => plain(d.data()));
    },
    async getCityHeadlineEntry(factionId: string) {
      const snap = await db
        .collection("sim_log_entries")
        .where("cityIds", "array-contains", factionId)
        .where("visibility", "==", "public")
        .orderBy("seq", "desc")
        .limit(1)
        .get();
      return snap.empty ? null : plain(snap.docs[0].data());
    },
  };
}

async function main() {
  requireEmulator("rebuild the dashboard snapshot");
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      "REFUSING to rebuild the dashboard snapshot: FIREBASE_AUTH_EMULATOR_HOST " +
        "is not set. Phase 3 exercises sim procedures against the emulators only " +
        "(Phase 3 brief §3.2/§15)."
    );
  }
  const db = getSimDb();
  const inputs = await fetchSnapshotInputs(adminSnapshotSource(db));
  const docData = projectSnapshot({ ...inputs, now: new Date() });
  await db.collection("sim_dashboard_snapshots").doc("current").set(docData);
  console.log(
    `snapshot rebuilt: asOfSeq ${String(docData.asOfSeq)}, ` +
      `${(docData.cityCards as unknown[]).length} city cards, ` +
      `${(docData.latestSummaries as unknown[]).length} summaries`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
