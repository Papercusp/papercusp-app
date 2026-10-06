/**
 * What a connected-app key may reach (external-app-access-to-workspaces-2026-09-29 P-003).
 *
 * P-002 made an app key authenticate as a `service` principal carrying the key's
 * capabilities; the dispatch capability-check already refuses a tool whose declared
 * capabilities the key lacks. This module adds the three limits a capability set cannot
 * express, and one it must never be able to override:
 *
 *   1. WORKSPACE — a call runs only in the key's own workspace.
 *   2. HARNESS   — when the key names harnesses, a call may only name those.
 *   3. TOOL      — an app key is DEFAULT-DENY: it reaches exactly the tools its scopes list
 *                  (`group:verb` or `group:*`), never "everything its capabilities cover".
 *   4. HARD DENY — shell, files, admin, credential, agent-spawn and meta-dispatch tools.
 *                  No scope can grant them: `validateAppKeyScopes` refuses them at issue
 *                  time and `evaluateAppScope` refuses them at call time, so a key minted
 *                  before a tool joined the set still cannot call it.
 *
 * Pure: no I/O. The dispatch seat (projected-tool-deps.ts, the kernel port) loads the key's
 * row and calls `evaluateAppScope` on every call, at preflight and again before invoke.
 */

import type { AppKeyRow, AppKeyScopes } from './store';
import type { RefusalContract } from '../capability-envelope/identity-refusal-contract';

/**
 * Capability namespaces no app key may hold, and therefore no tool needing one may be called.
 * DERIVED rule: every tool declaring one of these is hard-denied whatever its group.
 *   capability:*  shell, filesystem, git, network, terminal, computer-use
 *   secrets:*     stored credentials
 *   processes:*   killing / freezing host processes
 */
export const HARD_DENY_CAPABILITY_PREFIXES: readonly string[] = Object.freeze([
  'capability:',
  'secrets:',
  'processes:',
]);

/**
 * Tool groups no app key may call. CURATED, because group membership is a judgment about what
 * a tool DOES that its capability string does not always carry (e.g. `dev:restart` needs only
 * `operator:write`). Grouped by reason; `scope-policy.test.ts` pins every entry to a group that
 * exists in the real catalog so a rename cannot silently re-open a tool.
 */
export const HARD_DENY_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  // Shell, processes, code execution, desktop control.
  capability: 'shell and filesystem primitives',
  computer: 'desktop computer-use',
  exec_sandbox: 'code execution',
  processes: 'host process control',
  code: 'code:run executes scripts that dispatch further tools',
  build: 'runs compilers on the host',
  testing: 'runs test processes on the host',
  blender: 'drives a host binary',
  hooks: 'host hook configuration',
  ui: 'drives the owner desktop UI',
  tui: 'drives terminal UIs',
  // Source files and host logs.
  lsp: 'reads source files',
  graph: 'reads the source code index',
  logs: 'reads host service logs',
  // Operator administration and infrastructure.
  dev: 'dev-box administration (restarts, services, SQL)',
  db: 'schema migration',
  release: 'release gate and promotion',
  deploy: 'deploys',
  deploys: 'deploys',
  config: 'operator configuration',
  flags: 'feature flags',
  backup: 'snapshots and restores',
  platform: 'platform administration',
  instance: 'instance administration',
  network: 'network administration',
  p2p: 'peer-to-peer substrate',
  substrate: 'replication substrate',
  governor: 'resource governor',
  provisioner: 'machine provisioning',
  egress: 'egress policy',
  gateway: 'inference gateway and its accounts',
  routines: 'system routines',
  triggers: 'automation triggers',
  schedule: 'schedules',
  watchdog: 'watchdogs',
  'git-sync': 'repository sync',
  pot_git: 'repository administration',
  locks: 'file and resource locks',
  // Credentials, identity and authority.
  setup: 'provider credentials',
  accounts: 'model accounts and credentials',
  identities: 'agent identities',
  auth: 'authentication',
  cert: 'certificates',
  trust: 'trust grants',
  autonomy: 'autonomy policy',
  mode: 'session authority modes',
  connected_apps: 'minting or managing app keys',
  access: 'listing, minting, pausing or revoking app keys (local-only access:* tools, P-012)',
  // Agent spawning and meta-dispatch (an app key must not start agents or re-dispatch).
  fleet: 'spawns agents',
  pot: 'creates pots and spawns agents',
  orchestrate: 'spawns agents',
  new_subagent: 'spawns agents',
  loop: 'agent loops',
  scheduler: 'agent work scheduling',
  turn: 'interrupts agent turns',
  session: 'agent session control',
  omp: 'agent client control',
  tools: 'tools:invoke re-dispatches arbitrary tools',
  recipes: 'recipes:run executes composed tool scripts',
  knowledge_packs: 'installs and publishes packs',
  cupboard: 'publishes outward',
});

