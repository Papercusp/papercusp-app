/**
 * coord:send over-cap chunking (review-system-rework-reduction-2026-09-23 P-008,
 * clause RSR-P-008-B: "coord:send delivers a body over the delivery cap in full,
 * as chunks").
 *
 * WHY THIS EXISTS. A default inbox read shows at most {@link DEFAULT_INBOX_BODY_CAP}
 * characters of one message body (EI-21826596284846555). Before this module an
 * over-cap body was either REFUSED at the schema (expects != 'none') or persisted
 * and then reported as a failed, lossy send (expects:'none',
 * spec-coord-send-no-silent-body-truncation@3). Both outcomes cost the sender a
 * second round-trip, and 23.6% of coord:send calls in the 7-day census before
 * this change were refusals. Chunking keeps the guarantee those guards protect —
 * every character the recipient needs is visible in a normal inbox read — without
 * making the sender re-author the message: the body is split into ordered parts,
 * each of which fits the cap in full.
 *
 * THE CONTRACT (pinned by send-chunking.test.ts):
 *  - A body at or under the cap is returned untouched, as one message.
 *  - Every part's flattened body (the same `sectionsToText` projection the
 *    delivery diagnostics measure) is <= the cap, so no part is ever clipped.
 *  - {@link reassembleChunkedBodies} over the delivered parts returns the
 *    ORIGINAL section array exactly: same texts, same per-section metadata.
 *  - Only the FINAL part carries the message's ask: its `expects`, wake,
 *    reply-threading and every other envelope field. Earlier parts are
 *    `expects:'none'` continuations with no wake, so the recipient is woken once,
 *    after every part is persisted, and owes one reply, not N.
 *  - A body that would need more than {@link COORD_SEND_MAX_CHUNK_PARTS} parts is
 *    refused with a pointer to the durable long-form surfaces, rather than
 *    fanning into a flood of inbox lines.
 */
import { createHash } from 'node:crypto';

import { sectionsToText, toSections, type MessageSection } from '../message-fields';
import { COORD_SEND_MAX_CHUNK_PARTS, DEFAULT_INBOX_BODY_CAP } from './inbox-content-bounds';

/** Upper bound on parts per chunked message (defined beside the cap it scales).
 *  The longest agent-authored coord:send body in the 7-day census taken for
 *  P-008 was 5,181 chars; past the limit the content is an artifact, not a
 *  message, and belongs on a work item. */
export { COORD_SEND_MAX_CHUNK_PARTS };

/** Separator `sectionsToText` puts between sections. */
const SECTION_JOIN = '\n\n';

/** Fields that describe WHERE a message goes and how it is attributed. Every
 *  part carries these, so each part routes, scopes and relays exactly as the
 *  original would have. Every other field rides the final part only. */
const CONTINUATION_FIELDS = [
  'to',
  'harness',
  'scope',
  'hive',
  'allHive',
  'asAuthority',
  'plan_slug',
  'noBodyRefs',
  'relayOf',
  'relayQuote',
] as const;

export interface ChunkableMessage {
  to: string[];
  summary: string;
  body?: string | MessageSection[];
  expects: string;
}

export interface ChunkPartMeta {
  /** Stable id shared by every part of one chunked message. */
  group: string;
  /** 1-based part number. */
  part: number;
  /** Total parts. */
  of: number;
}

export type ChunkResult<M extends ChunkableMessage> =
  | { kind: 'single'; message: M }
  | { kind: 'chunked'; group: string; parts: Array<{ message: M; meta: ChunkPartMeta }> }
  | { kind: 'refused'; error: 'body_exceeds_chunk_limit'; message: string; partsNeeded: number };

const HEADER_RE = /^⟦part (\d+)\/(\d+) g:([0-9a-f]{8})( cont)?⟧$/;

/** The first section of every part: which part this is, of how many, which
 *  message it belongs to, and whether its first content section continues the
 *  previous part's last section. Readable by a human; parsed by
 *  {@link reassembleChunkedBodies}. */
