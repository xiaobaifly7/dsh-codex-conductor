"""Run Codex CLI tasks for an agent harness behind a stable JSON contract (Linux / WSL).

    python codex_runner.py run    --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py start  --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py status JOB_ID [--wait SECONDS]
    python codex_runner.py cancel JOB_ID

Every command prints exactly one JSON object on stdout. Raw events go to a log file.
"""
import argparse
import hashlib
import json
import os
import queue
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import tomllib
import uuid
from pathlib import Path
from urllib.parse import urlparse

IS_WIN = os.name == "nt"
if IS_WIN:
    import msvcrt
else:
    import fcntl
    import signal

# Codex keeps its own provider config and credentials, so only sandbox, approval and effort are pinned;
# its MCP servers and hooks stay off unless --use-user-config.
STRIP_USER_EXTRAS = ["--disable", "hooks"]

HOME = Path(os.environ.get("CODEX_RUNNER_HOME") or
            (Path(os.environ.get("LOCALAPPDATA", Path.home())) / "codex-runner" if IS_WIN
             else Path.home() / ".local/state/codex-runner"))
EXIT_GRACE_SECONDS = 20
NO_WINDOW = 0x08000000 if IS_WIN else 0
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

PERMANENT = re.compile(
    r"\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|usage limit|quota|insufficient"
    r"|model.{0,40}(not found|not supported|does not exist)|invalid.{0,20}(config|schema)|unrecognized", re.I)
TRANSIENT = re.compile(
    r"stream disconnected|stream error|timed? ?out|connection|reset by peer|\b429\b|rate.?limit"
    r"|\b50[0234]\b|overloaded|server_error|temporarily|try again", re.I)


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        emit({"status": "failed", "error_kind": "bad_arguments", "error": message, "retryable": False})
        sys.exit(2)


def find_codex():
    """Locate the codex CLI. Inside WSL a PATH entry under /mnt/ is the Windows build, so skip it;
    `wsl.exe -e` also skips the login profile, so check the usual npm/user bin directories too."""
    if IS_WIN:
        return shutil.which("codex")
    for d in os.environ.get("PATH", "").split(os.pathsep):
        candidate = os.path.join(d, "codex")
        if d and not d.startswith("/mnt/") and os.access(candidate, os.X_OK):
            return candidate
    for candidate in (Path.home() / ".npm-global/bin/codex", Path.home() / ".local/bin/codex", Path("/usr/local/bin/codex")):
        if os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def launcher():
    """Return the argv prefix and env; CODEX_RUNNER_CMD (a JSON argv list) overrides the lookup."""
    env = dict(os.environ)
    override = os.environ.get("CODEX_RUNNER_CMD")
    if override:
        return json.loads(override), env
    # A missing CLI fails at spawn with a clear "No such file" error.
    return [find_codex() or "codex"], env


def kill_tree(pid):
    if not IS_WIN:
        try:
            os.killpg(pid, signal.SIGKILL)  # children start in their own session, so the group id is the pid
        except ProcessLookupError:
            pass
        return
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)


def pid_alive(pid):
    if not IS_WIN:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass
        return True
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"], capture_output=True, text=True,
                         errors="replace", creationflags=NO_WINDOW).stdout
    return f'"{pid}"' in out


def router_reachable(timeout=2):
    # Opt-in: set CODEX_RUNNER_ROUTER_URL when Codex talks to a local proxy, so a dead proxy fails fast.
    target = os.environ.get("CODEX_RUNNER_ROUTER_URL", "")
    if target == "":
        return True
    url = urlparse(target)
    try:
        with socket.create_connection((url.hostname, url.port or 443), timeout=timeout):
            return True
    except OSError:
        return False


def acquire_write_lock(cwd):
    """Hold a per-directory lock so a retry can never overlap another writer. The OS frees it if we die."""
    locks = HOME / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(os.path.normcase(os.path.abspath(cwd)).encode("utf-8")).hexdigest()[:16]
    handle = open(locks / f"{key}.lock", "a+b")
    handle.seek(0)
    try:
        if IS_WIN:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def local_path(path):
    """DeepSeek often passes Windows paths; inside WSL map X:\\... to /mnt/x/...."""
    m = re.match(r"^([A-Za-z]):[\\/]*(.*)$", path)
    if IS_WIN or not m:
        return path
    return f"/mnt/{m.group(1).lower()}/" + m.group(2).replace("\\", "/")


