"""Generate pinned mDenseOn vectors for embedder-eval-cli --vectors.

Run in an isolated environment with torch (CPU) and sentence-transformers.
This is experimental Python inference, not a Transformers.js sidecar export.
The conventional Vitest suite validates the manifest before scoring it.
"""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import resource
import shutil
import subprocess
import time

import numpy as np
import torch
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer
from mdenseon_config import apply_pinned_rope

MODEL = "lightonai/mDenseOn"
REVISION = "a5fdb000f7a21da96c3bddde3a782ef777316df3"
VECTOR_COSINE_FLOOR = 0.99999
VECTOR_MAX_ABS_ERROR = 3e-5


def package_version(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def file_sha256(path):
    path = Path(path)
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sample_indices(length, count):
    """Stable coverage across a fixture without baking its current size into the validator."""
    if length <= count:
        return list(range(length))
    return sorted({round(i * (length - 1) / (count - 1)) for i in range(count)})


def normalized_cls(hidden_state):
    vectors = np.asarray(hidden_state[:, 0, :], dtype=np.float32)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(norms == 0) or not np.isfinite(vectors).all():
        raise ValueError("model produced a non-finite or zero-norm CLS vector")
    return vectors / norms


def compare_vectors(actual, expected, labels):
    actual = np.asarray(actual, dtype=np.float32)
    expected = np.asarray(expected, dtype=np.float32)
    if actual.shape != expected.shape:
        raise ValueError(f"vector shape mismatch: actual {actual.shape}, expected {expected.shape}")
    cosines = np.sum(actual * expected, axis=1)
    errors = np.max(np.abs(actual - expected), axis=1)
    return {
        "count": len(labels),
        "minimumCosine": float(np.min(cosines)),
        "maximumAbsoluteError": float(np.max(errors)),
        "worstCosineLabel": labels[int(np.argmin(cosines))],
        "worstAbsoluteErrorLabel": labels[int(np.argmax(errors))],
        "cases": [
            {"label": label, "cosine": float(cosine), "maximumAbsoluteError": float(error)}
            for label, cosine, error in zip(labels, cosines, errors)
        ],
    }


def run_onnx_vectors(session, tokenizer, texts, batch_size=8):
    vectors = []
    token_records = []
    for start in range(0, len(texts), batch_size):
        batch = texts[start:start + batch_size]
        encoded = tokenizer(batch, padding=True, truncation=True, max_length=8192,
                            return_tensors="np")
        inputs = {name: np.asarray(encoded[name], dtype=np.int64)
                  for name in ("input_ids", "attention_mask")}
        hidden = session.run(["last_hidden_state"], inputs)[0]
        vectors.extend(normalized_cls(hidden))
        for row, mask in zip(inputs["input_ids"], inputs["attention_mask"]):
            length = int(mask.sum())
            token_records.append({"length": length, "inputIds": row[:length].tolist()})
    return np.asarray(vectors, dtype=np.float32), token_records


def run_torch_vectors(model, tokenizer, texts):
    encoded = tokenizer(texts, padding=True, truncation=True, max_length=8192,
                        return_tensors="pt")
    model_inputs = {name: encoded[name] for name in ("input_ids", "attention_mask")}
    with torch.no_grad():
        hidden = model(**model_inputs).last_hidden_state.detach().cpu().numpy()
    return normalized_cls(hidden), [
        {"length": int(mask.sum()), "inputIds": ids[:int(mask.sum())].tolist()}
        for ids, mask in zip(encoded["input_ids"], encoded["attention_mask"])
    ]


def load_frozen_cases(repo_root):
    report_path = repo_root / ".papercusp/bench-reports/candidates-2026-09-30-mdenseon-vectors.json"
    frozen = json.loads(report_path.read_text())
    if frozen.get("model") != MODEL or frozen.get("revision") != REVISION:
        raise ValueError("frozen Python reference is not the pinned mDenseOn revision")
    fixtures = repo_root / "packages/operator-core/lib/memory/bench/fixtures"
    cases = []
    ranking = {}
    for corpus in ("memory", "prose"):
        prefix = "prose-" if corpus == "prose" else ""
        entries = json.loads((fixtures / f"{prefix}corpus.v1.json").read_text())["entries"]
        queries = json.loads((fixtures / f"{prefix}gold-set.v1.json").read_text())["queries"]
        suite = frozen["suites"][corpus]
        if suite["keys"] != [entry["key"] for entry in entries]:
            raise ValueError(f"{corpus} document order differs from the frozen reference")
        if suite["queryIds"] != [query["id"] for query in queries]:
            raise ValueError(f"{corpus} query order differs from the frozen reference")
        for index in sample_indices(len(entries), 6):
            cases.append({"label": f"{corpus}/document/{entries[index]['key']}",
                          "text": f"document: {entries[index]['text']}",
                          "vector": suite["docVectors"][index]})
        for index in sample_indices(len(queries), 6):
            cases.append({"label": f"{corpus}/query/{queries[index]['id']}",
                          "text": f"query: {queries[index]['query']}",
                          "vector": suite["queryVectors"][index]})
        doc_indices = sample_indices(len(entries), 32)
        query_indices = sample_indices(len(queries), 8)
        ranking[corpus] = {
            "docLabels": [entries[index]["key"] for index in doc_indices],
            "docTexts": [f"document: {entries[index]['text']}" for index in doc_indices],
            "docVectors": [suite["docVectors"][index] for index in doc_indices],
            "queryLabels": [queries[index]["id"] for index in query_indices],
            "queryTexts": [f"query: {queries[index]['query']}" for index in query_indices],
            "queryVectors": [suite["queryVectors"][index] for index in query_indices],
        }
    return report_path, frozen, cases, ranking


def validate_rankings(session, tokenizer, ranking):
    results = {}
    for corpus, suite in ranking.items():
        actual_docs, _ = run_onnx_vectors(session, tokenizer, suite["docTexts"])
        actual_queries, _ = run_onnx_vectors(session, tokenizer, suite["queryTexts"])
        expected_docs = np.asarray(suite["docVectors"], dtype=np.float32)
        expected_queries = np.asarray(suite["queryVectors"], dtype=np.float32)
        cases = []
        for index, label in enumerate(suite["queryLabels"]):
            expected_order = np.argsort(-(expected_docs @ expected_queries[index]))[:10]
            actual_order = np.argsort(-(actual_docs @ actual_queries[index]))[:10]
            cases.append({
                "query": label,
                "expectedTop10": [suite["docLabels"][i] for i in expected_order],
                "actualTop10": [suite["docLabels"][i] for i in actual_order],
                "exact": bool(np.array_equal(expected_order, actual_order)),
            })
        results[corpus] = {"candidateDocuments": len(expected_docs), "queries": cases}
    return results


def write_json_atomic(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def load_pinned_tokenizer(snapshot):
    """Load the tokenizer.json without trusting a newer Transformers class alias.

    The pinned snapshot was published with Transformers 5.x and names its generic
    Rust-backed implementation ``TokenizersBackend``. Transformers 4.57 cannot
    resolve that alias through AutoTokenizer even though it can consume the exact
    tokenizer.json. Constructing the stable fast-tokenizer base explicitly keeps
    the bytes and special-token contract pinned across that version boundary.
    """
    from transformers import PreTrainedTokenizerFast

    tokenizer_config = json.loads((snapshot / "tokenizer_config.json").read_text())
    keys = ["bos_token", "eos_token", "unk_token", "pad_token", "mask_token",
            "cls_token", "sep_token", "model_max_length"]
    return PreTrainedTokenizerFast(
        tokenizer_file=str(snapshot / "tokenizer.json"),
        **{key: tokenizer_config[key] for key in keys if key in tokenizer_config},
    )


def load_pinned_config(snapshot):
    from transformers import AutoConfig

    snapshot = Path(snapshot)
    canonical = json.loads((snapshot / "config.json").read_text())
    config = apply_pinned_rope(
        AutoConfig.from_pretrained(snapshot, local_files_only=True), canonical)
    config.reference_compile = False
    return config


def finalize_existing_onnx(directory):
    """Validate and finalize an already-exported graph without re-exporting its weights."""
    import onnx
    import onnxruntime as ort
    from transformers import AutoModel

    root = Path(directory).resolve()
    graph = root / "onnx/model.onnx"
    if not graph.is_file():
        raise ValueError(f"existing ONNX graph not found: {graph}")
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    repo_root = Path(__file__).resolve().parents[5]
    report_path, frozen, frozen_cases, ranking = load_frozen_cases(repo_root)
    thresholds = {"minimumCosine": VECTOR_COSINE_FLOOR,
                  "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR,
                  "top10Ranking": "exact"}
    started = time.perf_counter()
    tokenizer = load_pinned_tokenizer(snapshot)
    config = load_pinned_config(snapshot)
    model = AutoModel.from_pretrained(snapshot, config=config,
                                     attn_implementation="eager", local_files_only=True).eval()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(graph), sess_options=options,
                                   providers=["CPUExecutionProvider"])

    controlled = [
        ("short-query", "query: parity smoke"),
        ("short-document", "document: deterministic sidecar validation"),
        ("unicode-query", "query: résumé 東京 naïve façade عربي"),
        ("padded-257", "document: " + "token " * 257),
        ("long-1024", "query: " + "retrieval validation token " * 342),
    ]
    controlled_labels = [label for label, _ in controlled]
    controlled_texts = [text for _, text in controlled]
    torch_vectors, torch_tokens = run_torch_vectors(model, tokenizer, controlled_texts)
    onnx_vectors, onnx_tokens = run_onnx_vectors(session, tokenizer, controlled_texts,
                                                 batch_size=len(controlled_texts))
    if torch_tokens != onnx_tokens:
        raise ValueError("token IDs supplied to PyTorch and ONNX differ")
    controlled_result = compare_vectors(onnx_vectors, torch_vectors, controlled_labels)
    controlled_result["tokens"] = [
        {"label": label, **tokens} for label, tokens in zip(controlled_labels, onnx_tokens)
    ]

    frozen_vectors, frozen_tokens = run_onnx_vectors(
        session, tokenizer, [case["text"] for case in frozen_cases])
    frozen_result = compare_vectors(frozen_vectors, [case["vector"] for case in frozen_cases],
                                    [case["label"] for case in frozen_cases])
    frozen_result["tokens"] = [
        {"label": case["label"], **tokens}
        for case, tokens in zip(frozen_cases, frozen_tokens)
    ]
    rankings = validate_rankings(session, tokenizer, ranking)
    ranking_exact = all(case["exact"] for result in rankings.values() for case in result["queries"])
    accepted = (
        controlled_result["minimumCosine"] >= VECTOR_COSINE_FLOOR
        and controlled_result["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        and frozen_result["minimumCosine"] >= VECTOR_COSINE_FLOOR
        and frozen_result["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        and ranking_exact
    )
    limit_tokens = tokenizer("token " * 9000, truncation=True, max_length=8192)["input_ids"]
    if len(limit_tokens) != 8192:
        accepted = False
    validation = {
        "formatVersion": 1,
        "accepted": accepted,
        "model": MODEL,
        "revision": REVISION,
        "graph": {"path": "onnx/model.onnx", "bytes": graph.stat().st_size,
                  "sha256": file_sha256(graph)},
        "thresholds": thresholds,
        "controlledTorchParity": controlled_result,
        "frozenPythonParity": frozen_result,
        "rankingParity": rankings,
        "tokenizerLimit": {"requestedMaxLength": 8192, "observedLength": len(limit_tokens)},
        "frozenReference": {"path": str(report_path.relative_to(repo_root)),
                            "sha256": file_sha256(report_path),
                            "versions": frozen["versions"]},
        "validationVersions": {name: package_version(name) for name in
                               ["torch", "transformers", "onnx", "onnxruntime", "numpy"]},
        "effectiveRope": {"global": config.global_rope_theta,
                          "local": config.local_rope_theta,
                          "parameters": config.rope_parameters},
        "seconds": time.perf_counter() - started,
    }
    write_json_atomic(root / ("validation-report.json" if accepted else "validation-report.failed.json"),
                      validation)
    if not accepted:
        raise ValueError("existing ONNX graph failed the predeclared normalized-vector parity contract")

    config_json = config.to_dict()
    graph_proto = onnx.load(graph, load_external_data=False)
    external_files = sorted({entry.value for tensor in graph_proto.graph.initializer
                             for entry in tensor.external_data if entry.key == "location"})
    if external_files:
        config_json["transformers.js_config"] = {
            "use_external_data_format": {"model.onnx": len(external_files)}}
    write_json_atomic(root / "config.json", config_json)
    shutil.copy2(snapshot / "tokenizer.json", root / "tokenizer.json")
    tokenizer_config = json.loads((snapshot / "tokenizer_config.json").read_text())
    tokenizer_config["model_max_length"] = 8192
    tokenizer_config["tokenizer_class"] = "PreTrainedTokenizerFast"
    write_json_atomic(root / "tokenizer_config.json", tokenizer_config)
    manifest = {"formatVersion": 1, "model": MODEL, "revision": REVISION,
                "dimensions": 768, "pooling": "cls", "normalization": "l2",
                "maxLength": 8192, "output": "last_hidden_state", "weightDtype": "fp32",
                "prompts": {"query": "query: ", "document": "document: "},
                "validation": {"report": "validation-report.json", "thresholds": thresholds},
                "versions": {name: package_version(name) for name in
                             ["torch", "transformers", "optimum", "optimum-onnx", "onnx"]},
                "files": {str(path.relative_to(root)): {"bytes": path.stat().st_size,
                          "sha256": file_sha256(path)}
                          for path in root.rglob("*") if path.is_file()
                          and path.name != "export-manifest.json"}}
    write_json_atomic(root / "export-manifest.json", manifest)
    print(f"validated and finalized existing ONNX export: {root}", flush=True)


def export_onnx(directory):
    """Use Optimum's supported ModernBERT exporter, keeping the Hub snapshot intact."""
    from optimum.exporters.onnx import export
    from optimum.exporters.tasks import TasksManager
    from transformers import AutoModel

    root = Path(directory).resolve()
    if root.exists():
        raise ValueError(f"refusing to overwrite existing export directory: {root}")
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    config = load_pinned_config(snapshot)
    model = AutoModel.from_pretrained(snapshot, config=config,
                                     attn_implementation="eager", local_files_only=True).eval()
    constructor = TasksManager.get_exporter_config_constructor(
        model=model, exporter="onnx", task="feature-extraction", library_name="transformers")
    onnx_config = constructor(model.config)
    graph_dir = root / "onnx"
    graph_dir.mkdir(parents=True)
    graph = graph_dir / "model.onnx"
    print(f"exporting pinned {MODEL}@{REVISION} -> {graph}", flush=True)
    _, outputs = export(model, onnx_config, graph, opset=17, device="cpu",
                        input_shapes={"batch_size": 2, "sequence_length": 32})
    tokenizer = load_pinned_tokenizer(snapshot)
    # SentenceTransformers enforces this independently of tokenizer_config.json.
    tokenizer.model_max_length = 8192
    tokenizer.save_pretrained(root)
    model.config.save_pretrained(root)
    import onnx
    graph_proto = onnx.load(graph, load_external_data=False)
    external_files = sorted({entry.value for tensor in graph_proto.graph.initializer
                             for entry in tensor.external_data if entry.key == "location"})
    if external_files:
        graph_locations = ["model.onnx_data" if i == 0 else f"model.onnx_data_{i}"
                           for i in range(len(external_files))]
        for tensor in graph_proto.graph.initializer:
            for entry in tensor.external_data:
                if entry.key == "location":
                    entry.value = graph_locations[external_files.index(entry.value)]
        for original, target in zip(external_files, graph_locations):
            if original != target:
                (graph_dir / original).rename(graph_dir / target)
        onnx.save(graph_proto, graph)
        exported_config = json.loads((root / "config.json").read_text())
        exported_config["transformers.js_config"] = {
            "use_external_data_format": {"model.onnx": len(external_files)}}
        (root / "config.json").write_text(json.dumps(exported_config, indent=2))
    # The normalized CLS/frozen-reference contract also checks token IDs,
    # padded/long inputs and retrieval rankings. Numerical self-parity alone
    # cannot detect a semantically wrong config shared by torch and ONNX.
    del model
    finalize_existing_onnx(root)


def qualify_incumbent_reference(native_file, out_file):
    """Same pinned ONNX assets; independently maintained Python tokenizer and pooling.

    This is reference qualification, not a second export or a production migration.
    Report shipped and corrected Gemma separately even when shipped loses parity.
    """
    import numpy as np
    import onnxruntime as ort
    native_path = Path(native_file)
    native = json.loads(native_path.read_text())
    request_file = Path(str(native_path) + ".request.json")
    if file_sha256(request_file) != native["requestSha256"]:
        raise ValueError("reference request identity drift")
    request = json.loads(request_file.read_text())
    if native["cases"] != request["cases"] or native["identities"] != request["identities"]:
        raise ValueError("reference native/request recipe drift")
    report = {"formatVersion": 1, "nativeSha256": file_sha256(native_path),
              "requestSha256": native["requestSha256"], "executionProvider": "CPUExecutionProvider",
              "thresholds": {"minimumCosine": VECTOR_COSINE_FLOOR, "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR},
              "versions": {name: package_version(name) for name in ["numpy", "onnxruntime", "tokenizers", "transformers"]},
              "arms": []}
    options = ort.SessionOptions()
    options.intra_op_num_threads = request["execution"]["intraOpNumThreads"]
    options.inter_op_num_threads = request["execution"]["interOpNumThreads"]
    for identity in request["identities"]:
        for asset in identity["files"]:
            if file_sha256(asset["path"]) != asset["sha256"] or Path(asset["path"]).stat().st_size != asset["bytes"]:
                raise ValueError("reference asset identity drift")
        tokenizer = load_pinned_tokenizer(Path(identity["directory"]))
        graph = next(asset["path"] for asset in identity["files"] if asset["path"].endswith("/onnx/model.onnx"))
        session = ort.InferenceSession(graph, sess_options=options, providers=["CPUExecutionProvider"])
        for arm in [a for a in native["arms"] if a["model"] == identity["model"]]:
            if [c["id"] for c in arm["cases"]] != [c["id"] for c in request["cases"]]:
                raise ValueError("reference case coverage/order mismatch")
            results = []
            for case in arm["cases"]:
                encoded = tokenizer(case["promptedText"], padding=True, truncation=True,
                                    max_length=tokenizer.model_max_length, return_tensors="np")
                outputs = dict(zip([x.name for x in session.get_outputs()], session.run(None, {
                    x.name: encoded[x.name].astype(np.int64) for x in session.get_inputs()})))
                if identity["model"] == "harrier":
                    vector = outputs["sentence_embedding"][0]
                else:
                    mask = encoded["attention_mask"].astype(np.float32)[..., None]
                    vector = (outputs["last_hidden_state"] * mask).sum(axis=1)[0] / mask.sum(axis=1)[0]
                vector = vector / np.linalg.norm(vector)
                reference = vector.tolist()
                comparison = compare_vectors([case["vector"]], [reference], [case["id"]])
                tokens_equal = encoded["input_ids"][0].tolist() == case["inputIds"]
                results.append({"id": case["id"], "tokenIdsEqual": tokens_equal,
                                "referenceTokenIds": encoded["input_ids"][0].tolist(), "referenceVector": reference,
                                "nativeParity": comparison,
                                "shippedWorkerParity": compare_vectors([case["shippedVector"]], [case["vector"]], [case["id"]]) if case.get("shippedVector") else None})
            report["arms"].append({"model": arm["model"], "profileId": arm["profileId"],
                                   "tokenizerBackend": arm["tokenizerBackend"], "cases": results})
        del session
    destination = Path(out_file)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("x") as handle:
        json.dump(report, handle)


def validate_boundary_request(request):
    """Fail before weights are loaded; never relax a measured compatibility gate."""
    if (request.get("formatVersion") != 1 or request.get("model") != MODEL
            or request.get("revision") != REVISION
            or request.get("thresholds") != {"minimumCosine": VECTOR_COSINE_FLOOR,
                                             "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR,
                                             "ranking": "exact"}
            or request.get("execution") != {"dtype": "fp32", "intraOpThreads": 4,
                                            "interOpThreads": 1, "maxLength": 8192}):
        raise ValueError("boundary identity or fixed gate drift")
    cases = request.get("cases", [])
    identifiers = [case["id"] for case in cases]
    required = {"short-query", "short-document", "unicode", "code", "whitespace", "empty", "full-8192", "over-limit"}
    if len(set(identifiers)) != len(identifiers) or set(identifiers) != required:
        raise ValueError("boundary case population incomplete or duplicated")
    for case in cases:
        if case.get("kind") not in ("query", "document") or not isinstance(case.get("text"), str):
            raise ValueError("boundary text/prompt identity missing")
        if not isinstance(case.get("untruncatedTokens"), int) or case["untruncatedTokens"] < 2:
            raise ValueError("boundary token measurement missing")
    lengths = {case["id"]: case["untruncatedTokens"] for case in cases}
    if lengths["full-8192"] != 8192 or lengths["over-limit"] <= 8192:
        raise ValueError("8192/over-limit must be real untruncated token lengths")
    batches = request.get("batches", [])
    if {b.get("id") for b in batches} != {"padded", "mixed-length"} or len(batches) != 2:
        raise ValueError("boundary batch population incomplete")
    for batch in batches:
        if len(batch.get("caseIds", [])) < 2 or any(i not in required for i in batch["caseIds"]):
            raise ValueError("unknown or non-batch boundary case")
    for asset in request.get("assets", []):
        if (not isinstance(asset.get("path"), str) or not isinstance(asset.get("bytes"), int)
                or len(asset.get("sha256", "")) != 64):
            raise ValueError("boundary asset pin missing")
    if not request.get("assets") or not request.get("snapshot") or not request.get("export"):
        raise ValueError("boundary reference/export pins missing")
    return request


def freeze_boundary_request(directory, out_file):
    """New input contract only; reuse the qualified export and pinned snapshot."""
    snapshot = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True)).resolve()
    root = Path(directory).resolve()
    tokenizer = load_pinned_tokenizer(snapshot)
    count = lambda text: len(tokenizer(text, truncation=False)["input_ids"])
    # Binary search publisher-tokenized text, not synthetic input_ids or a
    # tokenizer-only maximum claim. Execution rechecks these counts per cell.
    low, high = 1, 8192
    while low < high:
        mid = (low + high) // 2
        if count("document: " + "token " * mid) < 8192:
            low = mid + 1
        else:
            high = mid
    full = "token " * low
    if count("document: " + full) != 8192:
        raise ValueError("cannot construct exact publisher-tokenized8192 text")
    texts = [("short-query", "query", "parity smoke"),
             ("short-document", "document", "deterministic boundary validation"),
             ("unicode", "query", "résumé 東京 naïve façade عربي 👩🏽‍💻 e\u0301"),
             ("code", "document", "def lookup(key):\n    return cache.get(key, None)\n// λ := 日本語"),
             ("whitespace", "query", " \t\r\n  "), ("empty", "document", ""),
             ("full-8192", "document", full), ("over-limit", "document", full + "token " * 64)]
    cases = [{"id": identifier, "kind": kind, "text": text,
              "untruncatedTokens": count(f"{kind}: {text}")} for identifier, kind, text in texts]
    assets = []
    for base, names in [(snapshot, ["config.json", "tokenizer.json", "tokenizer_config.json", "model.safetensors"]),
                        (root, ["config.json", "tokenizer.json", "tokenizer_config.json", "export-manifest.json"] +
                         [str(p.relative_to(root)) for p in (root / "onnx").iterdir() if p.is_file()]),
                        (Path(__file__).parent, ["mdenseon-vectors.py", "mdenseon_config.py"])]:
        for name in names:
            asset = base / name
            assets.append({"path": str(asset), "sha256": file_sha256(asset), "bytes": asset.stat().st_size})
    request = validate_boundary_request({"formatVersion": 1, "model": MODEL, "revision": REVISION,
        "snapshot": str(snapshot), "export": str(root), "assets": assets, "cases": cases,
        "execution": {"dtype": "fp32", "intraOpThreads": 4, "interOpThreads": 1, "maxLength": 8192},
        "thresholds": {"minimumCosine": VECTOR_COSINE_FLOOR, "maximumAbsoluteError": VECTOR_MAX_ABS_ERROR, "ranking": "exact"},
        "batches": [{"id": "padded", "caseIds": ["short-query", "unicode", "code", "whitespace", "empty"]},
                    {"id": "mixed-length", "caseIds": ["short-query", "full-8192"]}]})
    with Path(out_file).open("x") as handle:
        json.dump(request, handle, indent=2)
    print("boundary request frozen", file_sha256(out_file), flush=True)


def boundary_gpu_memory(device):
    """Timestamp device capacity near inference; never infer historical pressure."""
    if device != "cuda":
        return {"status": "not-applicable"}
    measured_at_ns = time.time_ns()
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=index,memory.total,memory.used,memory.free",
                                 "--format=csv,noheader,nounits"], capture_output=True, text=True,
                                timeout=5, check=True)
        rows = [row.strip().split(",") for row in result.stdout.strip().splitlines()]
        devices = [{"index": int(row[0]), "totalMiB": float(row[1]),
                    "usedMiB": float(row[2]), "freeMiB": float(row[3])} for row in rows]
        if not devices or any(row["freeMiB"] < 0 or row["totalMiB"] <= 0 for row in devices):
            raise ValueError("invalid GPU memory query")
        return {"status": "measured", "measuredAtEpochNs": measured_at_ns, "devices": devices}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError) as error:
        return {"status": "unknown", "measuredAtEpochNs": measured_at_ns,
                "error": {"name": type(error).__name__, "message": str(error)[:1000]}}


