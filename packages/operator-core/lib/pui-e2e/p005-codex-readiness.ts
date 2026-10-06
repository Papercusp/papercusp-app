import { posix as posixPath } from 'node:path';

export const CODEX_HOME_SOCKET_PATH_BUDGET_BYTES = 100;
export const CODEX_GREETING_EXPECTATION = /what can i help you with|how can i help|what would you like to work on/i;

export function codexHomeControlSocketPath(home: string): string {
  return posixPath.join(home, 'app-server-control', 'app-server-control.sock');
}

export function codexHomeFitsControlSocket(home: string): boolean {
  return Buffer.byteLength(codexHomeControlSocketPath(home)) < CODEX_HOME_SOCKET_PATH_BUDGET_BYTES;
}

export type CodexStartupAction = {
  kind: 'trust-folder' | 'skip-update' | 'keep-approval-required' | 'create-first-task';
  keys: string;
};

export function codexStartupAction(screen: string, allowFirstTask: boolean): CodexStartupAction | null {
  if (/Trust this folder\?[\s\S]*?1\. Trust and continue/i.test(screen)) {
    return { kind: 'trust-folder', keys: '\r' };
  }
  if (/Update available[\s\S]*?Skip\b/i.test(screen)) {
    return { kind: 'skip-update', keys: '\x1b[B\r' };
  }
  if (/(?:ask me to approve|Require approval)/i.test(screen)) {
    return { kind: 'keep-approval-required', keys: '\x1b[B\r' };
  }
  if (allowFirstTask && /Agent command center[\s\S]*No tasks yet[\s\S]*\bn\s+new\b/i.test(screen)) {
    return { kind: 'create-first-task', keys: 'n' };
  }
  return null;
}

export function isCodexPromptReady(screen: string): boolean {
  if (/Installing daemon|model:\s*loading|directory:\s*loading/i.test(screen)) return false;
  return /(?:›\s*Ask Codex to do anything|The prompt is yours\.)/i.test(screen);
}

/**
 * True when the screen shows `prompt` echoed after an input glyph (Codex `›`,
 * Claude Code / pui `❯`, a `>` composer) and `expected` matches text AFTER the
 * last such echo. Matching the whole screen is a false pass: an earlier user
 * prompt or transcript line can contain the expected words (P-022's resume
 * recall matched "optional third number" in the earlier edit request while the
 * pui resume picker was still loading and nothing had been asked).
 */
export function taskAnsweredAfterPrompt(screen: string, prompt: string, expected: RegExp): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const visible = normalize(screen);
  const echo = new RegExp(`[›❯>]\\s*${escape(normalize(prompt))}`, 'g');
  let end = -1;
  for (let m = echo.exec(visible); m; m = echo.exec(visible)) end = m.index + m[0].length;
  if (end < 0) return false;
  const safeExpected = new RegExp(expected.source, expected.flags.replace(/[gy]/g, ''));
  return safeExpected.test(visible.slice(end));
}

export function codexTaskCompleted(screen: string, prompt: string, expected: RegExp): boolean {
  return isCodexPromptReady(screen) && taskAnsweredAfterPrompt(screen, prompt, expected);
}
