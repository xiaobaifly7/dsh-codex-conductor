"""Launch a single Antigravity turn and adapt its stream to runner events."""

import base64
import json
import ntpath
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import uuid


WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[\\/]")
WSL_DRIVE = re.compile(r"^/mnt/([a-zA-Z])(?:/(.*))?$")
POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
JOB_RECORD = "agy.windows-job"
CANCEL_RECORD = "agy.windows-cancel"
EXPLICIT_TOOL_DENIAL = re.compile(
    r"\b(?:soft[-_ ]den(?:y|ied|ial)|(?:tool call|command) (?:was )?denied|permissions\.allow"
    r"|not pre-?approved|without pre-?approval"
    r"|approval (?:is )?required\b[^\n]*(?:headless|non.interactive))\b", re.IGNORECASE
)
DENIAL = re.compile(
    r"\b(?:permission[-_ ]denied|(?:denied|blocked) (?:by|due to) permissions?"
    r"|(?:permission|approval) (?:is )?required|requires (?:\w+ )?(?:approval|permission)"
    r"|not approved|without approval|permission (?:request )?was denied"
    r"|(?:approval|permission) [^\n]*(?:headless|non.interactive))\b", re.IGNORECASE
)
INVALID_FLAG = re.compile(r"flag provided but not defined|unknown (?:flag|option)|invalid value .+ for flag", re.IGNORECASE)
HTTP_FORBIDDEN = re.compile(r"\b403\b")
HTTP_STATUS = re.compile(r"(?:^|HTTP\s+|status code\s+)([1-5][0-9]{2})(?=[:\s]|$)", re.I)
MAX_RETRYABLE_DELAY_SECONDS = 300
QUOTA_STATUS_CODES = (429, 499, 503)
GOOGLE_RPC = "type.googleapis.com/google.rpc."
CLOUD_CODE_DOMAINS = {
    "cloudcode-pa.googleapis.com",
    "staging-cloudcode-pa.googleapis.com",
    "autopush-cloudcode-pa.googleapis.com",
}
CAPACITY_EXHAUSTION = re.compile(r"exhausted your capacity|capacity exceeded|MODEL_CAPACITY_EXHAUSTED", re.I)
TERMINAL_QUOTA_REASONS = ("MODEL_CAPACITY_EXHAUSTED", "MODEL_CAPACITY_EXCEEDED", "INSUFFICIENT_G1_CREDITS_BALANCE")


def _reject_unc(path):
    if path.startswith(("//", "\\\\")):
        raise ValueError(f"agy does not support UNC or Windows device paths: {path}")


def _windows_path(path):
    path = os.fspath(path)
    _reject_unc(path)
    if WINDOWS_DRIVE.match(path):
        return ntpath.normpath(path)
    match = WSL_DRIVE.fullmatch(os.path.realpath(path)) if os.path.isabs(path) else None
    if match:
        return ntpath.normpath(f"{match[1].upper()}:\\{match[2] or ''}")
    raise ValueError(f"agy requires a local Windows drive path: {path}")


def _path_from_cwd(path, cwd, windows):
    path = os.fspath(path)
    _reject_unc(path)
    if windows:
        if not (WINDOWS_DRIVE.match(path) or path.startswith("/")):
            if ntpath.splitdrive(path)[0] or ntpath.isabs(path):
                raise ValueError(f"agy requires an unambiguous path: {path}")
            path = ntpath.join(cwd, path)
        return _windows_path(path)
    return os.path.realpath(os.path.join(cwd, path))


HOST_COMMANDS = ["command(*)", "unsandboxed(*)"]


