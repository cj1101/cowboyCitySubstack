export const TREATY_TYPES = ["alliance", "trade", "non-aggression", "other"] as const;
export type TreatyType = (typeof TREATY_TYPES)[number];
export type TreatyDecision = "accept" | "decline" | "counter" | "withdraw";
export type TreatyStatus = "pending" | "active";

export const TREATY_TYPE_LABELS: Record<TreatyType, string> = {
  alliance: "Alliance",
  trade: "Trade pact",
  "non-aggression": "Non-aggression",
  other: "Other",
};

export const TREATY_COLORS = [
  "#169C9C",
  "#C4516C",
  "#3D7A3A",
  "#3A5FCD",
  "#B15E12",
  "#7A4E9A",
  "#1F7A8C",
  "#A33B3B",
] as const;

export class TreatyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreatyError";
  }
}

export interface TreatyRevision {
  number: number;
  name: string;
  type: TreatyType;
  nature: string;
  terms: string;
  purpose: string;
  open: boolean;
  inviteeCityIds: string[];
  authorCityId: string;
  note: string;
}

export interface TreatyResponse {
  cityId: string;
  revision: number;
  decision: TreatyDecision;
  note?: string;
}

export interface TreatyDraft {
  name: string;
  type: TreatyType;
  nature: string;
  terms: string;
  purpose: string;
  open: boolean;
  inviteeCityIds: string[];
  proposerCityId: string;
}

export interface TreatyRecord {
  proposerCityId: string;
  revisions: TreatyRevision[];
  responses: TreatyResponse[];
}

export interface TreatyAccess {
  isAdmin?: boolean;
  ownedCityIds: string[];
}

