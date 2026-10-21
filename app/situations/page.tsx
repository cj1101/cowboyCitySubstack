"use client";

/**
 * The Situations queue (Phase 5 brief §11.1 + §6.2's presentation
 * contract). One queue per owner, faceted per city — facets are
 * filters, never separate inboxes. Cards are ordered severity,
 * then oldest first; the owner's secondary sort is a display
 * preference, stored on this device only. Finite pages, a "show
 * more" step — never an infinite scroll. No read/unread state
 * exists here, and terminal cards never re-surface in the waiting
 * facets.
 *
 * Below the queue: the delegation rules panel (§7.4) — every rule
 * as a readable sentence, "Always wait for me" first, the §7.2
 * evaluation order as help text, and the rule composer, which runs
 * Vera's shared validator (`validateDelegationRuleDraft`, the same
 * function the rules tests use) before anything can be submitted.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { getAllFactions } from "@/lib/firestore/posts";
import type { Faction } from "@/lib/types";
import type { SimSituation } from "@/lib/sim/situations";
import { STARTING_SITUATION_KINDS } from "@/lib/sim/situations";
import type { SimDelegationRule } from "@/lib/sim/delegation";
import {
  validateDelegationRuleDraft,
  type ComposerContext,
  type DelegationRuleDraft,
} from "@/lib/sim/delegation";
import type { SimMandateVersion, SimNpc } from "@/lib/npcs/types";
import {
  EMPTY_QUEUE_MESSAGE,
  RULE_AUTHORITY_CHANGED_FLAG,
  RULE_EVALUATION_HELP,
  isHistory,
  kindLabel,
  ruleHandlerAuthorityChanged,
  ruleSentence,
  sortQueue,
  sortRules,
  waitsOnOwner,
  type QueueSort,
} from "@/lib/situations/present";
import {
  loadDelegationRules,
  loadQueue,
  loadRuleFireStats,
  submitDelegationRuleSet,
  type RuleFireStats,
} from "@/lib/situations/client";
import {
  loadMandateVersion,
  loadMyNpcs,
  loadSharedCityId,
} from "@/lib/npcs/client";
import { SituationCard } from "@/components/sim/SituationCard";
import { ActionRunner } from "@/components/sim/ActionRunner";
import { downloadSituationsHistory } from "@/lib/export/fetchPhase5Export";
import { actionError } from "@/lib/async";

const PAGE_STEP = 20;
const SORT_STORAGE_KEY = "cowboy-city-situations-sort";

/**
 * §11.4 export touchpoint: the owner's Situations history, as a
 * downloadable workbook. The scope is provable by construction —
 * the fetcher runs the same audience-fenced reads as this page and
 * the builder re-asserts the scope — so the download is offered
 * here, to the signed-in owner, and fails closed with the reason
 * rather than producing a partial file.
 */
