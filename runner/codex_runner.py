"""Run Codex CLI tasks for an agent harness behind a stable JSON contract (Linux / WSL).

    python codex_runner.py run    --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py start  --cwd DIR [--sandbox workspace-write] [--scope PATH ...] < prompt.txt
    python codex_runner.py status JOB_ID [--wait SECONDS]
    python codex_runner.py cancel JOB_ID
    python codex_runner.py rollback JOB_ID [--check]
    python codex_runner.py repeat-guard [--cwd DIR]
    python codex_runner.py doctor

Every command prints exactly one JSON object on stdout. Raw events go to a log file.
"""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager, suppress
import errno
from functools import cache
import hashlib
import http.client
import glob
import json
from math import isfinite
import os
import queue
import random
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11: `doctor` reports it, every other command refuses to run.
    tomllib = None

IS_WIN = os.name == "nt"
if IS_WIN:
    import msvcrt
else:
    import fcntl
    import signal

# Codex keeps its own provider config and credentials, so only sandbox and approval are pinned;
# its MCP servers and hooks stay off unless --use-user-config.
# Also off: the skills listing (39.7k characters every request; in a week of jobs it mostly led to reading
# using-superpowers and verification-before-completion as the first tool call), and the goal and image tools
# described inside the exec tool (one job in a week used goals, none used images).
# Codex plugins are off as a whole: none of 631 jobs called a plugin tool, and with any plugin on, a failed job
# could not be handed to Gemini (their MCP servers and apps start with the session and cannot be turned off by name).
STRIP_USER_EXTRAS = ["--disable", "hooks", "-c", "skills.include_instructions=false",
                     "--disable", "goals", "--disable", "image_generation", "--disable", "plugins"]

HOME = Path(os.environ.get("CODEX_RUNNER_HOME") or
            (Path(os.environ.get("LOCALAPPDATA", Path.home())) / "codex-runner" if IS_WIN
             else Path.home() / ".local/state/codex-runner"))
EXIT_GRACE_SECONDS = 20
WORKER_START_GRACE_SECONDS = 5
LOST_AFTER = 300
REPEAT_MIN_SECONDS = 60
REPEAT_FAILURES = 2
REPEAT_WINDOW_HOURS = 24
REPEAT_TOTALS = {"blocked": 0, "seconds_avoided": 0}
OWNER_ONLY_REASONS = ("irreversible_data", "outward_action", "spending", "credentials", "security_boundary")
POWERSHELL_BUILTINS = frozenset("""
    Write-Host Write-Output Get-Content Set-Content Out-File Select-Object Where-Object ForEach-Object
    Test-Path Join-Path Get-Date Start-Sleep Out-Null Format-List Format-Table Get-ChildItem New-Item
    Remove-Item Get-Item Copy-Item Split-Path Resolve-Path ConvertTo-Json ConvertFrom-Json Get-Location Set-Location
""".split())
SCRIPT_EXTENSIONS = frozenset("ps1 psm1 psd1 py pyi sh bash zsh fish js mjs cjs ts jsx tsx bat cmd rb pl php lua".split())
SCRIPT_SUFFIX = r"\.(?:" + "|".join(sorted(SCRIPT_EXTENSIONS)) + ")"
SCRIPT_DELIMITERS = r"""\s'"\\/|&;<>()=,"""
SCRIPT_NAMES = re.compile(
    rf"""(?P<quote>["'])(?P<quoted_dir>[^"'\r\n|&;<>]*[/\\])?(?P<quoted>[^"'\\/\r\n|&;<>]+{SCRIPT_SUFFIX})(?P=quote)"""
    rf"|(?<![^{SCRIPT_DELIMITERS}])(?P<bare_dir>(?:[^{SCRIPT_DELIMITERS}]*[/\\])*)(?P<bare>[^{SCRIPT_DELIMITERS}]+{SCRIPT_SUFFIX})(?=$|[{SCRIPT_DELIMITERS}])", re.I)
VERIFY_FILE_LIMIT = 1024 * 1024
VERIFY_TOTAL_LIMIT = 32 * 1024 * 1024
VERIFY_CONTENT_FILES = 256
VERIFY_STAT_WORKERS = 16
GIT_DIRTY_STATUS = ("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
NO_WINDOW = 0x08000000 if IS_WIN else 0
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200

PERMANENT = re.compile(
    r"\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|no longer signed in|usage limit|insufficient"
    r"|model.{0,40}(not found|not supported|does not exist)|invalid.{0,20}(config|schema)|unrecognized", re.I)
# The model refusing the request arrives inside "Reconnecting... n/5" notices; the same prompt is refused again,
# and one job spent 21 minutes and three attempts on it before failing as reconnect_timeout.
# The same refusal also arrives as a failed turn with no reconnect notice ("This content was flagged for ...").
REFUSED = re.compile(r"refused this request|safety filter|content was flagged for", re.I)
# The model service answering 400 "Bad Request" to one request of a thread: seven jobs in one evening, and both a
# retry inside the job and a later resume of the same thread were rejected again, while a new thread worked.
REJECTED = re.compile(r"bad request|invalid_request_error", re.I)
TRANSIENT = re.compile(
    r"stream disconnected|stream error|timed? ?out|connection|reset by peer|\b429\b|rate.?limit"
    r"|\b50[0234]\b|overloaded|server_error|temporarily|try again", re.I)
PROVIDER_PERMANENT = re.compile(
    r"\b40[13]\b|unauthori[sz]ed|forbidden|not logged in|no longer signed in|log.?in required|sign.?in required"
    r"|usage limit|insufficient balance|invalid model selection|(?:unknown|unsupported) model"
    r"|model.{0,40}(not found|not supported|does not exist)", re.I)


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


def descendants(pid):
    """Linux: (pid, start time) of every process whose parent chain reaches pid, including those that left its
    process group or session. A process whose parent already exited was reparented and is not found."""
    children = {}
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text(errors="replace").rsplit(")", 1)[1].split()
            children.setdefault(int(fields[1]), []).append((int(stat.parent.name), fields[19]))
        except (OSError, IndexError, ValueError):
            continue
    found, pending = [], [pid]
    while pending:
        for child in children.get(pending.pop(), []):
            found.append(child)
            pending.append(child[0])
    return found


def kill_tree(pid):
    if not IS_WIN:
        found = descendants(pid)  # before the group dies: orphans are reparented and lose the chain
        try:
            os.killpg(pid, signal.SIGKILL)  # children start in their own session, so the group id is the pid
        except ProcessLookupError:
            pass
        for child, started in found:
            with suppress(OSError):
                if process_start(child) == started:  # the pid still names the process that was a descendant
                    os.kill(child, signal.SIGKILL)
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


def proc_start(pid):
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19]


def process_start(pid):
    if not IS_WIN:
        try:
            return proc_start(pid)
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
    publisher = os.getpid()
    for target, value in ((path.with_suffix(".start"), process_start(pid) or ""), (path, str(pid))):
        tmp = target.with_name(f"{target.name}.{publisher}.tmp")
        tmp.write_text(value)
        os.replace(tmp, target)


def recorded_pid(path):
    if not path.exists() or not same_boot(path.parent):
        return None
    pid = int(path.read_text())
    start = path.with_suffix(".start")
    if start.exists():
        return pid if process_start(pid) == start.read_text() else None
    # 升级前启动的任务没有创建时刻记录，沿用同次启动内的存活判断，保证仍能查询和取消。
    return pid if pid_alive(pid) else None


def kernel_boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def boot_id():
    """Identifies this distro instance: the kernel boot id plus when this PID namespace's init (pid 1) started.
    The kernel boot id alone misses `wsl --terminate <distro>` or a distro auto-stop while the VM stays up — the
    kernel does not reboot but pids start over, so a bare pid could then name an unrelated process. init's start
    time (field 22 of /proc/1/stat, ticks since kernel boot) changes on every distro restart. None where no /proc."""
    try:
        return kernel_boot_id() + ":" + proc_start(1)
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


def writer(sandbox, context=None):
    # A full-access job dispatched with write=false keeps its sandbox (it may launch Windows programs)
    # but is trusted not to write: no directory write lock, snapshot or diff.
    return sandbox != "read-only" and not (
        sandbox == "danger-full-access" and isinstance(context, dict) and context.get("write") is False)


def write_lock_roots(cwd, sandbox, writable_roots, context=None):
    if not writer(sandbox, context):
        return {}
    roots = [cwd]
    if sandbox == "workspace-write":
        roots.extend(os.path.join(cwd, local_path(p)) for p in writable_roots or [])
    return {write_lock_key(p): p for p in roots}


def earlier_writer_waiting(run_dir, roots, lost_after=LOST_AFTER):
    position = ((run_dir / "args.json").stat().st_mtime_ns, run_dir.name) \
        if run_dir.parent == HOME / "jobs" else None
    paths = [Path(tree_key(p)) for p in roots.values()]
    directories = list(job_directories())
    runs = HOME / "runs"
    if runs.exists():
        directories.extend(d for d in runs.iterdir() if d.is_dir())
    for job_dir in directories:
        if job_dir == run_dir:
            continue
        try:
            codex_pid = recorded_pid(job_dir / "codex.pid")
            finished = (job_dir / "result.json").exists()
            if finished and codex_pid is None:
                continue
            task = task_record(job_dir)
            if not task.get("cwd"):
                continue
            other_roots = write_lock_roots(task["cwd"], task.get("sandbox"), task.get("writable_roots"), task.get("context"))
            other_paths = [Path(tree_key(p)) for p in other_roots.values()]
            overlapping_roots = [root for root, path in zip(other_roots.values(), other_paths)
                                 if any(path.is_relative_to(p) or p.is_relative_to(path) for p in paths)]
        except OSError:
            # A record read while its owner replaces or removes it may belong to an overlapping writer: look again.
            return True
        except (ValueError, TypeError):
            continue
        if not overlapping_roots:
            continue
        if codex_pid is not None:
            return True
        if finished:
            continue
        # A writer may hold its locks before publishing Codex's PID, even if submitted later.
        for root in overlapping_roots:
            lock = acquire_write_lock(root)
            if lock is None:
                return True
            lock.close()
        if position is None or job_dir.parent != HOME / "jobs":
            continue
        try:
            other = ((job_dir / "args.json").stat().st_mtime_ns, job_dir.name)
        except FileNotFoundError:
            continue
        if other < position and job_status(job_dir.name, lost_after=lost_after)["status"] == "running":
            return True
    return False


def local_path(path):
    """DeepSeek often passes Windows paths; inside WSL map X:\\... to /mnt/x/...."""
    m = re.match(r"^([A-Za-z]):[\\/]*(.*)$", path)
    if IS_WIN or not m:
        return path
    return f"/mnt/{m.group(1).lower()}/" + m.group(2).replace("\\", "/")


def disable_user_mcp_servers():
    """`-c mcp_servers={}` is a no-op in Codex 0.154, so turn off each server named in config.toml.
    Plugin-provided MCP servers are not listed there; STRIP_USER_EXTRAS turns the plugins themselves off."""
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


def replace_user_agents_md(env):
    """Opt-in CODEX_RUNNER_AGENTS_MD: "none" leaves the user-level AGENTS.md out of jobs, a file path puts that file
    in its place. Codex reads it only from CODEX_HOME, so jobs get a home of symlinks to every other entry of the
    real one (same config, sessions and state databases, so resume still finds the thread)."""
    choice = env.get("CODEX_RUNNER_AGENTS_MD")
    if not choice:
        return
    real = Path(env.get("CODEX_HOME") or Path.home() / ".codex")
    home = HOME / "codex-home"
    home.mkdir(parents=True, exist_ok=True)
    # shortcut: symlinks need Linux/WSL (Windows needs Developer Mode); a failure here fails the job visibly.
    for entry in real.iterdir():
        if entry.name != "AGENTS.md":
            try:
                (home / entry.name).symlink_to(entry)
            except FileExistsError:  # another job linked it first
                pass
    link = home / "AGENTS.md"
    if choice == "none":
        link.unlink(missing_ok=True)
    else:
        temp = home / f".AGENTS.md.{os.getpid()}"
        temp.unlink(missing_ok=True)
        temp.symlink_to(Path(local_path(choice)))
        os.replace(temp, link)  # atomic, so a job starting at the same time never sees it missing
    env["CODEX_HOME"] = str(home)


def build_command(args, run_dir, thread_id, scratch=None):
    prefix, env = launcher()
    cmd = [*prefix, "exec"]
    if thread_id:
        cmd.append("resume")
    cmd += ["--json", "--skip-git-repo-check", "-o", str(run_dir / "last_message.txt")]
    if not args.use_user_config:
        cmd += STRIP_USER_EXTRAS + disable_user_mcp_servers()
        replace_user_agents_md(env)
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
    scratch_only = scratch is not None and args.sandbox == "read-only"
    sandbox = "workspace-write" if scratch_only else args.sandbox
    cmd += ["-c", f'sandbox_mode="{sandbox}"']
    if scratch:
        tmp = scratch / "tmp"
        tmp.mkdir(parents=True, exist_ok=True)
        scratch_env = {"TMPDIR": str(tmp), "TMP": str(tmp), "TEMP": str(tmp), "PYTHONDONTWRITEBYTECODE": "1",
                       "PYTEST_ADDOPTS": "-p no:cacheprovider", "COVERAGE_FILE": str(tmp / ".coverage")}
        env.update(scratch_env)
        if scratch_only:
            cmd += ["-c", "sandbox_workspace_write.writable_roots=[]",
                    "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
                    "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true",
                    "-c", "sandbox_workspace_write.network_access=false"]
        for key, value in scratch_env.items():
            cmd += ["-c", f"shell_environment_policy.set.{key}={json.dumps(value, ensure_ascii=False)}"]
    elif args.sandbox == "workspace-write" and getattr(args, "writable_roots", None):
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


def windows_agy(command):
    return IS_WIN or (command or "").lower().endswith(".exe")


