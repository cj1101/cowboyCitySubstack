"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { actionError } from "@/lib/async";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationLabel,
} from "@/lib/firestore/notifications";
import type { AppNotification } from "@/lib/types";

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
      <path
        fill="#1c1917"
        d="M9 1h2v2h3v2h1v6h-2v2H5v-2H3V5h1V3h3V1h2zm0 14h2v2H7v-2h2z"
      />
    </svg>
  );
}

export function NotificationBell({
  uid,
  items,
  ready,
  loadError = "",
  placement,
  closeSignal = false,
  onNavigate,
}: {
  uid: string;
  items: AppNotification[];
  ready: boolean;
  loadError?: string;
  placement: "header" | "drawer";
  closeSignal?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const unread = items.filter((item) => !item.read).length;

  useEffect(() => {
    if (closeSignal) setOpen(false);
  }, [closeSignal]);

  useEffect(() => {
    if (!open || placement !== "header") return;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, placement]);

  const openItem = async (item: AppNotification) => {
    if (openingId) return;
    setError("");
    setStatus("");
    setOpeningId(item.id);
    try {
      if (!item.read) await markNotificationRead(item.id);
      setOpen(false);
      onNavigate?.();
      router.push(item.href || "/");
    } catch (err) {
      setError(actionError(err, "Could not mark that notice read."));
    } finally {
      setOpeningId(null);
    }
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    setError("");
    setStatus("");
    try {
      const count = await markAllNotificationsRead(uid);
      setStatus(count === 0 ? "All notices are already read." : "All notices marked read.");
    } catch (err) {
      setError(actionError(err, "Could not mark notices read."));
    } finally {
      setMarkingAll(false);
    }
  };

  const list = (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-ink">
          {ready ? `${unread} unread` : "Loading…"}
        </p>
        <button
          type="button"
          className="btn btn-secondary text-xs px-2 py-1 min-h-11"
          disabled={markingAll || !ready}
          aria-busy={markingAll}
          onClick={markAll}
        >
          {markingAll ? "Marking…" : "Mark all read"}
        </button>
      </div>
      {(loadError || error) && (
        <p className="text-sm font-bold" role="alert">
          {error || loadError}
        </p>
      )}
      {status && !error && !loadError && (
        <p className="text-sm text-accent-gold" role="status">
          {status}
        </p>
      )}
      <div className="space-y-1 max-h-80 overflow-y-auto">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`w-full text-left px-2 py-2 min-h-11 border-2 ${
              item.read ? "border-primary-brown opacity-70" : "border-ink bg-[#fff8d6]"
            }`}
            disabled={openingId !== null}
            aria-busy={openingId === item.id}
            onClick={() => openItem(item)}
          >
            <span className="block text-xs font-bold uppercase text-accent-gold">
              {openingId === item.id ? "Opening…" : notificationLabel(item)}
            </span>
            <span className="block text-sm break-words">{item.summary}</span>
          </button>
        ))}
        {ready && items.length === 0 && <p className="text-sm text-text-muted">No notices yet.</p>}
      </div>
      <Link href="/notifications" className="text-sm font-bold text-accent-gold inline-flex items-center min-h-11" onClick={() => { setOpen(false); onNavigate?.(); }}>
        See all notices
      </Link>
    </div>
  );

  if (placement === "drawer") {
    return (
      <div>
        <button
          type="button"
          className="mobile-nav-link w-full gap-2 text-left"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <BellIcon />
          <span>Notices{unread > 0 ? ` (${unread})` : ""}</span>
        </button>
        {open && (
          <div id={panelId} className="px-3 pb-3">
            {list}
          </div>
        )}
      </div>
    );
  }

  const badge = unread > 99 ? "99+" : String(unread);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="relative inline-flex items-center justify-center w-11 h-11 border-[3px] border-ink bg-white shadow-[3px_3px_0_#169c9c]"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread > 0 ? `Notices, ${unread} unread` : "Notices"}
        onClick={() => setOpen((value) => !value)}
      >
        <BellIcon />
        {unread > 0 && <span className="notice-count">{badge}</span>}
      </button>
      {open && (
        <div id={panelId} className="notice-panel glass-panel p-3">
          {list}
        </div>
      )}
    </div>
  );
}
