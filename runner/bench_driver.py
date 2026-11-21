"""Shared file workload and Codex stdout timing for bench-live.mjs."""
import atexit
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def file_workload(action, scratch=None):
    if action == "read":
        total = 0
        for directory, _, names in os.walk("."):
            for name in names:
                file = Path(directory, name)
                if not file.is_symlink() and file.is_file():
                    with file.open("rb") as stream:
                        while chunk := stream.read(256 * 1024):
                            total += len(chunk)
        print(total)
        return
    directory = Path.cwd().resolve() / scratch
    if directory.resolve().parent != Path.cwd().resolve():
        raise ValueError("Expected a scratch directory inside the benchmark clone")
    directory.mkdir()
    try:
        data = b"x" * 4096
        for index in range(500):
            (directory / str(index)).write_bytes(data)
    finally:
        if directory.resolve().parent != Path.cwd().resolve() or directory.is_symlink():
            raise ValueError("Scratch directory moved before cleanup")
        shutil.rmtree(directory)
    print("500 files x 4096 bytes")


def fake_codex(command, entered):
    sidecar = Path(command[command.index("-o") + 1]).with_name("bench-fake.json")

    @atexit.register
    def record_exit():
        sidecar.write_text(json.dumps({"entered_epoch_ms": entered, "exiting_epoch_ms": time.time_ns() / 1_000_000}),
                           encoding="utf-8")

    sys.stdin.buffer.read()
    print('{"type":"thread.started","thread_id":"bench-fake"}', flush=True)
    print('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}', flush=True)


def trace_codex(command):
    sidecar = Path(command[command.index("-o") + 1]).with_name("bench-events.json")
    launch_ms = time.time_ns() / 1_000_000
    clock = time.monotonic_ns()
    trace = {"launch_epoch_ms": launch_ms, "events_ms": []}
    with subprocess.Popen(command, stdout=subprocess.PIPE) as proc:
        trace["codex_pid"] = proc.pid
        for line in proc.stdout:
            received = (time.monotonic_ns() - clock) / 1_000_000
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
            try:
                event = json.loads(line)
            except (ValueError, UnicodeError):
                continue
            if isinstance(event, dict) and event.get("type") != "runner.phase":
                trace["events_ms"].append(received)
        code = proc.wait()
    trace["cli_exit_ms"] = (time.monotonic_ns() - clock) / 1_000_000
    sidecar.write_text(json.dumps(trace), encoding="utf-8")
    return code


def read_job(directory):
    job = Path(directory)
    files = {}
    for name in ("events.jsonl", "bench-events.json", "bench-fake.json", "result.json", "stderr.log"):
        file = job / name
        if file.exists():
            files[name] = file.read_text(encoding="utf-8", errors="replace")
    if "result.json" in files:
        files["receipt_epoch_ms"] = (job / "result.json").stat().st_mtime_ns / 1_000_000
    if "bench-fake.json" in files and (job / "worker.start").exists():
        start = (job / "worker.start").read_text().strip()
        if start and os.name == "nt":
            files["worker_epoch_ms"] = (int(start) - 116444736000000000) / 10_000  # FILETIME to Unix epoch
        elif start:
            files["worker_epoch_ms"] = (time.time_ns() - time.clock_gettime_ns(time.CLOCK_BOOTTIME)) / 1_000_000 \
                + int(start) * 1000 / os.sysconf("SC_CLK_TCK")
    print(json.dumps(files))


if __name__ == "__main__":
    action, *args = sys.argv[1:]
    if action == "FAKE_CODEX":
        fake_codex(args, time.time_ns() / 1_000_000)
    elif action == "trace":
        sys.exit(trace_codex(args))
    elif action == "job":
        read_job(*args)
    elif action == "clock":
        print(time.time_ns() / 1_000_000)
    elif action in ("read", "write"):
        file_workload(action, *args)
    else:
        raise SystemExit(f"Unknown benchmark action: {action}")
