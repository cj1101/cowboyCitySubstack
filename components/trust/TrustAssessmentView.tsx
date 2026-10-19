"use client";

/**
 * The separated view (June §7.4, TC-P12): a member's marks grouped by
 * subject city — the claim, THEIR stance, their note. Used for the
 * owner's own view and, read-only, for a view shared with the viewer.
 *
 * Attribution is structural here: every stance renders through
 * attributedStanceLabel with the AUTHOR's label ("CJ's assessment:
 * bullshit"), most of all inside a shared view — an assessment is
 * never rendered as a system verdict (TC-P12(iv)). A shared view is
 * view-only: it confers no export and no access to the owner's intel,
 * and the copy says exactly that.
 */

import {
  attributedRows,
  groupRowsByCity,
  type TrustAssessments,
} from "@/lib/trust/assessments";

interface TrustAssessmentViewProps {
  assessments: TrustAssessments;
  /** "Your" for the owner's own view; the owner's display label
   * (e.g. "CJ's") for a shared view. */
  authorLabel: string;
  isOwnView: boolean;
  cityLabels?: Record<string, string>;
  publicationLabels?: Record<string, string>;
  onClearMark?: (publicationId: string) => void | Promise<void>;
}

export function TrustAssessmentView({
  assessments,
  authorLabel,
  isOwnView,
  cityLabels,
  publicationLabels,
  onClearMark,
}: TrustAssessmentViewProps) {
  const rows = attributedRows(assessments, authorLabel);
  const groups = groupRowsByCity(rows);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-accent-gold">
          {isOwnView ? "Your separated view" : `${authorLabel} separated view`}
        </h2>
        <p className="text-text-muted text-sm mt-1">
          {isOwnView
            ? "Your own assessments of published claims — which you read as credible, bullshit, or unsure. Private to you unless you share this view."
            : `Shared with you by ${authorLabel.replace(/'s$/, "")}. View-only: this confers no export and no access to their intel or other data. Every stance below is their personal assessment, not a system verdict.`}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-text-muted">
          {isOwnView
            ? "You haven't assessed any published claims yet. Mark a claim from its city page and it will appear here."
            : "No assessments in this view yet."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.subjectCityId} className="glass-panel p-4 space-y-3">
            <h3 className="font-semibold">
              {cityLabels?.[group.subjectCityId] ?? group.subjectCityId}
            </h3>
            <ul className="space-y-3">
              {group.rows.map((row) => (
                <li key={row.publicationId} className="border-t border-white/10 pt-3">
                  <p className="font-medium">
                    {publicationLabels?.[row.publicationId] ?? row.publicationId}
                  </p>
                  <p className="text-sm mt-1">
                    <span className="font-semibold">{row.stanceLabel}</span>
                  </p>
                  {row.mark.note ? (
                    <p className="text-sm text-text-muted mt-1">{row.mark.note}</p>
                  ) : null}
                  {row.mark.updatedAtIso ? (
                    <p className="text-xs text-text-muted mt-1">
                      Marked {new Date(row.mark.updatedAtIso).toLocaleString()}
                    </p>
                  ) : null}
                  {isOwnView && onClearMark ? (
                    <button
                      type="button"
                      className="btn-secondary mt-2"
                      onClick={() => void onClearMark(row.publicationId)}
                    >
                      Clear assessment
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
