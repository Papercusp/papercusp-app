'use client';

/**
 * CreateHarnessPicker — modal picker for adding a new harness to the workspace.
 *
 * Implements Phase 1a P-012 (papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24):
 *   P-012a  4-entry picker renders with coming-soon placeholders
 *   P-012b  Entry 1 (New local directory) happy path
 *   P-012c  Entry 3 (Existing local repo) happy path
 *   P-012d  Per-error-code error messages
 *
 * Entries are grouped around the hive model (comb-hive-native-sharing P-006):
 * a **Create** group (new local · existing local · search GitHub → create or
 * join a hive from any repo) and a **Join** group (browse the Comb · hive
 * invite). The whole hive-native layout is gated on
 * POT_FROM_GITHUB_URL — flag OFF keeps the legacy Local/Shared layout
 * (coming-soon GitHub stub). Every card carries a one-line
 * OUTCOME explainer (P-007) — what that entry produces.
 *
 * The "Search GitHub" entry is the P-009 search panel (EntryGithubSearchForm)
 * feeding the create-from-repo flow; the github-url step id is unchanged so the
 * `?picker=github-url` deep link and its e2e keep working. "Browse the Comb" is
 * a router link to /cupboard (the hive directory browse, where Phase 1's join
 * lives), so the portal can map it onto its own Cupboard surface.
 *
 * The SELECTED entry rides the `?picker=` nuqs param (user-meaningful state →
 * URL, the house rule); form drafts inside each entry stay useState.
 */

import { useState, useRef, useEffect, type FormEvent, type ReactNode } from 'react';
import { parseAsBoolean, parseAsString, parseAsStringEnum, useQueryStates } from 'nuqs';
import { Modal } from './Modal';
import { Select } from './Select';
import { Tooltip } from './Tooltip';
import { toast } from 'sonner';
import { FLAGS } from '@papercusp/flags';
// Pure parser leaf — SPA-bundle-safe (the harness-link-types rule).
import { parseHiveInviteLink } from '@papercusp/operator-core/lib/harness/hive-invite-link';
import { useSyncQuery } from '@papercusp/sync';
import { useFlag } from '@/lib/flag-hooks';
import { useLexicon } from '@/lib/useLexicon';
import { readHostedBrowserApiMarker } from '@/lib/hosted-browser-api';
import { useOperatorWorkspaceLocation } from '@papercusp/operator-ui/seam';
import { EntryGithubSearchForm } from './EntryGithubSearchForm';
import { CupboardBlueprintForm } from './CupboardBlueprintForm';
import { PublishPotCard } from './PublishPotCard';
import { HowSharingWorks } from '../_components/HowSharingWorks';
import RouteLink from '../_components/RouteLink';

// ── Types ──────────────────────────────────────────────────────────────────

/** The non-default steps — the `?picker=` nuqs values ('picker' = param unset). */
const ENTRY_STEPS = [
  'new-local',
  'existing-local',
  'github-url',
  'work-hive',
  'comb-blueprint',
  'hive-invite',
  'share-offer',
] as const;
type EntryStep = (typeof ENTRY_STEPS)[number];

type Step = 'picker' | EntryStep;

/**
 * Blueprint id for the "New work hive" domain heading (domain-generic-hive
 * P-006 / Brief 3). The coding path OMITS blueprintId — `/api/harness/pots`
 * + createHiveHarness default to the coding `hive`, so only the work id is
 * sent from the UI. Brief 6 (rename `hive`→`coding`, `generic-hive`→`work`)
 * updates this constant; its extends-resolver alias keeps the old id resolving
 * during the transition so a missed update still works.
 */
const WORK_HIVE_BLUEPRINT_ID = 'work';

/**
 * The creation fork (harnesses-tab-hive-model D-005 / P-010). A `standalone`
 * "New local directory" now stands up a NEW hive (a fresh local dir IS a hive);
 * `into-hive` adds the new dir as a member of the selected hive scope, stamping
 * a membership edge (P-011). The "Add to <hive>" toggle only appears — and the
 * only difference between the modes only exists — when a hive scope is selected.
 */
type CreateMode = 'standalone' | 'into-hive';

interface CreateResult {
  ok: boolean;
  project: { slug: string; path: string };
}

interface ApiError {
  error: string;
  code?: string;
  detail?: string;
}

// ── Error message map ──────────────────────────────────────────────────────

function friendlyError(code: string | undefined, raw: string): string {
  switch (code) {
    case 'dest_exists':
      return 'A directory with that name already exists. Choose a different name or pick a different parent directory.';
    case 'invalid_path':
      return `That path is invalid: ${raw}`;
    case 'parent_missing':
      return 'Parent directory not found or not a directory. Check the path and try again.';
    case 'git_missing':
      return 'git was not found in PATH. Install git and try again.';
    default:
      return raw || 'An unexpected error occurred.';
  }
}

// ── Small shared helpers ───────────────────────────────────────────────────

function Label({ children }: { children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      {children}
    </label>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '7px 10px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

function HintText({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>
      {children}
    </p>
  );
}

function BackBtn({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 20 }}
    >
      ← Back
    </button>
  );
}

function SubmitRow({ busy, label, busyLabel = 'Creating…', onBack }: { busy: boolean; label: string; busyLabel?: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, fontWeight: 600 }}
      >
        {busy ? busyLabel : label}
      </button>
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

// ── Where the paths live (WI-10003268) ─────────────────────────────────────
//
// Every path Entries 1/3 ask for is on the machine running the operator. On the
// desktop that is the user's own computer; for a signed-in cloud-portal user
// (the portal's context) or the operator's own hosted shell (the injected
// marker) it is their cloud workspace machine, where "local" names the wrong
// machine. The local strings are the desktop's, unchanged.
function useWorkspaceInCloud(): boolean {
  const location = useOperatorWorkspaceLocation();
  return location === 'cloud' || readHostedBrowserApiMarker() !== null;
}

