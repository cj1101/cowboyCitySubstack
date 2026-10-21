/**
 * Finance + banking rule handlers (Phase 4 step 4 / module c):
 * F-01, F-02, F-03, F-05, F-12 and the banking slice B-01–B-04
 * (cash-paid interest only), per finance-system-design.md, the
 * conformed banking-amendment-design.md, and brief §6.2/§7.2.
 *
 * Phase 5 (PR-6, Felix): the banking family completes here —
 * B-04's credited branch, the REC-6 balance-sheet derivation
 * replacing the slice-form health reading, loan-record activation
 * (B-05/B-06/B-07/B-08/B-11), recapitalization (B-09), liquidation
 * with the waterfall, setoff, assignment and the B-13 insurance
 * payout step (B-10), the deposit-insurance fund (founding
 * composition, B-12 premiums + ladder + suspension, B-14
 * assessments), the B-01 controller bar, and the banking schedule
 * ripening composition (buildScheduleRipeningPlan) the Lead's
 * resolver wiring dispatches on effectPath "schedule". Built, not
 * live: the P2-K15 production chain is unexecuted (PR body).
 *
 * The Build Lead registers FINANCE_DESCRIPTORS into RULE_DESCRIPTORS
 * (registry.ts is Lead assembly); until then these descriptors are
 * inert data. FINANCE_DESCRIPTOR_META carries finance §2.4's
 * descriptor additions (shortfallClass / ledgersTouched /
 * invokesRules) in parallel, because the registry's RuleDescriptor
 * type is the Lead's to extend.
 *
 * Handler discipline (Step 0 contracts, binding):
 *  - read plans are declared per descriptor and derive ONLY from the
 *    action's own seeds (actor + structuredAction fields) — citations
 *    are never the sole source of a money or authority read;
 *  - step 0 of every money-touching handler is F-01 lazy-open for the
 *    payer AND the payee (accounts.ts composeLazyOpen), composed
 *    before the action's own lines so the genesis grant orders first;
 *  - all balance writes fold through the transfer primitive
 *    (lib/finance/transfer.ts) and planMutate/plannedDoc — no handler
 *    computes an after-state from the raw snapshot for a doc it writes;
 *  - no judgment is ever read from `structuredAction` — amounts, ids
 *    and terms are the member's stated act, validated against stored
 *    records; authority reads stored records (ownerMemberId,
 *    factions ownerUids via checkCityAuthority), never inferences.
 *
 * Rejection codes follow the designs' spellings (finance §2.3 /
 * banking Appendix B: kebab-case), not the Phase 2 fixtures' SNAKE
 * case — flagged for the Lead's registry pass.
 */

import {
  docField,
  emptyPlan,
  snapshotDoc,
  type ResolutionPlan,
  type SimAction,
  type SimChange,
  type SimSnapshot,
} from "../state";
import {
  fieldChange,
  planMutate,
  planWrite,
  plannedDoc,
  rejectedPlan,
  ruleEffectDraft,
  summaryDraft,
} from "./planHelpers";
import { checkCityAuthority, type DescriptorReadPlan, type HandlerContext, type ReadPlanSeeds, type RuleDescriptor } from "./registry";
import {
  actorMemberId,
  cityPath,
  composeLazyOpen,
  isExteriorScope,
  ledgerLabel,
  logEntryPath,
  memberAccountOf,
  memberAccountPath,
  bankDepositPath,
  bankLoanPath,
  difRef,
  INSURANCE_FUND_PATH,
  type LedgerRef,
} from "../../finance/accounts";
import {
  applyTransferLines,
  groupChangesByEntryCity,
  type FinanceDescriptorMeta,
  type TaggedChange,
  type TransferLine,
} from "../../finance/transfer";
import {
  accruedUnsettledRubars,
  bankBlockOf,
  bankCashRubars,
  buildBankCharterBlock,
  buildBankDepositDoc,
  buildSchedulePendingDraft,
  CHARTER_MIN_CAPITAL_RUBARS,
  deriveBankHealth,
  EQUITY_FLOOR_BPS,
  INSIDER_CAP_BPS,
  liquidReserveRubars,
  PREMIUM_PERIOD_SEQS,
  RATE_CAP_BPS_PER_KSEQ,
  RECHARTER_BAR_SEQS,
  RESERVE_FLOOR_BPS,
  seizedAssetsOf,
  unencumberedCash,
  type BankDepositRecord,
} from "../../finance/banking";
import {
  allocateRepayment,
  buildLoanOfferDoc,
  createdSupplyOf,
  deriveLoanStanding,
  distributeProRata,
  fundingSourceOf,
  installmentPrincipalOf,
  isInsiderBorrower,
  loanRecordOf,
  nextDueSeqFor,
  poolUnpaidRubars,
  setoffFor,
  type BankLoanRecord,
  type LoanCollateral,
} from "../../finance/loans";
import {
  buildDifFundDoc,
  claimBasisRubars,
  coveredSplitForDepositor,
  depositCoveredClass,
  derivePremiumLadder,
  fundDeficient,
  fundRecordOf,
  insuredLiabilitiesForBank,
  premiumDueRubars,
  premiumRiskMultiplier,
  bankRiskGradeOf,
  queuedShortfallsOf,
  supplementalAssessments,
  totalInsuredLiabilities,
  type PremiumMarkerView,
  type PremiumSettlementView,
} from "../../finance/insurance";
import {
  applySituationUpsert,
  buildIncidentSituation,
  buildProposalSituation,
  buildRipeningOccasionSituation,
  dedupeKeyFor,
  episodeSourceId,
  markSituationHandled,
  occasionSpecFromPending,
  planSituationUpsert,
  situationPath,
  type RipeningOccasionSpec,
  type SimSituation,
} from "../situations";
import { corporationPath } from "../corporations";

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

const sa = (action: SimAction): Record<string, unknown> =>
  (action.structuredAction ?? {}) as Record<string, unknown>;

function stringField(action: SimAction, field: string): string | null {
  const value = sa(action)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveAmount(action: SimAction, field = "amountRubars"): number | null {
  const value = sa(action)[field];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** The seq the plan's NEXT entry will receive at commit (entries
 * allocate in plan order from counterHead.lastSeq + 1). */
function nextEntrySeq(snapshot: SimSnapshot, plan: ResolutionPlan): number {
  return snapshot.counterHead.lastSeq + 1 + plan.entries.length;
}

function actorCitations(plan: ResolutionPlan, ctx: HandlerContext): void {
  for (const id of ctx.citations.resolutionIds ?? []) plan.readRefKeys.push(`resolution:${id}`);
  for (const id of ctx.citations.pendingIds ?? []) plan.readRefKeys.push(`pending:${id}`);
  for (const path of ctx.citations.recordPaths ?? []) plan.readRefKeys.push(`record:${path}`);
  for (const seq of ctx.citations.seqs ?? []) plan.readRefKeys.push(`seq:${seq}`);
  plan.readRefKeys.push(`resolution:${ctx.resolutionId}`);
}

const NPC_DEFERRED =
  "NPC actors act under mandate fields that name the act, its payee class, and its caps (systems-spec §8) — those fields are Phase 5 machinery, so in the Phase 4 slice this act must be the principal's own.";

function rejectNpc(ctx: HandlerContext, descriptorId: string): ResolutionPlan | null {
  if (ctx.action.actor.type !== "npc") return null;
  return rejectedPlan(descriptorId, "npc-mandate-unavailable", [descriptorId], `${descriptorId}: ${NPC_DEFERRED}`);
}

/** Push one rule-effect entry per entry-city group of movement
 * changes, in first-seen group order. Returns the seq of the first
 * entry pushed (or -1 when there were no changes). */
function pushMovementEntries(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  ruleId: string,
  tagged: TaggedChange[],
  summaryFor: (entryCityId: string | null) => string,
  records?: { created?: string[]; updated?: string[] }
): number {
  const grouped = groupChangesByEntryCity(tagged);
  let firstSeq = -1;
  let first = true;
  for (const [entryCityId, changes] of grouped) {
    if (firstSeq < 0) firstSeq = nextEntrySeq(ctx.snapshot, plan);
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: entryCityId,
        cityIds: entryCityId ? [entryCityId] : [],
        ruleIds: [ruleId],
        changes,
        recordsCreated: first ? (records?.created ?? []) : [],
        recordsUpdated: first ? (records?.updated ?? []) : [],
        summaryText: summaryFor(entryCityId),
      })
    );
    first = false;
  }
  return firstSeq;
}

function finishPlan(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    ruleId: string;
    verb: string;
    scope: string;
    cityId: string | null;
    summaryText: string;
    major?: boolean;
    /** Phase 5: additive machine-readable extras merged into the
     * summary entry's classification (premium settlements, banking
     * liquidations, controller-bar facts). Resolved entries'
     * classifications are handler-controlled (the resolver replaces
     * them only for rejections), and the standing verifier projects
     * its premium/failed-payment inputs from these stamps. */
    classificationExtra?: Record<string, unknown>;
  }
): ResolutionPlan {
  plan.entries.push(
    summaryDraft({
      actor: ctx.action.actor,
      actionId: ctx.action.actionId,
      actionText: ctx.action.actionText,
      classification: {
        verb: args.verb,
        scope: args.scope,
        ruleIds: [args.ruleId],
        unruled: false,
        ...(args.classificationExtra ?? {}),
      },
      cityId: args.cityId,
      cityIds: args.cityId ? [args.cityId] : [],
      ruleIds: [args.ruleId],
      summaryText: args.summaryText,
      major: args.major ?? false,
    })
  );
  actorCitations(plan, ctx);
  return plan;
}

/** Defense-in-depth NPC refusal for Tier B verbs (addendum §2):
 * the authority stage refuses an NPC attempting a Tier B act
 * before dispatch; if a plan nevertheless reaches a Tier B handler
 * with an NPC actor (a stage bypass, a stale mandate), the handler
 * refuses on its own — zero banking writes either way. */
function rejectTierBNpc(ctx: HandlerContext, descriptorId: string): ResolutionPlan | null {
  if (ctx.action.actor.type !== "npc") return null;
  return rejectedPlan(
    descriptorId,
    "npc-tier-b-refused",
    [descriptorId],
    `${descriptorId}: this act is Tier B (binding-by-nature) — no mandate wording demotes it and no cap enlarges an NPC into it (addendum §2). It is the principal's own act or it does not happen.`
  );
}

/** Rows of a declared collection query (the market family's
 * pattern): snapshot.queries records keyed by query id, each row
 * carrying its materialized path. */
function queryDocs(
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): { path: string; doc: Record<string, unknown> }[] {
  const records = snapshot.queries?.[queryId] ?? [];
  return records
    .filter((record) => record.path.startsWith(`${collectionPath}/`))
    .map((record) => ({ path: record.path, doc: record.data }));
}

/** Project the premium marker/settlement views for one bank from
 * the Log-entry query rows (the derivation inputs of
 * derivePremiumLadder — every premium figure in this family
 * recomputes from the standing Log alone, §7.7's bar extended). */
