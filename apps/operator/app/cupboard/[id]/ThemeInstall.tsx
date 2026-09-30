'use client';

import { useMemo, useState } from 'react';
import { Copy, Loader2, Palette, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';
import {
  CUSTOM_PREFIX,
  DEFAULT_THEME_ID,
  applyCustomThemes,
  useActiveTheme,
  useThemeCatalog,
  writeActiveTheme,
  type CustomTheme,
} from '@/lib/theme';
import { Button } from '../../harness/Button';
import RouteLink from '../../_components/RouteLink';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';

type BusyAction = 'install' | 'update' | 'remove' | null;

interface ThemeLifecycleResponse extends CustomTheme {
  ok?: boolean;
  activeThemeId?: string;
  operation?: 'install' | 'update' | 'no-op';
  error?: string;
  detail?: string;
}

function normalizeRepo(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\.git\/?$/, '').replace(/\/+$/, '');
}

function listingRepoUrl(listing: HarnessListing): string {
  if (listing.github_url) return listing.github_url;
  if (listing.github_owner && listing.github_name) {
    return `https://github.com/${listing.github_owner}/${listing.github_name}`;
  }
  return listing.github_repo ? `https://github.com/${listing.github_repo}` : '';
}

/** Match by source + within-repo ref, never by author-controlled display name.
 * This preserves distinct installs when two publishers use the same theme id. */
export function findInstalledThemeForListing(
  listing: HarnessListing,
  themes: readonly CustomTheme[],
): CustomTheme | null {
  const source = normalizeRepo(listingRepoUrl(listing));
  const listingRef = listing.listing_ref?.trim() ?? '';
  if (!source || !listingRef) return null;
  return themes.find((theme) => (
    theme.installed === true &&
    theme.listingRef === listingRef &&
    normalizeRepo(theme.source) === source
  )) ?? null;
}

function ValidatedThemePreview({ theme }: { theme: CustomTheme }) {
  const themeId = `${CUSTOM_PREFIX}${theme.id}`;
  return (
    <div
      data-testid="cupboard-theme-preview"
      data-theme={themeId}
      aria-label={`Validated palette preview for ${theme.label}`}
      style={{
        minWidth: 180,
        flex: '1 1 220px',
        background: 'var(--bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: RADIUS.md,
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ height: 9, width: '58%', borderRadius: 3, background: 'var(--fg)' }} />
      <div style={{ height: 7, width: '84%', borderRadius: 3, background: 'var(--fg-mute)' }} />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{ padding: '3px 9px', borderRadius: 999, background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: 10, fontWeight: 700 }}>
          Accent
        </span>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--good)' }} />
        <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--warn)' }} />
        <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--bad)' }} />
      </div>
    </div>
  );
}

/** Theme lifecycle panel. Installation is deliberately separate from selection:
 * Install/Update only change the catalog; Use theme is the sole preference write. */
