/**
 * useAccountOverride — shared client logic for the owner's session-now account
 * override (accounts-pool-tab-2026-06-15 P-004): subscribe through data sync, toggle force/exclude
 * per account, clear it. Backed by su-81fe4's GET/POST
 * /api/admin/deploy-accounts/session-override (hive_settings, fail-soft). Each POST
 * returns the new override (no refetch) and invalidates accounts.pool (cards refresh).
 *
 * Consumed by BOTH the AdvShell Accounts tab (per-card toggles) and the left-sidebar
 * Accounts tab next to Queen (the Queen-adjacent owner-steering lever, P-005).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { operatorUi } from '../seam';

export interface AccountOverride {
  forcedAccounts: string[];
  excludeAccounts: string[];
  /**
   * The Claude pool account standing in for this machine's own ~/.claude login
   * (default-deploy-account-2026-08-08 P-006). Absent ⇒ the local login.
   *
   * A different AXIS from the two lists: they restrict what may be selected, this only
   * replaces the implicit fallback — which is why `overrideActive` below still ignores it.
   */
  defaultAccountId?: string;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useAccountOverride() {
  const [override, setOverride] = useState<AccountOverride | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const { data: overrideRows, invalidate: invalidateOverride } = useSyncQuery<AccountOverride>({
    queryName: 'accounts.sessionOverride',
    staleTime: 30_000,
  });

  useEffect(() => {
    if (overrideRows?.[0]) setOverride(overrideRows[0]);
  }, [overrideRows]);

  // Optimistic by design: the desktop ships on the SSE transport, where
  // @papercusp/sync's useSyncMutate has no Zero client and so can't apply
  // optimistically (its optimistic path is WebSocket/Zero-only, and Zero is
  // retired) — it would degrade to this same REST POST. So we apply the predicted
  // override locally for INSTANT feedback, then reconcile with the server's
  // authoritative response (or roll back on failure). The accounts.pool sync
  // query still refreshes the cards over SSE when the server invalidates.
  const patchOverride = useCallback(
    async (
      patch: {
        forcedAccounts?: string[];
        excludeAccounts?: string[];
        /** null CLEARS the default; omitted leaves it untouched. */
        defaultAccountId?: string | null;
        clear?: boolean;
      },
      optimistic?: AccountOverride,
    ) => {
      const prev = override;
      const { apiFetch, toast } = operatorUi();
      if (optimistic) setOverride(optimistic); // instant — don't wait on the round-trip
      setOverrideBusy(true);
      try {
        const res = await apiFetch('/api/admin/deploy-accounts/session-override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const j = (await res.json()) as { ok?: boolean; error?: string; override?: AccountOverride };
        if (!res.ok || !j.ok) throw new Error(j.error || 'override failed');
        setOverride(j.override ?? { forcedAccounts: [], excludeAccounts: [] }); // reconcile with server truth
        invalidateOverride();
        if (patch.clear) toast.success('Cleared the account override');
      } catch (e) {
        if (optimistic) setOverride(prev); // roll back the optimistic apply
        toast.error(`Override failed: ${errMsg(e)}`);
      } finally {
        setOverrideBusy(false);
      }
    },
    [invalidateOverride, override],
  );

  const forced = useMemo(() => new Set(override?.forcedAccounts ?? []), [override]);
  const excluded = useMemo(() => new Set(override?.excludeAccounts ?? []), [override]);
  const overrideActive = forced.size > 0 || excluded.size > 0;

  // Each toggle computes the FULL predicted override (the changed axis + the untouched
  // one) and passes it as the optimistic value, so the lever flips instantly; the POST
  // still carries only the changed field (the server merges + echoes the truth back).
  const toggleForce = useCallback(
    (id: string) => {
      const nextForced = forced.has(id) ? [...forced].filter((x) => x !== id) : [...forced, id];
      void patchOverride({ forcedAccounts: nextForced }, { forcedAccounts: nextForced, excludeAccounts: [...excluded] });
    },
    [forced, excluded, patchOverride],
  );
  const toggleExclude = useCallback(
    (id: string) => {
      const nextExcluded = excluded.has(id) ? [...excluded].filter((x) => x !== id) : [...excluded, id];
      void patchOverride({ excludeAccounts: nextExcluded }, { forcedAccounts: [...forced], excludeAccounts: nextExcluded });
    },
    [forced, excluded, patchOverride],
  );
  const clearOverride = useCallback(
    () => void patchOverride({ clear: true }, { forcedAccounts: [], excludeAccounts: [] }),
    [patchOverride],
  );

  const defaultAccountId = override?.defaultAccountId;
  /**
   * Nominate (or clear, with null) the default account. Not optimistic, unlike the two
   * levers above: the server VALIDATES this against the pool and can legitimately reject it
   * (unknown id, Codex account), so flipping the star instantly would show a state the server
   * is about to refuse. The force/exclude toggles are free to be optimistic precisely because
   * they cannot fail that way.
   */
  const setDefaultAccount = useCallback(
    (id: string | null) => void patchOverride({ defaultAccountId: id }),
    [patchOverride],
  );

  return {
    override,
    overrideBusy,
    forced,
    excluded,
    overrideActive,
    toggleForce,
    toggleExclude,
    clearOverride,
    patchOverride,
    defaultAccountId,
    setDefaultAccount,
  };
}
