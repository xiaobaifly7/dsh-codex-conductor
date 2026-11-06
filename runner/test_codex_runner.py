"""Fault-injection tests for codex_runner.py. They use a fake Codex, so they spend no model quota."""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

RUNNER = Path(__file__).with_name("codex_runner.py")

FAKE_CODEX = textwrap.dedent(r"""
    import json, os, subprocess, sys, time
    from pathlib import Path

    state = Path(os.environ["FAKE_STATE"])
    state.mkdir(exist_ok=True)
    calls = len(list(state.glob("call-*.json")))
    prompt = sys.stdin.buffer.read()
    (state / f"call-{calls}.json").write_text(json.dumps({"argv": sys.argv[1:], "prompt": prompt.decode("utf-8")}))
    mode = os.environ["FAKE_MODE"]

    def say(**ev):
        print(json.dumps(ev), flush=True)

    def finish():
        say(type="item.completed", item={"type": "agent_message", "text": "done"})
        say(type="turn.completed", usage={"input_tokens": 1})

    say(type="thread.started", thread_id="thread-1")
    say(type="turn.started")
    if mode == "warnings_then_ok":
        say(type="item.completed", item={"type": "error", "message": "Codex is ignoring 2 unrecognized settings"})
        finish()
    elif mode == "nonzero_after_completed":
        finish()
        sys.exit(1)
    elif mode == "exit0_without_completion":
        sys.exit(0)
    elif mode == "hang_with_child":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        time.sleep(300)
    elif mode == "hang_after_completed":
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        finish()
        time.sleep(300)
    elif mode == "transient_then_ok":
        if calls == 0:
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
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
        (state / "child.pid").write_text(str(child.pid))
        while True:
            say(type="error", message="Reconnecting... waiting for network")
            time.sleep(0.5)
    elif mode == "scoped_write":
        Path("keep/a.txt").write_text("changed by a shell command")
        say(type="item.completed", item={"type": "file_change",
                                         "changes": [{"path": os.path.join(os.getcwd(), "other.txt"), "kind": "update"}]})
        finish()
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
            return open(f"/proc/{pid}/stat").read().split()[2] != "Z"  # a killed, unreaped child is gone
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
        self.env = dict(os.environ, CODEX_RUNNER_HOME=str(root / "home"), FAKE_STATE=str(self.state),
                        CODEX_RUNNER_CMD=json.dumps([sys.executable, str(self.fake)]), CODEX_RUNNER_ROUTER_URL="")

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
        args = [sys.executable, str(RUNNER), command, "--cwd", str(self.cwd), "--backoff", "0.1", *extra]
        p = subprocess.run(args, input=prompt.encode("utf-8"), capture_output=True, timeout=60,
                           env={**self.env, "FAKE_MODE": mode, **(env or {})})
        return json.loads(p.stdout.decode("utf-8"))

    def calls(self):
        return [json.loads(f.read_text()) for f in sorted(self.state.glob("call-*.json"))]

    def test_warning_items_do_not_fail_the_run(self):
        r = self.invoke()
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["final_message"], "done")
        self.assertEqual(r["thread_id"], "thread-1")

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

    def test_process_that_hangs_after_completion_still_succeeds(self):
        start = time.time()
        r = self.invoke("--exit-grace", "2", mode="hang_after_completed")
        self.assertEqual(r["status"], "completed")
        self.assertTrue(r["forced_exit"])
        self.assertLess(time.time() - start, 20)
        time.sleep(1)
        self.assertFalse(alive(int((self.state / "child.pid").read_text())))

    def test_transient_failure_on_writer_resumes_the_same_thread(self):
        r = self.invoke("--sandbox", "workspace-write", mode="transient_then_ok")
        self.assertEqual(r["status"], "completed")
        self.assertEqual(r["attempts"], 2)
        first, second = self.calls()
        self.assertNotIn("resume", first["argv"])
        self.assertIn("resume", second["argv"])
        self.assertIn("thread-1", second["argv"])
        self.assertIn("interrupted", second["prompt"])

    def test_transient_failure_on_reader_restarts_fresh(self):
        r = self.invoke(mode="transient_then_ok")
        self.assertEqual(r["attempts"], 2)
        self.assertNotIn("resume", self.calls()[1]["argv"])
        self.assertEqual(self.calls()[1]["prompt"], "do it")

    def test_permanent_failure_is_not_retried(self):
        r = self.invoke(mode="permanent")
        self.assertEqual(r["error_kind"], "permanent")
        self.assertEqual(r["attempts"], 1)
        self.assertFalse(r["retryable"])

    def test_router_down_never_spawns_codex(self):
        r = self.invoke("--retries", "0", env={"CODEX_RUNNER_ROUTER_URL": "http://127.0.0.1:9/x"})
        self.assertEqual(r["error_kind"], "router_down")
        self.assertEqual(self.calls(), [])

    def test_prompt_with_shell_metacharacters_arrives_intact(self):
        prompt = '修复 A&B|C %PATH% "引号" ^caret\n第二行 $(whoami) `tick`'
        self.invoke(prompt=prompt)
        self.assertEqual(self.calls()[0]["prompt"], prompt)
        self.assertEqual(self.calls()[0]["argv"][-1], "-")

    def test_full_access_is_refused(self):
        r = self.invoke("--sandbox", "danger-full-access")
        self.assertEqual(r["error_kind"], "bad_arguments")
        self.assertEqual(self.calls(), [])

    def test_second_writer_in_same_directory_is_rejected(self):
        args = [sys.executable, str(RUNNER), "run", "--cwd", str(self.cwd), "--sandbox", "workspace-write"]
        first = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={**self.env, "FAKE_MODE": "slow_ok"})
        first.stdin.write(b"one")
        first.stdin.close()
        time.sleep(2)
        r = self.invoke("--sandbox", "workspace-write", mode="slow_ok")
        self.assertEqual(r["error_kind"], "busy")
        self.assertTrue(r["retryable"])
        self.assertEqual(json.loads(first.stdout.read().decode("utf-8"))["status"], "completed")
        first.wait()

    def control(self, *args):
        p = subprocess.run([sys.executable, str(RUNNER), *args], capture_output=True, timeout=60, env=self.env)
        return json.loads(p.stdout.decode("utf-8"))

    def test_start_outlives_the_caller_and_status_returns_the_result(self):
        job = self.invoke(command="start", mode="slow_ok")
        self.assertEqual(job["status"], "running")
        self.assertEqual(self.control("status", job["job_id"])["status"], "running")
        done = self.control("status", job["job_id"], "--wait", "30")
        self.assertEqual(done["status"], "completed")
        self.assertEqual(done["final_message"], "done")

    def test_cancel_kills_the_worker_and_the_tree(self):
        job = self.invoke(command="start", mode="hang_with_child")
        child = self.state / "child.pid"
        for _ in range(40):
            if child.exists():
                break
            time.sleep(0.25)
        self.assertEqual(self.control("cancel", job["job_id"])["status"], "cancelled")
        time.sleep(1)
        self.assertFalse(alive(int(child.read_text())))

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

    @unittest.skipIf(os.name == "nt", "the /mnt/ rule only applies inside WSL")
    def test_codex_lookup_skips_the_windows_build_under_mnt(self):
        sys.path.insert(0, str(RUNNER.parent))
        import codex_runner

        with mock.patch.dict(os.environ, {"PATH": "/mnt/c/npm:/opt/tools/bin"}), \
                mock.patch.object(codex_runner.os, "access", return_value=True):
            self.assertEqual(codex_runner.find_codex(), "/opt/tools/bin/codex")

    def test_unknown_job_is_reported(self):
        self.assertEqual(self.control("status", "nope")["error_kind"], "unknown_job")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
