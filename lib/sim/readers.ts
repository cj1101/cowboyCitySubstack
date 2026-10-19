/**
 * Firestore readers for the sim engine (Phase 4 Step 0, F-01) — the
 * store-facing half of the read contract. The resolver stays pure: it
 * declares WHAT to read (doc paths + collection query specs, via
 * `collectActionReadPlan`); these helpers execute those reads against a
 * caller's Firestore instance, in the caller's identity. The
 * dispatcher uses them for preview/commit snapshots; the committer
 * uses `buildFirestoreQuery` to re-execute a plan's queries inside its
 * transaction, so a query read is re-verified exactly like a doc read.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fbLimit,
  orderBy as fbOrderBy,
  query as fbQuery,
  where as fbWhere,
  type Firestore,
  type Query,
} from "firebase/firestore";
import type { CollectionQuerySpec } from "./state";
import type { DocReader, QueryReader } from "./resolver";

export function firestoreReader(db: Firestore): DocReader {
  return {
    async get(path: string) {
      const segments = path.split("/");
      const snap = await getDoc(doc(db, segments[0], ...segments.slice(1)));
      return snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    },
  };
}

/** Build the Firestore query a spec denotes. One builder for every
 * executor (dispatcher reads, committer in-transaction re-execution,
 * tests) so a spec means the same read everywhere. */
export function buildFirestoreQuery(db: Firestore, spec: CollectionQuerySpec): Query {
  const segments = spec.collectionPath.split("/");
  const constraints = [
    ...spec.filters.map((f) => fbWhere(f.field, f.op, f.value)),
    ...(spec.orderBy ?? []).map((o) => fbOrderBy(o.field, o.direction)),
    ...(typeof spec.limit === "number" ? [fbLimit(spec.limit)] : []),
  ];
  return fbQuery(collection(db, segments[0], ...segments.slice(1)), ...constraints);
}

export function firestoreQueryReader(db: Firestore): QueryReader {
  return {
    async query(spec: CollectionQuerySpec) {
      const snap = await getDocs(buildFirestoreQuery(db, spec));
      return snap.docs.map((d) => ({
        path: d.ref.path,
        doc: d.data() as Record<string, unknown>,
      }));
    },
  };
}
