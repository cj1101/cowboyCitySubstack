"use client";

import { isRootSheriffEmail } from "@/lib/membership";

export function minecraftAvatarUrl(name: string, size = 64): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(trimmed)) return "";
  return `https://mc-heads.net/avatar/${encodeURIComponent(trimmed)}/${size}`;
}

export function RoleBadges({
  email,
  isAdmin,
  founder,
}: {
  email?: string | null;
  isAdmin?: boolean;
  founder?: boolean;
}) {
  const badges = [
    isRootSheriffEmail(email) ? "Sheriff" : "",
    isAdmin ? "Admin" : "",
    founder ? "Founder" : "",
  ].filter((badge) => badge);

  if (badges.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((badge) => (
        <span key={badge} className="role-badge">{badge}</span>
      ))}
    </span>
  );
}

export function PlayerAvatar({
  minecraftName,
  avatarUrl,
  label,
  size = 64,
}: {
  minecraftName?: string;
  avatarUrl?: string;
  label: string;
  size?: number;
}) {
  const skin = minecraftName ? minecraftAvatarUrl(minecraftName, size) : "";
  const src = skin || avatarUrl || "";
  if (!src) {
    return (
      <span
        className="inline-flex items-center justify-center border-2 border-ink bg-accent-yellow font-bold text-on-yellow"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {label.charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className="border-2 border-ink object-cover bg-[#c6c6c6]"
      style={{ width: size, height: size, imageRendering: "pixelated" }}
    />
  );
}
