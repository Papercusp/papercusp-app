'use client';

import { parseAsStringEnum, useQueryState } from 'nuqs';
import {
  HIVE_BRAND_COLORS,
  HiveCombMotif,
  HiveNounIcon,
  HivePrimaryMark,
  HiveQueenMark,
} from '../../_components/PotVisualIdentity';
import styles from './logo-lab.module.css';

// Labels follow the D-007-revised canon (the-hive-lexicon, packs.ts): the live
// agent collective is the Colony; Swarm = a deployment of a Hive to an instance
// (absorbing the old "Frame" machine/region term); "Sentinel Bee" → "Sentinel"
// (owner directive 2026-06-09). Icon KINDS keep their original ids — only the
// display labels/blurbs track the canon.
const NOUNS = [
  ['hive', 'Hive', 'Deployable project group'],
  ['swarm', 'Swarm', 'A deployment of a Hive to an instance'],
  ['mug', 'Queen', 'The brain — places + supervises bees'],
  ['papercup', 'Sentinel', 'The operator chat — always watching'],
  ['cup', 'Bee', 'AI agent'],
  ['keeper', 'Keeper', 'Human member'],
  ['cell', 'Cell', 'One unit of work'],
  ['comb', 'Comb', 'Shared library'],
  ['frame', 'Frame', 'Legacy machine/region motif (term folded into Swarm)'],
] as const;

const SWATCHES = [
  ['bg', 'Base', '#0B0E0B'],
  ['surface', 'Surface', '#12150F'],
  ['raised', 'Raised', '#1A1A12'],
  ['text', 'Text', '#FFF8E6'],
  ['muted', 'Muted', '#B9A982'],
  ['honey', 'Honey', HIVE_BRAND_COLORS.honey],
  ['honeyStrong', 'Honey strong', HIVE_BRAND_COLORS.honeyStrong],
  ['good', 'Success', '#34D399'],
  ['warn', 'Warning', '#F6B72F'],
  ['bad', 'Danger', '#FB7185'],
] as const;

type PreviewMode = 'identity' | 'icons' | 'motif';

export default function OperatorLogoLabPage() {
  const [mode, setMode] = useQueryState(
    'mode',
    parseAsStringEnum<PreviewMode>(['identity', 'icons', 'motif']).withDefault('identity'),
  );

  return (
    <div className={styles.page} data-theme="honeycomb">
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>The Swarm visual identity</div>
          <h1>The Swarm system</h1>
          <p>
            A flag-gated visual layer for ominous distributed intelligence:
            honey-amber signal color, charcoal fields, engineered hex geometry,
            and a separate Queen mark for the brain.
          </p>
          <div className={styles.segmented} role="tablist" aria-label="Hive logo lab sections">
            {(['identity', 'icons', 'motif'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                className={mode === item ? styles.segmentActive : undefined}
                onClick={() => setMode(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.heroMark} aria-label="The Swarm primary mark preview">
          <HivePrimaryMark decorative={false} />
        </div>
      </section>

      {mode === 'identity' ? <IdentityPanel /> : null}
      {mode === 'icons' ? <IconsPanel /> : null}
      {mode === 'motif' ? <MotifPanel /> : null}
    </div>
  );
}

function IdentityPanel() {
  return (
    <div className={styles.grid}>
      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>Primary mark</span>
          <code>primary-mark.svg</code>
        </div>
        <div className={styles.bigMark}><HivePrimaryMark /></div>
        <p>Use for app-level The Swarm surfaces, OS icons, empty states, release notes, and hero compositions.</p>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>Queen mark</span>
          <code>queen-mark.svg</code>
        </div>
        <div className={styles.bigMark}><HiveQueenMark /></div>
        <p>Use for the Queen brain avatar and high-judgment orchestration moments. Do not use it for the always-on Sentinel Bee operator.</p>
      </section>

      <section className={`${styles.panel} ${styles.wide}`}>
        <div className={styles.panelHeader}>
          <span>Wordmark lockup</span>
          <code>The Swarm · Hive console</code>
        </div>
        <div className={styles.wordmarkCard}>
          <img src="/brand/the-hive/wordmark-lockup.svg" alt="The Swarm lockup" />
        </div>
      </section>

      <section className={`${styles.panel} ${styles.wide}`}>
        <div className={styles.panelHeader}>
          <span>Color system</span>
          <code>design-tokens/honeycomb.semantic.tokens.json</code>
        </div>
        <div className={styles.swatches}>
          {SWATCHES.map(([id, label, value]) => (
            <div key={id} className={styles.swatch}>
              <span className={styles.swatchChip} style={{ background: value }} />
              <strong>{label}</strong>
              <code>{value}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function IconsPanel() {
  return (
    <div className={styles.grid}>
      <section className={`${styles.panel} ${styles.wide}`}>
        <div className={styles.panelHeader}>
          <span>Lexicon iconography</span>
          <code>/brand/the-hive/icons/*.svg</code>
        </div>
        <div className={styles.nounGrid}>
          {NOUNS.map(([kind, label, description]) => (
            <div key={kind} className={styles.nounCard}>
              <HiveNounIcon kind={kind} className={styles.nounIcon} />
              <strong>{label}</strong>
              <span>{description}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>App icon</span>
          <code>512 / 256 / 128 / 32</code>
        </div>
        <div className={styles.iconScale}>
          {[128, 64, 32, 16].map((size) => (
            <div key={size} className={styles.iconScaleItem}>
              <img src="/brand/the-hive/favicon.svg" alt="" style={{ width: size, height: size }} />
              <span>{size}px</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>Monochrome</span>
          <code>currentColor</code>
        </div>
        <div className={styles.monoRow}>
          <HivePrimaryMark monochrome />
          <HiveQueenMark monochrome />
        </div>
      </section>
    </div>
  );
}

function MotifPanel() {
  return (
    <div className={styles.grid}>
      <section className={`${styles.panel} ${styles.wide}`}>
        <div className={styles.panelHeader}>
          <span>Comb motif</span>
          <code>backgrounds / dividers / loading</code>
        </div>
        <div className={styles.motifHero}>
          <HiveCombMotif />
          <div>
            <strong>Geometry as system</strong>
            <span>Keep the hex grid aligned to layout and low-contrast; it should feel structural, not decorative.</span>
          </div>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>Swarm loading</span>
          <code>waggle optional</code>
        </div>
        <div className={styles.swarmLoader} aria-label="Swarm loading state preview">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <p>Use staggered movement for live agent activity; avoid random jitter.</p>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeader}>
          <span>Do / Don't</span>
          <code>usage rules</code>
        </div>
        <div className={styles.rules}>
          <strong>Do</strong>
          <span>Use charcoal fields, honey signal, precise hex alignment.</span>
          <strong>Don't</strong>
          <span>Use cartoon bees, yellow-on-white, or decorative honeycomb wallpaper.</span>
        </div>
      </section>
    </div>
  );
}
