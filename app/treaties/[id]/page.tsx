"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { PersonName } from "@/components/profile/PersonName";
import { ensureCityOwnerClaim, getAllFactions } from "@/lib/firestore/factions";
import {
  addTreatyComment,
  deleteTreatyWiki,
  getTreatyBundle,
  respondToTreaty,
  saveTreatyWiki,
  type TreatyComment,
  type TreatyWikiSection,
} from "@/lib/firestore/treaties";
import {
  canCityAct,
  currentRevision,
  ratifiedCityIds,
  responsesForRevision,
  TREATY_TYPE_LABELS,
  treatyStatus,
  type TreatyRecord,
} from "@/lib/treaties/machine";
import type { Faction } from "@/lib/types";
import type { StoredTreaty } from "@/lib/firestore/treaties";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

export default function TreatyPage() {
  const params = useParams<{ id: string }>();
  const { user, profile } = useAuth();
  const [treaty, setTreaty] = useState<StoredTreaty | null>(null);
  const [record, setRecord] = useState<TreatyRecord | null>(null);
  const [comments, setComments] = useState<TreatyComment[]>([]);
  const [wiki, setWiki] = useState<TreatyWikiSection[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [counterNote, setCounterNote] = useState("");
  const [counterTerms, setCounterTerms] = useState("");
  const [wikiTitle, setWikiTitle] = useState("");
  const [wikiBody, setWikiBody] = useState("");
  const [acting, setActing] = useState("");

  const load = () => {
    if (!params.id) return;
    getTreatyBundle(params.id)
      .then((bundle) => {
        if (!bundle) {
          setMissing(true);
          return;
        }
        setTreaty(bundle.treaty);
        setRecord(bundle.record);
        setComments(bundle.comments);
        setWiki(bundle.wiki);
        setCounterTerms(currentRevision(bundle.record).terms);
      })
      .catch(() => setMissing(true));
  };

  useEffect(() => {
    load();
    getAllFactions().then(setCities).catch(() => undefined);
  }, [params.id]);

  useEffect(() => {
    if (!user) return;
    const owned = cities.find((city) => city.ownerUids.includes(user.uid));
    if (owned) ensureCityOwnerClaim(user.uid, owned.id).catch(() => undefined);
  }, [user, cities]);

  if (missing) return <ScreenStatus>That treaty is not available.</ScreenStatus>;
  if (!treaty || !record) return <ScreenStatus>Loading…</ScreenStatus>;

  const revision = currentRevision(record);
  const status = treatyStatus(record);
  const parties = ratifiedCityIds(record);
  const owned = cities.filter((city) => user && city.ownerUids.includes(user.uid));
  const nameOf = (id: string) => cities.find((city) => city.id === id)?.name || "A city";
  const canWiki = Boolean(profile?.isAdmin) || owned.some((city) => parties.includes(city.id) || city.id === treaty.proposerCityId);

  const act = async (cityId: string, action: "accept" | "decline" | "withdraw" | "counter") => {
    if (!user) return;
    setActing(cityId + action);
    setError("");
    try {
      await respondToTreaty(
        treaty.id,
        cityId,
        user.uid,
        cities,
        action === "counter" ? { counter: { note: counterNote, terms: counterTerms } } : action
      );
      setCounterNote("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record that response.");
    } finally {
      setActing("");
    }
  };

  const sendComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !comment.trim() || commenting) return;
    setCommenting(true);
    setError("");
    try {
      await addTreatyComment(treaty.id, user.uid, profile?.displayName || "Member", comment.trim());
      setComment("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that comment.");
    } finally {
      setCommenting(false);
    }
  };

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href={status === "active" ? "/treaties" : "/treaties/negotiations"} className="text-accent-gold text-sm">← Back</Link>
        <header className="glass-panel p-6">
          <p className="text-xs uppercase tracking-wide text-accent-gold">{status} · {TREATY_TYPE_LABELS[revision.type]}{revision.open ? " · open" : ""}</p>
          <h1 className="text-3xl font-bold text-accent-gold">{revision.name}</h1>
          <p className="mt-2">{revision.purpose}</p>
        </header>
        <section className="glass-panel p-6 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Nature</h2>
          <p className="whitespace-pre-wrap">{revision.nature || "No general nature written yet."}</p>
          <h2 className="text-xl font-bold text-accent-gold">Terms</h2>
          <p className="whitespace-pre-wrap">{revision.terms || "No specific terms yet."}</p>
        </section>
        <section className="glass-panel p-6">
          <h2 className="text-xl font-bold text-accent-gold mb-3">Members</h2>
          <ul className="space-y-2">
            {parties.map((cityId) => {
              const city = cities.find((item) => item.id === cityId);
              return (
                <li key={cityId}>
                  {city ? <Link className="text-accent-gold font-bold" href={`/cities/${city.slug}`}>{city.name}</Link> : nameOf(cityId)}
                  {cityId === revision.authorCityId ? <span className="text-text-muted text-sm"> · ratified this revision</span> : null}
                </li>
              );
            })}
          </ul>
          <p className="text-sm text-text-muted mt-3">
            Invited: {revision.inviteeCityIds.length === 0 ? "none" : revision.inviteeCityIds.map(nameOf).join(", ")}
          </p>
        </section>

        {user && owned.length > 0 && (
          <section className="glass-panel p-6 space-y-3">
            <h2 className="text-xl font-bold text-accent-gold">Your city&apos;s response</h2>
            {owned.map((city) => {
              const response = responsesForRevision(record, revision.number).find((item) => item.cityId === city.id);
              const allowed = canCityAct(record, city.id);
              return (
                <div key={city.id} className="border border-primary-brown rounded p-3 space-y-2">
                  <p className="font-bold">{city.name}</p>
                  <p className="text-sm text-text-muted">{response ? `Current revision: ${response.decision}` : "No response on this revision."}</p>
                  {allowed && (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className="btn text-sm px-3 py-1.5" disabled={acting !== ""} onClick={() => act(city.id, "accept")}>Accept</button>
                      {city.id !== revision.authorCityId && (
                        <button type="button" className="btn btn-secondary text-sm px-3 py-1.5" disabled={acting !== ""} onClick={() => act(city.id, "decline")}>Decline</button>
                      )}
                      {parties.includes(city.id) && (
                        <button type="button" className="btn btn-secondary text-sm px-3 py-1.5" disabled={acting !== ""} onClick={() => act(city.id, "withdraw")}>Withdraw</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="space-y-2">
              <label className="form-label" htmlFor="counter-note">Counter-propose</label>
              <textarea id="counter-note" className="form-input" rows={3} placeholder="Requested changes" value={counterNote} onChange={(event) => setCounterNote(event.target.value)} />
              <textarea className="form-input" rows={4} value={counterTerms} onChange={(event) => setCounterTerms(event.target.value)} />
              <button
                type="button"
                className="btn btn-secondary text-sm px-3 py-1.5"
                disabled={acting !== "" || owned.length === 0}
                onClick={() => act(owned.find((city) => canCityAct(record, city.id))?.id || owned[0].id, "counter")}
              >
                Send revision
              </button>
            </div>
            {error && <p className="text-sm font-bold" role="alert">{error}</p>}
          </section>
        )}

        <section className="glass-panel p-6">
          <h2 className="text-xl font-bold text-accent-gold mb-3">Revision history</h2>
          <ol className="space-y-3">
            {[...record.revisions].reverse().map((item) => (
              <li key={item.number} className="border-b border-primary-brown pb-3">
                <p className="font-bold">Revision {item.number} · {nameOf(item.authorCityId)}</p>
                {item.note && <p className="text-sm">{item.note}</p>}
                <p className="text-sm text-text-muted whitespace-pre-wrap">{item.terms}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="glass-panel p-6 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Comments</h2>
          {comments.map((item) => (
            <article key={item.id} className="border-b border-primary-brown pb-2">
              <p className="text-sm font-bold"><PersonName uid={item.authorUid} name={item.authorName} /></p>
              <p className="whitespace-pre-wrap">{item.body}</p>
            </article>
          ))}
          {user && (
            <form onSubmit={sendComment} className="space-y-2">
              <textarea className="form-input" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Write a comment" />
              <button className="btn text-sm px-3 py-1.5" type="submit" disabled={commenting}>{commenting ? "Posting…" : "Post comment"}</button>
            </form>
          )}
        </section>

        <section className="glass-panel p-6 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Wiki</h2>
          {wiki.length === 0 && <p className="text-text-muted">No wiki notes yet.</p>}
          {wiki.map((section) => (
            <article key={section.id}>
              <h3 className="font-bold">{section.title}</h3>
              <p className="whitespace-pre-wrap">{section.body}</p>
              {canWiki && (
                <button type="button" className="text-sm text-accent-gold" onClick={() => deleteTreatyWiki(treaty.id, section.id).then(load)}>Remove</button>
              )}
            </article>
          ))}
          {canWiki && (
            <form
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault();
                await saveTreatyWiki(treaty.id, { title: wikiTitle, body: wikiBody });
                setWikiTitle("");
                setWikiBody("");
                load();
              }}
            >
              <input className="form-input" placeholder="Section title" value={wikiTitle} onChange={(event) => setWikiTitle(event.target.value)} required />
              <textarea className="form-input" rows={4} placeholder="Section body" value={wikiBody} onChange={(event) => setWikiBody(event.target.value)} required />
              <button className="btn text-sm px-3 py-1.5" type="submit">Add wiki section</button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
