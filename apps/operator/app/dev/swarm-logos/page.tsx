'use client';

import type { SVGProps } from 'react';
import styles from './swarm-logos.module.css';

type LogoOption = {
  id: string;
  name: string;
  mood: string;
  bestFor: string;
  verdict: string;
  Glyph: (props: SVGProps<SVGSVGElement>) => React.JSX.Element;
};

const OPTIONS: LogoOption[] = [
  {
    id: 'swarm-cloud',
    name: 'Swarm Cloud',
    mood: 'Many bees moving as one system around a dark Hive core.',
    bestFor: 'Primary app logo if the product name is The Swarm.',
    verdict: 'Most directly represents the product name: collective motion, not a single bee.',
    Glyph: SwarmCloudGlyph,
  },
  {
    id: 'black-comb',
    name: 'Black Comb',
    mood: 'Industrial honeycomb, precise and dev-tool serious.',
    bestFor: 'Primary app logo and compact sidebar mark.',
    verdict: 'Safest system replacement for cup-era logos.',
    Glyph: BlackCombGlyph,
  },
  {
    id: 'queen-sigil',
    name: 'Queen Sigil',
    mood: 'A crowned command intelligence inside the hive.',
    bestFor: 'Queen avatar, brain/orchestrator surfaces, hero art.',
    verdict: 'Use as the signature mark, not the default app icon.',
    Glyph: QueenSigilGlyph,
  },
  {
    id: 'eclipse-swarm',
    name: 'Eclipse Swarm',
    mood: 'Apocalyptic swarm moving across the sun.',
    bestFor: 'Website hero, splash screen, ominous campaign visuals.',
    verdict: 'Most ominous, less legible at tiny icon sizes.',
    Glyph: EclipseSwarmGlyph,
  },
  {
    id: 'sentinel-bee',
    name: 'Sentinel Bee',
    mood: 'Always-on perimeter bee watching for the Queen.',
    bestFor: 'Operator identity and status indicators.',
    verdict: 'Best candidate for the operator name/mark system.',
    Glyph: SentinelBeeGlyph,
  },
  {
    id: 'hive-eye',
    name: 'Hive Eye',
    mood: 'The hive is watching; every cell is a sensor.',
    bestFor: 'Desktop icon, favicon, empty states.',
    verdict: 'Strong at small sizes, abstract enough to feel premium.',
    Glyph: HiveEyeGlyph,
  },
  {
    id: 'stinger-frame',
    name: 'Stinger Frame',
    mood: 'A sharp frame, a worker body, a warning signal.',
    bestFor: 'CLI/plugin marks and engineering docs.',
    verdict: 'Most technical, least warm.',
    Glyph: StingerFrameGlyph,
  },
];

export default function SwarmLogosPage() {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div>
          <span className={styles.eyebrow}>theswarm.dev logo lab</span>
          <h1>Bee Marks For The End</h1>
          <p>
            Logo directions for replacing the cup-themed Papercusp marks with an ominous
            bee/hive system. The app is The Swarm: people create or join a Hive, and many
            swarms can operate inside that Hive.
          </p>
        </div>
        <div className={styles.heroMark} aria-hidden="true">
          <QueenSigilGlyph />
        </div>
      </section>

      <section className={styles.systemStrip} aria-label="Recommended usage system">
        <article>
          <span>Primary</span>
          <strong>Swarm Cloud or Hive Eye</strong>
          <p>Best for app icon, favicon, sidebar brand, and cup-logo replacement.</p>
        </article>
        <article>
          <span>Brain</span>
          <strong>Queen Sigil</strong>
          <p>Best for the Queen avatar and any orchestration/brain moment.</p>
        </article>
        <article>
          <span>Operator</span>
          <strong>Sentinel Bee</strong>
          <p>Best for the always-on watcher inside a Hive that wakes the Queen when needed.</p>
        </article>
      </section>

      <section className={styles.logoGrid} aria-label="Bee themed logo options">
        {OPTIONS.map((option) => (
          <article key={option.id} className={styles.logoCard}>
            <div className={styles.cardTop}>
              <span>{option.id}</span>
              <code>SVG candidate</code>
            </div>
            <div className={styles.markStage}>
              <option.Glyph />
            </div>
            <div className={styles.lockup}>
              <option.Glyph />
              <div>
                <strong>The Swarm</strong>
                <span>{option.name}</span>
              </div>
            </div>
            <h2>{option.name}</h2>
            <p>{option.mood}</p>
            <dl>
              <div>
                <dt>Best for</dt>
                <dd>{option.bestFor}</dd>
              </div>
              <div>
                <dt>Call</dt>
                <dd>{option.verdict}</dd>
              </div>
            </dl>
            <div className={styles.sizeRow} aria-label={`${option.name} small-size preview`}>
              <span><option.Glyph /></span>
              <span><option.Glyph /></span>
              <span><option.Glyph /></span>
              <span><option.Glyph /></span>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function MarkShell({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 160 160" role="img" {...props}>
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      {children}
    </svg>
  );
}

function SwarmCloudGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Swarm Cloud logo" {...props}>
      <path className={styles.strokeSoft} d="M40 84c20-42 61-52 86-24M35 102c31 27 72 28 98-5M54 45c-2 36 17 65 55 82" />
      <path className={styles.cell} d="M80 58 101 70v24l-21 12-21-12V70z" />
      <circle className={styles.eclipse} cx="80" cy="82" r="13" />
      <circle className={styles.swarmNode} cx="42" cy="82" r="6" />
      <circle className={styles.swarmNode} cx="55" cy="52" r="5" />
      <circle className={styles.swarmNode} cx="92" cy="38" r="5" />
      <circle className={styles.swarmNode} cx="121" cy="61" r="6" />
      <circle className={styles.swarmNode} cx="127" cy="101" r="5" />
      <circle className={styles.swarmNode} cx="94" cy="126" r="6" />
      <circle className={styles.swarmNode} cx="54" cy="116" r="5" />
      <path className={styles.threatStroke} d="M80 27v19M132 82h-18M80 134v-18M28 82h18" />
    </MarkShell>
  );
}

function BlackCombGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Black Comb logo" {...props}>
      <path className={styles.cell} d="M80 31 106 46v30L80 91 54 76V46z" />
      <path className={styles.cell} d="M53 78 79 93v30l-26 15-26-15V93z" />
      <path className={styles.cell} d="M107 78 133 93v30l-26 15-26-15V93z" />
      <path className={styles.stroke} d="M80 31v107M27 93l106 30M133 93 27 123" />
      <circle className={styles.glow} cx="80" cy="91" r="7" />
    </MarkShell>
  );
}

function QueenSigilGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Queen Sigil logo" {...props}>
      <path className={styles.stroke} d="m47 58 13-21 20 20 20-20 13 21" />
      <path className={styles.wing} d="M70 75C51 57 35 60 25 78c17 8 33 6 45-3Z" />
      <path className={styles.wing} d="M90 75c19-18 35-15 45 3-17 8-33 6-45-3Z" />
      <path className={styles.body} d="M80 53c14 11 21 27 21 47 0 23-9 38-21 38s-21-15-21-38c0-20 7-36 21-47Z" />
      <path className={styles.stroke} d="M62 88h36M61 106h38" />
      <circle className={styles.darkDot} cx="80" cy="72" r="6" />
    </MarkShell>
  );
}

function EclipseSwarmGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Eclipse Swarm logo" {...props}>
      <circle className={styles.sun} cx="78" cy="76" r="43" />
      <circle className={styles.eclipse} cx="94" cy="66" r="43" />
      <path className={styles.stroke} d="M43 114c21-19 53-19 74 0M56 126c15-11 33-11 48 0" />
      <circle className={styles.glow} cx="43" cy="56" r="4" />
      <circle className={styles.glow} cx="61" cy="38" r="3" />
      <circle className={styles.glow} cx="120" cy="100" r="4" />
      <circle className={styles.threat} cx="114" cy="48" r="3" />
    </MarkShell>
  );
}

function SentinelBeeGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Sentinel Bee logo" {...props}>
      <path className={styles.shield} d="M80 33 122 50v32c0 30-15 49-42 61-27-12-42-31-42-61V50z" />
      <path className={styles.wing} d="M74 75C56 61 42 64 34 78c15 7 28 6 40-3Z" />
      <path className={styles.wing} d="M86 75c18-14 32-11 40 3-15 7-28 6-40-3Z" />
      <path className={styles.stroke} d="M80 50v72M60 91h40" />
      <circle className={styles.threat} cx="80" cy="79" r="7" />
    </MarkShell>
  );
}

function HiveEyeGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Hive Eye logo" {...props}>
      <path className={styles.cell} d="M80 33 120 56v48l-40 23-40-23V56z" />
      <path className={styles.stroke} d="M37 81c20-24 66-24 86 0-20 24-66 24-86 0Z" />
      <circle className={styles.glow} cx="80" cy="81" r="18" />
      <circle className={styles.eclipse} cx="87" cy="75" r="13" />
      <path className={styles.strokeSoft} d="M80 33v94M40 56l80 48M120 56l-80 48" />
    </MarkShell>
  );
}

function StingerFrameGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <MarkShell aria-label="Stinger Frame logo" {...props}>
      <path className={styles.stroke} d="M47 50h66M47 111h66M58 38v84M102 38v84" />
      <path className={styles.body} d="M80 42c11 10 17 23 17 39 0 18-7 31-17 46-10-15-17-28-17-46 0-16 6-29 17-39Z" />
      <path className={styles.stroke} d="M64 75h32M63 91h34" />
      <path className={styles.threatStroke} d="m80 127-11 18h22z" />
    </MarkShell>
  );
}
