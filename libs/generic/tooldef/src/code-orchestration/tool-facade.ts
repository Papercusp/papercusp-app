/**
 * code-execution-tool-orchestration B-CX-1A — the tool FACADE.
 *
 * The code-execution sandbox injects a `tools` object whose every member is one of the
 * agent's ALLOWED tools, callable as a normal async function:
 *
 *     const open = await tools.workItems.list({ status: 'open' });
 *     await tools.coord.wakeQueue();                 // hyphenated verbs → camelCase
 *     await tools.call('plans:set-status', { ... }); // universal escape hatch by full name
 *
 * Each call is routed through an INJECTED `dispatch` fn. In production that fn is bound to the
 * caller's `UnifiedToolContext` + `DispatchProjectedDeps` (see `realDispatch` in
 * `dispatch-binding.ts`) so every call goes through the SAME gating / capability-envelope /
 * audit pipeline as an MCP `tools/call` — code-mode is just a new caller of the dispatcher, not
 * a parallel tool system. Injection keeps this builder pure + unit-testable with a mock.
 *
 * SAFETY MODEL: the facade only contains tools in `allowed` (the agent's capability envelope),
 * so model-written code physically cannot reference a tool it isn't permitted to call. That
 * whitelist — NOT vm isolation — is the security boundary (the field consensus; see the plan
 * §8). The dry-run/confirm gate on `effect: 'write'` tools (B-CX-PRE marker, B-CX-2A gate) is
 * the second layer.
 */
import type { ProjectedTool } from '../tool-projection';

/**
 * Per-call dispatch the facade invokes. Injected so the facade is decoupled from ctx/deps
 * construction — production binds it to the real dispatcher; tests pass a mock.
 */
export type FacadeDispatch = (
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
) => Promise<unknown>;

export interface ToolFacade {
  /** Universal escape hatch — call any ALLOWED tool by its full MCP name (`ns:verb`). */
  call(toolName: string, args?: unknown): Promise<unknown>;
  /** Namespaced access: `tools.<camelNamespace>.<camelVerb>(args)`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [ns: string]: any;
}

/**
 * `work_items` / `wake-queue` / `set_status` → `workItems` / `wakeQueue` / `setStatus`
 * (valid JS identifiers).
 * Exported so the COMPILE-TIME signature generator (facade-types.ts, B-CX-API) names verbs
 * identically to this RUNTIME facade — the two must never disagree.
 */
export function camelNamespace(ns: string): string {
  return ns.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

export function camelVerb(verb: string): string {
  return verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());
}

/**
 * Split a projected tool's full MCP name into its namespace + verb, tolerating BOTH the
 * canonical colon shape (`ns:verb`) and the DOT shape a plugin-namespaced tool projects as
 * (`plugin.verb`, e.g. `gitnexus.query` — see `registerPluginTools` in `@papercusp/plugin-loader`,
 * which mounts each plugin tool as `<shortPluginName>.<tool.name>` by default). Colon wins when
 * both are present (deterministic; a colon-form name is never mis-split on an incidental dot in
 * its verb). Returns `null` for a name with neither separator — nothing recognizable to expose.
 *
 * EI-18683272396981279: before this, every dot-form (plugin) tool name failed the colon-only
 * check every facade builder ran and was silently absent from `code:run`/`code:tools` — a plugin
 * tool the agent's `allowed` envelope already includes (role/capability scoping is unaffected by
 * this — see `roleScopedToolNames`) was simply never reachable through the facade at all, with no
 * error naming why, silently pushing agents back to a worse tool (e.g. raw grep instead of
 * `gitnexus.query`) whenever they followed the batching (`code:run`) nudge.
 */
export function splitToolName(name: string): { rawNs: string; rawVerb: string } | null {
  const ci = name.indexOf(':');
  if (ci > 0) return { rawNs: name.slice(0, ci), rawVerb: name.slice(ci + 1) };
  const di = name.indexOf('.');
  if (di > 0) return { rawNs: name.slice(0, di), rawVerb: name.slice(di + 1) };
  return null;
}

/**
 * The ergonomic spellings an agent might write for ONE identifier (a namespace
 * or a verb), so any of them resolves against the facade:
 *   - the camel form            — `workItems`, `wakeQueue`
 *   - the snake_underscore form  — `work_items`, `wake_queue` (dot-accessible)
 *   - the raw MCP spelling       — `work_items`, `wake-queue` (for exact bracket
 *                                  access, e.g. `tools.coord['wake-queue']`)
 * The canonical MCP name is snake/hyphen (`work_items:wake-queue`), so an agent
 * naturally types the snake spelling — this makes it Just Work. Deterministic
 * and lossless (all forms derive from the same name), so it can never
 * mis-target. Deduped; single-word identifiers collapse to one entry.
 */
export function aliasSpellings(raw: string, camel: string): string[] {
  const snake = raw.replace(/-/g, '_');
  return [...new Set([camel, snake, raw])];
}

/**
 * Build the `tools` facade the sandbox injects. One callable per ALLOWED tool, both
 * namespaced (`tools.camelNamespace.camelVerb`) and flat (`tools.call('ns:verb', …)`).
 * Tools outside `allowed` are absent. Returns an empty-but-callable facade if `tools` is empty.
 */
export function buildToolFacade(
  tools: readonly ProjectedTool[],
  dispatch: FacadeDispatch,
  allowed?: ReadonlySet<string>,
  /** Parse-check UNKNOWN refs (`ns.verb` dotted or `ns:verb` full). Each is bound to a stub that
   *  REJECTS only when called, so an unknown `tools.ns.verb` fails PER-CALL — isolable via
   *  Promise.allSettled / try-catch — instead of throwing a cryptic "cannot read undefined" that
   *  aborts a whole Promise.all (autonomous-loop-hardening F8/H2). */
  unknownRefs?: readonly string[],
): ToolFacade {
  const byName = new Map<string, ProjectedTool>();
  const facade: ToolFacade = {
    async call(toolName: string, args?: unknown): Promise<unknown> {
      const tool = byName.get(toolName);
      if (!tool) {
        throw new Error(`code-orchestration: tool not available in this sandbox: ${toolName}`);
      }
      return dispatch(tool, toolName, args ?? {});
    },
  };

  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    const split = splitToolName(name);
    if (!split) continue; // skip names without a `ns:verb` / `ns.verb` shape
    if (allowed && !allowed.has(name)) continue;

    byName.set(name, tool);
    const { rawNs, rawVerb } = split;
    const ns = camelNamespace(rawNs);
    const verb = camelVerb(rawVerb);
    if (rawNs === 'call' || ns === 'call') continue; // never shadow the escape hatch
    const bucket = (facade[ns] ??= {} as Record<string, unknown>);
    const fn = (args?: unknown): Promise<unknown> => dispatch(tool, name, args ?? {});
    // SNAKE_CASE ALIASES (agent ergonomics). The canonical MCP name is
    // snake/hyphen (`work_items:wake-queue`), so an agent naturally writes the
    // snake spelling `tools.work_items.wakeQueue` (or fully-snake
    // `tools.work_items.wake_queue`). Register every ergonomic spelling of the
    // verb, and alias the SAME bucket object under every spelling of the
    // namespace so any combination resolves. Deterministic + lossless (all
    // forms derive from the one MCP name), so it can never mis-target.
    for (const key of aliasSpellings(rawVerb, verb)) bucket[key] = fn;
    for (const key of aliasSpellings(rawNs, ns)) if (key !== ns) facade[key] = bucket;
  }

