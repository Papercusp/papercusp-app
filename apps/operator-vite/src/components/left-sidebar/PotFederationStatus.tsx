/**
 * PotFederationStatus — Brief M / G-004: the desktop's first LIVE federation
 * status surface, mounted in the always-visible left-sidebar Hives tab.
 *
 * Before this the desktop had member counts + a declared-visibility badge but NO
 * way to see "is my hive reaching peers / is my substrate live" — so a user who
 * published to 0 peers (the G-001 stranded-publish case) had no corrective in-app
 * signal (findings-G G-004). Push-driven via the `network.federationStatus` sync
 * query (data-sync-push-completion P-009 — the same composition the
 * /api/discovery/federation-status loopback GET serves), it renders the HONEST
 * signals available today.
 *
 * HONESTY CONTRACT ("the UI never lies" — the brief's whole point):
 *   - "reach" is the hive's ANNOUNCE/discovery topic peer count (who can FIND it),
 *     NOT content-replication peers — labeled as such; a 0-peer published hive is
 *     shown as "broadcasting into the void", never hidden or dressed as "synced".
 *   - A private hive shows "private — not announced" (it never announces), NOT
 *     "0 peers" (which would imply a failed reach).
 *   - The substrate line is install-wide local boot health, NOT a per-peer sync
 *     claim.
 *   - EI-1599 (composes onto Brief H/A-002): `contentPeers` / `lastContentSyncMs`
 *     are the TRUE per-hive content-replication signal — peers whose
 *     content-announce channel is open on THIS hive's own content topic right
 *     now (contentSyncLabel below), distinct from "reach" (discovery only) and
 *     from the install-wide substrate/drain lines. `contentPeers === undefined`
 *     (an older payload shape) renders NOTHING for this line rather than
 *     guessing — silence over a fabricated claim.
 */
import { Radio } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';
import RailSection from './RailSection';

export interface FedHive {
  potId: string;
  title: string;
  visibility: 'public' | 'invite' | 'private';
  memberCount: number;
  reachablePeers: number;
  /** EI-1599: TRUE content-replication peer count on this hive's own content
   *  topic (not discovery/reach). Optional so an older route response (or a
   *  test fixture) without it still renders — the label fn treats `undefined`
   *  as "not reported" and renders nothing, never a fabricated 0. */
  contentPeers?: number;
  /** EI-1599: ms-epoch of the last content-sync activity seen on this hive's
   *  content topic, or `null` if none yet / no minted identity. */
  lastContentSyncMs?: number | null;
}
/** Install-wide drain (SYNC) health — EI-1618/EI-1599. Optional so an older route
 *  response (or a test fixture) without it still renders. */
export interface FedDrain {
  /** Booted harnesses whose outbox has rows captured-but-not-federating past the stall lag. */
  stalledHarnesses: number;
  /** Largest undrained row count across the stalled harnesses. */
  worstUndrainedCount: number;
  /** Oldest undrained age (ms) across the stalled harnesses; null when none stalled. */
  worstOldestUndrainedAgeMs: number | null;
}
export interface FedStatus {
  ok: boolean;
  substrate: {
    active: boolean;
    bootedHarnesses: number;
    healthy: number;
    booting: number;
    degraded: number;
    drain?: FedDrain;
  };
  hives: FedHive[];
}

/** Honest reach copy for one owned hive — the honesty core, pure + exported for tests. */
export function reachLabel(h: Pick<FedHive, 'visibility' | 'reachablePeers'>): string {
  if (h.visibility === 'private') return 'private — not announced';
  if (h.reachablePeers > 0) {
    return `discoverable to ${h.reachablePeers} peer${h.reachablePeers === 1 ? '' : 's'}`;
  }
  // Announced (public/invite) but nobody on the topic — the honest stranded state
  // (mirrors SharePotForm's 0-peer copy). NEVER "synced" / "0 peers connected".
  return 'no peers connected yet — broadcasting into the void';
}

/** `123s`/`45m`/`6h`/`3d` — mirrors the short age idiom used elsewhere in this
 *  rail (e.g. GitClient.tsx); local so this file has no new shared dependency. */