function pathCopy(inCloud: boolean, hiveLower: string) {
  if (!inCloud) {
    return {
      newLabel: 'New local directory',
      existingLabel: 'Existing local repo',
      legacyHeading: 'Local',
      legacyExistingDescription: `Register an existing local directory or git repo as a ${hiveLower}.`,
      newDescription: `A fresh folder, git-initialised and registered as a coding ${hiveLower}.`,
      existingDescription: 'Link a local repo in place — nothing is moved or copied.',
      newFormHeading: `New ${hiveLower} from a local directory`,
      parentDirHint: 'Absolute path to the directory that will contain the new folder.',
      repoPathHint: 'Absolute path to an existing git repository or project directory. Stays where it is — linked, not moved.',
    };
  }
  return {
    newLabel: 'New folder on your cloud workspace',
    existingLabel: 'Existing repo on your cloud workspace',
    legacyHeading: 'Cloud workspace',
    legacyExistingDescription: `Register a directory or git repo on your cloud workspace machine as a ${hiveLower}.`,
    newDescription: `A fresh folder on your cloud workspace machine, git-initialised and registered as a coding ${hiveLower}.`,
    existingDescription: 'Link a repo already on your cloud workspace machine in place — nothing is moved or copied.',
    newFormHeading: `New ${hiveLower} from a folder on your cloud workspace`,
    parentDirHint: 'Absolute path on your cloud workspace machine to the directory that will contain the new folder.',
    repoPathHint:
      'Absolute path to a git repository or project directory on your cloud workspace machine. Stays where it is — linked, not moved.',
  };
}

// ── Entry 1 form — new local directory ────────────────────────────────────
//
// A new local directory IS a hive: when NOT adding into an existing hive the
// form stands up a kind:'hive' home (the Queen blueprint) via /api/harness/pots.
// When a `hive` scope IS passed (into-hive member) it posts a plain member
// harness to /api/harness/projects, reusing the slug as the folder name. The
// folder is the slug in both branches — there is no separate folder-name field.
function NewLocalForm({ onBack, onSuccess, hive, hiveLabel, domain = 'coding', blueprintId }: { onBack: () => void; onSuccess: (slug: string) => void; hive?: string; hiveLabel: string; domain?: 'coding' | 'work'; blueprintId?: string }) {
  const t = useLexicon();
  const hiveLower = hiveLabel.toLowerCase();
  const copy = pathCopy(useWorkspaceInCloud(), hiveLower);
  // P-006: a "work" hive is the same fresh-dir create, just a non-coding domain
  // (a different blueprint, judged-not-tested, repo-less). Only the new-hive
  // branch (`!hive`) reads `domain`/`blueprintId` — an into-hive member inherits
  // its parent hive's blueprint, so the domain fork there is moot.
  const isWork = domain === 'work' && !hive;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // knowledge-packs P-006: pack selection — default = the pack matching this
  // hive's DOMAIN. EI-1539: this was hardcoded to 'papercusp-default', which is
  // byte-identical to the generic `coding` pack apart from its manifest id/title,
  // and forced a Papercusp-branded pack onto WORK hives too.
  // Only used on the new-hive branch (`!hive`).
  const defaultPack = isWork ? 'work' : 'coding';
  const [knowledgePack, setKnowledgePack] = useState<string>(defaultPack);
  const slugRef = useRef<HTMLInputElement>(null);
  const parentDirRef = useRef<HTMLInputElement>(null);

  const { data: packRows } = useSyncQuery<{ id: string; title: string; version: string; itemCount: number }>({
    queryName: 'knowledgePacks.list',
    args: {},
    staleTime: 60_000,
  });
  const availablePacks =
    packRows && packRows.length > 0
      ? packRows
      : [{ id: defaultPack, title: defaultPack === 'work' ? 'Generic work learnings' : 'Generic coding learnings', version: '', itemCount: 0 }];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugRef.current?.value.trim() ?? '';
    const parentDir = parentDirRef.current?.value.trim() ?? '';
    if (!slug || !parentDir) {
      setError('All fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `hive` SET → a member harness inside the selected hive (the folder is
      // the slug). `hive` UNDEFINED → a new top-level hive home at
      // <parentDir>/<slug>, seeded from the chosen knowledge pack.
      const res = hive
        ? await fetch('/api/harness/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // `hive` (P-011): the route stamps the membership edge to that scope
            // (formal hive_slug / legacy parent_slug). The folder is the slug.
            body: JSON.stringify({ slug, parentDir, folderName: slug, hive }),
          })
        : await fetch('/api/harness/pots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // P-006: a work hive passes its blueprintId; coding omits it (the
            // route + createHiveHarness default to the coding `hive`).
            body: JSON.stringify({ slug, parentDir, knowledgePack: knowledgePack === 'none' ? null : knowledgePack, ...(blueprintId ? { blueprintId } : {}) }),
          });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(friendlyError(body.code, body.error));
        setBusy(false);
        return;
      }
      const data = (await res.json()) as CreateResult & {
        seededLearnings?: { packId: string; packVersion?: string; count?: number; error?: string };
      };
      if (hive) {
        toast.success(`${t('pot')} '${data.project.slug}' added to ${hive} at ${data.project.path}`);
      } else {
        toast.success(`${hiveLabel} '${data.project.slug}' created — the ${t('brain')} is provisioning its fleet.`, {
          // knowledge-packs P-006: tell the user the hive starts with default
          // learnings + where to edit them (the Learning tab's Learnings view).
          description:
            data.seededLearnings && !data.seededLearnings.error && (data.seededLearnings.count ?? 0) > 0
              ? `Started with ${data.seededLearnings.count} default learnings (${data.seededLearnings.packId}) — review & edit them in the Learning tab.`
              : undefined,
        });
      }
      onSuccess(data.project.slug);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>
        {hive ? copy.newLabel : isWork ? `New work ${hiveLower}` : copy.newFormHeading}
      </h2>
      {error && <ErrorBanner message={error} />}
      {hive ? (
        <div
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 16,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--fg-dim)',
          }}
        >
          <span style={{ marginRight: 6 }}>📁</span>
          Creates a fresh folder, runs <strong style={{ color: 'var(--fg)' }}>git init</strong>, and adds it as a
          member of <code>{hive}</code>.
        </div>
      ) : (
        <div
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 16,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--fg-dim)',
          }}
        >
          <span style={{ marginRight: 6 }}>{isWork ? '📋' : '☕'}</span>
          {isWork ? (
            <>
              Stands up a fresh folder as a new <strong style={{ color: 'var(--fg)' }}>work</strong> {hiveLower} home — a{' '}
              {t('brain')} that decomposes non-coding work (research, writing, ops) by topic, places it onto a fleet of{' '}
              {t('contributor', { plural: true, lower: true })}, and judges deliverables against a rubric. No repository or test suite required.
            </>
          ) : (
            <>
              Stands up a fresh folder as a new {hiveLower} home running the{' '}
              <strong style={{ color: 'var(--fg)' }}>{hiveLower}</strong> blueprint — a {t('brain')} that surveys the work
              frontier and places it onto a fleet of {t('contributor', { plural: true, lower: true })}. You can add members into it afterward.
            </>
          )}
        </div>
      )}
      <Label>
        <FieldLabel>{t('pot')} slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder={isWork ? `my-work-${hiveLower}` : 'my-project'} style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" />
        <HintText>Lowercase, hyphens OK. Used as the folder name created inside the parent directory.</HintText>
      </Label>
      <Label>
        <FieldLabel>Parent directory</FieldLabel>
        <input ref={parentDirRef} type="text" placeholder="/home/user/projects" style={inputStyle} />
        <HintText>{copy.parentDirHint}</HintText>
      </Label>
      {/* knowledge-packs P-006: the pack picker — a new hive starts with a
          default set of learnings; selectable away, editable afterward. Only
          shown for the new-hive branch (`!hive`); members inherit the hive's. */}
      {!hive && (
        <Label>
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
          <HintText>
            New {hiveLower}s start with a default set of learnings — working wisdom seeded
            into the {hiveLower}&rsquo;s shared memory. Review, edit, or remove them anytime
            from the Learning tab.
          </HintText>
        </Label>
      )}
      <SubmitRow busy={busy} label={hive ? `Add ${t('pot')}` : `Create ${t('pot')}`} onBack={onBack} />
    </form>
  );
}

