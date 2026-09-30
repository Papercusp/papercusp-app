// apps/operator/app/_lints/title-only-tooltip-pattern.mjs
//
// The one definition of the title-only button tooltip matcher used by both the
// design-primitives gate and the edit-time PostToolUse nudge. Keeping the pattern
// here prevents the author-time warning from drifting away from the gate's rule.

import { stripCssComments } from './letter-spacing-pattern.mjs';

/** A fresh regex each call; global regexes carry lastIndex between uses. */
export function buttonTitleTooltipRe() {
  return /<button\b(?:=>|[^>])*\btitle=/gm;
}

/** Blank whole-line JavaScript/TypeScript comments while preserving line numbers. */
function stripLineComments(src) {
  return src.replace(/(^|\n)([ \t]*)(\/\/[^\r\n]*)/g, (match, prefix, indent, comment) => {
    const blank = comment.replace(/[^\r\n]/g, ' ');
    return `${prefix}${indent}${blank}`;
  });
}

/** Every title-only button tooltip in rawText, with source line and match text. */
export function findButtonTitleTooltips(rawText) {
  const code = stripLineComments(stripCssComments(rawText));
  const found = [];
  for (const match of code.matchAll(buttonTitleTooltipRe())) {
    const index = match.index ?? 0;
    found.push({
      line: code.slice(0, index).split('\n').length,
      snippet: match[0].trim(),
      // Attribute edits should not look like a newly introduced violation. The
      // gate cares about the count of title-bearing buttons, not their exact tag.
      key: 'button-title-tooltip',
    });
  }
  return found;
}
