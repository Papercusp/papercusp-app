/**
 * The pot settings-override write, shared by every surface that performs it
 * (learning-pot-scope-gate-2026-08-30, P-013).
 *
 * WHY THIS IS A MODULE AND NOT A SECOND COPY. D-011 established that a pot's
 * `budget` config is the SOURCE the scout cadence rebuilds its `blender:<pot>`
 * governor row from, which is what moved the budget control out of
 * /settings/pot-customization's JSON textarea and onto the per-pot learning
 * drawer. That gives the write TWO callers, and a mirrored `fetch` in the
 * second one is a code-describing copy of the first: the endpoint path, the
 * arg shape and the error convention would each drift independently. So both
 * callers import this, and the REST fallback exists exactly once.
 *
 * It is the FALLBACK, not the transport: `useSyncMutate('hive.overrideSet', …)`
 * routes through @papercusp/sync, and this runs only on the degraded path.
 */

/** One row of the `hive.overrides` sync query. */
export interface HiveOverrideRow {
  kind: 'prompt' | 'config';
  name: string;
  value: unknown;
}

export interface HiveOverrideSetArgs {
  potSlug: string;
  kind: 'prompt' | 'config';
  name: string;
  /** A partial JSON delta for `config`, the prose string for `prompt`. */
  value: unknown;
}

export interface HiveOverrideSetResp {
  ok: boolean;
  error?: string;
  cleared?: boolean;
  /** scout config only: the accepted override + resolved config + dropped keys. */
  accepted?: unknown;
  resolved?: unknown;
  dropped?: string[];
}

/** REST fallback the sync-mutate hook calls (every transport on desktop is SSE). */
export async function hiveOverrideSetRest(
  args: HiveOverrideSetArgs,
): Promise<HiveOverrideSetResp> {
  const r = await fetch('/api/agent-mcp/pot-override-set', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let data: HiveOverrideSetResp = { ok: false };
  try {
    data = JSON.parse(text) as HiveOverrideSetResp;
  } catch {
    /* non-JSON */
  }
  if (!r.ok || data.ok === false) {
    throw new Error(data.error ?? `HTTP ${r.status}`);
  }
  return data;
}

/**
 * The pot's `budget` config delta, picked out of an `hive.overrides` result.
 *
 * Returns `null` when the pot has no budget override at all — which is NOT the
 * same as an empty object, and the drawer says so: no override means every key
 * runs at the engine default.
 */
export function budgetOverrideOf(
  rows: readonly HiveOverrideRow[] | null | undefined,
): unknown {
  if (!Array.isArray(rows)) return null;
  for (const r of rows) {
    if (r.kind === 'config' && r.name === 'budget') return r.value;
  }
  return null;
}
