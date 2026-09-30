/**
 * capture-recipe.ts — the code:run → recipe CAPTURE path
 * (code-recipes-2026-06-21 Phase 1, P-003).
 *
 * On a SUCCESSFUL, non-dry-run code:run the handler ALWAYS saves the script as a
 * reusable recipe (D-012: every run saves; the only non-save path is a Phase-2
 * dedup-reuse). title + description are OPTIONAL on the tool — when the agent
 * omits them we DERIVE a deterministic fallback so a recipe is always captured
 * and the call never fails for a missing title (non-breaking for the live
 * fleet's existing code:run calls).
 *
 * Everything here is BEST-EFFORT: `captureRecipe` wraps the whole thing in
 * try/catch (logs + swallows) so capture can NEVER break a code:run. The pure
 * helpers (slug/title/description derivation, tools_used extraction) are split
 * out so they unit-test without PG or an embedder.
 *
 * Server-only.
 */
import { createHash } from 'node:crypto';
import type { ProjectedTool } from '@papercusp/agent-mcp';
import { checkScript, ensureParseCheckReady } from '@papercusp/tooldef';
import {
  upsertRecipe,
  recordRecipeRun,
  getRecipe,
  findActiveRecipeByStructuralFingerprint,
  isLowValueRecipe,
  type CodeRecipeRow,
} from '../../code-recipes-store';
import type { NormalizedExecutionTrace } from '../../orchestration-trace';
import type { CapabilityManifestV1, RecipeBindingSchemaV1 } from '../../recipe-contract';
import { searchSimilarRecipes, type SimilarRecipe } from '../../code-recipes-search';
import { resolveLearningPotSlug } from '../../learning/pot-scope';
import {
  deriveRecipeAuthority,
  recipeAuthorityContextFromDescriptor,
} from '../../recipe-authority';
import type { EmbedderMode } from '@papercusp/memory';
import type { ProseProfileSelection } from '../../search/prose-vector-dims';

/** Stable kebab slug from a title (the recipe PRIMARY KEY). Matches the
 *  plans:apply-plan-block toKebab so recipe ids look like every other slug. */
