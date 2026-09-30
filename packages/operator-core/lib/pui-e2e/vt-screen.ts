/**
 * Minimal VT screen grid for installed-binary Ratatui PTY tests.
 *
 * Ratatui writes cursor-jump diffs: later frames contain only changed cells,
 * so stripping ANSI from the raw stream cannot recover what a person sees.
 * This parser replays the stream into a fixed-size grid and exposes the
 * rendered screen for assertions.
 */

// Written as an escape sequence rather than a raw control byte so
// lint:no-control-bytes remains green. Runtime-identical.
const ESC = '\x1b';

export class VtScreen {
  private grid: string[][];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;

  constructor(
    private rows: number,
    private cols: number,
  ) {
    this.grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  }

  private clamp(v: number, max: number): number {
    return Math.max(0, Math.min(v, max));
  }

  private clearAll(): void {
    for (const row of this.grid) row.fill(' ');
  }

  private clearRow(row: number, from: number, to: number): void {
    for (let col = from; col < to; col++) this.grid[row][col] = ' ';
  }

  private lineFeed(): void {
    this.row++;
    if (this.row >= this.rows) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.cols).fill(' '));
      this.row = this.rows - 1;
    }
  }

  private put(ch: string): void {
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = ch;
    this.col++;
  }

  private csi(params: string, final: string): void {
    const isPrivate = params.startsWith('?');
    const nums = (isPrivate ? params.slice(1) : params)
      .split(';')
      .map((param) => parseInt(param, 10))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = nums[0] ?? 0;
    switch (final) {
      case 'H':
      case 'f':
        this.row = this.clamp((nums[0] || 1) - 1, this.rows - 1);
        this.col = this.clamp((nums[1] || 1) - 1, this.cols - 1);
        break;
      case 'A':
        this.row = this.clamp(this.row - (first || 1), this.rows - 1);
        break;
      case 'B':
        this.row = this.clamp(this.row + (first || 1), this.rows - 1);
        break;
      case 'C':
        this.col = this.clamp(this.col + (first || 1), this.cols - 1);
        break;
      case 'D':
        this.col = this.clamp(this.col - (first || 1), this.cols - 1);
        break;
      case 'G':
        this.col = this.clamp((first || 1) - 1, this.cols - 1);
        break;
      case 'd':
        this.row = this.clamp((first || 1) - 1, this.rows - 1);
        break;
      case 'J':
        if (first === 2 || first === 3) this.clearAll();
        else if (first === 1) {
          for (let row = 0; row < this.row; row++) this.clearRow(row, 0, this.cols);
          this.clearRow(this.row, 0, this.col + 1);
        } else {
          this.clearRow(this.row, this.col, this.cols);
          for (let row = this.row + 1; row < this.rows; row++) {
            this.clearRow(row, 0, this.cols);
          }
        }
        break;
      case 'K':
        if (first === 2) this.clearRow(this.row, 0, this.cols);
        else if (first === 1) this.clearRow(this.row, 0, this.col + 1);
        else this.clearRow(this.row, this.col, this.cols);
        break;
      case 'h':
      case 'l':
        // Alt-screen enter/leave means a fresh screen. Other private modes
        // (cursor visibility, mouse, bracketed paste) do not affect the grid.
        if (isPrivate && nums.includes(1049)) {
          this.clearAll();
          this.row = 0;
          this.col = 0;
        }
        break;
      default:
        break;
    }
  }

  /**
   * Feed the whole raw stream from scratch. An incomplete trailing escape
   * sequence is left for the next replay instead of being mis-parsed.
   */
  feed(data: string): void {
    let index = 0;
    while (index < data.length) {
      const ch = data[index];
      if (ch === ESC) {
        const kind = data[index + 1];
        if (kind === undefined) break;
        if (kind === '[') {
          let end = index + 2;
          while (end < data.length && !(data[end] >= '@' && data[end] <= '~')) end++;
          if (end >= data.length) break;
          this.csi(data.slice(index + 2, end), data[end]);
          index = end + 1;
        } else if (kind === ']') {
          let end = index + 2;
          while (end < data.length && data[end] !== '\x07' && !(data[end] === ESC && data[end + 1] === '\\')) {
            end++;
          }
          if (end >= data.length) break;
          index = data[end] === '\x07' ? end + 1 : end + 2;
        } else if (kind === '7') {
          this.savedRow = this.row;
          this.savedCol = this.col;
          index += 2;
        } else if (kind === '8') {
          this.row = this.savedRow;
          this.col = this.savedCol;
          index += 2;
        } else if (kind === '(' || kind === ')') {
          index += 3;
        } else {
          index += 2;
        }
        continue;
      }
      if (ch === '\n') this.lineFeed();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = this.clamp(this.col - 1, this.cols - 1);
      else if (ch === '\t') {
        this.col = this.clamp((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
      } else if (ch >= ' ' && ch !== '\x7f') {
        this.put(ch);
      }
      index++;
    }
  }

  text(): string {
    return this.grid.map((row) => row.join('').trimEnd()).join('\n');
  }
}

/**
 * Codepoints a terminal lays out across TWO columns — East Asian Wide and
 * Fullwidth forms, plus the emoji planes.
 *
 * `put` above models every character as ONE cell, because the grid is a cell
 * array and not a shaped line. Ratatui positions the glyph following a wide one
 * past its continuation column, and this parser honours that cursor move, so
 * the continuation column replays as the blank it was initialised to. A typed
 * `日本語` therefore reads back off the grid as `日 本 語`.
 *
 * That padding is the CAPTURE's geometry, never the product's buffer, and the
 * screen dump proves which: the narrow characters beside it (`δ`, `ü`) are
 * unpadded, and a composer inserting literal spaces would have no reason to pad
 * exactly and only the double-width codepoints.
 */
const WIDE_CELL =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1F9FF}]|[\u{20000}-\u{3FFFD}]/u;