def disable_user_mcp_servers():
    """`-c mcp_servers={}` is a no-op in Codex 0.154, so turn off each server named in config.toml.
    Plugin-provided MCP servers are not listed there and are not covered."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    try:
        servers = tomllib.loads((home / "config.toml").read_text("utf-8")).get("mcp_servers")
    except (OSError, ValueError):
        return []
    out = []
    for name in servers if isinstance(servers, dict) else []:
        if "." not in name:  # Codex splits -c keys on '.' and ignores TOML quotes, so dotted names cannot be turned off
            out += ["-c", f"mcp_servers.{name}.enabled=false"]
    return out


def build_command(args, run_dir, thread_id):
    prefix, env = launcher()
    cmd = [*prefix, "exec"]
    if thread_id:
        cmd.append("resume")
    cmd += ["--json", "--skip-git-repo-check", "-o", str(run_dir / "last_message.txt")]
    if not args.use_user_config:
        cmd += STRIP_USER_EXTRAS + disable_user_mcp_servers()
    cmd += ["-c", 'approval_policy="never"']
    if args.model:
        cmd += ["-m", args.model]
    cmd += ["-c", f'model_reasoning_effort="{args.effort}"']
    # Jobs queued before this option existed have no service_tier in args.json.
    if getattr(args, "service_tier", None):
        cmd += ["-c", f'service_tier="{args.service_tier}"']
    # `exec resume` has no -s or -C, so the sandbox goes through -c and the directory through the process cwd.
    cmd += ["-c", f'sandbox_mode="{args.sandbox}"']
    if args.schema:
        cmd += ["--output-schema", args.schema]
    if args.sandbox == "read-only":
        cmd.append("--ephemeral")
    if thread_id:
        cmd.append(thread_id)
    cmd.append("-")
    return cmd, env


def run_attempt(args, prompt, run_dir, thread_id):
    """Run one Codex process to a verdict. turn.completed decides success, not the exit code."""
    cmd, env = build_command(args, run_dir, thread_id)
    state = {"thread_id": thread_id, "completed": False, "failed": False, "error": None, "usage": None,
             "last_text": None, "commands": 0, "forced_exit": False, "end_reason": None, "exit_code": None,
             "file_changes": []}
    start = time.time()
    with open(run_dir / "stderr.log", "ab") as stderr_log, open(run_dir / "events.jsonl", "ab") as event_log:
        try:
            proc = subprocess.Popen(cmd, cwd=args.cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=stderr_log, creationflags=NO_WINDOW, start_new_session=not IS_WIN)
        except OSError as e:
            state["end_reason"] = "spawn_failed"
            state["error"] = str(e)
            return state
        (run_dir / "codex.pid").write_text(str(proc.pid))
        # Closing stdin gives Codex its EOF, and the prompt skips cmd quoting and command-line limits.
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()

        lines = queue.Queue()

        def pump():
            for raw in proc.stdout:
                lines.put(raw)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        last_event = time.time()
        reconnecting_since = None
        completed_at = None
        while True:
            now = time.time()
            if completed_at and now - completed_at > args.exit_grace:
                state["forced_exit"] = True
                kill_tree(proc.pid)
                break
            # With the router down, Codex kept reconnecting for a full 240s test and never failed the turn.
            if not completed_at and reconnecting_since and now - reconnecting_since > args.reconnect_timeout:
                state["end_reason"] = "reconnect_timeout"
                kill_tree(proc.pid)
                break
            if not completed_at and now - start > args.timeout:
                state["end_reason"] = "timeout"
                kill_tree(proc.pid)
                break
            if not completed_at and now - last_event > args.idle_timeout:
                state["end_reason"] = "idle_timeout"
                kill_tree(proc.pid)
                break
            try:
                raw = lines.get(timeout=0.5)
            except queue.Empty:
                continue
            if raw is None:
                break
            event_log.write(raw)
            event_log.flush()
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            kind = ev.get("type")
            item = ev.get("item") or {}
            # Reconnect notices are not progress, so they must not refresh the idle timer.
            if kind == "error":
                reconnecting_since = reconnecting_since or time.time()
            else:
                reconnecting_since = None
                last_event = time.time()
            if kind == "thread.started":
                state["thread_id"] = ev.get("thread_id") or state["thread_id"]
            elif kind == "turn.completed":
                state["completed"] = True
                state["usage"] = ev.get("usage")
                completed_at = time.time()
            elif kind == "turn.failed":
                state["failed"] = True
                state["error"] = (ev.get("error") or {}).get("message") or json.dumps(ev, ensure_ascii=False)
            elif kind == "error":
                # Retry notices also arrive as top-level errors, so this alone does not end the turn.
                state["error"] = ev.get("message") or state["error"]
            elif kind == "item.completed" and item.get("type") == "agent_message":
                state["last_text"] = item.get("text")
            elif kind == "item.completed" and item.get("type") == "command_execution":
                state["commands"] += 1
            elif kind == "item.completed" and item.get("type") == "file_change":
                state["file_changes"] += [(c.get("path", ""), c.get("kind", "modified")) for c in item.get("changes", [])]
        try:
            state["exit_code"] = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            kill_tree(proc.pid)
    return state


def classify(state, run_dir):
    """Return (error_kind, retryable) for an attempt that did not complete."""
    if state["end_reason"] == "timeout":
        return "timeout", False
    if state["end_reason"] in ("idle_timeout", "reconnect_timeout"):
        return state["end_reason"], True
    if state["end_reason"] == "spawn_failed":
        return "spawn_failed", False
    text = state["error"] or ""
    if not state["failed"] and not text:
        try:
            text = (run_dir / "stderr.log").read_text("utf-8", "replace")[-2000:]
        except OSError:
            text = ""
        state["error"] = text.strip()[-500:] or "Codex exited without turn.completed"
    if PERMANENT.search(text):
        return "permanent", False
    if TRANSIENT.search(text):
        return "transient", True
    return "incomplete", False


SNAPSHOT_SKIP = {".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache"}
# A 10k-file tree on /mnt took 47s to walk; past this budget fall back to Codex's own file_change events.
SNAPSHOT_BUDGET = 20
# Trees that blew the budget are remembered, so later writers skip the doomed 20s walk.
TOO_BIG_FILE = "snapshot-too-big.json"
TOO_BIG_TTL = 7 * 86400


def snapshot(root, budget=SNAPSHOT_BUDGET, scope=None):
    """Map path relative to root -> (size, mtime_ns) under root, or only under the scope files/directories;
    None when the walk exceeds the budget."""
    deadline = time.time() + budget
    files = {}

    def add(path):
        try:
            st = os.stat(path, follow_symlinks=False)
        except OSError:
            return
        files[os.path.relpath(path, root).replace(os.sep, "/")] = (st.st_size, st.st_mtime_ns)

    for top in scope or [root]:
        if not os.path.isdir(top):
            add(top)  # a scoped file, or one that does not exist yet
            continue
        for dirpath, dirnames, filenames in os.walk(top):
            if time.time() > deadline:
                return None
            dirnames[:] = [d for d in dirnames if d not in SNAPSHOT_SKIP]
            for name in filenames:
                add(os.path.join(dirpath, name))
    return files


def too_big_trees():
    try:
        data = json.loads((HOME / TOO_BIG_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {k: v for k, v in data.items() if isinstance(v, (int, float)) and now - v < TOO_BIG_TTL} \
        if isinstance(data, dict) else {}


def tree_key(cwd):
    return os.path.normcase(os.path.abspath(cwd))


def remember_too_big(cwd):
    # Only an optimisation: losing a concurrent update or failing to write must never fail the task.
    try:
        data = {**too_big_trees(), tree_key(cwd): time.time()}
        HOME.mkdir(parents=True, exist_ok=True)
        tmp = HOME / f"{TOO_BIG_FILE}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(data), "utf-8")
        os.replace(tmp, HOME / TOO_BIG_FILE)
    except OSError:
        pass


def scope_path(cwd, scope):
    path = local_path(scope)
    if not IS_WIN:
        path = path.replace("\\", "/")  # a relative Windows path such as src\lib, read as index.mjs normPath reads it
    path, base = os.path.normpath(os.path.join(cwd, path)), os.path.normpath(cwd)
    head, rest = path[:len(base)], path[len(base):]
    # /mnt/<drive> ignores case: a scope naming cwd in another case would otherwise key its files as ../.. paths.
    if head != base and head.lower() == base.lower() and rest[:1] in ("", os.sep):
        try:
            if os.path.samefile(head, base):
                path = base + rest
        except OSError:
            pass
    return path


def snapshot_before(cwd, scope_args):
    """Snapshot cwd, or only the --scope paths when cwd is too big. Returns (before, scope); scope is None
    for a full snapshot, and before is None when only Codex's events can be used."""
    if tree_key(cwd) not in too_big_trees():
        before = snapshot(cwd)
        if before is not None:
            return before, None
        remember_too_big(cwd)
    scope = [scope_path(cwd, s) for s in scope_args or []]
    return (snapshot(cwd, scope=scope), scope) if scope else (None, None)


