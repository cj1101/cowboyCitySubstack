/**
 * Phase 4 close-out harness (step 12) — the permanent battery for the
 * engine hardening list E1–E6 plus the step-12 instruments. Pure
 * logic, no emulator: it rides the REAL engine functions
 * (buildPendingDraft, evaluateRipeness / buildRipenessView /
 * resolvedSeqOf, resolveRipening / resolveVoiding,
 * applyRipeningEffect, validatePayloadSpec, ripeningFailureClass)
 * over an in-process world whose miniature committer mirrors
 * committer.ts's stamping — including the close-out's own rules:
 * pending requiredSeq anchors to the CREATION seq (E1), and the
 * counter carries the lastResolvedSeq tally (E4), which the mirror
 * advances on every commit because it commits resolved plans only.
 *
 * The Firestore-bound halves (claim transactions, the committer's
 * in-transaction guard execution, releasePendingClaim's writes) are
 * exercised at the level this venue allows — predicate outcomes, the
 * failure classifier, and source evidence — and end-to-end in CI's
 * emulator suites (sim-core / play-core). Each section says which.
 *
 * Run: npx tsx tests/closeout-harness.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  collectRipeningReadPaths,
  resolveRipening,
  resolveVoiding,
  snapshotFromDocs,
} from "../lib/sim/resolver";
import {
  PENDING_KINDS,
  RipeningPreparationError,
  applyRipeningEffect,
  buildPendingDraft,
  evaluateRipeness,
  buildRipenessView,
  resolvedSeqOf,
  ripeningFailureClass,
  validatePayloadSpec,
  type PendingKindConfig,
} from "../lib/sim/rules/pendingRules";
import {
  buildFundPayloadSpec,
  fundPath,
  fundPreconditions,
} from "../lib/sim/rules/chains";
import {
  MAX_MANIFEST_BYTES,
  MAX_WRITES_PER_RESOLUTION,
  emptyPlan,
  snapshotDoc,
  type PreparedPayload,
  type ResolutionPlan,
  type SimActor,
  type SimSnapshot,
} from "../lib/sim/state";
import { canonicalJson } from "../lib/sim/canonical";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";

const fixtureRegistry = buildFixtureBaselineRegistry();
const T0 = "2026-10-20T00:00:00.000Z";
const hoursLater = (iso: string, hours: number): string =>
  new Date(Date.parse(iso) + hours * 3_600_000).toISOString();

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(2, " ")} — ${name}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------------------
// Mini world + committer mirror (chains-harness pattern, close-out rules)
// ---------------------------------------------------------------------------

const SEED_SEQ = 100;

interface World {
  docs: Map<string, Record<string, unknown>>;
  seq: number;
  log: Record<string, unknown>[];
}

function newWorld(): World {
  const docs = new Map<string, Record<string, unknown>>();
  docs.set("sim_counters/log", {
    lastSeq: SEED_SEQ,
    lastResolvedSeq: SEED_SEQ,
    lastEntryHash: "seed",
  });
  docs.set("sim_world/current", { lastCommittedSeq: SEED_SEQ });
  return { docs, seq: SEED_SEQ, log: [] };
}

function seedCity(
  w: World,
  cityId: string,
  stats: Record<string, number | null>
): void {
  w.docs.set(`sim_cities/${cityId}`, {
    factionId: cityId,
    stats,
    traits: [],
    legalExposure: { open: false, caseIds: [], tier: 0 },
    defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
    stateVersion: 1,
    lastChangedSeq: SEED_SEQ,
    lastResolutionId: null,
  });
}

const memberActor = (uid: string): SimActor => ({
  type: "member",
  memberId: uid,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

/** Mirror of committer.ts's pending stamping (post-close-out):
 * originSeq is attribution; requiredSeq anchors to the CREATION seq
 * (the creating event's summary seq) + minSeqAdvance (E1). The
 * counter tally advances with the commit (resolved plans only). */
function commitPlan(w: World, plan: ResolutionPlan, nowIso: string, resolutionId: string): void {
  assert.equal(plan.outcome, "resolved", "mini-committer only commits resolved plans");
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
    rc.requiredSeq = summarySeq + (rc.minSeqAdvance as number);
    rc.eligibleAt = hoursLater(nowIso, rc.minWallElapsedHours as number);
    doc.ripenCondition = rc;
    w.docs.set(`sim_pending_consequences/${doc.pendingId as string}`, doc);
  }
  for (const t of plan.pendingTransitions) {
    const doc = w.docs.get(`sim_pending_consequences/${t.pendingId}`);
    if (!doc) continue;
    const next: Record<string, unknown> = { ...doc, status: t.toStatus, updatedAt: nowIso };
    if (t.toStatus === "ripened") {
      next.ripenedAtSeq = summarySeq;
      next.outcomeSummary = t.outcomeSummary ?? null;
    } else {
      next.voidedAtSeq = summarySeq;
      next.voidReason = t.voidReason ?? null;
    }
    w.docs.set(`sim_pending_consequences/${t.pendingId}`, next);
  }
  w.seq = summarySeq;
  w.docs.set("sim_counters/log", {
    lastSeq: w.seq,
    lastResolvedSeq: w.seq,
    lastEntryHash: "harness",
  });
  w.docs.set("sim_world/current", { lastCommittedSeq: w.seq });
  plan.entries.forEach((e, i) => w.log.push({ ...e, seq: w.seq - plan.entries.length + 1 + i }));
}

/** Direct draft insertion with the committer's stamping applied by
 * hand (fixture arrangement for pre-existing pendings). */
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
  rc.requiredSeq = createdAtSeq + (rc.minSeqAdvance as number);
  rc.eligibleAt = hoursLater(nowIso, rc.minWallElapsedHours as number);
  out.ripenCondition = rc;
  w.docs.set(`sim_pending_consequences/${out.pendingId as string}`, out);
}

