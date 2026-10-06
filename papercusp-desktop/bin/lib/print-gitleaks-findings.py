#!/usr/bin/env python3
"""Print safe gitleaks finding locators without printing matched values.

Gitleaks reports are written with --redact=100. This formatter deliberately
does not deserialize or print Match/Secret, so a release refusal can carry the
rule, file, line range, and rule description without putting the finding value
in the release log.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.util
import contextlib
import fnmatch
import hashlib
import html
import importlib.util
import io
import json
import mmap
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tarfile
from collections import Counter
from pathlib import Path

MAX_LOCATORS = 50

_SEED_FIELDS = re.compile(rb'"(?P<field>__rekey|hbKey|writer_key)":"(?P<value>[^"\\]*)"')
_MATCH_FIELD = re.compile(r'^"?([A-Za-z_][A-Za-z_0-9]*)"\s*:')
_MESSAGE_ID = re.compile(rb'[a-z0-9]{8}-[0-9]{4}-[0-9a-f]{32}')
_UUID = re.compile(rb'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}')
_PROOF_SCHEMA = "papercusp-seed-finding-proof-v1"
_SEED_CLASSES = {
    "authenticated-ciphertext-with-classified-plaintext", "public-agent-or-session-id",
    "public-coord-or-issue-id", "public-sender-verified-in-decrypted-source",
    "public-announced-event-reference",
}
_PLAIN_CLASSES = {
    "public-coord-sender-identifier", "descriptive-doc-part-category-list",
    "deliberately-invalid-localhost-auth-probe", "documented-minified-source-expression",
    "public-hypercore-log-key", "public-standing-fact-reference",
    "scanner-truncated-public-coord-sender",
}
_MECHANICAL_SEED_CLASSES = {"public-projection-row-key", "public-hypercore-log-key",
                            "recipient-sealed-epoch-key-envelope"}
_MECHANICAL_PLAIN_CLASSES = {
    "public-git-object-reference", "public-hash-or-log-reference",
    "public-condition-reference", "public-opaque-operation-reference",
    "public-schema-bound-reference", "reviewed-public-source-literal",
    "public-cryptographic-key", "reviewed-descriptive-source-text",
    "public-generated-agent-identifier",
    "public-non-bearer-field-reference",
    "public-quoted-issue-reference",
}
_SEED_CLASSES |= _MECHANICAL_SEED_CLASSES
_PLAIN_CLASSES |= _MECHANICAL_PLAIN_CLASSES
_CREDENTIAL_FIELD = re.compile(r"token|secret|key|auth|password", re.IGNORECASE)
_ID_FIELDS = {"id", "issue_id", "msg_id", "condition_id", "operation_id", "request_id",
              "receipt_id", "event_id", "rubric_id", "rule_id", "task_id", "ref"}
_FROZEN_TREES = {"superproject": "d740fc3802877d1c8c3b1068768681ee32ef0025",
                 "desktop": "c864f7a1d1b62721a21dc8b0a576d51ff4edb345"}
_RESPAWN_MAKERS = {
    "packages/operator-core/lib/agent-tools/fleet_registry/respawn-member.ts":
        ("6662117f86f55049c335e7cf9f9c89882aaca298", {"hex16", "uuid4"}),
    "packages/operator-core/lib/fleet/member-recovery.ts":
        ("6d22fc28a9124ce58c5312d058c47813a3b0080c", {"hex16"}),
}
_RESPAWN_FIELDS = {"writer_key", "sender", "sender_id"}
_PUBLIC_ISSUE_MAKER = {
    "tree": "superproject", "path": "packages/operator-core/lib/issues-engineer.ts",
    "blob": "ab53e49b9bf43f6e1c2589302f8acb1fed891b8e",
}
_NON_BEARER_FIELDS = {"idempotencyKey", "conditionKey", "watchdogKey", "credentialSha256"}
_CREDENTIAL_DIGEST_VERIFIER = {
    "tree": "superproject",
    "path": "packages/operator-core/lib/work-item-admission-authority.ts",
    "blob": "f64c9f76696d7b28659345cad4441ec80675dad8",
}
_RUNTIME_SOURCE_PATHS = (
    "*.ts", "*.tsx", "*.js", "*.mjs", "*.cjs", "*.py", "*.rs",
    ":!*.test.*", ":!*.spec.*", ":!*/__tests__/*", ":!*/test/*", ":!*/tests/*",
)
_PROOF_FILES = (
    "ciphertext-auth-safe.json", "plaintext-classification-safe.json",
    "plaintext-exact-finding-digests.json", "seed-classification-verified-safe.json",
    "seed-exact-finding-digests.json", "seed-000080.plaintext.private.meta.json",
    "seed-000080.plaintext.private.json", "seed-000080.plaintext.jsonl",
    "seed-000080.private.meta.json", "seed-000080.private.json",
    "forbidden-literals.private.json",
)
_BASE_PROOF_FILES = _PROOF_FILES
_PROOF_FILES += ("mechanical-class-proof.private.json", "sealed-envelope-proof-safe.json",
                 "identity-secret-scan-safe.json")

# D-148: scanner findings alone missed a credential inside an issue body.
# The literal remains private; only its identity is part of the release contract.
_REQUIRED_FORBIDDEN_DIGESTS = {
    "4e77512c313a47d2e6f84c040beb7bf4ace649adc83be6bbd7ec26ff3a3fe912",
}


def verify_literal_absence(inputs: list[Path], literals: list[dict[str, str]],
                          required: set[str]) -> dict[str, object]:
    """Check actual bytes independently of scanner rules or finding digests."""
    if not inputs or not literals:
        raise ValueError("complete literal guard inputs required")
    values = []
    for entry in literals:
        value = entry.get("literal")
        if (not isinstance(value, str) or not value
                or hashlib.sha256(value.encode()).hexdigest() != entry.get("sha256")):
            raise ValueError("forbidden literal identity mismatch")
        values.append(value.encode())
    identities = {entry["sha256"] for entry in literals}
    if not required.issubset(identities):
        raise ValueError("required literal guard missing")
    inventory = []
    overlap = max(map(len, values)) - 1
    for path in inputs:
        if path.is_symlink() or not path.is_file():
            raise ValueError("invalid literal guard input")
        before = _sha256(path)
        previous = b""
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                if any(value in previous + chunk for value in values):
                    raise ValueError("forbidden literal remains")
                previous = chunk[-overlap:] if overlap else b""
        if _sha256(path) != before:
            raise ValueError("literal guard input changed")
        inventory.append({"path": str(path), "sha256": before})
    return {"schema": "papercusp-known-literal-absence-v1", "inputs": inventory,
            "literalDigests": sorted(identities), "rawLiteralHits": 0}


def _public_id(value: str) -> bool:
    raw = value.encode()
    return bool(_UUID.fullmatch(raw) or _MESSAGE_ID.fullmatch(raw)
                or (value.startswith("su-") and _UUID.fullmatch(raw[3:]))
                or re.fullmatch(r"(?:[a-z][a-z0-9-]*/)?(?:WI|EI|F|P)-[0-9]+", value)
                or re.fullmatch(r"0mu[a-z0-9]{16}", value))


def _canonical_base64(value: str, size: int) -> bytes:
    decoded = base64.b64decode(value, validate=True)
    if len(decoded) != size or base64.b64encode(decoded).decode() != value:
        raise ValueError("invalid public value encoding")
    return decoded


def _at_path(value: object, path: list[object]) -> object:
    if not isinstance(path, list) or not path:
        raise ValueError("exact field locator required")
    for part in path:
        if isinstance(value, dict) and isinstance(part, str):
            value = value[part]
        elif isinstance(value, list) and type(part) is int and 0 <= part < len(value):
            value = value[part]
        else:
            raise ValueError("invalid field locator")
    return value


def _embedded_reference(value: object, pointer: object) -> tuple[object, str]:
    """D-150 V4: exactly one JSON parse and an exact RFC 6901 pointer."""
    if (not isinstance(value, str) or not isinstance(pointer, str)
            or not pointer.startswith("/") or re.search(r"~(?![01])", pointer)):
        raise ValueError("typed embedded JSON locator required")
    value = json.loads(value)
    parts = [part.replace("~1", "/").replace("~0", "~")
             for part in pointer[1:].split("/")]
    for part in parts:
        if isinstance(value, dict):
            value = value[part]
        elif (isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", part)
              and int(part) < len(value)):
            value = value[int(part)]
        else:
            # A nested JSON string is not parsed a second time.
            raise ValueError("invalid embedded JSON pointer")
    return value, parts[-1]


def _manifest_publics(manifest: dict[str, object]) -> set[bytes]:
    result = set()
    for store in manifest.get("stores", []):
        meta = store.get("meta", {})
        values = list(meta.get("coreKeys", [])) + list(meta.get("coreLengths", {}))
        values += list(meta.get("coreProjectedFrom", {})) + list(meta.get("coreProjectedFrom", {}).values())
        for name in ("coreKey", "discoveryKey", "writerKey"):
            if name in meta:
                values.append(meta[name])
        for value in values:
            if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value):
                result.add(bytes.fromhex(value))
    return result


def _source_tree(ref: dict[str, object], trees: dict[str, object]) -> tuple[Path, str]:
    kind = ref.get("tree")
    tree = trees[kind]
    sha = tree["sha"]
    path = Path(tree["path"])
    if sha != _FROZEN_TREES.get(kind):
        raise ValueError("source tree is not the admitted release source")
    found = subprocess.run(["git", "-C", str(path), "rev-parse", "HEAD"], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
    if found != sha:
        raise ValueError("source tree changed")
    return path, sha


def validate_non_bearer_sources(field: str, witness: dict[str, object],
                                context: dict[str, object]) -> None:
    """D-149: exact frozen reader/writer citations, with a complete source census.

    This checks the citations themselves. Independent GO still reviews their
    meaning; a source witness alone never admits an occurrence.
    """
    if (field not in _NON_BEARER_FIELDS or witness.get("field") != field
            or witness.get("toolingSha256") != _sha256(Path(__file__))
            or witness.get("reviewRef") != "p2p-public-release-endgame-2026-09-01#D-149"):
        raise ValueError("closed non-bearer field source proof required")
    writers, readers = witness.get("writers", []), witness.get("readers", [])
    if not writers or not readers:
        raise ValueError("non-bearer writer and reader proofs required")
    refs = {(ref["tree"], ref["path"], ref["blob"]): ref for ref in [*writers, *readers]}
    cache = context.setdefault("_nonBearerSourceCache", {})
    identity = hashlib.sha256(json.dumps(witness, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    if identity in cache:
        return
    observed = set()
    for tree in _FROZEN_TREES:
        path, sha = _source_tree({"tree": tree}, context["trees"])
        result = subprocess.run(["git", "-C", str(path), "grep", "-l", "-w", "-F", field,
                                 sha, "--", *_RUNTIME_SOURCE_PATHS],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if result.returncode not in (0, 1):
            raise ValueError("non-bearer source census failed")
        for line in result.stdout.decode().splitlines():
            prefix = sha + ":"
            if not line.startswith(prefix):
                raise ValueError("invalid frozen source census")
            relative = line[len(prefix):]
            matching = [key for key in refs if key[:2] == (tree, relative)]
            if len(matching) != 1:
                raise ValueError("non-bearer reader/writer census incomplete")
            observed.add(matching[0])
    if observed != set(refs):
        raise ValueError("non-bearer source census mismatch")
    for ref in refs.values():
        if not re.search(rb"\b" + field.encode() + rb"\b", _frozen_source_bytes(ref, context["trees"])):
            raise ValueError("field absent from cited source")
    if field == "credentialSha256":
        if witness.get("verifier") != _CREDENTIAL_DIGEST_VERIFIER:
            raise ValueError("credential digest verifier mismatch")
        content = _frozen_source_bytes(witness["verifier"], context["trees"])
        if any(snippet not in content for snippet in (
                b"createHash('sha256').update(bytes).digest('hex')",
                b"admissionCredentialDigest(token) !== authority.credentialSha256",
                b"admissionCredentialDigest(decodeOperatorSecretKey(key.value_b64, 'spawn-signing-key')) !== authority.credentialSha256")):
            raise ValueError("credential verifier does not hash the presented credential")
    cache[identity] = list(refs.values())


def non_bearer_reference_valid(field: str, value: str, witness: dict[str, object],
                               context: dict[str, object]) -> bool:
    validate_non_bearer_sources(field, witness, context)
    shape = witness.get("shape")
    if field == "credentialSha256":
        clearance = context.get("credentialDigestScan", {})
        return (shape == "hex64" and re.fullmatch(r"[0-9a-f]{64}", value) is not None
                and context.get("identityScanValidated") is True
                and value in clearance.get("digests", [])
                and clearance.get("digestOfCredentialHits") == 0
                and clearance.get("rawCredentialHits") == 0
                and clearance.get("hashControlDetected") is True
                and clearance.get("rawControlDetected") is True)
    if shape == "uuid":
        return _UUID.fullmatch(value.encode()) is not None and value in context.get("publicIds", set())
    if shape == "projection-id":
        parts = value.split("::", 1)
        return (len(parts) == 2 and re.fullmatch(r"[a-z][a-z0-9-]*", parts[0]) is not None
                and _public_id(parts[1]) and parts[1] in context.get("publicIds", set()))
    if shape in {"hex40", "hex64"}:
        return (re.fullmatch(r"[0-9a-f]{" + shape[3:] + r"}", value) is not None
                and value in context["publicReferences"])
    return False


def mechanical_class_valid(entry: dict[str, object], finding: dict[str, object],
                           context: dict[str, object], *, seed: bool) -> bool:
    """D-147 predicates re-derived from exact private findings and bound inputs."""
    kind = entry["class"]
    value = finding.get("Secret")
    match = finding.get("Match")
    if (entry.get("digest") != finding_digest(finding) or entry.get("rule") != finding.get("RuleID")
            or not isinstance(value, str) or not isinstance(match, str)):
        return False
    if seed:
        fields = context["seedFields"]
        if kind == "public-projection-row-key":
            parts = value.split("::", 1)
            field_match = _MATCH_FIELD.match(match)
            field = field_match.group(1) if field_match else ""
            return (finding["RuleID"] == "generic-api-key" and len(parts) == 2
                    and re.fullmatch(r"[a-z][a-z0-9-]*", parts[0]) is not None
                    and _public_id(parts[1])
                    and field in {"hbKey", "__rekey", "writer_key"} and (field, value) in fields)
        if kind == "public-hypercore-log-key":
            return (re.fullmatch(r"[0-9a-f]{64}", value) is not None
                    and bytes.fromhex(value) in context["publicKeys"])
        if kind == "recipient-sealed-epoch-key-envelope":
            return entry["digest"] in context.get("envelopeDigests", set())
        return False
    if kind == "reviewed-public-source-literal":
        ref = entry["sourceRef"]
        path, sha = _source_tree(ref, context["trees"])
        relative = ref["path"]
        if Path(relative).is_absolute() or ".." in Path(relative).parts:
            return False
        blob = subprocess.run(["git", "-C", str(path), "rev-parse", sha + ":" + relative], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
        if blob != ref["blob"]:
            return False
        content = subprocess.run(["git", "-C", str(path), "cat-file", "blob", blob], check=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout
        return match.encode() in content and value.encode() in content
    if kind == "public-git-object-reference":
        if not re.fullmatch(r"[0-9a-f]{40}", value):
            return False
        path, _ = _source_tree(entry["sourceRef"], context["trees"])
        return subprocess.run(["git", "-C", str(path), "cat-file", "-e", value],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if kind == "public-quoted-issue-reference":
        return quoted_issue_reference_valid(entry, finding, context)
    row = context["plainRows"][int(finding["StartLine"])]
    locator = entry["fieldPath"]
    field = str(locator[-1])
    actual = _at_path(row, locator)
    if "embeddedJsonPointer" in entry:
        if kind not in {"public-hash-or-log-reference", "public-condition-reference",
                        "public-opaque-operation-reference", "public-schema-bound-reference",
                        "public-non-bearer-field-reference"}:
            return False
        actual, field = _embedded_reference(actual, entry["embeddedJsonPointer"])
    if kind == "public-non-bearer-field-reference":
        if (actual != value or field not in _NON_BEARER_FIELDS
                or finding["RuleID"] != "generic-api-key"
                or entry.get("line") != finding["StartLine"]
                or entry.get("rowSha256") != context["plainRowDigests"][int(finding["StartLine"])]):
            return False
        return non_bearer_reference_valid(field, value, context["nonBearerFields"][field], context)
    if kind == "public-cryptographic-key":
        return actual == value and _canonical_base64(value, 32) in context["publicKeys"]
    if kind == "reviewed-descriptive-source-text":
        return (finding["RuleID"] == "generic-api-key" and not _CREDENTIAL_FIELD.search(field)
                and isinstance(actual, str) and match in actual and value in actual
                and not _CREDENTIAL_FIELD.search((_MATCH_FIELD.match(match).group(1)
                                                  if _MATCH_FIELD.match(match) else "")))
    if kind == "public-generated-agent-identifier":
        if (actual != value or field not in _RESPAWN_FIELDS or finding["RuleID"] != "generic-api-key"
                or entry.get("line") != finding["StartLine"]
                or entry.get("rowSha256") != context["plainRowDigests"][int(finding["StartLine"])]):
            return False
        ref = entry["makerRef"]
        expected = _RESPAWN_MAKERS.get(ref.get("path"))
        if (not expected or ref.get("tree") != "superproject" or ref.get("blob") != expected[0]):
            return False
        if re.fullmatch(r"su-respawn-[0-9a-f]{32}", value):
            shape = "hex16"
        elif re.fullmatch(r"su-respawn-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value):
            shape = "uuid4"
        else:
            return False
        if shape not in expected[1]:
            return False
        # Thousands of rows cite the same immutable Git blob. Verify it once
        # within this validation context, then re-check HEAD at the batch end.
        cache = context.setdefault("_makerProofCache", {})
        witness = (ref["tree"], ref["path"], ref["blob"])
        if witness not in cache:
            _frozen_source_bytes(ref, context["trees"])
            cache[witness] = dict(ref)
        check = scan_secret_key_bytes(value.encode(), set(), context["publicKeys"])
        return check["realFindings"] == 0 and check["derivationMatches"] == 0
    if actual != value or _CREDENTIAL_FIELD.search(field):
        return False
    if kind in {"public-condition-reference", "public-opaque-operation-reference",
                "public-schema-bound-reference"}:
        return field in context["idFields"] and field in _ID_FIELDS and _public_id(value)
    if kind == "public-hash-or-log-reference":
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
            return False
        return value in context["publicReferences"]
    return False


def _validate_mechanical_entries(entries: list[dict[str, object]], report: list[dict[str, object]],
                                 context: dict[str, object], *, seed: bool) -> None:
    added = _MECHANICAL_SEED_CLASSES if seed else _MECHANICAL_PLAIN_CLASSES
    by_digest = {finding_digest(finding): finding for finding in report}
    by_location = {(finding_digest(finding), finding["StartLine"]): finding for finding in report}
    for entry in entries:
        finding = (by_location[(entry["digest"], entry["line"])]
                   if entry["class"] in {"public-generated-agent-identifier", "public-non-bearer-field-reference",
                                         "public-quoted-issue-reference"}
                   else by_digest[entry["digest"]])
        if entry["class"] in added and not mechanical_class_valid(
                entry, finding, context, seed=seed):
            raise ValueError("mechanical class predicate failed")
    for ref in context.get("_makerProofCache", {}).values():
        _source_tree(ref, context["trees"])
    for refs in context.get("_nonBearerSourceCache", {}).values():
        for ref in refs:
            _source_tree(ref, context["trees"])
    if not seed:
        counts = Counter()
        for entry in entries:
            if entry["class"] == "public-non-bearer-field-reference":
                row = context["plainRows"][int(entry["line"])]
                field = str(entry["fieldPath"][-1])
                if "embeddedJsonPointer" in entry:
                    _, field = _embedded_reference(_at_path(row, entry["fieldPath"]), entry["embeddedJsonPointer"])
                counts[field] += 1
        context["nonBearerCounts"] = {field: counts[field] for field in sorted(_NON_BEARER_FIELDS)}


def _table_ops(source: bytes, table: str) -> list[dict[str, object]]:
    decoder = json.JSONDecoder()
    pattern = rb'\{(?:"type":"put",)?"table":"' + re.escape(table.encode()) + rb'",'
    rows = []
    for found in re.finditer(pattern, source):
        # These are small public metadata rows. Oversized or incomplete rows
        # refuse the proof instead of silently reducing the population.
        text = source[found.start():found.start() + 4 * 1024 * 1024].decode("utf-8", errors="replace")
        row, _ = decoder.raw_decode(text)
        rows.append(row)
    return rows


def validate_envelope_structure(proof: dict[str, object], source: bytes,
                                report: list[dict[str, object]], epochs: set[int]) -> set[str]:
    members = _table_ops(source, "hive-members")
    recipients = {entry["device_pubkey"] for op in members
                  for entry in op["value"].get("device_attestations", [])}
    if len(recipients) != 33:
        raise ValueError("historical recipient population mismatch")
    for value in recipients:
        _canonical_base64(value, 32)
    rows = {op["hbKey"]: op for op in _table_ops(source, "hive-epoch-keys")}
    values = {}
    for op in rows.values():
        value = op["value"]
        if (value["harness_slug"] != "papercusp" or value["epoch"] not in epochs
                or value["member_device_pubkey"] not in recipients
                or op["hbKey"] != str(value["epoch"]) + ":" + value["member_device_pubkey"]):
            raise ValueError("epoch envelope membership mismatch")
        _canonical_base64(value["wrapped_key"], 80)
        values[value["wrapped_key"]] = op
    digests = set()
    count = 0
    for finding in report:
        if "wrapped_key" not in finding["Match"]:
            continue
        if (finding["RuleID"] != "generic-api-key" or finding["Secret"] not in values
                or finding["Match"].encode() not in source):
            raise ValueError("envelope exact finding mismatch")
        count += 1
        digests.add(finding_digest(finding))
    if (count != 62 or len(digests) != 62 or proof.get("count") != count
            or set(proof.get("digests", [])) != digests
            or set(proof.get("recipients", [])) != recipients
            or proof.get("sourceSha256") != hashlib.sha256(source).hexdigest()):
        raise ValueError("envelope count or digest set mismatch")
    return digests


def _read_extra_proof(proof: dict[str, object], directory: Path, name: str) -> object:
    path = directory / name
    _private_file(path)
    if proof.get("evidence", {}).get(name) != _sha256(path):
        raise ValueError("conditional evidence changed")
    return json.loads(path.read_text(encoding="utf-8"))


def validate_quoted_issue_twins(refs: list[dict[str, object]], directory: Path,
                                root: Path, config: Path,
                                parent_proof: dict[str, object],
                                identity_context: dict[str, object] | None = None) -> dict[str, set[str]]:
    """D-160 T1: independently valid same-seed proofs supply complete EI twins.

    Only top-level issue_id values are eligible. A twin's proof cannot depend
    on quoted twins, preventing recursive or circular admission.
    """
    twins: dict[str, set[str]] = {}
    for ref in refs:
        child = _source_file(directory.parent, ref["proofPath"])
        _private_file(child)
        if child.resolve() == (directory / "seed-finding-proof.json").resolve():
            raise ValueError("quoted issue self-twin refused")
        if _sha256(child) != ref.get("proofSha256"):
            raise ValueError("quoted issue twin proof changed")
        proof = json.loads(child.read_text())
        if ("proofs" in proof or proof.get("manifestSha256") != parent_proof["manifestSha256"]
                or proof.get("epochKeysSha256") != parent_proof["epochKeysSha256"]):
            raise ValueError("quoted issue twin is not from the same seed")
        entries = json.loads((child.parent / "plaintext-exact-finding-digests.json").read_text())
        reference = json.loads((child.parent / "mechanical-class-proof.private.json").read_text())
        if (reference.get("quotedIssueTwinProofs")
                or any(entry.get("class") == "public-quoted-issue-reference" for entry in entries)):
            raise ValueError("quoted issue twin proof cannot depend on quoted twins")
        if "occurrenceScope" in proof:
            validate_seed_proof(proof, child.parent, root, config,
                                issue_twin=ref, identity_context=identity_context)
            identity_context.setdefault("quotedIssueTwinResiduals", {})[ref["proofSha256"]] = (
                proof["occurrenceScope"]["remainingPlaintextFindings"])
        else:
            validate_seed_proof(proof, child.parent, root, config)
        plaintext = child.parent / "seed-000080.plaintext.jsonl"
        if _sha256(plaintext) != ref.get("plaintextSha256"):
            raise ValueError("quoted issue twin plaintext changed")
        line_number = ref.get("line")
        if type(line_number) is not int or line_number < 1 or ref.get("fieldPath") != ["issue_id"]:
            raise ValueError("quoted issue exact structured locator required")
        row = None
        with plaintext.open() as handle:
            for line, text in enumerate(handle, 1):
                if line == line_number:
                    if hashlib.sha256(text.encode()).hexdigest() != ref.get("rowSha256"):
                        raise ValueError("quoted issue twin row changed")
                    row = json.loads(text)
                    break
        value = row.get("issue_id") if isinstance(row, dict) else None
        if not isinstance(value, str) or re.fullmatch(r"EI-[0-9]+", value) is None:
            raise ValueError("quoted issue complete EI twin required")
        twins.setdefault(value, set()).add(ref["proofSha256"])
    return twins


def quoted_issue_reference_valid(entry: dict[str, object], finding: dict[str, object],
                                  context: dict[str, object]) -> bool:
    """D-160's accessBug EI route; other fields and UUIDs remain refused."""
    value = finding.get("Secret")
    locator = ["payload", "out", "accessBug"]
    if (entry.get("reviewRef") != "p2p-public-release-endgame-2026-09-01#D-160"
            or finding.get("RuleID") != "generic-api-key"
            or not isinstance(value, str) or re.fullmatch(r"EI-[0-9]+", value) is None
            or entry.get("fieldPath") != locator
            or entry.get("line") != finding.get("StartLine")
            or entry.get("rowSha256") != context["plainRowDigests"][int(finding["StartLine"])]
            or entry.get("sourceRef") != _PUBLIC_ISSUE_MAKER
            or entry.get("twinProofSha256") not in context.get("quotedIssueTwins", {}).get(value, set())
            or context.get("identityScanValidated") is not True):
        return False
    row = context["plainRows"][int(finding["StartLine"])]
    if _at_path(row, locator) != value:
        return False
    field = _MATCH_FIELD.match(finding["Match"])
    if not field or field.group(1) != "accessBug":
        return False
    maker = _frozen_source_bytes(entry["sourceRef"], context["trees"])
    if any(part not in maker for part in (
            b"const ms = BigInt(Math.max(0, Date.now() - EI_ID_EPOCH_MS));",
            b"const rand = BigInt(randomInt(0, EI_ID_RAND_SPACE));",
            b"return ((ms << EI_ID_RAND_BITS) + rand).toString();",
            b"const candidate = `EI-${newCollisionResistantIssueTail()}`;")):
        return False
    context.setdefault("_makerProofCache", {})["public-issue"] = entry["sourceRef"]
    containers = entry.get("containingStrings", [])
    if not containers:
        return False
    checked = set()
    for container in containers:
        path = container["fieldPath"]
        path_key = json.dumps(path, separators=(",", ":"))
        if path_key in checked:
            return False
        checked.add(path_key)
        text = _at_path(row, path)
        if not isinstance(text, str) or (path != locator and finding["Match"] not in text):
            return False
        expected = [{"byteStart": match.start(), "byteEnd": match.end(),
                     "sha256": hashlib.sha256(value.encode()).hexdigest()}
                    for match in re.finditer(re.escape(value.encode()), text.encode())]
        if not expected or container.get("spans") != expected:
            return False
        measured = scan_quoted_token_remainder(text, expected, context["identityRecipients"],
                                              context["scannerConfig"], context["credentialDigests"])
        if container.get("scan") != measured:
            return False
    required = {json.dumps(locator, separators=(",", ":"))}
    def walk(item: object, path: list[object]) -> None:
        if isinstance(item, dict):
            for key, nested in item.items():
                walk(nested, [*path, key])
        elif isinstance(item, list):
            for index, nested in enumerate(item):
                walk(nested, [*path, index])
        elif isinstance(item, str) and finding["Match"] in item:
            required.add(json.dumps(path, separators=(",", ":")))
    walk(row, [])
    return required == checked


