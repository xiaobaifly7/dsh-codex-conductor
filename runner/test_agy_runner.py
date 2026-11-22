from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

import agy_runner


def args(cwd, /, **overrides):
    values = dict(cwd=cwd, sandbox="read-only", schema=None, model=None, effort=None,
                  agy_command=r"C:\tools\fake-agy.exe" if os.name == "nt" else "fake-agy",
                  agy_proxy=None, writable_roots=[], scope=[], context={})
    return SimpleNamespace(**(values | overrides))


class FakeLink:
    """dsh-agy-link's lease API on a loopback port, announced in .link-endpoint.json next to pool.json.

    Accounts are pool-style dicts with id, home and proxyUrl; an unpinned acquire gets `choice`. Queue (status, body)
    replies per route in `replies`; routes=False answers every route with a plain 404 (a plugin without leases)."""

    def __init__(self, pool_dir, accounts, choice=None, routes=True, ttl_ms=60_000):
        self.accounts, self.choice, self.routes, self.ttl_ms = accounts, choice or accounts[0]["id"], routes, ttl_ms
        self.calls, self.replies, self.leases, self.count = [], {}, {}, 0
        link = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                route = self.path.rsplit("/", 1)[-1]
                link.calls.append((route, body))
                status, reply = link.answer(self.path, route, body)
                data = reply.encode() if isinstance(reply, str) else json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = Path(pool_dir) / ".link-endpoint.json"
        self.endpoint.write_text(json.dumps({"url": f"http://127.0.0.1:{self.server.server_port}/plugins/agy-link",
                                             "pid": 1, "startedAt": 0}), encoding="utf-8")

    def answer(self, path, route, body):
        if not self.routes or not path.startswith("/plugins/agy-link/lease/"):
            return 404, "Not Found"
        if self.replies.get(route):
            return self.replies[route].pop(0)
        if route == "acquire":
            if "accountDir" in body:
                account = next((a for a in self.accounts if a["home"] == body["accountDir"]), None)
            else:
                account = next((a for a in self.accounts if a["id"] == body.get("accountId", self.choice)), None)
            if account is None:
                return 404, {"ok": False, "code": "account_not_found", "error": "no such account"}
            self.count += 1
            lease = f"lease-{self.count}"
            self.leases[lease] = account["id"]
            fields = {key: value for key, value in account.items() if key != "env"}
            return 200, {"ok": True, "leaseId": lease, "ttlMs": self.ttl_ms, "expiresAt": 0,
                         "slot": "env" not in account, "env": account.get("env", {"NO_PROXY": "localhost", **{
                             key: account["proxyUrl"] for key in ("HTTP_PROXY", "HTTPS_PROXY") if account["proxyUrl"]}}),
                         "account": {"email": "", "alias": "", "primary": account["home"] == "",
                                     "isolated": "env" in account, **fields}}
        if body.get("leaseId") not in self.leases:
            return 404, {"ok": False, "code": "lease_not_found", "error": "unknown lease"}
        if route == "release":
            del self.leases[body["leaseId"]]
        return 200, {"ok": True, "expiresAt": 0}

    def routes_called(self):
        return [route for route, _ in self.calls]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def write_pool(pool_dir, accounts):
    """pool.json as dsh-agy-link writes it: the primary has no dir and lives in the system profile."""
    pool = Path(pool_dir) / "pool.json"
    pool.write_text(json.dumps({"primaryAccountId": "acc_primary", "accounts": [
        {"id": a["id"], "dir": a["home"], "systemHome": a["home"] == "", "proxyUrl": a["proxyUrl"], "enabled": True}
        for a in accounts]}), encoding="utf-8")
    return pool


