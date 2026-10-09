"use client";

import { useCallback, useState } from "react";
import type { PostMedia } from "@/lib/types";

interface MediaCarouselProps {
  media: PostMedia[];
  title?: string;
}

export function MediaCarousel({ media, title }: MediaCarouselProps) {
  const [index, setIndex] = useState(0);
  const goPrev = useCallback(() => {
    setIndex((current) => (current === 0 ? media.length - 1 : current - 1));
  }, [media.length]);
  const goNext = useCallback(() => {
    setIndex((current) => (current === media.length - 1 ? 0 : current + 1));
  }, [media.length]);

  if (media.length === 0) return null;
  const item = media[index];

  return (
    <div className="relative w-full overflow-hidden bg-darker-brown">
      <div className="relative aspect-square sm:aspect-[4/5] w-full bg-black/40">
        {item.type === "video" ? (
          <video
            key={item.url}
            src={item.url}
            poster={item.thumbUrl}
            controls
            playsInline
            className="w-full h-full object-contain bg-black"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.url}
            alt={title ? `${title} — ${index + 1}` : `Media ${index + 1}`}
            className="w-full h-full object-cover"
          />
        )}
      </div>
      {media.length > 1 && (
        <>
          <button type="button" onClick={goPrev} className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-glass-bg/90 border border-accent-gold text-accent-gold font-bold" aria-label="Previous">
            ‹
          </button>
          <button type="button" onClick={goNext} className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-glass-bg/90 border border-accent-gold text-accent-gold font-bold" aria-label="Next">
            ›
          </button>
          <span className="absolute top-3 right-3 text-xs bg-glass-bg/90 px-2 py-1 rounded border border-accent-gold/30">
            {index + 1} / {media.length}
          </span>
        </>
      )}
    </div>
  );
}
