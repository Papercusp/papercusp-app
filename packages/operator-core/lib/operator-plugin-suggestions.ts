/**
 * Plugin-authored suggestion sources (final v5 polish item).
 *
 * Calls every loaded plugin's `contributeOperatorSuggestions(ctx)` hook
 * and merges the returned suggestions through the same Zod + tier
 * pipeline the LLM output goes through.
 *
 * Errors per-plugin are isolated: a thrown hook does NOT block the
 * scan from emitting LLM suggestions. Logged + skipped.
 */

import { getPluginHost, buildPapercuspContext } from './plugin-host-runtime';
import { papercuspPath } from './papercusp-root';
import { join } from 'node:path';
import {
  SuggestionSchema,
  type Suggestion,
} from './operator-suggestion-schema';

/** Returns the LLM-emitted JSON shapes plugins contribute. */
export async function gatherPluginSuggestions(): Promise<Suggestion[]> {
  let host: Awaited<ReturnType<typeof getPluginHost>>;
  try {
    host = await getPluginHost();
  } catch {
    return [];
  }

  const out: Suggestion[] = [];
  for (const lp of host.loaded) {
    const hook = lp.plugin.hooks?.contributeOperatorSuggestions;
    if (!hook) continue;
    // The Operator scan isn't tied to a single harness — we run the
    // hook with a synthetic ctx scoped to the operator's own dir so
    // plugins can read their own state files but not pretend to be
    // a particular harness.
    const ctx = buildPapercuspContext({
      pluginName: lp.plugin.name,
      installSlug: 'system:operator',
      projectDir: papercuspPath('system', 'operator'),
      stateDir: papercuspPath('system', 'operator'),
      pluginDataDirOverride: join(papercuspPath('system', 'operator'), 'plugins', lp.plugin.name),
    });
    let raw: unknown[] = [];
    try {
      raw = (await hook(ctx)) ?? [];
    } catch (err) {
      console.warn(`[operator] plugin ${lp.plugin.name} contributeOperatorSuggestions threw:`, err);
      continue;
    }
    for (const candidate of raw) {
      const parsed = SuggestionSchema.safeParse(candidate);
      if (!parsed.success) {
        console.warn(`[operator] plugin ${lp.plugin.name} returned invalid suggestion:`, parsed.error.issues[0]?.message);
        continue;
      }
      out.push(parsed.data);
    }
  }
  return out;
}
