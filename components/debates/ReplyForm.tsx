"use client";

import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { getClientDb } from "@/lib/firebase";
import { useAuth } from "@/components/auth/AuthProvider";
import { createReply } from "@/lib/firestore/replies";
import { STANCE_OPTIONS } from "@/components/debates/StanceTag";
import type { Stance } from "@/lib/types";

interface FactionOption {
  id: string;
  name: string;
}

interface CharacterOption {
  id: string;
  name: string;
  factionId: string;
}

interface ReplyFormProps {
  postId: string;
  postFactionId: string;
  showStance?: boolean;
}

export function ReplyForm({ postId, postFactionId, showStance = true }: ReplyFormProps) {
  const { user, profile } = useAuth();
  const [body, setBody] = useState("");
  const [stance, setStance] = useState<Stance>("neutral");
  const [inCharacter, setInCharacter] = useState(true);
  const [factionId, setFactionId] = useState(postFactionId);
  const [characterId, setCharacterId] = useState("");
  const [factions, setFactions] = useState<FactionOption[]>([]);
  const [characters, setCharacters] = useState<CharacterOption[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!user) return;

    async function loadMemberships() {
      const db = getClientDb();
      const membersSnap = await getDocs(
        query(collection(db, "faction_members"), where("uid", "==", user!.uid))
      );

      const factionIds = membersSnap.docs.map((d) => d.data().factionId as string);
      if (factionIds.length === 0) return;

      const factionResults: FactionOption[] = [];
      for (const fid of factionIds) {
        const factionDoc = await getDoc(doc(db, "factions", fid));
        if (factionDoc.exists()) {
          factionResults.push({
            id: factionDoc.id,
            name: (factionDoc.data().name as string) || factionDoc.id,
          });
        }
      }
      setFactions(factionResults);

      if (factionResults.some((f) => f.id === postFactionId)) {
        setFactionId(postFactionId);
      } else if (factionResults.length > 0) {
        setFactionId(factionResults[0].id);
      }
    }

    loadMemberships().catch(() => setError("Could not load your factions."));
  }, [user, postFactionId]);

  useEffect(() => {
    if (!factionId) {
      setCharacters([]);
      setCharacterId("");
      return;
    }

    async function loadCharacters() {
      const db = getClientDb();
      const charSnap = await getDocs(
        query(collection(db, "characters"), where("factionId", "==", factionId))
      );
      const chars = charSnap.docs
        .filter((d) => d.data().isActive !== false)
        .map((d) => ({
          id: d.id,
          name: (d.data().name as string) || d.id,
          factionId: d.data().factionId as string,
        }));
      setCharacters(chars);
      if (chars.length > 0) setCharacterId(chars[0].id);
    }

    loadCharacters().catch(() => setCharacters([]));
  }, [factionId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !body.trim() || !factionId) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      await createReply({
        postId,
        factionId,
        characterId: inCharacter ? characterId : "",
        body: body.trim(),
        stance,
        authorUid: user.uid,
        authorName: inCharacter ? undefined : profile?.displayName || user.email || "Member",
        inCharacter,
      });
      setBody("");
      setStance("neutral");
      setSuccess(true);
    } catch {
      setError("Could not post reply. Check that you are a member of this faction.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!user) {
    return (
      <p className="text-text-muted text-sm mt-6">
        Sign in to join the debate.
      </p>
    );
  }

  if (factions.length === 0) {
    return (
      <p className="text-text-muted text-sm mt-6">
        You need a city membership to reply. Found or join a city first.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4 border-t border-accent-gold/30 pt-6">
      <h3 className="text-accent-gold font-bold">Add Your Reply</h3>

      {factions.length > 1 && (
        <div>
          <label className="form-label" htmlFor="reply-faction">
            Comment as city
          </label>
          <select
            id="reply-faction"
            className="form-input"
            value={factionId}
            onChange={(e) => setFactionId(e.target.value)}
          >
            {factions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {characters.length > 0 && (
        <div>
          <label className="form-label" htmlFor="reply-character">
            Character
          </label>
          <select
            id="reply-character"
            className="form-input"
            value={characterId}
            onChange={(e) => setCharacterId(e.target.value)}
          >
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={inCharacter} onChange={(e) => setInCharacter(e.target.checked)} />
        In character, as this city
      </label>

      {showStance && <div>
        <label className="form-label">Stance</label>
        <div className="flex gap-2 flex-wrap">
          {STANCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStance(opt.value)}
              className={`px-4 py-2 rounded border-2 text-sm font-bold transition-colors ${
                stance === opt.value
                  ? "border-accent-gold bg-accent-gold/20 text-accent-gold"
                  : "border-primary-brown text-text-muted hover:border-accent-gold/50"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>}

      <div>
        <label className="form-label" htmlFor="reply-body">
          Your argument
        </label>
        <textarea
          id="reply-body"
          className="form-input min-h-[100px] resize-y"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="State your case…"
          required
          maxLength={5000}
        />
      </div>

      {error && <p className="text-danger text-sm">{error}</p>}
      {success && <p className="text-green-400 text-sm">Reply posted.</p>}

      <button
        type="submit"
        disabled={submitting || (inCharacter && characters.length > 0 && !characterId)}
        className="btn text-sm px-5 py-2"
      >
        {submitting ? "Posting…" : "Post Reply"}
      </button>
    </form>
  );
}
