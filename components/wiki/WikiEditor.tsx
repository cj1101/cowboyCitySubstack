"use client";

import { useState } from "react";
import { MentionAutocomplete } from "@/components/mentions/MentionAutocomplete";
import {
  createEmptySection,
  saveAllWikiSections,
  type WikiSection,
} from "@/lib/firestore/wiki";

interface WikiEditorProps {
  factionId: string;
  initialSections: WikiSection[];
  onSaved?: () => void;
}

export function WikiEditor({ factionId, initialSections, onSaved }: WikiEditorProps) {
  const [sections, setSections] = useState<WikiSection[]>(
    initialSections.length > 0 ? initialSections : [createEmptySection(0)]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const updateSection = (index: number, patch: Partial<WikiSection>) => {
    setSections((prev) =>
      prev.map((section, i) => (i === index ? { ...section, ...patch } : section))
    );
  };

  const moveSection = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    setSections((prev) => {
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next.map((section, i) => ({ ...section, order: i }));
    });
  };

  const addSection = () => {
    setSections((prev) => [...prev, createEmptySection(prev.length)]);
  };

  const removeSection = (index: number) => {
    setSections((prev) => prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i })));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      await saveAllWikiSections(factionId, sections);
      setSuccess(true);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save wiki");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {sections.map((section, index) => (
        <div key={section.id} className="glass-panel p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <span className="text-accent-gold font-bold text-sm">Section {index + 1}</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => moveSection(index, -1)}
                disabled={index === 0}
                className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-40"
              >
                ↑ Up
              </button>
              <button
                type="button"
                onClick={() => moveSection(index, 1)}
                disabled={index === sections.length - 1}
                className="btn btn-secondary text-xs px-3 py-1 disabled:opacity-40"
              >
                ↓ Down
              </button>
              <button
                type="button"
                onClick={() => removeSection(index)}
                disabled={sections.length === 1}
                className="btn btn-danger text-xs px-3 py-1 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>

          <div>
            <label className="form-label" htmlFor={`title-${section.id}`}>
              Section Title
            </label>
            <input
              id={`title-${section.id}`}
              type="text"
              value={section.title}
              onChange={(e) => updateSection(index, { title: e.target.value })}
              className="form-input"
              placeholder="e.g. History, Territory, Notable Figures"
            />
          </div>

          <div>
            <label className="form-label" htmlFor={`body-${section.id}`}>
              Content
            </label>
            <MentionAutocomplete
              value={section.body}
              onChange={(body) => updateSection(index, { body })}
              rows={12}
            />
          </div>
        </div>
      ))}

      <div className="flex flex-wrap gap-4 items-center">
        <button type="button" onClick={addSection} className="btn btn-secondary">
          + Add Section
        </button>
        <button type="button" onClick={handleSave} disabled={saving} className="btn">
          {saving ? "Saving…" : "Save Wiki"}
        </button>
        {success && <span className="text-accent-gold text-sm">Wiki saved.</span>}
        {error && <span className="text-danger text-sm">{error}</span>}
      </div>
    </div>
  );
}
