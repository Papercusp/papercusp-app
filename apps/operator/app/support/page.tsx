'use client';

// Carried by the surface (like dev/dev.css): every host that mounts Support natively gets it.
import './support.css';
import RouteLink from '../_components/RouteLink';
import * as Collapsible from '@radix-ui/react-collapsible';

import { SupportChatButton } from '../_components/SupportChatButton';
import { SupportAgentPanel } from '../_components/SupportAgentPanel';
import { Button } from '../harness/Button';
// The CLIENT lexicon twin. `@papercusp/operator-core/lib/lexicon` is the SERVER
// wiring (its configure.ts reaches flag-distinct-id → `node:os` at module scope),
// so importing it from a page drags a Node builtin into every client bundle —
// operator-vite only survives that through Vite's browser-external stub, and the
// Portal's webpack client compilation fails outright on the `node:` scheme
// (portal build #3c, 2026-09-05 03:33Z, WI-2145038).
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';
import { GITHUB_ISSUES_URL, GITHUB_NEW_ISSUE_URL } from '@papercusp/operator-core/lib/canonical-github-identity';

export const metadata = {
  title: 'Support · Papercusp',
};

interface FaqItem {
  q: string;
  a: React.ReactNode;
}

// FAQ copy is built at render from the hook-bound resolver so the project term
// ("Pot"/"Hive") tracks the active brand pack (the-hive-lexicon) reactively,
// rather than freezing at module-eval time.
function buildFaqs(t: BoundLexicon): FaqItem[] {
  return [
  {
    q: "First-run says 'agent CLI not found'. What do I install?",
    a: (
      <>
        <p>
          Install one of the supported agent CLIs globally:
        </p>
        <pre>{`# claude (default)
npm install -g @anthropic-ai/claude-cli

# or omp (set AGENT_BACKEND=omp to use it)
bun add -g @oh-my-pi/pi-coding-agent`}</pre>
        <p>
          You&rsquo;ll need Node.js 20+ on PATH. Verify with <code>claude --version</code> or <code>omp --version</code>. The first-run banner on the home page turns green once Papercusp can find one.
        </p>
      </>
    ),
  },
  {
    q: `I added my API key but the ${t('pot', { lower: true })} still says it can't reach the LLM.`,
    a: (
      <>
        <p>
          Two things to check, in order:
        </p>
        <ol>
          <li>
            Run the agent CLI (<code>claude</code> or <code>omp</code>) directly
            in a terminal. The operator shells out to it for every agent run,
            so if the CLI itself can&rsquo;t reach the provider, neither can
            Papercusp. Re-authenticate with <code>claude /login</code> (or
            export <code>ANTHROPIC_API_KEY</code> for omp) if needed.
          </li>
          <li>
            Check that you&rsquo;re not over your <a href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer">monthly Anthropic quota</a>. The CLI returns a generic &ldquo;can&rsquo;t reach LLM&rdquo; on rate-limit responses.
          </li>
        </ol>
      </>
    ),
  },
  {
    q: `My ${t('pot', { lower: true })} exited unexpectedly. How do I see what happened?`,
    a: (
      <>
        <p>
          The <em>brain</em> tab on the {t('pot')} dashboard shows the last orchestrator decision and the cost-to-date. Two common exit causes:
        </p>
        <ul>
          <li><strong>Cost cap hit</strong> — default <code>maxCostUsd: 10</code>. Raise in <code>~/.papercusp/projects/&lt;name&gt;/.papercusp/config.json</code> and re-run.</li>
          <li><strong>Validator rejection loop</strong> — same feature failing 3 attempts. The dashboard shows the failed feature in red; click it to see validator output and either refine the owning plan (its items / acceptance) or accept the proposal manually.</li>
        </ul>
        <p>For deeper debugging, the embedded <em>pi</em> tab (omp terminal) lets you ask the {t('pot', { lower: true })} questions directly.</p>
      </>
    ),
  },
  {
    q: `Where do I publish my own ${t('pot', { lower: true })} template / plugin?`,
    a: (
      <>
        <p>
          Run <code>papercusp publish</code> from the directory containing your <code>papercusp.json</code>. The CLI handles signing, secret-scanning, and SBOM generation automatically.
        </p>
        <p>
          You'll need a GitHub identity to publish — run <code>papercusp login</code> first. Your namespace is your GitHub login (e.g. <code>@yourname/my-template</code>).
        </p>
        <p>
          Browse what's already there in the <RouteLink href="/cupboard">Cupboard</RouteLink>.
        </p>
      </>
    ),
  },
  {
    q: 'My desktop app says "Apple cannot verify the developer" / Windows SmartScreen warns me.',
    a: (
      <>
        <p>
          Papercusp Desktop v0.0.1 is unsigned (code-signing on the roadmap). The OS warning is expected; Papercusp itself is safe to run.
        </p>
        <ul>
          <li><strong>macOS</strong>: right-click the .app, choose <em>Open</em>, then <em>Open</em> in the dialog.</li>
          <li><strong>Windows</strong>: in the SmartScreen dialog click <em>More info → Run anyway</em>.</li>
          <li><strong>Linux</strong>: no warning; just install the .deb / .rpm.</li>
        </ul>
      </>
    ),
  },
  {
    q: 'How do I reset / start over with a clean install?',
    a: (
      <>
        <p>Two levels of reset:</p>
        <ul>
          <li>
            <strong>Per project</strong>: <code>rm -rf ~/.papercusp/projects/&lt;name&gt;</code>. The project's database schema (<code>harness_&lt;name&gt;</code>) stays — drop it manually with <code>papercusp scaffold-schema --drop &lt;name&gt;</code> if you want a clean slate.
          </li>
          <li>
            <strong>Full reset</strong>: <code>rm -rf ~/.papercusp/</code> (loses all projects, credentials, marketplace cache). The embedded Postgres data is separate — also remove <code>~/.papercusp/embedded-pg-data</code>.
          </li>
        </ul>
      </>
    ),
  },
  ];
}