PRIMARY = {"id": "acc_primary", "home": "", "proxyUrl": "http://127.0.0.1:50577"}
SECOND = {"id": "acc_b", "home": r"D:\pool\acc_b", "proxyUrl": ""}


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pool = write_pool(self.tmp.name, [PRIMARY, SECOND])
        self.log = Path(self.tmp.name) / "stderr.log"
        # The agy proxy in the environment must not catch the loopback calls.
        environment = mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:9", "http_proxy": "http://127.0.0.1:9"})
        environment.start()
        self.addCleanup(environment.stop)

    def link(self, **options):
        link = FakeLink(self.tmp.name, [PRIMARY, SECOND], **options)
        self.addCleanup(link.close)
        return link

    def lease(self):
        return agy_runner.AccountLease(self.pool, "dsh-codex-conductor/job-1", "gemini-4-neon-medium", self.log)

    def test_fresh_runs_take_the_account_the_plugin_chooses_and_release_with_the_outcome(self):
        link = self.link(choice="acc_b")
        lease = self.lease()
        # A secondary without its own proxy keeps the configured one.
        self.assertEqual(lease.acquire(None, None, "http://127.0.0.1:7890"), (SECOND["home"], "http://127.0.0.1:7890"))
        self.assertEqual(link.calls[0], ("acquire", {"holder": "dsh-codex-conductor/job-1", "ttlMs": agy_runner.LEASE_TTL_MS,
                                                     "waitMs": agy_runner.LEASE_WAIT_MS, "model": "gemini-4-neon-medium"}))
        lease.release(False, "429 RESOURCE_EXHAUSTED: quota")
        self.assertEqual(link.calls[-1], ("release", {"leaseId": "lease-1", "ok": False,
                                                      "error": "429 RESOURCE_EXHAUSTED: quota", "model": "gemini-4-neon-medium"}))
        self.assertEqual(link.leases, {})
        # The primary runs in its own profile: no HOME override, and its own proxy.
        link.choice = "acc_primary"
        lease = self.lease()
        self.assertEqual(lease.acquire(None, None, "http://127.0.0.1:7890"), (None, "http://127.0.0.1:50577"))
        lease.release(True, "ignored")
        self.assertEqual(link.calls[-1], ("release", {"leaseId": "lease-2", "ok": True, "model": "gemini-4-neon-medium"}))
        self.assertFalse(self.log.exists())

    def test_a_held_lease_carries_the_accounts_environment(self):
        isolated = {**SECOND, "env": {"HOME": SECOND["home"], "GEMINI_CLI_HOME": SECOND["home"], "BROWSER": "none",
                                      "BAD=NAME": "x", "ALSO:BAD": "x", "NUMBER": 1}}
        link = FakeLink(self.tmp.name, [PRIMARY, isolated], choice="acc_b")
        self.addCleanup(link.close)
        lease = self.lease()
        lease.acquire(None, None, None)
        self.assertEqual(lease.env, {"HOME": SECOND["home"], "GEMINI_CLI_HOME": SECOND["home"], "BROWSER": "none"})
        lease.release(True)
        (Path(self.tmp.name) / ".link-endpoint.json").unlink()
        lease = self.lease()
        lease.acquire(None, None, None)
        self.assertIsNone(lease.env)

    def test_continuations_pin_the_account_that_owns_the_conversation(self):
        link = self.link(choice="acc_primary")
        self.assertEqual(self.lease().acquire("conv-1", SECOND["home"], None)[0], SECOND["home"])
        self.assertEqual(link.calls[-1][1]["accountDir"], SECOND["home"])
        # No recorded home: the conversation is in the primary's profile, pinned by its id from pool.json.
        self.assertEqual(self.lease().acquire("conv-1", None, None)[0], None)
        self.assertEqual(link.calls[-1][1]["accountId"], "acc_primary")
        self.assertNotIn("accountDir", link.calls[-1][1])
        with self.assertRaisesRegex(agy_runner.LeaseError, "fresh: true") as caught:
            self.lease().acquire("conv-1", r"D:\pool\gone", None)
        self.assertEqual(caught.exception.kind, "provider_permanent")

    def test_renewal_keeps_the_lease_and_re_acquires_the_same_account_after_a_dsh_restart(self):
        link = self.link(choice="acc_b", ttl_ms=30)
        lease = self.lease()
        lease.acquire(None, None, None)
        deadline = time.monotonic() + 10
        while link.routes_called().count("renew") < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(link.calls[1], ("renew", {"leaseId": "lease-1", "ttlMs": agy_runner.LEASE_TTL_MS}))
        link.leases.clear()  # DSH restarted and forgot every lease
        while "lease-2" not in link.leases and time.monotonic() < deadline:
            time.sleep(0.01)
        reacquired = [body for route, body in link.calls if route == "acquire"][1]
        self.assertEqual(reacquired["accountDir"], SECOND["home"])
        lease.release(True)
        self.assertEqual(link.calls[-1][1]["leaseId"], "lease-2")
        self.assertEqual(link.leases, {})
        self.assertIn("re-acquired as lease-2", self.log.read_text("utf-8"))

    def test_lease_refusals_fail_with_the_quota_kind(self):
        link = self.link()
        for reply, kind in (((503, {"ok": False, "code": "no_account", "error": "all cooling", "retryAfterMs": 60_000}), "transient"),
                            ((503, {"ok": False, "code": "no_account", "error": "all cooling", "retryAfterMs": 3_600_000}),
                             "provider_permanent"),
                            ((504, {"ok": False, "code": "slot_timeout", "error": "slot busy"}), "transient"),
                            ((409, {"ok": False, "code": "account_unavailable", "error": "disabled"}), "provider_permanent"),
                            ((500, "Internal Server Error"), "transient")):
            link.replies["acquire"] = [reply]
            with self.assertRaises(agy_runner.LeaseError) as caught:
                self.lease().acquire(None, None, None)
            self.assertEqual(caught.exception.kind, kind, reply)
            if isinstance(reply[1], dict):
                self.assertIn(f"{reply[1]['code']}: {reply[1]['error']}", str(caught.exception))
        self.assertEqual(link.leases, {})

    def test_without_the_lease_api_fresh_runs_use_the_primary_and_secondary_continuations_fail(self):
        for setup in ("missing", "unreachable", "not upgraded"):
            self.log.unlink(missing_ok=True)
            if setup == "not upgraded":
                self.link(routes=False)
            elif setup == "unreachable":
                self.link().close()
            else:
                (Path(self.tmp.name) / ".link-endpoint.json").unlink(missing_ok=True)
            lease = self.lease()
            self.assertEqual(lease.acquire(None, None, "http://127.0.0.1:7890"), (None, "http://127.0.0.1:50577"), setup)
            lease.release(True)
            log = self.log.read_text("utf-8")
            self.assertEqual(log.count(agy_runner.LEASE_NOTE), 1, setup)
            self.assertIn("running on the primary account without a lease", log)
            self.assertEqual(self.lease().acquire("conv-1", None, None), (None, "http://127.0.0.1:50577"), setup)
            with self.assertRaisesRegex(agy_runner.LeaseError, "wrong account"):
                self.lease().acquire("conv-1", SECOND["home"], None)


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

    def test_leased_environment_replaces_the_runners_home_and_proxy(self):
        leased = {"HOME": r"D:\pool\acc 1", "USERPROFILE": r"D:\pool\acc 1", "GEMINI_CLI_HOME": r"D:\pool\acc 1",
                  "HTTPS_PROXY": "http://127.0.0.1:7894", "NO_PROXY": "localhost,127.0.0.1", "BROWSER": "none"}
        with tempfile.TemporaryDirectory() as run_dir, \
                mock.patch.dict(os.environ, {"WSLENV": "KEEP/u:HOME/p", "HTTP_PROXY": "http://inherited:1"}):
            command, env = agy_runner.build_command(args(
                r"D:\local project", agy_command=r"C:\tools\agy.exe", sandbox="danger-full-access", context={"write": False},
                agy_proxy="http://127.0.0.1:7890", agy_home=r"D:\pool\acc 1", agy_env=leased,
            ), run_dir, None)
            self.assertEqual({key: env[key] for key in leased}, leased)
            self.assertEqual(env["HTTP_PROXY"], "http://inherited:1")  # the runner's own proxy is not set on top
            self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
            if os.name != "nt":
                entries = env["WSLENV"].split(":")
                self.assertTrue(set(leased) <= set(entries))  # plain names: the values are already Windows strings
                self.assertIn("KEEP/u", entries)
                self.assertNotIn("HOME/p", entries)
            # The account home still scopes agy's own data directory for host read-only jobs.
            permissions = json.loads(command[command.index("--settings") + 1])["permissions"]
            self.assertIn("write_file(D:/pool/acc 1/.gemini/antigravity-cli)", permissions["allow"])

    def test_host_access_allows_commands_and_read_only_still_denies_writes(self):
        with tempfile.TemporaryDirectory() as run_dir:
            def built(**overrides):
                command, _ = agy_runner.build_command(args(run_dir, **overrides), run_dir, None)
                return command, json.loads(command[command.index("--settings") + 1])

            command, settings = built(sandbox="danger-full-access", context={"write": False})
            self.assertEqual(command[command.index("--mode") + 1], "plan")
            self.assertEqual(settings["permissions"]["allow"], ["command(*)", "unsandboxed(*)", "read_file(*)"])
            self.assertEqual(settings["permissions"]["deny"], ["write_file(*)", "mcp(*)", "read_url(*)", "execute_url(*)"])
            self.assertTrue(settings["allowNonWorkspaceAccess"])
            self.assertNotIn("--effort", command)
            # Headless agy denies every command that has no allow rule, so a host write task needs one to run anything.
            command, settings = built(sandbox="danger-full-access")
            self.assertEqual(command[command.index("--mode") + 1], "accept-edits")
            # Reading or editing a file outside the workspace asks too, and a headless ask is a denial that fails the job.
            self.assertEqual(settings["permissions"], {"allow": ["command(*)", "unsandboxed(*)", "read_file(*)", "write_file(*)"]})
            self.assertTrue(settings["allowNonWorkspaceAccess"])
            self.assertNotIn("--sandbox", command)
            self.assertNotIn("--dangerously-skip-permissions", command)
            # Outside host access nothing is allowed to run.
            command, settings = built()
            self.assertIn("--sandbox", command)
            self.assertEqual(settings["permissions"]["allow"], [])
            self.assertFalse(settings["allowNonWorkspaceAccess"])
            self.assertIn("command(*)", settings["permissions"]["deny"])

    def test_host_read_only_jobs_may_write_only_into_agys_own_data_directory(self):
        with tempfile.TemporaryDirectory() as run_dir:
            def permissions(**overrides):
                command = agy_runner.build_command(args(r"D:\local project", agy_command=r"C:\tools\agy.exe", **overrides),
                                                   run_dir, None)[0]
                return json.loads(command[command.index("--settings") + 1])["permissions"]

            perms = permissions(sandbox="danger-full-access", context={"write": False}, agy_home=r"D:\pool\acc 1")
            self.assertIn("write_file(D:/pool/acc 1/.gemini/antigravity-cli)", perms["allow"])
            # A deny rule would override that allow, so the blanket one goes; other writes still ask and are auto-denied.
            self.assertNotIn("write_file(*)", perms["deny"])
            self.assertNotIn("write_file(*)", perms["allow"])
            # Without a known home, or without host access, every write stays denied.
            self.assertIn("write_file(*)", permissions(sandbox="danger-full-access", context={"write": False})["deny"])
            self.assertIn("write_file(*)", permissions(agy_home=r"D:\pool\acc 1")["deny"])

    def test_host_read_only_jobs_keep_python_caches_out_of_the_project(self):
        with tempfile.TemporaryDirectory() as run_dir:
            def env_of(**overrides):
                return agy_runner.build_command(args(r"D:\local project", agy_command=r"C:\tools\agy.exe", **overrides),
                                                run_dir, None)[1]

            env = env_of(sandbox="danger-full-access", context={"write": False, "verification_of": "job-1"})
            self.assertEqual((env["PYTHONDONTWRITEBYTECODE"], env["PYTEST_ADDOPTS"]), ("1", "-p no:cacheprovider"))
            if os.name != "nt":
                self.assertTrue({"PYTHONDONTWRITEBYTECODE", "PYTEST_ADDOPTS"} <= set(env["WSLENV"].split(":")))
            # A writer keeps its caches: it may be meant to produce them.
            self.assertNotEqual(env_of(sandbox="danger-full-access").get("PYTEST_ADDOPTS"), "-p no:cacheprovider")

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
    def test_plan_mode_notice_does_not_replace_the_exit_failure(self):
        with tempfile.TemporaryDirectory() as run_dir:
            fake = Path(run_dir) / "fake-agy"
            fake.write_text("#!/bin/sh\nprintf '%s\\n' 'warning: --mode plan has no effect while slash command expansion "
                            "is disabled.' >&2\nexit 1\n")
            fake.chmod(0o700)
            command, env = agy_runner.build_command(args(run_dir, agy_command=fake), run_dir, None)
            self.assertEqual(command[command.index("--mode") + 1], "plan")
            child = subprocess.run(command, env=env, input=b"example", capture_output=True, timeout=5)
            self.assertEqual(child.returncode, 1)
            self.assertEqual(json.loads(child.stdout)["error"], "agy process exited with code 1")

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
