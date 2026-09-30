/** Publish a locally-authored color theme as a Cupboard `theme` listing. */
import { listCustomThemes } from '../custom-themes';
import { publishListingToCupboard } from './publish-listing';
import { fetchGithubRepoMeta, parseGithubRemote } from './resolve-repo-coords';
import {
  writeThemePackageDir,
  type WrittenThemePackage,
} from './theme-store';
import type { BuiltinThemeId, CustomTheme, ThemeColorScheme } from '../theme-tokens';

export interface PublishThemeInput {
  themeId: string;
  github_url: string;
  listing_ref?: string;
  project_ref?: string;
  version?: string;
  baseTheme?: BuiltinThemeId;
  colorScheme?: ThemeColorScheme;
  title?: string;
  description?: string;
  exportOnly?: boolean;
}

export interface PublishThemeDeps {
  listThemes: () => Promise<CustomTheme[]>;
  writePackage: typeof writeThemePackageDir;
  fetchRepo: typeof fetchGithubRepoMeta;
  publish: typeof publishListingToCupboard;
}

const defaults: PublishThemeDeps = {
  listThemes: listCustomThemes,
  writePackage: writeThemePackageDir,
  fetchRepo: fetchGithubRepoMeta,
  publish: publishListingToCupboard,
};

export type PublishThemeResult =
  | { ok: true; exportedOnly: boolean; export: WrittenThemePackage; listing?: unknown }
  | { ok: false; status: number; error: string; detail?: unknown; upstream_status?: number };

export async function publishThemeToCupboard(
  input: PublishThemeInput,
  deps: PublishThemeDeps = defaults,
): Promise<PublishThemeResult> {
  const themeId = String(input.themeId ?? '').trim();
  const theme = (await deps.listThemes()).find((candidate) => candidate.id === themeId);
  if (!theme) return { ok: false, status: 404, error: `local theme "${themeId}" not found` };

  const githubUrl = String(input.github_url ?? '').trim();
  const repo = parseGithubRemote(githubUrl);
  if (!repo) return { ok: false, status: 400, error: `invalid github_url "${githubUrl}"` };
  const listingRef = (input.listing_ref ?? theme.id).trim();

  let written: WrittenThemePackage;
  try {
    written = deps.writePackage(theme, {
      ref: listingRef,
      version: input.version,
      baseTheme: input.baseTheme,
      colorScheme: input.colorScheme,
      description: input.description,
      source: githubUrl,
    });
  } catch (error) {
    return { ok: false, status: 422, error: error instanceof Error ? error.message : String(error) };
  }
  if (input.exportOnly === true) return { ok: true, exportedOnly: true, export: written };

  const meta = await deps.fetchRepo(repo.owner, repo.repo);
  if (!meta) return { ok: false, status: 422, error: `could not resolve GitHub repo ${repo.owner}/${repo.repo}` };
  const result = await deps.publish({
    listing_kind: 'theme',
    listing_ref: listingRef,
    ...(input.project_ref ? { project_ref: input.project_ref } : {}),
    github_repository_id: meta.id,
    github_owner: repo.owner,
    github_name: repo.repo,
    github_url: meta.html_url || githubUrl,
    title: input.title?.trim() || theme.label,
    description: input.description?.trim() || '',
  });
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: result.error,
      detail: result.detail,
      upstream_status: result.upstream_status,
    };
  }
  return { ok: true, exportedOnly: false, export: written, listing: result.data };
}
