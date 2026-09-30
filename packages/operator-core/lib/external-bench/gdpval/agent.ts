/**
 * The GDPval deliverable-GENERATION arm (plan benchmark-suite-gdpval-2026-06-17, P-005).
 *
 * GDPval grades a real professional DELIVERABLE (a doc / spreadsheet / deck / …), so the arm must PRODUCE FILES,
 * not a FINAL ANSWER string. This reuses the GAIA ReAct loop ({@link runGaiaAgent}) + its run_python-in-scratch
 * toolset (the agent writes deliverable files via openpyxl / python-docx / python-pptx, or plain .md/.csv/.txt),
 * driven by a deliverable-producing system prompt instead of GAIA's FINAL-ANSWER discipline. After the run we
 * collect the files the agent CREATED (everything not a staged input) and reduce them to text via the P-004
 * resolver — that text is the {@link deliverableSubmission} the pairwise autograder compares to the expert
 * reference.
 *
 * Pure where it can be: {@link buildGdpvalBrief} + {@link collectOutputFileNames} are unit-tested; the LLM,
 * toolset, and filesystem are injected so {@link generateGdpvalDeliverable} runs under a fake with no spend.
 */
import { join } from 'node:path';
import { runGaiaAgent, type GaiaAgentConfig, type GaiaAgentResult, type GaiaToolset, type LlmFn } from '../gaia/agent';
import type { GaiaTask } from '../gaia/dataset';
import { extractFile, type ResolverDeps } from './reference-resolver';

/** The deliverable-producer system prompt — the GDPval analog of GAIA's FINAL-ANSWER prompt. */
export const GDPVAL_AGENT_SYSTEM = [
  'You are an experienced professional producing a real, client-quality work deliverable in response to a task.',
  'Your output will be graded BLIND against a deliverable made by a human expert with ~14 years of experience —',
  'so it must be complete, correct, and professionally formatted, not a sketch or a description of what you would do.',
  '',
  'How to work:',
  '- Read any provided input files first (read_file, or run_python to parse spreadsheets/PDFs).',
  '- Research with web_search + fetch_url when the task needs external facts.',
  '- PRODUCE THE ACTUAL DELIVERABLE AS FILE(S) in your current working directory using run_python or direct writes.',
  '- ALWAYS write a COMPLETE deliverable as a markdown file named "deliverable.md" containing the FULL content —',
  '  every section, table (as markdown tables), figure, number, and recommendation. This markdown is what gets graded,',
  '  so it must stand entirely on its own. You MAY ALSO produce a native file (.xlsx via openpyxl, .docx via',
  '  python-docx, .pptx via python-pptx) when the task asks for that format — but never put content ONLY in a binary',
  '  file; the markdown must always carry the complete deliverable content.',
  '- Do NOT merely describe the deliverable — write its full content. An empty or contentless deliverable scores as none.',
  '- When the deliverable is finished and saved, briefly list the file(s) you created, then stop.',
].join('\n');

/** Build the initial brief: the task prompt + a note about staged input files + the produce-files instruction. */
export function buildGdpvalBrief(prompt: string, stagedInputFiles: string[]): string {
  const inputs = stagedInputFiles.length
    ? `\n\nInput files are staged in your working directory: ${stagedInputFiles.join(', ')}. Read them before producing the deliverable.`
    : '';
  return `${prompt}${inputs}\n\nProduce the complete deliverable as file(s) in your current working directory.`;
}

/** Pure: the agent's output files = everything present after the run that was NOT a staged input (sorted). */
export function collectOutputFileNames(filesAfter: string[], stagedInputs: string[]): string[] {
  const staged = new Set(stagedInputs);
  return filesAfter.filter((f) => !staged.has(f)).sort();
}