interface PassResult {
  evaluated: number;
  ripened: string[];
  voided: string[];
  failed: { pendingId: string; code: string }[];
  skippedUnprepared: string[];
}

/** The LANDED scan's decision structure (post-close-out): pass-start
 * verdicts are scheduling only; each candidate is re-evaluated on a
 * fresh view of the current docs before resolving (E2), seq currency
 * is the resolved tally (E4). */
function runLandedPass(
  w: World,
  nowIso: string,
  opts: { prepared?: Map<string, PreparedPayload> } = {}
): PassResult {
  const result: PassResult = { evaluated: 0, ripened: [], voided: [], failed: [], skippedUnprepared: [] };
  const candidates = [...w.docs.entries()]
    .filter(([path]) => path.startsWith("sim_pending_consequences/"))
    .map(([, doc]) => doc)
    .filter((doc) => doc.status === "pending")
    .sort((a, b) => {
      const bySeq = (a.createdAtSeq as number) - (b.createdAtSeq as number);
      return bySeq !== 0 ? bySeq : String(a.pendingId).localeCompare(String(b.pendingId));
    });
  const frozen = new Map(w.docs);
  const frozenView = {
    currentSeq: resolvedSeqOf(frozen.get("sim_counters/log") ?? null),
    nowIso,
    cityActivitySeq: new Map<string, number>(),
    docByPath: (path: string) => frozen.get(path) ?? null,
  };
  for (const candidate of candidates) {
    result.evaluated += 1;
    const pendingId = candidate.pendingId as string;
    const schedulingVerdict = evaluateRipeness(candidate, frozenView);
    if (schedulingVerdict.state === "waiting") continue;
    const pendingNow = w.docs.get(`sim_pending_consequences/${pendingId}`) ?? candidate;
    const freshView = buildRipenessView(pendingNow, {
      counter: w.docs.get("sim_counters/log") ?? null,
      nowIso,
      docByPath: (path) => w.docs.get(path) ?? null,
    });
    const verdict = evaluateRipeness(pendingNow, freshView);
    if (verdict.state === "waiting") continue;
    const spec = pendingNow.payloadSpec as Record<string, unknown>;
    const prepared = opts.prepared?.get(pendingId);
    if (verdict.state === "ripe" && spec.mode === "generative" && !prepared) {
      result.skippedUnprepared.push(pendingId);
      continue;
    }
    const paths = collectRipeningReadPaths(pendingNow);
    const docs = new Map(paths.map((p) => [p, w.docs.get(p) ?? null]));
    const snapshot = snapshotFromDocs(docs, nowIso);
    try {
      if (verdict.state === "void") {
        const plan = resolveVoiding(snapshot, pendingNow, {
          baselineRegistry: fixtureRegistry,
          voidReason: verdict.reason,
        });
        commitPlan(w, plan, nowIso, `void_${pendingId}`);
        result.voided.push(pendingId);
      } else {
        const plan = resolveRipening(snapshot, pendingNow, {
          baselineRegistry: fixtureRegistry,
          prepared,
        });
        commitPlan(w, plan, nowIso, `ripen_${pendingId}`);
        result.ripened.push(pendingId);
      }
    } catch (error) {
      result.failed.push({
        pendingId,
        code: error instanceof RipeningPreparationError ? error.code : "ERROR",
      });
      const doc = w.docs.get(`sim_pending_consequences/${pendingId}`)!;
      w.docs.set(`sim_pending_consequences/${pendingId}`, {
        ...doc,
        attempts: (doc.attempts as number) + 1,
      });
    }
  }
  return result;
}

function worldJson(w: World): string {
  const docs = [...w.docs.entries()].sort(([a], [b]) => a.localeCompare(b));
  return canonicalJson({ docs, log: w.log });
}

// ---------------------------------------------------------------------------
// S1 — E2: the AGR re-evaluation guard (P4-K20), end to end
// ---------------------------------------------------------------------------

section("S1 E2 — re-evaluation converts a stale ripening into a voiding");

function buildSharedFundWorld(): { w: World; breakId: string; exhaustId: string } {
  const w = newWorld();
  seedCity(w, "cityE", { treasuryRubars: 1_000_000, infrastructure: 50, spirit: 50 });
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
  // Fixture arrangement: the tally stands past both requiredSeqs.
  w.docs.set("sim_counters/log", { lastSeq: 200, lastResolvedSeq: 200, lastEntryHash: "seed" });
  w.seq = 200;
  return { w, breakId: "pend_shared_02", exhaustId: "pend_shared_01" };
}

