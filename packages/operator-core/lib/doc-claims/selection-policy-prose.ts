/**
 * The responder bound is written in ONE place — `consult/selection-policies.ts` —
 * and this guard keeps every other surface from acquiring a second copy of it.
 *
 * ── Why this guard exists (unified-responder-selection-critique-and-grading
 * -2026-08-30 P-006) ─────────────────────────────────────────────────────────
 * The rubric-vetting cap lived as a hand-typed number at FIVE sites: CLAUDE.md's
 * ship-gate section, the vetting runbook's step 2, the ship-gate refusal message,
 * the goal-disposition refusal message, and a code comment above the vetting
 * check. When D-004 lowered the cap, the enforced value moved and all five kept
 * saying the old one — so the system spent that window instructing agents, in its
 * own refusal errors, to request a wider menu than the selector would grant.
 *
 * That is the derived-truth-ladder failure the repo names: a value that DESCRIBES
 * code, maintained by hand in prose. Rung 1 (DERIVE) is the fix — prose names the
 * POLICY KEY and the messages render from the registry — and this is rung 2 (PIN)
 * holding the fix in place, because nothing about the new text stops a future
 * editor from helpfully "clarifying" it back into a number.
 *
 * ── What it judges ───────────────────────────────────────────────────────────
 * Two subject kinds, because the two populations prove derivation differently:
 *
 *   'prose'  — the CLAUDE.md corpus and the vetting runbook. These must name the
 *              policy KEY (`rubric-vetting`) and must carry no hand-typed bound.
 *              The key is what makes them derived: it identifies the registry
 *              entry rather than quoting its value, and `selectionPolicy()`
 *              throws on an unknown key, so a rename fails loudly at the call
 *              site instead of rotting silently in a document.
 *   'source' — the agent-facing refusal messages. These must call the shared
 *              renderer (`rubricVettingConsultHint`) and must not spell a bound
 *              into their own strings.
 *
 * A subject that is empty, or that no longer mentions the vetting flow at all, is
 * a REFUSAL rather than a pass: this guard's whole value is that it fails when the
 * claim it protects has quietly stopped being made.
 */

/** What a subject must prove, given how it derives the bound. */
export type SubjectKind = 'prose' | 'source';

export interface ProseSubject {
  /** How a violation names this subject — a repo-relative path, normally. */
  label: string;
  kind: SubjectKind;
  text: string;
}

export interface SelectionPolicyViolation {
  subject: string;
  /** 1-indexed line within that subject; 0 when the finding is about the whole file. */
  line: number;
  excerpt: string;
  reason: string;
}

export interface SelectionPolicyProseVerdict {
  ok: boolean;
  violations: SelectionPolicyViolation[];
  /** How many subjects were actually scanned — the non-vacuity denominator. */
  measured: number;
}

/** The registry key every guarded prose surface must name instead of a number. */
export const REQUIRED_POLICY_KEY = 'rubric-vetting';

/** The shared renderer every guarded agent-facing message must call. */
export const REQUIRED_RENDERER = 'rubricVettingConsultHint';

/**
 * The shapes a hand-typed responder bound actually takes in this repo — each one
 * drawn from a site that really drifted, not invented:
 *   "min 1 / max 3"      CLAUDE.md, and both refusal messages
 *   "min:1/max:3"        the runbook's frontmatter description
 *   "max_agents:3"       the runbook's step 2 (an instruction to type the number)
 *   "max 3 responders"   the prose form the refusals used
 * `min_agents` is included for symmetry: the minimum is as much the policy's to
 * own as the maximum, and a doc that pins one will pin the other next.
 */
const BOUND_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = Object.freeze([
  {
    re: /\bmin\s*:?\s*\d+\s*\/\s*max\s*:?\s*\d+/gi,
    reason: 'hand-typed min/max responder bound — name the policy key instead',
  },
  {
    re: /\b(?:max|min)_agents\s*:\s*\d+/g,
    reason: 'instructs a hand-typed responder count — pass `policy` instead',
  },
  {
    re: /\b(?:max|min)(?:imum|)\s+\d+\s+responders?\b/gi,
    reason: 'spells a responder bound in prose — render it from the registry',
  },
  {
    re: /\b\d+\s+responders?\s+(?:max|min)\b/gi,
    reason: 'spells a responder bound in prose — render it from the registry',
  },
]);