def boundary_infer(session, inputs, destination, metadata):
    """Persist independent proof BEFORE a candidate can fail; retain its cause."""
    reference_path = destination / (metadata["cell"]["id"] + ".reference.json")
    with reference_path.open("x") as handle:
        json.dump(metadata, handle)
    try:
        return session.run(["last_hidden_state"], inputs)[0]
    except Exception as error:
        device = "cuda" if "CUDAExecutionProvider" in metadata.get("sessionProviders", []) else "cpu"
        failure_memory = boundary_gpu_memory(device)
        profile = Path(session.end_profiling())
        failure = {**metadata, "status": "inference-failed", "actual8192Completed": False,
                   "gpuMemoryAfterFailure": failure_memory,
                   "referenceFile": {"path": str(reference_path), "sha256": file_sha256(reference_path)},
                   "error": {"name": type(error).__name__, "message": str(error)},
                   "profile": {"path": str(profile), "sha256": file_sha256(profile)}}
        with (destination / (metadata["cell"]["id"] + ".failure.json")).open("x") as handle:
            json.dump(failure, handle)
        raise


def assert_boundary_provider(session, provider, cuda_tf32):
    """Verify the effective runtime recipe, including precision, before inference."""
    if not session.get_providers() or session.get_providers()[0] != provider:
        raise ValueError(f"session silently fell back: {session.get_providers()}")
    if provider == "CUDAExecutionProvider":
        effective = session.get_provider_options().get(provider, {}).get("use_tf32")
        if cuda_tf32 not in ("0", "1") or effective != cuda_tf32:
            raise ValueError(f"CUDA precision recipe not honored: requested {cuda_tf32}, effective {effective}")


