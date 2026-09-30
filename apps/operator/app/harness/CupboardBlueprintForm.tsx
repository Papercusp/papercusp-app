'use client';

/**
 * CupboardBlueprintForm — the picker's "New hive from a Comb blueprint" entry
 * (domain-generic-hive-architecture-2026-06-18 P-006 / Brief 3).
 *
 * A search-as-you-type panel over the public Comb listings index
 * (`GET /api/cupboard/listings?kind=blueprint`), filtered to hive-instantiable
 * blueprints (`blueprint_kind: 'hive'`, or unknown on a pre-009 worker — a
 * known `harness` blueprint can't be a hive home and is dropped). Pick a
 * blueprint → a small create form (slug · parent dir · knowledge pack) →
 * INSTANTIATE = install the blueprint into the installed tier
 * (`POST /api/cupboard/install-blueprint`) then stand up a new hive running it
 * (`POST /api/harness/pots` with the installed `blueprintId`). The tier-aware
 * resolver (P-014/D-006) then resolves that blueprint's prompts via the
 * installed tier — no per-id baking.
 *
 * Why raw fetch + debounce (not @papercusp/sync): the search is a TRANSIENT,
 * external Comb-index query, never invalidated by a write seam — the same
 * posture as the sibling EntryGithubSearchForm + the create/join POSTs in this
 * picker family. A ~300ms debounce + AbortController cancels stale keystrokes.
 *
 * Always creates a NEW top-level hive (a blueprint instantiation is never an
 * into-hive member) — the parent threads its onCreated through the new-hive
 * success path (→ the share-offer step).
 *
 * Form drafts (the query box, the slug/parent inputs) are useState — the nuqs
 * transient-lifecycle exception; the SELECTED picker entry lives in the
 * picker's `?picker=` nuqs param.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Select } from './Select';
import { useLexicon } from '@/lib/useLexicon';
import { useSyncQuery } from '@papercusp/sync';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A `kind: 'blueprint'` Comb listing row — the subset this panel reads. Declared
 * locally so the SPA bundle never imports the operator-core types module (the
 * harness-link-types pure-leaf rule the rest of this picker family follows).
 */
interface BlueprintListing {
  id: number;
  slug: string;
  title: string;
  description: string;
  /** Within-project blueprint discriminator (the blueprint id / subdir). */
  listing_ref?: string | null;
  /** 'hive' = a hive template (instantiable as a hive home) | 'harness' | 'identity'
   *  (a wearable identity, P-016 — never a hive home). */
  blueprint_kind?: 'hive' | 'harness' | 'identity' | null;
}

type SearchPhase = 'idle' | 'searching' | 'results' | 'empty' | 'error';

/** ~300ms client debounce — mirrors EntryGithubSearchForm / the P-008 design. */
const DEBOUNCE_MS = 300;

export interface CupboardBlueprintFormProps {
  onBack: () => void;
  /** Called with the new hive's slug after install + create succeeds. */
  onCreated: (slug: string) => void;
  /** Lexicon label for a hive (the parent passes the resolved term). */
  hiveLabel: string;
}

// ── Local styles (the picker-family look; self-contained per EntryGithub*) ───

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 11px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};
const backBtnStyle: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 16 };
const secondaryBtn: React.CSSProperties = { padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' };

function FieldLabel({ children }: { children: ReactNode }) {
  return <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>{children}</span>;
}
function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>{children}</p>;
}
function NoticeCard({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-dim)' }}>
      {children}
    </div>
  );
}
function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" style={{ background: 'var(--bad-bg, rgba(255,80,80,0.08))', border: '1px solid var(--bad)', color: 'var(--bad)', borderRadius: 5, padding: '8px 12px', fontSize: 13, marginBottom: 14 }}>
      {message}
    </div>
  );
}

