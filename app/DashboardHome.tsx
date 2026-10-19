"use client";

/**
 * The dashboard home (Phase 3 brief §4.1; P3-D1: dashboard at `/`, the
 * social feed preserved at /feed and its posts routes).
 *
 * INTEGRATION NOTE: this route composes the dashboard from the Phase 3
 * data layer (lib/dashboard/*) with route-local panel renders. The
 * module workers' panel components (components/dashboard/*, built in
 * the p3-panels clone) replace these renders at module integration; the
 * data contracts — registry order, prefs layout, snapshot core data,
 * why-links — are the ones both sides build against, so the swap is
 * presentational. Panels whose data source is another phase's module
 * render their brief-specified honest states here (never invented data).
 *
 * Discipline (brief §0.1/§13): one-time reads + explicit reload only —
 * no listeners, no polling, no auto-refetch. Freshness is the seq
 * comparison from lib/dashboard/snapshotRead, never a clock.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { doc, getDoc } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getClientDb } from "@/lib/firebase";
import { getPanel } from "@/lib/dashboard/registry";
import {
  defaultLayout,
  normalizePrefs,
  resolveDefaultCity,
  saveDashboardPrefs,
  type DashboardLayout,
  type ResolvedPanel,
} from "@/lib/dashboard/prefs";
import {
  freshnessLine,
  loadDashboardCore,
  type DashboardCoreData,
} from "@/lib/dashboard/snapshotRead";
import {
  buildWhyLink,
  whyLinkForSnapshot,
} from "@/lib/dashboard/whyLink";
import type { CityCard } from "@/lib/sim/snapshot";

type ViewerKind = "member" | "guest";

const STAT_LABELS: Record<string, string> = {
  spirit: "Spirit",
  culture: "Culture",
  infrastructure: "Infrastructure",
  stability: "Stability",
  law: "Law",
  influence: "Influence",
  treasuryRubars: "Treasury (Rubar)",
  gdpRubars: "GDP (Rubar)",
  population: "Population",
};

const panelBox: React.CSSProperties = {
  border: "1px solid #ddd6c9",
  borderRadius: 8,
  padding: 16,
  background: "#fffdf8",
};
const panelTitle: React.CSSProperties = {
  fontSize: 13,
  letterSpacing: 1,
  textTransform: "uppercase",
  margin: "0 0 10px",
  color: "#6b6659",
};

function Figure({
  label,
  value,
  whyHref,
  caption,
}: {
  label: string;
  value: number | null;
  whyHref: string | null;
  caption?: string;
}) {
  return (
    <div style={{ minWidth: 110 }}>
      <div style={{ fontSize: 12, color: "#6b6659" }}>{label}</div>
      <div style={{ fontSize: 20 }}>
        {value === null ? "—" : value.toLocaleString()}{" "}
        {value !== null && whyHref ? (
          <Link href={whyHref} style={{ fontSize: 12 }}>
            why?
          </Link>
        ) : null}
      </div>
      {value === null && caption ? (
        <div style={{ fontSize: 12, color: "#6b6659" }}>{caption}</div>
      ) : null}
    </div>
  );
}

function CityFigures({ card, fields }: { card: CityCard; fields: string[] }) {
  if (!card.hasSimState || !card.compactStats) {
    return (
      <p style={{ margin: 0 }}>
        This city isn&apos;t in the sim yet — its owner hasn&apos;t claimed
        it. Its lore and wiki are on its city page.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
      {fields.map((field) => (
        <Figure
          key={field}
          label={STAT_LABELS[field] ?? field}
          value={card.compactStats?.[field] ?? null}
          whyHref={buildWhyLink({
            cityId: card.factionId,
            fieldPath: `stats.${field}`,
            anchorSeq: card.activity.lastChangedSeq,
          })}
          caption="Not yet allocated"
        />
      ))}
    </div>
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
  const [gridSort, setGridSort] = useState<"alphabetical" | "gdp" | "chronological">(
    "alphabetical"
  );
  const [actingCity, setActingCity] = useState<string>("");

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

  const defaultCity = useMemo(() => {
    if (!core) return null;
    const factions = core.cityCards.map((c) => ({
      id: c.factionId,
      slug: c.slug,
      ownerUids: c.ownerUid ? [c.ownerUid] : [],
    }));
    const resolved = resolveDefaultCity({
      layout,
      factions,
      viewerUid: viewerKind === "guest" ? null : user?.uid ?? null,
      sharedCityId: core.sharedCityId,
    });
    if (!resolved) return null;
    return core.cityCards.find((c) => c.factionId === resolved.cityId) ?? null;
  }, [core, layout, user, viewerKind]);

  const sortedCards = useMemo(() => {
    if (!core) return [];
    const cards = [...core.cityCards];
    if (gridSort === "alphabetical") {
      cards.sort((a, b) => a.name.localeCompare(b.name));
    } else if (gridSort === "gdp") {
      cards.sort(
        (a, b) =>
          (b.compactStats?.gdpRubars ?? -1) - (a.compactStats?.gdpRubars ?? -1)
      );
    } else {
      cards.sort(
        (a, b) =>
          (b.activity.lastChangedSeq ?? -1) - (a.activity.lastChangedSeq ?? -1)
      );
    }
    return cards;
  }, [core, gridSort]);

  if (authLoading) return <p>Loading…</p>;
  if (!user) return <p>Sign in to see the dashboard.</p>;
  if (error) {
    return (
      <div>
        <p>The dashboard could not load: {error}</p>
        <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (!core || !layout) return <p>Loading the world…</p>;

  const isGuest = viewerKind === "guest";
  const visiblePanels = layout.panels.filter((p) => {
    const def = getPanel(p.panelId);
    if (!def || def.shipsInPhase > 3 || !p.visible) return false;
    if (isGuest && !def.guestVisible) return false;
    return true;
  });

  const snapshotWhy = whyLinkForSnapshot({
    resolutionId: core.generatedByResolutionId,
    asOfSeq: core.asOfSeq,
  });

  function renderPanel(panel: ResolvedPanel) {
    const def = getPanel(panel.panelId);
    if (!def) return null;
    const wrap = (children: React.ReactNode) => (
      <section key={panel.panelId} style={panelBox} data-panel={panel.panelId}>
        <h2 style={panelTitle}>{def.title}</h2>
        {children}
      </section>
    );
    switch (panel.panelId) {
      case "world-strip":
        return wrap(
          <p style={{ margin: 0 }}>
            {freshnessLine(core!)}{" "}
            {snapshotWhy ? <Link href={snapshotWhy}>why?</Link> : null}
          </p>
        );
      case "my-city": {
        if (!defaultCity) return wrap(<p>No cities exist yet.</p>);
        const fields =
          panel.variant === "card"
            ? ["spirit", "culture", "infrastructure", "stability", "law", "influence", "treasuryRubars"]
            : Object.keys(STAT_LABELS);
        return wrap(
          <div>
            <p style={{ marginTop: 0 }}>
              <Link href={defaultCity.links.cityPage}>{defaultCity.name}</Link>
              {isGuest ? " — featured city" : ""}
              {defaultCity.ownerDisplay
                ? ` · ${defaultCity.ownerDisplay}`
                : ""}
            </p>
            <CityFigures card={defaultCity} fields={fields} />
            {defaultCity.latestHeadline ? (
              <p style={{ marginBottom: 0 }}>Latest: {defaultCity.latestHeadline}</p>
            ) : null}
          </div>
        );
      }
      case "digest": {
        const items =
          panel.variant === "brief"
            ? core!.latestSummaries.slice(0, 5)
            : core!.latestSummaries;
        return wrap(
          <div>
            {items.length === 0 ? (
              <p>Nothing has happened — the world is waiting.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {items.map((s) => (
                  <li key={s.seq}>
                    #{s.seq} · {s.actorDisplay} — {s.summaryText}
                    {s.major ? " · major" : ""}
                  </li>
                ))}
              </ul>
            )}
            <p style={{ marginBottom: 0, color: "#6b6659" }}>END OF DIGEST</p>
          </div>
        );
      }
      case "situations-peek":
        return wrap(
          <p style={{ margin: 0 }}>
            Things that need your attention collect here. In Phase 3 they
            ride your <Link href="/notifications">notifications</Link>; the
            dedicated Situations queue replaces that source in Phase 5.
          </p>
        );
      case "city-grid":
        return wrap(
          <div>
            <label style={{ fontSize: 12 }}>
              Sort:{" "}
              <select
                value={gridSort}
                onChange={(e) =>
                  setGridSort(e.target.value as typeof gridSort)
                }
              >
                <option value="alphabetical">Alphabetical</option>
                <option value="gdp">By GDP</option>
                <option value="chronological">Chronological</option>
              </select>
            </label>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))",
                gap: 12,
                marginTop: 10,
              }}
            >
              {sortedCards.map((card) => (
                <div
                  key={card.factionId}
                  style={{ border: "1px solid #eee5d3", borderRadius: 6, padding: 10 }}
                >
                  <Link href={card.links.cityPage}>{card.name}</Link>
                  {card.compactStats ? (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      Treasury:{" "}
                      {card.compactStats.treasuryRubars === null
                        ? "—"
                        : card.compactStats.treasuryRubars.toLocaleString()}{" "}
                      · GDP:{" "}
                      {card.compactStats.gdpRubars === null
                        ? "—"
                        : card.compactStats.gdpRubars.toLocaleString()}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      Not in the sim yet.
                    </div>
                  )}
                  {card.latestHeadline ? (
                    <div style={{ fontSize: 12, marginTop: 6 }}>
                      {card.latestHeadline}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      case "contests":
        return wrap(
          <div>
            <p style={{ marginTop: 0 }}>No contests are open.</p>
            <button type="button" disabled>
              Declare a contest — arrives in Phase 7
            </button>
          </div>
        );
      case "town-hall":
        return wrap(
          <p style={{ margin: 0 }}>
            Town Hall business runs through the{" "}
            <Link href="/forum">forum</Link> and{" "}
            <Link href="/treaties">treaties</Link>. The mayor&apos;s term
            block appears here when term records exist (Phase 7).
          </p>
        );
      case "npc-team":
        return wrap(
          <p style={{ margin: 0 }}>
            No NPC team yet. NPCs and management teams arrive in Phase 5 —
            until then, a city responds only when its owner acts.
          </p>
        );
      case "sports":
        return wrap(<p style={{ margin: 0 }}>No recorded results yet.</p>);
      case "lore-highlights":
        return wrap(
          <p style={{ margin: 0 }}>
            Browse the realm&apos;s lore in the{" "}
            <Link href="/lore-graph">Lore Graph</Link> and on each{" "}
            <Link href="/factions">city&apos;s page</Link>.
          </p>
        );
      case "action-box":
        return wrap(
          <div>
            <label style={{ fontSize: 12 }}>
              Acting city:{" "}
              <select
                value={actingCity}
                onChange={(e) => setActingCity(e.target.value)}
              >
                <option value="">Choose a city…</option>
                {core!.cityCards
                  .filter((c) => c.ownerUid === user.uid)
                  .map((c) => (
                    <option key={c.factionId} value={c.factionId}>
                      {c.name}
                    </option>
                  ))}
                {core!.sharedCityId ? (
                  <option value={core!.sharedCityId}>
                    The shared city (Mayor / Town Hall)
                  </option>
                ) : null}
              </select>
            </label>
            <textarea
              rows={3}
              style={{ display: "block", width: "100%", marginTop: 8 }}
              placeholder="Describe what your city does…"
            />
            <div
              style={{
                marginTop: 8,
                border: "1px dashed #ddd6c9",
                borderRadius: 6,
                padding: 10,
                color: "#6b6659",
              }}
            >
              Preview arrives with the play loop — Phase 4
            </div>
          </div>
        );
      default:
        return null;
    }
  }

  const editLayout = draft ?? layout;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>The Realm</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
          <Link href="/feed">Community feed</Link>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>
            Reload
          </button>
          {!isGuest && !editing ? (
            <button
              type="button"
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
        <section style={panelBox}>
          <h2 style={panelTitle}>Customize your dashboard</h2>
          <p style={{ marginTop: 0 }}>
            You&apos;re rearranging your dashboard — this changes only what
            you see.
          </p>
          {editLayout.panels.map((p, index) => {
            const def = getPanel(p.panelId);
            if (!def) return null;
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
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                  padding: "6px 0",
                  borderTop: "1px solid #f0e9d8",
                }}
              >
                <span style={{ minWidth: 130 }}>{def.title}</span>
                <button type="button" onClick={() => move(-1)} aria-label={`Move ${def.title} up`}>
                  ↑
                </button>
                <button type="button" onClick={() => move(1)} aria-label={`Move ${def.title} down`}>
                  ↓
                </button>
                <label style={{ fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={p.visible}
                    onChange={(e) => update({ visible: e.target.checked })}
                  />{" "}
                  Visible
                </label>
                {def.variants.length > 0 ? (
                  <select
                    value={p.variant ?? def.defaultVariant ?? ""}
                    onChange={(e) => update({ variant: e.target.value })}
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
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12 }}>
              Default city:{" "}
              <select
                value={editLayout.defaultCityId ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...editLayout,
                    defaultCityId: e.target.value || null,
                  })
                }
              >
                <option value="">Automatic</option>
                {core.cityCards.map((c) => (
                  <option key={c.factionId} value={c.factionId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {saveError ? <p style={{ color: "#a33" }}>{saveError}</p> : null}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              type="button"
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
              onClick={() => {
                setDraft(null);
                setEditing(false);
              }}
            >
              Discard
            </button>
            <button
              type="button"
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
  );
}
