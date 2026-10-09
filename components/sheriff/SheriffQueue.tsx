"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Timestamp } from "firebase/firestore";
import {
  approveFactionHtml,
  getPendingHtmlFactions,
  rejectFactionHtml,
} from "@/lib/firestore/factions";
import type { Faction } from "@/lib/types";

function formatSubmitted(ts: Timestamp | undefined): string {
  if (!ts?.toDate) return "Unknown date";
  return ts.toDate().toLocaleString();
}

export function SheriffQueue() {
  const [factions, setFactions] = useState<Faction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setFactions(await getPendingHtmlFactions());
    } catch {
      setError("Failed to load approval queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = async (factionId: string) => {
    if (!confirm("Approve this HTML design? It will go live on the faction page.")) return;
    setActionId(factionId);
    try {
      await approveFactionHtml(factionId);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to approve");
    } finally {
      setActionId(null);
    }
  };

  const handleReject = async (factionId: string) => {
    if (!confirm("Reject this submission? Pending HTML will be discarded.")) return;
    setActionId(factionId);
    try {
      await rejectFactionHtml(factionId);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to reject");
    } finally {
      setActionId(null);
    }
  };

  const previewFaction = factions.find((f) => f.id === previewId);

  if (loading) {
    return <p className="text-text-muted">Loading approval queue…</p>;
  }

  if (error) {
    return <p className="text-red-400">{error}</p>;
  }

  return (
    <div className="space-y-4">
      {factions.length === 0 ? (
        <p className="text-text-muted text-center py-8">
          No pending HTML submissions. The queue is empty.
        </p>
      ) : (
        factions.map((faction) => (
          <div
            key={faction.id}
            className="border border-primary-brown rounded-lg p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          >
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-accent-gold">{faction.name}</h3>
              <p className="text-text-muted text-sm">
                Slug:{" "}
                <Link href={`/cities/${faction.slug}`} className="text-accent-gold hover:underline">
                  {faction.slug}
                </Link>
              </p>
              <p className="text-text-muted text-xs mt-1">
                Submitted: {formatSubmitted(faction.htmlSubmittedAt)}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setPreviewId(faction.id)}
                className="btn btn-secondary text-sm px-4 py-2"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={() => handleApprove(faction.id)}
                disabled={actionId === faction.id}
                className="btn text-sm px-4 py-2 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => handleReject(faction.id)}
                disabled={actionId === faction.id}
                className="btn btn-danger text-sm px-4 py-2 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))
      )}

      {previewFaction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
          onClick={() => setPreviewId(null)}
          onKeyDown={(e) => e.key === "Escape" && setPreviewId(null)}
          role="presentation"
        >
          <div
            className="glass-panel w-full max-w-4xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="preview-title"
          >
            <div className="flex items-center justify-between p-4 border-b border-primary-brown gap-3">
              <h3 id="preview-title" className="text-accent-gold font-bold truncate">
                Preview — {previewFaction.name}
              </h3>
              <button
                type="button"
                onClick={() => setPreviewId(null)}
                className="btn btn-secondary text-sm px-3 py-1 shrink-0"
              >
                Close
              </button>
            </div>
            <div
              className="flex-1 overflow-auto p-4 bg-darker-brown"
              dangerouslySetInnerHTML={{
                __html: previewFaction.pendingHtml ?? "<p>No content</p>",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
