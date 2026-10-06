/**
 * GDPval reference-deliverable → TEXT resolver (plan benchmark-suite-gdpval-2026-06-17, P-004).
 *
 * The pairwise autograder (grader/gdpval.ts) compares the arm's deliverable against the EXPERT reference
 * deliverable — but the reference is a FILE BUNDLE in the dataset (xlsx/docx/pptx/pdf/csv/…). This module
 * fetches those files and reduces them to text/markdown so the judge can read them, and CLEANLY EXCLUDES the
 * binary types a text judge can't read (CAD/video/images) with an `excludeReason` — surfaced, never a silent
 * loss (D-005). The same extractor serves the generation arm's INPUT-file reading (P-005).
 *
 * Testable by construction: the network fetch and the office/pdf extraction are INJECTED ports, so the
 * classification + text-format extraction + the all-excluded / concat logic are unit-tested with fakes — no
 * network, no heavy parser deps in the test path. The live office/pdf extractor ({@link pythonOfficeExtract})
 * is the one I/O binding (best-effort; a failure degrades to an excludeReason, never a throw that drops a task).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchTask } from '../types';

/** How a deliverable file is handled, by extension. */
export type FileClass = 'text' | 'office' | 'excluded';

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'html', 'htm', 'xml', 'yaml', 'yml', 'log']);
const OFFICE_EXTS = new Set(['xlsx', 'xls', 'xlsm', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'odt', 'ods', 'odp', 'rtf']);
// Binary types a TEXT autograder cannot meaningfully read → excluded (surfaced, not scored as a loss).
const EXCLUDED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tiff', 'tif', 'webp', 'svg', 'psd', 'ai', 'eps', 'fig',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'm4a',
  'zip', 'tar', 'gz', 'rar', '7z',
  'dwg', 'dxf', 'step', 'stp', 'stl', 'iges', 'igs', 'sldprt', 'sldasm', 'cad', '3ds', 'obj', 'blend',
]);

