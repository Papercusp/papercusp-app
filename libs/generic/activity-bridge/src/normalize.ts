/**
 * normalize.ts — turn a raw coding-agent hook event into a uniform display shape.
 *
 * Different CLIs (Claude Code, Codex, OMP-style agents) emit native tool calls,
 * lifecycle transitions and todo snapshots in differing shapes. A host that wants
 * one fleet/activity view forwards the RAW event (a `tool_name` + a capped
 * `tool_input`, or a `todos` snapshot) and normalizes it HERE — so there is ONE
 * summary implementation shared by every CLI's report path instead of one per hook.
 *
 * Pure + dependency-free: no I/O, no store, no host coupling. The persistence seam
 * lives in `store.ts` (an injected `TelemetryStore`); this file only decides what a
 * raw event MEANS as `{ kind, summary, detail }`.
 *
 * Cross-CLI native tool-name coverage (case-insensitive):
 *   - file edits:  Edit / Write / MultiEdit / apply_patch / write_file /
 *                  create_file / str_replace / str_replace_editor / patch
 *   - reads:       Read / view / cat / open
 *   - shell:       Bash / shell / run / exec / execute
 *   - search:      Grep / Glob / search / find / rg
 *   - delegation:  Task / spawn / subagent / agent
 *   - todos:       TodoWrite / TaskCreate / TaskUpdate / todo_write
 */

/** A capped, JSON-safe representation of an agent's native tool input. */
export type ToolInput = Record<string, unknown> | null | undefined;

/** One todo item as the CLIs emit them (Claude TodoWrite / OMP todo_write). */
export interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
  [k: string]: unknown;
}

export interface ActivitySummary {
  /** 'tool' | 'lifecycle' | 'todos' — the normalized activity kind. */
  kind: 'tool' | 'lifecycle' | 'todos';
  /** A short one-liner a fleet/activity view renders verbatim. */
  summary: string;
  /** Small structured detail (already capped) for the stored record. */
  detail: Record<string, unknown> | null;
}

const STR_CAP = 500;
const SUMMARY_CLIP = 72;

/** Collapse whitespace + clip to `n` chars with an ellipsis. */
export function clip(s: unknown, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  // n <= 0 has no room for content; n === 1 has room only for the ellipsis. A
  // naive `slice(0, n - 1)` would use a negative end index here (dropping the
  // LAST char and yielding a result LONGER than `n`), so guard it explicitly —
  // the result must never exceed `n`.
  if (n <= 0) return '';
  if (n === 1) return '…';
  return t.slice(0, n - 1) + '…';
}

/** Last path segment, tolerant of trailing slashes + windows separators. */
export function basename(p: unknown): string {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** First file-ish path found in a tool input across the CLIs' differing shapes. */
export function firstPath(input: ToolInput): string | null {
  if (!input || typeof input !== 'object') return null;
  for (const key of ['file_path', 'path', 'filePath', 'file', 'filename', 'target_file', 'notebook_path']) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // apply_patch / multiedit-style: an array of edits or files.
  for (const key of ['files', 'paths', 'edits']) {
    const v = (input as Record<string, unknown>)[key];
    if (Array.isArray(v) && v.length > 0) {
      const f = v[0];
      if (typeof f === 'string' && f.trim()) return f.trim();
      if (f && typeof f === 'object') {
        const inner = firstPath(f as ToolInput);
        if (inner) return inner;
      }
    }
  }
  return null;
}

/** A command string from a shell tool input (string OR argv array). */
export function commandText(input: ToolInput): string | null {
  if (!input || typeof input !== 'object') return null;
  const c = (input as Record<string, unknown>).command ?? (input as Record<string, unknown>).cmd;
  if (typeof c === 'string' && c.trim()) return c.trim();
  if (Array.isArray(c) && c.length > 0) return c.map((x) => String(x)).join(' ').trim();
  return null;
}

/** Cap every string field of a tool input so a giant Write `content` / patch body
 *  never bloats the stored detail. Shallow — the CLIs' inputs are flat-ish. */
export function capDetail(input: ToolInput): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v.length > STR_CAP ? v.slice(0, STR_CAP) + '…' : v;
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
    else if (v && typeof v === 'object') out[k] = '[object]';
    else out[k] = v;
  }
  return out;
}

