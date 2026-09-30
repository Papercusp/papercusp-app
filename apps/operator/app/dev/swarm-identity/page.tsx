'use client';

import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { HiveNounIcon, HiveQueenMark } from '../../_components/PotVisualIdentity';
import styles from './swarm-identity.module.css';

type DirectionId = 'crown' | 'signal' | 'blackcomb' | 'papercup' | 'eclipse';
type SwarmMarkId = 'vortex' | 'omen' | 'sigil' | 'front' | 'crownField' | 'blackSun';

type Direction = {
  id: DirectionId;
  name: string;
  stance: string;
  mood: string;
  colors: string[];
  operator: string;
  queen: string;
  note: string;
};

type SwarmMark = {
  id: SwarmMarkId;
  name: string;
  read: string;
};

const INTRO_MS = 19_000;
const SWARM_TRANSITION_MS = 3_800;

const TAGLINE = 'Welcome to the End. Be part of the new beginning. Create or Join a Hive, start a swarm, and mold the future for whatever comes next.';
const TAGLINE_SEQUENCE = [
  'Welcome to the End.',
  'Be part of the new beginning.',
  'Create or Join a Hive, start a swarm.',
  'and mold the future for whatever comes next.',
] as const;

const DIRECTIONS: Direction[] = [
  {
    id: 'crown',
    name: 'Crown Swarm',
    stance: 'Regal, ominous, premium',
    mood: 'The Queen is a command intelligence inside a black-gold swarm.',
    colors: ['#070704', '#131008', '#D99A18', '#FFE08A', '#7A1C1C'],
    operator: 'Guard Bee',
    queen: 'Queen',
    note: 'Best if we want the bee metaphor to stay explicit and high-status.',
  },
  {
    id: 'signal',
    name: 'The Signal',
    stance: 'Cryptic, networked, inevitable',
    mood: 'The swarm follows a pulse. Bees become nodes in a dark transmission field.',
    colors: ['#050609', '#0D1411', '#F3B232', '#7DD3FC', '#A3E635'],
    operator: 'Signal Bee',
    queen: 'Queen',
    note: 'Best if the product should feel more technical than biological.',
  },
  {
    id: 'blackcomb',
    name: 'Black Comb',
    stance: 'Industrial, sharp, dev-tool serious',
    mood: 'A machine honeycomb: exact hexes, black wax, amber compute light.',
    colors: ['#080806', '#17130A', '#EAB308', '#FDE68A', '#78716C'],
    operator: 'Guard Bee',
    queen: 'Queen',
    note: 'Best fit for a dark-first desktop coding tool.',
  },
  {
    id: 'papercup',
    name: 'Sentinel Swarm',
    stance: 'Watchful, tactical, always-on',
    mood: 'The operator is the perimeter: alert, cheaper, tireless, ready to wake the Queen.',
    colors: ['#050505', '#111827', '#F59E0B', '#FB7185', '#CBD5E1'],
    operator: 'Sentinel Bee',
    queen: 'Queen',
    note: 'Best if we want the operator role to be immediately legible.',
  },
  {
    id: 'eclipse',
    name: 'Eclipse Hive',
    stance: 'Apocalyptic, cinematic, memorable',
    mood: 'The swarm moves across the sun. The world changes after the Queen wakes.',
    colors: ['#030303', '#180C07', '#FFB020', '#FF5A1F', '#FFF1B8'],
    operator: 'Harbinger Bee',
    queen: 'Queen',
    note: 'Best for the website hero if we want maximum ominous energy.',
  },
];

const SWARM_MARKS: SwarmMark[] = [
  { id: 'vortex', name: 'Swarm Vortex', read: 'A moving colony collapsing into one will.' },
  { id: 'omen', name: 'Omen Cloud', read: 'The swarm as a dark shape on the horizon.' },
  { id: 'sigil', name: 'Swarm Sigil', read: 'A technical S formed from worker-bee vectors.' },
  { id: 'front', name: 'The Front', read: 'Many bees advancing as a single system.' },
  { id: 'crownField', name: 'Crown Field', read: 'The Queen is implied by swarm formation, not a mascot.' },
  { id: 'blackSun', name: 'Black Sun Swarm', read: 'The colony eclipses the old world.' },
];

