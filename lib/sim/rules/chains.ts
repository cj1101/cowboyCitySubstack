/**
 * Chains — consequence chains & funds (Phase 4 brief §9, step 10):
 * the product R-32 fund/program verbs riding the landed Phase 2
 * pending-consequence machinery (Action-Gated Ripening, spec v2 §1.6).
 *
 * What lives here:
 *  - `establish_fund` — a member commits Rubars from a city treasury
 *    into a named fund with published terms (purpose kind from the
 *    landed kind registry, mode, disbursement or bounds, dissolution
 *    return), creating the fund record and exactly one generation-1
 *    pending. The delay is DERIVED at creation from the landed formula
 *    (base hours × fund scale × infrastructure factor × connectivity
 *    factor) and disclosed in the Log — a ripening is gated on
 *    resolved events (seq), a wall-clock floor, and later player
 *    activity, never on a clock alone (CJ causality rule).
 *  - `dissolve_fund` — the owner ends the fund: unspent Rubars return
 *    to the treasury in the same Resolution Event, the record flips
 *    to `dissolved`, and the fund's still-pending consequences are
 *    NOT erased — each ends as a logged voiding at its next ripeness
 *    evaluation, because its fund-status precondition (recorded at
 *    creation, onFalse "void") no longer holds (P2-K5: ripenings and
 *    voidings are resolutions, never erasures).
 *
 * What does NOT live here: the ripening application itself (R-33) and
 * trickle-down evaluation (R-34) are resolver machinery (landed in
 * Phase 2: `applyRipeningEffect` / `evaluateTrickleDown`), invoked by
 * the scan over pendings this module creates. Fund pendings set
 * `trickleDown: true` so R-34's information-only findings ride every
 * fund ripening; priced propagation is a later phase's handlers,
 * never this file's.
 *
 * Assembly (Build Lead): this file is NOT registered in `registry.ts`.
 * The registry already carries an inline "R-32" descriptor holding the
 * Phase 2 FIXTURE kinds (`fixture_fund` / `fixture_schedule` /
 * `fixture_check_in`) whose handlers live in the registry and whose
 * gate tests depend on them. Assembly MERGES: the composed R-32
 * descriptor keeps the fixture actionKinds/handlers and adds
 * CHAINS_DESCRIPTORS["R-32"].actionKinds / .handlers (exported
 * separately below as R32_PRODUCT_ACTION_KINDS / R32_PRODUCT_HANDLERS
 * for exactly that merge). Fund records live in their own
 * subcollection, `sim_cities/{cityId}/funds/{fundId}` — deliberately
 * NOT the structures subcollection: Catalogue I owns that collection
 * semantically (every doc there is a structure with status/condition
 * semantics, enumerated by the R-05 collection reads), and a fund is
 * a first-class entity of its own (CJ: no decoration-only entities).
 * The resolver's base read paths add a fixture-shaped
 * `structures/{fundId}` read when an action names `fundId`; the
 * descriptor read-plan hook below adds the real funds path, and the
 * stale base read lands on an absent doc (benign). Rules/index needs
 * are specced in workstreams/p4-chains-prep-report.md.
 *
 * Handler discipline (Step 0 contracts, binding): handlers are pure
 * (snapshot, action) → plan; domain refusals return rejection plans,
 * never throw; every write composes against the planned doc (F-02);
 * authority reads stored records (faction ownerUids via
 * checkCityAuthority; for the shared city, the sitting-mayor actor
 * shape — the allocation module's posture, terms data is Phase 7's).
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  withDocField,
  type LogEntryDraft,
  type ResolutionPlan,
  type SimAction,
  type SimSnapshot,
} from "../state";
import {
  fieldChange,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import {
  checkCityAuthority,
  type DescriptorReadPlan,
  type HandlerContext,
  type HandlerFn,
  type ReadPlanSeeds,
  type RuleDescriptor,
} from "./registry";
import {
  buildPendingDraft,
  PENDING_KINDS,
  PendingSpecError,
  type StructuredPrecondition,
} from "./pendingRules";

// ---------------------------------------------------------------------------
// Fund record vocabulary
// ---------------------------------------------------------------------------

export function fundPath(cityId: string, fundId: string): string {
  return `sim_cities/${cityId}/funds/${fundId}`;
}

export function fundsCollectionPath(cityId: string): string {
  return `sim_cities/${cityId}/funds`;
}

/** The published purpose-kind list (spec R-32: "purpose kind from the
 * published kind list") IS the landed pending-kind registry — the
 * possibility space is code, not prose, so a fund can only promise a
 * consequence the machinery knows how to ripen. */
