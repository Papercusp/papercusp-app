/**
 * shape-clip.ts — self-describing truncation for the plans:* payload-tier shapers
 * (EI-20038981829684213).
 *
 * ## The class
 *
 * `libs/generic/tooldef/src/payload-tier.ts` already fixed this once
 * (EI-19447969329510166): a clipped string MUST ANNOUNCE ITS OWN CLIPPING, IN
 * BAND, because a bare `…` occurs constantly inside real content and so a
 * truncated value is indistinguishable from a complete one. That fix landed on
 * the GENERIC projector. The four tool-local plans shapers — get / items /
 * attention / list — each carry their own copy of the pre-fix idiom
 * (`s.slice(0, n - 1) + "…"`) and were never brought along.
 *
 * ## Why a sibling flag is not enough
 *
 * Each shaper does stamp a sibling marker (`body_truncated`, `text_truncated`,
 * `prose_truncated`). A sibling is strippable: the measured failure was
 *
 *     plans:get { slug, heading:'Decisions', projection:{ pick:['results[].section.body'] } }
 *
 * which selects the value and drops the flag that qualifies it. That also
 * blinds the result door, whose upstream-truncation detector scans the
 * SERIALIZED TEXT for marker field names (result-door.ts:380) — so the door
 * then reports "No upstream truncation marker was detected" on a payload that
 * was truncated. An in-band marker cannot be separated from the value it
 * qualifies by any projection, which is the whole point of putting it there.
 *
 * ## Why records, not chars, for a section body
 *
 * `heading:'Decisions'` returns one section as ONE STRING. Clipping it at a
 * fixed char count lands mid-ledger, and the retained prefix is N whole,
 * well-formed decisions — nothing about four complete `### D-NNN` blocks looks
 * cut off. Measured on `retire-mug-kettle-su-only-2026-08-09`: a 98,941-char /
 * 30-record Decisions section, capped to 6,000 chars at the trimmed tier,
 * yielded D-001..D-004 while `counts.decisions` said 30. The load-bearing
 * decisions on that plan were D-020 and D-030.
 *
 * So a record-structured body is cut at a RECORD BOUNDARY and the marker states
 * the count in the units the reader cares about ("showing 4 of 30"), not in
 * chars. A char count cannot answer "am I missing a ruling?"; a record count
 * can.
 *
 * The recovery pointer is deliberately an executable `tools:invoke` dispatch
 * carrying `payloadTier:'full'` — the one exit that actually resolves for this
 * layer. A direct schema-validated call rejects this framework-reserved arg.
 * (payload-tier.ts's own marker points at `_projection.cursor`, which these
 * shapers do not emit; advertising a pointer that does not resolve is worse
 * than none, because it becomes a lie the reader trusts.)
 */

/**
 * Build the schema-safe recovery pointer for a plans tool's reserved tier arg.
 * Keep the syntax in parity with payload-tier.ts's host dispatch template.
 */
export function payloadTierRecoveryHint(
  toolName: string,
  tier: "standard" | "full" = "full",
): string {
  return `tools:invoke { name:'${toolName}', args:{ …original args, payloadTier:'${tier}' } }`;
}

/** The recovery pointer for the default plans:get clipper. */
export const SHAPE_RECOVER_HINT = payloadTierRecoveryHint("plans:get");

/**
 * Below this cap the marker is charged against a budget small enough that the
 * recovery hint would crowd out the content it is meant to qualify — a 50-char
 * marker on `plans:items`' 120-char text cap is 42% of the field. The COMPACT
 * form drops the hint and keeps the load-bearing half: that the value is
 * incomplete, and by how much.
 */
const COMPACT_MARKER_BELOW = 200;

/**
 * In-band marker for a clipped string. Square-bracket form + a greppable
 * `TRUNCATED` matches the house convention in payload-tier.ts. Both forms carry
 * the word, so one grep finds either.
 */
