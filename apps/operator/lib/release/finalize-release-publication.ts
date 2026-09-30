/**
 * Verify a published release through its public read path, then mark the
 * corresponding registry row live.
 *
 * `record-release-cli` deliberately records a cut with `published_at = NULL`.
 * This module is the only writer that may advance that field: it proves that
 * the public manifest exists and that every artifact frozen into the row is
 * reachable at the size recorded at cut time before changing the registry.
 */

import postgres, { type Sql } from 'postgres';
import { getOwnerDirective, type OwnerDirectiveRow } from '@papercusp/operator-core/lib/owner-directives';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';
import {
  listReleases,
  markReleasePublished,
  type ReleaseRow,
} from './release-registry';
import { computeReleaseCompleteness } from './release-completeness';
import { incompleteDesktopScopeRefusal } from './release-owner-approval';
import { partialScopeApprovalDirectiveId } from './release-partial-scope';

export interface HeadProbeResult {
  status: number;
  /** Parsed Content-Length, or null when the server omitted it. */
  contentLength: number | null;
}

export type HeadProbe = (url: string) => Promise<HeadProbeResult>;

export interface FinalizeReleaseOptions {
  version: string;
  channel: string;
  workspaceId: string;
  baseUrl: string;
}

export interface PublicationProof {
  manifestStatus: number;
  artifactCount: number;
}

export interface ReleaseScopePreflightOptions {
  version: string;
  channel: string;
  workspaceId: string;
}

/** Resolve the release host without ever echoing its secret path. */
export function resolveReleaseBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = (env.PAPERCUSP_UPDATE_BASE_URL ?? env.PAPERCUSP_RELEASE_HOST ?? '').trim();
  if (!raw) {
    throw new Error(
      'no release host configured; source ~/.papercusp/release-host.env before finalizing',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('release host is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('release host must use http or https');
  }
  return raw.replace(/\/+$/, '');
}

function publicPath(baseUrl: string, relativePath: string): string {
  // ReleaseArtifact.url is a relative registry value. Keep it relative here:
  // accepting an absolute URL would let a malformed row escape the configured
  // release host and would make the proof attest to the wrong object.
  return `${baseUrl.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`;
}

async function fetchHead(url: string): Promise<HeadProbeResult> {
  const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const rawLength = response.headers.get('content-length');
  return {
    status: response.status,
    contentLength: rawLength === null ? null : Number(rawLength),
  };
}

async function checkedHead(
  head: HeadProbe,
  label: string,
  url: string,
): Promise<HeadProbeResult> {
  try {
    return await head(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Do not include `url`: the base path is the permanent release secret.
    throw new Error(`public release check could not reach ${label}: ${message}`);
  }
}

export async function assertRecordedReleaseScopeApproved(
  row: ReleaseRow,
  workspaceId: string,
  readDirective: (id: number) => Promise<OwnerDirectiveRow | null> = getOwnerDirective,
): Promise<number | null> {
  const completeness = computeReleaseCompleteness(row.artifacts);
  if (completeness.complete) return null;
  const directiveId = partialScopeApprovalDirectiveId(row.notes);
  const directive = directiveId === null ? null : await readDirective(directiveId);
  const refusal = incompleteDesktopScopeRefusal(
    row.version,
    row.channel,
    completeness.missing,
    directive,
    workspaceId,
  );
  if (refusal) throw new Error(refusal);
  return directiveId;
}

export async function preflightReleasePublication(
  opts: ReleaseScopePreflightOptions,
  deps: { sql?: Sql } = {},
): Promise<{ artifactCount: number; completeDesktopScope: boolean; approvalDirectiveId: number | null }> {
  const sql = deps.sql ?? postgres(getHarnessAdminUrl(), { max: 1 });
  const ownsSql = !deps.sql;
  try {
    const row = (await listReleases(sql, opts.workspaceId, opts.channel)).find(
      (candidate) => candidate.version === opts.version,
    );
    if (!row) {
      throw new Error(
        `cannot publish release: no registry row for ${opts.workspaceId}/${opts.channel}/${opts.version}`,
      );
    }
    const approvalDirectiveId = await assertRecordedReleaseScopeApproved(row, opts.workspaceId);
    return {
      artifactCount: row.artifacts.length,
      completeDesktopScope: computeReleaseCompleteness(row.artifacts).complete,
      approvalDirectiveId,
    };
  } finally {
    if (ownsSql) await sql.end({ timeout: 5 });
  }
}

function requireSuccess(label: string, response: HeadProbeResult): void {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`public release check failed for ${label}: HTTP ${response.status}`);
  }
}