/** The minimal description of a tool the policy needs. */
export interface AppScopeTool {
  /** The MCP name, e.g. `harness:list`. */
  name: string;
  capabilities: readonly string[];
  /** True when the tool deliberately reads or writes across workspaces. */
  crossWorkspace?: boolean;
  /** True when the tool's input names a harness (so a harness-restricted key must name one). */
  acceptsHarness?: boolean;
}

/** The key row fields the policy reads. */
export type AppScopeRow = Pick<
  AppKeyRow,
  'id' | 'workspace_id' | 'scopes' | 'revoked_at' | 'paused_at' | 'expires_at'
>;

export type AppScopeDenialCode =
  | 'key_revoked'
  | 'key_paused'
  | 'key_expired'
  | 'workspace_mismatch'
  | 'hard_denied'
  | 'cross_workspace'
  | 'tool_not_in_scope'
  | 'harness_not_in_scope'
  | 'harness_required_by_scope';

export type AppScopeVerdict =
  | { allow: true }
  | {
      allow: false;
      code: AppScopeDenialCode;
      reason: string;
      /** WI-10005197: what would LIFT the refusal. Present on `hard_denied` (a platform policy, not a per-key grant). */
      refusal?: RefusalContract;
    };

const HARNESS_ARG_KEYS = ['harness', 'harnessSlug', 'harness_slug'] as const;
const WORKSPACE_ARG_KEYS = ['workspace', 'workspaceId', 'workspace_id'] as const;

/** The registry fields `appScopeToolOf` reads (a structural subset of a projected tool). */
export interface AppScopeToolSource {
  capabilities: readonly string[];
  crossWorkspace?: boolean;
  harness?: 'required' | 'optional' | 'none';
  inputSchema?: Record<string, unknown>;
}

/**
 * Describe a registered tool for the policy. A tool "accepts a harness" when it declares a
 * harness requirement or its input schema has a harness argument — the case in which a
 * harness-restricted key must name one of its harnesses rather than let the tool default.
 */
export function appScopeToolOf(name: string, tool: AppScopeToolSource): AppScopeTool {
  const props = tool.inputSchema?.properties;
  const schemaNamesHarness =
    !!props && typeof props === 'object' && HARNESS_ARG_KEYS.some((k) => Object.prototype.hasOwnProperty.call(props, k));
  return {
    name,
    capabilities: [...tool.capabilities],
    crossWorkspace: tool.crossWorkspace === true,
    acceptsHarness: tool.harness === 'required' || tool.harness === 'optional' || schemaNamesHarness,
  };
}

/** The group of a tool name: `harness:list` → `harness`. */
export function toolGroupOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(0, colon);
}

/** Why a tool is hard-denied, or null when it is not. */
export function hardDenyReason(tool: Pick<AppScopeTool, 'name' | 'capabilities'>): string | null {
  const group = toolGroupOf(tool.name);
  if (Object.prototype.hasOwnProperty.call(HARD_DENY_GROUPS, group)) {
    return `tool group "${group}" is never grantable to an app key (${HARD_DENY_GROUPS[group]})`;
  }
  for (const cap of tool.capabilities) {
    if (cap === '*') return 'a tool requiring the wildcard capability is never grantable to an app key';
    const prefix = HARD_DENY_CAPABILITY_PREFIXES.find((p) => cap.startsWith(p));
    if (prefix) return `capability "${cap}" is never grantable to an app key`;
  }
  return null;
}

