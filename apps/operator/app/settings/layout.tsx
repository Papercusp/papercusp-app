'use client';

import { useEffect, useMemo, useState } from 'react';
// The Settings stylesheet rides WITH the surface (like dev/dev.css from
// dev/layout.tsx): every host that mounts SettingsLayout natively — the operator
// and the cloud portal through @papercusp/operator-ui/surfaces — gets the
// .pc-settings-* rules without importing the operator's whole globals.css
// (EI-22432328055190066, portal-parity-with-papercusp-2026-09-03 P-005).
import './settings.css';
import { usePathname, useRouter } from '@/lib/router-compat/navigation';
import RouteLink from '../_components/RouteLink';
import { Select } from '../harness/Select';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { useLexicon } from '@/lib/useLexicon';

/**
 * Settings paths that exist only behind a flag. The nav below hides a gated
 * link while its flag is off; the operator-vite route for each gated path
 * enforces the same flag in `beforeLoad` (`requireFlag`), and a router-less
 * host (`SettingsSurface`) reads this map to apply the same gate to the page
 * it mounts — one map, three enforcement points.
 */
export const SETTINGS_PATH_FLAGS: Record<string, FlagKey> = {
  '/settings/publishing': FLAGS.CLOUDFLARE_PUBLISH,
  '/settings/prompt-studio': FLAGS.PROMPT_STUDIO,
  '/settings/autonomy':   FLAGS.MUG_AUTONOMY_SETTINGS,
  '/settings/storage':    FLAGS.STORAGE_SETTINGS,
  '/settings/pot-customization': FLAGS.BLUEPRINT_AWARE_SETTINGS,
  '/settings/p2p':        FLAGS.P2P,
};

interface SettingsLink {
  readonly href: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly advanced?: boolean;
}

interface SettingsGroup {
  readonly label: string;
  readonly links: readonly SettingsLink[];
}

