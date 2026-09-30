/**
 * ElevenLabs webhook signature verification.
 *
 * EL signs webhook payloads with HMAC-SHA256 over `${timestamp}.${body}`
 * using a per-workspace secret configured on the dashboard. The signed
 * value lives in the `elevenlabs-signature` header in the format:
 *
 *   elevenlabs-signature: t=1700000000,v0=<hex>
 *
 * Configure the secret in the EL workspace settings and set the same
 * value as ELEVENLABS_WEBHOOK_SECRET in the operator environment. If
 * the secret is unset, verification is skipped (dev mode) — log a
 * warning so prod misconfiguration is visible.
 *
 * Replay protection: reject signatures whose timestamp is more than 5
 * minutes old, even if the HMAC matches.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const SKEW_MS = 5 * 60_000;
let warnedNoSecret = false;

export interface VerifyResult {
  ok: boolean;
  reason?: 'no-secret-dev' | 'missing-header' | 'malformed-header' | 'stale' | 'mismatch' | 'no-payload';
}

export function verifyElevenLabsSignature(opts: {
  rawBody: string;
  signatureHeader: string | null;
  /** Override clock for tests. */
  now?: number;
}): VerifyResult {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn(
        '[elevenlabs-webhook] ELEVENLABS_WEBHOOK_SECRET unset — accepting unsigned webhooks (dev mode). Set this env var in production.',
      );
    }
    return { ok: true, reason: 'no-secret-dev' };
  }

  if (!opts.signatureHeader) return { ok: false, reason: 'missing-header' };

  // Header format: t=<unix_secs>,v0=<hex>
  const parts = opts.signatureHeader.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return { ok: false, reason: 'malformed-header' };

  const ts = Number(t) * 1000;
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed-header' };
  const now = opts.now ?? Date.now();
  if (Math.abs(now - ts) > SKEW_MS) return { ok: false, reason: 'stale' };

  if (!opts.rawBody) return { ok: false, reason: 'no-payload' };

  const expected = createHmac('sha256', secret)
    .update(`${t}.${opts.rawBody}`)
    .digest('hex');

  // Constant-time compare. Both must be the same length; pad the
  // shorter one to avoid throwing in the rare malformed case.
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v0, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  const equal = timingSafeEqual(a, b);
  return equal ? { ok: true } : { ok: false, reason: 'mismatch' };
}
