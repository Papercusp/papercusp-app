/**
 * J5 outage drill (plan aws-byoc-gcp-parity-2026-10-01 P-017, moved from BYOC R-6 per
 * byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-445): prove that an agent task on a running
 * workspace host completes with its output intact while every Papercusp service the host talks
 * to is unreachable, and that the host reconnects once Papercusp is back.
 *
 * What a running host calls back to (code inventory, 2026-10-02):
 *  - the hosted connector: one long-lived wss socket to PAPERCUSP_HOSTED_CONTROL_PLANE_URL
 *    (hosted-workspace-host-runtime.ts `readHostedWorkspaceHostConfig`), carrying the desktop
 *    relay, audit events, relay-usage and membership reports. Enrollment posts once to
 *    `$ORIGIN/api/hosted/connectors/register` (workspace-host-bootstrap.ts) at bring-up only.
 *  - NOT Papercusp: the agent's model calls go straight to the model provider with a projected
 *    access token (workspace-host-agent-home.ts neutralizes the refresh token, so the host never
 *    asks Papercusp for a fresh one mid-task). Credential rotation, upgrades, health attestation
 *    and soak probes are all PUSHED by the controller over IAP SSH, so the host does not depend on
 *    them while it runs.
 * The live half of the inventory is measured by `inventoryHostConnections` on the real host.
 *
 * How the outage is made: an EGRESS DENY firewall rule on the canary host's OWN network for the
 * addresses the Papercusp origin resolves to at drill time (derived, never a hand-kept range
 * list). Stopping the shared control plane instead would take down every other host's connector
 * too, so the drill never does that.
 *  - GCP: one EGRESS DENY VPC firewall rule on the host network. IAP SSH keeps working: it is
 *    ingress from Google's IAP range and its replies are allowed by the stateful firewall.
 *  - AWS: one DENY egress entry per address on the network ACL of the host stack's private subnet
 *    (hosted-aws-host-stack.ts builds that VPC for workspace hosts only). A security group cannot
 *    express a deny, and the ACL is stateless, so it also cuts the connector socket already open.
 *    SSH over SSM keeps working: the tunnel runs to the regional SSM endpoint, not to Papercusp.
 *
 * Every side effect is injected (`OutageDrillDeps`), so the sequencing and the verdict are unit
 * tested and the live run differs only in its deps.
 */
import { createHash } from 'node:crypto';
import { WORKSPACE_HOST_OMP_LOCAL_MODEL } from '@papercusp/deployment-driver';

/** One established TCP connection the host holds, as `ss -Htn state established` reports it. */
export interface HostConnection {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
}

export type ConnectionClass = 'papercusp' | 'model-provider' | 'other';

export interface ClassifiedConnection extends HostConnection {
  readonly class: ConnectionClass;
}

/** Strip IPv6 brackets and the v4-mapped prefix so `[::ffff:1.2.3.4]` compares as `1.2.3.4`. */
export function normalizeAddress(raw: string): string {
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  return unbracketed.toLowerCase().startsWith('::ffff:') ? unbracketed.slice(7) : unbracketed;
}

