"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/components/auth/AuthProvider";
import { ensureCityOwnerClaim, getAllFactions } from "@/lib/firestore/factions";
import {
  addTreatyComment,
  breakStoredTreaty,
  deleteTreatyWiki,
  getTreatyBundle,
  renewStoredTreaty,
  respondToTreaty,
  saveTreatyWiki,
  treatyTimeline,
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
import { TreatyBadge } from "@/components/treaties/TreatyBadge";
import { actionError } from "@/lib/async";

const ACTION_LABELS = {
  accept: ["Accept", "Accepting…"],
  decline: ["Decline", "Declining…"],
  withdraw: ["Withdraw", "Withdrawing…"],
  counter: ["Send revision", "Sending…"],
} as const;

export default function TreatyPage() {
  const params = useParams<{ id: string }>();
  const { user, profile } = useAuth();
  const [treaty, setTreaty] = useState<StoredTreaty | null>(null);
  const [record, setRecord] = useState<TreatyRecord | null>(null);
  const [comments, setComments] = useState<TreatyComment[]>([]);
  const [wiki, setWiki] = useState<TreatyWikiSection[]>([]);
  const [cities, setCities] = useState<Faction[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [counterNote, setCounterNote] = useState("");
  const [counterTerms, setCounterTerms] = useState("");
  const [wikiTitle, setWikiTitle] = useState("");
  const [wikiBody, setWikiBody] = useState("");
  const [wikiSaving, setWikiSaving] = useState(false);
  const [removingWiki, setRemovingWiki] = useState("");
  const [acting, setActing] = useState("");
  const [renewNote, setRenewNote] = useState("");
  const [renewExpiry, setRenewExpiry] = useState("");
  const [renewOn, setRenewOn] = useState("");
  const [breakNote, setBreakNote] = useState("");
  const [links, setLinks] = useState<{ postId: string; threadId: string } | null>(null);

  const load = useCallback(() => {
    if (!params.id) return;
    setLoading(true);
    setLoadError("");
    getTreatyBundle(params.id)
      .then((bundle) => {
        if (!bundle) {
          setMissing(true);
          return;
        }
        setMissing(false);
        setTreaty(bundle.treaty);
        setRecord(bundle.record);
        setComments(bundle.comments);
        setWiki(bundle.wiki);
        const revision = currentRevision(bundle.record);
        setCounterTerms(revision.terms);
        setRenewExpiry(revision.expiresOn || "");
        setRenewOn(revision.renewOn || "");
      })
      .catch((err) => setLoadError(actionError(err, "Could not load that treaty.")))
      .finally(() => setLoading(false));
  }, [params.id]);

  useEffect(() => {
    load();
    getAllFactions().then(setCities).catch((err) => setLoadError(actionError(err, "Could not load cities.")));
  }, [load]);

  useEffect(() => {
    if (!user) return;
    const owned = cities.find((city) => city.ownerUids.includes(user.uid));
    if (owned) ensureCityOwnerClaim(user.uid, owned.id).catch(() => undefined);
  }, [user, cities]);

  if (loading && !treaty) return <ScreenStatus>Loading…</ScreenStatus>;
  if (missing) return <ScreenStatus>That treaty is not available.</ScreenStatus>;
  if (loadError && !treaty) {
    return (
      <div className="wood-texture min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center gap-3 p-6">
        <p className="text-text-muted text-center" role="alert">{loadError}</p>
        <button type="button" className="btn min-h-11" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!treaty || !record) return <ScreenStatus>Loading…</ScreenStatus>;

  const revision = currentRevision(record);
  const status = treatyStatus(record);
  const parties = ratifiedCityIds(record);
  const owned = cities.filter((city) => user && city.ownerUids.includes(user.uid));
  const memberCities = owned.filter((city) => parties.includes(city.id));
  const nameOf = (id: string) => cities.find((city) => city.id === id)?.name || "A city";
  const canWiki = Boolean(profile?.isAdmin) || owned.some((city) => parties.includes(city.id) || city.id === treaty.proposerCityId);
  const timeline = treatyTimeline(record, nameOf);

  const act = async (cityId: string, action: "accept" | "decline" | "withdraw" | "counter") => {
    if (!user || acting) return;
    setActing(`${cityId}:${action}`);
    setError("");
    setMessage("");
    try {
      await respondToTreaty(
        treaty.id,
        cityId,
        user.uid,
        cities,
        action === "counter" ? { counter: { note: counterNote, terms: counterTerms } } : action
      );
      if (action === "counter") setCounterNote("");
      const done: Record<typeof action, string> = {
        accept: `${nameOf(cityId)} ratified this revision.`,
        decline: `${nameOf(cityId)} declined this revision.`,
        withdraw: `${nameOf(cityId)} withdrew from this revision.`,
        counter: "Revision sent. The other cities need to ratify it.",
      };
      setMessage(done[action]);
      load();
    } catch (err) {
      setError(actionError(err, "Could not record that response."));
    } finally {
      setActing("");
    }
  };

  const renew = async (cityId: string) => {
    if (!user || acting) return;
    setActing("renew");
    setError("");
    setMessage("");
    try {
      await renewStoredTreaty(treaty.id, cityId, user.uid, cities, {
        expiresOn: renewExpiry,
        renewOn,
        note: renewNote,
      });
      setRenewNote("");
      setMessage("Renewal sent. The other cities have to ratify it again before the treaty is active.");
      load();
    } catch (err) {
      setError(actionError(err, "Could not propose that renewal."));
    } finally {
      setActing("");
    }
  };

  const breakAgreement = async (cityId: string) => {
    if (!user || acting) return;
    setActing("break");
    setError("");
    setMessage("");
    setLinks(null);
    try {
      const created = await breakStoredTreaty(
        treaty.id,
        cityId,
        user.uid,
        cities,
        breakNote,
        profile?.displayName || nameOf(cityId)
      );
      setBreakNote("");
      setLinks(created);
      setMessage("Treaty broken. A public announcement is on the feed and in the forum, and the map no longer draws the old membership.");
      load();
    } catch (err) {
      setError(actionError(err, "Could not break that treaty."));
    } finally {
      setActing("");
    }
  };

  const sendComment = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !comment.trim() || commenting) return;
    setCommenting(true);
    setError("");
    setMessage("");
    try {
      await addTreatyComment(treaty.id, user.uid, profile?.displayName || "Member", comment.trim());
      setComment("");
      setMessage("Comment posted.");
      load();
    } catch (err) {
      setError(actionError(err, "Could not post that comment."));
    } finally {
      setCommenting(false);
    }
  };

  const saveWiki = async (event: FormEvent) => {
    event.preventDefault();
    if (wikiSaving) return;
    setWikiSaving(true);
    setError("");
    setMessage("");
    try {
      await saveTreatyWiki(treaty.id, { title: wikiTitle, body: wikiBody });
      setWikiTitle("");
      setWikiBody("");
      setMessage("Wiki section saved.");
      load();
    } catch (err) {
      setError(actionError(err, "Could not save that wiki section."));
    } finally {
      setWikiSaving(false);
    }
  };

  const removeWiki = async (sectionId: string) => {
    setRemovingWiki(sectionId);
    setError("");
    setMessage("");
    try {
      await deleteTreatyWiki(treaty.id, sectionId);
      setMessage("Wiki section removed.");
      load();
    } catch (err) {
      setError(actionError(err, "Could not remove that wiki section."));
    } finally {
      setRemovingWiki("");
    }
  };

  const buttonLabel = (cityId: string, action: keyof typeof ACTION_LABELS, secondary = false) => {
    const [idle, busy] = ACTION_LABELS[action];
    const pending = acting === `${cityId}:${action}`;
    return (
      <button
        type="button"
        className={`text-sm px-3 py-1.5 min-h-11 ${secondary ? "btn btn-secondary" : "btn"}`}
        disabled={acting !== ""}
        aria-busy={pending}
        onClick={() => act(cityId, action)}
      >
        {pending ? busy : idle}
      </button>
    );
  };

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-4 sm:p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link href={status === "active" ? "/treaties" : "/treaties/negotiations"} className="text-accent-gold text-sm">← Back</Link>
        <header className="glass-panel p-6">
          <p className="text-xs uppercase tracking-wide text-accent-gold">
            {status} · {TREATY_TYPE_LABELS[revision.type]}{revision.open ? " · open" : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <h1 className="text-3xl font-bold text-accent-gold">{revision.name}</h1>
            <TreatyBadge status={status} expiresOn={revision.expiresOn} />
          </div>
          <p className="mt-2">{revision.purpose}</p>
          {(revision.expiresOn || revision.renewOn) && (
            <p className="text-sm text-text-muted mt-2">
              {revision.expiresOn ? `Expires ${revision.expiresOn}` : "No expiry date"}
              {revision.renewOn ? ` · Renewal ${revision.renewOn}` : ""}
            </p>
          )}
          {status === "broken" && treaty.breakNote && (
            <p className="mt-3 text-sm">Broken by {nameOf(treaty.brokenByCityId)}: {treaty.breakNote}</p>
          )}
        </header>
        {message && <p className="text-sm font-bold text-accent-gold" role="status">{message}</p>}
        {links && (
          <p className="text-sm">
            <Link className="text-accent-gold font-bold" href={`/posts/${links.postId}`}>Feed announcement</Link>
            {" · "}
            <Link className="text-accent-gold font-bold" href={`/forum/${links.threadId}`}>Forum thread</Link>
          </p>
        )}
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
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
            {parties.length === 0 && <li className="text-text-muted">No city has ratified this revision.</li>}
          </ul>
          <p className="text-sm text-text-muted mt-3">
            Invited: {revision.inviteeCityIds.length === 0 ? "none" : revision.inviteeCityIds.map(nameOf).join(", ")}
          </p>
        </section>

        {user && owned.length > 0 && status !== "broken" && (
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
                      {buttonLabel(city.id, "accept")}
                      {city.id !== revision.authorCityId && buttonLabel(city.id, "decline", true)}
                      {parties.includes(city.id) && buttonLabel(city.id, "withdraw", true)}
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
                className="btn btn-secondary text-sm px-3 py-1.5 min-h-11"
                disabled={acting !== "" || owned.length === 0}
                aria-busy={acting.endsWith(":counter")}
                onClick={() => act(owned.find((city) => canCityAct(record, city.id))?.id || owned[0].id, "counter")}
              >
                {acting.endsWith(":counter") ? "Sending…" : "Send revision"}
              </button>
            </div>
          </section>
        )}

        {user && memberCities.length > 0 && status === "active" && (
          <section className="glass-panel p-6 space-y-3">
            <h2 className="text-xl font-bold text-accent-gold">Renew</h2>
            <p className="text-sm text-text-muted">A renewal opens a new revision. The treaty leaves the map until the other members ratify it again.</p>
            <label className="form-label" htmlFor="renew-expiry">New expiry date</label>
            <input id="renew-expiry" className="form-input min-h-11" type="date" value={renewExpiry} onChange={(event) => setRenewExpiry(event.target.value)} />
            <label className="form-label" htmlFor="renew-on">Renewal date</label>
            <input id="renew-on" className="form-input min-h-11" type="date" value={renewOn} onChange={(event) => setRenewOn(event.target.value)} />
            <label className="form-label" htmlFor="renew-note">Note for the other cities</label>
            <textarea id="renew-note" className="form-input" rows={3} value={renewNote} onChange={(event) => setRenewNote(event.target.value)} />
            <button type="button" className="btn text-sm px-3 py-1.5 min-h-11" disabled={acting !== ""} aria-busy={acting === "renew"} onClick={() => renew(memberCities[0].id)}>
              {acting === "renew" ? "Sending renewal…" : `Propose renewal as ${memberCities[0].name}`}
            </button>
          </section>
        )}

        {user && memberCities.length > 0 && status === "active" && (
          <section className="glass-panel p-6 space-y-3">
            <h2 className="text-xl font-bold text-accent-gold">Break treaty</h2>
            <p className="text-sm text-text-muted">Breaking is public. It is recorded here, announced on the feed and in the forum, and the map drops this city from the treaty.</p>
            <label className="form-label" htmlFor="break-note">Why is {memberCities[0].name} breaking it?</label>
            <textarea id="break-note" className="form-input" rows={3} value={breakNote} onChange={(event) => setBreakNote(event.target.value)} />
            <button type="button" className="btn btn-danger text-sm px-3 py-1.5 min-h-11" disabled={acting !== "" || !breakNote.trim()} aria-busy={acting === "break"} onClick={() => breakAgreement(memberCities[0].id)}>
              {acting === "break" ? "Breaking…" : `Break treaty as ${memberCities[0].name}`}
            </button>
          </section>
        )}

        <section className="glass-panel p-6">
          <h2 className="text-xl font-bold text-accent-gold mb-3">Ratification and votes</h2>
          {timeline.length === 0 ? (
            <p className="text-text-muted">No votes yet.</p>
          ) : (
            <ol className="space-y-3">
              {timeline.map((event) => (
                <li key={event.id} className="border-b border-primary-brown pb-3">
                  <p className="font-bold">{event.title}</p>
                  {event.detail && <p className="text-sm whitespace-pre-wrap">{event.detail}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="glass-panel p-6 space-y-3">
          <h2 className="text-xl font-bold text-accent-gold">Comments</h2>
          {comments.map((item) => (
            <article key={item.id} className="border-b border-primary-brown pb-2">
              <p className="text-sm font-bold">{item.authorName}</p>
              <p className="whitespace-pre-wrap">{item.body}</p>
            </article>
          ))}
          {user && (
            <form onSubmit={sendComment} className="space-y-2">
              <label className="sr-only" htmlFor="treaty-comment">Comment</label>
              <textarea id="treaty-comment" className="form-input" rows={3} value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Write a comment" />
              <button className="btn text-sm px-3 py-1.5 min-h-11" type="submit" disabled={commenting} aria-busy={commenting}>
                {commenting ? "Posting…" : "Post comment"}
              </button>
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
                <button type="button" className="text-sm text-accent-gold min-h-11" disabled={removingWiki === section.id} onClick={() => removeWiki(section.id)}>
                  {removingWiki === section.id ? "Removing…" : "Remove"}
                </button>
              )}
            </article>
          ))}
          {canWiki && (
            <form className="space-y-2" onSubmit={saveWiki}>
              <input className="form-input min-h-11" placeholder="Section title" value={wikiTitle} onChange={(event) => setWikiTitle(event.target.value)} required />
              <textarea className="form-input" rows={4} placeholder="Section body" value={wikiBody} onChange={(event) => setWikiBody(event.target.value)} required />
              <button className="btn text-sm px-3 py-1.5 min-h-11" type="submit" disabled={wikiSaving} aria-busy={wikiSaving}>
                {wikiSaving ? "Saving…" : "Add wiki section"}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
