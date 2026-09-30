"""
HiveSolver unit tests (plan benchmark-suite-paperbench-2026-06-17). Exercises the full `_run_agent` flow —
download paper context -> drive hive -> upload submission -> AgentOutput — over a FAKE computer + a
monkeypatched `_drive_hive`, with NO operator / NO docker / NO LLM. Runs in the PaperBench uv env (it imports
the REAL paperbench BasePBSolver / AgentOutput / ComputerInterface), NOT papercup's vitest CI:

  cd ~/.papercusp/bench-harnesses/preparedness/project/paperbench
  PYTHONPATH=/home/dev/papercupai-workspace/papercup/packages/operator-core/lib/external-bench/paperbench \
    uv run pytest -q test_hive_solver.py
"""

from __future__ import annotations

import types
from pathlib import Path

import pytest

import hive_solver
from hive_solver import HiveSolver
from paperbench.nano.structs import AgentOutput


class FakeComputer:
    """Records uploads + shell commands; serves synthetic paper bytes for any download."""

    def __init__(self) -> None:
        self.uploads: dict[str, bytes] = {}
        self.shell: list[str] = []
        self.downloaded: list[str] = []

    async def download(self, path: str) -> bytes:
        self.downloaded.append(path)
        return f"CONTENT::{path}".encode()

    async def upload(self, data: bytes, dest: str) -> None:
        self.uploads[dest] = data

    async def check_shell_command(self, cmd: str, *, idempotent: bool = False):
        self.shell.append(cmd)
        return types.SimpleNamespace(output=b"", exit_code=0)


def _task(code_only: bool = True, run_id: str = "run-1", paper_id: str = "rice"):
    return types.SimpleNamespace(
        run_id=run_id, paper_id=paper_id, judge=types.SimpleNamespace(code_only=code_only)
    )


async def _no_existing(_task) -> None:
    return None


@pytest.fixture(autouse=True)
def _patch_existing(monkeypatch):
    # No resume by default — the flow runs the agent.
    monkeypatch.setattr(hive_solver, "check_for_existing_run", _no_existing)


def _writes_submission(files: dict[str, str]):
    async def fake_drive(self, task, paper_dir: Path, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for rel, content in files.items():
            p = out_dir / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)

    return fake_drive


@pytest.mark.asyncio
async def test_clean_flow_downloads_paper_drives_hive_uploads_submission(monkeypatch):
    monkeypatch.setattr(
        HiveSolver, "_drive_hive", _writes_submission({"reproduce.sh": "#!/bin/bash\n", "src/model.py": "# m\n"})
    )
    s = HiveSolver()
    comp = FakeComputer()
    out = await s._run_agent(comp, _task())

    assert isinstance(out, AgentOutput)
    assert out.status_exists is True
    assert out.error_msg is None
    # paper context was pulled out of the sandbox
    assert any("instructions.txt" in p for p in comp.downloaded)
    assert any("paper/paper.md" in p for p in comp.downloaded)
    # the produced submission tree was uploaded under SUBMISSION_DIR, parents mkdir'd
    assert set(comp.uploads.keys()) == {"/home/submission/reproduce.sh", "/home/submission/src/model.py"}
    assert "mkdir -p /home/submission" in comp.shell
    assert "mkdir -p /home/submission/src" in comp.shell


@pytest.mark.asyncio
async def test_empty_submission_is_flagged(monkeypatch):
    monkeypatch.setattr(HiveSolver, "_drive_hive", _writes_submission({}))  # produces nothing
    out = await HiveSolver()._run_agent(FakeComputer(), _task())
    assert out.status_exists is False
    assert "empty submission" in (out.error_msg or "")


@pytest.mark.asyncio
async def test_drive_failure_is_captured_never_raises(monkeypatch):
    async def boom(self, task, paper_dir, out_dir):
        raise RuntimeError("driver exit 1")

    monkeypatch.setattr(HiveSolver, "_drive_hive", boom)
    out = await HiveSolver()._run_agent(FakeComputer(), _task())  # must NOT raise
    assert out.status_exists is False
    assert "driver exit 1" in (out.error_msg or "")


@pytest.mark.asyncio
async def test_existing_run_is_resumed(monkeypatch):
    prior = AgentOutput(
        run_id="run-1", time_start=0.0, time_end=1.0, error_msg=None, runtime_in_seconds=1.0, status_exists=True
    )

    async def _has_existing(_task):
        return prior

    monkeypatch.setattr(hive_solver, "check_for_existing_run", _has_existing)
    # _drive_hive must NOT be called when resuming
    async def must_not_run(self, task, paper_dir, out_dir):
        raise AssertionError("should not drive on resume")

    monkeypatch.setattr(HiveSolver, "_drive_hive", must_not_run)
    out = await HiveSolver()._run_agent(FakeComputer(), _task())
    assert out is prior


def test_instantiates_and_shortname():
    s = HiveSolver()
    assert s.shortname() == "papercup-hive"
    assert s.arm == "hive"
    assert s.budget_usd == 40.0
