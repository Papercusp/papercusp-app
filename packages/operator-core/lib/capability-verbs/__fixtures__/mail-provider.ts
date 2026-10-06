/**
 * Test fixture: a registered `gmail` provider for the `mail:*` verb tests.
 *
 * Since P-008 the verbs hold no Gmail code; they select the source's registered
 * provider and invoke `mail.draft` / `mail.send` on it. These tests are about
 * the HOST's rails (addressee, disclosure, deliverability, recipient match,
 * account routing), so the provider is a recorder: every invoke is captured in
 * `calls`, and `respond` scripts what the provider returns. The real Gmail
 * plugin's MIME and HTTP behaviour is tested beside the plugin itself.
 */
import type { HostFetch, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createProviderRegistry } from '../../integrations/provider-registry';
import type { MailDeps } from '../mail';

export interface MailProviderCall {
  /** The data_sources row id the host bound this call to. */
  source: string;
  capability: string;
  args: Record<string, unknown>;
}

export type MailProviderResponder = (call: MailProviderCall) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** What a cooperative Gmail provider answers, per capability and operation. */
export const DEFAULT_MAIL_RESPONSES: MailProviderResponder = ({ capability, args }) => {
  if (capability === 'mail.draft' && args.operation === 'read') {
    return { draftId: args.draftId, to: [], cc: [], subject: null };
  }
  if (capability === 'mail.draft') {
    return { draftId: String(args.draftId ?? 'draft-1'), messageId: 'message-1', threadId: String(args.threadId ?? 'thread-1') };
  }
  return { messageId: 'message-1', threadId: String(args.threadId ?? 'thread-1') };
};

export async function mailProviderFixture(
  respond: MailProviderResponder = DEFAULT_MAIL_RESPONSES,
  options: { capabilities?: readonly string[] } = {},
): Promise<{ deps: MailDeps; calls: MailProviderCall[] }> {
  const calls: MailProviderCall[] = [];
  const descriptor: ProviderDescriptor = {
    id: 'gmail',
    contractVersion: 1,
    datatypes: ['email-message'],
    capabilities: [...(options.capabilities ?? ['mail.draft', 'mail.send'])],
    egressHosts: ['gmail.googleapis.com'],
  };
  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }),
    invoke: async (request) => {
      const call = { source: request.source, capability: request.capability, args: request.args };
      calls.push(call);
      return respond(call);
    },
  };
  const registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'gmail' });
  const noHttp: HostFetch = async () => {
    throw new Error('mail provider fixture performs no HTTP');
  };
  return { deps: { registry, hostFetchFor: () => noHttp }, calls };
}
