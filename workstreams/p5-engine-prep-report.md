# Phase 5 PR-2 — Engine Core: Prep / Build Report

**Branch:** `phase5/engine-core` (off `phase5/substrate`, tip `fa25bbf` at build
start — verified still the tip before branching).
**Scope:** brief §§2.x/5/6/7/8-shapes/9-consumption, decisions P5-K3/K4/K7/K11/
K13/K14/K15, countersign A-2/A-4/A-7/A-8, assembly plan §W2.
**Status: built, not live** (see §7 — the P2-K15 production chain has not run).

This is the second PR of the seven-PR Phase 5 train. PR-1 (substrate) landed
the ahead-built modules and the governance registration with stated deferrals;
PR-2 wires the engine: the authority stage inside the resolver, the eight live
governance handlers, the verifier's NPC checks, the F-S1 envelope rename, and
the rules-version stamp. Everything below was verified against the files as
built; divergences are named as flags (§5), never silently harmonized.

---

## 1. What landed (commit-by-commit)

1. **F-S1 envelope rename (Lead commit).** `requesterUid` → `requestingMemberId`,
   `intentText` → `task` across `lib/envelopes/{types,envelopes,lifecycle,index}.ts`
   and the module harness; behavior preserved (deterministic id derivation,
   closed taskType set, claim/revalidate machinery untouched in substance).
   `buildTaskOutput` additionally stores a caller-supplied `audienceUids`
   (the envelope's read audience at completion) — the §9.5 rules branch's
   first read path. The envelopes harness held NO whole-doc equality on
   outputs (field asserts + `validateTaskOutput` only), so the new field
   needed no harness surgery; E1–E11 pass unchanged otherwise.
2. **Rules-version stamp (own commit).** `RESOLVER_RULES_VERSION`
   `"sim-rules-0.2.0-phase2"` → `"sim-rules-0.5.0-phase5"` in
   `lib/sim/state.ts` (value only; no consumer changed). Citation surfaces
   updated: `tests/sim-core.test.ts` (×2), `tests/rules.test.ts` (×1),
   `tests/governance-harness.ts` (×1, the ALLOC fixture). A repo-wide grep
   confirms no remaining `sim-rules-0.2.0-phase2` literals in lib/tests/
   app/components/scripts/README. (F-S3 discharged.)
3. **Authority stage wiring.** New `lib/sim/authorityStage.ts` + resolver
   integration (§2 below).
4. **Governance handlers live.** `lib/sim/rules/governance.ts` rewritten:
   the eight PR-2 deferrals replaced with real handlers; `situation.*`
   deferrals kept, naming PR-3 (§3 below).
5. **Verifier NPC checks.** `lib/sim/verify.ts` gains the §3.2 checks (§4).
6. **README** (this PR's standing update) + this report.

## 2. The authority stage (`lib/sim/authorityStage.ts`)

**Placement.** Inside `resolveAction`, after snapshot materialization and
BEFORE descriptor dispatch, for EVERY action whose actor is an NPC — ruled
kinds and unruled kinds alike (an unruled kind derives `ruleIds: []`,
`classes: []`). Verdicts become PLANS, never throws.

**Dialect seam.** The stage projects the STORED mandate version doc into
the authority module's dialect per attempt:

- `scope.allowedActionTypes / namedRecordIds` ← `structuredScope`;
  `scope.triggerKinds` ← stored trigger kinds mapped through the same
  entry→authority vocabulary mapping as the attempt's trigger
  (`envelope` → `owner-envelope`, `mandate-routine` → `standing-routine`,
  `log-event`/`situation` shared);
- `scope.perActionRubars / perPeriodRubars` ← `caps.perActionRubars /
  perResolutionPeriodRubars`; `scope.perPeriodActions ← caps.periodDefinition.count`
  when the period kind is `actions`; `scope.periodDefinition` ← the
  `"<kind>:<count>"` string; `maxProjectPhase`, `allowPartialExecution`,
  `alwaysEscalate` ← caps/version fields;
- `scope.counterpartyCityIds`: stored `null` (no restriction) projects to
  the ATTEMPT's own counterparty list — projecting `[]` would forbid,
  which is the opposite of the stored meaning;
- `mode` ← `permissionMode`; `createdByUid` ← `ownerUid`;
  `revokedSeq` ← root.revokedSeq; status derived: root revoked ⇒
  `"revoked"`; `supersededSeq != null` ⇒ `"superseded"`;
  `effectiveSeq == null` ⇒ `"pending"`; root expired ⇒ `"expired"`;
  else `"active"`.
- **Stored-regime integrity is the stage's own:** the stored doc's
  `mandateHash` is recomputed with lib/npcs `mandateHash()` over the
  stored doc; mismatch ⇒ stage reject `MANDATE_HASH_MISMATCH`. The
  PROJECTED record's `mandateHash` field is `computeMandateHash` OF THE
  PROJECTION, so the module's internal version-state check is consistent
  within its own dialect.
- NPC form pre-checks the module cannot be trusted with: missing NPC doc
  ⇒ `view.npc = null` (module fires `NPC_NOT_FOUND`); any stored status
  other than `active`/`retired` (e.g. `pending_activation`) ⇒ the stage
  returns a reject verdict directly, `NPC_NOT_ACTIVE` naming the status —
  `npcFromDoc`'s coerce-to-active is never relied on; `retired` projects
  as retired so the module's check 1 fires.
- **Negotiation-bounds projection (mechanical subset — flagged for
  ratification, §5 F-E2):** stored prose bounds project only where the
  mapping is mechanical: `walkAwayIf` string ⇒ one-element exact-text
  list; `maxTurns: null` ⇒ `Number.MAX_SAFE_INTEGER` sentinel;
  `mayOffer`/`mayAccept === false` (or null) ⇒ empty side; non-false
  prose ⇒ one no-limit entry per distinct term kind the attempt proposes
  on that side. Amount prose is interpretation — recorded by the module,
  never silently mechanical here.

**Attempt derivation** (resolver-supplied, brief §5.3): actionType;
descriptor ruleIds; classes derived mechanically (R-06 and R-07-dissolve
⇒ `corporate-lifecycle`; R-11 adopt kinds ⇒ `canon-adoption`; R-19 with
an inhabited target structure read from the snapshot ⇒ `destruction`;
undo/ballot/permission-grant/contest ride `TIER_B_RULE_IDS`); principal
cityId = the NPC record's cityId; namedRecordIds ←
`structuredAction.namedRecordIds` else structureId/fundId singletons;
counterpartyCityIds ← `structuredAction.counterpartyCityIds ?? []`;
rubarMovement ← `|amountRubars ?? rubarMovement ?? 0|` (declared-movement
reading — flag §5 F-E3); projectPhase ← `toPhase ?? projectPhase`;
effectClass: acquisition-family descriptors (R-25–R-31) ⇒
`read-collection`, everything else ⇒ `state-change`. Trigger mapped
between vocabularies (entry vocab on the action/actor; authority vocab
for the module; the envelope root takes `envelopeId` from the actor).
Period usage is counted from the Log BY MANDATE CITATION: the stage's
read plan adds a `sim_log_entries` query (`actor.mandateId ==` the cited
mandate) and the pure core counts distinct resolutions and Σ|Δ| over
numeric `*Rubars` field changes, windowed by the cited version's
periodDefinition. No counter doc exists or was invented.

**Verdict → plan mapping.**

- `resolve` ⇒ normal dispatch proceeds; the summary entry's
  classification is stamped (merged) with `{mandate: {mandateId,
  mandateVersion, mode}, trigger: {kind, sourceId, sourceSeq,
  deliberation}}` in Vera's §3.2 entry vocabulary — on the ruled path,
  the unruled narrative path, AND the rejected-handler path after the
  resolver's rejection conversion.
- `reject` ⇒ the rejected-plan machinery with the module's code VERBATIM
  (rejection ruleIds = descriptor id if any). A mandate revoked between
  preview and commit therefore commits as `AUTHORITY_REVOKED` under the
  committer's recompute carve-out instead of dying as `stale-preview` —
  pinned in harness G6.
- `escalate` ⇒ resolved plan, `changes: []`, classification
  `{producer: "escalation", escalation: {failedCheck, reason,
  scopeFailures, allowPartialExecution, outOfBounds, checks}, mandateId,
  mandateVersion, trigger}`. The Situation RECORD is PR-3's; nothing is
  assembled here. **Partial execution is NOT implemented** — an
  escalation carrying `allowPartialExecution: true` still escalates the
  whole attempt (refusing whole is always lawful). Flag F-E1.
- `draft-only` ⇒ resolved plan, `changes: []`, classification
  `{producer: "draft-only", draftOnly: {reason}}` + a `chronicle`
  narrative output carrying the action text when present; the summary
  carries the principal cityId so committer badging never throws
  `CHRONICLE_UNBADGEABLE`.
- `silence` ⇒ resolved plan, `changes: []`, classification mirroring
  Vera's `buildSilenceCommit` shape: `{silence: true, producingMode:
  "silent", situationId (situation triggers only), situationKind: null,
  trigger: {sourceKind, sourceId, sourceSeq}}`.
- `blocked-fairness` ⇒ resolved plan, `changes: []`, classification
  `{producer: "blocked-fairness", blockedFairness: {reason}}` — a wall,
  NO Situation.

**Behavior-change note (named):** because the stage runs before dispatch
for every NPC-actor action, an NPC-actor GOVERNANCE action (e.g. an NPC
attempting `npc.edit`) now refuses at the stage when no NPC record
stands, where PR-1's harness expected the handler's `ACTOR_NOT_MEMBER`.
G3's expectation updated accordingly (`NPC_NOT_FOUND` at the stage);
member-actor governance is unaffected.

## 3. Governance handlers (`lib/sim/rules/governance.ts`)

Adapter discipline is PR-1's: module doc builders composed into plans;
`BUILDER_EPOCH` timestamps nulled on CREATE writes (committer stamps),
UPDATE writes carry stored `createdAt` and null only `updatedAt`;
top-level collections claim effects via `recordsCreated`/`recordsUpdated`
with `changes: []` (F-02); module `NpcCoreError`/`EnvelopeValidationError`
codes pass through as rejection codes. `summarySeq` (= counter head +
entry count) is the effectiveness stamp everywhere. The owner gate
(`requireNpcGovernance`): member actor AND (`npc.ownerUid === actor` OR
the NPC's city faction lists the actor) — co-owner support per §2.1.
Read plans are per-kind unions on the descriptors (NPC kinds add the
roster collection query; mandate kinds derive the current-version path
from the cited root seed — the F-01 two-phase mechanism; envelope kinds
derive the deterministic envelope path at read-plan time).

- **npc.create — activation composition (Cato flag 5, resolved as
  same-resolution composition per brief §1.2).** `buildNpcCreate` →
  `buildNpcActivation(summarySeq)` → `deriveTeamRoster` folded into ONE
  plan: net write = the ACTIVE record + the team roster; one summary
  ("created and activated"). If the snapshot already holds a
  `pending_activation` record for the id owned by the actor (the
  rules-level client-authored flow), the stored record is activated
  instead of refused `NPC_ALREADY_EXISTS`. **PR-1's G2 assertions are
  UPDATED in this PR** (pending write → active write + roster write) —
  the change is named here and in the harness, per the brief.
- **npc.edit** — owner gate ⇒ `buildNpcEdit` over the flat
  structuredAction definition fields present ⇒ one write.
- **npc.retire** — `buildNpcRetirement` (retiredSeq = summarySeq) +
  roster re-derivation ⇒ NPC + team writes. Retiring a
  pending_activation NPC is allowed (the builder refuses only
  already-retired).
- **npc.setMode (P5-D3).** WITH a mandate in force: the version ROLLS in
  the same resolution — full payload copied, `permissionMode` replaced,
  `sourceActionId` = this action, version = current+1,
  `effectiveSeq = summarySeq`, old version `supersededSeq = summarySeq`,
  root pointer/`expiresAtSeq` move, NPC snapshot via
  `buildNpcMandateSnapshot`. WITHOUT: snapshot-only `buildNpcSetMode`.
  (Surfaces cite the mandate root in `citations.recordPaths` so the
  two-phase read can derive the version path — W4 contract, §6.)
- **mandate.set.** Two forms. *New root:* `structuredAction.mandateId`
  REQUIRED — absent ⇒ reject `MANDATE_ID_REQUIRED`, no silent derivation;
  payload ⇒ `buildMandateVersion` + `buildMandateRoot`, the adapter
  stamps effectiveness in-plan (root status `active`, `createdSeq =
  summarySeq`, version `effectiveSeq = summarySeq`) + NPC snapshot
  write. *New version:* root must exist with NPC/owner match; version =
  `root.currentVersion + 1` (payload disagreement ⇒ `VERSION_CONFLICT`);
  old version superseded at summarySeq; root pointer + `expiresAtSeq`
  move; snapshot moves. *Client-authored posture:* a pending version doc
  already in the snapshot (authored under the §9.3 fence) is validated
  (stored `mandateHash` recompute + NPC/owner match + the Tier B
  authoring fence) and flipped effective instead of rebuilt. *Tier B
  authoring fence (resolver half):* any `allowedActionType` whose
  classifying descriptor id ∈ `TIER_B_RULE_IDS` ⇒ reject
  `MANDATE_AUTHORIZES_TIER_B`; free-string/prose kinds are the
  composer/UI fence's half, not mechanically classifiable, not
  re-implemented here. Setting on a REVOKED root ⇒ reject
  `MANDATE_REVOKED` (build choice, fail-closed — flag §5 F-E4).
- **mandate.revoke.** Root status ⇒ `revoked`, `revokedSeq = summarySeq`;
  NPC pointer nulled (`currentMandateId`/`currentMandateVersion`), mode
  value untouched; the current version doc is NOT written (revocation
  rides the root in both regimes). Already-revoked ⇒
  `MANDATE_ALREADY_REVOKED`.
- **delegationRule.set.** Versioned authoring mirroring mandate.set over
  `sim_delegation_rules` (root mirrors the current version's payload +
  `version`/`enabled`/`ruleHash`/`effectiveSeq`/`status`; version doc
  carries the authoring fields + `ruleHash` + `createdAt`; disable = new
  version with `enabled=false` ⇒ root status `"disabled"`; statuses
  `pending|active|disabled|superseded` per Vera's built shapes).
  Composer-side fences enforced here: the handler NPC must exist, be
  OWNED BY THE AUTHOR, and serve the rule's cityId (`DELEGATION_NPC_NOT_OWNED`,
  `DELEGATION_NPC_CITY_MISMATCH`); `alwaysWait == true` requires
  `handler.mode == "wait-for-owner"` (`ALWAYS_WAIT_REQUIRES_WAIT_MODE`).
  **`computeRuleHash` is copied EXACTLY** from Vera's `lib/sim/delegation.ts`
  (same canonical function, same field set: ruleId, ownerUid, cityId,
  version, priority, match, handler, caps, alwaysWait, enabled) into
  governance.ts as `computeDelegationRuleHash`; the harness pins her
  situations-harness S4e payload's digest as a literal vector
  (`0b37d446…4520`). **PR-3 assembly confirms parity against her harness
  itself.** NOT re-implemented here (seam recorded): the shared-city
  office-routing fence and the Tier B kind guardrail — both belong to
  Vera's shared composer validator (PR-3). Payload-form authoring only;
  mandate.set's client-authored flip is not mirrored for rules in this
  PR (flag §5 F-E5).
- **envelope.spawn.** Member actor; requester = `actor.memberId` (never
  a payload field); `buildTaskEnvelope` (post-rename) +
  `validateEnvelopeSpawn` with source `"owner-direct"` and a cities map
  built via `cityContextFromDocs` (sharedCityId from `sim_world/current`
  when the field exists — residual flagged §5 F-E6); deterministic id
  already standing ⇒ `ENVELOPE_ALREADY_EXISTS`. Structured as an
  EXPORTED `planEnvelopeSpawn(ctx, opts)` core: **PR-4's rule-spawned
  completion convention** — call the core with `source:
  "delegation-rule"` (the module's landed literal; Vera's prose says
  "rule-spawned" — flag §5 F-E7), `clientRequestId` ← the firing action's
  id, `requestingMemberId` ← the rule's owner, and the rule-evaluated
  mandate version (authority dialect) or null; the core's `source !==
  "owner-direct"` path skips the owner-authoring branch via the module's
  issuer-subset fence, exactly as W4's fire kind (EnvelopeSpawnInput
  minus spawn-action fields) requires.
- **envelope.cancel.** Requester-only (`AUTHORITY_REVOKED` otherwise);
  QUEUED ⇒ write `FAILED` + `lastError {code: "cancelled_before_claim"}`
  with `completionOutcome`/`outputId` left null (the brief's one
  terminal truth; the UI renders "cancelled" from the code); RUNNING ⇒
  `ENVELOPE_ALREADY_CLAIMED`; terminal ⇒ `ENVELOPE_TERMINAL`. **Flagged
  tension F-E8:** the module's `validateEnvelopeRecord` terminal
  invariants (`outputId === taskId`) assume completion; the module has
  no cancel helper and was NOT "fixed" — PR-4's claim pass must treat
  `FAILED` + `cancelled_before_claim` as terminal-without-output.

`situation.handle / situation.delegate / situation.silence` keep PR-1's
stated deferrals, naming PR-3 (`phase-5-situations`).

## 4. Verifier NPC checks (`lib/sim/verify.ts`)

New section, all checks keyed on NPC-actor entries or `sim_task_outputs`
docs — **inert on pre-Phase-5 worlds** (no such entries ⇒ no findings;
the landed pure battery passes unchanged, and the emulator suites run in
CI):

- **Actor form + exactly-one-root** via `validateNpcActorForm`
  (`NPC_ACTOR_FORM`).
- **P5-K13:** `characterId` present-and-non-null on ANY non-member actor
  ⇒ `CHARACTER_ID_ON_NON_MEMBER`. Absent ≡ null: a missing key is never
  flagged.
- **Traceability triple over 100% of NPC-actor entries:**
  (a) NPC record stands; `ownerUid === onBehalfOfMemberId`; NPC city
  matches the entry's cities; active at the entry's seq
  (`activationSeq ≤ seq < retiredSeq`) — `NPC_TRACE_*` codes;
  (b) mandate root stands and belongs to the actor's NPC; versions
  collected from `stateDocs` resolve via `resolveVersionInForce` at the
  entry's seq to the CITED version; the cited version's stored
  `mandateHash` recomputes equal (`NPC_TRACE_MANDATE_HASH_MISMATCH`) —
  this is also the mandate-citation hash-equality check;
  (c) trigger citation: classification.trigger present; `log-event` /
  `mandate-routine` triggers carry a sourceSeq that stands; envelope-root
  actors' envelope docs stand.
- **Envelope↔output bijection:** every `sim_task_outputs/{taskId}` doc
  is named by `recordsCreated` of EXACTLY ONE standing entry, whose
  actor is the NPC actor rooted at that envelope; the envelope doc
  stands (`OUTPUT_*` codes).
- **Silence assertions** (Vera's classification shape): any resolution
  containing a `classification.silence === true` entry must have
  `changes: []` on ALL its entries (`SILENCE_WITH_CHANGES`) and its
  manifest writeSet's state-writes confined to `sim_situations/*`
  (`SILENCE_FOREIGN_WRITE`).

P5-D6 is untouched: no undo-restore deletion assertions beyond PR-1's
ratified ground were added anywhere (A-7 holdout preserved).

## 5. Flags

**PR-2 build flags (F-E):**

- **F-E1 — Partial execution not implemented.** Escalate verdicts with
  `allowPartialExecution: true` escalate the WHOLE attempt; the module's
  `partialExecutionAllowed` is never honored. Refusing whole is always
  lawful; named here per the brief so a later PR can narrow it
  deliberately.
- **F-E2 — Negotiation-bounds projection is a mechanical subset.**
  Stored prose bounds project only where mechanical (exact walk-away
  text, `false` ⇒ empty side, per-term-kind no-limit entries, `maxTurns`
  null ⇒ unbounded sentinel). Amount prose is interpretation, recorded
  by the module at evaluation, never silently mechanical. ALSO: brief
  §5.3(a)'s "carries no list" allowedActionTypes case is
  indistinguishable from an empty stored list — projected as-is
  (fail-closed ⇒ escalate), which is the NPC's correct move.
- **F-E3 — Caps bind DECLARED movement.** `rubarMovement` derives from
  the action's declared fields (`amountRubars ?? rubarMovement`). Every
  landed money kind reads the same fields, so declared == actual today;
  a novel kind defaulting to 0 is type-gated by allowedActionTypes.
- **F-E4 — mandate.set on a revoked root** rejects `MANDATE_REVOKED`
  (build choice, fail-closed; the brief is silent — a revoked mandate is
  not revived by authoring).
- **F-E5 — delegationRule.set ships payload-form authoring only.** The
  client-authored pending-version flip that mandate.set supports is not
  mirrored for delegation rules in this PR.
- **F-E6 — Envelope spawn shared-city residual.** The cities map takes
  `sharedCityId` from `sim_world/current` when the field exists; if
  absent, the shared city is treated as ordinary. Mitigated: the module's
  canon fence still refuses envelope targets whose owners don't include
  the NPC's owner.
- **F-E7 — Envelope spawn source literal.** The landed module's spawn
  source is `"delegation-rule"`; Vera's §3 prose and the assembly text
  say "rule-spawned". Landed behavior preserved (per the LAND rule);
  PR-4's completion convention documents the mapping (§3).
- **F-E8 — Envelope cancel vs module terminal invariants.** The brief's
  cancel-before-claim truth (`FAILED` + `cancelled_before_claim`,
  `outputId` null) contradicts `validateEnvelopeRecord`'s completion
  invariants. Module NOT fixed; PR-4's claim pass must treat
  `FAILED`+`cancelled_before_claim` as terminal-without-output.
- **F-E9 — availableAt default.** When neither the spawn opts nor the
  action supply `availableAt`, the core uses `snapshot.now` (per the
  brief) — a wall-clock value inside an otherwise clock-free plan;
  preview/commit parity for spawns should be re-checked when PR-4 wires
  the wake (the envelope doc itself is deterministic; only its
  `availableAt` can drift between preview and commit recompute).
- **F-E10 — Stage-before-dispatch refusal precedence.** NPC-actor
  governance attempts refuse at the stage (`NPC_NOT_FOUND` etc.) before
  any handler gate — a deliberate consequence of stage placement
  (G3 expectation updated; §2 note).
- **F-E11 — A-8 Tier B coverage shape.** The harness's Tier B refusal
  case (G6) uses an EXISTING Tier B verb (R-11 canon adoption, escalated
  whole) plus the mandate authoring fence (R-16). PR-6's B-06
  loan-acceptance verb does not exist in the registry yet; when it
  lands it joins this same battery — A-8's requirement (the refusal case
  IN the harness, no deferral branch) is met for every Tier B verb that
  exists today.

**Carried flags from PR-1 (`p5-substrate-prep-report.md` §5):**

- **F-S1 (envelope field names) — RESOLVED** by commit 1 of this PR.
- **F-S2 (mandate root born shape)** — unchanged; the §9.3 fence admits
  both flows; the handler stamps effectiveness in-plan for the
  born-with flow.
- **F-S3 (rules-version stamp) — RESOLVED** by commit 2 of this PR.
- **F-S4 (P5-D6 / A-7 holdout)** — still pending Koda ratification;
  untouched here.
- **F-S5 (characters collection note)** — unchanged (minted character
  doc creation is a member write outside the sim transaction; W4
  sequences it).

**The ten module flags ride as PR-REVIEW items, UNDECIDED** (state
unchanged by this PR; the build adopted the substrates' positions where
the brief required one, without deciding the flags):

Cato's five (NPC core): (1) default-mode location — adopted as the
builder default (P5-K3); the A-4 gate reads the literal from the builder
(`DEFAULT_PERMISSION_MODE === "ask-first"`, harness G6); the residual
gate-expression question rides. (2) mandateHash field set (incl.
sourceActionId, excl. createdAt; golden vectors) — used as built by the
stage's stored-regime check and the verifier. (3) cascade policy
mechanics for revoke issuing new pendings — NOT implemented here;
mandate.revoke writes root + snapshot only. (4) awaiting-input expiry
constants vs WakeScanState fields — untouched (wake is PR-4). (5)
activation composition — substrate preserved the split; THIS PR composed
it same-resolution per brief §1.2 (G2 updated, named).

Vera's five (situations/envelopes): (1) owner-direct envelope vs later
flip-to-silent (E9 line: owner-direct survives, rule-spawned doesn't) —
module behavior preserved verbatim. (2) envelope claim-revalidation
timing + runStartSeq — untouched (PR-4). (3) situation↔pending linkage —
adopted linked-not-fused (P5-K8); the stage's silence classification
mirrors her commit shape. (4) revocation reach into ripening delegated
pendings (`revocationReaches("ripening") === false` is executable fact)
— untouched; TC-N09's bite here comes from the stage re-running at
commit + PR-4's envelope revalidation. (5) envelope results re-entering
evaluation as seven-check citations — untouched (PR-4).

Plus, riding alongside: **P5-D5** (adopted-but-flagged: structured floor
wins; prose interpreted at resolution with the interpretation recorded —
the stage's projection is the mechanical subset, F-E2) and **P5-D6**
(flagged for Koda; A-7 holdout — §4 note).

## 6. W4 contract notes (for June — surfaces)

- **Governance actions are ordinary member actions** through preview →
  confirm → commit (the settings surfaces call the standard sim action
  path with the governance action kinds; no special channel).
  `npc.setMode` and existing-root `mandate.set`/`mandate.revoke`
  actions should cite the mandate root in
  `structuredAction.citations.recordPaths` so the two-phase read plan
  can derive the current-version path from the STORED root.
- **Delegated-action previews are computed for the Log's before/after
  record but need NO owner confirmation** — the mandate WAS the
  confirmation (brief §5.1). Surfaces must not gate NPC resolutions
  behind a confirm step.
- **The ConfirmationCard's binding-step primitive consumes
  escalation/draft outcomes, never NPC output directly**: an escalation
  or draft-only resolution surfaces through the summary entry's
  classification (`producer: "escalation" | "draft-only"` + payload);
  the card renders THAT for the owner's decision — raw task outputs are
  never the confirmable object.

## 7. Gate discipline (A-2) — built, not live

This PR is **built, not live**. The five P2-K15 chain items are NOT done
here: (1) no production fabric user exists with both fabricRole values
(committer + worker); (2) no production rules deploy; (3) no production
indexes deploy; (4) no production genesis; (5) no operated production
wake path. The ten module flags + the F-S flags ride as PR-review items
UNDECIDED (§5). P5-D6 stays untouched.

## 8. Regression record

Pure battery (all green): cat1 (all), defense 12, chains 34, cat2 34,
acq 14, market 27, lore 27, closeout 29, **governance 44** (was 15;
G2 rewritten for the activation composition, G3 stage-precedence
expectation, G4 narrowed to situation.*, G6 stage routing incl. A-8
Tier B + A-4 literal + AUTHORITY_REVOKED carve-out code, G7–G9 handlers
end-to-end incl. the ruleHash parity vector, G10 verifier), NPC core
36/36, authority harness all cases, envelopes harness all cases.
`npx tsc --noEmit` clean; scoped ESLint clean; `npx next build` green.
Emulator suites (rules/sim-core/play-core) cannot run in this sandbox —
CI is their venue (standing hazard, as PR-1 recorded); the
rules-version citation updates inside them are literal-only.

## 9. PR draft (verbatim, for the push lane)

---

**Title:** Phase 5 PR-2 — engine core: authority stage, live governance handlers, verifier NPC checks

**Body:**

Phase 5 PR-2 of 7 — the engine core (brief `phase5-implementation-brief.md` §§2/5/6/7/8/9, decisions P5-K3/K4/K7/K13/K15, countersign A-2/A-4/A-7/A-8, assembly plan §W2). Full build record: `workstreams/p5-engine-prep-report.md`.

**What lands**

- **Authority stage** (`lib/sim/authorityStage.ts`): every NPC-actor action evaluates through the seven-check delegated-authority engine inside `resolveAction`, before descriptor dispatch (unruled kinds included), over a dialect-seam projection of the stored mandate docs — the stage verifies the stored `mandateHash` itself; verdicts become plans (resolve dispatches with mandate citation + trigger stamped; reject uses the module's code verbatim so the committer's `AUTHORITY_REVOKED` recompute carve-out bites; escalate/draft-only/silence/blocked-fairness resolve as zero-write plans in the brief's shapes). Partial execution is not implemented (escalate-whole; flag F-E1).
- **Eight governance handlers live**: npc.create activation composition (create + activation + roster in one resolution — PR-1's G2 assertions updated, named in the report), npc.edit/retire, npc.setMode (P5-D3 version roll), mandate.set (id required; in-resolution effectiveness; client-authored pending flip; Tier B authoring fence) / mandate.revoke (root `revokedSeq` only), delegationRule.set (ruleHash copied exactly from the situations module; parity vector pinned — PR-3 confirms against her harness), envelope.spawn (exported `planEnvelopeSpawn` core for PR-4) / envelope.cancel (QUEUED-only, `cancelled_before_claim`; module tension flagged F-E8). `situation.*` still defers, naming PR-3.
- **F-S1 rename**: envelope records carry `requestingMemberId`/`task`; `buildTaskOutput` stores caller-supplied `audienceUids` for the §9.5 read branch.
- **Rules-version stamp**: `RESOLVER_RULES_VERSION` → `sim-rules-0.5.0-phase5`, own commit, citations updated, consumers untouched.
- **Verifier §3.2 NPC checks**: actor form + exactly-one-root, traceability triple over 100% of NPC entries, envelope↔output bijection, silence assertions, P5-K13 `characterId` flag — inert on pre-Phase-5 worlds.
- **Harness**: governance 15 → 44 checks (stage routing incl. the A-8 Tier B refusal case and the A-4 `ask-first` literal, handlers end-to-end, envelope spawn/cancel, verifier G10); full pure battery green; tsc/ESLint/next build green. Emulator suites are CI's venue.

**Gate (A-2): built, not live.** The P2-K15 production chain has not run: no production fabric user (committer + worker roles), no production rules deploy, no production indexes deploy, no production genesis, no operated production wake path. The ten module flags + F-S flags ride as PR-review items UNDECIDED. P5-D6 untouched (A-7 holdout preserved).

README updated per the standing every-PR rule (Phase 5 section + changelog).

---