// The GUI Setup Wizard is DEMOTED to Advanced (agent-first-onboarding-2026-07-03
// P-010): first-run now lands on the agent-chat Onboarding Console (/onboarding,
// ONBOARDING_AGENT_FIRST), and the wizard survives as the fallback — reachable
// here and at /setup?force=1. Keep it listed (it is the no-pty / browser escape
// hatch), but not as the headline "Get started" entry.
// Exported for the WI-3449 regression test (settings-audit-nav.test.ts) — a
// plain-data unit test asserting the removed /settings/oracle +
// /settings/omp-integration nav entries never resurface.
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    label: 'Identity & devices',
    links: [
      { href: '/settings/profile', label: 'Profile', keywords: ['account', 'identity', 'email', 'display name', 'project directory'] },
      { href: '/settings/user', label: 'User preferences', keywords: ['user', 'me', 'override', 'password', 'session', 'logout'] },
      { href: '/settings/personal-vault', label: 'Personal Vault', keywords: ['personal', 'vault', 'gmail', 'calendar', 'contacts', 'takeout', 'facebook', 'instagram', 'x archive', 'private', 'local embeddings', 'grant', 'purge'] },
      { href: '/settings/remote-access', label: 'Remote access', keywords: ['remote', 'phone', 'mobile', 'device', 'pair', 'qr', 'workspace', 'app', 'api key', 'service key', 'connector', 'claude', 'chatgpt', 'mcp', 'tunnel', 'kill switch', 'revoke'] },
      { href: '/settings/publishing', label: 'Publishing', keywords: ['publish', 'preview', 'subdomain', 'public', 'marketplace'] },
    ],
  },
  {
    label: 'Assistants',
    links: [
      { href: '/settings/operator', label: 'Papercup agent', keywords: ['operator', 'agent', 'prompt', 'budget', 'preferences', 'approvals'] },
      { href: '/settings/identities', label: 'Identities', keywords: ['identity', 'identities', 'persona', 'profession', 'role', 'stack', 'behavior', 'agent', 'switch', 'facet', 'practice', 'provider binding'] },
      { href: '/settings/autonomy', label: 'Autonomy', keywords: ['autonomy', 'policy', 'ceiling', 'graduated', 'mug', 'auto', 'auto-decide', 'risk', 'protected', 'lock', 'escalation'] },
      { href: '/settings/pot-customization', label: 'Pot customization', keywords: ['pot', 'hive', 'customization', 'override', 'blueprint', 'prompt', 'persona', 'role', 'scout', 'config', 'queen', 'brain', 'bee', 'cup', 'overwatch', 'su', 'tuning', 'per-hive', 'per-pot', 'domain'] },
      { href: '/settings/expert-routing', label: 'Expert routing', keywords: ['expert', 'experts', 'consult', 'get_feedback', 'feedback', 'router', 'routing', 'allowlist', 'allowed models', 'rank', 'ranking', 'recency', 'half-life', 'halflife', 'opus', 'fable', 'sol', 'astra', 'peer', 'ask'] },
      { href: '/settings/trust', label: 'Trusted users', keywords: ['trust', 'trusted', 'github', 'author', 'admission', 'auto-run', 'shared hive', 'security', 'grant', 'verified', 'remote'] },
      { href: '/settings/p2p', label: 'P2P work sharing', keywords: ['p2p', 'peers', 'work sharing', 'foreign work', 'grants', 'capability', 'opt-in', 'kill switch', 'kill-switch', 'attestation', 'device', 'fleet', 'budgets', 'allotment', 'delegate', 'observer', 'collaborator', 'operator grant'] },
      { href: '/settings/voice', label: 'Voice & speech', keywords: ['voice', 'speech', 'stt', 'tts', 'microphone', 'wake word', 'elevenlabs', 'openai', 'cartesia', 'deepgram'] },
    ],
  },
  {
    label: 'Keys & OAuth',
    links: [
      { href: '/settings/api-keys', label: 'API keys', keywords: ['credentials', 'keys', 'api key', 'anthropic', 'openai', 'github', 'google', 'zeroentropy', 'elevenlabs', 'cartesia', 'deepgram', 'picovoice'] },
      // 'login' / 'sign in' / 'chatgpt' / 'codex' live HERE, not on api-keys: the account
      // sign-in cards were removed from that page (default-deploy-account-2026-08-08 P-001),
      // so a settings search for "sign in" must land on the pool that actually holds logins.
      // Labelled "Inference" since inference-rename-and-provider-agnostic-default-2026-08-09 P-001.
      // The href keeps the `deploy-accounts` path (D-003: labels-only rename), and the old name
      // stays in `keywords` so anyone searching settings for "deploy accounts" still lands here.
      { href: '/settings/deploy-accounts', label: 'Inference', keywords: ['inference', 'deploy', 'deployment', 'deploy accounts', 'accounts', 'credentials', 'claude', 'chatgpt', 'codex', 'oauth', 'login', 'sign in', 'default account', 'setup-token', 'remote frame', 'per-machine', 'pool', 'rate limit'] },
    ],
  },
  {
    label: 'App preferences',
    links: [
      { href: '/settings/personalization', label: 'Personalization', keywords: ['visual effects', 'motion', 'theme', 'density', 'calm'] },
      { href: '/settings/shortcuts', label: 'Keyboard shortcuts', keywords: ['keyboard', 'shortcuts', 'hotkeys', 'bindings', 'commands'] },
    ],
  },
  {
    label: 'Advanced',
    links: [
      { href: '/settings/setup-wizard', label: 'Setup Wizard (classic)', keywords: ['setup', 'wizard', 'onboarding', 'first run', 'install', 'permissions', 'workspace', 'keys', 'login', 'pair', 'fallback', 'classic', 'gui'], advanced: true },
      { href: '/settings/user/memory', label: 'Memory', keywords: ['memory', 'mem0', 'recall', 'forget', 'embeddings', 'history', 'identity', 'preference', 'harness'], advanced: true },
      { href: '/settings/agent', label: 'AI backend', keywords: ['agent backend', 'claude', 'omp', 'models', 'roles', 'command'], advanced: true },
      { href: '/settings/omp', label: 'Oh-My-Pi (omp)', keywords: ['omp', 'oh my pi', 'web search', 'tavily', 'perplexity', 'brave', 'jina', 'kimi', 'exa', 'kagi', 'searxng', 'parallel', 'synthetic', 'hindsight', 'memory', 'thinking', 'compaction', 'engineer collaborator', 'omp-su', 'wrapper', 'mcp', 'integration'], advanced: true },
      // Plugins + Plugin tools were functional but UNREACHABLE — on disk, with working
      // operator-vite route stubs, yet absent from this nav and linked only from
      // plugins/page.tsx's own self-link (settings-audit 2026-07-09, owner: add to nav).
      { href: '/settings/plugins', label: 'Plugins', keywords: ['plugin', 'plugins', 'install', 'enable', 'disable', 'marketplace', 'extension', 'global'], advanced: true },
      { href: '/settings/plugins/tools', label: 'Plugin tools', keywords: ['plugin', 'tools', 'mcp', 'agent tools', 'permissions', 'config'], advanced: true },
      { href: '/settings/plugin-runtime', label: 'Plugin runtime', keywords: ['plugin', 'runtime', 'hooks', 'load errors', 'cache'], advanced: true },
      { href: '/settings/backups', label: 'Backups', keywords: ['backup', 'backups', 'kopia', 'snapshot', 'restore', 'retention', 'dedup'], advanced: true },
      { href: '/settings/storage', label: 'Storage', keywords: ['storage', 'disk', 'trim', 'prune', 'reclaim', 'cleanup', 'cache', 'usage', 'space', 'vacuum', 'transcripts', 'telemetry'], advanced: true },
      { href: '/settings/prompt-studio', label: 'Prompt Studio', keywords: ['prompt', 'studio', 'playbook', 'system prompt', 'psu', 'agent prompt', 'overlay', 'project guide', 'preview', 'collaborator'], advanced: true },
    ],
  },
];

