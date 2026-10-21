/**
 * The resolver (Phase 2 brief §5) — a pure function of (snapshot, action):
 * no I/O, no clock reads, no randomness. Generative content arrives as
 * prepared payloads and is validated against stored bounds, never
 * generated. Three entry points share one discipline:
 *
 *   resolveAction(snapshot, action)         — member actions incl. the
 *                                               §6.4 Baseline guard and
 *                                               the unruled narrative path
 *   resolveRipening(snapshot, pending, …)    — R-33 application + R-34
 *   resolveVoiding(snapshot, pending, …)     — R-33 voiding
 *
 * Every plan passes `validatePlan` (the §5.6 + §6.3 mechanical guards)
 * and `finalizePlan` (ref-key normalization + planHash) before it may
 * reach the committer. Rejected outcomes are plans too — a rejection is
 * a deterministic first-class Resolution Event (§4.5).
 */

import { canonicalJson, sha256Hex } from "./canonical";
import { headHashOf, projectFirestoreValue } from "./log";
import {
  PENDING_FANOUT_CAP,
  PENDING_GENERATION_CAP,
  docField,
  snapshotDoc,
  withDocField,
  type CollectionQuerySpec,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimChange,
  type SimCitations,
  type SimSnapshot,
  type SnapshotQueryRecord,
} from "./state";
import {
  citableBaselineVersion,
  type BaselineRegistry,
} from "./baseline/registry";
import {
  RULE_DESCRIPTORS,
  baselineContextFor,
  descriptorForActionKind,
} from "./rules/registry";
import {
  RipeningPreparationError,
  applyRipeningEffect,
  buildPendingDraft,
  evaluateTrickleDown,
  pendingKindConfig,
  type DeterminateEffect,
} from "./rules/pendingRules";
import { planWrite, plannedDoc, ruleEffectDraft, summaryDraft } from "./rules/planHelpers";
import {
  collectNpcStageReadPlan,
  planForStageVerdict,
  runAuthorityStage,
  stampMandateCitation,
  type StageResult,
} from "./authorityStage";
import type { AuthorityVerdict } from "../authority";
import {
  COUNTER_MEANS_QUERY_ID,
  buildDeliveryPlan,
  type DeliverySpec,
} from "./rules/acquisition";
import {
  buildScheduleRipeningPlan,
  premiumQueries,
  situationKeyQueries,
} from "./rules/finance";
import { INSURANCE_FUND_PATH, bankLoanPath } from "../finance/accounts";
import { corporationPath } from "./corporations";

export class PlanValidationError extends Error {
  code = "PLAN_INVALID";
}

export class SnapshotError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Snapshot assembly (the one place reads become a snapshot; callers own
// the reader so preview/commit/tests each use their identity).
// ---------------------------------------------------------------------------

export interface DocReader {
  get(path: string): Promise<Record<string, unknown> | null>;
}

function assembleSnapshot(
  docs: ReadonlyMap<string, Record<string, unknown> | null>,
  now: string,
  queries: SnapshotQueryRecord[]
): SimSnapshot {
  const counter = docs.get("sim_counters/log") ?? null;
  if (!counter || typeof counter.lastSeq !== "number") {
    throw new SnapshotError(
      "LOG_NOT_INITIALIZED",
      "sim_counters/log is missing or malformed — the Log is not initialized (genesis has not run)."
    );
  }
  const heads = [...docs.keys()].map((path) => {
    const doc = docs.get(path) ?? null;
    const stateVersion =
      doc && typeof doc.stateVersion === "number" ? (doc.stateVersion as number) : null;
    return { path, stateVersion, hash: headHashOf(doc) };
  });
  return {
    docs,
    heads,
    queries,
    counterHead: {
      lastSeq: counter.lastSeq as number,
      lastEntryHash: (counter.lastEntryHash as string) ?? "",
    },
    now,
  };
}

export async function buildSnapshot(
  reader: DocReader,
  paths: readonly string[],
  now: string
): Promise<SimSnapshot> {
  const unique = [...new Set(paths)];
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of unique) {
    docs.set(path, await reader.get(path));
  }
  return assembleSnapshot(docs, now, []);
}

/** Assemble a snapshot from already-read docs (the committer's in-
 * transaction path: reads happen under the transaction, then the pure
 * resolver runs over exactly those docs). The F-01 query records the
 * dispatcher's plan was computed from ride along (`queries`): the
 * result DOCS are the transaction's own re-reads (they ride
 * `snapshotPaths` and are head-compared like any declared read), so a
 * handler recomputing in-transaction derives from transaction-fresh
 * docs — but without the records themselves it cannot find its
 * materialized set at all and every query-plan resolution would
 * recompute to READ_PLAN_MISSING. Set membership stays bound at the
 * dispatcher's materialization (in-transaction query re-execution is
 * the PR-F residual; see CommitRequest.queryRecords). */
export function snapshotFromDocs(
  docs: ReadonlyMap<string, Record<string, unknown> | null>,
  now: string,
  queries: readonly SnapshotQueryRecord[] = []
): SimSnapshot {
  return assembleSnapshot(docs, now, [...queries]);
}

/** Executes a collection query against the caller's store (the F-01
 * materialization step runs OUTSIDE the pure resolver, like doc reads). */
export interface QueryReader {
  query(
    spec: CollectionQuerySpec
  ): Promise<{ path: string; doc: Record<string, unknown> }[]>;
}

/** The digest binding a query read into the snapshot/manifest input set:
 * sha256 over the spec and the ordered (path, head-hash) result list. */
