// dsh-codex-conductor —— 「DSH agent 规划 → WSL 里的 Codex 执行 → agent 验收」的执行层与护栏
//
// 执行交给随包附带的 runner/codex_runner.py，在 WSL 里运行（超时、断线、重试、写锁、
// 按 thread 续跑、改动快照都在那里）。本插件负责：
//   · 结构化派活：codex_run 的任务、必填验收标准、执行约束和允许范围经 stdin 交给 runner，
//     要求 Codex 按 report.schema.json 逐条回报；结果里标出自报未满足、偏离计划和范围外的改动
//   · 等待与取消：start 之后用有界的 `status --wait` 等结果，仍在执行时带回最近动作；
//     中途停止时在 WSL 里 cancel，Linux 侧进程树由 runner 自己清理（taskkill wsl.exe 清不到）
//   · 护栏：config.workspaces 内的会话，写文件类工具一律拒绝，shell 只放行只读核验命令
//   · 防虚报：回合结束时声称已派 Codex、却没调用 codex_* 也没有在跑的任务，就提醒它补上或更正
//
// 护栏 fail-closed：范围内判定出错就拒绝并给出原因；范围外的会话完全不受影响。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'codex-conductor';
export const inject = ['tools'];

const here = (file) => wslPath(fileURLToPath(new URL(file, import.meta.url)));

// 留空的项都沿用 WSL 默认发行版和 Codex 自己的配置
const DEFAULTS = {
  distro: '',
  python: 'python3',
  runner: here('./runner/codex_runner.py'),
  codexBin: '',
  codexHome: '',
  runnerHome: '',
  model: '',
  effort: '',
  serviceTier: '',
  waitSeconds: 1500,
  // runner 在 WSL 里读取这个文件，用 --output-schema 约束 Codex 的最终答复
  reportSchema: here('./report.schema.json'),
};

function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

// 声称已经派出 / Codex 正在执行的说法
const DISPATCH_CLAIM = new RegExp([
  '(已|已经)[^。\\n]{0,8}(派|派发|派出|交给|委派|提交)[^。\\n]{0,12}codex',
  'codex[^。\\n]{0,12}(正在|在做|在跑|执行中|处理中)',
  '派出去了',
  '(dispatched|delegated|handed (it )?(off|over)|sent)( it| the task)? to codex',
  'codex is (now )?(working|running|handling)',
].join('|'), 'i');
const NUDGE = '[codex-conductor] 你刚才说已经派 Codex 去做或 Codex 正在执行，但这一轮没有调用 codex_run / codex_status，' +
  '也没有由 codex_run 启动且仍在运行的任务。确实需要 Codex 执行的，现在调用 codex_run；' +
  '只是计划或需要用户先确认的，请更正说法，不要说已经派出。';

// 范围内一律拒绝：直接写文件、交互终端、Windows shell、可跑任意命令的 Actions、PTC 代码执行
// subagent_codex 走的是 Windows 版 Codex，绕开了 WSL runner
const DENY_TOOLS = new Set(['write', 'edit', 'wsl-write', 'wsl-edit', 'wsl-term', 'wsl-bootstrap',
  'pwsh', 'actions_run', 'actions_configure', 'run_code', 'subagent_codex']);
// MCP 工具按动作名拦（Serena 的 replace_content / insert_after_symbol / execute_shell_command 等）
const MCP_WRITE = /(^|_)(write|edit|replace|insert|delete|remove|rename|move|create|patch|apply|execute|exec)(_|$)/i;
// shell 类工具只放行只读命令；这些参数一出现就拒绝
const SHELL_TOOLS = { wsl: ['env', 'stdin', 'asRoot', 'allowDangerous'], bash: ['env', 'stdin'], ops_bash: ['script_path'] };

const READERS = new Set(['cd', 'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'stat',
  'file', 'du', 'df', 'diff', 'cmp', 'sha256sum', 'sha1sum', 'md5sum', 'nl', 'cut', 'tr', 'column', 'jq',
  'basename', 'dirname', 'realpath', 'readlink', 'which', 'echo', 'printf', 'date', 'hexdump', 'od',
  'strings', 'readelf', 'objdump', 'nm', 'true', 'test', '[', '[[', 'read', 'exit', 'pytest', 'ps', 'pgrep',
  'uname', 'whoami', 'id']);