def select_boundary_cells(request, selected_cell):
    """A batch diagnostic measures its single baselines in the same process."""
    singles = [{"id": "single-" + case["id"], "caseIds": [case["id"]]} for case in request["cases"]]
    cells = singles + request["batches"]
    promised = [cell["id"] for cell in cells]
    if not selected_cell:
        return cells, promised
    selected = [cell for cell in cells if cell["id"] == selected_cell]
    if len(selected) != 1:
        raise ValueError("diagnostic selection requires one declared cell")
    if len(selected[0]["caseIds"]) == 1:
        return selected, promised
    baselines = {cell["caseIds"][0]: cell for cell in singles}
    return [baselines[identifier] for identifier in selected[0]["caseIds"]] + selected, promised


def measure_boundaries(request_file, device, out_directory, selected_cell=None, cuda_tf32=None):
    """Actual graph vs independently loaded PyTorch, one immutable file/cell.

    Python CUDA is a separately named recipe, never evidence that Node's
    worker used CUDA. Profiling proves which kernels ran, not mere registry.
    """
    import onnxruntime as ort
    from transformers import AutoModel

    # CUDA's implicit TF32 default missed the fixed fp32 vector tolerance in
    # a paired actual-device probe. Keep explicit TF32-on as a distinct arm.
    if device == "cuda" and cuda_tf32 is None:
        cuda_tf32 = "0"
    request = validate_boundary_request(json.loads(Path(request_file).read_text()))
    cells, promised_cells = select_boundary_cells(request, selected_cell)
    for asset in request["assets"]:
        if Path(asset["path"]).stat().st_size != asset["bytes"] or file_sha256(asset["path"]) != asset["sha256"]:
            raise ValueError("boundary source/reference/export fingerprint drift")
    destination = Path(out_directory)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    provider = "CUDAExecutionProvider" if device == "cuda" else "CPUExecutionProvider"
    if provider not in ort.get_available_providers():
        raise ValueError(f"required provider absent: {provider}")
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 4, 1
    options.enable_profiling = True
    options.profile_file_prefix = str(destination / "ort-profile")
    providers = [(provider, {"use_tf32": str(cuda_tf32)})] if device == "cuda" and cuda_tf32 is not None else [provider]
    session = ort.InferenceSession(str(Path(request["export"]) / "onnx/model.onnx"),
                                   sess_options=options, providers=providers)
    session.disable_fallback()
    assert_boundary_provider(session, provider, cuda_tf32)
    snapshot = Path(request["snapshot"])
    reference_tokenizer = load_pinned_tokenizer(snapshot)
    actual_tokenizer = load_pinned_tokenizer(Path(request["export"]))
    model = AutoModel.from_pretrained(snapshot, config=load_pinned_config(snapshot),
                                    attn_implementation="eager", local_files_only=True).eval()
    cases = {case["id"]: case for case in request["cases"]}
    singles = {}
    all_vector_gates_passed = True
    for cell in cells:
        started = time.perf_counter()
        texts = [f"{cases[i]['kind']}: {cases[i]['text']}" for i in cell["caseIds"]]
        actual = actual_tokenizer(texts, padding=True, truncation=True, max_length=8192, return_tensors="np")
        reference = reference_tokenizer(texts, padding=True, truncation=True, max_length=8192, return_tensors="pt")
        for name in ("input_ids", "attention_mask"):
            if not np.array_equal(actual[name], reference[name].numpy()):
                raise ValueError(f"independent tokenizer mismatch: {cell['id']} {name}")
        lengths = actual["attention_mask"].sum(axis=1).astype(int).tolist()
        if lengths != [min(8192, cases[i]["untruncatedTokens"]) for i in cell["caseIds"]]:
            raise ValueError("actual boundary tokens differ from frozen counts")
        ref_start = time.perf_counter()
        with torch.no_grad():
            hidden = model(**{name: reference[name] for name in ("input_ids", "attention_mask")}).last_hidden_state.numpy()
        expected = normalized_cls(hidden)
        del hidden
        reference_ms = (time.perf_counter() - ref_start) * 1000
        actual_start = time.perf_counter()
        inputs = {name: actual[name].astype(np.int64) for name in ("input_ids", "attention_mask")}
        metadata = {"formatVersion": 1, "cell": cell, "requestSha256": file_sha256(request_file),
                    "deviceRecipe": f"python-ort-{device}-fp32-tf32-{cuda_tf32 if cuda_tf32 is not None else 'default'}",
                    "sessionProviders": session.get_providers(), "providerOptions": session.get_provider_options(),
                    "inputShapeActuallySubmitted": list(inputs["input_ids"].shape), "tokenLengths": lengths,
                    "tokenIdsEqual": True, "inputIds": inputs["input_ids"].tolist(),
                    "gpuMemoryBeforeInference": boundary_gpu_memory(device),
                    "referenceVectors": expected.tolist(), "referenceMs": reference_ms}
        vectors = normalized_cls(boundary_infer(session, inputs, destination, metadata))
        inference_ms = (time.perf_counter() - actual_start) * 1000
        comparison = compare_vectors(vectors, expected, cell["caseIds"])
        passed = comparison["minimumCosine"] >= VECTOR_COSINE_FLOOR and comparison["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        batch_comparison = None
        if len(cell["caseIds"]) == 1:
            singles[cell["caseIds"][0]] = vectors[0]
        else:
            batch_comparison = compare_vectors(vectors, np.asarray([singles[i] for i in cell["caseIds"]]), cell["caseIds"])
            passed = passed and batch_comparison["minimumCosine"] >= VECTOR_COSINE_FLOOR and batch_comparison["maximumAbsoluteError"] <= VECTOR_MAX_ABS_ERROR
        all_vector_gates_passed = all_vector_gates_passed and bool(passed)
        report = {**metadata,
                  "inputShapeActuallyInferred": list(inputs["input_ids"].shape), "tokenLengths": lengths,
                  "tokenIdsEqual": True, "inputIds": inputs["input_ids"].tolist(),
                  "referenceVectors": expected.tolist(), "actualVectors": vectors.tolist(),
                  "referenceParity": comparison, "singleBatchParity": batch_comparison,
                  "passedFixedVectorGates": bool(passed), "inferenceMs": inference_ms,
                  "referenceMs": reference_ms, "wallMs": (time.perf_counter() - started) * 1000,
                  "versions": {p: package_version(p) for p in ["torch", "transformers", "onnxruntime", "tokenizers"]}}
        with (destination / (cell["id"] + ".json")).open("x") as handle:
            json.dump(report, handle)
        print("boundary cell", cell["id"], lengths, "fixed gates", passed, flush=True)
    profile = Path(session.end_profiling())
    nodes = [event for event in json.loads(profile.read_text()) if event.get("cat") == "Node" and event.get("args", {}).get("provider")]
    providers = sorted({event["args"]["provider"] for event in nodes})
    if provider not in providers or (device == "cuda" and not any(event["args"].get("provider") == provider
            and event["args"].get("op_name") in ("MatMul", "Gemm", "Attention", "FusedMatMul") for event in nodes)):
        raise ValueError(f"profiling does not prove requested compute provider: {providers}")
    ordered = [case["id"] for case in request["cases"] if case["id"] in singles]
    actual_vectors = np.asarray([singles[i] for i in ordered])
    reference_vectors = np.asarray([json.loads((destination / ("single-" + i + ".json")).read_text())["referenceVectors"][0] for i in ordered])
    # Stable ordering over the same eight frozen inputs, including near ties.
    ranks = lambda vectors: np.argsort(-(vectors @ vectors.T), axis=1, kind="stable").tolist()
    ranking_equal = ranks(actual_vectors) == ranks(reference_vectors)
    summary = {"formatVersion": 1, "requestSha256": file_sha256(request_file),
               "deviceRecipe": metadata["deviceRecipe"], "providerOptions": session.get_provider_options(),
               "actualProviderVerifiedByProfile": True, "providersWithExecutedKernels": providers,
               "profile": {"path": str(profile), "sha256": file_sha256(profile)},
               "rankingsEqual": ranking_equal, "passedFixedVectorGates": all_vector_gates_passed,
               "diagnosticOnly": bool(selected_cell), "fullPopulationCompatible": bool(not selected_cell and all_vector_gates_passed and ranking_equal),
               "notChecked": [identifier for identifier in promised_cells if identifier not in [cell["id"] for cell in cells]],
               "actualRankings": ranks(actual_vectors), "referenceRankings": ranks(reference_vectors),
               "peakRssMB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
               "cells": [cell["id"] for cell in cells]}
    with (destination / "summary.json").open("x") as handle:
        json.dump(summary, handle, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out")
    parser.add_argument("--export-onnx", help="New local Transformers.js model directory")
    parser.add_argument("--validate-onnx", help="Validate and finalize an existing ONNX export")
    parser.add_argument("--reference-native", help="Qualify incumbent native results against pinned Python ONNX/tokenizer reference")
    parser.add_argument("--freeze-boundaries", help="Freeze new input/batch cells using an existing pinned export")
    parser.add_argument("--boundary-request", help="Measure actual graph inference against independently tokenized pinned PyTorch")
    parser.add_argument("--boundary-device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--boundary-cell", help="One declared diagnostic cell plus its single-input batch baselines, never full-population proof")
    parser.add_argument("--boundary-cuda-tf32", choices=["0", "1"], help="Explicit separately identified CUDA arithmetic recipe")
    parser.add_argument("--corpus", choices=["memory", "prose", "both"], default="both")
    args = parser.parse_args()
    if args.freeze_boundaries:
        if not args.out:
            parser.error("--freeze-boundaries requires --out")
        freeze_boundary_request(args.freeze_boundaries, args.out)
        return
    if args.boundary_request:
        if not args.out:
            parser.error("--boundary-request requires a new --out directory")
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        measure_boundaries(args.boundary_request, args.boundary_device, args.out,
                           args.boundary_cell, args.boundary_cuda_tf32)
        return
    if args.reference_native:
        if not args.out:
            parser.error("--reference-native requires --out")
        qualify_incumbent_reference(args.reference_native, args.out)
        return
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    if args.export_onnx:
        export_onnx(args.export_onnx)
        return
    if args.validate_onnx:
        finalize_existing_onnx(args.validate_onnx)
        return
    if not args.out:
        parser.error("--out is required for a vector run")
    started = time.perf_counter()
    model = SentenceTransformer(MODEL, revision=REVISION, device="cpu",
                                model_kwargs={"attn_implementation": "sdpa"})
    # Model loading and warmup are reported separately from inference.
    for kind in ["query", "document"]:
        model.encode(["warmup"], prompt_name=kind, normalize_embeddings=True)
    cache = Path(snapshot_download(MODEL, revision=REVISION, local_files_only=True))
    report = {"name": "mdenseon-python", "model": MODEL, "revision": REVISION,
              "runtime": "python-sentence-transformers-cpu-fp32", "dimensions": 768,
              "pooling": "cls", "prompts": dict(model.prompts),
              "versions": {p: importlib.metadata.version(p) for p in ["torch", "transformers", "sentence-transformers"]},
              "loadSeconds": time.perf_counter() - started,
              "assetBytes": sum(p.stat().st_size for p in cache.rglob("*") if p.is_file()),
              "suites": {}}
    fixtures = Path(__file__).resolve().parent / "fixtures"
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    for corpus in (["memory", "prose"] if args.corpus == "both" else [args.corpus]):
        prefix = "prose-" if corpus == "prose" else ""
        corpus_file = fixtures / f"{prefix}corpus.v1.json"
        gold_file = fixtures / f"{prefix}gold-set.v1.json"
        entries = json.loads(corpus_file.read_text())["entries"]
        queries = json.loads(gold_file.read_text())["queries"]
        suite = {"corpusSha256": hashlib.sha256(corpus_file.read_bytes()).hexdigest(),
                 "goldSha256": hashlib.sha256(gold_file.read_bytes()).hexdigest(),
                 "keys": [e["key"] for e in entries], "queryIds": [q["id"] for q in queries]}
        for kind, texts, vector_key, time_key in [
            ("document", [e["text"] for e in entries], "docVectors", "docSeconds"),
            ("query", [q["query"] for q in queries], "queryVectors", "querySeconds")]:
            vectors = []
            t0 = time.perf_counter()
            for index, text in enumerate(texts):
                vector = model.encode([text], prompt_name=kind, normalize_embeddings=True,
                                      convert_to_numpy=True, batch_size=1)[0]
                vectors.append(vector.tolist())
                if (index + 1) % 50 == 0:
                    print(f"[{corpus}/{kind}] {index + 1}/{len(texts)}", flush=True)
            suite[vector_key] = vectors
            suite[time_key] = time.perf_counter() - t0
        suite["peakRssMB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        report["suites"][corpus] = suite
        # Each completed suite survives interruption of the next pass.
        temporary = out.with_suffix(out.suffix + ".tmp")
        temporary.write_text(json.dumps(report))
        temporary.replace(out)
        print(f"completed {corpus}: {suite['docSeconds']:.1f}s docs, {suite['querySeconds']:.1f}s queries -> {out}", flush=True)


if __name__ == "__main__":
    main()
