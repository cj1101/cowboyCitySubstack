"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { markAllNotificationsRead, markNotificationRead, notificationLabel, notificationsQuery, toNotification } from "@/lib/firestore/notifications";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { actionError } from "@/lib/async";
import type { AppNotification } from "@/lib/types";

export default function NotificationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);

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
        <div className="flex flex-wrap justify-between items-center gap-3">
          <h1 className="text-3xl font-bold text-accent-gold">Notices</h1>
          <SubmitButton
            type="button"
            busy={markingAll}
            busyLabel="Marking…"
            className="btn btn-secondary text-sm px-3 py-2"
            onClick={async () => {
              setMarkingAll(true);
              setError("");
              setStatus("");
              try {
                const count = await markAllNotificationsRead(user.uid);
                setStatus(count === 0 ? "All notices are already read." : "All notices marked read.");
              } catch (err) {
                setError(actionError(err, "Could not mark notices read."));
              } finally {
                setMarkingAll(false);
              }
            }}
          >
            Mark all read
          </SubmitButton>
        </div>
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        {status && !error && <p className="text-sm text-accent-gold" role="status">{status}</p>}
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className={`block glass-panel p-4 ${item.read ? "opacity-70" : ""}`}
            aria-busy={openingId === item.id}
            onClick={async (event) => {
              if (item.read) return;
              event.preventDefault();
              setOpeningId(item.id);
              setError("");
              try {
                await markNotificationRead(item.id);
                window.location.assign(item.href);
              } catch (err) {
                setError(actionError(err, "Could not mark that notice read."));
                setOpeningId(null);
              }
            }}
          >
            <p className="text-xs uppercase text-accent-gold">{openingId === item.id ? "Opening…" : notificationLabel(item)}</p>
            <p>{item.summary}</p>
          </Link>
        ))}
        {items.length === 0 && <p className="text-text-muted">No notices yet.</p>}
      </div>
    </div>
  );
}
