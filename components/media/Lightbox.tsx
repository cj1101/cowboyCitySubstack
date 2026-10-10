"use client";

import { useEffect, useRef } from "react";
import type { PostMedia } from "@/lib/types";
import { StoredImage } from "@/components/media/StoredImage";

export function Lightbox({
  media,
  index,
  title,
  onClose,
  onIndex,
}: {
  media: PostMedia[];
  index: number;
  title?: string;
  onClose: () => void;
  onIndex: (index: number) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const item = media[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") onIndex(index === media.length - 1 ? 0 : index + 1);
      if (event.key === "ArrowLeft") onIndex(index === 0 ? media.length - 1 : index - 1);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [index, media.length, onClose, onIndex]);

  useEffect(() => {
    const child = row.current?.children[index] as HTMLElement | undefined;
    if (!child) return;
    lock.current = true;
    child.scrollIntoView({ inline: "center", block: "nearest" });
    const timer = window.setTimeout(() => {
      lock.current = false;
    }, 400);
    return () => window.clearTimeout(timer);
  }, [index]);

  if (!item) return null;

  const go = (delta: number) => {
    const next = (index + delta + media.length) % media.length;
    onIndex(next);
  };

  return (
    <div className="fixed inset-0 z-[80] bg-ink/95 text-white flex flex-col" role="dialog" aria-modal="true" aria-label={title || "Photo viewer"}>
      <div className="flex items-center justify-between gap-3 px-3 py-3">
        <p className="text-sm font-bold truncate">{title || "Photo"} · {index + 1} / {media.length}</p>
        <button type="button" className="btn text-sm px-4 py-2" onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div
        ref={row}
        className="flex-1 flex overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(event) => {
          if (lock.current) return;
          const node = event.currentTarget;
          const width = node.clientWidth || 1;
          const next = Math.round(node.scrollLeft / width);
          if (next !== index && next >= 0 && next < media.length) onIndex(next);
        }}
      >
        {media.map((entry, entryIndex) => (
          <div key={`${entry.url}-${entryIndex}`} className="relative shrink-0 w-full snap-center h-full min-h-[60vh]">
            {entry.type === "video" ? (
              <video
                src={entry.url}
                poster={entry.thumbUrl}
                controls
                playsInline
                className="absolute inset-0 h-full w-full object-contain"
              />
            ) : (
              <StoredImage
                src={entry.url}
                alt={title ? `${title} — ${entryIndex + 1}` : `Photo ${entryIndex + 1}`}
                fill
                sizes="100vw"
                className="object-contain"
              />
            )}
          </div>
        ))}
      </div>
      {media.length > 1 && (
        <div className="flex items-center justify-center gap-3 px-3 py-4">
          <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={() => go(-1)} aria-label="Previous photo">
            Previous
          </button>
          <button type="button" className="btn btn-secondary text-sm px-4 py-2" onClick={() => go(1)} aria-label="Next photo">
            Next
          </button>
        </div>
      )}
    </div>
  );
}
