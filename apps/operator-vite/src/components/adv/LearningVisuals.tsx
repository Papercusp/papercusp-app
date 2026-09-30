import type { CSSProperties, ReactNode } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  AlertTriangle,
  ChevronDown,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

export type LearningTone = "good" | "warn" | "bad" | "neutral" | "accent";

export function LearningPageHeader({
  icon: Icon,
  title,
  question,
  signal,
  tone = "neutral",
  action,
  generatedAt,
}: {
  icon: LucideIcon;
  title: string;
  /**
   * The question this view answers (learning-tab-alignment P-006) — a
   * compare-view leads with it ("Did the new build get better?") so the
   * reader knows what verdict the numbers below are FOR.
   */
  question?: string;
  signal?: string;
  tone?: LearningTone;
  action?: ReactNode;
  /**
   * WI-5810 (owner ask 2026-07-25): when this view's data was generated —
   * rendered PROMINENTLY, not as a footnote. Every learning surface is a
   * snapshot of a moving system; a reader who cannot see the as-of time cannot
   * tell "nothing is happening" from "this panel is stale", which is exactly
   * the confusion that sent us chasing a phantom empty gym. Accepts an ISO
   * string or epoch ms.
   */
  generatedAt?: string | number | null;
}) {
  return (
    <div className="pc-learning-visual__head">
      <h2>
        <Icon size={15} aria-hidden />
        {title}
      </h2>
      {generatedAt != null && generatedAt !== "" ? (
        <GeneratedStamp at={generatedAt} />
      ) : null}
      {question ? (
        <span className="pc-learning-visual__question">{question}</span>
      ) : null}
      {signal ? (
        <span className={`pc-learning-visual__signal is-${tone}`}>
          {signal}
        </span>
      ) : null}
      <span className="pc-learning-visual__headspace" />
      {action}
    </div>
  );
}

export function LearningHeroMetric({
  eyebrow,
  value,
  status,
  tone = "accent",
  children,
}: {
  eyebrow: string;
  value: string;
  status?: string;
  tone?: LearningTone;
  children?: ReactNode;
}) {
  return (
    <section className={`pc-learning-visual__hero is-${tone}`}>
      <span className="pc-learning-visual__eyebrow">{eyebrow}</span>
      <strong>{value}</strong>
      {status ? (
        <span className="pc-learning-visual__verdict">{status}</span>
      ) : null}
      {children ? (
        <div className="pc-learning-visual__herofoot">{children}</div>
      ) : null}
    </section>
  );
}

/**
 * One quiet, consistent summary line of `label value` stats — replaces the loud,
 * inconsistent per-step metric-tile strips (owner ask 2026-07-19: the colored
 * flow-cell "info pills" were confusing and different on every step). Plain text,
 * tabular numbers, ONE accent only on the stat(s) that actually signal health
 * (pass a `tone`); everything else stays muted-neutral. ~1 line tall vs the former
 * ~120px hero+flow+evidence dashboard band, which also closes the blank-space gap.
 */
