#!/usr/bin/env python3
"""Drives `vault interactive --tui` (the BUILT binary) inside a real pseudo-terminal.

Run with `python3 -I` from tui-paste.e2e.test.ts. The child gets the sandbox environment from
--env-file plus a PATH that starts with a directory of stub clipboard tools; each stub drains its
stdin and appends one line to --clip-log, so a copy that reached the system clipboard is counted
without touching the real one. Prints exactly one JSON line with the timings observed.

Scenarios: paste-bracketed, paste-split-start-marker, paste-raw, paste-raw-ansi,
paste-raw-embedded-markers, paste-embedded-markers-then-keys, random (--seed), enter,
lock (--db, --hold-seconds).
Every scenario ends with Ctrl+C half a second after its last byte; one hard deadline covers it all.
"""

import argparse
import fcntl
import json
import os
import pty
import random
import re
import select
import signal
import sqlite3
import stat
import struct
import sys
import termios
import threading
import time

READY_MARKER = b"Search commands"
FRAME_MARKER = b"some comment"
ANSI_FRAME_MARKER = b"fourth line"
FAVORITE_ERROR = b"Could not save the favorite"
COPIED_MARKER = b"Copied:"
# The search box row showing the first pasted line as the whole query (the entry names also hold
# "demo", so the prompt is part of the marker).
QUERY_MARKER = b"> demo"
COPY_WAIT_S = 15.0
PASTE_START = b"\x1b[200~"
PASTE_END = b"\x1b[201~"
# Clipboard text pasted raw that itself carries a bracketed paste marker pair, then a CR and a
# Ctrl+F: Ink emits the pair's body as a paste and the bytes after it as keys, all in one read.
# Every byte of it was pasted, so the CR must not copy and the Ctrl+F must not toggle a favorite.
# Sent alone, the pair's body must name the fixture entries: should the CR and the Ctrl+F fire as
# keys after all, they then find a selected entry to copy and to favorite, which the probe counts;
# a body matching nothing would pass with the keys fired, their actions finding no entry.
EMBEDDED_MARKER_PAIR = PASTE_START + b"x" + PASTE_END
EMBEDDED_MARKER_PAIR_ALONE = PASTE_START + b"demo" + PASTE_END
BRACKETED_ON = b"\x1b[?2004h"
BRACKETED_OFF = b"\x1b[?2004l"
CTRL_C = b"\x03"
CTRL_F = b"\x06"
ENTER = b"\r"
PASTED_LINES = 150
FIRST_PASTED_LINE = "demo\n"
RANDOM_BYTES = 4096
SETTLE_S = 0.2
TYPE_SETTLE_S = 0.3
QUIT_DELAY_S = 0.5
# Well past Ink's 20 ms pending-escape flush: the first bytes of a start marker reach the TUI alone.
MARKER_GAP_S = 0.15
# `\e[20`: the longest start-marker prefix Ink flushes rather than holds (input-parser.js).
FLUSHED_MARKER_BYTES = 4
READ_CHUNK = 65536
TAIL_CHARS = 600
CLIP_TOOLS = ("pbcopy", "xsel", "xclip", "wl-copy")
# Ink styles the frame (the placeholder's first letter is inverse), so markers are matched on
# the text with every CSI sequence removed.
ANSI_SEQUENCE = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]")
# The search box row of a frame: a box border, the prompt, the query, the cursor cell and padding.
QUERY_ROW = re.compile("│ > (.*?)\\s*│".encode())


def paste_body() -> bytes:
    """A first line that names the fixture entries, then 150 lines of code.

    Decoded as keys, the first line's Enter lands on a real search hit and copies it, which is the
    defect (a pasted `cmd7` copied `/cmd7`); a body matching nothing would hide a broken paste path
    behind an Enter that finds no entry.
    """
    lines = (
        f"def function_{n}(arg): return arg * {n}  # some comment\n"
        for n in range(1, PASTED_LINES + 1)
    )
    return (FIRST_PASTED_LINE + "".join(lines)).encode()