{
  const { w, breakId, exhaustId } = buildSharedFundWorld();
  const frozenView = {
    currentSeq: resolvedSeqOf(w.docs.get("sim_counters/log") ?? null),
    nowIso: hoursLater(T0, 200),
    cityActivitySeq: new Map<string, number>(),
    docByPath: (path: string) => w.docs.get(path) ?? null,
  };
  check("at pass start BOTH pendings read ripe — the stale verdict exists", () => {
    const doc = w.docs.get(`sim_pending_consequences/${breakId}`)!;
    assert.equal(evaluateRipeness(doc, frozenView).state, "ripe");
  });
  const prepared = new Map<string, PreparedPayload>([
    [breakId, {
      inputHash: "prepared-shared",
      generatedContent: {
        creditRubars: 250_000,
        disbursementRubars: 250_000,
        summaryText: "An invention the fund can no longer pay for.",
        seed: "s",
        childBriefs: [],
      },
    }],
  ]);
  const pass = runLandedPass(w, hoursLater(T0, 200), { prepared });
  check("the landed pass ripens the payout and VOIDS the breakthrough in the same pass", () => {
    assert.deepEqual(pass.ripened, [exhaustId]);
    assert.deepEqual(pass.voided, [breakId]);
    assert.deepEqual(pass.failed, []);
  });
  check("no money materialized from the exhausted fund; the voiding names the dead precondition", () => {
    const city = w.docs.get("sim_cities/cityE")!;
    assert.equal((city.stats as Record<string, unknown>).treasuryRubars, 1_000_000);
    assert.equal((city.stats as Record<string, unknown>).spirit, 51, "the lawful first ripening landed");
    const doc = w.docs.get(`sim_pending_consequences/${breakId}`)!;
    assert.equal(doc.status, "voided");
    assert.ok(String(doc.voidReason).includes("remainingRubars"));
  });
  check("the committer guard's inputs flip too: re-evaluation on post-exhaustion docs reads void, not ripe", () => {
    const { w: w2, breakId: id2 } = buildSharedFundWorld();
    // Exhaust the fund directly (the first ripening's committed effect).
    const fPath = fundPath("cityE", "shared-fund");
    w2.docs.set(fPath, { ...w2.docs.get(fPath)!, remainingRubars: 0, disbursedRubars: 300_000 });
    const doc = w2.docs.get(`sim_pending_consequences/${id2}`)!;
    const view = buildRipenessView(doc, {
      counter: w2.docs.get("sim_counters/log") ?? null,
      nowIso: hoursLater(T0, 200),
      docByPath: (path) => w2.docs.get(path) ?? null,
    });
    assert.equal(evaluateRipeness(doc, view).state, "void",
      "a commitResolution dispatched as pending-ripening meets verdict void != expected ripe and aborts as verdict-flip");
    const committerSrc = readFileSync(new URL("../lib/sim/committer.ts", import.meta.url), "utf8");
    assert.ok(committerSrc.includes('"verdict-flip"'), "the committer carries the verdict-flip outcome");
    assert.ok(committerSrc.includes("evaluateRipeness"), "the committer evaluates the predicate in-transaction");
  });
}

// ---------------------------------------------------------------------------
// S2 — E4: lastResolvedSeq view semantics (P4-K24)
// ---------------------------------------------------------------------------

section("S2 E4 — delay clocks read the resolved tally, never the head");
{
  const pending = {
    pendingId: "pend_s2",
    createdAtSeq: 100,
    ripenCondition: {
      requiredSeq: 110,
      eligibleAt: "2026-01-01T00:00:00.000Z",
      requiresActionInCities: [],
      preconditions: [],
    },
  };
  const viewFor = (counter: Record<string, unknown>) =>
    buildRipenessView(pending, {
      counter,
      nowIso: T0,
      docByPath: () => null,
    });
  check("head past requiredSeq but tally short: WAITING (a rejected resolution mints no progress)", () => {
    const verdict = evaluateRipeness(pending, viewFor({ lastSeq: 500, lastResolvedSeq: 105 }));
    assert.equal(verdict.state, "waiting");
    assert.ok(
      verdict.state === "waiting" && verdict.blockers.some((b) => b.includes("seq 105")),
      "the blocker reports the tally, not the head"
    );
  });
  check("tally at requiredSeq: ripe, whatever the head says", () => {
    assert.equal(evaluateRipeness(pending, viewFor({ lastSeq: 500, lastResolvedSeq: 110 })).state, "ripe");
  });
  check("a pre-E4 counter (no tally field) falls back to the head — the conservative legacy reading", () => {
    assert.equal(evaluateRipeness(pending, viewFor({ lastSeq: 500 })).state, "ripe");
    assert.equal(resolvedSeqOf({ lastSeq: 500 }), 500);
    assert.equal(resolvedSeqOf({ lastSeq: 500, lastResolvedSeq: 7 }), 7);
    assert.equal(resolvedSeqOf(null), 0);
  });
  check("buildRipenessView exposes the tally as the view's currentSeq", () => {
    assert.equal(viewFor({ lastSeq: 500, lastResolvedSeq: 103 }).currentSeq, 103);
  });
}

// ---------------------------------------------------------------------------
// S3 — E3: the failure taxonomy + blocked-oversize routing (P4-K23)
// ---------------------------------------------------------------------------

section("S3 E3 — deterministic size failures block; generation failures retry");
{
  check("the classifier splits the two failure classes on the deterministic size codes", () => {
    assert.equal(ripeningFailureClass("WRITE_SET_TOO_LARGE"), "size-block");
    assert.equal(ripeningFailureClass("MANIFEST_TOO_LARGE"), "size-block");
    assert.equal(ripeningFailureClass("RIPENING_PREPARATION"), "attempts");
    assert.equal(ripeningFailureClass("PENDING_SPEC_INVALID"), "attempts");
  });
  check("the engine routes size failures to the named attention state (source evidence)", () => {
    const pendingSrc = readFileSync(new URL("../lib/sim/pending.ts", import.meta.url), "utf8");
    assert.ok(pendingSrc.includes('attentionState?: "blocked-oversize"'));
    assert.ok(pendingSrc.includes('status: blocked ? "blocked-oversize" : "pending"'));
    assert.ok(pendingSrc.includes("blocked: string[]"), "the scan summary carries the blocked list");
    const rulesSrc = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");
    assert.ok(!rulesSrc.includes("blocked-oversize"),
      "no rules change was needed: pending status is not an enumerated field in the rules (verified)");
  });
}

// ---------------------------------------------------------------------------
// S4 — E5: generative fund bookkeeping in applyRipeningEffect
// ---------------------------------------------------------------------------

