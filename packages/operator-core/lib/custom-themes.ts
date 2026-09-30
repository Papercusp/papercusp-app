/**
 * Custom-theme persistence — a per-workspace JSON file (D-1: "save the theme
 * locally to a file"). Lives at `papercuspPath('themes', 'custom.json')`
 * (`~/.papercusp-workspaces/<id>/.papercusp/themes/custom.json`), so a user can
 * inspect, hand-edit, or copy theme files between machines.
 *
 * File shape: `{ "themes": CustomTheme[] }`. Every row is re-validated on read
 * (the file is user-editable) and on write; rows that fail validation are
 * dropped on read with a warning rather than corrupting the whole list.
 *
 * NOTE on the storage policy: the repo defaults durable state to Postgres. This
 * is a deliberate, documented exception per the explicit "to a file" request —
 * see docs/plans/personalization-theme-selector-2026-05-30.md (D-1).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { papercuspPath } from './papercusp-root';
import {
  validateCustomTheme,
  CustomThemeValidationError,
  type CustomTheme,
} from './theme-tokens';
import { listInstalledThemes } from './cupboard/theme-store';

function themesFile(): string {
  return papercuspPath('themes', 'custom.json');
}

export async function listCustomThemes(): Promise<CustomTheme[]> {
  let text: string;
  try {
    text = await readFile(themesFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('[custom-themes] custom.json is not valid JSON — treating as empty');
    return [];
  }
  const rows = Array.isArray((parsed as { themes?: unknown })?.themes)
    ? ((parsed as { themes: unknown[] }).themes)
    : [];
  const out: CustomTheme[] = [];
  for (const row of rows) {
    try {
      out.push(validateCustomTheme(row));
    } catch (err) {
      console.warn(`[custom-themes] dropping invalid theme row: ${(err as Error).message}`);
    }
  }
  return out;
}

/** One catalog for every runtime/UI consumer. Locally-authored definitions stay
 * first and installed packages retain provenance metadata. */
export async function listThemeCatalog(): Promise<CustomTheme[]> {
  return [...await listCustomThemes(), ...listInstalledThemes()];
}

async function writeAll(themes: CustomTheme[]): Promise<void> {
  const file = themesFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ themes }, null, 2), 'utf8');
  await rename(tmp, file); // atomic replace
}

/** Upsert a theme by id. Validates first; throws CustomThemeValidationError. */
export async function saveCustomTheme(input: unknown): Promise<CustomTheme> {
  const theme = validateCustomTheme(input);
  const themes = await listCustomThemes();
  const idx = themes.findIndex((t) => t.id === theme.id);
  if (idx >= 0) themes[idx] = theme;
  else themes.push(theme);
  await writeAll(themes);
  return theme;
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const themes = await listCustomThemes();
  const next = themes.filter((t) => t.id !== id);
  if (next.length !== themes.length) await writeAll(next);
}

export { CustomThemeValidationError };
