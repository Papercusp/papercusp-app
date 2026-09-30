/**
 * Judge the executable claims in the Slack external-trigger setup runbook.
 *
 * The route contract is intentionally supplied by the caller rather than copied
 * into this module. The live claim test imports the actual route definitions, so
 * a future auth-tier change cannot hide behind a second, stale route parser.
 */

export const SLACK_SETUP_TRUST = ['verified', 'trusted'] as const;
export const SUPERUSER_CURL_HEADER = '-H "Authorization: Bearer $(cat ~/.papercusp/superuser-token)"';

export const SLACK_SETUP_ROUTES = [
  '/admin/triggers/slack/manifest',
  '/admin/triggers/slack/connect',
] as const;

export interface SlackRouteTrust {
  path: string;
  trust: readonly string[];
}

export interface SlackSetupDocVerdict {
  ok: boolean;
  violations: string[];
  docTrust: string[];
  checkedSections: number[];
  checkedRoutes: string[];
}

function section(markdown: string, number: number): string | null {
  const heading = new RegExp(`^##\\s+${number}\\.\\s.*$`, 'm');
  const match = heading.exec(markdown);
  if (!match) return null;
  const start = match.index + match[0].length;
  const nextHeading = markdown.slice(start).search(/^##\s+/m);
  return markdown.slice(start, nextHeading < 0 ? markdown.length : start + nextHeading);
}

function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? '');
}

function quotedValues(raw: string): string[] {
  return [...raw.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
}

function equalValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Check that the runbook's auth claim and its two runnable setup examples agree
 * with the route definitions supplied by the live code.
 */
export function judgeSlackSetupDoc(
  markdown: string,
  routes: readonly SlackRouteTrust[],
): SlackSetupDocVerdict {
  if (markdown.trim().length < 200) {
    throw new Error('Refusing to judge a short/empty Slack setup runbook read');
  }

  const violations: string[] = [];
  const checkedSections: number[] = [];
  const checkedRoutes: string[] = [];
  const zero = section(markdown, 0);
  const trustMatch = zero?.match(/auth:\s*\{\s*trust:\s*\[([^\]]+)\]\s*\}/);
  const docTrust = trustMatch ? quotedValues(trustMatch[1] ?? '') : [];

  if (!zero) {
    violations.push('missing section 0, which explains the trusted-principal requirement');
  } else {
    checkedSections.push(0);
  }
  if (docTrust.length === 0) {
    violations.push("section 0 does not state the routes' auth.trust array");
  }

  for (const path of SLACK_SETUP_ROUTES) {
    const route = routes.find((candidate) => candidate.path === path);
    if (!route) {
      violations.push(`live route definition missing: ${path}`);
      continue;
    }
    checkedRoutes.push(path);
    if (!equalValues(route.trust, docTrust)) {
      violations.push(
        `${path} auth.trust ${JSON.stringify(route.trust)} does not match runbook ${JSON.stringify(docTrust)}`,
      );
    }
  }

  const setupSections: Array<[number, string]> = [
    [1, SLACK_SETUP_ROUTES[0]],
    [3, SLACK_SETUP_ROUTES[1]],
  ];
  for (const [number, path] of setupSections) {
    const body = section(markdown, number);
    if (!body) {
      violations.push(`missing section ${number} for ${path}`);
      continue;
    }
    checkedSections.push(number);
    const command = fencedBlocks(body).find((block) => block.includes(path) && /\bcurl\b/.test(block));
    if (!command) {
      violations.push(`section ${number} has no curl block for ${path}`);
    } else if (!command.includes(SUPERUSER_CURL_HEADER)) {
      violations.push(`section ${number} curl for ${path} is missing the superuser bearer header`);
    }
  }

  return { ok: violations.length === 0, violations, docTrust, checkedSections, checkedRoutes };
}
