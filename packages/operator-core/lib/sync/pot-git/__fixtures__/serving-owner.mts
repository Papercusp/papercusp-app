/** Native process boundary fixture for P514. Only the serving process constructs
 * authority; the publisher sends a request, never its own identity/generation. */
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { deriveSwarmTopic } from '../../hyperbee/derive-swarm-topic.ts';
import { issueGitServingCapability, type GitServingRequest } from '../serving-capability.ts';

const config = JSON.parse(process.env.P514_SERVING_FIXTURE!) as {
  socketPath: string; request: GitServingRequest; device: string;
};
let live = true;
let generation = `sg2-1-${'a'.repeat(40)}`;
const owner = { runtimeId: randomUUID(), workspaceId: config.request.workspaceId,
  potHomeSlug: config.request.potHomeSlug,
  topicHex: deriveSwarmTopic({ kind: 'hive', hive_pubkey: config.request.scope.hive_id }).toString('hex'),
  identity: { devicePubkeyBase64: config.device, githubUserId: 42, keychainId: 'test-publisher-key' } };
const sockets = new Set<import('node:net').Socket>();
const server = createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  createInterface({ input: socket }).on('line', async line => {
    const message = JSON.parse(line);
    let result: unknown;
    if (message.method === 'substrate:getStoreStatus') {
      result = { gitServing: await issueGitServingCapability(message.params.gitServingRequest, {
        current: () => live ? owner : null,
        resolveContext: async () => ({ ...config.request.scope, store_generation: generation }),
      }) };
    } else if (message.method === 'test:replaceStore') {
      generation = `sg2-2-${'b'.repeat(40)}`;
      result = { ok: true };
    } else if (message.method === 'substrate:closeStore') {
      live = false;
      result = { ok: true };
    } else {
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } }) + '\n');
      return;
    }
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
  });
});
server.listen(config.socketPath, () => process.send?.({ ready: true, pid: process.pid }));
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
