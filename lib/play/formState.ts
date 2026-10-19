/**
 * Structured-form state logic (Phase 4 brief §2.1) — pure functions
 * between a `PlayActionKind` form spec and the `structuredAction`
 * record a handler receives.
 *
 * Kept separate from the component so the mapping is testable
 * without a DOM, and so the rules are stated once: a required field
 * must be present, a number field must parse and sit inside its
 * stated bounds, and the submitted record contains exactly the
 * form's fields — optional fields left blank are omitted, never
 * submitted as empty strings a handler would have to guess at.
 */

import type { PlayActionKind } from "./types";

/** Raw form values, keyed by field key. Everything is a string in
 * the form; coercion happens in buildStructuredAction. */
export type PlayFieldValues = Record<string, string>;

export function initialFieldValues(kind: PlayActionKind): PlayFieldValues {
  const values: PlayFieldValues = {};
  for (const field of kind.fields) values[field.key] = "";
  return values;
}

/** Problems with the current values, in field order, worded for the
 * member. An empty list means the form may submit. */
export function validateFieldValues(kind: PlayActionKind, values: PlayFieldValues): string[] {
  const problems: string[] = [];
  for (const field of kind.fields) {
    const raw = (values[field.key] ?? "").trim();
    if (raw === "") {
      if (field.required) problems.push(`${field.label} is required.`);
      continue;
    }
    if (field.kind === "number") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        problems.push(`${field.label} must be a number.`);
        continue;
      }
      if (field.min !== undefined && parsed < field.min) {
        problems.push(`${field.label} must be at least ${field.min}.`);
      }
      if (field.max !== undefined && parsed > field.max) {
        problems.push(`${field.label} must be at most ${field.max}.`);
      }
    }
    if (field.kind === "select" && field.options) {
      if (!field.options.some((option) => option.value === raw)) {
        problems.push(`${field.label} has an unrecognized choice.`);
      }
    }
  }
  return problems;
}

/** Coerce validated form values into the handler's record. Call only
 * with values validateFieldValues accepted. */
export function buildStructuredAction(
  kind: PlayActionKind,
  values: PlayFieldValues
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const field of kind.fields) {
    const raw = (values[field.key] ?? "").trim();
    if (raw === "") continue;
    record[field.key] = field.kind === "number" ? Number(raw) : raw;
  }
  return record;
}

/** The submitted action's targets, per the kind's own rule. A "form"
 * kind takes its target from its first `city` field. */
export function targetCityIdsFor(
  kind: PlayActionKind,
  values: PlayFieldValues,
  actingCityId: string
): string[] {
  if (kind.target === "acting-city") return actingCityId ? [actingCityId] : [];
  if (kind.target === "none") return [];
  const cityField = kind.fields.find((field) => field.kind === "city");
  const chosen = cityField ? (values[cityField.key] ?? "").trim() : "";
  return chosen ? [chosen] : [];
}