export function chunkHeaderText(part: number, of: number, group: string, continues: boolean): string {
  return `⟦part ${part}/${of} g:${group}${continues ? ' cont' : ''}⟧`;
}

/** Header length for the widest header this module can emit, so the per-part
 *  content budget holds whatever the final part count turns out to be. */
const WIDEST_HEADER_CHARS = chunkHeaderText(
  COORD_SEND_MAX_CHUNK_PARTS * 10,
  COORD_SEND_MAX_CHUNK_PARTS * 10,
  'ffffffff',
  true,
).length;

/** Content characters one part can carry under `cap`: the cap minus the widest
 *  header and the separator between the header and the first content section.
 *  Exported so a boundary test can build a body of EXACTLY N full parts. */
export function chunkContentBudget(cap: number = DEFAULT_INBOX_BODY_CAP): number {
  return cap - WIDEST_HEADER_CHARS - SECTION_JOIN.length;
}

/**
 * Split one text into contiguous slices of at most `budget` characters whose
 * concatenation is exactly `text`. Cuts prefer a paragraph break, then a line
 * break, then a sentence end, then a space, and never land inside a UTF-16
 * surrogate pair; a boundary is only used when it keeps at least half the
 * budget, so a single early newline cannot shred the text into slivers.
 */
export function splitTextForChunks(text: string, budget: number): string[] {
  if (budget < 1) throw new Error(`splitTextForChunks: budget must be >= 1 (got ${budget})`);
  const slices: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    const floor = Math.floor(budget / 2);
    let cut = -1;
    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= floor) cut = paragraph + 2;
    if (cut < 0) {
      const line = window.lastIndexOf('\n');
      if (line >= floor) cut = line + 1;
    }
    if (cut < 0) {
      const sentence = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      if (sentence >= floor) cut = sentence + 2;
    }
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      if (space >= floor) cut = space + 1;
    }
    if (cut < 0 || cut > budget) cut = budget;
    const before = rest.charCodeAt(cut - 1);
    if (cut > 1 && before >= 0xd800 && before <= 0xdbff) cut -= 1;
    slices.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  slices.push(rest);
  return slices;
}

function groupIdFor(msg: ChunkableMessage, sections: MessageSection[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ to: msg.to, summary: msg.summary, sections }))
    .digest('hex')
    .slice(0, 8);
}

interface Unit {
  section: MessageSection;
  /** True when this unit continues the previous unit's section. */
  continues: boolean;
}

/**
 * Plan how one message is delivered: untouched, as ordered chunks, or refused.
 * Pure — no I/O — so the send handler can expand a batch before any persistence
 * and a test can pin the contract without a database.
 */
