/** Readable tool-approval cards for the PUI (pui-chat-first-ux P-008).
 *
 * The P-005 review found the default chat asking `Allow mcp__papercusp-su__
 * work_items_claimable?` and `Allow Edit?` above the raw `{file_path,
 * old_string, new_string}` object. Claude Code asks about `Update(calc.js)`
 * and shows the diff. This module is the TypeScript twin of the PUI's
 * `apps/tui/src/tool_display.rs` (same titles: `Read(x)`, `Update(x)`,
 * `Bash(cmd)`, `server · verb words (MCP)`), plus what an approval needs on
 * top of a transcript row: the change itself (a bounded -/+ diff for an edit,
 * the full command for a shell call) and the raw arguments, which stay out of
 * the prompt and are shown only behind the PUI details toggle. */

const TARGET_CHARS = 60;
const BODY_LINES = 12;

type Input = Record<string, unknown>;

const words = (id: string): string => id.replace(/[_-]/g, ' ');

const record = (value: unknown): Input =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Input : {};

const str = (input: Input, key: string): string | undefined => {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

function clip(text: string, max: number): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ');
  if ([...flat].length <= max) return flat;
  return `${[...flat].slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

/** A path relative to the chat's launch directory, the way Claude Code shows
 * `calc.js` rather than `/tmp/…/calc.js`; a path outside it stays absolute. */
function displayPath(path: string, cwd?: string): string {
  const base = cwd?.replace(/\/+$/, '');
  if (base && path.startsWith(`${base}/`) && path.length > base.length + 1) return path.slice(base.length + 1);
  return path;
}

/** `mcp__<server>__<verb>` → `<server> · <verb words> (MCP)`; `group:verb` →
 * `group verb`; any other name unchanged. */
export function humanToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length);
    const split = rest.indexOf('__');
    if (split > 0 && split + 2 < rest.length) return `${rest.slice(0, split)} · ${words(rest.slice(split + 2))} (MCP)`;
  }
  const colon = /^([^:\s]+):([^:\s]+)$/.exec(name);
  if (colon) return `${words(colon[1])} ${words(colon[2])}`;
  return name;
}

/** A `tools:invoke` wrapper is labelled as the tool it dispatches. */
function effective(name: string, input: Input): { name: string; input: Input } {
  if ((name === 'tools:invoke' || name.endsWith('__tools_invoke')) && typeof input.name === 'string' && input.name) {
    return { name: input.name, input: record(input.args) };
  }
  return { name, input };
}

function scalar(value: unknown): string {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean).join(' ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  const n = Object.keys(value as object).length;
  return `${n} field${n === 1 ? '' : 's'}`;
}

/** One `key: value · key: value` line — scalars as values, containers as their
 * size — or undefined when there is nothing worth a line. */
export function humanArgs(input: Input, width = 160): string | undefined {
  const parts = Object.entries(input).filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${words(k)}: ${scalar(v)}`);
  return parts.length ? clip(parts.join(' · '), width) : undefined;
}

