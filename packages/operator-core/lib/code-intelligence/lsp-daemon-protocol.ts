/**
 * Typed operator-to-LSP-daemon request. The daemon resolves the project before
 * admission; the operator carries the caller's identity and the closed facade
 * operation without interpreting language-server capability state.
 */
import {
  languageForFile,
  resolveProjectRoot,
  resolveSymbolSearchScope,
  type LspLanguage,
} from './lsp-adapter.ts';
import type { LspFacadeArgs, LspFacadeOp } from './lsp-facade.ts';
import type { CodeIntelAnswer } from './contracts.ts';
import type { LspQueryEvidence } from './lsp-query-evidence.ts';
import type { lspHealth } from './lsp-daemon-facade.ts';

export interface LspDaemonRequest {
  op: LspFacadeOp;
  args: LspFacadeArgs;
  /** Durable queue partition, resolved from the caller's workspace context. */
  workspaceId?: string;
  actorId?: string;
  priority?: number;
  /** Absolute epoch milliseconds. The daemon must enforce this, not the caller. */
  deadlineAtMs?: number;
  /** Internal benchmark/archive delivery, never a public tool argument. */
  archive?: boolean;
}

export interface LspDaemonAnswer extends CodeIntelAnswer {
  readonly daemonEvidence?: LspQueryEvidence;
  /** Complete existing health inventory at archive boundaries; never clipped into sites. */
  readonly daemonRuntime?: Awaited<ReturnType<typeof lspHealth>> & { pid: number; node: string; entry: string; sampledAtMs: number };
}

/** Internal read/refresh operations used by the operator's locked rename writer. */
export interface LspDaemonApplyRequest {
  workspaceId: string;
  file: string;
  rootPath: string;
  line1?: number;
  character?: number;
  newName?: string;
  newText?: string;
  actorId?: string;
  deadlineAtMs?: number;
}

export interface LspDaemonDispatchContext {
  op: LspFacadeOp;
  language: LspLanguage;
  projectRoot: string;
  actorId?: string;
  priority?: number;
  deadlineAtMs?: number;
  /** Per-RPC abort controller; cancellation never crosses the wire as a signal. */
  signal: AbortSignal;
}

/**
 * Resolve the same project identity that the adapter will use. A null result
 * means the facade owns a loud refusal (missing file, unsupported language, or
 * invalid project); it must still run so the established CodeIntelAnswer text
 * survives the RPC move unchanged.
 */
export function resolveLspDaemonDispatchContext(
  request: LspDaemonRequest,
  signal: AbortSignal,
): LspDaemonDispatchContext | null {
  const { op, args } = request;
  if (op === 'health') return null;
  const rootPath = args.rootPath ?? process.cwd();
  let language: LspLanguage;
  let projectRoot: string;
  if (op === 'workspace_symbols') {
    language = args.language ?? 'typescript';
    const scope = resolveSymbolSearchScope(language, args.file, rootPath);
    if (scope.error) return null;
    projectRoot = scope.root;
  } else {
    if (!args.file) return null;
    const resolved = languageForFile(args.file);
    if (!resolved) return null;
    language = resolved;
    const project = resolveProjectRoot(language, args.file, rootPath);
    if (project.error) return null;
    projectRoot = project.root;
  }
  return {
    op,
    language,
    projectRoot,
    actorId: request.actorId,
    priority: request.priority,
    deadlineAtMs: request.deadlineAtMs,
    signal,
  };
}
