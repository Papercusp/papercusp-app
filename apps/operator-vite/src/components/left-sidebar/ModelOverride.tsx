/**
 * ModelOverride — a SESSION-only per-agent MODEL override for the left-rail agent
 * tabs (model-override-sidebar-2026-06-23). Used by the 🛡 Sentinel and 👁 Overwatch
 * tabs: the owner picks which `model[:effort]` that agent runs for THIS session,
 * separate from the workspace default (Settings → AI backend). It makes the state
 * OBVIOUS — a "session override" vs "workspace default" badge (via the shared
 * OverridableSetting primitive) + a reset ↺ shown only while overridden — mirroring
 * the 👑 Queen tab's ModelTiersOverride.
 *
 * Source-agnostic: the parent passes the current `override` spec (from
 * `hive.steering.modelOverrides[role]`) + `onWrite(spec|null)` that writes via
 * `pot:set-steering`. A null spec CLEARS the override (⇒ workspace default).
 */
import { Select } from '@/app/harness/Select';
import OverridableSetting from '../override/OverridableSetting';

/** Self-contained styles so the control looks right in any rail tab's CSS namespace. */
const MODEL_OVERRIDE_CSS = `
.pc-modelover { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
.pc-modelover__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pc-modelover__state { font-size: 11px; color: var(--fg-mute); margin-left: auto; }
.pc-modelover__row { display: flex; gap: 6px; }
.pc-modelover__select {
  flex: 1; min-width: 0; padding: 4px 6px; font-size: 12px;
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  text-align: left; font-family: inherit; cursor: pointer; outline: none;
  color: var(--fg); background: var(--bg-elev, var(--bg)); border: 1px solid var(--border); border-radius: 4px;
}
.pc-modelover__select:disabled { opacity: 0.55; cursor: default; }
.pc-modelover__select--effort { flex: 0 0 42%; }
.pc-modelover__hint { font-size: 11px; color: var(--fg-mute); line-height: 1.35; }
`;

/** Claude model aliases the picker offers (weakest → strongest). */
export const MODEL_CHOICES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
/** Reasoning-effort levels; '' = unset (the model's own default). */
export const EFFORT_CHOICES = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * Radix Select (the shared `Select` primitive) refuses an empty-string option value
 * and the wrapper drops such options defensively, so the two "unset" choices —
 * "(workspace default)" model and "effort: default" — ride on sentinels instead of
 * ''. They are UI-only: `toSpecValue` maps them back to '' before `joinSpec`, so
 * nothing outside this file ever sees them.
 */
export const NO_MODEL = '__workspace_default__';
export const NO_EFFORT = '__effort_default__';

/** Sentinel → the '' the spec helpers expect. Pure. */
function toSpecValue(v: string, sentinel: string): string {
  return v === sentinel ? '' : v;
}

/** Split a stored `model[:effort]` spec into its parts. Pure. */
export function splitSpec(spec: string | null | undefined): { model: string; effort: string } {
  const s = (spec ?? '').trim();
  if (!s) return { model: '', effort: '' };
  const i = s.indexOf(':');
  return i < 0 ? { model: s, effort: '' } : { model: s.slice(0, i).trim(), effort: s.slice(i + 1).trim() };
}

/** Join a model + effort into a spec, or null when no model is chosen (⇒ clear). Pure. */
export function joinSpec(model: string, effort: string): string | null {
  const m = model.trim();
  if (!m) return null;
  const e = effort.trim();
  return e ? `${m}:${e}` : m;
}

export default function ModelOverride({
  label,
  override,
  onWrite,
  busy,
}: {
  /** The control's label, e.g. "Sentinel model". */
  label: string;
  /** Current session override spec (`model[:effort]`), or null ⇒ workspace default. */
  override: string | null;
  /** Persist a new spec, or null to clear (⇒ workspace default). */
  onWrite: (spec: string | null) => void;
  busy: boolean;
}) {
  const { model, effort } = splitSpec(override);
  const overriding = !!(override && override.trim());

  return (
    <section className="pc-modelover">
      <style>{MODEL_OVERRIDE_CSS}</style>
      <div className="pc-modelover__head">
        <OverridableSetting
          label={label}
          isOverridden={overriding}
          onReset={() => onWrite(null)}
          busy={busy}
          badgeStyle="chip"
        />
        <span className="pc-modelover__state">{overriding ? 'session override' : 'workspace default'}</span>
      </div>
      <div className="pc-modelover__row">
        <Select
          triggerClassName="pc-modelover__select"
          ariaLabel={`${label} — model`}
          value={model || NO_MODEL}
          disabled={busy}
          onChange={(v: string) => onWrite(joinSpec(toSpecValue(v, NO_MODEL), effort))}
          options={[
            { value: NO_MODEL, label: '(workspace default)' },
            ...MODEL_CHOICES.map((m) => ({ value: m, label: m })),
          ]}
        />
        <Select
          triggerClassName="pc-modelover__select pc-modelover__select--effort"
          ariaLabel={`${label} — effort`}
          value={effort || NO_EFFORT}
          // Effort is meaningless without a model; disabled until one is picked.
          disabled={busy || !model}
          onChange={(v: string) => onWrite(joinSpec(model, toSpecValue(v, NO_EFFORT)))}
          options={EFFORT_CHOICES.map((e) => ({
            value: e || NO_EFFORT,
            label: e ? `effort: ${e}` : 'effort: default',
          }))}
        />
      </div>
      <div className="pc-modelover__hint">
        Session-only — overrides the workspace default (Settings → AI backend) for this agent until reset. Applies on its
        next (re)launch.
      </div>
    </section>
  );
}
