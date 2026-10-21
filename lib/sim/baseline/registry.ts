/**
 * The World Baseline registry (Phase 2 brief §6.2) — the machine-readable
 * form of the Baseline the resolver cites. A markdown file cannot be
 * cited by code; this registry can: for each version, its status, the
 * `docHash` of its §1 text (the ratification draft §5.2 normalization,
 * fixed here in code), and a section table with structured scope metadata
 * (TC-W06 needs scope as data, not prose).
 *
 * Registry versions are append-only: replay and citation checks always
 * use the CITED version + hash (TC-A03/TC-W05), so old versions are never
 * deleted.
 *
 * Status of the production text: **RATIFIED**. The ratification draft
 * (Vera, workstreams/world-baseline-ratification-draft.md) was adopted
 * as World Baseline 1.0 by CJ ruling in the War Room on 2026-10-20
 * (Option A of workstreams/baseline-ratification-pack.md, closing the
 * P2-K2 process call left open in workstreams/phase2-decisions.md):
 * under the Baseline's own precedence (§1.2.2.5) the ruling is the
 * ratifying act, and the one-line status flip in this file — shipped
 * as its own reviewed change, never a runtime mutation — is its
 * record. The entry's `effectiveFromSeq` stays null in this registry
 * until production genesis stamps it on `sim_world/current` (pack §3:
 * the version is citable from production seq 1 onward via that stamp),
 * so `citableBaselineVersion` still selects nothing from the code
 * registry alone pre-genesis; citations of the ratified version verify
 * against this entry (TC-W01 forbids citing a draft — this text is no
 * longer one).
 */

import { sha256HexOfText } from "../canonical";

export type BaselineScope =
  | "realm"
  | { cityId: string }
  | { layer: string };

export interface BaselineSection {
  id: string;
  title: string;
  scope: BaselineScope;
  /** sha256 over the section's normalized text (see normalizeBaselineText). */
  textHash: string;
}

export interface BaselineVersion {
  version: string;
  status: "draft" | "ratified";
  /** sha256 over the version's full §1 text under §5.2 normalization. */
  docHash: string;
  sections: BaselineSection[];
  /** First seq at which this version may be cited (amendments are
   * prospective only, TC-W04). Null while draft; world-baseline-1.0
   * also carries null here post-ratification, until production genesis
   * stamps it (ratification pack §3). */
  effectiveFromSeq: number | null;
}

export interface BaselineCitation {
  version: string;
  docHash: string;
  sections: string[];
  interpretation: string | null;
  interpretationId: string | null;
}

export interface BaselineRegistry {
  versions: BaselineVersion[];
}

function sha256Raw(text: string): string {
  return sha256HexOfText(text);
}

/**
 * The §5.2 normalization, fixed in code: UTF-8, LF line endings, exactly
 * one trailing newline, sections in document order. `computeBaselineDocHash`
 * over a candidate text must reproduce the stored `docHash` of the version
 * that text claims to be — a silent edit to the Baseline is mechanically
 * detectable.
 */
export function normalizeBaselineText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/, "") + "\n";
}

export function computeBaselineDocHash(sectionOneText: string): string {
  return sha256Raw(normalizeBaselineText(sectionOneText));
}

export function computeBaselineSectionHash(sectionText: string): string {
  return sha256Raw(normalizeBaselineText(sectionText));
}

export function getBaselineVersion(
  registry: BaselineRegistry,
  version: string
): BaselineVersion | null {
  return registry.versions.find((v) => v.version === version) ?? null;
}

export function getBaselineSection(
  registry: BaselineRegistry,
  version: string,
  sectionId: string
): BaselineSection | null {
  const v = getBaselineVersion(registry, version);
  return v?.sections.find((s) => s.id === sectionId) ?? null;
}

/** The version a resolution may cite right now: the ratified version in
 * force at `atSeq`, or null pre-ratification. Draft versions are NEVER
 * returned here — that is the fail-closed posture of brief §6.4 made
 * mechanical. */
export function citableBaselineVersion(
  registry: BaselineRegistry,
  atSeq: number
): BaselineVersion | null {
  let best: BaselineVersion | null = null;
  for (const v of registry.versions) {
    if (v.status !== "ratified") continue;
    if (v.effectiveFromSeq === null || v.effectiveFromSeq > atSeq) continue;
    if (best === null || (v.effectiveFromSeq as number) > (best.effectiveFromSeq as number)) {
      best = v;
    }
  }
  return best;
}

/** Does a section's structured scope cover an entry about these cities? */
export function sectionScopeCovers(section: BaselineSection, cityIds: string[]): boolean {
  if (section.scope === "realm") return true;
  if ("cityId" in section.scope) return cityIds.includes(section.scope.cityId);
  // Layer-scoped sections are checked by the audit surface (TC-W03/W06);
  // the mechanical resolver check treats a layer scope as covering only
  // entries that name the layer's home city, which the registry cannot
  // know — so layer scopes never auto-cover in the commit path.
  return false;
}

