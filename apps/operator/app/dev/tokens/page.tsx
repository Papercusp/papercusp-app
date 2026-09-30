/**
 * /dev/tokens — visual gallery of every DTCG-derived CSS variable.
 * Source-of-truth: _brand-primitives.css and _semantic.css (generated).
 * Serves as a baseline for visual regression when tokens are retuned.
 */
'use client';

const PRIMITIVE_COLORS = [
  'sky-100', 'sky-200', 'sky-300', 'sky-400', 'sky-500', 'sky-700',
  'sky-cool', 'sky-hero',
  'slate-300', 'slate-400',
  'emerald-400', 'rose-400', 'amber-400', 'gold-400',
];

const SEMANTIC_BG = ['bg', 'bg-1', 'bg-2', 'bg-3', 'bg-4', 'bg-popover'];
const SEMANTIC_FG = ['fg', 'fg-dim', 'fg-mute'];
const SEMANTIC_ACCENT = ['accent', 'accent-strong', 'accent-cool', 'accent-ink'];
const SEMANTIC_STATUS = ['good', 'warn', 'bad'];
const SEMANTIC_BORDER = ['border', 'border-strong'];
const SEMANTIC_OTHER = ['warn-bg', 'warn-border'];

const MOTION = ['ease-out', 'ease-in', 'ease-mid', 'dur-fast', 'dur-normal', 'dur-panel', 'dur-slow'];
const SHADOWS = ['card-shadow', 'frost'];

function Swatch({ name }: { name: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
      <div
        data-token={name}
        style={{
          width: 40,
          height: 24,
          background: `var(--${name})`,
          border: '1px solid var(--border)',
          borderRadius: 4,
        }}
      />
      <code style={{ fontSize: 11, color: 'var(--fg-dim)', minWidth: 130 }}>--{name}</code>
    </div>
  );
}

function Value({ name }: { name: string }) {
  return (
    <div style={{ padding: '3px 0' }}>
      <code data-token={name} style={{ fontSize: 11, color: 'var(--fg)' }}>
        --{name}
      </code>
    </div>
  );
}

function Section({ title, names }: { title: string; names: string[] }) {
  return (
    <section style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 6, textTransform: 'uppercase' }}>{title}</h2>
      {names.map((n) => <Swatch key={n} name={n} />)}
    </section>
  );
}

export default function TokensGallery() {
  return (
    <div style={{ padding: 24, background: 'var(--bg)', minHeight: '100vh', color: 'var(--fg)' }}>
      <h1 style={{ marginBottom: 8 }}>Design tokens gallery</h1>
      <p style={{ color: 'var(--fg-dim)', fontSize: 12, marginBottom: 24 }}>
        Visual regression baseline. Every token rendered from generated <code>_brand-primitives.css</code> + <code>_semantic.css</code>.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24 }}>
        <div>
          <Section title="Primitive colors" names={PRIMITIVE_COLORS} />
        </div>
        <div>
          <Section title="Semantic — backgrounds" names={SEMANTIC_BG} />
          <Section title="Semantic — foreground" names={SEMANTIC_FG} />
          <Section title="Semantic — accent" names={SEMANTIC_ACCENT} />
        </div>
        <div>
          <Section title="Semantic — status" names={SEMANTIC_STATUS} />
          <Section title="Semantic — border" names={SEMANTIC_BORDER} />
          <Section title="Other surfaces" names={SEMANTIC_OTHER} />
          <section style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 6, textTransform: 'uppercase' }}>Motion</h2>
            {MOTION.map((n) => <Value key={n} name={n} />)}
          </section>
          <section>
            <h2 style={{ fontSize: 11, color: 'var(--fg-mute)', marginBottom: 6, textTransform: 'uppercase' }}>Shadows / overlay</h2>
            {SHADOWS.map((n) => <Value key={n} name={n} />)}
          </section>
        </div>
      </div>
    </div>
  );
}
