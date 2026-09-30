/**
 * Thin saved-recipe backend adapter for the unified orchestration facade.
 *
 * The existing recipes:* family remains canonical for storage, search, exact
 * revision/authority continuations, run counters, and soft dedup. This adapter
 * deliberately owns none of those concerns: every operation re-dispatches the
 * corresponding projected tool under the current caller. In particular,
 * recipes:run then enters bindCurrentCallerDispatch for every nested call, so a
 * saved recipe carries source metadata but never its author's privilege.
 */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { RecipeAuthorityContext, RecipeAuthorityMetadata, RecipeAuthorityProof } from '../../recipe-authority';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';

export type SavedRecipeAuthority = RecipeAuthorityProof | RecipeAuthorityMetadata;

export interface SavedRecipeSelector {
  id: string;
  /** Optional caller pin. A mismatch with recipes:get's current revision fails before recipes:run. */
  revision?: string;
  /** Exact recipes:search proof or recipes:get metadata; never reconstructed from author data. */
  authority?: SavedRecipeAuthority;
}

export interface SavedRecipeSearchInput {
  query: string;
  limit?: number;
  context?: Omit<RecipeAuthorityContext, 'workspace'>;
}

export interface SavedRecipeBindings {
  values: Record<string, unknown>;
}

export interface SavedRecipeRunInput {
  recipe: SavedRecipeSelector;
  bindings?: SavedRecipeBindings;
  timeoutSec?: number;
  /** Compatibility-only preview flag inherited from recipes:run. */
  dryRun?: boolean;
}

export type SavedRecipePreflightErrorCode = 'recipe_not_found' | 'recipe_authority_stale';

export interface SavedRecipePreflightFailure {
  ok: false;
  phase: 'preflight';
  executed: false;
  error: {
    code: SavedRecipePreflightErrorCode;
    message: string;
    path?: string;
  };
}

export interface SavedRecipeInspection {
  ok: true;
  recipe: Record<string, unknown>;
  /** Exact continuation accepted by recipes:run for the revision just inspected. */
  continuation: {
    id: string;
    revision: string;
    authority: SavedRecipeAuthority;
  };
}

export interface SavedRecipeAdapter {
  /** Lossless delegation: preserves recipes:search's exact runArgs authority proof. */
  search(args: SavedRecipeSearchInput): Promise<unknown>;
  inspect(recipe: SavedRecipeSelector): Promise<SavedRecipeInspection | SavedRecipePreflightFailure>;
  /** Returns recipes:run's canonical reuse envelope unchanged. */
  run(args: SavedRecipeRunInput): Promise<unknown | SavedRecipePreflightFailure>;
}

type RecipeGetItem = {
  ok: boolean;
  id: string;
  error?: string;
  recipe?: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function preflightFailure(
  code: SavedRecipePreflightErrorCode,
  message: string,
  path?: string,
): SavedRecipePreflightFailure {
  return {
    ok: false,
    phase: 'preflight',
    executed: false,
    error: { code, message, ...(path ? { path } : {}) },
  };
}

function parseRecipeGetItem(value: unknown, id: string): RecipeGetItem {
  const envelope = asRecord(value);
  const results = envelope?.results;
  if (!Array.isArray(results)) {
    throw new Error('saved-recipe adapter: recipes:get returned an invalid envelope');
  }
  const item = results.find((candidate) => asRecord(candidate)?.id === id);
  const record = asRecord(item);
  if (!record || typeof record.ok !== 'boolean') {
    throw new Error(`saved-recipe adapter: recipes:get omitted result for ${id}`);
  }
  return record as RecipeGetItem;
}

function authorityRevision(authority: unknown): string | null {
  const revision = asRecord(authority)?.revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

/**
 * Dependency-injected constructor used by focused tests and later orchestrate:*
 * composition. Production callers should normally use savedRecipeAdapterFor.
 */
export function createSavedRecipeAdapter(call: InnerCall): SavedRecipeAdapter {
  const inspect = async (
    selector: SavedRecipeSelector,
  ): Promise<SavedRecipeInspection | SavedRecipePreflightFailure> => {
    const raw = await call('recipes:get', { id: selector.id });
    const item = parseRecipeGetItem(raw, selector.id);
    if (!item.ok) {
      if (item.error === 'not_found') {
        return preflightFailure(
          'recipe_not_found',
          `saved recipe ${selector.id} does not exist or is no longer active`,
          'recipe.id',
        );
      }
      throw new Error(`saved-recipe adapter: recipes:get failed for ${selector.id}: ${item.error ?? 'unknown error'}`);
    }

    const recipe = item.recipe;
    if (!recipe) {
      throw new Error(`saved-recipe adapter: recipes:get returned no recipe for ${selector.id}`);
    }
    const storedAuthority = recipe.authority;
    const currentRevision = authorityRevision(storedAuthority);
    if (!currentRevision) {
      throw new Error(`saved-recipe adapter: recipes:get returned no revision for ${selector.id}`);
    }

    if (selector.revision && selector.revision !== currentRevision) {
      return preflightFailure(
        'recipe_authority_stale',
        `saved recipe ${selector.id} revision changed; inspect/search again before running`,
        'recipe.revision',
      );
    }
    const suppliedAuthorityRevision = authorityRevision(selector.authority);
    if (selector.authority && suppliedAuthorityRevision !== currentRevision) {
      return preflightFailure(
        'recipe_authority_stale',
        `saved recipe ${selector.id} authority proof is stale; inspect/search again before running`,
        'recipe.authority.revision',
      );
    }

    // Keep the caller's search proof byte-for-byte/object-for-object when supplied.
    // Otherwise the current recipes:get metadata is itself an accepted recipes:run
    // continuation, and recipes:run still revalidates it against the live caller.
    const authority = selector.authority ?? (storedAuthority as SavedRecipeAuthority);
    return {
      ok: true,
      recipe,
      continuation: { id: selector.id, revision: currentRevision, authority },
    };
  };

  return {
    search: (args) => call('recipes:search', args),
    inspect,
    async run(args) {
      const inspected = await inspect(args.recipe);
      if (!inspected.ok) return inspected;

      return call('recipes:run', {
        id: inspected.continuation.id,
        authority: inspected.continuation.authority,
        ...(args.bindings === undefined ? {} : { bindings: args.bindings }),
        ...(args.timeoutSec === undefined ? {} : { timeoutSec: args.timeoutSec }),
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
      });
    },
  };
}

/**
 * Bind every recipes:* adapter call to the current projected-tool dispatcher.
 * This is the production entry point: no direct store access and no author
 * principal can cross the boundary.
 */
export function savedRecipeAdapterFor(ctx: UnifiedToolContext): SavedRecipeAdapter {
  return createSavedRecipeAdapter(inProcessCall(ctx));
}
