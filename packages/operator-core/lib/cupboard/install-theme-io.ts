import { promises as fs } from 'node:fs';
import { resolve, sep } from 'node:path';
import { cupboardGitDeps } from './install-io';
import type { ContentPinRef } from './install-self-describing-core';
import { resolveListingByKind } from './resolve-listing-by-kind';
import { installThemeFromCupboardCore, InstallThemeError } from './install-theme-core';
import {
  installedThemeRef,
  resolveInstalledTheme,
  userInstalledThemesDir,
  type InstalledTheme,
} from './theme-store';

export interface InstallThemeInput {
  listingId?: string;
  githubUrl?: string;
  listingRef?: string;
  update?: boolean;
}

export type InstallThemeResult =
  | { ok: true; result: InstalledTheme & { ok: true; ref: string; installedTo: string; operation: 'install' | 'update' | 'no-op' } }
  | { ok: false; status: number; error: string; detail?: string };

export async function installThemeFromCupboard(input: InstallThemeInput): Promise<InstallThemeResult> {
  let githubUrl = input.githubUrl?.trim() ?? '';
  let listingRef = input.listingRef?.trim() ?? '';
  let releaseVersion: string | undefined;
  // The Worker's publish-time content pin (P-002): present ⇒ the install fetches
  // exactly that commit and refuses content-address-mismatch. Only a listing carries
  // one; a direct githubUrl install is an unverified tip clone by construction.
  let pin: ContentPinRef | undefined;
  if (!githubUrl && input.listingId) {
    const resolved = await resolveListingByKind(String(input.listingId), 'theme');
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef ||= resolved.ref;
    releaseVersion = resolved.releaseVersion;
    pin = resolved.pin;
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };
  if (!listingRef) return { ok: false, status: 400, error: 'listingRef required' };

  const targetRef = installedThemeRef(githubUrl, listingRef);
  const existing = resolveInstalledTheme(targetRef);
  if (existing && releaseVersion && existing.version === releaseVersion && input.update !== true) {
    return { ok: true, result: { ...existing, ok: true, ref: targetRef, installedTo: existing.dir, operation: 'no-op' } };
  }
  if (existing && input.update !== true) {
    return { ok: false, status: 409, error: `theme "${existing.label}" is already installed; pass update:true to replace it` };
  }

  try {
    const installed = await installThemeFromCupboardCore(
      { githubUrl, listingRef, targetRef, replaceExisting: existing !== null && input.update === true, pin },
      cupboardGitDeps(),
    );
    return { ok: true, result: { ...installed, operation: existing ? 'update' : 'install' } };
  } catch (error) {
    if (error instanceof InstallThemeError) return { ok: false, status: error.status, error: error.message };
    return { ok: false, status: 500, error: 'install failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function removeInstalledTheme(idOrRef: string): Promise<{ ok: true; theme: InstalledTheme } | { ok: false; status: number; error: string }> {
  const theme = resolveInstalledTheme(idOrRef);
  if (!theme) return { ok: false, status: 404, error: `installed theme "${idOrRef}" not found` };
  const root = resolve(userInstalledThemesDir());
  const dir = resolve(theme.dir);
  if (!dir.startsWith(root + sep)) return { ok: false, status: 409, error: 'bundled themes cannot be removed' };
  const tombstone = `${dir}.removing-${process.pid}-${Date.now()}`;
  await fs.rename(dir, tombstone);
  await fs.rm(tombstone, { recursive: true, force: true });
  return { ok: true, theme };
}
