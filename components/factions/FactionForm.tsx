"use client";

import { FormEvent, useState } from "react";
import { slugify } from "@/lib/utils/slug";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { FactionColors } from "@/lib/types";

export interface FactionFormData {
  name: string;
  slug: string;
  colors: FactionColors;
  bio: string;
  lore: string;
  bannerFile: File | null;
  sigilFile: File | null;
}

interface FactionFormProps {
  initial?: Partial<FactionFormData> & { bannerUrl?: string; sigilUrl?: string };
  onSubmit: (data: FactionFormData) => Promise<void>;
  submitLabel?: string;
}

const DEFAULT_COLORS: FactionColors = { primary: "#169C9C", secondary: "#FED83D" };

export function FactionForm({ initial, onSubmit, submitLabel = "Save Faction" }: FactionFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [slugManual, setSlugManual] = useState(!!initial?.slug);
  const [primaryColor, setPrimaryColor] = useState(initial?.colors?.primary ?? DEFAULT_COLORS.primary);
  const [secondaryColor, setSecondaryColor] = useState(initial?.colors?.secondary ?? DEFAULT_COLORS.secondary);
  const [bio, setBio] = useState(initial?.bio ?? "");
  const [lore, setLore] = useState(initial?.lore ?? "");
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [sigilFile, setSigilFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugManual) {
      setSlug(slugify(value));
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        slug: slug.trim(),
        colors: { primary: primaryColor, secondary: secondaryColor },
        bio: bio.trim(),
        lore: lore.trim(),
        bannerFile,
        sigilFile,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save faction");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="faction-name" className="form-label">City name</label>
        <input
          id="faction-name"
          type="text"
          required
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          className="form-input"
          placeholder="Iron Ridge Republic"
        />
      </div>

      <div>
        <label htmlFor="faction-slug" className="form-label">URL Slug</label>
        <input
          id="faction-slug"
          type="text"
          required
          value={slug}
          onChange={(e) => {
            setSlugManual(true);
            setSlug(slugify(e.target.value));
          }}
          className="form-input"
          placeholder="iron-ridge-republic"
        />
        <p className="text-text-muted text-xs mt-1">/cities/{slug || "your-slug"}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label htmlFor="primary-color" className="form-label">Primary Color</label>
          <div className="flex items-center gap-2">
            <input
              id="primary-color"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="w-12 h-10 rounded cursor-pointer border border-accent-gold"
            />
            <input
              type="text"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="form-input flex-1"
            />
          </div>
        </div>
        <div>
          <label htmlFor="secondary-color" className="form-label">Secondary Color</label>
          <div className="flex items-center gap-2">
            <input
              id="secondary-color"
              type="color"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="w-12 h-10 rounded cursor-pointer border border-accent-gold"
            />
            <input
              type="text"
              value={secondaryColor}
              onChange={(e) => setSecondaryColor(e.target.value)}
              className="form-input flex-1"
            />
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="faction-bio" className="form-label">Description</label>
        <textarea
          id="faction-bio"
          rows={4}
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          className="form-input resize-y"
          placeholder="A short public description of this city"
        />
      </div>

      <div>
        <label htmlFor="faction-lore" className="form-label">Lore</label>
        <textarea
          id="faction-lore"
          rows={6}
          value={lore}
          onChange={(e) => setLore(e.target.value)}
          className="form-input resize-y"
          placeholder="The longer history of this city-state"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="banner-upload" className="form-label">Banner Image</label>
          {initial?.bannerUrl && !bannerFile && (
            <img src={initial.bannerUrl} alt="Current banner" className="w-full h-20 object-cover rounded mb-2 border border-accent-gold" />
          )}
          <input
            id="banner-upload"
            type="file"
            accept="image/*"
            onChange={(e) => setBannerFile(e.target.files?.[0] ?? null)}
            className="form-input text-sm"
          />
        </div>
        <div>
          <label htmlFor="sigil-upload" className="form-label">Crest</label>
          {initial?.sigilUrl && !sigilFile && (
            <img src={initial.sigilUrl} alt="Current sigil" className="w-16 h-16 object-cover rounded-full mb-2 border border-accent-gold" />
          )}
          <input
            id="sigil-upload"
            type="file"
            accept="image/*"
            onChange={(e) => setSigilFile(e.target.files?.[0] ?? null)}
            className="form-input text-sm"
          />
        </div>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <SubmitButton busy={submitting} busyLabel="Saving…">{submitLabel}</SubmitButton>
    </form>
  );
}