function ageShort(ms: number): string {
  const d = Math.max(0, ms);
  if (d < 60_000) return `${Math.round(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

/**
 * Honest per-hive content-REPLICATION line (EI-1599, composes onto Brief H/A-002).
 * Distinct from `reachLabel` (discovery/announce reach) — this counts peers whose
 * content-announce channel is open on THIS hive's own content topic right now,
 * i.e. actually syncing hive content, not merely able to find it.
 *
 * Returns `null` (render nothing) when `contentPeers` is `undefined` — an older
 * route/resolver payload without the field — rather than fabricating a 0; that
 * silence is the honest choice, matching this surface's whole contract.
 */
export function contentSyncLabel(h: Pick<FedHive, 'contentPeers' | 'lastContentSyncMs'>): string | null {
  if (h.contentPeers === undefined) return null;
  const lastSuffix = h.lastContentSyncMs != null ? ` · last synced ${ageShort(Date.now() - h.lastContentSyncMs)} ago` : '';
  if (h.contentPeers > 0) {
    return `syncing content with ${h.contentPeers} peer${h.contentPeers === 1 ? '' : 's'}${lastSuffix}`;
  }
  // 0 live content peers right now — honest, NOT "synced"/"disconnected". A past
  // lastContentSyncMs (peers come and go) is still worth showing; its absence
  // means no content-sync peer has ever paired on this hive's topic.
  return `no content-sync peers right now${lastSuffix}`;
}

/**
 * Honest install-wide SYNC line (EI-1618/EI-1599). Returns null when nothing is
 * stalled — silence is the honest healthy state, NOT a false "all synced" claim —
 * or the stall copy when ≥1 booted harness has content captured-but-not-federating
 * (the EI-681 silent-stall). NEVER says "synced" / "in sync"; it only ever reports
 * a stall, because the shared swarm has no clean per-peer count to back a positive
 * sync claim (see findings-M / the route honesty contract).
 */
export function drainLabel(d: FedStatus['substrate']['drain']): string | null {
  if (!d || d.stalledHarnesses <= 0) return null;
  const ageS = d.worstOldestUndrainedAgeMs != null ? Math.round(d.worstOldestUndrainedAgeMs / 1000) : 0;
  const h = `${d.stalledHarnesses} harness${d.stalledHarnesses === 1 ? '' : 'es'}`;
  const c = `${d.worstUndrainedCount} change${d.worstUndrainedCount === 1 ? '' : 's'}`;
  return `⚠ not syncing — ${h} with content captured but not federating (${c} undrained, oldest ${ageS}s)`;
}

/** Install substrate one-liner — honest install-wide boot health, not a sync claim. */
export function substrateLabel(s: FedStatus['substrate']): string {
  if (!s.active) return 'substrate inactive';
  const parts = [`${s.bootedHarnesses} harness${s.bootedHarnesses === 1 ? '' : 'es'} booted`, `${s.healthy} healthy`];
  if (s.booting > 0) parts.push(`${s.booting} booting`);
  if (s.degraded > 0) parts.push(`⚠ ${s.degraded} degraded`);
  return `substrate active · ${parts.join(' · ')}`;
}

/**
 * The COLLAPSED-header signal (owner ask 2026-07-25). Same honesty contract as the
 * body: it may only report a PROBLEM or a plain count — never a positive "synced"
 * claim the substrate cannot back. Ordered worst-first so a closed section still
 * shows the one thing that needs attention. Pure + exported for tests.
 */
export function federationSummary(
  data: FedStatus | null,
): { label: string; tone: 'good' | 'warn' | 'bad' | 'mute' } {
  if (!data) return { label: '…', tone: 'mute' };
  if (drainLabel(data.substrate.drain)) return { label: '⚠ not syncing', tone: 'bad' };
  if (!data.substrate.active) return { label: 'substrate inactive', tone: 'bad' };
  if (data.substrate.degraded > 0) {
    return { label: `⚠ ${data.substrate.degraded} degraded`, tone: 'warn' };
  }
  if (data.hives.length === 0) return { label: 'none published', tone: 'mute' };
  const stranded = data.hives.filter((h) => h.visibility !== 'private' && h.reachablePeers === 0).length;
  if (stranded > 0) return { label: `⚠ ${stranded} unreached`, tone: 'warn' };
  return { label: `${data.hives.length} published`, tone: 'good' };
}

export interface HiveFederationStatusProps {
  /**
   * Render inside a collapsible RailSection rather than an always-open panel
   * (owner ask 2026-07-25 — this panel plus the local-pots control pushed the
   * Pots tab's p2p roster below the fold). The collapsed header still carries
   * the worst-first signal from federationSummary(), so closing it never hides
   * a problem.
   */
  collapsible?: boolean;
}

export default function PotFederationStatus({ collapsible = false }: HiveFederationStatusProps = {}) {
  const t = useLexicon();
  // P-009 (data-sync-push-completion): push-driven federation status. The
  // `network.federationStatus` resolver serves the SAME { ok, substrate, hives }
  // FedStatus the GET /api/discovery/federation-status endpoint did, as a flat
  // one-element array (the resolver contract) — read data[0]. Pushed by the
  // directory ingest path + announce/withdraw/beacon writers; substrate/drain
  // changes (harness boots) converge via the sync library's drift-repair tick.
  // No poll. While the first push is in flight `rows` is undefined → data null.
  const { data: rows, error } = useSyncQuery({ queryName: 'network.federationStatus' });
  const data = (rows as FedStatus[] | undefined)?.[0] ?? null;

  const degraded = data?.substrate.degraded ?? 0;

  // In collapsible mode the RailSection header carries the title + the
  // worst-first summary, so the panel's own bar would just repeat it.
  const body = (
    <>
      {error && !data && (
        <div className="pclsb-panel__error">
          status unavailable: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {data && (
        <>
          <div
            className="pclsb-row"
            data-testid="fed-substrate"
            title="Local federation infrastructure boot health (this install) — not a per-peer sync claim."
          >
            <span className={`pclsb-dot ${data.substrate.active && degraded === 0 ? 'is-up' : 'is-down'}`} aria-hidden="true" />
            <div className="pclsb-row__main">
              <div className="pclsb-row__sub">{substrateLabel(data.substrate)}</div>
            </div>
          </div>

          {/* SYNC-health line (EI-1618/EI-1599) — rendered ONLY when a harness's
              outbox is stalled (content captured but not federating). Silence = the
              honest healthy state; this never claims a positive "synced". */}
          {(() => {
            const drainMsg = drainLabel(data.substrate.drain);
            return drainMsg ? (
              <div
                className="pclsb-row"
                data-testid="fed-drain"
                title="A local change was captured but its outbox has not drained to the federation log — content is NOT reaching peers yet (EI-681 class stall)."
              >
                <span className="pclsb-dot is-down" aria-hidden="true" />
                <div className="pclsb-row__main">
                  <div className="pclsb-row__sub">{drainMsg}</div>
                </div>
              </div>
            ) : null;
          })()}

          {data.hives.length === 0 ? (
            <div className="pclsb-panel__empty" data-testid="fed-no-hives">
              No {t('pot', { plural: true, lower: true })} published from this install yet. Publish a {t('pot', { lower: true })} and its live peer
              reach appears here.
            </div>
          ) : (
            data.hives.map((h) => {
              const stranded = h.visibility !== 'private' && h.reachablePeers === 0;
              return (
                <div className="pclsb-row" key={h.potId} data-testid={`fed-hive-${h.potId}`}>
                  <span className={`pclsb-dot ${stranded ? 'is-down' : 'is-up'}`} aria-hidden="true" />
                  <div className="pclsb-row__main">
                    <div className="pclsb-row__title" title={h.potId}>
                      {h.title}
                      <span style={{ color: 'var(--fg-mute, #888)', fontWeight: 400 }}>
                        {'  ·  '}
                        {h.visibility}
                      </span>
                    </div>
                    <div className="pclsb-row__sub" data-testid={`fed-reach-${h.potId}`}>
                      {reachLabel(h)}
                    </div>
                    {(() => {
                      const syncMsg = contentSyncLabel(h);
                      return syncMsg ? (
                        <div className="pclsb-row__sub" data-testid={`fed-content-${h.potId}`} style={{ opacity: 0.85 }}>
                          {syncMsg}
                        </div>
                      ) : null;
                    })()}
                  </div>
                </div>
              );
            })
          )}

          {/* Honest scope note — reach is discovery, content-sync is per-hive, sync-health is install-wide. */}
          <div className="pclsb-panel__empty" style={{ fontSize: 11, opacity: 0.7 }} data-testid="fed-scope-note">
            Reach = peers who can discover this {t('pot', { lower: true })} on its announce topic. Content-sync (per-
            {t('pot', { lower: true })}) = peers actively replicating its content right now. Sync-health below is
            install-wide (is local content draining to the federation log).
          </div>
        </>
      )}
    </>
  );

  if (collapsible) {
    const { label, tone } = federationSummary(data);
    return (
      <RailSection
        paramKey="potsFed"
        icon={Radio}
        title="Federation"
        summary={label}
        tone={tone}
        testId="pot-federation-status"
      >
        {body}
      </RailSection>
    );
  }

  return (
    <div className="pclsb-panel" data-testid="pot-federation-status">
      <div className="pclsb-panel__bar">
        <span className="pclsb-panel__bar-label">federation status</span>
      </div>
      {body}
    </div>
  );
}