export default function SupportPage() {
  const t = useLexicon();
  const FAQS = buildFaqs(t);
  return (
    <div className="pc-shell pc-support-shell" style={{ maxWidth: 820, margin: '0 auto', padding: '32px 28px' }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>Support</h1>
      <p className="pc-support-intro" style={{ color: 'var(--fg-mute)', fontSize: 15, marginBottom: 32, lineHeight: 1.55 }}>
        First check the FAQs below — they cover the most common stuck points. If you're still
        blocked, start a chat with our support team or open a GitHub issue.
      </p>

      {/* AI agent panel — try AI first, fall back to human */}
      <SupportAgentPanel surface="operator" />

      {/* Action buttons */}
      <div className="pc-support-actions" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 40 }}>
        <Button asChild size="lg" variant="accent">
          <SupportChatButton message="">💬 Start support chat</SupportChatButton>
        </Button>
        <Button asChild size="lg" variant="accent">
          <a
            href={GITHUB_NEW_ISSUE_URL}
            target="_blank"
            rel="noreferrer"
            style={{ background: 'var(--bg-1)' }}
          >
            🐛 Open a GitHub issue
          </a>
        </Button>
        <Button asChild size="lg" variant="accent">
          <a
            href="https://papercuspai.com/docs/"
            target="_blank"
            rel="noreferrer"
            style={{ background: 'var(--bg-1)' }}
          >
            📚 Browse the docs
          </a>
        </Button>
      </div>

      <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Frequently asked</h2>
      <div className="pc-support-faqs">
        {FAQS.map((f, i) => (
          <Collapsible.Root
            key={i}
            className="pc-support-faq"
            style={{
              padding: '14px 18px',
              marginBottom: 8,
              background: 'var(--bg-1)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}
          >
            <Collapsible.Trigger className="pc-support-faq-summary" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer', fontSize: 15, fontWeight: 600, fontFamily: 'inherit' }}>
              <span className="pc-support-faq-chevron" style={{ marginRight: 8, color: 'var(--fg-mute)' }}>›</span>
              {f.q}
            </Collapsible.Trigger>
            <Collapsible.Content
              className="pc-support-faq-answer"
              style={{
                marginTop: 12,
                color: 'var(--fg-mute)',
                fontSize: 14,
                lineHeight: 1.65,
              }}
            >
              {f.a}
            </Collapsible.Content>
          </Collapsible.Root>
        ))}
      </div>

      <div
        className="pc-support-resources"
        style={{
          marginTop: 40,
          padding: 20,
          background: 'var(--bg-1)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontSize: 14,
          color: 'var(--fg-mute)',
        }}
      >
        <strong style={{ color: 'var(--fg)' }}>Resources:</strong>{' '}
        <a href="https://papercuspai.com/docs/" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>full documentation</a>{' '}·{' '}
        <a href="https://papercusp.com" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>marketing site</a>{' '}·{' '}
        <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>issue tracker</a>{' '}·{' '}
        <RouteLink href="/setup" style={{ color: 'var(--accent)' }}>5-step setup</RouteLink>
      </div>
    </div>
  );
}
