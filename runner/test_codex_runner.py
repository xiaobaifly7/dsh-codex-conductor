"""Fault-injection tests for codex_runner.py. They use a fake Codex, so they spend no model quota."""
import errno
import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

RUNNER = Path(__file__).with_name("codex_runner.py")

FAKE_CODEX = textwrap.dedent(r"""
    import json, os, subprocess, sys, time
    from pathlib import Path

    state = Path(os.environ["FAKE_STATE"])
    state.mkdir(exist_ok=True)
    calls = len(list(state.glob("call-*.json")))
    mode = os.environ["FAKE_MODE"]
    if mode == "stall_before_stdin":
        child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        time.sleep(6)
    prompt = sys.stdin.buffer.read()
    (state / f"call-{calls}.json").write_text(json.dumps({"argv": sys.argv[1:], "prompt": prompt.decode("utf-8")}))

    def say(**ev):
        print(json.dumps(ev), flush=True)

    def finish(text="done"):
        say(type="item.completed", item={"type": "agent_message", "text": text})
        say(type="turn.completed", usage={"input_tokens": 1})

    if mode == "fault_logging":
        child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
    say(type="thread.started", thread_id="thread-1")
    say(type="turn.started")
    if mode == "warnings_then_ok":
        say(type="item.completed", item={"type": "error", "message": "Codex is ignoring 2 unrecognized settings"})
        finish()
    elif mode == "invalid_windows_path_report":
        finish(r'{"summary": "D:\docs\log.txt"}')
    elif mode == "literal_newline_report":
        finish('{"summary":"ok","criteria":[{"criterion":"checked","status":"met","evidence":"first\nsecond"}],'
               '"files_changed":[],"deviations":[],"unresolved":[]}')
    elif mode == "nonzero_after_completed":
        finish()
        sys.exit(1)
    elif mode == "exit0_without_completion":
        sys.exit(0)
    elif mode == "close_stdout_then_hang":
        os.close(sys.stdout.fileno())
        time.sleep(300)
    elif mode == "fault_logging":
        time.sleep(300)
    elif mode == "hang_with_child":
        child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        time.sleep(300)
    elif mode == "hang_after_completed":
        child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        finish()
        time.sleep(300)
    elif mode in ("transient_then_ok", "transient_with_inherited_group_child", "success_with_inherited_group_child"):
        if calls == 0:
            if mode != "transient_then_ok":
                child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                (state / "child.pid").write_text(str(child.pid))
            if mode != "success_with_inherited_group_child":
                say(type="error", message="stream disconnected before completion")
                say(type="turn.failed", error={"message": "stream disconnected before completion"})
                sys.exit(1)
        finish()
    elif mode == "permanent":
        say(type="turn.failed", error={"message": "401 Unauthorized"})
        sys.exit(1)
    elif mode == "retry_notice_then_ok":
        say(type="error", message="Reconnecting... 1/5")
        finish()
    elif mode == "reconnect_forever":
        child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        while True:
            say(type="error", message="Reconnecting... waiting for network")
            time.sleep(0.5)
    elif mode == "scoped_write":
        Path("keep/a.txt").write_text("changed by a shell command")
        say(type="item.completed", item={"type": "file_change",
                                         "changes": [{"path": os.path.join(os.getcwd(), "keep", "a.txt"), "kind": "update"},
                                                     {"path": os.path.join(os.getcwd(), "other.txt"), "kind": "update"}]})
        finish()
    elif mode == "gated_ok":
        active = state / "writer-active"
        active.mkdir()  # A second model running concurrently must fail the test.
        try:
            (state / f"ready-{calls}").touch()
            deadline = time.monotonic() + 30
            while not (state / f"release-{calls}").exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("test release gate timed out")
                time.sleep(.01)
            finish()
        finally:
            active.rmdir()
    elif mode == "slow_ok":
        time.sleep(float(os.environ.get("FAKE_SLEEP", "4")))
        finish()
""")