def coloured_paste_body() -> bytes:
    """A short first line, then text coloured the way grep and ls colour theirs, pasted raw.

    Ink cuts a read at every escape sequence, so the first line reaches the key handler as its own
    event before anything in the read shows it is a paste; decided per event, its newline is Enter.
    The codes are ones Ink's key parser does not resolve (bold, reset without a parameter, grep's
    bold red and erase-to-end, 16-colour yellow): they reach the key handler as their tails, ESC
    removed, and a handler that types them shows "[1mbold[m" in the box. `\\x1b[32m` would hide
    that: Ink happens to read it as a modified key, so it vanishes whatever the handler does.
    """
    return (
        FIRST_PASTED_LINE.encode()
        + b"\x1b[1mbold\x1b[m\n"
        + b"\x1b[01;31m\x1b[Kmatch\x1b[m\x1b[K\n"
        + b"\x1b[33myellow\x1b[0m third line\n"
        + ANSI_FRAME_MARKER
        + b"\n"
    )


def write_clip_stubs(stub_dir: str, clip_log: str) -> None:
    os.makedirs(stub_dir, exist_ok=True)
    script = f"#!/bin/sh\ncat > /dev/null\nprintf 'copy\\n' >> '{clip_log}'\n"
    for tool in CLIP_TOOLS:
        path = os.path.join(stub_dir, tool)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(script)
        os.chmod(
            path,
            stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH,
        )


def child_env(env_file: str, stub_dir: str) -> dict:
    with open(env_file, encoding="utf-8") as handle:
        env = {key: str(value) for key, value in json.load(handle).items()}
    env["PATH"] = stub_dir + os.pathsep + env.get("PATH", "")
    env.pop("CI", None)  # Ink draws no frames at all when it believes it runs in CI
    env.setdefault("TERM", "xterm-256color")
    return env


class Deadline(Exception):
    pass


