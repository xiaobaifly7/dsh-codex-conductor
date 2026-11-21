import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest

import agy_runner


def args(cwd, /, **overrides):
    values = dict(cwd=cwd, sandbox="read-only", schema=None, model=None, effort=None,
                  agy_command=r"C:\tools\fake-agy.exe" if os.name == "nt" else "fake-agy",
                  agy_proxy=None, writable_roots=[], scope=[], context={})
    return SimpleNamespace(**(values | overrides))


class AdapterTests(unittest.TestCase):
    def test_windows_argv_and_permissions(self):
        with tempfile.TemporaryDirectory() as run_dir:
            command, env = agy_runner.build_command(args(
                r"D:\local project", agy_command=r"C:\tools\agy.exe", schema=r"schemas\report.json",
                scope=["."], effort="xhigh", agy_proxy="http://127.0.0.1:7890", agy_home="D:/pool/acc 1/",
            ), run_dir, "AbC-中文-012")
            settings = json.loads(command[command.index("--settings") + 1])
            self.assertEqual(settings["modelProvider"], "")
            self.assertFalse(settings["useG1Credits"])
            self.assertIn("write_file(*)", settings["permissions"]["deny"])
            self.assertIn("command(*)", settings["permissions"]["deny"])
            self.assertIn("unsandboxed(*)", settings["permissions"]["deny"])
            self.assertIn("mcp(*)", settings["permissions"]["deny"])
            self.assertEqual(settings["permissions"]["allow"], [])
            self.assertEqual(settings["permissions"]["ask"], [])
            self.assertIn("--sandbox", command)
            self.assertNotIn("--dangerously-skip-permissions", command)
            self.assertEqual(command[command.index("--json-schema") + 1], r"D:\local project\schemas\report.json")
            self.assertEqual(command[command.index("--conversation") + 1], "AbC-中文-012")
            self.assertEqual(env["HTTPS_PROXY"], "http://127.0.0.1:7890")
            self.assertEqual((env["HOME"], env["USERPROFILE"]), (r"D:\pool\acc 1",) * 2)
            if os.name != "nt":
                self.assertTrue({"HOME", "USERPROFILE", "HTTPS_PROXY"} <= set(env["WSLENV"].split(":")))
            self.assertEqual((Path(run_dir) / agy_runner.JOB_RECORD).read_text(), command[3])

    def test_host_access_allows_commands_and_read_only_still_denies_writes(self):
        with tempfile.TemporaryDirectory() as run_dir:
            def built(**overrides):
                command, _ = agy_runner.build_command(args(run_dir, **overrides), run_dir, None)
                return command, json.loads(command[command.index("--settings") + 1])

            command, settings = built(sandbox="danger-full-access", context={"write": False})
            self.assertEqual(command[command.index("--mode") + 1], "plan")
            self.assertEqual(settings["permissions"]["allow"], ["command(*)", "unsandboxed(*)"])
            self.assertEqual(settings["permissions"]["deny"], ["write_file(*)", "mcp(*)", "read_url(*)", "execute_url(*)"])
            self.assertNotIn("--effort", command)
            # Headless agy denies every command that has no allow rule, so a host write task needs one to run anything.
            command, settings = built(sandbox="danger-full-access")
            self.assertEqual(command[command.index("--mode") + 1], "accept-edits")
            self.assertEqual(settings["permissions"], {"allow": ["command(*)", "unsandboxed(*)"]})
            self.assertNotIn("--sandbox", command)
            self.assertNotIn("--dangerously-skip-permissions", command)
            # Outside host access nothing is allowed to run.
            command, settings = built()
            self.assertIn("--sandbox", command)
            self.assertEqual(settings["permissions"]["allow"], [])
            self.assertIn("command(*)", settings["permissions"]["deny"])

    def test_unrepresentable_paths_and_sandbox_fail_closed(self):
        with tempfile.TemporaryDirectory() as run_dir:
            for overrides, error in [
                ({"cwd": r"\\server\share"}, "UNC"),
                ({"scope": [r"\\server\share"]}, "UNC"),
                ({"scope": ["one-file"]}, "restricted path scope"),
                ({"writable_roots": ["extra"]}, "extra writable roots"),
                ({"sandbox": "workspace-write"}, "workspace-write"),
            ]:
                with self.subTest(overrides=overrides), self.assertRaisesRegex(ValueError, error):
                    agy_runner.build_command(args(run_dir, **overrides), run_dir, None)

    def test_only_structured_output_becomes_final_message(self):
        adapter = agy_runner.EventAdapter()
        events = list(adapter.events({"event": "result", "conversation_id": " AbC-中文 ",
                                      "result": {"status": "SUCCESS", "response": "ignore",
                                                 "structured_output": {"summary": "中文"}}}))
        self.assertEqual(events[0], {"type": "thread.started", "thread_id": " AbC-中文 "})
        self.assertEqual(json.loads(events[1]["item"]["text"]), {"summary": "中文"})
        self.assertEqual(events[2]["type"], "turn.completed")
        failed = list(agy_runner.EventAdapter().events({
            "event": "result", "result": {"status": "SUCCESS", "response": '{"summary":"plaintext"}'},
        }))
        self.assertEqual(failed[0]["type"], "turn.failed")

    def test_structured_permission_denial_is_terminal(self):
        adapter = agy_runner.EventAdapter()
        denied = list(adapter.events({"event": "step_update", "step_update": {
            "step_type": "tool", "error": {"code": "PERMISSION_DENIED", "message": "Shell was blocked"},
        }}))
        self.assertEqual(denied, [{"type": "turn.failed", "error": {
            "message": "agy permission denied: Shell was blocked",
        }}])
        self.assertEqual(list(adapter.events({"event": "result", "result": {"status": "SUCCESS"}})), [])

    @unittest.skipIf(os.name == "nt", "exercises the Linux fake executable path")
    def test_cli_flag_error_is_reported_instead_of_usage_tail(self):
        with tempfile.TemporaryDirectory() as run_dir:
            fake = Path(run_dir) / "fake-agy"
            fake.write_text("#!/bin/sh\nprintf '%s\\n' 'flag provided but not defined: -json-schema' 'Usage: agy' >&2\nexit 2\n")
            fake.chmod(0o700)
            command, env = agy_runner.build_command(args(run_dir, agy_command=fake), run_dir, None)
            child = subprocess.run(command, env=env, input=b"example", capture_output=True, timeout=5)
            self.assertEqual(child.returncode, 2)
            self.assertEqual(json.loads(child.stdout)["error"],
                             "agy rejected a CLI argument: flag provided but not defined: -json-schema")

    @unittest.skipIf(os.name == "nt", "exercises the Linux fake executable path")
    def test_linux_fake_preserves_prompt_and_overrides_success_on_stderr_denial(self):
        with tempfile.TemporaryDirectory() as run_dir:
            fake = Path(run_dir) / "fake-agy"
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                "prompt = json.load(sys.stdin)['message']['content']\n"
                "assert prompt == 'first line\\n中文'\n"
                "print(json.dumps({'event':'result', 'conversation_id':'exact-ID', "
                "'result':{'status':'SUCCESS', 'structured_output':{'summary':'report'}}}))\n"
                "print('Tool requires user approval', file=sys.stderr)\n",
                encoding="utf-8",
            )
            fake.chmod(0o700)
            command, env = agy_runner.build_command(args(run_dir, agy_command=fake), run_dir, None)
            child = subprocess.run(command, env=env, cwd=run_dir, input="first line\n中文".encode(),
                                   capture_output=True, timeout=5, check=True)
            adapter = agy_runner.EventAdapter()
            events = [event for raw in child.stdout.splitlines() for event in adapter.events(json.loads(raw))]
            self.assertEqual([event["type"] for event in events], ["thread.started", "turn.failed"])
            self.assertEqual(events[0]["thread_id"], "exact-ID")
            self.assertIn("agy permission denied", events[1]["error"]["message"])
            self.assertTrue(agy_runner.cancel(run_dir))


if __name__ == "__main__":
    unittest.main()
