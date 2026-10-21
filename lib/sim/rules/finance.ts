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
  type CollectionQuerySpec,
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
  bankBalanceSheet,
  bankBlockOf,
  bankCashRubars,
  buildBankCharterBlock,
  buildBankDepositDoc,
  buildSchedulePendingDraft,
  CHARTER_MIN_CAPITAL_RUBARS,
  COVERAGE_CAP_RUBARS,
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
  frozenClaimOf,
  fundingSourceOf,
  installmentDueSeq,
  installmentPrincipalAt,
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
  fundTargetBalanceRubars,
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
  deterministicSituationId,
  episodeSourceId,
  markSituationHandled,
  occasionSpecFromPending,
  planSituationUpsert,
  situationPath,
  type RipeningOccasionSpec,
  type SimSituation,
} from "../situations";
import { buildHoldingDoc, holdingPath, listingPath } from "../marketRecords";
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

/** Rows of a declared collection query (the structures/defensive
 * local idiom): the snapshot's materialized query record for the
 * id, its result docs read back from the snapshot's doc map.
 * Returns [] when the snapshot carries no such query — every
 * banking read plan in this file declares the queries its handler
 * consumes, and the harness exercises the real read-plan path, so
 * an absent query here is an assembly defect the tests catch, not
 * a runtime state to price in. */
function queryDocs(
  snapshot: SimSnapshot,
  queryId: string,
  collectionPath: string
): { path: string; doc: Record<string, unknown> }[] {
  const record = snapshot.queries.find(
    (q) => q.spec.id === queryId && q.spec.collectionPath === collectionPath
  );
  if (!record) return [];
  const out: { path: string; doc: Record<string, unknown> }[] = [];
  for (const path of record.resultPaths) {
    const doc = snapshotDoc(snapshot, path);
    if (doc) out.push({ path, doc });
  }
  return out;
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
function premiumQueries(bankCorporationId: string): CollectionQuerySpec[] {
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

function personalRef(memberId: string): LedgerRef {
  return { kind: "personal", memberId };
}

function treasuryRef(cityId: string): LedgerRef {
  return { kind: "treasury", cityId };
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
  for (const query of ctx.snapshot.queries) {
    if (!query.spec.id.startsWith("situationsByKey")) continue;
    for (const path of query.resultPaths) {
      const raw = snapshotDoc(ctx.snapshot, path);
      if (!raw) continue;
      const doc = raw as unknown as SimSituation;
      if (predicate(doc)) return doc;
    }
  }
  return null;
}

/** Mint or upsert one banking Situation inside the caller's plan,
 * from a producer-built doc (the situations module's builders
 * return docs; the upsert machinery consumes create inputs — the
 * conversion is field-for-field, and the doc's own dedupeKey is
 * what the standing card is matched by). Returns the record ids
 * the caller's entry claims (recordsCreated/recordsUpdated). */
/** Re-key a built card for a multi-card event: the dedupe
 * discipline keys a card by (source, kind, audience), and one
 * Resolution Event that mints several cards of a kind to one
 * audience (B-10's per-depositor D1s + per-borrower B6s) must give
 * each card its own source identity — the source resolution stays
 * in sourceResolutionId for traceability; sourceId gains the
 * per-card suffix. The pool-closing D2 re-keys with the SAME
 * suffix against the liquidation's resolution id, so it lands on
 * its D1's key and supersedes it exactly (addendum §1 D2). */
export function rekeyCard(doc: SimSituation, sourceIdSuffix: string): SimSituation {
  const sourceId = `${doc.source.sourceResolutionId ?? "res"}:${sourceIdSuffix}`;
  const dedupeKey = dedupeKeyFor({
    sourceKind: doc.source.kind,
    sourceId,
    situationKind: doc.kind,
    audienceKey: doc.audienceCityId ?? doc.cityId ?? doc.recipientUid,
  });
  return {
    ...doc,
    source: { ...doc.source, sourceId },
    dedupeKey,
    situationId: deterministicSituationId(dedupeKey, doc.source.sourceSeq),
  };
}

export function mintSituation(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  doc: SimSituation
): { created: string[]; updated: string[] } {
  const existing = findSituation(ctx, (d) => d.dedupeKey === doc.dedupeKey);
  const decision = planSituationUpsert(existing, {
    situationId: doc.situationId,
    cityId: doc.cityId,
    audienceCityId: doc.audienceCityId,
    audienceOwnerUidsSnapshot: doc.audienceOwnerUidsSnapshot,
    recipientUid: doc.recipientUid,
    kind: doc.kind,
    severity: doc.severity,
    title: doc.title,
    summary: doc.summary,
    detail: doc.detail,
    source: doc.source,
    createdSeq: doc.createdSeq,
    now: ctx.snapshot.now,
  });
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
export function situationKeyQueries(cityId: string): CollectionQuerySpec[] {
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
          detail: { bankCorporationId: corporationId, periodIndex: 0, premiumChain: true },
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
  const queries: CollectionQuerySpec[] = [];
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
  const queries: CollectionQuerySpec[] = [];
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

// ---------------------------------------------------------------------------
// Banking loans — shared machinery (B-05..B-11).
// ---------------------------------------------------------------------------

interface LoanTarget {
  loanPath: string;
  loan: BankLoanRecord;
  bank: BankTarget & { cityId: string; corporationId: string };
}

function parseLoanTarget(
  ctx: HandlerContext,
  descriptorId: string
): LoanTarget | ResolutionPlan {
  const loanId = stringField(ctx.action, "loanId");
  if (!loanId) {
    return rejectedPlan(descriptorId, "malformed-action", [descriptorId], `${descriptorId}: the action requires loanId.`);
  }
  const cityId = stringField(ctx.action, "cityId");
  const corporationId = stringField(ctx.action, "corporationId");
  if (!cityId || !corporationId) {
    return rejectedPlan(descriptorId, "malformed-action", [descriptorId], `${descriptorId}: the action requires cityId and corporationId naming the bank.`);
  }
  const loanPath = bankLoanPath(loanId);
  const loan = loanRecordOf(snapshotDoc(ctx.snapshot, loanPath));
  if (!loan) {
    return rejectedPlan(descriptorId, "loan-not-found", [descriptorId], `${descriptorId}: no loan record at ${loanPath}.`);
  }
  if (loan.bankCorporationId !== corporationId || loan.bankCityId !== cityId) {
    return rejectedPlan(descriptorId, "loan-bank-mismatch", [descriptorId], `${descriptorId}: loan ${loanId} names bank ${loan.bankCorporationId} in ${loan.bankCityId}; the action names ${corporationId} in ${cityId}. The stored record governs.`);
  }
  const corpPath = corporationPath(cityId, corporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  if (!corp) {
    return rejectedPlan(descriptorId, "corporation-not-found", [descriptorId], `${descriptorId}: no corporation record at ${corpPath}.`);
  }
  const bank = bankBlockOf(corp);
  if (!bank) {
    return rejectedPlan(descriptorId, "bank-not-chartered", [descriptorId], `${descriptorId}: ${corporationId} holds no bank charter block.`);
  }
  // A live loan needs a live charter; a pool-ASSIGNED loan acts on
  // a dissolved bank by design (its charter ended at liquidation)
  // — the pool verbs resolve the dead bank's records, never its
  // charter powers.
  if (bank.status !== "active" && loan.status !== "assigned") {
    return rejectedPlan(descriptorId, "bank-not-chartered", [descriptorId], `${descriptorId}: ${corporationId} holds no active bank charter.`);
  }
  return { loanPath, loan, bank: { corpPath, corp, bank, cityId, corporationId } };
}

/** Control of a borrower ref by the actor (the B-03 depositor
 * discipline, restated for borrowers): personal = the member;
 * company = its ownerMemberId; treasury = its governor. Returns a
 * rejection plan or null. */
function borrowerControlRejection(
  ctx: HandlerContext,
  descriptorId: string,
  borrower: LedgerRef
): ResolutionPlan | null {
  const actorId = actorMemberId(ctx.action.actor);
  if (borrower.kind === "personal") {
    if (actorId !== borrower.memberId) {
      return rejectedPlan(descriptorId, "not-borrower", [descriptorId], `${descriptorId}: a personal loan is acted on by its borrower.`);
    }
    return null;
  }
  if (borrower.kind === "company") {
    const corp = snapshotDoc(ctx.snapshot, corporationPath(borrower.cityId, borrower.corporationId));
    if (!corp || corp.ownerMemberId !== actorId) {
      return rejectedPlan(descriptorId, "not-borrower", [descriptorId], `${descriptorId}: a company loan is acted on by the borrower company's ownerMemberId.`);
    }
    return null;
  }
  if (borrower.kind === "treasury") {
    const authority = checkCityAuthority(ctx.snapshot, borrower.cityId, ctx.action.actor);
    if (!authority.ok) {
      return rejectedPlan(descriptorId, "not-borrower", [descriptorId], `${descriptorId}: a treasury loan is acted on by its governor: ${authority.reason}.`);
    }
    return null;
  }
  return rejectedPlan(descriptorId, "borrower-not-eligible", [descriptorId], `${descriptorId}: this ledger kind cannot borrow — loans run to members, companies, and treasuries, never the Market Account, the Exterior, or the fund (M6).`);
}

/** The member who controls a borrower ref for share pledges
 * (holdings are member-keyed): the member themselves, or the
 * borrower company's owner. Treasury borrowers hold no shares. */
function pledgorMemberId(
  ctx: HandlerContext,
  borrower: LedgerRef
): string | null {
  if (borrower.kind === "personal") return borrower.memberId;
  if (borrower.kind === "company") {
    const corp = snapshotDoc(ctx.snapshot, corporationPath(borrower.cityId, borrower.corporationId));
    return typeof corp?.ownerMemberId === "string" ? corp.ownerMemberId : null;
  }
  return null;
}

function parseCollateral(value: unknown): LoanCollateral | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c.kind === "none" || c.kind === undefined) return { kind: "none" };
  if (
    c.kind === "shares" &&
    typeof c.corporationId === "string" &&
    typeof c.cityId === "string" &&
    typeof c.quantityShares === "number" &&
    Number.isInteger(c.quantityShares) &&
    c.quantityShares > 0
  ) {
    return { kind: "shares", corporationId: c.corporationId, cityId: c.cityId, quantityShares: c.quantityShares };
  }
  if (c.kind === "structure" && typeof c.structureId === "string" && typeof c.cityId === "string") {
    return { kind: "structure", structureId: c.structureId, cityId: c.cityId };
  }
  return null;
}

function collateralEchoMatches(action: SimAction, loan: BankLoanRecord): boolean {
  const echo = parseCollateral(sa(action).collateral);
  if (!echo) return false;
  const stored = loan.collateral;
  if (echo.kind !== stored.kind) return false;
  if (echo.kind === "shares" && stored.kind === "shares") {
    return echo.corporationId === stored.corporationId && echo.quantityShares === stored.quantityShares;
  }
  if (echo.kind === "structure" && stored.kind === "structure") {
    return echo.structureId === stored.structureId;
  }
  return true;
}

/** Supersede a standing card in-event (the B-05 cancel discipline:
 * the card leaves the open queue as history, no successor card is
 * minted). Returns the situation path claimed, or null. */
export function supersedeSituationWhere(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  predicate: (doc: SimSituation) => boolean,
  args: { resolvedSeq: number; resolutionId: string }
): string | null {
  const doc = findSituation(ctx, (d) => d.status === "open" && predicate(d));
  if (!doc) return null;
  const superseded: SimSituation = {
    ...doc,
    status: "superseded",
    resolvedSeq: args.resolvedSeq,
    resolvedByResolutionId: args.resolutionId,
    updatedAt: new Date(ctx.snapshot.now),
  };
  planWrite(plan, ctx.snapshot, situationPath(doc.situationId), superseded as unknown as Record<string, unknown>, "state", [
    "status",
    "resolvedSeq",
    "resolvedByResolutionId",
    "updatedAt",
  ]);
  return situationPath(doc.situationId);
}

// ---------------------------------------------------------------------------
// B-05 — offer_loan / cancel_loan_offer (amendment §3.3). The offer
// is the bank owner's Tier B standing act: its terms are complete
// and recorded verbatim; acceptance (B-06) executes them. The
// branch (cash | credit) is stated HERE and may not switch later
// (V2-§2.1). Insider-ness is derived at offer and stored, so the
// cap and the Log never recompute it differently (§3.3).
// ---------------------------------------------------------------------------

function offerLoanHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-05";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const bank: BankTarget & { cityId: string; corporationId: string } = { ...bankOrPlan, cityId, corporationId };
  const ownerId = actorMemberId(ctx.action.actor);
  if (!ownerId || ownerId !== bank.corp.ownerMemberId) {
    return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], "B-05: a loan offer is the bank owner's act — offers are the charter's standing terms made specific, and only the owner states them.");
  }
  if (deriveBankHealth(bank.corp) === "insolvent") {
    return rejectedPlan(descriptorId, "bank-failed", [descriptorId], `B-05: ${corporationId} derives failed (insolvent, REC-6) — a failed bank makes no offers; its book resolves in liquidation.`);
  }
  const borrower = parseLedgerRef(sa(ctx.action).borrower);
  if (!borrower || borrower.kind === "market" || borrower.kind === "exterior" || borrower.kind === "institution") {
    return rejectedPlan(descriptorId, "borrower-not-eligible", [descriptorId], "B-05: the borrower must be a member, a company, or a treasury ledger — households (the Exterior), the Market Account, and the fund never borrow (M6).");
  }
  let borrowerCompanyOwner: string | null = null;
  if (borrower.kind === "company") {
    const borrowerCorp = snapshotDoc(ctx.snapshot, corporationPath(borrower.cityId, borrower.corporationId));
    if (!borrowerCorp) {
      return rejectedPlan(descriptorId, "borrower-not-found", [descriptorId], `B-05: no corporation record for borrower ${borrower.corporationId}.`);
    }
    borrowerCompanyOwner = typeof borrowerCorp.ownerMemberId === "string" ? borrowerCorp.ownerMemberId : null;
  }
  const principal = positiveAmount(ctx.action, "principalRubars");
  if (principal === null) {
    return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], "B-05: principalRubars must be a positive integer.");
  }
  const rate = sa(ctx.action).rateBpsPerKseq;
  if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0) {
    return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], "B-05: rateBpsPerKseq must be a non-negative integer stated in the confirmed action.");
  }
  if (rate > RATE_CAP_BPS_PER_KSEQ) {
    return rejectedPlan(descriptorId, "rate-above-cap", [descriptorId], `B-05: rate ${rate} exceeds the published hard cap of ${RATE_CAP_BPS_PER_KSEQ} bps per kseq (§4.4).`);
  }
  if (rate > bank.bank.loanRateCeilingBpsPerKseq) {
    return rejectedPlan(descriptorId, "rate-above-charter-ceiling", [descriptorId], `B-05: rate ${rate} exceeds ${corporationId}'s chartered loan-rate ceiling of ${bank.bank.loanRateCeilingBpsPerKseq} bps per kseq.`);
  }
  const fundingSource = sa(ctx.action).fundingSource === "credit" ? "credit" : "cash";
  let createdDepositRate: number | null = null;
  if (fundingSource === "credit") {
    const stated = sa(ctx.action).createdDepositRateBpsPerKseq;
    createdDepositRate = typeof stated === "number" && Number.isInteger(stated) && stated >= 0 ? stated : 0;
    if (createdDepositRate > bank.bank.depositRateCeilingBpsPerKseq) {
      return rejectedPlan(descriptorId, "created-rate-above-ceiling", [descriptorId], `B-05: the created deposit's rate ${createdDepositRate} exceeds ${corporationId}'s chartered deposit-rate ceiling of ${bank.bank.depositRateCeilingBpsPerKseq} bps per kseq — a created deposit is a deposit, and the ceiling binds it at offer (BNK-D14).`);
    }
  }
  const installmentCount = sa(ctx.action).installmentCount;
  const dueIntervalSeqs = sa(ctx.action).dueIntervalSeqs;
  const defaultMissedCount = sa(ctx.action).defaultMissedCount;
  for (const [label, value] of [
    ["installmentCount", installmentCount],
    ["dueIntervalSeqs", dueIntervalSeqs],
    ["defaultMissedCount", defaultMissedCount],
  ] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], `B-05: ${label} must be a positive integer — the schedule is a term of the offer, stated in full at preview (§3.1).`);
    }
  }
  const defaultRate = sa(ctx.action).defaultRateBpsPerKseq;
  if (defaultRate !== undefined && defaultRate !== null) {
    if (typeof defaultRate !== "number" || !Number.isInteger(defaultRate) || defaultRate < 0 || defaultRate > RATE_CAP_BPS_PER_KSEQ) {
      return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], "B-05: defaultRateBpsPerKseq, when stated, must be an integer within the published rate cap — no variable rates exist (M14).");
    }
  }
  const prepaymentFee = sa(ctx.action).prepaymentFeeRubars;
  if (prepaymentFee !== undefined && prepaymentFee !== null) {
    if (typeof prepaymentFee !== "number" || !Number.isInteger(prepaymentFee) || prepaymentFee < 0) {
      return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], "B-05: prepaymentFeeRubars, when stated, must be a non-negative integer.");
    }
  }
  const collateral = parseCollateral(sa(ctx.action).collateral ?? { kind: "none" });
  if (!collateral) {
    return rejectedPlan(descriptorId, "malformed-loan-terms", [descriptorId], "B-05: collateral must be { kind: \"none\" } | { kind: \"shares\", corporationId, cityId, quantityShares } | { kind: \"structure\", structureId, cityId }.");
  }
  if (collateral.kind === "shares" && borrower.kind === "treasury") {
    return rejectedPlan(descriptorId, "collateral-not-pledgeable", [descriptorId], "B-05: a treasury borrower holds no shares (holdings are member-keyed) — share collateral cannot be pledged for it. Offer structure collateral or none.");
  }
  if (collateral.kind === "structure") {
    // Structure ownership in this world is the corporation link
    // (linkedStructureIds) — the one ownership fact a pledge can
    // validate against. A structure pledge therefore requires a
    // company borrower whose corporation links the structure.
    if (borrower.kind !== "company") {
      return rejectedPlan(descriptorId, "collateral-not-pledgeable", [descriptorId], "B-05: structure collateral is pledgeable only by a company borrower whose corporation links the structure (linkedStructureIds is the world's structure-ownership record).");
    }
    const borrowerCorp = snapshotDoc(ctx.snapshot, corporationPath(borrower.cityId, borrower.corporationId));
    const linked = (borrowerCorp?.linkedStructureIds as unknown[] | undefined) ?? [];
    if (!linked.includes(collateral.structureId)) {
      return rejectedPlan(descriptorId, "collateral-not-pledgeable", [descriptorId], `B-05: structure ${collateral.structureId} is not linked to borrower ${borrower.corporationId} — a bank can only take a lien on what the record shows the borrower owns.`);
    }
  }
  const insider = isInsiderBorrower({
    borrower,
    bankOwnerMemberId: ownerId,
    bankCorporationId: corporationId,
    borrowerCompanyOwnerMemberId: borrowerCompanyOwner,
  });

  const plan = emptyPlan(descriptorId);
  const loanId = `loan_${ctx.resolutionId}`;
  const loanPath = bankLoanPath(loanId);
  const recordSeq = nextEntrySeq(ctx.snapshot, plan);
  const summarySeq = recordSeq + 1;
  const doc = buildLoanOfferDoc({
    loanId,
    bankCorporationId: corporationId,
    bankCityId: cityId,
    borrower,
    principalRubars: principal,
    fundingSource,
    rateBpsPerKseq: rate,
    createdDepositRateBpsPerKseq: createdDepositRate,
    defaultRateBpsPerKseq: typeof defaultRate === "number" ? defaultRate : null,
    prepaymentFeeRubars: typeof prepaymentFee === "number" ? prepaymentFee : null,
    installmentCount: installmentCount as number,
    dueIntervalSeqs: dueIntervalSeqs as number,
    defaultMissedCount: defaultMissedCount as number,
    collateral,
    insider,
    offerResolutionId: ctx.resolutionId,
    offeredAtSeq: summarySeq,
  });
  planWrite(plan, ctx.snapshot, loanPath, doc, "state", [
    "status",
    "principalRubars",
    "rateBpsPerKseq",
    "fundingSource",
    "collateral",
    "insider",
  ]);
  // B1: the borrower's proposal card (Pattern E) — minted before
  // the record entry pushes so the entry claims its records.
  const addressing = situationAddressingFor(ctx.snapshot, borrower, cityId);
  const card = mintSituation(
    plan,
    ctx,
    buildProposalSituation({
      cityId,
      audienceCityId: cityId,
      audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
      recipientUid: addressing.recipientUid ?? null,
      severity: "routine",
      createdSeq: summarySeq,
      now: ctx.snapshot.now,
      sourceSeq: summarySeq,
      sourceResolutionId: ctx.resolutionId,
      sourceKind: "log",
      sourceId: ctx.resolutionId,
      title: `Loan offer from ${corporationId}`,
      summary: `${corporationId} offers ${ledgerLabel(borrower)} a ${fundingSource}-funded loan of ${principal} R at ${rate} bps/kseq over ${String(installmentCount)} installments. Accepting (B-06) funds it on these exact terms; the offer rests until accepted or cancelled.`,
      counterpartyCityId: cityId,
      amountRubars: principal,
      tags: ["loan-offer"],
      ruleIds: ["B-05", "B-06"],
      classes: ["Tier B"],
      proposalRef: loanId,
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`bankLoans/${loanId}.status`, null, "offered", "B-05 loan offer — the record is born offered; funding (B-06) is a separate event"),
        fieldChange(`bankLoans/${loanId}.principalRubars`, null, principal, "B-05 offered principal"),
        fieldChange(`bankLoans/${loanId}.rateBpsPerKseq`, null, rate, "B-05 offered rate"),
        fieldChange(`bankLoans/${loanId}.fundingSource`, null, fundingSource, "B-05 funding branch, stated at offer and unswitchable (V2-§2.1)"),
      ],
      recordsCreated: [loanPath, ...card.created],
      recordsUpdated: card.updated,
      summaryText: `B-05: ${corporationId} offers a ${fundingSource}-funded loan of ${principal} R to ${ledgerLabel(borrower)} at ${rate} bps/kseq — ${String(installmentCount)} installments every ${String(dueIntervalSeqs)} seqs, default at ${String(defaultMissedCount)} missed${insider ? "; INSIDER loan (derived at offer, §3.3)" : ""}. The offer rests until accepted (B-06) or cancelled; resting offers never expire.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "offer-loan",
    scope: "bank",
    cityId,
    summaryText: `Offered a ${fundingSource}-funded loan of ${principal} R from ${corporationId} to ${ledgerLabel(borrower)} at ${rate} bps/kseq (loan ${loanId})${insider ? " — insider loan, derived and recorded" : ""}. The borrower's proposal card stands in their Situations.`,
    classificationExtra: {
      loan: { loanId, fundingSource, insider, principalRubars: principal },
    },
  });
}

function cancelLoanOfferHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-05";
  const targetOrPlan = parseLoanTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { loanPath, loan, bank } = targetOrPlan;
  if (loan.status !== "offered") {
    return rejectedPlan(descriptorId, "loan-not-offered", [descriptorId], `B-05: loan ${loan.loanId} is ${loan.status}; only a resting offer can be cancelled.`);
  }
  const actorId = actorMemberId(ctx.action.actor);
  const isBankOwner = actorId !== null && actorId === bank.corp.ownerMemberId;
  if (!isBankOwner) {
    const control = borrowerControlRejection(ctx, descriptorId, loan.borrower);
    if (control) {
      return rejectedPlan(descriptorId, "not-offer-party", [descriptorId], "B-05: a resting offer is cancelled by the bank's owner (withdrawal) or by the borrower (decline) — no one else.");
    }
  }
  const plan = emptyPlan(descriptorId);
  planMutate(plan, ctx.snapshot, loanPath, "state", ["status"], (current) =>
    current ? { ...current, status: "cancelled" } : current
  );
  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + 2;
  const supersededCard = supersedeSituationWhere(
    plan,
    ctx,
    (doc) => doc.kind === "proposal" && doc.detail?.proposalRef === loan.loanId,
    { resolvedSeq: summarySeq, resolutionId: ctx.resolutionId }
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`bankLoans/${loan.loanId}.status`, "offered", "cancelled", "B-05 cancel — the offer is withdrawn/declined before funding; nothing was disbursed and nothing is owed"),
      ],
      recordsUpdated: [loanPath, ...(supersededCard ? [supersededCard] : [])],
      summaryText: `B-05: loan offer ${loan.loanId} (${loan.principalRubars} R from ${bank.corporationId} to ${ledgerLabel(loan.borrower)}) cancelled by ${isBankOwner ? "the bank's owner" : "the borrower"}. The borrower's proposal card is superseded in this event.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "cancel-loan-offer",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: `Cancelled the resting loan offer ${loan.loanId} (${loan.principalRubars} R). No money moved; the offer never funded.`,
    classificationExtra: { loan: { loanId: loan.loanId, cancelled: true } },
  });
}

// ---------------------------------------------------------------------------
// B-06 — accept_loan (amendment §3.2): the borrower accepts the
// resting offer and the loan FUNDS in this event. Funding
// revalidates everything at the funding snapshot — terms frozen at
// offer, position read fresh: an offer that can no longer lawfully
// fund rejects IN FULL and the offer rests (it is never silently
// amended). The branch is the offer's own (fundingSource), never
// the acceptance's choice. Tier B by construction: the stage
// refuses NPC acceptances categorically (addendum §2, gate A-8).
// ---------------------------------------------------------------------------

function acceptLoanHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-06";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const targetOrPlan = parseLoanTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { loanPath, loan, bank } = targetOrPlan;
  if (loan.status !== "offered") {
    return rejectedPlan(descriptorId, "loan-not-offered", [descriptorId], `B-06: loan ${loan.loanId} is ${loan.status}; only a resting offer can be accepted.`);
  }
  // The acceptance names the borrower + collateral as read-plan
  // echoes (the B-03 depositor discipline): the stored record
  // governs, and a mismatch refuses rather than redirects.
  const namedBorrower = parseLedgerRef(sa(ctx.action).borrower);
  if (!namedBorrower || !ledgerRefsEqual(namedBorrower, loan.borrower)) {
    return rejectedPlan(descriptorId, "borrower-mismatch", [descriptorId], "B-06: the action's borrower ref does not match the loan record's borrower. The stored record governs.");
  }
  if (!collateralEchoMatches(ctx.action, loan)) {
    return rejectedPlan(descriptorId, "collateral-mismatch", [descriptorId], "B-06: the action's collateral echo does not match the offer's recorded collateral. The stored record governs.");
  }
  const control = borrowerControlRejection(ctx, descriptorId, loan.borrower);
  if (control) return control;
  if (deriveBankHealth(bank.corp) === "insolvent") {
    return rejectedPlan(descriptorId, "bank-failed", [descriptorId], `B-06: ${bank.corporationId} derives failed (insolvent, REC-6) — its offers cannot fund; the book resolves in liquidation. The offer rests.`);
  }

  const principal = loan.principalRubars;
  const branch = fundingSourceOf(loan);

  // -- Collateral pledge validation (both branches; §3.2 step 2) --
  const pledgor = pledgorMemberId(ctx, loan.borrower);
  let pledgeHoldingPath: string | null = null;
  let pledgeHoldingDoc: Record<string, unknown> | null = null;
  let structurePathForLien: string | null = null;
  if (loan.collateral.kind === "shares") {
    const sharesCollateral = loan.collateral;
    if (!pledgor) {
      return rejectedPlan(descriptorId, "collateral-unavailable", [descriptorId], "B-06: the borrower controls no member holding to pledge shares from.");
    }
    const row = queryDocs(ctx.snapshot, "pledgeHoldings", "sim_holdings").find(
      ({ doc }) => doc.memberId === pledgor && doc.corporationId === sharesCollateral.corporationId
    );
    pledgeHoldingDoc = row?.doc ?? null;
    pledgeHoldingPath = row?.path ?? null;
    const quantity = typeof pledgeHoldingDoc?.quantityShares === "number" ? pledgeHoldingDoc.quantityShares : 0;
    const committed = typeof pledgeHoldingDoc?.committedShares === "number" ? pledgeHoldingDoc.committedShares : 0;
    const pledged = typeof pledgeHoldingDoc?.pledgedShares === "number" ? pledgeHoldingDoc.pledgedShares : 0;
    const free = quantity - committed - pledged;
    if (!pledgeHoldingDoc || free < sharesCollateral.quantityShares) {
      return rejectedPlan(descriptorId, "insufficient-free-shares", [descriptorId], `B-06: the pledgor holds ${free} free shares of ${sharesCollateral.corporationId} (quantity ${quantity} − committed ${committed} − already pledged ${pledged}); the offer pledges ${sharesCollateral.quantityShares}. Funding rejects in full and the offer rests.`);
    }
  }
  if (loan.collateral.kind === "structure") {
    const { structureId, cityId: structureCityId } = loan.collateral;
    structurePathForLien = `sim_cities/${structureCityId}/structures/${structureId}`;
    const structure = snapshotDoc(ctx.snapshot, structurePathForLien);
    if (!structure) {
      return rejectedPlan(descriptorId, "collateral-unavailable", [descriptorId], `B-06: no structure record at ${structurePathForLien} to take a lien on. The offer rests.`);
    }
    if (structure.bankLien) {
      return rejectedPlan(descriptorId, "collateral-encumbered", [descriptorId], `B-06: structure ${structureId} already carries a bank lien — one lien per structure. The offer rests.`);
    }
    if (loan.borrower.kind === "company") {
      const borrowerCorp = snapshotDoc(ctx.snapshot, corporationPath(loan.borrower.cityId, loan.borrower.corporationId));
      const linked = (borrowerCorp?.linkedStructureIds as unknown[] | undefined) ?? [];
      if (!linked.includes(structureId)) {
        return rejectedPlan(descriptorId, "collateral-not-pledgeable", [descriptorId], `B-06: structure ${structureId} is no longer linked to borrower ${loan.borrower.corporationId} at funding — the pledge fails validation and the offer rests.`);
      }
    }
  }

  const plan = emptyPlan(descriptorId);
  if (loan.borrower.kind === "personal") {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: loan.borrower.memberId, viaActionKind: "accept_loan" });
  }
  // Entry seqs that depend only on the entries already planned:
  // the loan record entry is next, the created-deposit entry (credit
  // branch) follows it. The summary seq is computed once every
  // tagged change exists (below).
  const loanEntrySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + 1;
  const depositEntrySeq = loanEntrySeq + 1;

  // -- Branch funding validations + money/record writes (§3.2) ----
  const tagged: TaggedChange[] = [];
  let createdDeposit: BankDepositRecord | null = null;
  let createdDepositPath: string | null = null;
  if (branch === "cash") {
    const bankDocNow = plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? bank.corp;
    const lendable = Math.max(0, bankCashRubars(bankDocNow) - liquidReserveRubars(bankDocNow));
    if (principal > lendable) {
      return rejectedPlan(descriptorId, "insufficient-lendable-cash", [descriptorId], `B-06: cash funding of ${principal} R exceeds ${bank.corporationId}'s lendable cash of ${lendable} R (cash minus liquid reserve, §3.2). Funding rejects in full; the offer rests.`);
    }
    const line: TransferLine = {
      from: corporationRef(bank.cityId, bank.corporationId),
      to: loan.borrower,
      amountRubars: principal,
      ruleId: descriptorId,
      memo: `loan disbursement for ${loan.loanId}`,
      surface: "reserve",
    };
    const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
    if (!applied.ok) {
      return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `B-06: disbursement refused: ${applied.message} The offer rests.`);
    }
    tagged.push(...applied.changes);
  } else {
    // Credit branch: validate the POST-funding position (the
    // Appendix A pair lands first in the plan, then the tests read
    // the planned sheet — V-B7's preview parity is this same
    // computation).
    tagged.push(applyBankAggregateDelta(plan, ctx, bank, "loanBookRubars", principal, descriptorId));
    if (loan.insider) {
      tagged.push(applyBankAggregateDelta(plan, ctx, bank, "insiderLoansRubars", principal, descriptorId));
    }
    tagged.push(applyAggregateDelta(plan, ctx, bank, principal, descriptorId));
    const sheet = bankBalanceSheet(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {});
    if (!sheet) {
      return rejectedPlan(descriptorId, "bank-not-chartered", [descriptorId], "B-06: the bank's charter block vanished mid-plan — refusing rather than pricing a creation against no charter.");
    }
    if (sheet.cashRubars < sheet.liquidReserveRubars) {
      return rejectedPlan(descriptorId, "creation-reserve-shortfall", [descriptorId], `B-06: credit funding of ${principal} R would leave ${bank.corporationId} with cash ${sheet.cashRubars} R against a liquid reserve of ${sheet.liquidReserveRubars} R over TOTAL post-funding liabilities (V2-§2.4) — creation is lawful only inside the published tests. The offer rests.`);
    }
    if (sheet.netWorthRubars * 10_000 < EQUITY_FLOOR_BPS * sheet.totalAssetsRubars) {
      return rejectedPlan(descriptorId, "creation-capital-floor", [descriptorId], `B-06: credit funding of ${principal} R would leave ${bank.corporationId}'s net worth at ${sheet.netWorthRubars} R against total recognized assets of ${sheet.totalAssetsRubars} R — below the ${EQUITY_FLOOR_BPS} bps equity floor over TOTAL RECOGNIZED ASSETS (REC-1). The offer rests.`);
    }
    if (loan.insider) {
      const insiderAfter = bank.bank.insiderLoansRubars + principal;
      if (insiderAfter * 10_000 > INSIDER_CAP_BPS * sheet.netWorthRubars) {
        return rejectedPlan(descriptorId, "insider-cap-exceeded", [descriptorId], `B-06: insider funding would take insider outstanding to ${insiderAfter} R against post-funding net worth ${sheet.netWorthRubars} R — above the ${INSIDER_CAP_BPS} bps insider cap (BNK-D3). The offer rests.`);
      }
    }
    // The paired deposit (Appendix A): born in this same event,
    // through the shared deposit builder (guardrail 2).
    const depositId = `dep_${ctx.resolutionId}`;
    createdDepositPath = bankDepositPath(depositId);
    const doc = buildBankDepositDoc({
      depositId,
      bankCorporationId: bank.corporationId,
      bankCityId: bank.cityId,
      depositor: loan.borrower,
      principalRubars: principal,
      rateBpsPerKseq: loan.createdDepositRateBpsPerKseq ?? 0,
      openedAtSeq: depositEntrySeq,
      openingEntryId: logEntryPath(depositEntrySeq),
      origin: "credit-created",
      fundingLoanId: loan.loanId,
    });
    createdDeposit = depositRecordOf(doc);
    planWrite(plan, ctx.snapshot, createdDepositPath, doc, "state", [
      "principalRubars",
      "creditedInterestRubars",
      "status",
      "rateBpsPerKseq",
      "origin",
      "fundingLoanId",
    ]);
    // A-B6: the created deposit is insured-liability growth when
    // covered-class (created deposits are in the premium base,
    // V2-§2.7).
    const insuredChange = applyInsuredLiabilityDelta(plan, ctx, {
      deposit: createdDeposit as BankDepositRecord,
      deltaRubars: principal,
      bank,
      ruleId: descriptorId,
    });
    if (insuredChange) tagged.push(insuredChange);
  }
  if (branch === "cash" && loan.insider) {
    // The insider cap binds cash funding identically (§3.3 reads
    // outstanding, not branch): post-funding net worth falls by
    // nothing in a cash loan (asset swaps cash for book), so the
    // test reads the standing sheet.
    const sheet = bankBalanceSheet(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {});
    if (!sheet) {
      return rejectedPlan(descriptorId, "bank-not-chartered", [descriptorId], "B-06: the bank's charter block vanished mid-plan — refusing.");
    }
    const insiderAfter = bank.bank.insiderLoansRubars + principal;
    if (insiderAfter * 10_000 > INSIDER_CAP_BPS * sheet.netWorthRubars) {
      return rejectedPlan(descriptorId, "insider-cap-exceeded", [descriptorId], `B-06: insider funding would take insider outstanding to ${insiderAfter} R against net worth ${sheet.netWorthRubars} R — above the ${INSIDER_CAP_BPS} bps insider cap (BNK-D3). The offer rests.`);
    }
    tagged.push(applyBankAggregateDelta(plan, ctx, bank, "insiderLoansRubars", principal, descriptorId));
  }
  if (branch === "cash") {
    tagged.push(applyBankAggregateDelta(plan, ctx, bank, "loanBookRubars", principal, descriptorId));
  }

  // -- Pledge commits ----------------------------------------------
  const pledgeChanges: SimChange[] = [];
  if (loan.collateral.kind === "shares" && pledgeHoldingPath && pledgeHoldingDoc) {
    const sharesCollateral = loan.collateral;
    const before = typeof pledgeHoldingDoc.pledgedShares === "number" ? pledgeHoldingDoc.pledgedShares : 0;
    const holdingIdStr = `${pledgor}__${sharesCollateral.corporationId}`;
    planMutate(plan, ctx.snapshot, pledgeHoldingPath, "state", ["pledgedShares"], (current) =>
      current ? { ...current, pledgedShares: before + sharesCollateral.quantityShares } : current
    );
    pledgeChanges.push(
      fieldChange(`holdings/${holdingIdStr}.pledgedShares`, before, before + sharesCollateral.quantityShares, "B-06 pledge — the shares are committed to the loan; freeShares reads quantity − committed − pledged")
    );
  }
  if (loan.collateral.kind === "structure" && structurePathForLien) {
    planMutate(plan, ctx.snapshot, structurePathForLien, "state", ["bankLien"], (current) =>
      current
        ? {
            ...current,
            bankLien: { bankCorporationId: bank.corporationId, loanId: loan.loanId, markedAtSeq: null },
          }
        : current
    );
    pledgeChanges.push(
      fieldChange(`structures/${loan.collateral.structureId}.bankLien`, null, { bankCorporationId: bank.corporationId, loanId: loan.loanId }, "B-06 lien — marked on the structure at funding (§3.2)")
    );
  }

  // -- Entry seq arithmetic -----------------------------------------
  // Entries to come: loan record (1) + created-deposit record
  // (credit only, 1) + movement groups + summary (1). The loan
  // activates AS OF the funding event's summary seq
  // (originatedAtSeq), the anchor every installment requiredSeq
  // derives from.
  const movementGroups = groupChangesByEntryCity(tagged).size;
  const summarySeq = loanEntrySeq + (branch === "credit" ? 1 : 0) + movementGroups + 1;
  const originatedAtSeq = summarySeq;
  const installmentPrincipal = installmentPrincipalOf(principal, loan.installmentCount);
  const firstDueSeq = originatedAtSeq + loan.dueIntervalSeqs;

  // -- Loan activation write ----------------------------------------
  const fundingChanges: SimChange[] = [
    fieldChange(`bankLoans/${loan.loanId}.status`, "offered", "active", "B-06 funding — the loan activates"),
    fieldChange(`bankLoans/${loan.loanId}.originatedAtSeq`, null, originatedAtSeq, "B-06 — the funding event's seq (schedule anchor)"),
    fieldChange(`bankLoans/${loan.loanId}.installmentPrincipalRubars`, null, installmentPrincipal, "B-06 — derived per-installment principal (final installment takes the remainder)"),
    fieldChange(`bankLoans/${loan.loanId}.nextDueSeq`, null, firstDueSeq, "B-06 — first installment due seq"),
    fieldChange(`bankLoans/${loan.loanId}.lastSettledSeq`, null, originatedAtSeq, "B-06 — interest watermark opens at funding (§3.6)"),
  ];
  if (branch === "cash") {
    fundingChanges.push(fieldChange(`bankLoans/${loan.loanId}.proceedsLedger`, null, loan.borrower, "B-06 — proceeds paid to the borrower's ledger"));
  }
  planMutate(plan, ctx.snapshot, loanPath, "state", ["status", "originatedAtSeq", "installmentPrincipalRubars", "nextDueSeq", "lastSettledSeq", "proceedsLedger", "proceedsDepositId"], (current) => {
    if (!current) return current;
    return {
      ...current,
      status: "active",
      originatedAtSeq,
      installmentPrincipalRubars: installmentPrincipal,
      nextDueSeq: firstDueSeq,
      lastSettledSeq: originatedAtSeq,
      ...(branch === "cash" ? { proceedsLedger: loan.borrower } : {}),
    };
  });

  // -- Credit branch: link the loan to its paired deposit ----------
  // (The deposit doc itself was written in the branch block above,
  // where its insured-liability pair could join the tagged changes
  // before the movement-group count fixed the summary seq.)
  if (branch === "credit" && createdDeposit) {
    planMutate(plan, ctx.snapshot, loanPath, "state", ["proceedsDepositId"], (current) =>
      current ? { ...current, proceedsDepositId: (createdDeposit as BankDepositRecord).depositId } : current
    );
    fundingChanges.push(fieldChange(`bankLoans/${loan.loanId}.proceedsDepositId`, null, createdDeposit.depositId, "B-06 — the created deposit issued as proceeds (the Appendix A pair)"));
  }

  // -- Schedule pendings (§3.4) --------------------------------------
  const addressing = situationAddressingFor(ctx.snapshot, loan.borrower, bank.cityId);
  for (let k = 1; k <= loan.installmentCount; k += 1) {
    const pendingId = `inst_${loan.loanId}_${k}`;
    const dueSeq = originatedAtSeq + k * loan.dueIntervalSeqs;
    const draft = buildSchedulePendingDraft(ctx.snapshot, {
      pendingId,
      kind: "loan-installment-due",
      originResolutionId: ctx.resolutionId,
      originActionId: ctx.action.actionId,
      originActor: ctx.action.actor,
      originCityId: bank.cityId,
      originSummaryText: `Installment ${k} of loan ${loan.loanId}`,
      targetCityId: bank.cityId,
      sourceKind: "action",
      generation: 1,
      chainId: loan.loanId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      minSeqAdvance: k * loan.dueIntervalSeqs,
      scheduleDerivation: {
        loanId: loan.loanId,
        installmentIndex: k,
        originatedAtSeq,
        dueIntervalSeqs: loan.dueIntervalSeqs,
        dueSeq,
      },
      payloadSpec: {
        schedule: {
          kind: "loan-installment",
          loanId: loan.loanId,
          bankCorporationId: bank.corporationId,
          bankCityId: bank.cityId,
          installmentIndex: k,
        },
        occasion: {
          kind: "loan-installment-due",
          severity: "routine",
          title: `Installment ${k} due — loan ${loan.loanId}`,
          summary: `Installment ${k} of ${loan.installmentCount} on the ${principal} R loan from ${bank.corporationId} falls due at seq ${dueSeq}. Repayment (B-07) is the borrower's act; nothing auto-debits.`,
          detail: {
            loanId: loan.loanId,
            bankCorporationId: bank.corporationId,
            installmentIndex: k,
            dueSeq,
          },
          cityId: bank.cityId,
          audienceCityId: addressing.audienceCityId,
          recipientUid: addressing.recipientUid ?? null,
        } satisfies RipeningOccasionSpec,
      },
    });
    plan.pendingCreates.push(draft.draft);
    plan.readRefKeys.push(`pending:${pendingId}`);
  }

  // -- Entries --------------------------------------------------------
  const closedCard = closeSituationWhere(
    plan,
    ctx,
    (doc) => doc.kind === "proposal" && doc.detail?.proposalRef === loan.loanId,
    { resolvedSeq: summarySeq, resolutionId: ctx.resolutionId }
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [...fundingChanges, ...pledgeChanges],
      recordsCreated: [],
      recordsUpdated: [loanPath, ...(closedCard ? [closedCard] : [])],
      summaryText: `B-06: loan ${loan.loanId} funded (${branch} branch) — ${principal} R at ${loan.rateBpsPerKseq} bps/kseq, ${loan.installmentCount} installments of ${installmentPrincipal} R every ${loan.dueIntervalSeqs} seqs from seq ${firstDueSeq}; payoff at funding = principal ${principal} R plus interest as it accrues (§4.1).${loan.insider ? " Insider loan — the cap was tested against post-funding net worth." : ""} The borrower's offer card is handled in this event.`,
    })
  );
  if (branch === "credit" && createdDeposit && createdDepositPath) {
    plan.entries.push(
      ruleEffectDraft({
        actor: ctx.action.actor,
        cityId: null,
        cityIds: [],
        ruleIds: [descriptorId],
        changes: [
          fieldChange(`bankDeposits/${createdDeposit.depositId}.principalRubars`, null, principal, "B-06 credit creation — the deposit claim issued as loan proceeds (Appendix A pair: ΔAssets = ΔLiabilities = principal, ΔCash = 0)"),
          fieldChange(`bankDeposits/${createdDeposit.depositId}.origin`, null, "credit-created", "B-06 — provenance: credit-created (the claim bridge's classification)"),
          fieldChange(`bankDeposits/${createdDeposit.depositId}.fundingLoanId`, null, loan.loanId, "B-06 — the backing loan (A-B4's pair, A-B5's group)"),
          fieldChange(`bankDeposits/${createdDeposit.depositId}.status`, null, "active", "B-06 — status"),
        ],
        recordsCreated: [createdDepositPath],
        summaryText: `B-06: deposit ${createdDeposit.depositId} created as the proceeds of loan ${loan.loanId} — a claim of ${principal} R against ${bank.corporationId} at ${loan.createdDepositRateBpsPerKseq ?? 0} bps/kseq, issued by paired posting with the loan asset. No cash moved; the bank's balance sheet grew on both sides by exactly the principal.`,
      })
    );
  }
  pushMovementEntries(plan, ctx, descriptorId, tagged, (entryCityId) =>
    entryCityId === bank.cityId
      ? branch === "cash"
        ? `B-06: ${bank.corporationId} disbursed ${principal} R to ${ledgerLabel(loan.borrower)}; its loan book rose by the same figure (the cash↔book asset swap). Lendable cash after: ${Math.max(0, bankCashRubars(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {}) - liquidReserveRubars(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {}))} R.`
        : `B-06: ${bank.corporationId}'s loan book and deposit liabilities each rose by ${principal} R (the Appendix A pair); cash unchanged. Created supply now includes this ${principal} R claim (a labeled derivation, never a stored figure).`
      : `B-06: ${ledgerLabel(loan.borrower)} received ${principal} R of loan proceeds from ${bank.corporationId}.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "accept-loan",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: `Funded loan ${loan.loanId}: ${principal} R from ${bank.corporationId} to ${ledgerLabel(loan.borrower)} (${branch} branch) at ${loan.rateBpsPerKseq} bps/kseq — ${loan.installmentCount} installments, first due seq ${firstDueSeq}. ${loan.installmentCount} installment pendings scheduled.`,
    major: true,
    classificationExtra: {
      loan: { loanId: loan.loanId, fundingMode: branch === "credit" ? "credit-created" : "cash-funded", principalRubars: principal },
    },
  });
}

function acceptLoanReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId), ...situationKeyQueries(record.cityId));
  }
  if (typeof record.loanId === "string" && record.loanId) {
    paths.push(bankLoanPath(record.loanId));
  }
  const borrower = parseLedgerRef(record.borrower);
  if (borrower?.kind === "company") {
    paths.push(corporationPath(borrower.cityId, borrower.corporationId));
  }
  if (borrower?.kind === "treasury") {
    paths.push(cityPath(borrower.cityId), `factions/${borrower.cityId}`);
  }
  if (borrower?.kind === "personal") {
    paths.push(memberAccountPath(borrower.memberId));
  }
  const collateral = parseCollateral(record.collateral);
  if (collateral?.kind === "shares") {
    queries.push({
      id: "pledgeHoldings",
      collectionPath: "sim_holdings",
      filters: [{ field: "corporationId", op: "==", value: collateral.corporationId }],
    });
  }
  if (collateral?.kind === "structure") {
    paths.push(`sim_cities/${collateral.cityId}/structures/${collateral.structureId}`);
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// Pool closing (§5.6) — shared by the pool-form verbs. The book is
// exhausted when nothing remains to collect (every assigned loan
// at zero) or when every claim stands whole (nothing remains to
// pay). At closing: each deposit's unpaid remainder is its
// realized loss (writtenDownRubars stamped on credit-created
// records — A-B5's bookkeeping; the figure itself derives from the
// liquidation block for every class), records close, loans with
// forgone outstanding are stamped poolClosed, and each depositor's
// D1 card is superseded by their D2 pool-closing card.
// ---------------------------------------------------------------------------

interface PoolClosingResult {
  closed: boolean;
  realizedLossRubars: number;
  situationClaims: { created: string[]; updated: string[] };
}

function maybeClosePool(
  plan: ResolutionPlan,
  ctx: HandlerContext,
  args: {
    bank: BankTarget & { cityId: string; corporationId: string };
    deposits: BankDepositRecord[]; // PLANNED views of the bank's deposits
    loans: BankLoanRecord[]; // PLANNED views of the bank's loans
    summarySeq: number;
    ruleId: string;
  }
): PoolClosingResult {
  const none: PoolClosingResult = { closed: false, realizedLossRubars: 0, situationClaims: { created: [], updated: [] } };
  const assignedDeposits = args.deposits.filter((d) => d.status === "assigned");
  if (assignedDeposits.length === 0) return none;
  const assignedLoans = args.loans.filter((l) => l.status === "assigned");
  const loansExhausted = assignedLoans.every((l) => l.outstandingRubars <= 0);
  const claimsWhole = assignedDeposits.every((d) => poolUnpaidRubars(d) <= 0);
  if (!loansExhausted && !claimsWhole) return none;

  let realizedLoss = 0;
  const claims = { created: [] as string[], updated: [] as string[] };
  // The final dust figure (§5.6): whatever integer-floor remainders
  // accumulated in the dissolved bank's frozen cash record over the
  // pool's life — the planned view, so this event's own dust (a
  // closing B-07/B-08 distribution) is already inside it.
  const frozenCash = plannedDoc(plan, ctx.snapshot, args.bank.corpPath);
  const finalDustRubars =
    typeof frozenCash?.companyCashRubars === "number" ? frozenCash.companyCashRubars : 0;
  for (const deposit of assignedDeposits) {
    const unpaid = poolUnpaidRubars(deposit);
    realizedLoss += unpaid;
    const depositPath = bankDepositPath(deposit.depositId);
    planMutate(plan, ctx.snapshot, depositPath, "state", ["status", "writtenDownRubars"], (current) => {
      if (!current) return current;
      const written = typeof current.writtenDownRubars === "number" ? current.writtenDownRubars : 0;
      return { ...current, status: "closed", writtenDownRubars: written + unpaid };
    });
    // D2 supersedes D1 (same dedupe key: the liquidation's source).
    const block = deposit.liquidation;
    if (block) {
      const addressing = situationAddressingFor(ctx.snapshot, deposit.depositor, args.bank.cityId);
      const recovered =
        block.frozenClaimRubars - block.setoffRubars - unpaid;
      const card = mintSituation(
        plan,
        ctx,
        rekeyCard(buildIncidentSituation({
          cityId: args.bank.cityId,
          audienceCityId: args.bank.cityId,
          audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
          recipientUid: addressing.recipientUid ?? null,
          severity: "important",
          createdSeq: args.summarySeq,
          now: ctx.snapshot.now,
          sourceSeq: args.summarySeq,
          sourceResolutionId: block.liquidationResolutionId,
          title: `Depositor pool closed — ${args.bank.corporationId}`,
          summary: `The depositor pool of the dissolved ${args.bank.corporationId} is exhausted and closes. Your frozen claim was ${block.frozenClaimRubars} R; total recovered ${recovered} R; realized loss ${unpaid} R.`,
          consequenceSummary: `Pool closed: recovered ${recovered} R of your ${block.frozenClaimRubars} R frozen claim (estate ${block.estatePaidRubars} R, fund ${block.fundPaidRubars} R, pool distributions ${block.poolDistributedRubars} R); realized loss ${unpaid} R is written down on the record. The fund's final recovery on your claim was ${block.fundRecoveredRubars} R of its ${block.fundPaidRubars} R payment. Final dust of ${finalDustRubars} R (integer-floor distribution remainders) remains in the dissolved bank's frozen cash record (§5.6).`,
          ask: "No action is required — this card closes the liquidation's account with you.",
          amountRubars: unpaid,
          subject: { kind: "corporation", id: args.bank.corporationId },
        }), `d1:${refKey(deposit.depositor)}`)
      );
      claims.created.push(...card.created);
      claims.updated.push(...card.updated);
    }
  }
  for (const loan of assignedLoans) {
    if (loan.outstandingRubars > 0) {
      planMutate(plan, ctx.snapshot, bankLoanPath(loan.loanId), "state", ["poolClosedAtSeq"], (current) =>
        current ? { ...current, poolClosedAtSeq: args.summarySeq } : current
      );
    }
  }
  return { closed: true, realizedLossRubars: realizedLoss, situationClaims: claims };
}

// ---------------------------------------------------------------------------
// B-07 — repay_loan (amendment §3.5). Borrower-initiated ONLY:
// nothing in this world auto-debits a borrower, ever (M5/M14). The
// amount allocates in the fixed order (unsettled interest, then
// principal, oldest installment first); a repayment the borrower
// cannot cover rejects IN FULL. Netting (V2-§2.3) applies against
// the principal portion only, and only against the loan's OWN
// created deposit; interest always moves as cash. The pool form
// (loan assigned) distributes the payment across the pool's unpaid
// claims — interest portion first across claims, subrogation
// routing the fund's recovery ahead of the depositor's (§5.6).
// ---------------------------------------------------------------------------

function repayLoanHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-07";
  const targetOrPlan = parseLoanTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { loanPath, loan, bank } = targetOrPlan;
  if (loan.status !== "active" && loan.status !== "assigned") {
    return rejectedPlan(descriptorId, "loan-not-active", [descriptorId], `B-07: loan ${loan.loanId} is ${loan.status}; only an active or pool-assigned loan can be repaid.`);
  }
  const poolForm = loan.status === "assigned";
  const namedBorrower = parseLedgerRef(sa(ctx.action).borrower);
  if (!namedBorrower || !ledgerRefsEqual(namedBorrower, loan.borrower)) {
    return rejectedPlan(descriptorId, "borrower-mismatch", [descriptorId], "B-07: the action's borrower ref does not match the loan record's borrower. The stored record governs.");
  }
  const control = borrowerControlRejection(ctx, descriptorId, loan.borrower);
  if (control) return control;
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-repayment", [descriptorId], "B-07: amountRubars must be a positive integer.");
  }
  const nettingElected = sa(ctx.action).netting === true;
  if (poolForm && nettingElected) {
    return rejectedPlan(descriptorId, "netting-not-available", [descriptorId], "B-07: netting does not apply to a pool-assigned loan — setoff already governed this debt at liquidation (BNK-D16), and pool repayments distribute in cash.");
  }
  let createdDeposit: BankDepositRecord | null = null;
  let createdDepositPath: string | null = null;
  if (nettingElected) {
    if (fundingSourceOf(loan) !== "credit" || !loan.proceedsDepositId) {
      return rejectedPlan(descriptorId, "netting-not-available", [descriptorId], "B-07: netting exists only against a credit-created loan's own created deposit (V2-§2.3) — this loan has none.");
    }
    createdDepositPath = bankDepositPath(loan.proceedsDepositId);
    createdDeposit = depositRecordOf(snapshotDoc(ctx.snapshot, createdDepositPath));
    if (
      !createdDeposit ||
      createdDeposit.status !== "active" ||
      createdDeposit.fundingLoanId !== loan.loanId ||
      !ledgerRefsEqual(createdDeposit.depositor, loan.borrower)
    ) {
      return rejectedPlan(descriptorId, "netting-not-available", [descriptorId], "B-07: the loan's created deposit does not stand active in the borrower's name — netting has nothing lawful to net against.");
    }
  }

  const plan = emptyPlan(descriptorId);
  if (loan.borrower.kind === "personal") {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: loan.borrower.memberId, viaActionKind: "repay_loan" });
  }
  // Interest basis seq: the loan entry's own seq (the B-04
  // settlement-entry convention) — the allocation, the watermark,
  // and the Log's stated figures all name this one seq.
  const loanEntrySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + 1;
  const standing = deriveLoanStanding(loan, loanEntrySeq);
  if (amount > standing.payoffWithFeeRubars) {
    return rejectedPlan(descriptorId, "repayment-exceeds-payoff", [descriptorId], `B-07: repayment of ${amount} R exceeds the loan's payoff figure of ${standing.payoffWithFeeRubars} R at seq ${loanEntrySeq} (outstanding ${loan.outstandingRubars} + unsettled interest ${standing.accruedInterestRubars}${loan.prepaymentFeeRubars ? ` + prepayment fee ${loan.prepaymentFeeRubars}` : ""}). Excess money is not a tip jar; the borrower names a lawful amount.`);
  }
  if (
    loan.prepaymentFeeRubars !== null &&
    amount >= standing.payoffRubars &&
    amount < standing.payoffWithFeeRubars
  ) {
    // The stated fee is part of the payoff figure (§3.5): an
    // amount that covers principal + interest but not the fee is
    // neither a lawful partial (it reaches the payoff line) nor a
    // lawful payoff (the fee is unpaid) — it refuses with both
    // figures named, and the borrower re-files.
    return rejectedPlan(descriptorId, "repayment-fee-figure", [descriptorId], `B-07: repayment of ${amount} R reaches the payoff line (${standing.payoffRubars} R) but not the full payoff figure of ${standing.payoffWithFeeRubars} R — the offer's stated prepayment fee of ${loan.prepaymentFeeRubars} R is part of payoff. File a partial below ${standing.payoffRubars} R or the full ${standing.payoffWithFeeRubars} R.`);
  }
  if (loan.collateral.kind !== "none" && !collateralEchoMatches(ctx.action, loan)) {
    return rejectedPlan(descriptorId, "collateral-mismatch", [descriptorId], "B-07: the action's collateral echo does not match the loan record's collateral. The stored record governs.");
  }
  const allocation = allocateRepayment(loan, amount, loanEntrySeq);

  // Netting split (principal only, against the own created deposit).
  let nettedPrincipal = 0;
  if (nettingElected && createdDeposit) {
    nettedPrincipal = Math.min(allocation.principalRubars, createdDeposit.principalRubars);
  }
  const cashPrincipal = allocation.principalRubars - nettedPrincipal;
  const cashDue = allocation.interestRubars + cashPrincipal + allocation.feeRubars;

  const tagged: TaggedChange[] = [];
  const situationClaims = { created: [] as string[], updated: [] as string[] };
  let poolDistributionNote = "";
  let closing: PoolClosingResult = { closed: false, realizedLossRubars: 0, situationClaims: { created: [], updated: [] } };

  if (!poolForm) {
    if (cashDue > 0) {
      const line: TransferLine = {
        from: loan.borrower,
        to: corporationRef(bank.cityId, bank.corporationId),
        amountRubars: cashDue,
        ruleId: descriptorId,
        memo: `loan repayment for ${loan.loanId}`,
      };
      const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
      if (!applied.ok) {
        return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `B-07: repayment refused in full (never partial, never auto-debited): ${applied.message}`);
      }
      tagged.push(...applied.changes);
    }
    if (allocation.principalRubars > 0) {
      tagged.push(applyBankAggregateDelta(plan, ctx, bank, "loanBookRubars", -allocation.principalRubars, descriptorId));
      if (loan.insider) {
        tagged.push(applyBankAggregateDelta(plan, ctx, bank, "insiderLoansRubars", -allocation.principalRubars, descriptorId));
      }
    }
    if (nettedPrincipal > 0 && createdDeposit && createdDepositPath) {
      const newPrincipal = createdDeposit.principalRubars - nettedPrincipal;
      const closesDeposit = newPrincipal === 0 && createdDeposit.creditedInterestRubars === 0;
      planMutate(plan, ctx.snapshot, createdDepositPath, "state", closesDeposit ? ["principalRubars", "status"] : ["principalRubars"], (current) =>
        current
          ? { ...current, principalRubars: newPrincipal, ...(closesDeposit ? { status: "closed" } : {}) }
          : current
      );
      tagged.push(applyAggregateDelta(plan, ctx, bank, -nettedPrincipal, descriptorId));
      const insuredChange = applyInsuredLiabilityDelta(plan, ctx, {
        deposit: createdDeposit,
        deltaRubars: -nettedPrincipal,
        bank,
        ruleId: descriptorId,
      });
      if (insuredChange) tagged.push(insuredChange);
    }
  } else {
    // Pool form: distribute across the bank's unpaid pool claims.
    const depositRows = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
      .map(({ doc }) => depositRecordOf(doc))
      .filter((d): d is BankDepositRecord => d !== null && d.status === "assigned");
    const totalUnpaid = depositRows.reduce((sum, d) => sum + poolUnpaidRubars(d), 0);
    if (amount > totalUnpaid) {
      return rejectedPlan(descriptorId, "repayment-exceeds-pool-claims", [descriptorId], `B-07: repayment of ${amount} R exceeds the pool's unpaid claims of ${totalUnpaid} R at ${bank.corporationId} — the pool may not collect beyond what it is owed.`);
    }
    const shares = depositRows
      .filter((d) => poolUnpaidRubars(d) > 0)
      .map((d) => ({ key: d.depositId, weight: poolUnpaidRubars(d), cap: poolUnpaidRubars(d) }));
    const interestPass = distributeProRata(allocation.interestRubars + allocation.feeRubars, shares);
    const remainingShares = shares.map((s) => ({
      ...s,
      weight: s.weight - (interestPass.payouts.get(s.key) ?? 0),
      cap: s.cap - (interestPass.payouts.get(s.key) ?? 0),
    }));
    const principalPass = distributeProRata(allocation.principalRubars, remainingShares);
    const lines: TransferLine[] = [];
    const perDeposit = new Map<string, { total: number; toFund: number }>();
    for (const deposit of depositRows) {
      const total =
        (interestPass.payouts.get(deposit.depositId) ?? 0) +
        (principalPass.payouts.get(deposit.depositId) ?? 0);
      if (total <= 0) continue;
      const block = deposit.liquidation;
      const fundOwed = block ? Math.max(0, block.fundPaidRubars - block.fundRecoveredRubars) : 0;
      const toFund = Math.min(total, fundOwed);
      perDeposit.set(deposit.depositId, { total, toFund });
      if (total - toFund > 0) {
        lines.push({
          from: loan.borrower,
          to: deposit.depositor,
          amountRubars: total - toFund,
          ruleId: descriptorId,
          memo: `pool distribution on deposit ${deposit.depositId} (liquidation of ${bank.corporationId})`,
        });
      }
      if (toFund > 0) {
        lines.push({
          from: loan.borrower,
          to: difRef(),
          amountRubars: toFund,
          ruleId: descriptorId,
          memo: `subrogated recovery for the fund on deposit ${deposit.depositId} (§5.6: distributions route to the fund until its payment is recovered)`,
        });
      }
    }
    // Dust (§5.6): the integer-floor remainder of the two passes is
    // part of the borrower's payment — it routes to the dissolved
    // bank's frozen cash record, visible and unspendable, and the
    // pool closing entry names the accumulated figure. The claims'
    // unpaid balances fall only by what was actually distributed.
    const dustRubars = interestPass.dustRubars + principalPass.dustRubars;
    if (dustRubars > 0) {
      lines.push({
        from: loan.borrower,
        to: corporationRef(bank.cityId, bank.corporationId),
        amountRubars: dustRubars,
        ruleId: descriptorId,
        memo: `pool distribution dust on liquidation of ${bank.corporationId} — integer-floor remainder to the dissolved bank's frozen cash record (§5.6)`,
      });
    }
    if (lines.length > 0) {
      const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines, shortfallClass: "transfer" });
      if (!applied.ok) {
        return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `B-07: pool repayment refused in full: ${applied.message}`);
      }
      tagged.push(...applied.changes);
    }
    for (const [depositId, { total, toFund }] of perDeposit) {
      const depositPath = bankDepositPath(depositId);
      planMutate(plan, ctx.snapshot, depositPath, "state", ["liquidation.poolDistributedRubars", "liquidation.fundRecoveredRubars"], (current) => {
        if (!current) return current;
        const record = current as unknown as BankDepositRecord;
        const block = record.liquidation;
        if (!block) return current;
        return {
          ...current,
          liquidation: {
            ...block,
            poolDistributedRubars: block.poolDistributedRubars + total,
            fundRecoveredRubars: block.fundRecoveredRubars + toFund,
          },
        };
      });
    }
    poolDistributionNote = ` Distributed across the pool's unpaid claims (interest portion first): ${[...perDeposit.entries()].map(([id, v]) => `${id} ${v.total} R${v.toFund > 0 ? ` (${v.toFund} R routed to the fund by subrogation)` : ""}`).join("; ")}.${dustRubars > 0 ? ` Dust of ${dustRubars} R (integer-floor remainder) remains in the dissolved bank's frozen cash record (§5.6).` : ""}`;
  }

  // -- Loan record write --------------------------------------------
  const residualAfter = Math.max(
    0,
    (loan.residualInterestRubars ?? 0) - Math.min(loan.residualInterestRubars ?? 0, allocation.interestRubars)
  );
  const loanChanges: SimChange[] = [
    fieldChange(`bankLoans/${loan.loanId}.outstandingRubars`, loan.outstandingRubars, loan.outstandingRubars - allocation.principalRubars, "B-07 repayment — principal portion (allocation: interest first, then principal, oldest installment first)"),
    fieldChange(`bankLoans/${loan.loanId}.lastSettledSeq`, loan.lastSettledSeq, loanEntrySeq, "B-07 — interest settled through this entry's seq (the borrower-initiated settlement; nothing auto-debits)"),
    fieldChange(`bankLoans/${loan.loanId}.totalInterestPaidRubars`, loan.totalInterestPaidRubars, loan.totalInterestPaidRubars + allocation.interestRubars, "B-07 — lifetime interest settled"),
    fieldChange(`bankLoans/${loan.loanId}.installmentsSettled`, loan.installmentsSettled, allocation.installmentsSettledAfter, "B-07 — installments fully covered"),
    fieldChange(`bankLoans/${loan.loanId}.nextDueSeq`, loan.nextDueSeq, allocation.nextDueSeqAfter, "B-07 — next unsettled installment's due seq"),
  ];
  if (residualAfter !== (loan.residualInterestRubars ?? 0)) {
    loanChanges.push(fieldChange(`bankLoans/${loan.loanId}.residualInterestRubars`, loan.residualInterestRubars ?? 0, residualAfter, "B-07 — residual (post-seizure) interest settled"));
  }
  if (nettedPrincipal > 0) {
    loanChanges.push(fieldChange(`bankLoans/${loan.loanId}.nettedPrincipalRubars`, loan.nettedPrincipalRubars, loan.nettedPrincipalRubars + nettedPrincipal, "B-07 netting — principal extinguished against the loan's own created deposit (no cash moved for this portion)"));
  }
  if (allocation.closesLoan) {
    loanChanges.push(fieldChange(`bankLoans/${loan.loanId}.status`, loan.status, "repaid", "B-07 — full payoff: the loan closes; pledge/lien release in this same event"));
  }
  planMutate(plan, ctx.snapshot, loanPath, "state", ["outstandingRubars", "lastSettledSeq", "totalInterestPaidRubars", "installmentsSettled", "nextDueSeq", "residualInterestRubars", "nettedPrincipalRubars", "status"], (current) => {
    if (!current) return current;
    return {
      ...current,
      outstandingRubars: loan.outstandingRubars - allocation.principalRubars,
      lastSettledSeq: loanEntrySeq,
      totalInterestPaidRubars: loan.totalInterestPaidRubars + allocation.interestRubars,
      installmentsSettled: allocation.installmentsSettledAfter,
      nextDueSeq: allocation.nextDueSeqAfter,
      residualInterestRubars: residualAfter,
      nettedPrincipalRubars: loan.nettedPrincipalRubars + nettedPrincipal,
      ...(allocation.closesLoan ? { status: "repaid" } : {}),
    };
  });

  // Collateral release at full payoff (§3.5).
  const releaseChanges: SimChange[] = [];
  if (allocation.closesLoan && loan.collateral.kind === "shares") {
    const sharesCollateral = loan.collateral;
    const pledgor = pledgorMemberId(ctx, loan.borrower);
    const row = queryDocs(ctx.snapshot, "pledgeHoldings", "sim_holdings").find(
      ({ doc }) => doc.memberId === pledgor && doc.corporationId === sharesCollateral.corporationId
    );
    if (row) {
      const before = typeof row.doc.pledgedShares === "number" ? row.doc.pledgedShares : 0;
      planMutate(plan, ctx.snapshot, row.path, "state", ["pledgedShares"], (current) =>
        current ? { ...current, pledgedShares: before - sharesCollateral.quantityShares } : current
      );
      releaseChanges.push(fieldChange(`holdings/${pledgor}__${sharesCollateral.corporationId}.pledgedShares`, before, before - sharesCollateral.quantityShares, "B-07 payoff — the pledge releases"));
      situationClaims.updated.push(row.path);
    }
  }
  if (allocation.closesLoan && loan.collateral.kind === "structure") {
    const structurePath = `sim_cities/${loan.collateral.cityId}/structures/${loan.collateral.structureId}`;
    planMutate(plan, ctx.snapshot, structurePath, "state", ["bankLien"], (current) =>
      current ? { ...current, bankLien: null } : current
    );
    releaseChanges.push(fieldChange(`structures/${loan.collateral.structureId}.bankLien`, "lien", null, "B-07 payoff — the lien releases"));
  }

  // B2 cards: installments now fully covered terminal their cards
  // in this transaction (partial coverage leaves them open).
  if (!poolForm) {
    let guard = 0;
    let closedPath: string | null;
    const settledThrough = allocation.installmentsSettledAfter;
    while (
      guard < loan.installmentCount &&
      (closedPath = closeSituationWhere(
        plan,
        ctx,
        (doc) =>
          doc.kind === "loan-installment-due" &&
          doc.detail?.loanId === loan.loanId &&
          typeof doc.detail?.installmentIndex === "number" &&
          (doc.detail.installmentIndex as number) <= settledThrough,
        { resolvedSeq: loanEntrySeq, resolutionId: ctx.resolutionId }
      )) !== null
    ) {
      situationClaims.updated.push(closedPath);
      guard += 1;
    }
  }

  // Pool closing (pool form): evaluate against PLANNED views.
  let summarySeq = loanEntrySeq + groupChangesByEntryCity(tagged).size + 1;
  if (poolForm) {
    const plannedDeposits = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
      .map(({ path }) => depositRecordOf(plannedDoc(plan, ctx.snapshot, path)))
      .filter((d): d is BankDepositRecord => d !== null);
    const plannedLoans = queryDocs(ctx.snapshot, "bankLoans", "sim_bank_loans")
      .map(({ path }) => loanRecordOf(plannedDoc(plan, ctx.snapshot, path)))
      .filter((l): l is BankLoanRecord => l !== null);
    closing = maybeClosePool(plan, ctx, {
      bank,
      deposits: plannedDeposits,
      loans: plannedLoans,
      summarySeq,
      ruleId: descriptorId,
    });
    if (closing.closed) {
      situationClaims.created.push(...closing.situationClaims.created);
      situationClaims.updated.push(...closing.situationClaims.updated);
    }
  }

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [...loanChanges, ...releaseChanges],
      recordsUpdated: [loanPath, ...situationClaims.updated],
      recordsCreated: situationClaims.created,
      summaryText: `B-07: loan ${loan.loanId} repaid ${amount} R — interest ${allocation.interestRubars} R, principal ${allocation.principalRubars} R${allocation.feeRubars > 0 ? `, prepayment fee ${allocation.feeRubars} R` : ""}${nettedPrincipal > 0 ? `; ${nettedPrincipal} R of the principal netted against the loan's own created deposit (no cash moved for it; interest always moves as cash)` : ""}${allocation.closesLoan ? `; the loan is REPAID in full — total interest paid over its life: ${loan.totalInterestPaidRubars + allocation.interestRubars} R; collateral released` : `; outstanding now ${loan.outstandingRubars - allocation.principalRubars} R`}.${poolDistributionNote}`,
    })
  );
  pushMovementEntries(plan, ctx, descriptorId, tagged, (entryCityId) =>
    entryCityId === bank.cityId
      ? `B-07: ${bank.corporationId} received the cash portion of the repayment on loan ${loan.loanId} (interest ${allocation.interestRubars} R + principal ${cashPrincipal} R${allocation.feeRubars > 0 ? ` + fee ${allocation.feeRubars} R` : ""}); its loan book fell by ${allocation.principalRubars} R.`
      : `B-07: ${ledgerLabel(loan.borrower)} paid toward loan ${loan.loanId} — borrower-initiated, as every repayment in this world is.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "repay-loan",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: poolForm
      ? `Repaid ${amount} R on pool-assigned loan ${loan.loanId} — distributed across the ${bank.corporationId} pool's unpaid claims${closing.closed ? "; the pool is exhausted and CLOSES in this event (D2 cards issued)" : ""}.`
      : `Repaid ${amount} R on loan ${loan.loanId} (interest ${allocation.interestRubars} R, principal ${allocation.principalRubars} R)${allocation.closesLoan ? " — loan closed, collateral released" : ""}.`,
    major: closing.closed,
    classificationExtra: {
      loan: {
        loanId: loan.loanId,
        interestRubars: allocation.interestRubars,
        principalRubars: allocation.principalRubars,
        nettedPrincipalRubars: nettedPrincipal,
        closesLoan: allocation.closesLoan,
        poolForm,
        poolClosed: closing.closed,
      },
    },
  });
}

