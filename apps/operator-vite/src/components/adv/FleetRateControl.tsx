/**
 * FleetRateControl — the /adv top-bar fleet rate/usage/max control
 * (rate-limit-layer-v2-2026-06-05 P-013, D-004/D-005).
 *
 * One strip: usage% (ONLY where a provider ceiling is known — hidden, never
 * fabricated, on subscription-only pools), recent $spend, LIVE fleet-wide agent
 * count (presence), and the GOVERNED pair — rate-governed in-flight vs
 * AIMD-effective vs the EDITABLE governed cap (`maxSimultaneousAgents`). Live
 * and governed are deliberately SEPARATE slots: they count different populations
 * (owner-flagged "81/8" confusion — overview-tab-expansion-2026-07-20 P-005).
 * Edits commit on blur/Enter → PUT
 * /api/operator/rate-limit-config, which persists to PG and propagates live
 * (governor global gate + dispatcher honor it with zero restart).
 *
 * Data: GET /api/operator/rate-limit-config → `{ config, status }` (the
 * `buildFleetRateStatus` read-model), light 8s poll — the same idiom as the
 * Overview tiles (no global sync hook on this surface yet). The numeric draft
 * is `useState` by design (mid-edit form draft, per the nuqs policy).
 *
 * Consumed by AdvOverviewTab's top-bar (Brief 23 reserved the slot).
 */
import { useEffect, useRef, useState } from 'react';

export interface FleetRateConfigWire {
  maxSimultaneousAgents: number;
  concurrencyFloor: number;
}

export interface FleetRateStatusWire {
  config: FleetRateConfigWire;
  fleet: { cap: number; inFlight: number; effective: number; floor: number; liveAgents?: number };
  buckets: Array<{ key: string; paused: boolean; pausedUntil: string | null }>;
  usage: { spendUsd: number; calls: number; buckets: Array<{ key: string; usagePct: number | null }> };
}

/** Headline usage%: the WORST (max) bucket usage% across buckets with a known
    ceiling; null when no bucket exposes one (subscription paths) — never fabricate. */
export function headlineUsagePct(usage: FleetRateStatusWire['usage'] | undefined): number | null {
  if (!usage) return null;
  let worst: number | null = null;
  for (const b of usage.buckets) {
    if (b.usagePct === null || !Number.isFinite(b.usagePct)) continue;
    if (worst === null || b.usagePct > worst) worst = b.usagePct;
  }
  return worst;
}

/** "$1.23" / "$0.0042" / "$0" — compact spend, more precision under a cent. */
export function fmtSpend(spendUsd: number | undefined): string {
  if (spendUsd === undefined || !Number.isFinite(spendUsd) || spendUsd <= 0) return '$0';
  if (spendUsd < 0.01) return `$${spendUsd.toFixed(4)}`;
  return `$${spendUsd.toFixed(2)}`;
}

/** "81" — the REAL fleet-wide live-agent count (`liveAgents`, from coord_presence —
    EI-18106936190883400). Rendered ALONE, never over the governed cap: the old
    "liveAgents / cap" juxtaposition read as "81 of 8" nonsense (owner-flagged twice,
    overview-tab-expansion P-005) because the two numbers describe DIFFERENT
    populations — live counts every agent (mostly ungoverned su/CLI sessions), the
    cap only bounds rate-governed dispatches. */
export function fmtLiveAgents(fleet: FleetRateStatusWire['fleet'] | undefined): string {
  if (!fleet || !Number.isFinite(fleet.liveAgents)) return '—';
  return String(fleet.liveAgents);
}

/** "0 / 8" (rate-GOVERNED dispatches in flight / the editable `maxSimultaneousAgents`
    cap) — "0 / eff 6 / 8" when AIMD adapted effective concurrency below the cap.
    This pair is population-consistent: both sides count governed dispatches only. */
export function fmtGoverned(fleet: FleetRateStatusWire['fleet'] | undefined): string {
  if (!fleet) return '—';
  const eff = Number.isFinite(fleet.effective) ? fleet.effective : fleet.cap;
  const cap = Number.isFinite(fleet.cap) ? String(fleet.cap) : '∞';
  const n = Number.isFinite(fleet.inFlight) ? fleet.inFlight : 0;
  return eff < fleet.cap ? `${n} / eff ${eff} / ${cap}` : `${n} / ${cap}`;
}

/** Count of currently-paused governor buckets (the "rate-limited right now" signal). */
export function pausedCount(buckets: FleetRateStatusWire['buckets'] | undefined): number {
  return (buckets ?? []).filter((b) => b.paused).length;
}

/** Parse + clamp a max-agents draft. Null = not a valid edit (don't commit). */
export function parseMaxDraft(draft: string, ceiling = 64): number | null {
  const n = Number(draft.trim());
  if (!Number.isInteger(n) || n < 1 || n > ceiling) return null;
  return n;
}

const POLL_MS = 8_000;

