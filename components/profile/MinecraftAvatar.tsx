"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { isDisplayableImageUrl, shouldOptimizeImage } from "@/lib/images";
import { minecraftAvatarUrl } from "@/lib/profile/identity";

export function MinecraftAvatar({
  username,
  fallbackUrl,
  label,
  size = 40,
}: {
  username?: string;
  fallbackUrl?: string;
  label: string;
  size?: number;
}) {
  const skin = minecraftAvatarUrl(username);
  const photo = fallbackUrl && isDisplayableImageUrl(fallbackUrl) ? fallbackUrl : "";
  const [mode, setMode] = useState<"skin" | "photo" | "initial">(skin ? "skin" : photo ? "photo" : "initial");

  useEffect(() => {
    setMode(skin ? "skin" : photo ? "photo" : "initial");
  }, [skin, photo]);

  const className = "pixel-image shrink-0 border-2 border-ink bg-white";
  if (mode === "skin" && skin) {
    return (
      <Image
        src={skin}
        alt=""
        width={size}
        height={size}
        sizes={`${size}px`}
        className={className}
        style={{ width: size, height: size }}
        onError={() => setMode(photo ? "photo" : "initial")}
      />
    );
  }
  if (mode === "photo" && photo) {
    if (!shouldOptimizeImage(photo)) {
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photo}
          alt=""
          width={size}
          height={size}
          className={`${className} object-cover`}
          style={{ width: size, height: size }}
          onError={() => setMode("initial")}
        />
      );
    }
    return (
      <Image
        src={photo}
        alt=""
        width={size}
        height={size}
        sizes={`${size}px`}
        className={`${className} object-cover`}
        style={{ width: size, height: size }}
        onError={() => setMode("initial")}
      />
    );
  }
  return (
    <span
      className={`${className} inline-flex items-center justify-center font-bold text-on-yellow bg-accent-yellow`}
      style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.4)) }}
      aria-hidden
    >
      {(label || "?").charAt(0).toUpperCase()}
    </span>
  );
}
