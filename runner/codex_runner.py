"""Run Codex CLI tasks for an agent harness behind a stable JSON contract (Linux / WSL).

    python codex_runner.py run    --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py start  --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py status JOB_ID [--wait SECONDS]
    python codex_runner.py cancel JOB_ID

Every command prints exactly one JSON object on stdout. Raw events go to a log file.
"""
import argparse
from contextlib import closing, suppress
import errno
import hashlib
import http.client
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

# Codex keeps its own provider config and credentials, so only sandbox and approval are pinned;
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
    # ASCII JSON also works with Windows pipes using a legacy encoding.
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
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


def process_start(pid):
    if not IS_WIN:
        try:
            return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]
        except (OSError, IndexError):
            return None
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    handle = wintypes.HANDLE(kernel.OpenProcess(0x1000, False, pid))
    if not handle:
        return None
    times = (wintypes.FILETIME * 4)()
    try:
        if kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
    finally:
        kernel.CloseHandle(handle)
    return None


def record_pid(path, pid):
    path.with_suffix(".start").write_text(process_start(pid) or "")
    path.write_text(str(pid))


def recorded_pid(path):
    if not path.exists() or not same_boot(path.parent):
        return None
    pid = int(path.read_text())
    start = path.with_suffix(".start")
    if start.exists():
        return pid if process_start(pid) == start.read_text() else None
    # 升级前启动的任务没有创建时刻记录，沿用同次启动内的存活判断，保证仍能查询和取消。
    return pid if pid_alive(pid) else None


def boot_id():
    """Identifies this distro instance: the kernel boot id plus when this PID namespace's init (pid 1) started.
    The kernel boot id alone misses `wsl --terminate <distro>` or a distro auto-stop while the VM stays up — the
    kernel does not reboot but pids start over, so a bare pid could then name an unrelated process. init's start
    time (field 22 of /proc/1/stat, ticks since kernel boot) changes on every distro restart. None where no /proc."""
    try:
        init_start = Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()[19]
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip() + ":" + init_start
    except (OSError, IndexError):
        return None


def same_boot(job_dir):
    """Pids recorded before a WSL VM, distro or Windows restart may now belong to unrelated processes."""
    recorded = job_dir / "boot_id"
    return not recorded.exists() or recorded.read_text().strip() == boot_id()


def router_reachable():
    # Opt-in: set CODEX_RUNNER_ROUTER_URL when Codex talks to a local proxy, so a dead proxy fails fast.
    target = os.environ.get("CODEX_RUNNER_ROUTER_URL")
    route = os.environ.get("CODEX_RUNNER_ROUTE_URL")
    if not (target or route):
        return True
    url = urlparse(target or route)
    try:
        if target:
            with socket.create_connection((url.hostname, url.port or (80 if url.scheme == "http" else 443)), timeout=2):
                return True
        connect = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        with closing(connect(url.hostname, url.port, timeout=2)) as conn:
            conn.request("HEAD", "/")
            conn.getresponse()
            return True
    except (OSError, http.client.HTTPException):
        return False


def acquire_file_lock(path, blocking=False):
    handle = open(path, "a+b")
    handle.seek(0)
    try:
        if IS_WIN:
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
    except OSError as error:
        handle.close()
        if blocking or error.errno not in (errno.EACCES, errno.EAGAIN):
            raise
        return None
    return handle


def write_lock_key(cwd):
    return hashlib.sha1(tree_key(cwd).encode("utf-8")).hexdigest()[:16]


def normalized_path(path):
    path = os.path.normcase(os.path.normpath(path))
    if not IS_WIN and re.match(r"^/mnt/[A-Za-z](/|$)", path):
        path = path.lower()  # Windows-backed paths ignore case, unlike native Linux paths.
    return path


def acquire_write_lock(cwd):
    """Hold a per-directory lock so a retry can never overlap another writer. The OS frees it if we die."""
    locks = HOME / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    return acquire_file_lock(locks / f"{write_lock_key(cwd)}.lock")


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
    route = env.get("CODEX_RUNNER_ROUTE_URL")
    if route:
        provider = env["CODEX_RUNNER_ROUTE_PROVIDER"]
        cmd += ["-c", "model_provider=" + json.dumps(provider),
                "-c", f"model_providers.{provider}.base_url=" + json.dumps(route)]
        host = urlparse(route).hostname
        if host in ("127.0.0.1", "localhost", "::1"):
            inherited = env.get("NO_PROXY") or env.get("no_proxy", "")
            for key in (("NO_PROXY",) if IS_WIN else ("NO_PROXY", "no_proxy")):
                existing = env.get(key, inherited)
                env[key] = ",".join(filter(None, (existing, host)))
    if args.model:
        cmd += ["-m", args.model]
    if args.effort:
        cmd += ["-c", f'model_reasoning_effort="{args.effort}"']
    # Jobs queued before this option existed have no service_tier in args.json.
    if getattr(args, "service_tier", None):
        cmd += ["-c", f'service_tier="{args.service_tier}"']
    # `exec resume` has no -s or -C, so the sandbox goes through -c and the directory through the process cwd.
    cmd += ["-c", f'sandbox_mode="{args.sandbox}"']
    if args.sandbox == "workspace-write" and getattr(args, "writable_roots", None):
        cmd += ["-c", "sandbox_workspace_write.writable_roots=" +
                json.dumps([local_path(p) for p in args.writable_roots], ensure_ascii=False)]
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
             "last_text": None, "commands": 0, "forced_exit": False, "end_reason": None,
             "file_changes": [], "prompt_delivered": False}
    start = time.monotonic()
    proc = reader = writer = None
    startup = acquire_file_lock(run_dir / "process.lock", blocking=True)
    try:
        with open(run_dir / "stderr.log", "ab") as stderr_log, open(run_dir / "events.jsonl", "ab") as event_log:
            state["stderr_offset"] = stderr_log.tell()
            try:
                proc = subprocess.Popen(cmd, cwd=args.cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=stderr_log, creationflags=NO_WINDOW, start_new_session=not IS_WIN)
            except OSError as e:
                state["end_reason"] = "spawn_failed"
                state["error"] = str(e)
                return state
            record_pid(run_dir / "codex.pid", proc.pid)
            startup.close()
            stdin_done = threading.Event()
            stdin_errors = []

            def send_prompt():
                # A child that stops reading must not block the timeout monitor.
                try:
                    proc.stdin.write(prompt.encode("utf-8"))
                    proc.stdin.close()
                except OSError as e:
                    stdin_errors.append(e)
                    try:
                        proc.stdin.close()
                    except OSError:
                        pass  # Closing can flush the same broken pipe again.
                finally:
                    stdin_done.set()

            lines = queue.Queue()

            def pump():
                try:
                    for raw in proc.stdout:
                        lines.put(raw)
                finally:
                    proc.stdout.close()
                    lines.put(None)

            reader = threading.Thread(target=pump, daemon=True)
            reader.start()
            writer = threading.Thread(target=send_prompt, daemon=True)
            writer.start()
            last_event = time.monotonic()
            reconnecting_since = None
            completed_at = None
            stdout_done = False
            active_commands = set()
            while True:
                now = time.monotonic()
                if stdin_errors:
                    state.update(completed=False, end_reason="spawn_failed", error=str(stdin_errors[0]))
                    kill_tree(proc.pid)
                    break
                if stdout_done and stdin_done.is_set():
                    # Keep the Linux leader unreaped until group cleanup so its PID cannot be reused.
                    exited = (proc.poll() is not None if IS_WIN else
                              os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None)
                    if exited:
                        break
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
                if not completed_at and not active_commands and now - last_event > args.idle_timeout:
                    state["end_reason"] = "idle_timeout"
                    kill_tree(proc.pid)
                    break
                try:
                    raw = lines.get(timeout=0.5)
                except queue.Empty:
                    continue
                if raw is None:
                    stdout_done = True
                    continue
                event_log.write(raw)
                event_log.flush()
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                kind = ev.get("type")
                item = ev.get("item") or {}
                # Startup events and configuration warnings can precede saving this turn's input.
                if kind in ("item.started", "item.completed") and item.get("type") in (
                        "command_execution", "file_change", "agent_message"):
                    state["prompt_delivered"] = True
                if item.get("type") == "command_execution":
                    if kind == "item.started" and item.get("status") == "in_progress":
                        active_commands.add(item.get("id"))
                    elif kind == "item.completed":
                        active_commands.discard(item.get("id"))
                # Reconnect notices are not progress, so they must not refresh the idle timer.
                if kind == "error":
                    reconnecting_since = reconnecting_since or time.monotonic()
                else:
                    reconnecting_since = None
                    last_event = time.monotonic()
                if kind == "thread.started":
                    state["thread_id"] = ev.get("thread_id") or state["thread_id"]
                elif kind == "turn.completed":
                    state["completed"] = True
                    state["usage"] = ev.get("usage")
                    completed_at = time.monotonic()
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
            with acquire_file_lock(run_dir / "process.lock", blocking=True):
                # Failed launchers can leave children behind after closing their standard streams.
                if not IS_WIN and state["end_reason"] is None and (not state["completed"] or state["failed"]):
                    kill_tree(proc.pid)
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    kill_tree(proc.pid)
    except BaseException:
        if proc is not None:
            # Preserve the original failure even if process cleanup also fails.
            with suppress(Exception):
                kill_tree(proc.pid)
            with suppress(Exception):
                proc.wait(timeout=10)
        raise
    finally:
        startup.close()
        with acquire_file_lock(run_dir / "process.lock", blocking=True):
            (run_dir / "codex.pid").unlink(missing_ok=True)
            (run_dir / "codex.start").unlink(missing_ok=True)
        for thread, pipe in ((writer, proc.stdin if proc else None), (reader, proc.stdout if proc else None)):
            if thread is not None:
                with suppress(RuntimeError):
                    thread.join(timeout=1)
            elif pipe is not None:
                with suppress(OSError):
                    pipe.close()
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
            with open(run_dir / "stderr.log", "rb") as f:
                f.seek(max(state["stderr_offset"], f.seek(0, os.SEEK_END) - 8000))
                text = f.read().decode("utf-8", "replace")[-2000:]
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
    """Map path relative to root -> (size, mtime_ns, mode) under root, or only under the scope files/directories;
    None when the walk exceeds the budget."""
    deadline = time.monotonic() + budget
    files = {}

    def add(path):
        try:
            st = os.stat(path, follow_symlinks=False)
        except FileNotFoundError:
            return
        files[os.path.relpath(path, root).replace(os.sep, "/")] = (st.st_size, st.st_mtime_ns, st.st_mode)

    def onerror(error):
        if not isinstance(error, FileNotFoundError):
            raise error

    for top in scope or [root]:
        if time.monotonic() > deadline:
            return None
        if not os.path.isdir(top):
            add(top)  # a scoped file, or one that does not exist yet
            continue
        for dirpath, dirnames, filenames in os.walk(top, onerror=onerror):
            if time.monotonic() > deadline:
                return None
            dirnames[:] = [d for d in dirnames if d not in SNAPSHOT_SKIP]
            for name in filenames:
                if time.monotonic() > deadline:
                    return None
                add(os.path.join(dirpath, name))
    return files if time.monotonic() <= deadline else None