def build_command(args, run_dir, conversation_id, scratch=None):
    """Return argv and env for a process that accepts the runner's raw UTF-8 prompt.

    Serialize build/spawn and cancel with the runner's process lock.
    """
    command = os.fspath(args.agy_command) if args.agy_command else ""
    if not command:
        raise ValueError("agy_command is required")
    _reject_unc(command)
    windows = os.name == "nt" or command.lower().endswith(".exe")
    cwd = _windows_path(args.cwd) if windows else os.path.realpath(args.cwd)
    _reject_unc(os.fspath(args.cwd))
    if windows:
        command = _windows_path(command)
    elif "/" in command:
        command = str(Path(args.cwd, command).resolve())

    settings = {"modelProvider": "", "useG1Credits": False, "toolPermission": "request-review"}
    readonly = args.sandbox == "read-only" or (getattr(args, "context", None) or {}).get("write") is False
    flags = ["--input-format", "stream-json", "--output-format", "stream-json",
             "--disable-slash-commands"]
    if args.sandbox != "danger-full-access":
        if args.sandbox not in ("read-only", "workspace-write"):
            raise ValueError(f"Unsupported agy sandbox: {args.sandbox}")
        scopes = [_path_from_cwd(path, cwd, windows) for path in args.scope or []]
        roots = [_path_from_cwd(path, cwd, windows) for path in args.writable_roots or []]
        normalize = ntpath.normcase if windows else os.path.normcase
        if roots or any(normalize(scope) != normalize(cwd) for scope in scopes):
            raise ValueError("agy cannot enforce extra writable roots or a restricted path scope")
        if args.sandbox == "workspace-write":
            raise ValueError("agy cannot enforce workspace-write against inherited permission grants")
        if scratch is not None:
            raise ValueError("agy read-only cannot provide writable verification scratch")
        flags.append("--sandbox")
    # Host access means the task runs unsandboxed with the machine's full permissions, as it does for Codex. Headless
    # agy cannot prompt, so without an allow rule every shell command is denied and the task fails.
    # The file tools need their own rules: a read_file outside the workspace otherwise asks, headless agy auto-denies it
    # and the whole job fails (3 of the first 10 host jobs on 2026-11-22). They grant nothing command(*) does not.
    host = args.sandbox == "danger-full-access"
    if readonly:
        flags += ["--mode", "plan"]
        settings.update(allowNonWorkspaceAccess=host, enableTerminalSandbox=not host, permissions={
            "allow": [*HOST_COMMANDS, "read_file(*)"] if host else [], "ask": [],
            "deny": ["write_file(*)", *([] if host else ["command(*)", "unsandboxed(*)"]),
                     "mcp(*)", "read_url(*)", "execute_url(*)"],
        })
    else:
        flags += ["--mode", "accept-edits"]
        if host:
            settings.update(allowNonWorkspaceAccess=True,
                            permissions={"allow": [*HOST_COMMANDS, "read_file(*)", "write_file(*)"]})

    flags += ["--settings", json.dumps(settings, separators=(",", ":"))]
    if args.schema:
        flags += ["--json-schema", _path_from_cwd(args.schema, cwd, windows)]
    if args.model:
        flags += ["--model", args.model]
    if args.effort:
        if args.effort not in ("low", "medium", "high", "xhigh", "max"):
            raise ValueError(f"Unsupported agy effort: {args.effort}")
        flags += ["--effort", args.effort]
    if conversation_id is not None:
        if not isinstance(conversation_id, str) or not conversation_id or "\0" in conversation_id:
            raise ValueError("agy conversation_id must be a nonempty string")
        flags += ["--conversation", conversation_id]

    env = os.environ.copy()
    exported = []
    if args.agy_proxy:
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            env[key] = env[key.lower()] = args.agy_proxy
            exported.append(key)
    if getattr(args, "agy_home", None):
        # agy reads its login and conversations from HOME/USERPROFILE; one directory per pooled account.
        home = _windows_path(args.agy_home) if windows else os.path.realpath(args.agy_home)
        env["HOME"] = env["USERPROFILE"] = home
        exported.extend(("HOME", "USERPROFILE"))
    if host and readonly:
        # Python bytecode and pytest caches written into the project failed 3 of 87 Gemini verifications as
        # verification_tree_changed (none of 307 Codex ones, which set the same two variables). Plain values, so
        # WSLENV also carries them into the commands Gemini runs through wsl.exe.
        env.update(PYTHONDONTWRITEBYTECODE="1", PYTEST_ADDOPTS="-p no:cacheprovider")
        exported.extend(("PYTHONDONTWRITEBYTECODE", "PYTEST_ADDOPTS"))
    if scratch is not None:
        tmp = Path(scratch) / "tmp"
        temp = _windows_path(tmp) if windows else str(tmp.resolve())
        tmp.mkdir(parents=True, exist_ok=True)
        env.update(TMP=temp, TEMP=temp, TMPDIR=temp)
        exported.extend(("TMP", "TEMP", "TMPDIR"))
    if exported and windows and os.name != "nt":
        existing = [entry for entry in env.get("WSLENV", "").split(":")
                    if entry and entry.split("/")[0].upper() not in exported]
        env["WSLENV"] = ":".join([*existing, *exported])

    run_dir = Path(run_dir).absolute()
    if windows:
        job_id = uuid.uuid4().hex
        _record(run_dir / JOB_RECORD, job_id)
    else:
        job_id = ""
    cmd = [sys.executable, str(Path(__file__).resolve()), str(run_dir), job_id, cwd, command, *flags]
    return cmd, env


