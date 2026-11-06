// dsh-codex-conductor —— 「DSH agent 规划 → WSL 里的 Codex 执行 → agent 验收」的执行层与护栏
//
// 执行交给随包附带的 runner/codex_runner.py，在 WSL 里运行（超时、断线、重试、写锁、
// 按 thread 续跑、改动快照都在那里）。本插件负责：
//   · 结构化派活：codex_run 的任务、必填验收标准、执行约束和允许范围经 stdin 交给 runner，
//     要求 Codex 按 report.schema.json 逐条回报；结果里标出自报未满足、偏离计划和范围外的改动
//   · 等待与取消：start 之后用有界的 `status --wait` 等结果，仍在执行时带回最近动作；
//     中途停止时在 WSL 里 cancel，Linux 侧进程树由 runner 自己清理（taskkill wsl.exe 清不到）；
//     等到点仍在执行时登记 DSH 后台任务，Codex 结束后结果自动送回会话（没有 jobs 服务就照旧轮询）
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
  // 只读任务的推理强度，留空与 effort 相同
  readOnlyEffort: '',
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
// 只认字面的 pwsh 路径：$PWSH 之类的变量可以先被单独赋值成任意命令，展开后按空白切开执行
const PWSH = /^([^$]*[\\/])?(pwsh|powershell)(\.exe)?$/i;
const TEST_SCRIPT = /(^|[\\/])tests[\\/][^\\/]+\.ps1$/i;
const PWSH_FLAGS = new Set(['-noprofile', '-noninteractive', '-nologo']);
// 随包的只读语法检查脚本；护栏只认这一个路径（/mnt 形式和 Windows 形式都行）
const PS_SYNTAX_WIN = fileURLToPath(new URL('./tools/Test-PsSyntax.ps1', import.meta.url));
export const PS_SYNTAX = wslPath(PS_SYNTAX_WIN);
// 地址里不放行 \/：转义的斜杠会让后面的 e/w 命令混进地址；也不放行 $：变量或命令替换展开后同样能混进 e/w（末行用 tail）
const SED_PRINT = /^(\d+(,\d+)?|\/[^/\\$]*\/(,\/[^/\\$]*\/)?)p$/;

const HINT = '改文件、跑会产生改动的命令、做调查，都用 codex_run 交给 Codex；你只做只读核验：read / glob / grep 等读工具，' +
  '或 wsl 里的只读命令（git status/diff/log/show、ls、cat、head、tail、grep、find、wc、sha256sum、pytest、npm test 等，' +
  '可以用 | && for/if 组合，$(...) 里也只能是只读命令；不能写重定向（/dev/null 除外）、反引号、heredoc 或 $((...)) 算术）。' +
  "项目 tests 目录下的验证脚本可以直接跑：pwsh -NoProfile -File '<...\\tests\\xxx.ps1>'。" +
  `检查 PowerShell 语法不能用 -Command，改用随包脚本：pwsh.exe -NoProfile -File '${PS_SYNTAX_WIN}' 'D:\\path\\a.ps1' …` +
  `（Windows 的 pwsh.exe 用 Windows 路径；WSL 里的 pwsh 用 ${PS_SYNTAX}），输出 PARSE-OK / PARSE-FAIL 和出错行。`;

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
      // $((...)) 是算术：会把变量值当表达式递归求值，值里的 a[$(...)] 就能执行命令
      if (command[i + 2] === '(') return null;
      const end = closingParen(command, i + 2);
      if (end < 0 || !inner(command.slice(i + 2, end))) return null;
      // 保留 $，让后面的检查（sed 脚本、pwsh 路径）看得出这里展开过
      word += '$X';
      started = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      // 和 bash 一样，双引号里的 \ 只转义 $ ` " \ 和换行，Windows 路径 "C:\x" 保持原样
      else if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) { if (next !== '\n') word += next; i++; } else word += ch;
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
  const script = args[file + 1] ?? '';
  // 语法检查脚本后面只能跟待检查的文件，不放行任何开关
  const helper = normPath(script) === normPath(PS_SYNTAX) &&
    args.length > file + 2 && args.slice(file + 2).every((a) => !a.startsWith('-'));
  if (file < 0 || script.includes('$') || !(helper || TEST_SCRIPT.test(script))) return false;
  for (let i = 0; i < file; i++) {
    if (/^-ExecutionPolicy$/i.test(args[i])) i++;
    else if (!PWSH_FLAGS.has(args[i].toLowerCase())) return false;
  }
  return true;
}

