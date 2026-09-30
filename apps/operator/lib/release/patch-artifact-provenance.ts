/**
 * patch-artifact-provenance — update the recorded size/sha256 of artifacts that
 * were RE-PUBLISHED after the release row was first recorded.
 *
 * Why this exists (WI-39370). When a shipped artifact is re-published — a repack,
 * a corrupted upload replaced, a signature refreshed — the bytes on the release
 * host change but `harness_shared.releases.artifacts` keeps the ORIGINAL sha256.
 * The registry then publishes a checksum that MISMATCHES what the host serves,
 * which is exactly the kind of thing a careful verifier trips over.
 *
 * Neither existing path fixes that narrowly:
 *   --regenerate  → regenerateOnly(): re-renders the SITE, never re-reads artifacts.
 *   a full re-record → also re-snapshots work items / plans / changelog for the
 *                      version, which is a side effect nobody asked for when all
 *                      that changed is a checksum (the CLI warns about exactly
 *                      this at record-release-cli.ts:1145).
 *
 * So this touches ONE thing: the artifacts array. Every other column on the row is
 * read and written back verbatim through recordRelease's ON CONFLICT DO UPDATE.
 *
 * It re-hashes from a LOCAL file you point it at, and refuses to record a hash it
 * did not compute itself — a provenance record asserting a checksum nobody verified
 * is worse than a stale one, because it looks authoritative.
 *
 *   Usage:
 *     tsx apps/operator/lib/release/patch-artifact-provenance.ts \
 *       --version 0.0.17 --channel alpha \
 *       --artifact "Papercusp GUI_0.0.17_amd64.deb=/path/to/local.deb" \
 *       [--artifact "<name>=<path>" ...]        # repeatable
 *       [--apply]                               # default is DRY RUN
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '@papercusp/operator-core/lib/embedded-pg-discovery';
import { listReleases, recordRelease, type ReleaseRow } from './release-registry';

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function args(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) out.push(argv[i + 1]);
  return out;
}

async function sha256(file: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  await new Promise<void>((res, rej) =>
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => res()).on('error', rej),
  );
  return { sha256: h.digest('hex'), size: fs.statSync(file).size };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const version = arg(argv, '--version');
  const channel = arg(argv, '--channel');
  const pairs = args(argv, '--artifact');
  const apply = argv.includes('--apply');
  if (!version || !channel || pairs.length === 0) {
    console.error(
      'usage: patch-artifact-provenance --version X.Y.Z --channel <ch> --artifact "<name>=<localpath>" [--artifact ...] [--apply]',
    );
    return 2;
  }

  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || 'papercusp-workspace';
  const sql = postgres(await getHarnessAdminUrl(), { max: 1 });
  try {
    const rows = await listReleases(sql, workspaceId);
    const row = rows.find((r) => r.version === version && r.channel === channel);
    if (!row) {
      console.error(`no release row for ${version} (${channel}) in workspace ${workspaceId}`);
      return 1;
    }

    const artifacts = JSON.parse(JSON.stringify(row.artifacts)) as ReleaseRow['artifacts'];
    let changed = 0;
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const file = pair.slice(eq + 1);
      if (!fs.existsSync(file)) {
        console.error(`REFUSING: local file not found, cannot verify a hash for "${name}": ${file}`);
        return 1;
      }
      const target = artifacts.find((a) => a.name === name);
      if (!target) {
        console.error(`REFUSING: "${name}" is not in the recorded artifact set for ${version} (${channel}).`);
        console.error(`  recorded: ${artifacts.map((a) => a.name).join(', ')}`);
        return 1;
      }
      const { sha256: got, size } = await sha256(file);
      const before = { sha256: String(target.sha256 ?? ''), size: Number(target.size ?? 0) };
      if (before.sha256 === got && before.size === size) {
        console.log(`  = ${name}\n      already correct (${got.slice(0, 12)}…, ${size} B)`);
        continue;
      }
      console.log(
        `  ~ ${name}\n      sha256 ${before.sha256.slice(0, 12)}… -> ${got.slice(0, 12)}…\n      size   ${before.size} -> ${size}`,
      );
      target.sha256 = got;
      target.size = size;
      changed++;
    }

    if (changed === 0) {
      console.log('\nnothing to change — recorded provenance already matches the local bytes.');
      return 0;
    }
    if (!apply) {
      console.log(`\nDRY RUN — ${changed} artifact(s) would be updated. Re-run with --apply.`);
      return 0;
    }

    // Every other column is passed through verbatim: this must not re-snapshot
    // work items, plans, or the changelog (record-release-cli.ts:1145).
    await recordRelease(sql, workspaceId, {
      version: row.version,
      channel: row.channel,
      cutAt: row.cutAt,
      publishedAt: row.publishedAt,
      changelogMd: row.changelogMd,
      workItemIds: row.workItemIds,
      planSlugs: row.planSlugs,
      artifacts,
      gitSha: row.gitSha,
      cutBy: row.cutBy,
      notes: row.notes,
    });
    console.log(`\napplied — ${changed} artifact(s) updated for ${version} (${channel}).`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
