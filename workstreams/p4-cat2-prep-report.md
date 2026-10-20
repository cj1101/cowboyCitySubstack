# Phase 4 Catalogue II (businesses & tax) — prep report

**Worker:** Felix (Muse Eng), Phase 4 step 6.
**Clone / branch:** `p4-cat2-clone` at local base `b3a0303` (tree verified
byte-identical to remote master `b7743d7` — Finance + Catalogue I in tree),
branch `p4/catalogue-business`. No push; the Lead assembles and pushes.
**Deliverable:** new family file `lib/sim/rules/businesses.ts` — R-06/R-07
in both branches, the F-06 assessment composer + descriptor, F-07
`pay_tax_arrears`, the tax-payables flow — plus a pure-logic harness
(`tests/cat2-harness.ts`, modeled on `tests/cat1-harness.ts`) and the
README delta. Environment: `npm ci` failed sandbox-wide with EPERM tar
errors; `node_modules` is a local symlink to `../phase4-clone/node_modules`
(the allocation-clone precedent; gitignored, never rides a PR). Base
verified clean before any edit: `tsc --noEmit` exit 0 on the untouched
base, TypeScript 5.9.3.

Ownership fence observed throughout: **no edits** to
`lib/sim/rules/registry.ts`, `firestore.rules`, `firestore.indexes.json`,
or `lib/sim/verify.ts`. Everything the Lead must assemble is listed in
§5. Corporation-record deltas are applied by the R-06 handler on top of
Module 0's `buildCorporationDoc` output (that file is not edited); §5
lists the deltas for the Lead/Dana to fold into the builder and the
`CorporationRecord` type at assembly.

---

## 1. Design — descriptors, action kinds, read plans

| Descriptor | Action kinds | Class (finance additions) | Ledgers | Invokes |
|---|---|---|---|---|
| R-06 | `found_corporation` | transfer | personal, company | M-01, M-06 (declared seam, listed branch) |
| R-07 | `expand_corporation`, `contract_corporation`, `relocate_corporation`, `dissolve_corporation` | budget (the unlisted Expand path; listed paths are transfer-disciplined in-handler — see flag F2) | personal, company, treasury, exterior | M-06 (listed branch), M-08/M-09/M-10 (named in rejections until step 7) |
| F-06 | *(none — resolver step, cited by invoking rules)* | none (assessment collects what is collectible by rule; the payable is the mechanism, §2) | company, treasury | — |
| F-07 | `pay_tax_arrears` | transfer | company, treasury | — |

Rejection codes are kebab-case, the finance-family convention ratified
at PR #29. Handlers follow the landed family discipline: read plans
derive only from the action's own seeds (actor + `structuredAction`
fields), never from citations; NPC actors reject (`npc-mandates-deferred`,
the finance posture — mandates are Phase 5); authority reads stored
records (`ownerMemberId` for company acts, `checkCityAuthority` where a
treasury/governance fact is read) and never `founderFigureId` (A-7);
every money movement composes through `applyTransferLines`, so every
event this module produces is checkable by the finance conservation
checker unchanged (cash legs carry its exact change grammar, including
the dotted `corporations/<id>.taxPayables.<cityId>` spelling the
checker's bijection resolves — see §4).

**Read plans.** R-06: home + second-city docs, the founder's personal
account (listed paid-in + lazy-open), and a structures query over the
home city (industry synergy). R-07: the corporation doc (home city +
corporation id from the action), the city docs whose GDP/indices move,
the actor's personal account (listed Expand funding), the destination
city doc + new corporation path (Relocate), a structures query over the
home city (link validation / unlink / dissolve third-city derivation
inputs). F-07: the corporation doc and the creditor city's doc (its
treasury is a transfer target, so it must stand in the snapshot).

## 2. F-06 — the assessment composer

