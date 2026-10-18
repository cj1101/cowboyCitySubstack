/**
 * The even-start template and the Phase 1 sim constants (Phase 1 brief §1).
 *
 * One template for every city, defined once, hashed once. No stats are
 * seeded from the corpus for any city — corpus GDP/population figures are
 * lore reference only and appear nowhere in this module or in any sim doc.
 *
 * Template composition (brief §1.1, cross-checked line-by-line against
 * Vera's stat-model amendment §3.2 — see workstreams/phase1-decisions.md,
 * decision K-3): the eight allocatable indices and population/gdpRubars are
 * `null` (present keys, no invented value); households/housingUnits/
 * treasuryRubars are true bookkeeping zeroes (counts of records that do
 * not exist yet).
 */

import { sha256Hex } from "./canonical";

export const EVEN_START_TEMPLATE_VERSION = "even-start-template-v1";

/** Genesis rules label (decision K-2, phase1-decisions.md). */
export const GENESIS_RULES_VERSION = "sim-rules-0.1.0-phase1";

/** The Log's world id (brief §1.2). */
export const WORLD_ID = "united-realms";

/** Genesis prevHash: 64 zero characters (spec §3.4). */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * Season-0 point pool (Vera's lock, stat-model amendment §3.3/§5: Q-B5
 * closed at 400 — eight indices × the old neutral 50, allocated as final
 * index values, per-stat bounds 0..80 at allocation, sum exactly 400).
 * Phase 1 only records it on the allocation control doc; Phase 4 enforces
 * bounds and the exact-sum rule at allocation commit.
 */
export const INITIAL_POINT_BUDGET = 400;

export interface BaselineStats {
  spirit: null;
  culture: null;
  infrastructure: null;
  stability: null;
  law: null;
  influence: null;
  military: null;
  defense: null;
  households: 0;
  housingUnits: 0;
  treasuryRubars: 0;
  population: null;
  gdpRubars: null;
}

export const EVEN_START_TEMPLATE: {
  templateVersion: string;
  baselineStats: BaselineStats;
} = {
  templateVersion: EVEN_START_TEMPLATE_VERSION,
  baselineStats: {
    spirit: null,
    culture: null,
    infrastructure: null,
    stability: null,
    law: null,
    influence: null,
    military: null,
    defense: null,
    households: 0,
    housingUnits: 0,
    treasuryRubars: 0,
    population: null,
    gdpRubars: null,
  },
};

/** Season constant: identical for every city (brief §1.1). */
export const BASELINE_HASH = sha256Hex({
  templateVersion: EVEN_START_TEMPLATE.templateVersion,
  baselineStats: EVEN_START_TEMPLATE.baselineStats,
});

/** Hash of the canonical empty allocation draft (brief §1.6). */
export const EMPTY_DRAFT_HASH = sha256Hex({ allocations: {}, spentPoints: null });

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function templateStats(): BaselineStats {
  return deepCopy(EVEN_START_TEMPLATE.baselineStats);
}

/** Zero-padded 12-digit Log doc id for a seq (brief §1.4). */
export function logEntryDocId(seq: number): string {
  return String(seq).padStart(12, "0");
}

// ---------------------------------------------------------------------------
// Log entry hashing (spec §3.4 canonical input, extended per brief §1.4
// with `visibility` and `baseline` — they are entry content; excluding them
// would let a visibility flip go undetected by the verifier).
// ---------------------------------------------------------------------------

const LOG_HASH_FIELDS = [
  "hashVersion",
  "seq",
  "resolutionId",
  "resolutionSeq",
  "kind",
  "resolvedAt",
  "rulesVersion",
  "actor",
  "actionId",
  "classification",
  "cityId",
  "cityIds",
  "ruleIds",
  "changes",
  "spilloverFromSeq",
  "causedBySeq",
  "correctsSeq",
  "recordsCreated",
  "recordsUpdated",
  "legal",
  "chronicleDraftId",
  "major",
  "summaryText",
  "actionText",
  "prevHash",
  "visibility",
  "baseline",
] as const;

export function computeLogEntryHash(entry: Record<string, unknown>): string {
  const input: Record<string, unknown> = {};
  for (const field of LOG_HASH_FIELDS) {
    input[field] = entry[field] ?? null;
  }
  return sha256Hex(input);
}

// ---------------------------------------------------------------------------
// Document builders. Pure: they return plain objects (Dates for timestamp
// fields; the Admin SDK stores them as Firestore Timestamps). The genesis
// and lazy-creation procedures write exactly what these builders return.
// ---------------------------------------------------------------------------

