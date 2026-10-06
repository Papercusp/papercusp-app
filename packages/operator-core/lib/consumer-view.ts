/**
 * Consumer-attested writes (EI-23770243810745552).
 *
 * A write verb that reports `ok` has only proven that the WRITE landed. When the
 * path a downstream CONSUMER reads differs from the path that was written (a
 * decoy column, a projection, a default-view cap), the consumer can still see
 * something else — WI-10002021 was exactly that: the writer updated
 * `control_transition->'state'->'activation'` while the enforcement port read
 * `control_state->'activation'`. `coord:send`'s `bodyDeliveredChars` is the first
 * instance of the idea ("what the recipient's default read can see"); this is the
 * same shape as a standard, reusable block:
 *
 *   consumerView: { readPath, value, divergedFromWrite }
 *
 * `readPath` names the path/lens the consumer actually reads, `value` is what that
 * read returned, and `divergedFromWrite` is true when `value` is NOT what the write
 * intended. It is additive and observational — it never changes what is written.
 *
 * Leaf module on purpose (no imports beyond the shared canonical-JSON primitive) so a
 * write path can attest its consumer without pulling a read-side graph.
 */
import { canonicalJson } from '@papercusp/hash-chain';

export interface ConsumerView<T = unknown> {
  /** The path/lens the downstream consumer actually reads (a stable, human-greppable label). */
  readPath: string;
  /** What that consumer read returned for this write. */
  value: T;
  /** True when `value` differs from what the write intended — or cannot be proven equal. */
  divergedFromWrite: boolean;
}

/**
 * Compare what a write INTENDED with what the consumer's read path returned.
 *
 * Equality is structural (object key order is irrelevant, matching jsonb), and
 * `undefined`/`null` are the same absent value. A pair that cannot be put in
 * canonical JSON (a `bigint`, a `Date`, a non-finite number) cannot be shown equal, so it
 * is reported as diverged: an attestation that cannot prove agreement must not claim it.
 */
export function buildConsumerView<T>(input: {
  readPath: string;
  written: unknown;
  consumed: T;
}): ConsumerView<T> {
  return {
    readPath: input.readPath,
    value: input.consumed,
    divergedFromWrite: !structurallyEqual(input.written, input.consumed),
  };
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a ?? null) === canonicalJson(b ?? null);
  } catch {
    return false;
  }
}
