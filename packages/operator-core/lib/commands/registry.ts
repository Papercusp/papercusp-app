/**
 * Agent Action Registry — engine.
 *
 * See /docs/agents/action-registry §2.2 for the full design rationale.
 *
 * Critical contract: `runCommand` and `runQuery` NEVER throw to their
 * callers. Every error becomes a `CommandResult.ok=false` payload that
 * shims serialize to their transport's preferred error shape (MCP
 * isError, OpenAI Realtime tool error, ElevenLabs webhook 4xx) — all
 * from the same `CommandErrorPayload`.
 */

import { audit, auditQuery } from './audit';
import {
  type AgentId,
  type CommandContext,
  type CommandDef,
  type CommandErrorPayload,
  type CommandResult,
  CommandError,
  type Definition,
  type QueryDef,
  type Tier,
} from './types';

const defs = new Map<string, Definition>();
const inflight = new Map<string, Promise<unknown>>();

export class RegistryDuplicateError extends Error {
  constructor(id: string) {
    super(`duplicate command id: ${id}`);
    this.name = 'RegistryDuplicateError';
  }
}

export function register(def: Definition): void {
  if (defs.has(def.id)) throw new RegistryDuplicateError(def.id);
  defs.set(def.id, def);
}

export function get(id: string): Definition | undefined {
  return defs.get(id);
}

export interface ListFilter {
  kind?: 'command' | 'query';
  agent?: AgentId;
  tier?: Tier;
  /** When set, only commands whose `browser` matches one of these. */
  browser?: Array<'required' | 'optional' | 'none'>;
}

export function list(filter: ListFilter = {}): Definition[] {
  const out: Definition[] = [];
  for (const d of defs.values()) {
    if (filter.kind && d.kind !== filter.kind) continue;
    if (filter.agent && !d.agents.includes(filter.agent)) continue;
    if (filter.tier && d.tier !== filter.tier) continue;
    if (filter.browser && d.kind === 'command' && !filter.browser.includes(d.browser)) continue;
    out.push(d);
  }
  return out;
}

/** Test-only: clear all registrations. NOT exported as part of the public API. */
export function __resetRegistryForTests(): void {
  defs.clear();
  inflight.clear();
}

export async function runCommand<T = unknown>(
  id: string,
  args: unknown,
  ctx: CommandContext,
): Promise<CommandResult<T>> {
  const def = defs.get(id);
  if (!def || def.kind !== 'command')
    return err('unknown', `no such command: ${id}`, false);
  if (!def.agents.includes(ctx.agent))
    return err('denied', `agent ${ctx.agent} not authorized for ${id}`, false);

  // Schema validation
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success)
    return err('invalid-args', formatZodError(parsed.error), false);

  // Browser-requirement gate. Commands needing a browser but called from
  // a non-browser context (Pi, server-side cron) get a structured
  // 'no-active-session' before the handler runs. The shim that has a
  // back-channel pre-resolves the session and passes it via ctx.sessionId;
  // if set, the gate is satisfied.
  if (def.browser === 'required' && !ctx.sessionId)
    return err(
      'no-active-session',
      'this command needs an open browser tab',
      true,
      'ask the user to open the workspace in a browser',
    );

  // Concurrency
  const policy = def.concurrent ?? 'allow';
  if (policy !== 'allow') {
    if (inflight.has(id)) {
      if (policy === 'deny') return err('conflict', `${id} is already running`, true);
      // 'queue' — wait for the in-flight call, then run.
      try { await inflight.get(id); } catch { /* prior failure shouldn't block us */ }
    }
  }

  const t0 = Date.now();
  const auditRow = {
    id,
    agent: ctx.agent,
    workspace: ctx.workspace,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    args: parsed.data as unknown,
  };

  const promise = (async (): Promise<CommandResult<T>> => {
    try {
      const value = (await def.handler(parsed.data, ctx)) as T;
      audit({ ...auditRow, status: 'ok', durationMs: Date.now() - t0 });
      return { ok: true, value };
    } catch (e: unknown) {
      const payload =
        e instanceof CommandError
          ? e.payload
          : ({
              code: 'internal',
              message: 'handler threw',
              retryable: false,
            } satisfies CommandErrorPayload);
      audit({
        ...auditRow,
        status: 'err',
        errorCode: payload.code,
        durationMs: Date.now() - t0,
      });
      return { ok: false, error: payload };
    }
  })();

  if (policy !== 'allow') {
    inflight.set(
      id,
      promise.finally(() => inflight.delete(id)) as Promise<unknown>,
    );
  }
  return promise;
}

export async function runQuery<T = unknown>(
  id: string,
  args: unknown,
  ctx: CommandContext,
): Promise<CommandResult<T>> {
  const def = defs.get(id);
  if (!def || def.kind !== 'query')
    return err('unknown', `no such query: ${id}`, false);
  if (!def.agents.includes(ctx.agent))
    return err('denied', `agent ${ctx.agent} not authorized for ${id}`, false);

  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success)
    return err('invalid-args', formatZodError(parsed.error), false);

  // Audit policy per-query. Default sampled.
  const policy = def.audit ?? 'sample';
  if (policy !== 'none') {
    auditQuery({
      id,
      agent: ctx.agent,
      workspace: ctx.workspace,
      requestId: ctx.requestId,
      args: policy === 'full' ? (parsed.data as unknown) : undefined,
      sample: policy === 'sample',
    });
  }

  try {
    const value = (await def.handler(parsed.data, ctx)) as T;
    return { ok: true, value };
  } catch (e: unknown) {
    const payload =
      e instanceof CommandError
        ? e.payload
        : ({
            code: 'internal',
            message: 'query handler threw',
            retryable: false,
          } satisfies CommandErrorPayload);
    return { ok: false, error: payload };
  }
}

// ─── helpers ────────────────────────────────────────────────────────────

function err(
  code: string,
  message: string,
  retryable: boolean,
  hint?: string,
): CommandResult<never> {
  return { ok: false, error: { code, message, retryable, hint } };
}

function formatZodError(zerr: { issues: ReadonlyArray<{ path: ReadonlyArray<unknown>; message: string }> }): string {
  return zerr.issues
    .map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`)
    .join('; ');
}
