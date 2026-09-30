/**
 * Playbook rule segmentation for prompt sedimentology (self-learning-frontier
 * P-023 / FB-09) — turn the SU engineer playbook BODY (the exact spliced text
 * the llm-testing `su` target feeds the SUT, `loadPlaybookBody()`) into
 * discrete ABLATABLE RULE UNITS, and produce the body with one unit removed.
 *
 * A rule unit is a **bold-led** block — the playbook's house style for a hard
 * rule — at the top level of a `##` section:
 *
 *   - a bold-led bullet (`- **File locking is ENFORCED…**` + its indented
 *     continuation lines), or
 *   - a bold-led paragraph (`**You don't commit or push…**` + its contiguous
 *     non-blank lines).
 *
 * Identity is two-layered (the dead-weight report's evidence semantics):
 *   - `ruleKey` (`<section-slug>/<lead-slug>`) — STABLE across wording tweaks;
 *     the rotation + report group by it.
 *   - `contentHash` (sha256/12 of the normalized text) — evidence for a rule
 *     only accumulates while its wording holds; a reworded rule starts over.
 *
 * Everything here is pure (string → values) so it unit-tests against both a
 * synthetic fixture and the real playbook with zero IO beyond the caller's
 * body load. Ablation NEVER touches the source file — it returns a new string
 * the runner feeds the target as a ScenarioVariant (shadow-only by
 * construction).
 */

import { createHash } from 'node:crypto';

export interface AblatableRule {
  /** `<section-slug>/<lead-slug>` — stable rotation + report identity. */
  ruleKey: string;
  /** The `##` section heading the rule lives under. */
  sectionHeading: string;
  /** The bold lead text (the rule's human-readable name). */
  lead: string;
  /** The full unit text (exact body lines, joined). */
  text: string;
  /** 0-based inclusive line span in the body this unit occupies. */
  startLine: number;
  endLine: number;
  /** sha256 hex (12) of the whitespace-normalized text. */
  contentHash: string;
}

/** Whitespace-normalize for hashing: collapse runs, trim. */
export function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function hashRuleText(text: string): string {
  return createHash('sha256').update(normalizeRuleText(text)).digest('hex').slice(0, 12);
}

/** Body-level hash — run rows pin the playbook snapshot they measured. */
export function hashPlaybookBody(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function slugify(text: string, maxLen = 48): string {
  const slug = text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
  return slug || 'rule';
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BOLD_BULLET_RE = /^- \*\*(.+?)\*\*/;
const BOLD_PARA_RE = /^\*\*(.+?)\*\*/;
/** A line that CONTINUES a bullet unit: indented content (incl. nested bullets). */
const INDENTED_RE = /^\s+\S/;

/** Units shorter than this (normalized chars) are fragments, not rules. */
const MIN_RULE_CHARS = 60;

/**
 * Segment a playbook body into ablatable rule units. Deterministic: same body
 * ⇒ same units in file order with the same keys/hashes.
 */
export function extractAblatableRules(body: string): AblatableRule[] {
  const lines = body.split('\n');
  const rules: AblatableRule[] = [];
  const keyCounts = new Map<string, number>();
  let sectionHeading = '';
  let sectionSlug = '';
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = HEADING_RE.exec(line);
    if (heading && heading[1]!.length === 2) {
      sectionHeading = heading[2]!.trim();
      sectionSlug = slugify(sectionHeading, 40);
      continue;
    }
    if (!sectionSlug) continue; // preamble before the first ## section

    const bullet = BOLD_BULLET_RE.exec(line);
    const para = bullet ? null : BOLD_PARA_RE.exec(line);
    if (!bullet && !para) continue;

    // Extent: bullets swallow their indented continuations; paragraphs swallow
    // contiguous non-blank, non-new-unit lines. Fenced blocks inside the unit
    // (a rule's example snippet) ride along.
    let end = i;
    let fenceDepth = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (/^\s*```/.test(next)) {
        fenceDepth = fenceDepth === 0 ? 1 : 0;
        end = j;
        continue;
      }
      if (fenceDepth > 0) {
        end = j;
        continue;
      }
      if (bullet) {
        if (INDENTED_RE.test(next)) {
          end = j;
          continue;
        }
        break; // blank line, new top-level token, or heading — bullet over
      }
      // paragraph: contiguous non-blank lines that don't start a new unit/heading
      if (!next.trim()) break;
      if (HEADING_RE.test(next) || BOLD_BULLET_RE.test(next) || /^- /.test(next)) break;
      end = j;
    }

    const text = lines.slice(i, end + 1).join('\n');
    if (normalizeRuleText(text).length < MIN_RULE_CHARS) {
      i = end;
      continue;
    }

    const lead = (bullet?.[1] ?? para![1]!).trim();
    const baseKey = `${sectionSlug}/${slugify(lead)}`;
    const n = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, n);
    rules.push({
      ruleKey: n === 1 ? baseKey : `${baseKey}-${n}`,
      sectionHeading,
      lead,
      text,
      startLine: i,
      endLine: end,
      contentHash: hashRuleText(text),
    });
    i = end;
  }
  return rules;
}

/**
 * Produce the body with one rule removed (plus the blank line the removal
 * orphans, so the ablated prompt reads clean). Throws when the body has
 * drifted from the extraction snapshot — extraction and ablation must operate
 * on the SAME string within one cycle.
 */
export function ablateRule(body: string, rule: AblatableRule): string {
  const lines = body.split('\n');
  const span = lines.slice(rule.startLine, rule.endLine + 1).join('\n');
  if (hashRuleText(span) !== rule.contentHash) {
    throw new Error(
      `ablateRule: body drifted — lines ${rule.startLine}..${rule.endLine} no longer hash to ` +
        `${rule.contentHash} for rule '${rule.ruleKey}' (extract + ablate must share one snapshot)`,
    );
  }
  let removeEnd = rule.endLine;
  if (removeEnd + 1 < lines.length && lines[removeEnd + 1]!.trim() === '') removeEnd++;
  const ablated = [...lines.slice(0, rule.startLine), ...lines.slice(removeEnd + 1)].join('\n');
  if (ablated.includes(normalizeRuleText(rule.text)) || ablated.length >= body.length) {
    throw new Error(`ablateRule: removal of '${rule.ruleKey}' did not shrink the body`);
  }
  return ablated;
}
