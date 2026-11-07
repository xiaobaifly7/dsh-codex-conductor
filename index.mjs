// dsh-codex-conductor —— 「DSH agent 规划 → WSL 里的 Codex 执行 → agent 验收」的执行层与护栏
//
// 执行交给随包附带的 runner/codex_runner.py，在 WSL 里运行（超时、断线、重试、写锁、
// 按 thread 续跑、改动快照都在那里）。本插件负责：
//   · 结构化派活：codex_run 的任务、必填验收标准、执行约束和允许范围经 stdin 交给 runner，
//     要求 Codex 按 report.schema.json 逐条回报；结果里标出自报未满足、偏离计划和范围外的改动
//   · 等待与取消：start 后立即登记 DSH 后台任务（任务表里看得到进度和结束摘要），经任务表等结果；
//     到点仍在执行就留在后台，Codex 结束后 DSH 发任务通知，agent 再读结果（没有 jobs 服务就用有界的 `status --wait` 照旧轮询）；
//     中途停止时在 WSL 里 cancel，Linux 侧进程树由 runner 自己清理（taskkill wsl.exe 清不到）
//   · 护栏：config.workspaces 内的会话，写文件类工具一律拒绝，shell 只放行只读核验命令
//   · 防虚报：回合结束时声称已派 Codex、却没调用 codex_* 也没有在跑的任务，就提醒它补上或更正
//
// 护栏 fail-closed：范围内判定出错就拒绝并给出原因；范围外的会话完全不受影响。

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'codex-conductor';
// systemPrompt 不列为依赖（这里的 inject 每一项都是必需的），用 ctx.get 取：有就注入规划要求，没有照样能用其余功能
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
  // 允许 codex_run 传 host_access=true，让 Codex 在沙箱外运行（能启动 Windows 程序）；默认关闭
  allowHostAccess: false,
  // runner 在 WSL 里读取这个文件，用 --output-schema 约束 Codex 的最终答复
  reportSchema: here('./report.schema.json'),
  // 用户写给 DeepSeek 的规划要求（Markdown）；留空用 %LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md
  plannerPromptFile: '',
};

const PLANNER_TEMPLATE = `<!--
DeepSeek 派活给 Codex 前的规划要求（dsh-codex-conductor）。

写在这段注释下面的内容，会作为系统提示词的一段注入给 DeepSeek，每一步都带着；
它是给 DeepSeek 自己规划用的（怎么拆任务、写 task 和验收标准时要注意什么），不会原样发给 Codex。
保存后下一步就生效，不用重载插件。只留这段注释（或清空文件）就不注入任何内容。
-->
`;