export interface ToolTitle {
  /** `Update(calc.js)`, `Bash(npm test)`, `papercusp-su · work items claimable (MCP)`. */
  title: string;
  /** Lines under the title: a summary, the diff, the full command. Never raw JSON. */
  body: string[];
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function bounded(lines: string[]): string[] {
  if (lines.length <= BODY_LINES) return lines;
  return [...lines.slice(0, BODY_LINES), `… ${plural(lines.length - BODY_LINES, 'more line')}`];
}

/** The changed lines of one string replacement: the common leading and trailing
 * lines are dropped, the rest shown as `- old` / `+ new`. */
function replacement(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

function editBody(input: Input): string[] {
  const edits = Array.isArray(input.edits)
    ? input.edits.map(record)
    : [input];
  const removed: string[] = [];
  const added: string[] = [];
  const diff: string[] = [];
  for (const edit of edits) {
    const oldText = typeof edit.old_string === 'string' ? edit.old_string : '';
    const newText = typeof edit.new_string === 'string' ? edit.new_string : '';
    const change = replacement(oldText, newText);
    removed.push(...change.removed);
    added.push(...change.added);
    diff.push(...change.removed.map((line) => `- ${line}`), ...change.added.map((line) => `+ ${line}`));
  }
  const every = edits.some((edit) => edit.replace_all === true) ? ' (every occurrence)' : '';
  const summary = `Add ${plural(added.length, 'line')}, remove ${plural(removed.length, 'line')}${every}`;
  return [summary, ...bounded(diff)];
}

/** Title and body for one tool call. `cwd` shortens paths inside the chat's
 * launch directory. */
export function toolTitle(rawName: string, rawInput: unknown, cwd?: string): ToolTitle {
  const { name, input } = effective(rawName, record(rawInput));
  const path = str(input, 'file_path') ?? str(input, 'notebook_path') ?? str(input, 'path');
  const shown = path ? clip(displayPath(path, cwd), TARGET_CHARS) : undefined;
  const target = (verb: string, t?: string) => (t ? `${verb}(${t})` : verb);
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return { title: target('Read', shown), body: [] };
    case 'Edit':
    case 'MultiEdit':
      return { title: target('Update', shown), body: editBody(input) };
    case 'NotebookEdit': {
      const summary = humanArgs({ ...input, notebook_path: undefined });
      return { title: target('Update', shown), body: summary ? [summary] : [] };
    }
    case 'Write': {
      const content = typeof input.content === 'string' ? input.content : '';
      const lines = content ? content.replace(/\n$/, '').split('\n') : [];
      return { title: target('Write', shown), body: [`Write ${plural(lines.length, 'line')}`, ...bounded(lines.map((line) => `+ ${line}`))] };
    }
    case 'Bash':
    case 'shell':
    case 'exec_command':
    case 'local_shell': {
      const argv = Array.isArray(input.command) ? input.command.filter((part): part is string => typeof part === 'string').join(' ') : undefined;
      const command = str(input, 'command') ?? str(input, 'cmd') ?? argv;
      const description = str(input, 'description');
      // An approval must show the whole command, never only the clipped title.
      const full = command && clip(command, Number.MAX_SAFE_INTEGER) !== clip(command, TARGET_CHARS) ? [command] : [];
      return { title: target('Bash', command && clip(command, TARGET_CHARS)), body: [...(description ? [description] : []), ...full] };
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str(input, 'pattern');
      return { title: target('Search', pattern && clip(pattern, TARGET_CHARS)), body: path ? [`in ${displayPath(path, cwd)}`] : [] };
    }
    case 'WebFetch':
      return { title: target('Fetch', str(input, 'url') && clip(str(input, 'url')!, TARGET_CHARS)), body: [] };
    case 'WebSearch':
      return { title: target('Web Search', str(input, 'query') && clip(str(input, 'query')!, TARGET_CHARS)), body: [] };
    case 'TodoWrite':
      return { title: 'Update todos', body: [] };
    default: {
      const summary = humanArgs(input);
      return { title: humanToolName(name), body: summary ? [summary] : [] };
    }
  }
}

export interface ApprovalCardText {
  /** What the card shows: `Allow Update(calc.js)?`, the diff, Claude's reason. */
  prompt: string;
  /** The raw arguments, sent as the card's `details`: the PUI shows them only
   * behind its details toggle. */
  details: string;
}

/** The text of one native tool-approval card. A `title` Claude supplies is
 * kept (it is already human text); otherwise the readable tool title is asked
 * about. The full path is shown under the title when the title shortened it,
 * so the owner always sees exactly which file is affected. */
export function approvalCardText(toolName: string, input: unknown,
  options: { title?: string; description?: string; decisionReason?: string; cwd?: string } = {}): ApprovalCardText {
  const { name, input: args } = effective(toolName, record(input));
  const display = toolTitle(toolName, input, options.cwd);
  const path = str(args, 'file_path') ?? str(args, 'notebook_path');
  const fullPath = path && !display.title.includes(`(${path})`) ? [path] : [];
  const lines = [options.title || `Allow ${display.title}?`, ...fullPath, ...display.body,
    options.description, options.decisionReason].filter((line): line is string => Boolean(line && line.trim()));
  return { prompt: lines.join('\n'), details: `Raw arguments (${name}):\n${JSON.stringify(record(input), null, 2)}` };
}
