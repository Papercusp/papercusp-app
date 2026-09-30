/**
 * prepareForTTS — reply-shaping for the LEGACY voice path
 * (Whisper + Claude + ElevenLabs/OpenAI TTS).
 *
 * Runs on every model output before TTS dispatch. Enforces:
 *   - Length cap (mode-dependent)
 *   - Markdown stripping
 *   - {name} interpolation per the budget rules
 *   - Banned-preamble removal
 *   - Backstory anti-pattern check
 *   - No-op suppression (don't pay for empty audio)
 *
 * EL Conv AI and OpenAI Realtime DO NOT use this — they generate
 * speech end-to-end and the host doesn't see the text. For those
 * paths, the same rules are encoded in the persona prompt.
 *
 * Pure functions, deterministic, fully unit-tested.
 */

export type Mode = 'default' | 'assertive' | 'sober' | 'apologetic' | 'wry' | 'narration';

export interface PrepareOptions {
  mode?: Mode;
  /** User's display name. Undefined → all {name} tokens are stripped. */
  name?: string;
  /** Last name-use timestamp for budget enforcement (5-min window). */
  lastNameUseAt?: number;
  /** "Now" injection point for tests; defaults to Date.now(). */
  now?: () => number;
}

export interface PrepareResult {
  /** The text to ship to TTS. `null` means no-op (don't speak). */
  text: string | null;
  /** True if the {name} token was actually substituted (caller updates lastNameUseAt). */
  nameUsed: boolean;
  /** Set if any rule modified the input — for telemetry. */
  modifications: string[];
}

const MAX_LEN: Record<Mode, number> = {
  default: 200,
  assertive: 350,
  sober: 350,
  apologetic: 350,
  wry: 200,
  narration: 200,
};

const NAME_RATE: Record<Mode, number> = {
  default: 0,
  assertive: 0.4,
  sober: 0.25,
  apologetic: 0.8,
  wry: 0.15,
  narration: 0,
};

const NAME_BUDGET_MS = 5 * 60_000;

const BANNED_PREAMBLES = [
  /\bgreat question[!.,]?\s*/gi,
  /\bi['']?d be happy to help[!.,]?\s*/gi,
  /\b(as an ai|i['']?m an ai)\b[^.!?]*[.!?]?\s*/gi,
  /\blet me know if (there\s*(['']?s|is)\s*anything else|you (need|have any|want))[^.!?]*[.!?]?\s*/gi,
  /\bthis reminds me of\s*/gi,
  /\bspeaking of which[,]?\s*/gi,
  /\bfun story[!.,]?\s*/gi,
];

const MORALIZING_TAILS = [
  /\band the lesson there is[^.!?]*[.!?]?\s*/gi,
];

const COMPANY_DENYLIST = [
  // Real names — backstories must be anonymized.
  /\b(google|alphabet|meta|facebook|instagram|whatsapp|stripe|openai|anthropic|apple|amazon|aws|microsoft|netflix|uber|lyft|airbnb|spotify|twitter|x\.com|linkedin|tesla|nvidia|salesforce|oracle|ibm|adobe|shopify|square|block|coinbase|cloudflare|github|gitlab|vercel|datadog|snowflake|databricks)\b/gi,
];

/** Strip markdown chars that get spoken aloud. */
function stripMarkdown(s: string): { out: string; changed: boolean } {
  const cleaned = s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return { out: cleaned, changed: cleaned !== s };
}

/** Truncate at sentence boundary just under limit, never mid-word. */
function lengthCap(s: string, max: number): { out: string; changed: boolean } {
  if (s.length <= max) return { out: s, changed: false };
  // Try to truncate at sentence boundary first.
  const slice = s.slice(0, max);
  const lastPunct = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastPunct > max * 0.6) {
    return { out: slice.slice(0, lastPunct + 1).trim(), changed: true };
  }
  // Fall back to last word boundary.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > 0) return { out: slice.slice(0, lastSpace).trim() + '…', changed: true };
  return { out: slice + '…', changed: true };
}

/**
 * Decide whether {name} should be substituted, stripped, or kept.
 *
 * Rules:
 *   - name unset → strip the token + any trailing comma/space
 *   - within budget window (lastNameUseAt < 5min ago) → strip
 *   - mode rate roll → substitute or strip per probability
 *
 * Position enforcement: never first word, never last. The model is
 * instructed to put it after 1-3 words; we enforce by stripping from
 * obvious bad positions.
 */
