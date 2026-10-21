# Phase 5 PR-6 Prep Report — The Banking Slice (Felix, Muse Eng)

**Branch:** `p5/banking` in `p5-banking-clone`, from `phase5/situations-assembled`
tip `d36088d` (PR #40's stack; master has since merged it at `c00f1a5` — Rafe
assembles and reconciles base drift). **Tip at this report:** `7e08e72`.
**Authorship:** Felix (Muse Eng) <felix@cowboy-city.local>, 17 commits.
**Contract:** `workstreams/p5-banking-addendum.md` (items 0–15) +
`banking-amendment-design.md` (conformed) + `systems-spec-v2-acceptance.md`
(REC-1–REC-8) + `banking-v2-systems-review.md` (V-B0–V-B7).
**Discipline held:** family files + harness only. No edits to `registry.ts`,
`firestore.rules`, `firestore.indexes.json`, the resolver, or the dispatcher.
**Not pushed. No production anything.**

**A-2 statement (for the PR body):** Phase 5 PR-6 is **built, not live**. The
production chain (P2-K15) remains unexecuted and unowned at this build: (1) a
production fabric service user provisioned with the `fabric` claim and both
`fabricRole` values (`committer` and `worker`); (2) production rules deploy of
the full post-Phase-5 rules file; (3) production indexes deploy; (4) production
genesis executed; (5) an operated production wake path. Nothing in this branch
touches production.

---

## 1. Build record, per addendum item

**Item 0 — the addendum.** Discharged before this build (producer inventory
§1, tier table §2, A-B2 activation §3). No code.

**Item 1 — B-04 credited branch.** Built (commit `5296da9`). The
`credited-branch-phase-5` rejection is retired: `settlementMode: "credited"`
capitalizes the §4.1 figure (`creditedInterestRubars += amount`, liability
aggregate += amount, watermark advances) with **zero cash lines**; the claim
bridge classifies the growth `interest-capitalized` in the settlement entry's
classification (asserted in harness check 4 — it fires as classified, not as
`CLAIM_UNEXPLAINED`). The cash-paid branch is regression-proven unchanged
(check 5). Both branches reject `bank-failed` against a derived-failed bank
(asserted in W9, both modes). Zero-due settlements advance the watermark only.

**Item 2 — REC-6 full identity + failed-payment derivation.** Built (commit
`f08bdb3`). `bankBalanceSheet(corpDoc, extras?)` is the one implementation:
Assets = cash + loanBook + seizedAssets (at recorded satisfaction value) +
recognizedInsuranceReceivables (extras input, default 0 — post-recognition
only); Liabilities = depositLiabilities + taxPayables (record map) +
adjudicatedPayablesRubars + other recognized liabilities (extras, default 0).
Solvent ⇔ netWorth ≥ 0 ∧ cash ≥ liquidReserve for the failure state;
`deriveBankHealth` composes the three-state health over it with **no code
change at the Phase 4 call sites**. `deriveFailedPayment` is the pure
Log-slice derivation (uncured B-03/B-04 `insufficient-unencumbered` rejection
⇒ failed; a B-09 entry stamping `curesFailedPayment: true` clears every
rejection standing before it). Harness: W6 check 42 proves the identity is
per-term real (an adjudicated term tips a slice-solvent bank insolvent;
receivables default to zero — M3's positive form); W9 checks 34–35 prove the
failed-payment derivation end-to-end. See flag **F1** for the stamp's limit.

**Item 3 — Loan-record activation (data step).** Felix names, Rafe lands —
**not built here** (it is `firestore.rules` / `firestore.indexes.json` work).
The record shape is live in code (`lib/finance/loans.ts`, §3.1 as conformed:
`fundingSource`, `proceedsDepositId`, `origin`/`fundingLoanId` on deposits,
`setoffAppliedRubars`, `nettedPrincipalRubars`, `residualInterestRubars`,
liquidation block on deposits). Assembly items **A2/A11** carry the rules +
indexes + posture matrix.

**Item 4 — B-05 `offer_loan` (+ cancel).** Built (commit `e2b5a99`). Tier B.
The record is created `offered`; no money moves; the branch is stated at offer
(`fundingSource`, absent ≡ `"cash"`) and may not switch afterward — W4 check
25 proves the record-governs half (a cash-record offer over lendable rejects
`insufficient-lendable-cash` at funding; no created deposit appears). Insider
is derived and stored at offer. Structure pledges validate the borrower
company's `linkedStructureIds` at offer and again at funding. The B1 proposal
card mints via Vera's proposal producer (Pattern E); cancel supersedes it.
Resting offers never expire (W4's offers rest across thousands of seqs).

**Item 5 — B-06 `accept_loan`, both branches.** Built (commits `e2b5a99`,
`359c8f9`). Cash branch: disbursement validates against lendable (cash −
liquid reserve) on the claimed snapshot via the transfer primitive's
`surface: "reserve"` leg; exactly-lendable funds (W3 check 18, W2 check 11),
lendable + 1 rejects in full and the offer rests (W4 check 25). Credit
branch: the Appendix A pair — loan activation + created deposit through the
**shared deposit-record builder** in one event, `origin: "credit-created"` +
`fundingLoanId` stamped, ΔCash = 0, ΔAssets = ΔLiabilities = P (W3 check 17);
creation tests read the **post-funding** sheet over total liabilities /
total recognized assets (REC-1): `creation-reserve-shortfall` and
`creation-capital-floor` reject independently at their boundaries, and the
equity floor's exact boundary funds (W6 check 41). Insider cap
(`INSIDER_CAP_BPS` = 2,500 of post-funding net worth, BNK-D3): at-cap funds,
+1 R rejects `insider-cap-exceeded` (W4 check 26) — see the composition-order
fix in §4. Pledge commits: shares validate free = quantity − committed −
pledged (`insufficient-free-shares`, W4 check 28); structures take the lien
marker at funding. Schedule pendings: exactly `installmentCount`, at
`originatedAtSeq + k × dueIntervalSeqs` (W2 check 11). **A-8:** an NPC
attempt at B-06 with a fully standing mandate is refused by the handler's
Tier B gate (`npc-tier-b-refused`), zero writes, offer untouched (W4 check
32 — F-E11 closes here).

**Item 6 — B-07 `repay_loan`.** Built (commit `52de9fb`). Tier A,
borrower-initiated only; nothing auto-debits. Fixed allocation (unsettled
interest → prepayment fee at payoff → principal, oldest installment first);
amount > payoff rejects `repayment-exceeds-payoff`; an uncoverable amount
rejects in full; the fee-gap band [payoff, payoff+fee) rejects
`repayment-fee-figure` with both figures named. Full payoff closes the loan
(`repaid`), releases pledge/lien in-event, and the closing entry states
lifetime interest paid. **Netting** (V2-§2.3): principal portion only,
against the loan's own created deposit — deposit principal and loan
outstanding fall together, no cash lines for the netted portion, interest
always cash (W3 check 19); netting elected on a cash-funded or pool-assigned
loan rejects `netting-not-available` (W4 check 27). **Pool form:** interest
portion first across the pool's claims, then principal pro-rata by unpaid
claim, integer floors, **dust to the dissolved bank's frozen cash record**
(§5.6 — implemented in this build's final pass; W2 check 14 and W3 check 21
assert distributed + dust == repayment, borrower debited in full).
Subrogation is a derivation: distributions route to the fund until
Σ receipts == its B-13 payout on that claim, then to the depositor (W2
check 14). Pool closing is evaluated on planned views (see flag **F4**).

**Item 7 — B-08 `seize_collateral`.** Built (commit `52de9fb`). Tier B. The
default gate **re-derives on the claimed snapshot**: a loan previewed in
default but cured before commit does not seize (W4 check 30). Satisfaction
at recorded basis — shares at the listing's `officialPriceRubars` (no price
⇒ `collateral-unvalued`, the lien rests), structures at cumulative
`paidRubars`. **The excess return is a plan validation**: the return line is
constructed unconditionally and a seizure whose return cannot be covered
rejects `excess-return-uncoverable` — the standing Log carries the return
line on every excess seizure (W4 check 29: value 10,000 vs debt 8,000 →
2,000 R returned in-event; structure form check 31: 30,000 vs 20,000 →
10,000 R returned, lien consumed, link moves to the bank, seized-assets
aggregate exact). Unsecured loans reject `no-collateral` (W2 check 12).
Pool form: any pool claimant seizes for the pool; shares distribute integer
pro-rata with remainder shares to the largest unpaid claim; a structure goes
to the largest claimant as custodian with its value credited against their
claim (§5.6). Seized value feeds REC-6's seizedAssets term (A-B7 asserts the
aggregate against the records). Share seizures land in the bank owner's
holding flagged `heldForBank` — the **BNK-D4 fallback, taken** (flag **F9**).

