/**
 * The open-source payment-receipt verifier's logic (agent-economy-flywheel-2026-08-30
 * P-046, D-029). `scripts/verify-payment-receipt.mts` is a thin wrapper over
 * `runPaymentReceiptVerifier`, which needs only the receipt and a public RPC.
 * Like payment-receipt.ts, this module imports no Postgres code.
 *
 * Exit codes: 0 verified · 1 not verified (reason printed) · 2 usage or unreadable input.
 */
import { http } from 'viem';
import { ANCHOR_CHAINS, easAnchorReader } from './ledger-anchor-eas';
import { verifyPaymentReceipt, type PaymentReceipt } from './payment-receipt';

export const PAYMENT_RECEIPT_VERIFIER_USAGE =
  'usage: verify-payment-receipt <receipt.json | -> [--rpc <url>] [--attester <0x…40 hex>] [--log-id <id>]';

export interface ReceiptVerifierIo {
  /** Read the receipt file; `-` means stdin. */
  readonly readFile: (file: string) => string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface ParsedArgs {
  readonly file: string;
  readonly rpc?: string;
  readonly attester?: string;
  readonly logId?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { readonly help: true } | { readonly error: string } {
  let file: string | undefined;
  let rpc: string | undefined;
  let attester: string | undefined;
  let logId: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--rpc' || a === '--attester' || a === '--log-id') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${a} needs a value` };
      i += 1;
      if (a === '--rpc') rpc = value;
      else if (a === '--attester') attester = value;
      else logId = value;
    } else if (a.startsWith('--')) return { error: `unknown option: ${a}` };
    else if (file === undefined) file = a;
    else return { error: `unexpected argument: ${a}` };
  }
  if (file === undefined) return { error: 'missing receipt file' };
  if (attester !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(attester)) {
    return { error: '--attester must be a 0x-prefixed 20-byte address' };
  }
  return { file, ...(rpc ? { rpc } : {}), ...(attester ? { attester } : {}), ...(logId ? { logId } : {}) };
}

/**
 * Checks, in order: the commitment is SHA-256 over the salt and the five
 * transaction fields; the bundle's chain entry is that commitment; the chain
 * link sits in the anchored Merkle root; the root is attested on-chain (EAS),
 * unrevoked, by `--attester` when given.
 */
export async function runPaymentReceiptVerifier(argv: readonly string[], io: ReceiptVerifierIo): Promise<0 | 1 | 2> {
  const parsed = parseArgs(argv);
  if ('help' in parsed) {
    io.stdout(`${PAYMENT_RECEIPT_VERIFIER_USAGE}\n`);
    return 0;
  }
  if ('error' in parsed) {
    io.stderr(`${parsed.error}\n${PAYMENT_RECEIPT_VERIFIER_USAGE}\n`);
    return 2;
  }

  let receipt: PaymentReceipt;
  try {
    receipt = JSON.parse(io.readFile(parsed.file)) as PaymentReceipt;
  } catch (err) {
    io.stderr(`cannot read receipt: ${(err as Error).message}\n`);
    return 2;
  }

  const anchor = receipt?.bundle?.anchor;
  const chainId = anchor?.chainId;
  const spec = typeof chainId === 'number' ? ANCHOR_CHAINS[chainId] : undefined;
  if (anchor?.backend !== 'eas' || !spec) {
    io.stderr(`unsupported anchor: backend ${String(anchor?.backend)} on chain ${String(chainId)}\n`);
    return 2;
  }
  const rpcUrl = parsed.rpc ?? spec.chain.rpcUrls.default.http[0]!;
  const reader = easAnchorReader({ chain: spec.chain, transport: http(rpcUrl) });
  const verdict = await verifyPaymentReceipt(receipt, reader, {
    ...(parsed.attester ? { expectedAttester: parsed.attester } : {}),
    ...(parsed.logId ? { expectedLogId: parsed.logId } : {}),
  });
  const report = verdict.ok
    ? { ...verdict, existedBy: new Date(verdict.anchoredWindowEnd * 1000).toISOString(), chainId, rpcUrl }
    : { ...verdict, chainId, rpcUrl };
  io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  return verdict.ok ? 0 : 1;
}