export function clipMarker(
  omittedChars: number,
  recover: string = SHAPE_RECOVER_HINT,
  compact = false,
): string {
  return compact
    ? `…[+${omittedChars} chars TRUNCATED]`
    : `…[TRUNCATED +${omittedChars} chars — recover: ${recover}]`;
}

/**
 * Clip `s` so the RESULT — marker included — is at most `n` chars, and so the
 * result says so in band.
 *
 * The marker's own length depends on the omitted count, which depends on how
 * much we keep: sizing the reserve against the worst case (the whole string
 * omitted) makes the final marker never longer than the reserve, so one pass
 * always fits. No iteration needed.
 */
export function clipWithMarker(s: string, n: number, recover: string = SHAPE_RECOVER_HINT): string {
  if (s.length <= n) return s;
  const compact = n < COMPACT_MARKER_BELOW;
  const reserve = clipMarker(s.length, recover, compact).length;
  // Degenerate cap (smaller than a marker): still never return a silent clip —
  // an unmarked truncation is the exact failure this module exists to prevent.
  if (n <= reserve) return clipMarker(s.length, recover, true);
  const keep = n - reserve;
  return `${s.slice(0, keep)}${clipMarker(s.length - keep, recover, compact)}`;
}

/** Start offsets of every `### ` record in a markdown body. */
function recordOffsets(body: string): number[] {
  const offsets: number[] = [];
  const re = /^### /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) offsets.push(m.index);
  return offsets;
}

/**
 * Longest record heading quoted in a marker. Bounds the marker so the reserve
 * below stays a worst case, keeping clipSectionBody single-pass.
 */
const RECOVER_HEADING_MAX = 48;

/**
 * The heading text of the `### ` record starting at `offset`, clipped to
 * {@link RECOVER_HEADING_MAX}.
 *
 * Clipping it keeps the pointer HONEST rather than approximate: the `heading`
 * lookup in plans/get.ts matches by substring, so a PREFIX of a record heading
 * resolves to that record. A shortened pointer is still a working call.
 */