def _mechanical_context(proof: dict[str, object], directory: Path, root: Path,
                        source: Path, entries: list[dict[str, object]],
                        report: list[dict[str, object]], plain_report: list[dict[str, object]]) -> dict[str, object]:
    reference = _read_extra_proof(proof, directory, "mechanical-class-proof.private.json")
    if (reference.get("sourceSha256") != proof["sourceSha256"]
            or reference.get("plaintextSha256") != _sha256(directory / "seed-000080.plaintext.jsonl")):
        raise ValueError("mechanical proof input mismatch")
    manifest = json.loads((root / "manifest.json").read_text())
    publics = _manifest_publics(manifest)
    public_refs = set()
    for ref in reference.get("publicReferences", []):
        path = _source_file(root, ref["file"])
        field_path = ref["fieldPath"]
        if (_sha256(path) != ref["sourceSha256"]
                or not re.fullmatch(r"(?:sha256|sha|digest|hash|log_id|logId)", str(field_path[-1]))):
            raise ValueError("public reference source mismatch")
        value = _at_path(json.loads(path.read_text()), field_path)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", value):
            raise ValueError("invalid public reference value")
        public_refs.add(value)
    needed_lines = {int(row["StartLine"]) for row in plain_report}
    plain_rows = {}
    plain_digests = {}
    public_ids = set()
    with (directory / "seed-000080.plaintext.jsonl").open() as handle:
        for line, text in enumerate(handle, 1):
            row = json.loads(text)
            def collect_ids(value: object) -> None:
                if isinstance(value, dict):
                    for name, item in value.items():
                        if name in _ID_FIELDS and isinstance(item, str) and _public_id(item):
                            public_ids.add(item)
                        collect_ids(item)
                elif isinstance(value, list):
                    for item in value:
                        collect_ids(item)
            collect_ids(row)
            if line in needed_lines:
                plain_rows[line] = row
                plain_digests[line] = hashlib.sha256(text.encode()).hexdigest()
    data = source.read_bytes()
    fields = {(found.group("field").decode(), found.group("value").decode())
              for found in _SEED_FIELDS.finditer(data)}
    context = {"seedFields": fields, "publicKeys": publics, "plainRows": plain_rows,
               "plainRowDigests": plain_digests,
               "publicReferences": public_refs, "idFields": set(reference.get("idFields", [])),
               "trees": reference.get("trees", {}), "publicIds": public_ids,
               "nonBearerFields": reference.get("nonBearerFields", {})}
    quoted_twins = reference.get("quotedIssueTwinProofs", [])
    if quoted_twins:
        config = Path(__file__).parent.parent / "release-gitleaks.toml"
        if _sha256(config) != proof["configSha256"]:
            raise ValueError("quoted issue scan configuration changed")
        context["scannerConfig"] = config
    has_envelopes = any(entry["class"] == "recipient-sealed-epoch-key-envelope" for entry in entries)
    # Plain entries are checked by the caller; a supplied closed field proof
    # requires the same full inventory scan, even in a non-metadata segment.
    has_non_bearer = bool(reference.get("nonBearerFields"))
    if has_envelopes or has_non_bearer or quoted_twins:
        envelope = _read_extra_proof(proof, directory, "sealed-envelope-proof-safe.json")
        keys = json.loads((root / "epoch-keys.json").read_text())["papercusp"]
        if has_envelopes:
            context["envelopeDigests"] = validate_envelope_structure(envelope, data, report, {int(k) for k in keys})
            recipient_keys = {_canonical_base64(value, 32) for value in envelope["recipients"]}
        else:
            recipient_ref = reference["identityRecipientSource"]
            recipient_source = _source_file(root, recipient_ref["file"])
            if _sha256(recipient_source) != recipient_ref["sha256"]:
                raise ValueError("identity recipient source changed")
            recipient_data = recipient_source.read_bytes()
            members = _table_ops(recipient_data, "hive-members")
            encoded = {entry["device_pubkey"] for op in members
                       for entry in op["value"].get("device_attestations", [])}
            recipient_keys = {_canonical_base64(value, 32) for value in encoded}
            rows = _table_ops(recipient_data, "hive-epoch-keys")
            if len(recipient_keys) != 33 or not rows or set(envelope["recipients"]) != encoded:
                raise ValueError("historical recipient source incomplete")
            for op in rows:
                value = op["value"]
                if (value["harness_slug"] != "papercusp" or value["epoch"] not in {int(k) for k in keys}
                        or value["member_device_pubkey"] not in encoded
                        or op["hbKey"] != str(value["epoch"]) + ":" + value["member_device_pubkey"]):
                    raise ValueError("cross-segment recipient source mismatch")
                _canonical_base64(value["wrapped_key"], 80)
            if envelope["sourceSha256"] != recipient_ref["sha256"]:
                raise ValueError("recipient proof source mismatch")
        publics |= recipient_keys
        identity_scan = _read_extra_proof(proof, directory, "identity-secret-scan-safe.json")
        validate_identity_secret_proof(identity_scan, root, directory, recipient_keys, reference)
        context["identityScanValidated"] = True
        context["credentialDigestScan"] = identity_scan.get("credentialDigestScan", {})
        context["identityRecipients"] = recipient_keys
        context["credentialDigests"] = set(reference.get("credentialDigests", []))
    if quoted_twins:
        context["quotedIssueTwins"] = validate_quoted_issue_twins(
            quoted_twins, directory, root, context["scannerConfig"], proof, context)
    return context


def _secret_inventory(roots: list[Path]) -> set[Path]:
    # rglob does not traverse symlink directories. The link text is shipped
    # content; its host-resolved destination is not part of the artifact.
    return {Path(os.path.abspath(path)) for folder in roots for path in folder.rglob("*")
            if path.is_symlink() or path.is_file()}


def _secret_input_hash(path: Path) -> str:
    if path.is_symlink():
        return hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
    if not path.is_file():
        raise ValueError("secret scan input must be a file or symlink")
    return _sha256(path)


_IDENTITY_NAMES = ("*keychain*", "*keystore*", "*device-keypair*", "*.pem", "*.p8", "*.key")


def _identity_name_hit(path: Path) -> bool:
    return any(fnmatch.fnmatch(path.name.lower(), pattern) for pattern in _IDENTITY_NAMES)


