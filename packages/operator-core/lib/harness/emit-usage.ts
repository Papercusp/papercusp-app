/**
 * emitUsageEventBestEffort — the single seam every P-070 lifecycle call site
 * uses to record one contributor activity event.
 *
 * Two responsibilities the raw `emitUsageEvent` deliberately doesn't take on:
 *   1. Actor resolution — pulls { githubUserId, devicePubkey } from the local
 *      machine via the cached `resolveUsageActor`. If gh is unauthenticated the
 *      actor is null and the emit is skipped silently (no ledger row, no error).
 *   2. Best-effort — it NEVER throws. A usage-event write failure (PG down,
 *      keychain locked, gh hiccup) must not break the feature/PR/plan/run action
 *      it rides on. Failures route to `onError` (default: console.warn) and the
 *      call resolves cleanly.
 *
 * Call sites are therefore one-liners, e.g.:
 *   void emitUsageEventBestEffort(slug, 'feature_authored', { ref_id, payload });
 */
import {
  emitUsageEvent,
  type EmitUsageEventInput,
  type EmitDeps,
} from './usage-events';
import { resolveUsageActor, type UsageActor } from './usage-actor';
import type {
  UsageEventKind,
  UsageEventPayloadByKind,
} from './contributor-usage-event-types';

export interface EmitBestEffortDeps {
  resolveActor?: () => Promise<UsageActor | null>;
  emit?: (
    input: EmitUsageEventInput,
    deps?: EmitDeps,
  ) => Promise<{ event_id: string }>;
  /** Failure sink. Defaults to a console.warn naming the kind. */
  onError?: (err: unknown) => void;
}

export interface EmitBestEffortOpts<K extends UsageEventKind> {
  ref_id?: string | null;
  payload?: UsageEventPayloadByKind[K] | null;
  deps?: EmitBestEffortDeps;
}

function defaultOnError(kind: UsageEventKind, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
   
  console.warn(`[usage-events] best-effort emit '${kind}' failed: ${msg}`);
}

export async function emitUsageEventBestEffort<K extends UsageEventKind>(
  harnessSlug: string,
  kind: K,
  opts: EmitBestEffortOpts<K> = {},
): Promise<void> {
  const resolveActor = opts.deps?.resolveActor ?? resolveUsageActor;
  const emit = opts.deps?.emit ?? emitUsageEvent;
  try {
    const actor = await resolveActor();
    if (!actor) return; // no local identity → skip silently
    await emit({
      harness_slug: harnessSlug,
      github_user_id: actor.githubUserId,
      device_pubkey: actor.devicePubkey,
      kind,
      ref_id: opts.ref_id ?? null,
      payload: opts.payload ?? null,
    });
  } catch (err) {
    (opts.deps?.onError ?? ((e) => defaultOnError(kind, e)))(err);
  }
}
