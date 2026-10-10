"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth/AuthProvider";
import { ensureCityOwnerClaim, getAllFactions } from "@/lib/firestore/factions";
import { createTreaty } from "@/lib/firestore/treaties";
import { TREATY_TYPES, TREATY_TYPE_LABELS, type TreatyType } from "@/lib/treaties/machine";
import type { Faction } from "@/lib/types";
import { ScreenStatus } from "@/components/layout/ScreenStatus";

export default function NewTreatyPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [cities, setCities] = useState<Faction[]>([]);
  const [proposerCityId, setProposerCityId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<TreatyType>("alliance");
  const [nature, setNature] = useState("");
  const [terms, setTerms] = useState("");
  const [purpose, setPurpose] = useState("");
  const [open, setOpen] = useState(false);
  const [invitees, setInvitees] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    getAllFactions().then((factions) => {
      setCities(factions);
      const owned = factions.filter((city) => city.ownerUids.includes(user.uid));
      if (owned[0]) {
        setProposerCityId(owned[0].id);
        ensureCityOwnerClaim(user.uid, owned[0].id).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, [user]);

  const owned = cities.filter((city) => user && city.ownerUids.includes(user.uid));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user) return;
    setBusy(true);
    setError("");
    try {
      const id = await createTreaty(user.uid, {
        name,
        type,
        nature,
        terms,
        purpose,
        open,
        inviteeCityIds: invitees,
        proposerCityId,
      }, cities);
      router.push(`/treaties/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not propose that treaty.");
      setBusy(false);
    }
  };

  if (loading) return <ScreenStatus>Loading…</ScreenStatus>;
  if (!user) return <ScreenStatus>Sign in to propose a treaty.</ScreenStatus>;
  if (owned.length === 0) return <ScreenStatus>Found a city before proposing a treaty. Only a city&apos;s owners can draft one.</ScreenStatus>;

  return (
    <div className="wood-texture min-h-[calc(100vh-4rem)] p-6">
      <form onSubmit={submit} className="max-w-2xl mx-auto glass-panel p-6 space-y-4">
        <Link href="/treaties" className="text-accent-gold text-sm">← Treaties</Link>
        <h1 className="text-3xl font-bold text-accent-gold">Propose a treaty</h1>
        <div>
          <label className="form-label" htmlFor="proposer">Your city</label>
          <select id="proposer" className="form-input" value={proposerCityId} onChange={(event) => setProposerCityId(event.target.value)}>
            {owned.map((city) => <option key={city.id} value={city.id}>{city.name}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="name">Name</label>
          <input id="name" className="form-input" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div>
          <label className="form-label" htmlFor="type">Type</label>
          <select id="type" className="form-input" value={type} onChange={(event) => setType(event.target.value as TreatyType)}>
            {TREATY_TYPES.map((item) => <option key={item} value={item}>{TREATY_TYPE_LABELS[item]}</option>)}
          </select>
        </div>
        <div>
          <label className="form-label" htmlFor="purpose">Short purpose</label>
          <input id="purpose" className="form-input" value={purpose} onChange={(event) => setPurpose(event.target.value)} required />
        </div>
        <div>
          <label className="form-label" htmlFor="nature">General nature</label>
          <textarea id="nature" className="form-input" rows={4} value={nature} onChange={(event) => setNature(event.target.value)} />
        </div>
        <div>
          <label className="form-label" htmlFor="terms">Specific terms</label>
          <textarea id="terms" className="form-input" rows={6} value={terms} onChange={(event) => setTerms(event.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={open} onChange={(event) => setOpen(event.target.checked)} />
          Open to every city
        </label>
        <fieldset className="space-y-1">
          <legend className="form-label">Invite cities</legend>
          {cities.filter((city) => city.id !== proposerCityId).map((city) => (
            <label key={city.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={invitees.includes(city.id)}
                onChange={(event) => {
                  setInvitees((current) => event.target.checked ? [...current, city.id] : current.filter((id) => id !== city.id));
                }}
              />
              {city.name}
            </label>
          ))}
        </fieldset>
        {error && <p className="text-sm font-bold" role="alert">{error}</p>}
        <button className="btn" disabled={busy} type="submit">{busy ? "Sending…" : "Send proposal"}</button>
      </form>
    </div>
  );
}