// 剥掉流程关键字和 timeout 前缀（它只是给后面的命令限时），剩下真正执行的命令；
// timeout 的时长不合法或后面没有命令时保留原样，按 timeout 本身判定（不放行）
function core(words) {
  for (;;) {
    while (words.length && LEAD_KEYWORDS.has(words[0])) words = words.slice(1);
    while (words.length && CLOSE_KEYWORDS.has(words.at(-1))) words = words.slice(0, -1);
    if (words[0] !== 'timeout') return words;
    let i = 1;
    while (words[i]?.startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(words[i]) ? 2 : 1;
    if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i] ?? '') || words.length <= i + 1) return words;
    words = words.slice(i + 1);
  }
}

function segmentAllowed(raw, extra) {
  const words = core(raw);
  if (extra.some((rx) => rx.test(raw.join(' ')) || rx.test(words.join(' ')))) return true;
  if (!words.length) return true;
  // 循环列表里的词会代入后面的命令，不能借它塞进参数（for f in -delete; do find . $f）
  if (words[0] === 'for') return (words.length <= 2 || words[2] === 'in') && words.slice(3).every((w) => !w.startsWith('-'));
  // 单独的变量赋值（D=/mnt/...）无害；带命令的前缀赋值（X=1 cmd）不放行。
  // 值不能以 - 开头或含空白，免得展开后变成参数（X=-delete; find . $X）；
  // 也不能含字面的 $(，否则 [[ X -eq 0 ]] 之类的算术求值会执行它
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    return words.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=(?!-)\S*$/.test(words[0]) && !words[0].includes('$(');
  }
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
    // printf -v 能给任意变量赋任意值
    case 'printf': return !args[0]?.startsWith('-v');
    case 'tree': return !args.some((a) => a === '-o');
    // 后面再出现开关（-i、--in-place、-e、-f）就可能写文件或执行命令；
    // 文件参数里的 $ 和 { 也不放行：$(printf -- -i)、{-i,f} 展开后同样变成开关
    case 'sed': return args[0] === '-n' && args.length >= 2 && SED_PRINT.test(args[1]) && args.slice(2).every((a) => !/^-|[{$]/.test(a));
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

// 拒绝原因：整条命令截断后看不到真正卡住的地方，所以指出不放行的结构或第一段不放行的命令
function refusedPart(command, extra) {
  const segments = typeof command === 'string' ? splitCommand(command, (sub) => readOnlyCommand(sub, extra)) : [];
  if (segments === null) {
    return '含不放行的结构：写到 /dev/null 以外的重定向、反引号、heredoc、$((...)) 算术、进程替换、$(...) 里的非只读命令或未闭合引号';
  }
  const bad = segments.find((w) => !segmentAllowed(w, extra));
  return bad ? `不放行的是「${core(bad).join(' ').slice(0, 200)}」` : '命令为空';
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
    return deny(`这条命令不在只读核验范围内，${refusedPart(args.command, cfg.allowCommands)}`);
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
      // 不设 WSL_UTF8 时 wsl.exe 自己的报错是 UTF-16LE，按 UTF-8 读出来是乱码
      child = spawn('wsl.exe', runnerArgv(cfg, args), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WSL_UTF8: '1' } });
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
    const effort = args.effort ?? (args.write === true ? cfg.effort : cfg.readOnlyEffort || cfg.effort);
    if (effort) argv.push('--effort', effort);
    if (cfg.model) argv.push('--model', cfg.model);
    if (cfg.serviceTier) argv.push('--service-tier', cfg.serviceTier);
    if (args.write === true) argv.push('--sandbox', 'workspace-write');
    if (args.resume) argv.push('--resume', args.resume);
    if (args.use_user_config === true) argv.push('--use-user-config');
    if (cfg.reportSchema) argv.push('--schema', cfg.reportSchema);
    for (const s of args.scope ?? []) argv.push('--scope', s);
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
    'deviations 列出与计划不一致的地方及原因（没有就空数组）；unresolved 列出没解决的问题。\n' +
    '任务或验收标准里对最终答复版式的要求（如单独的结论行）写进 summary 即算满足，不算偏离，也不要因此标 blocked。\n';
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

