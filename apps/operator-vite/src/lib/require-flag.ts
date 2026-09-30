import { notFound } from '@tanstack/react-router';
import type { FlagKey } from '@papercusp/flags';
import { FLAG_DEFAULTS } from '@papercusp/flags';
import { getFlagSnapshot, loadFlags } from '@papercusp/flags/client';

/**
 * SPA-flags port — the operator-vite equivalent of
 * `apps/operator/lib/require-flag.ts`'s `requireFlag()`.
 *
 * The Next version was a Server Component gate: it resolved the flag
 * server-side and called `next/navigation`'s `notFound()`. Under Vite/SPA
 * there is no server render, but `@papercusp/flags/client` already does a
 * real client-side fetch (`loadFlags()`) — the same path `useFlag()` uses.
 * So the gate becomes a TanStack Router `beforeLoad` hook:
 *
 *   export const Route = createFileRoute('/design/')({
 *     beforeLoad: () => requireFlag(FLAGS.DESIGN),
 *     component: DesignClient,
 *   });
 *
 * Behavior parity with the Next gate:
 *   - flag on  → resolves, route renders.
 *   - flag off → `throw notFound()`, the root route's `notFoundComponent`
 *     renders (same observable result as Next's `notFound()`).
 *   - flags unreachable → `loadFlags()` rejects; `getFlagSnapshot()` then
 *     returns `FLAG_DEFAULTS`. A closed gate is the safe state — identical
 *     to the Next version's "closed gate when PostHog is unreachable".
 *
 * `loadFlags()` is idempotent + cached in `@papercusp/flags/client`, so
 * calling it from every gated route's `beforeLoad` costs one fetch total.
 */
export async function requireFlag(key: FlagKey): Promise<void> {
  await loadFlags().catch(() => {
    // network failure → fall through to FLAG_DEFAULTS via getFlagSnapshot
  });
  const snapshot = getFlagSnapshot();
  const enabled = snapshot.flags[key] ?? FLAG_DEFAULTS[key];
  if (!enabled) throw notFound();
}
