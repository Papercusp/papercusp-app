/**
 * Server-side feature-flag gate for API route handlers (runs in the Hono
 * host — `lib/endpoint-route/routes/**`).
 *
 * `gateApiRoute(req, key)` returns a 404 `Response` to short-circuit a
 * handler when the flag is off, or `null` when it's on (continue). Falls
 * back to FLAG_DEFAULTS[key] (false — a closed gate) when PostHog is
 * unreachable: closed is the safe state when we can't verify the flag.
 *
 * The former page-side `requireFlag()` (a Next Server-Component gate that
 * used `next/navigation`'s `notFound()`) was removed with the Next→Vite
 * migration — the SPA equivalent lives in
 * `apps/operator-vite/src/lib/require-flag.ts` (TanStack `notFound()` in a
 * route `beforeLoad`). See plan `finish-next-removal-2026-06-01`.
 */
import type { FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

import { resolveDistinctId } from './flag-distinct-id';
import './flag-bus';

export async function gateApiRoute(
  req: Request,
  key: FlagKey,
): Promise<Response | null> {
  const enabled = await getFlag(key, resolveDistinctId(req));
  if (enabled) return null;
  return new Response(
    JSON.stringify({ ok: false, reason: 'feature-disabled', flag: key }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}
