/**
 * D-421 (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, WI-10003195): on a hosted
 * workspace host, every customer-driven agent CLI the operator spawns runs as the customer
 * workspace account — never as the operator service account (D-417: its state, embedded
 * Postgres and the hosted PTY key would be readable by a shell-capable agent a customer
 * steers through chat) and never as the platform agent account (D-416).
 *
 * The identity switch reuses the pinned loopback-SSH vector the customer terminal already
 * uses (`hostedWorkspaceSshArgs`), without a TTY. The customer's own agent credential is
 * linked from that account's home into the per-spawn CODEX_HOME, and the operator's
 * superuser token is refused outright if it would cross to the customer account.
 *
 * D-423: the customer account cannot read the Papercusp runtime (D-043), so neither the
 * release's Node nor its psu wrappers are usable there. The wrapper's Node and the agent CLI
 * both come from the host's customer agent toolchain (`WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN`),
 * the remote PATH is set explicitly rather than forwarded from the operator, and a host whose
 * bootstrap predates the toolchain gets a NAMED refusal instead of a bare EACCES.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import {
  AgentSpawnRefusedError,
  buildLoopbackIdentitySpawn,
  configureAgentSpawnTransform,
  type AgentIdentitySpec,
  type AgentSpawnTransform,
} from '@papercusp/papercusp-shared/agent';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN,
} from '@papercusp/deployment-driver';
import { setHostedAgentIdentityPsuSpec } from './hosted-agent-identity-psu-env';
import { HOSTED_WORKSPACE_ACCOUNT_HOME, hostedWorkspaceSshArgs } from './hosted-session-host';

export interface HostedCustomerAgentIdentityOptions {
  /** Customer agent toolchain bin dir (Node plus the vendor agent CLIs). */
  readonly toolchainBin?: string;
  /** The operator service account's home (its PATH entries are not forwarded). */
  readonly localHome?: string;
  /** Operator environment to diff the spawn env against. */
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Operator secrets that must never reach the customer account. */
  readonly forbiddenSecrets?: readonly string[];
  /** Existence probe for toolchain entries; injectable for tests. */
  readonly exists?: (path: string) => boolean;
}

function readOperatorSuperuserToken(localHome: string): string[] {
  try {
    const token = readFileSync(join(localHome, '.papercusp', 'superuser-token'), 'utf8').trim();
    return token.length >= 16 ? [token] : [];
  } catch {
    return [];
  }
}

/**
 * The toolchain executable for a chat backend. Keyed by BACKEND, not by the requested command:
 * the operator may resolve the command to a release wrapper path (`AGENT_CMD`), which the
 * customer account can neither read nor execute.
 */
export function hostedCustomerAgentCommand(backend: string, toolchainBin: string): string {
  const name = backend === 'omp' ? 'omp' : backend === 'codex' ? 'codex' : 'claude';
  return posix.join(toolchainBin, name);
}

/**
 * The loopback SSH vector to the customer account. Quiet ssh diagnostics so the agent's stderr
 * stays the agent's own; the option goes before `-l <user> <host>` so the destination stays last
 * and the remote command follows it.
 */
function hostedIdentitySshArgs(tty: boolean): string[] {
  const ssh = hostedWorkspaceSshArgs({ tty });
  const destination = ssh.indexOf('-l');
  return [...ssh.slice(0, destination), '-o', 'LogLevel=ERROR', ...ssh.slice(destination)];
}

const HOSTED_IDENTITY = `${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}@127.0.0.1`;
const HOSTED_SPAWN_ROOT = posix.join(HOSTED_WORKSPACE_ACCOUNT_HOME, '.papercusp', 'agent-spawns');

/** The customer's PATH: its toolchain first; the operator's PATH is never forwarded. */
function hostedRemotePath(toolchainBin: string): string[] {
  return [toolchainBin, posix.join(HOSTED_WORKSPACE_ACCOUNT_HOME, '.local', 'bin'), '/usr/local/bin', '/usr/bin', '/bin'];
}

// Each per-spawn config dir gets a link to the customer's own delivered credential (D-421/P-325):
// runAgentChat links the OPERATOR's file into the local staged dir, and symlinks are not shipped.
const HOSTED_HOME_LINKS = [
  { envVar: 'CODEX_HOME', name: 'auth.json', homeRelative: '.codex/auth.json' },
  { envVar: 'CLAUDE_CONFIG_DIR', name: '.credentials.json', homeRelative: '.claude/.credentials.json' },
] as const;

