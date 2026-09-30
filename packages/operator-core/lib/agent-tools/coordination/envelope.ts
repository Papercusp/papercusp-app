/**
 * envelope.ts — operator-side re-export of the coordination envelope
 * vocabulary, owned by @papercusp/coordination/core (P-011).
 *
 * The extracted channels (messages/handoffs/escalations/plan-events) read and
 * write through the `coordLog` seam (see log.ts); they no longer touch coord
 * files directly. The former generic file-line primitives (`appendCoordLine` /
 * `readCoordFile`) had no remaining production consumers after the FS→PG
 * cutover and were removed.
 */

export {
  type CoordKind,
  type CoordEnvelope,
  newMsgId,
} from '@papercusp/coordination/core';
