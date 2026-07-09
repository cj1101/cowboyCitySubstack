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

export interface Post {
  id: string;
  type: PostType;
  factionId: string;
  characterId: string;
  title: string;
  body: string;
  images?: string[];
  poll?: PostPoll;
  pinned?: boolean;
  mentions: PostMentions;
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