export function digestQueryResults(
  spec: CollectionQuerySpec,
  results: readonly { path: string; hash: string }[]
): string {
  return sha256Hex(
    projectFirestoreValue({
      spec: spec as unknown as Record<string, unknown>,
      results: results.map((r) => ({ path: r.path, hash: r.hash })),
    }) as Record<string, unknown>
  );
}

/** Materialize a read plan into a snapshot: doc reads plus the plan's
 * collection queries, every result doc bound into `docs`/`heads`
 * exactly like a doc-get, and each query recorded (spec + ordered
 * result paths + digest) on the snapshot for the manifest's input set. */
export async function materializeSnapshot(
  reader: DocReader,
  queryReader: QueryReader | undefined,
  plan: ActionReadPlan,
  now: string
): Promise<SimSnapshot> {
  const docs = new Map<string, Record<string, unknown> | null>();
  for (const path of [...new Set(plan.paths)]) {
    docs.set(path, await reader.get(path));
  }
  const queryRecords: SnapshotQueryRecord[] = [];
  for (const spec of plan.queries) {
    if (!queryReader) {
      throw new SnapshotError(
        "QUERY_READER_MISSING",
        `read plan declares collection query "${spec.id}" (${spec.collectionPath}) but no query reader was supplied`
      );
    }
    const results = await queryReader.query(spec);
    const hashed: { path: string; hash: string }[] = [];
    for (const result of results) {
      docs.set(result.path, result.doc);
      hashed.push({ path: result.path, hash: headHashOf(result.doc) });
    }
    queryRecords.push({
      spec,
      resultPaths: results.map((r) => r.path),
      digest: digestQueryResults(spec, hashed),
    });
  }
  return assembleSnapshot(docs, now, queryRecords);
}

// ---------------------------------------------------------------------------
// Read plans — the snapshot boundary (brief §5.1). Resolution reads only
// declared inputs; anything a handler needs must be reachable from here.
// ---------------------------------------------------------------------------

export function collectActionReadPaths(action: SimAction): string[] {
  const paths = new Set<string>([
    "sim_world/current",
    "sim_counters/log",
    `sim_actions/${action.actionId}`,
  ]);
  const sa = (action.structuredAction ?? {}) as Record<string, unknown>;
  const cities = new Set<string>(action.targetCityIds);
  if (typeof sa.cityId === "string") cities.add(sa.cityId);
  for (const cityId of cities) {
    paths.add(`sim_cities/${cityId}`);
    paths.add(`factions/${cityId}`);
    // Note: sim_stat_allocations is deliberately NOT a Phase 2 resolver
    // input — no Phase 2 handler consumes it (allocation commits are
    // Phase 4), and the committer identity cannot read that collection.
  }
  if (typeof sa.structureId === "string" && typeof sa.cityId === "string") {
    paths.add(`sim_cities/${sa.cityId}/structures/${sa.structureId}`);
  }
  if (typeof sa.fundId === "string" && typeof sa.cityId === "string") {
    paths.add(`sim_cities/${sa.cityId}/structures/${sa.fundId}`);
  }
  if (typeof sa.pendingId === "string") {
    paths.add(`sim_pending_consequences/${sa.pendingId}`);
  }
  if (typeof sa.publicationPath === "string") paths.add(sa.publicationPath);
  const citations = extractCitations(action);
  for (const id of citations.pendingIds ?? []) paths.add(`sim_pending_consequences/${id}`);
  for (const path of citations.recordPaths ?? []) paths.add(path);
  return [...paths];
}

/** A full read plan for an action (F-01): doc paths + collection
 * queries. The base doc paths derive from the action record itself;
 * the classifying descriptor's read-plan hook adds paths/queries whose
 * seeds come from the action and from STORED records (the seed docs —
 * the base paths already read), never from actor nomination alone.
 * Actor-supplied `citations.recordPaths` remain part of the base set
 * as ADDITIONAL reliance declarations (their undo-graph role); they
 * are never the sole source of an authority- or money-critical read —
 * the descriptor hook is resolver-side code, and a citation can add a
 * read but can never narrow or replace the plan's own reads. */
export interface ActionReadPlan {
  paths: string[];
  queries: CollectionQuerySpec[];
}

export function collectActionReadPlan(
  action: SimAction,
  seedDocs: ReadonlyMap<string, Record<string, unknown> | null>
): ActionReadPlan {
  const paths = new Set(collectActionReadPaths(action));
  const queries: CollectionQuerySpec[] = [];
  const descriptor = descriptorForActionKind(action.actionType);
  if (descriptor?.readPlan) {
    const extra = descriptor.readPlan({ action, seedDocs });
    for (const path of extra.paths ?? []) paths.add(path);
    for (const spec of extra.queries ?? []) queries.push(spec);
  }
  // Phase 5 authority stage (PR-2): an NPC-actor action's stage reads
  // derive from the actor's own citation (npc doc, mandate root + the
  // cited version — the root path carries the mandateId, so no seed
  // round-trip is needed), the terms record, counterparty factions,
  // and the period-usage Log query (counted by mandate citation).
  if (action.actor.type === "npc") {
    const stageReads = collectNpcStageReadPlan(action);
    for (const path of stageReads.paths) paths.add(path);
    for (const spec of stageReads.queries) queries.push(spec);
  }
  return { paths: [...paths], queries };
}