export function recipeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Resolve the recipe PRIMARY KEY id (P-003 collision-fix).
 *
 * When the agent GAVE a title, `id = recipeSlug(title)` — the intended EXPLICIT
 * dedup key (re-running the same titled recipe upserts in place, bumping its
 * run_count). When the title was AUTO-DERIVED (no `given.title`), suffix the slug
 * with a short content-hash of the script: two DIFFERENT scripts that happen to
 * derive the SAME tool-set fallback title (`recipe: a + b`) must not clobber each
 * other and pollute one another's run_count. Cross-title semantic dedup is the
 * SearchSource (#1); this only stops auto-derived-title collisions.
 */
export function recipeId(
  title: string,
  description: string,
  script: string,
  given: { title?: string },
): string {
  const base = recipeSlug(title) || recipeSlug(description) || 'untitled-recipe';
  if (given.title?.trim()) return base; // explicit title ⇒ stable dedup key
  const hash = createHash('sha1').update(script).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** `wake-queue` / `set_status` → `wakeQueue` / `setStatus` — mirrors parse-check. */
const camelVerb = (verb: string): string =>
  verb.replace(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase());

/**
 * The canonical `ns:verb` tool names a script references, via the SAME static
 * resolver the parse-check uses (`checkScript` resolves dotted access, the
 * `tools.call('ns:verb')` hatch, aliasing, and destructuring). `checkScript`
 * returns `refs` in MEMBER form (`ns.camelVerb`) for dotted access and FULL form
 * (`ns:verb`) for the call-hatch; we reverse-map members back to canonical full
 * names via the same camelVerb keying the parse-check builds internally, and keep
 * any already-canonical full names as-is. Result is sorted + de-duped.
 */
export function extractToolsUsed(
  script: string,
  tools: readonly ProjectedTool[],
  allowed?: ReadonlySet<string>,
): string[] {
  const memberToName = new Map<string, string>(); // "ns.camelVerb" → full "ns:verb"
  const fullNames = new Set<string>();
  for (const t of tools) {
    const name = t.expose?.mcp?.name;
    if (!name || name.indexOf(':') <= 0) continue;
    if (allowed && !allowed.has(name)) continue;
    const ci = name.indexOf(':');
    memberToName.set(`${name.slice(0, ci)}.${camelVerb(name.slice(ci + 1))}`, name);
    fullNames.add(name);
  }
  const out = new Set<string>();
  for (const ref of checkScript(script, tools, allowed).refs) {
    if (ref.includes(':')) {
      if (fullNames.has(ref)) out.add(ref); // call-hatch full name
    } else {
      const full = memberToName.get(ref); // dotted member → canonical
      if (full) out.add(full);
    }
  }
  return [...out].sort();
}

/** First `// …` line comment in the script, trimmed — the agent's own label. */
function firstCommentTitle(script: string): string | null {
  for (const raw of script.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('//')) {
      const text = line.replace(/^\/+\s*/, '').trim();
      if (text) return text.slice(0, 120);
    }
    // stop at the first non-blank, non-comment line — the title is a leading comment
    if (line && !line.startsWith('//')) break;
  }
  return null;
}

/**
 * Derive a fallback title + description when the agent omits them, so a recipe is
 * ALWAYS captured. Preference: the script's first `//` comment for the title,
 * else the sorted tool-set ("recipe: <tools>"); the description names the tools.
 */
export function deriveTitleDescription(
  script: string,
  toolsUsed: string[],
  given: { title?: string; description?: string },
): { title: string; description: string } {
  const toolList = toolsUsed.length > 0 ? toolsUsed.join(', ') : 'no tools';
  const title =
    given.title?.trim() ||
    firstCommentTitle(script) ||
    (toolsUsed.length > 0 ? `recipe: ${toolsUsed.join(' + ')}`.slice(0, 120) : 'untitled recipe');
  const description =
    given.description?.trim() || `auto-captured recipe: calls ${toolList}`;
  return { title, description };
}

export interface CaptureRecipeDeps {
  /** PG handle (caller passes getOrgPg().sql — RLS-bypass; the store filters by workspace). */
  sql: import('postgres').Sql;
  /** Resolve the embedding plus its exact prose-space identity. */
  embed: (text: string) => Promise<{
    vector: number[];
    mode: EmbedderMode;
    profile: ProseProfileSelection;
  } | null>;
  /** harness → home-hive slug (the sharing boundary), or null. */
  resolveHive: (workspaceId: string, harness: string) => Promise<string | null>;
  log?: (msg: string) => void;
}

export interface CaptureRecipeInput {
  script: string;
  workspaceId: string;
  harness: string | null;
  /** The acting agent's coord ownerId (distinct-agent + author attribution). */
  ownerId: string | null;
  /** The acting agent's role. */
  role: string | null;
  /** Agent-supplied title/description (optional — derived when absent). */
  title?: string;
  description?: string;
  /** Exact versioned declarations captured with this script revision. */
  bindingSchema?: RecipeBindingSchemaV1;
  capabilityManifest?: CapabilityManifestV1;
  tags?: string[];
  /** All projected tools + the role-scoped allow-list (for tools_used extraction). */
  tools: readonly ProjectedTool[];
  allowed?: ReadonlySet<string>;
  /** P-013 trace for the same execution; stored on the recipe-run row. */
  executionTrace?: NormalizedExecutionTrace | null;
}

export interface CaptureRecipeResult {
  /** The created candidate, or the existing candidate selected by trace dedup. */
  row: CodeRecipeRow;
  /** How this execution was attached to the candidate. */
  disposition: RecipeCaptureDisposition;
  /** Similarity for a near-match reuse; null for exact/new captures. */
  matchedSimilarity: number | null;
  /**
   * Top-N prior recipes that ALREADY do something similar (semantic + structural
   * dedup, P-004 / D-003). SOFT/ADVISORY — surfaced in the code:run result so the
   * LLM can choose `recipes:run(<id>)` next time instead of re-authoring. Empty
   * when nothing was similar (or the search degraded). EXCLUDES the just-upserted
   * recipe itself.
   */
  similarRecipes: SimilarRecipe[];
}

export const RECIPE_CAPTURE_NEAR_DUPLICATE_THRESHOLD = 0.8;

export type RecipeCaptureDisposition =
  | 'created'
  | 'exact-fingerprint-reuse'
  | 'near-similarity-reuse';

export interface RecipeCaptureTarget {
  id: string;
  disposition: RecipeCaptureDisposition;
  matchedSimilarity: number | null;
}

/** Deterministic P-014 target selection: exact structure, then strongest near
 * match above the existing merge threshold, otherwise a new candidate. */
export function selectRecipeCaptureTarget(input: {
  proposedId: string;
  exactRecipeId?: string | null;
  similarRecipes: ReadonlyArray<Pick<SimilarRecipe, 'id' | 'similarity'>>;
  nearDuplicateThreshold?: number;
}): RecipeCaptureTarget {
  if (input.exactRecipeId) {
    return {
      id: input.exactRecipeId,
      disposition: 'exact-fingerprint-reuse',
      matchedSimilarity: null,
    };
  }

  const threshold = input.nearDuplicateThreshold ?? RECIPE_CAPTURE_NEAR_DUPLICATE_THRESHOLD;
  const near = input.similarRecipes
    .filter((candidate) => candidate.id !== input.proposedId && candidate.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id))[0];
  if (near) {
    return {
      id: near.id,
      disposition: 'near-similarity-reuse',
      matchedSimilarity: near.similarity,
    };
  }

  return { id: input.proposedId, disposition: 'created', matchedSimilarity: null };
}

