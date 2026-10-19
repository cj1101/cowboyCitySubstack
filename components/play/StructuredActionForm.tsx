"use client";

/**
 * The generic structured-action form (Phase 4 brief §2.1) — renders
 * any `PlayActionKind` catalog entry from its field specs. Adding a
 * kind to the catalog gives it this form for free; the form holds no
 * per-kind code, and no field renders that the spec did not declare.
 */

import { useId } from "react";
import type { PlayFieldValues } from "@/lib/play/formState";
import type { PlayActionKind, PlayCityOption } from "@/lib/play/types";

export interface StructuredActionFormProps {
  kind: PlayActionKind;
  values: PlayFieldValues;
  onChange: (values: PlayFieldValues) => void;
  /** Options for `city` fields (the member's reachable cities). */
  cities: PlayCityOption[];
}

export function StructuredActionForm({
  kind,
  values,
  onChange,
  cities,
}: StructuredActionFormProps) {
  const idPrefix = useId();
  const setField = (key: string, value: string) => onChange({ ...values, [key]: value });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-muted">{kind.blurb}</p>
      {kind.fields.map((field) => {
        const fieldId = `${idPrefix}-${field.key}`;
        const value = values[field.key] ?? "";
        return (
          <label key={field.key} className="flex flex-col gap-1" htmlFor={fieldId}>
            <span className="text-text-muted">
              {field.label}
              {field.required ? " *" : ""}
            </span>
            {field.kind === "textarea" ? (
              <textarea
                id={fieldId}
                className="form-input min-h-24"
                value={value}
                placeholder={field.placeholder}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            ) : field.kind === "select" ? (
              <select
                id={fieldId}
                className="form-input min-h-11"
                value={value}
                onChange={(event) => setField(field.key, event.target.value)}
              >
                <option value="">Choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.kind === "city" ? (
              <select
                id={fieldId}
                className="form-input min-h-11"
                value={value}
                onChange={(event) => setField(field.key, event.target.value)}
              >
                <option value="">Choose a city…</option>
                {cities.map((city) => (
                  <option key={city.factionId} value={city.factionId}>
                    {city.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={fieldId}
                className="form-input min-h-11"
                type={field.kind === "number" ? "number" : "text"}
                value={value}
                placeholder={field.placeholder}
                min={field.kind === "number" ? field.min : undefined}
                max={field.kind === "number" ? field.max : undefined}
                step={field.kind === "number" ? field.step : undefined}
                onChange={(event) => setField(field.key, event.target.value)}
              />
            )}
            {field.help ? <span className="text-xs text-text-muted">{field.help}</span> : null}
          </label>
        );
      })}
    </div>
  );
}
