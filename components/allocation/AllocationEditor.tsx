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
  saveAllocationDraft,
  submitAllocationCommitAction,
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
   * these. By default Save writes through lib/allocation/draftSave (the
   * rules' owner draft fence and nothing else), and Commit runs the
   * default flow in handleSubmitCommit: save the final map as the head
   * draft, then submit the `allocate_season0` action that references it.
   * A page that injects onSaveDraft should inject onSubmitCommit too —
   * the default commit flow needs the saved draft's version + hash from
   * the real saver.
   */
  onSaveDraft?: (values: AllocationValues) => Promise<void>;
  onSubmitCommit?: (values: AllocationValues) => Promise<void>;
}

/**
 * The Season-0 allocation editor (R-35): shape your city's founding build
 * from the shared 400-point pool. Drafts save freely; the commit is
 * one-time and final (no respec — amendment §3.4), so it is two-step and
 * stays disabled until the allocation validates exactly.
 *
 * ==========================================================================
 * COMMIT — AN ACTION, NOT A STATUS WRITE (P4-K14, brief §3.3)
 * ==========================================================================
 * The two-step confirmation below is presentation: the second step saves
 * the final map as the head draft and SUBMITS the `allocate_season0`
 * action (lib/allocation/commitAction.ts). The binding confirmation is
 * the member's hash-bound confirmation on the action's preview (§2.3
 * never-bind card) — nothing is committed by this editor. The fabric
 * queues the confirmed action (setting 'commit_requested' itself),
 * resolves it in a wake, and the commit lands as a logged Resolution
 * Event. Once a commit is submitted this editor locks locally: saving a
 * newer draft would stale the submitted action (§3.4), so the lock is
 * the honest presentation of that discipline.
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
  onSubmitCommit,
}: AllocationEditorProps) {
  const [values, setValues] = useState<AllocationValues>(() =>
    normalizeAllocation(initialAllocations)
  );
  const [status, setStatus] = useState<AllocationStatus>(initialStatus);
  const [draftVersion, setDraftVersion] = useState(initialDraftVersion);
  const [busy, setBusy] = useState<"draft" | "commit" | null>(null);
  const [confirmingCommit, setConfirmingCommit] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const locked =
    submitted ||
    status === "committed" ||
    status === "commit_requested" ||
    status === "superseded";
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

  async function handleSubmitCommit() {
    setError("");
    setNotice("");
    setBusy("commit");
    try {
      if (onSubmitCommit) {
        await onSubmitCommit(values);
      } else {
        // Save the final map as the head draft first: the commit action
        // references the draft by version + hash (brief §3.3 step 1), so
        // what the fabric previews is exactly the draft as saved.
        const saved = await saveAllocationDraft({
          cityId,
          values,
          authorUid,
          previousDraftVersion: draftVersion,
        });
        await submitAllocationCommitAction({
          cityId,
          values,
          authorUid,
          draftVersion: saved.draftVersion,
        });
        setDraftVersion(saved.draftVersion);
      }
      setSubmitted(true);
      setConfirmingCommit(false);
      setNotice(
        "Commit action submitted. The fabric will preview this exact build; " +
          "your confirmation on that preview is the binding act, and the commit " +
          "then lands as a logged Resolution Event. This build is locked meanwhile."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit commit");
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
            The fabric has queued this build&apos;s confirmed commit action
            and it is locked while the commit stands in the queue.
          </p>
        ) : submitted ? (
          <p className="text-sm text-amber-400" role="status">
            A commit action for this build has been submitted and it is
            locked while the submission stands.
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
            here is earned in play. Submitting creates the commit action —
            the fabric previews this exact build first, and your
            confirmation on that preview is the binding act. Submit
            exactly this build?
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn"
              disabled={busy !== null || !committable}
              aria-busy={busy === "commit"}
              onClick={handleSubmitCommit}
            >
              {busy === "commit" ? "Submitting…" : "Yes — submit this build"}
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