// ── Entry 3 form — existing local repo ────────────────────────────────────
//
// An existing local repo IS a hive: when NOT adding into an existing hive the
// form LINKS the repo in place AND stands up a kind:'hive' home (the Queen
// blueprint) via /api/harness/pots with a non-empty `path` (the contract:
// `path` set ⇒ link-in-place as a new hive). When a `hive` scope IS passed
// (into-hive member) it posts a plain member harness to /api/harness/projects,
// stamping the membership edge. The repo never moves in either branch.
function ExistingLocalForm({ onBack, onSuccess, hive, hiveLabel }: { onBack: () => void; onSuccess: (slug: string) => void; hive?: string; hiveLabel: string }) {
  const t = useLexicon();
  const hiveLower = hiveLabel.toLowerCase();
  const copy = pathCopy(useWorkspaceInCloud(), hiveLower);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // knowledge-packs P-006: pack selection — default = the generic `coding` pack
  // (EI-1539: was 'papercusp-default', byte-identical apart from its manifest
  // id/title). This form links an existing local REPO, so it is always coding.
  const defaultPack = 'coding';
  const [knowledgePack, setKnowledgePack] = useState<string>(defaultPack);
  const slugRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  const { data: packRows } = useSyncQuery<{ id: string; title: string; version: string; itemCount: number }>({
    queryName: 'knowledgePacks.list',
    args: {},
    staleTime: 60_000,
  });
  // No domain ternary here: this form is always coding (see defaultPack above),
  // so TS narrows it to the literal 'coding' and a `=== 'work'` test is provably
  // dead (TS2367). NewLocalForm's copy DOES branch, because its defaultPack is a
  // real 'coding'|'work' union driven by the `domain` prop.
  const availablePacks =
    packRows && packRows.length > 0
      ? packRows
      : [{ id: defaultPack, title: 'Generic coding learnings', version: '', itemCount: 0 }];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugRef.current?.value.trim() ?? '';
    const path = pathRef.current?.value.trim() ?? '';
    if (!slug || !path) {
      setError('Both fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // `hive` SET → a member harness linked in place inside the selected hive
      // (P-011 stamps the membership edge). `hive` UNDEFINED → LINK the existing
      // repo in place as a NEW top-level hive home (the contract: a non-empty
      // `path` links a dir as a hive), seeded from the chosen knowledge pack.
      const res = hive
        ? await fetch('/api/harness/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, path, hive }),
          })
        : await fetch('/api/harness/pots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, path, knowledgePack: knowledgePack === 'none' ? null : knowledgePack }),
          });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(friendlyError(body.code, body.error));
        setBusy(false);
        return;
      }
      const data = (await res.json()) as CreateResult & {
        seededLearnings?: { packId: string; packVersion?: string; count?: number; error?: string };
      };
      if (hive) {
        toast.success(`${t('pot')} '${data.project.slug}' linked in place — ${data.project.path} (folder not moved)`);
      } else {
        toast.success(`${hiveLabel} '${data.project.slug}' created — linked in place, the ${t('brain')} is provisioning its fleet.`, {
          description:
            data.seededLearnings && !data.seededLearnings.error && (data.seededLearnings.count ?? 0) > 0
              ? `Started with ${data.seededLearnings.count} default learnings (${data.seededLearnings.packId}) — review & edit them in the Learning tab.`
              : undefined,
        });
      }
      onSuccess(data.project.slug);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>
        {hive ? copy.existingLabel : `Existing repo as a new ${hiveLower}`}
      </h2>
      {error && <ErrorBanner message={error} />}
      {hive ? (
        <div
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 16,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--fg-dim)',
          }}
        >
          <span style={{ marginRight: 6 }}>🔗</span>
          <strong style={{ color: 'var(--fg)' }}>Links the folder in place</strong> as a member of{' '}
          <code>{hive}</code> — your repo stays exactly where it is; nothing is moved or copied. The same
          folder can be linked into more than one workspace (e.g. to try different prompts on it).
        </div>
      ) : (
        <div
          style={{
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 16,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--fg-dim)',
          }}
        >
          <span style={{ marginRight: 6 }}>☕</span>
          <strong style={{ color: 'var(--fg)' }}>Links the folder in place</strong> as a new {hiveLower} home
          running the <strong style={{ color: 'var(--fg)' }}>{hiveLower}</strong> blueprint — a {t('brain')} that
          surveys the work frontier and places it onto a fleet of {t('contributor', { plural: true, lower: true })}. Your repo stays where it is; nothing
          is moved or copied. You can add members into it afterward.
        </div>
      )}
      <Label>
        <FieldLabel>{t('pot')} slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder="my-project" style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" />
        <HintText>Lowercase, hyphens OK.</HintText>
      </Label>
      <Label>
        <FieldLabel>Path to repo</FieldLabel>
        <input ref={pathRef} type="text" placeholder="/home/user/projects/my-project" style={inputStyle} />
        <HintText>{copy.repoPathHint}</HintText>
      </Label>
      {/* knowledge-packs P-006: the pack picker — a new hive starts with a
          default set of learnings; selectable away, editable afterward. Only
          shown for the new-hive branch (`!hive`); members inherit the hive's. */}
      {!hive && (
        <Label>
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
          <HintText>
            New {hiveLower}s start with a default set of learnings — working wisdom seeded
            into the {hiveLower}&rsquo;s shared memory. Review, edit, or remove them anytime
            from the Learning tab.
          </HintText>
        </Label>
      )}
      <SubmitRow busy={busy} label={hive ? `Add ${t('pot')}` : `Create ${t('pot')}`} onBack={onBack} />
    </form>
  );
}

