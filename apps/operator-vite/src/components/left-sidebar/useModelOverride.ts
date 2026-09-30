/**
 * useModelOverride — read/write a single agent's SESSION model override
 * (model-override-sidebar-2026-06-23), shared by the 🛡 Sentinel and 👁 Overwatch
 * tabs. Reads `hive.steering.modelOverrides[role]` (the HOME hive's row) and writes
 * via `pot:set-steering` (which invalidates `hive.steering`, so the read refreshes;
 * for the Sentinel it ALSO projects the spec to ~/.papercusp/sentinel-model for the
 * dock wrapper). Writes MERGE — setting one role preserves the other's override.
 *
 * Like the 👑 Queen tab, this targets the workspace's HOME hive: `hive.steering`
 * can return MULTIPLE rows, so we resolve the home slug (first kind:'hive' project,
 * else the first steering row) via `resolveHomeHive` and BOTH read that row AND pass
 * `hive: <home>` to the write — `pot:set-steering` defaults to hive '*' otherwise,
 * which is not a real Hive and the write is rejected (verified live 2026-06-25).
 */
import { useCallback, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { resolveHomeHive } from './resolve-home-pot';

interface SteeringRow {
  slug: string;
  /** Server-stamped home-queen marker. The row HAS it on the wire — omitting it
   *  here hid it from `resolveHomeHive`, which reads exactly this field to pick the
   *  home hive (see MugTab). Declared so the type matches what we actually receive. */
  isHome?: boolean;
  modelOverrides?: Record<string, string> | null;
}

interface LiteProject {
  slug: string;
  parent_slug?: string | null;
  harness_kind?: string | null;
}

async function runSetSteering(args: Record<string, unknown>): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pot:set-steering', args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; error?: string; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? payload.error ?? 'pot:set-steering refused');
}

export interface ModelOverrideState {
  /** The role's current session override spec (`model[:effort]`), or null ⇒ default. */
  override: string | null;
  busy: boolean;
  error: string | null;
  /** Set the role's spec, or null to clear. Merges so the other role is preserved. */
  setOverride: (spec: string | null) => void;
}

export function useModelOverride(role: string, enabled = true): ModelOverrideState {
  const steeringQ = useSyncQuery<SteeringRow>({ queryName: 'hive.steering', args: {}, staleTime: 15_000, enabled });
  const projectsQ = useSyncQuery<LiteProject>({
    queryName: 'harnessProjects.lite',
    args: { includeHiveHomes: true },
    staleTime: 60_000,
    enabled,
  });
  const rows = steeringQ.data ?? [];
  const home = resolveHomeHive(projectsQ.data ?? [], rows);
  const current = (rows.find((r) => r.slug === home) ?? rows[0])?.modelOverrides ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setOverride = useCallback(
    (spec: string | null) => {
      // The home pot comes from the (async) harnessProjects.lite query. A click
      // before it resolves would send pot:'' — which `pot:set-steering` rejects
      // ("no Pot ''"). Guard like the Mug tab (which bails with an error on
      // empty home) so a too-fast click is a clear retry, not a confusing failure.
      if (!home) {
        setError('Home pot still loading — try again in a moment.');
        return;
      }
      setBusy(true);
      setError(null);
      // Merge so a peer role's override (e.g. overwatch when writing sentinel) survives.
      const merged: Record<string, string> = { ...(current ?? {}) };
      if (spec && spec.trim()) merged[role] = spec.trim();
      else delete merged[role];
      const next = Object.keys(merged).length > 0 ? merged : null;
      // pot: home is REQUIRED — set-steering otherwise resolves no home pot and
      // refuses with "Pass `pot` (or set PAPERCUSP_POT_HOME_SLUG)".
      void runSetSteering({ pot: home, modelOverrides: next })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setBusy(false));
    },
    [current, role, home],
  );

  return { override: current?.[role] ?? null, busy, error, setOverride };
}
