/**
 * Credential scrubbing for upstream ERROR bodies that a lane adapter relays to the gateway caller.
 *
 * An upstream error body is never guaranteed to be secret-free. If an upstream echoes the
 * credential the gateway presented (in a 401 explanation, a 500 dump, a debug envelope), relaying
 * that body verbatim hands a POOL account's secret to whichever caller triggered the error. This is
 * the same incident class `scrubSecrets` was written for (2026-07-03). The fix first landed on the
 * Claude lane (anthropic-credits-gateway P-005 R-5). WI-10004561 lifts it here so every lane that
 * relays a non-2xx body uses the same rule.
 *
 * Two layers, applied in this order:
 *  1. `scrubSecrets`, the shape-based redactor (`sk-ant-…`, `Bearer <token>`). It runs first so a
 *     Claude key keeps the identifying prefix operators already rely on.
 *  2. Exact-value redaction of every credential the attempt PRESENTED, read from its own outbound
 *     headers. This catches shapes `scrubSecrets` does not know, such as an OpenAI key or a ChatGPT
 *     OAuth JWT echoed without a `Bearer ` prefix. Those shapes cannot be matched by pattern
 *     without false positives, but the exact value the gateway sent is known for certain.
 *
 * A 2xx stream is never wrapped; callers gate on `status >= 400`.
 */
import { scrubSecrets } from './credential-store';

/** A relayable response body, as the request kernel carries it. */
export type RelayBody = AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void };

/** Past this many bytes an error body is scrubbed chunk by chunk instead of as one buffer. */
export const MAX_BUFFERED_ERROR_BODY_BYTES = 1 << 20;

/**
 * Exact-match redaction ignores values shorter than this. A short header value is not a
 * credential worth leaking, and replacing it everywhere would mangle ordinary body text.
 */
export const MIN_EXACT_SECRET_LENGTH = 12;

/** Outbound header names whose value is (or wraps) a credential. Compared lowercase. */
const CREDENTIAL_HEADER_NAMES = new Set(['authorization', 'proxy-authorization', 'x-api-key', 'api-key']);

/**
 * The credential values an attempt presented upstream, read from its outbound headers. The
 * `Bearer ` / `Basic ` scheme is stripped so the bare token is matched wherever it reappears.
 */
export function presentedSecretsFromHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>> | null | undefined,
): string[] {
  if (!headers) return [];
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADER_NAMES.has(name.toLowerCase())) continue;
    const values: readonly (string | undefined)[] = Array.isArray(raw) ? raw : [raw as string | undefined];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const bare = value.replace(/^\s*(?:Bearer|Basic)\s+/i, '').trim();
      if (bare.length >= MIN_EXACT_SECRET_LENGTH) out.add(bare);
    }
  }
  return [...out];
}

/** How much of a redacted exact-match secret stays visible: enough to say WHICH, never most of it. */
function visiblePrefix(secret: string): string {
  return secret.slice(0, Math.min(8, Math.floor(secret.length / 4)));
}

/** Scrub one decoded error-body string: shape-based first, then every presented value exactly. */
export function scrubErrorText(text: string, presented: readonly string[] = []): string {
  let out = scrubSecrets(text);
  for (const secret of presented) {
    if (secret.length < MIN_EXACT_SECRET_LENGTH) continue;
    if (out.includes(secret)) out = out.split(secret).join(`${visiblePrefix(secret)}…[redacted]`);
  }
  return out;
}

/**
 * Wrap a non-2xx upstream body so whatever reaches the caller has its credentials scrubbed. The
 * body is buffered whole, up to MAX_BUFFERED_ERROR_BODY_BYTES, so a secret cannot straddle a chunk
 * boundary; past that it is scrubbed chunk by chunk. Changing the byte length is safe because
 * gateway.ts strips content-length/content-encoding on the way back. `cancel` is preserved, so a
 * retried attempt can still release the socket.
 */
export function scrubbedErrorBody(body: RelayBody, presented: readonly string[] = []): RelayBody {
  const scrub = (bytes: Uint8Array): Uint8Array =>
    Buffer.from(scrubErrorText(Buffer.from(bytes).toString('utf8'), presented), 'utf8');
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = body[Symbol.asyncIterator]();
      const buffered: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const chunk = next.value as Uint8Array;
        if (size >= MAX_BUFFERED_ERROR_BODY_BYTES) {
          yield scrub(chunk);
          continue;
        }
        buffered.push(chunk);
        size += chunk.length;
        if (size >= MAX_BUFFERED_ERROR_BODY_BYTES) {
          yield scrub(Buffer.concat(buffered.map((c) => Buffer.from(c))));
          buffered.length = 0;
        }
      }
      if (buffered.length) yield scrub(Buffer.concat(buffered.map((c) => Buffer.from(c))));
    },
    cancel: () => body.cancel?.(),
  };
}
