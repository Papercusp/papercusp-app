/**
 * Test support: a minimal EAS chain served over local JSON-RPC, so the real viem
 * clients (anchor publish, public read-back, the receipt verifier) run end to
 * end with no network. Shared by ledger-anchor-eas.test.ts and
 * payment-receipt-cli.test.ts.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  recoverTransactionAddress,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import {
  ANCHOR_SCHEMA,
  ANCHOR_SCHEMA_UID,
  EAS_ABI,
  EAS_PREDEPLOY,
  SCHEMA_REGISTRY_ABI,
  SCHEMA_REGISTRY_PREDEPLOY,
} from './ledger-anchor-eas';

export interface StoredAttestation {
  uid: Hex;
  schema: Hex;
  time: bigint;
  revocationTime: bigint;
  attester: Address;
  data: Hex;
}

/** A minimal EAS chain: answers exactly the JSON-RPC a viem local-account write + read needs. */
export function mockEasChain() {
  const schemas = new Set<string>();
  const attestations = new Map<string, StoredAttestation>();
  const receipts = new Map<string, Record<string, unknown>>();
  const calls: { method: string; to?: string; fn?: string }[] = [];
  let block = 100n;

  const handle = async (method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(baseSepolia.id);
      case 'eth_blockNumber':
        return numberToHex(block);
      case 'eth_getBlockByNumber':
        return {
          number: numberToHex(block),
          hash: keccak256(numberToHex(block)),
          parentHash: zeroHash,
          timestamp: numberToHex(1_790_000_000n),
          baseFeePerGas: '0x1',
          gasLimit: '0x1c9c380',
          gasUsed: '0x0',
          transactions: [],
        };
      case 'eth_maxPriorityFeePerGas':
      case 'eth_gasPrice':
        return '0x1';
      case 'eth_getTransactionCount':
        return numberToHex(receipts.size);
      case 'eth_estimateGas':
        return '0x40000';
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        if (to.toLowerCase() === SCHEMA_REGISTRY_PREDEPLOY.toLowerCase()) {
          const { args } = decodeFunctionData({ abi: SCHEMA_REGISTRY_ABI, data });
          calls.push({ method, to, fn: 'getSchema' });
          const uid = args[0] as Hex;
          const known = schemas.has(uid.toLowerCase());
          return encodeFunctionResult({
            abi: SCHEMA_REGISTRY_ABI,
            functionName: 'getSchema',
            result: { uid: known ? uid : zeroHash, resolver: zeroAddress, revocable: false, schema: known ? ANCHOR_SCHEMA : '' },
          });
        }
        const { args } = decodeFunctionData({ abi: EAS_ABI, data });
        calls.push({ method, to, fn: 'getAttestation' });
        const a = attestations.get((args[0] as Hex).toLowerCase());
        return encodeFunctionResult({
          abi: EAS_ABI,
          functionName: 'getAttestation',
          result: {
            uid: a?.uid ?? zeroHash,
            schema: a?.schema ?? zeroHash,
            time: a?.time ?? 0n,
            expirationTime: 0n,
            revocationTime: a?.revocationTime ?? 0n,
            refUID: zeroHash,
            recipient: zeroAddress,
            attester: a?.attester ?? zeroAddress,
            revocable: false,
            data: a?.data ?? '0x',
          },
        });
      }
      case 'eth_sendRawTransaction': {
        const raw = params[0] as Hex;
        const hash = keccak256(raw);
        const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
        const { parseTransaction } = await import('viem');
        const tx = parseTransaction(raw as never);
        const logs: Record<string, unknown>[] = [];
        block += 1n;
        if (tx.to?.toLowerCase() === SCHEMA_REGISTRY_PREDEPLOY.toLowerCase()) {
          calls.push({ method, to: tx.to, fn: 'register' });
          schemas.add(ANCHOR_SCHEMA_UID.toLowerCase());
        } else {
          const { args } = decodeFunctionData({ abi: EAS_ABI, data: tx.data! });
          calls.push({ method, to: tx.to!, fn: 'attest' });
          const req = args[0] as { schema: Hex; data: { data: Hex } };
          if (!schemas.has(req.schema.toLowerCase())) throw new Error('InvalidSchema');
          const uid = keccak256(concatHex([hash, req.schema]));
          attestations.set(uid, { uid, schema: req.schema, time: 1_790_000_100n, revocationTime: 0n, attester: from, data: req.data.data });
          logs.push({
            address: EAS_PREDEPLOY,
            topics: encodeEventTopics({ abi: EAS_ABI, eventName: 'Attested', args: { recipient: zeroAddress, attester: from, schemaUID: req.schema } }),
            data: encodeAbiParameters([{ type: 'bytes32' }], [uid]),
            blockNumber: numberToHex(block),
            blockHash: keccak256(numberToHex(block)),
            transactionHash: hash,
            transactionIndex: '0x0',
            logIndex: '0x0',
            removed: false,
          });
        }
        receipts.set(hash, {
          transactionHash: hash,
          transactionIndex: '0x0',
          blockHash: keccak256(numberToHex(block)),
          blockNumber: numberToHex(block),
          from,
          to: tx.to,
          cumulativeGasUsed: '0x5208',
          gasUsed: '0x5208',
          effectiveGasPrice: '0x1',
          contractAddress: null,
          logs,
          logsBloom: `0x${'0'.repeat(512)}`,
          status: '0x1',
          type: '0x2',
        });
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return receipts.get(params[0] as string) ?? null;
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  };

  let server: Server | null = null;
  return {
    schemas,
    attestations,
    calls,
    async listen(): Promise<string> {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const msg = JSON.parse(body) as { id: number; method: string; params: unknown[] };
          handle(msg.method, msg.params ?? []).then(
            (result) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })),
            (err: Error) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } })),
          );
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/rpc`;
    },
    async close(): Promise<void> {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    },
  };
}
