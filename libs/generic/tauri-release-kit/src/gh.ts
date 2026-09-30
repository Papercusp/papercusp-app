/**
 * GitHub release driver over the Exec port. Idempotent: if the release for the
 * tag exists, upload assets with --clobber; else create it. Mirrors the gh
 * block in bin/release-local.sh.
 */
import type { Channel, ExecPort, LogPort } from './types.js';
import { isPrerelease } from './tag.js';

export interface GhRepo {
  owner: string;
  name: string;
}

export function repoSlug(repo: GhRepo): string {
  return `${repo.owner}/${repo.name}`;
}

export function ghViewArgs(tag: string, repo: GhRepo): string[] {
  return ['release', 'view', tag, '--repo', repoSlug(repo)];
}

export function ghUploadArgs(opts: {
  tag: string;
  repo: GhRepo;
  assets: string[];
}): string[] {
  return [
    'release',
    'upload',
    opts.tag,
    ...opts.assets,
    '--repo',
    repoSlug(opts.repo),
    '--clobber',
  ];
}

export function ghCreateArgs(opts: {
  tag: string;
  repo: GhRepo;
  title: string;
  notesFile?: string;
  channel: Channel;
  assets: string[];
}): string[] {
  const args = [
    'release',
    'create',
    opts.tag,
    ...opts.assets,
    '--repo',
    repoSlug(opts.repo),
    '--title',
    opts.title,
  ];
  if (opts.notesFile) args.push('--notes-file', opts.notesFile);
  if (isPrerelease(opts.channel)) args.push('--prerelease');
  return args;
}

export interface PublishResult {
  action: 'created' | 'uploaded';
}

export async function publishRelease(
  ports: { exec: ExecPort; log: LogPort },
  opts: {
    tag: string;
    repo: GhRepo;
    title: string;
    notesFile?: string;
    channel: Channel;
    assets: string[];
  },
): Promise<PublishResult> {
  const view = await ports.exec.run('gh', ghViewArgs(opts.tag, opts.repo));
  if (view.code === 0) {
    ports.log.info(`release ${opts.tag} exists; uploading assets with --clobber`);
    const up = await ports.exec.run('gh', ghUploadArgs(opts));
    if (up.code !== 0) throw new Error(`gh release upload failed: ${up.stderr || up.stdout}`);
    return { action: 'uploaded' };
  }
  ports.log.info(`creating GitHub release ${opts.tag}`);
  const created = await ports.exec.run('gh', ghCreateArgs(opts));
  if (created.code !== 0) {
    throw new Error(`gh release create failed: ${created.stderr || created.stdout}`);
  }
  return { action: 'created' };
}