/** createHiveHarness error-code → friendly copy (shared shape with the picker). */
function friendlyCreateError(code: string | undefined, raw: string, potLower: string): string {
  switch (code) {
    case 'slug_exists':
    case 'dest_exists':
      return `A ${potLower} with that name already exists. Choose a different slug.`;
    case 'blueprint_invalid':
      return `That blueprint could not be used to create a ${potLower}: ${raw}`;
    case 'invalid_slug':
      return 'The slug must be lowercase letters, digits, and hyphens.';
    default:
      return raw || 'An unexpected error occurred.';
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function CupboardBlueprintForm({ onBack, onCreated, hiveLabel }: CupboardBlueprintFormProps) {
  const t = useLexicon();
  const hiveLower = hiveLabel.toLowerCase();
  const combLabel = t('cupboard');

  // Search state — transient (useState, the nuqs exception).
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [results, setResults] = useState<BlueprintListing[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  // The chosen blueprint — while set, the create form takes over the panel.
  const [selected, setSelected] = useState<BlueprintListing | null>(null);

  // Create-form state.
  const slugRef = useRef<HTMLInputElement>(null);
  const parentDirRef = useRef<HTMLInputElement>(null);
  // EI-1539: default = the generic `coding` pack (was 'papercusp-default', which
  // is byte-identical to it apart from its manifest id/title).
  const defaultPack = 'coding';
  const [knowledgePack, setKnowledgePack] = useState<string>(defaultPack);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('Creating…');
  const [createError, setCreateError] = useState<string | null>(null);

  const { data: packRows } = useSyncQuery<{ id: string; title: string; version: string; itemCount: number }>({
    queryName: 'knowledgePacks.list',
    args: {},
    staleTime: 60_000,
  });
  const availablePacks =
    packRows && packRows.length > 0
      ? packRows
      : [{ id: defaultPack, title: 'Generic coding learnings', version: '', itemCount: 0 }];

  // Debounced search-as-you-type. Paused while a blueprint is selected (the
  // create form owns the panel). AbortController cancels the stale in-flight
  // request on each keystroke / unmount; its AbortError is swallowed.
  useEffect(() => {
    if (selected) return;
    const q = query.trim();
    if (!q) {
      setPhase('idle');
      setResults([]);
      return;
    }
    setPhase('searching');
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/cupboard/listings?kind=blueprint&q=${encodeURIComponent(q)}`, {
            signal: ctrl.signal,
          });
          if (!res.ok) {
            setErrorMsg(`Search failed (HTTP ${res.status}).`);
            setPhase('error');
            return;
          }
          const data = (await res.json().catch(() => ({}))) as { listings?: BlueprintListing[] };
          const raw = Array.isArray(data.listings) ? data.listings : [];
          // Hive-instantiable only: keep 'hive' templates + unknown (pre-009
          // worker rows that don't carry blueprint_kind); drop known 'harness'
          // blueprints and identities — they can't be a hive home (createHiveHarness
          // rejects them).
          const hives = raw.filter((l) => l.blueprint_kind !== 'harness' && l.blueprint_kind !== 'identity');
          setResults(hives);
          setPhase(hives.length ? 'results' : 'empty');
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          setErrorMsg((err as Error).message ?? 'Search failed.');
          setPhase('error');
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [query, selected]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const slug = slugRef.current?.value.trim() ?? '';
    const parentDir = parentDirRef.current?.value.trim() ?? '';
    if (!slug) {
      setCreateError('A slug is required.');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      setCreateError('The slug must be lowercase letters, digits, and hyphens.');
      return;
    }
    setBusy(true);
    setCreateError(null);
    try {
      // 1) INSTALL the blueprint into the installed tier — this clones the
      //    listing's repo + validates the blueprint, and returns its id.
      setBusyLabel('Installing blueprint…');
      const inst = await fetch('/api/cupboard/install-blueprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listingId: String(selected.id) }),
      });
      const instBody = (await inst.json().catch(() => ({}))) as { ok?: boolean; id?: string; error?: string };
      if (!inst.ok || instBody.ok === false || !instBody.id) {
        setCreateError(
          instBody.error ? `Couldn’t install the blueprint: ${instBody.error}` : `Couldn’t install the blueprint (HTTP ${inst.status}).`,
        );
        setBusy(false);
        return;
      }
      const blueprintId = instBody.id;
      // 2) CREATE the hive running the freshly-installed blueprint.
      setBusyLabel(`Creating ${hiveLower}…`);
      const res = await fetch('/api/harness/pots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug,
          ...(parentDir ? { parentDir } : {}),
          blueprintId,
          knowledgePack: knowledgePack === 'none' ? null : knowledgePack,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        setCreateError(friendlyCreateError(body.code, body.error ?? `HTTP ${res.status}`, hiveLower));
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { project: { slug: string; path: string } };
      toast.success(`${hiveLabel} '${data.project.slug}' created from ${selected.title} — the ${t('brain')} is provisioning its fleet.`);
      onCreated(data.project.slug);
    } catch (err: unknown) {
      setCreateError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  // ── Create form (a blueprint is selected) ──────────────────────────────────

  if (selected) {
    return (
      <form onSubmit={(e) => void handleCreate(e)}>
        <button
          type="button"
          onClick={() => { setSelected(null); setCreateError(null); }}
          style={backBtnStyle}
          disabled={busy}
        >
          ← Choose a different blueprint
        </button>
        <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>
          New {hiveLower} from <span style={{ color: 'var(--accent)' }}>{selected.title}</span>
        </h2>
        <NoticeCard testId="comb-blueprint-selected">
          <span style={{ marginRight: 6 }}>🫖</span>
          Installs <code>{selected.listing_ref || selected.slug}</code> from the {combLabel} and stands up a new {hiveLower}
          running it. The blueprint stays linked to its upstream — improvements published to it can be pulled later.
        </NoticeCard>
        {createError && <ErrorBanner message={createError} />}
        <label style={{ display: 'block', marginBottom: 14 }}>
          <FieldLabel>{hiveLabel} slug</FieldLabel>
          <input ref={slugRef} type="text" placeholder={`my-${hiveLower}`} style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" />
          <Hint>Lowercase, hyphens OK. Used as the folder name + the {hiveLower} id.</Hint>
        </label>
        <label style={{ display: 'block', marginBottom: 14 }}>
          <FieldLabel>Parent directory <span style={{ color: 'var(--fg-mute)' }}>(optional)</span></FieldLabel>
          <input ref={parentDirRef} type="text" placeholder="~/.papercusp/hives" style={inputStyle} />
          <Hint>Where the {hiveLower}&rsquo;s home folder is created. Leave blank for the default (~/.papercusp/hives).</Hint>
        </label>
        <label style={{ display: 'block', marginBottom: 14 }}>
          <FieldLabel>Knowledge pack</FieldLabel>
          <Select
            testId="knowledge-pack-picker"
            value={knowledgePack}
            onChange={setKnowledgePack}
            ariaLabel="Knowledge pack"
            triggerStyle={inputStyle}
            options={[
              ...availablePacks.map((p) => ({
                value: p.id,
                label: `${p.title}${p.itemCount ? ` — ${p.itemCount} learnings` : ''}${p.id === defaultPack ? ' (default)' : ''}`,
              })),
              { value: 'none', label: 'None — start with an empty memory' },
            ]}
          />
          <Hint>Working wisdom seeded into the {hiveLower}’s shared memory. Editable later from the Learning tab.</Hint>
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button type="button" onClick={() => { setSelected(null); setCreateError(null); }} disabled={busy} style={{ ...secondaryBtn, opacity: busy ? 0.5 : 1, cursor: busy ? 'not-allowed' : 'pointer' }}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, fontWeight: 600 }}
          >
            {busy ? busyLabel : `Create ${hiveLabel}`}
          </button>
        </div>
      </form>
    );
  }

  // ── Search screen (no blueprint selected) ──────────────────────────────────

  return (
    <div>
      <button type="button" onClick={onBack} style={backBtnStyle}>← Back</button>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>New {hiveLower} from a {combLabel} blueprint</h2>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        Search published blueprints on the {combLabel} and instantiate one as a new {hiveLower}. The blueprint defines how
        the {hiveLower}&rsquo;s {t('brain')} decomposes work and what its {t('contributor', { plural: true }).toLowerCase()} do.
      </p>
      <label style={{ display: 'block', marginBottom: 14 }}>
        <FieldLabel>Search the {combLabel}</FieldLabel>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. research, writing, data-pipeline…"
          style={inputStyle}
          autoFocus
          aria-label={`Search ${combLabel} blueprints`}
        />
      </label>

      {phase === 'idle' && (
        <NoticeCard testId="comb-blueprint-idle">
          Start typing to search blueprints published to the {combLabel}. For the two built-in domains, use{' '}
          <strong style={{ color: 'var(--fg)' }}>New coding {hiveLower}</strong> or{' '}
          <strong style={{ color: 'var(--fg)' }}>New work {hiveLower}</strong> above.
        </NoticeCard>
      )}
      {phase === 'searching' && (
        <NoticeCard testId="comb-blueprint-searching">Searching the {combLabel}…</NoticeCard>
      )}
      {phase === 'empty' && (
        <NoticeCard testId="comb-blueprint-empty">
          No published blueprints match “{query.trim()}”.
        </NoticeCard>
      )}
      {phase === 'error' && <ErrorBanner message={errorMsg} />}

      {phase === 'results' && (
        <div data-testid="comb-blueprint-results" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => { setSelected(b); setCreateError(null); }}
              className="pc-comb-blueprint-result"
              style={{
                textAlign: 'left',
                padding: '10px 12px',
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: 'pointer',
                display: 'block',
              }}
            >
              <strong style={{ fontSize: 13, display: 'block', marginBottom: 2, color: 'var(--fg)' }}>
                {b.title || b.slug}
              </strong>
              {b.description && (
                <span style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.4, display: 'block' }}>
                  {b.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
