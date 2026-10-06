/** Cost observations belong to an exact operation, cursor and document revision. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LspFacadeArgs } from './lsp-facade.ts';

export async function lspDaemonCostKey(op: string, args: LspFacadeArgs): Promise<string | undefined> {
  // No document revision means no evidence that an earlier symbol cost applies.
  if (!args.file) return undefined;
  try {
    const revision = createHash('sha256').update(await readFile(args.file)).digest('hex');
    return createHash('sha256').update(JSON.stringify({ op, args, revision })).digest('hex');
  } catch {
    return undefined;
  }
}
