/**
 * The Phase 4 workbook builders (brief §10): Portfolio, City Ledger
 * (treasury ledger view + action history), and Survey Results. Pure:
 * bundles + context → PlannedWorkbook, through the same SheetSpec
 * contract and packaging caps as every Phase 3 export.
 *
 * Tier discipline (CJ §7.4, TC-P04/TC-X04): verified figures and
 * owner-published claims never share a tab or a column. These
 * datasets carry NO owner-published figures at all — portfolio and
 * ledger rows are resolver/Log-derived (verified), survey rows are
 * intel (their own tier, `intel_survey`) — so each workbook's Cover
 * states contains_owner_published: NO, truthfully. Published claims
 * live on the Phase 3 city workbook's own tab, untouched by this
 * module.
 *
 * Scope discipline (TC-X01/X05/X09): the portfolio and survey
 * builders take the requester's uid and REFUSE a bundle that is not
 * the requester's own — the pure layer fails closed even if a fetch
 * is ever mis-wired, because an export must never become the leak
 * path around the fairness boundary.
 */

import {
  ExportError,
  assembleWorkbook,
  exportFilenameBase,
  provenanceDefinitions,
  provenanceValues,
  withProvenance,
  type ColumnDefinition,
  type PlannedWorkbook,
  type SheetColumn,
  type SheetSpec,
} from "../sheetSpec";
import type { ExportContext } from "./cityData";
import type {
  CityLedgerBundle,
  PortfolioBundle,
  SurveyRecordData,
} from "./phase4Data";

// ---------------------------------------------------------------------------
// Scope guards (fail-closed, pure layer)
// ---------------------------------------------------------------------------

export function assertPortfolioIsRequesters(
  bundle: PortfolioBundle,
  requesterUid: string
): void {
  if (bundle.memberId !== requesterUid) {
    throw new ExportError(
      "A portfolio export contains only the requester's own account, holdings, and orders. No file was produced."
    );
  }
  for (const holding of bundle.holdings) {
    // Holding ids are `{memberId}__{corporationId}` by construction
    // (Cato's record shape): a holding that does not carry the
    // requester's prefix is not the requester's, whatever the fetch
    // was told — refuse rather than export it.
    if (!holding.holdingId.startsWith(`${requesterUid}__`)) {
      throw new ExportError(
        "A holding record that is not the requester's was read; no file was produced."
      );
    }
  }
}