/**
 * Verify the public manifest and every artifact frozen in a release row.
 *
 * The manifest only needs a successful response: the uploader already compares
 * its served bytes with the local manifest. Artifacts have an independent,
 * database-backed expected size, so a missing or mismatched Content-Length is
 * a hard failure even when the server returns HTTP 200.
 */
export async function verifyReleasePublication(
  row: ReleaseRow,
  baseUrl: string,
  head: HeadProbe = fetchHead,
): Promise<PublicationProof> {
  if (row.artifacts.length === 0) {
    throw new Error(`release ${row.version} (${row.channel}) has no recorded artifacts`);
  }

  const manifest = await checkedHead(
    head,
    'latest.json',
    publicPath(baseUrl, 'latest.json'),
  );
  requireSuccess('latest.json', manifest);

  for (const artifact of row.artifacts) {
    const label = `artifact ${artifact.name}`;
    const response = await checkedHead(head, label, publicPath(baseUrl, artifact.url));
    requireSuccess(label, response);
    if (!Number.isSafeInteger(response.contentLength)) {
      throw new Error(`${label} did not return a usable Content-Length`);
    }
    if (response.contentLength !== artifact.size) {
      throw new Error(
        `${label} Content-Length ${response.contentLength} does not match recorded size ${artifact.size}`,
      );
    }
  }

  return { manifestStatus: manifest.status, artifactCount: row.artifacts.length };
}

/** Verify public bytes and atomically advance the workspace release row. */
export async function finalizeReleasePublication(
  opts: FinalizeReleaseOptions,
  deps: { head?: HeadProbe; sql?: Sql } = {},
): Promise<{ publishedAt: Date; proof: PublicationProof }> {
  const sql = deps.sql ?? postgres(getHarnessAdminUrl(), { max: 1 });
  const ownsSql = !deps.sql;
  try {
    const row = (await listReleases(sql, opts.workspaceId, opts.channel)).find(
      (candidate) => candidate.version === opts.version,
    );
    if (!row) {
      throw new Error(
        `cannot finalize release: no registry row for ${opts.workspaceId}/${opts.channel}/${opts.version}`,
      );
    }

    await assertRecordedReleaseScopeApproved(row, opts.workspaceId);
    const proof = await verifyReleasePublication(row, opts.baseUrl, deps.head);
    const publishedAt = await markReleasePublished(
      sql,
      opts.workspaceId,
      opts.channel,
      opts.version,
    );
    return { publishedAt, proof };
  } finally {
    if (ownsSql) await sql.end({ timeout: 5 });
  }
}

function arg(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

export function buildFinalizeOptions(argv: string[]): FinalizeReleaseOptions {
  const version = arg(argv, '--version');
  if (!version) throw new Error('usage: finalize-release-publication.ts --version <version> [--channel <channel>]');
  return {
    version,
    channel: arg(argv, '--channel') ?? 'alpha',
    workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
    baseUrl: resolveReleaseBaseUrl(),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--preflight')) {
    const version = arg(argv, '--version');
    if (!version) {
      throw new Error(
        'usage: finalize-release-publication.ts --preflight --version <version> [--channel <channel>] [--workspace <id>]',
      );
    }
    const result = await preflightReleasePublication({
      version,
      channel: arg(argv, '--channel') ?? 'alpha',
      workspaceId: arg(argv, '--workspace') ?? 'papercusp-workspace',
    });
    console.log(
      `[finalize-release] preflight passed for ${version}: ${result.artifactCount} artifacts; ` +
        `desktop scope ${result.completeDesktopScope ? 'complete' : `approved by directive #${result.approvalDirectiveId}`}`,
    );
    return 0;
  }
  const opts = buildFinalizeOptions(argv);
  const result = await finalizeReleasePublication(opts);
  console.log(
    `[finalize-release] ${opts.version} (${opts.channel}) marked live after ` +
      `${result.proof.artifactCount} public artifact checks; published_at=${result.publishedAt.toISOString()}`,
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('[finalize-release] FATAL:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
