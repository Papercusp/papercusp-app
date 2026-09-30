/**
 * Doc-claim: the Codex ptool fallback section names EXACT accepted/rejected
 * argument keys for two write tools, so a Codex agent can stop guessing them.
 *
 * Those key names are code-describing metadata — a second copy of a truth the
 * tool's own zod `args` owns — so per the derived-truth ladder they get a
 * build-time divergence check (rung 2, PIN) rather than being hand-maintained.
 * Without this, the prompt keeps teaching `paths`/`body` long after a rename,
 * and the failure is invisible: the prose still reads authoritative.
 *
 * EI-20199546213299985.
 */

/** A claim the prompt makes about one tool's argument surface. */
export interface ToolArgClaim {
  /** Tool name as written in the prompt. */
  readonly tool: string;
  /** Keys the prompt says the tool DOES accept — each must exist in the live schema. */
  readonly accepted: readonly string[];
  /** Keys the prompt says it does NOT accept — each must be absent from the live schema. */
  readonly rejected: readonly string[];
  /**
   * Substrings that must still appear in the prompt. If someone rewrites the
   * prose, this fails and forces the claim table to be revisited with it —
   * that coupling is the whole point of pinning prose to code.
   */
  readonly prose: readonly string[];
}

/**
 * The claims the Codex fallback section currently makes.
 *
 * `improvements:capture` deliberately does NOT claim `harness` is rejected:
 * it is accepted today as a compatibility alias, even though the originating
 * report listed it alongside the genuinely-rejected keys. Measured, not copied.
 */
export const CODEX_PTOOL_ARG_CLAIMS: readonly ToolArgClaim[] = [
  {
    tool: 'locks:acquire',
    accepted: ['paths'],
    rejected: ['files', 'harness'],
    prose: ['`locks:acquire` takes `paths`'],
  },
  {
    tool: 'improvements:capture',
    accepted: ['body'],
    rejected: ['description', 'evidence'],
    prose: ['`improvements:capture` takes `body`'],
  },
];

/**
 * Unwrap a zod schema to its object shape keys.
 *
 * Handles the wrappers actually in use on these tools: `ZodPreprocess`/`ZodPipe`
 * (zod v4 — `_def.out` is the target schema; `_def.in` is the transform) and
 * `ZodEffects` from `.superRefine()` (`_def.schema`).
 *
 * Returns `null`, never `[]`, when the shape cannot be reached. That distinction
 * is load-bearing: an empty array is indistinguishable from "this tool declares
 * no keys", which would make every `rejected` assertion pass VACUOUSLY. Reading
 * `.in` instead of `.out` produced exactly that false-absence during development.
 */
export function objectShapeKeys(schema: unknown): string[] | null {
  let node = schema as { shape?: unknown; _def?: Record<string, unknown> } | null | undefined;
  for (let hops = 0; hops < 16 && node; hops++) {
    if (node.shape && typeof node.shape === 'object') return Object.keys(node.shape as object);
    const def = node._def;
    if (!def) return null;
    const next = def.out ?? def.schema ?? def.innerType ?? null;
    if (!next) return null;
    node = next as typeof node;
  }
  return null;
}

export interface ClaimViolation {
  readonly tool: string;
  readonly kind: 'unreachable-schema' | 'missing-prose' | 'claimed-accepted-absent' | 'claimed-rejected-present';
  readonly detail: string;
}

/**
 * Judge the claims against live schemas + the prompt text.
 *
 * `liveKeys` maps tool name -> its accepted keys, or `null` when the shape could
 * not be read. An unreachable schema is reported as a violation, never skipped:
 * a check that silently stops measuring is the failure mode this guards against.
 */
export function judgeCodexPtoolClaims(
  promptText: string,
  liveKeys: ReadonlyMap<string, string[] | null>,
  claims: readonly ToolArgClaim[] = CODEX_PTOOL_ARG_CLAIMS,
): ClaimViolation[] {
  const violations: ClaimViolation[] = [];

  for (const claim of claims) {
    for (const snippet of claim.prose) {
      if (!promptText.includes(snippet)) {
        violations.push({
          tool: claim.tool,
          kind: 'missing-prose',
          detail: `prompt no longer contains ${JSON.stringify(snippet)} — prose changed; re-verify this claim against the live schema and update CODEX_PTOOL_ARG_CLAIMS with it`,
        });
      }
    }

    const keys = liveKeys.get(claim.tool) ?? null;
    if (keys === null) {
      violations.push({
        tool: claim.tool,
        kind: 'unreachable-schema',
        detail: `could not read the zod object shape for ${claim.tool}; the claim is UNMEASURED, not satisfied`,
      });
      continue;
    }

    for (const key of claim.accepted) {
      if (!keys.includes(key)) {
        violations.push({
          tool: claim.tool,
          kind: 'claimed-accepted-absent',
          detail: `prompt teaches \`${key}\` but ${claim.tool} no longer declares it (declares: ${keys.join(', ')})`,
        });
      }
    }

    for (const key of claim.rejected) {
      if (keys.includes(key)) {
        violations.push({
          tool: claim.tool,
          kind: 'claimed-rejected-present',
          detail: `prompt says ${claim.tool} rejects \`${key}\`, but it is now an accepted key — the prompt is teaching a false negative`,
        });
      }
    }
  }

  return violations;
}
