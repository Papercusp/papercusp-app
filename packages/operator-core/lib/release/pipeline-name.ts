/**
 * pipeline-name.ts — the ONE derivation of the `pipeline` identity stamped on gate-verdict
 * events (EI-19344528739076339).
 *
 * ## What a "pipeline" actually is — read this before scoping anything on it
 *
 * It is the **sanitized basename of the integration root directory**. It is NOT the harness
 * slug, and nothing anywhere enforces that the two agree. `green-checkpoint.ts`'s own doc
 * comment names the hazard directly: this box co-hosts `papercusp` and `papercup`, one letter
 * apart, and the value is whatever the checkout directory happens to be called.
 *
 * Measured 2026-08-02 against `harness_shared.event_key_fires`, the four pipelines that have
 * ever emitted a gate verdict here are `papercusp`, `oddsmith`, `hello-world-3` and
 * `hello-world-3-pot`. All four ALSO happen to be real `install_slug`s — so the mapping is
 * true today. It is true by naming convention, not by construction, and the failure mode when
 * it stops being true is SILENT: a `payload_filter` narrowed on a slug that never appears in
 * any payload produces an await that simply never fires, and an agent sleeping to its timeout
 * for a green that already landed is strictly worse than one woken by the wrong pipeline. A
 * spurious wake is noise you can see; a filter that can never match is a hang you cannot.
 *
 * So: **never derive the pipeline from a harness slug.** Derive it the way the EMITTER does,
 * from the same root, with the same function — then it cannot drift by construction rather
 * than by convention.
 *
 * ## Why this module exists
 *
 * This exact eight-token expression was independently re-typed in three places
 * (green-checkpoint.ts's exported `pipelineName`, release/trace.ts's file-local copy, and
 * — as a harness-slug ASSUMPTION rather than a copy — the fix originally proposed on
 * EI-19344528739076339). Three copies of a rule whose whole job is that two parties agree is
 * the drift waiting to happen. One export, imported by consumers.
 */
import * as path from 'node:path';

/**
 * The pipeline identity for a given integration root — the basename, sanitized to a safe
 * event-key segment. Byte-identical to `green-checkpoint.ts`'s exported `pipelineName`, which
 * is the emitter of record; `pipeline-name.test.ts` pins them equivalent so a change to either
 * cannot silently desynchronize the awaiting side from the emitting side.
 */
export function pipelineName(integrationRoot: string): string {
  const base = path.basename(path.resolve(integrationRoot));
  return (base.replace(/[^a-zA-Z0-9_-]/g, '-') || 'default').slice(0, 64);
}

/**
 * EI-21949138739080608 — the LEADING tag on a cross-pipeline gate summary. Byte-identical to
 * `green-checkpoint.ts`'s exported `pipelineTag` (the emitter of record); pinned equivalent in
 * `pipeline-name.test.ts` for the same reason `pipelineName` is.
 *
 * Third instance of one class. EI-15925 added a `[<pipeline>]` prefix to the advance broadcast
 * because an unlabelled advance was unattributable; P-004/D-002 added the same prefix to the
 * event wake-banners. Both asked "is an identifier PRESENT?" — neither asked "does a reader
 * RECOGNISE it as one?". On 2026-08-31 the `email` pipeline broadcast
 * `[email] 🟩 green-checkpoint: ...` and an su who correctly verified the sha against their own
 * checkout still read the bare `[email]` as a redaction/template artifact rather than a pipeline
 * name, and filed "names no hive" — quoting the very tag they had missed.
 *
 * A bare bracketed basename is self-describing only to a reader who ALREADY knows the
 * convention, and the audience is `*`: every agent in every co-hosted hive. The `pipeline:`
 * discriminator makes the tag unmistakably an identifier for EVERY pipeline, not just the ones
 * whose directory name doesn't collide with an English word.
 *
 * Display-only. The machine-readable identity rides `payload.pipeline` and the `:<pipeline>`
 * event-key segment, both untouched — nothing parses this tag.
 */
export function pipelineTag(pipeline: string): string {
  return `[pipeline:${pipeline}]`;
}

/**
 * EI-22240267519750098 — qualify the release REF itself, inside the sentence:
 * `email:main`, not a bare `main`.
 *
 * The FOURTH filed instance of one class, and the first whose fix is not "put the label on
 * one more surface". EI-15925 prefixed the broadcast; P-004/D-002 prefixed the event
 * wake-banners; the tag above was reworked so the prefix READS as an identifier. Coverage
 * became complete — and on 2026-09-03 an su blocked on a papercusp deploy still read
 *   [pipeline:email] 🟩 green-checkpoint: `main` advanced to ad49e48a (green, deployable)
 * as their own gate greening.
 *
 * Coverage was therefore never the defect. A bracketed PREFIX reads as routing metadata — a
 * delivery channel, a log facility — while the sentence after it is a complete, confident,
 * unqualified claim, and readers parse the CLAIM. Worse, its subject `main` is a ref name
 * every reader resolves against their OWN checkout, so the sentence is true of a foreign pot
 * in words that are false of the reader's. A qualifier only works where the reader's
 * attention already is: attribution has to sit INSIDE the noun phrase being acted on.
 *
 * Display-only, exactly like {@link pipelineTag}: nothing parses this. Machine-readable
 * identity still rides `payload.pipeline` and the `:<pipeline>` event-key segment.
 *
 * Deliberately NOT applied to a real remote-ref path (`origin/${releaseRef}` in the
 * push-failure broadcast) — `origin/email:main` would name a ref that does not exist. Only
 * bare refs a reader resolves locally get qualified.
 */
