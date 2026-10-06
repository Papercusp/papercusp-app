/**
 * Set the two Papercusp-hosted GCP custom roles to exactly the permission lists in
 * packages/operator-core/lib/workspace-host/hosted-gcp-hosting.ts (WI-10005251, DERIVE half).
 *
 * Runs under an OPERATOR identity that holds iam.roles.create/update/undelete on the hosting
 * project (the gcloud login by default), never the control plane's delegation source: the
 * control plane may grant these roles, so it must not also be able to redefine them. The
 * control plane only ATTESTS them, read-only, on the standing health cadence and files a
 * finding on drift whose body names this command.
 *
 *   npx tsx scripts/workspace-host/reconcile-hosted-gcp-roles.ts --project=papercusp-hosted-workspaces          # dry run
 *   npx tsx scripts/workspace-host/reconcile-hosted-gcp-roles.ts --project=papercusp-hosted-workspaces --apply  # write
 *
 * `--project` defaults to PAPERCUSP_HOSTED_GCP_WORKSPACE_PROJECT. Exit 0 = the live roles match
 * code (after --apply, or already); 1 = drift remains (a dry run that found some); 2 = error.
 */
import { execFileSync } from 'node:child_process';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { hostedGcpWorkspaceProject } from '@papercusp/operator-core/lib/workspace-host/hosted-gcp-hosting';
import {
  papercuspHostedRoleDrifted,
  reconcilePapercuspHostedRoles,
  type PapercuspHostedRoleReconcileOutcome,
} from '@papercusp/operator-core/lib/workspace-host/hosted-gcp-roles';

function flag(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function renderReconcileOutcomes(projectId: string, outcomes: readonly PapercuspHostedRoleReconcileOutcome[]): string {
  const lines = [`project ${projectId}`];
  for (const outcome of outcomes) {
    const { before } = outcome;
    const state = before.absent ? ' (absent)' : before.deleted ? ' (deleted)' : '';
    lines.push(
      `  ${outcome.roleId}${state}: ${outcome.action}` +
        (before.missing.length ? `\n    missing: ${before.missing.join(', ')}` : '') +
        (before.extra.length ? `\n    extra:   ${before.extra.join(', ')}` : ''),
    );
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const projectId = flag(args, 'project') ?? hostedGcpWorkspaceProject();
  const accessToken = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  const outcomes = await reconcilePapercuspHostedRoles({ projectId, accessToken, apply });
  console.log(renderReconcileOutcomes(projectId, outcomes));
  const remaining = outcomes.some((outcome) => outcome.action === 'would-change' && papercuspHostedRoleDrifted(outcome.before));
  if (remaining) console.log('\nDrift remains. Re-run with --apply to set the live roles to the code lists.');
  return remaining ? 1 : 0;
}

if (isCliEntry(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
