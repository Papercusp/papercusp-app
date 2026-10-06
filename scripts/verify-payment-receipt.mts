#!/usr/bin/env -S npx tsx
/**
 * Open-source payment-receipt verifier (agent-economy-flywheel-2026-08-30
 * P-046, D-029). Needs only the receipt file and a public RPC for the chain the
 * receipt's anchor lives on. It imports no Postgres code and talks to no
 * Papercusp server.
 *
 *   npx tsx scripts/verify-payment-receipt.mts <receipt.json | -> [--rpc <url>] [--attester <0x…>] [--log-id <id>]
 *
 * Exit: 0 verified · 1 not verified (reason printed) · 2 usage or unreadable input.
 * The logic (and its tests) live in packages/operator-core/lib/cupboard/payment-receipt-cli.ts.
 */
import { readFileSync } from 'node:fs';
import { defaultEvidenceRoot, runHarness } from '@papercusp/verification-harness';
import { runPaymentReceiptVerifier } from '../packages/operator-core/lib/cupboard/payment-receipt-cli.ts';

let code = 2;
await runHarness({
  contract: { name: 'payment-receipt', phases: [{ id: 'verify' }] },
  evidenceRoot: defaultEvidenceRoot('payment-receipt'),
  async runPhase(ctx) {
    ctx.markStep('verify-receipt');
    code = await runPaymentReceiptVerifier(process.argv.slice(2), {
      readFile: (file) => readFileSync(file === '-' ? 0 : file, 'utf8'),
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
    return code === 0
      ? { ok: true }
      : { ok: false, reasonCode: code === 1 ? 'receipt-not-verified' : 'usage-or-input-error' };
  },
});
process.exit(code);