// ── Hive-invite join form (hive-from-repo-hardening P-006 / D-006) ─────────

/**
 * The INVITEE side of a `papercusp://pot?...` invite artifact: paste the
 * link → POST /api/discovery/join-invite → the loopback route joins the
 * invite-scoped directory topic, so the hive's announce lands in the Hives
 * panel. No clone, no harness — joining the directory is the whole action.
 */
function HiveInviteForm({
  onBack,
  onDone,
  hiveLabel,
}: {
  onBack: () => void;
  onDone: () => void;
  hiveLabel: string;
}) {
  const hiveLower = hiveLabel.toLowerCase();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = link.trim();
    // Same strict parser the route runs — instant feedback, zero round-trip.
    if (!parseHiveInviteLink(trimmed)) {
      setError(`That doesn’t look like a ${hiveLower} invite link — expected papercusp://pot?secret=…`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/discovery/join-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (!res.ok) {
        setError(
          body.code === 'directory_unavailable'
            ? `The ${hiveLower} directory isn’t available on this machine — run \`gh auth login\` in your terminal, then retry.`
            : body.code === 'invalid_link'
              ? `That doesn’t look like a ${hiveLower} invite link — expected papercusp://pot?secret=…`
              : body.error || `HTTP ${res.status}`,
        );
        setBusy(false);
        return;
      }
      setJoined(true);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  if (joined) {
    return (
      <div>
        <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>✓ Subscribed to this invite</h2>
        <p data-testid="hive-invite-joined" style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          The {hiveLower} appears in the {hiveLabel}s panel once its owner&rsquo;s machine announces it on this
          invite — it won&rsquo;t appear if the invite was withdrawn or the link is wrong.
        </p>
        <div style={{ textAlign: 'right' }}>
          <button
            type="button"
            onClick={onDone}
            style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: 'pointer', fontWeight: 600 }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Join a {hiveLower} by invite</h2>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        Paste the invite link you were given. It subscribes this machine to the {hiveLower}&rsquo;s
        invite-only directory listing — the {hiveLower} shows up in the {hiveLabel}s panel, where you can
        join its member harnesses.
      </p>
      {error && <ErrorBanner message={error} />}
      <Label>
        <FieldLabel>Invite link</FieldLabel>
        <textarea
          value={link}
          onChange={(e) => { setLink(e.target.value); setError(null); }}
          placeholder="papercusp://pot?pubkey=…&secret=…&title=…"
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-mono, monospace)' }}
          autoFocus
        />
        <HintText>The full papercusp://pot?… link — the bare secret alone won&rsquo;t work.</HintText>
      </Label>
      <SubmitRow busy={busy} label="Join" busyLabel="Joining…" onBack={onBack} />
    </form>
  );
}

// ── Coming-soon placeholder ────────────────────────────────────────────────

function ComingSoonStub({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{title}</h2>
      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 20, textAlign: 'center' }}>
        <span style={{ fontSize: 28, display: 'block', marginBottom: 10 }}>🚧</span>
        <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 14 }}>Coming soon</p>
        <p style={{ margin: 0, color: 'var(--fg-dim)', fontSize: 13, lineHeight: 1.5 }}>
          This entry type requires GitHub authentication and repository cloning, which isn&rsquo;t available yet.
        </p>
      </div>
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' }}
        >
          Back
        </button>
      </div>
    </div>
  );
}

