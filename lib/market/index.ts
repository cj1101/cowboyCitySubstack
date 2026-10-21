/**
 * lib/market — pure market core barrel (Cato's market-systems-spec v1,
 * Phase 4 step-7 port). Pure functions + types only: no Firestore, no
 * dispatcher, no I/O. The resolver family (lib/sim/rules/market.ts)
 * adapts these functions into ResolutionPlans; this module never
 * imports lib/sim.
 *
 * NOT ported from the engine build: `ledgers.ts` (three-ledger seam
 * guards + a local conservation check). Finance's landed modules own
 * that ground now — lib/finance/accounts.ts (ledger grammar),
 * lib/finance/transfer.ts (the one movement primitive), and
 * lib/finance/conservation.ts (the checker every market event is
 * proven against) — and a second, market-local copy of the seam table
 * would be a divergence waiting to happen.
 */
export * from "./types";
export * from "./valuation";
export * from "./realmIndex";
export * from "./settlement";
export * from "./matching";
export * from "./marketMaker";
