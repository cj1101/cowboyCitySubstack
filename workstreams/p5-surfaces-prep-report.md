# Phase 5 W4 prep report — Surfaces + ConfirmationCard (June, Muse UX)

**Branch:** `p5/surfaces` in `p5-surfaces-clone`, based on
`phase5/situations-assembled` tip `d36088d` (PR #40's stack, PR-3).
**NOT pushed.** Rafe assembles as PR-5; reconcile the base onto
PR-3's merged master when it lands — every W4 file is new UI
surface except the five shared files listed in §6, all low-conflict.

**Status: BUILT, NOT LIVE** (countersign A-2 — the PR body must
carry the built-not-live statement and the five P2-K15 chain
items; nothing in this branch touches production data, deploys
rules/indexes, or writes a genesis record).

---

## 1. Build record

Five commits on `p5/surfaces`:

| Commit | Contents |
|---|---|
| `7983ad0` | Presentation + client data layers (`lib/situations/present.ts`, `lib/situations/client.ts`, `lib/npcs/present.ts`, `lib/npcs/client.ts`) |
| `0c8927d` | Components (`components/sim/ActionRunner.tsx`, `ConfirmationCard.tsx`, `SpawnNpcForm.tsx` + `EnvelopeMarker`, `SituationCard.tsx`) |
| `360206f` | Pages (`app/situations/page.tsx`, `app/settings/npcs/page.tsx`) |
| `c6d4184` | Peek swap (P5-D7), Log NPC actor filter, §11.4 exports + wiring, NavBar/settings links, lint fixes |
| `af50987` | Review fixes (marker "Cancelled" state, composer city default, fire-stats conditional) |
| (this report) | Prep report commit |

Deliverables against the tasking:

1. **`app/situations/`** — one queue per owner, faceted per city
   (filter, not inboxes): facets Waiting on you / With a delegate /
   History; city facet incl. Personal; kind facet from kinds
   present; §6.2 order (severity, then oldest first) with
   owner-selectable secondary sorts persisted as a device-local
   display preference; finite pagination ("Show more", 20/page);
   empty queue renders exactly "Nothing is waiting on you." Cards
   (`SituationCard`) carry all three §6.3 decisions. The
   delegation-rules panel (§7.4) renders every rule as a sentence
   (`ruleSentence`), always-wait first (`sortRules`), the §7.2
   evaluation order as help text, the `handler authority changed`
   flag when the handler's current mandate no longer matches the
   cited one, best-effort fire stats from the Log, enable/disable
   via a fresh `delegationRule.set` version, and the composer —
   which calls **`validateDelegationRuleDraft` from
   `lib/sim/delegation.ts`, the same function the rules tests use**
   (no UI-side fork; violations render as Vera's one-sentence
   messages verbatim, and Save is unreachable while any exist).
2. **Peek swap (P5-D7)** — `loadSituationsPeek` in
   `lib/dashboard/panelData.ts` now reads `sim_situations` (waiting
   = open + awaiting_owner, §6.2 order, top 3) and links to
   `/situations`. Component, props, and registry entry are
   byte-unchanged; the panel's header comment now records the swap.
3. **`components/sim/SpawnNpcForm.tsx`** — one component; placement
   varies only by `threadRef`. Negotiation bounds block is
   required when the task type is negotiation (form refuses in one
   sentence: "No bounds, no spawn"); `mayCommit` renders as the
   fixed line "This NPC cannot commit you to anything" and the
   payload hardcodes `mayCommit: false`. The `EnvelopeMarker`
   renders the §2.6.1 thread states (spawned — awaiting fabric
   cycle / working / the one output, badged) plus cancel-before-
   claim. **`components/sim/ConfirmationCard.tsx`** — Petra §4.3:
   exactly one confirm (named for the act) + one decline, full
   consequence text (effects, authority citations as links,
   legal line, the always-present what-will-NOT-happen sentence,
   decline outcome) rendered before either control; no timeout, no
   auto-confirm. Wired live at the §7.3 delegation confirm step and
   the NPC retire gate; the binding itself still runs through the
   fabric's preview + hash-bound confirmation (`ActionRunner` over
   `lib/play/intake.ts`).