export function assertSurveyRecordsAreRequesters(
  records: SurveyRecordData[],
  requesterUid: string
): void {
  for (const record of records) {
    if (record.collectorUid !== requesterUid) {
      throw new ExportError(
        "Survey results export only to the member who collected them. Another member's intel is never exported — no file was produced."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Portfolio (account + positions + orders)
// ---------------------------------------------------------------------------

const ACCOUNT_COLUMNS: SheetColumn[] = [
  { key: "member_id", header: "member_id", width: 18, type: "string" },
  { key: "cash_rubars", header: "cash_rubars", width: 16, type: "number" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "genesis_grant_rubars", header: "genesis_grant_rubars", width: 20, type: "number" },
  { key: "opened_at_seq", header: "opened_at_seq", width: 15, type: "number" },
  { key: "opened_via", header: "opened_via", width: 18, type: "string" },
  { key: "last_changed_seq", header: "last_changed_seq", width: 16, type: "number" },
];

const POSITIONS_COLUMNS: SheetColumn[] = [
  { key: "corporation_id", header: "corporation_id", width: 20, type: "string" },
  { key: "home_city_id", header: "home_city_id", width: 16, type: "string" },
  { key: "quantity_shares", header: "quantity_shares", width: 16, type: "number" },
  { key: "committed_shares", header: "committed_shares", width: 17, type: "number" },
  { key: "free_shares", header: "free_shares", width: 13, type: "number" },
  { key: "cost_basis_rubars", header: "cost_basis_rubars", width: 18, type: "number" },
  { key: "official_price_rubars", header: "official_price_rubars", width: 21, type: "number" },
  { key: "market_value_rubars", header: "market_value_rubars", width: 20, type: "number" },
  { key: "listing_status", header: "listing_status", width: 15, type: "string" },
  { key: "trading_status", header: "trading_status", width: 15, type: "string" },
  { key: "last_changed_seq", header: "last_changed_seq", width: 16, type: "number" },
];

const ORDERS_COLUMNS: SheetColumn[] = [
  { key: "order_id", header: "order_id", width: 20, type: "string" },
  { key: "corporation_id", header: "corporation_id", width: 20, type: "string" },
  { key: "home_city_id", header: "home_city_id", width: 16, type: "string" },
  { key: "side", header: "side", width: 8, type: "string" },
  { key: "type", header: "type", width: 10, type: "string" },
  { key: "kind", header: "kind", width: 13, type: "string" },
  { key: "quantity_shares", header: "quantity_shares", width: 16, type: "number" },
  { key: "original_quantity_shares", header: "original_quantity_shares", width: 23, type: "number" },
  { key: "filled_shares", header: "filled_shares", width: 14, type: "number" },
  { key: "limit_price_rubars", header: "limit_price_rubars", width: 19, type: "number" },
  { key: "status", header: "status", width: 12, type: "string" },
  { key: "cancel_reason", header: "cancel_reason", width: 24, type: "string" },
  { key: "placed_at_seq", header: "placed_at_seq", width: 15, type: "number" },
];

export function buildPortfolioWorkbook(
  bundle: PortfolioBundle,
  ctx: ExportContext,
  requesterUid: string
): PlannedWorkbook {
  assertPortfolioIsRequesters(bundle, requesterUid);
  const listingsByCorp = new Map(bundle.listings.map((l) => [l.corporationId, l]));

  const accountSheet: SheetSpec = {
    name: "Account",
    columns: withProvenance(ACCOUNT_COLUMNS),
    rows: bundle.account
      ? [
          {
            member_id: bundle.account.memberId,
            cash_rubars: bundle.account.cashRubars,
            status: bundle.account.status,
            genesis_grant_rubars: bundle.account.genesisGrantRubars,
            opened_at_seq: bundle.account.openedAtSeq,
            opened_via: bundle.account.openedVia,
            last_changed_seq: bundle.account.lastChangedSeq,
            ...provenanceValues({
              cityId: null,
              cityName: null,
              entityId: bundle.account.memberId,
              entityName: bundle.memberLabel,
              trustTier: "verified",
              sourceType: "resolver",
              sourceRef: bundle.account.lastChangedSeq
                ? `seq ${bundle.account.lastChangedSeq}`
                : null,
              asOfSeq: ctx.asOfSeq,
              rulesVersion: ctx.rulesVersion,
              stateVersion: bundle.account.stateVersion,
              notes:
                "Tracked cash only (finance §1.1): the realm's money also exists as Exterior flows; this is the member's tracked personal balance, not a realm total.",
            }),
          },
        ]
      : [],
  };

  const positionsSheet: SheetSpec = {
    name: "Positions",
    columns: withProvenance(POSITIONS_COLUMNS),
    rows: bundle.holdings.map((holding) => {
      const listing = listingsByCorp.get(holding.corporationId) ?? null;
      const official = listing?.officialPriceRubars ?? null;
      return {
        corporation_id: holding.corporationId,
        home_city_id: holding.homeCityId,
        quantity_shares: holding.quantityShares,
        committed_shares: holding.committedShares,
        free_shares: holding.freeShares,
        cost_basis_rubars: holding.costBasisRubars,
        official_price_rubars: official,
        market_value_rubars:
          holding.quantityShares !== null && official !== null
            ? holding.quantityShares * official
            : null,
        listing_status: listing?.status ?? null,
        trading_status: listing?.tradingStatus ?? null,
        last_changed_seq: holding.lastChangedSeq,
        ...provenanceValues({
          cityId: holding.homeCityId,
          cityName: null,
          entityId: holding.corporationId,
          entityName: null,
          trustTier: "verified",
          sourceType: "resolver",
          sourceRef: holding.lastChangedSeq ? `seq ${holding.lastChangedSeq}` : null,
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          stateVersion: holding.stateVersion,
          notes:
            "market_value_rubars is an arithmetic convenience (quantity × the listing's official price at export time), written as a value — it is not a stored figure and confers no claim about realizable proceeds.",
        }),
      };
    }),
  };

  const ordersSheet: SheetSpec = {
    name: "Orders",
    columns: withProvenance(ORDERS_COLUMNS),
    rows: bundle.orders.map((order) => ({
      order_id: order.orderId,
      corporation_id: order.corporationId,
      home_city_id: order.homeCityId,
      side: order.side,
      type: order.type,
      kind: order.kind,
      quantity_shares: order.quantityShares,
      original_quantity_shares: order.originalQuantityShares,
      filled_shares: order.filledShares,
      limit_price_rubars: order.limitPriceRubars,
      status: order.status,
      cancel_reason: order.cancelReason,
      placed_at_seq: order.placedAtSeq,
      ...provenanceValues({
        cityId: order.homeCityId,
        cityName: null,
        entityId: order.corporationId,
        entityName: null,
        trustTier: "verified",
        sourceType: "resolver",
        sourceRef: order.placedAtSeq ? `seq ${order.placedAtSeq}` : null,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        stateVersion: order.stateVersion,
      }),
    })),
  };

  const definitions: ColumnDefinition[] = [
    ...defs("Account", [
      ["cash_rubars", "The member's tracked personal cash (finance §1.2).", "Rubar"],
      ["genesis_grant_rubars", "The equal genesis grant the account opened with (250,000 R, finance §3.3).", "Rubar"],
      ["opened_via", "How the account opened: explicit, or lazy via the member's first money action.", null],
    ]),
    ...defs("Positions", [
      ["quantity_shares", "Shares held, from the standing holding record.", "shares"],
      ["committed_shares", "Shares committed to the member's resting sell orders (incl. a founder's float offer).", "shares"],
      ["free_shares", "quantity − committed: the only shares that can be sold or transferred.", "shares"],
      ["cost_basis_rubars", "Σ (trade price × quantity) over acquisitions; founding shares at paid-in basis. Fees are not cost basis.", "Rubar"],
      ["official_price_rubars", "The listing's official price at export time (market record).", "Rubar"],
      ["market_value_rubars", "quantity × official price, computed at export and written as a value.", "Rubar"],
    ]),
    ...defs("Orders", [
      ["quantity_shares", "Remaining unfilled quantity on the order.", "shares"],
      ["limit_price_rubars", "Limit price, market-order protection cap/floor, or the float offer's stated price.", "Rubar"],
      ["cancel_reason", "The coded cancellation cause, where the order was cancelled.", null],
    ]),
    ...provenanceDefinitions("Account"),
    ...provenanceDefinitions("Positions"),
    ...provenanceDefinitions("Orders"),
  ];

  return assembleWorkbook({
    filenameBase: exportFilenameBase("portfolio", ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: `Portfolio — ${bundle.memberLabel}`,
      scopeLabel: `${bundle.memberLabel} (own account, holdings, and orders only)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [accountSheet, positionsSheet, ordersSheet],
    definitions,
  });
}

// ---------------------------------------------------------------------------
// City ledger (treasury ledger view + action history)
// ---------------------------------------------------------------------------

const TREASURY_COLUMNS: SheetColumn[] = [
  { key: "seq", header: "seq", width: 10, type: "number" },
  { key: "resolution_id", header: "resolution_id", width: 20, type: "string" },
  { key: "entry_kind", header: "entry_kind", width: 15, type: "string" },
  { key: "actor", header: "actor", width: 18, type: "string" },
  { key: "rule_ids", header: "rule_ids", width: 16, type: "string" },
  { key: "before_rubars", header: "before_rubars", width: 16, type: "number" },
  { key: "after_rubars", header: "after_rubars", width: 16, type: "number" },
  { key: "delta_rubars", header: "delta_rubars", width: 15, type: "number" },
  { key: "formula", header: "formula", width: 40, type: "string" },
  { key: "summary", header: "summary", width: 60, type: "string" },
];

const ACTION_HISTORY_COLUMNS: SheetColumn[] = [
  { key: "action_id", header: "action_id", width: 20, type: "string" },
  { key: "action_type", header: "action_type", width: 20, type: "string" },
  { key: "status", header: "status", width: 13, type: "string" },
  { key: "actor", header: "actor", width: 18, type: "string" },
  { key: "target_city_ids", header: "target_city_ids", width: 22, type: "string" },
  { key: "first_log_seq", header: "first_log_seq", width: 15, type: "number" },
  { key: "last_log_seq", header: "last_log_seq", width: 15, type: "number" },
  { key: "resolution_id", header: "resolution_id", width: 20, type: "string" },
];

export function buildCityLedgerWorkbook(
  bundle: CityLedgerBundle,
  ctx: ExportContext
): PlannedWorkbook {
  const treasurySheet: SheetSpec = {
    name: "Treasury Ledger",
    columns: withProvenance(TREASURY_COLUMNS),
    rows: bundle.treasury.map((row) => ({
      seq: row.seq,
      resolution_id: row.resolutionId,
      entry_kind: row.entryKind,
      actor: row.actorLabel,
      rule_ids: row.ruleIds.join(", "),
      before_rubars: row.beforeRubars,
      after_rubars: row.afterRubars,
      delta_rubars: row.deltaRubars,
      formula: row.formula,
      summary: row.summaryText,
      ...provenanceValues({
        cityId: bundle.cityId,
        cityName: bundle.cityName,
        trustTier: "verified",
        sourceType: "log",
        sourceRef: `seq ${row.seq}`,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          "Derived from the standing Log (brief §1.5): one row per committed stats.treasuryRubars change. The Log is the record; this view is a convenience copy of it.",
      }),
    })),
  };

  const actionsSheet: SheetSpec = {
    name: "Action History",
    columns: withProvenance(ACTION_HISTORY_COLUMNS),
    rows: bundle.actions.map((row) => ({
      action_id: row.actionId,
      action_type: row.actionType,
      status: row.status,
      actor: row.actorLabel,
      target_city_ids: row.targetCityIds.join(", "),
      first_log_seq: row.firstLogSeq,
      last_log_seq: row.lastLogSeq,
      resolution_id: row.resolutionId,
      ...provenanceValues({
        cityId: bundle.cityId,
        cityName: bundle.cityName,
        trustTier: "verified",
        sourceType: "log",
        sourceRef: row.resolutionId,
        asOfSeq: ctx.asOfSeq,
        rulesVersion: ctx.rulesVersion,
        notes:
          "Actions as recorded on sim_actions; outcomes are in the Log (see the Treasury Ledger tab and the realm Log export).",
      }),
    })),
  };

  const definitions: ColumnDefinition[] = [
    ...defs("Treasury Ledger", [
      ["before_rubars", "The city treasury immediately before this committed change (from the Log entry's change record).", "Rubar"],
      ["after_rubars", "The city treasury immediately after it.", "Rubar"],
      ["delta_rubars", "after − before, computed at export and written as a value.", "Rubar"],
      ["formula", "The ruling formula the resolver recorded for the change.", null],
    ]),
    ...defs("Action History", [
      ["action_type", "The submitted action kind (the classifying rule's verb).", null],
      ["status", "The action's terminal/current status on its record.", null],
      ["first_log_seq", "First Log seq the action's resolution produced; empty until resolved.", null],
    ]),
    ...provenanceDefinitions("Treasury Ledger"),
    ...provenanceDefinitions("Action History"),
  ];

  return assembleWorkbook({
    filenameBase: exportFilenameBase(
      `${bundle.cityName}-ledger`,
      ctx.asOfSeq,
      ctx.exportedAtIso
    ),
    meta: {
      title: `City Ledger — ${bundle.cityName}`,
      scopeLabel: `${bundle.cityName} (treasury ledger view + action history)`,
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [treasurySheet, actionsSheet],
    definitions,
  });
}

// ---------------------------------------------------------------------------
// Survey results (the collector's own intel — TC-X05)
// ---------------------------------------------------------------------------

const SURVEY_COLUMNS: SheetColumn[] = [
  { key: "record_id", header: "record_id", width: 20, type: "string" },
  { key: "target_city_id", header: "target_city_id", width: 16, type: "string" },
  { key: "target_business_id", header: "target_business_id", width: 19, type: "string" },
  { key: "method", header: "method", width: 20, type: "string" },
  { key: "method_ref", header: "method_ref", width: 22, type: "string" },
  { key: "collected_at_seq", header: "collected_at_seq", width: 17, type: "number" },
  { key: "reliability_band", header: "reliability_band", width: 17, type: "string" },
  { key: "band_dropped_at_delivery", header: "band_dropped_at_delivery", width: 24, type: "boolean" },
  { key: "coverage_achieved_pct", header: "coverage_achieved_pct", width: 21, type: "number" },
  { key: "coverage_cap_pct", header: "coverage_cap_pct", width: 17, type: "number" },
  { key: "coverage_funded_cap_pct", header: "coverage_funded_cap_pct", width: 23, type: "number" },
  { key: "target_population", header: "target_population", width: 26, type: "string" },
  { key: "known_unknowns", header: "known_unknowns", width: 30, type: "string" },
  { key: "null_reasons", header: "null_reasons", width: 26, type: "string" },
  { key: "metric", header: "metric", width: 20, type: "string" },
  { key: "value", header: "value", width: 16, type: "string" },
  { key: "unit", header: "unit", width: 12, type: "string" },
  { key: "finding_note", header: "finding_note", width: 36, type: "string" },
];

export function buildSurveyResultsSheet(
  records: SurveyRecordData[],
  ctx: ExportContext,
  requesterUid: string
): SheetSpec {
  assertSurveyRecordsAreRequesters(records, requesterUid);
  const rows: SheetSpec["rows"] = [];
  for (const record of records) {
    // A record with no findings still exports one row: its limits
    // (coverage, band, null reasons) are first-class data, and a
    // survey that found nothing must not vanish from the export.
    const findings = record.findings.length > 0 ? record.findings : [null];
    for (const finding of findings) {
      rows.push({
        record_id: record.recordId,
        target_city_id: record.targetCityId,
        target_business_id: record.targetBusinessId,
        method: record.methodKindLabel,
        method_ref: record.methodRef,
        collected_at_seq: record.collectedAtSeq,
        reliability_band: record.band,
        band_dropped_at_delivery: record.bandDroppedAtDelivery,
        coverage_achieved_pct: record.coverageAchievedPct,
        coverage_cap_pct: record.coverageCapPct,
        coverage_funded_cap_pct: record.coverageFundedCapPct,
        target_population: record.targetPopulationText,
        known_unknowns: record.knownUnknowns.join("; "),
        null_reasons: record.nullReasons.join("; "),
        metric: finding?.metric ?? null,
        value:
          finding?.value === null || finding?.value === undefined
            ? null
            : String(finding.value),
        unit: finding?.unit ?? null,
        finding_note: finding?.note ?? null,
        ...provenanceValues({
          cityId: record.targetCityId,
          cityName: null,
          entityId: record.targetBusinessId,
          entityName: null,
          trustTier: "intel_survey",
          sourceType: "intel_survey",
          sourceRef: record.collectionResolutionId,
          asOfSeq: ctx.asOfSeq,
          rulesVersion: ctx.rulesVersion,
          stateVersion: record.stateVersion,
          collectedBy: ctx.exportedByLabel,
          notes:
            "Intel is the collector's own record of a means-gated collection: figures carry the reliability band and coverage they were collected under — they are not resolver ground truth, and weak means show up here as weak bands, not hidden caveats.",
        }),
      });
    }
  }
  return { name: "Survey Results", columns: withProvenance(SURVEY_COLUMNS), rows };
}

export function buildSurveyWorkbook(
  records: SurveyRecordData[],
  ctx: ExportContext,
  requesterUid: string
): PlannedWorkbook {
  const sheet = buildSurveyResultsSheet(records, ctx, requesterUid);
  const definitions: ColumnDefinition[] = [
    ...defs("Survey Results", [
      ["reliability_band", "The frozen grading band (A–D) the collection was commissioned and delivered under.", null],
      ["band_dropped_at_delivery", "True when delivery conditions dropped the band one step (e.g. unverifiable span).", null],
      ["coverage_achieved_pct", "Coverage actually achieved, as recomputed at delivery.", "%"],
      ["coverage_cap_pct", "The means' coverage cap from the published grading tables.", "%"],
      ["coverage_funded_cap_pct", "The funded coverage cap after the commission's budget class applied.", "%"],
      ["known_unknowns", "What the collection states it does not know — exported, not hidden.", null],
      ["null_reasons", "Per-metric reasons a value is null (the closed null-reason vocabulary).", null],
      ["value", "The finding's value, as text: intel values are as reliable as their band, and are never silently promoted to verified figures.", null],
    ]),
    ...provenanceDefinitions("Survey Results"),
  ];
  return assembleWorkbook({
    filenameBase: exportFilenameBase("survey-results", ctx.asOfSeq, ctx.exportedAtIso),
    meta: {
      title: "Survey Results — own collected intel",
      scopeLabel: "Intel records collected by the requester only (TC-X05)",
      exportedAtIso: ctx.exportedAtIso,
      exportedByLabel: ctx.exportedByLabel,
      asOfSeq: ctx.asOfSeq,
      rulesVersion: ctx.rulesVersion,
      containsOwnerPublished: false,
    },
    dataSheets: [sheet],
    definitions,
  });
}

// ---------------------------------------------------------------------------

function defs(
  tab: string,
  entries: [string, string, string | null][]
): ColumnDefinition[] {
  return entries.map(([column, meaning, unit]) => ({
    tab,
    column,
    meaning,
    unit,
    trustTier: tab === "Survey Results" ? "intel_survey" : "verified",
    source:
      tab === "Survey Results"
        ? "sim_intel_records (collector's own)"
        : "sim state (resolver/Log)",
  }));
}
