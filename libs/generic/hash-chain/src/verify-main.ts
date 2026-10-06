/**
 * Entry-only file — run it, never import it:
 *   npx tsx libs/generic/hash-chain/src/verify-main.ts verify <export.jsonl> [--head-seq N --head-hash H]
 * Exit 0 = intact, 1 = broken (the JSON verdict names the first break), 2 = usage.
 */
import { nodeCliIo, runVerifyCli } from './cli';

process.exitCode = runVerifyCli(process.argv.slice(2), nodeCliIo);
