'use client';

/**
 * IdentitySurface — what an identity listing will do, shown BEFORE install
 * (portable-identity-packages P-016).
 *
 * Renders the listing's declared surface (`identity_surface`, worker migration
 * 035): slots, context contributions and where they inject, sync and async
 * hooks, bundled packages, knowledge-pack memories and docs, class contracts,
 * grants and the permission lines install asks consent for. The publisher
 * derived it from the closure it signed and install recomputes it from the
 * verified clone, refusing a listing whose surface differs — so this preview
 * cannot describe less than what installs.
 *
 * Fail-soft: an unreadable surface renders a notice instead of blanking the
 * page. Install itself refuses such a listing; the notice says so.
 */
import React from 'react';
import {
  parseIdentityListingSurface,
  type IdentityListingSurface,
} from '@papercusp/operator-core/lib/cupboard/identity-listing-surface-wire';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';

const box: React.CSSProperties = {
  marginTop: SIZES.md,
  background: COLORS.surface,
  border: `1px solid ${COLORS.border}`,
  borderRadius: RADIUS.lg,
  padding: SIZES.md,
};

const heading: React.CSSProperties = {
  fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, textTransform: 'uppercase', margin: '10px 0 4px',
};

const note: React.CSSProperties = { fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' };

const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 };

const mono: React.CSSProperties = { fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text };

const muted: React.CSSProperties = { fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted };

function Group({ title, testId, count, children }: {
  title: string; testId: string; count: number; children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section data-testid={testId} data-count={count}>
      <div style={heading}>{title} · {count}</div>
      <ul style={list}>{children}</ul>
    </section>
  );
}

function Contributions({ surface }: { surface: IdentityListingSurface }) {
  return (
    <Group title="Context contributions" testId="identity-surface-contributions" count={surface.contributions.length}>
      {surface.contributions.map((c) => (
        <li key={c.id} data-contribution={c.id}>
          <code style={mono}>{c.id}</code>{' '}
          <span style={muted}>{c.inputKind} {c.ref}{c.verb ? ` · ${c.verb}` : ''} · refresh {c.refresh}</span>
          {c.injection ? (
            <div style={muted} data-testid="identity-surface-injection">
              injects into {c.injection.sinks.join(', ')} · {c.injection.timing} · ≤{c.injection.tokenBudget} tokens
              · priority {c.injection.priority} · over budget: {c.injection.overBudget}
            </div>
          ) : (
            <div style={muted}>read on demand; never injected</div>
          )}
        </li>
      ))}
    </Group>
  );
}

function Hooks({ surface }: { surface: IdentityListingSurface }) {
  const { sync, async: asyncHooks, unreadable } = surface.hooks;
  return (
    <>
      <Group title="Synchronous hooks" testId="identity-surface-sync-hooks" count={sync.length}>
        {sync.map((h) => (
          <li key={h.id}>
            <code style={mono}>{h.id}</code>{' '}
            <span style={muted}>
              {h.kind} on {h.sink} · rule {h.rule}{h.tools?.length ? ` · tools ${h.tools.join(', ')}` : ''}
            </span>
          </li>
        ))}
      </Group>
      <Group title="Asynchronous hooks" testId="identity-surface-async-hooks" count={asyncHooks.length}>
        {asyncHooks.map((h) => (
          <li key={h.id}>
            <code style={mono}>{h.id}</code>{' '}
            <span style={muted}>on {h.on} → {h.fire} · rule {h.rule}</span>
          </li>
        ))}
      </Group>
      <Group title="Rules this build cannot read" testId="identity-surface-unreadable-rules" count={unreadable.length}>
        {unreadable.map((ref) => (
          <li key={ref}><code style={mono}>{ref}</code></li>
        ))}
      </Group>
    </>
  );
}

function Packages({ surface }: { surface: IdentityListingSurface }) {
  return (
    <>
      <Group title="Bundled packages" testId="identity-surface-packages" count={surface.packages.length}>
        {surface.packages.map((p) => (
          <li key={`${p.kind}:${p.ref}`}>
            <code style={mono}>{p.kind}:{p.ref}</code> <span style={muted}>@{p.version}</span>
          </li>
        ))}
      </Group>
      <Group title="Knowledge" testId="identity-surface-knowledge" count={surface.knowledge.length}>
        {surface.knowledge.map((k) => (
          <li key={k.ref}>
            <code style={mono}>{k.ref}</code>{' '}
            <span style={muted}>@{k.version} · {k.memories} {k.memories === 1 ? 'memory' : 'memories'} · {k.docs.length} docs</span>
            {k.docs.length > 0 && (
              <ul style={{ ...list, margin: '2px 0 0 14px' }}>
                {k.docs.map((d) => (
                  <li key={d.id} style={muted}>{d.section} / {d.title}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </Group>
      <Group title="Class contracts" testId="identity-surface-class-contracts" count={surface.classContracts.length}>
        {surface.classContracts.map((c) => (
          <li key={c.ref}><code style={mono}>{c.ref}</code> <span style={muted}>{c.contractHash.slice(0, 19)}…</span></li>
        ))}
      </Group>
    </>
  );
}

function Access({ surface }: { surface: IdentityListingSurface }) {
  const grants = [
    ...surface.grants.requires.map((g) => ({ g, optional: false })),
    ...surface.grants.optional.map((g) => ({ g, optional: true })),
  ];
  return (
    <>
      <Group title="Capability grants" testId="identity-surface-grants" count={grants.length}>
        {grants.map(({ g, optional }) => (
          <li key={g} data-optional={optional ? 'true' : 'false'}>
            <code style={mono}>{g}</code> <span style={muted}>{optional ? 'optional' : 'required'}</span>
          </li>
        ))}
      </Group>
      <Group title="Permissions install asks consent for" testId="identity-surface-permissions" count={surface.permissions.length}>
        {surface.permissions.map((line) => (
          <li key={line} style={mono}>{line}</li>
        ))}
      </Group>
    </>
  );
}

export default function IdentitySurface({ value }: { value: string | null | undefined }) {
  const surface = parseIdentityListingSurface(value);
  if (!surface) {
    return (
      <div style={box} data-testid="identity-surface" data-state="unreadable">
        <div style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.text }}>Identity surface</div>
        <p style={note}>
          This identity listing carries no readable declared surface, so there is nothing to preview. Install refuses an
          identity whose listed surface does not match what its signed release contains.
        </p>
      </div>
    );
  }
  return (
    <div style={box} data-testid="identity-surface" data-state="ok" data-consent={surface.consent}>
      <div style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.text }}>
        What this identity does
      </div>
      <p style={note}>
        <code style={mono}>{surface.identity.id}</code> @{surface.identity.version}
        {surface.identity.slots.length > 0 && <> · fills {surface.identity.slots.join(', ')}</>}
        {' · '}
        {surface.consent === 'content-only'
          ? 'content only: installs without an administrator consent step'
          : 'install asks an administrator to consent to the lines below'}
      </p>
      <p style={note}>
        Derived from the signed release. Install recomputes it from the verified download and refuses a listing whose
        surface differs.
      </p>
      <Contributions surface={surface} />
      <Hooks surface={surface} />
      <Packages surface={surface} />
      <Access surface={surface} />
    </div>
  );
}