export function collectRipeningReadPaths(pending: Record<string, unknown>): string[] {
  const paths = new Set<string>([
    "sim_world/current",
    "sim_counters/log",
    `sim_pending_consequences/${pending.pendingId as string}`,
  ]);
  const cities = new Set<string>();
  if (typeof pending.originCityId === "string") cities.add(pending.originCityId);
  if (typeof pending.targetCityId === "string") cities.add(pending.targetCityId);
  const spec = (pending.payloadSpec ?? {}) as Record<string, unknown>;
  const effect = spec.effect as DeterminateEffect | undefined;
  if (effect && typeof effect.cityId === "string") cities.add(effect.cityId);
  const bounds = spec.bounds as { cityId?: string } | undefined;
  if (bounds && typeof bounds.cityId === "string") cities.add(bounds.cityId);
  if (Array.isArray(spec.childPendings)) {
    for (const child of spec.childPendings as { targetCityId?: string }[]) {
      if (child.targetCityId) cities.add(child.targetCityId);
    }
  }
  if (Array.isArray(spec.voidEffects)) {
    for (const e of spec.voidEffects as DeterminateEffect[]) cities.add(e.cityId);
  }
  for (const cityId of cities) {
    paths.add(`sim_cities/${cityId}`);
    paths.add(`factions/${cityId}`);
  }
  if (typeof spec.fundPath === "string") paths.add(spec.fundPath);
  // Delivery pendings (Phase 4 step 9): the frozen delivery spec
  // names every doc the delivery re-validates against — the means
  // record first, then its vehicles and targets (prep §5 item 3).
  const delivery = spec.delivery as { readPaths?: unknown } | undefined;
  if (delivery && Array.isArray(delivery.readPaths)) {
    for (const path of delivery.readPaths) {
      if (typeof path === "string") paths.add(path);
    }
  }
  // Schedule pendings (Phase 5 PR-6 assembly, A1): the banking
  // ripening composition reads the loan doc (installments), the
  // bank's corporation doc, and the Deposit Insurance Fund
  // singleton. Every address derives from the frozen schedule spec,
  // which carries bankCorporationId / bankCityId (and loanId for
  // installments) by construction at every seeding site.
  if (pendingKindConfig(pending.kind as string).effectPath === "schedule") {
    const schedule = spec.schedule as
      | { bankCorporationId?: unknown; bankCityId?: unknown; loanId?: unknown }
      | undefined;
    if (
      typeof schedule?.bankCorporationId === "string" &&
      typeof schedule?.bankCityId === "string"
    ) {
      paths.add(corporationPath(schedule.bankCityId, schedule.bankCorporationId));
      paths.add(INSURANCE_FUND_PATH);
      if (typeof schedule.loanId === "string") {
        paths.add(bankLoanPath(schedule.loanId));
      }
    }
  }
  const condition = (pending.ripenCondition ?? {}) as Record<string, unknown>;
  const preconditions = (condition.preconditions ?? []) as { path: string }[];
  for (const pc of preconditions) paths.add(pc.path);
  return [...paths];
}

/** The ripening snapshot's collection queries. Delivery pendings
 * declare one: the counter-means query, materialized
 * whole-collection in Phase 4 form — discovery at delivery is
 * evaluated against the realm's standing counter-means posture
 * (design §7.3), read from this query record by the delivery
 * builder. Schedule pendings (Phase 5 PR-6 assembly, A1) declare
 * the banking composition's read set, bank-scoped from the frozen
 * schedule spec: the bank's deposit and loan books, the premium
 * marker/settlement Log views and the assessment-marker view (the
 * family's own spec builders, so a ripening derives ladder and
 * obligation state from exactly the views the action read plans
 * derive), the bank city's Situation cards for the GAP-1 occasion
 * upserts, and the bank's standing schedule pendings — the last
 * materializes into the snapshot's doc set, which the premium
 * composition scans for an already-standing assessment before
 * creating a second (one outstanding assessment per bank). Every
 * other kind declares none and its snapshot materializes exactly
 * as before. */
export function collectRipeningReadQueries(
  pending: Record<string, unknown>
): CollectionQuerySpec[] {
  const spec = (pending.payloadSpec ?? {}) as Record<string, unknown>;
  if (spec.delivery && typeof spec.delivery === "object") {
    return [
      {
        id: COUNTER_MEANS_QUERY_ID,
        collectionPath: "sim_collection_means",
        filters: [],
      },
    ];
  }
  if (pendingKindConfig(pending.kind as string).effectPath === "schedule") {
    const schedule = spec.schedule as
      | { bankCorporationId?: unknown; bankCityId?: unknown }
      | undefined;
    if (
      typeof schedule?.bankCorporationId === "string" &&
      typeof schedule?.bankCityId === "string"
    ) {
      const bankCorporationId = schedule.bankCorporationId;
      return [
        {
          id: "bankDeposits",
          collectionPath: "sim_bank_deposits",
          filters: [
            { field: "bankCorporationId", op: "==", value: bankCorporationId },
          ],
        },
        {
          id: "bankLoans",
          collectionPath: "sim_bank_loans",
          filters: [
            { field: "bankCorporationId", op: "==", value: bankCorporationId },
          ],
        },
        ...premiumQueries(bankCorporationId),
        {
          id: "assessmentMarkers",
          collectionPath: "sim_log_entries",
          filters: [
            {
              field: "classification.assessmentDue.bankCorporationId",
              op: "==",
              value: bankCorporationId,
            },
          ],
        },
        ...situationKeyQueries(schedule.bankCityId),
        {
          id: "standingSchedulePendings",
          collectionPath: "sim_pending_consequences",
          filters: [
            {
              field: "payloadSpec.schedule.bankCorporationId",
              op: "==",
              value: bankCorporationId,
            },
          ],
        },
      ];
    }
  }
  return [];
}

