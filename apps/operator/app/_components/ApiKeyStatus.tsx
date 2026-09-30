'use client';

import { useEffect, useState } from 'react';

/**
 * ⚠ NOT MOUNTED anywhere in the product as of 2026-08-09 — measured while doing
 * inference-rename-and-provider-agnostic-default-2026-08-09 P-004: the only references to
 * `<ApiKeyStatus>` in apps/ are its own test and stories. Its docstring calls it "the header
 * pill", which is what it USED to be. It is kept (and kept correct) rather than deleted
 * because that is a retirement decision nobody has asked for; do not assume changing it
 * affects a live surface.
 */
interface Status {
  /** Still returned by /api/credentials as a legacy fall-through (D-001), no longer surfaced. */
  anthropic_api_key: string | null;
  openai_api_key: string | null;
  github_pat: string | null;
}

export default function ApiKeyStatus() {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    fetch('/api/credentials', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (status === null) {
    return <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>checking…</span>;
  }

  // Keyed on the OPENAI EMBEDDINGS key since
  // inference-rename-and-provider-agnostic-default-2026-08-09 P-004. It used to warn on a
  // missing ANTHROPIC key, which is no longer a gap at all: Anthropic access comes from the
  // default account under Settings → Inference, so a box with no Anthropic key is the normal,
  // fully-working configuration. Embeddings are the remaining thing only a raw key can supply,
  // which makes them the honest subject for a "is anything actually missing" pill.
  const openaiOk = !!status.openai_api_key;
  const githubOk = !!status.github_pat;

  const dotColor = openaiOk ? 'var(--good)' : 'var(--warn)';
  const label = openaiOk
    ? `Embeddings key set${githubOk ? ' · GitHub' : ''}`
    : 'OpenAI embeddings key not set';

  return (
    <span
      title={`openai (embeddings): ${openaiOk ? '✓' : '✗'} · github: ${githubOk ? '✓' : '—'}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-mute)' }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          // Use the `background-color` longhand (not the `background` shorthand): a
          // color-only value is all we set, and jsdom's cssstyle validates the
          // `background` shorthand's `var()` inconsistently across versions (drops it
          // to '' on some), which flip-flaked ApiKeyStatus.test.tsx. The longhand
          // preserves `var()` verbatim and is identical in real browsers. (EI-10455)
          backgroundColor: dotColor,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}