// 流程控制关键字本身不执行任何东西，剥掉后检查它带的命令
const LEAD_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(', 'time']);
const CLOSE_KEYWORDS = new Set(['fi', 'done', '}', ')']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame',
  'grep', 'describe', 'shortlog', 'cat-file', 'whatchanged']);
const GIT_BRANCH_READ = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--show-current', '--no-color']);
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
// 项目自带的验证脚本视同 pytest：只放行 -File 指向 tests 目录下的 .ps1，不放行 -Command
const PWSH = /^(\$\{?PWSH\}?|(.*[\\/])?(pwsh|powershell)(\.exe)?)$/i;
const TEST_SCRIPT = /(^|[\\/])tests[\\/][^\\/]+\.ps1$/i;
const PWSH_FLAGS = new Set(['-noprofile', '-noninteractive', '-nologo']);
const SED_PRINT = /^((\d+|\$)(,(\d+|\$))?|\/[^/]*\/(,\/[^/]*\/)?)p$/;

const HINT = '改文件、跑会产生改动的命令、做调查，都用 codex_run 交给 Codex；你只做只读核验：read / glob / grep 等读工具，' +
  '或 wsl 里的只读命令（git status/diff/log/show、ls、cat、head、tail、grep、find、wc、sha256sum、pytest、npm test 等，' +
  '可以用 | && for/if 组合，$(...) 里也只能是只读命令；不能写重定向（/dev/null 除外）、反引号或 heredoc）。';

export function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/');
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(s);
  if (m) s = `${m[1]}:${m[2] ?? '/'}`;
  return path.posix.normalize(s).replace(/\/+$/, '').toLowerCase();
}

function inWorkspace(cwd, roots) {
  const c = normPath(cwd);
  return c !== '' && roots.some((r) => c === r || c.startsWith(`${r}/`));
}

// `$(` 之后找到配对的 `)`，跳过引号内的括号；找不到返回 -1。
function closingParen(s, start) {
  let depth = 1;
  let quote = null;
  for (let j = start; j < s.length; j++) {
    const c = s[j];
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') j++; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') j++;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

// 按未加引号的 && || | ; & 和换行切段，段内按空白切词并去掉引号。$(...) 交给 inner 判定，通过后当作一个普通词。
// 返回 null 表示出现了不放行的结构：反引号、未通过的命令替换、进程替换、heredoc、写到 /dev/null 以外的重定向。
export function splitCommand(command, inner = () => false) {
  const segments = [];
  let words = [];
  let word = '';
  let started = false;
  let quote = null;
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") { if (ch === "'") quote = null; else word += ch; continue; }
    if (ch === '`') return null;
    if (ch === '$' && next === '(') {
      const end = closingParen(command, i + 2);
      if (end < 0 || !inner(command.slice(i + 2, end))) return null;
      word += 'X';
      started = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && next !== undefined) { word += next; i++; } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if (ch === '\\') {
      if (next !== undefined && next !== '\n') { word += next; started = true; }
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      if (/^\d+$/.test(word)) { word = ''; started = false; } else endWord();
      let j = ch === '&' ? i + 2 : i + 1;
      if (ch === '<' && (command[j] === '<' || command[j] === '(')) return null;
      if (ch === '>' && command[j] === '(') return null;
      if (ch === '>' && command[j] === '>') j++;
      if (ch === '>' && command[j] === '&' && /\d/.test(command[j + 1] ?? '')) { i = j + 1; continue; }
      while (command[j] === ' ' || command[j] === '\t') j++;
      let target = '';
      while (j < command.length && !/[\s;&|<>]/.test(command[j])) target += command[j++];
      if (!target || (ch !== '<' && target !== '/dev/null')) return null;
      i = j - 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      if ((ch === '|' || ch === '&') && next === ch) i++;
      continue;
    }
    word += ch;
    started = true;
  }
  if (quote) return null;
  endSegment();
  return segments;
}

function gitAllowed(args) {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-P' || args[i] === '-C') i += args[i] === '-C' ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (rest.some((a) => /^--(output|ext-diff|textconv)/.test(a))) return false;
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_READ.has(a));
  return GIT_READ.has(sub);
}

