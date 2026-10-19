/**
 * lib/dashboard/trust.ts — compare-view eligibility + sources
 * (Phase 3 brief §7.3–7.4; module map: "Assessment read/write/share
 * helpers + compare-view eligibility predicate. Pure eligibility
 * logic; writes go through the client SDK under §11 rules").
 *
 * Assessment read/write/share itself lives in Felix's module
 * (lib/trust/assessments.ts + lib/trust/store.ts). This file carries
 * the piece no module owned: the GATED COMPARE VIEW's eligibility
 * predicate and its source loaders, under Theo's TC-P03 ruling
 * (Reading A — workstreams/tc-p03-ruling-memo.md §6, Vera's six
 * clauses):
 *
 *   (i)   eligibility is evaluated per viewer at render time against
 *         sources the viewer legitimately holds in-app: the subject
 *         city's verified sim figures, or the viewer's own collected
 *         intel about the subject. No source ⇒ no compare UI at all
 *         (absent, never disabled).
 *   (ii)  the compare renders exactly the claim, the viewer's source,
 *         and their arithmetic delta — a difference between two
 *         shown figures, never a verdict, never a consensus or
 *         "actual" figure (none is computed).
 *   (iii) both sides carry tier labels at figure prominence.
 *   (iv)  the view persists nothing, confers no access or export,
 *         and writes no assessment.
 *   (v)   the Phase 4 merge-conflict case stays sim-internal (TC-P04).
 *   (vi)  [process clause — the §22 deletion fallback is NOT taken;
 *         the gate runs P3-G8 under Variant A.]
 *
 * Guests never compare: the predicate's first clause is full-member
 * standing, evaluated from the viewer's own users doc at render time
 * (the host passes it in; this module never trusts a stale flag).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  type Firestore,
} from "firebase/firestore";

/** One owner-published claim (Phase 1 brief §1.7 doc shape). */
export interface PublicationClaim {
  metric: string;
  claimedValue: number | string;
  unit: string | null;
  periodLabel: string | null;
  note: string | null;
}

export function parseClaims(raw: unknown): PublicationClaim[] {
  if (!Array.isArray(raw)) return [];
  const claims: PublicationClaim[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.metric !== "string") continue;
    if (typeof c.claimedValue !== "number" && typeof c.claimedValue !== "string") {
      continue;
    }
    claims.push({
      metric: c.metric,
      claimedValue: c.claimedValue,
      unit: typeof c.unit === "string" ? c.unit : null,
      periodLabel: typeof c.periodLabel === "string" ? c.periodLabel : null,
      note: typeof c.note === "string" ? c.note : null,
    });
  }
  return claims;
}

/**
 * Claim metric → verified stat key. Claims name metrics freely; only
 * metrics that ARE sim stats can ever meet a verified figure. Aliases
 * cover the corpus spellings; anything unmapped has no verified
 * source by construction.
 */
const METRIC_TO_STAT_KEY: Record<string, string> = {
  spirit: "spirit",
  culture: "culture",
  infrastructure: "infrastructure",
  stability: "stability",
  law: "law",
  influence: "influence",
  military: "military",
  defense: "defense",
  defence: "defense",
  treasury: "treasuryRubars",
  treasuryRubars: "treasuryRubars",
  gdp: "gdpRubars",
  gdpRubars: "gdpRubars",
  population: "population",
  households: "households",
  housing: "housingUnits",
  housingUnits: "housingUnits",
};

export function statKeyForMetric(metric: string): string | null {
  return METRIC_TO_STAT_KEY[metric.trim()] ?? null;
}

export type CompareSourceKind = "verified" | "intel";

export interface CompareSource {
  kind: CompareSourceKind;
  /** Tier label rendered at figure prominence (clause iii). */
  tierLabel: string;
  /** The source's figure for the claim's metric; null when the
   *  source speaks to the metric non-numerically. */
  value: number | string | null;
  /** Where the source figure lives, for the reader's own checking. */
  detail: string;
}

export interface CompareEligibility {
  eligible: boolean;
  sources: CompareSource[];
}

/**
 * The eligibility predicate (pure). A compare exists exactly when the
 * viewer is a full member AND at least one legitimately-held source
 * states a figure for the claim's metric. The subject city's OWNER
 * comparing their own claim against its verified figure is eligible
 * like anyone holding the source — the predicate fences on source
 * access, never on whose claim it is.
 */
export function compareEligibility(args: {
  viewerIsFullMember: boolean;
  claim: PublicationClaim;
  verifiedFigure: number | null;
  intelFigure: { value: number | string | null; detail: string } | null;
}): CompareEligibility {
  if (!args.viewerIsFullMember) return { eligible: false, sources: [] };
  const sources: CompareSource[] = [];
  if (args.verifiedFigure !== null) {
    sources.push({
      kind: "verified",
      tierLabel: "Verified sim figure",
      value: args.verifiedFigure,
      detail: "From the city's sim sheet — Log-derived ground truth.",
    });
  }
  if (args.intelFigure !== null) {
    sources.push({
      kind: "intel",
      tierLabel: "Your intel",
      value: args.intelFigure.value,
      detail: args.intelFigure.detail,
    });
  }
  return { eligible: sources.length > 0, sources };
}

/** The arithmetic delta (clause ii): source − claim, numbers only. */
export function compareDelta(
  claim: PublicationClaim,
  source: CompareSource
): number | null {
  if (typeof claim.claimedValue !== "number") return null;
  if (typeof source.value !== "number") return null;
  return source.value - claim.claimedValue;
}

// ---------------------------------------------------------------------------
// Source loaders (client SDK, the viewer's own session)
// ---------------------------------------------------------------------------

/** The verified figure for a metric from the subject city's sim doc. */
export async function loadVerifiedFigure(
  db: Firestore,
  cityId: string,
  metric: string
): Promise<number | null> {
  const statKey = statKeyForMetric(metric);
  if (!statKey) return null;
  const snap = await getDoc(doc(db, "sim_cities", cityId));
  if (!snap.exists()) return null;
  const stats = (snap.data().stats ?? {}) as Record<string, unknown>;
  const value = stats[statKey];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The viewer's own intel figure for a metric about a subject city.
 * Intel records are collector-private (rules: collectorUid == viewer,
 * or the collector city's owner); this loader reads only the viewer's
 * own collected records and extracts a numeric figure defensively —
 * the record's findings map is the collector's own product, and a
 * metric it does not state yields no source (never an invented one).
 */
export async function loadIntelFigure(
  db: Firestore,
  viewerUid: string,
  cityId: string,
  metric: string
): Promise<{ value: number | string | null; detail: string } | null> {
  const statKey = statKeyForMetric(metric);
  if (!statKey) return null;
  const snap = await getDocs(
    query(
      collection(db, "sim_intel_records"),
      where("collectorUid", "==", viewerUid)
    )
  );
  for (const recordDoc of snap.docs) {
    const data = recordDoc.data();
    const subject =
      (data.subjectCityId as string | undefined) ??
      (data.targetCityId as string | undefined);
    if (subject !== cityId) continue;
    const findings =
      (data.figures as Record<string, unknown> | undefined) ??
      (data.stats as Record<string, unknown> | undefined) ??
      (data.findings as Record<string, unknown> | undefined);
    if (!findings) continue;
    const value = findings[statKey] ?? findings[metric];
    if (typeof value === "number" || typeof value === "string") {
      return {
        value,
        detail: "From an intel record you collected about this city.",
      };
    }
  }
  return null;
}
