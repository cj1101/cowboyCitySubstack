"use client";

/**
 * The separated view (Phase 3 brief §7.4) — route per the brief's
 * [Proposal]: app/settings/trust.
 *
 * A member's own assessments of published claims, grouped by subject
 * city, every stance attributed to its author and never rendered as
 * a system verdict. From here the member can:
 *   - clear a mark (their own hand only — §11.3 rules fence),
 *   - run the §7.3 compare for their marked claims where eligibility
 *     holds for them (same predicate, same component as the city
 *     sheet — the view persists nothing),
 *   - manage who the view is shared with (TrustShareManager — a
 *     share confers this view only: not intel, not exports),
 *   - export their OWN assessments (§10.5 — their own data),
 * and read, read-only, the separated views other members shared
 * with them (each stance attributed to its author, TC-P12(iv)).
 *
 * Guests have no assessments and no page here.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { getAllFactions } from "@/lib/firestore/factions";
import { loadMemberCard } from "@/lib/profile/members";
import {
  clearTrustMark,
  loadOwnTrustAssessments,
  loadTrustAssessments,
  TRUST_ASSESSMENTS_COLLECTION,
} from "@/lib/trust/store";
import type { TrustAssessments } from "@/lib/trust/assessments";
import { TrustAssessmentView } from "@/components/trust/TrustAssessmentView";
import { TrustShareManagerConnected } from "@/components/trust/TrustShareManager";
import { ClaimCompare } from "@/components/city/ClaimCompare";
import {
  compareEligibility,
  loadIntelFigure,
  loadVerifiedFigure,
  parseClaims,
  type CompareSource,
  type PublicationClaim,
} from "@/lib/dashboard/trust";
import { downloadOwnAssessmentsWorkbook } from "@/lib/export/assessmentsWorkbook";

interface EligibleCompare {
  publicationId: string;
  claim: PublicationClaim;
  sources: CompareSource[];
}

interface SharedView {
  ownerUid: string;
  ownerLabel: string;
  assessments: TrustAssessments;
}

export default function TrustSettingsPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [own, setOwn] = useState<TrustAssessments | null>(null);
  const [cityLabels, setCityLabels] = useState<Record<string, string>>({});
  const [memberLabels, setMemberLabels] = useState<Record<string, string>>({});
  const [compares, setCompares] = useState<EligibleCompare[]>([]);
  const [sharedViews, setSharedViews] = useState<SharedView[]>([]);
  const [exportNote, setExportNote] = useState("");
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const db = getClientDb();
      const [assessments, factions] = await Promise.all([
        loadOwnTrustAssessments(user.uid),
        getAllFactions().catch(() => []),
      ]);
      if (cancelled) return;
      setOwn(assessments);
      setCityLabels(
        Object.fromEntries(factions.map((f) => [f.id, f.name]))
      );
      // Labels for the share manager (best effort; uids render raw
      // when a card can't be loaded).
      const labels: Record<string, string> = {};
      for (const uid of assessments.sharedWith) {
        const card = await loadMemberCard(uid).catch(() => null);
        if (card) labels[uid] = card.displayName;
      }
      if (!cancelled) setMemberLabels(labels);

      // The §7.4 compare affordance for the member's own marks:
      // eligibility evaluated per mark against the member's own
      // sources, exactly as on the city sheet.
      const eligible: EligibleCompare[] = [];
      for (const [publicationId, mark] of Object.entries(assessments.marks)) {
        try {
          const pubSnap = await getDoc(doc(db, "sim_publications", publicationId));
          if (!pubSnap.exists()) continue;
          const claims = parseClaims(pubSnap.data().claims);
          for (const claim of claims) {
            const [verifiedFigure, intelFigure] = await Promise.all([
              loadVerifiedFigure(db, mark.subjectCityId, claim.metric),
              loadIntelFigure(db, user.uid, mark.subjectCityId, claim.metric),
            ]);
            const result = compareEligibility({
              viewerIsFullMember: true,
              claim,
              verifiedFigure,
              intelFigure,
            });
            if (result.eligible) {
              eligible.push({ publicationId, claim, sources: result.sources });
            }
          }
        } catch {
          // A mark whose publication can't be read confers no compare.
        }
      }
      if (!cancelled) setCompares(eligible);

      // Views shared WITH this member (read-only, attributed).
      try {
        const sharedSnap = await getDocs(
          query(
            collection(db, TRUST_ASSESSMENTS_COLLECTION),
            where("sharedWith", "array-contains", user.uid)
          )
        );
        const views: SharedView[] = [];
        for (const ownerDoc of sharedSnap.docs) {
          if (ownerDoc.id === user.uid) continue;
          const loaded = await loadTrustAssessments(ownerDoc.id);
          if (!loaded) continue;
          const card = await loadMemberCard(ownerDoc.id).catch(() => null);
          views.push({
            ownerUid: ownerDoc.id,
            ownerLabel: card ? `${card.displayName}'s` : "A member's",
            assessments: loaded,
          });
        }
        if (!cancelled) setSharedViews(views);
      } catch {
        // No shared views is a normal state; failures stay silent
        // here rather than blocking the member's own view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const marksCount = useMemo(
    () => (own ? Object.keys(own.marks).length : 0),
    [own]
  );

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to see your assessments.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <header>
          <Link href="/settings" className="text-accent-gold hover:text-accent-gold-hover text-sm">
            ← Back to settings
          </Link>
          <h1 className="text-3xl font-bold text-accent-gold mt-2">
            Your assessments
          </h1>
          <p className="text-text-muted mt-1">
            Your own read on published claims — credible, bullshit, or
            unsure. These are yours alone: they never feed the sim, the
            market, or anyone else&apos;s screen, and a publisher never
            sees them.
          </p>
        </header>

        {own === null ? (
          <p className="text-text-muted">Loading your assessments…</p>
        ) : (
          <>
            <section className="glass-panel p-5">
              <TrustAssessmentView
                assessments={own}
                authorLabel="Your"
                isOwnView
                cityLabels={cityLabels}
                onClearMark={async (publicationId) => {
                  const next = await clearTrustMark(user.uid, publicationId);
                  setOwn(next);
                }}
              />
              {marksCount > 0 ? (
                <div className="mt-4 flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    className="btn btn-secondary text-sm px-4 py-2"
                    disabled={exportBusy}
                    onClick={async () => {
                      setExportBusy(true);
                      setExportNote("");
                      try {
                        await downloadOwnAssessmentsWorkbook({
                          uid: user.uid,
                          format: "xlsx",
                        });
                        setExportNote("Workbook downloaded.");
                      } catch (err) {
                        setExportNote(
                          err instanceof Error ? err.message : "Export failed."
                        );
                      } finally {
                        setExportBusy(false);
                      }
                    }}
                  >
                    {exportBusy ? "Preparing…" : "Download Excel — your assessments"}
                  </button>
                  {exportNote ? (
                    <span className="text-sm text-text-muted">{exportNote}</span>
                  ) : null}
                </div>
              ) : null}
            </section>

            {compares.length > 0 ? (
              <section className="glass-panel p-5" aria-label="Compares for your marks">
                <h2 className="hud-title">Compare your marks</h2>
                <p className="text-sm text-text-muted mt-1">
                  Where a source you hold states a figure for a claim
                  you marked, the two stand side by side — the claim,
                  your source, and the difference. Nothing is stored.
                </p>
                {compares.map((entry, i) => (
                  <ClaimCompare
                    key={`${entry.publicationId}-${i}`}
                    claim={entry.claim}
                    publisherLabel="the publisher"
                    sources={entry.sources}
                  />
                ))}
              </section>
            ) : null}

            <section className="glass-panel p-5" aria-label="Share your view">
              <h2 className="hud-title">Share this view</h2>
              <TrustShareManagerConnected memberLabels={memberLabels} />
            </section>

            {sharedViews.map((view) => (
              <section key={view.ownerUid} className="glass-panel p-5">
                <TrustAssessmentView
                  assessments={view.assessments}
                  authorLabel={view.ownerLabel}
                  isOwnView={false}
                  cityLabels={cityLabels}
                />
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
