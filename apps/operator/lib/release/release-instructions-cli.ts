#!/usr/bin/env npx tsx
/**
 * Render the release page's Instructions to `<out>/instructions.html`.
 *
 *   npx tsx apps/operator/lib/release/release-instructions-cli.ts --out <dir>
 *
 * [owner 2026-09-28, #868] "the instructions should come seperate from the release
 * cut". This is the ONLY writer of instructions.html. record-release-cli (which
 * runs from the release's own checkout) never writes it, so a release can no longer
 * roll the instructions back the way the 0.0.24 publish did (EI-24562046738478155).
 * bin/publish-release-instructions.sh calls this, gates the result, and uploads it.
 *
 * It renders from THIS checkout's release-instructions.ts — run it from the tree
 * the instructions were edited in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { OWNER_NAME_ENV, hasOwnerNameLiteral, identityLiterals, type IdentityLiteral } from './release-content-scrub';
import { describeOwnerIdentityLoad, loadOwnerIdentityEnv } from './owner-identity-env';
import { INSTRUCTIONS_PAGE_PATH, renderInstructionsHtml } from './release-history-page';

/**
 * Write instructions.html into `outDir` and return its path.
 *
 * Fails closed when no owner-name literal resolved, for the same reason the site
 * generator does: the scrub would redact nothing and still emit a complete-looking
 * page.
 */
export function writeInstructionsPage(
  outDir: string,
  opts: { generatedAt?: Date; redact?: IdentityLiteral[] } = {},
): string {
  const redact = opts.redact ?? identityLiterals();
  if (!hasOwnerNameLiteral(redact)) {
    throw new Error(
      "REFUSING TO RENDER — no owner-name literal resolved, so the owner's name cannot be " +
        `redacted from instructions.html. Set ${OWNER_NAME_ENV} (or ~/.papercusp/release-identity.env).`,
    );
  }
  const html = renderInstructionsHtml({ generatedAt: opts.generatedAt ?? new Date(), redact });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, INSTRUCTIONS_PAGE_PATH);
  fs.writeFileSync(file, html);
  return file;
}

function main(argv: string[]): number {
  const at = argv.indexOf('--out');
  const outDir = at >= 0 ? argv[at + 1] : undefined;
  if (!outDir || outDir.startsWith('--')) {
    console.error('usage: release-instructions-cli --out <dir>');
    return 2;
  }
  const file = writeInstructionsPage(path.resolve(outDir));
  console.log(`[release-instructions] wrote ${file}`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  console.error(describeOwnerIdentityLoad(loadOwnerIdentityEnv()));
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error('[release-instructions] FATAL:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
