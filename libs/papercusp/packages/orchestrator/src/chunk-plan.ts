/**
 * Types, prompt builders, and parsers for the worker chunk plan.
 *
 * The chunk plan is the worker's contract with itself: a list of
 * self-contained edits in order, each of which leaves the codebase
 * typecheck-clean. Workers emit it once up-front (planChunksUpfront),
 * iterate through it, and re-emit a single replacement chunk on
 * typecheck failure (replanChunk).
 *
 * Wire format: a fenced ```chunk-plan JSON block. Same shape for both
 * up-front plans (multiple chunks) and replans (single chunk replacing
 * the failed one). Parser is forgiving — strips fence markers, single-
 * trailing-comma JSON, and code-fence language tags.
 */

export interface Chunk {
  /** Sequential ID: F-X-1, F-X-2, ...  */
  id: string;
  /** Declared paths the chunk will modify. Must include every file
   *  the worker writes — exceeding the declaration triggers
   *  lock-extension; missing a file is a contract violation. */
  files: readonly string[];
  /** Human-readable, format-constrained: lowercase verb object, ≤72
   *  chars. Used as the commit message body after the chunk[F-X-N]:
   *  prefix. */
  description: string;
}

export interface ChunkPlan {
  /** The feature this plan is for. Echoed back so callers can sanity-
   *  check that the LLM didn't switch features mid-plan. */
  featureId: string;
  chunks: readonly Chunk[];
}

/** Allowed first words in `description`. Constrains worker style and
 *  makes the integration log scannable. Keep this PERMISSIVE about
 *  synonyms — a missing everyday verb hard-fails the whole planning
 *  round (live on frame 138790170, 2026-06-09: haiku wrote "create
 *  hello.txt" and the round died on "create" not being listed while
 *  "add" was — a vocabulary exam, not a style gate). */
export const ALLOWED_VERBS = [
  'add',
  'create',
  'write',
  'implement',
  'remove',
  'delete',
  'rewrite',
  'update',
  'refactor',
  'move',
  'rename',
  'wire',
  'unwire',
  'fix',
  'extract',
] as const;
export type AllowedVerb = (typeof ALLOWED_VERBS)[number];

// ─── Prompts ─────────────────────────────────────────────────────────

export interface PlanChunksUpfrontInput {
  featureId: string;
  featureTitle: string;
  featureDescription: string;
  /** Optional acceptance criteria / hints the orchestrator pulled
   *  from the feature definition. */
  context?: string;
  /**
   * Retry context: when set, the planner knows this feature was
   * previously attempted, the validator REJECTED that attempt, and
   * the prior plan has been dropped. The planner should plan chunks
   * that specifically address the validator's complaints rather than
   * re-implementing the whole feature from scratch.
   *
   * `priorValidatorLog` is the full body of the validator's last
   * `.out` file. `priorFiles` is the set of files the prior plan
   * touched (helps the planner reason about what's already in place).
   */
  priorValidatorLog?: string;
  priorFiles?: string[];
  /**
   * Parse feedback: when set, the planner's PREVIOUS response was
   * rejected by the chunk-plan parser (bad fence / JSON / id / verb /
   * length) and this is the one re-ask — the exact parser error is
   * quoted so the model can correct the format rather than guess.
   */
  parseFeedback?: string;
}

