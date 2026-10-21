# Phase 4 step 7 — Market slice: prep report (Cato)

Status: BUILDING. Branch `p4/market` in `p4-market-clone`, base
`63a1445` (tree == master `b5eb611`: Finance + Catalogue I + Defensive
+ Chains + Catalogue II landed; registry at 44 descriptors). Base
verified tsc-clean before any edit (`npm ci` succeeded in this clone;
no symlink needed).

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

(To be completed as the module lands; §5–§7 follow at completion.)