function pwshTestAllowed(args) {
  const file = args.findIndex((a) => /^-f(ile)?$/i.test(a));
  if (file < 0 || !TEST_SCRIPT.test(args[file + 1] ?? '')) return false;
  for (let i = 0; i < file; i++) {
    if (/^-ExecutionPolicy$/i.test(args[i])) i++;
    else if (!PWSH_FLAGS.has(args[i].toLowerCase())) return false;
  }
  return true;
}

function segmentAllowed(words, extra) {
  if (extra.some((rx) => rx.test(words.join(' ')))) return true;
  while (words.length && LEAD_KEYWORDS.has(words[0])) words = words.slice(1);
  while (words.length && CLOSE_KEYWORDS.has(words.at(-1))) words = words.slice(0, -1);
  if (!words.length) return true;
  if (words[0] === 'for') return words.length <= 2 || words[2] === 'in';
  // timeout 只是给后面的命令限时，剥掉后检查真正执行的命令
  if (words[0] === 'timeout') {
    let i = 1;
    while (words[i]?.startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(words[i]) ? 2 : 1;
    if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i] ?? '')) return false;
    return words.length > i + 1 && segmentAllowed(words.slice(i + 1), extra);
  }
  // 单独的变量赋值（D=/mnt/...）无害；带命令的前缀赋值（X=1 cmd）不放行
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return words.length === 1;
  if (PWSH.test(words[0])) return pwshTestAllowed(words.slice(1));
  const [cmd, ...args] = words;
  const positional = args.filter((a) => !a.startsWith('-')).length;
  switch (cmd) {
    case 'git': return gitAllowed(args);
    case 'bash': case 'sh': return args[0] === '-n' && args.length > 1 && args.slice(1).every((a) => !a.startsWith('-'));
    case 'iconv': return !args.some((a) => a === '-o' || a.startsWith('--output'));
    case 'find': return !args.some((a) => FIND_ACTIONS.has(a));
    case 'rg': return !args.some((a) => a.startsWith('--pre'));
    case 'sort': return !args.some((a) => a.startsWith('--output') || /^-[^-]*o/.test(a));
    case 'uniq': return positional <= 1;
    case 'tree': return !args.some((a) => a === '-o');
    case 'sed': return args[0] === '-n' && args.length >= 2 && SED_PRINT.test(args[1]);
    case 'python': case 'python3': return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]);
    case 'npm': case 'pnpm': case 'yarn': return args[0] === 'test' || (args[0] === 'run' && /^test/.test(args[1] ?? ''));
    case 'node': return args[0] === '--test' || args[0] === '--check';
    case 'go': return ['test', 'vet'].includes(args[0]);
    case 'cargo': case 'make': return ['test', 'check'].includes(args[0]);
    default: return READERS.has(cmd);
  }
}

export function readOnlyCommand(command, extra = []) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const segments = splitCommand(command, (sub) => readOnlyCommand(sub, extra));
  return segments !== null && segments.length > 0 && segments.every((w) => segmentAllowed(w, extra));
}

const present = (v) => v !== undefined && v !== null && v !== false && v !== '' &&
  !(typeof v === 'object' && Object.keys(v).length === 0);

// 返回拒绝理由（字符串）或 undefined（放行）。
export function decide(exec, cfg) {
  if (!inWorkspace(exec?.agent?.session?.header?.cwd, cfg.roots)) return undefined;
  const tool = String(exec?.name ?? '');
  const deny = (reason) => `[codex-conductor] 本工作区按「你规划 → Codex 执行 → 你验收」运行，${reason}。${HINT}`;
  if (DENY_TOOLS.has(tool) || cfg.denyTools.has(tool)) return deny(`${tool} 会直接改动文件或执行任意代码，已拒绝`);
  if (tool.startsWith('mcp__') && MCP_WRITE.test(tool.slice(tool.lastIndexOf('__') + 2))) {
    return deny(`${tool} 会改动文件或执行命令，已拒绝`);
  }
  const blocked = SHELL_TOOLS[tool];
  if (!blocked) return undefined;
  const args = exec.arguments ?? {};
  const used = blocked.filter((k) => present(args[k]));
  if (used.length) return deny(`${tool} 带了 ${used.join(' / ')} 参数，已拒绝`);
  if (!readOnlyCommand(args.command, cfg.allowCommands)) {
    return deny(`这条命令不在只读核验范围内：${String(args.command ?? '').slice(0, 200)}`);
  }
  return undefined;
}