def alive(pid):
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        try:
            return Path(f"/proc/{pid}/stat").read_text().split()[2] != "Z"  # a killed, unreaped child is gone
        except OSError:
            return False
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"], capture_output=True, text=True, errors="replace").stdout
    return f'"{pid}"' in out


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.fake = root / "fake_codex.py"
        self.fake.write_text(FAKE_CODEX)
        self.state = root / "state"
        self.cwd = root / "work"
        self.cwd.mkdir()
        (root / "isolated-codex-home").mkdir()
        self.env = dict(os.environ, CODEX_RUNNER_HOME=str(root / "home"), FAKE_STATE=str(self.state),
                        CODEX_RUNNER_CMD=json.dumps([sys.executable, "-B", str(self.fake)]), CODEX_RUNNER_ROUTER_URL="",
                        CODEX_HOME=str(root / "isolated-codex-home"), PYTHONDONTWRITEBYTECODE="1")
        environment = mock.patch.dict(os.environ, self.env)
        environment.start()
        self.addCleanup(environment.stop)

    def tearDown(self):
        child = self.state / "child.pid"
        if child.exists():
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", child.read_text(), "/T", "/F"], capture_output=True)
            else:
                try:
                    os.kill(int(child.read_text()), 9)
                except ProcessLookupError:
                    pass
        self.tmp.cleanup()

    def invoke(self, *extra, mode="warnings_then_ok", prompt="do it", command="run", env=None):
        args = [sys.executable, "-B", str(RUNNER), command, "--cwd", str(self.cwd), "--backoff", "0.1", *extra]
        p = subprocess.run(args, input=prompt.encode("utf-8"), capture_output=True, timeout=60,
                           env={**self.env, "FAKE_MODE": mode, **(env or {})})
        return json.loads(p.stdout.decode("utf-8"))

    def calls(self):
        return [json.loads(f.read_text()) for f in sorted(self.state.glob("call-*.json"))]

    def wait_for(self, condition):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(.01)
        self.fail("test condition did not become ready")

    def test_warning_items_do_not_fail_the_run(self):
        r = self.invoke()
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["final_message"], "done")
        # A read-only run is --ephemeral, so its own thread cannot be resumed and is not advertised.
        self.assertIsNone(r["thread_id"])
        self.assertNotIn("usage_scope", r)
        self.assertEqual(self.invoke("--sandbox", "workspace-write")["thread_id"], "thread-1")

    def test_literal_newline_in_evidence_preserves_the_structured_and_raw_report(self):
        schema = RUNNER.parents[1] / "report.v2.schema.json"
        result = self.invoke("--schema", str(schema), mode="literal_newline_report")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["structured"]["criteria"],
                         [{"criterion": "checked", "status": "met", "evidence": "first\nsecond"}])
        self.assertIn('"evidence":"first\nsecond"', result["final_message"])

    def test_invalid_windows_path_report_preserves_the_original_and_reports_json_position(self):
        schema = RUNNER.parents[1] / "report.v2.schema.json"
        result = self.invoke("--schema", str(schema), mode="invalid_windows_path_report")
        self.assertEqual(result["error_kind"], "schema_invalid")
        self.assertEqual(result["final_message"], r'{"summary": "D:\docs\log.txt"}')
        self.assertRegex(result["error"], r"Invalid \\escape \(line 1, column \d+\)")
        self.assertNotIn("structured", result)

    def test_read_only_resume_keeps_the_writer_thread_and_marks_usage_as_thread_total(self):
        r = self.invoke("--resume", "writer-9")
        self.assertEqual(r["thread_id"], "writer-9")
        self.assertEqual(r["usage_scope"], "thread_total")
        self.assertIn("writer-9", self.calls()[0]["argv"])

    def test_retry_notice_does_not_fail_the_run(self):
        self.assertEqual(self.invoke(mode="retry_notice_then_ok")["status"], "completed")

    def test_turn_completed_wins_over_nonzero_exit(self):
        self.assertEqual(self.invoke(mode="nonzero_after_completed")["status"], "completed")

    def test_exit_zero_without_turn_completed_is_a_failure(self):
        r = self.invoke(mode="exit0_without_completion")
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["error_kind"], "incomplete")

    def test_idle_timeout_kills_the_whole_tree(self):
        r = self.invoke("--idle-timeout", "3", "--retries", "0", mode="hang_with_child")
        self.assertEqual(r["error_kind"], "idle_timeout")
        self.assertTrue(r["retryable"])
        time.sleep(1)
        self.assertFalse(alive(int((self.state / "child.pid").read_text())))

    def test_endless_reconnect_notices_are_cut_off_and_retryable(self):
        start = time.time()
        r = self.invoke("--reconnect-timeout", "2", "--idle-timeout", "60", "--retries", "0", mode="reconnect_forever")
        self.assertEqual(r["error_kind"], "reconnect_timeout")
        self.assertTrue(r["retryable"])
        self.assertLess(time.time() - start, 20)
        time.sleep(1)
        self.assertFalse(alive(int((self.state / "child.pid").read_text())))

    def test_reconnect_notices_do_not_refresh_the_idle_timer(self):
        r = self.invoke("--idle-timeout", "2", "--reconnect-timeout", "60", "--retries", "0", mode="reconnect_forever")
        self.assertEqual(r["error_kind"], "idle_timeout")

    def test_total_timeout_is_not_retried(self):
        r = self.invoke("--timeout", "3", "--idle-timeout", "30", mode="hang_with_child")
        self.assertEqual(r["error_kind"], "timeout")
        self.assertEqual(r["attempts"], 1)

    def test_attempt_timeouts_ignore_wall_clock_jumps(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        parser = codex_runner.Parser()
        codex_runner.add_task_arguments(parser)
        args = parser.parse_args(["--cwd", str(self.cwd), "--timeout", "3", "--idle-timeout", "3"])
        run_dir = Path(self.tmp.name) / "attempt"
        run_dir.mkdir()
        with mock.patch.dict(os.environ, {"FAKE_MODE": "slow_ok", "FAKE_SLEEP": ".1"}), \
                mock.patch.object(codex_runner.time, "time", side_effect=range(0, 360000, 3600)):
            state = codex_runner.run_attempt(args, "do it", run_dir, None)
        self.assertTrue(state["completed"])
        self.assertIsNone(state["end_reason"])

    def test_failure_classification_only_reads_current_attempt_stderr(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        self.fake.write_text(FAKE_CODEX.replace('sys.exit(0)',
            'sys.stderr.write("first attempt: connection reset\\n" if calls == 0 else "second attempt stopped\\n"); sys.exit(0)'))
        value = self.invoke(mode="exit0_without_completion")
        self.assertEqual(value["error_kind"], "incomplete")
        self.assertEqual(value["attempts"], 2)
        self.assertEqual(value["error"], "second attempt stopped")
        self.assertIn("first attempt", (Path(value["log_dir"]) / "stderr.log").read_text())

    def test_stdout_eof_does_not_stop_the_timeout_monitor(self):
        start = time.monotonic()
        r = self.invoke("--timeout", "1", "--idle-timeout", "30", "--retries", "0", mode="close_stdout_then_hang")
        self.assertEqual(r["error_kind"], "timeout")
        self.assertEqual(r["attempts"], 1)
        self.assertLess(time.monotonic() - start, 5)

    def test_timeout_while_child_is_not_reading_a_large_prompt(self):
        start = time.monotonic()
        r = self.invoke("--timeout", "1", "--idle-timeout", "30", "--retries", "0",
                        mode="stall_before_stdin", prompt="x" * 1048576)
        self.assertEqual(r["error_kind"], "timeout")
        self.assertEqual(r["attempts"], 1)
        self.assertLess(time.monotonic() - start, 5)
        self.assertFalse(alive(int((self.state / "child.pid").read_text())))

    def test_process_that_hangs_after_completion_still_succeeds(self):
        start = time.time()
        r = self.invoke("--exit-grace", "2", mode="hang_after_completed")
        self.assertEqual(r["status"], "completed")
        self.assertTrue(r["forced_exit"])
        self.assertLess(time.time() - start, 20)
        time.sleep(1)
        self.assertFalse(alive(int((self.state / "child.pid").read_text())))

    def test_transient_failure_on_writer_resumes_the_same_thread(self):
        r = self.invoke("--sandbox", "workspace-write", "--writable-root", str(self.cwd / "extra"),
                        mode="transient_then_ok")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["attempts"], 2)
        self.assertEqual(r["usage_scope"], "thread_total")
        first, second = self.calls()
        self.assertNotIn("resume", first["argv"])
        self.assertIn("resume", second["argv"])
        self.assertIn("thread-1", second["argv"])
        self.assertIn("interrupted", second["prompt"])
        override = "sandbox_workspace_write.writable_roots=" + json.dumps([str(self.cwd / "extra")])
        for call in (first, second):
            self.assertEqual(call["argv"].count(override), 1)
            self.assertEqual(call["argv"][call["argv"].index(override) - 1], "-c")

    def test_router_recovery_keeps_the_unsent_resume_task(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for sandbox in ("workspace-write", "danger-full-access", "read-only"):
            with self.subTest(sandbox=sandbox), mock.patch.dict(os.environ, {**self.env, "FAKE_MODE": "warnings_then_ok"}), \
                    mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                    mock.patch.object(codex_runner, "router_reachable", side_effect=[False, True]):
                parser = codex_runner.Parser()
                codex_runner.add_task_arguments(parser)
                args = parser.parse_args(["--cwd", str(self.cwd), "--sandbox", sandbox,
                                          "--resume", "writer-9", "--backoff", "0"])
                result = codex_runner.execute(args, "NEW TASK: fix the CSV parser", Path(self.tmp.name) / sandbox)
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["attempts"], 2)
                self.assertEqual(result["usage_scope"], "thread_total")
                self.assertEqual(self.calls()[-1]["prompt"], "NEW TASK: fix the CSV parser")
                self.assertIn("writer-9", self.calls()[-1]["argv"])

    def test_pid_and_event_write_errors_reap_the_process_and_preserve_the_error(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        parser = codex_runner.Parser()
        codex_runner.add_task_arguments(parser)
        args = parser.parse_args(["--cwd", str(self.cwd)])
        real_open, real_write = open, Path.write_text
        for operation in ("pid", "write", "flush"):
            with self.subTest(operation=operation):
                run_dir = Path(self.tmp.name) / operation
                run_dir.mkdir()
                failure = OSError(errno.ENOSPC, "injected " + operation + " failure")
                spawned = []
                real_popen = subprocess.Popen

                def spawn(*a, **kw):
                    proc = real_popen(*a, **kw)
                    spawned.append(proc)
                    return proc

                def write_pid(path, *a, **kw):
                    if operation == "pid" and path == run_dir / "codex.pid":
                        raise failure
                    return real_write(path, *a, **kw)

                def open_log(path, *a, **kw):
                    f = real_open(path, *a, **kw)
                    if path == run_dir / "events.jsonl" and operation != "pid":
                        wrapped = mock.MagicMock(wraps=f)
                        wrapped.__enter__.return_value = wrapped
                        wrapped.__exit__.side_effect = lambda *exc: f.close()
                        getattr(wrapped, operation).side_effect = failure
                        return wrapped
                    return f

                try:
                    with mock.patch.dict(os.environ, {**self.env, "FAKE_MODE": "fault_logging"}), \
                            mock.patch.object(codex_runner.subprocess, "Popen", side_effect=spawn), \
                            mock.patch.object(Path, "write_text", write_pid), \
                            mock.patch.object(codex_runner, "open", open_log, create=True):
                        with self.assertRaises(OSError) as stopped:
                            codex_runner.run_attempt(args, "do it", run_dir, None)
                    self.assertIs(stopped.exception, failure)
                    self.assertIsNotNone(spawned[0].returncode)
                    self.assertFalse(alive(spawned[0].pid))
                    self.assertTrue(spawned[0].stdin.closed)
                    self.assertTrue(spawned[0].stdout.closed)
                    child_file = self.state / "child.pid"
                    if child_file.exists():
                        self.assertFalse(alive(int(child_file.read_text())))
                finally:
                    for proc in spawned:
                        if alive(proc.pid):
                            codex_runner.kill_tree(proc.pid)
                        proc.wait(timeout=10)

    def test_cancel_waits_for_pid_publication_before_killing_the_worker(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        home = Path(self.tmp.name) / "home"
        jd = home / "jobs" / "starting"
        jd.mkdir(parents=True)
        gate, reached = Path(self.tmp.name) / "release", Path(self.tmp.name) / "publishing"
        worker_script = Path(self.tmp.name) / "worker.py"
        worker_script.write_text(textwrap.dedent("""\
            import importlib.util, sys, time
            from pathlib import Path
            spec = importlib.util.spec_from_file_location('runner', sys.argv[1])
            runner = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runner)
            job_dir, work, gate, reached = map(Path, sys.argv[2:])
            real_write = Path.write_text
            def delayed_write(path, text, *a, **kw):
                if path == job_dir / 'codex.pid':
                    real_write(reached, text)
                    deadline = time.monotonic() + 10
                    while not gate.exists() and time.monotonic() < deadline:
                        time.sleep(.01)
                    if not gate.exists():
                        raise RuntimeError('test barrier timed out')
                return real_write(path, text, *a, **kw)
            Path.write_text = delayed_write
            parser = runner.Parser()
            runner.add_task_arguments(parser)
            args = parser.parse_args(['--cwd', str(work), '--sandbox', 'danger-full-access'])
            runner.execute(args, 'do it', job_dir)
            """), "utf-8")
        worker = subprocess.Popen([sys.executable, "-B", str(worker_script), str(RUNNER), str(jd),
                                   str(self.cwd), str(gate), str(reached)],
                                  env={**self.env, "FAKE_MODE": "hang_with_child"},
                                  start_new_session=os.name != "nt", creationflags=codex_runner.NO_WINDOW,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        codex_runner.record_pid(jd / "worker.pid", worker.pid)
        cancel = None
        child = None
        try:
            deadline = time.monotonic() + 5
            while not reached.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(reached.exists())
            child = int(reached.read_text())
            cancel = subprocess.Popen([sys.executable, "-B", str(RUNNER), "cancel", "starting"],
                                      env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(.2)
            self.assertIsNone(cancel.poll(), "cancel must wait for the startup lock")
            self.assertTrue(alive(worker.pid))
            gate.write_text("go")
            stdout, stderr = cancel.communicate(timeout=20)
            self.assertEqual(cancel.returncode, 0, stderr.decode())
            self.assertEqual(json.loads(stdout)["status"], "cancelled")
            worker.wait(timeout=10)
            self.assertFalse(alive(child))
        finally:
            gate.touch()
            for proc in (cancel, worker):
                if proc is not None:
                    if alive(proc.pid):
                        if proc is worker:
                            codex_runner.kill_tree(proc.pid)
                        else:
                            proc.kill()
                    proc.wait(timeout=10)
                    for pipe in (proc.stdout, proc.stderr):
                        if pipe is not None:
                            pipe.close()
            if child is not None:
                codex_runner.kill_tree(child)

    def test_symlink_cwd_reports_one_change_for_relative_and_absolute_scopes(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        alias = Path(self.tmp.name) / "alias"
        try:
            alias.symlink_to(self.cwd, target_is_directory=True)
        except OSError as e:
            if os.name == "nt":
                self.skipTest(f"directory symlink is unavailable: {e}")
            raise
        (self.cwd / "keep").mkdir()
        target = self.cwd / "keep" / "a.txt"
        home = Path(self.tmp.name) / "home"
        with mock.patch.object(codex_runner, "HOME", home):
            self.assertEqual(codex_runner.tree_key(str(alias)), codex_runner.tree_key(str(self.cwd)))
            codex_runner.remember_too_big(str(alias))
        for scope in ("keep", str(alias / "keep"), str(self.cwd / "keep"),
                      "keep/a.txt", str(alias / "keep" / "a.txt"), str(target)):
            with self.subTest(scope=scope):
                target.unlink(missing_ok=True)
                result = self.invoke("--cwd", str(alias), "--sandbox", "danger-full-access", "--scope", scope,
                                     mode="scoped_write")
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["cwd"], os.path.realpath(self.cwd))
                self.assertEqual(result["scope_paths"], [os.path.realpath(codex_runner.scope_path(str(alias), scope))])
                expected = [{"path": "keep/a.txt", "change": "added"},
                            {"path": "other.txt", "change": "update"}]
                self.assertEqual(result["files_changed"], expected)
                self.assertEqual(result["files_changed_total"], 2)

    def test_writable_roots_round_trip_through_run_and_start(self):
        roots = [r"E:\task data\密钥", "E:/task-output", str(self.cwd / "extra")]
        expected = roots if os.name == "nt" else ["/mnt/e/task data/密钥", "/mnt/e/task-output", roots[2]]
        for command in ("run", "start"):
            for resume in ([], ["--resume", "writer-9"]):
                with self.subTest(command=command, resume=bool(resume)):
                    result = self.invoke("--sandbox", "workspace-write", *resume,
                                         "--writable-root", roots[0], "--writable-root", roots[1],
                                         "--writable-root", roots[2], command=command)
                    if command == "start":
                        args_file = Path(self.tmp.name) / "home" / "jobs" / result["job_id"] / "args.json"
                        self.assertEqual(json.loads(args_file.read_text("utf-8"))["writable_roots"], roots)
                        result = self.control("status", result["job_id"], "--wait", "30")
                    self.assertEqual(result["status"], "completed")
                    argv = self.calls()[-1]["argv"]
                    overrides = [p for p in argv if p.startswith("sandbox_workspace_write.writable_roots=")]
                    self.assertEqual(len(overrides), 1)
                    self.assertEqual(json.loads(overrides[0].split("=", 1)[1]), expected)
                    self.assertEqual(argv[argv.index(overrides[0]) - 1], "-c")
                    self.assertNotIn("--add-dir", argv)
                    self.assertEqual("resume" in argv, bool(resume))
                    if resume:
                        self.assertIn("writer-9", argv)

    def test_writable_roots_do_not_override_other_sandbox_modes(self):
        sys.path.insert(0, str(RUNNER.parent))
        import argparse
        import codex_runner

        for sandbox in ("read-only", "danger-full-access"):
            for thread_id in (None, "writer-9"):
                with self.subTest(sandbox=sandbox, thread_id=thread_id):
                    args = argparse.Namespace(use_user_config=True, model=None, effort=None, sandbox=sandbox,
                                              schema=None, writable_roots=["E:/task-output"])
                    cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), thread_id)
                    self.assertFalse(any("sandbox_workspace_write.writable_roots" in p for p in cmd))
                    self.assertIn(f'sandbox_mode="{sandbox}"', cmd)
                    self.assertEqual("--ephemeral" in cmd, sandbox == "read-only")

    def test_omitted_writable_roots_preserve_config_and_old_jobs(self):
        sys.path.insert(0, str(RUNNER.parent))
        import argparse
        import codex_runner

        args = argparse.Namespace(use_user_config=True, model=None, effort=None, sandbox="workspace-write", schema=None)
        for roots in ("missing", None, []):
            if roots != "missing":
                args.writable_roots = roots
            for thread_id in (None, "writer-9"):
                with self.subTest(roots=roots, thread_id=thread_id):
                    cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), thread_id)
                    self.assertFalse(any("sandbox_workspace_write.writable_roots" in p for p in cmd))

    def test_transient_failure_on_reader_restarts_fresh(self):
        r = self.invoke(mode="transient_then_ok")
        self.assertEqual(r["attempts"], 2)
        self.assertNotIn("resume", self.calls()[1]["argv"])
        self.assertEqual(self.calls()[1]["prompt"], "do it")

    def test_reader_retry_after_resume_does_not_claim_thread_total_usage(self):
        r = self.invoke("--resume", "writer-9", mode="transient_then_ok")
        self.assertEqual(r["attempts"], 2)
        self.assertNotIn("resume", self.calls()[1]["argv"])
        self.assertNotIn("usage_scope", r)

    def test_permanent_failure_is_not_retried(self):
        r = self.invoke(mode="permanent")
        self.assertEqual(r["error_kind"], "permanent")
        self.assertEqual(r["attempts"], 1)
        self.assertFalse(r["retryable"])
        self.assertIsNone(r["thread_id"])

    def test_configured_router_reaches_http_and_preserves_other_proxy_settings(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        route = 'http://127.0.0.1:3426/v1'
        args = SimpleNamespace(use_user_config=True, model=None, effort=None, service_tier='fast',
                               sandbox='danger-full-access', schema=None)
        proxy = {'NO_PROXY': 'internal.example', 'HTTPS_PROXY': 'http://proxy.example:8080'}
        if os.name != 'nt':
            proxy['no_proxy'] = 'other.example'
        with mock.patch.dict(os.environ, {
            'CODEX_RUNNER_ROUTER_URL': '', 'CODEX_RUNNER_ROUTE_PROVIDER': 'gateway', 'CODEX_RUNNER_ROUTE_URL': route,
            **proxy,
        }), mock.patch.object(codex_runner.http.client, 'HTTPConnection') as connect:
            self.assertTrue(codex_runner.router_reachable())
            connect.return_value.request.assert_called_once_with('HEAD', '/')
            connect.return_value.getresponse.side_effect = codex_runner.http.client.RemoteDisconnected()
            self.assertFalse(codex_runner.router_reachable())
            for thread_id in (None, 'THREAD'):
                argv, env = codex_runner.build_command(args, Path(self.tmp.name), thread_id)
                self.assertIn('model_provider="gateway"', argv)
                self.assertIn('model_providers.gateway.base_url=' + json.dumps(route), argv)
                self.assertIn('service_tier="fast"', argv)
                self.assertIn('sandbox_mode="danger-full-access"', argv)
                self.assertEqual(env['NO_PROXY'], 'internal.example,127.0.0.1')
                if os.name != 'nt':
                    self.assertEqual(env['no_proxy'], 'other.example,127.0.0.1')
                self.assertEqual(env['HTTPS_PROXY'], 'http://proxy.example:8080')

    def test_router_down_never_spawns_codex(self):
        r = self.invoke("--retries", "0", env={"CODEX_RUNNER_ROUTER_URL": "http://127.0.0.1:9/x"})
        self.assertEqual(r["error_kind"], "router_down")
        self.assertEqual(self.calls(), [])

    def test_prompt_with_shell_metacharacters_arrives_intact(self):
        prompt = '修复 A&B|C %PATH% "引号" ^caret\n第二行 $(whoami) `tick`'
        self.invoke(prompt=prompt)
        self.assertEqual(self.calls()[0]["prompt"], prompt)
        self.assertEqual(self.calls()[0]["argv"][-1], "-")

    def test_full_access_runs_as_a_writer(self):
        r = self.invoke("--sandbox", "danger-full-access", mode="transient_then_ok")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["thread_id"], "thread-1")
        first, second = self.calls()
        self.assertIn("resume", second["argv"])
        self.assertIn("thread-1", second["argv"])
        for call in (first, second):
            self.assertIn('sandbox_mode="danger-full-access"', call["argv"])
            self.assertNotIn("--ephemeral", call["argv"])

    def test_second_writer_in_same_directory_waits_then_completes(self):
        jobs = []
        try:
            first = self.invoke("--sandbox", "danger-full-access", command="start", mode="gated_ok", prompt="one")
            jobs.append(first["job_id"])
            self.wait_for(lambda: (self.state / "ready-0").exists())
            second = self.invoke("--sandbox", "danger-full-access", command="start", mode="gated_ok", prompt="two")
            jobs.append(second["job_id"])
            self.wait_for(lambda: self.control("status", second["job_id"]).get("phase") == "lock_wait")
            waiting = self.control("status", second["job_id"])
            self.assertEqual((waiting["status"], waiting["phase"], waiting["attempt"]), ("running", "lock_wait", 0))
            self.assertEqual([call["prompt"] for call in self.calls()], ["one"])
            self.assertEqual(self.control("status", first["job_id"])["status"], "running")
            second_dir = Path(self.env["CODEX_RUNNER_HOME"]) / "jobs" / second["job_id"]
            self.assertFalse((second_dir / "codex.pid").exists())
            (self.state / "release-0").touch()
            self.assertEqual(self.control("status", first["job_id"], "--wait", "20")["status"], "completed")
            self.wait_for(lambda: (self.state / "ready-1").exists())
            (self.state / "release-1").touch()
            self.assertEqual(self.control("status", second["job_id"], "--wait", "20")["status"], "completed")
            self.assertEqual([call["prompt"] for call in self.calls()], ["one", "two"])
        finally:
            for job_id in reversed(jobs):
                self.control("cancel", job_id)

    def test_cancel_waiting_writer_does_not_cancel_owner_or_start_a_model(self):
        jobs = []
        try:
            first = self.invoke("--sandbox", "danger-full-access", command="start", mode="gated_ok", prompt="one")
            jobs.append(first["job_id"])
            self.wait_for(lambda: (self.state / "ready-0").exists())
            second = self.invoke("--sandbox", "danger-full-access", command="start", mode="gated_ok", prompt="two")
            jobs.append(second["job_id"])
            self.wait_for(lambda: self.control("status", second["job_id"]).get("phase") == "lock_wait")
            waiting = self.control("status", second["job_id"])
            self.assertEqual((waiting["status"], waiting["phase"], waiting["attempt"]), ("running", "lock_wait", 0))
            second_dir = Path(self.env["CODEX_RUNNER_HOME"]) / "jobs" / second["job_id"]
            worker_pid = int((second_dir / "worker.pid").read_text())
            self.assertFalse((second_dir / "codex.pid").exists())
            cancelled = self.control("cancel", second["job_id"])
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual(cancelled["phase"], "lock_wait")
            self.wait_for(lambda: not alive(worker_pid))
            self.assertEqual(self.control("status", first["job_id"])["status"], "running")
            self.assertEqual([call["prompt"] for call in self.calls()], ["one"])
            (self.state / "release-0").touch()
            self.assertEqual(self.control("status", first["job_id"], "--wait", "20")["status"], "completed")
            self.assertEqual(self.control("status", second["job_id"])["status"], "cancelled")
            self.assertFalse((second_dir / "codex.pid").exists())
            self.assertEqual([call["prompt"] for call in self.calls()], ["one"])
        finally:
            for job_id in reversed(jobs):
                self.control("cancel", job_id)

    def test_writers_in_different_directories_share_the_writable_root_lock(self):
        shared = Path(self.tmp.name) / "shared"
        other = Path(self.tmp.name) / "other-work"
        shared.mkdir()
        other.mkdir()
        jobs = []
        try:
            first = self.invoke("--sandbox", "workspace-write", "--writable-root", str(shared),
                                "--writable-root", str(shared / "."), command="start", mode="gated_ok", prompt="one")
            jobs.append(first["job_id"])
            self.wait_for(lambda: (self.state / "ready-0").exists())
            second = self.invoke("--cwd", str(other), "--sandbox", "workspace-write", "--writable-root", "../shared",
                                 command="start", mode="gated_ok", prompt="two")
            jobs.append(second["job_id"])
            self.wait_for(lambda: self.control("status", second["job_id"]).get("phase") == "lock_wait")
            self.assertEqual([call["prompt"] for call in self.calls()], ["one"])
            (self.state / "release-0").touch()
            self.assertEqual(self.control("status", first["job_id"], "--wait", "20")["status"], "completed")
            self.wait_for(lambda: (self.state / "ready-1").exists())
            (self.state / "release-1").touch()
            self.assertEqual(self.control("status", second["job_id"], "--wait", "20")["status"], "completed")
            self.assertEqual([call["prompt"] for call in self.calls()], ["one", "two"])
        finally:
            for job_id in reversed(jobs):
                self.control("cancel", job_id)

    def test_waiting_for_a_writable_root_releases_partial_locks(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        held = mock.Mock()
        error = OSError(errno.EIO, "injected lock error")
        args = SimpleNamespace(cwd=str(self.cwd), sandbox="workspace-write", writable_roots=["../shared"])
        with mock.patch.object(codex_runner, "acquire_write_lock", side_effect=[held, None, error]), \
                mock.patch.object(codex_runner.time, "sleep", side_effect=lambda delay: held.close.assert_called_once()), \
                mock.patch.object(codex_runner, "run_attempt") as attempt:
            result = codex_runner.execute(args, "do it", Path(self.tmp.name) / "waiting")
        self.assertEqual(result["error_kind"], "runner_error")
        held.close.assert_called_once()
        attempt.assert_not_called()

    def test_file_lock_only_treats_contention_errors_as_busy(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        locking = codex_runner.msvcrt if os.name == "nt" else codex_runner.fcntl
        operation = "locking" if os.name == "nt" else "flock"
        for error in (errno.EACCES, errno.EAGAIN, errno.EIO):
            with self.subTest(errno=error), mock.patch.object(locking, operation, side_effect=OSError(error, "injected lock error")):
                path = Path(self.tmp.name) / "injected.lock"
                if error in (errno.EACCES, errno.EAGAIN):
                    self.assertIsNone(codex_runner.acquire_file_lock(path))
                else:
                    with self.assertRaises(OSError) as raised:
                        codex_runner.acquire_file_lock(path)
                    self.assertEqual(raised.exception.errno, error)

    def test_execute_returns_structured_failure_for_lock_io_errors(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for waiting in (False, True):
            with self.subTest(waiting=waiting):
                error = OSError(errno.EIO, "injected lock I/O error")
                outcomes = [None, error] if waiting else [error]
                args = SimpleNamespace(cwd=str(self.cwd), sandbox="danger-full-access")
                run_dir = Path(self.tmp.name) / f"lock-error-{waiting}"
                with mock.patch.object(codex_runner, "acquire_write_lock", side_effect=outcomes) as acquire, \
                        mock.patch.object(codex_runner, "run_attempt") as attempt, \
                        mock.patch.object(codex_runner, "snapshot_before") as snapshot, \
                        mock.patch.object(codex_runner.time, "sleep"):
                    result = codex_runner.execute(args, "do it", run_dir)
                self.assertEqual({key: result[key] for key in ("status", "error_kind", "retryable", "attempts", "error")},
                                 {"status": "failed", "error_kind": "runner_error", "retryable": False,
                                  "attempts": 0, "error": str(error)})
                self.assertEqual(acquire.call_count, len(outcomes))
                attempt.assert_not_called()
                snapshot.assert_not_called()

    def test_writer_lock_serializes_windows_path_case_aliases(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        paths = [r"F:\Work\Project", r"f:\work\project"]
        if os.name != "nt":
            paths += ["/mnt/f/work/PROJECT", "/mnt/F/WORK/Project"]
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            lock = codex_runner.acquire_write_lock(paths[0])
            self.assertIsNotNone(lock)
            with lock:
                for alias in paths[1:]:
                    with self.subTest(alias=alias):
                        self.assertIsNone(codex_runner.acquire_write_lock(alias))

    def test_writer_lock_serializes_symlink_aliases(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        alias = Path(self.tmp.name) / "alias"
        try:
            alias.symlink_to(self.cwd, target_is_directory=True)
        except OSError as e:
            if os.name == "nt":
                self.skipTest(f"directory symlink is unavailable: {e}")
            raise
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            with codex_runner.acquire_write_lock(str(self.cwd)):
                self.assertIsNone(codex_runner.acquire_write_lock(str(alias)))

    @unittest.skipIf(os.name == "nt", "native Linux paths are case-sensitive")
    def test_writer_lock_keeps_native_linux_paths_case_sensitive(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            for path in (str(self.cwd / "Project"), "/mnt/data/Project"):
                with self.subTest(path=path):
                    with codex_runner.acquire_write_lock(path):
                        other = codex_runner.acquire_write_lock(path.lower())
                        self.assertIsNotNone(other)
                        other.close()

    def test_stdin_errors_return_spawn_failed_and_clean_up(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for operation in ("write", "close"):
            for error_type in (BrokenPipeError, OSError):
                with self.subTest(operation=operation, error=error_type.__name__):
                    proc = mock.Mock(pid=123)
                    proc.stdout = mock.MagicMock()
                    proc.stdout.__iter__.return_value = iter(())
                    getattr(proc.stdin, operation).side_effect = error_type("stdin failed")
                    with mock.patch.dict(os.environ, self.env), \
                            mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                            mock.patch.object(sys, "argv", [str(RUNNER), "run", "--cwd", str(self.cwd)]), \
                            mock.patch.object(sys, "stdout", new_callable=io.StringIO) as output, \
                            mock.patch.object(codex_runner, "read_prompt", return_value="do it"), \
                            mock.patch.object(codex_runner.subprocess, "Popen", return_value=proc) as popen, \
                            mock.patch.object(codex_runner, "kill_tree") as kill:
                        with self.assertRaises(SystemExit) as stopped:
                            codex_runner.main()
                        self.assertEqual(stopped.exception.code, 1)
                        result = json.loads(output.getvalue())
                        self.assertEqual(result["status"], "failed")
                        self.assertEqual(result["error_kind"], "spawn_failed")
                        self.assertEqual(result["error"], "stdin failed")
                        self.assertFalse(result["retryable"])
                        self.assertEqual(result["attempts"], 1)
                        popen.assert_called_once()
                        kill.assert_called_once_with(proc.pid)
                        proc.wait.assert_called_once_with(timeout=10)
                        proc.stdin.close.assert_called()
                        proc.stdout.close.assert_called_once_with()
                        self.assertTrue(popen.call_args.kwargs["stderr"].closed)

    def test_timeout_cleanup_does_not_wait_indefinitely_for_pipe_threads(self):
        sys.path.insert(0, str(RUNNER.parent))
        import argparse
        import codex_runner

        proc = mock.Mock(pid=123)
        proc.wait.side_effect = subprocess.TimeoutExpired("fake", 10)
        reader, writer = mock.Mock(), mock.Mock()
        args = argparse.Namespace(cwd=str(self.cwd), sandbox="read-only", use_user_config=True,
                                  model=None, effort=None, schema=None, timeout=-1,
                                  idle_timeout=30, reconnect_timeout=30, exit_grace=1)
        with mock.patch.object(codex_runner.subprocess, "Popen", return_value=proc), \
                mock.patch.object(codex_runner.threading, "Thread", side_effect=[reader, writer]), \
                mock.patch.object(codex_runner, "kill_tree") as kill:
            result = codex_runner.run_attempt(args, "large prompt", Path(self.tmp.name), None)
        self.assertEqual(result["end_reason"], "timeout")
        self.assertEqual(kill.call_args_list, [mock.call(proc.pid), mock.call(proc.pid)])
        proc.wait.assert_called_once_with(timeout=10)
        for thread in (reader, writer):
            thread.join.assert_called_once_with(timeout=1)
        proc.stdin.close.assert_not_called()
        proc.stdout.close.assert_not_called()

    def control(self, *args):
        p = subprocess.run([sys.executable, "-B", str(RUNNER), *args], capture_output=True, timeout=60, env=self.env)
        return json.loads(p.stdout.decode("utf-8"))

    def test_start_outlives_the_caller_and_status_returns_the_result(self):
        job = self.invoke(command="start", mode="slow_ok")
        self.assertEqual(job["status"], "running")
        self.assertEqual(self.control("status", job["job_id"])["status"], "running")
        done = self.control("status", job["job_id"], "--wait", "30")
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["final_message"], "done")

    def test_cancel_kills_the_worker_and_the_tree(self):
        context = self.sample_context()
        envelope = json.dumps({"prompt": "do it", "context": context})
        job = self.invoke("--context-json", "--sandbox", "danger-full-access", "--scope", "keep",
                          command="start", mode="hang_with_child", prompt=envelope)
        child = self.state / "child.pid"
        for _ in range(40):
            if child.exists():
                break
            time.sleep(0.25)
        cancelled = self.control("cancel", job["job_id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["context"], context)
        self.assertEqual(cancelled["thread_id"], "thread-1")
        self.assertEqual(cancelled["sandbox"], "danger-full-access")
        self.assertEqual(cancelled["scope"], ["keep"])
        self.assertIsInstance(cancelled["duration_s"], (int, float))
        self.assertNotIn("files_changed", cancelled)
        time.sleep(1)
        self.assertFalse(alive(int(child.read_text())))

    def test_cancel_preserves_a_result_published_during_killing(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        home = Path(self.tmp.name) / "home"
        job_dir = home / "jobs" / "raced"
        job_dir.mkdir(parents=True)
        (job_dir / "worker.pid").write_text("123")
        (job_dir / "codex.pid").write_text("456")
        (job_dir / "worker.start").write_text("worker-start")
        (job_dir / "codex.start").write_text("codex-start")
        completed = {"status": "completed", "final_message": "done", "usage": {"input_tokens": 1}}
        for finishing_pid in (123, 456):
            with self.subTest(finishing_pid=finishing_pid):
                (job_dir / "result.json").unlink(missing_ok=True)
                killed = []

                def finish_during_kill(pid):
                    killed.append(pid)
                    if pid == finishing_pid:
                        codex_runner.write_result(job_dir, completed)

                def start(pid):
                    # Killing the worker can let init reap its already-exited Codex leader.
                    return "worker-start" if pid == 123 else (None if 123 in killed else "codex-start")

                with mock.patch.object(codex_runner, "HOME", home), \
                        mock.patch.object(codex_runner, "process_start", side_effect=start), \
                        mock.patch.object(sys, "argv", [str(RUNNER), "cancel", "raced"]), \
                        mock.patch.object(codex_runner, "kill_tree", side_effect=finish_during_kill) as kill, \
                        mock.patch.object(codex_runner, "emit") as emit:
                    codex_runner.main()
                    self.assertEqual(kill.call_args_list, [mock.call(456), mock.call(123)])
                    emit.assert_called_once()
                    published = emit.call_args.args[0]
                    self.assertEqual({k: published[k] for k in completed}, completed)
                    self.assertEqual(published["job_id"], "raced")
                    self.assertIn("review_status", published)
                    self.assertNotIn("review_summary", published)
                    saved = json.loads((job_dir / "result.json").read_text("utf-8"))
                    self.assertEqual({k: saved[k] for k in completed}, completed)

    def test_status_and_cancel_check_process_start_within_the_same_boot(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for reused in (123, 456):
            with self.subTest(reused=reused):
                jd = self.stored_job(f"reused-{reused}", None)
                (jd / "worker.pid").write_text("123")
                (jd / "codex.pid").write_text("456")
                (jd / "worker.start").write_text("original-123")
                (jd / "codex.start").write_text("original-456")
                (jd / "boot_id").write_text("same-boot")
                start = lambda pid: "reused" if pid == reused else f"original-{pid}"
                with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                        mock.patch.object(codex_runner, "boot_id", return_value="same-boot"), \
                        mock.patch.object(codex_runner, "process_start", side_effect=start), \
                        mock.patch.object(codex_runner, "kill_tree") as kill, \
                        mock.patch.object(sys, "argv", [str(RUNNER), "cancel", jd.name]), \
                        mock.patch.object(codex_runner, "emit") as emit:
                    status = codex_runner.job_status(jd.name)
                    self.assertEqual(status["status"], "failed" if reused == 123 else "running")
                    codex_runner.main()
                    self.assertEqual(kill.call_args_list, [mock.call(456 if reused == 123 else 123)])
                    self.assertEqual(emit.call_args.args[0]["status"], "failed" if reused == 123 else "cancelled")

    def test_cancel_during_retry_wait_has_no_stale_codex_pid(self):
        job = self.invoke("--sandbox", "workspace-write", "--backoff", "30", command="start", mode="transient_then_ok")
        try:
            self.wait_for(lambda: self.control("status", job["job_id"]).get("phase") == "retry_wait")
            jd = Path(self.env["CODEX_RUNNER_HOME"]) / "jobs" / job["job_id"]
            self.assertFalse((jd / "codex.pid").exists())
            self.assertFalse((jd / "codex.start").exists())
            self.assertEqual(self.control("cancel", job["job_id"])["status"], "cancelled")
            self.wait_for(lambda: not alive(int((jd / "worker.pid").read_text())))
            self.assertEqual(len(self.calls()), 1)
        finally:
            self.control("cancel", job["job_id"])

    @unittest.skipIf(os.name == "nt", "requires POSIX process-group inheritance")
    def test_cancel_during_retry_wait_kills_child_in_exited_launchers_group(self):
        job = self.invoke("--sandbox", "workspace-write", "--backoff", "60", command="start",
                          mode="transient_with_inherited_group_child")
        child_file = self.state / "child.pid"
        try:
            self.wait_for(lambda: self.control("status", job["job_id"]).get("phase") == "retry_wait")
            child = int(child_file.read_text())
            self.assertEqual(self.control("cancel", job["job_id"])["status"], "cancelled")
            jd = Path(self.env["CODEX_RUNNER_HOME"]) / "jobs" / job["job_id"]
            self.wait_for(lambda: not alive(int((jd / "worker.pid").read_text())))
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(alive(child), "cancelled retry left a child in the exited launcher's process group")
        finally:
            try:
                self.control("cancel", job["job_id"])
            finally:
                if child_file.exists():
                    child = int(child_file.read_text())
                    try:
                        os.kill(child, 9)
                    except ProcessLookupError:
                        pass
                    self.wait_for(lambda: not alive(child))
                    child_file.unlink()

    def test_successful_task_preserves_child_in_exited_launchers_group(self):
        child_file = self.state / "child.pid"
        try:
            result = self.invoke("--sandbox", "workspace-write", mode="success_with_inherited_group_child")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["final_message"], "done")
            self.assertFalse(result["forced_exit"])
            self.assertTrue(alive(int(child_file.read_text())), "successful task killed its background child")
        finally:
            if child_file.exists():
                child = int(child_file.read_text())
                try:
                    os.kill(child, 9)
                except ProcessLookupError:
                    pass
                self.wait_for(lambda: not alive(child))
                child_file.unlink()

    def test_windows_cwd_is_mapped_only_inside_wsl(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        windows = r"F:\work\测试项目"
        expected = windows if os.name == "nt" else "/mnt/f/work/测试项目"
        self.assertEqual(codex_runner.local_path(windows), expected)
        self.assertEqual(codex_runner.local_path("/mnt/f/x"), "/mnt/f/x")

    def test_running_status_reports_the_last_codex_activity(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        events = Path(self.tmp.name) / "events.jsonl"
        item = lambda t, kind, **kw: json.dumps({"type": t, "item": {"type": kind, **kw}})
        events.write_text("\n".join([
            item("item.completed", "agent_message", text="plan"),
            item("item.completed", "command_execution", command="/usr/bin/sh -c pytest -q", exit_code=0),
            item("item.completed", "reasoning", text="thinking"),
            "not json",
        ]), "utf-8")
        self.assertEqual(codex_runner.last_activity(events), "ran: pytest -q (exit 0)")
        with events.open("a", encoding="utf-8") as f:
            f.write("\n" + item("item.started", "file_change", changes=[{"path": "/mnt/d/x/a.ps1"}]))
        self.assertEqual(codex_runner.last_activity(events), "editing: a.ps1")

    def test_runner_phase_cache_avoids_event_scans_and_legacy_logs_still_work(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        events = self.cwd / "events.jsonl"
        codex_runner.runner_event(self.cwd, 2, "retry_wait", "transient", 1234)
        with events.open("ab") as f:
            f.write(b'{"type":"item.updated"}\n' * 10000)
        expected = {"phase": "retry_wait", "attempt": 2, "last_error_kind": "transient", "retry_at": 1234}
        with mock.patch("builtins.open", side_effect=AssertionError("scanned the full events log")):
            self.assertEqual(codex_runner.runner_activity(events), expected)
        (self.cwd / "phase.json").unlink()
        self.assertEqual(codex_runner.runner_activity(events), expected)
        (self.cwd / "phase.json").write_text("interrupted cache write")
        self.assertEqual(codex_runner.runner_activity(events), expected)

    def test_model_effort_and_fast_mode_reach_codex(self):
        sys.path.insert(0, str(RUNNER.parent))
        import argparse
        import codex_runner

        args = argparse.Namespace(use_user_config=False, model="some-model", effort="max", service_tier="fast",
                                  sandbox="workspace-write", schema=None)
        cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), None)
        self.assertIn("some-model", cmd)
        self.assertIn('model_reasoning_effort="max"', cmd)
        self.assertIn('service_tier="fast"', cmd)
        del args.service_tier
        cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), None)
        self.assertFalse(any("service_tier" in part for part in cmd))

    def test_omitted_effort_leaves_codex_config_in_control(self):
        for command in ("run", "start"):
            with self.subTest(command=command):
                result = self.invoke(command=command)
                if command == "start":
                    result = self.control("status", result["job_id"], "--wait", "30")
                self.assertEqual(result["status"], "completed")
                self.assertFalse(any("model_reasoning_effort" in part for part in self.calls()[-1]["argv"]))

    def test_user_mcp_servers_are_disabled_one_by_one(self):
        sys.path.insert(0, str(RUNNER.parent))
        import argparse
        import codex_runner

        home = Path(self.tmp.name) / "codex-home"
        home.mkdir()
        (home / "config.toml").write_text('[mcp_servers.alpha]\ncommand = "a"\n\n[mcp_servers."a b"]\ncommand = "b"\n\n[mcp_servers."my.server"]\ncommand = "c"\n')
        args = argparse.Namespace(use_user_config=False, model=None, effort="medium", sandbox="read-only", schema=None)
        with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
            cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), None)
            mcp = [part for part in cmd if "mcp_servers" in part]
            self.assertEqual(mcp, ["mcp_servers.alpha.enabled=false", "mcp_servers.a b.enabled=false"])
            self.assertEqual(cmd[cmd.index(mcp[0]) - 1], "-c")
            self.assertIn("hooks", cmd)
            args.use_user_config = True
            cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), None)
            self.assertFalse(any("mcp_servers" in part for part in cmd))
            args.use_user_config = False
            (home / "config.toml").write_text("not = [valid toml")
            cmd, _ = codex_runner.build_command(args, Path(self.tmp.name), None)
            self.assertFalse(any("mcp_servers" in part for part in cmd))

    def test_writer_changes_come_from_a_snapshot_diff_or_codex_events(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        root = Path(self.tmp.name) / "ws"
        (root / "keep").mkdir(parents=True)
        (root / "keep" / "a.txt").write_text("a")
        (root / "old.txt").write_text("old")
        (root / ".git").mkdir()
        before = codex_runner.snapshot(str(root))
        (root / "keep" / "a.txt").write_text("changed by a shell command")
        (root / "new.txt").write_text("n")
        (root / "old.txt").unlink()
        (root / ".git" / "index").write_text("ignored")
        report = codex_runner.files_changed(str(root), before, [])
        self.assertEqual(report["files_changed_source"], "snapshot")
        self.assertEqual(report["files_changed"], [{"path": "keep/a.txt", "change": "modified"},
                                                   {"path": "new.txt", "change": "added"},
                                                   {"path": "old.txt", "change": "deleted"}])
        # A tree too large to walk in time falls back to what Codex itself reported.
        events = [(str(root / "keep" / "a.txt"), "update"), (str(root / "keep" / "a.txt"), "update")]
        report = codex_runner.files_changed(str(root), None, events)
        self.assertEqual(report["files_changed_source"], "codex_events")
        self.assertEqual(report["files_changed"], [{"path": "keep/a.txt", "change": "update"}])
        self.assertIsNone(codex_runner.snapshot(str(root), budget=-1))

    @unittest.skipIf(os.name == "nt", "Windows chmod does not expose Unix executable bits")
    def test_snapshot_reports_permission_only_changes(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        script = self.cwd / "tool.sh"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o644)
        before = codex_runner.snapshot(str(self.cwd))
        script.chmod(0o755)
        self.assertEqual(before["tool.sh"][:2], codex_runner.snapshot(str(self.cwd))["tool.sh"][:2])
        report = codex_runner.files_changed(str(self.cwd), before, [(str(script), "update")])
        self.assertEqual(report["files_changed"], [{"path": "tool.sh", "change": "modified"}])

    def test_snapshot_budget_covers_flat_directories_and_scoped_files(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        first = self.cwd / "a.txt"
        first.write_text("a")
        (self.cwd / "b.txt").write_text("b")
        real_stat = os.stat
        for scope in (None, [str(first)]):
            with self.subTest(scope=scope):
                clock = [0]
                scanned = []

                def slow_stat(path, *args, **kwargs):
                    if kwargs.get("follow_symlinks") is False:
                        scanned.append(path)
                        clock[0] += 2
                    return real_stat(path, *args, **kwargs)

                with mock.patch.object(codex_runner.time, "monotonic", side_effect=lambda: clock[0]), \
                        mock.patch.object(codex_runner.os, "stat", side_effect=slow_stat):
                    self.assertIsNone(codex_runner.snapshot(str(self.cwd), budget=1, scope=scope))
                self.assertEqual(len(scanned), 1)

    def test_snapshot_budget_ignores_wall_clock_jumps(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        (self.cwd / "a.txt").write_text("a")
        with mock.patch.object(codex_runner.time, "time", side_effect=range(0, 360000, 3600)):
            self.assertIn("a.txt", codex_runner.snapshot(str(self.cwd)))

    def test_snapshot_stat_errors_fall_back_to_events_instead_of_reporting_deletion(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        path = self.cwd / "a.txt"
        path.write_text("still exists")
        before = codex_runner.snapshot(str(self.cwd))
        # files_changed 先 realpath 根目录；Windows CI 的临时目录是 8.3 短路径，须按展开后的路径匹配。
        target = os.path.normcase(os.path.realpath(path))
        real_stat = os.stat
        for failure in (PermissionError(errno.EACCES, "denied"), OSError(errno.EIO, "I/O failure")):
            with self.subTest(error=type(failure).__name__):
                def fail_stat(p, *args, **kwargs):
                    if os.path.normcase(os.fspath(p)) == target:
                        raise failure
                    return real_stat(p, *args, **kwargs)
                with mock.patch.object(codex_runner.os, "stat", side_effect=fail_stat):
                    report = codex_runner.files_changed(str(self.cwd), before, [(str(path), "update")])
                self.assertEqual(report["files_changed_source"], "codex_events")
                self.assertEqual(report["files_changed"], [{"path": "a.txt", "change": "update"}])

    def test_snapshot_walk_errors_fall_back_to_events_instead_of_reporting_deletion(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        folder = self.cwd / "blocked"
        folder.mkdir()
        path = folder / "a.txt"
        path.write_text("still exists")
        before = codex_runner.snapshot(str(self.cwd))
        target = os.path.normcase(os.path.realpath(folder))
        real_scandir = os.scandir
        def fail_scandir(p):
            if os.path.normcase(os.fspath(p)) == target:
                raise PermissionError(errno.EACCES, "denied")
            return real_scandir(p)
        with mock.patch.object(codex_runner.os, "scandir", side_effect=fail_scandir):
            report = codex_runner.files_changed(str(self.cwd), before, [(str(path), "update")])
        self.assertEqual(report["files_changed_source"], "codex_events")
        self.assertEqual(report["files_changed"], [{"path": "blocked/a.txt", "change": "update"}])

    def big_tree(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        root = Path(self.tmp.name) / "ws"
        (root / "keep").mkdir(parents=True)
        (root / "keep" / "a.txt").write_text("a")
        (root / "single.txt").write_text("s")
        (root / "other.txt").write_text("o")
        home = mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home")
        home.start()
        self.addCleanup(home.stop)
        return codex_runner, root

    def test_tree_too_big_to_snapshot_is_remembered_and_skipped(self):
        codex_runner, root = self.big_tree()
        with mock.patch.object(codex_runner, "snapshot", return_value=None):
            self.assertEqual(codex_runner.snapshot_before(str(root), None), (None, None))
        with mock.patch.object(codex_runner.os, "walk", side_effect=AssertionError("walked a remembered tree")):
            self.assertEqual(codex_runner.snapshot_before(str(root), None), (None, None))

    def test_snapshot_io_failure_does_not_remember_a_tree_as_too_big(self):
        codex_runner, root = self.big_tree()
        real_stat = os.stat

        def fail_stat(path, *args, **kwargs):
            if kwargs.get("follow_symlinks") is False:
                raise OSError(errno.EIO, "temporary I/O failure")
            return real_stat(path, *args, **kwargs)

        with mock.patch.object(codex_runner.os, "stat", side_effect=fail_stat):
            self.assertEqual(codex_runner.snapshot_before(str(root), None), (None, None))
        self.assertNotIn(codex_runner.tree_key(str(root)), codex_runner.too_big_trees())
        before, scope = codex_runner.snapshot_before(str(root), None)
        self.assertIsNone(scope)
        self.assertIn("other.txt", before)

    @unittest.skipIf(os.name == "nt", "Windows-mounted path casing is tested inside WSL")
    def test_mounted_windows_paths_share_snapshot_and_history_keys(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            codex_runner.remember_too_big("/mnt/C/Work/Project")
            self.assertIn(codex_runner.tree_key("c:\\work\\PROJECT"), codex_runner.too_big_trees())
            self.assertEqual(codex_runner.write_lock_key("/mnt/c/work/project"),
                             codex_runner.write_lock_key("C:\\Work\\Project"))
            self.assertNotEqual(codex_runner.tree_key("/home/Project"), codex_runner.tree_key("/home/project"))
            self.stored_job("mixed-case", {"status": "completed", "cwd": "/mnt/C/Work/Project"})
            for command in ("list", "summary"):
                value = self.control(command, "--cwd", "c:\\work\\PROJECT")
                self.assertEqual(value.get("total_jobs", value["total"]), 1)
            value = {"cwd": "/mnt/c/WORK/project", "scope_paths": ["/mnt/C/work/PROJECT/Src"],
                     "files_changed": [{"path": "src/File.py"}, {"path": "src-other/File.py"}]}
            self.assertEqual(codex_runner.out_of_scope_paths(value), ["src-other/File.py"])

    def test_stale_too_big_entry_is_ignored(self):
        codex_runner, root = self.big_tree()
        codex_runner.HOME.mkdir(parents=True)
        (codex_runner.HOME / codex_runner.TOO_BIG_FILE).write_text(
            json.dumps({codex_runner.tree_key(str(root)): time.time() - 8 * 86400}))
        before, scope = codex_runner.snapshot_before(str(root), ["keep"])
        self.assertIsNone(scope)
        self.assertIn("other.txt", before)

    def test_scope_snapshot_catches_shell_writes_and_merges_events_outside_it(self):
        codex_runner, root = self.big_tree()
        codex_runner.remember_too_big(str(root))
        before, scope = codex_runner.snapshot_before(str(root), ["keep", str(root / "single.txt")])
        self.assertEqual(sorted(before), ["keep/a.txt", "single.txt"])
        (root / "keep" / "a.txt").write_text("changed by a shell command")
        (root / "keep" / "new.txt").write_text("n")
        (root / "single.txt").write_text("shell write to a scoped file")
        events = [(str(root / "other.txt"), "update"), ("keep/a.txt", "update"), (str(root / "single.txt"), "update")]
        report = codex_runner.files_changed(str(root), before, events, scope)
        self.assertEqual(report["files_changed_source"], "scope_snapshot+codex_events")
        self.assertEqual(report["files_changed"], [{"path": "keep/a.txt", "change": "modified"},
                                                   {"path": "keep/new.txt", "change": "added"},
                                                   {"path": "other.txt", "change": "update"},
                                                   {"path": "single.txt", "change": "modified"}])

    def test_full_snapshot_merges_events_outside_cwd_and_keeps_snapshot_precedence(self):
        codex_runner, root = self.big_tree()
        extra = Path(self.tmp.name) / "extra-output"
        extra.mkdir()
        before = codex_runner.snapshot(str(root))
        (root / "keep" / "a.txt").write_text("changed")
        (extra / "out.txt").write_text("outside cwd")
        events = [(str(extra / "out.txt"), "add"), ("../extra-output/out.txt", "update"),
                  ("keep/a.txt", "update"), ("other.txt", "update")]
        report = codex_runner.files_changed(str(root), before, events)
        self.assertEqual(report["files_changed_source"], "snapshot+codex_events")
        self.assertEqual(report["files_changed_total"], 2)
        self.assertEqual(report["files_changed"], [{"path": "../extra-output/out.txt", "change": "add"},
                                                 {"path": "keep/a.txt", "change": "modified"}])
        self.assertEqual(codex_runner.out_of_scope_paths({"cwd": str(root), "scope_paths": [str(root)], **report}),
                         ["../extra-output/out.txt"])

    def test_scope_with_backslashes_is_a_relative_directory(self):
        codex_runner, root = self.big_tree()
        codex_runner.remember_too_big(str(root))
        (root / "keep" / "sub").mkdir()
        before, scope = codex_runner.snapshot_before(str(root), ["keep\\sub"])
        (root / "keep" / "sub" / "b.txt").write_text("shell write")
        report = codex_runner.files_changed(str(root), before, [], scope)
        self.assertEqual(report["files_changed"], [{"path": "keep/sub/b.txt", "change": "added"}])

    def test_scope_naming_cwd_in_another_case_stays_under_cwd(self):
        codex_runner, root = self.big_tree()
        codex_runner.remember_too_big(str(root))
        # Stand in for case-insensitive /mnt/<drive>, so this also runs on a case-sensitive tmp dir.
        same = lambda a, b: a.lower() == b.lower()
        with mock.patch.object(codex_runner.os.path, "samefile", side_effect=same):
            before, scope = codex_runner.snapshot_before(str(root), [str(root).swapcase() + os.sep + "keep"])
        self.assertEqual(sorted(before), ["keep/a.txt"])
        (root / "keep" / "a.txt").write_text("changed")
        report = codex_runner.files_changed(str(root), before, [(str(root / "keep" / "a.txt"), "update")], scope)
        self.assertEqual(report["files_changed"], [{"path": "keep/a.txt", "change": "modified"}])

    def test_scope_round_trips_through_start(self):
        job = self.invoke("--scope", "src", "--scope", "lib/x.py", command="start")
        args = json.loads((Path(self.tmp.name) / "home" / "jobs" / job["job_id"] / "args.json").read_text("utf-8"))
        self.assertEqual(args["scope"], ["src", "lib/x.py"])
        self.assertEqual(self.control("status", job["job_id"], "--wait", "30")["status"], "completed")

    def test_writer_on_a_too_big_tree_reports_scope_changes_and_events_outside_it(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        (self.cwd / "keep").mkdir()
        (self.cwd / "keep" / "a.txt").write_text("a")
        (self.cwd / "other.txt").write_text("o")
        home = Path(self.tmp.name) / "home"
        home.mkdir()
        (home / codex_runner.TOO_BIG_FILE).write_text(json.dumps({codex_runner.tree_key(str(self.cwd)): time.time()}))
        r = self.invoke("--sandbox", "workspace-write", "--scope", "keep", mode="scoped_write")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["files_changed_source"], "scope_snapshot+codex_events")
        self.assertEqual(r["files_changed"], [{"path": "keep/a.txt", "change": "modified"},
                                              {"path": "other.txt", "change": "update"}])

    def test_ignored_paths_are_dropped_before_the_change_list_is_capped(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        root = Path(self.tmp.name) / "ws"
        (root / ".cache").mkdir(parents=True)
        (root / "src").mkdir()
        before = codex_runner.snapshot(str(root))
        for i in range(400):  # sorts before src/, so it would fill the 300-entry list
            (root / ".cache" / f"c{i}.bin").write_text("x")
        (root / "src" / "a.py").write_text("a")
        (root / "run.log").write_text("log")
        report = codex_runner.files_changed(str(root), before, [], ignore=[r"^\.cache/", r"\.log$", "(?<bad"])
        self.assertEqual(report["files_changed"], [{"path": "src/a.py", "change": "added"}])
        self.assertEqual(report["files_changed_total"], 1)
        self.assertEqual(len(report["ignore_warnings"]), 1)
        self.assertIn("(?<bad", report["ignore_warnings"][0])

    def test_ignore_patterns_use_python_re_and_report_skipped_patterns(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        events = [("logs/progress.log", "update"), ("CACHE/state", "update"), ("src/a.py", "update")]
        report = codex_runner.files_changed(str(self.cwd), None, events,
                                           ignore=["(?P<log>^logs/)", "(?i)^cache/", "(?<log>^src/)", "["])
        self.assertEqual(report["files_changed"], [{"path": "src/a.py", "change": "update"}])
        self.assertEqual(report["files_changed_total"], 1)
        self.assertEqual(len(report["ignore_warnings"]), 2)
        self.assertIn("(?<log>^src/)", report["ignore_warnings"][0])
        self.assertIn("'['", report["ignore_warnings"][1])
        for warning in report["ignore_warnings"]:
            self.assertIn("ignoreChanges", warning)
            self.assertIn("Python re", warning)

    def test_read_only_run_reports_invalid_ignore_patterns(self):
        result = self.invoke("--ignore", "(?<log>^logs/)")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(result["ignore_warnings"]), 1)
        self.assertIn("(?<log>^logs/)", result["ignore_warnings"][0])
        self.assertIn("Python re", result["ignore_warnings"][0])

    def test_ignore_reaches_the_worker_through_start(self):
        (self.cwd / "keep").mkdir()
        (self.cwd / "keep" / "a.txt").write_text("a")
        job = self.invoke("--sandbox", "workspace-write", "--ignore", "(?P<log>^keep/)",
                          "--ignore", "(?<log>^keep/)", command="start", mode="scoped_write")
        r = self.control("status", job["job_id"], "--wait", "30")
        self.assertEqual(r["status"], "completed")
        self.assertEqual((r["files_changed"], r["files_changed_total"]), ([], 0))
        self.assertEqual(len(r["ignore_warnings"]), 1)
        self.assertIn("(?<log>^keep/)", r["ignore_warnings"][0])

    @unittest.skipIf(os.name == "nt", "the /mnt/ rule only applies inside WSL")
    def test_codex_lookup_skips_the_windows_build_under_mnt(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.dict(os.environ, {"PATH": "/mnt/c/npm:/opt/tools/bin"}), \
                mock.patch.object(codex_runner.os, "access", return_value=True):
            self.assertEqual(codex_runner.find_codex(), "/opt/tools/bin/codex")

    def sample_context(self, owner="owner-a"):
        return {"owner": owner, "task": "Task title\nprivate task body", "acceptance": ["Criterion one"], "write": True}

    def sample_report(self, **fields):
        return {"summary": "done", "criteria": [{"criterion": "Criterion one", "status": "met", "evidence": "checked"}],
                "files_changed": [], "deviations": [], "unresolved": [], **fields}

    def stored_job(self, job_id, result, **task):
        root = Path(self.tmp.name) / "home" / "jobs" / job_id
        root.mkdir(parents=True)
        args = {"cwd": str(self.cwd), "sandbox": "danger-full-access", **task}
        (root / "args.json").write_text(json.dumps(args, ensure_ascii=False), "utf-8")
        if result is not None:
            (root / "result.json").write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        else:
            (root / "worker.pid").write_text(str(os.getpid()))
        return root

    def submit_review(self, job_id, review, reviewer="reviewer-a"):
        p = subprocess.run([sys.executable, "-B", str(RUNNER), "review", job_id, "--reviewer", reviewer],
                           input=json.dumps(review, ensure_ascii=False).encode("utf-8"), capture_output=True,
                           timeout=30, env=self.env)
        return json.loads(p.stdout)

    def sample_review(self, **fields):
        return {"status": "verified", "criteria": [{"index": 1, "status": "met", "evidence": "independently checked"}],
                "notes": "checked", "accepted_deviations": [], **fields}

    def blocker(self, kind="user_input", **fields):
        return {"id": "b1", "kind": kind, "message": "A decision is needed", "question": "Which option?",
                "resolution": "", **fields}

    def test_reports_accept_legacy_and_strict_optional_blockers(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        self.assertTrue(codex_runner.valid_report(self.sample_report()))
        for kind in ("user_input", "task_conflict", "environment", "implementation"):
            blocker = self.blocker(kind)
            self.assertTrue(codex_runner.valid_report(self.sample_report(blockers=[blocker])))
        invalid = [None, {}, [None], [self.blocker(id=" ")], [self.blocker(message="")],
                   [self.blocker(kind="other")], [self.blocker(question="")], [self.blocker(resolution=None)],
                   [self.blocker(extra=True)], [{k: v for k, v in self.blocker().items() if k != "resolution"}]]
        for blockers in invalid:
            with self.subTest(blockers=blockers):
                self.assertFalse(codex_runner.valid_report(self.sample_report(blockers=blockers)))
        self.assertFalse(codex_runner.valid_report(self.sample_report(unrelated=[])))

    def test_duplicate_blocker_ids_cannot_be_reported_or_saved(self):
        blockers = [self.blocker(), self.blocker("environment", question="")]
        self.stored_job("duplicate-report", {"status": "completed", "structured": self.sample_report(blockers=blockers)},
                        context=self.sample_context())
        value = self.control("status", "duplicate-report")
        self.assertEqual(value["report_status"], "invalid")
        self.assertEqual(value["blocking"]["state"], "unclassified")

        jd = self.stored_job("duplicate-review", {"status": "completed", "structured": self.sample_report()},
                             context=self.sample_context())
        review = self.sample_review(status="needs_changes", blockers=[blockers[0]])
        self.assertEqual(self.submit_review(jd.name, review)["verification_status"], "needs_changes")
        original = (jd / "reviews.json").read_bytes()
        self.assertEqual(self.submit_review(jd.name, {**review, "blockers": blockers})["error_kind"], "bad_arguments")
        self.assertEqual((jd / "reviews.json").read_bytes(), original)

        blockers[1]["id"] = " b1 "
        value = self.submit_review(jd.name, {**review, "blockers": blockers})
        self.assertEqual([b["id"] for b in value["verification"]["blockers"]], ["b1", " b1 "])

    def test_status_and_list_classify_only_explicit_blockers(self):
        pairs = [("user_input", "needs_input", "ask_user"), ("task_conflict", "needs_input", "ask_user"),
                 ("environment", "waiting_environment", "wait_condition"), ("implementation", "needs_fix", "resume_fix")]
        for kind, state, action in pairs:
            self.stored_job(kind, {"status": "completed", "structured": self.sample_report(blockers=[self.blocker(kind)])})
            value = self.control("status", kind)
            self.assertEqual(value["blocking"]["state"], state)
            self.assertEqual(value["blocking"]["next_action"], action)
            self.assertEqual(value["blocking"]["questions"],
                             [{"id": "b1", "question": "Which option?"}] if kind in ("user_input", "task_conflict") else [])
            self.assertEqual(value["review_status"], "needs_attention")
        self.stored_job("legacy-blocked", {"status": "completed", "structured": self.sample_report(
            criteria=[{"criterion": "one", "status": "blocked", "evidence": "environment user input implementation"}])})
        legacy = self.control("status", "legacy-blocked")
        self.assertEqual(legacy["blocking"]["state"], "unclassified")
        self.stored_job("resolution-hint", {"status": "completed", "structured": self.sample_report(
            blockers=[self.blocker(resolution="Choose option A or B")])})
        self.assertEqual(self.control("status", "resolution-hint")["blocking"]["state"], "needs_input")
        self.stored_job("active", None)
        self.assertEqual(self.control("status", "active")["blocking"]["state"], "running")
        listing = self.control("list")
        for item in listing["jobs"]:
            self.assertEqual(item["blocking"], self.control("status", item["job_id"])["blocking"])

    def test_blocking_summary_closed_and_needs_changes_replace_old_blockers(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        old = self.blocker()
        base = {"status": "completed", "structured": self.sample_report(blockers=[old])}
        for status in ("verified", "accepted_deviations"):
            with self.subTest(status=status):
                value = {**base, "verification_status": status,
                         "verification": {"status": status, "blockers": [old]}}
                self.assertEqual(codex_runner.blocking_summary(value),
                                 {"state": "clear", "next_action": "done", "blockers": [], "questions": []})
        for review in ({"status": "needs_changes"}, {"status": "needs_changes", "blockers": []}):
            self.assertEqual(codex_runner.blocking_summary({**base, "verification": review}),
                             {"state": "needs_fix", "next_action": "resume_fix", "blockers": [], "questions": []})
        self.assertEqual(codex_runner.blocking_summary({**base, "verification_status": "needs_changes"}),
                         {"state": "needs_fix", "next_action": "resume_fix", "blockers": [], "questions": []})
        blocker = self.blocker("environment", resolution="wait for service")
        changed = codex_runner.blocking_summary({**base, "verification_status": "needs_changes",
                                               "verification": {"blockers": [blocker]}})
        self.assertEqual(changed, {"state": "waiting_environment", "next_action": "wait_condition",
                                   "blockers": [blocker], "questions": []})

    def test_blocking_summary_inspection_has_priority_over_typed_questions(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        base = {"status": "completed", "structured": self.sample_report(blockers=[self.blocker()])}
        cases = [{"status": "unknown"}, {"status": "monitor_failed"}, {"execution_status": "unknown"},
                 {"error_kind": "unknown_job"}, {"error_kind": "bridge_error"}, {"error_kind": "invalid_record"},
                 {"verification_status": "invalid"}, {"verification_status": "unknown"},
                 {"report_status": "invalid"}, {"verification": {"blockers": None}},
                 {"verification_status": "verified", "execution_status": "unknown"},
                 {"verification_status": "verified", "verification": {"blockers": None}}]
        for changes in cases:
            with self.subTest(changes=changes):
                result = codex_runner.blocking_summary({**base, **changes})
                self.assertEqual((result["state"], result["next_action"]), ("unclassified", "inspect_report"))
        running = codex_runner.blocking_summary({**base, "status": "running"})
        self.assertEqual((running["state"], running["next_action"]), ("running", "wait"))

    def test_blocking_summary_distinguishes_unmet_and_unclassified_criteria(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for status, state, action in (("met", "clear", "verify"), ("not_met", "needs_fix", "resume_fix"),
                                      ("blocked", "unclassified", "inspect_report")):
            with self.subTest(status=status):
                report = self.sample_report(criteria=[{"criterion": "one", "status": status, "evidence": "checked"}])
                self.assertEqual(codex_runner.blocking_summary({"status": "completed", "structured": report}),
                                 {"state": state, "next_action": action, "blockers": [], "questions": []})
        base = {"status": "completed", "structured": self.sample_report()}
        for changes in ({"status": "failed"}, {"status": "cancelled"}, {"structured": None},
                        {"structured": self.sample_report(unresolved=["remaining"])},
                        {"context": {**self.sample_context(), "acceptance": ["one", "two"]}}):
            with self.subTest(changes=changes):
                result = codex_runner.blocking_summary({**base, **changes})
                self.assertEqual((result["state"], result["next_action"]), ("unclassified", "inspect_report"))

    def test_blocking_summary_only_user_and_conflict_blockers_supply_questions(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        blockers = [self.blocker(kind, id=kind) for kind in ("implementation", "environment", "user_input", "task_conflict")]
        base = {"status": "completed", "structured": self.sample_report(blockers=blockers)}
        result = codex_runner.blocking_summary(base)
        self.assertEqual((result["state"], result["next_action"]), ("needs_input", "ask_user"))
        self.assertEqual(result["questions"], [{"id": b["id"], "question": b["question"]} for b in blockers[2:]])
        for selected, state, action in ((blockers[:1], "needs_fix", "resume_fix"),
                                        (blockers[:2], "waiting_environment", "wait_condition")):
            result = codex_runner.blocking_summary({**base, "structured": self.sample_report(blockers=selected)})
            self.assertEqual((result["state"], result["next_action"]), (state, action))
            self.assertEqual(result["questions"], [])
        self.assertEqual(codex_runner.blocking_summary({"status": "completed", "report": base["structured"]}),
                         codex_runner.blocking_summary(base))

    def test_review_summary_flags_blockers_even_when_every_criterion_is_met(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for kind in ("user_input", "task_conflict", "environment", "implementation"):
            with self.subTest(kind=kind):
                report = self.sample_report(blockers=[self.blocker(kind, resolution="proposed remedy")])
                result = codex_runner.review_summary({"status": "completed", "structured": report})
                self.assertEqual(result["criteria_counts"], {"met": 1, "not_met": 0, "blocked": 0})
                self.assertEqual(result["review_status"], "needs_attention")

    def test_continuation_retains_permissions_and_filters_without_listing_answers(self):
        context = {**self.sample_context(), "continuation": {"parent_job_id": "parent-1",
                   "answers": [{"id": "b1", "answer": "private answer"}], "resolution": "use option A"}}
        envelope = json.dumps({"prompt": "continue", "context": context})
        started = self.invoke("--context-json", "--sandbox", "danger-full-access", "--writable-root", str(self.cwd),
                              "--use-user-config", "--effort", "high", "--resume", "thread-parent", prompt=envelope,
                              command="start")
        value = self.control("status", started["job_id"], "--wait", "30")
        self.assertEqual(value["context"], context)
        self.assertEqual(value["sandbox"], "danger-full-access")
        self.assertEqual(value["task_options"], {"writable_roots": [str(self.cwd)], "use_user_config": True, "effort": "high"})
        self.stored_job("unrelated", {"status": "completed", "thread_id": "different"}, context=self.sample_context())
        listing = self.control("list", "--parent-job", "parent-1", "--thread-id", "thread-1")
        self.assertEqual([j["job_id"] for j in listing["jobs"]], [started["job_id"]])
        self.assertEqual(listing["jobs"][0]["parent_job_id"], "parent-1")
        self.assertNotIn("private answer", json.dumps(listing))
        self.assertNotIn("answers", json.dumps(listing))
        self.assertEqual(self.control("list", "--thread-id", "missing")["total"], 0)
        for continuation in (None, {}, {**context["continuation"], "parent_job_id": "../escape"},
                             {**context["continuation"], "answers": [{"id": "b", "answer": ""}]},
                             {**context["continuation"], "extra": True},
                             {**context["continuation"], "answers": [{"id": "b", "answer": "a"}] * 2}):
            bad = {**context, "continuation": continuation}
            self.assertEqual(self.invoke("--context-json", prompt=json.dumps({"prompt": "x", "context": bad}))["error_kind"],
                             "bad_arguments")

    def test_independent_reviews_preserve_reports_and_close_attention(self):
        report = self.sample_report(deviations=["Used another implementation"])
        jd = self.stored_job("reviewed", {"status": "completed", "structured": report}, context=self.sample_context(),
                             scope=["allowed"])
        raw = json.loads((jd / "result.json").read_text("utf-8"))
        raw["files_changed"] = [{"path": "outside.txt", "change": "modified"}]
        (jd / "result.json").write_text(json.dumps(raw), "utf-8")
        (jd / "last_message.txt").write_text(json.dumps(report), "utf-8")
        originals = [(jd / name).read_bytes() for name in ("result.json", "last_message.txt")]
        self.assertEqual(self.control("status", jd.name)["verification_status"], "unreviewed")
        changes = self.sample_review(status="needs_changes", criteria=[{"index": 1, "status": "not_met", "evidence": "fails"}])
        value = self.submit_review(jd.name, changes)
        self.assertEqual(value["verification_status"], "needs_changes")
        missing_scope = self.sample_review(status="accepted_deviations", accepted_deviations=[
            {"kind": "reported", "index": 1, "evidence": "within acceptance"}])
        self.assertEqual(self.submit_review(jd.name, missing_scope)["error_kind"], "bad_arguments")
        passing = {**missing_scope, "accepted_deviations": [*missing_scope["accepted_deviations"],
                   {"kind": "scope", "index": 1, "evidence": "outside file is intended"}]}
        value = self.submit_review(jd.name, passing, reviewer="reviewer-b")
        self.assertEqual(value["verification_status"], "accepted_deviations")
        self.assertEqual(value["blocking"]["state"], "clear")
        self.assertEqual(value["review_status"], "needs_attention")
        self.assertEqual(value["structured"], report)
        self.assertEqual(value["verification"]["reviewer"], "reviewer-b")
        self.assertIsInstance(value["verification"]["time"], float)
        history = json.loads((jd / "reviews.json").read_text("utf-8"))
        self.assertEqual(len(history["history"]), 2)
        self.assertEqual(history["latest"], value["verification"])
        self.assertEqual([(jd / name).read_bytes() for name in ("result.json", "last_message.txt")], originals)
        self.assertEqual(self.control("list", "--needs-attention")["total"], 0)
        self.assertEqual(self.control("list")["jobs"][0]["verification"], value["verification"])

    def test_review_blockers_drive_continuation_questions_without_rewriting_report(self):
        report = self.sample_report()
        self.stored_job("review-blocked", {"status": "completed", "structured": report}, context=self.sample_context())
        review = self.sample_review(status="needs_changes", blockers=[self.blocker("task_conflict")])
        value = self.submit_review("review-blocked", review)
        self.assertEqual(value["blocking"]["state"], "needs_input")
        self.assertEqual(value["blocking"]["questions"], [{"id": "b1", "question": "Which option?"}])
        self.assertEqual(value["structured"], report)
        self.assertEqual(value["review_status"], "needs_verification")
        self.assertEqual(self.control("list", "--needs-attention")["total"], 1)
        value = self.submit_review("review-blocked", self.sample_review())
        self.assertEqual(value["blocking"]["state"], "clear")
        self.assertEqual(value["blocking"]["questions"], [])

    def test_invalid_report_cannot_hide_real_deviation_acknowledgements(self):
        report = self.sample_report(deviations=["real deviation"], unrelated="invalidates report")
        self.stored_job("invalid-deviations", {"status": "completed", "structured": report}, context=self.sample_context())
        self.assertEqual(self.submit_review("invalid-deviations", self.sample_review())["error_kind"], "bad_arguments")
        review = self.sample_review(accepted_deviations=[{"kind": "reported", "index": 1, "evidence": "assessed"}])
        value = self.submit_review("invalid-deviations", review)
        self.assertEqual(value["verification_status"], "verified")
        self.assertEqual(value["report_status"], "invalid")

    def test_reviews_require_real_acceptance_coverage_and_strict_decisions(self):
        context = {**self.sample_context(), "acceptance": ["one", "two"]}
        self.stored_job("coverage", {"status": "completed", "structured": self.sample_report()}, context=context)
        self.assertEqual(self.submit_review("coverage", self.sample_review())["error_kind"], "bad_arguments")
        complete = self.sample_review(criteria=[{"index": i, "status": "met", "evidence": "checked"} for i in (1, 2)])
        invalid = [self.sample_review(criteria=[]), {**complete, "extra": True}, {**complete, "status": "pass"},
                   {**complete, "notes": []}, {**complete, "blockers": [self.blocker()]},
                   {**complete, "blockers": [self.blocker(resolution="need a decision")]},
                   {**complete, "status": "accepted_deviations", "blockers": [self.blocker()]},
                   {**complete, "status": "accepted_deviations", "blockers": [self.blocker(resolution="need a decision")]},
                   {**complete, "accepted_deviations": [{"kind": "reported", "index": 1, "evidence": "invented"}]}]
        for field, bad in (("index", True), ("index", 0), ("index", 3), ("status", "not_met"), ("evidence", " ")):
            invalid.append({**complete, "criteria": [{**complete["criteria"][0], field: bad}, complete["criteria"][1]]})
        invalid.append({**complete, "criteria": [complete["criteria"][0]] * 2})
        for review in invalid:
            with self.subTest(review=review):
                self.assertEqual(self.submit_review("coverage", review)["error_kind"], "bad_arguments")
        self.assertEqual(self.submit_review("coverage", complete)["verification_status"], "verified")
        self.stored_job("legacy-review", {"status": "completed", "structured": self.sample_report()})
        self.assertEqual(self.submit_review("legacy-review", self.sample_review())["verification_status"], "verified")
        self.stored_job("running-review", None, context=self.sample_context())
        for identifier in ("running-review", "missing", "../coverage"):
            self.assertEqual(self.submit_review(identifier, self.sample_review())["error_kind"], "bad_arguments")

    def test_22_criteria_survive_history_output_and_require_complete_review(self):
        acceptance = [f'验收 {i}：保留 "CSV" 原文与数据 😀' for i in range(1, 23)]
        context = {**self.sample_context(), "acceptance": acceptance}
        report = self.sample_report(criteria=[{"criterion": item, "status": "met", "evidence": f"checked {i}"}
                                             for i, item in enumerate(acceptance, 1)])
        jd = self.stored_job("criteria-22", {"status": "completed", "structured": report}, context=context)
        (jd / "last_message.txt").write_text(json.dumps(report, ensure_ascii=False), "utf-8")
        value = self.control("status", jd.name)
        self.assertEqual(value["context"], context)
        self.assertEqual(value["structured"], report)
        self.assertEqual(value["criteria_counts"], {"met": 22, "not_met": 0, "blocked": 0})
        listed = self.control("list", "--owner", context["owner"])["jobs"]
        self.assertEqual([item["job_id"] for item in listed], [jd.name])
        self.assertEqual(listed[0]["criteria_counts"], value["criteria_counts"])
        for artifact, expected in (("context", context), ("report", report)):
            page = self.control("output", jd.name, "--artifact", artifact, "--limit", "8000")
            self.assertTrue(page["eof"])
            self.assertEqual(json.loads(page["text"]), expected)
        criteria = [{"index": i, "status": "met", "evidence": f"independently checked {i}"} for i in range(1, 23)]
        missing_last = self.sample_review(criteria=criteria[:-1])
        self.assertEqual(self.submit_review(jd.name, missing_last)["error_kind"], "bad_arguments")
        self.assertFalse((jd / "reviews.json").exists())
        reviewed = self.submit_review(jd.name, self.sample_review(criteria=criteria))
        self.assertEqual(reviewed["verification_status"], "verified")
        self.assertEqual(reviewed["verification"]["criteria"], criteria)
        self.assertEqual(reviewed["structured"], report)
        page = self.control("output", jd.name, "--artifact", "review", "--limit", "8000")
        self.assertTrue(page["eof"])
        self.assertEqual(json.loads(page["text"])["latest"]["criteria"], criteria)

    def test_corrupt_review_history_never_passes_or_gets_overwritten(self):
        jd = self.stored_job("corrupt-review", {"status": "completed", "structured": self.sample_report()},
                             context=self.sample_context())
        entry = {**self.sample_review(), "reviewer": "reviewer-a", "time": time.time()}
        bad_entry = {**entry, "criteria": []}
        corruptions = ["not JSON", "[]", "{}", json.dumps({"history": [], "latest": entry}),
                       json.dumps({"history": [entry], "latest": None}),
                       json.dumps({"history": [bad_entry, entry], "latest": entry}),
                       json.dumps({"history": [{**entry, "time": "now"}], "latest": {**entry, "time": "now"}})]
        for content in corruptions:
            (jd / "reviews.json").write_text(content, "utf-8")
            with self.subTest(content=content[:70]):
                status = self.control("status", jd.name)
                self.assertEqual(status["status"], "completed")
                self.assertEqual(status["verification_status"], "invalid")
                self.assertIn("verification_error", status)
                listing = self.control("list", "--needs-attention")
                self.assertEqual(listing["jobs"][0]["verification_status"], "invalid")
                self.assertEqual(self.submit_review(jd.name, self.sample_review())["error_kind"], "bad_arguments")
                self.assertEqual((jd / "reviews.json").read_text("utf-8"), content)

    def test_review_artifact_pages_unicode_and_enforces_artifact_boundary(self):
        jd = self.stored_job("review-output", {"status": "completed", "structured": self.sample_report()})
        self.submit_review(jd.name, self.sample_review(notes="汉😀" * 5000))
        pages = []
        offset = 0
        while True:
            page = self.control("output", jd.name, "--artifact", "review", "--offset", str(offset))
            self.assertEqual(page["status"], "completed")
            pages.append(page["text"])
            if page["eof"]:
                break
            offset = page["next_offset"]
        self.assertEqual(json.loads("".join(pages))["latest"]["notes"], "汉😀" * 5000)
        outside = Path(self.tmp.name) / "external-review.json"
        outside.write_text((jd / "reviews.json").read_text("utf-8"), "utf-8")
        (jd / "reviews.json").unlink()
        try:
            (jd / "reviews.json").symlink_to(outside)
        except OSError as e:
            if os.name == "nt":
                self.skipTest(f"file symlink is unavailable: {e}")
            raise
        self.assertEqual(self.control("output", jd.name, "--artifact", "review")["error_kind"], "invalid_artifact")
        self.assertEqual(self.control("status", jd.name)["verification_status"], "invalid")
        original = outside.read_bytes()
        self.assertEqual(self.submit_review(jd.name, self.sample_review())["error_kind"], "bad_arguments")
        self.assertEqual(outside.read_bytes(), original)

    def test_summary_groups_all_rounds_and_uses_latest_cumulative_usage(self):
        for i, tokens in enumerate((10, 25, 40), 1):
            result = {"status": "completed", "thread_id": "shared-thread", "duration_s": i,
                      "usage": {"input_tokens": tokens, "output_tokens": i}, "structured": self.sample_report(summary=f"round {i}"),
                      "files_changed": [{"path": f"file-{i}.txt", "change": "modified"}]}
            if i > 1:
                result["usage_scope"] = "thread_total"
            jd = self.stored_job(f"round-{i}", result, context=self.sample_context())
            os.utime(jd / "args.json", (1000 + i, 1000 + i))
        for name in ("threadless-a", "threadless-b"):
            self.stored_job(name, {"status": "completed", "structured": self.sample_report()}, context=self.sample_context())
        result = self.control("summary", "--thread-id", "shared-thread", "--round-limit", "1")
        self.assertEqual(result["total_jobs"], 3)
        group = result["groups"][0]
        self.assertEqual(group["group_id"], "thread:shared-thread")
        self.assertEqual(group["job_ids"], ["round-1", "round-2", "round-3"])
        self.assertEqual(group["total_rounds"], 3)
        self.assertEqual(len(group["rounds"]), 1)
        self.assertTrue(group["rounds_truncated"])
        self.assertEqual(group["latest_job_id"], "round-3")
        self.assertEqual(group["summary"], "round 3")
        self.assertEqual(group["finished_duration_s"], 6)
        self.assertEqual(group["usage"], {"input_tokens": 40, "output_tokens": 3})
        self.assertEqual(group["files_changed"], ["file-1.txt", "file-2.txt", "file-3.txt"])
        all_groups = self.control("summary")["groups"]
        self.assertEqual(len(all_groups), 3)
        self.assertTrue(all(g["usage"] is None for g in all_groups if not g["thread_id"]))
        self.assertEqual(self.control("summary", "--job-id", "round-2")["total_jobs"], 1)
        self.assertEqual(self.control("summary", "--owner", "missing")["total_jobs"], 0)
        self.assertEqual(self.control("summary", "--cwd", str(self.cwd / "elsewhere"))["total_jobs"], 0)
        self.assertEqual(self.control("summary", "--round-limit", "0")["error_kind"], "bad_arguments")
        latest = self.stored_job("round-4", {"status": "completed", "thread_id": "shared-thread",
                                            "usage": {"input_tokens": 50}, "structured": self.sample_report()})
        os.utime(latest / "args.json", (1004, 1004))
        self.assertIsNone(self.control("summary", "--thread-id", "shared-thread")["groups"][0]["usage"])
        self.assertEqual(self.control("summary", "--job-id", "round-4")["groups"][0]["usage"], {"input_tokens": 50})

    def test_summary_pages_threads_without_losing_totals_or_rounds(self):
        for i in range(12):
            job = self.stored_job(f"page-{i}", {"status": "completed", "thread_id": f"thread-{min(i, 10)}",
                                               "structured": self.sample_report()}, context=self.sample_context())
            os.utime(job / "args.json", (1000 + i, 1000 + i))

        first = self.control("summary")
        self.assertEqual((first["total"], first["total_jobs"], first["next_offset"]), (11, 12, 10))
        self.assertEqual([g["thread_id"] for g in first["groups"]], [f"thread-{i}" for i in range(10, 0, -1)])
        self.assertEqual(first["groups"][0]["job_ids"], ["page-10", "page-11"])

        second = self.control("summary", "--limit", "1", "--offset", str(first["next_offset"]))
        self.assertEqual((second["total"], second["total_jobs"], second["next_offset"]), (11, 12, None))
        self.assertEqual([g["thread_id"] for g in second["groups"]], ["thread-0"])
        self.assertEqual(self.control("summary", "--offset", "-1")["error_kind"], "bad_arguments")

    def test_summary_usage_requires_latest_cumulative_scope_for_multiple_rounds(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        earlier = {"thread_id": "thread", "usage_scope": "thread_total", "usage": {"input_tokens": 10}}
        latest = {"thread_id": "thread", "usage": {"input_tokens": 25}}
        for scope in (None, "unknown", "turn"):
            with self.subTest(scope=scope):
                self.assertIsNone(codex_runner.summary_usage([earlier, {**latest, "usage_scope": scope}]))
        self.assertEqual(codex_runner.summary_usage([earlier, {**latest, "usage_scope": "thread_total"}]), latest["usage"])
        for usage in (None, {}, [], {"input_tokens": "unknown"}):
            with self.subTest(usage=usage):
                self.assertIsNone(codex_runner.summary_usage([
                    earlier, {**latest, "usage_scope": "thread_total", "usage": usage}]))
        for job in (latest, {"usage": {"input_tokens": 3}}):
            self.assertEqual(codex_runner.summary_usage([job]), job["usage"])
        self.assertIsNone(codex_runner.summary_usage([]))

    def test_summary_unknown_usage_stays_unknown_and_review_controls_open_items(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        self.assertIsNone(codex_runner.summary_usage([{"usage": {"input_tokens": 2}},
                                                    {"usage": {"input_tokens": 3}}]))
        self.assertIsNone(codex_runner.summary_usage([{"usage": {"input_tokens": 2}}, {}]))
        self.assertIsNone(codex_runner.summary_usage([{"usage": {"input_tokens": 2, "output_tokens": 1}},
                                                    {"usage": {"input_tokens": 3}}]))
        self.assertIsNone(codex_runner.summary_usage([{"usage_scope": "thread_total", "usage": {"input_tokens": 8}},
                                                    {"usage_scope": "thread_total", "usage": None}]))
        jd = self.stored_job("summary-review", {"status": "completed", "structured": self.sample_report(unresolved=["check manually"])},
                             context=self.sample_context())
        self.assertEqual(self.control("summary")["groups"][0]["open_items"]["unresolved"], ["check manually"])
        blocker = self.blocker("environment", resolution="wait for service recovery")
        self.submit_review(jd.name, self.sample_review(status="needs_changes", blockers=[blocker]))
        group = self.control("summary")["groups"][0]
        self.assertEqual(group["latest_job"]["blocking"]["state"], "waiting_environment")
        self.assertEqual(group["open_items"]["blockers"], [blocker])
        self.submit_review(jd.name, self.sample_review())
        group = self.control("summary")["groups"][0]
        self.assertEqual(group["verification_status"], "verified")
        self.assertTrue(all(not items for items in group["open_items"].values()))

    def test_context_envelope_round_trips_large_unicode_without_argv(self):
        context = self.sample_context()
        context["task"] += "上下文😀" * 20000
        context["acceptance"] = ["验证完整结果" * 2000]
        envelope = json.dumps({"prompt": "only this prompt reaches Codex", "context": context}, ensure_ascii=False)
        for command in ("run", "start"):
            with self.subTest(command=command):
                result = self.invoke("--context-json", "--sandbox", "danger-full-access", prompt=envelope, command=command)
                if command == "start":
                    jd = Path(self.tmp.name) / "home" / "jobs" / result["job_id"]
                    result = self.control("status", result["job_id"], "--wait", "30")
                else:
                    jd = Path(result["log_dir"])
                self.assertEqual(result["context"], context)
                if command == "start":
                    self.assertEqual(json.loads((jd / "args.json").read_text("utf-8"))["context"], context)
                else:
                    self.assertFalse((jd / "args.json").exists())
                self.assertIn("review_status", result)
                self.assertNotIn("review_summary", result)
                call = self.calls()[-1]
                self.assertEqual(call["prompt"], "only this prompt reaches Codex")
                self.assertNotIn(context["task"], call["argv"])
                self.assertEqual(result["sandbox"], "danger-full-access")

    def test_context_envelope_rejects_bad_shapes_without_spawning(self):
        context = self.sample_context()
        values = ["not json", "[]", json.dumps({"prompt": "do it"}),
                  json.dumps({"prompt": 12, "context": context})]
        for key, bad in (("owner", []), ("task", None), ("acceptance", "one"),
                         ("acceptance", [1]), ("write", "true")):
            values.append(json.dumps({"prompt": "do it", "context": {**context, key: bad}}))
        for value in values:
            with self.subTest(value=value[:25]):
                result = self.invoke("--context-json", prompt=value)
                self.assertEqual(result["error_kind"], "bad_arguments")
                self.assertFalse(result["retryable"])
        malformed = subprocess.run([sys.executable, "-B", str(RUNNER), "run", "--cwd", str(self.cwd), "--context-json"],
                                   input=b'{"prompt":"bad \xff"}', capture_output=True, env=self.env, timeout=30)
        self.assertEqual(json.loads(malformed.stdout)["error_kind"], "bad_arguments")
        self.assertEqual(self.calls(), [])
        unknown = {**context, "owner": None}
        result = self.invoke("--context-json", prompt=json.dumps({"prompt": "do it", "context": unknown}))
        self.assertIsNone(result["context"]["owner"])

    def test_old_cancelled_status_recovers_context_without_rewriting(self):
        cases = [("read-only", None, None), ("read-only", "writer-old", "writer-old"),
                 ("workspace-write", None, "T-event"), ("danger-full-access", None, "T-event")]
        for n, (sandbox, resume, expected) in enumerate(cases):
            with self.subTest(sandbox=sandbox, resume=resume):
                context = self.sample_context()
                jd = self.stored_job(f"cancelled-{n}", {"status": "cancelled", "retryable": False},
                                     sandbox=sandbox, resume=resume, scope=["keep"], context=context)
                (jd / "events.jsonl").write_text(json.dumps({"type": "thread.started", "thread_id": "T-event"}) + "\n")
                old = time.time() - 120
                os.utime(jd / "args.json", (old, old))
                original = (jd / "result.json").read_bytes()
                for _ in range(2):
                    value = self.control("status", jd.name)
                    self.assertEqual(value["context"], context)
                    self.assertEqual(value["thread_id"], expected)
                    self.assertEqual(value["cwd"], os.path.realpath(self.cwd))
                    self.assertEqual(value["sandbox"], sandbox)
                    self.assertEqual(value["scope"], ["keep"])
                    self.assertEqual(value["scope_paths"], [os.path.realpath(self.cwd / "keep")])
                    self.assertGreaterEqual(value["duration_s"], 119)
                    self.assertNotIn("files_changed", value)
                    self.assertEqual(value["review_status"], "needs_attention")
                self.assertEqual((jd / "result.json").read_bytes(), original)

    def test_review_summary_matches_schema_and_keeps_execution_separate(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        valid = self.sample_report()
        base = {"status": "completed", "structured": valid}
        self.assertEqual(codex_runner.review_summary(base), {
            "execution_status": "completed", "report_status": "valid", "review_status": "needs_verification",
            "criteria_counts": {"met": 1, "not_met": 0, "blocked": 0}})
        invalids = [[], {}, {**valid, "extra": 1}, {**valid, "summary": None},
                    {**valid, "unresolved": [1]}, {**valid, "criteria": [None]},
                    {**valid, "criteria": [{"criterion": "c", "status": "unknown", "evidence": "e"}]},
                    {**valid, "criteria": [{"criterion": "c", "status": "met", "evidence": 1}]}]
        for report in invalids:
            summary = codex_runner.review_summary({**base, "structured": report})
            self.assertEqual(summary["report_status"], "invalid")
            self.assertEqual(summary["review_status"], "needs_attention")
        for status in ("blocked", "not_met"):
            report = self.sample_report(criteria=[{"criterion": "c", "status": status, "evidence": "e"}])
            self.assertEqual(codex_runner.review_summary({**base, "structured": report})["criteria_counts"][status], 1)
        for report in (self.sample_report(unresolved=["remaining"]), self.sample_report(deviations=["changed plan"])):
            self.assertEqual(codex_runner.review_summary({**base, "structured": report})["review_status"], "needs_attention")
        context = self.sample_context()
        context["acceptance"] *= 2
        summary = codex_runner.review_summary({**base, "context": context})
        self.assertEqual(summary["report_status"], "valid")
        self.assertEqual(summary["review_status"], "needs_attention")
        for value in ({"status": "failed", "error_kind": "schema_invalid"},
                      {"status": "failed", "error_kind": "schema_invalid", "structured": valid}):
            summary = codex_runner.review_summary(value)
            self.assertEqual(summary["execution_status"], "completed")
            self.assertEqual(summary["report_status"], "invalid")
        missing = codex_runner.review_summary({"status": "completed", "final_message": json.dumps(valid)})
        self.assertEqual(missing["report_status"], "missing")
        self.assertEqual(missing["criteria_counts"], {"met": 0, "not_met": 0, "blocked": 0})
        self.assertEqual(codex_runner.review_summary({"status": "running"})["review_status"], "pending")
        outside = {**base, "cwd": str(self.cwd), "scope_paths": [str(self.cwd / "src")],
                   "files_changed": [{"path": "other.txt", "change": "modified"}]}
        self.assertEqual(codex_runner.review_summary(outside)["review_status"], "needs_attention")

    def test_review_query_errors_leave_execution_unknown(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for raw_status, kind in (("failed", "invalid_record"), ("failed", "unknown_job"),
                                 ("failed", "bridge_error"), ("monitor_failed", None)):
            value = {"status": raw_status, "error_kind": kind}
            summary = codex_runner.review_summary(value)
            self.assertEqual(summary["execution_status"], "unknown")
            self.assertEqual(summary["review_status"], "needs_attention")
            self.assertEqual(summary["report_status"], "missing")
            self.assertEqual(value["status"], raw_status)
        missing = self.control("status", "no-such-job")
        self.assertEqual(missing["status"], "failed")
        self.assertEqual(missing["execution_status"], "unknown")
        self.assertEqual(self.control("output", "no-such-job")["execution_status"], "unknown")
        bad = self.stored_job("bad-record", {"status": "completed"})
        (bad / "args.json").write_text("[]")
        result = self.control("status", bad.name)
        self.assertEqual(result["error_kind"], "invalid_record")
        self.assertEqual(result["execution_status"], "unknown")
        listing = self.control("list", "--status", "unknown")
        self.assertEqual([j["job_id"] for j in listing["jobs"]], [bad.name])
        self.assertEqual(listing["jobs"][0]["status"], "failed")

    def test_review_paths_do_not_follow_symlinks_created_after_the_run(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        allowed = self.cwd / "allowed"
        allowed.mkdir()
        changed = allowed / "file.txt"
        changed.write_text("original")
        outside = Path(self.tmp.name) / "outside.txt"
        outside.write_text("external")
        value = {"status": "completed", "structured": self.sample_report(), "cwd": str(self.cwd),
                 "scope_paths": [str(allowed)], "files_changed": [{"path": "allowed/file.txt", "change": "modified"}]}
        before = codex_runner.review_summary(value)
        self.assertEqual(before["review_status"], "needs_verification")
        changed.unlink()
        try:
            changed.symlink_to(outside)
        except OSError as e:
            if os.name == "nt":
                self.skipTest(f"file symlink is unavailable: {e}")
            raise
        self.assertEqual(codex_runner.review_summary(value), before)

    def test_review_windows_backed_paths_compare_lexically_without_fs_lookups(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        value = {"status": "completed", "structured": self.sample_report(), "cwd": "/mnt/c/Work/Project",
                 "scope_paths": ["/mnt/C/work/PROJECT/src"],
                 "files_changed": [{"path": "SRC/./a.py", "change": "modified"}]}
        with mock.patch.object(codex_runner.os.path, "realpath", side_effect=AssertionError("historical path was resolved")):
            self.assertEqual(codex_runner.review_summary(value)["review_status"], "needs_verification")
            value["files_changed"][0]["path"] = "src/../../outside.py"
            self.assertEqual(codex_runner.review_summary(value)["review_status"], "needs_attention")

    @unittest.skipIf(os.name == "nt", "native Linux path case belongs to the Linux runner")
    def test_review_native_linux_paths_keep_case_sensitive_scope(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for cwd in ("/srv/Project", "/mnt/data/Project"):
            with self.subTest(cwd=cwd):
                value = {"status": "completed", "structured": self.sample_report(), "cwd": cwd,
                         "scope_paths": [cwd + "/src"], "files_changed": [{"path": "SRC/a.py", "change": "modified"}]}
                self.assertEqual(codex_runner.review_summary(value)["review_status"], "needs_attention")
                value["files_changed"][0]["path"] = "src/a.py"
                self.assertEqual(codex_runner.review_summary(value)["review_status"], "needs_verification")

    def test_list_filters_owner_cwd_execution_attention_and_paginates(self):
        context = self.sample_context()
        self.stored_job("owned", {"status": "completed", "structured": self.sample_report()}, context=context, scope=["src"])
        self.stored_job("legacy", {"status": "cancelled", "retryable": False})
        self.stored_job("other", {"status": "completed", "structured": self.sample_report()}, context=self.sample_context("owner-b"))
        self.stored_job("bad-report", {"status": "failed", "error_kind": "schema_invalid"}, context=context)
        self.stored_job("elsewhere", {"status": "completed", "structured": self.sample_report()}, cwd=str(self.cwd / "elsewhere"), context=context)
        result = self.control("list", "--owner", "owner-a", "--job-id", "legacy", "--cwd", str(self.cwd))
        self.assertEqual({j["job_id"] for j in result["jobs"]}, {"owned", "legacy", "bad-report"})
        old = next(j for j in result["jobs"] if j["job_id"] == "legacy")
        self.assertIsNone(old["context"])
        owned = next(j for j in result["jobs"] if j["job_id"] == "owned")
        self.assertEqual(owned["context"], {"owner": "owner-a", "task": "Task title"})
        self.assertEqual(owned["scope"], ["src"])
        self.assertEqual(owned["scope_paths"], [os.path.realpath(self.cwd / "src")])
        self.assertEqual(owned["criteria_counts"], {"met": 1, "not_met": 0, "blocked": 0})
        self.assertEqual(owned["report_status"], "valid")
        self.assertEqual(owned["review_status"], "needs_verification")
        self.assertNotIn("review_summary", owned)
        self.assertNotIn("private task body", json.dumps(result))
        result = self.control("list", "--owner", "owner-a", "--cwd", str(self.cwd), "--status", "completed", "--needs-attention")
        self.assertEqual([j["job_id"] for j in result["jobs"]], ["bad-report"])
        self.assertEqual(result["jobs"][0]["status"], "failed")
        self.assertEqual(result["jobs"][0]["execution_status"], "completed")
        first = self.control("list", "--limit", "2")
        second = self.control("list", "--limit", "2", "--offset", str(first["next_offset"]))
        self.assertEqual(first["total"], 5)
        self.assertFalse(first["eof"])
        self.assertFalse({j["job_id"] for j in first["jobs"]} & {j["job_id"] for j in second["jobs"]})
        last = self.control("list", "--offset", "4")
        self.assertTrue(last["eof"])
        self.assertIsNone(last["next_offset"])
        for extra in (("--limit", "101"), ("--offset", "-1")):
            self.assertEqual(self.control("list", *extra)["error_kind"], "bad_arguments")

    def test_list_filters_metadata_before_reading_job_events(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for job_id, owner, cwd in (("keep", "owner-a", self.cwd), ("other-owner", "owner-b", self.cwd),
                                   ("other-cwd", "owner-a", self.cwd / "elsewhere"), ("explicit", "owner-b", self.cwd)):
            self.stored_job(job_id, {"status": "completed", "thread_id": "W"},
                            context=self.sample_context(owner), cwd=str(cwd))
        args = SimpleNamespace(command="list", owner="owner-a", cwd=str(self.cwd), job_id=["explicit"],
                               status=None, needs_attention=False, offset=0, limit=20)
        activity = codex_runner.runner_activity
        def read_activity(events):
            self.assertIn(events.parent.name, ("keep", "explicit"))
            return activity(events)
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                mock.patch.object(codex_runner, "runner_activity", side_effect=read_activity) as read:
            result = codex_runner.list_jobs(args)
        self.assertEqual({j["job_id"] for j in result["jobs"]}, {"keep", "explicit"})
        self.assertEqual(read.call_count, 2)

    def test_history_pages_reuse_records_and_only_enrich_selected_jobs(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        for i in range(4):
            jd = self.stored_job(f"history-{i}", {"status": "completed", "thread_id": f"thread-{i}",
                                                  "structured": self.sample_report()}, context=self.sample_context())
            os.utime(jd / "args.json", (1000 + i, 1000 + i))
        read_text = Path.read_text
        for command in ("list", "summary"):
            reads = []

            def read(path, *args, **kwargs):
                if path.name in ("args.json", "result.json"):
                    reads.append(path)
                return read_text(path, *args, **kwargs)

            args = SimpleNamespace(command=command, owner="owner-a", cwd=str(self.cwd), job_id=None,
                                   status=None, needs_attention=False, offset=1, limit=1, round_limit=20)
            with self.subTest(command=command), mock.patch.object(codex_runner, "HOME", Path(self.env["CODEX_RUNNER_HOME"])), \
                    mock.patch.object(Path, "read_text", read), \
                    mock.patch.object(codex_runner, "enriched_status", wraps=codex_runner.enriched_status) as enrich:
                value = codex_runner.list_jobs(args) if command == "list" else codex_runner.summarize_jobs(args)
            self.assertEqual(value["total"], 4)
            self.assertEqual(len(reads), len(set(reads)))
            self.assertEqual(enrich.call_count, 1)
            if command == "list":
                self.assertEqual(value["jobs"][0]["job_id"], "history-2")
            else:
                self.assertEqual(value["groups"][0]["job_ids"], ["history-2"])

    def test_output_unicode_pagination_is_complete_repeatable_and_controlled(self):
        context = self.sample_context()
        jd = self.stored_job("output", {"status": "completed"}, context=context)
        content = "漢" * 3999 + "😀" + "第二页" * 1800 + "\r\nEND"
        with open(jd / "last_message.txt", "w", encoding="utf-8", newline="") as f:
            f.write(content)
        pages = []
        offset = 0
        while True:
            page = self.control("output", "output", "--offset", str(offset))
            self.assertEqual(page["status"], "completed")
            self.assertEqual(page["total_chars"], len(content))
            self.assertEqual(self.control("output", "output", "--offset", str(offset)), page)
            pages.append(page["text"])
            if page["eof"]:
                self.assertIsNone(page["next_offset"])
                break
            offset = page["next_offset"]
        self.assertEqual("".join(pages), content)
        self.assertTrue(pages[0].endswith("😀"))
        context_page = self.control("output", "output", "--artifact", "context", "--limit", "8000")
        self.assertEqual(json.loads(context_page["text"]), context)
        result_page = self.control("output", "output", "--artifact", "result")
        self.assertEqual(json.loads(result_page["text"]), {"status": "completed"})
        self.assertEqual(self.control("output", "output", "--offset", str(len(content)))["error_kind"], "offset_out_of_range")
        self.assertEqual(self.control("output", "../output")["error_kind"], "bad_arguments")
        self.assertEqual(self.control("output", "output", "--limit", "8001")["error_kind"], "bad_arguments")

    def test_output_distinguishes_pending_missing_empty_and_legacy_context(self):
        pending = self.stored_job("running", None)
        (pending / "last_message.txt").write_text("stale previous attempt")
        self.assertEqual(self.control("output", "running")["error_kind"], "artifact_pending")
        empty = self.stored_job("empty", {"status": "completed"})
        self.assertEqual(self.control("output", "empty")["error_kind"], "artifact_missing")
        (empty / "last_message.txt").write_text("")
        self.assertEqual(self.control("output", "empty")["error_kind"], "artifact_empty")
        self.assertEqual(self.control("output", "empty", "--artifact", "context")["error_kind"], "legacy_context_missing")
        (empty / "args.json").write_text("[]")
        self.assertEqual(self.control("status", "empty")["error_kind"], "invalid_record")

    def test_runner_phases_expose_retry_without_changing_retry_policy(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        parser = codex_runner.Parser()
        codex_runner.add_task_arguments(parser)
        args = parser.parse_args(["--cwd", str(self.cwd), "--sandbox", "danger-full-access", "--resume", "W", "--backoff", "0.1"])
        jd = self.stored_job("phases", None, resume="W")
        waits = []
        def observe_retry(delay):
            status = codex_runner.job_status(jd.name)
            waits.append(status)
            self.assertEqual(status["phase"], "retry_wait")
            self.assertEqual(status["attempt"], 1)
            self.assertEqual(status["last_error_kind"], "router_down")
            self.assertIsInstance(status["retry_at"], float)
            self.assertGreater(delay, 0)
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                mock.patch.dict(os.environ, {**self.env, "FAKE_MODE": "warnings_then_ok"}), \
                mock.patch.object(codex_runner, "router_reachable", side_effect=[False, True]), \
                mock.patch.object(codex_runner, "time", wraps=codex_runner.time) as runner_clock:
            runner_clock.sleep.side_effect = observe_retry
            result = codex_runner.execute(args, "a new resume task", jd)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(len(waits), 1)
        self.assertEqual(self.calls()[-1]["prompt"], "a new resume task")
        events = [json.loads(s) for s in (jd / "events.jsonl").read_text().splitlines()]
        phases = [e for e in events if e["type"] == "runner.phase"]
        self.assertEqual([e["phase"] for e in phases], ["router_check", "retry_wait", "router_check", "codex_running", "finalizing"])
        activity = codex_runner.runner_activity(jd / "events.jsonl")
        self.assertEqual(activity["attempt"], 2)
        self.assertEqual(activity["last_error_kind"], "router_down")
        self.assertIsNone(activity["retry_at"])
        with (jd / "events.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "item.completed", "item": {"type": "reasoning", "text": "x" * 140000}}) + "\n")
        self.assertEqual(codex_runner.runner_activity(jd / "events.jsonl"), activity)
        (jd / "result.json").write_text(json.dumps({"status": "failed", "error_kind": "runner_error"}))
        self.assertEqual(self.control("status", jd.name)["last_error_kind"], "runner_error")

    def test_unknown_job_is_reported(self):
        self.assertEqual(self.control("status", "nope")["error_kind"], "unknown_job")

    def test_running_status_reports_current_reconnect(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        home = Path(self.tmp.name) / "home"
        jd = home / "jobs" / "live-reconnect"
        jd.mkdir(parents=True)
        codex_runner.runner_event(jd, 1, "codex_running")
        with mock.patch.object(codex_runner, "HOME", home), mock.patch.object(codex_runner, "recorded_pid", return_value=os.getpid()):
            events = jd / "events.jsonl"
            with events.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"type": "error", "message": "Reconnecting... 1/5 (timed out)"}) + "\n")
            status = codex_runner.job_status(jd.name)
            self.assertEqual((status["status"], status["phase"]), ("running", "codex_reconnecting"))
            with events.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"type": "item.started", "item": {"type": "command_execution", "command": "true"}}) + "\n")
            self.assertEqual(codex_runner.job_status(jd.name)["phase"], "codex_running")

    def test_runner_activity_reads_only_the_tail_on_repeated_queries(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        phase = {"type": "runner.phase", "phase": "retry_wait", "attempt": 2, "reason": "transient", "retry_at": 123}
        history = (json.dumps({"type": "item.completed", "item": {"text": "x" * 1000}}) + "\n").encode() * 4096
        payload = history + (json.dumps(phase) + "\nnot json\n").encode()
        sizes = []
        class Counted(io.BytesIO):
            def read(self, *args):
                data = super().read(*args)
                sizes.append(len(data))
                return data
            def readline(self, *args):
                data = super().readline(*args)
                sizes.append(len(data))
                return data
            def __next__(self):
                data = self.readline()
                if not data:
                    raise StopIteration
                return data
        with mock.patch.object(codex_runner, "open", side_effect=lambda *a, **kw: Counted(payload), create=True):
            for _ in range(2):
                self.assertEqual(codex_runner.runner_activity(Path("events.jsonl")),
                                 {"phase": "retry_wait", "attempt": 2, "last_error_kind": "transient", "retry_at": 123})
        self.assertLessEqual(sum(sizes), 2 * 65536)

    def test_finished_status_uses_the_saved_phase_without_reading_events(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        jd = self.stored_job("finished-phase", {"status": "completed"}, sandbox="read-only")
        codex_runner.runner_event(jd, 2, "finalizing", "transient")
        codex_runner.write_result(jd, {"status": "completed", "attempts": 2})
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                mock.patch.object(codex_runner, "runner_activity", side_effect=AssertionError("reread finished events")):
            status = codex_runner.job_status(jd.name)
        self.assertEqual((status["phase"], status["attempt"], status["last_error_kind"], status["retry_at"]),
                         ("finalizing", 2, "transient", None))

    def test_worker_finishing_during_status_check_is_not_reported_dead(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        job_dir = Path(self.tmp.name) / "home" / "jobs" / "raced"
        job_dir.mkdir(parents=True)
        (job_dir / "worker.pid").write_text("1")

        def worker_exits_after_writing_result(_pid):
            (job_dir / "result.json").write_text(json.dumps({"status": "completed"}))
            return False

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"), \
                mock.patch.object(codex_runner, "pid_alive", worker_exits_after_writing_result):
            self.assertEqual(codex_runner.job_status("raced")["status"], "completed")

    def old_job(self, args):
        """A job whose worker pid is alive but was recorded in an earlier boot (WSL restarted since)."""
        job_dir = Path(self.tmp.name) / "home" / "jobs" / f"old-{len(list(Path(self.tmp.name).glob('home/jobs/*')))}"
        job_dir.mkdir(parents=True)
        (job_dir / "args.json").write_text(json.dumps(args))
        (job_dir / "events.jsonl").write_text("not json\n" + json.dumps({"type": "thread.started", "thread_id": "T-old"}) + "\n")
        (job_dir / "worker.pid").write_text(str(os.getpid()))
        (job_dir / "boot_id").write_text("an-earlier-boot")
        return job_dir

    def test_a_worker_from_before_a_restart_is_dead_keeps_its_thread_and_cancel_kills_nothing(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            job_dir = self.old_job({"sandbox": "workspace-write", "resume": None})
            codex_runner.runner_event(job_dir, 1, "retry_wait", "router_down", time.time() + 30)
            status = codex_runner.job_status(job_dir.name)
            self.assertEqual((status["phase"], status["attempt"], status["retry_at"]), ("interrupted", 1, None))
            self.assertEqual((status["status"], status["error_kind"], status["retryable"], status["thread_id"], status["sandbox"]),
                             ("failed", "worker_died", True, "T-old", "workspace-write"))
            with mock.patch.object(sys, "argv", [str(RUNNER), "cancel", job_dir.name]), \
                    mock.patch.object(codex_runner, "kill_tree") as kill, \
                    mock.patch.object(codex_runner, "emit") as emit:
                codex_runner.main()
            kill.assert_not_called()
            self.assertEqual(emit.call_args.args[0]["error_kind"], "worker_died")
            self.assertFalse((job_dir / "result.json").exists())
            # Jobs started before boot ids were recorded keep the plain pid check.
            (job_dir / "boot_id").unlink()
            self.assertEqual(codex_runner.job_status(job_dir.name)["status"], "running")

    def test_a_dead_read_only_worker_offers_only_the_writer_thread_it_resumed(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        cases = (
            ({"sandbox": "read-only"}, None),                       # read-only: --ephemeral, own thread cannot resume
            ({"sandbox": "read-only", "resume": "W"}, "W"),         # resumed a writer thread -> still resumable
            ({"sandbox": "workspace-write"}, "T-old"),              # writer: thread.started from events
            ({"sandbox": "danger-full-access"}, "T-old"),          # host_access writer keeps its thread too
        )
        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            for args, expected in cases:
                with self.subTest(args=args):
                    status = codex_runner.job_status(self.old_job(args).name)
                    self.assertEqual((status["error_kind"], status["thread_id"]), ("worker_died", expected))
            # Writer that died before Codex printed thread.started (during the lock/snapshot/backoff): fall back to --resume.
            jd = self.old_job({"sandbox": "workspace-write", "resume": "W"})
            (jd / "events.jsonl").unlink()
            s = codex_runner.job_status(jd.name)
            self.assertEqual((s["error_kind"], s["thread_id"]), ("worker_died", "W"))

    @unittest.skipIf(os.name == "nt", "boot ids come from Linux /proc")
    def test_start_records_the_boot_id(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        job = self.invoke(command="start", mode="slow_ok", env={"FAKE_SLEEP": "1"})
        job_dir = Path(self.tmp.name) / "home" / "jobs" / job["job_id"]
        self.assertEqual((job_dir / "boot_id").read_text(), codex_runner.boot_id())
        self.assertEqual(self.control("status", job["job_id"], "--wait", "30")["status"], "completed")

    def test_start_prunes_only_long_finished_job_and_run_dirs(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            old_job = codex_runner.HOME / "jobs" / "old"
            fresh_job = codex_runner.HOME / "jobs" / "fresh"
            old_run = codex_runner.HOME / "runs" / "old"
            for d in (old_job, fresh_job, old_run):
                d.mkdir(parents=True)
                (d / "result.json").write_text("{}")
            stale = time.time() - codex_runner.PRUNE_TTL - 86400
            for d in (old_job, old_run):
                os.utime(d / "result.json", (stale, stale))
                os.utime(d, (stale, stale))
            codex_runner.prune_old("jobs")
            codex_runner.prune_old("runs")
            self.assertFalse(old_job.exists())
            self.assertFalse(old_run.exists())
            self.assertTrue(fresh_job.exists())
            codex_runner.prune_old("missing")  # absent subdir is a no-op, not an error

    def test_prune_keeps_old_unfinished_dirs_and_recent_results(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.tmp.name) / "home"):
            stale = time.time() - codex_runner.PRUNE_TTL - 86400
            for subdir in ("jobs", "runs"):
                for name in ("running", "queued", "recently-finished"):
                    d = codex_runner.HOME / subdir / name
                    d.mkdir(parents=True)
                    if name == "recently-finished":
                        (d / "result.json").write_text("{}")
                    else:
                        (d / "worker.pid").write_text(str(os.getpid()))
                        (d / "events.jsonl").write_text("active")
                    os.utime(d, (stale, stale))
                codex_runner.prune_old(subdir)
                self.assertEqual(sorted(d.name for d in (codex_runner.HOME / subdir).iterdir()),
                                 ["queued", "recently-finished", "running"])

    def test_worker_registers_its_own_process_identity_before_execution(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        jd = self.stored_job("self-register", None)
        (jd / "worker.pid").unlink()
        (jd / "prompt.txt").write_text("do it")

        def execute(*unused):
            self.assertEqual(codex_runner.recorded_pid(jd / "worker.pid"), os.getpid())
            self.assertEqual((jd / "worker.start").read_text(), codex_runner.process_start(os.getpid()))
            return {"status": "completed"}

        with mock.patch.object(codex_runner, "HOME", Path(self.env["CODEX_RUNNER_HOME"])), \
                mock.patch.object(sys, "argv", [str(RUNNER), "_worker", jd.name]), \
                mock.patch.object(codex_runner, "execute", side_effect=execute):
            codex_runner.main()
        self.assertEqual(json.loads((jd / "result.json").read_text())["status"], "completed")

    def test_prune_removes_only_stale_unfinished_dirs_with_no_live_process(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.object(codex_runner, "HOME", Path(self.env["CODEX_RUNNER_HOME"])):
            stale = time.time() - codex_runner.PRUNE_TTL - 86400
            for subdir in ("jobs", "runs"):
                for name in ("abandoned", "running", "queued", "orphan", "recent-log"):
                    d = codex_runner.HOME / subdir / name
                    d.mkdir(parents=True)
                    (d / "events.jsonl").write_text("activity")
                    if name in ("running", "queued", "orphan"):
                        codex_runner.record_pid(d / ("codex.pid" if name == "orphan" else "worker.pid"), os.getpid())
                    for path in [d, *d.iterdir()]:
                        os.utime(path, (stale, stale))
                    if name == "recent-log":
                        (d / "stderr.log").write_text("recent")
                codex_runner.prune_old(subdir)
                self.assertEqual(sorted(d.name for d in (codex_runner.HOME / subdir).iterdir()),
                                 ["orphan", "queued", "recent-log", "running"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
