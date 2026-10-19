/**
 * The fabric-side snapshot refresh adapter (Phase 3 brief §3.2 situation
 * 1) — the wake-terminal writer for `sim_dashboard_snapshots/current`.
 *
 * The projection itself is pure (`lib/sim/snapshot.ts`); this module is
 * the thin I/O shell the dispatcher calls: assemble a SnapshotSource over
 * the committer identity, fetch inputs, project, and write the doc in
 * its own small transaction. The ops/recovery path
 * (scripts/sim-rebuild-snapshot.ts) implements the same SnapshotSource
 * interface over the Admin SDK — the two are interchangeable because the
 * projection is pure over its read set.
 *
 * Failure isolation (brief §3.2, final): this function NEVER throws. A
 * failed refresh leaves the wake's commits standing (they are already
 * durable), reports the failure, and leaves the snapshot stale — the
 * dashboard's freshness line and fallback reads (brief §3.3/§3.5) carry
 * the site until the next world-changing wake or an ops rebuild. A
 * failed refresh never fails a resolution.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  where,
  type Firestore,
} from "firebase/firestore";
import { projectFirestoreValue } from "./genesis";
import {
  fetchSnapshotInputs,
  projectSnapshot,
  type SnapshotSource,
} from "./snapshot";
import { logEntryDocId } from "./template";

function plain(data: Record<string, unknown>): Record<string, unknown> {
  return projectFirestoreValue(data) as Record<string, unknown>;
}

/** SnapshotSource over a client-SDK Firestore handle (committer identity). */
export function committerSnapshotSource(db: Firestore): SnapshotSource {
  return {
    async getWorld() {
      const snap = await getDoc(doc(db, "sim_world", "current"));
      return snap.exists() ? plain(snap.data()) : null;
    },
    async getCounters() {
      const snap = await getDoc(doc(db, "sim_counters", "log"));
      return snap.exists() ? plain(snap.data()) : null;
    },
    async listFactions() {
      const snap = await getDocs(collection(db, "factions"));
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async listSimCities() {
      const snap = await getDocs(collection(db, "sim_cities"));
      return snap.docs.map((d) => ({ id: d.id, data: plain(d.data()) }));
    },
    async getLogEntry(seq: number) {
      const snap = await getDoc(
        doc(db, "sim_log_entries", logEntryDocId(seq))
      );
      return snap.exists() ? plain(snap.data()) : null;
    },
    async listRecentEntries(limitN: number) {
      const snap = await getDocs(
        query(
          collection(db, "sim_log_entries"),
          orderBy("seq", "desc"),
          limit(limitN)
        )
      );
      return snap.docs.map((d) => plain(d.data()));
    },
    async getCityHeadlineEntry(factionId: string) {
      const snap = await getDocs(
        query(
          collection(db, "sim_log_entries"),
          where("cityIds", "array-contains", factionId),
          where("visibility", "==", "public"),
          orderBy("seq", "desc"),
          limit(1)
        )
      );
      return snap.empty ? null : plain(snap.docs[0].data());
    },
  };
}

/**
 * Run one wake-terminal snapshot refresh. Returns true when the snapshot
 * doc was (re)written, false when the refresh failed (failure-isolated:
 * the error is reported here and never propagates into the wake).
 */
export async function refreshSnapshotAfterWake(
  deps: { committerDb: Firestore },
  now: string
): Promise<boolean> {
  try {
    const inputs = await fetchSnapshotInputs(
      committerSnapshotSource(deps.committerDb)
    );
    const docData = projectSnapshot({ ...inputs, now: new Date(now) });
    const ref = doc(deps.committerDb, "sim_dashboard_snapshots", "current");
    // Its own small transaction (brief §3.2): the refresh is not part of
    // any resolution's commit and can never roll one back.
    await runTransaction(deps.committerDb, async (tx) => {
      tx.set(ref, docData);
    });
    return true;
  } catch (error) {
    console.error(
      "snapshot refresh failed after wake (commits stand; snapshot remains stale):",
      error
    );
    return false;
  }
}