// resumed：这次是否带了 resume；codex_status 不知道时传 undefined，按 runner 有没有给 thread_id 判断
export function nextStep(value, acceptance, resumed) {
  if (value.status === 'running') return `任务 ${value.job_id} 仍在执行，用 codex_status 等结果，不要自己动手补做。`;
  // 只读任务用 --ephemeral 运行、不留会话记录，自己的 thread_id 续不上；只有它续跑的写任务线程还能续
  const resumable = value.sandbox !== 'read-only' || (resumed ?? Boolean(value.thread_id));
  if (value.status !== 'completed') {
    if (!value.retryable) return '这次失败不可重试：把 error 原样告诉用户，不要改为自己动手。';
    return resumable ? '这次失败可重试：稍后用同样的参数再派一次（有 thread_id 时带 resume）。'
      : '这次失败可重试：稍后用同样的参数再派一次，不要带 resume（只读任务不留会话，不能续跑）。';
  }
  const report = value.report ?? {};
  const flagged = (report.criteria ?? []).filter((c) => c.status !== 'met');
  const alerts = [
    flagged.length ? `Codex 自报有 ${flagged.length} 条未满足或受阻：${flagged.map((c) => `${c.criterion}（${c.status}）`).join('；')}` : '',
    report.deviations?.length ? `Codex 自报偏离计划：${report.deviations.join('；')}` : '',
    value.out_of_scope?.length ? `改动超出 scope：${value.out_of_scope.join('、')}。这份清单来自目录快照，可能含同时段其他进程写的文件（如定期日志）；` +
      '不在 Codex 自报 files_changed 里、明显来自其他进程的，只需一句说明，不算 Codex 越界，也不用请用户决定；其余的先核实是否应保留' : '',
  ].filter(Boolean);
  const list = (acceptance ?? []).map((a, i) => `${i + 1}. ${a}`).join('\n');
  return (alerts.length ? `${alerts.join('\n')}\n偏离或冲突需要用户取舍的，先向用户说明，不要替用户选。\n` : '') +
    'Codex 的答复不是完成证据。用只读检查逐条核验下面的验收标准，给出每条的证据；' +
    `有任何一条不通过，就写清差距，${resumable ? `用 codex_run 带 resume="${value.thread_id ?? ''}" 派回修正`
      : '用 codex_run 重新派一个写全背景的完整任务（只读任务不留会话，不能 resume）'}。${list ? `\n${list}` : ''}`;
}

const MARK = { met: '✓', not_met: '✗', blocked: '⛔' };

function render(value) {
  // 后台任务结算时存下的成品文字，原样交回
  if (typeof value?.rendered === 'string') return [{ type: 'text', text: value.rendered }];
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

// 任务目录：显式 cwd > 包含会话工作区的 workspaces 条目的 cwd（最具体的那条）> 会话工作区
export function taskCwd(args, session, workspaces) {
  if (args.cwd) return args.cwd;
  const hits = workspaces.filter((w) => w.cwd && inWorkspace(session, [w.root]));
  return hits.sort((a, b) => b.root.length - a.root.length)[0]?.cwd ?? session;
}

function settings(config) {
  // workspaces 的条目可以是路径字符串，也可以是 {path, cwd}
  const workspaces = (Array.isArray(config.workspaces) ? config.workspaces : [])
    .map((w) => typeof w === 'string' ? { root: normPath(w) }
      : { root: normPath(w?.path), cwd: typeof w?.cwd === 'string' && w.cwd.trim() ? w.cwd.trim() : undefined })
    .filter((w) => w.root);
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config).filter(([k, v]) => k in DEFAULTS && v !== undefined && v !== '')),
    workspaces,
    roots: workspaces.map((w) => w.root),
    denyTools: new Set(Array.isArray(config.denyTools) ? config.denyTools : []),
    allowCommands: (Array.isArray(config.allowCommands) ? config.allowCommands : []).map((s) => new RegExp(s)),
  };
}

const BG_WAIT = 300;
// runner 取消后会立即写下结果，后台循环一秒内就能看到，这里只是上限
const CANCEL_SETTLE_MS = 30_000;
const JOB_STATUS = { completed: 'completed', cancelled: 'killed' };