export function chunkOverCapMessage<M extends ChunkableMessage>(
  msg: M,
  cap: number = DEFAULT_INBOX_BODY_CAP,
  maxParts: number = COORD_SEND_MAX_CHUNK_PARTS,
): ChunkResult<M> {
  const sections = toSections(msg.body);
  if (!sections.length || sectionsToText(sections).length <= cap) return { kind: 'single', message: msg };

  const budget = chunkContentBudget(cap);
  if (budget < 1) throw new Error(`chunkOverCapMessage: cap ${cap} leaves no room for content`);

  const units: Unit[] = [];
  for (const section of sections) {
    if (section.text.length <= budget) {
      units.push({ section, continues: false });
      continue;
    }
    const [first, ...rest] = splitTextForChunks(section.text, budget);
    units.push({ section: { ...section, text: first }, continues: false });
    for (const slice of rest) units.push({ section: { text: slice }, continues: true });
  }

  // Greedy packing. A continuation unit always opens a NEW part, so the only
  // section that can continue across a boundary is a part's first content
  // section — which is what the header's ` cont` flag records.
  const packed: Array<{ units: Unit[]; length: number }> = [];
  for (const unit of units) {
    const current = packed[packed.length - 1];
    const added = unit.section.text.length + (current?.units.length ? SECTION_JOIN.length : 0);
    if (!current || unit.continues || current.length + added > budget) {
      packed.push({ units: [unit], length: unit.section.text.length });
    } else {
      current.units.push(unit);
      current.length += added;
    }
  }

  if (packed.length > maxParts) {
    return {
      kind: 'refused',
      error: 'body_exceeds_chunk_limit',
      partsNeeded: packed.length,
      message:
        `coord:send body is ${sectionsToText(sections).length} characters, which would take ` +
        `${packed.length} inbox-sized parts; coord:send delivers at most ${maxParts} parts per message ` +
        `(about ${maxParts * budget} characters). Nothing was sent. Put the long content on a durable ` +
        'surface — `work_items:comment { id, body }` for item detail, or `coord:message-agent { to, body }` ' +
        'for a direct peer artifact — then send a short `coord:send` pointer to it.',
    };
  }

  const group = groupIdFor(msg, sections);
  const of = packed.length;
  const forYouBecause = sections.find((section) => section.forYouBecause)?.forYouBecause;
  const record = msg as unknown as Record<string, unknown>;

  const parts = packed.map((entry, index) => {
    const part = index + 1;
    const isFinal = part === of;
    const header: MessageSection = { text: chunkHeaderText(part, of, group, entry.units[0].continues) };
    const content = entry.units.map((unit) => unit.section);
    // A directed ask needs a `forYouBecause` on the message that carries it. The
    // final part carries the ask, so give its header a copy when none of its own
    // sections has one. Headers are dropped on reassembly, so the copy never
    // appears in the recipient's reconstructed body.
    if (isFinal && forYouBecause && !content.some((section) => section.forYouBecause)) {
      header.forYouBecause = forYouBecause;
    }
    const body = [header, ...content];
    const summary = `${msg.summary} (part ${part}/${of})`;
    if (isFinal) return { message: { ...msg, summary, body } as M, meta: { group, part, of } };
    const continuation: Record<string, unknown> = { summary, body, expects: 'none' };
    for (const field of CONTINUATION_FIELDS) {
      if (record[field] !== undefined) continuation[field] = record[field];
    }
    return { message: continuation as unknown as M, meta: { group, part, of } };
  });

  return { kind: 'chunked', group, parts };
}

/**
 * Rebuild the original section array from delivered part bodies, in any order.
 * The inverse of {@link chunkOverCapMessage}: headers are dropped and a
 * `cont` part's first section is appended to the previous section's text.
 * Throws when a part is missing, duplicated, or from another group, because a
 * partial reassembly would silently present an incomplete message as whole.
 */
export function reassembleChunkedBodies(bodies: MessageSection[][]): MessageSection[] {
  const parsed = bodies.map((body) => {
    const match = HEADER_RE.exec(body[0]?.text ?? '');
    if (!match) throw new Error('reassembleChunkedBodies: a part has no chunk header');
    return {
      part: Number(match[1]),
      of: Number(match[2]),
      group: match[3],
      continues: Boolean(match[4]),
      content: body.slice(1),
    };
  });
  if (!parsed.length) return [];
  const { of, group } = parsed[0];
  if (parsed.some((entry) => entry.group !== group || entry.of !== of)) {
    throw new Error('reassembleChunkedBodies: parts belong to different messages');
  }
  parsed.sort((a, b) => a.part - b.part);
  if (parsed.length !== of || parsed.some((entry, index) => entry.part !== index + 1)) {
    throw new Error(`reassembleChunkedBodies: expected parts 1..${of}, got ${parsed.map((e) => e.part).join(',')}`);
  }
  const sections: MessageSection[] = [];
  for (const entry of parsed) {
    entry.content.forEach((section, index) => {
      const previous = sections[sections.length - 1];
      if (index === 0 && entry.continues && previous) {
        sections[sections.length - 1] = { ...previous, text: previous.text + section.text };
      } else {
        sections.push({ ...section });
      }
    });
  }
  return sections;
}
