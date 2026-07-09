"use client";

import { FormEvent, useState } from "react";
import type { Character } from "@/lib/types";

export interface CharacterFormData {
  name: string;
  title: string;
  isActive: boolean;
  avatarFile: File | null;
}

interface CharacterFormProps {
  initial?: Partial<CharacterFormData> & { avatarUrl?: string };
  onSubmit: (data: CharacterFormData) => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}

export function CharacterForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel = "Save Character",
}: CharacterFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive !== false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await onSubmit({ name: name.trim(), title: title.trim(), isActive, avatarFile });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save character");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 glass-panel p-5">
      <div>
        <label htmlFor="char-name" className="form-label">Character Name</label>
        <input
          id="char-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="form-input"
          placeholder="Marshal Kane"
        />
      </div>
      <div>
        <label htmlFor="char-title" className="form-label">Title (optional)</label>
        <input
          id="char-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="form-input"
          placeholder="Sheriff of Iron Ridge"
        />
      </div>
      <div>
        <label htmlFor="char-avatar" className="form-label">Avatar</label>
        {initial?.avatarUrl && !avatarFile && (
          <img src={initial.avatarUrl} alt="Current avatar" className="w-12 h-12 rounded-full mb-2 border border-accent-gold object-cover" />
        )}
        <input
          id="char-avatar"
          type="file"
          accept="image/*"
          onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
          className="form-input text-sm"
        />
      </div>
      <label className="flex items-center gap-2 text-text-light cursor-pointer">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
          className="w-4 h-4 accent-accent-gold"
        />
        Active (can be selected for posting)
      </label>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <div className="flex gap-3">
        <button type="submit" disabled={submitting} className="btn text-sm px-5 py-2">
          {submitting ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="btn btn-secondary text-sm px-5 py-2">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

interface CharacterListProps {
  characters: Character[];
  onEdit: (character: Character) => void;
  onDelete: (characterId: string) => Promise<void>;
}

export function CharacterList({ characters, onEdit, onDelete }: CharacterListProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (characters.length === 0) {
    return <p className="text-text-muted text-sm">No characters yet. Add one to post as this faction.</p>;
  }

  return (
    <ul className="space-y-3">
      {characters.map((character) => (
        <li
          key={character.id}
          className="flex items-center justify-between gap-4 glass-panel p-4"
        >
          <div className="flex items-center gap-3 min-w-0">
            {character.avatarUrl ? (
              <img
                src={character.avatarUrl}
                alt=""
                className="w-10 h-10 rounded-full border border-accent-gold object-cover shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary-brown border border-accent-gold flex items-center justify-center text-accent-gold font-bold shrink-0">
                {character.name.charAt(0)}
              </div>
            )}
            <div className="min-w-0">
              <p className="font-bold text-text-light truncate">{character.name}</p>
              {character.title && (
                <p className="text-text-muted text-sm truncate">{character.title}</p>
              )}
              {!character.isActive && (
                <span className="text-xs text-danger">Inactive</span>
              )}
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onEdit(character)}
              className="btn btn-secondary text-xs px-3 py-1.5"
            >
              Edit
            </button>
            <button
              type="button"
              disabled={deletingId === character.id}
              onClick={async () => {
                if (!confirm(`Delete character "${character.name}"?`)) return;
                setDeletingId(character.id);
                try {
                  await onDelete(character.id);
                } finally {
                  setDeletingId(null);
                }
              }}
              className="btn btn-danger text-xs px-3 py-1.5"
            >
              {deletingId === character.id ? "…" : "Delete"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