export default function FleetRateControl() {
  const [status, setStatus] = useState<FleetRateStatusWire | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Mid-edit draft (useState by design — form draft, not URL state). null = not editing,
  // display tracks the live value.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = useRef(false);
  // Escape-cancel marker. Escape calls setDraft(null) and then blur(), but
  // blur() dispatches its event SYNCHRONOUSLY — commit() runs with the stale
  // pre-cancel `draft` closure and would PUT the value Escape meant to throw
  // away. The ref is read at commit time, so the cancel actually cancels.
  const cancelled = useRef(false);

  useEffect(() => {
    let cancel = false;
    const pull = () => {
      fetch('/api/operator/rate-limit-config', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d: { config: FleetRateConfigWire; status: FleetRateStatusWire }) => {
          if (cancel) return;
          setStatus(d.status ?? null);
          setErr(null);
        })
        .catch((e) => !cancel && setErr(String((e as Error)?.message ?? e)));
    };
    pull();
    const t = setInterval(pull, POLL_MS);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  const commit = async () => {
    editing.current = false;
    if (cancelled.current) {
      cancelled.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const next = parseMaxDraft(draft);
    setDraft(null);
    if (next === null || next === status?.config.maxSimultaneousAgents) return;
    setSaving(true);
    try {
      const r = await fetch('/api/operator/rate-limit-config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ maxSimultaneousAgents: next }),
      });
      if (r.ok) {
        const d = (await r.json()) as { config: FleetRateConfigWire };
        setStatus((s) => (s ? { ...s, config: d.config, fleet: { ...s.fleet, cap: d.config.maxSimultaneousAgents } } : s));
      }
    } catch {
      /* next poll restores truth */
    } finally {
      setSaving(false);
    }
  };

  const usagePct = headlineUsagePct(status?.usage);
  const paused = pausedCount(status?.buckets);
  const maxValue = draft ?? (status ? String(status.config.maxSimultaneousAgents) : '');

  return (
    <div
      className="pc-overview__rate"
      title={
        err
          ? `Fleet rate — unreachable: ${err}`
          : 'Fleet rate / usage — edit max to throttle or open up the fleet (live, no restart)'
      }
    >
      {/* Usage% only renders when a provider actually exposes a rate-limit ceiling
          (API-key buckets). Subscription accounts never do, so on a subscription-only
          pool this slot used to permanently read "usage n/a" — pure confusion
          (owner-flagged, overview-tab-expansion P-005). Hidden instead of fabricated. */}
      {usagePct !== null && (
        <span
          className="pc-overview__rate-slot"
          title="Worst provider rate-limit usage% across buckets that expose a ceiling (API-key paths only — subscription accounts expose none)"
        >
          <span className="pc-overview__rate-k">usage</span>
          <span className="pc-overview__rate-v">{`${Math.round(usagePct)}%`}</span>
        </span>
      )}
      <span className="pc-overview__rate-slot" title="LLM spend over the last hour (usage telemetry, all accounts)">
        <span className="pc-overview__rate-k">spend 1h</span>
        <span className="pc-overview__rate-v">{fmtSpend(status?.usage?.spendUsd)}</span>
      </span>
      <span
        className="pc-overview__rate-slot"
        title="Agents alive fleet-wide right now (fresh presence heartbeats) — includes the interactive su/CLI sessions the spawn governor does not manage, so this is NOT bounded by the governed cap"
      >
        <span className="pc-overview__rate-k">live</span>
        <span className="pc-overview__rate-v">{fmtLiveAgents(status?.fleet)}</span>
      </span>
      <span
        className="pc-overview__rate-slot"
        title="Rate-GOVERNED dispatches in flight vs the editable cap — the cap throttles governed spawns (Mug/fleet placements) only, never the interactive sessions counted under LIVE"
      >
        <span className="pc-overview__rate-k">governed</span>
        <span className="pc-overview__rate-v">{fmtGoverned(status?.fleet)}</span>
      </span>
      <span className="pc-overview__rate-slot">
        <label
          className="pc-overview__rate-k"
          htmlFor="pc-fleet-max"
          title="maxSimultaneousAgents — hard cap on simultaneous rate-governed dispatches (edit commits live: persists + propagates, no restart). Does not limit interactive su sessions."
        >
          governed cap
        </label>
        <input
          id="pc-fleet-max"
          className="pc-overview__rate-input"
          type="number"
          min={1}
          max={64}
          value={maxValue}
          disabled={!status || saving}
          onFocus={() => {
            editing.current = true;
            setDraft(status ? String(status.config.maxSimultaneousAgents) : '');
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              cancelled.current = true;
              setDraft(null);
              editing.current = false;
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </span>
      {paused > 0 && (
        <span className="pc-overview__rate-paused" title="Governor buckets currently rate-limit paused">
          {paused} paused
        </span>
      )}
      <style>{`
        .pc-overview__rate { display: inline-flex; align-items: center; gap: 16px; }
        .pc-overview__rate-slot { display: inline-flex; flex-direction: column; gap: 1px; }
        .pc-overview__rate-k {
          font-size: 9px; font-weight: 760; letter-spacing: 0; text-transform: uppercase;
          color: var(--fg-mute, #7f9bb4);
        }
        .pc-overview__rate-v {
          font-size: 16px; font-weight: 760; color: var(--fg, #e7f7ff);
          font-variant-numeric: tabular-nums; line-height: 1.1;
        }
        .pc-overview__rate-input {
          width: 52px; font-size: 15px; font-weight: 760; line-height: 1.1;
          font-variant-numeric: tabular-nums;
          color: var(--fg, #e7f7ff); background: transparent;
          border: 1px solid var(--border, #24435c); border-radius: 4px; padding: 0 4px;
        }
        .pc-overview__rate-input:focus { outline: none; border-color: var(--accent, #57b3ff); }
        .pc-overview__rate-paused {
          font-size: 10px; font-weight: 760; letter-spacing: 0; text-transform: uppercase;
          color: var(--warn, #ffb454); border: 1px solid currentColor; border-radius: 4px;
          padding: 1px 6px; align-self: center;
        }
      `}</style>
    </div>
  );
}
