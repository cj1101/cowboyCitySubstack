/**
 * Task envelopes — public surface (Phase 5 envelope machinery, built
 * ahead of the phase from the Phase 5 implementation brief §2.5/§4).
 *
 * What is NOT here: no worker, no scheduler, no commit path — by
 * construction. An envelope's output is a proposal artifact; the only
 * way envelope work changes the world is the owner (or a binding act)
 * confirming it as a NEW action through the ordinary Phase 2/3 path,
 * where it faces the authority stage like everything else. The
 * never-bind guarantee is structural here: `mayCommit` is false by
 * type, thrown on by the builder, rejected by validation, and no
 * function in this module returns a plan, a write, or a resolution.
 */

export type {
  EnvelopeBounds,
  EnvelopeSpawnInput,
  EnvelopeSpawnSource,
  EnvelopeStatus,
  EnvelopeStructuredOutput,
  EnvelopeTaskType,
  TaskEnvelopeRecord,
  TaskOutputRecord,
} from "./types";

export { TERMINAL_ENVELOPE_STATUSES } from "./types";

export {
  EnvelopeValidationError,
  buildTaskEnvelope,
  envelopeMandateLabel,
  envelopeExceedsMandate,
  envelopeTaskId,
  evaluateEnvelopeTasking,
  validateEnvelopeRecord,
  validateEnvelopeSpawn,
  type EnvelopeTaskingVerdict,
} from "./envelopes";

export {
  MAX_ENVELOPE_ATTEMPTS,
  buildEnvelopeOutcomeEntryDraft,
  buildTaskOutput,
  claimEnvelope,
  envelopeContextHash,
  failureOutcome,
  leaseIsLive,
  revalidateEnvelopeAtExecution,
  terminalEnvelopePatch,
  validateTaskOutput,
  validateTerminalPreconditions,
  type ClaimResult,
} from "./lifecycle";
