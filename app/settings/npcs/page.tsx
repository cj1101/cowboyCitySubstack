"use client";

/**
 * Settings → Your NPCs (Phase 5 brief §11.3; June design §§2–6).
 *
 * Character and authority are separate blocks here, because they
 * are separate things: the character is flavor and voice; the
 * mandate is a logged grant with caps. Creating with NO mandate is
 * a valid completion — the NPC exists, can be tasked by one-off
 * envelopes, and holds no standing authority.
 *
 * The permission-mode control is a three-option radio group with
 * each mode's contract written out — never a dropdown, never a
 * toggle. The default for a new NPC is read from the builder
 * default (`DEFAULT_PERMISSION_MODE`, P5-K3), not hardcoded here.
 * Changing a mode is a mandate event (it authors a new version
 * where a mandate stands), never a settings flip.
 *
 * Mandate authoring is versioned: saving authors the next version;
 * old versions stay in the record, cited by every act taken under
 * them; the mandate hash renders read-only. Periods are counted in
 * actions or Log entries — no wall-clock period control exists in
 * this UI, because this world has no clock that moves on its own.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { getAllFactions } from "@/lib/firestore/posts";
import type { Character, Faction } from "@/lib/types";
import type {
  PermissionMode,
  SimMandateRoot,
  SimMandateVersion,
  SimNpc,
  SimTeam,
} from "@/lib/npcs/types";
import { deriveTeamActivity } from "@/lib/npcs/npcs";
import {
  DEFAULT_PERMISSION_MODE,
  MODE_OPTIONS,
  NEXT_CYCLE_LINE,
  RETIRE_CONSEQUENCES,
  authoritySummary,
  modeShortLabel,
  teamActivityLine,
} from "@/lib/npcs/present";
import {
  loadCharactersForCity,
  loadMandateRoot,
  loadMandateVersions,
  loadMyNpcs,
  loadTeam,
  submitMandateRevoke,
  submitMandateSet,
  submitNpcCreate,
  submitNpcEdit,
  submitNpcRetire,
  submitNpcSetMode,
} from "@/lib/npcs/client";
import { ActionRunner } from "@/components/sim/ActionRunner";
import { ConfirmationCard } from "@/components/sim/ConfirmationCard";
import { downloadNpcRegister } from "@/lib/export/fetchPhase5Export";
import { actionError } from "@/lib/async";

/**
 * §11.4 export touchpoint: the owner's NPC / mandate / rule
 * register as a downloadable workbook. Scope is provable by
 * construction (owner-scoped reads; the builder re-asserts
 * ownership of every row) — the download fails closed with the
 * reason rather than producing a partial file.
 */
