
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.mjs';
import { prepareNativeTest } from './native-test-config.mjs';

const scenario = process.argv[2] ?? 'write';
const id = process.argv[3];
const timingOut = scenario === 'timeout';
const exitMinusOne = scenario === 'exit-minus-one';
const mode = scenario === 'burst' || timingOut ? id : undefined;
const orphan = scenario === 'cancel-orphan';
const background = scenario === 'background';
const cancelling = scenario === 'cancel' || orphan;
if (!['write', 'write-patch', 'verify', 'pwsh', 'read', 'resume', 'cancel', 'cancel-orphan', 'background', 'burst', 'timeout', 'exit-minus-one', 'doctor'].includes(scenario) ||
    (['verify', 'resume'].includes(scenario) && !id) ||
    (mode !== undefined && !['elevated', 'unelevated'].includes(mode))) {
  throw Error('Usage: node native-live-e2e.mjs doctor|write|pwsh|read|cancel|cancel-orphan|background|verify <job>|resume <thread>|burst|timeout [elevated|unelevated]|exit-minus-one');
}
const { yaml, settings, work, portable } = prepareNativeTest();
const repo = fileURLToPath(new URL('../', import.meta.url));
const { runnerMode, python, codexBin, pwshDir, runnerHome, codexHome, stateDir, model, effort, readOnlyEffort } = settings;
const bundledKey = Object.keys(settings).find(key => settings[key] === 'bundled');
const [, provider, baseUrl] = yaml.match(/^ {8}codexRoute:\r?\n {10}provider: "?([^"\s]+)"?\r?\n {10}baseUrl: "?([^"\s]+)"?$/m);
const timeoutSeconds = timingOut ? 45 : scenario === 'verify' ? 300 : cancelling || scenario === 'burst' ? 180 : 75;
const idleTimeoutSeconds = scenario === 'burst' ? 45 : undefined;
if (mode) process.env.CODEX_RUNNER_CMD = JSON.stringify([codexBin, '-c', 'windows.sandbox=' + JSON.stringify(mode)]);
const tools = {};
const ctx = { tools: { register(t) { tools[t.name] = t; }, guard() {} }, on() {}, logger: { warn: console.warn } };
const exec = { agent: { id: 'windows-native-live', session: { header: { cwd: work }, log: [] } } };
apply(ctx, {
  runnerMode, python, codexBin: mode ? '' : codexBin, pwshDir, runnerHome, codexHome, stateDir, model, effort, readOnlyEffort,
  codexRoute: { provider, baseUrl }, [bundledKey]: 'bundled', workspaces: [work],
  allowHostAccess: background,
  autoResume: { enabled: false }, autoVerify: 'off', closeoutGuard: false, retries: 0, timeoutSeconds, idleTimeoutSeconds,
});
const call = (name, args, signal) => tools[name].execute(args, { ...exec, signal });
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n', 'utf8');
const pwshCommand = "& '" + portable.replaceAll('\\', '/') + "' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'";
const pwshTask = '在当前 workspace-write 沙箱内各执行一次并记录真实输出和退出状态。命令一：' +
  pwshCommand + '。命令二：pwsh -NoProfile -Command ' +
  "'$PSVersionTable.PSVersion.ToString()'。失败就记录原始错误，不重试、不修改 PATH。";
const args = {
  task: '在 cwd 创建 native-live.txt，UTF-8 无 BOM，唯一内容为「原生验证」。只写该文件。然后执行以下检查。' + pwshTask,
  acceptance: ['文件内容严格为原生验证', '实测两条 PowerShell 启动命令并报告原始输出'],
  must_verify: [1], write: true, scope: ['native-live.txt'], wait_seconds: 0,
};
if (scenario === 'pwsh') Object.assign(args, {
  task: pwshTask + '不写入文件。',
  acceptance: ['如实记录两次调用的原始输出或工具错误'], must_verify: [], scope: [],
});
if (scenario === 'burst') Object.assign(args, {
  task: '在当前 workspace-write 沙箱中用 5 次独立的 shell 工具调用顺序执行以下同一条命令，每次只执行一次：\n' +
    pwshCommand + '\n等待本次返回后再发下一次。失败也继续下一次并保留原始错误。禁止并行、循环、合并命令或重试。不写文件。',
  acceptance: ['完成 5 次独立的顺序调用，逐条报告退出码和完整输出或原始工具错误'], must_verify: [], scope: [],
});
if (scenario === 'write-patch') Object.assign(args, {
  task: '仅使用内建 apply_patch 创建 native-live.txt，UTF-8 无 BOM，唯一内容为「原生验证」。禁止使用 shell 或其他写入工具。',
  acceptance: ['仅用内建编辑工具将原生验证写入指定文件'], must_verify: [],
});
if (scenario === 'read') Object.assign(args, {
  task: '只读任务，不调用工具、不写文件。在摘要中逐字回显「原生验证」这四个字。',
  acceptance: ['原样回显中文原生验证'], must_verify: [], write: false, scope: [],
});
if (scenario === 'resume') Object.assign(args, {
  task: '同线程续接。在当前线程报告上轮写出的文件名，禁止写新文件。',
  acceptance: ['同线程报告上一轮文件名'], must_verify: [], resume: id, scope: [],
});
if (scenario === 'cancel') Object.assign(args, {
  task: "在前台运行 & '" + python + "' -B -c 'import time; time.sleep(120)'，命令超时设为至少 125 秒。" +
    '等待命令结果再回报。不写文件、不执行其他命令。',
  acceptance: ['启动指定的 Python 长命令并保持前台运行'], must_verify: [], write: false, scope: [],
});
if (timingOut) Object.assign(args, {
  task: '现在用一次 shell 工具调用前台执行 Start-Sleep -Seconds 120，yield_time_ms=1000。等待命令结束。不写文件。',
  acceptance: ['启动并等待该前台命令'], must_verify: [], write: true, scope: [],
});
const exitMarker = 'native-exit-minus-one';
if (exitMinusOne) Object.assign(args, {
  task: '在 workspace-write 沙箱当前工作目录只执行一次以下 PowerShell 工具命令，不写文件：\n' +
    `Write-Output '${exitMarker}'; exit -1\n` +
    '这是预期的非零退出。请根据工具结果直接提交报告，不要包装命令、重试或再调用工具。',
  acceptance: ['运行指定命令一次，记录标记与预期的非零退出，然后直接提交报告'], must_verify: [], scope: [],
});
const orphanMarker = orphan || background ? scenario + '-' + randomUUID() + '.json' : undefined;
if (orphan || background) {
  const code = 'import json, os, subprocess, sys; from pathlib import Path; ' +
    'child = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(120)"], ' +
    'stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); ' +
    `Path("${orphanMarker}").write_text(json.dumps({"parent": os.getpid(), "child": child.pid, "user": os.getlogin()}))`;
  const launch = `& '${python}' -B -c '${code}'`;
  Object.assign(args, {
    task: background
      ? `在当前工作目录只运行一次以下命令。命令返回后直接提交报告，保留后台进程，只允许写指定标记文件。\n${launch}`
      : `在 workspace-write 沙箱用一条前台命令执行，workdir 为当前目录，yield_time_ms=1000：\n` +
        `${launch}; Start-Sleep -Seconds 120\n` +
        'Python 启动的父进程应先退出，子进程保持运行。等待命令结束，只允许写指定标记文件。',
    acceptance: ['启动指定父子进程并保留 PID 标记'], must_verify: [], write: true, scope: [orphanMarker],
  });
}
if (background) args.host_access = true;

function snapshot(job) {
  const result = spawnSync(python, ['-B', '-c',
    'import json, os, sys; from runner.codex_runner import windows_job_pids, windows_processes; ' +
    'print(json.dumps([list(windows_processes()), windows_job_pids(sys.argv[1]), os.getlogin()]))', job],
  { cwd: repo, encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.status !== 0) throw Error(result.error?.message ?? result.stderr);
  const [rows, members, user] = JSON.parse(result.stdout);
  return { rows: rows.map(([pid, ppid, name]) => ({ pid, ppid, name })), members, user };
}

async function waitForResult(jobId) {
  const wait = timeoutSeconds + 20;
  const signal = AbortSignal.timeout((wait + 10) * 1000);
  let result;
  try {
    result = await call('codex_status', { job_id: jobId, wait_seconds: wait }, signal);
  } catch (error) {
    if (!signal.aborted && error.code !== 'query_timeout') throw error;
    result = { status: 'running', error: error.message };
  }
  if (result.status !== 'running' && result.error_kind !== 'bridge_error') return result;
  // The observer's deadline is distinct from an authoritative timeout receipt from the runner.
  const cleanup = await call('codex_cancel', { job_id: jobId });
  return { job_id: jobId, status: 'failed', error_kind: result.error_kind ?? 'e2e_wait_timeout',
    error: result.error ?? 'Test wait expired while the runner was still active',
    cleanup: { status: cleanup.status, error_kind: cleanup.error_kind, error: cleanup.error } };
}

async function observeTimeoutCommand(job, signal) {
  while (!signal.aborted) {
    if ([...commandEvents(job)].some(event => event.type === 'item.started' &&
        /\bStart-Sleep\s+-Seconds\s+120\b/i.test(event.item.command))) {
      const { rows, members } = snapshot(job);
      if (rows.some(row => members.includes(row.pid) && row.name.toLowerCase() === 'pwsh.exe')) {
        return rows.filter(row => members.includes(row.pid));
      }
    }
    await delay(500);
  }
  return [];
}

async function cancelAndProve(jobId) {
  const job = path.join(runnerHome, 'jobs', jobId);
  const worker = Number(readFileSync(path.join(job, 'worker.pid'), 'utf8'));
  let before = [];
  let sawLongCommand = false;
  let observedOrphan;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { rows, members, user } = snapshot(job);
      before = rows.filter(row => row.pid === worker);
      for (const parent of before) before.push(...rows.filter(row => row.ppid === parent.pid && !before.includes(row)));
      before.push(...rows.filter(row => members.includes(row.pid) && !before.includes(row)));
      const codex = before.find(row => row.name.toLowerCase() === 'codex.exe');
      if (orphan && existsSync(path.join(work, orphanMarker))) {
        const marker = readFileSync(path.join(work, orphanMarker), 'utf8');
        const ids = marker.endsWith('}') && JSON.parse(marker);
        if (ids) {
          const parentExited = !rows.some(row => row.pid === ids.parent);
          const child = rows.find(row => row.pid === ids.child && row.ppid === ids.parent);
          const childInJob = child && members.includes(child.pid);
          const crossAccount = ids.user.toLowerCase() !== user.toLowerCase();
          observedOrphan = { ...ids, parentExited, childInJob: Boolean(childInJob), crossAccount, jobMembers: members };
          if (child && !before.includes(child)) before.push(child);
          sawLongCommand = Boolean(codex && parentExited && childInJob && crossAccount);
        }
      } else if (!orphan && codex) {
        const descendants = new Set([codex.pid]);
        for (const row of before) if (descendants.has(row.ppid)) descendants.add(row.pid);
        sawLongCommand = before.some(row => descendants.has(row.pid) && row.name.toLowerCase() === 'python.exe');
      }
      if (sawLongCommand) break;
      if ((await call('codex_status', { job_id: jobId, wait_seconds: 0 })).status !== 'running') break;
      await delay(500);
    }
  } finally {
    const result = await call('codex_cancel', { job_id: jobId });
    const after = snapshot(job).rows.filter(row => before.some(previous => previous.pid === row.pid));
    print({ scenario, job_id: jobId, status: result.status, before, after, sawLongCommand,
      orphan: observedOrphan, marker: orphanMarker, kind: result.error_kind, error: result.error });
    if (!sawLongCommand || result.status !== 'cancelled' || after.length) process.exitCode = 1;
  }
}