export function extractCitations(action: SimAction): SimCitations {
  const sa = (action.structuredAction ?? {}) as Record<string, unknown>;
  const raw = (sa.citations ?? {}) as Record<string, unknown>;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const numbers = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : undefined;
  return {
    resolutionIds: strings(raw.resolutionIds),
    pendingIds: strings(raw.pendingIds),
    recordPaths: strings(raw.recordPaths),
    seqs: numbers(raw.seqs),
  };
}

function citationRefKeys(citations: SimCitations): string[] {
  const keys: string[] = [];
  for (const id of citations.resolutionIds ?? []) keys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) keys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) keys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) keys.push(`seq:${seq}`);
  return keys;
}

// ---------------------------------------------------------------------------
// Plan validation — the mechanical guards (brief §5.6 + §6.3). Throws
// PlanValidationError; both the resolver's own output and any plan
// reaching the committer pass through here.
// ---------------------------------------------------------------------------

export function validatePlan(
  plan: ResolutionPlan,
  opts: {
    baselineRegistry: BaselineRegistry;
    covertEntriesAllowed: boolean;
    /** When provided, the F-02 reconciliation runs: every entry change
     * must chain from the snapshot value through its sibling changes to
     * the plan's folded write for its doc. Callers that have the
     * snapshot (the resolver itself; the committer's in-transaction
     * revalidation) always pass it. */
    snapshot?: SimSnapshot;
  }
): void {
  const fail = (message: string): never => {
    throw new PlanValidationError(message);
  };

  // §5.6 — narrative outputs: notes always; chronicle outputs are
  // admitted since the Phase 4 step 11 badging wiring (the committer
  // turns them into sim-badged drafts in the existing `drafts`
  // collection — prep report §4(a)); situation/outbox records remain
  // forbidden (their surfaces are Phase 5/6). A chronicle output must
  // carry its telling: an empty text is a bug, not a draft.
  for (const output of plan.narrativeOutputs) {
    if (output.kind === "chronicle") {
      if (typeof output.text !== "string" || output.text.trim().length === 0) {
        fail("plan emits a chronicle output with no text — an empty telling is a bug, not a draft");
      }
    } else if (output.kind !== "note") {
      fail(`plan emits a ${output.kind} output — situation/outbox records are not Phase 4`);
    }
  }

  // §6.3 Baseline guards.
  for (const entry of plan.entries) {
    if (entry.baseline !== null) {
      const version = opts.baselineRegistry.versions.find(
        (v) => v.version === (entry.baseline as { version: string }).version
      );
      if (!version) fail(`entry cites unknown Baseline version ${entry.baseline.version}`);
      if (version?.status !== "ratified") {
        fail(`entry cites Baseline ${entry.baseline.version} with status ${version?.status} — unratified text is never citable`);
      }
      if (entry.changes.length > 0) {
        fail("an entry carrying field changes may not also cite the Baseline (§5.6: R-derivable changes resolve with baseline: null)");
      }
    }
  }

  // §2.1 visibility: actor-private entries exist only under a covert
  // rule's classification.
  if (!opts.covertEntriesAllowed) {
    for (const entry of plan.entries) {
      if (entry.visibility === "actor-private") {
        fail("actor-private entry outside a covert rule classification (§2.1)");
      }
    }
  }

  // Rule ids cited anywhere must exist in the registry.
  for (const entry of plan.entries) {
    for (const ruleId of entry.ruleIds) {
      if (!RULE_DESCRIPTORS[ruleId]) fail(`entry cites unknown rule ${ruleId}`);
    }
  }

  // Pending creation is a permission of the classifying descriptor.
  if (plan.pendingCreates.length > 0 && plan.descriptorId) {
    const descriptor = RULE_DESCRIPTORS[plan.descriptorId];
    if (descriptor && !descriptor.mayCreatePendings) {
      fail(`descriptor ${plan.descriptorId} may not create pendings`);
    }
  }

  // Exactly one summary entry, in last position (rejected plans carry
  // exactly one entry, built by the resolver below).
  const summaries = plan.entries.filter((e) => e.summary);
  if (plan.entries.length > 0) {
    if (summaries.length !== 1) fail(`plan has ${summaries.length} summary entries (exactly one required)`);
    if (!plan.entries[plan.entries.length - 1].summary) fail("the summary entry must be last");
  }

  // Every record a plan claims to create/update must be in its write set.
  const written = new Set(plan.writes.map((w) => w.path));
  for (const entry of plan.entries) {
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      if (!written.has(path)) fail(`entry claims record ${path} but the plan writes no such path`);
    }
  }

  // F-02 reconciliation (Phase 4 Step 0): the union of entry changes[]
  // per (doc path, field) must reconcile with the plan's folded write
  // for that doc — the first change's `before` is the snapshot value,
  // each later change chains off its predecessor, and the last change's
  // `after` is the write's final value. A handler that computed an
  // after-state from the snapshot instead of the planned doc (the old
  // planWrite replacement flaw) produces changes that cannot chain, and
  // fails here instead of committing a Log that claims effects the
  // state never took. Change fields are target-qualified exactly as
  // TC-E02 chains them: relative to the entry's city doc, either a
  // dotted field of the city doc itself (`stats.treasuryRubars`) or a
  // subcollection doc's field (`structures/<id>.status`).
  if (opts.snapshot) {
    const snapshot = opts.snapshot;
    const norm = (v: unknown): unknown => (v === undefined ? null : v);
    const sameValue = (a: unknown, b: unknown): boolean =>
      canonicalJson(projectFirestoreValue(norm(a)) as never) ===
      canonicalJson(projectFirestoreValue(norm(b)) as never);
    const resolveTarget = (
      cityId: string,
      field: string
    ): { path: string; docField: string; write: ResolutionPlan["writes"][number] } | null => {
      const candidates: { path: string; docField: string }[] = [];
      const sub = /^([^/]+)\/([^/.]+)\.(.+)$/.exec(field);
      if (sub) {
        candidates.push({
          path: `sim_cities/${cityId}/${sub[1]}/${sub[2]}`,
          docField: sub[3],
        });
      }
      candidates.push({ path: `sim_cities/${cityId}`, docField: field });
      for (const candidate of candidates) {
        const write = plan.writes.find((w) => w.path === candidate.path);
        if (write && write.changedFields.includes(candidate.docField)) {
          return { ...candidate, write };
        }
      }
      return null;
    };
    interface ChangeGroup {
      path: string;
      docField: string;
      write: ResolutionPlan["writes"][number];
      changes: SimChange[];
    }
    const groups = new Map<string, ChangeGroup>();
    for (const entry of plan.entries) {
      if (!entry.cityId) continue;
      for (const change of entry.changes) {
        const target = resolveTarget(entry.cityId, change.field);
        if (!target) {
          fail(
            `change "${change.field}" (entry city ${entry.cityId}) reconciles with no planned write — the Log would claim an effect the plan does not write (F-02)`
          );
          continue;
        }
        const key = `${target.path}|${target.docField}`;
        const group: ChangeGroup = groups.get(key) ?? { ...target, changes: [] };
        group.changes.push(change);
        groups.set(key, group);
      }
    }
    for (const group of groups.values()) {
      const write = group.write;
      let expected = norm(docField(snapshotDoc(snapshot, group.path), group.docField));
      for (const change of group.changes) {
        if (!sameValue(change.before, expected)) {
          fail(
            `change "${group.docField}" on ${group.path} claims before=${JSON.stringify(norm(change.before))} but the plan's chain holds ${JSON.stringify(expected)} — an after-state was computed against the snapshot instead of the planned doc (F-02)`
          );
        }
        expected = norm(change.after);
      }
      const finalValue =
        write.op === "delete" ? null : norm(docField(write.afterDoc ?? null, group.docField));
      if (!sameValue(expected, finalValue)) {
        fail(
          `changes for "${group.docField}" on ${group.path} end at ${JSON.stringify(expected)} but the planned write lands ${JSON.stringify(finalValue)} (F-02)`
        );
      }
    }
  }
}

