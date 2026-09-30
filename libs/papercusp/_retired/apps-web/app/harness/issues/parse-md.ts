import type { Issue } from './types';

// Best-effort parser: extract structured Issue rows from a narrative issues.md.
//
// Looks for these patterns inside each `## F-XXX — Validation round <N>` block:
//   - `### OUT-OF-SCOPE bugs surfaced …` (a numbered list follows)
//   - `### OUT-OF-SCOPE notes …`  (a numbered list follows)
//   - `### OUT-OF-SCOPE but worth filing:` (a bulleted list follows)
//   - `[FAIL]` entries under `### VAL-…` (these map to failing assertions)
//
// Produces stable-ish ids (I-0001, I-0002, …) keyed by content hash so re-running
// the parser on the same input doesn't produce duplicates in the UI.
//
// This is intentionally read-only / best-effort — once the validator prompt
// emits structured JSON directly, this parser becomes a one-shot migration.

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36).padStart(7, '0').slice(-7);
}

interface ParsedBlock {
  feature: string;
  round: string;
  ts: string;
  body: string;
}

function splitByFeatureBlocks(md: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const headerRe = /^## (F-[A-Z0-9-]+)\s+—\s+Validation round (\d+)\s+—\s+(\S+)\s*$/gm;
  const matches = [...md.matchAll(headerRe)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    blocks.push({
      feature: m[1],
      round: m[2],
      ts: m[3],
      body: md.slice(start, end).trim(),
    });
  }
  return blocks;
}

function extractOutOfScopeSections(body: string): string[] {
  const sections: string[] = [];
  const re = /###\s+OUT-OF-SCOPE[^\n]*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    sections.push(m[1].trim());
  }
  return sections;
}

function splitNumberedList(section: string): string[] {
  // Accept both "1. …", "2. …" at line starts and "- **…**" bullets.
  const items: string[] = [];
  const lines = section.split('\n');
  let current = '';
  for (const line of lines) {
    if (/^\d+\.\s+/.test(line) || /^\*\s+\*\*/.test(line) || /^-\s+\*\*/.test(line)) {
      if (current.trim()) items.push(current.trim());
      current = line.replace(/^\d+\.\s+|^[-*]\s+/, '');
    } else {
      current += '\n' + line;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function splitSimpleList(section: string): string[] {
  const items: string[] = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^[-*]\s+(.+)$/);
    if (m) items.push(m[1].trim());
  }
  return items;
}

function guessSeverity(text: string): Issue['severity'] {
  if (/\bcrash|panic|corrupt|data loss|security|inject|RCE|auth bypass/i.test(text)) return 'critical';
  if (/\bblock|break|broken|fail\b|5\d\d|500\b|hang|deadlock|preflight\b/i.test(text)) return 'major';
  if (/\bnit|typo|style|nitpick|cosmetic|wording/i.test(text)) return 'nit';
  return 'minor';
}

function extractCodePointer(text: string): string | undefined {
  const m = text.match(/([a-zA-Z0-9_./+-]+(?:\.[a-zA-Z0-9]+)?):(\d+)(?::\d+)?/);
  return m ? m[0] : undefined;
}

function extractTitle(text: string): string {
  // First bold phrase wins; otherwise first sentence.
  const bold = text.match(/\*\*(.+?)\*\*/);
  if (bold) return bold[1].trim().replace(/[.:]\s*$/, '');
  const firstLine = text.split('\n')[0].trim();
  const firstSentence = firstLine.split(/(?<=[.!?])\s/)[0];
  return (firstSentence || firstLine).slice(0, 140).trim();
}

function sectionToIssue(
  raw: string,
  feature: string,
  foundAt: string,
): Issue {
  const title = extractTitle(raw);
  const severity = guessSeverity(raw);
  const codePointer = extractCodePointer(raw);

  // Try to split repro / evidence / suggested fix heuristically.
  const reproM = raw.match(/Repro[s]?:\s*\n?((?:.+\n?)+?)(?=\n\n|\nObserved:|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
  const evidenceM = raw.match(/(?:Observed|Evidence):\s*\n?((?:.+\n?)+?)(?=\n\n|\nRoot cause:|\nImpact|\nSuggested|\nVerified|$)/i);
  const fixM = raw.match(/Suggested fix:\s*\n?((?:.+\n?)+?)(?=\n\n|\nFiled|$)/i);

  const id = `I-${shortHash(`${feature}|${title}|${codePointer ?? ''}`)}`;

  return {
    id,
    title,
    severity,
    source: 'validator',
    foundAt,
    foundDuring: feature,
    status: 'open',
    repro: reproM?.[1]?.trim(),
    evidence: evidenceM?.[1]?.trim() ?? raw.slice(0, 400),
    suggestedFix: fixM?.[1]?.trim(),
    codePointer,
    attempts: 0,
    notes: [],
  };
}

export function parseIssuesMd(md: string): Issue[] {
  if (!md || !md.trim()) return [];
  const out: Issue[] = [];
  const seen = new Set<string>();

  for (const block of splitByFeatureBlocks(md)) {
    for (const section of extractOutOfScopeSections(block.body)) {
      const items = splitNumberedList(section);
      const candidates = items.length > 0 ? items : splitSimpleList(section).map((s) => s);
      for (const raw of candidates) {
        if (raw.length < 10) continue;
        const issue = sectionToIssue(raw, block.feature, block.ts);
        if (seen.has(issue.id)) continue;
        seen.add(issue.id);
        out.push(issue);
      }
    }
  }
  return out;
}