export function fundPurposeKinds(): string[] {
  return Object.keys(PENDING_KINDS);
}

/** The dissolution term recorded on every fund at creation (R-32's
 * terms are published at creation; v1 offers the one return the
 * design's canonical case uses). */
export const FUND_DISSOLUTION_RETURN = "treasury" as const;

// ---------------------------------------------------------------------------
// Shared handler helpers (local copies, the family-file pattern — this
// module must not import the registry's unexported internals).
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

const actionCityId = (action: SimAction): string =>
  typeof sa(action).cityId === "string"
    ? (sa(action).cityId as string)
    : (action.targetCityIds[0] ?? "");

const num = (doc: Record<string, unknown> | null, field: string): number | null => {
  const value = docField(doc, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

function actorCitations(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  resolutionId: string
): void {
  const citations = ctx.citations;
  for (const id of citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${resolutionId}`);
}

/** Fund authority: the city owner — or, for the shared city, the
 * sitting mayor alone (CJ round 3; the allocation module's posture —
 * mayor identity terms data is Phase 7's, so the guard enforces the
 * shared-office actor shape until then). */
function requireFundAuthority(
  ctx: HandlerContext,
  descriptorId: string
): ResolutionPlan | null {
  const cityId = actionCityId(ctx.action);
  const city = snapshotDoc(ctx.snapshot, `sim_cities/${cityId}`);
  if (city?.isSharedCity === true) {
    const actor = ctx.action.actor;
    if (actor.type !== "shared-office" || actor.office !== "mayor" || !actor.memberId) {
      return rejectedPlan(
        descriptorId,
        "AUTHORITY_REVOKED",
        ["R-32"],
        `${cityId} is the shared city: its funds are the sitting mayor's act alone (CJ round 3), and this actor is not a shared-office mayor actor.`
      );
    }
    return null;
  }
  const verdict = checkCityAuthority(ctx.snapshot, cityId, ctx.action.actor);
  if (!verdict.ok) {
    return rejectedPlan(
      descriptorId,
      "AUTHORITY_REVOKED",
      ["R-32"],
      `Authority revoked for ${ctx.action.actor.memberId ?? "actor"} over ${cityId}: ${verdict.reason}.`
    );
  }
  return null;
}

/** The preconditions every fund pending carries (Felix's canonical
 * case, §3 of the chains design): the fund must still stand and still
 * hold money when the consequence comes due. Either failing VOIDS
 * the pending — a dissolved or exhausted fund's breakthrough never
 * ripens (P4-K20's fixture posture). */
export function fundPreconditions(fPath: string): StructuredPrecondition[] {
  return [
    {
      type: "record-status",
      path: fPath,
      field: null,
      operator: "==",
      value: "active",
      onFalse: "void",
    },
    {
      type: "record-field-gt",
      path: fPath,
      field: "remainingRubars",
      operator: ">",
      value: 0,
      onFalse: "void",
    },
  ];
}

