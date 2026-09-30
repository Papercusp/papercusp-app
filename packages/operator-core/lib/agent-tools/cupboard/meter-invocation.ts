/**
 * cupboard:meter-invocation — the interception point every per-use Cupboard item
 * passes through (shared-pot-dao-cupboard-v1-2026-09-04 P-031, requirement 5).
 *
 * A per-use item is billed PER UNIT SERVED, so there is no single purchase to
 * authorize: `cupboard:checkout` returns a microcharge preflight and a funded
 * channel, and then every billable unit reserves against that channel BEFORE it
 * executes and settles the units actually served AFTER it. This tool is that
 * pair, plus the read the two parties reconcile against.
 *
 * Reserving first is the whole design: a unit that would exhaust the escrow,
 * replay a nonce, or regress the cumulative claim is refused while refusing is
 * still free, rather than discovered once the seller has already paid to serve
 * it. The refusals themselves are `p2p/metered-invocation.ts` (pure), evaluated
 * locally here and again by the hosted door against state a client cannot forge.
 *
 * Signing stays behind the hive keychain seam (`signWithHiveKey`) rather than
 * crossing the tool boundary: an agent names the unit, it never handles a key.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const data = (payload: Record<string, unknown>) => ({ data: payload });

/** A unit that has not been reserved within five minutes is a stale quote. */
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;

const args = z
  .object({
    op: z
      .enum(['reserve', 'settle', 'usage'])
      .describe('reserve before executing a billable unit; settle after it; usage to read the channel ledger.'),
    channelId: z.string().min(1).max(200).describe('The microcharge channel from the checkout preflight.'),
    workspaceId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Workspace owning the signing hive key. Required for reserve and settle.'),
    hiveSlug: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Hive whose key signs the voucher (payer) or the receipt (seller). Required for reserve and settle.'),
    offerId: z.string().min(1).max(200).optional().describe('reserve: the per-use offer being metered.'),
    payer: z.string().min(1).max(200).optional().describe('reserve: the principal that funded the channel.'),
    seller: z.string().min(1).max(200).optional().describe('reserve: the principal serving the unit.'),
    releaseRef: z.string().min(1).max(300).optional().describe('reserve: the release the unit is served from.'),
    usageNonce: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Unique per channel. Required for reserve and settle; a repeat is refused, never re-billed.'),
    quantity: z.number().int().positive().optional().describe('reserve: units this invocation may consume.'),
    expiresAtMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('reserve: epoch ms the voucher stops being reservable. Defaults to five minutes out.'),
    unitPriceMicros: z.number().int().positive().optional().describe('reserve: published price per unit, in micros.'),
    meterUnit: z.string().min(1).max(200).optional().describe('reserve: the published unit the price is per.'),
    priceVersion: z.string().min(1).max(200).optional().describe('reserve: the published price version.'),
    splitManifestHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/i)
      .optional()
      .describe('reserve: sha256:<64 hex> of the revenue-split manifest these terms pay out under.'),
    actualQuantity: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('settle: units ACTUALLY served. Defaults to the reserved quantity; never more.'),
  })
  .superRefine((value, ctx) => {
    const need = (field: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for op='${value.op}'` });
    if (value.op === 'reserve' || value.op === 'settle') {
      if (!value.usageNonce) need('usageNonce');
      if (!value.workspaceId) need('workspaceId');
      if (!value.hiveSlug) need('hiveSlug');
    }
    if (value.op === 'reserve') {
      for (const field of [
        'offerId',
        'payer',
        'seller',
        'releaseRef',
        'quantity',
        'unitPriceMicros',
        'meterUnit',
        'priceVersion',
        'splitManifestHash',
      ] as const) {
        if (value[field] === undefined) need(field);
      }
    }
  });

export default defineTool({
  name: 'cupboard:meter-invocation',
  capability: 'harness:write',
  description:
    'Meter one billable unit of a per-use Cupboard item against a funded microcharge channel. op=reserve BEFORE executing the unit (refuses a duplicate nonce, an exhausted escrow cap, a regressed cumulative claim, or terms that do not match the published offer), op=settle AFTER it with the units actually served, op=usage to read the channel ledger. Refuses locally before any network call.',
  guidance: {
    when: 'Serving or paying for a unit of a per-use Cupboard offer, after cupboard:checkout returned a microcharge preflight and the channel was funded.',
    notWhen:
      'A one-time or subscription offer (cupboard:checkout alone settles those). Funding the channel itself. Reading what an org bought (cupboard:commerce-dashboards).',
    chaining:
      'reserve → execute the unit → settle with actualQuantity. Reserve FIRST: settling a nonce that was never reserved is refused rather than billed, and a unit executed before reserving may turn out to be uncoverable. Reuse the SAME usageNonce across the pair; a fresh one on retry double-bills.',
    seeAlso: ['cupboard:checkout', 'cupboard:commerce-dashboards'],
  },
  args,
  async handler(input) {
    const { reserveMeteredUnit, settleMeteredUnit, readChannelUsage } = await import(
      '../../cupboard/metered-invocation-door-io'
    );

    if (input.op === 'usage') {
      const read = await readChannelUsage(input.channelId);
      if (read.ok !== true) {
        return data({ ok: false, error: read.code, detail: read.detail, status: read.status, refusedBy: read.refusedBy });
      }
      return data({ ok: true, ...read.usage });
    }

    const { signWithHiveKey } = await import('../../identity/hive-keypair');
    const workspaceId = input.workspaceId as string;
    const hiveSlug = input.hiveSlug as string;
    const sign = async (bytes: Buffer) => (await signWithHiveKey(workspaceId, hiveSlug, bytes)).toString('base64');

    if (input.op === 'reserve') {
      const outcome = await reserveMeteredUnit({
        channelId: input.channelId,
        offerId: input.offerId as string,
        terms: {
          unitPriceMicros: input.unitPriceMicros as number,
          meterUnit: input.meterUnit as string,
          priceVersion: input.priceVersion as string,
          splitManifestHash: input.splitManifestHash as string,
        },
        payer: input.payer as string,
        seller: input.seller as string,
        releaseRef: input.releaseRef as string,
        usageNonce: input.usageNonce as string,
        quantity: BigInt(input.quantity as number),
        expiresAtMs: input.expiresAtMs ?? Date.now() + DEFAULT_EXPIRY_MS,
        signVoucher: sign,
      });
      if (outcome.ok !== true) {
        return data({
          ok: false,
          error: outcome.code,
          detail: outcome.detail,
          status: outcome.status,
          refusedBy: outcome.refusedBy,
        });
      }
      return data({
        ok: true,
        reserved: true,
        usageNonce: outcome.voucher.usageNonce,
        reservedMicros: String(outcome.reservedMicros),
        cumulativeClaimMicros: String(outcome.voucher.cumulativeClaimMicros),
        meterUnit: outcome.meter.meterUnit,
        receipt: outcome.receipt,
        note: 'The unit is now covered. Execute it, then call op=settle with the SAME usageNonce and the units actually served.',
      });
    }

    const outcome = await settleMeteredUnit({
      channelId: input.channelId,
      usageNonce: input.usageNonce as string,
      ...(input.actualQuantity !== undefined ? { actualQuantity: BigInt(input.actualQuantity) } : {}),
      signReceipt: sign,
    });
    if (outcome.ok !== true) {
      return data({
        ok: false,
        error: outcome.code,
        detail: outcome.detail,
        status: outcome.status,
        refusedBy: outcome.refusedBy,
      });
    }
    return data({
      ok: true,
      settled: true,
      amountMicros: String(outcome.amountMicros),
      receipt: outcome.receipt,
    });
  },
});