def files_changed(root, before, event_changes, scope=None, limit=300):
    """What a writer touched: a snapshot diff catches shell writes too; events only cover Codex's patch tool."""
    after = snapshot(root, scope=scope) if before is not None else None
    rel = lambda p: os.path.relpath(os.path.join(root, p), root).replace(os.sep, "/")
    events = list(dict.fromkeys((rel(p), k) for p, k in event_changes if p))
    if after is not None:
        changes = [(p, "added") for p in after.keys() - before.keys()]
        changes += [(p, "deleted") for p in before.keys() - after.keys()]
        changes += [(p, "modified") for p in before.keys() & after.keys() if before[p] != after[p]]
        source = "snapshot"
        if scope:
            inside = [rel(s) for s in scope]
            changes += [(p, k) for p, k in events
                        if not any(s in (".", p) or p.startswith(s + "/") for s in inside)]
            source = "scope_snapshot+codex_events"
    else:
        changes = events
        source = "codex_events"
    changes.sort()
    return {"files_changed": [{"path": p, "change": c} for p, c in changes[:limit]],
            "files_changed_total": len(changes), "files_changed_source": source}


def execute(args, prompt, run_dir):
    run_dir.mkdir(parents=True, exist_ok=True)
    base = {"cwd": os.path.abspath(args.cwd), "sandbox": args.sandbox, "log_dir": str(run_dir)}
    started = time.time()
    lock = None
    before = scope = None
    event_changes = []
    if args.sandbox != "read-only":
        lock = acquire_write_lock(args.cwd)
        if lock is None:
            return {**base, "status": "failed", "error_kind": "busy", "retryable": True, "attempts": 0,
                    "error": "Another Codex writer holds this directory. Wait, or use a separate worktree."}
        # Jobs queued before --scope existed have no scope in args.json.
        before, scope = snapshot_before(args.cwd, getattr(args, "scope", None))

    def changes():
        return files_changed(args.cwd, before, event_changes, scope) if args.sandbox != "read-only" else {}

    # Read-only runs are --ephemeral, so only a writer thread they resumed can be resumed again.
    resumable = lambda tid: tid if args.sandbox != "read-only" else args.resume
    thread_id = args.resume
    attempt = 0
    while True:
        attempt += 1
        if not router_reachable():
            state = {"end_reason": "router_down", "error": "Local model router is not reachable", "thread_id": thread_id}
            kind, retryable = "router_down", True
        else:
            resumed = bool(thread_id)  # a read-only retry drops the resumed thread and starts fresh
            state = run_attempt(args, prompt, run_dir, thread_id)
            thread_id = state["thread_id"]
            event_changes += state["file_changes"]
            if state["completed"] and not state["failed"]:
                break
            kind, retryable = classify(state, run_dir)
        # Read-only runs are ephemeral and safe to restart. A writer that started a thread must resume it.
        can_retry = retryable and attempt <= args.retries and (args.sandbox == "read-only" or thread_id or kind == "router_down")
        if not can_retry:
            return {**base, "status": "failed", "error_kind": kind, "error": state.get("error"), "retryable": retryable,
                    "attempts": attempt, "thread_id": resumable(thread_id), "duration_s": round(time.time() - started, 1),
                    **changes()}
        time.sleep(min(60, args.backoff * 3 ** (attempt - 1)) * random.uniform(0.8, 1.2))
        if thread_id and args.sandbox != "read-only":
            prompt = ("The previous attempt was interrupted. Inspect the current state of the workspace, "
                      "then finish the original task without repeating completed work.")
        elif args.sandbox == "read-only":
            thread_id = None

    message_file = run_dir / "last_message.txt"
    final = message_file.read_text("utf-8", "replace").strip() if message_file.exists() else ""
    final = final or state["last_text"] or ""
    result = {**base, "status": "completed", "attempts": attempt, "thread_id": resumable(thread_id),
              "final_message": final[:8000],
              "truncated": len(final) > 8000, "usage": state["usage"], "commands_run": state["commands"],
              "forced_exit": state["forced_exit"], "duration_s": round(time.time() - started, 1), **changes()}
    if args.resume and resumed:
        result["usage_scope"] = "thread_total"  # exec resume reports the whole thread's cumulative usage
    if args.schema:
        try:
            result["structured"] = json.loads(final)
        except ValueError:
            result.update(status="failed", error_kind="schema_invalid", error="Final message is not valid JSON",
                          retryable=False)
    return result