def confirm_agy_stopped(run_dir):
    import agy_runner

    confirm = getattr(agy_runner, "cancel", None)
    with suppress(OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return confirm is not None and confirm(run_dir) is True
    return False


def run_attempt(args, prompt, run_dir, thread_id, repeat_guard=None):
    """Run one provider process to a verdict. A completed turn determines success."""
    scratch = getattr(args, "verification_scratch", None)
    gemini = getattr(args, "engine", None) == "gemini"
    id_field = "conversation_id" if gemini else "thread_id"
    fallback_check = getattr(args, "gemini_fallback_check", False)
    state = {"thread_id": thread_id, "completed": False, "failed": False, "error": None, "usage": None,
             "last_text": None, "commands": 0, "forced_exit": False, "end_reason": None,
             "file_changes": [], "prompt_delivered": False}
    if gemini:
        import agy_runner
        state["engine"] = "gemini"
        adapter = agy_runner.EventAdapter()
    else:
        cmd, env = build_command(args, run_dir, thread_id, scratch)
    start = time.monotonic()
    proc = reader = writer = None
    startup = acquire_file_lock(run_dir / "process.lock", blocking=True)
    try:
        if gemini:
            try:
                cmd, env = agy_runner.build_command(args, run_dir, thread_id, scratch)
            except ValueError as error:
                state.update(end_reason="bad_arguments", error=str(error))
                return state
        with open(run_dir / "stderr.log", "ab") as stderr_log, open(run_dir / "events.jsonl", "ab") as event_log:
            state["stderr_offset"] = stderr_log.tell()
            try:
                cwd = scratch if scratch and args.sandbox == "read-only" else args.cwd
                proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
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
            stdout_eof = possible_write = failure_observed = False

            def pump():
                nonlocal stdout_eof, possible_write, failure_observed
                try:
                    for raw in proc.stdout:
                        received = time.monotonic() if repeat_guard else None
                        if not (gemini or fallback_check):
                            lines.put((raw, received))
                            continue
                        try:
                            event = json.loads(raw)
                        except (ValueError, UnicodeError):
                            event = None
                        if fallback_check:
                            if not fallback_read_only_event(event):
                                possible_write = True
                            elif event["type"] in ("error", "turn.failed"):
                                failure_observed = True
                        if gemini:
                            if not isinstance(event, dict):
                                continue
                            for normalized in adapter.events(event):
                                if normalized.get("type") == "thread.started":
                                    normalized = dict(normalized)
                                    normalized[id_field] = normalized.pop("thread_id")
                                lines.put(((json.dumps(normalized) + "\n").encode("ascii"), received))
                        else:
                            lines.put((raw, received))
                    stdout_eof = True
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
            command_starts = {}  # scoped to this attempt: Codex may reuse item IDs on resume
            timeout_reason = None
            timeout_marker = object()
            while True:
                now = time.monotonic()
                if stdin_errors:
                    state.update(completed=False, end_reason="spawn_failed", error=str(stdin_errors[0]))
                    kill_tree(proc.pid)
                    break
                if stdout_done and stdin_done.is_set() and (timeout_reason is None or completed_at):
                    # Keep the Linux leader unreaped until group cleanup so its PID cannot be reused.
                    exited = (proc.poll() is not None if IS_WIN else
                              os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None)
                    if exited:
                        break
                if completed_at and now - completed_at > args.exit_grace:
                    state["forced_exit"] = True
                    kill_tree(proc.pid)
                    break
                if not completed_at and timeout_reason is None:
                    if reconnecting_since and now - reconnecting_since > args.reconnect_timeout:
                        timeout_reason = "reconnect_timeout"
                    elif now - start > args.timeout:
                        timeout_reason = "timeout"
                    elif not active_commands and now - last_event > args.idle_timeout:
                        timeout_reason = "idle_timeout"
                    if timeout_reason:
                        # Honour a completion already queued without letting later output defer the timeout.
                        lines.put(timeout_marker)
                try:
                    line = lines.get(timeout=0.5)
                except queue.Empty:
                    continue
                if line is timeout_marker:
                    if completed_at:
                        continue
                    state["end_reason"] = timeout_reason
                    kill_tree(proc.pid)
                    break
                if line is None:
                    stdout_done = True
                    continue
                raw, received = line
                event_log.write(raw)
                event_log.flush()
                try:
                    ev = json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
                if not isinstance(ev, dict):
                    continue
                kind = ev.get("type")
                item = ev.get("item") or {}
                # Startup events and configuration warnings can precede saving this turn's input.
                if kind in ("item.started", "item.completed") and item.get("type") in (
                        "command_execution", "file_change", "agent_message"):
                    state["prompt_delivered"] = True
                if item.get("type") == "command_execution":
                    if kind == "item.started":
                        if item.get("status") == "in_progress":
                            active_commands.add(item.get("id"))
                        if repeat_guard and repeat_guard.enabled:
                            step = repeat_guard.step(item)
                            if step:
                                block = repeat_guard.check_start(step, item["command"])
                                if block:
                                    state.update(completed=False, end_reason="repeated_failure", repeat_block=block,
                                                 error="A command started again after repeated long failures.")
                                    kill_tree(proc.pid)
                                    repeat_guard.record_block(block, event_log)
                                    break
                                if item.get("id") is not None:
                                    command_starts[item["id"]] = (step, received)
                    elif kind == "item.completed":
                        active_commands.discard(item.get("id"))
                        if repeat_guard and repeat_guard.enabled:
                            started_command = command_starts.pop(item.get("id"), None)
                            repeat_guard.complete(item, started_command, received)
                # Reconnect notices are not progress, so they must not refresh the idle timer.
                if kind == "error":
                    if REFUSED.search(str(ev.get("message") or "")):
                        state.update(end_reason="model_refused", error=str(ev["message"])[:500])
                        kill_tree(proc.pid)
                        break
                    reconnecting_since = reconnecting_since or time.monotonic()
                else:
                    reconnecting_since = None
                    last_event = time.monotonic()
                if kind == "thread.started":
                    state["thread_id"] = ev.get(id_field) or state["thread_id"]
                elif kind == "turn.completed":
                    state["completed"] = True
                    state["usage"] = ev.get("usage")
                    completed_at = time.monotonic()
                elif kind == "turn.failed":
                    state["failed"] = True
                    state["error"] = (ev.get("error") or {}).get("message") or json.dumps(ev, ensure_ascii=False)
                    if gemini:
                        state["gemini_quota_kind"] = (ev.get("error") or {}).get("quota_kind")
                        completed_at = time.monotonic()
                elif kind == "error" and not (gemini and state["failed"]):
                    # Retry notices also arrive as top-level errors, so this alone does not end the turn.
                    state["error"] = ev.get("message") or state["error"]
                elif kind == "item.completed" and item.get("type") == "agent_message":
                    state["last_text"] = item.get("text")
                elif kind == "item.completed" and item.get("type") == "command_execution":
                    state["commands"] += 1
                elif kind == "item.completed" and item.get("type") == "file_change":
                    state["file_changes"] += [(c.get("path", ""), c.get("kind", "modified")) for c in item.get("changes", [])]
                    if repeat_guard and item.get("changes"):
                        repeat_guard.clear_changes(c.get("path") for c in item["changes"])
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
        wait_for_windows = proc is not None and gemini and windows_agy(args.agy_command)
        waiting = False
        while True:
            with acquire_file_lock(run_dir / "process.lock", blocking=True):
                if not wait_for_windows or confirm_agy_stopped(run_dir):
                    (run_dir / "codex.pid").unlink(missing_ok=True)
                    (run_dir / "codex.start").unlink(missing_ok=True)
                    break
            if not waiting:
                with suppress(OSError):
                    attempt = runner_activity(run_dir / "events.jsonl")["attempt"]
                    runner_event(run_dir, attempt, "cleanup_wait", "process_cleanup_unconfirmed")
                waiting = True
            time.sleep(2)
        for thread, pipe in ((writer, proc.stdin if proc else None), (reader, proc.stdout if proc else None)):
            if thread is not None:
                with suppress(RuntimeError):
                    thread.join(timeout=1)
            elif pipe is not None:
                with suppress(OSError):
                    pipe.close()
    if fallback_check:
        state["fallback_stream_safe"] = stdout_eof and failure_observed and not possible_write
    return state


def fallback_read_only_event(event):
    if not isinstance(event, dict):
        return False
    kind = event.get("type")
    if kind in ("item.started", "item.updated", "item.completed"):
        item = event.get("item")
        return isinstance(item, dict) and item.get("type") in ("agent_message", "reasoning", "todo_list", "error")
    return kind in ("thread.started", "turn.started", "turn.completed", "turn.failed", "error")


def fallback_config_isolated(cwd):
    """Whether everything the configuration could start is turned off by build_command. Plugins are (the feature
    flag on the command line wins over any config file), so only MCP servers are looked at."""
    user_config = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"
    project = Path(cwd)
    configs = {user_config: True}
    for path in (project, *project.parents):
        configs.setdefault(path / ".codex" / "config.toml", False)

    for path, user in configs.items():
        try:
            config = tomllib.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            return False
        servers = config.get("mcp_servers", {})
        if not isinstance(servers, dict):
            return False
        for name, server in servers.items():
            if (not user or "." in name) and (not isinstance(server, dict) or server.get("enabled") is not False):
                return False
    return True


def classify(state, run_dir):
    """Return (error_kind, retryable) for an attempt that did not complete."""
    if state["end_reason"] == "timeout":
        return "timeout", False
    if state["end_reason"] in ("idle_timeout", "reconnect_timeout"):
        return state["end_reason"], True
    if state["end_reason"] == "spawn_failed":
        return "spawn_failed", False
    if state["end_reason"] == "bad_arguments":
        return "bad_arguments", False
    if state["end_reason"] == "model_refused":
        return "model_refused", False
    if state["end_reason"] == "repeated_failure":
        return "repeated_failure", False
    gemini = state.get("engine") == "gemini"
    text = state["error"] or ""
    if not state["failed"] and not text:
        try:
            with open(run_dir / "stderr.log", "rb") as f:
                f.seek(max(state["stderr_offset"], f.seek(0, os.SEEK_END) - 8000))
                text = f.read().decode("utf-8", "replace")[-2000:]
        except OSError:
            text = ""
        engine = "Gemini" if gemini else "Codex"
        state["error"] = text.strip()[-500:] or f"{engine} exited without turn.completed"
    if gemini:
        if "agy permission denied" in text.lower():
            return "permission_denied", False
        if text.startswith("agy rejected a CLI argument:"):
            return "bad_arguments", False
        if quota_kind := state.get("gemini_quota_kind"):
            return quota_kind, quota_kind == "transient"
        if PROVIDER_PERMANENT.search(text):
            return "provider_permanent", False
    if REFUSED.search(text):
        return "model_refused", False
    if PERMANENT.search(text) or (not gemini and "quota" in text.lower()):
        return "permanent", False
    if REJECTED.search(text):
        return "upstream_rejected", False
    if TRANSIENT.search(text):
        return "transient", True
    return "incomplete", False


SNAPSHOT_SKIP = {".git", "node_modules", "__pycache__", ".venv", ".mypy_cache", ".pytest_cache"}
# A 10k-file tree on /mnt took 47s to walk; past this budget fall back to Codex's own file_change events.
SNAPSHOT_BUDGET = 20
# Fallback baseline of a tree too big to walk: only the event stream shows that Codex ran no tool.
STREAM_ONLY = object()
# Trees that blew the budget are remembered, so later writers skip the doomed 20s walk.
TOO_BIG_FILE = "snapshot-too-big.json"
TOO_BIG_TTL = 7 * 86400
# Hashing a tree for a diff can exceed its budget where the stat-only snapshot does not, so it has its own entry.
DIFF_TOO_BIG = "diff:"
SCOPE_TOO_BIG = "scope:"
SCOPE_SLOW_S = 5  # a scope entry that alone takes longer than this to walk is skipped on later jobs
DIFF_BUDGET = 20
LATE_DIFF_BUDGET = 4  # per step, twice per late diff: a status query must stay quick
DIFF_MAX_BYTES = 5 * 1024 ** 2
DIFF_CACHE_MAX_BYTES = 256 * 1024 ** 2  # one directory's cached index and objects
# The user's diff settings must not change the patch format that `git apply` reads back.
GIT_DIFF = ("-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false",
            "-c", "diff.srcPrefix=a/", "-c", "diff.dstPrefix=b/",
            "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short")


def snapshot(root, budget=SNAPSHOT_BUDGET, scope=None, slow=None, *, strict=False, exclude_tree=None):
    """Map path relative to root -> (size, mtime_ns, mode) under root, or only under the scope files/directories;
    None when the walk exceeds the budget. With scope, entries that took over SCOPE_SLOW_S to walk, or that were being
    walked when the budget ran out, are appended to slow; when only the whole scoped walk took over SCOPE_SLOW_S, its
    slowest entry is."""
    began = time.monotonic()
    durations = {}
    deadline = time.monotonic() + budget
    files = {}

    def add(path):
        try:
            st = os.stat(path, follow_symlinks=False)
        except FileNotFoundError:
            if strict:
                raise
            return
        fingerprint = (st.st_size, st.st_mtime_ns, st.st_mode)
        if strict:
            fingerprint += (st.st_ctime_ns, st.st_ino)
        files[os.path.relpath(path, root).replace(os.sep, "/")] = fingerprint

    def onerror(error):
        if strict or not isinstance(error, FileNotFoundError):
            raise error

    for top in scope or [root]:
        if time.monotonic() > deadline:
            return None
        if not os.path.isdir(top):
            add(top)  # a scoped file, or one that does not exist yet
            continue
        started = time.monotonic()
        for dirpath, dirnames, filenames in os.walk(top, onerror=onerror):
            if time.monotonic() > deadline:
                if slow is not None and scope:
                    slow.append(top)
                return None
            if exclude_tree and normalized_path(dirpath) == os.path.dirname(exclude_tree):
                dirnames[:] = [name for name in dirnames if normalized_path(os.path.join(dirpath, name)) != exclude_tree]
            if strict:
                add(dirpath)
                filenames.extend(name for name in dirnames if os.path.islink(os.path.join(dirpath, name)))
            else:
                dirnames[:] = [d for d in dirnames if d not in SNAPSHOT_SKIP]
            for name in filenames:
                if time.monotonic() > deadline:
                    if slow is not None and scope:
                        slow.append(top)
                    return None
                add(os.path.join(dirpath, name))
        durations[top] = time.monotonic() - started
        if slow is not None and scope and durations[top] > SCOPE_SLOW_S:
            slow.append(top)
    if slow is not None and scope and not slow and durations and time.monotonic() - began > SCOPE_SLOW_S:
        slow.append(max(durations, key=durations.get))
    return files if time.monotonic() <= deadline else None


def too_big_trees():
    try:
        data = json.loads((HOME / TOO_BIG_FILE).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    now = time.time()
    return {k: v for k, v in data.items() if isinstance(v, (int, float)) and now - v < TOO_BIG_TTL} \
        if isinstance(data, dict) else {}


def tree_key(cwd, *, resolve=None):
    return normalized_path((resolve or os.path.realpath)(local_path(cwd)))


def read_step_failures(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return {}


class RepeatGuard:
    def __init__(self, cwd, options, job_dir=None):
        self.cwd = os.path.realpath(local_path(cwd))
        self.cwd_key = tree_key(cwd)
        self.cwd_hash = hashlib.sha1(self.cwd_key.encode("utf-8")).hexdigest()[:16]
        self.enabled = options.get("repeat_guard", "on") == "on"
        self.min_seconds = options.get("repeat_min_seconds", REPEAT_MIN_SECONDS)
        self.threshold = options.get("repeat_failures", REPEAT_FAILURES)
        self.window_hours = options.get("repeat_window_hours", REPEAT_WINDOW_HOURS)
        self.path = HOME / "step-failures.json"
        self.lock = HOME / "locks" / "step-failures.lock"
        self.job_dir = job_dir
        self.blocked = None

    def fingerprint(self, command):
        deadline = time.monotonic() + 2

        def git_state(query):
            status = query(*GIT_DIRTY_STATUS, "--", ".")
            state = {"git:status": hashlib.sha256(status).hexdigest()}
            with suppress(ValueError):
                state["git:head"] = query("rev-parse", "--verify", "HEAD").decode("ascii").strip()
            if status:
                top = os.fsdecode(query("rev-parse", "--show-toplevel").rstrip(b"\r\n"))
                hashes, _ = dirty_file_hashes(Path(local_path(top)), status, deadline)
                state.update({"file:" + hashlib.sha256(name).hexdigest(): digest for name, digest in hashes.items()})
            return state

        cwd = Path(self.cwd)
        state = {}
        if os.environ.get("GIT_DIR") or any((parent / ".git").exists() for parent in (cwd, *cwd.parents)):
            state = git_on_tree(self.cwd, deadline, git_state) or {}
        for match in SCRIPT_NAMES.finditer(command):
            script = (match["quoted_dir"] or match["bare_dir"] or "") + (match["quoted"] or match["bare"])
            path = scope_path(self.cwd, script)
            key = "script:" + hashlib.sha256(os.fsencode(normalized_path(path))).hexdigest()
            try:
                info = os.stat(path)
                state[key] = [info.st_size, info.st_mtime_ns]
            except FileNotFoundError:
                state[key] = "missing"
            except (OSError, ValueError):
                pass
        return state

    @staticmethod
    def step_names(command):
        if not isinstance(command, str):
            return set()
        names = set(re.findall(r"\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b", command)) - POWERSHELL_BUILTINS
        for match in SCRIPT_NAMES.finditer(command):
            name = match["quoted"] or match["bare"]
            if not re.search(r"tmp|temp|run_|wrap", name, re.I):
                names.add(name)
        return names

    def step(self, item):
        command = item.get("command")
        if not isinstance(command, str) or not command:
            return None
        names = {re.sub(r"\d", "#", name) for name in self.step_names(command)}
        signature = self.cwd_key + "\0" + json.dumps(sorted(names)) if names else re.sub(r"\d+", "#", command)
        return hashlib.sha1(signature.encode("utf-8", "surrogatepass")).hexdigest()

    def recent(self, data, now):
        steps = data.get(self.cwd_hash, {})
        cutoff = now - 3600 * self.window_hours
        recent = {}
        for key, value in steps.items():
            if key != "_changed_at":
                events = [event for event in value.get("events", []) if event[0] >= cutoff]
                if events:
                    fingerprint = value.get("fingerprint")
                    recent[key] = {**value, "events": events,
                                   "fingerprint": fingerprint if isinstance(fingerprint, dict) else {}}
        changed_at = steps.get("_changed_at", 0)
        if recent or changed_at:
            recent["_changed_at"] = changed_at
        return recent

    @contextmanager
    def edit(self, clear_keys=()):
        self.lock.parent.mkdir(parents=True, exist_ok=True)
        with acquire_file_lock(self.lock, blocking=True):
            data = read_step_failures(self.path)
            now = time.time()
            steps = self.recent(data, now)
            totals = {**REPEAT_TOTALS, **data.get("_totals", {})}
            cleared = False
            for key in clear_keys:
                if key == self.cwd_hash:
                    steps = {"_changed_at": now}
                elif key in data:
                    data[key] = {"_changed_at": now}
                    cleared = True
            yield steps, totals, now
            if cleared or steps != data.get(self.cwd_hash, {}) or totals != data.get("_totals", REPEAT_TOTALS):
                if steps:
                    data[self.cwd_hash] = steps
                else:
                    data.pop(self.cwd_hash, None)
                data["_totals"] = totals
                tmp = self.path.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(data), "utf-8")
                os.replace(tmp, self.path)

    @staticmethod
    def failure_stats(record):
        events = record["events"]
        return {"failures": len(events), "seconds": sum(event[1] for event in events),
                "last_exit": events[-1][2], "last_at": events[-1][0]}

    def standing(self, steps):
        return [{"step": key[:8], "words": record.get("words", []),
                 **self.failure_stats(record)}
                for key, record in sorted(steps.items()) if key != "_changed_at" and len(record["events"]) >= self.threshold]

    def snapshot(self, *, blocking=True):
        if not self.path.exists():
            return REPEAT_TOTALS.copy(), [], 0
        lock = acquire_file_lock(self.lock, blocking=blocking)
        if lock is None:
            return REPEAT_TOTALS.copy(), [], 0
        with lock:
            data = read_step_failures(self.path)
        return ({**REPEAT_TOTALS, **data.get("_totals", {})},
                self.standing(self.recent(data, time.time())) if self.enabled else [],
                data.get(self.cwd_hash, {}).get("_changed_at", 0))

    def clear(self, *, file_changed=True):
        with self.edit() as (steps, _, now):
            changed_at = now if file_changed else steps.get("_changed_at", 0)
            steps.clear()
            steps["_changed_at"] = changed_at

    def clear_changes(self, paths):
        keys = set()
        for path in paths:
            if isinstance(path, str) and path:
                changed = Path(normalized_path(scope_path(self.cwd, path)))
                keys.update(hashlib.sha1(str(directory).encode("utf-8")).hexdigest()[:16]
                            for directory in (changed, *changed.parents))
        if keys:
            with self.edit(keys):
                pass

    def prepare_prompt(self, prompt, allow_rerun):
        if allow_rerun:
            self.clear(file_changed=False)
        if not self.enabled:
            return prompt
        with self.edit() as (steps, _, _):
            standing = self.standing(steps)
        if standing:
            minutes = round(sum(step["seconds"] for step in standing) / 60)
            prompt += (f"\n\n## 本目录近期反复失败的步骤\n- 有 {len(standing)} 个步骤在最近 {self.window_hours:g} 小时里"
                       f"各失败了 {self.threshold} 次以上（共约 {minutes} 分钟），期间没有文件改动；runner 会拦下再次运行它们。"
                       "先修改相关文件或换掉依赖它的做法；做不到时把依赖它的验收项标 blocked 并写 environment blocker。")
        return prompt

    def check_start(self, step, command):
        with self.edit() as (steps, totals, now):
            record = steps.get(step)
            if record and observations_changed(record["fingerprint"], self.fingerprint(command)):
                steps.pop(step)
                steps["_changed_at"] = now
                record = None
            if record and len(record["events"]) >= self.threshold:
                prior = self.failure_stats(record)
            else:
                if not self.blocked or self.blocked[0] != step:
                    return None
                prior = self.blocked[1]  # the report-only prompt forbids this step even after a patch
            if self.blocked is None:
                self.blocked = (step, prior)
            totals["blocked"] += 1
            totals["seconds_avoided"] += prior["seconds"] / prior["failures"]
            return {"step": step[:8], "prior_failures": prior["failures"], "prior_seconds": prior["seconds"]}

    def complete(self, item, started, received):
        exit_code = item.get("exit_code")
        if type(exit_code) is not int:
            return
        if started:
            step, at = started
            seconds = received - at
        elif exit_code == 0:
            step, seconds = self.step(item), 0
        else:
            return
        if not step or (exit_code != 0 and seconds < self.min_seconds):
            return
        with self.edit() as (steps, _, now):
            if exit_code == 0:
                steps.pop(step, None)
            else:
                prior = steps.get(step, {})
                fingerprint = self.fingerprint(item["command"])
                if prior and observations_changed(prior["fingerprint"], fingerprint):
                    prior = {}
                    steps["_changed_at"] = now
                words = set(prior.get("words", []))
                for name in self.step_names(item.get("command")):
                    separated = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", name)
                    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", separated)
                    words.update(hashlib.sha1(word.encode("utf-8")).hexdigest()[:8]
                                 for word in re.findall(r"[a-z0-9]+", separated.lower())
                                 if word not in SCRIPT_EXTENSIONS)
                steps.setdefault("_changed_at", 0)
                steps[step] = {"events": [*prior.get("events", []), [now, seconds, exit_code]],
                               "fingerprint": {**prior.get("fingerprint", {}), **fingerprint}, "words": sorted(words)}

    def blocks(self):
        try:
            return [json.loads(line) for line in (self.job_dir / "repeat-blocks.jsonl").read_bytes().splitlines(keepends=True)
                    if line.endswith(b"\n")]
        except FileNotFoundError:
            return []

    def record_block(self, block, event_log):
        # The short journal lets status show blocks without scanning the potentially large Codex event stream.
        with open(self.job_dir / "repeat-blocks.jsonl", "ab") as journal:
            journal.write((json.dumps(block) + "\n").encode("utf-8"))
        event_log.write((json.dumps({"type": "runner.repeat_block", **block}) + "\n").encode("utf-8"))
        event_log.flush()

    def summary(self, *, blocking=True):
        return {"blocks": self.blocks(), "standing": self.snapshot(blocking=blocking)[1]}


def remember_too_big(cwd, prefix=""):
    # Only an optimisation: losing a concurrent update or failing to write must never fail the task.
    try:
        data = {**too_big_trees(), prefix + tree_key(cwd): time.time()}
        HOME.mkdir(parents=True, exist_ok=True)
        tmp = HOME / f"{TOO_BIG_FILE}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(data), "utf-8")
        os.replace(tmp, HOME / TOO_BIG_FILE)
    except OSError:
        pass


def diff_index_cache(cwd):
    """One refreshed index per task directory, with the objects it refers to: a repository kept by Windows git has
    stat data that never matches inside WSL, so starting from the user's index re-hashes every tracked file under
    cwd for each task. The objects stay because that index names blobs and trees the repository does not have."""
    return HOME / "diff-index" / write_lock_key(cwd)


def remove_tree(path):
    if IS_WIN and path.is_dir():
        for entry in path.rglob("*"):
            os.chmod(entry, 0o700)  # git writes objects read-only, which Windows refuses to delete
    shutil.rmtree(path, ignore_errors=True)


def forget_too_big(cwd):
    cached = diff_index_cache(cwd)
    had_index = cached.exists()
    remove_tree(cached)
    try:
        data = json.loads((HOME / TOO_BIG_FILE).read_text("utf-8"))
    except FileNotFoundError:
        return had_index
    if not isinstance(data, dict):
        raise ValueError("Snapshot size cache must be a JSON object")
    root = tree_key(cwd)
    # Scope paths under the tree are remembered under both prefixes.
    keys = [k for k in data if k == root or any(
        k.startswith(prefix) and (k[len(prefix):] == root or k[len(prefix):].startswith(root.rstrip(os.sep) + os.sep))
        for prefix in (SCOPE_TOO_BIG, DIFF_TOO_BIG))]
    if not keys:
        return had_index
    for key in keys:
        del data[key]
    tmp = HOME / f"{TOO_BIG_FILE}.{os.getpid()}.tmp"
    tmp.write_text(json.dumps(data), "utf-8")
    os.replace(tmp, HOME / TOO_BIG_FILE)
    return True


def thread_last_input_tokens(thread_id, tail=512 * 1024):
    """Input tokens of the thread's last model request, from its rollout's last token count; None if unknown.
    Read-only: a continuation decides from this whether resuming would re-send a large history."""
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    files = sorted(glob.glob(str(home / "sessions" / "*" / "*" / "*" / f"rollout-*-{glob.escape(thread_id)}.jsonl")))
    if not files:
        return None
    try:
        with open(files[-1], "rb") as f:
            f.seek(max(0, f.seek(0, os.SEEK_END) - tail))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    found = re.findall(r'"last_token_usage":\s*\{[^}]*"input_tokens":\s*(\d+)', text)
    return int(found[-1]) if found else None


def scope_path(cwd, scope, *, resolve=None):
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
    return (resolve or os.path.realpath)(path)


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
    # A scope directory that once ran the walk out of budget is skipped for the too-big TTL; the other scope entries
    # are still snapshotted, and changes inside the skipped directory come from Codex's events, as when the walk fails.
    known = too_big_trees()
    scope = [p for p in (scope_path(cwd, s) for s in scope_args or []) if SCOPE_TOO_BIG + tree_key(p) not in known]
    slow = []
    try:
        before = snapshot(cwd, scope=scope, slow=slow) if scope else None
    except OSError:
        return None, scope
    for path in slow:
        remember_too_big(path, SCOPE_TOO_BIG)
    return (before, scope) if scope else (None, None)


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


def git(cwd, *argv, deadline, env=None, program="git"):
    p = subprocess.run([program, "-C", cwd, "-c", "core.fsmonitor=false", "-c", "core.splitIndex=false", *argv],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=max(0.1, deadline - time.monotonic()),
                       creationflags=NO_WINDOW, env={**os.environ, "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0", **(env or {})})
    if p.returncode:
        raise ValueError(p.stderr.decode("utf-8", "replace").strip() or f"git exited {p.returncode}")
    return p.stdout


def git_on_tree(cwd, deadline, operation, *, raise_errors=False):
    def run(directory, program):
        def query(*argv, at=directory):
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(argv, 0)
            return git(at, *argv, deadline=deadline, program=program)
        result = operation(query)
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired(program, 0)
        return result

    try:
        try:
            return run(cwd, "git")
        except (OSError, ValueError):
            drive = re.fullmatch(r"/mnt/([a-zA-Z])/(.*)", cwd) if not IS_WIN else None
            windows_git = drive and shutil.which("git.exe")
            if not windows_git or time.monotonic() >= deadline:
                raise
            directory = f"{drive[1].upper()}:/" + drive[2]
            return run(directory, windows_git)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        if raise_errors:
            raise
        return None


def observations_changed(before, after):
    return any(key in before and before[key] != value for key, value in after.items())


def verification_observations_changed(before, after):
    for name in before.keys() & after.keys():
        previous_stat, previous_hash = before[name]
        current_stat, current_hash = after[name]
        if previous_stat != current_stat or (
                previous_hash is not None and current_hash is not None and previous_hash != current_hash):
            return True
    return False


def stat_fingerprint(info):
    return info.st_size, info.st_mtime_ns, stat.S_IFMT(info.st_mode)


def dirty_file_stats(directory, names, deadline):
    def scan(batch):
        fingerprints, unchecked = {}, set()
        for name in batch:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("dirty file checks", 0)
            path = directory / os.fsdecode(name)
            try:
                info = path.lstat()
                if stat.S_ISREG(info.st_mode):
                    fingerprints[name] = (stat_fingerprint(info), None)
                    continue
                if stat.S_ISLNK(info.st_mode):
                    content_hash = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
                    fingerprints[name] = (stat_fingerprint(info), content_hash)
                    continue
            except (OSError, ValueError):
                pass
            unchecked.add(name)
        return fingerprints, unchecked

    fingerprints, unchecked = {}, set()
    batches = (names[offset::VERIFY_STAT_WORKERS] for offset in range(VERIFY_STAT_WORKERS))
    with ThreadPoolExecutor(max_workers=VERIFY_STAT_WORKERS) as workers:
        for batch, skipped in workers.map(scan, batches):
            fingerprints.update(batch)
            unchecked.update(skipped)
    return fingerprints, unchecked


def dirty_file_hashes(directory, status, deadline, *, stat_fallback=False):
    names = [entry[3:] for entry in status.split(b"\0") if entry and entry[1:2] != b"D"]
    if stat_fallback and len(names) > VERIFY_CONTENT_FILES:
        return dirty_file_stats(directory, names, deadline)

    hashes, unchecked = {}, set()
    remaining = VERIFY_TOTAL_LIMIT
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    for name in names:
        if time.monotonic() >= deadline:
            raise subprocess.TimeoutExpired("dirty file checks", 0)
        path = directory / os.fsdecode(name)
        limit = min(remaining, VERIFY_FILE_LIMIT)
        try:
            info = path.lstat()
            metadata = stat_fingerprint(info) if stat_fallback else None
            if stat.S_ISLNK(info.st_mode):
                content = os.fsencode(os.readlink(path))
            elif stat.S_ISREG(info.st_mode):
                if stat_fallback:
                    hashes[name] = (metadata, None)
                if info.st_size <= limit:
                    with os.fdopen(os.open(path, flags), "rb") as file:
                        opened = os.fstat(file.fileno())
                        content = file.read(limit + 1) if stat.S_ISREG(opened.st_mode) and opened.st_size <= limit else None
                elif stat_fallback:
                    continue
                else:
                    content = None
            else:
                content = None
        except (OSError, ValueError):
            content = None
        if content is None or len(content) > limit:
            unchecked.add(name)
        else:
            remaining -= len(content)
            content_hash = hashlib.sha256(content).hexdigest()
            hashes[name] = (metadata, content_hash) if stat_fallback else content_hash
    return hashes, unchecked


def verification_git_digest(cwd, paths, *, budget=30, strict=False):
    deadline = time.monotonic() + budget

    def digest(query):
        head = query("rev-parse", "--verify", "HEAD")
        whole = hashlib.sha256(head + b"\0" + query(*GIT_DIRTY_STATUS)).digest()
        top = os.fsdecode(query("rev-parse", "--show-toplevel").rstrip(b"\r\n"))
        directory = Path(local_path(top))
        root = Path(normalized_path(str(directory)))
        relative = sorted({Path(*Path(path).parts[len(root.parts):]).as_posix()
                           for path in paths if Path(normalized_path(path)).is_relative_to(root)})
        if not relative:
            return whole, None, set()
        tree = query("--literal-pathspecs", "ls-tree", "-rz", "HEAD", "--", *relative, at=top)
        index = query("--literal-pathspecs", "diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames",
                      "HEAD", "--", *relative, at=top)
        scoped = query("--literal-pathspecs", *GIT_DIRTY_STATUS, "--", *relative, at=top)
        if strict and query("--literal-pathspecs", "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", *relative, at=top):
            return whole, None, set()
        hashes, unchecked = dirty_file_hashes(directory, scoped, deadline, stat_fallback=not strict)
        checksum = hashlib.sha256(tree + b"\0" + index + b"\0" + scoped).digest()
        return whole, (checksum, hashes), unchecked

    return git_on_tree(cwd, deadline, digest, raise_errors=True)


def verification_paths(context, cwd):
    source = job_status(context["verification_of"])
    if not source.get("cwd") or tree_key(source["cwd"]) != tree_key(cwd):
        return []
    files = [entry.get("path") if isinstance(entry, dict) else entry
             for entry in (source.get("files_changed") or []) + (source.get("write_paths") or [])]
    return [scope_path(cwd, path) for path in [*(source.get("scope_paths") or source.get("scope") or []), *files]
            if isinstance(path, str) and path.strip()]


def verification_version(source):
    cwd = source.get("cwd")
    if not cwd:
        return None
    report = source.get("structured") or {}
    files = [entry.get("path") if isinstance(entry, dict) else entry for entry in
             [*(source.get("files_changed") or []), *(source.get("write_paths") or []), *report.get("files_changed", [])]]
    paths = [*(source.get("scope_paths") or source.get("scope") or []), *files, source.get("output")]
    root = Path(tree_key(cwd))
    if any(not Path(tree_key(scope_path(cwd, file))).is_relative_to(root) for file in paths if isinstance(file, str) and file):
        return None
    try:
        _, digest, unchecked = verification_git_digest(cwd, [cwd], budget=3, strict=True)
        if digest is not None and not unchecked:
            tree, changes = digest
            return hashlib.sha256(repr((tree, sorted(changes.items()))).encode("utf-8")).hexdigest()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        pass
    return None


def concurrent_writer_in_scope(paths, run_dir, started):
    roots = [Path(tree_key(path)) for path in paths]
    runs = HOME / "runs"
    for job_dir in [*job_directories(), *(runs.iterdir() if runs.exists() else ())]:
        if job_dir == run_dir:
            continue
        with suppress(OSError, ValueError, TypeError):
            if not (job_dir / "stderr.log").exists():
                continue
            task = task_record(job_dir)
            cwd, sandbox = task.get("cwd"), task.get("sandbox")
            if not cwd or not sandbox or not writer(sandbox, task.get("context")):
                continue
            scopes = [scope_path(cwd, path) for path in task.get("scope") or []]
            writable = scopes or write_lock_roots(cwd, sandbox, task.get("writable_roots"), task.get("context")).values()
            other = [Path(tree_key(path)) for path in writable]
            if not any(path.is_relative_to(root) or root.is_relative_to(path) for path in other for root in roots):
                continue
            result_file = job_dir / "result.json"
            if result_file.exists():
                if result_file.stat().st_mtime > started:
                    return True
            elif job_dir.parent == runs and recorded_pid(job_dir / "worker.pid") is not None:
                return True
            elif job_dir.parent != runs and job_status(job_dir.name)["status"] == "running":
                return True
    return False


def diff_fields(job_dir):
    """The saved diff_* fields of a writer and when it was rolled back."""
    info = {}
    for name in ("diff.json", "rollback.json"):
        try:
            info.update(json.loads((job_dir / name).read_text("utf-8")))
        except (OSError, ValueError, TypeError):
            pass
    return info


def diff_save(job_dir, info):
    tmp = job_dir / "diff.json.tmp"
    tmp.write_text(json.dumps(info), "utf-8")
    os.replace(tmp, job_dir / "diff.json")
    # The patch is self-contained, so the task's own index and objects are only needed until it exists.
    for name in ("diff.index", "diff.index.lock", "diff-base.json"):
        (job_dir / name).unlink(missing_ok=True)
    remove_tree(job_dir / "diff-objects")
    return info


def diff_skipped(job_dir, reason, info=None):
    return diff_save(job_dir, {**(info or {}), "diff_status": "skipped",
                               "diff_reason": (reason.strip().splitlines() or ["git failed"])[0][:300]})


def diff_tree(job_dir, base, budget):
    """Write the tree of the starting index plus everything under cwd that .gitignore lets through. The index and
    the new objects live under the runner home, so the repository's own index, HEAD and object store stay as they are."""
    deadline = time.monotonic() + budget
    env = {"GIT_INDEX_FILE": str(job_dir / "diff.index"), "GIT_OBJECT_DIRECTORY": base["object_dir"],
           "GIT_ALTERNATE_OBJECT_DIRECTORIES": base["objects"]}
    (job_dir / "diff.index.lock").unlink(missing_ok=True)  # left by a git that was stopped at its deadline
    paths = base.get("paths") or ["."]
    # A scope path that is not there has nothing to add, and `git add` fails on it; when the index tracks it, the
    # tree must still say the file is gone.
    missing = [p for p in paths if not os.path.lexists(os.path.join(base["cwd"], p))]
    if missing:
        git(base["cwd"], "--literal-pathspecs", "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", *missing,
            deadline=deadline, env=env)
    present = [p for p in paths if p not in missing]
    if present and base.get("paths"):
        # `git add` fails on a named path that .gitignore excludes; such a scope path has nothing to show.
        try:
            # shortcut: a name with a quote, backslash or control character comes back quoted and is not recognised
            # (the diff then fails as before); `-z` needs --stdin, switch to that if such names turn up.
            ignored = git(base["cwd"], "-c", "core.quotePath=false", "check-ignore", "--",
                          *present, deadline=deadline, env=env).decode("utf-8").splitlines()
        except ValueError as e:
            if str(e) != "git exited 1":  # exit 1 with nothing on stderr: none of them is ignored
                raise
            ignored = []
        present = [p for p in present if p not in ignored]
    if present:
        git(base["cwd"], "--literal-pathspecs", "add", "-A", "--", *present, deadline=deadline, env=env)
    return git(base["cwd"], "write-tree", deadline=deadline, env=env).decode("ascii").strip(), env


def diff_slow_paths(base):
    """What a diff that ran out of time is remembered by: the scope paths it was limited to, or the whole tree."""
    return [os.path.join(base["cwd"], p) for p in base.get("paths") or ["."]]


def diff_begin(job_dir, cwd, enabled=True, scope=None):
    """Record the tree a writer starts from. Nothing here may fail the task: every problem becomes diff.json."""
    if not enabled:
        return diff_skipped(job_dir, "disabled by --no-diff")
    known = too_big_trees().keys()
    only = None
    if {tree_key(cwd), DIFF_TOO_BIG + tree_key(cwd)} & known:
        # 310 of 310 writers in two big work trees left no patch. A task with a scope still gets one for the paths it
        # may change: git then looks at those instead of the whole tree.
        here = os.path.realpath(cwd)
        inside = [p for p in scope or [] if p != here and Path(p).is_relative_to(here) and DIFF_TOO_BIG + tree_key(p) not in known]
        if not inside or len(inside) < len(scope):
            return diff_skipped(job_dir, "the tree is recorded as too big")
        only = [os.path.relpath(p, here).replace(os.sep, "/") for p in inside]
    try:
        try:
            paths = git(cwd, "rev-parse", "--show-toplevel", "--git-path", "objects", "--git-path", "index",
                        deadline=time.monotonic() + DIFF_BUDGET).decode("utf-8").splitlines()
        except ValueError as e:
            if "not a git repository" not in str(e):
                raise
            return diff_save(job_dir, {"diff_status": "not_git"})
        repo, objects, index = (os.path.normpath(os.path.join(cwd, p)) for p in paths)
        base = {"cwd": cwd, "repo": repo, "objects": objects, **({"paths": only} if only else {})}
        deadline = time.monotonic() + DIFF_BUDGET
        cache = diff_index_cache(cwd)

        def user_index():
            (job_dir / "diff.index").unlink(missing_ok=True)
            with suppress(FileNotFoundError):  # a repository without an index yet (no HEAD) starts from the empty tree
                shutil.copy2(index, job_dir / "diff.index")

        # Either index is only a starting point: `git add -A` makes the entries under cwd equal the work tree, and
        # the entries elsewhere are the same in both trees. copy2 keeps the mtime git's racy-entry check relies on.
        try:
            (cache / "objects").mkdir(parents=True, exist_ok=True)
            base.update(object_dir=str(cache / "objects"), cached=True)
            try:
                shutil.copy2(cache / "index", job_dir / "diff.index")
            except FileNotFoundError:
                user_index()  # the first writer here: its objects stay, and the index it leaves joins them
            base["tree"] = diff_tree(job_dir, base, DIFF_BUDGET)[0]
        except (OSError, ValueError):
            # The cache cannot be used (or no longer fits this repository): drop it and work in the task directory.
            remove_tree(cache)
            (job_dir / "diff-objects").mkdir(exist_ok=True)
            base.update(object_dir=str(job_dir / "diff-objects"), cached=False)
            user_index()
            base["tree"] = diff_tree(job_dir, base, max(0.1, deadline - time.monotonic()))[0]
        (job_dir / "diff-base.json").write_text(json.dumps(base), "utf-8")
    except subprocess.TimeoutExpired:
        for path in diff_slow_paths({"cwd": cwd, "paths": only}):
            remember_too_big(path, DIFF_TOO_BIG)
        diff_skipped(job_dir, f"recording the starting tree exceeded {DIFF_BUDGET}s")
    except (OSError, ValueError) as e:
        diff_skipped(job_dir, str(e) or type(e).__name__)


def diff_end(job_dir, budget=DIFF_BUDGET, note=None):
    """Record the tree a writer left and save the difference as diff.patch. Returns the diff_* result fields."""
    try:
        base = json.loads((job_dir / "diff-base.json").read_text("utf-8"))
    except (OSError, ValueError):
        return diff_fields(job_dir)  # no starting tree: diff.json already says why, or the task took none
    patch = job_dir / "diff.patch"
    info = {"diff_note": note} if note else {}
    try:
        info["diff_repo"] = base["repo"]
        tree, env = diff_tree(job_dir, base, budget)
        cache = diff_index_cache(base["cwd"]) if base["cached"] else None
        with suppress(OSError):  # losing the cached index only costs the next writer here its re-hash
            if cache is not None:
                tmp = cache / f"index.{os.getpid()}.tmp"
                shutil.copy2(job_dir / "diff.index", tmp)
                os.replace(tmp, cache / "index")
        deadline = time.monotonic() + budget
        compare = lambda *options: git(base["cwd"], *GIT_DIFF, *options, base["tree"], tree, "--", ".",
                                       deadline=deadline, env=env)
        files = compare("--name-only", "-z").count(b"\0")
        size = 0
        if files:
            compare("--binary", f"--output={patch}")
            size = patch.stat().st_size
            if size > DIFF_MAX_BYTES:
                patch.write_bytes(compare("--stat=200"))  # too big to keep or to roll back: only the file list remains
        info.update(diff_status="empty" if not files else "too_large" if size > DIFF_MAX_BYTES else "captured",
                    diff_bytes=size, diff_files=files)
        with suppress(OSError):
            # Objects are never collected, so past the limit the cache starts over with the next writer. A late diff
            # holds no write lock and leaves it to the task that may be using it.
            if cache is not None and not note and storage_size(cache) > DIFF_CACHE_MAX_BYTES:
                remove_tree(cache)
        return diff_save(job_dir, info)
    except subprocess.TimeoutExpired:
        if budget >= DIFF_BUDGET:
            for path in diff_slow_paths(base):
                remember_too_big(path, DIFF_TOO_BIG)
        reason = f"recording the final tree exceeded {budget}s"
    except (OSError, ValueError, KeyError, TypeError) as e:
        reason = str(e) or type(e).__name__
    patch.unlink(missing_ok=True)
    return diff_skipped(job_dir, reason, info)


def late_diff(job_dir):
    """A worker that died left a starting tree but no patch: record the final tree now, once nothing is running."""
    if not (job_dir / "diff-base.json").exists() or \
            any(recorded_pid(job_dir / name) is not None for name in ("worker.pid", "codex.pid")):
        return
    lock = acquire_file_lock(job_dir / "process.lock")  # a cancel in progress records the tree itself
    if lock is not None:
        with lock:
            diff_end(job_dir, LATE_DIFF_BUDGET, "Recorded after the worker died: may include later changes to the tree.")


def parse_final_message(final):
    try:
        return json.loads(final), []
    except json.JSONDecodeError as original_error:
        try:
            report = json.loads(final, strict=False)
            repaired = ["control_character"]
        except json.JSONDecodeError:
            # Match strings first so escaped quotes and paired backslashes keep their meaning.
            escaped = re.sub(r'"(?:[^"\\]|\\.)*"', lambda string: re.sub(
                r'\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|\\',
                lambda escape: escape[0] if len(escape[0]) > 1 else "\\\\", string[0]), final, flags=re.S)
            if escaped == final:
                raise original_error
            repaired = ["invalid_escape"]
            try:
                report = json.loads(escaped)
            except json.JSONDecodeError:
                try:
                    report = json.loads(escaped, strict=False)
                    repaired.insert(0, "control_character")
                except json.JSONDecodeError:
                    raise original_error
        if not valid_report(report):
            raise original_error
        return report, repaired


def execute(args, prompt, run_dir):
    run_dir.mkdir(parents=True, exist_ok=True)
    args.cwd = os.path.realpath(args.cwd)
    gemini = getattr(args, "engine", None) == "gemini"
    id_field = "conversation_id" if gemini else "thread_id"
    scope_args = [scope_path(args.cwd, s) for s in getattr(args, "scope", None) or []]
    base = {"cwd": args.cwd, "sandbox": args.sandbox, "log_dir": str(run_dir)}
    fallback_check = getattr(args, "gemini_fallback_check", False)
    if fallback_check:
        base["fallback_safe"] = False
    ignore, warnings = ignore_patterns(getattr(args, "ignore", None))
    if warnings:
        base["ignore_warnings"] = warnings
    if getattr(args, "context", None) is not None:
        base["context"] = args.context
    if scope_args:
        base.update(scope=getattr(args, "scope", None), scope_paths=scope_args)
    started = time.time()
    context = getattr(args, "context", None) or {}
    if gemini:
        args.context = context or None
        base["task_options"] = task_options(vars(args))
    verification = context.get("verification_of") and context.get("write") is False
    host_verification = verification and args.sandbox == "danger-full-access"
    if not gemini and verification and args.sandbox in ("read-only", "danger-full-access"):
        scratch = (run_dir / "scratch").resolve()
        if Path(normalized_path(str(scratch))).is_relative_to(Path(normalized_path(args.cwd))):
            return {**base, "status": "failed", "error_kind": "verification_scratch_overlap",
                    "error": "Verification scratch would be inside the project directory.",
                    "retryable": False, "attempts": 0}
        args.verification_scratch = scratch
    if not gemini and verification and args.sandbox == "read-only":
        prompt = (f"Verification project directory (absolute): {json.dumps(args.cwd, ensure_ascii=False)}\n"
                  "当前目录是核验暂存区。先读取上述项目目录中适用的 AGENTS.md。项目目录只读，"
                  "相对路径均以该项目目录为准。运行检查时先切到项目目录（cd <项目绝对路径> && …），"
                  "临时文件和测试缓存写入 TMPDIR。\n\n" + prompt)
    declared_paths = verification_paths(context, args.cwd) if host_verification else []
    paths = declared_paths or [args.cwd]

    def take_snapshot(stage):
        try:
            digest = verification_git_digest(args.cwd, paths)
        except subprocess.TimeoutExpired:
            return None, f"{stage}_timeout"
        except (OSError, ValueError):
            return None, f"{stage}_git_error"
        except RuntimeError:
            return None, f"{stage}_error"
        return (None, f"{stage}_no_scope") if digest[1] is None else (digest, None)

    before_digest, before_reason = take_snapshot("before") if host_verification else (None, None)
    verification_scope = (context.get("routing") or {}).get("verification_scope") if verification else None
    version_source = job_status(context["verification_of"]) if isinstance(verification_scope, str) else None
    before_version = verification_version(version_source) if version_source else None

    def finish(result):
        if before_version and result["status"] == "completed" and before_version == verification_version(version_source):
            result.update(verification_version=before_version, verification_scope=verification_scope)
        if not host_verification:
            return result
        after_digest, reason = take_snapshot("after") if before_digest is not None else (None, before_reason)
        if reason:
            result.update(verification_integrity="unavailable", verification_integrity_reason=reason)
        else:
            before_whole, before_scope, before_unchecked = before_digest
            after_whole, after_scope, after_unchecked = after_digest
            scope_changed = before_scope[0] != after_scope[0] or verification_observations_changed(
                before_scope[1], after_scope[1])
            unchecked = before_unchecked | after_unchecked
            if unchecked:
                result.update(verification_integrity="unchecked", verification_unchecked_files=len(unchecked))
            if scope_changed and (declared_paths or not concurrent_writer_in_scope(paths, run_dir, started)):
                result.pop("structured", None)
                result.update(status="failed", error_kind="verification_tree_changed", retryable=False,
                              error="Git status, index or file contents changed within the monitored verification paths.")
            elif before_whole != after_whole or scope_changed:
                result["verification_integrity"] = "concurrent_changes"
        return result

    repeat_guard = RepeatGuard(args.cwd, vars(args), run_dir)
    locks = []
    before = scope = None
    event_changes = []
    writes = writer(args.sandbox, getattr(args, "context", None))
    roots = {}

    def fallback_snapshot():
        monitored = list(dict.fromkeys(os.path.realpath(path) for path in roots.values())) if roots else [args.cwd]
        try:
            runner_home = Path(normalized_path(str(HOME.resolve())))
            if any(Path(normalized_path(path)).is_relative_to(runner_home) for path in monitored):
                return None
            # Every tool call arrives as an item event, so a stream with none of them is enough when the walk cannot
            # finish; without this a big workspace never hands a refused or out-of-quota task to Gemini.
            known = too_big_trees()
            if all(tree_key(path) in known for path in monitored):
                return STREAM_ONLY
            walked = snapshot(args.cwd, scope=monitored, strict=True, exclude_tree=str(runner_home))
            return STREAM_ONLY if walked is None else walked
        except (OSError, ValueError):
            return None

    def tree_changed():
        return baseline is not STREAM_ONLY and baseline != fallback_snapshot()

    try:
        if writes:
            try:
                roots = write_lock_roots(args.cwd, args.sandbox, getattr(args, "writable_roots", None),
                                         getattr(args, "context", None))
                lock_timeout = getattr(args, "lock_timeout", None)
                deadline = time.monotonic() + lock_timeout if lock_timeout is not None else None
                waiting = False
                (HOME / "locks").mkdir(parents=True, exist_ok=True)
                while True:
                    if waiting and deadline is not None and time.monotonic() >= deadline:
                        return {**base, "status": "failed", "error_kind": "lock_timeout",
                                "error": f"Timed out waiting for directory write locks; {'Gemini' if gemini else 'Codex'} was not started.",
                                "retryable": True, "attempts": 0, "duration_s": round(time.time() - started, 1)}
                    admission = acquire_file_lock(HOME / "locks" / "admission.lock")
                    if admission is not None:
                        with admission:
                            # Keep overlap checks and all directory claims in one critical section.
                            if not earlier_writer_waiting(run_dir, roots, getattr(args, "lost_after", LOST_AFTER)):
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
                    delay = 0.25 if deadline is None else min(0.25, max(0, deadline - time.monotonic()))
                    time.sleep(delay)
            except OSError as error:
                return {**base, "status": "failed", "error_kind": "runner_error", "error": str(error),
                        "retryable": False, "attempts": 0, "duration_s": round(time.time() - started, 1)}
        baseline = (fallback_snapshot() if fallback_check and not args.use_user_config and
                    fallback_config_isolated(args.cwd) else None)
        if writes:
            # Jobs queued before --scope existed have no scope in args.json.
            before, scope = snapshot_before(args.cwd, scope_args)
            with suppress(OSError):  # not even a full disk may fail the task over its diff
                diff_begin(run_dir, args.cwd, not getattr(args, "no_diff", False), scope_args)

        def changes():
            if args.sandbox == "read-only":
                return {}
            result = files_changed(args.cwd, before, event_changes, scope, ignore)
            if gemini:
                result["files_changed_source"] = result["files_changed_source"].replace("codex_events", "gemini_events")
            return result

        def diff():
            try:
                return diff_end(run_dir) if writes else {}
            except OSError as error:
                return {"diff_status": "skipped", "diff_reason": str(error)[:300]}

        # Read-only runs are --ephemeral, so only a writer thread they resumed can be resumed again.
        resumable = lambda tid: tid if gemini or args.sandbox != "read-only" else args.resume
        prompt = repeat_guard.prepare_prompt(prompt, getattr(args, "allow_rerun", False))
        thread_id = args.resume
        attempt = 0
        last_error_kind = None
        report_only = False
        while True:
            attempt += 1
            if not gemini:
                runner_event(run_dir, attempt, "router_check", last_error_kind)
            if not gemini and not router_reachable():
                state = {"end_reason": "router_down", "error": "Local model router is not reachable", "thread_id": thread_id}
                kind, retryable = "router_down", True
                if baseline is not None and tree_changed():
                    baseline = None
            else:
                resumed = bool(thread_id)  # a read-only retry drops the resumed thread and starts fresh
                runner_event(run_dir, attempt, "gemini_running" if gemini else "codex_running", last_error_kind)
                state = run_attempt(args, prompt, run_dir, thread_id, repeat_guard)
                if baseline is not None and (not state.get("fallback_stream_safe") or state["file_changes"] or
                                             tree_changed()):
                    baseline = None
                followup_thread = resumable(state["thread_id"])
                if not gemini and args.sandbox == "read-only":
                    followup_thread = thread_id
                thread_id = state["thread_id"]
                event_changes += state["file_changes"]
                if state.get("repeat_block") and not report_only and followup_thread:
                    block = state["repeat_block"]
                    failures = block["prior_failures"]
                    prompt = (f"runner 拦下了第 {failures + 1} 次运行同一个失败步骤（前 {failures} 次都失败，"
                              f"共 {round(block['prior_seconds'])} 秒，期间没有观察到文件改动）。"
                              "不要再运行这个步骤，也不要换个写法运行它。现在只整理并输出最终报告："
                              "依赖这一步的验收项标 blocked，blockers 写一条 environment（需要用户处理时用 user_input），"
                              "说明失败现象和已经尝试过的做法；其余已完成的验收照常汇报。")
                    thread_id = followup_thread
                    report_only = True
                    last_error_kind = "repeat_block"
                    (run_dir / "last_message.txt").unlink(missing_ok=True)
                    continue
                if state["completed"] and not state["failed"]:
                    break
                kind, retryable = classify(state, run_dir)
            last_error_kind = kind
            # Codex read-only runs are ephemeral. Gemini resumes any conversation it started.
            can_retry = (not report_only and retryable and attempt <= args.retries and
                         (args.sandbox == "read-only" or thread_id or kind == "router_down"))
            if not can_retry:
                error = state.get("error") or ""
                if baseline is not None and (
                        kind in ("router_down", "model_refused", "upstream_rejected", "transient", "reconnect_timeout") or
                        (kind == "permanent" and (PROVIDER_PERMANENT.search(error) or "quota" in error.lower()))):
                    base["fallback_safe"] = True
                runner_event(run_dir, attempt, "finalizing", kind)
                return finish({**base, "status": "failed", "error_kind": kind, "error": state.get("error"), "retryable": retryable,
                        "attempts": attempt, id_field: resumable(thread_id), "duration_s": round(time.time() - started, 1),
                        **changes(), **diff(), "repeat_guard": repeat_guard.summary()})
            delay = min(60, args.backoff * 3 ** (attempt - 1)) * random.uniform(0.8, 1.2)
            runner_event(run_dir, attempt, "retry_wait", kind, time.time() + delay)
            time.sleep(delay)
            if thread_id and (gemini or args.sandbox != "read-only") and kind != "router_down" and state["prompt_delivered"]:
                prompt = ("The previous attempt was interrupted. Inspect the current state of the workspace, "
                          "then finish the original task without repeating completed work.")
            elif not gemini and args.sandbox == "read-only" and kind != "router_down":
                thread_id = None

        runner_event(run_dir, attempt, "finalizing", last_error_kind)
        message_file = run_dir / "last_message.txt"
        if gemini and state["last_text"] is not None:
            message_file.write_text(state["last_text"], encoding="utf-8", errors="replace")
        final = message_file.read_text("utf-8", "replace").strip() if message_file.exists() else ""
        final = final or state["last_text"] or ""
        result = {**base, "status": "completed", "attempts": attempt, id_field: resumable(thread_id),
                  "final_message": final[:8000],
                  "truncated": len(final) > 8000, "usage": state["usage"], "commands_run": state["commands"],
                  "forced_exit": state["forced_exit"], "duration_s": round(time.time() - started, 1), **changes(), **diff(),
                  "repeat_guard": repeat_guard.summary()}
        if resumed and not gemini:
            result["usage_scope"] = "thread_total"  # exec resume reports the whole thread's cumulative usage
        if args.schema:
            try:
                report, repaired = parse_final_message(final)
                if gemini and not valid_report(report):
                    raise ValueError("Final message does not match the task report schema")
                result["structured"] = report
                if repaired:
                    result["final_message_repaired"] = repaired
            except ValueError as error:
                message = str(error) if gemini and not isinstance(error, json.JSONDecodeError) else "Final message is not valid JSON"
                if isinstance(error, json.JSONDecodeError):
                    message += f": {error.msg} (line {error.lineno}, column {error.colno})"
                result.update(status="failed", error_kind="schema_invalid", error=message, retryable=False)
        return finish(result)
    finally:
        for lock in reversed(locks):
            lock.close()


def positive_float(value):
    number = float(value)
    if not 0 < number < float("inf"):
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return number


def positive_int(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def parse_model_ab(value):
    try:
        models, share = json.loads(value)
        if (isinstance(models, list) and len(models) == 2 and
                all(isinstance(model, str) and model.strip() for model in models) and models[0] != models[1] and
                type(share) in (int, float) and 0 <= share <= 1):
            return models, share
    except (TypeError, ValueError):
        pass
    raise argparse.ArgumentTypeError("model A/B requires [two distinct models, share from 0 to 1]")


def select_ab_model(job_id, models, share):
    bucket = int.from_bytes(hashlib.sha256(job_id.encode("utf-8")).digest()[:4], "big") / (1 << 32)
    return models[0] if bucket < share else models[1]


def add_task_arguments(p):
    p.add_argument("--context-json", action="store_true", help="Read a prompt/context JSON envelope from stdin")
    p.add_argument("--cwd", required=True)
    p.add_argument("--engine", choices=("codex", "gemini"), default="codex")
    p.add_argument("--agy-command", help="Antigravity executable for Gemini")
    p.add_argument("--agy-proxy", help="Proxy for Antigravity")
    p.add_argument("--agy-home", help="Windows directory used as HOME/USERPROFILE for Antigravity (one pooled account)")
    p.add_argument("--gemini-fallback-check", action="store_true", help="Check whether a failed Codex task left its worktree untouched")
    # danger-full-access is for host-access runs: the Codex sandbox blocks WSL interop, so Windows programs need it.
    p.add_argument("--sandbox", choices=["read-only", "workspace-write", "danger-full-access"], default="read-only")
    p.add_argument("--model", help="Model override; omitted keeps the Codex config default")
    p.add_argument("--effort", help="Reasoning effort override; omitted keeps the Codex config default")
    p.add_argument("--service-tier", help='Codex service tier, e.g. "fast" for Fast mode; omitted keeps the config value')
    p.add_argument("--schema")
    p.add_argument("--resume", help="Continue a Codex thread or Gemini conversation by provider ID")
    p.add_argument("--scope", action="append",
                   help="File or directory (relative to --cwd) to snapshot when cwd is too big to walk; repeatable")
    p.add_argument("--writable-root", dest="writable_roots", action="append",
                   help="Additional writable directory for workspace-write; repeatable")
    p.add_argument("--ignore", action="append",
                   help="Regex for cwd-relative paths other processes write; such changes are left out; repeatable")
    p.add_argument("--use-user-config", action="store_true", help="Inherit ~/.codex/config.toml, MCP servers and hooks")
    p.add_argument("--no-diff", action="store_true", help="Do not record a writer's changes as diff.patch")
    p.add_argument("--timeout", type=float, default=3600)
    p.add_argument("--lock-timeout", type=positive_float, help="Maximum seconds waiting for write locks; omitted waits indefinitely")
    p.add_argument("--max-storage-mb", type=positive_float, help="Best-effort jobs/runs storage limit in MiB; omitted is unlimited")
    # The Windows sandbox setup alone was silent for about 60s, so keep this well above that.
    p.add_argument("--idle-timeout", type=float, default=600)
    p.add_argument("--reconnect-timeout", type=float, default=180)
    p.add_argument("--exit-grace", type=float, default=EXIT_GRACE_SECONDS)
    p.add_argument("--retries", type=int, default=2)
    p.add_argument("--backoff", type=float, default=5)
    p.add_argument("--repeat-min-seconds", type=positive_float, default=REPEAT_MIN_SECONDS)
    p.add_argument("--repeat-failures", type=positive_int, default=REPEAT_FAILURES)
    p.add_argument("--repeat-window-hours", type=positive_float, default=REPEAT_WINDOW_HOURS)
    p.add_argument("--repeat-guard", choices=("off", "on"), default="on",
                   help="Block repeated long failures; completed file_change events reset counts (shell edits are invisible)")
    p.add_argument("--allow-rerun", action="store_true", help="Clear this cwd's repeated failures at job start")


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


def write_result(job_dir, result, *, activity=None):
    tmp = job_dir / "result.json.tmp"
    if activity is None:
        activity = runner_activity(job_dir / "events.jsonl")
    value = {**result, **activity}
    if "repeat_guard" not in value:
        value["repeat_guard"] = job_repeat_guard(job_dir)
    try:
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        # A report can carry an unpaired surrogate escape (\ud83d); keep it escaped instead of losing the result.
        data = json.dumps(value).encode("ascii")
    tmp.write_bytes(data)
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
    optional = {"continuation", "dispatcher", "verification_of", "fallback_of", "routing", "must_verify"}
    if not isinstance(value, dict) or not fields <= set(value) or set(value) - fields - optional:
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
    if "must_verify" in value and (not isinstance(value["must_verify"], list) or any(
            type(index) is not int or not 1 <= index <= len(value["acceptance"]) for index in value["must_verify"])):
        raise ValueError("context.must_verify must be a list of 1-based acceptance indices")
    for field in ("verification_of", "fallback_of"):
        if field not in value:
            continue
        if not isinstance(value[field], str):
            raise ValueError(f"context.{field} must be a job identifier")
        try:
            job_identifier(value[field])
        except argparse.ArgumentTypeError as e:
            raise ValueError(f"context.{field}: {e}") from e
    # routing: how the plugin dispatched this job (fresh/resume, parent thread, verify_previous), for later analysis.
    if "routing" in value and (not isinstance(value["routing"], dict) or any(
            not isinstance(k, str) or not (v is None or isinstance(v, (str, int, bool)) or
                                           (isinstance(v, list) and all(isinstance(i, str) for i in v)))
            for k, v in value["routing"].items())):
        raise ValueError("context.routing must map names to strings, numbers, booleans or string lists")
    if "dispatcher" in value:
        dispatcher = value["dispatcher"]
        if (not isinstance(dispatcher, dict) or set(dispatcher) != {"version", "revision", "pid"} or
                type(dispatcher["pid"]) is not int or dispatcher["pid"] <= 0 or
                any(dispatcher[k] is not None and (not isinstance(dispatcher[k], str) or not dispatcher[k].strip())
                    for k in ("version", "revision"))):
            raise ValueError("context.dispatcher requires a positive pid and version/revision strings or null")
    if "continuation" in value:
        continuation = value["continuation"]
        required = {"parent_job_id", "answers", "resolution"}
        metadata = {"decided_by", "decision_basis", "decided_at", "resolves"}
        if not isinstance(continuation, dict) or set(continuation) not in (required, required | metadata):
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
        if "decided_by" in continuation:
            decided_at, resolves = continuation["decided_at"], continuation["resolves"]
            if (continuation["decided_by"] != "planner" or continuation["decision_basis"] != "standing_authorization" or
                    type(decided_at) not in (int, float) or not 0 < decided_at < float("inf") or
                    not isinstance(resolves, list) or not resolves or
                    any(not isinstance(blocker, str) or not blocker.strip() for blocker in resolves) or
                    len(set(resolves)) != len(resolves) or
                    (not continuation["resolution"].strip() and not set(resolves) <= ids)):
                raise ValueError("continuation has invalid planner decision metadata")
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
            # JSON can carry an unpaired surrogate that UTF-8 cannot: neither prompt.txt nor Codex's stdin takes it.
            prompt = re.sub("[\ud800-\udfff]", "\ufffd", envelope["prompt"])
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
    path = job_dir / ("write-lock.json" if job_dir.parent == HOME / "runs" else "args.json")
    if not path.exists():
        return {}
    task = json.loads(path.read_text("utf-8"))
    if not isinstance(task, dict):
        raise ValueError(f"{path.name} must be an object")
    if task.get("context") is not None:
        task_context(task["context"])
    return task


def job_repeat_guard(job_dir, *, blocking=True):
    # A damaged ledger must not prevent publishing another result, such as a cancellation or runner error.
    with suppress(OSError, ValueError, TypeError, KeyError):
        task = task_record(job_dir)
        if task.get("cwd"):
            return RepeatGuard(task["cwd"], task, job_dir).summary(blocking=blocking)
    return {"blocks": [], "standing": []}


def task_options(task):
    options = {"writable_roots": task.get("writable_roots"),
               "use_user_config": task.get("use_user_config", False), "effort": task.get("effort")}
    options.update({key: task[key] for key in ("model", "service_tier") if task.get(key) is not None})
    if task.get("engine") == "gemini":
        options.update(engine="gemini", model=task.get("model"))
        options.pop("service_tier", None)
        # agy keeps conversations under HOME, so a continuation must return to the same account directory.
        if task.get("agy_home"):
            options["agy_home"] = task["agy_home"]
    return options


def job_metadata(job_dir, task=None, finished_at=None, thread_id=None, *, conversation_id=None, resolve=None):
    resolve = resolve or os.path.realpath
    task = task_record(job_dir) if task is None else task
    meta = {"context": task.get("context"), "sandbox": task.get("sandbox"), "scope": task.get("scope")}
    meta["task_options"] = task_options(task)
    if task.get("cwd"):
        meta["cwd"] = resolve(local_path(task["cwd"]))
        if task.get("scope"):
            meta.update(scope=task["scope"], scope_paths=[scope_path(meta["cwd"], s, resolve=resolve) for s in task["scope"]])
    gemini = task.get("engine") == "gemini"
    id_field = "conversation_id" if gemini else "thread_id"
    provider_id = conversation_id if gemini else thread_id
    if not provider_id and (gemini or task.get("sandbox") not in (None, "read-only")):
        provider_id = started_thread(job_dir / "events.jsonl", id_field)
    meta[id_field] = provider_id or task.get("resume")
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


def validate_review(review, value, submitting=False):
    fields = {"status", "criteria", "notes", "accepted_deviations"}
    if (not isinstance(review, dict) or not fields <= set(review) or set(review) - fields - {"blockers", "report_rows"} or
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

    def valid_owner_only(entry):
        return "owner_only" not in entry or ("accepted" in entry and entry["owner_only"] in OWNER_ONLY_REASONS)

    def valid_historical_gap(entry):
        return "historical_gap" not in entry or (
            entry["historical_gap"] in ("missing_snapshot", "historical_redaction", "historical_runtime_record") and
            "accepted" in entry and "owner_only" not in entry and
            entry.get("index") not in (context or {}).get("must_verify", []))

    criteria = review["criteria"]
    if not isinstance(criteria, list):
        raise ValueError("review.criteria must be an array")
    indexes = []
    for criterion in criteria:
        # "accepted" (optional) records an open criterion that accepted_deviations accepts although it is not met.
        if (not isinstance(criterion, dict) or not {"index", "status", "evidence"} <= set(criterion) or
                set(criterion) - {"index", "status", "evidence", "accepted", "owner_only", "historical_gap"} or
                not valid_owner_only(criterion) or not valid_historical_gap(criterion) or
                type(criterion["index"]) is not int or
                not isinstance(criterion["status"], str) or criterion["status"] not in ("met", "not_met", "blocked") or
                not isinstance(criterion["evidence"], str) or not criterion["evidence"].strip() or
                ("accepted" in criterion and (criterion["status"] == "met" or
                                              (review["status"] != "accepted_deviations" and "historical_gap" not in criterion) or
                                              not isinstance(criterion["accepted"], str) or not criterion["accepted"].strip()))):
            raise ValueError("Review criteria require valid 1-based indexes, status and nonempty evidence; "
                             "accepted is only for a not_met/blocked criterion of an accepted_deviations review; owner_only requires valid reason and accepted")
        indexes.append(criterion["index"])
    # "report_rows" (optional): report rows flagged not_met/blocked that match no acceptance criterion
    # (the report has a different number of rows); same status, evidence and "accepted" rules as criteria.
    rows = review.get("report_rows", [])
    row_count = len(report["criteria"]) if valid_report(report) else 0
    if (not isinstance(rows, list) or any(
            not isinstance(r, dict) or not {"row", "status", "evidence"} <= set(r) or
            set(r) - {"row", "status", "evidence", "accepted", "owner_only", "historical_gap"} or
            not valid_owner_only(r) or not valid_historical_gap(r) or
            type(r["row"]) is not int or not 1 <= r["row"] <= row_count or
            not isinstance(r["status"], str) or r["status"] not in ("met", "not_met", "blocked") or
            not isinstance(r["evidence"], str) or not r["evidence"].strip() or
            ("accepted" in r and (r["status"] == "met" or (review["status"] != "accepted_deviations" and "historical_gap" not in r) or
                                  not isinstance(r["accepted"], str) or not r["accepted"].strip()))
            for r in rows) or len({r["row"] for r in rows}) != len(rows)):
        raise ValueError("report_rows entries require a unique report row number, status and nonempty evidence; "
                         "accepted is only for a not_met/blocked row of an accepted_deviations review; owner_only requires valid reason and accepted")
    if sorted(indexes) != list(range(1, len(acceptance) + 1)):
        counts = Counter(indexes)
        expected = set(range(1, len(acceptance) + 1))
        missing = sorted(expected - counts.keys())
        missing_criteria = {i: (acceptance[i - 1]["criterion"] if isinstance(acceptance[i - 1], dict)
                                else acceptance[i - 1])[:60] for i in missing}
        raise ValueError("Review must cover every acceptance criterion exactly once"
                         f"; acceptance_count={len(acceptance)}, out_of_range={sorted(counts.keys() - expected)}, "
                         f"duplicates={sorted(i for i, count in counts.items() if count > 1)}, "
                         f"missing={missing}, missing_criteria={missing_criteria}")
    reported = report.get("deviations", []) if isinstance(report, dict) else []
    if not isinstance(reported, list) or any(not isinstance(d, str) for d in reported):
        raise ValueError("Reported deviations cannot be indexed")
    outside = out_of_scope_paths(value)
    expected = {("reported", i + 1) for i in range(len(reported))} | {("scope", i + 1) for i in range(len(outside))}
    acknowledged = set()
    if not isinstance(review["accepted_deviations"], list):
        raise ValueError("accepted_deviations must be an array")
    submitted = {(d["kind"], d["index"]) for d in review["accepted_deviations"]
                 if isinstance(d, dict) and isinstance(d.get("kind"), str) and type(d.get("index")) is int}
    deviation_hint = (f"; allowed={sorted(expected)}, missing={sorted(expected - submitted)}, "
                      f"extra={sorted(submitted - expected)}")
    for deviation in review["accepted_deviations"]:
        if (not isinstance(deviation, dict) or set(deviation) != {"kind", "index", "evidence"} or
                not isinstance(deviation["kind"], str) or type(deviation["index"]) is not int or
                (deviation["kind"], deviation["index"]) not in expected or
                not isinstance(deviation["evidence"], str) or not deviation["evidence"].strip() or
                (deviation["kind"], deviation["index"]) in acknowledged):
            raise ValueError("Deviation acknowledgements require real unique indexes and nonempty evidence" + deviation_hint)
        acknowledged.add((deviation["kind"], deviation["index"]))
    if review["status"] != "needs_changes":
        if (any(c["status"] != "met" and "accepted" not in c for c in criteria + rows) or acknowledged != expected or review.get("blockers")):
            raise ValueError("Passing review requires all criteria met, all deviations acknowledged and no active blockers" + deviation_hint)
    # Only new submissions: older stored reviews may already hold this contradiction and must stay readable.
    elif submitting and all(c["status"] == "met" or c.get("historical_gap") for c in criteria + rows) and not review.get("blockers") and not expected:
        raise ValueError("所有验收项都 met 且无阻塞/偏差时不能记 needs_changes；"
                         "被审对象（正文、产品）的缺陷写进 notes 或结论，审计任务本身记 verified；"
                         "若确有执行缺口，把对应 criterion 标 not_met 或加 blocker 并给出证据。")
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
    validate_review(review, value, submitting=True)
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
                                                                         thread_id=value.get("thread_id"),
                                                                         conversation_id=value.get("conversation_id"))
    result = {**metadata, **diff_fields(job_dir), **value, "job_id": job_id}
    if finished is None and "repeat_guard" not in result:
        result["repeat_guard"] = job_repeat_guard(job_dir)
    # Same timestamps as the job listing: a review needs to know when this round finished.
    args_file = job_dir / "args.json"
    result.setdefault("started_at", args_file.stat().st_mtime if args_file.exists() else None)
    result.setdefault("finished_at", finished)
    for key in ("engine", "model", "service_tier"):
        if key in metadata["task_options"]:
            result["task_options"] = {**result["task_options"], key: metadata["task_options"][key]}
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


def recorded_process_exited(pid_file):
    pid = int(pid_file.read_text())
    if pid <= 0:
        return False
    try:
        actual = proc_start(pid)
    except FileNotFoundError:
        return True
    expected = pid_file.with_suffix(".start").read_text().strip()
    return actual.isdecimal() and expected.isdecimal() and int(actual) != int(expected)


def executor_loss(job_dir, started_at, lost_after):
    try:
        current = uuid.UUID(kernel_boot_id())
        try:
            previous = uuid.UUID((job_dir / "boot_id").read_text().partition(":")[0].strip())
        except FileNotFoundError:
            previous = current
        mtimes = []
        for name in ("events.jsonl", "phase.json"):
            with suppress(FileNotFoundError):
                mtimes.append((job_dir / name).stat().st_mtime)
        last_activity = max(mtimes) if mtimes else None
        if previous != current:
            return "boot_changed", started_at if last_activity is None else last_activity
        if last_activity is not None and time.time() - last_activity >= lost_after and all(
                recorded_process_exited(job_dir / name) for name in ("worker.pid", "codex.pid")):
            return "worker_exited", last_activity
    except (OSError, ValueError, IndexError):
        pass  # A failed read or malformed identity is not evidence that an executor exited.
    return None


def reconcile_lost_executor(job_dir, result_file, task, lost_after):
    try:
        started_at = (job_dir / "args.json").stat().st_mtime
    except FileNotFoundError:
        return
    if executor_loss(job_dir, started_at, lost_after) is None:
        return
    lock = acquire_file_lock(job_dir / "process.lock")  # Admission must not wait on cancel or late diff.
    if lock is None:
        return
    with lock:
        if result_file.exists():
            return
        loss = executor_loss(job_dir, started_at, lost_after)
        if loss is None:
            return
        reason, last_activity = loss
        finished_at = time.time()
        attempts = runner_activity(job_dir / "events.jsonl")["attempt"] or 0
        value = {**job_metadata(job_dir, task=task, finished_at=finished_at), "status": "failed",
                 "error_kind": "executor_lost", "lost_reason": reason, "retryable": False,
                 "log_dir": str(job_dir), "attempts": attempts, "started_at": started_at,
                 "finished_at": finished_at, "last_activity_at": last_activity,
                 "repeat_guard": job_repeat_guard(job_dir, blocking=False)}
        value.update(review_summary(value))
        activity = {"phase": "lost", "attempt": attempts, "last_error_kind": "executor_lost", "retry_at": None}
        write_result(job_dir, value, activity=activity)
        with suppress(OSError):  # The result is authoritative even if the terminal event cannot be logged.
            runner_event(job_dir, attempts, "lost", "executor_lost")


def job_status(job_id, record=None, *, lost_after=LOST_AFTER):
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
        if not result.exists():
            reconcile_lost_executor(job_dir, result, record["task"] if record is not None else None, lost_after)
        if result.exists():
            return enriched_status(job_id, job_dir, json.loads(result.read_text("utf-8")), record)
        if not pid_file.exists() and time.time() - job_dir.stat().st_ctime < WORKER_START_GRACE_SECONDS:
            return enriched_status(job_id, job_dir, {"status": "running", "seconds_since_last_event": None}, record)
        return enriched_status(job_id, job_dir, worker_died(job_id, job_dir, record["task"] if record else None), record)
    except (OSError, ValueError, TypeError) as e:
        value = {"job_id": job_id, "status": "failed", "error_kind": "invalid_record",
                 "error": str(e), "retryable": False}
        return {**value, **review_summary(value), "blocking": blocking_summary(value),
                "verification_status": "invalid", "verification": None}


def job_details(job, args):
    if "_details" not in job:
        job["_details"] = job_status(job["job_id"], job["_record"], lost_after=getattr(args, "lost_after", LOST_AFTER))
    return {**job, **job["_details"]}


def job_directories(job_ids=None):
    root = HOME / "jobs"
    for job_dir in root.iterdir() if root.exists() else []:
        if job_ids and job_dir.name not in job_ids:
            continue
        if not job_dir.is_dir():
            continue
        try:
            job_identifier(job_dir.name)
        except argparse.ArgumentTypeError:
            continue
        yield job_dir


def job_listing_times(job_dir, started_at=None):
    args_file, result_file = job_dir / "args.json", job_dir / "result.json"
    if started_at is None:
        started_at = args_file.stat().st_mtime if args_file.exists() else None
    return {"job_id": job_dir.name, "started_at": started_at,
            "finished_at": result_file.stat().st_mtime if result_file.exists() else None,
            "updated_at": max(p.stat().st_mtime for p in (job_dir, args_file, result_file, job_dir / "events.jsonl",
                                                        job_dir / "reviews.json") if p.exists())}


def job_listing_order(job):
    return (job["started_at"] or job["updated_at"], job["job_id"])


def matching_jobs(args, *, page_dates=None):
    scope_conflicts = getattr(args, "scope_conflicts", False)
    started_between = getattr(args, "started_between", None)
    needs_attention = args.needs_attention or scope_conflicts
    resolve = os.path.realpath
    # Reuse canonical paths only within this list query. Scope-conflict checks keep fresh resolution.
    if getattr(args, "command", None) == "list" and not scope_conflicts:
        resolve = cache(resolve)

    def matches_metadata(value, job_id):
        context = value.get("context")
        # --also-owner adds predecessor sessions handed over to --owner; it never applies without --owner.
        owners = {args.owner, *(getattr(args, "also_owner", None) or [])}
        if args.owner and not ((isinstance(context, dict) and context.get("owner") in owners) or
                               job_id in (args.job_id or [])):
            return False
        verification_of = getattr(args, "verification_of", None)
        if verification_of and (context or {}).get("verification_of") != verification_of:
            return False
        task_key = getattr(args, "task_key", None)
        if task_key and hashlib.sha256((context or {}).get("task", "").strip().encode("utf-8", "surrogatepass")).hexdigest() != task_key:
            return False
        return not args.cwd or bool(value.get("cwd") and
                                    tree_key(args.cwd, resolve=resolve) == tree_key(value["cwd"], resolve=resolve))

    jobs = []
    directories = job_directories(args.job_id if not args.owner else None) if page_dates is None else page_dates
    for job_dir in directories:
        args_file, result_file = job_dir / "args.json", job_dir / "result.json"
        started_at = None
        if started_between is not None:
            try:
                started_at = args_file.stat().st_mtime
            except FileNotFoundError:
                continue
            if not started_between[0] <= started_at <= started_between[1]:
                continue
        try:
            finished = result_file.exists()
            # Only terminal jobs publish result.json.
            if args.status == "running" and finished:
                continue
            task = task_record(job_dir)
            result = json.loads(result_file.read_text("utf-8")) if finished else None
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
                                                 thread_id=value.get("thread_id"),
                                                 conversation_id=value.get("conversation_id"), resolve=resolve)
                value = {**record["metadata"], **(record["result"] if record["result"] is not None else {})}
            except (OSError, ValueError, TypeError):
                record = None
                value = job_status(job_dir.name, lost_after=getattr(args, "lost_after", LOST_AFTER))
                value["_details"] = dict(value)
                if not matches_metadata(value, job_dir.name):
                    continue
        context = value.get("context") or {}
        parent = (context.get("fallback_of") or context.get("continuation", {}).get("parent_job_id") or
                  context.get("routing", {}).get("parent_job_id"))
        if getattr(args, "thread_id", None) and value.get("thread_id") != args.thread_id:
            continue
        if getattr(args, "parent_job", None) and parent != args.parent_job:
            continue
        value.update(job_id=job_dir.name, _record=record)
        if args.status or needs_attention:
            value = job_details(value, args)
        if args.status and value["execution_status"] != args.status:
            continue
        verification = value.get("verification_status", "unreviewed")
        attention = verification in ("needs_changes", "invalid") or (
            verification == "unreviewed" and value.get("review_status") == "needs_attention")
        if needs_attention and not attention:
            continue
        if scope_conflicts:
            blocking = value["blocking"]
            if blocking["next_action"] != "ask_user" or not any(b["kind"] == "task_conflict" for b in blocking["blockers"]):
                continue
        dates = job_listing_times(job_dir, started_at) if page_dates is None else page_dates[job_dir]
        jobs.append({**value, "parent_job_id": parent, **dates})
    jobs.sort(key=job_listing_order, reverse=True)
    return jobs


def list_jobs(args):
    requested = slice(args.offset, args.offset + args.limit)
    filters = ("cwd", "owner", "status", "job_id", "thread_id", "parent_job", "needs_attention",
               "scope_conflicts", "started_between", "verification_of", "task_key")
    if any(getattr(args, key, None) for key in filters):
        jobs = matching_jobs(args)
        total = len(jobs)
        page = jobs[requested]
    else:
        # Ordering and totals for an unfiltered page need timestamps only.
        dates = {p: job_listing_times(p) for p in job_directories()}
        ordered = sorted(dates, key=lambda p: job_listing_order(dates[p]), reverse=True)
        total = len(ordered)
        page = matching_jobs(args, page_dates={p: dates[p] for p in ordered[requested]})
    page = [job_details(j, args) for j in page]
    predispatch = None
    if args.owner and getattr(args, "thread_id", None) and args.offset == 0 and page:
        report = page[0].get("structured")
        acceptance = (page[0].get("context") or {}).get("acceptance")
        if (isinstance(acceptance, list) and valid_report(report) and
                any(blocker["kind"] == "environment" for blocker in report.get("blockers", []))):
            predispatch = {"acceptance": acceptance, "criteria": [
                {"criterion": row["criterion"], "status": row["status"]} for row in report["criteria"]]}
    fields = ("job_id", "cwd", "scope", "scope_paths", "thread_id", "parent_job_id", "sandbox", "task_options", "status", "error_kind", "duration_s",
              "started_at", "finished_at", "updated_at", "execution_status", "report_status", "review_status",
              "criteria_counts", "blocking", "verification_status", "verification", "phase", "attempt",
              "last_error_kind", "retry_at")
    page = [{**{k: j.get(k) for k in fields if k != "thread_id" or "conversation_id" not in j},
             "context": {"owner": j["context"].get("owner"),
                         **({"write": j["context"]["write"]} if "write" in j["context"] else {}),
                         "task": j["context"]["task"].strip().splitlines()[0][:160],
                         **({"dispatcher": j["context"]["dispatcher"]} if "dispatcher" in j["context"] else {}),
                         **{key: j["context"][key] for key in ("verification_of", "fallback_of") if key in j["context"]}}
             if j.get("context") else None,
             **({"final_message_repaired": j["final_message_repaired"]} if j.get("final_message_repaired") else {}),
             **({"last_activity": j.get("last_activity")} if j.get("status") == "running" else {}),
             **{k: j[k] for k in ("conversation_id", "fallback_safe", "diff_status", "diff_files", "rolled_back_at",
                                  "verification_version", "verification_scope") if k in j},
             **({"verification_error": j["verification_error"]} if "verification_error" in j else {})} for j in page]
    next_offset = args.offset + len(page)
    if predispatch is not None:
        page[0]["predispatch"] = predispatch
    return {"status": "completed", "jobs": page, "total": total, "offset": args.offset, "limit": args.limit,
            "next_offset": next_offset if next_offset < total else None, "eof": next_offset >= total}


def products(args):
    paths, truncated = {}, False
    resolve = cache(os.path.realpath)

    def add(cwd, path):
        nonlocal truncated
        if not isinstance(path, str) or not path.strip() or "\0" in path:
            raise ValueError("Product paths must be nonempty strings")
        if truncated:
            return
        absolute = scope_path(cwd, path, resolve=resolve)
        key = tree_key(absolute, resolve=resolve)
        # Directory grants would expose unrelated raw material beneath cwd or a write scope.
        if os.path.isdir(absolute) or key in (tree_key(cwd, resolve=resolve), tree_key(str(HOME), resolve=resolve)):
            return
        if key not in paths:
            if len(paths) < args.limit:
                paths[key] = absolute
            else:
                truncated = True

    for job_dir in job_directories():
        if job_dir.is_symlink() or not job_dir.resolve().is_relative_to((HOME / "jobs").resolve()):
            continue
        args_file, result_file = job_dir / "args.json", job_dir / "result.json"
        if not result_file.exists() or args_file.is_symlink():
            continue
        try:
            task = json.loads(args_file.read_text("utf-8"))
        except (OSError, ValueError):
            continue  # No trustworthy owner is available.
        context = task.get("context") if isinstance(task, dict) else None
        if not isinstance(context, dict) or context.get("owner") != args.owner:
            continue
        try:
            task_context(context)
            if result_file.is_symlink():
                raise ValueError("result.json must be a regular job file")
            result = json.loads(result_file.read_text("utf-8"))
            if not isinstance(result, dict):
                raise ValueError("result.json must be an object")
            if "context" in result and result["context"] != context:
                raise ValueError("result context does not match args.json")
            if result.get("status") in ("running", "unknown"):
                continue
            if result.get("status") not in ("completed", "failed", "cancelled"):
                raise ValueError("result.json has an invalid status")
            cwd = task.get("cwd")
            if not isinstance(cwd, str) or not os.path.isabs(local_path(cwd)):
                raise ValueError("Task cwd must be an absolute path")
            cwd = resolve(local_path(cwd))
            changes = result.get("files_changed", [])
            if not isinstance(changes, list):
                raise ValueError("files_changed must be an array")
            for change in changes:
                if not isinstance(change, dict):
                    raise ValueError("files_changed entries must contain a path")
                add(cwd, change.get("path"))
            for record in (task, result):
                writes = record.get("write_paths", [])
                if not isinstance(writes, list):
                    raise ValueError("write_paths must be an array")
                for path in writes:
                    add(cwd, path)
            for name in ("args.json", "prompt.txt", "result.json", "last_message.txt", "reviews.json", "stderr.log", "events.jsonl"):
                artifact = job_dir / name
                if artifact.is_file() and not artifact.is_symlink():
                    add(str(job_dir), name)
        except (OSError, ValueError, TypeError) as e:
            raise ValueError(f"Invalid product record for {job_dir.name}: {e}") from e
        if truncated:
            break
    return {"status": "completed", "owner": args.owner, "paths": list(paths.values()), "truncated": truncated}


def summary_usage(rounds):
    """Each thread's latest thread_total, summed: a group can span threads when a continuation started a fresh one."""
    threads = {}
    for job in rounds:
        threads.setdefault(job.get("thread_id") or job.get("job_id"), []).append(job)
    total = {}
    for part in threads.values():
        usage = part[-1].get("usage")
        if (len(part) > 1 and part[-1].get("usage_scope") != "thread_total") or not (
                isinstance(usage, dict) and usage and all(type(v) in (int, float) for v in usage.values())):
            return None
        for key, amount in usage.items():
            total[key] = total.get(key, 0) + amount
    return total or None


def summarize_jobs(args):
    groups = {}
    error_kinds = {}
    listed = []
    for job in matching_jobs(args):
        if job["_record"] is None or job["_record"]["result"] is None:
            job = job_details(job, args)
        if job.get("error_kind"):
            kind = job["error_kind"]
            error_kinds[kind] = error_kinds.get(kind, 0) + 1
        listed.append(job)
    # A continuation that started a fresh thread stays in its parent's unit of work.
    key_of = {}
    for job in reversed(listed):
        own = ("thread", job["thread_id"]) if job.get("thread_id") else ("job", job["job_id"])
        key_of[job["job_id"]] = key_of.get(job.get("parent_job_id"), own)
    for job in listed:
        groups.setdefault(key_of[job["job_id"]], []).append(job)
    result = []
    page = list(groups.items())[args.offset:args.offset + args.limit]
    for (kind, identifier), jobs in page:
        jobs = [job_details(j, args) for j in jobs]
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
        open_items = {"criteria": [c for c in criteria if c["status"] != "met" and not c.get("historical_gap")],
                      "unresolved": report.get("unresolved", []), "deviations": report.get("deviations", []),
                      "out_of_scope": out_of_scope_paths(latest),
                      "blockers": latest["blocking"]["blockers"]}
        if closed:
            open_items = {k: [] for k in open_items}
        # Criteria a closing review accepted although they are not met stay visible after close-out.
        accepted_open = ([{"index": c["index"], "status": c["status"]} for c in (verification or {}).get("criteria", []) if c.get("accepted")] +
                         [{"row": r["row"], "status": r["status"]} for r in (verification or {}).get("report_rows", []) if r.get("accepted")])
        result.append({"group_id": kind + ":" + identifier, "thread_id": latest.get("thread_id"),
                       "job_ids": [j["job_id"] for j in rounds], "total_rounds": len(rounds),
                       "rounds": [{k: j.get(k) for k in ("job_id", "parent_job_id", "status", "execution_status",
                                   "verification_status", "started_at", "finished_at", "duration_s", "usage", "usage_scope")}
                                  for j in jobs[:args.round_limit]],
                       "rounds_truncated": len(rounds) > args.round_limit,
                       "latest_job_id": latest["job_id"],
                       "latest_job": {k: latest.get(k) for k in ("job_id", "thread_id", "parent_job_id", "status",
                                      "execution_status", "review_status", "report_status", "blocking", "context")},
                       "repeat_guard": latest.get("repeat_guard", {"blocks": [], "standing": []}),
                       "summary": report.get("summary"), "verification_status": latest.get("verification_status"),
                       "verification": verification, "open_items": open_items, "accepted_open": accepted_open, "files_changed": files,
                       "finished_duration_s": round(sum(durations), 1) if all(type(d) in (int, float) for d in durations) else None,
                       "usage": summary_usage(rounds), "usage_scope": "thread_total" if kind == "thread" else "job"})
    usage_total, usage_unknown = {}, 0
    for jobs in groups.values():  # every matching group, whatever page is shown
        usage = summary_usage(list(reversed(jobs)))
        usage_unknown += usage is None
        for key, amount in (usage or {}).items():
            usage_total[key] = usage_total.get(key, 0) + amount
    next_offset = args.offset + len(result)
    return {"status": "completed", "groups": result, "total": len(groups),
            "usage_total": usage_total, "usage_unknown_groups": usage_unknown,
            "total_jobs": sum(map(len, groups.values())), "error_kinds": error_kinds, "offset": args.offset, "limit": args.limit,
            "next_offset": next_offset if next_offset < len(groups) else None}


def job_output(args):
    job_dir = job_directory(args.job_id)
    if not job_dir.exists():
        value = {"job_id": args.job_id, "status": "failed", "error_kind": "unknown_job", "retryable": False}
        return {**value, **review_summary(value)}
    source = job_dir / {"report": "last_message.txt", "result": "result.json", "context": "args.json",
                        "review": "reviews.json", "stderr": "stderr.log", "events": "events.jsonl",
                        "diff": "diff.patch"}[args.artifact]
    if args.artifact == "diff":
        late_diff(job_dir)
    value = job_status(args.job_id)
    base = {"job_id": args.job_id, "artifact": args.artifact, "execution_status": value.get("execution_status", value["status"]),
            "source_path": str(source), "offset": args.offset, "limit": args.limit}
    if args.artifact == "diff":
        base["diff_status"] = value.get("diff_status")  # too_large: the text is the --stat list, not a patch
    if not source.resolve().is_relative_to(job_dir.resolve()):
        return {**base, "status": "failed", "error_kind": "invalid_artifact", "retryable": False}
    if args.artifact in ("report", "result", "diff") and value["status"] == "running":
        return {**base, "status": "pending", "error_kind": "artifact_pending", "retryable": True}
    if not source.exists():
        if args.artifact == "diff":
            reason = {"empty": "the task left no changes under its directory",
                      "not_git": "the task directory is not inside a git work tree",
                      "skipped": value.get("diff_reason")}.get(value.get("diff_status")) or \
                "none was recorded (a read-only task, or a job from before diffs were recorded)"
            return {**base, "status": "failed", "error_kind": "artifact_missing", "retryable": False,
                    "error": "No patch for this job: " + reason}
        return {**base, "status": "failed", "error_kind": "legacy_context_missing" if args.artifact == "context" else "artifact_missing", "retryable": False}
    try:
        if args.artifact == "context":
            context = task_record(job_dir).get("context")
            if context is None:
                return {**base, "status": "failed", "error_kind": "legacy_context_missing", "retryable": False}
            content = json.dumps(context, ensure_ascii=False)
            total_chars = len(content)
            has_content = bool(content.strip())
            text = content[args.offset:args.offset + args.limit]
        else:
            total_chars = 0
            has_content = False
            text = ""
            # A patch quotes the files' own bytes, which need not be UTF-8.
            with open(source, "r", encoding="utf-8", newline="", **({"errors": "replace"} if args.artifact == "diff" else {})) as f:
                while chunk := f.read(65536):
                    start = max(0, args.offset - total_chars)
                    stop = min(len(chunk), args.offset + args.limit - total_chars)
                    if start < stop:
                        text += chunk[start:stop]
                    total_chars += len(chunk)
                    has_content = has_content or bool(chunk.strip())
    except (OSError, ValueError):
        return {**base, "status": "failed", "error_kind": "artifact_read_failed", "retryable": False}
    if not has_content:
        return {**base, "status": "failed", "error_kind": "artifact_empty", "retryable": False}
    if args.offset >= total_chars:
        return {**base, "status": "failed", "error_kind": "offset_out_of_range", "retryable": False,
                "total_chars": total_chars, "next_offset": None, "eof": True}
    end = args.offset + len(text)
    return {**base, "status": "completed", "text": text, "total_chars": total_chars,
            "next_offset": end if end < total_chars else None, "eof": end >= total_chars}


def rollback_job(args):
    """Reverse a finished writer's diff.patch in the working tree; the user's index and commits are not touched."""
    fail = lambda kind, error, **extra: {"status": "failed", "job_id": args.job_id, "error_kind": kind, "error": error,
                                          "retryable": kind == "lock_busy", "rolled_back": False, **extra}
    job_dir = job_directory(args.job_id)
    if job_dir.exists():
        late_diff(job_dir)
    value = job_status(args.job_id)
    if value.get("error_kind") in ("unknown_job", "invalid_record"):
        return fail(value["error_kind"], value.get("error") or "No such job.")
    if value["status"] == "running" or value.get("residual_codex_pid"):
        return fail("still_running", "The job or its Codex process is still running; wait for it or cancel it first.")
    if value.get("rolled_back_at"):
        return fail("already_rolled_back", "This job was already rolled back.", rolled_back_at=value["rolled_back_at"])
    patch = job_dir / "diff.patch"
    if value.get("diff_status") != "captured" or not patch.is_file() or patch.is_symlink():
        return fail("no_diff", f"No patch to roll back: diff_status is {value.get('diff_status')!r}.",
                    diff_status=value.get("diff_status"))
    roots = write_lock_roots(value["cwd"], value.get("sandbox"), value["task_options"].get("writable_roots"))
    apply = lambda *options, seconds: git(value["diff_repo"], "apply", "-R", "--binary", "--whitespace=nowarn", *options,
                                         str(patch), deadline=time.monotonic() + seconds)
    reason = lambda error: "git apply timed out" if isinstance(error, subprocess.TimeoutExpired) else \
        "\n".join(str(error).splitlines()[:10])
    (HOME / "locks").mkdir(parents=True, exist_ok=True)
    locks = []
    try:
        # Admission stays held, so no writer on this or an overlapping directory starts while files are restored.
        with acquire_file_lock(HOME / "locks" / "admission.lock", blocking=True):
            busy = earlier_writer_waiting(job_dir, roots)
            for key in sorted(roots) if not busy else []:
                lock = acquire_write_lock(roots[key])
                if lock is None:
                    busy = True
                    break
                locks.append(lock)
            if busy:
                return fail("lock_busy", "Another writer holds or waits for this directory; try again once it has finished.")
            try:
                apply("--check", seconds=60)
            except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                return fail("rollback_conflict", reason(error))
            if not args.check:
                try:
                    apply(seconds=300)
                except (subprocess.TimeoutExpired, OSError, ValueError) as error:
                    return fail("rollback_failed", reason(error))
                tmp = job_dir / "rollback.json.tmp"
                tmp.write_text(json.dumps({"rolled_back_at": time.time()}), "utf-8")
                os.replace(tmp, job_dir / "rollback.json")
    finally:
        for lock in locks:
            lock.close()
    return {"status": "completed", "job_id": args.job_id, "rolled_back": not args.check, "checked": True,
            "files": value.get("diff_files")}


def worker_died(job_id, job_dir, task=None):
    """The worker exited without a result (WSL restart, crash). A writer can still be resumed from its thread;
    a read-only run is --ephemeral, so only a writer thread it resumed can be."""
    if task is None:
        try:
            task = json.loads((job_dir / "args.json").read_text("utf-8"))
        except (OSError, ValueError):
            task = {}
    gemini = task.get("engine") == "gemini"
    id_field = "conversation_id" if gemini else "thread_id"
    provider_id = task.get("resume")
    if gemini or task.get("sandbox") != "read-only":
        provider_id = started_thread(job_dir / "events.jsonl", id_field) or provider_id
    result = {"job_id": job_id, "status": "failed", "error_kind": "worker_died", "retryable": True,
              "error": "The runner worker exited without writing a result (WSL restart or crash).",
              "sandbox": task.get("sandbox"), id_field: provider_id, "log_dir": str(job_dir)}
    pid = recorded_pid(job_dir / "codex.pid")
    if pid is not None:
        result.update({"residual_provider_pid" if gemini else "residual_codex_pid": pid}, retryable=False)
        result["error"] += f" {'Gemini' if gemini else 'Codex'} PID {pid} is still present. Do not retry until the residual process is stopped."
    return result


def started_thread(events, id_field="thread_id"):
    try:
        with open(events, "rb") as f:
            for raw in f:
                try:
                    ev = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(ev, dict) and ev.get("type") == "thread.started" and ev.get(id_field):
                    return ev[id_field]
    except OSError:
        pass
    return None


def gemini_admission(args):
    context = getattr(args, "context", None) or {}
    parent = context.get("fallback_of")
    owner = context.get("owner")
    if parent:
        try:
            source_dir = job_directory(parent)
            source = task_record(source_dir)
            result = json.loads((source_dir / "result.json").read_text("utf-8"))
            authorized = (source.get("engine", "codex") == "codex" and owner and
                          (source.get("context") or {}).get("owner") == owner and
                          result.get("status") == "failed" and result.get("fallback_safe") is True)
        except (OSError, ValueError, AttributeError):
            authorized = False
        if not authorized:
            return {"status": "failed", "error_kind": "invalid_fallback", "retryable": False,
                    "error": "fallback_of must identify a fallback-safe failed Codex job owned by this task's owner."}

    limit = args.max_engine_running
    if not (parent or limit):
        return None
    running = 0
    for job_dir in job_directories():
        try:
            task = task_record(job_dir)
            if task.get("engine") != "gemini":
                continue
            prior = task.get("context") or {}
            if parent and prior.get("fallback_of") == parent and prior.get("owner") == owner:
                child = job_status(job_dir.name)
                if child.get("error_kind") != "worker_start_failed":
                    return {"job_id": job_dir.name, "status": child["status"], "deduplicated": True}
            if limit:
                worker_pid = job_dir / "worker.pid"
                worker_active = not (job_dir / "result.json").exists() and (
                    (not worker_pid.exists() and time.time() - job_dir.stat().st_ctime < LOST_AFTER)
                    or recorded_pid(worker_pid) is not None)
                if worker_active or recorded_pid(job_dir / "codex.pid") is not None:
                    running += 1
        except (OSError, ValueError):
            continue
    if limit and running >= limit:
        return {"status": "failed", "error_kind": "engine_limit", "retryable": True,
                "error": f"Gemini already has {running} active jobs (limit {limit})."}
    return None


def start_job(args, prompt):
    job_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    if args.engine == "codex" and args.model_ab is not None:
        args.model = select_ab_model(job_id, *args.model_ab)
        args.context["routing"] = {**args.context.get("routing", {}), "ab": True, "model": args.model}
    job_dir = HOME / "jobs" / job_id
    job_dir.mkdir(parents=True)
    (job_dir / "prompt.txt").write_text(prompt, "utf-8")
    task = {k: v for k, v in vars(args).items() if k not in ("command", "model_ab")}
    (job_dir / "args.json").write_text(json.dumps(task), "utf-8")
    # Written before worker.pid, so a status that sees the pid also sees which boot it belongs to.
    boot = boot_id()
    if boot:
        (job_dir / "boot_id").write_text(boot)
    # Windows cannot replace a PID file while another publisher is replacing it.
    with acquire_file_lock(job_dir / "process.lock", blocking=True):
        try:
            worker = subprocess.Popen([sys.executable, os.path.abspath(__file__), "_worker", job_id],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      creationflags=(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP) if IS_WIN else 0,
                                      start_new_session=not IS_WIN, close_fds=True)
        except OSError as error:
            if args.engine != "gemini":
                raise
            failure = {**job_metadata(job_dir, task=task), "status": "failed", "error_kind": "worker_start_failed",
                       "error": f"Could not start Gemini worker: {error}", "retryable": True, "attempts": 0}
            write_result(job_dir, failure)
            return {"job_id": job_id, **failure}
        record_pid(job_dir / "worker.pid", worker.pid)
    return {"job_id": job_id, "status": "running"}


PRUNE_TTL = 30 * 86400


def keep_fallback_child(job_dir, result=None):
    with suppress(OSError, ValueError):
        task = task_record(job_dir)
        parent = (task.get("context") or {}).get("fallback_of")
        if task.get("engine") != "gemini" or not parent or parent == job_dir.name or not job_directory(parent).is_dir():
            return False
        if result is None:
            record = job_dir / "result.json"
            if not record.is_file():
                return True
            result = json.loads(record.read_text("utf-8"))
        return isinstance(result, dict) and result.get("error_kind") != "worker_start_failed"
    return False


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
            if any(recorded_pid(d / name) is not None for name in ("worker.pid", "codex.pid")):
                continue
            if result.is_file():
                expired = result.stat().st_mtime < cutoff
            else:
                expired = max(p.stat().st_mtime for p in [d, *d.rglob("*")]) < cutoff
            if expired and not (subdir == "jobs" and keep_fallback_child(d)):
                shutil.rmtree(d, ignore_errors=True)
        except (OSError, ValueError):
            pass


def prune_diff_index():
    for cached in (HOME / "diff-index").glob("*"):
        with suppress(OSError):
            # Every writer replaces the index inside, which is what moves the directory's mtime.
            if cached.stat().st_mtime < time.time() - PRUNE_TTL:
                remove_tree(cached)


def storage_size(root):
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def prune_storage(max_storage_mb, keep=()):
    """keep: job ids the task being started still refers to (its verification target and continuation parent)."""
    total, finished = 0, []
    for root in (HOME / "jobs", HOME / "runs"):
        try:
            total += storage_size(root)
            directories = list(root.iterdir())
        except OSError:
            continue
        for d in directories:
            try:
                result = d / "result.json"
                if not d.is_dir() or d.is_symlink() or not result.is_file() or (root.name == "jobs" and d.name in keep):
                    continue
                value = json.loads(result.read_text("utf-8"))
                if not isinstance(value, dict) or value.get("status") not in ("completed", "failed", "cancelled"):
                    continue
                if root.name == "jobs" and keep_fallback_child(d, value):
                    continue
                if any(recorded_pid(d / name) is not None for name in ("worker.pid", "codex.pid")):
                    continue
                finished.append((result.stat().st_mtime, d))
            except (OSError, ValueError):
                continue
    for _, d in sorted(finished, key=lambda item: item[0]):
        if total <= max_storage_mb * 1024 ** 2:
            break
        try:
            size = storage_size(d)
            shutil.rmtree(d, ignore_errors=True)
            total -= size - storage_size(d)
        except OSError:
            pass


def doctor():
    """Read-only environment checks: starts no task, calls no model and writes nothing."""
    checks = []

    def check(name, probe):
        try:
            ok, detail = probe()
        except Exception as e:
            ok, detail = False, repr(e)[:300]
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    def first_line(argv):
        p = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace",
                           timeout=10, creationflags=NO_WINDOW)
        return p.returncode == 0, ((p.stdout or p.stderr).strip().splitlines() or [f"exit {p.returncode}"])[0][:200]

    def codex_path():
        prefix = launcher()[0]
        path = shutil.which(prefix[0]) if os.environ.get("CODEX_RUNNER_CMD") else find_codex()
        return bool(path), path or f"{prefix[0]} not found"

    def runner_home():
        existing = next(p for p in (HOME, *HOME.parents) if p.exists())
        return os.access(existing, os.W_OK | os.X_OK), str(HOME) if existing == HOME else f"{HOME} (not created yet)"

    def router():
        target = os.environ.get("CODEX_RUNNER_ROUTER_URL") or os.environ.get("CODEX_RUNNER_ROUTE_URL")
        if not target:
            return True, "not configured"
        url = urlparse(target)  # Only host and port: a route URL may embed credentials.
        reachable = router_reachable()
        port = url.port or (80 if url.scheme == "http" else 443)
        return reachable, f"{url.hostname}:{port} {'reachable' if reachable else 'unreachable'}"

    def codex_auth():  # Existence only: the file is never opened.
        present = (codex_home / "auth.json").is_file()
        return present, "auth.json exists" if present else "auth.json missing (expected with an API key or a custom provider)"

    codex_home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    check("python", lambda: (sys.version_info >= (3, 11), sys.version.split()[0]))
    check("codex", codex_path)
    check("codex_version", lambda: first_line([*launcher()[0], "--version"]))
    check("codex_home", lambda: (codex_home.is_dir(), str(codex_home)))
    check("codex_auth", codex_auth)
    check("runner_home", runner_home)
    check("router", router)
    check("bash", lambda: first_line(["bash", "--version"]))
    # codex_auth is advisory: API-key and custom-provider setups have no auth.json.
    return {"status": "completed", "ok": all(c["ok"] for c in checks if c["name"] != "codex_auth"), "checks": checks}


def main():
    parser = Parser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True, parser_class=Parser)
    sub.add_parser("doctor")
    run = sub.add_parser("run")
    add_task_arguments(run)
    start = sub.add_parser("start")
    add_task_arguments(start)
    start.add_argument("--model-ab", type=parse_model_ab, help="Assign a fresh job by job ID using [models, share]")
    start.add_argument("--max-engine-running", type=positive_int, help="Limit active Gemini jobs under the runner home")
    status = sub.add_parser("status")
    status.add_argument("job_id", type=job_identifier)
    status.add_argument("--wait", type=float, default=0)
    status.add_argument("--follow", action="store_true")
    sub.add_parser("cancel").add_argument("job_id", type=job_identifier)
    sub.add_parser("_worker").add_argument("job_id", type=job_identifier)
    sub.add_parser("forget-too-big").add_argument("--cwd", required=True)
    sub.add_parser("thread-size").add_argument("thread_id")
    sub.add_parser("verification-version").add_argument("job_id", type=job_identifier)
    repeat_guard = sub.add_parser("repeat-guard")
    repeat_guard.add_argument("--cwd", default=os.getcwd())
    repeat_guard.add_argument("--repeat-failures", type=positive_int, default=REPEAT_FAILURES)
    repeat_guard.add_argument("--repeat-window-hours", type=positive_float, default=REPEAT_WINDOW_HOURS)
    listing = sub.add_parser("list")
    summary = sub.add_parser("summary")
    for command in (run, start, status, listing, summary):
        command.add_argument("--lost-after", type=float, default=LOST_AFTER, metavar="SECONDS",
                             help="Minimum inactivity before finalizing a job whose recorded processes both exited")
    for command in (listing, summary):
        command.add_argument("--cwd")
        command.add_argument("--owner")
        command.add_argument("--also-owner", action="append")
        command.add_argument("--status", choices=["running", "completed", "failed", "cancelled", "unknown"])
        command.add_argument("--needs-attention", action="store_true")
        command.add_argument("--job-id", action="append", type=job_identifier)
        command.add_argument("--thread-id")
        command.add_argument("--parent-job", type=job_identifier)
        command.add_argument("--offset", type=int, default=0)
    listing.add_argument("--limit", type=int, default=20)
    listing.add_argument("--scope-conflicts", action="store_true")
    listing.add_argument("--verification-of", type=job_identifier)
    listing.add_argument("--task-key")
    listing.add_argument("--started-between", nargs=2, type=float, metavar=("START", "END"))
    summary.add_argument("--limit", type=int, default=10)
    summary.add_argument("--round-limit", type=int, default=20)
    product_query = sub.add_parser("products")
    product_query.add_argument("--owner", required=True)
    product_query.add_argument("--limit", type=int, default=10000)
    review = sub.add_parser("review")
    review.add_argument("job_id", type=job_identifier)
    review.add_argument("--reviewer", required=True)
    output = sub.add_parser("output")
    output.add_argument("job_id", type=job_identifier)
    output.add_argument("--artifact", choices=["report", "result", "context", "review", "stderr", "events", "diff"],
                        default="report")
    output.add_argument("--limit", type=int, default=4000)
    output.add_argument("--offset", type=int, default=0)
    rollback = sub.add_parser("rollback")
    rollback.add_argument("job_id", type=job_identifier)
    rollback.add_argument("--check", action="store_true", help="Only test whether the patch still reverses cleanly")
    args = parser.parse_args()
    if hasattr(args, "lost_after") and not (isfinite(args.lost_after) and args.lost_after >= 0):
        parser.error("--lost-after requires nonnegative finite seconds")
    if args.command == "doctor":
        emit(doctor())
        return
    if tomllib is None:
        parser.error("Python 3.11 or newer is required")
    if args.command == "products":
        if not args.owner.strip() or not 1 <= args.limit <= 10000:
            parser.error("owner must be nonempty and limit between 1 and 10000")
        try:
            emit(products(args))
        except (OSError, ValueError) as e:
            emit({"status": "failed", "owner": args.owner, "error_kind": "invalid_record", "error": str(e), "retryable": False})
        return
    if args.command == "list" and args.started_between is not None:
        start, end = args.started_between
        if not (isfinite(start) and isfinite(end) and start <= end):
            parser.error("--started-between requires finite epoch seconds in order")
    if args.command == "thread-size":
        if not re.fullmatch(r"[0-9A-Za-z-]{8,80}", args.thread_id):
            emit({"status": "failed", "error_kind": "bad_arguments", "error": "thread_id is invalid", "retryable": False})
        else:
            emit({"status": "completed", "thread_id": args.thread_id, "last_input_tokens": thread_last_input_tokens(args.thread_id)})
        return
    if args.command == "verification-version":
        emit({"status": "completed", "verification_version": verification_version(job_status(args.job_id))})
        return
    if args.command == "repeat-guard":
        try:
            totals, standing, changed_at = RepeatGuard(args.cwd, vars(args)).snapshot()
            emit({"status": "completed", "totals": totals, "standing": standing, "_changed_at": changed_at})
        except (OSError, ValueError, TypeError, KeyError) as e:
            emit({"status": "failed", "error_kind": "invalid_record", "error": str(e), "retryable": False})
        return
    if args.command == "forget-too-big":
        try:
            emit({"status": "completed", "removed": forget_too_big(args.cwd)})
        except (OSError, ValueError) as e:
            emit({"status": "failed", "error_kind": "invalid_record", "error": str(e), "retryable": False})
        return
    if args.command == "review":
        try:
            decision = json.loads(read_prompt(strict=True))
            emit(review_job(args, decision))
        except (OSError, ValueError, argparse.ArgumentTypeError) as e:
            parser.error("Invalid review: " + str(e))
        return
    if args.command == "rollback":
        try:
            emit(rollback_job(args))
        except (OSError, ValueError, KeyError) as e:
            emit({"status": "failed", "job_id": args.job_id, "error_kind": "invalid_record", "error": str(e),
                  "retryable": False, "rolled_back": False})
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
        args.cwd = os.path.realpath(local_path(args.cwd))
        prompt = read_task_input(args, parser)
        context = getattr(args, "context", None) or {}
        fallback_of = context.get("fallback_of")
        if fallback_of and (args.command != "start" or args.engine != "gemini" or args.resume or
                            (context.get("continuation") or {}).get("parent_job_id", fallback_of) != fallback_of):
            parser.error("fallback_of requires a fresh Gemini start linked to the same parent")
        if args.engine == "gemini":
            if not args.agy_command:
                parser.error("--engine gemini requires --agy-command")
            if args.gemini_fallback_check:
                parser.error("--gemini-fallback-check is for Codex")
        elif args.agy_command or args.agy_proxy or args.agy_home or getattr(args, "max_engine_running", None):
            parser.error("--agy-command, --agy-proxy, --agy-home and --max-engine-running require --engine gemini")
        if args.engine == "codex" and getattr(args, "model_ab", None) is not None:
            if not context or args.model is not None or args.resume or context.get("continuation") or context.get("verification_of"):
                parser.error("--model-ab requires a new contextual task without a model override")
        if args.command == "start" or args.max_storage_mb is not None:
            prune_old("jobs")
            prune_old("runs")
            prune_diff_index()
        keep = {fallback_of, context.get("verification_of"), (context.get("continuation") or {}).get("parent_job_id")}
        if args.max_storage_mb is not None and (args.command != "start" or args.engine != "gemini"):
            prune_storage(args.max_storage_mb, keep)

    if args.command == "run":
        run_dir = HOME / "runs" / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        run_dir.mkdir(parents=True)
        if writer(args.sandbox, getattr(args, "context", None)):
            task = {k: getattr(args, k) for k in ("cwd", "sandbox", "writable_roots")}
            if args.scope:
                task["scope"] = args.scope
            (run_dir / "write-lock.json").write_text(json.dumps(task), "utf-8")
        boot = boot_id()
        if boot:
            (run_dir / "boot_id").write_text(boot)
        record_pid(run_dir / "worker.pid", os.getpid())
        result = execute(args, prompt, run_dir)
        result.update(review_summary(result))
        write_result(run_dir, result)
        emit(result)
        sys.exit(0 if result["status"] == "completed" else 1)

    if args.command == "start":
        if args.engine == "gemini":
            locks = HOME / "locks"
            locks.mkdir(parents=True, exist_ok=True)
            with acquire_file_lock(locks / "gemini-start.lock", blocking=True):
                result = gemini_admission(args)
                if result is None:
                    if args.max_storage_mb is not None:
                        prune_storage(args.max_storage_mb, keep)
                    result = start_job(args, prompt)
        else:
            result = start_job(args, prompt)
        emit(result)
        return

    if args.command == "_worker":
        job_dir = HOME / "jobs" / args.job_id
        with acquire_file_lock(job_dir / "process.lock", blocking=True):
            if recorded_pid(job_dir / "worker.pid") != os.getpid():
                record_pid(job_dir / "worker.pid", os.getpid())
        task = argparse.Namespace(**json.loads((job_dir / "args.json").read_text("utf-8")))
        try:
            result = execute(task, (job_dir / "prompt.txt").read_text("utf-8"), job_dir)
        except Exception as e:
            result = {"status": "failed", "error_kind": "runner_error", "error": repr(e), "retryable": False}
        try:
            result = {**job_metadata(job_dir, thread_id=result.get("thread_id"),
                                     conversation_id=result.get("conversation_id")), **result}
            result.update(review_summary(result))
            write_result(job_dir, result)
        except Exception as e:
            # Codex may have finished and changed files: a missing result would read as a dead worker to retry.
            write_result(job_dir, {
                "status": "failed", "error_kind": "runner_error", "retryable": False, "log_dir": str(job_dir),
                "error": f"Saving the result failed after execution ended as {result.get('status')!r}: {repr(e)[:500]}",
                **{key: result[key] for key in ("thread_id", "conversation_id") if result.get(key)}})
        return

    if args.command == "status":
        interval = max(1, args.wait) if args.follow else args.wait
        deadline = time.monotonic() + interval
        while True:
            with suppress(OSError, ValueError):
                late_diff(job_directory(args.job_id))
            current = job_status(args.job_id, lost_after=args.lost_after)
            now = time.monotonic()
            if current["status"] != "running" or now >= deadline:
                emit(current)
                if not args.follow or current["status"] != "running":
                    return
                deadline = now + interval
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
            task = {}
            with suppress(OSError, ValueError):
                task = task_record(job_dir)
            if task.get("engine") == "gemini" and windows_agy(task.get("agy_command")):
                phase = runner_activity(job_dir / "events.jsonl")["phase"]
                if phase not in (None, "lock_wait") or (job_dir / "codex.pid").exists():
                    if not confirm_agy_stopped(job_dir):
                        emit({"job_id": args.job_id, "status": "monitor_failed", "error_kind": "cancel_unconfirmed",
                              "error": "The Windows Gemini process tree has not confirmed termination.", "retryable": True})
                        return
            # With a diff to finish, hold admission: the killed worker frees its write locks, and a queued writer
            # must not change the tree before the final tree is recorded.
            (HOME / "locks").mkdir(parents=True, exist_ok=True)
            admission = acquire_file_lock(HOME / "locks" / "admission.lock", blocking=True) \
                if (job_dir / "diff-base.json").exists() else None
            try:
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
                    with suppress(OSError):
                        result.update(diff_end(job_dir))
                    result.update(review_summary(result))
                    write_result(job_dir, result)
            finally:
                if admission is not None:
                    admission.close()
        emit(job_status(args.job_id))


if __name__ == "__main__":
    main()
