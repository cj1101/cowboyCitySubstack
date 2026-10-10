"use client";

import { useState } from "react";
import Image from "next/image";
import { isDisplayableImageUrl, UPLOAD_FAILED_MESSAGE } from "@/lib/images";

export function StoredImage({
  src,
  alt,
  className,
  fill = false,
}: {
  src: string;
  alt: string;
  className?: string;
  fill?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed || !isDisplayableImageUrl(src)) {
    return <p className="text-sm font-bold p-3" role="alert">{UPLOAD_FAILED_MESSAGE}</p>;
  }
  if (fill) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        className={className}
        sizes="(max-width: 768px) 100vw, 720px"
        unoptimized={!src.startsWith("/")}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} onError={() => setFailed(true)} />
  );
}