/**
 * Does this text still describe the vetting consult at all? Used as the
 * non-vacuity floor: a guarded subject that has stopped mentioning the flow is
 * no longer evidence of anything, and silence is the failure mode a doc guard is
 * least able to notice on its own.
 *
 * This is the DEFAULT floor, scoped to the rubric-vetting flow specifically. A
 * caller judging a different policy's prose (see `JudgeOptions.stillOnTopic`
 * below — e.g. `acceptance-grading-prose.test.ts`, EI-21929043331389136 /
 * WI-1409611) supplies its own predicate rather than reusing this one.
 */
function mentionsVettingFlow(text: string): boolean {
  return /rubric-vetting/.test(text) || (/vett/i.test(text) && /get_feedback/.test(text));
}

/**
 * Overrides for judging a SIBLING policy's prose with the same mechanism
 * (WI-1409611): the registry (`selection-policies.ts`) holds more than one
 * bound, and P-006's fix — name the key, never the number — applies to all of
 * them, not only `rubric-vetting`. Every field defaults to the rubric-vetting
 * behavior, so an existing zero-arg call is byte-for-byte unchanged.
 */
export interface JudgeOptions {
  /** The registry key a `kind:'prose'` subject must name instead of a number. */
  policyKey?: string;
  /** The renderer a `kind:'source'` subject must call instead of hand-rendering. */
  requiredRenderer?: string;
  /** Non-vacuity floor: does this text still describe the flow this policy governs? */
  stillOnTopic?: (text: string) => boolean;
  /** Human phrase for violation messages, e.g. "rubric-vetting consult". */
  flowLabel?: string;
}

/** Line number (1-indexed) of a character offset. */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function excerptAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim().slice(0, 200);
}

export function judgeSelectionPolicyProse(
  subjects: readonly ProseSubject[],
  options: JudgeOptions = {},
): SelectionPolicyProseVerdict {
  const policyKey = options.policyKey ?? REQUIRED_POLICY_KEY;
  const requiredRenderer = options.requiredRenderer ?? REQUIRED_RENDERER;
  const stillOnTopic = options.stillOnTopic ?? mentionsVettingFlow;
  const flowLabel = options.flowLabel ?? 'rubric-vetting consult';
  const violations: SelectionPolicyViolation[] = [];

  if (subjects.length === 0) {
    return {
      ok: false,
      measured: 0,
      violations: [
        {
          subject: '(none)',
          line: 0,
          excerpt: '',
          reason: 'no subjects were scanned — this guard measured nothing, which is not a pass',
        },
      ],
    };
  }

  for (const subject of subjects) {
    if (!subject.text.trim()) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: 'subject is empty or unreadable — the claim it carries cannot be judged',
      });
      continue;
    }

    for (const { re, reason } of BOUND_PATTERNS) {
      // Fresh lastIndex per subject: these are module-level /g regexes.
      re.lastIndex = 0;
      let match: RegExpExecArray | null = re.exec(subject.text);
      while (match !== null) {
        violations.push({
          subject: subject.label,
          line: lineOf(subject.text, match.index),
          excerpt: excerptAt(subject.text, match.index),
          reason,
        });
        match = re.exec(subject.text);
      }
    }

    if (!stillOnTopic(subject.text)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: `no longer describes the ${flowLabel} — either the claim moved (re-point this guard) or it was dropped`,
      });
      continue;
    }

    if (subject.kind === 'prose' && !subject.text.includes(policyKey)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: `describes the ${flowLabel} without naming the '${policyKey}' policy key — the bound would be back in prose`,
      });
    }

    if (subject.kind === 'source' && !subject.text.includes(requiredRenderer)) {
      violations.push({
        subject: subject.label,
        line: 0,
        excerpt: '',
        reason: `agent-facing ${flowLabel.replace(/ consult$/, '')} message does not call ${requiredRenderer}() — its bound is no longer derived from the registry`,
      });
    }
  }

  return { ok: violations.length === 0, violations, measured: subjects.length };
}

