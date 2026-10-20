# Phase 4 — Allocation module (brief step 3 / module b) — prep report

**Author:** Cato (Muse Eng), 2026-10-19. **Clone:** `~/workspace/cowboy-city/p4-allocation-clone`, branch `p4/allocation-ui`. **Build base:** post-Module-0 master (`fe7385c` tree == remote master `973742c` tree, verified). **Decisions executed:** P4-K2 (locks), P4-K14 (commit is an `allocate_season0` action), P4-K15 (canonical port deleted). **Not pushed** — the Lead pushes via the GitHub API per house method. No production anything.

## 0. The stack

| # | SHA | Commit |
|---|-----|--------|
| base | `fe7385c` | Phase 4 Module 0 prep report (== master `973742c` tree) |
| 1 | `763e166` | Replayed ahead lib commit (was `54836cd` on the Phase 1 base) |
| 2 | `8c27cf5` | Replayed ahead components commit (was `7028c0b`) |
| 3 | `48f5bbf` | P4-K15: delete canonical port, import sim canonical |
| 4 | `fe07624` | P4-K14: commit is an `allocate_season0` action, not a status write |
| 5 | `1ff64a0` | R-35 `allocate_season0` handler + pure harness |
| 6 | (this report's commit) | README delta + this report (in-clone copy) |

All commits authored `Cato (Muse Eng) <cato@muse.local>`. Tree delta vs base: `lib/allocation/**` (7 files), `components/allocation/**` (4 files), `lib/sim/rules/allocation.ts` + `allocation.test.ts`, README, this report. **Ownership fence held:** no edits to `lib/sim/rules/registry.ts`, `firestore.rules`, `firestore.indexes.json`, `lib/sim/committer.ts`, or anything outside the module fence. Lead needs are §6.

## 1. Rebase record (prep §2.3)

The ahead stack (Phase 1 base `30f2a6a`) was replayed verbatim, not merged:

```
git remote add p4base ~/workspace/cowboy-city/phase4-clone   (path remote, fetched; origin untouched)
git rebase --onto fe7385c 30f2a6a p4/allocation-ui
```

**Zero conflicts** — the two bases' histories diverge only outside the module's files, as the prep predicted. The replayed delta is byte-identical in scope to the ahead delta (11 files, +1,405: the same 7 lib + 4 components files). Reconciliation deltas (P4-K15, P4-K14, handler) are separate commits on top, so the rebase record stays auditable. Note for the push: local SHAs diverge from remote by house rule — replay the delta onto current master, never the payloads of a stale base.

`node_modules` in this clone is a symlink to `phase4-clone`'s install (the rebased lockfile's install; node_modules is gitignored, so the symlink is local state only and does not ride the PR).

## 2. P4-K15 — canonical dedup (commit `48f5bbf`)

`lib/allocation/canonical.ts` is **deleted**. Phase 2's `lib/sim/canonical.ts` is pure TypeScript and isomorphic (sync `sha256Hex` over WebCrypto-free pure SHA-256), so the browser port is obsolete:

- `computeDraftHash(allocations, spentPoints)` now lives in `lib/allocation/draft.ts` as a sync helper over `sha256Hex` from `@/lib/sim/canonical`; `draftSave.ts` drops the `await`.
- `lib/allocation/index.ts` no longer exports the port.
- `validation.test.ts` keeps the golden-vector pin as the equivalence proof (TC-D04 / P4-G1-C1): `computeDraftHash({}, null)` and a direct `sha256Hex({allocations:{}, spentPoints:null})` both equal `EMPTY_DRAFT_HASH` = `a57492f8…603fe`. Browser draft-hash == fabric hash now holds **by construction** — one canonical module, imported by both sides.

## 3. P4-K14 — the contract fix (commit `fe07624`)

**Before:** the ahead module committed by a browser status write — `draftSave.requestAllocationCommit()` set `status: "commit_requested"` through the owner fence. Rules-legal under the Phase 1 fence; contract-wrong against brief §3; and **rules-refused** since Module 0 narrowed the fence (owner updates may target only `draft`).

**After — exactly one commit path exists:**

