/**
 * The per-user trust-separation layer (CJ §7.5; QA TC-P12; June phase3
 * brief §2.3/§7.4). Pure logic for `sim_trust_assessments/{uid}`.
 *
 * What this layer IS: one member's own, private-by-default record of
 * which published claims THEY assess as credible, bullshit, or unsure —
 * separable in their own UI and shareable as a view. What it is NOT: a
 * system truth verdict. A mark lives in the assessor's own collection,
 * so by construction it can never be rendered as anything but that
 * person's assessment; every rendering attributes the stance to its
 * author. Marks never feed the resolver, the market, standings, the
 * snapshot, or any other user's default screen.
 *
 * Caps (June §2.3 [Proposal], P3-K7): ≤ 1,000 marks per doc,
 * `sharedWith` ≤ 50 uids, note ≤ 500 chars — the same fences the
 * firestore.rules `validAssessments` check enforces.
 */

export type TrustStance = "credible" | "bullshit" | "unsure";

export const TRUST_STANCES: readonly TrustStance[] = [
  "credible",
  "bullshit",
  "unsure",
];

export const MAX_TRUST_MARKS = 1_000;
export const MAX_TRUST_SHARED_WITH = 50;
export const MAX_TRUST_NOTE_LENGTH = 500;

export interface TrustMark {
  stance: TrustStance;
  note: string | null;
  subjectCityId: string;
  /** ISO-8601 in the pure layer; the store converts to/from the
   * Firestore Timestamp the doc shape carries. */
  updatedAtIso: string | null;
}

export interface TrustAssessments {
  marks: Record<string, TrustMark>;
  sharedWith: string[];
  updatedAtIso: string | null;
}

export const EMPTY_TRUST_ASSESSMENTS: TrustAssessments = {
  marks: {},
  sharedWith: [],
  updatedAtIso: null,
};

export class TrustError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustError";
  }
}

export function isTrustStance(value: unknown): value is TrustStance {
  return (
    value === "credible" || value === "bullshit" || value === "unsure"
  );
}

/**
 * Defensive read normalization: any stored doc — including one written
 * by a future shape — yields a renderable assessments value. Malformed
 * marks are dropped (never guessed at), unknown stances are dropped,
 * notes are clamped to the cap, sharedWith is deduped and capped.
 */
export function normalizeTrustAssessments(raw: unknown): TrustAssessments {
  if (!raw || typeof raw !== "object") return { ...EMPTY_TRUST_ASSESSMENTS };
  const data = raw as Record<string, unknown>;
  const marks: Record<string, TrustMark> = {};
  const rawMarks = data.marks;
  if (rawMarks && typeof rawMarks === "object" && !Array.isArray(rawMarks)) {
    for (const [publicationId, value] of Object.entries(
      rawMarks as Record<string, unknown>
    )) {
      if (!value || typeof value !== "object") continue;
      const mark = value as Record<string, unknown>;
      if (!isTrustStance(mark.stance)) continue;
      if (typeof mark.subjectCityId !== "string" || !mark.subjectCityId) continue;
      marks[publicationId] = {
        stance: mark.stance,
        note:
          typeof mark.note === "string"
            ? mark.note.slice(0, MAX_TRUST_NOTE_LENGTH)
            : null,
        subjectCityId: mark.subjectCityId,
        updatedAtIso:
          typeof mark.updatedAtIso === "string" ? mark.updatedAtIso : null,
      };
      if (Object.keys(marks).length >= MAX_TRUST_MARKS) break;
    }
  }
  const sharedWith: string[] = [];
  if (Array.isArray(data.sharedWith)) {
    for (const uid of data.sharedWith) {
      if (typeof uid === "string" && uid.length > 0 && !sharedWith.includes(uid)) {
        sharedWith.push(uid);
      }
      if (sharedWith.length >= MAX_TRUST_SHARED_WITH) break;
    }
  }
  return {
    marks,
    sharedWith,
    updatedAtIso: typeof data.updatedAtIso === "string" ? data.updatedAtIso : null,
  };
}

