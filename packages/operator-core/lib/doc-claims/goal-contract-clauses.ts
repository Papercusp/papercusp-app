/**
 * Clause segmentation for the GOAL-mode contract (su.mode-goal goal.md), used to pin
 * rubric coverage at SUB-OBLIGATION granularity (WI-10005180).
 *
 * Why this exists: the first coverage pass over goal-mode-e2e (WI-10003475) mapped
 * contract SECTIONS to criteria, one per header. A section that had a criterion counted
 * as covered even when the criterion's method enforced only one of the section's
 * obligations, so rule 1's "NOT IN A PLAN YET → plans:new" default route and the
 * revised drain-fence / spend clauses went ungraded for weeks. Splitting at every
 * ALL-CAPS lead-in, numbered rule and rule-1 branch makes each obligation its own
 * clause, and hashing each clause means any contract edit forces the coverage map
 * (and therefore the rubric) to be re-reviewed.
 */
import { createHash } from 'node:crypto';

export interface GoalContractClause {
  /** Stable id: slug of the clause's lead-in, suffixed when the same lead-in repeats. */
  id: string;
  /** 1-based line where the clause starts. */
  line: number;
  /** The lead-in text that opened the clause. */
  leadIn: string;
  /** sha256 of the clause text with whitespace collapsed. */
  sha256: string;
}

const LEAD_IN = /^\s*(?:\d+\.\s+)?((?:[A-Z][A-Z'’-]*[A-Z]|[A-Z])(?:[\s,/-]+(?:[A-Z][A-Z'’-]*[A-Z]|[A-Z]|VS|—|-)){1,}(?=[\s.,:—→-]|$))/;

/** A single ALL-CAPS word opening a clause: "DURABILITY:", "REPORT on…", "GROUND the review…". */
const SINGLE_LEAD = /^\s*([A-Z]{4,})(?=[\s:(])(?!\s+[A-Z]{2,})/;
/** A clause that opens mid-line after a sentence end: "… asking. THE FLOOR IS CONCRETE: …", "… auto-kill. SCOPE — the …". */
const MID_LEAD = /[.!?]["”)]?\s+((?:[A-Z][A-Z'’-]+\s+){2,}[A-Z][A-Z'’-]+|[A-Z]{4,}(?=\s+—|:))/;

function leadInOf(line: string): string | null {
  if (/^\s*##\s/.test(line)) return line.replace(/^\s*#+\s*/, '').trim();
  const m = LEAD_IN.exec(line);
  if (m) {
    const words = m[1].split(/[\s,/]+/).filter((w) => /[A-Z]{2,}/.test(w));
    if (words.length >= 2) return m[1].trim();
  }
  const single = SINGLE_LEAD.exec(line);
  if (single) return single[1];
  const mid = MID_LEAD.exec(line);
  return mid ? mid[1].trim() : null;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function segmentGoalContract(markdown: string): GoalContractClause[] {
  const lines = markdown.split('\n');
  const starts: Array<{ line: number; leadIn: string }> = [];
  lines.forEach((text, i) => {
    const leadIn = leadInOf(text);
    if (leadIn) starts.push({ line: i + 1, leadIn });
  });
  const seen = new Map<string, number>();
  return starts.map((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line - 1 : lines.length;
    const body = lines.slice(s.line - 1, end).join(' ').replace(/\s+/g, ' ').trim();
    const base = slug(s.leadIn) || `clause-${s.line}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}-${n}`,
      line: s.line,
      leadIn: s.leadIn,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
  });
}