/**
 * D-424 (P-326): the spec psu's PTY host uses to run a New Session's agent CLI as the customer
 * account. psu itself stays the service-user supervisor; only the agent exec crosses. What may
 * cross is psu's rendered system-prompt file (under the operator's state dir) and Claude/Codex
 * behaviour env — never a credential-shaped name, never the operator superuser token.
 */
export function hostedCustomerAgentIdentitySpec(options: HostedCustomerAgentIdentityOptions = {}): AgentIdentitySpec {
  const localHome = options.localHome ?? homedir();
  const toolchainBin = options.toolchainBin ?? WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN;
  const stateRoots = [join(localHome, '.papercusp')];
  const papercuspHome = (options.baseEnv ?? process.env).PAPERCUSP_HOME?.trim();
  if (papercuspHome && !stateRoots.includes(papercuspHome)) stateRoots.push(papercuspHome);
  return {
    v: 1,
    identity: HOSTED_IDENTITY,
    stageTransport: { command: '/usr/bin/ssh', args: hostedIdentitySshArgs(false) },
    execTransport: { command: '/usr/bin/ssh', args: hostedIdentitySshArgs(true) },
    nodePath: posix.join(toolchainBin, 'node'),
    toolchainBin,
    remoteHome: HOSTED_WORKSPACE_ACCOUNT_HOME,
    spawnRoot: HOSTED_SPAWN_ROOT,
    remotePath: hostedRemotePath(toolchainBin),
    localHome,
    shipFileRoots: stateRoots,
    envAllowPrefixes: ['CLAUDE_CODE_', 'DISABLE_'],
    homeLinks: HOSTED_HOME_LINKS,
    // The operator's embedded-PG credentials (WI-10003627) never cross to the customer:
    // embedded-pg.json carries the admin DSN, embedded-pg-credentials.json every role's password.
    forbiddenSecretFiles: [
      join(localHome, '.papercusp', 'superuser-token'),
      ...stateRoots.flatMap((root) => [
        join(root, 'embedded-pg.json'),
        join(root, 'embedded-pg-credentials.json'),
      ]),
    ],
  };
}

/** The transform that runs agent CLIs as the customer workspace account. */
export function hostedCustomerAgentSpawnTransform(
  options: HostedCustomerAgentIdentityOptions = {},
): AgentSpawnTransform {
  const localHome = options.localHome ?? homedir();
  const toolchainBin = options.toolchainBin ?? WORKSPACE_HOST_CUSTOMER_AGENT_TOOLCHAIN_BIN;
  const exists = options.exists ?? existsSync;
  const nodePath = posix.join(toolchainBin, 'node');
  const inner = buildLoopbackIdentitySpawn({
    transportCommand: '/usr/bin/ssh',
    transportArgs: hostedIdentitySshArgs(false),
    identity: HOSTED_IDENTITY,
    nodePath,
    remoteHome: HOSTED_WORKSPACE_ACCOUNT_HOME,
    spawnRoot: HOSTED_SPAWN_ROOT,
    localHome,
    baseEnv: options.baseEnv ?? process.env,
    passthroughEnv: ['LANG', 'LC_ALL', 'TZ'],
    remotePath: hostedRemotePath(toolchainBin),
    homeLinks: HOSTED_HOME_LINKS,
    forbiddenSecrets: options.forbiddenSecrets ?? readOperatorSuperuserToken(localHome),
  });
  return (request) => {
    const command = hostedCustomerAgentCommand(request.backend, toolchainBin);
    for (const required of [nodePath, command]) {
      if (!exists(required)) {
        throw new AgentSpawnRefusedError(
          'agent_toolchain_missing',
          `cannot run ${request.backend} as the customer workspace account: the customer agent toolchain has no ${required} ` +
            '(this host was bootstrapped before D-423 or without that agent installed; upgrade the workspace host)',
        );
      }
    }
    return inner({ ...request, command });
  };
}

/**
 * Install process-wide, once when the hosted runtime starts: the transform (chat/converse
 * spawns, D-421/D-423) and the psu spec (New Session's PTY agent, D-424) — one call, so the two
 * agent paths cannot disagree about which account they run as.
 */
export function installHostedCustomerAgentIdentity(options: HostedCustomerAgentIdentityOptions = {}): void {
  configureAgentSpawnTransform(hostedCustomerAgentSpawnTransform(options));
  setHostedAgentIdentityPsuSpec(hostedCustomerAgentIdentitySpec(options));
}