- `draft.ts`: `DraftSaveFields["status"]` is `"draft"` only; `buildCommitRequestFields` is deleted; the header documents the landed contract.
- `draftSave.ts`: keeps only `saveAllocationDraft`, which now **returns the written fields** so the commit flow binds the saved `draftVersion` + `draftHash`.
- **`lib/allocation/commitAction.ts` (new):**
  - `buildAllocationCommitPayload` — `{ cityId, allocations, draftVersion, draftHash }` (brief §3.3 step 1); throws unless the map is commit-grade, so the client never builds an action the fabric would refuse for shape reasons.
  - `buildAllocationCommitAction` — the born-`received` action doc via the landed `buildActionDoc` (`lib/sim/intake.ts`); `actionType: "allocate_season0"`, `targetCityIds: [cityId]`, member actor. Default `clientRequestId` = `allocate-season0:{cityId}:v{draftVersion}`, so the intake idempotency (`actionId = sha256(actorUid + ":" + clientRequestId)`) makes a retry the same action (TC-A04 pattern).
  - `submitAllocationCommitAction` — `getDoc` first, `setDoc` only if absent (a raw create over an existing action id would hit the `sim_actions` update clause and be refused; existing ⇒ return the existing id).
- **Editor (`AllocationEditor.tsx`):** the two-step no-respec confirmation is retained as presentation; its second step now (1) saves the final map as the head draft, then (2) submits the action binding the saved version + hash. Injectable prop renamed `onRequestCommit` → `onSubmitCommit` (nothing consumes the old prop yet). New local `submitted` lock + honest copy: the doc stays `draft` after submit; the committer flips `commit_requested` when it queues the confirmed action; the binding confirmation is the §2.3 never-bind card on the action's preview. CSS classes re-verified against the CURRENT `app/globals.css` (`.glass-panel`, `.btn`, `.btn-secondary`, `.form-input`, `.form-label` all present); no class changes were needed.
- `validation.test.ts` updated: commit-request-builder assertions replaced with commit-action pins (born-`received` shape, lifecycle fields null, payload identity, idempotent action id, not-committable throw).

## 4. The R-35 handler (commit `1ff64a0`)

`lib/sim/rules/allocation.ts` exports `allocationDescriptor` fitting the landed `RuleDescriptor` interface: id `R-35`, kinds `["allocate_season0"]`, visibility `public`, `requiresBaseline: false`, `mayCreatePendings: false`, handler + **readPlan hook**.

**Read path (the subtle part).** The landed resolver's base read paths deliberately EXCLUDE `sim_stat_allocations/{cityId}` ("no Phase 2 handler consumes it" — and the committer identity cannot read that collection; see §6.3). The descriptor's F-01 readPlan hook declares `sim_stat_allocations/{cityId}` and `sim_stat_allocations/{cityId}/versions/v1`, cityId from the action seed (`structuredAction.cityId ?? targetCityIds[0]`); `collectActionReadPlan` merges them into the snapshot set, so preview and commit read identically and the paths are in the manifest's input set.

**Validation battery** (deterministic order; all refusals are rejected plans with these codes):

| Check | Code |
|---|---|
| no target city / no city doc / no allocation doc | `NO_TARGET_CITY` / `NO_CITY` / `NO_ALLOCATION_DOC` |
| non-owner actor; shared city + non-mayor actor | `AUTHORITY_REVOKED` |
| status `committed` / `superseded` / other | `ALREADY_COMMITTED` / `ALLOCATION_SUPERSEDED` / `ALLOCATION_NOT_COMMITTABLE` (valid pre-states: `not_started`, `draft`, `commit_requested`) |
| `pointBudget !== 400` (Module 0 stamp missing) | `POOL_NOT_STAMPED` |
| payload missing/invalid draft binding fields | `MALFORMED_ALLOCATION` |
| payload draftVersion/draftHash ≠ saved draft | `STALE_DRAFT` (see note) |
| map not an object | `MALFORMED_ALLOCATION` |
| stock key present (`population`, `gdpRubars`, `treasuryRubars`, `households`, `housingUnits`) | `STOCK_NOT_ALLOCATABLE` |
| foreign key | `UNKNOWN_STAT_KEY` |
| one of the eight keys missing | `MISSING_STAT` (reading flagged, §6.5) |
| non-integer value | `NON_INTEGER_VALUE` |
| value outside [0, 80] | `VALUE_OUT_OF_BOUNDS` |
| sum 399 / 401 (any ≠ 400) | `SUM_NOT_EXACT` — message in R-35 form ("N unspent — … not banked" / "N over the pool") |
| sha256 over payload map ≠ payload draftHash | `DRAFT_HASH_MISMATCH` |
| `versions/v1` already exists over an uncommitted doc | `VERSION_EXISTS` |

