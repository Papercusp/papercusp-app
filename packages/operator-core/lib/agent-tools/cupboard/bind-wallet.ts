/**
 * cupboard:bind-wallet — signed-nonce EVM wallet binding (P-029).
 *
 * The tool never accepts a Papercusp principal id. The hosted Worker derives
 * that principal from the authenticated GitHub bearer, issues a short-lived
 * challenge, verifies the EIP-191 signature, and persists the resulting
 * principal↔wallet binding. A later verified challenge rotates the wallet;
 * `unbind` removes it explicitly.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const args = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('challenge'),
    walletAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .describe('EVM wallet that will sign the returned SIWE-style message.'),
    chainId: z.number().int().positive().safe().optional().describe('EVM chain id; defaults to 1.'),
  }).strict(),
  z.object({
    op: z.literal('verify'),
    challengeId: z.string().min(1).max(100).describe('Server-issued challenge id returned by op=challenge.'),
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]{130}$/)
      .describe('65-byte EIP-191 personal_sign signature over the exact returned message.'),
  }).strict(),
  z.object({ op: z.literal('status') }).strict(),
  z.object({ op: z.literal('unbind') }).strict(),
]);

const data = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:bind-wallet',
  capability: 'harness:write',
  description:
    'Bind, rotate, inspect, or unbind the authenticated Papercusp principal’s EVM wallet through a short-lived server-issued signed nonce. Use op=challenge, have that wallet personal_sign the exact message, then op=verify. A wallet address alone never identifies a principal; replayed or expired challenges are refused.',
  guidance: {
    when:
      'A Cupboard commerce or settlement flow needs a verified EVM wallet for the currently authenticated Papercusp principal.',
    notWhen:
      'Sending a transaction, proving treasury authority, or looking up who owns an arbitrary address. This tool only establishes the principal↔wallet binding.',
    chaining:
      'Call op=challenge with the wallet address, present message to that wallet for personal_sign, then call op=verify with the returned challengeId and signature. A second verified challenge rotates the binding. Use op=unbind to remove it.',
    seeAlso: ['cupboard:checkout', 'p2p:trace'],
  },
  args,
  async handler(input) {
    const {
      readWalletBinding,
      requestWalletBindingChallenge,
      submitWalletBinding,
      unbindWallet,
    } = await import('../../cupboard/wallet-binding-io');
    const result =
      input.op === 'challenge'
        ? await requestWalletBindingChallenge({
            walletAddress: input.walletAddress,
            ...(input.chainId !== undefined ? { chainId: input.chainId } : {}),
          })
        : input.op === 'verify'
          ? await submitWalletBinding({
              challengeId: input.challengeId,
              signature: input.signature,
            })
          : input.op === 'status'
            ? await readWalletBinding()
            : await unbindWallet();

    if (!result.ok) {
      return data({
        ok: false,
        error: result.error,
        detail: result.detail,
        status: result.status,
      });
    }
    return data({ ok: true, ...result.value });
  },
});
