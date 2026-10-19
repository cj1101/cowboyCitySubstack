"use client";

import { useMemo, useState } from "react";

import {
  ALLOCATABLE_STATS,
  EARNED_SPACE_NOTE,
  STAT_META,
  emptyAllocation,
  isCommittable,
  neutralAllocation,
  normalizeAllocation,
  requestAllocationCommit,
  saveAllocationDraft,
  validateAllocation,
  type AllocationStatus,
  type AllocationValues,
  type AllocatableStat,
} from "@/lib/allocation";

import { AllocationSummary } from "./AllocationSummary";
import { StatAllocatorRow } from "./StatAllocatorRow";

export interface AllocationEditorProps {
  cityId: string;
  cityName?: string;
  /** The owner's uid — recorded as authorUid on every draft save. */
  authorUid: string;
  /** Existing draft allocations (the doc's `allocations` map), if any. */
  initialAllocations?: Partial<Record<string, unknown>>;
  /** The doc's current status; 'not_started' for a fresh city. */
  initialStatus?: AllocationStatus;
  /** The doc's current draftVersion (0 until the first draft save). */
  initialDraftVersion?: number;
  /**
   * Injectable handlers — Phase 4 page wiring (or tests) can substitute
   * these; by default the editor writes through lib/allocation/draftSave,
   * i.e. the Phase 1 rules' owner draft fence and nothing else.
   */
  onSaveDraft?: (values: AllocationValues) => Promise<void>;
  onRequestCommit?: (values: AllocationValues) => Promise<void>;
}

/**
 * The Season-0 allocation editor (R-35): shape your city's founding build
 * from the shared 400-point pool. Drafts save freely; the commit is
 * one-time and final (no respec — amendment §3.4), so it is two-step and
 * stays disabled until the allocation validates exactly.
 *
 * ==========================================================================
 * PHASE 4 INTEGRATION POINT — COMMIT
 * ==========================================================================
 * "Request commit" sets status 'commit_requested' via the draft fence.
 * Phase 4's fabric resolves that request as a Resolution Event (writes
 * sim_cities stats, committed fields, the versions record, and the Log
 * entries). Until that intake exists, a requested commit is recorded and
 * pending — and once requested, the Phase 1 rules refuse further draft
 * edits, so this editor locks. Copy below says all of this plainly.
 * ==========================================================================
 */
export function AllocationEditor({
  cityId,
  cityName,
  authorUid,
  initialAllocations,
  initialStatus = "not_started",
  initialDraftVersion = 0,
  onSaveDraft,
  onRequestCommit,
}: AllocationEditorProps) {
  const [values, setValues] = useState<AllocationValues>(() =>
    normalizeAllocation(initialAllocations)
  );
  const [status, setStatus] = useState<AllocationStatus>(initialStatus);
  const [draftVersion, setDraftVersion] = useState(initialDraftVersion);
  const [busy, setBusy] = useState<"draft" | "commit" | null>(null);
  const [confirmingCommit, setConfirmingCommit] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const locked =
    status === "committed" || status === "commit_requested" || status === "superseded";
  const committable = isCommittable(values);
  const perStatIssues = useMemo(() => {
    const map = new Map<string, string>();
    for (const issue of validateAllocation(values)) {
      if (issue.stat) map.set(issue.stat, issue.message);
    }
    return map;
  }, [values]);

  function setStat(stat: AllocatableStat, next: number) {
    setValues((prev) => ({ ...prev, [stat]: next }));
    setNotice("");
  }

  async function handleSaveDraft() {
    setError("");
    setNotice("");
    setBusy("draft");
    try {
      if (onSaveDraft) {
        await onSaveDraft(values);
      } else {
        await saveAllocationDraft({
          cityId,
          values,
          authorUid,
          previousDraftVersion: draftVersion,
        });
      }
      setDraftVersion((v) => v + 1);
      setStatus("draft");
      setNotice("Draft saved. You can keep reshaping it until you commit.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft");
    } finally {
      setBusy(null);
    }
  }

  async function handleRequestCommit() {
    setError("");
    setNotice("");
    setBusy("commit");
    try {
      if (onRequestCommit) {
        await onRequestCommit(values);
      } else {
        await requestAllocationCommit({
          cityId,
          values,
          authorUid,
          previousDraftVersion: draftVersion,
        });
      }
      setDraftVersion((v) => v + 1);
      setStatus("commit_requested");
      setConfirmingCommit(false);
      setNotice(
        "Commit requested. The fabric resolves allocation commits as a logged Resolution Event; until it does, this build is locked as requested."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request commit");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="Season-0 stat allocation">
      <header className="space-y-2">
        <h2 className="text-xl font-bold">
          Founding build{cityName ? ` — ${cityName}` : ""}
        </h2>
        <p className="text-sm opacity-80">
          Every city starts even: the same 400-point pool, allocated freely
          across the eight indices as final values. Your committed build is
          public — a rival&apos;s build shape is realm knowledge the moment
          it exists, and scouting it is play.
        </p>
        <p className="text-sm opacity-80">{EARNED_SPACE_NOTE}</p>
        {status === "committed" ? (
          <p className="text-sm text-emerald-400" role="status">
            This city&apos;s Season-0 allocation is committed. There is no
            respec: indexes move from here only through play, and every move
            is in the Log.
          </p>
        ) : status === "commit_requested" ? (
          <p className="text-sm text-amber-400" role="status">
            A commit has been requested for this build and it is locked
            while the request stands.
          </p>
        ) : null}
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {ALLOCATABLE_STATS.map((stat) => (
          <StatAllocatorRow
            key={stat}
            meta={STAT_META[stat]}
            value={values[stat]}
            disabled={locked || busy !== null}
            issue={perStatIssues.get(stat)}
            onChange={(next) => setStat(stat, next)}
          />
        ))}
      </div>

      <AllocationSummary values={values} />

      {!locked ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() => {
              setValues(neutralAllocation());
              setNotice("");
            }}
          >
            Start from the neutral city (50 each)
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null}
            onClick={() => {
              setValues(emptyAllocation());
              setNotice("");
            }}
          >
            Clear to zero
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            aria-busy={busy === "draft"}
            onClick={handleSaveDraft}
          >
            {busy === "draft" ? "Saving…" : "Save draft"}
          </button>
          {!confirmingCommit ? (
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !committable}
              title={
                committable
                  ? "Commit this founding build"
                  : "Spend exactly 400 points, all in bounds, to commit"
              }
              onClick={() => setConfirmingCommit(true)}
            >
              Commit allocation
            </button>
          ) : null}
        </div>
      ) : null}

      {confirmingCommit && !locked ? (
        <div className="glass-panel space-y-3 border border-amber-500/50 p-4" role="alertdialog" aria-label="Confirm allocation commit">
          <p className="text-sm">
            <strong>Commit is one-time and final.</strong> This founding
            build becomes your city&apos;s stats in a logged Resolution
            Event; there is no second commit and no respec. Growth from
            here is earned in play. Commit exactly this build?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !committable}
              aria-busy={busy === "commit"}
              onClick={handleRequestCommit}
            >
              {busy === "commit" ? "Requesting…" : "Yes — commit this build"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => setConfirmingCommit(false)}
            >
              Keep editing
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-emerald-400">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