def _frozen_source_bytes(ref: dict[str, object], trees: dict[str, object]) -> bytes:
    root, sha = _source_tree(ref, trees)
    relative = ref["path"]
    if (not isinstance(relative, str) or Path(relative).is_absolute()
            or ".." in Path(relative).parts):
        raise ValueError("invalid frozen source locator")
    blob = subprocess.run(["git", "-C", str(root), "rev-parse", sha + ":" + relative],
                          check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
    if blob != ref["blob"]:
        raise ValueError("frozen source blob mismatch")
    return subprocess.run(["git", "-C", str(root), "cat-file", "blob", blob], check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def _vendored_package_bytes(ref: dict[str, object], trees: dict[str, object],
                            bundled_path: Path) -> bytes:
    """D-150/D-151: exact bundled package member and frozen sha512 integrity."""
    if ref["lockRef"].get("path") != "package-lock.json" or ref["lockRef"].get("tree") != "superproject":
        raise ValueError("frozen root package lock required")
    lock = json.loads(_frozen_source_bytes(ref["lockRef"], trees))
    package = lock["packages"][ref["packagePath"]]
    if (package["version"] != ref["version"] or package["integrity"] != ref["integrity"]
            or ref["packagePath"] != "node_modules/" + ref["name"]):
        raise ValueError("vendored certificate package mismatch")
    registry_url = ("https://registry.npmjs.org/" + ref["name"] + "/-/"
                    + ref["name"].rsplit("/", 1)[-1] + "-" + ref["version"] + ".tgz")
    if package.get("resolved") != registry_url:
        raise ValueError("vendored package registry URL mismatch")
    algorithm, encoded = ref["integrity"].split("-", 1)
    if algorithm != "sha512":
        raise ValueError("unsupported package integrity")
    archive = Path(ref["archive"])
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("package archive required")
    before = _sha256(archive)
    digest = hashlib.new(algorithm)
    with archive.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if base64.b64encode(digest.digest()).decode() != encoded:
        raise ValueError("package archive integrity mismatch")
    member = ref["member"]
    if (not isinstance(member, str) or member.startswith("/")
            or any(part in {"", ".", ".."} for part in member.split("/"))):
        raise ValueError("invalid package member")
    with tarfile.open(archive) as handle:
        members = handle.getmembers()
        # npm also serves archives with repository roots (ssh2@1.17.0 uses
        # mscdex-ssh2-5c506eb/). Derive exactly one root from the integrity-bound
        # package metadata, never from a caller-selected arbitrary prefix.
        metadata = [row for row in members
                    if len(row.name.split("/")) == 2 and row.name.endswith("/package.json")]
        if (len(metadata) != 1 or not metadata[0].isfile()
                or metadata[0].name.split("/")[0] in {"", ".", ".."}):
            raise ValueError("unique regular archive package metadata required")
        archive_json = json.loads(handle.extractfile(metadata[0]).read())
        if (not isinstance(archive_json, dict) or archive_json.get("name") != ref["name"]
                or archive_json.get("version") != ref["version"]):
            raise ValueError("archive package identity mismatch")
        prefix = metadata[0].name.removesuffix("package.json")
        if not member.startswith(prefix) or member == metadata[0].name:
            raise ValueError("package member outside archive root")
        relative = member[len(prefix):]
        if ((ref["name"] == "ssh2" and relative.startswith("test/fixtures/")
             and relative != "test/fixtures/https_cert.pem")
                or (ref["name"] == "style-dictionary"
                    and relative == "examples/advanced/create-react-native-app/android/app/debug.keystore")):
            raise ValueError("vendor fixture cannot be excluded")
        suffix = "/node_modules/" + ref["name"] + "/" + relative
        if not bundled_path.as_posix().endswith(suffix):
            raise ValueError("bundled package path mismatch")
        package_root = Path(bundled_path.as_posix()[:-len(relative)])
        package_json = json.loads((package_root / "package.json").read_text())
        if (package_json.get("name") != ref["name"]
                or package_json.get("version") != ref["version"]):
            raise ValueError("bundled package identity mismatch")
        found = [row for row in members if row.name == member]
        if len(found) != 1 or not found[0].isfile():
            raise ValueError("exact regular package member required")
        data = handle.extractfile(found[0]).read()
    if _sha256(archive) != before:
        raise ValueError("package archive changed")
    return data


def _dpkg_certificate_bytes(ref: dict[str, object], bundled_path: Path) -> bytes:
    """D-151 V2: .deb digest in the exact Packages index, not dpkg md5sums."""
    index = Path(ref["index"])
    archive = Path(ref["archive"])
    if (index.is_symlink() or archive.is_symlink() or _sha256(index) != ref["indexSha256"]
            or _sha256(archive) != ref["archiveSha256"]):
        raise ValueError("OS certificate provenance input mismatch")
    records = []
    for paragraph in index.read_text().split("\n\n"):
        record = dict(line.split(": ", 1) for line in paragraph.splitlines()
                      if ": " in line and not line.startswith(" "))
        if record.get("Package") == ref["name"] and record.get("Version") == ref["version"]:
            records.append(record)
    if not records or any(row.get("SHA256") != ref["archiveSha256"] for row in records):
        raise ValueError("OS certificate is not bound to apt Packages index")
    member = ref["member"]
    if (not isinstance(member, str) or not member.startswith("./")
            or ".." in Path(member).parts or not bundled_path.as_posix().endswith("/" + member[2:])):
        raise ValueError("OS certificate path mismatch")
    fields = subprocess.run(["dpkg-deb", "-f", str(archive), "Package", "Version"], check=True,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().splitlines()
    if fields != ["Package: " + ref["name"], "Version: " + ref["version"]]:
        raise ValueError("OS certificate package identity mismatch")
    producer = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(archive)],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    found = []
    try:
        with tarfile.open(fileobj=producer.stdout, mode="r|") as handle:
            for row in handle:
                if row.name == member:
                    if not row.isfile():
                        raise ValueError("OS certificate regular member required")
                    found.append(handle.extractfile(row).read())
        if producer.wait() != 0 or len(found) != 1:
            raise ValueError("OS certificate package member incomplete")
    finally:
        producer.stdout.close()
        if producer.poll() is None:
            producer.terminate()
            producer.wait()
    if _sha256(archive) != ref["archiveSha256"] or _sha256(index) != ref["indexSha256"]:
        raise ValueError("OS certificate provenance changed")
    return found[0]


def _parsed_public_certificates(data: bytes) -> list[dict[str, str]]:
    if any(label != b"CERTIFICATE" for label in re.findall(rb"-----BEGIN ([A-Z0-9 ]+)-----", data)):
        raise ValueError("non-certificate block in public certificate input")
    blocks = list(re.finditer(rb"-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+)"
                             rb"-----END CERTIFICATE-----", data))
    if (not blocks or len(blocks) != data.count(b"-----BEGIN CERTIFICATE-----")
            or len(blocks) != data.count(b"-----END CERTIFICATE-----")):
        raise ValueError("complete public certificates required")
    result = []
    for block in blocks:
        parsed = subprocess.run(["openssl", "x509", "-inform", "PEM", "-noout",
                                 "-sha256", "-fingerprint", "-subject", "-nameopt", "RFC2253"],
                                input=block.group(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if parsed.returncode != 0:
            raise ValueError("public certificate parse failed")
        lines = parsed.stdout.decode().splitlines()
        fingerprint = lines[0].split("=", 1)[1].replace(":", "").lower()
        subject = lines[1].removeprefix("subject=")
        if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
            raise ValueError("public certificate fingerprint invalid")
        result.append({"sha256": fingerprint, "subject": subject})
    return result


def validate_identity_name_exclusions(entries: list[dict[str, object]], inputs: set[Path],
                                      recipients: set[bytes], publics: set[bytes],
                                      trees: dict[str, object]) -> dict[str, int]:
    """D-150 V1/V2: exact file digests, re-derived provenance and key checks."""
    seen = set()
    counts = Counter()
    for entry in entries:
        path = Path(os.path.abspath(entry["path"]))
        if (path in seen or path not in inputs or path.is_symlink() or not path.is_file()
                or not _identity_name_hit(path) or _sha256(path) != entry["sha256"]):
            raise ValueError("identity name exclusion input mismatch")
        data = path.read_bytes()
        key_check = scan_secret_key_bytes(data, recipients, publics)
        private_der = subprocess.run(["openssl", "pkey", "-inform", "DER", "-noout"],
                                     input=data, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if key_check["realFindings"] != 0 or private_der.returncode == 0:
            raise ValueError("private material cannot be name-excluded")
        kind = entry["class"]
        if kind == "frozen-public-source-vocabulary":
            if ("sourceRef" in entry) == ("packageRef" in entry):
                raise ValueError("one source provenance required")
            provenance = (_frozen_source_bytes(entry["sourceRef"], trees) if "sourceRef" in entry
                          else _vendored_package_bytes(entry["packageRef"], trees, path))
            if provenance != data:
                raise ValueError("public source exclusion bytes mismatch")
        elif kind == "parsed-public-x509-certificate":
            certificates = _parsed_public_certificates(data)
            if certificates != entry["certificates"]:
                raise ValueError("public certificate identity mismatch")
            if sum(name in entry for name in ("sourceRef", "packageRef", "debRef")) != 1:
                raise ValueError("one certificate provenance required")
            provenance = (_frozen_source_bytes(entry["sourceRef"], trees) if "sourceRef" in entry
                          else _vendored_package_bytes(entry["packageRef"], trees, path) if "packageRef" in entry
                          else _dpkg_certificate_bytes(entry["debRef"], path))
            if provenance != data:
                raise ValueError("public certificate provenance bytes mismatch")
        else:
            raise ValueError("unsupported identity name exclusion")
        if _sha256(path) != entry["sha256"]:
            raise ValueError("identity name exclusion input changed")
        seen.add(path)
        counts[entry["sha256"]] += 1
    return dict(sorted(counts.items()))


def validate_identity_secret_proof(scan: dict[str, object], root: Path, directory: Path,
                                   recipients: set[bytes], reference: dict[str, object]) -> None:
    if (scan.get("schema") != "papercusp-sealed-envelope-secret-scan-v1"
            or scan.get("seedRootSha") != _sha256(root / "manifest.json")
            or scan.get("scannerSha256") != _sha256(Path(__file__))
            or scan.get("recipientSetSha256") != hashlib.sha256(
                json.dumps(sorted(value.hex() for value in recipients), separators=(",", ":")).encode()).hexdigest()
            or any(scan.get(name) != 0 for name in ("realFindings", "derivationMatches", "rawSkMatches", "nameScanHits"))
            or scan.get("positivePlantedSecretDetected") is not True
            or not isinstance(scan.get("tokensChecked"), int)):
        raise ValueError("identity secret scan failed")
    bundles = [Path(value) for value in reference["bundleRoots"]]
    plaintext_root = Path(reference.get("plaintextRoot", str(directory)))
    if not bundles or any(not bundle.is_dir() or bundle.is_symlink() for bundle in bundles):
        raise ValueError("assembled bundle input required")
    expected = _secret_inventory([root, *bundles])
    expected |= {Path(os.path.abspath(_source_file(plaintext_root, value)))
                 for value in reference["plaintextInputs"]}
    inputs = scan.get("inputs", [])
    if (len(inputs) != len(expected)
            or {Path(os.path.abspath(row["path"])) for row in inputs} != expected):
        raise ValueError("identity secret scan inventory incomplete")
    for row in inputs:
        path = Path(row["path"])
        kind = "symlink-target" if path.is_symlink() else "file"
        if row.get("contentKind", "file") != kind or _secret_input_hash(path) != row["sha256"]:
            raise ValueError("identity secret scan input changed")
    manifest = json.loads((root / "manifest.json").read_text())
    exclusions = scan.get("nameExclusions", [])
    counts = validate_identity_name_exclusions(exclusions, expected, recipients,
                                              _manifest_publics(manifest), reference.get("trees", {}))
    if (scan.get("nameExclusionCounts", {}) != counts
            or len(exclusions) != sum(_identity_name_hit(path) for path in expected)):
        raise ValueError("identity name exclusions incomplete")
    if "credentialDigestScan" in scan:
        digest_scan = scan["credentialDigestScan"]
        digests = digest_scan.get("digests", [])
        if (not digests or len(digests) != len(set(digests))
                or any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in digests)
                or any(digest_scan.get(name) != 0 for name in ("digestOfCredentialHits", "rawCredentialHits"))
                or any(digest_scan.get(name) is not True for name in ("hashControlDetected", "rawControlDetected"))
                or not re.fullmatch(r"[0-9a-f]{64}", str(digest_scan.get("plantedSha256", "")))):
            raise ValueError("credential digest exposure scan failed")
    controls = scan.get("controls", [])
    encodings = {"der-base64", "pem", "jwk-d", "hex-seed", "base64-seed", "raw-sodium-secret"}
    samples = {}
    for row in controls:
        if (row.get("detected") is not True or row.get("derivationDetected") is not True
                or not re.fullmatch(r"[0-9a-f]{64}", str(row.get("plantedSha256", "")))
                or row.get("inputSha256") not in {entry["sha256"] for entry in inputs}):
            raise ValueError("identity secret positive control failed")
        samples.setdefault(row["inputSha256"], set()).add(row["encoding"])
    plain_hashes = {_sha256(_source_file(plaintext_root, path)) for path in reference["plaintextInputs"]}
    bundle_hashes = {_secret_input_hash(path) for path in _secret_inventory(bundles)}
    if (not any(digest in plain_hashes and kinds == encodings for digest, kinds in samples.items())
            or not any(digest in bundle_hashes and kinds == encodings for digest, kinds in samples.items())):
        raise ValueError("seed and bundle planted controls required")

# D-142/D-147: recognize complete private-key material, including raw seeds
# whose derived public key belongs to a recipient. Source vocabulary by itself
# (a PEM header or a service name in code) is not a serialized private key.
_ED25519_DER_PREFIX = bytes.fromhex("302e020100300506032b657004220420")
_X25519_DER_PREFIX = bytes.fromhex("302e020100300506032b656e04220420")
# '=' can precede an unquoted assignment value. On the right it remains part
# of base64 padding, so a prefix of a longer encoded value is never accepted.
_KEY_TOKENS = re.compile(rb"(?<![A-Za-z0-9_+/-])(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{64}|[A-Za-z0-9_+/-]{86}={0,2}|[A-Za-z0-9_+/-]{43}=?)(?![A-Za-z0-9_+/=-])")
_PEM_PRIVATE = re.compile(rb"-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----\s+([A-Za-z0-9+/=\s]+)-----END \1-----")
_PRIVATE_JWK = re.compile(rb'\{[^{}]{0,16384}"kty"\s*:\s*"(?:OKP|RSA|EC)"[^{}]{0,16384}\}')


def _sodium():
    name = ctypes.util.find_library("sodium")
    if not name:
        raise ValueError("secret-key derivation scanner unavailable")
    library = ctypes.CDLL(name)
    if library.sodium_init() < 0:
        raise ValueError("secret-key derivation scanner unavailable")
    for function, arity in (("crypto_sign_seed_keypair", 3),
                            ("crypto_sign_ed25519_pk_to_curve25519", 2),
                            ("crypto_scalarmult_base", 2)):
        method = getattr(library, function)
        method.argtypes = [ctypes.c_void_p] * arity
        method.restype = ctypes.c_int
    return library


def _key_publics(sodium, seed: bytes) -> tuple[bytes, bytes]:
    ed = ctypes.create_string_buffer(32)
    secret = ctypes.create_string_buffer(64)
    curve = ctypes.create_string_buffer(32)
    if sodium.crypto_sign_seed_keypair(ed, secret, seed) != 0:
        raise ValueError("Ed25519 derivation failed")
    if sodium.crypto_scalarmult_base(curve, seed) != 0:
        raise ValueError("X25519 derivation failed")
    return ed.raw, curve.raw


def scan_secret_key_bytes(data: bytes, recipients: set[bytes],
                          public_keys: set[bytes] | None = None) -> dict[str, int]:
    """Read-only, value-free detector shared by real input and planted controls."""
    sodium = _sodium()
    curve_recipients = set()
    for public in recipients:
        if len(public) != 32:
            raise ValueError("invalid recipient public key")
        curve = ctypes.create_string_buffer(32)
        if sodium.crypto_sign_ed25519_pk_to_curve25519(curve, public) != 0:
            raise ValueError("invalid Ed25519 recipient public key")
        curve_recipients.add(curve.raw)
    seeds: set[bytes] = set()
    public_keys = public_keys or set()
    serialized = 0
    raw_sk_matches = 0
    if len(data) in (32, 64):
        seeds.add(data[:32])

    def der(value: bytes) -> bool:
        nonlocal serialized
        found = False
        for prefix in (_ED25519_DER_PREFIX, _X25519_DER_PREFIX):
            offset = 0
            while True:
                offset = value.find(prefix, offset)
                if offset < 0:
                    break
                end = offset + len(prefix) + 32
                if end <= len(value):
                    seeds.add(value[offset + len(prefix):end])
                    serialized += 1
                    found = True
                offset += 1
        return found

    der(data)
    # A raw libsodium Ed25519 secret is seed || public. Search recipient public
    # bytes first, then derive the preceding seed; random ciphertext is not a key.
    for public in recipients | public_keys:
        offset = data.find(public)
        while offset >= 0:
            if offset >= 32:
                seed = data[offset - 32:offset]
                derived, _ = _key_publics(sodium, seed)
                if derived == public:
                    seeds.add(seed)
                    serialized += 1
                    raw_sk_matches += 1
            offset = data.find(public, offset + 1)
    # Complete DER, not its prefix, represented as hex or base64.
    for pattern, decode in (
        (rb"(?<![0-9a-fA-F])(?:" + _ED25519_DER_PREFIX.hex().encode() + b"|" + _X25519_DER_PREFIX.hex().encode() + rb")[0-9a-fA-F]{64}(?![0-9a-fA-F])", lambda value: bytes.fromhex(value.decode("ascii"))),
        (rb"(?<![A-Za-z0-9+/])MC4CAQAwBQYDK2V[wu]BCIEI[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])", base64.b64decode),
    ):
        for match in re.finditer(pattern, data):
            der(decode(match.group()))
    for match in _PEM_PRIVATE.finditer(data):
        value = base64.b64decode(re.sub(rb"\s", b"", match.group(2)), validate=True)
        if not der(value):
            # Other complete PEM private-key formats are also private material.
            serialized += 1
    for match in _PRIVATE_JWK.finditer(data):
        try:
            value = json.loads(match.group())
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get("d"), str):
            raw = base64.urlsafe_b64decode(value["d"] + "=" * (-len(value["d"]) % 4))
            if value.get("crv") in {"Ed25519", "X25519"} and len(raw) in (32, 64):
                seeds.add(raw[:32])
            if raw:
                serialized += 1
    for match in _KEY_TOKENS.finditer(data):
        token = match.group()
        try:
            raw = (bytes.fromhex(token.decode()) if re.fullmatch(rb"[0-9a-fA-F]{64}|[0-9a-fA-F]{128}", token)
                   else base64.b64decode(token.replace(b"-", b"+").replace(b"_", b"/") + b"=" * (-len(token) % 4), validate=True))
        except ValueError:
            continue
        if len(raw) in (32, 64):
            seeds.add(raw[:32])
            if len(raw) == 64:
                public, _ = _key_publics(sodium, raw[:32])
                if raw[32:] == public:
                    serialized += 1
    matches = 0
    for seed in seeds:
        ed, curve = _key_publics(sodium, seed)
        if ed in recipients | public_keys or curve in curve_recipients | public_keys:
            matches += 1
    pem_blocks = len(list(_PEM_PRIVATE.finditer(data)))
    marker_hits = (data.count(b"BEGIN PRIVATE KEY") +
                   data.count(b"BEGIN OPENSSH PRIVATE KEY") +
                   data.count(b"BEGIN ENCRYPTED PRIVATE KEY") +
                   data.count(b"papercusp-hive-epoch-key") +
                   data.count(b"papercusp-device-keypair"))
    dumps = len(list(re.finditer(
        rb'papercusp-(?:hive-epoch-key|device-keypair)[^\n]{0,256}"value"\s*:\s*"[A-Za-z0-9_+/=-]{43,}"', data)))
    return {"realFindings": serialized + matches + dumps,
            "derivationMatches": matches, "tokensChecked": len(seeds),
            "rawSkMatches": raw_sk_matches,
            "literalOnlyMarkers": max(0, marker_hits - pem_blocks - dumps)}


def scan_identity_secret_inputs(inputs: list[Path], recipients: set[bytes],
                                control_samples: list[Path], *,
                                name_exclusions: list[dict[str, object]] | None = None,
                                trees: dict[str, object] | None = None,
                                public_keys: set[bytes] | None = None,
                                credential_digests: set[str] | None = None) -> dict[str, object]:
    """Scan an explicit complete inventory and run controls only in memory.

    The caller binds the inventory to seed/assembled-bundle or final artifacts.
    This never extracts containers implicitly: finished installers need their
    expanded contents in the inventory, through the existing artifact auditor.
    """
    if (not inputs or not control_samples or any(path not in inputs for path in control_samples)
            or any(path.is_symlink() or not path.is_file() for path in control_samples)):
        raise ValueError("complete inventory and real control samples required")
    totals = Counter()
    digest_totals = Counter()
    credential_digests = credential_digests or set()
    if any(not re.fullmatch(r"[0-9a-f]{64}", value) for value in credential_digests):
        raise ValueError("invalid credential digest candidate")
    inventory = []
    name_exclusions = name_exclusions or []
    public_keys = public_keys or set()
    exclusion_counts = validate_identity_name_exclusions(name_exclusions, set(inputs), recipients,
                                                         public_keys, trees or {})
    excluded = {Path(os.path.abspath(entry["path"])) for entry in name_exclusions}
    for path in inputs:
        kind = "symlink-target" if path.is_symlink() else "file"
        before = _secret_input_hash(path)
        # Chunk overlap covers the scanner's largest bounded JWK serialization.
        # It keeps large full-history bundles out of Python heap allocations.
        if kind == "symlink-target":
            content = os.fsencode(os.readlink(path))
            totals.update(scan_secret_key_bytes(content, recipients, public_keys))
            digest_totals.update(scan_credential_digest_bytes(content, credential_digests))
        else:
            with path.open("rb") as handle:
                previous = b""
                for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
                    totals.update(scan_secret_key_bytes(previous + chunk, recipients, public_keys))
                    digest_totals.update(scan_credential_digest_bytes(previous + chunk, credential_digests))
                    previous = chunk[-32768:]
        if (("symlink-target" if path.is_symlink() else "file") != kind
                or _secret_input_hash(path) != before):
            raise ValueError("secret scan input changed")
        entry = {"path": str(path), "sha256": before}
        if kind != "file":
            entry["contentKind"] = kind
        inventory.append(entry)
        if _identity_name_hit(path) and Path(os.path.abspath(path)) not in excluded:
            totals["nameScanHits"] += 1
    sodium = _sodium()
    seed = os.urandom(32)
    public, _ = _key_publics(sodium, seed)
    der = _ED25519_DER_PREFIX + seed
    controls = {
        "der-base64": base64.b64encode(der),
        "pem": b"-----BEGIN " + b"PRIVATE KEY-----\n" + base64.b64encode(der) + b"\n-----END " + b"PRIVATE KEY-----",
        "jwk-d": json.dumps({"kty": "OKP", "crv": "Ed25519", "d": base64.urlsafe_b64encode(seed).decode().rstrip("=")}).encode(),
        "hex-seed": seed.hex().encode(),
        "base64-seed": base64.b64encode(seed),
        "raw-sodium-secret": seed + public,
    }
    results = []
    for sample in control_samples:
        with sample.open("rb") as handle:
            real_copy = handle.read(8 * 1024 * 1024)
        for encoding, planted in controls.items():
            result = scan_secret_key_bytes(real_copy + b"\n" + planted + b"\n", recipients | {public})
            results.append({"inputSha256": _sha256(sample), "encoding": encoding,
                            "plantedSha256": hashlib.sha256(planted).hexdigest(),
                            "detected": result["realFindings"] > 0,
                            "derivationDetected": result["derivationMatches"] > 0})
    if not all(row["detected"] and row["derivationDetected"] for row in results):
        raise ValueError("planted secret control failed")
    result = {"schema": "papercusp-sealed-envelope-secret-scan-v1",
            "inputs": inventory, "scannerSha256": _sha256(Path(__file__)),
            "recipientSetSha256": hashlib.sha256(json.dumps(
                sorted(value.hex() for value in recipients), separators=(",", ":")).encode()).hexdigest(),
            "realFindings": totals["realFindings"],
            "derivationMatches": totals["derivationMatches"],
            "rawSkMatches": totals["rawSkMatches"],
            "tokensChecked": totals["tokensChecked"],
            "literalOnlyMarkers": totals["literalOnlyMarkers"],
            "nameScanHits": totals["nameScanHits"], "controls": results,
            "nameExclusions": name_exclusions, "nameExclusionCounts": exclusion_counts,
            "positivePlantedSecretDetected": True}
    if credential_digests:
        planted = os.urandom(32).hex().encode()
        target = hashlib.sha256(planted).hexdigest()
        hash_control = scan_credential_digest_bytes(planted, {target})
        raw_control = scan_credential_digest_bytes(target.encode(), {target})
        result["credentialDigestScan"] = {
            "digests": sorted(credential_digests),
            "digestOfCredentialHits": digest_totals["digestOfCredentialHits"],
            "rawCredentialHits": digest_totals["rawCredentialHits"],
            "hashControlDetected": hash_control["digestOfCredentialHits"] > 0,
            "rawControlDetected": raw_control["rawCredentialHits"] > 0,
            "plantedSha256": target,
        }
    return result


def scan_credential_digest_bytes(data: bytes, digests: set[str]) -> dict[str, int]:
    """D-149 E3: refuse a digest preimage or reuse outside a typed JSON field.

    Values stay in memory. A digest in prose, a header, or a string containing
    JSON is refused; only direct, parseable credentialSha256 properties qualify.
    """
    counts = Counter()
    if not digests:
        return counts
    if len(data) in (32, 64) and hashlib.sha256(data).hexdigest() in digests:
        counts["digestOfCredentialHits"] += 1
    for token in re.finditer(rb"[A-Za-z0-9_+/.=-]{1,4096}", data):
        value = token.group()
        candidates = {value}
        if re.fullmatch(rb"[0-9a-fA-F]{64}|[0-9a-fA-F]{128}", value):
            candidates.add(bytes.fromhex(value.decode()))
        try:
            decoded = base64.b64decode(value.replace(b"-", b"+").replace(b"_", b"/")
                                       + b"=" * (-len(value) % 4), validate=True)
            if len(decoded) in (32, 64):
                candidates.add(decoded)
        except ValueError:
            pass
        if any(hashlib.sha256(candidate).hexdigest() in digests for candidate in candidates):
            counts["digestOfCredentialHits"] += 1
        # D-156: gateway.ts hashes the authorization HEADER, not just its token.
        if any(hashlib.sha256(prefix + candidate).hexdigest() in digests
               for prefix in (b"Bearer ", b"bearer ", b"BEARER ") for candidate in candidates):
            counts["digestOfCredentialHits"] += 1
        if value.decode("ascii") not in digests:
            continue
        start = data.rfind(b"\n", 0, token.start()) + 1
        end = data.find(b"\n", token.end())
        line = data[start:end if end >= 0 else len(data)]
        before = data[start:token.start()]
        direct = re.search(rb'(?<!\\)"credentialSha256"\s*:\s*"$', before)
        try:
            json.loads(line)
        except (ValueError, UnicodeDecodeError):
            direct = None
        if direct is None:
            counts["rawCredentialHits"] += 1
    return counts


def scan_identity_proof(config_path: Path, seed: Path, output: Path) -> dict[str, object]:
    """Collect a private scan over the explicit seed and assembled inventories.

    Container expansion belongs to the maintained artifact auditor; its expanded
    roots must be included alongside the actual sidecar/resource roots here.
    """
    _private_file(config_path)
    config = json.loads(config_path.read_text())
    roots = [seed] + [Path(value) for value in config["bundleRoots"]]
    plaintext = [Path(value) for value in config["plaintextInputs"]]
    if len(roots) < 2 or not plaintext or any(not root.is_dir() or root.is_symlink() for root in roots):
        raise ValueError("seed, assembled bundle and plaintext inventories required")
    paths = sorted(_secret_inventory(roots) | set(plaintext))
    recipients = {_canonical_base64(value, 32) for value in config["recipients"]}
    if len(recipients) != 33:
        raise ValueError("historical recipient population required")
    controls = [Path(value) for value in config["controlSamples"]]
    if (not any(value in plaintext for value in controls)
            or not any(value.resolve().is_relative_to(root.resolve()) for value in controls for root in roots[1:])):
        raise ValueError("plaintext and bundle control samples required")
    scan = scan_identity_secret_inputs(paths, recipients, controls,
                                      name_exclusions=config.get("nameExclusions", []),
                                      trees=config.get("trees", {}),
                                      public_keys=_manifest_publics(json.loads((seed / "manifest.json").read_text())),
                                      credential_digests=set(config.get("credentialDigests", [])))
    scan["seedRootSha"] = _sha256(seed / "manifest.json")
    scan["collectorConfigSha256"] = _sha256(config_path)
    if output.parent.is_symlink() or not output.parent.is_dir() or output.parent.stat().st_mode & 0o077:
        raise ValueError("private scan output directory required")
    fd, temporary = tempfile.mkstemp(prefix="identity-scan-", suffix=".partial", dir=output.parent)
    with os.fdopen(fd, "w") as handle:
        json.dump(scan, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, output)
    return scan


def finding_digest(finding: dict[str, object]) -> str:
    # Gitleaks' native fingerprint binds only file/rule/line. It would hide a
    # second credential on the same binary-blob line (release decision D-140).
    values = [finding.get(key) for key in ("RuleID", "Match", "Secret")]
    if any(not isinstance(value, str) or value == "REDACTED" for value in values):
        raise ValueError("exact private finding required")
    return hashlib.sha256(json.dumps(values, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _private_file(path: Path) -> None:
    if (path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077
            or path.parent.is_symlink() or path.parent.stat().st_mode & 0o077):
        raise ValueError("proof must be private")


def _source_file(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or not candidate.parts or ".." in candidate.parts:
        raise ValueError("invalid source locator")
    target = root / candidate
    if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("source outside seed")
    return target


_UUID_DROP_REVIEW = 'p2p-public-release-endgame-2026-09-01#D-166'
_UUID_DROP_SCHEMA = 'papercusp-uuid-idempotency-row-drop-plan-v1'
_UUID_DROP_SET_SCHEMA = 'papercusp-uuid-idempotency-row-drop-plan-set-v1'
_UUID_MARKER = '<redacted:idempotency-key>'
_UUID4_TEXT = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
_UUID_FIELD_SPACE = r'(?:[\s\\"\x27]|&quot;|&#34;|&#39;)*'
_UUID_NAMED_TEXT = re.compile(r'\bidempotencyKey' + _UUID_FIELD_SPACE + r'[:=]' + _UUID_FIELD_SPACE + r'(' + _UUID4_TEXT + r')')
_UUID_JSON_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
_UUID_DOC_SUFFIXES = {'.md', '.mdx', '.html', '.htm', '.txt', '.json', '.jsonl'}


def _uuid_class_tokens(value: object) -> set[str]:
    """Discover the field class, including JSON quoted inside prose. Never print values."""
    tokens = set()
    if isinstance(value, dict):
        for key, child in value.items():
            if key == 'idempotencyKey' and isinstance(child, str):
                tokens.update(re.findall(_UUID4_TEXT, child))
            tokens.update(_uuid_class_tokens(key))
            tokens.update(_uuid_class_tokens(child))
    elif isinstance(value, list):
        for child in value:
            tokens.update(_uuid_class_tokens(child))
    elif isinstance(value, str):
        tokens.update(_UUID_NAMED_TEXT.findall(value))
    return tokens


def _uuid_occurrences(value: object, tokens: set[str], path: list[object] | None = None) -> list[list[object]]:
    """Value-free exact field paths; text indices distinguish repeats in one container."""
    path = [] if path is None else path
    result = []
    if isinstance(value, dict):
        for key, child in value.items():
            # A secret used as an object key cannot itself become a public field path.
            if any(token.lower() in key.lower() for token in tokens):
                raise ValueError('unsafe UUID object-key locator')
            result += _uuid_occurrences(child, tokens, [*path, key])
    elif isinstance(value, list):
        for index, child in enumerate(value):
            result += _uuid_occurrences(child, tokens, [*path, index])
    elif isinstance(value, str) and tokens:
        pattern = re.compile('|'.join(re.escape(t) for t in sorted(tokens)), re.IGNORECASE)
        hits = list(pattern.finditer(value))
        if len(hits) == 1 and hits[0].span() == (0, len(value)):
            result.append(path or ['<value>'])
        else:
            result += [[*path, '<text>', index] for index in range(len(hits))]
    return result


def _uuid_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def _uuid_source_tokens(config_path: Path) -> set[str]:
    config, keys = _uuid_census_inputs(config_path)
    tokens = set()
    for source in config['sources']:
        for row in _uuid_source_rows(source):
            plain, _ = _uuid_open_row(row, config['potId'], keys)
            tokens.update(_uuid_class_tokens(plain))
            tokens.update(_uuid_class_tokens({k: row[k] for k in ('table', 'hbKey', 'author_pubkey') if k in row}))
    tokens.update(_uuid_document_source_tokens(config))
    return tokens


def _uuid_document_source_tokens(config: dict[str, object]) -> set[str]:
    tokens = set()
    for document in config.get('documentSources', []):
        root = Path(document['rootPath'])
        if _uuid_document_root_sha256(root) != document['rootSha256']:
            raise ValueError('UUID frozen document binding changed')
        for path, _ in _uuid_root_files([root]):
            if path.is_symlink():
                raise ValueError('UUID frozen document input linked')
            if path.suffix.lower() in _UUID_DOC_SUFFIXES:
                tokens.update(_uuid_document_tokens(path.read_text(encoding='utf-8'), path.suffix.lower()))
    return tokens


def _uuid_document_value(text: str, suffix: str) -> object:
    if suffix == '.json':
        return json.loads(text)
    if suffix == '.jsonl':
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return text


def _uuid_document_tokens(text: str, suffix: str) -> set[str]:
    tokens = _uuid_class_tokens(_uuid_document_value(text, suffix))
    # Rendered docs quote JSON with HTML entities. JSON string literals in prose
    # can also quote an escaped field name/value. Neither is a path exemption.
    tokens.update(_uuid_class_tokens(html.unescape(text)))
    for representation in (text, html.unescape(text)):
        previous = None
        for match in _UUID_JSON_STRING.finditer(representation):
            try:
                decoded = json.loads(match.group())
            except ValueError:
                previous = None
                continue
            tokens.update(_uuid_class_tokens(decoded))
            if (previous and previous[0] == 'idempotencyKey'
                    and representation[previous[1]:match.start()].strip() == ':'):
                tokens.update(re.findall(_UUID4_TEXT, decoded))
            previous = (decoded, match.end())
    return tokens


def _uuid_document_occurrences(text: str, suffix: str, tokens: set[str]) -> list[dict[str, object]]:
    value = _uuid_document_value(text, suffix)
    paths = _uuid_occurrences(value, tokens)
    pattern = re.compile('|'.join(re.escape(t) for t in sorted(tokens)), re.IGNORECASE) if tokens else None
    lines = []
    if pattern:
        if suffix in ('.json', '.jsonl'):
            for match in _UUID_JSON_STRING.finditer(text):
                decoded = json.loads(match.group())
                if len(list(pattern.finditer(html.unescape(decoded)))) != len(list(pattern.finditer(decoded))):
                    raise ValueError('UUID HTML-encoded value requires explicit projection')
                lines += [text.count('\n', 0, match.start()) + 1] * len(list(pattern.finditer(decoded)))
        else:
            lines = [text.count('\n', 0, match.start()) + 1 for match in pattern.finditer(text)]
            if len(list(pattern.finditer(html.unescape(text)))) != len(lines):
                raise ValueError('UUID HTML-encoded value requires explicit projection')
    if len(paths) != len(lines):
        raise ValueError('UUID document representation requires explicit projection')
    result = [{'line': line, 'fieldPath': path} for line, path in zip(lines, paths)]
    if suffix not in ('.json', '.jsonl') and pattern:
        for index, match in enumerate(_UUID_JSON_STRING.finditer(text)):
            try:
                decoded = json.loads(match.group())
            except ValueError:
                continue
            # Raw matches were already counted above. Only decoded-but-absent
            # representations are an additional surface (e.g. a Unicode UUID).
            if pattern.search(match.group()):
                continue
            result += [{'line': text.count('\n', 0, match.start()) + 1,
                        'fieldPath': ['<json-string>', index, '<text>', n]}
                       for n, _ in enumerate(pattern.finditer(decoded))]
    return result


def _uuid_byte_strings(data):
    """JSON string decoding without a whole-blob UTF8 allocation or suffix trust."""
    for index, match in enumerate(re.finditer(_UUID_JSON_STRING.pattern.encode(), data)):
        try:
            value = json.loads(match.group())
        except (UnicodeError, ValueError):
            continue
        yield index, match, value


def _uuid_root_files(roots: list[Path]) -> list[tuple[Path, str]]:
    if not roots:
        raise ValueError('UUID artifact roots missing')
    resolved = [root.resolve() for root in roots]
    if any(a == b or a.is_relative_to(b) or b.is_relative_to(a)
           for i, a in enumerate(resolved) for b in resolved[i + 1:]):
        raise ValueError('UUID artifact roots overlap')
    result = []
    for index, root in enumerate(roots):
        if root.is_symlink() or not root.exists():
            raise ValueError('UUID artifact root missing or linked')
        if root.is_file():
            result.append((root, f'root-{index}/{root.name}'))
            continue
        if not root.is_dir():
            raise ValueError('UUID artifact root unsupported')
        for directory, dirs, files in os.walk(root, followlinks=False):
            for name in sorted(dirs + files):
                path = Path(directory) / name
                if path.is_symlink() or path.is_file():
                    result.append((path, f'root-{index}/{path.relative_to(root).as_posix()}'))
                elif not path.is_dir():
                    raise ValueError('UUID artifact contains special file')
    if not result:
        raise ValueError('UUID artifact population empty')
    return sorted(result, key=lambda entry: entry[1])


def _uuid_document_root_sha256(root: Path) -> str:
    entries = _uuid_root_files([root])
    if not root.is_dir() or any(path.is_symlink() for path, _ in entries):
        raise ValueError('UUID frozen document root invalid')
    return hashlib.sha256(_uuid_json([(label, _sha256(path)) for path, label in entries]).encode()).hexdigest()


def bind_uuid_document_sources(config_path: Path, expected_sha256: str, output: Path, roots: list[Path]) -> None:
    if not re.fullmatch(r'[0-9a-f]{64}', expected_sha256) or _sha256(config_path) != expected_sha256:
        raise ValueError('UUID private census changed')
    config, _ = _uuid_census_inputs(config_path)
    if 'documentSources' in config or not roots:
        raise ValueError('UUID document binding requires original census and fresh roots')
    _uuid_root_files(roots)  # Refuse overlaps as well as missing/empty populations.
    context = {**config, 'originalCensusSha256': expected_sha256,
               'documentSources': [{'rootPath': str(root), 'rootSha256': _uuid_document_root_sha256(root)} for root in roots]}
    _private_file(config_path)
    if output.parent.is_symlink() or output.parent.stat().st_mode & 0o077:
        raise ValueError('UUID document context must stay private')
    with output.open('x', encoding='utf-8') as handle:
        os.chmod(output, 0o600)
        json.dump(context, handle)


@contextlib.contextmanager
def _uuid_artifact_population(roots: list[Path]):
    """Reuse the release audit's readers; never certify compressed bytes alone."""
    spec = importlib.util.spec_from_file_location('uuid_release_audit', Path(__file__).parents[1] / 'audit-release-bundle.py')
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    original = _uuid_root_files(roots)
    fingerprint = lambda p: hashlib.sha256(os.readlink(p).encode()).hexdigest() if p.is_symlink() else _sha256(p)
    before = [(label, fingerprint(path)) for path, label in original]
    with tempfile.TemporaryDirectory(prefix='papercusp-uuid-artifacts-') as temporary:
        population = []

        def visit(path: Path, label: str, ancestors: tuple[str, ...] = ()):
            digest = fingerprint(path)
            population.append((path, label, digest))
            if path.is_symlink():
                return  # The link target string is scanned, never followed on the host.
            low = path.name.lower()
            installer = audit._looks_like_installer_stub(low)
            if not installer and not low.endswith(audit.ARCHIVE_SUFFIXES):
                with path.open('rb') as handle:
                    prefix = handle.read(512)
                if (prefix.startswith((b'\x1f\x8b', b'PK\x03\x04', b'\x28\xb5\x2f\xfd', b'\xfd7zXZ\x00', b'BZh'))
                        or prefix[257:262] == b'ustar'):
                    raise ValueError('UUID archive format/name mismatch requires explicit reader')
                return
            if digest in ancestors or len(ancestors) >= 32:
                raise ValueError('UUID archive recursion invalid')
            destination = Path(temporary) / str(len(population))
            # Readers may report archive member names/errors. Do not echo those
            # into a release log that promises never to disclose the UUID value.
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                ok = audit._expand_installer(str(path.absolute()), str(destination))[0] if installer else audit._expand_archive(str(path.absolute()), str(destination))
            if not ok:
                raise ValueError('UUID artifact could not be expanded')
            members = _uuid_root_files([destination])
            if installer and audit._tree_bytes(str(destination)) < path.stat().st_size * audit.ARTIFACT_MIN_EXPANSION_RATIO:
                raise ValueError('UUID installer expansion coverage incomplete')
            for member, relative in members:
                visit(member, label + '!' + relative.split('/', 1)[1], (*ancestors, digest))
            if fingerprint(path) != digest:
                raise ValueError('UUID archive changed during enumeration')

        for path, label in original:
            visit(path, label)
        yield population
        if before != [(label, fingerprint(path)) for path, label in _uuid_root_files(roots)]:
            raise ValueError('UUID artifact population changed')


def census_uuid_artifacts(config_path: Path, roots: list[Path]) -> dict[str, object]:
    """Complete within the caller's bound roots, not proof of release-root selection."""
    tokens = _uuid_source_tokens(config_path)
    with _uuid_artifact_population(roots) as population:
        for path, _, _ in population:
            if path.is_symlink():
                continue
            if path.suffix.lower() in _UUID_DOC_SUFFIXES:
                tokens.update(_uuid_document_tokens(path.read_text(encoding='utf-8'), path.suffix.lower()))
            elif path.stat().st_size:
                with path.open('rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
                    tokens.update(match.group(1).decode() for match in re.finditer(_UUID_NAMED_TEXT.pattern.encode(), data))
                    previous = None
                    for _, match, value in _uuid_byte_strings(data):
                        tokens.update(_uuid_class_tokens(html.unescape(value)))
                        if (previous and previous[0] == 'idempotencyKey'
                                and data[previous[1]:match.start()].strip() == b':'):
                            tokens.update(re.findall(_UUID4_TEXT, html.unescape(value)))
                        previous = (value, match.end())
        inventory, occurrences = [], []
        for root in roots:
            if root.is_dir():
                for directory, dirs, _ in os.walk(root, followlinks=False):
                    for name in dirs:
                        if _uuid_occurrences((Path(directory) / name).relative_to(root).as_posix(), tokens):
                            raise ValueError('UUID unsafe artifact directory path')
        for index, (path, label, digest) in enumerate(population, 1):
            segment = f'artifact-{index:06d}'
            if _uuid_occurrences(label, tokens):
                raise ValueError('UUID unsafe artifact path')
            if path.is_symlink():
                found = _uuid_document_occurrences(os.readlink(path), '.txt', tokens)
            elif path.suffix.lower() in _UUID_DOC_SUFFIXES:
                found = _uuid_document_occurrences(path.read_text(encoding='utf-8'), path.suffix.lower(), tokens)
            else:
                found = []
                if path.stat().st_size:
                    with path.open('rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
                        if tokens:
                            pattern = re.compile(b'|'.join(re.escape(t.encode()) for t in sorted(tokens)), re.IGNORECASE)
                            found = [{'line': data[:m.start()].count(b'\n') + 1, 'fieldPath': ['<bytes>', n]}
                                     for n, m in enumerate(pattern.finditer(data))]
                            text_pattern = re.compile('|'.join(re.escape(t) for t in sorted(tokens)), re.IGNORECASE)
                            for n, match, value in _uuid_byte_strings(data):
                                if len(list(text_pattern.finditer(html.unescape(value)))) != len(list(text_pattern.finditer(value))):
                                    raise ValueError('UUID byte string HTML encoding requires explicit decoder')
                                if pattern.search(match.group()):
                                    continue
                                found += [{'line': data[:match.start()].count(b'\n') + 1,
                                           'fieldPath': ['<json-string>', n, '<text>', i]}
                                          for i, _ in enumerate(text_pattern.finditer(value))]
                            utf16 = re.compile(b'|'.join(re.escape(t.encode(encoding)) for t in sorted(tokens)
                                                        for encoding in ('utf-16-le', 'utf-16-be')), re.IGNORECASE)
                            found += [{'line': 1, 'fieldPath': ['<utf16-bytes>', n]}
                                      for n, _ in enumerate(utf16.finditer(data))]
                        if any(re.search(re.escape('idempotencyKey'.encode(encoding)), data, re.IGNORECASE)
                               for encoding in ('utf-16-le', 'utf-16-be')):
                            raise ValueError('UUID UTF16 named class requires explicit decoder')
            current = hashlib.sha256(os.readlink(path).encode()).hexdigest() if path.is_symlink() else _sha256(path)
            if current != digest:
                raise ValueError('UUID artifact changed during scan')
            inventory.append({'segment': segment, 'path': label, 'sha256': digest})
            occurrences += [{**row, 'segment': segment} for row in found]
        return {'reviewRef': _UUID_DROP_REVIEW, 'inventory': inventory,
                'occurrences': occurrences, 'occurrenceCount': len(occurrences),
                'coverage': 'complete-within-bound-roots',
                'releaseRootSelection': 'requires-independent-release-inventory-validation'}


def _uuid_document_projection_expectation(config_path: Path, source: Path):
    """Independently rederive from frozen inputs, never from the emitted manifest."""
    census = census_uuid_artifacts(config_path, [source])
    originals = _uuid_root_files([source])
    tokens = _uuid_source_tokens(config_path)
    for path, _ in originals:
        if path.is_symlink():
            raise ValueError('UUID document projection cannot copy linked input')
        if path.suffix.lower() in _UUID_DOC_SUFFIXES:
            tokens.update(_uuid_document_tokens(path.read_text(encoding='utf-8'), path.suffix.lower()))
    expected = {row['path']: row['sha256'] for row in census['inventory'] if '!' not in row['path']}
    changes = {}

    def carries_authentication(value: object) -> bool:
        if isinstance(value, dict):
            return bool(set(value) & {'__rekey', 'signature', 'author_pubkey'}) or any(carries_authentication(child) for child in value.values())
        if isinstance(value, list):
            return any(carries_authentication(child) for child in value)
        if isinstance(value, str):
            for match in _UUID_JSON_STRING.finditer(value):
                try:
                    if json.loads(match.group()) in ('__rekey', 'signature', 'author_pubkey'):
                        return True
                except ValueError:
                    pass  # A prose quote is not necessarily a JSON literal.
            return False
        return False

    for path, label in originals:
        if _sha256(path) != expected[label]:
            raise ValueError('UUID frozen document changed')
        if path.suffix.lower() not in _UUID_DOC_SUFFIXES:
            continue
        text = path.read_text(encoding='utf-8')
        if not _uuid_document_occurrences(text, path.suffix.lower(), tokens):
            continue
        if carries_authentication(_uuid_document_value(text, path.suffix.lower())):
            raise ValueError('UUID document contains original authentication; drop or reattest required')
        pattern = re.compile('|'.join(re.escape(t) for t in sorted(tokens)), re.IGNORECASE)
        # Rewrite JSON string literals separately to cover Unicode-escaped values,
        # preserving every byte outside those strings and JSONL record boundaries.
        def replacement(match):
            try:
                value = json.loads(match.group())
            except ValueError:
                return match.group()
            changed = pattern.sub(_UUID_MARKER, value)
            return json.dumps(changed, ensure_ascii=False) if changed != value else match.group()
        changed = pattern.sub(_UUID_MARKER, _UUID_JSON_STRING.sub(replacement, text))
        if _uuid_document_tokens(changed, path.suffix.lower()) or _uuid_document_occurrences(changed, path.suffix.lower(), tokens):
            raise ValueError('UUID document projection incomplete')
        changes[path.relative_to(source)] = changed
    report = {'schema': 'papercusp-uuid-idempotency-document-redaction-manifest-v1',
              'reviewRef': _UUID_DROP_REVIEW, 'replacement': _UUID_MARKER,
              'authenticationDisposition': 'plaintext-output-only-not-original-row-authentication',
              'redactedDocuments': len(changes), 'occurrenceCount': census['occurrenceCount'],
              'occurrences': census['occurrences']}
    return originals, expected, changes, report


def validate_uuid_document_projection(config_path: Path, source: Path, output: Path,
                                     manifest: Path) -> dict[str, object]:
    if (not source.is_dir() or source.is_symlink() or not output.is_dir() or output.is_symlink()
            or source.resolve() == output.resolve() or manifest.is_symlink()):
        raise ValueError('UUID document validation inputs invalid')
    originals, expected, changes, report = _uuid_document_projection_expectation(config_path, source)
    if json.loads(manifest.read_text()) != report:
        raise ValueError('UUID document manifest does not match frozen occurrence census')
    actual = _uuid_root_files([output])
    if [label for _, label in actual] != [label for _, label in originals]:
        raise ValueError('UUID document output population mismatch')
    for path, label in actual:
        relative = Path(label.split('/', 1)[1])
        digest = hashlib.sha256(changes[relative].encode('utf-8')).hexdigest() if relative in changes else expected[label]
        if path.is_symlink() or _sha256(path) != digest:
            raise ValueError('UUID document output differs from exact projection')
    if census_uuid_artifacts(config_path, [output, manifest])['occurrenceCount']:
        raise ValueError('UUID class remains in projected docs or manifest')
    if [(label, _sha256(path)) for path, label in _uuid_root_files([source])] != [(label, expected[label]) for _, label in originals]:
        raise ValueError('UUID frozen document population changed')
    return report


def project_uuid_document_tree(config_path: Path, source: Path, output: Path, manifest: Path) -> dict[str, object]:
    """New output COPY only. Authenticated rows and archives are never rewritten."""
    if (not source.is_dir() or source.is_symlink() or output.exists() or output.is_symlink()
            or manifest.exists() or manifest.is_symlink()
            or output.resolve().is_relative_to(source.resolve())
            or source.resolve().is_relative_to(output.resolve())
            or manifest.resolve().is_relative_to(source.resolve())
            or manifest.resolve().is_relative_to(output.resolve())):
        raise ValueError('UUID document projection requires distinct fresh outputs')
    originals, expected, changes, report = _uuid_document_projection_expectation(config_path, source)
    # Build outside the frozen input, publish no partial output on a refused scan.
    output.mkdir(mode=0o700)
    manifest_created = False
    try:
        shutil.copytree(source, output, dirs_exist_ok=True)
        for relative, text in changes.items():
            target = output / relative
            target.write_text(text, encoding='utf-8')
        verified = census_uuid_artifacts(config_path, [output])
        if verified['occurrenceCount']:
            raise ValueError('UUID unprojected archive/binary/document remains')
        if [(label, _sha256(path)) for path, label in _uuid_root_files([source])] != [(label, expected[label]) for _, label in originals]:
            raise ValueError('UUID frozen document population changed')
        fd, temporary = tempfile.mkstemp(prefix='.uuid-manifest-', dir=manifest.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                json.dump(report, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.link(temporary, manifest)
            manifest_created = True
        finally:
            os.unlink(temporary)
        validate_uuid_document_projection(config_path, source, output, manifest)
        return report
    except BaseException:
        shutil.rmtree(output)
        # Only remove this call's manifest, never one that won an exclusive-create
        # race. The emitted bytes must still equal our exact safe report.
        if manifest_created and manifest.is_file() and not manifest.is_symlink():
            try:
                if json.loads(manifest.read_text()) == report:
                    manifest.unlink()
            except (OSError, ValueError):
                pass
        raise


@contextlib.contextmanager
def _uuid_source_tar(path: Path):
    """Same zstd/tar readers as the audit, with the producer's status checked."""
    if path.is_symlink() or not path.is_file() or not path.name.endswith('.tar.zst'):
        raise ValueError('UUID source archive requires exact tar.zst input')
    proc = subprocess.Popen(['zstd', '-dc', str(path)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        with tarfile.open(fileobj=proc.stdout, mode='r|') as archive:
            yield archive
        proc.stdout.close()
        if proc.wait() != 0:
            raise ValueError('UUID source archive decompression failed')
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        proc.stdout.close()


def _uuid_source_tar_inventory(path: Path, documents: Path | None = None):
    """Bind EVERY member, including links/modes/PAX, without following links."""
    inventory, seen = [], set()
    with _uuid_source_tar(path) as archive:
        for member in archive:
            parts = member.name.split('/')
            relative = '/'.join(p for p in parts if p not in ('', '.'))
            if (member.name.startswith('/') or '\\' in member.name or '..' in parts
                    or relative in seen or relative == '__member_names__.txt'
                    or not (member.isfile() or member.isdir() or member.issym())):
                # GNU tar's D166 producer dereferences hard links. An older or
                # ambiguous archive must not hide a second plaintext population.
                raise ValueError('UUID source archive member unsupported or ambiguous')
            seen.add(relative)
            meta = {field: getattr(member, field) for field in
                    ('name', 'mode', 'uid', 'gid', 'mtime', 'size', 'linkname', 'uname', 'gname', 'devmajor', 'devminor')}
            meta.update(type=member.type.hex(), pax_headers=dict(member.pax_headers))
            # PAX can encode an ordinary header field (including long names).
            # Bind its semantic value once, while retaining every custom header.
            for key, field in {'path': 'name', 'linkpath': 'linkname', 'size': 'size',
                               'uid': 'uid', 'gid': 'gid', 'mtime': 'mtime',
                               'uname': 'uname', 'gname': 'gname'}.items():
                if key in meta['pax_headers']:
                    value = meta['pax_headers'][key]
                    same = float(value) == meta[field] if field in ('size', 'uid', 'gid', 'mtime') else value == meta[field]
                    if same:
                        del meta['pax_headers'][key]
            digest = None
            if member.isfile():
                stream = archive.extractfile(member)
                if stream is None or not relative:
                    raise ValueError('UUID source archive payload unreadable')
                sha = hashlib.sha256()
                target = None
                if documents is not None and Path(relative).suffix.lower() in _UUID_DOC_SUFFIXES:
                    target_path = documents / relative
                    target_path.parent.mkdir(parents=True, exist_ok=True)
                    target = target_path.open('xb')
                try:
                    for data in iter(lambda: stream.read(1024 * 1024), b''):
                        sha.update(data)
                        if target is not None:
                            target.write(data)
                finally:
                    stream.close()
                    if target is not None:
                        target.close()
                digest = sha.hexdigest()
            inventory.append({'relative': relative, 'metadata': meta, 'sha256': digest})
    if not inventory:
        raise ValueError('UUID source archive empty')
    return inventory


def _uuid_source_archive_expectation(config_path: Path, source: Path, private: Path):
    documents = private / 'documents'
    documents.mkdir(mode=0o700)
    before = _sha256(source)
    inventory = _uuid_source_tar_inventory(source, documents)
    census = census_uuid_artifacts(config_path, [source])
    if any(p.is_file() for p in documents.rglob('*')):
        config, _ = _uuid_census_inputs(config_path)
        bound = private / 'census.private.json'
        bound.write_text(json.dumps({**config, 'documentSources': [*config.get('documentSources', []),
                         {'rootPath': str(documents), 'rootSha256': _uuid_document_root_sha256(documents)}]}))
        bound.chmod(0o600)
        _, _, changes, report = _uuid_document_projection_expectation(bound, documents)
    else:
        changes = {}
        report = {'schema': 'papercusp-uuid-idempotency-document-redaction-manifest-v1',
                  'reviewRef': _UUID_DROP_REVIEW, 'replacement': _UUID_MARKER,
                  'authenticationDisposition': 'plaintext-output-only-not-original-row-authentication',
                  'redactedDocuments': 0, 'occurrenceCount': 0, 'occurrences': []}
    # Anything in a binary, nested archive, link or archive metadata is outside
    # this plaintext copy operation. Refuse it; never remove its member.
    if census['occurrenceCount'] != report['occurrenceCount'] or _sha256(source) != before:
        raise ValueError('UUID source archive contains unprojectable occurrences or changed')
    report = {**report, 'inputPlane': 'selected-source-archive-after-normal-privacy-not-signed-source-proof'}
    if Path('package-lock.json') in changes:
        raise ValueError('UUID projection would change the committed package-lock pin')
    for row in inventory:
        relative = Path(row['relative'])
        if relative in changes:
            data = changes[relative].encode('utf-8')
            row['sha256'] = hashlib.sha256(data).hexdigest()
            row['metadata']['size'] = len(data)
            if 'size' in row['metadata']['pax_headers']:
                row['metadata']['pax_headers']['size'] = str(len(data))
    return inventory, changes, report


def bind_uuid_source_documents(config_path: Path, expected_sha256: str, source: Path, output: Path, documents: Path):
    """Keep the selected source's class-discovery inputs for the final census."""
    if (_sha256(config_path) != expected_sha256 or output.exists() or documents.exists()
            or output.parent.stat().st_mode & 0o077):
        raise ValueError('UUID source document binding requires fresh private inputs')
    config, _ = _uuid_census_inputs(config_path)
    before = _sha256(source)
    documents.mkdir(mode=0o700)
    _uuid_source_tar_inventory(source, documents)
    sources = list(config.get('documentSources', []))
    if any(path.is_file() for path in documents.rglob('*')):
        sources.append({'rootPath': str(documents), 'rootSha256': _uuid_document_root_sha256(documents)})
    if _sha256(source) != before:
        raise ValueError('UUID source document archive changed')
    with output.open('x') as handle:
        os.chmod(output, 0o600)
        json.dump({**config, 'documentSources': sources, 'selectedSourceArchiveSha256': before}, handle)


def validate_uuid_release_artifacts(config_path: Path, expected_sha256: str, run: Path,
                                    roots: list[Path], final: bool = False):
    """Independent projection/count checks plus a census of every supplied leaf."""
    _private_file(config_path)
    if _sha256(config_path) != expected_sha256 or run.is_symlink() or not run.is_dir():
        raise ValueError('UUID release context changed or unavailable')
    pointers = list(run.glob('uuid-document-projection-inputs.*'))
    sources = list(run.glob('uuid-source-inputs.*/projection-inputs.private.json'))
    if len(pointers) != 1 or len(sources) != 1:
        raise ValueError('UUID release projection descriptors incomplete or ambiguous')
    doc_path = Path(pointers[0].read_text().strip())
    for path in (doc_path, sources[0]):
        _private_file(path)
        if not path.resolve().is_relative_to(run.resolve()):
            raise ValueError('UUID release descriptor outside private run')
    docs = json.loads(doc_path.read_text())
    source = json.loads(sources[0].read_text())
    for descriptor in (docs, source):
        if _sha256(Path(descriptor['censusPath'])) != descriptor['censusSha256']:
            raise ValueError('UUID release projection census changed')
        census, _ = _uuid_census_inputs(Path(descriptor['censusPath']))
        if census.get('originalCensusSha256') != expected_sha256:
            raise ValueError('UUID release projection original census mismatch')
    original = Path(source['sourcePath'])
    if _sha256(original) != source['sourceSha256']:
        raise ValueError('UUID selected source archive changed')
    expected_payloads, doc_prefixes = {}, []
    documents_count = 0
    for doc in docs['documentProjections']:
        manifest = Path(doc['manifestPath'])
        if _sha256(manifest) != doc['manifestSha256']:
            raise ValueError('UUID document manifest changed')
        report = validate_uuid_document_projection(Path(docs['censusPath']), Path(doc['sourcePath']),
                                                   Path(doc['outputPath']), manifest)
        documents_count += report['occurrenceCount']
        prefix = doc['relative'] + '/'
        doc_prefixes.append(prefix)
        for path, label in _uuid_root_files([Path(doc['outputPath'])]):
            expected_payloads[prefix + label.split('/', 1)[1]] = _sha256(path)
        expected_payloads[manifest.name] = _sha256(manifest)
    source_manifest = Path(source['manifestPath'])
    if _sha256(source_manifest) != source['manifestSha256']:
        raise ValueError('UUID source manifest changed')
    source_report = validate_uuid_source_archive(Path(source['censusPath']), original,
                                                Path(source['outputPath']), source_manifest)
    expected_payloads['source.tar.zst'] = _sha256(Path(source['outputPath']))
    expected_payloads[source_manifest.name] = _sha256(source_manifest)
    if not final:
        if (len(roots) != 3 or [root.name for root in roots] != ['sidecar', 'resources', 'seed']
                or any(root.is_symlink() or not root.is_dir() for root in roots)
                or Path(source['outputPath']).resolve() != (roots[0] / 'source.tar.zst').resolve()
                or any(Path(doc['outputPath']).resolve() != (roots[0] / doc['relative']).resolve()
                       for doc in docs['documentProjections'])):
            raise ValueError('UUID assembled release roots incomplete or different')
    else:
        if any(root.is_symlink() or not root.is_file() for root in roots):
            raise ValueError('UUID final release requires exact artifact files')
        payload_roots = {root.resolve() for root in roots if not root.name.endswith('.sig')}
        # Reuse the audit's actual installer/archive population. Require exact
        # projected payloads AND manifests in each payload, including copies.
        # ARTIFACTS also includes detached signatures: account for them against
        # an included payload, but keep their bytes in the full class census
        # below. Signature cryptographic verification remains the signing gate.
        for root in roots:
            if root.name.endswith('.sig'):
                parent = root.with_name(root.name[:-4])
                if (parent.resolve() not in payload_roots or parent.is_symlink()
                        or not parent.is_file() or not root.stat().st_size):
                    raise ValueError('UUID final detached signature lacks included payload or is empty')
                continue
            groups = {}
            with _uuid_artifact_population([root]) as population:
                for path, label, digest in population:
                    match = re.search(r'(?:/|!)sidecar/', label)
                    if not match:
                        continue
                    relative = label[match.end():]
                    if '!' in relative:
                        continue  # expanded descendants are censused separately
                    if relative in expected_payloads or any(relative.startswith(prefix) for prefix in doc_prefixes):
                        if path.is_symlink():
                            raise ValueError('UUID final document payload linked')
                        group = groups.setdefault(label[:match.end()], {})
                        if relative in group:
                            raise ValueError('UUID final document population ambiguous')
                        group[relative] = digest
                if not groups or any(group != expected_payloads for group in groups.values()):
                    raise ValueError('UUID final artifact projection payload population mismatch')
    census = census_uuid_artifacts(Path(source['censusPath']), roots)
    if census['occurrenceCount']:
        raise ValueError('UUID class remains in fully staged or final release artifacts')
    return {'reviewRef': _UUID_DROP_REVIEW, 'documentOccurrences': documents_count,
            'sourceOccurrences': source_report['occurrenceCount'], 'remainingOccurrences': 0,
            'artifactLeavesChecked': len(census['inventory']), 'coverage': census['coverage'],
            'releaseRootSelection': 'declared-assembled-roots' if not final else 'requires-independent-final-artifact-set-validation',
            'sourceAuthentication': 'requires-independent-original-core-and-source-signature-validation'}


def validate_uuid_source_archive(config_path: Path, source: Path, output: Path, manifest: Path):
    if source.resolve() == output.resolve() or manifest.is_symlink():
        raise ValueError('UUID source archive validation inputs invalid')
    with tempfile.TemporaryDirectory(prefix='papercusp-uuid-source-') as directory:
        expected, _, report = _uuid_source_archive_expectation(config_path, source, Path(directory))
        if json.loads(manifest.read_text()) != report or _uuid_source_tar_inventory(output) != expected:
            raise ValueError('UUID source archive manifest or exact member population mismatch')
        if census_uuid_artifacts(config_path, [output, manifest])['occurrenceCount']:
            raise ValueError('UUID class remains in source archive output')
        return report


def project_uuid_source_archive(config_path: Path, source: Path, output: Path, manifest: Path):
    """Overlay the exact selected archive into a NEW output; retain every member."""
    if (output.exists() or output.is_symlink() or manifest.exists() or manifest.is_symlink()
            or source.resolve() in (output.resolve(), manifest.resolve())
            or not output.name.endswith('.tar.zst')):
        raise ValueError('UUID source archive requires fresh distinct outputs')
    before = _sha256(source)
    output_created = manifest_created = False
    with tempfile.TemporaryDirectory(prefix='papercusp-uuid-source-') as directory:
        _, changes, report = _uuid_source_archive_expectation(config_path, source, Path(directory))
        try:
            with output.open('xb') as destination:
                output_created = True
                proc = subprocess.Popen(['zstd', '-T0', '-6', '--long=27', '-q', '-c'],
                                        stdin=subprocess.PIPE, stdout=destination, stderr=subprocess.DEVNULL)
                try:
                    with _uuid_source_tar(source) as original, tarfile.open(fileobj=proc.stdin, mode='w|', format=tarfile.PAX_FORMAT) as projected:
                        for member in original:
                            relative = Path('/'.join(p for p in member.name.split('/') if p not in ('', '.')))
                            if relative in changes:
                                data = changes[relative].encode('utf-8')
                                member.size = len(data)
                                if 'size' in member.pax_headers:
                                    member.pax_headers['size'] = str(len(data))
                                projected.addfile(member, io.BytesIO(data))
                            else:
                                projected.addfile(member, original.extractfile(member) if member.isfile() else None)
                    proc.stdin.close()
                    if proc.wait() != 0:
                        raise ValueError('UUID source archive compression failed')
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
                    proc.stdin.close()
            with manifest.open('x') as handle:
                manifest_created = True
                json.dump(report, handle)
            validate_uuid_source_archive(config_path, source, output, manifest)
            if _sha256(source) != before:
                raise ValueError('UUID frozen source archive changed')
            return report
        except BaseException:
            if output_created:
                output.unlink()
            if manifest_created:
                manifest.unlink()
            raise


def _uuid_open_row(row: dict[str, object], pot_id: str, keys: dict[str, object]) -> tuple[object, bool]:
    """Authenticate original stored envelopes with the production length-prefixed AAD."""
    value = row['value']
    if not isinstance(value, dict) or '__rekey' not in value:
        if row.get('epoch') is not None:
            raise ValueError('stamped row without ciphertext')
        return value, False
    if set(value) != {'__rekey'} or type(row.get('epoch')) is not int or row['epoch'] < 0:
        raise ValueError('invalid UUID source envelope')
    author = row.get('author_pubkey')
    if not isinstance(author, str):
        raise ValueError('original author required for AAD')
    key = _canonical_base64(keys[str(row['epoch'])], 32)
    encoded = value['__rekey']
    if not isinstance(encoded, str):
        raise ValueError('invalid UUID ciphertext encoding')
    ciphertext = base64.b64decode(encoded, validate=True)
    if len(ciphertext) < 40 or base64.b64encode(ciphertext).decode() != encoded:
        raise ValueError('invalid UUID ciphertext framing')
    op_id = hashlib.sha256(_uuid_json([row['table'], row['hbKey'], author]).encode()).hexdigest()
    parts = [pot_id.encode(), str(row['epoch']).encode(), op_id.encode()]
    aad = b''.join(len(part).to_bytes(4, 'big') + part for part in parts)
    sodium = _sodium()
    method = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt
    method.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulonglong), ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_ulonglong, ctypes.c_void_p, ctypes.c_ulonglong,
                       ctypes.c_void_p, ctypes.c_void_p]
    method.restype = ctypes.c_int
    output = ctypes.create_string_buffer(len(ciphertext) - 40)
    length = ctypes.c_ulonglong()
    if method(output, ctypes.byref(length), None, ciphertext[24:], len(ciphertext) - 24,
              aad, len(aad), ciphertext[:24], key) != 0:
        raise ValueError('UUID source authentication failed')
    return json.loads(output.raw[:length.value]), True


def _uuid_source_span(source: dict[str, object]) -> None:
    """D-174 exact declared ORIGINAL span. This validates shape/counts, not GO proof."""
    span = source.get('sourceInput')
    if span is None:
        return  # Legacy full-log inputs retain the manifest's full-count guard.
    required = {'coverage', 'sourceHead', 'seedIndex', 'coversUpTo', 'chunkCount',
                'snapshotSetSha256', 'omittedPrefixBlocks', 'sourceBlocksRead',
                'sourceBlocksJsonSha256', 'proofInventorySha256', 'sealedRowOccurrences', 'foldNow', 'winners'}
    if not isinstance(span, dict) or set(span) - {'executionBinding'} != required:
        raise ValueError('UUID original source span incomplete')
    if 'executionBinding' in span:
        binding = span['executionBinding']
        paths = {'packages/operator-core/lib/sync/hyperbee/read-merge.ts',
                 'packages/operator-core/lib/sync/hyperbee/log-snapshot.ts',
                 'packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts',
                 'apps/operator/lib/release/cut-seed-cli.ts'}
        if (not isinstance(binding, dict)
                or set(binding) != {'sourceCommit', 'gitDirty', 'nodeVersion', 'packageLockSha256',
                                    'installedLockSha256', 'dependencyGeneration', 'directBlobs'}
                or not re.fullmatch(r'[0-9a-f]{40}', str(binding['sourceCommit']))
                or binding['gitDirty'] is not False
                or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', str(binding['nodeVersion']))
                or any(not re.fullmatch(r'[0-9a-f]{64}', str(binding[k])) for k in ('packageLockSha256', 'installedLockSha256'))
                or not re.fullmatch(r'v1-[0-9a-f]{64}', str(binding['dependencyGeneration']))
                or not isinstance(binding['directBlobs'], list)
                or len(binding['directBlobs']) != len(paths)
                or any(not isinstance(b, dict) or set(b) != {'path', 'sha256'}
                       or b['path'] not in paths or not re.fullmatch(r'[0-9a-f]{64}', str(b['sha256']))
                       for b in binding['directBlobs'])
                or {b['path'] for b in binding['directBlobs']} != paths):
            raise ValueError('UUID frozen execution binding invalid')
    length = source['sourceLength']
    if (any(type(span.get(k)) is not int or span[k] < 0 for k in
            ('seedIndex', 'coversUpTo', 'chunkCount', 'omittedPrefixBlocks', 'sourceBlocksRead', 'sealedRowOccurrences', 'foldNow'))
            or not 0 <= span['seedIndex'] < length
            or span['coversUpTo'] != span['seedIndex']
            or span['omittedPrefixBlocks'] != span['seedIndex']
            or span['sourceBlocksRead'] != length - span['seedIndex']
            or source.get('sourceBlocksRead') != span['sourceBlocksRead']
            or source.get('sourceBlocksJsonSha256') != span['sourceBlocksJsonSha256']
            or not re.fullmatch(r'[0-9a-f]{64}', str(span['sourceBlocksJsonSha256']))
            or not re.fullmatch(r'[0-9a-f]{64}', str(span['proofInventorySha256']))):
        raise ValueError('UUID original source span block coverage mismatch')
    if span['chunkCount']:
        if (span['coverage'] != 'complete-snapshot-set + tail'
                or span['seedIndex'] + span['chunkCount'] > length
                or not re.fullmatch(r'[0-9a-f]{64}', str(span['snapshotSetSha256']))):
            raise ValueError('UUID original snapshot set binding invalid')
    elif (span['coverage'] != 'full-log' or span['seedIndex'] != 0
          or span['snapshotSetSha256'] is not None):
        raise ValueError('UUID from-zero source coverage invalid')
    head = span['sourceHead']
    if (not isinstance(head, dict)
            or set(head) != {'sourceKeyHex', 'sourceLength', 'fork', 'byteLength', 'treeHash', 'signatureHex'}
            or head['sourceKeyHex'] != source['sourceKeyHex'] or head['sourceLength'] != length
            or any(type(head[k]) is not int or head[k] < 0 for k in ('fork', 'byteLength'))
            or not re.fullmatch(r'[0-9a-f]{64}', str(head['treeHash']))
            or not re.fullmatch(r'(?:[0-9a-f]{2}){64,}', str(head['signatureHex']))
            or not isinstance(span['winners'], list)):
        raise ValueError('UUID signed original head/winner binding invalid')


def _uuid_census_inputs(config_path: Path) -> tuple[dict[str, object], dict[str, object]]:
    _private_file(config_path)
    config = json.loads(config_path.read_text())
    if (config.get('reviewRef') != _UUID_DROP_REVIEW
            or not isinstance(config.get('potId'), str) or not config['potId']
            or not isinstance(config.get('sources'), list) or not config['sources']):
        raise ValueError('UUID census configuration incomplete')
    keys_path = Path(config['epochKeysPath'])
    _private_file(keys_path)
    if _sha256(keys_path) != config['epochKeysSha256']:
        raise ValueError('UUID epoch key binding changed')
    keys = json.loads(keys_path.read_text())[config['potId']]
    seen = set()
    for source in config['sources']:
        key = source.get('sourceKeyHex')
        if (not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key) or key in seen
                or type(source.get('sourceLength')) is not int or source['sourceLength'] <= 0
                or type(source.get('rowCount')) is not int or source['rowCount'] < 0):
            raise ValueError('UUID source census binding invalid')
        seen.add(key)
        _uuid_source_span(source)
        path = Path(source['rowsPath'])
        _private_file(path)
        if _sha256(path) != source['rowsSha256']:
            raise ValueError('UUID source export changed')
        if 'privacyProjectionContext' in source:
            context = source['privacyProjectionContext']
            if (not isinstance(context, dict)
                    or set(context) != {'schema', 'literalsSha256', 'excludedTablesSha256'}
                    or context['schema'] != 'papercusp-seed-privacy-projection-v1'
                    or any(not re.fullmatch(r'[0-9a-f]{64}', str(context[field]))
                           for field in ('literalsSha256', 'excludedTablesSha256'))):
                raise ValueError('UUID privacy projection context invalid')
    if 'sourceManifestPath' in config:
        manifest_path = Path(config['sourceManifestPath'])
        if _sha256(manifest_path) != config['sourceManifestSha256']:
            raise ValueError('UUID source manifest changed')
        manifest = json.loads(manifest_path.read_text())
        stores = [store for store in manifest['stores'] if store['kind'] == 'corestore']
        if len(stores) != 1 or manifest.get('potId') != config['potId']:
            raise ValueError('UUID source manifest coverage invalid')
        meta = stores[0]['meta']
        if manifest.get('schema') == 'papercusp-original-signed-source-span-v1':
            if (manifest.get('sourceSelection') != 'enumerateOwnStoreCoreKeys'
                    or len(seen) != 1 or set(meta.get('sourceHeads', {})) != seen
                    or any(meta['sourceHeads'].get(s['sourceKeyHex']) != s.get('sourceInput', {}).get('sourceHead')
                           for s in config['sources'])):
                raise ValueError('UUID original source selected-head coverage mismatch')
        if (set(meta['coreKeys']) != seen or len(meta['coreKeys']) != len(seen)
                or any(meta['coreLengths'][s['sourceKeyHex']] != s['sourceLength']
                       or s.get('sourceBlocksRead') != s['sourceLength'] - s.get('sourceInput', {}).get('seedIndex', 0)
                       for s in config['sources'])):
            raise ValueError('UUID source core/block coverage incomplete')
    # The exporter must enumerate the actual signed core/snapshot population.
    # A supplied export is not, by itself, proof that every source core was read.
    return config, keys


def _uuid_source_rows(source: dict[str, object]):
    count = 0
    row_ids = set()
    declared = source.get('sourceInput', {}).get('winners')
    winners = []
    with Path(source['rowsPath']).open() as handle:
        for count, text in enumerate(handle, 1):
            row = json.loads(text)
            if (not isinstance(row, dict) or not isinstance(row.get('table'), str) or not row['table']
                    or not isinstance(row.get('hbKey'), str) or not row['hbKey'] or 'value' not in row
                    or not re.fullmatch(r'segment-[0-9]{6}\.(?:blob|log)', str(row.get('segment')))
                    or type(row.get('line')) is not int or row['line'] <= 0):
                raise ValueError('UUID source row/locator invalid')
            identity = (row['table'], row['hbKey'])
            if identity in row_ids:
                raise ValueError('UUID source export must contain each winning row once')
            row_ids.add(identity)
            winners.append({'table': row['table'], 'hbKey': row['hbKey'],
                            'disposition': row.get('privacyProjection', {'disposition': 'carry'}).get('disposition')})
            if 'privacyProjection' in row and 'privacyProjectionContext' not in source:
                raise ValueError('UUID privacy projection context missing')
            yield row
    if count != source['rowCount'] or _sha256(Path(source['rowsPath'])) != source['rowsSha256']:
        raise ValueError('UUID source export incomplete or changed')
    if declared is not None and winners != declared:
        raise ValueError('UUID original census winner/disposition coverage mismatch')


def _uuid_privacy_projection(row: dict[str, object], authenticated: bool) -> tuple[str, object]:
    """Private, source-hash-bound expectation from the maintained TS privacy fold.

    GO must independently reproduce that export with the exact release literal set.
    This never authorizes a changed encrypted value to claim its original AEAD.
    """
    projection = row.get('privacyProjection', {'disposition': 'carry'})
    if not isinstance(projection, dict):
        raise ValueError('UUID privacy projection invalid')
    disposition = projection.get('disposition')
    if disposition in ('carry', 'drop') and set(projection) == {'disposition'}:
        return disposition, row['value']
    if disposition == 'redact' and set(projection) == {'disposition', 'value'}:
        if authenticated or row.get('epoch') is not None:
            raise ValueError('UUID privacy projection cannot retain changed original authentication')
        if projection['value'] == row['value']:
            raise ValueError('UUID privacy projection redaction unchanged')
        return disposition, projection['value']
    raise ValueError('UUID privacy projection invalid')


def assemble_uuid_idempotency_drop_plans(config_path: Path) -> dict[str, object]:
    """Re-derive an entire supplied authenticated row population, independent of gitleaks hits.

    This is source-AEAD and plan evidence, not source-signature/coverage or GO evidence.
    Final admission requires an independently enumerated actual Hypercore export.
    """
    config, keys = _uuid_census_inputs(config_path)
    # A supplied frozen document population extends class discovery, not source
    # signature authority. Mirrors across input planes must use one token union.
    tokens = _uuid_document_source_tokens(config)
    original = encrypted = 0
    for source in config['sources']:
        for row in _uuid_source_rows(source):
            plain, authenticated = _uuid_open_row(row, config['potId'], keys)
            original += 1
            encrypted += int(authenticated)
            _uuid_privacy_projection(row, authenticated)
            tokens.update(_uuid_class_tokens(plain))
            tokens.update(_uuid_class_tokens({field: row[field] for field in ('table', 'hbKey', 'author_pubkey') if field in row}))
    spans = [source['sourceInput'] for source in config['sources'] if 'sourceInput' in source]
    unopened = sum(span['sealedRowOccurrences'] for span in spans) - encrypted
    if spans and (len(spans) != len(config['sources']) or unopened < 0):
        raise ValueError('UUID proof/AEAD census accounting incomplete')
    plans = []
    locators = set()
    dropped = encrypted_dropped = privacy_dropped = privacy_auth_dropped = privacy_redacted = 0
    for source in config['sources']:
        rows = []
        for row in _uuid_source_rows(source):
            plain, authenticated = _uuid_open_row(row, config['potId'], keys)
            paths = _uuid_occurrences(plain, tokens)
            paths += _uuid_occurrences({field: row[field] for field in ('table', 'hbKey', 'author_pubkey') if field in row},
                                       tokens, ['<row-header>'])
            if not paths:
                disposition, _ = _uuid_privacy_projection(row, authenticated)
                privacy_dropped += int(disposition == 'drop')
                privacy_auth_dropped += int(disposition == 'drop' and authenticated)
                privacy_redacted += int(disposition == 'redact')
                continue
            occurrences = [{'segment': row['segment'], 'line': row['line'], 'fieldPath': path} for path in paths]
            for occurrence in occurrences:
                identity = _uuid_json(occurrence)
                if not occurrence['fieldPath'] or identity in locators:
                    raise ValueError('UUID occurrence locator missing or duplicated')
                locators.add(identity)
            # Exporters may supply JSON.stringify(value), preserving JS number encoding.
            stored = row.get('storedValueJson', _uuid_json(row['value']))
            if not isinstance(stored, str) or json.loads(stored) != row['value']:
                raise ValueError('UUID stored value serialization changed')
            rows.append({'table': row['table'], 'hbKey': row['hbKey'],
                         'valueSha256': hashlib.sha256(stored.encode()).hexdigest(), 'occurrences': occurrences})
            dropped += 1
            encrypted_dropped += int(authenticated)
        if rows or 'sourceInput' in source:
            plans.append({'schema': _UUID_DROP_SCHEMA, 'reviewRef': _UUID_DROP_REVIEW,
                          'sourceKeyHex': source['sourceKeyHex'], 'sourceLength': source['sourceLength'], 'rows': rows,
                          **({'sourceInput': source['sourceInput']} if 'sourceInput' in source else {})})
    # All counters refer to source rows; a dropped ciphertext is never claimed as shipped auth.
    return {'schema': _UUID_DROP_SET_SCHEMA, 'reviewRef': _UUID_DROP_REVIEW, 'plans': plans,
            **({'sourceCoverage': [{'coverage': span['coverage'], 'omittedPrefixBlocks': span['omittedPrefixBlocks'],
                                   'sourceBlocksRead': span['sourceBlocksRead'], 'sourceLength': source['sourceLength']}
                                  for source, span in zip(config['sources'], spans)],
                'spanAuthenticationCounts': {'proofVerifiedBlocks': sum(s['sourceBlocksRead'] for s in spans),
                                             'aeadOpenedWinningRows': encrypted,
                                             # Occurrences omitted by supersession, table exclusion, or tombstone GC.
                                             'unopenedNonWinningSealedRowOccurrences': unopened}}
               if spans else {}),
            'privateSourceBindings': {'configSha256': _sha256(config_path),
                                     'sources': config['sources'], 'epochKeysSha256': config['epochKeysSha256']},
            'sourceAuthentication': 'original-envelope-aead',
            'sourceSignatureAndCoverage': 'requires-independent-hypercore-export-validation',
            'sourcePrivacyProjection': 'requires-independent-shared-projection-validation',
            'counts': {'originalRows': original, 'originalAuthenticated': encrypted,
                       'originalPlaintext': original - encrypted, 'droppedRows': dropped,
                       'droppedAuthenticated': encrypted_dropped,
                       'privacyDroppedRows': privacy_dropped, 'privacyDroppedAuthenticated': privacy_auth_dropped,
                       'privacyRedactedPlaintext': privacy_redacted,
                       'authenticatedOriginalRetained': encrypted - encrypted_dropped - privacy_auth_dropped,
                       'redactedReattested': 0, 'occurrenceCount': len(locators)}}


def validate_uuid_idempotency_row_drops(config_path: Path, plan_set: dict[str, object],
                                      output_sources: list[dict[str, object]],
                                      reports: list[dict[str, object]],
                                      artifact_inputs: list[Path], *,
                                      artifact_roots: list[Path] | None = None) -> dict[str, object]:
    """Independently authenticate retained output and compare the complete source/drop partition.

    Source/output exports must be independently bound to the actual candidate by the caller.
    No gitleaks exemptions or segment clearances are produced.
    """
    expected = assemble_uuid_idempotency_drop_plans(config_path)
    if expected != plan_set or not artifact_inputs:
        raise ValueError('UUID plan census changed or artifact coverage missing')
    config, keys = _uuid_census_inputs(config_path)
    by_key = {entry['sourceKeyHex']: entry for entry in output_sources}
    if len(by_key) != len(output_sources) or set(by_key) != {s['sourceKeyHex'] for s in config['sources']}:
        raise ValueError('UUID output core coverage mismatch')
    dropped = {(p['sourceKeyHex'], r['table'], r['hbKey']) for p in expected['plans'] for r in p['rows']}
    tokens = set()
    originals = {}
    privacy_dropped = set()
    for source in config['sources']:
        for row in _uuid_source_rows(source):
            plain, authenticated = _uuid_open_row(row, config['potId'], keys)
            tokens.update(_uuid_class_tokens(plain))
            tokens.update(_uuid_class_tokens({field: row[field] for field in ('table', 'hbKey', 'author_pubkey') if field in row}))
            identity = (source['sourceKeyHex'], row['table'], row['hbKey'])
            disposition, value = _uuid_privacy_projection(row, authenticated)
            originals[identity] = {**row, 'value': value}
            if disposition == 'drop':
                privacy_dropped.add(identity)
    retained_auth = 0
    for key, source in by_key.items():
        path = Path(source['rowsPath'])
        _private_file(path)
        if _sha256(path) != source['rowsSha256']:
            raise ValueError('UUID output export changed')
        remaining = {identity for identity in originals if identity[0] == key} - dropped - privacy_dropped
        for row in _uuid_source_rows(source):
            identity = (key, row['table'], row['hbKey'])
            if identity not in remaining:
                raise ValueError('dropped or extra UUID output row')
            original = originals[identity]
            content = lambda entry: {k: v for k, v in entry.items()
                                     if k not in ('segment', 'line', 'storedValueJson', 'privacyProjection')}
            if content(row) != content(original):
                raise ValueError('UUID output changed original authentication')
            plain, authenticated = _uuid_open_row(row, config['potId'], keys)
            headers = {field: row[field] for field in ('table', 'hbKey', 'author_pubkey') if field in row}
            if (_uuid_class_tokens(plain) or _uuid_occurrences(plain, tokens)
                    or _uuid_class_tokens(headers) or _uuid_occurrences(headers, tokens)):
                raise ValueError('UUID class remains in output')
            retained_auth += int(authenticated)
            remaining.remove(identity)
        if remaining:
            raise ValueError('UUID output omitted unrelated source rows')
    expected_reports = [{'schema': 'papercusp-uuid-idempotency-redaction-manifest-v1',
                         'reviewRef': _UUID_DROP_REVIEW, 'replacement': _UUID_MARKER,
                         'authenticationDisposition': 'dropped',
                         'ciphertextAuthentication': 'requires-independent-candidate-validation',
                         'droppedRows': len(plan['rows']),
                         'occurrenceCount': sum(len(row['occurrences']) for row in plan['rows']),
                         'occurrences': [o for row in plan['rows'] for o in row['occurrences']]}
                        for plan in expected['plans']]
    if reports != expected_reports or retained_auth != expected['counts']['authenticatedOriginalRetained']:
        raise ValueError('UUID public manifest or authentication accounting mismatch')
    coverage = 'supplied-file-list-only'
    if artifact_roots is not None:
        population = _uuid_root_files(artifact_roots)
        if (len(set(artifact_inputs)) != len(artifact_inputs)
                or {p.absolute() for p in artifact_inputs} != {p.absolute() for p, _ in population}):
            raise ValueError('UUID supplied artifact inventory omits or adds shipped files')
        census = census_uuid_artifacts(config_path, artifact_roots)
        if census['occurrenceCount']:
            raise ValueError('UUID class remains in expanded shipped population')
        return {'reviewRef': _UUID_DROP_REVIEW, 'counts': expected['counts'], 'rawClassHits': 0,
                'artifacts': census['inventory'], 'artifactCoverage': census['coverage'],
                'candidateBinding': 'requires-independent-actual-artifact-validation'}
    inventory = []
    for path in artifact_inputs:
        if path.is_symlink() or not path.is_file():
            raise ValueError('UUID shipped artifact input invalid')
        before = _sha256(path)
        # mmap keeps arbitrarily spaced field/value pairs visible without a fixed overlap gap.
        if path.stat().st_size:
            with path.open('rb') as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
                if re.search(_UUID_NAMED_TEXT.pattern.encode(), data):
                    raise ValueError('UUID named class remains in shipped artifact')
        if path.suffix in ('.json', '.jsonl'):
            with path.open() as handle:
                rows = (json.loads(line) for line in handle) if path.suffix == '.jsonl' else [json.load(handle)]
                for value in rows:
                    if _uuid_class_tokens(value) or _uuid_occurrences(value, tokens):
                        raise ValueError('UUID encoded class remains in shipped artifact')
        # Known-value mirrors crossing chunk boundaries; no scan-report allowlist.
        tail = b''
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                text = (tail + chunk).decode('utf-8', errors='replace')
                if _uuid_class_tokens(text) or _uuid_occurrences(text, tokens):
                    raise ValueError('UUID class remains in shipped artifact')
                tail = (tail + chunk)[-256:]
        if _sha256(path) != before:
            raise ValueError('UUID shipped artifact changed')
        inventory.append({'path': str(path), 'sha256': before})
    return {'reviewRef': _UUID_DROP_REVIEW, 'counts': expected['counts'], 'rawClassHits': 0,
            'artifacts': inventory, 'artifactCoverage': coverage,
            'candidateBinding': 'requires-independent-actual-artifact-validation'}


def _classification(summary: dict[str, object], entries: list[dict[str, object]],
                    allowed: set[str]) -> set[str]:
    if (summary.get("unclassifiedLocators") != [] or not entries
            or summary.get("findings") != len(entries)
            or dict(Counter(row.get("class") for row in entries)) != summary.get("classes")
            or not set(summary["classes"]).issubset(allowed)):
        raise ValueError("incomplete classification")
    for row in entries:
        if (not isinstance(row.get("rule"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", str(row.get("digest", "")))):
            raise ValueError("invalid finding digest")
    return {str(row["digest"]) for row in entries}


def validate_seed_proof(proof: dict[str, object], directory: Path, root: Path,
                        config: Path, *, issue_twin: dict[str, object] | None = None,
                        identity_context: dict[str, object] | None = None) -> set[str]:
    """Validate an explicitly reviewed, private, exact-source evidence package.

    This does not infer publicness from a field name or grant new classifications.
    The review reference and digest-only classifications are authored evidence;
    authentication, scan results and all source inputs must remain bound to it.
    """
    if (proof.get("schemaVersion") != _PROOF_SCHEMA
            or not isinstance(proof.get("reviewRef"), str) or not proof["reviewRef"].strip()
            or proof.get("configSha256") != _sha256(config)):
        raise ValueError("proof identity mismatch")
    if "occurrenceScope" in proof and issue_twin is None:
        raise ValueError("occurrence proof cannot clear a segment")
    if issue_twin is not None and (
            proof.get("reviewRef") != "p2p-public-release-endgame-2026-09-01#D-165"
            or proof.get("toolingSha256") != _sha256(Path(__file__))
            or not isinstance(proof.get("occurrenceScope"), dict)
            or not identity_context or identity_context.get("identityScanValidated") is not True
            or not identity_context.get("identityRecipients")):
        raise ValueError("scoped issue twin identity proof required")
    version = subprocess.run(["gitleaks", "version"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
    if proof.get("scannerVersion") != version:
        raise ValueError("scanner changed")
    source = _source_file(root, proof["file"])
    if (proof.get("sourceSha256") != _sha256(source)
            or proof.get("epochKeysSha256") != _sha256(_source_file(root, "epoch-keys.json"))
            or proof.get("manifestSha256") != _sha256(_source_file(root, "manifest.json"))):
        raise ValueError("seed changed")
    evidence = {}
    for name in _PROOF_FILES:
        if name not in _BASE_PROOF_FILES and name not in proof.get("evidence", {}):
            continue
        path = directory / name
        _private_file(path)
        if proof.get("evidence", {}).get(name) != _sha256(path):
            raise ValueError("evidence changed")
        if name.endswith(".json"):
            evidence[name] = json.loads(path.read_text(encoding="utf-8"))
    auth = evidence["ciphertext-auth-safe.json"]
    fields = auth.get("ciphertextFields")
    if (type(fields) is not int or fields <= 0 or auth.get("parsedRows") != fields
            or auth.get("classes") != {"authenticated_ciphertext": fields}
            or auth.get("unparsedCiphertextFields") != 0
            or auth.get("negativeControls") != {"tamper_rejected": True, "wrong_key_rejected": True}):
        raise ValueError("cipher authentication incomplete")
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    verify_literal_absence([directory / "seed-000080.plaintext.jsonl"],
                          evidence["forbidden-literals.private.json"],
                          _REQUIRED_FORBIDDEN_DIGESTS if manifest.get("potId") == "papercusp" else set())
    plain = evidence["plaintext-classification-safe.json"]
    plain_entries = evidence["plaintext-exact-finding-digests.json"]
    plain_allowed = (_classification(plain, plain_entries, _PLAIN_CLASSES)
                     if issue_twin is None else None)
    plain_meta = evidence["seed-000080.plaintext.private.meta.json"]
    plain_identity = {"blobSha256": _sha256(directory / "seed-000080.plaintext.jsonl"),
                      "configSha256": proof["configSha256"], "scannerVersion": version}
    plain_report = evidence["seed-000080.plaintext.private.json"]
    if (plain_meta.get("identity") != plain_identity or plain_meta.get("scannerExit") not in (0, 1)
            or plain.get("plaintextSha256") != plain_identity["blobSha256"]
            or plain_meta.get("reportSha256") != _sha256(directory / "seed-000080.plaintext.private.json")
            or plain_meta.get("findings") != len(plain_report)
            or len(plain_entries) != len(plain_report)
            or (issue_twin is None
                and {finding_digest(row) for row in plain_report} != plain_allowed)):
        raise ValueError("plaintext scan incomplete")
    if issue_twin is not None:
        scope = proof["occurrenceScope"]
        plaintext = directory / "seed-000080.plaintext.jsonl"
        if (scope.get("kind") != "public-issue-id-twin"
                or scope.get("fieldPath") != ["issue_id"]
                or scope.get("line") != issue_twin.get("line")
                or type(scope.get("line")) is not int or scope["line"] < 1
                or scope.get("rowSha256") != issue_twin.get("rowSha256")
                or issue_twin.get("fieldPath") != ["issue_id"]
                or issue_twin.get("plaintextSha256") != plain_identity["blobSha256"]
                or auth.get("sourceSha256") != proof["sourceSha256"]
                or plain.get("findings") != len(plain_report)
                or type(scope.get("remainingPlaintextFindings")) is not int
                or scope.get("remainingPlaintextFindings") != len(plain_report)
                or dict(Counter(row.get("class") for row in plain_entries)) != plain.get("classes")
                or Counter((row.get("digest"), row.get("rule")) for row in plain_entries)
                != Counter((finding_digest(row), row.get("RuleID")) for row in plain_report)):
            raise ValueError("scoped issue twin binding or residue mismatch")
        row = None
        row_count = 0
        with plaintext.open() as handle:
            for row_count, text in enumerate(handle, 1):
                parsed = json.loads(text)
                if row_count == scope["line"]:
                    if hashlib.sha256(text.encode()).hexdigest() != scope["rowSha256"]:
                        raise ValueError("scoped issue twin row changed")
                    row = parsed
        if row_count != fields:
            raise ValueError("scoped issue twin authentication row count mismatch")
        value = row.get("issue_id") if isinstance(row, dict) else None
        if not isinstance(value, str) or re.fullmatch(r"EI-[0-9]+", value) is None:
            raise ValueError("scoped complete public issue id required")
        spans = [{"byteStart": 0, "byteEnd": len(value.encode()),
                  "sha256": hashlib.sha256(value.encode()).hexdigest()}]
        measured = scan_quoted_token_remainder(
            value, spans, identity_context["identityRecipients"], config,
            identity_context.get("credentialDigests", set()))
        if scope.get("tokenScan") != measured:
            raise ValueError("scoped issue twin token scan mismatch")
        # T1 evidence only: not a single seed or plaintext finding is cleared
        # here. Their full report remains bound and its residue is reported.
        return set()
    seed = evidence["seed-classification-verified-safe.json"]
    entries = evidence["seed-exact-finding-digests.json"]
    allowed = _classification(seed, entries, _SEED_CLASSES)
    report = evidence["seed-000080.private.json"]
    meta = evidence["seed-000080.private.meta.json"]
    identity = {"blobSha256": proof["sourceSha256"], "configSha256": proof["configSha256"],
                "scannerVersion": version}
    if (meta.get("identity") != identity or meta.get("scannerExit") not in (0, 1)
            or meta.get("findings") != len(report) or len(entries) != len(report)
            or seed.get("sourceSha256") != proof["sourceSha256"]
            or seed.get("plaintextProofSha256") != _sha256(directory / "plaintext-classification-safe.json")
            or {finding_digest(row) for row in report} != allowed):
        raise ValueError("seed scan incomplete")
    if (any(row["class"] in _MECHANICAL_SEED_CLASSES for row in entries)
            or any(row["class"] in _MECHANICAL_PLAIN_CLASSES for row in plain_entries)):
        context = _mechanical_context(proof, directory, root, source, entries, report, plain_report)
        _validate_mechanical_entries(entries, report, context, seed=True)
        _validate_mechanical_entries(plain_entries, plain_report, context, seed=False)
        if any(row["class"] == "public-non-bearer-field-reference" for row in plain_entries):
            if plain.get("nonBearerFields") != {"listedNames": sorted(_NON_BEARER_FIELDS),
                                              "admitted": context["nonBearerCounts"]}:
                raise ValueError("closed non-bearer admission census mismatch")
    return allowed


def assemble_seed_proof(directory: Path, root: Path, config: Path, relative: str,
                        review_ref: str, *, issue_twin: dict[str, object] | None = None,
                        identity_context: dict[str, object] | None = None) -> dict[str, object]:
    meta = json.loads((directory / "seed-000080.private.meta.json").read_text())
    proof = {"schemaVersion": _PROOF_SCHEMA, "reviewRef": review_ref, "file": relative,
             "sourceSha256": _sha256(_source_file(root, relative)),
             "epochKeysSha256": _sha256(root / "epoch-keys.json"),
             "manifestSha256": _sha256(root / "manifest.json"),
             "configSha256": _sha256(config), "scannerVersion": meta["identity"]["scannerVersion"],
             "evidence": {name: _sha256(directory / name) for name in _PROOF_FILES
                          if name in _BASE_PROOF_FILES or (directory / name).exists()}}
    if issue_twin is not None:
        proof["toolingSha256"] = _sha256(Path(__file__))
        proof["occurrenceScope"] = issue_twin["occurrenceScope"]
    validate_seed_proof(proof, directory, root, config,
                        issue_twin=issue_twin, identity_context=identity_context)
    path = directory / "seed-finding-proof.json"
    fd, temporary = tempfile.mkstemp(prefix="seed-proof-", suffix=".partial", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(proof, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    return proof


def filter_seed_findings(report_path: Path, root: Path, proof_path: Path,
                         config: Path) -> dict[str, int]:
    _private_file(report_path)
    allowances = seed_proof_allowances(proof_path, root, config)
    findings = json.loads(report_path.read_text(encoding="utf-8"))
    residual = []
    for finding in findings:
        file = Path(str(finding.get("File", "")))
        candidate = file if file.is_absolute() else Path.cwd() / file
        try:
            relative = candidate.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            relative = ""
        if relative in allowances and finding_digest(finding) in allowances[relative]:
            continue
        residual.append({**finding, "Match": "REDACTED", "Secret": "REDACTED"})
    # Keep the original exact scan private for independent review. The normal
    # failure formatter sees only residual, redacted findings at its usual path.
    os.replace(report_path, report_path.with_suffix(".private.json"))
    fd, temporary = tempfile.mkstemp(prefix="seed-residual-", suffix=".partial", dir=report_path.parent)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(residual, handle)
    os.replace(temporary, report_path)
    return {"findings": len(findings), "exempted": len(findings) - len(residual), "remaining": len(residual)}


def seed_proof_allowances(proof_path: Path, root: Path,
                          config: Path) -> dict[str, set[str]]:
    """Compose reviewed per-file proofs without broadening any file's allowance.

    The directory scan can find ciphertext in multiple storage segments. Each
    segment needs its own source-bound authentication and plaintext proof; a
    digest approved in one segment never grants an exception in another.
    """
    _private_file(proof_path)
    proof = json.loads(proof_path.read_text(encoding="utf-8"))
    if "proofs" not in proof:
        return {proof["file"]: validate_seed_proof(proof, proof_path.parent, root, config)}
    if (proof.get("schemaVersion") != _PROOF_SCHEMA
            or not isinstance(proof.get("reviewRef"), str) or not proof["reviewRef"].strip()
            or not isinstance(proof["proofs"], list) or not proof["proofs"]):
        raise ValueError("invalid proof collection")
    allowances = {}
    for entry in proof["proofs"]:
        child = _source_file(proof_path.parent, entry["path"])
        _private_file(child)
        if entry.get("sha256") != _sha256(child):
            raise ValueError("segment proof changed")
        segment = json.loads(child.read_text(encoding="utf-8"))
        if "proofs" in segment or segment.get("file") in allowances:
            raise ValueError("nested or duplicate segment proof")
        allowances[segment["file"]] = validate_seed_proof(segment, child.parent, root, config)
    return allowances


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scan_quoted_token_remainder(text: str, spans: list[dict[str, object]],
                                recipients: set[bytes], config: Path,
                                credential_digests: set[str]) -> dict[str, object]:
    """D-157 T3/T4 only; this scan does not establish a twin or maker proof.

    Offsets address UTF-8 bytes. Each span must cover a complete maximal token;
    masking preserves every other byte, including adjacent credential text.
    The caller must separately validate T1/T2 (and D-158 for metadata twins).
    """
    if not isinstance(text, str) or not spans or not recipients:
        raise ValueError("complete quoted token scan inputs required")
    original = text.encode()
    masked = bytearray(original)
    token_proofs = []
    previous_end = 0
    token_character = re.compile(rb"[A-Za-z0-9_-]")
    for span in spans:
        start, end = span.get("byteStart"), span.get("byteEnd")
        if (type(start) is not int or type(end) is not int
                or not 0 <= previous_end <= start < end <= len(original)):
            raise ValueError("invalid or overlapping quoted token offsets")
        token = original[start:end]
        if (not re.fullmatch(rb"[A-Za-z0-9_-]+", token)
                or start > 0 and token_character.fullmatch(original[start - 1:start])
                or end < len(original) and token_character.fullmatch(original[end:end + 1])
                or hashlib.sha256(token).hexdigest() != span.get("sha256")):
            raise ValueError("quoted token is not an exact maximal match")
        if token.decode() in credential_digests:
            raise ValueError("credential digest requires the direct E3 route")
        key_scan = scan_secret_key_bytes(token, recipients)
        if any(key_scan[key] for key in ("realFindings", "derivationMatches", "rawSkMatches")):
            raise ValueError("quoted token secret-key scan refused")
        masked[start:end] = b" " * len(token)
        token_proofs.append({"byteStart": start, "byteEnd": end,
                             "sha256": span["sha256"], "keyScan": key_scan})
        previous_end = end
    remainder = bytes(masked)
    key_scan = scan_secret_key_bytes(remainder, recipients)
    digest_scan = scan_credential_digest_bytes(original, credential_digests)
    if (any(key_scan[key] for key in ("realFindings", "derivationMatches", "rawSkMatches"))
            or any(digest_scan.values())):
        raise ValueError("quoted token containing string secret scan refused")
    with tempfile.TemporaryDirectory(prefix="quoted-token-scan-") as temporary:
        directory = Path(temporary)
        source = directory / "remainder.txt"
        source.write_bytes(remainder)
        source.chmod(0o600)
        report = directory / "remainder.private.json"
        findings, _ = scan_seed_report(report, source, config)
        metadata = json.loads(report.with_suffix(".meta.json").read_text())
        if findings:
            raise ValueError("quoted token remainder scan refused")
    return {"schema": "papercusp-quoted-token-remainder-v1",
            "sourceSha256": hashlib.sha256(original).hexdigest(),
            "remainderSha256": hashlib.sha256(remainder).hexdigest(),
            "tokens": token_proofs, "remainderKeyScan": key_scan,
            "credentialDigestScan": digest_scan, "gitleaks": metadata["identity"],
            "remainderFindings": 0}


def scan_seed_report(report: Path, blob: Path, config: Path) -> tuple[list[object], bool]:
    """Retain an identity-bound private scan BEFORE starting classification.

    Reuse requires both input identities and the saved report digest. Scanner
    errors and changed inputs fail closed. A killed scanner leaves its private
    partial report; a killed classifier leaves the completed reusable report.
    """
    directory = report.parent
    if not directory.is_dir() or directory.is_symlink() or directory.stat().st_mode & 0o077:
        raise ValueError("report directory must already be private")
    meta = report.with_suffix(".meta.json")
    if report.is_symlink() or meta.is_symlink():
        raise ValueError("report symlink")
    version = subprocess.run(["gitleaks", "version"], check=True,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode().strip()
    identity = {"blobSha256": _sha256(blob), "configSha256": _sha256(config),
                "scannerVersion": version}
    if report.exists() and meta.exists():
        try:
            saved = json.loads(meta.read_text(encoding="utf-8"))
            if (saved.get("identity") == identity and saved.get("scannerExit") in (0, 1)
                    and saved.get("reportSha256") == _sha256(report)):
                findings = json.loads(report.read_text(encoding="utf-8"))
                if isinstance(findings, list) and len(findings) == saved.get("findings"):
                    return findings, True
        except (OSError, UnicodeError, ValueError, AttributeError):
            pass
    fd, name = tempfile.mkstemp(prefix="seed-scan-", suffix=".partial", dir=directory)
    os.close(fd)
    partial = Path(name)
    result = subprocess.run(["gitleaks", "dir", str(blob), "--config", str(config),
                             "--no-banner", "--log-level=error", "--redact=0",
                             "--report-format=json", "--report-path", str(partial)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode not in (0, 1):
        raise ValueError("scanner failed")
    findings = json.loads(partial.read_text(encoding="utf-8"))
    if not isinstance(findings, list):
        raise ValueError("report shape")
    if identity["blobSha256"] != _sha256(blob) or identity["configSha256"] != _sha256(config):
        raise ValueError("scan input changed")
    report_digest = _sha256(partial)
    os.replace(partial, report)
    report.chmod(0o600)
    fd, name = tempfile.mkstemp(prefix="seed-scan-meta-", suffix=".partial", dir=directory)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"identity": identity, "scannerExit": result.returncode,
                   "findings": len(findings), "reportSha256": report_digest}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(name, meta)
    return findings, False


def _seed_field_kind(field: str, value: bytes) -> str:
    if field == "__rekey":
        try:
            decoded = base64.b64decode(value, validate=True)
            if len(decoded) >= 40 and base64.b64encode(decoded) == value:
                return "ciphertext-envelope-framing"
        except ValueError:
            pass
    elif field == "hbKey" and _MESSAGE_ID.fullmatch(value):
        return "public-message-id"
    elif field == "writer_key":
        if value.startswith(b"su-") and _UUID.fullmatch(value[3:]):
            return "public-agent-id"
        if _UUID.fullmatch(value):
            return "public-session-id"
    return "unclassified"


def classify_seed_findings(blob_path: Path, findings: list[object]) -> dict[str, object]:
    """Diagnostic only: classify exact fields, never grant a release exception.

    A raw private report is required. Values stay in memory; the result contains
    only constant class names, offsets and counts. Index the source ONCE instead
    of searching a hundreds-of-MB blob once per finding. Only fragmented field
    names need a source search, cached by match digest for repeated findings.
    Canonical ciphertext framing is not a claim of cryptographic authentication.
    """
    counts: Counter[str] = Counter()
    residuals: list[dict[str, object]] = []
    searches = 0
    with blob_path.open("rb") as handle:
        if blob_path.stat().st_size == 0:
            return {"findings": len(findings), "classes": {"unclassified": len(findings)},
                    "indexPasses": 1, "fullBlobSearches": 0, "residuals": []}
        with mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as source:
            index: dict[tuple[str, bytes], str] = {}
            for match in _SEED_FIELDS.finditer(source):
                field = match.group("field").decode("ascii")
                value = match.group("value")
                index[(field, hashlib.sha256(value).digest())] = _seed_field_kind(field, value)
            fragments: dict[bytes, tuple[str, int]] = {}
            for finding in findings:
                if not isinstance(finding, dict) or finding.get("RuleID") != "generic-api-key":
                    counts["unclassified"] += 1
                    continue
                secret, text = finding.get("Secret"), finding.get("Match")
                if not isinstance(secret, str) or not isinstance(text, str) or secret == "REDACTED":
                    counts["unclassified"] += 1
                    continue
                field_match = _MATCH_FIELD.match(text)
                field = field_match.group(1) if field_match else ""
                digest = hashlib.sha256(secret.encode()).digest()
                kind = index.get((field, digest), "unclassified")
                if field not in {"__rekey", "hbKey", "writer_key"}:
                    # The scanner can split in the middle of a serialized field
                    # name. Recover context only for suffixes of our known fields.
                    if field and any(name.endswith(field) for name in ("__rekey", "hbKey", "writer_key")):
                        encoded = text.encode()
                        match_digest = hashlib.sha256(encoded).digest()
                        if match_digest not in fragments:
                            searches += 1
                            offset = source.find(encoded)
                            original = ""
                            if offset >= 0:
                                before = source[max(0, offset - 80):offset] + field.encode()
                                complete = re.search(rb'"(__rekey|hbKey|writer_key)$', before)
                                if complete:
                                    original = complete.group(1).decode("ascii")
                            fragments[match_digest] = (original, offset)
                        original, offset = fragments[match_digest]
                        kind = index.get((original, digest), "unclassified")
                        if len(residuals) < MAX_LOCATORS:
                            residuals.append({"originalField": original or "unclassified",
                                              "offset": offset, "class": kind})
                counts[kind] += 1
    return {"findings": len(findings), "classes": dict(counts), "indexPasses": 1,
            "fullBlobSearches": searches, "residuals": residuals}


def _single_line(value: object, fallback: str) -> str:
    text = " ".join(str(value or fallback).split())
    return text or fallback


def _safe_locator(raw_file: object, scan_root: str) -> str:
    """Return a scan-relative locator, never an absolute build-box path."""

    value = _single_line(raw_file, "<unknown-file>").replace("\\", "/")
    root = scan_root.strip("/").replace("\\", "/")
    root_prefix = f"{root.rstrip('/')}/" if root else ""
    if value.startswith(root_prefix):
        return value[len(root_prefix) :]
    if value.startswith("/"):
        absolute_marker = f"/{root_prefix}" if root_prefix else ""
        if absolute_marker and absolute_marker in value:
            return value.split(absolute_marker, 1)[1]
        # An unexpected path outside the scan root is still useful as a
        # basename, but must never disclose the build machine's directories.
        return Path(value).name or "<unknown-file>"
    return value.lstrip("./") or "<unknown-file>"


def main(argv: list[str]) -> int:
    if len(argv) == 7 and argv[1] == '--bind-uuid-source-documents':
        try:
            bind_uuid_source_documents(Path(argv[2]), argv[3], Path(argv[4]), Path(argv[5]), Path(argv[6]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError):
            print('UUID source document binding incomplete (values omitted).', file=sys.stderr)
            return 2
        return 0
    if len(argv) >= 7 and argv[1] == '--validate-uuid-release-artifacts':
        try:
            if argv[5] not in ('--assembled', '--final'):
                raise ValueError('UUID release validation phase invalid')
            result = validate_uuid_release_artifacts(Path(argv[2]), argv[3], Path(argv[4]),
                                                    [Path(path) for path in argv[6:]], argv[5] == '--final')
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError):
            print('UUID release artifact validation incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps(result))
        return 0
    if len(argv) == 6 and argv[1] in ('--project-uuid-source-archive', '--validate-uuid-source-archive'):
        try:
            operation = project_uuid_source_archive if argv[1].startswith('--project-') else validate_uuid_source_archive
            result = operation(Path(argv[2]), Path(argv[3]), Path(argv[4]), Path(argv[5]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, tarfile.TarError, subprocess.SubprocessError):
            print('UUID source archive projection/validation incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'reviewRef': result['reviewRef'], 'occurrenceCount': result['occurrenceCount'],
                          'redactedDocuments': result['redactedDocuments']}))
        return 0
    if len(argv) >= 6 and argv[1] == '--bind-uuid-document-sources':
        try:
            bind_uuid_document_sources(Path(argv[2]), argv[3], Path(argv[4]), [Path(path) for path in argv[5:]])
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID document source binding incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'reviewRef': _UUID_DROP_REVIEW, 'documentRoots': len(argv[5:])}))
        return 0
    if len(argv) == 6 and argv[1] == '--validate-uuid-documents':
        try:
            result = validate_uuid_document_projection(Path(argv[2]), Path(argv[3]), Path(argv[4]), Path(argv[5]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID document validation incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'reviewRef': result['reviewRef'], 'occurrenceCount': result['occurrenceCount'],
                          'redactedDocuments': result['redactedDocuments']}))
        return 0
    if len(argv) >= 4 and argv[1] == '--census-uuid-artifacts':
        try:
            result = census_uuid_artifacts(Path(argv[2]), [Path(path) for path in argv[3:]])
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID artifact census incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({key: result[key] for key in ('reviewRef', 'occurrenceCount', 'occurrences', 'coverage', 'releaseRootSelection')}))
        return 1 if result['occurrenceCount'] else 0
    if len(argv) == 6 and argv[1] == '--project-uuid-documents':
        try:
            result = project_uuid_document_tree(Path(argv[2]), Path(argv[3]), Path(argv[4]), Path(argv[5]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID document projection incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'reviewRef': result['reviewRef'], 'occurrenceCount': result['occurrenceCount'],
                          'redactedDocuments': result['redactedDocuments']}))
        return 0
    if len(argv) == 4 and argv[1] == '--assemble-uuid-row-drops':
        try:
            config, output = Path(argv[2]), Path(argv[3])
            if output.exists() or output.is_symlink() or output.parent.is_symlink() or output.parent.stat().st_mode & 0o077:
                raise ValueError('private create-only UUID output required')
            result = assemble_uuid_idempotency_drop_plans(config)
            fd, temporary = tempfile.mkstemp(prefix='uuid-drops-', suffix='.partial', dir=output.parent)
            try:
                with os.fdopen(fd, 'w') as handle:
                    json.dump(result, handle, ensure_ascii=False)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.link(temporary, output)
            finally:
                os.unlink(temporary)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID row-drop assembly incomplete (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'schema': result['schema'], 'counts': result['counts'], 'planSetSha256': _sha256(output)}))
        return 0
    if len(argv) == 5 and argv[1] == '--validate-uuid-row-drops':
        try:
            plan_path, output_path = Path(argv[3]), Path(argv[4])
            _private_file(plan_path)
            _private_file(output_path)
            plan = json.loads(plan_path.read_text())
            candidate = json.loads(output_path.read_text())
            manifest_path = Path(candidate['manifestPath'])
            if _sha256(manifest_path) != candidate['manifestSha256']:
                raise ValueError('UUID output manifest changed')
            manifest = json.loads(manifest_path.read_text())
            reports = [report for store in manifest['stores']
                       for report in store.get('meta', {}).get('uuidIdempotencyRedactions', [])]
            inputs = [Path(path) for path in candidate['artifactInputs']]
            if manifest_path not in inputs:
                raise ValueError('UUID output manifest not scanned')
            roots = [Path(path) for path in candidate['artifactRoots']]
            result = validate_uuid_idempotency_row_drops(Path(argv[2]), plan, candidate['sources'], reports, inputs,
                                                        artifact_roots=roots)
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            print('UUID row-drop validation incomplete; candidate remains refused (values omitted).', file=sys.stderr)
            return 2
        print(json.dumps({'reviewRef': result['reviewRef'], 'counts': result['counts'],
                          'rawClassHits': result['rawClassHits'], 'candidateBinding': result['candidateBinding']}))
        return 0
    if len(argv) == 5 and argv[1] == "--scan-identity-proof":
        try:
            scan = scan_identity_proof(Path(argv[2]), Path(argv[3]), Path(argv[4]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
            print("Identity secret proof scan incomplete (values omitted).", file=sys.stderr)
            return 2
        summary = {key: scan[key] for key in ("schema", "seedRootSha", "scannerSha256",
                          "realFindings", "derivationMatches", "rawSkMatches", "nameScanHits",
                          "tokensChecked", "positivePlantedSecretDetected")}
        digest_scan = scan.get("credentialDigestScan", {})
        if digest_scan:
            summary["credentialDigestCandidates"] = len(digest_scan["digests"])
            for key in ("digestOfCredentialHits", "rawCredentialHits"):
                summary[key] = digest_scan[key]
        print(json.dumps(summary))
        refused = any(scan[key] for key in ("realFindings", "derivationMatches", "rawSkMatches", "nameScanHits"))
        refused |= any(digest_scan.get(key, 0) for key in ("digestOfCredentialHits", "rawCredentialHits"))
        return 1 if refused else 0
    if len(argv) == 7 and argv[1] == "--assemble-seed-proof":
        try:
            proof = assemble_seed_proof(Path(argv[2]), Path(argv[3]), Path(argv[4]), argv[5], argv[6])
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
            print("Seed proof could not be assembled (values omitted).", file=sys.stderr)
            return 2
        print(json.dumps({"schemaVersion": proof["schemaVersion"], "sourceSha256": proof["sourceSha256"]}))
        return 0
    if len(argv) == 6 and argv[1] == "--filter-seed":
        try:
            result = filter_seed_findings(Path(argv[2]), Path(argv[3]), Path(argv[4]), Path(argv[5]))
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
            print("Exact seed exemption proof invalid; credential gate remains failed (values omitted).", file=sys.stderr)
            return 2
        print(json.dumps(result))
        return 1 if result["remaining"] else 0
    if len(argv) == 5 and argv[1] == "--scan-seed":
        try:
            findings, reused = scan_seed_report(Path(argv[2]), Path(argv[3]), Path(argv[4]))
            result = classify_seed_findings(Path(argv[3]), findings)
            result["privateReportReused"] = reused
        except (OSError, UnicodeError, ValueError, subprocess.SubprocessError):
            print("Private seed scan could not be completed (values omitted).", file=sys.stderr)
            return 2
        print(json.dumps(result))
        return 0
    if len(argv) == 4 and argv[1] == "--classify-seed":
        try:
            findings = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
            if not isinstance(findings, list):
                raise ValueError("report shape")
            result = classify_seed_findings(Path(argv[3]), findings)
        except (OSError, UnicodeError, ValueError):
            print("Seed finding classification could not be completed (values omitted).", file=sys.stderr)
            return 2
        print(json.dumps(result))
        return 0
    if len(argv) != 3:
        print("usage: print-gitleaks-findings.py REPORT_JSON SCAN_ROOT", file=sys.stderr)
        return 2

    report_path = Path(argv[1])
    scan_root = argv[2]
    try:
        findings = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        # Do not echo the path or parser exception: either could carry a host
        # path or scanner output into a release log.
        print("       Redacted gitleaks report could not be read.", file=sys.stderr)
        return 2

    if not isinstance(findings, list):
        print("       Redacted gitleaks report had an unexpected shape.", file=sys.stderr)
        return 2

    if not findings:
        print("       No structured finding details were recorded.", file=sys.stderr)
        return 0

    locators: Counter[tuple[str, str, str, str, str]] = Counter()
    malformed = 0
    for finding in findings:
        if not isinstance(finding, dict):
            malformed += 1
            continue
        rule_id = _single_line(finding.get("RuleID"), "<unknown-rule>")
        locator = _safe_locator(finding.get("File"), scan_root)
        start_line = _single_line(finding.get("StartLine"), "?")
        end_line = _single_line(finding.get("EndLine"), start_line)
        description = _single_line(finding.get("Description"), "<no-description>")
        locators[(rule_id, locator, start_line, end_line, description)] += 1
    print(
        f"       {len(findings)} finding records; {len(locators)} unique locators; "
        f"showing at most {MAX_LOCATORS} (matched values omitted).",
        file=sys.stderr,
    )
    for (rule_id, locator, start_line, end_line, description), count in list(locators.items())[:MAX_LOCATORS]:
        print(
            f"       - RuleID={rule_id} File={locator} "
            f"Lines={start_line}-{end_line} Occurrences={count} Description={description}",
            file=sys.stderr,
        )
    if len(locators) > MAX_LOCATORS:
        print(f"       {len(locators) - MAX_LOCATORS} additional locators retained in the private report.", file=sys.stderr)
    if malformed:
        print(f"       {malformed} malformed finding records (values omitted).", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
