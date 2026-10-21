/**
 * Lore harness (Phase 4 step 11) — a pure (snapshot, action) → plan
 * battery over lib/sim/rules/lore.ts (R-11), plus the pure-layer
 * export assertions for the Phase 4 export additions. In the
 * defense-harness style: snapshots are fabricated against an
 * in-memory world, handlers run through their descriptor's read plan
 * (the F-01 contract), and every resolved plan goes through the REAL
 * validatePlan + finalizePlan. No emulator.
 *
 * Mandated cases (step-11 brief): adoption refused for a non-owner;
 * a contradictory draft surfacing as a retcon proposal, NOT an
 * overwrite (entry byte-identical); an export builder refusing a
 * surface the viewer cannot see; an export labeling a published
 * claim as a claim (Phase 3 city workbook, asserted here against the
 * landed builders).
 *
 * Run: ./node_modules/.bin/tsx tests/lore-harness.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PlanValidationError,
  collectActionReadPaths,
  finalizePlan,
  snapshotFromDocs,
  validatePlan,
} from "../lib/sim/resolver";
import { CommitError, deriveChronicleBadging } from "../lib/sim/committer";
import { ruleEffectDraft, summaryDraft } from "../lib/sim/rules/planHelpers";
import { emptyPlan } from "../lib/sim/state";
import { buildFixtureBaselineRegistry } from "../lib/sim/baseline/fixtures";
import { RULE_DESCRIPTORS, type HandlerContext, type RuleDescriptor } from "../lib/sim/rules/registry";
import {
  LORE_DESCRIPTORS,
  buildChronicleDraftDoc,
  chronicleDraftIdForResolution,
  isSimChronicleDraft,
  wikiEntryIdForDraft,
} from "../lib/sim/rules/lore";
import { ExportError, sheetHeaderRow, specCellMatrix, type PlannedWorkbook } from "../lib/export/sheetSpec";
import { buildCityWorkbook } from "../lib/export/datasets/cityWorkbook";
import {
  buildPortfolioWorkbook,
  buildSurveyWorkbook,
} from "../lib/export/datasets/phase4Workbook";
import { assertExportAllowed, type ExportRequester } from "../lib/export/fetchCityExport";
import type { CityExportBundle, ExportContext } from "../lib/export/datasets/cityData";
import type { PortfolioBundle, SurveyRecordData } from "../lib/export/datasets/phase4Data";
import type {
  ResolutionPlan,
  SimAction,
  SimActor,
  SimSnapshot,
  SnapshotQueryRecord,
} from "../lib/sim/state";

Object.assign(RULE_DESCRIPTORS, LORE_DESCRIPTORS);

const KIND_TO_DESCRIPTOR: Record<string, RuleDescriptor> = {};
for (const descriptor of Object.values(LORE_DESCRIPTORS)) {
  for (const kind of descriptor.actionKinds) KIND_TO_DESCRIPTOR[kind] = descriptor;
}

const fixtureRegistry = buildFixtureBaselineRegistry();
const NOW = "2026-10-20T12:00:00.000Z";

const OWNER_A = "ownerA";
const OWNER_B = "ownerB";
const MAYOR = "mayor1";

const memberActor = (uid: string): SimActor => ({
  type: "member",
  memberId: uid,
  npcId: null,
  onBehalfOfMemberId: null,
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

const npcActor = (onBehalfOf: string): SimActor => ({
  type: "npc",
  memberId: null,
  npcId: "npc_scribe",
  onBehalfOfMemberId: onBehalfOf,
  mandateId: "mandate_1",
  mandateVersion: 1,
  envelopeId: null,
});

const mayorActor = (): SimActor => ({
  type: "shared-office",
  memberId: MAYOR,
  npcId: null,
  onBehalfOfMemberId: null,
  office: "mayor",
  mandateId: null,
  mandateVersion: null,
  envelopeId: null,
});

interface Stats {
  population: number;
  treasuryRubars: number;
  [key: string]: number;
}

function simCityDoc(name: string, isSharedCity: boolean): Record<string, unknown> {
  const stats: Stats = {
    population: 1200,
    households: 480,
    treasuryRubars: 500000,
    debtRubars: 0,
    gdpRubars: 9000000,
    innovation: 40,
    education: 50,
    health: 55,
    infrastructure: 60,
    environment: 65,
    culture: 45,
    safety: 70,
    military: 10,
    defense: 10,
  };
  return {
    cityId: name,
    name,
    isSharedCity,
    stats,
    stateVersion: 3,
    lastChangedSeq: 90,
    lastResolutionId: "res_seed",
  };
}

function wikiDraft(over: Record<string, unknown>): Record<string, unknown> {
  return {
    targetCityId: "cascadia",
    targetCitySlug: "cascadia",
    existingWikiEntryId: null,
    baseWikiVersion: null,
    proposedKind: "place",
    proposedTitle: "Founders' Bell",
    proposedSlug: "founders-bell",
    proposedSummary: "The bell over the old market.",
    proposedBody: "Cast in the first winter from the courthouse roof copper.",
    proposedStats: null,
    proposedCanonLayer: "current",
    changeType: "new",
    diffSummary: "new entry",
    sourceCitations: [
      {
        documentId: "doc_bell",
        documentVersion: 3,
        chunkId: "chunk_7",
        quoteHash: "qhash1",
        shortExcerpt: "…the bell was cast…",
      },
    ],
    crossCityIds: [],
    status: "pending",
    decision: null,
    resultWikiEntryId: null,
    resultWikiVersion: null,
    ingestionRunId: "run_seed",
    ...over,
  };
}

function seedWorld(): Map<string, Record<string, unknown>> {
  const world = new Map<string, Record<string, unknown>>();
  world.set("sim_counters/log", { lastSeq: 100, lastEntryHash: "seedhash" });
  world.set("sim_world/current", { lastCommittedSeq: 100, rulesVersion: "p4-test" });
  world.set("factions/cascadia", { name: "Cascadia", ownerUids: [OWNER_A] });
  world.set("factions/evancity", { name: "Evan City", ownerUids: [OWNER_B] });
  world.set("factions/cowboycity", { name: "Cowboy City", ownerUids: [] });
  world.set("sim_cities/cascadia", simCityDoc("cascadia", false));
  world.set("sim_cities/evancity", simCityDoc("evancity", false));
  world.set("sim_cities/cowboycity", simCityDoc("cowboycity", true));

  // The standing canon entry everything else pushes against.
  world.set("wiki_entries/founding_charter", {
    cityId: "cascadia",
    citySlug: "cascadia",
    kind: "charter",
    title: "Founding Charter",
    slug: "founding-charter",
    summary: "The original charter.",
    body: "Article I: the city is founded.",
    stats: null,
    searchTokens: ["founding", "charter"],
    currentVersion: 2,
    versioned: true,
    canonLayer: "realm",
    canonStatus: "canon",
    adoptedByUid: OWNER_A,
    adoptedAtSeq: 40,
    provenanceSummary: ["adopted draft draft_charter_v1 · realm · seq 40"],
    contentHash: "seedhash_charter_v2",
    updatedAt: null,
  });

  world.set(
    "sim_wiki_entry_drafts/draft_new",
    wikiDraft({ crossCityIds: ["evancity"] })
  );
  world.set(
    "sim_wiki_entry_drafts/draft_charter_v3",
    wikiDraft({
      existingWikiEntryId: "founding_charter",
      baseWikiVersion: 2,
      proposedKind: "charter",
      proposedTitle: "Founding Charter",
      proposedSlug: "founding-charter",
      proposedSummary: "The charter, amended.",
      proposedBody: "Article I: the city is founded. Article II: the bell rings.",
      proposedCanonLayer: "realm",
      changeType: "changed",
      crossCityIds: [],
    })
  );
  world.set(
    "sim_wiki_entry_drafts/draft_retcon",
    wikiDraft({
      existingWikiEntryId: "founding_charter",
      baseWikiVersion: 2,
      proposedTitle: "Founding Charter — the other account",
      proposedBody: "A contradictory telling of the founding.",
      changeType: "retcon_conflict",
    })
  );
  world.set(
    "sim_wiki_entry_drafts/draft_stale",
    wikiDraft({
      existingWikiEntryId: "founding_charter",
      baseWikiVersion: 1, // canon has moved to 2 since this draft was cut
      proposedTitle: "Founding Charter — stale edit",
      changeType: "changed",
    })
  );
  world.set(
    "sim_wiki_entry_drafts/draft_shared",
    wikiDraft({
      targetCityId: "cowboycity",
      targetCitySlug: "cowboy-city",
      proposedTitle: "Town Hall Bell",
      proposedSlug: "town-hall-bell",
    })
  );

  // A committer-badged chronicle draft (the Lead's wiring produces
  // exactly this doc via buildChronicleDraftDoc) + an ordinary,
  // unbadged post draft.
  world.set(
    "drafts/chronicle_res_bell",
    buildChronicleDraftDoc({
      resolutionId: "res_bell",
      cityId: "cascadia",
      title: "The Bell Is Cast",
      body: "How the founders' bell came to hang over the old market.",
      sourceRuleIds: ["R-10"],
    })
  );
  world.set("drafts/post_draft_plain", {
    type: "lore",
    factionId: "cascadia",
    characterId: "",
    title: "An ordinary member draft",
    body: "Not a sim draft.",
    status: "draft",
    cityIds: ["cascadia"],
    authorUid: OWNER_A,
  });
  return world;
}

let actionCounter = 0;
function act(
  actionType: string,
  actor: SimActor,
  structuredAction: Record<string, unknown>
): SimAction {
  actionCounter += 1;
  const actionId = `act_lore_${String(actionCounter).padStart(3, "0")}`;
  return {
    actionId,
    schemaVersion: 2,
    clientRequestId: `req_${actionId}`,
    idempotencyKey: `idem_${actionId}`,
    source: "lore-harness",
    actor,
    actionType,
    actionText: `${actionType} (harness)`,
    structuredAction,
    targetCityIds:
      typeof structuredAction.cityId === "string" ? [structuredAction.cityId] : [],
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
  } as SimAction;
}

type World = Map<string, Record<string, unknown>>;

function runAction(world: World, action: SimAction): ResolutionPlan {
  const descriptor = KIND_TO_DESCRIPTOR[action.actionType];
  assert.ok(descriptor, `no lore descriptor classifies ${action.actionType}`);
  const handler = descriptor.handlers[action.actionType];
  assert.ok(handler, `descriptor ${descriptor.id} has no handler for ${action.actionType}`);

  const basePaths = collectActionReadPaths(action);
  const seedDocs = new Map<string, Record<string, unknown> | null>();
  for (const path of basePaths) seedDocs.set(path, world.get(path) ?? null);
  const extra = descriptor.readPlan?.({ action, seedDocs }) ?? {};
  const docs = new Map(seedDocs);
  for (const path of extra.paths ?? []) docs.set(path, world.get(path) ?? null);

  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of extra.queries ?? []) {
    const prefix = `${spec.collectionPath}/`;
    const resultPaths = [...world.keys()]
      .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
      .filter((key) => {
        const doc = world.get(key) as Record<string, unknown>;
        return spec.filters.every((f) => doc[f.field] === f.value);
      })
      .sort();
    for (const path of resultPaths) docs.set(path, world.get(path) ?? null);
    queryRecords.push({ spec, resultPaths, digest: "lore-harness" });
  }

  const snapshot: SimSnapshot = snapshotFromDocs(docs, NOW, queryRecords);
  const ctx: HandlerContext = {
    snapshot,
    action,
    resolutionId: action.actionId,
    prepared: undefined,
    baselineRegistry: fixtureRegistry,
    citableBaseline: null,
    citations: {},
  };
  const plan = handler(ctx);
  plan.descriptorId = descriptor.id;
  if (plan.outcome === "resolved") {
    validatePlan(plan, {
      baselineRegistry: fixtureRegistry,
      covertEntriesAllowed: false,
      snapshot,
    });
    finalizePlan(plan);
    assert.ok(plan.planHash.length > 0, "finalized plan carries a hash");
    for (const write of plan.writes) {
      if (write.op === "delete") world.delete(write.path);
      else world.set(write.path, write.afterDoc as Record<string, unknown>);
    }
  }
  return plan;
}

function expectRejected(plan: ResolutionPlan, code: string): void {
  assert.equal(plan.outcome, "rejected", `expected rejection ${code}`);
  assert.equal(plan.rejection?.code, code);
  assert.equal(plan.writes.length, 0, "a rejection writes nothing");
}

let checks = 0;
function check(label: string, fn: () => void): void {
  fn();
  checks += 1;
  console.log(`  ok ${String(checks).padStart(2, "0")} — ${label}`);
}

const world = seedWorld();
const charterBefore = structuredClone(world.get("wiki_entries/founding_charter"));

// ---------------------------------------------------------------------------
// R-11 wiki adoption
// ---------------------------------------------------------------------------

check("retcon-flagged draft surfaces a proposal; canon byte-identical", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_retcon",
      cityId: "cascadia",
    })
  );
  assert.equal(plan.outcome, "resolved");
  assert.deepEqual(world.get("wiki_entries/founding_charter"), charterBefore);
  const draft = world.get("sim_wiki_entry_drafts/draft_retcon")!;
  assert.equal(draft.status, "pending", "the draft stays pending — a proposal is not a decision");
  const proposal = draft.retconProposal as Record<string, unknown>;
  assert.equal(proposal.status, "open");
  assert.equal(proposal.againstEntryId, "founding_charter");
  assert.equal(proposal.againstVersion, 2);
  assert.equal(proposal.proposedByUid, OWNER_A);
  assert.equal(world.get("wiki_entries/founding_charter/versions/3"), undefined);
});

check("stale-base draft (canon moved under it) also surfaces a proposal", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_stale",
      cityId: "cascadia",
    })
  );
  assert.equal(plan.outcome, "resolved");
  assert.deepEqual(world.get("wiki_entries/founding_charter"), charterBefore);
  const draft = world.get("sim_wiki_entry_drafts/draft_stale")!;
  assert.equal(draft.status, "pending");
  assert.equal((draft.retconProposal as Record<string, unknown>).againstVersion, 2);
});

check("non-owner adoption refused (AUTHORITY_REVOKED, zero writes)", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_B), {
      draftId: "draft_new",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "AUTHORITY_REVOKED");
  assert.equal(world.get("sim_wiki_entry_drafts/draft_new")!.status, "pending");
  assert.equal(world.get("wiki_entries/wiki_draft_new"), undefined);
});

check("NPC adoption refused structurally — canon never rides a delegation", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", npcActor(OWNER_A), {
      draftId: "draft_new",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "CANON_ADOPTION_OWNER_ONLY");
});

check("owner adopts a new entry: version 1 + provenance + cross-reference", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_new",
      cityId: "cascadia",
    })
  );
  assert.equal(plan.outcome, "resolved");
  const entryId = wikiEntryIdForDraft("draft_new");
  const entry = world.get(`wiki_entries/${entryId}`)!;
  assert.equal(entry.currentVersion, 1);
  assert.equal(entry.canonLayer, "current");
  assert.equal(entry.canonStatus, "canon");
  assert.equal(entry.adoptedByUid, OWNER_A);
  assert.equal((entry.provenanceSummary as string[]).length, 1);
  assert.ok(typeof entry.contentHash === "string" && entry.contentHash.length === 64);
  const version = world.get(`wiki_entries/${entryId}/versions/1`)!;
  assert.equal(version.version, 1);
  assert.equal(version.previousVersion, null);
  assert.equal(version.sourceDraftId, "draft_new");
  assert.equal(version.authorType, "ingestion");
  assert.equal(
    (version.sourceCitations as unknown[]).length,
    1,
    "citations ride into the version snapshot (TC-C02 provenance)"
  );
  const draft = world.get("sim_wiki_entry_drafts/draft_new")!;
  assert.equal(draft.status, "adopted");
  assert.equal(draft.resultWikiEntryId, entryId);
  assert.equal(draft.resultWikiVersion, 1);
  // The cross-reference: a labeled record on Evan City, no canon copied.
  const xref = world.get(`sim_cities/evancity/lore_cross_refs/${entryId}`)!;
  assert.equal(xref.sourceCityId, "cascadia");
  assert.equal(xref.removableByOwner, true);
  assert.equal(xref.title, "Founders' Bell");
  assert.equal(world.get("wiki_entries/founding_charter")!.cityId, "cascadia");
});

check("re-adopting an adopted draft refused (DRAFT_NOT_ADOPTABLE)", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_new",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "DRAFT_NOT_ADOPTABLE");
});

check("owner adopts a changed entry: version advances, history immutable", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_charter_v3",
      cityId: "cascadia",
    })
  );
  assert.equal(plan.outcome, "resolved");
  const entry = world.get("wiki_entries/founding_charter")!;
  assert.equal(entry.currentVersion, 3);
  assert.equal(entry.body, "Article I: the city is founded. Article II: the bell rings.");
  assert.equal((entry.provenanceSummary as string[]).length, 2);
  const v3 = world.get("wiki_entries/founding_charter/versions/3")!;
  assert.equal(v3.previousVersion, 2);
  assert.equal(v3.canonLayer, "realm");
});

check("action targeting the wrong city refused (draft's record governs)", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_shared",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "DRAFT_TARGET_MISMATCH");
});

check("shared city: a plain member cannot adopt its lore", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_shared",
      cityId: "cowboycity",
    })
  );
  expectRejected(plan, "AUTHORITY_REVOKED");
});

check("shared city: the sitting mayor adopts (shared-office posture)", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", mayorActor(), {
      draftId: "draft_shared",
      cityId: "cowboycity",
    })
  );
  assert.equal(plan.outcome, "resolved");
  const entry = world.get(`wiki_entries/${wikiEntryIdForDraft("draft_shared")}`)!;
  assert.equal(entry.cityId, "cowboycity");
  assert.equal(entry.adoptedByUid, MAYOR);
});

// ---------------------------------------------------------------------------
// R-11 chronicle adoption + the badging helper
// ---------------------------------------------------------------------------

check("badging helper: deterministic id + badge + provenance fields", () => {
  assert.equal(chronicleDraftIdForResolution("res_x"), "chronicle_res_x");
  const doc = buildChronicleDraftDoc({
    resolutionId: "res_x",
    cityId: "cascadia",
    title: "T",
    body: "B",
    sourceRuleIds: ["R-11"],
  });
  assert.equal(doc.badge, "sim");
  assert.equal(doc.canonLayer, "sim");
  assert.equal(doc.status, "draft");
  assert.ok(isSimChronicleDraft(doc));
  assert.ok(!isSimChronicleDraft({ type: "lore", status: "draft" }));
  assert.ok(!isSimChronicleDraft(null));
});

check("owner adopts a chronicle draft: canon post, draft consumed", () => {
  const plan = runAction(
    world,
    act("adopt_chronicle_draft", memberActor(OWNER_A), {
      draftId: "chronicle_res_bell",
      cityId: "cascadia",
    })
  );
  assert.equal(plan.outcome, "resolved");
  assert.equal(world.get("drafts/chronicle_res_bell"), undefined, "draft consumed");
  const post = world.get("posts/chronicle_res_bell")!;
  assert.equal(post.status, "published");
  assert.equal(post.canonLayer, "current");
  assert.equal(post.canonStatus, "canon");
  assert.equal(post.adoptedByUid, OWNER_A);
  assert.equal(post.sourceResolutionId, "res_bell");
  assert.equal(post.sourceChronicleDraftId, "chronicle_res_bell");
  assert.equal(post.badge, undefined, "the draft badge does not ride onto canon");
});

check("an ordinary post draft is refused by R-11 (NOT_CHRONICLE_DRAFT)", () => {
  const plan = runAction(
    world,
    act("adopt_chronicle_draft", memberActor(OWNER_A), {
      draftId: "post_draft_plain",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "NOT_CHRONICLE_DRAFT");
  assert.ok(world.get("drafts/post_draft_plain"), "the ordinary draft is untouched");
});

check("missing draft refused (DRAFT_NOT_FOUND)", () => {
  const plan = runAction(
    world,
    act("adopt_lore_draft", memberActor(OWNER_A), {
      draftId: "draft_nope",
      cityId: "cascadia",
    })
  );
  expectRejected(plan, "DRAFT_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Export assertions (pure layer)
// ---------------------------------------------------------------------------

const CTX: ExportContext = {
  asOfSeq: 100,
  rulesVersion: "p4-test",
  exportedAtIso: "2026-10-20T12:00:00.000Z",
  exportedByLabel: "Owner A",
};

function matrixOf(workbook: PlannedWorkbook, tab: string): unknown[][] {
  const sheet = workbook.sheets.find((s) => s.name === tab);
  assert.ok(sheet, `tab ${tab} exists`);
  return [sheetHeaderRow(sheet) as unknown[], ...specCellMatrix(sheet)];
}

function columnIndex(matrix: unknown[][], header: string): number {
  const idx = (matrix[0] as string[]).indexOf(header);
  assert.ok(idx >= 0, `column ${header} present`);
  return idx;
}

check("published claims export LABELED as claims, never as ground truth", () => {
  const bundle: CityExportBundle = {
    cityId: "cascadia",
    cityName: "Cascadia",
    slug: "cascadia",
    hasSimState: true,
    stats: { population: 1200, treasuryRubars: 500000 },
    baselineHash: null,
    stateVersion: 3,
    lastChangedSeq: 90,
    allocations: null,
    structures: [],
    businesses: [],
    geography: [],
    publications: [
      {
        publicationId: "pub_1",
        version: 1,
        supersedesPublicationId: null,
        storedStatus: "published",
        publisherUid: OWNER_A,
        publisherLabel: "Owner A",
        publishedAtIso: "2026-10-19T00:00:00.000Z",
        publishedAtSeq: 95,
        visibility: "public",
        businessId: null,
        claims: [
          {
            metric: "population",
            claimedValue: 999999,
            unit: null,
            periodLabel: "Season 0",
            note: "A deliberate exaggeration, published as a claim.",
          },
        ],
      },
    ],
  };
  const workbook = buildCityWorkbook(bundle, CTX);
  const claims = matrixOf(workbook, "Published Claims");
  const tierIdx = columnIndex(claims, "trust_tier");
  const valueIdx = columnIndex(claims, "claimed_value");
  const claimRows = claims.slice(1).filter((r) => r[valueIdx] === "999999");
  assert.equal(claimRows.length, 1, "the claim figure appears exactly once — on the claims tab");
  assert.equal(claimRows[0][tierIdx], "owner_published");
  const stats = matrixOf(workbook, "City Stats");
  const statsText = stats.flat().join("|");
  assert.ok(!statsText.includes("999999"), "the claim figure never appears as a verified stat");
  const cover = matrixOf(workbook, "Cover");
  const coverText = cover.flat().join("|");
  assert.ok(coverText.includes("contains_owner_published"), "Cover carries the claims flag");
  assert.ok(
    coverText.includes("YES — this workbook contains owner-published claims"),
    "the Cover declares the claims content (P4-G11-C2)"
  );
});

check("portfolio builder refuses another member's bundle (fail-closed)", () => {
  const foreign: PortfolioBundle = {
    memberId: OWNER_B,
    memberLabel: "Owner B",
    account: null,
    holdings: [],
    listings: [],
    orders: [],
  };
  assert.throws(() => buildPortfolioWorkbook(foreign, CTX, OWNER_A), ExportError);
  const own: PortfolioBundle = { ...foreign, memberId: OWNER_A, memberLabel: "Owner A" };
  const workbook = buildPortfolioWorkbook(own, CTX, OWNER_A);
  assert.ok(workbook.sheets.some((s) => s.name === "Positions"));
});

check("survey builder refuses another collector's intel (TC-X05)", () => {
  const foreign: SurveyRecordData = {
    recordId: "intel_1",
    collectorUid: OWNER_B,
    collectorCityId: "evancity",
    targetCityId: "cascadia",
    targetBusinessId: null,
    methodKindLabel: "Census sample",
    methodRef: "census-sample/B",
    collectionResolutionId: "res_intel_1",
    collectedAtSeq: 99,
    band: "B",
    bandDroppedAtDelivery: false,
    coverageAchievedPct: 80,
    coverageCapPct: 85,
    coverageFundedCapPct: 85,
    targetPopulationText: "adults",
    knownUnknowns: ["night-shift workers"],
    nullReasons: [],
    findings: [{ metric: "population", value: 1180, unit: "people", note: null }],
    stateVersion: 1,
  };
  assert.throws(() => buildSurveyWorkbook([foreign], CTX, OWNER_A), ExportError);
});

check("survey export carries its limits as first-class columns (intel tier)", () => {
  const own: SurveyRecordData = {
    recordId: "intel_2",
    collectorUid: OWNER_A,
    collectorCityId: "cascadia",
    targetCityId: "evancity",
    targetBusinessId: null,
    methodKindLabel: "Traveler interviews",
    methodRef: "traveler-interviews/D",
    collectionResolutionId: "res_intel_2",
    collectedAtSeq: 98,
    band: "D",
    bandDroppedAtDelivery: true,
    coverageAchievedPct: 20,
    coverageCapPct: 25,
    coverageFundedCapPct: 25,
    targetPopulationText: "market visitors",
    knownUnknowns: ["residents who never travel"],
    nullReasons: ["gdpRubars:BELOW_FLOOR"],
    findings: [],
    stateVersion: 1,
  };
  const workbook = buildSurveyWorkbook([own], CTX, OWNER_A);
  const sheet = matrixOf(workbook, "Survey Results");
  assert.equal(sheet.length, 2, "a finding-less record still exports its limits row");
  const row = sheet[1] as unknown[];
  assert.equal(row[columnIndex(sheet, "reliability_band")], "D");
  assert.equal(row[columnIndex(sheet, "coverage_achieved_pct")], 20);
  assert.equal(row[columnIndex(sheet, "trust_tier")], "intel_survey");
  assert.ok(String(row[columnIndex(sheet, "null_reasons")]).includes("BELOW_FLOOR"));
  assert.ok(String(row[columnIndex(sheet, "known_unknowns")]).includes("never travel"));
});

check("guest export fence: guests are view-only (OPEN-1 default)", () => {
  const guest: ExportRequester = {
    uid: "guest1",
    label: "Guest",
    isGuest: true,
    isFullMember: false,
    blocked: false,
  };
  assert.throws(() => assertExportAllowed(guest), ExportError);
  const member: ExportRequester = { ...guest, isGuest: false, isFullMember: true };
  assertExportAllowed(member);
});

check("no direct-to-Sheets creation path in the Phase 4 export additions (TC-X11)", () => {
  for (const file of [
    "lib/export/fetchPhase4Export.ts",
    "lib/export/phase4Workbook.ts",
    "lib/export/datasets/phase4Workbook.ts",
    "lib/export/datasets/phase4Data.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("googleapis"), `${file}: no Google API client`);
    assert.ok(!source.includes("spreadsheets"), `${file}: no Sheets API surface`);
    assert.ok(!source.includes("createSpreadsheet"), `${file}: no sheet creation`);
  }
});

// ---------------------------------------------------------------------------
// Lead assembly section (Phase 4 step 11 assembly): the §4 badging
// wiring, exercised against the shipped code — validatePlan's §5.6
// admission and the committer's own derivation (imported, not copied).
// The transaction application rides the same finalWrites path as every
// committer write; the emulator suites remain CI's venue.
// ---------------------------------------------------------------------------

function chroniclePlan(
  outputs: { kind: "note" | "chronicle" | "situation" | "outbox"; text: string }[],
  cityId: string | null
): ResolutionPlan {
  const actor = memberActor(OWNER_A);
  const plan = emptyPlan("R-11");
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: cityId ? [cityId] : [],
      ruleIds: ["R-11"],
      summaryText: "harness effect entry",
    }),
    summaryDraft({
      actor,
      cityId,
      cityIds: cityId ? [cityId] : [],
      ruleIds: ["R-11"],
      summaryText: "harness summary entry",
    })
  );
  plan.narrativeOutputs = outputs;
  return plan;
}

const validateOpts = {
  baselineRegistry: fixtureRegistry,
  covertEntriesAllowed: false,
};

check("assembly §5.6: a chronicle output is admitted by validatePlan", () => {
  const plan = chroniclePlan([{ kind: "chronicle", text: "The telling." }], "cityA");
  validatePlan(plan, validateOpts);
});

check("assembly §5.6: an empty chronicle output fails validation", () => {
  const plan = chroniclePlan([{ kind: "chronicle", text: "   " }], "cityA");
  assert.throws(() => validatePlan(plan, validateOpts), PlanValidationError);
});

check("assembly §5.6: situation and outbox outputs still fail validation", () => {
  for (const kind of ["situation", "outbox"] as const) {
    const plan = chroniclePlan([{ kind, text: "not yet" }], "cityA");
    assert.throws(() => validatePlan(plan, validateOpts), PlanValidationError);
  }
});

check("assembly §4(b): the committer derivation badges a resolved chronicle plan", () => {
  const plan = chroniclePlan(
    [{ kind: "chronicle", text: "The First Telling\n\nBody of the telling." }],
    "cityA"
  );
  const badging = deriveChronicleBadging(plan, "res_harness");
  assert.ok(badging);
  assert.equal(badging.draftId, "chronicle_res_harness");
  assert.equal(badging.draftId, chronicleDraftIdForResolution("res_harness"));
  assert.equal(badging.path, "drafts/chronicle_res_harness");
  assert.equal(badging.doc.badge, "sim");
  assert.equal(badging.doc.source, "sim-chronicle");
  assert.equal(badging.doc.sourceResolutionId, "res_harness");
  assert.equal(badging.doc.sourceCityId, "cityA");
  assert.deepEqual(badging.doc.sourceRuleIds, ["R-11"]);
  assert.equal(badging.doc.title, "The First Telling");
  assert.equal(badging.doc.factionId, "cityA");
  assert.ok(isSimChronicleDraft(badging.doc));
  // Deterministic: the same plan derives the identical badge.
  assert.deepEqual(deriveChronicleBadging(plan, "res_harness"), badging);
});

check("assembly §4(b): several outputs join into the one draft; title = first non-empty line, capped at 120", () => {
  const longLine = "L".repeat(200);
  const plan = chroniclePlan(
    [
      { kind: "note", text: "a note is not badged" },
      { kind: "chronicle", text: `\n\n${longLine}\nrest` },
      { kind: "chronicle", text: "the second telling" },
    ],
    "cityA"
  );
  const badging = deriveChronicleBadging(plan, "res_join");
  assert.ok(badging);
  assert.equal((badging.doc.title as string).length, 120);
  assert.ok((badging.doc.body as string).includes("the second telling"));
  assert.ok(!(badging.doc.body as string).includes("a note is not badged"));
});

check("assembly §4(b): unbadgeable fails closed; rejected and note-only plans badge nothing", () => {
  const noCity = chroniclePlan([{ kind: "chronicle", text: "orphan" }], null);
  assert.throws(
    () => deriveChronicleBadging(noCity, "res_orphan"),
    (error: unknown) => error instanceof CommitError && error.code === "CHRONICLE_UNBADGEABLE"
  );
  const rejected = chroniclePlan([{ kind: "chronicle", text: "never happened" }], "cityA");
  rejected.outcome = "rejected";
  assert.equal(deriveChronicleBadging(rejected, "res_rejected"), null);
  const noteOnly = chroniclePlan([{ kind: "note", text: "just a note" }], "cityA");
  assert.equal(deriveChronicleBadging(noteOnly, "res_note"), null);
});

check("assembly §4(b): the plan hash binds narrativeOutputs (preview parity)", () => {
  const a = finalizePlan(chroniclePlan([{ kind: "chronicle", text: "telling A" }], "cityA"));
  const b = finalizePlan(chroniclePlan([{ kind: "chronicle", text: "telling B" }], "cityA"));
  assert.notEqual(a.planHash, b.planHash);
});

console.log(`\nlore-harness: ${checks} checks passed`);
