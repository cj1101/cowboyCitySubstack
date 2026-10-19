/**
 * Season-0 allocation constants and per-stat metadata.
 *
 * Every number here is Vera's lock in workstreams/stat-model-amendment.md
 * (Build Plan v1.2, Phase 0/1 deliverable closing Dana's Q-B5), taken under
 * CJ's delegation of the exact pool/bounds (plan §6.1):
 *
 * - Pool: 400 points, allocated as FINAL index values (1 point = 1 index
 *   point). 400 = the old neutral city: 8 indices x 50. An owner can rebuild
 *   the flat-50 city exactly, or reshape it — but no allocation makes a city
 *   globally stronger in total than the neutral baseline (amendment §3.3).
 * - Per-stat bounds at allocation: min 0, max 80. The top fifth of every
 *   index (81-100) is EARNED SPACE — reachable only through play (R-36
 *   capacity investment, R-38 military structures, and the other published
 *   growth rules). A starting 100 would make growth on that axis meaningless.
 * - Allocatable: the eight indices ONLY. Stocks (population, gdpRubars,
 *   treasuryRubars, households, housingUnits) are never allocatable
 *   (amendment §3.2) and do not appear in this module.
 * - Commit validates the sum is EXACTLY the pool: unspent points are not
 *   banked, they are a validation error the UI surfaces before confirmation
 *   (R-35, amendment §3.1). There is no second commit and no respec (§3.4).
 */

/** The eight allocatable indices, in the template's canonical order. */
export const ALLOCATABLE_STATS = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "military",
  "defense",
] as const;

export type AllocatableStat = (typeof ALLOCATABLE_STATS)[number];

/** Season-0 point pool (Vera lock; also INITIAL_POINT_BUDGET in lib/sim/template.ts). */
export const POINT_BUDGET = 400;

/** Per-stat bounds at allocation time (amendment §3.3). */
export const ALLOCATION_MIN = 0;
export const ALLOCATION_MAX = 80;

/** In-play index ceiling: values above ALLOCATION_MAX are earned, never allocated. */
export const INDEX_MAX_IN_PLAY = 100;

/** The neutral-city value: 8 x 50 = 400 reproduces the pre-allocation baseline. */
export const NEUTRAL_VALUE = 50;

export interface StatMeta {
  key: AllocatableStat;
  label: string;
  /** One-line plain-language explanation shown with the control. */
  explanation: string;
  /** Published mechanical hooks, where Vera's amendment states them. */
  mechanicsNote?: string;
}

export const STAT_META: Record<AllocatableStat, StatMeta> = {
  spirit: {
    key: "spirit",
    label: "Spirit",
    explanation:
      "Morale and collective will — how your city absorbs setbacks, displacement, and bad news without breaking.",
  },
  culture: {
    key: "culture",
    label: "Culture",
    explanation:
      "Cultural output and identity — the arts, traditions, and prestige that make your city itself, and worth visiting.",
  },
  infrastructure: {
    key: "infrastructure",
    label: "Infrastructure",
    explanation:
      "Roads, ports, utilities, and plant — the built capacity everything else runs on.",
    mechanicsNote:
      "Also feeds readiness: floor(infrastructure / 20) (0-5) is added to BOTH sides of a stat contest (amended R-18) — logistics move an expedition and a defense alike.",
  },
  stability: {
    key: "stability",
    label: "Stability",
    explanation:
      "Governmental coherence — whether your city's institutions hold together under pressure.",
    mechanicsNote:
      "Below 25, the city fights in disarray: -5 to its contest number, attacking or defending (amended R-18). Stability neglect is a military fact, in advance.",
  },
  law: {
    key: "law",
    label: "Law",
    explanation:
      "Rule of law and enforcement — courts, codes, and the credibility of consequences inside your city.",
    mechanicsNote:
      "Law prices the act, not the outcome: an attack costs the attacker's city law -5 whatever the contest result (amended R-18). Winning a war does not make it lawful.",
  },
  influence: {
    key: "influence",
    label: "Influence",
    explanation:
      "Political weight in the realm — your city's voice in Town Hall, treaties, and the shared life of the United Realms.",
    mechanicsNote:
      "Earned in politics (contests, office, verdicts) — never harvested from targets: aggression costs the attacker's city influence -3 (amended R-18).",
  },
  military: {
    key: "military",
    label: "Military",
    explanation:
      "Offensive capability: your city's standing capacity to project force beyond its own borders — trained and equipped forces, command, and the reach to sustain an expedition.",
    mechanicsNote:
      "The attacker's base number in a stat contest (amended R-18). A city that allocates 0 here has built no forces and cannot initiate a hostile action.",
  },
  defense: {
    key: "defense",
    label: "Defense",
    explanation:
      "Defensive capability: fortifications, garrison readiness, civil defense, and prepared positions — your city's capacity to make an attack fail or cost more than it gains.",
    mechanicsNote:
      "The target's base number in a stat contest (amended R-18). It does not stop an attack being attempted; it decides how the attempt lands. 0 is a published soft target.",
  },
};

/** The earned-space note, shown wherever the allocation controls appear. */
export const EARNED_SPACE_NOTE =
  "No index can start above 80: the top fifth of every index (81-100) is earned space, won in play — capacity projects, structures, titles, and verdicts — never allocated at founding.";
