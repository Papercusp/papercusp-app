# Inno Verification metadata is not a GOG multipart checksum
URL: /internal/docs/agent-insights/inno-verification-metadata-is-not-a-multipart-checksum

A listing-compatible innoextract can emit a read-back warning for every ordinary file: Inno 6.5+ Verification metadata was loaded into the unrelated GOG output-checksum field. Preserve the final audit refusal and fix the consumer; prove extraction and corruption rejection before compiling a release.

## Signature and cause

The pinned upstream innoextract commit `376a13e7c41cc5528b6088d0dd16ec1b323a8d37` lists an Inno 6.7 fixture successfully, then emits `Could not read back ... to calculate output checksum for multi-part file` on ordinary files. On September 7, 2026, the preserved 0.0.19 GUI installer reproduced this with exit 0, 2,718 extracted files and 2,718 warnings. A warning saying multi-part is therefore NOT proof that the Server disk slices are corrupt or missing.

`src/setup/file.cpp` loads the always-present Inno 6.5+ Verification record's digest into `file_entry::checksum` and leaves it SHA256 even when Verification is None. That field belongs to GOG multipart output, paired with `file_entry::size`, which stays zero for ordinary Inno entries. `cli/extract.cpp:file_output` consequently requests an impossible output checksum/read-back. The archive payload checksum is a DIFFERENT field, `data_entry::file.checksum`, parsed in `src/setup/data.cpp` and verified during extraction.

The maintained patch separates the Verification metadata into `verification_checksum` and restores initialization of the GOG-only output checksum. It does not change the data-entry checksum reader, extraction comparison, GOG multipart assembly, or the release auditor's warning refusal. The altered source is explicitly identified by the installed manifest.

## Recovery procedure

1. Preserve the original installer set, including every Server slice. Record hashes and exact extractor argv. A failed release producer is terminal; do not relaunch all platform builds to conceal an inspector failure.
2. Build the corrected consumer from canonical staging: `bash papercusp-desktop/bin/build-innoextract.sh`. The optional first argument is a local upstream checkout containing the exact pinned commit; the optional second is a NEW install prefix. The builder exports that immutable commit into a generated build directory and applies the maintained patch with zero fuzz. It never edits the installed upstream checkout, the frozen release tree, or an existing consumer.
3. The build must pass the existing compatibility preflight before installation. Its manifest records upstream commit, patch SHA256, binary SHA256, and that the source was modified. The last stdout line names the installed executable. Build diagnostics are not proof that preflight passed; require successful exit and manifest.
4. Pass the installed executable explicitly as `PAPERCUSP_INNOEXTRACT` to the CURRENT auditor's `--scan-artifact` on the PRESERVED setup.exe files. The Server stub resolves its sibling slices. Require audit success AND unchanged input hashes before resuming signing, provenance emission, and span normalization.
5. Keep identity-audit scope, updater signatures, OS signing, and installation/runtime verification separate. Passing an extraction fixture does not establish any of those final-artifact properties. A name-only identity scan does not establish full owner-email coverage.

## Recurrence guards

The existing compatibility helper no longer accepts listing alone. It compiles a tiny fixture with the exact release ISCC, lists its payload, invokes the same `_expand_installer` function as the final audit, checks byte equality, and flips one stored payload byte to prove checksum verification rejects corruption. Each candidate has its own clean extraction directory. An explicit override is authoritative and cannot fall back to another consumer. The final auditor uses `-e -t -s`: extract, make checksum failure fatal, silence listings but not warnings.

Node regression tests cover warning-with-exit-zero, incorrect extracted bytes, ignored corruption, explicit consumer selection, and preserved final-audit refusal. A hunk-length test prevents a malformed maintained patch reaching the build. Real controls on September 7 rejected the old consumer and accepted the corrected consumer, including refusal of the corrupted fixture. Evidence and exact-finished-byte acceptance are recorded on EI-22612317284763819; do not infer release acceptance from this runbook.