def too_big_trees():
    try:
        data = json.loads((HOME / TOO_BIG_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {k: v for k, v in data.items() if isinstance(v, (int, float)) and now - v < TOO_BIG_TTL} \
        if isinstance(data, dict) else {}


def tree_key(cwd):
    return normalized_path(os.path.realpath(local_path(cwd)))


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
    return os.path.realpath(path)


def snapshot_before(cwd, scope_args):
    """Snapshot cwd, or only the --scope paths when cwd is too big. Returns (before, scope); scope is None
    for a full snapshot, and before is None when only Codex's events can be used."""
    cwd = os.path.realpath(cwd)
    if tree_key(cwd) not in too_big_trees():
        try:
            before = snapshot(cwd)
        except OSError:
            return None, None
        if before is not None:
            return before, None
        remember_too_big(cwd)
    scope = [scope_path(cwd, s) for s in scope_args or []]
    try:
        return (snapshot(cwd, scope=scope), scope) if scope else (None, None)
    except OSError:
        return None, scope


def ignore_patterns(ignore):
    patterns, warnings = [], []
    for pattern in ignore or []:
        try:
            patterns.append(re.compile(pattern))
        except re.error as error:
            warnings.append(f"忽略无效的 ignoreChanges Python re 正则 {pattern!r}：{error}")
    return patterns, warnings


def files_changed(root, before, event_changes, scope=None, ignore=None):
    """What a writer touched: a snapshot diff catches shell writes too; events only cover Codex's patch tool.
    Paths matching an ignore regex (files other processes keep writing) are dropped before the 300-entry cap."""
    root = os.path.realpath(root)
    scope = [os.path.realpath(s) for s in scope] if scope else scope
    try:
        after = snapshot(root, scope=scope) if before is not None else None
    except OSError:
        after = None
    rel = lambda p: os.path.relpath(os.path.realpath(os.path.join(root, p)), root).replace(os.sep, "/")
    events = {}
    for p, k in event_changes:
        if p:
            key = rel(p)
            if k != "update" or events.get(key) != "add":
                events[key] = k
    if after is not None:
        changes = [(p, "added") for p in after.keys() - before.keys()]
        changes += [(p, "deleted") for p in before.keys() - after.keys()]
        changes += [(p, "modified") for p in before.keys() & after.keys() if before[p] != after[p]]
        source = "snapshot"
        inside = [rel(s) for s in scope] if scope else ["."]
        outside = [(p, k) for p, k in events.items() if not any(
            (s == "." and p != ".." and not p.startswith("../")) or s == p or p.startswith(s + "/") for s in inside)]
        changes += outside
        if scope:
            source = "scope_snapshot+codex_events"
        elif outside:
            source = "snapshot+codex_events"
    else:
        changes = list(events.items())
        source = "codex_events"
    patterns, warnings = ignore_patterns(ignore)
    changes = [(p, k) for p, k in changes if not any(rx.search(p) for rx in patterns)]
    changes.sort()
    return {"files_changed": [{"path": p, "change": c} for p, c in changes[:300]],
            "files_changed_total": len(changes), "files_changed_source": source,
            **({"ignore_warnings": warnings} if warnings else {})}


def execute(args, prompt, run_dir):
    run_dir.mkdir(parents=True, exist_ok=True)
    args.cwd = os.path.realpath(args.cwd)
    scope_args = [scope_path(args.cwd, s) for s in getattr(args, "scope", None) or []]
    base = {"cwd": args.cwd, "sandbox": args.sandbox, "log_dir": str(run_dir)}
    ignore, warnings = ignore_patterns(getattr(args, "ignore", None))
    if warnings:
        base["ignore_warnings"] = warnings
    if getattr(args, "context", None) is not None:
        base["context"] = args.context
    if scope_args:
        base.update(scope=getattr(args, "scope", None), scope_paths=scope_args)
    started = time.time()
    locks = []
    before = scope = None
    event_changes = []
    try:
        if args.sandbox != "read-only":
            try:
                roots = [args.cwd]
                if args.sandbox == "workspace-write":
                    roots += [os.path.join(args.cwd, local_path(p)) for p in getattr(args, "writable_roots", None) or []]
                roots = {write_lock_key(p): p for p in roots}
                lock_timeout = getattr(args, "lock_timeout", None)
                deadline = time.monotonic() + lock_timeout if lock_timeout is not None else None
                waiting = False
                while True:
                    for key in sorted(roots):
                        lock = acquire_write_lock(roots[key])
                        if lock is None:
                            break
                        locks.append(lock)
                    else:
                        break
                    for lock in locks:
                        lock.close()
                    locks.clear()
                    if not waiting:
                        runner_event(run_dir, 0, "lock_wait")
                        waiting = True
                    if deadline is not None and time.monotonic() >= deadline:
                        return {**base, "status": "failed", "error_kind": "lock_timeout",
                                "error": "Timed out waiting for directory write locks; Codex was not started.",
                                "retryable": True, "attempts": 0, "duration_s": round(time.time() - started, 1)}
                    # shortcut: waiters are not FIFO; add ordered admission if task ordering is required.
                    time.sleep(0.25)
            except OSError as error:
                return {**base, "status": "failed", "error_kind": "runner_error", "error": str(error),
                        "retryable": False, "attempts": 0, "duration_s": round(time.time() - started, 1)}
            # Jobs queued before --scope existed have no scope in args.json.
            before, scope = snapshot_before(args.cwd, scope_args)

        def changes():
            return files_changed(args.cwd, before, event_changes, scope, ignore) \
                if args.sandbox != "read-only" else {}

        # Read-only runs are --ephemeral, so only a writer thread they resumed can be resumed again.
        resumable = lambda tid: tid if args.sandbox != "read-only" else args.resume
        thread_id = args.resume
        attempt = 0
        last_error_kind = None
        while True:
            attempt += 1
            runner_event(run_dir, attempt, "router_check", last_error_kind)
            if not router_reachable():
                state = {"end_reason": "router_down", "error": "Local model router is not reachable", "thread_id": thread_id}
                kind, retryable = "router_down", True
            else:
                resumed = bool(thread_id)  # a read-only retry drops the resumed thread and starts fresh
                runner_event(run_dir, attempt, "codex_running", last_error_kind)
                state = run_attempt(args, prompt, run_dir, thread_id)
                thread_id = state["thread_id"]
                event_changes += state["file_changes"]
                if state["completed"] and not state["failed"]:
                    break
                kind, retryable = classify(state, run_dir)
            last_error_kind = kind
            # Read-only runs are ephemeral and safe to restart. A writer that started a thread must resume it.
            can_retry = retryable and attempt <= args.retries and (args.sandbox == "read-only" or thread_id or kind == "router_down")
            if not can_retry:
                runner_event(run_dir, attempt, "finalizing", kind)
                return {**base, "status": "failed", "error_kind": kind, "error": state.get("error"), "retryable": retryable,
                        "attempts": attempt, "thread_id": resumable(thread_id), "duration_s": round(time.time() - started, 1),
                        **changes()}
            delay = min(60, args.backoff * 3 ** (attempt - 1)) * random.uniform(0.8, 1.2)
            runner_event(run_dir, attempt, "retry_wait", kind, time.time() + delay)
            time.sleep(delay)
            if thread_id and args.sandbox != "read-only" and kind != "router_down" and state["prompt_delivered"]:
                prompt = ("The previous attempt was interrupted. Inspect the current state of the workspace, "
                          "then finish the original task without repeating completed work.")
            elif args.sandbox == "read-only" and kind != "router_down":
                thread_id = None

        runner_event(run_dir, attempt, "finalizing", last_error_kind)
        message_file = run_dir / "last_message.txt"
        final = message_file.read_text("utf-8", "replace").strip() if message_file.exists() else ""
        final = final or state["last_text"] or ""
        result = {**base, "status": "completed", "attempts": attempt, "thread_id": resumable(thread_id),
                  "final_message": final[:8000],
                  "truncated": len(final) > 8000, "usage": state["usage"], "commands_run": state["commands"],
                  "forced_exit": state["forced_exit"], "duration_s": round(time.time() - started, 1), **changes()}
        if resumed:
            result["usage_scope"] = "thread_total"  # exec resume reports the whole thread's cumulative usage
        if args.schema:
            try:
                # Codex can emit literal newlines inside evidence strings. Preserve them and the raw report.
                result["structured"] = json.loads(final, strict=False)
            except ValueError as error:
                detail = f": {error.msg} (line {error.lineno}, column {error.colno})" if isinstance(error, json.JSONDecodeError) else ""
                result.update(status="failed", error_kind="schema_invalid", error="Final message is not valid JSON" + detail,
                              retryable=False)
        return result
    finally:
        for lock in reversed(locks):
            lock.close()


def positive_float(value):
    number = float(value)
    if not 0 < number < float("inf"):
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return number


def add_task_arguments(p):
    p.add_argument("--context-json", action="store_true", help="Read a prompt/context JSON envelope from stdin")
    p.add_argument("--cwd", required=True)
    # danger-full-access is for host-access runs: the Codex sandbox blocks WSL interop, so Windows programs need it.
    p.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"], default="read-only")
    p.add_argument("--model", help="Model override; omitted keeps the Codex config default")
    p.add_argument("--effort", help="Reasoning effort override; omitted keeps the Codex config default")
    p.add_argument("--service-tier", help='Codex service tier, e.g. "fast" for Fast mode; omitted keeps the config value')
    p.add_argument("--schema")
    p.add_argument("--resume", help="Continue an existing thread id")
    p.add_argument("--scope", action="append",
                   help="File or directory (relative to --cwd) to snapshot when cwd is too big to walk; repeatable")
    p.add_argument("--writable-root", dest="writable_roots", action="append",
                   help="Additional writable directory for workspace-write; repeatable")
    p.add_argument("--ignore", action="append",
                   help="Regex for cwd-relative paths other processes write; such changes are left out; repeatable")
    p.add_argument("--use-user-config", action="store_true", help="Inherit ~/.codex/config.toml, MCP servers and hooks")
    p.add_argument("--timeout", type=float, default=3600)
    p.add_argument("--lock-timeout", type=positive_float, help="Maximum seconds waiting for write locks; omitted waits indefinitely")
    # The Windows sandbox setup alone was silent for about 60s, so keep this well above that.
    p.add_argument("--idle-timeout", type=float, default=600)
    p.add_argument("--reconnect-timeout", type=float, default=180)
    p.add_argument("--exit-grace", type=float, default=EXIT_GRACE_SECONDS)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--backoff", type=float, default=5)


def read_prompt(strict=False):
    try:
        prompt = sys.stdin.buffer.read().decode("utf-8", "strict" if strict else "replace")
    except UnicodeDecodeError:
        emit({"status": "failed", "error_kind": "bad_arguments", "error": "stdin must be UTF-8", "retryable": False})
        sys.exit(2)
    if not prompt.strip():
        emit({"status": "failed", "error_kind": "bad_arguments", "error": "Prompt must be supplied on stdin", "retryable": False})
        sys.exit(2)
    return prompt


def write_result(job_dir, result):
    tmp = job_dir / "result.json.tmp"
    tmp.write_text(json.dumps({**result, **runner_activity(job_dir / "events.jsonl")}, ensure_ascii=False), "utf-8")
    os.replace(tmp, job_dir / "result.json")


def last_activity(events):
    """Describe the newest meaningful Codex item so a poller can see progress, not just 'running'."""
    try:
        with open(events, "rb") as f:
            f.seek(max(0, events.stat().st_size - 65536))
            lines = f.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    newest = True
    for line in reversed(lines):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if newest:
            newest = False
            message = ev.get("message")
            if ev.get("type") == "error" and isinstance(message, str) and message.startswith("Reconnecting"):
                return "reconnecting"
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


def task_context(value):
    fields = {"owner", "task", "acceptance", "write"}
    if not isinstance(value, dict) or not fields <= set(value) or set(value) - fields - {"continuation"}:
        raise ValueError("context must contain owner, task, acceptance and write")
    if value["owner"] is not None and (not isinstance(value["owner"], str) or not value["owner"].strip()):
        raise ValueError("context.owner must be a nonempty string or null")
    if not isinstance(value["task"], str) or not value["task"].strip():
        raise ValueError("context.task must be a nonempty string")
    if not isinstance(value["acceptance"], list) or not value["acceptance"] or any(
            not isinstance(a, str) or not a.strip() for a in value["acceptance"]):
        raise ValueError("context.acceptance must be a nonempty array of nonempty strings")
    if not isinstance(value["write"], bool):
        raise ValueError("context.write must be a boolean")
    if "continuation" in value:
        continuation = value["continuation"]
        if not isinstance(continuation, dict) or set(continuation) != {"parent_job_id", "answers", "resolution"}:
            raise ValueError("continuation must contain parent_job_id, answers and resolution")
        if not isinstance(continuation["parent_job_id"], str):
            raise ValueError("continuation.parent_job_id must be a job identifier")
        try:
            job_identifier(continuation["parent_job_id"])
        except argparse.ArgumentTypeError as e:
            raise ValueError(str(e)) from e
        if not isinstance(continuation["resolution"], str) or not isinstance(continuation["answers"], list):
            raise ValueError("continuation requires a resolution string and answers array")
        ids = set()
        for answer in continuation["answers"]:
            if (not isinstance(answer, dict) or set(answer) != {"id", "answer"} or
                    any(not isinstance(answer[k], str) or not answer[k].strip() for k in ("id", "answer")) or
                    answer["id"] in ids):
                raise ValueError("continuation answers require unique nonempty id and answer strings")
            ids.add(answer["id"])
    return value


def read_task_input(args, parser):
    prompt = read_prompt(strict=args.context_json)
    if args.context_json:
        try:
            envelope = json.loads(prompt)
            if not isinstance(envelope, dict) or set(envelope) != {"prompt", "context"}:
                raise ValueError("stdin must contain prompt and context")
            if not isinstance(envelope["prompt"], str) or not envelope["prompt"].strip():
                raise ValueError("prompt must be a nonempty string")
            args.context = task_context(envelope["context"])
            prompt = envelope["prompt"]
        except (ValueError, argparse.ArgumentTypeError) as e:
            parser.error("Invalid context envelope: " + str(e))
    return prompt


def job_identifier(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", value):
        raise argparse.ArgumentTypeError("job_id must be a runner job identifier, not a path")
    return value


def job_directory(job_id):
    job_identifier(job_id)
    root = (HOME / "jobs").resolve()
    path = root / job_id
    if not path.resolve().is_relative_to(root):
        raise ValueError("job directory is outside runner jobs")
    return path


def task_record(job_dir):
    path = job_dir / "args.json"
    if not path.exists():
        return {}
    task = json.loads(path.read_text("utf-8"))
    if not isinstance(task, dict):
        raise ValueError("args.json must be an object")
    if task.get("context") is not None:
        task_context(task["context"])
    return task


def job_metadata(job_dir, task=None, finished_at=None, thread_id=None):
    task = task_record(job_dir) if task is None else task
    meta = {"context": task.get("context"), "sandbox": task.get("sandbox"), "scope": task.get("scope")}
    meta["task_options"] = {"writable_roots": task.get("writable_roots"),
                            "use_user_config": task.get("use_user_config", False), "effort": task.get("effort")}
    if task.get("cwd"):
        meta["cwd"] = os.path.realpath(local_path(task["cwd"]))
        if task.get("scope"):
            meta.update(scope=task["scope"], scope_paths=[scope_path(meta["cwd"], s) for s in task["scope"]])
    thread = thread_id or task.get("resume")
    if not thread_id and task.get("sandbox") and task["sandbox"] != "read-only":
        thread = started_thread(job_dir / "events.jsonl") or thread
    meta["thread_id"] = thread
    args_file = job_dir / "args.json"
    if finished_at is not None and args_file.exists():
        meta["duration_s"] = round(max(0, finished_at - args_file.stat().st_mtime), 1)
    return meta


def valid_blockers(blockers):
    fields = {"id", "kind", "message", "question", "resolution"}
    return isinstance(blockers, list) and all(
        isinstance(b, dict) and set(b) == fields and all(isinstance(b[k], str) for k in fields) and
        b["id"].strip() and b["message"].strip() and
        b["kind"] in ("user_input", "task_conflict", "environment", "implementation") and
        (b["kind"] not in ("user_input", "task_conflict") or b["question"].strip())
        for b in blockers) and len({b["id"] for b in blockers}) == len(blockers)


def valid_report(report):
    fields = {"summary", "criteria", "files_changed", "deviations", "unresolved"}
    if (not isinstance(report, dict) or not fields <= set(report) or set(report) - fields - {"blockers"} or
            not isinstance(report["summary"], str) or not valid_blockers(report.get("blockers", []))):
        return False
    if any(not isinstance(report[k], list) or any(not isinstance(v, str) for v in report[k])
           for k in ("files_changed", "deviations", "unresolved")):
        return False
    return isinstance(report["criteria"], list) and all(
        isinstance(c, dict) and set(c) == {"criterion", "status", "evidence"} and
        isinstance(c["criterion"], str) and isinstance(c["evidence"], str) and
        isinstance(c["status"], str) and c["status"] in ("met", "not_met", "blocked")
        for c in report["criteria"])


def out_of_scope_paths(value):
    outside = list(value.get("out_of_scope") or [])
    if value.get("cwd") and value.get("scope_paths"):
        # Historical paths must not follow symlinks created after execution.
        roots = [normalized_path(p).rstrip(os.sep) + os.sep for p in value["scope_paths"]]
        for change in value.get("files_changed") or []:
            if isinstance(change, dict) and isinstance(change.get("path"), str):
                path = normalized_path(os.path.join(value["cwd"], change["path"]))
                if not any(path == r.rstrip(os.sep) or path.startswith(r) for r in roots):
                    outside.append(change["path"])
    return list(dict.fromkeys(outside))


def review_summary(value):
    status = "completed" if value.get("error_kind") == "schema_invalid" else value.get("status")
    if value.get("error_kind") in ("bridge_error", "unknown_job", "invalid_record") or value.get("status") == "monitor_failed":
        status = "unknown"
    report = value.get("structured")
    present = "structured" in value
    if status == "running":
        report_status = "pending"
    elif value.get("error_kind") == "schema_invalid":
        report_status = "invalid"
    elif not present:
        report_status = "missing"
    else:
        report_status = "valid" if valid_report(report) else "invalid"
    counts = {"met": 0, "not_met": 0, "blocked": 0}
    if isinstance(report, dict) and isinstance(report.get("criteria"), list):
        for criterion in report["criteria"]:
            if isinstance(criterion, dict) and isinstance(criterion.get("status"), str) and criterion["status"] in counts:
                counts[criterion["status"]] += 1
    outside = bool(out_of_scope_paths(value))
    context = value.get("context")
    uncovered = (isinstance(context, dict) and isinstance(context.get("acceptance"), list) and
                 isinstance(report, dict) and isinstance(report.get("criteria"), list) and
                 len(context["acceptance"]) != len(report["criteria"]))
    flagged = (uncovered or status in ("failed", "cancelled", "unknown") or report_status in ("invalid", "missing") or
               counts["not_met"] or counts["blocked"] or outside or
               (isinstance(report, dict) and (report.get("unresolved") or report.get("deviations") or
                report.get("blockers"))))
    return {"execution_status": status, "report_status": report_status,
            "review_status": "pending" if status == "running" else "needs_attention" if flagged else "needs_verification",
            "criteria_counts": counts}


def blocking_summary(value):
    report = value.get("report") if "report" in value else value.get("structured")
    valid = valid_report(report)
    blockers = report.get("blockers", []) if valid else []
    verification = value.get("verification")
    verification = verification if isinstance(verification, dict) else {}
    status = value.get("verification_status") or verification.get("status")
    closed = status in ("verified", "accepted_deviations")
    review_blockers = "blockers" in verification
    invalid_blockers = review_blockers and not valid_blockers(verification["blockers"])
    if closed or status == "needs_changes":
        blockers = []
    if review_blockers and not invalid_blockers and not closed:
        blockers = verification["blockers"]
    execution = ("unknown" if value.get("error_kind") in ("bridge_error", "unknown_job", "invalid_record") else
                 value.get("execution_status", value.get("status")))
    state, action = "clear", "verify"
    if execution == "running":
        state, action = "running", "wait"
    elif execution not in ("completed", "failed", "cancelled") or status in ("unknown", "invalid") or invalid_blockers:
        state, action = "unclassified", "inspect_report"
    elif closed:
        state, action = "clear", "done"
    elif not valid or value.get("report_status") == "invalid":
        state, action = "unclassified", "inspect_report"
    elif any(b["kind"] in ("user_input", "task_conflict") for b in blockers):
        state, action = "needs_input", "ask_user"
    elif any(b["kind"] == "environment" for b in blockers):
        state, action = "waiting_environment", "wait_condition"
    elif blockers or status == "needs_changes":
        state, action = "needs_fix", "resume_fix"
    elif any(c["status"] == "blocked" for c in report["criteria"]):
        state, action = "unclassified", "inspect_report"
    elif any(c["status"] == "not_met" for c in report["criteria"]):
        state, action = "needs_fix", "resume_fix"
    elif (execution != "completed" or report["unresolved"] or
          (isinstance(value.get("context"), dict) and isinstance(value["context"].get("acceptance"), list) and
           len(report["criteria"]) != len(value["context"]["acceptance"]))):
        state, action = "unclassified", "inspect_report"
    return {"state": state, "blockers": blockers,
            "questions": [{"id": b["id"], "question": b["question"]} for b in blockers
                          if b["kind"] in ("user_input", "task_conflict")],
            "next_action": action}


def validate_review(review, value):
    fields = {"status", "criteria", "notes", "accepted_deviations"}
    if (not isinstance(review, dict) or not fields <= set(review) or set(review) - fields - {"blockers"} or
            not isinstance(review["status"], str) or
            review["status"] not in ("verified", "needs_changes", "accepted_deviations") or
            not isinstance(review["notes"], str) or not valid_blockers(review.get("blockers", []))):
        raise ValueError("Invalid review fields, status, notes or blockers")
    report = value.get("structured")
    context = value.get("context")
    acceptance = context["acceptance"] if isinstance(context, dict) else (
        report["criteria"] if valid_report(report) else None)
    if acceptance is None:
        raise ValueError("Review requires context acceptance or a valid legacy report")
    criteria = review["criteria"]
    if not isinstance(criteria, list):
        raise ValueError("review.criteria must be an array")
    indexes = []
    for criterion in criteria:
        if (not isinstance(criterion, dict) or set(criterion) != {"index", "status", "evidence"} or
                type(criterion["index"]) is not int or not 1 <= criterion["index"] <= len(acceptance) or
                not isinstance(criterion["status"], str) or criterion["status"] not in ("met", "not_met", "blocked") or
                not isinstance(criterion["evidence"], str) or not criterion["evidence"].strip()):
            raise ValueError("Review criteria require valid 1-based indexes, status and nonempty evidence")
        indexes.append(criterion["index"])
    if sorted(indexes) != list(range(1, len(acceptance) + 1)):
        raise ValueError("Review must cover every acceptance criterion exactly once")
    reported = report.get("deviations", []) if isinstance(report, dict) else []
    if not isinstance(reported, list) or any(not isinstance(d, str) for d in reported):
        raise ValueError("Reported deviations cannot be indexed")
    outside = out_of_scope_paths(value)
    expected = {("reported", i + 1) for i in range(len(reported))} | {("scope", i + 1) for i in range(len(outside))}
    acknowledged = set()
    if not isinstance(review["accepted_deviations"], list):
        raise ValueError("accepted_deviations must be an array")
    for deviation in review["accepted_deviations"]:
        if (not isinstance(deviation, dict) or set(deviation) != {"kind", "index", "evidence"} or
                not isinstance(deviation["kind"], str) or type(deviation["index"]) is not int or
                (deviation["kind"], deviation["index"]) not in expected or
                not isinstance(deviation["evidence"], str) or not deviation["evidence"].strip() or
                (deviation["kind"], deviation["index"]) in acknowledged):
            raise ValueError("Deviation acknowledgements require real unique indexes and nonempty evidence")
        acknowledged.add((deviation["kind"], deviation["index"]))
    if review["status"] != "needs_changes":
        if (any(c["status"] != "met" for c in criteria) or acknowledged != expected or review.get("blockers")):
            raise ValueError("Passing review requires all criteria met, all deviations acknowledged and no active blockers")
    return review


def read_reviews(job_dir, value):
    path = job_dir / "reviews.json"
    if not path.resolve().is_relative_to(job_dir.resolve()):
        raise ValueError("reviews artifact is outside job directory")
    if not path.exists():
        return {"history": [], "latest": None}
    data = json.loads(path.read_text("utf-8"))
    if (not isinstance(data, dict) or set(data) != {"history", "latest"} or
            not isinstance(data["history"], list) or not data["history"] or data["latest"] != data["history"][-1]):
        raise ValueError("Invalid review history/latest")
    for entry in data["history"]:
        if (not isinstance(entry, dict) or not {"reviewer", "time"} <= set(entry) or
                not isinstance(entry["reviewer"], str) or not entry["reviewer"].strip() or
                type(entry["time"]) not in (int, float) or not 0 <= entry["time"] < float("inf")):
            raise ValueError("Invalid review reviewer/time")
        validate_review({k: v for k, v in entry.items() if k not in ("reviewer", "time")}, value)
    return data


def verification_summary(job_dir, value):
    try:
        latest = read_reviews(job_dir, value)["latest"]
        return {"verification_status": latest["status"] if latest else "unreviewed", "verification": latest}
    except (OSError, ValueError, TypeError) as e:
        return {"verification_status": "invalid", "verification": None, "verification_error": str(e)}


def review_job(args, review):
    job_dir = job_directory(args.job_id)
    value = job_status(args.job_id)
    if value["execution_status"] in ("running", "unknown"):
        raise ValueError("Cannot review a running or unknown job")
    if not isinstance(args.reviewer, str) or not args.reviewer.strip():
        raise ValueError("reviewer must be nonempty")
    validate_review(review, value)
    lock_path = job_dir / "reviews.lock"
    if not lock_path.resolve().is_relative_to(job_dir.resolve()):
        raise ValueError("reviews lock is outside job directory")
    with acquire_file_lock(lock_path, blocking=True):
        data = read_reviews(job_dir, value)
        entry = {**review, "reviewer": args.reviewer, "time": time.time()}
        data["history"].append(entry)
        data["latest"] = entry
        tmp = job_dir / "reviews.json.tmp"
        if not tmp.resolve().is_relative_to(job_dir.resolve()):
            raise ValueError("reviews temporary artifact is outside job directory")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        os.replace(tmp, job_dir / "reviews.json")
    return job_status(args.job_id)


def runner_event(run_dir, attempt, phase, reason=None, retry_at=None):
    event = {"type": "runner.phase", "attempt": attempt, "phase": phase, "reason": reason,
             "time": time.time(), "retry_at": retry_at}
    with open(run_dir / "events.jsonl", "ab") as f:
        f.write((json.dumps(event) + "\n").encode("utf-8"))
    tmp = run_dir / "phase.json.tmp"
    tmp.write_text(json.dumps(event), "utf-8")
    os.replace(tmp, run_dir / "phase.json")


def runner_activity(events):
    activity = {"phase": None, "attempt": None, "last_error_kind": None, "retry_at": None}
    try:
        event = json.loads(events.with_name("phase.json").read_text("utf-8"))
        if isinstance(event, dict) and event.get("type") == "runner.phase":
            return {"phase": event.get("phase"), "attempt": event.get("attempt"),
                    "last_error_kind": event.get("reason"), "retry_at": event.get("retry_at")}
    except (OSError, ValueError):
        pass
    try:
        with open(events, "rb") as f:
            position = f.seek(0, os.SEEK_END)
            pending = b""
            while position:
                size = min(position, 65536)
                position -= size
                f.seek(position)
                lines = (f.read(size) + pending).split(b"\n")
                pending = lines.pop(0) if position else b""
                for raw in reversed(lines):
                    if not raw.startswith(b'{"type": "runner.phase",'):
                        continue
                    try:
                        event = json.loads(raw)
                    except ValueError:
                        continue
                    activity.update(phase=event.get("phase"), attempt=event.get("attempt"),
                                    last_error_kind=event.get("reason"), retry_at=event.get("retry_at"))
                    return activity
    except OSError:
        pass
    return activity


def enriched_status(job_id, job_dir, value, record=None):
    finished = (job_dir / "result.json").stat().st_mtime if (job_dir / "result.json").exists() else None
    metadata = record["metadata"] if record is not None else job_metadata(job_dir, finished_at=finished,
                                                                         thread_id=value.get("thread_id"))
    result = {**metadata, **value, "job_id": job_id}
    result.update(review_summary(result))
    result.update(verification_summary(job_dir, result))
    result["blocking"] = blocking_summary(result)
    if result.get("scope_paths"):
        result["out_of_scope"] = out_of_scope_paths(result)
    keys = ("phase", "attempt", "last_error_kind", "retry_at")
    activity = {k: value[k] for k in keys} if all(k in value for k in keys) else runner_activity(job_dir / "events.jsonl")
    if activity["attempt"] is None:
        activity["attempt"] = result.get("attempts")
    activity["last_error_kind"] = result.get("error_kind") or activity["last_error_kind"]
    if result.get("error_kind") == "worker_died":
        activity.update(phase="interrupted", retry_at=None)
    elif activity["phase"] == "codex_running" and result.get("last_activity") == "reconnecting":
        activity["phase"] = "codex_reconnecting"
    return {**result, **activity}


def job_status(job_id, record=None):
    try:
        job_dir = job_directory(job_id)
        if not job_dir.exists():
            value = {"job_id": job_id, "status": "failed", "error_kind": "unknown_job", "retryable": False}
            return {**value, **review_summary(value), "blocking": blocking_summary(value),
                    "verification_status": "unreviewed", "verification": None}
        result = job_dir / "result.json"
        if result.exists():
            value = record["result"] if record is not None else None
            return enriched_status(job_id, job_dir, value if value is not None else json.loads(result.read_text("utf-8")), record)
        pid_file = job_dir / "worker.pid"
        if recorded_pid(pid_file) is not None:
            events = job_dir / "events.jsonl"
            idle = round(time.time() - events.stat().st_mtime, 1) if events.exists() else None
            return enriched_status(job_id, job_dir, {"status": "running", "seconds_since_last_event": idle,
                                                    "last_activity": last_activity(events) if events.exists() else None}, record)
        if result.exists():
            return enriched_status(job_id, job_dir, json.loads(result.read_text("utf-8")), record)
        if not pid_file.exists() and time.time() - job_dir.stat().st_ctime < 5:
            return enriched_status(job_id, job_dir, {"status": "running", "seconds_since_last_event": None}, record)
        return enriched_status(job_id, job_dir, worker_died(job_id, job_dir, record["task"] if record else None), record)
    except (OSError, ValueError, TypeError) as e:
        value = {"job_id": job_id, "status": "failed", "error_kind": "invalid_record",
                 "error": str(e), "retryable": False}
        return {**value, **review_summary(value), "blocking": blocking_summary(value),
                "verification_status": "invalid", "verification": None}


def job_details(job):
    if "_details" not in job:
        job["_details"] = job_status(job["job_id"], job["_record"])
    return {**job, **job["_details"]}


def matching_jobs(args):
    def matches_metadata(value, job_id):
        context = value.get("context")
        if args.owner and not ((isinstance(context, dict) and context.get("owner") == args.owner) or
                               job_id in (args.job_id or [])):
            return False
        return not args.cwd or bool(value.get("cwd") and tree_key(args.cwd) == tree_key(value["cwd"]))

    jobs = []
    root = HOME / "jobs"
    for job_dir in root.iterdir() if root.exists() else []:
        if not job_dir.is_dir():
            continue
        try:
            job_identifier(job_dir.name)
        except argparse.ArgumentTypeError:
            continue
        if getattr(args, "command", None) == "summary" and not args.owner and args.job_id and job_dir.name not in args.job_id:
            continue
        args_file, result_file = job_dir / "args.json", job_dir / "result.json"
        try:
            task = task_record(job_dir)
            result = json.loads(result_file.read_text("utf-8")) if result_file.exists() else None
            value = {**task, **(result if result is not None else {})}
            record = {"task": task, "result": result}
        except (OSError, ValueError, TypeError):
            value, record = {}, None
        if not matches_metadata(value, job_dir.name):
            continue
        if record is not None:
            try:
                record["metadata"] = job_metadata(job_dir, task=record["task"],
                                                 finished_at=result_file.stat().st_mtime if result_file.exists() else None,
                                                 thread_id=value.get("thread_id"))
                value = {**record["metadata"], **(record["result"] if record["result"] is not None else {})}
            except (OSError, ValueError, TypeError):
                record = None
                value = job_status(job_dir.name)
                value["_details"] = dict(value)
                if not matches_metadata(value, job_dir.name):
                    continue
        context = value.get("context")
        parent = (context or {}).get("continuation", {}).get("parent_job_id")
        if getattr(args, "thread_id", None) and value.get("thread_id") != args.thread_id:
            continue
        if getattr(args, "parent_job", None) and parent != args.parent_job:
            continue
        value.update(job_id=job_dir.name, _record=record)
        if args.status or args.needs_attention:
            value = job_details(value)
        if args.status and value["execution_status"] != args.status:
            continue
        verification = value.get("verification_status", "unreviewed")
        attention = verification in ("needs_changes", "invalid") or (
            verification == "unreviewed" and value.get("review_status") == "needs_attention")
        if args.needs_attention and not attention:
            continue
        jobs.append({**value, "parent_job_id": parent,
                     "started_at": args_file.stat().st_mtime if args_file.exists() else None,
                     "finished_at": result_file.stat().st_mtime if result_file.exists() else None,
                     "updated_at": max(p.stat().st_mtime for p in (job_dir, args_file, result_file, job_dir / "events.jsonl",
                                                                 job_dir / "reviews.json") if p.exists())})
    jobs.sort(key=lambda j: (j["started_at"] or j["updated_at"], j["job_id"]), reverse=True)
    return jobs


def list_jobs(args):
    jobs = matching_jobs(args)
    page = [job_details(j) for j in jobs[args.offset:args.offset + args.limit]]
    fields = ("job_id", "cwd", "scope", "scope_paths", "thread_id", "parent_job_id", "sandbox", "task_options", "status", "error_kind", "duration_s",
              "started_at", "finished_at", "updated_at", "execution_status", "report_status", "review_status",
              "criteria_counts", "blocking", "verification_status", "verification", "phase", "attempt",
              "last_error_kind", "retry_at")
    page = [{**{k: j.get(k) for k in fields},
             "context": {"owner": j["context"].get("owner"),
                         "task": j["context"]["task"].strip().splitlines()[0][:160]} if j.get("context") else None,
             **({"verification_error": j["verification_error"]} if "verification_error" in j else {})} for j in page]
    next_offset = args.offset + len(page)
    return {"status": "completed", "jobs": page, "total": len(jobs), "offset": args.offset, "limit": args.limit,
            "next_offset": next_offset if next_offset < len(jobs) else None, "eof": next_offset >= len(jobs)}


def summary_usage(rounds):
    if not rounds or (len(rounds) > 1 and rounds[-1].get("usage_scope") != "thread_total"):
        return None
    usage = rounds[-1].get("usage")
    return usage if isinstance(usage, dict) and usage and all(type(v) in (int, float) for v in usage.values()) else None


def summarize_jobs(args):
    groups = {}
    error_kinds = {}
    for job in matching_jobs(args):
        if job["_record"] is None or job["_record"]["result"] is None:
            job = job_details(job)
        if job.get("error_kind"):
            kind = job["error_kind"]
            error_kinds[kind] = error_kinds.get(kind, 0) + 1
        key = ("thread", job["thread_id"]) if job.get("thread_id") else ("job", job["job_id"])
        groups.setdefault(key, []).append(job)
    result = []
    page = list(groups.items())[args.offset:args.offset + args.limit]
    for (kind, identifier), jobs in page:
        jobs = [job_details(j) for j in jobs]
        rounds = list(reversed(jobs))
        latest = jobs[0]
        report = latest.get("structured")
        report = report if valid_report(report) else {}
        verification = latest.get("verification")
        closed = latest.get("verification_status") in ("verified", "accepted_deviations")
        criteria = verification["criteria"] if verification else report.get("criteria", [])
        finished = [j for j in rounds if j.get("finished_at") is not None]
        durations = [j.get("duration_s") for j in finished]
        files = []
        for job in rounds:
            for change in job.get("files_changed") or []:
                path = change.get("path") if isinstance(change, dict) else change
                if path and path not in files:
                    files.append(path)
            structured = job.get("structured")
            for path in structured.get("files_changed", []) if valid_report(structured) else []:
                if path not in files:
                    files.append(path)
        open_items = {"criteria": [c for c in criteria if c["status"] != "met"],
                      "unresolved": report.get("unresolved", []), "deviations": report.get("deviations", []),
                      "out_of_scope": out_of_scope_paths(latest),
                      "blockers": latest["blocking"]["blockers"]}
        if closed:
            open_items = {k: [] for k in open_items}
        result.append({"group_id": kind + ":" + identifier, "thread_id": latest.get("thread_id"),
                       "job_ids": [j["job_id"] for j in rounds], "total_rounds": len(rounds),
                       "rounds": [{k: j.get(k) for k in ("job_id", "parent_job_id", "status", "execution_status",
                                   "verification_status", "started_at", "finished_at", "duration_s", "usage", "usage_scope")}
                                  for j in jobs[:args.round_limit]],
                       "rounds_truncated": len(rounds) > args.round_limit,
                       "latest_job_id": latest["job_id"],
                       "latest_job": {k: latest.get(k) for k in ("job_id", "thread_id", "parent_job_id", "status",
                                      "execution_status", "review_status", "report_status", "blocking", "context")},
                       "summary": report.get("summary"), "verification_status": latest.get("verification_status"),
                       "verification": verification, "open_items": open_items, "files_changed": files,
                       "finished_duration_s": round(sum(durations), 1) if all(type(d) in (int, float) for d in durations) else None,
                       "usage": summary_usage(rounds), "usage_scope": "thread_total" if kind == "thread" else "job"})
    next_offset = args.offset + len(result)
    return {"status": "completed", "groups": result, "total": len(groups),
            "total_jobs": sum(map(len, groups.values())), "error_kinds": error_kinds, "offset": args.offset, "limit": args.limit,
            "next_offset": next_offset if next_offset < len(groups) else None}


def job_output(args):
    job_dir = job_directory(args.job_id)
    if not job_dir.exists():
        value = {"job_id": args.job_id, "status": "failed", "error_kind": "unknown_job", "retryable": False}
        return {**value, **review_summary(value)}
    source = job_dir / {"report": "last_message.txt", "result": "result.json", "context": "args.json",
                        "review": "reviews.json", "stderr": "stderr.log", "events": "events.jsonl"}[args.artifact]
    value = job_status(args.job_id)
    base = {"job_id": args.job_id, "artifact": args.artifact, "execution_status": value.get("execution_status", value["status"]),
            "source_path": str(source), "offset": args.offset, "limit": args.limit}
    if not source.resolve().is_relative_to(job_dir.resolve()):
        return {**base, "status": "failed", "error_kind": "invalid_artifact", "retryable": False}
    if args.artifact in ("report", "result") and value["status"] == "running":
        return {**base, "status": "pending", "error_kind": "artifact_pending", "retryable": True}
    if not source.exists():
        return {**base, "status": "failed", "error_kind": "legacy_context_missing" if args.artifact == "context" else "artifact_missing", "retryable": False}
    try:
        if args.artifact == "context":
            context = task_record(job_dir).get("context")
            if context is None:
                return {**base, "status": "failed", "error_kind": "legacy_context_missing", "retryable": False}
            content = json.dumps(context, ensure_ascii=False)
        else:
            with open(source, "r", encoding="utf-8", newline="") as f:
                content = f.read()
    except (OSError, ValueError):
        return {**base, "status": "failed", "error_kind": "artifact_read_failed", "retryable": False}
    if not content.strip():
        return {**base, "status": "failed", "error_kind": "artifact_empty", "retryable": False}
    if args.offset >= len(content):
        return {**base, "status": "failed", "error_kind": "offset_out_of_range", "retryable": False,
                "total_chars": len(content), "next_offset": None, "eof": True}
    text = content[args.offset:args.offset + args.limit]
    end = min(len(content), args.offset + len(text))
    return {**base, "status": "completed", "text": text, "total_chars": len(content),
            "next_offset": end if end < len(content) else None, "eof": end >= len(content)}


def worker_died(job_id, job_dir, task=None):
    """The worker exited without a result (WSL restart, crash). A writer can still be resumed from its thread;
    a read-only run is --ephemeral, so only a writer thread it resumed can be."""
    if task is None:
        try:
            task = json.loads((job_dir / "args.json").read_text("utf-8"))
        except (OSError, ValueError):
            task = {}
    thread = task.get("resume")
    if task.get("sandbox") != "read-only":
        thread = started_thread(job_dir / "events.jsonl") or thread
    result = {"job_id": job_id, "status": "failed", "error_kind": "worker_died", "retryable": True,
              "error": "The runner worker exited without writing a result (WSL restart or crash).",
              "sandbox": task.get("sandbox"), "thread_id": thread, "log_dir": str(job_dir)}
    pid = recorded_pid(job_dir / "codex.pid")
    if pid is not None:
        result.update(residual_codex_pid=pid, retryable=False)
        result["error"] += f" Codex PID {pid} is still present. Do not retry until the residual process is stopped."
    return result


def started_thread(events):
    try:
        with open(events, "rb") as f:
            for raw in f:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(ev, dict) and ev.get("type") == "thread.started" and ev.get("thread_id"):
                    return ev["thread_id"]
    except OSError:
        pass
    return None


PRUNE_TTL = 30 * 86400


def prune_old(subdir):
    """仅尽力清理过期结果，以及已无进程且长期没有活动的未完成任务。"""
    root = HOME / subdir
    if not root.is_dir():
        return
    cutoff = time.time() - PRUNE_TTL
    for d in root.iterdir():
        try:
            result = d / "result.json"
            if not d.is_dir():
                continue
            if result.is_file():
                expired = result.stat().st_mtime < cutoff
            else:
                if any(recorded_pid(d / name) is not None for name in ("worker.pid", "codex.pid")):
                    continue
                expired = max(p.stat().st_mtime for p in [d, *d.rglob("*")]) < cutoff
            if expired:
                shutil.rmtree(d, ignore_errors=True)
        except (OSError, ValueError):
            pass


def main():
    parser = Parser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    add_task_arguments(sub.add_parser("run"))
    add_task_arguments(sub.add_parser("start"))
    status = sub.add_parser("status")
    status.add_argument("job_id", type=job_identifier)
    status.add_argument("--wait", type=float, default=0)
    sub.add_parser("cancel").add_argument("job_id", type=job_identifier)
    sub.add_parser("_worker").add_argument("job_id", type=job_identifier)
    listing = sub.add_parser("list")
    summary = sub.add_parser("summary")
    for command in (listing, summary):
        command.add_argument("--cwd")
        command.add_argument("--owner")
        command.add_argument("--status", choices=["running", "completed", "failed", "cancelled", "unknown"])
        command.add_argument("--needs-attention", action="store_true")
        command.add_argument("--job-id", action="append", type=job_identifier)
        command.add_argument("--thread-id")
        command.add_argument("--parent-job", type=job_identifier)
        command.add_argument("--offset", type=int, default=0)
    listing.add_argument("--limit", type=int, default=20)
    summary.add_argument("--limit", type=int, default=10)
    summary.add_argument("--round-limit", type=int, default=20)
    review = sub.add_parser("review")
    review.add_argument("job_id", type=job_identifier)
    review.add_argument("--reviewer", required=True)
    output = sub.add_parser("output")
    output.add_argument("job_id", type=job_identifier)
    output.add_argument("--artifact", choices=["report", "result", "context", "review", "stderr", "events"], default="report")
    output.add_argument("--limit", type=int, default=4000)
    output.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()
    if args.command == "review":
        try:
            decision = json.loads(read_prompt(strict=True))
            emit(review_job(args, decision))
        except (OSError, ValueError, argparse.ArgumentTypeError) as e:
            parser.error("Invalid review: " + str(e))
        return
    if args.command in ("list", "summary", "output"):
        maximum = 8000 if args.command == "output" else 100
        if args.offset < 0 or not 1 <= args.limit <= maximum:
            parser.error(f"offset must be nonnegative and limit between 1 and {maximum}")
    if args.command == "summary":
        if not 1 <= args.round_limit <= 1000:
            parser.error("round-limit must be between 1 and 1000")
        try:
            emit(summarize_jobs(args))
        except (OSError, ValueError) as e:
            emit({"status": "failed", "error_kind": "invalid_record", "error": str(e), "retryable": False})
        return
    if args.command in ("list", "output"):
        try:
            emit(list_jobs(args) if args.command == "list" else job_output(args))
        except (OSError, ValueError) as e:
            value = {"status": "failed", "error_kind": "invalid_record", "error": str(e), "retryable": False}
            emit({**value, **review_summary(value)})
        return
    if args.command in ("run", "start"):
        args.cwd = local_path(args.cwd)
        prompt = read_task_input(args, parser)

    if args.command == "run":
        run_dir = HOME / "runs" / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        run_dir.mkdir(parents=True)
        record_pid(run_dir / "worker.pid", os.getpid())
        result = execute(args, prompt, run_dir)
        result.update(review_summary(result))
        write_result(run_dir, result)
        emit(result)
        sys.exit(0 if result["status"] == "completed" else 1)

    if args.command == "start":
        prune_old("jobs")
        prune_old("runs")
        job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        job_dir = HOME / "jobs" / job_id
        job_dir.mkdir(parents=True)
        (job_dir / "prompt.txt").write_text(prompt, "utf-8")
        task = {k: v for k, v in vars(args).items() if k != "command"}
        (job_dir / "args.json").write_text(json.dumps(task), "utf-8")
        # Written before worker.pid, so a status that sees the pid also sees which boot it belongs to.
        boot = boot_id()
        if boot:
            (job_dir / "boot_id").write_text(boot)
        worker = subprocess.Popen([sys.executable, os.path.abspath(__file__), "_worker", job_id],
                                  stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  creationflags=(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP) if IS_WIN else 0,
                                  start_new_session=not IS_WIN, close_fds=True)
        record_pid(job_dir / "worker.pid", worker.pid)
        emit({"job_id": job_id, "status": "running"})
        return

    if args.command == "_worker":
        job_dir = HOME / "jobs" / args.job_id
        record_pid(job_dir / "worker.pid", os.getpid())
        task = argparse.Namespace(**json.loads((job_dir / "args.json").read_text("utf-8")))
        try:
            result = execute(task, (job_dir / "prompt.txt").read_text("utf-8"), job_dir)
        except Exception as e:
            result = {"status": "failed", "error_kind": "runner_error", "error": repr(e), "retryable": False}
        result = {**job_metadata(job_dir, thread_id=result.get("thread_id")), **result}
        result.update(review_summary(result))
        write_result(job_dir, result)
        return

    if args.command == "status":
        deadline = time.monotonic() + args.wait
        while True:
            current = job_status(args.job_id)
            if current["status"] != "running" or time.monotonic() >= deadline:
                emit(current)
                return
            time.sleep(1)

    if args.command == "cancel":
        job_dir = job_directory(args.job_id)
        pid_file = job_dir / "worker.pid"
        # After a restart the worker is gone and its recorded pids may name other processes: kill nothing.
        if (job_dir / "result.json").exists() or not pid_file.exists() or not same_boot(job_dir):
            emit(job_status(args.job_id))
            return
        with acquire_file_lock(job_dir / "process.lock", blocking=True):
            if (job_dir / "result.json").exists():
                emit(job_status(args.job_id))
                return
            codex_pid = job_dir / "codex.pid"
            pid = recorded_pid(codex_pid)
            if pid is not None:
                # On Linux Codex runs in its own session, so killing the worker's group does not reach it.
                kill_tree(pid)
            # Stop Codex before its worker: orphaning an exited leader can reap its recorded identity.
            worker_pid = recorded_pid(pid_file)
            if worker_pid is not None:
                kill_tree(worker_pid)
            if worker_pid is None:
                emit(job_status(args.job_id))
                return
            # The worker may have published its result after the initial check, before it was killed.
            if not (job_dir / "result.json").exists():
                result = {**job_metadata(job_dir, finished_at=time.time()), "status": "cancelled",
                          "retryable": False, "log_dir": str(job_dir)}
                result.update(review_summary(result))
                write_result(job_dir, result)
        emit(job_status(args.job_id))


if __name__ == "__main__":
    main()