/**
 * Capture a successful code:run as a recipe AND surface near-duplicates (P-004).
 * ALWAYS best-effort: any failure is logged + swallowed so capture never breaks
 * the run. Returns the saved row + the top similar recipes (or null when capture
 * was skipped/failed).
 *
 * The embedding is computed ONCE (`title\ndescription`, 384-dim) and reused for
 * BOTH the dedup search and the upsert. Dedup runs BEFORE the upsert — excluding
 * the new recipe's id — so a re-run of an existing recipe doesn't match itself,
 * and the result reflects the PRIOR corpus. Dedup is SOFT: a search failure
 * degrades to `similarRecipes: []` and never blocks the capture/run.
 */
export async function captureRecipe(
  deps: CaptureRecipeDeps,
  input: CaptureRecipeInput,
): Promise<CaptureRecipeResult | null> {
  const log = deps.log ?? (() => {});
  try {
    await ensureParseCheckReady(); // lazy-load the TS compiler before extractToolsUsed→checkScript (kept out of the eager client bundle)
    const toolsUsed = safe(() => extractToolsUsed(input.script, input.tools, input.allowed), []);
    const { title, description } = deriveTitleDescription(input.script, toolsUsed, {
      title: input.title,
      description: input.description,
    });
    // P-003 collision-fix: explicit title ⇒ slug; auto-derived ⇒ slug+scriptHash.
    const id = recipeId(title, description, input.script, { title: input.title });

    // P-002 (pot-scope-all-learnings): the shared resolution order — explicit →
    // harness's owning pot → the harness itself when it IS a hive home → env home
    // pot → null. deps.resolveHive stays the injected registry-read step.
    const potSlug = await resolveLearningPotSlug({
      workspaceId: input.workspaceId,
      harnessSlug: input.harness,
      resolveHive: deps.resolveHive,
    });

    // Compute the embedding ONCE and reuse it for both dedup + the upsert.
    const embedded = await deps.embed(`${title}\n${description}`).catch(() => null);
    const embedding = embedded?.vector ?? null;

    // P-014: exact normalized structure reuses the established active candidate.
    // This indexed lookup rides the P-013 run ledger; failure remains soft so a
    // capture still falls through to hybrid matching / creation.
    let exactRecipe: CodeRecipeRow | null = null;
    if (input.executionTrace?.structuralFingerprint) {
      try {
        exactRecipe = await findActiveRecipeByStructuralFingerprint(
          deps.sql,
          input.executionTrace.structuralFingerprint,
        );
      } catch (err) {
        log(`code:run recipe fingerprint dedup failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
      }
    }

    // DEDUP (SOFT, P-004/P-014): rank prior recipes before creating anything.
    // When exact structure already picked a target, exclude that candidate from
    // the advisory search so the remaining results stay useful.
    let similarRecipes: SimilarRecipe[] = [];
    try {
      const sourceAuthority = await deriveRecipeAuthority(input.script);
      similarRecipes = await searchSimilarRecipes(
        deps.sql,
        {
          title,
          description,
          toolsUsed,
          embedding,
          embeddingMode: embedded?.mode ?? null,
          embeddingProfile: embedded?.profile ?? null,
          excludeId: exactRecipe?.id ?? id,
          limit: 5,
          recommendationContext: recipeAuthorityContextFromDescriptor(sourceAuthority, {
            workspace: input.workspaceId,
            harness: input.harness,
          }),
        },
        { log },
      );
    } catch (err) {
      log(`code:run recipe dedup failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    }

    let target = selectRecipeCaptureTarget({
      proposedId: id,
      exactRecipeId: exactRecipe?.id,
      similarRecipes,
    });

    // Reusing a cross-title exact/near candidate must not overwrite its canonical
    // title/script with the latest concrete binding values. The execution row is
    // the update: it moves usage counters and retains the new normalized trace.
    // A candidate can disappear between the advisory read and this fetch; fall
    // back to creating the proposed candidate instead of losing capture.
    let row = target.disposition === 'created'
      ? null
      : exactRecipe?.id === target.id
        ? exactRecipe
        : await getRecipe(deps.sql, target.id);
    if (!row || row.status !== 'active') {
      target = { id, disposition: 'created', matchedSimilarity: null };
      row = await upsertRecipe(deps.sql, {
        id,
        title,
        description,
        script: input.script,
        bindingSchema: input.bindingSchema,
        capabilityManifest: input.capabilityManifest,
        authorRole: input.role,
        toolsUsed,
        tags: input.tags,
        embedding,
        embeddingMode: embedded?.mode ?? null,
        embeddingProfile: embedded?.profile ?? null,
        createdBy: input.ownerId,
        potSlug,
      });
    }

    await recordRecipeRun(deps.sql, {
      recipeId: row.id,
      workspaceId: input.workspaceId,
      potSlug,
      agentOwner: input.ownerId,
      agentRole: input.role,
      success: true,
      reused: target.disposition !== 'created',
      executionTrace: input.executionTrace,
    });

    // P-004: don't SURFACE the selected target (already represented by
    // disposition/recipeId) or low-value wrappers. They still capture and count;
    // they simply do not pollute the advisory reuse nudge.
    similarRecipes = similarRecipes.filter((candidate) =>
      candidate.id !== row.id && !isLowValueRecipe(candidate));

    // Live-update the /admin/recipes dashboard (code-recipes-2026-06-21 P-009):
    // a fresh capture / re-run shifts the recipe list AND the candidate worklist,
    // so invalidate both sync queries. Best-effort + lazy-imported so the pure
    // capture helper stays PG-only and unit-testable without the sync-sse bus.
    await notifyRecipesChanged(log);

    return {
      row,
      disposition: target.disposition,
      matchedSimilarity: target.matchedSimilarity,
      similarRecipes,
    };
  } catch (err) {
    log(`code:run recipe capture failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
    return null;
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Fire the sync-invalidation for BOTH recipe dashboard queries after a recipe
 * write (capture, sweep, or merge) commits — the SINGLE invalidate point so every
 * write site stays consistent (code-recipes-2026-06-21 P-009). A list change can
 * also change the candidate worklist (a swept/merged recipe drops out, a re-run
 * crosses the promote threshold), so both names are invalidated together. Lazy
 * import + best-effort: a missing/erroring bus must NEVER break the underlying
 * write (the capture path is already wrapped in try/catch; the tools call this
 * AFTER their commit returns).
 */
export async function notifyRecipesChanged(log: (msg: string) => void = () => {}): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('codeRecipes');
    await notifySyncInvalidate('recipeCandidates');
  } catch (err) {
    log(`recipe sync-invalidate failed (swallowed): ${(err as Error)?.message ?? String(err)}`);
  }
}
