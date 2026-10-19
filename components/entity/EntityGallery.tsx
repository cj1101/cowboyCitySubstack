"use client";

/**
 * Screenshots gallery (spec §6.4; brief §8.2.3 + §8.4).
 *
 * Member content, never team-sourced (CJ): the empty state is a
 * prompt, not a placeholder. Images carry uploader, date, caption,
 * and kind — plans are labeled as plans and never framed as
 * screenshots, maps as maps. Uploads from members who don't manage
 * this entity land **pending** (sovereign canon — your city, your
 * pages) and are visible only to their uploader and to members who
 * can accept them, until a manager accepts. The showcase image is set
 * explicitly by a manager; the newest upload is never auto-promoted.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { StoredImage } from "@/components/media/StoredImage";
import type { Faction } from "@/lib/types";
import {
  listEntityGallery,
  removeGalleryItem,
  setGalleryAcceptance,
  setGalleryShowcase,
  uploadEntityImage,
  visibleGallery,
} from "@/lib/entity/gallery";
import { canManageEntity } from "@/lib/entity/resolve";
import type { EntityPageData, GalleryImageKind, GalleryItem } from "@/lib/entity/types";
import { EntitySection, HonestEmpty } from "./EntitySections";

const KIND_LABELS: Record<GalleryImageKind, string> = {
  screenshot: "Screenshot",
  plan: "Plan",
  map: "Map",
};

function formatDate(millis: number | null): string | null {
  if (millis === null) return null;
  return new Date(millis).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function EntityGallery({
  faction,
  data,
  viewerUid,
  viewerDisplay,
}: {
  faction: Faction;
  data: EntityPageData;
  viewerUid: string | null;
  viewerDisplay: string | null;
}) {
  const entityKey = data.structure?.id ?? data.corporation?.id ?? data.presentation?.key ?? null;
  const canManage = canManageEntity(viewerUid, faction, data);
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [imageKind, setImageKind] = useState<GalleryImageKind>("screenshot");
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!entityKey) {
      setItems([]);
      return;
    }
    setItems(await listEntityGallery(faction.id, data.kind, entityKey));
  }, [entityKey, faction.id, data.kind]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = items === null ? null : visibleGallery(items, viewerUid, canManage);
  const showcase = visible?.find((item) => item.showcase && item.acceptance === "accepted");
  const rest = visible?.filter((item) => item !== showcase) ?? [];

  async function onUpload(file: File) {
    if (!entityKey || !viewerUid) return;
    setBusy(true);
    setError(null);
    try {
      const item = await uploadEntityImage({
        factionId: faction.id,
        kind: data.kind,
        entityKey,
        file,
        uploaderUid: viewerUid,
        uploaderDisplay: viewerDisplay,
        caption: caption.trim() ? caption.trim() : null,
        imageKind,
        asAccepted: canManage,
      });
      setItems((prev) => [...(prev ?? []), item]);
      setCaption("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setError(e instanceof Error ? e.message : "That upload didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  async function onAccept(item: GalleryItem) {
    setError(null);
    try {
      await setGalleryAcceptance(faction.id, item.id, "accepted");
      setItems((prev) =>
        (prev ?? []).map((i) => (i.id === item.id ? { ...i, acceptance: "accepted" } : i))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change didn't save.");
    }
  }

  async function onShowcase(item: GalleryItem) {
    if (!items) return;
    setError(null);
    try {
      await setGalleryShowcase(faction.id, items, item.id);
      setItems((prev) =>
        (prev ?? []).map((i) => ({ ...i, showcase: i.id === item.id }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change didn't save.");
    }
  }

  async function onRemove(item: GalleryItem) {
    setError(null);
    try {
      await removeGalleryItem(faction.id, item.id);
      setItems((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "That removal didn't save.");
    }
  }

  return (
    <EntitySection title="Gallery">
      {visible === null ? (
        <HonestEmpty>Loading the gallery…</HonestEmpty>
      ) : visible.length === 0 ? (
        <HonestEmpty>
          No images yet — and none will appear until a member uploads one. The team never sources
          screenshots: what belongs here is the group&apos;s own captures, renders, and plans of
          this place.
        </HonestEmpty>
      ) : (
        <div className="space-y-3">
          {showcase ? (
            <GalleryCard
              item={showcase}
              featured
              canManage={canManage}
              viewerUid={viewerUid}
              onAccept={onAccept}
              onShowcase={onShowcase}
              onRemove={onRemove}
            />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            {rest.map((item) => (
              <GalleryCard
                key={item.id}
                item={item}
                canManage={canManage}
                viewerUid={viewerUid}
                onAccept={onAccept}
                onShowcase={onShowcase}
                onRemove={onRemove}
              />
            ))}
          </div>
        </div>
      )}

      {error ? (
        <p className="text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      {viewerUid ? (
        <div className="border-t border-white/10 pt-3 space-y-2">
          <p className="text-sm font-bold text-text-light">Add an image</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              disabled={busy || !entityKey}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onUpload(file);
              }}
              className="text-sm text-text-light"
            />
            <select
              value={imageKind}
              onChange={(e) => setImageKind(e.target.value as GalleryImageKind)}
              className="text-sm bg-primary-brown/40 text-text-light rounded px-2 py-1"
              aria-label="Image kind"
            >
              <option value="screenshot">Screenshot</option>
              <option value="plan">Plan</option>
              <option value="map">Map</option>
            </select>
            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Caption (optional)"
              className="text-sm bg-primary-brown/40 text-text-light rounded px-2 py-1 flex-1 min-w-40"
            />
          </div>
          <p className="text-sm text-text-muted">
            {canManage
              ? "Your uploads appear immediately. Images are resized before upload."
              : "Your upload lands as a proposal: it appears here once this place's owner or the host city's owner accepts it — their page, their call."}
          </p>
        </div>
      ) : (
        <HonestEmpty>Sign in as a member to add an image of this place.</HonestEmpty>
      )}
    </EntitySection>
  );
}

function GalleryCard({
  item,
  featured = false,
  canManage,
  viewerUid,
  onAccept,
  onShowcase,
  onRemove,
}: {
  item: GalleryItem;
  featured?: boolean;
  canManage: boolean;
  viewerUid: string | null;
  onAccept: (item: GalleryItem) => Promise<void>;
  onShowcase: (item: GalleryItem) => Promise<void>;
  onRemove: (item: GalleryItem) => Promise<void>;
}) {
  const date = formatDate(item.createdAtMillis);
  const ownUpload = viewerUid !== null && item.uploaderUid === viewerUid;
  return (
    <figure className="space-y-1">
      <StoredImage
        src={item.url}
        alt={item.caption ?? `${KIND_LABELS[item.kind]} of this place`}
        className={featured ? "w-full rounded" : "w-full rounded aspect-video object-cover"}
      />
      <figcaption className="text-sm space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-text-light px-2 py-0.5 rounded">
            {item.kind === "plan" ? "Plan — not a screenshot" : KIND_LABELS[item.kind]}
          </span>
          {item.showcase && item.acceptance === "accepted" ? (
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-accent-gold px-2 py-0.5 rounded">
              Showcase
            </span>
          ) : null}
          {item.acceptance === "pending" ? (
            <span className="text-xs font-bold uppercase tracking-wide bg-primary-brown/40 text-amber-200 px-2 py-0.5 rounded">
              Proposed — awaiting the owner
            </span>
          ) : null}
        </div>
        {item.caption ? <p className="text-text-light">{item.caption}</p> : null}
        <p className="text-text-muted">
          {item.uploaderDisplay ?? "A member"}
          {date ? ` · ${date}` : ""}
        </p>
        {canManage || ownUpload ? (
          <div className="flex flex-wrap gap-2">
            {canManage && item.acceptance === "pending" ? (
              <button
                type="button"
                onClick={() => void onAccept(item)}
                className="text-accent-gold hover:underline"
              >
                Accept
              </button>
            ) : null}
            {canManage && item.acceptance === "accepted" && !item.showcase ? (
              <button
                type="button"
                onClick={() => void onShowcase(item)}
                className="text-accent-gold hover:underline"
              >
                Set as showcase
              </button>
            ) : null}
            {canManage || ownUpload ? (
              <button
                type="button"
                onClick={() => void onRemove(item)}
                className="text-accent-gold hover:underline"
              >
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
      </figcaption>
    </figure>
  );
}
