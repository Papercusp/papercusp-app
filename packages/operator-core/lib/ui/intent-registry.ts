/**
 * Browser-side intent registry.
 *
 * Singleton map of intent-name → handler. Two kinds of entries:
 *
 *   1. Built-ins (registered eagerly at module load by the dispatcher):
 *      `set_url`, `snapshot`, `read_visible_text`, `focus`,
 *      `scroll_into_view`, `click`.
 *
 *   2. Feature-registered (via the `useUiIntent` hook): one entry
 *      per mounted component that opts into agent control.
 *
 * Agents dispatch by name; the registry hands the args to the
 * registered handler. Unknown names produce a structured error that
 * propagates back to the agent.
 */

export type IntentHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

interface RegistryEntry {
  handler: IntentHandler;
  /** True for dispatcher-shipped built-ins; agents see them on every page. */
  builtIn: boolean;
}

const __registry: Map<string, RegistryEntry> = new Map();

export function registerIntent(name: string, handler: IntentHandler, opts: { builtIn?: boolean } = {}): () => void {
  __registry.set(name, { handler, builtIn: opts.builtIn === true });
  return () => {
    const cur = __registry.get(name);
    // Only unregister if this exact handler is still active (guards
    // against StrictMode double-mount or hot-reload stomping).
    if (cur && cur.handler === handler) __registry.delete(name);
  };
}

export function lookupIntent(name: string): RegistryEntry | undefined {
  return __registry.get(name);
}

export function listIntents(): Array<{ name: string; builtIn: boolean }> {
  return Array.from(__registry.entries()).map(([name, entry]) => ({ name, builtIn: entry.builtIn }));
}
