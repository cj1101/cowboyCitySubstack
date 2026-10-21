# Phase 4 step 7 — Market slice: prep report (Cato)

Status: COMPLETE (module build). Branch `p4/market` in
`p4-market-clone`, base `63a1445` (tree == master `b5eb611`: Finance +
Catalogue I + Defensive + Chains + Catalogue II landed; registry at
44 descriptors). Base verified tsc-clean before any edit (`npm ci`
succeeded in this clone; no symlink needed). Final state: repo
`tsc --noEmit` clean; `tests/market-harness.ts` 27/27 green; the
cat1/cat2/chains/defense harnesses re-run green (no regression from
the §3 finance landings). No registry/rules/index/verify/businesses/
laws edits; no push; nothing deployed.

Governing texts: `market-systems-spec.md` (my spec, M-01–M-12),
`phase4-implementation-brief.md` §7.3, `phase4-build-prep-report.md`
(P4-K18/K21/K22/K25, step-7 worker row), `finance-system-design.md`
(§1 account model, §2.1 transfer primitive, §3.1/§3.3 conservation +
closed mint list), PR #33's named step-7 obligations (M-01/M-02
founder-holding creation/backfill before any holdings supply is wired;
M-06 in-event execution against R-07's coded inputs; M-08/M-09
un-blocking the listed Contract cash leg per P4-K22; M-10 un-blocking
listed Dissolve).

## 1. Composition decisions taken at grounding (surfaced, not hidden)

**D-1 — Custody float governs; the market-engine's MM-inventory model
is superseded.** P4-K21(i) (ADOPTED) rules: float shares remain in the
founder's holding as *committed* (mechanically a resting limit sell);
the Market Maker holds **no share inventory of its own**; it executes
against committed float under a standing mandate; float sales credit
the **founder's** account (fees to the Market Account); M-02 recall =
release of commitment, no share movement. My earlier market-engine
build (`market-engine-clone` @ `7167162`) implemented the spec §1.7
inventory model, and brief §7.3's one-liner ("trades only float/owned
inventory from the seeded Market Account") still carries that wording.
P4-K21 is the later, adopted build record and it expressly supersedes
the §9 worked-example arithmetic of the same model. The port therefore
keeps the engine's valuation / matching / index / fee mathematics
verbatim and **drops its Market-Maker inventory fills**: the quote
function survives (reference ± spread, for block caps and display);
executions run against the book, in which the float offer is a resting
sell order like any other. Share conservation's "MM inventory ≡ 0"
(P4-K21) then holds by construction.

**D-2 — Holdings are top-level records:
`sim_holdings/{memberId}__{corporationId}`.** Market §10.1 proposed a
holdings subcollection under `sim_member_accounts/{memberId}` (my
proposal; Dana to confirm/replace). The landed Step 0 read contract
(F-01) makes that shape unusable for settlement: a read plan is
one-pass — seeds are the base-path docs only, query results cannot seed
further doc reads, and the production query reader executes plain
collection paths (no collection-group). A settlement event must read
**and write** arbitrary counterparties' holdings (whoever rests in the
book), which a per-member subcollection can never materialize. A
top-level `sim_holdings` collection serves it with one query
(`corporationId == X`), and it is also the shape the conservation
checker's standing-records supply natively expects (records carrying
`corporationId` + `quantityShares`). Flagged for Dana/Lead
ratification at assembly; the member account doc itself is untouched
(finance §1.2 stands exactly as landed).

**D-3 — The listing record is a root doc:
`sim_market_listings/{corporationId}`** (market §10.1's stated lean,
adopted): reference/last-trade/official prices, trading status,
committed-float and public-held counters, earnings window anchor. The
corporation record keeps its landed fields (`listed`,
`paidInCapitalRubars`, `sharesOutstanding`,
`openingReferencePriceRubars`, `lastJudgment`, the `valuationRubars`
market-cap cache, and — new in this slice — `retiredShares`).

