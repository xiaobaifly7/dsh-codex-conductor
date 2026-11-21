import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { release, version } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createConductor, runProcess, runRunner } from '../index.mjs';
import { wslPath } from '../guard.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const state = fileURLToPath(new URL('../../state/', import.meta.url));
const distro = 'Ubuntu-24.04';
const driver = path.join(repo, 'runner', 'bench_driver.py');
const runner = path.join(repo, 'runner', 'codex_runner.py');
const native = 'native';
const wsl = 'wsl';
const modes = [native, wsl];
const model = 'codex/gpt-6.1-sol';
const modelTimeout = 150;
const outputName = 'bench-live-output.txt';
const outputText = 'conductor benchmark';
const now = () => performance.timeOrigin + performance.now();
const safeRoot = /^\/tmp\/codex-runner-winmig\.[A-Za-z0-9]+$/;
const usage = 'Usage: node bench-live.mjs [--no-model]\n';

function emit(text) {
  process.stdout.write(text + '\n', 'utf8');
}

export function execute(command, argv, { cwd, env, input, timeout = 60_000 } = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    const child = spawn(command, argv, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const finish = (code, signal, error = null) => {
      clearTimeout(timer);
      resolve({ command, argv, elapsed_ms: performance.now() - start, code, signal, error,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.unref();
      finish(null, null, 'Process timed out after ' + timeout + ' ms');
    }, timeout);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

const succeeded = result => result.code === 0 && !result.error;
const psQuote = text => "'" + text.replaceAll("'", "''") + "'";
const asFailure = (error, detail) => ({ ok: false, error, detail });

function powershell(exe, argv, options) {
  return execute(exe, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; & " + argv.map(psQuote).join(' ') + '; exit $LASTEXITCODE'], options);
}

function windowsSettings() {
  const yaml = readFileSync(path.join(repo, 'config', 'cordis.patch.yml'), 'utf8');
  const settings = Object.fromEntries([...yaml.matchAll(/^ {8}(\w+): (.+)$/gm)].map(([, key, value]) => [key, value.trim()]));
  const [, provider, url] = yaml.match(/^ {8}codexRoute:\r?\n {10}provider: "?([^"\s]+)"?\r?\n {10}baseUrl: "?([^"\s]+)"?$/m);
  return { ...settings, provider, url, pwsh: path.join(settings.pwshDir, 'pwsh.exe') };
}

function gitSettings(work, mode, count = 0) {
  const settings = {};
  for (const directory of mode === wsl ? [wslPath(work)] : [repo, work]) {
    settings['GIT_CONFIG_KEY_' + count] = 'safe.directory';
    settings['GIT_CONFIG_VALUE_' + count++] = directory.replaceAll('\\', '/').replace(/\/$/, '');
  }
  return { ...settings, GIT_CONFIG_COUNT: String(count) };
}

function childEnvironment(work) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^CODEX_(HOME$|RUNNER_)/i.test(key)));
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid GIT_CONFIG_COUNT');
  Object.assign(env, gitSettings(work, native, count));
  const inherited = (env.WSLENV ?? '').split(':').filter(name =>
    name && !/^(MAGPIE_GATEWAY_KEY|CODEX_HOME|CODEX_RUNNER_|GIT_CONFIG_)/i.test(name));
  env.WSLENV = [...inherited, 'MAGPIE_GATEWAY_KEY/u'].join(':');
  env.WSL_UTF8 = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function gitShellConfig(work, mode) {
  // Codex's default shell filtering can drop GIT_CONFIG_KEY_* because of the name.
  return '\n[shell_environment_policy.set]\n' + Object.entries(gitSettings(work, mode))
    .map(([key, value]) => key + ' = ' + JSON.stringify(value))
    .join('\n') + '\n';
}

const wslExec = (argv, options, run = execute) => run('wsl.exe', ['-d', distro, '-e', ...argv], options);

async function prepareWsl(config, env) {
  return wslExec(['sh', '-eu', '-c', [
    'root=$(mktemp -d /tmp/codex-runner-winmig.XXXXXXXX)',
    'printf "%s\\n" "$root"',
    'test "$(realpath "$root")" = "$root"',
    'for online in "$HOME/.codex" "$HOME/.local/state/codex-runner"; do',
    '  online=$(realpath -m "$online")',
    '  for private in "$root" "$root/runner" "$root/codex-home"; do',
    '    case "$private/" in "$online/"*) exit 1 ;; esac',
    '  done',
    'done',
    'mkdir -m 700 "$root/runner" "$root/codex-home" "$root/tmp"',
    'cat > "$root/codex-home/config.toml"',
  ].join('\n')], { input: config, env, timeout: 20_000 });
}

export function platform(mode, settings, work, root, baseEnv) {
  const win = mode === native;
  const cwd = win ? work : wslPath(work);
  const here = file => win ? file : wslPath(file);
  const python = win ? settings.python : 'python3';
  const runnerHome = root && (win ? path.join(root, 'runner') : root + '/runner');
  const codexHome = root && (win ? path.join(root, 'codex-home') : root + '/codex-home');
  const temp = root && (win ? path.join(root, 'tmp') : root + '/tmp');
  const env = { ...baseEnv };
  if (win) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
    env[pathKey] = [settings.pwshDir, env[pathKey]].filter(Boolean).join(path.delimiter);
    Object.assign(env, { CODEX_HOME: codexHome, TEMP: temp, TMP: temp });
  }
  const git = win ? [] : Object.entries(gitSettings(work, wsl)).map(([key, value]) => key + '=' + value);
  const p = { mode, root, cwd, env, here, python, git, codex: win ? settings.codexBin : null, settings };
  const privateEnv = ['CODEX_HOME=' + codexHome, 'TMPDIR=' + temp];
  // Capture the interactive PATH once. A timed login shell does not necessarily run .bashrc.
  const direct = (argv, timeout) => win ? powershell(settings.pwsh, argv, { cwd, env, timeout })
    : wslExec(['env', ...privateEnv, 'bash', '-lc',
      'cd -- "$1" || exit; shift; exec env "$@"', 'bench', cwd, ...privateEnv,
      ...git, ...(p.linuxPath ? ['PATH=' + p.linuxPath] : []), ...argv], { env, timeout });
  const pythonRun = args => win
    ? execute(python, ['-B', here(driver), ...args], { cwd, env, timeout: 15_000 })
    : wslExec(['env', 'PYTHONUTF8=1', p.python, '-B', here(driver), ...args], { env, timeout: 15_000 });
  const cfg = {
    runnerMode: mode, distro, python, runner: here(runner), pwshDir: settings.pwshDir,
    runnerHome, codexHome, stateDir: root && path.join(win ? root : state, 'conductor-bench'),
    runnerAgentsMd: 'bundled', reportSchema: here(path.join(repo, 'report.v2.schema.json')),
    retries: 0, timeoutSeconds: modelTimeout, idleTimeoutSeconds: 60, model, effort: 'medium',
  };
  return Object.assign(p, { cfg, direct, pythonRun });
}

function benchBridge(p, prefix) {
  return (cfg, args, opts) => runRunner(cfg, args, opts, (command, argv, options) => {
    const env = { ...options.env, ...Object.fromEntries(Object.entries(p.env).filter(([key]) =>
      key === 'WSLENV' || key.startsWith('GIT_'))), PYTHONDONTWRITEBYTECODE: '1' };
    const launcher = JSON.stringify(prefix);
    if (p.mode === native) {
      Object.assign(env, { TEMP: p.env.TEMP, TMP: p.env.TMP, CODEX_RUNNER_CMD: launcher });
      delete env.CODEX_RUNNER_ROUTER_URL;
      if (!cfg.codexRoute) {
        delete env.CODEX_RUNNER_ROUTE_URL;
        delete env.CODEX_RUNNER_ROUTE_PROVIDER;
      }
    } else {
      return wslExec(['env', 'CODEX_RUNNER_CMD=' + launcher, 'PYTHONUTF8=1',
        'PYTHONDONTWRITEBYTECODE=1', 'TMPDIR=' + p.root + '/tmp', ...p.git, ...(p.linuxPath ? ['PATH=' + p.linuxPath] : []),
        ...argv.slice(argv.indexOf('-e') + 2)], { ...options, env }, runProcess);
    }
    return runProcess(command, argv, { ...options, env });
  });
}

async function environment(p) {
  const isWin = p.mode === native;
  const result = {};
  if (!isWin) {
    const profile = await wslExec(['env', 'CODEX_HOME=' + p.cfg.codexHome, 'TMPDIR=' + p.root + '/tmp', 'bash', '-ic',
      'printf "\\nbench-path=%s\\n" "$PATH"; for tool in node python3 git rg codex; do printf "bench-%s=%s\\n" "$tool" "$(type -P "$tool")"; done'],
    { env: p.env, timeout: 15_000 });
    const found = Object.fromEntries([...profile.stdout.matchAll(/^bench-([\w]+)=(.*)$/gm)].map(([, key, value]) => [key, value]));
    result.interactive_path = succeeded(profile) && !found.path ? { ...profile, error: 'Interactive Bash did not return PATH' } : profile;
    p.linuxPath = found.path;
    p.python = p.cfg.python = found.python3 || p.python;
    const find = await p.direct([p.python, '-B', '-c',
      'from pathlib import Path; import sys; sys.path.insert(0, str(Path(sys.argv[1]).parent)); import codex_runner; print("bench-codex=" + (codex_runner.find_codex() or ""))',
      p.here(runner)], 15_000);
    // Keep the Linux runner's own executable selection, including its Windows PATH exclusion.
    if (succeeded(find)) p.codex = find.stdout.match(/^bench-codex=(.*)$/m)?.[1] || null;
    result.codex_lookup = succeeded(find) && !p.codex ? { ...find, error: 'Linux runner found no Codex executable' } : find;
    delete found.path;
    result.paths = { ...found, codex: p.codex, python3: p.python };
  }
  result.kernel = isWin ? { release: release(), version: version() } : await p.direct(['uname', '-srvm'], 15_000);
  for (const [name, executable] of Object.entries({ node: 'node', python: p.python, git: 'git', rg: 'rg', codex: p.codex })) {
    if (executable) result[name] = await p.direct([result.paths?.[name] || executable, '--version'], 15_000);
  }
  return result;
}

export function sandboxPrefix(help, p, legacyLinuxHelp = '') {
  if (help.includes('--permission-profile') && help.includes('--cd')) {
    const command = [p.codex, 'sandbox', '--permission-profile', ':workspace', '-C', p.cwd];
    if (help.includes('--include-managed-config')) command.push('--include-managed-config');
    if (p.mode === native) command.push('-c', 'windows.sandbox="elevated"');
    return [...command, '--'];
  }
  if (p.mode === wsl && /\blinux\b/i.test(help) && legacyLinuxHelp.includes('--full-auto')) {
    return [p.codex, 'sandbox', 'linux', '--full-auto', '--'];
  }
  return null;
}

async function discoverSandbox(p) {
  if (!p.codex) return { prefix: null, reason: 'Codex executable unavailable' };
  const help = await p.direct([p.codex, 'sandbox', '--help'], 15_000);
  if (!succeeded(help)) return { prefix: null, reason: 'codex sandbox --help failed', help };
  const text = help.stdout + help.stderr;
  let prefix = sandboxPrefix(text, p);
  let linuxHelp;
  if (!prefix && p.mode === wsl && /\blinux\b/i.test(text)) {
    linuxHelp = await p.direct([p.codex, 'sandbox', 'linux', '--help'], 15_000);
    if (succeeded(linuxHelp)) prefix = sandboxPrefix(text, p, linuxHelp.stdout + linuxHelp.stderr);
  }
  return { prefix, help, linuxHelp, ...(!prefix && { reason: 'No workspace-write sandbox entry in local --help' }) };
}

async function readJob(p, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw Error('Invalid runner job ID: ' + id);
  const result = await p.pythonRun(['job', p.cfg.runnerHome + '/jobs/' + id]);
  if (!succeeded(result)) throw Error(result.error || result.stderr || result.stdout || 'Could not read runner job');
  return JSON.parse(result.stdout);
}

async function clockCalibration(p) {
  if (p.mode === native) return { offset_ms: 0, uncertainty_ms: 0 };
  const before = now();
  const clock = await p.pythonRun(['clock']);
  const after = now();
  const linux = Number(clock.stdout.trim());
  return succeeded(clock) && linux > 0
    ? { offset_ms: linux - (before + after) / 2, uncertainty_ms: (after - before) / 2, clock }
    : { offset_ms: null, uncertainty_ms: null, clock };
}

function fakeTimings(logs, receiptToHost, started, offset) {
  const { entered_epoch_ms: entered, exiting_epoch_ms: exiting } = JSON.parse(logs['bench-fake.json']);
  const phases = Object.fromEntries(logs['events.jsonl'].trim().split(/\r?\n/).map(line => JSON.parse(line))
    .filter(event => event.type === 'runner.phase').map(event => [event.phase, event.time * 1000]));
  const worker = logs.worker_epoch_ms;
  return {
    dispatch_to_worker_birth_ms: offset === null || worker === undefined ? null : worker - offset - started,
    worker_birth_to_attempt_ms: worker === undefined ? null : phases.codex_running - worker,
    attempt_to_fake_entry_ms: entered - phases.codex_running,
    fake_entry_to_exit_ms: exiting - entered,
    fake_exit_to_finalizing_ms: phases.finalizing - exiting,
    finalizing_to_receipt_ms: logs.receipt_epoch_ms - phases.finalizing,
    receipt_to_host_ms: receiptToHost,
  };
}

export async function dispatch(p, args, fake) {
  const cfg = { ...p.cfg, ...(fake ? { reportSchema: '', model: '', effort: '' } : {
    codexRoute: { provider: p.settings.provider, baseUrl: p.mode === native ? p.settings.url : 'http://127.0.0.1:3426/v1' },
  }) };
  const prefix = [p.python, '-B', p.here(driver), ...(fake ? ['FAKE_CODEX'] : ['trace', p.codex])];
  const conductor = createConductor(cfg, benchBridge(p, prefix));
  const started = now();
  const first = await conductor.start(args, p.cwd);
  const dispatchMs = now() - started;
  if (!first.job_id) {
    if (first.error_kind === 'bridge_error') p.unconfirmed = true;
    return { ...asFailure(first.error || first.error_kind || 'No job ID returned', first),
      metrics: { dispatch_ms: dispatchMs } };
  }
  const receipt = await conductor.waitJob(first.job_id, fake ? 15 : modelTimeout + 25);
  const totalMs = now() - started;
  let cancel;
  if (!['completed', 'failed', 'cancelled'].includes(receipt.status) ||
      ['bridge_error', 'worker_died', 'executor_lost', 'process_cleanup_failed', 'unknown_job', 'invalid_record'].includes(receipt.error_kind)) {
    cancel = await conductor.cancel(first.job_id);
    if (cancel.status !== 'cancelled' && cancel.status !== 'completed') p.unconfirmed = true;
  }
  const metrics = { dispatch_ms: dispatchMs, total_ms: totalMs };
  const common = { job_id: first.job_id, started_epoch_ms: started, receipt, cancel, metrics };
  try {
    const logs = await readJob(p, first.job_id);
    if (p.clock.offset_ms !== null && Number.isFinite(logs.receipt_epoch_ms)) {
      metrics.to_receipt_ms = logs.receipt_epoch_ms - p.clock.offset_ms - started;
    }
    if (receipt.status !== 'completed') {
      return { ...common, logs, ...asFailure(receipt.error || receipt.error_kind || receipt.status) };
    }
    if (fake) Object.assign(metrics, fakeTimings(logs, metrics.to_receipt_ms === undefined ? null : totalMs - metrics.to_receipt_ms,
      started, p.clock.offset_ms));
    return { ...common, ok: true, logs };
  } catch (error) {
    return { ...common, ...asFailure(error.message) };
  }
}

export function modelTimings(logs, started, offset, total, expectedCommands) {
  const trace = JSON.parse(logs['bench-events.json']);
  const events = logs['events.jsonl'].split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) && value.type !== 'runner.phase' ? [value] : [];
    } catch { return []; }
  });
  if (events.length !== trace.events_ms.length) throw Error('Codex events and timestamp sidecar disagree');
  const command = [];
  let turnCompleted;
  for (const [index, event] of events.entries()) {
    const ms = trace.events_ms[index];
    if (event.type === 'turn.completed') turnCompleted = ms;
    if (event.item?.type !== 'command_execution') continue;
    if (event.type === 'item.started') {
      if (command.length && command.at(-1).ended_ms === undefined) throw Error('Concurrent commands in a sequential sample');
      command.push({ id: event.item.id, command: event.item.command, started_ms: ms });
    } else if (event.type === 'item.completed') {
      const current = command.at(-1);
      if (!current || current.id !== event.item.id || current.ended_ms !== undefined) throw Error('Unmatched command event');
      Object.assign(current, { ended_ms: ms, elapsed_ms: ms - current.started_ms, exit_code: event.item.exit_code,
        first_output_line: (event.item.aggregated_output ?? '').split(/\r?\n/, 1)[0] });
    }
  }
  const normalize = text => text.replace(/["'\\\x60]/g, '').replace(/\s+/g, ' ').trim();
  if (command.length !== expectedCommands.length ||
      command.some((item, i) => item.exit_code !== 0 || !normalize(item.command ?? '').includes(normalize(expectedCommands[i])))) {
    throw Error('Expected five successful, ordered benchmark commands; observed ' + JSON.stringify(command));
  }
  const first = trace.events_ms[0];
  if (!Number.isFinite(turnCompleted) || !Number.isFinite(first) || turnCompleted < command.at(-1).ended_ms) {
    throw Error('Missing or inconsistent turn completion timing');
  }
  const commandMs = command.reduce((sum, item) => sum + item.elapsed_ms, 0);
  const toLaunch = offset === null ? null : trace.launch_epoch_ms - offset - started;
  return {
    commands: command, trace,
    metrics: { dispatch_to_launch_ms: toLaunch, launch_to_first_event_ms: first, commands_ms: commandMs,
      model_and_other_ms: turnCompleted - first - commandMs,
      post_turn_to_observed_receipt_ms: toLaunch === null ? null : total - toLaunch - turnCompleted },
  };
}

function modelCommands(search) {
  return [
    'git status --porcelain',
    'git log --oneline -5',
    search.join(' '),
    'node -p "JSON.parse(require(\'fs\').readFileSync(\'package.json\',\'utf8\')).version"',
    'node -e "require(\'fs\').writeFileSync(\'' + outputName + '\',\'' + outputText +
      '\'); console.log(\'' + outputText + '\')"',
  ];
}

const cases = [
  { id: 'A.doctor', count: 10, fields: ['total_ms'] },
  { id: 'A.fake', count: 10, fields: ['dispatch_ms', 'to_receipt_ms', 'total_ms', 'dispatch_to_worker_birth_ms',
    'worker_birth_to_attempt_ms', 'attempt_to_fake_entry_ms', 'fake_entry_to_exit_ms', 'fake_exit_to_finalizing_ms',
    'finalizing_to_receipt_ms', 'receipt_to_host_ms'] },
  ...['shell', 'cmd', 'status', 'log', 'search', 'read', 'write', 'tests'].map(key =>
    ({ id: 'B.' + key, count: 5, fields: ['total_ms'], ...(key === 'cmd' && { modes: [native] }) })),
  ...['status', 'search', 'write'].map(key => ({ id: 'B.sandbox.' + key, count: 5, fields: ['total_ms'] })),
  { id: 'C.model', count: 5, fields: ['total_ms', 'dispatch_ms', 'to_receipt_ms', 'dispatch_to_launch_ms',
    'launch_to_first_event_ms', 'commands_ms', 'model_and_other_ms', 'post_turn_to_observed_receipt_ms'] },
];

export async function measure(samples, run, noModel) {
  for (const { id, count, modes: targets = modes } of cases) {
    if (noModel && id.startsWith('C.')) continue;
    for (let sample = 1; sample <= count; sample++) {
      for (const mode of targets) {
        const attempts = [];
        // The ten C slots are also the ceiling on real model dispatches.
        const max = id === 'C.model' ? 1 : 2;
        for (let attempt = 1; attempt <= max; attempt++) {
          let result;
          try { result = await run(id, mode, sample); }
          catch (error) { result = asFailure(error.message); }
          attempts.push(result);
          if (result.ok || result.skipped || result.no_retry) break;
        }
        const last = attempts.at(-1);
        samples.push({ id, mode, sample, retried: attempts.length > 1,
          status: last.ok ? 'ok' : last.skipped ? 'skipped' : 'failed', attempts });
      }
    }
  }
}

export function summarize(samples) {
  const stats = (id, mode, field) => {
    const records = samples.filter(sample => sample.id === id && sample.mode === mode);
    const values = records.filter(sample => sample.status === 'ok')
      .map(sample => sample.attempts.at(-1).metrics[field]).filter(Number.isFinite).sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return { n: values.length, failed: records.filter(sample => sample.status === 'failed').length,
      skipped: records.filter(sample => sample.status === 'skipped').length, min_ms: values[0] ?? null,
      max_ms: values.at(-1) ?? null,
      median_ms: values.length ? (values[mid] + values[(values.length - 1) >> 1]) / 2 : null };
  };
  return cases.filter(({ id }) => samples.some(sample => sample.id === id)).flatMap(({ id, fields }) => fields.map(metric => {
    const win = stats(id, native, metric);
    const linux = stats(id, wsl, metric);
    return { id, metric, native: win, wsl: linux,
      wsl_over_native: win.median_ms > 0 && linux.median_ms !== null ? linux.median_ms / win.median_ms : null };
  }));
}

function problem(result) {
  if (!result) return '';
  return [result.error, result.stderr?.trim(), result.code != null && result.code !== 0 ? 'exit ' + result.code : null]
    .filter(Boolean).join(' / ');
}

export function printTable(results) {
  const ms = x => x === null ? '—' : x.toFixed(1);
  const column = p => ms(p.median_ms) + ' [' + ms(p.min_ms) + ', ' + ms(p.max_ms) + '] (n=' + p.n + ')';
  const problems = (id, mode) => [...new Set(results.samples.filter(s => s.id === id && s.mode === mode)
    .flatMap(s => s.attempts.filter(a => !a.ok).map(a => [a.reason || a.error, problem(a.result || a.detail)]
      .filter(Boolean).join(' / ') || '失败')))];
  const diagnostics = {};
  const rowError = (label, error) => emit([label, '—', '—', '—', error.replace(/\r?\n/g, '\\n')].join('\t'));
  emit('项目 / 指标\tNative 中位数 [最小, 最大] ms\tWSL 中位数 [最小, 最大] ms\tWSL/Native\t错误/跳过');
  for (const mode of modes) {
    const info = results.environment[mode];
    diagnostics[mode] = [];
    const checks = { ...info?.versions, sandbox_help: info?.sandbox?.help, sandbox_linux_help: info?.sandbox?.linuxHelp,
      setup: mode === wsl ? results.wsl_setup : undefined };
    for (const [name, result] of Object.entries(checks)) {
      if (result && 'code' in result && !succeeded(result)) {
        diagnostics[mode].push(name + ': ' + problem(result));
        rowError('环境 / ' + mode + ' ' + name, problem(result));
      }
    }
  }
  for (const error of results.errors) rowError('初始化', error);
  const shown = new Set();
  for (const row of results.summary) {
    const errors = shown.has(row.id) ? [] : modes.flatMap(mode => problems(row.id, mode).map(error => mode + ': ' + error));
    shown.add(row.id);
    emit([row.id + ' / ' + row.metric, column(row.native), column(row.wsl),
      row.wsl_over_native === null ? '—' : row.wsl_over_native.toFixed(2) + 'x', errors.join(' | ').replace(/\r?\n/g, '\\n')].join('\t'));
  }
  for (const mode of modes) {
    for (const layer of results.no_model ? ['B'] : ['B', 'C']) {
      const rows = results.summary.filter(row => row.id.startsWith(layer + '.'));
      if (rows.some(row => row[mode].n > 0)) continue;
      const errors = [...new Set([...rows.flatMap(row => problems(row.id, mode)), ...diagnostics[mode], ...results.errors])];
      emit(mode + ' ' + layer + ' 层无数据：' + (errors.join(' | ') || '没有可用样本').replace(/\r?\n/g, '\\n'));
    }
  }
}

async function prepareClone(work, env) {
  const git = (args, cwd = repo) => execute('git', args, { cwd, env });
  const head = await git(['rev-parse', 'HEAD']);
  if (!succeeded(head)) throw Error(head.error || head.stderr);
  const expected = head.stdout.trim();
  if (!existsSync(work)) {
    const cloned = await git(['clone', '--no-local', '--', repo, work]);
    if (!succeeded(cloned)) throw Error(cloned.error || cloned.stderr);
  }
  if (path.relative(work, realpathSync.native(work))) throw Error('bench-work resolves outside its expected path');
  const origin = await git(['config', '--local', '--get', 'remote.origin.url'], work);
  const top = await git(['rev-parse', '--show-toplevel'], work);
  const current = await git(['rev-parse', 'HEAD'], work);
  if (!succeeded(origin) || path.relative(repo, origin.stdout.trim()) ||
      !succeeded(top) || path.relative(work, top.stdout.trim()) || !succeeded(current)) {
    throw Error('bench-work must be a clone of this repository. ' + [origin, top, current].map(problem).filter(Boolean).join(' | '));
  }
  const clean = await git(['--no-optional-locks', 'status', '--porcelain'], work);
  if (!succeeded(clean) || clean.stdout.trim()) throw Error('bench-work is not clean: ' + (clean.error || clean.stderr || clean.stdout));
  if (existsSync(path.join(work, outputName))) throw Error('Benchmark output path already exists');
  if (current.stdout.trim() !== expected) {
    const fetched = await git(['fetch', '--no-tags', 'origin', expected], work);
    if (!succeeded(fetched)) throw Error('bench-work fetch: ' + problem(fetched));
    const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', expected], work);
    if (!succeeded(ancestor)) throw Error('bench-work cannot fast-forward to ' + expected + ': ' + problem(ancestor));
    const checkout = await git(['checkout', '--detach', expected], work);
    if (!succeeded(checkout)) throw Error('bench-work checkout: ' + problem(checkout));
  }
  return expected;
}

async function cleanupWsl(root, env) {
  if (!safeRoot.test(root)) return { ok: false, error: 'Unrecognized WSL temporary root', root };
  const result = await wslExec(['sh', '-eu', '-c', [
    'test -d "$1" && test "$(realpath "$1")" = "$1"',
    'for online in "$HOME/.codex" "$HOME/.local/state/codex-runner"; do',
    '  case "$1/" in "$(realpath -m "$online")/"*) exit 1 ;; esac',
    'done',
    'rm -rf -- "$1"',
    'test ! -e "$1"',
  ].join('\n'), 'bench-cleanup', root], { env, timeout: 20_000 });
  return { ok: succeeded(result), root, result };
}

function bCommand(p, id, search, scratch) {
  return {
    status: ['git', 'status', '--porcelain'],
    log: ['git', 'log', '--oneline', '-200'],
    search,
    read: [p.python, '-B', p.here(driver), 'read'],
    write: [p.python, '-B', p.here(driver), 'write', scratch],
    tests: ['node', '--test', 'guard.test.mjs'],
    shell: ['bash', '-c', 'true'],
  }[id];
}

export async function sampleCommand(p, id, search, scratch) {
  const sandbox = id.startsWith('B.sandbox.');
  const name = id.split('.').at(-1);
  if (sandbox && !p.sandbox.prefix) return { skipped: true, reason: p.sandbox.reason };
  const result = name === 'cmd'
    ? await execute('cmd.exe', ['/d', '/c', 'exit'], { cwd: p.cwd, env: p.env })
    : name === 'shell' && p.mode === native
      ? await execute(p.settings.pwsh, ['-NoProfile', '-Command', 'exit'], { cwd: p.cwd, env: p.env })
      : await p.direct([...(sandbox ? p.sandbox.prefix : []), ...bCommand(p, name, search, scratch)]);
  return { ok: succeeded(result), metrics: { total_ms: result.elapsed_ms }, result };
}

async function sampleModel(p, search, work) {
  if (!process.env.MAGPIE_GATEWAY_KEY) return { skipped: true, reason: 'MAGPIE_GATEWAY_KEY unavailable' };
  const unavailable = ['codex', 'node', 'git'].filter(tool => !p.versions[tool] || !succeeded(p.versions[tool]));
  if (unavailable.length) return { skipped: true, reason: 'Unavailable: ' + unavailable.join(', ') };
  const output = path.join(work, outputName);
  rmSync(output, { force: true });
  const clock = await clockCalibration(p);
  p.clock = clock;
  const commands = modelCommands(search);
  const measurement = await dispatch(p, {
    task: '在当前工作目录按下列顺序，用五次独立的 shell 工具调用逐条执行。每条只运行一次，等前一条完成再执行下一条。' +
      '除此之外不调用工具、不读其他文件、不重试。只允许创建 ' + outputName + '。' +
      '在最终报告的五项 evidence 中逐条原样记录对应命令的输出首行，没有输出就写空字符串。\n' +
      commands.map((command, index) => (index + 1) + '. ' + command).join('\n'),
    acceptance: commands.map((_, i) => '按顺序执行第 ' + (i + 1) + ' 条命令并报告输出首行'),
    scope: [outputName], write: true,
  }, false);
  measurement.clock = clock;
  if (!measurement.ok) return measurement;
  try {
    const timing = modelTimings(measurement.logs, measurement.started_epoch_ms, p.clock.offset_ms,
      measurement.metrics.total_ms, commands);
    if (!lstatSync(output).isFile() || path.relative(output, realpathSync.native(output)) ||
        readFileSync(output, 'utf8') !== outputText) throw Error('Benchmark file content mismatch');
    if (measurement.receipt.sandbox !== 'workspace-write' || measurement.receipt.report_status !== 'valid') {
      throw Error('Expected a workspace-write receipt with a valid report');
    }
    return { ...measurement, ...timing, metrics: { ...measurement.metrics, ...timing.metrics } };
  } catch (error) {
    return { ...measurement, ...asFailure(error.message) };
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(usage, 'utf8');
    return;
  }
  if (argv.length && !(argv.length === 1 && argv[0] === '--no-model')) {
    process.stderr.write(usage, 'utf8');
    process.exitCode = 2;
    return;
  }
  if (process.platform !== 'win32') throw Error('bench-live requires a Windows host');
  if (path.relative(state, realpathSync.native(state))) throw Error('The benchmark state directory must be local');
  const home = path.join(state, 'bench');
  mkdirSync(home, { recursive: true });
  if (path.relative(home, realpathSync.native(home))) throw Error('The benchmark results directory must be local');
  const directory = mkdtempSync(path.join(home, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  const work = path.join(state, 'bench-work');
  const scratch = '.bench-live-files-' + path.basename(directory);
  const noModel = argv[0] === '--no-model';
  const results = {
    started_at: new Date().toISOString(), no_model: noModel, work: { native: work, wsl: wslPath(work) },
    design: { model, effort: 'medium', service_tier: 'default (standard, no override)', real_dispatch_limit: noModel ? 0 : 10,
      notes: {
        A: 'Actual bridge, no router checks. Doctor uses real --version without --sandbox. Fake worker birth is the runner PID creation record (WSL rounded to a kernel tick). Fake timestamps mark Python script entry and exit handler. Finalizing to receipt uses the result file mtime, a proxy taken when the payload is written before rename. Receipt to host includes status startup/polling and any gap before rename. Cross-clock intervals use the clock probe midpoint and its uncertainty.',
        B: 'Times include outer shell startup and, on WSL, wsl.exe. Read walks and reads all regular files including .git. Write creates, closes and deletes 500 files without fsync.',
        C: 'Fresh task each time. Host total includes bridge and receipt observation. Timestamps are observed JSON output. Command spans include CLI/tool scheduling around the command. Model and other is non-command time between first event and turn.completed, including model, network and CLI work. Windows/WSL launch alignment uses the clock probe midpoint and its uncertainty.',
      },
    },
    environment: {}, samples: [], cleanup: {}, errors: [],
  };
  const platforms = {};
  let env;
  let wslRoot;
  let cloneReady = false;
  try {
    env = childEnvironment(work);
    env.TEMP = env.TMP = directory;
    const settings = windowsSettings();
    results.revision = await prepareClone(work, env);
    cloneReady = true;
    const toml = readFileSync(path.join(repo, 'config', 'codex.native.toml'), 'utf8');
    const winRoot = path.join(directory, 'native');
    for (const key of ['runner', 'codex-home', 'tmp']) mkdirSync(path.join(winRoot, key), { recursive: true });
    writeFileSync(path.join(winRoot, 'codex-home', 'config.toml'), toml + gitShellConfig(work, native), 'utf8');
    platforms.native = platform(native, settings, work, winRoot, env);
    const setup = await prepareWsl(toml.split('[windows]')[0].replace(settings.url, 'http://127.0.0.1:3426/v1') +
      gitShellConfig(work, wsl), env);
    const candidate = setup.stdout.split(/\r?\n/).map(line => line.trim()).find(line => safeRoot.test(line)) ?? '';
    if (safeRoot.test(candidate)) wslRoot = candidate;
    results.wsl_setup = setup;
    if (succeeded(setup) && wslRoot) platforms.wsl = platform(wsl, settings, work, wslRoot, env);
    for (const p of Object.values(platforms)) {
      p.versions = await environment(p);
      p.sandbox = await discoverSandbox(p);
      p.clock = await clockCalibration(p);
      results.environment[p.mode] = { versions: p.versions, sandbox: p.sandbox, clock: p.clock,
        codex: p.codex, python: p.python, ...(p.mode === native && { pwsh: p.settings.pwsh }) };
    }
    // Git runs inside both sandboxes; the Windows sandbox cannot launch rg from the host PATH.
    const search = ['git', 'grep', '-c', 'codex'];
    results.search = search;
    await measure(results.samples, async (id, mode) => {
      const p = platforms[mode];
      if (!p) return { skipped: true, reason: 'Platform setup failed' };
      if (id.startsWith('B.')) return sampleCommand(p, id, search, scratch);
      if (id === 'C.model' && Object.values(platforms).some(platform => platform.unconfirmed)) {
        return { skipped: true, reason: 'The shared workspace has a task whose termination is unconfirmed' };
      }
      if (p.unconfirmed) return { skipped: true, reason: 'An earlier task could not be confirmed stopped' };
      if (id === 'A.doctor') {
        if (!p.codex) return { skipped: true, reason: 'Codex executable unavailable' };
        const start = now();
        const result = await benchBridge(p, [p.codex])(p.cfg, ['doctor'], { timeoutMs: 30_000 });
        return { ok: result.ok === true, metrics: { total_ms: now() - start }, result };
      }
      if (id === 'A.fake') return dispatch(p, { task: 'No-op benchmark stub', acceptance: ['Empty fake task'], write: false }, true);
      return sampleModel(p, search, work);
    }, noModel);
  } catch (error) {
    results.errors.push(error.message);
  } finally {
    try {
      if (wslRoot) results.cleanup.wsl = platforms.wsl?.unconfirmed
        ? { ok: false, root: wslRoot, error: 'Retained because task termination could not be confirmed' }
        : await cleanupWsl(wslRoot, env);
    } catch (error) { results.cleanup.wsl = { ok: false, root: wslRoot, error: error.message }; }
    try {
      if (cloneReady && !Object.values(platforms).some(p => p.unconfirmed)) {
        if (path.relative(work, realpathSync.native(work))) throw Error('bench-work moved before cleanup');
        rmSync(path.join(work, outputName), { force: true });
        const files = path.join(work, scratch);
        if (existsSync(files)) {
          if (path.relative(files, realpathSync.native(files))) throw Error('Scratch directory resolves outside its expected path');
          rmSync(files, { recursive: true, force: true });
        }
        const clean = await execute('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: work, env });
        results.cleanup.work = { ok: succeeded(clean) && !clean.stdout.trim(), clean };
      } else if (cloneReady) results.cleanup.work = { ok: false, error: 'Retained because task termination could not be confirmed' };
    } catch (error) { results.cleanup.work = { ok: false, error: error.message }; }
    results.finished_at = new Date().toISOString();
    results.summary = summarize(results.samples);
    const file = path.join(directory, 'results.json');
    const secret = process.env.MAGPIE_GATEWAY_KEY;
    const data = JSON.stringify(results, (_, value) => secret && typeof value === 'string'
      ? value.replaceAll(secret, '[redacted]') : value, 2);
    writeFileSync(file, data + '\n', 'utf8');
    printTable(secret ? JSON.parse(data) : results);
    if (results.search) emit('Search:\t' + results.search.join(' '));
    emit('Cleanup:\t' + Object.entries(results.cleanup).map(([key, value]) => key + '=' + (value.ok ? 'ok' : 'failed')).join('\t'));
    emit('JSON:\t' + file);
    if (results.errors.length || results.samples.some(sample => sample.status !== 'ok') ||
        Object.values(results.cleanup).some(value => !value.ok)) process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
