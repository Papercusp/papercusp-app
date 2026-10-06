/** Operator-facing LSP facade: closed contract and transport only. */
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../workspace-registry.ts';
import { queryLspDaemon } from './lsp-daemon-client.ts';
import { DEFAULT_RESOURCE_BUDGET, type BackendHealth, type CodeIntelAnswer, type CodeIntelIntent } from './contracts.ts';
import type { LspLanguage } from './lsp-adapter.ts';

export type LspFacadeOp = 'symbol' | 'references' | 'implementations' | 'diagnostics' | 'workspace_symbols' | 'refactor_preview' | 'health';
export const LSP_FACADE_OPS: readonly LspFacadeOp[] = Object.freeze([
  'symbol', 'references', 'implementations', 'diagnostics', 'workspace_symbols', 'refactor_preview', 'health',
]);
export const MAX_SITES_PER_ANSWER = Math.max(1, Math.floor(DEFAULT_RESOURCE_BUDGET.resultTokensMax / 12));
export interface LspFacadeArgs {
  file?: string;
  line1?: number;
  character?: number;
  rootPath?: string;
  name?: string;
  language?: LspLanguage;
  newName?: string;
  limit?: number;
}
const INTENT_BY_OP: Record<LspFacadeOp, CodeIntelIntent> = {
  symbol: 'definition', references: 'references', implementations: 'implementations',
  diagnostics: 'diagnostics', workspace_symbols: 'symbol-search',
  refactor_preview: 'rename-preview', health: 'diagnostics',
};
function refusal(op: LspFacadeOp, query: string, error: string, health: BackendHealth, startedAt: number): CodeIntelAnswer {
  return {
    backend: 'lsp-adapter', intent: INTENT_BY_OP[op], query, sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    freshness: { health, indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - startedAt, error,
  };
}
export async function lspFacade(
  op: LspFacadeOp,
  args: LspFacadeArgs = {},
  caller: { workspaceId?: string; actorId?: string; priority?: number; deadlineAtMs?: number } = {},
): Promise<CodeIntelAnswer> {
  const started = Date.now();
  if (!LSP_FACADE_OPS.includes(op)) return refusal('health', String(op), `unknown lsp op '${op}'. The op set is closed: ${LSP_FACADE_OPS.join(', ')}`, 'unknown', started);
  const enabled = await getFlag(FLAGS.CODE_INTEL_LSP, 'system').catch(() => false);
  if (!enabled) return refusal(op, args.file ?? args.name ?? '', `code-intelligence LSP facade is disabled (flag ${FLAGS.CODE_INTEL_LSP}). This is a DISABLED answer, not an empty one — do not read it as "no results".`, 'unknown', started);
  return queryLspDaemon({
    op, args: { ...args, rootPath: args.rootPath ?? process.cwd() },
    workspaceId: caller.workspaceId ?? activeWorkspaceId(), actorId: caller.actorId,
    priority: caller.priority, deadlineAtMs: caller.deadlineAtMs ?? started + 90_000,
  });
}
export function lspFacadeOpSpec(): Array<{ op: LspFacadeOp; requires: string[]; reads: true; writes: false }> {
  return [
    { op: 'symbol', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'references', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'implementations', requires: ['file', 'line1', 'character'], reads: true, writes: false },
    { op: 'diagnostics', requires: ['file'], reads: true, writes: false },
    { op: 'workspace_symbols', requires: ['name'], reads: true, writes: false },
    { op: 'refactor_preview', requires: ['file', 'line1', 'character', 'newName'], reads: true, writes: false },
    { op: 'health', requires: [], reads: true, writes: false },
  ];
}
