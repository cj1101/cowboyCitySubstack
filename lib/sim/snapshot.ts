/**
 * The dashboard snapshot projection (Phase 3 brief §2.1/§3; Dana
 * backend-architecture §3.1). Pure: no I/O, no clocks except the
 * caller-supplied `now` that lands in `updatedAt` (presentation metadata
 * only — freshness is a seq comparison, never a clock comparison, §3.3).
 *
 * The snapshot is a disposable cache with NO authority (Dana §3.1): it is
 * never an input to the resolver, and every consumer must tolerate it
 * being missing or stale (brief §3.5 fallback reads).
 *
 * Visibility fence (brief §3.4, CJ §7.1): the doc is readable by members
 * AND guests, so it is a public-tier projection only. The projection
 * itself enforces this — an actor-private entry handed to it by a buggy
 * or over-broad read set contributes nothing: no summary, no headline,
 * no count, no seq-gap annotation.
 *
 * ---------------------------------------------------------------------
 * INTEGRATION POINT — dispatcher terminal step (Phase 3 brief §3.2;
 * Phase 2 brief P2-D9 deferred the writer to this phase). LANDED in the
 * Phase 3 integration pass, after PR #21 merged: `runWake()` in
 * `lib/sim/dispatcher.ts` ends with exactly
 *
 *   if (wakeChangedWorld(summary)) {
 *     await refreshSnapshotAfterWake(deps, opts.now);
 *   }
 *
 * immediately before `return summary;`, where `refreshSnapshotAfterWake`
 * is the thin fabric-side adapter in `lib/sim/snapshotRefresh.ts`: it
 * assembles a SnapshotSource over the committer identity, calls
 * fetchSnapshotInputs + projectSnapshot from this module, and writes
 * the result to sim_dashboard_snapshots/current in its own small
 * transaction, failure-isolated (a failed refresh never fails a
 * resolution). The ops/recovery path is scripts/sim-rebuild-snapshot.ts,
 * which implements the same SnapshotSource interface over the Admin SDK
 * (emulator-guarded) — the adapter and the script are interchangeable
 * because the projection is pure over its read set.
 * ---------------------------------------------------------------------
 */

/** Firestore's 1 MiB document ceiling, with the brief's fail-loud margin. */
export const SNAPSHOT_SIZE_LIMIT_BYTES = 900_000;

/** `latestSummaries` cap (Dana §3.1; fenced again in firestore.rules). */
export const LATEST_SUMMARIES_CAP = 10;

/** WakeSummary-shaped input for wakeChangedWorld (Phase 2 dispatcher). */
export interface WakeOutcomeLike {
  actionsCommitted: readonly unknown[];
  undoOpsProcessed: number;
}

/**
 * Brief §3.2: a wake changed the world iff it committed ≥1 Resolution
 * Event (ripening commits ride inside commit-driven scans, so they are
 * covered by actionsCommitted) or executed ≥1 undo. An empty wake writes
 * nothing — there is nothing new to project, and §0.1.1 forbids implying
 * otherwise.
 */
export function wakeChangedWorld(summary: WakeOutcomeLike): boolean {
  return summary.actionsCommitted.length > 0 || summary.undoOpsProcessed > 0;
}

// ---------------------------------------------------------------------------
// Read-set types. Inputs are plain document data (Firestore values already
// projected to plain JS by the reader: Timestamps may arrive as Date or
// { seconds, nanoseconds } — the projection never reads timestamp fields
// off its inputs except where noted, and never echoes them into the doc).
// ---------------------------------------------------------------------------

export interface SnapshotFactionInput {
  id: string;
  data: Record<string, unknown>;
}

export interface SnapshotCityInput {
  /** The faction id (sim_cities doc id === factionId, Phase 1). */
  id: string;
  data: Record<string, unknown>;
}

export interface SnapshotInputs {
  /** sim_world/current, or null pre-genesis. */
  world: Record<string, unknown> | null;
  /** sim_counters/log, or null pre-genesis. Head-agreement check (§3.1). */
  counters: Record<string, unknown> | null;
  /** Every live faction (identity/profile), any order. */
  factions: SnapshotFactionInput[];
  /** Every sim_cities doc, any order. */
  simCities: SnapshotCityInput[];
  /**
   * The standing Log entry at world.lastCommittedSeq (the head entry),
   * or null when the head is 0 / pre-genesis.
   */
  headEntry: Record<string, unknown> | null;
  /**
   * Recent Log entries, seq DESC. May include actor-private entries if
   * the reader over-fetched; the projection fences them out (§3.4) and
   * keeps at most LATEST_SUMMARIES_CAP public ones.
   */
  recentEntries: Record<string, unknown>[];
  /** Latest public entry per faction id (cityIds CONTAINS), or null. */
  cityHeadlineEntries: Record<string, Record<string, unknown> | null>;
  /** Projection time; lands in `updatedAt` and nowhere else. */
  now: Date;
}

