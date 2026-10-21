/**
 * The authority stage wiring (Phase 5 engine core, PR-2; brief §5) —
 * the resolver-side seam between the stored mandate regime
 * (`lib/npcs/**`: SimNpc / SimMandateRoot / SimMandateVersion docs) and
 * the authority dialect (`lib/authority/**`: NpcRecord /
 * MandateVersionRecord / AuthorityView).
 *
 * THE DIALECT SEAM (Lead call, pre-build): the stage — not the module —
 * projects stored docs into the authority dialect, per attempt:
 *  - the STORED-regime integrity check happens here: the stored
 *    version's `mandateHash` must equal `mandateHash()` recomputed over
 *    the stored doc (lib/npcs), or the stage rejects with the module's
 *    own code, MANDATE_HASH_MISMATCH;
 *  - the projected record's `mandateHash` is then the authority-dialect
 *    hash OF THE PROJECTION (`computeMandateHash` over the projected
 *    payload), so the module's internal `mandateVersionState` check is
 *    consistent within its own dialect;
 *  - `npcFromDoc`'s status coercion is NOT trusted: a stored
 *    `pending_activation` (or any non-active/non-retired status) makes
 *    the stage return a reject verdict directly (NPC_NOT_ACTIVE,
 *    naming the status); only a stored `retired` projects as retired
 *    (the module's check 1 then fires) and only a stored `active`
 *    projects as active.
 *
 * Verdicts become PLANS, never throws (see `planForStageVerdict`):
 * reject → the resolver's rejected-plan machinery with the authority
 * module's code VERBATIM (so a revocation landing between preview and
 * commit recomputes to code AUTHORITY_REVOKED and the committer's
 * carve-out commits the rejection instead of stale-previewing);
 * escalate / draft-only / silence / blocked-fairness → resolved plans
 * with `changes: []` and no writes. Partial execution is NOT
 * implemented: an escalate verdict carrying allowPartialExecution still
 * escalates the WHOLE attempt (refusing whole is always lawful) —
 * flag F-E in the PR-2 prep report.
 *
 * Period usage (brief §5.3(e)): counted from the Log BY MANDATE
 * CITATION. The pure core (`runAuthorityStage`) takes the usage from
 * the snapshot's materialized period query (see
 * `collectNpcStageReadPlan` — the F-01 collection query over
 * `sim_log_entries` filtered on `actor.mandateId`); no counter doc is
 * invented.
 */

import {
  computeMandateHash,
  evaluateDelegatedAction,
  isPermissionMode,
  cityContextFromDocs,
  type AuthorityTrigger,
  type AuthorityVerdict,
  type AuthorityView,
  type DelegatedActionAttempt,
  type MandateVersionRecord,
  type NegotiationBoundEntry,
  type NegotiationBounds,
  type NpcRecord,
  type PeriodUsage,
  type TriggerKind,
} from "../authority";
import { mandateHash as storedMandateHash } from "../npcs";
import {
  emptyPlan,
  snapshotDoc,
  type CollectionQuerySpec,
  type PreparedPayload,
  type ResolutionPlan,
  type SimAction,
  type SimSnapshot,
} from "./state";
import { descriptorForActionKind } from "./rules/registry";
import { rejectedPlan, ruleEffectDraft, summaryDraft } from "./rules/planHelpers";
import type { SimCitations } from "./state";

/** Local copy of the resolver's citation extraction (resolver.ts) —
 * duplicated so this module never imports the resolver (which imports
 * this module for the stage wiring). Same grammar, same defaults. */