export function buildSimWorldDoc(now: Date): Record<string, unknown> {
  return {
    worldId: WORLD_ID,
    rulesVersion: GENESIS_RULES_VERSION,
    evenStartTemplateVersion: EVEN_START_TEMPLATE_VERSION,
    evenStartTemplateHash: BASELINE_HASH,
    genesisSeq: 1,
    lastCommittedSeq: 1,
    currentSeasonId: null,
    // Set by a later operations step once the Cowboy City faction is
    // identified in Firebase. Phase 1 must not guess it (brief §1.2).
    sharedCityId: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildSimCountersDoc(
  genesisEntryHash: string,
  now: Date
): Record<string, unknown> {
  return {
    lastSeq: 1,
    lastEntryHash: genesisEntryHash,
    lastResolutionId: "genesis",
    updatedAt: now,
  };
}

/**
 * The genesis Log entry, minus the fields that depend on the write set
 * (`entryHash`, `writeSetDigest`, `stateHeadsAfter`) — the genesis
 * procedure computes and attaches those (brief §2 step 4).
 */
export function buildGenesisLogEntry(resolvedAt: Date): Record<string, unknown> {
  return {
    seq: 1,
    resolutionSeq: 1,
    resolutionId: "genesis",
    entryIndexWithinResolution: 0,
    kind: "genesis",
    resolvedAt: resolvedAt.toISOString(),
    rulesVersion: GENESIS_RULES_VERSION,
    actor: {
      type: "system",
      memberId: null,
      npcId: null,
      onBehalfOfMemberId: null,
      mandateId: null,
      mandateVersion: null,
      envelopeId: null,
    },
    actionId: null,
    actionText: null,
    classification: null,
    cityId: null,
    cityIds: [],
    ruleIds: [],
    changes: [],
    spilloverFromSeq: null,
    causedBySeq: null,
    correctsSeq: null,
    recordsCreated: ["sim_world/current", "sim_counters/log"],
    recordsUpdated: [],
    legal: null,
    chronicleDraftId: null,
    major: false,
    summaryText:
      `Genesis: even-start template ${EVEN_START_TEMPLATE_VERSION} ` +
      `(baselineHash ${BASELINE_HASH}), rules ${GENESIS_RULES_VERSION}. ` +
      "No city state seeded.",
    visibility: "public",
    baseline: null,
    prevHash: GENESIS_PREV_HASH,
    hashVersion: "cowboy-canonical-json-v1",
  };
}

export interface FactionSnapshot {
  slug: string;
  name: string;
}

/** `sim_cities/{factionId}` exactly per brief §1.3. */
export function buildSimCityDoc(args: {
  factionId: string;
  faction: FactionSnapshot;
  seedCityId: string | null;
  sharedCityId: string | null;
  createdAtSeq: number;
  now: Date;
}): Record<string, unknown> {
  return {
    factionId: args.factionId,
    seedCityId: args.seedCityId,
    slugSnapshot: args.faction.slug,
    nameSnapshot: args.faction.name,
    isSharedCity:
      args.sharedCityId !== null && args.factionId === args.sharedCityId,
    baseline: {
      templateVersion: EVEN_START_TEMPLATE_VERSION,
      baselineStats: templateStats(),
      baselineHash: BASELINE_HASH,
    },
    stats: templateStats(),
    legalExposure: { open: false, caseIds: [], tier: 0 },
    traits: [],
    // R-37 posture record (Vera, stat-model amendment §5 item 2): the
    // honest unbuilt state. Fabric-written only; no Phase 1 mechanic
    // reads or sets it.
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
    lastActionSeq: null,
    lastActionAt: null,
    createdVia: "lazy-claim",
    createdAtSeq: args.createdAtSeq,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** `sim_stat_allocations/{cityId}` exactly per brief §1.6 + Vera's pool lock. */
export function buildSimStatAllocationsDoc(
  cityId: string,
  now: Date
): Record<string, unknown> {
  return {
    cityId,
    status: "not_started",
    baselineHash: BASELINE_HASH,
    baselineStats: templateStats(),
    // Vera's landed lock (Q-B5 closed at 400) — see phase1-decisions.md.
    // The brief's null posture was explicitly "until Vera locks the pool";
    // CJ's ~1,000 example appears in no data, per the brief.
    pointBudget: INITIAL_POINT_BUDGET,
    allocations: {},
    spentPoints: null,
    draftVersion: 0,
    draftHash: EMPTY_DRAFT_HASH,
    authorUid: null,
    commitActionId: null,
    committedSeq: null,
    committedByUid: null,
    createdAt: now,
    updatedAt: now,
  };
}
