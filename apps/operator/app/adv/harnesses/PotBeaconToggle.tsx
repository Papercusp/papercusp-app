'use client';

/**
 * PotBeaconToggle — the pot's live-status-beacon publish consent, as one compact
 * pot-bar pill.
 *
 * WHY it lives here and not in the Work tab (owner ask 2026-07-27): the Work tab's
 * hive header (HiveHeaderStrip) restated the pot bar's identity + Share cluster one
 * row below it, so it was deleted. This toggle was the ONLY control in that strip
 * with no second home anywhere in the UI, so it moved UP onto the pot bar — which
 * renders on every pot-scoped tab (POT_BAR_TAB_IDS), making the beacon reachable
 * from all of them instead of only from Work.
 *
 * Read path: the canonical ID-scoped sync query (`hive.beaconConsent`), so the pill
 * has one authoritative cache + push path and never disagrees with the publish flow.
 * The injected `getBeaconConsent` / `setBeaconConsent` props are a TEST SEAM only —
 * passing a reader switches the read off the sync query onto the injected fn.
 *
 * Only a formal Pot home (`harness_kind: 'hive'`) can publish a beacon, so the
 * CALLER gates on that; this component assumes it is only mounted for one.
 *
 * B-07 / C-2 lineage: the beacon is auto-ON for a public pot and auto-OFF for a
 * private one at creation (EntryGithubUrlForm has no checkbox, only a note). This
 * pill is the standing after-the-fact control that note points at.
 */

import { useEffect, useState } from 'react';
import { Radio } from 'lucide-react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Tooltip } from '@/app/harness/Tooltip';
import { useLexicon } from '@/lib/useLexicon';

export interface HiveBeaconToggleProps {
  /** The pot (hive home) slug whose beacon consent this toggles. */
  potSlug: string;
  /** TEST SEAM — read current consent (absent = OFF). Default: the sync query. */
  getBeaconConsent?: (potSlug: string) => Promise<boolean>;
  /** TEST SEAM — write consent. Default POSTs /api/discovery/beacon-consent. */
  setBeaconConsent?: (
    potSlug: string,
    consent: boolean,
  ) => Promise<{ ok: boolean; consent?: boolean; error?: string }>;
}

export async function defaultGetBeaconConsent(potSlug: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/discovery/beacon-consent?potId=${encodeURIComponent(potSlug)}`);
    const body = (await res.json().catch(() => ({}))) as { consent?: boolean };
    return res.ok && body.consent === true;
  } catch {
    return false;
  }
}

export async function defaultSetBeaconConsent(
  potSlug: string,
  consent: boolean,
): Promise<{ ok: boolean; consent?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/discovery/beacon-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ potId: potSlug, consent }),
    });
    const body = (await res.json().catch(() => ({}))) as { consent?: boolean; error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, consent: body.consent };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default function PotBeaconToggle({
  potSlug,
  getBeaconConsent = defaultGetBeaconConsent,
  setBeaconConsent = defaultSetBeaconConsent,
}: HiveBeaconToggleProps) {
  const t = useLexicon();
  const potLower = t('pot', { lower: true });
  // An injected reader is the test seam; production reads the sync query.
  const readInjected = getBeaconConsent !== defaultGetBeaconConsent;
  const beaconQuery = useSyncQuery<{ potId: string; consent: boolean }>({
    queryName: 'hive.beaconConsent',
    args: { potId: potSlug },
    enabled: Boolean(potSlug) && !readInjected,
  });

  const [consent, setConsent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!potSlug || !readInjected) return;
    let alive = true;
    void getBeaconConsent(potSlug)
      .then((next) => {
        if (alive) setConsent(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [potSlug, readInjected, getBeaconConsent]);

  useEffect(() => {
    if (readInjected || !beaconQuery.data?.[0]) return;
    setConsent(beaconQuery.data[0].consent === true);
  }, [readInjected, beaconQuery.data]);

  if (!potSlug) return null;

  const on = consent === true;

  async function toggle(): Promise<void> {
    if (busy) return;
    const next = !on;
    setBusy(true);
    const res = await setBeaconConsent(potSlug, next);
    setBusy(false);
    if (!res.ok) {
      toast.error(`beacon: ${res.error ?? 'failed'}`);
      return;
    }
    setConsent(res.consent ?? next);
    if (!readInjected) beaconQuery.invalidate();
  }

  return (
    <Tooltip
      label={`Publish a live status beacon for ${potSlug} — active agents, queue depth, current focus — on the ${potLower} directory, so collaborators can see it is alive. Recommended for ${potLower}s you want people to find.`}
    >
      <button
        type="button"
        className={`pc-pot-beacon${on ? ' pc-pot-beacon--on' : ''}`}
        data-testid="pot-beacon-toggle"
        aria-label="Live status beacon"
        aria-pressed={on}
        disabled={busy}
        onClick={() => void toggle()}
      >
        <Radio size={13} aria-hidden />
        Beacon {busy ? '…' : on ? 'on' : 'off'}
        <style>{`
          .pc-pot-beacon {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 4px 10px;
            border: 1px solid var(--border, color-mix(in oklab, #7dd3fc, transparent 78%));
            border-radius: 999px;
            background: var(--bg-2, rgba(255, 255, 255, 0.045));
            color: var(--fg-mute, #7f9bb4);
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0;
            cursor: pointer;
            flex-shrink: 0;
          }
          .pc-pot-beacon:hover:not(:disabled) {
            color: var(--fg, #e7f7ff);
            border-color: var(--accent, #38bdf8);
          }
          .pc-pot-beacon--on {
            border-color: color-mix(in oklab, #34d399, transparent 60%);
            background: color-mix(in oklab, #34d399, transparent 86%);
            color: #86efac;
          }
          .pc-pot-beacon:disabled { opacity: 0.55; cursor: default; }
        `}</style>
      </button>
    </Tooltip>
  );
}
