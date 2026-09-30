/**
 * capture-coerce.ts — WI-1974: be liberal about improvements:capture's top-level `kind`.
 *
 * improvements:capture is the self-improvement loop's OWN intake tool, yet it failed
 * ~17% of calls (27/160 in 24h), 29 of them on the top-level `kind` enum — and every
 * rejected call is a captured insight LOST (the exact rot the loop exists to prevent).
 * Live 48h breakdown of the failing `kind` values:
 *   observation 18 · null 11 · process 3 · friction 2 · tooling 2 · improvement 2
 *   · gap 1 · reliability 1 · issue 1 · tool-friction 1
 * Agents conflate `kind` with (a) the observation LANE, (b) the observation SUB-kind,
 * or (c) a free-form label — none of which should hard-reject. Coerce to intent:
 *   - kind null / '' / whitespace   → omit (schema `.optional()`, handler defaults 'change')
 *   - kind 'observation'            → lane:'observation' (kind is ignored in that lane)
 *   - kind ∈ observation sub-kinds  → lane:'observation' + observation.kind = that value
 *   - any other non-enum label      → 'change' (the documented default for a desired improvement)
 *   - a valid {bug,change,feature}  → untouched (case-normalised if it differed)
 *
 * This normalises ONLY the top-level `kind`. It deliberately does NOT touch the
 * `.strict()` observation sub-object (its unknown-key rejection is intentional —
 * added to stop silent data loss — and must keep failing loud).
 *
 * EI-10424: an IDEATE-pass PROPOSAL (an su session's "here's a feature idea" filing)
 * has no dedicated `kind` and defaults to 'change' — ordinary claimable change-work,
 * indistinguishable from a human-triaged request, bypassing the reviewed-proposal
 * pipeline the su IDEATE contract promises ("File each as … improvements:capture
 * { kind:'feature' }"). Live evidence: 29 open EI-10xxx rows with kind='change', no
 * payload.lane, found_during matching /su-ideate/i — several of them carrying a fully
 * populated `ideation` (lens/bet/cheapExperiment) block that the handler then silently
 * DISCARDS because it only persists `ideation` for kind:'feature' (capture.ts).
 * `coerceIdeateProvenance` catches both signals — a structured `ideation` payload, or
 * `foundDuring` naming an ideate pass — and forces kind→'feature' UNLESS the caller
 * explicitly chose 'bug' (a genuine defect found while ideating stays a bug) or the
 * capture is lane:'observation' (never enters the work queue regardless of kind).
 */

import { OBSERVATION_KINDS } from '../../harness/improvements/observation-types';

const VALID_KIND = new Set(['bug', 'change', 'feature']);
const OBSERVATION_SUBKINDS = new Set<string>(OBSERVATION_KINDS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function coerceCaptureKind(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;

  // explicit null (11×): z.enum().optional() rejects null (only undefined) — drop it
  // so the schema default ('change') applies. undefined already parses fine.
  if (raw.kind === undefined) return raw;
  if (raw.kind === null) {
    const out = { ...raw };
    delete out.kind;
    return out;
  }
  if (typeof raw.kind !== 'string') return raw; // non-string, non-null → let validation speak

  const k = raw.kind.trim().toLowerCase();
  if (VALID_KIND.has(k)) return raw.kind === k ? raw : { ...raw, kind: k };

  const out: Record<string, unknown> = { ...raw };
  if (k === '') {
    delete out.kind;
    return out;
  }
  if (k === 'observation') {
    delete out.kind;
    out.lane = out.lane ?? 'observation';
    return out;
  }
  if (OBSERVATION_SUBKINDS.has(k)) {
    delete out.kind;
    out.lane = out.lane ?? 'observation';
    const obs = isPlainObject(out.observation) ? { ...out.observation } : {};
    if (obs.kind === undefined) obs.kind = k;
    out.observation = obs;
    return out;
  }
  // any other free-form label ('process','tooling','improvement','reliability','issue',
  // 'tool-friction', …) → the documented default kind for a desired improvement.
  out.kind = 'change';
  return out;
}

/**
 * EI-21601117899178959: the improvement capture core calls this field `origin`,
 * while the persisted/domain model exposes the same learning provenance as
 * `signalOrigin`. Accept the latter at the public tool boundary and canonicalize
 * it before the handler forwards the capture to the core. When both spellings are
 * present, retain them so the args schema can reject a conflicting pair loudly;
 * equal values are harmless and collapse to the canonical `origin` field.
 */
function coerceSignalOrigin(raw: unknown): unknown {
  if (!isPlainObject(raw) || raw.signalOrigin === undefined) return raw;
  if (raw.origin !== undefined && raw.origin !== raw.signalOrigin) return raw;

  const out: Record<string, unknown> = { ...raw, origin: raw.origin ?? raw.signalOrigin };
  delete out.signalOrigin;
  return out;
}

const IDEATE_PROVENANCE_RE = /su-ideate/i;

function hasIdeationContent(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  return v.lens !== undefined || v.bet !== undefined || v.cheapExperiment !== undefined;
}

/**
 * EI-10424: force an IDEATE-pass proposal into the reviewed lane (kind:'feature')
 * instead of letting it silently default to ordinary claimable change-work. Runs
 * AFTER `coerceCaptureKind` (composed in `coerceCaptureArgs` below), so by this
 * point `raw.kind` is either a valid enum member or absent.
 *
 * Trigger (either signal, both free-text-tolerant / structural — no ctx needed):
 *   - `raw.ideation` carries lens/bet/cheapExperiment (the IDEATE-provenance schema), or
 *   - `raw.foundDuring` names an ideate pass (matches /su-ideate/i, the convention every
 *     observed filer already uses).
 * Never overrides an EXPLICIT 'bug' (a genuine defect found while ideating stays a
 * bug) or a lane:'observation' capture (never enters the work queue regardless of kind).
 * Only re-targets the ambiguous default ('change' or omitted-→-'change').
 */
export function coerceIdeateProvenance(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  if (raw.lane === 'observation') return raw;
  if (raw.kind !== undefined && raw.kind !== 'change') return raw; // explicit bug/feature — leave it

  const signaled =
    hasIdeationContent(raw.ideation) ||
    (typeof raw.foundDuring === 'string' && IDEATE_PROVENANCE_RE.test(raw.foundDuring));
  if (!signaled) return raw;

  return { ...raw, kind: 'feature' };
}

/** The full args-preprocess pipeline: general `kind` liberality, then IDEATE-provenance
 *  coercion. Exported as one step so callers (the tool's `z.preprocess`) never need to
 *  remember the order — `coerceIdeateProvenance` depends on `coerceCaptureKind` having
 *  already normalised `kind` to a valid enum member or removed it. */
export function coerceCaptureArgs(raw: unknown): unknown {
  return coerceIdeateProvenance(coerceSignalOrigin(coerceCaptureKind(raw)));
}
