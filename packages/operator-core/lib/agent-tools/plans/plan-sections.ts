export interface PlanMarkdownSection {
  heading: string;
  level: number;
  chars: number;
  body: string;
}

/**
 * Split markdown into level-1/2 plan sections while ignoring headings inside
 * fenced code. This is shared by plans:get and activation-audit target checks,
 * so a `section:<heading>` mapping means exactly what a heading read means.
 */
export function splitPlanSections(md: string): PlanMarkdownSection[] {
  const lines = md.split('\n');
  const out: PlanMarkdownSection[] = [];
  let cur: PlanMarkdownSection | null = null;
  let buf: string[] = [];
  let inFence = false;
  const flush = () => {
    if (!cur) return;
    cur.body = buf.join('\n').trim();
    cur.chars = cur.body.length;
    out.push(cur);
  };
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      if (cur) buf.push(line);
      continue;
    }
    const match = !inFence ? /^(#{1,2})\s+(.*)$/.exec(line) : null;
    if (match) {
      flush();
      buf = [];
      cur = {
        heading: (match[2] ?? '').trim(),
        level: (match[1] ?? '').length,
        chars: 0,
        body: '',
      };
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}