/** Validate a member-authored mark before it is written. */
export function validateMarkInput(input: {
  stance: unknown;
  note?: string | null;
  subjectCityId: unknown;
}): Omit<TrustMark, "updatedAtIso"> {
  if (!isTrustStance(input.stance)) {
    throw new TrustError("Choose an assessment: credible, bullshit, or unsure.");
  }
  if (typeof input.subjectCityId !== "string" || !input.subjectCityId) {
    throw new TrustError("A mark needs the city the claim is about.");
  }
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.length > MAX_TRUST_NOTE_LENGTH) {
    throw new TrustError(
      `Keep the note under ${MAX_TRUST_NOTE_LENGTH} characters.`
    );
  }
  return {
    stance: input.stance,
    note: note.length > 0 ? note : null,
    subjectCityId: input.subjectCityId,
  };
}

/** Return a new doc with the mark set. Throws at the marks cap when
 * ADDING a new mark (replacing your own existing mark always works). */
export function withMark(
  doc: TrustAssessments,
  publicationId: string,
  mark: TrustMark
): TrustAssessments {
  const isNew = !(publicationId in doc.marks);
  if (isNew && Object.keys(doc.marks).length >= MAX_TRUST_MARKS) {
    throw new TrustError(
      `You have ${MAX_TRUST_MARKS} assessments — the cap for one view. Remove some before adding more.`
    );
  }
  return {
    ...doc,
    marks: { ...doc.marks, [publicationId]: mark },
  };
}

export function withoutMark(
  doc: TrustAssessments,
  publicationId: string
): TrustAssessments {
  if (!(publicationId in doc.marks)) return doc;
  const marks = { ...doc.marks };
  delete marks[publicationId];
  return { ...doc, marks };
}

/** Validate + set the share list. A share confers READING this view
 * and nothing else — not intel, not exports, not prefs (TC-P12(iii)). */
export function withSharedWith(
  doc: TrustAssessments,
  sharedWith: string[]
): TrustAssessments {
  const cleaned: string[] = [];
  for (const uid of sharedWith) {
    if (typeof uid === "string" && uid.length > 0 && !cleaned.includes(uid)) {
      cleaned.push(uid);
    }
  }
  if (cleaned.length > MAX_TRUST_SHARED_WITH) {
    throw new TrustError(
      `A view can be shared with at most ${MAX_TRUST_SHARED_WITH} members.`
    );
  }
  return { ...doc, sharedWith: cleaned };
}

/**
 * Who may VIEW an assessments doc: its owner, or a member named in
 * sharedWith. (Firestore rules are the enforcement; this predicate is
 * the UI's posture so affordances never imply a view that will fail.)
 * The publisher of a claim has NO special access to marks on it, and
 * guests hold no assessments at all.
 */
export function canViewAssessments(
  viewerUid: string | null,
  ownerUid: string,
  doc: TrustAssessments
): boolean {
  if (!viewerUid) return false;
  if (viewerUid === ownerUid) return true;
  return doc.sharedWith.includes(viewerUid);
}

/**
 * The attribution rule (TC-P12(iv)): a stance is ALWAYS rendered with
 * its author — "Your assessment: credible" in your own view, "CJ's
 * assessment: bullshit" in a shared one. Never a bare verdict chip.
 */
export function attributedStanceLabel(authorLabel: string, stance: TrustStance): string {
  return `${authorLabel} assessment: ${stance}`;
}

export interface AttributedMarkRow {
  publicationId: string;
  mark: TrustMark;
  authorLabel: string;
  stanceLabel: string;
}

/** All marks, attributed, grouped-ready (subject city, then claim). */
export function attributedRows(
  doc: TrustAssessments,
  authorLabel: string
): AttributedMarkRow[] {
  return Object.entries(doc.marks)
    .map(([publicationId, mark]) => ({
      publicationId,
      mark,
      authorLabel,
      stanceLabel: attributedStanceLabel(authorLabel, mark.stance),
    }))
    .sort((a, b) =>
      a.mark.subjectCityId === b.mark.subjectCityId
        ? a.publicationId.localeCompare(b.publicationId)
        : a.mark.subjectCityId.localeCompare(b.mark.subjectCityId)
    );
}

export function groupRowsByCity(
  rows: AttributedMarkRow[]
): { subjectCityId: string; rows: AttributedMarkRow[] }[] {
  const groups = new Map<string, AttributedMarkRow[]>();
  for (const row of rows) {
    const list = groups.get(row.mark.subjectCityId) ?? [];
    list.push(row);
    groups.set(row.mark.subjectCityId, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([subjectCityId, groupRows]) => ({ subjectCityId, rows: groupRows }));
}
