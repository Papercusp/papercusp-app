/**
 * Hidden-delegate reads of the Personal Vault (plan
 * personal-data-reader-set-labels-2026-10-01, P-007 / BAR R-12, D-007).
 *
 * A caller asks a question; a DELEGATE answers it from the matching personal
 * documents. The delegate is a bare model call with no tools, so it cannot send
 * anything anywhere — what it learns can leave only through its answer. The
 * answer is therefore the one thing judged:
 *
 *   - no restricted document was consulted, or the answer is TYPED → delivered,
 *     and the caller's disclosure ledger is NOT touched;
 *   - otherwise it is presumed to carry EVERY restricted document consulted →
 *     WITHHELD by default; with `acceptLabel` it is delivered and every
 *     restricted document consulted is recorded on the caller through
 *     `discloseDocuments`, the same delivery-time rule personal:search applies,
 *     so the caller's later sends are bound by those documents' reader sets
 *     (R-1). A caller with no attributable identity cannot carry a label
 *     (D-004), so its answer is withheld either way.
 *
 * WHY BY FORM, NOT BY WORDS (WI-10005608, D-010). Whether free text carries a
 * document's content cannot be decided lexically: a paraphrase shares no word
 * run and no field value with its source, and an earlier shingle classifier
 * passed exactly that. A typed answer CAN be decided — `isTypedDelegateAnswer`:
 * every word is yes/no/unknown/none, a word of the caller's own question, or at
 * most one whole number that appears nowhere in what the delegate was shown of a
 * restricted document (so a code, phone fragment or date copied from one is not
 * a "count"). Such an answer reveals at most a bit, a count, or a choice among
 * options the caller itself named — never document text or fields.
 *
 * Labelling and the ledger write happen in ONE transaction, after the model
 * call: the delegate's answer can take longer than Postgres's
 * idle_in_transaction_session_timeout, so no transaction is held across it.
 */
import type postgres from 'postgres';
import { discloseDocuments, loadPrivacyRules } from './disclosure-ledger';
import {
  documentSender,
  labelDocument,
  readerSetFor,
  type DocumentLabel,
  type LabelableDocument,
} from './disclosure-labels';

type Db = postgres.Sql | postgres.TransactionSql;

/** Words a typed answer may use beyond the caller's own question words and one number. */
export const DELEGATE_TYPED_WORDS: ReadonlySet<string> = new Set(['yes', 'no', 'unknown', 'none']);
/** A count: a whole number of at most this many digits. */
export const DELEGATE_MAX_COUNT_DIGITS = 4;
/** The ledger's `delivered_via` for a delegated read. */
export const DELEGATED_READ_VIA = 'personal:ask';

export interface DelegateSourceDocument extends LabelableDocument {
  title: string;
  snippet: string;
  kind?: string | null;
  occurredAt?: string | null;
}

/** Produces the delegate's answer. Production: a tool-less model call (personal:ask). */
export type DelegateAnswerer = (input: { question: string; documents: string }) => Promise<string>;

export interface DelegatedReadParams {
  workspaceId: string;
  userId: string;
  /** The caller's disclosure identity (`disclosureSubject(ctx)`); null = unattributable. */
  callerOwnerId: string | null;
  question: string;
  documents: readonly DelegateSourceDocument[];
  /** Take on the label of any restricted document the answer carries, rather than have it withheld. */
  acceptLabel: boolean;
}

export type DelegatedReadResult =
  | {
      delivered: true;
      answer: string | null;
      labelled: false;
      consulted: number;
    }
  | {
      delivered: true;
      answer: string;
      labelled: true;
      consulted: number;
      /** The restricted documents the answer carries, now on the caller's ledger. */
      labels: Array<{ documentId: string; source: string; privacy: DocumentLabel }>;
    }
  | {
      delivered: false;
      reason: 'delegate_answer_carries_restricted' | 'disclosure_identity_unresolved';
      consulted: number;
      /** How many restricted documents the withheld (untyped) answer is presumed to carry. */
      carriedRestricted: number;
    };

export interface DelegatedReadDeps {
  answer: DelegateAnswerer;
  /** Runs `fn` in one workspace-scoped transaction (labelling + ledger write). */
  inWorkspaceTx: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
}

// ── lexical primitives ────────────────────────────────────────────────────

