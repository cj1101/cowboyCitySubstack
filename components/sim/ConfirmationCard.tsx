"use client";

/**
 * The never-bind confirmation card (Petra spec §4.3; June design
 * §7.2) — the plan-wide binding-step primitive for NPC-originated
 * proposals and situation confirmations. It renders when an NPC
 * output, a draft, or a delegated proposal wants to become real,
 * and it is addressed to the owning owner only: surfaces render it
 * solely where the viewer is the owner it addresses.
 *
 * The contract, mechanically:
 *  - The FULL consequence text renders before either control:
 *    what will happen (exact effects), under what authority (each
 *    citation links to the readable authority text), and what will
 *    NOT happen — one sentence, always present.
 *  - Exactly ONE confirm control, named for the act (never a
 *    generic "OK" / "Continue"), and exactly ONE decline control.
 *    Backing out is always available before confirmation.
 *  - No timeout, no auto-confirm, no "confirm all". Declining is a
 *    complete outcome, stated on the card itself.
 *
 * This is the presentation primitive; the binding itself still
 * runs through the fabric's preview + hash-bound confirmation —
 * confirming here hands the confirmed act to the caller's submit,
 * which the play loop then previews and binds.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { SubmitButton } from "@/components/ui/SubmitButton";

export interface AuthorityCitation {
  /** e.g. "mandate v4", "envelope NPC-000123", "delegation rule v2". */
  label: string;
  /** Link to the readable authority text, when a surface serves it. */
  href?: string;
}

export interface SimConfirmationCardProps {
  /** Addressed line: who this binds, e.g. "Confirmation — only you
   * can bind Cascadia". */
  title: string;
  /** Who proposed this, badged at change prominence:
   * "〈NPC name〉, for 〈owner〉 · under mandate v4". */
  proposedBy: string;
  /** The authority chain this confirms under — mandate / rule /
   * envelope / proposal — each rendered as a citation. */
  authority: AuthorityCitation[];
  /** EXACT EFFECTS IF YOU CONFIRM — one line per effect, evaluated
   * on current state, spillover included as its own lines. */
  effects: string[];
  /** Legal-case warning line, when flagged; null renders the
   * honest "Legal: none flagged". */
  legalWarning?: string | null;
  /** What will NOT happen — one sentence, always present (§4.3). */
  notHappening: string;
  /** The decline outcome, stated plainly ("Declining is a complete
   * outcome: …"). */
  declineOutcome: string;
  /** The confirm control's name — the act itself ("Confirm — bind
   * Cascadia"). Never generic. */
  confirmLabel: string;
  declineLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onDecline: () => void;
  /** After confirmation, the caller renders the Log chain here
   * (proposal → confirmation → change, with seqs). */
  afterConfirm?: ReactNode;
  confirmed?: boolean;
}

export function ConfirmationCard({
  title,
  proposedBy,
  authority,
  effects,
  legalWarning,
  notHappening,
  declineOutcome,
  confirmLabel,
  declineLabel = "Decline",
  busy,
  error,
  onConfirm,
  onDecline,
  afterConfirm,
  confirmed,
}: SimConfirmationCardProps) {
  return (
    <section
      aria-label={title}
      className="rounded border border-accent-gold bg-glass-bg p-4 flex flex-col gap-3 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h4 className="font-bold">{title}</h4>
        <p className="text-text-muted">{proposedBy}</p>
        {authority.length > 0 && (
          <p className="text-text-muted">
            Under{" "}
            {authority.map((citation, i) => (
              <span key={`${citation.label}-${i}`}>
                {i > 0 ? " · " : ""}
                {citation.href ? (
                  <Link href={citation.href} className="text-accent-gold underline">
                    {citation.label}
                  </Link>
                ) : (
                  citation.label
                )}
              </span>
            ))}
          </p>
        )}
      </div>

      <div>
        <h5 className="text-xs font-bold uppercase tracking-wide text-text-muted">
          Exact effects if you confirm
        </h5>
        <ul className="list-disc pl-5 mt-1 flex flex-col gap-1">
          {effects.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-text-muted">
          {legalWarning ? `Legal: ${legalWarning}` : "Legal: none flagged."}
        </p>
      </div>

      <p>
        <strong>What will not happen:</strong> {notHappening}
      </p>
      <p className="text-text-muted">{declineOutcome}</p>

      {error ? (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      ) : null}

      {confirmed ? (
        afterConfirm ?? (
          <p role="status">Confirmed. The Log carries the chain from here.</p>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn btn-secondary min-h-11"
            onClick={onDecline}
            disabled={busy}
          >
            {declineLabel}
          </button>
          <SubmitButton
            type="button"
            busy={busy ?? false}
            busyLabel="Confirming…"
            onClick={onConfirm}
            className="btn min-h-11"
          >
            {confirmLabel}
          </SubmitButton>
        </div>
      )}
    </section>
  );
}