def add_task_arguments(p):
    p.add_argument("--cwd", required=True)
    # danger-full-access is deliberately absent: nobody is watching these runs.
    p.add_argument("--sandbox", choices=["read-only", "workspace-write"], default="read-only")
    p.add_argument("--model", help="Model override; omitted keeps the Codex config default")
    p.add_argument("--effort", default="medium")
    p.add_argument("--service-tier", help='Codex service tier, e.g. "fast" for Fast mode; omitted keeps the config value')
    p.add_argument("--schema")
    p.add_argument("--resume", help="Continue an existing thread id")
    p.add_argument("--scope", action="append",
                   help="File or directory (relative to --cwd) to snapshot when cwd is too big to walk; repeatable")
    p.add_argument("--use-user-config", action="store_true", help="Inherit ~/.codex/config.toml, MCP servers and hooks")
    p.add_argument("--timeout", type=float, default=3600)
    # The Windows sandbox setup alone was silent for about 60s, so keep this well above that.
    p.add_argument("--idle-timeout", type=float, default=600)
    p.add_argument("--reconnect-timeout", type=float, default=180)
    p.add_argument("--exit-grace", type=float, default=EXIT_GRACE_SECONDS)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--backoff", type=float, default=5)


def read_prompt():
    prompt = sys.stdin.buffer.read().decode("utf-8", "replace")
    if not prompt.strip():
        emit({"status": "failed", "error_kind": "bad_arguments", "error": "Prompt must be supplied on stdin", "retryable": False})
        sys.exit(2)
    return prompt