// ── Picker cards ───────────────────────────────────────────────────────────

interface PickerEntry {
  /** React key + e2e/test anchor. For a step entry, equals the step it opens. */
  key: string;
  label: string;
  description: string;
  icon: string;
  /** The in-modal picker step this entry opens. Omit for an `href` entry. */
  step?: EntryStep;
  /** A navigation target (the Comb at /cupboard) — renders an <a>, not a step. */
  href?: string;
  /** Routes to a not-yet-available stub; renders dimmed (no visible badge). */
  comingSoon?: boolean;
}

interface PickerSection {
  heading: string;
  subheading?: string;
  /** P-006: the creation-mode fork (New hive · Add to <hive> · Standalone)
   *  renders inside this section's header (only the Create group governs it). */
  showForkToggle?: boolean;
  entries: PickerEntry[];
}

/**
 * Sections are built per-render: the domain-first hive-native layout
 * (domain-generic-hive P-006 — New coding hive · New work hive · New hive from a
 * Comb blueprint · Join) lights up on POT_FROM_GITHUB_URL; flag OFF keeps the
 * legacy Local/Shared layout (coming-soon GitHub stub). Labels are
 * lexicon-bound; every card carries a one-line OUTCOME explainer (P-007).
 */
function buildSections(opts: {
  hiveLower: string;
  hivesLower: string;
  combLabel: string;
  brainLabel: string;
  githubUrlEnabled: boolean;
  inCloud: boolean;
}): PickerSection[] {
  const { hiveLower, hivesLower, combLabel, brainLabel, githubUrlEnabled, inCloud } = opts;
  const copy = pathCopy(inCloud, hiveLower);

  if (!githubUrlEnabled) {
    // Legacy layout (flag off) — preserved byte-for-byte on the desktop.
    return [
      {
        heading: copy.legacyHeading,
        entries: [
          {
            key: 'new-local',
            step: 'new-local',
            label: copy.newLabel,
            description: `Create a new folder, run git init, and register it as a ${hiveLower}.`,
            icon: '📁',
          },
          {
            key: 'existing-local',
            step: 'existing-local',
            label: copy.existingLabel,
            description: copy.legacyExistingDescription,
            icon: '📂',
          },
        ],
      },
      {
        heading: 'Shared',
        subheading: 'Work on these repositories collaboratively.',
        entries: [
          {
            key: 'github-url',
            step: 'github-url',
            label: 'GitHub URL',
            description: 'Clone a GitHub repository and register it. Requires GitHub auth.',
            icon: '🐙',
            comingSoon: true,
          },
        ],
      },
    ];
  }

  // Domain-first hive-native layout (domain-generic-hive P-006 / Brief 3): four
  // headings — New coding hive (its 3 mechanism sub-options), New work hive,
  // New hive from a Comb blueprint, and Join. The domain is the FIRST choice;
  // the coding mechanism (local/repo/github) nests under its heading.
  return [
    {
      heading: `New coding ${hiveLower}`,
      subheading: `A ${hiveLower} that writes code against a repository.`,
      showForkToggle: true,
      entries: [
        {
          key: 'new-local',
          step: 'new-local',
          label: copy.newLabel,
          description: copy.newDescription,
          icon: '📁',
        },
        {
          key: 'existing-local',
          step: 'existing-local',
          label: copy.existingLabel,
          description: copy.existingDescription,
          icon: '📂',
        },
        {
          key: 'github-url',
          step: 'github-url',
          label: 'Search GitHub or enter URL',
          description: `Find any repo on GitHub and create or join a ${hiveLower} from it.`,
          icon: '🔎',
        },
      ],
    },
    {
      heading: `New work ${hiveLower}`,
      subheading: `Non-coding work — research, writing, ops. Judged against a rubric; no repo.`,
      entries: [
        {
          key: 'work-hive',
          step: 'work-hive',
          label: `Start a work ${hiveLower}`,
          description: `A fresh ${hiveLower} for non-coding work — the ${brainLabel} judges deliverables, no repo needed.`,
          icon: '📋',
        },
      ],
    },
    {
      heading: `New ${hiveLower} from a ${combLabel} blueprint`,
      subheading: `Start a ${hiveLower} from a published blueprint.`,
      entries: [
        {
          key: 'comb-blueprint',
          step: 'comb-blueprint',
          label: `Search the ${combLabel}`,
          description: `Search published blueprints and instantiate one as a new ${hiveLower}.`,
          icon: '🧩',
        },
      ],
    },
    {
      heading: 'Join',
      subheading: `Collaborate on a ${hiveLower} someone else published.`,
      entries: [
        {
          key: 'browse-comb',
          // `create=false` closes this modal in the SAME navigation. The portal
          // carries the current search into a mapped link, so a bare /cupboard
          // left ?create=true behind and reopened the modal on return; a
          // separate close write races the navigation (see the nuqs note on
          // CreateHarnessPicker).
          href: '/cupboard?create=false',
          label: `Browse the ${combLabel}`,
          description: `Browse published ${hivesLower} in the ${combLabel} and join one.`,
          icon: '🫖',
        },
        {
          key: 'hive-invite',
          step: 'hive-invite',
          label: `${capitalize(hiveLower)} invite`,
          description: `Paste a papercusp://pot invite link to join a private ${hiveLower}.`,
          icon: '✉️',
        },
      ],
    },
  ];
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * The creation fork toggle (D-005 / P-010), now a 2-option scope toggle that
 * only appears WHEN a hive scope is selected: [Add to <hive>] (into-hive) |
 * [New <hive>] (standalone — a fresh local dir is its own new hive). With no
 * scope there is no fork at all (mode stays `standalone` = a new hive), so this
 * renders nothing.
 */
function ForkToggle({
  mode,
  onMode,
  hiveScope,
  hiveLabel,
}: {
  mode: CreateMode;
  onMode: (m: CreateMode) => void;
  hiveScope: string | null;
  hiveLabel: string;
}) {
  const t = useLexicon();
  const lower = hiveLabel.toLowerCase();
  if (!hiveScope) return null;
  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 10px',
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--accent)' : 'var(--bg-2)',
    color: active ? 'var(--accent-ink, #051827)' : 'var(--fg-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  return (
    <div role="tablist" aria-label="Creation mode" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
      <Tooltip label={`Add the new ${lower} into ${hiveScope}`}>
        <button type="button" role="tab" aria-selected={mode === 'into-hive'} onClick={() => onMode('into-hive')} style={btn(mode === 'into-hive')}>
          Add to {hiveScope}
        </button>
      </Tooltip>
      <Tooltip label={`Stand up a new ${lower} home running the ${t('brain')} blueprint`}>
        <button type="button" role="tab" aria-selected={mode === 'standalone'} onClick={() => onMode('standalone')} style={btn(mode === 'standalone')}>
          New {lower}
        </button>
      </Tooltip>
    </div>
  );
}

