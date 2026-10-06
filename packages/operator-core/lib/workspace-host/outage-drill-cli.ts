/**
 * Live runner for the J5 outage drill (outage-drill.ts; plan aws-byoc-gcp-parity-2026-10-01
 * P-017; AWS per WI-10005447). Runs the drill against a real GCP or AWS workspace host and prints
 * the evidence + verdict.
 *
 *   tsx packages/operator-core/lib/workspace-host/outage-drill-cli.ts \
 *     --project <p> --zone <z> --instance <name> --instance-id <id> --network <net> \
 *     --host-id <host-…> --workspace-dir <dir> [--agent <cli>] [--nonce <n>] [--out <evidence.json>]
 *
 *   tsx packages/operator-core/lib/workspace-host/outage-drill-cli.ts --cloud aws \
 *     --region <r> --instance-id <i-…> [--aws-profile <p>] \
 *     --host-id <host-…> --workspace-dir <dir> [--agent <cli>] [--nonce <n>] [--out <evidence.json>]
 *
 * --agent-kind claude|omp (default claude) picks the agent's argv; OMP runs on the host's local inference.
 * Measured 2026-10-03: OMP on the pinned local model returns a final answer without a tool call, so an
 * OMP gated task cannot pass on any customer-cloud host today (WI-10005804; R-13 requires Claude only, D-033).
 * --mode task runs ONLY the gated agent task, with no egress block (no --network, no database needed):
 * the agent reads a secret from its gate pipe and writes sha256(secret). It is controller-pushed over
 * SSH, so its evidence is labelled that way (aws-byoc-gcp-parity-2026-10-01 R-13, D-031).
 *
 * On AWS the drill reaches the host by SSH over SSM and blocks egress with deny entries on the
 * network ACL of the instance's subnet, which it looks up from the instance.
 *
 * --agent is the agent CLI on the host, invoked with the argv agentTaskInvocation (outage-drill.ts) builds
 * for --agent-kind (claude: `<cli> -p <prompt> --allowedTools Bash,Write`). A
 * hosted host ships only the local-inference agent (D-250); the customer connects their own model
 * account, so point --agent at a wrapper that runs claude with that account's credential.
 *
 * Needs HARNESS_ADMIN_DATABASE_URL (the hosted connector heartbeat lives in
 * papercusp_auth.hosted_workspace_connectors) and the controller's IAP SSH key + known_hosts
 * under ~/.local/state/papercusp/controller, exactly as the controller reaches the host. It only
 * ever blocks egress on the named host network; it never touches shared Papercusp services.
 * Exit code: 0 = drill passed, 1 = drill failed, 2 = usage.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve4 } from 'node:dns/promises';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { isCliEntry } from '../util/cli-entry';
import { awsSsmHostKeyAlias, gcpIapHostKeyAlias } from './gcp-iap-initialization-operations';
import { buildAwsSsmProxyCommand } from './local-connection-manager';
import {
  awsSubnetNetworkAcl,
  evaluateGatedAgentTask,
  evaluateOutageDrill,
  runGatedAgentTask,
  runOutageDrill,
  type AwsEgressBlockTarget,
  type GatedAgentKind,
  type GatedAgentTaskConfig,
  type HostCommandResult,
  type OutageDrillConfig,
} from './outage-drill';

const WORKSPACE_ACCOUNT = 'papercusp-workspace';
const DEFAULT_AGENTS: Record<GatedAgentKind, string> = {
  claude: '/usr/local/lib/papercusp-agent-toolchain/bin/claude',
  omp: '/usr/local/bin/omp',
};

interface SshTarget {
  readonly alias: string;
  readonly destination: string;
  readonly proxyCommand: string;
}

/** Run a command on the host as the workspace account, over the controller's SSH (IAP or SSM proxy). */
function sshHostExec(ssh: SshTarget): (command: string) => Promise<HostCommandResult> {
  const controller = join(homedir(), '.local/state/papercusp/controller');
  return (command) =>
    run('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${join(controller, 'known_hosts')}`, '-o', `HostKeyAlias=${ssh.alias}`,
      '-o', 'IdentitiesOnly=yes', '-i', join(controller, 'id_ed25519'), '-o', 'ConnectTimeout=30',
      '-o', `ProxyCommand=${ssh.proxyCommand}`,
      `${WORKSPACE_ACCOUNT}@${ssh.destination}`, command,
    ], 90_000);
}