// 规划要求文件的有效内容：去掉 HTML 注释；文件不存在或读不了就当没有
export function plannerPrompt(file) {
  try {
    return readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch {
    return '';
  }
}

export function plannerSection(text) {
  return text ? '## 派活给 Codex 前的规划要求（用户设定）\n' +
    '每次用 codex_run 派活前，都按下面的要求规划、写 task 和 acceptance。这是用户给你的规划要求，不要原样抄进给 Codex 的 task。\n\n' +
    text : '';
}

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
const SED_ADDRESS = String.raw`(?:\d+(?:,\d+)?|/[^/\\$]*/(?:,/[^/\\$]*/)?)`;
const SED_PRINT = new RegExp(String.raw`^\s*${SED_ADDRESS}p(?:\s*;\s*${SED_ADDRESS}p)*\s*;?\s*$`);

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

const under = (p, r) => p === r || p.startsWith(`${r}/`);

function inWorkspace(cwd, roots) {
  const c = normPath(cwd);
  return c !== '' && roots.some((r) => under(c, r));
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
  // -ePATTERN/-fFILE 等会吞掉后面的字母，其中的 O 不是 pager 开关。
  if (sub === 'grep' && rest.some((a) => /^-[^-efmCBA]*O/.test(a) || (a.startsWith('--') && a !== '--' &&
    '--open-files-in-pager'.startsWith(a.split('=')[0])))) return false;
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_READ.has(a));
  if (sub === 'config') return (rest.length === 1 && ['-l', '--list'].includes(rest[0])) ||
    (rest[0] === '--get' && rest.length > 1 && rest.slice(1).every((a) => !a.startsWith('-')));
  if (sub === 'remote') return rest.every((a) => ['-v', '--verbose'].includes(a));
  if (sub === 'tag') return rest.length === 0 ||
    (['-l', '--list'].includes(rest[0]) && rest.slice(1).every((a) => !a.startsWith('-')));
  if (sub === 'stash') return rest.length === 1 && rest[0] === 'list';
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
  // 展开后的词可能变成被过滤的开关，不能把它当成普通文件参数。
  if (/^(git|iconv|find|rg|sort|uniq|tree|npm|pnpm|yarn|node|go|cargo|make)$/.test(cmd) &&
      args.some((a) => a.includes('$'))) return false;
  const positional = args.filter((a) => !a.startsWith('-')).length;
  switch (cmd) {
    case 'git': return gitAllowed(args);
    case 'bash': case 'sh': return args[0] === '-n' && args.length > 1 && args.slice(1).every((a) => !a.startsWith('-'));
    case 'iconv': return !args.some((a) => a === '-o' || a.startsWith('--output'));
    case 'find': return !args.some((a) => FIND_ACTIONS.has(a));
    case 'rg': return !args.some((a) => a.startsWith('--pre'));
    case 'sort': return !args.some((a) => /^-[^-]*o/.test(a) || (a.startsWith('--') && a !== '--' &&
      ['--output', '--compress-program', '--random-source'].some((flag) => flag.startsWith(a.split('=')[0]))));
    case 'uniq': return positional <= 1;
    // printf -v 能给任意变量赋任意值
    case 'printf': return !args[0]?.startsWith('-v') && !args[0]?.includes('$');
    case 'tree': return !args.some((a) => a === '-o');
    // 后面再出现开关（-i、--in-place、-e、-f）就可能写文件或执行命令；
    // 文件参数里的 $ 和 { 也不放行：$(printf -- -i)、{-i,f} 展开后同样变成开关
    case 'sed': return args[0] === '-n' && args.length >= 2 && SED_PRINT.test(args[1]) && args.slice(2).every((a) => !/^-|[{$]/.test(a));
    case 'python': case 'python3': return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]);
    case 'npm': case 'pnpm': case 'yarn': return args[0] === 'test' || (args[0] === 'run' && /^test/.test(args[1] ?? ''));
    case 'node': return args[0] === '--test' || args[0] === '--check';
    case 'go': return ['test', 'vet'].includes(args[0]) && !args.some((a) => /^--?(exec|toolexec|vettool)(=|$)/.test(a));
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

// 跑一个命令，返回它输出的最后一行 JSON。timeoutMs 到了还没结束（WSL 卡死或起不来）就结束它并按 bridge_error 返回，
// 不等 close：进程树没收干净时 close 可能一直不来
export function runProcess(command, argv, { stdin, signal, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
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
    // 用 1 秒一跳的 interval，而不是一个长 setTimeout：Windows 上 libuv 计时走 QueryPerformanceCounter，含睡眠时间，
    // 一个长 setTimeout 会在电脑睡眠唤醒后立刻判超时、误杀在飞的 status；interval 睡眠期间只补一跳（约 1 秒），不会误杀，
    // 也不会因 timeoutMs 超过 2^31 而被 Node 夹成 1 毫秒立刻触发。
    let ticks = 0;
    const timer = timeoutMs && setInterval(() => {
      if (++ticks * 1000 < timeoutMs) return;
      clearInterval(timer);
      child.kill();
      resolve({ status: 'failed', error_kind: 'bridge_error', retryable: true,
        error: `${command} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已结束它（WSL 可能卡住或正在启动）` });
    }, 1000);
    child.on('error', (error) => {
      clearInterval(timer);
      resolve({ status: 'failed', error_kind: 'bridge_error', error: error.message, retryable: true });
    });
    child.on('close', (code) => {
      clearInterval(timer);
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

// 调用 WSL 里的 runner。不设 WSL_UTF8 时 wsl.exe 自己的报错是 UTF-16LE，按 UTF-8 读出来是乱码
// exec 可注入，默认 runProcess；测试据此验证超时/stdin/signal/env 真的传到了 spawn，而不是只在假 run 上验证
export const runRunner = (cfg, args, opts = {}, exec = runProcess) =>
  exec('wsl.exe', runnerArgv(cfg, args), { ...opts, env: { ...process.env, WSL_UTF8: '1' } });

// start / cancel 正常几秒就返回，冷启动 WSL 也用不了这么久；status 在它自己的等待之外再留这么多余量
const BRIDGE_TIMEOUT_MS = 120_000;
const BRIDGE_SLACK_MS = 60_000;

export function createConductor(cfg, run = runRunner) {
  // 每次等待是一个有界的 `status --wait` 进程，到点即退出；仍在执行时 runner 会带回空闲秒数和最近动作
  async function waitJob(jobId, seconds, signal) {
    // 夹在 1 天内：既防超大值让底层 status 等上几十天，也让 timeoutMs 远小于 2^31
    const wait = Math.min(Math.max(0, seconds), 86_400);
    const value = await run(cfg, ['status', jobId, '--wait', String(wait)], { signal, timeoutMs: wait * 1000 + BRIDGE_SLACK_MS });
    if (signal?.aborted) {
      await cancel(jobId);
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
    // host_access 不管 write 都在沙箱外运行，write=false 的只读只靠提示约束
    if (args.host_access === true) argv.push('--sandbox', 'danger-full-access');
    else if (args.write === true) argv.push('--sandbox', 'workspace-write');
    if (args.resume) argv.push('--resume', args.resume);
    if (args.use_user_config === true) argv.push('--use-user-config');
    if (cfg.reportSchema) argv.push('--schema', cfg.reportSchema);
    for (const s of args.scope ?? []) argv.push('--scope', s);
    for (const root of args.writable_roots ?? []) argv.push('--writable-root', root);
    // runner 在截取前 300 条改动之前就过滤，改动数和超出 scope 的检查才准
    for (const rx of cfg.ignoreChanges ?? []) argv.push('--ignore', rx.source);
    const prompt = composePrompt(args.task, args.acceptance, args.scope, { hostAccess: args.host_access === true, write: args.write === true,
      ignore: (cfg.ignoreChanges ?? []).map((rx) => rx.source) });
    return run(cfg, argv, { stdin: prompt, signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  function cancel(jobId) {
    return run(cfg, ['cancel', jobId], { timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  return { start, waitJob, cancel };
}

export function composePrompt(task, acceptance, scope = [], { hostAccess = false, write = false, ignore = [] } = {}) {
  return `${task.trim()}\n\n## 验收标准\n完成后逐条自查，每条都要满足：\n` +
    acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join('\n') +
    '\n\n## 执行约束\n' +
    '- 只做上面任务和验收标准要求的事，不扩大范围，不顺手重构或修改无关文件。\n' +
    (scope.length ? `- 只允许改动这些路径：${scope.join('、')}；其他文件一律不要动。\n` : '') +
    (ignore.length ? `- 路径（相对任务目录，用 / 分隔）匹配这些正则的文件会被其他进程持续写入：${ignore.join('、')}。` +
      '它们在任务期间的变化不一定是你造成的：不要因此认为现状与任务不符，也不要因此把验收标准标为 blocked；' +
      '任务或验收标准本身要求查看或修改这些文件时照常处理。\n' : '') +
    (hostAccess ? '- 你在沙箱外运行，对这台机器有完全访问权限，可以通过 WSL interop 启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V cmdlet 等）。' +
      '只做任务需要的事；任务没有点名的虚拟机、文件和网络设置，不要删除、停止、重建或改配置。\n' : '') +
    (hostAccess && !write ? '- 这是只读调查：不要修改任何文件，也不要改变虚拟机、网络或系统状态。\n' : '') +
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
    .filter((p) => { const a = abs(p); return !roots.some((r) => under(a, r)); });
}

export function validateRun(args) {
  if (typeof args?.task !== 'string' || args.task.trim().length < 10) throw new Error('codex_run: task 必须写清目标、相关路径和约束（至少 10 个字符）');
  if (!Array.isArray(args.acceptance) || args.acceptance.length === 0 || args.acceptance.length > 20 ||
    args.acceptance.some((a) => typeof a !== 'string' || a.trim().length < 4)) {
    throw new Error('codex_run: acceptance 必须是 1–20 条可核验的验收标准（每条至少 4 个字符）');
  }
  // 不传就默认只读时，实际常因此白跑一整轮（只读任务又不能 resume），所以必须明说
  if (typeof args.write !== 'boolean') {
    throw new Error('codex_run: write 必须是布尔值 true 或 false（不能省略，也不能写成字符串）：要改文件、做修复或建备份传 true，只读调查传 false');
  }
  for (const k of ['cwd', 'resume', 'effort']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k].trim())) throw new Error(`codex_run: ${k} 必须是非空字符串`);
  }
  if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
    throw new Error('codex_run: wait_seconds 必须是非负整数');
  }
  for (const k of ['scope', 'writable_roots']) {
    if (args[k] !== undefined && (!Array.isArray(args[k]) || args[k].length > 50 ||
      args[k].some((s) => typeof s !== 'string' || !s.trim()))) {
      throw new Error(`codex_run: ${k} 必须是不超过 50 个非空路径`);
    }
  }
  if (args.writable_roots?.length && args.write !== true) throw new Error('codex_run: writable_roots 需要 write=true');
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

// 受阻条目里提到这些，可能是沙箱里的 Codex 启动不了 Windows 程序
const WINDOWS_BLOCK = /\.exe\b|interop|Hyper-V|cmdlet|Windows 程序/i;

// 汇报条数和验收标准一致、编号也对得上时，逐条汇报显示验收标准原文（Codex 几乎总会改写条目），下一步不再重复列出。
// 编号认 1. / 1) / 1、 / 1: / 第1条，NFKC 先把全角数字和标点换成半角
function sameCriteria(report, acceptance) {
  const criteria = report?.criteria ?? [];
  return criteria.length > 0 && acceptance?.length === criteria.length && criteria.every((c, i) => {
    const n = /^\s*(?:第\s*)?\(?(\d+)\s*(?:条|[.):、])/.exec(String(c.criterion ?? '').normalize('NFKC'))?.[1];
    return n === undefined || Number(n) === i + 1;
  });
}

// resumed：这次是否带了 resume；codex_status 不知道时传 undefined，按 runner 有没有给 thread_id 判断
// hostAccess：插件开了 allowHostAccess 时，Windows 程序受阻就提示带 host_access=true 派回，否则提示自己跑
// readOnly：这次是不是只读任务；host_access=true、write=false 的任务沙箱是 danger-full-access，只能由调用方告知
export function nextStep(value, acceptance, resumed, { hostAccess = false, readOnly = value.sandbox === 'read-only' } = {}) {
  if (value.status === 'running') return `任务 ${value.job_id} 仍在执行，用 codex_status 等结果，不要自己动手补做。`;
  // runner 的取消结果不带改动清单和沙箱，可写任务可能已改了一半
  if (value.status === 'cancelled') {
    return 'Codex 任务已取消（用户停止、会话归档或调用中止）：不要自行续跑或重派，先问用户。' +
      '如果这是可写任务，取消前可能已改了部分文件且没有改动清单，核验前先用 git status 或对比文件确认现状。';
  }
  // 只读任务用 --ephemeral 运行、不留会话记录，自己的 thread_id 续不上；只有它续跑的写任务线程还能续
  const resumable = value.sandbox !== 'read-only' || (resumed ?? Boolean(value.thread_id));
  if (value.status !== 'completed') {
    // wsl.exe 出错只说明这次没查到或没取消成功，任务本身可能还在跑；重派会多出一个同样的任务
    if (value.error_kind === 'bridge_error' && value.job_id) {
      return `连接 WSL 出错，Codex 任务 ${value.job_id} 可能仍在运行：先用 codex_status 查询，不要直接重派。`;
    }
    if (!value.retryable) return '这次失败不可重试：把 error 原样告诉用户，不要改为自己动手。';
    // worker_died 的可写任务：退出前可能已改了部分文件，续跑后的改动清单也不含这些
    const partial = value.error_kind === 'worker_died' && !readOnly
      ? '退出前 Codex 可能已改了部分文件且没有改动清单，续跑后的清单也不含它们，核验前先用 git status 或对比文件确认现状。' : '';
    return (resumable ? '这次失败可重试：稍后用同样的参数再派一次（有 thread_id 时带 resume）。'
      : '这次失败可重试：稍后用同样的参数再派一次，不要带 resume（只读任务不留会话，不能续跑）。') + partial;
  }
  const report = value.report ?? {};
  const original = sameCriteria(report, acceptance);
  const flagged = (report.criteria ?? []).map((c, i) => [c, i]).filter(([c]) => c.status !== 'met');
  const alerts = [
    flagged.length ? `Codex 自报有 ${flagged.length} 条未满足或受阻：` +
      flagged.map(([c, i]) => `${original ? `第 ${i + 1} 条` : c.criterion}（${c.status}）`).join('；') : '',
    // 只读任务改不了文件，实际受阻常因 write 传了 false
    flagged.length && readOnly ? '这是只读任务：受阻如果是因为不能改文件或建备份，派回时传 write=true' : '',
    // 只看 blocked：not_met 多是结果不对（比如产出 .exe 的编译失败了），不是启动不了程序
    value.sandbox !== 'danger-full-access' && flagged.some(([c]) => c.status === 'blocked' && WINDOWS_BLOCK.test(`${c.criterion} ${c.evidence}`))
      ? `受阻条目提到 Windows 程序：如果确实是因为沙箱里的 Codex 启动不了它们，${hostAccess ? '派回时传 host_access=true' : '这类检查你自己跑'}` : '',
    report.deviations?.length ? `Codex 自报偏离计划：${report.deviations.join('；')}` : '',
    value.out_of_scope?.length ? `改动超出 scope：${value.out_of_scope.join('、')}。这份清单来自目录快照，可能含同时段其他进程写的文件（如定期日志）；` +
      '不在 Codex 自报 files_changed 里、明显来自其他进程的，只需一句说明，不算 Codex 越界，也不用请用户决定；其余的先核实是否应保留；' +
      '总是由其他进程写的文件，可以请用户写进插件配置 ignoreChanges，以后不再列出' : '',
  ].filter(Boolean);
  const list = original ? '' : (acceptance ?? []).map((a, i) => `${i + 1}. ${a}`).join('\n');
  const where = original ? '上面逐条汇报里的验收标准' : list ? '下面的验收标准' : '验收标准';
  return (alerts.length ? `${alerts.join('\n')}\n偏离或冲突需要用户取舍的，先向用户说明，不要替用户选。\n` : '') +
    `Codex 的答复不是完成证据。用只读检查逐条核验${where}，给出每条的证据；` +
    // resume 不继承沙箱：漏传 host_access 会回到沙箱，Codex 又启动不了 Windows 程序
    `有任何一条不通过，就写清差距，${resumable ? `用 codex_run 带 resume="${value.thread_id ?? ''}"` +
      `${value.sandbox === 'danger-full-access' ? ' 和 host_access=true' : ''} 派回修正`
      : '用 codex_run 重新派一个写全背景的完整任务（只读任务不留会话，不能 resume）'}。${list ? `\n${list}` : ''}`;
}

const MARK = { met: '✓', not_met: '✗', blocked: '⛔' };
// 每条证据最多显示的字数：Codex 的答复本来就不是完成证据，全文留在 runner 任务目录的 last_message.txt
const EVIDENCE_LIMIT = 800;

// 一行摘要，任务表的 detail 和结果第一行都以它开头，如 completed · 12 met / 1 blocked · 3 files · 148 s
function summaryLine(value) {
  const criteria = value.report?.criteria ?? [];
  const counts = Object.keys(MARK).map((s) => [s, criteria.filter((c) => c.status === s).length])
    .filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(' / ');
  const files = value.files_changed_total ?? value.files_changed?.length;
  const done = value.status === 'completed';
  return [String(value.status), done ? counts : value.error_kind, done && files !== undefined && `${files} files`,
    typeof value.duration_s === 'number' && `${Math.round(value.duration_s)} s`].filter(Boolean).join(' · ');
}

// 已完成的结果只留核验用得上的：任务目录和一行改动清单；失败、取消、仍在执行的保留全部字段，便于排查。
// 用量、日志目录等完整字段在 runner 的 result.json（runnerHome/jobs/<job_id>/）里
function details(rest) {
  if (rest.status !== 'completed') return [JSON.stringify(rest, null, 2)];
  // runner 最多列 300 条，总数照实给
  const shown = rest.files_changed?.length;
  const total = rest.files_changed_total ?? shown;
  const files = Array.isArray(rest.files_changed) && `改动文件（${rest.files_changed_source ?? '来源未知'}，共 ${total} 个` +
    `${total > shown ? `，只列出前 ${shown} 个，超出 scope 的检查也只看这些，其余的到任务目录里核对` : ''}）：` +
    (rest.files_changed.map((f) => `${f.path}(${f.change})`).join('、') || '无');
  return [rest.cwd && `任务目录：${rest.cwd}`, files, rest.report_note].filter(Boolean);
}

function render(value) {
  // 后台任务结算时存下的成品文字，原样交回
  if (typeof value?.rendered === 'string') return [{ type: 'text', text: value.rendered }];
  // acceptance 不放进详细字段：逐条汇报或下一步里已列出
  const { final_message: answer, report, next, acceptance, ...rest } = value ?? {};
  const full = rest.log_dir ? `${rest.log_dir}/last_message.txt` : 'runner 任务目录里的 last_message.txt';
  // 不合 schema 的汇报（如 evidence 为 null）也要能显示；截断处不留半个代理对
  const clip = (v) => {
    const s = typeof v === 'string' ? v : String(v ?? '');
    return s.length > EVIDENCE_LIMIT ? `${s.slice(0, EVIDENCE_LIMIT).replace(/[\uD800-\uDBFF]$/, '')}…（已截断，全文见 ${full}）` : s;
  };
  const original = sameCriteria(report, acceptance);
  const reportLines = report ? [
    '--- Codex 逐条汇报 ---', `概述：${report.summary ?? ''}`,
    ...(report.criteria ?? []).map((c, i) => `${MARK[c.status] ?? '?'} ${i + 1}. ${original ? acceptance[i] : c.criterion} —— ${clip(c.evidence)}`),
    `自报改动：${report.files_changed?.join('、') || '无'}`,
    `偏离计划：${report.deviations?.join('；') || '无'}`,
    `未解决：${report.unresolved?.join('；') || '无'}`,
  ] : [];
  const extra = details(rest);
  return [{ type: 'text', text: [
    `${summaryLine(value ?? {})}${rest.job_id ? `  job_id: ${rest.job_id}` : ''}${rest.thread_id ? `  thread_id: ${rest.thread_id}` : ''}`,
    ...(report ? reportLines
      : answer ? [`--- Codex 最终答复${rest.truncated ? `（超过 8000 字已截断，全文见 ${full}）` : ''} ---`, answer] : []),
    ...(extra.length ? ['--- 详细字段 ---', ...extra] : []),
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

// 工具卡片和任务表用的短标题：任务的第一行，截到 n 个字
export function taskLine(args, n) {
  const line = typeof args?.task === 'string' ? args.task.trim().split('\n')[0].trim() : '';
  return line.length > n ? `${line.slice(0, n)}…` : line;
}
// 结果第一行里 job_id 之前的一行摘要
const resultSummary = (result) =>
  (result?.content?.find((c) => c?.type === 'text')?.text ?? '').split('\n')[0].split('  job_id')[0].trim();
// 聊天里 codex_* 调用卡片的标题：进行中显示派了什么，结束后换成一行摘要；只依赖参数和结果，重放时也一样
const PRESENT = {
  codex_run: {
    presentCall: (a) => ({ card: 'generic', kind: a?.write === true || a?.host_access === true ? 'execute' : 'read', rawInput: a,
      title: [`${a?.resume ? 'Codex 返工' : 'Codex'}${a?.host_access === true ? '（主机）' : ''}`, taskLine(a, 60)].filter(Boolean).join(' · ') }),
    presentResult: (a, r) => r?.isError || !resultSummary(r) ? undefined
      : { card: 'generic', title: [`Codex ${resultSummary(r)}`, taskLine(a, 40)].filter(Boolean).join(' · ') },
  },
  codex_status: {
    presentCall: (a) => ({ card: 'generic', kind: 'read', title: `Codex 状态 ${a?.job_id ?? ''}` }),
    presentResult: (a, r) => r?.isError || !resultSummary(r) ? undefined
      : { card: 'generic', title: `Codex 状态 ${a?.job_id ?? ''} · ${resultSummary(r)}` },
  },
  codex_cancel: {
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `取消 Codex ${a?.job_id ?? ''}` }),
  },
};
const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;

// 任务目录：显式 cwd > 包含会话工作区的 workspaces 条目的 cwd（最具体的那条）> 会话工作区
export function taskCwd(args, session, workspaces) {
  if (args.cwd) return args.cwd;
  const hits = workspaces.filter((w) => w.cwd && inWorkspace(session, [w.root]));
  return hits.sort((a, b) => b.root.length - a.root.length)[0]?.cwd ?? session;
}

function settings(config, logger) {
  // workspaces 的条目可以是路径字符串，也可以是 {path, cwd}
  const workspaces = (Array.isArray(config.workspaces) ? config.workspaces : [])
    .map((w) => typeof w === 'string' ? { root: normPath(w) }
      : { root: normPath(w?.path), cwd: typeof w?.cwd === 'string' && w.cwd.trim() ? w.cwd.trim() : undefined })
    .filter((w) => w.root);
  // 正则列表：非法的警告后跳过，其余照常生效
  const patterns = (key) => (Array.isArray(config[key]) ? config[key] : []).flatMap((pattern) => {
    try {
      return [new RegExp(pattern)];
    } catch (error) {
      logger?.warn?.(`[codex-conductor] 忽略无效的 ${key} 正则 ${pattern}：${error.message}`);
      return [];
    }
  });
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config).filter(([k, v]) => k in DEFAULTS && v !== undefined && v !== '')),
    workspaces,
    roots: workspaces.map((w) => w.root),
    denyTools: new Set(Array.isArray(config.denyTools) ? config.denyTools : []),
    allowCommands: patterns('allowCommands'),
    ignoreChanges: patterns('ignoreChanges'),
  };
}

// 后台循环每次 `status --wait` 的秒数，只决定任务表进度行多久刷新一次
const BG_WAIT = 20;
// runner 取消后会立即写下结果，后台循环一秒内就能看到，这里只是上限
const CANCEL_SETTLE_MS = 30_000;
const JOB_STATUS = { completed: 'completed', cancelled: 'killed' };

export function apply(ctx, config = {}, run = runRunner) {
  const cfg = settings(config, ctx.logger);
  const conductor = createConductor(cfg, run);

  // 用户设定的规划要求：作为系统提示词的一段，每次组装时现读文件，改完下一步就生效
  const plannerFile = cfg.plannerPromptFile ||
    (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor', 'planner-prompt.md') : '');
  if (plannerFile && !existsSync(plannerFile)) try {
    mkdirSync(path.dirname(plannerFile), { recursive: true });
    writeFileSync(plannerFile, PLANNER_TEMPLATE);
  } catch {}
  // 经 ctx.get 取服务（没列进 inject 时 ctx.systemPrompt 取不到），登记随插件卸载自动撤销。
  // 同名段已登记（新旧实例同时在）会抛错，这时只放弃注入，不连累其余功能；
  // 组装出错会让所有请求失败，所以 text 里不抛错（plannerPrompt 读不了就返回空）
  let plannerInjected = false;
  if (plannerFile) try {
    ctx.get?.('systemPrompt')?.section({ name: 'codex-conductor:planner', order: 10100, interpolate: false,
      text: () => plannerSection(plannerPrompt(plannerFile)) });
    plannerInjected = Boolean(ctx.get?.('systemPrompt'));
  } catch (error) {
    ctx.logger?.warn?.(`[codex-conductor] 规划要求没能注入系统提示词：${error?.message ?? error}`);
  }
  // 只记录有后台监控负责清理的任务，轮询回退不能保证跨轮状态仍有效。
  const activeJobs = new Set();

  // 这个 runner 任务仍在进行的 DSH 后台任务。按 DSH 任务表查而不记在插件内存里：
  // 插件热重载后旧的后台任务和它的等待循环仍在，内存记录却清空了，会重复登记、重复送回结果
  function liveBackground(jobId, exec) {
    const owner = exec?.agent?.id;
    const jobs = owner === undefined ? undefined : ctx.get?.('jobs');
    // 标签是「Codex <job_id>」或后面再跟「 · 任务摘要」
    const base = `Codex ${jobId}`;
    const job = jobs?.list(owner).find((j) => j.kind === 'codex' && (j.label === base || j.label?.startsWith(`${base} · `)) &&
      (j.status === 'running' || j.status === 'stopping'));
    return job && { jobs, id: job.id, owner };
  }

  // 后台循环：有界地反复 `status --wait`，结束时把与工具结果相同的文字交给 DSH 送回会话
  async function watch(jobId, handle, finish) {
    activeJobs.add(jobId);
    try {
      let bridgeErrors = 0;
      for (;;) {
        const value = withReport(await conductor.waitJob(jobId, BG_WAIT));
        if (value.status === 'running') {
          bridgeErrors = 0;
          handle.updateProgress(`Codex 执行中，距上次活动 ${value.seconds_since_last_event ?? '?'} 秒：${value.last_activity ?? '启动中'}`);
          continue;
        }
        // status 是只读的：一次 wsl.exe 出错（含电脑睡眠唤醒、发行版重启瞬间）不代表任务结束，连续多次才放弃
        if (value.error_kind === 'bridge_error') {
          if (++bridgeErrors < 3) continue;
          throw new Error(value.error);
        }
        const done = finish(value);
        return { status: JOB_STATUS[done.status] ?? 'failed', detail: summaryLine(done), result: render(done)[0].text };
      }
    } catch (error) {
      const lost = { job_id: jobId, status: 'monitor_failed', error: String(error?.message ?? error),
        next: `后台等待出错，底层 Codex 任务可能仍在运行：先用 codex_status 查询 ${jobId}，不要直接重派。` };
      return { status: 'failed', detail: `无法继续等待 Codex 任务 ${jobId}`, result: render(lost)[0].text };
    } finally {
      activeJobs.delete(jobId);
    }
  }

  // 登记 DSH 后台任务（同一个 runner 任务只登记一个），结束后由 DSH 把结果送回会话；
  // 没有 jobs 服务、没有 agent 或登记失败时返回 undefined，调用方照旧轮询
  // label：任务表里这一行的标题，带上任务摘要才看得出是哪件事；codex_status 补登记时不知道任务，只用 job_id
  function background(jobId, exec, finish, label = `Codex ${jobId}`) {
    if (!exec?.agent) return undefined;
    try {
      const live = liveBackground(jobId, exec);
      if (live) return live;
      const jobs = ctx.get?.('jobs');
      if (!jobs) return undefined;
      const owner = exec.agent.id;
      const id = jobs.start({
        owner, kind: 'codex', label, outputLimitBytes: 65536,
        run: (handle) => ({
          done: watch(jobId, handle, finish),
          cancel: () => { Promise.resolve(conductor.cancel(jobId)).catch(() => {}); },
        }),
      });
      return { jobs, id, owner };
    } catch {
      return undefined;
    }
  }

  // 等 runner 任务的结果。有后台任务时经 DSH 任务表等：结算时这次等待算作已被等到，DSH 就不会再把同一结果作为通知补发
  async function collect(jobId, bg, seconds, signal) {
    if (bg) {
      let view;
      try {
        view = await bg.jobs.wait(bg.id, Math.max(1, seconds * 1000), bg.owner, signal);
      } catch (error) {
        // 中途停止：结束后台任务（它的 cancel 会取消 runner 任务），等它结算完再抛出，免得之后又冒出一条结束通知。
        // 抛一条明确的错误：jobs.wait 的中止拒绝直接抛出会被 DSH 渲染成 Error: [object Object]
        if (signal?.aborted) {
          bg.jobs.kill(bg.id, bg.owner, 'tool call aborted');
          await bg.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner).catch(() => {});
          throw new Error('Codex 任务的等待已被中止');
        }
        throw error;
      }
      // 第一次刷新进度（约 20 秒）前 progress 还没有；DSH 要求工具结果是无损 JSON，不能带值为 undefined 的字段
      if (view.status === 'running' || view.status === 'stopping') {
        return { job_id: jobId, status: 'running', ...(view.progress ? { last_activity: view.progress } : {}) };
      }
      // 结算时存下的是 codex_run 渲染好的完整结果（含 acceptance 和 out_of_scope），runner 重查拿不到这些；
      // 这次等待已算作被等到，DSH 不会再作为通知送回，所以在这里原样交回（结果只给一次，再读就回退到 runner）
      const rendered = bg.jobs.read?.(bg.id, bg.owner)?.result;
      // 后台监控自己出错时存的只是「先查询」的提示，改查 runner 拿真实状态（仍在运行会重新登记）
      if (typeof rendered === 'string' && !rendered.startsWith('monitor_failed')) return { job_id: jobId, status: /^\S+/.exec(rendered)?.[0], rendered };
    }
    // 后台任务已结算时 runner 的结果文件已在，只查一次取完整结果
    return withReport(await conductor.waitJob(jobId, bg ? 0 : seconds, signal));
  }

  // 仍在执行时交给后台任务，结束后 DSH 只发一条带摘要的任务通知，完整结果要用 job_output 读；没有后台任务就照旧轮询
  function notifyOnDone(value, exec, finish) {
    if (value.status !== 'running' || !value.job_id) return value;
    const id = background(value.job_id, exec, finish)?.id;
    if (id === undefined) return value;
    return { ...value, background_job_id: id,
      note: `已登记为后台任务 ${id}：Codex 结束后 DSH 会发一条任务通知（只有一行摘要），届时用 job_output 读取 ${id} 的完整结果（含逐条汇报和下一步），在此之前不必轮询。`,
      next: '等 DSH 的任务通知，再用 job_output 读取完整结果；在此之前不要自己动手补做，也不要重复派同一个任务。' };
  }

  ctx.tools.register({
    ...PRESENT.codex_run,
    name: 'codex_run',
    description: '把任务交给 WSL 里的 Codex 执行（它看不到本对话），并等待结果。必须给出验收标准和 write：' +
      '要改文件、做修复或建备份传 write=true，只读调查传 false；scope 限定允许改动的路径。' +
      '沙箱内跨目录写入还要用 writable_roots 指定额外可写目录，并将实际写入目标列入 scope。Codex 会按验收标准逐条回报 ' +
      '（report），结果里还会标出它自报未满足、偏离计划和超出 scope 的改动。completed 后你要逐条只读核验，' +
      '不通过就带 resume=thread_id 派回修正。汇报格式由插件固定为 JSON，task/acceptance 里不要规定末行结论行之类的版式。' +
      (cfg.allowHostAccess === true
        ? '任务需要启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令等）或连接 Hyper-V 虚拟机时传 host_access=true；不传时 WSL 里的 Codex 启动不了 Windows 程序。'
        : 'WSL 里的 Codex 启动不了 Windows 程序（pwsh.exe、Hyper-V 命令等），不要把需要 Windows 运行时的检查写进 task/acceptance，这类检查你自己跑。'),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务：目标、相关文件路径、约束和背景。Codex 看不到本对话，必须写全。' },
        acceptance: { type: 'array', items: { type: 'string' }, description: '验收标准，1–20 条，每条写成可核验的结果：做完后应当存在什么、运行什么检查得到什么。' },
        write: { type: 'boolean', description: '必填。true 允许 Codex 修改任务目录及 writable_roots 指定目录里的文件（workspace-write 沙箱）；' +
          'false 只读调查：新开的只读任务不留会话，事后不能 resume；带 resume 追问写任务线程时仍可续跑' +
          `${cfg.allowHostAccess === true ? '，带 host_access=true 时也会保留会话' : ''}。要改文件、做修复或建备份就传 true。` },
        ...(cfg.allowHostAccess === true ? { host_access: { type: 'boolean', description: 'true 时 Codex 在沙箱外运行（danger-full-access），' +
          '可以通过 WSL interop 启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令）、连接 Hyper-V 虚拟机；write 仍决定能否改动（文件、虚拟机、网络和系统状态）：' +
          '要启动/停止/新建虚拟机，或运行会建、改虚拟机的脚本，也要传 write=true，否则 Codex 只做只读调查。不再有沙箱，只靠提示约束。只在任务需要时传。' } } : {}),
        scope: { type: 'array', items: { type: 'string' }, description: '允许 Codex 改动的文件或目录（相对任务目录或绝对路径）。须覆盖任务中所有写入目标，包括工作区外的复制目的地。' +
          '它不增加沙箱写权限；给了就写进约束，完成后在 out_of_scope 里列出范围外的改动。' },
        writable_roots: { type: 'array', items: { type: 'string' }, description: '本次任务在 cwd 以外需要写入的已有目录（Windows 路径或 /mnt/...）；需要 write=true。' +
          'workspace-write 沙箱会额外允许写入这些目录，scope 仍须列出所有允许修改的目标。仅对本次调用生效；host_access=true 时已无沙箱，不需要此参数。' },
        cwd: { type: 'string', description: '任务目录（Codex 在这里运行，write=true 时可写；沙箱内的额外可写目录用 writable_roots 指定），Windows 路径或 /mnt/... 都可以。' +
          '不传时：会话工作区属于配置里带 cwd 的 workspaces 条目，就用那个 cwd，否则用当前会话工作区。' +
          '只在 task 里写目标目录不会切换任务目录，要处理哪个目录就传哪个 cwd。' },
        resume: { type: 'string', description: '在上一次返回的 thread_id 上继续（返工、追问时用）。' },
        use_user_config: { type: 'boolean', description: '加载 WSL Codex 自己配置的 MCP 和 hooks（任务要用到这些工具时），启动更慢。' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: `推理强度。默认：write=true 时 ${cfg.effort || 'Codex 配置里的值'}，只读时 ` +
          `${cfg.readOnlyEffort || cfg.effort || 'Codex 配置里的值'}${cfg.model ? `（模型 ${cfg.model}）` : ''}。简单任务可调低以加快速度。` },
        wait_seconds: { type: 'integer', description: `最多等待秒数，默认 ${cfg.waitSeconds}；到时任务转入后台继续，` +
          '登记为后台任务时，Codex 结束后会收到任务通知，再用 job_output 读取完整结果；否则用 codex_status 接着等。' },
      },
      required: ['task', 'acceptance', 'write'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      validateRun(args);
      if (args.host_access === true && cfg.allowHostAccess !== true) {
        throw new Error('codex_run: 插件配置没有开启 allowHostAccess，不能传 host_access=true；Codex 只能在沙箱里运行，启动不了 Windows 程序');
      }
      const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces);
      if (!cwd) throw new Error('codex_run: 当前会话没有工作区，请传 cwd');
      const finish = (result) => {
        const outside = outOfScope(result, cwd, args.scope);
        const value = { ...result, acceptance: args.acceptance, ...(outside ? { out_of_scope: outside } : {}) };
        // 每轮结果都提醒一次规划要求：DeepSeek 正要据此规划下一次派活
        const reminder = value.status === 'completed' && plannerPrompt(plannerFile)
          ? '\n规划下一次派活前，再对照系统提示词里的「派活给 Codex 前的规划要求」。' : '';
        return { ...value, next: nextStep(value, args.acceptance, Boolean(args.resume),
          { hostAccess: cfg.allowHostAccess === true, readOnly: args.write !== true }) + reminder };
      };
      // 启动不随中止打断：runner 在打印 job_id 前就拉起了 Codex，这时杀掉 wsl.exe 会让 Codex 在 WSL 里没人管地跑下去；
      // 等拿到 job_id 再按中止取消它
      exec?.signal?.throwIfAborted();
      const started = await conductor.start(args, cwd);
      if (exec?.signal?.aborted) {
        if (started.job_id) await conductor.cancel(started.job_id);
        exec.signal.throwIfAborted();
      }
      // 启动后立即登记后台任务（任务表里看得到进度），再经任务表等到 wait_seconds；没有后台任务时直接等 runner
      const label = `Codex ${started.job_id} · ${taskLine(args, 40)}`;
      const value = started.status === 'running' && started.job_id
        ? await collect(started.job_id, background(started.job_id, exec, finish, label), args.wait_seconds ?? cfg.waitSeconds, exec?.signal)
        : withReport(started);
      return value.rendered ? value : notifyOnDone(finish(value), exec, finish);
    },
  });

  ctx.tools.register({
    ...PRESENT.codex_status,
    name: 'codex_status',
    description: '查询或继续等待 codex_run 返回的任务。已登记为后台任务（结果带 background_job_id）的，结束时会收到 DSH 任务通知，' +
      '用 job_output 读完整结果，不必调用本工具；没登记的才用它等，仍在执行时返回 last_activity（它最近在做什么）和距上次活动的秒数，' +
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
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
        throw new Error('codex_status: wait_seconds 必须是非负整数');
      }
      const finish = (value) => ({ ...value, next: nextStep(value, undefined, undefined, { hostAccess: cfg.allowHostAccess === true }) });
      const value = await collect(args.job_id, liveBackground(args.job_id, exec), args.wait_seconds ?? 600, exec?.signal);
      return value.rendered ? value : notifyOnDone(finish(value), exec, finish);
    },
  });

  ctx.tools.register({
    ...PRESENT.codex_cancel,
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
      const bg = liveBackground(args.job_id, exec);
      // 取消前先挂上等待：后台循环随后看到任务结束并结算，算作已被等到，DSH 不再另发一条结束通知。
      // wsl.exe 出错时取消没执行，撤掉等待，免得它吞掉任务之后真正结束时的通知
      const stop = new AbortController();
      const settled = bg?.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner, stop.signal).catch(() => {});
      const value = await conductor.cancel(args.job_id);
      if (value.error_kind === 'bridge_error') stop.abort();
      else activeJobs.delete(args.job_id);
      await settled;
      // 下一步要贴合「取消」这件事，不能套用重派话术
      const done = withReport({ job_id: args.job_id, ...value });
      let next;
      if (done.error_kind === 'bridge_error') {
        next = `这次 wsl.exe 调用出错，取消可能没执行，Codex 任务 ${args.job_id} 可能仍在运行：稍后再调用一次 codex_cancel（任务已结束时它会直接返回结果），不要重派；再出错就把 error 原样告诉用户。`;
      } else if (done.status === 'completed') {
        // 取消没赶上：任务已经完成，改动已经留下，按完成处理
        next = `取消没有生效：任务在取消前已经完成，改动已经留下。先把这点告诉用户。\n${nextStep(done, undefined, undefined, { hostAccess: cfg.allowHostAccess === true })}`;
      } else if (done.status === 'cancelled') {
        next = '已按本次调用取消。可写任务可能已改了一部分且没有改动清单，核验或重派前先用 git status 或对比文件确认现状。';
      } else {
        next = `任务 ${args.job_id} 在取消前已经结束（${done.error_kind ?? done.status}），没有结束任何进程；是否重派或续跑由用户决定，不要自行重派。`;
      }
      return { ...done, next };
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
      JSON.stringify({ loadedAt: new Date().toISOString(), pid: process.pid, module: import.meta.url, workspaces: cfg.roots,
        plannerPromptFile: plannerFile, plannerPromptInjected: plannerInjected }, null, 1));
  } catch {}
}