**D-4 — `sharesOutstanding` is the cumulative issued count; live
shares = issued − `retiredShares`.** The conservation checker's
standing share assertion is `Σ holdings + retired == sharesOutstanding`
(P4-K21). After a buyback that retires shares, that identity holds
**only** if `sharesOutstanding` never falls — so the checker's grammar
governs: buyback/liquidation retirements accumulate in `retiredShares`
on the corporation record, holdings fall, `sharesOutstanding` stands
as the issued total, and every per-share computation (M-06 division,
index caps, pro-rata) uses **live shares** = issued − retired, with
both figures printed in the Log. Market spec M-09's parenthetical
"(sharesOutstanding falls)" is the superseded reading — spec-text
errata candidate for Vera, flagged in §7 below, not silently flipped:
the executable checker is the law the harness must satisfy.

**D-5 — Resting buys carry no cash reservation in v1.** Share
commitments are enforceable inside this module's fence (shares move
only through market rules), so resting sells commit shares at
placement (`committedShares` on the holding). Cash has other lawful
spend paths (F-02) that a market-side reservation field could not bind
without finance-side cooperation, so a resting buy is validated
against cash at placement (advisory) and **re-validated at crossing**:
if the resting buyer cannot cover an execution, that resting order is
cancelled in-event (`cancelled-insufficient-cash`, logged) and
matching continues — settlement never drives a balance negative
(§1.6 step 7). Escrow/reservation is the Phase 11-depth candidate.
Flagged in §7.

