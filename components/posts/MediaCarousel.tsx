"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PostMedia } from "@/lib/types";
import { StoredImage } from "@/components/media/StoredImage";

interface MediaCarouselProps {
  media: PostMedia[];
  title?: string;
}

export function MediaCarousel({ media, title }: MediaCarouselProps) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const startX = useRef<number | null>(null);

  const goPrev = useCallback(() => {
    setIndex((current) => (current === 0 ? media.length - 1 : current - 1));
  }, [media.length]);
  const goNext = useCallback(() => {
    setIndex((current) => (current === media.length - 1 ? 0 : current + 1));
  }, [media.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrev();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, goNext, goPrev]);

  if (media.length === 0) return null;
  const item = media[Math.min(index, media.length - 1)];
  const caption = title ? `${title} — ${index + 1} of ${media.length}` : `Photo ${index + 1} of ${media.length}`;

  const swipe = (event: React.PointerEvent, phase: "down" | "up") => {
    if (media.length < 2) return;
    if (phase === "down") {
      startX.current = event.clientX;
      return;
    }
    if (startX.current == null) return;
    const delta = event.clientX - startX.current;
    startX.current = null;
    if (delta <= -40) goNext();
    else if (delta >= 40) goPrev();
  };

  const frame = (viewer: boolean) => (
    item.type === "video" ? (
      <video
        key={item.url}
        src={item.url}
        poster={item.thumbUrl}
        controls
        playsInline
        className={viewer ? "max-w-full max-h-[85vh] object-contain" : "w-full h-auto max-h-[70vh] object-contain bg-black"}
      />
    ) : (
      <StoredImage
        src={item.url}
        alt={caption}
        className={viewer ? "max-w-full max-h-[85vh] w-auto h-auto object-contain" : "w-full h-auto max-h-[70vh] object-contain bg-[#f7f6f3]"}
      />
    )
  );

  return (
    <div className="relative w-full">
      <div
        className="relative w-full bg-black/10 touch-pan-y"
        onPointerDown={(event) => swipe(event, "down")}
        onPointerUp={(event) => swipe(event, "up")}
        onPointerCancel={() => { startX.current = null; }}
      >
        {item.type === "image" ? (
          <button type="button" className="block w-full" onClick={() => setOpen(true)} aria-label="Open full screen">
            {frame(false)}
          </button>
        ) : frame(false)}
      </div>
      {media.length > 1 && (
        <>
          <button type="button" onClick={goPrev} className="absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/95 border-2 border-ink font-bold" aria-label="Previous photo">
            ‹
          </button>
          <button type="button" onClick={goNext} className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/95 border-2 border-ink font-bold" aria-label="Next photo">
            ›
          </button>
          <span className="absolute top-3 right-3 text-xs bg-white/95 px-2 py-1 border border-ink">
            {index + 1} / {media.length}
          </span>
        </>
      )}
      {open && (
        <div className="fixed inset-0 z-[80] bg-black/90 flex flex-col" role="dialog" aria-modal="true" aria-label={caption}>
          <div className="flex justify-between items-center px-3 py-2 text-white">
            <p className="text-sm">{caption}</p>
            <button type="button" className="min-h-11 min-w-11 text-2xl" onClick={() => setOpen(false)} aria-label="Close viewer">×</button>
          </div>
          <div
            className="flex-1 flex items-center justify-center px-3 pb-6 touch-pan-y"
            onPointerDown={(event) => swipe(event, "down")}
            onPointerUp={(event) => swipe(event, "up")}
          >
            {frame(true)}
          </div>
          {media.length > 1 && (
            <div className="flex justify-center gap-3 pb-4">
              <button type="button" className="btn btn-secondary min-h-11 px-4" onClick={goPrev}>Previous</button>
              <button type="button" className="btn btn-secondary min-h-11 px-4" onClick={goNext}>Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
