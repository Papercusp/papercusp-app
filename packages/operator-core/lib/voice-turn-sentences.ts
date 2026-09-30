/**
 * voice-turn-sentences — incremental speakable-sentence extraction for the
 * device voice-turn SSE route (on-desktop-direct-lan-voice-2026-07-14
 * P-001/D-005/D-006).
 *
 * The papercup/operator converse brains stream raw `delta` text that may
 * contain the operator tag protocol (<say>, <set_mode>, <sleep>, <report>,
 * <spawn …>, <continue/>). The phone must SPEAK only clean prose:
 *
 *   - <say>…</say> content is unwrapped — it IS the spoken reply;
 *   - every other control tag block is dropped entirely — markup is never
 *     spoken aloud (D-006);
 *   - bare prose outside any tag is spoken (parseOperatorTurn's defensive
 *     fallback treats a tagless turn as spoken content — mirrored here);
 *   - a partially-arrived tag at the stream tail is DEFERRED until its
 *     closing '>' arrives (the operator-converse-voice.ts
 *     hasUnclosedTrailingTag idea, restated as a char state machine);
 *   - a lone '<' that isn't starting a tag ("2 < 5", "i <3 u") stays
 *     literal text.
 *
 * Sentences complete on [.!?…] followed by whitespace (with a digit-decimal
 * guard so "3.5s" doesn't split) or on a newline, so TTS can start on the
 * FIRST sentence while the brain is still streaming — the whole point of
 * the streamed turn (D-005).
 *
 * Pure + synchronous; unit-tests without audio or network.
 */

/** Tag names of the operator tag protocol whose BLOCKS are never spoken. */
const SKIP_TAGS = new Set([
  'set_mode',
  'sleep',
  'report',
  'spawn',
  'handoff',
  'deep_delegate',
  'deep-delegate',
  'continue',
  'tool_call',
]);

/** Longest plausible tag literal — anything longer is literal '<' text. */
const MAX_TAG_LITERAL = 300;

const SENTENCE_END = new Set(['.', '!', '?', '…']);

/** Does the candidate sentence contain anything worth speaking? */
function isSpeakable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

export interface SentenceExtractor {
  /** Feed a raw delta chunk; returns any NEWLY completed speakable sentences. */
  feed(chunk: string): string[];
  /** End of stream: returns the final unterminated sentence, if any. */
  flush(): string[];
}

export function createSentenceExtractor(): SentenceExtractor {
  /** 'text' = passing prose through · 'tag' = accumulating a <…> literal ·
   *  'skip' = inside a control-tag block waiting for its close tag. */
  let mode: 'text' | 'tag' | 'skip' = 'text';
  let tagBuf = '';
  let skipClose = ''; // lower-cased literal close tag that ends the skip
  let skipBuf = '';
  /** Clean speakable prose not yet emitted as complete sentences. */
  let clean = '';

  function handleCompleteTag(literal: string): void {
    const m = /^<\/?([a-zA-Z_][\w-]*)/.exec(literal);
    if (!m) {
      // Not a real tag after all — keep it as literal prose.
      clean += literal;
      return;
    }
    const name = m[1].toLowerCase();
    const isClosing = literal.startsWith('</');
    const isSelfClosing = /\/>$/.test(literal);
    if (name === 'say') {
      // Unwrap: drop the tag literal, keep streaming its inner prose.
      return;
    }
    if (isClosing || isSelfClosing) {
      // Stray close / self-closing control tag — drop the literal.
      return;
    }
    if (SKIP_TAGS.has(name)) {
      mode = 'skip';
      skipClose = `</${name}>`;
      skipBuf = '';
      return;
    }
    // Unknown opening tag (model improvisation) — treat its literal as
    // dropped markup but do NOT skip its content: prose after an unknown
    // opener is more likely speech than machinery.
  }

  function process(input: string): void {
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (mode === 'text') {
        if (ch === '<') {
          mode = 'tag';
          tagBuf = '<';
        } else {
          clean += ch;
        }
        continue;
      }
      if (mode === 'tag') {
        if (tagBuf.length === 1) {
          // First char after '<' decides whether this is tag-like at all.
          if (!/[a-zA-Z/]/.test(ch)) {
            clean += tagBuf + ch;
            mode = 'text';
            tagBuf = '';
            continue;
          }
        }
        tagBuf += ch;
        if (ch === '>') {
          const literal = tagBuf;
          tagBuf = '';
          mode = 'text';
          handleCompleteTag(literal);
        } else if (tagBuf.length > MAX_TAG_LITERAL) {
          // Malformed runaway "tag" — reclassify as literal prose.
          clean += tagBuf;
          tagBuf = '';
          mode = 'text';
        }
        continue;
      }
      // mode === 'skip'
      skipBuf += ch;
      if (ch === '>') {
        const idx = skipBuf.toLowerCase().lastIndexOf(skipClose);
        if (idx >= 0 && idx + skipClose.length === skipBuf.length) {
          mode = 'text';
          skipBuf = '';
          skipClose = '';
        }
      }
    }
  }

  /** Pull complete sentences off the front of `clean`. */
  function drainSentences(): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      let boundary = false;
      if (ch === '\n') {
        boundary = true;
      } else if (SENTENCE_END.has(ch)) {
        const next = clean[i + 1];
        // Only a boundary once the FOLLOWING char has arrived and is
        // whitespace — an end-of-buffer '.' may still be mid-number or
        // mid-ellipsis, so it waits for the next chunk.
        if (next !== undefined && /\s/.test(next)) {
          const prev = clean[i - 1];
          const after = clean[i + 1];
          const decimal =
            ch === '.' && prev !== undefined && /\d/.test(prev) && after !== undefined && /\d/.test(after);
          if (!decimal) boundary = true;
        }
      }
      if (boundary) {
        const sentence = clean.slice(start, i + 1).trim();
        if (sentence && isSpeakable(sentence)) out.push(sentence);
        start = i + 1;
      }
    }
    clean = clean.slice(start);
    return out;
  }

  return {
    feed(chunk: string): string[] {
      if (!chunk) return [];
      process(chunk);
      return drainSentences();
    },
    flush(): string[] {
      // An unterminated tag literal or skip block at end-of-stream is
      // markup noise, never speech — drop it (mirrors parseOperatorTurn
      // dropping unclosed machinery).
      tagBuf = '';
      skipBuf = '';
      const rest = clean.trim();
      clean = '';
      return rest && isSpeakable(rest) ? [rest] : [];
    },
  };
}
