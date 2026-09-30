#!/usr/bin/env node
// scripts/share-source.mjs — per-person read access to the private source preview
// (plan dhh-source-preview-2026-09-28 P-006, D-004).
//
// Grants or revokes READ access to exactly ONE repository, Papercusp/papercusp-preview
// (the public-safe source cut published by scripts/source-preview.mjs). It is
// deliberately unable to touch any other repository — never Papercusp/papercup or its
// private submodule repos — and unable to grant anything but read.
//
// Adding someone is outward-facing (GitHub emails them an invitation), so every
// mutation is a DRY RUN unless --confirm is passed. Do not pass --confirm for a
// person the owner has not explicitly approved.
//
// Usage:
//   npm run share-source -- list
//   npm run share-source -- add <github-user> [--confirm]
//   npm run share-source -- remove <github-user> [--confirm]
//
// Exit: 0 ok · 1 GitHub call failed · 2 usage / refused.
import { spawnSync } from 'node:child_process';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export const PREVIEW_REPO = 'Papercusp/papercusp-preview';
export const PERMISSION = 'pull';
const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export class ShareRefused extends Error {}

/** Parse argv into a validated request, refusing anything outside the contract. */
export function parseShareArgs(argv) {
  const [action, ...rest] = argv;
  let user;
  let confirm = false;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--confirm') confirm = true;
    else if (a === '--repo') {
      const repo = rest[++i];
      if (repo !== PREVIEW_REPO) throw new ShareRefused(`refusing repository ${repo ?? '(none)'}: share-source only manages ${PREVIEW_REPO}`);
    } else if (a === '--permission') {
      const perm = rest[++i];
      if (perm !== PERMISSION && perm !== 'read') throw new ShareRefused(`refusing permission ${perm ?? '(none)'}: share-source only grants read`);
    } else if (a.startsWith('-')) throw new ShareRefused(`unknown flag ${a}`);
    else if (user === undefined) user = a;
    else throw new ShareRefused(`unexpected argument ${a}`);
  }
  if (!['list', 'add', 'remove'].includes(action)) throw new ShareRefused('usage: share-source list | add <github-user> [--confirm] | remove <github-user> [--confirm]');
  if (action === 'list') {
    if (user !== undefined) throw new ShareRefused('list takes no user');
    return { action, confirm };
  }
  if (!user || !GITHUB_LOGIN_RE.test(user)) throw new ShareRefused(`not a valid GitHub username: ${user ?? '(none)'}`);
  return { action, user, confirm };
}

/** The exact gh invocations for a request (pure — tests assert on this). */
export function plannedCalls(req) {
  const base = `repos/${PREVIEW_REPO}`;
  if (req.action === 'list') {
    return [
      ['api', '--paginate', `${base}/collaborators?affiliation=direct`, '--jq', '.[] | [.login, .role_name] | @tsv'],
      ['api', '--paginate', `${base}/invitations`, '--jq', '.[] | [.invitee.login, .permissions, "pending-invite"] | @tsv'],
    ];
  }
  if (req.action === 'add') {
    return [['api', '-X', 'PUT', `${base}/collaborators/${req.user}`, '-f', `permission=${PERMISSION}`]];
  }
  return [['api', '-X', 'DELETE', `${base}/collaborators/${req.user}`]];
}

function gh(args, env) {
  return spawnSync(env.SHARE_SOURCE_GH || 'gh', args, { encoding: 'utf8', env });
}

/** Cancel a still-pending invitation for `user` (removing a collaborator does not). */
function cancelInvite(user, env) {
  const r = gh(['api', '--paginate', `repos/${PREVIEW_REPO}/invitations`, '--jq', `.[] | select(.invitee.login == "${user}") | .id`], env);
  if (r.status !== 0) return { ok: false, detail: r.stderr };
  const ids = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  for (const id of ids) {
    const d = gh(['api', '-X', 'DELETE', `repos/${PREVIEW_REPO}/invitations/${id}`], env);
    if (d.status !== 0) return { ok: false, detail: d.stderr };
  }
  return { ok: true, cancelled: ids.length };
}

export function runShare(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  let req;
  try {
    req = parseShareArgs(argv);
  } catch (e) {
    err(`REFUSED: ${e.message}`);
    return 2;
  }
  const calls = plannedCalls(req);
  if (req.action !== 'list' && !req.confirm) {
    out(`dry run — would ${req.action === 'add' ? `invite ${req.user} with READ access to` : `remove ${req.user} from`} ${PREVIEW_REPO}:`);
    for (const c of calls) out(`  gh ${c.join(' ')}`);
    out('Re-run with --confirm to apply. Only do that with the owner\'s explicit go for this person.');
    return 0;
  }
  for (const c of calls) {
    const r = gh(c, env);
    if (r.status !== 0) {
      err(`gh ${c.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
      return 1;
    }
    if (r.stdout.trim()) out(r.stdout.trim());
  }
  if (req.action === 'remove') {
    const c = cancelInvite(req.user, env);
    if (!c.ok) {
      err(`removed collaborator, but cancelling a pending invite failed: ${c.detail}`);
      return 1;
    }
    out(`${req.user} no longer has access to ${PREVIEW_REPO}${c.cancelled ? ` (cancelled ${c.cancelled} pending invite)` : ''}`);
  } else if (req.action === 'add') {
    out(`${req.user} invited to ${PREVIEW_REPO} with read access — GitHub emails them the invitation`);
  }
  return 0;
}

if (isCliEntry(import.meta.url)) process.exit(runShare(process.argv.slice(2)));