function PickerStep({
  onSelect,
  onClose,
  mode,
  onMode,
  hiveScope,
  hiveLabel,
  combLabel,
  githubUrlEnabled,
}: {
  onSelect: (step: Step) => void;
  /** EI-544: the top-level grid step has no inner Cancel/Back button (those only
   *  exist on the entry FORM steps), so it needs its own explicit dismiss
   *  affordance — a visible Close (X) alongside the existing Escape/backdrop
   *  dismissal, per the WCAG 2.1.2 dialog pattern. */
  onClose: () => void;
  mode: CreateMode;
  onMode: (m: CreateMode) => void;
  hiveScope: string | null;
  hiveLabel: string;
  combLabel: string;
  githubUrlEnabled: boolean;
}) {
  const t = useLexicon();
  const hiveLower = hiveLabel.toLowerCase();
  const intoHive = mode === 'into-hive' && hiveScope;
  const inCloud = useWorkspaceInCloud();
  const sections = buildSections({
    hiveLower,
    hivesLower: `${hiveLower}s`,
    combLabel,
    brainLabel: t('brain'),
    githubUrlEnabled,
    inCloud,
  });
  const fork = (
    <ForkToggle mode={mode} onMode={onMode} hiveScope={hiveScope} hiveLabel={hiveLabel} />
  );
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="pc-create-harness-close"
        style={{
          position: 'absolute',
          top: -4,
          right: -4,
          width: 28,
          height: 28,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'none',
          border: 'none',
          borderRadius: 6,
          color: 'var(--fg-dim)',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ✕
      </button>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600, paddingRight: 24 }}>Add a {hiveLabel}</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-dim)' }}>
        {intoHive
          ? <>New {hiveLabel}s will be added into <code>{hiveScope}</code>.</>
          : `Choose how to add a new ${hiveLower} to this workspace.`}
      </p>
      {/* Flag OFF: the fork toggle sits at the top (legacy layout). Flag ON it
          moves inside the Create section — only creation reads the mode (P-006). */}
      {!githubUrlEnabled && fork}
      {sections.map((section) => (
        <div key={section.heading} style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 10 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                color: 'var(--fg-dim)',
              }}
            >
              {section.heading}
            </h3>
            {section.subheading && (
              <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--fg-mute)' }}>
                {section.subheading}
              </p>
            )}
          </div>
          {section.showForkToggle && githubUrlEnabled && <div style={{ marginBottom: 12 }}>{fork}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {section.entries.map((entry) => {
              const cardStyle: React.CSSProperties = {
                textAlign: 'left',
                padding: 16,
                background: 'var(--bg-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                cursor: 'pointer',
                position: 'relative',
                transition: 'border-color 0.1s',
                display: 'block',
                textDecoration: 'none',
              };
              const inner = (
                <>
                  <span style={{ fontSize: 24, display: 'block', marginBottom: 8 }}>{entry.icon}</span>
                  <strong style={{ fontSize: 13, display: 'block', marginBottom: 4, color: entry.comingSoon ? 'var(--fg-mute)' : 'var(--fg)' }}>
                    {entry.label}
                  </strong>
                  <span style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.4, display: 'block' }}>
                    {entry.description}
                  </span>
                </>
              );
              // "Browse the Comb" navigates to /cupboard (a real route). A
              // RouteLink, not a raw <a>: it still behaves like a link
              // (cmd-click, etc.), and the portal's router shim maps it onto
              // its Cupboard surface — a raw <a> sent the portal to a /cupboard
              // page it does not have (404, WI-10003268).
              if (entry.href) {
                return (
                  <RouteLink key={entry.key} href={entry.href} className="pc-create-harness-entry" style={cardStyle}>
                    {inner}
                  </RouteLink>
                );
              }
              return (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => entry.step && onSelect(entry.step)}
                  className="pc-create-harness-entry"
                  style={cardStyle}
                >
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {/* P-012: the in-UI explainer is reachable from the picker (D-004). */}
      {githubUrlEnabled && (
        <div style={{ marginTop: 4, textAlign: 'center' }}>
          <HowSharingWorks />
        </div>
      )}
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────

interface CreateHarnessPickerProps {
  open: boolean;
  // May return a promise (nuqs setter): the picker AWAITS close/create writes so
  // they serialize over the custom nuqs adapter (which clobbers same-tick writes).
  onOpenChange: (open: boolean) => void | Promise<unknown>;
  /**
   * Called after a harness is successfully created/added. `opts.hive` names the
   * hive the new harness was added INTO (add-into-hive mode, P-011) so the caller
   * can land it as the focused member; absent ⇒ a standalone / new-hive root.
   * May return a promise (nuqs writes) — the picker awaits it before closing so
   * the focus-write and the close-write don't race on the URL.
   */
  onCreated?: (slug: string, opts?: { hive?: string }) => void | Promise<unknown>;
  /**
   * The currently-selected hive scope (`?slug=`), if any (harnesses-tab-hive-model
   * P-010/P-011). When set, the picker offers "Add to <hive>" and defaults to it;
   * the add-into-hive create stamps the membership edge to this scope.
   */
  hiveScope?: string | null;
  /** Lexicon label for a pot (D-006 — the parent passes the resolved term). Default "Pot". */
  hiveLabel?: string;
}

export function CreateHarnessPicker({ open, onOpenChange, onCreated, hiveScope = null, hiveLabel = 'Pot' }: CreateHarnessPickerProps) {
  // ALL modal URL state lives in ONE useQueryStates so multi-key transitions
  // write ATOMICALLY (a single navigate). The custom nuqs adapter
  // (operator-vite/lib/nuqs-tanstack-router-adapter) re-derives EVERY watched key
  // from the last flush's snapshot, so two separate same-tick setters clobber
  // each other (and awaiting them does NOT serialize — the setter resolves before
  // the navigate lands; proven in nuqs-two-write-race.router-integration.test).
  // The close (clear create+picker) and create-completion (focus slug/harness +
  // close) each touch several keys; doing them as one useQueryStates write is the
  // only race-free pattern — without it ?create=false was dropped and the modal
  // stuck open on the picker grid ("can't dismiss Add a Hive").
  //   ?picker = the selected entry (unset = the picker grid; agents drive it via
  //   ui:get_state/ui:dispatch). create/slug/harness are co-owned with AdvShell
  //   purely so the picker can co-write them atomically with the step/close.
  const [nav, setNav] = useQueryStates({
    create: parseAsBoolean.withDefault(false),
    picker: parseAsStringEnum<EntryStep>([...ENTRY_STEPS]),
    slug: parseAsString,
    harness: parseAsString,
  });
  const step: Step = nav.picker ?? 'picker';
  const setStep = (s: Step) => void setNav({ picker: s === 'picker' ? null : s });
  // Default into-hive when a hive is selected (the common case from the tab).
  const [mode, setMode] = useState<CreateMode>(hiveScope ? 'into-hive' : 'standalone');
  // WI-39533: that initializer alone could never deliver the D-005 default. This
  // picker is rendered by AdvShell UNCONDITIONALLY (visibility rides `open`), so
  // it mounts with the shell — before `projects` have loaded, when `activeIsHive`
  // is still false and `hiveScope` is therefore null. `mode` latched 'standalone'
  // at that first render and nothing re-seeded it when the scope resolved, so the
  // fork opened on Standalone even on a hive scope. Re-seed when the scope itself
  // changes: a user's explicit toggle survives (hiveScope does not change while
  // they interact), and handleClose still resets on close.
  useEffect(() => {
    setMode(hiveScope ? 'into-hive' : 'standalone');
  }, [hiveScope]);
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  // The hive the share-offer step can publish: the membership scope of an
  // into-hive create, or the new hive itself for a new-hive create. Per-harness
  // sharing is retired (comb-retire-per-harness-sharing-2026-06-11) — the
  // share offer is hive-publish or nothing.
  const [createdPotSlug, setCreatedPotSlug] = useState<string | null>(null);
  // P-012 (hive-from-github-url): the hive-native Create/Join layout + the
  // GitHub search entry go live behind this flag; off = the legacy
  // Local/Shared layout (coming-soon GitHub stub).
  const githubUrlEnabled = useFlag(FLAGS.POT_FROM_GITHUB_URL);
  // The Comb term for the "Browse the Comb" Join card (P-006) — lexicon-bound
  // (t('cupboard') = "Comb" | "Cupboard"). The hive term still rides the
  // parent-passed `hiveLabel` prop.
  const t = useLexicon();
  const combLabel = t('cupboard');

  const handleClose = () => {
    setMode(hiveScope ? 'into-hive' : 'standalone');
    setCreatedSlug(null);
    setCreatedPotSlug(null);
    // ATOMIC close: clear create AND picker in ONE useQueryStates write so the
    // adapter can't drop ?create=false (the stuck-modal bug). onOpenChange is no
    // longer used to close — AdvShell reads the same ?create and re-renders shut.
    void setNav({ create: false, picker: null });
  };

  // The membership scope passed to a create when adding into the selected hive.
  const memberHive = mode === 'into-hive' && hiveScope ? hiveScope : undefined;

  const handleSuccess = (slug: string) => {
    // A new top-level hive (no membership scope) is a root; an into-hive create
    // carries the scope so the caller can focus the new member (P-011). Keep the
    // single-arg call for the root path (back-compat with existing callers).
    const createdInto = memberHive;
    // onCreated is now SIDE-EFFECTS ONLY (refresh/localStorage) — AdvShell no
    // longer writes ?slug/?harness there, so the focus-write here is OURS and goes
    // in the SAME atomic nav write as the step move (no same-tick clobber). The
    // modal STAYS OPEN (create untouched) and advances to share-offer.
    if (createdInto) onCreated?.(slug, { hive: createdInto });
    else onCreated?.(slug);
    setCreatedSlug(slug);
    // A root hive publishes itself; a member publishes its parent hive.
    setCreatedPotSlug(memberHive ?? slug);
    // into-hive: focus the new member via ?harness, keep ?slug on the hive;
    // new root: focus the new hive via ?slug. Both folded into one write.
    if (createdInto) void setNav({ picker: 'share-offer', harness: slug });
    else void setNav({ picker: 'share-offer', slug, harness: null });
  };

  // P-006: work + Comb-blueprint ALWAYS create a NEW top-level hive — never an
  // into-hive member, regardless of any selected hiveScope. They use this
  // dedicated success path that treats the result as a root hive (focus it via
  // ?slug and advance to the share-offer/publish step), bypassing the
  // memberHive fork in handleSuccess.
  const handleNewHiveSuccess = (slug: string) => {
    onCreated?.(slug);
    setCreatedSlug(slug);
    setCreatedPotSlug(slug);
    void setNav({ picker: 'share-offer', slug, harness: null });
  };

  const goBack = () => setStep('picker');

  // For Entries 1/3 (new-local, existing-local) the harness is freshly
  // local and may want to be shared, so the share offer follows the create.
  const showShareOffer =
    step === 'share-offer' &&
    createdSlug !== null;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(v) => { if (!v) handleClose(); else void onOpenChange(true); }}
        title={step === 'share-offer' && createdSlug ? `${t('pot')} created` : `Add a ${t('pot')}`}
        contentStyle={{
          width: 'min(520px, 96vw)',
          background: 'var(--bg-popover, #0d1829)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          color: 'var(--fg, #e8e8ea)',
        }}
      >
        {/* A deep-linked `?picker=share-offer` has no created slug (transient
            result state is useState) — fall back to the grid. */}
        {(step === 'picker' || (step === 'share-offer' && createdSlug === null)) && (
          <PickerStep onSelect={setStep} onClose={handleClose} mode={mode} onMode={setMode} hiveScope={hiveScope} hiveLabel={hiveLabel} combLabel={combLabel} githubUrlEnabled={githubUrlEnabled} />
        )}
        {step === 'new-local' && <NewLocalForm onBack={goBack} onSuccess={handleSuccess} hive={memberHive} hiveLabel={hiveLabel} />}
        {step === 'existing-local' && <ExistingLocalForm onBack={goBack} onSuccess={handleSuccess} hive={memberHive} hiveLabel={hiveLabel} />}
        {/* P-006: a work hive is a fresh-dir create with the work blueprint —
            always a NEW top-level hive (no into-hive), so it uses
            handleNewHiveSuccess. Reuses NewLocalForm with domain="work". */}
        {step === 'work-hive' && (
          <NewLocalForm onBack={goBack} onSuccess={handleNewHiveSuccess} hiveLabel={hiveLabel} domain="work" blueprintId={WORK_HIVE_BLUEPRINT_ID} />
        )}
        {/* P-006: instantiate a published Comb blueprint — install it (installed
            tier) then create a hive running it. Always a NEW top-level hive. */}
        {step === 'comb-blueprint' && (
          <CupboardBlueprintForm onBack={goBack} onCreated={handleNewHiveSuccess} hiveLabel={hiveLabel} />
        )}
        {step === 'github-url' && !githubUrlEnabled && <ComingSoonStub title="GitHub URL" onBack={goBack} />}
        {step === 'github-url' && githubUrlEnabled && (
          <EntryGithubSearchForm
            onBack={goBack}
            hiveScope={hiveScope}
            // The entry's own 3-mode fork (P-012): the picker's into-hive
            // selection carries over; otherwise the headline new-hive default.
            // The search panel threads this into the create form it opens (P-009).
            initialMode={mode === 'into-hive' && hiveScope ? 'into-hive' : 'new-hive'}
            onCreated={(slug, opts) => {
              // The create form already showed its own success/publish summary
              // (and a hive auto-publishes per visibility) — skip the share offer
              // and CLOSE. onCreated is side-effects only now; the focus-write
              // (?slug / ?harness) and the close (?create=false, ?picker=null) go
              // in ONE atomic nav write so the adapter can't drop the close (the
              // stuck-modal bug). into-hive focuses the member via ?harness and
              // keeps ?slug on the hive; a new root focuses it via ?slug.
              onCreated?.(slug, opts);
              setCreatedSlug(null);
              setCreatedPotSlug(null);
              setMode(hiveScope ? 'into-hive' : 'standalone');
              if (opts?.hive) void setNav({ create: false, picker: null, harness: slug });
              else void setNav({ create: false, picker: null, slug, harness: null });
            }}
          />
        )}
        {/* P-006 (hive-from-repo-hardening): the invitee side — joining the
            invite directory creates no harness, so Done just closes. */}
        {step === 'hive-invite' && (
          <HiveInviteForm onBack={goBack} onDone={handleClose} hiveLabel={hiveLabel} />
        )}
        {showShareOffer && createdSlug && (
          <ShareOfferStep
            slug={createdSlug}
            potSlug={createdPotSlug}
            hiveLabel={hiveLabel}
            onDone={handleClose}
          />
        )}
      </Modal>
    </>
  );
}

// ── Share-offer step ───────────────────────────────────────────────────────
// Per-harness sharing is retired (comb-retire-per-harness-sharing-2026-06-11):
// the offer is hive-publish (when the create has a home hive) or nothing.

function ShareOfferStep({
  slug,
  potSlug,
  hiveLabel,
  onDone,
}: {
  slug: string;
  /** The created harness's home hive (or the new hive itself); null = standalone. */
  potSlug: string | null;
  hiveLabel: string;
  onDone: () => void;
}) {
  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>
        ✓ {hiveLabel} created
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--fg-dim)' }}>
        <code>{slug}</code> is registered.
      </p>
      {potSlug ? (
        <div style={{ marginBottom: 16 }}>
          <PublishPotCard potSlug={potSlug} hiveLabel={hiveLabel.toLowerCase()} />
        </div>
      ) : (
        <p data-testid="share-offer-standalone-note" style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-dim)' }}>
          Sharing happens at the {hiveLabel.toLowerCase()} level — publish it to let others collaborate.
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDone}
          style={{
            padding: '8px 14px',
            background: 'transparent',
            color: 'var(--fg-dim)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
