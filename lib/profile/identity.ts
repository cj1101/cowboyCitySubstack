import { isRootSheriffEmail, isSheriff } from "@/lib/membership";

export const MINECRAFT_NAME = /^[A-Za-z0-9_]{3,16}$/;

export type RealmRole = "sheriff" | "founder" | "admin";

export const ROLE_LABELS: Record<RealmRole, string> = {
  sheriff: "Sheriff",
  founder: "Founder",
  admin: "Admin",
};

export function minecraftAvatarUrl(username: string | null | undefined): string | null {
  const name = (username || "").trim();
  if (!MINECRAFT_NAME.test(name)) return null;
  return `https://mc-heads.net/avatar/${encodeURIComponent(name)}`;
}

export function normalizeMinecraftUsername(value: string): string {
  const name = value.trim();
  if (!name) return "";
  if (!MINECRAFT_NAME.test(name)) {
    throw new Error("Minecraft usernames are 3–16 letters, numbers, or underscores.");
  }
  return name;
}

/** Sheriff moderates, Founder owns a city, Admin is a root site owner. */
export function rolesForMember(input: {
  isAdmin?: boolean;
  ownsCity?: boolean;
  email?: string | null;
}): RealmRole[] {
  const roles: RealmRole[] = [];
  if (isSheriff({ isAdmin: input.isAdmin, email: input.email || undefined }, input.email)) {
    roles.push("sheriff");
  }
  if (input.ownsCity) roles.push("founder");
  if (isRootSheriffEmail(input.email)) roles.push("admin");
  return roles;
}