export default function ThemeInstall({ listing }: { listing: HarnessListing }) {
  const { themes, invalidate } = useThemeCatalog();
  const activeTheme = useActiveTheme();
  const catalogTheme = useMemo(() => findInstalledThemeForListing(listing, themes), [listing, themes]);
  const [optimisticTheme, setOptimisticTheme] = useState<CustomTheme | null>(null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const installed = removed ? null : (optimisticTheme ?? catalogTheme);
  const installedId = installed ? `${CUSTOM_PREFIX}${installed.id}` : null;
  const isActive = installedId !== null && activeTheme === installedId;

  const install = async (update: boolean) => {
    if (busy) return;
    setBusy(update ? 'update' : 'install');
    try {
      const response = await fetch('/api/cupboard/install-theme', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id, ...(update ? { update: true } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as ThemeLifecycleResponse;
      if (!response.ok || body.ok === false || !body.id || !body.label || !body.tokens) {
        toast.error(`${update ? 'Update' : 'Install'} failed: ${body.error ?? `HTTP ${response.status}`}${body.detail ? ` — ${body.detail}` : ''}`);
        return;
      }
      const next = body as CustomTheme;
      setRemoved(false);
      setOptimisticTheme(next);
      applyCustomThemes([...themes.filter((theme) => theme.id !== next.id), next]);
      invalidate();
      toast.success(
        body.operation === 'no-op'
          ? `Theme "${body.label}" is already up to date.`
          : `${update ? 'Updated' : 'Installed'} theme "${body.label}"${body.version ? ` v${body.version}` : ''}.`,
      );
    } catch (error) {
      toast.error(`${update ? 'Update' : 'Install'} crashed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!installed || busy) return;
    setBusy('remove');
    try {
      const response = await fetch(`/api/themes/${encodeURIComponent(installed.id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        toast.error(`Remove failed: ${body.error ?? `HTTP ${response.status}`}`);
        return;
      }
      if (isActive) writeActiveTheme(DEFAULT_THEME_ID);
      setRemoved(true);
      setOptimisticTheme(null);
      applyCustomThemes(themes.filter((theme) => theme.id !== installed.id));
      invalidate();
      toast.success(`Removed theme "${installed.label}"${isActive ? ' and restored Blue frost' : ''}.`);
    } catch (error) {
      toast.error(`Remove crashed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const useTheme = () => {
    if (!installedId || !installed) return;
    writeActiveTheme(installedId);
    toast.success(`Theme set to ${installed.label}`);
  };

  return (
    <section
      data-testid="cupboard-theme-install"
      data-installed={installed ? 'true' : 'false'}
      style={{
        marginTop: SIZES.md,
        padding: SIZES.md,
        background: COLORS.surface,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
      }}
    >
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', fontFamily: FONTS.ui, color: COLORS.text, fontWeight: 650 }}>
        <Palette size={15} /> Theme package
      </div>

      {installed ? (
        <>
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', flexWrap: 'wrap', marginTop: 10 }}>
            <ValidatedThemePreview theme={installed} />
            <div style={{ flex: '1 1 250px', fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
              <strong style={{ display: 'block', color: COLORS.text, fontSize: 14 }}>{installed.label}</strong>
              <span data-testid="cupboard-theme-version">Installed{installed.version ? ` · v${installed.version}` : ''}</span>
              {listing.release_version && (
                <span style={{ display: 'block' }}>Cupboard release · v{listing.release_version}</span>
              )}
              {installed.source && (
                <span data-testid="cupboard-theme-source" style={{ display: 'block', overflowWrap: 'anywhere' }}>{installed.source}</span>
              )}
              <p style={{ margin: '7px 0 0' }}>
                Package tokens passed the semantic-token and CSS-safety validators. Editing creates a local copy; updates never overwrite it.
              </p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <Button size="lg" variant="primary" onClick={useTheme} disabled={isActive || busy !== null}>
              <Palette size={14} /> {isActive ? 'In use' : 'Use theme'}
            </Button>
            <Button size="lg" variant="accent" onClick={() => void install(true)} disabled={busy !== null}>
              {busy === 'update' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <RefreshCw size={14} />}
              {busy === 'update' ? 'Updating…' : 'Update'}
            </Button>
            <Button asChild size="lg" variant="accent">
              <RouteLink href={`/settings/personalization?themeEdit=${encodeURIComponent(`copy:${installedId}`)}`}>
                <Copy size={14} /> Edit as copy
              </RouteLink>
            </Button>
            <Button size="lg" variant="destructive" onClick={() => void remove()} disabled={busy !== null}>
              {busy === 'remove' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={14} />}
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p style={{ margin: '8px 0 0', fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
            Installs inert, validated semantic color tokens into this workspace. Installation does not switch your current theme.
          </p>
          <Button
            size="lg"
            variant="primary"
            onClick={() => void install(false)}
            disabled={busy !== null}
            style={{ marginTop: 10 }}
          >
            {busy === 'install' ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Palette size={14} />}
            {busy === 'install' ? 'Installing theme…' : 'Install theme'}
          </Button>
        </>
      )}
    </section>
  );
}
