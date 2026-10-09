"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { markAllNotificationsRead, markNotificationRead, notificationsQuery, toNotification } from "@/lib/firestore/notifications";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import type { AppNotification } from "@/lib/types";

export default function NotificationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(notificationsQuery(user.uid), (snap) => {
      setItems(snap.docs.map((d) => toNotification(d.id, d.data())));
    });
  }, [user]);

  if (!user) return <ScreenStatus>Sign in to read notices.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex justify-between items-center">
          <h1 className="text-3xl font-bold text-accent-gold">Notices</h1>
          <button type="button" className="btn btn-secondary text-sm px-3 py-1" onClick={() => markAllNotificationsRead(user.uid)}>Mark all read</button>
        </div>
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={`block glass-panel p-4 ${item.read ? "opacity-70" : ""}`}
            onClick={() => { if (!item.read) markNotificationRead(item.id).catch(() => undefined); }}
          >
            <p className="text-xs uppercase text-accent-gold">{item.type}</p>
            <p>{item.summary}</p>
          </Link>
        ))}
        {items.length === 0 && <p className="text-text-muted">No notices yet.</p>}
      </div>
    </div>
  );
}