*Stale note:* a `STALE_DRAFT` plan at wake has, by construction, a different plan hash than the confirmed preview, so the dispatcher takes the stale path (fresh preview, no Log entry — §3.4). The rejection only lands in the Log if a warned preview is confirmed anyway. That is the §3.4 discipline working as designed, not handler code — the handler just refuses deterministically.

**Commit plan (3 writes, 2 entries):**

1. `sim_cities/{cityId}` — `stats` = current stats overwritten by the eight final values. The rule-effect entry's eight `stats.<index>` changes hang off this doc (F-02 reconciliation resolves entry changes only against the entry city's docs, so the other two writes ride as writes + `recordsUpdated`/`recordsCreated`, not as entry changes).
2. `sim_stat_allocations/{cityId}` — `status: "committed"`, `allocations` = final map, `spentPoints: 400`, `commitActionId` = resolutionId (== actionId), `committedSeq` = the plan's summary seq, `committedByUid` = actor uid.
3. CREATE `sim_stat_allocations/{cityId}/versions/v1` — `{ cityId, source: "first_login", allocations, spentPoints: 400, draftVersion, draftHash, authorUid, previewHash: null, commitSeq, createdAt: null }` (`createdAt` is the committer's stamp on creates; `previewHash` is §6.4).

Entries: rule-effect (major, the eight changes + full-map text with pool/sum/baselineHash) + action-summary last (verb `commit-allocation`, scope `city`, ruleIds `["R-35"]`) — the TC-D04 anchor pair, i.e. the city's first Log entries (K-4). `commitSeq`/`committedSeq` = `snapshot.counterHead.lastSeq + plan.entries.length` — the same derivation `preview.ts` uses for `originSeqIfCommitted`, so preview and commit compute identical plans (harness-pinned: identical planHash in both modes).

**Authority mirror.** The handler does not runtime-import the registry (landed precedent: `pendingRules.ts`); `checkAllocationAuthority` mirrors `checkCityAuthority`'s semantics locally (faction `ownerUids` ∋ member/on-behalf uid). §6.7 offers the Lead a dedupe if preferred.

**Harness.** `lib/sim/rules/allocation.test.ts` (pure tsx, colocated like `lib/allocation/validation.test.ts`; not CI-wired) patches the descriptor into `RULE_DESCRIPTORS` + `ACTION_KIND_INDEX` in test code only — simulating the assembly edit — and drives the real `resolveAction` (so `validatePlan` runs on every case). Green: valid commit end-to-end (all write/entry/seq assertions), preview/commit planHash parity, the seven P4-G1-C3 cases with codes, missing-key, already-committed, superseded, stale (moved version; same-version/different-hash), hash-mismatch (incl. the unsaved-map-against-pristine-doc case), non-owner, shared-city member-refused vs shared-office-mayor-resolves, pool-unstamped, no-doc cases, `commit_requested` pre-state, and the cross-module pin (handler's eight == `lib/allocation`'s `ALLOCATABLE_STATS`, disjoint from the five stocks, all present in `templateStats()`).

## 5. Verification (all local, this clone, sibling install matching the rebased lockfile)

- `npx tsx lib/allocation/validation.test.ts` — all assertions passed (after commits 3 and 4).
- `npx tsx lib/sim/rules/allocation.test.ts` — all assertions passed.
- `npx tsc --noEmit` — clean at every commit.
- `npx eslint lib/allocation lib/sim/rules/allocation.ts lib/sim/rules/allocation.test.ts components/allocation` — clean.
- `npx next build` — passed at stack tip (exit 0; full route table emitted, no errors).
- The Firestore emulator cannot run in this sandbox; the rules/emulator battery (P4-G1-C3 via the real preview path, H-P45-3, the play-core additions) is CI's venue at assembly, as with every prior phase.

## 6. Lead assembly needs (in order)

1. **Registry slot.** Register `allocationDescriptor` from `lib/sim/rules/allocation.ts` in `RULE_DESCRIPTORS` (the `ACTION_KIND_INDEX` derivation then picks up `allocate_season0` automatically). One descriptor object; no other registry change. The play-core P4-G1 battery (C1 hash pin, C3 seven cases via the real preview path, C5 one-commit-ever + no-respec) wires against the registered descriptor at the same time.
2. **§12.4 index (rides this PR by Module 0's deferral).** Add to `firestore.indexes.json`, collection-group scope on `versions`: fields `cityId` ASC, `commitSeq` ASC. **The query it serves:** the allocation-history read — collection-group `versions` where `cityId == <cityId>` order by `commitSeq` asc (the stat-sheet/audit allocation-history surface; also undo/verification tooling that walks a city's version chain). The version doc carries a `cityId` field precisely so this index is real. (Module 0's own §12.3/§12.4 audit found no other Phase 4 index gap on landed shapes; this is the one deferred item.)
3. ⚠️ **Rules: fabric read of the allocation docs.** Landed `firestore.rules` reads `sim_stat_allocations/{cityId}` (and its `versions`) to `isAdmin() || simCityOwner(cityId)` only — **the fabric committer/service identity cannot read them**, yet the dispatcher must materialize the handler's declared read-plan paths and undo-restore transactions re-read the write set (the resolver source carries the same warning: "the committer identity cannot read that collection"). This is the Phase 2 P2-K16 pattern recurring: add a fabric read branch (`|| isFabricService()` or the current equivalent) to the allocations match and its versions subcollection. Member/guest semantics (draft privacy) are unchanged — the branch only admits the fabric identity. Handler work is unaffected; emulator test identities are the harness's concern at assembly.
4. **Version-doc `previewHash` — decision needed.** The handler writes `previewHash: null` in the version doc, necessarily: the confirmed preview's hash exists only on the action doc after preview, and embedding it in the plan is a hash fixpoint (plans must be byte-identical between preview and commit; §3.11 types the field `string | null`). The committer already records the true value in the resolution manifest (from `txAction.preview.previewHash`). Options: (a) accept `null` + manifest as authoritative (zero code), or (b) add a committer stamp for version-doc creates from the action's stored preview hash (insertion point: the manifest-summary mapping in `committer.ts`, beside the existing `previewHash` record). Either is defensible; the module takes no position beyond "the handler cannot write it". Do not let an assembler "fix" this inside the handler.
5. **`MISSING_STAT` reading.** The handler refuses a commit map missing any of the eight keys (brief §3.3 step 4: the commit "writes the eight index values"; a missing key would commit a city with a null founding index; the editor never emits partial maps). If Koda/the Lead prefer missing = 0, the flip is one branch in `validateAllocationCommitMap` — flagged here so the reading is ratified, not silently shipped.
6. **Shared-city mayor guard posture.** For `isSharedCity` cities the handler requires a `shared-office` actor with `office === "mayor"` and a memberId (CJ round 3: sitting mayor only). Verifying the memberId IS the sitting mayor needs Phase 7 terms data, which does not exist yet — the same posture `undo.ts` takes toward shared-office targets. The guard enforces the office shape now; the terms check slots in at Phase 7 without a contract change.
7. **Optional dedupe.** `checkAllocationAuthority` (allocation.ts) mirrors the registry's `checkCityAuthority` to keep the handler module cycle-free (pendingRules precedent). If the Lead prefers one copy, hoisting the registry helper into `planHelpers.ts` at assembly is a safe, behavior-identical move — author's hands off either way.
8. **README.** This PR carries its README delta in-clone (status paragraph + dated Changelog line, per CJ's rule) — the Lead should NOT need a separate README commit; if the assembly edit itself warrants a line, that's the Lead's call.
9. **Page wiring (for the Intake UI module, not the Lead).** The editor is not yet mounted on any page (unchanged from the ahead build — page wiring is step 2's territory). Its props: `cityId`, `cityName`, `authorUid`, `initialAllocations`, `initialStatus`, `initialDraftVersion`; the page derives the post-submit lock from doc status + any pending `allocate_season0` action; a page injecting `onSaveDraft` should inject `onSubmitCommit` (the default commit flow needs the saver's returned version/hash).

## 7. Residuals

- Version doc id is `v1` (matches the landed rules test's committer example and the §1.2 chain start).
- `authorUid` on the version doc falls back to the committing uid when the record's `authorUid` is null (defensive; normal flow always has the drafter).
- No emulator evidence exists for this module (sandbox limit, standing). Every assertion that can run pure has run pure; the rest is explicitly CI's venue at assembly (§5).

*This report also lives in-clone at `workstreams/p4-allocation-module-prep-report.md` (identical copy, for assembly parity with the Step 0 / Module 0 in-repo reports); the workspace copy at `~/workspace/cowboy-city/workstreams/` is the task-specified destination.*
