/**
 * Oracle prompt + MCP config assembly. Lives next to `oracle/chat.ts` so
 * the tool handler is self-contained (matches architect:chat pattern).
 *
 * The `_hono/oracle.ts` route shim forwards raw args; everything else
 * — system principal load, superuser token, MCP config build, prompt
 * composition (persona + tools + playbook + inventory + tutorial +
 * memory + history + user) — happens in here so the IPC fast-path can
 * call oracle:chat directly without going through HTTP for prompt
 * assembly.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { readOperatorState, writeOperatorState } from '../../operator-state-pg';
import { activeWorkspaceId } from '../../workspace-registry';
import { readSystemPrincipal } from '../../system-principal';
import {
  loadRolePersona,
  loadRoleToolsMd,
  renderToolsCatalog,
} from '../../prompt-assembly';
import { listAgentsAcrossWorkspace } from '../../agents-list';
import { buildMemoryContextBlock } from '../../memory/injection';
import { loadHarnessRegistry } from '../../harness-registry';
import { operatorApiBase } from '../../operator-api-base';

const ORACLE_PROMPT_TABLE = 'harness_shared.operator_oracle_prompt';
const ORACLE_MEMORY_TABLE = 'harness_shared.operator_oracle_memory';

const DEFAULT_PROMPT = loadRolePersona('oracle');
const DEFAULT_MEMORY = `# Oracle memory

Add notes here you want the Oracle to keep in mind across conversations.
Examples:
- Preferred default project location
- Names of teammates / agents you collaborate with
- Conventions specific to your workflow
`;

export const ORACLE_ALLOWED_TOOLS = [
  // Browser navigation + UI state introspection.
  'mcp__agentmcp__ui:dispatch',
  'mcp__agentmcp__ui:get_state',
  'mcp__agentmcp__ui:list_clients',
  // Model-driven choice cards.
  'mcp__agentmcp__chat:ask_choice',
  // Harness reads.
  'mcp__agentmcp__harness:list',
  'mcp__agentmcp__harness:get',
  'mcp__agentmcp__harness:status',
  // App-template discovery (WI-3198) — browse/read the Cupboard templates a new
  // app is built from (read-only; materialize stays with the builder surfaces).
  'mcp__agentmcp__templates:list',
  'mcp__agentmcp__templates:get-guide',
  // cupboard-agent-tool-coverage-2026-07-14 — cross-kind Cupboard BROWSE (read-only;
  // publish/install/delist stay with the operator-converse surface per the Oracle's
  // read-only posture). Answer "what's on the Cupboard?" across every listing kind.
  'mcp__agentmcp__cupboard:search',
  'mcp__agentmcp__knowledge_packs:list',
  // Agent dispatch.
  'mcp__agentmcp__agents:list',
  'mcp__agentmcp__agent_chats:list',
  'mcp__agentmcp__agent_chats:get',
  'mcp__agentmcp__agent_chats:create',
  'mcp__agentmcp__agent_chats:send_message',
  // Workspace bookkeeping.
  'mcp__agentmcp__tasks:list',
  'mcp__agentmcp__tasks:get',
  'mcp__agentmcp__goals:list',
  'mcp__agentmcp__goals:get',
  'mcp__agentmcp__audit:list',
  // Memory + search. (hindsight:recall removed with the dead tool —
  // audit P-047; memory:* is the canonical surface.)
  'mcp__agentmcp__memory:search',
  'mcp__agentmcp__memory:remember',
  'mcp__agentmcp__search:query',
  // Tool introspection.
  'mcp__agentmcp__agent_tools:list',
] as const;
const ORACLE_TOOL_NAMES = ORACLE_ALLOWED_TOOLS.map((n) =>
  n.replace(/^mcp__agentmcp__/, ''),
);

export interface OracleMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TutorialStep {
  id: string;
  navigate: string | null;
  pre?: string;
  body: string;
  closer: string;
}

const TUTORIAL_STEPS: TutorialStep[] = [
  { id: 'greeting', navigate: null, body: 'Greet the user. In two short sentences tell them: Papercusp is an autonomous-harness framework where multi-agent crews ("harnesses") build features for them, and you\'ll show them around in 5 stops.', closer: 'Ask: "Ready? Say **next** when you are."' },
  { id: 'harness-list', navigate: '/harness', body: 'Explain: this is the home base. A *harness* is a project with a crew of role-scoped agents (architect, orchestrator, worker, validator, reviewer, documenter, debugger). From here they pick an existing harness or create a new one. Mention they can spin one up from a marketplace template later in the tour.', closer: 'End with: "Say **next** to continue, or **stop** to exit."' },
  { id: 'harness-console', pre: 'Call `mcp__agentmcp__harness:list` first. Pick the first slug from the result. If the result is empty, stay on `/harness` instead and tell them they\'ll see the per-harness console once they create one.', navigate: '/harness/<first-slug-or-/harness>', body: 'Inside a harness, point out: the feature list (work the crew is doing), the agent chat dock (talk to any role on the crew), and the panel tabs (Snapshots, Decisions, Memory, Hooks, Usage, Tests).', closer: 'End with: "Say **next** to continue, or **stop** to exit."' },
  { id: 'marketplace-templates', navigate: '/marketplace/templates', body: 'Explain: starter harnesses they can clone. Each comes pre-wired with a SPEC, agent roster, and plugins. Clicking one brings up an install flow that creates a local harness on their machine.', closer: 'End with: "Say **next** to continue, or **stop** to exit."' },
  { id: 'marketplace-plugins', navigate: '/marketplace/plugins', body: 'Explain: plugins extend a harness with capabilities — publishing to Cloudflare Pages, syncing Linear issues, custom UI panels, lifecycle hooks. Plugins are enabled per harness and can ship their own UI tabs that appear inside the harness console.', closer: 'End with: "Say **next** to continue, or **stop** to exit."' },
  { id: 'settings-oracle', navigate: '/settings/oracle', body: 'Explain: this is where they teach *you* (the Oracle) about their workflow. The prompt and memory shown here are loaded into every conversation, so editing them changes how you respond across the whole app.', closer: 'End with: "Say **next** for the wrap-up."' },
  { id: 'wrap', navigate: null, body: 'Tell them the tour is done. Mention they can re-open it any time from the **Tutorial** button in the top nav. Offer to (a) take them back to `/harness` to start working, or (b) answer any question.', closer: 'Wait for their answer. If they pick (a), call `ui:dispatch` with { intent: \'set_url\', args: { path: \'/harness\' } }.' },
];

async function ensureDefaults() {
  for (const [table, content] of [
    ['operator_oracle_prompt', DEFAULT_PROMPT],
    ['operator_oracle_memory', DEFAULT_MEMORY],
  ] as const) {
    const existing = await readOperatorState<{ content?: string }>(table);
    if (existing && typeof existing.content === 'string') continue;
    await writeOperatorState(table, { content });
  }
}

export async function readOracleConfig(): Promise<{
  prompt: string;
  memory: string;
  prompt_path: string;
  memory_path: string;
}> {
  await ensureDefaults();
  const [pRow, mRow] = await Promise.all([
    readOperatorState<{ content?: string }>('operator_oracle_prompt'),
    readOperatorState<{ content?: string }>('operator_oracle_memory'),
  ]);
  return {
    prompt: pRow?.content ?? '',
    memory: mRow?.content ?? '',
    prompt_path: ORACLE_PROMPT_TABLE,
    memory_path: ORACLE_MEMORY_TABLE,
  };
}

export async function writeOracleConfig(patch: { prompt?: string; memory?: string }): Promise<void> {
  if (typeof patch.prompt === 'string') {
    await writeOperatorState('operator_oracle_prompt', { content: patch.prompt });
  }
  if (typeof patch.memory === 'string') {
    await writeOperatorState('operator_oracle_memory', { content: patch.memory });
  }
}

async function buildOracleInventoryBlock(): Promise<string> {
  const workspace = activeWorkspaceId();
  const port = process.env.PORT ?? '3055';
  const base = process.env.INTERNAL_API_BASE ?? `http://127.0.0.1:${port}`;
  let projects: Array<{ slug: string; path: string }> = [];
  try {
    // BOUNDED: this is best-effort prompt enrichment — without the abort, a
    // slow /api/harness/projects hangs every composeOraclePrompt caller for
    // the route's full latency (2026-06-06: the route degraded to 76s/408 and
    // took the oracle prompt tests — and with them the green gate — down with
    // it). Degrade to no-inventory after 3s, same posture as the catch.
    const r = await fetch(`${base}/api/harness/projects`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      projects = (d?.projects ?? []).map((p: { slug: string; path: string }) => ({ slug: p.slug, path: p.path }));
    }
  } catch { /* degraded */ }

  let agents: Array<{ slug: string; role: string; chat_count: number; last_active: string | null }> = [];
  try { agents = await listAgentsAcrossWorkspace({ limit: 8 }); } catch { /* degraded */ }

  if (!projects.length && !agents.length) return '';

  const projectLines = projects.slice(0, 6).map((p) => `  - ${p.slug}`);
  const agentLines = agents.map((a) => {
    const ago = a.last_active ? `${Math.round((Date.now() - new Date(a.last_active).getTime()) / 60000)}m ago` : 'idle';
    return `  - ${a.slug}/${a.role} (${a.chat_count} chats, ${ago})`;
  });

  return [
    '\n\n## Workspace at a glance',
    `\nWorkspace: ${workspace}`,
    projectLines.length ? `\nHarnesses (${projects.length}${projects.length > 6 ? ', showing 6' : ''}):\n${projectLines.join('\n')}` : '',
    agentLines.length ? `\nMost-active agents:\n${agentLines.join('\n')}` : '',
    '\n\nThis is a snapshot. For deeper info call listHarnesses / listAgents / getHarnessStatus.',
  ].join('');
}