function ExportControls({ uid }: { uid: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const run = async (format: "xlsx" | "csv") => {
    setBusy(true);
    setNote("");
    try {
      await downloadSituationsHistory(uid, format);
      setNote("Your Situations history downloaded.");
    } catch (err) {
      setNote(actionError(err, "The export was refused — nothing was downloaded."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 mt-4">
      <span className="text-sm text-text-muted">Export my Situations history:</span>
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

type Facet = "waiting" | "delegated" | "history";

export default function SituationsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [factions, setFactions] = useState<Faction[]>([]);
  const [queue, setQueue] = useState<SimSituation[]>([]);
  const [rules, setRules] = useState<SimDelegationRule[]>([]);
  const [myNpcs, setMyNpcs] = useState<SimNpc[]>([]);
  const [mandateVersionByNpc, setMandateVersionByNpc] = useState<
    Map<string, SimMandateVersion | null>
  >(new Map());
  const [sharedCityId, setSharedCityId] = useState<string | null>(null);
  const [fireStats, setFireStats] = useState<Map<string, RuleFireStats | null>>(
    new Map()
  );
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [facet, setFacet] = useState<Facet>("waiting");
  const [cityFacet, setCityFacet] = useState<string>("");
  const [kindFacet, setKindFacet] = useState<string>("");
  const [sort, setSort] = useState<QueueSort>("severity-oldest");
  const [visibleCount, setVisibleCount] = useState(PAGE_STEP);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (
      stored === "newest" ||
      stored === "city" ||
      stored === "kind" ||
      stored === "severity-oldest"
    ) {
      setSort(stored);
    }
  }, []);

  const ownedCityIds = useMemo(
    () =>
      user
        ? factions.filter((f) => f.ownerUids.includes(user.uid)).map((f) => f.id)
        : [],
    [factions, user]
  );

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const list = await getAllFactions();
      setFactions(list);
      const owned = list
        .filter((f) => f.ownerUids.includes(user.uid))
        .map((f) => f.id);
      const [queueRows, ruleRows, npcRows, shared] = await Promise.all([
        loadQueue(user.uid, owned),
        loadDelegationRules(user.uid),
        loadMyNpcs(user.uid),
        loadSharedCityId(),
      ]);
      setQueue(queueRows);
      setRules(ruleRows);
      setMyNpcs(npcRows);
      setSharedCityId(shared);
      const versions = new Map<string, SimMandateVersion | null>();
      await Promise.all(
        npcRows
          .filter((npc) => npc.currentMandateId && npc.currentMandateVersion)
          .map(async (npc) => {
            versions.set(
              npc.npcId,
              await loadMandateVersion(
                npc.currentMandateId as string,
                npc.currentMandateVersion as number
              )
            );
          })
      );
      for (const npc of npcRows) {
        if (!versions.has(npc.npcId)) versions.set(npc.npcId, null);
      }
      setMandateVersionByNpc(versions);
      const stats = new Map<string, RuleFireStats | null>();
      await Promise.all(
        ruleRows.map(async (rule) => {
          stats.set(rule.ruleId, await loadRuleFireStats(rule.ruleId));
        })
      );
      setFireStats(stats);
      setLoadError("");
    } catch (err) {
      setLoadError(actionError(err, "The queue could not be read as your account."));
    } finally {
      setLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const cityName = useCallback(
    (cityId: string | null) => {
      if (cityId === null) return "You, personally";
      return factions.find((f) => f.id === cityId)?.name ?? cityId;
    },
    [factions]
  );

  const cityHref = useCallback(
    (cityId: string) => {
      const faction = factions.find((f) => f.id === cityId);
      return faction ? `/factions/${faction.slug}` : "/cities";
    },
    [factions]
  );

  const npcName = useCallback(
    (npcId: string) =>
      myNpcs.find((n) => n.npcId === npcId)?.displayNameSnapshot ?? `NPC ${npcId}`,
    [myNpcs]
  );

  const facetRows = useMemo(() => {
    let rows = queue;
    if (facet === "waiting") rows = rows.filter(waitsOnOwner);
    else if (facet === "delegated") rows = rows.filter((s) => s.status === "delegated");
    else rows = rows.filter(isHistory);
    if (cityFacet === "__personal") {
      rows = rows.filter((s) => s.audienceCityId === null);
    } else if (cityFacet !== "") {
      rows = rows.filter((s) => (s.audienceCityId ?? s.cityId) === cityFacet);
    }
    if (kindFacet !== "") rows = rows.filter((s) => s.kind === kindFacet);
    return sortQueue(rows, sort, cityName);
  }, [queue, facet, cityFacet, kindFacet, sort, cityName]);

  const kindsPresent = useMemo(
    () => [...new Set(queue.map((s) => s.kind))].sort(),
    [queue]
  );
  const citiesPresent = useMemo(
    () =>
      [
        ...new Set(
          queue
            .map((s) => s.audienceCityId ?? s.cityId)
            .filter((id): id is string => id !== null)
        ),
      ].sort(),
    [queue]
  );
  const waitingCount = useMemo(() => queue.filter(waitsOnOwner).length, [queue]);

  if (!user) return <ScreenStatus>Sign in to see your Situations.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="glass-panel p-6">
          <h1 className="text-3xl font-bold text-accent-gold">Situations</h1>
          <p className="text-text-muted mt-2">
            Everything that is waiting on a decision, in one queue — faceted by
            city, never split into separate inboxes. Handling a matter,
            delegating it, and saying nothing are all complete decisions, and
            all three are recorded in the Log the same way.
          </p>
          <p className="text-sm mt-3">
            Your NPCs and their mandates live in{" "}
            <Link href="/settings/npcs" className="text-accent-gold underline">
              Settings → Your NPCs
            </Link>
            .
          </p>
          <ExportControls uid={user.uid} />
        </header>

        {loadError && (
          <p role="alert" className="glass-panel p-4 text-sm">
            {loadError}
          </p>
        )}

        {/* Facets */}
        <div className="glass-panel p-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Queue facets">
            <button
              type="button"
              role="tab"
              aria-selected={facet === "waiting"}
              className={`btn min-h-11 ${facet === "waiting" ? "" : "btn-secondary"}`}
              onClick={() => {
                setFacet("waiting");
                setVisibleCount(PAGE_STEP);
              }}
            >
              Waiting on you ({waitingCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={facet === "delegated"}
              className={`btn min-h-11 ${facet === "delegated" ? "" : "btn-secondary"}`}
              onClick={() => {
                setFacet("delegated");
                setVisibleCount(PAGE_STEP);
              }}
            >
              With a delegate
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={facet === "history"}
              className={`btn min-h-11 ${facet === "history" ? "" : "btn-secondary"}`}
              onClick={() => {
                setFacet("history");
                setVisibleCount(PAGE_STEP);
              }}
            >
              History
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <select
              className="form-input"
              value={cityFacet}
              onChange={(e) => {
                setCityFacet(e.target.value);
                setVisibleCount(PAGE_STEP);
              }}
              aria-label="Facet by city"
            >
              <option value="">All cities</option>
              {citiesPresent.map((id) => (
                <option key={id} value={id}>
                  {cityName(id)}
                </option>
              ))}
              <option value="__personal">Personal</option>
            </select>
            <select
              className="form-input"
              value={kindFacet}
              onChange={(e) => {
                setKindFacet(e.target.value);
                setVisibleCount(PAGE_STEP);
              }}
              aria-label="Facet by kind"
            >
              <option value="">All kinds</option>
              {kindsPresent.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </select>
            <select
              className="form-input"
              value={sort}
              onChange={(e) => {
                const next = e.target.value as QueueSort;
                setSort(next);
                window.localStorage.setItem(SORT_STORAGE_KEY, next);
              }}
              aria-label="Card order"
            >
              <option value="severity-oldest">Severity, then oldest first</option>
              <option value="newest">Newest first</option>
              <option value="city">By city</option>
              <option value="kind">By kind</option>
            </select>
          </div>
        </div>

        {/* Queue */}
        {!loaded ? (
          <p className="text-text-muted">Reading your queue…</p>
        ) : facetRows.length === 0 ? (
          <p className="glass-panel p-6">
            {facet === "waiting"
              ? EMPTY_QUEUE_MESSAGE
              : facet === "delegated"
                ? "Nothing is with a delegate right now."
                : "Nothing has closed yet — handled matters, and matters you let sit, will be recorded here."}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {facetRows.slice(0, visibleCount).map((situation) => (
              <SituationCard
                key={situation.situationId}
                situation={situation}
                cityName={cityName}
                cityHref={cityHref}
                npcsHere={myNpcs.filter(
                  (npc) =>
                    npc.cityId === (situation.audienceCityId ?? situation.cityId) &&
                    npc.ownerUid === user.uid
                )}
                mandateVersionByNpc={mandateVersionByNpc}
                spawnCities={factions.map((f) => ({ id: f.id, name: f.name }))}
                onChanged={() => void refresh()}
              />
            ))}
            {facetRows.length > visibleCount && (
              <button
                type="button"
                className="btn min-h-11 self-center"
                onClick={() => setVisibleCount((c) => c + PAGE_STEP)}
              >
                Show more ({facetRows.length - visibleCount} more)
              </button>
            )}
          </div>
        )}

        {/* Delegation rules (§7.4) */}
        <RulesPanel
          rules={rules}
          myNpcs={myNpcs}
          mandateVersionByNpc={mandateVersionByNpc}
          ownedCityIds={ownedCityIds}
          factions={factions}
          sharedCityId={sharedCityId}
          fireStats={fireStats}
          cityName={cityName}
          npcName={npcName}
          onChanged={() => void refresh()}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// §7.4 — the delegation rules panel: sentences, flags, toggles, and
// the composer that runs the shared validator before it can save.
// ---------------------------------------------------------------------

function RulesPanel(props: {
  rules: SimDelegationRule[];
  myNpcs: SimNpc[];
  mandateVersionByNpc: Map<string, SimMandateVersion | null>;
  ownedCityIds: string[];
  factions: Faction[];
  sharedCityId: string | null;
  fireStats: Map<string, RuleFireStats | null>;
  cityName: (id: string | null) => string;
  npcName: (npcId: string) => string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const ordered = useMemo(() => sortRules(props.rules), [props.rules]);
  const [toggleFor, setToggleFor] = useState<string | null>(null);

  return (
    <section className="glass-panel p-6 flex flex-col gap-4" aria-label="Delegation rules">
      <div>
        <h2 className="text-2xl font-bold text-accent-gold">Delegation rules</h2>
        <p className="text-sm text-text-muted mt-1">{RULE_EVALUATION_HELP}</p>
        <p className="text-sm text-text-muted mt-1">
          Rules route matters; mandates authorize them. A rule whose handler&rsquo;s
          mandate has been revoked or replaced stops matching and is flagged —
          it never falls through silently.
        </p>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm">
          You have no delegation rules. Without one, every matter waits for
          you — and waiting is a complete outcome.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {ordered.map((rule) => {
            const handlerNpc = rule.handler.npcId
              ? props.myNpcs.find((n) => n.npcId === rule.handler.npcId)
              : undefined;
            const authorityChanged = ruleHandlerAuthorityChanged(
              rule,
              handlerNpc?.currentMandateId
            );
            const stats = props.fireStats.get(rule.ruleId);
            return (
              <li key={rule.ruleId} className="rounded border border-darker-brown p-3 flex flex-col gap-2">
                <p className="font-bold">
                  {ruleSentence(rule, {
                    npcName: props.npcName,
                    cityName: (id) => props.cityName(id),
                  })}
                </p>
                <p className="text-xs text-text-muted">
                  {props.cityName(rule.cityId)} · rule v{rule.version} ·{" "}
                  {rule.status === "pending"
                    ? "pending — takes effect when the fabric commits it"
                    : rule.enabled
                      ? "enabled"
                      : "disabled"}
                  {rule.effectiveSeq !== null ? ` · effective at seq ${rule.effectiveSeq}` : ""}
                  {stats
                    ? stats.count > 0
                      ? ` · fired ${stats.count} time${stats.count === 1 ? "" : "s"}${stats.lastSeq !== null ? `, last at seq ${stats.lastSeq}` : ""}`
                      : " · has not fired"
                    : ""}
                  {stats?.lastSeq !== null && stats !== undefined && stats !== null && (
                    <>
                      {" "}
                      <Link href={`/log?anchor=${stats.lastSeq}`} className="text-accent-gold underline">
                        last fire in the Log
                      </Link>
                    </>
                  )}
                </p>
                {authorityChanged && (
                  <p role="alert" className="text-sm font-bold">
                    {RULE_AUTHORITY_CHANGED_FLAG} — this rule no longer matches.
                    Its handler&rsquo;s mandate was revoked or replaced; author the
                    rule again against the current mandate to route these
                    matters once more.
                  </p>
                )}
                {user && rule.status !== "superseded" && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary min-h-11 self-start"
                      onClick={() =>
                        setToggleFor(toggleFor === rule.ruleId ? null : rule.ruleId)
                      }
                    >
                      {rule.enabled ? "Turn this rule off" : "Turn this rule on"}
                    </button>
                    {toggleFor === rule.ruleId && (
                      <ActionRunner
                        autoStart
                        ctaLabel={rule.enabled ? "Turn off" : "Turn on"}
                        cityName={(id) => props.cityName(id)}
                        onResolved={props.onChanged}
                        submit={() =>
                          submitDelegationRuleSet(user.uid, {
                            cityId: rule.cityId,
                            rule: {
                              ruleId: rule.ruleId,
                              cityId: rule.cityId,
                              match: rule.match,
                              handler: rule.handler,
                              caps: rule.caps,
                              alwaysWait: rule.alwaysWait,
                              priority: rule.priority,
                              enabled: !rule.enabled,
                            },
                          })
                        }
                      />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <RuleComposer
        myNpcs={props.myNpcs}
        mandateVersionByNpc={props.mandateVersionByNpc}
        ownedCityIds={props.ownedCityIds}
        factions={props.factions}
        sharedCityId={props.sharedCityId}
        cityName={props.cityName}
        onChanged={props.onChanged}
      />
    </section>
  );
}

function RuleComposer(props: {
  myNpcs: SimNpc[];
  mandateVersionByNpc: Map<string, SimMandateVersion | null>;
  ownedCityIds: string[];
  factions: Faction[];
  sharedCityId: string | null;
  cityName: (id: string | null) => string;
  onChanged: () => void;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [cityId, setCityId] = useState<string>(props.ownedCityIds[0] ?? "");
  const [kinds, setKinds] = useState<string[]>([]);
  const [sourceKinds, setSourceKinds] = useState("");
  const [counterpartyCityIds, setCounterpartyCityIds] = useState<string[]>([]);
  const [minRubars, setMinRubars] = useState("");
  const [maxRubars, setMaxRubars] = useState("");
  const [npcId, setNpcId] = useState<string>("");
  const [mode, setMode] = useState<string>("ask-first");
  const [perActionRubars, setPerActionRubars] = useState("");
  const [alwaysWait, setAlwaysWait] = useState(false);

  const cityNpcs = useMemo(
    () => props.myNpcs.filter((n) => n.cityId === cityId && n.status !== "retired"),
    [props.myNpcs, cityId]
  );
  const handlerNpc = cityNpcs.find((n) => n.npcId === npcId) ?? null;
  const handlerVersion = handlerNpc
    ? (props.mandateVersionByNpc.get(handlerNpc.npcId) ?? null)
    : null;

  const draft: DelegationRuleDraft = {
    ownerUid: user?.uid ?? "",
    cityId,
    match: {
      situationKinds: kinds,
      sourceKinds: sourceKinds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
      cityIds: null,
      counterpartyCityIds: counterpartyCityIds.length > 0 ? counterpartyCityIds : null,
      minRubars: minRubars.trim() === "" ? null : Number(minRubars),
      maxRubars: maxRubars.trim() === "" ? null : Number(maxRubars),
      tags: [],
    },
    handler: {
      npcId: alwaysWait ? null : npcId === "" ? null : npcId,
      mode: (alwaysWait ? "wait-for-owner" : mode) as DelegationRuleDraft["handler"]["mode"],
      mandateId: alwaysWait ? null : (handlerNpc?.currentMandateId ?? null),
    },
    caps: {
      perActionRubars:
        perActionRubars.trim() === "" ? null : Number(perActionRubars),
    },
    alwaysWait,
  };

  const ctx: ComposerContext = {
    handlerNpc: handlerNpc
      ? { npcId: handlerNpc.npcId, ownerUid: handlerNpc.ownerUid }
      : null,
    mandate:
      handlerNpc?.currentMandateId && handlerVersion
        ? {
            mandateId: handlerNpc.currentMandateId,
            npcId: handlerNpc.npcId,
            caps: handlerVersion.caps,
          }
        : null,
    isSharedCity: props.sharedCityId !== null && cityId === props.sharedCityId,
    // No client-readable office record exists before the shared-city
    // office build; the composer therefore cannot prove mayoral
    // authority, and the shared validator refuses shared-city rules
    // on exactly that ground (see the prep report's flags).
    authorIsSittingMayor: false,
  };

  const validation = validateDelegationRuleDraft(draft, ctx);
  const canSave = open && cityId !== "" && validation.ok;

  if (!user) return null;

  return (
    <div className="border-t border-primary-brown pt-4 flex flex-col gap-3">
      {!open ? (
        <button
          type="button"
          className="btn min-h-11 self-start"
          onClick={() => setOpen(true)}
        >
          Write a new rule
        </button>
      ) : (
        <form className="flex flex-col gap-3 text-sm" onSubmit={(e) => e.preventDefault()}>
          <h3 className="font-bold">New delegation rule</h3>
          <label className="flex flex-col gap-1">
            <span className="text-text-muted">City</span>
            <select
              className="form-input min-h-11"
              value={cityId}
              onChange={(e) => {
                setCityId(e.target.value);
                setNpcId("");
              }}
            >
              {props.ownedCityIds.map((id) => (
                <option key={id} value={id}>
                  {props.cityName(id)}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-text-muted">Situation kinds (none ticked = any kind)</legend>
            <div className="flex flex-wrap gap-2">
              {STARTING_SITUATION_KINDS.map((kind) => (
                <label key={kind} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={kinds.includes(kind)}
                    onChange={(e) =>
                      setKinds((current) =>
                        e.target.checked
                          ? [...current, kind]
                          : current.filter((k) => k !== kind)
                      )
                    }
                  />
                  {kindLabel(kind)}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex flex-col gap-1">
            <span className="text-text-muted">Source kinds (comma-separated, optional)</span>
            <input
              className="form-input min-h-11"
              value={sourceKinds}
              onChange={(e) => setSourceKinds(e.target.value)}
              placeholder="e.g. proposal, delegation"
            />
          </label>

          <fieldset className="flex flex-col gap-1">
            <legend className="text-text-muted">Counterparty cities (optional)</legend>
            <div className="flex flex-wrap gap-2">
              {props.factions
                .filter((f) => f.id !== cityId)
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
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">At least (Rubars, optional)</span>
              <input className="form-input min-h-11" value={minRubars} onChange={(e) => setMinRubars(e.target.value)} inputMode="numeric" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-muted">At most (Rubars, optional)</span>
              <input className="form-input min-h-11" value={maxRubars} onChange={(e) => setMaxRubars(e.target.value)} inputMode="numeric" />
            </label>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={alwaysWait}
              onChange={(e) => setAlwaysWait(e.target.checked)}
            />
            Always wait for me — these matters always wait for my own decision.
          </label>

          {!alwaysWait && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">Handler — one of my NPCs in this city</span>
                <select
                  className="form-input min-h-11"
                  value={npcId}
                  onChange={(e) => setNpcId(e.target.value)}
                >
                  <option value="">Choose an NPC…</option>
                  {cityNpcs.map((npc) => (
                    <option key={npc.npcId} value={npc.npcId}>
                      {npc.displayNameSnapshot} — {npc.titleFreeform}
                      {npc.currentMandateId
                        ? ` · mandate v${npc.currentMandateVersion ?? "?"}`
                        : " · no mandate"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">How the handler responds</span>
                <select
                  className="form-input min-h-11"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  <option value="act-for-me">Act for me, inside the mandate</option>
                  <option value="ask-first">Draft and wait for me</option>
                  <option value="silent">Give no response</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-text-muted">Cap per action (Rubars, optional)</span>
                <input className="form-input min-h-11" value={perActionRubars} onChange={(e) => setPerActionRubars(e.target.value)} inputMode="numeric" />
              </label>
            </>
          )}

          {validation.violations.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Why this rule cannot be saved">
              {validation.violations.map((violation) => (
                <li key={violation.code} role="alert" className="text-red-300">
                  {violation.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary min-h-11"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            {canSave ? (
              <ActionRunner
                ctaLabel="Save this rule"
                cityName={(id) => props.cityName(id)}
                onResolved={() => {
                  setOpen(false);
                  props.onChanged();
                }}
                submit={() =>
                  submitDelegationRuleSet(user.uid, {
                    cityId,
                    rule: {
                      ruleId:
                        typeof crypto !== "undefined" && "randomUUID" in crypto
                          ? crypto.randomUUID()
                          : `rule-${Date.now()}`,
                      cityId,
                      match: draft.match,
                      handler: draft.handler,
                      caps: draft.caps,
                      alwaysWait: draft.alwaysWait,
                      enabled: true,
                      priority: 0,
                    },
                  })
                }
              />
            ) : (
              <button type="button" className="btn min-h-11" disabled>
                Save this rule
              </button>
            )}
          </div>
          <p className="text-xs text-text-muted">
            Saving authors the rule as a pending version; it takes effect when
            the fabric commits it, and every fire is written to the Log with the
            rule and its version cited.
          </p>
        </form>
      )}
    </div>
  );
}
