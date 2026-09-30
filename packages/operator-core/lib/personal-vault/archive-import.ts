import AdmZip from 'adm-zip';
import type { Readable } from 'node:stream';
import { simpleParser } from 'mailparser';
import * as yauzl from 'yauzl';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import type { PersonalDocumentInput } from './types';
import { dedupeKeyFor, normalizeParticipant, normalizePersonalSource } from './store';
import { openEncryptedPersonalArchive } from './archive-encryption';

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_STREAMED_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_STREAMED_UNCOMPRESSED_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_STREAMED_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_MBOX_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface ParsedPersonalArchive {
  documents: PersonalDocumentInput[];
  sources: string[];
  warnings: string[];
}

function unfoldLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function headerMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ').split('\n');
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

function addresses(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(normalizeParticipant).filter(Boolean);
}

export function parseMbox(text: string): PersonalDocumentInput[] {
  const chunks = text.replace(/\r\n/g, '\n').split(/\n(?=From [^\n]+\n)/g);
  return chunks.flatMap((chunk, index) => {
    const withoutEnvelope = chunk.replace(/^From [^\n]*\n/, '');
    const split = withoutEnvelope.search(/\n\n/);
    if (split < 0) return [];
    const headers = headerMap(withoutEnvelope.slice(0, split));
    const body = withoutEnvelope.slice(split + 2).trim();
    const externalId = headers.get('message-id')?.replace(/[<>]/g, '') ?? null;
    const doc: PersonalDocumentInput = {
      source: 'gmail',
      kind: 'message',
      externalId,
      occurredAt: headers.get('date') ?? null,
      participants: [...addresses(headers.get('from')), ...addresses(headers.get('to')), ...addresses(headers.get('cc'))],
      title: headers.get('subject') ?? '(no subject)',
      text: body,
      metadata: { from: headers.get('from') ?? null, to: headers.get('to') ?? null },
    };
    doc.dedupeKey = externalId ? `gmail:${externalId}` : `gmail:mbox:${index}:${dedupeKeyFor(doc)}`;
    return [doc];
  });
}

