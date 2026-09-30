/**
 * DESIGN_SPEC.md resolver — fallback chain.
 *
 * Order: harness → workspace → app default → empty (warning).
 * See plan §5.1.
 *
 * The resolver returns the resolved markdown body and parsed frontmatter
 * along with which layer it came from, so the design-tab can show
 * the resolution path in a tooltip / banner.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type DesignSpecLayer = 'harness' | 'workspace' | 'app-default' | 'empty';

export interface DesignSpecModels {
  designer?: string;
  reviewer?: string;
  crit?: string;
  /** Implementer model is set by the existing implementer config, not here. */
}

export interface DesignSpecFrontmatter {
  models?: DesignSpecModels;
  [key: string]: unknown;
}

export interface ResolvedDesignSpec {
  layer: DesignSpecLayer;
  /** Absolute path of the file we read; null for `empty`. */
  source: string | null;
  /** Raw markdown body (frontmatter stripped). Empty string on `empty`. */
  body: string;
  /** Parsed YAML frontmatter; empty object when none. */
  frontmatter: DesignSpecFrontmatter;
  /** When layer === 'empty', a warning the design tab can surface. */
  warning?: string;
}

export interface ResolverInputs {
  /** Absolute path of the active harness root. May be null in the
   *  workspace-only case. */
  harnessRoot: string | null;
  /** Absolute path of the workspace root. */
  workspaceRoot: string;
  /** Absolute path of the app-default markdown file. Defaults to the
   *  one bundled alongside this resolver. */
  appDefaultPath?: string;
  /** Filename to look for at each layer. Defaults to "DESIGN_SPEC.md". */
  filename?: string;
  /** For testing: alternative readFile. */
  readFile?: (p: string) => Promise<string>;
}

const DEFAULT_FILENAME = 'DESIGN_SPEC.md';
const APP_DEFAULT_REL = './default.md';

function defaultReadFile(p: string): Promise<string> {
  return fs.readFile(p, 'utf-8');
}

/**
 * Tiny YAML frontmatter parser. Handles the simple shapes we actually
 * use here: scalar values + one level of nesting. Unknown shapes pass
 * through as strings and are ignored downstream — by design, this is
 * not a general YAML parser.
 */
function parseFrontmatter(body: string): { fm: DesignSpecFrontmatter; rest: string } {
  if (!body.startsWith('---')) return { fm: {}, rest: body };
  const end = body.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, rest: body };
  const head = body.slice(3, end).trim();
  const rest = body.slice(end + 4).replace(/^\r?\n/, '');
  const fm: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentObj: Record<string, unknown> | null = null;
  for (const rawLine of head.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s+/.test(rawLine);
    if (!indented) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, val] = m;
      if (val === '' || val === undefined) {
        // begin nested object
        currentKey = key;
        currentObj = {};
        fm[key] = currentObj;
      } else {
        fm[key] = stripQuotes(val);
        currentKey = null;
        currentObj = null;
      }
    } else if (currentObj) {
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, key, val] = m;
      currentObj[key] = stripQuotes(val);
    }
  }
  return { fm: fm as DesignSpecFrontmatter, rest };
}

/**
 * Strip a trailing `#` comment, quote-aware. A `#` only begins a comment when it
 * is at the start of the line OR preceded by whitespace AND is not inside a single-
 * or double-quoted string. So `brand: "#ff0066"` (hex) and `url: "x#frag"` keep
 * their `#`, while `key: value # note` still drops the comment. (Matches YAML's
 * rule that `#` mid-token — e.g. inside a quoted scalar — is a literal.)
 */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only a real comment when at line-start or preceded by whitespace.
      if (i === 0 || /\s/.test(line[i - 1]!)) return line.slice(0, i);
    }
  }
  return line;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

async function tryRead(
  p: string,
  read: (q: string) => Promise<string>,
): Promise<string | null> {
  try {
    return await read(p);
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'code' in e && (e as { code: string }).code === 'ENOENT') {
      return null;
    }
    throw e;
  }
}

/**
 * Walk the fallback chain. First hit wins.
 */
export async function resolveDesignSpec(input: ResolverInputs): Promise<ResolvedDesignSpec> {
  const filename = input.filename ?? DEFAULT_FILENAME;
  const read = input.readFile ?? defaultReadFile;
  const appDefault =
    input.appDefaultPath ?? path.resolve(__dirname, APP_DEFAULT_REL);

  const candidates: Array<{ layer: DesignSpecLayer; path: string }> = [];
  if (input.harnessRoot) {
    candidates.push({ layer: 'harness', path: path.join(input.harnessRoot, filename) });
  }
  candidates.push({ layer: 'workspace', path: path.join(input.workspaceRoot, filename) });
  candidates.push({ layer: 'app-default', path: appDefault });

  for (const c of candidates) {
    const raw = await tryRead(c.path, read);
    if (raw !== null) {
      const { fm, rest } = parseFrontmatter(raw);
      return { layer: c.layer, source: c.path, body: rest, frontmatter: fm };
    }
  }

  return {
    layer: 'empty',
    source: null,
    body: '',
    frontmatter: {},
    warning:
      'no DESIGN_SPEC.md found at harness, workspace, or app-default paths; designer is operating with no rules — quality will suffer',
  };
}

/**
 * Convenience for the designer-agent prompt assembler: returns just the
 * fully-rendered markdown the designer should load (frontmatter stripped
 * but headers added so the agent knows the layer it came from).
 */
export function renderResolvedSpec(spec: ResolvedDesignSpec): string {
  const header =
    spec.layer === 'empty'
      ? `<!-- DESIGN_SPEC: empty (no fallback found) -->\n${spec.warning ?? ''}\n`
      : `<!-- DESIGN_SPEC: layer=${spec.layer} source=${spec.source} -->\n`;
  return header + spec.body;
}