**Item 8 — B-09 `recapitalize_bank`.** Built (commit `588c064`). Tier B.
Any member may inject from a ledger they control (never Market/Exterior/
fund); the cure determination recomputes in-event on the planned sheet:
cured ⇔ netWorth ≥ 0 ∧ cash ≥ liquidReserve, **boundary inclusive** — 1 R
short does not cure, the exact figure does (W9 check 35). A non-curing
injection is lawful and its entry states it did not cure. The summary
classification stamps `recapitalization.curesFailedPayment` for the
failed-payment derivation; a standing K2 episode card terminals on a cure
and updates on a non-cure (see flags **F1/F3** for the seam). Against a sound
bank it is an ordinary capital injection.

**Item 9 — B-10 `liquidate_bank`.** Built (commit `a3ec1fa`). Tier B.
Triggers: owner-voluntary (no failure precondition — a sound bank's owner
dissolution runs the waterfall and pays claims in full, W6 check 43) and
depositor-triggered (active claim + derived failure required; a sound bank
rejects `bank-not-failed`, W6 check 43; see flag **F2**). In-event: charter
surrenders **before** payout validation (payouts validate against the
estate's gross cash), claims freeze at the event's first entry seq on the
REC-5 basis (principal + credited + computable unsettled interest — one
basis for tier (c), coverage, and setoff), setoff applies in-event
(BNK-D16: `netClaim = max(0, claim − outstandingOwedToPool)`, the loan's
outstanding reduced in the same event as its assignment), waterfall
(a) taxes → (b) adjudicated → (c) depositors pro-rata on **full** claims →
**B-13 top-up** → (d) shareholders; shares retire; the company dissolves.
The B-13 step is derivation-gated on the fund record's existence (no fund ⇒
split computed, top-up zero, entry states no fund in existence). Assignment
is in-event (`status: "assigned"`, `assignee: "depositor-pool:{id}"`, terms
untouched). RIDER-7 propagation lines carry the full field set with
idempotence key `claimId:liquidationId:recognitionSeq`; **no liquidation
executes recursively in this pass** — the second failure's B-10 settles the
first failure's queued shortfalls as its own event (W3 check 20). Cards:
D1 per depositor, B6/B7 per borrower, K5 on the depositor-trigger branch,
K2 terminal — each card re-keyed per recipient so a multi-card event does
not collapse onto one dedupe key (§4).

**Item 10 — B-11 `write_off_loan`.** Built (commit `588c064`). Tier B. The
loss posts through the named **equity bridge** (credit loss, REC-2): no cash
moves, no liability moves, the record is retained whole (`written-off`); a
created loan's created deposit stands in full, and when the write-down
carries net worth below zero the bank derives failed from the write-down
alone (W2 check 13, W9). In a derived failure it rejects
`write-off-in-failure` (W9); on a pool-assigned loan it rejects
`loan-not-active` — the pool's book is not the old owner's (W3 check 23,
M9). The borrower's B5 card mints.