def write_result(job_dir, result):
    tmp = job_dir / "result.json.tmp"
    tmp.write_text(json.dumps(result, ensure_ascii=False), "utf-8")
    os.replace(tmp, job_dir / "result.json")


def last_activity(events, tail_bytes=65536):
    """Describe the newest meaningful Codex item so a poller can see progress, not just 'running'."""
    try:
        with open(events, "rb") as f:
            f.seek(max(0, events.stat().st_size - tail_bytes))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        item = ev.get("item") or {}
        kind = item.get("type")
        started = ev.get("type") == "item.started"
        if kind == "command_execution":
            cmd = re.sub(r"^(/usr)?/bin/(ba)?sh -l?c ", "", item.get("command") or "").strip("\"'").replace("\n", " / ")[:160]
            return f"running: {cmd}" if started else f"ran: {cmd} (exit {item.get('exit_code')})"
        if kind == "agent_message":
            return "message: " + (item.get("text") or "")[:160]
        if kind == "file_change":
            return "editing: " + ", ".join(Path(c.get("path", "")).name for c in item.get("changes", [])[:5])
        if kind == "mcp_tool_call":
            return f"mcp: {item.get('server')}.{item.get('tool')}"
        if kind == "collab_tool_call":
            return f"subagent: {item.get('tool')}"
    return None


