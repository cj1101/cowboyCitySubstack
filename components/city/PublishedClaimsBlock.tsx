"use client";

/**
 * The published-claims block (Phase 3 brief §7.2) — shared by the city
 * sheet section and the business entity pages (one component, every
 * surface; TC-D01 discipline).
 *
 * Renders the CURRENT version of each of the subject's claim chains
 * under the standing header — "Published by [owner] — claims, not
 * verified by the sim" — with the full chain one click away (version
 * history rendered from the same fetch, superseded versions labeled,
 * retracted chains never rendered as current). Each claim carries:
 * the "Owner-published" tier badge at figure prominence (§7.1), the
 * viewer's own mark control (§7.4, members only — other members'
 * marks are never shown here), and, where the TC-P03 eligibility
 * predicate holds for this viewer, the gated compare view (§7.3).
 */

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import {
  fetchCityClaimChains,
  type ClaimChain,
  type PublicationDoc,
} from "@/lib/dashboard/publications";
import {
  compareEligibility,
  loadIntelFigure,
  loadVerifiedFigure,
  parseClaims,
  type CompareSource,
  type PublicationClaim,
} from "@/lib/dashboard/trust";
import { ClaimCompare } from "./ClaimCompare";
import { TrustMarkControlConnected } from "@/components/trust/TrustMarkControl";

interface ClaimCompareState {
  claim: PublicationClaim;
  sources: CompareSource[];
}

function ClaimRow({
  publication,
  claim,
  cityId,
  publisherLabel,
  viewerIsFullMember,
}: {
  publication: PublicationDoc;
  claim: PublicationClaim;
  cityId: string;
  publisherLabel: string;
  viewerIsFullMember: boolean;
}) {
  const { user } = useAuth();
  const [compare, setCompare] = useState<ClaimCompareState | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedNone, setCheckedNone] = useState(false);

  // Eligibility is evaluated at render time against the viewer's own
  // legitimately-held sources (ruling clause i). The compare UI is
  // ABSENT until a source exists — there is no disabled placeholder.
  const openCompare = async () => {
    if (!user) return;
    setChecking(true);
    try {
      const db = getClientDb();
      const [verifiedFigure, intelFigure] = await Promise.all([
        loadVerifiedFigure(db, cityId, claim.metric),
        loadIntelFigure(db, user.uid, cityId, claim.metric),
      ]);
      const result = compareEligibility({
        viewerIsFullMember,
        claim,
        verifiedFigure,
        intelFigure,
      });
      if (result.eligible) {
        setCompare({ claim, sources: result.sources });
      } else {
        setCheckedNone(true);
      }
    } catch {
      setCheckedNone(true);
    } finally {
      setChecking(false);
    }
  };

  return (
    <li className="py-2 border-t border-black/5">
      <p>
        <span className="font-medium">{claim.metric}</span>:{" "}
        <strong>
          {typeof claim.claimedValue === "number"
            ? claim.claimedValue.toLocaleString()
            : claim.claimedValue}
        </strong>
        {claim.unit ? <span className="text-text-muted"> {claim.unit}</span> : null}{" "}
        <span className="text-xs uppercase tracking-wide border border-black/20 rounded px-1 py-0.5 align-middle">
          Owner-published
        </span>
        {claim.periodLabel ? (
          <span className="text-text-muted text-sm"> · {claim.periodLabel}</span>
        ) : null}
      </p>
      {claim.note ? <p className="text-sm text-text-muted">{claim.note}</p> : null}
      {viewerIsFullMember ? (
        <div className="mt-1">
          <TrustMarkControlConnected
            publicationId={publication.id}
            subjectCityId={cityId}
          />
        </div>
      ) : null}
      {viewerIsFullMember && !compare ? (
        <p className="mt-1">
          <button
            type="button"
            className="btn btn-secondary text-xs px-3 py-1"
            disabled={checking}
            onClick={() => void openCompare()}
          >
            {checking ? "Checking your sources…" : "Compare with a source you hold"}
          </button>
          {checkedNone ? (
            <span className="text-xs text-text-muted ml-2">
              No source you hold states a figure for this metric.
            </span>
          ) : null}
        </p>
      ) : null}
      {compare ? (
        <ClaimCompare
          claim={compare.claim}
          publisherLabel={publisherLabel}
          sources={compare.sources}
        />
      ) : null}
    </li>
  );
}