4. **`app/settings/npcs/`** — per owned city: team roster with the
   derived activity state rendered from the landed
   `deriveTeamActivity` (display, never a setting); NPC create
   (freeform name/title/scope/personality, character link or
   minted persona, starting-point examples that pre-fill text and
   store nothing); character edit (`npc.edit`); the permission-
   mode radio with all three contract paragraphs, the default read
   from **`DEFAULT_PERMISSION_MODE` in `lib/npcs/modes.ts`** (never
   hardcoded); mode changes submit `npc.setMode` (a mandate event,
   TC-N09 copy); mandate panel with Dana's three-part authority
   summary, version history with the **mandate hash read-only**,
   the §5.1 editor (freeform scope + structured scope, caps with
   action/seq-counted periods only — no wall-clock control,
   negotiation bounds, fixed Tier B block rendered not editable),
   revoke with immediacy copy; retire behind the §4.3 card. No
   delete control exists anywhere.
5. **Log page** — NPC actor filter (all NPC acts, or one NPC),
   composed with the existing city/kind/member filters; NPC
   entries badged `NPC 〈id〉, for 〈owner〉` (A-6 pattern) in
   `actorLabel`, which also feeds the existing export's actor
   column. **§11.4 exports** — `lib/export/datasets/phase5Data.ts`
   + `phase5Workbook.ts` (pure builders that re-assert requester
   scope and throw before any file exists) + `fetchPhase5Export.ts`
   (fetchers running the surfaces' own audience/owner-fenced
   reads); touchpoints on `/situations` (history workbook:
   Waiting + History tabs) and `/settings/npcs` (register: NPCs,
   Mandates, Delegation rules tabs), xlsx + CSV via the landed
   `deliverWorkbook`. The peek deliberately keeps NO export
   affordance (its component contract forbids one).

## 2. Contract notes vs PR-2 / PR-3 as built

- **All writes go through the play intake.** Every decision
  (handle / delegate / silence / rule set+toggle / spawn / cancel /
  npc.* / mandate.*) submits one governance action and follows the
  standard lifecycle via `ActionRunner`; surfaces never write
  `sim_*` collections directly, and NPC/delegated actors are never
  minted client-side (`memberActor` discipline preserved).
- **§7.3 delegation composition.** Authority summary → sim
  ConfirmationCard (§4.3 review gate) → `situation.delegate`
  submission → the fabric's own preview + hash-bound confirm. Two
  confirmations by design: the §4.3 card is the plan's "confirm
  delegation" step; the play loop's confirm is the binding one.
  Noted so the gate doesn't read it as duplication drift.
- **The handler never receives a nominated mandate version.**
  `situation.delegate` sends `{situationId, npcId, mandateId?}`
  only; the current version is read from the stored root
  handler-side, as built. The composer cites the handler NPC's
  CURRENT mandate id, read at compose time.
- **Two negotiation-bounds dialects** (both landed, both honored):
  envelopes carry the authority dialect (`{subject, mayOffer:
  entries[], mayAccept: entries[], walkAwayIf: string[], maxTurns}`)
  from `lib/authority/types.ts`; mandate versions carry the
  mandate dialect (`{mayOffer: string|null, …}`) from
  `lib/npcs/types.ts`. The spawn form and the mandate editor each
  collect their own dialect; nothing translates between them.
