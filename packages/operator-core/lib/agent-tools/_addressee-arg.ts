/**
 * Shared `addressee` argument for the create-shaped capability verbs
 * (D-020 rail 2). Declared once so mail:send, chat:post, calendar:propose and
 * social:post cannot drift into four subtly different provenance vocabularies
 * — and so the prompt weight of explaining it is paid once per tool, not
 * re-derived.
 */
import { z } from 'zod';
import type { AddresseeProvenance } from '../capability-verbs/addressing';

export const addresseeArg = z
  .discriminatedUnion('from', [
    z.object({ from: z.literal('owner-instruction') }).strict(),
    z
      .object({ from: z.literal('contact'), contactExternalId: z.string().trim().min(1).max(256) })
      .strict(),
    z
      .object({
        from: z.literal('thread-participant'),
        source: z.string().trim().min(1).max(64),
        externalId: z.string().trim().min(1).max(512),
      })
      .strict(),
  ])
  .describe(
    'Where these addresses came from. "contact" (with a personal:search contact externalId) and "thread-participant" are VERIFIED server-side; "owner-instruction" means the owner named it directly and is accepted only if the address is not one that appears solely in message content.',
  );

export type AddresseeArg = z.infer<typeof addresseeArg>;

export function toProvenance(arg: AddresseeArg): AddresseeProvenance {
  return arg;
}