def job_status(job_id):
    job_dir = HOME / "jobs" / job_id
    if not job_dir.exists():
        return {"job_id": job_id, "status": "failed", "error_kind": "unknown_job", "retryable": False}
    result = job_dir / "result.json"
    if result.exists():
        return {"job_id": job_id, **json.loads(result.read_text("utf-8"))}
    pid_file = job_dir / "worker.pid"
    if pid_file.exists() and pid_alive(int(pid_file.read_text())):
        events = job_dir / "events.jsonl"
        idle = round(time.time() - events.stat().st_mtime, 1) if events.exists() else None
        return {"job_id": job_id, "status": "running", "seconds_since_last_event": idle,
                "last_activity": last_activity(events) if events.exists() else None}
    # The worker may have finished between the result check above and the pid check.
    if result.exists():
        return {"job_id": job_id, **json.loads(result.read_text("utf-8"))}
    # The worker writes its pid before anything else, so give a just-started job a moment.
    if time.time() - job_dir.stat().st_ctime < 5:
        return {"job_id": job_id, "status": "running", "seconds_since_last_event": None}
    return {"job_id": job_id, "status": "failed", "error_kind": "worker_died", "retryable": True, "log_dir": str(job_dir)}


def main():
    parser = Parser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    add_task_arguments(sub.add_parser("run"))
    add_task_arguments(sub.add_parser("start"))
    status = sub.add_parser("status")
    status.add_argument("job_id")
    status.add_argument("--wait", type=float, default=0)
    sub.add_parser("cancel").add_argument("job_id")
    sub.add_parser("_worker").add_argument("job_id")
    args = parser.parse_args()
    if args.command in ("run", "start"):
        args.cwd = local_path(args.cwd)

    if args.command == "run":
        run_dir = HOME / "runs" / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        result = execute(args, read_prompt(), run_dir)
        emit(result)
        sys.exit(0 if result["status"] == "completed" else 1)

    if args.command == "start":
        job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        job_dir = HOME / "jobs" / job_id
        job_dir.mkdir(parents=True)
        (job_dir / "prompt.txt").write_text(read_prompt(), "utf-8")
        task = {k: v for k, v in vars(args).items() if k != "command"}
        (job_dir / "args.json").write_text(json.dumps(task), "utf-8")
        worker = subprocess.Popen([sys.executable, os.path.abspath(__file__), "_worker", job_id],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  creationflags=(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP) if IS_WIN else 0,
                                  start_new_session=not IS_WIN, close_fds=True)
        (job_dir / "worker.pid").write_text(str(worker.pid))
        emit({"job_id": job_id, "status": "running"})
        return

    if args.command == "_worker":
        job_dir = HOME / "jobs" / args.job_id
        task = argparse.Namespace(**json.loads((job_dir / "args.json").read_text("utf-8")))
        (job_dir / "worker.pid").write_text(str(os.getpid()))
        try:
            result = execute(task, (job_dir / "prompt.txt").read_text("utf-8"), job_dir)
        except Exception as e:
            result = {"status": "failed", "error_kind": "runner_error", "error": repr(e), "retryable": False}
        write_result(job_dir, result)
        return

    if args.command == "status":
        deadline = time.time() + args.wait
        while True:
            current = job_status(args.job_id)
            if current["status"] != "running" or time.time() >= deadline:
                emit(current)
                return
            time.sleep(1)

    if args.command == "cancel":
        job_dir = HOME / "jobs" / args.job_id
        pid_file = job_dir / "worker.pid"
        if (job_dir / "result.json").exists() or not pid_file.exists():
            emit(job_status(args.job_id))
            return
        kill_tree(int(pid_file.read_text()))
        codex_pid = job_dir / "codex.pid"
        if codex_pid.exists():
            # On Linux Codex runs in its own session, so killing the worker's group does not reach it.
            kill_tree(int(codex_pid.read_text()))
        write_result(job_dir, {"status": "cancelled", "retryable": False, "log_dir": str(job_dir)})
        emit(job_status(args.job_id))


if __name__ == "__main__":
    main()
