/**
 * Season-0 allocation module (Phase 4, built ahead of the Phase 4 brief).
 *
 * Pure logic (stats / validation / draft shapes) is importable anywhere;
 * draft hashes come from the sim layer's canonical module (P4-K15 — the
 * browser port is deleted). draftSave is the only submodule that touches
 * Firestore, and it writes only through the rules' owner draft fence. The
 * commit itself is a Phase 4 fabric Resolution Event — see draft.ts.
 */

export * from "./stats";
export * from "./validation";
export * from "./draft";
export { saveAllocationDraft, requestAllocationCommit } from "./draftSave";
