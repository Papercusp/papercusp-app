/**
 * backup:diff — show the file-level diff between two snapshots.
 * Useful for "what did the agent change in the last hour" — pick two
 * snapshot ids and read the tree-diff back.
 */

import { z } from 'zod';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { deriveRepoPassword } from '../../backup';
import { activeWorkspaceId, workspacesRoot } from '../../workspace-registry';
import { runGovernedOperation } from '../../resource-governor/execution';

const KOPIA_BIN = process.env.KOPIA_BIN ?? 'kopia';

export default defineTool({
  name: 'backup:diff',
  profile: 'engineer',
  description: 'Diff two kopia snapshots — list files added/changed/removed.',
  capability: 'backup:read',
  guidance: {
    when: `Diff current state vs a backup snapshot — what would change if we restored. Read-only.`,
    notWhen: `For applying the diff, use \`backup:restore\`. diff is the dry-run view.`,
    seeAlso: ['backup:restore (apply the diff — this is the dry-run view)'],
  },
  requirePrincipal: false,
  // EI-18803497769946984: shells out to diff snapshots and never reads ctx.tx — holding
  // the ambient workspace transaction across that wait trips
  // idle_in_transaction_session_timeout (60s), surfacing as a bare
  // `write CONNECTION_CLOSED 127.0.0.1:6432`. See ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fromSnapshotId: z.string().min(1),
    toSnapshotId: z.string().min(1),
  }),
  async handler(args) {
    const workspaceId = activeWorkspaceId();
    const backupsDir = join(workspacesRoot(), workspaceId, 'backups');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KOPIA_PASSWORD: await deriveRepoPassword(workspaceId),
      KOPIA_CONFIG_PATH: join(backupsDir, 'repository.config'),
      KOPIA_LOG_DIR: join(backupsDir, 'logs'),
      KOPIA_CACHE_DIRECTORY: join(backupsDir, 'cache'),
    };
    const out = await runGovernedOperation(
      {
        workspaceId,
        namespace: 'backup-diff',
        owner: 'backup:diff',
        admissionClass: 'process',
        demand: { cpuWeight: 0.5, memoryBytes: 256 * 1024 * 1024, fileDescriptors: 3 },
        payloadRef: `backup:diff:${args.fromSnapshotId}:${args.toSnapshotId}`,
        metadata: { command: 'kopia diff' },
      },
      async () => runKopia(['diff', args.fromSnapshotId, args.toSnapshotId], env),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ diff: out }) }],
    };
  },
});

function runKopia(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(KOPIA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`kopia ${args.join(' ')} exited ${code}: ${Buffer.concat(err).toString('utf8')}`));
    });
  });
}