function run(file: string, args: readonly string[], timeoutMs: number): Promise<HostCommandResult> {
  return new Promise((resolvePromise) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** The network ACL on the AWS host's subnet, looked up from the instance. */
async function resolveAwsTarget(region: string, instanceId: string, profileArgs: readonly string[]): Promise<AwsEgressBlockTarget> {
  const aws = (args: readonly string[]) => run('aws', [...args, '--region', region, ...profileArgs, '--output', 'json'], 60_000);
  const described = await aws(['ec2', 'describe-instances', '--instance-ids', instanceId, '--query', 'Reservations[0].Instances[0].SubnetId']);
  if (described.code !== 0) throw new Error(`describe-instances failed: ${described.stderr.trim()}`);
  const subnetId: unknown = JSON.parse(described.stdout);
  if (typeof subnetId !== 'string' || !subnetId.startsWith('subnet-')) throw new Error(`instance ${instanceId} reports no subnet`);
  const acls = await aws(['ec2', 'describe-network-acls', '--filters', `Name=association.subnet-id,Values=${subnetId}`]);
  if (acls.code !== 0) throw new Error(`describe-network-acls failed: ${acls.stderr.trim()}`);
  return { cloud: 'aws', region, ...awsSubnetNetworkAcl(acls.stdout, subnetId) };
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`bad argument near ${key ?? '<end>'}`);
    args.set(key.slice(2), value);
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Map<string, string>;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(String(error));
    return 2;
  }
  const need = (key: string) => {
    const value = args.get(key);
    if (!value) throw new Error(`--${key} is required`);
    return value;
  };
  let config: OutageDrillConfig | null = null;
  let task: GatedAgentTaskConfig | null = null;
  let ssh: SshTarget;
  let cloudCli: 'gcloud' | 'aws';
  let cloudArgsSuffix: string[] = [];
  let hostId: string;
  try {
    const cloud = args.get('cloud') ?? 'gcp';
    hostId = need('host-id');
    const nonce = args.get('nonce') ?? `j5${randomBytes(6).toString('hex')}`;
    // --mode task runs only the gated agent task: no egress block, so no block target and no database.
    const mode = args.get('mode') ?? 'drill';
    if (mode !== 'drill' && mode !== 'task') throw new Error(`--mode must be drill or task, got ${mode}`);
    const agentKind = args.get('agent-kind') ?? 'claude';
    if (agentKind !== 'claude' && agentKind !== 'omp') throw new Error(`--agent-kind must be claude or omp, got ${agentKind}`);
    const agentCommand = args.get('agent') ?? DEFAULT_AGENTS[agentKind];
    const workspaceDir = need('workspace-dir');
    const secret = randomBytes(16).toString('hex');
    let target: OutageDrillConfig['target'] | null = null;
    if (cloud === 'gcp') {
      const project = need('project');
      const zone = need('zone');
      const instance = need('instance');
      ssh = {
        alias: gcpIapHostKeyAlias({ projectId: project, zone, instanceName: instance, instanceId: need('instance-id') }),
        destination: instance,
        proxyCommand: `gcloud compute start-iap-tunnel %h %p --listen-on-stdin --project=${project} --zone=${zone} --verbosity=error`,
      };
      cloudCli = 'gcloud';
      if (mode === 'drill') {
        target = { cloud: 'gcp', project, network: need('network'), ruleName: `pc-j5-outage-drill-${nonce}`.toLowerCase().slice(0, 63) };
      }
    } else if (cloud === 'aws') {
      const region = need('region');
      const instanceId = need('instance-id');
      const awsProfile = args.get('aws-profile');
      ssh = { alias: awsSsmHostKeyAlias({ region, instanceId }), destination: instanceId, proxyCommand: buildAwsSsmProxyCommand({ region, awsProfile }) };
      cloudCli = 'aws';
      cloudArgsSuffix = awsProfile ? ['--profile', awsProfile] : [];
      if (mode === 'drill') target = await resolveAwsTarget(region, instanceId, cloudArgsSuffix);
    } else {
      throw new Error(`--cloud must be gcp or aws, got ${cloud}`);
    }
    if (mode === 'task') {
      task = { agentKind, agentCommand, workspaceDir, nonce, secret };
    } else {
      if (target === null) throw new Error('the drill has no egress block target');
      config = {
        target,
        papercuspOrigin: args.get('papercusp-origin') ?? 'https://app.papercusp.com',
        modelProviderOrigin: args.get('model-origin') ?? 'https://api.anthropic.com',
        serviceUnit: args.get('service') ?? 'papercusp-workspace.service',
        agentCommand,
        agentKind,
        workspaceDir,
        nonce,
        secret,
      };
    }
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    return 2;
  }
  const hostExec = sshHostExec(ssh);
  const log = (line: string) => console.error(`[j5] ${new Date().toISOString()} ${line}`);
  if (task !== null) {
    const evidence = await runGatedAgentTask(task, {
      hostExec,
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      now: () => new Date(),
      log,
    });
    const verdict = evaluateGatedAgentTask(evidence);
    const report = JSON.stringify({ hostId, mode: 'task', task, evidence, verdict }, null, 2);
    const out = args.get('out');
    if (out) writeFileSync(out, `${report}\n`);
    console.log(report);
    return verdict.passed ? 0 : 1;
  }
  if (config === null) {
    console.error('the drill has no configuration');
    return 2;
  }
  const databaseUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
  if (!databaseUrl) {
    console.error('HARNESS_ADMIN_DATABASE_URL is required');
    return 2;
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const evidence = await runOutageDrill(config, {
      hostExec,
      cloudExec: (cloudArgs) => run(cloudCli, [...cloudArgs, ...cloudArgsSuffix], 120_000),
      resolveAddresses: (hostname) => resolve4(hostname),
      readConnectorLastSeenAt: async () => {
        const rows = await sql<{ seen: Date | null }[]>`
          SELECT max(heartbeat_at) AS seen FROM papercusp_auth.hosted_workspace_connectors
           WHERE host_id = ${hostId} AND revoked_at IS NULL`;
        return rows[0]?.seen ?? null;
      },
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
      now: () => new Date(),
      log,
    });
    const verdict = evaluateOutageDrill(evidence);
    const report = JSON.stringify({ hostId, config, evidence, verdict }, null, 2);
    const out = args.get('out');
    if (out) writeFileSync(out, `${report}\n`);
    console.log(report);
    return verdict.passed ? 0 : 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
