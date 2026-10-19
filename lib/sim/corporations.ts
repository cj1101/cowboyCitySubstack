/**
 * The corporation record — `sim_cities/{cityId}/corporations/{corporationId}`.
 *
 * Shape provenance, three layers, landed together here by the Phase 4
 * Module 0 data step (build-prep P4-K11) so every later Phase 4 handler
 * reads one lawful record:
 *
 *  1. Base shape: Dana's backend architecture §3 (name, industry, status,
 *     valuationRubars, founderFigureId, homeCityId, marketCityIds,
 *     linkedStructureIds, source/seq/version bookkeeping). Reads are
 *     members + guests; writes are fabric-committer only, through
 *     R-06/R-07 or successor rules (the rules block landed in Phase 1).
 *  2. Market amendment A-7, carried by finance FIN-C3 and CONFIRMED at
 *     P4-K11: `ownerMemberId` and `companyCashRubars` are first-class
 *     fields, and `taxPayables` gets its shape (finance §5.3). F-03/F-06
 *     validation reads `ownerMemberId` — never an inference from
 *     `founderFigureId`, which is a lore persona link, not an ownership
 *     fact.
 *  3. Phase 4 brief §1.4: `legacyBookRubars` (provenance/display only —
 *     it is NOT an input to the market repricing formula) and the
 *     `listed` flag, which keys the dual meaning of `valuationRubars`
 *     (book value unlisted / market-cap cache at last touching event
 *     listed). Every surface that renders `valuationRubars` labels which
 *     meaning is live, keyed off `listed`; no surface guesses.
 *
 * This module is the shape and the founding builder only. No handler
 * lives here: R-06/R-07 (Catalogue II) create and mutate records through
 * resolutions, F-06 (Catalogue II) assesses into `taxPayables`, and the
 * Finance module moves `companyCashRubars` — all via the committer.
 */

export type CorporationStatus =
  | "active"
  | "contracted"
  | "relocated"
  | "dissolved";

export const CORPORATION_STATUSES: readonly CorporationStatus[] = [
  "active",
  "contracted",
  "relocated",
  "dissolved",
];

/**
 * Per-city unpaid tax remainders (finance §5.3): `{ [cityId]: integer }`.
 * A payable is a recorded obligation, not a loan — it accrues nothing, is
 * not tradable, and is held as no one's asset; the host treasury is
 * credited only when cash actually moves (F-07). An empty map means no
 * outstanding payables. Keys are removed when a city's remainder reaches
 * zero (paid or forgiven by a logged act) — a zero entry and an absent
 * key must never carry different meanings.
 */
export type TaxPayables = Record<string, number>;

export interface CorporationRecord {
  corporationId: string;
  name: string;
  industry: string;
  status: CorporationStatus;
  /** Dual meaning keyed by `listed` (brief §1.4): book value when
   * unlisted; market-cap cache at last touching event when listed. */
  valuationRubars: number;
  listed: boolean;
  /** The unlisted formula's result at founding/listing, or null where
   * skipped under the null-GDP rule. Provenance/display only. */
  legacyBookRubars: number | null;
  /** Lore persona link (Dana base shape). NOT an ownership fact. */
  founderFigureId: string | null;
  /** A-7: the member who owns this corporation. The one ownership fact
   * F-03/F-06 validation may read. */
  ownerMemberId: string;
  /** A-7: the company's own cash ledger (finance §1.1 account class 3). */
  companyCashRubars: number;
  /** Finance §5.3 payables shape — see TaxPayables above. */
  taxPayables: TaxPayables;
  homeCityId: string;
  marketCityIds: string[];
  linkedStructureIds: string[];
  sourceActionId: string;
  sourceSeq: number;
  stateVersion: number;
  lastChangedSeq: number;
  lastResolutionId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** The record's path — the one spelling read plans and handlers use. */
export function corporationPath(cityId: string, corporationId: string): string {
  return `sim_cities/${cityId}/corporations/${corporationId}`;
}

/**
 * The founding-time record (R-06 creates through this builder inside its
 * commit transaction). Founding economics are the caller's: the founding
 * rule computes `valuationRubars` (amended R-06) and `legacyBookRubars`
 * and passes both in — this builder invents no value. Cash starts at a
 * true bookkeeping zero; funding arrives as F-03 resolutions, never as a
 * founding default. `listed` starts false; listing is an M-01/M-02 act.
 */
export function buildCorporationDoc(args: {
  corporationId: string;
  name: string;
  industry: string;
  ownerMemberId: string;
  founderFigureId: string | null;
  homeCityId: string;
  marketCityIds?: string[];
  valuationRubars: number;
  legacyBookRubars: number | null;
  sourceActionId: string;
  sourceSeq: number;
  lastResolutionId: string;
  now: Date;
}): Record<string, unknown> {
  const record: CorporationRecord = {
    corporationId: args.corporationId,
    name: args.name,
    industry: args.industry,
    status: "active",
    valuationRubars: args.valuationRubars,
    listed: false,
    legacyBookRubars: args.legacyBookRubars,
    founderFigureId: args.founderFigureId,
    ownerMemberId: args.ownerMemberId,
    companyCashRubars: 0,
    taxPayables: {},
    homeCityId: args.homeCityId,
    marketCityIds: args.marketCityIds ?? [],
    linkedStructureIds: [],
    sourceActionId: args.sourceActionId,
    sourceSeq: args.sourceSeq,
    stateVersion: 1,
    lastChangedSeq: args.sourceSeq,
    lastResolutionId: args.lastResolutionId,
    createdAt: args.now,
    updatedAt: args.now,
  };
  return { ...record };
}