section("S4 E5 — generative ripenings book their fund disbursement");
{
  const fPath = fundPath("cascadia", "fund1");
  const makeCase = (specExtra: Record<string, unknown> = {}) => {
    const docs = new Map<string, Record<string, unknown> | null>();
    docs.set("sim_cities/cascadia", {
      factionId: "cascadia",
      stats: { treasuryRubars: 700_000 },
      traits: [],
      stateVersion: 1,
      lastChangedSeq: SEED_SEQ,
      lastResolutionId: null,
    });
    docs.set(fPath, {
      schemaVersion: 2, kind: "fund", cityId: "cascadia", name: "Fund One",
      initialRubars: 100_000, remainingRubars: 100_000, disbursedRubars: 0,
      status: "active", stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
    });
    docs.set("sim_counters/log", { lastSeq: SEED_SEQ, lastResolvedSeq: SEED_SEQ, lastEntryHash: "seed" });
    const snapshot: SimSnapshot = snapshotFromDocs(docs, T0);
    const spec = {
      ...buildFundPayloadSpec({
        fundPath: fPath,
        cityId: "cascadia",
        purposeKind: "innovation-breakthrough",
        mode: "generative",
        minRubars: 1,
        maxRubars: 500_000,
      }),
      ...specExtra,
    };
    const pending = {
      pendingId: "pend_s4",
      kind: "innovation-breakthrough",
      targetCityId: "cascadia",
      payloadSpec: spec,
    };
    return { snapshot, pending, fPath };
  };
  const payload = (content: Record<string, unknown>): PreparedPayload => ({
    inputHash: "s4",
    generatedContent: { summaryText: "A detailed invention.", seed: "s", childBriefs: [], ...content },
  });
  check("no figure anywhere: generation-contract failure (the product spec carries none)", () => {
    const { snapshot, pending } = makeCase();
    assert.throws(
      () => applyRipeningEffect(snapshot, emptyPlan("R-33"), pending, payload({ creditRubars: 50_000 })),
      (e: unknown) => e instanceof RipeningPreparationError && /disbursementRubars/.test((e as Error).message)
    );
  });
  check("figure above the credited amount: failure", () => {
    const { snapshot, pending } = makeCase();
    assert.throws(
      () => applyRipeningEffect(snapshot, emptyPlan("R-33"), pending, payload({ creditRubars: 50_000, disbursementRubars: 60_000 })),
      RipeningPreparationError
    );
  });
  check("figure above the fund's remaining balance: failure", () => {
    const { snapshot, pending } = makeCase();
    assert.throws(
      () => applyRipeningEffect(snapshot, emptyPlan("R-33"), pending, payload({ creditRubars: 200_000, disbursementRubars: 150_000 })),
      (e: unknown) => e instanceof RipeningPreparationError && /remaining/.test((e as Error).message)
    );
  });
  check("a valid figure books: fund counters move, change lines are target-qualified", () => {
    const { snapshot, pending, fPath: path } = makeCase();
    const plan = emptyPlan("R-33");
    const app = applyRipeningEffect(snapshot, plan, pending, payload({ creditRubars: 50_000, disbursementRubars: 40_000 }));
    const fundWrite = plan.writes.find((wr) => wr.path === path);
    assert.equal(fundWrite?.afterDoc?.disbursedRubars, 40_000);
    assert.equal(fundWrite?.afterDoc?.remainingRubars, 60_000);
    assert.ok(app.changes.some((c) => c.field === "funds/fund1.disbursedRubars"));
    assert.ok(app.changes.some((c) => c.field === "funds/fund1.remainingRubars"));
    assert.ok(app.changes.some((c) => c.field === "stats.treasuryRubars"), "the credit still lands");
  });
  check("the spec-committed figure (fixture shape) books when the payload carries none", () => {
    const { snapshot, pending, fPath: path } = makeCase({ fundDisbursementRubars: 30_000 });
    const plan = emptyPlan("R-33");
    applyRipeningEffect(snapshot, plan, pending, payload({ creditRubars: 50_000 }));
    const fundWrite = plan.writes.find((wr) => wr.path === path);
    assert.equal(fundWrite?.afterDoc?.disbursedRubars, 30_000);
  });
}

// ---------------------------------------------------------------------------
// S5 — E1: wall floors + creation anchoring (P4-K19)
// ---------------------------------------------------------------------------