function icalValue(lines: string[], key: string): string | undefined {
  const line = lines.find((l) => l.toUpperCase().startsWith(`${key.toUpperCase()}:`) || l.toUpperCase().startsWith(`${key.toUpperCase()};`));
  return line?.slice(line.indexOf(':') + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').trim();
}

function icalDate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{8}T\d{6}Z$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`;
  return raw;
}

export function parseIcs(text: string): PersonalDocumentInput[] {
  const lines = unfoldLines(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT' && current) { blocks.push(current); current = null; }
    else if (current) current.push(line);
  }
  return blocks.map((block, index) => {
    const uid = icalValue(block, 'UID') ?? `event-${index}`;
    const participantLines = block.filter((l) => /^(ATTENDEE|ORGANIZER)[;:]/i.test(l));
    const participants = participantLines.map((l) => normalizeParticipant(l.slice(l.indexOf(':') + 1))).filter(Boolean);
    return {
      source: 'calendar', kind: 'event', externalId: uid,
      occurredAt: icalDate(icalValue(block, 'DTSTART')),
      participants,
      title: icalValue(block, 'SUMMARY') ?? '(untitled event)',
      text: icalValue(block, 'DESCRIPTION') ?? '',
      metadata: { location: icalValue(block, 'LOCATION') ?? null, end: icalDate(icalValue(block, 'DTEND')) },
      dedupeKey: `calendar:${uid}`,
    };
  });
}

export function parseVcard(text: string): PersonalDocumentInput[] {
  const lines = unfoldLines(text);
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VCARD') current = [];
    else if (line === 'END:VCARD' && current) { blocks.push(current); current = null; }
    else if (current) current.push(line);
  }
  return blocks.map((block, index) => {
    const value = (key: string) => block.find((l) => l.toUpperCase().startsWith(`${key}:`) || l.toUpperCase().startsWith(`${key};`))?.slice(block.find((l) => l.toUpperCase().startsWith(`${key}:`) || l.toUpperCase().startsWith(`${key};`))!.indexOf(':') + 1).trim();
    const email = value('EMAIL')?.toLowerCase() ?? null;
    const name = value('FN') ?? email ?? `Contact ${index + 1}`;
    return {
      source: 'contacts', kind: 'contact', externalId: value('UID') ?? email,
      participants: email ? [email] : [], title: name,
      text: [email, value('TEL'), value('ORG')].filter(Boolean).join('\n'),
      metadata: { email, phone: value('TEL') ?? null, organization: value('ORG') ?? null },
      dedupeKey: `contacts:${value('UID') ?? email ?? dedupeKeyFor({ source: 'contacts', kind: 'contact', title: name })}`,
    };
  });
}

function jsonAfterAssignment(text: string): unknown {
  const trimmed = text.trim().replace(/^window\.YTD\.[^=]+\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(trimmed);
}

function parseSocialJson(path: string, text: string): PersonalDocumentInput[] {
  let parsed: unknown;
  try { parsed = jsonAfterAssignment(text); } catch { return []; }
  const lower = path.toLowerCase();
  if (lower.includes('tweet')) {
    const rows = Array.isArray(parsed) ? parsed : [];
    return rows.flatMap((entry) => {
      const tweet = (entry as { tweet?: Record<string, unknown> }).tweet ?? entry as Record<string, unknown>;
      if (!tweet || typeof tweet !== 'object') return [];
      const id = String(tweet.id_str ?? tweet.id ?? '');
      return [{
        source: 'x', kind: 'post', externalId: id || null,
        occurredAt: typeof tweet.created_at === 'string' ? tweet.created_at : null,
        participants: typeof tweet.in_reply_to_screen_name === 'string' ? [tweet.in_reply_to_screen_name] : [],
        title: 'Post on X', text: String(tweet.full_text ?? tweet.text ?? ''), metadata: tweet,
        dedupeKey: `x:${id || dedupeKeyFor({ source: 'x', kind: 'post', text: String(tweet.full_text ?? '') })}`,
      } satisfies PersonalDocumentInput];
    });
  }
  const root = parsed as { participants?: Array<{ name?: string }>; messages?: Array<Record<string, unknown>> };
  if (Array.isArray(root?.messages)) {
    const source = lower.includes('instagram') ? 'instagram' : 'facebook';
    const threadParticipants = (root.participants ?? []).map((p) => p.name ?? '').filter(Boolean);
    return root.messages.map((m, index) => ({
      source, kind: 'message', externalId: String(m.id ?? `${m.timestamp_ms ?? 'unknown'}-${index}`),
      occurredAt: typeof m.timestamp_ms === 'number' ? new Date(m.timestamp_ms).toISOString() : null,
      participants: [...threadParticipants, String(m.sender_name ?? '')].filter(Boolean),
      title: `Conversation with ${threadParticipants.join(', ') || 'unknown'}`,
      text: String(m.content ?? ''), metadata: m,
      dedupeKey: `${source}:${String(m.id ?? `${m.timestamp_ms ?? 'unknown'}-${index}`)}`,
    }));
  }
  return [];
}

function metaMessageDocument(
  path: string,
  message: Record<string, unknown>,
  index: number,
  participants: string[] = [],
): PersonalDocumentInput {
  const source = path.toLowerCase().includes('instagram') ? 'instagram' : 'facebook';
  const sender = String(message.sender_name ?? '');
  const externalId = String(message.id ?? `${message.timestamp_ms ?? 'unknown'}-${index}`);
  return {
    source,
    kind: 'message',
    externalId,
    occurredAt: typeof message.timestamp_ms === 'number'
      ? new Date(message.timestamp_ms).toISOString()
      : null,
    participants: [...new Set([...participants, sender].filter(Boolean))],
    title: `Conversation with ${participants.join(', ') || sender || 'unknown'}`,
    text: String(message.content ?? ''),
    metadata: message,
    dedupeKey: `${source}:${externalId}`,
  };
}

function parseEntry(path: string, data: Buffer): PersonalDocumentInput[] {
  const lower = path.toLowerCase();
  const text = data.toString('utf8');
  if (lower.endsWith('.mbox')) return parseMbox(text);
  if (lower.endsWith('.ics')) return parseIcs(text);
  if (lower.endsWith('.vcf')) return parseVcard(text);
  if (lower.endsWith('.json') || lower.endsWith('.js')) return parseSocialJson(path, text);
  return [];
}

export function parsePersonalArchive(filename: string, bytes: Buffer): ParsedPersonalArchive {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('personal_archive_too_large');
  const warnings: string[] = [];
  let documents: PersonalDocumentInput[] = [];
  if (filename.toLowerCase().endsWith('.zip')) {
    const zip = new AdmZip(bytes);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('personal_archive_too_many_entries');
    const total = entries.reduce((n, e) => n + Number(e.header.size), 0);
    if (total > MAX_ARCHIVE_BYTES) throw new Error('personal_archive_uncompressed_too_large');
    for (const entry of entries) {
      try { documents.push(...parseEntry(entry.entryName, entry.getData())); }
      catch (err) { warnings.push(`${entry.entryName}: ${(err as Error).message}`); }
    }
  } else {
    documents = parseEntry(filename, bytes);
  }
  documents = documents.map((d) => ({ ...d, source: normalizePersonalSource(d.source), dedupeKey: dedupeKeyFor(d) }));
  if (!documents.length) warnings.push('No supported Gmail/Calendar/Contacts, Facebook/Instagram, or X records were found.');
  return { documents, sources: [...new Set(documents.map((d) => d.source))].sort(), warnings };
}

export interface PersonalArchiveCheckpoint {
  entryIndex: number;
  recordIndex: number;
}

export interface StreamedPersonalArchiveRecord {
  document?: PersonalDocumentInput;
  warning?: string;
  /** Position of the next record. Persisting this after a batch makes replay safe. */
  checkpoint: PersonalArchiveCheckpoint;
  /** Monotonic, conservative progress; document counts remain the precise progress signal. */
  bytesProcessed: number;
}

function supportedEntry(path: string): boolean {
  return /\.(?:mbox|ics|vcf|json|js)$/i.test(path);
}

async function readableBuffer(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > limit) throw new Error('personal_archive_entry_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parsedAddressValues(value: unknown): string[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  return groups.flatMap((group) => {
    const entries = (group as { value?: Array<{ address?: string; name?: string }> }).value ?? [];
    return entries
      .map((entry) => normalizeParticipant(entry.address ?? entry.name ?? ''))
      .filter(Boolean);
  });
}

async function parseMimeMboxMessage(raw: Buffer, index: number): Promise<PersonalDocumentInput> {
  const firstLf = raw.indexOf(0x0a);
  const message = raw.subarray(
    raw.subarray(0, Math.max(0, firstLf)).toString('utf8').startsWith('From ')
      ? firstLf + 1
      : 0,
  );
  const parsed = await simpleParser(message, { skipHtmlToText: false, skipTextToHtml: true });
  const externalId = parsed.messageId?.replace(/[<>]/g, '') ?? null;
  const participants = [
    ...parsedAddressValues(parsed.from),
    ...parsedAddressValues(parsed.to),
    ...parsedAddressValues(parsed.cc),
  ];
  const document: PersonalDocumentInput = {
    source: 'gmail',
    kind: 'message',
    externalId,
    occurredAt: parsed.date?.toISOString() ?? null,
    participants: [...new Set(participants)],
    title: parsed.subject ?? '(no subject)',
    text: parsed.text ?? (typeof parsed.html === 'string' ? parsed.html : ''),
    metadata: {
      from: parsed.from?.text ?? null,
      to: Array.isArray(parsed.to) ? parsed.to.map((value) => value.text) : parsed.to?.text ?? null,
      cc: Array.isArray(parsed.cc) ? parsed.cc.map((value) => value.text) : parsed.cc?.text ?? null,
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename ?? null,
        contentType: attachment.contentType,
        size: attachment.size,
      })),
    },
  };
  document.dedupeKey = externalId
    ? `gmail:${externalId}`
    : `gmail:mbox:${index}:${dedupeKeyFor(document)}`;
  return document;
}

/**
 * Split an mbox stream without retaining the archive. Memory is bounded to one
 * message and mailparser supplies RFC/MIME transfer-decoding for the job path.
 */
async function* streamMboxMessages(stream: Readable): AsyncGenerator<Buffer> {
  const boundary = Buffer.from('\nFrom ');
  let pending = Buffer.alloc(0);
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let boundaryAt = pending.indexOf(boundary);
    while (boundaryAt >= 0) {
      const message = pending.subarray(0, boundaryAt);
      if (message.length > MAX_MBOX_MESSAGE_BYTES) throw new Error('personal_mbox_message_too_large');
      if (message.length) yield message;
      pending = pending.subarray(boundaryAt + 1);
      boundaryAt = pending.indexOf(boundary);
    }
    if (pending.length > MAX_MBOX_MESSAGE_BYTES) throw new Error('personal_mbox_message_too_large');
  }
  if (pending.length) yield pending;
}

/** Meta message exports can contain millions of records; assemble one message object at a time. */
async function* streamMetaMessages(
  path: string,
  stream: Readable,
): AsyncGenerator<PersonalDocumentInput> {
  const pipeline = chain([
    stream,
    parser(),
    pick({ filter: 'messages' }),
    streamArray(),
  ]);
  for await (const item of pipeline) {
    const { key, value } = item as { key: number; value: unknown };
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    yield metaMessageDocument(path, value as Record<string, unknown>, key);
  }
}

async function* streamOneEntry(
  path: string,
  stream: Readable,
  entryIndex: number,
  skipRecords: number,
  bytesBefore: number,
  entryBytes: number,
): AsyncGenerator<StreamedPersonalArchiveRecord> {
  if (path.toLowerCase().endsWith('.mbox')) {
    let recordIndex = 0;
    for await (const raw of streamMboxMessages(stream)) {
      if (recordIndex >= skipRecords) {
        try {
          const document = await parseMimeMboxMessage(raw, recordIndex);
          yield {
            document,
            checkpoint: { entryIndex, recordIndex: recordIndex + 1 },
            bytesProcessed: bytesBefore,
          };
        } catch (error) {
          yield {
            warning: `${path} message ${recordIndex + 1}: ${(error as Error).message}`,
            checkpoint: { entryIndex, recordIndex: recordIndex + 1 },
            bytesProcessed: bytesBefore,
          };
        }
      }
      recordIndex += 1;
    }
    return;
  }

  const lower = path.toLowerCase();
  if (lower.endsWith('.json') && /(?:facebook|instagram|messages?\/|inbox\/)/i.test(lower)) {
    let recordIndex = 0;
    for await (const document of streamMetaMessages(path, stream)) {
      if (recordIndex >= skipRecords) {
        yield {
          document,
          checkpoint: { entryIndex, recordIndex: recordIndex + 1 },
          bytesProcessed: bytesBefore + entryBytes,
        };
      }
      recordIndex += 1;
    }
    if (recordIndex === 0) {
      yield {
        warning: `${path}: unsupported Meta JSON shape (expected a messages array)`,
        checkpoint: { entryIndex: entryIndex + 1, recordIndex: 0 },
        bytesProcessed: bytesBefore + entryBytes,
      };
    }
    return;
  }

  const data = await readableBuffer(stream, Math.min(MAX_STREAMED_ENTRY_BYTES, entryBytes || MAX_STREAMED_ENTRY_BYTES));
  const documents = parseEntry(path, data);
  for (let recordIndex = skipRecords; recordIndex < documents.length; recordIndex += 1) {
    yield {
      document: documents[recordIndex],
      checkpoint: { entryIndex, recordIndex: recordIndex + 1 },
      bytesProcessed: bytesBefore + entryBytes,
    };
  }
}

/**
 * Stream a durable on-disk archive. ZIP entries are opened lazily and mbox is
 * decoded one message at a time. A crash can replay from the persisted
 * entry/record checkpoint; document upserts remain the final idempotency rail.
 */
export async function* streamPersonalArchiveFile(
  workspaceId: string,
  filename: string,
  filePath: string,
  checkpoint: Partial<PersonalArchiveCheckpoint> = {},
): AsyncGenerator<StreamedPersonalArchiveRecord> {
  const initial: PersonalArchiveCheckpoint = {
    entryIndex: Math.max(0, Math.floor(checkpoint.entryIndex ?? 0)),
    recordIndex: Math.max(0, Math.floor(checkpoint.recordIndex ?? 0)),
  };
  const archive = await openEncryptedPersonalArchive(workspaceId, filePath);
  const archiveBytes = archive.metadata.plaintextBytes;
  if (archiveBytes > MAX_STREAMED_ARCHIVE_BYTES) throw new Error('personal_archive_too_large');

  if (!filename.toLowerCase().endsWith('.zip')) {
    if (!supportedEntry(filename)) {
      yield {
        warning: `${filename}: unsupported archive entry`,
        checkpoint: { entryIndex: 1, recordIndex: 0 },
        bytesProcessed: archiveBytes,
      };
      return;
    }
    yield* streamOneEntry(
      filename,
      archive.createReadStream(),
      0,
      initial.entryIndex === 0 ? initial.recordIndex : Number.MAX_SAFE_INTEGER,
      0,
      archiveBytes,
    );
    return;
  }

  class EncryptedArchiveReader extends yauzl.RandomAccessReader {
    _readStreamForRange(start: number, end: number): Readable {
      return archive.createReadStream(start, end);
    }
  }
  const zip = await yauzl.fromRandomAccessReaderPromise(
    new EncryptedArchiveReader(),
    archiveBytes,
    { lazyEntries: true, validateEntrySizes: true },
  );
  let entryIndex = 0;
  let uncompressed = 0;
  try {
    if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error('personal_archive_too_many_entries');
    for await (const entry of zip.eachEntry()) {
      const current = entryIndex++;
      if (/\/$/.test(entry.fileName)) continue;
      uncompressed += entry.uncompressedSize;
      if (uncompressed > MAX_STREAMED_UNCOMPRESSED_BYTES) {
        throw new Error('personal_archive_uncompressed_too_large');
      }
      if (entry.uncompressedSize > MAX_STREAMED_ENTRY_BYTES) {
        yield {
          warning: `${entry.fileName}: personal_archive_entry_too_large`,
          checkpoint: { entryIndex: current + 1, recordIndex: 0 },
          bytesProcessed: uncompressed,
        };
        continue;
      }
      if (current < initial.entryIndex || !supportedEntry(entry.fileName)) continue;
      const skipRecords = current === initial.entryIndex ? initial.recordIndex : 0;
      try {
        const stream = await zip.openReadStreamPromise(entry);
        yield* streamOneEntry(
          entry.fileName,
          stream,
          current,
          skipRecords,
          uncompressed - entry.uncompressedSize,
          entry.uncompressedSize,
        );
      } catch (error) {
        yield {
          warning: `${entry.fileName}: ${(error as Error).message}`,
          checkpoint: { entryIndex: current + 1, recordIndex: 0 },
          bytesProcessed: uncompressed,
        };
      }
    }
  } finally {
    zip.close();
  }
}