**D-6 — The Market Account never holds shares and is seeded by a
genesis-class founding act, M-00.** Record: `sim_market_account/main`
(finance §1.1's collection, singleton doc), `cashRubars` + the index
divisor anchor. Founding action kind `found_market_account`,
descriptor **M-00** (my numbering, outside the M-01–M-12 table
because the act is genesis-class, like F-01's grant — flagged for
ratification/renumber at assembly). Seed **1,000,000 R** — Cato's N-5
lock proposal: under custody the account never trades in v1, so the
seed is the operator's float for fees/escrow custody headroom
(finance FN-5), sized at 4× the genesis grant; it is a mint under
finance §3.3's closed list, which names this exact seed as joining
when the Market module lands its founding act. If the account does
not stand, market money lines fail and handlers reject
`market-account-missing` — the founding act is a named gate/data-step
item (§6), never lazy-invented inside a trade.

**D-7 — M-10's salvage line is disclosed, not paid, in v1.** Spec
§5.5's waterfall adds "salvage value of linked structures at their
recorded values" to distributable Rubars. Paying it would mint
unbacked cash (no structure-sale mechanism or buyer ledger exists in
Phase 4) and break the conservation invariant this same slice must
prove; M-10's own text states the structures themselves are not
transferred. The waterfall therefore pays from **actual company cash**
(taxes/fees payable → adjudicated → pro-rata holders) and prints the
salvage figure as a non-cash disclosure line in the waterfall entry.
Flagged for Vera in §7.

**D-8 — Earnings proxy is read, never invented.** No landed rule
maintains an earnings-window accumulator on the corporation record,
so M-06's `earningsProxyRubars` input is the record's own
`earningsProxyRubars` figure **if one stands**, else `null` → the
earnings term is skipped and the skip is logged (null-honesty, §4.3).
As operating rules begin writing coded operating credits attributable
to a company, the figure has a lawful source; until then the formula
runs on cash + structures − case discount, and says so.

## 2. What is being built (map)

- `lib/market/**` — the pure engine, ported from
  `market-engine-clone` @ `7167162` (57-assertion harness green there):
  `types.ts` (constants + shapes, custody-adjusted), `valuation.ts`
  (§4.4 formula, §4.7 step cap ±25% with the two named exceptions,
  §4.1 official-price rule, §4.2 opening price), `matching.ts`
  (price–time priority, resting-price execution, self-match
  prevention), `marketMaker.ts` (quote only — see D-1),
  `settlement.ts` (fee schedule + per-execution delta computation),
  `realmIndex.ts` (RCI derived-never-stored, divisor, concentration
  warning), `index.ts` barrel. `ledgers.ts` is **not** ported:
  finance's `lib/finance/{accounts,transfer,conservation}.ts` own
  seams and conservation now; the port notes this in the barrel.
- `lib/sim/marketRecords.ts` — record builders/paths for the listing,
  holding, order, and trade records + the Market Account record, and
  the pure **founder-holding backfill planner** (M-01/M-02 obligation:
  given corporation + holding views, list every listed corporation
  whose founder holding is missing or short, with the exact repair
  figures — the operated data step and the M-01 completion branch
  consume the same computation).
- `lib/sim/rules/market.ts` — the family: descriptors **M-00…M-12**,
  handlers, F-01 read plans, the exported in-event composers
  `composeMarketRepricing` (M-06), `composeDistribution` (M-08's leg),
  `composeLiquidation` (M-10's waterfall) for the Lead's wiring, plus
  `MARKET_DESCRIPTORS`, `MARKET_FINANCE_ADDITIONS` (finance §2.4),
  and `MARKET_UNDO_CLASSES` (P4-K25: M-03/M-04/M-10
  `locked-at-commit`).
- In-fence `lib/finance` landings (§3) — the three edits the designs
  assign to this module's landing.
- `tests/market-harness.ts` — pure-logic battery in the cat1/cat2
  idiom: every resolved plan through the real `validatePlan`, every
  money event through the real conservation checker, standing share
  conservation after each phase.

## 3. In-fence lib/finance edits (taken, enumerated)

The task fence forbids `registry.ts`, `firestore.rules`,
`firestore.indexes.json`, `verify.ts`, `businesses.ts`, `laws.ts`.
The three edits below are in `lib/finance/**`, each expressly
anticipated by that module's own text as this landing's work:

1. `accounts.ts` — `ledgerDocPath({kind:"market"})` returns
   `sim_market_account/main` (was `null`: "whose record the Market
   module owns and Phase 4 finance never writes" — the owner has now
   landed the record). New exported const `MARKET_ACCOUNT_PATH`.
2. `transfer.ts` — the blanket `MARKET_LEDGER_UNAVAILABLE` refusal is
   lifted. Finance's own prep record states the posture: market lines
   refuse "*until the Market module lands its account — M-04
   settlement composes through the same primitive then.*" Structural
   validation, netting, and the custodial branch are unchanged.
3. `conservation.ts` — (a) `MINT_RULES` gains `"M-00"` (the file's own
   comment: "the Market Account seed joins when the Market module
   lands its founding act"); (b) `cashDeltaOfWrite` recognizes
   `sim_market_account/main` as a fourth tracked cash pattern
   (`cashRubars`), per finance §3.1's generalized invariant, which
   already names the Market Account inside Σ Δtracked; (c)
   `resolveChangeTarget` maps the `marketAccount.cashRubars` change
   field (the spelling `accounts.ts` already defines) to that doc, so
   fee legs enter the paired-posting and Log/writeSet bijection
   checks instead of passing unseen.

No test in the repo asserts the old refusal or the null path (grep
verified before editing).

## 4. Record shapes (as built)

All shapes live in `lib/sim/marketRecords.ts` (builders stamp
`stateVersion`/`lastChangedSeq`/`lastResolutionId`/`createdAt`/
`updatedAt` per the family convention). Paths are root collections
(D-2) so any handler can read/write any counterparty's records in
one event.

- **Market Account** — `sim_market_account/main`:
  `{ kind: "market-account", cashRubars, seedRuleId: "M-00",
  seedRubars: 1_000_000, indexDivisorBaseRubars: number|null,
  genesisListingCorporationId: string|null }` + version fields.
  Founded only by the M-00 act (§6); handlers never lazy-create it —
  trade events reject `market-account-missing` while it is absent.
- **Listing** — `sim_market_listings/{corporationId}` (D-3):
  `{ corporationId, homeCityId, ownerMemberId, status:
  "listed"|"delisted", tradingStatus: "open"|"halted"|"suspended"|
  "delisted", referencePriceRubars, officialPriceRubars,
  lastTradePriceRubars|null, tradedSinceLastRepricing,
  committedFloatShares, publicHeldShares, cumulativeFeesRubars,
  listedAtSeq, delistedAtSeq|null, finalLiquidationPriceRubars|null,
  haltReason: null|"downtime"|"owner-suspension", haltedAtSeq|null }`.
  The float invariant at every commit: `committedFloatShares` ==
  resting float-offer quantity; `publicHeldShares` == Σ non-founder
  holdings; the index float is their sum (§3.2).
- **Holding** — `sim_holdings/{memberId}__{corporationId}` (D-2):
  `{ memberId, corporationId, homeCityId, quantityShares,
  committedShares, costBasisRubars }`. `committedShares` backs the
  holder's resting SELL orders (incl. the founder's float offer);
  `quantityShares − committedShares` is the free balance every verb
  validates against. Cost basis moves only on acquisitions.
- **Order** — `sim_market_orders/{orderId}`: `{ orderId,
  corporationId, homeCityId, memberId, side, type: "limit"|"market",
  kind: "standard"|"float-offer", quantityShares (remaining),
  originalQuantityShares, filledShares, limitPriceRubars|null
  (protection cap for market orders; the float price for offers),
  status: "resting"|"filled"|"cancelled"|"expired",
  cancelReason|null, placedAtSeq, expiresAtSeq|null }`.
  Ids: `ord_<resolutionId>` for placed orders, `float_<corporationId>`
  for the one standing float offer per listing.
  `cancelReason` vocabulary: `owner-cancel`, `float-recall`,
  `unfilled-market-remainder`, `insufficient-cash-at-settlement`,
  `listing-liquidated` (+ `expired` is a status, not a reason).
- **Trade (the tape)** — `sim_market_trades/{tradeId}`: `{ tradeId,
  corporationId, homeCityId, buyerMemberId, sellerMemberId,
  quantityShares, priceRubars, valueRubars, buyerFeeRubars,
  sellerFeeRubars, incomingOrderId, restingOrderId, seq }`.
  Ids: `trade_<resolutionId>_<nn>` (two-digit execution counter).
  M-09 buyback fills carry the disclosed spellings
  `buyerMemberId: "company:<corporationId>"` and
  `incomingOrderId: "buyback_<resolutionId>"` — the buyer is the
  company, never a person, and the tape says so.
- **Corporation record deltas** (additive only): `retiredShares`
  (new field, written by M-09/M-10; absent reads as 0),
  `valuationRubars` cache (official × live shares, written by every
  repricing incl. M-01's opening), `listed`, `sharesOutstanding`,
  `paidInCapitalRubars`, `openingReferencePriceRubars`,
  `lastJudgment` (already folded by Cat II assembly; M-01/M-02/M-06
  are their market writers).
- **Change-field spellings** (the conservation checker's closed
  vocabulary): `marketAccount.cashRubars` on null-city entries;
  `marketListings/<id>.<field>`, `holdings/<memberId>__<id>.<field>`,
  `marketOrders/<id>.<field>`, `marketTrades/<id>.<field>` on
  null-city entries; company legs as
  `corporations/<id>.companyCashRubars` on the home-city entry;
  treasury legs as `stats.treasuryRubars` on the creditor city's
  entry; personal legs as `memberAccounts/<id>.cashRubars` on
  null-city entries. Zero-fee M-04 transfers state their fee line in
  entry TEXT only — a `marketAccount.cashRubars` change record with
  no matching write would break the checker's Log⇄writeSet
  bijection, correctly.

## 5. Lead assembly (exact — specified, not taken)

1. **Registry merge** (`lib/sim/rules/registry.ts`): spread
   `MARKET_DESCRIPTORS` (from `lib/sim/rules/market.ts`) into
   `RULE_DESCRIPTORS`, and fold `MARKET_FINANCE_ADDITIONS` onto the
   `finance` descriptor exactly as `BUSINESS_REGISTERED` folds
   Catalogue II's additions (class from the addition when the base
   carries none, `moneyPaths` unioned, `invokesRules` unioned).
   Result: **57 descriptors** (44 + M-00…M-12).
2. **`undoClass` (P4-K25)**: `RuleDescriptor` has no such field
   today. Add `undoClass?: "locked-at-commit" | …` to the type and
   fold `MARKET_UNDO_CLASSES` (`{ M-03, M-04, M-10 }`) onto the
   market descriptors at the same merge. Note: `lib/sim/undo.ts`
   does not read any such field yet — until it does, the class is
   documentary; the Lead confirms whether assembly also teaches the
   undo engine to refuse these ruleIds' events outright.
3. **`verify.ts` holdings supply** (the PR #33 obligation — wire
   ONLY after the §6 data step completes): in
   `verifyStandingConservation` (a) add the market rule ids to
   `financeRuleIds` (`...Object.keys(MARKET_DESCRIPTORS)` once
   registered — M-00…M-11 move or accompany money; M-12 cites
   nothing); (b) extend `isFinancePath` with
   `path.startsWith("sim_market_account/")`; (c) collect
   `holdingDocs` in the state-docs pass
   (`segments[0] === "sim_holdings" && segments.length === 2`) and
   pass `holdings: holdingDocs` into the existing
   `checkStandingRecords({...})` call, replacing the Cat II comment
   at that site ("NO holdings supply is wired… stays inert until
   step 7"). The harness's `assertStanding` is this exact wiring in
   miniature and is green over every storyline world.
4. **`firestore.rules` posture for the five new collections**
   (`sim_market_account`, `sim_market_listings`, `sim_holdings`,
   `sim_market_orders`, `sim_market_trades`): none has a match block
   today (grep-verified). Family-consistent recommendation:
   committer-only writes, viewer reads — the `sim_cases` posture
   from the Defensive assembly. Until these land, production
   resolution of any market action cannot read its own records
   under the committer identity; treat as assembly-blocking.
5. **`firestore.indexes.json`** (Lead-only): one composite index —
   `sim_market_trades` on (`corporationId` ASC, `seq` ASC) for the
   tape/publication reads. The book and holdings queries are
   equality-only and need no composite.
6. **`test:sim`**: chain `npx tsx tests/market-harness.ts` after the
   cat2 harness (the e85a620 pattern).
7. **`businesses.ts` seams — SPECIFIED, NOT TAKEN** (the module was
   built so every seam is a composition, not an edit war):
   (i) R-07 listed Contract cash leg: replace the
   `cash-leg-requires-market-module` rejection with
   `composeDistribution({ entryRuleIds: ["R-07","M-08"],
   invokedByRuleId: "R-07", … })` followed by
   `composeMarketRepricing({ invokedByRuleId: "R-07", … })` when the
   Lead wants withdrawals to succeed in-verb. **Recommendation: the
   fail-closed rejection is also lawful as-is** — it already routes
   owners to the M-08/M-09 verbs, which ARE the un-block (harness
   check 16 proves the pair). Take (i) only as a UX decision, never
   as a correctness need. (ii) R-07 listed Dissolve: same shape with
   `composeLiquidation({ entryRuleIds: ["R-07","M-10"] })`; same
   recommendation. (iii) R-07 listed branches + any future
   input-changing event: compose `composeMarketRepricing` in-event
   (P4-K18's "M-06 is the only writer" cuts both ways — listed
   branches currently declare `invokesRules: ["M-06"]` but never
   reprice; needs `listingPath(corporationId)` + the listings query
   added to `corporationActionReadPlan` — the structures query is
   already there). (iv) **Named F-03 gap**: F-03 funding of a listed
   company changes company cash (an M-06 input) but cannot reprice
   until a later market event; finance-side composition of
   `composeMarketRepricing` has the same read-plan shape as (iii).
   Until (iii)/(iv) land, prices move at the next market verb — a
   disclosed lag, not a silent one: every market entry prints the
   inputs it used. (v) **Step-11 hand-off**: M-06 composition inside
   ripening plans (structure completions/repairs changing coded
   inputs while no market verb fires) belongs to the pending-rules
   engine work, not to a handler edit.

## 6. Operated data step (the gate before §5 item 3)

In order, against production corpora, each step a player/fabric act
— no direct writes:

1. **Found the Market Account**: one member submits
   `found_market_account` (M-00). Until this lands, every trade verb
   rejects `market-account-missing` and listings anchor nothing.
2. **Backfill report**: run `planFounderHoldingBackfill` (pure,
   exported from `lib/sim/marketRecords.ts`) over all standing
   corporation docs + holdings + listings. For corpora that predate
   step 7 the expected output is: one gap per company listed at
   R-06 founding, `missingShares == sharesOutstanding` (no holdings
   exist yet), zero gaps elsewhere. Any OTHER shape (a standing
   holding short of issued, a listing whose founder holding exceeds
   live shares) is a data incident to surface, not to paper over —
   M-01 completion itself rejects the over-issued shape as
   `share-ledger-inconsistent`.
3. **Completion acts**: for each gap company, its owner submits
   `list_company` (M-01 branch (a)) — optionally with `floatShares`
   to open a float in the same act. This creates the listing record
   + founder holding from the founding figures and anchors the
   index divisor if the float is the realm's first positive one.
4. **Only then** wire the `verify.ts` holdings supply (§5 item 3).
   Wired earlier, the checker would — correctly — fail every
   standing listed company that has not yet been completed; wired
   after, the assertion Σ holdings + retired == sharesOutstanding
   guards the whole corpus from that seq forward.

## 7. Flags (surfaced, not flipped)

- **D-1 / brief §7.3 wording** (Vera/Lead): the brief's market-maker
  "owned inventory" language is superseded by P4-K21(i) custody;
  the brief text should be aligned so the next reader does not
  re-derive the conflict.
- **D-2 holdings shape** (Dana/Lead ratification): top-level
  `sim_holdings` vs systems-spec §10.1's subcollection spelling —
  forced by the F-01 read contract (query results cannot seed doc
  reads; settlement touches arbitrary counterparties). §5 item 4's
  rules posture assumes the top-level shape.
- **D-4 spec errata candidate** (Vera): market spec M-09's
  "(sharesOutstanding falls)" contradicts the conservation identity
  under any reading where holdings also fall; the module implements
  cumulative-issued + `retiredShares` (identity exact, harness
  check 18). If Vera prefers falling outstanding, the checker
  assertion and D-4 flip together — a spec decision, not a code
  preference.
- **D-6 M-00 numbering + seed** (ratify at assembly): the founding
  act is numbered M-00 as genesis-class, outside M-01–M-12; the
  1,000,000 R seed is the N-5 lock proposal. Renumbering is a
  one-line change in `market.ts` + `conservation.ts` `MINT_RULES`
  if the Lead prefers it inside the sequence.
- **D-7 salvage** (Vera): M-10 discloses structure salvage and does
  not pay it — paying would mint unbacked cash and break the
  conservation invariant the checker proves. A salvage buyer or a
  treasury-funded salvage pool is a design addition, not a patch.
- **§4.1 official-price wording** (Vera): as written, a print in
  the repricing event supersedes the fresh reference for the
  official price; harness check 18 pins the consequence (official
  140 against reference 110 in one M-09 event) and M-08 distributions
  without prints reprice the official normally (check 16). If the
  intent was "official follows reference except between repricings,"
  the composer is the single place to change.
- **D-5 escrow** (Phase 11 candidate): resting buys are unreserved;
  crossing re-validation + in-event cancellation is the v1
  discipline. True escrow needs a reserved-balance field on member
  accounts (finance's call) and a reservation release protocol.
- **Custody block-quote derivation** (already flagged in
  `lib/market/marketMaker.ts`): the spec's block-size derivation
  assumed an MM-inventory counterparty; under custody the derived
  cap/quote figures are display + placement-validation inputs only.
- **M-12 stub**: the descriptor carries `actionKinds: []` — the
  market publication layer is step 9's R-30 work; the tape records
  (§4) are written now so R-30 reads, never reconstructs.
- **NPC actors**: every market handler rejects NPC actors
  (`npc-mandate-unavailable`) — NPC market mandates are unbuilt
  design, consistent with the family's posture elsewhere.
- **D-8 earnings proxy**: no module writes `earningsProxyRubars`
  yet; M-06 reads a standing finite integer or treats the term as
  absent (null, logged). The first writer (a finance/business
  earnings record) inherits the closed-list seat unchanged.
