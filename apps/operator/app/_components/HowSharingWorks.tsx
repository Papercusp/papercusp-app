'use client';

/**
 * HowSharingWorks — the in-UI "how sharing works" explainer
 * (comb-hive-native-sharing-2026-06-11 P-012, D-004). A compact,
 * progressive-disclosure panel reachable from the Comb header, the Share-Hive
 * dialog, and the create picker. The confusion this answers is in-flow (what
 * does Share do? what is "claimed"? what do I get when I join?) so the
 * explanation is in-product copy, NOT docs links — a "learn more" deep link is
 * only the tail (D-004).
 *
 * Drop `<HowSharingWorks />` anywhere a trigger belongs: it renders a "How
 * sharing works" text button and owns the modal. Open-state rides the `?explain`
 * nuqs param (user-meaningful → URL, agent-drivable via ui:get_state/dispatch).
 *
 * Copy is grounded in /internal/docs/agent-insights/hive-scoped-federation and
 * lexicon-bound (Hive/Comb ⇄ Pot/Cupboard). The claimed/unclaimed section
 * reuses CLAIM_STATUS_COPY — the SINGLE copy source it shares with the
 * claim-badge tooltips (P-003).
 *
 * Sections use Radix Collapsible per the app design primitives.
 */

import { type CSSProperties, type ReactNode } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { Modal } from '../harness/Modal';
import { useLexicon } from '@/lib/useLexicon';
import { CLAIM_STATUS_COPY } from './ClaimStatusBadge';

const DEFAULT_LINK_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  fontSize: 12,
  fontFamily: 'inherit',
  textDecoration: 'underline',
};

/**
 * The trigger + modal. Drop it wherever the "How sharing works" link belongs;
 * `linkStyle` tunes the trigger to its surface (the Comb header passes its own
 * muted color). The modal is shared — open-state is the `?explain` param.
 */
export function HowSharingWorks({
  linkStyle,
  label = 'How sharing works',
}: {
  linkStyle?: CSSProperties;
  label?: string;
}) {
  const [explain, setExplain] = useQueryState('explain', parseAsStringEnum(['sharing']));
  return (
    <>
      <button
        type="button"
        data-testid="how-sharing-works-link"
        onClick={() => void setExplain('sharing')}
        style={{ ...DEFAULT_LINK_STYLE, ...linkStyle }}
      >
        {label}
      </button>
      <HowSharingWorksModal open={explain === 'sharing'} onClose={() => void setExplain(null)} />
    </>
  );
}

function Section({ summary, children, open }: { summary: string; children: ReactNode; open?: boolean }) {
  return (
    <Collapsible.Root
      defaultOpen={open}
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '0 12px',
        marginBottom: 8,
      }}
    >
      <Collapsible.Trigger
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--fg)',
          padding: '10px 0',
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        {summary}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div style={{ fontSize: 12.5, lineHeight: 1.6, color: 'var(--fg-dim)', padding: '0 0 12px' }}>
          {children}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** The explainer modal itself — exported for callers that own their own open-state. */
export function HowSharingWorksModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useLexicon();
  const Hive = t('pot');
  const hive = t('pot', { lower: true });
  const hives = t('pot', { lower: true, plural: true });
  const Comb = t('cupboard');

  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title="How sharing works"
      contentStyle={{
        width: 'min(560px, 96vw)',
        maxHeight: '85vh',
        overflowY: 'auto',
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
        color: 'var(--fg, #e8e8ea)',
      }}
    >
      <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>How sharing works</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        A short tour of {hives}, publishing, joining, and what “claimed” means.
      </p>

      <Section summary={`What's a ${hive}?`} open>
        A {hive} is a <strong style={{ color: 'var(--fg)' }}>project</strong> — its harnesses, plans, and
        settings — with its own cryptographic identity (an Ed25519 keypair). That keypair is what other
        people join; the member repos are what it’s built around. A {hive} can hold one repo or many.
      </Section>

      <Section summary={`Publishing — listing a ${hive} so others can find it`}>
        Publishing lists your {hive} on the peer-to-peer directory and indexes its member repos in the{' '}
        {Comb}. You pick the visibility:
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li><strong style={{ color: 'var(--fg)' }}>Public</strong> — discoverable by anyone on the network; contributors’ GitHub identities are visible.</li>
          <li><strong style={{ color: 'var(--fg)' }}>Invite-only</strong> — hidden from the directory; joinable only with the invite link.</li>
          <li><strong style={{ color: 'var(--fg)' }}>Private</strong> — nothing leaves your machine. No announce, no listing. Publish later anytime.</li>
        </ul>
      </Section>

      <Section summary={`Joining — what you get, what the owner sees`}>
        Joining clones the {hive}’s member repos to your machine and <strong style={{ color: 'var(--fg)' }}>federates</strong>{' '}
        its shared workspace — messages, plans, presence, and file locks sync across everyone’s machines
        over the {hive}’s topic. You’re admitted to the <em>whole</em> {hive} at once, not repo by repo.
        The owner sees you as a contributor and can revoke you — revocation stops your writes across every
        member repo at once. If you already joined, you keep read access to the {hive}'s new content until
        it's dissolved. What you get: the repos plus the live shared coordination. What the owner controls:
        who's admitted.
      </Section>

      <Section summary="Claimed vs unclaimed — a trust signal, not ownership">
        <p style={{ margin: '0 0 8px' }}>{CLAIM_STATUS_COPY.claimed}</p>
        <p style={{ margin: 0 }}>{CLAIM_STATUS_COPY.unclaimed}</p>
      </Section>

      <Section summary="Invite links">
        An invite link (<code>papercusp://pot?…</code>) lets someone join an invite-only {hive} without it
        appearing in the public directory. The secret is shown <strong style={{ color: 'var(--fg)' }}>once</strong>{' '}
        at publish — share it only with people you’re inviting; anyone holding the link can join.
      </Section>

      <Section summary={`${Hive}s vs blueprints vs plugins & packs`}>
        Three different things you can share — the {Comb} browses all of them:
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          <li>A <strong style={{ color: 'var(--fg)' }}>blueprint</strong> is a recipe you <em>fork</em> — a work-pipeline shape.</li>
          <li>A <strong style={{ color: 'var(--fg)' }}>plugin</strong> or <strong style={{ color: 'var(--fg)' }}>pack</strong> is a set of tools you <em>install</em>.</li>
          <li>A <strong style={{ color: 'var(--fg)' }}>{hive}</strong> is a project you <em>join</em> to collaborate on.</li>
        </ul>
      </Section>

      <p style={{ margin: '14px 0 0', fontSize: 11.5, color: 'var(--fg-mute)' }}>
        Want the deep dive?{' '}
        <a href="/internal/docs/agent-insights/hive-scoped-federation" style={{ color: 'var(--accent)' }}>
          How federation works →
        </a>
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 18 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: 'pointer', fontWeight: 600 }}
        >
          Got it
        </button>
      </div>
    </Modal>
  );
}
