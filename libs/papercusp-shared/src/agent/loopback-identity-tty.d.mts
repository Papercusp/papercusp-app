export const AGENT_IDENTITY_SPEC_ENV: 'PAPERCUSP_AGENT_IDENTITY_SPEC';
export const AGENT_IDENTITY_SPEC_VERSION: 1;
export const AGENT_IDENTITY_TTY_STAGE_SOURCE: string;
export const AGENT_IDENTITY_TTY_EXEC_SOURCE: string;
/** P-326: per-cwd `~/.claude.json` flags the stage hop pre-accepts on the target account. */
export const CLAUDE_PROJECT_LAUNCH_FLAGS: readonly string[];

export interface AgentIdentityTransport {
  readonly command: string;
  readonly args: readonly string[];
}

export interface AgentIdentityHomeLink {
  /** Env var naming a per-spawn config dir the link goes into. */
  readonly envVar: string;
  /** Link name inside that dir. */
  readonly name: string;
  /** Target, relative to the target account's home. */
  readonly homeRelative: string;
}

export interface AgentIdentitySpec {
  readonly v: 1;
  /** `<user>@<host>` for messages. */
  readonly identity: string;
  /** Non-TTY transport; the remote command is appended as its final argument. */
  readonly stageTransport: AgentIdentityTransport;
  /** TTY transport (e.g. `ssh -tt`); the remote command is appended as its final argument. */
  readonly execTransport: AgentIdentityTransport;
  /** Node the target account can execute (NOT the operator's release node). */
  readonly nodePath: string;
  /** Directory holding the agent CLIs the target account runs (`claude`/`codex`/`omp`). */
  readonly toolchainBin: string;
  readonly remoteHome: string;
  readonly remoteCwd?: string;
  /** Per-spawn dirs are created beneath this, in the target account. */
  readonly spawnRoot: string;
  /** The PATH the agent sees; never forwarded from the operator. */
  readonly remotePath: readonly string[];
  /** The spawning account's home (the transport's own HOME). */
  readonly localHome: string;
  /** Only argv files beneath these roots are shipped; other args pass through verbatim. */
  readonly shipFileRoots?: readonly string[];
  /** Extra exact env names that may cross (credential-shaped names never do). */
  readonly envAllow?: readonly string[];
  readonly envAllowPrefixes?: readonly string[];
  readonly homeLinks?: readonly AgentIdentityHomeLink[];
  /** Files holding operator secrets that must never cross (checked in argv, env, shipped files). */
  readonly forbiddenSecretFiles?: readonly string[];
  readonly maxShippedBytes?: number;
  readonly stageTimeoutMs?: number;
}

export interface AgentIdentityTtyRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
}

export interface AgentIdentityTtyExec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly execHeaderPath: string;
  readonly identity: string;
}

export interface AgentIdentityTtyPlan {
  readonly spawnId: string;
  readonly identity: string;
  readonly stage: {
    readonly command: string;
    readonly args: readonly string[];
    readonly input: Buffer;
    readonly env: Record<string, string>;
  };
  readonly exec: AgentIdentityTtyExec;
}

export interface AgentIdentityTtyDeps {
  readonly exists?: (path: string) => boolean;
  readonly stat?: (path: string) => { isFile(): boolean };
  readonly readFile?: (path: string, encoding?: 'utf8') => string | Buffer;
  readonly newId?: () => string;
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: { input: Buffer; env: Record<string, string>; timeout: number; maxBuffer: number },
  ) => { status: number | null; signal?: string | null; stdout?: string | Buffer; stderr?: string | Buffer; error?: Error };
}

export type AgentIdentityTtyRefusalCode =
  | 'agent_identity_spec_invalid'
  | 'agent_backend_unsupported'
  | 'agent_toolchain_missing'
  | 'agent_spawn_payload_too_large'
  | 'agent_spawn_forbidden_secret'
  | 'agent_identity_stage_failed';

export class AgentIdentityTtyRefusedError extends Error {
  constructor(code: AgentIdentityTtyRefusalCode, message: string);
  readonly code: AgentIdentityTtyRefusalCode;
}

export function parseAgentIdentitySpec(raw: string | AgentIdentitySpec): AgentIdentitySpec;
export function planAgentIdentityTty(
  spec: string | AgentIdentitySpec,
  request: AgentIdentityTtyRequest,
  deps?: AgentIdentityTtyDeps,
): AgentIdentityTtyPlan;
export function stageAgentIdentityTty(
  spec: string | AgentIdentitySpec,
  request: AgentIdentityTtyRequest,
  deps?: AgentIdentityTtyDeps,
): AgentIdentityTtyExec;
