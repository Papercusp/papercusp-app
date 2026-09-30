/**
 * MOVED to `@papercusp/operator-ui/papercup-chat/parse-work-refs`
 * (papercup-chat-one-component-one-contract-2026-09-06 P-007): the ref
 * extraction is part of the shared Papercup chat now. This module is the
 * operator's historical import surface and re-exports the one implementation —
 * two copies of the ref grammar would drift.
 */
export { parseWorkRefs, type WorkRefKind, type WorkRefMatch } from '@papercusp/operator-ui/papercup-chat/parse-work-refs';