export function planChunksUpfrontPrompt(input: PlanChunksUpfrontInput): string {
  const parseFeedbackSection = input.parseFeedback
    ? `
⚠️  FORMAT REJECTION — your previous chunk-plan was rejected by the parser:
    ${input.parseFeedback}
Re-emit the COMPLETE corrected \`\`\`chunk-plan block. Follow the Rules
below exactly (especially the allowed verbs and the id format).

`
    : '';
  const retrySection = input.priorValidatorLog
    ? `

### Prior validator rejection — this is a RETRY

A previous implementation of this feature was committed but the
validator REJECTED it. The validator's output is below. Plan chunks
that specifically address its complaints. Do NOT re-implement the
whole feature — the foundation is already on the integration branch.
Target only what's wrong.

${
  input.priorFiles && input.priorFiles.length > 0
    ? `Files already touched on this feature's prior attempt:
${input.priorFiles.map((f) => `  - ${f}`).join('\n')}

`
    : ''
}Validator output (verbatim):
\`\`\`
${input.priorValidatorLog.slice(0, 8192)}${input.priorValidatorLog.length > 8192 ? '\n…(truncated; first 8KB of validator output above)' : ''}
\`\`\`

`
    : '';

  return `You are the WORKER for feature ${input.featureId}: ${input.featureTitle}.

${input.featureDescription}

${input.context ? `Additional context:\n${input.context}\n\n` : ''}${parseFeedbackSection}${retrySection}Your task: plan the smallest sequence of self-contained chunks that,
when applied in order, complete this feature. Each chunk must leave
the codebase in a working state — specifically, the project's
typecheck command must pass after the chunk is committed.

Each chunk acquires file-level locks atomically before it runs. Lock
holds match chunk duration, not feature duration, so other workers can
proceed on disjoint files between your chunks.

Output a JSON object inside a fenced \`\`\`chunk-plan block:

\`\`\`chunk-plan
{
  "chunks": [
    { "id": "${input.featureId}-1", "files": ["src/a.ts"],          "description": "add foo()" },
    { "id": "${input.featureId}-2", "files": ["src/a.ts","src/b.ts"], "description": "wire foo through bar" }
  ]
}
\`\`\`

Rules:
- Each chunk's \`files\` MUST include every file the chunk writes.
  Over-declaring is fine; under-declaring will fail.
- Each chunk's commit must independently typecheck. If two changes
  must land together (e.g. rename + update-callers), bundle them into
  ONE chunk — never split such that an intermediate snapshot would be
  broken.
- IDs: \`${input.featureId}-N\` where N starts at 1.
- Description: lowercase, verb-first, ≤ 72 chars.
- Allowed verbs: ${ALLOWED_VERBS.join(', ')}.

Plan the entire feature up-front. Be conservative about chunk
boundaries — when in doubt, fewer larger chunks are safer than many
smaller ones, because each chunk has to typecheck independently.`;
}

export interface ReplanChunkInput {
  featureId: string;
  failedChunk: Chunk;
  typecheckError: string;
  /** What the worker actually wrote, summarized in plain English so
   *  the LLM doesn't have to re-derive it from scratch. */
  attemptedChange: string;
}

export function replanChunkPrompt(input: ReplanChunkInput): string {
  return `Chunk ${input.failedChunk.id} failed the typecheck gate.

Original chunk:
  description: "${input.failedChunk.description}"
  files: ${JSON.stringify(input.failedChunk.files)}

What the worker attempted:
${input.attemptedChange}

Typecheck error:
\`\`\`
${input.typecheckError.slice(0, 4000)}
\`\`\`

The intermediate state — applying the original chunk alone — is not a
working state. You need to BUNDLE additional work into this chunk so
that committing it leaves the tree typecheck-clean.

Common fixes:
  - You added a function but a caller still references the old
    location: include the call-site update files in this chunk.
  - You removed a symbol but importers still reference it: include
    every importer in this chunk.
  - You renamed a type but consumers haven't been updated: include
    every consumer file in this chunk.

Output ONE replacement chunk in the same fenced format, with the same
ID (${input.failedChunk.id}). Subsequent chunks in the plan are
unaffected and will run after this replacement succeeds.

\`\`\`chunk-plan
{
  "chunks": [
    { "id": "${input.failedChunk.id}", "files": [...], "description": "..." }
  ]
}
\`\`\``;
}

// ─── Parsing ─────────────────────────────────────────────────────────

const FENCE_RE = /```chunk-plan\s*\n([\s\S]*?)```/m;