/**
 * The read assembly the projection needs, as an interface so the two
 * callers (dispatcher adapter, ops rebuild script) share the projection.
 * Implementations must read with an identity allowed to see the docs;
 * the projection's own fence (§3.4) is the guarantee, not the reader's.
 */
export interface SnapshotSource {
  getWorld(): Promise<Record<string, unknown> | null>;
  getCounters(): Promise<Record<string, unknown> | null>;
  listFactions(): Promise<SnapshotFactionInput[]>;
  listSimCities(): Promise<SnapshotCityInput[]>;
  getLogEntry(seq: number): Promise<Record<string, unknown> | null>;
  /** Seq DESC, any visibility, at least `limit` rows when available. */
  listRecentEntries(limit: number): Promise<Record<string, unknown>[]>;
  getCityHeadlineEntry(
    factionId: string
  ): Promise<Record<string, unknown> | null>;
}

export async function fetchSnapshotInputs(
  source: SnapshotSource
): Promise<Omit<SnapshotInputs, "now">> {
  const [world, counters, factions, simCities] = await Promise.all([
    source.getWorld(),
    source.getCounters(),
    source.listFactions(),
    source.listSimCities(),
  ]);
  const headSeq =
    typeof world?.lastCommittedSeq === "number" ? world.lastCommittedSeq : 0;
  const headEntry = headSeq > 0 ? await source.getLogEntry(headSeq) : null;
  // Over-fetch so the §3.4 fence cannot starve the digest: the cap counts
  // PUBLIC entries, and private ones interleaved in the window are dropped.
  const recentEntries = await source.listRecentEntries(LATEST_SUMMARIES_CAP * 3);
  const cityHeadlineEntries: Record<string, Record<string, unknown> | null> = {};
  for (const faction of factions) {
    cityHeadlineEntries[faction.id] = await source.getCityHeadlineEntry(faction.id);
  }
  return { world, counters, factions, simCities, headEntry, recentEntries, cityHeadlineEntries };
}

// ---------------------------------------------------------------------------
// Card shaping — shared by the projection and the client fallback reads
// (brief §3.5), so a fallback card and a projected card cannot drift.
// ---------------------------------------------------------------------------

/**
 * Compact stats per brief §2.1 ("the six indices + treasury/GDP/
 * population in their landed sim_cities forms, nulls preserved"): the
 * six headline indices named in the dashboard spec §5.2.12
 * (spirit/culture/infrastructure/stability/law/influence).
 * Military/defense are full-sheet figures, not compact-card figures.
 */
export const COMPACT_STAT_FIELDS = [
  "spirit",
  "culture",
  "infrastructure",
  "stability",
  "law",
  "influence",
  "treasuryRubars",
  "gdpRubars",
  "population",
] as const;

function isPublicEntry(entry: Record<string, unknown>): boolean {
  // Phase 1 entries always carry `visibility`; a missing field defaults
  // to public, mirroring the landed sim_log_entries read rule's
  // get('visibility', 'public') — every other value fences the entry out.
  return ((entry.visibility as string | undefined) ?? "public") === "public";
}

function actorDisplayOf(actor: unknown): string {
  const a = (actor ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case "member":
      return String(a.memberId ?? "member");
    case "npc":
      return `${String(a.npcId ?? "NPC")} (for ${String(a.onBehalfOfMemberId ?? "")})`;
    case "shared-office":
      return `shared office (${String(a.office ?? "mayor")})`;
    case "system":
      return "system";
    default:
      return String(a.type ?? "unknown");
  }
}

export interface CityCard {
  factionId: string;
  slug: string;
  name: string;
  ownerUid: string | null;
  ownerDisplay: string | null;
  hasSimState: boolean;
  compactStats: Record<string, number | null> | null;
  activity: { lastChangedSeq: number | null; lastActionSeq: number | null };
  latestHeadline: string | null;
  links: { cityPage: string; map: string };
}

export function buildCityCard(args: {
  faction: SnapshotFactionInput;
  simCity: Record<string, unknown> | null;
  headlineEntry: Record<string, unknown> | null;
}): CityCard {
  const { faction, simCity, headlineEntry } = args;
  const data = faction.data;
  const slug = String(data.slug ?? "");
  const ownerUids = Array.isArray(data.ownerUids) ? (data.ownerUids as unknown[]) : [];
  let compactStats: Record<string, number | null> | null = null;
  let activity: CityCard["activity"] = { lastChangedSeq: null, lastActionSeq: null };
  if (simCity) {
    const stats = (simCity.stats ?? {}) as Record<string, unknown>;
    compactStats = {};
    for (const field of COMPACT_STAT_FIELDS) {
      const value = stats[field];
      compactStats[field] = typeof value === "number" ? value : null;
    }
    activity = {
      lastChangedSeq:
        typeof simCity.lastChangedSeq === "number" ? simCity.lastChangedSeq : null,
      lastActionSeq:
        typeof simCity.lastActionSeq === "number" ? simCity.lastActionSeq : null,
    };
  }
  // Headline fence (§3.4): only a PUBLIC entry may headline a card.
  const headline =
    headlineEntry && isPublicEntry(headlineEntry)
      ? ((headlineEntry.summaryText as string | undefined) ?? null)
      : null;
  return {
    factionId: faction.id,
    slug,
    name: String(data.name ?? slug),
    ownerUid: ownerUids.length > 0 ? String(ownerUids[0]) : null,
    // The §3.1 read set carries no user docs, so a display name exists
    // only if the faction doc itself snapshots one; otherwise null and
    // the UI falls back to the owner uid / nothing. Never invented.
    ownerDisplay:
      typeof data.ownerDisplay === "string" ? data.ownerDisplay : null,
    hasSimState: simCity !== null,
    compactStats,
    activity,
    latestHeadline: headline,
    links: {
      cityPage: `/factions/${slug}`,
      map: `/factions/${slug}/map`,
    },
  };
}

