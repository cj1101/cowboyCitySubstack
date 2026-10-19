"use client";

/**
 * The dashboard home (Phase 3 brief §4.1; P3-D1: dashboard at `/`, the
 * social feed preserved at /feed and its posts routes).
 *
 * INTEGRATION STATE (Build Lead): the route-local renders are gone —
 * this host now composes June's panel components
 * (components/dashboard/panels/*) driven by her registry
 * (lib/dashboard/registry.ts), with per-panel data assembled by
 * lib/dashboard/panelData.ts from the snapshot read path
 * (lib/dashboard/snapshotRead.ts) plus the small per-panel reads the
 * snapshot does not carry. The my-city panel's sheet variant renders
 * Ines' SimSheet (via components/city/SimSheet.tsx) — the identical
 * component the city page mounts (TC-D01).
 *
 * Kept from the lead draft by design: the viewer-kind load, the prefs
 * load/save cycle, the default-city fallback chain (brief §5.3), and
 * the Customize editor (brief §5.2 — explicit mode, explicit
 * Save/Discard; guests get no prefs and no editor, §5.4).
 *
 * Discipline (brief §0.1/§13): one-time reads + explicit reload only —
 * no listeners, no polling, no auto-refetch. Freshness is the seq
 * comparison from the snapshot read path, never a clock.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { doc, getDoc, type Firestore } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import {
  PANEL_BY_ID,
  type PanelId,
  type PanelLoadState,
} from "@/lib/dashboard/registry";
import {
  defaultLayout,
  normalizePrefs,
  resolveDefaultCity,
  saveDashboardPrefs,
  type DashboardLayout,
  type ResolvedPanel,
} from "@/lib/dashboard/prefs";
import {
  loadDashboardCore,
  type DashboardCoreData,
} from "@/lib/dashboard/snapshotRead";
import {
  adaptSnapshot,
  buildMyCityDetail,
  digestHref,
  loadFabricStatus,
  loadLoreHighlights,
  loadOwnPrivateDigest,
  loadSituationsPeek,
  loadTownHall,
  selectNpcTeams,
} from "@/lib/dashboard/panelData";
import { WorldStripPanel, type WorldStripData } from "@/components/dashboard/panels/WorldStripPanel";
import { MyCityPanel, type MyCityData } from "@/components/dashboard/panels/MyCityPanel";
import { DigestPanel, type DigestData } from "@/components/dashboard/panels/DigestPanel";
import { SituationsPeekPanel } from "@/components/dashboard/panels/SituationsPeekPanel";
import { CityGridPanel } from "@/components/dashboard/panels/CityGridPanel";
import { ContestsPanel } from "@/components/dashboard/panels/ContestsPanel";
import { TownHallPanel, type TownHallData } from "@/components/dashboard/panels/TownHallPanel";
import { NpcTeamPanel } from "@/components/dashboard/panels/NpcTeamPanel";
import { SportsPanel } from "@/components/dashboard/panels/SportsPanel";
import { LoreHighlightsPanel } from "@/components/dashboard/panels/LoreHighlightsPanel";
import { ActionBoxPanel } from "@/components/dashboard/panels/ActionBoxPanel";
import SimSheet from "@/components/city/SimSheet";
import { downloadCityWorkbook } from "@/lib/export/cityWorkbook";
import { downloadRealmWorkbook } from "@/lib/export/dashboardWorkbook";

type ViewerKind = "member" | "guest";

type Loadable<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error" };

const DIGEST_SINCE_KEY = "cc.digestSinceSeq";

function toPanelState<T>(
  loadable: Loadable<T> | undefined,
  stale: boolean,
  onRetry: () => void
): PanelLoadState<T> {
  if (!loadable || loadable.status === "loading") return { status: "loading" };
  if (loadable.status === "error") return { status: "error", onRetry };
  return { status: "ready", data: loadable.data, ...(stale ? { stale: true } : {}) };
}

/** A quiet per-panel Excel affordance (brief §10.2) — members only;
 *  Felix's runners re-fence the requester before any fetch. */
function ExportButton({
  label,
  run,
}: {
  label: string;
  run: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className="btn btn-secondary text-xs px-3 py-1"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote("");
          try {
            await run();
            setNote("Workbook downloaded.");
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Export failed.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : label}
      </button>
      {note ? <span className="text-xs text-text-muted">{note}</span> : null}
    </span>
  );
}

