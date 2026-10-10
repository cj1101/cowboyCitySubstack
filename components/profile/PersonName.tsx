"use client";

import { useEffect, useState } from "react";
import { rolesForMember } from "@/lib/profile/identity";
import { cachedMember, loadMemberCard, type MemberCard } from "@/lib/profile/members";
import { MinecraftAvatar } from "@/components/profile/MinecraftAvatar";
import { RoleBadges } from "@/components/profile/RoleBadges";

export function PersonName({
  uid,
  name,
  email,
  minecraftUsername,
  avatarUrl,
  isAdmin,
  ownsCity,
  size = "sm",
}: {
  uid?: string;
  name: string;
  email?: string | null;
  minecraftUsername?: string;
  avatarUrl?: string;
  isAdmin?: boolean;
  ownsCity?: boolean;
  size?: "sm" | "md";
}) {
  const known = minecraftUsername !== undefined || isAdmin !== undefined || ownsCity !== undefined;
  const [card, setCard] = useState<MemberCard | null>(uid ? cachedMember(uid) ?? null : null);

  useEffect(() => {
    if (known || !uid) return;
    let cancelled = false;
    loadMemberCard(uid).then((next) => {
      if (!cancelled) setCard(next);
    });
    return () => {
      cancelled = true;
    };
  }, [known, uid]);

  const display = (known ? name : card?.displayName || name) || "Member";
  const skin = known ? minecraftUsername : card?.minecraftUsername;
  const photo = known ? avatarUrl : card?.avatarUrl;
  const roles = rolesForMember({
    isAdmin: known ? isAdmin : card?.isAdmin,
    ownsCity: known ? ownsCity : card?.ownsCity,
    email: known ? email : card?.email,
  });
  const pixels = size === "md" ? 48 : 28;

  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 max-w-full align-middle">
      <MinecraftAvatar username={skin} fallbackUrl={photo} label={display} size={pixels} />
      <span className="truncate font-bold">{display}</span>
      <RoleBadges roles={roles} />
    </span>
  );
}