export function pipelineRef(pipeline: string, ref: string): string {
  return `${pipeline}:${ref}`;
}

/**
 * The pipeline THIS process belongs to, resolved from the same env var the release plumbing
 * uses (`PAPERCUSP_INTEGRATION_ROOT`, else the operator's conventional `../..`).
 *
 * Returns `null` rather than a guess when it cannot be resolved. That is the whole point: a
 * caller auto-scoping an await must be able to tell "I know which pipeline I am" from "I do
 * not", because only the first justifies installing a filter. Callers that cannot resolve it
 * must WARN, never narrow — see events/await.ts's gate-key auto-scope.
 */
export function currentPipelineName(): string | null {
  try {
    const root = process.env.PAPERCUSP_INTEGRATION_ROOT ?? path.resolve(process.cwd(), '..', '..');
    const name = pipelineName(root);
    // 'default' is the sanitizer's fallback for an empty basename — a real answer is never
    // this, so treating it as unresolved keeps a degenerate cwd from installing a filter that
    // matches nothing.
    return name && name !== 'default' ? name : null;
  } catch {
    return null;
  }
}

/**
 * The gate-verdict event keys that are emitted GLOBALLY (unscoped) by every co-hosted pipeline
 * on this box, alongside their `<key>:<pipeline>` siblings.
 *
 * Awaiting one of these bare keys subscribes you to ~13 unrelated pipelines. It has produced a
 * false "the gate is green" twice in one day (EI-19311522275272409, and again on
 * EI-19344528739076339's filer) — both times on `release:green`, which is maximally dangerous
 * precisely because it arrives as `satisfied:true` on a family literally named "green", right
 * when the reader is primed for good news, and the documented next step after green is to SHIP.
 *
 * `green-checkpoint:inconclusive` (EI-19928976726540168) is the third member of this family —
 * the same emitter (green-checkpoint.ts), the same `<key>` / `<key>:<pipeline>` dual-emit shape,
 * the same cross-tenant hazard. It was missing here even though the third terminal-outcome
 * family was added to the events:catalog (EI-19320479870270699) — the catalog entry and this
 * scoping list drifted independently.
 */
export const MULTI_PIPELINE_GATE_KEYS: readonly string[] = [
  'release:green',
  'green-checkpoint:red',
  'green-checkpoint:inconclusive',
];

/** Is `key` one of the globally-emitted gate keys that needs pipeline scoping? */
export function isMultiPipelineGateKey(key: string): boolean {
  return MULTI_PIPELINE_GATE_KEYS.includes(key);
}

/**
 * EI-19928976726540168: is `key` a GLOB over the pipeline segment of one of the
 * {@link MULTI_PIPELINE_GATE_KEYS} families — i.e. exactly `<family>:*`?
 *
 * The exact-key check above (`isMultiPipelineGateKey`) only catches the bare global key with NO
 * trailing segment at all. It does nothing for the shape an agent reaches for when they actually
 * DO want "any verdict for my pipeline": `release:green:*` / `green-checkpoint:red:*` /
 * `green-checkpoint:inconclusive:*`. That glob is EXACTLY as cross-tenant as the bare key — the
 * pipeline is the LAST key segment, so `*` matches every co-hosted pipeline's, not just the
 * caller's — but because it is a glob (`events:await`'s `patternAwait` branch), the exact-key
 * auto-narrow below never ran for it at all. Live incident: a caller intending "any verdict for
 * MY gate" parked on `green-checkpoint:red:*` and was woken by `{"pipeline":"hello-world-hive"}`
 * — a foreign pipeline's verdict, payload-shape-identical to the caller's own.
 *
 * Deliberately narrow: only the EXACT `<family>:*` shape matches (not `release:green*` with no
 * colon, not a multi-segment glob) — the same "resolve or warn, never guess" discipline
 * `currentPipelineName` documents applies here too; a broader match risks silently mis-scoping a
 * pattern that meant something else.
 */
export function isMultiPipelineGateKeyPattern(key: string): boolean {
  if (!key.endsWith(':*')) return false;
  return isMultiPipelineGateKey(key.slice(0, -2));
}
