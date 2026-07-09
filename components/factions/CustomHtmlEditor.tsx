"use client";

import { useState } from "react";
import type { Faction, HtmlStatus } from "@/lib/types";

const STATUS_LABELS: Record<HtmlStatus, string> = {
  approved: "Approved",
  pending_review: "Pending Sheriff Review",
  rejected: "Rejected — resubmit to try again",
};

interface CustomHtmlEditorProps {
  faction: Faction;
  onSubmit: (html: string) => Promise<void>;
}

export function CustomHtmlEditor({ faction, onSubmit }: CustomHtmlEditorProps) {
  const initialHtml =
    faction.pendingHtml ??
    faction.liveHtml ??
    "<h1>Welcome to our Saloon</h1>";

  const [html, setHtml] = useState(initialHtml);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    const trimmed = html.trim();
    if (!trimmed) {
      setError("Please enter some HTML code.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit for review");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {faction.htmlStatus && (
        <p
          className={`text-sm font-bold ${
            faction.htmlStatus === "pending_review"
              ? "text-accent-gold"
              : faction.htmlStatus === "rejected"
                ? "text-red-400"
                : "text-text-muted"
          }`}
        >
          Status: {STATUS_LABELS[faction.htmlStatus]}
        </p>
      )}

      <p className="text-text-muted text-sm">
        Design your faction page with custom HTML. Submissions go to the Sheriff for approval
        before going live. Your current live page stays visible until approved.
      </p>

      <div>
        <label htmlFor="custom-html" className="form-label">
          HTML Code
        </label>
        <textarea
          id="custom-html"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          className="form-input editor-textarea font-mono text-sm min-h-[400px]"
          placeholder="Enter your HTML code here…"
          spellCheck={false}
        />
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="flex gap-3 justify-end">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="btn text-sm px-6 py-2 disabled:opacity-50"
        >
          {submitting ? "Submitting…" : "Submit for Review"}
        </button>
      </div>
    </div>
  );
}