section("S5 E1 — derivations floor at the kind's minimum; children anchor to their creation");
{
  const citySnapshot = (infrastructure: number): SimSnapshot => {
    const docs = new Map<string, Record<string, unknown> | null>();
    docs.set("sim_cities/probe", {
      factionId: "probe",
      stats: { infrastructure, treasuryRubars: 0 },
      traits: [],
      stateVersion: 1,
      lastChangedSeq: SEED_SEQ,
      lastResolutionId: null,
    });
    docs.set("sim_counters/log", { lastSeq: SEED_SEQ, lastResolvedSeq: SEED_SEQ, lastEntryHash: "seed" });
    return snapshotFromDocs(docs, T0);
  };
  const draftArgs = (kind: string) => ({
    pendingId: `pend_probe_${kind}`,
    kind,
    originResolutionId: "seed_resolution",
    originActionId: null,
    originActor: memberActor("probe"),
    originCityId: "probe",
    originSummaryText: "floor probe",
    targetCityId: "probe",
    sourceKind: "action" as const,
    generation: 1,
    chainId: `pend_probe_${kind}`,
    chainRootPendingId: null,
    createdByResolutionId: null,
    payloadSpec: {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "probe", field: "stats.spirit", delta: 1 },
    },
    fundSize: null,
  });
  check("a sub-floor derivation is raised to the floor — and the raise is recorded", () => {
    const probe: PendingKindConfig = {
      kind: "closeout-floor-probe",
      baseHours: 1,
      modes: ["determinate"],
      ruleIdsOnRipen: ["R-33"],
      referenceFund: null,
      effectPath: "stat",
      minWallHoursFloor: 6,
    };
    PENDING_KINDS[probe.kind] = probe;
    try {
      // infrastructure 100 -> factor 0.85: derived round(1 x 0.85) = 1h < 6h floor.
      const { draft } = buildPendingDraft(citySnapshot(100), draftArgs(probe.kind));
      const derivation = draft.doc.delayDerivation as Record<string, unknown>;
      assert.equal(derivation.minWallElapsedHours, 6);
      assert.equal(derivation.minSeqAdvance, 1, "advance = round(floor / 6)");
      assert.equal(derivation.wallFloorHours, 6, "the floor that bound is on the record");
      assert.equal(derivation.derivedWallHours, 1, "the raw derivation stays visible");
    } finally {
      delete PENDING_KINDS[probe.kind];
    }
  });
  check("the named zero-delay exemption skips the floor entirely", () => {
    const probe: PendingKindConfig = {
      kind: "closeout-exempt-probe",
      baseHours: 1,
      modes: ["determinate"],
      ruleIdsOnRipen: ["R-33"],
      referenceFund: null,
      effectPath: "stat",
      minWallHoursFloor: 6,
      zeroDelayExempt: true,
    };
    PENDING_KINDS[probe.kind] = probe;
    try {
      const { draft } = buildPendingDraft(citySnapshot(100), draftArgs(probe.kind));
      const derivation = draft.doc.delayDerivation as Record<string, unknown>;
      assert.equal(derivation.minWallElapsedHours, 1, "derived, unfloored");
      assert.equal(derivation.wallFloorHours, undefined);
    } finally {
      delete PENDING_KINDS[probe.kind];
    }
  });
  check("landed kinds derive exactly as before (floors sit below every reachable derivation)", () => {
    const delayed = buildPendingDraft(citySnapshot(50), draftArgs("delayed-stat-effect"));
    const dd = delayed.draft.doc.delayDerivation as Record<string, unknown>;
    assert.equal(dd.minWallElapsedHours, 6);
    assert.equal(dd.minSeqAdvance, 1);
    assert.equal(dd.wallFloorHours, undefined, "no raise: 6h derived >= 1h floor");
    const insider = buildPendingDraft(citySnapshot(100), {
      ...draftArgs("insider-delivery"),
      payloadSpec: {
        mode: "generative",
        bounds: { minRubars: 0, maxRubars: 10 },
        delivery: { targetKind: "insider-intel", visibilityClass: "owner" },
      },
    });
    const id = insider.draft.doc.delayDerivation as Record<string, unknown>;
    assert.equal(id.minWallElapsedHours, 1, "round(1 x 0.85) = 1h, at its 1h floor — unraised");
    assert.equal(id.wallFloorHours, undefined);
  });
  check("a ripening's child anchors requiredSeq to its own creation seq (origin stays attribution)", () => {
    const w = newWorld();
    seedCity(w, "cityH", { treasuryRubars: 0, infrastructure: 50, spirit: 40 });
    const snapshot = snapshotFromDocs(new Map(w.docs), T0);
    const parent = buildPendingDraft(snapshot, {
      pendingId: "pend_anchor_parent",
      kind: "delayed-stat-effect",
      originResolutionId: "seed_resolution",
      originActionId: null,
      originActor: memberActor("ownerH"),
      originCityId: "cityH",
      originSummaryText: "anchor parent",
      targetCityId: "cityH",
      sourceKind: "action",
      generation: 1,
      chainId: "pend_anchor_parent",
      chainRootPendingId: null,
      createdByResolutionId: null,
      payloadSpec: {
        mode: "determinate",
        effect: { type: "stat-delta", cityId: "cityH", field: "stats.spirit", delta: 1 },
        childPendings: [{
          kind: "delayed-stat-effect",
          targetCityId: "cityH",
          payloadSpec: {
            mode: "determinate",
            effect: { type: "stat-delta", cityId: "cityH", field: "stats.spirit", delta: 1 },
          },
        }],
        requiresActionInCities: [],
      },
      fundSize: null,
    });
    insertPending(w, parent.draft.doc, SEED_SEQ, SEED_SEQ, T0);
    w.docs.set("sim_counters/log", { lastSeq: 200, lastResolvedSeq: 200, lastEntryHash: "seed" });
    w.seq = 200;
    const pass = runLandedPass(w, hoursLater(T0, 200));
    assert.deepEqual(pass.ripened, ["pend_anchor_parent"]);
    const child = [...w.docs.values()].find(
      (d) => d.chainId === "pend_anchor_parent" && d.pendingId !== "pend_anchor_parent"
    )!;
    assert.ok(child, "the ripening created its child");
    assert.equal(child.originSeq, SEED_SEQ, "attribution still traces to the chain origin");
    assert.ok((child.createdAtSeq as number) > SEED_SEQ, "but the child was CREATED by the ripening, later");
    const rc = child.ripenCondition as Record<string, unknown>;
    assert.equal(rc.requiredSeq, (child.createdAtSeq as number) + (rc.minSeqAdvance as number));
    assert.ok((rc.requiredSeq as number) > (child.createdAtSeq as number),
      "a generation-2 child can no longer be seq-ripe at the moment it exists");
    const committerSrc = readFileSync(new URL("../lib/sim/committer.ts", import.meta.url), "utf8");
    assert.ok(committerSrc.includes("summarySeq + (condition.minSeqAdvance as number)"),
      "the production committer stamps the same creation anchor");
  });
}

// ---------------------------------------------------------------------------
// S6 — E6: delivery as a declared effect path
// ---------------------------------------------------------------------------

