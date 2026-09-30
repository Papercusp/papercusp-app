'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * SharePotDialog / SharePotForm — the real share surface for a hive
 * (comb-hive-native-sharing-2026-06-11 P-004). Replaces the retired
 * default-public one-click publish with an explicit choice:
 *
 *   - visibility (public / invite / private) with consequence copy per option
 *   - title + description (the directory listing's face)
 *   - the member repos the publish will list (derived server-side, fresh)
 *   - the `papercusp://pot` invite artifact for invite mode — REUSING the
 *     stored secret on edit (re-minting would orphan every link already
 *     handed out; mint only when none exists)
 *
 * SharePotForm is the embeddable core: PublishPotCard (the picker's
 * share-offer) embeds it as its minimal form; the hive header strip opens it
 * centered via SharePotDialog (a Modal wrapper). Data flows through
 * injectable seams for tests:
 *
 *   - fetchShareMeta: GET /api/discovery/pot-meta (prefill + pubkey + repos)
 *   - setHiveListing: POST /api/discovery/set-pot (the one flip composition)
 */

import React, { useEffect, useState } from 'react';
import { Check, Copy, Globe, Link2, Lock } from 'lucide-react';
import { formatHiveInviteLink } from '@papercusp/operator-core/lib/harness/hive-invite-link';
import { Modal } from './Modal';
import { HowSharingWorks } from '../_components/HowSharingWorks';
import { useLexicon } from '@/lib/useLexicon';
import { Button } from './Button';
import { TextArea, TextInput } from './TextInput';

export type HiveShareVisibility = 'public' | 'invite' | 'private';

/** The owner's share-state projection (GET /api/discovery/pot-meta). */
export interface HiveShareMeta {
  potId: string;
  /** false = never published (the "unpublished" chrome state). */
  found: boolean;
  visibility: HiveShareVisibility | null;
  title: string;
  description: string;
  /** Stored invite secret — lets the owner re-copy the artifact. */
  inviteSecret: string | null;
  /** The hive's Ed25519 identity pubkey (base64) for the FULL invite link. */
  hivePubkey: string | null;
  /** Member repos the next publish will list, encoded `owner/repo[#id]`. */
  memberRepos: string[];
}

export interface SetHiveOutcome {
  ok: boolean;
  announced?: boolean;
  /** Deceptive-publish fix: swarm peers the announce actually reached. 0 (with
   *  announced=true) means it was broadcast into the void — registered, not yet
   *  discoverable — so the UI says so instead of claiming a successful publish. */
  reachablePeers?: number;
  withdrawn?: boolean;
  error?: string;
}

/** Default meta read: GET /api/discovery/pot-meta. null on any failure. */
export async function defaultFetchShareMeta(potSlug: string): Promise<HiveShareMeta | null> {
  try {
    const res = await fetch(`/api/discovery/pot-meta?potId=${encodeURIComponent(potSlug)}`);
    if (!res?.ok) return null;
    const body = (await res.json()) as Partial<HiveShareMeta>;
    return {
      potId: String(body.potId ?? potSlug),
      found: body.found === true,
      visibility:
        body.visibility === 'public' || body.visibility === 'invite' || body.visibility === 'private'
          ? body.visibility
          : null,
      title: typeof body.title === 'string' && body.title ? body.title : potSlug,
      description: typeof body.description === 'string' ? body.description : '',
      inviteSecret: typeof body.inviteSecret === 'string' ? body.inviteSecret : null,
      hivePubkey: typeof body.hivePubkey === 'string' ? body.hivePubkey : null,
      memberRepos: Array.isArray(body.memberRepos) ? body.memberRepos.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Default write: POST /api/discovery/set-pot (the one flip composition). */
export async function defaultSetHiveListing(input: {
  potId: string;
  title: string;
  description: string;
  visibility: HiveShareVisibility;
  inviteSecret?: string;
}): Promise<SetHiveOutcome> {
  try {
    const res = await fetch('/api/discovery/set-pot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as SetHiveOutcome & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    return { ok: true, announced: body.announced, reachablePeers: body.reachablePeers, withdrawn: body.withdrawn };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 24 random bytes as 48 hex chars — same shape the header strip minted. */
function mintInviteSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Display form of an encoded member-repo ref: drop the `#<id>` suffix. */
function repoRefDisplay(ref: string): string {
  return ref.replace(/#\d+$/, '');
}

/**
 * Visibility choices + their consequence copy. A function (not a const) so the
 * "Comb"→lexicon noun resolves live: `comb` is the active brand word for the
 * shared library (t('cupboard') → "Cupboard" public / "Comb" the-hive) —
 * restore-pot-lexicon P-006/P-007.
 */
function visibilityOptions(comb: string): ReadonlyArray<{
  value: HiveShareVisibility;
  label: string;
  Icon: typeof Globe;
  /** Consequence copy — what picking this actually does. */
  copy: string;
}> {
  return [
    {
      value: 'public',
      label: 'Public',
      Icon: Globe,
      copy: `Listed on the P2P directory and browsable in the ${comb}. The member repos below are indexed; anyone can join in one click.`,
    },
    {
      value: 'invite',
      label: 'Invite-only',
      Icon: Link2,
      copy: 'Unlisted — announced only on an invite-scoped topic. Joining requires the invite link below; nothing is indexed publicly.',
    },
    {
      value: 'private',
      label: 'Private',
      Icon: Lock,
      copy: `Stops sharing via discovery: the published listing is withdrawn and ${comb} rows unlisted, and peers drop the announce. Members who already joined keep reading new content over the existing topic — only Dissolve cuts off an existing reader.`,
    },
  ];
}

export interface ShareHiveFormProps {
  potSlug: string;
  /** Lexicon-resolved noun for copy ("hive" / "pot"). */
  hiveLabel?: string;
  /** Tighter spacing for embedded contexts (the picker share-offer card). */
  compact?: boolean;
  /** Fired after a successful save with the saved visibility (chrome refresh). */
  onSaved?: (visibility: HiveShareVisibility) => void;
  /** Injection seams for tests. Defaults hit the loopback routes. */
  fetchShareMeta?: (potSlug: string) => Promise<HiveShareMeta | null>;
  setHiveListing?: typeof defaultSetHiveListing;
}

export function SharePotForm({
  potSlug,
  hiveLabel = 'hive',
  compact = false,
  onSaved,
  fetchShareMeta = defaultFetchShareMeta,
  setHiveListing = defaultSetHiveListing,
}: ShareHiveFormProps) {
  const t = useLexicon();
  const visibilityCards = visibilityOptions(t('cupboard'));
  // Mid-edit drafts + load/save lifecycle — render state, not URL state.
  const [meta, setMeta] = useState<HiveShareMeta | null>(null);
  const [metaLoaded, setMetaLoaded] = useState(false);
  const [title, setTitle] = useState(potSlug);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<HiveShareVisibility>('public');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SetHiveOutcome | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setMetaLoaded(false);
    void fetchShareMeta(potSlug).then((m) => {
      if (!alive) return;
      setMetaLoaded(true);
      if (!m) return;
      setMeta(m);
      setTitle(m.title);
      setDescription(m.description);
      // Preselect the live state for a published hive; a withdrawn or
      // never-published hive opens on the headline choice (public) — the
      // owner came here to share.
      if (m.visibility === 'public' || m.visibility === 'invite') setVisibility(m.visibility);
      // Recover the invite artifact for an already-invite hive — the strip
      // used to show it exactly once and lose it.
      if (m.visibility === 'invite' && m.inviteSecret) {
        setInviteLink(
          formatHiveInviteLink({
            ...(m.hivePubkey ? { pubkeyBase64: m.hivePubkey } : {}),
            secret: m.inviteSecret,
            title: m.title,
          }),
        );
      }
    });
    return () => {
      alive = false;
    };
  }, [potSlug, fetchShareMeta]);

  async function submit(): Promise<void> {
    // Reuse the stored secret on edit — re-minting orphans every link already
    // handed out. Mint only when this hive has never had one.
    const inviteSecret =
      visibility === 'invite' ? (meta?.inviteSecret ?? mintInviteSecret()) : undefined;
    setBusy(true);
    setOutcome(null);
    setInviteCopied(false);
    const res = await setHiveListing({
      potId: potSlug,
      title: title.trim() || potSlug,
      description: description.trim(),
      visibility,
      ...(inviteSecret ? { inviteSecret } : {}),
    });
    setBusy(false);
    setOutcome(res);
    if (res.ok) {
      if (visibility === 'invite' && inviteSecret) {
        setMeta((m) => (m ? { ...m, visibility, inviteSecret } : m));
        setInviteLink(
          formatHiveInviteLink({
            ...(meta?.hivePubkey ? { pubkeyBase64: meta.hivePubkey } : {}),
            secret: inviteSecret,
            title: title.trim() || potSlug,
          }),
        );
      } else {
        setMeta((m) => (m ? { ...m, visibility } : m));
        setInviteLink(null);
      }
      onSaved?.(visibility);
    }
  }

  const currentState = meta?.found
    ? (meta.visibility ?? 'private')
    : metaLoaded
      ? 'unpublished'
      : null;
  const memberRepos = meta?.memberRepos ?? [];
  const submitLabel = busy
    ? 'Saving…'
    : visibility === 'private'
      ? 'Withdraw from directory'
      : visibility === 'invite'
        ? 'Publish invite-only'
        : `Publish ${hiveLabel}`;

  return (
    <div className={compact ? 'pc-share-pot pc-share-pot--compact' : 'pc-share-pot'} data-testid="share-pot-form">
      {currentState && (
        <div className="pc-share-pot__current" data-testid="share-pot-current">
          Currently: <strong>{currentState}</strong>
        </div>
      )}

      <div className="pc-share-pot__viz" role="group" aria-label="Visibility">
        {visibilityCards.map(({ value, label, Icon, copy }) => (
          <button
            key={value}
            type="button"
            className="pc-share-pot__viz-card"
            data-testid={`share-pot-viz-${value}`}
            aria-pressed={visibility === value}
            disabled={busy}
            onClick={() => setVisibility(value)}
          >
            <span className="pc-share-pot__viz-head">
              <Icon size={13} aria-hidden /> {label}
            </span>
            <span className="pc-share-pot__viz-copy">{copy}</span>
          </button>
        ))}
      </div>

      <label className="pc-share-pot__field">
        <span className="pc-share-pot__field-label">Title</span>
        <TextInput
          data-testid="share-pot-title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={potSlug}
        />
      </label>
      <label className="pc-share-pot__field">
        <span className="pc-share-pot__field-label">Description</span>
        <TextArea
          data-testid="share-pot-description"
          value={description}
          rows={compact ? 2 : 3}
          maxLength={1000}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={`What is this ${hiveLabel} about?`}
        />
      </label>

      {memberRepos.length > 0 && (
        <div className="pc-share-pot__repos" data-testid="share-pot-repos">
          <span className="pc-share-pot__field-label">
            {visibility === 'private'
              ? `Member repos that will be unlisted (${memberRepos.length})`
              : `Member repos that will be listed (${memberRepos.length})`}
          </span>
          <ul className="pc-share-pot__repo-list">
            {memberRepos.map((ref) => (
              <li key={ref}>
                <code>{repoRefDisplay(ref)}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {inviteLink && (
        <div className="pc-share-pot__invite" data-testid="share-pot-invite">
          <span className="pc-share-pot__field-label">Invite link — share it with collaborators</span>
          <span className="pc-share-pot__invite-row">
            <code className="pc-share-pot__invite-code" data-testid="share-pot-invite-link" title={inviteLink}>
              {inviteLink}
            </code>
            <Tooltip label="Copy the invite link"><button
              type="button"
              className="pc-share-pot__copy"
              data-testid="share-pot-invite-copy"

              onClick={() => {
                void navigator.clipboard
                  .writeText(inviteLink)
                  .then(() => setInviteCopied(true))
                  .catch(() => {});
              }}
            >
              {inviteCopied ? (
                <>
                  <Check size={12} aria-hidden /> copied
                </>
              ) : (
                <>
                  <Copy size={12} aria-hidden /> copy
                </>
              )}
            </button></Tooltip>
          </span>
        </div>
      )}

      {outcome && (
        <div
          className="pc-share-pot__outcome"
          data-testid="share-pot-outcome"
          style={{ color: outcome.ok ? 'var(--good, #34d399)' : 'var(--bad, #e64646)' }}
        >
          {outcome.ok
            ? outcome.withdrawn
              ? `Withdrawn — the ${hiveLabel} is no longer shared.`
              : outcome.announced
                ? (outcome.reachablePeers ?? 0) > 0
                  ? `Published — announced to ${outcome.reachablePeers} connected peer${outcome.reachablePeers === 1 ? '' : 's'}.`
                  : 'Published & registered, but no peers are connected yet — it becomes discoverable once peers come online.'
                : 'Saved (announce pending transport).'
            : `Failed: ${outcome.error ?? 'unknown error'}`}
        </div>
      )}

      <div className="pc-share-pot__actions">
        <Button
          variant={visibility === 'private' ? 'destructive' : 'primary'}
          data-testid="share-pot-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
      <ShareHiveStyles />
    </div>
  );
}

export interface ShareHiveDialogProps extends ShareHiveFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The centered Share-Hive surface — the hive header's Share target. */
export function SharePotDialog({ open, onOpenChange, ...form }: ShareHiveDialogProps) {
  const label = form.hiveLabel ?? 'hive';
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Share ${label}`}
      srOnlyTitle
      contentStyle={{
        width: 480,
        maxWidth: '90vw',
        maxHeight: '85vh',
        overflowY: 'auto',
        background: 'var(--bg-1, #0d1726)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 18,
      }}
    >
      <h2 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
        Share {label} <code>{form.potSlug}</code>
      </h2>
      <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--fg-dim)' }}>
        Sharing happens at the {label} level — choose who can find and join it.
      </p>
      {/* P-012: the in-UI explainer is reachable from the Share dialog (D-004). */}
      <p style={{ margin: '0 0 14px' }}>
        <HowSharingWorks />
      </p>
      <SharePotForm {...form} />
    </Modal>
  );
}

function ShareHiveStyles() {
  return (
    <style>{`
      .pc-share-pot { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
      .pc-share-pot--compact { gap: 9px; font-size: 12.5px; }
      .pc-share-pot__current { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); }
      .pc-share-pot__current strong { color: var(--fg-dim, #b9d4e8); font-weight: 650; }
      .pc-share-pot__viz { display: flex; flex-direction: column; gap: 6px; }
      .pc-share-pot__viz-card {
        display: flex;
        flex-direction: column;
        gap: 3px;
        text-align: left;
        padding: 8px 10px;
        background: var(--bg-2, #101c2e);
        color: var(--fg-dim, #b9d4e8);
        border: 1px solid var(--border, #1e3349);
        border-radius: 6px;
        cursor: pointer;
        font: inherit;
      }
      .pc-share-pot__viz-card:hover:not(:disabled) {
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 55%);
      }
      .pc-share-pot__viz-card[aria-pressed='true'] {
        border-color: var(--accent, #38bdf8);
        background: color-mix(in oklab, var(--accent, #38bdf8), transparent 92%);
        color: var(--fg, #e7f7ff);
      }
      .pc-share-pot__viz-card:disabled { opacity: 0.6; cursor: default; }
      .pc-share-pot__viz-head {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-weight: 650;
        font-size: 12.5px;
      }
      .pc-share-pot__viz-copy { font-size: 11.5px; color: var(--fg-mute, #7f9bb4); line-height: 1.4; }
      .pc-share-pot__field { display: flex; flex-direction: column; gap: 4px; }
      .pc-share-pot__field-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--fg-mute, #7f9bb4);
        text-transform: uppercase;
        letter-spacing: 0;
      }
      .pc-share-pot__repos { display: flex; flex-direction: column; gap: 4px; }
      .pc-share-pot__repo-list {
        margin: 0;
        padding: 0 0 0 16px;
        font-size: 12px;
        color: var(--fg-dim, #b9d4e8);
        max-height: 110px;
        overflow-y: auto;
      }
      .pc-share-pot__invite { display: flex; flex-direction: column; gap: 4px; }
      .pc-share-pot__invite-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .pc-share-pot__invite-code {
        font-size: 11px;
        color: var(--fg-dim, #b9d4e8);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .pc-share-pot__copy {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 0 0 auto;
        padding: 2px 9px;
        font-size: 11px;
        font-weight: 600;
        color: var(--fg-dim, #b9d4e8);
        background: transparent;
        border: 1px solid color-mix(in oklab, var(--accent, #38bdf8), transparent 78%);
        border-radius: 999px;
        cursor: pointer;
      }
      .pc-share-pot__copy:hover {
        color: var(--fg, #e7f7ff);
        border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 45%);
      }
      .pc-share-pot__outcome { font-size: 12px; }
      .pc-share-pot__actions { display: flex; justify-content: flex-end; }
    `}</style>
  );
}
