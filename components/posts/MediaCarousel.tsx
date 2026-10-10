"use client";

import { useCallback, useRef, useState } from "react";
import type { PostMedia } from "@/lib/types";
import { StoredImage } from "@/components/media/StoredImage";
import { Lightbox } from "@/components/media/Lightbox";

interface MediaCarouselProps {
  media: PostMedia[];
  title?: string;
}

export function MediaCarousel({ media, title }: MediaCarouselProps) {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const lock = useRef(false);

  const scrollTo = useCallback((next: number) => {
    const child = row.current?.children[next] as HTMLElement | undefined;
    lock.current = true;
    setIndex(next);
    child?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    window.setTimeout(() => {
      lock.current = false;
    }, 400);
  }, []);

  const goPrev = useCallback(() => {
    scrollTo(index === 0 ? media.length - 1 : index - 1);
  }, [index, media.length, scrollTo]);

  const goNext = useCallback(() => {
    scrollTo(index === media.length - 1 ? 0 : index + 1);
  }, [index, media.length, scrollTo]);

  if (media.length === 0) return null;

  return (
    <div className="relative w-full overflow-hidden bg-darker-brown">
      <div
        ref={row}
        className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-roledescription="carousel"
        aria-label={title ? `${title} photos` : "Post photos"}
        onScroll={(event) => {
          if (lock.current) return;
          const node = event.currentTarget;
          const width = node.clientWidth || 1;
          const next = Math.round(node.scrollLeft / width);
          if (next !== index && next >= 0 && next < media.length) setIndex(next);
        }}
      >
        {media.map((item, itemIndex) => (
          <div key={`${item.url}-${itemIndex}`} className="relative shrink-0 w-full snap-center aspect-square sm:aspect-[4/5] bg-black/40">
            {item.type === "video" ? (
              <video
                src={item.url}
                poster={item.thumbUrl}
                controls
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : (
              <button
                type="button"
                className="absolute inset-0"
                onClick={() => {
                  setIndex(itemIndex);
                  setOpen(true);
                }}
                aria-label={`Open photo ${itemIndex + 1} full screen`}
              >
                <StoredImage
                  src={item.url}
                  alt={title ? `${title} — ${itemIndex + 1}` : `Photo ${itemIndex + 1}`}
                  fill
                  sizes="(max-width: 768px) 100vw, 720px"
                  className="object-cover"
                />
              </button>
            )}
          </div>
        ))}
      </div>
      {media.length > 1 && (
        <>
          <button type="button" onClick={goPrev} className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-white/90 border border-primary-brown text-accent-gold font-bold" aria-label="Previous photo">
            ‹
          </button>
          <button type="button" onClick={goNext} className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-11 h-11 rounded-full bg-white/90 border border-primary-brown text-accent-gold font-bold" aria-label="Next photo">
            ›
          </button>
          <span className="absolute top-3 right-3 z-10 text-xs bg-white/90 px-2 py-1 border border-primary-brown">
            {index + 1} / {media.length}
          </span>
        </>
      )}
      {open && (
        <Lightbox
          media={media}
          index={index}
          title={title}
          onClose={() => setOpen(false)}
          onIndex={setIndex}
        />
      )}
    </div>
  );
}