/**
 * The capabilities an app key's principal carries (WI-10004317). A key's grant is its `tools`
 * allowlist; the tools it names declare capabilities (`work_items:list` → `work_items:read`), and
 * the generic tools/list filter and dispatch capability gate check THOSE against the principal. A
 * key issued with exact tools and no capabilities (every "Connect an app" key) would otherwise
 * list nothing and be refused `missing_capability` on every real tool.
 *
 * Adds the declared capabilities of every catalog tool the allowlist covers, skipping hard-denied
 * and cross-workspace tools, so a tampered row naming one never lifts its capability into the
 * principal. The dispatch seat (`evaluateAppScope`) still decides WHICH tools run: a capability
 * shared with an ungranted tool does not reach that tool.
 */
export function grantedToolCapabilities(
  scopes: AppKeyScopes | null | undefined,
  catalog: Iterable<AppScopeTool>,
): Set<string> {
  const out = new Set<string>(scopes?.capabilities ?? []);
  const entries = nonEmpty(scopes?.tools);
  if (!entries) return out;
  for (const tool of catalog) {
    if (!entries.some((entry) => scopeEntryMatches(entry, tool.name))) continue;
    if (tool.crossWorkspace || hardDenyReason(tool)) continue;
    for (const cap of tool.capabilities) out.add(cap);
  }
  return out;
}

/** True when a scope allowlist entry covers the tool name. */
export function scopeEntryMatches(entry: string, toolName: string): boolean {
  const e = entry.trim();
  if (!e || e === '*') return false; // a bare wildcard is never a valid entry
  if (e.endsWith(':*')) return toolGroupOf(toolName) === e.slice(0, -2) && toolName.includes(':');
  return e === toolName;
}

function stringArg(args: unknown, keys: readonly string[]): string[] {
  if (!args || typeof args !== 'object') return [];
  const rec = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  }
  return out;
}

function nonEmpty(list: readonly string[] | undefined): readonly string[] | null {
  const cleaned = (list ?? []).map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Decide one call. Order matters only for the reported reason: key state first (a revoked key
 * is revoked whatever it asks for), then workspace, then the hard-deny set, then the scopes.
 */
export function evaluateAppScope(
  input: {
    tool: AppScopeTool;
    args: unknown;
    /** The workspace the call is dispatched under. */
    workspaceId: string | null | undefined;
    /** The transport's harness (`'*'` or empty = none named). */
    harnessSlug?: string | null;
    now?: Date;
  },
  row: AppScopeRow,
): AppScopeVerdict {
  const now = input.now ?? new Date();
  if (row.revoked_at) return { allow: false, code: 'key_revoked', reason: 'app key is revoked' };
  if (row.paused_at) return { allow: false, code: 'key_paused', reason: 'app key is paused' };
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return { allow: false, code: 'key_expired', reason: 'app key has expired' };
  }

  const workspaces = [input.workspaceId ?? '', ...stringArg(input.args, WORKSPACE_ARG_KEYS)];
  if (workspaces.some((ws) => ws !== row.workspace_id)) {
    return {
      allow: false,
      code: 'workspace_mismatch',
      reason: `app key is bound to workspace "${row.workspace_id}"`,
    };
  }

  const denied = hardDenyReason(input.tool);
  if (denied) {
    return {
      allow: false,
      code: 'hard_denied',
      reason: denied,
      refusal: {
        observed: { tool: input.tool.name, toolGroup: toolGroupOf(input.tool.name) },
        liftsWhen:
          'the tool is no longer in a hard-deny group and declares no wildcard / hard-denied capability prefix ' +
          '(HARD_DENY_GROUPS / HARD_DENY_CAPABILITY_PREFIXES in connected-apps/scope-policy.ts). No app-key grant ' +
          'or scope edit lifts it — adding the tool to the key allowlist changes nothing. An app key can only call a ' +
          'non-denied tool that does the job; changing the deny policy itself is a platform code change',
        whoCanMakeItTrue: ['host'],
      },
    };
  }
  if (input.tool.crossWorkspace) {
    return {
      allow: false,
      code: 'cross_workspace',
      reason: `tool "${input.tool.name}" reaches across workspaces and is never grantable to an app key`,
    };
  }

  const scopes: AppKeyScopes = row.scopes ?? {};
  const tools = nonEmpty(scopes.tools);
  if (!tools || !tools.some((entry) => scopeEntryMatches(entry, input.tool.name))) {
    return {
      allow: false,
      code: 'tool_not_in_scope',
      reason: `tool "${input.tool.name}" is not in this app key's tool allowlist`,
    };
  }

  const harnesses = nonEmpty(scopes.harnesses);
  if (harnesses) {
    const named = stringArg(input.args, HARNESS_ARG_KEYS);
    const transport = (input.harnessSlug ?? '').trim();
    if (transport && transport !== '*') named.push(transport);
    const outside = named.find((h) => !harnesses.includes(h));
    if (outside) {
      return {
        allow: false,
        code: 'harness_not_in_scope',
        reason: `harness "${outside}" is not in this app key's harness allowlist`,
      };
    }
    if (named.length === 0 && input.tool.acceptsHarness) {
      return {
        allow: false,
        code: 'harness_required_by_scope',
        reason: `this app key is limited to harnesses [${harnesses.join(', ')}]; name one explicitly`,
      };
    }
  }
  return { allow: true };
}

