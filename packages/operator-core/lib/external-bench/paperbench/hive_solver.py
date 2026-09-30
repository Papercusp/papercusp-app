"""
PaperBench BYO-solver: **HiveSolver** — drives the Papercup opus hive as a PaperBench solver
(plan benchmark-suite-paperbench-2026-06-17, Code-Dev FIRST).

WHY a solver (not a grader): unlike the SWE-bench suites (we run OUR harness + their grader), PaperBench
runs in ITS OWN harness (nanoeval + alcatraz) with our agent plugged in as a `BasePBSolver` subclass and
selected via the chz flag `paperbench.solver=hive_solver:HiveSolver`. The base `run()` does
setup -> `_run_agent` -> grade; we only implement `_run_agent`.

ARCHITECTURE (Code-Dev). The PaperBench harness drops the paper context into the sandbox `computer` at
`/home/instructions.txt` + `/home/paper/{paper.md,paper.pdf,addendum.md,blacklist.txt}` (paperbench/nano/
task.py) and grades whatever lands in `/home/submission` (= SUBMISSION_DIR). For Code-Dev (`judge.code_only`)
the judge grades ONLY Code-Development leaves — the agent produces the replication CODE + a root
`reproduce.sh` WITHOUT executing it, so NO GPU is needed (the reproduction is decoupled — a fresh
pb-reproducer reruns reproduce.sh later, in full mode).

The Papercup hive runs in its NATIVE environment (local files, our tools, opus). This solver BRIDGES that to
the sandbox by:
  1. downloading the paper context out of the `computer` into a local scratch dir,
  2. driving the opus hive over it (a tsx paper-replication driver — the spine/hive arm seeded with a paper
     instead of a SWE repo, extracting a `/submission` tree instead of a diff) → a local submission dir,
  3. uploading that submission tree back into the sandbox's SUBMISSION_DIR,
  4. returning an `AgentOutput`.

Opus is the only brain anywhere in the loop — the NPCs/judges and this solver all point at opus; the GPU (full
mode, later) only ever executes the paper's training code, never an LLM.

TESTABILITY: `_drive_hive` is the one method that shells out to the (TS) hive driver; tests monkeypatch it +
a fake `computer`, so the whole `_run_agent` flow (download -> drive -> upload -> AgentOutput) is exercised
with NO operator / NO docker / NO LLM. The TS-side paper-replication driver (`driver_script`) is the
counterpart that reuses the in-flux arm machinery — built separately.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from pathlib import Path

import chz
import structlog
from nanoeval.solvers.computer_tasks.code_execution_interface import ComputerInterface
from paperbench.constants import SUBMISSION_DIR, WORKSPACE_BASE
from paperbench.nano.structs import AgentOutput
from paperbench.nano.task import PBTask
from paperbench.solvers.base import BasePBSolver
from paperbench.solvers.utils import check_for_existing_run
from typing_extensions import override

logger = structlog.stdlib.get_logger(component=__name__)

# The paper-context files the harness places in the sandbox (paperbench/nano/task.py). Text files the hive
# reads; the PDF is fetched separately (binary). A missing optional file (e.g. blacklist) is non-fatal.
PAPER_TEXT_FILES: dict[str, str] = {
    "instructions.txt": f"{WORKSPACE_BASE}/instructions.txt",
    "paper.md": f"{WORKSPACE_BASE}/paper/paper.md",
    "addendum.md": f"{WORKSPACE_BASE}/paper/addendum.md",
    "blacklist.txt": f"{WORKSPACE_BASE}/paper/blacklist.txt",
}


@chz.chz
class HiveSolver(BasePBSolver):
    """Drive the Papercup opus hive to replicate a paper, then upload its `/home/submission`."""

    operator_dir: str = chz.field(
        default="/home/dev/papercupai-workspace/papercup",
        doc="The papercup checkout the hive driver runs from (cwd for the tsx driver).",
    )
    driver_script: str = chz.field(
        default="packages/operator-core/lib/external-bench/_pb_hive_solve.ts",
        doc="The tsx paper-replication driver (relative to operator_dir) that runs the hive arm.",
    )
    node_bin: str = chz.field(default="npx", doc="Runner for the tsx driver — invoked as `<node_bin> tsx <script> …`.")
    arm: str = chz.field(default="hive", doc="Which Papercup arm drives it: 'hive' | 'su-independent'.")
    budget_usd: float = chz.field(
        default=40.0, doc="Per-paper iso-budget in USD (owner: no real cap — generous so it isn't truncated)."
    )
    timeout_seconds: int = chz.field(default=4 * 60 * 60, doc="Wall-clock ceiling for one paper's hive drive.")

    @override
    def shortname(self) -> str:
        return "papercup-hive"

    def _code_only(self, task: PBTask) -> bool:
        """True in Code-Dev mode (the judge grades only Code-Development leaves). Defaults to True (the
        Code-Dev-first posture) if the task doesn't expose the flag."""
        try:
            return bool(task.judge.code_only)
        except Exception:
            return True

    async def _download_paper_context(self, computer: ComputerInterface, scratch: Path) -> Path:
        """Pull the paper + instructions out of the sandbox into a local scratch dir for the hive to read."""
        paper_dir = scratch / "paper"
        paper_dir.mkdir(parents=True, exist_ok=True)
        for local_name, remote_path in PAPER_TEXT_FILES.items():
            try:
                (paper_dir / local_name).write_bytes(await computer.download(remote_path))
            except Exception as e:  # a missing optional file is non-fatal
                logger.info(f"paper context {remote_path} not downloaded: {e}")
        try:
            (paper_dir / "paper.pdf").write_bytes(await computer.download(f"{WORKSPACE_BASE}/paper/paper.pdf"))
        except Exception as e:
            logger.info(f"paper.pdf not downloaded: {e}")
        return paper_dir

    async def _drive_hive(self, task: PBTask, paper_dir: Path, out_dir: Path) -> None:
        """Run the opus hive over the paper → write the replication submission (+ reproduce.sh) into `out_dir`.

        Shells out to the tsx paper-replication driver (the spine/hive arm, paper-seeded). Overridable +
        monkeypatched in tests. Raises on a non-zero exit or a timeout so `_run_agent` records the error.
        """
        out_dir.mkdir(parents=True, exist_ok=True)
        cmd: list[str] = [
            self.node_bin,
            "tsx",
            self.driver_script,
            "--paper-id",
            task.paper_id,
            "--paper-dir",
            str(paper_dir),
            "--out",
            str(out_dir),
            "--arm",
            self.arm,
            "--budget-usd",
            str(self.budget_usd),
        ]
        if self._code_only(task):
            cmd.append("--code-only")
        env = {**os.environ, "PAPERCUSP_PB_RUN_ID": task.run_id}
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=self.operator_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env=env,
        )
        try:
            stdout_bytes, _ = await asyncio.wait_for(proc.communicate(), timeout=self.timeout_seconds)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"hive driver exceeded {self.timeout_seconds}s for paper {task.paper_id}")
        if proc.returncode != 0:
            tail = stdout_bytes.decode("utf-8", "replace")[-2000:]
            raise RuntimeError(f"hive driver exit {proc.returncode} for paper {task.paper_id}: {tail}")

    async def _upload_submission(self, computer: ComputerInterface, out_dir: Path) -> int:
        """Upload the locally-produced submission tree → SUBMISSION_DIR in the sandbox. Returns file count."""
        await computer.check_shell_command(f"mkdir -p {SUBMISSION_DIR}")
        count = 0
        for path in sorted(out_dir.rglob("*")):
            if path.is_dir():
                continue
            rel = path.relative_to(out_dir).as_posix()
            dest = f"{SUBMISSION_DIR}/{rel}"
            parent = dest.rsplit("/", 1)[0]
            if parent != SUBMISSION_DIR:
                await computer.check_shell_command(f"mkdir -p {parent}")
            await computer.upload(path.read_bytes(), dest)
            count += 1
        return count

    @override
    async def _run_agent(self, computer: ComputerInterface, task: PBTask) -> AgentOutput:
        start = time.time()
        existing = await check_for_existing_run(task)
        if existing:
            return existing

        scratch = Path(f"/tmp/papercup-pb-{task.run_id}")
        # Start from a clean scratch so a re-run with the same run_id never uploads stale files.
        shutil.rmtree(scratch, ignore_errors=True)
        out_dir = scratch / "submission"
        error_msg: str | None = None
        try:
            paper_dir = await self._download_paper_context(computer, scratch)
            await self._drive_hive(task, paper_dir, out_dir)
            n = await self._upload_submission(computer, out_dir)
            logger.info(f"HiveSolver uploaded {n} submission files for {task.run_id}")
            if n == 0:
                error_msg = "HiveSolver produced an empty submission (no files in out_dir)"
        except Exception as e:  # never raise out of _run_agent — base.run() still grades whatever exists
            error_msg = f"HiveSolver failed for {task.run_id}: {e}"
            logger.exception(error_msg)

        return AgentOutput(
            run_id=task.run_id,
            time_start=start,
            time_end=time.time(),
            error_msg=error_msg,
            runtime_in_seconds=time.time() - start,
            status_exists=error_msg is None,
        )
