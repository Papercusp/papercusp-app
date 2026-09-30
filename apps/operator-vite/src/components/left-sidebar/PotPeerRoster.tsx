/**
 * PotPeerRoster — the p2p swarm roster: every remote Papercusp install that has
 * announced into the Model-B substrate (`shared_presence`), grouped per DEVICE.
 * Stale pots stay listed (joined but quiet), flagged. Honest empty state until a
 * real peer announces.
 *
 * WHY IT LIVES HERE AND NOT IN A "Pots" TAB (P-077, plan
 * retire-mug-kettle-su-only-2026-08-09). This was the body of the left rail's
 * Pots tab, which P-074 removed on the owner's directive. The tab was a
 * TIER-shaped container, but this roster is not tier code: it reads
 * `shared_presence`, i.e. the SHARED POT SUBSTRATE that D-003 explicitly says
 * SURVIVES the mug/kettle retirement. D-069 §2 caught exactly that distinction
 * for its sibling `PotFederationStatus` and preserved it; the same argument
 * applies verbatim here, and a grep at the time of this extraction confirmed
 * that the removed tab was the app's ONLY reader of `shared_presence` — so
 * deleting it with its host would have left the install with no view of the
 * swarm at all, and orphaned the `sidebar.hives` resolver behind it.
 *
 * It is collapsed by default like every other rail section, and its collapsed
 * header carries the live/quiet counts, so closing it never hides a peer that
 * has gone quiet.
 */
import { useMemo } from 'react';
import { Network } from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useLexicon } from '@/lib/useLexicon';
import RailSection from './RailSection';

interface FederatedRow {
  ownerId: string;
  ownerLabel: string;
  host: string;
  userId?: string | null;
  intent?: string | null;
  currentView?: string | null;
  harnessSlug?: string | null;
  devicePubkey?: string | null;
  heartbeatAt?: string | null;
  stale: boolean;
}

export interface HiveGroup {
  machine: string;
  devicePubkey: string;
  users: string[];
  harnesses: string[];
  doing: string;
  lastSeen: string;
  stale: boolean;
}

/** Group per-(user, harness) presence rows into one entry per device — the
 *  freshest row wins the doing field; a pot is stale only when ALL its rows
 *  are. Live pots sort first, then by machine (pui group_hives parity). */
export function groupHives(rows: FederatedRow[]): HiveGroup[] {
  const groups: HiveGroup[] = [];
  for (const r of rows) {
    const key = r.devicePubkey?.trim() || r.host;
    let g = groups.find((x) => x.devicePubkey === key);
    if (!g) {
      g = {
        machine: r.host || key,
        devicePubkey: key,
        users: [],
        harnesses: [],
        doing: '',
        lastSeen: '',
        stale: true,
      };
      groups.push(g);
    }
    if (r.userId && !g.users.includes(r.userId)) g.users.push(r.userId);
    if (r.harnessSlug && !g.harnesses.includes(r.harnessSlug)) g.harnesses.push(r.harnessSlug);
    const ts = r.heartbeatAt ?? '';
    if (ts >= g.lastSeen) {
      g.lastSeen = ts;
      g.doing = r.currentView || r.intent || '';
    }
    g.stale = g.stale && r.stale;
  }
  return groups.sort((a, b) =>
    a.stale === b.stale ? a.machine.localeCompare(b.machine) : a.stale ? 1 : -1,
  );
}

/**
 * The COLLAPSED-header signal. Same honesty contract as `PotFederationStatus`
 * beside it: report a plain count or a problem, never a positive claim the
 * substrate cannot back. Worst-first, so a closed section still shows the one
 * thing worth knowing. Pure + exported for tests.
 */
export function rosterSummary(
  groups: HiveGroup[],
  loading: boolean,
): { label: string; tone: 'good' | 'warn' | 'bad' | 'mute' } {
  if (loading && groups.length === 0) return { label: '…', tone: 'mute' };
  if (groups.length === 0) return { label: 'flying solo', tone: 'mute' };
  const live = groups.filter((g) => !g.stale).length;
  // Every peer that ever joined has gone quiet — worth surfacing on a closed
  // header, because "joined" alone reads as connected when nothing is.
  if (live === 0) return { label: `⚠ ${groups.length} quiet`, tone: 'warn' };
  return { label: `${live}/${groups.length} live`, tone: 'good' };
}

export default function PotPeerRoster() {
  const t = useLexicon();
  const hives = useSyncQuery<FederatedRow>({
    queryName: 'sidebar.hives',
    staleTime: 10_000,
  });

  const groups = useMemo(() => groupHives(hives.data ?? []), [hives.data]);
  const { label, tone } = rosterSummary(groups, hives.loading);

  return (
    <RailSection
      paramKey="potsPeers"
      icon={Network}
      title="P2P peers"
      summary={label}
      tone={tone}
      testId="pot-peer-roster"
    >
      {/* `pclsb-pots` is the COMPACT density scope (owner ask 2026-07-25: "make
          the Pots tab more compact so it's easier to see the full list without
          scrolling"). It tightens these rows only — the roomier default density
          every other surface relies on is untouched. */}
      <div className="pclsb-pots" data-testid="left-sidebar-hives">
        {hives.error && <div className="pclsb-panel__error">{String(hives.error)}</div>}
        {groups.length === 0 && !hives.loading && (
          <div className="pclsb-panel__empty">
            no remote {t('pot', { plural: true, lower: true })} in the p2p network yet — this{' '}
            {t('pot', { lower: true })} flies solo
            <br />
            <br />A {t('pot')} appears here once another Papercusp install joins the substrate and
            its announce lands in shared_presence.
          </div>
        )}
        {groups.map((g) => (
          <div className="pclsb-row" key={g.devicePubkey} data-testid={`hive-${g.machine}`}>
            <span className={`pclsb-dot ${g.stale ? 'is-down' : 'is-up'}`} aria-hidden="true" />
            <div className="pclsb-row__main">
              <div className="pclsb-row__title" title={g.devicePubkey}>
                {g.machine}
                {g.users.length > 0 ? `  ·  gh:${g.users.join(',')}` : ''}
              </div>
              <div className="pclsb-row__sub" title={g.doing}>
                {g.doing || (g.stale ? 'quiet' : 'idle')}
                {g.harnesses.length > 0 ? `  ·  [${g.harnesses.join(', ')}]` : ''}
              </div>
            </div>
            {g.stale && <span className="pclsb-pill">stale</span>}
          </div>
        ))}
      </div>
    </RailSection>
  );
}
