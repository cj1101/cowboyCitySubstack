/**
 * The fetch layer for the Phase 4 exports (brief §10): every read
 * executes CLIENT-SIDE as the requesting user, through the same
 * rules-governed queries the UI uses — visibility is inherited,
 * never re-implemented (Dana addendum §2.1). A denied or failed read
 * fails the export closed: no file, an honest error (TC-X03).
 *
 * Scope notes (fail-closed by construction):
 *  - Portfolio reads are keyed to the requester's OWN uid
 *    (account doc id, holdings/orders `memberId == uid`). There is
 *    no parameter that could name another member.
 *  - Survey reads are keyed `collectorUid == uid` (the §12.4
 *    intel-by-actor index serves exactly this). Intel is never read
 *    by target city — TC-X05 directionality holds at the query.
 *  - The treasury ledger derives from PUBLIC Log entries only:
 *    actor-private (covert) entries never enter a derived public
 *    view, even when the requester is their actor.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { ExportError } from "./sheetSpec";
import type {
  ActionHistoryRowData,
  CityLedgerBundle,
  HoldingExportData,
  ListingExportData,
  MemberAccountExportData,
  OrderExportData,
  PortfolioBundle,
  SurveyRecordData,
  TreasuryLedgerRowData,
} from "./datasets/phase4Data";

const READ_CAP = 5000;

function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strListOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function actorLabelOf(actor: unknown): string | null {
  if (!actor || typeof actor !== "object") return null;
  const a = actor as DocumentData;
  if (typeof a.memberId === "string" && a.memberId) return a.memberId;
  return typeof a.type === "string" ? a.type : null;
}

async function readOrFail<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    throw new ExportError(
      `${what} could not be read as your account, so no export was produced.`
    );
  }
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

function mapAccount(memberId: string, data: DocumentData): MemberAccountExportData {
  const grant = (data.genesisGrant as DocumentData | undefined) ?? null;
  return {
    memberId,
    cashRubars: numOf(data.cashRubars),
    status: strOf(data.status),
    genesisGrantRubars: grant ? numOf(grant.amountRubars) : null,
    openedAtSeq: numOf(data.openedAtSeq),
    openedVia: strOf(data.openedVia),
    stateVersion: numOf(data.stateVersion),
    lastChangedSeq: numOf(data.lastChangedSeq),
  };
}

function mapHolding(id: string, data: DocumentData): HoldingExportData {
  const quantity = numOf(data.quantityShares);
  const committed = numOf(data.committedShares);
  return {
    holdingId: id,
    corporationId: strOf(data.corporationId) ?? "",
    homeCityId: strOf(data.homeCityId),
    quantityShares: quantity,
    committedShares: committed,
    freeShares:
      quantity !== null && committed !== null ? quantity - committed : null,
    costBasisRubars: numOf(data.costBasisRubars),
    stateVersion: numOf(data.stateVersion),
    lastChangedSeq: numOf(data.lastChangedSeq),
  };
}

function mapListing(id: string, data: DocumentData): ListingExportData {
  return {
    corporationId: strOf(data.corporationId) ?? id,
    homeCityId: strOf(data.homeCityId),
    status: strOf(data.status),
    tradingStatus: strOf(data.tradingStatus),
    referencePriceRubars: numOf(data.referencePriceRubars),
    lastTradePriceRubars: numOf(data.lastTradePriceRubars),
    officialPriceRubars: numOf(data.officialPriceRubars),
    committedFloatShares: numOf(data.committedFloatShares),
    publicHeldShares: numOf(data.publicHeldShares),
    listedAtSeq: numOf(data.listedAtSeq),
    stateVersion: numOf(data.stateVersion),
  };
}

function mapOrder(id: string, data: DocumentData): OrderExportData {
  return {
    orderId: id,
    corporationId: strOf(data.corporationId) ?? "",
    homeCityId: strOf(data.homeCityId),
    side: strOf(data.side),
    type: strOf(data.type),
    kind: strOf(data.kind),
    quantityShares: numOf(data.quantityShares),
    originalQuantityShares: numOf(data.originalQuantityShares),
    filledShares: numOf(data.filledShares),
    limitPriceRubars: numOf(data.limitPriceRubars),
    status: strOf(data.status),
    cancelReason: strOf(data.cancelReason),
    placedAtSeq: numOf(data.placedAtSeq),
    stateVersion: numOf(data.stateVersion),
  };
}

export async function fetchPortfolioBundle(
  uid: string,
  memberLabel: string
): Promise<PortfolioBundle> {
  const db = getClientDb();
  const accountSnap = await readOrFail("Your member account", () =>
    getDoc(doc(db, "sim_member_accounts", uid))
  );
  const holdingsSnap = await readOrFail("Your holdings", () =>
    getDocs(
      query(
        collection(db, "sim_holdings"),
        where("memberId", "==", uid),
        limit(READ_CAP)
      )
    )
  );
  const ordersSnap = await readOrFail("Your orders", () =>
    getDocs(
      query(
        collection(db, "sim_market_orders"),
        where("memberId", "==", uid),
        limit(READ_CAP)
      )
    )
  );
  const holdings = holdingsSnap.docs.map((d) => mapHolding(d.id, d.data()));
  const listings: ListingExportData[] = [];
  for (const corporationId of [...new Set(holdings.map((h) => h.corporationId))]) {
    if (!corporationId) continue;
    const snap = await readOrFail("A market listing", () =>
      getDoc(doc(db, "sim_market_listings", corporationId))
    );
    // A holding in a never-listed company honestly has no listing.
    if (snap.exists()) listings.push(mapListing(snap.id, snap.data()));
  }
  return {
    memberId: uid,
    memberLabel,
    account: accountSnap.exists() ? mapAccount(uid, accountSnap.data()) : null,
    holdings,
    listings,
    orders: ordersSnap.docs.map((d) => mapOrder(d.id, d.data())),
  };
}

// ---------------------------------------------------------------------------
// City ledger (treasury view + action history)
// ---------------------------------------------------------------------------

export async function fetchCityLedgerBundle(
  cityId: string
): Promise<CityLedgerBundle> {
  const db = getClientDb();
  const factionSnap = await readOrFail("That city", () =>
    getDoc(doc(db, "factions", cityId))
  );
  if (!factionSnap.exists()) {
    throw new ExportError(
      "That city could not be read as your account, so no export was produced."
    );
  }
  const cityName = strOf(factionSnap.data().name) ?? cityId;

  const entriesSnap = await readOrFail("The city's Log entries", () =>
    getDocs(
      query(
        collection(db, "sim_log_entries"),
        where("cityIds", "array-contains", cityId),
        orderBy("seq", "asc"),
        limit(READ_CAP)
      )
    )
  );
  const treasury: TreasuryLedgerRowData[] = [];
  for (const entryDoc of entriesSnap.docs) {
    const data = entryDoc.data();
    if (data.visibility === "actor-private") continue; // never a public view
    const changes = Array.isArray(data.changes) ? data.changes : [];
    for (const raw of changes) {
      const change = (raw ?? {}) as DocumentData;
      if (change.field !== "stats.treasuryRubars") continue;
      const before = numOf(change.before);
      const after = numOf(change.after);
      treasury.push({
        seq: numOf(data.seq) ?? 0,
        resolutionId: strOf(data.resolutionId),
        entryKind: strOf(data.kind),
        actorLabel: actorLabelOf(data.actor),
        ruleIds: strListOf(data.ruleIds),
        beforeRubars: before,
        afterRubars: after,
        deltaRubars: before !== null && after !== null ? after - before : null,
        formula: strOf(change.formula),
        summaryText: strOf(data.summaryText),
      });
    }
  }

  const actionsSnap = await readOrFail("The city's action history", () =>
    getDocs(
      query(
        collection(db, "sim_actions"),
        where("targetCityIds", "array-contains", cityId),
        limit(READ_CAP)
      )
    )
  );
  const actions: ActionHistoryRowData[] = actionsSnap.docs.map((d) => {
    const data = d.data();
    return {
      actionId: d.id,
      actionType: strOf(data.actionType) ?? "",
      status: strOf(data.status),
      actorLabel: actorLabelOf(data.actor),
      targetCityIds: strListOf(data.targetCityIds),
      firstLogSeq: numOf(data.firstLogSeq),
      lastLogSeq: numOf(data.lastLogSeq),
      resolutionId: strOf(data.resolutionId),
    };
  });

  return { cityId, cityName, treasury, actions };
}

// ---------------------------------------------------------------------------
// Survey results (the collector's own intel)
// ---------------------------------------------------------------------------

function mapSurveyRecord(id: string, data: DocumentData): SurveyRecordData {
  const method = (data.method as DocumentData | undefined) ?? {};
  const coverage = (data.coverage as DocumentData | null) ?? null;
  const reliability = (data.reliability as DocumentData | undefined) ?? {};
  const findings = Array.isArray(data.findings) ? data.findings : [];
  return {
    recordId: id,
    collectorUid: strOf(data.collectorUid) ?? "",
    collectorCityId: strOf(data.collectorCityId),
    targetCityId: strOf(data.targetCityId),
    targetBusinessId: strOf(data.targetBusinessId),
    methodKindLabel: strOf(method.kindLabel),
    methodRef: strOf(method.methodRef),
    collectionResolutionId: strOf(data.collectionResolutionId),
    collectedAtSeq: numOf(data.collectedAtSeq),
    band: strOf(reliability.band),
    bandDroppedAtDelivery:
      typeof reliability.bandDroppedAtDelivery === "boolean"
        ? reliability.bandDroppedAtDelivery
        : null,
    coverageAchievedPct: coverage ? numOf(coverage.achievedPct) : null,
    coverageCapPct: coverage ? numOf(coverage.capPct) : null,
    coverageFundedCapPct: coverage ? numOf(coverage.fundedCapPct) : null,
    targetPopulationText: coverage ? strOf(coverage.targetPopulationText) : null,
    knownUnknowns: coverage ? strListOf(coverage.knownUnknowns) : [],
    nullReasons: strListOf(data.nullReasons),
    findings: findings.map((raw) => {
      const finding = (raw ?? {}) as DocumentData;
      return {
        metric: typeof finding.metric === "string" ? finding.metric : "",
        value:
          typeof finding.value === "number" || typeof finding.value === "string"
            ? finding.value
            : null,
        unit: strOf(finding.unit),
        note: strOf(finding.note),
      };
    }),
    stateVersion: numOf(data.stateVersion),
  };
}

export async function fetchSurveyRecords(uid: string): Promise<SurveyRecordData[]> {
  const db = getClientDb();
  const snap = await readOrFail("Your collected intel", () =>
    getDocs(
      query(
        collection(db, "sim_intel_records"),
        where("collectorUid", "==", uid),
        orderBy("collectedAtSeq", "desc"),
        limit(READ_CAP)
      )
    )
  );
  return snap.docs.map((d) => mapSurveyRecord(d.id, d.data()));
}
