"use client";

/**
 * The Log page (Phase 2 brief §11.1) — the realm's memory, readable.
 *
 * Reverse-chronological, finite pages of 50 (a "load more" cursor on
 * seq — never an infinite scroll over an unbounded Log), filters for
 * city / member / kind. A member's view merges the public entries with
 * their OWN actor-private entries (badged private); nobody else's
 * private entries ever render, and erased entries leave no placeholder
 * and no gap annotation — the standing Log is the whole story.
 *
 * Detail view shows the entry's changes with before/after values and
 * the recorded ruling formulas, its rule citations, and its Baseline
 * citation resolved against the CITED version in the in-code registry
 * (version, docHash, section titles — never a newer version's text).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  type DocumentData,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAllFactions } from "@/lib/firestore/posts";
import type { Faction } from "@/lib/types";
import { isActorPrivate, mergeVisibleEntries } from "@/lib/sim/log";
import { PRODUCTION_BASELINE_REGISTRY, getBaselineVersion } from "@/lib/sim/baseline/registry";
import {
  planLogWorkbooks,
  renderLogWorkbookBlob,
  type ExportEntry,
} from "@/lib/export/logWorkbook";
import { zipStore } from "@/lib/export/zip";

const PAGE_SIZE = 50;

interface LogRow {
  seq: number;
  data: DocumentData;
  [key: string]: unknown;
}

function actorLabel(actor: DocumentData | undefined): string {
  if (!actor) return "unknown";
  if (actor.type === "member") return `member ${actor.memberId ?? ""}`;
  if (actor.type === "npc") return `NPC ${actor.npcId ?? ""} (for ${actor.onBehalfOfMemberId ?? ""})`;
  if (actor.type === "shared-office") return `shared office (${actor.office ?? "mayor"})`;
  if (actor.type === "contest") return `contest (${actor.type})`;
  return String(actor.type ?? "unknown");
}

export default function LogPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [cities, setCities] = useState<Faction[]>([]);
  const [cityFilter, setCityFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [memberFilter, setMemberFilter] = useState("");
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);
  const [exportLimit, setExportLimit] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState("");

  const loadPage = useCallback(
    async (after: QueryDocumentSnapshot<DocumentData> | null) => {
      const db = getClientDb();
      const base = query(
        collection(db, "sim_log_entries"),
        orderBy("seq", "desc"),
        ...(after ? [startAfter(after)] : []),
        limit(PAGE_SIZE)
      );
      const snap = await getDocs(base);
      const fetched: LogRow[] = snap.docs.map((d) => ({
        seq: (d.data().seq as number) ?? 0,
        data: d.data(),
      }));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      if (snap.docs.length < PAGE_SIZE) setExhausted(true);
      return fetched;
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    loadPage(null)
      .then((fetched) => {
        if (!cancelled) setRows(fetched);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    getAllFactions()
      .then((list) => {
        if (!cancelled) setCities(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadPage]);

  const loadMore = async () => {
    if (!cursor || exhausted) return;
    setLoading(true);
    const fetched = await loadPage(cursor);
    setRows((current) => [...current, ...fetched]);
    setLoading(false);
  };

  // The read-path merge (§11.1): public entries for everyone; an
  // actor-private entry renders only in its own actor's view.
  const visible = useMemo(() => {
    const publicRows = rows.filter((row) => !isActorPrivate(row.data as { seq: number }));
    const ownPrivate = rows.filter(
      (row) =>
        isActorPrivate(row.data as { seq: number }) &&
        user &&
        (row.data.actor as DocumentData | undefined)?.memberId === user.uid
    );
    return mergeVisibleEntries(publicRows, ownPrivate);
  }, [rows, user]);

  const memberOptions = useMemo(() => {
    const members = new Map<string, string>();
    for (const row of visible) {
      const actor = row.data.actor as DocumentData | undefined;
      if (actor?.memberId) members.set(actor.memberId as string, actorLabel(actor));
    }
    return [...members.entries()];
  }, [visible]);

  const filtered = visible.filter((row) => {
    const data = row.data;
    if (cityFilter && !((data.cityIds as string[] | undefined) ?? []).includes(cityFilter)) {
      return false;
    }
    if (kindFilter && data.kind !== kindFilter) return false;
    if (memberFilter && (data.actor as DocumentData | undefined)?.memberId !== memberFilter) {
      return false;
    }
    return true;
  });

  const runExport = async () => {
    if (!user) return;
    setExporting(true);
    setExportNote("");
    try {
      const db = getClientDb();
      const snap = await getDocs(
        query(collection(db, "sim_log_entries"), orderBy("seq", "asc"))
      );
      const allRows: LogRow[] = snap.docs.map((d) => ({
        seq: (d.data().seq as number) ?? 0,
        data: d.data(),
      }));
      const merged = mergeVisibleEntries(
        allRows.filter((row) => !isActorPrivate(row.data as { seq: number })),
        allRows.filter(
          (row) =>
            isActorPrivate(row.data as { seq: number }) &&
            (row.data.actor as DocumentData | undefined)?.memberId === user.uid
        )
      );
      const entries: ExportEntry[] = [...merged]
        .sort((a, b) => a.seq - b.seq)
        .map((row) => {
          const data = row.data;
          const baseline = data.baseline as DocumentData | null;
          return {
            seq: row.seq,
            entryHash: data.entryHash as string,
            prevHash: data.prevHash as string,
            resolutionId: data.resolutionId as string,
            kind: data.kind as string,
            resolvedAt: data.resolvedAt as string,
            rulesVersion: data.rulesVersion as string,
            hashVersion: data.hashVersion as string,
            actorLabel: actorLabel(data.actor as DocumentData),
            actorUid: (data.actor as DocumentData | undefined)?.memberId ?? null,
            cityId: (data.cityId as string | null) ?? null,
            cityIds: (data.cityIds as string[]) ?? [],
            ruleIds: (data.ruleIds as string[]) ?? [],
            visibility: data.visibility as string,
            baselineVersion: baseline?.version ?? null,
            summaryText: data.summaryText as string,
            writeSetDigest: (data.writeSetDigest as string | null) ?? null,
            changes: ((data.changes as DocumentData[]) ?? []).map((change) => ({
              field: change.field as string,
              before: change.before,
              after: change.after,
              formula: change.formula as string,
            })),
          };
        });
      const parsedLimit = Number.parseInt(exportLimit, 10);
      const parts = planLogWorkbooks({
        entries,
        requesterLabel: user.email ?? user.uid,
        asOfSeq: entries.length > 0 ? entries[entries.length - 1].seq : 0,
        exportedAtIso: new Date().toISOString(),
        explicitLimit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null,
      });
      const files: { name: string; data: Uint8Array }[] = [];
      for (const part of parts) {
        const blob = await renderLogWorkbookBlob(part);
        files.push({
          name: part.filename,
          data: new Uint8Array(await blob.arrayBuffer()),
        });
        files.push({
          name: part.csv.filename,
          data: new TextEncoder().encode(part.csv.content),
        });
      }
      const bundle =
        files.length === 1
          ? new Blob([files[0].data.buffer as ArrayBuffer])
          : zipStore(files);
      const url = URL.createObjectURL(bundle);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        files.length === 1 ? files[0].name : `cowboy-city-log-export.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExportNote(
        `Exported ${parts.length} workbook part(s) covering seq ${parts[0]?.fromSeq ?? 0}..${parts[parts.length - 1]?.toSeq ?? 0}.`
      );
    } catch {
      setExportNote("Export failed — the Log could not be read as your account.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="glass-panel p-6">
          <h1 className="text-3xl font-bold text-accent-gold">The Log</h1>
          <p className="text-text-muted mt-2">
            Everything that has happened in the world, newest first. What was lawfully
            undone is simply not here — the standing Log is the whole story.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
            <select className="form-input" value={cityFilter} onChange={(e) => setCityFilter(e.target.value)} aria-label="Filter by city">
              <option value="">All cities</option>
              {cities.map((city) => (
                <option key={city.id} value={city.id}>{city.name}</option>
              ))}
            </select>
            <select className="form-input" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Filter by kind">
              <option value="">All kinds</option>
              {["action-summary", "rule-effect", "case", "contest", "rejected", "genesis"].map((kind) => (
                <option key={kind} value={kind}>{kind}</option>
              ))}
            </select>
            <select className="form-input" value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} aria-label="Filter by member">
              <option value="">All members</option>
              {memberOptions.map(([uid, label]) => (
                <option key={uid} value={uid}>{label}</option>
              ))}
            </select>
          </div>
          {user && (
            <div className="flex flex-wrap items-center gap-3 mt-4">
              <input
                className="form-input w-40"
                placeholder="Newest N (optional)"
                value={exportLimit}
                onChange={(e) => setExportLimit(e.target.value)}
                inputMode="numeric"
                aria-label="Export limit"
              />
              <button className="btn-primary" onClick={runExport} disabled={exporting}>
                {exporting ? "Exporting…" : "Export my audit workbook"}
              </button>
              {exportNote && <span className="text-text-muted text-sm">{exportNote}</span>}
            </div>
          )}
        </div>

        {loading && rows.length === 0 && <p className="text-text-muted">Loading the Log…</p>}
        {!loading && filtered.length === 0 && (
          <p className="text-text-muted">No standing entries match these filters.</p>
        )}

        <div className="space-y-3">
          {filtered.map((row) => {
            const data = row.data;
            const priv = isActorPrivate(data as { seq: number });
            const baseline = data.baseline as DocumentData | null;
            const baselineVersion = baseline
              ? getBaselineVersion(PRODUCTION_BASELINE_REGISTRY, baseline.version as string)
              : null;
            const expanded = expandedSeq === row.seq;
            return (
              <article key={row.seq} className="glass-panel p-4">
                <button
                  className="w-full text-left"
                  onClick={() => setExpandedSeq(expanded ? null : row.seq)}
                >
                  <p className="text-xs text-text-muted">
                    seq {row.seq} · {data.kind as string} · {actorLabel(data.actor as DocumentData)}
                    {priv && <span className="ml-2 text-accent-gold">private to you</span>}
                    {baseline && <span className="ml-2">· Baseline {baseline.version as string}</span>}
                  </p>
                  <p className="font-bold hover:text-accent-gold">{data.summaryText as string}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {((data.ruleIds as string[]) ?? []).join(", ") || "no rules cited"} ·{" "}
                    {data.resolvedAt as string}
                  </p>
                </button>
                {expanded && (
                  <div className="mt-3 space-y-3 text-sm">
                    {((data.changes as DocumentData[]) ?? []).length > 0 && (
                      <table className="w-full text-left">
                        <thead>
                          <tr className="text-text-muted">
                            <th>Field</th>
                            <th>Before</th>
                            <th>After</th>
                            <th>Ruling</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data.changes as DocumentData[]).map((change, i) => (
                            <tr key={i}>
                              <td>{change.field as string}</td>
                              <td>{JSON.stringify(change.before)}</td>
                              <td>{JSON.stringify(change.after)}</td>
                              <td className="text-text-muted">{change.formula as string}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {baseline && (
                      <div className="text-text-muted">
                        <p>
                          Baseline citation: <strong>{baseline.version as string}</strong> ·
                          docHash {(baseline.docHash as string).slice(0, 12)}… · sections{" "}
                          {((baseline.sections as string[]) ?? [])
                            .map(
                              (id) =>
                                `${id} — ${baselineVersion?.sections.find((s) => s.id === id)?.title ?? "title unavailable in this client registry"}`
                            )
                            .join("; ")}
                        </p>
                        {typeof baseline.interpretation === "string" && (
                          <p>Recorded interpretation: {baseline.interpretation}</p>
                        )}
                      </div>
                    )}
                    {(data.generation as DocumentData | null) && (
                      <p className="text-text-muted">
                        Generative content: prepared by a worker, bounds-checked, input hash{" "}
                        {String((data.generation as DocumentData).preparedInputHash).slice(0, 12)}…
                      </p>
                    )}
                    <p className="text-text-muted text-xs">
                      entryHash {(data.entryHash as string).slice(0, 16)}… · prevHash{" "}
                      {(data.prevHash as string).slice(0, 16)}… · resolution{" "}
                      {data.resolutionId as string} · rules {data.rulesVersion as string}
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {!exhausted && (
          <button className="btn-primary" onClick={loadMore} disabled={loading}>
            {loading ? "Loading…" : "Load older entries"}
          </button>
        )}
      </div>
    </div>
  );
}
