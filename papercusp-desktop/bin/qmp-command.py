#!/usr/bin/env python3
"""Run one QMP command with an explicit single-client greeting diagnostic.

QEMU's unix QMP chardev accepts a second client but sends it no greeting while
the first client owns the slot.  Exit 75 (EX_TEMPFAIL) reserves that case so
callers can report socket contention instead of misdiagnosing a wedged QEMU
main loop.

QMP interleaves asynchronous events ({"event": ...}) with command replies, so a
reply read skips event lines instead of taking the next line as the reply.  A
guest in a firmware reset loop emits RESET about once a second (EI-24019740313758959);
without the skip, query-status read a RESET event as its reply and reported
"VM is not running" at random.

`status-events SECONDS` is the watchdog mode (WI-10002582): run query-status,
keep the single-client slot for a bounded window, and print one JSON object
{"status", "running", "events": {NAME: count}, "window_sec"} counting every
event seen from connect to window end.  It never sends a state-changing command.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time
from typing import NoReturn


GREETING_TIMEOUT_EXIT = 75  # sysexits.h EX_TEMPFAIL: another client may release the slot


def fail(message: str, code: int = 1) -> NoReturn:
    print(f"qmp-command: {message}", file=sys.stderr)
    raise SystemExit(code)


MAX_EVENTS_BEFORE_REPLY = 10000


def count_event(events: dict[str, int], parsed: dict[str, object]) -> None:
    name = str(parsed.get("event") or "UNKNOWN")
    events[name] = events.get(name, 0) + 1


def read_reply(stream, execute: str, events: dict[str, int]) -> dict[str, object]:
    """Read the reply to `execute`, counting (not returning) interleaved events."""
    for _ in range(MAX_EVENTS_BEFORE_REPLY):
        try:
            line = stream.readline()
        except socket.timeout:
            fail(f"QMP {execute} response timed out")
        if not line:
            fail(f"QMP socket closed before {execute} response")
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            fail(f"invalid QMP {execute} response: {exc}")
        if isinstance(parsed, dict) and "event" in parsed:
            count_event(events, parsed)
            continue
        if not isinstance(parsed, dict):
            fail(f"invalid QMP {execute} response: not an object")
        return parsed
    fail(f"QMP {execute} reply never arrived: more than {MAX_EVENTS_BEFORE_REPLY} events first")


def watch_events(sock: socket.socket, stream, window: float, events: dict[str, int]) -> None:
    deadline = time.monotonic() + window
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        sock.settimeout(remaining)
        try:
            line = stream.readline()
        except (socket.timeout, TimeoutError):
            return
        if not line:
            return
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "event" in parsed:
            count_event(events, parsed)


def main() -> int:
    if len(sys.argv) < 3:
        fail("usage: qmp-command.py SOCKET COMMAND [SCREENDUMP_PATH | WINDOW_SEC]")

    qmp_sock, execute = sys.argv[1:3]
    timeout = float(os.environ.get("PAPERCUSP_QMP_TIMEOUT_SEC", "4"))
    if timeout <= 0:
        fail("PAPERCUSP_QMP_TIMEOUT_SEC must be positive")

    window = 0.0
    payload: dict[str, object] = {"execute": execute}
    if execute == "status-events":
        if len(sys.argv) != 4:
            fail("status-events requires a window in seconds")
        try:
            window = float(sys.argv[3])
        except ValueError:
            fail("status-events window must be a number of seconds")
        if not 0 < window <= 60:
            fail("status-events window must be in (0, 60] seconds")
        payload = {"execute": "query-status"}
    elif execute == "send-key":
        payload["arguments"] = {"keys": [{"type": "qcode", "data": "ret"}]}
    elif execute == "screendump":
        if len(sys.argv) != 4 or not sys.argv[3]:
            fail("screendump requires an output PPM path")
        payload["arguments"] = {"filename": sys.argv[3]}
    elif len(sys.argv) != 3:
        fail(f"unexpected argument for {execute}")

    sock = socket.socket(socket.AF_UNIX)
    try:
        sock.settimeout(timeout)
        try:
            sock.connect(qmp_sock)
        except OSError as exc:
            fail(f"unable to connect to {qmp_sock}: {exc}")

        stream = sock.makefile("rwb", buffering=0)
        try:
            try:
                greeting = stream.readline()
            except socket.timeout:
                fail(
                    "QMP greeting timed out after connection; another client may hold "
                    "the single-client socket (QEMU main loop is not proven wedged)",
                    GREETING_TIMEOUT_EXIT,
                )
            if not greeting:
                fail("QMP socket closed before greeting")

            events: dict[str, int] = {}
            try:
                stream.write(b'{"execute":"qmp_capabilities"}\n')
            except socket.timeout:
                fail("QMP capabilities response timed out")
            capabilities_reply = read_reply(stream, "qmp_capabilities", events)
            if "error" in capabilities_reply:
                fail(f"QMP capabilities error: {capabilities_reply['error']}")

            try:
                stream.write((json.dumps(payload) + "\n").encode())
            except socket.timeout:
                fail(f"QMP {execute} response timed out")
            parsed = read_reply(stream, str(payload["execute"]), events)
            if "error" in parsed:
                fail(f"QMP {execute} error: {parsed['error']}")
            if execute == "status-events":
                returned = parsed.get("return")
                if not isinstance(returned, dict):
                    fail("QMP query-status returned no status object")
                watch_events(sock, stream, window, events)
                print(json.dumps({
                    "status": returned.get("status"),
                    "running": returned.get("running") is True,
                    "events": events,
                    "window_sec": window,
                }))
                return 0
            if execute == "query-status" and parsed.get("return", {}).get("running") is not True:
                fail("VM is not running")
        finally:
            stream.close()
    finally:
        sock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
