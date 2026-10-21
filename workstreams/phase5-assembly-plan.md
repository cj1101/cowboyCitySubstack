# Phase 5 Assembly Plan — Rafe (Muse Eng), Build Lead

**Date:** 2026-10-20 · **Status:** Half 1 COMPLETE (rebases verified); Half 2 = this plan.
**Inputs of record:** `phase5-implementation-brief.md` (brief of record) · `phase5-build-prep-report.md` (Petra) · `phase5-decisions.md` (Petra, 2026-10-20 — **cited throughout; it governs where this plan and the prep draft differ**) · `qa-phase5-gate-countersign.md` (Osei — **COUNTERSIGNED WITH ADDENDUM A-1–A-8**; the addendum, not the brief's proposal language, states the venue of record) · `p5-npc-core-prep-report.md` §3 · `p5-authority-prep-report.md` (design notes + conflicts) · `banking-amendment-design.md` §7.2 (Felix, conformed).
**Decisions posture:** P5-K1–K15 as recorded in `phase5-decisions.md`. **P5-D6 stays FLAGGED for Koda** (recommended reading stated there, NOT adopted). **P5-D5 adopted-but-flagged** (structured floor wins; prose interpreted at resolution with the interpretation recorded). The ten pre-built module flags (Cato's 5, Vera's 5 + her remaining notes by reference) are **PR-review ratification items — undecided here, none silently flipped by this plan.**

---

## 1. Assembly record — Half 1: verified rebases (done)

STATUS.md was checked and is **not current** (last entry 2026-10-19, closing at Phase 8 brief notes — it predates the Phase 4 back half and close-out), so per the standing instruction this record lives in the plan file rather than being appended to a stale ledger.

- **Clone:** `~/workspace/cowboy-city/phase5-clone` (`git clone --local` from `phase4-clone`). Module objects fetched from the two source clones (they are absent from phase4-clone's API-replayed lineage).
- **Local base reconstruction:** branch `assembly/base-master-b8ddf93` = `assembly/base-master-de40cbc` (eb1be89) + the 10 `p4/closeout` commits cherry-picked. Resulting tree **`91be037d…` — byte-identical to the closeout tip's tree**, as expected ahead of Theo's push-side verification against remote master `b8ddf93`.
- **Module branch:** `phase5/assembly-base` = reconstructed base + 6 cherry-picks, in order: NPC core `1c43e2d` → `95c88d9`; authority/envelopes `5e16a37…5338973` → `02bebef, 0f80a52, 4e37c1d, 4983ded, d81410c`. **Zero conflicts** (all six commits are pure file additions). All **23 module files verified byte-identical** to their source commits (blob-for-blob).
- **Re-verification on current master:** the modules are not hermetic — they import three landed seams: `lib/sim/canonical` (`sha256Hex`/`canonicalJson`), `lib/sim/state` (`SimActor`, `SimSnapshot`, `snapshotDoc`, `LogEntryDraft`), `lib/sim/rules/planHelpers` (`fieldChange`, `planWrite`, `summaryDraft`). Results:
  - `tsc --noEmit`: **clean** (after the seam fix below).
  - NPC core harness: **36/36 checks pass** — build-time number reproduced, mandate-hash golden vectors intact (so `lib/sim/canonical` did not drift through Step 0 or E1–E6).
  - Authority harness: **A1–A13 all pass**. Envelopes harness: **E1–E11 all pass**.
  - Scoped ESLint over the three module dirs: 0 errors (1 pre-existing warning — unused `PermissionMode` import in Vera's harness file; module payload, left untouched).
- **The one seam fix (Lead commit `b728863`, separate from the module commits):** Step 0 (F-01) made `SimSnapshot.queries: SnapshotQueryRecord[]` a required field; the two Phase 2-era harness files construct snapshot literals without it (npc-core harness `emptySnapshot()`, authority harness view fixture). Fix = `queries: []` added to those two literals — the same empty value landed code uses (`lib/sim/rules/allocation.test.ts`). **Fixture construction only; no module logic altered; no other seam required a fix.**
- **Not pushed.** Theo pushes after his tree verification.

---

## 2. Two decisions this plan makes (stated, not left ambiguous)

### 2.1 Module homes — ADOPT the built homes as-is
Petra's prep file map (following brief §1.1) names `lib/sim/npcs.ts` / `lib/sim/mandates.ts` / `lib/sim/authority.ts` / `lib/sim/envelopes.ts`. The ahead-built modules actually live at **`lib/npcs/**`, `lib/authority/**`, `lib/envelopes/**`**. **Decision (Theo's default, adopted): the built homes stand.** Reasons: (1) the modules are verified byte-identical and green *at those paths* on current master — moving them is pure churn that re-opens verification for zero functional gain; (2) each built home is a self-contained directory with its harness, matching the Phase 4 family pattern of cohesive new modules; (3) every consumer (registry/governance wiring, resolver authority stage, surfaces) imports from the built homes — the brief's flat-file map predates the ahead builds and binds nothing the builds contradict in substance. **New** Phase 5 runtime modules with no ahead build (situations, delegation) land at the brief §1.1 paths `lib/sim/situations.ts` and `lib/sim/delegation.ts`; if the builder outgrows a single file, a directory split under `lib/sim/` with the same import surface is permitted with Lead notice at assembly — the paths above are the contract, not a guess left open.

### 2.2 Wake semantics — the close-out's WakeScanState governs the Phase 5 passes
The brief §1.3 wake was written against pre-close-out dispatcher semantics. Phase 4's close-out changed the ground (Petra's build-start note, decisions record): per-wake **WakeScanState** (E1) — per-wake evaluation/event budgets and a **wake-start eligibility snapshot shared by all of a wake's scans**; ripeness verdicts re-evaluated on the claimed snapshot and again in-transaction (E2); delay clocks read the `lastResolvedSeq` tally (E4); delivery is a declared pending-kind `effectPath` (E6). **Wiring consequences, named explicitly so no builder codes against the brief's assumed semantics:**
- **Ripening/pending eligibility is snapshot-bound.** A pending created mid-wake is not scan-eligible until the next wake. Phase 5 creates pendings (envelope deliveries ride the E6 effect-path machinery); none may assume same-wake ripening.
- **Brief wake steps 4–6 are passes over this wake's commits, not scans.** Step 4 (delegation evaluation) and step 5 (standing-team triggers) evaluate Situations and Log events **committed in this wake** (steps 1–3 output), in the brief's order, exactly once — they do not re-read a live queue mid-pass. The brief's own guardrails compose with E1 unchanged: a rule fire never recurses inside its creating transaction; a situation created *by* a rule fire is not re-evaluated until a later wake (§1.4 bars stand verbatim).
- **Envelope claim pass (step 6) is a queue pass, not a scan.** It claims from `sim_task_envelopes` in QUEUED state as the pass runs — including envelopes spawned by step-2 commits earlier in the same wake (the brief's step order puts spawn in step 2 and claim in step 6 of one wake = one fabric cycle) — up to the P5-K5 per-wake claim cap (5); contention and leftovers wait for the next wake, logged as wake-summary bookkeeping, never as world outcomes. Execution-time authority revalidation (TC-N09) happens inside each terminal transaction per the pre-built lifecycle module (E9 semantics), not at claim time.
- **Budgets compose, never merge.** P5-K5's Phase 5 caps (envelope claims 5/wake; delegated resolutions 5/wake/city; rule fires 10/wake) are separate budgets from WakeScanState's scan budgets; both are logged on the wake summary. A Phase 5 pass hitting its cap stops cleanly — leftover work waits (§1.3 step 7).

---

## 3. Remaining build — work items, owners, dependencies

Gate throughout: brief §12 rows **P5-G1–P5-G13 as amended by Osei's addendum** (decisions P5-K12). Venue bindings from the addendum are folded into the items below and restated in §5.

### W1 — Substrate wiring (Lead: Rafe) · brief App. steps 1–2, 4 (substrate half)
- Registry/governance registration for the Phase 5 action surface (`npc.*`, `mandate.*`, `delegationRule.set`, envelope spawn, situation handling decisions) against the rebased modules in their adopted homes (§2.1); descriptor names per P5-K6 (brief §3.3 verbatim).
- **P5-K13 attribution amendment** (Vera's character obligations, adopted verbatim in the decisions record): NPC `characterId` link, the additive attribution field on NPC-attributed entries, **absent ≡ null canonical form**, **no `character` actor type, ever**. Gate consequence lands in W2's verifier work + P5-G9's hash-discipline assertions (a pre-Phase-5 fixture entry re-verifies byte-identical; both key forms accepted).
- `firestore.rules`: brief §9 blocks for all seven collections (`sim_npcs`, `sim_teams`, `sim_mandates` + `versions`, `sim_task_envelopes`, `sim_task_outputs`, `sim_situations`, `sim_delegation_rules` + `versions`) — owner-pending vs committer-effective fences per §1.2's write split.
- `firestore.indexes.json`: brief §10 additions.
- Phase 5 section of `tests/rules.test.ts` (P5-G9 matrix) — **with the A-7 discipline of §5.3 applied to its undo-restore assertion.**
- *Depends on:* Half 1 (done). *Feeds:* everything.

### W2 — Engine amendments (Lead: Rafe) · brief App. steps 3–5 (wiring half)
- **Resolver:** NPC-attributed actions pass through the authority stage (`lib/authority/**`) before rule dispatch (brief §5.1), with preview parity for delegated actions; escalation plans are first-class plan outcomes (§4.3/§5.5 routing per Vera's flag 1, as built).
- **Governance actions end-to-end:** `npc.*` / `mandate.*` / `delegationRule.set` through intake → preview → committer effectiveness flips → team roster projection; mode-default (P5-K3 `ask-first`, read from the builder default — A-4) and revocation-timing semantics (TC-N09: revoke between queue and run bites at execution).
- **Verifier (`lib/sim/verify.ts`):** the NPC checks — traceability triple over 100% of NPC-attributed entries, mandate-citation resolvability + `mandateHash` equality, envelope↔output bijection, silence-entry state-hash assertions (P5-G2 CI half).
- **Dispatcher/wake:** the §1.3 steps 4–6 wiring **under §2.2's semantics** — delegation pass, standing-team trigger pass, envelope claim pass, §8 silence commit — consuming W3's evaluator and the pre-built envelope lifecycle. `scripts/sim-run-wake.ts` step order updated; no scheduler (§1.4 bars are acceptance criteria, not aspirations).
- *Depends on:* W1; W3 (for the step-4/5 passes — W2's resolver/governance/verifier halves do not wait for W3). *Feeds:* W4 surfaces (preview/confirmation contracts), W5 banking (Tier B discipline live), W6 gate suite (the real dispatcher is the suite's subject).

### W3 — Situations + delegation (Owner: Vera) · brief App. steps 7–8
- `lib/sim/situations.ts`: builders, `dedupeKey`, handling-decision payloads, terminal transitions; creation inside Resolution Events from the §6.5 producers (escalation/incident/proposal); the §6.4 `needsAttention` conversion — backfill on first Phase 5 wake + steady-state creation at attempt 3 (P5-K8: handling the Situation does **not** clear the flag; P5-G12 asserts both halves).
- `lib/sim/delegation.ts`: Dana's five-step evaluation order (§7.2), narrower-of(rule, mandate) resolution, rule-fire payloads citing rule id + version, the composer guardrail validator shared by UI and rules tests (§7.3: no `act-for-me` over Tier B kinds, ever).
- Silence mechanics (§8) where they belong to the module layer: the non-response commit shape, P5-K9's silence actor (the owner member record for teamless cities).
- *Depends on:* W1 (shapes/rules). *Feeds:* W2's wake passes, W4's queue surface, W5's loan-occasion producers.

### W4 — Surfaces + ConfirmationCard (Owner: June) · brief App. step 9–10
- `app/situations/` per §11.1/§6.2's presentation contract (queue facets, cards, the three decisions §6.3, rules panel §7.4, history view); **Phase 3 situations-peek source swap** to `sim_situations` (P5-D7).
- `components/sim/SpawnNpcForm.tsx` (one component, four placements; bounds block required for negotiation tasks; `mayCommit` as fixed copy, never a toggle) + `components/sim/ConfirmationCard.tsx` (Petra spec §4.3 — the plan-wide binding-step primitive; exactly one confirm + one decline).
- `app/settings/npcs/` per §11.3 (freeform fields, mode control with the adopted default, versioned mandate authoring, hash shown read-only, team roster with derived activity state); Log page `npc` actor filter; §11.4 export touchpoints under the fail-closed discipline (P5-G10's export half).
- Terminology discipline is acceptance criteria: "NPC" in every string incl. generated output copy (P5-G13 render sweep, A-6).
- *Depends on:* W1 shapes; W2 preview/confirmation contracts; W3 queue semantics. *Feeds:* the gate's PR-evidence captures (§5.4).

### W5 — Banking Phase 5 slice (Owner: Felix) · amendment §7.2 — **sequenced after the NPC substrate it rides (W2 + W3)**
Loans stand on Situations producers (due occasions land in the owner's inbox) and on the mandate/Tier-B discipline being live — both are W2/W3 outputs, so this slice starts only when they land.
- **First work item, before code:** the build-prep banking addendum the amendment §7.2 itself demands (the Phase 5 brief predates CJ's banking rulings): loan/Situations producer inventory, the mandate tier table (origination + seizure **Tier B**; repayment/withdrawal **Tier A within caps**), A-B2 activation.
- **Rules:** B-05 (offer), B-06 (funding — **both funding branches: cash-funded and credit-creation**, paired-posting per Appendix A as conformed; unpaired issuance is a must-not-build), B-07 (repayment, borrower-initiated only), B-08 (seizure with mandatory excess-value return), B-09 (recapitalization), B-10 (waterfall + assignment with setoff), B-11 (write-off), **B-04 credited branch** (interest capitalizes into the claim at the bank's election).
- **DIF:** founding by the **Theo/Koda adoption act** (BNK-D18; Phase 7's charter act supersedes governance only) + the mechanical layer riding it — B-12 risk-based premiums, B-13 payout inside B-10 liquidation with subrogation, B-14 supplemental assessments. No Market Account backstop, no unchartered guarantee, no guarantee-as-cash (amendment §7.4 replacements govern).
- **Gate evidence (amendment §7.2/§7.7):** §4.1 interest recomputation extended to loan interest; the failure fixture end-to-end (charter → deposits → loans → derived default → seizure → failure → waterfall → pool recovery), every transition asserted from the standing Log; frozen-world assertion over bank fixtures.
- **A-8 consequence:** this slice ships the loan-acceptance class (B-06 borrower confirmation is binding-by-nature) → the P5-G3 battery **includes** an NPC attempt at that verb, refused structurally (see §5.5).
- *Depends on:* W2 (Tier B stage), W3 (Situations producers). *Feeds:* W6 gate battery (A-8 case), Phase 7 hooks (R-23, DIF charter B-15+) — named, not built here.

### W6 — Gate suite + CI wiring + PR assembly (Lead: Rafe) · brief App. steps 11–12 **as amended by A-1**
- `tests/npc-core.test.ts` — the full TC-N + TC-S battery against the P5-FIX world (seeded after genesis, through the dispatcher, extending P4-FIX) — wired **inside the existing `Sim core tests (non-required)` job's `emulators:exec` segment, alongside `tests/sim-core.test.ts` and `tests/play-core.test.ts`** (A-1/P5-K11). **Not** a new job, **not** the brief's `tests/sim-npc.test.ts` name, **no** branch-protection change (see §5.1).
- README (NPC/mandates/Situations sections + dated Changelog line) per the standing every-PR rule.
- Gate record + PR-evidence assembly per §5.4–§5.5.
- *Depends on:* W1–W5. This is the closing PR of the train.

---

## 4. PR sequence

One PR per work item, Phase 4 discipline (parallel where dependencies allow; Theo merges on green under CJ's delegated authority; **no merge while any of required + Rules + Sim core + Vercel is red** — brief §13 as amended by A-1). Every PR updates the README. The gate closes at PR-7's merge.

| # | PR | Owner | Contents | Depends on |
|---|---|---|---|---|
| 1 | Substrate | Rafe (Lead) | W1: rebased modules land (the `phase5/assembly-base` stack), registry/governance registration, P5-K13 amendment, §9 rules + §10 indexes, rules-suite Phase 5 section | Half 1 ✔ |
| 2 | Engine core | Rafe (Lead) | W2 halves: authority-stage resolver wiring, governance actions end-to-end, verifier NPC checks | PR-1 |
| 3 | Situations + delegation | Vera | W3: `lib/sim/situations.ts`, `lib/sim/delegation.ts`, silence module mechanics, `needsAttention` conversion | PR-1 |
| 4 | Wake completion | Rafe (Lead) | W2 wake half: dispatcher steps 4–6 under §2.2 semantics, envelope claim pass, `sim-run-wake.ts` order | PR-2, PR-3 |
| 5 | Surfaces | June | W4: `app/situations/`, SpawnNpcForm, ConfirmationCard, `app/settings/npcs/`, peek swap, Log filter, export touchpoints | PR-1 (shapes), PR-3 (queue), PR-2 (confirmation contracts) — build may start against PR-1/PR-3 drafts |
| 6 | Banking slice | Felix | W5: addendum first, then B-04 credited / B-05–B-11 / DIF founding + B-12–B-14, A-B2, failure fixture | PR-2 (Tier B live), PR-3 (Situations producers) |
| 7 | Gate | Rafe (Lead) | W6: `tests/npc-core.test.ts` + A-1 wiring, full P5-G1–G13 evidence table, PR-evidence captures, gate record, README completion | PR-1–PR-6 |

Dependency notes: PR-3 and PR-2 are parallel-safe after PR-1 (different files; PR-4 is where they meet). PR-5's mechanics are UI-only against landed contracts. PR-6 is deliberately last-but-one: it is the only item whose absence changes a gate row's *form* (A-8), and the gate PR must know which branch it is closing.

---

## 5. Countersign bindings in force (Osei, A-1–A-8 — plan-level restatement)

### 5.1 A-1 — Test venue of record
The NPC suite is **`tests/npc-core.test.ts` inside the existing `Sim core tests (non-required)` job** (`emulators:exec` segment, with sim-core/play-core). No new CI job, no renamed jobs, **branch protection untouched by every Phase 5 PR** — `Install · Typecheck · Lint · Build` remains the only required context; promotion of any non-required job follows only the standing separate evidence path. Any document citing an "NPC core job" means the suite inside the Sim core job. (The brief Appendix step 11's new-job proposal is superseded — P5-K11.)

### 5.2 A-2 — Every Phase 5 PR is "built, not live"
While the P2-K15/P5-K10 production chain is unexecuted, **every Phase 5 PR body states "built, not live"** and names the five outstanding chain items: (1) production fabric service user provisioned with the `fabric` claim and **both** `fabricRole` values (`committer` + `worker`); (2) production rules deploy of the full post-Phase-5 rules file; (3) production indexes deploy; (4) production genesis executed; (5) an operated production wake path. Gate rows close on emulator/CI evidence in built form only — no row (in the PR, the gate record, or any summary) may be reported as passing "live"; the four rows whose live form exercises the production identity are named in the gate record: **P5-G1, P5-G8, P5-G9, P5-G12**. The chain is not a gate row and does not block the gate; its assignment stands as carried by the Phase 4 gate (Theo's proposal on record: Rafe named production-chain owner for execution **when CJ authorizes** — no execution is authorized or taken by this plan).

### 5.3 A-7 — P5-G9's undo-restore assertion encodes the ratified P5-D6 reading — or says so
P5-D6 is **flagged for Koda** (decisions record): the recommended reading is brief §9.8 as written (inside an undo restore transaction only: root version pointer restored, superseded version's status flipped, payloads never edited; pending versions deletable by their author; effective versions deletable by no identity outside a restore). The Phase 5 rules suite's deletion-inside-restore assertion **must encode Koda's ratified reading**. **If P5-D6 is still unratified when PR-1 assembles:** the suite ships the §9.8 immutability matrix and restore-exception fence, the deletion-inside-restore assertion is **held out and named in the PR body as PENDING Koda ratification under P5-D6** — the PR states which reading its fixture encodes as *pending*, never silently rides the §9.8 default as if ratified — and P5-G9's D6-dependent assertion stays **open in the gate record** until ratification pins its final form (a one-line fixture pin at PR review once Koda rules). The build is not blocked; the assertion's final form is.

### 5.4 A-3 / A-5 / A-6 — PR-evidence halves (owned by June's surfaces, assembled by the Lead in PR-7)
Three gate rows close in two pieces; the CI halves live in the suites, the render halves are **preview captures attached to the gate PR and reviewed at merge**: **P5-G2** — Log → mandate click-through resolving with hash matching `mandateHash` (A-3); **P5-G11** — the unknown-kind card showing all three decisions + the silence-copy sweep over the rendered Situations surface (A-5); **P5-G13** — the rendered sweep for **each** named surface (dashboard, Log, digest, Situations, settings) showing "NPCs" terminology and outputs badged "〈name〉, for 〈owner〉" at change prominence (A-6). CI green alone closes none of these three rows.

### 5.5 A-8 — Banking Tier B case: planned branch
PR-6 ships the loan-acceptance class (B-06 borrower confirmation — binding-by-nature, Tier B by construction). **The P5-G3 battery therefore includes an NPC attempt at that verb, refused structurally like every other Tier B attempt**, and PR-7's gate record states this branch as taken. (The alternative branch — no such verb in the phase's surface, deferral recorded naming the verb class and the owing PR — applies only if PR-6's scope is cut by a later ruling; it is not the plan.)

### 5.6 A-4 — Fresh-NPC default assertion
P5-G5's default assertion reads: a fresh NPC's `permissionMode` === `"ask-first"`, read from the builder default in exactly one place (P5-K3; the rebased NPC core's `DEFAULT_PERMISSION_MODE`, harness-verified in Half 1). If a future CJ ruling flips P5-K3, the assertion flips in the same commit.

---

## 6. What this plan does not do

- **No production anything** — no access, provisioning, deploy, or genesis (P5-K10 carried, unabsorbed; §5.2).
- **No deal-portal flows** (P5-K7 substrate only; DP-1–DP-8 and the portal UI are not Phase 5; the R-29 handler seam per P5-K15 rides the portal phase).
- **No reachability build** (P5-K14: R-40/R-42/full-channel reachability recorded, not in this phase).
- **No module builds beyond Half 1's rebases** were performed under this task; W1–W6 start on Theo's dispatch.
- **No flag decided:** P5-D6 (Koda), P5-D5 (adopted-but-flagged for Koda), and the ten module flags ride to PR review exactly as the decisions record carries them.

*— Rafe (Muse Eng), Build Lead, 2026-10-20. Half 1 verified on disk in `phase5-clone` (branch `phase5/assembly-base`, tip `b728863`); this plan is the assembly's Half 2.*
