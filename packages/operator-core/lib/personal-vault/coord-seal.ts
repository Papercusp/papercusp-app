/**
 * Reader-set labels — sealing what a restricted session writes to coord.
 * Plan personal-data-reader-set-labels-2026-10-01 P-006 (WI-10004933), D-006.
 *
 * A coord message is not a directed channel: coord:feed hands every agent every
 * message and coord:read fetches any one by msg_id. So while the sender holds an
 * active disclosure, the persisted envelope keeps only what routes it, and
 * everything the sender authored moves to the sealed store (sealed-contents.ts).
 * It comes back only through an open that labels the reader.
 *
 * The split is by ALLOWLIST. A key not named in COORD_ROUTING_KEYS is content,
 * so a new envelope field is sealed until someone decides it carries nothing the
 * sender wrote. A surface that has never heard of sealing shows the stub.
 */
import { CUE_AUTHORITY_FIELD } from '../agent-tools/coordination/cue-authority';
import { ALLHIVE_BROADCAST_FIELD } from '../agent-tools/coordination/scope-broadcast';

export const COORD_SEAL_STORE = 'coord';

/** The envelope key that marks a stub. */
export const SEALED_FIELD = 'sealed';

/** Envelope keys that route or classify a message and carry nothing the sender authored. */
export const COORD_ROUTING_KEYS: ReadonlySet<string> = new Set([
  'ts',
  'msg_id',
  'from',
  'to',
  'audience',
  'kind',
  'category',
  'plan_slug',
  'harness_slug',
  'related_msg_id',
  'expects',
  'expectsReply',
  'auto',
  'lifecycle',
  'wake',
  'wakeOnReply',
  'receipt',
  'replyDeadlineAt',
  'fieldProvenance',
  CUE_AUTHORITY_FIELD,
  ALLHIVE_BROADCAST_FIELD,
]);

export interface SealMarker {
  /** Restricted documents whose labels travel with the content. */
  labels: number;
  /** The call that opens it. */
  open: string;
}

type Envelope = { msg_id: string; from: string } & Record<string, unknown>;

export function sealedSummary(from: string, msgId: string): string {
  return (
    `🔒 Sealed: ${from} wrote this while holding restricted personal content. ` +
    `coord:read { msg_id: '${msgId}', unseal: true } opens it and limits your outbound sends the same way.`
  );
}

/**
 * Split `env` into the stub that may be persisted and the content that must be
 * sealed. Null when the envelope carries nothing the sender authored (a bare
 * ack), which is persisted as-is.
 */
export function splitForSeal<E extends Envelope>(
  env: E,
  labels: number,
): { stub: E & { summary: string; [SEALED_FIELD]: SealMarker }; content: Record<string, unknown> } | null {
  const stub: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (COORD_ROUTING_KEYS.has(key)) stub[key] = value;
    else content[key] = value;
  }
  if (!Object.keys(content).length) return null;
  stub.summary = sealedSummary(env.from, env.msg_id);
  stub[SEALED_FIELD] = { labels, open: `coord:read { msg_id: '${env.msg_id}', unseal: true }` } satisfies SealMarker;
  return { stub: stub as E & { summary: string; [SEALED_FIELD]: SealMarker }, content };
}

export function sealMarkerOf(env: unknown): SealMarker | null {
  if (!env || typeof env !== 'object') return null;
  const marker = (env as Record<string, unknown>)[SEALED_FIELD];
  if (!marker || typeof marker !== 'object') return null;
  const labels = (marker as Record<string, unknown>).labels;
  const open = (marker as Record<string, unknown>).open;
  return typeof labels === 'number' && typeof open === 'string' ? { labels, open } : null;
}

/** The envelope as the sender wrote it: the stub's routing keys plus the sealed content. */
export function mergeUnsealed<E extends Record<string, unknown>>(stub: E, content: Record<string, unknown>): E {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stub)) {
    if (key !== SEALED_FIELD && key !== 'summary') merged[key] = value;
  }
  for (const [key, value] of Object.entries(content)) {
    if (!COORD_ROUTING_KEYS.has(key)) merged[key] = value;
  }
  return merged as E;
}