/** Lowercased extension (no dot) of a filename/URL path; '' if none. */
export function fileExt(nameOrUrl: string): string {
  const path = nameOrUrl.split(/[?#]/)[0];
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Classify a deliverable file by extension. Unknown extensions default to `office` (try to extract). */
export function classifyFile(nameOrUrl: string): FileClass {
  const ext = fileExt(nameOrUrl);
  if (EXCLUDED_EXTS.has(ext)) return 'excluded';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (OFFICE_EXTS.has(ext)) return 'office';
  return ext === '' ? 'text' : 'office'; // extensionless → assume text; unknown ext → try office extraction
}

/** A per-file extraction result: either text, or a reason it was excluded. */
export type FileExtract = { ok: true; text: string } | { ok: false; excludeReason: string };

/** Strip HTML tags to plain text (light — the judge tolerates rough text). */
function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Injected ports — the network fetch + the office/pdf text extractor (so the logic is unit-testable). */
export interface ResolverDeps {
  /** Fetch a URL → raw bytes. */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  /** Extract text from an office/pdf file's bytes (filename gives the type). Throws on failure. */
  officeExtract: (bytes: Uint8Array, filename: string) => Promise<string>;
}

/** Extract ONE file's bytes → text or excludeReason, by class. Truncates very large text to keep the judge prompt bounded. */
export async function extractFile(bytes: Uint8Array, nameOrUrl: string, deps: ResolverDeps, maxChars = 40_000): Promise<FileExtract> {
  const cls = classifyFile(nameOrUrl);
  const ext = fileExt(nameOrUrl) || '(none)';
  if (cls === 'excluded') return { ok: false, excludeReason: `binary deliverable (.${ext}) — the text autograder cannot read it` };
  try {
    let text: string;
    if (cls === 'text') {
      const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      text = ext === 'html' || ext === 'htm' ? stripHtml(raw) : raw;
    } else {
      text = await deps.officeExtract(bytes, nameOrUrl);
    }
    text = text.trim();
    if (!text) return { ok: false, excludeReason: `extracted no text from .${ext}` };
    return { ok: true, text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text };
  } catch (e) {
    return { ok: false, excludeReason: `extraction failed for .${ext}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A bundle resolution: the concatenated readable text + which files were excluded. */
export interface BundleResolution {
  /** Concatenated text of the readable files (with per-file headers), or '' if none readable. */
  text: string;
  /** Files that could not be read (binary / extraction failure), with reasons — surfaced for honest coverage. */
  excluded: { file: string; reason: string }[];
  /** True iff NO file in the bundle was readable → the whole task should be excluded from scoring. */
  allExcluded: boolean;
}

/** Resolve a bundle of file URLs → concatenated text + the excluded list. Fetches each via the injected port. */
export async function resolveBundle(urls: string[], deps: ResolverDeps): Promise<BundleResolution> {
  const parts: string[] = [];
  const excluded: { file: string; reason: string }[] = [];
  for (const url of urls) {
    const name = url.split('/').pop() ?? url;
    let result: FileExtract;
    try {
      result = await extractFile(await deps.fetchBytes(url), url, deps);
    } catch (e) {
      result = { ok: false, excludeReason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (result.ok) parts.push(`## File: ${name}\n${result.text}`);
    else excluded.push({ file: name, reason: result.excludeReason });
  }
  return { text: parts.join('\n\n'), excluded, allExcluded: parts.length === 0 && urls.length > 0 };
}

/**
 * Resolve the reference deliverable for each {@link BenchTask} → populate `graderMeta.referenceDeliverableText`
 * (what the autograder compares against). A task whose reference bundle is entirely binary/unreadable gets
 * `graderMeta.referenceExcludeReason` instead — the grader excludes it (NOT a silent loss; D-005). Returns NEW
 * tasks (does not mutate the inputs). Concurrency-bounded so a 220-task resolve doesn't open 220 fetches at once.
 */
export async function resolveGdpvalReferences(tasks: BenchTask[], deps: ResolverDeps, concurrency = 6): Promise<BenchTask[]> {
  const out: BenchTask[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      const urls = ((task.graderMeta?.referenceDeliverableUrls as string[]) ?? []).filter((u) => typeof u === 'string');
      if (urls.length === 0) {
        out[i] = { ...task, graderMeta: { ...task.graderMeta, referenceExcludeReason: 'task has no reference deliverable files' } };
        continue;
      }
      const res = await resolveBundle(urls, deps);
      out[i] = {
        ...task,
        graderMeta: {
          ...task.graderMeta,
          ...(res.allExcluded
            ? { referenceExcludeReason: `reference deliverable unreadable: ${res.excluded.map((e) => e.reason).join('; ')}` }
            : { referenceDeliverableText: res.text }),
          referenceExcludedFiles: res.excluded,
        },
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tasks.length)) }, () => worker()));
  return out;
}

/**
 * The LIVE office/pdf extractor — shells to a python helper (best-effort). Needs the python libs
 * (openpyxl / python-docx / python-pptx / pypdf) for full coverage; a missing lib throws (the caller degrades
 * to an excludeReason). This is the one I/O binding; the pure logic above is extractor-agnostic.
 *
 * Injected, not imported at module top, so the pure module carries no child_process/fs dependency.
 */
export function makePythonOfficeExtract(opts: {
  pythonBin: string;
  run: (cmd: string, args: string[], stdin: Uint8Array) => Promise<{ stdout: string; code: number; stderr: string }>;
}): ResolverDeps['officeExtract'] {
  const SCRIPT = [
    'import sys,io',
    'data=sys.stdin.buffer.read()',
    'name=sys.argv[1].lower()',
    'def out(s):',
    '  sys.stdout.write(s or "")',
    'try:',
    '  if name.endswith((".xlsx",".xlsm",".xls",".ods")):',
    '    import openpyxl',  // merge computed values (data_only) with formulas — agent-written sheets have no
    '    wbv=openpyxl.load_workbook(io.BytesIO(data),data_only=True,read_only=True)',  // cached formula values,
    '    wbf=openpyxl.load_workbook(io.BytesIO(data),data_only=False,read_only=True)',  // so fall back to the formula text
    '    rows=[]',
    '    for wsv,wsf in zip(wbv.worksheets,wbf.worksheets):',
    '      for rv,rf in zip(wsv.iter_rows(values_only=True),wsf.iter_rows(values_only=True)):',
    '        rows.append("\\t".join((("" if v is None else str(v)) or ("" if f is None else str(f))) for v,f in zip(rv,rf)))',
    '    out("\\n".join(rows))',
    '  elif name.endswith((".docx",".odt")):',
    '    import docx; d=docx.Document(io.BytesIO(data))',
    '    parts=[p.text for p in d.paragraphs]',  // body paragraphs
    '    for tb in d.tables:',                    // + table cells (much docx content lives here)
    '      for row in tb.rows:',
    '        parts.append("\\t".join(c.text for c in row.cells))',
    '    out("\\n".join(x for x in parts if x and x.strip()))',
    '  elif name.endswith((".pptx",".odp")):',
    '    from pptx import Presentation; pr=Presentation(io.BytesIO(data))',
    '    out("\\n".join(sh.text for sl in pr.slides for sh in sl.shapes if sh.has_text_frame))',
    '  elif name.endswith(".pdf"):',
    '    from pypdf import PdfReader; r=PdfReader(io.BytesIO(data)); out("\\n".join((pg.extract_text() or "") for pg in r.pages))',
    '  else:',
    '    out(data.decode("utf-8","replace"))',
    'except Exception as e:',
    '  sys.stderr.write(str(e)); sys.exit(3)',
  ].join('\n');
  return async (bytes, filename) => {
    const name = filename.split('/').pop() ?? filename;
    const { stdout, code, stderr } = await opts.run(opts.pythonBin, ['-c', SCRIPT, name], bytes);
    if (code !== 0) throw new Error(stderr.trim() || `python extractor exited ${code}`);
    return stdout;
  };
}

/** The provisioned office-extractor python (env-overridable). The gdpval venv carries openpyxl/python-docx/
 *  python-pptx/pypdf; provision it once with `python3 -m venv <here> && pip install openpyxl python-docx python-pptx pypdf`. */
export function defaultGdpvalPythonBin(): string {
  return process.env.PAPERCUSP_GDPVAL_PYTHON ?? join(homedir(), '.papercusp', 'bench-results', 'gdpval', 'venv', 'bin', 'python');
}

/**
 * The LIVE resolver deps — global `fetch` for bytes + the venv python office extractor (spawned, bytes on
 * stdin). The one I/O binding the runner uses; child_process is lazy-imported so the pure module stays light.
 */
export function makeLiveResolverDeps(pythonBin: string = defaultGdpvalPythonBin()): ResolverDeps {
  const run = async (cmd: string, args: string[], stdin: Uint8Array) => {
    const { spawn } = await import('node:child_process');
    return await new Promise<{ stdout: string; code: number; stderr: string }>((resolve) => {
      const p = spawn(cmd, args);
      let stdout = '';
      let stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('error', (e) => resolve({ stdout, stderr: String(e), code: 1 }));
      p.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      p.stdin.write(Buffer.from(stdin));
      p.stdin.end();
    });
  };
  return {
    fetchBytes: async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer()),
    officeExtract: makePythonOfficeExtract({ pythonBin, run }),
  };
}