export function apply(ctx, config = {}, run = runRunner) {
  const cfg = settings(config);
  const conductor = createConductor(cfg, run);
  // codex_run 启动、尚未结束的任务；有它们时说「Codex 正在做」是真话
  const activeJobs = new Set();
  const track = (value) => {
    if (!value?.job_id) return value;
    if (value.status === 'running') activeJobs.add(value.job_id);
    else activeJobs.delete(value.job_id);
    return value;
  };

  // 这个 runner 任务仍在进行的 DSH 后台任务。按 DSH 任务表查而不记在插件内存里：
  // 插件热重载后旧的后台任务和它的等待循环仍在，内存记录却清空了，会重复登记、重复送回结果
  function liveBackground(jobId, exec) {
    const owner = exec?.agent?.id;
    const jobs = owner === undefined ? undefined : ctx.get?.('jobs');
    const job = jobs?.list(owner).find((j) => j.kind === 'codex' && j.label === `Codex ${jobId}` &&
      (j.status === 'running' || j.status === 'stopping'));
    return job && { jobs, id: job.id, owner };
  }

  // 后台循环：有界地反复 `status --wait`，结束时把与工具结果相同的文字交给 DSH 送回会话
  async function watch(jobId, handle, finish) {
    try {
      for (;;) {
        const value = withReport(await conductor.waitJob(jobId, BG_WAIT));
        if (value.status === 'running') {
          handle.updateProgress(`Codex 执行中，距上次活动 ${value.seconds_since_last_event ?? '?'} 秒：${value.last_activity ?? '启动中'}`);
          continue;
        }
        // wsl.exe 本身出错不代表任务结束
        if (value.error_kind === 'bridge_error') throw new Error(value.error);
        const done = finish(track(value));
        return { status: JOB_STATUS[done.status] ?? 'failed',
          detail: `Codex 任务 ${jobId} 结束：${done.status}${done.error_kind ? `（${done.error_kind}）` : ''}`,
          result: render(done)[0].text };
      }
    } catch (error) {
      activeJobs.delete(jobId);
      const lost = { job_id: jobId, status: 'monitor_failed', error: String(error?.message ?? error),
        next: `后台等待出错，底层 Codex 任务可能仍在运行：先用 codex_status 查询 ${jobId}，不要直接重派。` };
      return { status: 'failed', detail: `无法继续等待 Codex 任务 ${jobId}`, result: render(lost)[0].text };
    }
  }

  // 仍在执行时登记 DSH 后台任务（同一个 runner 任务只登记一个），结束后由 DSH 把结果送回会话；
  // 没有 jobs 服务或登记失败就照旧轮询
  function notifyOnDone(value, exec, finish) {
    if (value.status !== 'running' || !value.job_id || !exec?.agent) return value;
    let id;
    try {
      id = liveBackground(value.job_id, exec)?.id;
      if (id === undefined) {
        const jobs = ctx.get?.('jobs');
        if (!jobs) return value;
        id = jobs.start({
          owner: exec.agent.id, kind: 'codex', label: `Codex ${value.job_id}`, outputLimitBytes: 65536,
          run: (handle) => ({
            done: watch(value.job_id, handle, finish),
            cancel: () => { Promise.resolve(conductor.cancel(value.job_id)).catch(() => {}); },
          }),
        });
      }
    } catch {
      return value;
    }
    return { ...value, background_job_id: id,
      note: `已登记为后台任务 ${id}：Codex 结束后，结果（含逐条汇报和下一步）会自动送回本会话，不必用 codex_status 轮询。`,
      next: '等待自动送回的结果；在此之前不要自己动手补做，也不要重复派同一个任务。' };
  }

  ctx.tools.register({
    name: 'codex_run',
    description: '把任务交给 WSL 里的 Codex 执行（它看不到本对话），并等待结果。必须给出验收标准；' +
      'write=true 才允许它改文件，默认只读用于调查；scope 限定允许改动的路径。Codex 会按验收标准逐条回报 ' +
      '（report），结果里还会标出它自报未满足、偏离计划和超出 scope 的改动。completed 后你要逐条只读核验，' +
      '不通过就带 resume=thread_id 派回修正。汇报格式由插件固定为 JSON，task/acceptance 里不要规定末行结论行之类的版式。' +
      'WSL 里的 Codex 启动不了 Windows 程序（pwsh.exe、Hyper-V 命令等），不要把需要 Windows 运行时的检查写进 task/acceptance，这类检查你自己跑。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务：目标、相关文件路径、约束和背景。Codex 看不到本对话，必须写全。' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，1–20 条，每条写成可核验的结果：做完后应当存在什么、运行什么检查得到什么。' },
        write: { type: 'boolean', description: 'true 允许 Codex 修改任务目录里的文件（workspace-write 沙箱）；默认 false 只读。' },
        scope: { type: 'array', items: { type: 'string' }, description: '允许 Codex 改动的文件或目录（相对任务目录或绝对路径）。给了就写进约束，完成后在 out_of_scope 里列出范围外的改动。' },
        cwd: { type: 'string', description: '任务目录（Codex 在这里运行，write=true 时只能改这里的文件），Windows 路径或 /mnt/... 都可以。' +
          '不传时：会话工作区属于配置里带 cwd 的 workspaces 条目，就用那个 cwd，否则用当前会话工作区。' +
          '只在 task 里写目标目录不会切换任务目录，要处理哪个目录就传哪个 cwd。' },
        resume: { type: 'string', description: '在上一次返回的 thread_id 上继续（返工、追问时用）。' },
        use_user_config: { type: 'boolean', description: '加载 WSL Codex 自己配置的 MCP 和 hooks（任务要用到这些工具时），启动更慢。' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: `推理强度。默认：write=true 时 ${cfg.effort || 'Codex 配置里的值'}，只读时 ` +
          `${cfg.readOnlyEffort || cfg.effort || 'Codex 配置里的值'}${cfg.model ? `（模型 ${cfg.model}）` : ''}。简单任务可调低以加快速度。` },
        wait_seconds: { type: 'integer', description: `最多等待秒数，默认 ${cfg.waitSeconds}；到时任务转入后台继续，` +
          '登记为后台任务时结果会自动送回本会话，否则用 codex_status 接着等。' },
      },
      required: ['task', 'acceptance'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      validateRun(args);
      const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces);
      if (!cwd) throw new Error('codex_run: 当前会话没有工作区，请传 cwd');
      const finish = (result) => {
        const outside = outOfScope(result, cwd, args.scope);
        const value = { ...result, acceptance: args.acceptance, ...(outside ? { out_of_scope: outside } : {}) };
        return { ...value, next: nextStep(value, args.acceptance, Boolean(args.resume)) };
      };
      return notifyOnDone(finish(track(withReport(await conductor.start(args, cwd, exec?.signal)))), exec, finish);
    },
  });

  ctx.tools.register({
    name: 'codex_status',
    description: '查询或继续等待 codex_run 返回的任务。已登记为后台任务（结果带 background_job_id）的，结束后结果会自动送回，' +
      '不必调用本工具；没登记的才用它等，仍在执行时返回 last_activity（它最近在做什么）和距上次活动的秒数，' +
      '不必再去翻日志；建议每次等 300–600 秒，不要频繁轮询。',
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
      const finish = (value) => ({ ...value, next: nextStep(value) });
      const seconds = args.wait_seconds ?? 600;
      const bg = liveBackground(args.job_id, exec);
      let value;
      if (bg) {
        // 经 DSH 任务表等：结束时这次结算算作已被等到，DSH 就不会再把同一结果作为通知补发一遍
        let view;
        try {
          view = await bg.jobs.wait(bg.id, Math.max(1, seconds * 1000), bg.owner, exec?.signal);
        } catch (error) {
          if (exec?.signal?.aborted) bg.jobs.kill(bg.id, bg.owner);
          throw error;
        }
        if (view.status === 'running' || view.status === 'stopping') value = { job_id: args.job_id, status: 'running', last_activity: view.progress };
        else {
          // 结算时存下的是 codex_run 渲染好的完整结果（含 acceptance 和 out_of_scope），runner 重查拿不到这些；
          // 这次等待已算作被等到，DSH 不会再作为通知送回，所以在这里原样交回（结果只给一次，再读就回退到 runner）
          const rendered = bg.jobs.read?.(bg.id, bg.owner)?.result;
          // 后台监控自己出错时存的只是「先查询」的提示，改查 runner 拿真实状态（仍在运行会重新登记）
          if (typeof rendered === 'string' && !rendered.startsWith('status: monitor_failed')) return track({ job_id: args.job_id, status: /^status: (\S+)/.exec(rendered)?.[1], rendered });
        }
      }
      // 后台任务已结算时 runner 的结果文件已在，只查一次取完整结果
      value ??= withReport(await conductor.waitJob(args.job_id, bg ? 0 : seconds, exec?.signal));
      return notifyOnDone(finish(track(value)), exec, finish);
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
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !args.job_id.trim()) throw new Error('codex_cancel: job_id 必须是非空字符串');
      activeJobs.delete(args.job_id);
      const bg = liveBackground(args.job_id, exec);
      // 取消前先挂上等待：后台循环随后看到任务结束并结算，算作已被等到，DSH 不再另发一条结束通知。
      // wsl.exe 出错时取消没执行，撤掉等待，免得它吞掉任务之后真正结束时的通知
      const stop = new AbortController();
      const settled = bg?.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner, stop.signal).catch(() => {});
      const value = await conductor.cancel(args.job_id);
      if (value.error_kind === 'bridge_error') stop.abort();
      await settled;
      return value;
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
  // 没有 LOCALAPPDATA（Linux 上跑测试）时不写，免得落到当前目录
  if (process.env.LOCALAPPDATA) try {
    const dir = path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'loaded.json'),
      JSON.stringify({ loadedAt: new Date().toISOString(), pid: process.pid, module: import.meta.url, workspaces: cfg.roots }, null, 1));
  } catch {}
}
