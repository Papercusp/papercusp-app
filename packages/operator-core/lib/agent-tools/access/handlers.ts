/**
 * The access:* tool logic (P-012, WI-10004025), injectable so the tests drive it with fakes.
 * Each tool file wires these to the real store with {@link defaultAccessHandlerDeps}.
 *
 * A key's SECRET never enters a tool result by default: agent transcripts are persisted and
 * indexed for search, so a secret returned there would outlive the conversation. access:create
 * writes it once to a private file (mode 0600, outside any repository) and returns the path; the
 * caller hands the path to the user. `revealSecret: true` returns it inline instead, for a user
 * who explicitly asks for that.
 */
import type { AppKeyRow, CreateAppKeyOptions, CreatedAppKey } from '../../connected-apps/store';
import {
  ACCESS_TOOL_CREATOR_EMAIL,
  accessKeyView,
  jsonResult,
  localOnlyRefusal,
  refusedResult,
  type AccessToolCallContext,
  type AccessToolDeps,
} from './_shared';

export interface AccessHandlerDeps extends AccessToolDeps {
  listKeys(workspaceId: string): Promise<AppKeyRow[]>;
  createKey(opts: CreateAppKeyOptions): Promise<CreatedAppKey>;
  setPaused(workspaceId: string, id: string, paused: boolean): Promise<boolean>;
  revoke(workspaceId: string, id: string): Promise<boolean>;
  workspaceExists(workspaceId: string): boolean;
  /** Write a new key's secret to a private file and return its path. */
  writeSecretFile(id: string, secret: string): Promise<string>;
  /** Classify a store error: a scope or spend-cap refusal, or null to rethrow. */
  refusalOf(err: unknown): { error: 'invalid_scope' | 'invalid_spend_cap'; problems: unknown } | null;
}

export async function defaultAccessHandlerDeps(base: AccessToolDeps): Promise<AccessHandlerDeps> {
  const [store, serviceKeys, registry, fs, os, path] = await Promise.all([
    import('../../connected-apps/store'),
    import('../../connected-apps/service-keys'),
    import('../../workspace-registry'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  return {
    ...base,
    listKeys: store.listAppKeys,
    createKey: store.createAppKey,
    setPaused: store.setAppKeyPaused,
    revoke: store.revokeAppKey,
    workspaceExists: (id) => Boolean(registry.workspaceById(id)),
    async writeSecretFile(id, secret) {
      const dir = process.env.PAPERCUSP_ACCESS_KEY_DIR || path.join(os.homedir(), '.papercusp', 'connected-apps', 'keys');
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${id}.key`);
      // wx: never overwrite an existing file; the mode applies at creation.
      await fs.writeFile(file, `${secret}\n`, { mode: 0o600, flag: 'wx' });
      return file;
    },
    refusalOf(err) {
      if (err instanceof store.AppKeyScopeError) return { error: 'invalid_scope', problems: err.problems };
      if (err instanceof serviceKeys.SpendCapError) return { error: 'invalid_spend_cap', problems: err.problems };
      return null;
    },
  };
}

export async function accessList(
  args: { workspaceId: string; includeRevoked?: boolean },
  ctx: AccessToolCallContext | undefined,
  deps: AccessHandlerDeps,
) {
  const refusal = localOnlyRefusal(ctx, deps);
  if (refusal) return refusedResult('local_only', { reason: refusal });
  const keys = (await deps.listKeys(args.workspaceId)).filter((k) => args.includeRevoked || !k.revoked_at);
  return jsonResult({ ok: true, workspaceId: args.workspaceId, count: keys.length, keys: keys.map(accessKeyView) });
}

export interface AccessCreateArgs {
  workspaceId: string;
  label: string;
  kind?: 'app' | 'service';
  tools?: string[];
  capabilities?: string[];
  harnesses?: string[];
  expiresAt?: string;
  spendCapCents?: number | null;
  spendCapWindowSec?: number | null;
  revealSecret?: boolean;
}

export async function accessCreate(args: AccessCreateArgs, ctx: AccessToolCallContext | undefined, deps: AccessHandlerDeps) {
  const refusal = localOnlyRefusal(ctx, deps);
  if (refusal) return refusedResult('local_only', { reason: refusal });
  if (!deps.workspaceExists(args.workspaceId)) return refusedResult('workspace_not_found', { workspaceId: args.workspaceId });
  const expiresAt = args.expiresAt ? new Date(args.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) return refusedResult('invalid_expires_at');
  let created: CreatedAppKey;
  try {
    created = await deps.createKey({
      workspaceId: args.workspaceId,
      userEmail: ACCESS_TOOL_CREATOR_EMAIL,
      label: args.label,
      kind: args.kind ?? 'app',
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.capabilities ? { capabilities: args.capabilities } : {}),
      ...(args.harnesses ? { harnesses: args.harnesses } : {}),
      expiresAt,
      ...(args.spendCapCents !== undefined ? { spendCapCents: args.spendCapCents } : {}),
      ...(args.spendCapWindowSec !== undefined ? { spendCapWindowSec: args.spendCapWindowSec } : {}),
    });
  } catch (err) {
    const refused = deps.refusalOf(err);
    if (refused) return refusedResult(refused.error, { problems: refused.problems });
    throw err;
  }
  const key = accessKeyView(created.app);
  if (args.revealSecret) {
    return jsonResult({ ok: true, key, secret: created.key, note: 'Shown once. It is not stored anywhere readable.' });
  }
  const secretFile = await deps.writeSecretFile(created.app.id, created.key);
  return jsonResult({
    ok: true,
    key,
    secretFile,
    note: 'The key was written once to secretFile (readable only by this account). Give the user that path; delete the file once the key is copied into the app.',
  });
}

export async function accessSetPaused(
  args: { workspaceId: string; id: string; paused: boolean },
  ctx: AccessToolCallContext | undefined,
  deps: AccessHandlerDeps,
) {
  const refusal = localOnlyRefusal(ctx, deps);
  if (refusal) return refusedResult('local_only', { reason: refusal });
  const changed = await deps.setPaused(args.workspaceId, args.id, args.paused);
  if (!changed) return refusedResult('key_not_found', { id: args.id });
  return jsonResult({ ok: true, id: args.id, paused: args.paused });
}

export async function accessRevoke(
  args: { workspaceId: string; id: string },
  ctx: AccessToolCallContext | undefined,
  deps: AccessHandlerDeps,
) {
  const refusal = localOnlyRefusal(ctx, deps);
  if (refusal) return refusedResult('local_only', { reason: refusal });
  const revoked = await deps.revoke(args.workspaceId, args.id);
  if (!revoked) return refusedResult('key_not_found', { id: args.id });
  return jsonResult({ ok: true, id: args.id, revoked: true });
}