function recordHeadingAt(body: string, offset: number): string {
  const line = body.slice(offset).split("\n", 1)[0] ?? "";
  const text = line.replace(/^###\s+/, "").trim();
  return text.length > RECOVER_HEADING_MAX
    ? text.slice(0, RECOVER_HEADING_MAX).trim()
    : text;
}

/**
 * EI-19459526252132133: a full-tier `tools:invoke` dispatch is the honest exit
 * for a clipped FIELD, but for a record-structured section it is the wrong size
 * of answer —
 * on the measured 98,941-char Decisions section it re-serves all 30 records to
 * recover one, which overflows the door again. Now that plans:get resolves
 * `heading` to a `### ` subsection, ONE record is addressable, so the marker
 * names the first record the reader is actually missing. Still per the module
 * rule above: this pointer is advertised only because it now resolves.
 */
function recordRecoverHint(heading: string): string {
  return `plans:get { heading:"${heading}" } for one record, or ${SHAPE_RECOVER_HINT}`;
}

function recordMarker(
  shown: number,
  total: number,
  omittedChars: number,
  firstOmittedHeading?: string,
): string {
  const recover = firstOmittedHeading
    ? recordRecoverHint(firstOmittedHeading)
    : SHAPE_RECOVER_HINT;
  return (
    `…[TRUNCATED — showing ${shown} of ${total} "###" records, ` +
    `+${omittedChars} chars — recover: ${recover}]`
  );
}

/**
 * EI-22128943077118798: cap on how many omitted-record headings ride on
 * {@link ClippedSection.omittedHeadings}, so a mega-plan (30+ decisions) cannot
 * turn the sibling field into another oversized payload the caller has to page.
 */
const OMITTED_HEADINGS_CAP = 20;

export interface ClippedSection {
  body: string;
  truncated: boolean;
  /** Length of the ORIGINAL body, before any clip. */
  fullChars: number;
  /** Present only for a record-structured body that was cut. */
  recordsShown?: number;
  recordsTotal?: number;
  /**
   * EI-22128943077118798: the heading of every OMITTED `### ` record (capped at
   * {@link OMITTED_HEADINGS_CAP}, with a trailing "+N more" entry beyond that),
   * as a SIBLING field alongside `body` rather than only inside its in-band
   * marker.
   *
   * This is deliberately NOT a substitute for the in-band marker above (see the
   * file header on why a sibling alone is not enough against a caller's
   * `projection.pick` stripping it) — it defends against a DIFFERENT failure
   * mode this module did not yet cover: the generic outer bounded-payload
   * envelope re-truncates an already-shape-clipped `body` when the whole
   * result still overflows the per-call budget, and it clips from the tail —
   * exactly where the in-band recover marker lives. Measured live
   * (EI-22128943077118798): a `body_records_shown`/`body_records_total`-bearing
   * response still lost its embedded "which record is missing" marker to that
   * outer clip, while short sibling fields survived untouched (the outer
   * truncator targets the single largest string, not small fields). A grading
   * spot-check read the truncated Decisions section and could not tell which
   * decision had been cut. This field is small by construction, so it survives
   * that outer clip and states plainly which records were omitted even when
   * the body's own marker does not make it through.
   */
  omittedHeadings?: string[];
}

function boundedOmittedHeadings(body: string, offsets: number[]): string[] {
  const shown = offsets.slice(0, OMITTED_HEADINGS_CAP).map((offset) => recordHeadingAt(body, offset));
  if (offsets.length > OMITTED_HEADINGS_CAP) {
    shown.push(`+${offsets.length - OMITTED_HEADINGS_CAP} more`);
  }
  return shown;
}

/**
 * Clip one heading-narrowed section body to `n` chars.
 *
 * A body with 2+ `### ` records is cut at a record BOUNDARY, never mid-record,
 * and its marker reports records rather than chars. Anything else falls back to
 * {@link clipWithMarker}. Either way the marker rides IN BAND.
 */
export function clipSectionBody(body: string, n: number): ClippedSection {
  const fullChars = body.length;
  if (fullChars <= n) return { body, truncated: false, fullChars };

  const offsets = recordOffsets(body);
  const total = offsets.length;

  if (total >= 2) {
    // Reserve against the worst case, as in clipWithMarker — the quoted heading
    // is bounded by RECOVER_HEADING_MAX, so a full-length placeholder makes the
    // reserve an upper bound on every marker this call can emit.
    const reserve = recordMarker(
      total,
      total,
      fullChars,
      "x".repeat(RECOVER_HEADING_MAX),
    ).length;
    const budget = n - reserve;
    // Largest record boundary that still fits. offsets[0] is the head preamble's
    // end; cutting there would show ZERO records, so require at least one.
    let cutAt = -1;
    let shown = 0;
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i]! <= budget) {
        cutAt = offsets[i]!;
        shown = i;
      } else break;
    }
    if (cutAt > 0) {
      const kept = body.slice(0, cutAt);
      return {
        // `cutAt` IS the start of the first omitted record — the one the reader
        // is missing, and so the one worth naming.
        body: `${kept}${recordMarker(shown, total, fullChars - cutAt, recordHeadingAt(body, cutAt))}`,
        truncated: true,
        fullChars,
        recordsShown: shown,
        recordsTotal: total,
        omittedHeadings: boundedOmittedHeadings(body, offsets.slice(shown)),
      };
    }
    // The FIRST record alone overruns the budget — a boundary cut would show
    // nothing. Fall back to a char clip, but still report the record counts so
    // the caller learns it is seeing 0 complete records of `total`.
    return {
      // Zero complete records survive, so the record the reader most needs is
      // the FIRST one — name it rather than falling back to the whole-payload
      // exit that re-serves all `total` records to recover one.
      body: clipWithMarker(body, n, recordRecoverHint(recordHeadingAt(body, offsets[0]!))),
      truncated: true,
      fullChars,
      recordsShown: 0,
      recordsTotal: total,
      omittedHeadings: boundedOmittedHeadings(body, offsets),
    };
  }

  return { body: clipWithMarker(body, n), truncated: true, fullChars };
}