export default function SwarmIdentityPage() {
  const [introPhase, setIntroPhase] = useState<'lines' | 'swarm' | 'done'>('lines');
  const [introReplay] = useQueryState('intro', parseAsString.withDefault(''));

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    if (introReplay === 'skip') {
      setIntroPhase('done');
      return undefined;
    }
    setIntroPhase('lines');
    const swarmTimer = window.setTimeout(() => setIntroPhase('swarm'), INTRO_MS);
    const doneTimer = window.setTimeout(() => setIntroPhase('done'), INTRO_MS + SWARM_TRANSITION_MS);
    return () => {
      window.clearTimeout(swarmTimer);
      window.clearTimeout(doneTimer);
    };
  }, [introReplay]);

  const [selected, setSelected] = useQueryState(
    'direction',
    parseAsStringEnum<DirectionId>(DIRECTIONS.map((d) => d.id) as [DirectionId, ...DirectionId[]]).withDefault('blackcomb'),
  );
  const active = DIRECTIONS.find((d) => d.id === selected) ?? DIRECTIONS[2];

  return (
    <main className={styles.page}>
      {introPhase === 'lines' ? (
        <section className={styles.introSequence} aria-label={TAGLINE}>
          <div className={styles.introComb} aria-hidden="true" />
          <div className={styles.introLines} aria-hidden="true">
            {TAGLINE_SEQUENCE.map((line, index) => (
              <span key={line} data-line={index + 1} style={{ '--intro-index': index } as CSSProperties}>
                {line}
              </span>
            ))}
          </div>
          <div className={styles.introSwarm} aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
        </section>
      ) : null}

      {introPhase === 'swarm' ? (
        <section className={styles.swarmTakeover} aria-label="The swarm gathers">
          <div className={styles.swarmVortex} aria-hidden="true">
            {Array.from({ length: 32 }, (_, index) => (
              <span key={index} style={{ '--bee-index': index } as CSSProperties} />
            ))}
          </div>
          <p>The Hive is awake.</p>
        </section>
      ) : null}

      <div className={introPhase === 'done' ? styles.contentVisible : styles.contentReveal}>
        <section className={`${styles.hero} ${styles.finalDirection}`}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>implemented now · theswarm.dev</span>
            <h1>The Swarm</h1>
            <p>{TAGLINE}</p>
            <div className={styles.lexicon}>
              <span><strong>Queen</strong> brain</span>
              <span><strong>Sentinel Bee</strong> operator</span>
              <span><strong>Keepers</strong> humans</span>
              <span><strong>Bees</strong> agents</span>
            </div>
            <a className={styles.replayIntro} href="/dev/swarm-identity?v=intro">
              Replay intro and swarm vortex
            </a>
          </div>
          <HeroLogo direction="blackcomb" />
        </section>

        <section className={styles.implementedSystem} aria-label="Implemented Swarm design system">
          <article className={styles.implementedWordmark}>
            <div className={styles.cardHeader}>
              <span>Final app mark</span>
              <code>/brand/the-hive/wordmark-lockup.svg</code>
            </div>
            <img src="/brand/the-hive/wordmark-lockup.svg" alt="The Swarm Hive Console wordmark" />
          </article>
          <article>
            <div className={styles.cardHeader}>
              <span>Role split</span>
              <code>lexicon pack</code>
            </div>
            <div className={styles.roleGrid}>
              <span><HiveQueenMark monochrome /> <strong>Queen</strong><small>brain</small></span>
              <span><HiveNounIcon kind="papercup" /> <strong>Sentinel Bee</strong><small>operator</small></span>
              <span><HiveNounIcon kind="keeper" /> <strong>Keeper</strong><small>human</small></span>
              <span><HiveNounIcon kind="swarm" /> <strong>Swarm</strong><small>live bees</small></span>
            </div>
          </article>
        </section>

        <section className={styles.switcher} aria-label="Swarm identity directions">
          {DIRECTIONS.map((direction) => (
            <button
              key={direction.id}
              type="button"
              className={direction.id === active.id ? styles.activeButton : undefined}
              onClick={() => setSelected(direction.id)}
            >
              <span>{direction.name}</span>
              <small>{direction.stance}</small>
            </button>
          ))}
        </section>

        <section className={`${styles.optionDetail} ${styles[active.id]}`}>
          <div className={styles.optionHeader}>
            <div>
              <span className={styles.eyebrow}>Selected direction</span>
              <h2>{active.name}</h2>
              <p>{active.mood}</p>
            </div>
            <div className={styles.palette} aria-label={`${active.name} palette`}>
              {active.colors.map((color) => (
                <span key={color} style={{ background: color }} title={color} />
              ))}
            </div>
          </div>

          <div className={styles.detailGrid}>
            <article className={styles.logoCard}>
              <div className={styles.cardHeader}>
                <span>Primary mark</span>
                <code>SVG / app icon candidate</code>
              </div>
              <HeroLogo direction={active.id} compact />
            </article>

            <article className={styles.wordmarkCard}>
              <div className={styles.cardHeader}>
                <span>Wordmark</span>
                <code>theswarm.dev</code>
              </div>
              <div className={styles.wordmark}>
                <LogoGlyph direction={active.id} />
                <div>
                  <strong>The Swarm</strong>
                  <span>{active.stance}</span>
                </div>
              </div>
              <p>{active.note}</p>
            </article>

            <article className={styles.websiteCard}>
              <div className={styles.cardHeader}>
                <span>Website hero treatment</span>
                <code>landing page</code>
              </div>
              <div className={styles.browserMock}>
                <div className={styles.browserTop}>
                  <span />
                  <span />
                  <span />
                  <code>https://theswarm.dev</code>
                </div>
                <div className={styles.browserBody}>
                  <span className={styles.miniEyebrow}>A new intelligence is forming</span>
                  <h3>Welcome to the End.</h3>
                  <p>Be part of the new beginning. Create or Join a Hive, start a swarm, and mold the future for whatever comes next.</p>
                  <div className={styles.browserActions}>
                    <button type="button">Create a Hive</button>
                    <button type="button">Join a Hive</button>
                  </div>
                </div>
              </div>
            </article>

            <article className={styles.appCard}>
              <div className={styles.cardHeader}>
                <span>App chrome treatment</span>
                <code>desktop shell</code>
              </div>
              <div className={styles.appMock}>
                <aside>
                  <div className={styles.appBrand}><LogoGlyph direction={active.id} /> The Swarm</div>
                  <span>Hive</span>
                  <span>Swarm</span>
                  <span>{active.operator}</span>
                  <span>Comb</span>
                </aside>
                <div className={styles.appPanel}>
                  <div className={styles.statusLine}>
                  <strong>{active.queen}</strong>
                  <span>thinking</span>
                </div>
                  <div className={styles.hexRows}>
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <p>{active.operator} is online. A Hive can run many swarms; the Queen wakes when judgment is required.</p>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.swarmLogoWall} aria-label="Swarm logo candidates">
          <div className={styles.swarmLogoHeader}>
            <span className={styles.eyebrow}>Swarm-forward marks</span>
            <h2>Logos that read as a swarm first</h2>
            <p>These avoid the single cute bee problem. The mark is the collective: many workers forming one ominous intelligence.</p>
          </div>
          <div className={styles.swarmLogoGrid}>
            {SWARM_MARKS.map((mark) => (
              <article key={mark.id} className={styles.swarmLogoCard}>
                <div className={styles.swarmLogoGlyph}>
                  <SwarmMarkGlyph mark={mark.id} />
                </div>
                <h3>{mark.name}</h3>
                <p>{mark.read}</p>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.compareGrid}>
          {DIRECTIONS.map((direction) => (
            <article key={direction.id} className={`${styles.compareCard} ${styles[direction.id]}`}>
              <LogoGlyph direction={direction.id} />
              <h3>{direction.name}</h3>
              <p>{direction.note}</p>
              <div className={styles.palette}>
                {direction.colors.map((color) => (
                  <span key={color} style={{ background: color }} title={color} />
                ))}
              </div>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

function SwarmMarkGlyph({ mark }: { mark: SwarmMarkId }) {
  if (mark === 'omen') return <OmenCloudGlyph />;
  if (mark === 'sigil') return <SwarmSigilGlyph />;
  if (mark === 'front') return <SwarmFrontGlyph />;
  if (mark === 'crownField') return <CrownFieldGlyph />;
  if (mark === 'blackSun') return <BlackSunSwarmGlyph />;
  return <SwarmVortexGlyph />;
}

function SwarmBee({ x, y, scale = 1, rotate = 0, hot = false }: { x: number; y: number; scale?: number; rotate?: number; hot?: boolean }) {
  return (
    <g className={hot ? styles.swarmBeeHot : styles.swarmBee} transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <path d="M0-6C4-10 9-8 10-3 6-2 3-3 0-6Z" />
      <path d="M0 6C4 10 9 8 10 3 6 2 3 3 0 6Z" />
      <ellipse cx="-2" cy="0" rx="4" ry="7" />
      <path d="M-6-3h8M-6 3h8" />
    </g>
  );
}

function HeroLogo({ direction, compact = false }: { direction: DirectionId; compact?: boolean }) {
  return (
    <div className={compact ? styles.logoStageCompact : styles.logoStage} aria-label={`${direction} logo preview`}>
      <LogoGlyph direction={direction} />
      {!compact ? (
        <div className={styles.orbit}>
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}
    </div>
  );
}

function SwarmVortexGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Swarm vortex logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <path className={styles.swarmOrbitStroke} d="M36 100c14 37 57 53 92 31 36-22 38-76 5-100" />
      <path className={styles.swarmOrbitStroke} d="M139 83c-9-34-45-54-80-40-34 14-48 54-31 86" />
      <SwarmBee x={94} y={38} scale={0.78} rotate={16} hot />
      <SwarmBee x={122} y={52} scale={0.68} rotate={46} />
      <SwarmBee x={139} y={82} scale={0.58} rotate={84} hot />
      <SwarmBee x={128} y={118} scale={0.72} rotate={138} />
      <SwarmBee x={92} y={139} scale={0.86} rotate={192} hot />
      <SwarmBee x={54} y={122} scale={0.66} rotate={238} />
      <SwarmBee x={39} y={84} scale={0.7} rotate={288} hot />
      <SwarmBee x={62} y={50} scale={0.54} rotate={326} />
      <SwarmBee x={90} y={90} scale={1.18} rotate={0} hot />
    </svg>
  );
}

function OmenCloudGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Omen cloud swarm logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <path className={styles.omenMass} d="M31 94c11-35 37-54 70-52 30 2 48 19 55 51-16 22-37 33-64 33-26 0-46-11-61-32Z" />
      <SwarmBee x={50} y={88} scale={0.54} rotate={-17} />
      <SwarmBee x={70} y={64} scale={0.6} rotate={22} hot />
      <SwarmBee x={92} y={80} scale={0.5} rotate={-32} />
      <SwarmBee x={116} y={59} scale={0.56} rotate={36} />
      <SwarmBee x={132} y={92} scale={0.62} rotate={-8} hot />
      <SwarmBee x={104} y={113} scale={0.58} rotate={26} />
      <SwarmBee x={74} y={108} scale={0.5} rotate={-24} />
      <path className={styles.swarmHorizon} d="M44 137h92" />
    </svg>
  );
}

function SwarmSigilGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Swarm sigil S logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <path className={styles.sigilGuide} d="M123 45c-34-18-72-4-72 22 0 35 80 14 80 49 0 27-42 37-78 15" />
      <SwarmBee x={119} y={48} scale={0.56} rotate={-62} hot />
      <SwarmBee x={89} y={43} scale={0.52} rotate={-84} />
      <SwarmBee x={61} y={58} scale={0.58} rotate={-122} />
      <SwarmBee x={64} y={82} scale={0.5} rotate={-202} hot />
      <SwarmBee x={94} y={91} scale={0.54} rotate={-252} />
      <SwarmBee x={125} y={104} scale={0.6} rotate={-214} hot />
      <SwarmBee x={111} y={132} scale={0.52} rotate={-134} />
      <SwarmBee x={76} y={137} scale={0.56} rotate={-88} hot />
      <SwarmBee x={53} y={124} scale={0.48} rotate={-54} />
    </svg>
  );
}

function SwarmFrontGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Advancing swarm front logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <path className={styles.frontWedge} d="M30 117 150 51 132 123 92 105 52 137z" />
      <SwarmBee x={52} y={117} scale={0.48} rotate={62} />
      <SwarmBee x={72} y={104} scale={0.54} rotate={61} hot />
      <SwarmBee x={93} y={92} scale={0.62} rotate={61} />
      <SwarmBee x={114} y={80} scale={0.7} rotate={61} hot />
      <SwarmBee x={136} y={67} scale={0.56} rotate={61} />
      <SwarmBee x={102} y={116} scale={0.48} rotate={31} />
      <SwarmBee x={64} y={135} scale={0.42} rotate={35} hot />
    </svg>
  );
}

function CrownFieldGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Crown field swarm logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <path className={styles.crownFieldLine} d="m47 85 18-28 25 25 25-25 18 28" />
      <SwarmBee x={48} y={102} scale={0.46} rotate={-24} />
      <SwarmBee x={65} y={71} scale={0.52} rotate={14} hot />
      <SwarmBee x={90} y={82} scale={0.62} rotate={0} hot />
      <SwarmBee x={115} y={71} scale={0.52} rotate={-14} hot />
      <SwarmBee x={132} y={102} scale={0.46} rotate={24} />
      <SwarmBee x={75} y={119} scale={0.5} rotate={-28} />
      <SwarmBee x={105} y={119} scale={0.5} rotate={28} />
    </svg>
  );
}