export function finalizePlan(plan: ResolutionPlan): ResolutionPlan {
  plan.readRefKeys = [...new Set(plan.readRefKeys)].sort();
  const hashable: Record<string, unknown> = {
    ...(plan as unknown as Record<string, unknown>),
  };
  delete hashable.planHash;
  plan.planHash = sha256Hex(hashable);
  return plan;
}

// ---------------------------------------------------------------------------
// Member actions
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  baselineRegistry: BaselineRegistry;
  mode: "preview" | "commit";
  prepared?: PreparedPayload;
}

export function resolveAction(
  snapshot: SimSnapshot,
  action: SimAction,
  opts: ResolveOptions
): ResolutionPlan {
  const citations = extractCitations(action);
  const descriptor = descriptorForActionKind(action.actionType);

  // Phase 5 authority stage (brief §5.1, PR-2): EVERY npc-actor action
  // passes the stage BEFORE descriptor dispatch — including unruled
  // kinds (the attempt then carries ruleIds [] / classes []). A
  // non-resolve verdict becomes a plan here (planForStageVerdict); a
  // resolve verdict lets dispatch proceed and stamps the summary
  // entry's classification with the mandate citation + trigger.
  let stage: (StageResult & {
    verdict: Extract<AuthorityVerdict, { disposition: "resolve" }>;
  }) | null = null;
  if (action.actor.type === "npc") {
    const result = runAuthorityStage(snapshot, action, opts.prepared);
    if (result.verdict.disposition !== "resolve") {
      const plan = planForStageVerdict(action, result, descriptor?.id ?? null, opts.prepared);
      validatePlan(plan, {
        baselineRegistry: opts.baselineRegistry,
        covertEntriesAllowed: descriptor?.visibility === "covert",
        snapshot,
      });
      return finalizePlan(plan);
    }
    stage = result as StageResult & {
      verdict: Extract<AuthorityVerdict, { disposition: "resolve" }>;
    };
  }

  if (!descriptor) {
    // §5.5 unruled: narrative-only plan, baseline null, changes []. The
    // action still enters the Log (auditability), and that entry is what
    // a later undo targets if the narrative has effects.
    const plan: ResolutionPlan = {
      outcome: "resolved",
      descriptorId: null,
      entries: [
        summaryDraft({
          actor: action.actor,
          actionId: action.actionId,
          actionText: action.actionText,
          classification: {
            verb: null,
            scope: null,
            ruleIds: [],
            unruled: true,
            unruledReason: "no rule classifies this action kind",
          },
          cityId: action.targetCityIds[0] ?? null,
          cityIds: action.targetCityIds,
          ruleIds: [],
          baseline: null,
          summaryText:
            action.actionText ??
            "Narrative action recorded. No rule classifies it (unruled); no state changed.",
        }),
      ],
      writes: [],
      pendingCreates: [],
      pendingTransitions: [],
      pendingReferenceWrites: [],
      readRefKeys: citationRefKeys(citations),
      narrativeOutputs: action.actionText
        ? [{ kind: "note", text: action.actionText }]
        : [],
      planHash: "",
    };
    // An unruled kind under a passing mandate resolves as the narrative
    // plan with the citation stamped (brief §5.1).
    if (stage) stampMandateCitation(plan, stage);
    validatePlan(plan, { baselineRegistry: opts.baselineRegistry, covertEntriesAllowed: false, snapshot });
    return finalizePlan(plan);
  }

  const handler = descriptor.handlers[action.actionType];
  const plan = handler({
    snapshot,
    action,
    resolutionId: action.actionId,
    prepared: opts.prepared,
    baselineRegistry: opts.baselineRegistry,
    citableBaseline: baselineContextFor(opts.baselineRegistry, snapshot.counterHead.lastSeq),
    citations,
  });
  plan.descriptorId = descriptor.id;

  if (plan.outcome === "rejected" && plan.rejection) {
    plan.entries = [
      {
        ...ruleEffectDraft({
          actor: action.actor,
          cityId: action.targetCityIds[0] ?? null,
          cityIds: action.targetCityIds,
          ruleIds: plan.rejection.ruleIds,
          summaryText: plan.rejection.summaryText,
        }),
        kind: "rejected",
        summary: true,
        actionId: action.actionId,
        actionText: action.actionText,
        classification: {
          verb: null,
          scope: null,
          ruleIds: plan.rejection.ruleIds,
          unruled: false,
          rejectionCode: plan.rejection.code,
        },
      },
    ];
  }

  // Resolve verdicts stamp the summary with the mandate citation +
  // trigger — including rejected-handler-path plans (the resolver's
  // rejection conversion above rebuilt the summary entry).
  if (stage) stampMandateCitation(plan, stage);

  validatePlan(plan, {
    baselineRegistry: opts.baselineRegistry,
    covertEntriesAllowed: descriptor.visibility === "covert",
    snapshot,
  });
  return finalizePlan(plan);
}