**Item 11 — DIF founding (adoption act, BNK-D18).** Built as the exported
composition `buildDifFoundingPlan` (commit `3e8b48b`) for the Lead to wire
to the act's venue (assembly **A7**). Singleton: a second founding rejects
`fund-exists`. **Grandfathering election: none** — deposits opened before
founding derive uninsured for life (W1 check 7, M12). The fund record stands
at `sim_deposit_insurance_fund/main` as the **fifth tracked account class**
(commit `ca324ec`: institution LedgerRef; the transfer primitive guards the
fund's closed inflow set and B-13-only outflow — M10/M11). Founding seeds
premium chains for banks already chartered; banks chartered afterward are
seeded in the B-01 event. **G5 proof:** the founding writes only the fund
record (+ any situation claims) — the posture flip is asserted through the
one derivation `insurancePostureFromFund` with no copy writes anywhere
(W1 check 6).

**Item 12 — B-12 premium machinery + chain.** Built (commits `5296da9`,
`3e8b48b`). **SPEC-1 as Vera confirmed it:** the chain perpetuates **at
ripening** — the ripening composition (`buildScheduleRipeningPlan`, family-
exported for the Lead's dispatch branch, assembly **A1**) computes the due
from Log inputs alone (BNK-D11: `ceil(insuredLiabilities × 10 ×
riskMultiplier × periodKseqs / 10,000)` over covered-class, non-insider,
claim-basis liabilities — created deposits in the base), writes the marker,
and schedules the successor schedule-anchored (`requiredSeq = parent
requiredSeq + PREMIUM_PERIOD_SEQS`), generation-1 fresh chain (W1 check 8,
W2 check 10). A zero-due period lands its marker only — no card, chain
unbroken. K3 accumulates by supersession (never two open cards per bank).
**The ladder is a derivation** over markers/settlements: delinquent at one
unsettled period, suspended at two — B-02 rejects
`premium-delinquent-suspended` while suspended, and deposits opened during
a suspension interval derive uninsured for life (coverage reads
`openedAtSeq` against derived intervals; no stored flag). Paying arrears in
full (B-12, Tier A, against unencumbered cash — never auto-debited) cures
by derivation. The full walk is harness-proven (W6 check 40).

**Item 13 — B-13 activation + B-14 assessments.** Built (commits `a3ec1fa`,
`3e8b48b`). B-13 is **not a verb**: it executes inside B-10 as the committer
step after tier (c) — `fundPays = covered − estatePaidOnCovered` per covered
depositor (cap 250,000 R per depositor per bank; insider deposits
excluded), insufficiency pro-rata at the event with paid + queued ==
due stated per claim (REC-7 three-state, W2 check 13). Queued shortfalls
are **senior to later failures' top-ups** — failure 2's B-10 settles failure
1's queue before its own top-ups, proven with exact figures (W3 check 20).
The fund pays **only** inside B-10 (the transfer primitive's fund-line
guards reject any other outflow — M11). **B-14:** where the fund derives
deficient after a liquidation (target ratio 500 bps of insured liabilities,
one-period grace), supplemental obligations arise against surviving banks
pro-rata by insured liabilities — arising **at each survivor's next premium
ripening**, the venue where its own numerator and the fund aggregate are
both exactly readable (W2/W3 evidence: X check 50 finds bankG's B-14
obligation + `asm_bankG_*` pending after failure 1 drained the fund).
B-14 payments ride the B-12 machinery (Tier A, cited B-14, same ladder).

**Item 14 — Controller bar (BNK-D15).** Built (commit `5296da9`): a B-01
validation addition, deriving from liquidation entries naming the
controller (default: the failed bank's `ownerMemberId` only). The bar holds
until **both** 2,000 resolved seqs have passed since the liquidation **and**
every records-named personal obligation of the controller at the failed
bank stands settled; rejection code `controller-barred`. W3 check 22:
barred on both failing conditions; a non-controller with debts at the
failed bank charters freely (the bar names controllers only); the bar lifts
on seqs alone for a controller with no personal obligations.

**Item 15 — §7.5 export datasets.** **Built** (commit `2fe1a2e`) — the scope
read clean against the landed export discipline. Pure layer only:
`lib/export/datasets/bankingData.ts` (row/bundle shapes + scope assertions)
and `bankingWorkbook.ts` (four builders: bank-book deposits — owner view /
depositor own-rows view; bank-book loans — owner view / borrower own-rows
view; bank verified sheet — public; failure statement — public). The pure
layer **re-asserts §7.5 scope fail-closed** (`ExportError`): a non-owner
asking for the owner's book throws; a depositor view containing another
member's row throws; the lawful view builds (X check 51). The verified sheet
labels `tracked_cash_rubars` and `created_supply_rubars` separately (G4).
Runners/routes are assembly (**A8**).

---

## 2. Harness results — `tests/banking-harness.ts`, 51 checks, all green

Resolver-driven (real `resolveAction` in commit mode, `validatePlan` + F-02
reconciliation on every plan) with a mini-commit that materializes writes,
Log entries, and committer pending stamps into fixture worlds, so the
standing Log is a real input to later resolutions. Every committed banking
event in every world is additionally checked through
`lib/finance/conservation.ts` (`checkConservation`: per-event paired posting
+ standing A-B assertions) at each world's close. Run:
`npx tsx tests/banking-harness.ts`. Typecheck clean; the full sibling
harness suite (cat1, cat2, defense, chains, acq, market, lore, situations)
stays green on this tip; governance/closeout pass with only the two
mechanical census updates listed at **A4**.

| Section | Checks | What it proves |
|---|---|---|
| W1 | 1–9 | Descriptors (B-13 absent); charter; B-02 pair; **B-04 credited §4.1 exact figure 20,030 R at Δseq 2,003, zero cash movement**; cash-branch regression; DIF founding (singleton, G5 posture flip, M12); premium ripening recomputation + SPEC-1 successor; conservation |
| W2 | 10–15 | **Failure fixture v1 (cash-funded)**: premium paid; loans fund, pendings at exact due seqs; default derives at the crossing ripening (B2 + K1 cards); unsecured seizure refuses; write-off → derived failure → **B-10 waterfall + B-13 + assignment recomputed figure-for-figure**; pool recovery with subrogation routing; conservation |
| W3 | 16–24 | **Failure fixture v2 (credit-created)**: creation pair (ΔCash 0); exactly-lendable cash funding; netting; write-down → failure → **B-10 pays the senior queue before its own top-ups**; **setoff** in-event; pool recovery (distributed + dust == repayment); controller bar; M9; conservation |
| W4 | 25–33 | Verb batteries: lendable + 1 / record-governs; insider cap at/over; netting scope; pledge shortfall; **B-08 excess-return line in the standing Log**; cured-before-commit; structure seizure; **A-8 NPC Tier B refusal, zero writes**; conservation |
| W9 | 34–36 | **Failed-payment derivation** from the standing Log (two uncured B-03 rejections; arithmetic form still reads sound); B-04/B-11 failure gates; **B-09 exact-boundary cure** (1 R short fails, exact figure cures, derivation clears) |
| W5 | 37–39 | Charter surrender at zero claims; surrender barred with live claims |
| W6 | 40–44 | **Premium ladder walk** (delinquent → suspended → B-02 rejection → cure); **creation tests at their boundaries**; REC-6 per-term identity; B-10 trigger branches (sound-bank depositor trigger rejects; owner dissolution pays in full) |
| X | 45–51 | §4.1 loan-interest recomputation from the Log; **tamper negatives A-B2 / A-B4 / CLAIM_UNEXPLAINED**; frozen world over 10,000 seqs; B-14 obligation evidence; export scope + G4 labels |

**Gate-evidence roll-up (addendum §4) mapping:** (1) §4.1 recomputation
extended — deposit interest (W1), loan interest (X-45), premiums (W1/W2),
all from Log inputs alone ✓. (2) Failure fixture end-to-end, both forms,
every transition asserted from the standing Log ✓ (W2/W3). (3)
Default-derivation — derives at the crossing, cure un-happens it ✓ (W2-12,
W4-30). (4) Seizure excess-return line present; a plan without it does not
validate (the handler constructs it unconditionally and refuses
`excess-return-uncoverable` when it cannot land) ✓ (W4-29/31). (5) Pool
integer/dust rules — floors asserted per claim, dust to the frozen record
and named in the D2 closing card ✓ (W2-14, W3-21). (6) Write-off-in-failure
rejection + equity-bridge posting ✓ (W9, W2-13). (7) A-8 NPC case ✓ (W4-32).
(8) Frozen-world assertion over bank fixtures ✓ (X-49). (9) Conservation
negatives re-proven on the live book, with the untampered book proven clean
first (falsifiability, not vacuity) ✓ (X-46/47/48); the created book's ΔM
classifies lawful throughout W3 (G1's positive proof) ✓.

**Honestly unasserted sub-cases** (built, not harness-proven — candidates
for PR-7's suite): B-05's rate-ceiling/hard-cap rejection codes at offer;
B-05 cancel supersession of the B1 card; pool-claimant B-08 seizure
routing; B-10 propagation-line idempotence under a re-driven duplicate
event; an interbank-deposit contagion fixture (M13's channel); item 14's
two mixed bar sub-cases in isolation (obligations settled but seqs short;
seqs passed but obligations standing — the conjunction and the lift are
proven); a deposit opened *during* suspension deriving uninsured (the
ladder + interval derivation are proven; the coverage read against a
suspension-interval opening is not separately fixtured).

## 3. Guardrail discharges (addendum §5.1)

- **G1 — No no-creation invariant exists.** No assertion, validation, or
  test anywhere in the slice bounds deposit liabilities by cash + loan
  book or requires deposits to originate in B-02. Positive proof: the
  credit-created book (W3) passes the standing assertions and its ΔM
  classifies `credit-created` lawfully; the REC-6 derivation goes negative
  freely (W2/W9 failures derive, nothing asserts against it).
- **G2 — One deposit-record builder; creation is a plan effect.** B-06's
  credit branch writes through the same builder as B-02
  (`buildBankDepositDoc` gained `origin`/`fundingLoanId` additively); no
  B-02-handler call exists inside a loan event. A record with `origin`
  absent reads as `"cash"` (canonical-absent), so no Phase 4 record
  migrates.
- **G3 — No undifferentiated tier-(c) helper.** B-10 computes the
  covered/uninsured split inside its own plan; no shared distribution
  helper takes claims without the split (the one pro-rata helper,
  `distributeProRata`, is branch-agnostic arithmetic over caller-supplied
  shares — the split is computed by B-10 itself, and W2 asserts the split
  figures per depositor, which an undifferentiated helper cannot produce).
- **G4 — Tracked vs created, labeled, never conflated.** The verified
  sheet and exports name `tracked_cash_rubars` and `created_supply_rubars`
  separately (X-51 asserts both labels present and no unqualified
  "money supply" string in the rendered workbook). `claimSupply` is
  neither stored nor displayed.
- **G5 — Posture copy is derived, never hardcoded.** DIF founding contains
  no copy change; the posture flips through `insurancePostureFromFund`
  alone (W1-6 asserts the flip and that founding writes only the fund
  record + situation claims). The purged flat lines ("no deposit
  insurance", "banks cannot create credit") appear nowhere as system
  truths in the slice's copy.

## 4. Must-not-build discharges (addendum §5.2)

- **M1 — Unpaired issuance:** A-B4 fires in both halves (per-event
  plan-shape; standing orphan check) — tamper-proven (X-47); every lawful
  creation in W3/W6 is the Appendix A pair.
- **M2 — Unchartered guarantee:** guarantee state exists only in the DIF
  record + B-12/B-13/B-14 mechanics; no other rule writes coverage,
  payout, or guarantee fields (code review over the family diff).
- **M3 — Guarantee as cash:** REC-6's receivables term defaults to 0 and
  moves only via an explicit post-recognition input (W6-42); lendable,
  reserve, and equity-floor figures never read contingent coverage.
- **M4 — Creation outside the published tests:** both rejection codes
  exercised at their boundaries (W6-41); no B-02-credit path exists —
  B-02's input grammar has no `origin` field to smuggle.
- **M5 — Clock/auto-debit:** no wall-clock source drives any banking
  transition; interest, premiums, and installments ripen by seq under
  player-caused wakes only; B-07/B-12/B-14 are acts. Frozen-world
  assertion over the failed-bank fixtures (X-49): 10,000 seqs change no
  banking doc.
- **M6 — Household/Exterior parties:** borrower/depositor refs are
  LedgerRef-class-checked at B-02/B-05/B-06 (personal | company |
  treasury only; market/exterior/institution rejected at parse).
- **M7 — Character-held claims:** no deposit or loan record names a
  character; NPC-attributed acts settle into the principal's ledgers
  (the A-8 fixture's NPC is refused before any ledger is touched).
- **M8 — Platform credit score:** no stored or computed score field
  exists anywhere in the slice (schema review over the new record
  shapes); the credit record is the Log.
- **M9 — Assignment outside §5.6:** the `assigned` transition is written
  only inside B-10 plans (B-11 on an assigned loan refuses — W3-23);
  subrogation moves no loan record.
- **M10 — Market Account as insurer/backstop:** fund inflows are the
  closed set (premiums, assessments, subrogated recoveries, governance
  grants) enforced in the transfer primitive's fund-line guards;
  fund↔market lines are forbidden outright.
- **M11 — Lender-of-last-resort in insurance's clothes:** the fund's rule
  surface is closed at the founding composition + B-12/B-13/B-14; B-13
  has no descriptor (it is a committer step inside B-10); no fund loan,
  advance, or pre-liquidation payout verb exists in the registry delta.
- **M12 — Retroactive coverage:** eligibility derives from `openedAtSeq`
  against fund existence + suspension intervals; the founding act elects
  **none**; a pre-founding deposit derives uninsured for life (W1-7).
- **M13 — Interbank instruments:** a bank's position in another bank is
  an ordinary B-02 company deposit in the record grammar; no interbank
  loan/note record type exists in the slice.
- **M14 — The loan nevers:** B-07 is borrower-initiated in every fixture
  (no auto-debit anywhere); a loan record's rate has no update path
  (terms change only by a new loan + a repayment); allocation can never
  raise `outstandingRubars`, and unsettled interest never capitalizes
  into principal — post-seizure uncovered interest sits in the
  non-accruing `residualInterestRubars` bucket until a settlement event
  makes it a transfer.

## 5. GAP / SPEC consumption notes

- **GAP-1 (system producer + `occasionSpecFromPending`): consumed as
  landed.** Banking's schedule pendings (`loan-installment-due`,
  `insurance-premium-due`, effectPath `"schedule"` in `pendingRules.ts`)
  ride the producer class; the family's ripening composition synthesizes
  the occasion specs at ripening (B2/B3 on the installment card, K1 at
  the default crossing, K3/K4 on premium/assessment) with figures
  computed at ripening, never at seed. **SPEC-1 consumed as Vera
  confirmed it:** perpetuation at ripening, schedule-anchored
  `requiredSeq`, generation-1 fresh chain per period.
- **GAP-2 (spillover widened; `buildIncidentSituation` subject/episode):
  consumed.** B4 (seizure, major), B5 (write-off), B6 (assignment),
  D1/D2, K5 mint through the incident builder with corporation subjects;
  K2 uses the Pattern X episode key `bank:<id>:failed-payment`. **GAP-4's
  build note discharged:** the major flag is set on B-08/B-10/
  custodial-rejection entries (B-10's summary is major; pool closing
  majors B-07's summary).
- **GAP-3:** declined by Vera (shareholders get no card) — none built.

## 6. Bugs the build caught in its own code (fixed in-branch)

1. **B-10 dedupe collapse** (`8b8470f`): every card minted by one
   Resolution Event shared (source, kind, audience), so a liquidation
   produced one situation instead of D1×N + B6 + K5. Fixed with
   `rekeyCard` (per-recipient source ids; `sourceResolutionId` keeps the
   true resolution); D2 re-keys with the *same* suffix as its D1, so it
   supersedes exactly.
2. **Pool read set** (`8b8470f`): B-07/B-08 pool forms distribute to
   data-dependent recipients; their read plans now carry B-10's broad
   shape (`allMemberAccounts` / `allCities` / per-city corporations).
3. **§5.6 dust was dropped** (`8b8470f`): pool distributions floored per
   claim and the remainder vanished from the borrower's debit. The dust
   now routes to the dissolved bank's frozen cash record as its own
   transfer line, and the D2 closing card names the accumulated figure.
4. **Insider-cap composition order** (`359c8f9`): the cash branch's cap
   test read the planned sheet after the disbursement leg but before the
   loan-book leg, understating net worth by the principal and rejecting
   at-cap insider funding its own comment said must pass. The loan-book
   leg now lands before the test, mirroring the credit branch.

## 7. Flags and open seams (for Vera / Osei / the Lead — none improvised)

- **F1 — B-09's cure stamp over-certifies for the failed-payment form
  (sharpest).** §5.4's cure condition has a coverability half (every
  failure-deriving custodial claim must become coverable). The handler
  cannot read the Log slice — by design, the derivation's venue is the
  verifier — so its `curesFailedPayment` stamp certifies the
  *arithmetic* cure only. W9's own fixture shows the consequence: the
  derivation clears on the stamp while the bounced claims remain
  uncoverable on the post-cure sheet. Ruling wanted: split the stamp
  (arithmetic vs failed-payment, the latter computed at the verifier
  venue), or give B-09 a Log-slice read. Until then the stamp should be
  read as "arithmetic cure" wherever the two forms coexist.
- **F2 — B-10 depositor trigger vs failed-payment-only banks.** The
  handler gates on the arithmetic sheet; a bank failed *only* by an
  uncured failed payment rejects `bank-not-failed` (the rejection text
  names this seam). Same Log-slice seam as F1; the owner may always
  liquidate voluntarily.
- **F3 — K2 episode minting rides the same seam.** Rejections write no
  entries a situation can ride, so the K2 card is minted/closed only by
  the first banking event whose read set can see the episode standing;
  B-09 terminals or updates a standing card but nothing mints it at the
  rejection itself. Candidate Lead change: stamp
  `classification.banking.bankCorporationId` on banking rejections so a
  wake composition can mint K2 deterministically.
- **F4 — Pool closing is evaluated only in B-07.** A pool-form B-08 that
  exhausts the book, and a B-10 with no loans / fully-paid claims (W6-43),
  leave deposits `assigned` with `poolUnpaid == 0` and no D2 closing.
  Candidate: evaluate `maybeClosePool` at B-10's end and in B-08's pool
  form, on planned views, exactly as B-07 does.
- **F5 — B-08 pool-form excess funding source is untested.** The
  mandatory excess-return line draws on the dissolved bank's frozen cash
  (post-surrender, the custodial surface reads the raw balance). No
  fixture covers a pool seizure with value > debt; Vera to confirm the
  intended source (frozen cash vs in-kind remainder to the borrower).
- **F6 — B-14 venue (design decision, taken at build).** Obligations
  arise at surviving banks' premium ripenings, not as B-10 pendings:
  the exact pro-rata figure needs the survivor's own insured numerator
  and the fund aggregate, both exactly readable only there. B-10's
  summary states the deficiency instead.
- **F7 — Pledged shares and the market path.** B-06 validates free
  shares as quantity − committed − pledged; the M-family sell path does
  not yet subtract pledged (assembly **A6**, one line). Until it lands,
  the pledge marking is the sim's truth but a market sale does not read
  it.
- **F8 — BNK-D3 label tension.** The addendum §2 table labels the
  insider cap "[Proposal — BNK-D3]" while §3.3/A-B3 verify against it;
  built as published (2,500 bps of post-funding net worth).
- **F9 — BNK-D4 fallback taken.** Seized shares land in the bank owner's
  holding flagged `heldForBank` (custody). Dana's corporation-holder
  confirmation is still outstanding; if she confirms a corporation
  holder, the landing site changes, not the mechanics.
- **F10 — Structure pledges narrowed to company borrowers** with the
  structure linked (a personal borrower cannot pledge a structure —
  `collateral-not-pledgeable`). A reading of §3.2, flagged for Vera.
- **F11 — Unvalued share collateral.** Satisfaction prices at seizure;
  a pledge of unlisted shares funds but cannot seize until priced
  (`collateral-unvalued`).
- **F12 — `"cancelled"` loan status** is this build's additive extension
  of the amendment's status union (B-05 cancel needs a terminal
  status); all derivations read it as inert.
- **F13 — `residualInterestRubars`** carries post-seizure uncovered
  interest as a non-accruing bucket on the loan record (M14-safe),
  settled by later B-07 payments.
- **F14 — V-B7 preview parity is structural.** One code path serves
  preview and commit; the harness drives commit mode through the real
  resolver, so preview figures are the committed figures by
  construction — parity is not separately asserted in a preview-mode
  run.

## 8. §Assembly list for Rafe

- **A1 — Resolver schedule dispatch.** On wake of a pending whose kind's
  `effectPath` is `"schedule"`, call the family's exported
  `buildScheduleRipeningPlan(snapshot, pending, ctx)` and commit its
  plan + transition the pending, exactly as acquisition's delivery
  dispatch calls `buildDeliveryPlan`. Read wiring for the composition:
  the loan doc (installments), `bankDeposits` + `bankLoans` queries,
  `premiumMarkers` / `premiumSettlements` / `assessmentMarkers` Log
  queries, the situations city query. Until wired, a scanned schedule
  pending falls to the stat path — the branch is built, not live (A-2).
- **A2 — `sim_bank_loans` rules + indexes (item 3).** `firestore.rules`:
  committer-only writes; reads = bank owner + borrower + fabric (company/
  treasury loans public as their ledgers are). `firestore.indexes.json`:
  `bankCorporationId + status`; borrower-identity + status.
- **A3 — Chain the harness.** Add `tests/banking-harness.ts` to
  `test:sim` after `situations-harness`.
- **A4 — Sibling census updates (verified on this tip, then reverted —
  not in this branch).** `tests/governance-harness.ts` G1:
  `RULE_DESCRIPTORS` 70 → **79** ("74 landed + 5 governance"; the +9 are
  B-05…B-12 and B-14). `tests/closeout-harness.ts` S6: the effectPath
  assert admits `"schedule"`. With exactly those two changes both
  harnesses pass in full on this branch (54 and 29 checks).
- **A5 — R-07/M-10 → B-10 routing (Lead-coordinated minimal edit).** At
  the dissolution seam: chartered check → cite B-10 for chartered
  companies; unchartered mechanics untouched.
- **A6 — `freeShares` pledged amendment.** One line in the market
  family's free-share computation: subtract `pledgedShares` (see F7).
- **A7 — DIF founding venue.** Wire `buildDifFoundingPlan` (exported
  from `lib/sim/rules/finance.ts`) to the adoption act's execution
  path; the act itself is Theo/Koda's.
- **A8 — Export runners/routes** for item 15's four datasets (the pure
  builders are landed; §7.5 scope re-asserts in the pure layer).
- **A9 — README** Phase 5 PR-6 section + changelog (standing every-PR
  rule).
- **A10 — Registry: no edit needed.** `FINANCE_DESCRIPTORS` auto-folds
  into `RULE_DESCRIPTORS` (verified total: 79). B-13 has no descriptor
  by design — it is a committer step inside B-10.
- **A11 — Rules-suite posture matrix** for `sim_bank_loans` (the
  deposits matrix, loan-shaped), with A2.

## 9. PR draft

**Title:** Phase 5 PR-6: the banking slice — B-04 credited branch, REC-6
identity, loans B-05–B-08, recapitalization B-09, waterfall B-10, write-off
B-11, DIF founding + premiums B-12, B-13/B-14, controller bar, §7.5 exports

**Body:**

> Built per `workstreams/p5-banking-addendum.md` items 0–15 against the
> conformed banking amendment, REC-1–REC-8, and Vera's V-B0–V-B7. Felix
> build (family files + harness); assembly per the prep report's §8
> (schedule-dispatch branch, `sim_bank_loans` rules/indexes, harness
> chaining, R-07/M-10 → B-10 routing, README).
>
> **Built, not live (A-2).** The P2-K15 production chain is unexecuted
> and unowned: (1) production fabric service user provisioned with the
> `fabric` claim and both `fabricRole` values (`committer` and
> `worker`); (2) production rules deploy of the full post-Phase-5 rules
> file; (3) production indexes deploy; (4) production genesis executed;
> (5) an operated production wake path. No production anything in this
> PR.
>
> Evidence: `tests/banking-harness.ts`, 51 checks — the failure fixture
> end-to-end in both funding forms (every transition asserted from the
> standing Log), the second-failure senior queue, §4.1 recomputation
> extended to loan interest and premiums, the premium ladder walk,
> creation tests at their boundaries, conservation negatives re-proven
> on a live book, frozen world, and the A-8 NPC Tier B refusal (F-E11
> closes). Guardrail (G1–G5) and must-not-build (M1–M14) discharges,
> GAP-1/GAP-2 consumption notes, and flags F1–F14 are in
> `workstreams/p5-banking-prep-report.md`. Sharpest flag: **F1** —
> B-09's `curesFailedPayment` stamp certifies the arithmetic cure; the
> failed-payment form's coverability half awaits Vera/Osei's ruling on
> the Log-slice seam (F2/F3 ride the same seam).

---

# Assembly addendum — PR-6 (Rafe, Phase 5 Build Lead)

Felix's slice assembled onto current master. This addendum records
the base, the compositions, the A1–A11 dispositions, the F1–F14
dispositions, two assembly catches beyond Felix's list, the
regression, and the PR draft of record. The branch is
`phase5/banking-assembled` in phase5-clone; per the standing process
the Lead does not push — Theo verifies and pushes.

## Base verification + commit map

- Target master: **`081c21a`** (PR #43, Baseline ratification),
  tree `390e59976875cd16b7b608f9a30e496dd8240e85`, verified via
  the GitHub API against the local reconstruction
  (`assembly/base-master-081c21a` at `543dd38`, the baseline-flip
  branch tip — tree byte-identical).
- Felix's branch: `p5/banking` in p5-banking-clone, tip `8d91533`,
  based on `d36088d` (PR-3 tip). **Nineteen commits** ride
  `d36088d..8d91533` (the eighteenth is the last code commit; the
  nineteenth is the prep-report commit itself). All nineteen
  cherry-picked onto the base — **zero conflicts**: Felix's delta
  is 13 files, none of which PR-4, PR-5, or #43 touched. Every file
  sha256-verified byte-identical to his tip after the pick.
- Assembly commits on top (Rafe): A4 census/effectPath (`e0a7a22`);
  A1 resolver schedule dispatch (`32f1ec2`); A5 charter routing +
  A6 freeShares (`8eaea89`); A2 rules/indexes + A11 matrix + A3
  chain (`102569f`); fund-singleton rules block (`28be5a4`); A8
  export runners (`6a927a2`); A1 completion — descriptor
  permissions + resolver-drive coverage (`e4e65f7`); prefer-const
  build fix; this addendum + README.

## Shared files across the four deltas, and their compositions

Felix's 13 files are disjoint from the PR-4 (17 files), PR-5 (19
files), and #43 (3 files) deltas. The shared files are
assembly-side only, composed as follows:

- `README.md` — PR-6 section after PR-5's + changelog entry +
  scripts-table row (this PR).
- `package.json` — `test:sim` gains `tests/banking-harness.ts`
  after situations-harness, before wake-harness (A3).
- `firestore.rules` — `sim_bank_loans` holder-read branches (A2) +
  the fund singleton block (assembly catch 2, below). No other
  rules text moves; PR-4's delegated-action create fence and PR-5's
  (none) are untouched.
- `firestore.indexes.json` — four `sim_bank_loans` composites (A2)
  + two runner composites (bankCorporationId + depositor.memberId
  on deposits; bankCorporationId + borrower.memberId on loans).
- `tests/rules.test.ts` — the loan-shaped posture matrix inside
  the existing finance block + the fund singleton assertions (A11);
  the shapeless reserved-loan seed's assertions stand unchanged
  (still fabric-only under the new branches — no borrower/bankCityId
  on that seed).
- `tests/sim-core.test.ts` — **untouched**: Felix added no sim-core
  scenarios (his delta carries none), so master's version stands,
  including #43's CK4 ratified-posture asserts and PR-4 fix round
  2's full collection list in `assembleWorld`. Nothing in the
  assembly writes a collection a landed scenario reads without
  collecting it. The suite is CI's venue on this PR.
- `tests/governance-harness.ts` / `tests/closeout-harness.ts` —
  A4 only (below).

## A1–A11 dispositions

- **A1 (resolver schedule dispatch) — DONE, with two Lead
  decisions.** `resolveRipening` gains a schedule branch on the
  kind's declared `effectPath` (E6), mirroring the delivery
  branch: the plan comes from `buildScheduleRipeningPlan` over a
  synthetic action standing in the origin action's place (the
  wakeSteps delegation-fire precedent — actor and actionId copied
  from the pending's origin, never a "system" actor), validated
  and finalized through the same tail as every ripening.
  **D-A1a (transition ownership):** Felix's composition pushes no
  pending transition (his harness transitions manually); the
  branch pushes `{pendingId, toStatus: "ripened", outcomeSummary}`
  itself, per A1's text ("commit its plan + transition the
  pending") and the R-33 tail's precedent. **D-A1b (refusal
  channel):** a rejected composition plan converts to
  `RipeningPreparationError` carrying the rejection code — no
  ripening path in this engine commits rejections (R-33 throws;
  delivery never rejects), and the throw routes Felix's designed
  refusals (`ripening-kind-unrecognized`,
  `ripening-read-incomplete` — "nothing ripens blind") into the
  established attempts → needsAttention channel instead of an
  infinite per-wake rejection loop. **Read wiring:**
  `collectRipeningReadPaths` adds the loan doc (installments), the
  bank corporation doc, and the fund singleton from the frozen
  schedule spec; `collectRipeningReadQueries` declares the
  bank-scoped set — `bankDeposits`, `bankLoans`, premium
  markers/settlements via the family's own `premiumQueries` (now
  exported for the collector), `assessmentMarkers`,
  `situationsByKey*` for the bank city, and
  `standingSchedulePendings` (the premium composition scans the
  snapshot's doc set for an already-standing assessment; the
  materializer binds query results into that set, so the scan now
  sees them). `pending.ts` materializes declared queries
  generically, so dispatcher and in-transaction recompute carry
  the same set. **Named residual:** a cross-city company borrower's
  corporation doc is not derivable from the pending alone, so
  `situationAddressingFor`'s company case cannot resolve
  `recipientUid` for installment cards in that case — the card
  still files under the bank-city facet with the faction audience
  (no leak, fewer readers). Follow-up shape: two-round ripening
  seed reads, or B-06 freezing borrower read paths into the spec.
  **Coverage:** the banking harness gains an A1 section (checks
  52–54) driving a premium ripening through the real
  `resolveRipening` — marker + transition + successor asserted —
  and the refusal case (fund record deleted → throws
  `ripening-read-incomplete`).
- **A2 (rules + indexes for `sim_bank_loans`) — DONE.** Read
  branches mirror the deposits matrix on the loan record's own
  fields: personal borrower reads own; company/treasury borrower
  loans public to viewers (§2.7); bank owner via the corporation
  `ownerMemberId` fact; admin/fabric as before; writes
  committer-only. Indexes: (bankCorporationId + status),
  (borrower.memberId / cityId / corporationId + status).
- **A3 (chain the harness) — DONE** (see shared files).
- **A4 (census updates) — DONE exactly as Felix verified:**
  governance-harness census 70 → 79 with the label corrected to
  "74 landed + 5 governance registrations at census 79"; the
  closeout S6 assert admits `"schedule"`. Both harnesses re-run
  green (57 / 29).
- **A5 (R-07/M-10 → B-10 routing) — DONE, minimal seam.** R-07
  Dissolve refuses a company holding an ACTIVE charter on both
  its paths (`bank-chartered-dissolution`, citing B-10);
  M-10's `composeLiquidation` refuses the same
  (`bank-chartered`). Unchartered mechanics byte-untouched; a
  surrendered charter restores them. Fail-closed posture
  preserved everywhere the routing does not reach. (Noted, not
  changed: R-07's listed-dissolve rejection text still carries
  its Phase 4-era rationale sentence although M-10 stands —
  the rejection and its M-10 citation are correct; the stale
  sentence is a copy follow-up, not a posture gap.)
- **A6 (freeShares) — DONE.** `freeShares` reads quantity −
  committed − pledged, exactly as B-06's pledge-commit change
  text already stated; `ShareHoldingRecord` gains the additive
  optional `pledgedShares` (absent ≡ 0). Closes F7's engine half.
- **A7 (DIF founding venue) — disposition: composition landed,
  execution operated.** `buildDifFoundingPlan` is exported and
  harness-proven (singleton, second founding rejects, chains
  seeded); no member action kind exists for it, by design — the
  founding is an adoption act (BNK-D18 / REC-3), and no lawful
  in-repo execution path stands today. Its execution rides the
  P2-K15 production chain as an operated step (named in the PR
  body beside the A-2 statement); the Phase 7 Town Hall charter
  venue (B-15+) is the in-world successor. No route was invented.
- **A8 (export runners) — DONE with one named narrowing.**
  `lib/export/fetchBankingExport.ts` lands fetchers + download
  runners for all four datasets in step 11's pattern
  (as-requester reads; visibility inherited; fail-closed).
  Depositor/borrower views use identity-constrained queries
  (rules are not filters) served by two new cross composites.
  The verified sheet derives through the family's own
  `bankBalanceSheet` / `deriveBankHealth`; its per-bank created
  supply is summed when readable and null when not (never
  invented). **The failure statement is bank-owner-scoped in
  this build**: Felix's §7.5 matrix designs it any-member (the
  waterfall's figures are public Log facts), but the
  per-depositor rows live on holder-scoped deposit records and
  the B-10 event publishes totals, not the per-row table. The
  runner serves the one identity who may read every row and
  refuses the rest with the reason stated; opening the
  any-member venue is a §2.7 posture decision **named for Vera**
  in the PR body. No page touchpoints: no banking surface exists
  yet (surfaces follow-up, June's line).
- **A9 (sim-core scenarios) — nothing to assemble** (see shared
  files): Felix added none; master's suite stands.
- **A10 (registry) — VERIFIED, no edit needed.** The nine
  B-descriptors fold through `FINANCE_DESCRIPTORS` (Felix's
  step-0 import); a Lead probe over the assembled registry:
  census 79, every descriptor's every action kind resolves
  through `descriptorForActionKind` to its own descriptor with a
  function handler. B-13 absent by design (committer step inside
  B-10). The governance harness's G1 census asserts 79.
- **A11 (rules-suite matrix) — DONE** (see A2): the loan-shaped
  matrix beside the deposits one — borrower/bank-owner/fabric
  reads, cross-city/guest/anon refusals, company-borrower viewer
  reads, committer-only writes. CI's venue (the sandbox cannot
  run the emulator).

## Assembly catches beyond Felix's list

1. **B-07/B-12 `mayCreatePendings`.** The first resolver drive of
   a schedule ripening failed validation: "descriptor B-12 may
   not create pendings." Felix set the permission by action
   handler (B-01 charter seeding, B-06 schedule seeding — both
   true), but B-07's and B-12's creates live in their RIPENING
   compositions (successor installment/premium pendings; B-14
   assessment pendings raised inside ripenPremium) — SPEC-1
   perpetuation under their own descriptors. The permission now
   stands on both, commented with the reason. Without this catch
   every schedule ripening would have thrown in production.
2. **The fund singleton's rules block was missing.** PR #30's
   record states the DIF rules landed ("fund singleton
   public-read + committer-write"); no match for
   `sim_deposit_insurance_fund` stood in `firestore.rules` on
   master — the singleton was default-denied to every
   rules-evaluated identity (unnoticed because engine reads run
   server-side). The block lands here exactly as recorded
   (viewer read of `main`; committer-only writes), with the catch
   noted in the block comment and posture assertions in the
   rules suite.
3. **`prefer-const` build error** in B-08's pool-form closing
   (`let summarySeq`, never reassigned) — one-token fix,
   behavior-identical; the assembled `next build` is green.

## F1–F14 dispositions (for the PR body)

- **F1 — SHIPS AS BUILT, NAMED RATIFICATION ITEM.** B-09's
  `curesFailedPayment` stamp certifies the arithmetic cure only;
  §5.4's coverability half is unverifiable from the handler by
  design (the verifier venue). The stamp's scope is stated in
  code (Felix §5) and in the PR body; **F1 is carried as a named
  ratification item for Vera/Osei — the PR-7 gate records it;
  nothing silently widens.**
- **F2 / F3 — ride F1's seam, carried with it.** (B-10's
  depositor trigger refuses a merely-insolvent bank
  `bank-not-failed`, its text naming the seam — the owner may
  always liquidate voluntarily; K2 episode minting rides the
  same seam, candidate fix: stamp
  `classification.banking.bankCorporationId` on banking
  rejections.)
- **F4 — RECORDED.** Pool closing is evaluated only in B-07's
  paths; a pool-form B-08 that exhausts the book and a B-10 with
  no loans / fully-paid claims leave deposits `assigned` with
  `poolUnpaid == 0` and no D2 closing. The assigned-at-zero edge
  is named here and in the PR body (candidate: evaluate
  `maybeClosePool` in B-10 / pool-form B-08).
- **F5 — as recorded** (pool-form excess-return source untested
  by fixture; Vera to confirm the source reading).
- **F6 — as built** (B-14 obligations arise at surviving banks'
  premium ripenings; design decision taken at build, exact-figure
  venue).
- **F7 — engine half CLOSED at assembly (A6);** pledge marking
  itself was already sim truth.
- **F8 — as published** (BNK-D3 label tension; built as the
  amendment's text directs, insider cap 2,500 bps of post-funding
  net worth).
- **F9 — BNK-D4 fallback taken as built** (seized shares land in
  the bank owner's holding flagged `heldForBank`); Dana's
  corporation-holder confirmation outstanding.
- **F10 — as built, flagged for Vera** (structure pledges
  narrowed to company borrowers, a §3.2 reading).
- **F11 — as built** (unlisted-share pledges fund but cannot
  seize until priced, `collateral-unvalued`).
- **F12 — as built** (`"cancelled"` loan status is an additive
  extension; derivations read it as inert).
- **F13 — as built** (`residualInterestRubars` non-accruing
  bucket, M14-safe).
- **F14 — as built** (V-B7 preview parity is structural — one
  code path; the harness drives commit mode through the real
  resolver).

## Regression (assembled tree, this machine)

- Banking harness **54/54** (Felix's 51 + the Lead's 3 A1
  resolver-drive checks); governance **57**; closeout **29**;
  situations **32**; wake **23**; chains **34**; cat2 **34**;
  cat1 all; defense **12**; acq **14**; market **27**; lore
  **27**. Registry probe: census 79, all descriptors resolve.
- `tsc --noEmit` clean; scoped ESLint clean on every assembled
  file; `next build` green (after catch 3).
- Emulator suites (Rules incl. the A11 matrix + fund assertions;
  Sim core incl. CK4) are CI's venue on PR-6 — the sandbox cannot
  run the Firestore emulator.
- Terminology: engine PR — no new member-facing copy except the
  export module's error strings and README text; both say "NPC"
  where the concept appears (the A-8 battery's actor form) and
  the forbidden synonym occurs in zero added lines.

## PR draft of record (Theo: push as-is or edit)

**Title:** Phase 5 PR-6: the banking slice — B-04 credited branch, REC-6 identity, loans B-05–B-08, recapitalization B-09, waterfall B-10, write-off B-11, DIF founding + premiums B-12, B-13/B-14, controller bar, §7.5 exports

**Body:**

Phase 5 PR-6 (of the seven-PR train) lands Felix's banking slice
(prep report `workstreams/p5-banking-prep-report.md` §§1–7, Felix;
§8 assembly list executed by the Lead — dispositions in the
assembly addendum appended to that report) on the post-#43
master. It completes the finance family under Banking Rider 1 /
Addendum v2: the registry census lands at **79** (the nine
B-verb descriptors B-05…B-12 + B-14 via the finance family;
B-13 deliberately has none — a committer step inside B-10).

What lands, by Felix's items: (0) the R-12 situational-awareness
table completed for every B-verb (each family's `situationsFor`
covers the banking kinds conjunctively inside its own family's
rows); (1) **B-04 credited branch** — §4.1 interest settles into
the claim itself at exact integer figures, liabilities paired
(A-B1), zero cash movement, the claim-figure Log grammar
extended across the accrual family; (2) the **REC-6
balance-sheet identity** in the standing verifier — one
aggregate-sourced sheet asserted per chartered bank every wake,
with the equity bridge rebuilt per resolution from Log-stored
opening equity (A-B8); (3) **B-05 loan offers** (insider
aggregate derived at offer, Tier B, stated branch from the
Phase 4 record); (4) **B-06 funding** on both branches — cash
against real tracked cash; credit creating the paired deposit +
claim under BNK-D8's solvency equality (never a silent
overdraft), structure/share collateral marked with
`pledgedShares` stamped; (5) **B-07 repayment + installment
ripening** — the installment schedule on the frozen interval
lattice (one outstanding per loan), fixed allocation order,
principal-only netting under the §3.2 acceptance matrix, the
pool form with subrogation; (6) **B-08 seizure** on both
branches — third-party valuation as the satisfaction figure,
excess returned, shortfall written down never forgiven,
insurance-receivable recognition at seizure (REC-6's fifth
account class input); (7) **B-09 recapitalization** — owner cash
converts to equity live; member injections are equity-NEUTRAL
(A-B8: the claim survives OR is subordinated into equity, never
both); (8) **B-10 liquidation** — owner-voluntary and
depositor-triggered forms, claims frozen on the REC-5 basis,
BNK-D16 setoff without circularity, the waterfall (taxes →
adjudicated → depositors → shareholders on the M-10 remainder),
**B-13 senior-queue settlement inside the event** before its
own top-ups, the loan book assigned to the depositor pool —
a derivation over records + Log, never a stored object — whose
closings state forgone claims in the open; (9) **B-11
write-off** through the equity bridge (REC-2 credit loss, never
a burn); (10) the **controller bar** — derived from the Log
alone, barring a failed bank's controller from a new charter
until uninsured depositors and the fund are whole or the seq
term passes; (11) **DIF founding** (adoption-act composition;
grandfathering NONE; chains seeded for chartered banks) +
**B-12 premiums** on the exact ladder with the derivation shown
in every marker; (12) **B-14 supplemental assessments** raised
at surviving banks' premium ripenings from the fund's derived
deficiency; (13) **GAP-1 occasion wiring** live for B-10/B-12/
B-14 (the §6.5 producer composed into the B families; credit-
alert anticipation for nonzero bank-equity deltas only, R-33
excluded by construction); (14) the **W4 battery** — every
B-verb's Tier B classification pinned from three sources, and
**Osei's A-8 case: all fourteen B-verbs refuse an NPC-system
actor structurally** (`npc-tier-b-structural`), closing
**F-E11**; (15) the **§7.5 banking datasets** (bank book
deposits + loans, verified sheet, failure statement) as pure
builders with fail-closed scope assertions — verified tier
throughout, created supply under its own name (G4).

Assembly (Lead; addendum has the full record): **A1** the
resolver's schedule-ripening branch — installment/premium
pendings now ripen through the real wake path over a
bank-scoped read set declared from the frozen schedule spec;
composition refusals ride the ripening preparation channel,
never a committed rejection; the banking harness drives the
branch end-to-end (54 checks). **A5** R-07 Dissolve and M-10
liquidation refuse an actively chartered company, citing
**B-10** as the only lawful dissolution for a chartered bank;
unchartered mechanics untouched. **A6** `freeShares` reads
quantity − committed − pledged (F7's engine half closed).
**A2/A11** `sim_bank_loans` holder-read rules + indexes and the
loan-shaped posture matrix; **A3** the banking harness chained
into `test:sim`. **A8** the §7.5 export runners
(`lib/export/fetchBankingExport.ts`). Two assembly catches:
B-07/B-12 `mayCreatePendings` now stands (their ripening
compositions create successors by design — the first resolver
drive caught it), and the deposit-insurance fund's rules block
— recorded as landed in Phase 4 (PR #30) but absent from
`firestore.rules` — lands here exactly as recorded, with suite
assertions.

**Named items carried, nothing silently widened:**

- **F1 (ratification item for Vera/Osei, recorded at the PR-7
  gate):** B-09's `curesFailedPayment` stamp certifies the
  arithmetic cure only. §5.4's coverability half is unverifiable
  from the handler by design (verifier venue); the PR ships as
  built with the stamp's scope stated in code and here. **F2**
  (B-10's depositor trigger refuses a merely-insolvent bank —
  `bank-not-failed`, the text naming the seam; the owner may
  always liquidate voluntarily) and **F3** (K2 episode minting
  rides the same seam; candidate fix recorded) ride with it.
- **F4 (recorded):** pool closing is evaluated only in B-07's
  paths; the assigned-at-zero edge (pool-form B-08 exhausting
  the book; a B-10 with no loans or fully-paid claims) leaves
  deposits `assigned` with `poolUnpaid == 0` and no D2 closing.
- **Failure-statement scope:** the §7.5 matrix designs the
  failure statement any-member; its per-depositor rows live on
  holder-scoped deposit records, so the landed runner is
  bank-owner-scoped and refuses other identities with the
  reason stated. Opening the any-member venue is a §2.7
  posture decision named for Vera.
- Felix's remaining flags (F5–F14) ride as built / recorded in
  the addendum; BNK-D4/D5/D15/D18 postures stand as Felix built
  them (F9's corporation-holder confirmation still Dana's).

**Operated steps:** the DIF founding composition is landed and
harness-proven; its execution is an operated adoption act
riding the P2-K15 production chain — it is not a member action
and no route was invented for it.

**This PR is built, not live** (A-2): the P2-K15 production
chain has not run — (1) no production fabric service user with
the `fabric` claim and both `fabricRole` values (committer +
worker); (2) no production rules deploy; (3) no production
indexes deploy; (4) no production genesis; (5) no operated
production wake path.

Regression: banking 54, governance 57, closeout 29, situations
32, wake 23, chains 34, cat2 34, cat1 all, defense 12, acq 14,
market 27, lore 27; registry probe census 79 with every
descriptor resolving; tsc clean; scoped lint clean; `next
build` green. Rules + Sim core suites are CI's venue on this
PR.

## CI fix round 1 (PR #44) — Rules suite: the fabric fixture gap (Rafe)

**Symptom.** The Rules suite ran its full length and died at the end
of the finance posture block with an uncaught FirebaseError
permission-denied: "evaluation error at L1560:22 for 'get' @ L1560,
false for 'get' @ L1560". Install, Sim core, and Vercel were green.

**L1560 identified.** firestore.rules L1560 is the deposit-insurance
fund singleton's read clause — `allow read: if isViewer() &&
docId == 'main'` in `match /sim_deposit_insurance_fund/{docId}`
(L1559–1562), landed at assembly (catch #2). The failing assertion
is the fund block's `assertSucceeds(getDoc(fundRef(fabricWorker)))`:
the guest and member reads before it (both seeded viewers) succeed,
and the worker read is the first assertion in the suite's history to
exercise a fabric identity against a purely viewer-gated clause.

**Root cause — the test fixture, not the clause.** The rules
suite's sim fixture never seeded user records for the fabric
identities. `isViewer()` is `isSignedIn() && hasUser() &&
!isSuspended()`; with no `users/fabricWkr` doc, `hasUser()` is
false and every viewer-gated clause evaluates false for the fabric
identities. The gap is Phase 2 vintage: the fabric contexts were
introduced for claims-gated write fences, where a user record is
irrelevant, and no later section reached a viewer-only clause with
a fabric identity until the fund block.

**The engine's model, proven in the sibling suites.** Both engine
fixtures seed the records this one lacked — sim-core.test.ts
(fabricSvc/fabricWkr user docs, `{email, status: "approved",
isAdmin: false}`) and play-core.test.ts (same) — because the
dispatcher materializes read plans over the fabric committer
identity through the client SDK, in the caller's identity
(dispatcher.ts's `committerDb` + readers.ts), and the wake runner
executes the whole wake signed in as the fabric service user
"exactly as production fabric would" (scripts/sim-run-wake.ts).
Viewer-only clauses the fabric legitimately reads —
sim_world/current, sim_fabric_status/current — have depended on
the service user being a viewer all along. The rules suite was the
lone fixture not encoding it.

**Why the clause stands.** The design's posture for the fund is
viewer read of `main` + committer-only writes (the banking
amendment's recorded posture, landed verbatim at assembly).
Widening it with an `isFabricService()` branch would exceed the
design and break symmetry with the three sibling viewer-only
singleton clauses, none of which carries a fabric branch — the
model puts the service user's viewer status in its user record,
not in per-clause branches. (Contrast deposits / loans / member
accounts, whose designs name the fabric identity in the read
matrix — finance §1.2/§2.7 — and whose clauses carry the branch
for that reason.) Per the PR #41 round-2 lesson, neither side was
edited until the evidence indicted one: the suite was taught
nothing, and the clause was widened by nothing.

**Fix.** Two `seedUser` lines in the rules suite's sim section
(fabricSvc, fabricWkr — same shape as the sim-core/play-core
fixtures) plus a comment at the seed site stating the discipline.
Assertions untouched; rules untouched.

**Sibling sweep.**
- Loans clause vs handler shapes — clean. loans.ts writes
  `borrower: LedgerRef` (personal `{kind, memberId}`; company
  `{kind, corporationId, cityId}`; treasury `{kind, cityId}`) and
  top-level `bankCorporationId` / `bankCityId` (loans.ts:45–46,
  167–168) — exactly the fields the clause keys on; the
  corporation read-back (`sim_cities/{bankCityId}/corporations/
  {bankCorporationId}` → `ownerMemberId`) is the Phase 4 deposits
  pattern. The A11 matrix assertions preceding the fatal line all
  behaved as designed, and the test fixtures mirror the handler
  shapes, not merely the clause.
- Deposits mirror — clean: banking.ts writes `depositor:
  LedgerRef` (banking.ts:167/235/251), the grammar the deposits
  clause keys on.
- Fund update/delete postures — consistent: create, update, and
  delete share the single `isFabricCommitter() && docId == 'main'`
  line (L1561), so no posture divergence between them is possible;
  the clause keys on docId only (no fund-record fields), so the
  field-divergence class cannot occur here. Fund consumers
  verified against the landed posture: resolver snapshot reads
  (lib/sim/rules/finance.ts) and the as-requester export read
  (lib/export/fetchBankingExport.ts).
- Fixture-flip sweep — clean. Every fabric-context assertion in
  the suite was enumerated: write denials are claims-, ownership-,
  or shape-gated (a user record with `isAdmin: false`, no city
  ownership, and a uid matching no fixture owner opens none of
  them — including the publications "fabric never publishes"
  create, the drafts badge fence, and the posts sim branch); read
  successes ride explicit fabric branches; no assertion anywhere
  denies a fabric read on viewer/member grounds. The sections
  after the finance block (cases, acquisition, Phase 5
  governance), which ran green in PR #41 and never executed in
  PR #44's run, contain no assertion the seeding can flip.

**Regression (local).** Pure battery green at landed counts
(banking 54, governance 57, situations 32, wake 23, closeout 29,
chains 34, cat2 34, cat1 all, defense 12, acq 14, market 27,
lore 27); tsc clean; ESLint on the touched file 0 errors (one
pre-existing warning at tests/rules.test.ts:2095, `_dropped`, in
an untouched region); `next build` green. The rules suite itself
is CI's venue: the case to watch is the fund block completing and
the suite running to its final ok line, with the cases,
acquisition, and Phase 5 governance sections executing after it.
