# Phase 5 Gate Record — PR-7 (Rafe, Build Lead)

**Instrument:** brief §12 (P5-G1–P5-G13) **as amended** by Osei's
countersign, `workstreams/qa-phase5-gate-countersign.md` (COUNTERSIGNED
WITH ADDENDUM A-1–A-8). Where the addendum speaks, it governs.

**Base:** master `aa3420b564ffc198c12032cd9fa0596d39405bb0` (PR #44
merge). Tree identity verified via the GitHub API before branching:
master's tree `f9f5e846b6df423b5fddd54aff95fc8a03c08d57` is
byte-identical to the local base branch
`assembly/base-master-aa3420b` (`2485eff`). The train on that base:
#38 PR-1 substrate (`070b8de`), #39 PR-2 engine core (`35e8527`),
#40 PR-3 situations + delegation (`c00f1a5`), #41 PR-4 wake
completion (`17ebbd0`), #42 PR-5 surfaces (`d30cc4f`), #43 the
world-baseline ratification flip (`081c21a`), #44 PR-6 banking slice
(`aa3420b`). Registry census on the base: **79 descriptors**
(verified by direct count of `RULE_DESCRIPTORS` and asserted
in-suite at N0).

**This PR:** `tests/npc-core.test.ts` (the gate suite) + the A-1
wiring in `package.json` + README + this record. Branch
`phase5/gate`, 3 commits on the base. NOT pushed by the author —
Theo verifies and pushes.

---

## 1. The A-2 statement (verbatim posture, applies to every row)

Every row below closes on CI evidence **in built form only**. The
gate's claim fixtures are emulator fixtures; no row's evidence
touches production, and no row certifies production operation. The
four rows whose live form exercises the production identity are
**P5-G1** (fabric cycles), **P5-G8** (worker claim/lease/crash
behavior), **P5-G9** (committer fences), **P5-G12** (wake-created
Situation): their live forms close only when the P2-K15 production
chain executes. The chain, in order:

1. The fabric service user provisioned in production with the
   `fabric` claim and **both** `fabricRole` values Phase 5 uses:
   `"committer"` and `"worker"`.
2. Production rules deploy — the full rules file as it stands after
   the Phase 5 PRs, after CI's Rules job has proven that exact file
   in the emulator.
3. Production indexes deploy — `firestore.indexes.json` as merged.
4. Production genesis executed.
5. An operated wake path in production.

