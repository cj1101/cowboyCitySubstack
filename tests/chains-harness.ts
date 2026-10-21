/**
 * Chains + growth harness (Phase 4 step 10) — a pure-logic battery
 * over lib/sim/rules/chains.ts and lib/sim/rules/growth.ts, riding
 * the REAL landed machinery end-to-end: resolveAction for actions,
 * evaluateRipeness for scan verdicts, resolveRipening /
 * resolveVoiding for wake resolutions, validatePlan inside every
 * resolver call. No emulator: the Firestore-bound pieces (claims,
 * the committer transaction) are simulated by a miniature committer
 * whose stamping mirrors committer.ts (entry seqs in plan order;
 * pending originSeq/createdAtSeq from the creating event's summary
 * seq; requiredSeq = CREATION seq + minSeqAdvance (E1 anchoring);
 * eligibleAt = created + minWallElapsedHours; city lastChangedSeq =
 * the event's summary seq; the counter's lastResolvedSeq tally (E4)
 * advances with every commit — the mirror commits resolved plans
 * only, so its tally equals its head).
 *
 * The scan simulator mirrors scanRipeness's decision structure:
 * candidates snapshotted at pass start in (createdAtSeq, pendingId)
 * order, pass-start RipenessView (counter + per-city activity +
 * precondition docs read ONCE), evaluate cap 25, event cap 5,
 * generative-without-prepared = skipped (not failed),
 * per-candidate resolution against a FRESH snapshot, failures caught
 * and recorded with the attempt counter the claim-release path keeps.
 *
 * ONE deliberate deviation, flagged wherever it matters: the pass
 * takes a `guard` option modeling P4-K20's re-evaluation — landed in
 * the engine at the Phase 4 close-out (E2: claimed-snapshot
 * re-evaluation in scanRipeness + the in-transaction guard in
 * commitResolution). The F-05 section runs the same pass with the
 * guard OFF (the pre-close-out scan) and ON (the landed contract) so
 * both behaviors stay executable evidence, not prose. Everything
 * else is landed behavior only.
 *
 * Descriptors are registered in-process exactly as the Build Lead's
 * assembly will: the registry's inline R-32 keeps its fixture kinds
 * and GAINS the product kinds/handlers (the chains merge), and
 * GROWTH_DESCRIPTORS is assigned whole (R-36 is a pure addition).
 * The registry's ACTION_KIND_INDEX is a load-time derivation over
 * RULE_DESCRIPTORS, so the harness updates it alongside — in the
 * Lead's source-level edit the index follows automatically.
 *
 * Run: npx tsx tests/chains-harness.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectActionReadPaths,
  collectActionReadPlan,
  collectRipeningReadPaths,
  resolveAction,
  resolveRipening,
  resolveVoiding,
  snapshotFromDocs,
} from "../lib/sim/resolver";
import { evaluateRipeness, type RipenessVerdict, type RipenessView } from "../lib/sim/pending";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { ACTION_KIND_INDEX, RULE_DESCRIPTORS } from "../lib/sim/rules/registry";
import {
  CHAINS_DESCRIPTORS,
  R32_PRODUCT_ACTION_KINDS,
  R32_PRODUCT_HANDLERS,
  buildFundPayloadSpec,
  fundPath,
  fundPreconditions,
} from "../lib/sim/rules/chains";
import {
  GROWTH_DESCRIPTORS,
  auditIndexSum,
  capacityProjectPath,
  capacityWorkUnitsFor,
  indexSumOfStats,
  verifyIndexSumAgainstCity,
  type GrowthAuditEntry,
} from "../lib/sim/rules/growth";
import { buildPendingDraft, resolvedSeqOf, ripeningFailureClass } from "../lib/sim/rules/pendingRules";
import { deriveDelay } from "../lib/sim/rules/arithmetic";
import {
  PENDING_FANOUT_CAP,
  SCAN_EVALUATE_CAP,
  SCAN_RIPEN_CAP,
  type LogEntryDraft,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimActor,
} from "../lib/sim/state";

// ---------------------------------------------------------------------------
// The Lead's assembly, simulated in-process.
// ---------------------------------------------------------------------------

const inlineR32 = RULE_DESCRIPTORS["R-32"];
assert.ok(inlineR32, "base registry carries the inline R-32 (fixture) descriptor");
RULE_DESCRIPTORS["R-32"] = {
  ...inlineR32,
  actionKinds: [...inlineR32.actionKinds, ...R32_PRODUCT_ACTION_KINDS],
  handlers: { ...inlineR32.handlers, ...R32_PRODUCT_HANDLERS },
  mayCreatePendings: true,
  readPlan: CHAINS_DESCRIPTORS["R-32"].readPlan,
};
Object.assign(RULE_DESCRIPTORS, GROWTH_DESCRIPTORS);
for (const kind of R32_PRODUCT_ACTION_KINDS) ACTION_KIND_INDEX[kind] = "R-32";
for (const [id, descriptor] of Object.entries(GROWTH_DESCRIPTORS)) {
  for (const kind of descriptor.actionKinds) ACTION_KIND_INDEX[kind] = id;
}

const fixtureRegistry = buildFixtureBaselineRegistry();

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(3, " ")} — ${label}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// World + miniature committer (mirrors committer.ts stamping)
// ---------------------------------------------------------------------------

interface CommittedEntry extends LogEntryDraft {
  seq: number;
}

interface World {
  docs: Map<string, Record<string, unknown>>;
  seq: number;
  log: CommittedEntry[];
}

const SEED_SEQ = 100;

function newWorld(): World {
  const docs = new Map<string, Record<string, unknown>>();
  docs.set("sim_counters/log", { lastSeq: SEED_SEQ, lastResolvedSeq: SEED_SEQ, lastEntryHash: "seed" });
  docs.set("sim_world/current", { lastCommittedSeq: SEED_SEQ });
  return { docs, seq: SEED_SEQ, log: [] };
}

function seedCity(
  w: World,
  cityId: string,
  ownerUid: string,
  stats: Record<string, number | null>,
  traits: string[] = []
): void {
  w.docs.set(`factions/${cityId}`, { name: cityId, slug: cityId, ownerUids: [ownerUid] });
  w.docs.set(`sim_cities/${cityId}`, {
    factionId: cityId,
    stats,
    traits,
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1,
    lastChangedSeq: SEED_SEQ,
    lastResolutionId: null,
  });
}

function commitPlan(w: World, plan: ResolutionPlan, nowIso: string, resolutionId: string): CommittedEntry[] {
  assert.equal(plan.outcome, "resolved", "mini-committer only commits resolved plans");
  const entries: CommittedEntry[] = plan.entries.map((e, i) => ({ ...e, seq: w.seq + 1 + i }));
  const summarySeq = w.seq + plan.entries.length;
  for (const write of plan.writes) {
    if (write.op === "delete" || !write.afterDoc) {
      w.docs.delete(write.path);
      continue;
    }
    const after: Record<string, unknown> = { ...write.afterDoc };
    if (typeof after.stateVersion === "number") after.stateVersion += 1;
    after.lastChangedSeq = summarySeq;
    after.lastResolutionId = resolutionId;
    w.docs.set(write.path, after);
  }
  for (const draft of plan.pendingCreates) {
    const doc: Record<string, unknown> = { ...draft.doc };
    const originSeq = typeof doc.originSeq === "number" ? doc.originSeq : summarySeq;
    doc.originSeq = originSeq;
    doc.createdAtSeq = summarySeq;
    doc.createdBySeq = doc.sourceKind === "ripening" ? summarySeq : null;
    doc.createdAt = nowIso;
    doc.updatedAt = nowIso;
    const rc = { ...(doc.ripenCondition as Record<string, unknown>) };
    // E1 anchoring mirror (Phase 4 close-out): requiredSeq anchors to
    // the CREATION seq (this summary's seq), not the chain origin —
    // identical for generation-1 pendings, where originSeq IS the
    // creation seq.
    rc.requiredSeq = summarySeq + (rc.minSeqAdvance as number);
    rc.eligibleAt = new Date(
      Date.parse(nowIso) + (rc.minWallElapsedHours as number) * 3_600_000
    ).toISOString();
    doc.ripenCondition = rc;
    w.docs.set(`sim_pending_consequences/${doc.pendingId as string}`, doc);
  }
  for (const t of plan.pendingTransitions) {
    const path = `sim_pending_consequences/${t.pendingId}`;
    const doc = w.docs.get(path);
    if (!doc) continue;
    const next: Record<string, unknown> = { ...doc, status: t.toStatus, updatedAt: nowIso };
    if (t.toStatus === "ripened") {
      next.ripenedAtSeq = summarySeq;
      next.outcomeSummary = t.outcomeSummary ?? null;
    } else {
      next.voidedAtSeq = summarySeq;
      next.voidReason = t.voidReason ?? null;
    }
    w.docs.set(path, next);
  }
  w.seq = summarySeq;
  // E4 tally mirror: the mini-committer only commits resolved plans,
  // so its resolved tally advances with every commit (== its head).
  w.docs.set("sim_counters/log", { lastSeq: w.seq, lastResolvedSeq: w.seq, lastEntryHash: "harness" });
  w.docs.set("sim_world/current", { lastCommittedSeq: w.seq });
  w.log.push(...entries);
  return entries;
}

// ---------------------------------------------------------------------------
// Action driving (dispatcher surface, minus the scan — passes are
// invoked explicitly so each one is legible in the trace)
// ---------------------------------------------------------------------------

const memberActor = (uid: string): SimActor => ({
  type: "member",
  memberId: uid,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

let actionCounter = 0;
function act(
  actionType: string,
  uid: string,
  structuredAction: Record<string, unknown>,
  actionText?: string
): SimAction {
  actionCounter += 1;
  const actionId = `act_chains_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "chains-harness",
    actor: memberActor(uid),
    actionType,
    actionText: actionText ?? `${actionType} (harness)`,
    structuredAction,
    targetCityIds: typeof structuredAction.cityId === "string" ? [structuredAction.cityId] : [],
    threadRef: null,
    audienceUids: [],
    preview: null,
    previewPlanHash: null,
    confirmation: null,
    claim: null,
    lastAttempt: null,
    status: "confirmed",
    resolutionId: null,
    firstLogSeq: null,
    lastLogSeq: null,
    failure: null,
    createdAt: null,
    updatedAt: null,
  };
}

function runAction(
  w: World,
  action: SimAction,
  nowIso: string
): { plan: ResolutionPlan; entries: CommittedEntry[] } {
  const basePaths = collectActionReadPaths(action);
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of basePaths) seedDocs.set(path, w.docs.get(path) ?? null);
  const readPlan = collectActionReadPlan(action, seedDocs);
  const docs = new Map(seedDocs);
  for (const path of readPlan.paths) {
    if (!docs.has(path)) docs.set(path, w.docs.get(path) ?? null);
  }
  assert.equal(readPlan.queries.length, 0, "chains/growth descriptors declare no collection queries");
  const snapshot = snapshotFromDocs(docs, nowIso);
  const plan = resolveAction(snapshot, action, { baselineRegistry: fixtureRegistry, mode: "commit" });
  const entries = plan.outcome === "resolved" ? commitPlan(w, plan, nowIso, action.actionId) : [];
  return { plan, entries };
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}, got a resolved plan`);
  assert.equal(plan.rejection?.code, code, `expected ${code}, got ${plan.rejection?.code}`);
  assert.equal(plan.writes.length, 0, "a rejected plan writes nothing");
}

// ---------------------------------------------------------------------------
// Scan pass simulator (mirrors scanRipeness's decision structure)
// ---------------------------------------------------------------------------

interface PassResult {
  evaluated: number;
  ripened: string[];
  voided: string[];
  skippedUnprepared: string[];
  failed: { pendingId: string; code: string }[];
  events: number;
}

function liveActivity(w: World, cityIds: Iterable<string>): Map<string, number> {
  const map = new Map<string, number>();
  for (const cityId of cityIds) {
    const city = w.docs.get(`sim_cities/${cityId}`);
    map.set(cityId, typeof city?.lastChangedSeq === "number" ? (city.lastChangedSeq as number) : 0);
  }
  return map;
}

function runScanPass(
  w: World,
  nowIso: string,
  opts: { prepared?: Map<string, PreparedPayload>; guard?: boolean } = {}
): PassResult {
  const result: PassResult = { evaluated: 0, ripened: [], voided: [], skippedUnprepared: [], failed: [], events: 0 };
  const candidates = [...w.docs.entries()]
    .filter(([path]) => path.startsWith("sim_pending_consequences/"))
    .map(([, doc]) => doc)
    .filter((doc) => doc.status === "pending")
    .sort((a, b) => {
      const bySeq = (a.createdAtSeq as number) - (b.createdAtSeq as number);
      return bySeq !== 0 ? bySeq : String(a.pendingId).localeCompare(String(b.pendingId));
    })
    .slice(0, SCAN_EVALUATE_CAP);

  // Pass-start view: counter, activity and precondition docs read ONCE
  // (the landed scan's shape — and the reason the P4-K20 guard exists).
  const frozen = new Map(w.docs);
  const activityCities = new Set<string>();
  for (const c of candidates) {
    for (const cityId of ((c.ripenCondition as Record<string, unknown>).requiresActionInCities as string[] | undefined) ?? []) {
      activityCities.add(cityId);
    }
  }
  const frozenActivity = new Map<string, number>();
  for (const cityId of activityCities) {
    const city = frozen.get(`sim_cities/${cityId}`);
    frozenActivity.set(cityId, typeof city?.lastChangedSeq === "number" ? (city.lastChangedSeq as number) : 0);
  }
  const view: RipenessView = {
    // E4: seq currency is the resolved tally, read off the counter —
    // in this mirror tally == head (resolved-only commits), but the
    // read goes through the same rule the engine uses.
    currentSeq: resolvedSeqOf(w.docs.get("sim_counters/log") ?? null),
    nowIso,
    cityActivitySeq: frozenActivity,
    docByPath: (path) => frozen.get(path) ?? null,
  };

  for (const candidate of candidates) {
    result.evaluated += 1;
    const pendingId = candidate.pendingId as string;
    const verdict = evaluateRipeness(candidate, view);
    if (verdict.state === "waiting") continue;
    if (result.events >= SCAN_RIPEN_CAP) break;
    const spec = candidate.payloadSpec as Record<string, unknown>;
    if (verdict.state === "ripe" && spec.mode === "generative" && !opts.prepared?.has(pendingId)) {
      result.skippedUnprepared.push(pendingId);
      continue;
    }
    const pendingNow = w.docs.get(`sim_pending_consequences/${pendingId}`) ?? candidate;
    let finalVerdict: RipenessVerdict = verdict;
    if (opts.guard) {
      // P4-K20 (landed as E2 at the close-out): re-evaluate the AGR
      // predicates against the claimed (fresh) snapshot before
      // resolving. The engine additionally re-checks inside the
      // commit transaction; this mirror models the scan-side half.
      const freshView: RipenessView = {
        currentSeq: resolvedSeqOf(w.docs.get("sim_counters/log") ?? null),
        nowIso,
        cityActivitySeq: liveActivity(w, activityCities),
        docByPath: (path) => w.docs.get(path) ?? null,
      };
      finalVerdict = evaluateRipeness(pendingNow, freshView);
      if (finalVerdict.state === "waiting") continue;
    }
    const paths = collectRipeningReadPaths(pendingNow);
    const docs = new Map(paths.map((p) => [p, w.docs.get(p) ?? null]));
    const snapshot = snapshotFromDocs(docs, nowIso);
    try {
      if (finalVerdict.state === "void") {
        const plan = resolveVoiding(snapshot, pendingNow, {
          baselineRegistry: fixtureRegistry,
          voidReason: finalVerdict.reason,
        });
        commitPlan(w, plan, nowIso, `void_${pendingId}`);
        result.voided.push(pendingId);
        result.events += 1;
      } else if (finalVerdict.state === "ripe") {
        const plan = resolveRipening(snapshot, pendingNow, {
          baselineRegistry: fixtureRegistry,
          prepared: opts.prepared?.get(pendingId),
        });
        commitPlan(w, plan, nowIso, `ripen_${pendingId}`);
        result.ripened.push(pendingId);
        result.events += 1;
      }
    } catch (err) {
      // The landed scan catches, releases the claim with a failure
      // code, and burns one attempt (needsAttention at the cap).
      const code = (err as { code?: string }).code ?? "RESOLUTION_FAILED";
      result.failed.push({ pendingId, code });
      const doc = w.docs.get(`sim_pending_consequences/${pendingId}`);
      if (doc) {
        const attempts = (doc.attempts as number) + 1;
        w.docs.set(`sim_pending_consequences/${pendingId}`, {
          ...doc,
          attempts,
          needsAttention: attempts >= 3 ? true : doc.needsAttention,
          lastFailure: { at: nowIso, code },
        });
      }
    }
  }
  return result;
}

const cityStats = (w: World, cityId: string): Record<string, unknown> =>
  (w.docs.get(`sim_cities/${cityId}`)?.stats ?? {}) as Record<string, unknown>;
const pendingDoc = (w: World, pendingId: string) => w.docs.get(`sim_pending_consequences/${pendingId}`);
const worldJson = (w: World): string =>
  JSON.stringify(
    [...w.docs.entries()].sort(([a], [b]) => a.localeCompare(b)),
    null,
    0
  );

const T0 = "2026-10-20T00:00:00.000Z";
const hoursLater = (iso: string, hours: number): string =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

// ---------------------------------------------------------------------------
// Seed stats (each city's eight indices sum to exactly 400 — the
// Season-0 even start; the growth audit sections rely on it)
// ---------------------------------------------------------------------------

const statsOf = (over: Record<string, number | null>): Record<string, number | null> => ({
  spirit: 50, culture: 50, infrastructure: 50, stability: 50,
  law: 50, influence: 50, military: 50, defense: 50,
  households: 0, housingUnits: 0, treasuryRubars: 0,
  population: null, gdpRubars: null,
  ...over,
});

// ---------------------------------------------------------------------------
// THE CANONICAL CASE (CJ's own example, brief §9.3): a member funds
// innovation -> a simulation delay (ripening, never a clock) -> a
// fully detailed brand-new invention generating X money, traced in
// the Log to the fund action.
// ---------------------------------------------------------------------------

const INVENTION_TEXT =
  "The Aetheric Condenser Array. Inventor: Mara Venn, a dockside instrument-maker in Cascadia's Foundry Ward, working from the fund's published brief. " +
  "The Array is a lattice of counter-rotating copper vanes set over the harbor's tidal race; it condenses atmospheric brine into potable water and " +
  "saleable salt at a measured 41 liters per vane-hour, drawing no fuel beyond the tide itself. First production run: 38 units fabricated in Ward " +
  "shops; licensing to two Chess City waterworks plus direct sales booked 1,150,000 R in its first season — inside the fund's published band " +
  "(1–2,000,000 R). Traced to the fund action by causedBySeq on every entry of this ripening.";

interface CanonicalRun {
  w: World;
  pendingId: string;
  originSeq: number;
  planHashes: string[];
  ripeningEntries: CommittedEntry[];
}

function runCanonical(): CanonicalRun {
  actionCounter = 0; // identical action ids across runs — replay determinism is measured, not assumed
  const w = newWorld();
  seedCity(w, "cascadia", "cj", statsOf({
    spirit: 55, culture: 60, infrastructure: 62, stability: 55,
    law: 48, influence: 45, military: 40, defense: 35,
    households: 40000, housingUnits: 38000, treasuryRubars: 3_000_000,
    population: 120000, gdpRubars: 900_000_000,
  }), ["connection:chess-city:live"]);
  seedCity(w, "chess-city", "keaton", statsOf({
    households: 10000, housingUnits: 9000, treasuryRubars: 500_000,
    population: 50000, gdpRubars: 100_000_000,
  }));
  const planHashes: string[] = [];

  // -- Step 1: CJ establishes the innovation fund --------------------
  const establish = runAction(w, act("establish_fund", "cj", {
    cityId: "cascadia",
    fundId: "aetheric-innovation-fund",
    fundName: "Aetheric Innovation Fund",
    purposeKind: "innovation-breakthrough",
    mode: "generative",
    amountRubars: 2_000_000,
  }, "Establish the Aetheric Innovation Fund"), T0);
  assert.equal(establish.plan.outcome, "resolved", "canonical establish resolves");
  planHashes.push(establish.plan.planHash);
  const originSeq = establish.entries[establish.entries.length - 1].seq;
  const pending = [...w.docs.values()].find((d) => d.kind === "innovation-breakthrough");
  assert.ok(pending, "the fund's pending consequence exists");
  const realPendingId = pending.pendingId as string;

  check("canonical: fund commitment moves treasury -> fund, in full, in one event", () => {
    assert.equal(cityStats(w, "cascadia").treasuryRubars, 1_000_000);
    const fund = w.docs.get(fundPath("cascadia", "aetheric-innovation-fund"));
    assert.ok(fund);
    assert.equal(fund.status, "active");
    assert.equal(fund.committedRubars, 2_000_000);
    assert.equal(fund.remainingRubars, 2_000_000);
    assert.equal(fund.disbursedRubars, 0);
    assert.equal((fund.terms as Record<string, unknown>).dissolutionReturn, "treasury");
  });

  check("canonical: delay is DERIVED by the landed formula and disclosed in the Log", () => {
    const expected = deriveDelay({
      baseHours: 48, fundSize: 2_000_000, referenceFund: 1_500_000,
      infrastructure: 62, connected: true,
    });
    assert.equal(expected.minWallElapsedHours, 36);
    assert.equal(expected.minSeqAdvance, 6);
    assert.deepEqual(pending.delayDerivation, expected);
    const rc = pending.ripenCondition as Record<string, unknown>;
    assert.equal(rc.requiredSeq, originSeq + 6);
    assert.equal(rc.eligibleAt, hoursLater(T0, 36));
    assert.deepEqual(rc.requiresActionInCities, ["cascadia"]);
    const pcs = rc.preconditions as Record<string, unknown>[];
    assert.equal(pcs.length, 2);
    assert.ok(pcs.every((pc) => pc.onFalse === "void"));
    const scheduleEntry = establish.entries.find((e) => e.pendingId === realPendingId && !e.summary);
    assert.ok(scheduleEntry?.summaryText.includes("36h"), "schedule entry discloses the derived delay");
    assert.ok(establish.plan.planHash.length > 0);
  });

  // -- Invariant 1: frozen world with pendings live ------------------
  check("P4-G9.1 frozen world: 30 days pass, no actions — nothing ripens, world byte-identical", () => {
    const before = worldJson(w);
    const logBefore = w.log.length;
    for (let i = 0; i < 3; i += 1) {
      const pass = runScanPass(w, hoursLater(T0, 24 * 30));
      assert.deepEqual(pass.ripened, []);
      assert.deepEqual(pass.voided, []);
    }
    const verdict = evaluateRipeness(pendingDoc(w, realPendingId)!, {
      currentSeq: w.seq,
      nowIso: hoursLater(T0, 24 * 30),
      cityActivitySeq: new Map([["cascadia", SEED_SEQ]]),
      docByPath: (p) => w.docs.get(p) ?? null,
    });
    assert.equal(verdict.state, "waiting");
    if (verdict.state === "waiting") {
      assert.ok(verdict.blockers.some((b) => b.includes("needs")), "seq gate still blocks (time alone never ripens)");
      assert.ok(verdict.blockers.some((b) => b.includes("no action yet")), "activity gate still blocks");
    }
    assert.equal(worldJson(w), before);
    assert.equal(w.log.length, logBefore);
  });

  // -- Step 2: unrelated play advances the realm seq ------------------
  for (let i = 0; i < 5; i += 1) {
    const lore = runAction(w, act("post_lore", "keaton", { cityId: "chess-city" }, `Keaton posts Chess City lore (${i + 1})`), hoursLater(T0, 24 * 30));
    assert.equal(lore.plan.outcome, "resolved");
    const pass = runScanPass(w, hoursLater(T0, 24 * 30));
    assert.deepEqual(pass.ripened, [], "a Chess City occasion alone ripens nothing for Cascadia's fund");
  }
  check("canonical: five foreign actions later, the fund still waits (seq + activity gates)", () => {
    assert.equal(w.seq, originSeq + 5);
    const doc = pendingDoc(w, realPendingId)!;
    assert.equal(doc.status, "pending");
  });

  // -- Step 3: a later player action IN Cascadia (the occasion) -------
  const capacity = runAction(w, act("start_capacity_project", "cj", {
    cityId: "cascadia", projectId: "cascadia-culture-capacity",
    capacityIndex: "culture", totalBudgetRubars: 900_000,
  }, "Start a culture capacity project"), hoursLater(T0, 24 * 30 + 1));
  assert.equal(capacity.plan.outcome, "resolved");
  planHashes.push(capacity.plan.planHash);
  const wakeSeq = capacity.entries[capacity.entries.length - 1].seq;
  check("canonical: the occasioning action is ordinary play in the host city (R-36 start)", () => {
    assert.equal(cityStats(w, "cascadia").treasuryRubars, 700_000);
    const project = w.docs.get(capacityProjectPath("cascadia", "cascadia-culture-capacity"));
    assert.equal(project?.workUnitsRequired, 3, "culture 60 bands 3 work units");
    assert.equal(project?.workUnitsDone, 1);
    assert.equal(project?.status, "under-construction");
  });

  // -- Step 4: the wake's scan ripens the breakthrough ----------------
  const prepared = new Map<string, PreparedPayload>([
    [realPendingId, {
      inputHash: "prepared-aetheric-001",
      generatedContent: {
        creditRubars: 1_150_000,
        // E5 (Phase 4 close-out): the generation contract carries the
        // disbursement figure; the fund books it at ripening.
        disbursementRubars: 1_150_000,
        summaryText: INVENTION_TEXT,
        seed: "seed-aetheric-1",
        childBriefs: [],
      },
    }],
  ]);
  const pass = runScanPass(w, hoursLater(T0, 24 * 30 + 1), { prepared, guard: true });
  assert.deepEqual(pass.ripened, [realPendingId], "the breakthrough ripens in the occasioned wake");
  const ripeningEntries = w.log.filter((e) => e.pendingId === realPendingId && e.seq > wakeSeq);
  planHashes.push("ripening-committed");

  check("canonical: the invention lands — X money, fully detailed, inside the published band", () => {
    assert.equal(cityStats(w, "cascadia").treasuryRubars, 1_850_000, "700,000 + 1,150,000 credited");
    const summary = ripeningEntries.find((e) => e.summary);
    assert.ok(summary, "ripening carries a summary entry");
    assert.equal(summary.summaryText, INVENTION_TEXT, "the detailed invention IS the ripening's Log summary");
    const r33 = ripeningEntries.find((e) => e.ruleIds.includes("R-33") && !e.summary);
    assert.ok(r33);
    const credit = r33.changes.find((c) => c.field === "stats.treasuryRubars");
    assert.deepEqual([credit?.before, credit?.after], [700_000, 1_850_000]);
    assert.equal(r33.generation?.boundsChecked, true);
    assert.equal(r33.generation?.preparedBy, "worker");
    const doc = pendingDoc(w, realPendingId)!;
    assert.equal(doc.status, "ripened");
    assert.equal(doc.ripenedAtSeq, w.seq);
  });

  check("P4-G9.3 cause vs occasion: every ripening entry cites the FUND's seq, never the wake's", () => {
    assert.ok(ripeningEntries.length >= 3, "R-33 effect + R-34 findings + summary");
    for (const entry of ripeningEntries) {
      assert.equal(entry.causedBySeq, originSeq, `entry at seq ${entry.seq} traces to the fund action`);
      assert.notEqual(entry.causedBySeq, wakeSeq, "the occasioning action is never the cause");
    }
    const doc = pendingDoc(w, realPendingId)!;
    assert.ok(String(doc.originSummaryText).includes("Aetheric"), "the pending itself names its origin act");
  });

  check("P4-G9.7 channel honesty (positive): R-34 findings travel only the recorded connection", () => {
    const r34 = ripeningEntries.find((e) => e.ruleIds.includes("R-34"));
    assert.ok(r34, "fund pendings carry trickleDown: true, so the R-34 evaluation is on the record");
    const findings = (r34.classification as Record<string, unknown>).trickleDownFindings as unknown[];
    assert.equal(findings.length, 1, "exactly the one live connection trait in state — no template list");
    assert.ok(JSON.stringify(findings).includes("chess-city"));
    assert.deepEqual(r34.changes, [], "information-only: no mechanical effect rides the finding");
  });

  check("E5 closed (close-out): generative ripening books the fund disbursement", () => {
    const fund = w.docs.get(fundPath("cascadia", "aetheric-innovation-fund"))!;
    assert.equal(fund.disbursedRubars, 1_150_000, "the prepared disbursement figure books at ripening, as in determinate mode");
    assert.equal(fund.remainingRubars, 850_000, "2,000,000 fund - 1,150,000 disbursed");
  });

  return { w, pendingId: realPendingId, originSeq, planHashes, ripeningEntries };
}

section("Canonical case — CJ's innovation fund, end to end");
const canonical = runCanonical();

section("P4-G9.5 determinism / replay");
check("the canonical flow replays hash-equal and state-equal from identical inputs", () => {
  const replay = runCanonical();
  assert.deepEqual(replay.planHashes, canonical.planHashes);
  assert.equal(worldJson(replay.w), worldJson(canonical.w));
  assert.deepEqual(
    replay.ripeningEntries.map((e) => [e.seq, e.summaryText]),
    canonical.ripeningEntries.map((e) => [e.seq, e.summaryText])
  );
});

section("P4-G9.8 prototype parity — the same verbs on a sparse, unconnected city");
check("citySparse: identical shape, different derivation; zero propagation artifacts (no channels)", () => {
  const w = newWorld();
  seedCity(w, "citySparse", "wes", statsOf({
    infrastructure: 10, households: 10, housingUnits: 8,
    treasuryRubars: 300_000, population: 900, gdpRubars: null,
  }));
  const establish = runAction(w, act("establish_fund", "wes", {
    cityId: "citySparse", fundId: "sparse-innovation", fundName: "Sparse Innovation Fund",
    purposeKind: "innovation-breakthrough", mode: "generative", amountRubars: 100_000,
  }), T0);
  assert.equal(establish.plan.outcome, "resolved");
  const pending = [...w.docs.values()].find((d) => d.kind === "innovation-breakthrough")!;
  const derivation = pending.delayDerivation as Record<string, unknown>;
  assert.equal(derivation.infraFactor, 1.25, "unbuilt infrastructure is a slow city");
  assert.equal(derivation.connectivityFactor, 1.0, "no live connection");
  assert.equal(derivation.minWallElapsedHours, 88);
  assert.equal(derivation.minSeqAdvance, 15);
  // Drive the gates: 15 foreign seq + a writing action in citySparse.
  for (let i = 0; i < 15; i += 1) {
    runAction(w, act("post_lore", "wes", { cityId: "citySparse" }, `sparse lore ${i}`), hoursLater(T0, 90));
  }
  runAction(w, act("start_capacity_project", "wes", {
    cityId: "citySparse", projectId: "sparse-law", capacityIndex: "law", totalBudgetRubars: 1_000,
  }), hoursLater(T0, 90));
  const pendingId = pending.pendingId as string;
  const prepared = new Map<string, PreparedPayload>([
    [pendingId, { inputHash: "prepared-sparse-001", generatedContent: { creditRubars: 42_000, disbursementRubars: 42_000, summaryText: "A hand-cranked seed drill, built in a barn.", seed: "s", childBriefs: [] } }],
  ]);
  const pass = runScanPass(w, hoursLater(T0, 90), { prepared, guard: true });
  assert.deepEqual(pass.ripened, [pendingId]);
  // treasury: 300,000 − 100,000 (fund) − 333 (phase 1 of 3 on a 1,000 R
  // budget — R-05 phase formula) + 42,000 (the ripened credit)
  assert.equal(cityStats(w, "citySparse").treasuryRubars, 241_667);
  const r34 = w.log.find((e) => e.pendingId === pendingId && e.ruleIds.includes("R-34"));
  assert.ok(r34);
  assert.deepEqual(
    (r34.classification as Record<string, unknown>).trickleDownFindings, [],
    "no press, no connections in state => zero propagation artifacts produced"
  );
});

// ---------------------------------------------------------------------------
// Determinate fund: the fundPath disbursement bookkeeping lands
// ---------------------------------------------------------------------------

section("Determinate fund — ripening books the fund (disbursed/remaining)");
check("innovation-breakthrough (determinate): disbursement + stated effect, traced to origin", () => {
  const w = newWorld();
  seedCity(w, "cityB", "dana", statsOf({
    spirit: 60, culture: 55, infrastructure: 20, stability: 65,
    law: 45, influence: 55, military: 55, defense: 45,
    households: 20000, housingUnits: 19000, treasuryRubars: 2_000_000,
    population: 80000, gdpRubars: 200_000_000,
  }));
  const establish = runAction(w, act("establish_fund", "dana", {
    cityId: "cityB", fundId: "det-fund", fundName: "Determinate Innovation Fund",
    purposeKind: "innovation-breakthrough", mode: "determinate", amountRubars: 1_000_000,
    disbursementRubars: 640_000, effectField: "stats.gdpRubars", effectDelta: 5_000_000,
  }), T0);
  assert.equal(establish.plan.outcome, "resolved");
  const originSeq = establish.entries[establish.entries.length - 1].seq;
  const pending = [...w.docs.values()].find((d) => d.kind === "innovation-breakthrough")!;
  const derivation = pending.delayDerivation as Record<string, unknown>;
  assert.equal(derivation.minWallElapsedHours, 70, "48h x 1.1667 (fund scale) x 1.25 (infra 20) x 1.0");
  assert.equal(derivation.minSeqAdvance, 12);
  const pendingId = pending.pendingId as string;

  // Activity in cityB (a capacity project that completes: infra 20 -> 22)
  const growth = runAction(w, act("start_capacity_project", "dana", {
    cityId: "cityB", projectId: "cityB-infra", capacityIndex: "infrastructure", totalBudgetRubars: 50_000,
  }), hoursLater(T0, 80));
  assert.equal(growth.plan.outcome, "resolved");
  assert.equal(cityStats(w, "cityB").infrastructure, 22);
  for (let i = 0; i < 8; i += 1) {
    runAction(w, act("post_lore", "dana", { cityId: "cityB" }, `cityB lore ${i}`), hoursLater(T0, 80));
  }
  const pass = runScanPass(w, hoursLater(T0, 80), { guard: true });
  assert.deepEqual(pass.ripened, [pendingId]);
  const fund = w.docs.get(fundPath("cityB", "det-fund"))!;
  assert.equal(fund.disbursedRubars, 640_000, "the disbursement the terms published");
  assert.equal(fund.remainingRubars, 360_000);
  assert.equal(cityStats(w, "cityB").gdpRubars, 205_000_000, "the stated determinate effect landed");
  assert.equal(cityStats(w, "cityB").treasuryRubars, 950_000, "treasury untouched by the ripening (the effect was GDP; the disbursement books the fund)");
  const r33 = w.log.find((e) => e.pendingId === pendingId && e.ruleIds.includes("R-33") && !e.summary)!;
  assert.equal(r33.causedBySeq, originSeq);
  const disb = r33.changes.find((c) => c.field === "funds/det-fund.disbursedRubars");
  assert.deepEqual([disb?.before, disb?.after], [0, 640_000], "target-qualified fund change lines (TC-E02)");
});

// ---------------------------------------------------------------------------
// Dissolution (product verb) — the fund's pending VOIDS, never ripens
// ---------------------------------------------------------------------------

section("Dissolution — P4-K20's posture through the product verbs");
check("dissolve returns unspent Rubars; the breakthrough voids at its next evaluation", () => {
  const w = newWorld();
  seedCity(w, "cityD", "evan", statsOf({
    households: 5000, housingUnits: 4500, treasuryRubars: 800_000,
    population: 30000, gdpRubars: 50_000_000,
  }));
  const establish = runAction(w, act("establish_fund", "evan", {
    cityId: "cityD", fundId: "doomed-fund", fundName: "Doomed Fund",
    purposeKind: "innovation-breakthrough", mode: "generative", amountRubars: 500_000,
  }), T0);
  assert.equal(establish.plan.outcome, "resolved");
  const originSeq = establish.entries[establish.entries.length - 1].seq;
  const pendingId = ([...w.docs.values()].find((d) => d.kind === "innovation-breakthrough")!).pendingId as string;
  assert.equal(cityStats(w, "cityD").treasuryRubars, 300_000);

  const dissolve = runAction(w, act("dissolve_fund", "evan", { cityId: "cityD", fundId: "doomed-fund" }), hoursLater(T0, 1));
  assert.equal(dissolve.plan.outcome, "resolved");
  assert.equal(cityStats(w, "cityD").treasuryRubars, 800_000, "unspent commitment returned in the same event");
  const fund = w.docs.get(fundPath("cityD", "doomed-fund"))!;
  assert.equal(fund.status, "dissolved");
  assert.equal(fund.remainingRubars, 0);
  expectRejected(runAction(w, act("dissolve_fund", "evan", { cityId: "cityD", fundId: "doomed-fund" }), hoursLater(T0, 2)).plan, "FUND_NOT_ACTIVE");
  expectRejected(runAction(w, act("dissolve_fund", "mallory", { cityId: "cityD", fundId: "doomed-fund" }), hoursLater(T0, 2)).plan, "AUTHORITY_REVOKED");

  // Drive every other gate open; the fund-status precondition ends it.
  for (let i = 0; i < 12; i += 1) {
    runAction(w, act("post_lore", "evan", { cityId: "cityD" }, `cityD lore ${i}`), hoursLater(T0, 100));
  }
  const prepared = new Map<string, PreparedPayload>([
    [pendingId, { inputHash: "prepared-doomed", generatedContent: { creditRubars: 400_000, summaryText: "Never built.", seed: "x", childBriefs: [] } }],
  ]);
  const pass = runScanPass(w, hoursLater(T0, 100), { prepared, guard: true });
  assert.deepEqual(pass.ripened, [], "a dissolved fund's breakthrough NEVER ripens");
  assert.deepEqual(pass.voided, [pendingId]);
  const doc = pendingDoc(w, pendingId)!;
  assert.equal(doc.status, "voided");
  assert.ok(String(doc.voidReason).includes("precondition"), "the voiding states which precondition failed");
  assert.ok(String(doc.voidReason).includes(fundPath("cityD", "doomed-fund")), "and cites the record that changed");
  assert.equal(cityStats(w, "cityD").treasuryRubars, 800_000, "no invention money materialized");
  const voidEntries = w.log.filter((e) => e.pendingId === pendingId && e.seq > originSeq);
  assert.ok(voidEntries.length >= 2);
  assert.ok(voidEntries.every((e) => e.causedBySeq === originSeq), "the voiding also traces to the fund action");
  // Undo-matrix structure (P4-G9.6): nothing was erased — the origin
  // event stands in the Log, the fund record stands (dissolved), the
  // pending stands (voided). Erasure is undo's business, gated on
  // dependencies; a voiding is a resolution, not an erasure (P2-K5).
  assert.ok(w.log.some((e) => e.seq === originSeq), "origin event intact in the standing Log");
  assert.ok(w.docs.has(fundPath("cityD", "doomed-fund")), "fund record stands");
});

// ---------------------------------------------------------------------------
// F-05 / P4-K20 — the one-pass case: two pendings, one fund. The
// first ripening exhausts the fund; the second pending's precondition
// dies INSIDE the same pass. Pre-close-out scan semantics evaluated
// verdicts against pass-start docs and resolveRipening never
// re-checked: the second pending ripened off the exhausted fund.
// The close-out lands the guard in the engine (E2): scanRipeness
// re-evaluates on the claimed snapshot, and the committer re-checks
// in-transaction. The mini scan below models the CLAIMED-snapshot
// re-evaluation (guard flag) and its pre-close-out absence.
// ---------------------------------------------------------------------------

function insertPending(
  w: World,
  doc: Record<string, unknown>,
  originSeq: number,
  createdAtSeq: number,
  nowIso: string
): void {
  const out: Record<string, unknown> = { ...doc };
  out.originSeq = originSeq;
  out.createdAtSeq = createdAtSeq;
  out.createdBySeq = out.sourceKind === "ripening" ? createdAtSeq : null;
  out.createdAt = nowIso;
  out.updatedAt = nowIso;
  const rc = { ...(out.ripenCondition as Record<string, unknown>) };
  // E1 anchoring mirror: creation-anchored, as in the committer
  // (identical here — this factory is always called with
  // originSeq == createdAtSeq).
  rc.requiredSeq = createdAtSeq + (rc.minSeqAdvance as number);
  rc.eligibleAt = hoursLater(nowIso, rc.minWallElapsedHours as number);
  out.ripenCondition = rc;
  w.docs.set(`sim_pending_consequences/${out.pendingId as string}`, out);
}

function buildSharedFundWorld(): { w: World; breakId: string; exhaustId: string } {
  const w = newWorld();
  seedCity(w, "cityE", "ownerE", statsOf({
    households: 100, housingUnits: 90, treasuryRubars: 1_000_000, population: 2000,
  }));
  const fPath = fundPath("cityE", "shared-fund");
  w.docs.set(fPath, {
    schemaVersion: 2, kind: "fund", cityId: "cityE", name: "Shared Fund",
    committedRubars: 300_000, initialRubars: 300_000, remainingRubars: 300_000,
    disbursedRubars: 0, status: "active", createdByResolutionId: "seed",
    createdAt: null, stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
  });
  const snapshot = snapshotFromDocs(new Map(w.docs), T0);
  const actor = memberActor("ownerE");
  const exhaust = buildPendingDraft(snapshot, {
    pendingId: "pend_shared_01",
    kind: "delayed-stat-effect",
    originResolutionId: "seed_resolution",
    originActionId: null,
    originActor: actor,
    originCityId: "cityE",
    originSummaryText: "Shared fund scheduled payout",
    targetCityId: "cityE",
    sourceKind: "action",
    generation: 1,
    chainId: "pend_shared_01",
    chainRootPendingId: null,
    createdByResolutionId: null,
    payloadSpec: {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "cityE", field: "stats.spirit", delta: 1 },
      fundPath: fPath,
      fundDisbursementRubars: 300_000,
      summaryOnRipen: "The shared fund pays out in full.",
      preconditions: fundPreconditions(fPath),
      requiresActionInCities: [],
    },
    fundSize: null,
  });
  const breakthrough = buildPendingDraft(snapshot, {
    pendingId: "pend_shared_02",
    kind: "innovation-breakthrough",
    originResolutionId: "seed_resolution",
    originActionId: null,
    originActor: actor,
    originCityId: "cityE",
    originSummaryText: "Shared fund breakthrough",
    targetCityId: "cityE",
    sourceKind: "action",
    generation: 1,
    chainId: "pend_shared_02",
    chainRootPendingId: null,
    createdByResolutionId: null,
    payloadSpec: {
      mode: "generative",
      bounds: { minRubars: 1, maxRubars: 300_000 },
      trickleDown: false,
      fundPath: fPath,
      preconditions: fundPreconditions(fPath),
      requiresActionInCities: [],
    },
    fundSize: 300_000,
  });
  insertPending(w, exhaust.draft.doc, SEED_SEQ, SEED_SEQ, T0);
  insertPending(w, breakthrough.draft.doc, SEED_SEQ, SEED_SEQ, T0);
  for (let i = 0; i < 11; i += 1) {
    runAction(w, act("post_lore", "ownerE", { cityId: "cityE" }, `cityE lore ${i}`), hoursLater(T0, 200));
  }
  return { w, breakId: "pend_shared_02", exhaustId: "pend_shared_01" };
}

section("F-05 / P4-K20 — one pass, two pendings, one fund");
check("guard OFF (no re-evaluation): E5's fund validation stops the money, but as the WRONG outcome — a burned attempt, not a voiding", () => {
  const { w, breakId, exhaustId } = buildSharedFundWorld();
  const prepared = new Map<string, PreparedPayload>([
    [breakId, { inputHash: "prepared-shared", generatedContent: { creditRubars: 250_000, disbursementRubars: 250_000, summaryText: "An invention the fund can no longer pay for.", seed: "s", childBriefs: [] } }],
  ]);
  const treasuryBefore = cityStats(w, "cityE").treasuryRubars as number;
  const pass = runScanPass(w, hoursLater(T0, 200), { prepared, guard: false });
  assert.deepEqual(pass.ripened, [exhaustId], "only the determinate payout ripens");
  const fund = w.docs.get(fundPath("cityE", "shared-fund"))!;
  assert.equal(fund.remainingRubars, 0, "the first ripening exhausted the fund mid-pass");
  assert.equal(
    cityStats(w, "cityE").treasuryRubars, treasuryBefore,
    "the stale ripening cannot credit: its disbursement exceeds the exhausted fund (E5 validation, fresh per-candidate snapshot)"
  );
  assert.deepEqual(
    pass.failed, [{ pendingId: breakId, code: "RIPENING_PREPARATION" }],
    "but without the guard the world records a generation FAILURE — the pending stays pending and burns an attempt, where the truth is a voiding"
  );
  const doc = pendingDoc(w, breakId)!;
  assert.equal(doc.status, "pending");
  assert.equal(doc.attempts, 1);
});
check("guard ON (P4-K20 contract, landed as E2): the second pending VOIDS in the same pass — never ripens", () => {
  const { w, breakId, exhaustId } = buildSharedFundWorld();
  const prepared = new Map<string, PreparedPayload>([
    [breakId, { inputHash: "prepared-shared", generatedContent: { creditRubars: 250_000, disbursementRubars: 250_000, summaryText: "An invention the fund can no longer pay for.", seed: "s", childBriefs: [] } }],
  ]);
  const treasuryBefore = cityStats(w, "cityE").treasuryRubars as number;
  const pass = runScanPass(w, hoursLater(T0, 200), { prepared, guard: true });
  assert.deepEqual(pass.ripened, [exhaustId]);
  assert.deepEqual(pass.voided, [breakId], "re-evaluation on the claimed snapshot converts it to a voiding");
  assert.equal(cityStats(w, "cityE").treasuryRubars, treasuryBefore, "no money materialized from the exhausted fund");
  const doc = pendingDoc(w, breakId)!;
  assert.equal(doc.status, "voided");
  assert.ok(String(doc.voidReason).includes("remainingRubars"), "the voiding names the precondition that died mid-pass");
  assert.equal(cityStats(w, "cityE").spirit, 51, "the lawful first ripening still landed");
});

// ---------------------------------------------------------------------------
// Bounds fidelity + generation failure + fan-out slice (F-12 rows)
// ---------------------------------------------------------------------------

section("Bounds fidelity, silent generation failure, fan-out slice (P4-G9.4 + F-12)");
check("out-of-bounds preparations fail silently; in-bounds ripens; 6 child briefs slice to 4 with the cap on the record", () => {
  const w = newWorld();
  seedCity(w, "cityF", "ownerF", statsOf({
    households: 100, housingUnits: 90, treasuryRubars: 5_000_000, population: 2000,
  }));
  const establish = runAction(w, act("establish_fund", "ownerF", {
    cityId: "cityF", fundId: "fan-fund", fundName: "Fan Fund",
    purposeKind: "innovation-breakthrough", mode: "generative", amountRubars: 100_000,
    requiresActionInCities: [],
  }), T0);
  assert.equal(establish.plan.outcome, "resolved");
  const originSeq = establish.entries[establish.entries.length - 1].seq;
  const pendingId = ([...w.docs.values()].find((d) => d.kind === "innovation-breakthrough")!).pendingId as string;
  for (let i = 0; i < 12; i += 1) {
    runAction(w, act("post_lore", "ownerF", { cityId: "cityF" }, `cityF lore ${i}`), hoursLater(T0, 80));
  }
  const childBrief = (n: number) => ({
    kind: "delayed-stat-effect",
    targetCityId: "cityF",
    payloadSpec: {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "cityF", field: "stats.culture", delta: 1 },
    },
    summaryText: `child brief ${n}`,
  });

  // (a) above the stored max — bounds re-derived from the CREATION spec
  const logBefore = w.log.length;
  const failHigh = runScanPass(w, hoursLater(T0, 80), {
    prepared: new Map([[pendingId, { inputHash: "p-high", generatedContent: { creditRubars: 100_001, summaryText: "too big", seed: "s", childBriefs: [] } }]]),
    guard: true,
  });
  assert.equal(failHigh.failed.length, 1);
  assert.equal(failHigh.failed[0].code, "RIPENING_PREPARATION");
  assert.deepEqual(failHigh.ripened, []);
  assert.equal(w.log.length, logBefore, "a generation failure writes NO Log entry (silent, retried)");
  assert.equal(pendingDoc(w, pendingId)!.status, "pending");
  assert.equal(pendingDoc(w, pendingId)!.attempts, 1);

  // (b) below the stored min
  const failLow = runScanPass(w, hoursLater(T0, 80), {
    prepared: new Map([[pendingId, { inputHash: "p-low", generatedContent: { creditRubars: 0, summaryText: "too small", seed: "s", childBriefs: [] } }]]),
    guard: true,
  });
  assert.equal(failLow.failed.length, 1);
  assert.equal(pendingDoc(w, pendingId)!.attempts, 2);
  const spec = pendingDoc(w, pendingId)!.payloadSpec as Record<string, unknown>;
  assert.deepEqual(spec.bounds, { minRubars: 1, maxRubars: 100_000 }, "bounds are the creation-time spec, untouched by failures or current state");

  // (c) in bounds, with 6 child briefs — fan-out slices BEFORE creation
  const okPass = runScanPass(w, hoursLater(T0, 80), {
    prepared: new Map([[pendingId, {
      inputHash: "p-ok",
      generatedContent: {
        creditRubars: 50_000, disbursementRubars: 50_000, summaryText: "A modest, real invention.", seed: "s",
        childBriefs: [childBrief(1), childBrief(2), childBrief(3), childBrief(4), childBrief(5), childBrief(6)],
      },
    }]]),
    guard: true,
  });
  assert.deepEqual(okPass.ripened, [pendingId]);
  const children = [...w.docs.values()].filter((d) => d.chainId === pendingId && d.pendingId !== pendingId);
  assert.equal(children.length, PENDING_FANOUT_CAP, "exactly the fan-out cap of children was created");
  assert.ok(children.every((c) => c.generation === 2));
  assert.ok(children.every((c) => c.originSeq === originSeq), "children inherit the chain origin seq");
  const capEntry = w.log.find((e) => (e.classification as Record<string, unknown> | null)?.capReached === true);
  assert.ok(capEntry, "the trimmed fan-out is on the record as a cap entry (F-12 posture)");
  // E1 landed (close-out): child requiredSeq anchors to the child's
  // CREATION seq (P4-K19) — originSeq remains pure attribution (the
  // assertion above: children still inherit the chain origin seq).
  const child = children[0];
  const rc = child.ripenCondition as Record<string, unknown>;
  assert.equal(rc.requiredSeq, (child.createdAtSeq as number) + (rc.minSeqAdvance as number),
    "child delay anchors to its CREATION seq (P4-K19, landed as E1)");
  assert.ok((rc.requiredSeq as number) > (child.createdAtSeq as number),
    "so a generation-2 child can no longer be seq-ripe the moment it exists");
});

check("generation cap: a generation-3 ripening schedules NO children, cap on the record", () => {
  const w = newWorld();
  seedCity(w, "cityG", "ownerG", statsOf({ treasuryRubars: 10_000 }));
  const snapshot = snapshotFromDocs(new Map(w.docs), T0);
  const { draft } = buildPendingDraft(snapshot, {
    pendingId: "pend_gen3",
    kind: "delayed-stat-effect",
    originResolutionId: "seed_resolution",
    originActionId: null,
    originActor: memberActor("ownerG"),
    originCityId: "cityG",
    originSummaryText: "gen-3 pending",
    targetCityId: "cityG",
    sourceKind: "ripening",
    generation: 3,
    chainId: "pend_gen1",
    chainRootPendingId: "pend_gen1",
    createdByResolutionId: "seed_resolution",
    payloadSpec: {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "cityG", field: "stats.spirit", delta: 1 },
      childPendings: [{
        kind: "delayed-stat-effect",
        targetCityId: "cityG",
        payloadSpec: { mode: "determinate", effect: { type: "stat-delta", cityId: "cityG", field: "stats.spirit", delta: 1 } },
      }],
    },
    fundSize: null,
  });
  insertPending(w, draft.doc, SEED_SEQ, SEED_SEQ, T0);
  const doc = pendingDoc(w, "pend_gen3")!;
  const paths = collectRipeningReadPaths(doc);
  const snap = snapshotFromDocs(new Map(paths.map((p) => [p, w.docs.get(p) ?? null])), T0);
  const plan = resolveRipening(snap, doc, { baselineRegistry: fixtureRegistry });
  assert.equal(plan.pendingCreates.length, 0, "generation 4 does not happen");
  assert.ok(
    plan.entries.some((e) => (e.classification as Record<string, unknown> | null)?.capReached === true),
    "the generation cap is logged, not silent"
  );
});

// ---------------------------------------------------------------------------
// Growth — R-36 battery + the P4-G7 audit identity
// ---------------------------------------------------------------------------

section("R-36 capacity growth — bands, phases, completion, clamp");
check("work-unit bands at every boundary (P4-G7)", () => {
  assert.equal(capacityWorkUnitsFor(0), 1);
  assert.equal(capacityWorkUnitsFor(24), 1);
  assert.equal(capacityWorkUnitsFor(25), 2);
  assert.equal(capacityWorkUnitsFor(49), 2);
  assert.equal(capacityWorkUnitsFor(50), 3);
  assert.equal(capacityWorkUnitsFor(74), 3);
  assert.equal(capacityWorkUnitsFor(75), 4);
  assert.equal(capacityWorkUnitsFor(99), 4);
  assert.equal(capacityWorkUnitsFor(100), null, "at cap: no lawful project");
  assert.equal(capacityWorkUnitsFor(null), null, "unset: the engine invents no band");
});

check("full lifecycle: start pays phase 1, advance completes, +2 lands with the running sum", () => {
  const w = newWorld();
  seedCity(w, "cityC", "ownerC", statsOf({
    culture: 25, infrastructure: 75, households: 100, housingUnits: 90,
    treasuryRubars: 100_000, population: 2000,
  }));
  const start = runAction(w, act("start_capacity_project", "ownerC", {
    cityId: "cityC", projectId: "culture-works", capacityIndex: "culture", totalBudgetRubars: 10_001,
  }), T0);
  assert.equal(start.plan.outcome, "resolved");
  let project = w.docs.get(capacityProjectPath("cityC", "culture-works"))!;
  assert.equal(project.workUnitsRequired, 2, "culture 25 bands 2 work units");
  assert.equal(project.workUnitsDone, 1, "phase 1 (5,001 R of the 10,001 R budget) paid at start");
  assert.equal(project.paidRubars, 5_001);
  assert.equal(project.status, "under-construction");
  assert.equal(cityStats(w, "cityC").treasuryRubars, 94_999);
  assert.equal(cityStats(w, "cityC").culture, 25, "no growth before completion");

  const advance = runAction(w, act("advance_capacity_project", "ownerC", {
    cityId: "cityC", projectId: "culture-works",
  }), hoursLater(T0, 1));
  assert.equal(advance.plan.outcome, "resolved");
  project = w.docs.get(capacityProjectPath("cityC", "culture-works"))!;
  assert.equal(project.status, "complete");
  assert.equal(project.paidRubars, 10_001, "last phase takes the remainder (5,000 R)");
  assert.equal(cityStats(w, "cityC").culture, 27, "the +2 lands inside the completing event");
  assert.equal(indexSumOfStats(cityStats(w, "cityC") as Record<string, unknown>), 402);
  const completion = advance.entries.find((e) => e.summaryText.includes("completion"));
  assert.ok(completion?.summaryText.includes("running index-sum is now 402"), "the completion entry carries the running index-sum");
  expectRejected(runAction(w, act("advance_capacity_project", "ownerC", { cityId: "cityC", projectId: "culture-works" }), T0).plan, "NOTHING_TO_ADVANCE");
  expectRejected(runAction(w, act("start_capacity_project", "ownerC", { cityId: "cityC", projectId: "culture-works", capacityIndex: "law", totalBudgetRubars: 10 }), T0).plan, "PROJECT_EXISTS");
});

check("the +2 clamps at 100 (P4-G7)", () => {
  const w = newWorld();
  seedCity(w, "cityClamp", "ownerK", statsOf({
    spirit: 40, culture: 40, infrastructure: 40, stability: 40,
    law: 40, influence: 40, military: 61, defense: 99, treasuryRubars: 10_000,
  }));
  runAction(w, act("start_capacity_project", "ownerK", {
    cityId: "cityClamp", projectId: "defense-works", capacityIndex: "defense", totalBudgetRubars: 4,
  }), T0);
  let last: { plan: ResolutionPlan } | null = null;
  for (let i = 0; i < 3; i += 1) {
    last = runAction(w, act("advance_capacity_project", "ownerK", { cityId: "cityClamp", projectId: "defense-works" }), hoursLater(T0, i + 1));
  }
  assert.equal(last!.plan.outcome, "resolved");
  assert.equal(cityStats(w, "cityClamp").defense, 100, "99 + 2 clamps at the cap, never 101");
  const line = last!.plan.entries.flatMap((e) => e.changes).find((c) => c.field === "stats.defense");
  assert.equal(line?.after, 100);
  assert.ok(line?.formula.includes("clamped"), "the clamp is stated on the change line");
  expectRejected(runAction(w, act("start_capacity_project", "ownerK", {
    cityId: "cityClamp", projectId: "defense-2", capacityIndex: "defense", totalBudgetRubars: 10,
  }), T0).plan, "INDEX_AT_CAP");
});

check("budget class: a part-paid phase does not complete; the shortfall is logged", () => {
  const w = newWorld();
  seedCity(w, "cityShort", "ownerS", statsOf({ treasuryRubars: 100 }));
  const start = runAction(w, act("start_capacity_project", "ownerS", {
    cityId: "cityShort", projectId: "spirit-works", capacityIndex: "spirit", totalBudgetRubars: 9_999,
  }), T0);
  assert.equal(start.plan.outcome, "resolved");
  const project = w.docs.get(capacityProjectPath("cityShort", "spirit-works"))!;
  assert.equal(project.workUnitsDone, 0, "phase cost 3,333 R; only 100 R stood — the phase did not complete");
  assert.equal(project.status, "under-construction", "ground is broken by the confirming act itself");
  assert.equal(cityStats(w, "cityShort").treasuryRubars, 0);
  assert.ok(start.entries.some((e) => e.summaryText.includes("SHORTFALL 3233")), "the shortfall is on the record");
});

check("the 10%-of-treasury proposal flag rides the creation entry (a flag, not a refusal)", () => {
  const w = newWorld();
  seedCity(w, "cityFlag", "ownerL", statsOf({ treasuryRubars: 1_000 }));
  const start = runAction(w, act("start_capacity_project", "ownerL", {
    cityId: "cityFlag", projectId: "law-works", capacityIndex: "law", totalBudgetRubars: 500,
  }), T0);
  assert.equal(start.plan.outcome, "resolved");
  assert.ok(start.entries.some((e) => e.summaryText.includes("exceeds 10%")), "flag printed in the open");
});

section("Growth audit — the P4-G7 identity, recomputed from the standing Log");
check("index sum == 400 + Sigma growth lines; every channel counts; no ledger anywhere", () => {
  const w = newWorld();
  seedCity(w, "cityC", "ownerC", statsOf({
    culture: 25, infrastructure: 75, households: 100, housingUnits: 90,
    treasuryRubars: 100_000, population: 2000,
  }));
  runAction(w, act("start_capacity_project", "ownerC", {
    cityId: "cityC", projectId: "culture-works", capacityIndex: "culture", totalBudgetRubars: 10_001,
  }), T0);
  runAction(w, act("advance_capacity_project", "ownerC", { cityId: "cityC", projectId: "culture-works" }), hoursLater(T0, 1));
  const entries: GrowthAuditEntry[] = w.log.filter((e) => e.cityId === "cityC");
  let verdict = verifyIndexSumAgainstCity(entries, "cityC", w.docs.get("sim_cities/cityC")!);
  assert.equal(verdict.ok, true, verdict.note);
  assert.equal(verdict.audit.computedIndexSum, 402);
  assert.equal(verdict.audit.perIndex.culture, 2);
  assert.equal(verdict.audit.lines.length, 1, "exactly the one growth line the Log holds");

  // R-38's hook output (Catalogue I) is the same shape of line — the
  // audit counts it without knowing the channel (compose, not rebuild).
  const cityDoc = w.docs.get("sim_cities/cityC")!;
  const stats = { ...(cityDoc.stats as Record<string, unknown>), military: 52 };
  w.docs.set("sim_cities/cityC", { ...cityDoc, stats });
  entries.push({
    seq: 9_001, cityId: "cityC", ruleIds: ["R-38"],
    changes: [{ field: "stats.military", before: 50, after: 52 }],
  });
  verdict = verifyIndexSumAgainstCity(entries, "cityC", w.docs.get("sim_cities/cityC")!);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.audit.computedIndexSum, 404);

  // A downward line (damage/attrition from any lawful mover) counts
  // too — the identity is over the Log's lines, not a channel list.
  const cityDoc2 = w.docs.get("sim_cities/cityC")!;
  const stats2 = { ...(cityDoc2.stats as Record<string, unknown>), spirit: 47 };
  w.docs.set("sim_cities/cityC", { ...cityDoc2, stats: stats2 });
  entries.push({
    seq: 9_002, cityId: "cityC", ruleIds: ["R-16"],
    changes: [{ field: "stats.spirit", before: 50, after: 47 }],
  });
  verdict = verifyIndexSumAgainstCity(entries, "cityC", w.docs.get("sim_cities/cityC")!);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.audit.computedIndexSum, 401);

  const audit = auditIndexSum(entries, "cityC");
  assert.equal(audit.basePoints, 400);
  const growthSource = readFileSync(new URL("../lib/sim/rules/growth.ts", import.meta.url), "utf8");
  assert.ok(!/pointsLedger|pointBalance|respec/i.test(growthSource.replace(/no points ledger|never re-allocatable|no respec path/gi, "")),
    "growth.ts holds no points ledger and no respec path — growth is direct stat growth only");
});

// ---------------------------------------------------------------------------
// Product-verb refusal battery + spec-shape units
// ---------------------------------------------------------------------------

section("R-32 refusal battery — every refusal is a plan, never a throw, never a write");
check("authority, kind list, mode, shortfall, effect, duplicates", () => {
  const w = newWorld();
  seedCity(w, "cityR", "ownerR", statsOf({ treasuryRubars: 50_000 }));
  const base = { cityId: "cityR", fundId: "f1", fundName: "F", purposeKind: "innovation-breakthrough", mode: "generative", amountRubars: 10_000 };
  expectRejected(runAction(w, act("establish_fund", "mallory", base), T0).plan, "AUTHORITY_REVOKED");
  expectRejected(runAction(w, act("establish_fund", "ownerR", { ...base, purposeKind: "nonsense" }), T0).plan, "UNKNOWN_PURPOSE_KIND");
  expectRejected(runAction(w, act("establish_fund", "ownerR", { ...base, purposeKind: "delayed-stat-effect" }), T0).plan, "MODE_NOT_AVAILABLE");
  expectRejected(runAction(w, act("establish_fund", "ownerR", { ...base, amountRubars: 60_000 }), T0).plan, "INSUFFICIENT_TREASURY");
  expectRejected(runAction(w, act("establish_fund", "ownerR", { ...base, mode: "determinate" }), T0).plan, "EFFECT_REQUIRED");
  expectRejected(runAction(w, act("dissolve_fund", "ownerR", { cityId: "cityR", fundId: "ghost" }), T0).plan, "NO_FUND");
  const ok = runAction(w, act("establish_fund", "ownerR", base), T0);
  assert.equal(ok.plan.outcome, "resolved");
  expectRejected(runAction(w, act("establish_fund", "ownerR", base), T0).plan, "FUND_EXISTS");
  const spec = buildFundPayloadSpec({
    fundPath: fundPath("cityR", "f1"), cityId: "cityR", purposeKind: "innovation-breakthrough",
    mode: "generative", minRubars: 5, maxRubars: 10,
  });
  assert.equal(spec.trickleDown, true);
  assert.equal((spec.preconditions as unknown[]).length, 2);
  assert.equal(fundPreconditions("x")[0].onFalse, "void");
});

// ---------------------------------------------------------------------------
// F-12 taxonomy evidence (P4-K23): what is landed vs what is specced
// ---------------------------------------------------------------------------

section("F-12 taxonomy — the blocked-oversize row, landed at the close-out (E3)");
check("deterministic write-set rejection exists for resolutions; blocked-oversize IS in the pending path (E3)", () => {
  const committer = readFileSync(new URL("../lib/sim/committer.ts", import.meta.url), "utf8");
  assert.ok(committer.includes("WRITE_SET_TOO_LARGE"), "landed: deterministic oversize rejection for resolution plans");
  assert.ok(committer.includes("MANIFEST_TOO_LARGE"), "landed: deterministic manifest rejection");
  const pendingSrc = readFileSync(new URL("../lib/sim/pending.ts", import.meta.url), "utf8");
  assert.ok(pendingSrc.includes("blocked-oversize"),
    "landed (E3): the pending path carries the blocked-oversize attention state");
  assert.ok(pendingSrc.includes("attentionState"), "the release path routes size failures to it");
  assert.equal(ripeningFailureClass("WRITE_SET_TOO_LARGE"), "size-block");
  assert.equal(ripeningFailureClass("MANIFEST_TOO_LARGE"), "size-block");
  assert.equal(ripeningFailureClass("RIPENING_PREPARATION"), "attempts");
  const dispatcher = readFileSync(new URL("../lib/sim/dispatcher.ts", import.meta.url), "utf8");
  assert.ok(dispatcher.includes("scanRipeness"), "the scan is dispatcher-wired (one pass per committed action)");
});

console.log(`\nCHAINS + GROWTH HARNESS: ${checks} checks passed`);
