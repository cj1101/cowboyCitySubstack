/**
 * Membership approval is off. A signed-in person can use the realm unless a
 * sheriff has suspended or removed them.
 *
 * Set this to true to bring the waiting room back. Also require
 * status == 'approved' inside isMember() in firestore.rules and storage.rules.
 */
export const REQUIRE_APPROVAL = false;

export const ROOT_SHERIFF_EMAILS = [
  "charlie@suarezhouse.net",
  "cjtheswimmer1101@gmail.com",
] as const;

export function normalizeEmail(email: string | null | undefined): string {
  return (email || "").trim().toLowerCase();
}

export function isRootSheriffEmail(email: string | null | undefined): boolean {
  const normalized = normalizeEmail(email);
  return ROOT_SHERIFF_EMAILS.some((item) => item === normalized);
}

export function isBlockedStatus(status: string | undefined): boolean {
  return status === "suspended" || status === "removed";
}

export function canUseRealm(profile: {
  status?: string;
  isAdmin?: boolean;
} | null): boolean {
  if (profile && isBlockedStatus(profile.status)) return false;
  if (!profile) return !REQUIRE_APPROVAL;
  if (profile.isAdmin) return true;
  if (!REQUIRE_APPROVAL) return true;
  return profile.status === "approved";
}

export function isSheriff(
  profile: { isAdmin?: boolean; email?: string } | null,
  authEmail?: string | null
): boolean {
  if (profile?.isAdmin) return true;
  return isRootSheriffEmail(profile?.email || authEmail);
}