export function delegateWords(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * The normalized addresses the delegate is shown for a document: its sender
 * and participants, exactly as a `participants` reader set would list them
 * (display names stripped, so the delegate never sees a name the classifier
 * does not check).
 */
function addressesOf(doc: DelegateSourceDocument): string[] {
  return readerSetFor(doc, 'participants').map((a) => a.trim().toLowerCase());
}

/** Every word the delegate is shown for one document: header, addresses, title and text. */
function shownWords(doc: DelegateSourceDocument): string[] {
  return [doc.source, doc.kind ?? '', doc.occurredAt ?? '', ...addressesOf(doc), doc.title ?? '', doc.snippet ?? ''].flatMap(delegateWords);
}

// ── what the delegate sees ────────────────────────────────────────────────

/**
 * The document block handed to the delegate. Only these fields reach it, and
 * `isTypedDelegateAnswer` refuses a number taken from any of them.
 */
export function renderDelegateDocuments(documents: readonly DelegateSourceDocument[]): string {
  return documents
    .map((doc, i) => {
      const sender = documentSender(doc)?.trim().toLowerCase() ?? null;
      const others = addressesOf(doc).filter((a) => a !== sender);
      const lines = [
        `[${i + 1}] ${doc.source}${doc.kind ? `/${doc.kind}` : ''}${doc.occurredAt ? ` · ${doc.occurredAt}` : ''}`,
        sender ? `from: ${sender}` : null,
        others.length ? `participants: ${others.join(', ')}` : null,
        doc.title ? `title: ${doc.title}` : null,
        doc.snippet ? `text: ${doc.snippet}` : null,
      ];
      return lines.filter(Boolean).join('\n');
    })
    .join('\n\n');
}

export const DELEGATE_SYSTEM_PROMPT = [
  'You answer one question for another agent from the owner\'s personal documents listed below.',
  'When the question can be answered with yes, no or a number, reply with ONLY that word or number; reply ONLY "unknown" when the documents do not answer it.',
  'Only an answer in that form reaches the asker freely: any other answer drawn from a private document is withheld from it.',
  'Otherwise answer in at most three sentences, without quoting document text or naming anyone the question does not already name.',
].join(' ');

// ── classification ────────────────────────────────────────────────────────

/**
 * True when `answer` is TYPED (see the module header): every word is one of
 * {@link DELEGATE_TYPED_WORDS}, a word of the caller's own `question`, or a
 * single whole number of at most {@link DELEGATE_MAX_COUNT_DIGITS} digits that
 * appears in none of the `restricted` documents as the delegate was shown them.
 * An empty answer is typed. PURE.
 */
export function isTypedDelegateAnswer(input: {
  answer: string;
  question: string;
  restricted: readonly DelegateSourceDocument[];
}): boolean {
  const asked = new Set(delegateWords(input.question));
  const restrictedWords = new Set(input.restricted.flatMap(shownWords));
  const count = new RegExp(`^\\d{1,${DELEGATE_MAX_COUNT_DIGITS}}$`);
  let numbers = 0;
  for (const word of delegateWords(input.answer)) {
    if (asked.has(word) || DELEGATE_TYPED_WORDS.has(word)) continue;
    if (count.test(word) && !restrictedWords.has(word) && numbers === 0) {
      numbers += 1;
      continue;
    }
    return false;
  }
  return true;
}

// ── delivery ──────────────────────────────────────────────────────────────

/**
 * Ask the delegate, then decide what reaches the caller. The model call runs
 * outside any transaction; labelling, classification and the ledger write run
 * together in one, so the labels the delivery is judged by are the labels the
 * ledger records.
 */
export async function delegatedRead(params: DelegatedReadParams, deps: DelegatedReadDeps): Promise<DelegatedReadResult> {
  const consulted = params.documents.length;
  if (!consulted) return { delivered: true, answer: null, labelled: false, consulted };

  const answer = (await deps.answer({ question: params.question, documents: renderDelegateDocuments(params.documents) })).trim();

  return deps.inWorkspaceTx(async (tx) => {
    const rules = await loadPrivacyRules(tx, params.workspaceId, params.userId);
    const labelled = params.documents.map((doc) => ({ doc, privacy: rules.length ? labelDocument(doc, rules) : null }));
    const restricted = labelled.filter((entry) => entry.privacy !== null);
    if (!restricted.length) return { delivered: true, answer, labelled: false, consulted } as const;

    // An untyped answer is presumed to carry EVERY restricted document consulted:
    // which ones a paraphrase draws on cannot be attributed, so none is exempted.
    const carriedDocs = restricted.map((entry) => entry.doc);
    if (isTypedDelegateAnswer({ answer, question: params.question, restricted: carriedDocs })) {
      return { delivered: true, answer, labelled: false, consulted } as const;
    }
    if (!params.acceptLabel) {
      return { delivered: false, reason: 'delegate_answer_carries_restricted', consulted, carriedRestricted: carriedDocs.length } as const;
    }

    const disclosed = await discloseDocuments(tx, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      agentOwnerId: params.callerOwnerId,
      documents: carriedDocs,
      via: DELEGATED_READ_VIA,
    });
    if (disclosed.withheld > 0) {
      return { delivered: false, reason: 'disclosure_identity_unresolved', consulted, carriedRestricted: carriedDocs.length } as const;
    }
    return {
      delivered: true,
      answer,
      labelled: true,
      consulted,
      labels: disclosed.documents
        .filter((doc): doc is typeof doc & { privacy: DocumentLabel } => doc.privacy !== null)
        .map((doc) => ({ documentId: doc.id, source: doc.source, privacy: doc.privacy })),
    } as const;
  });
}