export interface ParseResult<T> {
  ok: true;
  value: T;
}
export interface ParseError {
  ok: false;
  message: string;
}

/**
 * Pull the JSON object out of the fenced \`\`\`chunk-plan block. Returns
 * a structured error rather than throwing — the chunk loop will use
 * the error to decide whether to retry, escalate, or kill the worker.
 */
export function parseChunkPlanBlock(
  output: string,
  expectedFeatureId: string,
): ParseResult<ChunkPlan> | ParseError {
  const m = FENCE_RE.exec(output);
  if (!m) {
    return {
      ok: false,
      message: 'no ```chunk-plan fenced block found in output',
    };
  }
  const raw = m[1].trim();
  let json: unknown;
  try {
    json = JSON.parse(stripTrailingCommas(raw));
  } catch (e) {
    return {
      ok: false,
      message: `chunk-plan JSON parse error: ${(e as Error).message}`,
    };
  }
  if (!json || typeof json !== 'object') {
    return { ok: false, message: 'chunk-plan body is not an object' };
  }
  const obj = json as { chunks?: unknown };
  if (!Array.isArray(obj.chunks)) {
    return { ok: false, message: 'chunk-plan.chunks is not an array' };
  }

  const chunks: Chunk[] = [];
  for (let i = 0; i < obj.chunks.length; i++) {
    const c = obj.chunks[i] as { id?: unknown; files?: unknown; description?: unknown };
    if (typeof c?.id !== 'string') {
      return { ok: false, message: `chunks[${i}].id missing or not a string` };
    }
    if (!Array.isArray(c.files) || c.files.some((f) => typeof f !== 'string')) {
      return { ok: false, message: `chunks[${i}].files missing or not string[]` };
    }
    if (typeof c.description !== 'string') {
      return { ok: false, message: `chunks[${i}].description missing or not a string` };
    }
    const validation = validateChunkShape(c.id, c.files as string[], c.description, expectedFeatureId);
    if (!validation.ok) {
      return validation;
    }
    chunks.push({
      id: c.id,
      files: (c.files as string[]).slice(),
      description: c.description.trim(),
    });
  }

  return { ok: true, value: { featureId: expectedFeatureId, chunks } };
}

function validateChunkShape(
  id: string,
  files: readonly string[],
  description: string,
  expectedFeatureId: string,
): { ok: true } | ParseError {
  if (!id.startsWith(`${expectedFeatureId}-`)) {
    return {
      ok: false,
      message: `chunk id "${id}" does not start with expected feature id "${expectedFeatureId}-"`,
    };
  }
  const idSuffix = id.slice(expectedFeatureId.length + 1);
  if (!/^\d+$/.test(idSuffix)) {
    return {
      ok: false,
      message: `chunk id "${id}" suffix is not a positive integer`,
    };
  }
  if (description.length > 72) {
    return {
      ok: false,
      message: `chunk "${id}" description is ${description.length} chars (max 72)`,
    };
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: `chunk "${id}" description is empty` };
  }
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
  if (!firstWord || !ALLOWED_VERBS.includes(firstWord as AllowedVerb)) {
    return {
      ok: false,
      message: `chunk "${id}" description must start with one of: ${ALLOWED_VERBS.join(', ')}; got "${firstWord}"`,
    };
  }
  return { ok: true };
}

/**
 * Lenient JSON parsing helper — strips a trailing comma in objects and
 * arrays. LLMs sometimes emit them; standard JSON.parse rejects them.
 */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[\]}])/g, '$1');
}

// ─── Commit-message formatter ────────────────────────────────────────

/**
 * `chunk[F-X-3]: add jwt verify middleware`
 *
 * Per the agreed format: the commit subject for a successful chunk.
 */
export function formatChunkCommitMessage(chunk: Chunk): string {
  return `chunk[${chunk.id}]: ${chunk.description}`;
}
