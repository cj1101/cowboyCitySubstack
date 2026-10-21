/**
 * Input shapes for the Phase 4 datasets (brief §10): portfolio /
 * positions, the treasury ledger view, action history, and survey
 * results. Like the Phase 3 city data (./cityData.ts), these are PURE
 * inputs: the fetch layer (../fetchPhase4Export.ts) fills them from
 * rules-governed reads executed as the requester, and the builders
 * in ./phase4Workbook.ts turn them into SheetSpecs — a builder can
 * only ever contain what the requester was allowed to read.
 *
 * Fairness boundary (CJ's data rule + TC-X): fair-to-see is
 * fair-to-export, and private data is not made exportable by being
 * bundled. Two of these datasets are therefore requester-scoped BY
 * CONSTRUCTION, and the builders re-assert the scope in the pure
 * layer (fail-closed) rather than trusting the fetch:
 *  - Portfolio: a member's own account/holdings/orders. Another
 *    member's portfolio is not theirs to see, so it is not theirs
 *    to export (TC-X01/X09).
 *  - Survey results: intel records keyed to the COLLECTOR. The
 *    target of a survey never receives the collector's intel in
 *    their own exports (TC-X05 directionality) — there is
 *    deliberately no city-scoped intel dataset here.
 */

export interface MemberAccountExportData {
  memberId: string;
  cashRubars: number | null;
  status: string | null;
  genesisGrantRubars: number | null;
  openedAtSeq: number | null;
  openedVia: string | null;
  stateVersion: number | null;
  lastChangedSeq: number | null;
}

export interface HoldingExportData {
  holdingId: string;
  corporationId: string;
  homeCityId: string | null;
  quantityShares: number | null;
  committedShares: number | null;
  /** Derived at fetch: quantity − committed (Cato §5.4 free shares);
   * null when either input is unknown — never invented. */
  freeShares: number | null;
  costBasisRubars: number | null;
  stateVersion: number | null;
  lastChangedSeq: number | null;
}

export interface ListingExportData {
  corporationId: string;
  homeCityId: string | null;
  status: string | null;
  tradingStatus: string | null;
  referencePriceRubars: number | null;
  lastTradePriceRubars: number | null;
  officialPriceRubars: number | null;
  committedFloatShares: number | null;
  publicHeldShares: number | null;
  listedAtSeq: number | null;
  stateVersion: number | null;
}

export interface OrderExportData {
  orderId: string;
  corporationId: string;
  homeCityId: string | null;
  side: string | null;
  type: string | null;
  kind: string | null;
  quantityShares: number | null;
  originalQuantityShares: number | null;
  filledShares: number | null;
  limitPriceRubars: number | null;
  status: string | null;
  cancelReason: string | null;
  placedAtSeq: number | null;
  stateVersion: number | null;
}

export interface PortfolioBundle {
  /** The member this portfolio belongs to — must equal the
   * requester or the builder refuses (fail-closed, pure layer). */
  memberId: string;
  memberLabel: string;
  account: MemberAccountExportData | null;
  holdings: HoldingExportData[];
  /** Listings for the held corporations (market-public records). */
  listings: ListingExportData[];
  orders: OrderExportData[];
}

// ---------------------------------------------------------------------------
// City ledger (brief §1.5: the treasury ledger view is a derived Log
// query, not a stored table) + action history (brief §10).
// ---------------------------------------------------------------------------

export interface TreasuryLedgerRowData {
  seq: number;
  resolutionId: string | null;
  entryKind: string | null;
  actorLabel: string | null;
  ruleIds: string[];
  beforeRubars: number | null;
  afterRubars: number | null;
  /** after − before when both are known; null otherwise. */
  deltaRubars: number | null;
  formula: string | null;
  summaryText: string | null;
}

export interface ActionHistoryRowData {
  actionId: string;
  actionType: string;
  status: string | null;
  actorLabel: string | null;
  targetCityIds: string[];
  firstLogSeq: number | null;
  lastLogSeq: number | null;
  resolutionId: string | null;
}

export interface CityLedgerBundle {
  cityId: string;
  cityName: string;
  treasury: TreasuryLedgerRowData[];
  actions: ActionHistoryRowData[];
}

// ---------------------------------------------------------------------------
// Survey results (Ines's delivery shape on sim_intel_records). The
// limits are first-class data, exported — never hidden (brief §10):
// coverage achieved vs caps, the reliability band, what was not
// known, and every null reason ride along with the findings.
// ---------------------------------------------------------------------------

export interface SurveyFindingData {
  metric: string;
  value: string | number | null;
  unit: string | null;
  note: string | null;
}

export interface SurveyRecordData {
  recordId: string;
  /** Must equal the requester or the builder refuses (TC-X05). */
  collectorUid: string;
  collectorCityId: string | null;
  targetCityId: string | null;
  targetBusinessId: string | null;
  methodKindLabel: string | null;
  methodRef: string | null;
  collectionResolutionId: string | null;
  collectedAtSeq: number | null;
  band: string | null;
  bandDroppedAtDelivery: boolean | null;
  coverageAchievedPct: number | null;
  coverageCapPct: number | null;
  coverageFundedCapPct: number | null;
  targetPopulationText: string | null;
  knownUnknowns: string[];
  nullReasons: string[];
  findings: SurveyFindingData[];
  stateVersion: number | null;
}
