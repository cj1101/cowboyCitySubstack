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

---

## CI fix round 1 (PR #45) — N2 mandateHash mismatch: SUITE bug, engine untouched

**Result that indicted:** Sim core failed inside npc-core at
`tests/npc-core.test.ts:521` — "mandateHash equality: the standing
version recomputes to its own hash (P5-G2's in-suite half)":
recomputed `fbb085a3f88694eb…` vs stored `ca28282cc2a4214f…`
(Install · Typecheck · Lint · Build, Rules, and Vercel all green;
N0 census and N1 passed before the failure). Log:
`pr45-simcore-log.txt`.

**Root cause — the suite applied the wrong dialect's hash to a raw
stored doc, skipping the projection.** N2 asserted
`computeMandateHash(version)` (lib/authority) over the Firestore-read
version doc. That function's payload is the authority dialect's
projection shape — `{mandateId, version, mode, scope, expiresAtSeq,
horizonActions, createdByUid}` — while a stored version doc
(lib/npcs `SimMandateVersion`) carries `permissionMode`,
`scopeFreeform`, `structuredScope`, `caps`, `ownerUid`, and no
`mandateId` at all. Four of the seven payload fields read as
`undefined` and are dropped by canonical JSON, so the digest the
suite computed was over `{"expiresAtSeq":null,"horizonActions":null,
"version":1}` — a payload containing **none of the mandate's
content**.

**Field-level evidence (pure probe, run locally against the landed
code; suite inputs mirrored through the handler's own builder
path):**
- The probe reproduces CI's "actual" `fbb085a3f88694eb…` **exactly**
  by applying `computeMandateHash` to the raw (round-tripped) stored
  doc — and reproduces it again for a *different* mandate (the
  suite's envoy): under the suite's form the "recomputed" digest is
  mandate-independent, which no real recompute can be.
- The stored-regime recompute — lib/npcs `mandateHash` over
  `MANDATE_HASH_FIELDS` — over the same Firestore-round-tripped doc
  equals the builder's stored hash exactly: the recompute the
  engine performs is round-trip stable.

**Which layer was wrong, and the proof the engine never depended on
the raw form:** every production verification site uses the stored
regime or a projection, never `computeMandateHash` over a stored
doc — `lib/sim/authorityStage.ts` recomputes
`storedMandateHash(versionDoc)` (lib/npcs) for its stored-regime
integrity check and calls `computeMandateHash` only over its own
projection (`projected.mandateHash = computeMandateHash(projected)`);
`lib/sim/verify.ts` recomputes with the same lib/npcs function over
resolved versions; `lib/sim/rules/governance.ts`'s flip path uses
`mandateHash(asVersion(citedDoc))`. A full call-site sweep of
`computeMandateHash(` confirms the suite's line was the **only**
place in the codebase feeding it a raw stored doc (the remaining
sites: the stage's projection, `verifyMandateHash` over dialect
records, and the authority/envelopes harnesses over module-built
records). Cato's golden vectors — the plan-time form — are
untouched and still pin the canonical payload.

**Fix (suite only; no engine file changed):**
`tests/npc-core.test.ts` N2 now asserts the stored-regime recompute
(`mandateHash` from lib/npcs over the read-back doc — the stage's
and verifier's own check), with the dialect seam stated in a comment
at the assertion and in the section header; the unused authority
imports are gone.

**Durable pin (the divergence class cannot regress silently):**
a pure round-trip check — builder object → Firestore-shaped
round-trip (undefined members dropped, Dates back Timestamp-shaped,
`effectiveSeq` stamped) → stored-regime recompute equality — now
stands in both pure venues: `lib/npcs/harness/npc-core-harness.ts`
(beside the golden vectors; 36 → **37 checks**) and
`tests/governance-harness.ts` (the CI-run pure chain, beside the
ruleHash parity pin; 57 → **58 checks**). The fixed N2 assertion is
itself the emulator-venue tripwire: it recomputes over a real
emulator read-back on every PR.

**Sibling sweep — delegationRuleHash (the same class, checked
before N3 could run): CLEAN.** `computeRuleHash`
(lib/sim/delegation.ts) takes an explicit payload object on every
path — the module builder, governance's exact copy
(`computeDelegationRuleHash`), and the suite's N3, which constructs
the payload field-by-field rather than reading a doc. Fire-time
code (`lib/sim/delegation.ts`) carries the stored `ruleHash`
forward and never recomputes over a doc. Parity stays pinned at
`0b37d446…4520` (PR-3) in the governance harness. No other suite
section recomputes a hash over a raw doc (line 1469ff read the
stored hashes into export fixtures; they do not recompute).

**Local regression (fix branch tip):** `tsc --noEmit` clean;
scoped ESLint on the three touched files clean; `next build`
green; pure battery green — npc-core harness 37, authority +
envelopes harnesses all-pass, and the test:sim pure chain at
landed counts (cat1 all, defense 12, chains 34, cat2 34, acq 14,
market 27, lore 27, closeout 29, governance 58 incl. the new pin,
situations 32, banking 54, wake 23). The npc-core suite itself
remains CI's venue — the sandbox emulator still cannot boot
(firebase-tools config-store error, the standing blocker); the
case to watch on re-run is N2 passing and the suite proceeding
through N3–N11 for the first time.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 1, 2026-10-21.*

---

## CI fix round 2 (PR #45) — N4: the trigger touch rejected AUTHORITY_REVOKED; the suite's submission form, not the engine

**Round-2 result:** Install + Rules + Vercel green; Sim core advanced
(sim-core + play-core pass; npc-core N0/N1/**N2**/N3 all ok — the
round-1 dialect fix and the ruleHash parity proof both landed in the
emulator venue). N4 failed at `tests/npc-core.test.ts:726`:
`actionStatus(touch.actionId)` was `rejected`, expected `resolved`.
One correction to the round's framing: line 726 asserts the owner's
**own `situation.handle` touch**, not the delegated action — the touch
was rejected at resolution, so the fire it exists to trigger never
became a candidate. The delegated-action machinery downstream was
never reached and is not indicted.

**Rejection code + stage (pinned by a pure probe, not by a DIAG
round):** `AUTHORITY_REVOKED`, returned by `requireSituationAudience`
(the §9.6 audience gate, `lib/sim/rules/governance.ts`) inside
`situationHandleHandler` — the resolver handler stage, before any
authority-stage or commit machinery. The probe replicated the suite's
exact inputs through the harness materialization discipline (base
paths as seeds → `collectActionReadPlan` → `snapshotFromDocs` →
`resolveAction`), with the card built by the module's own
`buildSituationDoc` from N4's seed inputs and the faction doc exactly
as the suite seeds it:

- **As submitted (targetCityIds `[]`):** the read plan is
  `sim_world/current, sim_counters/log, sim_actions/{id},
  sim_situations/{id}` — **no `factions/` path at all** → rejected
  `AUTHORITY_REVOKED`. The card's `recipientUid` is `null`, so the
  gate's first leg cannot pass; its second leg reads the LIVE faction
  doc (`factions/{audienceCityId}.ownerUids` — current owners, the
  design's deliberate choice over the card's owner snapshot), and
  that doc is not in the snapshot.
- **Production form (targetCityIds `["cityA"]`, all else
  identical):** resolved, exactly one write — the situation doc
  (the §6.3A decision record).

**Why the plan cannot contain the faction in the submitted form —
the F-01 seed contract:** the dispatcher reads the BASE paths first
(`snapshotForAction`: `buildSnapshot(reader, collectActionReadPaths)`
as seeds), then calls the descriptor hook ONCE with those seeds.
`situationReadPlan`'s two-phase loop derives `factions/{cityId}` from
a STORED situation doc *among the seeds* — but the situation doc
enters the plan only via that same hook's first phase (from
`params.situationId`), so it is never a seed unless the action itself
makes it one: via `targetCityIds` (each named city contributes
`factions/{cityId}` as a base path) or via `citations.recordPaths`
(the doc as a base path, after which the loop fires). The resolver
never fetches an undeclared doc mid-resolution; a city-less,
citation-less decision action leaves the gate's faction leg unseeded
and the refusal is the fail-closed posture working as designed.

**Why every other venue passed — the discriminating comparison:**
- *Production client* (`lib/situations/client.ts`,
  `SituationCard.tsx:89/130`): `submitSituationHandle(uid, {…,
  cityId})` with `cityId = situation.audienceCityId ??
  situation.cityId`, submitted as `targetCityIds: [cityId]`. The
  suite's N4 card would carry `["cityA"]` through the real surface.
- *Governance harness* (the one pure venue that runs
  `situation.handle` through the real read-plan path): its
  `memberAction` hardcodes `targetCityIds: ["cityA"]` AND cites the
  situation in `recordPaths` — both lawful routes supplied.
- *Wake harness* delegation checks: they drive the wake PASS step
  resolvers over hand-built snapshots whose fixture map contains the
  faction doc by construction; the pass machinery never routes the
  *trigger* through `collectActionReadPlan` — the trigger as a member
  action is exactly the leg only the suite exercises end-to-end.
- `situation.handle` is the only governance family whose params
  carry no `cityId` (the city lives on the stored card): npc.create /
  mandate.set / delegationRule.set / envelope.* / fixture kinds all
  name a city in params, which `collectActionReadPaths` turns into
  the `factions/{cityId}` base path — which is why N1–N3 passed and
  N4 is the first failure of this class.

**Verdict: FIXTURE authoring (candidate 1) — the suite submitted
the decision in a form no real caller uses.** The engine, the gate,
the read plan, and the handler all behave as designed and as
exercised by the production client and both harnesses. No engine
code changed; the gate was not widened; the suite was not taught to
expect the rejection — it now submits the decision the way the
surface does.

**Fix (suite layer only):** all FOUR `situation.handle` submissions
in the suite now carry `targetCityIds` with the card's city derived
exactly as the client derives it (`audienceCityId ?? cityId`):
- **N4** (the fire touch) — from the seeded `card`; the derivation +
  the seed-contract reason are commented at the site.
- **N5** (the ask-first touch) — **same defect, affected**: its
  touch would have rejected identically and no fire/envelope/claim
  could have occurred. Fixed identically, and the touch's `resolved`
  status is now asserted (it previously went unasserted, so the
  defect would have surfaced one assertion later, misattributed to
  the pass).
- **N7** (the decline of the conversion card) — **same defect,
  affected**: the conversion producer mints its card with
  `recipientUid: null`, `audienceCityId = originCityId` (verified in
  `lib/sim/situations.ts`'s conversion), so the decline's asserted
  `resolved` depended on the same unseeded faction leg. The city is
  derived from the standing card doc.
- **N8** (the revocation-boundary touch) — **same defect,
  affected**, and the least visible: the touch's own status was
  never asserted, but the blocked-fire assertions presuppose its
  committed manifest (the delegation pass's candidates come from the
  wake's manifests). Fixed identically; the touch's `resolved`
  status is now asserted with the reason stated.

**Durable pin (pure venue):** the governance harness gains one check
(58 → **59**): an audience owner's `situation.handle` naming no city
and citing nothing refuses `AUTHORITY_REVOKED` with zero writes —
the seed contract itself, pinned where the read-plan path runs
purely, so the form-A refusal is proven intentional in every CI run
rather than rediscovered per-venue. The fixed N4/N5/N7/N8 submissions
are the emulator-venue tripwires for the production form.

**Local regression (fix branch tip):** `tsc --noEmit` clean; scoped
ESLint on the two touched test files clean; `next build` green; pure
battery green at landed counts (governance **59** incl. the new pin,
situations 32, wake 23, banking 54, closeout 29, chains 34, cat2 34,
cat1 all, defense 12, acq 14, market 27, lore 27). The npc-core suite
remains CI's venue (the sandbox emulator still cannot boot); the
case to watch on re-run is N4 completing the fire end-to-end and the
suite proceeding through N5–N11 for the first time (the round-1
report's watch items N5 same-wake claim parity and N9(b)
DEPENDENTS_EXIST remain ahead of it).

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 2, 2026-10-21.*

---

## CI fix round 3 (PR #45) — INTERIM: diagnosis + DIAG commit (fix contingent on the probe verdict)

Round 2's fix landed (N0–N3 all ok on the re-run; N2's hash check and
N3's ruleHash parity now proven in the emulator venue). N4 then died
on an UNCAUGHT `FirebaseError: No matching allow statements`
(`permission-denied`, no assertion frame) — the suite process exited
inside N4's wake. Round-3 job log: `pr45-simcore-log-r3.txt`.

**What the evidence says before any new code:**

- The error text is the emulator's **query-denial** message. Document
  denials in this project's CI logs carry the verbose evaluation text
  (`false for 'get' @ L…`, `evaluation error at L…` — see the PR #44
  rules log); the terse `No matching allow statements` is what a
  denied `getDocs` returns. Corroborating: the run's uploaded
  `firestore-debug.log` artifact (fetched via the Actions API) shows
  authorizer WARNINGs for the expected document denials earlier in
  the chain and **none at the failure second (06:57:35)** — nothing
  was logged for a document commit denial at that moment.
- Static enumeration of every client-SDK operation N4's wake performs
  that N0–N3's wakes did not: the delegated-action **create** matches
  the rules suite's PR-4 asserted shape field-for-field (the two
  production-only extras — the body's `actionId` field and
  `structuredAction.delegatedVia` — meet no key-enumerating branch);
  the situations/cities/counters/world/manifest writes ride unfenced
  committer branches exercised since N1; the log-entry validator
  (`validNewLogEntry`) never inspects the actor, and
  `npcActorStanding` carries **no** `characterId` (P5-K13's additive
  field lives on the MEMBER form only) — the brief's lead (1) is dead
  in its literal form for both the action doc and its entries.
- The ONE operation with no prior emulator-venue precedent is the
  delegation pass's seed query — `WAKE_RULES_QUERY_ID`:
  `sim_delegation_rules where cityId == "cityA"`, executed by
  `firestoreQueryReader` over the committer DB. That collection's
  read rule is the only one among everything the engine queries whose
  sibling branches call `get()` on resource-derived paths
  (`ownsListedCity(resource.data.cityId)` → `exists`/`get` on
  `faction_members`/`factions` keyed by a field the query does not
  constrain) — the classic emulator query-authorization poison: the
  Datastore emulator's authorizer cannot prove the query from the
  combined expression even though the first disjunct
  (`isFabricService()`) is auth-only and true. Every previously
  exercised engine query runs against rules whose read branches are
  auth-only or viewer-only (`sim_actions`, `sim_npcs`,
  `sim_pending_consequences`, `sim_task_envelopes`) and passes.

**DIAG commit (`521a762`, throwaway — removed with the fix):**
read-only probes inserted between N3 and N4, catch-and-log, suite
proceeds to the real failure: **Q1** the suspect query as fabricSvc;
**Q2** control — `sim_npcs where cityId` as fabricSvc (known-good
pattern); **Q3** control — `sim_delegation_rules where ownerUid` as
ownerA (the member-side query on the same collection); **Q4** control
— `sim_situations where audienceCityId` as fabricSvc (the other
`ownsListedCity`-bearing read rule, fabric-first). Plus stage markers
bracketing N4's card seed and its touch+wake. Local regression for
the DIAG commit: `tsc --noEmit` clean, scoped ESLint clean (the
emulator suites remain CI's venue).

**Contingent fix (lands when the probes convict Q1):** the rules
layer, semantics-identical — split `sim_delegation_rules`' read into
two allow statements (the fabric/admin statement, resource-free and
independently query-provable; the member statement unchanged), so
the authorized (identity, doc) set is exactly today's while the
fabric query is provable in the emulator's per-statement query
check. Plus rules-suite assertions: the fabric cityId query succeeds
and returns both cityA rules; a member's ownerUid query succeeds; a
non-author member's cityId query still fails (no widening). Sibling
flag for the record, NOT touched this round: `sim_situations`' read
rule carries the same combined pattern, but no fabric/engine path
queries that collection (doc gets + member UI queries only), so it
is out of this round's indictment. If Q1 instead ALLOWS, the next
round bisects inside `executeDelegatedAction`/`commitStep` with
labeled catches; the stage markers bound that search.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 3 (interim), 2026-10-21.*

---

## CI fix round 4 (PR #45) — INTERIM: round-3 hypothesis REFUTED; full census + bisection DIAG

**Verdict on round 3, recorded plainly: the seed-query hypothesis is
DEAD.** The CI run on `005bf42` printed all four round-3 probes
ALLOWED — **Q1** `sim_delegation_rules where cityId==cityA` as
fabricSvc: **ALLOWED (size 2)**; Q2 `sim_npcs` control ALLOWED (size
2); Q3 member-side `ownerUid` control ALLOWED (size 2); Q4
`sim_situations` control ALLOWED (size 0) — and after the stage
markers ("card seeded; submitting the owner's touch + wake") the
suite died on the same uncaught `FirebaseError: No matching allow
statements`, exactly as before. The contingent rules split from the
round-3 note is **NOT applied** and is withdrawn: the delegation
seed query was never the failing operation. The round-3 note's
sibling-pattern reasoning was sound as a suspicion and wrong as a
conviction — the probes did their job.

**Round 4 (this note's commit pair: DIAG `3fab1df` + this note)** is
the round-3 note's recorded fallback, extended to a full census
plus in-situ bisection, in one DIAG round. No fix is pre-applied;
the fix lands in round 5 on this round's prints.

### Prong A — the full query census (suite-side, between N3 and N4)

Every query the N4 touch + wake cycle performs, replicated
standalone as the identity the wake uses (the suite's `committerFs`
— the fabricSvc context with `fabricRole: committer`, which `deps()`
hands to BOTH `fabricDb` and `committerDb`), against the standing
world right before N4's wake. Round-3 Q1–Q4 are removed; Q1 is
folded into the census as `delegation_rules-cityId`. Each probe
prints `DIAG Q-<label>: ALLOWED (size n) / DENIED (code) message`.

| Census label | Operation (performing call site) | First emulator-venue precedent | Read-rule pattern |
|---|---|---|---|
| `actions-status-confirmed` | `sim_actions where status=="confirmed" orderBy createdAt limit 10` (dispatcher `runWake`, fabricDb) | Phase 2 sim-core; N1–N3 wakes here | combined: auth-only fabric disjunct + resource-derived member branches (`actor.memberId`, `audienceUids`) |
| `undo_operations-status-in` | `sim_undo_operations where status in (requested, checking) orderBy createdAt limit 10` (dispatcher) | Phase 2 sim-core; N1–N3 wakes | combined: fabric disjunct + `requesterUid` member branch |
| `pending_consequences-status-pending` | `sim_pending_consequences where status=="pending" orderBy createdAtSeq, pendingId limit 25` (`scanRipeness` candidates) | Phase 2 sim-core; N1–N3 wakes | combined: fabric disjunct + `audienceUids` member branch |
| `pending_consequences-status-ripening-claimed` | `sim_pending_consequences where status=="ripening-claimed" limit 25` (`scanRipeness`) | same | same |
| `pending_consequences-needsAttention` | `sim_pending_consequences where needsAttention==true limit 25` (attention pass) | PR-4 sim-core; N1–N3 wakes (pass runs every wake) | same |
| `task_envelopes-status-QUEUED` / `-RUNNING` | `sim_task_envelopes where status==… limit 50` (claim pass) | PR-4 sim-core; N1–N3 wakes | fabric disjunct + `envelopeReadable(resource.data)` resource-derived |
| `delegation_rules-cityId` | `sim_delegation_rules where cityId=="cityA"` (`WAKE_RULES_QUERY_ID`, delegation/silence step seed queries) | FIRST candidate-bearing step is N4 — but standalone-probed ALLOWED in round 3 | fabric/admin disjuncts + author + `ownsListedCity(resource.data.cityId)` (get()-on-resource-path branches) |
| `log_entries-actor.mandateId` | `sim_log_entries where actor.mandateId=="mand-steward-1"` (`NPC_PERIOD_QUERY_ID`, authority-stage read plan in `collectActionReadPlan`) | **NONE — first npc-actor materialization in any emulator suite** (the N4 delegated action; N1–N3 actors are members) | fabric disjunct + viewer branch dereferencing `resource.data.actor.memberId` — the member branch keys on `actor.memberId`; the query filters `actor.mandateId`, a field NO branch references |
| `log_entries-recent` | `sim_log_entries orderBy seq desc limit 30` (snapshot refresh `listRecentEntries`, LATEST_SUMMARIES_CAP×3) | Phase 3 sim-core; every world-changing wake — but the refresh is failure-isolated (never throws) | same rule as above |
| `log_entries-headline-cityA` | `sim_log_entries where cityIds array-contains cityA, visibility=="public" orderBy seq desc limit 1` (refresh `getCityHeadlineEntry` per faction) | same, failure-isolated | same |
| `factions-scan` | `factions` full-collection getDocs (refresh `listFactions`) | same, failure-isolated | `isMember()` only — auth-only, no resource reference |
| `sim_cities-scan` | `sim_cities` full-collection getDocs (refresh `listSimCities`) | same, failure-isolated | `isViewer()` — auth-only |

GET census (the materialization read sets — doc reads no query
probe can see; each prints `DIAG Q-<label>: ALLOWED (exists b) /
DENIED …`):

| Census label | Path | Read-rule pattern |
|---|---|---|
| `world-get-current` | `sim_world/current` | `isViewer() && docId=='current'` (viewer-gated singleton; fabric user record seeded — PR #44 precedent) |
| `counters-get-log` | `sim_counters/log` | `isAdmin() \|\| isFabricService()` — auth-only |
| `factions-get-cityA` | `factions/cityA` | `isMember()` — auth-only |
| `sim_cities-get-cityA` | `sim_cities/cityA` | `isViewer()` |
| `npcs-get-charA2` | `sim_npcs/charA2` | `isViewer()` |
| `teams-get-cityA` | `sim_teams/cityA` | `isViewer()` |
| `mandates-get-mand-steward-1` (+`-v1`) | `sim_mandates/mand-steward-1`, `…/versions/1` | `isViewer()` both |
| **`terms-get-current`** | **`sim_terms/current`** | **NO MATCH BLOCK EXISTS. `firestore.rules` contains no `sim_terms` rule at all (grep-verified) — there is no allow statement any identity can match, for a get or a query. The authority stage's read plan adds `TERMS_PATH` for EVERY npc-actor action (`collectNpcStageReadPlan`), and the design's own posture (dashboard registry comment; the stage's absence handling at `authorityStage.ts:582`) is that no `sim_terms` record stands until Phase 7 — the read is expected to return absent, but a rules-denied get is not an absent doc: it throws. First npc-actor materialization in the venue is N4's delegated action.** |
| `situations-get-absent` | `sim_situations/diag-absent` (posture probe, absent doc) | fabric disjunct + recipient/`ownsListedCity` branches |
| `actions-get-absent` | `sim_actions/diag-absent` | fabric disjunct + resource-derived member branches |
| `resolutions-get-absent` | `sim_resolutions/diag-absent` | `isAdmin() \|\| isFabricService()` — auth-only |

Not performed in N4 (censused as absent, for completeness): the
ripening read queries (`collectRipeningReadQueries` — no candidate
ripens; the fixture pendings arrive in N7); descriptor queries of
other kinds (`NPC_ROSTER_QUERY_ID` rode N1's npc.create plans, not
N4's kinds — `situationReadPlan` declares paths only and
FIXTURE-ADJUST has no `readPlan`); direct `users` reads (none — the
rules helpers' `get()` calls are rules-internal, not client ops).

### Prong B — labeled bisection inside the wake (lib-side, print-and-rethrow)

If the census all-alloweds, the failing op names itself in situ:

- **The materialization funnel** (`lib/sim/resolver.ts`,
  `buildSnapshot`/`materializeSnapshot`): every plan doc-get and
  collection query the resolver executes prints, on denial,
  `DIAG STEP materialize: DENIED get <path>` or
  `DIAG STEP materialize: DENIED query <spec.id> <collectionPath>
  <filters>`, then rethrows. This funnel serves the dispatcher's
  action snapshots, every wake-step materialization, and the
  delegated action's `snapshotForActionLike`.
- **Step labels** (`diagStep`, print + rethrow, in
  `lib/sim/dispatcher.ts` and `lib/sim/wakePasses.ts`):
  `dispatcher.actions-query`, `dispatcher.scan`,
  `dispatcher.undo-query`, `dispatcher.passes`;
  `passes.attention-query`, `passes.claims-query-QUEUED`,
  `passes.claims-query-RUNNING`,
  `passes.attention-readback-materialize`,
  `passes.delegation-materialize`, `passes.trigger-materialize`,
  `commitStep-<kind>-materialize` (every step kind);
  `delegatedAction.npc-get`, `delegatedAction.existing-get`,
  `delegatedAction.create`, `delegatedAction.snapshot`,
  `delegatedAction.preview-update`, `delegatedAction.claim-tx`.
  (commitResolution's own errors stay on their existing caught
  paths — a denial there surfaces as a step/action outcome, not the
  uncaught death; the two commit call sites therefore carry no
  label.) The suite's N4 stage markers from round 3 stay in place
  to bound the prints.

**What to read on the CI re-run:** (1) the census lines after
`ok N3` — any `DENIED` there is a standalone conviction; (2) the
first `DIAG STEP … DENIED` line inside N4 — the funnel line names
the exact path/spec, the enclosing step label names the call site.
**Expected signature if the census's one rule-less collection is the
culprit:** `Q-terms-get-current: DENIED` in the census, then
`DIAG STEP materialize: DENIED get sim_terms/current` wrapped by
`DIAG STEP delegatedAction.snapshot: DENIED` during N4's wake, and
the suite dies as before. If instead the census all-alloweds and a
query-spec funnel line fires, the conviction is that spec. If NO
DIAG line prints before the death, the operation sits outside the
wrapped set (in-transaction reads are the named remainder — the
committer's tx.get set is doc gets over already-probed paths plus
the manifest get, all posture-probed above).

Local regression for the DIAG commit (`3fab1df`): `tsc --noEmit`
clean; scoped ESLint clean on all four touched files; full pure
battery green at landed counts (governance 59, banking 54,
situations 32, wake 23, closeout 29, chains 34, cat2 34, cat1 all,
defense 12, acq 14, market 27, lore 27; npc-core harness 37;
authority + envelopes harnesses all-pass); `next build` green. The
suite's assertions are untouched; all DIAG code is catch-log-rethrow
or catch-log only. The fix lands in round 5 on these prints — the
leading candidate fix, stated now so round 5 can move directly: a
`sim_terms` rules block matching the design's Phase 7 posture (the
record does not stand yet; the committer/fabric read the stage
needs, members none until the office exists) plus rules-suite
assertions — but round 5 follows the prints, not this paragraph.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 4 (interim), 2026-10-21.*

## CI fix round 5 (PR #45) — sim_terms rules block lands; all DIAG removed

**Root cause (final, convicted on the round-4 census):** `firestore.rules`
carried NO `sim_terms` match block at all. The authority stage's read plan
(`collectNpcStageReadPlan`, `lib/sim/authorityStage.ts`) adds
`TERMS_PATH = sim_terms/current` for EVERY NPC-actor action, and the stage
handles the record's absence from the snapshot by design — no term record
stands until the Phase 7 election act (Phase 5 brief line 35: "No term
records are created by this phase"). But a rules-denied get is not an
absent doc: with no allow statement it throws `permission-denied` ("No
matching allow statements"), for the production fabric identity exactly as
for the suite. CI evidence (run on `0db1660`, log
`pr45-simcore-log-r4diag.txt`): the census of 25 operations printed 24
ALLOWED and exactly ONE denied — `Q-terms-get-current: DENIED` — and the
bisection funnel named it in situ: `DIAG STEP materialize: DENIED get
sim_terms/current` ← `delegatedAction.snapshot: DENIED` ←
`dispatcher.passes: DENIED`. N4's delegated action was the first NPC-actor
materialization in any emulator suite (N1–N3 actors are members), which is
why the seam was unreachable in every earlier venue. This is an
engine/rules seam fix, not a suite fix: no test was changed to
accommodate it, and no engine code changed.

**The block, and its posture (design citation).** Dana's
backend-architecture §3.2 specifies `sim_terms/{termId}` (fields `cityId`,
`mayorUid`, `viceMayorUid`, `startedSeq`, `endedSeq | null`,
`sourceActionId`, `status: "current" | "closed"`) with the posture stated
verbatim: "**Reads:** members and guests. **Writes:** fabric committer only
through R-22/close-season actions." §A.3 + the election design add that
certification is one Resolution Event resolved by the fabric, closing the
outgoing record and opening the new one atomically — i.e. the design DOES
name a committer write posture, and this block implements exactly it:

```
match /sim_terms/{termId} {
  allow read: if isViewer();
  allow create, update: if isFabricCommitter();
  allow delete: if false;
}
```

- Read `isViewer()` is the rules dialect's "members and guests" (the same
  translation `sim_world/current` carries). It covers the fabric
  identities the stage runs as: in the engine's operating model the fabric
  service user holds a `users` record and satisfies `isViewer()` — the
  PR #44 lesson, seeded in both suites' fixtures and proven by the census
  itself (the viewer-gated `sim_world` get was ALLOWED as fabricSvc). No
  separate fabric disjunct was needed, and none was added.
- Write committer-only, through the Phase 7 R-22 actions when they land.
  No landed Phase 5 code path writes `sim_terms` (grep: the stage reads
  it; nothing else in `lib/` references it as a write), so carrying the
  branch now stands no record up early — the same posture `sim_world`'s
  committer branch carried from Phase 2, before genesis.
- Delete denied to everyone: term records are historical (a closed term
  persists on the record series), matching the three sibling core-state
  singletons (`sim_world`, `sim_counters`, `sim_fabric_status`), and the
  election design's undo posture for certifications (undo-locked,
  cascaded) gives no delete path.
- One divergence from round 4's interim sketch, recorded plainly: the
  sketch guessed "members none until the office exists" for reads. The
  design text found at fix time says members AND guests — the block
  follows the design, and the sketch is superseded.

**Rules-suite assertions added** (tests/rules.test.ts, "ok sim terms
posture"): fabric committer AND fabric worker gets on the ABSENT
`sim_terms/current` succeed (the absence posture the stage depends on);
guest + member gets succeed; anon + suspended gets fail; member and
fabric-worker creates fail; committer create (Dana §3.2 shape) and update
succeed; member update fails; delete fails for member AND committer. The
Rules suite is CI's venue for execution; the block + assertions are
written to run to its final ok line.

**DIAG removal (grep proof).** Round 3's probes (`521a762`) and round 4's
census + bisection labels (`3fab1df`) are reverted wholesale. The four
touched files — `lib/sim/resolver.ts`, `lib/sim/dispatcher.ts`,
`lib/sim/wakePasses.ts`, `tests/npc-core.test.ts` — are verified
BYTE-IDENTICAL to their pre-DIAG state at `f9686af` (`git diff f9686af`
over those paths: empty), so rounds 1–2's suite fixes stand exactly as
written and no assertion was touched by the removal. Tree-wide grep over
`lib/ tests/ app/ components/` for `DIAG`: **0 occurrences**.

**Completeness sweep** — every collection the engine reads or writes
(grep of read plans, query specs, path constants, and committer write
paths across `lib/sim`, `lib/npcs`, `lib/authority`, `lib/envelopes`,
`lib/finance`) vs `firestore.rules` match blocks:

| Engine-touched collection | Rules block | Verdict |
|---|---|---|
| sim_terms | **was MISSING** | FIXED this round (the convicted gap) |
| sim_actions, sim_resolutions, sim_log_entries, sim_counters, sim_world, sim_cities (+ structures/households/figures/corporations/laws/budgets/funds/projects subcollections), sim_stat_allocations (+ versions), sim_pending_consequences, sim_undo_operations, sim_publications, sim_intel_records, sim_cases, sim_collection_means, sim_collection_posture, sim_verification_adoptions, sim_wiki_entry_drafts, sim_member_accounts, sim_bank_deposits, sim_bank_loans, sim_deposit_insurance_fund, sim_market_account, sim_market_listings, sim_market_orders, sim_market_trades, sim_holdings, sim_npcs, sim_teams, sim_mandates (+ versions), sim_task_envelopes, sim_task_outputs, sim_situations, sim_delegation_rules (+ versions), factions, characters, wiki_entries | present | covered — every one exercised green in CI across Phases 2–5 or in the round-4 census |
| sim_seasons | MISSING | **Named finding, NOT fixed:** zero references anywhere in this repo's `lib/ app/ components/ scripts/` — Dana §3.2's other half stands up only with Phase 7 close-season actions. Same missing-block class, unreachable by any landed code path. Phase 7 must land its block with its first read/write path, the way this round did for terms. |
| sim_elections (+ ballots subcollection) | MISSING | **Named finding, NOT fixed:** same posture — the election engine lives in its own clone for Phase 7; nothing in this repo references the collection. Phase 7 carries the same obligation. |

`sim_terms` was the only REACHABLE gap of the class.

**Local regression (assembled branch tip):** `tsc --noEmit` clean ·
scoped ESLint on the five touched files 0 errors (one pre-existing
`_dropped` warning in tests/rules.test.ts, untouched region, carried since
PR #44) · full pure battery green at landed counts (cat1 all, defense 12,
chains 34, cat2 34, acq 14, market 27, lore 27, closeout 29, governance
59, situations 32, banking 54, wake 23; npc-core harness 37, authority +
envelopes harnesses all-pass) · `next build` green. The emulator suites
(Rules incl. the new terms block; npc-core N4→N11 running for the first
time) are CI's venue on this push. Remaining known watch items, unchanged
from the gate build: N5 same-wake claim parity, N7 trigger candidacy,
N9(b) `DEPENDENTS_EXIST`.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 5, 2026-10-21.*

## CI fix round 6 (PR #45) — N4: the executor built the delegated action without its §3.2 trigger citation; the stage refused it NO_TRIGGER_ROOT

**Post-wake state evidence (what the wake actually did, before any
theory).** The round-5 CI log (`pr45-simcore-log-r5.txt`) shows the
assertion BEFORE :751 passing: `passes.delegation.fired` contains
`{ situationId: fireSituationId, kind: "delegated-action" }` — the
rule fired in the touch's own wake, off the REAL dispatcher manifest.
The wake returned a summary (no throw — the terms fix holds), and the
delegated action was created and committed, but its summary record
was outcome `"rejected"`, not `"resolved"`: :751's
`passes.delegatedActions.some(d => d.actionId === fireActionId &&
d.outcome === "resolved")` is `false`. The card therefore never
completed through a resolved action (a rejected delegated action's
follow-up returns the card to its owner). Discrimination against the
assignment's three seams: **(a) candidacy is REFUTED by CI itself** —
the collector and the real `situation.handle` manifest agree; the
pure venues' hand-built manifests were not the gap. **(b) matcher
inputs are lawful** — the probe below shows the stage's checks 1–4
(identity, ownership, mandate currency, mode, scope/caps) and the
fairness fence ALL passing on the suite's exact fixtures. **(c)
execution shape is CONVICTED.**

**Root cause (probe-convicted, pure venue).** `executeDelegatedAction`
(`lib/sim/wakePasses.ts`) built the delegated action's
`structuredAction` with `delegatedVia` only — no `trigger` field —
and the NPC standing actor carries `envelopeId: null`. So
`entryTriggerOf` (`lib/sim/authorityStage.ts`) returns null,
`authorityTriggerOf` finds neither a rooted entry trigger nor
`ownerConfirmedDelegated`, and `evaluateDelegatedAction` check 5
(`lib/authority/evaluate.ts`) rejects: **NO_TRIGGER_ROOT** — "nothing
in the committed world asked for this act (causality rule)". A pure
tsx probe rebuilt the action field-for-field as the executor builds
it, over standing docs mirroring N4's world (steward charA2,
mand-steward-1 v1 built with the real `buildMandateVersion` from the
suite's own N2 inputs, cityA treasury 1,000,000), and ran the real
pipeline (`collectActionReadPaths/Plan` → `snapshotFromDocs` →
`resolveAction`, commit mode): stage verdict **reject
NO_TRIGGER_ROOT** with checks 1–4 + fairness passing and check 5
failing; plan rejected, no writes. The same action with the §3.2
citation stamped — `{ kind: "situation", sourceId: situationId,
sourceSeq: the card's createdSeq, deliberation: null }` — verdict
**resolve**, plan resolved, summary classification carrying exactly
the `{mandate, trigger}` stamps of Vera's §3.2 vocabulary. This is
an ENGINE bug, production-shaped: in production every act-for-me
delegation fire (and every standing-team act, same construction)
would have committed as a NO_TRIGGER_ROOT rejection while the touch
itself resolved — a silent no-op rule engine. Why no earlier venue
caught it: the governance harness hand-authors every NPC action WITH
a trigger (its `TRIGGER` constant), the wake harness drives only the
pure step resolvers and never the DB-bound executor construction,
and this gate suite is the first end-to-end exercise of that
construction. Completeness: `executeDelegatedAction` is the only
`lib/` construction site of a resolved NPC mandate action
(wakeSteps' `stageMandateVersionRecord` action is projection-only
and never resolved).

**The fix (engine layer, one construction site).** The construction
moved verbatim into a pure exported builder,
`buildDelegatedActionDoc` in `lib/sim/wakeSteps.ts` (beside
`delegatedActionId`), which stamps the citation; the executor now
(1) reads the card doc for its `createdSeq` — an unreadable card
defers, the same posture as an unreadable NPC — and (2) persists
the builder's output. Citation design: kind `"situation"` is the
mandate's contemplated trigger kind (the steward's `triggerKinds:
["situation"]`) and §3.2's vocabulary for exactly this route;
`sourceSeq` is the card's `createdSeq`, defined in
`lib/sim/situations.ts` as the creating event's summary seq — the
committed record that asked for the act, always < the action's own
seq. A null `createdSeq` stamps as null and the stage's fail-closed
verdict governs; the citation is never fabricated from the wake's
position. `ownerConfirmedDelegated` was NOT used: it maps to
authority kind `"delegated-action"`, outside the steward's
contemplated kinds (it would escalate, not resolve), and belongs to
owner-direct tasking (P5-K4).

**Second defect, same scenario (suite fixture layer).** The probe's
resolved run also printed the city write: treasury
1,000,000 → **1,000**. `fixture_adjust` writes are absolute and
clamped to [0, 1000] (the FIXTURE-ADJUST handler, Phase 2's fixture
contract) — N4's expectation `treasuryBefore + 5000` was
arithmetically unreachable from any standing value, the
fixture-economy lesson's sixth bite. The suite's card spec now
adjusts `stats.infrastructure` (+5 from a standing 50, inside the
clamp) and asserts `infrastructureBefore + 5`, with the derivation
stated in the scenario header (sim-core CK6's discipline). The
handler's clamp is untouched — sim-core's expectations derive from
it across the suite. No gate-relevant assertion changed: fire,
mandate citation, exactly-once landing, traceability, and the
verifier all stand as written.

**Durable pin (same joint).** W24 in `tests/wake-harness.ts`
(23 → 24 checks): builds standing docs, takes the card's spec
through the real `readSituationActionSpec`, constructs the action
with the REAL `buildDelegatedActionDoc`, and runs the real resolver
— asserts the citation's shape (kind/sourceId/sourceSeq = the
card's createdSeq), plan resolved, the summary classification
carrying the §3.2 trigger stamp, and the act landing (infrastructure
50 → 55). Falsifiability half: the identical action with the
citation stripped rejects `NO_TRIGGER_ROOT`. The harness no longer
hand-authors what the engine is responsible for stamping.

**Sibling disposition.** **N5 (ask-first fire): NOT affected** — an
ask-first handler routes to an envelope; `executeDelegatedAction`
is never called, and N5's touch already shares the round-2
production form. **N8 (revocation): NOT affected** — the
post-revocation fire blocks at evaluation
(blocked-handler-authority-changed) upstream of execution; its card
spec never runs, so the clamp is moot there as well. **Trigger pass
(`via: "trigger"`): SAME root cause, same fix** — it shares the one
construction site, so standing-team acts carried the identical
defect; the suite exercises trigger postures as draft/silence only
(N7), so that caller's end-to-end act path is pinned at the builder
joint by W24 (route-independent: `via` is an input), not by a
second emulator scenario.

**Local regression (branch tip after this round):** `tsc --noEmit`
clean · scoped ESLint on the four touched files
(`lib/sim/wakeSteps.ts`, `lib/sim/wakePasses.ts`,
`tests/wake-harness.ts`, `tests/npc-core.test.ts`) 0 errors · full
pure battery green (governance 59, situations 32, banking 54, wake
**24** incl. W24, acq 14, cat1 all, cat2 34, chains 34, closeout 29,
defense 12, lore 27, market 27; npc-core harness 37) · `next build`
green. The diagnosis probe lived in the clone's `tmp/` and was
deleted after conviction — no DIAG entered the tree this round,
and no test was weakened: the suite's only changes are the N4 card
spec/expectation (clamp-derived, above) — the :751 assertion stands
exactly as written. Emulator suites are CI's venue on this push;
watch items for the run: N4 runs through (fire → resolved →
follow-up → handled, verifier over the trigger-stamped entries);
N5 same-wake claim parity, N7 trigger candidacy, N9(b)
`DEPENDENTS_EXIST` unchanged from the gate build.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 6, 2026-10-21.*

---

## CI fix round 7 (PR #45) — N4 attribution: the fire entry's mandate citation

**The failure.** Round 6's engine fix held: the :751 assertion (the
delegated action resolved in the same wake) passed, and the suite
advanced to `tests/npc-core.test.ts:803` — `strictEqual` actual
**null** vs expected **`'mand-steward-1'`**. The field is the
delegation-fire Log entry's **`actor.mandateId`** (the entry the
suite finds by `classification.delegationFire === true`), following
P5-G2's traceability requirement: every NPC-attributed entry cites
the mandate in force.

**Diagnosis — the seam is the evaluator's adoption gate, not the
stage and not the executor.** The suite's rule-fire-1 authors its
handler `{ npcId: "charA2", mode: "act-for-me", mandateId: null }`
— a lawful shape (brief §7.1: `handler.mandateId: string | null`;
the composer and the governance fences alike admit an uncited
handler, meaning "the handler NPC's standing mandate").
`buildRuleFireEntry` (lib/sim/delegation.ts) builds the entry's
actor from `DelegationFire.mandateId/mandateVersion`, and
`evaluateDelegation` composed that pair from the rule alone: its
local `mandateVersion` was adopted from the authority view **only
when the rule cited a mandate**, and `fire.mandateId` was
`rule.handler.mandateId` verbatim — null here, version null with it.
The production authority view had already resolved the standing
mandate: `handlerAuthorityView` (wakeSteps.ts) implements the
§6.3B cited-or-standing doctrine (`rule.handler.mandateId ??
npc.currentMandateId`) and returns mand-steward-1's root + current
version as `authority.mandate`. The evaluator dropped that
resolution on the floor for uncited rules. Two consequences beyond
the citation itself: `resolveDelegationAuthority` ran with
`mandateVersion: null`, so the standing mandate's mode and caps
never entered the §7.3 narrower-of for an uncited fire (brief §7.2
step 4: "**the handler's mandate** caps and Tier B escalation
override every rule" — the handler's mandate, cited or standing;
in the suite's world the mode coincided and the amount was null,
so routing was unaffected — the citation was the visible half).

The neighbouring paths do the resolution the fire path omitted:
`executeDelegatedAction` fills the delegated ACTION's actor via
`input.mandateId ?? npc.currentMandateId` before
`buildDelegatedActionDoc` (which is why the action resolved and
its records cite mand-steward-1), and the authority stage stamps
its `{mandate, trigger}` classification from its own verified
verdict citation. The stage never sees the fire entry — no stage
fix was available or needed; the round-6 construction site stands
as built. The suite's expectation is the design's (brief §3:
exactly one authority root per NPC entry; §7.1 as carried in the
view's own doc: "the Log cites rule id/version and mandate
id/version"; situations harness S6d pins the same completeness for
cited rules) — no suite change.

**Verifier disposition — no tolerance exists, and none was
relying on it.** `verify.ts` runs `validateNpcActorForm` over
EVERY standing NPC entry before traceability (a)/(b)/(c): the
pre-fix fire entry's actor (mandateId null, mandateVersion null,
envelopeId null) is an orphan — "actor cites NO authority root" →
`NPC_ACTOR_FORM`, and the entry is skipped for the remaining
checks. Traceability (b)'s `mandateId !== null && mandateVersion
!== null` guard is never reached for such an entry, so the null
was not an absent≡null case (that doctrine governs P5-K13's
`characterId` key form, not an authority root's presence): in
production the standing Log FAILS verification on every
uncited-handler fire entry. Ordering in-suite: N4's `verifyOk()`
is the section's last step, after :803, so CI never got to print
it — the finding was queued behind the assertion, not absent.

**Why no pure venue caught it.** Every fire fixture in the pure
venues CITES its mandate: the wake harness's `ruleDoc` handler
carries `mandateId: "mandate1"`, the situations harness's `rule()`
carries `"mand-1"`, and W1 asserts the fire entry's classification
and the transition but never its actor. The gate suite's
rule-fire-1 is the first uncited-handler fire exercised end-to-end
anywhere.

**The fix (engine, lib/sim/delegation.ts + the view's one
producer).** `evaluateDelegation` now adopts the view's resolved
mandate for uncited handlers exactly as for cited ones:
`effectiveMandateId` (cited id, else the view's standing id) feeds
the fire, its envelope spec, and its structured intent; the
adopted version feeds the narrower-of. A standing mandate that
does not resolve, is not active, or belongs to another NPC/city
blocks the fire (`blocked-handler-authority-changed`, §7.2 —
mirroring the cited branch's checks verbatim); an NPC holding no
standing mandate at all blocks likewise, instead of composing a
rootless fire. The cited branch is byte-for-byte unchanged in
behavior (S6g's revoked-cited-mandate block stands). To carry the
id, `HandlerAuthorityView.mandate` gains `mandateId` — the
production producer (`handlerAuthorityView`) already computed it
and now returns it; its doc comment in delegation.ts is corrected
from "the cited mandate" to the landed cited-or-standing
doctrine. Blast radius, all deliberate: `recordDelegation` now
writes the standing pair onto the card's `handling` (brief §6.2's
handling shape carries both fields); the §8 silence commit
receives the adopted pair for uncited silent rules (the same
orphan-actor exposure, closed by the same adoption);
`composeFirePlan`'s envelope staging now stages the mandate
version record for uncited envelope fires, aligning them with the
cited path. Sibling rules in the suite: rule-ask-1 (N5) is also
uncited — its fire entry and envelope record now cite
mand-envoy-1; N8's revocation scenario is served by the new
standing-branch block (post-revocation, the view resolves no
standing mandate → blocked at evaluation, as its spec requires).

**The pin (same joint, W24 extended in place — count stays 24).**
W24's first half now also asserts the stage's
`classification.mandate` stamp (`{mandateId, mandateVersion, mode}`)
beside the trigger on the delegated action's summary. Its new
second half drives the REAL step (`evaluateDelegationStep`, hence
the real `handlerAuthorityView` + evaluator + fire composition)
over an uncited rule and asserts the citation on all three records
the suite reads — `fire.mandateId/mandateVersion`, the fire
entry's actor pair with `validateNpcActorForm(actor).ok === true`
(the verifier's own form gate), and the card transition's
`handling` pair — with the plan validated by the real
`validatePlan`. Falsifiability half: the same uncited rule with
the standing mandate revoked blocks at evaluation
(`blocked-handler-authority-changed`, reason /no standing
mandate/), composes no fire entry, and writes no transition.
Situations-harness fixtures gained the view's new `mandateId`
field at its three literal sites (defaults `"mand-1"`, S6g's
`"mand-dead"`); no harness expectation changed.

**Local regression (branch tip after this round):** `tsc --noEmit`
clean · scoped ESLint on the four touched files
(`lib/sim/delegation.ts`, `lib/sim/wakeSteps.ts`,
`tests/wake-harness.ts`, `tests/situations-harness.ts`) 0 errors ·
full pure battery green at landed counts (governance 59,
situations 32, banking 54, wake **24** incl. the extended W24,
closeout 29, chains 34, cat2 34, cat1 all, defense 12, acq 14,
market 27, lore 27; npc-core harness 37, authority + envelopes
harnesses all-pass) · `next build` green. No suite assertion was
touched this round. Emulator suites are CI's venue on this push;
watch items for the run: N4 completes through `verifyOk()` over
the fire entry for the first time; then N5 (now citation-bearing),
N7 trigger candidacy, N9(b) `DEPENDENTS_EXIST` as before.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 7, 2026-10-21.*

---

## PR #45 CI fix round 8 — §3.2 trigger citation missing on standing NPC entries

**Evidence (round-7 run, remote head `8efa9c2`).** Install + Rules +
Vercel GREEN. Sim core: N0–N3 pass; N4 passes :751 (round 6) AND
:803 (round 7); the stop is N4's `verifyOk()`
(`tests/npc-core.test.ts:312`, invoked at :825): the standing
verifier returns EXACTLY two findings —
**`NPC_TRACE_TRIGGER_MISSING` at seq 13 and seq 14** ("npc entry
carries no classification.trigger citation — an orphan (§3.2)").
Log: `pr45-simcore-log-r7.txt`.

**Seq identification (from the builders, not assumed).** Genesis =
seq 1 (N0 asserts `headSeq() == 1`); N1–N3 bring the head to 11 —
the suite itself proves this: it seeds the N4 card with
`createdSeq = await headSeq()` = 11. N4's owner
`situation.handle` touch is a single member-actor summary
(seq 12). The wake's delegation pass then produces exactly three
NPC-actor entries, in order: the delegation **FIRE entry**
(seq 13), the delegated action's **rule-effect DETAIL entry**
(seq 14), and its **summary** (seq 15). `fixture_adjust`'s handler
emits detail + summary; only the summary carried a citation, so
exactly {13, 14} flag — matching the evidence uniquely.

**The seam.** The verifier's traceability (c) reads
`classification.trigger` on EVERY standing entry whose actor is an
NPC — no kind/status exemption, rejected entries included. Round 6
put the citation on the delegated ACTION (so the stage's check 5
passes); round 7 put the mandate on the fire entry's ACTOR. But
the ENTRY classifications were stamped at most once per resolution
(the summary) or never. This round swept every producer of an
NPC-actor Log entry and fixed the whole class at the producers;
every stamp is the citation the producer/stage actually verified,
never a reconstructed guess.

**Producer audit (complete sweep).**

| Producer | Actor | Verdict |
|---|---|---|
| `buildRuleFireEntry` (delegation.ts) | NPC standing | **GAP — seq 13.** Classification had no `trigger`. Fixed: the §3.2 situation citation `{kind:"situation", sourceId, sourceSeq: situation.createdSeq, deliberation: null}` — the same citation the delegated action carries. |
| Delegated-action resolutions via `stampMandateCitation` (authorityStage.ts) | NPC standing | **GAP — seq 14.** Stamped the summary ONLY; multi-entry handler plans (fixture_adjust, chains, finance, …) left every detail entry orphaned. Fixed: the stamp now lands on EVERY entry of the resolution (each entry's own classification keys preserved). |
| Stage verdict plans — escalate / draft-only / blocked-fairness | NPC standing | CLEAR (already carried `mandateId`/`mandateVersion`/`trigger: triggerClassification(stage)`). |
| Stage REJECT plan (planForStageVerdict) | NPC standing | **GAP.** Classification carried no mandate keys, no trigger. Fixed for parity: `mandateId` + `mandateVersion` + `trigger: triggerClassification(stage)`. Residual named below. |
| Stage SILENCE verdict plan | NPC standing | **GAP.** `trigger: {sourceKind, …}` — no `kind` key, read as missing. Fixed: `trigger: triggerClassification(stage)`. |
| `buildSilenceCommit` (situations.ts) — wake silence pass, silence-rule fires, `situation.silence` | NPC for `npc-silent-mode`/`silence-rule` (member for owner-explicit/no-permission) | **GAP** (inherited by the stage mirror above). Same wrong shape: the SITUATION's source kind (e.g. `"manual-action"`) under `sourceKind`. Fixed: entry-vocab citation `{kind:"situation", sourceId: situationId, sourceSeq: triggerSeq, deliberation: null}`, where `triggerSeq` is the seq the entry's own summary text already cites. No other reader of the old shape exists (grep over lib/tests/app/components). N7 exercises this next. |
| `buildEnvelopeOutcomeEntryDraft` (envelopes/lifecycle.ts) | NPC envelope | **GAP.** No `trigger`. Fixed: `{kind:"envelope", sourceId: env.taskId, sourceSeq: env.createdSeq ?? null, deliberation: null}` — mirroring `entryTriggerOf`'s envelope fallback. N5/N6 exercise this next. |
| Attention conversion entry (`resolveAttentionStep`, wakeSteps.ts) | pending's `originActor` — **can be an NPC** | **CONDITIONAL GAP.** Classification had no trigger. Fixed: when the entry actor is an NPC, stamp `{kind:"log-event", sourceId: pendingId, sourceSeq: pending.originSeq, deliberation: null}`. Member-origin conversions keep their landed shape byte-identical. |
| Ripening + voiding entries (`resolveRipening`/`resolveVoiding`, resolver.ts — R-33/R-34/R-32/cap/summary drafts; delivery + schedule family plans) | pending's `originActor` — **can be an NPC** (incl. banking occasion entries via the schedule path) | **GAP of the class.** Classifications null or family-shaped. Fixed at one choke point (`stampOriginActorTrigger`, applied in all three ripening branches + voiding, before validatePlan): NPC-actor entries lacking a trigger gain `{kind:"log-event", sourceId: pendingId, sourceSeq: originSeq, deliberation: null}` — the origin event, the same seq these entries already cite as `causedBySeq` (standing: voiding here is the ripeness verdict's own event, not an undo erasure). Member/system origins untouched. |
| Committer `writeSetTooLargePlan` fallback | the attempted action's actor — can be an NPC | **CONDITIONAL GAP.** The fallback rebuilt the rejection entry from the raw action, stripping the stage's stamp. Fixed: the attempted plan summary's stamped `mandate` + `trigger` carry over verbatim when present. No dedicated pin (driving a >ceiling NPC plan is disproportionate); fixed by construction. |
| `buildDelegationEvaluationEntry` (delegation.ts) | MEMBER (rule owner, §5.5 audit pattern) | CLEAR — not an NPC entry. |
| Trigger-pass entries (`resolveTriggerStep`) | MEMBER (owner) | CLEAR — and carry a situation trigger anyway. |
| Follow-up entries (`resolveSituationFollowupStep`), envelope-failure entry, claim pass | MEMBER | CLEAR. Envelope claims write no entry (doc transition only). |
| Governance handlers (`npc.*`, `situation.*`, `envelope.spawn`) | MEMBER (owner-submitted) | CLEAR. NPC governance kinds are member actions; the spawn summary's actor is the submitter. |
| Phase 4 data step / snapshot refresh / genesis | — / system | CLEAR — no NPC-actor entries (data step writes none by design). |
| `wakePasses.ts` executor | — | CLEAR — writes no entry drafts; commits resolver/step plans only. |

**Named residuals (recorded, not silently resolved).** (1) A
genuinely triggerless NPC attempt (`NO_TRIGGER_ROOT`) now stamps
the defaulted citation `{kind:"log-event", sourceSeq: null}` on its
rejection entry; if such an entry ever stood, the verifier would
flag it `NPC_TRACE_TRIGGER_UNRESOLVABLE` instead of MISSING. No
landed path produces one: the wake executor stamps every delegated
action (round 6), envelope executions root at the envelope
(`entryTriggerOf` fallback), and clients cannot submit NPC actors
(intake fences actor forms). Defense-in-depth only. (2) Ripening
traceability (a)/(b) under NPC origin actors: (b)'s `usedBefore`
re-citation is the verifier's designed mechanism and W25 exercises
it across five citing resolutions cleanly; (a)'s active-window
reading (an NPC retired before its pending ripens) is a
verifier-design question for Vera, not a producer gap — untouched
this round, and no landed suite exercises an NPC-origin ripening
in the emulator venue yet.

**The pin (W25, new — wake harness 24 → 25).** One check drives
the real producers for five of the fixes and asserts their
standing entries through the REAL verifier: the fire entry via
`evaluateDelegationStep`; EVERY entry of the delegated
`fixture_adjust` resolution via `buildDelegatedActionDoc` →
`resolveAction` (mandate + trigger on detail and summary alike);
the silence commit via `buildSilenceCommit`; the envelope outcome
entry via the real terminal step; a determinate ripening under an
NPC origin actor via `resolveRipening` — plus producer-level
assertions for the stage's silence verdict (silent-mode world),
the stage's reject plan (round 6's unstamped shape), and an
NPC-origin attention conversion. The five produced entry sets are
assembled into a standing world (genesis + member seed entries at
the cited seqs) and `verifyStandingLog` returns **zero
`NPC_TRACE_*` findings**; falsifiability halves strip the fire
entry's and the detail entry's citations and the verifier flags
`NPC_TRACE_TRIGGER_MISSING` at exactly seqs 7 and 8 of the
assembly. The assertion scope is the §3.2 family per the round's
brief — the synthetic assembly's empty manifest write sets are not
the bijection's subject; the emulator suite's `verifyOk` runs the
full verifier over committed worlds. One existing expectation was
updated: the governance harness's stage-silence check asserted the
pre-fix `{sourceKind, …}` trigger shape — it now asserts the
entry vocabulary (`kind`/`sourceId`/`sourceSeq`); no count
changed (governance stays 59).

**Local regression (branch tip after this round):** `tsc --noEmit`
clean · scoped ESLint on the nine touched files 0 errors · full
pure battery green (governance 59, banking 54, situations 32, wake
**25** incl. the new W25, closeout 29, chains 34, cat2 34, cat1
all, defense 12, acq 14, market 27, lore 27; npc-core harness 37,
authority + envelopes harnesses all-pass) · `next build` green. No
gate-suite assertion was touched. Emulator suites are CI's venue
on this push; watch items: N4 completes through `verifyOk()`; N5
(envelope outcome entry now cited; same-wake claim parity), N7
(silence entries now entry-vocab; trigger candidacy), N8, N9(b)
`DEPENDENTS_EXIST` as before.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 8, 2026-10-21.*

## CI fix round 9 (PR #45) — N5: the output stood; the suite read it by a field the record never carries

**The failure (CI on `0facbe3`):** Install + Rules + Vercel
GREEN. Sim core: **N4 COMPLETES** — "ok N4 rule fire -> delegated
action under mandate (NPC entries traced) -> card handled;
verifier clean" (rounds 6–8 proven in the venue). N5 (the
ask-first fire as an envelope) stopped at
`tests/npc-core.test.ts:891`: "exactly one output record stands"
— actual 0, expected 1, from
`sim_task_outputs.where("taskId", "==", askTaskId)`.

**Post-wake state evidence (the suite's own passed assertions,
in execution order):** the ask-first rule fired as an envelope
(`passes.delegation.fired`, kind "envelope") · the claim pass
completed it in the same wake (`passes.claims.completed` =
DONE) · the worker saw the claim standing RUNNING (npcId
charA1) · the envelope doc stands **DONE**. The claim pass
pushes `claims.completed` only when the terminal step's
`commitStep` returns true, and the terminal plan commits
output write + envelope patch + outcome entry wholesale — so
the terminal transaction committed, output included. The only
assertion that failed is the output READ. Segment indicted:
**the read, not the chain** — spawn, claim, and terminal
execution all proven by the suite itself before the stop.

**Root cause — SUITE reading (hypothesis (c), the PR-6 loans
class).** The output record (`TaskOutputRecord`, built by
`buildTaskOutput`) carries `outputId`, `npcId`,
`envelopeTaskId`, `outcome`, `outputText`,
`structuredOutput`, `createdSeq`, `audienceUids` — **there is
no `taskId` field on the record, and there never has been**.
Outputs are addressed by doc id (`sim_task_outputs/{taskId}`):
types.ts §4.3 ("exactly one per envelope, ever");
`validateTaskOutput` ("exactly-one is provable only if the ids
coincide" — `outputId === envelopeTaskId`); the terminal
preconditions' own comment ("the output's id is the task id,
so this is an existence check, not a query"); the verifier
binds outputs by path + `recordsCreated`, never by a `taskId`
field; and every production reader doc()-reads by id
(`lib/situations/client.ts`, `components/sim/SpawnNpcForm.tsx`).
A Firestore `where("taskId", "==", …)` matches only documents
carrying that field — zero, standing or not. The suite was the
only reader in the repo querying outputs by `taskId` (grep:
four sites, all in `tests/npc-core.test.ts`).

**Discriminations.** (a) CLAIM ELIGIBILITY — refuted twice.
Behaviorally: CI proves the fire-spawned envelope was claimed
and completed in the same wake. At the code level:
`composeFirePlan` stamps `availableAt: snapshot.now` — the
wake's own instant — so the claim planner's availability floor
cannot bite, and the claim pass scans the live collection at
pass time (after the delegation pass commits), not the
wake-start snapshot; the assembly ruling (same-wake spawns
claimable) is what the code does. The F-E9 sibling is not
implicated: pass spawns inject the instant explicitly (W2's
standing assertion). (b) TERMINAL EXECUTION — refuted: a
revalidation failure terminates FAILED *with* an output record
(outcome FAILED) and the envelope standing FAILED; the
envelope stands DONE and `claims.completed` records DONE, so
the terminal plan — whose output `planWrite` is unconditional
once preconditions pass — committed whole. No silent-failure
channel exists on this path: W14 proves the same resolver
lands output + patch + entry as one bijection. (c) confirmed
as above.

**Fix (suite layer only; no engine code touched).** All four
`where("taskId", …)` output reads become doc-id reads via the
suite's `adminDoc` — the production reading:
- N5: doc read + stands + `envelopeTaskId === askTaskId` +
  outcome DONE (the exactly-one claim now rests on the §4.3
  mechanism itself: the doc id is the task id and the record's
  ids coincide).
- N6 cancelled envelope: doc read === null. This assertion
  previously passed **vacuously** — the field query returns 0
  whether or not an output stands — so the F-E8
  terminal-without-output assertion was no assertion at all;
  it is one now.
- N6 P5-K4 silent tasking and N10 novel NPC: doc read +
  `envelopeTaskId` equality (both expected a standing output
  and would have failed identically when reached).

**Pin — W26 (wake harness 25 → 26).** The joint the pure
venues had never chained: W13's claim-planner fixtures and
W14's terminal fixtures are hand-built envelopes with past
`availableAt`. W26 drives a **fire-spawned** envelope — the
real `evaluateDelegationStep`, N5's shape (ask-first handler
citing no mandate, a question card with no delegated spec) —
asserts `availableAt === NOW` on the fire's own output, runs
the real `planEnvelopeClaims` over that record (claimed in its
own wake, nothing skipped), applies the real lifecycle
`claimEnvelope` (the claim `claimEnvelopeTx` applies), and
completes it through the real `resolveEnvelopeTerminalStep` in
a world where the fire entry stands at the envelope's
`createdSeq`. It asserts the whole bijection (output at
`sim_task_outputs/{taskId}` with `outputId`/`envelopeTaskId`
=== taskId and outcome DONE; envelope DONE with `outputId`
set and claim cleared; one outcome entry whose
`recordsCreated` names the output path and whose actor is the
envelope actor) — and the record-shape fact the corrected
suite reading rests on: **the output record's `taskId` field
is `undefined`**, so a `taskId` field query can never match a
standing output.

**Sibling disposition.** N6's owner-direct envelopes ride
the same claim pass and the same terminal step, and the
defect was never spawn-path-specific: the suite's reading was
wrong for every output. :974 (cancelled, owner-direct) was
vacuous-pass; :1005 (silent direct tasking, owner-direct) and
:1415 (N10) would have failed exactly as N5 did. All four
sites are fixed; the engine paths for owner-direct spawns are
untouched and were never indicted (their claims/completions
are asserted from the wake summary and the envelope doc,
which read correctly throughout).

**Local regression (branch tip after this round):**
`tsc --noEmit` clean · scoped ESLint on the two touched files
0 errors · full pure battery green at landed counts
(governance 59, banking 54, situations 32, wake **26** incl.
the new W26, closeout 29, chains 34, cat2 34, cat1 all,
defense 12, acq 14, market 27, lore 27; npc-core harness 37,
authority + envelopes harnesses all-pass) · `next build`
green. Emulator suites are CI's venue on this push; watch
items: N5 completes through its outcome-entry assertions and
`verifyOk()` (first exercise of both past :891), then N6's
now-real output assertions, N7 trigger candidacy, N9(b)
`DEPENDENTS_EXIST` as before.

*— Rafe (Muse Eng), Phase 5 Build Lead, PR #45 fix round 9, 2026-10-21.*