export interface AppKeyScopeProblem {
  field: 'capabilities' | 'tools' | 'harnesses';
  value: string;
  reason: string;
}

/**
 * Issue-time check: the scopes a key is about to be minted with. A non-empty result means the
 * key must not be created. `knownTools` (the catalog) lets an exact tool entry be checked against
 * the capabilities the tool actually declares; without it only name-level rules apply.
 */
export function validateAppKeyScopes(
  scopes: AppKeyScopes,
  knownTools?: ReadonlyMap<string, Pick<AppScopeTool, 'name' | 'capabilities' | 'crossWorkspace'>>,
): AppKeyScopeProblem[] {
  const problems: AppKeyScopeProblem[] = [];
  for (const cap of scopes.capabilities ?? []) {
    if (cap.trim() === '*') {
      problems.push({ field: 'capabilities', value: cap, reason: 'the wildcard capability is never grantable' });
      continue;
    }
    if (HARD_DENY_CAPABILITY_PREFIXES.some((p) => cap.startsWith(p))) {
      problems.push({ field: 'capabilities', value: cap, reason: `capability "${cap}" is never grantable` });
    }
  }
  for (const entry of scopes.tools ?? []) {
    const e = entry.trim();
    if (!e || e === '*' || e === '*:*') {
      problems.push({ field: 'tools', value: entry, reason: 'a wildcard tool entry is never grantable; list tools or `group:*`' });
      continue;
    }
    const group = toolGroupOf(e);
    if (Object.prototype.hasOwnProperty.call(HARD_DENY_GROUPS, group)) {
      problems.push({ field: 'tools', value: entry, reason: `tool group "${group}" is never grantable (${HARD_DENY_GROUPS[group]})` });
      continue;
    }
    const known = e.endsWith(':*') ? undefined : knownTools?.get(e);
    if (known) {
      const denied = hardDenyReason(known);
      if (denied) problems.push({ field: 'tools', value: entry, reason: denied });
      else if (known.crossWorkspace) {
        problems.push({ field: 'tools', value: entry, reason: `tool "${e}" reaches across workspaces` });
      }
    } else if (knownTools && !e.endsWith(':*')) {
      problems.push({ field: 'tools', value: entry, reason: `no tool named "${e}" exists` });
    }
  }
  for (const h of scopes.harnesses ?? []) {
    if (!h.trim() || h.trim() === '*') {
      problems.push({ field: 'harnesses', value: h, reason: 'a harness entry must name one harness' });
    }
  }
  return problems;
}