function buildTutorialBlock(stepIndex: number, lastUser: string): string {
  const stop = /^(stop|exit|end|skip|that'?s enough|no thanks|quit)\b/i.test(lastUser.trim());
  const idx = stop ? TUTORIAL_STEPS.length - 1 : Math.min(stepIndex, TUTORIAL_STEPS.length - 1);
  const step = TUTORIAL_STEPS[idx];
  const navLine = step.navigate
    ? `1. Call \`mcp__agentmcp__ui:dispatch\` with { intent: 'set_url', args: { path: '${step.navigate}' } } (skip the call if the user is already on that path).\n`
    : '1. Do not navigate this turn.\n';
  const preLine = step.pre ? `0. ${step.pre}\n` : '';
  return `

---

## Tutorial mode — Step ${idx + 1} of ${TUTORIAL_STEPS.length} (${step.id})

You are running a hardcoded walkthrough of Papercusp. **Do exactly the
step below — do not split it, do not skip it, do not invent extra
sub-steps.** One navigate call, then 2–4 plain sentences, then the
closer. No emoji, no marketing prose, no bullet lists.

${preLine}${navLine}2. Then write 2–4 short sentences: ${step.body}
3. ${step.closer}

If the user asked a question instead of saying "next", answer it briefly
in one sentence and then re-prompt with the closer above. Do not
dispatch to agents during the tour.
`;
}

export interface AssembledOracleTurn {
  promptText: string;
  tutorialIsFinalStep: boolean;
}

export async function composeOraclePrompt(
  messages: OracleMessage[],
  opts: { currentPath: string; tutorialMode: boolean; userId?: string },
): Promise<AssembledOracleTurn> {
  const { prompt, memory } = await readOracleConfig();

  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'You (assistant)'}: ${m.content}`)
    .join('\n\n');
  const last = messages[messages.length - 1];
  const userContent = typeof last?.content === 'string' ? last.content : '';

  const toolBlock = renderToolsCatalog('oracle', ORACLE_TOOL_NAMES);
  const playbook = loadRoleToolsMd('oracle') ?? '';
  const inventoryBlock = await buildOracleInventoryBlock().catch(() => '');

  // Oracle answers Q&A workspace-wide with no specific harness in
  // scope, so fan out memory recall across every harness in the
  // workspace (same shape as operator chat). Failures degrade
  // gracefully — the helper returns null.
  let oracleHarnessSlugs: string[] = [];
  try {
    const reg = await loadHarnessRegistry(activeWorkspaceId());
    oracleHarnessSlugs = reg.projects.map((p) => p.slug);
  } catch { /* leave empty */ }
  const memInjected = await buildMemoryContextBlock({
    userId: opts.userId ?? null,
    workspaceId: activeWorkspaceId(),
    harnessSlugs: oracleHarnessSlugs,
    queryContext: userContent,
    heading: 'Oracle memory (relevant entries)',
  }).catch(() => null);

  const ctxBlock = opts.currentPath
    ? `\n\n## Runtime context\n\nThe user is currently on path: ${opts.currentPath}\n`
    : '';

  let tutorialBlock = '';
  let tutorialIsFinalStep = false;
  if (opts.tutorialMode) {
    const userTurns = messages.filter((m) => m?.role === 'user').length;
    const stepIndex = Math.max(0, userTurns - 1);
    const stop = /^(stop|exit|end|skip|that'?s enough|no thanks|quit)\b/i.test(userContent.trim());
    tutorialBlock = buildTutorialBlock(stepIndex, userContent);
    tutorialIsFinalStep = stop || stepIndex >= TUTORIAL_STEPS.length - 1;
  }

  const promptText = [
    prompt.trim(),
    toolBlock ? `\n\n${toolBlock}` : '',
    playbook ? `\n\n${playbook}` : '',
    inventoryBlock,
    ctxBlock,
    tutorialBlock,
    memory.trim() ? `\n---\n\n## Persistent memory\n\n${memory.trim()}\n` : '',
    memInjected ? `\n---\n\n${memInjected}\n` : '',
    history ? `\n---\n\n## Conversation history\n\n${history}\n` : '',
    `\n---\n\n## User\n\n${userContent}\n`,
  ].join('');

  return { promptText, tutorialIsFinalStep };
}

export async function buildOracleMcpConfig(opts: { uiClientId: string | null }): Promise<{
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
} | null> {
  const oracleP = await readSystemPrincipal('oracle');
  if (!oracleP?.bearer) return null;
  let superuserToken: string | null = null;
  try {
    const tokenPath = join(homedir(), '.papercusp', 'superuser-token');
    superuserToken = readFileSync(tokenPath, 'utf8').trim();
    if (!superuserToken || superuserToken.length < 16) superuserToken = null;
  } catch { /* */ }
  if (!superuserToken) return null;

  const oracleBase = operatorApiBase();
  const clientParam = opts.uiClientId ? `&client=${encodeURIComponent(opts.uiClientId)}` : '';
  const workspaceParam = `&workspace=${encodeURIComponent(activeWorkspaceId())}`;
  return {
    mcpServers: {
      agentmcp: {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote@latest',
          `${oracleBase}/api/mcp?superuser=1${workspaceParam}${clientParam}`,
          '--header',
          `Authorization:Bearer ${superuserToken}`,
        ],
      },
    },
  };
}

export function oracleToolEventFilter(raw: string): string | null {
  if (raw.startsWith('mcp__agentmcp__')) return raw.replace(/^mcp__agentmcp__/, '');
  return null;
}