export function LearningStatLine({
  stats,
}: {
  stats: Array<{ label: string; value: ReactNode; tone?: LearningTone }>;
}) {
  return (
    <dl className="pc-learning-visual__statline">
      {stats.map((s) => (
        <div key={s.label} className={s.tone ? `is-${s.tone}` : undefined}>
          <dt>{s.label}</dt>
          <dd>{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface LearningComparisonRow {
  label: string;
  baseline: number | null;
  treatment: number | null;
  baselineLabel?: string;
  treatmentLabel?: string;
  max?: number;
  treatmentWins?: boolean;
}

const barWidth = (value: number | null, max: number): string =>
  value == null ? "0%" : `${Math.max(2, Math.min(100, (value / max) * 100))}%`;

export function LearningComparisonBars({
  title,
  rows,
  baselineName = "Baseline",
  treatmentName = "Treatment",
}: {
  title: string;
  rows: LearningComparisonRow[];
  baselineName?: string;
  treatmentName?: string;
}) {
  return (
    <section className="pc-learning-visual__comparison">
      <header>
        <h3>{title}</h3>
        <span className="pc-learning-visual__legend is-baseline">
          {baselineName}
        </span>
        <span className="pc-learning-visual__legend is-treatment">
          {treatmentName}
        </span>
      </header>
      <div className="pc-learning-visual__barrows">
        {rows.map((row) => {
          const max =
            row.max ?? Math.max(row.baseline ?? 0, row.treatment ?? 0, 1);
          return (
            <div className="pc-learning-visual__barrow" key={row.label}>
              <span className="pc-learning-visual__barlabel">{row.label}</span>
              <div className="pc-learning-visual__barpair">
                <span className="pc-learning-visual__bartrack">
                  <span
                    className="pc-learning-visual__bar is-baseline"
                    style={
                      {
                        "--pc-learning-bar-width": barWidth(row.baseline, max),
                      } as CSSProperties
                    }
                  />
                  <em>{row.baselineLabel ?? row.baseline ?? "—"}</em>
                </span>
                <span className="pc-learning-visual__bartrack">
                  <span
                    className={`pc-learning-visual__bar is-treatment${row.treatmentWins ? " is-winner" : ""}`}
                    style={
                      {
                        "--pc-learning-bar-width": barWidth(row.treatment, max),
                      } as CSSProperties
                    }
                  />
                  <em>{row.treatmentLabel ?? row.treatment ?? "—"}</em>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function LearningEvidenceRail({
  title = "Evidence",
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className="pc-learning-visual__evidence" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </aside>
  );
}

export function LearningVisualEmpty({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  /** P-009 teaching copy: what this view shows → what makes data appear. ≤2 sentences. */
  body?: string;
  /** The ONE action that makes data appear (e.g. open the Blender pane's Arming section). */
  action?: { label: string; onClick: () => void };
}) {
  const teach = Boolean(body || action);
  return (
    <div
      className={`pc-learning-visual__empty${teach ? " pc-learning-visual__empty--teach" : ""}`}
      role="status"
    >
      <span className="pc-learning-visual__emptyicon" aria-hidden>
        <Icon size={14} />
      </span>
      <strong>{title}</strong>
      {body ? <p className="pc-learning-visual__emptybody">{body}</p> : null}
      {action ? (
        <button
          type="button"
          className="pc-learning-visual__emptyaction"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function LearningVisualError({
  title = "Data unavailable",
  onRetry,
}: {
  title?: string;
  onRetry: () => void;
}) {
  return (
    <div className="pc-learning-visual__error" role="alert">
      <span className="pc-learning-visual__emptyicon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <strong>{title}</strong>
      <button type="button" onClick={onRetry} aria-label={`Retry ${title}`}>
        <RefreshCw size={12} aria-hidden />
        Retry
      </button>
    </div>
  );
}

export function LearningDisclosure({
  label,
  subtitle,
  count,
  aside,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
}: {
  label: string;
  /**
   * One-line "what is this FOR" explainer, always visible next to the label
   * (not gated behind opening the disclosure) — owner ask 2026-07-19: a
   * header alone doesn't say what its contents mean.
   */
  subtitle?: string;
  count?: number;
  /**
   * Trailing header content, pinned right and visible while the disclosure is
   * CLOSED. For the one thing a reader must not have to open the section to
   * learn: a live warning about what is inside it (P-004 — loop health markers
   * used to render inside the collapsed body, so a starving loop was silent
   * until someone thought to expand it).
   */
  aside?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root
      className="pc-learning-visual__disclosure"
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Collapsible.Trigger className="pc-learning-visual__disclosure-trigger">
        <ChevronDown size={13} aria-hidden />
        <span className="pc-learning-visual__disclosure-label">{label}</span>
        {subtitle ? (
          <span className="pc-learning-visual__disclosure-subtitle">
            {subtitle}
          </span>
        ) : null}
        {count != null ? <em>{count}</em> : null}
        {aside ? (
          <span className="pc-learning-visual__disclosure-aside">{aside}</span>
        ) : null}
      </Collapsible.Trigger>
      <Collapsible.Content className="pc-learning-visual__disclosure-content">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/**
 * P-004 (owner 2026-08-28: "The how the loop section is also confusing"). One
 * instrument group inside "How the loop is doing", led by the plain-language
 * QUESTION it answers. The label is the question; the line beside it is the
 * answer in words — so the numbers below read as evidence for a claim already
 * made, rather than as a wall of chips the reader has to decode into one.
 *
 * Nothing is summarised away: every instrument that was in that section before
 * is still in it, under the question it happens to answer.
 *
 * It lives HERE rather than in LearningTab so that a panel which knows when it
 * is empty (LearningEfficacyPanel returns null with no data) can wrap ITSELF
 * and never leave a labelled card standing empty.
 */
export function LoopSection({
  label,
  answer,
  children,
}: {
  label: string;
  answer: string;
  children: ReactNode;
}) {
  return (
    <section className="pc-learning__loopsec" aria-label={label}>
      <div className="pc-learning__loopsechead">
        <span className="pc-learning__loopseclabel">{label}</span>
        <span className="pc-learning__loopsecanswer">{answer}</span>
      </div>
      {children}
    </section>
  );
}

export function LearningVisualStyles() {
  return (
    <style>{`
      .pc-learning-visual__head { min-height: 26px; display: flex; align-items: center; gap: 7px; margin: 0 0 3px; }
      .pc-learning-visual__head h2 { display: inline-flex; align-items: center; gap: 7px; margin: 0; color: var(--fg); font-size: 13px; font-weight: 680; letter-spacing: 0; }
      .pc-learning-visual__headspace { flex: 1 1 auto; }
      /* The page's "what is this view for" line WRAPS instead of truncating —
         an ellipsized explainer explains nothing (owner design pass 2026-07-19). */
      .pc-learning-visual__question { color: var(--fg-dim, #b9d4e8); font-size: 11.5px; line-height: 1.4; font-weight: 550; font-style: italic; white-space: normal; min-width: 0; }
      /* Quiet header signal (owner ask 2026-07-19): the former uppercase, bordered,
         tone-filled pill read as a confusing "info pill". Now plain inline text —
         a small muted label with the number tone-tinted, the ONE accent the header
         carries. No pill chrome, no uppercase. */
      /* WI-5810 — the as-of stamp. Legible, not a footnote: a reader must be able
         to tell a quiet system from a stale panel at a glance. */
      .pc-learning-visual__asof {
        /* letter-spacing stays 0 — nonzero tracking is not an approved app-UI
           primitive (design-primitives lint); the 0.01em here was a no-op
           micro-adjustment, so weight alone carries the stamp. */
        font-size: 11px; font-weight: 700;
        color: var(--accent, #7dd3fc); border: 1px solid color-mix(in srgb, var(--accent, #7dd3fc) 35%, transparent);
        border-radius: 999px; padding: 1px 8px; white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .pc-learning-visual__asof.is-stale {
        color: var(--warn, #fbbf24);
        border-color: color-mix(in srgb, var(--warn, #fbbf24) 45%, transparent);
      }
      .pc-learning-visual__signal { color: var(--fg-mute); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: 0; }
      .pc-learning-visual__signal.is-good { color: #34d399; }
      .pc-learning-visual__signal.is-warn { color: #fbbf24; }
      .pc-learning-visual__signal.is-bad { color: #fb7185; }
      .pc-learning-visual__signal.is-accent { color: var(--accent); }
      /* One quiet stat line replacing the per-step metric-tile strips (owner ask
         2026-07-19). Single row, plain label/value pairs, one accent per tone. */
      .pc-learning-visual__statline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 18px; margin: 0 0 4px; padding: 7px 11px; border: 1px solid color-mix(in srgb, var(--border) 82%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--bg-2) 55%, transparent); }
      .pc-learning-visual__statline > div { display: inline-flex; align-items: baseline; gap: 5px; min-width: 0; }
      .pc-learning-visual__statline dt { color: var(--fg-mute); font-size: 10.5px; font-weight: 600; }
      .pc-learning-visual__statline dd { margin: 0; color: var(--fg); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
      .pc-learning-visual__statline > div.is-good dd { color: #34d399; }
      .pc-learning-visual__statline > div.is-warn dd { color: #fbbf24; }
      .pc-learning-visual__statline > div.is-bad dd { color: #fb7185; }
      .pc-learning-visual__statline > div.is-accent dd { color: var(--accent); }
      .pc-learning-visual__layout { display: grid; grid-template-columns: minmax(140px, .62fr) minmax(300px, 2fr) minmax(170px, .78fr); gap: 6px; align-items: stretch; margin-bottom: 5px; }
      .pc-learning-visual__hero, .pc-learning-visual__comparison, .pc-learning-visual__evidence { border: 1px solid color-mix(in srgb, var(--border) 84%, transparent); border-radius: 11px; background: color-mix(in srgb, var(--bg-2) 92%, transparent); }
      .pc-learning-visual__hero { min-height: 62px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 8px 11px; overflow: hidden; position: relative; }
      .pc-learning-visual__hero::after { content: ''; position: absolute; inset: auto -20% -55% 15%; height: 75%; border-radius: 50%; background: currentColor; opacity: .055; filter: blur(18px); pointer-events: none; }
      .pc-learning-visual__hero.is-good { color: #34d399; }
      .pc-learning-visual__hero.is-warn { color: #fbbf24; }
      .pc-learning-visual__hero.is-bad { color: #fb7185; }
      .pc-learning-visual__hero.is-accent { color: var(--accent); }
      .pc-learning-visual__hero.is-neutral { color: var(--fg); }
      .pc-learning-visual__hero strong { margin-top: 4px; color: currentColor; font-size: clamp(24px, 2vw, 32px); line-height: .95; font-variant-numeric: tabular-nums; letter-spacing: 0; }
      .pc-learning-visual__eyebrow { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 12px; font-weight: 690; }
      .pc-learning-visual__verdict { margin-top: 5px; border: 1px solid currentColor; border-radius: 5px; padding: 1px 6px; background: color-mix(in srgb, currentColor 10%, transparent); color: currentColor; font-size: 8.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
      .pc-learning-visual__herofoot { width: 100%; margin-top: 5px; color: var(--fg-mute); font-size: 9.5px; font-variant-numeric: tabular-nums; }
      .pc-learning-visual__comparison { padding: 8px 10px 7px; }
      .pc-learning-visual__comparison > header { display: flex; align-items: center; gap: 9px; margin-bottom: 4px; }
      .pc-learning-visual__comparison h3, .pc-learning-visual__evidence h3 { flex: 1 1 auto; margin: 0; color: var(--fg); font-size: 12px; font-weight: 680; }
      .pc-learning-visual__legend { display: inline-flex; align-items: center; gap: 5px; color: var(--fg-mute); font-size: 9.5px; }
      .pc-learning-visual__legend::before { content: ''; width: 7px; height: 7px; border-radius: 2px; background: #64748b; }
      .pc-learning-visual__legend.is-treatment::before { background: #34d399; }
      .pc-learning-visual__barrows { display: flex; flex-direction: column; }
      .pc-learning-visual__barrow { display: grid; grid-template-columns: minmax(76px, .62fr) minmax(180px, 2fr); gap: 9px; align-items: center; padding: 2px 0; border-top: 1px solid color-mix(in srgb, var(--border) 48%, transparent); }
      .pc-learning-visual__barlabel { color: var(--fg); font-size: 11px; font-weight: 610; }
      .pc-learning-visual__barpair { display: grid; gap: 2px; }
      .pc-learning-visual__bartrack { display: grid; grid-template-columns: minmax(0, 1fr) 42px; gap: 7px; align-items: center; min-height: 8px; line-height: 1; }
      .pc-learning-visual__bartrack::before { content: ''; grid-column: 1; grid-row: 1; height: 7px; border-radius: 2px; background: color-mix(in srgb, var(--fg) 5%, transparent); }
      .pc-learning-visual__bar { grid-column: 1; grid-row: 1; display: block; width: var(--pc-learning-bar-width); height: 7px; border-radius: 2px; background: #64748b; transition: width 180ms ease; }
      .pc-learning-visual__bar.is-treatment { background: color-mix(in srgb, var(--accent) 72%, #34d399); }
      .pc-learning-visual__bar.is-treatment.is-winner { background: #34d399; }
      .pc-learning-visual__bartrack em { grid-column: 2; color: var(--fg-mute); font-size: 10px; font-style: normal; font-variant-numeric: tabular-nums; line-height: 1; text-align: right; }
      .pc-learning-visual__evidence { padding: 8px; }
      .pc-learning-visual__evidence > h3 { padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 56%, transparent); }
      .pc-learning-visual__evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; margin-top: 4px; }
      .pc-learning-visual__evidence-metric { min-width: 0; border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: 6px; padding: 5px; }
      .pc-learning-visual__evidence-metric span { display: block; overflow: hidden; color: var(--fg-mute); font-size: 9px; line-height: 1.1; text-overflow: ellipsis; white-space: nowrap; }
      .pc-learning-visual__evidence-metric strong { display: block; margin-top: 2px; color: var(--fg); font-size: 14px; font-variant-numeric: tabular-nums; line-height: 1; }
      .pc-learning-visual__empty { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px dashed color-mix(in srgb, var(--border) 72%, transparent); border-radius: 8px; color: var(--fg-mute); }
      .pc-learning-visual__emptyicon { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border: 1px solid var(--border); border-radius: 50%; color: var(--fg-mute); background: var(--bg-2); }
      .pc-learning-visual__empty strong { color: var(--fg-dim); font-size: 11px; font-weight: 650; }
      /* P-009 teaching variant: body copy + one action turn the row into a small centered card. */
      .pc-learning-visual__empty--teach { flex-direction: column; justify-content: center; gap: 6px; padding: 18px 16px; text-align: center; }
      .pc-learning-visual__empty--teach strong { font-size: 12px; }
      .pc-learning-visual__emptybody { margin: 0; max-width: 46ch; color: var(--fg-mute); font-size: 11px; line-height: 1.5; }
      .pc-learning-visual__emptyaction { display: inline-flex; align-items: center; min-height: 26px; margin-top: 2px; padding: 4px 12px; border: 1px solid color-mix(in srgb, var(--accent) 55%, var(--border)); border-radius: 7px; background: color-mix(in srgb, var(--accent) 12%, var(--bg-2)); color: var(--accent); cursor: pointer; font: inherit; font-size: 11px; font-weight: 650; }
      .pc-learning-visual__emptyaction:hover { background: color-mix(in srgb, var(--accent) 20%, var(--bg-2)); }
      .pc-learning-visual__emptyaction:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      .pc-learning-visual__error { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid color-mix(in srgb, #fb7185 30%, var(--border)); border-radius: 8px; color: #fb7185; background: color-mix(in srgb, #fb7185 4%, transparent); }
      .pc-learning-visual__error strong { color: var(--fg-dim); font-size: 11px; font-weight: 650; }
      .pc-learning-visual__error button { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; min-height: 25px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); color: var(--fg); cursor: pointer; font: inherit; font-size: 10px; font-weight: 650; }
      .pc-learning-visual__error button:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); color: var(--accent); }
      .pc-learning-visual__disclosure { border-top: 1px solid color-mix(in srgb, var(--border) 68%, transparent); }
      /* Disclosure triggers read as REAL headings everywhere (owner design
         pass 2026-07-19: expanders were whisper-grey one-liners you'd miss) —
         left-justified label at full foreground on a raised bar. */
      .pc-learning-visual__disclosure-trigger {
        width: 100%; min-height: 32px; display: flex; align-items: center; gap: 7px;
        padding: 6px 11px; border-radius: 9px;
        border: 1px solid var(--border, rgba(125, 211, 252, 0.16));
        background: var(--bg-2, rgba(255, 255, 255, 0.04));
        color: var(--fg-dim, #b9d4e8); cursor: pointer; font: inherit; text-align: left;
      }
      .pc-learning-visual__disclosure-trigger:hover { color: var(--fg); border-color: color-mix(in srgb, var(--accent, #7dd3fc) 40%, var(--border, rgba(125, 211, 252, 0.16))); }
      .pc-learning-visual__disclosure-trigger svg { flex: none; transition: transform var(--dur-fast); }
      .pc-learning-visual__disclosure-trigger[data-state='open'] svg { transform: rotate(180deg); }
      .pc-learning-visual__disclosure-label { flex: 0 1 auto; font-size: 12px; font-weight: 700; color: var(--fg, #e7eef5); line-height: 1.35; }
      .pc-learning-visual__disclosure-subtitle { min-width: 0; overflow: hidden; color: var(--fg-mute); font-size: 10.5px; font-weight: 500; font-style: italic; text-overflow: ellipsis; white-space: nowrap; }
      /* P-004: pinned right, so a warning about the contents is legible without
         opening them. flex:none keeps it from being the thing that ellipsises. */
      .pc-learning-visual__disclosure-aside { margin-left: auto; flex: none; display: inline-flex; align-items: center; gap: 5px; }
      .pc-learning-visual__disclosure-trigger em { flex: none; margin-left: auto; min-width: 20px; border-radius: 999px; padding: 1px 7px; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg-dim, #b9d4e8); font-size: 10px; font-style: normal; font-variant-numeric: tabular-nums; text-align: center; }
      .pc-learning-visual__disclosure-content { padding-top: 8px; }
      .pc-learning-visual__layout > .pc-ekg__wave, .pc-learning-visual__layout > .pc-rq__waterfall { min-height: 92px; }
      @container learning (max-width: 1060px) { .pc-learning-visual__layout { grid-template-columns: minmax(150px, .66fr) minmax(290px, 2fr); } .pc-learning-visual__evidence { grid-column: 1 / -1; } }
      @container learning (max-width: 720px) { .pc-learning-visual__layout { grid-template-columns: 1fr; } .pc-learning-visual__evidence { grid-column: auto; } .pc-learning-visual__barrow { grid-template-columns: 1fr; gap: 6px; } }
    `}</style>
  );
}

/**
 * WI-5810 — the "as of" stamp. Deliberately high-contrast and adjacent to the
 * title rather than tucked in a corner: its whole job is to stop a reader
 * trusting stale numbers. Shows relative age (the thing you actually judge by)
 * with the absolute timestamp on hover, and turns amber past 10 minutes.
 */
export function GeneratedStamp({ at }: { at: string | number }) {
  const ms = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const ageMin = (Date.now() - ms) / 60_000;
  const rel =
    ageMin < 1
      ? "just now"
      : ageMin < 60
        ? `${Math.round(ageMin)}m ago`
        : ageMin < 60 * 24
          ? `${Math.round(ageMin / 60)}h ago`
          : `${Math.round(ageMin / (60 * 24))}d ago`;
  return (
    <span
      className={`pc-learning-visual__asof${ageMin >= 10 ? " is-stale" : ""}`}
      title={`Data generated ${new Date(ms).toLocaleString()}`}
    >
      as of {rel}
    </span>
  );
}
