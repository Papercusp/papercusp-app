'use client';

/**
 * useHarnessClaimStatus — Phase 8 P-069 (a/b/e) claim-status data for the
 * live `/adv` shell.
 *
 * One-shot REST read of `GET /api/harness/:slug/claim-status` (the binding-
 * cache-backed claim state, server-resolved against the local viewer) plus
 * a `claim()` mutation that POSTs `/api/harness/binding/claim` (P-068's
 * `claimBinding`). A structured permission rejection surfaces as a toast
 * AND is returned to the caller so the header can show an inline message.
 *
 * No polling — claim status changes rarely (a deliberate maintainer action);
 * `refresh()` re-pulls after a successful claim.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

export type ClaimStatus = 'unclaimed' | 'claimed' | 'stale' | 'superseded';

export interface ClaimStatusData {
  status: ClaimStatus;
  binding_id: string | null;
  claimant_login: string | null;
  claimants: Array<{ github_user_id: number; login: string | null }>;
  provisional_owner_login: string | null;
  viewer_is_provisional_owner: boolean;
  viewer_is_claimant: boolean;
  viewer_can_claim: boolean;
  superseded_by_href: string | null;
  summary: string;
}

/** Map a claim-route error body to a human message. */
function claimErrorMessage(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: string; actual?: string; required?: string; reason?: string };
  switch (b.error) {
    case 'CLAIM_PERMISSION_DENIED':
      return `You don't have permission to claim this harness (your GitHub access is "${b.actual ?? 'none'}"; ${b.required ?? 'maintain or admin'} required).`;
    case 'BINDING_NOT_FOUND':
      return 'No shared binding exists for this harness yet — share it first.';
    case 'BINDING_NOT_CLAIMABLE':
      return `This binding can't be claimed (${b.reason ?? 'not claimable'}).`;
    case 'GITHUB_REPO_PRIVATE_NO_ACCESS':
      return "You don't have access to the bound GitHub repository.";
    case 'GITHUB_API_RATE_LIMIT':
      return 'GitHub rate limit hit — try again shortly.';
    case 'GITHUB_API_DOWN':
      return 'GitHub is unreachable right now — try again shortly.';
    default:
      return `Claim failed (HTTP ${status}).`;
  }
}

export interface UseHarnessClaimStatusResult {
  data: ClaimStatusData | null;
  loading: boolean;
  error: string | null;
  /** Attempt to claim. Returns true on success; surfaces a toast on failure. */
  claim: () => Promise<boolean>;
  claiming: boolean;
  refresh: () => void;
}

export function useHarnessClaimStatus(slug: string): UseHarnessClaimStatusResult {
  const [data, setData] = useState<ClaimStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!slug) {
      setData(null);
      return;
    }
    let cancel = false;
    setError(null);
    fetch(`/api/harness/${encodeURIComponent(slug)}/claim-status`)
      .then((r) => (r.ok ? (r.json() as Promise<ClaimStatusData>) : Promise.reject(new Error(`claim-status ${r.status}`))))
      .then((j) => {
        if (!cancel) setData(j);
      })
      .catch((e: Error) => {
        if (!cancel) setError(e.message);
      });
    return () => {
      cancel = true;
    };
  }, [slug, tick]);

  const claim = useCallback(async (): Promise<boolean> => {
    if (!data?.binding_id) {
      toast.error('No shared binding to claim — share this harness first.');
      return false;
    }
    setClaiming(true);
    try {
      const res = await fetch('/api/harness/binding/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding_id: data.binding_id }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const msg = claimErrorMessage(res.status, body);
        setError(msg);
        toast.error(msg);
        return false;
      }
      toast.success('You claimed this harness.');
      setError(null);
      refresh();
      return true;
    } catch (e) {
      const msg = `Claim failed: ${e instanceof Error ? e.message : String(e)}`;
      setError(msg);
      toast.error(msg);
      return false;
    } finally {
      setClaiming(false);
    }
  }, [data?.binding_id, refresh]);

  return { data, loading: data === null && !error, error, claim, claiming, refresh };
}