function ChainHistory({ chain }: { chain: ClaimChain }) {
  const [open, setOpen] = useState(false);
  if (chain.chain.length <= 1) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-xs text-accent-gold hover:text-accent-gold-hover"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} version history ({chain.chain.length} versions)
      </button>
      {open ? (
        <ul className="mt-1 space-y-1 text-sm text-text-muted">
          {chain.chain.map((version) => (
            <li key={version.id}>
              v{version.version} · {version.status} · published at Log #
              {version.publishedAtSeq}
              {version.id === chain.current.id ? " · current" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PublishedClaimsBlock({
  cityId,
  businessId = null,
  publisherLabel,
}: {
  cityId: string;
  /** Business pages pass the corporation id; city pages pass null
   *  (city-scoped chains only). */
  businessId?: string | null;
  publisherLabel: string;
}) {
  const { user } = useAuth();
  const [chains, setChains] = useState<ClaimChain[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewerIsFullMember, setViewerIsFullMember] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchCityClaimChains(getClientDb(), cityId)
      .then((result) => {
        if (!cancelled) setChains(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cityId]);

  // Full-member standing is read from the viewer's own users doc —
  // the same `accessLevel` field the rules' isFullMember() fence and
  // Felix's export requester read. Guests never see mark controls or
  // the compare affordance (§7.3/§7.4 are member surfaces).
  useEffect(() => {
    if (!user) {
      setViewerIsFullMember(false);
      return;
    }
    let cancelled = false;
    getDoc(doc(getClientDb(), "users", user.uid))
      .then((snap) => {
        if (!cancelled) {
          setViewerIsFullMember(snap.data()?.accessLevel !== "guest");
        }
      })
      .catch(() => {
        if (!cancelled) setViewerIsFullMember(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const visibleChains = useMemo(() => {
    if (!chains) return [];
    return chains.filter((chain) => {
      if (businessId === null) return chain.current.businessId === null;
      return chain.current.businessId === businessId;
    });
  }, [chains, businessId]);

  if (failed) {
    return (
      <section aria-label="Published claims" className="glass-panel p-5">
        <h3 className="hud-title">Published claims</h3>
        <p className="text-text-muted text-sm mt-2">
          Published claims couldn&apos;t be read just now. Nothing is shown
          rather than something stale.
        </p>
      </section>
    );
  }
  if (chains === null) {
    return (
      <section aria-label="Published claims" className="glass-panel p-5">
        <h3 className="hud-title">Published claims</h3>
        <p className="text-text-muted text-sm mt-2">Loading published claims…</p>
      </section>
    );
  }
  if (visibleChains.length === 0) return null;

  return (
    <section aria-label="Published claims" className="glass-panel p-5">
      <h3 className="hud-title">Published claims</h3>
      <p className="text-sm text-text-muted mt-1">
        Published by {publisherLabel} — claims, not verified by the sim.
      </p>
      {visibleChains.map((chain) => {
        const current = chain.current;
        const claims = parseClaims(current.claims);
        if (current.status === "retracted") {
          // A retracted chain renders AS retracted — never as current
          // claims, and never silently hidden either (§7.2).
          return (
            <div key={current.id} className="mt-3">
              <p className="text-xs text-text-muted">
                Version {current.version} · published at Log #{current.publishedAtSeq}
              </p>
              <p className="text-sm mt-1">
                <strong>Retracted by the publisher.</strong>{" "}
                <span className="text-text-muted">
                  These claims were withdrawn and are not current.
                </span>
              </p>
              <ChainHistory chain={chain} />
            </div>
          );
        }
        return (
          <div key={current.id} className="mt-3">
            <p className="text-xs text-text-muted">
              Version {current.version} · published at Log #{current.publishedAtSeq}
            </p>
            {claims.length > 0 ? (
              <ul>
                {claims.map((claim, i) => (
                  <ClaimRow
                    key={`${current.id}-${i}`}
                    publication={current}
                    claim={claim}
                    cityId={cityId}
                    publisherLabel={publisherLabel}
                    viewerIsFullMember={viewerIsFullMember}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text-muted">This version states no figures.</p>
            )}
            <ChainHistory chain={chain} />
          </div>
        );
      })}
    </section>
  );
}