export interface LatestSummary {
  seq: number;
  actorDisplay: string;
  actorKind: string;
  cityIds: string[];
  summaryText: string;
  major: boolean;
}

export function projectLatestSummaries(
  recentEntries: Record<string, unknown>[]
): LatestSummary[] {
  const out: LatestSummary[] = [];
  for (const entry of recentEntries) {
    if (out.length >= LATEST_SUMMARIES_CAP) break;
    if (!isPublicEntry(entry)) continue; // §3.4 fence: contributes nothing.
    const actor = (entry.actor ?? {}) as Record<string, unknown>;
    out.push({
      seq: typeof entry.seq === "number" ? entry.seq : 0,
      actorDisplay: actorDisplayOf(entry.actor),
      actorKind: String(actor.type ?? "unknown"),
      cityIds: Array.isArray(entry.cityIds) ? (entry.cityIds as string[]) : [],
      summaryText: String(entry.summaryText ?? ""),
      major: entry.major === true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The projection.
// ---------------------------------------------------------------------------

/**
 * Computes the §2.1 snapshot doc from a read set. Deterministic: same
 * standing state ⇒ byte-identical doc modulo `updatedAt` (factions are
 * sorted by factionId before card assembly). Throws — fail loud, never
 * truncate (§2.1) — when the counter and the world disagree about the
 * head, or when the computed doc would exceed the size limit; the wake
 * reports the failure and the snapshot simply remains stale (§3.2).
 */
export function projectSnapshot(inputs: SnapshotInputs): Record<string, unknown> {
  const { world, counters } = inputs;
  const asOfSeq =
    typeof world?.lastCommittedSeq === "number" ? world.lastCommittedSeq : 0;

  if (counters && typeof counters.lastSeq === "number" && counters.lastSeq !== asOfSeq) {
    throw new Error(
      `snapshot projection head mismatch: sim_counters/log lastSeq ${counters.lastSeq} ` +
        `!= sim_world/current lastCommittedSeq ${asOfSeq}`
    );
  }

  // generatedByResolutionId: the STANDING head entry's resolution. After
  // an undo-only wake the head is an older entry and names its own
  // resolution — an undo is not a resolution and never names itself here.
  // Null only pre-genesis (no head entry).
  let generatedByResolutionId: string | null = null;
  if (inputs.headEntry && typeof inputs.headEntry.seq === "number" && inputs.headEntry.seq === asOfSeq && asOfSeq > 0) {
    generatedByResolutionId =
      typeof inputs.headEntry.resolutionId === "string"
        ? inputs.headEntry.resolutionId
        : null;
  }

  const simCityById = new Map(inputs.simCities.map((c) => [c.id, c.data]));
  const factions = [...inputs.factions].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
  const cityCards = factions.map((faction) =>
    buildCityCard({
      faction,
      simCity: simCityById.get(faction.id) ?? null,
      headlineEntry: inputs.cityHeadlineEntries[faction.id] ?? null,
    })
  );

  const doc: Record<string, unknown> = {
    asOfSeq,
    generatedByResolutionId,
    cityCards,
    latestSummaries: projectLatestSummaries(inputs.recentEntries),
    // Phase 7 records do not exist yet; the projection emits what the
    // records say, and there are none (brief §2.1). Never invented.
    openContestCards: [],
    townHallCard: null,
    updatedAt: inputs.now,
  };

  const bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (bytes > SNAPSHOT_SIZE_LIMIT_BYTES) {
    throw new Error(
      `snapshot projection would be ${bytes} bytes (> ${SNAPSHOT_SIZE_LIMIT_BYTES}); ` +
        "refusing to truncate a city card silently (Phase 3 brief §2.1)"
    );
  }
  return doc;
}

/**
 * Freshness predicate (brief §3.3) — seq comparison only, shared by the
 * client and the tests. `!=`, never `>`: after a lawful undo the head
 * DECREASES, and a snapshot ahead of the head is stale, not future.
 * A missing snapshot is never current.
 */
export function snapshotIsCurrent(
  snapshot: Record<string, unknown> | null,
  world: Record<string, unknown> | null
): boolean {
  if (!snapshot || !world) return false;
  return snapshot.asOfSeq === world.lastCommittedSeq;
}