// ---------------------------------------------------------------------------
// Ripening + voiding (R-33 / R-34) — planned by the same resolver, inside
// the wake that a player action caused. Actor = the origin actor, copied
// verbatim (never "system"); the wake is recorded by the committer in
// wakeActionId/executedDuringSeq, outside the cause chain.
// ---------------------------------------------------------------------------

export function ripeningResolutionId(pendingId: string): string {
  return `ripen_${pendingId}`;
}

export function voidingResolutionId(pendingId: string): string {
  return `void_${pendingId}`;
}

export function resolveRipening(
  snapshot: SimSnapshot,
  pending: Record<string, unknown>,
  opts: { baselineRegistry: BaselineRegistry; prepared?: PreparedPayload }
): ResolutionPlan {
  const pendingId = pending.pendingId as string;
  const resolutionId = ripeningResolutionId(pendingId);
  const originActor = pending.originActor as SimAction["actor"];
  const originSeq = pending.originSeq as number;
  const targetCityId = pending.targetCityId as string;
  const kindConfig = pendingKindConfig(pending.kind as string);
  const spec = pending.payloadSpec as Record<string, unknown>;

  // Data acquisition delivery kinds (Phase 4 step 9 assembly): the
  // plan comes from the acquisition family's delivery builder, which
  // re-validates the prepared findings against this snapshot and
  // writes the intel record — a delivery is not a stat effect, so
  // the R-33 path below cannot express it. Validation keys on the
  // spec's own rule (R-25/R-27/R-28 — the builder sets it as the
  // plan's descriptorId), and the covert flag is the frozen spec's
  // visibility class, never a constant: a covert run's entries stay
  // actor-private, and discovery surfaces exactly one public entry,
  // by citation. Citable Baseline: the ratified version in force at
  // the snapshot's Log head, or null pre-ratification (fail-closed —
  // attitude findings null with BASELINE_UNRATIFIED_SOURCE).
  const delivery = spec.delivery as DeliverySpec | undefined;
  // E6 (Phase 4 close-out): dispatch is on the KIND's declared effect
  // path (PENDING_KINDS), not on payload sniffing — "delivery" is a
  // first-class effect class in the kind registry. A delivery kind
  // whose frozen spec lacks its delivery block is a creation-fence
  // breach and fails closed here (validatePayloadSpec fences it at
  // creation; acquisition's manual drafts are held to the same shape
  // by their builder).
  if (kindConfig.effectPath === "delivery") {
    if (!delivery) {
      throw new RipeningPreparationError(
        `delivery-kind pending ${pendingId} carries no delivery block (creation fence breach)`
      );
    }
    if (!opts.prepared) {
      throw new RipeningPreparationError(
        "generative ripening requires a prepared payload"
      );
    }
    const deliveryPlan = buildDeliveryPlan(snapshot, pending, {
      prepared: opts.prepared,
      citableBaseline:
        citableBaselineVersion(
          opts.baselineRegistry,
          snapshot.counterHead.lastSeq
        )?.version ?? null,
    });
    validatePlan(deliveryPlan, {
      baselineRegistry: opts.baselineRegistry,
      covertEntriesAllowed: delivery.visibilityClass === "actor-private",
      snapshot,
    });
    return finalizePlan(deliveryPlan);
  }

  // Schedule pendings (Phase 5 PR-6 assembly, A1): dispatch on the
  // kind's declared effect path (E6), mirroring the delivery branch
  // — the plan comes from the banking family's ripening
  // composition, which lands, inside this Resolution Event, the
  // schedule marker, the GAP-1 occasion Situation(s) with figures
  // computed at ripening, the successor pending (SPEC-1: premium
  // chains perpetuate at ripening, schedule-anchored, generation-1
  // of a fresh chain), and any B-14 assessment the fund's derived
  // deficiency raises. The composition's HandlerContext carries a
  // synthetic action standing in the origin action's place (the
  // wakeSteps delegation-fire precedent): actor and actionId are
  // the pending's origin, copied verbatim — a schedule ripening is
  // the origin act's own consequence coming due, never a "system"
  // act. The Lead's branch owns the pending's transition, exactly
  // as the R-33 path below owns its own (Felix's assembly list,
  // A1: "commit its plan + transition the pending").
  if (kindConfig.effectPath === "schedule") {
    const scheduleAction: SimAction = {
      actionId: (pending.originActionId as string | null) ?? resolutionId,
      schemaVersion: 2,
      clientRequestId: resolutionId,
      idempotencyKey: resolutionId,
      source: "ripening",
      actor: originActor,
      actionType: pending.kind as string,
      actionText: null,
      structuredAction: null,
      targetCityIds: [targetCityId],
      threadRef: null,
      audienceUids: Array.isArray(pending.audienceUids)
        ? (pending.audienceUids as string[])
        : [],
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
    const schedulePlan = buildScheduleRipeningPlan(
      {
        snapshot,
        action: scheduleAction,
        resolutionId,
        baselineRegistry: opts.baselineRegistry,
        citableBaseline: baselineContextFor(
          opts.baselineRegistry,
          snapshot.counterHead.lastSeq
        ),
        citations: {},
      },
      pending
    );
    // The composition's refusals (an unrecognized schedule kind; a
    // read the wiring did not carry — "nothing ripens blind") are
    // preparation-class failures: they ride the engine's ripening
    // failure channel (attempts counted by the wake scan, then
    // needsAttention), never a committed rejection event — no
    // ripening path in this engine commits rejections.
    if (schedulePlan.outcome === "rejected" && schedulePlan.rejection) {
      throw new RipeningPreparationError(
        `schedule ripening of ${pendingId} refused (${schedulePlan.rejection.code}): ${schedulePlan.rejection.summaryText}`
      );
    }
    schedulePlan.pendingTransitions.push({
      pendingId,
      toStatus: "ripened",
      outcomeSummary:
        schedulePlan.entries.find((entry) => entry.summary)?.summaryText ??
        `Schedule ripening of ${pendingId} (origin seq ${originSeq}).`,
    });
    validatePlan(schedulePlan, {
      baselineRegistry: opts.baselineRegistry,
      covertEntriesAllowed: false,
      snapshot,
    });
    return finalizePlan(schedulePlan);
  }

  const plan: ResolutionPlan = {
    outcome: "resolved",
    descriptorId: "R-33",
    entries: [],
    writes: [],
    pendingCreates: [],
    pendingTransitions: [],
    pendingReferenceWrites: [],
    readRefKeys: [`pending:${pendingId}`, `resolution:${pending.originResolutionId as string}`],
    narrativeOutputs: [],
    planHash: "",
  };

  const application = applyRipeningEffect(snapshot, plan, pending, opts.prepared);

  plan.entries.push(
    ruleEffectDraft({
      actor: originActor,
      ruleIds: ["R-33"],
      cityId: targetCityId,
      cityIds: [targetCityId],
      changes: application.changes,
      recordsUpdated: plan.writes.filter((w) => w.recordClass === "state").map((w) => w.path),
      causedBySeq: originSeq,
      pendingId,
      generation: application.generation,
      summaryText: `R-33 ripening of ${pendingId} (origin seq ${originSeq}).`,
    })
  );

  // R-34 trickle-down: information-only findings, when the origin rule
  // committed to evaluating them.
  if (spec.trickleDown === true) {
    const findings = evaluateTrickleDown(snapshot, pending);
    plan.entries.push(
      ruleEffectDraft({
        actor: originActor,
        ruleIds: ["R-34"],
        cityId: pending.originCityId as string | null,
        cityIds: pending.originCityId ? [pending.originCityId as string] : [],
        changes: [],
        causedBySeq: originSeq,
        pendingId,
        classification: { trickleDownFindings: findings, ruleIds: ["R-34"] },
        summaryText:
          findings.length > 0
            ? `R-34 trickle-down: ${findings.length} propagation path(s) found for ${pendingId}; no mechanical effect in Phase 2.`
            : `R-34 trickle-down: no propagation paths found for ${pendingId}.`,
      })
    );
  }

  // Children — generation-capped, fan-out-capped (brief §7.4). Excess
  // consequences simply do not happen, and the cap is on the record.
  const childGeneration = (pending.generation as number) + 1;
  let capped = false;
  if (application.childSpecs.length > 0) {
    if (childGeneration > PENDING_GENERATION_CAP) {
      capped = true;
    } else {
      const specs = application.childSpecs.slice(0, PENDING_FANOUT_CAP);
      // P4-K23 (Phase 4 close-out): generative briefs arrive
      // pre-sliced from applyRipeningEffect, so the cap test runs
      // against the pre-slice total, not the surviving list.
      if (specs.length < application.childSpecsTotal) capped = true;
      specs.forEach((childSpec, i) => {
        const childId = `pend_${resolutionId}_${String(i + 1).padStart(2, "0")}`;
        const { draft } = buildPendingDraft(snapshot, {
          pendingId: childId,
          kind: childSpec.kind,
          originResolutionId: pending.originResolutionId as string,
          originActionId: pending.originActionId as string | null,
          originActor,
          originCityId: pending.originCityId as string | null,
          originSummaryText: childSpec.summaryText ?? application.outcomeSummary,
          targetCityId: childSpec.targetCityId,
          sourceKind: "ripening",
          generation: childGeneration,
          chainId: pending.chainId as string,
          chainRootPendingId:
            (pending.chainRootPendingId as string | null) ?? pendingId,
          createdByResolutionId: resolutionId,
          payloadSpec: childSpec.payloadSpec,
          fundSize: null,
        });
        draft.doc.originSeq = originSeq;
        plan.pendingCreates.push(draft);
        plan.entries.push(
          ruleEffectDraft({
            actor: originActor,
            ruleIds: ["R-32"],
            cityId: childSpec.targetCityId,
            cityIds: [childSpec.targetCityId],
            changes: [],
            causedBySeq: originSeq,
            pendingId: childId,
            summaryText: `R-32: child consequence ${childId} (generation ${childGeneration}) created by ripening of ${pendingId}.`,
          })
        );
      });
    }
  }
  if (capped) {
    plan.entries.push(
      ruleEffectDraft({
        actor: originActor,
        ruleIds: ["R-33"],
        cityId: targetCityId,
        cityIds: [targetCityId],
        changes: [],
        causedBySeq: originSeq,
        pendingId,
        classification: { capReached: true, ruleIds: ["R-33"] },
        summaryText: `R-33 cap reached while ripening ${pendingId}: further child consequences did not happen (generation cap ${PENDING_GENERATION_CAP}, fan-out cap ${PENDING_FANOUT_CAP}).`,
      })
    );
  }

  plan.pendingTransitions.push({
    pendingId,
    toStatus: "ripened",
    outcomeSummary: application.outcomeSummary,
  });
  plan.entries.push(
    summaryDraft({
      actor: originActor,
      ruleIds: kindConfig.ruleIdsOnRipen,
      cityId: targetCityId,
      cityIds: [targetCityId],
      causedBySeq: originSeq,
      pendingId,
      generation: application.generation,
      summaryText: application.outcomeSummary,
    })
  );

  validatePlan(plan, { baselineRegistry: opts.baselineRegistry, covertEntriesAllowed: false, snapshot });
  return finalizePlan(plan);
}

export function resolveVoiding(
  snapshot: SimSnapshot,
  pending: Record<string, unknown>,
  opts: { baselineRegistry: BaselineRegistry; voidReason: string }
): ResolutionPlan {
  const pendingId = pending.pendingId as string;
  const originActor = pending.originActor as SimAction["actor"];
  const originSeq = pending.originSeq as number;
  const spec = pending.payloadSpec as Record<string, unknown>;
  const plan: ResolutionPlan = {
    outcome: "resolved",
    descriptorId: "R-33",
    entries: [],
    writes: [],
    pendingCreates: [],
    pendingTransitions: [],
    pendingReferenceWrites: [],
    readRefKeys: [`pending:${pendingId}`, `resolution:${pending.originResolutionId as string}`],
    narrativeOutputs: [],
    planHash: "",
  };

  // Voiding effects compose against the PLANNED doc (F-02): two effects
  // on the same city — the in-repo proof of the old replacement flaw —
  // now both land, each change chaining off its predecessor. Changes
  // are grouped per effect city so every change is scoped to the city
  // whose doc it describes (the TC-E02 chaining convention).
  const changesByCity = new Map<string, SimChange[]>();
  const cityOrder: string[] = [];
  const voidEffects = (spec.voidEffects as DeterminateEffect[] | undefined) ?? [];
  for (const effect of voidEffects) {
    const path = `sim_cities/${effect.cityId}`;
    const current = plannedDoc(plan, snapshot, path);
    if (!current) continue;
    const before = docField(current, effect.field);
    if (typeof before !== "number") continue;
    planWrite(plan, snapshot, path, withDocField(current, effect.field, before + effect.delta), "state", [effect.field]);
    if (!changesByCity.has(effect.cityId)) {
      changesByCity.set(effect.cityId, []);
      cityOrder.push(effect.cityId);
    }
    changesByCity.get(effect.cityId)?.push({
      field: effect.field,
      before,
      after: before + effect.delta,
      formula: `voiding effect of ${pendingId} (R-33)`,
    });
  }

  if (cityOrder.length === 0) {
    plan.entries.push(
      ruleEffectDraft({
        actor: originActor,
        ruleIds: ["R-33"],
        cityId: pending.targetCityId as string,
        cityIds: [pending.targetCityId as string],
        changes: [],
        causedBySeq: originSeq,
        pendingId,
        summaryText: `R-33 voiding of ${pendingId}: ${opts.voidReason}.`,
      })
    );
  }
  for (const cityId of cityOrder) {
    plan.entries.push(
      ruleEffectDraft({
        actor: originActor,
        ruleIds: ["R-33"],
        cityId,
        cityIds: [cityId],
        changes: changesByCity.get(cityId) ?? [],
        causedBySeq: originSeq,
        pendingId,
        summaryText: `R-33 voiding of ${pendingId}: ${opts.voidReason}.`,
      })
    );
  }
  plan.pendingTransitions.push({ pendingId, toStatus: "voided", voidReason: opts.voidReason });
  plan.entries.push(
    summaryDraft({
      actor: originActor,
      ruleIds: ["R-33"],
      cityId: pending.targetCityId as string,
      cityIds: [pending.targetCityId as string],
      causedBySeq: originSeq,
      pendingId,
      summaryText: `Pending ${pendingId} voided: ${opts.voidReason}. The world did not change except as its own voiding terms stated.`,
    })
  );

  validatePlan(plan, { baselineRegistry: opts.baselineRegistry, covertEntriesAllowed: false, snapshot });
  return finalizePlan(plan);
}

export function citableBaselineForHead(
  registry: BaselineRegistry,
  headSeq: number
) {
  return citableBaselineVersion(registry, headSeq + 1);
}