// wsl.exe 的参数。配置了的路径用 env 显式传入，不依赖宿主进程继承来的环境
export function runnerArgv(cfg, args) {
  const env = [
    cfg.codexHome && `CODEX_HOME=${cfg.codexHome}`,
    cfg.runnerHome && `CODEX_RUNNER_HOME=${cfg.runnerHome}`,
    cfg.codexBin && `CODEX_RUNNER_CMD=${JSON.stringify([cfg.codexBin])}`,
  ].filter(Boolean);
  return [...(cfg.distro ? ['-d', cfg.distro] : []), '-e', 'env', ...env, cfg.python, cfg.runner, ...args];
}

// 调用 WSL 里的 runner，返回它输出的最后一行 JSON。
function runRunner(cfg, args, { stdin, signal } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('wsl.exe', runnerArgv(cfg, args), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 'failed', error_kind: 'bridge_error', error: String(error?.message ?? error), retryable: true });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => resolve({ status: 'failed', error_kind: 'bridge_error', error: error.message, retryable: true }));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const lines = Buffer.concat(out).toString('utf8').trim().split('\n');
      try {
        resolve(JSON.parse(lines.at(-1)));
      } catch {
        const stderr = Buffer.concat(err).toString('utf8').trim().slice(-2000);
        resolve({ status: 'failed', error_kind: 'bridge_error', error: `runner exited ${code}: ${stderr || lines.join('\n').slice(-2000)}`, retryable: true });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

export function createConductor(cfg, run = runRunner) {
  // 每次等待是一个有界的 `status --wait` 进程，到点即退出；仍在执行时 runner 会带回空闲秒数和最近动作
  async function waitJob(jobId, seconds, signal) {
    const value = await run(cfg, ['status', jobId, '--wait', String(Math.max(0, seconds))], { signal });
    if (signal?.aborted) {
      await run(cfg, ['cancel', jobId]);
      signal.throwIfAborted();
    }
    const note = value.status === 'running' ? { note: `等了 ${seconds} 秒仍在执行，任务在后台继续；用 codex_status 接着等。` } : {};
    return { job_id: jobId, ...value, ...note };
  }

  async function start(args, cwd, signal) {
    const argv = ['start', '--cwd', cwd];
    const effort = args.effort ?? cfg.effort;
    if (effort) argv.push('--effort', effort);
    if (cfg.model) argv.push('--model', cfg.model);
    if (cfg.serviceTier) argv.push('--service-tier', cfg.serviceTier);
    if (args.write === true) argv.push('--sandbox', 'workspace-write');
    if (args.resume) argv.push('--resume', args.resume);
    if (args.use_user_config === true) argv.push('--use-user-config');
    if (cfg.reportSchema) argv.push('--schema', cfg.reportSchema);
    const started = await run(cfg, argv, { stdin: composePrompt(args.task, args.acceptance, args.scope), signal });
    if (started.status !== 'running' || !started.job_id) return started;
    return waitJob(started.job_id, args.wait_seconds ?? cfg.waitSeconds, signal);
  }

  return { start, waitJob, cancel: (jobId) => run(cfg, ['cancel', jobId]) };
}

export function composePrompt(task, acceptance, scope = []) {
  return `${task.trim()}\n\n## 验收标准\n完成后逐条自查，每条都要满足：\n` +
    acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join('\n') +
    '\n\n## 执行约束\n' +
    '- 只做上面任务和验收标准要求的事，不扩大范围，不顺手重构或修改无关文件。\n' +
    (scope.length ? `- 只允许改动这些路径：${scope.join('、')}；其他文件一律不要动。\n` : '') +
    '- 任务与现状不符、验收标准之间互相冲突，或者按计划做不到时，不要自行改方案或取舍：做完能做的部分，' +
    '在 deviations 里写清冲突和原因，并把对应验收标准标为 blocked。\n' +
    '- 不要为了通过验收去修改验收脚本、测试或判据本身，除非任务明确要求。\n' +
    '\n## 最后汇报\n最终答复只输出符合给定 JSON 格式的对象：summary 概述结果；criteria 按上面的顺序逐条给出 ' +
    'status（met / not_met / blocked）和 evidence（具体证据：命令与输出、文件与行号）；files_changed 列出改动的文件；' +
    'deviations 列出与计划不一致的地方及原因（没有就空数组）；unresolved 列出没解决的问题。\n';
}

// 不在 scope 内的改动；没给 scope 或 runner 没给出改动清单时返回 undefined
export function outOfScope(value, cwd, scope) {
  if (!scope?.length || !Array.isArray(value.files_changed)) return undefined;
  const abs = (p) => normPath(/^([A-Za-z]:|\/)/.test(p) ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`);
  const roots = scope.map(abs);
  return value.files_changed.map((f) => f.path)
    .filter((p) => { const a = abs(p); return !roots.some((r) => a === r || a.startsWith(`${r}/`)); });
}

export function validateRun(args) {
  if (typeof args?.task !== 'string' || args.task.trim().length < 10) throw new Error('codex_run: task 必须写清目标、相关路径和约束（至少 10 个字符）');
  if (!Array.isArray(args.acceptance) || args.acceptance.length === 0 || args.acceptance.length > 20 ||
    args.acceptance.some((a) => typeof a !== 'string' || a.trim().length < 4)) {
    throw new Error('codex_run: acceptance 必须是 1–20 条可核验的验收标准（每条至少 4 个字符）');
  }
  for (const k of ['cwd', 'resume', 'effort']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k].trim())) throw new Error(`codex_run: ${k} 必须是非空字符串`);
  }
  if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
    throw new Error('codex_run: wait_seconds 必须是非负整数');
  }
  if (args.scope !== undefined && (!Array.isArray(args.scope) || args.scope.length > 50 ||
    args.scope.some((s) => typeof s !== 'string' || !s.trim()))) {
    throw new Error('codex_run: scope 必须是不超过 50 个非空路径');
  }
}

// runner 把合法的 JSON 汇报放在 structured 里，统一改名为 report。
// Codex 没按 JSON 汇报时 runner 记为 schema_invalid 失败，但活已经干完，按完成处理并提示以实际文件为准。
export function withReport(value) {
  const { structured, ...rest } = value;
  if (rest.status === 'failed' && rest.error_kind === 'schema_invalid') {
    const { error_kind: _kind, error: _error, retryable: _retryable, ...done } = rest;
    return { ...done, status: 'completed', report_note: 'Codex 没按 JSON 格式逐条汇报，核验时以 final_message 和实际文件为准。' };
  }
  return structured && typeof structured === 'object' ? { ...rest, report: structured } : rest;
}

export function nextStep(value, acceptance) {
  if (value.status === 'running') return `任务 ${value.job_id} 仍在执行，用 codex_status 等结果，不要自己动手补做。`;
  if (value.status !== 'completed') {
    return value.retryable ? '这次失败可重试：稍后用同样的参数再派一次（有 thread_id 时带 resume）。' : '这次失败不可重试：把 error 原样告诉用户，不要改为自己动手。';
  }
  const report = value.report ?? {};
  const flagged = (report.criteria ?? []).filter((c) => c.status !== 'met');
  const alerts = [
    flagged.length ? `Codex 自报有 ${flagged.length} 条未满足或受阻：${flagged.map((c) => `${c.criterion}（${c.status}）`).join('；')}` : '',
    report.deviations?.length ? `Codex 自报偏离计划：${report.deviations.join('；')}` : '',
    value.out_of_scope?.length ? `改动超出 scope：${value.out_of_scope.join('、')}，先核实这些改动是否应保留` : '',
  ].filter(Boolean);
  const list = (acceptance ?? []).map((a, i) => `${i + 1}. ${a}`).join('\n');
  return (alerts.length ? `${alerts.join('\n')}\n偏离或冲突需要用户取舍的，先向用户说明，不要替用户选。\n` : '') +
    'Codex 的答复不是完成证据。用只读检查逐条核验下面的验收标准，给出每条的证据；' +
    `有任何一条不通过，就写清差距，用 codex_run 带 resume="${value.thread_id ?? ''}" 派回修正。${list ? `\n${list}` : ''}`;
}

const MARK = { met: '✓', not_met: '✗', blocked: '⛔' };

function render(value) {
  const { final_message: answer, report, next, ...rest } = value ?? {};
  const reportLines = report ? [
    '--- Codex 逐条汇报 ---', `概述：${report.summary ?? ''}`,
    ...(report.criteria ?? []).map((c, i) => `${MARK[c.status] ?? '?'} ${i + 1}. ${c.criterion} —— ${c.evidence}`),
    `自报改动：${report.files_changed?.join('、') || '无'}`,
    `偏离计划：${report.deviations?.join('；') || '无'}`,
    `未解决：${report.unresolved?.join('；') || '无'}`,
  ] : [];
  return [{ type: 'text', text: [
    `status: ${rest.status}${rest.job_id ? `  job_id: ${rest.job_id}` : ''}${rest.thread_id ? `  thread_id: ${rest.thread_id}` : ''}`,
    ...(report ? reportLines : answer ? ['--- Codex 最终答复 ---', answer] : []),
    '--- 详细字段 ---', JSON.stringify(rest, null, 2),
    ...(next ? ['--- 下一步 ---', next] : []),
  ].join('\n') }];
}

// 这一轮的最后一条回复文字，以及调用过的工具名（tool_call 间接调用按其参数里的真实工具名算）
export function turnSummary(log, turn) {
  let text = '';
  const tools = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    const t = e?.data?.turn;
    if (t === undefined) continue;
    if (t < turn) break;
    if (t !== turn) continue;
    if (e.type === 'tool/call') {
      tools.push(e.data.name);
      if (e.data.name === 'tool_call') tools.push(...(String(e.data.arguments).match(/codex_\w+/g) ?? []));
    } else if (e.type === 'assistant/message' && !text) {
      text = (e.data.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    }
  }
  return { text, tools };
}

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => render(value) };
const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;

function settings(config) {
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config).filter(([k, v]) => k in DEFAULTS && v !== undefined && v !== '')),
    roots: (Array.isArray(config.workspaces) ? config.workspaces : []).map(normPath).filter(Boolean),
    denyTools: new Set(Array.isArray(config.denyTools) ? config.denyTools : []),
    allowCommands: (Array.isArray(config.allowCommands) ? config.allowCommands : []).map((s) => new RegExp(s)),
  };
}

export function apply(ctx, config = {}) {
  const cfg = settings(config);
  const conductor = createConductor(cfg);
  // codex_run 启动、尚未结束的任务；有它们时说「Codex 正在做」是真话
  const activeJobs = new Set();
  const track = (value) => {
    if (!value?.job_id) return value;
    if (value.status === 'running') activeJobs.add(value.job_id);
    else activeJobs.delete(value.job_id);
    return value;
  };

  ctx.tools.register({
    name: 'codex_run',
    description: '把任务交给 WSL 里的 Codex 执行（它看不到本对话），并等待结果。必须给出验收标准；' +
      'write=true 才允许它改文件，默认只读用于调查；scope 限定允许改动的路径。Codex 会按验收标准逐条回报 ' +
      '（report），结果里还会标出它自报未满足、偏离计划和超出 scope 的改动。completed 后你要逐条只读核验，' +
      '不通过就带 resume=thread_id 派回修正。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务：目标、相关文件路径、约束和背景。Codex 看不到本对话，必须写全。' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，1–20 条，每条写成可核验的结果：做完后应当存在什么、运行什么检查得到什么。' },
        write: { type: 'boolean', description: 'true 允许 Codex 修改任务目录里的文件（workspace-write 沙箱）；默认 false 只读。' },
        scope: { type: 'array', items: { type: 'string' }, description: '允许 Codex 改动的文件或目录（相对任务目录或绝对路径）。给了就写进约束，完成后在 out_of_scope 里列出范围外的改动。' },
        cwd: { type: 'string', description: '任务目录，默认当前会话工作区；Windows 路径或 /mnt/... 都可以。' },
        resume: { type: 'string', description: '在上一次返回的 thread_id 上继续（返工、追问时用）。' },
        use_user_config: { type: 'boolean', description: '加载 WSL Codex 自己配置的 MCP 和 hooks（任务要用到这些工具时），启动更慢。' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: `推理强度，默认 ${cfg.effort || 'Codex 配置里的值'}${cfg.model ? `（模型 ${cfg.model}）` : ''}。简单任务可调低以加快速度。` },
        wait_seconds: { type: 'integer', description: `最多等待秒数，默认 ${cfg.waitSeconds}；到时任务在后台继续，用 codex_status 接着等。` },
      },
      required: ['task', 'acceptance'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      validateRun(args);
      const cwd = args.cwd ?? sessionCwd(exec);
      if (!cwd) throw new Error('codex_run: 当前会话没有工作区，请传 cwd');
      const result = track(withReport(await conductor.start(args, cwd, exec?.signal)));
      const outside = outOfScope(result, cwd, args.scope);
      const value = { ...result, acceptance: args.acceptance, ...(outside ? { out_of_scope: outside } : {}) };
      return { ...value, next: nextStep(value, args.acceptance) };
    },
  });

  ctx.tools.register({
    name: 'codex_status',
    description: '查询或继续等待 codex_run 返回的后台任务。仍在执行时返回 seconds_since_last_event（距 Codex 上次活动的秒数）' +
      '和 last_activity（它最近在做什么），不必再去翻日志；建议每次等 300–600 秒，不要频繁轮询。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'codex_run 返回的 job_id。' },
        wait_seconds: { type: 'integer', description: '最多等待秒数，默认 600；0 表示只查一次。' },
      },
      required: ['job_id'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !args.job_id.trim()) throw new Error('codex_status: job_id 必须是非空字符串');
      const value = track(withReport(await conductor.waitJob(args.job_id, args.wait_seconds ?? 600, exec?.signal)));
      return { ...value, next: nextStep(value) };
    },
  });

  ctx.tools.register({
    name: 'codex_cancel',
    description: '取消 codex_run 启动的任务，连同 WSL 里的 Codex 进程一起结束。',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'codex_run 返回的 job_id。' } },
      required: ['job_id'],
    },
    output: OUTPUT,
    async execute(args) {
      if (typeof args?.job_id !== 'string' || !args.job_id.trim()) throw new Error('codex_cancel: job_id 必须是非空字符串');
      activeJobs.delete(args.job_id);
      return conductor.cancel(args.job_id);
    },
  });

  // 防虚报：每个回合最多提醒一次，提醒会让这一回合继续，由它补调用或更正说法
  const nudged = new Set();
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      if (!inWorkspace(agent?.session?.header?.cwd, cfg.roots) || activeJobs.size) return;
      const key = `${agent.id}:${turn}`;
      if (nudged.has(key)) return;
      const { text, tools } = turnSummary(agent.session.log ?? [], turn);
      if (!DISPATCH_CLAIM.test(text) || tools.some((n) => n?.startsWith('codex_'))) return;
      if (nudged.size > 500) nudged.clear();
      nudged.add(key);
      agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: NUDGE }], source: { kind: `plugin:${name}` } });
    } catch {}
  });

  if (cfg.roots.length) {
    ctx.tools.guard((exec) => {
      try {
        return decide(exec, cfg);
      } catch (error) {
        return inWorkspace(sessionCwd(exec), cfg.roots)
          ? `[codex-conductor] 护栏判定出错，已拒绝：${error?.message ?? error}`
          : undefined;
      }
    });
  }
  ctx.logger?.info?.(`[codex-conductor] active: codex_run/codex_status/codex_cancel；护栏工作区 ${cfg.roots.join(', ') || '(未配置)'}`);
  // 桌面宿主日志不落盘，留一个加载标记，便于确认插件是否在运行中的 DSH 里生效
  try {
    const dir = path.join(process.env.LOCALAPPDATA ?? '', 'dsh-codex-conductor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'loaded.json'),
      JSON.stringify({ loadedAt: new Date().toISOString(), pid: process.pid, workspaces: cfg.roots }, null, 1));
  } catch {}
}