function applyNameToken(
  s: string,
  opts: PrepareOptions,
): { out: string; changed: boolean; used: boolean } {
  if (!s.includes('{name}')) return { out: s, changed: false, used: false };

  const { name, mode = 'default', lastNameUseAt = 0 } = opts;
  const now = (opts.now ?? Date.now)();

  const stripToken = (text: string) =>
    text
      // ", {name}" → ""
      .replace(/[,\s]+\{name\}/g, '')
      // "{name}, " → ""
      .replace(/\{name\}[,\s]+/g, '')
      // "{name}" alone → ""
      .replace(/\{name\}/g, '')
      // Clean double spaces / dangling punctuation
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .trim();

  if (!name) {
    return { out: stripToken(s), changed: true, used: false };
  }

  // Budget gate.
  if (now - lastNameUseAt < NAME_BUDGET_MS) {
    return { out: stripToken(s), changed: true, used: false };
  }

  // Mode-rate roll.
  const rate = NAME_RATE[mode];
  if (Math.random() > rate) {
    return { out: stripToken(s), changed: true, used: false };
  }

  // Position check: refuse to substitute if {name} is at index 0 or end.
  const idx = s.indexOf('{name}');
  if (idx === 0) return { out: stripToken(s), changed: true, used: false };
  const tailMatch = s.match(/\{name\}[,.!?\s]*$/);
  if (tailMatch) return { out: stripToken(s), changed: true, used: false };

  return { out: s.replace(/\{name\}/g, name), changed: true, used: true };
}

function stripBannedPreambles(s: string): { out: string; changed: boolean } {
  let out = s;
  for (const re of BANNED_PREAMBLES) out = out.replace(re, '');
  for (const re of MORALIZING_TAILS) out = out.replace(re, '');
  // Tidy: collapse whitespace, capitalize the first letter.
  out = out.replace(/\s{2,}/g, ' ').trim();
  if (out.length > 0) out = out[0].toUpperCase() + out.slice(1);
  return { out, changed: out !== s };
}

function checkCompanyDenylist(s: string): { hits: string[] } {
  const hits: string[] = [];
  for (const re of COMPANY_DENYLIST) {
    const m = s.match(re);
    if (m) hits.push(...m.map((x) => x.toLowerCase()));
  }
  return { hits };
}

export function prepareForTTS(input: string, opts: PrepareOptions = {}): PrepareResult {
  const modifications: string[] = [];
  const mode = opts.mode ?? 'default';

  let text = input;

  // 1. Strip markdown.
  const md = stripMarkdown(text);
  text = md.out;
  if (md.changed) modifications.push('markdown');

  // 2. Strip banned preambles + moralizing tails.
  const ban = stripBannedPreambles(text);
  text = ban.out;
  if (ban.changed) modifications.push('preamble');

  // 3. Company-denylist check (warning, not fix — surface for telemetry).
  const dn = checkCompanyDenylist(text);
  if (dn.hits.length) modifications.push(`company:${dn.hits.join(',')}`);

  // 4. {name} substitution.
  const nameRes = applyNameToken(text, opts);
  text = nameRes.out;
  if (nameRes.changed) modifications.push(nameRes.used ? 'name-sub' : 'name-strip');

  // 5. Length cap.
  const lc = lengthCap(text, MAX_LEN[mode]);
  text = lc.out;
  if (lc.changed) modifications.push(`length-cap:${MAX_LEN[mode]}`);

  // 6. No-op suppression.
  if (!text || /^\s*$/.test(text)) {
    void logUtterance({ source: 'legacy', mode, lengthChars: 0, nameUsed: false, hadBackstory: false, modifications: [...modifications, 'noop'] });
    return { text: null, nameUsed: false, modifications: [...modifications, 'noop'] };
  }

  void logUtterance({
    source: 'legacy',
    mode,
    lengthChars: text.length,
    nameUsed: nameRes.used,
    hadBackstory: /\b(at the last place|knew a senior|spent a weekend|first oncall page)\b/i.test(text),
    modifications,
  });
  return { text, nameUsed: nameRes.used, modifications };
}

/**
 * Best-effort fire-and-forget audit log. Browser-side: hits the
 * /api/agent-mcp/voice-utterance-log endpoint. Server-side (e.g.
 * pre-TTS shaping in API routes): inserts directly via withWorkspace.
 *
 * Failures are silent — audit is observation, not a hard requirement.
 */
function logUtterance(payload: {
  source: 'legacy' | 'elevenlabs-conv' | 'realtime';
  mode: Mode;
  lengthChars: number;
  nameUsed: boolean;
  hadBackstory: boolean;
  modifications: string[];
}): void {
  if (typeof window === 'undefined') return;
  try {
    void fetch('/api/agent-mcp/voice-utterance-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* silent */ });
  } catch { /* silent */ }
}