  // F8 (autonomous-loop-hardening / H2): bind each parse-check UNKNOWN ref to a stub that REJECTS
  // only when called, so an unknown `tools.ns.verb` fails PER-CALL (isolable) rather than throwing
  // a cryptic "cannot read undefined" that aborts a sibling Promise.all. Never shadows a real verb
  // (unknown refs aren't real by definition). The `tools.call('ns:verb')` hatch already rejects
  // clearly via the `call` handler above, so only the dotted `tools.ns.verb` form needs a stub.
  if (unknownRefs) {
    for (const ref of unknownRefs) {
      const ci = ref.indexOf(':');
      const di = ref.indexOf('.');
      const sep = ci >= 0 ? ci : di; // `ns:verb` (call-hatch full name) or `ns.verb` (dotted access)
      if (sep <= 0) continue;
      const ns = camelNamespace(ref.slice(0, sep));
      if (ns === 'call') continue; // never shadow the escape hatch
      const rawVerb = ref.slice(sep + 1);
      const verb = camelVerb(rawVerb);
      const bucket = (facade[ns] ??= {} as Record<string, unknown>);
      if (bucket[verb] === undefined) {
        bucket[verb] = (): Promise<never> =>
          Promise.reject(
            new Error(
              `code-orchestration: tool not available in this sandbox: ${ns}:${rawVerb} — not in your ` +
                `allowed facade (fix the tools.${ns}.${verb} name; see unknownRefs/facadeHelp). Wrap it in ` +
                `Promise.allSettled or try/catch so sibling calls still return.`,
            ),
          );
      }
    }
  }

  return facade;
}

/** Names of the tools exposed by a facade (for parse-checks + prompt catalogs). */
export function facadeToolNames(
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name || !splitToolName(name)) continue;
    if (allowed && !allowed.has(name)) continue;
    out.push(name);
  }
  return out.sort();
}

/**
 * The role-scoped allowed set BOTH code-mode meta-tools (`code:run`, `code:tools`) build before
 * handing the facade/signatures to a script: the MCP names of every tool whose `agentRoles` admit
 * `role`, minus an `exclude` set (the meta-tools exclude THEMSELVES so a script can't recursively
 * nest code-mode). A tool with no `agentRoles` is role-open; an empty list is an explicit deny-all
 * allowlist. This MIRRORS the dispatcher's role-allowlist gate (`dispatch-stack.ts` / `listMcpProjections`)
 * so the facade a script can reference is exactly the set the dispatcher would let it call — the
 * envelope IS the security boundary, so the two must never disagree.
 *
 * Extracted from the identical loop that lived inline in both `code/run.ts` and `code/tools.ts`
 * (code-execution-tool-orchestration) so the scoping has ONE definition + a hermetic unit test.
 */
export function roleScopedToolNames(
  tools: readonly ProjectedTool[],
  role: string | null | undefined,
  exclude?: ReadonlySet<string>,
): Set<string> {
  const allowed = new Set<string>();
  for (const tool of tools) {
    const name = tool.expose?.mcp?.name;
    if (!name) continue;
    if (exclude?.has(name)) continue;
    const roles = tool.agentRoles;
    const roleOk = !roles || (role != null && roles.includes(role));
    if (roleOk) allowed.add(name);
  }
  return allowed;
}