class Terminal:
    """The child on the slave side of a pty; everything it writes is kept in `output`."""

    def __init__(self, argv, env, rows, cols, deadline_s):
        self.output = bytearray()
        self.exit_status = None
        self.deadline = time.monotonic() + deadline_s
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(1, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.execvpe(argv[0], argv, env)
        self.pid, self.fd = pid, fd
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    @staticmethod
    def ms_since(start: float) -> int:
        return int((time.monotonic() - start) * 1000)

    def check_deadline(self) -> None:
        if time.monotonic() > self.deadline:
            raise Deadline()

    def pump(self, wait_s: float) -> None:
        """Reads what the child wrote, waiting up to wait_s for something to arrive."""
        self.check_deadline()
        readable, _, _ = select.select([self.fd], [], [], wait_s)
        if not readable:
            return
        try:
            data = os.read(self.fd, READ_CHUNK)
        except OSError:  # EIO: the slave side closed
            self.exited()
            return
        self.output += data

    def exited(self) -> bool:
        if self.exit_status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid == self.pid:
                self.exit_status = os.waitstatus_to_exitcode(status)
        return self.exit_status is not None

    def write_all(self, data: bytes) -> bool:
        """Feeds the child; the kernel takes a pty's input in small pieces, so this loops."""
        offset = 0
        while offset < len(data):
            self.check_deadline()
            if self.exited():
                return False
            try:
                offset += os.write(self.fd, data[offset:])
            except BlockingIOError:
                self.pump(0.02)
            except OSError:
                return False
            else:
                self.pump(0)
        return True

    def has_marker(self, marker: bytes, since: int) -> bool:
        """True when `marker` is in the text the child wrote from offset `since` on, styling removed."""
        window = self.output[max(0, since - TAIL_CHARS) :]
        return marker in ANSI_SEQUENCE.sub(b"", bytes(window))

    def wait_for(self, marker: bytes, since: int, timeout_s: float):
        """Milliseconds until `marker` shows up in output written after offset `since`, else None."""
        start = time.monotonic()
        while True:
            if self.has_marker(marker, since):
                return self.ms_since(start)
            if self.exited() or time.monotonic() - start > timeout_s:
                return None
            self.pump(0.02)

    def query_line(self):
        """What the search box showed in the last frame drawn, or None when no frame had it."""
        rows = QUERY_ROW.findall(ANSI_SEQUENCE.sub(b"", bytes(self.output)))
        return rows[-1].decode("utf-8", errors="replace") if rows else None

    def sleep(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            self.pump(min(0.05, max(0, end - time.monotonic())))

    def quit(self) -> dict:
        """Ctrl+C, then waits for the exit; reports how long the child took to go."""
        if self.exited():
            return {"ctrl_c_to_exit_ms": 0, "exited_before_ctrl_c": True}
        self.write_all(CTRL_C)
        start = time.monotonic()
        while not self.exited():
            self.pump(0.05)
        self.drain()
        return {
            "ctrl_c_to_exit_ms": self.ms_since(start),
            "exited_before_ctrl_c": False,
        }

    def drain(self) -> None:
        for _ in range(20):
            readable, _, _ = select.select([self.fd], [], [], 0.05)
            if not readable:
                break
            try:
                data = os.read(self.fd, READ_CHUNK)
            except OSError:
                break
            if not data:
                break
            self.output += data

    def kill(self) -> None:
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if self.exit_status is None:
            _, status = os.waitpid(self.pid, 0)
            self.exit_status = os.waitstatus_to_exitcode(status)


def run_paste(term: Terminal, data: bytes, marker: bytes, late_from: int = 0) -> dict:
    """Pastes `data`; with `late_from`, its first bytes go first and the rest MARKER_GAP_S later.

    Ink flushes a pending `\\e[2` or `\\e[20` to the key handler as text after 20 ms (only `\\e[200`
    and a whole marker are held back), so a start marker cut by a slow link reaches the TUI as the
    text `[20`, then `0~` and the body as plain keys, whose newlines would be Enter.
    """
    since = len(term.output)
    start = time.monotonic()
    if late_from:
        term.write_all(data[:late_from])
        term.sleep(MARKER_GAP_S)
        data = data[late_from:]
    term.write_all(data)
    write_ms = term.ms_since(start)
    frame_update_ms = term.wait_for(marker, since, QUIT_DELAY_S)
    term.sleep(max(0, QUIT_DELAY_S - (time.monotonic() - start)))
    query_line = term.query_line()
    result = term.quit()
    if frame_update_ms is None and term.has_marker(marker, since):
        frame_update_ms = term.ms_since(
            start
        )  # it arrived after the quit was requested
    return {
        "write_ms": write_ms,
        "frame_update_ms": frame_update_ms,
        "query_line": query_line,
        **result,
    }


def run_random(term: Terminal, seed: int) -> dict:
    random.seed(seed)
    data = bytes(random.getrandbits(8) for _ in range(RANDOM_BYTES))
    start = time.monotonic()
    term.write_all(data)
    write_ms = term.ms_since(start)
    term.sleep(QUIT_DELAY_S)
    return {"write_ms": write_ms, "frame_update_ms": None, **term.quit()}


def run_enter(term: Terminal) -> dict:
    start = time.monotonic()
    term.write_all(b"demo")
    term.sleep(TYPE_SETTLE_S)
    since = len(term.output)
    term.write_all(ENTER)
    write_ms = term.ms_since(start)
    # The copy runs a clipboard tool and then records the use; quitting earlier would lose both.
    copied_ms = term.wait_for(COPIED_MARKER, since, COPY_WAIT_S)
    term.sleep(QUIT_DELAY_S)
    return {"write_ms": write_ms, "frame_update_ms": copied_ms, **term.quit()}


def run_lock(term: Terminal, db_path: str, hold_s: float) -> dict:
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"no vault database at {db_path}")
    acquired = threading.Event()
    released = threading.Event()

    def hold():
        connection = sqlite3.connect(db_path, timeout=hold_s, isolation_level=None)
        connection.execute("BEGIN EXCLUSIVE")
        acquired.set()
        time.sleep(hold_s)
        connection.execute("COMMIT")
        connection.close()
        released.set()

    holder = threading.Thread(target=hold, daemon=True)
    lock_start = time.monotonic()
    holder.start()
    while not acquired.is_set():
        term.pump(0.02)
    lock_acquired_ms = term.ms_since(lock_start)

    term.write_all(b"demo")
    term.sleep(TYPE_SETTLE_S)
    since = len(term.output)
    start = time.monotonic()
    term.write_all(CTRL_F)
    message_ms = term.wait_for(FAVORITE_ERROR, since, hold_s + 5)
    while not released.is_set():
        term.pump(0.05)
    term.sleep(QUIT_DELAY_S)
    return {
        "write_ms": term.ms_since(start),
        "frame_update_ms": None,
        "lock_acquired_ms": lock_acquired_ms,
        "message_ms": message_ms,
        **term.quit(),
    }


def count_lines(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path, "rb") as handle:
        return sum(1 for _ in handle)


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "scenario",
        choices=[
            "paste-bracketed",
            "paste-split-start-marker",
            "paste-raw",
            "paste-raw-ansi",
            "paste-raw-embedded-markers",
            "paste-embedded-markers-then-keys",
            "random",
            "enter",
            "lock",
        ],
    )
    parser.add_argument("--node", required=True)
    parser.add_argument("--cli", required=True)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--clip-log", required=True)
    parser.add_argument("--rows", type=int, default=40)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--db", default=None, help="vault.db to lock (scenario lock)")
    parser.add_argument("--hold-seconds", type=float, default=30.0)
    parser.add_argument(
        "--deadline", type=float, default=60.0, help="hard deadline in seconds"
    )
    return parser.parse_args()