// ---------------------------------------------------------------------------
// The production registry. One version: world-baseline-1.0, status
// "ratified" (CJ ruling, War Room 2026-10-20; the docHash is unchanged
// — ratification adopts the identified text, it does not edit it).
// Section textHashes + docHash were computed from
// workstreams/world-baseline-ratification-draft.md §1 at Phase 2 build
// time under the normalization above; recomputing them over the draft
// file (see tests/sim-core.test.ts vectors for the fixture analogue)
// reproduces them exactly.
// ---------------------------------------------------------------------------

const R = "realm" as const;

export const PRODUCTION_BASELINE_REGISTRY: BaselineRegistry = {
  versions: [
    {
      version: "world-baseline-1.0",
      status: "ratified",
      docHash: "db01a43ab1e6015d18d82cc09bf48cddea70a320bad44617f9d39e6a4e0d63ae",
      effectiveFromSeq: null,
      sections: [
        { id: "1.0", title: "What this document is", scope: R, textHash: "af554840a3dd73d25812d3c38245aff91793c74716a7cc1101cde9fba683f2c7" },
        { id: "1.0.1", title: "Purpose", scope: R, textHash: "fe863b5b92ebc90e4f7f1d6d8269824182a1f5c08b4f2276387203a98138608d" },
        { id: "1.0.2", title: "Labeling conventions", scope: R, textHash: "158fc67794378ca9a0d986911085aebb219a02d5348039d765009d5ff14686a3" },
        { id: "1.0.3", title: "Placement and lifecycle", scope: R, textHash: "609fe758397e9df1b25513530e346037f0a51fd3d24f68c32a87f960a67803e0" },
        { id: "1.1", title: "Precedence and citation", scope: R, textHash: "da829ad75ecba4265973b4cacbcac019351a651d222458a6cf72b6d75b9d8c91" },
        { id: "1.1.1", title: "The precedence stack", scope: R, textHash: "fedcb821b81d5fbddf7b26f3c09ba1bc3483cbd54476790c411b3bf68fe8fc63" },
        { id: "1.1.2", title: "The two canon layers and the Baseline", scope: R, textHash: "3638ef895c4caa5b8bcfbfd72d0f83278b314713f70470c78e25c9a30565f77b" },
        { id: "1.1.3", title: "How resolutions cite the Baseline", scope: R, textHash: "ffad5bceda5ccc1dc5155880f2e28eef92904ce36af1c22062250cd2dd63340e" },
        { id: "1.2", title: "Interpretation and amendment", scope: R, textHash: "289e37e27e777b8b5bcdcfd9175f1e5715b4acac82f3c5263ebdcf8becbe3418" },
        { id: "1.2.1", title: "Interpretation protocol", scope: R, textHash: "ca7bcee83316e9873748e1ac75acaaa22ec1274943ab16e267fb2d982bc06cee" },
        { id: "1.2.2", title: "Amendment process", scope: R, textHash: "b1bfe8cf87de57f03fc460236c96771a5ad887f726129c4dcca529717db2f8b9" },
        { id: "1.2.3", title: "What \"clear\" means in this document", scope: R, textHash: "176d4a3eed4fdc7bf7dba824d4d76135ce93131426213174ae24fa97cec1ce66" },
        { id: "WB-3", title: "Physical world and geography", scope: R, textHash: "f11fd6bf8b4b68664c9f13a3e9b2490da7f4206c1de72c874c8b2f7e8486f0fa" },
        { id: "WB-3.1", title: "Material defaults", scope: R, textHash: "56855c8b0c2682441479ee7d3a46a2ee80432af01a55cdec5834976e9a16912c" },
        { id: "WB-3.2", title: "Geography is fixed until a player changes it", scope: R, textHash: "07727674446aa007252c7ad19ac28ab6a2e5b6395b1122961b9a2ad69eb40a1e" },
        { id: "WB-3.3", title: "Space, distance, and neighbors", scope: R, textHash: "4bc5a4f43ca9b7253a448c7b4c88a76866b12e743eaa24a8c2825fb214200642" },
        { id: "WB-4", title: "Economy and market defaults", scope: R, textHash: "120b9a9efb9bd35fe4db1d5b22c5297f39439f8942e0662e1e6cf95412158d15" },
        { id: "WB-4.1", title: "Currency and the shape of the economy", scope: R, textHash: "bf2f4c82e5042301dba020cbce725f6584e693f88390779517b83758f18dd2e5" },
        { id: "WB-4.2", title: "Economic models differ by city — as lore, not as engine settings", scope: R, textHash: "5036970facd7bcddd5dfcb9a202892a00b2c1c12dfef744140a3b7196dd73a53" },
        { id: "WB-4.3", title: "The AI-as-market", scope: R, textHash: "bc2eccb217042cbf7d11200751a78b2f4d6c95c81706ec5c475fff558fbf900f" },
        { id: "WB-4.4", title: "Scarcity, damage, and downtime", scope: R, textHash: "8d9ecf498c29afc6963d685121a4d782c5c5bc9d11e55ef65f304f4a6dfcb6df" },
        { id: "WB-5", title: "Individual psychology", scope: R, textHash: "ac5b14676b81fa0a4d7c16a88ae3eed6704e8848d1c43db351f95d4be3327961" },
        { id: "WB-5.1", title: "Core defaults", scope: R, textHash: "da779aff1b77317426f99e1810a62962d3470d42b249cd3dc4d9e7a7c321d1ac" },
        { id: "WB-5.2", title: "Characters and NPCs", scope: R, textHash: "7dc5d846265df3b6d2dcea893211aeb6dd198a5345fc9b3e9aa3ba5520d732cf" },
        { id: "WB-5.3", title: "Corpus-grounded illustrations (examples, not universal laws)", scope: R, textHash: "4f905b2e842f98a34f7319dc5d2e9cfd22660f668a74e42bc39e2bdd9418e9b1" },
        // WB-5.4 is the Baseline's scoped exception: the Vif, sim-active
        // inside Cascadia's adopted scope only (CJ §7.9). The scope key is
        // the corpus city id; the seed crosswalk binds it to a factionId
        // when that mapping exists (Phase 1 leaves seedCityId null).
        { id: "WB-5.4", title: "The Vif — a scoped biological exception, sim-active", scope: { cityId: "cascadia" }, textHash: "7d21a98bcb93e00d5b9b3a96244abdc7b15730873329d54ea85110ce3ef37471" },
        { id: "WB-6", title: "Society, sociology, and trickle-down propagation", scope: R, textHash: "5fcac6bcfb4bf36601480f98a76aba4bf995b0d08d7464620b4a067780b2aafd" },
        { id: "WB-6.1", title: "The propagation discipline", scope: R, textHash: "b93d2042683154b79bec32b398bb7ecf2c8877cb4872539c683ecc9220870850" },
        { id: "WB-6.2", title: "Social defaults", scope: R, textHash: "3def4c8c9602f2e3caf72ed0b0bcc2dc547f92e3e8ab7e1c8f70d679d5382702" },
        { id: "WB-6.3", title: "Population and households", scope: R, textHash: "d88c2bd0eb4b2f4f4b4cdec7089b0aa6b4f11299992fc2d868be50746c9e6592" },
        { id: "WB-6.4", title: "Sport as social infrastructure", scope: R, textHash: "708f63f0d291008d759ba4733c4df149fb6e51fbc4608dbc832dbf5b93f872bf" },
        { id: "WB-7", title: "Information environment: press and connectivity as causal infrastructure", scope: R, textHash: "ba51b3d7770e323de4a4fa7e8dc032a0489bf6e202231a6e5146d951495bff9e" },
        { id: "WB-7.1", title: "Knowledge is local, partial, and earned", scope: R, textHash: "46fd7faafcc915f56450d0b8f44f430c79fe92ff374e6b5dd1168057e2bd3ea1" },
        { id: "WB-7.2", title: "Connectivity infrastructure", scope: R, textHash: "4b5ca293c589a92fd070e865d1da5d3362541fd09052e40f72e4563296222183" },
        { id: "WB-7.3", title: "The press: existence is a fact, freedom is a variable", scope: R, textHash: "f2b6154c609f470fa89ee7332a82775a16ca80c228d546fab9031b05e69ef59a" },
        { id: "WB-7.4", title: "Deliberate collection: surveys, insiders, spies", scope: R, textHash: "b93b441db3f9c1c02a85469d2d45b208979a12b79d78ad6d9efb72dcb7f3a3e7" },
        { id: "WB-7.5", title: "Covert action and the two Logs", scope: R, textHash: "d1202fa946b655ef062e2ef3a50ed4c7b9f8555d403f9c259fc8da8a88227ae0" },
        { id: "WB-8", title: "Time and delayed consequences", scope: R, textHash: "540da5fe79ca033420abd264cf962f62a7339d92e29e15ed3cef06d00a2bb023" },
        { id: "WB-8.1", title: "The only clock is still the Log", scope: R, textHash: "5cefbf409281b8c4ffc49ea6ff408cc07030f60d0db9fd6a0369cb823af03b0f" },
        { id: "WB-8.2", title: "Ripening: delayed consequences of present actions", scope: R, textHash: "ddeaa0e8ce8c41a8aaa6e800c6f7097e6531965ce0f00a80821ff0b1b036b78c" },
        { id: "WB-8.3", title: "The canonical test case", scope: R, textHash: "794984e8102969cd293f12071bc3a0ae699f6d7226ecdc329a04a80b0e855605" },
        { id: "WB-8.4", title: "Duration defaults", scope: R, textHash: "39309dec4c57fc9254dfda7beb8aefd8e249abe23a455e18d36f66adf2afc344" },
        { id: "WB-9", title: "Cross-cutting principles", scope: R, textHash: "e43f619c9e11abe5e1b901c88b66a5c33cd1878a231ad440d75d4f7fa6357d99" },
      ],
    },
  ],
};
