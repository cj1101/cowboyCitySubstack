"use client";

import { useState } from "react";
import Link from "next/link";
import { StoredImage } from "@/components/media/StoredImage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { actionError } from "@/lib/async";
import { UPLOAD_FAILED_MESSAGE } from "@/lib/images";
import type { MapPin } from "@/lib/types";

export function MapBoard({
  imageUrl,
  pins,
  canEdit,
  onUpload,
  onAddPin,
  onDeletePin,
}: {
  imageUrl?: string;
  pins: MapPin[];
  canEdit: boolean;
  onUpload?: (file: File) => Promise<void>;
  onAddPin: (pin: Omit<MapPin, "id">) => Promise<void>;
  onDeletePin: (pinId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<{ nx: number; ny: number } | null>(null);
  const [title, setTitle] = useState("");
  const [postId, setPostId] = useState("");
  const [wikiEntryId, setWikiEntryId] = useState("");
  const [x, setX] = useState("");
  const [z, setZ] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");

  const place = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canEdit || !imageUrl) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setDraft({
      nx: (event.clientX - rect.left) / rect.width,
      ny: (event.clientY - rect.top) / rect.height,
    });
  };

  return (
    <div className="space-y-4">
      {canEdit && onUpload && (
        <label className="block text-sm">
          <span className="form-label">Map image</span>
          <input
            type="file"
            accept="image/*"
            className="form-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file || !onUpload) return;
              setError("");
              setNotice("");
              setPreview(URL.createObjectURL(file));
              setBusy(true);
              onUpload(file)
                .then(() => setNotice("Map image saved."))
                .catch((err) => setError(actionError(err, UPLOAD_FAILED_MESSAGE)))
                .finally(() => setBusy(false));
            }}
          />
        </label>
      )}
      {error && <p className="text-sm font-bold" role="alert">{error}</p>}
      {notice && <p className="text-sm font-bold" role="status">{notice}</p>}
      {imageUrl || preview ? (
        <div className="relative border-4 border-ink overflow-hidden cursor-crosshair" onClick={place}>
          <StoredImage src={imageUrl || preview} alt="City map" className="w-full h-auto block pixel-image" />
          {pins.map((pin) => (
            <Link
              key={pin.id}
              href={pin.postId ? `/posts/${pin.postId}` : "#"}
              className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full bg-accent-yellow border border-on-yellow"
              style={{ left: `${pin.nx * 100}%`, top: `${pin.ny * 100}%` }}
              title={pin.title}
              onClick={(event) => event.stopPropagation()}
            />
          ))}
          {draft && (
            <span className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full bg-accent-cyan border border-on-yellow" style={{ left: `${draft.nx * 100}%`, top: `${draft.ny * 100}%` }} />
          )}
        </div>
      ) : (
        <p className="text-text-muted">No map image yet.</p>
      )}
      {canEdit && draft && (
        <form
          className="glass-panel p-4 space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onAddPin({
                title: title.trim(),
                nx: draft.nx,
                ny: draft.ny,
                x: x ? Number(x) : null,
                z: z ? Number(z) : null,
                postId: postId.trim() || null,
                wikiEntryId: wikiEntryId.trim() || null,
              });
              setDraft(null);
              setTitle("");
              setPostId("");
              setWikiEntryId("");
              setX("");
              setZ("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="text-sm text-text-muted">Click the map to drop a pin, then name it.</p>
          <input className="form-input" required placeholder="Pin title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input className="form-input" placeholder="Post id (optional)" value={postId} onChange={(e) => setPostId(e.target.value)} />
          <input className="form-input" placeholder="Wiki entry id (optional)" value={wikiEntryId} onChange={(e) => setWikiEntryId(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className="form-input" placeholder="Minecraft X" value={x} onChange={(e) => setX(e.target.value)} />
            <input className="form-input" placeholder="Minecraft Z" value={z} onChange={(e) => setZ(e.target.value)} />
          </div>
          <SubmitButton busy={busy} busyLabel="Saving…" className="btn text-sm px-4 py-2">Save pin</SubmitButton>
        </form>
      )}
      <ul className="space-y-2">
        {pins.map((pin) => (
          <li key={pin.id} className="flex justify-between gap-3 text-sm border-b border-primary-brown/40 py-2">
            <span>
              <span className="text-accent-gold font-bold">{pin.title}</span>
              {pin.x != null && pin.z != null ? <span className="text-text-muted"> · {pin.x}, {pin.z}</span> : null}
              {pin.postId ? <Link className="ml-2 text-accent-gold" href={`/posts/${pin.postId}`}>Post</Link> : null}
            </span>
            {canEdit && (
              <button type="button" className="text-danger" onClick={() => onDeletePin(pin.id)}>Remove</button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