- **Landed-shape corrections the surfaces absorbed** (module types
  are authoritative over the brief's sketches): situation `detail`
  is a record (rendered as key/value lines), `createdSeq` is
  nullable, rule status is `pending|active|disabled|superseded`,
  rule caps are an open record, rule match city lists are nullable
  (toggles resubmit the stored payload verbatim so null ≠ [] is
  preserved), `SituationSource.kind` is a closed union (coerced).
- **Reads are equality-only query shapes** — the two §9.6-provable
  queue shapes, `ownerUid ==` for rules/NPCs, subcollection reads
  for mandate versions. No composite-index dependence was added;
  ordering is client-side per §6.2.

## 3. PR-evidence capture points for the gate PR (named, NOT captured)

Per countersign A-3 / A-5 / A-6 — the gate PR captures these from
the built site in its own environment; W4 names the screens/flows:

- **A-3 (P5-G2 Log→mandate click-through, both halves).**
  (a) `/log` with the NPC actor filter set → open an NPC-authored
  entry → its actor line ("NPC 〈id〉, for 〈owner〉") and mandate
  citation resolve to `/settings/npcs`, the NPC's mandate panel,
  showing the same mandate id, version, and hash. (b) Reverse:
  `/settings/npcs` version-history entry → the acts citing that
  version are the Log entries the NPC filter surfaces.
- **A-5 (P5-G11 render halves).** (a) Unknown-kind card: a
  situation whose `kind` is NOT in `STARTING_SITUATION_KINDS`
  rendered on `/situations` — generic card, city named, all three
  decisions present (Handle it myself / Delegate / Let it sit).
  (b) Silence-copy sweep over the rendered Situations surface:
  the Let-it-sit block ("…the Log records the non-response…"),
  the History facet's "Closed as silent. No response — 〈city〉's
  leader didn't say anything (seq N).", the empty-queue line.
  The sweep greps rendered text for the forbidden words (ignored /
  missed / overdue / failed to respond) — they must appear zero
  times in rendered copy. (They appear once in a code comment in
  `lib/situations/present.ts` NAMING them as forbidden — source,
  not render.)
- **A-6 (P5-G13 per-surface terminology sweep).** Rendered-text
  sweep for "NPC" (never "agent") + the "〈name〉, for 〈owner〉"
  badge at change prominence, per surface: **dashboard** (digest
  NPC entries + situations peek), **Log** (actor labels + filter),
  **digest** (same loader family as dashboard), **Situations**
  (delegate picker, handling citations, envelope marker badge),
  **settings** (`/settings/npcs` register, mode control, mandate
  summaries). W4's own source-level pre-sweep: `agent` occurs in
  **zero** added lines of this branch (verified by grep over the
  full diff).

## 4. Flags (undecided; for Rafe / Theo / Koda as marked)

- **F1 — Task-type field vs the module's closed set.** Brief
  §11.2 forbids closed enums in UI controls; the landed envelope
  builder refuses unknown task types (`TASK_TYPES`). The form
  threads it as free text + a datalist of the five accepted values
  labeled as examples, with the refusal arriving honestly in the
  preview. If CJ wants unknown types to fail AT the form, that is
  a copy/contract decision against the brief's openness rule —
  flagged, not resolved here.
- **F2 — One-off persona spawns are not spawnable as built.**
  Brief §2.5 permits `npcId: null` (one-off persona); the landed
  `envelope.spawn` handler requires a standing NPC record and
  refuses otherwise. The form therefore offers only the owner's
  active NPCs and says plainly why a persona label can't be tasked
  until it stands as an NPC (linking to Settings). Engine-side
  persona spawning is a fabric question for Vera/Rafe, not a UI
  fork — no surface-side workaround was built.
- **F3 — Declining a draft has no completing action kind.**
  Petra §3.3 routes `awaiting_owner` ──decline──► `handled`
  (handled-by-declining), but `markSituationHandled` is not an
  action kind in the landed registry — it fires inside another
  flow's resolution, and a bare decline has no such flow. The
  card therefore offers Handle-it-myself and Let-it-sit on
  awaiting_owner cards and states that the draft binds nothing on
  its own; the sim ConfirmationCard stands ready for the
  confirm/decline pair the moment the fabric's proposal record
  (the draft's confirmable act) has a client-readable shape —
  expected to resolve with PR-4's wake completion or a small
  follow-up kind. **Gate should not close P5-G11's confirmation
  half on W4 alone.**
- **F4 — Composer cannot prove sitting-mayor authority.** The
  shared validator refuses shared-city rules unless
  `authorIsSittingMayor`; no client-readable office record exists
  before the Phase 7 office build, so the composer passes `false`
  and shared-city rules are refused from this surface with the
  validator's own sentence. Honest refusal, not a silent skip —
  revisit when the office record is readable.
- **F5 — Design-doc drift (two wordings).** (a) npc-builder
  §6.1's multi-city roster prose vs the landed model (one NPC
  record serves one city; rosters derive per city) — surfaces
  follow the landed model. (b) §6.2's wireframe calls the
  mandate-holding team state "staffed"; the landed
  `deriveTeamActivity` names it `active` (staffed = active NPCs,
  no mandate). Surface copy follows the landed derivation. Both
  are design-doc wording fixes for June/Theo, no code impact.
- **F6 — `roleTemplate` deliberately unwritten.** The landed NPC
  record carries the field; design §2.2 rules the starting-point
  choice is never stored. The create form's examples strip
  pre-fills text only and never sends `roleTemplate` (records
  created from this surface carry `null`). If the gate wants the
  template label persisted as provenance, that reverses a design
  rule — Koda/Theo call.
- **F7 — Rule fire stats are best-effort.** §7.4's last-fired seq
  + fire count derive from a `classification.delegationRuleId`
  dot-path Log query; if the read fails (index posture), the panel
  renders no fire line rather than a confident zero. The gate's
  rules/index review should confirm the dot-path read posture in
  the emulator suite.
- **F8 — Mandate-editor bounds mirror.** The editor blocks save
  when a negotiation-ish allowed type lacks bounds (a client-side
  mirror of Vera §8.4 layer 1, so the refusal arrives before
  submit). The authoritative validation remains the module's at
  resolution; the mirror's substring heuristic (`negotiat|envoy`)
  can drift from the module's test — if the module's detection
  changes, update the mirror in the same PR.
- **F9 — Read caps.** Queue reads cap at 200 per query shape;
  rules at 100; NPCs at 100. Fine for the group's scale today;
  flagged for the scale review, not silently raised.
- **P5-D6 / A-7:** untouched — no surface in W4 deletes a mandate
  version or reaches inside an undo restore; the held-out
  assertion stays held out and PENDING for Koda.

## 5. Verification (local; CI is the emulator venue)

- `tsc --noEmit` — clean.
- `eslint` scoped to every new/changed file — clean (21
  unescaped-entity errors found and fixed in the repo's entity
  idiom; 3 unused-symbol warnings removed).
- `next build` — exit 0; `/situations` (11.7 kB) and
  `/settings/npcs` (8.26 kB) in the route table.
- Pure sibling battery — all green, landed counts unchanged:
  governance 54, situations 32, cat1 all, defense 12, chains 34,
  cat2 34, acq 14, market 27, lore 27.
- Terminology: zero occurrences of the word "agent" in any added
  line (full-diff grep); forbidden silence vocabulary appears
  only in the `present.ts` contract comment naming it forbidden.
- Emulator suites (rules matrix incl. P5-G9, npc-core per A-1)
  cannot run in this sandbox — CI on PR-5 is the venue; W4 adds
  no rules, indexes, or registry entries for them to catch, and
  the UI reads were written against the landed §9 fences.

## 6. Assembly list for Rafe (PR-5)

**New files:** `lib/situations/present.ts`,
`lib/situations/client.ts`, `lib/npcs/present.ts`,
`lib/npcs/client.ts`, `components/sim/ActionRunner.tsx`,
`components/sim/ConfirmationCard.tsx`,
`components/sim/SpawnNpcForm.tsx`,
`components/sim/SituationCard.tsx`, `app/situations/page.tsx`,
`app/settings/npcs/page.tsx`,
`lib/export/datasets/phase5Data.ts`,
`lib/export/datasets/phase5Workbook.ts`,
`lib/export/fetchPhase5Export.ts`,
`workstreams/p5-surfaces-prep-report.md` (this file).

**Shared files touched (small, reviewable):**
`lib/dashboard/panelData.ts` (peek loader swap + header bullet;
notifications imports removed — they had no other use in the
file), `components/dashboard/panels/SituationsPeekPanel.tsx`
(header comment only — the P5-D7 record), `app/log/page.tsx`
(NPC filter + actorLabel badge wording), `app/settings/page.tsx`
(one link block), `components/layout/NavBar.tsx` (one NAV_LINKS
entry — note the mobile menu and tabbar derive from separate
lists; only NAV_LINKS gained Situations).

**README (standing every-PR rule):** Phase 5 section gains the
PR-5 entry: Surfaces + ConfirmationCard — Situations queue live
at /situations (facets, three decisions, rules panel over the
shared composer validator), NPC settings at /settings/npcs
(modes, versioned mandates, teams), SpawnNpcForm +
ConfirmationCard components, peek reading the real queue, Log
NPC filter, §11.4 exports — **built, not live** + the five
P2-K15 chain items (A-2).

**Suggested PR-5 gate posture:** closes the W4 halves of P5-G10
(export half), P5-G11 (render halves land at capture time, §3 of
this report; the draft-confirm binding stays open per F3),
P5-G13 (source sweep clean; rendered sweep at capture). No
branch-protection changes; no new CI jobs.
