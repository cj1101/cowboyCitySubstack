"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { onSnapshot } from "firebase/firestore";
import { markNotificationRead, notificationsQuery, toNotification } from "@/lib/firestore/notifications";
import type { AppNotification, NotificationType } from "@/lib/types";

const LABELS: Record<NotificationType, string> = {
  treaty: "Treaty",
  reply: "Reply",
  dm: "Mail",
  mention: "Mention",
  reference: "Reference",
  approval: "Approval",
};

export function NotificationBell({ uid }: { uid: string }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return onSnapshot(
      notificationsQuery(uid),
      (snap) => {
        setError("");
        setItems(snap.docs.map((item) => toNotification(item.id, item.data())));
      },
      () => setError("Could not load notices.")
    );
  }, [uid]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = items.filter((item) => !item.read).length;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="menu-button relative"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={unread > 0 ? `Notices, ${unread} unread` : "Notices"}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden className="text-lg leading-none">🔔</span>
        {unread > 0 && <span className="tabbar-badge absolute -top-1 -right-1">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="note-menu" role="menu">
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-primary-brown">
            <p className="font-bold text-sm">Notices</p>
            <Link href="/notifications" className="text-sm text-accent-gold font-bold" onClick={() => setOpen(false)}>
              See all
            </Link>
          </div>
          {error && <p className="px-3 py-2 text-sm font-bold" role="alert">{error}</p>}
          {items.length === 0 && !error && <p className="px-3 py-3 text-sm text-text-muted">No treaty invites, replies, or mail yet.</p>}
          <ul className="max-h-80 overflow-y-auto">
            {items.slice(0, 8).map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href}
                  role="menuitem"
                  className={`block px-3 py-2 hover:bg-[#f7f6f3] ${item.read ? "opacity-70" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    if (!item.read) markNotificationRead(item.id).catch(() => setError("Could not mark that notice read."));
                  }}
                >
                  <p className="text-xs uppercase tracking-wide text-accent-gold">{LABELS[item.type] || item.type}</p>
                  <p className="text-sm">{item.summary}</p>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