/** Summarize a TodoWrite/TaskCreate/TaskUpdate/todo_write snapshot. */
export function summariseTodos(todos: TodoItem[]): ActivitySummary {
  const total = todos.length;
  const done = todos.filter((t) => (t.status ?? '').toLowerCase() === 'completed' || (t.status ?? '').toLowerCase() === 'done').length;
  const inProgress = todos.find((t) => (t.status ?? '').toLowerCase() === 'in_progress');
  const active = inProgress ? clip(inProgress.activeForm || inProgress.content, SUMMARY_CLIP) : null;
  const summary = active
    ? `⇄ ${active} (${done}/${total})`
    : `⇄ ${total} todo${total === 1 ? '' : 's'} (${done} done)`;
  return {
    kind: 'todos',
    summary,
    // Cap the stored list to keep detail bounded.
    detail: { count: total, done, todos: todos.slice(0, 20).map((t) => ({ content: clip(t.content, STR_CAP), status: t.status ?? null })) },
  };
}

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'write_file', 'create_file', 'str_replace', 'str_replace_editor', 'patch', 'notebookedit']);
const READ_TOOLS = new Set(['read', 'view', 'cat', 'open', 'read_file']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'run', 'exec', 'execute', 'run_command', 'local_shell']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'search', 'find', 'rg', 'codebase_search']);
const SPAWN_TOOLS = new Set(['task', 'spawn', 'subagent', 'agent', 'dispatch_agent']);

/**
 * Derive `{ kind, summary, detail }` from a native tool call. `todos` (when the
 * hook forwarded a TodoWrite/TaskCreate snapshot) takes precedence over `toolName`.
 */
export function summariseActivity(opts: {
  toolName?: string | null;
  toolInput?: ToolInput;
  todos?: TodoItem[] | null;
}): ActivitySummary {
  const { toolName, toolInput } = opts;
  if (Array.isArray(opts.todos)) return summariseTodos(opts.todos);

  const name = (toolName ?? '').trim();
  if (!name) {
    return { kind: 'lifecycle', summary: '· activity', detail: capDetail(toolInput) };
  }
  const lower = name.toLowerCase();

  // A TodoWrite/todo_write whose list rode in tool_input rather than `todos`.
  if ((lower === 'todowrite' || lower === 'todo_write' || lower === 'taskcreate' || lower === 'taskupdate') && toolInput && Array.isArray((toolInput as Record<string, unknown>).todos)) {
    return summariseTodos((toolInput as Record<string, unknown>).todos as TodoItem[]);
  }

  if (EDIT_TOOLS.has(lower)) {
    const path = firstPath(toolInput);
    return { kind: 'tool', summary: `✎ ${path ? basename(path) : name}`, detail: path ? { file: path } : capDetail(toolInput) };
  }
  if (READ_TOOLS.has(lower)) {
    const path = firstPath(toolInput);
    return { kind: 'tool', summary: `👁 ${path ? basename(path) : name}`, detail: path ? { file: path } : capDetail(toolInput) };
  }
  if (SHELL_TOOLS.has(lower)) {
    const cmd = commandText(toolInput);
    return { kind: 'tool', summary: `▶ ${cmd ? clip(cmd, SUMMARY_CLIP) : name}`, detail: cmd ? { command: clip(cmd, STR_CAP) } : capDetail(toolInput) };
  }
  if (SEARCH_TOOLS.has(lower)) {
    const pat = toolInput && typeof toolInput === 'object'
      ? ((toolInput as Record<string, unknown>).pattern ?? (toolInput as Record<string, unknown>).query ?? (toolInput as Record<string, unknown>).q)
      : null;
    return { kind: 'tool', summary: `🔎 ${pat ? clip(pat, SUMMARY_CLIP) : name}`, detail: capDetail(toolInput) };
  }
  if (SPAWN_TOOLS.has(lower)) {
    const what = toolInput && typeof toolInput === 'object'
      ? ((toolInput as Record<string, unknown>).subagent_type ?? (toolInput as Record<string, unknown>).description ?? (toolInput as Record<string, unknown>).agentType)
      : null;
    return { kind: 'tool', summary: `⊕ ${what ? clip(what, SUMMARY_CLIP) : name}`, detail: capDetail(toolInput) };
  }

  // MCP tool calls (group:verb) and anything else: show the name.
  return { kind: 'tool', summary: `· ${clip(name, SUMMARY_CLIP)}`, detail: capDetail(toolInput) };
}
