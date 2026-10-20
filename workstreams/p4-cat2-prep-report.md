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
4. `collected = min(assessed, companyCash)` composed as ONE transfer
   line company → treasury(operating city), transfer class (sufficient
   by construction; company cash never goes below zero).
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

## 5. Lead assembly needs

*(Completed at the end of the build — registration, additions merge,
record deltas, rules/index needs, verifier gate-set extension, the
F-10 wiring requirement, and step-7 composition requirements.)*

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

## 7. What landed / harness evidence

*(Completed at the end of the build.)*
