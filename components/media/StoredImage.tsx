"use client";

import { useState } from "react";
import Image from "next/image";
import { isDisplayableImageUrl, shouldOptimizeImage, UPLOAD_FAILED_MESSAGE } from "@/lib/images";

export function StoredImage({
  src,
  alt,
  className,
  fill = false,
  sizes = "(max-width: 768px) 100vw, 720px",
  width,
  height,
}: {
  src: string;
  alt: string;
  className?: string;
  fill?: boolean;
  sizes?: string;
  width?: number;
  height?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || !isDisplayableImageUrl(src)) {
    return <p className="text-sm font-bold p-3" role="alert">{UPLOAD_FAILED_MESSAGE}</p>;
  }
  if (shouldOptimizeImage(src)) {
    if (fill) {
      return (
        <Image
          src={src}
          alt={alt}
          fill
          className={className}
          sizes={sizes}
          onError={() => setFailed(true)}
        />
      );
    }
    return (
      <Image
        src={src}
        alt={alt}
        width={width ?? 1200}
        height={height ?? 900}
        className={className}
        sizes={sizes}
        onError={() => setFailed(true)}
      />
    );
  }
  if (fill) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt} className={`absolute inset-0 h-full w-full ${className || ""}`} onError={() => setFailed(true)} />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
  );
}