/**
 * ── The DERIVED half of this guard (EI-21929043331389136 / WI-1409611) ───────
 *
 * Everything above judges a HAND-MAINTAINED subject list. That is rung 2 (PIN)
 * of the derived-truth ladder, and its structural blind spot is the one the
 * shared-root-cause item names: a pinned list cannot see a subject nobody
 * thought to pin. It was not a hypothetical — the rubric-vetting guard pinned
 * the runbook's `.mdx` SOURCE and passed for ten days while the SERVED twin at
 * `apps/operator/public/internal/docs/agent-insights/acceptance-rubric-vetting.md`
 * still told agents to `pass max_agents:3`, the exact pre-P-006 instruction the
 * fix existed to delete. A guard measuring five files reported five greens.
 *
 * So this census derives the population instead of declaring it: hand the whole
 * tracked file list in, and every file carrying a hand-typed bound WHILE still
 * describing the flow comes back. A caller then asserts that set is empty apart
 * from sites it has explicitly excluded WITH a reason — which makes a brand-new
 * offender, in a file that did not exist when the guard was written, fail.
 *
 * It shares BOUND_PATTERNS with the pinned half deliberately: two detectors
 * with two pattern lists would be the same defect one level up.
 */
export interface BoundSite {
  /** Repo-relative path of the offending file. */
  path: string;
  /** 1-indexed line of the hand-typed bound. */
  line: number;
  excerpt: string;
  reason: string;
}

export interface BoundSiteCensus {
  /** Files actually read — the non-vacuity denominator. */
  scanned: number;
  /** Files skipped because `read` returned null (binary/unreadable). */
  unreadable: string[];
  sites: BoundSite[];
}

export interface CensusOptions {
  /** The candidate population — normally every tracked text file. */
  files: readonly string[];
  /** Reads a file; return null when it cannot be read as text. */
  read: (path: string) => string | null;
  /** Only files still describing this flow are offenders (same floor as the pinned half). */
  stillOnTopic?: (text: string) => boolean;
}

/**
 * Find every file in `files` that spells a responder bound by hand while still
 * describing the guarded flow. Returns the DERIVED population; the caller owns
 * the policy of which sites are legitimately excluded.
 */
export function censusHandTypedBoundSites(options: CensusOptions): BoundSiteCensus {
  const stillOnTopic = options.stillOnTopic ?? mentionsVettingFlow;
  const sites: BoundSite[] = [];
  const unreadable: string[] = [];
  let scanned = 0;

  for (const path of options.files) {
    const text = options.read(path);
    if (text === null) {
      unreadable.push(path);
      continue;
    }
    scanned += 1;
    if (!stillOnTopic(text)) continue;

    for (const { re, reason } of BOUND_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null = re.exec(text);
      while (match !== null) {
        sites.push({
          path,
          line: lineOf(text, match.index),
          excerpt: excerptAt(text, match.index),
          reason,
        });
        match = re.exec(text);
      }
    }
  }

  return { scanned, unreadable, sites };
}

/** Render census sites for an assertion message that points at each offending line. */
export function formatBoundSites(sites: readonly BoundSite[]): string {
  return sites.map((s) => `${s.path}:${s.line} — ${s.reason}\n    ${s.excerpt}`).join('\n');
}

/** Render violations for an assertion message that points at the offending line. */
export function formatViolations(violations: readonly SelectionPolicyViolation[]): string {
  return violations
    .map((v) => `${v.subject}${v.line ? `:${v.line}` : ''} — ${v.reason}${v.excerpt ? `\n    ${v.excerpt}` : ''}`)
    .join('\n');
}