function BlackSunSwarmGlyph() {
  return (
    <svg viewBox="0 0 180 180" role="img" aria-label="Black sun swarm logo">
      <path className={styles.swarmHexShell} d="M90 9 160 49v82l-70 40-70-40V49z" />
      <circle className={styles.blackSunRing} cx="90" cy="88" r="48" />
      <circle className={styles.blackSunVoid} cx="100" cy="78" r="42" />
      <SwarmBee x={48} y={60} scale={0.44} rotate={22} />
      <SwarmBee x={67} y={37} scale={0.5} rotate={48} hot />
      <SwarmBee x={113} y={40} scale={0.46} rotate={92} />
      <SwarmBee x={137} y={71} scale={0.54} rotate={130} hot />
      <SwarmBee x={128} y={118} scale={0.48} rotate={188} />
      <SwarmBee x={86} y={138} scale={0.56} rotate={230} hot />
      <SwarmBee x={44} y={105} scale={0.5} rotate={288} />
    </svg>
  );
}

function LogoGlyph({ direction }: { direction: DirectionId }) {
  if (direction === 'signal') return <SwarmSigilGlyph />;
  if (direction === 'papercup') return <SwarmFrontGlyph />;
  if (direction === 'eclipse') return <BlackSunSwarmGlyph />;
  if (direction === 'crown') return <CrownFieldGlyph />;
  return <SwarmVortexGlyph />;
}

function CrownGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Crowned bee hex logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.markStroke} d="m48 61 14-22 18 20 18-20 14 22" />
      <path className={styles.wingLeft} d="M70 74C51 57 34 59 25 76c17 8 32 6 45-2Z" />
      <path className={styles.wingRight} d="M90 74c19-17 36-15 45 2-17 8-32 6-45-2Z" />
      <path className={styles.beeBody} d="M80 55c13 10 19 24 19 42 0 21-8 35-19 35S61 118 61 97c0-18 6-32 19-42Z" />
      <path className={styles.markStroke} d="M63 86h34M61 103h38" />
    </svg>
  );
}

function SignalGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Signal bee logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.signalLine} d="M32 80h28l12-24 18 48 12-24h26" />
      <circle className={styles.node} cx="80" cy="80" r="21" />
      <path className={styles.markStroke} d="M80 42v76M54 57l52 46M106 57l-52 46" />
      <circle className={styles.markFill} cx="80" cy="80" r="8" />
    </svg>
  );
}

function BlackCombGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Black comb logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.combCell} d="M80 35 104 49v28L80 91 56 77V49z" />
      <path className={styles.combCell} d="M55 79 79 93v28l-24 14-24-14V93z" />
      <path className={styles.combCell} d="M105 79 129 93v28l-24 14-24-14V93z" />
      <path className={styles.markStroke} d="M80 35v100M31 93l98 28M129 93l-98 28" />
    </svg>
  );
}

function SentinelGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Sentinel bee shield logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <path className={styles.shield} d="M80 34 121 50v32c0 29-15 48-41 60-26-12-41-31-41-60V50z" />
      <path className={styles.wingLeft} d="M74 75C56 61 42 64 34 78c15 7 28 6 40-3Z" />
      <path className={styles.wingRight} d="M86 75c18-14 32-11 40 3-15 7-28 6-40-3Z" />
      <path className={styles.markStroke} d="M80 51v70M61 90h38" />
      <circle className={styles.dangerDot} cx="80" cy="79" r="7" />
    </svg>
  );
}

function EclipseGlyph() {
  return (
    <svg viewBox="0 0 160 160" role="img" aria-label="Eclipse swarm logo">
      <path className={styles.hexShell} d="M80 8 142 44v72l-62 36-62-36V44z" />
      <circle className={styles.eclipseSun} cx="80" cy="78" r="42" />
      <circle className={styles.eclipseMoon} cx="94" cy="68" r="42" />
      <path className={styles.markStroke} d="M45 114c20-20 50-20 70 0M56 124c14-12 34-12 48 0" />
      <circle className={styles.markFill} cx="43" cy="58" r="4" />
      <circle className={styles.markFill} cx="61" cy="39" r="3" />
      <circle className={styles.markFill} cx="119" cy="100" r="4" />
    </svg>
  );
}
