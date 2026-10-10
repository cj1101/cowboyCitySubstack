"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/components/auth/AuthProvider";
import { getAllUsers, type AdminUser } from "@/lib/firestore/admin";
import {
  markConversationRead,
  sendDirectMessage,
  subscribeConversations,
  subscribeMessages,
} from "@/lib/firestore/messages";
import { getClientDb } from "@/lib/firebase";
import { ScreenStatus } from "@/components/layout/ScreenStatus";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { actionError, withTimeout } from "@/lib/async";
import { isBlockedStatus } from "@/lib/membership";
import type { Conversation, DirectMessage } from "@/lib/types";

export default function MessagesPage() {
  const { user } = useAuth();
  const [people, setPeople] = useState<AdminUser[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [reads, setReads] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  useEffect(() => {
    const existing = new URLSearchParams(window.location.search).get("c");
    if (existing) setActiveId(existing);
  }, []);

  useEffect(() => {
    if (!user) return;
    getAllUsers().then((users) => setPeople(users.filter((person) => !isBlockedStatus(person.status) && person.uid !== user.uid))).catch(() => setPeople([]));
    const unsub = subscribeConversations(user.uid, setConversations);
    const readsUnsub = onSnapshot(collection(getClientDb(), "users", user.uid, "reads"), (snap) => {
      const next: Record<string, number> = {};
      snap.docs.forEach((d) => {
        const at = d.data().lastReadAt?.toMillis?.() ?? 0;
        next[d.id] = at;
      });
      setReads(next);
    });
    return () => {
      unsub();
      readsUnsub();
    };
  }, [user]);

  useEffect(() => {
    if (!activeId) return;
    const unsub = subscribeMessages(activeId, setMessages);
    if (user) markConversationRead(user.uid, activeId).catch(() => undefined);
    return unsub;
  }, [activeId, user]);

  const names = useMemo(() => {
    const map = new Map(people.map((person) => [person.uid, person.displayName || person.email]));
    if (user) map.set(user.uid, "You");
    return map;
  }, [people, user]);

  if (!user) return <ScreenStatus>Sign in to read messages.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4">
      <div className="max-w-5xl mx-auto grid md:grid-cols-[280px_1fr] gap-4">
        <aside className="glass-panel p-4 space-y-3">
          <h1 className="text-xl font-bold text-accent-gold">Messages</h1>
          <div className="max-h-40 overflow-auto space-y-1">
            {people.map((person) => (
              <label key={person.uid} className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(person.uid)}
                  onChange={(e) => setSelected((current) => e.target.checked ? [...current, person.uid].slice(0, 7) : current.filter((id) => id !== person.uid))}
                />
                {person.displayName || person.email}
              </label>
            ))}
          </div>
          <form
            className="space-y-2"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!body.trim() || selected.length === 0 || sending) return;
              setSending(true);
              setSendError("");
              try {
                const id = await withTimeout(sendDirectMessage({
                  participantUids: [user.uid, ...selected],
                  senderUid: user.uid,
                  body,
                }));
                setBody("");
                setActiveId(id);
              } catch (error) {
                setSendError(actionError(error, "Could not send that message."));
              } finally {
                setSending(false);
              }
            }}
          >
            <textarea className="form-input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message the selected people" />
            {sendError && <p className="text-sm font-bold" role="alert">{sendError}</p>}
            <SubmitButton busy={sending} busyLabel="Sending…" className="btn text-sm px-4 py-2">Send</SubmitButton>
          </form>
          <ul className="space-y-2">
            {conversations.map((conversation) => {
              const unread = (conversation.lastMessageAt?.toMillis?.() ?? 0) > (reads[conversation.id] ?? 0) && conversation.lastSenderUid !== user.uid;
              return (
                <li key={conversation.id}>
                  <button type="button" className={`w-full text-left text-sm p-2 rounded ${activeId === conversation.id ? "bg-primary-brown" : ""}`} onClick={() => setActiveId(conversation.id)}>
                    <span className="font-bold">{conversation.participantUids.map((uid) => names.get(uid) || "Member").join(", ")}</span>
                    {unread && <span className="ml-2 text-accent-gold">•</span>}
                    <span className="block text-text-muted truncate">{conversation.lastMessagePreview}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <section className="glass-panel p-4 min-h-[50vh] flex flex-col">
          <div className="flex-1 space-y-3 overflow-auto">
            {messages.map((message) => (
              <p key={message.id} className={message.senderUid === user.uid ? "text-right" : ""}>
                <span className="inline-block glass-panel px-3 py-2 text-sm">{message.body}</span>
              </p>
            ))}
            {activeId && messages.length === 0 && <p className="text-text-muted">No messages yet.</p>}
          </div>
          {activeId && (
            <form
              className="mt-4 flex gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                const conversation = conversations.find((item) => item.id === activeId);
                if (!conversation || !body.trim() || sending) return;
                setSending(true);
                setSendError("");
                try {
                  await withTimeout(sendDirectMessage({
                    participantUids: conversation.participantUids,
                    senderUid: user.uid,
                    body,
                  }));
                  setBody("");
                } catch (error) {
                  setSendError(actionError(error, "Could not send that message."));
                } finally {
                  setSending(false);
                }
              }}
            >
              <input className="form-input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a message" />
              <SubmitButton busy={sending} busyLabel="Sending…" className="btn text-sm px-4 py-2">Send</SubmitButton>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
