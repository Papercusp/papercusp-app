# @papercusp/hash-chain

Tamper-evident, append-only hash chains. Pure (only `node:crypto`) and storage-agnostic:
you keep entries and links wherever you like and hand the verifier the records in order.

## Model

A **stream** is an ordered sequence of entries. Each entry gets a **link**:

| field         | meaning                                                                 |
|---------------|-------------------------------------------------------------------------|
| `seq`         | 0-based, gap-free position                                              |
| `prevHash`    | the previous link's `entryHash` (all-zero genesis for `seq` 0)          |
| `entryDigest` | SHA-256 of the entry's canonical JSON (domain-separated)                |
| `entryHash`   | commits to stream id, `seq`, `prevHash` and `entryDigest`               |

Editing, deleting, inserting or reordering an entry or link breaks the chain at that point,
and `verifyChain` reports the **first** break with a reason (`entry-mismatch`,
`entry-missing`, `seq-gap`, `prev-mismatch`, `link-hash-mismatch`, `stream-mismatch`,
`malformed`, `head-mismatch`). A chain alone cannot see a truncated tail; pass a head you
published elsewhere (an anchor, an earlier export) as `expectedHead`.

## API

```ts
import { appendLinks, entryDigest, verifyChain, exportChain, parseChainExport, verifyChainExport } from '@papercusp/hash-chain';

const links = appendLinks('my.stream', head, entries.map(entryDigest));
const verdict = verifyChain('my.stream', records, { requireEntries: true, expectedHead });
const jsonl = exportChain('my.stream', records);   // byte-stable
verifyChainExport(jsonl, { expectedHead });         // offline check
```

## Export format

Canonical JSON Lines: a header line (`format`, `version`, `streamId`, `length`, `head`,
`genesis`) followed by one `{ entry, link }` record per position (`{ entryMissing: true,
link }` when the store lost the entry). Exporting the same chain twice gives identical
bytes, and `exportChain(parseChainExport(text))` reproduces `text` exactly. The parser
refuses non-canonical lines.

## Offline verifier

```sh
npx tsx libs/generic/hash-chain/src/verify-main.ts verify chain.jsonl [--head-seq N --head-hash H]
```

Prints the verdict as one JSON line; exits 0 intact, 1 broken, 2 usage error.

## Users in this repo

- Cupboard D1 commerce + treasury ledgers: `apps/operator-public/src/ledger-chain-store.ts`
  (operator routes `/admin/ledger-chain/*`).
- Postgres plan-admission governance ledgers: `packages/operator-core/lib/cupboard/ledger-chain.ts`
  (tools `cupboard:ledger-chain`, `cupboard:ledger-chain-witness`).

Chain an append-only record log, never a mutable (upsert) table: a legitimate update would
read as tampering.
