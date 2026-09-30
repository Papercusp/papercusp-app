/**
 * ServerActionRegistry — runtime that wires plugin-declared actions
 * (from papercusp.json `actions[]`) to the handlers each plugin's
 * `init(ctx)` registers via `ctx.actions.register(name, handler)`.
 *
 * Contract:
 *
 *   1. Constructor takes the plugin's manifest-declared `actions[]` plus
 *      the plugin's manifest-declared `capabilities[]`. It validates each
 *      action's `capabilities[]` is a subset of the plugin's capabilities,
 *      so an action can never escalate beyond what the user consented to
 *      at enable time.
 *
 *   2. During `plugin.init(ctx)`, the plugin calls
 *      `ctx.actions.register(name, handler)` for each action it implements.
 *      Names not in the manifest are rejected. Duplicate registrations are
 *      rejected.
 *
 *   3. After init returns, the loader calls `registry.seal()`. Subsequent
 *      register() calls throw — handlers are immutable post-init.
 *
 *   4. `invoke({name, ctx, params, triggerSource, triggerId})` looks up
 *      the handler, mints an AbortSignal with the action's timeout
 *      (default 60s, override via manifest.serverHandler.timeoutSec),
 *      dispatches the handler, audit-logs the outcome, and returns the
 *      handler's `{ok, result?, error?}` envelope. Throws → audit-logs
 *      "error" and returns `{ok:false, error: <message>}`. Timeout →
 *      "timeout" outcome and `{ok:false, error: 'action timed out'}`.
 */

import type { AuditWriter } from './audit';
import { InMemoryAuditWriter, type AuditRow } from './audit';
import { matchWildcardCap } from './capabilities';

export class ActionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionRegistryError';
  }
}

export interface ActionDecl {
  name: string;
  label?: string;
  surfaces?: string[];
  capabilities?: string[];
  serverHandler?: { timeoutSec?: number };
  paramsSchema?: unknown;
}

export interface InvokeRequest {
  name: string;
  ctx: unknown;
  params?: unknown;
  triggerSource: AuditRow['triggerSource'];
  triggerId: string;
}

export interface ActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type ActionHandler = (
  ctx: unknown,
  params: unknown,
  signal: AbortSignal,
) => Promise<ActionResult> | ActionResult;

export interface RegistryOptions {
  pluginName: string;
  pluginCapabilities?: string[];
  audit?: AuditWriter;
  /** Default per-action timeout when manifest doesn't specify. */
  defaultTimeoutSec?: number;
}

export class ServerActionRegistry {
  private declared = new Map<string, ActionDecl>();
  private handlers = new Map<string, ActionHandler>();
  private sealed = false;
  private readonly pluginName: string;
  private readonly pluginCaps: Set<string>;
  private readonly audit: AuditWriter;
  private readonly defaultTimeoutSec: number;

  constructor(declaredActions: ActionDecl[] | undefined, opts: RegistryOptions) {
    this.pluginName = opts.pluginName;
    this.pluginCaps = new Set(opts.pluginCapabilities ?? []);
    this.audit = opts.audit ?? new InMemoryAuditWriter();
    this.defaultTimeoutSec = opts.defaultTimeoutSec ?? 60;

    if (!Array.isArray(declaredActions)) return;

    for (const a of declaredActions) {
      if (!a || typeof a.name !== 'string' || a.name.length === 0) {
        throw new ActionRegistryError(`action declaration missing 'name'`);
      }
      if (this.declared.has(a.name)) {
        throw new ActionRegistryError(`duplicate action name "${a.name}"`);
      }
      // Validate caps ⊆ plugin caps. Wildcards (`http:fetch:*.foo`) match
      // any same-prefix entry; exact strings must match exactly.
      if (Array.isArray(a.capabilities)) {
        for (const cap of a.capabilities) {
          if (!this.pluginAllowsCap(cap)) {
            throw new ActionRegistryError(
              `action "${a.name}" requires capability "${cap}" not declared in plugin manifest`,
            );
          }
        }
      }
      this.declared.set(a.name, a);
    }
  }

  /** Called by plugin.init via ctx.actions.register. */
  register(name: string, handler: ActionHandler): void {
    if (this.sealed) {
      throw new ActionRegistryError(
        `cannot register "${name}": registry is sealed (init has returned)`,
      );
    }
    if (typeof handler !== 'function') {
      throw new ActionRegistryError(`handler for "${name}" must be a function`);
    }
    if (!this.declared.has(name)) {
      throw new ActionRegistryError(
        `cannot register handler for "${name}": not declared in manifest.actions[]`,
      );
    }
    if (this.handlers.has(name)) {
      throw new ActionRegistryError(`handler for "${name}" already registered`);
    }
    this.handlers.set(name, handler);
  }