The production chain is **not a gate row** and the gate does not
block on it. The operated Market §6 holdings-supply data step
(Phase 4, gated since PR #35) rides the same chain. Ownership
proposal of record (Theo's, from the Phase 4 gate): **Rafe as
production-chain owner for execution when CJ authorizes production
steps.** No production step has been taken or authorized by any PR
to date.

## 2. The A-1 wiring

`tests/npc-core.test.ts` is chained into `npm run test:sim` **inside
the existing `emulators:exec` segment**, after `tests/play-core.test.ts`:

```
firebase emulators:exec --only firestore,auth --project cowboycityrealm \
  "tsx tests/sim-core.test.ts && tsx tests/play-core.test.ts && tsx tests/npc-core.test.ts"
&& <the pure harness chain, unchanged>
```

No new CI job, no new branch-protection context, no job rename —
the suite's venue is the existing non-required **Sim core tests**
job, exactly as A-1 specifies. The pure harness chain order is
untouched.

## 3. The evidence table — P5-G1–P5-G13

Suite section references are to `tests/npc-core.test.ts` (N0–N11).
"Pure venues" are the tsx harnesses chained in `test:sim`; all ran
green locally at assembly (see §7) and run in CI on this PR.

| Row | Disposition | Evidence |
|---|---|---|
| **P5-G1** Wake integration | **CLOSED (built form)** | npc-core runs the extended wake end-to-end through the real dispatcher in every section: action phase → ripening scans → undo ops → passes (attention conversion, delegation, trigger, silence, claims, refresh). N4: a fire + delegated action + follow-up inside one wake; N5/N6: claims inside the fire/spawn wakes; N7: conversions inside a drive wake. Pure legs: wake-harness (pass arithmetic), sim-core (the Phase 2 wake, unregressed). Live form (fabric cycles) closes only when the §1 chain executes. |
| **P5-G2** Traceability triple, 100% | **CLOSED (built form; A-3 PR-evidence half code-evidenced, human capture outstanding)** | CI half: the F5 verifier walks **every** NPC-attributed entry after every npc-core section (`verifyOk()` — three-way traceability: NPC record stands + creator = city owner; mandate id+version = the version in force at the entry's seq, scope-covering; trigger resolves). N4 additionally asserts the trace in-suite over the fire's entries. `mandateHash` equality: N2 recomputes the hash from the **standing** version doc's own fields and asserts equality with the stored `mandateHash`. A-3 half: §5.1. |
| **P5-G3** Authority negatives | **CLOSED (built form)** | Two batteries, per the brief: (i) governance-harness (plan-level refusals: foreign city, unowned NPC, revoked mandate, envelope cancel by a non-requester, Tier B under every mode); (ii) npc-core through the dispatcher — N1 non-owner `npc.create` refused (one rejected entry, no record stands), N2 Tier B mandate authoring refused `MANDATE_AUTHORIZES_TIER_B`, N8 non-owner `npc.setMode` refused. **A-8 taken branch (named per the countersign): PR-6 SHIPPED B-06, so the battery case ran** — the banking harness's W4 battery carries the NPC Tier B structural refusal for all fourteen B-verbs under `npcSystemActor` (refused before any family validation), and **F-E11 closed at PR-6**. The deferral branch was NOT taken. |
| **P5-G4** Mandate + roster integrity | **CLOSED (built form)** | npc-core N1: create + activation + roster in ONE resolution (team docs stand with the created NPCs after each create). N2: `mandate.set` stamps root + version + NPC snapshot in one resolution (all three asserted on the standing docs, same resolution); supersede arithmetic and the client-authored pending-version flip are governance-harness G8 legs; hash-collision/astronomical-version refusals likewise. |
| **P5-G5** Permission modes | **CLOSED (built form)** | A-4's literal: N1 asserts the standing doc of a mode-less create reads `permissionMode === "ask-first"` (the adopted P5-K3 literal — not a paraphrase). Act-for-me: N4 (executes within caps; treasury moves exactly the spec's delta). Ask-first: N5 (envelope draft, card `awaiting_owner`, treasury byte-identical) + N7 (trigger draft posture on the converted card: no action doc created, no state moved). Silent: N6 (P5-K4 owner-direct tasking permitted, output advisory) + N7 (silence posture: exactly one silence commit, the P5-K9 NPC + mandate actor form). Drafts-never-auto-commit is asserted by state equality in N5/N7. Escalation-beyond-caps and Tier B contemplation legs: situations/wake harnesses (pure venue, named in the countersign's venue column). |
| **P5-G6** Envelopes | **CLOSED (built form)** | npc-core N5: fire-spawned envelope claimed in the same wake (the worker observes it RUNNING at claim time), exactly one output record, card rests `awaiting_owner`. N6: owner-direct spawn stands QUEUED; a worker-less wake defers (`deferredNoWorker: 1`, claims nothing); duplicate spawn refuses `ENVELOPE_ALREADY_EXISTS`; cancel-before-claim is terminal-without-output (`cancelled_before_claim`, `outputId: null` — F-E8's disposition) and never resurrects under a later worker wake. NEED-INFO/FAILED output forms and wrong-thread/double-complete refusals: envelopes harness E-series (pure venue). |
| **P5-G7** Delegation rules | **CLOSED (built form)** | npc-core N3: `delegationRule.set` writes root + version; the standing root's `ruleHash` equals `computeRuleHash` over the same field set (parity in the emulator venue; PR-3 confirmed the same digest against Vera's vectors). N4: the fire entry cites rule id + version (`classification.delegationFire`, `delegationRuleId`, `delegationRuleVersion`) and the card's handling record cites both. Specificity/priority/wait ordering, caps deferral (a capped fire writes nothing), hash-collision and foreign-NPC refusals: situations-harness + governance-harness legs. |
| **P5-G8** Revocation races | **CLOSED (built form)** | npc-core N8, in the emulator venue: `mandate.revoke` clears the NPC snapshot in the same resolution; a later matching card is **blocked** at the boundary (`delegation.blocked`, the §7.3 evaluation entry stands, the card rests open, treasury unchanged) — never silently re-authorized. Claim/execution-time revalidation bite, the ripening-reach fact (`revocationReaches("ripening") === false`, recorded at PR-4), and the envelope survival asymmetry (Vera flag 3): wake-harness + authority-harness legs. Live form (production worker claim/lease/crash) closes only when the §1 chain executes. |
| **P5-G9** Rules lattice | **CLOSED WITH ONE NAMED OPEN ITEM (A-7)** | The PR-1 rules matrix (owner-pending writes allowed pre-effectiveness; committer-only effectiveness flips; effective versions + task outputs deletable by **no** identity; non-owner and fabric-**worker** writes to authoritative collections refused; the §9.6 audience fences) stands merged and green since #38. npc-core N9 adds the dispatcher-venue undo legs: a leaf governance resolution undoes totally (entries + manifest + source action erased, doc restored); a cascaded resolution (`mandate.set` consumed by N4's fire) refuses `DEPENDENTS_EXIST`. **OPEN ITEM: the D6-dependent deletion-inside-restore assertion remains HELD OUT** — see §6. G9 closes with that one item named open; it does not silently ride the §9.8 default. Live form (production committer fences) closes only when the §1 chain executes. |
| **P5-G10** Visibility + audit | **CLOSED (built form)** | PR evidence of record: PR-5 (#42) — queue reads scoped per owner, Log badging, §11.4 export touchpoints. npc-core N11: the §11.4 pure builders (`buildSituationsWorkbook`, `buildNpcRegisterWorkbook`) over bundles mapped from the scenario's **standing** state — in-scope builds stand with exactly the scenario's records; a foreign requester fails closed (throws; no partial file). Banking §7.5 builders: banking-harness legs (PR-6). The A-7-adjacent audit-export interaction (P2-K9 follow-up) is a carried note, §4. |
| **P5-G11** Situations lifecycle | **CLOSED (built form; A-5 PR-evidence half code-evidenced, human capture outstanding)** | CI half (state machine): npc-core walks open → handled (N4 follow-up), open → delegated → awaiting_owner (N5), open → silent (N7), awaiting_owner → handled via the F3 decline payload with its §6.1 outcome verb (N7), blocked-at-boundary rests open (N8); dedupe — the conversion's stamp means repeated wakes never mint a second card (N7); terminal states never exit (asserted by the silence/handled cards' stability across later wakes + the module's `SITUATION_TERMINAL` fences in the situations harness); no notification exists for any non-`major` situation (N7 count assertion). A-5 half: §5.2. |
| **P5-G12** needsAttention conversion | **CLOSED (built form)** | npc-core N7, the countersign's fixture form: two **real** fixture-fund pendings patched to the pre-Phase-5 state (3 attempts, flag set, no Situation) convert exactly once on the first wake; the pendings remain `pending` throughout; handling the converted Situation does **not** clear the flag (P5-K8). The failure-path half (attempts 1–2 create nothing, the flag sets at 3, conversion follows) is sim-core CK7e's, green since PR #41 (its converted card is also what PR-4's fix rounds pinned). Backfill/dedupe idempotence: wake-harness W12. Live form (a wake-created Situation in production) closes only when the §1 chain executes. |
| **P5-G13** Terminology & openness | **CLOSED (built form; A-6 PR-evidence half code-evidenced, human captures outstanding)** | (i) GREP half: title/role/scope are freeform **by construction** — `lib/npcs/types.ts` ("Any title, per CJ's openness rule. No enum, no whitelist"), `requireFreeformString` validation, situation kinds a "bounded string, NOT a closed enum" (`lib/sim/situations.ts`). **One named exception**: `taskType` carries the landed `TASK_TYPES` set in `lib/envelopes/envelopes.ts`, which refuses unknown types at envelope build — this is June's **F1**, carried undecided in §4; the row records the deviation rather than passing it silently. (ii) Engine half: npc-core N10 — the novel-title NPC ("Keeper of the Third Bell", prose scope) creates, validates, is tasked, and resolves end-to-end through the dispatcher; N0 asserts the census (79). (iii) Rendered sweep: §5.3. |

## 4. Carried items — recorded at the gate, NOT solved here

1. **PR-6 F1 (+F2/F3) — named ratification item for Vera/Osei.**
   B-09's `curesFailedPayment` stamp certifies the arithmetic cure
   only; §5.4's coverability half is unverifiable from the handler
   by design (the verifier venue). F2 (B-10's depositor trigger
   refuses a merely-insolvent bank, `bank-not-failed`, its text
   naming the seam) and F3 (K2 episode minting rides the same seam;
   candidate fix recorded in the PR-6 record) ride with it.
2. **PR-6 F4 (recorded).** Pool closing is evaluated only in B-07's
   paths; the assigned-at-zero edge (pool-form B-08 exhausting the
   book; a B-10 with no loans or fully-paid claims) leaves deposits
   `assigned` with `poolUnpaid == 0` and no D2 closing.
3. **June's surfaces flags (PR-5), undecided:** F1 (task-type field
   vs the module's `TASK_TYPES` set — see G13), F2 (one-off persona
   spawns not spawnable as built — `envelope.spawn` requires a
   standing NPC record; engine-side persona spawning is a fabric
   question), F4 (composer cannot prove sitting-mayor authority
   pre-Phase-7), F5 (two design-doc wording drifts), F6
   (`roleTemplate` deliberately unwritten from the surface), F7
   (rule fire-stats read is best-effort; its dot-path index posture
   is confirmed workable by the fire entries this suite produces,
   the surface read itself unchanged), F8 (mandate-editor bounds
   mirror heuristic), F9 (read caps). **June's F3 is NOT carried**:
   PR-4 wired the completing action (`situation.handle` outcome
   "declined") and PR-5 surfaced it; npc-core N7 exercises it.
4. **Pre-built module flags, undecided (PR-review ratification
   items):** Cato's 5 NPC-core flags and Vera's 5 authority flags
   (recorded in `phase5-decisions.md`), and Vera's W3 situations
   flags F1–F8 (assembly adopted none; F3 stands as built).
5. **Engine flags, undecided:** F-E1–F-E7, F-E10. (F-E8 closed at
   PR-4, F-E9 closed at PR-4, F-E11 closed at PR-6.)
6. **NEED-INFO question-Situation linkage** (carried from PR-4):
   a NEED-INFO envelope outcome does not yet mint/link its
   follow-up question Situation in the wake; the linkage is a
   named follow-up (PR-7/W6 line in the assembly plan).
7. **P5-D5** — adopted as built, **flagged for Koda's explicit
   ratification** (rides with PR-2's flag F-E2).
8. **P5-D6 / A-7** — §6 below; the gate's one named open item.
9. **The P2-K15 production chain + the Market §6 operated data
   step** — §1. Not a gate row; a standing, named debt with a
   proposed owner (Rafe, on CJ's authorization).
10. **Dana + Osei's pending audit-export sign-off (P2-K9
    follow-up)** should note the P5-D6 interaction (a restored
    version pointer is exactly the kind of fact an audit export
    must represent content-free) — noted here per the decisions
    record; the sign-off itself is theirs.

## 5. A-3 / A-5 / A-6 — PR-evidence halves, as far as this venue honestly allows

Per the countersign, these halves are **PR evidence, not CI
evidence**. What follows assembles each from the built site's code
paths (June's named capture points, `p5-surfaces-prep-report.md`
§3) and states plainly what is code-evidenced vs what awaits a
human preview pass. **No screenshot or click-through is claimed
that did not happen.** The human captures remain outstanding named
steps after this PR (the Phase 3 precedent: post-merge human
evidence steps are owed and tracked, not silently dropped).

### 5.1 A-3 (P5-G2) — Log → mandate click-through

Code-evidenced:
- The Log page (`app/log/page.tsx`) carries the NPC actor filter
  (§11.1: "every entry an NPC authored, or one NPC's entries",
  lines 80–83, 200–220) and badges NPC attribution
  `` `NPC ${npcId}, for ${onBehalfOfMemberId}` `` (line 64) — the
  "〈name〉, for 〈owner〉" form; `lib/npcs/present.ts:89` builds the
  same badge for the NPC surfaces (`` `${npcName}, for ${ownerName}` ``).
- Entries themselves carry the mandate citation the click resolves:
  npc-core N4 asserts the fire and delegated-action entries cite
  `mandateId` + `mandateVersion`, and the standing verifier walks
  them (G2's CI half).
- The resolution target exists and renders the same hash the suite
  recomputed: `/settings/npcs` renders the current version's
  `mandateHash` (page lines 492–493, full hash in the title
  attribute, 16-char display) and every historical version's hash
  (lines 512–513); `components/sim/SituationCard.tsx` links the
  mandate context to `/settings/npcs` (lines 317, 420).
- The hash equality itself is CI evidence (N2): the value the panel
  displays is the value `computeMandateHash` reproduces from the
  standing version doc.

Outstanding (human preview pass): the literal click-through capture
— open an NPC-authored entry on a deployed preview, follow it to
the mandate panel, and the reverse (version-history entry → the
acts citing that version) — as two captures attached at review.

### 5.2 A-5 (P5-G11) — render halves

Code-evidenced:
- Unknown-kind card: `components/sim/SituationCard.tsx` renders the
  card generically from the situation doc — kind is data on the
  card, not a branch: all three decisions stand on the one
  component (A. "Handle it myself", line 268 ff.; B. Delegate, with
  the handler pick; C. Let it sit, with the silence copy at line
  522). `STARTING_SITUATION_KINDS` is used on `/situations` only as
  a filter facet (page line 721), never as a render gate.
- Silence-copy sweep over the rendered-copy sources
  (`lib/situations/present.ts`, `app/situations/page.tsx`,
  `components/sim/SituationCard.tsx`): the forbidden words
  (ignored / missed / overdue / failed to respond) occur **exactly
  once** — at `lib/situations/present.ts:16`, a code comment NAMING
  them as forbidden (source, not render — precisely as June
  recorded). Zero occurrences in rendered strings. The approved
  copy stands verbatim: `present.ts:134–135` — "No response —
  〈city〉's leader didn't say anything (seq N)."
- The state-layer halves the sweep describes (silence commits,
  terminal stability, notification absence) are CI evidence in
  npc-core N7.

Outstanding (human preview pass): a preview capture of an
unknown-kind card showing all three decisions, and the rendered
Situations surface sweep (Let-it-sit block, History facet line,
empty-queue line) as rendered text.

### 5.3 A-6 (P5-G13) — per-surface terminology sweep

Code-evidenced (grep over the shipped surface sources on this
branch's base — `app/situations`, `app/settings/npcs`, `app/log`,
`lib/situations`, `lib/npcs/present.ts`, `lib/npcs/client.ts`, all
of `components/`): the word "agent" occurs **exactly once** — a
code comment at `components/dashboard/panels/NpcTeamPanel.tsx:20`
stating the rule itself ("Copy says NPC, never \"agent\" (R-20)").
Zero occurrences in rendered copy, on any surface. The badge
builders (§5.1) produce "〈name〉, for 〈owner〉" for the Log and the
NPC surfaces from the same presentational layer the dashboard
digest and Situations delegate picker consume.

Outstanding (human preview pass): per-surface rendered captures
(dashboard, Log, digest, Situations, settings) showing the
terminology and the badge at change prominence, as A-6 enumerates.

## 6. A-7 / P5-D6 — the gate's one named open item

**P5-D6 remains PENDING Koda ratification.** The reading this gate
**recommends** — and does **not** adopt, ride, or assert — is
Petra's recommended reading, recorded in
`workstreams/phase5-decisions.md`: **adopt brief §9.8 as written**:

> (a) inside an undo restore transaction (§8.5 discipline) and
> nowhere else, the fabric restores the mandate/rule root's
> current-version pointer to the pre-resolution value; (b) inside
> that same transaction, the fabric flips the superseded version's
> status back — the version **payload is never edited**, by anyone,
> ever; (c) versions that never became effective (still `pending`)
> are deletable by their author through the ordinary action flow;
> (d) effective versions are deletable by **no** identity outside a
> restore transaction.

Disposition in this PR, exactly as instructed by the countersign's
A-7 and the PR-1 precedent:

- The suite contains **no** D6-dependent assertion. The holdout is
  preserved in `tests/npc-core.test.ts` at N9 as a named comment,
  beside the undo legs that ARE asserted (leaf erasure; cascade
  refusal).
- The rules suite's deletion-inside-restore assertion likewise
  remains held out (PR-1's posture, unchanged by this PR).
- **P5-G9 closes WITH this one named open item.** The gate does not
  silently ride the §9.8 default and does not claim the assertion.
  When Koda ratifies a reading, the assertion is pinned to it in a
  small follow-up PR (suite + rules matrix), and this item closes.

## 7. Regression (local; the emulator suites are CI's venue)

Local, on this branch (sandbox: the Firestore emulator cannot run
here — it rejects its own rules upload; CI is the venue of record
for `rules.test.ts`, `sim-core`, `play-core`, and this suite):

- `npx tsc --noEmit` — clean.
- `npx eslint tests/npc-core.test.ts` — clean (0 errors, 0 warnings).
- `npx next build` — green.
- The full pure battery, chained as in `test:sim` — all PASS:
  cat1, defense, chains, cat2, acq, market, lore, closeout,
  governance, situations, banking, wake harnesses.
- Census spot-check by direct execution: `RULE_DESCRIPTORS` = 79,
  `RESOLVER_RULES_VERSION` = `sim-rules-0.5.0-phase5`.

CI on this PR is the authority: required **Install · Typecheck ·
Lint · Build** + **Rules tests (non-required)** + **Sim core tests
(non-required)** (now incl. npc-core) + Vercel preview.

## 8. PR draft of record

Title: **Phase 5 PR-7 — Gate: npc-core suite + P5-G1–G13 evidence (built form)**

Body: assembled in the PR itself from §1 (A-2 statement), §3 (the
evidence table), §4 (carried items), §5 (A-3/A-5/A-6 dispositions),
and §6 (A-7) of this record, with the README-completion note. The
record and the body are the same text by design; if they ever
diverge, this record governs.

*— Rafe (Muse Eng), Phase 5 Build Lead, 2026-10-21.*
