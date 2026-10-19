"use client";

/**
 * The per-city sim stat sheet (Phase 3 brief §6.1).
 *
 * One component for every city — the identical component backs the
 * city page's Sim sheet section and the dashboard my-city panel's
 * sheet variant, so TC-D01's identical-component requirement holds by
 * construction. No city-slug conditionals anywhere (TC-D02).
 *
 * Renders ONLY verified figures from `sim_cities/{factionId}` (via
 * `lib/stats/statSheet`'s model). Owner-published claims are a
 * separate block owned by the trust layer (§7.2) and never merge
 * into this table; corpus/lore figures never appear here (TC-D04).
 * Every non-null figure carries its why-link to the Log (§6.2);
 * null figures carry their honest caption instead (§6.1).
 */

import { useEffect, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import {
  NULL_CAPTIONS,
  SIM_INDEX_KEYS,
  buildStatSheetModel,
  formatStatValue,
  type StatSheetModel,
} from "@/lib/stats/statSheet";
import { buildWhyLinkHref } from "@/lib/stats/whyLink";

/** The pure render half: model in, sheet out. */
export function SimSheetView({ model }: { model: StatSheetModel }) {
  if (model.state === "not-in-sim") {
    return (
      <section aria-label="Simulation stats">
        <h3 className="hud-title">Sim sheet</h3>
        <p>
          This city isn&apos;t in the sim yet — its owner hasn&apos;t claimed it.
          There are no sim figures to show, and none are invented here.
        </p>
      </section>
    );
  }

  const indexFigures = model.figures.filter((figure) =>
    (SIM_INDEX_KEYS as readonly string[]).includes(figure.key)
  );
  const stockFigures = model.figures.filter(
    (figure) => !(SIM_INDEX_KEYS as readonly string[]).includes(figure.key)
  );

  const renderFigure = (figure: (typeof model.figures)[number]) => (
    <tr key={figure.key}>
      <th scope="row">{figure.label}</th>
      <td>
        {figure.display}
        {figure.unit ? ` ${figure.unit}` : ""}
        {figure.nullCaption ? (
          <span> — {NULL_CAPTIONS[figure.nullCaption]}</span>
        ) : null}
        {figure.growthSinceAllocation !== null &&
        figure.growthSinceAllocation !== 0 ? (
          <span>
            {" "}
            ({figure.growthSinceAllocation > 0 ? "+" : ""}
            {formatStatValue(figure.growthSinceAllocation)} since allocation)
          </span>
        ) : null}
      </td>
      <td>
        {figure.whyLink ? (
          <a href={buildWhyLinkHref(figure.whyLink)}>Why?</a>
        ) : null}
      </td>
    </tr>
  );

  return (
    <section aria-label="Simulation stats">
      <h3 className="hud-title">Sim sheet</h3>
      <p>
        {model.allocationState === "allocated" ? (
          <>
            Season-0 allocation committed.
            {model.allocationCommittedSeq !== null ? (
              <>
                {" "}
                <a
                  href={buildWhyLinkHref({
                    cityId: model.factionId,
                    fieldPath: null,
                    anchorSeq: model.allocationCommittedSeq,
                  })}
                >
                  Allocation entry (Log #{model.allocationCommittedSeq})
                </a>
              </>
            ) : null}
          </>
        ) : (
          "Not yet allocated — the owner allocates this city's Season-0 pool in play."
        )}
        {model.lastChangedSeq !== null
          ? ` Last changed at Log #${model.lastChangedSeq}.`
          : ""}
      </p>
      <table>
        <caption>Verified figures — from the sim</caption>
        <tbody>{indexFigures.map(renderFigure)}</tbody>
        <tbody>{stockFigures.map(renderFigure)}</tbody>
      </table>
    </section>
  );
}

/** The loading half: reads the city's sim doc + allocation doc under
 * the viewer's own identity (rules govern what comes back) and builds
 * the model. A missing sim doc is the not-in-sim state, not an error. */
export default function SimSheet({ factionId }: { factionId: string }) {
  const [model, setModel] = useState<StatSheetModel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getClientDb();
        const [citySnap, allocationSnap] = await Promise.all([
          getDoc(doc(db, "sim_cities", factionId)),
          getDoc(doc(db, "sim_stat_allocations", factionId)),
        ]);
        if (cancelled) return;
        setModel(
          buildStatSheetModel({
            factionId,
            simCity: citySnap.exists()
              ? (citySnap.data() as Record<string, unknown>)
              : null,
            allocation: allocationSnap.exists()
              ? (allocationSnap.data() as Record<string, unknown>)
              : null,
          })
        );
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [factionId]);

  if (failed) {
    return (
      <section aria-label="Simulation stats">
        <h3 className="hud-title">Sim sheet</h3>
        <p>The sim sheet couldn&apos;t be read just now. No figures are shown rather than wrong ones.</p>
      </section>
    );
  }
  if (model === null) {
    return (
      <section aria-label="Simulation stats">
        <h3 className="hud-title">Sim sheet</h3>
        <p>Reading the sim sheet…</p>
      </section>
    );
  }
  return <SimSheetView model={model} />;
}