  seal(): void {
    this.sealed = true;
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  registeredNames(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  declaredNames(): string[] {
    return Array.from(this.declared.keys()).sort();
  }

  async invoke(req: InvokeRequest): Promise<ActionResult> {
    const decl = this.declared.get(req.name);
    if (!decl) {
      return this.failSync(req, 'capability-denied', `action "${req.name}" not declared`);
    }
    const handler = this.handlers.get(req.name);
    if (!handler) {
      return this.failSync(req, 'error', `no handler registered for "${req.name}"`);
    }
    const timeoutMs = (decl.serverHandler?.timeoutSec ?? this.defaultTimeoutSec) * 1000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const start = Date.now();
    try {
      const out = await Promise.race([
        Promise.resolve(handler(req.ctx, req.params ?? {}, ctrl.signal)),
        new Promise<ActionResult>((_, rej) => {
          ctrl.signal.addEventListener('abort', () =>
            rej(new Error(`action "${req.name}" timed out after ${timeoutMs}ms`)),
          );
        }),
      ]);
      const result = this.normalizeResult(out);
      try {
        await this.recordAudit(req, result.ok ? 'ok' : 'error', Date.now() - start, result.error);
      } catch (auditErr: unknown) {
        // Fail-closed (Batch C5): an action that ran but couldn't be
        // audited is worse than one that didn't run. Surface the audit
        // failure as the action's failure; the handler's effects may
        // have completed but the host won't lie about whether they're
        // recorded.
        const msg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        return { ok: false, error: `audit write failed: ${msg}` };
      }
      return result;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const outcome: AuditRow['outcome'] = ctrl.signal.aborted ? 'timeout' : 'error';
      try {
        await this.recordAudit(req, outcome, Date.now() - start, msg);
      } catch (auditErr: unknown) {
        const auditMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
        return { ok: false, error: `${msg} (also: audit write failed: ${auditMsg})` };
      }
      return { ok: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private normalizeResult(out: unknown): ActionResult {
    if (out && typeof out === 'object' && 'ok' in (out as Record<string, unknown>)) {
      return out as ActionResult;
    }
    return { ok: true, result: out };
  }

  private failSync(
    req: InvokeRequest,
    outcome: AuditRow['outcome'],
    msg: string,
  ): ActionResult {
    // Fire-and-forget audit for sync-fail paths (action not declared, no
    // handler). These are programmer errors caught before the action's
    // effects could run; the audit best-effort suffices.
    void this.recordAudit(req, outcome, 0, msg).catch(() => {});
    return { ok: false, error: msg };
  }

  private async recordAudit(
    req: InvokeRequest,
    outcome: AuditRow['outcome'],
    durationMs: number,
    errorMessage?: string,
    extras?: Partial<Pick<AuditRow, 'capabilitiesUsed' | 'killedByTimeout' | 'stdoutBytes' | 'stderrBytes' | 'truncated'>>,
  ): Promise<void> {
    const ctxObj = (req.ctx as { installSlug?: string }) ?? {};
    const row: AuditRow = {
      ts: Date.now(),
      pluginName: this.pluginName,
      installSlug: ctxObj.installSlug ?? '',
      actionName: req.name,
      triggerSource: req.triggerSource,
      triggerId: req.triggerId,
      params: req.params ?? {},
      outcome,
      durationMs,
      errorMessage,
      ...(extras ?? {}),
    };
    // Fail-closed (Batch C5, Rust-port-feedback item 9): if the audit
    // writer fails, the action invocation must be considered untrusted.
    // The InMemoryAuditWriter never throws (used in CLI/dev); the
    // operator's PgAuditWriter throws on PG outage, which surfaces here
    // as a rejected promise the host treats as a hard error. Callers
    // (invoke()) propagate the rejection up.
    await this.audit.write(row);
  }

  /**
   * Plugin caps may be exact strings or wildcards (`http:fetch:*.foo.com`).
   * An action's required cap matches a plugin cap when the action cap is
   * exactly equal OR the plugin cap is a wildcard whose prefix matches.
   */
  private pluginAllowsCap(actionCap: string): boolean {
    if (this.pluginCaps.has(actionCap)) return true;
    for (const pluginCap of this.pluginCaps) {
      if (matchWildcardCap(pluginCap, actionCap)) return true;
    }
    return false;
  }
}