function unique(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function assertText(draft: { name: string; type: TreatyType; nature: string; terms: string; purpose: string }) {
  if (!TREATY_TYPES.includes(draft.type)) throw new TreatyError("Unknown treaty type.");
  if (!draft.name.trim() || draft.name.trim().length > 160) throw new TreatyError("A treaty needs a name.");
  if (!draft.purpose.trim() || draft.purpose.trim().length > 500) {
    throw new TreatyError("Add a short purpose.");
  }
  if (draft.nature.trim().length > 8000 || draft.terms.trim().length > 20000) {
    throw new TreatyError("That text is too long.");
  }
}

export function currentRevision(record: TreatyRecord): TreatyRevision {
  const revision = [...record.revisions].sort((a, b) => a.number - b.number).at(-1);
  if (!revision) throw new TreatyError("This treaty has no revision.");
  return revision;
}

export function responsesForRevision(record: TreatyRecord, revision: number): TreatyResponse[] {
  const latest = new Map<string, TreatyResponse>();
  for (const response of record.responses) {
    if (response.revision === revision) latest.set(response.cityId, response);
  }
  return [...latest.values()];
}

/** Cities that ratified the current revision. The revision's author counts. */
export function ratifiedCityIds(record: TreatyRecord): string[] {
  const revision = currentRevision(record).number;
  return responsesForRevision(record, revision)
    .filter((response) => response.decision === "accept")
    .map((response) => response.cityId);
}

export function treatyStatus(record: TreatyRecord): TreatyStatus {
  return ratifiedCityIds(record).length >= 2 ? "active" : "pending";
}

export function isPublicTreaty(record: TreatyRecord): boolean {
  return treatyStatus(record) === "active";
}

export function canCityAct(record: TreatyRecord, cityId: string): boolean {
  const revision = currentRevision(record);
  if (revision.open) return Boolean(cityId);
  return cityId === record.proposerCityId || revision.inviteeCityIds.includes(cityId);
}

/**
 * Pending treaties are visible to admins and owners of involved cities.
 * An open treaty is visible to every city owner so they can ratify.
 * Active treaties are public.
 */
export function canReadTreaty(record: TreatyRecord, access: TreatyAccess): boolean {
  if (access.isAdmin) return true;
  if (isPublicTreaty(record)) return true;
  const revision = currentRevision(record);
  if (revision.open && access.ownedCityIds.length > 0) return true;
  const involved = new Set([record.proposerCityId, ...revision.inviteeCityIds]);
  return access.ownedCityIds.some((cityId) => involved.has(cityId));
}

export function proposeTreaty(draft: TreatyDraft): TreatyRecord {
  assertText(draft);
  if (!draft.proposerCityId) throw new TreatyError("Choose the city making this proposal.");
  const inviteeCityIds = unique(draft.inviteeCityIds).filter((id) => id !== draft.proposerCityId);
  if (!draft.open && inviteeCityIds.length === 0) {
    throw new TreatyError("Invite at least one city, or open the treaty to every city.");
  }
  return {
    proposerCityId: draft.proposerCityId,
    revisions: [
      {
        number: 1,
        name: draft.name.trim(),
        type: draft.type,
        nature: draft.nature.trim(),
        terms: draft.terms.trim(),
        purpose: draft.purpose.trim(),
        open: draft.open,
        inviteeCityIds,
        authorCityId: draft.proposerCityId,
        note: "",
      },
    ],
    responses: [{ cityId: draft.proposerCityId, revision: 1, decision: "accept" }],
  };
}

function withResponse(
  record: TreatyRecord,
  cityId: string,
  decision: TreatyDecision,
  note?: string
): TreatyRecord {
  const revision = currentRevision(record).number;
  const responses = record.responses.filter(
    (response) => !(response.cityId === cityId && response.revision === revision)
  );
  responses.push({ cityId, revision, decision, note });
  return { ...record, responses };
}

export function acceptTreaty(record: TreatyRecord, cityId: string): TreatyRecord {
  if (!canCityAct(record, cityId)) throw new TreatyError("That city cannot ratify this treaty.");
  return withResponse(record, cityId, "accept");
}

export function declineTreaty(record: TreatyRecord, cityId: string): TreatyRecord {
  if (!canCityAct(record, cityId)) throw new TreatyError("That city cannot respond to this treaty.");
  if (cityId === currentRevision(record).authorCityId) {
    throw new TreatyError("The author of this revision already ratifies it. Withdraw instead.");
  }
  return withResponse(record, cityId, "decline");
}

export function withdrawTreaty(record: TreatyRecord, cityId: string): TreatyRecord {
  if (!ratifiedCityIds(record).includes(cityId)) {
    throw new TreatyError("Only a city that ratified this revision can withdraw.");
  }
  return withResponse(record, cityId, "withdraw");
}

export function counterTreaty(
  record: TreatyRecord,
  cityId: string,
  changes: Partial<Omit<TreatyDraft, "proposerCityId">> & { note: string }
): TreatyRecord {
  if (!canCityAct(record, cityId)) throw new TreatyError("That city cannot counter-propose.");
  if (!changes.note?.trim()) throw new TreatyError("Describe the requested changes.");
  const previous = currentRevision(record);
  const nextNumber = previous.number + 1;
  const inviteeCityIds = unique([
    ...(changes.inviteeCityIds ?? previous.inviteeCityIds),
    ...(cityId === record.proposerCityId ? [] : [cityId]),
  ]).filter((id) => id !== record.proposerCityId);
  const revision: TreatyRevision = {
    number: nextNumber,
    name: (changes.name ?? previous.name).trim(),
    type: changes.type ?? previous.type,
    nature: (changes.nature ?? previous.nature).trim(),
    terms: (changes.terms ?? previous.terms).trim(),
    purpose: (changes.purpose ?? previous.purpose).trim(),
    open: changes.open ?? previous.open,
    inviteeCityIds,
    authorCityId: cityId,
    note: changes.note.trim(),
  };
  assertText(revision);
  return {
    proposerCityId: record.proposerCityId,
    revisions: [...record.revisions, revision],
    responses: [
      ...record.responses,
      { cityId, revision: nextNumber, decision: "accept", note: revision.note },
    ],
  };
}

export function colorForTreatyName(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return TREATY_COLORS[hash % TREATY_COLORS.length];
}