function extractCitations(action: SimAction): SimCitations {
  const params = (action.structuredAction ?? {}) as Record<string, unknown>;
  const raw = (params.citations ?? {}) as Record<string, unknown>;
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

export const NPC_PERIOD_QUERY_ID = "npc-period-usage";
export const TERMS_PATH = "sim_terms/current";

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// ---------------------------------------------------------------------------
// Trigger vocabulary mapping. Entry vocab (brief §3.2, Vera §3.2):
// {log-event, envelope, mandate-routine, situation}. Authority vocab
// (lib/authority TriggerKind): {log-event, owner-envelope,
// standing-routine, situation, delegated-action, ...}. The mandate's
// stored triggerKinds project through the SAME mapping, so both sides
// of check 5 compare in authority vocab. Unknown kinds pass through
// unchanged (a stored "delegated-action" stays "delegated-action").
// ---------------------------------------------------------------------------

const ENTRY_TO_AUTHORITY_TRIGGER: Record<string, TriggerKind> = {
  "log-event": "log-event",
  envelope: "owner-envelope",
  "mandate-routine": "standing-routine",
  situation: "situation",
};

export function entryTriggerKindToAuthority(kind: string): TriggerKind {
  return ENTRY_TO_AUTHORITY_TRIGGER[kind] ?? (kind as TriggerKind);
}

export function authorityTriggerKindToEntry(kind: TriggerKind): string {
  switch (kind) {
    case "owner-envelope":
      return "envelope";
    case "standing-routine":
      return "mandate-routine";
    default:
      return kind;
  }
}

export interface EntryTriggerCitation {
  kind: string;
  sourceId: string | null;
  sourceSeq: number | null;
  deliberation: unknown;
}

/** The trigger citation as authored on the action (§3.2 entry vocab),
 * read from `structuredAction.trigger`; falls back to the actor's
 * envelope root, then to an owner-confirmed delegation, then null. */
export function entryTriggerOf(action: SimAction): EntryTriggerCitation | null {
  const raw = sa(action).trigger;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const t = raw as Record<string, unknown>;
    if (typeof t.kind === "string") {
      return {
        kind: t.kind,
        sourceId: str(t.sourceId),
        sourceSeq: num(t.sourceSeq),
        deliberation: t.deliberation ?? null,
      };
    }
  }
  if (action.actor.envelopeId !== null) {
    return { kind: "envelope", sourceId: action.actor.envelopeId, sourceSeq: null, deliberation: null };
  }
  return null;
}

function authorityTriggerOf(
  action: SimAction,
  entry: EntryTriggerCitation | null
): AuthorityTrigger | null {
  if (sa(action).ownerConfirmedDelegated === true && entry === null) {
    return { kind: "delegated-action", sourceSeq: null, sourceId: null, routineName: null, envelopeId: null };
  }
  if (entry === null) return null;
  const kind = entryTriggerKindToAuthority(entry.kind);
  return {
    kind,
    sourceSeq: entry.sourceSeq,
    sourceId: entry.sourceId,
    routineName: kind === "standing-routine" ? entry.sourceId : null,
    envelopeId: kind === "owner-envelope" ? (action.actor.envelopeId ?? entry.sourceId) : null,
  };
}

// ---------------------------------------------------------------------------
// Read plan (F-01): everything the stage reads, declared resolver-side
// from the action + (for the version path) the actor's own citation —
// the mandate root path carries the mandateId, so the cited version
// path derives from the ACTION, no seed round-trip needed. The period
// query materializes the mandate's Log entries by citation.
// ---------------------------------------------------------------------------