def _record(path, value):
    temp = path.with_name(f".{path.name}.{os.getpid()}")
    temp.write_text(value, encoding="ascii")
    temp.replace(path)


def _read_record(path):
    try:
        return path.read_text(encoding="ascii")
    except FileNotFoundError:
        return None


def _powershell():
    script = Path(__file__).with_name("agy_process.ps1").read_text(encoding="utf-8")
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    exe = POWERSHELL if os.name == "nt" else "/mnt/c/" + POWERSHELL[3:].replace("\\", "/")
    return [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]


def cancel(run_dir):
    """Gate Windows startup and verify job termination. Keep normal runner tree cleanup.

    Call under the same process lock as launch, before publishing cancellation
    or a timeout. False means cleanup could not be verified within the bound.
    """
    run_dir = Path(run_dir)
    try:
        job_id = _read_record(run_dir / JOB_RECORD)
        if job_id is None:
            return True
        if not re.fullmatch(r"[0-9a-f]{32}", job_id):
            return False
        _record(run_dir / CANCEL_RECORD, job_id)
        stopped = subprocess.run(
            _powershell(), input=json.dumps({"cancel": True, "job": job_id}).encode("ascii") + b"\n",
            capture_output=True, timeout=15,
        )
        return stopped.returncode == 0 and stopped.stdout.strip() == b"AGY_JOB_STOPPED"
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return False