function splitEndpoint(token: string): { address: string; port: number } | null {
  const colon = token.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = Number(token.slice(colon + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  return { address: normalizeAddress(token.slice(0, colon)), port };
}

/**
 * Parse `ss -Htn state established` output. With a state filter ss omits the State column, so a
 * row is `Recv-Q Send-Q Local:Port Peer:Port [process]`; rows that do not parse are dropped rather
 * than guessed at.
 */
export function parseEstablishedConnections(ssOutput: string): HostConnection[] {
  const connections: HostConnection[] = [];
  for (const line of ssOutput.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = splitEndpoint(fields[2]!);
    const remote = splitEndpoint(fields[3]!);
    if (!local || !remote) continue;
    connections.push({
      localAddress: local.address,
      localPort: local.port,
      remoteAddress: remote.address,
      remotePort: remote.port,
    });
  }
  return connections;
}

export function classifyConnections(
  connections: readonly HostConnection[],
  addresses: { readonly papercusp: readonly string[]; readonly modelProvider: readonly string[] },
): ClassifiedConnection[] {
  const papercusp = new Set(addresses.papercusp.map(normalizeAddress));
  const model = new Set(addresses.modelProvider.map(normalizeAddress));
  return connections.map((connection) => ({
    ...connection,
    class: papercusp.has(connection.remoteAddress)
      ? 'papercusp'
      : model.has(connection.remoteAddress)
        ? 'model-provider'
        : 'other',
  }));
}

/** One reversible network change: the cloud-CLI argv that applies it and the argv that undoes it. */
export interface EgressBlockStep {
  readonly createArgs: readonly string[];
  readonly deleteArgs: readonly string[];
}

/**
 * The drill's egress block on the host's own network. Every step must apply for the outage to exist,
 * and every step that applied is undone afterwards, even when a later step failed. GCP needs one
 * firewall rule; AWS needs one network-ACL entry per address, because an ACL entry holds one CIDR.
 */
export interface EgressBlock {
  readonly name: string;
  readonly steps: readonly EgressBlockStep[];
}

/** The gcloud argv that creates and deletes the drill's GCP egress deny rule. */
export interface EgressDenyRule extends EgressBlockStep {
  readonly name: string;
}

/** Where the drill blocks egress: the GCP host network, or the network ACL on the AWS host subnet. */
export type EgressBlockTarget = GcpEgressBlockTarget | AwsEgressBlockTarget;

export interface GcpEgressBlockTarget {
  readonly cloud: 'gcp';
  readonly project: string;
  readonly network: string;
  readonly ruleName: string;
}

/** One existing EGRESS entry of a network ACL, as `aws ec2 describe-network-acls` reports it. */
export interface AwsNetworkAclEntry {
  readonly ruleNumber: number;
  readonly ruleAction: 'allow' | 'deny';
}

export interface AwsEgressBlockTarget {
  readonly cloud: 'aws';
  readonly region: string;
  /** The network ACL associated with the host's subnet (the host stack's dedicated private subnet). */
  readonly networkAclId: string;
  /** That ACL's current egress entries, so the drill's entries take free numbers ahead of every allow. */
  readonly egressEntries: readonly AwsNetworkAclEntry[];
}

const RULE_NAME = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const NETWORK_ACL_ID = /^acl-[0-9a-f]{8,17}$/;
/** The highest rule number a network ACL entry may carry. */
const AWS_ACL_MAX_RULE_NUMBER = 32_766;

/** The deduplicated, sorted IPv4 addresses to block; refuses an empty set and any non-IPv4 address. */
function blockableAddresses(addresses: readonly string[]): string[] {
  const ranges = [...new Set(addresses.map(normalizeAddress))].sort();
  if (ranges.length === 0) throw new Error('outage drill: no Papercusp addresses to block');
  for (const address of ranges) {
    const match = IPV4.exec(address);
    if (!match || match.slice(1).some((octet) => Number(octet) > 255)) {
      throw new Error(`outage drill: ${address} is not an IPv4 address (the drill blocks IPv4 only)`);
    }
  }
  return ranges;
}

/**
 * AWS: one DENY egress entry per address on the host subnet's network ACL. ACL entries are evaluated
 * lowest number first, so each deny takes a free number below the ACL's first ALLOW egress entry.
 * ACLs are stateless, so the deny also cuts the connector socket that is already open, the same
 * outcome the GCP rule produces. Like the GCP rule, it covers every instance on that subnet.
 */
export function buildAwsNetworkAclEgressDeny(target: AwsEgressBlockTarget, addresses: readonly string[]): EgressBlock {
  if (!AWS_REGION.test(target.region)) throw new Error(`outage drill: invalid AWS region ${target.region}`);
  if (!NETWORK_ACL_ID.test(target.networkAclId)) throw new Error(`outage drill: invalid network ACL id ${target.networkAclId}`);
  const ranges = blockableAddresses(addresses);
  const used = new Set(target.egressEntries.map((entry) => entry.ruleNumber));
  const allows = target.egressEntries
    .filter((entry) => entry.ruleAction === 'allow' && entry.ruleNumber <= AWS_ACL_MAX_RULE_NUMBER)
    .map((entry) => entry.ruleNumber);
  const ceiling = allows.length > 0 ? Math.min(...allows) : AWS_ACL_MAX_RULE_NUMBER + 1;
  const numbers: number[] = [];
  for (let candidate = 1; candidate < ceiling && numbers.length < ranges.length; candidate += 1) {
    if (!used.has(candidate)) numbers.push(candidate);
  }
  if (numbers.length < ranges.length) {
    throw new Error(
      `outage drill: network ACL ${target.networkAclId} has ${numbers.length} free egress rule number(s) below its first allow (rule ${ceiling}); ${ranges.length} needed`,
    );
  }
  const scope = ['--region', target.region, '--network-acl-id', target.networkAclId, '--egress'];
  return {
    name: `${target.networkAclId} egress deny rules ${numbers.join(',')}`,
    steps: ranges.map((address, index) => {
      const ruleNumber = String(numbers[index]);
      return {
        createArgs: [
          'ec2', 'create-network-acl-entry', ...scope, '--rule-number', ruleNumber,
          '--protocol', '-1', '--rule-action', 'deny', '--cidr-block', `${address}/32`,
        ],
        deleteArgs: ['ec2', 'delete-network-acl-entry', ...scope, '--rule-number', ruleNumber],
      };
    }),
  };
}

/**
 * The network ACL governing `subnetId` and its egress entries, read from the JSON of
 * `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<subnetId>`.
 * A subnet has exactly one ACL; anything else means the lookup went wrong, so it refuses.
 */
export function awsSubnetNetworkAcl(
  describeJson: string,
  subnetId: string,
): { networkAclId: string; egressEntries: AwsNetworkAclEntry[] } {
  const parsed = JSON.parse(describeJson) as {
    NetworkAcls?: Array<{
      NetworkAclId?: string;
      Associations?: Array<{ SubnetId?: string }>;
      Entries?: Array<{ RuleNumber?: number; RuleAction?: string; Egress?: boolean }>;
    }>;
  };
  const matches = (parsed.NetworkAcls ?? []).filter((acl) =>
    (acl.Associations ?? []).some((association) => association.SubnetId === subnetId));
  if (matches.length !== 1 || typeof matches[0]?.NetworkAclId !== 'string') {
    throw new Error(`outage drill: expected one network ACL for ${subnetId}, found ${matches.length}`);
  }
  const egressEntries = (matches[0].Entries ?? [])
    .filter((entry) => entry.Egress === true && typeof entry.RuleNumber === 'number')
    .map((entry) => ({
      ruleNumber: entry.RuleNumber as number,
      ruleAction: entry.RuleAction === 'allow' ? 'allow' as const : 'deny' as const,
    }));
  return { networkAclId: matches[0].NetworkAclId, egressEntries };
}

/** The block for the target's cloud: argv for gcloud (GCP) or the aws CLI (AWS). */
export function buildEgressBlock(target: EgressBlockTarget, addresses: readonly string[]): EgressBlock {
  if (target.cloud === 'aws') return buildAwsNetworkAclEgressDeny(target, addresses);
  const rule = buildEgressDenyRule({ ...target, addresses });
  return { name: rule.name, steps: [rule] };
}

export function buildEgressDenyRule(input: {
  readonly project: string;
  readonly network: string;
  readonly ruleName: string;
  readonly addresses: readonly string[];
}): EgressDenyRule {
  if (!RULE_NAME.test(input.ruleName)) throw new Error(`outage drill: invalid firewall rule name ${input.ruleName}`);
  const ranges = blockableAddresses(input.addresses);
  const scope = ['--project', input.project];
  return {
    name: input.ruleName,
    createArgs: [
      'compute', 'firewall-rules', 'create', input.ruleName, ...scope,
      '--network', input.network, '--direction', 'EGRESS', '--action', 'DENY', '--rules', 'all',
      '--priority', '0', '--destination-ranges', ranges.map((address) => `${address}/32`).join(','),
      '--description', 'Papercusp J5 outage drill: temporary block of Papercusp services',
    ],
    deleteArgs: ['compute', 'firewall-rules', 'delete', input.ruleName, ...scope, '--quiet'],
  };
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface HostCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OutageDrillDeps {
  /** Run a shell command ON the host as the workspace account (IAP SSH in production). */
  readonly hostExec: (command: string) => Promise<HostCommandResult>;
  /** Run the target cloud's CLI with argv, no shell: gcloud for a GCP target, aws for an AWS target. */
  readonly cloudExec: (args: readonly string[]) => Promise<HostCommandResult>;
  /** A/AAAA records for a hostname, as seen from the drill runner. */
  readonly resolveAddresses: (hostname: string) => Promise<string[]>;
  /**
   * When the control plane last heard from this host's connector (its heartbeat), or null if
   * never. A value newer than the lift is the proof that the host reconnected.
   */
  readonly readConnectorLastSeenAt: () => Promise<Date | null>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly log?: (line: string) => void;
}

export interface OutageDrillConfig {
  /** Where the egress block goes: the GCP host network or the AWS host subnet's network ACL. */
  readonly target: EgressBlockTarget;
  /** The Papercusp origin the host's connector dials, e.g. https://app.papercusp.com. */
  readonly papercuspOrigin: string;
  /** The model provider endpoint the agent calls directly, e.g. https://api.anthropic.com. */
  readonly modelProviderOrigin: string;
  /** systemd unit of the host's Papercusp service. */
  readonly serviceUnit: string;
  /** Absolute agent CLI path on the host. */
  readonly agentCommand: string;
  /** Which CLI `agentCommand` is; selects its argv. Default 'claude'. */
  readonly agentKind?: GatedAgentKind;
  /** Workspace directory on the host the agent writes into. */
  readonly workspaceDir: string;
  /** Unique per run; names the drill's files on the host. */
  readonly nonce: string;
  /**
   * The value handed to the agent through its gate pipe once the outage is confirmed. The agent's output
   * must be sha256(secret). It never appears in the prompt or in any file name, so the agent can only learn
   * it by reading the pipe during the outage.
   */
  readonly secret: string;
  readonly agentTimeoutMs?: number;
  /** How long the drill waits for the agent to open its gate pipe. Must stay under the host-exec timeout. */
  readonly gateTimeoutSeconds?: number;
  readonly reconnectTimeoutMs?: number;
  readonly pollMs?: number;
}

export interface OutageDrillEvidence {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly papercuspAddresses: string[];
  readonly modelProviderAddresses: string[];
  readonly before: { readonly connections: ClassifiedConnection[]; readonly connectorLastSeenAt: string | null };
  readonly blockedAt: string | null;
  readonly during: {
    readonly papercuspReachable: boolean | null;
    readonly modelProviderReachable: boolean | null;
    readonly agentRunningWhenBlocked: boolean | null;
    readonly serviceActive: boolean | null;
    readonly papercuspConnectionsWhileBlocked: number | null;
  };
  readonly agent: {
    readonly exitCode: number | null;
    readonly output: string | null;
    readonly expected: string;
    /** When the agent read its secret from the gate pipe; null if it never did. */
    readonly gateReleasedAt: string | null;
    readonly completedAt: string | null;
  };
  readonly liftedAt: string | null;
  readonly after: {
    readonly connectorLastSeenAt: string | null;
    readonly papercuspConnections: number | null;
    readonly serviceActive: boolean | null;
  };
  readonly ruleDeleted: boolean;
  readonly errors: string[];
}

export interface OutageDrillVerdict {
  readonly passed: boolean;
  readonly failures: string[];
}

/** Judge the evidence. Every check is stated as what a pass requires, so a failure names itself. */
export function evaluateOutageDrill(evidence: OutageDrillEvidence): OutageDrillVerdict {
  const failures: string[] = [...evidence.errors.map((error) => `drill error: ${error}`)];
  const require = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };
  require(evidence.papercuspAddresses.length > 0, 'the Papercusp origin resolved to no address');
  require(
    evidence.before.connections.some((connection) => connection.class === 'papercusp'),
    'before the block the host held no connection to Papercusp, so blocking it proves nothing',
  );
  require(evidence.blockedAt !== null, 'the egress block was never applied');
  require(evidence.during.papercuspReachable === false, 'Papercusp was still reachable from the host during the block');
  require(evidence.during.modelProviderReachable === true, 'the model provider was not reachable during the block');
  require(evidence.during.agentRunningWhenBlocked === true, 'the agent task was not running when the block landed');
  require(evidence.during.serviceActive === true, "the host's Papercusp service was not active during the block");
  require(
    evidence.agent.gateReleasedAt !== null && evidence.blockedAt !== null && evidence.agent.gateReleasedAt > evidence.blockedAt,
    'the agent was never handed its secret during the outage',
  );
  require(evidence.agent.exitCode === 0, `the agent task exited ${evidence.agent.exitCode ?? 'never'}`);
  require(evidence.agent.output === evidence.agent.expected, 'the agent output is missing or not the expected digest');
  require(
    evidence.agent.completedAt !== null && evidence.liftedAt !== null && evidence.agent.completedAt <= evidence.liftedAt,
    'the agent task did not complete before the block was lifted',
  );
  require(evidence.ruleDeleted, 'the egress block was not removed');
  require(
    evidence.liftedAt !== null &&
      evidence.after.connectorLastSeenAt !== null &&
      evidence.after.connectorLastSeenAt > evidence.liftedAt,
    "the control plane did not hear from the host's connector after the block was lifted",
  );
  require((evidence.after.papercuspConnections ?? 0) > 0, 'after the lift the host held no connection to Papercusp');
  require(evidence.after.serviceActive === true, "the host's Papercusp service was not active after the lift");
  return { passed: failures.length === 0, failures };
}

/**
 * One gated agent task on a workspace host, with no outage: the drill's agent half on its own
 * (aws-byoc-gcp-parity-2026-10-01 R-13 as rescoped by D-031). The agent learns its secret only by
 * reading the gate pipe, so a matching digest proves it ran its tools on the host and finished.
 * The host is reached over SSH by the caller, so this is controller-pushed, not product-path dispatch.
 */
export interface GatedAgentTaskConfig {
  readonly agentKind: GatedAgentKind;
  readonly agentCommand: string;
  readonly workspaceDir: string;
  readonly nonce: string;
  readonly secret: string;
  readonly agentTimeoutMs?: number;
  readonly gateTimeoutSeconds?: number;
  readonly pollMs?: number;
}

export type GatedAgentTaskDeps = Pick<OutageDrillDeps, 'hostExec' | 'sleep' | 'now' | 'log'>;

export interface GatedAgentTaskEvidence {
  readonly agentKind: GatedAgentKind;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outputPath: string;
  /** The exact command the host ran, prompt included. Recorded so a grader can see the secret is not in it. */
  readonly invocation: string;
  /** True when the secret occurs in the invocation; a task that saw its secret in the prompt proves nothing. */
  readonly secretInInvocation: boolean;
  readonly agent: OutageDrillEvidence['agent'];
  readonly errors: string[];
}

/** Run one gated agent task. Never throws: failures land in `evidence.errors` for the verdict. */
export async function runGatedAgentTask(config: GatedAgentTaskConfig, deps: GatedAgentTaskDeps): Promise<GatedAgentTaskEvidence> {
  const log = deps.log ?? (() => {});
  const iso = () => deps.now().toISOString();
  const pollMs = config.pollMs ?? 5_000;
  const outputPath = `${config.workspaceDir}/agent-task-${config.nonce}.txt`;
  const exitFile = FLAG_FILE(config.workspaceDir, config.nonce, 'exit');
  const gatePath = FLAG_FILE(config.workspaceDir, config.nonce, 'gate');
  const invocation = agentTaskInvocation(config.agentKind, config.agentCommand, agentTaskPrompt(gatePath, outputPath));
  const errors: string[] = [];
  const evidence = {
    agentKind: config.agentKind,
    startedAt: iso(),
    finishedAt: '',
    outputPath,
    invocation,
    secretInInvocation: invocation.includes(config.secret),
    agent: {
      exitCode: null as number | null,
      output: null as string | null,
      expected: sha256Hex(config.secret),
      gateReleasedAt: null as string | null,
      completedAt: null as string | null,
    },
    errors,
  };
  try {
    const started = await deps.hostExec(
      gatedAgentLaunchCommand({
        workspaceDir: config.workspaceDir,
        gatePath,
        exitFile,
        logFile: FLAG_FILE(config.workspaceDir, config.nonce, 'log'),
        invocation,
      }),
    );
    if (started.code !== 0) throw new Error(`agent launch failed (exit ${started.code}): ${started.stderr.trim()}`);
    log(`${config.agentKind} task started`);
    await releaseGate(deps.hostExec, gatePath, config.secret, config.gateTimeoutSeconds ?? 60);
    evidence.agent.gateReleasedAt = iso();
    log(`gate released at ${evidence.agent.gateReleasedAt}`);
    const result = await awaitAgentResult(deps, {
      exitFile,
      outputPath,
      timeoutMs: config.agentTimeoutMs ?? 15 * 60_000,
      pollMs,
    });
    if (result === null) errors.push('the agent task did not finish before its deadline');
    else {
      evidence.agent.exitCode = result.exitCode;
      evidence.agent.completedAt = iso();
      evidence.agent.output = result.output;
    }
  } catch (error) {
    errors.push(String(error instanceof Error ? error.message : error));
  } finally {
    await deps.hostExec(`rm -f ${shellQuote(gatePath)}`).catch(() => undefined);
  }
  evidence.finishedAt = iso();
  return evidence;
}

export function evaluateGatedAgentTask(evidence: GatedAgentTaskEvidence): OutageDrillVerdict {
  const failures: string[] = [...evidence.errors.map((error) => `task error: ${error}`)];
  const require = (ok: boolean, message: string) => {
    if (!ok) failures.push(message);
  };
  require(!evidence.secretInInvocation, 'the secret appears in the agent invocation, so the output proves nothing');
  require(evidence.agent.gateReleasedAt !== null, 'the agent never read its secret from the gate pipe');
  require(evidence.agent.exitCode === 0, `the agent task exited ${evidence.agent.exitCode ?? 'never'}`);
  require(evidence.agent.output === evidence.agent.expected, 'the agent output is missing or not the expected digest');
  return { passed: failures.length === 0, failures };
}

function hostnameOf(origin: string): string {
  return new URL(origin).hostname;
}

/** Single-quote a value for the host's POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The agent task: a deliberate wait (so the block lands mid-task), then a computed, checkable file. */
/**
 * The agent's task. Its first tool call blocks reading a named pipe that the drill fills only once the
 * outage is confirmed, so the agent is provably mid-task when Papercusp disappears, and everything after
 * that read (a model round trip, more tool calls, the file write) happens during the outage. The prompt
 * never carries the value. There is no sleep: agent CLIs refuse a long foreground sleep (measured
 * 2026-10-02 on host-19ff2a97befd83b51d2306fd: Claude Code backgrounded `sleep 90`, then exited 0 without
 * doing the task).
 */
export function agentTaskPrompt(gatePath: string, outputPath: string): string {
  return [
    `Use the Bash tool to run exactly: cat ${gatePath}`,
    'That command waits until a value is written to the pipe, then prints the value.',
    'Then use the Bash tool to compute the SHA-256 hex digest of exactly that printed value (no trailing newline),',
    'with: printf %s <the printed value> | sha256sum',
    `Then write only that 64-character hex digest, with no other text, to the file ${outputPath}.`,
    'Reply DONE when the file is written.',
  ].join(' ');
}

/** Printed by {@link gateReleaseCommand} only once the agent has taken its secret off the pipe. */
export const GATE_RELEASED_MARKER = 'j5-gate-released';

/**
 * The host command that hands the agent its secret through the gate pipe.
 *
 * The write blocks until the agent's `cat` opens the pipe. After that the agent CLI may open the same path
 * AGAIN: Claude Code re-reads a file it saw `cat` read, and opening a FIFO for reading blocks until a writer
 * opens it. Measured 2026-10-02 on host-19ff2a97befd83b51d2306fd (drill run #4): with the writer gone, a
 * Claude Code thread sat in the kernel's `wait_for_partner` for 5 minutes and the task never got its tool
 * result; one extra open-for-write released it at once. So once the secret is taken, the pipe is renamed
 * aside and a regular empty file takes its path (a later re-open reads that and never blocks), and a reader
 * already waiting on the pipe itself is served end-of-file through the renamed path.
 */
export function gateReleaseCommand(gatePath: string, secret: string): string {
  const gate = shellQuote(gatePath);
  const served = shellQuote(`${gatePath}.served`);
  return [
    `printf %s ${shellQuote(secret)} > ${gate} && echo ${GATE_RELEASED_MARKER}`,
    `mv -f ${gate} ${served}`,
    `: > ${gate}`,
    `timeout 2 sh -c ${shellQuote(`: > ${served}`)}`,
    `rm -f ${served}`,
  ].join('; ');
}

const FLAG_FILE = (dir: string, nonce: string, suffix: string) => `${dir}/.j5-drill-${nonce}.${suffix}`;

/** The agent CLI a gated task runs. Each kind has its own non-interactive argv. */
export type GatedAgentKind = 'claude' | 'omp';

/**
 * The shell command that runs ONE gated agent task non-interactively with shell and file-write tools.
 *
 * Claude Code: `-p <prompt> --allowedTools Bash,Write`. OMP on a customer-cloud host is credential-free
 * and runs on the host's own local inference (D-230), so it is pinned to the model the host's readiness
 * probe uses (workspace-host-agent-authentication.ts) and its tools are auto-approved: `--print` has no
 * one to approve them.
 */
export function agentTaskInvocation(kind: GatedAgentKind, agentCommand: string, prompt: string): string {
  if (kind === 'claude') return `${shellQuote(agentCommand)} -p ${shellQuote(prompt)} --allowedTools Bash,Write`;
  return [
    shellQuote(agentCommand),
    '--model', shellQuote(`ollama/${WORKSPACE_HOST_OMP_LOCAL_MODEL}`),
    '--print', '--tools', 'bash,write', '--approval-mode', 'yolo',
    '--no-session', '--no-extensions', '--no-skills', '--no-rules', '--mode', 'text',
    shellQuote(prompt),
  ].join(' ');
}

/**
 * Start the agent detached, blocked on its gate pipe. Its exit code lands in a file so a dropped SSH
 * session cannot lose it.
 *
 * The `&` MUST be scoped to the agent alone. A bare trailing `&` backgrounds the WHOLE `&&` list as a
 * subshell that keeps the SSH channel's stdout/stderr and waits for the agent, so the launch call returns
 * only when the agent exits (measured 2026-10-02: run #1 returned at the agent's exit, run #2 hit the SSH
 * timeout and the block never ran).
 */
export function gatedAgentLaunchCommand(input: {
  readonly workspaceDir: string;
  readonly gatePath: string;
  readonly exitFile: string;
  readonly logFile: string;
  readonly invocation: string;
}): string {
  return (
    `cd ${shellQuote(input.workspaceDir)} && rm -f ${shellQuote(input.exitFile)} ${shellQuote(input.gatePath)} && ` +
    `mkfifo -m 600 ${shellQuote(input.gatePath)} && ` +
    `{ nohup sh -c ${shellQuote(
      `${input.invocation} > ${shellQuote(input.logFile)} 2>&1; echo $? > ${shellQuote(input.exitFile)}`,
    )} < /dev/null > /dev/null 2>&1 & }`
  );
}

/** Hand the agent its secret. Throws when the agent never opened its gate pipe within the timeout. */
async function releaseGate(
  hostExec: OutageDrillDeps['hostExec'],
  gatePath: string,
  secret: string,
  gateSeconds: number,
): Promise<void> {
  const released = await hostExec(`timeout ${gateSeconds} sh -c ${shellQuote(gateReleaseCommand(gatePath, secret))}`);
  if (!released.stdout.includes(GATE_RELEASED_MARKER)) {
    throw new Error(`the agent never read its gate pipe within ${gateSeconds}s (exit ${released.code})`);
  }
}

/** Wait for the agent's exit file, then read its output. `null` when the deadline passed first. */
async function awaitAgentResult(
  deps: Pick<OutageDrillDeps, 'hostExec' | 'sleep' | 'now'>,
  input: { readonly exitFile: string; readonly outputPath: string; readonly timeoutMs: number; readonly pollMs: number },
): Promise<{ exitCode: number; output: string | null } | null> {
  const deadline = deps.now().getTime() + input.timeoutMs;
  while (deps.now().getTime() < deadline) {
    const exitText = (await deps.hostExec(`cat ${shellQuote(input.exitFile)} 2>/dev/null`)).stdout.trim();
    if (exitText !== '') {
      const output = await deps.hostExec(`cat ${shellQuote(input.outputPath)} 2>/dev/null`);
      return { exitCode: Number(exitText), output: output.code === 0 ? output.stdout.trim() : null };
    }
    await deps.sleep(input.pollMs);
  }
  return null;
}

/** Run the drill end to end. Never throws: failures land in `evidence.errors` for the verdict. */
export async function runOutageDrill(config: OutageDrillConfig, deps: OutageDrillDeps): Promise<OutageDrillEvidence> {
  const log = deps.log ?? (() => {});
  const iso = () => deps.now().toISOString();
  const pollMs = config.pollMs ?? 5_000;
  const outputPath = `${config.workspaceDir}/j5-drill-${config.nonce}.txt`;
  const exitFile = FLAG_FILE(config.workspaceDir, config.nonce, 'exit');
  const gatePath = FLAG_FILE(config.workspaceDir, config.nonce, 'gate');
  const errors: string[] = [];
  const startedAt = iso();

  const ss = async () =>
    parseEstablishedConnections((await deps.hostExec('ss -Htn state established')).stdout);
  const serviceActive = async () =>
    (await deps.hostExec(`systemctl is-active ${shellQuote(config.serviceUnit)}`)).stdout.trim() === 'active';
  const reachable = async (origin: string) =>
    (await deps.hostExec(`curl -sS -o /dev/null --max-time 8 ${shellQuote(origin)}`)).code === 0;

  const papercuspAddresses = await deps.resolveAddresses(hostnameOf(config.papercuspOrigin)).catch((error) => {
    errors.push(`resolve ${config.papercuspOrigin}: ${String(error)}`);
    return [] as string[];
  });
  const modelProviderAddresses = await deps.resolveAddresses(hostnameOf(config.modelProviderOrigin)).catch((error) => {
    errors.push(`resolve ${config.modelProviderOrigin}: ${String(error)}`);
    return [] as string[];
  });
  const overlap = papercuspAddresses.filter((address) => modelProviderAddresses.includes(address));
  if (overlap.length > 0) errors.push(`Papercusp and the model provider share addresses ${overlap.join(',')}`);
  const classify = (connections: HostConnection[]) =>
    classifyConnections(connections, { papercusp: papercuspAddresses, modelProvider: modelProviderAddresses });

  const evidence = {
    startedAt,
    finishedAt: startedAt,
    papercuspAddresses,
    modelProviderAddresses,
    before: { connections: [] as ClassifiedConnection[], connectorLastSeenAt: null as string | null },
    blockedAt: null as string | null,
    during: {
      papercuspReachable: null as boolean | null,
      modelProviderReachable: null as boolean | null,
      agentRunningWhenBlocked: null as boolean | null,
      serviceActive: null as boolean | null,
      papercuspConnectionsWhileBlocked: null as number | null,
    },
    agent: {
      exitCode: null as number | null,
      output: null as string | null,
      expected: sha256Hex(config.secret),
      gateReleasedAt: null as string | null,
      completedAt: null as string | null,
    },
    liftedAt: null as string | null,
    after: { connectorLastSeenAt: null as string | null, papercuspConnections: null as number | null, serviceActive: null as boolean | null },
    ruleDeleted: false,
    errors,
  };

  let block: EgressBlock | null = null;
  // Every step that applied, in order, so the lift undoes a half-applied block too.
  const applied: EgressBlockStep[] = [];
  try {
    if (errors.length > 0) return evidence;
    block = buildEgressBlock(config.target, papercuspAddresses);
    evidence.before.connections = classify(await ss());
    evidence.before.connectorLastSeenAt = (await deps.readConnectorLastSeenAt())?.toISOString() ?? null;
    log(`before: ${evidence.before.connections.filter((c) => c.class === 'papercusp').length} Papercusp connection(s)`);

    // Start the agent detached. It blocks on its gate pipe until the drill hands it the secret during the
    // outage.
    const launch = gatedAgentLaunchCommand({
      workspaceDir: config.workspaceDir,
      gatePath,
      exitFile,
      logFile: FLAG_FILE(config.workspaceDir, config.nonce, 'log'),
      invocation: agentTaskInvocation(config.agentKind ?? 'claude', config.agentCommand, agentTaskPrompt(gatePath, outputPath)),
    });
    const started = await deps.hostExec(launch);
    if (started.code !== 0) throw new Error(`agent launch failed (exit ${started.code}): ${started.stderr.trim()}`);
    log('agent task started');

    for (const step of block.steps) {
      const blocked = await deps.cloudExec(step.createArgs);
      if (blocked.code !== 0) throw new Error(`egress block failed: ${blocked.stderr.trim()}`);
      applied.push(step);
    }
    evidence.blockedAt = iso();
    log(`blocked Papercusp at ${evidence.blockedAt}`);

    // Wait for the rule to take effect: Papercusp unreachable from the host.
    const blockDeadline = deps.now().getTime() + 120_000;
    let papercuspReachable = await reachable(config.papercuspOrigin);
    while (papercuspReachable && deps.now().getTime() < blockDeadline) {
      await deps.sleep(pollMs);
      papercuspReachable = await reachable(config.papercuspOrigin);
    }
    evidence.during.papercuspReachable = papercuspReachable;
    evidence.during.modelProviderReachable = await reachable(config.modelProviderOrigin);
    evidence.during.agentRunningWhenBlocked =
      (await deps.hostExec(`test -e ${shellQuote(exitFile)}`)).code !== 0;
    log(`during: papercusp reachable=${papercuspReachable}, agent running=${evidence.during.agentRunningWhenBlocked}`);

    // Hand the agent its secret only now, with the outage confirmed. The write blocks until the agent's
    // `cat` opens the pipe, so a timeout means the agent never got as far as reading it.
    if (evidence.during.agentRunningWhenBlocked && !papercuspReachable) {
      await releaseGate(deps.hostExec, gatePath, config.secret, config.gateTimeoutSeconds ?? 60);
      evidence.agent.gateReleasedAt = iso();
      log(`gate released to the agent at ${evidence.agent.gateReleasedAt}`);
    }

    const result = await awaitAgentResult(deps, {
      exitFile,
      outputPath,
      timeoutMs: config.agentTimeoutMs ?? 15 * 60_000,
      pollMs,
    });
    if (result === null) errors.push('the agent task did not finish before its deadline');
    else {
      evidence.agent.exitCode = result.exitCode;
      evidence.agent.completedAt = iso();
      evidence.agent.output = result.output;
    }
    await deps.hostExec(`rm -f ${shellQuote(gatePath)}`);
    // Sampled at the END of the outage, so a connector that kept a socket alive is visible.
    evidence.during.serviceActive = await serviceActive();
    evidence.during.papercuspConnectionsWhileBlocked = classify(await ss()).filter((c) => c.class === 'papercusp').length;
  } catch (error) {
    errors.push(String(error instanceof Error ? error.message : error));
  } finally {
    if (block && applied.length > 0) {
      // Undo in reverse and keep going past a failure: one stuck step must not strand the others.
      const failures: string[] = [];
      for (const step of [...applied].reverse()) {
        const lifted = await deps.cloudExec(step.deleteArgs).catch((error) => ({ code: 1, stdout: '', stderr: String(error) }));
        if (lifted.code !== 0) failures.push(lifted.stderr.trim());
      }
      evidence.ruleDeleted = failures.length === 0;
      if (!evidence.ruleDeleted) errors.push(`egress block NOT removed (${block.name}): ${failures.join('; ')}`);
      evidence.liftedAt = iso();
      log(`lifted block at ${evidence.liftedAt}`);
    }
  }

  if (evidence.ruleDeleted && evidence.liftedAt !== null) {
    const liftedAt = evidence.liftedAt;
    const deadline = deps.now().getTime() + (config.reconnectTimeoutMs ?? 10 * 60_000);
    while (deps.now().getTime() < deadline) {
      const connectedAt = (await deps.readConnectorLastSeenAt())?.toISOString() ?? null;
      if (connectedAt !== null && connectedAt > liftedAt) {
        evidence.after.connectorLastSeenAt = connectedAt;
        break;
      }
      await deps.sleep(pollMs);
    }
    evidence.after.papercuspConnections = classify(await ss()).filter((c) => c.class === 'papercusp').length;
    evidence.after.serviceActive = await serviceActive();
  }
  evidence.finishedAt = iso();
  return evidence;
}
