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
TOOL_DENIAL = re.compile(
    r"\b(?:soft[-_ ]den(?:y|ied|ial)|(?:denied|blocked) (?:by|due to) permissions?"
    r"|(?:permission|approval) (?:is )?required|requires (?:\w+ )?(?:approval|permission)"
    r"|not (?:pre-?)?approved|without (?:pre-?)?approval|permission (?:request )?was denied"
    r"|(?:tool call|command) (?:was )?denied|permissions\.allow"
    r"|(?:approval|permission) [^\n]*(?:headless|non.interactive))\b", re.IGNORECASE
)
DENIAL = re.compile(r"\bpermission[-_ ]denied\b", re.IGNORECASE)
INVALID_FLAG = re.compile(r"flag provided but not defined|unknown (?:flag|option)|invalid value .+ for flag", re.IGNORECASE)
HTTP_FORBIDDEN = re.compile(r"\b403\b")


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
    if readonly:
        flags += ["--mode", "plan"]
        settings.update(allowNonWorkspaceAccess=False, enableTerminalSandbox=True, permissions={
            "allow": [], "ask": [],
            "deny": ["write_file(*)", "command(*)", "unsandboxed(*)", "mcp(*)", "read_url(*)", "execute_url(*)"],
        })
    else:
        flags += ["--mode", "accept-edits"]

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
                if text:
                    diagnostics_tail[0] = text[-1000:]
                if not invalid_flag and INVALID_FLAG.search(text):
                    invalid_flag.append(text[:1000])
                if TOOL_DENIAL.search(text):
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
        problem = (result or {}).get("error") or payload.get("error")
        denial = tool_denied or (denied if not (_provider_forbidden(problem) or (result is None and provider_denial)) else [])
        if denial:
            _emit({"event": "permission_denied", "error": denial[0],
                   "conversation_id": conversation_id})
        if result is not None and (not code or payload.get("status") != "SUCCESS"):
            _emit(result)
        elif code:
            message = provider_denial[0] if provider_denial else diagnostics_tail[0]
            if invalid_flag:
                message = f"agy rejected a CLI argument: {invalid_flag[0]}"
            _emit({"event": "error", "error": message or f"agy process exited with code {code}",
                   "conversation_id": conversation_id})
        return code
    finally:
        finished.set()


def _message(payload):
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("error") or payload.get("code") or payload.get("type")
        return _message(message) if message else ""
    return ""


def _provider_forbidden(problem):
    return (isinstance(problem, dict) and str(problem.get("code")) == "403") or bool(HTTP_FORBIDDEN.search(_message(problem)))


class EventAdapter:
    def __init__(self):
        self.conversation_id = None
        self.finished = False
        self.commands = {}

    def _failed(self, message):
        self.finished = True
        return {"type": "turn.failed", "error": {"message": message}}

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
        problem = raw_event.get("error") or result.get("error") or step.get("error") or info.get("error")
        error = _message(problem)
        signals = (error, status, str(kind), str(step.get("state", "")), str(info.get("status", "")),
                   str(problem.get("type") or problem.get("code")) if isinstance(problem, dict) else "")
        tool_denial = next((text for text in signals if TOOL_DENIAL.search(text)), None)
        if not tool_denial and kind in ("result", "error") and status != "SUCCESS" and _provider_forbidden(problem):
            yield self._failed(error if HTTP_FORBIDDEN.search(error) else f"HTTP 403: {error or 'Forbidden'}")
            return
        denial = tool_denial or next((text for text in signals if DENIAL.search(text)), None)
        if denial:
            yield self._failed(f"agy permission denied: {error or denial}")
        elif kind == "result":
            if status != "SUCCESS":
                yield self._failed(error or _message(result.get("response"))[:1000] or
                                   f"agy result status: {status or 'missing'}")
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
            yield self._failed(error or "agy reported an error")
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
