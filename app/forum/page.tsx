"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listThreads, type ForumThread } from "@/lib/firestore/forum";
import { getAllFactions } from "@/lib/firestore/factions";
import { listActiveTreaties } from "@/lib/firestore/treaties";
import { actionError } from "@/lib/async";
import { LoadNotice } from "@/components/ui/LoadNotice";
import type { Faction } from "@/lib/types";

export default function ForumPage() {
  const [threads, setThreads] = useState<ForumThread[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [treatyNames, setTreatyNames] = useState<Record<string, string>>({});
  const [cityFilter, setCityFilter] = useState("");
  const [treatyFilter, setTreatyFilter] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError("");
    Promise.all([listThreads(), getAllFactions(), listActiveTreaties()])
      .then(([items, factions, treaties]) => {
        if (cancelled) return;
        setThreads(items);
        setCities(factions);
        setTreatyNames(Object.fromEntries(treaties.map((treaty) => [treaty.id, treaty.name])));
      })
      .catch((err) => {
        if (!cancelled) setError(actionError(err, "Could not load the forum."));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const visible = threads.filter((thread) => {
    if (cityFilter && thread.cityId !== cityFilter) return false;
    if (treatyFilter && thread.treatyId !== treatyFilter) return false;
    return true;
  });

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex flex-wrap justify-between items-end gap-3">
          <div>
            <h1 className="text-3xl font-bold text-accent-gold">Forum</h1>
            <p className="text-text-muted">Open threads, newest activity first.</p>
          </div>
          <Link href="/forum/new" className="btn text-sm px-4 py-2 min-h-11">New thread</Link>
        </div>
        <div className="flex flex-wrap gap-3">
          <select className="form-input max-w-xs" value={cityFilter} onChange={(event) => setCityFilter(event.target.value)}>
            <option value="">Any city</option>
            {cities.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
          <select className="form-input max-w-xs" value={treatyFilter} onChange={(event) => setTreatyFilter(event.target.value)}>
            <option value="">Any treaty</option>
            {Object.entries(treatyNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>
        <LoadNotice message={error} onRetry={() => setAttempt((value) => value + 1)} />
        {!error && visible.length === 0 ? <p className="text-text-muted">No threads yet.</p> : null}
        {!error && visible.map((thread) => (
          <article key={thread.id} className="glass-panel p-5">
            <Link href={`/forum/${thread.id}`} className="text-xl font-bold text-accent-gold">{thread.title}</Link>
            <p className="text-sm text-text-muted mt-1">
              {thread.authorName} · {thread.replyCount} {thread.replyCount === 1 ? "reply" : "replies"}
              {thread.cityId ? ` · ${cities.find((city) => city.id === thread.cityId)?.name || "City"}` : ""}
              {thread.treatyId ? ` · ${treatyNames[thread.treatyId] || "Treaty"}` : ""}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
