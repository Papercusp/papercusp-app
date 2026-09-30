/**
 * `claude-loaded-index` — a bench backend modeling the REAL Claude file-memory
 * runtime (memory-backend-improve-and-hybrid P-012).
 *
 * The plain `claude-file` bench backend scores LEXICAL SEARCH over the topic
 * files — but that is not how the live runtime recalls. Live, the generated
 * MEMORY.md index (one line per memory) is LOADED INTO CONTEXT WHOLE at
 * session start, and "retrieval" is the MODEL recognizing, from those one-line
 * hooks, which memories answer the intent. This backend measures that actual
 * mechanism: `search(query)` renders the full loaded index and asks an LLM to
 * pick the relevant entries (ranked, or none) — making the file-vs-mem0
 * comparison airtight on the methodological question "does load-all close the
 * paraphrase gap that lexical search loses?".
 *
 * Two structural notes the scorecard reader needs:
 *   - The model judges only the INDEX LINES (description hooks), not the topic
 *     bodies — exactly the live mechanism, where the body is read only after
 *     the model decides to open the file. A fact whose hook line doesn't carry
 *     it is invisible at recall time, however good the body.
 *   - Unlike a vector or lexical store, the model CAN answer "nothing here is
 *     relevant" — the loaded-index runtime has a native relevance threshold,
 *     so its hard-negative FP rate is a real measurement, not a floor artifact.
 *
 * Writes delegate to an inner ClaudeFileMemoryBackend (the same topic-file
 * store the live runtime writes). The LLM transport is injected (the CLI
 * passes llm-testing's `llmCall`; tests pass a fake).
 */
import type {
  ListOptions,
  MemoryAvailability,
  MemoryBackend,
  MemoryEntry,
  RememberOptions,
  SearchOptions,
  UpdatePatch,
} from '@papercusp/memory';
import type { LlmCallFn } from '@papercusp/testing-shell/llm';

/** Frozen model for run-over-run comparability (bump when changing). */
export const LOADED_INDEX_MODEL = 'claude-haiku-4-5';

/** Render the entries the way MEMORY.md presents them: one hook line each. */
export function renderLoadedIndex(entries: readonly MemoryEntry[]): string {
  return entries
    .map((e, i) => {
      const kind = e.kind ?? (typeof e.metadata?.kind === 'string' ? e.metadata.kind : 'note');
      const hook =
        typeof e.metadata?.description === 'string' && e.metadata.description.trim()
          ? e.metadata.description.trim()
          : e.text.replace(/\s+/g, ' ').slice(0, 140);
      return `${i + 1}. [${kind}] ${hook}`;
    })
    .join('\n');
}

/**
 * Parse the model's pick list. Accepts `{"picks":[3,1,7]}` (preferred) or a
 * bare JSON array; numbers are 1-based index-line positions. Anything
 * unparseable → no picks (scored as a miss, never a throw).
 */
export function parsePicks(text: string, max: number): number[] {
  try {
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { picks?: unknown }).picks)
        ? ((parsed as { picks: unknown[] }).picks)
        : [];
    const out: number[] = [];
    for (const v of arr) {
      const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
      if (Number.isInteger(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
    }
    return out;
  } catch {
    return [];
  }
}

export class ClaudeLoadedIndexBackend implements MemoryBackend {
  readonly name = 'claude-loaded-index';

  constructor(
    private readonly inner: MemoryBackend,
    private readonly llm: LlmCallFn,
    private readonly model: string = LOADED_INDEX_MODEL,
  ) {}

  available(): Promise<MemoryAvailability> {
    return this.inner.available();
  }

  remember(text: string, opts: RememberOptions): Promise<{ ids: string[]; storedEvents?: number }> {
    return this.inner.remember(text, opts);
  }

  get(id: string): Promise<MemoryEntry | null> {
    return this.inner.get(id);
  }

  forget(id: string): Promise<void> {
    return this.inner.forget(id);
  }

  update(id: string, patch: UpdatePatch): Promise<void> {
    return this.inner.update(id, patch);
  }

  list(opts: ListOptions): Promise<MemoryEntry[]> {
    return this.inner.list(opts);
  }

  async search(query: string, opts: SearchOptions): Promise<MemoryEntry[]> {
    const all = await this.inner.list({ scope: opts.scope });
    if (all.length === 0) return [];
    const limit = opts.limit ?? 6;
    const index = renderLoadedIndex(all);
    const res = await this.llm({
      model: this.model,
      system:
        'You are the memory-recall step of a coding agent. The agent\'s memory INDEX ' +
        '(one line per stored memory) is loaded in your context below. Given the ' +
        'agent\'s current intent, pick which memories are RELEVANT to it — the ones ' +
        'whose stored fact the agent would genuinely want in front of it for this ' +
        'intent. Respond with ONLY JSON: {"picks": [<line numbers, most relevant ' +
        'first>]}. Pick AT MOST ' + limit + '. If nothing in the index is relevant ' +
        'to the intent, respond {"picks": []} — do not stretch.',
      messages: [
        {
          role: 'user',
          content: `MEMORY INDEX:\n${index}\n\nCURRENT INTENT: "${query}"`,
        },
      ],
      maxTokens: 200,
      temperature: 0,
      responseFormat: 'json',
    });
    const picks = parsePicks(res.text, all.length);
    return picks.slice(0, limit).map((n, rank) => ({
      ...all[n - 1],
      // Ordering-only score, mirroring the MemoryEntry contract.
      score: 1 - rank / Math.max(1, limit),
    }));
  }
}