/** Injected deps for one generation: the LLM + toolset (live or fake) + the scratch filesystem + office extractor. */
export interface GdpvalGenerationDeps {
  llm: LlmFn;
  tools: GaiaToolset;
  /** The agent's working directory (where run_python executes + writes files). */
  scratchDir: string;
  /** Filenames already staged in scratchDir before the run (the task inputs) — excluded from the deliverable. */
  stagedInputFiles: string[];
  listFiles: (dir: string) => Promise<string[]>;
  readFileBytes: (path: string) => Promise<Uint8Array>;
  /** Office/pdf → text extractor (the resolver's; reuse makeLiveResolverDeps().officeExtract). */
  officeExtract: ResolverDeps['officeExtract'];
  agentConfig?: GaiaAgentConfig;
  /** Retry ONCE with a forceful "write the file now" brief if the first run yields an empty deliverable
   *  (the agent narrated a plan without calling run_python, or wrote only unreadable/empty files). Default true. */
  retryOnEmpty?: boolean;
}

export interface GdpvalGenerationResult {
  /** The produced deliverable bundle reduced to text — the qa-style submission the autograder grades. */
  deliverableText: string;
  /** The files the agent created (the deliverable bundle). */
  outputFiles: string[];
  /** Created files that couldn't be reduced to text (binary the judge can't read), with reasons. */
  excluded: { file: string; reason: string }[];
  /** The underlying agent run (telemetry: turns, tokens, stopReason). */
  agent: GaiaAgentResult;
}

/**
 * Run the generation arm for ONE GDPval task: drive the ReAct agent with the deliverable brief, then collect +
 * reduce the produced files to text. Never throws out of the loop (a task failure stays a task failure).
 */
export async function generateGdpvalDeliverable(
  task: { instanceId: string; prompt: string },
  deps: GdpvalGenerationDeps,
): Promise<GdpvalGenerationResult> {
  // extractFile only needs officeExtract for local files (fetchBytes is unused — we read bytes directly).
  const extractDeps: ResolverDeps = { fetchBytes: async () => { throw new Error('local file, no fetch'); }, officeExtract: deps.officeExtract };

  // Run the agent once for `question`, then collect + reduce the files it created to deliverable text.
  const runOnce = async (question: string): Promise<GdpvalGenerationResult> => {
    const gaiaTask: GaiaTask = { taskId: task.instanceId, question, level: 1, finalAnswer: '', fileName: '' };
    const agent = await runGaiaAgent(gaiaTask, { llm: deps.llm, tools: deps.tools }, { systemPrompt: GDPVAL_AGENT_SYSTEM, ...deps.agentConfig });
    const after = await deps.listFiles(deps.scratchDir).catch(() => []);
    const outputs = collectOutputFileNames(after, deps.stagedInputFiles);
    const parts: string[] = [];
    const excluded: { file: string; reason: string }[] = [];
    for (const f of outputs) {
      let bytes: Uint8Array;
      try {
        bytes = await deps.readFileBytes(join(deps.scratchDir, f));
      } catch (e) {
        excluded.push({ file: f, reason: `read failed: ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      const r = await extractFile(bytes, f, extractDeps);
      if (r.ok) parts.push(`## ${f}\n${r.text}`);
      else excluded.push({ file: f, reason: r.excludeReason });
    }
    return { deliverableText: parts.join('\n\n'), outputFiles: outputs, excluded, agent };
  };

  const first = await runOnce(buildGdpvalBrief(task.prompt, deps.stagedInputFiles));
  if (first.deliverableText.trim() || (deps.retryOnEmpty ?? true) === false) return first;

  // Empty deliverable: the agent narrated a plan without calling run_python, or wrote only unreadable/empty
  // files (the GAIA loop ends on "no tool call"). Retry ONCE, forcefully demanding the file be written.
  const forceful =
    'CRITICAL: your previous attempt saved NO readable deliverable. You MUST now use run_python to WRITE a file ' +
    'named "deliverable.md" containing the COMPLETE deliverable (all sections, tables as markdown), then stop. ' +
    'Do not end your turn until that file exists.\n\n' +
    buildGdpvalBrief(task.prompt, deps.stagedInputFiles);
  const second = await runOnce(forceful);
  return second.deliverableText.trim() ? second : first; // keep whichever produced content
}