/** Pool-distribution reads (B-07/B-08 pool forms): a distribution
 * credits every claimant of the bank's pool — personal depositors'
 * member accounts, company depositors' corporation docs, treasury
 * depositors' city docs. The recipient set is data-dependent (it
 * derives from the bank's deposit records), so the read plan takes
 * the same broad shape B-10's waterfall read plan takes: all member
 * accounts, all cities, and the corporations of every target city. */
function poolDistributionReads(
  seeds: ReadPlanSeeds,
  paths: string[],
  queries: CollectionQuerySpec[]
): void {
  queries.push(
    { id: "allMemberAccounts", collectionPath: "sim_member_accounts", filters: [] },
    { id: "allCities", collectionPath: "sim_cities", filters: [] },
    { id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] }
  );
  const cityIds = new Set<string>();
  const record = seeds.action.structuredAction ?? {};
  if (typeof record.cityId === "string") cityIds.add(record.cityId);
  const targets = (seeds.action as { targetCityIds?: unknown }).targetCityIds;
  if (Array.isArray(targets)) {
    for (const t of targets) if (typeof t === "string") cityIds.add(t);
  }
  for (const cid of cityIds) {
    queries.push({
      id: `cityCorporations_${cid}`,
      collectionPath: `sim_cities/${cid}/corporations`,
      filters: [],
    });
    paths.push(cityPath(cid), `factions/${cid}`);
  }
}

function repayLoanReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(
      ...premiumQueries(record.corporationId),
      ...situationKeyQueries(record.cityId),
      {
        id: "bankDeposits",
        collectionPath: "sim_bank_deposits",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      },
      {
        id: "bankLoans",
        collectionPath: "sim_bank_loans",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      }
    );
  }
  poolDistributionReads(seeds, paths, queries);
  if (typeof record.loanId === "string" && record.loanId) {
    paths.push(bankLoanPath(record.loanId));
  }
  const borrower = parseLedgerRef(record.borrower);
  if (borrower?.kind === "company") paths.push(corporationPath(borrower.cityId, borrower.corporationId));
  if (borrower?.kind === "treasury") paths.push(cityPath(borrower.cityId), `factions/${borrower.cityId}`);
  if (borrower?.kind === "personal") paths.push(memberAccountPath(borrower.memberId));
  const collateral = parseCollateral(record.collateral);
  if (collateral?.kind === "shares") {
    queries.push({
      id: "pledgeHoldings",
      collectionPath: "sim_holdings",
      filters: [{ field: "corporationId", op: "==", value: collateral.corporationId }],
    });
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-08 — seize_collateral (amendment §3.8). Lawful ONLY against a
// loan in DERIVED default, re-derived on the claimed snapshot at
// the seizure entry's seq — a loan previewed in default but cured
// before commit does not seize (the commit-time snapshot governs).
// Satisfaction values the collateral at its recorded basis (shares
// at the listing's official price at the seizure seq; a structure
// at its cumulative paidRubars) and applies interest-first. Any
// EXCESS of value over the debt returns to the borrower as a
// custodial line IN THE SAME EVENT — the return is a plan
// validation: a seizure plan without it does not validate (the
// handler constructs it unconditionally; the harness asserts the
// standing Log carries it on every seizure with excess). The
// remainder of the debt stays owed, unsecured. Pool form: a pool
// claimant seizes for the pool; proceeds distribute in kind / by
// custodian credit under §5.6's rules.
// ---------------------------------------------------------------------------

function seizeCollateralHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-08";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const targetOrPlan = parseLoanTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { loanPath, loan, bank } = targetOrPlan;
  if (loan.status !== "active" && loan.status !== "assigned") {
    return rejectedPlan(descriptorId, "loan-not-active", [descriptorId], `B-08: loan ${loan.loanId} is ${loan.status}; seizure acts on an active or pool-assigned loan.`);
  }
  const poolForm = loan.status === "assigned";
  const actorId = actorMemberId(ctx.action.actor);
  let claimantDeposit: BankDepositRecord | null = null;
  if (!poolForm) {
    if (!actorId || actorId !== bank.corp.ownerMemberId) {
      return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], "B-08: seizure is the bank owner's act (the creditor's remedy), or a pool claimant's in the pool form.");
    }
  } else {
    const claimantDepositId = stringField(ctx.action, "claimantDepositId");
    if (!claimantDepositId) {
      return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "B-08: the pool form names claimantDepositId — the actor seizes as a claimant of the pool, and the record proves it.");
    }
    claimantDeposit = depositRecordOf(snapshotDoc(ctx.snapshot, bankDepositPath(claimantDepositId)));
    if (
      !claimantDeposit ||
      claimantDeposit.bankCorporationId !== bank.corporationId ||
      claimantDeposit.status !== "assigned"
    ) {
      return rejectedPlan(descriptorId, "not-pool-claimant", [descriptorId], "B-08: the named deposit is not an assigned claim in this bank's pool.");
    }
    const control = borrowerControlRejection(ctx, descriptorId, claimantDeposit.depositor);
    if (control) {
      return rejectedPlan(descriptorId, "not-pool-claimant", [descriptorId], "B-08: the actor does not control the named claimant deposit.");
    }
  }
  if (loan.collateral.kind === "none") {
    return rejectedPlan(descriptorId, "no-collateral", [descriptorId], "B-08: this loan is unsecured — default gives the creditor an unsecured claim and the ordinary legal path, not a seizure. Nothing here is a defect: the offer's terms stated no collateral.");
  }
  if (!collateralEchoMatches(ctx.action, loan)) {
    return rejectedPlan(descriptorId, "collateral-mismatch", [descriptorId], "B-08: the action's collateral echo does not match the loan record's collateral. The stored record governs.");
  }

  const plan = emptyPlan(descriptorId);
  const seizureSeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + 1;
  const standing = deriveLoanStanding(loan, seizureSeq);
  if (!standing.inDefault) {
    return rejectedPlan(descriptorId, "loan-not-in-default", [descriptorId], `B-08: loan ${loan.loanId} does not derive in default at seq ${seizureSeq} — ${standing.missedCount} of ${loan.defaultMissedCount} required missed installments stand due-and-unsettled. Seizure follows the derived state on the claimed snapshot, never a stale preview; cure (B-07) un-happens default before any seizure can land.`);
  }

  // -- Satisfaction value (§3.8) -------------------------------------
  let value = 0;
  let valueBasis = "";
  let sharePrice = 0;
  if (loan.collateral.kind === "shares") {
    const listing = snapshotDoc(ctx.snapshot, listingPath(loan.collateral.corporationId));
    const price = typeof listing?.officialPriceRubars === "number" ? listing.officialPriceRubars : null;
    if (price === null) {
      return rejectedPlan(descriptorId, "collateral-unvalued", [descriptorId], `B-08: shares of ${loan.collateral.corporationId} carry no official price (no listing stands) — an unvalued pledge cannot satisfy a debt at a figure no record states. The lien rests until the shares are listed and priced.`);
    }
    sharePrice = price;
    value = price * loan.collateral.quantityShares;
    valueBasis = `${loan.collateral.quantityShares} shares at the official price ${price} R`;
  } else {
    const structure = snapshotDoc(ctx.snapshot, `sim_cities/${loan.collateral.cityId}/structures/${loan.collateral.structureId}`);
    if (!structure) {
      return rejectedPlan(descriptorId, "collateral-unavailable", [descriptorId], "B-08: the pledged structure's record does not stand.");
    }
    value = typeof structure.paidRubars === "number" ? structure.paidRubars : 0;
    valueBasis = `the structure's recorded paidRubars of ${value} R`;
  }
  const debt = standing.payoffRubars;
  const applied = Math.min(value, debt);
  const interestCovered = Math.min(applied, standing.accruedInterestRubars);
  const principalCovered = applied - interestCovered;
  const excess = value - applied;
  const remainder = debt - applied;
  const outstandingAfter = loan.outstandingRubars - principalCovered;
  // The watermark advances to the seizure seq; every Rubar of
  // unsettled interest the satisfaction did not cover remains owed
  // as residual (non-accruing, never principal — M14).
  const residualAfter = standing.accruedInterestRubars - interestCovered;

  const tagged: TaggedChange[] = [];
  const situationClaims = { created: [] as string[], updated: [] as string[] };

  // -- Excess return: the plan-validation line (§3.8) -----------------
  if (excess > 0) {
    const line: TransferLine = {
      from: corporationRef(bank.cityId, bank.corporationId),
      to: loan.borrower,
      amountRubars: excess,
      ruleId: descriptorId,
      memo: `excess collateral value returned on loan ${loan.loanId}`,
    };
    const appliedLines = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "custodial" });
    if (!appliedLines.ok) {
      return rejectedPlan(descriptorId, "excess-return-uncoverable", [descriptorId], `B-08: the seizure's mandatory excess return of ${excess} R cannot be covered from ${bank.corporationId}'s unencumbered cash (${appliedLines.message}) — a seizure whose return line cannot land does not validate, so the seizure itself refuses. The collateral rests; the default stands.`);
    }
    tagged.push(...appliedLines.changes);
  }

  // -- Collateral transfer --------------------------------------------
  const transferChanges: SimChange[] = [];
  if (loan.collateral.kind === "shares") {
    const sharesCollateral = loan.collateral;
    const pledgor = pledgorMemberId(ctx, loan.borrower);
    const rows = queryDocs(ctx.snapshot, "pledgeHoldings", "sim_holdings");
    const pledgorRow = rows.find(({ doc }) => doc.memberId === pledgor && doc.corporationId === sharesCollateral.corporationId);
    if (!pledgorRow) {
      return rejectedPlan(descriptorId, "collateral-unavailable", [descriptorId], "B-08: the pledgor's holding carrying the pledged shares does not stand in the read set — seizure cannot move what the snapshot cannot see.");
    }
    if (pledgorRow) {
      const pledgedBefore = typeof pledgorRow.doc.pledgedShares === "number" ? pledgorRow.doc.pledgedShares : 0;
      const quantityBefore = typeof pledgorRow.doc.quantityShares === "number" ? pledgorRow.doc.quantityShares : 0;
      planMutate(plan, ctx.snapshot, pledgorRow.path, "state", ["pledgedShares", "quantityShares"], (current) =>
        current
          ? {
              ...current,
              pledgedShares: pledgedBefore - sharesCollateral.quantityShares,
              quantityShares: quantityBefore - sharesCollateral.quantityShares,
            }
          : current
      );
      transferChanges.push(
        fieldChange(`holdings/${pledgor}__${sharesCollateral.corporationId}.quantityShares`, quantityBefore, quantityBefore - sharesCollateral.quantityShares, "B-08 seizure — the pledged shares leave the pledgor's holding"),
        fieldChange(`holdings/${pledgor}__${sharesCollateral.corporationId}.pledgedShares`, pledgedBefore, pledgedBefore - sharesCollateral.quantityShares, "B-08 seizure — the pledge is consumed")
      );
      situationClaims.updated.push(pledgorRow.path);
    }
    if (!poolForm) {
      // Bank form: the shares land in the bank OWNER's holding,
      // flagged held for the bank (custody, not the owner's
      // property — BNK-D4's fallback, flagged in the prep report).
      const ownerId = bank.corp.ownerMemberId as string;
      const ownerPath = holdingPath(ownerId, sharesCollateral.corporationId);
      const ownerRow = rows.find(({ doc }) => doc.memberId === ownerId && doc.corporationId === sharesCollateral.corporationId);
      if (ownerRow) {
        const quantityBefore = typeof ownerRow.doc.quantityShares === "number" ? ownerRow.doc.quantityShares : 0;
        planMutate(plan, ctx.snapshot, ownerRow.path, "state", ["quantityShares", "heldForBank"], (current) =>
          current
            ? {
                ...current,
                quantityShares: quantityBefore + sharesCollateral.quantityShares,
                heldForBank: { bankCorporationId: bank.corporationId },
              }
            : current
        );
        transferChanges.push(fieldChange(`holdings/${ownerId}__${sharesCollateral.corporationId}.quantityShares`, quantityBefore, quantityBefore + sharesCollateral.quantityShares, "B-08 seizure — shares held by the bank's owner FOR the bank (heldForBank)"));
        situationClaims.updated.push(ownerRow.path);
      } else {
        const doc = buildHoldingDoc({
          memberId: ownerId,
          corporationId: sharesCollateral.corporationId,
          homeCityId: sharesCollateral.cityId,
          quantityShares: sharesCollateral.quantityShares,
          committedShares: 0,
          costBasisRubars: applied,
          sourceActionId: ctx.action.actionId,
          sourceSeq: seizureSeq,
          lastResolutionId: ctx.resolutionId,
          now: new Date(ctx.snapshot.now),
        });
        planWrite(plan, ctx.snapshot, ownerPath, { ...doc, heldForBank: { bankCorporationId: bank.corporationId }, pledgedShares: 0 }, "state", ["quantityShares", "heldForBank"]);
        transferChanges.push(fieldChange(`holdings/${ownerId}__${sharesCollateral.corporationId}.quantityShares`, null, sharesCollateral.quantityShares, "B-08 seizure — a holding opens for the bank's owner, holding the seized shares FOR the bank"));
        situationClaims.created.push(ownerPath);
      }
      if (applied > 0) {
        tagged.push(applyBankAggregateDelta(plan, ctx, bank, "seizedAssetsRubars", applied, descriptorId));
      }
    } else {
      // Pool form: shares distribute integer pro-rata by unpaid
      // claim (remainder to the largest unpaid claim, §5.6);
      // treasury claimants take claim credit instead (holdings are
      // member-keyed), their share quantity folding to the largest
      // unpaid claimant.
      const depositRows = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
        .map(({ doc }) => depositRecordOf(doc))
        .filter((d): d is BankDepositRecord => d !== null && d.status === "assigned" && poolUnpaidRubars(d) > 0);
      const totalUnpaid = depositRows.reduce((sum, d) => sum + poolUnpaidRubars(d), 0);
      if (totalUnpaid > 0) {
        let remainingShares = sharesCollateral.quantityShares;
        const perClaimant = depositRows
          .map((d) => ({
            deposit: d,
            shares: Math.floor((sharesCollateral.quantityShares * poolUnpaidRubars(d)) / totalUnpaid),
          }))
          .sort((a, b) => poolUnpaidRubars(b.deposit) - poolUnpaidRubars(a.deposit));
        for (const entry of perClaimant) remainingShares -= entry.shares;
        if (perClaimant.length > 0 && remainingShares > 0) perClaimant[0].shares += remainingShares;
        for (const { deposit, shares } of perClaimant) {
          if (shares <= 0) continue;
          const creditedValue = Math.min(poolUnpaidRubars(deposit), shares * sharePrice);
          const depositPath = bankDepositPath(deposit.depositId);
          planMutate(plan, ctx.snapshot, depositPath, "state", ["liquidation.poolDistributedRubars"], (current) => {
            if (!current) return current;
            const record = current as unknown as BankDepositRecord;
            if (!record.liquidation) return current;
            return {
              ...current,
              liquidation: { ...record.liquidation, poolDistributedRubars: record.liquidation.poolDistributedRubars + creditedValue },
            };
          });
          const holderMember =
            deposit.depositor.kind === "personal"
              ? deposit.depositor.memberId
              : deposit.depositor.kind === "company"
                ? (() => {
                    const corp = snapshotDoc(ctx.snapshot, corporationPath(deposit.depositor.kind === "company" ? deposit.depositor.cityId : "", deposit.depositor.kind === "company" ? deposit.depositor.corporationId : ""));
                    return typeof corp?.ownerMemberId === "string" ? corp.ownerMemberId : null;
                  })()
                : null;
          if (holderMember) {
            const claimantRow = rows.find(({ doc }) => doc.memberId === holderMember && doc.corporationId === sharesCollateral.corporationId);
            const targetPath = holdingPath(holderMember, sharesCollateral.corporationId);
            if (claimantRow) {
              const quantityBefore = typeof claimantRow.doc.quantityShares === "number" ? claimantRow.doc.quantityShares : 0;
              planMutate(plan, ctx.snapshot, claimantRow.path, "state", ["quantityShares"], (current) =>
                current ? { ...current, quantityShares: quantityBefore + shares } : current
              );
              transferChanges.push(fieldChange(`holdings/${holderMember}__${sharesCollateral.corporationId}.quantityShares`, quantityBefore, quantityBefore + shares, "B-08 pool seizure — shares distributed to a pool claimant"));
              situationClaims.updated.push(claimantRow.path);
            } else {
              const doc = buildHoldingDoc({
                memberId: holderMember,
                corporationId: sharesCollateral.corporationId,
                homeCityId: sharesCollateral.cityId,
                quantityShares: shares,
                committedShares: 0,
                costBasisRubars: creditedValue,
                sourceActionId: ctx.action.actionId,
                sourceSeq: seizureSeq,
                lastResolutionId: ctx.resolutionId,
                now: new Date(ctx.snapshot.now),
              });
              planWrite(plan, ctx.snapshot, targetPath, { ...doc, pledgedShares: 0 }, "state", ["quantityShares"]);
              transferChanges.push(fieldChange(`holdings/${holderMember}__${sharesCollateral.corporationId}.quantityShares`, null, shares, "B-08 pool seizure — a holding opens for a pool claimant"));
              situationClaims.created.push(targetPath);
            }
          }
        }
      }
    }
  }
  if (loan.collateral.kind === "structure") {
    const structureCollateral = loan.collateral;
    const structurePath = `sim_cities/${structureCollateral.cityId}/structures/${structureCollateral.structureId}`;
    if (!poolForm) {
      planMutate(plan, ctx.snapshot, structurePath, "state", ["bankLien", "seizedForBank"], (current) =>
        current
          ? {
              ...current,
              bankLien: null,
              seizedForBank: { bankCorporationId: bank.corporationId, loanId: loan.loanId, satisfactionValueRubars: applied, atSeq: seizureSeq },
            }
          : current
      );
      transferChanges.push(fieldChange(`structures/${structureCollateral.structureId}.bankLien`, "lien", null, "B-08 seizure — the lien is consumed by the seizure"));
      // The link moves from the borrower's corporation to the bank's.
      if (loan.borrower.kind === "company") {
        const borrowerCorpPath = corporationPath(loan.borrower.cityId, loan.borrower.corporationId);
        planMutate(plan, ctx.snapshot, borrowerCorpPath, "state", ["linkedStructureIds"], (current) => {
          if (!current) return current;
          const linked = ((current.linkedStructureIds as unknown[] | undefined) ?? []).filter((id) => id !== structureCollateral.structureId);
          return { ...current, linkedStructureIds: linked };
        });
        planMutate(plan, ctx.snapshot, bank.corpPath, "state", ["linkedStructureIds"], (current) => {
          if (!current) return current;
          const linked = ((current.linkedStructureIds as unknown[] | undefined) ?? []).slice();
          if (!linked.includes(structureCollateral.structureId)) linked.push(structureCollateral.structureId);
          return { ...current, linkedStructureIds: linked };
        });
      }
      if (applied > 0) {
        tagged.push(applyBankAggregateDelta(plan, ctx, bank, "seizedAssetsRubars", applied, descriptorId));
      }
    } else {
      // Pool form: the largest unpaid claimant becomes custodian;
      // their claim falls by the recorded value (excess paid onward
      // in cash if the pool holds any, else their windfall, §5.6).
      const depositRows = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
        .map(({ doc }) => depositRecordOf(doc))
        .filter((d): d is BankDepositRecord => d !== null && d.status === "assigned" && poolUnpaidRubars(d) > 0)
        .sort((a, b) => poolUnpaidRubars(b) - poolUnpaidRubars(a));
      const custodian = depositRows[0];
      if (custodian) {
        const credited = Math.min(poolUnpaidRubars(custodian), value);
        planMutate(plan, ctx.snapshot, structurePath, "state", ["bankLien", "poolCustodian"], (current) =>
          current
            ? {
                ...current,
                bankLien: null,
                poolCustodian: { depositor: custodian.depositor, creditedValueRubars: credited },
              }
            : current
        );
        const custodianPath = bankDepositPath(custodian.depositId);
        planMutate(plan, ctx.snapshot, custodianPath, "state", ["liquidation.poolDistributedRubars"], (current) => {
          if (!current) return current;
          const record = current as unknown as BankDepositRecord;
          if (!record.liquidation) return current;
          return {
            ...current,
            liquidation: { ...record.liquidation, poolDistributedRubars: record.liquidation.poolDistributedRubars + credited },
          };
        });
        transferChanges.push(fieldChange(`structures/${structureCollateral.structureId}.bankLien`, "lien", null, "B-08 pool seizure — the lien is consumed; the structure passes to the pool's custodian"));
      }
    }
  }

  // -- Loan record write ----------------------------------------------
  const extinguished = outstandingAfter === 0;
  planMutate(plan, ctx.snapshot, loanPath, "state", ["outstandingRubars", "lastSettledSeq", "totalInterestPaidRubars", "residualInterestRubars", "seizure", "status"], (current) => {
    if (!current) return current;
    return {
      ...current,
      outstandingRubars: outstandingAfter,
      lastSettledSeq: seizureSeq,
      totalInterestPaidRubars: loan.totalInterestPaidRubars + interestCovered,
      residualInterestRubars: residualAfter,
      seizure: {
        atSeq: seizureSeq,
        byActorMemberId: actorId ?? "",
        forPool: poolForm,
        satisfactionValueRubars: applied,
        grossValueRubars: value,
        excessReturnedRubars: excess,
        remainderRubars: remainder,
      },
      ...(extinguished ? { status: "seized" } : {}),
    };
  });
  if (principalCovered > 0 && !poolForm) {
    tagged.push(applyBankAggregateDelta(plan, ctx, bank, "loanBookRubars", -principalCovered, descriptorId));
    if (loan.insider) {
      tagged.push(applyBankAggregateDelta(plan, ctx, bank, "insiderLoansRubars", -principalCovered, descriptorId));
    }
  }
  if (principalCovered > 0 && poolForm) {
    // Pool loans stand outside the (dissolved) bank's aggregates —
    // the loanBook was zeroed at liquidation; nothing pairs here.
  }

  // B4: the borrower's seizure card (major).
  const addressing = situationAddressingFor(ctx.snapshot, loan.borrower, bank.cityId);
  const card = mintSituation(
    plan,
    ctx,
    buildIncidentSituation({
      cityId: bank.cityId,
      audienceCityId: bank.cityId,
      audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
      recipientUid: addressing.recipientUid ?? null,
      severity: "major",
      createdSeq: seizureSeq,
      now: ctx.snapshot.now,
      sourceSeq: seizureSeq,
      sourceResolutionId: ctx.resolutionId,
      title: `Collateral seized — loan ${loan.loanId}`,
      summary: `${poolForm ? "A pool claimant" : bank.corporationId} seized the collateral on loan ${loan.loanId} after derived default (${standing.missedCount} missed installments). Satisfaction ${applied} R against a debt of ${debt} R; ${remainder} R remains owed unsecured${excess > 0 ? `; ${excess} R of excess value returned to the borrower in this event` : ""}.`,
      consequenceSummary: `Seized: ${valueBasis} (gross value ${value} R). Applied interest-first: interest ${interestCovered} R, principal ${principalCovered} R. Remainder of the debt: ${remainder} R, unsecured. Excess returned: ${excess} R.`,
      ask: "No action is required unless you contest the valuation basis stated — the recorded figures are the Log's.",
      amountRubars: applied,
      subject: { kind: "corporation", id: bank.corporationId },
    })
  );
  situationClaims.created.push(...card.created);
  situationClaims.updated.push(...card.updated);

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`bankLoans/${loan.loanId}.outstandingRubars`, loan.outstandingRubars, outstandingAfter, "B-08 seizure — principal satisfied by collateral"),
        fieldChange(`bankLoans/${loan.loanId}.seizure`, null, { satisfactionValueRubars: applied, grossValueRubars: value, excessReturnedRubars: excess, remainderRubars: remainder }, "B-08 seizure record (A-B7's satisfaction source)"),
        ...transferChanges,
      ],
      recordsCreated: situationClaims.created,
      recordsUpdated: [loanPath, ...situationClaims.updated],
      summaryText: `B-08: collateral on loan ${loan.loanId} seized after derived default (missed ${standing.missedCount} ≥ ${loan.defaultMissedCount}). Satisfaction basis: ${valueBasis} — gross ${value} R; applied ${applied} R (interest ${interestCovered} R, principal ${principalCovered} R); excess ${excess} R returned to the borrower in this event (a seizure plan without the return line does not validate); remainder ${remainder} R owed unsecured.${extinguished ? " The debt is extinguished by the collateral; the loan closes as seized." : ""}`,
    })
  );
  pushMovementEntries(plan, ctx, descriptorId, tagged, (entryCityId) =>
    entryCityId === bank.cityId
      ? `B-08: ${bank.corporationId}'s position after seizure on loan ${loan.loanId}: loan book fell by ${principalCovered} R; seized assets rose by ${applied} R (recorded satisfaction value); excess ${excess} R returned from unencumbered cash.`
      : `B-08: ${ledgerLabel(loan.borrower)} received the ${excess} R excess-value return on loan ${loan.loanId}.`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "seize-collateral",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: `Seized the collateral on loan ${loan.loanId} (derived default): satisfaction ${applied} R against ${debt} R of debt, excess ${excess} R returned, remainder ${remainder} R unsecured.`,
    major: true,
    classificationExtra: {
      loan: { loanId: loan.loanId, satisfactionRubars: applied, excessReturnedRubars: excess, remainderRubars: remainder, poolForm },
    },
  });
}

function seizeCollateralReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(
      ...premiumQueries(record.corporationId),
      ...situationKeyQueries(record.cityId),
      {
        id: "bankDeposits",
        collectionPath: "sim_bank_deposits",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      },
      {
        id: "bankLoans",
        collectionPath: "sim_bank_loans",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      }
    );
  }
  poolDistributionReads(seeds, paths, queries);
  if (typeof record.loanId === "string" && record.loanId) paths.push(bankLoanPath(record.loanId));
  if (typeof record.claimantDepositId === "string" && record.claimantDepositId) {
    paths.push(bankDepositPath(record.claimantDepositId));
  }
  const borrower = parseLedgerRef(record.borrower);
  if (borrower?.kind === "company") paths.push(corporationPath(borrower.cityId, borrower.corporationId));
  if (borrower?.kind === "treasury") paths.push(cityPath(borrower.cityId), `factions/${borrower.cityId}`);
  const collateral = parseCollateral(record.collateral);
  if (collateral?.kind === "shares") {
    paths.push(listingPath(collateral.corporationId));
    queries.push({
      id: "pledgeHoldings",
      collectionPath: "sim_holdings",
      filters: [{ field: "corporationId", op: "==", value: collateral.corporationId }],
    });
  }
  if (collateral?.kind === "structure") {
    paths.push(`sim_cities/${collateral.cityId}/structures/${collateral.structureId}`);
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-11 — write_off_loan (amendment §3.10, REC-2). The bank forgives
// debt it judges uncollectible: the loan asset falls, NO liability
// moves, NO cash moves, and the loss posts through the bank's
// EQUITY — the named "credit loss" bridge (classification-stamped
// on the summary + stated in the entry), never a burn (REC-2's
// rejected alternative). The record is retained whole (A-B2/A-B5
// read it; §3.9's credit record keeps the history). A bank in
// derived failure may not write off (§5.4): judgments about
// collectibility belong to a going concern; in failure the book is
// the pool's, untouched by the old owner's forgiveness.
// ---------------------------------------------------------------------------

function writeOffLoanHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-11";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const targetOrPlan = parseLoanTarget(ctx, descriptorId);
  if ("outcome" in targetOrPlan) return targetOrPlan;
  const { loanPath, loan, bank } = targetOrPlan;
  if (loan.status !== "active") {
    return rejectedPlan(descriptorId, "loan-not-active", [descriptorId], `B-11: loan ${loan.loanId} is ${loan.status}; write-off acts on a live bank's active loan (a pool-assigned loan is the pool's, and no pool write-off verb exists).`);
  }
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId || actorId !== bank.corp.ownerMemberId) {
    return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], "B-11: writing off a loan is the bank owner's act.");
  }
  if (deriveBankHealth(bank.corp) === "insolvent") {
    return rejectedPlan(descriptorId, "write-off-in-failure", [descriptorId], `B-11: ${bank.corporationId} derives failed (insolvent, REC-6) — in failure the book belongs to the waterfall; the owner may not forgive debts out of the pool's reach (§5.4).`);
  }
  const amount = sa(ctx.action).amountRubars;
  const writeOffAmount =
    typeof amount === "number" && Number.isInteger(amount) && amount > 0 ? amount : loan.outstandingRubars;
  if (writeOffAmount > loan.outstandingRubars) {
    return rejectedPlan(descriptorId, "write-off-exceeds-outstanding", [descriptorId], `B-11: write-off of ${writeOffAmount} R exceeds the loan's outstanding principal of ${loan.outstandingRubars} R. Unsettled interest is never written off by B-11 — it is extinguished, unclaimed, when the record closes (the B-03 closing discipline), and this entry states it.`);
  }
  const standing = deriveLoanStanding(loan, ctx.snapshot.counterHead.lastSeq + 1);
  const closes = writeOffAmount === loan.outstandingRubars;
  const plan = emptyPlan(descriptorId);
  const tagged: TaggedChange[] = [
    applyBankAggregateDelta(plan, ctx, bank, "loanBookRubars", -writeOffAmount, descriptorId),
  ];
  if (loan.insider) {
    tagged.push(applyBankAggregateDelta(plan, ctx, bank, "insiderLoansRubars", -writeOffAmount, descriptorId));
  }
  planMutate(plan, ctx.snapshot, loanPath, "state", ["outstandingRubars", "writtenOffRubars", "status"], (current) => {
    if (!current) return current;
    return {
      ...current,
      outstandingRubars: loan.outstandingRubars - writeOffAmount,
      writtenOffRubars: loan.writtenOffRubars + writeOffAmount,
      ...(closes ? { status: "written-off" } : {}),
    };
  });
  // B5: the borrower's write-off card (history not erased).
  const addressing = situationAddressingFor(ctx.snapshot, loan.borrower, bank.cityId);
  const card = mintSituation(
    plan,
    ctx,
    buildIncidentSituation({
      cityId: bank.cityId,
      audienceCityId: bank.cityId,
      audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
      recipientUid: addressing.recipientUid ?? null,
      severity: "routine",
      createdSeq: ctx.snapshot.counterHead.lastSeq + 1,
      now: ctx.snapshot.now,
      sourceSeq: ctx.snapshot.counterHead.lastSeq + 1,
      sourceResolutionId: ctx.resolutionId,
      title: `Loan written off — ${loan.loanId}`,
      summary: `${bank.corporationId} wrote off ${writeOffAmount} R of loan ${loan.loanId}${closes ? " — the debt is forgiven in full" : ` — ${loan.outstandingRubars - writeOffAmount} R remains owed`}. The loan's history stands in the Log; write-off forgives, it does not erase.`,
      consequenceSummary: `Forgiven: ${writeOffAmount} R of principal. The loss posts through the bank's equity as a named credit loss (REC-2) — no cash moved, no liability moved, nothing was burned.`,
      ask: "No action is required.",
      amountRubars: writeOffAmount,
      subject: { kind: "corporation", id: bank.corporationId },
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      changes: [
        fieldChange(`bankLoans/${loan.loanId}.outstandingRubars`, loan.outstandingRubars, loan.outstandingRubars - writeOffAmount, "B-11 write-off — the asset falls; the loss posts through equity (credit-loss bridge)"),
        fieldChange(`bankLoans/${loan.loanId}.writtenOffRubars`, loan.writtenOffRubars, loan.writtenOffRubars + writeOffAmount, "B-11 — cumulative written-off principal (the record is retained, §3.10)"),
        ...(closes
          ? [
              fieldChange(`bankLoans/${loan.loanId}.status`, "active", "written-off", `B-11 — fully written off; ${standing.accruedInterestRubars} R of unsettled interest is extinguished unclaimed at closing (a derived figure, never a balance)`),
            ]
          : []),
      ],
      recordsCreated: card.created,
      recordsUpdated: [loanPath, ...card.updated],
      summaryText: `B-11: ${bank.corporationId} wrote off ${writeOffAmount} R of loan ${loan.loanId} (borrower ${ledgerLabel(loan.borrower)}). The loss posts as a credit loss through the bank's equity: net worth falls by exactly ${writeOffAmount} R; no cash, liability, or claim moved.`,
    })
  );
  pushMovementEntries(plan, ctx, descriptorId, tagged, () =>
    `B-11: ${bank.corporationId}'s loan book fell by ${writeOffAmount} R — the A-B2 pair of the write-off (equity bridge: net worth ${bankBalanceSheet(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {})?.netWorthRubars ?? 0} R after).`
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "write-off-loan",
    scope: "bank",
    cityId: bank.cityId,
    summaryText: `Wrote off ${writeOffAmount} R of loan ${loan.loanId} at ${bank.corporationId} — credit loss through equity; the borrower's card stands and the record's history is retained.`,
    classificationExtra: {
      creditLoss: { loanId: loan.loanId, amountRubars: writeOffAmount, bridge: "equity" },
    },
  });
}

function cancelLoanOfferReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId), ...situationKeyQueries(record.cityId));
  }
  if (typeof record.loanId === "string" && record.loanId) paths.push(bankLoanPath(record.loanId));
  return { paths, queries };
}

function writeOffLoanReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId), ...situationKeyQueries(record.cityId));
  }
  if (typeof record.loanId === "string" && record.loanId) paths.push(bankLoanPath(record.loanId));
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-09 — recapitalize_bank (amendment §5.2). Anyone may inject
// capital into a bank from a ledger they control; against a FAILED
// bank the injection is tested as a CURE in the same event: cure ⇔
// the post-injection sheet derives solvent (net worth ≥ 0) AND
// liquid (cash ≥ liquid reserve) AND — for the failed-payment form
// — the failure-deriving claims are now coverable, stamped
// `curesFailedPayment` on the summary classification for the
// derivation (banking.ts deriveFailedPayment reads it). The
// boundary is inclusive: exact equality cures. A non-curing
// injection is lawful and lands as an ordinary injection whose Log
// entry states it did not cure (previews show the same verdict —
// V-B7 parity is the same computation).
// ---------------------------------------------------------------------------

function recapitalizeBankHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-09";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const bank: BankTarget & { cityId: string; corporationId: string } = { ...bankOrPlan, cityId, corporationId };
  const from = parseLedgerRef(sa(ctx.action).from);
  if (!from || from.kind === "market" || from.kind === "exterior" || from.kind === "institution") {
    return rejectedPlan(descriptorId, "malformed-recapitalization", [descriptorId], "B-09: `from` must name a member, company, or treasury ledger the actor controls — recapitalization is real money from a real ledger, never the Market Account, the Exterior, or the fund.");
  }
  const control = borrowerControlRejection(ctx, descriptorId, from);
  if (control) {
    return rejectedPlan(descriptorId, "not-ledger-controller", [descriptorId], "B-09: the injection's source ledger is not the actor's to spend.");
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null) {
    return rejectedPlan(descriptorId, "malformed-recapitalization", [descriptorId], "B-09: amountRubars must be a positive integer.");
  }
  const healthBefore = deriveBankHealth(bank.corp);
  const sheetBefore = bankBalanceSheet(bank.corp);
  const plan = emptyPlan(descriptorId);
  if (from.kind === "personal") {
    composeLazyOpen({ plan, snapshot: ctx.snapshot, actor: ctx.action.actor, memberId: from.memberId, viaActionKind: "recapitalize_bank" });
  }
  const line: TransferLine = {
    from,
    to: corporationRef(cityId, corporationId),
    amountRubars: amount,
    ruleId: descriptorId,
    memo: `recapitalization of ${corporationId}`,
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `B-09: injection refused: ${applied.message}`);
  }
  const sheetAfter = bankBalanceSheet(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {});
  const cured =
    sheetAfter !== null && sheetAfter.netWorthRubars >= 0 && sheetAfter.cashRubars >= sheetAfter.liquidReserveRubars;
  const wasFailed = healthBefore === "insolvent";
  // K2: a standing failed-payment episode card terminals on a cure
  // and updates on a non-cure (Pattern X). (The episode's minting
  // rides the Log-slice seam — rejections write no entries, so the
  // card is minted by the first banking event whose read set can
  // see the derivation; B-09 is that event when the card already
  // stands from the wake composition. Flagged in the prep report.)
  const episodeKey = {
    sourceKind: "system" as const,
    sourceId: episodeSourceId(`bank:${corporationId}`, "failed-payment"),
    situationKind: "incident",
    audienceKey: cityId,
  };
  const standingCard = findSituation(
    ctx,
    (doc) => doc.dedupeKey === dedupeKeyFor(episodeKey) && doc.status === "open"
  );
  const situationClaims = { created: [] as string[], updated: [] as string[] };
  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + groupChangesByEntryCity(applied.changes).size + 1;
  if (standingCard && cured) {
    const closedPath = closeSituationWhere(plan, ctx, (doc) => doc.situationId === standingCard.situationId, {
      resolvedSeq: summarySeq,
      resolutionId: ctx.resolutionId,
    });
    if (closedPath) situationClaims.updated.push(closedPath);
  } else if (standingCard && !cured) {
    const card = mintSituation(
      plan,
      ctx,
      buildIncidentSituation({
        cityId,
        audienceCityId: cityId,
        audienceOwnerUidsSnapshot: standingCard.audienceOwnerUidsSnapshot,
        recipientUid: standingCard.recipientUid,
        severity: "major",
        createdSeq: summarySeq,
        now: ctx.snapshot.now,
        sourceSeq: summarySeq,
        sourceResolutionId: ctx.resolutionId,
        title: standingCard.title,
        summary: `${corporationId} remains in failed-payment failure after a recapitalization of ${amount} R: net worth ${sheetBefore?.netWorthRubars ?? 0} → ${sheetAfter?.netWorthRubars ?? 0} R, cash ${sheetBefore?.cashRubars ?? 0} → ${sheetAfter?.cashRubars ?? 0} R against a liquid reserve of ${sheetAfter?.liquidReserveRubars ?? 0} R. The injection landed; it did not cure.`,
        consequenceSummary: "The failed-payment episode continues: custodial claims that derived the failure are not all coverable on the post-injection sheet (derivation stated in the B-09 entry).",
        ask: "Inject enough to cure, or liquidate (B-10) — the episode closes only on a cure or a liquidation.",
        amountRubars: amount,
        subject: { kind: "corporation", id: corporationId },
        episode: { subjectKey: `bank:${corporationId}`, episodeClass: "failed-payment" },
      })
    );
    situationClaims.created.push(...card.created);
    situationClaims.updated.push(...card.updated);
  }
  pushMovementEntries(
    plan,
    ctx,
    descriptorId,
    applied.changes,
    (entryCityId) =>
      entryCityId === cityId
        ? `B-09: ${corporationId} received ${amount} R of recapitalization from ${ledgerLabel(from)}. Post-injection: net worth ${sheetAfter?.netWorthRubars ?? 0} R, cash ${sheetAfter?.cashRubars ?? 0} R, liquid reserve ${sheetAfter?.liquidReserveRubars ?? 0} R — ${cured ? "the bank derives CURED (solvent and liquid; the boundary is inclusive)" : wasFailed ? "the injection landed but does NOT cure (the preview computes this same verdict)" : "an ordinary capital injection into a going concern"}.`
        : `B-09: ${ledgerLabel(from)} injected ${amount} R into ${corporationId}.`,
    { created: situationClaims.created, updated: situationClaims.updated }
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "recapitalize-bank",
    scope: "bank",
    cityId,
    summaryText: wasFailed
      ? cured
        ? `Recapitalized ${corporationId} with ${amount} R from ${ledgerLabel(from)} — the bank derives CURED in this event (net worth ${sheetAfter?.netWorthRubars ?? 0} R ≥ 0, cash ≥ liquid reserve).`
        : `Injected ${amount} R into the failed ${corporationId} — the injection stands, but the bank does NOT derive cured (net worth ${sheetAfter?.netWorthRubars ?? 0} R, cash ${sheetAfter?.cashRubars ?? 0} R vs reserve ${sheetAfter?.liquidReserveRubars ?? 0} R).`
      : `Recapitalized ${corporationId} with ${amount} R from ${ledgerLabel(from)} (ordinary injection; the bank was not failed).`,
    major: wasFailed,
    classificationExtra: {
      recapitalization: {
        bankCorporationId: corporationId,
        amountRubars: amount,
        cured,
        // The derivation's clearing signal: a curing injection
        // clears earlier uncured failed-payment rejections. On a
        // bank with none standing the stamp is vacuous; on a
        // non-curing injection it is false and nothing clears.
        curesFailedPayment: cured,
        netWorthBeforeRubars: sheetBefore?.netWorthRubars ?? null,
        netWorthAfterRubars: sheetAfter?.netWorthRubars ?? null,
      },
    },
  });
}

function recapitalizeBankReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId), ...situationKeyQueries(record.cityId));
  }
  const from = parseLedgerRef(record.from);
  if (from?.kind === "company") paths.push(corporationPath(from.cityId, from.corporationId));
  if (from?.kind === "treasury") paths.push(cityPath(from.cityId), `factions/${from.cityId}`);
  if (from?.kind === "personal") paths.push(memberAccountPath(from.memberId));
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-10 — liquidate_bank (amendment §5). The waterfall, run ONCE, in
// one Resolution Event, over figures frozen at the event's first
// entry seq (REC-5: principal + credited + computable unsettled
// interest at the failure seq — one basis for tier (c), coverage,
// and setoff). Order: (a) taxes, (b) adjudicated payables (none
// stand in this build — the derivation reads the corp doc's field,
// which no Phase 5 verb writes), (c) depositors pro-rata on FULL
// frozen claims net of setoff, (d) shareholders. B-13 pays inside
// this event and nowhere else: FIRST the senior queue (earlier
// failures' unpaid covered shortfalls, REC-7), then this failure's
// covered shortfalls. Loans ASSIGN to the depositor pool with
// setoff applied in-event; the charter surrenders and the company
// dissolves in the same event (its payouts validate against the
// estate's gross cash because the surrender lands in the plan
// before the lines do). NO recursive liquidation: an interbank
// loss this event evidences (RIDER-7 propagation lines) is
// recognized by the affected bank's own derivation afterwards —
// if it fails, that is a later event, player- or
// derivation-triggered like any other.
// ---------------------------------------------------------------------------

function refKey(ref: LedgerRef): string {
  switch (ref.kind) {
    case "personal":
      return `personal:${ref.memberId}`;
    case "company":
      return `company:${ref.cityId}:${ref.corporationId}`;
    case "treasury":
      return `treasury:${ref.cityId}`;
    case "market":
      return "market";
    case "exterior":
      return "exterior";
    case "institution":
      return `institution:${ref.institutionId}`;
  }
}

interface LiquidationDepositFigure {
  deposit: BankDepositRecord;
  frozenClaim: number;
  setoff: number;
  netClaim: number;
  covered: number;
  estatePaid: number;
  fundPaid: number;
  fundShortfall: number;
}

