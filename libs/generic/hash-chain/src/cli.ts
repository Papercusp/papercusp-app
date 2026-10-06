/**
 * Third-party verifier: `npx tsx libs/generic/hash-chain/src/verify-main.ts verify
 * <export.jsonl> [--head-seq N --head-hash H]`. This module is side-effect free
 * (importable and bundle-safe); `verify-main.ts` is the entry-only file that runs it.
 *
 * Prints the verdict as one JSON line and exits 0 when the chain is intact, 1
 * when it is broken (the verdict names the first break), 2 on a usage error.
 * `--head-seq/--head-hash` pin the head you obtained independently (an anchor),
 * which is what exposes a consistently truncated export.
 */
import { readFileSync } from 'node:fs';
import { verifyChainExport } from './export';
import type { ChainHead } from './chain';

export interface CliIo {
  readonly readFile: (path: string) => string;
  readonly out: (line: string) => void;
}

const USAGE = 'usage: verify <export.jsonl> [--head-seq N --head-hash H]';

export function runVerifyCli(argv: readonly string[], io: CliIo): number {
  const [command, file, ...rest] = argv;
  if (command !== 'verify' || !file) {
    io.out(JSON.stringify({ ok: false, error: USAGE }));
    return 2;
  }
  let headSeq: string | undefined;
  let headHash: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) {
      io.out(JSON.stringify({ ok: false, error: `${flag} needs a value; ${USAGE}` }));
      return 2;
    }
    if (flag === '--head-seq') headSeq = value;
    else if (flag === '--head-hash') headHash = value;
    else {
      io.out(JSON.stringify({ ok: false, error: `unknown flag ${flag}; ${USAGE}` }));
      return 2;
    }
  }
  if ((headSeq === undefined) !== (headHash === undefined)) {
    io.out(JSON.stringify({ ok: false, error: `--head-seq and --head-hash go together; ${USAGE}` }));
    return 2;
  }
  let expectedHead: ChainHead | undefined;
  if (headSeq !== undefined && headHash !== undefined) {
    const seq = Number(headSeq);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      io.out(JSON.stringify({ ok: false, error: `--head-seq must be a non-negative integer; ${USAGE}` }));
      return 2;
    }
    expectedHead = { seq, entryHash: headHash };
  }
  let text: string;
  try {
    text = io.readFile(file);
  } catch (error) {
    io.out(JSON.stringify({ ok: false, error: `cannot read ${file}: ${(error as Error).message}` }));
    return 2;
  }
  const verdict = verifyChainExport(text, expectedHead ? { expectedHead } : {});
  io.out(JSON.stringify(verdict));
  return verdict.ok ? 0 : 1;
}

/** The real-process wiring, used by the entry-only `verify-main.ts`. */
export const nodeCliIo: CliIo = {
  readFile: (path) => readFileSync(path, 'utf8'),
  out: (line) => process.stdout.write(`${line}\n`),
};
