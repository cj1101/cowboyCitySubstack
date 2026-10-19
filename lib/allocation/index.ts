/**
 * Season-0 allocation module (Phase 4, built ahead of the Phase 4 brief).
 *
 * Pure logic (stats / validation / canonical / draft shapes) is importable
 * anywhere; draftSave is the only submodule that touches Firestore, and it
 * writes only through the Phase 1 rules' owner draft fence. The commit
 * itself is a Phase 4 fabric Resolution Event — see draft.ts.
 */

export * from "./stats";
export * from "./validation";
export * from "./canonical";
export * from "./draft";
export { saveAllocationDraft, requestAllocationCommit } from "./draftSave";