function RegisterExportControls({ uid }: { uid: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const run = async (format: "xlsx" | "csv") => {
    setBusy(true);
    setNote("");
    try {
      await downloadNpcRegister(uid, format);
      setNote("Your NPC register downloaded.");
    } catch (err) {
      setNote(actionError(err, "The export was refused — nothing was downloaded."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 mt-4">
      <span className="text-sm text-text-muted">Export my NPC register:</span>
      <button
        type="button"
        className="btn btn-secondary text-sm px-4 py-2"
        disabled={busy}
        onClick={() => void run("xlsx")}
      >
        Excel (.xlsx)
      </button>
      <button
        type="button"
        className="btn btn-secondary text-sm px-4 py-2"
        disabled={busy}
        onClick={() => void run("csv")}
      >
        CSV
      </button>
      {note && (
        <span className="text-sm text-text-muted" role="status">
          {note}
        </span>
      )}
    </div>
  );
}

interface MandateBundle {
  root: SimMandateRoot;
  versions: SimMandateVersion[];
}

const STARTING_POINTS: { label: string; title: string; scope: string }[] = [
  {
    label: "Steward",
    title: "Steward",
    scope: "Runs the household side of the city: triages routine matters and keeps the day-to-day moving.",
  },
  {
    label: "Treasurer",
    title: "Treasurer",
    scope: "Keeps the books and budgets; pays named budgeted costs inside the caps and flags threshold crossings.",
  },
  {
    label: "Envoy",
    title: "Envoy",
    scope: "Carries the city's words to other cities and negotiates inside written bounds — never beyond them.",
  },
  {
    label: "Analyst",
    title: "Analyst",
    scope: "Reads what the city can see and writes briefings. No action authority unless a mandate grants it.",
  },
  {
    label: "Counsel",
    title: "Counsel",
    scope: "Drafts texts and acknowledges cases. Nothing case-like resolves through counsel.",
  },
];

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function parseOptionalInt(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : null;
}

export default function NpcSettingsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [factions, setFactions] = useState<Faction[]>([]);
  const [npcs, setNpcs] = useState<SimNpc[]>([]);
  const [teams, setTeams] = useState<Map<string, SimTeam | null>>(new Map());
  const [mandates, setMandates] = useState<Map<string, MandateBundle>>(new Map());
  const [charactersByCity, setCharactersByCity] = useState<
    Map<string, Character[]>
  >(new Map());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const list = await getAllFactions();
      setFactions(list);
      const owned = list
        .filter((f) => f.ownerUids.includes(user.uid))
        .map((f) => f.id);
      const npcRows = await loadMyNpcs(user.uid);
      setNpcs(npcRows);
      const teamMap = new Map<string, SimTeam | null>();
      const charMap = new Map<string, Character[]>();
      await Promise.all(
        owned.map(async (cityId) => {
          teamMap.set(cityId, await loadTeam(cityId));
          charMap.set(cityId, await loadCharactersForCity(cityId));
        })
      );
      setTeams(teamMap);
      setCharactersByCity(charMap);
      const mandateMap = new Map<string, MandateBundle>();
      await Promise.all(
        npcRows
          .filter((npc) => npc.currentMandateId)
          .map(async (npc) => {
            const root = await loadMandateRoot(npc.currentMandateId as string);
            if (!root) return;
            const versions = await loadMandateVersions(root.mandateId);
            mandateMap.set(npc.npcId, { root, versions });
          })
      );
      setMandates(mandateMap);
      setLoadError("");
    } catch (err) {
      setLoadError(actionError(err, "Your NPCs could not be read as your account."));
    } finally {
      setLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const cityName = useCallback(
    (cityId: string) => factions.find((f) => f.id === cityId)?.name ?? cityId,
    [factions]
  );

  const ownedCities = useMemo(
    () =>
      user
        ? factions.filter((f) => f.ownerUids.includes(user.uid))
        : [],
    [factions, user]
  );

  if (!user) return <ScreenStatus>Sign in to manage your NPCs.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="glass-panel p-6">
          <p className="text-sm">
            <Link href="/settings" className="text-accent-gold underline">
              ← Settings
            </Link>
          </p>
          <h1 className="text-3xl font-bold text-accent-gold mt-2">Your NPCs</h1>
          <p className="text-text-muted mt-2">
            NPCs are yours: you create them, give them their character, and
            decide — in writing, in a mandate — what they may do on your
            behalf. Everything they do is logged as theirs, for you. Matters
            waiting on decisions live in{" "}
            <Link href="/situations" className="text-accent-gold underline">
              Situations
            </Link>
            .
          </p>
          <RegisterExportControls uid={user.uid} />
        </header>

        {loadError && (
          <p role="alert" className="glass-panel p-4 text-sm">
            {loadError}
          </p>
        )}

        {!loaded ? (
          <p className="text-text-muted">Reading your NPCs…</p>
        ) : ownedCities.length === 0 ? (
          <p className="glass-panel p-6">
            You don&rsquo;t own a city yet — NPCs serve a city, so there is nowhere
            for one to stand until you do.
          </p>
        ) : (
          ownedCities.map((city) => {
            const cityNpcs = npcs.filter((npc) => npc.cityId === city.id);
            const npcsById = new Map(cityNpcs.map((npc) => [npc.npcId, npc]));
            const team = teams.get(city.id) ?? null;
            const activity = deriveTeamActivity(
              team ?? {
                cityId: city.id,
                npcIds: cityNpcs.map((n) => n.npcId),
                leadNpcId: null,
                displayNote: null,
                stateVersion: 0,
                lastChangedSeq: null,
                createdAt: new Date(0),
                updatedAt: new Date(0),
              },
              npcsById
            );
            return (
              <section key={city.id} className="glass-panel p-6 flex flex-col gap-4">
                <div>
                  <h2 className="text-2xl font-bold text-accent-gold">
                    {city.name} — management team
                  </h2>
                  <p className="text-sm text-text-muted mt-1">
                    {teamActivityLine(activity, city.name)} This state is
                    derived from the team&rsquo;s mandates — it is a display, not a
                    setting.
                  </p>
                </div>

                {cityNpcs.length === 0 ? (
                  <p className="text-sm">
                    No NPCs serve {city.name} yet. Matters for {city.name}{" "}
                    wait for you — and waiting is a complete outcome.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {cityNpcs.map((npc) => (
                      <NpcDetail
                        key={npc.npcId}
                        npc={npc}
                        cityName={city.name}
                        mandate={mandates.get(npc.npcId) ?? null}
                        factions={factions}
                        cityNameOf={cityName}
                        onChanged={() => void refresh()}
                      />
                    ))}
                  </div>
                )}

                <CreateNpcForm
                  city={city}
                  characters={(charactersByCity.get(city.id) ?? []).filter(
                    (c) => !cityNpcs.some((npc) => npc.characterId === c.id)
                  )}
                  onChanged={() => void refresh()}
                />
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// One NPC: character block, mode control, mandate panel, retire.
// ---------------------------------------------------------------------

function NpcDetail(props: {
  npc: SimNpc;
  cityName: string;
  mandate: MandateBundle | null;
  factions: Faction[];
  cityNameOf: (cityId: string) => string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const { npc, mandate } = props;
  const [editing, setEditing] = useState(false);
  const [showMandateEditor, setShowMandateEditor] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [retireSubmitted, setRetireSubmitted] = useState(false);
  const [modeChoice, setModeChoice] = useState<PermissionMode>(npc.permissionMode);

  const currentVersion = mandate
    ? (mandate.versions.find((v) => v.version === mandate.root.currentVersion) ??
      mandate.versions[mandate.versions.length - 1] ??
      null)
    : null;

  return (
    <article className="rounded border border-darker-brown p-4 flex flex-col gap-3">
      <header>
        <h3 className="font-bold text-lg">
          {npc.displayNameSnapshot} — {npc.titleFreeform}
        </h3>
        <p className="text-sm text-text-muted">
          {modeShortLabel(npc.permissionMode)} ({npc.permissionMode})
          {currentVersion ? ` · mandate v${currentVersion.version}` : " · no standing mandate"}
          {" · "}
          {npc.status === "active"
            ? `active${npc.activationSeq !== null ? ` since seq ${npc.activationSeq}` : ""}`
            : npc.status === "retired"
              ? "retired"
              : "pending activation — the fabric activates NPCs when their creation resolves"}
        </p>
        <p className="text-sm mt-1">{npc.scopeFreeform}</p>
        {(npc.personality.traits.length > 0 ||
          npc.personality.voiceNotes ||
          npc.personality.characterNotes) && (
          <p className="text-sm text-text-muted mt-1">
            {npc.personality.traits.length > 0 &&
              `Traits: ${npc.personality.traits.join(", ")}. `}
            {npc.personality.voiceNotes ? `Voice: ${npc.personality.voiceNotes} ` : ""}
            {npc.personality.characterNotes ?? ""}
          </p>
        )}
      </header>

      {npc.status !== "retired" && user && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Close character editor" : "Edit character"}
          </button>
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            onClick={() => setShowMandateEditor(!showMandateEditor)}
          >
            {showMandateEditor
              ? "Close mandate editor"
              : currentVersion
                ? "Author a new mandate version"
                : "Give a mandate"}
          </button>
        </div>
      )}

      {editing && user && (
        <NpcEditForm npc={npc} onChanged={props.onChanged} />
      )}

      {/* ——— Permission mode (a mandate event, not a flip) ——— */}
      {npc.status !== "retired" && user && (
        <fieldset className="rounded border border-darker-brown p-3 flex flex-col gap-2">
          <legend className="font-bold px-1">
            When something pops up in {npc.displayNameSnapshot}&rsquo;s scope, they may:
          </legend>
          {MODE_OPTIONS.map((option) => (
            <label key={option.mode} className="flex gap-2 items-start text-sm">
              <input
                type="radio"
                name={`mode-${npc.npcId}`}
                className="mt-1"
                checked={modeChoice === option.mode}
                onChange={() => setModeChoice(option.mode)}
              />
              <span>
                <strong className="uppercase">{option.label}</strong>{" "}
                <span className="text-text-muted text-xs">({option.mode})</span>
                <br />
                {option.paragraph}
              </span>
            </label>
          ))}
          {modeChoice !== npc.permissionMode && (
            <>
              <p className="text-sm text-text-muted">
                Changing the mode authors a new mandate version
                {currentVersion ? " (the current one stays in the record)" : ""}{" "}
                and {NEXT_CYCLE_LINE.toLowerCase()} It applies to the next
                trigger evaluation — it does not reach back into a delegation
                already in flight.
              </p>
              <ActionRunner
                ctaLabel={`Set mode: ${modeShortLabel(modeChoice)}`}
                cityName={props.cityNameOf}
                onResolved={props.onChanged}
                submit={() =>
                  submitNpcSetMode(user.uid, npc.npcId, modeChoice, npc.cityId)
                }
              />
            </>
          )}
        </fieldset>
      )}

      {/* ——— Mandate ——— */}
      <div className="rounded border border-darker-brown p-3 flex flex-col gap-2">
        <h4 className="font-bold">Mandate</h4>
        {mandate && currentVersion ? (
          <>
            <p className="text-sm">
              {authoritySummary(npc.displayNameSnapshot, currentVersion)}
            </p>
            <p className="text-xs text-text-muted">
              Mandate v{currentVersion.version} · status {mandate.root.status}
              {currentVersion.effectiveSeq !== null
                ? ` · effective at seq ${currentVersion.effectiveSeq}`
                : " · pending — takes effect when the fabric commits it"}
              <br />
              Mandate hash (read-only):{" "}
              <code title={currentVersion.mandateHash}>
                {currentVersion.mandateHash.slice(0, 16)}…
              </code>
            </p>
            {mandate.versions.length > 0 && (
              <details>
                <summary className="text-sm text-accent-gold cursor-pointer">
                  Version history ({mandate.versions.length})
                </summary>
                <ul className="text-sm mt-2 flex flex-col gap-1">
                  {mandate.versions.map((version) => (
                    <li key={version.version}>
                      v{version.version} · {modeShortLabel(version.permissionMode)}
                      {version.effectiveSeq !== null
                        ? ` · effective seq ${version.effectiveSeq}`
                        : " · never took effect"}
                      {version.supersededSeq !== null
                        ? ` · superseded at seq ${version.supersededSeq}`
                        : ""}
                      {" · hash "}
                      <code title={version.mandateHash}>
                        {version.mandateHash.slice(0, 12)}…
                      </code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {mandate.root.status !== "revoked" && user && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-text-muted">
                  Revoking ends this mandate&rsquo;s authority. {NEXT_CYCLE_LINE}{" "}
                  Revocation never rewrites or deletes any version.
                </p>
                <ActionRunner
                  subtle
                  ctaLabel={`Revoke ${npc.displayNameSnapshot}'s mandate`}
                  cityName={props.cityNameOf}
                  onResolved={props.onChanged}
                  submit={() =>
                    submitMandateRevoke(user.uid, mandate.root.mandateId, npc.cityId)
                  }
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm">
            {authoritySummary(npc.displayNameSnapshot, null)}
          </p>
        )}
        {showMandateEditor && user && (
          <MandateEditor
            npc={npc}
            root={mandate?.root ?? null}
            currentVersion={currentVersion}
            factions={props.factions}
            cityNameOf={props.cityNameOf}
            onDone={() => {
              setShowMandateEditor(false);
              props.onChanged();
            }}
          />
        )}
      </div>

      {/* ——— Retire ——— */}
      {npc.status !== "retired" && user && (
        <div className="flex flex-col gap-2">
          {!confirmRetire && !retireSubmitted && (
            <button
              type="button"
              className="btn btn-secondary min-h-11 self-start"
              onClick={() => setConfirmRetire(true)}
            >
              Retire {npc.displayNameSnapshot}
            </button>
          )}
          {confirmRetire && !retireSubmitted && (
            <ConfirmationCard
              title={`Retire ${npc.displayNameSnapshot}`}
              proposedBy={`${npc.displayNameSnapshot}, for you · ${props.cityName}`}
              authority={[{ label: "your instruction, as the owner" }]}
              effects={[
                "Trigger matching stops before the next fabric cycle.",
                "Envelopes already claimed finish or fail on their own terms.",
                "The record and its full history remain — retirement is a state, never a deletion.",
              ]}
              notHappening="Nothing they already did is undone, and no record is deleted — there is no delete control for an NPC, anywhere."
              declineOutcome="Declining keeps them on the team exactly as they are."
              confirmLabel={`Retire ${npc.displayNameSnapshot}`}
              onDecline={() => setConfirmRetire(false)}
              onConfirm={() => setRetireSubmitted(true)}
            />
          )}
          {retireSubmitted && (
            <ActionRunner
              autoStart
              ctaLabel="Retire"
              cityName={props.cityNameOf}
              onResolved={props.onChanged}
              submit={() => submitNpcRetire(user.uid, npc.npcId, npc.cityId)}
            />
          )}
          <p className="text-xs text-text-muted">{RETIRE_CONSEQUENCES}</p>
        </div>
      )}
    </article>
  );
}

function NpcEditForm(props: { npc: SimNpc; onChanged: () => void }) {
  const { user } = useAuth();
  const { npc } = props;
  const [name, setName] = useState(npc.displayNameSnapshot);
  const [title, setTitle] = useState(npc.titleFreeform);
  const [scope, setScope] = useState(npc.scopeFreeform);
  const [traits, setTraits] = useState(npc.personality.traits.join("\n"));
  const [voiceNotes, setVoiceNotes] = useState(npc.personality.voiceNotes ?? "");
  const [characterNotes, setCharacterNotes] = useState(
    npc.personality.characterNotes ?? ""
  );
  if (!user) return null;
  return (
    <div className="rounded border border-darker-brown p-3 flex flex-col gap-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Name</span>
        <input className="form-input min-h-11" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Title / role (free text — any title in the lore is fine; there is no list)</span>
        <input className="form-input min-h-11" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Scope — in your words</span>
        <textarea className="form-input" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Traits (one per line)</span>
        <textarea className="form-input" rows={2} value={traits} onChange={(e) => setTraits(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Voice notes</span>
        <textarea className="form-input" rows={2} value={voiceNotes} onChange={(e) => setVoiceNotes(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Character notes</span>
        <textarea className="form-input" rows={2} value={characterNotes} onChange={(e) => setCharacterNotes(e.target.value)} />
      </label>
      <ActionRunner
        ctaLabel="Save character changes"
        cityName={(id) => id}
        onResolved={props.onChanged}
        submit={() =>
          submitNpcEdit(
            user.uid,
            {
              npcId: npc.npcId,
              displayNameSnapshot: name.trim(),
              titleFreeform: title.trim(),
              scopeFreeform: scope.trim(),
              personality: {
                traits: linesToList(traits),
                voiceNotes: voiceNotes.trim() === "" ? null : voiceNotes.trim(),
                characterNotes:
                  characterNotes.trim() === "" ? null : characterNotes.trim(),
              },
            },
            npc.cityId
          )
        }
      />
      <p className="text-xs text-text-muted">
        Character edits are yours any time. They never change authority — that
        is the mandate below.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// The mandate editor (design §5.1): one editor for creation and for
// every later version.
// ---------------------------------------------------------------------

function MandateEditor(props: {
  npc: SimNpc;
  root: SimMandateRoot | null;
  currentVersion: SimMandateVersion | null;
  factions: Faction[];
  cityNameOf: (cityId: string) => string;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const { npc, currentVersion } = props;
  const [mode, setMode] = useState<PermissionMode>(
    currentVersion?.permissionMode ?? npc.permissionMode
  );
  const [scope, setScope] = useState(
    currentVersion?.scopeFreeform ?? npc.scopeFreeform
  );
  const [triggerKinds, setTriggerKinds] = useState(
    (currentVersion?.structuredScope.triggerKinds ?? []).join("\n")
  );
  const [allowedTypes, setAllowedTypes] = useState(
    (currentVersion?.structuredScope.allowedActionTypes ?? []).join("\n")
  );
  const [namedRecords, setNamedRecords] = useState(
    (currentVersion?.structuredScope.namedRecordIds ?? []).join("\n")
  );
  const [restrictCounterparties, setRestrictCounterparties] = useState(
    currentVersion?.structuredScope.counterpartyCityIds !== null &&
      currentVersion?.structuredScope.counterpartyCityIds !== undefined
  );
  const [counterpartyCityIds, setCounterpartyCityIds] = useState<string[]>(
    currentVersion?.structuredScope.counterpartyCityIds ?? []
  );
  const [perAction, setPerAction] = useState(
    currentVersion?.caps.perActionRubars?.toString() ?? ""
  );
  const [perPeriod, setPerPeriod] = useState(
    currentVersion?.caps.perResolutionPeriodRubars?.toString() ?? ""
  );
  const [periodKind, setPeriodKind] = useState<"actions" | "seqWindow">(
    currentVersion?.caps.periodDefinition?.kind ?? "actions"
  );
  const [periodCount, setPeriodCount] = useState(
    currentVersion?.caps.periodDefinition?.count?.toString() ?? "20"
  );
  const [maxPhase, setMaxPhase] = useState(
    currentVersion?.caps.maxProjectPhase?.toString() ?? ""
  );
  const [allowPartial, setAllowPartial] = useState(
    currentVersion?.caps.allowPartialExecution ?? false
  );
  const [boundsOffer, setBoundsOffer] = useState(
    typeof currentVersion?.negotiationBounds?.mayOffer === "string"
      ? currentVersion.negotiationBounds.mayOffer
      : ""
  );
  const [boundsAccept, setBoundsAccept] = useState(
    typeof currentVersion?.negotiationBounds?.mayAccept === "string"
      ? currentVersion.negotiationBounds.mayAccept
      : ""
  );
  const [boundsWalkAway, setBoundsWalkAway] = useState(
    currentVersion?.negotiationBounds?.walkAwayIf ?? ""
  );
  const [boundsTurns, setBoundsTurns] = useState(
    currentVersion?.negotiationBounds?.maxTurns?.toString() ?? ""
  );
  const [alwaysEscalate, setAlwaysEscalate] = useState(
    (currentVersion?.alwaysEscalate ?? []).join("\n")
  );
  const [responseStyle, setResponseStyle] = useState(
    currentVersion?.responseStyle ?? ""
  );
  const [expiresAtSeq, setExpiresAtSeq] = useState(
    currentVersion?.expiresAtSeq?.toString() ?? ""
  );
  const [horizon, setHorizon] = useState(
    currentVersion?.horizonActions?.toString() ?? ""
  );

  if (!user) return null;

  const allowedList = linesToList(allowedTypes);
  const touchesNegotiation = allowedList.some((t) =>
    /negotiat|envoy/i.test(t)
  );
  const hasBounds =
    boundsOffer.trim() !== "" ||
    boundsAccept.trim() !== "" ||
    boundsWalkAway.trim() !== "" ||
    boundsTurns.trim() !== "";
  const boundsRefusal =
    touchesNegotiation && !hasBounds
      ? "This mandate lets the NPC negotiate, so it needs negotiation bounds — no bounds, no save."
      : null;
  const nextVersion = (props.root?.currentVersion ?? 0) + 1;

  const buildPayload = (): Record<string, unknown> => ({
    mandateId: props.root?.mandateId ?? newId(),
    npcId: npc.npcId,
    permissionMode: mode,
    scopeFreeform: scope.trim(),
    structuredScope: {
      triggerKinds: linesToList(triggerKinds),
      allowedActionTypes: allowedList,
      namedRecordIds: linesToList(namedRecords),
      counterpartyCityIds: restrictCounterparties ? counterpartyCityIds : null,
    },
    caps: {
      perActionRubars: parseOptionalInt(perAction),
      perResolutionPeriodRubars: parseOptionalInt(perPeriod),
      periodDefinition:
        perPeriod.trim() === ""
          ? null
          : { kind: periodKind, count: parseOptionalInt(periodCount) ?? 20 },
      maxProjectPhase: parseOptionalInt(maxPhase),
      allowPartialExecution: allowPartial,
    },
    negotiationBounds: hasBounds
      ? {
          mayOffer: boundsOffer.trim() === "" ? null : boundsOffer.trim(),
          mayAccept: boundsAccept.trim() === "" ? null : boundsAccept.trim(),
          walkAwayIf: boundsWalkAway.trim() === "" ? null : boundsWalkAway.trim(),
          maxTurns: parseOptionalInt(boundsTurns),
        }
      : null,
    alwaysEscalate: linesToList(alwaysEscalate),
    responseStyle: responseStyle.trim() === "" ? null : responseStyle.trim(),
    expiresAtSeq: parseOptionalInt(expiresAtSeq),
    horizonActions: parseOptionalInt(horizon),
  });

  return (
    <div className="rounded border border-accent-gold p-3 flex flex-col gap-3 text-sm">
      <h5 className="font-bold">
        Mandate for {npc.displayNameSnapshot} — new version (will be v
        {nextVersion})
      </h5>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted">Permission mode under this version</legend>
        {MODE_OPTIONS.map((option) => (
          <label key={option.mode} className="flex gap-2 items-start">
            <input
              type="radio"
              name={`mandate-mode-${npc.npcId}`}
              className="mt-1"
              checked={mode === option.mode}
              onChange={() => setMode(option.mode)}
            />
            <span>
              <strong className="uppercase">{option.label}</strong>{" "}
              <span className="text-text-muted text-xs">({option.mode})</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Scope (your words — part of the mandate record, shown to anyone auditing their acts)</span>
        <textarea className="form-input" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Watches for — trigger kinds (one per line)</span>
          <textarea className="form-input" rows={3} value={triggerKinds} onChange={(e) => setTriggerKinds(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">May resolve — action types (one per line)</span>
          <textarea className="form-input" rows={3} value={allowedTypes} onChange={(e) => setAllowedTypes(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Named records they may act on (one per line)</span>
          <textarea className="form-input" rows={3} value={namedRecords} onChange={(e) => setNamedRecords(e.target.value)} />
        </label>
      </div>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-text-muted">Counterparties</legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={restrictCounterparties}
            onChange={(e) => setRestrictCounterparties(e.target.checked)}
          />
          Restrict to named counterparty cities (unchecked = no restriction beyond fairness and sovereignty)
        </label>
        {restrictCounterparties && (
          <div className="flex flex-wrap gap-2">
            {props.factions
              .filter((f) => f.id !== npc.cityId)
              .map((faction) => (
                <label key={faction.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={counterpartyCityIds.includes(faction.id)}
                    onChange={(e) =>
                      setCounterpartyCityIds((current) =>
                        e.target.checked
                          ? [...current, faction.id]
                          : current.filter((id) => id !== faction.id)
                      )
                    }
                  />
                  {faction.name}
                </label>
              ))}
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted">Caps</legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Per action (Rubars)</span>
            <input className="form-input min-h-11" value={perAction} onChange={(e) => setPerAction(e.target.value)} inputMode="numeric" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Per period (Rubars)</span>
            <input className="form-input min-h-11" value={perPeriod} onChange={(e) => setPerPeriod(e.target.value)} inputMode="numeric" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Max project phase</span>
            <input className="form-input min-h-11" value={maxPhase} onChange={(e) => setMaxPhase(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        {perPeriod.trim() !== "" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-text-muted">A period is</span>
            <input className="form-input w-24" value={periodCount} onChange={(e) => setPeriodCount(e.target.value)} inputMode="numeric" aria-label="Period length" />
            <select className="form-input w-44" value={periodKind} onChange={(e) => setPeriodKind(e.target.value as "actions" | "seqWindow")} aria-label="Period unit">
              <option value="actions">actions</option>
              <option value="seqWindow">Log entries</option>
            </select>
          </div>
        )}
        <p className="text-xs text-text-muted">
          Periods are counted in actions or Log entries — this world has no
          clock that moves on its own, so there is no &ldquo;per week.&rdquo; A spending
          permission without both caps filled will be refused when it is
          previewed.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />
          Allow partial execution (an over-cap attempt executes up to the cap instead of being refused whole and escalated)
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted">
          Negotiation bounds (required if this NPC negotiates)
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">May offer…</span>
            <input className="form-input min-h-11" value={boundsOffer} onChange={(e) => setBoundsOffer(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">May accept…</span>
            <input className="form-input min-h-11" value={boundsAccept} onChange={(e) => setBoundsAccept(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Walk away if…</span>
            <input className="form-input min-h-11" value={boundsWalkAway} onChange={(e) => setBoundsWalkAway(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Max turns</span>
            <input className="form-input min-h-11" value={boundsTurns} onChange={(e) => setBoundsTurns(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        {boundsRefusal && (
          <p role="alert" className="text-red-300">
            {boundsRefusal}
          </p>
        )}
      </fieldset>

      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Always escalate to me (one per line — in addition to the fixed list below)</span>
        <textarea className="form-input" rows={2} value={alwaysEscalate} onChange={(e) => setAlwaysEscalate(e.target.value)} />
      </label>
      <p className="text-xs text-text-muted">
        Fixed by the rules, cannot be removed: sign, accept, or adopt
        anything; spend above caps; touch another city&rsquo;s anything; write
        canon. A mandate that purported to authorize one of those would be
        refused when previewed — they are listed here so the refusal never
        surprises you.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Response style (optional)</span>
          <input className="form-input min-h-11" value={responseStyle} onChange={(e) => setResponseStyle(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Expires at Log seq (optional)</span>
          <input className="form-input min-h-11" value={expiresAtSeq} onChange={(e) => setExpiresAtSeq(e.target.value)} inputMode="numeric" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Ask me to renew after N delegated resolutions (optional)</span>
          <input className="form-input min-h-11" value={horizon} onChange={(e) => setHorizon(e.target.value)} inputMode="numeric" />
        </label>
      </div>

      <p className="text-sm text-text-muted">
        Saving authors mandate v{nextVersion}.{" "}
        {props.root
          ? `v${props.root.currentVersion} stays in the record, cited by every act taken under it.`
          : "Until the fabric commits it, this mandate is pending and grants nothing."}
      </p>
      {boundsRefusal ? (
        <button type="button" className="btn min-h-11" disabled>
          Save as v{nextVersion}
        </button>
      ) : (
        <ActionRunner
          ctaLabel={`Save as v${nextVersion}`}
          cityName={props.cityNameOf}
          onResolved={props.onDone}
          submit={() => submitMandateSet(user.uid, buildPayload(), npc.cityId)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Create an NPC (design §2): who they are → what they cover → the
// mode. No mandate is forced: creating with none is a valid
// completion.
// ---------------------------------------------------------------------

function CreateNpcForm(props: {
  city: Faction;
  characters: Character[];
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [characterId, setCharacterId] = useState<string>("");
  const [scope, setScope] = useState("");
  const [traits, setTraits] = useState("");
  const [voiceNotes, setVoiceNotes] = useState("");
  const [characterNotes, setCharacterNotes] = useState("");
  const [mode, setMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE);
  const [problem, setProblem] = useState<string | null>(null);

  if (!user) return null;
  if (!openForm) {
    return (
      <button
        type="button"
        className="btn min-h-11 self-start"
        onClick={() => setOpenForm(true)}
      >
        Create an NPC for {props.city.name}
      </button>
    );
  }

  const ready = name.trim() !== "" && title.trim() !== "" && scope.trim() !== "";

  return (
    <div className="border-t border-primary-brown pt-4 flex flex-col gap-3 text-sm">
      <h3 className="font-bold">New NPC for {props.city.name}</h3>

      <div className="flex flex-col gap-1">
        <span className="text-text-muted">Starting points, if you want one</span>
        <div className="flex flex-wrap gap-2">
          {STARTING_POINTS.map((point) => (
            <button
              key={point.label}
              type="button"
              className="btn btn-secondary text-sm px-3 py-1"
              onClick={() => {
                setTitle(point.title);
                setScope(point.scope);
              }}
            >
              {point.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted">
          These are examples other owners have used — inspiration, not a menu.
          Using one fills the fields below with editable text. Nothing about
          the choice is stored: there is no &ldquo;type&rdquo; on an NPC.
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Name *</span>
        <input className="form-input min-h-11" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Title / role * (free text — any title in the lore is fine; there is no list)</span>
        <input className="form-input min-h-11" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Persona</span>
        <select
          className="form-input min-h-11"
          value={characterId}
          onChange={(e) => setCharacterId(e.target.value)}
        >
          <option value="">A new persona (minted with this NPC)</option>
          {props.characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name}
              {character.title ? ` — ${character.title}` : ""}
            </option>
          ))}
        </select>
        <span className="text-xs text-text-muted">
          An NPC record links to a character of this city — the public persona.
          The character is never the authority; the mandate is.
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-text-muted">Scope — in your words *</span>
        <textarea className="form-input" rows={3} value={scope} onChange={(e) => setScope(e.target.value)} />
        <span className="text-xs text-text-muted">
          This text is part of the record. It is what &ldquo;in scope&rdquo; means for this
          NPC, and it is shown to anyone auditing their acts.
        </span>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Traits (one per line)</span>
          <textarea className="form-input" rows={2} value={traits} onChange={(e) => setTraits(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Voice notes</span>
          <textarea className="form-input" rows={2} value={voiceNotes} onChange={(e) => setVoiceNotes(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-text-muted">Character notes</span>
          <textarea className="form-input" rows={2} value={characterNotes} onChange={(e) => setCharacterNotes(e.target.value)} />
        </label>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-text-muted">
          When something pops up in their scope, they may:
        </legend>
        {MODE_OPTIONS.map((option) => (
          <label key={option.mode} className="flex gap-2 items-start">
            <input
              type="radio"
              name={`create-mode-${props.city.id}`}
              className="mt-1"
              checked={mode === option.mode}
              onChange={() => setMode(option.mode)}
            />
            <span>
              <strong className="uppercase">{option.label}</strong>{" "}
              <span className="text-text-muted text-xs">({option.mode})</span>
              {option.mode === DEFAULT_PERMISSION_MODE && (
                <span className="text-text-muted text-xs"> — the default for a new NPC</span>
              )}
              <br />
              {option.paragraph}
            </span>
          </label>
        ))}
      </fieldset>

      <p className="text-sm text-text-muted">
        Creating {name.trim() === "" ? "this NPC" : name.trim()} is a logged
        action. They become active when the fabric commits it — until then
        they show as &ldquo;pending activation.&rdquo; You can edit their character any
        time. Changing their authority creates a new mandate version — the old
        one stays in the record. Creating with no mandate at all is a valid
        completion: they can be tasked by one-off envelopes, and the team
        shows them as holding no standing authority.
      </p>

      {problem && (
        <p role="alert" className="text-red-300">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-secondary min-h-11"
          onClick={() => setOpenForm(false)}
        >
          Cancel
        </button>
        {ready ? (
          <ActionRunner
            ctaLabel="Create NPC"
            cityName={(id) => id}
            onResolved={() => {
              setOpenForm(false);
              props.onChanged();
            }}
            submit={() =>
              submitNpcCreate(
                user.uid,
                {
                  cityId: props.city.id,
                  ...(characterId !== ""
                    ? { characterId }
                    : { mintedCharacterId: newId() }),
                  displayNameSnapshot: name.trim(),
                  titleFreeform: title.trim(),
                  personality: {
                    traits: linesToList(traits),
                    voiceNotes: voiceNotes.trim() === "" ? null : voiceNotes.trim(),
                    characterNotes:
                      characterNotes.trim() === "" ? null : characterNotes.trim(),
                  },
                  scopeFreeform: scope.trim(),
                  permissionMode: mode,
                },
                props.city.id
              )
            }
          />
        ) : (
          <button
            type="button"
            className="btn min-h-11"
            onClick={() =>
              setProblem("Name, title, and scope are required — an unnamed, untitled delegate could not be attributed in the Log.")
            }
          >
            Create NPC
          </button>
        )}
      </div>
    </div>
  );
}