section("S6 E6 — the kind registry declares effect paths; creation fences both ways");
{
  check("every registered kind declares an effect path; the delivery set is exactly the step-9 kinds", () => {
    for (const config of Object.values(PENDING_KINDS)) {
      assert.ok(config.effectPath === "stat" || config.effectPath === "delivery", config.kind);
    }
    const deliveryKinds = Object.values(PENDING_KINDS)
      .filter((c) => c.effectPath === "delivery")
      .map((c) => c.kind)
      .sort();
    assert.deepEqual(deliveryKinds, ["collection-delivery", "insider-delivery", "survey-delivery"]);
  });
  check("a delivery kind's spec without its delivery block is refused at creation", () => {
    assert.throws(
      () => validatePayloadSpec("survey-delivery", { mode: "generative", bounds: { minRubars: 0, maxRubars: 10 } }),
      /delivery block/
    );
  });
  check("a stat kind's spec carrying a delivery block is refused at creation", () => {
    assert.throws(
      () =>
        validatePayloadSpec("delayed-stat-effect", {
          mode: "determinate",
          effect: { type: "stat-delta", cityId: "x", field: "stats.spirit", delta: 1 },
          delivery: { targetKind: "insider-intel", visibilityClass: "owner" },
        }),
      /must not carry a delivery block/
    );
  });
  check("a well-formed delivery spec passes; the resolver dispatches on the declaration (source evidence)", () => {
    validatePayloadSpec("survey-delivery", {
      mode: "generative",
      bounds: { minRubars: 0, maxRubars: 10 },
      delivery: { targetKind: "survey-findings", visibilityClass: "owner" },
    });
    const resolverSrc = readFileSync(new URL("../lib/sim/resolver.ts", import.meta.url), "utf8");
    assert.ok(resolverSrc.includes('kindConfig.effectPath === "delivery"'),
      "dispatch reads the kind's declared effect path, not the payload shape");
  });
}

// ---------------------------------------------------------------------------
// S7 — step-12 instrument: wake determinism + idempotency (causality)
// ---------------------------------------------------------------------------

section("S7 wake battery — same world + same actions => identical world; idle wakes change nothing");
{
  const storyline = (): World => {
    const w = newWorld();
    seedCity(w, "cityA", { treasuryRubars: 500_000, infrastructure: 50, spirit: 40 });
    const fPath = fundPath("cityA", "story-fund");
    w.docs.set(fPath, {
      schemaVersion: 2, kind: "fund", cityId: "cityA", name: "Story Fund",
      initialRubars: 100_000, remainingRubars: 100_000, disbursedRubars: 0,
      status: "active", createdByResolutionId: "seed", createdAt: null,
      stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
    });
    const snapshot = snapshotFromDocs(new Map(w.docs), T0);
    const actor = memberActor("ownerA");
    const mkDraft = (
      pendingId: string,
      kind: string,
      payloadSpec: Record<string, unknown>,
      fundSize: number | null
    ) =>
      buildPendingDraft(snapshot, {
        pendingId,
        kind,
        originResolutionId: "seed_resolution",
        originActionId: null,
        originActor: actor,
        originCityId: "cityA",
        originSummaryText: `story ${pendingId}`,
        targetCityId: "cityA",
        sourceKind: "action",
        generation: 1,
        chainId: pendingId,
        chainRootPendingId: null,
        createdByResolutionId: null,
        payloadSpec,
        fundSize,
      }).draft.doc;
    insertPending(w, mkDraft("pend_story_1", "delayed-stat-effect", {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "cityA", field: "stats.spirit", delta: 2 },
      fundPath: fPath,
      fundDisbursementRubars: 10_000,
      preconditions: fundPreconditions(fPath),
      requiresActionInCities: [],
    }, null), SEED_SEQ, SEED_SEQ, T0);
    insertPending(w, mkDraft("pend_story_2", "innovation-breakthrough", {
      mode: "generative",
      bounds: { minRubars: 1, maxRubars: 100_000 },
      trickleDown: false,
      fundPath: fPath,
      preconditions: fundPreconditions(fPath),
      requiresActionInCities: [],
    }, 100_000), SEED_SEQ, SEED_SEQ, T0);
    // A third pending whose fund is already dissolved: voids. It is
    // named to sort FIRST in the pass, so its commit lands before the
    // generation-2 child exists — leaving the child's creation seq as
    // the pass's final tally (which is what makes the child's own
    // seq gate the binding constraint in the idle-wake check below).
    const deadPath = fundPath("cityA", "dead-fund");
    w.docs.set(deadPath, {
      schemaVersion: 2, kind: "fund", cityId: "cityA", name: "Dead Fund",
      initialRubars: 5_000, remainingRubars: 0, disbursedRubars: 0,
      status: "dissolved", createdByResolutionId: "seed", createdAt: null,
      stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
    });
    insertPending(w, mkDraft("pend_story_0", "delayed-stat-effect", {
      mode: "determinate",
      effect: { type: "stat-delta", cityId: "cityA", field: "stats.spirit", delta: 9 },
      preconditions: fundPreconditions(deadPath),
      requiresActionInCities: [],
    }, null), SEED_SEQ, SEED_SEQ, T0);
    w.docs.set("sim_counters/log", { lastSeq: 200, lastResolvedSeq: 200, lastEntryHash: "seed" });
    w.seq = 200;
    const prepared = new Map<string, PreparedPayload>([
      ["pend_story_2", {
        inputHash: "story-2",
        generatedContent: {
          creditRubars: 20_000,
          disbursementRubars: 20_000,
          summaryText: "A story invention.",
          seed: "s",
          childBriefs: [{
            kind: "delayed-stat-effect",
            targetCityId: "cityA",
            payloadSpec: {
              mode: "determinate",
              effect: { type: "stat-delta", cityId: "cityA", field: "stats.spirit", delta: 3 },
            },
          }],
        },
      }],
    ]);
    const pass1 = runLandedPass(w, hoursLater(T0, 200), { prepared });
    assert.deepEqual(pass1.ripened, ["pend_story_1", "pend_story_2"]);
    assert.deepEqual(pass1.voided, ["pend_story_0"]);
    return w;
  };

  const w1 = storyline();
  check("the storyline lands: fund booked by both modes (100,000 - 10,000 - 20,000 = 70,000)", () => {
    const fund = w1.docs.get(fundPath("cityA", "story-fund"))!;
    assert.equal(fund.remainingRubars, 70_000);
    assert.equal(fund.disbursedRubars, 30_000);
    const child = [...w1.docs.values()].find(
      (d) => d.chainId === "pend_story_2" && d.pendingId !== "pend_story_2"
    )!;
    assert.ok(child && child.status === "pending", "the generation-2 child waits for a later wake");
  });
  check("determinism: the same storyline run twice produces byte-identical worlds", () => {
    const w2 = storyline();
    assert.equal(worldJson(w2), worldJson(w1));
  });
  check("idempotency: a duplicated pass at the same instant changes nothing", () => {
    const before = worldJson(w1);
    const again = runLandedPass(w1, hoursLater(T0, 200));
    assert.deepEqual(again.ripened, []);
    assert.deepEqual(again.voided, []);
    assert.deepEqual(again.failed, []);
    assert.equal(worldJson(w1), before);
  });
  check("causality: 30 days of idle passes change nothing — the child's seq gate is unmet and time alone ripens nothing", () => {
    const before = worldJson(w1);
    const idle = runLandedPass(w1, hoursLater(T0, 200 + 24 * 30));
    assert.deepEqual(idle.ripened, [], "the child still waits: created at the tally, it needs one more RESOLVED seq");
    assert.deepEqual(idle.voided, []);
    assert.equal(worldJson(w1), before);
  });
  check("one further resolved event unblocks the child — progress is action-shaped, not clock-shaped", () => {
    const extraPlan: ResolutionPlan = {
      ...emptyPlan("fixture"),
      outcome: "resolved",
      entries: [{
        kind: "rule-effect",
        summary: true,
        actor: memberActor("ownerA"),
        actionId: null,
        actionText: null,
        classification: null,
        cityId: "cityA",
        cityIds: ["cityA"],
        ruleIds: ["R-00"],
        changes: [],
        spilloverFromSeq: null,
        causedBySeq: null,
        correctsSeq: null,
        recordsCreated: [],
        recordsUpdated: [],
        legal: null,
        chronicleDraftId: null,
        major: false,
        summaryText: "a further act",
        visibility: "public",
        pendingId: null,
        generation: null,
      } as never],
    };
    commitPlan(w1, extraPlan, hoursLater(T0, 200 + 24 * 30), "story_extra_act");
    const pass = runLandedPass(w1, hoursLater(T0, 200 + 24 * 30));
    const child = [...w1.docs.values()].find(
      (d) => d.chainId === "pend_story_2" && d.pendingId !== "pend_story_2"
    )!;
    assert.equal(child.status, "ripened");
    assert.deepEqual(pass.ripened, [child.pendingId]);
  });
}