function liquidateBankHandler(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-10";
  const tierB = rejectTierBNpc(ctx, descriptorId);
  if (tierB) return tierB;
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const bank: BankTarget & { cityId: string; corporationId: string } = { ...bankOrPlan, cityId, corporationId };
  const ownerId = bank.corp.ownerMemberId as string;
  const actorId = actorMemberId(ctx.action.actor);
  const trigger = sa(ctx.action).trigger === "depositor" ? "depositor" : "owner";
  if (trigger === "owner") {
    if (!actorId || actorId !== ownerId) {
      return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], "B-10: voluntary liquidation is the bank owner's act. A depositor's trigger requires trigger: \"depositor\" and a derived failure.");
    }
  } else {
    const depositId = stringField(ctx.action, "depositId");
    const triggerDeposit = depositId ? depositRecordOf(snapshotDoc(ctx.snapshot, bankDepositPath(depositId))) : null;
    if (!triggerDeposit || triggerDeposit.bankCorporationId !== corporationId || triggerDeposit.status !== "active") {
      return rejectedPlan(descriptorId, "trigger-deposit-not-active", [descriptorId], "B-10: the depositor trigger names an ACTIVE deposit at this bank held by the actor.");
    }
    const control = borrowerControlRejection(ctx, descriptorId, triggerDeposit.depositor);
    if (control) {
      return rejectedPlan(descriptorId, "trigger-not-depositor", [descriptorId], "B-10: the actor does not control the named trigger deposit.");
    }
    if (deriveBankHealth(bank.corp) !== "insolvent") {
      return rejectedPlan(descriptorId, "bank-not-failed", [descriptorId], `B-10: ${corporationId} does not derive failed on the REC-6 identity (solvent and liquid on its standing sheet) — a depositor's trigger requires a failed bank. (A bank failed ONLY by an uncured failed payment — solvent on paper, bounced in fact — awaits the Log-slice read seam named in the prep report; the owner may always liquidate voluntarily.)`);
    }
  }

  // -- Read completeness (fail-closed) --------------------------------
  const depositRows = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
    .map(({ doc }) => depositRecordOf(doc))
    .filter((d): d is BankDepositRecord => d !== null && d.bankCorporationId === corporationId);
  const loanRows = queryDocs(ctx.snapshot, "bankLoans", "sim_bank_loans")
    .map(({ doc }) => loanRecordOf(doc))
    .filter((l): l is BankLoanRecord => l !== null && l.bankCorporationId === corporationId);
  const activeDeposits = depositRows.filter((d) => d.status === "active");
  const activeLoans = loanRows.filter((l) => l.status === "active");
  for (const ref of [
    ...activeDeposits.map((d) => d.depositor),
    ...activeLoans.map((l) => l.borrower),
  ]) {
    if (ref.kind === "company" && !snapshotDoc(ctx.snapshot, corporationPath(ref.cityId, ref.corporationId))) {
      return rejectedPlan(descriptorId, "liquidation-read-incomplete", [descriptorId], `B-10: the liquidation's read set does not cover corporation ${ref.corporationId} in ${ref.cityId} — a waterfall over a partial claimant set is not a waterfall. Name every involved city in the action's target cities and re-file.`);
    }
  }

  const plan = emptyPlan(descriptorId);
  const freezeSeq = ctx.snapshot.counterHead.lastSeq + 1;
  const liquidationId = `liq_${ctx.resolutionId}`;
  const fund = snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH);
  const ladder = bankPremiumLadder(ctx.snapshot, corporationId);

  // -- Charter surrender FIRST (the estate posture) -------------------
  planMutate(plan, ctx.snapshot, bank.corpPath, "state", ["bank", "status", "retiredShares"], (current) => {
    if (!current) return current;
    const block = bankBlockOf(current as unknown as Record<string, unknown>);
    return {
      ...current,
      bank: block ? { ...block, status: "surrendered" } : current.bank,
      status: "dissolved",
      retiredShares:
        (typeof current.retiredShares === "number" ? current.retiredShares : 0) +
        (typeof current.sharesOutstanding === "number" ? current.sharesOutstanding : 0),
    };
  });

  // -- Freeze + setoff (§5.3, BNK-D16) --------------------------------
  const figures = new Map<string, LiquidationDepositFigure>();
  for (const deposit of activeDeposits) {
    figures.set(deposit.depositId, {
      deposit,
      frozenClaim: frozenClaimOf(deposit, accruedUnsettledRubars(deposit, freezeSeq)),
      setoff: 0,
      netClaim: 0,
      covered: 0,
      estatePaid: 0,
      fundPaid: 0,
      fundShortfall: 0,
    });
  }
  const setoffByLoan = new Map<string, number>();
  const loansByBorrower = new Map<string, BankLoanRecord[]>();
  for (const loan of activeLoans) {
    const key = refKey(loan.borrower);
    loansByBorrower.set(key, [...(loansByBorrower.get(key) ?? []), loan]);
  }
  const depositsByDepositor = new Map<string, BankDepositRecord[]>();
  for (const deposit of activeDeposits) {
    const key = refKey(deposit.depositor);
    depositsByDepositor.set(key, [...(depositsByDepositor.get(key) ?? []), deposit]);
  }
  for (const [key, deposits] of depositsByDepositor) {
    const loans = (loansByBorrower.get(key) ?? []).slice().sort((a, b) => a.loanId.localeCompare(b.loanId));
    let owed = loans.reduce((sum, l) => sum + l.outstandingRubars, 0);
    if (owed <= 0) continue;
    for (const deposit of deposits.slice().sort((a, b) => a.depositId.localeCompare(b.depositId))) {
      const figure = figures.get(deposit.depositId);
      if (!figure || owed <= 0) continue;
      const applied = Math.min(figure.frozenClaim, owed);
      figure.setoff = applied;
      owed -= applied;
      let remaining = applied;
      for (const loan of loans) {
        if (remaining <= 0) break;
        const room = loan.outstandingRubars - (setoffByLoan.get(loan.loanId) ?? 0);
        const take = Math.min(room, remaining);
        if (take > 0) {
          setoffByLoan.set(loan.loanId, (setoffByLoan.get(loan.loanId) ?? 0) + take);
          remaining -= take;
        }
      }
    }
  }
  for (const figure of figures.values()) {
    figure.netClaim = figure.frozenClaim - figure.setoff;
  }
  // Coverage (§5.5): per depositor, the cap applies across their
  // ELIGIBLE deposits' combined net claims.
  const fundRecord = fundRecordOf(fund);
  for (const [, deposits] of depositsByDepositor) {
    const eligible = deposits.filter((d) =>
      depositCoveredClass(d, {
        fund: fundRecord,
        bankOwnerMemberId: ownerId,
        suspensionIntervals: ladder.suspensionIntervals,
      })
    );
    const eligibleNet = eligible.reduce((sum, d) => sum + (figures.get(d.depositId)?.netClaim ?? 0), 0);
    let coveredTotal = Math.min(eligibleNet, COVERAGE_CAP_RUBARS);
    const sorted = eligible.slice().sort((a, b) => (figures.get(b.depositId)?.netClaim ?? 0) - (figures.get(a.depositId)?.netClaim ?? 0));
    for (const deposit of sorted) {
      const figure = figures.get(deposit.depositId);
      if (!figure) continue;
      const share =
        deposit === sorted[sorted.length - 1]
          ? coveredTotal
          : eligibleNet > 0
            ? Math.floor((coveredTotal * figure.netClaim) / Math.max(eligibleNet, 1))
            : 0;
      figure.covered = Math.min(share, figure.netClaim);
      coveredTotal -= figure.covered;
    }
  }

  // -- The waterfall ----------------------------------------------------
  const cash = typeof bank.corp.companyCashRubars === "number" ? bank.corp.companyCashRubars : 0;
  const lines: TransferLine[] = [];
  const taxPayables = (bank.corp.taxPayables as Record<string, number> | undefined) ?? {};
  const taxCities = Object.keys(taxPayables).filter((c) => taxPayables[c] > 0);
  const taxTotal = taxCities.reduce((sum, c) => sum + taxPayables[c], 0);
  const taxDistribution = distributeProRata(
    Math.min(cash, taxTotal),
    taxCities.map((c) => ({ key: c, weight: taxPayables[c], cap: taxPayables[c] }))
  );
  let taxPaidTotal = 0;
  for (const taxCity of taxCities) {
    const paid = taxDistribution.payouts.get(taxCity) ?? 0;
    taxPaidTotal += paid;
    if (paid > 0) {
      lines.push({
        from: corporationRef(cityId, corporationId),
        to: treasuryRef(taxCity),
        amountRubars: paid,
        ruleId: descriptorId,
        memo: `liquidation waterfall tier (a) — taxes owed to ${taxCity}`,
      });
    }
  }
  let cashLeft = cash - taxPaidTotal;
  const tierCDistribution = distributeProRata(
    cashLeft,
    activeDeposits.map((d) => {
      const net = figures.get(d.depositId)?.netClaim ?? 0;
      return { key: d.depositId, weight: net, cap: net };
    })
  );
  let estatePaidTotal = 0;
  for (const deposit of activeDeposits) {
    const figure = figures.get(deposit.depositId);
    const paid = tierCDistribution.payouts.get(deposit.depositId) ?? 0;
    if (figure) figure.estatePaid = paid;
    estatePaidTotal += paid;
  }
  cashLeft -= estatePaidTotal;
  for (const figure of figures.values()) {
    if (figure.estatePaid > 0) {
      lines.push({
        from: corporationRef(cityId, corporationId),
        to: figure.deposit.depositor,
        amountRubars: figure.estatePaid,
        ruleId: descriptorId,
        memo: `liquidation waterfall tier (c) — estate payment on frozen claim ${figure.frozenClaim} R (net ${figure.netClaim} R after setoff)`,
      });
    }
  }
  // B-13: senior queue first, then this failure's top-ups.
  let fundCashLeft = fund ? fundCashOf(fund) : 0;
  const seniorPaid: { deposit: BankDepositRecord; paid: number }[] = [];
  if (fund) {
    const allDeposits = queryDocs(ctx.snapshot, "allDeposits", "sim_bank_deposits")
      .map(({ doc }) => depositRecordOf(doc))
      .filter((d): d is BankDepositRecord => d !== null);
    for (const queued of queuedShortfallsOf(allDeposits)) {
      if (fundCashLeft <= 0) break;
      const paid = Math.min(queued.shortfallRubars, fundCashLeft);
      if (paid <= 0) continue;
      const queuedRecord = allDeposits.find((d) => d.depositId === queued.depositId);
      if (!queuedRecord) continue;
      fundCashLeft -= paid;
      seniorPaid.push({ deposit: queuedRecord, paid });
      lines.push({
        from: difRef(),
        to: queued.depositor,
        amountRubars: paid,
        ruleId: "B-13",
        memo: `B-13 senior queue — queued covered shortfall from the liquidation of ${queued.bankCorporationId} settles before any newer failure's top-ups (REC-7)`,
      });
    }
    const topUps = [...figures.values()].map((figure) => {
      const estateOnCovered =
        figure.netClaim > 0 ? Math.floor((figure.estatePaid * figure.covered) / figure.netClaim) : 0;
      return { figure, due: Math.max(0, figure.covered - estateOnCovered) };
    });
    const topUpDistribution = distributeProRata(
      fundCashLeft,
      topUps.map((t) => ({ key: t.figure.deposit.depositId, weight: t.due, cap: t.due }))
    );
    for (const t of topUps) {
      const paid = topUpDistribution.payouts.get(t.figure.deposit.depositId) ?? 0;
      t.figure.fundPaid = paid;
      t.figure.fundShortfall = t.due - paid;
      fundCashLeft -= paid;
      if (paid > 0) {
        lines.push({
          from: difRef(),
          to: t.figure.deposit.depositor,
          amountRubars: paid,
          ruleId: "B-13",
          memo: `B-13 payout inside liquidation ${liquidationId} — covered shortfall on deposit ${t.figure.deposit.depositId}${t.figure.fundShortfall > 0 ? `; ${t.figure.fundShortfall} R queues senior unpaid (REC-7)` : ""}`,
        });
      }
    }
  }
  // (d) shareholders.
  const holdingRows = queryDocs(ctx.snapshot, "bankHoldings", "sim_holdings").filter(
    ({ doc }) => doc.corporationId === corporationId && typeof doc.quantityShares === "number" && doc.quantityShares > 0
  );
  const dividendDistribution = distributeProRata(
    cashLeft,
    holdingRows.map((row) => ({
      key: row.path,
      weight: row.doc.quantityShares as number,
      cap: cashLeft,
    }))
  );
  let dividendsTotal = 0;
  for (const row of holdingRows) {
    const paid = dividendDistribution.payouts.get(row.path) ?? 0;
    dividendsTotal += paid;
    if (paid > 0) {
      lines.push({
        from: corporationRef(cityId, corporationId),
        to: personalRef(row.doc.memberId as string),
        amountRubars: paid,
        ruleId: descriptorId,
        memo: "liquidation waterfall tier (d) — residual to shareholders pro-rata",
      });
    }
  }
  cashLeft -= dividendsTotal;

  const appliedLines = applyTransferLines({ plan, snapshot: ctx.snapshot, lines, shortfallClass: "custodial" });
  if (!appliedLines.ok) {
    return rejectedPlan(descriptorId, "waterfall-unpayable", [descriptorId], `B-10: the waterfall does not validate: ${appliedLines.message}`);
  }
  const tagged: TaggedChange[] = [...appliedLines.changes];

  // -- Senior-queue record updates --------------------------------------
  // The corporation's own changes are appended at entry-build time
  // (below), once every aggregate mutate has folded — F-02 chains
  // the whole-block change to the write's final block.
  const recordChanges: SimChange[] = [];
  const recordsUpdated: string[] = [bank.corpPath];
  for (const { deposit, paid } of seniorPaid) {
    const path = bankDepositPath(deposit.depositId);
    planMutate(plan, ctx.snapshot, path, "state", ["liquidation.fundPaidRubars", "liquidation.fundShortfallRubars"], (current) => {
      if (!current) return current;
      const record = current as unknown as BankDepositRecord;
      if (!record.liquidation) return current;
      return {
        ...current,
        liquidation: {
          ...record.liquidation,
          fundPaidRubars: record.liquidation.fundPaidRubars + paid,
          fundShortfallRubars: record.liquidation.fundShortfallRubars - paid,
        },
      };
    });
    recordChanges.push(
      fieldChange(`bankDeposits/${deposit.depositId}.liquidation.fundShortfallRubars`, deposit.liquidation?.fundShortfallRubars ?? 0, (deposit.liquidation?.fundShortfallRubars ?? 0) - paid, "B-13 senior queue — the queued shortfall settles inside this liquidation, before its own top-ups")
    );
    recordsUpdated.push(path);
  }

  // -- Assignment + deposit sweep ----------------------------------------
  const aggregateDeltas: { field: "loanBookRubars" | "insiderLoansRubars" | "depositLiabilitiesRubars" | "seizedAssetsRubars"; amount: number }[] = [
    { field: "loanBookRubars", amount: -(typeof bank.bank.loanBookRubars === "number" ? bank.bank.loanBookRubars : 0) },
    { field: "insiderLoansRubars", amount: -(typeof bank.bank.insiderLoansRubars === "number" ? bank.bank.insiderLoansRubars : 0) },
    { field: "depositLiabilitiesRubars", amount: -(typeof bank.bank.depositLiabilitiesRubars === "number" ? bank.bank.depositLiabilitiesRubars : 0) },
    { field: "seizedAssetsRubars", amount: -seizedAssetsOf(bank.bank) },
  ];
  for (const delta of aggregateDeltas) {
    if (delta.amount !== 0) tagged.push(applyBankAggregateDelta(plan, ctx, bank, delta.field, delta.amount, descriptorId));
  }
  for (const loan of activeLoans) {
    const setoff = setoffByLoan.get(loan.loanId) ?? 0;
    planMutate(plan, ctx.snapshot, bankLoanPath(loan.loanId), "state", ["status", "assignee", "assignedAtSeq", "outstandingRubars", "setoffAppliedRubars"], (current) => {
      if (!current) return current;
      return {
        ...current,
        status: "assigned",
        assignee: `depositor-pool:${corporationId}`,
        assignedAtSeq: freezeSeq,
        outstandingRubars: loan.outstandingRubars - setoff,
        setoffAppliedRubars: loan.setoffAppliedRubars + setoff,
      };
    });
    recordsUpdated.push(bankLoanPath(loan.loanId));
  }
  for (const figure of figures.values()) {
    const deposit = figure.deposit;
    planMutate(plan, ctx.snapshot, bankDepositPath(deposit.depositId), "state", ["status", "liquidation"], (current) => {
      if (!current) return current;
      return {
        ...current,
        status: "assigned",
        liquidation: {
          liquidationId,
          liquidationResolutionId: ctx.resolutionId,
          bankCorporationId: corporationId,
          frozenClaimRubars: figure.frozenClaim,
          coveredRubars: figure.covered,
          uninsuredRubars: figure.netClaim - figure.covered,
          setoffRubars: figure.setoff,
          estatePaidRubars: figure.estatePaid,
          fundPaidRubars: figure.fundPaid,
          fundShortfallRubars: figure.fundShortfall,
          poolDistributedRubars: 0,
          fundRecoveredRubars: 0,
          liquidatedAtSeq: freezeSeq,
        },
      };
    });
    recordsUpdated.push(bankDepositPath(deposit.depositId));
  }
  // The fund's insured aggregate sheds this bank's contribution.
  if (fund) {
    const shed = insuredLiabilitiesForBank({
      deposits: activeDeposits,
      bankCorporationId: corporationId,
      fund: fundRecord,
      bankOwnerMemberId: ownerId,
      suspensionIntervals: ladder.suspensionIntervals,
    });
    if (shed > 0) {
      planMutate(plan, ctx.snapshot, INSURANCE_FUND_PATH, "state", ["totalInsuredLiabilitiesRubars"], (current) => {
        if (!current) return current;
        const before = typeof current.totalInsuredLiabilitiesRubars === "number" ? current.totalInsuredLiabilitiesRubars : 0;
        return { ...current, totalInsuredLiabilitiesRubars: before - shed };
      });
      recordChanges.push(
        fieldChange("institutionAccount.totalInsuredLiabilitiesRubars", insuredAggregateOf(fund), insuredAggregateOf(fund) - shed, "B-10 — the liquidated bank's deposits leave the insured aggregate as their claims sweep to the pool (A-B6)")
      );
      recordsUpdated.push(INSURANCE_FUND_PATH);
    }
  }
  // Shares retire with the dissolution.
  const recordsCreated: string[] = [];
  for (const row of holdingRows) {
    planWrite(plan, ctx.snapshot, row.path, null, "state", ["quantityShares", "committedShares"]);
    recordsUpdated.push(row.path);
    recordChanges.push(
      fieldChange(`holdings/${row.doc.memberId as string}__${corporationId}.quantityShares`, row.doc.quantityShares as number, 0, "B-10 — the dissolved bank's shares retire with the company (holdings close; retiredShares carries the count)")
    );
  }

  // -- Propagation lines (RIDER-7) ---------------------------------------
  const propagation: Record<string, unknown>[] = [];
  for (const figure of figures.values()) {
    const depositor = figure.deposit.depositor;
    if (depositor.kind !== "company") continue;
    const corp = snapshotDoc(ctx.snapshot, corporationPath(depositor.cityId, depositor.corporationId));
    const theirBank = corp ? bankBlockOf(corp) : null;
    if (!theirBank || theirBank.status !== "active") continue;
    const poolUnpaid = figure.netClaim - figure.estatePaid - figure.fundPaid;
    propagation.push({
      sourceInstitutionId: corporationId,
      exposureRecordId: figure.deposit.depositId,
      edgeKind: "interbank-deposit",
      amountBefore: figure.frozenClaim,
      amountAfter: figure.estatePaid + figure.fundPaid,
      lossRecognized: figure.netClaim - figure.estatePaid - figure.fundPaid,
      ruleId: "B-10",
      causedBySeq: freezeSeq,
      idempotenceKey: `${figure.deposit.depositId}:${liquidationId}:${freezeSeq}`,
      poolClaimOutstandingRubars: poolUnpaid,
    });
  }

  // -- Cards: D1 per depositor, B6/B7 per borrower, K5, K2 terminal ------
  const cardSeq = freezeSeq + 1;
  const situationClaims = { created: [] as string[], updated: [] as string[] };
  for (const [key, deposits] of depositsByDepositor) {
    const depositor = deposits[0].depositor;
    const totals = deposits.reduce(
      (acc, d) => {
        const f = figures.get(d.depositId);
        if (!f) return acc;
        return {
          frozen: acc.frozen + f.frozenClaim,
          covered: acc.covered + f.covered,
          estate: acc.estate + f.estatePaid,
          fundPaid: acc.fundPaid + f.fundPaid,
          shortfall: acc.shortfall + f.fundShortfall,
          setoff: acc.setoff + f.setoff,
          pool: acc.pool + (f.netClaim - f.estatePaid - f.fundPaid),
        };
      },
      { frozen: 0, covered: 0, estate: 0, fundPaid: 0, shortfall: 0, setoff: 0, pool: 0 }
    );
    const addressing = situationAddressingFor(ctx.snapshot, depositor, cityId);
    const card = mintSituation(
      plan,
      ctx,
      rekeyCard(buildIncidentSituation({
        cityId,
        audienceCityId: cityId,
        audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
        recipientUid: addressing.recipientUid ?? null,
        severity: "major",
        createdSeq: cardSeq,
        now: ctx.snapshot.now,
        sourceSeq: freezeSeq,
        sourceResolutionId: ctx.resolutionId,
        title: `${corporationId} has been liquidated — your claim`,
        summary: `${corporationId} was liquidated at seq ${freezeSeq}. Your frozen claim: ${totals.frozen} R${totals.setoff > 0 ? ` (${totals.setoff} R set off against your borrowing)` : ""}. The estate paid ${totals.estate} R; the Deposit Insurance Fund paid ${totals.fundPaid} R of your ${totals.covered} R covered portion${totals.shortfall > 0 ? `; ${totals.shortfall} R of covered shortfall queues senior unpaid` : ""}. ${totals.pool} R stands as your pool claim against the bank's assigned loan book.`,
        consequenceSummary: `Covered portion: ${totals.covered} R (cap ${COVERAGE_CAP_RUBARS} R per depositor per bank); uninsured: ${totals.frozen - totals.setoff - totals.covered} R. Pool distributions route first to the fund until its payout on your claim is recovered (subrogation — derived, never stored), then to you. The pool closing entry will supersede this card with final figures.`,
        ask: "No action is required. Borrowers repay the pool under B-07's pool form; distributions arrive as events, each logged.",
        amountRubars: totals.frozen,
        subject: { kind: "corporation", id: corporationId },
      }), `d1:${key}`)
    );
    situationClaims.created.push(...card.created);
    situationClaims.updated.push(...card.updated);
  }
  for (const [key, loans] of loansByBorrower) {
    const assigned = loans.filter((l) => l.status === "active");
    if (assigned.length === 0) continue;
    const borrower = assigned[0].borrower;
    const addressing = situationAddressingFor(ctx.snapshot, borrower, cityId);
    const linesText = assigned
      .map((l) => {
        const setoff = setoffByLoan.get(l.loanId) ?? 0;
        return `loan ${l.loanId}: outstanding ${l.outstandingRubars - setoff} R assigned to the depositor pool${setoff > 0 ? ` (setoff of ${setoff} R applied against your deposits at this bank — your net position was computed claim-first, BNK-D16)` : ""}; schedule and collateral unchanged`;
      })
      .join("; ");
    const card = mintSituation(
      plan,
      ctx,
      rekeyCard(buildIncidentSituation({
        cityId,
        audienceCityId: cityId,
        audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
        recipientUid: addressing.recipientUid ?? null,
        severity: "important",
        createdSeq: cardSeq,
        now: ctx.snapshot.now,
        sourceSeq: freezeSeq,
        sourceResolutionId: ctx.resolutionId,
        title: `Your loans at ${corporationId} are assigned to the depositor pool`,
        summary: `${corporationId} was liquidated; its loan book assigns to the depositor pool. ${linesText}.`,
        consequenceSummary: "Repayment continues under B-07's pool form — same schedule, same rates, same collateral. Excess obligations beyond your claims survive as unsecured pool obligations, stated per loan above.",
        ask: "Keep repaying on schedule — to the pool now. Nothing else changes.",
        subject: { kind: "corporation", id: corporationId },
      }), `b6:${key}`)
    );
    situationClaims.created.push(...card.created);
    situationClaims.updated.push(...card.updated);
  }
  if (trigger === "depositor") {
    const addressing = situationAddressingFor(ctx.snapshot, personalRef(ownerId), cityId);
    const card = mintSituation(
      plan,
      ctx,
      rekeyCard(buildIncidentSituation({
        cityId,
        audienceCityId: cityId,
        audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
        recipientUid: ownerId,
        severity: "major",
        createdSeq: cardSeq,
        now: ctx.snapshot.now,
        sourceSeq: freezeSeq,
        sourceResolutionId: ctx.resolutionId,
        title: `Your bank ${corporationId} was liquidated on a depositor's trigger`,
        summary: `A depositor of ${corporationId} exercised the B-10 trigger against a bank deriving failed; the waterfall ran in this event. Depositor claims froze at seq ${freezeSeq}; the charter is surrendered and the company dissolved.`,
        consequenceSummary: "The full waterfall, the frozen figures, and every payout stand in this event's Log entries. Your controller position is barred from a new charter under B-01's controller bar until its conditions pass.",
        ask: "No action is available — liquidation is final. The Log is the record.",
        subject: { kind: "corporation", id: corporationId },
      }), "k5")
    );
    situationClaims.created.push(...card.created);
    situationClaims.updated.push(...card.updated);
  }
  const episodeStanding = findSituation(
    ctx,
    (doc) =>
      doc.dedupeKey ===
        dedupeKeyFor({
          sourceKind: "system",
          sourceId: episodeSourceId(`bank:${corporationId}`, "failed-payment"),
          situationKind: "incident",
          audienceKey: cityId,
        }) && doc.status === "open"
  );
  if (episodeStanding) {
    const closedPath = closeSituationWhere(plan, ctx, (doc) => doc.situationId === episodeStanding.situationId, {
      resolvedSeq: freezeSeq,
      resolutionId: ctx.resolutionId,
    });
    if (closedPath) situationClaims.updated.push(closedPath);
  }

  // -- Entries ------------------------------------------------------------
  recordChanges.push(
    fieldChange(`corporations/${corporationId}.status`, bank.corp.status ?? null, "dissolved", "B-10 liquidation — the company dissolves in the event that runs its waterfall"),
    fieldChange(`corporations/${corporationId}.bank`, bank.bank, bankBlockOf(plannedDoc(plan, ctx.snapshot, bank.corpPath) ?? {}) ?? bank.bank, "B-10 liquidation — the charter surrenders (bank block status active → surrendered) and its aggregates zero as the claims sweep; the premium chain ends (no successor after the charter ends, SPEC-1)"),
    fieldChange(`corporations/${corporationId}.retiredShares`, typeof bank.corp.retiredShares === "number" ? bank.corp.retiredShares : 0, (typeof bank.corp.retiredShares === "number" ? bank.corp.retiredShares : 0) + (typeof bank.corp.sharesOutstanding === "number" ? bank.corp.sharesOutstanding : 0), "B-10 — the dissolved bank's shares retire with the company")
  );
  // Split by F-02's grammar: the corporation's own changes are
  // city-relative (they reconcile against the city doc); the
  // top-level-collection changes (deposit blocks, holding
  // retirements, the fund aggregate) ride a realm entry, the
  // Phase 4 convention for such records.
  const cityRecordChanges = recordChanges.filter((c) => c.field.startsWith("corporations/"));
  const realmRecordChanges = recordChanges.filter((c) => !c.field.startsWith("corporations/"));
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId,
      cityIds: [cityId],
      ruleIds: [descriptorId],
      major: true,
      changes: cityRecordChanges,
      recordsCreated: [],
      recordsUpdated: [bank.corpPath],
      summaryText: `B-10: ${corporationId} liquidated (${trigger} trigger) — claims frozen at seq ${freezeSeq} on the REC-5 basis. Waterfall: (a) taxes ${taxPaidTotal} R; (b) adjudicated 0 R (no adjudicated payables stand); (c) depositors ${estatePaidTotal} R pro-rata on full frozen claims; B-13 paid ${seniorPaid.reduce((s, p) => s + p.paid, 0)} R of senior queued shortfalls BEFORE this failure's top-ups of ${[...figures.values()].reduce((s, f) => s + f.fundPaid, 0)} R; (d) shareholders ${dividendsTotal} R; ${cashLeft} R remains as dust on the dissolved record. ${activeLoans.length} loan(s) assigned to depositor-pool:${corporationId} with setoff applied in-event. No bank was liquidated recursively in this pass — interbank losses stand as propagation lines for the affected banks' own derivations.`,
    })
  );
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      major: true,
      changes: realmRecordChanges,
      recordsCreated: [...recordsCreated, ...situationClaims.created],
      recordsUpdated: [...recordsUpdated.filter((p) => p !== bank.corpPath), ...situationClaims.updated],
      summaryText: `B-10: ${corporationId}'s claim records sweep to the depositor pool — deposit liquidation blocks stamped (frozen claim, coverage split, setoff, estate/fund payments), senior-queue settlements recorded, shares retired, and the fund's insured aggregate shed of this bank's contribution.`,
    })
  );
  pushMovementEntries(plan, ctx, descriptorId, tagged, (entryCityId) =>
    entryCityId === cityId
      ? `B-10: ${corporationId}'s estate movements — the waterfall's cash legs and the zeroing of its loan book, insider book, deposit liabilities, and seized-asset aggregate as the claims sweep to the pool (A-B1/A-B2/A-B7 pairs).`
      : entryCityId === null
        ? "B-10: the Deposit Insurance Fund's legs — B-13 payouts inside this liquidation only (senior queue first), and the insured aggregate shedding the failed bank's contribution (A-B6)."
        : `B-10: a payee ledger in ${entryCityId} received its waterfall share of ${corporationId}'s liquidation.`
  );

  const fundAfter = fund ? plannedDoc(plan, ctx.snapshot, INSURANCE_FUND_PATH) : null;
  const fundAfterRecord = fundRecordOf(fundAfter);
  const totalInsuredAfter = fundAfter ? insuredAggregateOf(fundAfter) : 0;
  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + 1;
  const deficientAfter = fundAfterRecord
    ? fundDeficient({ fund: fundAfterRecord, insuredLiabilitiesRubars: totalInsuredAfter, atSeq: summarySeq })
    : false;
  const deficitAfter = fundAfter ? Math.max(0, fundTargetBalanceRubars(totalInsuredAfter) - fundCashOf(fundAfter)) : 0;
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "liquidate-bank",
    scope: "bank",
    cityId,
    summaryText: `Liquidated ${corporationId} (${trigger} trigger): waterfall ran over claims frozen at seq ${freezeSeq}; ${activeLoans.length} loan(s) assigned to the depositor pool; charter surrendered, company dissolved.${fund ? ` Fund ${deficientAfter ? `derives DEFICIENT after this event (deficit ${deficitAfter} R) — B-14 supplemental assessments arise against surviving banks at their next premium ripenings, computed exactly from each bank's own insured liabilities` : "remains within its target ratio"}.` : ""}`,
    major: true,
    classificationExtra: {
      banking: {
        bankCorporationId: corporationId,
        controllerMemberId: ownerId,
        liquidationId,
        trigger,
        failureSeq: freezeSeq,
      },
      propagation,
      dif: {
        seniorQueuePaidRubars: seniorPaid.reduce((s, p) => s + p.paid, 0),
        topUpsPaidRubars: [...figures.values()].reduce((s, f) => s + f.fundPaid, 0),
        queuedShortfallRubars: [...figures.values()].reduce((s, f) => s + f.fundShortfall, 0),
        deficientAfter,
        deficitRubars: deficitAfter,
      },
    },
  });
}

function fundCashOf(fundDoc: Record<string, unknown>): number {
  return typeof fundDoc.fundCashRubars === "number" ? fundDoc.fundCashRubars : 0;
}

function insuredAggregateOf(fundDoc: Record<string, unknown>): number {
  return typeof fundDoc.totalInsuredLiabilitiesRubars === "number"
    ? fundDoc.totalInsuredLiabilitiesRubars
    : 0;
}

function liquidateBankReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [
    {
      id: "allMemberAccounts",
      collectionPath: "sim_member_accounts",
      filters: [],
    },
    { id: "allCities", collectionPath: "sim_cities", filters: [] },
    { id: "allDeposits", collectionPath: "sim_bank_deposits", filters: [] },
  ];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(
      ...premiumQueries(record.corporationId),
      ...situationKeyQueries(record.cityId),
      {
        id: "bankDeposits",
        collectionPath: "sim_bank_deposits",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      },
      {
        id: "bankLoans",
        collectionPath: "sim_bank_loans",
        filters: [{ field: "bankCorporationId", op: "==", value: record.corporationId }],
      },
      {
        id: "bankHoldings",
        collectionPath: "sim_holdings",
        filters: [{ field: "corporationId", op: "==", value: record.corporationId }],
      }
    );
    const cityIds = new Set<string>([record.cityId]);
    const targets = (seeds.action as { targetCityIds?: unknown }).targetCityIds;
    if (Array.isArray(targets)) {
      for (const t of targets) if (typeof t === "string") cityIds.add(t);
    }
    for (const cid of cityIds) {
      queries.push({
        id: `cityCorporations_${cid}`,
        collectionPath: `sim_cities/${cid}/corporations`,
        filters: [],
      });
      paths.push(cityPath(cid), `factions/${cid}`);
    }
  }
  if (typeof record.depositId === "string" && record.depositId) {
    paths.push(bankDepositPath(record.depositId));
  }
  return { paths, queries };
}

// ---------------------------------------------------------------------------
// B-12 — pay_insurance_premium (amendment V2-§1.3, Tier A). Premiums
// are the bank owner's obligation, payable in full against the
// ripened markers the Log carries — never auto-debited (M5): the
// chain ripens, the marker lands, the Situation accumulates, and
// only this act moves money. The settlement summary's
// classification is the ladder derivation's input: what was settled
// (pending ids), how much, under which rule. Paying arrears in
// full cures delinquency/suspension BY DERIVATION — the ladder
// walk closes the interval at this event's seq; no flag flips.
// ---------------------------------------------------------------------------

function insurancePaymentHandler(ctx: HandlerContext, citesRule: "B-12" | "B-14"): ResolutionPlan {
  const descriptorId = citesRule;
  const bankOrPlan = parseBankTarget(ctx, descriptorId);
  if ("outcome" in bankOrPlan) return bankOrPlan;
  const cityId = stringField(ctx.action, "cityId") as string;
  const corporationId = stringField(ctx.action, "corporationId") as string;
  const bank: BankTarget & { cityId: string; corporationId: string } = { ...bankOrPlan, cityId, corporationId };
  const actorId = actorMemberId(ctx.action.actor);
  if (!actorId || actorId !== bank.corp.ownerMemberId) {
    return rejectedPlan(descriptorId, "not-bank-owner", [descriptorId], `${descriptorId}: insurance obligations are paid by the bank's owner (or their mandated NPC — the authority stage is the mandate's venue; the handler still requires the principal to be the owner).`);
  }
  const fund = snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH);
  if (!fund) {
    return rejectedPlan(descriptorId, "no-insurance-fund", [descriptorId], `${descriptorId}: no Deposit Insurance Fund stands — there is nothing to pay premiums into. Founding is an adoption act (BNK-D18).`);
  }
  let dueRubars = 0;
  let settledPendingIds: string[] = [];
  let obligationText = "";
  const ladderBefore = bankPremiumLadder(ctx.snapshot, corporationId);
  if (citesRule === "B-12") {
    dueRubars = ladderBefore.arrearsRubars;
    settledPendingIds = ladderBefore.unsettled.map((m) => m.pendingId);
    if (dueRubars <= 0 || settledPendingIds.length === 0) {
      return rejectedPlan(descriptorId, "no-premium-due", [descriptorId], "B-12: no ripened premium arrears stand for this bank — premiums are payable against ripened markers, never in advance and never by estimate.");
    }
    obligationText = `${settledPendingIds.length} ripened period(s) totaling ${dueRubars} R`;
  } else {
    const pendingId = stringField(ctx.action, "pendingId");
    if (!pendingId) {
      return rejectedPlan(descriptorId, "malformed-action", [descriptorId], "B-14: the action names pendingId — the assessment obligation it settles (assessments are per-obligation records, each settled by name).");
    }
    const outstanding = assessmentObligations(ctx.snapshot, corporationId);
    const obligation = outstanding.find((o) => o.pendingId === pendingId);
    if (!obligation) {
      return rejectedPlan(descriptorId, "assessment-not-due", [descriptorId], `B-14: no outstanding assessment obligation ${pendingId} stands for this bank — either it has not ripened (the obligation arises at ripening, not at creation) or it already stands settled in the Log.`);
    }
    dueRubars = obligation.dueRubars;
    settledPendingIds = [pendingId];
    obligationText = `the supplemental assessment of ${dueRubars} R arising from the fund's standing deficiency`;
  }
  const amount = positiveAmount(ctx.action);
  if (amount === null || amount !== dueRubars) {
    return rejectedPlan(descriptorId, "insurance-amount-mismatch", [descriptorId], `${descriptorId}: the payment must be the full standing obligation — ${dueRubars} R (${obligationText}). Partial premium payments are not a state the ladder knows; arrears settle whole or stand.`);
  }
  const plan = emptyPlan(descriptorId);
  const line: TransferLine = {
    from: corporationRef(cityId, corporationId),
    to: difRef(),
    amountRubars: amount,
    ruleId: citesRule,
    memo:
      citesRule === "B-12"
        ? `deposit-insurance premium — ${settledPendingIds.length} period(s) in full`
        : "B-14 supplemental assessment — paid in full",
  };
  const applied = applyTransferLines({ plan, snapshot: ctx.snapshot, lines: [line], shortfallClass: "transfer" });
  if (!applied.ok) {
    return rejectedPlan(descriptorId, applied.code.toLowerCase().replace(/_/g, "-"), [descriptorId], `${descriptorId}: payment refused: ${applied.message}`);
  }
  // K3/K4: the bank's accumulated premium card terminals in this
  // event when the settlement clears what the card carries.
  const situationClaims = { created: [] as string[], updated: [] as string[] };
  const standingCard = findSituation(
    ctx,
    (doc) =>
      doc.status === "open" &&
      doc.kind === "system" &&
      (doc.detail as Record<string, unknown> | null)?.premiumChain === true &&
      (doc.detail as Record<string, unknown> | null)?.bankCorporationId === corporationId
  );
  const summarySeq = ctx.snapshot.counterHead.lastSeq + plan.entries.length + groupChangesByEntryCity(applied.changes).size + 1;
  if (standingCard) {
    const closedPath = closeSituationWhere(plan, ctx, (doc) => doc.situationId === standingCard.situationId, {
      resolvedSeq: summarySeq,
      resolutionId: ctx.resolutionId,
    });
    if (closedPath) situationClaims.updated.push(closedPath);
  }
  pushMovementEntries(
    plan,
    ctx,
    descriptorId,
    applied.changes,
    (entryCityId) =>
      entryCityId === null
        ? `${descriptorId}: the Deposit Insurance Fund received ${amount} R from ${corporationId} — an inflow of the closed set (premiums, assessments, subrogated recoveries, governance grants; M10). Fund cash and the premium ladder both derive from these lines.`
        : `${descriptorId}: ${corporationId} paid its standing insurance obligation of ${amount} R in full. Ladder before: ${ladderBefore.state}; the derivation after this settlement reads current (arrears settled whole).`,
    { created: situationClaims.created, updated: situationClaims.updated }
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: citesRule === "B-12" ? "pay-insurance-premium" : "pay-supplemental-assessment",
    scope: "bank",
    cityId,
    summaryText:
      citesRule === "B-12"
        ? `B-12: ${corporationId} paid ${amount} R of deposit-insurance premiums in full (${obligationText}). Ladder: ${ladderBefore.state} → current by derivation at this settlement. The fund's cash rose by the same figure — the pair is this entry and the fund's movement entry.`
        : `B-14: ${corporationId} paid its supplemental assessment of ${amount} R in full. The fund's deficiency position re-derives from its standing sheet.`,
    classificationExtra: {
      premiumSettlement: {
        bankCorporationId: corporationId,
        settledPendingIds,
        totalPaidRubars: amount,
        citesRule,
        ladderBefore: ladderBefore.state,
      },
    },
  });
}

function payInsurancePremiumHandler(ctx: HandlerContext): ResolutionPlan {
  return insurancePaymentHandler(ctx, "B-12");
}

function paySupplementalAssessmentHandler(ctx: HandlerContext): ResolutionPlan {
  return insurancePaymentHandler(ctx, "B-14");
}

/** Outstanding B-14 assessment obligations for a bank, derived
 * from the standing Log: ripened assessment markers minus the
 * settlements citing B-14. */
function assessmentObligations(
  snapshot: SimSnapshot,
  bankCorporationId: string
): { pendingId: string; dueRubars: number; deficitRubars: number | null }[] {
  const markers = queryDocs(snapshot, "assessmentMarkers", "sim_log_entries");
  const settlements = queryDocs(snapshot, "premiumSettlements", "sim_log_entries");
  const settled = new Set<string>();
  for (const { doc } of settlements) {
    const classification = (doc.classification ?? {}) as Record<string, unknown>;
    const settlement = classification.premiumSettlement as
      | { settledPendingIds?: unknown; citesRule?: unknown }
      | undefined;
    if (settlement?.citesRule === "B-14" && Array.isArray(settlement.settledPendingIds)) {
      for (const id of settlement.settledPendingIds) if (typeof id === "string") settled.add(id);
    }
  }
  const out: { pendingId: string; dueRubars: number; deficitRubars: number | null }[] = [];
  for (const { doc } of markers) {
    const classification = (doc.classification ?? {}) as Record<string, unknown>;
    const due = classification.assessmentDue as
      | { bankCorporationId?: unknown; pendingId?: unknown; dueRubars?: unknown; deficitRubars?: unknown }
      | undefined;
    if (
      due?.bankCorporationId === bankCorporationId &&
      typeof due.pendingId === "string" &&
      typeof due.dueRubars === "number" &&
      !settled.has(due.pendingId)
    ) {
      out.push({
        pendingId: due.pendingId,
        dueRubars: due.dueRubars,
        deficitRubars: typeof due.deficitRubars === "number" ? due.deficitRubars : null,
      });
    }
  }
  return out;
}

function insurancePaymentReadPlan(citesRule: "B-12" | "B-14") {
  return (seeds: ReadPlanSeeds): DescriptorReadPlan => {
    const record = seeds.action.structuredAction ?? {};
    const paths: string[] = [INSURANCE_FUND_PATH];
    const queries: CollectionQuerySpec[] = [];
    if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
      paths.push(corporationPath(record.cityId, record.corporationId));
      queries.push(
        ...premiumQueries(record.corporationId),
        ...situationKeyQueries(record.cityId),
        {
          id: "assessmentMarkers",
          collectionPath: "sim_log_entries",
          filters: [
            {
              field: "classification.assessmentDue.bankCorporationId",
              op: "==",
              value: record.corporationId,
            },
          ],
        }
      );
    }
    return { paths, queries };
  };
}

// ---------------------------------------------------------------------------
// DIF founding (V2-§1.1, BNK-D18) — an ADOPTION ACT, exported for
// the Lead to wire to the Town Hall / genesis route. The act: the
// singleton record is created exactly once (a second act rejects
// fund-exists); the grandfathering election is NONE (pre-founding
// deposits derive uninsured for life — M12's only lawful
// alternative would have been an election stated here, and this
// build elects none); premium chains seed for every bank chartered
// at founding. The act moves NO money and changes NO posture copy
// (G5: surfaces derive the founded posture from this record
// through the one describeInsurancePosture path).
// ---------------------------------------------------------------------------

export function buildDifFoundingPlan(ctx: HandlerContext): ResolutionPlan {
  const descriptorId = "B-12";
  if (snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH)) {
    return rejectedPlan(descriptorId, "fund-exists", [descriptorId], "The Deposit Insurance Fund already stands — founding is a once-ever act (BNK-D18). A second founding is not a top-up; fund inflows are the closed set of B-12/B-14 settlements, subrogated recoveries, and governance grants.");
  }
  const plan = emptyPlan(descriptorId);
  const summarySeq = ctx.snapshot.counterHead.lastSeq + 2;
  // Insured aggregate at founding, derived honestly: under the
  // none election every pre-founding deposit is uninsured, so the
  // derivation over the standing book is 0 — computed, not assumed,
  // wherever the snapshot carries the book.
  const allDeposits = queryDocs(ctx.snapshot, "allDeposits", "sim_bank_deposits")
    .map(({ doc }) => depositRecordOf(doc))
    .filter((d): d is BankDepositRecord => d !== null);
  const charteredBanks: { corporationId: string; cityId: string; ownerMemberId: string }[] = [];
  for (const [path, doc] of ctx.snapshot.docs) {
    const match = /^sim_cities\/([^/]+)\/corporations\/([^/]+)$/.exec(path);
    if (!match || !doc) continue;
    const block = bankBlockOf(doc);
    if (block && block.status === "active" && typeof doc.ownerMemberId === "string") {
      charteredBanks.push({ corporationId: match[2], cityId: match[1], ownerMemberId: doc.ownerMemberId });
    }
  }
  const foundingRecord = fundRecordOf(
    buildDifFundDoc({
      establishedAtSeq: summarySeq,
      establishingEntryId: ctx.resolutionId,
      totalInsuredLiabilitiesRubars: 0,
    })
  );
  const aggregate = totalInsuredLiabilities({
    deposits: allDeposits,
    banks: charteredBanks.map((b) => ({ corporationId: b.corporationId, ownerMemberId: b.ownerMemberId })),
    fund: foundingRecord,
    suspensionIntervalsByBank: new Map(),
  });
  const fundDoc = buildDifFundDoc({
    establishedAtSeq: summarySeq,
    establishingEntryId: ctx.resolutionId,
    totalInsuredLiabilitiesRubars: aggregate,
  });
  planWrite(plan, ctx.snapshot, INSURANCE_FUND_PATH, fundDoc, "state", [
    "fundCashRubars",
    "totalInsuredLiabilitiesRubars",
    "establishedAtSeq",
  ]);
  for (const bank of charteredBanks) {
    const pendingId = `prem_${bank.corporationId}_0`;
    if (snapshotDoc(ctx.snapshot, `sim_pending_consequences/${pendingId}`)) continue;
    const draft = buildSchedulePendingDraft(ctx.snapshot, {
      pendingId,
      kind: "insurance-premium-due",
      originResolutionId: ctx.resolutionId,
      originActionId: ctx.action.actionId,
      originActor: ctx.action.actor,
      originCityId: bank.cityId,
      originSummaryText: `Deposit-insurance premium period 0 for ${bank.corporationId} (seeded at founding)`,
      targetCityId: bank.cityId,
      sourceKind: "action",
      generation: 1,
      chainId: pendingId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      minSeqAdvance: PREMIUM_PERIOD_SEQS,
      scheduleDerivation: {
        bankCorporationId: bank.corporationId,
        periodIndex: 0,
        anchor: "dif-founding",
        periodSeqs: PREMIUM_PERIOD_SEQS,
      },
      payloadSpec: {
        schedule: {
          kind: "insurance-premium",
          bankCorporationId: bank.corporationId,
          bankCityId: bank.cityId,
          periodIndex: 0,
        },
        occasion: {
          kind: "insurance-premium-due",
          severity: "routine",
          title: `Deposit-insurance premium due — ${bank.corporationId}`,
          summary: `A premium period for ${bank.corporationId} has ripened; the due figure is computed at ripening from the bank's standing insured liabilities (B-12).`,
          detail: { bankCorporationId: bank.corporationId, periodIndex: 0, premiumChain: true },
          cityId: bank.cityId,
          audienceCityId: bank.cityId,
          recipientUid: bank.ownerMemberId,
        } satisfies RipeningOccasionSpec,
      },
    });
    plan.pendingCreates.push(draft.draft);
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: null,
      cityIds: [],
      ruleIds: [descriptorId],
      major: true,
      changes: [
        fieldChange("institutionAccount.cashRubars", null, 0, "The Deposit Insurance Fund is founded by adoption act (BNK-D18) — its segregated balance opens at 0 R; premiums, assessments, subrogated recoveries, and governance grants are its only inflows (M10)"),
        fieldChange("institutionAccount.totalInsuredLiabilitiesRubars", null, aggregate, `Insured aggregate at founding, derived over the standing book under the grandfathering election: NONE — pre-founding deposits derive uninsured for life (M12); the derivation over the book gives ${aggregate} R`),
      ],
      recordsCreated: [INSURANCE_FUND_PATH],
      recordsUpdated: [],
      summaryText: `The Realm Deposit Insurance Fund is founded by adoption act. Grandfathering election: NONE. Premium chains seeded for ${charteredBanks.length} chartered bank(s). The fund insures nothing retroactively and holds no one's money yet.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "found-deposit-insurance-fund",
    scope: "bank",
    cityId: null,
    summaryText: `Founded the Realm Deposit Insurance Fund (adoption act, BNK-D18): grandfathering NONE, insured aggregate ${aggregate} R at founding, premium chains seeded for ${charteredBanks.map((b) => b.corporationId).join(", ") || "no chartered banks"}.`,
    major: true,
    classificationExtra: {
      difFounding: {
        grandfathering: "none",
        establishedAtSeq: summarySeq,
        seededBankCorporationIds: charteredBanks.map((b) => b.corporationId),
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Schedule ripening composition (addendum §4 items 6/12/13; SPEC-1
// as Vera confirmed it). Exported for the Lead's resolver dispatch:
// ONE branch routes pendings of the two schedule kinds here. The
// composition lands, inside the ripening Resolution Event: the
// marker (the event's summary classification — premiumDue /
// assessmentDue are Log facts), the occasion Situation(s) via
// Vera's GAP-1 producer (occasion figures are computed HERE, at
// ripening, from standing state — a seed-time spec carries
// addressing and fallback text only), the successor pending
// (premium chains: schedule-anchored requiredSeq, generation-1 of
// a FRESH chain), and B-14 assessment creation when the fund
// derives deficient. Charter-ended banks end their chains: no
// successor, stated on the marker.
// ---------------------------------------------------------------------------

export function buildScheduleRipeningPlan(
  ctx: HandlerContext,
  pendingDoc: Record<string, unknown>
): ResolutionPlan {
  const pendingId = typeof pendingDoc.pendingId === "string" ? pendingDoc.pendingId : "";
  const payloadSpec = (pendingDoc.payloadSpec ?? {}) as Record<string, unknown>;
  const schedule = (payloadSpec.schedule ?? {}) as Record<string, unknown>;
  const scheduleKind = typeof schedule.kind === "string" ? schedule.kind : "";
  if (scheduleKind === "loan-installment") return ripenInstallment(ctx, pendingDoc, schedule);
  if (scheduleKind === "insurance-premium") return ripenPremium(ctx, pendingDoc, schedule);
  if (scheduleKind === "insurance-assessment") return ripenAssessment(ctx, pendingDoc, schedule);
  return rejectedPlan("B-12", "ripening-kind-unrecognized", ["B-12"], `Schedule ripening: pending ${pendingId} carries no recognized banking schedule kind ("${scheduleKind}") — the composition refuses rather than improvises.`);
}

function ripenInstallment(
  ctx: HandlerContext,
  pendingDoc: Record<string, unknown>,
  schedule: Record<string, unknown>
): ResolutionPlan {
  const descriptorId = "B-07";
  const pendingId = pendingDoc.pendingId as string;
  const loanId = typeof schedule.loanId === "string" ? schedule.loanId : "";
  const installmentIndex = typeof schedule.installmentIndex === "number" ? schedule.installmentIndex : 0;
  const loan = loanRecordOf(snapshotDoc(ctx.snapshot, bankLoanPath(loanId)));
  if (!loan) {
    return rejectedPlan(descriptorId, "ripening-read-incomplete", [descriptorId], `Installment ripening for ${pendingId}: the loan record ${loanId} is not in the ripening read set — the Lead's ripening read wiring must carry the loan (assembly item). Nothing ripens blind.`);
  }
  const plan = emptyPlan(descriptorId);
  const markerSeq = ctx.snapshot.counterHead.lastSeq + 2; // card entry, then summary
  const standing = deriveLoanStanding(loan, markerSeq);
  const missedIndices: number[] = [];
  for (let k = 1; k <= loan.installmentCount; k += 1) {
    const dueSeq = installmentDueSeq(loan, k);
    if (dueSeq !== null && markerSeq > dueSeq && k > loan.installmentsSettled) missedIndices.push(k);
  }
  const installmentPrincipal = installmentPrincipalAt(loan.principalRubars, loan.installmentCount, installmentIndex);
  const addressing = situationAddressingFor(ctx.snapshot, loan.borrower, loan.bankCityId);
  const defaultNote = standing.inDefault
    ? ` The loan stands in DERIVED DEFAULT (${standing.missedCount} missed installments ≥ the ${loan.defaultMissedCount} its terms require): the bank's remedies are armed — seizure (B-08) and write-off (B-11) read this same derivation. Cure by repaying the missed installments (B-07); cure un-happens default.`
    : "";
  const spec: RipeningOccasionSpec = {
    kind: "system",
    severity: "routine",
    title: `Installment ${installmentIndex} due — loan ${loan.loanId}`,
    summary: `Installment ${installmentIndex} of ${loan.installmentCount} on the ${loan.principalRubars} R loan from ${loan.bankCorporationId} is due: ${installmentPrincipal} R of principal plus interest as it stands (${standing.accruedInterestRubars} R unsettled at seq ${markerSeq}). Repayment is your act (B-07) — nothing auto-debits.${defaultNote}`,
    detail: {
      loanId: loan.loanId,
      bankCorporationId: loan.bankCorporationId,
      installmentIndex,
      dueRubars: installmentPrincipal,
      inDefault: standing.inDefault,
      missedCount: standing.missedCount,
    },
    cityId: loan.bankCityId,
    audienceCityId: addressing.audienceCityId,
    recipientUid: addressing.recipientUid ?? null,
  };
  const card = mintSituation(
    plan,
    ctx,
    buildRipeningOccasionSituation({
      pending: { pendingId, originSeq: typeof pendingDoc.originSeq === "number" ? pendingDoc.originSeq : null },
      spec,
      ripeningSeq: markerSeq,
      ripeningResolutionId: ctx.resolutionId,
      audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
      createdSeq: markerSeq - 1,
      now: ctx.snapshot.now,
    })
  );
  const claims = { created: [...card.created], updated: [...card.updated] };
  // K1: remedies-armed card for the bank, once per crossing — its
  // dedupe key derives from (loan, crossing installment), so a
  // re-driven ripening supersedes rather than duplicates.
  if (standing.inDefault && missedIndices.length >= loan.defaultMissedCount) {
    const crossingIndex = missedIndices[loan.defaultMissedCount - 1];
    if (installmentIndex === crossingIndex) {
      const bankCorp = snapshotDoc(ctx.snapshot, corporationPath(loan.bankCityId, loan.bankCorporationId));
      const ownerId = typeof bankCorp?.ownerMemberId === "string" ? bankCorp.ownerMemberId : null;
      const k1Addressing = situationAddressingFor(ctx.snapshot, personalRef(ownerId ?? ""), loan.bankCityId);
      const k1 = mintSituation(
        plan,
        ctx,
        buildRipeningOccasionSituation({
          pending: { pendingId: `k1_${loan.loanId}_${crossingIndex}`, originSeq: typeof pendingDoc.originSeq === "number" ? pendingDoc.originSeq : null },
          spec: {
            kind: "system",
            severity: "important",
            title: `Remedies armed — loan ${loan.loanId} in default`,
            summary: `Loan ${loan.loanId} (borrower ${ledgerLabel(loan.borrower)}) crossed into derived default at installment ${crossingIndex}: ${standing.missedCount} missed installments stand due-and-unsettled. Your remedies are armed on this same derivation: seize the collateral (B-08) or write the loan off (B-11). If the bank itself fails, write-off closes — the book becomes the pool's.`,
            detail: { loanId: loan.loanId, crossingInstallmentIndex: crossingIndex, remediesArmed: true },
            cityId: loan.bankCityId,
            audienceCityId: loan.bankCityId,
            recipientUid: ownerId,
          },
          ripeningSeq: markerSeq,
          ripeningResolutionId: ctx.resolutionId,
          audienceOwnerUidsSnapshot: k1Addressing.audienceOwnerUidsSnapshot,
          createdSeq: markerSeq - 1,
          now: ctx.snapshot.now,
        })
      );
      claims.created.push(...k1.created);
      claims.updated.push(...k1.updated);
    }
  }
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: loan.bankCityId,
      cityIds: [loan.bankCityId],
      ruleIds: [descriptorId],
      changes: [],
      recordsCreated: claims.created,
      recordsUpdated: claims.updated,
      summaryText: `Installment ripening: installment ${installmentIndex} of loan ${loan.loanId} falls due at seq ${markerSeq} (${installmentPrincipal} R principal; unsettled interest ${standing.accruedInterestRubars} R; missed ${standing.missedCount}${standing.inDefault ? ` — the loan derives in DEFAULT; remedies armed` : ""}). The borrower's B2 card stands; no money moved and nothing auto-debits (M5).`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "ripen-installment",
    scope: "bank",
    cityId: loan.bankCityId,
    summaryText: `Ripened installment ${installmentIndex} of loan ${loan.loanId} — due ${installmentPrincipal} R${standing.inDefault ? ", loan in derived default, remedies armed (K1)" : ""}.`,
    classificationExtra: {
      ripening: { pendingId, kind: "loan-installment-due", installmentIndex, inDefault: standing.inDefault },
    },
  });
}