function* commandEvents(job) {
  const file = path.join(job, 'events.jsonl');
  for (const line of existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []) {
    let event;
    try { event = JSON.parse(line); } catch { continue; } // Runner also logs non-JSON stdout.
    if (event.item?.type === 'command_execution') yield event;
  }
}

function burstResults(jobId) {
  const commands = new Map();
  const active = new Set();
  let sequential = true;
  for (const { type, item } of commandEvents(path.join(runnerHome, 'jobs', jobId))) {
    if (type === 'item.started') {
      sequential &&= active.size === 0 && !commands.has(item.id);
      active.add(item.id);
      commands.set(item.id, item);
    } else if (type === 'item.completed') {
      if (!active.delete(item.id)) sequential = false;
      commands.set(item.id, item);
    }
  }
  const portablePath = portable.replaceAll('\\', '/').toLowerCase();
  const samples = [...commands.values()].map((item, index) => ({
    sample: index + 1, exit_code: item.exit_code, output: item.aggregated_output, status: item.status,
    ok: item.exit_code === 0 && item.aggregated_output?.trim() === '7.7.0' &&
      item.command?.replace(/\\+/g, '/').toLowerCase().includes(portablePath) &&
      item.command.includes('$PSVersionTable.PSVersion.ToString()'),
  }));
  const passed = samples.filter(sample => sample.ok).length;
  print({ scenario, mode: mode ?? 'config', job_id: jobId, sequential, samples, passed, expected: 5 });
  return sequential && active.size === 0 && samples.length === 5 && passed === 5;
}