export interface FundPendingArgs {
  fundPath: string;
  cityId: string;
  purposeKind: string;
  mode: "determinate" | "generative";
  /** Determinate: the fund disbursement booked at ripening. */
  disbursementRubars?: number | null;
  /** Determinate: the stat effect applied at ripening (host city). */
  effectField?: string | null;
  effectDelta?: number | null;
  /** Generative: the published value band for the prepared outcome. */
  minRubars?: number | null;
  maxRubars?: number | null;
  summaryOnRipen?: string | null;
  requiresActionInCities?: string[];
}

/** Build the payloadSpec a fund's generation-1 pending carries, in
 * the landed machinery's shape (preconditions and the activity gate
 * ride inside the spec; buildPendingDraft lifts them into the ripen
 * condition). Pure and exported so the harness (and the Lead's gate)
 * can pin the exact spec shape without running a handler. Throws
 * PendingSpecError on an unlawful spec — handlers convert that to a
 * rejection plan. */
export function buildFundPayloadSpec(args: FundPendingArgs): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    mode: args.mode,
    trickleDown: true,
    fundPath: args.fundPath,
    preconditions: fundPreconditions(args.fundPath),
    requiresActionInCities: args.requiresActionInCities ?? [args.cityId],
  };
  if (args.mode === "determinate") {
    if (!args.effectField || typeof args.effectDelta !== "number") {
      throw new PendingSpecError(
        "a determinate fund pending needs its ripening effect (effectField + effectDelta) stated at creation"
      );
    }
    spec.effect = {
      type: "stat-delta",
      cityId: args.cityId,
      field: args.effectField,
      delta: args.effectDelta,
    };
    if (args.disbursementRubars != null) spec.fundDisbursementRubars = args.disbursementRubars;
    if (args.summaryOnRipen) spec.summaryOnRipen = args.summaryOnRipen;
  } else {
    spec.bounds = {
      minRubars: args.minRubars ?? 1,
      maxRubars: args.maxRubars ?? 0,
    };
  }
  return spec;
}

/** Drop record claims the folded plan does not actually perform
 * (the Catalogue I discipline — validatePlan reconciles claims
 * against writes). */
function pruneRecordClaims(plan: ResolutionPlan): void {
  const ops = new Map(plan.writes.map((w) => [w.path, w.op]));
  for (const entry of plan.entries) {
    const created = new Set<string>();
    const updated = new Set<string>();
    for (const path of [...entry.recordsCreated, ...entry.recordsUpdated]) {
      const op = ops.get(path);
      if (op === "create") created.add(path);
      else if (op !== undefined) updated.add(path);
    }
    entry.recordsCreated = [...created];
    entry.recordsUpdated = [...updated];
  }
}

function fundReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const params = (seeds.action.structuredAction ?? {}) as Record<string, unknown>;
  const cityId =
    (typeof params.cityId === "string" ? params.cityId : undefined) ??
    seeds.action.targetCityIds[0] ??
    "";
  const fundId = typeof params.fundId === "string" ? params.fundId : "";
  if (!cityId || !fundId) return {};
  return { paths: [fundPath(cityId, fundId)] };
}

// ---------------------------------------------------------------------------
// R-32 — establish a fund (the canonical verb)
// ---------------------------------------------------------------------------

function establishFundHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-32";
  const ruleIds = ["R-32"];
  const denied = requireFundAuthority(ctx, descriptorId);
  if (denied) return denied;

  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) {
    return rejectedPlan(descriptorId, "NO_CITY", ruleIds, `City ${cityId} does not stand.`);
  }

  const fundId =
    typeof params.fundId === "string" && params.fundId.length > 0
      ? params.fundId
      : `fund_${ctx.resolutionId}`;
  if (fundId.includes("/") || fundId.includes(".")) {
    return rejectedPlan(
      descriptorId,
      "INVALID_FUND_ID",
      ruleIds,
      `Fund id "${fundId}" is not a lawful record id (no path separators).`
    );
  }
  const fPath = fundPath(cityId, fundId);
  if (snapshotDoc(ctx.snapshot, fPath)) {
    return rejectedPlan(
      descriptorId,
      "FUND_EXISTS",
      ruleIds,
      `A fund record already stands at ${fPath} — a fund's published terms are never silently rewritten; dissolve it and establish anew.`
    );
  }

  const purposeKind = typeof params.purposeKind === "string" ? params.purposeKind : "";
  const kindSpec = PENDING_KINDS[purposeKind];
  if (!kindSpec) {
    return rejectedPlan(
      descriptorId,
      "UNKNOWN_PURPOSE_KIND",
      ruleIds,
      `Purpose kind "${purposeKind || "(none)"}" is not on the published kind list (${fundPurposeKinds().join(", ")}). The list is the landed pending-kind registry: a fund may only promise a consequence the machinery knows how to ripen.`
    );
  }
  const mode = params.mode === "generative" ? "generative" : "determinate";
  if (!kindSpec.modes.includes(mode)) {
    return rejectedPlan(
      descriptorId,
      "MODE_NOT_AVAILABLE",
      ruleIds,
      `Kind ${purposeKind} ripens in ${kindSpec.modes.join("/")} mode only — "${mode}" is not available for it.`
    );
  }

  const amount = params.amountRubars;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
    return rejectedPlan(
      descriptorId,
      "INVALID_AMOUNT",
      ruleIds,
      "A fund is established with a positive whole-Rubar commitment (amountRubars) — the commitment is the fund's published size and feeds its delay derivation."
    );
  }
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  if (amount > treasury) {
    // Commitment class, refused in full (the finance taxonomy call,
    // recorded in the prep report): a fund commitment is not a
    // budget-class phase payment — part-funding it would silently
    // rewrite the published terms (size, derivation, bounds) the
    // ripening is later audited against.
    return rejectedPlan(
      descriptorId,
      "INSUFFICIENT_TREASURY",
      ruleIds,
      `${cityId}'s treasury holds ${treasury} R; the fund commitment is ${amount} R. A fund commitment is refused in full on shortfall — part-funding would rewrite the published terms the ripening is audited against.`
    );
  }

  // Mode-specific terms, validated before any draft is built.
  let disbursementRubars: number | null = null;
  let effectField: string | null = null;
  let effectDelta: number | null = null;
  let minRubars: number | null = null;
  let maxRubars: number | null = null;
  if (mode === "determinate") {
    const disbursement = params.disbursementRubars;
    disbursementRubars =
      typeof disbursement === "number" && Number.isInteger(disbursement) && disbursement > 0
        ? disbursement
        : amount;
    if (disbursementRubars > amount) {
      return rejectedPlan(
        descriptorId,
        "INVALID_DISBURSEMENT",
        ruleIds,
        `The ripening disbursement (${disbursementRubars} R) exceeds the committed fund (${amount} R) — a fund cannot promise out more than was committed into it.`
      );
    }
    effectField = typeof params.effectField === "string" ? params.effectField : null;
    effectDelta =
      typeof params.effectDelta === "number" && Number.isFinite(params.effectDelta)
        ? params.effectDelta
        : null;
    if (!effectField || effectDelta === null) {
      return rejectedPlan(
        descriptorId,
        "EFFECT_REQUIRED",
        ruleIds,
        "A determinate fund states its ripening effect at creation (effectField + effectDelta on the host city) — the consequence is fixed in the open at commitment, never improvised at ripening."
      );
    }
  } else {
    const min = params.minRubars;
    const max = params.maxRubars;
    minRubars = typeof min === "number" && Number.isInteger(min) && min >= 0 ? min : 1;
    maxRubars = typeof max === "number" && Number.isInteger(max) && max > 0 ? max : amount;
    if (minRubars > maxRubars) {
      return rejectedPlan(
        descriptorId,
        "INVALID_BOUNDS",
        ruleIds,
        `The published value band is empty (min ${minRubars} R > max ${maxRubars} R).`
      );
    }
  }

  const fundName =
    typeof params.fundName === "string" && params.fundName.length > 0
      ? params.fundName
      : fundId;
  const hostStructureId =
    typeof params.hostStructureId === "string" ? params.hostStructureId : null;
  const hostCorporationId =
    typeof params.hostCorporationId === "string" ? params.hostCorporationId : null;

  // The pending draft: built BEFORE the plan's entries so the
  // scheduling entry can disclose the derived delay verbatim.
  const requiresActionInCities: string[] = Array.isArray(params.requiresActionInCities)
    ? (params.requiresActionInCities as unknown[]).filter(
        (x): x is string => typeof x === "string"
      )
    : [cityId];

  const spec = buildFundPayloadSpec({
    fundPath: fPath,
    cityId,
    purposeKind,
    mode,
    disbursementRubars,
    effectField,
    effectDelta,
    minRubars,
    maxRubars,
    summaryOnRipen:
      mode === "determinate"
        ? `The ${fundName} pays out: ${disbursementRubars} R disbursed and its stated effect lands — a consequence of the fund's establishment, ripened by later play.`
        : null,
    requiresActionInCities,
  });

  const pendingId = `pend_${ctx.resolutionId}_01`;
  let built: ReturnType<typeof buildPendingDraft>;
  try {
    built = buildPendingDraft(ctx.snapshot, {
      pendingId,
      kind: purposeKind,
      originResolutionId: ctx.resolutionId,
      originActionId: ctx.action.actionId,
      originActor: ctx.action.actor,
      originCityId: cityId,
      originSummaryText: ctx.action.actionText ?? `Establish the ${fundName}`,
      targetCityId: cityId,
      sourceKind: "action",
      generation: 1,
      chainId: pendingId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      payloadSpec: spec,
      fundSize: amount,
    });
  } catch (err) {
    if (err instanceof PendingSpecError) {
      return rejectedPlan(
        descriptorId,
        "PENDING_SPEC_INVALID",
        ruleIds,
        `The fund's consequence spec is unlawful: ${err.message}`
      );
    }
    throw err;
  }
  const derivation = built.derivation;

  const plan = emptyPlan(descriptorId);
  plan.pendingCreates.push(built.draft);
  plan.readRefKeys.push(`pending:${pendingId}`);

  // Money + record: treasury pays the commitment in full; the fund
  // record is born with the landed machinery's bookkeeping fields
  // (initial/remaining/disbursed) the ripening path reads.
  const fundDoc: Record<string, unknown> = {
    schemaVersion: 2,
    kind: "fund",
    cityId,
    name: fundName,
    purposeKind,
    mode,
    committedRubars: amount,
    initialRubars: amount,
    remainingRubars: amount,
    disbursedRubars: 0,
    status: "active",
    terms: {
      disbursementRubars,
      effectField,
      effectDelta,
      minRubars,
      maxRubars,
      dissolutionReturn: FUND_DISSOLUTION_RETURN,
      trickleDown: true,
    },
    hostStructureId,
    hostCorporationId,
    createdByResolutionId: ctx.resolutionId,
    createdAt: null,
    stateVersion: 1,
    lastChangedSeq: null,
    lastResolutionId: null,
  };
  planWrite(plan, ctx.snapshot, fPath, fundDoc, "state", [
    "status",
    "committedRubars",
    "remainingRubars",
    "disbursedRubars",
  ]);
  const cityNow = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
  planWrite(
    plan,
    ctx.snapshot,
    cityPath,
    withDocField(cityNow, "stats.treasuryRubars", treasury - amount),
    "state",
    ["stats.treasuryRubars"]
  );

  const actor = ctx.action.actor;
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: [cityId],
      ruleIds,
      changes: [
        fieldChange(
          "stats.treasuryRubars",
          treasury,
          treasury - amount,
          `R-32: fund commitment — ${amount} R moves from ${cityId}'s treasury into the ${fundName} (one-way commitment; unspent Rubars return only on dissolution, per the fund's published terms)`
        ),
        fieldChange("funds/" + fundId + ".status", null, "active", "R-32: fund record created, terms published"),
        fieldChange("funds/" + fundId + ".committedRubars", null, amount, "R-32: committed size (feeds the delay derivation and the ripening bounds)"),
      ],
      recordsCreated: [fPath],
      recordsUpdated: [cityPath],
      summaryText:
        `R-32: the ${fundName} is established in ${cityId} — ${amount} R committed from the treasury. Published terms: purpose ${purposeKind} (${mode}); ` +
        (mode === "determinate"
          ? `at ripening it disburses ${disbursementRubars} R and applies ${effectField} ${effectDelta !== null && effectDelta >= 0 ? "+" : ""}${effectDelta} to ${cityId}. `
          : `at ripening it yields a prepared outcome valued within the published band ${minRubars}–${maxRubars} R. `) +
        `Dissolution returns unspent Rubars to the treasury. The fund stands at ${fPath}.`,
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: [cityId],
      ruleIds,
      changes: [
        fieldChange("status", null, "pending", "pending consequence committed to at fund establishment (R-32 → R-33 ripening)"),
      ],
      recordsCreated: [`sim_pending_consequences/${pendingId}`],
      pendingId,
      summaryText:
        `R-32 → R-33: one ${purposeKind} consequence is committed to (generation 1, chain ${pendingId}). Delay derivation, from the landed formula: base ${derivation.baseHours}h × fund scale ${derivation.fundScaleFactor} × infrastructure factor ${derivation.infraFactor} × connectivity factor ${derivation.connectivityFactor} = ${derivation.minWallElapsedHours}h minimum, and at least ${derivation.minSeqAdvance} further resolved events must land. It ripens only inside a later player-caused wake whose conditions hold (Action-Gated Ripening — no clock ripens it), and it voids if the fund no longer stands active with Rubars remaining. R-34 trickle-down findings ride the ripening (information-only in this phase).`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: "establish-fund",
        scope: "city",
        ruleIds,
        unruled: false,
      },
      cityId,
      cityIds: [cityId],
      ruleIds,
      pendingId,
      summaryText: `Established the ${fundName} in ${cityId}: ${amount} R committed, one ${purposeKind} consequence scheduled under Action-Gated Ripening.`,
      major: true,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// R-32 — dissolve a fund