function premiumLogViews(
  snapshot: SimSnapshot,
  bankCorporationId: string
): { markers: PremiumMarkerView[]; settlements: PremiumSettlementView[] } {
  const markers: PremiumMarkerView[] = [];
  const settlements: PremiumSettlementView[] = [];
  for (const queryId of ["premiumMarkers", "premiumSettlements"]) {
    for (const { doc } of queryDocs(snapshot, queryId, "sim_log_entries")) {
      const classification = doc.classification as
        | {
            premiumDue?: { pendingId?: unknown; dueRubars?: unknown; periodIndex?: unknown };
            premiumSettlement?: { settledPendingIds?: unknown };
          }
        | undefined;
      const seq = typeof doc.seq === "number" ? doc.seq : 0;
      if (queryId === "premiumMarkers" && classification?.premiumDue) {
        markers.push({
          pendingId: String(classification.premiumDue.pendingId ?? ""),
          seq,
          dueRubars:
            typeof classification.premiumDue.dueRubars === "number"
              ? classification.premiumDue.dueRubars
              : 0,
          periodIndex:
            typeof classification.premiumDue.periodIndex === "number"
              ? classification.premiumDue.periodIndex
              : 0,
        });
      }
      if (queryId === "premiumSettlements" && classification?.premiumSettlement) {
        settlements.push({
          seq,
          settledPendingIds: Array.isArray(classification.premiumSettlement.settledPendingIds)
            ? classification.premiumSettlement.settledPendingIds.filter(
                (id): id is string => typeof id === "string"
              )
            : [],
        });
      }
    }
  }
  return { markers, settlements };
}

/** The premium Log queries every banking read plan that derives
 * ladder/coverage state declares (filters on the classification
 * stamps' dotted paths — the F-01 query machinery walks them). */
function premiumQueries(bankCorporationId: string): DescriptorReadPlan["queries"] {
  return [
    {
      id: "premiumMarkers",
      collectionPath: "sim_log_entries",
      filters: [
        { field: "classification.premiumDue.bankCorporationId", op: "==", value: bankCorporationId },
      ],
    },
    {
      id: "premiumSettlements",
      collectionPath: "sim_log_entries",
      filters: [
        {
          field: "classification.premiumSettlement.bankCorporationId",
          op: "==",
          value: bankCorporationId,
        },
      ],
    },
  ];
}

/** Read a bank's standing premium ladder from the snapshot's Log
 * queries (markers + settlements declared by the caller's plan). */
function bankPremiumLadder(snapshot: SimSnapshot, bankCorporationId: string) {
  const views = premiumLogViews(snapshot, bankCorporationId);
  return derivePremiumLadder(views);
}

/** Maintain the fund's insured-liabilities aggregate (A-B6's pair)
 * for a claim change at a bank, folding the delta into the plan
 * when the deposit is covered-class AT ITS OPEN (top-ups inherit
 * the record's own eligibility, V2-§1.4). No fund → no-op: coverage
 * machinery is inert before founding, and pre-founding deposits
 * derive uninsured for their whole lives (grandfathering: none). */
function applyInsuredLiabilityDelta(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    deposit: BankDepositRecord;
    deltaRubars: number;
    bank: BankTarget;
    ruleId: string;
  }
): TaggedChange | null {
  if (args.deltaRubars === 0) return null;
  const fundDoc = snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH);
  const fund = fundRecordOf(fundDoc);
  if (!fund) return null;
  const covered = depositCoveredClass(args.deposit, {
    fund,
    suspensionIntervals: bankPremiumLadder(ctx.snapshot, args.deposit.bankCorporationId)
      .suspensionIntervals,
    bankOwnerMemberId:
      typeof args.bank.corp.ownerMemberId === "string" ? args.bank.corp.ownerMemberId : "",
  });
  if (!covered) return null;
  const planned = plannedDoc(plan, ctx.snapshot, INSURANCE_FUND_PATH);
  const before = typeof planned?.totalInsuredLiabilitiesRubars === "number" ? planned.totalInsuredLiabilitiesRubars : 0;
  planMutate(plan, ctx.snapshot, INSURANCE_FUND_PATH, "state", ["totalInsuredLiabilitiesRubars"], (current) =>
    current
      ? {
          ...current,
          totalInsuredLiabilitiesRubars:
            (typeof current.totalInsuredLiabilitiesRubars === "number" ? current.totalInsuredLiabilitiesRubars : 0) +
            args.deltaRubars,
        }
      : current
  );
  return {
    entryCityId: null,
    change: fieldChange(
      "institutionAccount.totalInsuredLiabilitiesRubars",
      before,
      before + args.deltaRubars,
      `${args.ruleId} insured-liabilities aggregate (A-B6 pair of the covered claim change at ${args.deposit.bankCorporationId})`
    ),
  };
}

function corporationRef(cityId: string, corporationId: string): LedgerRef {
  return { kind: "company", corporationId, cityId };
}

// ---------------------------------------------------------------------------
// Banking Situations (addendum §1) — producer occasions ride Vera's
// landed module. Addressing (§1.0): a personal ref addresses its
// member; a company ref addresses its owner with the facet city the
// company's home city; a treasury ref addresses the city (recipient
// unset; the governor audience is the faction owners snapshot).
// Banking cards file under the bank's city facet. Every mint goes
// through planSituationUpsert against the card the caller's read
// plan materialized by dedupe key (query id "situationsByKey") —
// dedupe patterns E/P/X live in the inputs the producers build.
// ---------------------------------------------------------------------------

export interface SituationAddressing {
  recipientUid?: string;
  audienceCityId: string;
  audienceOwnerUidsSnapshot: string[];
}

export function situationAddressingFor(
  snapshot: SimSnapshot,
  ref: LedgerRef,
  facetCityId: string
): SituationAddressing {
  const ownersOf = (cityId: string): string[] => {
    const faction = snapshotDoc(snapshot, `factions/${cityId}`);
    const owners = faction?.ownerUids;
    return Array.isArray(owners) ? owners.filter((u): u is string => typeof u === "string") : [];
  };
  switch (ref.kind) {
    case "personal":
      return {
        recipientUid: ref.memberId,
        audienceCityId: facetCityId,
        audienceOwnerUidsSnapshot: ownersOf(facetCityId),
      };
    case "company": {
      const corp = snapshotDoc(snapshot, corporationPath(ref.cityId, ref.corporationId));
      return {
        recipientUid: typeof corp?.ownerMemberId === "string" ? corp.ownerMemberId : undefined,
        // Banking cards file under the BANK's city facet uniformly
        // (the dedupe audience key must be computable by every
        // later verb in the relationship); the governing audience
        // snapshot is the company's own city's owners.
        audienceCityId: facetCityId,
        audienceOwnerUidsSnapshot: ownersOf(ref.cityId),
      };
    }
    case "treasury":
      return {
        audienceCityId: ref.cityId,
        audienceOwnerUidsSnapshot: ownersOf(ref.cityId),
      };
    default:
      return { audienceCityId: facetCityId, audienceOwnerUidsSnapshot: ownersOf(facetCityId) };
  }
}

/** Banking occasion cards are fetched by a city-scoped query
 * (every banking card's cityId is its bank's city — the producer
 * discipline in this family) and matched in memory by dedupe key
 * or producer-stamped fields: several keys (an offer card's
 * resolution id, a liquidation's) are knowable only from records
 * the handler reads, never from the action alone, so read plans
 * fetch the city's cards and handlers match exactly. */
export function findSituation(
  ctx: HandlerContext,
  predicate: (doc: SimSituation) => boolean
): SimSituation | null {
  for (const [queryId, records] of Object.entries(ctx.snapshot.queries ?? {})) {
    if (!queryId.startsWith("situationsByKey")) continue;
    for (const record of records) {
      const doc = record.data as unknown as SimSituation;
      if (predicate(doc)) return doc;
    }
  }
  return null;
}

/** Mint or upsert one banking Situation inside the caller's plan.
 * Returns the record ids the caller's entry claims
 * (recordsCreated/recordsUpdated). */
export function mintSituation(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  input: Parameters<typeof buildProposalSituation>[0] | Parameters<typeof buildIncidentSituation>[0]
): { created: string[]; updated: string[] } {
  const key = dedupeKeyFor(input);
  const existing = findSituation(ctx, (doc) => doc.dedupeKey === key);
  const decision = planSituationUpsert(existing, input);
  const applied = applySituationUpsert(plan, ctx.snapshot, decision);
  return {
    created: applied.created.map((id) => situationPath(id)),
    updated: [...applied.updated, ...applied.superseded].map((id) => situationPath(id)),
  };
}

/** Mark a standing card handled inside the caller's transaction
 * (the §6.3 discipline: the authoritative act's own event closes
 * its card — B-06 funding closes B1; a curing B-09 closes K2).
 * Returns the situation path to claim as updated, or null when no
 * open card matches. */
export function closeSituationWhere(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  predicate: (doc: SimSituation) => boolean,
  args: { resolvedSeq: number; resolutionId: string }
): string | null {
  const doc = findSituation(ctx, (d) => d.status === "open" && predicate(d));
  if (!doc) return null;
  const transition = markSituationHandled(doc, {
    resolvedSeq: args.resolvedSeq,
    resolvedByResolutionId: args.resolutionId,
    decidedAt: ctx.snapshot.now,
  });
  planWrite(plan, ctx.snapshot, situationPath(doc.situationId), transition.doc as unknown as Record<string, unknown>, "state", transition.changedFields);
  return situationPath(doc.situationId);
}

/** The read-plan query that materializes a bank city's situation
 * cards for in-memory matching (see findSituation). */
export function situationKeyQueries(cityId: string): NonNullable<DescriptorReadPlan["queries"]> {
  return [
    {
      id: "situationsByKey0",
      collectionPath: "sim_situations",
      filters: [{ field: "cityId", op: "==" as const, value: cityId }],
    },
  ];
}

// ---------------------------------------------------------------------------
// F-01 — open_member_account (genesis grant; finance §1.2/§1.4, §3.3).
// ---------------------------------------------------------------------------

function openAccountHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-01";
  const memberId = actorMemberId(ctx.action.actor);
  if (!memberId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "F-01: the actor carries no member identity — guests hold no accounts (finance §1.1).");
  }
  const named = stringField(ctx.action, "memberId");
  if (named && named !== memberId) {
    return rejectedPlan(descriptorId, "account-not-actors", [descriptorId], `F-01: an account opens only for the acting member (${memberId}); the action names ${named}.`);
  }
  const accountPath = memberAccountPath(memberId);
  const existing = snapshotDoc(ctx.snapshot, accountPath);
  if (existing) {
    const account = memberAccountOf(existing);
    if (!account) {
      return rejectedPlan(descriptorId, "account-record-malformed", [descriptorId], `F-01: the account record at ${accountPath} does not carry the §1.2 shape.`);
    }
    if (account.status === "open") {
      return rejectedPlan(descriptorId, "account-exists", [descriptorId], `F-01: ${memberId} already holds an open account — a second opening is never a second grant (§1.4).`);
    }
  }
  const plan = emptyPlan(descriptorId);
  const outcome = composeLazyOpen({
    plan,
    snapshot: ctx.snapshot,
    actor: ctx.action.actor,
    memberId,
    viaActionKind: "explicit",
  });
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "open-account",
    scope: "personal",
    cityId: null,
    summaryText: outcome.granted
      ? `Opened a personal account for ${memberId} with the genesis grant of 250000 R (mint, finance §3.3).`
      : `Reopened the personal account of ${memberId}; the original genesis grant stands — no second grant (§1.4).`,
    major: true,
  });
}

function openAccountReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const memberId = actorMemberId(seeds.action.actor);
  return { paths: memberId ? [memberAccountPath(memberId)] : [] };
}

// ---------------------------------------------------------------------------
// F-02 — transfer_rubars (transfer class, public; finance §2.3).
// One line personal -> personal. There is NO covert member transfer in
// v1: this descriptor is public and no flag on the action can change
// that (market §5.2 carried as a hard property).
// ---------------------------------------------------------------------------

function transferHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-02";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const payerId = actorMemberId(ctx.action.actor);
  if (!payerId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "F-02: the actor carries no member identity.");
  }
  const payeeId = stringField(ctx.action, "toMemberId");
  if (!payeeId) {
    return rejectedPlan(descriptorId, "malformed-transfer", [descriptorId], "F-02: transfer_rubars requires toMemberId.");
  }
  if (payeeId === payerId) {
    return rejectedPlan(descriptorId, "self-transfer", [descriptorId], "F-02: payer and payee are the same member — a self-line is a plan defect (§2.1.3).");
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-transfer", [descriptorId], "F-02: amountRubars must be a positive integer.");
  }
  if (sa(ctx.action).requiresAcceptance === true) {
    // The two-sided form (design [Proposal], §2.3 F-02) parks the
    // offer as a pending of kind "transfer-offer" — a kind the
    // pending registry (pendingRules.ts, not this module) does not
    // yet carry. Until the Lead registers the kind and its wake
    // application, the honest resolution is a named rejection, never
    // a silent downgrade to a one-sided transfer the payer did not
    // confirm.
    return rejectedPlan(descriptorId, "transfer-acceptance-deferred", [descriptorId], "F-02: requiresAcceptance transfers park as transfer-offer pendings; that pending kind is not yet registered (Lead assembly), so the two-sided form cannot resolve in this slice. The one-sided form (no flag) is unaffected.");
  }
  const memo = stringField(ctx.action, "memo") ?? "member transfer";

  const plan = emptyPlan(descriptorId);
  // Step 0 (§1.4): payer AND payee lazy-open, grants ordered before
  // the transfer line. Funds validate against the PLANNED docs, so a
  // first-time payer spends from their just-granted balance.
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: payerId, viaActionKind: "transfer_rubars" });
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: payeeId, viaActionKind: "transfer_rubars" });

  const line: TransferLine = {
    from: { kind: "personal", memberId: payerId },
    to: { kind: "personal", memberId: payeeId },
    amountRubars: amount,
    ruleId: descriptorId,
    memo,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId],
      `F-02: transfer of ${amount} R from ${payerId} to ${payeeId} refused in full (transfer class): ${applied.message}`
    );
  }
  pushMovementEntries(plan, ctx, descriptorId, applied.changes, () =>
    `F-02: ${payerId} transferred ${amount} R to ${payeeId} — "${memo}".`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "transfer",
    scope: "personal",
    cityId: null,
    summaryText: `Transferred ${amount} R from ${payerId} to ${payeeId} — "${memo}". Public, per market §5.2: money between members moves in the open or not at all.`,
  });
}

function transferReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const payerId = actorMemberId(seeds.action.actor);
  if (payerId) paths.push(memberAccountPath(payerId));
  const payeeId = seeds.action.structuredAction?.toMemberId;
  if (typeof payeeId === "string" && payeeId) paths.push(memberAccountPath(payeeId));
  return { paths };
}

// ---------------------------------------------------------------------------
// F-03 — fund_company (transfer class; finance §2.3). Personal-only
// source (OPEN-5(ii)); actor is the corporation's ownerMemberId — the
// one ownership fact (A-7), never an inference from founderFigureId.
// Listed-company M-01/M-02/M-06 consequences are the Market module's
// seam: this handler moves the money and says so; it does not price.
// ---------------------------------------------------------------------------

function fundCompanyHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-03";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const ownerId = actorMemberId(ctx.action.actor);
  if (!ownerId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "F-03: the actor carries no member identity.");
  }
  const cityId = stringField(ctx.action, "cityId");
  const corporationId = stringField(ctx.action, "corporationId");
  if (!cityId || !corporationId) {
    return rejectedPlan(descriptorId, "malformed-funding", [descriptorId], "F-03: fund_company requires cityId and corporationId.");
  }
  const source = stringField(ctx.action, "source");
  if (source !== null && source !== "personal") {
    return rejectedPlan(descriptorId, "source-not-personal", [descriptorId], `F-03: source "${source}" is barred — funding is personal-only in v1 (OPEN-5(ii)); treasury-sourced capital and company-to-company funding are not in v1 (FIN-C5).`);
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-funding", [descriptorId], "F-03: amountRubars must be a positive integer.");
  }
  const corpPath = corporationPath(cityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `F-03: no corporation record at ${corpPath}.`);
  }
  if (corp.ownerMemberId !== ownerId) {
    return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `F-03: ${ownerId} is not the ownerMemberId of ${corporationId} — funding is the owner's act.`);
  }
  if (corp.status === "dissolved") {
    return rejectedPlan(descriptorId, "company-dissolved", [descriptorId], `F-03: ${corporationId} is dissolved; capital cannot be funded into a dissolved company.`);
  }

  const plan = emptyPlan(descriptorId);
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: ownerId, viaActionKind: "fund_company" });
  const line: TransferLine = {
    from: { kind: "personal", memberId: ownerId },
    to: corporationRef(cityId, corporationId),
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `paid-in capital for ${corporationId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId],
      `F-03: funding of ${amount} R into ${corporationId} refused in full (transfer class): ${applied.message}`
    );
  }
  pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
    entryCityId === null
      ? `F-03: ${ownerId}'s personal account funded ${corporationId} with ${amount} R of paid-in capital.`
      : `F-03: ${corporationId} received ${amount} R of paid-in capital from its owner.`
  );
  const listed = corp.listed === true;
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "fund-company",
    scope: "company",
    cityId,
    summaryText: listed
      ? `Funded ${corporationId} with ${amount} R from ${ownerId}'s personal account. The company is listed: M-01/M-02/M-06 market consequences are the Market module's seam and ride its own rules — F-03 moved the money only.`
      : `Funded ${corporationId} with ${amount} R from ${ownerId}'s personal account (paid-in capital).`,
  });
}

function fundCompanyReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const ownerId = actorMemberId(seeds.action.actor);
  if (ownerId) paths.push(memberAccountPath(ownerId));
  const cityId = seeds.action.structuredAction?.cityId;
  const corporationId = seeds.action.structuredAction?.corporationId;
  if (typeof cityId === "string" && typeof corporationId === "string") {
    paths.push(corporationPath(cityId, corporationId));
  }
  return { paths };
}

// ---------------------------------------------------------------------------
// F-05 — treasury_spend (budget class; finance §2.3/§2.2). Partial
// funding is lawful here because the governor's confirmed instruction
// was "spend up to this amount on this purpose" — the preview states
// the balance and the shortfall range, and the entry states the
// shortfall that actually occurred. Company payees are NOT F-05: a
// payment to a company for a service is F-10's shape and this handler
// rejects with the citation. Loans between cities are not created by
// this rule — an inter-city movement here is a grant, and the Log
// says grant.
// ---------------------------------------------------------------------------

function treasurySpendHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-05";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const cityId = stringField(ctx.action, "cityId");
  if (!cityId) {
    return rejectedPlan(descriptorId, "malformed-spend", [descriptorId], "F-05: treasury_spend requires cityId.");
  }
  const authority = checkCityAuthority(ctx.snapshot, cityId, ctx.action.actor);
  if (!authority.ok) {
    return rejectedPlan(descriptorId, "not-city-governor", [descriptorId], `F-05: the actor does not govern ${cityId}: ${authority.reason}. (For the shared city, the sitting-mayor narrowing rides the same helper via Phase 7's office machinery.)`);
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-spend", [descriptorId], "F-05: amountRubars must be a positive integer.");
  }
  const category = stringField(ctx.action, "category") ?? "uncategorized";
  const cityDocPath = cityPath(cityId);
  const city = snapshotDoc(ctx.snapshot, cityDocPath);
  if (!city) {
    return rejectedPlan(descriptorId, "city-not-found", [descriptorId], `F-05: no city record for ${cityId}.`);
  }
  const treasury = docField(city, "stats.treasuryRubars");
  if (typeof treasury !== "number") {
    return rejectedPlan(descriptorId, "no-treasury-figure", [descriptorId], `F-05: ${cityId} carries no treasury figure.`);
  }

  const payeeKind = stringField(ctx.action, "payeeKind");
  let to: LedgerRef;
  let payeeLabel: string;
  if (payeeKind === "exterior") {
    const scope = stringField(ctx.action, "payeeScope");
    if (!scope || !isExteriorScope(scope)) {
      return rejectedPlan(descriptorId, "malformed-spend", [descriptorId], "F-05: an Exterior payee requires a named scope (households:<cityId> | realm-public | outside-realm).");
    }
    to = { kind: "exterior", scope };
    payeeLabel = `the Exterior (${scope})`;
  } else if (payeeKind === "treasury") {
    const payeeCityId = stringField(ctx.action, "payeeCityId");
    if (!payeeCityId) {
      return rejectedPlan(descriptorId, "malformed-spend", [descriptorId], "F-05: a treasury payee requires payeeCityId.");
    }
    if (payeeCityId === cityId) {
      return rejectedPlan(descriptorId, "self-transfer", [descriptorId], "F-05: a treasury cannot grant to itself — a self-line is a plan defect (§2.1.3).");
    }
    to = { kind: "treasury", cityId: payeeCityId };
    payeeLabel = `the treasury of ${payeeCityId}`;
  } else if (payeeKind === "company") {
    return rejectedPlan(descriptorId, "company-payee-is-f-10", [descriptorId, "F-10"], "F-05: a company payee is a service-contract payment and resolves under F-10, which carries the contract fields — F-05 does not move money to companies.");
  } else {
    return rejectedPlan(descriptorId, "malformed-spend", [descriptorId], "F-05: payeeKind must be exterior | treasury | company.");
  }

  // Authorization citation (§4.2): spending under an authorization
  // cites it; spending without one is lawful for a governor and the
  // entry states `authorization: none`. A NAMED authorization must
  // stand — citing a record that does not exist would falsify the Log.
  const authorizationId = stringField(ctx.action, "authorizationId");
  if (authorizationId) {
    const budgetPath = `${cityDocPath}/budgets/${authorizationId}`;
    if (!snapshotDoc(ctx.snapshot, budgetPath)) {
      return rejectedPlan(descriptorId, "authorization-not-found", [descriptorId], `F-05: authorization ${authorizationId} does not stand at ${budgetPath}; a citation must name a real record.`);
    }
  }

  // Budget class (§2.2): execute up to the available balance; the
  // unfunded remainder is logged as shortfallRubars with the rule
  // cited. A fully unfunded spend still resolves — the shortfall IS
  // the world fact (Vera §2.4).
  const paid = Math.min(amount, treasury);
  const shortfall = amount - paid;
  const plan = emptyPlan(descriptorId);
  const memo = stringField(ctx.action, "memo") ?? `treasury spend (${category})`;
  if (paid > 0) {
    const line: TransferLine = {
      from: { kind: "treasury", cityId },
      to,
      amountRubars: paid,
      ruleId: descriptorId,
      memo,
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "budget" });
    if (!applied.ok) {
      return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `F-05: ${applied.message}`);
    }
    pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
      entryCityId === cityId
        ? `F-05: treasury of ${cityId} spent ${paid} R on "${category}" to ${payeeLabel}; authorization: ${authorizationId ?? "none"}${shortfall > 0 ? `; shortfallRubars: ${shortfall}` : ""}.`
        : `F-05: ${payeeLabel} received ${paid} R from the treasury of ${cityId} ("${category}").`
    );
  } else {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId,
        cityIds: [cityId],
        ruleIds: [descriptorId],
        changes: [],
        summaryText: `F-05: treasury of ${cityId} holds 0 R; the spend of ${amount} R on "${category}" to ${payeeLabel} funded nothing — shortfallRubars: ${shortfall}; authorization: ${authorizationId ?? "none"}.`,
      })
    );
  }
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "treasury-spend",
    scope: "city",
    cityId,
    summaryText:
      shortfall > 0
        ? `Treasury of ${cityId} spent ${paid} of ${amount} R on "${category}" to ${payeeLabel} (budget class — partial funding, shortfallRubars: ${shortfall}).`
        : `Treasury of ${cityId} spent ${amount} R on "${category}" to ${payeeLabel}.`,
  });
}

function treasurySpendReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const paths: string[] = [];
  const record = seeds.action.structuredAction ?? {};
  const cityId = record.cityId;
  if (typeof cityId === "string" && typeof record.authorizationId === "string" && record.authorizationId) {
    paths.push(`sim_cities/${cityId}/budgets/${record.authorizationId}`);
  }
  if (record.payeeKind === "treasury" && typeof record.payeeCityId === "string") {
    paths.push(cityPath(record.payeeCityId));
  }
  return { paths };
}

// ---------------------------------------------------------------------------
// F-12 — contribute_to_treasury (P4-K1 ADOPTED; brief §6.2's exact
// shape). Transfer class, public, one-way personal -> treasury. The
// contributor must own the city (funding another city's treasury is
// an inter-city act and routes through F-05's machinery, not F-12).
// F-12 creates NO reverse path: nothing in this module constructs a
// treasury -> personal line, and F-04 (withdraw from a company) still
// does not exist.
// ---------------------------------------------------------------------------

function contributeHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "F-12";
  const npc = rejectNpc(ctx, descriptorId);
  if (npc) return npc;
  const contributorId = actorMemberId(ctx.action.actor);
  if (!contributorId) {
    return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "F-12: the actor carries no member identity.");
  }
  const cityId = stringField(ctx.action, "cityId");
  if (!cityId) {
    return rejectedPlan(descriptorId, "malformed-contribution", [descriptorId], "F-12: contribute_to_treasury requires cityId.");
  }
  const authority = checkCityAuthority(ctx.snapshot, cityId, ctx.action.actor);
  if (!authority.ok) {
    return rejectedPlan(descriptorId, "not-city-owner", [descriptorId], `F-12: a member funds only their own city's treasury: ${authority.reason}. Funding another city's treasury is an inter-city transfer and routes through F-05. (Shared city: sitting mayor only, via the same helper.)`);
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-contribution", [descriptorId], "F-12: amountRubars must be a positive integer.");
  }

  const plan = emptyPlan(descriptorId);
  composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: contributorId, viaActionKind: "contribute_to_treasury" });
  const line: TransferLine = {
    from: { kind: "personal", memberId: contributorId },
    to: { kind: "treasury", cityId },
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `contribution to the treasury of ${cityId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_FUNDS" ? "insufficient-funds" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId],
      `F-12: contribution of ${amount} R to ${cityId} refused in full (transfer class — never partial, never negative): ${applied.message}`
    );
  }
  pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
    entryCityId === null
      ? `F-12: ${contributorId} contributed ${amount} R to the treasury of ${cityId}. One-way: F-12 creates no withdrawal path.`
      : `F-12: treasury of ${cityId} received a ${amount} R contribution from its owner ${contributorId}.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "contribute-to-treasury",
    scope: "city",
    cityId,
    summaryText: `Contributed ${amount} R from ${contributorId}'s personal account to the treasury of ${cityId}. One-way and public: this cannot be withdrawn (brief §6.2).`,
  });
}

function contributeReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const contributorId = actorMemberId(seeds.action.actor);
  return { paths: contributorId ? [memberAccountPath(contributorId)] : [] };
}

// ---------------------------------------------------------------------------
// B-01 — charter_bank + surrender_charter (banking amendment §1.2/§1.4).
// Owner-only, binding-class: an NPC may not charter. Charter terms are
// stated in the action and recorded VERBATIM on the corporation's
// bank block; validation reads the block, never the profile text.
// ---------------------------------------------------------------------------

function charterBankHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-01";
  if (ctx.action.actor.type === "npc") {
    return rejectedPlan(descriptorId, "npc-cannot-charter", [descriptorId], "B-01: an NPC may not charter a bank — chartering is a binding-class (Tier B) act of the owner (amendment §1.2).");
  }
  const ownerId = actorMemberId(ctx.action.actor);
  const cityId = stringField(ctx.action, "cityId");
  const corporationId = stringField(ctx.action, "corporationId");
  if (!ownerId || !cityId || !corporationId) {
    return rejectedPlan(descriptorId, "malformed-charter", [descriptorId], "B-01: charter_bank requires an owner actor, cityId, and corporationId.");
  }
  const corpPath = corporationPath(cityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `B-01: no corporation record at ${corpPath}.`);
  }
  if (corp.ownerMemberId !== ownerId) {
    return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `B-01: ${ownerId} is not the ownerMemberId of ${corporationId} — chartering is the owner's act, read from the record.`);
  }
  if (corp.status !== "active") {
    return rejectedPlan(descriptorId, "company-not-active", [descriptorId], `B-01: ${corporationId} is ${String(corp.status)}; only an active corporation may charter.`);
  }
  const existing = bankBlockOf(corp);
  if (existing && existing.status === "active") {
    return rejectedPlan(descriptorId, "already-chartered", [descriptorId], `B-01: ${corporationId} already holds an active charter (chartered at seq ${existing.charteredAtSeq}).`);
  }
  // The controller bar (BNK-D15, Phase 5): a member who controlled
  // a bank into liquidation may not charter again until BOTH
  // RECHARTER_BAR_SEQS resolved seqs have passed since that
  // liquidation AND every personal obligation the failure named
  // stands settled (their loans at the failed bank, read from the
  // records — assigned pool obligations included). Derived from the
  // standing Log + loan records on every charter attempt; a Town
  // Hall waiver entry naming the controller + bank lifts that
  // liquidation's bar (Phase 7 machinery — the derivation reads a
  // waiver if one ever stands; nothing here mints one).
  {
    const standingSeq = ctx.snapshot.counterHead.lastSeq + 1;
    const liquidations = queryDocs(ctx.snapshot, "controllerLiquidations", "sim_log_entries")
      .map(({ doc }) => {
        const banking = (doc.classification as { banking?: Record<string, unknown> } | undefined)
          ?.banking;
        return {
          seq: typeof doc.seq === "number" ? doc.seq : 0,
          bankCorporationId: typeof banking?.bankCorporationId === "string" ? banking.bankCorporationId : null,
          waived: banking?.controllerWaived === true,
        };
      })
      .filter((row) => row.bankCorporationId !== null);
    const actorLoans = queryDocs(ctx.snapshot, "controllerLoans", "sim_bank_loans").map(
      ({ doc }) => loanRecordOf(doc)
    );
    for (const liquidation of liquidations) {
      if (liquidation.waived) continue;
      const seqsPassed = standingSeq - liquidation.seq >= RECHARTER_BAR_SEQS;
      const openObligations = actorLoans.filter(
        (loan) =>
          loan !== null &&
          loan.bankCorporationId === liquidation.bankCorporationId &&
          loan.status === "assigned" &&
          loan.outstandingRubars > 0
      ).length;
      if (!seqsPassed || openObligations > 0) {
        return rejectedPlan(
          descriptorId,
          "controller-barred",
          [descriptorId],
          `B-01: ${ownerId} controlled ${liquidation.bankCorporationId} into liquidation at seq ${liquidation.seq} and is barred from chartering (BNK-D15): ${standingSeq - liquidation.seq} of ${RECHARTER_BAR_SEQS} required seqs have passed and ${openObligations} named personal obligation(s) at the failed bank stand unsettled. Both conditions must clear; a Town Hall waiver is the only other path.`
        );
      }
    }
  }
  const reserveRatioBps = sa(ctx.action).reserveRatioBps;
  if (typeof reserveRatioBps !== "number" || !Number.isInteger(reserveRatioBps) || reserveRatioBps < RESERVE_FLOOR_BPS || reserveRatioBps > 10_000) {
    return rejectedPlan(descriptorId, "reserve-ratio-invalid", [descriptorId], `B-01: reserveRatioBps must be an integer in [${RESERVE_FLOOR_BPS}, 10000] — a chartered ratio may only RAISE the published floor (§1.2).`);
  }
  const depositCeiling = sa(ctx.action).depositRateCeilingBpsPerKseq;
  const loanCeiling = sa(ctx.action).loanRateCeilingBpsPerKseq;
  for (const [label, value] of [["depositRateCeilingBpsPerKseq", depositCeiling], ["loanRateCeilingBpsPerKseq", loanCeiling]] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return rejectedPlan(descriptorId, "malformed-charter", [descriptorId], `B-01: ${label} must be a non-negative integer (charter terms are stated in the action and recorded verbatim).`);
    }
    if (value > RATE_CAP_BPS_PER_KSEQ) {
      return rejectedPlan(descriptorId, "rate-above-cap", [descriptorId], `B-01: ${label} ${value} exceeds the published hard cap of ${RATE_CAP_BPS_PER_KSEQ} bps per kseq (§4.4).`);
    }
  }
  const cash = bankCashRubars(corp);
  if (cash < CHARTER_MIN_CAPITAL_RUBARS) {
    return rejectedPlan(descriptorId, "below-charter-capital", [descriptorId], `B-01: ${corporationId} holds ${cash} R of company cash; chartering requires at least ${CHARTER_MIN_CAPITAL_RUBARS} R already inside the company (BNK-D1).`);
  }

  const plan = emptyPlan(descriptorId);
  const charteredAtSeq = nextEntrySeq(ctx.snapshot, plan);
  const block = buildBankCharterBlock({
    charteredAtSeq,
    charterEntryId: logEntryPath(charteredAtSeq),
    reserveRatioBps,
    depositRateCeilingBpsPerKseq: depositCeiling as number,
    loanRateCeilingBpsPerKseq: loanCeiling as number,
    existing,
  });
  planMutate(plan, ctx.snapshot, corpPath, "state", ["bank"], (current) =>
    current ? { ...current, bank: block } : current
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`corporations/${corporationId}.bank`, existing ?? null, block, "B-01 charter terms, recorded verbatim from the confirmed action"),
      ],
      recordsUpdated: [corpPath],
      summaryText: `B-01: ${corporationId} chartered as a bank. Terms: reserve ratio ${reserveRatioBps} bps, deposit-rate ceiling ${String(depositCeiling)} bps/kseq, loan-rate ceiling ${String(loanCeiling)} bps/kseq. Deposits are claims against the bank, not vault contents; posture copy on surfaces is generated from derived state (§7.6).`,
    })
  );
  // DIF premium chain seeding (V2-§1.3, SPEC-1 as confirmed): when
  // the fund stands, chartering starts the bank's premium chain —
  // the first period's pending, anchored to this event, ripening
  // exactly PREMIUM_PERIOD_SEQS later. Before founding there is no
  // chain (pre-founding charters seed at founding's aftermath only
  // if the fund's own composition says so — the founding act in
  // this build seeds chains for then-chartered banks itself).
  const fundStands = fundRecordOf(snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH)) !== null;
  if (fundStands) {
    const pendingId = `prem_${corporationId}_0`;
    const draft = buildSchedulePendingDraft(ctx.snapshot, {
      pendingId,
      kind: "insurance-premium-due",
      originResolutionId: ctx.resolutionId,
      originActionId: ctx.action.actionId,
      originActor: ctx.action.actor,
      originCityId: cityId,
      originSummaryText: `Deposit-insurance premium period 0 for ${corporationId}`,
      targetCityId: cityId,
      sourceKind: "action",
      generation: 1,
      chainId: pendingId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      minSeqAdvance: PREMIUM_PERIOD_SEQS,
      scheduleDerivation: {
        bankCorporationId: corporationId,
        periodIndex: 0,
        anchor: "charter-event",
        periodSeqs: PREMIUM_PERIOD_SEQS,
      },
      payloadSpec: {
        schedule: {
          kind: "insurance-premium",
          bankCorporationId: corporationId,
          bankCityId: cityId,
          periodIndex: 0,
        },
        occasion: {
          kind: "insurance-premium-due",
          severity: "routine",
          title: `Deposit-insurance premium due — ${corporationId}`,
          summary: `A premium period for ${corporationId} has ripened; the due figure is computed at ripening from the bank's standing insured liabilities (B-12).`,
          detail: { bankCorporationId: corporationId, periodIndex: 0 },
          cityId,
          audienceCityId: cityId,
          recipientUid: ownerId,
        } satisfies RipeningOccasionSpec,
      },
    });
    plan.pendingCreates.push(draft.draft);
    plan.readRefKeys.push(`pending:${pendingId}`);
  }
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "charter-bank",
    scope: "company",
    cityId,
    summaryText: `Chartered ${corporationId} as a bank (reserve ${reserveRatioBps} bps; ceilings ${String(depositCeiling)}/${String(loanCeiling)} bps per kseq). No approval gate exists — the charter is the owner's published declaration, and its terms are now world facts depositors can read.`,
    major: true,
  });
}

function surrenderCharterHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-01";
  if (ctx.action.actor.type === "npc") {
    return rejectedPlan(descriptorId, "npc-cannot-charter", [descriptorId], "B-01: surrender is a charter-class act of the owner; an NPC may not perform it.");
  }
  const ownerId = actorMemberId(ctx.action.actor);
  const cityId = stringField(ctx.action, "cityId");
  const corporationId = stringField(ctx.action, "corporationId");
  if (!ownerId || !cityId || !corporationId) {
    return rejectedPlan(descriptorId, "malformed-charter", [descriptorId], "B-01: surrender_charter requires an owner actor, cityId, and corporationId.");
  }
  const corpPath = corporationPath(cityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `B-01: no corporation record at ${corpPath}.`);
  }
  if (corp.ownerMemberId !== ownerId) {
    return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `B-01: ${ownerId} is not the ownerMemberId of ${corporationId}.`);
  }
  const bank = bankBlockOf(corp);
  if (!bank || bank.status !== "active") {
    return rejectedPlan(descriptorId, "not-chartered", [descriptorId], `B-01: ${corporationId} holds no active charter to surrender.`);
  }
  if (bank.depositLiabilitiesRubars !== 0 || bank.loanBookRubars !== 0) {
    return rejectedPlan(descriptorId, "charter-has-live-claims", [descriptorId], `B-01: surrender is valid only at zero live claims — ${corporationId} carries ${bank.depositLiabilitiesRubars} R of deposit liabilities and ${bank.loanBookRubars} R of loan book. A bank exits banking by first ceasing to owe and be owed (§1.4).`);
  }
  const plan = emptyPlan(descriptorId);
  planMutate(plan, ctx.snapshot, corpPath, "state", ["bank.status"], (current) => {
    if (!current) return current;
    const currentBank = bankBlockOf(current);
    if (!currentBank) return current;
    return { ...current, bank: { ...currentBank, status: "surrendered" } };
  });
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`corporations/${corporationId}.bank.status`, "active", "surrendered", "B-01 surrender at zero live claims (§1.4)"),
      ],
      recordsUpdated: [corpPath],
      summaryText: `B-01: ${corporationId} surrendered its charter. The block is retained for the record; the company continues as an ordinary company.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "surrender-charter",
    scope: "company",
    cityId,
    summaryText: `Surrendered the bank charter of ${corporationId} at zero live claims.`,
  });
}

function charterReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
  }
  const actorId = actorMemberId(seeds.action.actor);
  const queries: DescriptorReadPlan["queries"] = [];
  if (actorId && seeds.action.actionType === "charter_bank") {
    // The controller bar's inputs (BNK-D15): the actor's liquidation
    // summaries + their loan records (obligations read per-bank in
    // the handler).
    queries.push(
      {
        id: "controllerLiquidations",
        collectionPath: "sim_log_entries",
        filters: [
          { field: "classification.banking.controllerMemberId", op: "==", value: actorId },
        ],
      },
      {
        id: "controllerLoans",
        collectionPath: "sim_bank_loans",
        filters: [{ field: "borrower.memberId", op: "==", value: actorId }],
      }
    );
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// Banking slice — shared deposit machinery (B-02/B-03/B-04).
// ---------------------------------------------------------------------------

function depositRecordOf(doc: Record<string, unknown> | null): BankDepositRecord | null {
  if (!doc || typeof doc.depositId !== "string") return null;
  return doc as unknown as BankDepositRecord;
}

function ledgerRefsEqual(a: LedgerRef, b: LedgerRef): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "personal":
      return a.memberId === (b as { memberId: string }).memberId;
    case "treasury":
      return a.cityId === (b as { cityId: string }).cityId;
    case "company":
      return (
        a.corporationId === (b as { corporationId: string }).corporationId &&
        a.cityId === (b as { cityId: string }).cityId
      );
    default:
      return false;
  }
}

/** Parse an action-named LedgerRef (B-03/B-04 name the depositor ref
 * from the deposit record they can read; handlers cross-check it
 * against the stored record — the action never substitutes for the
 * record). */
function parseLedgerRef(value: unknown): LedgerRef | null {
  if (typeof value !== "object" || value === null) return null;
  const ref = value as Record<string, unknown>;
  if (ref.kind === "personal" && typeof ref.memberId === "string") {
    return { kind: "personal", memberId: ref.memberId };
  }
  if (ref.kind === "treasury" && typeof ref.cityId === "string") {
    return { kind: "treasury", cityId: ref.cityId };
  }
  if (ref.kind === "company" && typeof ref.corporationId === "string" && typeof ref.cityId === "string") {
    return { kind: "company", corporationId: ref.corporationId, cityId: ref.cityId };
  }
  return null;
}

function depositorReadPaths(ref: LedgerRef | null): string[] {
  if (!ref) return [];
  switch (ref.kind) {
    case "personal":
      return [memberAccountPath(ref.memberId)];
    case "company":
      return [corporationPath(ref.cityId, ref.corporationId)];
    case "treasury":
      return [cityPath(ref.cityId), `factions/${ref.cityId}`];
    default:
      return [];
  }
}

interface BankTarget {
  corpPath: string;
  corp: Record<string, unknown>;
  bank: NonNullable<ReturnType<typeof bankBlockOf>>;
}

function parseBankTarget(
  ctx: HandlerContext,
  descriptorId: string
): BankTarget | ResolutionPlan {
  const cityId = stringField(ctx.action, "cityId");
  const corporationId = stringField(ctx.action, "corporationId");
  if (!cityId || !corporationId) {
    return rejectedPlan(descriptorId, "malformed-action", [descriptorId], `${descriptorId}: the action requires cityId and corporationId naming the bank.`);
  }
  const corpPath = corporationPath(cityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `${descriptorId}: no corporation record at ${corpPath}.`);
  }
  const bank = bankBlockOf(corp);
  if (!bank || bank.status !== "active") {
    return rejectedPlan(descriptorId, "bank-not-chartered", [descriptorId], `${descriptorId}: ${corporationId} holds no active bank charter — banking powers attach to the charter block, never to a company's profile text (§1.1).`);
  }
  return { corpPath, corp, bank };
}

interface DepositTarget {
  depositPath: string;
  deposit: BankDepositRecord;
  bank: BankTarget & { cityId: string; corporationId: string };
}

function parseDepositTarget(
  ctx: HandlerContext,
  descriptorId: string
): DepositTarget | ResolutionPlan {
  const depositId = stringField(ctx.action, "depositId");
  if (!depositId) {
    return rejectedPlan(descriptorId, "malformed-action", [descriptorId], `${descriptorId}: the action requires depositId.`);
  }
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const depositPath = bankDepositPath(depositId);
  const deposit = depositRecordOf(snapshotDoc(ctx.snapshot, depositPath));
  if (!deposit) {
    return rejectedPlan(descriptorId, "deposit-not-found", [descriptorId], `${descriptorId}: no deposit record at ${depositPath}.`);
  }
  if (deposit.bankCorporationId !== corporationId || deposit.bankCityId !== cityId) {
    return rejectedPlan(descriptorId, "deposit-bank-mismatch", [descriptorId], `${descriptorId}: deposit ${depositId} names bank ${deposit.bankCorporationId} in ${deposit.bankCityId}; the action names ${corporationId} in ${cityId}. The stored record governs.`);
  }
  return { depositPath, deposit, bank: { ...bankOrPlan, cityId, corporationId } };
}

type BankAggregateField =
  | "depositLiabilitiesRubars"
  | "loanBookRubars"
  | "insiderLoansRubars"
  | "seizedAssetsRubars";

/** Fold an aggregate delta on the bank's charter block into the
 * plan and return its tagged change (the per-event pair discipline:
 * the aggregate and the record(s) it aggregates move in the SAME
 * event or the conservation checker fires — A-B1/A-B2/A-B3/A-B7). */
function applyBankAggregateDelta(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  target: BankTarget & { cityId: string; corporationId: string },
  field: BankAggregateField,
  delta: number,
  ruleId: string
): TaggedChange {
  const plannedBank = bankBlockOf(plannedDoc(plan, ctx.snapshot, target.corpPath) ?? {});
  const before = plannedBank ? ((plannedBank[field] as number | undefined) ?? 0) : 0;
  planMutate(plan, ctx.snapshot, target.corpPath, "state", [`bank.${field}`], (current) => {
    if (!current) return current;
    const currentBank = bankBlockOf(current);
    if (!currentBank) return current;
    return {
      ...current,
      bank: { ...currentBank, [field]: ((currentBank[field] as number | undefined) ?? 0) + delta },
    };
  });
  return {
    entryCityId: target.cityId,
    change: fieldChange(
      `corporations/${target.corporationId}.bank.${field}`,
      before,
      before + delta,
      `${ruleId} aggregate — the per-event pair of the bank record change it aggregates`
    ),
  };
}

/** Fold the liability-aggregate delta for a bank into the plan and
 * return its tagged change (the A-B1 pair of the deposit record's
 * claim change — both sides land in the same event's Log). */
function applyAggregateDelta(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  target: BankTarget & { cityId: string; corporationId: string },
  delta: number,
  ruleId: string
): TaggedChange {
  return applyBankAggregateDelta(plan, ctx, target, "depositLiabilitiesRubars", delta, ruleId);
}

// ---------------------------------------------------------------------------
// B-02 — deposit_funds (banking amendment §2.4). The cash moves as an
// ordinary transfer line; the deposit record comes into existence in
// the same event; the liability aggregate follows. Custody ≠
// ownership: the depositor owns the CLAIM, the bank owns the cash.
// Treasury deposits are this amendment's named new seam (§2.3): the
// governor's act, sitting-mayor-only for the shared city via the same
// authority helper as F-12.
// ---------------------------------------------------------------------------

function depositHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-02";
  // Tier A within caps (addendum §2): the Phase 4 blanket NPC
  // refusal retires — the authority stage enforces mandate + caps
  // before dispatch, and the act settles into the principal's
  // ledgers like every Tier A banking verb.
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const bankTarget: BankTarget & { cityId: string; corporationId: string } = { ...bankOrPlan, cityId, corporationId };

  const health = deriveBankHealth(bankTarget.corp);
  if (health === "insolvent") {
    return rejectedPlan(descriptorId, "bank-failed", [descriptorId], `B-02: ${corporationId}'s derived health is insolvent (net worth < 0, §5.1) — a failed bank takes no new deposits.`);
  }
  if (health === "liquidity-impaired") {
    return rejectedPlan(descriptorId, "bank-impaired", [descriptorId], `B-02: ${corporationId} is liquidity-impaired (cash below its liquid reserve, §5.1) — impairment restricts growth: no new deposits.`);
  }
  // Premium suspension (V2-§1.3): a bank two premium periods in
  // arrears is suspended — B-02 refuses, and deposits opened during
  // suspension would derive uninsured for life, so none open.
  if (bankPremiumLadder(ctx.snapshot, corporationId).state === "suspended") {
    return rejectedPlan(descriptorId, "premium-delinquent-suspended", [descriptorId], `B-02: ${corporationId} is suspended from insured deposit-taking — two consecutive premium periods stand unsettled in its Log (the delinquency ladder, V2-§1.3). Paying the arrears in full (B-12) restores it.`);
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-deposit", [descriptorId], "B-02: amountRubars must be a positive integer.");
  }
  const rate = sa(ctx.action).rateBpsPerKseq;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0) {
    return rejectedPlan(descriptorId, "malformed-deposit", [descriptorId], "B-02: rateBpsPerKseq must be a non-negative integer stated in the confirmed action — a deposit is an agreement, and its terms are previewed in full (§2.4).");
  }
  if (rate > RATE_CAP_BPS_PER_KSEQ) {
    return rejectedPlan(descriptorId, "rate-above-cap", [descriptorId], `B-02: rate ${rate} exceeds the published hard cap of ${RATE_CAP_BPS_PER_KSEQ} bps per kseq (§4.4).`);
  }
  if (rate > bankTarget.bank.depositRateCeilingBpsPerKseq) {
    return rejectedPlan(descriptorId, "rate-above-charter-ceiling", [descriptorId], `B-02: rate ${rate} exceeds ${corporationId}'s chartered deposit-rate ceiling of ${bankTarget.bank.depositRateCeilingBpsPerKseq} bps per kseq — the charter is the bank's standing offer, and a rate it forbids is not the depositor's surprise to discover later.`);
  }

  // Depositor resolution (§2.3): member | company | treasury.
  const fromKind = stringField(ctx.action, "fromKind") ?? "personal";
  let depositor: LedgerRef;
  if (fromKind === "personal") {
    const memberId = actorMemberId(ctx.action.actor);
    if (!memberId) {
      return rejectedPlan(descriptorId, "not-a-member", [descriptorId], "B-02: the actor carries no member identity.");
    }
    depositor = { kind: "personal", memberId };
  } else if (fromKind === "company") {
    const fromCityId = stringField(ctx.action, "fromCityId");
    const fromCorporationId = stringField(ctx.action, "fromCorporationId");
    if (!fromCityId || !fromCorporationId) {
      return rejectedPlan(descriptorId, "malformed-deposit", [descriptorId], "B-02: a company depositor requires fromCityId and fromCorporationId.");
    }
    const fromCorp = snapshotDoc(ctx.snapshot, corporationPath(fromCityId, fromCorporationId));
    if (!fromCorp) {
      return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `B-02: no corporation record for depositor ${fromCorporationId}.`);
    }
    if (fromCorp.ownerMemberId !== actorMemberId(ctx.action.actor)) {
      return rejectedPlan(descriptorId, "not-company-owner", [descriptorId], `B-02: the actor is not the ownerMemberId of depositor company ${fromCorporationId}.`);
    }
    depositor = { kind: "company", corporationId: fromCorporationId, cityId: fromCityId };
  } else if (fromKind === "treasury") {
    const fromCityId = stringField(ctx.action, "fromCityId");
    if (!fromCityId) {
      return rejectedPlan(descriptorId, "malformed-deposit", [descriptorId], "B-02: a treasury depositor requires fromCityId.");
    }
    const authority = checkCityAuthority(ctx.snapshot, fromCityId, ctx.action.actor);
    if (!authority.ok) {
      return rejectedPlan(descriptorId, "not-city-governor", [descriptorId], `B-02: a treasury deposit is the governor's act: ${authority.reason}.`);
    }
    depositor = { kind: "treasury", cityId: fromCityId };
  } else {
    return rejectedPlan(descriptorId, "malformed-deposit", [descriptorId], "B-02: fromKind must be personal | company | treasury. The Market Account and the Exterior never deposit (§2.3).");
  }

  // Top-up resolution: an existing deposit at identical terms grows;
  // different terms are a new record, never a mutation of this one.
  const topUpId = stringField(ctx.action, "depositId");
  let topUp: BankDepositRecord | null = null;
  if (topUpId) {
    topUp = depositRecordOf(snapshotDoc(ctx.snapshot, bankDepositPath(topUpId)));
    if (!topUp) {
      return rejectedPlan(descriptorId, "deposit-not-found", [descriptorId], `B-02: no deposit record ${topUpId} to top up.`);
    }
    if (topUp.status !== "active" || topUp.bankCorporationId !== corporationId || !ledgerRefsEqual(topUp.depositor, depositor) || topUp.rateBpsPerKseq !== rate) {
      return rejectedPlan(descriptorId, "topup-terms-mismatch", [descriptorId], "B-02: a top-up must name an active deposit at this bank, for this depositor, at the identical rate — one record, one rate, forever auditable (§2.4). Different terms open a new deposit (omit depositId).");
    }
  }

  const plan = emptyPlan(descriptorId);
  if (depositor.kind === "personal") {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: depositor.memberId, viaActionKind: "deposit_funds" });
  }
  const line: TransferLine = {
    from: depositor,
    to: corporationRef(cityId, corporationId),
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `deposit into ${corporationId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `B-02: deposit of ${amount} R into ${corporationId} refused: ${applied.message}`);
  }

  // The deposit record entry is pushed FIRST among this rule's
  // entries — its seq is the record's openedAtSeq / openingEntryId.
  const depositId = topUp ? topUp.depositId : `dep_${ctx.resolutionId}`;
  const depositPath = bankDepositPath(depositId);
  const openingSeq = nextEntrySeq(ctx.snapshot, plan);
  const depositChanges: SimChange[] = [];
  if (topUp) {
    planMutate(plan, ctx.snapshot, depositPath, "state", ["principalRubars"], (current) =>
      current ? { ...current, principalRubars: (current.principalRubars as number) + amount } : current
    );
    depositChanges.push(
      fieldChange(`bankDeposits/${depositId}.principalRubars`, topUp.principalRubars, topUp.principalRubars + amount, "B-02 top-up at identical terms (§2.4)")
    );
  } else {
    const doc = buildBankDepositDoc({
      depositId,
      bankCorporationId: corporationId,
      bankCityId: cityId,
      depositor,
      principalRubars: amount,
      rateBpsPerKseq: rate,
      openedAtSeq: openingSeq,
      openingEntryId: logEntryPath(openingSeq),
    });
    planWrite(plan, ctx.snapshot, depositPath, doc, "state", [
      "principalRubars",
      "creditedInterestRubars",
      "status",
      "rateBpsPerKseq",
      "origin",
      "fundingLoanId",
    ]);
    depositChanges.push(
      fieldChange(`bankDeposits/${depositId}.principalRubars`, null, amount, "B-02 deposit — claim created (custody is not ownership, §2.1)"),
      fieldChange(`bankDeposits/${depositId}.creditedInterestRubars`, null, 0, "B-02 deposit — credited interest starts at 0"),
      fieldChange(`bankDeposits/${depositId}.status`, null, "active", "B-02 deposit — status"),
      fieldChange(`bankDeposits/${depositId}.rateBpsPerKseq`, null, rate, "B-02 deposit — agreed rate"),
      fieldChange(`bankDeposits/${depositId}.origin`, null, "cash", "B-02 deposit — provenance: cash-funded (§2.1)")
    );
  }
  const aggregateChange = applyAggregateDelta(plan, ctx, bankTarget, amount, descriptorId);
  // A-B6 maintenance: a covered-class deposit's claim growth moves
  // the fund's insured-liabilities aggregate in the same event
  // (top-ups read the record's own open-date eligibility).
  const coverageRecord: BankDepositRecord =
    topUp ??
    (depositRecordOf(plannedDoc(plan, ctx.snapshot, depositPath)) as BankDepositRecord);
  const insuredChange = applyInsuredLiabilityDelta(plan, ctx, {
    deposit: coverageRecord,
    deltaRubars: amount,
    bank: bankTarget,
    ruleId: descriptorId,
  });
  const insider =
    depositor.kind === "personal" && depositor.memberId === bankTarget.corp.ownerMemberId;
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: depositChanges,
      recordsCreated: topUp ? [] : [depositPath],
      recordsUpdated: topUp ? [depositPath] : [],
      summaryText: topUp
        ? `B-02: deposit ${depositId} topped up by ${amount} R at its standing rate of ${rate} bps/kseq.`
        : `B-02: deposit ${depositId} opened — ${ledgerLabel(depositor)} deposited ${amount} R into ${corporationId} at ${rate} bps/kseq. The cash is the bank's; the depositor owns the recorded claim.${insider ? " Insider deposit (depositor is the bank's owner) — flagged by derivation, ranked identically (§2.3)." : ""}`,
    })
  );
  pushMovementEntries(
    plan,
    ctx,
    descriptorId,
    [...applied.changes, aggregateChange, ...(insuredChange ? [insuredChange] : [])],
    (entryCityId) =>
      entryCityId === cityId
        ? `B-02: ${corporationId}'s cash and deposit liabilities each rose by ${amount} R (A-B1 pair). Cash ${bankCashRubars(plannedDoc(plan, ctx.snapshot, bankTarget.corpPath) ?? {})} R; unencumbered ${unencumberedCash(plannedDoc(plan, ctx.snapshot, bankTarget.corpPath))} R after the deposit.`
        : `B-02: ${ledgerLabel(depositor)} paid ${amount} R into ${corporationId} as a deposit.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "deposit",
    scope: "bank",
    cityId,
    summaryText: topUp
      ? `Topped up deposit ${depositId} by ${amount} R in ${corporationId}.`
      : `Deposited ${amount} R into ${corporationId} from ${ledgerLabel(depositor)} at ${rate} bps/kseq — deposit ${depositId} records the claim; the bank's liability aggregate rose in the same event (A-B1).`,
  });
}

function depositReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: DescriptorReadPlan["queries"] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId));
  }
  const fromKind = typeof record.fromKind === "string" ? record.fromKind : "personal";
  if (fromKind === "personal") {
    const memberId = actorMemberId(seeds.action.actor);
    if (memberId) paths.push(memberAccountPath(memberId));
  } else if (fromKind === "company" && typeof record.fromCityId === "string" && typeof record.fromCorporationId === "string") {
    paths.push(corporationPath(record.fromCityId, record.fromCorporationId));
  } else if (fromKind === "treasury" && typeof record.fromCityId === "string") {
    paths.push(cityPath(record.fromCityId), `factions/${record.fromCityId}`);
  }
  if (typeof record.depositId === "string" && record.depositId) {
    paths.push(bankDepositPath(record.depositId));
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-03 — withdraw_deposit (custodial class; amendment §2.5). A
// withdrawal is of PRINCIPAL: accrued-unsettled interest is not
// withdrawable — it realizes only through B-04 settlement. A
// withdrawal that closes the record (principal -> 0) extinguishes
// any accrued-unsettled interest UNCLAIMED: that is the depositor's
// own confirmed act (their preview shows claim and principal
// distinctly, §2.2), the extinguished figure is printed in the Log
// entry — never silent — and it touches no recorded claim stock
// (accrued-unsettled is a derived figure, not a balance), so the
// conservation checker sees exactly the principal's movement.
// (Reading flagged for the Phase 4 gate: the stricter alternative —
// refusing closure until B-04 runs — makes full withdrawal
// practically unreachable at any positive rate, since dust interest
// accrues within a few seqs of any settlement.) Custodial
// semantics: full payment if UNENCUMBERED cash covers it, otherwise
// rejection in full — partial payment is forbidden (the
// no-surprise rule).
// ---------------------------------------------------------------------------

function withdrawHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-03";
  // Tier A (addendum §2) — the blanket NPC refusal retires with
  // B-02's; the authority stage enforces mandate + caps.
  const targetOrPlan = parseDepositTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { depositPath, deposit, bank } = targetOrPlan;
  if (deposit.status !== "active") {
    return rejectedPlan(descriptorId, "deposit-not-active", [descriptorId], `B-03: deposit ${deposit.depositId} is ${deposit.status}; only an active deposit can be withdrawn from.`);
  }
  // The action names the depositor ref (read from the record); the
  // stored record governs — a mismatch is a refusal, not a redirect.
  const namedDepositor = parseLedgerRef(sa(ctx.action).depositor);
  if (!namedDepositor || !ledgerRefsEqual(namedDepositor, deposit.depositor)) {
    return rejectedPlan(descriptorId, "depositor-mismatch", [descriptorId], "B-03: the action's depositor ref does not match the deposit record's depositor. The stored record governs.");
  }
  // Control: the withdrawal is the depositor's own act (or their
  // company's owner / city's governor, per the depositor kind).
  const actorId = actorMemberId(ctx.action.actor);
  if (deposit.depositor.kind === "personal" && actorId !== deposit.depositor.memberId) {
    return rejectedPlan(descriptorId, "not-depositor", [descriptorId], "B-03: a personal deposit is withdrawn by its depositor.");
  }
  if (deposit.depositor.kind === "company") {
    const depCorp = snapshotDoc(ctx.snapshot, corporationPath(deposit.depositor.cityId, deposit.depositor.corporationId));
    if (!depCorp || depCorp.ownerMemberId !== actorId) {
      return rejectedPlan(descriptorId, "not-depositor", [descriptorId], "B-03: a company deposit is withdrawn by the depositor company's ownerMemberId.");
    }
  }
  if (deposit.depositor.kind === "treasury") {
    const authority = checkCityAuthority(ctx.snapshot, deposit.depositor.cityId, ctx.action.actor);
    if (!authority.ok) {
      return rejectedPlan(descriptorId, "not-depositor", [descriptorId], `B-03: a treasury deposit is withdrawn by its governor: ${authority.reason}.`);
    }
  }
  // Failure freezes withdrawals (§5.1): a bank deriving insolvent
  // under the REC-6 identity pays no one outside the waterfall.
  // Liquidity impairment alone does NOT freeze B-03 — the custodial
  // test below prices each withdrawal on its own.
  if (deriveBankHealth(bank.corp) === "insolvent") {
    return rejectedPlan(descriptorId, "bank-failed", [descriptorId], `B-03: ${bank.corporationId} derives failed (insolvent under the REC-6 balance-sheet identity) — withdrawals are frozen; depositors' claims resolve in liquidation (B-10), not at the window.`);
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-withdrawal", [descriptorId], "B-03: amountRubars must be a positive integer.");
  }
  if (amount > deposit.principalRubars) {
    return rejectedPlan(descriptorId, "withdrawal-exceeds-principal", [descriptorId], `B-03: withdrawal of ${amount} R exceeds the deposit's principal of ${deposit.principalRubars} R. Accrued-unsettled interest is not principal — it realizes only through B-04 settlement.`);
  }
  const closesAccrued =
    amount === deposit.principalRubars
      ? accruedUnsettledRubars(deposit, ctx.snapshot.counterHead.lastSeq + 1)
      : 0;

  const plan = emptyPlan(descriptorId);
  const line: TransferLine = {
    from: corporationRef(bank.cityId, bank.corporationId),
    to: deposit.depositor,
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `withdrawal from deposit ${deposit.depositId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "custodial" });
  if (!applied.ok) {
    return rejectedPlan(
      descriptorId,
      applied.code === "INSUFFICIENT_UNENCUMBERED" ? "insufficient-unencumbered" : applied.code.toLowerCase().replace(/_/g, "-"),
      [descriptorId],
      `B-03: withdrawal of ${amount} R from deposit ${deposit.depositId} refused in full (custodial class — never partial): ${applied.message} This rejection is a standing world fact: once the bank carries a loan book it is failure-triggering evidence (§5.1).`
    );
  }
  const newPrincipal = deposit.principalRubars - amount;
  const closes = newPrincipal === 0;
  planMutate(plan, ctx.snapshot, depositPath, "state", closes ? ["principalRubars", "status"] : ["principalRubars"], (current) =>
    current
      ? { ...current, principalRubars: newPrincipal, ...(closes ? { status: "closed" } : {}) }
      : current
  );
  const aggregateChange = applyAggregateDelta(plan, ctx, bank, -amount, descriptorId);
  // A-B6 maintenance: the covered claim falls by the withdrawal —
  // and by its credited interest too when the withdrawal closes
  // the record (the derivation counts active records only).
  const insuredChange = applyInsuredLiabilityDelta(plan, ctx, {
    deposit,
    deltaRubars: -(amount + (closes ? deposit.creditedInterestRubars : 0)),
    bank,
    ruleId: descriptorId,
  });
  const depositChanges: SimChange[] = [
    fieldChange(`bankDeposits/${deposit.depositId}.principalRubars`, deposit.principalRubars, newPrincipal, "B-03 withdrawal of principal (custodial)"),
  ];
  if (closes) {
    depositChanges.push(fieldChange(`bankDeposits/${deposit.depositId}.status`, "active", "closed", "B-03 — closed only at full withdrawal (§2.2)"));
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: depositChanges,
      recordsUpdated: [depositPath],
      summaryText: `B-03: deposit ${deposit.depositId} principal ${deposit.principalRubars} -> ${newPrincipal} R${closes ? "; the record closes at full withdrawal" : ""}${closes && closesAccrued > 0 ? `; ${closesAccrued} R of accrued-unsettled interest is extinguished unclaimed by the depositor's own closing act (it was a derived figure, never a balance — B-04 is the only path that realizes it)` : ""}.`,
    })
  );
  pushMovementEntries(
    plan,
    ctx,
    descriptorId,
    [...applied.changes, aggregateChange, ...(insuredChange ? [insuredChange] : [])],
    (entryCityId) =>
      entryCityId === bank.cityId
        ? `B-03: ${bank.corporationId} paid ${amount} R of custodial money to ${ledgerLabel(deposit.depositor)}; unencumbered cash after: ${unencumberedCash(plannedDoc(plan, ctx.snapshot, bank.corpPath))} R.`
        : `B-03: ${ledgerLabel(deposit.depositor)} received ${amount} R withdrawn from deposit ${deposit.depositId}.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "withdraw-deposit",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: `Withdrew ${amount} R of principal from deposit ${deposit.depositId} at ${bank.corporationId}, paid in full from unencumbered cash (custodial class).`,
  });
}

// ---------------------------------------------------------------------------
// B-04 — settle_deposit_interest (amendment §2.6). Settlement is
// the BANK's act (its owner initiates); the amount is §4.1's one
// formula over (principal + credited, rate, lastSettledSeq ->
// settlement seq), reproducible from the standing Log alone. The
// cash-paid branch pays the amount as a custodial transfer (a
// shortfall rejects in full and the watermark does not move). The
// CREDITED branch (Phase 5, addendum item 1) capitalizes the
// amount into the claim instead: creditedInterestRubars += amount,
// the liability aggregate moves in the same event (A-B1's pair),
// NO cash moves, and the claim bridge classifies the growth
// "interest-capitalized" (Appendix A) — which is precisely why the
// branch waited for the claim bridge to exist.
// ---------------------------------------------------------------------------

function settleInterestHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-04";
  // Tier A (addendum §2): a mandated NPC settles for its principal —
  // actorMemberId resolves the NPC to the owner it acts for, and the
  // authority stage has already enforced the mandate. The Phase 4
  // in-handler NPC exclusion retires with the blanket refusal.
  const targetOrPlan = parseDepositTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { depositPath, deposit, bank } = targetOrPlan;
  if (actorMemberId(ctx.action.actor) !== bank.corp.ownerMemberId) {
    return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], "B-04: settling deposit interest is the bank's act — initiated by the bank's owner (in person, or by their mandated NPC under the Phase 5 authority stage). It is never auto-debited by the world (§2.6).");
  }
  if (deposit.status !== "active") {
    return rejectedPlan(descriptorId, "deposit-not-active", [descriptorId], `B-04: deposit ${deposit.depositId} is ${deposit.status}; only an active deposit settles.`);
  }
  const namedDepositor = parseLedgerRef(sa(ctx.action).depositor);
  if (!namedDepositor || !ledgerRefsEqual(namedDepositor, deposit.depositor)) {
    return rejectedPlan(descriptorId, "depositor-mismatch", [descriptorId], "B-04: the action's depositor ref does not match the deposit record's depositor. The stored record governs.");
  }
  // Failure fixes claim figures (§5.3): in EITHER branch a bank
  // deriving failed settles nothing — claims resolve in B-10, where
  // the frozen figure (principal + credited + computable unsettled
  // interest at the failure seq) is the one basis (REC-5).
  if (deriveBankHealth(bank.corp) === "insolvent") {
    return rejectedPlan(descriptorId, "bank-failed", [descriptorId], `B-04: ${bank.corporationId} derives failed (insolvent under the REC-6 identity) — settlement is frozen in both branches; the claim figure fixes at liquidation (REC-5).`);
  }
  if (sa(ctx.action).settlementMode === "credited") {
    return settleInterestCredited(ctx, { depositPath, deposit, bank });
  }

  const plan = emptyPlan(descriptorId);
  // The settlement entry — the one carrying the watermark change — is
  // pushed after the movement entries; its seq is the settlement seq
  // the formula and the new watermark both name. Movement groups are
  // determined by the two ledgers' entry cities alone, so the seq is
  // exact before the amount is computed.
  const bankRef = corporationRef(bank.cityId, bank.corporationId);
  const groupCities = new Set<string | null>([
    bank.cityId,
    deposit.depositor.kind === "treasury"
      ? deposit.depositor.cityId
      : deposit.depositor.kind === "company"
        ? deposit.depositor.cityId
        : null,
  ]);
  const settlementSeq =
    ctx.snapshot.counterHead.lastSeq + 1 + plan.entries.length + groupCities.size;
  const amount = accruedUnsettledRubars(deposit, settlementSeq);

  if (amount > 0) {
    const line: TransferLine = {
      from: bankRef,
      to: deposit.depositor,
      amountRubars: amount,
      ruleId: descriptorId,
      memo: `deposit interest settlement for ${deposit.depositId} (seq ${deposit.lastSettledSeq} -> ${settlementSeq})`,
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "custodial" });
    if (!applied.ok) {
      return rejectedPlan(
        descriptorId,
        applied.code === "INSUFFICIENT_UNENCUMBERED" ? "insufficient-unencumbered" : applied.code.toLowerCase().replace(/_/g, "-"),
        [descriptorId],
        `B-04: interest settlement of ${amount} R on deposit ${deposit.depositId} refused in full (custodial class): ${applied.message} The settlement watermark does not move.`
      );
    }
    pushMovementEntries(plan, ctx, descriptorId, applied.changes, (entryCityId) =>
      entryCityId === bank.cityId
        ? `B-04: ${bank.corporationId} paid ${amount} R of deposit interest in cash (custodial); liquid reserve after: ${liquidReserveRubars(plannedDoc(plan, ctx.snapshot, bank.corpPath))} R.`
        : `B-04: ${ledgerLabel(deposit.depositor)} received ${amount} R of settled deposit interest.`
    );
  }
  // Zero-interest case: no movement entries were pushed, so the
  // settlement entry's own seq is earlier than the seq the (zero)
  // computation ran to. The watermark names the settlement entry's
  // actual seq; interest is monotone in Δseq, so a zero over the
  // longer span is a zero over the shorter — nothing is skipped or
  // double-counted, and the figure stays reproducible from the Log.
  const watermarkSeq = amount > 0 ? settlementSeq : nextEntrySeq(ctx.snapshot, plan);
  planMutate(plan, ctx.snapshot, depositPath, "state", ["lastSettledSeq"], (current) =>
    current ? { ...current, lastSettledSeq: watermarkSeq } : current
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(
          `bankDeposits/${deposit.depositId}.lastSettledSeq`,
          deposit.lastSettledSeq,
          watermarkSeq,
          `B-04 settlement watermark — interest = floor((${deposit.principalRubars} + ${deposit.creditedInterestRubars}) x ${deposit.rateBpsPerKseq} x ${settlementSeq - deposit.lastSettledSeq} / 10000000) = ${amount} R (§4.1)`
        ),
      ],
      recordsUpdated: [depositPath],
      summaryText:
        amount > 0
          ? `B-04: deposit ${deposit.depositId} settled ${amount} R of interest in cash; watermark ${deposit.lastSettledSeq} -> ${watermarkSeq}.`
          : `B-04: deposit ${deposit.depositId} settled — no interest accrued over seq ${deposit.lastSettledSeq} -> ${settlementSeq} (amount 0); the watermark advances to this entry's seq (${watermarkSeq}) and nothing moves.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "settle-deposit-interest",
    scope: "bank",
    cityId: bank.cityId,
    summaryText:
      amount > 0
        ? `Settled ${amount} R of interest on deposit ${deposit.depositId} in cash from ${bank.corporationId} (B-04 cash-paid branch). Watermark now ${watermarkSeq}.`
        : `Settled deposit ${deposit.depositId}: no interest accrued; watermark advanced to ${watermarkSeq}, no money moved.`,
    classificationExtra: {
      settlement: {
        mode: "cash-paid",
        depositId: deposit.depositId,
        amountRubars: amount,
        bridgeClass: "transfer",
      },
    },
  });
}

/** B-04 credited branch (Appendix A's B-04 row): interest settles
 * as claim, not cash. Entry order: the deposit-record entry FIRST
 * (its seq is the settlement seq the formula names — parity with
 * the cash branch's settlement-entry arithmetic), then the
 * liability aggregate's movement entry. A zero accrual advances
 * the watermark to the settlement entry's own seq with no claim
 * movement, exactly as the cash branch's zero case. */
function settleInterestCredited(
  ctx: HandlerContext,
  target: DepositTarget
): ResolutionPlan {
  const descriptorId = "B-04";
  const { depositPath, deposit, bank } = target;
  const plan = emptyPlan(descriptorId);
  const settlementSeq = nextEntrySeq(ctx.snapshot, plan);
  const amount = accruedUnsettledRubars(deposit, settlementSeq);
  const changes: SimChange[] = [];
  if (amount > 0) {
    planMutate(plan, ctx.snapshot, depositPath, "state", ["creditedInterestRubars", "lastSettledSeq"], (current) =>
      current
        ? {
            ...current,
            creditedInterestRubars: (current.creditedInterestRubars as number) + amount,
            lastSettledSeq: settlementSeq,
          }
        : current
    );
    changes.push(
      fieldChange(
        `bankDeposits/${deposit.depositId}.creditedInterestRubars`,
        deposit.creditedInterestRubars,
        deposit.creditedInterestRubars + amount,
        `B-04 credited settlement — interest capitalizes into the claim (§4.1: floor((${deposit.principalRubars} + ${deposit.creditedInterestRubars}) x ${deposit.rateBpsPerKseq} x ${settlementSeq - deposit.lastSettledSeq} / 10000000) = ${amount} R); the claim bridge classifies this growth interest-capitalized (Appendix A)`
      ),
      fieldChange(
        `bankDeposits/${deposit.depositId}.lastSettledSeq`,
        deposit.lastSettledSeq,
        settlementSeq,
        "B-04 settlement watermark (credited branch)"
      )
    );
  } else {
    planMutate(plan, ctx.snapshot, depositPath, "state", ["lastSettledSeq"], (current) =>
      current ? { ...current, lastSettledSeq: settlementSeq } : current
    );
    changes.push(
      fieldChange(
        `bankDeposits/${deposit.depositId}.lastSettledSeq`,
        deposit.lastSettledSeq,
        settlementSeq,
        "B-04 settlement watermark — no interest accrued over the span (amount 0); the watermark advances and nothing moves"
      )
    );
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes,
      recordsUpdated: [depositPath],
      summaryText:
        amount > 0
          ? `B-04 (credited): deposit ${deposit.depositId} settled ${amount} R of interest into its claim — credited interest ${deposit.creditedInterestRubars} -> ${deposit.creditedInterestRubars + amount} R, watermark ${deposit.lastSettledSeq} -> ${settlementSeq}. No cash moved; the claim grew, classified interest-capitalized.`
          : `B-04 (credited): deposit ${deposit.depositId} settled — no interest accrued over seq ${deposit.lastSettledSeq} -> ${settlementSeq} (amount 0); the watermark advances and nothing moves.`,
    })
  );
  if (amount > 0) {
    const aggregateChange = applyAggregateDelta(plan, ctx, bank, amount, descriptorId);
    // A-B6: credited growth on a covered-class deposit is insured
    // liability growth in the same event.
    const insuredChange = applyInsuredLiabilityDelta(plan, ctx, {
      deposit,
      deltaRubars: amount,
      bank,
      ruleId: descriptorId,
    });
    pushMovementEntries(
      plan,
      ctx,
      descriptorId,
      [aggregateChange, ...(insuredChange ? [insuredChange] : [])],
      () =>
        `B-04 (credited): ${bank.corporationId}'s deposit liabilities rose by ${amount} R — the A-B1 pair of the credited claim growth on deposit ${deposit.depositId}. No cash moved.`
    );
  }
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "settle-deposit-interest",
    scope: "bank",
    cityId: bank.cityId,
    summaryText:
      amount > 0
        ? `Settled ${amount} R of interest on deposit ${deposit.depositId} as CREDITED claim at ${bank.corporationId} (B-04 credited branch): the depositor's claim grew by the formula amount; no cash moved; watermark now ${settlementSeq}.`
        : `Settled deposit ${deposit.depositId} (credited): no interest accrued; watermark advanced to ${settlementSeq}, no claim movement.`,
    classificationExtra: {
      settlement: {
        mode: "credited",
        depositId: deposit.depositId,
        amountRubars: amount,
        bridgeClass: "interest-capitalized",
      },
    },
  });
}

function depositTargetReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: DescriptorReadPlan["queries"] = [];
  if (typeof record.depositId === "string" && record.depositId) {
    paths.push(bankDepositPath(record.depositId));
  }
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId));
  }
  const depositor = parseLedgerRef(record.depositor);
  paths.push(...depositorReadPaths(depositor));
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// Descriptors + finance §2.4 metadata. The Lead registers
// FINANCE_DESCRIPTORS into RULE_DESCRIPTORS; FINANCE_DESCRIPTOR_META
// travels in parallel until the registry type grows the fields.
// ---------------------------------------------------------------------------

export const FINANCE_DESCRIPTORS: Record<string, RuleDescriptor> = {
  "F-01": {
    id: "F-01",
    actionKinds: ["open_member_account"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { open_member_account: openAccountHandler },
    readPlan: openAccountReadPlan,
    summary: "Open a personal account with the genesis grant (mint, finance §3.3 closed list); also the lazy step 0 of every money-touching action.",
  },
  "F-02": {
    id: "F-02",
    actionKinds: ["transfer_rubars"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { transfer_rubars: transferHandler },
    readPlan: transferReadPlan,
    summary: "Member-to-member transfer, transfer class, public — no covert money movement exists in v1.",
  },
  "F-03": {
    id: "F-03",
    actionKinds: ["fund_company"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { fund_company: fundCompanyHandler },
    readPlan: fundCompanyReadPlan,
    summary: "Fund a company with paid-in capital from the owner's personal account (personal-only source).",
  },
  "F-05": {
    id: "F-05",
    actionKinds: ["treasury_spend"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { treasury_spend: treasurySpendHandler },
    readPlan: treasurySpendReadPlan,
    summary: "Treasury spend, budget class (partial funding with logged shortfall); company payees reject citing F-10.",
  },
  "F-12": {
    id: "F-12",
    actionKinds: ["contribute_to_treasury"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { contribute_to_treasury: contributeHandler },
    readPlan: contributeReadPlan,
    summary: "Contribute to one's own city treasury (P4-K1): one-way personal -> treasury, transfer class, no reverse path.",
  },
  "B-01": {
    id: "B-01",
    actionKinds: ["charter_bank", "surrender_charter"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { charter_bank: charterBankHandler, surrender_charter: surrenderCharterHandler },
    readPlan: charterReadPlan,
    summary: "Charter a corporation as a bank (owner-only, min capital 100000 R, terms recorded verbatim) + surrender at zero live claims.",
  },
  "B-02": {
    id: "B-02",
    actionKinds: ["deposit_funds"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { deposit_funds: depositHandler },
    readPlan: depositReadPlan,
    summary: "Deposit funds into a chartered bank: cash line + deposit claim record + liability aggregate, in one event.",
  },
  "B-03": {
    id: "B-03",
    actionKinds: ["withdraw_deposit"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { withdraw_deposit: withdrawHandler },
    readPlan: depositTargetReadPlan,
    summary: "Withdraw deposit principal, custodial class against unencumbered cash, refused in full on shortfall.",
  },
  "B-04": {
    id: "B-04",
    actionKinds: ["settle_deposit_interest"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { settle_deposit_interest: settleInterestHandler },
    readPlan: depositTargetReadPlan,
    summary: "Settle deposit interest, cash-paid branch only (custodial); the credited branch is Phase 5.",
  },
};

export const FINANCE_DESCRIPTOR_META: Record<string, FinanceDescriptorMeta> = {
  "F-01": { shortfallClass: "transfer", ledgersTouched: ["personal"], invokesRules: [] },
  "F-02": { shortfallClass: "transfer", ledgersTouched: ["personal"], invokesRules: [] },
  "F-03": { shortfallClass: "transfer", ledgersTouched: ["personal", "company"], invokesRules: [] },
  "F-05": { shortfallClass: "budget", ledgersTouched: ["treasury", "exterior", "company"], invokesRules: [] },
  "F-12": { shortfallClass: "transfer", ledgersTouched: ["personal", "treasury"], invokesRules: [] },
  "B-01": { shortfallClass: "none", ledgersTouched: ["company"], invokesRules: [] },
  "B-02": { shortfallClass: "transfer", ledgersTouched: ["personal", "company", "treasury"], invokesRules: [] },
  "B-03": { shortfallClass: "custodial", ledgersTouched: ["company", "personal", "treasury"], invokesRules: [] },
  "B-04": { shortfallClass: "custodial", ledgersTouched: ["company", "personal", "treasury"], invokesRules: [] },
};