/** Drop the blank continuation column that follows each double-width glyph. */
function collapseWideCells(line: string): string {
  const chars = [...line];
  let out = '';
  for (let index = 0; index < chars.length; index++) {
    out += chars[index];
    if (WIDE_CELL.test(chars[index]) && chars[index + 1] === ' ') index++;
  }
  return out;
}

/** Normalize column padding while retaining row boundaries. */
export function screenContains(screen: string, needle: string): boolean {
  const lines = screen.split('\n').map((line) => line.replace(/\s+/g, ' ').trim());
  const want = needle.replace(/\s+/g, ' ').trim();
  if (lines.join('\n').includes(want)) return true;
  // Continuation padding can only ever hide a needle that itself carries a
  // double-width glyph, so this second attempt is gated on one: an ASCII needle
  // has already returned, and no existing assertion's verdict can change.
  // Deliberately one-directional — the SCREEN is collapsed and the needle never
  // is, so this recovers a match the padding hid and cannot make two distinct
  // strings compare equal. A needle whose own spacing is meaningful (a real
  // space immediately after a wide glyph) is served by the first attempt.
  if (!WIDE_CELL.test(want)) return false;
  return lines.map(collapseWideCells).join('\n').includes(want);
}

/**
 * Whether the bordered pane whose top border starts with `title` contains
 * `needle`, reading its rows as one wrapped paragraph. A soft wrap splits a
 * phrase across rows, and where it falls depends on which side panes are open;
 * `screenContains` keeps row boundaries, and joining rows of the whole screen
 * would splice neighbouring panes together. Only this pane's columns are read.
 */
export function paneContains(screen: string, title: string, needle: string): boolean {
  const rows = screen.split('\n').map((row) => Array.from(row));
  const want = needle.replace(/\s+/g, ' ').trim();
  for (let top = 0; top < rows.length; top++) {
    const line = rows[top].join('');
    const at = line.indexOf(`┌ ${title}`);
    if (at < 0) continue;
    const column = Array.from(line.slice(0, at)).length;
    const right = rows[top].indexOf('┐', column);
    if (right < 0) continue;
    const body: string[] = [];
    for (const row of rows.slice(top + 1)) {
      if (row[column] !== '│') break;
      body.push(row.slice(column + 1, right).join(''));
    }
    if (body.join(' ').replace(/\s+/g, ' ').includes(want)) return true;
  }
  return false;
}

/** Match an assistant bubble, never an echoed owner prompt. */
export function screenHasAssistantReply(screen: string, needle: string | RegExp): boolean {
  const rows = screen.split('\n');
  const top = rows.findIndex((row) => row.startsWith('┌ Agent Chat'));
  if (top < 0) return false;
  const right = rows[top].indexOf('┐');
  if (right < 2) return false;
  const body = rows.slice(top + 1);
  const bottom = body.findIndex((row) => row.startsWith('└'));
  // The transcript's border defines its columns; content may itself contain
  // pipes, and another pane may contain words that resemble an answer.
  const lines = (bottom < 0 ? body : body.slice(0, bottom))
    .filter((row) => row.startsWith('│'))
    .map((row) => row.slice(1, right).trimEnd());
  const matches = (line: string): boolean => {
    if (typeof needle === 'string') return line.includes(needle);
    needle.lastIndex = 0;
    return needle.test(line);
  };
  // The transcript is a list with a two-column highlight gutter, so a role
  // label renders as `  agent`, or `▸ agent` on the focused message.
  const roleOf = (line: string): string | undefined => /^(?:▸ | {2})?(agent|you)$/.exec(line)?.[1];
  for (let index = 0; index < lines.length; index++) {
    if (roleOf(lines[index]) !== 'agent') continue;
    for (let replyIndex = index + 1; replyIndex < lines.length; replyIndex++) {
      const line = lines[replyIndex];
      if (roleOf(line)) break;
      // Reasoning/tool detail rows are indented; the rendered final answer is
      // top-level even when it follows those sections in the same bubble.
      if (line.trim() && !/^\s/.test(line) && matches(line)) return true;
    }
  }
  return false;
}