function ripenPremium(
  ctx: HandlerContext,
  pendingDoc: Record<string, unknown>,
  schedule: Record<string, unknown>
): ResolutionPlan {
  const descriptorId = "B-12";
  const pendingId = pendingDoc.pendingId as string;
  const bankCorporationId = typeof schedule.bankCorporationId === "string" ? schedule.bankCorporationId : "";
  const bankCityId = typeof schedule.bankCityId === "string" ? schedule.bankCityId : "";
  const periodIndex = typeof schedule.periodIndex === "number" ? schedule.periodIndex : 0;
  const corpPath = corporationPath(bankCityId, bankCorporationId);
  const corp = snapshotDoc(ctx.snapshot, corpPath);
  const block = corp ? bankBlockOf(corp) : null;
  const fund = snapshotDoc(ctx.snapshot, INSURANCE_FUND_PATH);
  const fundRec = fundRecordOf(fund);
  if (!corp || !block || !fundRec) {
    return rejectedPlan(descriptorId, "ripening-read-incomplete", [descriptorId], `Premium ripening for ${pendingId}: the bank corporation or the fund record is not in the ripening read set — the Lead's ripening read wiring must carry both (assembly item).`);
  }
  const depositQuery = ctx.snapshot.queries.find((q) => q.spec.id === "bankDeposits");
  if (!depositQuery) {
    return rejectedPlan(descriptorId, "ripening-read-incomplete", [descriptorId], `Premium ripening for ${pendingId}: the bank's deposit book is not in the ripening read set — premiums compute from standing insured liabilities, never from a guess (assembly item: the ripening read wiring carries the bankDeposits query).`);
  }
  const deposits = queryDocs(ctx.snapshot, "bankDeposits", "sim_bank_deposits")
    .map(({ doc }) => depositRecordOf(doc))
    .filter((d): d is BankDepositRecord => d !== null && d.bankCorporationId === bankCorporationId);
  const ownerId = corp.ownerMemberId as string;
  const ladderBefore = bankPremiumLadder(ctx.snapshot, bankCorporationId);
  const insured = insuredLiabilitiesForBank({
    deposits,
    bankCorporationId,
    fund: fundRec,
    suspensionIntervals: ladderBefore.suspensionIntervals,
    bankOwnerMemberId: ownerId,
  });
  const grade = bankRiskGradeOf(corp);
  const multiplier = premiumRiskMultiplier(grade);
  const due = premiumDueRubars({ insuredLiabilitiesRubars: insured, riskMultiplier: multiplier, periodSeqs: PREMIUM_PERIOD_SEQS });
  const charterEnded = block.status !== "active" || corp.status === "dissolved";
  const plan = emptyPlan(descriptorId);
  const cardSeq = ctx.snapshot.counterHead.lastSeq + 1;
  const summarySeq = cardSeq + 1;
  const arrearsAfter = ladderBefore.arrearsRubars + due;
  const unsettledAfter = ladderBefore.unsettled.length + (due > 0 ? 1 : 0);
  const ladderAfter = unsettledAfter >= 2 ? "suspended" : unsettledAfter === 1 ? "delinquent" : "current";

  // B-14: while the fund derives deficient, an outstanding
  // assessment obligation is created for this bank at its premium
  // ripening — the venue where the bank's own insured liabilities
  // (the assessment's numerator) and the fund's aggregate (its
  // denominator) are both exactly readable.
  let assessmentDueCreated = 0;
  let assessmentPendingId: string | null = null;
  const aggregate = fundRec.totalInsuredLiabilitiesRubars;
  if (
    fundDeficient({ fund: fundRec, insuredLiabilitiesRubars: aggregate, atSeq: summarySeq }) &&
    !charterEnded
  ) {
    const outstanding = assessmentObligations(ctx.snapshot, bankCorporationId);
    const standingAssessmentPendings = [...ctx.snapshot.docs.entries()].filter(([, doc]) => {
      if (!doc) return false;
      const spec = (doc.payloadSpec ?? {}) as Record<string, unknown>;
      const sched = (spec.schedule ?? {}) as Record<string, unknown>;
      return (
        sched.kind === "insurance-assessment" &&
        sched.bankCorporationId === bankCorporationId &&
        (doc.status === "pending" || doc.status === "ripe")
      );
    });
    // One outstanding assessment per bank at a time: a ripened-
    // unpaid obligation (marker standing, no settlement) or an
    // unripened assessment pending both block a second creation.
    const alreadyOwed = outstanding.length > 0 || standingAssessmentPendings.length > 0;
    if (!alreadyOwed) {
      const amounts = supplementalAssessments({
        fundCashRubars: fundRec.fundCashRubars,
        insuredLiabilitiesRubars: aggregate,
        survivingBanks: [
          { bankCorporationId, insuredLiabilitiesRubars: insured },
          { bankCorporationId: "__realm-rest__", insuredLiabilitiesRubars: Math.max(0, aggregate - insured) },
        ],
      });
      const dueAsm = amounts.get(bankCorporationId) ?? 0;
      if (dueAsm > 0) {
        assessmentDueCreated = dueAsm;
        assessmentPendingId = `asm_${bankCorporationId}_${summarySeq}`;
        const draft = buildSchedulePendingDraft(ctx.snapshot, {
          pendingId: assessmentPendingId,
          kind: "insurance-premium-due",
          originResolutionId: ctx.resolutionId,
          originActionId: ctx.action.actionId,
          originActor: ctx.action.actor,
          originCityId: bankCityId,
          originSummaryText: `B-14 supplemental assessment for ${bankCorporationId} — ${dueAsm} R toward the fund's deficiency`,
          targetCityId: bankCityId,
          sourceKind: "action",
          generation: 1,
          chainId: assessmentPendingId,
          chainRootPendingId: null,
          createdByResolutionId: null,
          minSeqAdvance: 0,
          scheduleDerivation: {
            bankCorporationId,
            assessment: true,
            deficitRubars: Math.max(0, fundTargetBalanceRubars(aggregate) - fundRec.fundCashRubars),
            anchor: "premium-ripening",
          },
          payloadSpec: {
            schedule: {
              kind: "insurance-assessment",
              bankCorporationId,
              bankCityId,
              dueRubars: dueAsm,
              deficitRubars: Math.max(0, fundTargetBalanceRubars(aggregate) - fundRec.fundCashRubars),
            },
            occasion: {
              kind: "insurance-premium-due",
              severity: "important",
              title: `Supplemental assessment due — ${bankCorporationId}`,
              summary: `The Deposit Insurance Fund derives deficient; a supplemental assessment of ${dueAsm} R stands against ${bankCorporationId} (B-14), payable in full under that rule.`,
              detail: { bankCorporationId, premiumChain: true, assessment: true },
              cityId: bankCityId,
              audienceCityId: bankCityId,
              recipientUid: ownerId,
            } satisfies RipeningOccasionSpec,
          },
        });
        plan.pendingCreates.push(draft.draft);
        plan.readRefKeys.push(`pending:${assessmentPendingId}`);
      }
    }
  }

  // K3: the accumulated premium card (never two open cards per
  // bank — the standing card supersedes into the new one, which
  // carries the accumulated figures).
  const claims = { created: [] as string[], updated: [] as string[] };
  if (due > 0 || assessmentDueCreated > 0) {
    const supersededPath = supersedeSituationWhere(
      plan,
      ctx,
      (doc) =>
        doc.kind === "system" &&
        (doc.detail as Record<string, unknown> | null)?.premiumChain === true &&
        (doc.detail as Record<string, unknown> | null)?.bankCorporationId === bankCorporationId,
      { resolvedSeq: cardSeq, resolutionId: ctx.resolutionId }
    );
    if (supersededPath) claims.updated.push(supersededPath);
    const addressing = situationAddressingFor(ctx.snapshot, personalRef(ownerId), bankCityId);
    const card = mintSituation(
      plan,
      ctx,
      buildRipeningOccasionSituation({
        pending: { pendingId, originSeq: typeof pendingDoc.originSeq === "number" ? pendingDoc.originSeq : null },
        spec: {
          kind: "system",
          severity: assessmentDueCreated > 0 ? "important" : "routine",
          title: `Deposit-insurance premium due — ${bankCorporationId}`,
          summary: `Premium period ${periodIndex} for ${bankCorporationId} ripened: ${due} R due on insured liabilities of ${insured} R (risk multiplier ${multiplier}×, ${grade ?? "unassessed"} grade). Accumulated arrears: ${arrearsAfter} R; ladder state: ${ladderAfter}${ladderAfter === "suspended" ? " — new deposits are REJECTED while suspended (B-02), and deposits opened during suspension derive uninsured for life" : ""}.${assessmentDueCreated > 0 ? ` A supplemental assessment of ${assessmentDueCreated} R also stands (B-14) — it ripens as its own obligation and is stated separately on this card.` : ""} Pay premiums under B-12 in full; nothing auto-debits.`,
          detail: {
            bankCorporationId,
            premiumChain: true,
            periodIndex,
            dueRubars: due,
            arrearsRubars: arrearsAfter,
            ladderState: ladderAfter,
            assessmentPendingId,
            assessmentDueRubars: assessmentDueCreated,
          },
          cityId: bankCityId,
          audienceCityId: bankCityId,
          recipientUid: ownerId,
        },
        ripeningSeq: summarySeq,
        ripeningResolutionId: ctx.resolutionId,
        audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
        createdSeq: cardSeq,
        now: ctx.snapshot.now,
      })
    );
    claims.created.push(...card.created);
    claims.updated.push(...card.updated);
  }

  // Successor (SPEC-1): schedule-anchored, generation-1 fresh chain.
  let successorNote = "";
  if (!charterEnded) {
    const parentRequiredSeq =
      typeof (pendingDoc.ripenCondition as Record<string, unknown> | undefined)?.requiredSeq === "number"
        ? ((pendingDoc.ripenCondition as Record<string, unknown>).requiredSeq as number)
        : summarySeq;
    const anchor = parentRequiredSeq + PREMIUM_PERIOD_SEQS;
    const nextPeriod = periodIndex + 1;
    const successorId = `prem_${bankCorporationId}_${nextPeriod}`;
    const draft = buildSchedulePendingDraft(ctx.snapshot, {
      pendingId: successorId,
      kind: "insurance-premium-due",
      originResolutionId: ctx.resolutionId,
      originActionId: ctx.action.actionId,
      originActor: ctx.action.actor,
      originCityId: bankCityId,
      originSummaryText: `Deposit-insurance premium period ${nextPeriod} for ${bankCorporationId}`,
      targetCityId: bankCityId,
      sourceKind: "action",
      generation: 1,
      chainId: successorId,
      chainRootPendingId: null,
      createdByResolutionId: null,
      minSeqAdvance: anchor - summarySeq,
      scheduleDerivation: {
        bankCorporationId,
        periodIndex: nextPeriod,
        anchor: "schedule",
        anchorRequiredSeq: anchor,
        previousPendingId: pendingId,
        periodSeqs: PREMIUM_PERIOD_SEQS,
      },
      payloadSpec: {
        schedule: {
          kind: "insurance-premium",
          bankCorporationId,
          bankCityId,
          periodIndex: nextPeriod,
        },
        occasion: {
          kind: "insurance-premium-due",
          severity: "routine",
          title: `Deposit-insurance premium due — ${bankCorporationId}`,
          summary: `A premium period for ${bankCorporationId} has ripened; the due figure is computed at ripening from the bank's standing insured liabilities (B-12).`,
          detail: { bankCorporationId, periodIndex: nextPeriod, premiumChain: true },
          cityId: bankCityId,
          audienceCityId: bankCityId,
          recipientUid: ownerId,
        } satisfies RipeningOccasionSpec,
      },
    });
    plan.pendingCreates.push(draft.draft);
    plan.readRefKeys.push(`pending:${successorId}`);
    successorNote = ` Successor period ${nextPeriod} scheduled at the anchored seq ${anchor} (generation-1 of a fresh chain, SPEC-1).`;
  } else {
    successorNote = " The bank's charter has ended — the premium chain ends here; no successor is created (SPEC-1).";
  }

  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: bankCityId,
      cityIds: [bankCityId],
      ruleIds: [descriptorId],
      changes: [],
      recordsCreated: claims.created,
      recordsUpdated: claims.updated,
      summaryText: `Premium ripening (period ${periodIndex}) for ${bankCorporationId}: insured liabilities ${insured} R × 10 bps × ${multiplier}× risk multiplier = ${due} R due.${due === 0 ? " A zero-due period lands its marker only — no card, the chain unbroken (K3)." : ""} Arrears stand at ${arrearsAfter} R; ladder derives ${ladderAfter}.${assessmentDueCreated > 0 ? ` The fund derives deficient; a B-14 assessment obligation of ${assessmentDueCreated} R was created for this bank.` : ""}${successorNote}`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "ripen-premium",
    scope: "bank",
    cityId: bankCityId,
    summaryText: `Ripened premium period ${periodIndex} for ${bankCorporationId}: ${due} R due (insured ${insured} R, ${multiplier}×); arrears ${arrearsAfter} R, ladder ${ladderAfter}.${charterEnded ? " Chain ended with the charter." : ""}`,
    classificationExtra: {
      premiumDue: {
        bankCorporationId,
        periodIndex,
        pendingId,
        dueRubars: due,
        insuredLiabilitiesRubars: insured,
        multiplier,
      },
      ripening: { pendingId, kind: "insurance-premium-due", periodIndex },
    },
  });
}

function ripenAssessment(
  ctx: HandlerContext,
  pendingDoc: Record<string, unknown>,
  schedule: Record<string, unknown>
): ResolutionPlan {
  const descriptorId = "B-12";
  const pendingId = pendingDoc.pendingId as string;
  const bankCorporationId = typeof schedule.bankCorporationId === "string" ? schedule.bankCorporationId : "";
  const bankCityId = typeof schedule.bankCityId === "string" ? schedule.bankCityId : "";
  const dueRubars = typeof schedule.dueRubars === "number" ? schedule.dueRubars : 0;
  const deficitRubars = typeof schedule.deficitRubars === "number" ? schedule.deficitRubars : null;
  const corp = snapshotDoc(ctx.snapshot, corporationPath(bankCityId, bankCorporationId));
  const ownerId = typeof corp?.ownerMemberId === "string" ? corp.ownerMemberId : "";
  const ladder = bankPremiumLadder(ctx.snapshot, bankCorporationId);
  const plan = emptyPlan(descriptorId);
  const cardSeq = ctx.snapshot.counterHead.lastSeq + 1;
  const summarySeq = cardSeq + 1;
  // K4 rides the bank's premium card machinery: supersede the
  // standing card into one that states the assessment separately.
  const claims = { created: [] as string[], updated: [] as string[] };
  const supersededPath = supersedeSituationWhere(
    plan,
    ctx,
    (doc) =>
      doc.kind === "system" &&
      (doc.detail as Record<string, unknown> | null)?.premiumChain === true &&
      (doc.detail as Record<string, unknown> | null)?.bankCorporationId === bankCorporationId,
    { resolvedSeq: cardSeq, resolutionId: ctx.resolutionId }
  );
  if (supersededPath) claims.updated.push(supersededPath);
  const addressing = situationAddressingFor(ctx.snapshot, personalRef(ownerId), bankCityId);
  const card = mintSituation(
    plan,
    ctx,
    buildRipeningOccasionSituation({
      pending: { pendingId, originSeq: typeof pendingDoc.originSeq === "number" ? pendingDoc.originSeq : null },
      spec: {
        kind: "system",
        severity: "important",
        title: `Supplemental assessment due — ${bankCorporationId}`,
        summary: `A supplemental assessment of ${dueRubars} R stands against ${bankCorporationId} (B-14): the Deposit Insurance Fund derives deficient${deficitRubars !== null ? ` by ${deficitRubars} R against its target balance` : ""}, and surviving banks are assessed pro-rata by insured liabilities. Premium arrears stand separately at ${ladder.arrearsRubars} R. Pay the assessment under B-14, naming this obligation; premiums under B-12. Nothing auto-debits.`,
        detail: {
          bankCorporationId,
          premiumChain: true,
          assessment: true,
          assessmentPendingId: pendingId,
          assessmentDueRubars: dueRubars,
          arrearsRubars: ladder.arrearsRubars,
        },
        cityId: bankCityId,
        audienceCityId: bankCityId,
        recipientUid: ownerId || null,
      },
      ripeningSeq: summarySeq,
      ripeningResolutionId: ctx.resolutionId,
      audienceOwnerUidsSnapshot: addressing.audienceOwnerUidsSnapshot,
      createdSeq: cardSeq,
      now: ctx.snapshot.now,
    })
  );
  claims.created.push(...card.created);
  claims.updated.push(...card.updated);
  plan.entries.push(
    ruleEffectDraft({
      actor: ctx.action.actor,
      cityId: bankCityId,
      cityIds: [bankCityId],
      ruleIds: ["B-14"],
      changes: [],
      recordsCreated: claims.created,
      recordsUpdated: claims.updated,
      summaryText: `Assessment ripening: the B-14 obligation of ${dueRubars} R against ${bankCorporationId} is now DUE (marker: this event). It settles only by the owner's B-14 payment naming ${pendingId}; the K4 card rides the bank's premium card. No successor — assessments do not perpetuate.`,
    })
  );
  return finishPlan(plan, ctx, {
    ruleId: descriptorId,
    verb: "ripen-assessment",
    scope: "bank",
    cityId: bankCityId,
    summaryText: `Ripened the B-14 supplemental assessment against ${bankCorporationId}: ${dueRubars} R due.`,
    classificationExtra: {
      assessmentDue: { bankCorporationId, pendingId, dueRubars, deficitRubars },
      ripening: { pendingId, kind: "insurance-assessment" },
    },
  });
}

function offerLoanReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
  if (typeof record.cityId === "string" && typeof record.corporationId === "string") {
    paths.push(corporationPath(record.cityId, record.corporationId));
    queries.push(...premiumQueries(record.corporationId), ...situationKeyQueries(record.cityId));
  }
  const borrower = parseLedgerRef(record.borrower);
  if (borrower?.kind === "company") {
    paths.push(corporationPath(borrower.cityId, borrower.corporationId));
  }
  if (borrower?.kind === "treasury") {
    paths.push(cityPath(borrower.cityId), `factions/${borrower.cityId}`);
  }
  if (typeof record.loanId === "string" && record.loanId) {
    paths.push(bankLoanPath(record.loanId));
    if (borrower?.kind === "company") paths.push(corporationPath(borrower.cityId, borrower.corporationId));
  }
  return { paths, queries };
}

function depositTargetReadPlan(seeds: ReadPlanSeeds): DescriptorReadPlan {
  const record = seeds.action.structuredAction ?? {};
  const paths: string[] = [INSURANCE_FUND_PATH];
  const queries: CollectionQuerySpec[] = [];
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
    mayCreatePendings: true,
    handlers: { charter_bank: charterBankHandler, surrender_charter: surrenderCharterHandler },
    readPlan: charterReadPlan,
    summary: "Charter a corporation as a bank (owner-only, min capital 100000 R, terms recorded verbatim; the controller bar refuses a barred controller) + surrender at zero live claims. Chartering seeds the bank's DIF premium chain when the fund stands.",
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
    summary: "Deposit funds into a chartered bank: cash line + deposit claim record + liability aggregate, in one event. Tier A (mandated NPCs within caps); a premium-suspended bank refuses new deposits.",
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
    summary: "Withdraw deposit principal, custodial class against unencumbered cash, refused in full on shortfall. Tier A; a bank deriving failed (REC-6) refuses — claims route to the waterfall.",
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
    summary: "Settle deposit interest: cash-paid branch (custodial) or credited branch (the claim grows, no cash moves, bridge class interest-capitalized). Tier A; refused at a failed bank in both branches.",
  },
  "B-05": {
    id: "B-05",
    actionKinds: ["offer_loan", "cancel_loan_offer"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { offer_loan: offerLoanHandler, cancel_loan_offer: cancelLoanOfferHandler },
    readPlan: (seeds) =>
      seeds.action.actionType === "cancel_loan_offer" ? cancelLoanOfferReadPlan(seeds) : offerLoanReadPlan(seeds),
    summary: "Offer a loan (Tier B): full terms stated at offer, funding source (cash | credit) fixed at offer, collateral pledged at offer, resting offers never expire; either party may cancel an unfunded offer.",
  },
  "B-06": {
    id: "B-06",
    actionKinds: ["accept_loan"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: true,
    handlers: { accept_loan: acceptLoanHandler },
    readPlan: acceptLoanReadPlan,
    summary: "Fund an offered loan (Tier B, binding by nature): cash branch disburses above the liquid reserve; credit branch creates the paired deposit in the same event (Appendix A — unpaired issuance does not exist). Creates the installment schedule pendings.",
  },
  "B-07": {
    id: "B-07",
    actionKinds: ["repay_loan"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { repay_loan: repayLoanHandler },
    readPlan: repayLoanReadPlan,
    summary: "Repay a loan (Tier A, borrower-initiated only, never auto-debit): fixed allocation (interest, fee at payoff, principal), principal-only netting against the loan's own created deposit, and the pool form for assigned loans with subrogation routing.",
  },
  "B-08": {
    id: "B-08",
    actionKinds: ["seize_collateral"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { seize_collateral: seizeCollateralHandler },
    readPlan: seizeCollateralReadPlan,
    summary: "Seize collateral on a loan in derived default (Tier B; pool form for claimants): satisfaction at recorded basis, mandatory excess-value return as a plan validation, remainder unsecured.",
  },
  "B-09": {
    id: "B-09",
    actionKinds: ["recapitalize_bank"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { recapitalize_bank: recapitalizeBankHandler },
    readPlan: recapitalizeBankReadPlan,
    summary: "Inject capital into a bank from any controlled ledger (Tier B); against a failed bank the injection is tested as a cure in-event (inclusive boundary), stamped for the failed-payment derivation.",
  },
  "B-10": {
    id: "B-10",
    actionKinds: ["liquidate_bank"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { liquidate_bank: liquidateBankHandler },
    readPlan: liquidateBankReadPlan,
    summary: "Liquidate a bank (Tier B): REC-5 frozen claims, in-event setoff, the (a)-(d) waterfall with B-13 paying inside (senior queue first), assignment to the depositor pool, charter surrender and dissolution in the same event. (B-13 is a committer step inside B-10, never an actor verb.)",
  },
  "B-11": {
    id: "B-11",
    actionKinds: ["write_off_loan"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { write_off_loan: writeOffLoanHandler },
    readPlan: writeOffLoanReadPlan,
    summary: "Write off a loan (Tier B): the loss posts through the bank's equity as a named credit-loss bridge (REC-2, never a burn); the record is retained; refused in derived failure.",
  },
  "B-12": {
    id: "B-12",
    actionKinds: ["pay_insurance_premium"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { pay_insurance_premium: payInsurancePremiumHandler },
    readPlan: insurancePaymentReadPlan("B-12"),
    summary: "Pay deposit-insurance premiums in full against ripened markers (Tier A, never auto-debit); the settlement classification is the delinquency ladder's input — cure derives, no flag flips.",
  },
  "B-14": {
    id: "B-14",
    actionKinds: ["pay_supplemental_assessment"],
    visibility: "public",
    requiresBaseline: false,
    defaultBaselineSections: [],
    mayCreatePendings: false,
    handlers: { pay_supplemental_assessment: paySupplementalAssessmentHandler },
    readPlan: insurancePaymentReadPlan("B-14"),
    summary: "Pay a B-14 supplemental assessment in full, naming the ripened obligation (Tier A). Obligations arise at premium ripenings while the fund derives deficient, pro-rata by insured liabilities.",
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
  "B-05": { shortfallClass: "none", ledgersTouched: ["company", "personal", "treasury"], invokesRules: [] },
  "B-06": { shortfallClass: "custodial", ledgersTouched: ["company", "personal", "treasury"], invokesRules: ["B-05"] },
  "B-07": { shortfallClass: "transfer", ledgersTouched: ["personal", "company", "treasury", "institution"], invokesRules: [] },
  "B-08": { shortfallClass: "custodial", ledgersTouched: ["company", "personal", "treasury"], invokesRules: [] },
  "B-09": { shortfallClass: "transfer", ledgersTouched: ["personal", "company", "treasury"], invokesRules: [] },
  "B-10": { shortfallClass: "custodial", ledgersTouched: ["company", "personal", "treasury", "institution"], invokesRules: ["B-13"] },
  "B-11": { shortfallClass: "none", ledgersTouched: ["company"], invokesRules: [] },
  "B-12": { shortfallClass: "transfer", ledgersTouched: ["company", "institution"], invokesRules: [] },
  "B-14": { shortfallClass: "transfer", ledgersTouched: ["company", "institution"], invokesRules: ["B-12"] },
};