// ---------------------------------------------------------------------------
// S8 — step-12 instrument: manifest-size instrumentation
// ---------------------------------------------------------------------------

section("S8 manifest sizes — measured, against both ceilings");
{
  interface SizeRow {
    name: string;
    writes: number;
    manifestBytes: number;
    pctOfInternalCap: number;
    pctOfFirestoreLimit: number;
  }
  const FIRESTORE_DOC_LIMIT = 1_048_576;
  const rows: SizeRow[] = [];
  /** Compose the manifest the way committer.ts does (writeSet with
   * full before/after docs + control writes + heads + ref keys) and
   * measure its canonical serialization. */
  const measure = (name: string, plan: ResolutionPlan, snapshot: SimSnapshot): void => {
    // WritePlan carries no beforeDoc: the committer derives befores
    // from its transaction snapshot when composing the manifest —
    // mirrored here from the same snapshot the plan was resolved on.
    const writeSet = plan.writes.map((wr) => ({
      path: wr.path,
      op: wr.op,
      recordClass: wr.recordClass,
      beforeDoc: snapshotDoc(snapshot, wr.path),
      afterDoc: wr.afterDoc ?? null,
    }));
    const manifestLike = {
      resolutionId: `measure_${name}`,
      schemaVersion: 2,
      sourceKind: "pending-ripening",
      firstSeq: 1,
      lastSeq: plan.entries.length,
      planHash: plan.planHash,
      inputHeads: snapshot.heads,
      inputRefKeys: plan.readRefKeys,
      dependencyRefKeys: plan.readRefKeys,
      outputRefKeys: plan.writes.map((wr) => `doc:${wr.path}`),
      writeSet,
      counterBefore: { lastSeq: 1, lastResolvedSeq: 1, lastEntryHash: "x", lastResolutionId: null },
      counterAfter: { lastSeq: 2, lastResolvedSeq: 2, lastEntryHash: "y", lastResolutionId: "m" },
    };
    const bytes = canonicalJson(manifestLike).length;
    rows.push({
      name,
      writes: plan.writes.length,
      manifestBytes: bytes,
      pctOfInternalCap: Math.round((bytes / MAX_MANIFEST_BYTES) * 1000) / 10,
      pctOfFirestoreLimit: Math.round((bytes / FIRESTORE_DOC_LIMIT) * 1000) / 10,
    });
  };

  // (1) The canonical ripening (S1's world, the payout plan).
  {
    const { w, exhaustId } = buildSharedFundWorld();
    const doc = w.docs.get(`sim_pending_consequences/${exhaustId}`)!;
    const paths = collectRipeningReadPaths(doc);
    const snapshot = snapshotFromDocs(new Map(paths.map((p) => [p, w.docs.get(p) ?? null])), T0);
    const plan = resolveRipening(snapshot, doc, { baselineRegistry: fixtureRegistry });
    measure("canonical determinate ripening (fund payout)", plan, snapshot);
  }
  // (2) A generative ripening with a child (S4's shape, resolved whole).
  {
    const fPath = fundPath("cascadia", "fund1");
    const docs = new Map<string, Record<string, unknown> | null>();
    docs.set("sim_cities/cascadia", {
      factionId: "cascadia", stats: { treasuryRubars: 700_000 }, traits: [],
      stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
    });
    docs.set(fPath, {
      schemaVersion: 2, kind: "fund", cityId: "cascadia", name: "Fund One",
      initialRubars: 100_000, remainingRubars: 100_000, disbursedRubars: 0,
      status: "active", stateVersion: 1, lastChangedSeq: SEED_SEQ, lastResolutionId: null,
    });
    docs.set("sim_counters/log", { lastSeq: SEED_SEQ, lastResolvedSeq: SEED_SEQ, lastEntryHash: "seed" });
    const pending = {
      pendingId: "pend_s8",
      kind: "innovation-breakthrough",
      targetCityId: "cascadia",
      originSeq: SEED_SEQ,
      originActor: memberActor("owner8"),
      originActionId: null,
      originResolutionId: "seed_resolution",
      originCityId: "cascadia",
      originSummaryText: "S8 measurement pending",
      generation: 1,
      chainId: "pend_s8",
      chainRootPendingId: null,
      payloadSpec: buildFundPayloadSpec({
        fundPath: fPath, cityId: "cascadia", purposeKind: "innovation-breakthrough",
        mode: "generative", minRubars: 1, maxRubars: 500_000,
      }),
    };
    const paths = collectRipeningReadPaths(pending);
    const snap2 = snapshotFromDocs(new Map(paths.map((p) => [p, docs.get(p) ?? null])), T0);
    const plan = resolveRipening(snap2, pending, {
      baselineRegistry: fixtureRegistry,
      prepared: {
        inputHash: "s8",
        generatedContent: {
          creditRubars: 50_000, disbursementRubars: 40_000,
          summaryText: "A detailed invention.", seed: "s",
          childBriefs: [{
            kind: "delayed-stat-effect", targetCityId: "cascadia",
            payloadSpec: { mode: "determinate", effect: { type: "stat-delta", cityId: "cascadia", field: "stats.spirit", delta: 1 } },
          }],
        },
      },
    });
    measure("generative ripening + child creation", plan, snap2);
  }
  // (3) Stress: a synthetic plan at the write ceiling (MAX_WRITES_PER_RESOLUTION)
  // whose writes carry full city-shaped docs (~750 B each side).
  {
    const fatDoc = (n: number): Record<string, unknown> => ({
      factionId: `city${n}`,
      stats: {
        spirit: 50, culture: 50, infrastructure: 50, stability: 50,
        law: 50, influence: 50, military: 50, defense: 50,
        treasuryRubars: 1_000_000, population: 30_000, households: 5_000,
        housingUnits: 4_500, gdpRubars: 50_000_000,
      },
      traits: ["river-port", "old-quarter"],
      legalExposure: { open: false, caseIds: [], tier: 0 },
      defensePosture: { prepared: false, setAtSeq: null, treasuryPaidRubars: null },
      charterNote: "x".repeat(220),
      stateVersion: 3,
      lastChangedSeq: SEED_SEQ,
      lastResolutionId: "seed",
    });
    const plan = emptyPlan("stress");
    const stressDocs = new Map<string, Record<string, unknown> | null>();
    stressDocs.set("sim_counters/log", { lastSeq: SEED_SEQ, lastResolvedSeq: SEED_SEQ, lastEntryHash: "seed" });
    stressDocs.set("sim_world/current", { lastCommittedSeq: SEED_SEQ });
    for (let i = 0; i < MAX_WRITES_PER_RESOLUTION; i += 1) {
      stressDocs.set(`sim_cities/city${i}`, fatDoc(i));
      plan.writes.push({
        path: `sim_cities/city${i}`,
        op: "update",
        recordClass: "state",
        afterDoc: { ...fatDoc(i), stateVersion: 4 },
        changedFields: ["stats"],
      } as never);
    }
    const snapshot = snapshotFromDocs(stressDocs, T0);
    measure(`stress: ${MAX_WRITES_PER_RESOLUTION} writes of city-shaped docs`, plan, snapshot);
  }

  for (const row of rows) {
    console.log(
      `  size ${row.name}: ${row.writes} writes, manifest ~${row.manifestBytes} B ` +
      `(${row.pctOfInternalCap}% of the ${MAX_MANIFEST_BYTES} B internal cap; ` +
      `${row.pctOfFirestoreLimit}% of Firestore's ${FIRESTORE_DOC_LIMIT} B document limit)`
    );
  }
  check("every measured manifest sits under the internal cap; the stress row is the flagged approach", () => {
    for (const row of rows) {
      assert.ok(row.manifestBytes < MAX_MANIFEST_BYTES, `${row.name} exceeds the internal cap`);
    }
    const stress = rows[rows.length - 1];
    assert.ok(stress.pctOfInternalCap > 50,
      "the write-ceiling stress manifest is the one shape that approaches the cap — flagged with its number");
  });
}

console.log(`\nCLOSE-OUT HARNESS: ${checks} checks passed`);
