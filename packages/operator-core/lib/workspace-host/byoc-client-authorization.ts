/** Customer-host custody for authorized desktop Noise public keys. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const BYOC_CLIENT_AUTHORIZATION_VERSION = 'byoc-client-authorization-v1';

export interface ByocClientAuthorizationScope {
  organizationId: string;
  workspaceId: string;
  hostId: string;
  clientId: string;
}

export interface ByocClientAuthorizationRecord extends ByocClientAuthorizationScope {
  version: typeof BYOC_CLIENT_AUTHORIZATION_VERSION;
  publicKeyBase64: string;
  generation: number;
  status: 'authorized' | 'revoked';
  updatedAt: string;
}

export interface ByocClientAuthorizationStore {
  read(scope: ByocClientAuthorizationScope): Promise<ByocClientAuthorizationRecord | null>;
  write(record: ByocClientAuthorizationRecord): Promise<void>;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;

export function assertByocClientAuthorizationScope(scope: ByocClientAuthorizationScope): void {
  for (const [name, value] of Object.entries(scope)) {
    if (typeof value !== 'string' || !SAFE_ID.test(value)) {
      throw new Error(`BYOC client authorization ${name} must be a canonical identifier`);
    }
  }
}

export function assertByocClientPublicKey(publicKeyBase64: string): void {
  const bytes = Buffer.from(publicKeyBase64, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== publicKeyBase64) {
    throw new Error('BYOC client public key must be canonical 32-byte base64');
  }
}

function scopeKey(scope: ByocClientAuthorizationScope): string {
  assertByocClientAuthorizationScope(scope);
  return [scope.organizationId, scope.workspaceId, scope.hostId, scope.clientId]
    .map((value) => encodeURIComponent(value))
    .join('__');
}

export function defaultByocClientAuthorizationDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const systemdState = env.STATE_DIRECTORY?.trim();
  if (systemdState?.startsWith('/')) return join(systemdState, 'byoc-client-authorizations');
  const configured = env.PAPERCUSP_BYOC_AUTHORIZATION_DIR?.trim();
  if (configured?.startsWith('/')) return configured;
  return join(homedir(), '.papercusp', 'workspace-host', 'byoc-client-authorizations');
}

export class FileByocClientAuthorizationStore implements ByocClientAuthorizationStore {
  constructor(private readonly directory = defaultByocClientAuthorizationDirectory()) {}

  private path(scope: ByocClientAuthorizationScope): string {
    return join(this.directory, `${scopeKey(scope)}.json`);
  }

  async read(scope: ByocClientAuthorizationScope): Promise<ByocClientAuthorizationRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path(scope), 'utf8')) as ByocClientAuthorizationRecord;
      assertByocClientAuthorizationScope(parsed);
      assertByocClientPublicKey(parsed.publicKeyBase64);
      if (
        parsed.version !== BYOC_CLIENT_AUTHORIZATION_VERSION ||
        !Number.isSafeInteger(parsed.generation) ||
        parsed.generation < 1 ||
        (parsed.status !== 'authorized' && parsed.status !== 'revoked')
      ) throw new Error('invalid BYOC client authorization record');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(record: ByocClientAuthorizationRecord): Promise<void> {
    assertByocClientAuthorizationScope(record);
    assertByocClientPublicKey(record.publicKeyBase64);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(record);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  }
}

export async function authorizeByocClientKey(
  store: ByocClientAuthorizationStore,
  scope: ByocClientAuthorizationScope,
  publicKeyBase64: string,
  now = new Date().toISOString(),
): Promise<ByocClientAuthorizationRecord> {
  assertByocClientAuthorizationScope(scope);
  assertByocClientPublicKey(publicKeyBase64);
  const prior = await store.read(scope);
  if (prior?.status === 'authorized' && prior.publicKeyBase64 !== publicKeyBase64) {
    throw new Error('BYOC client key replacement requires an explicit rotation');
  }
  const record: ByocClientAuthorizationRecord = {
    version: BYOC_CLIENT_AUTHORIZATION_VERSION,
    ...scope,
    publicKeyBase64,
    generation: prior?.generation ?? 1,
    status: 'authorized',
    updatedAt: now,
  };
  await store.write(record);
  return record;
}

export async function rotateAuthorizedByocClientKey(
  store: ByocClientAuthorizationStore,
  scope: ByocClientAuthorizationScope,
  oldPublicKeyBase64: string,
  nextPublicKeyBase64: string,
  now = new Date().toISOString(),
): Promise<ByocClientAuthorizationRecord> {
  assertByocClientPublicKey(oldPublicKeyBase64);
  assertByocClientPublicKey(nextPublicKeyBase64);
  const prior = await store.read(scope);
  if (!prior || prior.status !== 'authorized' || prior.publicKeyBase64 !== oldPublicKeyBase64) {
    throw new Error('BYOC client key rotation refused: old key is not currently authorized');
  }
  const record: ByocClientAuthorizationRecord = {
    ...prior,
    publicKeyBase64: nextPublicKeyBase64,
    generation: prior.generation + 1,
    status: 'authorized',
    updatedAt: now,
  };
  await store.write(record);
  return record;
}

export async function revokeAuthorizedByocClientKey(
  store: ByocClientAuthorizationStore,
  scope: ByocClientAuthorizationScope,
  publicKeyBase64: string,
  now = new Date().toISOString(),
): Promise<ByocClientAuthorizationRecord> {
  assertByocClientPublicKey(publicKeyBase64);
  const prior = await store.read(scope);
  // A rotation atomically replaced this key before the desktop's existing lifecycle helper
  // sends its explicit old-key revocation confirmation. A different currently-authorized key
  // is positive proof that this old key is already refused; keep the replacement intact.
  if (prior?.status === 'authorized' && prior.publicKeyBase64 !== publicKeyBase64) return prior;
  if (!prior || prior.status !== 'authorized' || prior.publicKeyBase64 !== publicKeyBase64) {
    throw new Error('BYOC client key revocation refused: key is not currently authorized');
  }
  const record = { ...prior, status: 'revoked' as const, updatedAt: now };
  await store.write(record);
  return record;
}

export async function assertAuthorizedByocClientKey(
  store: ByocClientAuthorizationStore,
  scope: ByocClientAuthorizationScope,
  publicKeyBase64: string,
  generation?: number,
): Promise<ByocClientAuthorizationRecord> {
  assertByocClientPublicKey(publicKeyBase64);
  const record = await store.read(scope);
  if (
    !record ||
    record.status !== 'authorized' ||
    record.publicKeyBase64 !== publicKeyBase64 ||
    (generation !== undefined && record.generation !== generation)
  ) throw new Error('BYOC client key is not authorized by the customer host');
  return record;
}
