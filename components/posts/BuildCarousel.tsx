"use client";

import { useCallback, useState } from "react";
import { StoredImage } from "@/components/media/StoredImage";

interface BuildCarouselProps {
  images: string[];
  title?: string;
}

export function BuildCarousel({ images, title }: BuildCarouselProps) {
  const [index, setIndex] = useState(0);

  const goPrev = useCallback(() => {
    setIndex((i) => (i === 0 ? images.length - 1 : i - 1));
  }, [images.length]);

  const goNext = useCallback(() => {
    setIndex((i) => (i === images.length - 1 ? 0 : i + 1));
  }, [images.length]);

  if (images.length === 0) return null;

  return (
    <div className="relative w-full rounded-lg overflow-hidden border border-primary-brown bg-darker-brown">
      <div className="relative aspect-video w-full">
        <StoredImage
          src={images[index]}
          alt={title ? `${title} — image ${index + 1}` : `Build image ${index + 1}`}
          fill
          className="object-cover"
        />
      </div>

      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={goPrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 border border-primary-brown text-accent-gold font-bold hover:bg-accent-yellow hover:text-on-yellow transition-colors"
            aria-label="Previous image"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={goNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 border border-primary-brown text-accent-gold font-bold hover:bg-accent-yellow hover:text-on-yellow transition-colors"
            aria-label="Next image"
          >
            ›
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === index ? "bg-accent-gold" : "bg-text-muted/50"
                }`}
                aria-label={`Go to image ${i + 1}`}
              />
            ))}
          </div>
          <span className="absolute top-3 right-3 text-xs bg-glass-bg/90 px-2 py-1 rounded border border-primary-brown text-text-muted">
            {index + 1} / {images.length}
          </span>
        </>
      )}
    </div>
  );
}
