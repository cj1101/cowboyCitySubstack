/**
 * F10 — the Baseline fixture registry (QA plan v2 §1, Phase 2 brief §6.4).
 *
 * Tests exercise the citation machinery against this controlled registry —
 * two small versions, one section amended between them with an
 * `effectiveFromSeq`, one scoped exception — never against the draft
 * production text. The Phase 2 gate therefore passes pre-ratification
 * without faking ratification.
 *
 * Both versions are status "ratified" *inside the fixture world*: v0.1
 * from seq 1, v0.2 from seq 100 (the fixture amendment's effectiveFromSeq).
 */

import {
  computeBaselineDocHash,
  computeBaselineSectionHash,
  type BaselineRegistry,
  type BaselineSection,
} from "./registry";

const V01_TEXTS: Record<string, string> = {
  "WB-FIX-1": [
    "## WB-FIX-1 — Fixture market principle",
    "",
    "A market judgment weighs the affected city's recorded economic state",
    "and nothing else. (Fixture text v0.1.)",
  ].join("\n"),
  "WB-FIX-2": [
    "## WB-FIX-2 — Fixture scoped exception",
    "",
    "Inside its home city, the fixture exception is sim-active and may",
    "inform judgments. Outside that city it does not exist. (Fixture v0.1.)",
  ].join("\n"),
  "WB-FIX-3": [
    "## WB-FIX-3 — Fixture narrative principle",
    "",
    "Unresolvable cases are narrated honestly and flagged, never filled",
    "by analogy. (Fixture text v0.1.)",
  ].join("\n"),
};

const V02_AMENDED_WB_FIX_1 = [
  "## WB-FIX-1 — Fixture market principle",
  "",
  "A market judgment weighs the affected city's recorded economic state,",
  "its standing obligations, and nothing else. (Fixture text v0.2 —",
  "amended by fixture Town Hall resolution FIX-TH-1, effectiveFromSeq 100.)",
].join("\n");

function sectionsFor(
  texts: Record<string, string>,
  scopedCityId: string
): BaselineSection[] {
  return Object.entries(texts).map(([id, text]) => ({
    id,
    title: text.split("\n")[0].replace(/^##\s*/, ""),
    scope: id === "WB-FIX-2" ? { cityId: scopedCityId } : "realm",
    textHash: computeBaselineSectionHash(text),
  }));
}

function fullText(texts: Record<string, string>): string {
  return Object.values(texts).join("\n\n");
}

/**
 * Build the fixture registry for a given scoped-exception home city.
 * The F10 amendment fixture: v0.2 amends WB-FIX-1 only; WB-FIX-2/3 carry
 * over byte-identically (their textHashes must match across versions).
 */
export function buildFixtureBaselineRegistry(scopedCityId = "cityB"): BaselineRegistry {
  const v02Texts = { ...V01_TEXTS, "WB-FIX-1": V02_AMENDED_WB_FIX_1 };
  return {
    versions: [
      {
        version: "baseline-fixture-0.1",
        status: "ratified",
        docHash: computeBaselineDocHash(fullText(V01_TEXTS)),
        effectiveFromSeq: 1,
        sections: sectionsFor(V01_TEXTS, scopedCityId),
      },
      {
        version: "baseline-fixture-0.2",
        status: "ratified",
        docHash: computeBaselineDocHash(fullText(v02Texts)),
        effectiveFromSeq: 100,
        sections: sectionsFor(v02Texts, scopedCityId),
      },
    ],
  };
}

export const FIXTURE_BASELINE_TEXTS = { v01: V01_TEXTS, v02Amendment: V02_AMENDED_WB_FIX_1 };