export function collectNpcStageReadPlan(action: SimAction): {
  paths: string[];
  queries: CollectionQuerySpec[];
} {
  const paths: string[] = [];
  const queries: CollectionQuerySpec[] = [];
  const actor = action.actor;
  if (actor.type !== "npc") return { paths, queries };
  if (actor.npcId) paths.push(`sim_npcs/${actor.npcId}`);
  if (actor.mandateId) {
    paths.push(`sim_mandates/${actor.mandateId}`);
    if (actor.mandateVersion !== null) {
      paths.push(`sim_mandates/${actor.mandateId}/versions/${actor.mandateVersion}`);
    }
    queries.push({
      id: NPC_PERIOD_QUERY_ID,
      collectionPath: "sim_log_entries",
      filters: [{ field: "actor.mandateId", op: "==", value: actor.mandateId }],
    });
  }
  paths.push(TERMS_PATH);
  for (const cityId of strArr(sa(action).counterpartyCityIds)) {
    paths.push(`factions/${cityId}`);
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// Attempt derivation (brief §5.3) — resolver-supplied, mechanical.
// ---------------------------------------------------------------------------

const ACQUISITION_DESCRIPTOR_IDS = new Set(["R-25", "R-26", "R-27", "R-28", "R-29", "R-30", "R-31"]);

export function deriveAttempt(
  snapshot: SimSnapshot,
  action: SimAction
): { attempt: DelegatedActionAttempt; principalCityId: string } {
  const params = sa(action);
  const descriptor = descriptorForActionKind(action.actionType);
  const ruleIds = descriptor ? [descriptor.id] : [];

  const npcDoc = action.actor.npcId
    ? snapshotDoc(snapshot, `sim_npcs/${action.actor.npcId}`)
    : null;
  const principalCityId =
    str(npcDoc?.cityId) ?? str(params.cityId) ?? action.targetCityIds[0] ?? "";

  // Classes — the mechanical subset (descriptor-assigned distinctions
  // a rule id alone cannot carry; classify.ts).
  const classes: string[] = [];
  if (descriptor?.id === "R-06") classes.push("corporate-lifecycle");
  if (descriptor?.id === "R-07" && action.actionType === "dissolve_corporation") {
    classes.push("corporate-lifecycle");
  }
  if (
    descriptor?.id === "R-11" &&
    (action.actionType === "adopt_lore_draft" || action.actionType === "adopt_chronicle_draft")
  ) {
    classes.push("canon-adoption");
  }
  if (descriptor?.id === "R-19" && typeof params.structureId === "string") {
    const cityId = str(params.cityId) ?? principalCityId;
    const structure = snapshotDoc(
      snapshot,
      `sim_cities/${cityId}/structures/${params.structureId}`
    );
    const residents = structure?.residentHouseholdIds;
    if (Array.isArray(residents) && residents.length > 0) classes.push("destruction");
  }

  const namedRecordIds =
    Array.isArray(params.namedRecordIds) && (params.namedRecordIds as unknown[]).length > 0
      ? strArr(params.namedRecordIds)
      : [str(params.structureId) ?? str(params.fundId)].filter(
          (x): x is string => x !== null
        );

  const declaredMovement = num(params.amountRubars) ?? num(params.rubarMovement) ?? 0;

  let negotiation: DelegatedActionAttempt["negotiation"] = null;
  const rawNeg = params.negotiation;
  if (rawNeg !== null && typeof rawNeg === "object" && !Array.isArray(rawNeg)) {
    const n = rawNeg as Record<string, unknown>;
    if (Array.isArray(n.proposedTerms)) {
      negotiation = {
        proposedTerms: n.proposedTerms as NonNullable<DelegatedActionAttempt["negotiation"]>["proposedTerms"],
        turnsUsed: num(n.turnsUsed) ?? 0,
      };
    }
  }

  const attempt: DelegatedActionAttempt = {
    actionType: action.actionType,
    ruleIds,
    classes,
    cityId: principalCityId,
    targetCityIds: [...action.targetCityIds],
    namedRecordIds,
    counterpartyCityIds: strArr(params.counterpartyCityIds),
    // Declared-movement reading (flagged in the prep report): cap
    // checks bind the DECLARED movement; landed money kinds read the
    // same fields, so declared == actual there; novel kinds default 0
    // and are type-gated by allowedActionTypes instead.
    rubarMovement: Math.abs(declaredMovement),
    projectPhase: num(params.toPhase) ?? num(params.projectPhase),
    effectClass:
      descriptor !== null && ACQUISITION_DESCRIPTOR_IDS.has(descriptor.id)
        ? "read-collection"
        : "state-change",
    ownerConfirmedDelegated: params.ownerConfirmedDelegated === true,
    proseStructuredConflict: null, // filled by runAuthorityStage from the prepared payload
    negotiation,
  };
  return { attempt, principalCityId };
}

function proseConflictOf(prepared: PreparedPayload | undefined): string | null {
  if (!prepared) return null;
  const classification = prepared.classification;
  if (classification !== null && typeof classification === "object" && !Array.isArray(classification)) {
    const v = (classification as Record<string, unknown>).proseStructuredConflict;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Period usage — counted from the Log by mandate citation (§5.3(e)).
// The wiring's mechanical counting rule: among the materialized period
// query's entries citing this mandate + version, resolutions are the
// distinct resolutionIds; Rubars are the summed absolute numeric deltas
// of `*Rubars` field changes. The mandate's own periodDefinition
// windows the count: "actions" keeps the newest `count` resolutions;
// "seqWindow" keeps resolutions with an entry seq after atSeq - count.
// ---------------------------------------------------------------------------

export function computePeriodUsage(
  snapshot: SimSnapshot,
  mandateId: string,
  mandateVersion: number,
  periodDefinition: { kind: "actions" | "seqWindow"; count: number } | null,
  atSeq: number
): PeriodUsage {
  const record = snapshot.queries.find((q) => q.spec.id === NPC_PERIOD_QUERY_ID);
  if (!record) return { delegatedResolutions: 0, delegatedRubars: 0 };
  interface ResAgg { maxSeq: number; rubars: number }
  const byResolution = new Map<string, ResAgg>();
  for (const path of record.resultPaths) {
    const entry = snapshotDoc(snapshot, path);
    if (!entry) continue;
    const actor = entry.actor as Record<string, unknown> | undefined;
    if (!actor || actor.mandateId !== mandateId || actor.mandateVersion !== mandateVersion) continue;
    const resolutionId = str(entry.resolutionId) ?? "";
    const seq = num(entry.seq) ?? 0;
    let rubars = 0;
    for (const change of (entry.changes as { field?: unknown; before?: unknown; after?: unknown }[] | undefined) ?? []) {
      if (
        typeof change.field === "string" &&
        change.field.includes("Rubars") &&
        typeof change.before === "number" &&
        typeof change.after === "number"
      ) {
        rubars += Math.abs(change.after - change.before);
      }
    }
    const agg = byResolution.get(resolutionId) ?? { maxSeq: 0, rubars: 0 };
    agg.maxSeq = Math.max(agg.maxSeq, seq);
    agg.rubars += rubars;
    byResolution.set(resolutionId, agg);
  }
  let resolutions = [...byResolution.values()];
  if (periodDefinition?.kind === "seqWindow") {
    resolutions = resolutions.filter((r) => r.maxSeq > atSeq - periodDefinition.count);
  } else if (periodDefinition?.kind === "actions") {
    resolutions = resolutions
      .sort((a, b) => b.maxSeq - a.maxSeq)
      .slice(0, periodDefinition.count);
  }
  return {
    delegatedResolutions: resolutions.length,
    delegatedRubars: resolutions.reduce((sum, r) => sum + r.rubars, 0),
  };
}

// ---------------------------------------------------------------------------
// The dialect-seam projection: stored docs → AuthorityView.
// ---------------------------------------------------------------------------

function projectNegotiationSide(
  value: unknown,
  attempt: DelegatedActionAttempt,
  side: "offer" | "accept"
): NegotiationBoundEntry[] {
  // mayOffer/mayAccept === false ⇒ no entries for that side. A non-false
  // prose value (string, or true) ⇒ per-term-kind entries with NO
  // amount limits, one per distinct kind the attempt proposes on this
  // side (amount prose is interpretation — recorded, never silently
  // mechanical). null/absent ⇒ no entries (fail-closed: a negotiation
  // attempt then diffs out-of-bounds and escalates).
  if (value === false || value === null || value === undefined) return [];
  if (attempt.negotiation === null) return [];
  const kinds = new Set<string>();
  for (const term of attempt.negotiation.proposedTerms) {
    if (term.side === side) kinds.add(term.kind);
  }
  return [...kinds].map((kind) => ({ kind }));
}

function projectNegotiationBounds(
  stored: Record<string, unknown> | null,
  attempt: DelegatedActionAttempt
): NegotiationBounds | null {
  if (stored === null) return null;
  return {
    subject: "mandate-negotiation",
    mayOffer: projectNegotiationSide(stored.mayOffer, attempt, "offer"),
    mayAccept: projectNegotiationSide(stored.mayAccept, attempt, "accept"),
    walkAwayIf: typeof stored.walkAwayIf === "string" && stored.walkAwayIf.length > 0 ? [stored.walkAwayIf] : [],
    maxTurns: num(stored.maxTurns) ?? Number.MAX_SAFE_INTEGER,
  };
}

type Projection =
  | { kind: "view"; view: AuthorityView }
  | { kind: "verdict"; verdict: AuthorityVerdict };

export function projectAuthorityView(
  snapshot: SimSnapshot,
  action: SimAction,
  attempt: DelegatedActionAttempt,
  periodUsage: PeriodUsage
): Projection {
  const actor = action.actor;
  const atSeq = snapshot.counterHead.lastSeq + 1;
  const reject = (code: string, reason: string): Projection => ({
    kind: "verdict",
    verdict: { disposition: "reject", code, reason, checks: [] },
  });

  // -- NPC record (status coercion NOT trusted — see header) -----------
  let npc: NpcRecord | null = null;
  const npcDoc = actor.npcId ? snapshotDoc(snapshot, `sim_npcs/${actor.npcId}`) : null;
  if (npcDoc !== null && actor.npcId) {
    const status = str(npcDoc.status);
    if (status !== "active" && status !== "retired") {
      return reject(
        "NPC_NOT_ACTIVE",
        `NPC ${actor.npcId} is ${status ?? "in an unknown status"} — only an active NPC may act (the stored status is read verbatim, never coerced).`
      );
    }
    const cityId = str(npcDoc.cityId);
    const ownerUid = str(npcDoc.ownerUid);
    if (cityId === null || ownerUid === null) {
      npc = null; // malformed record degrades to NPC_NOT_FOUND in check 1
    } else {
      npc = {
        npcId: str(npcDoc.npcId) ?? actor.npcId,
        characterId: str(npcDoc.characterId) ?? "",
        cityId,
        ownerUid,
        permissionMode: isPermissionMode(npcDoc.permissionMode)
          ? npcDoc.permissionMode
          : "ask-first",
        status,
        currentMandateId: str(npcDoc.currentMandateId),
        currentMandateVersion: num(npcDoc.currentMandateVersion),
        activationSeq: num(npcDoc.activationSeq) ?? 0,
        retiredSeq: num(npcDoc.retiredSeq),
      };
    }
  }

  // -- Mandate root + cited version ------------------------------------
  let mandateRoot: AuthorityView["mandateRoot"] = null;
  let mandateVersion: MandateVersionRecord | null = null;
  if (actor.mandateId !== null) {
    const rootDoc = snapshotDoc(snapshot, `sim_mandates/${actor.mandateId}`);
    if (rootDoc !== null) {
      const rootNpcId = str(rootDoc.npcId);
      const rootCityId = str(rootDoc.cityId);
      const rootOwnerUid = str(rootDoc.ownerUid);
      const currentVersion = num(rootDoc.currentVersion);
      if (rootNpcId !== null && rootCityId !== null && rootOwnerUid !== null && currentVersion !== null) {
        mandateRoot = {
          mandateId: str(rootDoc.mandateId) ?? actor.mandateId,
          npcId: rootNpcId,
          cityId: rootCityId,
          ownerUid: rootOwnerUid,
          currentVersion,
        };
      }
      if (actor.mandateVersion !== null) {
        const versionDoc = snapshotDoc(
          snapshot,
          `sim_mandates/${actor.mandateId}/versions/${actor.mandateVersion}`
        );
        if (versionDoc !== null) {
          // Stored-regime integrity (this stage's own check): the
          // stored hash must recompute over the stored doc.
          let storedHashOk = false;
          try {
            storedHashOk =
              typeof versionDoc.mandateHash === "string" &&
              storedMandateHash(versionDoc as never) === versionDoc.mandateHash;
          } catch {
            storedHashOk = false;
          }
          if (!storedHashOk) {
            return reject(
              "MANDATE_HASH_MISMATCH",
              `stored mandate ${actor.mandateId} version ${actor.mandateVersion} fails its stored-regime integrity check (mandateHash does not recompute over the stored doc) — evaluation fails closed.`
            );
          }
          const structuredScope = (versionDoc.structuredScope ?? {}) as Record<string, unknown>;
          const caps = (versionDoc.caps ?? {}) as Record<string, unknown>;
          const storedCounterparties = structuredScope.counterpartyCityIds;
          const rootRevoked =
            str(rootDoc.status) === "revoked" || rootDoc.revokedSeq !== null && rootDoc.revokedSeq !== undefined;
          const versionExpires = num(versionDoc.expiresAtSeq);
          const rootExpires = num(rootDoc.expiresAtSeq);
          const status: MandateVersionRecord["status"] = rootRevoked
            ? "revoked"
            : versionDoc.supersededSeq !== null && versionDoc.supersededSeq !== undefined
              ? "superseded"
              : versionDoc.effectiveSeq === null || versionDoc.effectiveSeq === undefined
                ? "pending"
                : str(rootDoc.status) === "expired" ||
                    (versionExpires !== null && atSeq >= versionExpires) ||
                    (rootExpires !== null && atSeq >= rootExpires)
                  ? "expired"
                  : "active";
          const projected: MandateVersionRecord = {
            mandateId: actor.mandateId,
            version: actor.mandateVersion,
            status,
            mode: isPermissionMode(versionDoc.permissionMode)
              ? versionDoc.permissionMode
              : "ask-first",
            scope: {
              allowedActionTypes: strArr(structuredScope.allowedActionTypes),
              namedRecordIds: strArr(structuredScope.namedRecordIds),
              // Stored null ⇒ no restriction: project the attempt's own
              // counterparty list (NOT the empty list).
              counterpartyCityIds:
                storedCounterparties === null || storedCounterparties === undefined
                  ? [...attempt.counterpartyCityIds]
                  : strArr(storedCounterparties),
              perActionRubars: num(caps.perActionRubars),
              perPeriodRubars: num(caps.perResolutionPeriodRubars),
              perPeriodActions:
                caps.periodDefinition !== null &&
                typeof caps.periodDefinition === "object" &&
                (caps.periodDefinition as Record<string, unknown>).kind === "actions"
                  ? num((caps.periodDefinition as Record<string, unknown>).count)
                  : null,
              periodDefinition:
                caps.periodDefinition !== null && typeof caps.periodDefinition === "object"
                  ? `${String((caps.periodDefinition as Record<string, unknown>).kind)}:${String((caps.periodDefinition as Record<string, unknown>).count)}`
                  : "",
              maxProjectPhase: num(caps.maxProjectPhase),
              triggerKinds: strArr(structuredScope.triggerKinds).map(entryTriggerKindToAuthority),
              negotiationBounds: projectNegotiationBounds(
                versionDoc.negotiationBounds !== null &&
                  typeof versionDoc.negotiationBounds === "object"
                  ? (versionDoc.negotiationBounds as Record<string, unknown>)
                  : null,
                attempt
              ),
              alwaysEscalate: strArr(versionDoc.alwaysEscalate),
              allowPartialExecution: caps.allowPartialExecution === true,
            },
            expiresAtSeq: versionExpires,
            horizonActions: num(versionDoc.horizonActions),
            effectiveSeq: num(versionDoc.effectiveSeq),
            revokedSeq: num(rootDoc.revokedSeq),
            mandateHash: "",
            createdByUid: str(versionDoc.ownerUid) ?? "",
          };
          // The projected record's hash is the authority-dialect hash
          // OF THE PROJECTION, so the module's internal state check is
          // consistent within its dialect.
          projected.mandateHash = computeMandateHash(projected);
          mandateVersion = projected;
        }
      }
    }
  }

  // -- Cities ------------------------------------------------------------
  const world = snapshotDoc(snapshot, "sim_world/current");
  const sharedCityId = str(world?.sharedCityId);
  const termsDoc = snapshotDoc(snapshot, TERMS_PATH);
  const cities = new Map<string, ReturnType<typeof cityContextFromDocs>>();
  const cityIds = new Set<string>([
    attempt.cityId,
    ...attempt.targetCityIds,
    ...attempt.counterpartyCityIds,
  ]);
  for (const cityId of cityIds) {
    if (!cityId) continue;
    cities.set(
      cityId,
      cityContextFromDocs(cityId, snapshotDoc(snapshot, `factions/${cityId}`), sharedCityId, termsDoc)
    );
  }

  return {
    kind: "view",
    view: { npc, mandateRoot, mandateVersion, cities, periodUsage, ruleMode: null, atSeq },
  };
}

// ---------------------------------------------------------------------------
// The stage entry point.
// ---------------------------------------------------------------------------

export interface StageResult {
  verdict: AuthorityVerdict;
  attempt: DelegatedActionAttempt;
  entryTrigger: EntryTriggerCitation | null;
}

export function runAuthorityStage(
  snapshot: SimSnapshot,
  action: SimAction,
  prepared?: PreparedPayload
): StageResult {
  const { attempt } = deriveAttempt(snapshot, action);
  attempt.proseStructuredConflict = proseConflictOf(prepared);
  const entryTrigger = entryTriggerOf(action);
  const trigger = authorityTriggerOf(action, entryTrigger);

  // Period usage under the cited version's own periodDefinition.
  let periodDefinition: { kind: "actions" | "seqWindow"; count: number } | null = null;
  if (action.actor.mandateId && action.actor.mandateVersion !== null) {
    const versionDoc = snapshotDoc(
      snapshot,
      `sim_mandates/${action.actor.mandateId}/versions/${action.actor.mandateVersion}`
    );
    const pd = (versionDoc?.caps as Record<string, unknown> | undefined)?.periodDefinition;
    if (pd !== null && typeof pd === "object") {
      const p = pd as Record<string, unknown>;
      if ((p.kind === "actions" || p.kind === "seqWindow") && typeof p.count === "number") {
        periodDefinition = { kind: p.kind, count: p.count };
      }
    }
  }
  const atSeq = snapshot.counterHead.lastSeq + 1;
  const periodUsage =
    action.actor.mandateId && action.actor.mandateVersion !== null
      ? computePeriodUsage(snapshot, action.actor.mandateId, action.actor.mandateVersion, periodDefinition, atSeq)
      : { delegatedResolutions: 0, delegatedRubars: 0 };

  const projection = projectAuthorityView(snapshot, action, attempt, periodUsage);
  if (projection.kind === "verdict") {
    return { verdict: projection.verdict, attempt, entryTrigger };
  }
  const verdict = evaluateDelegatedAction(projection.view, action.actor, attempt, trigger);
  return { verdict, attempt, entryTrigger };
}

// ---------------------------------------------------------------------------
// Verdict → plan mapping (verdicts become plans, never throws).
// ---------------------------------------------------------------------------

function citationRefKeysFor(action: SimAction): string[] {
  const citations = extractCitations(action);
  const keys: string[] = [];
  for (const id of citations.resolutionIds ?? []) keys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) keys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) keys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) keys.push(`seq:${seq}`);
  keys.push(`resolution:${action.actionId}`);
  return keys;
}

/** The §3.2 trigger citation stamped on resolved entries (entry vocab). */
export function triggerClassification(
  stage: StageResult
): Record<string, unknown> {
  const t = stage.entryTrigger;
  return {
    kind: t?.kind ?? "log-event",
    sourceId: t?.sourceId ?? null,
    sourceSeq: t?.sourceSeq ?? null,
    deliberation: t?.deliberation ?? null,
  };
}

/** Merge the mandate citation + trigger into EVERY entry's
 * classification (which may be null) on resolve verdicts — including
 * the resolver's rejected-handler-path plans.
 *
 * PR #45 CI round 8: this stamp originally landed on the summary
 * entry only, but the standing verifier's §3.2 traceability reads
 * classification.trigger on every entry whose actor is an NPC — a
 * multi-entry handler plan leaves its non-summary entries as orphans
 * (the gate suite's seq 14: fixture_adjust's rule-effect detail entry
 * stood triggerless beside its stamped summary at seq 15). The
 * citation is a property of the resolution's authority, not of the
 * summary, so it lands on every entry the resolution writes; each
 * entry's own classification keys are preserved. */
export function stampMandateCitation(
  plan: ResolutionPlan,
  stage: StageResult & { verdict: Extract<AuthorityVerdict, { disposition: "resolve" }> }
): void {
  for (const entry of plan.entries) {
    const existing =
      entry.classification !== null && typeof entry.classification === "object"
        ? entry.classification
        : {};
    entry.classification = {
      ...existing,
      mandate: {
        mandateId: stage.verdict.citation.mandateId,
        mandateVersion: stage.verdict.citation.mandateVersion,
        mode: stage.verdict.citation.mode,
      },
      trigger: triggerClassification(stage),
    };
  }
}

export function planForStageVerdict(
  action: SimAction,
  stage: StageResult,
  descriptorId: string | null,
  prepared?: PreparedPayload
): ResolutionPlan {
  const verdict = stage.verdict;
  const ruleIds = descriptorId ? [descriptorId] : [];
  const principalCityId = stage.attempt.cityId || action.targetCityIds[0] || null;
  const cityIds = [...new Set([principalCityId, ...action.targetCityIds].filter((c): c is string => c !== null))];

  if (verdict.disposition === "reject") {
    const plan = rejectedPlan(descriptorId, verdict.code, ruleIds, verdict.reason);
    plan.entries = [
      {
        ...ruleEffectDraft({
          actor: action.actor,
          cityId: principalCityId,
          cityIds,
          ruleIds,
          summaryText: verdict.reason,
        }),
        kind: "rejected",
        summary: true,
        actionId: action.actionId,
        actionText: action.actionText,
        classification: {
          verb: null,
          scope: null,
          ruleIds,
          unruled: false,
          rejectionCode: verdict.code,
          // §3.2 parity with the sibling verdict plans below (PR #45
          // CI round 8): a stage-rejected NPC entry is still an NPC
          // entry — it carries the mandate keys and the trigger
          // citation the stage actually verified. For a NO_TRIGGER_ROOT
          // rejection the citation is the defaulted one (kind
          // "log-event", sourceSeq null): the honest record of a
          // triggerless attempt, which no landed path produces
          // (the wake executor stamps every delegated action; envelope
          // executions root at the envelope).
          mandateId: action.actor.mandateId,
          mandateVersion: action.actor.mandateVersion,
          trigger: triggerClassification(stage),
        },
      },
    ];
    plan.readRefKeys = citationRefKeysFor(action);
    return plan;
  }

  const plan = emptyPlan(descriptorId);
  plan.readRefKeys = citationRefKeysFor(action);

  if (verdict.disposition === "escalate") {
    plan.entries.push(
      summaryDraft({
        actor: action.actor,
        actionId: action.actionId,
        actionText: action.actionText,
        cityId: principalCityId,
        cityIds,
        ruleIds,
        classification: {
          verb: action.actionType,
          scope: "city",
          ruleIds,
          unruled: false,
          producer: "escalation",
          escalation: {
            failedCheck: verdict.failedCheck,
            reason: verdict.reason,
            scopeFailures: verdict.scopeFailures,
            // Partial execution is NOT implemented (flag F-E): the
            // payload records what the mandate allowed; the plan
            // escalates the whole attempt regardless.
            allowPartialExecution: verdict.allowPartialExecution,
            outOfBounds: verdict.outOfBounds,
            checks: verdict.checks,
          },
          mandateId: action.actor.mandateId,
          mandateVersion: action.actor.mandateVersion,
          trigger: triggerClassification(stage),
        },
        summaryText:
          `Escalation: NPC action "${action.actionType}" stopped at the authority stage — ${verdict.failedCheck}: ${verdict.reason} ` +
          `The Situation record for the owner is materialized by the Situations step (PR-3); this entry is the §6.5 escalation record.`,
      })
    );
    return plan;
  }

  if (verdict.disposition === "draft-only") {
    const draftText =
      action.actionText ??
      (typeof prepared?.generatedContent === "string" ? prepared.generatedContent : null);
    if (draftText !== null && draftText.trim().length > 0) {
      plan.narrativeOutputs.push({ kind: "chronicle", text: draftText });
    }
    plan.entries.push(
      summaryDraft({
        actor: action.actor,
        actionId: action.actionId,
        actionText: action.actionText,
        // The principal cityId rides the summary so the Phase 4
        // step-11 chronicle badging never throws CHRONICLE_UNBADGEABLE.
        cityId: principalCityId,
        cityIds,
        ruleIds,
        classification: {
          verb: action.actionType,
          scope: "city",
          ruleIds,
          unruled: false,
          producer: "draft-only",
          draftOnly: { reason: verdict.reason, detail: verdict.detail },
          mandateId: action.actor.mandateId,
          mandateVersion: action.actor.mandateVersion,
          trigger: triggerClassification(stage),
        },
        summaryText:
          `Draft only (${verdict.reason}): ${verdict.detail} The NPC's prepared text lands as an npc-draft chronicle; no state changed.`,
      })
    );
    return plan;
  }

  if (verdict.disposition === "silence") {
    const t = stage.entryTrigger;
    plan.entries.push(
      summaryDraft({
        actor: action.actor,
        actionId: action.actionId,
        actionText: action.actionText,
        cityId: principalCityId,
        cityIds,
        ruleIds,
        // Silence + producingMode + situation fields, with the
        // trigger in the §3.2 entry vocabulary — the same citation
        // triggerClassification stamps everywhere (PR #45 CI round 8;
        // the pre-fix mirror of buildSilenceCommit's {sourceKind, …}
        // shape read as triggerless to the standing verifier, whose
        // traceability keys on trigger.kind).
        classification: {
          silence: true,
          producingMode: "silent",
          situationId: t?.kind === "situation" ? t.sourceId : null,
          situationKind: null,
          trigger: triggerClassification(stage),
        },
        summaryText: `No response — the NPC acting for ${principalCityId ?? "its city"} is in silent mode; the leader didn't say anything.`,
      })
    );
    return plan;
  }

  // blocked-fairness — a wall, not an owner question: no Situation.
  if (verdict.disposition !== "blocked-fairness") {
    // Unreachable: resolve verdicts never reach planForStageVerdict
    // (the resolver dispatches them); every other disposition returns
    // above. A throw here is a wiring bug, not a domain outcome.
    throw new Error(`planForStageVerdict called with disposition ${verdict.disposition}`);
  }
  plan.entries.push(
    summaryDraft({
      actor: action.actor,
      actionId: action.actionId,
      actionText: action.actionText,
      cityId: principalCityId,
      cityIds,
      ruleIds,
      classification: {
        verb: action.actionType,
        scope: "city",
        ruleIds,
        unruled: false,
        producer: "blocked-fairness",
        blockedFairness: { reason: verdict.reason, checks: verdict.checks },
        mandateId: action.actor.mandateId,
        mandateVersion: action.actor.mandateVersion,
        trigger: triggerClassification(stage),
      },
      summaryText: `Blocked by the fairness fence: ${verdict.reason} No state changed and no Situation is raised — a wall, not an owner question.`,
    })
  );
  return plan;
}
