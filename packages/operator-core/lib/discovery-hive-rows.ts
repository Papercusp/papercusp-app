import { getHiveDirectory } from './hive-directory-deps';
import { loadHarnessRegistry, type ProjectEntry } from './harness-registry';
import { getHiveBySlug, type HiveRecord } from './hive-store';
import { activeWorkspaceId } from './workspace-registry';
import type { DiscoveredHive } from './hive-directory';
import type { HiveStatusBeacon } from './hive-beacon';

export interface HiveDirectoryBrowseRow {
  potId: string;
  title: string;
  description: string;
  owner: string;
  visibility: 'public' | 'invite';
  hivePubkey: string | null;
  memberTopics: string[];
  memberLinks: string[];
  memberCount: number;
  createdAt: number;
  lastSeenMs: number;
  beacon?: HiveStatusBeacon;
}

function discoveredRow(h: DiscoveredHive): HiveDirectoryBrowseRow {
  const memberLinks = h.memberLinks ?? [];
  return {
    potId: h.potId,
    title: h.title,
    description: h.description,
    owner: h.ownerGithubLogin,
    visibility: h.visibility === 'invite' ? 'invite' : 'public',
    hivePubkey: h.hivePubkey ?? null,
    memberTopics: h.memberTopics,
    memberLinks,
    // memberTopics is empty for from-repo publishes that still carry one-click
    // member links; count whichever join signal is present.
    memberCount: h.memberTopics.length || memberLinks.length || 0,
    createdAt: h.createdAt,
    lastSeenMs: h.lastSeenMs,
    ...(h.beacon ? { beacon: h.beacon } : {}),
  };
}

function joinedRemoteRow(project: ProjectEntry, hive: HiveRecord | null): HiveDirectoryBrowseRow | null {
  if (project.harness_kind !== 'hive' || project.remote_hive !== true) return null;
  const hivePubkey = hive?.pubkeyBase64 ?? project.hive_pubkey ?? null;
  if (!hivePubkey) return null;
  const now = Date.now();
  return {
    potId: project.slug,
    title: hive?.title ?? project.slug,
    description: hive?.description ?? '',
    owner: 'remote',
    visibility: 'invite',
    hivePubkey,
    memberTopics: [],
    memberLinks: [],
    memberCount: 0,
    createdAt: hive?.createdAt ?? now,
    lastSeenMs: hive?.updatedAt ?? now,
  };
}

async function joinedRemoteRows(workspaceId: string): Promise<HiveDirectoryBrowseRow[]> {
  const reg = await loadHarnessRegistry(workspaceId);
  const projects = reg.projects.filter((p) => p.harness_kind === 'hive' && p.remote_hive === true);
  const rows: HiveDirectoryBrowseRow[] = [];
  for (const project of projects) {
    const hive = await getHiveBySlug(workspaceId, project.slug).catch(() => null);
    const row = joinedRemoteRow(project, hive);
    if (row) rows.push(row);
  }
  return rows;
}

export async function buildHiveDirectoryRows(opts: {
  includeExpired?: boolean;
  includeJoinedRemoteViews?: boolean;
  workspaceId?: string;
} = {}): Promise<HiveDirectoryBrowseRow[]> {
  const rows = getHiveDirectory()
    .listDiscoveredHives({ includeExpired: opts.includeExpired })
    .filter((h) => h.visibility !== 'private')
    .map(discoveredRow);

  if (opts.includeJoinedRemoteViews !== false) {
    const workspaceId = opts.workspaceId ?? activeWorkspaceId();
    const joined = await joinedRemoteRows(workspaceId).catch(() => [] as HiveDirectoryBrowseRow[]);
    const seenHiveIds = new Set(rows.map((r) => r.potId));
    const seenPubkeys = new Set(rows.map((r) => r.hivePubkey).filter((x): x is string => Boolean(x)));
    for (const row of joined) {
      if (seenHiveIds.has(row.potId)) continue;
      if (row.hivePubkey && seenPubkeys.has(row.hivePubkey)) continue;
      rows.push(row);
      seenHiveIds.add(row.potId);
      if (row.hivePubkey) seenPubkeys.add(row.hivePubkey);
    }
  }

  return rows;
}

export const __test = { joinedRemoteRow, discoveredRow };
