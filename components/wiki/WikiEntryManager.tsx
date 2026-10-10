"use client";

import { useEffect, useState } from "react";
import { deleteWikiEntry, getWikiEntriesForCity, saveWikiEntry } from "@/lib/firestore/wikiEntries";
import { TipTapEditor } from "@/components/editor/TipTapEditor";
import type { WikiEntry, WikiEntryKind } from "@/lib/types";
import { WIKI_ENTRY_KINDS } from "@/lib/types";
import { slugify } from "@/lib/utils/slug";
import { actionError, withTimeout } from "@/lib/async";

export function WikiEntryManager({
  cityId,
  citySlug,
  canEdit,
}: {
  cityId: string;
  citySlug: string;
  canEdit: boolean;
}) {
  const [entries, setEntries] = useState<WikiEntry[]>([]);
  const [kind, setKind] = useState<WikiEntryKind | "all">("all");
  const [editing, setEditing] = useState<Partial<WikiEntry> | null>(null);
  const [columns, setColumns] = useState("GDP|Population");
  const [rows, setRows] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const load = () => {
    getWikiEntriesForCity(cityId).then(setEntries).catch(() => setEntries([]));
  };

  useEffect(() => {
    load();
  }, [cityId]);

  const visible = entries.filter((entry) => kind === "all" || entry.kind === kind);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-accent-gold">Codex</h2>
        {canEdit && (
          <button type="button" className="btn text-sm px-4 py-2" onClick={() => {
            setEditing({ kind: "place", title: "", slug: "", summary: "", body: "" });
            setColumns("GDP|Population");
            setRows("");
          }}>
            New entry
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {(["all", ...WIKI_ENTRY_KINDS] as const).map((item) => (
          <button key={item} type="button" className={`text-xs px-3 py-1 rounded border ${kind === item ? "border-accent-gold text-accent-gold" : "border-primary-brown text-text-muted"}`} onClick={() => setKind(item)}>
            {item}
          </button>
        ))}
      </div>
      {editing && canEdit && (
        <form
          className="glass-panel p-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const stats = rows.trim()
              ? {
                  columns: columns.split("|").map((cell) => cell.trim()).filter(Boolean),
                  rows: rows.split("\n").map((row) => row.split("|").map((cell) => cell.trim())).filter((row) => row.some(Boolean)),
                }
              : null;
            setSaving(true);
            setSaveError("");
            try {
              await withTimeout(saveWikiEntry({
                id: editing.id,
                cityId,
                citySlug,
                kind: (editing.kind || "place") as WikiEntryKind,
                title: editing.title || "Untitled",
                slug: editing.slug || slugify(editing.title || "entry"),
                summary: editing.summary || "",
                body: editing.body || "",
                stats,
              }));
              setEditing(null);
              load();
            } catch (error) {
              setSaveError(actionError(error, "Could not save that entry."));
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="grid sm:grid-cols-2 gap-3">
            <select className="form-input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as WikiEntryKind })}>
              {WIKI_ENTRY_KINDS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <input className="form-input" placeholder="Title" value={editing.title || ""} onChange={(e) => setEditing({ ...editing, title: e.target.value, slug: editing.slug || slugify(e.target.value) })} required />
          </div>
          <input className="form-input" placeholder="slug" value={editing.slug || ""} onChange={(e) => setEditing({ ...editing, slug: slugify(e.target.value) })} required />
          <input className="form-input" placeholder="Short summary for hover cards" value={editing.summary || ""} onChange={(e) => setEditing({ ...editing, summary: e.target.value })} />
          <TipTapEditor content={editing.body || ""} onChange={(html) => setEditing({ ...editing, body: html })} />
          <div>
            <p className="form-label">Stat table</p>
            <input className="form-input mb-2" value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="GDP|Population" />
            <textarea className="form-input" rows={4} value={rows} onChange={(e) => setRows(e.target.value)} placeholder={"Cowboy City|900|12000\nCascadia|400|8000"} />
          </div>
          {saveError && <p className="text-sm font-bold" role="alert">{saveError}</p>}
          <div className="flex gap-2">
            <button className="btn text-sm px-4 py-2" type="submit" disabled={saving}>{saving ? "Saving…" : "Save entry"}</button>
            <button className="btn btn-secondary text-sm px-4 py-2" type="button" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
      <div className="space-y-4">
        {visible.map((entry) => (
          <article key={entry.id} id={entry.slug} className="glass-panel p-4">
            <p className="text-xs uppercase text-accent-gold">{entry.kind}</p>
            <h3 className="text-xl font-bold">{entry.title}</h3>
            {entry.summary && <p className="text-text-muted text-sm">{entry.summary}</p>}
            {entry.stats && entry.stats.columns.length > 0 && (
              <table className="stat-table mt-3">
                <thead><tr>{entry.stats.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>
                  {entry.stats.rows.map((row, index) => (
                    <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            )}
            {entry.body && <div className="mt-3 text-sm" dangerouslySetInnerHTML={{ __html: entry.body }} />}
            {canEdit && (
              <div className="flex gap-3 mt-3 text-sm">
                <button type="button" className="text-accent-gold" onClick={() => {
                  setEditing(entry);
                  setColumns(entry.stats?.columns.join("|") || "GDP|Population");
                  setRows(entry.stats?.rows.map((row) => row.join("|")).join("\n") || "");
                }}>Edit</button>
                <button type="button" className="text-danger" onClick={async () => { await deleteWikiEntry(entry.id); load(); }}>Delete</button>
              </div>
            )}
          </article>
        ))}
        {visible.length === 0 && <p className="text-text-muted">No codex entries in this category yet.</p>}
      </div>
    </section>
  );
}
