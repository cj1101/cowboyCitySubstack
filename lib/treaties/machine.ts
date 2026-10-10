export const TREATY_TYPES = ["alliance", "trade", "non-aggression", "other"] as const;
export type TreatyType = (typeof TREATY_TYPES)[number];
export type TreatyDecision = "accept" | "decline" | "counter" | "withdraw" | "break";
export type TreatyStatus = "pending" | "active" | "broken";
export type TreatyRevisionKind = "proposal" | "counter" | "renewal";

/** Active treaties inside this window show an "Expiring soon" badge. */
export const EXPIRING_SOON_DAYS = 14;

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
  expiresOn: string;
  renewOn: string;
  kind: TreatyRevisionKind;
  /** Milliseconds, when Firestore stored a timestamp. Display only. */
  at?: number;
}

export interface TreatyResponse {
  cityId: string;
  revision: number;
  decision: TreatyDecision;
  note?: string;
  /** Milliseconds, when Firestore stored a timestamp. Display only. */
  at?: number;
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
  expiresOn?: string;
  renewOn?: string;
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

export function parseTreatyDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export function cleanDate(value: string | undefined, label: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  if (!parseTreatyDate(trimmed)) throw new TreatyError(`The ${label} date should look like YYYY-MM-DD.`);
  return trimmed;
}

export type ExpiryBadge = "expiring" | "expired";

/** Badge for an active treaty. `now` is injectable so tests can pin the day. */
export function expiryBadge(expiresOn: string, now = new Date()): ExpiryBadge | null {
  const date = parseTreatyDate(expiresOn);
  if (!date) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const delta = date.getTime() - today;
  if (delta < 0) return "expired";
  if (delta <= EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000) return "expiring";
  return null;
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

/**
 * Cities that ratified the current revision. The revision's author counts.
 * Older saves stored the author's own revision as decision "counter".
 */
export function ratifiedCityIds(record: TreatyRecord): string[] {
  const revision = currentRevision(record);
  return responsesForRevision(record, revision.number)
    .filter(
      (response) =>
        response.decision === "accept" ||
        (response.decision === "counter" && response.cityId === revision.authorCityId)
    )
    .map((response) => response.cityId);
}

export function treatyStatus(record: TreatyRecord): TreatyStatus {
  const parties = ratifiedCityIds(record);
  const revision = currentRevision(record).number;
  const broke = responsesForRevision(record, revision).some((response) => response.decision === "break");
  if (broke && parties.length < 2) return "broken";
  return parties.length >= 2 ? "active" : "pending";
}

export function isPublicTreaty(record: TreatyRecord): boolean {
  const status = treatyStatus(record);
  return status === "active" || status === "broken";
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
        expiresOn: cleanDate(draft.expiresOn, "expiry"),
        renewOn: cleanDate(draft.renewOn, "renewal"),
        kind: "proposal",
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
  if (treatyStatus(record) === "broken") throw new TreatyError("This treaty is broken.");
  const revision = currentRevision(record).number;
  const responses = record.responses.filter(
    (response) => !(response.cityId === cityId && response.revision === revision)
  );
  responses.push({ cityId, revision, decision, note });
  return { ...record, responses };
}

export function acceptTreaty(record: TreatyRecord, cityId: string): TreatyRecord {
  if (treatyStatus(record) === "broken") throw new TreatyError("This treaty is broken.");
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
  if (treatyStatus(record) === "broken") throw new TreatyError("This treaty is broken.");
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
    expiresOn: changes.expiresOn !== undefined ? cleanDate(changes.expiresOn, "expiry") : previous.expiresOn,
    renewOn: changes.renewOn !== undefined ? cleanDate(changes.renewOn, "renewal") : previous.renewOn,
    kind: "counter",
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

/** A member proposes new dates. Every other member must ratify the new revision. */
export function renewTreaty(
  record: TreatyRecord,
  cityId: string,
  input: { expiresOn?: string; renewOn?: string; note: string }
): TreatyRecord {
  if (treatyStatus(record) !== "active") throw new TreatyError("Only an active treaty can be renewed.");
  if (!ratifiedCityIds(record).includes(cityId)) throw new TreatyError("Only a member can renew this treaty.");
  const note = input.note?.trim() || "";
  if (!note) throw new TreatyError("Add a note for the cities ratifying this renewal.");
  if (note.length > 500) throw new TreatyError("Keep the renewal note under 500 characters.");
  const expiresOn = cleanDate(input.expiresOn, "expiry");
  const renewOn = cleanDate(input.renewOn, "renewal");
  if (!expiresOn && !renewOn) throw new TreatyError("Set an expiry date or a renewal date.");
  const previous = currentRevision(record);
  const nextNumber = previous.number + 1;
  const inviteeCityIds = unique([
    ...previous.inviteeCityIds,
    ...(cityId === record.proposerCityId ? [] : [cityId]),
  ]).filter((id) => id !== record.proposerCityId);
  const revision: TreatyRevision = {
    number: nextNumber,
    name: previous.name,
    type: previous.type,
    nature: previous.nature,
    terms: previous.terms,
    purpose: previous.purpose,
    open: previous.open,
    inviteeCityIds,
    authorCityId: cityId,
    note,
    expiresOn,
    renewOn,
    kind: "renewal",
  };
  assertText(revision);
  return {
    proposerCityId: record.proposerCityId,
    revisions: [...record.revisions, revision],
    responses: [...record.responses, { cityId, revision: nextNumber, decision: "accept", note }],
  };
}

/** A member publicly leaves. Below two members, the treaty is broken and leaves the map. */
export function breakTreaty(record: TreatyRecord, cityId: string, note: string): TreatyRecord {
  if (treatyStatus(record) !== "active") throw new TreatyError("Only an active treaty can be broken.");
  if (!ratifiedCityIds(record).includes(cityId)) {
    throw new TreatyError("Only a member of this treaty can break it.");
  }
  const trimmed = note.trim();
  if (!trimmed) throw new TreatyError("Say why this treaty is breaking.");
  if (trimmed.length > 500) throw new TreatyError("Keep the break note under 500 characters.");
  return withResponse(record, cityId, "break", trimmed);
}

export function colorForTreatyName(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
  return TREATY_COLORS[hash % TREATY_COLORS.length];
}
