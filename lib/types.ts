import type { Timestamp } from "firebase/firestore";

export type PostType =
  | "announcement"
  | "build"
  | "lore"
  | "debate"
  | "event"
  | "wiki";

export const POST_TYPES: PostType[] = [
  "announcement",
  "build",
  "lore",
  "debate",
  "event",
  "wiki",
];

export const POST_TYPE_LABELS: Record<PostType, string> = {
  announcement: "Announcement",
  build: "Build",
  lore: "Lore",
  debate: "Debate",
  event: "Event",
  wiki: "Wiki",
};

export interface PostMentions {
  factions: string[];
  characters: string[];
  posts: string[];
}

export interface PostPoll {
  question: string;
  options: string[];
  votes: Record<string, number>;
}

export type PostStatus = "published" | "draft" | "scheduled";

export interface PostMedia {
  url: string;
  type: "image" | "video";
  thumbUrl?: string;
}

export interface Post {
  id: string;
  type: PostType;
  factionId: string;
  characterId: string;
  title: string;
  body: string;
  images?: string[];
  media?: PostMedia[];
  poll?: PostPoll;
  pinned?: boolean;
  mentions: PostMentions;
  cityIds?: string[];
  referencedPostIds?: string[];
  authorUid?: string;
  status?: PostStatus;
  publishAt?: Timestamp | null;
  settlementYear?: number | null;
  era?: string | null;
  contentWarning?: string | null;
  spoiler?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type CreatePostInput = Omit<
  Post,
  "id" | "createdAt" | "updatedAt" | "mentions"
> & {
  mentions?: Partial<PostMentions>;
};

export interface FactionColors {
  primary: string;
  secondary: string;
}

export type HtmlStatus = "approved" | "pending_review" | "rejected";

export interface Faction {
  id: string;
  name: string;
  slug: string;
  colors: FactionColors;
  bannerUrl?: string;
  sigilUrl?: string;
  bio?: string;
  description?: string;
  lore?: string;
  mapImageUrl?: string;
  liveHtml?: string;
  pendingHtml?: string;
  htmlStatus?: HtmlStatus;
  htmlSubmittedAt?: Timestamp;
  ownerUids: string[];
  createdAt?: Timestamp;
}

export interface FactionInput {
  name: string;
  slug: string;
  colors: FactionColors;
  bannerUrl?: string;
  sigilUrl?: string;
  bio?: string;
  description?: string;
  lore?: string;
  mapImageUrl?: string;
}

export interface Character {
  id: string;
  factionId: string;
  name: string;
  title?: string;
  avatarUrl?: string;
  isActive: boolean;
}

export interface CharacterInput {
  name: string;
  title?: string;
  avatarUrl?: string;
  isActive?: boolean;
}

export type FactionMemberRole = "owner" | "member";

export interface FactionMember {
  id: string;
  uid: string;
  factionId: string;
  role: FactionMemberRole;
}

export interface PostingIdentity {
  factionId: string;
  factionName: string;
  factionSlug: string;
  factionColors: FactionColors;
  characterId: string;
  characterName: string;
}

export type Stance = "for" | "against" | "neutral";

export type ReactionType = "agrees" | "disputes" | "witnessed";

export interface Reply {
  id: string;
  factionId: string;
  characterId: string;
  body: string;
  stance: Stance;
  authorUid?: string;
  authorName?: string;
  inCharacter?: boolean;
  createdAt: Timestamp;
}

export interface Reaction {
  type: ReactionType;
}

export interface ReactionCounts {
  agrees: number;
  disputes: number;
  witnessed: number;
}

export type MembershipStatus =
  | "pending"
  | "approved"
  | "denied"
  | "suspended"
  | "removed";

export type WikiEntryKind =
  | "character"
  | "place"
  | "faction"
  | "law"
  | "species"
  | "team";

export const WIKI_ENTRY_KINDS: WikiEntryKind[] = [
  "character",
  "place",
  "faction",
  "law",
  "species",
  "team",
];

export interface WikiEntryStats {
  columns: string[];
  rows: string[][];
}

export interface WikiEntry {
  id: string;
  cityId: string;
  citySlug: string;
  kind: WikiEntryKind;
  title: string;
  slug: string;
  summary?: string;
  body: string;
  stats?: WikiEntryStats | null;
  updatedAt?: Timestamp;
}

export interface MapPin {
  id: string;
  title: string;
  nx: number;
  ny: number;
  x?: number | null;
  z?: number | null;
  postId?: string | null;
  wikiEntryId?: string | null;
  note?: string;
}

export interface DirectMessage {
  id: string;
  senderUid: string;
  body: string;
  createdAt: Timestamp;
}

export interface Conversation {
  id: string;
  participantUids: string[];
  lastMessageAt?: Timestamp;
  lastMessagePreview?: string;
  lastSenderUid?: string;
  createdAt?: Timestamp;
}

export type NotificationType =
  | "mention"
  | "reference"
  | "reply"
  | "dm"
  | "approval";

export interface AppNotification {
  id: string;
  recipientUid: string;
  type: NotificationType;
  summary: string;
  href: string;
  read: boolean;
  actorUid?: string;
  createdAt?: Timestamp;
}

export function canUseRealm(profile: {
  status?: MembershipStatus | string;
  isAdmin?: boolean;
} | null): boolean {
  return profile?.status === "approved";
}
