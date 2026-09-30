/**
 * Best-effort embedder warm-up (memory-backend-improve-and-hybrid P-004a).
 *
 * The first memory search after boot pays the embedder's cold-start — a TLS
 * handshake for the OpenAI embedder (~60ms; undici keepalive then reuses the
 * connection, so subsequent calls are warm) or, when the local BGE-ONNX embedder
 * is active, the one-time ONNX model load (~1s, which `injection.ts` otherwise
 * absorbs behind a 5s timeout → degraded mode). Firing one throwaway search at
 * boot moves that cost off the user's first turn.
 *
 * Fully defensive + bounded: it never throws and never blocks the caller — a
 * cold or misconfigured embedder must not affect operator boot. Fire-and-forget.
 */
import { getMemoryBackend, type MemoryBackend } from '@papercusp/memory';

/**
 * Generous by design (EI-12962): the warmup is DETACHED (never awaited), so a
 * tight deadline protects nothing — while boot-storm contention (cargo build,
 * embedded-pg start, migrations) routinely pushes the cold client build past
 * the old 8s (8.1s measured live), making the warmup silently give up and the
 * first real chat turn pay the full cold path anyway. The deadline exists only
 * so a truly wedged backend can't pin the promise forever.
 */
const WARM_TIMEOUT_MS = 60_000;
/** One retry after a boot-storm miss — PG/credentials are usually up by then. */
const WARM_RETRY_DELAY_MS = 15_000;

function deadline<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), WARM_TIMEOUT_MS))]);
}

/** Pre-warm the embedder/connection with one throwaway read. `backend` is
 *  injectable for tests; defaults to the configured backend.
 *
 *  ALWAYS logs its outcome (EI-12962): this warmup ran SILENTLY for weeks
 *  while the first real chat turn still paid a ~5s cold `available()` +
 *  a ~5s (timed-out) search — with no log line there was no way to tell
 *  from a sidecar log whether the warmup ran, failed, or raced boot. One
 *  line per boot is cheap; debugging a silent no-op is not. */
export async function warmMemoryEmbedder(
  backend: MemoryBackend = getMemoryBackend(),
  attempt = 1,
): Promise<void> {
  const t0 = Date.now();
  try {
    const avail = await deadline(backend.available(), { ok: false as const, reason: 'warm_timeout' });
    const tAvail = Date.now() - t0;
    if (!avail.ok) {
      const reason = (avail as { reason?: string }).reason ?? 'not ok';
      if (attempt < 2) {
        console.log(
          `[memory-warm] attempt ${attempt} not ready after available() (${tAvail}ms): ${reason} — retrying once in ${WARM_RETRY_DELAY_MS / 1000}s`,
        );
        setTimeout(() => void warmMemoryEmbedder(backend, attempt + 1), WARM_RETRY_DELAY_MS).unref?.();
        return;
      }
      console.log(
        `[memory-warm] SKIPPED after available() (${tAvail}ms): ${reason} — the first real turn will pay the cold path`,
      );
      return;
    }
    const tSearch = Date.now();
    await deadline(
      backend.search('warmup', { scope: '__warmup__', limit: 1 }).then(() => undefined),
      undefined,
    );
    console.log(
      `[memory-warm] done availableMs=${tAvail} searchMs=${Date.now() - tSearch} backend=${backend.name}`,
    );
  } catch (err) {
    /* best-effort — a cold/misconfigured embedder must never affect boot */
    console.log(
      `[memory-warm] FAILED after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