def run_scenario(term: Terminal, args) -> dict:
    if args.scenario == "paste-bracketed":
        return run_paste(term, PASTE_START + paste_body() + PASTE_END, FRAME_MARKER)
    if args.scenario == "paste-split-start-marker":
        # One short line: as keys its newline is Enter, and the whole query fits the box row.
        data = PASTE_START + FIRST_PASTED_LINE.encode() + PASTE_END
        return run_paste(term, data, QUERY_MARKER, late_from=FLUSHED_MARKER_BYTES)
    if args.scenario == "paste-raw":
        return run_paste(term, paste_body(), FRAME_MARKER)
    if args.scenario == "paste-raw-ansi":
        return run_paste(term, coloured_paste_body(), ANSI_FRAME_MARKER)
    if args.scenario == "paste-raw-embedded-markers":
        # The line before the pair and the CR after it are two line breaks: the read looks pasted
        # before the pair is even considered, so this one exercises the raw-paste rule.
        data = FIRST_PASTED_LINE.encode() + EMBEDDED_MARKER_PAIR + ENTER + CTRL_F
        return run_paste(term, data, QUERY_MARKER)
    if args.scenario == "paste-embedded-markers-then-keys":
        # Nothing but the pair, a CR and a Ctrl+F: only the rule that a read carrying a bracketed
        # paste is text to its last byte keeps the two keys from acting.
        data = EMBEDDED_MARKER_PAIR_ALONE + ENTER + CTRL_F
        return run_paste(term, data, QUERY_MARKER)
    if args.scenario == "random":
        return run_random(term, args.seed)
    if args.scenario == "enter":
        return run_enter(term)
    if args.db is None:
        raise ValueError("scenario lock needs --db")
    return run_lock(term, args.db, args.hold_seconds)


def main() -> int:
    args = parse_args()
    stub_dir = os.path.join(
        os.path.dirname(os.path.abspath(args.clip_log)), "clip-stubs"
    )
    write_clip_stubs(stub_dir, args.clip_log)
    env = child_env(args.env_file, stub_dir)
    argv = [args.node, args.cli, "interactive", "--tui"]
    term = Terminal(argv, env, args.rows, args.cols, args.deadline)
    report = {
        "scenario": args.scenario,
        "seed": args.seed if args.scenario == "random" else None,
    }
    started = time.monotonic()
    status = 0
    try:
        ready_ms = term.wait_for(READY_MARKER, 0, args.deadline)
        report["ready_ms"] = ready_ms
        if ready_ms is None:
            raise RuntimeError("the TUI never drew its search box")
        term.sleep(SETTLE_S)
        report.update(run_scenario(term, args))
    except Deadline:
        term.kill()
        report["error"] = (
            f"hard deadline of {args.deadline:g} s hit after {term.ms_since(started)} ms"
        )
        status = 1
    except Exception as error:  # noqa: BLE001 - reported in the JSON line for the test to show
        term.kill()
        report["error"] = f"{type(error).__name__}: {error}"
        status = 1
    report["exit_status"] = term.exit_status
    report["clip_invocations"] = count_lines(args.clip_log)
    report["saw_2004h"] = BRACKETED_ON in term.output
    report["saw_2004l"] = BRACKETED_OFF in term.output
    plain = ANSI_SEQUENCE.sub(b"", bytes(term.output))
    report["output_tail"] = plain[-TAIL_CHARS:].decode("utf-8", errors="replace")
    print(json.dumps(report), flush=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