export default function DashboardHome() {
  const { user, loading: authLoading } = useAuth();
  const [viewerKind, setViewerKind] = useState<ViewerKind>("member");
  const [core, setCore] = useState<DashboardCoreData | null>(null);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  const [fabric, setFabric] = useState<Loadable<WorldStripData["fabricStatus"]>>();
  const [situations, setSituations] =
    useState<Loadable<Awaited<ReturnType<typeof loadSituationsPeek>>>>();
  const [townHall, setTownHall] =
    useState<Loadable<{ openMotions: TownHallData["openMotions"]; recentResolutions: TownHallData["recentResolutions"] }>>();
  const [lore, setLore] =
    useState<Loadable<Awaited<ReturnType<typeof loadLoreHighlights>>>>();
  const [ownPrivate, setOwnPrivate] =
    useState<Loadable<Awaited<ReturnType<typeof loadOwnPrivateDigest>>>>();
  const [detail, setDetail] =
    useState<Loadable<{ cityId: string; data: Awaited<ReturnType<typeof buildMyCityDetail>> }>>();
  const [digestSince, setDigestSince] = useState<number | null>(null);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);

  const load = useCallback(async () => {
    if (!user) return;
    const db = getClientDb();
    try {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      const kind: ViewerKind =
        userSnap.data()?.accessLevel === "guest" ? "guest" : "member";
      setViewerKind(kind);
      let resolved: DashboardLayout;
      if (kind === "guest") {
        resolved = defaultLayout(); // §5.4: shipped defaults, no saved prefs
      } else {
        const prefsSnap = await getDoc(doc(db, "sim_dashboard_prefs", user.uid));
        resolved = normalizePrefs(prefsSnap.exists() ? prefsSnap.data() : null);
      }
      setLayout(resolved);
      setCore(await loadDashboardCore(db));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The dashboard could not load.");
    }
  }, [user]);

  useEffect(() => {
    if (user) void load();
  }, [user, load, reloadKey]);

  const snapshot = useMemo(() => (core ? adaptSnapshot(core) : null), [core]);

  const cityResolution = useMemo(() => {
    if (!core) return null;
    const factions = core.cityCards.map((c) => ({
      id: c.factionId,
      slug: c.slug,
      ownerUids: c.ownerUid ? [c.ownerUid] : [],
    }));
    return resolveDefaultCity({
      layout,
      factions,
      viewerUid: viewerKind === "guest" ? null : (user?.uid ?? null),
      sharedCityId: core.sharedCityId,
    });
  }, [core, layout, user, viewerKind]);

  // The selected city starts at the resolved default; the my-city
  // panel's switcher can move it (member's own cities only).
  useEffect(() => {
    if (cityResolution && selectedCityId === null) {
      setSelectedCityId(cityResolution.cityId);
    }
  }, [cityResolution, selectedCityId]);

  // Per-panel extra reads, each isolated: one panel's failure is that
  // panel's error state, never the page's.
  useEffect(() => {
    if (!core || !user || !snapshot) return;
    const db: Firestore = getClientDb();
    let cancelled = false;
    const run = <T,>(
      fn: () => Promise<T>,
      set: (value: Loadable<T>) => void
    ) => {
      set({ status: "loading" });
      fn()
        .then((data) => {
          if (!cancelled) set({ status: "ready", data });
        })
        .catch(() => {
          if (!cancelled) set({ status: "error" });
        });
    };
    run(() => loadFabricStatus(db), setFabric);
    run(() => loadTownHall(db), setTownHall);
    run(() => loadLoreHighlights(snapshot.cityCards), setLore);
    if (viewerKind === "member") {
      run(() => loadSituationsPeek(user.uid), setSituations);
      run(() => loadOwnPrivateDigest(db, user.uid), setOwnPrivate);
    }
    // Digest "since" anchor: read the stored value for this render,
    // then advance it to the observed head for the next visit (§6.3 —
    // client-side only, clamped by the panel against the head).
    try {
      const stored = window.localStorage.getItem(DIGEST_SINCE_KEY);
      setDigestSince(stored ? Number.parseInt(stored, 10) || null : null);
      if (core.worldSeq !== null) {
        window.localStorage.setItem(DIGEST_SINCE_KEY, String(core.worldSeq));
      }
    } catch {
      setDigestSince(null);
    }
    return () => {
      cancelled = true;
    };
  }, [core, user, snapshot, viewerKind, reloadKey]);

  const selectedCard = useMemo(() => {
    if (!snapshot || !selectedCityId) return null;
    return snapshot.cityCards.find((c) => c.factionId === selectedCityId) ?? null;
  }, [snapshot, selectedCityId]);

  // Verified detail figures for the selected city (card variant).
  useEffect(() => {
    if (!selectedCityId || !user) return;
    let cancelled = false;
    setDetail({ status: "loading" });
    buildMyCityDetail(
      getClientDb(),
      selectedCityId,
      selectedCard?.ownerUid === user.uid
    )
      .then((data) => {
        if (!cancelled) {
          setDetail({ status: "ready", data: { cityId: selectedCityId, data } });
        }
      })
      .catch(() => {
        if (!cancelled) setDetail({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedCityId, user, selectedCard]);

  if (authLoading) return <p className="text-text-muted">Loading…</p>;
  if (!user) return <p className="text-text-muted">Sign in to see the dashboard.</p>;
  if (error) {
    return (
      <div className="glass-panel p-6">
        <p>The dashboard could not load: {error}</p>
        <button type="button" className="btn btn-primary mt-3" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  if (!core || !layout || !snapshot) {
    return <p className="text-text-muted">Loading the world…</p>;
  }

  const uid = user.uid;
  const isGuest = viewerKind === "guest";
  const stale = core.freshness === "stale";
  const ready = <T,>(data: T): PanelLoadState<T> => ({
    status: "ready",
    data,
    ...(stale ? { stale: true } : {}),
  });

  const visiblePanels = layout.panels.filter((p) => {
    const def = PANEL_BY_ID[p.panelId as PanelId];
    if (!def || def.reserve || def.shipsInPhase > 3 || !p.visible) return false;
    if (isGuest && !def.guestVisible) return false;
    return true;
  });

  const viewerCities = isGuest
    ? []
    : snapshot.cityCards
        .filter((c) => c.ownerUid === user.uid)
        .map((c) => ({ factionId: c.factionId, name: c.name }));

  const resolutionNote = (() => {
    if (!cityResolution || !selectedCard) return null;
    if (selectedCard.factionId !== cityResolution.cityId) return null;
    if (isGuest) return "Featured city";
    switch (cityResolution.source) {
      case "prefs":
        return null;
      case "own":
        return "Your city — set a default in Customize";
      case "shared":
        return "The shared city — set a default in Customize";
      case "first":
        return "First city in the realm — set a default in Customize";
      default:
        return null;
    }
  })();

  const myCityData: MyCityData = {
    mode:
      snapshot.cityCards.length === 0
        ? "no-city"
        : isGuest
          ? "guest-featured"
          : "member",
    card: selectedCard,
    detail:
      detail?.status === "ready" && detail.data.cityId === selectedCityId
        ? detail.data.data
        : null,
    resolutionNote,
    viewerCities,
    createCityHref: "/factions/new",
  };

  const digestEntries = (() => {
    const publicEntries = snapshot.latestSummaries.map((s) => ({
      ...s,
      href: digestHref(s.seq, s.cityIds),
    }));
    if (isGuest || ownPrivate?.status !== "ready") return publicEntries;
    const publicSeqs = new Set(publicEntries.map((e) => e.seq));
    const merged = [
      ...publicEntries,
      ...ownPrivate.data.filter((e) => !publicSeqs.has(e.seq)),
    ];
    return merged.sort((a, b) => b.seq - a.seq);
  })();

  const digestData: DigestData = {
    entries: digestEntries,
    sinceSeq: digestSince,
    headSeq: core.worldSeq,
    logHref: "/log",
  };

  const worldStripData: WorldStripData = {
    asOfSeq: core.asOfSeq,
    worldHeadSeq: core.worldSeq,
    snapshotMissing: core.freshness === "missing",
    liveCityCount: snapshot.cityCards.length,
    townHallCard: snapshot.townHallCard,
    // No snapshot aggregate for realm GDP exists in Phase 3 — the
    // panel renders the honest null cell rather than a sum invented
    // at the read path.
    realmGdp: null,
    fabricStatus: fabric?.status === "ready" ? fabric.data : null,
  };

  const actionBoxCities = [
    ...viewerCities.map((c) => ({
      factionId: c.factionId,
      name: c.name,
      isShared: false,
    })),
    ...(core.sharedCityId
      ? snapshot.cityCards
          .filter((c) => c.factionId === core.sharedCityId)
          .map((c) => ({ factionId: c.factionId, name: c.name, isShared: true }))
      : []),
  ];

  function renderPanel(panel: ResolvedPanel) {
    const variant = panel.variant ?? PANEL_BY_ID[panel.panelId as PanelId]?.defaultVariant ?? "";
    switch (panel.panelId) {
      case "world-strip": {
        const state: PanelLoadState<WorldStripData> =
          !fabric || fabric.status === "loading"
            ? { status: "loading" }
            : fabric.status === "error"
              ? { status: "error", onRetry: retry }
              : ready(worldStripData);
        return <WorldStripPanel key={panel.panelId} state={state} variant={variant} />;
      }
      case "my-city": {
        const state: PanelLoadState<MyCityData> =
          variant === "card" && detail?.status === "error"
            ? { status: "error", onRetry: retry }
            : variant === "card" && detail?.status === "loading"
              ? { status: "loading" }
              : ready(myCityData);
        return (
          <MyCityPanel
            key={panel.panelId}
            state={state}
            variant={variant}
            sheet={
              selectedCityId ? (
                <SimSheet factionId={selectedCityId} />
              ) : undefined
            }
            onSelectCity={(factionId) => setSelectedCityId(factionId)}
            footer={
              !isGuest && selectedCityId ? (
                <ExportButton
                  label="Download Excel — this city"
                  run={() =>
                    downloadCityWorkbook({
                      uid: uid,
                      cityId: selectedCityId,
                      format: "xlsx",
                    })
                  }
                />
              ) : undefined
            }
          />
        );
      }
      case "digest": {
        const state: PanelLoadState<DigestData> = isGuest
          ? ready(digestData)
          : !ownPrivate || ownPrivate.status === "loading"
            ? { status: "loading" }
            : ownPrivate.status === "error"
              ? { status: "error", onRetry: retry }
              : ready(digestData);
        return <DigestPanel key={panel.panelId} state={state} variant={variant} />;
      }
      case "situations-peek":
        return (
          <SituationsPeekPanel
            key={panel.panelId}
            state={toPanelState(situations, stale, retry)}
            variant={variant}
          />
        );
      case "city-grid":
        return (
          <CityGridPanel
            key={panel.panelId}
            state={ready({ cards: snapshot!.cityCards })}
            variant={variant}
            footer={
              !isGuest ? (
                <ExportButton
                  label="Download Excel — the realm"
                  run={() =>
                    downloadRealmWorkbook({ uid: uid, format: "xlsx" })
                  }
                />
              ) : undefined
            }
          />
        );
      case "contests":
        return (
          <ContestsPanel
            key={panel.panelId}
            state={ready({ contests: snapshot!.openContestCards })}
            variant={variant}
          />
        );
      case "town-hall": {
        const state: PanelLoadState<TownHallData> =
          !townHall || townHall.status === "loading"
            ? { status: "loading" }
            : townHall.status === "error"
              ? { status: "error", onRetry: retry }
              : ready({
                  termCard: snapshot!.townHallCard,
                  openMotions: townHall.data.openMotions,
                  recentResolutions: townHall.data.recentResolutions,
                });
        return <TownHallPanel key={panel.panelId} state={state} variant={variant} />;
      }
      case "npc-team":
        return (
          <NpcTeamPanel
            key={panel.panelId}
            state={ready(
              selectNpcTeams({
                cards: snapshot!.cityCards,
                viewerUid: isGuest ? null : uid,
                defaultCity: selectedCard,
              })
            )}
            variant={variant}
          />
        );
      case "sports":
        return (
          <SportsPanel
            key={panel.panelId}
            state={ready({ competitions: [] })}
            variant={variant}
          />
        );
      case "lore-highlights":
        return (
          <LoreHighlightsPanel
            key={panel.panelId}
            state={toPanelState(lore, stale, retry)}
            variant={variant}
          />
        );
      case "action-box":
        return (
          <ActionBoxPanel
            key={panel.panelId}
            state={ready({ cities: actionBoxCities })}
          />
        );
      default:
        return null;
    }
  }

  const editLayout = draft ?? layout;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-baseline justify-between flex-wrap gap-2">
          <h1 className="text-2xl font-bold text-accent-gold">The Realm</h1>
          <div className="flex gap-3 items-baseline">
            <Link href="/feed" className="text-sm text-accent-gold hover:text-accent-gold-hover">
              Community feed
            </Link>
            <button type="button" className="btn btn-secondary text-sm px-3 py-1" onClick={retry}>
              Reload
            </button>
            {!isGuest && !editing ? (
              <button
                type="button"
                className="btn btn-secondary text-sm px-3 py-1"
                onClick={() => {
                  setDraft(layout);
                  setSaveError(null);
                  setEditing(true);
                }}
              >
                Customize
              </button>
            ) : null}
          </div>
        </div>

        {editing && !isGuest ? (
          <section className="glass-panel p-5" aria-label="Customize your dashboard">
            <h2 className="hud-title">Customize your dashboard</h2>
            <p className="text-sm text-text-muted mt-1">
              You&apos;re rearranging your dashboard — this changes only what{" "}
              <em>you</em> see.
            </p>
            <div className="mt-3">
              {editLayout.panels.map((p, index) => {
                const def = PANEL_BY_ID[p.panelId as PanelId];
                if (!def || def.reserve || def.shipsInPhase > 3) return null;
                const update = (patch: Partial<ResolvedPanel>) =>
                  setDraft({
                    ...editLayout,
                    panels: editLayout.panels.map((q) =>
                      q.panelId === p.panelId ? { ...q, ...patch } : q
                    ),
                  });
                const move = (delta: number) => {
                  const panels = [...editLayout.panels];
                  const target = index + delta;
                  if (target < 0 || target >= panels.length) return;
                  const [item] = panels.splice(index, 1);
                  panels.splice(target, 0, item);
                  setDraft({
                    ...editLayout,
                    panels: panels.map((q, i) => ({ ...q, order: i })),
                  });
                };
                return (
                  <div
                    key={p.panelId}
                    className="flex gap-2 items-center flex-wrap py-2 border-t border-black/5"
                  >
                    <span className="min-w-32 text-sm">{def.title}</span>
                    <button
                      type="button"
                      className="btn btn-secondary text-xs px-2 py-1"
                      onClick={() => move(-1)}
                      aria-label={`Move ${def.title} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary text-xs px-2 py-1"
                      onClick={() => move(1)}
                      aria-label={`Move ${def.title} down`}
                    >
                      ↓
                    </button>
                    <label className="text-xs">
                      <input
                        type="checkbox"
                        checked={p.visible}
                        onChange={(e) => update({ visible: e.target.checked })}
                      />{" "}
                      Visible
                    </label>
                    {def.variants.length > 0 ? (
                      <select
                        className="form-input text-xs w-auto"
                        value={p.variant ?? def.defaultVariant ?? ""}
                        onChange={(e) => update({ variant: e.target.value })}
                        aria-label={`${def.title} style`}
                      >
                        {def.variants.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 mt-3 flex-wrap items-center">
              <label className="text-xs">
                Default city:{" "}
                <select
                  className="form-input text-xs w-auto"
                  value={editLayout.defaultCityId ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...editLayout,
                      defaultCityId: e.target.value || null,
                    })
                  }
                >
                  <option value="">Automatic</option>
                  {snapshot.cityCards.map((c) => (
                    <option key={c.factionId} value={c.factionId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {saveError ? <p className="text-sm mt-2" style={{ color: "#a33" }}>{saveError}</p> : null}
            <div className="flex gap-2 mt-3">
              <button
                type="button"
                className="btn btn-primary text-sm px-4 py-2"
                onClick={async () => {
                  try {
                    await saveDashboardPrefs(getClientDb(), user.uid, editLayout);
                    setLayout(editLayout);
                    setDraft(null);
                    setEditing(false);
                  } catch (err) {
                    setSaveError(
                      err instanceof Error
                        ? err.message
                        : "Saving failed — your changes are still here."
                    );
                  }
                }}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-secondary text-sm px-4 py-2"
                onClick={() => {
                  setDraft(null);
                  setEditing(false);
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="btn btn-secondary text-sm px-4 py-2"
                onClick={async () => {
                  const fresh = defaultLayout();
                  try {
                    await saveDashboardPrefs(getClientDb(), user.uid, fresh);
                    setLayout(fresh);
                    setDraft(null);
                    setEditing(false);
                  } catch (err) {
                    setSaveError(
                      err instanceof Error ? err.message : "Reset failed."
                    );
                  }
                }}
              >
                Reset to the standard layout
              </button>
            </div>
          </section>
        ) : null}

        {visiblePanels.map((p) => renderPanel(p))}
      </div>
    </div>
  );
}
