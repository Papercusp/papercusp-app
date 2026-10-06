/**
 * Read-only diagnostics for a per-session CODEX_HOME.
 *
 * Keep this reader separate from role-codex-home.ts. The writer imports the
 * Codex gateway/TOML builder used during spawn; a dossier read must not pull
 * that construction graph into the operator's static module graph. A stale
 * process can otherwise fail at ESM link time when the builder changes its
 * named exports, before the dossier's optional diagnostics leg can catch it.
 *
 * WI-10005188: every read here is ASYNC (node:fs/promises). Every caller runs on
 * an operator request path (coord:orient, the agent dossier, GET /agent-config),
 * and this reader walks the session's whole `sessions/` rollout tree. A sync
 * readdir/lstat/open there parks the operator main thread whenever the
 * filesystem stalls: WI-10004754 measured a 10s D-state stall from one sync open
 * on this same orient path. Do not add a sync twin. A launch-time caller that
 * needs a sync answer should read the one file it needs directly.
 */
import type { Dirent } from 'node:fs';
import { access, lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';

export interface CodexPapercuspDiagnostics {
  lockEnforcement?: string;
  codexPreToolUseStatus?: string;
  lockMode?: 'automatic' | 'manual';
  hookHealth?: string;
  runtimeProbed?: boolean;
  lockGeneration?: number;
  lockReason?: string;
  requiresExplicitPapercuspLocks?: boolean;
  lockOwnerSid?: string;
  inheritedPromptsCopied?: boolean;
}

export interface CodexHomeDiagnostics {
  codexHome: string;
  exists: boolean;
  agentsPath: string;
  agentsExists: boolean;
  configPath: string;
  configExists: boolean;
  hooksPath: string;
  hooksExists: boolean;
  promptsPath: string;
  promptsExists: boolean;
  authPath: string;
  authExists: boolean;
  diagnosticsPath: string;
  diagnosticsExists: boolean;
  diagnostics: CodexPapercuspDiagnostics | null;
  latestRolloutId: string | null;
  latestRolloutPath: string | null;
  resumeStrategy: 'codex-resume-last-in-code-home';
  resumeCommand: string;
  error: string | null;
}

/** `existsSync` semantics: follows symlinks, and any error reads as "absent". */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function coerceCodexPapercuspDiagnostics(
  raw: Record<string, unknown> | null,
): CodexPapercuspDiagnostics | null {
  if (!raw) return null;
  return {
    ...(typeof raw.lockEnforcement === 'string' ? { lockEnforcement: raw.lockEnforcement } : {}),
    ...(typeof raw.codexPreToolUseStatus === 'string'
      ? { codexPreToolUseStatus: raw.codexPreToolUseStatus }
      : {}),
    ...(raw.lockMode === 'automatic' || raw.lockMode === 'manual' ? { lockMode: raw.lockMode } : {}),
    ...(typeof raw.hookHealth === 'string' ? { hookHealth: raw.hookHealth } : {}),
    ...(typeof raw.runtimeProbed === 'boolean' ? { runtimeProbed: raw.runtimeProbed } : {}),
    ...(typeof raw.lockGeneration === 'number' ? { lockGeneration: raw.lockGeneration } : {}),
    ...(typeof raw.lockReason === 'string' ? { lockReason: raw.lockReason } : {}),
    ...(typeof raw.requiresExplicitPapercuspLocks === 'boolean'
      ? { requiresExplicitPapercuspLocks: raw.requiresExplicitPapercuspLocks }
      : {}),
    ...(typeof raw.lockOwnerSid === 'string' ? { lockOwnerSid: raw.lockOwnerSid } : {}),
    ...(typeof raw.inheritedPromptsCopied === 'boolean'
      ? { inheritedPromptsCopied: raw.inheritedPromptsCopied }
      : {}),
  };
}

async function latestCodexRollout(codexHome: string): Promise<{ id: string; path: string } | null> {
  const root = join(codexHome, 'sessions');
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        let mtimeMs = 0;
        try {
          mtimeMs = (await lstat(path)).mtimeMs;
        } catch {
          // Keep deterministic enough if cleanup races the read.
        }
        files.push({ path, mtimeMs });
      }
    }
  };
  await walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.path.localeCompare(a.path));
  const latest = files[0];
  if (!latest) return null;
  const match = latest.path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return {
    id:
      match?.[1] ??
      latest.path
        .split('/')
        .pop()!
        .replace(/^rollout-/, '')
        .replace(/\.jsonl$/, ''),
    path: latest.path,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function readCodexHomeDiagnostics(sessionKey: string | number): Promise<CodexHomeDiagnostics> {
  const codexHome = codexHomeForSessionKey(sessionKey);
  const agentsPath = join(codexHome, 'AGENTS.md');
  const configPath = join(codexHome, 'config.toml');
  const hooksPath = join(codexHome, 'hooks.json');
  const promptsPath = join(codexHome, 'prompts');
  const authPath = join(codexHome, 'auth.json');
  const diagnosticsPath = join(codexHome, 'papercusp-diagnostics.json');
  try {
    const [
      rollout,
      exists,
      agentsExists,
      configExists,
      hooksExists,
      promptsExists,
      authExists,
      diagnosticsExists,
      diagnosticsRaw,
    ] = await Promise.all([
      latestCodexRollout(codexHome),
      pathExists(codexHome),
      pathExists(agentsPath),
      pathExists(configPath),
      pathExists(hooksPath),
      pathExists(promptsPath),
      pathExists(authPath),
      pathExists(diagnosticsPath),
      readJsonObject(diagnosticsPath),
    ]);
    return {
      codexHome,
      exists,
      agentsPath,
      agentsExists,
      configPath,
      configExists,
      hooksPath,
      hooksExists,
      promptsPath,
      promptsExists,
      authPath,
      authExists,
      diagnosticsPath,
      diagnosticsExists,
      diagnostics: coerceCodexPapercuspDiagnostics(diagnosticsRaw),
      latestRolloutId: rollout?.id ?? null,
      latestRolloutPath: rollout?.path ?? null,
      resumeStrategy: 'codex-resume-last-in-code-home',
      resumeCommand: `CODEX_HOME=${shellSingleQuote(codexHome)} codex resume --last`,
      error: null,
    };
  } catch (error) {
    return {
      codexHome,
      exists: false,
      agentsPath,
      agentsExists: false,
      configPath,
      configExists: false,
      hooksPath,
      hooksExists: false,
      promptsPath,
      promptsExists: false,
      authPath,
      authExists: false,
      diagnosticsPath,
      diagnosticsExists: false,
      diagnostics: null,
      latestRolloutId: null,
      latestRolloutPath: null,
      resumeStrategy: 'codex-resume-last-in-code-home',
      resumeCommand: `CODEX_HOME=${shellSingleQuote(codexHome)} codex resume --last`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