def _emit(event):
    sys.stdout.buffer.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def _windows_launch(run_dir, job_id, cwd, command, flags, prompt):
    process = subprocess.Popen(
        _powershell(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    finished = threading.Event()
    try:
        spec = json.dumps({
            "job": job_id, "cwd": cwd, "command": command, "arguments": subprocess.list2cmdline(flags),
            "prompt": base64.b64encode(prompt).decode("ascii"),
        }).encode("ascii")
        process.stdin.write(spec + b"\n")
        process.stdin.flush()
        if (process.stdout.readline().strip() != b"AGY_JOB_READY"
                or _read_record(run_dir / CANCEL_RECORD) == job_id):
            process.stdin.close()
            return process, finished
        process.stdin.write(b"GO\n")
        process.stdin.flush()
    except OSError:
        try:
            process.stdin.close()
        except OSError:
            pass
        return process, finished

    def heartbeat():
        try:
            with process.stdin:
                while not finished.wait(0.5):
                    process.stdin.write(b"\n")
                    process.stdin.flush()
        except OSError:
            pass

    threading.Thread(target=heartbeat, daemon=True).start()
    return process, finished


def _launch(run_dir, job_id, cwd, command, flags):
    prompt = (json.dumps({
        "event": "user", "message": {"role": "user", "content": sys.stdin.buffer.read().decode("utf-8")},
    }, ensure_ascii=False) + "\n").encode("utf-8")
    if job_id:
        child, finished = _windows_launch(run_dir, job_id, cwd, command, flags, prompt)
    else:
        child = subprocess.Popen(
            [command, *flags], cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        finished = threading.Event()

        def send_prompt():
            try:
                with child.stdin:
                    child.stdin.write(prompt)
            except BrokenPipeError:
                pass

        threading.Thread(target=send_prompt, daemon=True).start()
    denied = []
    tool_denied = []
    diagnostics_tail = [""]
    invalid_flag = []
    provider_denial = []

    def stderr():
        with child.stderr:
            for line in child.stderr:
                sys.stderr.buffer.write(line)
                sys.stderr.buffer.flush()
                text = line.decode("utf-8", "replace").strip()
                problem = _error_payload(text)
                rendered = _message(problem)
                if isinstance(problem, dict) and rendered:
                    diagnostics_tail[0] = problem
                elif text:
                    previous = diagnostics_tail[0]
                    if isinstance(previous, str) and _http_status(previous) in QUOTA_STATUS_CODES and not _http_status(text):
                        diagnostics_tail[0] = f"{previous}\n{text}"[:1000]
                    else:
                        diagnostics_tail[0] = text[-1000:]
                text = rendered or text
                if not invalid_flag and INVALID_FLAG.search(text):
                    invalid_flag.append(text[:1000])
                if EXPLICIT_TOOL_DENIAL.search(text):
                    if not tool_denied:
                        tool_denied.append(text[-1000:])
                elif HTTP_FORBIDDEN.search(text):
                    if not provider_denial:
                        provider_denial.append(text[:1000])
                elif not denied and DENIAL.search(text):
                    denied.append(text[-1000:])

    diagnostics = threading.Thread(target=stderr, daemon=True)
    diagnostics.start()
    result = None
    try:
        with child.stdout:
            for line in child.stdout:
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    event = None
                if isinstance(event, dict) and event.get("event") == "result":
                    result = event
                else:
                    sys.stdout.buffer.write(line)
                    sys.stdout.buffer.flush()
        code = child.wait()
        diagnostics.join()
        payload = (result or {}).get("result")
        payload = payload if isinstance(payload, dict) else {}
        conversation_id = (result or {}).get("conversation_id") or payload.get("conversation_id")
        problem = _error_payload((result or {}).get("error") or payload.get("error"))
        denial = tool_denied or (
            denied if not (HTTP_FORBIDDEN.search(_message(problem)) or (result is None and provider_denial)) else [])
        if denial:
            _emit({"event": "permission_denied", "error": denial[0],
                   "conversation_id": conversation_id})
        if result is not None and (not code or payload.get("status") != "SUCCESS"):
            _emit(result)
        elif code:
            problem = provider_denial[0] if provider_denial else diagnostics_tail[0]
            if invalid_flag:
                problem = f"agy rejected a CLI argument: {invalid_flag[0]}"
            _emit({"event": "error", "error": problem or f"agy process exited with code {code}",
                   "conversation_id": conversation_id})
        return code
    finally:
        finished.set()


def _error_payload(problem):
    if isinstance(problem, str) and problem.lstrip().startswith("{"):
        try:
            parsed = json.loads(problem)
        except ValueError:
            return problem
        if isinstance(parsed, dict):
            return _error_payload(parsed)
    if isinstance(problem, dict):
        for field in ("message", "error"):
            nested = _error_payload(problem.get(field))
            if isinstance(nested, dict):
                return {**problem, **nested}
    return problem


def _http_status(problem):
    if isinstance(problem, dict):
        for value in (problem.get("code"), problem.get("status")):
            if re.fullmatch(r"[1-5][0-9]{2}", str(value)):
                return int(value)
    elif isinstance(problem, str) and (match := HTTP_STATUS.search(problem.strip())):
        return int(match[1])
    return None


def _quota_details(problem):
    details = problem.get("details") if isinstance(problem, dict) else None
    by_type = {}
    if isinstance(details, list):
        for detail in details:
            if isinstance(detail, dict) and isinstance(kind := detail.get("@type"), str):
                by_type.setdefault(kind, detail)
    return by_type


def _duration_seconds(value):
    if isinstance(value, str) and (match := re.fullmatch(r"(\d+(?:\.\d*)?|\.\d+)(ms|s)", value)):
        return float(match[1]) / (1000 if match[2] == "ms" else 1)
    return None


def _retry_kind(delay_seconds):
    return "provider_permanent" if delay_seconds > MAX_RETRYABLE_DELAY_SECONDS else "transient"


def _google_quota_kind(problem, message):
    if isinstance(problem, dict):
        name = problem.get("name")
        if name == "TerminalQuotaError":
            return "provider_permanent"
        if name == "RetryableQuotaError":
            return "transient"
    status = _http_status(problem) or _http_status(message)
    if status in (401, 403, 404):
        return None
    if status in QUOTA_STATUS_CODES and re.search(r"limit:\s*0(?!\d|\.\d)", message, re.I):
        return "provider_permanent"
    if status in (400, 429, 499) and re.search(r"\b(?:spending|spend)\s+cap\b", message, re.I):
        return "provider_permanent"

    details = _quota_details(problem)
    if status not in QUOTA_STATUS_CODES or not details:
        if match := re.search(r"Please retry in ([0-9.]+(?:ms|s))", message):
            seconds = _duration_seconds(match[1])
            return _retry_kind(seconds) if seconds is not None else None
        if status in QUOTA_STATUS_CODES and CAPACITY_EXHAUSTION.search(message):
            return "provider_permanent"
        if (status is None or status in QUOTA_STATUS_CODES) and "quota" in message.lower():
            if re.search(r"per[ _-]?(?:day|week)|daily|weekly", message, re.I):
                return "provider_permanent"
            if re.search(r"per[ _-]?minute", message, re.I):
                return "transient"
            if re.search(r"\bquota (?:is )?exhausted\b", message, re.I):
                return "provider_permanent"
        return "transient" if status in QUOTA_STATUS_CODES else None

    violations = details.get(GOOGLE_RPC + "QuotaFailure", {}).get("violations")
    quota_ids = [str(item.get("quotaId", "")) for item in (violations if isinstance(violations, list) else ())
                 if isinstance(item, dict)]
    if any("PerDay" in quota or "Daily" in quota for quota in quota_ids):
        return "provider_permanent"

    delay = _duration_seconds(details.get(GOOGLE_RPC + "RetryInfo", {}).get("retryDelay"))
    info = details.get(GOOGLE_RPC + "ErrorInfo", {})
    reason = info.get("reason")
    if reason in TERMINAL_QUOTA_REASONS:
        return "provider_permanent"
    domain = re.sub(r"[^a-zA-Z0-9.-]", "", str(info.get("domain", "")))
    if domain in CLOUD_CODE_DOMAINS and (
            reason == "QUOTA_EXHAUSTED" or (reason == "RATE_LIMIT_EXCEEDED" and not delay)):
        return "provider_permanent"
    if delay:
        return _retry_kind(delay)
    metadata = info.get("metadata")
    quota_limit = str(metadata.get("quota_limit", "")) if isinstance(metadata, dict) else ""
    if any("PerMinute" in quota for quota in quota_ids) or "PerMinute" in quota_limit:
        return "transient"
    return "provider_permanent" if CAPACITY_EXHAUSTION.search(message) else "transient"


def _message(payload):
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        message = _message(payload.get("message") or payload.get("error") or payload.get("code") or payload.get("type"))
        if status := _http_status(payload):
            return f"HTTP {status}: {message}" if message and message != str(status) else f"HTTP {status}"
        return message
    return ""


class EventAdapter:
    def __init__(self):
        self.conversation_id = None
        self.finished = False
        self.commands = {}

    def _failed(self, message, problem=None):
        self.finished = True
        error = {"message": message}
        if problem is not None and (kind := _google_quota_kind(problem, message)):
            error["quota_kind"] = kind
        return {"type": "turn.failed", "error": error}

    def events(self, raw_event):
        if not isinstance(raw_event, dict) or self.finished:
            return
        kind = raw_event.get("event")
        result = raw_event.get("result")
        result = result if isinstance(result, dict) else {}
        step = raw_event.get("step_update")
        step = step if isinstance(step, dict) else {}
        conversation_id = raw_event.get("conversation_id") or result.get("conversation_id") or step.get("conversation_id")
        if isinstance(conversation_id, str) and conversation_id and conversation_id != self.conversation_id:
            if self.conversation_id is not None:
                yield self._failed("agy changed conversation_id within a turn")
                return
            self.conversation_id = conversation_id
            yield {"type": "thread.started", "thread_id": conversation_id}

        info = step.get("tool_info")
        info = info if isinstance(info, dict) else {}
        status = str(result.get("status", raw_event.get("status", "")))
        problem = _error_payload(raw_event.get("error") or result.get("error") or step.get("error") or info.get("error"))
        error = _message(problem)
        signals = (error, status, str(kind), str(step.get("state", "")), str(info.get("status", "")),
                   str(problem.get("type") or problem.get("code")) if isinstance(problem, dict) else "")
        tool_denial = next((text for text in signals if EXPLICIT_TOOL_DENIAL.search(text)), None)
        if not tool_denial and kind in ("result", "error") and status != "SUCCESS" and HTTP_FORBIDDEN.search(error):
            yield self._failed(error)
            return
        denial = tool_denial or next((text for text in signals if DENIAL.search(text)), None)
        if denial:
            yield self._failed(f"agy permission denied: {error or denial}")
        elif kind == "result":
            if status != "SUCCESS":
                problem = problem or _error_payload(result.get("response"))
                yield self._failed(error or _message(problem) or f"agy result status: {status or 'missing'}", problem)
                return
            report = result.get("structured_output")
            if isinstance(report, str):
                try:
                    report = json.loads(report)
                except ValueError:
                    report = None
            if not isinstance(report, dict):
                yield self._failed("agy SUCCESS result is missing a structured_output object")
                return
            self.finished = True
            yield {"type": "item.completed", "item": {
                "id": "agy-report", "type": "agent_message", "text": json.dumps(report, ensure_ascii=False),
            }}
            yield {"type": "turn.completed", "usage": result.get("usage")}
        elif kind == "error":
            yield self._failed(error or "agy reported an error", problem)
        elif kind == "user_input" or step.get("step_type") == "user_input":
            yield {"type": "turn.started"}
        elif step.get("step_type") == "tool":
            yield from self._tool_events(step, info, error)
        elif kind and kind != "init":
            yield {"type": "agy.progress", "event": kind}

    def _tool_events(self, step, info, error):
        name = step.get("tool_name") or info.get("name")
        index = step.get("step_index")
        state = step.get("state")
        params = info.get("parameters")
        params = params if isinstance(params, dict) else {}
        command = params.get("CommandLine")
        path = params.get("Path") or params.get("TargetFile")
        if isinstance(index, int) and state == "DONE" and index in self.commands:
            command = self.commands.pop(index)
            name = "run_command"
        if name == "run_command" and isinstance(index, int) and isinstance(command, str):
            item = {"id": f"agy-step-{index}", "type": "command_execution", "command": command}
            if state == "ACTIVE" and index not in self.commands:
                self.commands[index] = command
                yield {"type": "item.started", "item": dict(item, status="in_progress")}
                return
            if state == "DONE":
                yield {"type": "item.completed", "item": dict(
                    item, status="failed" if error else "completed",
                    aggregated_output=error or info.get("output") or "", exit_code=info.get("exit_code"),
                )}
                return
        if (state == "DONE" and not error and isinstance(path, str)
                and name in ("write_file", "write_to_file", "replace_file_content", "multi_replace_file_content")):
            yield {"type": "item.completed", "item": {"type": "file_change", "changes": [
                {"path": path, "kind": "modified"},
            ]}}
        else:
            yield {"type": "agy.progress", "event": "step_update"}


if __name__ == "__main__":
    try:
        sys.exit(_launch(Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]))
    except OSError as error:
        _emit({"event": "error", "error": f"agy launch failed: {error}"})
        sys.exit(1)
