/**
 * Cupboard rate-limit primitives.
 *
 * Two storage backends:
 *
 *   - KV-counter (per-IP, per-minute / per-hour) — fast, cheap, fuzzy.
 *     Same pattern as `papercusp-publish/src/ratelimit.ts`.
 *
 *   - D1 publish_rate_limit table — durable per-user counter so the
 *     audit trail can answer "how many times did @alice publish in
 *     window X?" later. Single-row UPSERT per (user, hour).
 *
 * Both throw `RateLimitError` on overage; the route handler maps
 * that to 429.
 */

import type { Env } from './env.ts';

export class RateLimitError extends Error {
  constructor(public bucket: string, public retryAfterSec: number) {
    super(`rate limit exceeded: ${bucket}`);
  }
}

async function kvIncrement(
  kv: KVNamespace,
  key: string,
  ttlSec: number,
  cap: number,
): Promise<void> {
  const cur = parseInt((await kv.get(key)) ?? '0', 10) || 0;
  if (cur >= cap) throw new RateLimitError(key, ttlSec);
  await kv.put(key, String(cur + 1), { expirationTtl: ttlSec });
}

export async function checkIpListPerMinute(env: Env, ip: string): Promise<void> {
  if (!ip) return;
  const cap = parseInt(env.RATE_PER_IP_LIST_PER_MINUTE, 10);
  if (!cap) return;
  await kvIncrement(env.COUNTERS, `cupboard:ip-list:${ip}`, 60, cap);
}

export async function checkUserReportHourly(env: Env, userId: number): Promise<void> {
  const cap = parseInt(env.RATE_PER_USER_REPORT_HOURLY, 10) || 10;
  await kvIncrement(env.COUNTERS, `cupboard:user-report:${userId}`, 3600, cap);
}

/**
 * Publish limit: durable in D1, hour-bucketed by floor(now_ms / 3_600_000).
 * UPSERT pattern so concurrent requests don't double-count.
 */
export async function checkAndRecordUserPublishHourly(
  env: Env,
  userId: number,
  now_ms: number,
): Promise<void> {
  const cap = parseInt(env.RATE_PER_USER_PUBLISH_HOURLY, 10) || 5;
  const window_start = Math.floor(now_ms / 3_600_000) * 3_600_000;
  const cur = await env.DB.prepare(
    'SELECT count FROM publish_rate_limit WHERE github_user_id = ? AND window_start = ?',
  )
    .bind(userId, window_start)
    .first<{ count: number }>();
  const next = (cur?.count ?? 0) + 1;
  if (next > cap) {
    throw new RateLimitError(`cupboard:user-publish:${userId}`, 3600);
  }
  await env.DB.prepare(
    `INSERT INTO publish_rate_limit (github_user_id, window_start, count)
       VALUES (?, ?, 1)
     ON CONFLICT(github_user_id, window_start) DO UPDATE SET count = count + 1`,
  )
    .bind(userId, window_start)
    .run();
}
