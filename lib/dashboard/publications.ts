/**
 * City-sheet published-claims selector (Phase 3 brief §7.2) over
 * sim_publications (Phase 1 collection + rules: version docs are
 * create-only; supersede/retract are NEW version docs in a chain linked
 * by supersedesPublicationId).
 *
 * Tier discipline (brief §7.1, CJ §7.4/§7.5): this selector returns
 * claims AS claims. Nothing here computes, merges, or hints at a
 * verified value, and no consumer may render these rows in a verified
 * figure's column. The platform asserts provenance only — never a truth
 * verdict.
 */

import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  type Firestore,
} from "firebase/firestore";

export interface PublicationDoc {
  id: string;
  cityId: string;
  businessId: string | null;
  publisherUid: string;
  version: number;
  supersedesPublicationId: string | null;
  status: string; // "published" | "superseded" | "retracted" (as recorded)
  publishedAtSeq: number;
  claims: unknown[];
  visibility: string;
}

export interface ClaimChain {
  /** The chain's current version doc (the one nothing supersedes). */
  current: PublicationDoc;
  /** Full version chain, oldest → newest, for the one-click history. */
  chain: PublicationDoc[];
}

/**
 * Resolve version chains from a set of publication docs (pure).
 * Current = the doc no other doc supersedes. A chain whose head's
 * recorded status is "retracted" stays in the result WITH that status —
 * a retracted claim never renders as a current claim (brief §7.2), and
 * hiding the retraction would be its own kind of lie.
 */
export function resolveClaimChains(docs: PublicationDoc[]): ClaimChain[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const supersededIds = new Set(
    docs.map((d) => d.supersedesPublicationId).filter((x): x is string => !!x)
  );
  const chains: ClaimChain[] = [];
  for (const doc of docs) {
    if (supersededIds.has(doc.id)) continue; // not a chain head
    const chain: PublicationDoc[] = [];
    let cursor: PublicationDoc | undefined = doc;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.supersedesPublicationId
        ? byId.get(cursor.supersedesPublicationId)
        : undefined;
    }
    chains.push({ current: doc, chain });
  }
  // Newest current claims first (publishedAtSeq DESC, matching the
  // Phase 3 composite index the fetch below rides).
  chains.sort((a, b) => b.current.publishedAtSeq - a.current.publishedAtSeq);
  return chains;
}

function toPublicationDoc(id: string, data: Record<string, unknown>): PublicationDoc {
  return {
    id,
    cityId: String(data.cityId ?? ""),
    businessId: typeof data.businessId === "string" ? data.businessId : null,
    publisherUid: String(data.publisherUid ?? ""),
    version: typeof data.version === "number" ? data.version : 1,
    supersedesPublicationId:
      typeof data.supersedesPublicationId === "string"
        ? data.supersedesPublicationId
        : null,
    status: String(data.status ?? "published"),
    publishedAtSeq: typeof data.publishedAtSeq === "number" ? data.publishedAtSeq : 0,
    claims: Array.isArray(data.claims) ? data.claims : [],
    visibility: String(data.visibility ?? "members"),
  };
}

/**
 * Fetch a city's publications AS THE REQUESTER (rules-governed reads —
 * a members-only claim simply does not come back for a guest) and
 * resolve the current-version chains. Rides the Phase 3 composite index
 * (cityId ASC, publishedAtSeq DESC).
 */
export async function fetchCityClaimChains(
  db: Firestore,
  cityId: string
): Promise<ClaimChain[]> {
  const snap = await getDocs(
    query(
      collection(db, "sim_publications"),
      where("cityId", "==", cityId),
      orderBy("publishedAtSeq", "desc")
    )
  );
  return resolveClaimChains(
    snap.docs.map((d) => toPublicationDoc(d.id, d.data() as Record<string, unknown>))
  );
}