const startedAt = performance.now();
const first = scenario === 'doctor'
  ? await call('codex_runtime', { action: 'doctor' })
  : scenario === 'verify'
  ? await call('codex_verify', { job_id: id, samples: 2, wait_seconds: 0 })
  : await call('codex_run', args);
if (scenario !== 'doctor') {
  print({ scenario, mode, timeoutSeconds, idleTimeoutSeconds, dispatched: first.job_id,
    status: first.status, phase: first.phase, error_kind: first.error_kind });
}
if (scenario === 'doctor') {
  print(first);
  if (!first.ok) process.exitCode = 1;
} else if (cancelling && first.status === 'running') {
  await cancelAndProve(first.job_id);
} else if (timingOut && first.status === 'running') {
  const job = path.join(runnerHome, 'jobs', first.job_id);
  const observation = new AbortController();
  const [final, before] = await Promise.all([
    waitForResult(first.job_id).finally(() => observation.abort()),
    observeTimeoutCommand(job, observation.signal),
  ]);
  const { rows, members } = snapshot(job);
  const after = rows.filter(row => before.some(previous => previous.pid === row.pid));
  print({ scenario, job_id: first.job_id, status: final.status, kind: final.error_kind, error: final.error,
    duration_s: final.duration_s, before, after, remaining_job_members: members, cleanup: final.cleanup });
  if (final.status !== 'failed' || final.error_kind !== 'timeout' || !before.length || after.length || members.length) process.exitCode = 1;
} else {
  const final = first.status === 'running'
    ? await waitForResult(first.job_id)
    : first;
  const elapsedMs = Math.round(performance.now() - startedAt);
  let content;
  if (['write', 'write-patch'].includes(scenario)) {
    try { content = readFileSync(path.join(work, 'native-live.txt'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  print({ scenario, status: final.status, job_id: final.job_id, sandbox: final.sandbox,
    thread_id: final.thread_id, verification_of: final.verification_of ?? final.context?.verification_of,
    report: final.report, kind: final.error_kind, error: final.error, cleanup: final.cleanup, content });
  const criteriaPassed = final.report?.criteria?.length && final.report.criteria.every(criterion => criterion.status === 'met');
  const fileMismatch = ['write', 'write-patch'].includes(scenario) && content !== '原生验证';
  const threadMismatch = scenario === 'resume' && final.thread_id !== id;
  const jobId = final.job_id ?? first.job_id;
  const burstMismatch = scenario === 'burst' && (!jobId || !burstResults(jobId));
  if (exitMinusOne) {
    const commands = jobId ? [...commandEvents(path.join(runnerHome, 'jobs', jobId))]
      .filter(event => event.type === 'item.completed').map(event => event.item) : [];
    const [command] = commands;
    const observed = commands.length === 1 && command.exit_code === -1 &&
      command.command?.includes(exitMarker) && command.aggregated_output?.includes(exitMarker);
    print({ scenario, job_id: jobId, elapsedMs, limitMs: timeoutSeconds * 1000,
      completedCommands: commands.length, exitCode: command?.exit_code, observed: Boolean(observed) });
    if (!observed || elapsedMs >= timeoutSeconds * 1000) process.exitCode = 1;
  }
  let backgroundMismatch = false;
  if (background && final.status === 'completed') {
    const job = path.join(runnerHome, 'jobs', jobId);
    const marker = path.join(work, orphanMarker);
    const ids = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')) : null;
    const worker = Number(readFileSync(path.join(job, 'worker.pid'), 'utf8'));
    const deadline = Date.now() + 5000;
    let state = snapshot(job);
    while (state.rows.some(row => row.pid === worker) && Date.now() < deadline) {
      await delay(100);
      state = snapshot(job);
    }
    const workerExited = !state.rows.some(row => row.pid === worker);
    const childAlive = Boolean(ids && state.rows.some(row => row.pid === ids.child && row.ppid === ids.parent));
    print({ scenario, job_id: jobId, marker: orphanMarker, workerExited, childAlive, child: ids?.child, expiresAfterSeconds: 120 });
    backgroundMismatch = !workerExited || !childAlive;
  }
  if (cancelling || final.status !== 'completed' || !criteriaPassed || fileMismatch || threadMismatch || burstMismatch || backgroundMismatch) {
    process.exitCode = 1;
  }
}