const SETTINGS_LINKS = SETTINGS_GROUPS.flatMap((group) => group.links);

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const t = useLexicon();
  const [query, setQuery] = useState('');

  // The nav label is defined in a module-level const (SETTINGS_GROUPS), so the
  // product-vocabulary word is routed at render time — 'Hive customization' →
  // '{Pot} customization' (restore-pot-lexicon-public-release P-007). The
  // `keywords` array keeps 'hive' as a search alias, so the entry is still
  // discoverable under either lexicon.
  const labelFor = (link: SettingsLink): string =>
    link.href === '/settings/pot-customization' ? `${t('pot')} customization` : link.label;
  const [wizardProgress, setWizardProgress] = useState<{
    finishedAt: string | null;
    completed: number;
    total: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as {
          finished_at?: string;
          step_status?: Record<string, 'completed' | 'dismissed'>;
        };
        if (cancelled) return;
        const TOTAL = 12;
        const completed = Object.values(j.step_status ?? {}).filter(
          (s) => s === 'completed' || s === 'dismissed',
        ).length;
        setWizardProgress({
          finishedAt: j.finished_at ?? null,
          completed: Math.min(completed, TOTAL),
          total: TOTAL,
        });
      } catch { /* leave null */ }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const publishingEnabled = useFlag(FLAGS.CLOUDFLARE_PUBLISH);
  const promptStudioEnabled = useFlag(FLAGS.PROMPT_STUDIO);
  const autonomySettingsEnabled = useFlag(FLAGS.MUG_AUTONOMY_SETTINGS);
  const storageSettingsEnabled = useFlag(FLAGS.STORAGE_SETTINGS);
  const blueprintAwareSettingsEnabled = useFlag(FLAGS.BLUEPRINT_AWARE_SETTINGS);
  const p2pEnabled = useFlag(FLAGS.P2P);
  // /settings/autonomy is PERMANENTLY hidden (retire-mug-kettle-su-only-2026-08-09
  // P-011 / D-021, terminal step P-068 / D-098). It used to AND two gates:
  // MUG_AUTONOMY_SETTINGS (the pre-existing per-page kill-switch, ON by default)
  // and MUG_KETTLE_SYSTEM, which retired the tier the page steers. The latter is
  // now DELETED and the retirement is permanent, so the entry is simply `false` —
  // the page edits Queen/Mug ceilings that no decider consults any more.
  //
  // This hides the NAV ENTRY only — `linkAllowed` filters SETTINGS_GROUPS and
  // nothing else, so the route stays reachable by URL. The page itself carries the
  // matching (now unconditional) early return; neither half is sufficient alone.

  // Keys are FlagKey values; this is the subset of flags that gate a settings path
  // (SETTINGS_PATH_FLAGS), not an exhaustive map — so `Record<string, boolean>`, not
  // `Record<FlagKey, boolean>` (which would (wrongly) require every flag).
  const flagEnabled: Record<string, boolean> = {
    [FLAGS.CLOUDFLARE_PUBLISH]: publishingEnabled,
    [FLAGS.PROMPT_STUDIO]: promptStudioEnabled,
    [FLAGS.MUG_AUTONOMY_SETTINGS]: false,
    [FLAGS.STORAGE_SETTINGS]: storageSettingsEnabled,
    [FLAGS.BLUEPRINT_AWARE_SETTINGS]: blueprintAwareSettingsEnabled,
    [FLAGS.P2P]: p2pEnabled,
    [FLAGS.HARNESS_PHASES]: true,
  };

  const linkAllowed = (href: string): boolean => {
    const flag = SETTINGS_PATH_FLAGS[href];
    return flag ? flagEnabled[flag] : true;
  };

  const filteredGroups = SETTINGS_GROUPS
    .map((group) => ({ ...group, links: group.links.filter((l) => linkAllowed(l.href)) }))
    .filter((group) => group.links.length > 0);

  const filteredLinks = filteredGroups.flatMap((g) => g.links);

  // Sort by href length desc so the most-specific match wins (e.g.
  // `/settings/user/memory` beats `/settings/user` on the memory page).
  const activeLink = [...filteredLinks]
    .sort((a, b) => b.href.length - a.href.length)
    .find((link) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    ?? filteredLinks[0];
  const normalizedQuery = query.trim().toLowerCase();

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return filteredGroups;
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return filteredGroups
      .map((group) => ({
        ...group,
        links: group.links.filter((link) => {
          const haystack = [
            group.label,
            link.label,
            link.href.replace('/settings/', ''),
            ...link.keywords,
            link.advanced ? 'advanced debug diagnostics' : '',
          ].join(' ').toLowerCase();
          return terms.every((term) => haystack.includes(term));
        }),
      }))
      .filter((group) => group.links.length > 0);
  }, [normalizedQuery]);

  return (
    <div className="pc-settings-shell">
      <aside className="pc-settings-nav" aria-label="Settings sections">
        <div className="pc-settings-nav-search">
          <label className="pc-settings-nav-search-label" htmlFor="settings-nav-search">Search</label>
          <input
            id="settings-nav-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings…"
            className="pc-settings-nav-search-input"
          />
        </div>

        <div className="pc-settings-mobile-picker">
          <Select
            value={activeLink.href}
            onChange={(href) => router.push(href)}
            ariaLabel="Settings page"
            options={SETTINGS_GROUPS.flatMap((group) =>
              group.links.map((link) => ({
                value: link.href,
                label: `${labelFor(link)} · ${group.label}`,
              })),
            )}
            triggerClassName="pc-settings-mobile-trigger"
            contentStyle={{ zIndex: 90 }}
          />
        </div>

        <nav className="pc-settings-nav-groups" aria-label="Settings pages">
          {visibleGroups.length === 0 ? (
            <div className="pc-settings-nav-empty">No settings match “{query.trim()}”.</div>
          ) : (
            visibleGroups.map((group) => (
              <div key={group.label} className="pc-settings-nav-group">
                <div className="pc-settings-nav-heading">{group.label}</div>
                {group.links.map((link) => {
                  const active = link.href === activeLink.href;
                  return (
                    <RouteLink
                      key={link.href}
                      href={link.href}
                      className="pc-settings-nav-link"
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="pc-settings-nav-link-label">{labelFor(link)}</span>
                      {link.advanced && <span className="pc-settings-nav-chip">Advanced</span>}
                      {link.href === '/settings/setup-wizard' && wizardProgress && (
                        <span
                          className="pc-settings-nav-chip pc-settings-nav-chip--progress"
                          data-finished={wizardProgress.finishedAt ? 'true' : 'false'}
                        >
                          {wizardProgress.finishedAt
                            ? '✓'
                            : `${wizardProgress.completed}/${wizardProgress.total}`}
                        </span>
                      )}
                    </RouteLink>
                  );
                })}
              </div>
            ))
          )}
        </nav>
      </aside>
      <section className="pc-settings-content">{children}</section>
    </div>
  );
}