// ---------------------------------------------------------------------------

function dissolveFundHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "R-32";
  const ruleIds = ["R-32"];
  const denied = requireFundAuthority(ctx, descriptorId);
  if (denied) return denied;

  const params = sa(ctx.action);
  const cityId = actionCityId(ctx.action);
  const cityPath = `sim_cities/${cityId}`;
  const city = snapshotDoc(ctx.snapshot, cityPath);
  if (!city) {
    return rejectedPlan(descriptorId, "NO_CITY", ruleIds, `City ${cityId} does not stand.`);
  }
  const fundId = typeof params.fundId === "string" ? params.fundId : "";
  if (!fundId) {
    return rejectedPlan(descriptorId, "NO_FUND", ruleIds, "The action names no fundId.");
  }
  const fPath = fundPath(cityId, fundId);
  const fund = snapshotDoc(ctx.snapshot, fPath);
  if (!fund) {
    return rejectedPlan(descriptorId, "NO_FUND", ruleIds, `No fund record stands at ${fPath}.`);
  }
  if (fund.status !== "active") {
    return rejectedPlan(
      descriptorId,
      "FUND_NOT_ACTIVE",
      ruleIds,
      `Fund ${fundId} in ${cityId} has status ${String(fund.status ?? "unset")} — only an active fund can be dissolved.`
    );
  }

  const remaining = num(fund, "remainingRubars") ?? 0;
  const treasury = num(city, "stats.treasuryRubars") ?? 0;
  const fundName = (fund.name as string | undefined) ?? fundId;

  const plan = emptyPlan(descriptorId);
  const changes: LogEntryDraft["changes"] = [];
  if (remaining > 0) {
    const cityNow = plannedDoc(plan, ctx.snapshot, cityPath) ?? city;
    planWrite(
      plan,
      ctx.snapshot,
      cityPath,
      withDocField(cityNow, "stats.treasuryRubars", treasury + remaining),
      "state",
      ["stats.treasuryRubars"]
    );
    changes.push(
      fieldChange(
        "stats.treasuryRubars",
        treasury,
        treasury + remaining,
        `R-32 dissolution: the ${fundName}'s unspent ${remaining} R return to ${cityId}'s treasury, per the fund's published terms`
      )
    );
  }
  const fundNow = plannedDoc(plan, ctx.snapshot, fPath) ?? fund;
  planWrite(
    plan,
    ctx.snapshot,
    fPath,
    {
      ...withDocField(fundNow, "status", "dissolved"),
      remainingRubars: 0,
      dissolvedInResolutionId: ctx.resolutionId,
    },
    "state",
    ["status", "remainingRubars"]
  );
  changes.push(
    fieldChange("funds/" + fundId + ".status", "active", "dissolved", "R-32: the owner dissolves the fund — a deliberate act, never neglect"),
    fieldChange("funds/" + fundId + ".remainingRubars", remaining, 0, "R-32: unspent commitment leaves the fund (returned above)")
  );

  const actor = ctx.action.actor;
  plan.entries.push(
    ruleEffectDraft({
      actor,
      cityId,
      cityIds: [cityId],
      ruleIds,
      changes,
      recordsUpdated: [fPath, cityPath],
      summaryText:
        `R-32: the ${fundName} in ${cityId} is dissolved by its owner. ${remaining > 0 ? `Unspent ${remaining} R return to the treasury. ` : "No unspent Rubars remained. "}` +
        `The fund's still-pending consequences are not erased by this act: each carries a fund-status precondition recorded at its creation, so each ends as a logged voiding at its next ripeness evaluation — a dissolved fund's consequences never ripen (P4-K20 posture).`,
    })
  );
  plan.entries.push(
    summaryDraft({
      actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: "dissolve-fund",
        scope: "city",
        ruleIds,
        unruled: false,
      },
      cityId,
      cityIds: [cityId],
      ruleIds,
      summaryText: `Dissolved the ${fundName} in ${cityId}${remaining > 0 ? `; ${remaining} unspent R returned to the treasury` : ""}.`,
    })
  );
  pruneRecordClaims(plan);
  actorCitations(plan, ctx, ctx.resolutionId);
  return plan;
}

// ---------------------------------------------------------------------------
// Descriptors (Lead assembly merges R-32 into the registry — see header)
// ---------------------------------------------------------------------------

export const R32_PRODUCT_ACTION_KINDS = ["establish_fund", "dissolve_fund"] as const;

export const R32_PRODUCT_HANDLERS: Record<string, HandlerFn> = {
  establish_fund: establishFundHandler,
  dissolve_fund: dissolveFundHandler,
};

export const CHAINS_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "R-32": {
    id: "R-32",
    actionKinds: [...R32_PRODUCT_ACTION_KINDS],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: true,
    handlers: { ...R32_PRODUCT_HANDLERS },
    readPlan: fundReadPlan,
    summary:
      "Product fund verbs: establish_fund commits treasury Rubars into a named fund with published terms and schedules exactly one generation-1 pending under Action-Gated Ripening (delay derived from the landed formula and disclosed in the Log); dissolve_fund returns unspent Rubars and ends the fund, its live pendings voiding at their next ripeness evaluation. ASSEMBLY: merge actionKinds/handlers into the registry's inline R-32 (the Phase 2 fixture kinds stay).",
  },
};
