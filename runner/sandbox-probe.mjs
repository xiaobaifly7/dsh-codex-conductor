import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeTest } from './native-test-config.mjs';

const [mode, count, ...flags] = process.argv.slice(2);
const inJob = flags.length === 1 && flags[0] === '--in-job';
const samples = Number(count);
if (process.platform !== 'win32' || !['elevated', 'unelevated'].includes(mode) ||
    !Number.isSafeInteger(samples) || samples < 1 || (flags.length && !inJob)) {
  console.error('Usage on Windows: node sandbox-probe.mjs <elevated|unelevated> <count> [--in-job]');
  process.exit(2);
}

const { settings: { codexBin, codexHome, pwshDir, python, runnerHome }, work, portable } = prepareNativeTest();
const sampleTimeoutMs = 30_000;
const env = { ...process.env, CODEX_HOME: codexHome, PYTHONUTF8: '1' };
if (inJob) {
  const driver = [
    'import subprocess, sys, tempfile, uuid',
    'from runner import codex_runner as runner',
    'with tempfile.TemporaryDirectory(prefix="sandbox-probe-", dir=sys.argv[1]) as directory:',
    '    name = r"Local\\dsh-codex-" + uuid.uuid4().hex',
    '    job = runner.create_windows_job(name)',
    '    try:',
    '        sys.exit(subprocess.call([sys.executable, "-B", runner.__file__, "_job_exec", directory, name, *sys.argv[2:]]))',
    '    finally:',
    '        runner._winapi.CloseHandle(job)',
  ].join('\n');
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const { status, error, signal } = spawnSync(python, ['-B', '-c', driver, runnerHome,
    process.execPath, fileURLToPath(import.meta.url), mode, count], {
    cwd: repo, env: { ...env, CODEX_PROBE_IN_JOB: '1' }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    timeout: Math.min(2 ** 31 - 1, samples * (sampleTimeoutMs + 2000) + 5000),
  });
  if (status !== 0) console.error(JSON.stringify({ mode, in_job: true, exit_code: status, signal, error: error?.message }));
  process.exitCode = status ?? 1;
} else {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
  env[pathKey] = [pwshDir, env[pathKey]].filter(Boolean).join(path.delimiter);
  const args = ['sandbox', '--permission-profile', ':workspace', '--include-managed-config',
    '-c', 'windows.sandbox=' + JSON.stringify(mode), '-C', work, '--',
    portable, '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'];
  const options = { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    timeout: sampleTimeoutMs };
  console.log(JSON.stringify({ mode, in_job: process.env.CODEX_PROBE_IN_JOB === '1', codexHome, work, samples }));
  let passed = 0;
  for (let sample = 1; sample <= samples; sample++) {
    const { status, stdout, stderr, error, signal } = spawnSync(codexBin, args, options);
    const ok = status === 0 && stdout?.trim() === '7.7.0';
    if (ok) passed++;
    console.log(JSON.stringify({ sample, ok, exit_code: status, stdout, stderr, signal, error: error?.message }));
  }
  console.log(JSON.stringify({ mode, samples, passed, failed: samples - passed, success_percent: 100 * passed / samples }));
  process.exitCode = passed === samples ? 0 : 1;
}