`composeTaxAssessment({ plan, snapshot, actor, citingRuleId, fact })` is
exported from `businesses.ts`. A taxable fact is
`{ kind, corporationId, homeCityId, operatingCityId, baseAmountRubars }`
with `kind ∈ operating-credit | contract-payment | payroll` (finance
design §5.2's closed v1 list), mapped to the schedule component
(`operatingReceiptsBps` / `contractPaymentsBps` /
`payrollWithholdingBps`) derived from the operating city's in-force laws
via Catalogue I's `deriveTaxScheduleFromLaws`. The composer:

1. Reads the corporation from the planned doc and the operating city's
   law set from the snapshot query (the read-plan contract: any rule
   invoking F-06 must declare the operating city's laws query — R-06 /
   R-07 declare it for every city a fact can name; see flag F5 for the
   F-10 retrofit this implies).
2. Unset component → no writes; returns `skipped: tax schedule unset`
   for the caller's Log (honest zero, finance §2.3 F-06). Assessed 0 at
   a 0 rate is likewise returned as a stated figure, never a skip.
3. `assessed = Math.round(base × bps / 10000)` — flag F4.
4. `collected = min(assessed, spendable surface)` composed as ONE
   transfer line company → treasury(operating city), transfer class
   (sufficient by construction). The surface is the transfer
   primitive's own `spendableSurface`: raw cash for an ordinary
   company, UNENCUMBERED cash for a chartered bank — an assessment
   therefore never reaches depositor-encumbered funds, and the
   remainder beyond the surface becomes the payable like any other
   uncollectible remainder. Company cash never goes below zero.
5. The remainder folds into `taxPayables[operatingCityId]` on the
   corporation record via `planMutate` against the planned doc (so it
   composes with the cash write from the same event); a key reaching
   zero is deleted — absent and zero never differ (§5.3).
6. Pushes the F-06 entry (ruleIds `[citingRuleId, "F-06"]`): cash
   changes from the transfer primitive plus the per-city payables
   change, and a classification carrying the full §2.3 log record —
   fact kind, base, schedule cited (law ids, rate, `asOfSeq` = the
   operating city's `stateVersion`), assessed, collected, payable
   created/increased.

F-07 (`pay_tax_arrears`, transfer class): the owner confirms
`corporationId`, `homeCityId` (record location), `cityId` (the creditor
city — the payable's key and the treasury paid), `amountRubars`.
Validates the record stands, the actor is `ownerMemberId`, a payable
for `cityId` stands, and `amount ≤ payable` (overpayment rejects —
paying more than the bill is not a tax payment). The line company →
treasury(city) moves in full or the action rejects in full; the payable
then reduces, its key is removed at zero, and the entry states payable
before/after and that the §5.3 blocks lift in the same event when the
last payable clears.

## 3. R-06 / R-07 — branch discipline

**R-06 unlisted (verbatim per systems-spec v2).** Home GDP +0.4%
(`gdp += round(gdp × pct/100)`, §2.4 formula; `null` GDP → effect
skipped and the Log notes `skipped: gdp unset`, never an invented
figure). Book value `valuationRubars = round(2% of GDP)`; under null GDP
the book computation skips the same way — `legacyBookRubars: null`,
`valuationRubars: 0` (Module 0's builder posture: the caller supplies
economics; the null-GDP record is representable, as the Module 0
play-core fixtures already assert). Industry synergy: a completed
structure in the home city whose `kind` equals the corporation's
industry, or whose `supports` names it, adds a separate +0.2% GDP line,
stated separately in the Log (flag F6). A named second city (market /
HQ2) with a confirmation reference in the action record takes +0.2% GDP
and joins `marketCityIds`; named without a reference, it takes no
effect and the Log says why (cross-city draft rule; flag F7).

**R-06 listed (bundled M-01 founding).** The book assignment is skipped,
not computed and replaced. `legacyBookRubars` records the unlisted
formula result (or `null` under the GDP skip) as provenance — it is
never an input to any valuation this module computes. Paid-in capital
moves founder-personal → company cash as a transfer line (Phase 4:
personal source only — P4-K21(ii) suspends treasury-sourced paid-in
capital; a treasury source named in the action rejects citing it). The
judgment comes ONLY from the worker-prepared payload bound at preview
(`ctx.prepared.classification.judgment = { quality, scale, importance }`,
integers 0–100; no payload → `judgment-required` rejection — code never
invents the multiplier, and the action itself is never read for it).
`multiplier = 0.5 + (quality + scale + importance) / 200` (§4.4:
0.50 + 1.50 × mean/100); `openingReferenceCapRubars =
round(paidIn × multiplier)` becomes the record's `valuationRubars`
(the §4.2 market-cap cache at the founding event, formula inputs
logged); `openingReferencePriceRubars = max(1, round(cap /
sharesIssued))`. Record deltas (§5): `paidInCapitalRubars`,
`sharesOutstanding`, `openingReferencePriceRubars`, `lastJudgment`.
Share-issuance records (holdings, float) are step 7's — flag F1.

**R-07 unlisted (verbatim).** Expand: valuation ×1.25 (rounded), home
GDP +0.2%, and the home treasury pays the recorded expansion budget,
budget class — the funded-gate mirrors landed R-05 exactly: the paid
portion moves (treasury → Exterior, `households:<homeCity>` scope),
and the valuation/GDP effects fire only when the budget is funded in
full; a shortfall is logged with `shortfallRubars` and the expansion
does not take effect (flag F2). Contract: ×0.8, GDP −0.2%, status →
`contracted`. Relocate: home Contract effects, destination Expand GDP
at half rate (+0.1%), valuation ×1.1 after the move, the record moves
to the destination city's subcollection (old path deleted, new path
created), destination confirmation reference required. Dissolve:
valuation → 0, status → `dissolved`, GDP −0.3%, spirit −1 at home;
each third city named in the action record (`affectedCityIds` — where
the corporation has structures/staff) takes spirit −1. GDP effects
skip-and-log per city under null GDP, as R-06.

**R-07 listed (P4-K18).** No multiplier ever touches valuation; a
ripening writes only coded inputs and declares `invokesRules: ["M-06"]`
— M-06 (step 7) is the listed branch's only valuation writer, invoked
inside the same Resolution Event once it lands. Expand: the budget is
paid INTO `companyCashRubars` from the founder's personal account,
transfer class, the funding source recorded distinctly; named
footprint changes (structure links, market cities) land as records;
home GDP +0.2% as unlisted. Contract: must name input changes (market-
city exit, structure unlink/mothball, and/or a recorded cash
withdrawal) — naming none rejects `contentless-contract`, logged.
Relocate: record move + confirmations + city GDP effects as unlisted,
no ×1.1. The two market-dependent legs resolve fail-closed until
step 7 — flag F3: a listed Contract naming a cash withdrawal rejects
`cash-leg-requires-market-module` (P4-K22 routes the leg through
M-08/M-09; no bare company → owner line is ever composed), and a
listed Dissolve rejects `liquidation-requires-market-module` (M-10's
waterfall pays shareholders of record pro-rata; with no holdings
records in the world the waterfall has no lawful payee set, and a
half-liquidation that strands cash in a dissolved record would break
the seam silently). Both rejections are atomic — the action's other
legs do not half-land.

## 4. Conservation posture

Every money movement in the module is an `applyTransferLines` line, so
the finance conservation checker (settlement-cash bridge, paired
posting, Log/writeSet bijection) evaluates these events unchanged:
F-06/F-07 events balance company −X / treasury +X with no Exterior or
mint legs; listed Expand and listed founding balance personal −X /
company +X (plus F-01's closed-list mint when lazy-open fires);
unlisted Expand balances treasury −pay against the `exterior:`
households leg. Non-cash changes (valuation, GDP, payables) resolve
under the checker's grammar without entering its cash sums; the
payables change uses the per-city dotted spelling
(`corporations/<id>.taxPayables.<cityId>`, numeric before/after) so the
bijection check reconciles it against the writeSet exactly. The Lead
assembly the checker needs is in §5 (the verify.ts gate set keys off
`FINANCE_DESCRIPTORS`; R-06/R-07/F-06/F-07 events enter the per-event
set only when the Lead extends it — the same extension Catalogue I
already requested for F-09/F-10/F-11).

One composition convention the harness forced into the open (it is
the F-01 genesis pattern, generalized): a record CREATED by an event
is born holding its creation-state balances, and the Log change for a
created doc's balance field chains from `null` (validatePlan's chain
for a created doc starts at the snapshot's null), not from the
builder's 0. R-06's listed founding therefore writes the corporation
record with `companyCashRubars` at its builder 0, folds the capital
through the transfer primitive for validation, and states the company
leg on the founding entry as a creation change (`null →
paidInCapitalRubars`). Any future handler funding a just-created
company must do the same; the harness's check 10 proves the composed
event (genesis mint + capital) conservation-clean.

## 5. Lead assembly needs

1. **Registry registration (one edit, the Finance/Catalogue I
   pattern).** In `lib/sim/rules/registry.ts`: import
   `BUSINESS_DESCRIPTORS` and `BUSINESS_FINANCE_ADDITIONS` from
   `./businesses`; add `...BUSINESS_DESCRIPTORS` to the
   `RULE_DESCRIPTORS` assign; fold each additions entry onto its
   descriptor's `finance` field (the existing `foldFinance` pass over
   `Object.entries(BUSINESS_FINANCE_ADDITIONS)`). Descriptor IDs
   R-06/R-07/F-06/F-07 collide with nothing standing (37 → 41).
2. **Corporation-record deltas into Module 0's builder/type.** The
   R-06 handler spreads four fields onto `buildCorporationDoc`'s
   output; fold them into `lib/sim/corporations.ts` (the
   `CorporationRecord` interface + builder defaults) so the type
   carries them for step 7: `paidInCapitalRubars: number` (0 when
   unlisted), `sharesOutstanding: number` (0 when unlisted),
   `openingReferencePriceRubars: number | null`,
   `lastJudgment: { quality, scale, importance, inputHash } | null`.
   No other record shape changes; `taxPayables` is Module 0's map,
   used as designed. Also note for step 7: F-03 events do not maintain
   `paidInCapitalRubars` (the landed F-03 moves cash only) — M-02's
   capital-injection composition should maintain it, or the field
   stays a founding-time figure by declared posture.
3. **Verifier conservation gate-set extension (`lib/sim/verify.ts`).**
   The per-event conservation scope keys off `FINANCE_DESCRIPTORS`
   rule ids (plus `sim_member_accounts/` / `sim_bank_deposits/`
   writes). Extend `financeRuleIds` with the business descriptor ids
   (R-06, R-07, F-06, F-07) — or generalize the set to every descriptor
   carrying finance additions — in the SAME edit that lands Catalogue
   I's already-requested F-09/F-10/F-11 extension. No checker change
   is needed: `checkConservationEvent` evaluates these events as-is
   (the harness proves it — §7), and no new mint/burn rule joins
   §3.3's closed lists. Do NOT wire a holdings supply into
   `checkStandingRecords` yet (flag F1): the share-conservation
   assertion must stay inert until step 7 creates holding records.
4. **F-10 → F-06 invocation wiring (flag F5).** In `laws.ts`'s F-10
   handler, after the payment lines compose, call
   `composeTaxAssessment({ plan, snapshot, actor, citingRuleId:
   "F-10", fact })` with the fact F-10 already records, and surface
   the outcome in F-10's summary/classification. Read-plan side:
   F-10's read plan must declare the laws of the fact's OPERATING city
   — import `businessLawsQuery` from `./businesses` and add it for
   the paying city and for any city a `serviceRef` can name (or rely
   on doc-map materialization where a laws query for that city
   already ran; the composer's contract is in its header comment).
   Until this edit lands, F-10 facts remain recorded-but-unassessed,
   exactly as Catalogue I left them — nothing is silently skipped.
5. **Rules / indexes: none.** This module creates no new collection
   and no new query shape: corporation docs live under the existing
   `sim_cities/{cityId}/corporations/` match block (Module 0), law and
   structure reads reuse Catalogue I's collection shapes, and no
   composite index is introduced. `firestore.rules` and
   `firestore.indexes.json` need no delta from Catalogue II. (The
   `test:sim` script's harness list should gain
   `tests/cat2-harness.ts` — a package.json convenience edit for the
   Lead, not a gate.)
6. **Step-7 (Market) composition requirements this module creates.**
   - M-01/M-02 must create (or backfill) the founder holding record
     for any company listed at founding under R-06, before the
     checker's share assertion is wired with a holdings supply (F1).
   - M-06 repricing is invoked in-event by R-07's listed branch via
     the declared `invokesRules: ["M-06"]` classification (the same
     declared-invocation posture as F-10 → F-06); when the market
     module lands, its handlers — or the resolver's invocation
     mechanism, if the Lead builds one — execute the repricing
     against the coded inputs this module writes. `lastJudgment` on
     the corporation record carries the prior scores M-06's
     carried-scores path reads.
   - M-08/M-09 un-block the listed Contract cash leg: R-07 rejects it
     with `cash-leg-requires-market-module` (citing M-08/M-09) until
     the market handlers exist to route it; M-10 likewise un-blocks
     listed Dissolve (`liquidation-requires-market-module`). No
     R-07 change is needed beyond removing nothing — the rejections
     name the seam, and step 7's assembly decides whether the acts
     re-route through the market descriptors or compose in-event.
   - The earnings-window anchor (`earningsWindowStartSeq`) is a
     market record field for M-06 §4.3 to stamp at listing; this
     module deliberately does not invent it. `taxesPaidRubars` is
     Log-derived by M-06 and needs no record field.

## 6. Flags surfaced, not improvised

- **F1 — Listed founding composes M-01's record effects; issuance
  records are step 7's.** Amended R-06 contemplates founding with M-01
  bundled, and R-06's own text specifies the founding outputs (capital
  movement, opening cap/price, judgment inputs). This module composes
  exactly those and records `sharesOutstanding` on the corporation
  record, but creates NO holding/float records — §5.4's record shape
  belongs to the market module. Consequence the Lead owns: step 7's
  M-01/M-02 must create (or backfill) the founder holding for any
  company listed at founding, and the conservation checker's share
  assertion (Σ holdings + retired == sharesOutstanding) must not be
  wired with a holdings supply before that exists. As verify.ts stands
  (no holdings passed), the assertion is inert and a step-6 listed
  founding trips nothing.
- **F2 — Unlisted Expand's funded-gate and R-07's declared class.**
  Vera's text says the treasury pays the expansion budget "refused/
  shortfall per §2.4" without naming the destination ledger or whether
  the ×1.25 fires on partial funding. This module mirrors landed R-05:
  destination is the Exterior (the budget is spent on the expansion;
  paying it into company cash would double-count against the book step,
  and Module 0's F-03 note holds unlisted valuation is untouched by
  cash alone), the paid portion moves, the step fires only on full
  funding. Because R-07 also carries transfer-class paths (listed
  Expand, Relocate/Dissolve city effects are determinate), its finance
  additions declare `shortfallClass: "budget"` for the one partial
  path; the listed paths enforce transfer discipline in-handler.
  Needs Vera/Lead ratification at assembly.
- **F3 — Listed Contract cash legs and listed Dissolve fail closed
  until step 7** (see §3). P4-K22's routing is honored by refusal —
  no disguised withdrawal can occur — at the cost of those two acts
  being unavailable in the Phase 4 slice until the market module
  lands. If the Lead prefers the non-cash legs of a cash-naming
  Contract to land with only the leg deferred, that is a one-handler
  change; it was NOT taken because severing one leg of a confirmed
  action falsifies the action as confirmed.
- **F4 — Tax rounding.** No spec text settles F-06's rounding. The
  module uses `Math.round(base × bps / 10000)`, the engine's universal
  rounding (GDP percentages, valuations, phase costs), over `floor`.
  One-line change if Dana/Vera rule otherwise.
- **F5 — The F-10 → F-06 wiring gap is real and Lead-owned.**
  Catalogue I's F-10 records the `contract-payment` taxable fact and
  declares `invokesRules: ["F-06"]`, but no engine mechanism executes
  declared invocations, and this module may not edit `laws.ts`.
  F-06 therefore lands as (a) the descriptor, (b) the exported
  composer any handler can compose in-event, and (c) in-module
  invocation for facts this module's own rules create — of which
  R-06/R-07 create none (capital movements are excluded facts by
  design). F-10 events will assess only when the Lead either composes
  the F-06 call into the F-10 handler or lands a resolver-level
  invocation mechanism. Until then the fact is recorded in full and
  no tax is silently skipped — it is unassessed, in the open, exactly
  as Catalogue I left it. F-11 needs no wiring (it assesses inline).
- **F6 — Industry synergy matching.** Vera's text gives one example
  (factory ↔ industrial corp). The module matches deterministically:
  a completed home-city structure whose `kind` equals the industry
  string, or whose profile `supports` names it. Free-text industries
  outside the structure-kind vocabulary take no synergy. Widening the
  match table is a spec act, not a handler act.
- **F7 — Cross-city confirmations are action-record references.**
  No cross-city draft machinery exists in the landed engine. R-06's
  second-city naming and R-07's Relocate carry a confirmation
  reference string in the action record, recorded verbatim in the
  Log; the reference's provenance is an intake/fabric concern. This
  module is the first consumer; step 7/9 may formalize the shape.
- **F8 — Status transitions on R-07 verbs.** Module 0's status enum
  (`active | contracted | relocated | dissolved`) implies verb-driven
  statuses; the module sets Contract → `contracted`, Expand →
  `active`, Relocate → `relocated`, Dissolve → `dissolved`. If Dana
  intended `relocated` as a transient marker only, the change is
  confined to one mapping in `businesses.ts`.
- **F9 — Unlisted Expand's treasury payer requires governance.**
  Vera's text says "treasury pays" without naming whose authority
  spends it; CJ's cross-city ownership ruling means the corporation's
  owner need not govern its home city, and letting any owner spend
  any home city's treasury would be an open exploit. The module
  therefore gates the unlisted Expand on `checkCityAuthority` over
  the home city (`not-city-governor`): the governor-founder path is
  Vera's; a foreign-owned unlisted corporation's expansion budget has
  no lawful payer in v1 (its listed path is founder-funded). Founding
  itself is NOT gated — a founding spends nothing of the city's and
  its GDP effects benefit the host. Needs Theo/Vera ratification; if
  the intended payer is instead the founder's own-city treasury or
  the founder personally, the change is confined to the Expand
  branch's funding block.

## 7. What landed / harness evidence

**Landed** (branch `p4/catalogue-business`, commits in order):
`lib/sim/rules/businesses.ts` (R-06, R-07, F-06 descriptor + exported
`composeTaxAssessment` + exported `businessLawsQuery`, F-07;
`BUSINESS_DESCRIPTORS` + `BUSINESS_FINANCE_ADDITIONS` for Lead
assembly), `tests/cat2-harness.ts`, the README delta (status
narrative, Scripts row, 2026-10-20 Changelog line), and this report.
No other file is touched.

**Harness** — `npx tsx tests/cat2-harness.ts`: **34/34 checks pass.**
Every resolved plan runs through the real `validatePlan` (including
F-02 changes↔writes reconciliation) AND the real finance conservation
checker over the event's entries + writeSet. Coverage: R-06 unlisted
(GDP order-of-rows, book from the post-+0.4% figure, synergy stated
separately, damaged-structure non-match, null-GDP skip with
`legacyBookRubars: null`); confirmed vs unconfirmed second-city
naming; duplicate founding; R-06 listed (legacyBook as provenance,
cap-first opening price 140,000 on 100,000 paid-in at scores
80/60/40, cash actually moved, `judgment-required` with no payload —
including when the action itself names scores — and the P4-K21(ii)
treasury-source rejection; a fresh founder's genesis + capital event
conservation-clean); R-07 unlisted (×1.25 funded, the funded-gate
shortfall resolving without the step, the corpCrossB
`not-city-governor` treasury gate, ×0.8 Contract, Relocate's record
move with ×1.1 and half-rate destination GDP, unconfirmed-relocate
rejection, Dissolve with third-city spirit); R-07 listed (Expand
paying into company cash with valuation provably untouched and
`invokesRules: ["M-06"]` declared, contentless Contract rejection,
input-change Contract, the P4-K22 cash-leg rejection leaving every
other leg un-landed, M-10 dissolution rejection, listed Relocate
with no ×1.1); F-06 driven as a citing rule composes it (cross-city
operating-credit with partial collection + payable, payable
accumulation at an empty till, schedule-unset skip, honest 0-rate
assessment, the contract-payment and payroll components, and the
unreadable-schedule refusal); F-07 (partial → full payment with key
removal and the blocks-lifted statement, overpay / no-payable /
non-owner / short-cash rejections with the payable standing, the
corpCrossB three-facts separation), and the end-to-end
assessment → payable → arrears story.

**Other local evidence** (2026-10-20, this clone): `tsc --noEmit`
exit 0 repo-wide; ESLint clean (0 errors, 0 warnings) on both new
files; `next build` succeeded; `tests/cat1-harness.ts` re-run green
(no cross-family regression). The Firestore emulator cannot run in
this sandbox; emulator-venue suites (`test:sim`, `test:rules`) are
CI's to run, as with prior modules. The harness caught and fixed
three real defects before landing (the listed-founding creation
chain, the dotted `taxPayables` changed-field registration, and the
literal-null chain spelling for absent payable keys) — §4 records
the convention so the next family does not rediscover it.

---

## 8. Assembly record (Lead — Rafe, 2026-10-20)

Assembled as branch **`p4/cat2-assembled`** in `phase4-clone`, forked
from the Chains assembly tip (`p4/chains-assembled` @ `90ebdb8` — the
post-Chains local base; Theo pushes Chains first and verifies trees
before pushing this). **13 commits**: Felix's 7 cherry-picked with
authorship preserved (module payload byte-identical to
`p4-cat2-clone` @ `0c8d538`; the README conflict composed
payload-delta style — his three additions placed after the Chains
entries), then 6 Lead commits, one per §5 item.

- **Item 1 — registry.** `BUSINESS_REGISTERED` folds
  `BUSINESS_FINANCE_ADDITIONS` onto each descriptor (the
  FINANCE_REGISTERED pattern) and spreads into `RULE_DESCRIPTORS`.
  **Descriptor count: 44** — Felix's "37 → 41" was counted on his
  pre-Defensive/pre-Chains base; on the post-Chains registry (40)
  the family adds exactly its four (R-06, R-07, F-06, F-07). Probe:
  `found_corporation` → R-06; the four corporation verbs → R-07;
  `pay_tax_arrears` → F-07; **F-06 present with no action kinds and
  no handlers** (a resolver step, as designed), finance additions
  folded (`shortfallClass: "none"`, company/treasury ledgers).
- **Item 2 — corporation deltas folded.** `CorporationRecord` +
  `buildCorporationDoc` now carry `paidInCapitalRubars` (0),
  `sharesOutstanding` (0), `openingReferencePriceRubars` (null),
  `lastJudgment` (null, typed `{ quality, scale, importance,
  inputHash }`) as layer 4 of the shape provenance. Play-core's
  Module 0 section extended with pins for the four defaults; its
  standing assertions unchanged (field-wise, none broke). R-06's
  founding spread is untouched — it supplies the real values over
  the builder defaults. The §5 step-7 note stands: F-03 does not
  maintain `paidInCapitalRubars`.
- **Item 3 — verifier gate set.** `financeRuleIds` in
  `lib/sim/verify.ts` now includes R-06/R-07/F-06/F-07 **and**
  F-09/F-10/F-11 (Catalogue I's pending ask, same edit). Checker
  unchanged; **no holdings supply wired** — the share-conservation
  assertion stays inert until step 7 creates holding records (F1).
- **Item 4 — F-10 → F-06 wiring (F5 CLOSED).** In `laws.ts`: the
  F-10 handler composes `composeTaxAssessment` in-event after the
  payment lines and the recorded fact (fact shape mapped to the
  composer's `TaxableFact`: `homeCityId` = the corporation record's
  city), and the outcome (status / assessed / collected / payable
  delta / rate) surfaces on the event's summary entry classification
  + text. The F-10 read plan declares the operating city's laws via
  `businessLawsQuery` (the named service city, else the payer). The
  laws↔businesses import is function-level both ways (businesses
  already imports `deriveTaxScheduleFromLaws` from laws) — the
  tolerated pattern; nothing executes at module-eval time. F-10
  facts no longer stand recorded-but-unassessed.
- **Item 5 — rules/indexes: none**, as specced.
- **Item 6 — CI:** `test:sim` chains `tests/cat2-harness.ts` after
  the chains harness, existing non-required Sim core job; required
  check untouched.

**Flags:** F1–F9 ship **as built** (Theo's posture), including F9's
`checkCityAuthority` gate on unlisted Expand — a genuine cross-city
exploit closure, named in the PR body. F3's listed cash leg /
dissolve stay fail-closed until step 7; the M-08/M-09/M-10
obligations are named in the PR body.

**Verification (assembled tree):** `tsc --noEmit` clean · scoped
ESLint clean (0 problems) · `next build` green · **cat2 harness
34/34 post-registration** (every plan through the real
`validatePlan` + the real conservation checker, now also
gate-extended) · **cat1 harness all scenarios green** with the
F-10 wiring live · registry probe above. Play-core's Module 0
section carries the new pins (emulator venue = CI, as throughout).
**No defects found inside Felix's fence.**

## 9. PR draft — Phase 4 Catalogue II (step 6)

**Title:** Phase 4 Catalogue II (step 6): businesses & tax (R-06/R-07/F-06/F-07) — registry + corp-record fold, conservation gate extension, F-10 → F-06 wiring (F5 closed)

**Body:**

### Summary
Felix's step-6 module + Lead assembly. `lib/sim/rules/businesses.ts`
carries corporation founding and actions in both branches, the
F-06 business-tax assessment composer, and F-07 arrears payment.
With this PR, every Catalogue I taxable fact has a live assessment
path: the F-10 → F-06 invocation Catalogue I declared is wired.

### What lands
- **R-06 `found_corporation`:** unlisted book verbatim (home GDP
  +0.4%, industry synergy +0.2% where a completed structure matches,
  null-GDP skip-and-log; `legacyBookRubars` provenance only, provably
  absent from valuation inputs). Listed-at-founding: paid-in capital
  moves founder → company cash, and the opening reference price
  derives from paid-in capital × the prepared-payload judgment,
  cap-first rounding (P4-K18: no multiplier ever touches valuation).
- **R-07 corporation verbs** (Expand / Contract / Relocate /
  Dissolve): unlisted multipliers verbatim — Expand's budget is
  treasury-paid under the funded gate, **gated on
  `checkCityAuthority` over the home city (flag F9): a foreign
  owner cannot spend a treasury they do not govern** — a real
  cross-city exploit closure. Listed: coded inputs only; a
  contentless Contract rejects; M-06 repricing invoked in-event.
  Ownership is carried as three separate facts (owner member, home
  city, operating city) and read correctly (P4-G6).
- **F-06** lands as a descriptor with **no action kinds** — a
  resolver step: `composeTaxAssessment` computes tax from the
  operating city's law-derived schedule over the closed fact list,
  collects the collectible portion company → host treasury (never
  beyond a bank's unencumbered surface), and records any remainder
  as a `taxPayables` entry. **F-07 `pay_tax_arrears`** pays a
  payable down; keys are removed at zero.
- **Harness:** `tests/cat2-harness.ts`, 34 checks — every resolved
  plan through the real `validatePlan` and every money event
  against the real finance conservation checker.

### Assembly (Lead)
- Registry: family registered, finance additions folded —
  **44 descriptors**.
- Module 0's corporation builder/type now carries the four
  market-founding fields with unlisted defaults (play-core pins
  extended; standing assertions unchanged).
- Verifier conservation gate set extended: R-06/R-07/F-06/F-07 plus
  Catalogue I's F-09/F-10/F-11. No holdings supply wired.
- **F-10 → F-06 wiring in `laws.ts` (flag F5 closed):** the F-10
  handler composes the assessment in-event over its recorded
  contract-payment fact; its read plan declares the operating
  city's laws query; the outcome rides the event's summary entry.

### Flags (ship as built — Theo's posture)
F1–F9 per the prep report §6, including F9's treasury-authority
gate (above) and F4's `Math.round` tax rounding (the engine's
universal convention). **F3 stays fail-closed:** a listed
Contract's cash leg rejects with `cash-leg-requires-market-module`
and a listed Dissolve with `liquidation-requires-market-module` —
**step 7 obligations, named here: M-08/M-09 must un-block the
listed Contract cash leg (P4-K22 routing), M-10 the listed
Dissolve, and M-01/M-02 must create or backfill the founder
holding record for any company listed at founding before the
checker's share assertion may be wired with a holdings supply
(F1).**

### Verification
Assembly tree: tsc clean; scoped ESLint clean; `next build`
green; cat2 harness 34/34 post-registration; cat1 harness all
scenarios green with the wiring live; registry probe (44
descriptors; F-06 kindless). Emulator suites are CI's venue.
README updated (module delta composed payload-delta + Lead
assembly sentence) per the README-with-every-PR rule. Full
record: `workstreams/p4-cat2-prep-report.md` §8. No production
deploy or data access.
