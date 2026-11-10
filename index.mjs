// dsh-codex-conductor —— 「DSH agent 规划 → WSL 里的 Codex 执行 → agent 验收」的执行层与护栏
//
// 执行交给随包附带的 runner/codex_runner.py，在 WSL 里运行（超时、断线、重试、写锁、
// 按 thread 续跑、改动快照都在那里）。本插件负责：
//   · 结构化派活：codex_run 的任务、必填验收标准、执行约束和允许范围经 stdin 交给 runner，
//     要求 Codex 按 report.v2.schema.json 逐条回报；结果里标出自报未满足、偏离计划和范围外的改动
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
// helper 继承入口的重载 query，避免入口刷新后仍复用旧依赖。
const reloadQuery = new URL(import.meta.url).search;
const { validReport, blockingState, prepareContinuation } = await import(new URL(`./workflow.mjs${reloadQuery}`, import.meta.url));
const { runtimeIdentity, registerRuntimeTool } = await import(new URL(`./runtime.mjs${reloadQuery}`, import.meta.url));

const loadedIdentity = runtimeIdentity(import.meta.url);

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
  routerCheckUrl: '',
  codexRoute: null,
  model: '',
  effort: '',
  // 只读任务的推理强度，留空与 effort 相同
  readOnlyEffort: '',
  serviceTier: '',
  waitSeconds: 0,
  // 允许 codex_run 传 host_access=true，让 Codex 在沙箱外运行（能启动 Windows 程序）；默认关闭
  allowHostAccess: false,
  // 省略 host_access 时默认使用主机模式，仍须开启 allowHostAccess
  defaultHostAccess: false,
  // runner 在 WSL 里读取这个文件，用 --output-schema 约束 Codex 的最终答复
  reportSchema: here('./report.v2.schema.json'),
  // 用户写给 DeepSeek 的规划要求（Markdown）；留空用 %LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md
  plannerPromptFile: '',
  runtimeProfileFile: '',
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
// Seep 的任意 r2 命令入口也可调用 Shell 或写文件，不能当读取工具放行。
const MCP_WRITE = /(^|_)(write|edit|replace|insert|delete|remove|rename|move|create|patch|apply|execute|exec)(_|$)|^seep_r2_cmd$/i;
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
  '或 wsl 里的只读命令（git status/diff/log/show、ls、cat、head、tail、grep、find、wc、sha256sum、gzip -t、pytest、npm test 等，' +
  '可以用 | && for/if 组合，$(...) 里也只能是只读命令；不能写重定向（/dev/null 除外）、反引号、heredoc 或 $((...)) 算术、$[...] 算术）。' +
  "项目 tests 目录下的验证脚本可以直接跑：pwsh -NoProfile -File '<...\\tests\\xxx.ps1>'。" +
  'PowerShell -Command（包括只读查询）默认不放行；Windows 执行与核验交给主机访问模式的 codex_run。' +
  `检查 PowerShell 语法用随包脚本：pwsh.exe -NoProfile -File '${PS_SYNTAX_WIN}' 'D:\\path\\a.ps1' …` +
  `（Windows 的 pwsh.exe 用 Windows 路径；WSL 里的 pwsh 用 ${PS_SYNTAX}），输出 PARSE-OK / PARSE-FAIL 和出错行。`;

export function normPath(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  let s = p.trim().replace(/\\/g, '/');
  const windows = /^[A-Za-z]:/.test(s) || s.startsWith('//');
  // Resolve .. in WSL before converting a mount to its Windows drive.
  s = path.posix.normalize(s);
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(s);
  if (m) s = `${m[1]}:${m[2] ?? '/'}`;
  s = s.replace(/\/+$/, '') || '/';
  return windows || m ? s.toLowerCase() : s;
}

const under = (p, r) => p === r || p.startsWith(r === '/' ? r : `${r}/`);

function inWorkspace(cwd, roots) {
  const c = normPath(cwd);
  // '*' 匹配任何会话工作区
  return c !== '' && roots.some((r) => r === '*' || under(c, r));
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

// Bash removes a backslash-newline before recognizing operators.
function skipLineContinuations(command, i) {
  while (command[i] === '\\' && command[i + 1] === '\n') i += 2;
  return i;
}

// 按未加引号的 && || | ; & 和换行切段，段内按空白切词并去掉引号。$(...) 交给 inner 判定，通过后当作一个普通词。
// 返回 null 表示出现了不放行的结构：反引号、未通过的命令替换、进程替换、heredoc、写到 /dev/null 以外的重定向。
export function splitCommand(command, inner = () => false, braceSegments = new Set(), expansions = new Map()) {
  const segments = [];
  let words = [];
  let kinds = [];
  let word = '';
  let kind = 'literal';
  let started = false;
  let quote = null;
  let redirect = null;
  let valid = true;
  let syntax = '';
  let parameterWord = ''; // 字面 $ 用 X 占位，避免去掉引号后被误认成展开。
  let expanded = false;
  let glob = false;
  let fieldSplit = false;
  let unsafeParameter = false;
  const endWord = () => {
    if (started) {
      if (redirect) {
        if ((redirect !== '<' && word !== '/dev/null') || !braceExpansionsSafe(parameterWord)) valid = false;
        redirect = null;
      } else {
        words.push(word);
        kinds.push(kind);
        unsafeParameter ||= !braceExpansionsSafe(parameterWord);
        expanded ||= /\{(?:[^{}]*,[^{}]*|(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?)\}/.test(syntax);
        const pattern = /[*?]|\[[^\]]+\]/.test(syntax);
        glob ||= pattern;
        // test 的额外词可能变成操作符；固定字母/路径前缀的 glob 无法生成 -v、! 等词。
        fieldSplit ||= /\$(?![?#])/.test(syntax) ||
          (pattern && !/^[A-Za-z0-9_./]/.test(word) && !intOperand(word));
      }
    }
    word = ''; kind = 'literal'; started = false; syntax = ''; parameterWord = '';
  };
  const endSegment = () => {
    endWord();
    if (redirect) valid = false;
    if (words.length) {
      if (expanded) braceSegments.add(words);
      expansions.set(words, { glob, fieldSplit, unsafeParameter, kinds });
      segments.push(words);
    }
    words = []; kinds = []; expanded = false; glob = false; fieldSplit = false; unsafeParameter = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else { word += ch; parameterWord += ch === '$' ? 'X' : ch; }
      continue;
    }
    if (ch === '`') return null;
    const expansion = ch === '$' ? skipLineContinuations(command, i + 1) : -1;
    if (command[expansion] === '[') return null;
    if (command[expansion] === '(') {
      // $((...)) 是算术：会把变量值当表达式递归求值，值里的 a[$(...)] 就能执行命令
      const start = expansion + 1;
      if (command[skipLineContinuations(command, start)] === '(') return null;
      const end = closingParen(command, start);
      if (end < 0 || !inner(command.slice(start, end))) return null;
      // 保留 $，让后面的检查（sed 脚本、pwsh 路径）看得出这里展开过
      word += '$X';
      parameterWord += '$X';
      if (kind === 'literal') kind = 'word';
      if (!quote) syntax += '$';
      started = true;
      i = end;
      continue;
    }
    if (quote === '"') {
      if (ch === '$' && /^\$(?:@|\{(?:@|[A-Za-z_][A-Za-z0-9_]*\[@\]))/.test(command.slice(i))) fieldSplit = true;
      if (ch === '"') quote = null;
      // 和 bash 一样，双引号里的 \ 只转义 $ ` " \ 和换行，Windows 路径 "C:\x" 保持原样
      else if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') { word += next; parameterWord += next === '$' ? 'X' : next; }
        i++;
      } else { word += ch; parameterWord += ch; }
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (kind === 'literal') kind = 'word';
      quote = ch; started = true; continue;
    }
    if (ch === '\\') {
      if (next !== undefined && next !== '\n') {
        if (kind === 'literal') kind = 'word';
        word += next; parameterWord += next === '$' ? 'X' : next; started = true;
      }
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '(' && !redirect) {
      const leader = (w, j) => kinds[j] === 'literal' && LEAD_KEYWORDS.has(w);
      if (!started && words.every(leader)) {
        if (command[skipLineContinuations(command, i + 1)] === '(') return null;
        word = ch; started = true; endWord(); continue;
      }
      // A command name followed by () can define a function rather than call it.
      if ((started ? word : words.at(-1)) && (started ? words : words.slice(0, -1)).every(leader) &&
          /^(?:[ \t\n]|\\\n)*\)/.test(command.slice(i + 1))) return null;
    }
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      if (!redirect && kind === 'literal' && /^\d+$/.test(word)) {
        word = ''; started = false; syntax = ''; parameterWord = '';
      } else endWord();
      if (redirect) return null;
      let j = ch === '&' ? i + 2 : i + 1;
      const target = command[skipLineContinuations(command, j)];
      if (ch === '<' && (target === '<' || target === '(')) return null;
      if (ch === '>' && target === '(') return null;
      if (ch === '>' && command[j] === '>') j++;
      if (ch === '>' && command[j] === '&') {
        // 数字只是前缀时，Bash 可能把整个词当成写入目标。
        const fd = /^\d+(?=[ \t\n;&|<>()]|$)/.exec(command.slice(j + 1));
        if (!fd) return null;
        i = j + fd[0].length;
        continue;
      }
      // 重定向目标也走正常分词和命令替换检查，不作为命令参数保留。
      redirect = ch;
      i = j - 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      endSegment();
      if ((ch === '|' || ch === '&') && next === ch) i++;
      continue;
    }
    if (ch === '=' && kind === 'literal' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) kind = 'assignment';
    word += ch;
    parameterWord += ch;
    syntax += ch;
    started = true;
  }
  if (quote) return null;
  endSegment();
  return valid && !redirect ? segments : null;
}

function gitAllowed(args) {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-P' || args[i] === '-C') i += args[i] === '-C' ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  // --no-index 接受外部程序开关的缩写；--text 本身是合法的文本比较选项。
  if (rest.some((a) => /^--(output|ext(?:-|$)|textc)/.test(a.split('=')[0]))) return false;
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

// 只剥语法位置的未引用关键字；timeout 后是程序 argv，不能再按 Shell 语法处理。
function core(words, kinds) {
  let start = 0;
  let end = words.length;
  while (start < end && kinds[start] === 'literal' && LEAD_KEYWORDS.has(words[start])) start++;
  while (start < end && kinds[end - 1] === 'literal' && CLOSE_KEYWORDS.has(words[end - 1]) &&
      (end - start === 1 || words[end - 1] === ')')) end--;
  let wrapped = false;
  while (words[start] === 'timeout') {
    let i = start + 1;
    while (i < end && words[i].startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(words[i]) ? 2 : 1;
    if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i] ?? '') || end <= i + 1) break;
    start = i + 1;
    wrapped = true;
  }
  return { words: words.slice(start, end), kind: wrapped ? 'command' : kinds[start] };
}

// bash 的算术求值会递归展开其中的变量和 $(...)，从而执行文件/变量值里夹带的命令。算术出现在：
//   $((...))、$[...]、((...))  —— splitCommand/READERS 已拦；
//   [ ] / [[ ]] / test 的 -eq 等比较符两侧（intOperand）；
//   ${name[下标]}、${var:偏移[:长度]}、间接引用 ${!name}（braceBodySafe）。
const ARITH_OP = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
// 算术操作数只放行字面整数，以及恒为整数、无法夹带 $( 的 $? / $#；变量、命令替换结果、read 进来的值一律不放行
const intOperand = (a) => /^-?\d+$/.test(a) || a === '$?' || a === '$#';
// -v/-R 和 read 的目标必须是字面变量名；数组下标会算术求值，只允许整数及 @ / *。
// 单引号挡不住：bash 在求值时才解析下标里的 $(...)，所以这里按词形判断
const safeSub = (a) => /^[A-Za-z_][A-Za-z0-9_]*(?:\[(?:@|\*|-?\d+)\])?$/.test(a);
const TEST_UNARY = new Set('-a -b -c -d -e -f -g -G -h -k -L -n -N -O -p -r -R -s -S -t -u -v -w -x -z'.split(' '));
const TEST_BINARY = new Set(['=', '==', '!=', '<', '>', '-ef', '-nt', '-ot', ...ARITH_OP]);

// test/[ 在运行时识别操作符；只接受静态谓词，不能让展开的 -v/-eq 改变操作数用途。
function testAllowed(args) {
  let i = 0;
  const predicate = () => {
    while (args[i] === '!') i++;
    const [a, op, b] = args.slice(i, i + 3);
    if (a === undefined) return false;
    if (TEST_BINARY.has(op)) {
      i += 3;
      return b !== undefined && (!ARITH_OP.has(op) || (intOperand(a) && intOperand(b)));
    }
    if (TEST_UNARY.has(a)) {
      i += 2;
      return op !== undefined && (!['-v', '-R'].includes(a) || safeSub(op));
    }
    i++;
    return true;
  };
  if (!args.length) return true;
  if (!predicate()) return false;
  while (i < args.length) {
    if (!['-a', '-o'].includes(args[i++]) || !predicate()) return false;
  }
  return i === args.length;
}

function readAllowed(args) {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '--') { i++; break; }
    const option = /^-[ersE]*(?:([adinNptu])(.*))?$/.exec(args[i]);
    if (!option) return false;
    if (option[1]) {
      const value = option[2] || args[++i];
      if (value === undefined || (option[1] === 'a' && !safeSub(value))) return false;
    }
  }
  return args.slice(i).every(safeSub);
}

// 单个 ${...} 体是否不触发算术求值。放行普通 ${name}、默认值 :-/:=/:?/:+、长度 ${#..}、删减 %/#、
// 替换 /、大小写 ^/,，以及字面整数下标和 @ / * 整组；数组下标非整数、子串偏移/长度非整数、${!..} 一律拒绝。
function braceBodySafe(body) {
  if (body[0] === '!') return false;
  let s = body[0] === '#' ? body.slice(1) : body;
  const name = /^([A-Za-z_][A-Za-z0-9_]*|[-@*#?$!0-9]+)/.exec(s);
  if (!name) return true;
  s = s.slice(name[0].length);
  if (s[0] === '[') {
    const close = s.indexOf(']');
    const idx = close < 0 ? null : s.slice(1, close);
    if (idx === null || !(idx === '@' || idx === '*' || /^-?\d+$/.test(idx))) return false;
    s = s.slice(close + 1);
  }
  // ${var@P} 等变换运算符：@P 会对变量值做提示符展开并执行其中的 $(...)，其余 @ 运算也一律 err-closed（${@}/${arr[@]} 的 @ 已在上面消化掉）
  if (s[0] === '@') return false;
  // : 后面紧跟 - = ? + 是默认值运算（不做算术）；否则是子串偏移[:长度]，每段必须是字面整数
  if (s[0] === ':' && !['-', '=', '?', '+'].includes(s[1])) {
    return s.slice(1).split(':').every((p) => /^\s*[+-]?\d+\s*$/.test(p));
  }
  return true;
}

// 词里每个 ${...}（含嵌套、未闭合保守拒绝）都安全。$(...) 已被 splitCommand 收敛成 $X，所以这里的 $ 只会是变量
function braceExpansionsSafe(word) {
  for (let i = word.indexOf('${', 0); i >= 0; i = word.indexOf('${', i + 2)) {
    let depth = 0;
    let end = -1;
    for (let j = i + 1; j < word.length; j++) {
      if (word[j] === '{') depth++;
      else if (word[j] === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0 || !braceBodySafe(word.slice(i + 2, end))) return false;
  }
  return true;
}

function segmentAllowed(raw, extra, braceExpansion = false, expansion = {}) {
  const { words, kind } = core(raw, expansion.kinds);
  if (extra.some((rx) => rx.test(raw.join(' ')) || rx.test(words.join(' ')))) return true;
  if (!words.length) return true;
  // 只检查实际展开；单引号和转义保护的字面文本不参与。
  if (expansion.unsafeParameter) return false;
  // 循环列表里的词会代入后面的命令，不能借它塞进参数（for f in -delete; do find . $f）
  if (words[0] === 'for') return kind === 'literal' && (words.length <= 2 || words[2] === 'in') &&
    words.slice(3).every((w) => !w.startsWith('-'));
  // 单独的变量赋值（D=/mnt/...）无害；带命令的前缀赋值（X=1 cmd）不放行。
  // 值不能以 - 开头或含空白，免得展开后变成参数（X=-delete; find . $X）；
  // 也不能含字面的 $(，否则 [[ X -eq 0 ]] 之类的算术求值会执行它
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    return kind === 'assignment' && words.length === 1 &&
      /^[A-Za-z_][A-Za-z0-9_]*=(?!-)\S*$/.test(words[0]) && !words[0].includes('$(');
  }
  if (PWSH.test(words[0])) return pwshTestAllowed(words.slice(1));
  const [cmd, ...args] = words;
  // 展开后的词可能变成被过滤的开关，不能把它当成普通文件参数。
  if (/^(git|iconv|find|rg|sort|uniq|tree|file|date|npm|pnpm|yarn|node|go|cargo|make)$/.test(cmd) &&
      (braceExpansion || args.some((a) => a.includes('$')) || (expansion.glob && expansion.fieldSplit))) return false;
  switch (cmd) {
    // 只放行直接、无参数的内建控制；timeout 后的同名外部程序仍拒绝。
    case ':': case 'continue': return kind === 'literal' && args.length === 0;
    case 'command': return kind === 'literal' && args[0] === '-v' && args.length > 1 &&
      args.slice(1).every((a) => /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(a));
    case 'git': return gitAllowed(args);
    case 'gzip': return ['-t', '--test'].includes(args[0]);
    // GNU tar can inherit execution options from TAR_OPTIONS; only list with it removed.
    case 'env': return kind === 'literal' && args.length === 5 && args[0] === '-u' &&
      args[1] === 'TAR_OPTIONS' && args[2] === 'tar' && args[3] === '-tzvf' &&
      !braceExpansion && !expansion.glob && /^(?!-)[^:$~]+$/.test(args[4]);
    case 'bash': case 'sh': return args[0] === '-n' && args.length > 1 && !braceExpansion && !expansion.glob &&
      args.slice(1).every((a) => !/^[+-]/.test(a) && !a.includes('$'));
    case 'iconv': return !args.some((a) => /^-[cs]*o/.test(a) ||
      (a.startsWith('--') && a !== '--' && '--output'.startsWith(a.split('=')[0])));
    case 'file': {
      for (let i = 0; i < args.length && args[i] !== '--'; i++) {
        const a = args[i];
        if (/^-[^-efFmP]*C/.test(a) || (a.startsWith('--') && '--compile'.startsWith(a.split('=')[0]))) return false;
        if (/^-[^-efFmP]*[efFmP]$/.test(a) || (a.startsWith('--') && !a.includes('=') &&
            ['--exclude', '--exclude-quiet', '--files-from', '--separator', '--magic-file', '--parameter'].some((flag) => flag.startsWith(a)))) i++;
      }
      return true;
    }
    case 'date': {
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--') return args.slice(i + 1).every((v) => v.startsWith('+'));
        if (/^-[uR]*s/.test(a) || (a.startsWith('--') && '--set'.startsWith(a.split('=')[0]))) return false;
        if (/^-[uR]*[dfr]$/.test(a) || (a.startsWith('--') && !a.includes('=') &&
            ['--date', '--file', '--reference', '--rfc-3339'].some((flag) => flag.startsWith(a)))) i++;
        else if (!a.startsWith('-') && !a.startsWith('+')) return false;
      }
      return true;
    }
    case 'find': return !args.some((a) => FIND_ACTIONS.has(a));
    case 'rg': return !args.some((a) => a.startsWith('--pre'));
    case 'sort': return !args.some((a) => /^-[^-]*o/.test(a) || (a.startsWith('--') && a !== '--' &&
      ['--output', '--compress-program', '--random-source'].some((flag) => flag.startsWith(a.split('=')[0]))));
    case 'uniq': {
      const end = args.indexOf('--');
      const files = args.filter((a, i) => a === '-' || !a.startsWith('-') || (end >= 0 && i > end));
      return !expansion.glob && (files.length <= 1 || (files.length === 2 && files[1] === '-'));
    }
    // printf -v 能给任意变量赋任意值
    case 'printf': return !args[0]?.startsWith('-v') && !args[0]?.includes('$');
    case 'tree': return !args.some((a) => /^-[^-]*o/.test(a));
    // 后面再出现开关（-i、--in-place、-e、-f）就可能写文件或执行命令；
    // 文件参数里的 $ 和 { 也不放行：$(printf -- -i)、{-i,f} 展开后同样变成开关
    case 'sed': return args[0] === '-n' && args.length >= 2 && SED_PRINT.test(args[1]) && args.slice(2).every((a) => !/^-|[{$]/.test(a));
    case 'python': case 'python3': return args[0] === '-m' && ['pytest', 'unittest'].includes(args[1]);
    case 'npm': case 'pnpm': case 'yarn': return args[0] === 'test' || (args[0] === 'run' && /^test/.test(args[1] ?? ''));
    case 'node': return args[0] === '--test' || args[0] === '--check';
    case 'go': return ['test', 'vet'].includes(args[0]) && !args.some((a) => /^--?(exec|toolexec|vettool)(=|$)/.test(a));
    case 'cargo': case 'make': return ['test', 'check'].includes(args[0]);
    // 算术比较（-eq 等）两侧必须是字面整数：否则操作数的运行时值（文件内容、变量、命令输出）会被当算术表达式求值并执行其中的 $(...)。
    // 只有 -v / -R 的操作数会对 name[下标] 做算术求值；=~、== 的模式和文件测试里的 name[..] 不求值，照常放行（真有 $(...) 由 splitCommand 拦）
    case 'test': case '[':
      return !braceExpansion && !expansion.fieldSplit &&
        (cmd !== '[' || args.at(-1) === ']') && testAllowed(cmd === '[' ? args.slice(0, -1) : args);
    case '[[':
      return kind === 'literal' && args.every((a, i) => ((args[i - 1] !== '-v' && args[i - 1] !== '-R') || safeSub(a)) &&
        (!ARITH_OP.has(a) || (intOperand(args[i - 1] ?? '') && intOperand(args[i + 1] ?? ''))));
    // read 把输入赋给 name[下标] 目标时会算术求值下标（单引号也挡不住），和 -v 同类
    case 'read': return readAllowed(args);
    default: return READERS.has(cmd);
  }
}

export function readOnlyCommand(command, extra = []) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const braceSegments = new Set();
  const expansions = new Map();
  const segments = splitCommand(command, (sub) => readOnlyCommand(sub, extra), braceSegments, expansions);
  return segments !== null && segments.length > 0 && segments.every((w) => segmentAllowed(w, extra, braceSegments.has(w), expansions.get(w)));
}

// 拒绝原因：整条命令截断后看不到真正卡住的地方，所以指出不放行的结构或第一段不放行的命令
function refusedPart(command, extra) {
  const braceSegments = new Set();
  const expansions = new Map();
  const segments = typeof command === 'string' ? splitCommand(command, (sub) => readOnlyCommand(sub, extra), braceSegments, expansions) : [];
  if (segments === null) {
    return '含不放行的结构：写到 /dev/null 以外的重定向、反引号、heredoc、$((...)) 算术、$[...] 算术、进程替换、$(...) 里的非只读命令或未闭合引号';
  }
  const bad = segments.find((w) => !segmentAllowed(w, extra, braceSegments.has(w), expansions.get(w)));
  if (!bad) return '命令为空';
  const words = core(bad, expansions.get(bad).kinds).words;
  let hint = '';
  if (words[0] === 'tar' && words[1] === '-tzvf' && words.length === 3) {
    hint = '；列出本地压缩包可用 env -u TAR_OPTIONS tar -tzvf ./archive.tar.gz，换成实际文件路径';
  } else if (['find', 'sed'].includes(words[0]) && words.slice(1).some((a) => a.includes('$'))) {
    hint = '；这类只读核验不接受含 $ 的参数，请直接写出固定路径和查询参数';
  }
  return `不放行的是「${words.join(' ').slice(0, 200)}」${hint}`;
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

function routeConfiguration(cfg) {
  const router = cfg.routerCheckUrl && new URL(cfg.routerCheckUrl);
  if (router && !['http:', 'https:'].includes(router.protocol)) throw new Error('routerCheckUrl 必须是 HTTP(S) URL');
  const route = cfg.codexRoute;
  let routeUrl;
  if (route != null) {
    if (typeof route.provider !== 'string' || !/^[A-Za-z0-9_-]+$/.test(route.provider) || typeof route.baseUrl !== 'string') {
      throw new Error('codexRoute 需要已有自定义 provider 和 baseUrl');
    }
    routeUrl = new URL(route.baseUrl);
    if (!['http:', 'https:'].includes(routeUrl.protocol) || routeUrl.username || routeUrl.password) {
      throw new Error('codexRoute.baseUrl 必须是无凭据的 HTTP(S) URL');
    }
  }
  return { router, route, routeUrl };
}

function loadedGateway(cfg) {
  try {
    const { router, route, routeUrl } = routeConfiguration(cfg);
    return { codexRoute: routeUrl ? { provider: route.provider, origin: routeUrl.origin } : null,
      routerCheck: router ? { transport: 'tcp', origin: router.origin }
        : routeUrl ? { transport: 'http', origin: routeUrl.origin } : null };
  } catch {
    return { routeConfigInvalid: true };
  }
}

// wsl.exe 的参数。配置了的路径用 env 显式传入，不依赖宿主进程继承来的环境
export function runnerArgv(cfg, args) {
  const { router, route, routeUrl } = routeConfiguration(cfg);
  const env = [
    cfg.codexHome && `CODEX_HOME=${cfg.codexHome}`,
    cfg.runnerHome && `CODEX_RUNNER_HOME=${cfg.runnerHome}`,
    router && `CODEX_RUNNER_ROUTER_URL=${router.origin}`,
    routeUrl && `CODEX_RUNNER_ROUTE_PROVIDER=${route.provider}`,
    routeUrl && `CODEX_RUNNER_ROUTE_URL=${routeUrl.href}`,
    cfg.codexBin && `CODEX_RUNNER_CMD=${JSON.stringify([cfg.codexBin])}`,
  ].filter(Boolean);
  return [...(cfg.distro ? ['-d', cfg.distro] : []), '-e', 'env', ...env, cfg.python, cfg.runner, ...args];
}

// 跑一个命令，返回它输出的最后一行 JSON。timeoutMs 到了还没结束（WSL 卡死或起不来）就结束它并按 bridge_error 返回，
// 不等 close：进程树没收干净时 close 可能一直不来
export function runProcess(command, argv, { stdin, signal, timeoutMs, env } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: 'failed', error_kind: 'bridge_error',
    error: `${command} 调用前已被中止`, retryable: true });
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
    const cleanup = () => {
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    let ticks = 0;
    const timer = timeoutMs && setInterval(() => {
      if (++ticks * 1000 < timeoutMs) return;
      cleanup();
      child.kill();
      resolve({ status: 'failed', error_kind: 'bridge_error', retryable: true,
        error: `${command} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已结束它（WSL 可能卡住或正在启动）` });
    }, 1000);
    child.on('error', (error) => {
      cleanup();
      resolve({ status: 'failed', error_kind: 'bridge_error', error: error.message, retryable: true });
    });
    child.on('close', (code) => {
      cleanup();
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

const unknownState = (value) => ['bridge_error', 'unknown_job', 'invalid_record'].includes(value.error_kind) ||
  ['monitor_failed', 'unknown'].includes(value.status);
const cancelUnconfirmed = (value) => unknownState(value) || !['cancelled', 'completed', 'failed'].includes(value.status);

export function createConductor(cfg, run = runRunner) {
  // 每次等待是一个有界的 `status --wait` 进程，到点即退出；仍在执行时 runner 会带回空闲秒数和最近动作
  async function waitJob(jobId, seconds, signal) {
    // 夹在 1 天内：既防超大值让底层 status 等上几十天，也让 timeoutMs 远小于 2^31
    const wait = Math.min(Math.max(0, seconds), 86_400);
    const value = signal?.aborted ? undefined
      : await run(cfg, ['status', jobId, '--wait', String(wait)], { signal, timeoutMs: wait * 1000 + BRIDGE_SLACK_MS });
    if (signal?.aborted) {
      await cancel(jobId, signal);
      signal.throwIfAborted();
    }
    const note = value.status === 'running' ? { note: `等了 ${seconds} 秒仍在执行，任务在后台继续；用 codex_status 接着等。` } : {};
    return { job_id: jobId, ...value, ...note };
  }

  async function start(args, cwd, signal, context) {
    const argv = ['start', '--cwd', cwd];
    const hostAccess = args.host_access ?? (cfg.defaultHostAccess === true);
    const effort = args.effort ?? (args.write === true ? cfg.effort : cfg.readOnlyEffort || cfg.effort);
    if (effort) argv.push('--effort', effort);
    if (cfg.model) argv.push('--model', cfg.model);
    if (cfg.serviceTier) argv.push('--service-tier', cfg.serviceTier);
    // host_access 不管 write 都在沙箱外运行，write=false 的只读只靠提示约束
    if (hostAccess === true) argv.push('--sandbox', 'danger-full-access');
    else if (args.write === true) argv.push('--sandbox', 'workspace-write');
    if (args.resume) argv.push('--resume', args.resume);
    if (args.use_user_config === true) argv.push('--use-user-config');
    if (cfg.reportSchema) argv.push('--schema', cfg.reportSchema);
    for (const s of args.scope ?? []) argv.push('--scope', s);
    for (const root of args.writable_roots ?? []) argv.push('--writable-root', root);
    // runner 在截取前 300 条改动之前就过滤，改动数和超出 scope 的检查才准
    for (const pattern of cfg.ignoreChanges ?? []) argv.push('--ignore', pattern);
    const prompt = composePrompt(args.task, args.acceptance, args.scope, { hostAccess: hostAccess === true, write: args.write === true,
      ignore: cfg.ignoreChanges ?? [] });
    if (context !== undefined) argv.push('--context-json');
    return run(cfg, argv, { stdin: context === undefined ? prompt : JSON.stringify({ prompt, context }), signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function cancel(jobId, signal) {
    const value = await run(cfg, ['cancel', jobId], { timeoutMs: BRIDGE_TIMEOUT_MS });
    if (signal?.aborted && cancelUnconfirmed(value)) {
      throw new Error(`Codex 任务 ${jobId} 的取消未确认：${value.error ?? value.error_kind ?? value.status}。` +
        `任务可能仍在运行，用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${jobId}，不要重派。`);
    }
    return value;
  }

  async function list(filters = {}, signal) {
    const argv = ['list', '--limit', String(filters.limit ?? 20), '--offset', String(filters.offset ?? 0)];
    for (const key of ['cwd', 'owner', 'status']) if (filters[key] !== undefined) argv.push(`--${key}`, filters[key]);
    for (const [key, flag] of [['thread_id', '--thread-id'], ['parent_job', '--parent-job']]) if (filters[key] !== undefined) argv.push(flag, filters[key]);
    if (filters.needs_attention) argv.push('--needs-attention');
    for (const id of filters.job_ids ?? []) argv.push('--job-id', id);
    return run(cfg, argv, { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function output(jobId, { artifact = 'report', offset = 0, limit = 4000 } = {}, signal) {
    return run(cfg, ['output', jobId, '--artifact', artifact, '--offset', String(offset), '--limit', String(limit)],
      { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function review(jobId, review, reviewer, signal) {
    return run(cfg, ['review', jobId, '--reviewer', reviewer],
      { stdin: JSON.stringify(review), signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function summary(filters = {}, signal) {
    const argv = ['summary'];
    for (const key of ['cwd', 'owner']) if (filters[key] !== undefined) argv.push(`--${key}`, filters[key]);
    if (filters.thread_id !== undefined) argv.push('--thread-id', filters.thread_id);
    for (const key of ['limit', 'offset']) if (filters[key] !== undefined) argv.push(`--${key}`, String(filters[key]));
    for (const id of filters.job_ids ?? []) argv.push('--job-id', id);
    return run(cfg, argv, { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  return { start, waitJob, cancel, list, output, review, summary };
}

export function composePrompt(task, acceptance, scope = [], { hostAccess = false, write = false, ignore = [] } = {}) {
  return `${task.trim()}\n\n## 验收标准\n完成后逐条自查，每条都要满足：\n` +
    acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join('\n') +
    '\n\n## 执行约束\n' +
    '- 只做上面任务和验收标准要求的事，不扩大范围，不顺手重构或修改无关文件。\n' +
    '- 任务明确禁止某些访问或状态变更时，运行相关脚本前先只读检查是否触及这些限制；存在冲突或无法确认时，不执行相关步骤并标为 blocked。\n' +
    (scope.length ? `- 只允许改动这些路径：${scope.join('、')}；其他文件一律不要动。\n` : '') +
    (ignore.length ? `- 路径（相对任务目录，用 / 分隔）匹配这些 Python re 正则的文件会被其他进程持续写入：${ignore.join('、')}。` +
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
    'blockers 列出真实阻塞，没有就 []；每项包含唯一 id、kind、message、question、resolution 五个字符串。' +
    'kind 只用 user_input（缺用户信息）、task_conflict（任务冲突需用户取舍）、environment（环境条件未满足）、implementation（实现待修）。' +
    '前两类必须写清 question；其余没有问题时 question 留空，resolution 写已知解除条件，不确定原因时不要猜分类。\n' +
    'JSON 字符串里的 Windows 路径优先写成 D:/docs/log.txt；必须保留反斜杠时按 JSON 转义。返回前确认整个对象可被 JSON 解析。\n' +
    '任务或验收标准里对最终答复版式的要求（如单独的结论行）写进 summary 即算满足，不算偏离，也不要因此标 blocked。\n';
}

const taskScopePath = (cwd, p) => normPath(/^([A-Za-z]:|\/)/.test(p) ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`);

// 不在 scope 内的改动；没给 scope 或 runner 没给出改动清单时返回 undefined
export function outOfScope(value, cwd, scope) {
  if (!scope?.length || !Array.isArray(value.files_changed)) return undefined;
  const roots = scope.map(p => taskScopePath(cwd, p));
  return value.files_changed.map(f => f.path).filter(p => !roots.some(r => under(taskScopePath(cwd, p), r)));
}

function widensOverlappingScope(previousCwd, original, cwd, requested) {
  if (!original?.length) return false;
  if (!requested?.length && normPath(previousCwd) === normPath(cwd)) return true;
  const before = original.map(p => taskScopePath(previousCwd, p));
  const after = requested?.length ? requested.map(p => taskScopePath(cwd, p)) : [normPath(cwd)];
  return after.some(p => before.some(r => under(p, r) || under(r, p))) &&
    after.some(p => !before.some(r => under(p, r)));
}

function hasUserReply(log, job, owner) {
  const user = log.findLastIndex(e => e.type === 'user/message' && e.data?.source?.kind === 'user');
  if (user < 0) return false;
  const replyAt = log[user].at ?? log[user].time;
  const review = job.verification;
  if (review?.blockers?.length && Number.isFinite(review.time) &&
      (!Number.isFinite(replyAt) || replyAt <= review.time * 1000)) return false;
  const label = `Codex ${job.job_id}`;
  const native = log.findLast(e => e.type === 'job/registered' && e.data?.kind === 'codex' && e.data.owner === owner &&
    (e.data.label === label || e.data.label?.startsWith(`${label} · `)));
  const settled = native?.data?.jobId && log.findLastIndex(e => e.type === 'job/settled' && e.data?.jobId === native.data.jobId);
  return Number.isInteger(settled) && settled >= 0 ? user > settled :
    Number.isFinite(replyAt) && Number.isFinite(job.finished_at) && replyAt > job.finished_at * 1000;
}

export function validateRun(args) {
  if (typeof args?.task !== 'string' || args.task.trim().length < 10) throw new Error('codex_run: task 必须写清目标、相关路径和约束（至少 10 个字符）');
  if (!Array.isArray(args.acceptance) || args.acceptance.length === 0 ||
    args.acceptance.some((a) => typeof a !== 'string' || a.trim().length < 4)) {
    throw new Error('codex_run: acceptance 必须是至少 1 条可核验的验收标准（每条至少 4 个字符，条数不限）');
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

// 执行完成不等于独立验收通过；模型自报全 met 仍需规划端核验。
export function reviewState(value) {
  const report = Object.hasOwn(value, 'structured') ? value.structured : value.report;
  const counts = { met: 0, not_met: 0, blocked: 0 };
  const criteria = Array.isArray(report?.criteria) ? report.criteria : [];
  for (const item of criteria) if (Object.hasOwn(counts, item?.status)) counts[item.status]++;
  const valid = validReport(report);
  const unknown = unknownState(value);
  const execution = unknown ? 'unknown' : value.error_kind === 'schema_invalid' ? 'completed' : value.status;
  const pending = execution === 'running';
  const reportStatus = unknown ? 'missing' : pending ? 'pending' : value.error_kind === 'schema_invalid' || value.report_status === 'invalid' ? 'invalid'
    : report === undefined ? 'missing' : valid ? 'valid' : 'invalid';
  const expected = value.acceptance ?? value.context?.acceptance;
  const attention = execution !== 'completed' || reportStatus !== 'valid' || counts.not_met > 0 || counts.blocked > 0 ||
    report?.unresolved?.length > 0 || report?.deviations?.length > 0 || report?.blockers?.length > 0 || value.out_of_scope?.length > 0 ||
    (Array.isArray(expected) && expected.length !== criteria.length);
  return { execution_status: execution, report_status: reportStatus,
    review_status: pending ? 'pending' : attention ? 'needs_attention' : 'needs_verification', criteria_counts: counts };
}

// 将 runner 的规范化路径用于范围检查，并把 structured 汇报改名为 report。
// Codex 没按 JSON 汇报时 runner 记为 schema_invalid 失败，但活已经干完，按完成处理并提示以实际文件为准。
export function withReport(value) {
  const { structured, ...rest } = value;
  if (rest.context?.acceptance) rest.acceptance = rest.context.acceptance;
  const outside = outOfScope(rest, rest.cwd, rest.scope_paths);
  if (outside) rest.out_of_scope = outside;
  Object.assign(rest, reviewState({ ...rest, ...(structured !== undefined ? { structured } : {}) }));
  if (rest.status === 'failed' && rest.error_kind === 'schema_invalid') {
    const { error_kind: _kind, error, retryable: _retryable, ...done } = rest;
    const prefix = 'Final message is not valid JSON: ';
    const detail = typeof error === 'string' && error.startsWith(prefix) ? `\nJSON 解析错误：${error.slice(prefix.length)}` : '';
    const value = { ...done, status: 'completed', report_note: 'Codex 没按 JSON 格式逐条汇报，核验时以 final_message 和实际文件为准。' + detail };
    return { ...value, blocking: blockingState(value) };
  }
  if (structured === undefined) return { ...rest, blocking: blockingState(rest) };
  const lists = ['criteria', 'files_changed', 'deviations', 'unresolved'];
  if (!structured || typeof structured !== 'object' || Array.isArray(structured) ||
      lists.some((key) => structured[key] !== undefined && !Array.isArray(structured[key])) ||
      (structured.criteria ?? []).some((c) => !c || typeof c !== 'object' || Array.isArray(c))) {
    return { ...rest, blocking: blockingState(rest), report_note: 'Codex 汇报字段格式不正确，核验时以 final_message 和实际文件为准。' };
  }
  const normalized = { ...rest, report: structured };
  return { ...normalized, blocking: blockingState(normalized) };
}

// 汇报条数和验收标准一致、编号也对得上时，逐条汇报显示验收标准原文（Codex 几乎总会改写条目），下一步不再重复列出。
// 编号认 1. / 1) / 1、 / 1: / 第1条，NFKC 先把全角数字和标点换成半角
function sameCriteria(report, acceptance) {
  const criteria = report?.criteria;
  return Array.isArray(criteria) && criteria.length > 0 && acceptance?.length === criteria.length && criteria.every((c, i) => {
    if (typeof c?.criterion !== 'string') return false;
    const n = /^\s*(?:第\s*)?\(?(\d+)\s*(?:条|[.):、])/.exec(String(c.criterion ?? '').normalize('NFKC'))?.[1];
    return n === undefined || Number(n) === i + 1;
  });
}

const RECORD_REVIEW = '核验后用 codex_review 按原验收标准逐条记录证据：全部通过用 verified，有明确差距用 needs_changes，逐条通过且用户明确接受已列出的偏差时用 accepted_deviations。';

// resumed：这次是否带了 resume；codex_status 不知道时传 undefined，按 runner 有没有给 thread_id 判断
// readOnly：这次是不是只读任务；host_access=true、write=false 的任务沙箱是 danger-full-access，只能由调用方告知
export function nextStep(value, acceptance, resumed, { readOnly = value.context?.write === false || value.sandbox === 'read-only' } = {}) {
  acceptance ??= value.acceptance ?? value.context?.acceptance;
  if (!value.job_id && unknownState(value)) {
    return '这次未取得任务编号，无法确认 Codex 是否已经启动。先用 codex_jobs 按相同任务目录和原任务核对近期记录，找回 job_id 后再查状态，不要直接重派。';
  }
  if (value.job_id && unknownState(value)) {
    return `当前未取得可信状态或报告，Codex 任务 ${value.job_id} 可能仍在运行。` +
      `用 codex_jobs 核对正确 job_id；先用 codex_status 查询，不要直接重派。`;
  }
  if (value.status === 'running') {
    if (value.phase === 'lock_wait') return `任务 ${value.job_id} 正在等待同目录写锁，尚未启动 Codex。用 codex_status 等待这个 job_id，不要重复派活；需要退出队列时用 codex_cancel，只取消本任务。`;
    if (value.phase === 'codex_reconnecting') return `任务 ${value.job_id} 正在重连模型服务。用 codex_status 查询原任务，不要重复派活。`;
    return `任务 ${value.job_id} 仍在执行，用 codex_status 等结果，不要自己动手补做。`;
  }
  // 取消会保留恢复信息，但不会重建中断前的改动清单。
  if (value.status === 'cancelled') {
    if (value.phase === 'lock_wait') return '已取消排队，尚未启动 Codex；没有取消持锁任务。不要自行恢复或重派。';
    return 'Codex 任务已取消（用户停止、会话归档或调用中止）：不要自行续跑或重派，先问用户。' +
      '如果这是可写任务，取消前可能已改了部分文件且没有改动清单，核验前先用 git status 或对比文件确认现状。';
  }
  const blocking = blockingState(value);
  const report = value.report ?? {};
  const original = sameCriteria(report, acceptance);
  const list = !original && Array.isArray(acceptance) ? acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n') : '';
  if (value.status === 'completed' || blocking.blockers.length || ['verified', 'accepted_deviations', 'needs_changes', 'invalid'].includes(value.verification_status)) {
    if (blocking.next_action === 'done') return `独立核验已记录（${value.verification_status}）。本轮已关闭；完整依据可用 codex_output artifact=review 重读。`;
    if (blocking.next_action === 'ask_user') {
      const environment = blocking.blockers.some((b) => b.kind === 'environment');
      const guidance = environment
        ? '先向用户提出以下具体问题，同时核实报告里的环境解除条件。取得回答且条件已满足后，用 codex_continue 同时提交 answers 和 resolution，resolution 写明条件已满足的具体证据。条件未齐备时先不要续接；不要重复派活或替用户决定：\n'
        : '先向用户提出以下具体问题，取得回答后用 codex_continue 提交 answers；不要重复派活或替用户决定：\n';
      return guidance + blocking.questions.map((q) => `${q.id}: ${q.question}`).join('\n');
    }
    if (blocking.next_action === 'wait_condition') return '当前受环境条件阻塞。先说明 blockers 中的解除条件；条件改变并取得证据后，用 codex_continue 的 resolution 说明事实再续跑，不要原样重试。';
    if (blocking.next_action === 'inspect_report') return '报告或任务状态仍需核对。先读完整报告和实际状态，按原验收标准逐条核对。对照原任务范围区分真实缺口与已说明的验证边界；边界说明本身不自动增加补做要求。确有遗留问题时，再查清需要用户回答、环境变化还是实现修正；不能把未知原因当实现问题重复派活。\n' +
      RECORD_REVIEW +
      (value.out_of_scope?.length ? `\n范围外改动待核实：${value.out_of_scope.join('、')}。快照也可能包含其他进程写的文件，先核实归属，不能仅凭快照认定 Codex 越界。` : '') +
      (list ? `\n原验收标准：\n${list}` : '');
    if (blocking.next_action === 'resume_fix') return '已有明确实现差距。用 codex_continue 续接原任务，它会保留原目录、验收、write、scope 和主机权限；不得借修正扩大授权。';
  }
  // 只读任务用 --ephemeral 运行；只有它续跑的写任务线程还能续。
  const resumable = value.sandbox !== 'read-only' || (resumed ?? Boolean(value.thread_id));
  if (value.status !== 'completed') {
    if (!value.retryable) return '这次失败不可重试：把 error 原样告诉用户，不要改为自己动手。';
    if (value.error_kind === 'reconnect_timeout' || value.error_kind === 'router_down') {
      const attempts = value.attempts ?? value.attempt;
      const cause = value.error_kind === 'reconnect_timeout' ? 'Codex 重连超时' : 'Codex 本地路由不可达';
      return `${cause}${attempts ? `（已尝试 ${attempts} 次）` : ''}。先确认 Codex 到模型服务的连接恢复，恢复前不要重派。` +
        `连接恢复后，用 codex_run 沿用原任务和授权${resumable && value.thread_id ? '，把原 thread_id 填入 resume 续跑。' : '再派。'}`;
    }
    if (value.error_kind === 'worker_died' && !readOnly) {
      return '执行进程已中断，退出前可能已改了部分文件且没有改动清单。先用 codex_output（artifact=context）取回原任务和验收标准，再用 git status 或对比文件核对已有产物。' +
        '产物齐全就报告核验结果；只有确认有缺项才按原授权补做。' +
        (resumable && value.thread_id ? '用 codex_run 的 resume 带上原 thread_id，只补缺项。' : '没有可续接线程时另派，只补缺项。');
    }
    return resumable ? '这次失败可重试：稍后用同样的参数再派一次（有 thread_id 时带 resume）。'
      : '这次失败可重试：稍后用同样的参数再派一次，不要带 resume（只读任务不留会话，不能续跑）。';
  }
  const alerts = [
    report.deviations?.length ? `Codex 自报偏离计划：${report.deviations.join('；')}` : '',
    value.out_of_scope?.length ? `改动超出 scope：${value.out_of_scope.join('、')}。这份清单来自目录快照，可能含同时段其他进程写的文件（如定期日志）；` +
      '不在 Codex 自报 files_changed 里、明显来自其他进程的，只需一句说明，不算 Codex 越界，也不用请用户决定；其余的先核实是否应保留；' +
      '总是由其他进程写的文件，可以请用户写进插件配置 ignoreChanges，以后不再列出' : '',
  ].filter(Boolean);
  const where = original ? '上面逐条汇报里的验收标准' : list ? '下面的验收标准' : '验收标准';
  return (alerts.length ? `${alerts.join('\n')}\n偏离或冲突需要用户取舍的，先向用户说明，不要替用户选。\n` : '') +
    `Codex 的答复不是完成证据。用只读检查逐条核验${where}，给出每条的证据；` +
    RECORD_REVIEW +
    `有差距时先记录 needs_changes，再用 codex_continue 在原权限内修正。${list ? `\n${list}` : ''}`;
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
    typeof value.duration_s === 'number' && `${Math.round(value.duration_s)} s`,
    ['verified', 'accepted_deviations'].includes(value.verification_status) && `已核验 ${value.verification_status}`,
    done && !['verified', 'accepted_deviations'].includes(value.verification_status) && value.review_status === 'needs_attention' && '待关注',
    done && !['verified', 'accepted_deviations'].includes(value.verification_status) && value.review_status === 'needs_verification' && '待核验',
    done && value.verification_status === 'needs_changes' && '核验待修',
    done && value.report_status === 'invalid' && '报告异常'].filter(Boolean).join(' · ');
}

// 已完成的结果只留核验用得上的：任务目录和一行改动清单；失败、取消、仍在执行的保留全部字段，便于排查。
// 用量、日志目录等完整字段在 runner 的 result.json（runnerHome/jobs/<job_id>/）里
function details(rest) {
  if (rest.status !== 'completed') {
    const value = { ...rest };
    if (value.context) value.context = { owner: value.context.owner, write: value.context.write, task: taskLine(value.context, 120) };
    return [JSON.stringify(value, null, 2)];
  }
  // runner 最多列 300 条，总数照实给
  const shown = rest.files_changed?.length;
  const total = rest.files_changed_total ?? shown;
  const files = Array.isArray(rest.files_changed) && `改动文件（${rest.files_changed_source ?? '来源未知'}，共 ${total} 个` +
    `${total > shown ? `，只列出前 ${shown} 个，超出 scope 的检查也只看这些，其余的到任务目录里核对` : ''}）：` +
    (rest.files_changed.map((f) => `${f.path}(${f.change})`).join('、') || '无');
  return [rest.cwd && `任务目录：${rest.cwd}`, files,
    rest.execution_status && `执行：${rest.execution_status}；报告：${rest.report_status}；执行端自报检查：${rest.review_status}`,
    rest.verification_status && `独立核验：${rest.verification_status}${rest.verification?.reviewer ? `；核验人：${rest.verification.reviewer}` : ''}`,
    rest.verification_error && `核验记录异常：${rest.verification_error}`,
    rest.verification?.notes && `核验说明：${rest.verification.notes}`,
    ...(rest.verification?.criteria ?? []).map((c) => `核验第 ${c.index} 条 ${c.status}：${c.evidence}`),
    rest.usage && `用量（${rest.usage_scope ?? '统计范围未知'}，不是费用）：${JSON.stringify(rest.usage)}`,
    ...(rest.ignore_warnings ?? []),
    rest.report_note].filter(Boolean);
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
    '--- Codex 逐条汇报（保留原记录）---', `概述：${report.summary ?? ''}`,
    ...(report.criteria ?? []).map((c, i) => `${MARK[c.status] ?? '?'} ${i + 1}. ${original ? acceptance[i] : c.criterion} —— ${clip(c.evidence)}`),
    `自报改动：${report.files_changed?.join('、') || '无'}`,
    `偏离计划：${report.deviations?.join('；') || '无'}`,
    `未解决：${report.unresolved?.join('；') || '无'}`,
  ] : [];
  const extra = details(rest);
  const blockers = value?.blocking ?? blockingState(value);
  return [{ type: 'text', text: [
    `${summaryLine(value ?? {})}${rest.job_id ? `  job_id: ${rest.job_id}` : ''}${rest.thread_id ? `  thread_id: ${rest.thread_id}` : ''}`,
    ...(report ? reportLines
      : answer ? [`--- Codex 最终答复${rest.truncated ? `（超过 8000 字已截断，全文见 ${full}）` : ''} ---`, answer] : []),
    ...(extra.length ? ['--- 详细字段 ---', ...extra] : []),
    ...(blockers.blockers.length ? ['--- 阻塞与待回答问题 ---', ...blockers.blockers.map((b) =>
      `${b.id} [${b.kind}] ${b.message}${b.question ? `\n需要回答：${b.question}` : ''}${b.resolution ? `\n解除条件/已有信息：${b.resolution}` : ''}`)] : []),
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
const DATA_OUTPUT = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

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
  // allowCommands 用 JavaScript 正则；ignoreChanges 交给 runner 按 Python re 验证和应用。
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
    ignoreChanges: Array.isArray(config.ignoreChanges) ? config.ignoreChanges.map(String) : [],
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
  let dispatching = 0;
  let dispatchGeneration = 0;

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
  // 这个 runner 任务仍在进行的 DSH 后台任务。按 DSH 任务表查而不记在插件内存里：
  // 插件热重载后旧的后台任务和它的等待循环仍在，内存记录却清空了，会重复登记、重复送回结果
  // 省略 jobId 时查询当前 agent 的任一 Codex 任务。
  function liveBackground(jobId, exec, includeSettled = false) {
    const owner = exec?.agent?.id;
    const jobs = owner === undefined ? undefined : ctx.get?.('jobs');
    // 标签是「Codex <job_id>」或后面再跟「 · 任务摘要」
    const base = `Codex ${jobId}`;
    const job = jobs?.list(owner).find((j) => j.owner === owner && j.kind === 'codex' &&
      (!jobId || j.label === base || j.label?.startsWith(`${base} · `)) &&
      (includeSettled || j.status === 'running' || j.status === 'stopping'));
    return job && { jobs, id: job.id, owner };
  }

  function outputEntry(jobId, logDir) {
    const dir = (logDir || (cfg.runnerHome && `${cfg.runnerHome}/jobs/${jobId}`)).replace(/\/$/, '');
    const paths = dir ? `完整报告：${dir}/last_message.txt\n完整结果：${dir}/result.json\n`
      : '完整路径尚未确认；可用 codex_output 的 result 查看 runner 返回的 log_dir。\n';
    return `\n--- 完整结果入口 ---\nrunner job_id: ${jobId}\n${paths}` +
      `可重复分页读取：codex_output ${JSON.stringify({ job_id: jobId, artifact: 'report', offset: 0, limit: 8000 })}\n` +
      '原始结果或原任务背景可将 artifact 改为 result 或 context；继续读取时使用返回的 next_offset。';
  }

  // log 通道只供原生面板观察，job_output 过滤它，模型只收到一次最终 result。
  async function watch(jobId, handle, finish, state) {
    const publish = (value) => {
      const warning = value.status === 'monitor_failed' && state.cancelNotice ? `\n${state.cancelNotice}` : '';
      const text = render(value)[0].text + warning + outputEntry(jobId, state.logDir);
      handle.append(`${text}\n`, { channel: 'log' });
      const lookup = value.status === 'monitor_failed'
        ? `codex_status ${JSON.stringify({ job_id: jobId })}`
        : `codex_output ${JSON.stringify({ job_id: jobId, artifact: value.report_status === 'valid' ? 'report' : 'result' })}`;
      return { status: JOB_STATUS[value.status] ?? 'failed', detail: `${summaryLine(value)} · ${lookup}`, result: text };
    };
    try {
      let bridgeErrors = 0;
      for (;;) {
        const value = withReport(await conductor.waitJob(jobId, BG_WAIT));
        if (value.log_dir) state.logDir = value.log_dir;
        if (unknownState(value) && value.error_kind !== 'bridge_error') {
          throw new Error([value.error_kind ?? value.status, value.error].filter(Boolean).join(': '));
        }
        if (value.status === 'running') {
          bridgeErrors = 0;
          const phase = { lock_wait: '排队等待目录写锁', router_check: '检查路由', codex_running: 'Codex 执行中', codex_reconnecting: 'Codex 正在重连模型服务', retry_wait: '等待重试', finalizing: '整理最终结果' }[value.phase] ?? value.phase;
          const stage = [phase, value.attempt > 0 && `第 ${value.attempt} 轮`,
            value.last_error_kind && `上次错误 ${value.last_error_kind}`,
            value.retry_at != null && `约 ${Math.max(0, Math.ceil(value.retry_at - Date.now() / 1000))} 秒后重试`]
            .filter(Boolean).join(' · ') || 'Codex 执行中';
          state.progress = value.phase === 'codex_reconnecting' ? stage
            : `${stage}，距上次活动 ${value.seconds_since_last_event ?? '?'} 秒：${value.last_activity ?? '启动中'}`;
          handle.updateProgress([state.cancelNotice, state.progress].filter(Boolean).join('\n'));
          const stageKey = JSON.stringify([value.phase, value.attempt, value.last_error_kind, value.retry_at]);
          if (stageKey !== state.lastStage) {
            handle.append(`${stage}\n`, { channel: 'log' });
            state.lastStage = stageKey;
          }
          continue;
        }
        // status 是只读的：一次 wsl.exe 出错（含电脑睡眠唤醒、发行版重启瞬间）不代表任务结束，连续多次才放弃
        if (value.error_kind === 'bridge_error') {
          if (++bridgeErrors < 3) continue;
          throw new Error(value.error);
        }
        return publish(finish(value));
      }
    } catch (error) {
      const lost = withReport({ job_id: jobId, status: 'monitor_failed', error: String(error?.message ?? error) });
      lost.next = nextStep(lost);
      return publish(lost);
    } finally {
      state.settled = true;
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
      const state = {};
      const id = jobs.start({
        owner, kind: 'codex', label, outputLimitBytes: 65536,
        run: (handle) => {
          const cancelNotice = (reason) => {
            if (state.settled) return;
            state.cancelNotice = `取消未确认 · runner job_id: ${jobId}：${reason}；` +
              `任务可能仍在运行，用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${jobId}，` +
              `或 codex_cancel 再取消 ${jobId}，不要重派。`;
            handle.updateProgress([state.cancelNotice, state.progress].filter(Boolean).join('\n'));
            handle.append(`${state.cancelNotice}\n`, { channel: 'log' });
          };
          return {
            done: watch(jobId, handle, finish, state),
            cancel: () => {
              cancelNotice('正在请求 runner 取消');
              return conductor.cancel(jobId).then((value) => {
                if (cancelUnconfirmed(value)) {
                  cancelNotice([value.error_kind ?? value.status, value.error].filter(Boolean).join(': '));
                }
              }).catch((error) => cancelNotice(String(error?.message ?? error)));
            },
          };
        },
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
          const settled = await bg.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner).catch(() => undefined);
          const ended = settled?.status === 'killed' || settled?.status === 'completed';
          throw new Error(`Codex 任务 ${jobId} 的等待已被中止；` + (ended ? '任务已结束。'
            : `取消未确认，任务可能仍在运行，用 codex_status 查询 ${jobId}，不要重派。`));
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
  const finishStatus = (value) => ({ ...value, next: nextStep(value) });

  function notifyOnDone(value, exec, finish) {
    if (value.status !== 'running' || !value.job_id) return value;
    const id = background(value.job_id, exec, finish)?.id;
    if (id === undefined) return value;
    return { ...value, background_job_id: id,
      note: `已登记为后台任务 ${id}：Codex 结束后 DSH 会发一条任务通知（只有一行摘要），届时用 job_output 读取 ${id} 的完整结果（含逐条汇报和下一步）；` +
        `超长结果用 codex_output 按 runner job_id=${value.job_id} 可重复分页读取，在此之前不必轮询。`,
      next: '等 DSH 的任务通知，再用 job_output 读取完整结果；需要全文时用 codex_output 分页。' +
        '在此之前不要自己动手补做，也不要重复派同一个任务。' };
  }

  async function dispatch(args, exec, continuation, originalTask = args.task) {
    validateRun(args);
    if ((args.host_access ?? cfg.defaultHostAccess) === true && cfg.allowHostAccess !== true) {
      throw new Error('codex_run: 插件配置没有开启 allowHostAccess，不能传 host_access=true；Codex 只能在沙箱里运行，启动不了 Windows 程序');
    }
    const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces);
    if (!cwd) throw new Error('codex_run: 当前会话没有工作区，请传 cwd');
    const finish = (result) => {
      const outside = result.scope_paths ? result.out_of_scope : outOfScope(result, cwd, args.scope);
      const value = { ...result, acceptance: args.acceptance, ...(outside ? { out_of_scope: outside } : {}) };
      Object.assign(value, reviewState(value));
      value.blocking = blockingState(value);
      const reminder = value.status === 'completed' && plannerPrompt(plannerFile)
        ? '\n规划下一次派活前，再对照系统提示词里的「派活给 Codex 前的规划要求」。' : '';
      return { ...value, next: nextStep(value, args.acceptance, Boolean(args.resume),
        { readOnly: args.write !== true }) + reminder };
    };
    // 取得 job_id 后才响应中止，避免留下已启动却无人管理的 Codex。
    exec?.signal?.throwIfAborted();
    let started;
    dispatching++;
    dispatchGeneration++;
    try {
      const owner = exec?.agent?.id;
      const log = exec?.agent?.session?.log ?? [];
      if (args.resume && owner) {
        const tool = continuation ? 'codex_continue' : 'codex_run';
        // 新一轮的结果不能替代同线程更早问题的用户回复。
        for (let offset = 0; offset !== null;) {
          const history = await conductor.list({ owner, thread_id: args.resume, limit: 100, offset }, exec?.signal);
          exec?.signal?.throwIfAborted();
          if (!Array.isArray(history.jobs)) throw new Error(`${tool}: 无法核对待续接线程的任务，未启动 Codex。`);
          const pending = history.jobs.find((job, index) => job.blocking?.next_action === 'ask_user' &&
            ((!continuation && offset === 0 && index === 0) || !hasUserReply(log, job, owner)));
          if (pending) throw new Error(`${tool}: 原任务 ${pending.job_id} 仍需用户回答，未启动 Codex。先向用户确认，再按最新任务状态用 codex_continue 处理。`);
          offset = history.next_offset ?? null;
        }
      }
      if (!continuation && args.write && owner) {
        for (let offset = 0; offset !== null;) {
          const history = await conductor.list({ owner, needs_attention: true, limit: 100, offset }, exec?.signal);
          exec?.signal?.throwIfAborted();
          if (!Array.isArray(history.jobs)) throw new Error('codex_run: 无法核对已有写入范围，未启动 Codex。');
          for (const job of history.jobs) {
            if (job.blocking?.next_action !== 'ask_user' || !job.blocking.blockers?.some(b => b.kind === 'task_conflict') ||
                hasUserReply(log, job, owner)) continue;
            const previous = withReport(await conductor.waitJob(job.job_id, 0, exec?.signal));
            exec?.signal?.throwIfAborted();
            if (unknownState(previous) || previous.job_id !== job.job_id) throw new Error(`codex_run: 无法核对原任务 ${job.job_id} 的写入范围，未启动 Codex。`);
            if (previous.blocking?.next_action === 'ask_user' &&
                widensOverlappingScope(previous.cwd ?? cwd, previous.scope_paths ?? previous.scope, cwd, args.scope)) {
              throw new Error(`codex_run: 原任务 ${job.job_id} 的范围冲突仍需用户回答，未启动 Codex。请先向用户确认新增写入路径。`);
            }
          }
          offset = history.next_offset ?? null;
        }
      }
      started = await conductor.start(args, cwd, undefined, {
        owner: owner ?? null, task: originalTask, acceptance: args.acceptance, write: args.write,
        ...(continuation ? { continuation } : {}),
      });
    } finally { dispatching--; }
    if (exec?.signal?.aborted) {
      if (started.job_id) await conductor.cancel(started.job_id, exec.signal);
      exec.signal.throwIfAborted();
    }
    const label = `Codex ${started.job_id} · ${taskLine(args, 40)}`;
    let value;
    if (started.status === 'running' && started.job_id) {
      const bg = background(started.job_id, exec, finish, label);
      value = await collect(started.job_id, bg, bg ? 0 : (args.wait_seconds ?? cfg.waitSeconds), exec?.signal);
    } else {
      value = withReport(started);
    }
    return value.rendered ? value : notifyOnDone(finish(value), exec, finish);
  }

  const waitSecondsDescription = `未登记 Harness 后台任务时最多等待的秒数，默认 ${cfg.waitSeconds}。` +
    '登记成功时直接返回任务号；需要同步等待时用该 job_id 调 codex_status。';
  ctx.tools.register({
    ...PRESENT.codex_run,
    presentCall: (args) => PRESENT.codex_run.presentCall({ host_access: cfg.defaultHostAccess === true, ...args }),
    name: 'codex_run',
    description: '把任务交给 WSL 里的 Codex 执行（它看不到本对话）。登记为 Harness 后台任务后直接返回任务号，结束时用 job_output 取报告。必须给出验收标准和 write：' +
      '要改文件、做修复、建备份或运行会产生写入的测试/部署，按用户授权传 write=true；纯只读核查传 false；scope 限定允许改动的路径。' +
      '沙箱内跨目录写入还要用 writable_roots 指定额外可写目录，并将实际写入目标列入 scope。Codex 会按验收标准逐条回报 ' +
      '（report），结果里还会标出它自报未满足、偏离计划和超出 scope 的改动。completed 后你要逐条只读核验，' +
      '原任务需要用户回答时先询问，再用 codex_continue；其他返工可带 resume=thread_id。同目录写锁被占用时会自动排队，用原 job_id 等待；codex_cancel 可取消排队，不要重复派活。' +
      '汇报格式由插件固定为 JSON，task/acceptance 里不要规定末行结论行之类的版式。' +
      (cfg.allowHostAccess === true
        ? (cfg.defaultHostAccess === true
          ? '当前默认以 danger-full-access 运行：省略 host_access 也没有沙箱，可以启动 Windows 程序及访问主机网络；resume 同样生效。host_access=false 可为单次任务恢复沙箱。'
          : '任务需要启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令等）或连接 Hyper-V 虚拟机时传 host_access=true；不传时 WSL 里的 Codex 启动不了 Windows 程序。')
        : 'WSL 里的 Codex 启动不了 Windows 程序（pwsh.exe、Hyper-V 命令等），不要把需要 Windows 运行时的检查写进 task/acceptance，这类检查你自己跑。'),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务：目标、相关文件路径、约束和背景。Codex 看不到本对话，必须写全。' },
        acceptance: { type: 'array', minItems: 1, items: { type: 'string' }, description: '验收标准，至少 1 条，不设条数上限；每条去除首尾空白后至少 4 个字符，写成可核验的结果：做完后应当存在什么、运行什么检查得到什么。' },
        write: { type: 'boolean', description: '必填。true 允许 Codex 修改任务目录及 writable_roots 指定目录里的文件（使用沙箱时为 workspace-write）；' +
          'false 只读调查：新开的只读任务不留会话，事后不能 resume；带 resume 追问写任务线程时仍可续跑' +
          `${cfg.allowHostAccess === true ? '，带 host_access=true 时也会保留会话' : ''}。测试/部署若会生成或删除文件、改变远端状态，也属于写入；须按用户授权设置 true 并在 scope/task 写明目标，不能同时要求这些操作和禁止任何写入。` },
        ...(cfg.allowHostAccess === true ? { host_access: { type: 'boolean', default: cfg.defaultHostAccess === true,
          description: 'true 时 Codex 在沙箱外运行（danger-full-access），' +
          '可以通过 WSL interop 启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令）、连接 Hyper-V 虚拟机；write 仍决定能否改动（文件、虚拟机、网络和系统状态）：' +
          '要启动/停止/新建虚拟机，或运行会建、改虚拟机的脚本，也要传 write=true，否则 Codex 只做只读调查。不再有沙箱，只靠提示约束。' +
          (cfg.defaultHostAccess === true ? '当前默认 true，新任务和 resume 都可省略；false 为本次任务恢复沙箱。' : '只在任务需要时传。') } } : {}),
        scope: { type: 'array', items: { type: 'string' }, description: '允许 Codex 改动的文件或目录（相对任务目录或绝对路径）。须覆盖所有获准的写入目标，包括新建的临时脚本、备份和工作区外的复制目的地。若任务必需的写入超出用户授权，先澄清再派单。' +
          '不展开通配符；动态命名的备份须在派活前确定具体文件名并列入 scope。' +
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
        wait_seconds: { type: 'integer', description: waitSecondsDescription },
      },
      required: ['task', 'acceptance', 'write'],
    },
    output: OUTPUT,
    execute: dispatch,
  });

  ctx.tools.register({
    ...PRESENT.codex_status,
    name: 'codex_status',
    description: '查询 Codex 任务，默认只查一次。已登记后台任务时，通常等 DSH 通知并用 job_output 读结果；' +
      '只有用户明确要求本轮同步等待时才传正数。仍在执行时返回最近活动、距上次活动的秒数、阶段和尝试轮次。' +
      '用 codex_output 分段读取原任务、验收标准和已回传的报告。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'codex_run 返回的 job_id。' },
        wait_seconds: { type: 'integer', description: '默认 0，只查一次；用户明确要求等待时传最多等待的秒数。' },
      },
      required: ['job_id'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_status: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
        throw new Error('codex_status: wait_seconds 必须是非负整数');
      }
      const value = await collect(args.job_id, liveBackground(args.job_id, exec), args.wait_seconds ?? 0, exec?.signal);
      return value.rendered ? value : notifyOnDone(finishStatus(value), exec, finishStatus);
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
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_cancel: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      const bg = liveBackground(args.job_id, exec);
      // 取消前先挂上等待：后台循环随后看到任务结束并结算，算作已被等到，DSH 不再另发一条结束通知。
      // 取消未确认时撤掉等待，免得吞掉任务之后真正结束时的通知。
      const stop = new AbortController();
      const settled = bg?.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner, stop.signal).catch(() => {});
      const value = await conductor.cancel(args.job_id);
      const unconfirmed = cancelUnconfirmed(value);
      if (unconfirmed) stop.abort();
      await settled;
      // 下一步要贴合「取消」这件事，不能套用重派话术
      const done = withReport({ job_id: args.job_id, ...value });
      let next;
      if (unconfirmed) {
        next = `取消未确认（${done.error_kind ?? done.status}），Codex 任务 ${args.job_id} 可能仍在运行：` +
          `用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${args.job_id}；需要取消时可再调用 codex_cancel，不要重派。`;
      } else if (done.status === 'completed') {
        // 取消没赶上：任务已经完成，改动已经留下，按完成处理
        next = `取消没有生效：任务在取消前已经完成，改动已经留下。先把这点告诉用户。\n${nextStep(done)}`;
      } else if (done.status === 'cancelled') {
        next = done.phase === 'lock_wait' ? nextStep(done)
          : '已按本次调用取消。可写任务可能已改了一部分且没有改动清单，核验或重派前先用 git status 或对比文件确认现状。';
      } else {
        next = `任务 ${args.job_id} 在取消前已经结束（${done.error_kind ?? done.status}），没有结束任何进程；是否重派或续跑由用户决定，不要自行重派。`;
      }
      return { ...done, next };
    },
  });

  async function historySelection(args, exec) {
    for (const key of ['cwd', 'session_id', 'thread_id', 'parent_job']) if (args[key] !== undefined &&
      (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} 必须是非空字符串`);
    const owner = args.session_id === 'current' ? exec?.agent?.id : args.session_id;
    if (args.session_id && owner === undefined) throw new Error('当前调用没有会话 ID');
    const cwd = args.cwd ?? (owner === undefined ? taskCwd({}, sessionCwd(exec), cfg.workspaces) : undefined);
    if (cwd === undefined && owner === undefined) throw new Error('请传 cwd 或 session_id');
    const historyOwner = owner ?? exec?.agent?.id;
    let events = historyOwner === exec?.agent?.id ? exec?.agent?.session?.log ?? [] : [];
    const query = owner !== undefined ? ctx.get?.('sessionQuery') : undefined;
    const observation = query ? await query.observeSession(owner, { projectionMode: 'none', signal: exec?.signal }) : undefined;
    let history, settled;
    try {
      events = observation?.events ?? events;
      const ownJobs = events.filter((e) => e.seq >= (observation?.inheritedEventCount ?? 0) &&
        (e.type === 'job/registered' || e.type === 'job/settled') && e.data.kind === 'codex' && e.data.owner === historyOwner);
      history = ownJobs.filter((e) => e.type === 'job/registered')
        .map((e) => ({ id: e.data.jobId, owner: e.data.owner, kind: e.data.kind, label: e.data.label }));
      settled = new Set(ownJobs.filter((e) => e.type === 'job/settled').map((e) => e.data.jobId));
    } finally { observation?.[Symbol.dispose](); }
    const native = (ctx.get?.('jobs')?.list(historyOwner) ?? []).filter((j) => j.owner === historyOwner);
    const linked = new Map([...history, ...native].filter((j) => j.kind === 'codex').flatMap((j) => {
      const match = /^Codex ([^\s·]+)/.exec(j.label ?? '');
      return match ? [[match[1], j]] : [];
    }));
    const filters = Object.fromEntries(['status', 'needs_attention', 'limit', 'offset', 'thread_id', 'parent_job']
      .filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    return { owner, linked, settled, filters: { ...filters, ...(cwd !== undefined ? { cwd } : {}),
      ...(owner !== undefined ? { owner, job_ids: [...linked.keys()] } : {}) } };
  }

  async function recoverBackground(agent) {
    const owner = agent?.id;
    const agents = ctx.get?.('agents');
    if (!owner || agents?.get(owner) !== agent || !ctx.get?.('jobs')) return;
    const exec = { agent };
    const { linked, settled } = await historySelection({ session_id: 'current' }, exec);
    for (const [id, entry] of linked) {
      if (entry.status !== undefined || settled.has(entry.id)) continue;
      const value = withReport(await conductor.waitJob(id, 0));
      if (value.job_id !== id || value.context?.owner !== owner || unknownState(value) ||
          !['running', 'completed', 'failed', 'cancelled'].includes(value.status)) continue;
      if (agents.get(owner) !== agent) return;
      if (!liveBackground(id, exec, true)) background(id, exec, finishStatus, entry.label);
    }
  }

  ctx.tools.register({
    name: 'codex_jobs',
    description: '只读列出 Codex 任务历史，找回 runner job_id、Codex thread_id 和本会话的 Harness 后台任务编号。' +
      '默认查当前工作区，可用 session_id="current" 查当前会话，或传指定会话 ID；旧任务归属未知时按 cwd 查。' +
      '可按执行状态或 needs_attention 筛选。completed 只表示执行结束，自报全部满足仍需独立核验。不会启动或恢复任务。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Codex 任务历史' }),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '任务工作目录，省略且未指定会话时使用当前工作区。' },
        session_id: { type: 'string', description: 'Harness 会话 ID；current 表示当前会话。' },
        status: { type: 'string', enum: ['running', 'completed', 'cancelled', 'failed', 'unknown'], description: '按执行状态筛选。' },
        needs_attention: { type: 'boolean', description: '仅列出失败、取消、报告异常、受阻或有未解决事项的任务。' },
        thread_id: { type: 'string', description: '仅查指定 Codex 线程。' },
        parent_job: { type: 'string', description: '仅查从这个 runner job_id 续接的后续轮次。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 20。' },
        offset: { type: 'integer', minimum: 0, description: '分页起点，默认 0。' },
      },
    },
    output: DATA_OUTPUT,
    async execute(args = {}, exec) {
      for (const key of ['cwd', 'session_id']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) {
        throw new Error(`codex_jobs: ${key} 必须是非空字符串`);
      }
      if (args.status !== undefined && !['running', 'completed', 'cancelled', 'failed', 'unknown'].includes(args.status)) throw new Error('codex_jobs: status 无效');
      if (args.needs_attention !== undefined && typeof args.needs_attention !== 'boolean') throw new Error('codex_jobs: needs_attention 必须是布尔值');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error('codex_jobs: limit 必须是 1–100 的整数');
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error('codex_jobs: offset 必须是非负整数');
      const { filters, linked, owner } = await historySelection(args, exec);
      const value = await conductor.list(filters, exec?.signal);
      if (!Array.isArray(value.jobs)) return value;
      return { ...value, jobs: value.jobs.map((job) => {
        const bg = linked.get(job.job_id);
        return { ...job, ...(bg ? { background_job_id: bg.id, owner: bg.owner } : {}) };
      }), ...(owner !== undefined ? { note: '无法从会话历史或任务元数据确认归属的旧任务，可用 cwd 按工作区找回；完整结果用 codex_output 读取。' } : {}) };
    },
  });

  ctx.tools.register({
    name: 'codex_output',
    description: '只读、可重复地分段读取 Codex 完整原始报告、runner 结果或原任务与验收上下文。' +
      'job_output 截断或已经消费结果时，用本工具找回；不会消费报告、启动或恢复任务。' +
      'offset 和 next_offset 按 Unicode 字符计算，按 next_offset 接着读取，直至 eof=true。',
    presentCall: (a) => ({ card: 'generic', kind: 'read', title: `Codex 完整结果 ${a?.job_id ?? ''}` }),
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'runner job_id；可用 codex_jobs 找回，不是 Harness 的 background_job_id。' },
        artifact: { type: 'string', enum: ['report', 'result', 'context', 'review'], description: 'report 原始全文；result 执行结果；context 原任务和验收标准；review 独立核验历史。默认 report。' },
        offset: { type: 'integer', minimum: 0, description: 'Unicode 字符起点，默认 0。' },
        limit: { type: 'integer', minimum: 1, maximum: 8000, description: '每段最多字符数，默认 4000。' },
      },
      required: ['job_id'],
    },
    output: DATA_OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_output: job_id 无效');
      if (args.artifact !== undefined && !['report', 'result', 'context', 'review'].includes(args.artifact)) throw new Error('codex_output: artifact 无效');
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error('codex_output: offset 必须是非负整数');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8000)) throw new Error('codex_output: limit 必须是 1–8000 的整数');
      return conductor.output(args.job_id, args, exec?.signal);
    },
  });

  const continuations = new Map();
  ctx.tools.register({
    name: 'codex_continue',
    description: '在用户回答阻塞问题或环境条件已改变后续接原任务；先核对原归属，严格保留原 cwd、验收、write、scope、权限和线程。' +
      'answers 用阻塞问题的 id，须来自原会话中的实际用户回复；缺回答时只返回问题。resolution 说明环境变化或旧报告解除阻塞的事实。原任务运行中、状态未知或已取消时不重派。' +
      '已有后续轮次时返回该轮次，不从同一个父任务重复派活。后续修正请用最新 job_id。',
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `续接 Codex ${a?.job_id ?? ''}` }),
    parameters: { type: 'object', properties: {
      job_id: { type: 'string' },
      answers: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] } },
      resolution: { type: 'string', description: '已满足环境条件或查明旧阻塞的具体事实，不是授权扩大范围。' },
      wait_seconds: { type: 'integer', minimum: 0, description: waitSecondsDescription },
    }, required: ['job_id'] },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_continue: job_id 无效');
      const owner = exec?.agent?.id;
      if (!owner) throw new Error('codex_continue: 当前调用没有会话 ID');
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) throw new Error('wait_seconds 必须是非负整数');
      const key = `${owner}:${args.job_id}`;
      if (continuations.has(key)) return continuations.get(key);
      const pending = (async () => {
        const source = withReport(await conductor.waitJob(args.job_id, 0));
        exec?.signal?.throwIfAborted();
        if (source.context?.owner !== owner) throw new Error('codex_continue: 原任务归属未知或不属于当前会话');
        const children = await conductor.list({ owner, parent_job: args.job_id, limit: 1 }, exec?.signal);
        if (!Array.isArray(children.jobs)) throw new Error(`codex_continue: 无法核对已有续接：${children.error ?? children.status}`);
        if (children.jobs.length) {
          const child = withReport(await conductor.waitJob(children.jobs[0].job_id, 0));
          const bg = liveBackground(child.job_id, exec);
          return { ...child, reused: true, ...(bg ? { background_job_id: bg.id } : {}),
            next: `原任务已有后续轮次 ${child.job_id}，没有重复派活。补充信息或修正请基于该轮次。\n${nextStep(child)}` };
        }
        const plan = prepareContinuation(source, args, owner);
        const needsReply = plan.ready && plan.blocking.questions.length > 0 &&
          !hasUserReply(exec.agent.session?.log ?? [], source, owner);
        if (!plan.ready || needsReply) return { ...source, continuation_ready: false, blocking: plan.blocking,
          remaining_questions: needsReply ? plan.blocking.questions : plan.remaining_questions,
          next: needsReply ? '原会话尚未收到这些问题产生后的用户回复。先向用户确认，等实际回答后再用 codex_continue 提交 answers。' : plan.next };
        return dispatch({ ...plan.args, ...(args.wait_seconds !== undefined ? { wait_seconds: args.wait_seconds } : {}) },
          exec, plan.continuation, plan.task);
      })();
      continuations.set(key, pending);
      try { return await pending; } finally { continuations.delete(key); }
    },
  });

  ctx.tools.register({
    name: 'codex_review',
    description: '规划端独立检查后记录逐条验收证据，保留 Codex 原报告。verified=全部核验通过，needs_changes=仍需修正，' +
      'accepted_deviations=逐条通过且原会话用户已明确接受原报告偏差或范围外改动。不能把 Codex 自报 met 当作独立核验。只能记录当前会话拥有的任务。',
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `记录 Codex 核验 ${a?.job_id ?? ''}` }),
    parameters: { type: 'object', additionalProperties: false, properties: {
      job_id: { type: 'string' }, status: { type: 'string', enum: ['verified', 'needs_changes', 'accepted_deviations'] },
      criteria: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { index: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['met', 'not_met', 'blocked'] },
          evidence: { type: 'string', minLength: 1 } }, required: ['index', 'status', 'evidence'] } },
      notes: { type: 'string', description: '没有补充说明可省略。' },
      accepted_deviations: { type: 'array', description: '原会话用户在作业结束后明确接受偏差或范围外改动时，逐项记录确认依据；没有时可省略。', items: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['reported', 'scope'] }, index: { type: 'integer', minimum: 1 },
          evidence: { type: 'string', minLength: 1 } }, required: ['kind', 'index', 'evidence'] } },
      blockers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, kind: { type: 'string', enum: ['user_input', 'task_conflict', 'environment', 'implementation'] },
        message: { type: 'string' }, question: { type: 'string' }, resolution: { type: 'string' },
      }, required: ['id', 'kind', 'message', 'question', 'resolution'] } },
    }, required: ['job_id', 'status', 'criteria'] },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_review: job_id 无效');
      const owner = exec?.agent?.id;
      const source = await conductor.waitJob(args.job_id, 0);
      if (!owner || source.context?.owner !== owner) throw new Error('codex_review: 原任务归属未知或不属于当前会话');
      exec?.signal?.throwIfAborted();
      const { job_id, notes = '', accepted_deviations = [], ...review } = args;
      if (Array.isArray(accepted_deviations) && accepted_deviations.length > 0 &&
          !hasUserReply(exec.agent.session?.log ?? [], source, owner)) {
        throw new Error('codex_review: 原会话尚未收到作业结束后的用户确认，未写入核验记录。不要替用户接受偏差。');
      }
      const result = await conductor.review(job_id, { ...review, notes, accepted_deviations }, owner, exec?.signal);
      // 无 job_id 的参数错误属于复核调用，不能按 Codex 执行结果补状态。
      if (result.error_kind === 'bad_arguments' && !result.job_id) {
        throw new Error(`codex_review: 复核操作失败：${result.error}。请先处理这项复核错误再重新提交；` +
          `用 codex_status 查询原任务 ${job_id}，不要仅因此重新派活。`);
      }
      const value = withReport(result);
      return { ...value, next: nextStep(value) };
    },
  });

  ctx.tools.register({
    name: 'codex_summary',
    description: '只读汇总当前会话的多轮 Codex 任务；相同 thread_id 归为一组，无线程的独立列出。' +
      '显示最新验收、待办、交付文件、累计已结束耗时和用量。thread_total 是线程累计值，不把每轮累计值重复相加。' +
      '可传 cwd 查一个项目，或 session_id 查指定会话；默认每页 10 组，用 limit 和 offset 翻页。不会启动或继续任务。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Codex 多轮任务汇总' }),
    parameters: { type: 'object', properties: {
      cwd: { type: 'string' }, session_id: { type: 'string' }, thread_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页线程组数，默认 10。' },
      offset: { type: 'integer', minimum: 0, description: '从第几组开始，默认 0；下一页用 next_offset。' },
    } },
    output: { schema: DATA_OUTPUT.schema, render: (_args, value) => [{ type: 'text', text: Array.isArray(value.groups)
      ? [`Codex 汇总：${value.total} 组，${value.total_jobs} 轮；本页 ${value.groups.length} 组。` +
        (value.next_offset == null ? '' : `沿用筛选和每页条数，传 offset=${value.next_offset} 查看下一页。`) +
        '执行结束与独立验收分别显示。', ...value.groups.map((g) =>
        [`${g.thread_id ?? g.group_id} · ${g.total_rounds} 轮 · 最新 ${g.latest_job_id} · 执行 ${g.latest_job?.execution_status ?? g.latest_job?.status ?? 'unknown'} · 独立核验 ${g.verification_status ?? 'unknown'}`,
          `目标：${taskLine(g.latest_job?.context, 160)}`, `最新结果：${g.summary ?? ''}`,
          `涉及文件（含历史改动）：${g.files_changed.join('、') || '无'}`, `未闭环事项：${JSON.stringify(g.open_items)}`,
          `已结束轮次耗时合计：${typeof g.finished_duration_s === 'number' ? `${Math.round(g.finished_duration_s)} 秒` : '未知'}；用量（${g.usage_scope}）：${g.usage == null ? '未知（原始用量不完整）' : JSON.stringify(g.usage)}`,
          ...(g.rounds_truncated ? ['只展示最新轮次明细；总轮数、文件集合与耗时按全部匹配记录计算。'] : []),
        ].join('\n'))].join('\n\n') : JSON.stringify(value, null, 2) }] },
    async execute(args = {}, exec) {
      const selected = args.cwd !== undefined || args.session_id !== undefined ? args : { session_id: 'current', ...args };
      const { filters } = await historySelection(selected, exec);
      return conductor.summary(filters, exec?.signal);
    },
  });

  ctx.tools.register({
    name: 'codex_watch',
    description: '为当前会话登记安静的原生后台观察：attention 仅在失败、受阻、报告异常等重要变化时通知；all 也通知开始/正常完成。' +
      '空闲时只观察 Harness 内存任务表，不反复启动 Codex 或唤醒模型。首次符合条件的变化后结束，需要继续观察可再调用。' +
      '停止这个观察任务只停止观察，不取消 Codex。任务本身原有的结束通知仍保留。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: '安静观察 Codex' }),
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['attention', 'all'] } } },
    output: DATA_OUTPUT,
    async execute({ mode = 'attention' } = {}, exec) {
      if (!['attention', 'all'].includes(mode)) throw new Error('codex_watch: mode 无效');
      const jobs = ctx.get?.('jobs');
      const owner = exec?.agent?.id;
      if (!jobs || !owner) throw new Error('codex_watch: 需要 Harness 原生后台任务服务与当前会话 ID');
      const label = `Codex 安静观察 · ${mode}`;
      const existing = jobs.list(owner).find((j) => j.owner === owner && j.kind === 'codex-watch' && j.label === label && ['running', 'stopping'].includes(j.status));
      if (existing) return { status: 'watching', background_job_id: existing.id, reused: true, mode };
      const snapshot = () => new Map(jobs.list(owner).filter((j) => j.owner === owner && j.kind === 'codex').flatMap((j) => {
        const id = /^Codex ([^\s·]+)/.exec(j.label ?? '')?.[1];
        return id ? [[j.id, { job_id: id, status: j.status }]] : [];
      }));
      let baseline = snapshot();
      const id = jobs.start({ owner, kind: 'codex-watch', label, outputLimitBytes: 32768,
        run(handle) {
          let stopped = false;
          let timer;
          let wake;
          const done = (async () => {
            handle.updateProgress('等待重要状态变化；无变化不唤醒模型');
            while (!stopped) {
              const current = snapshot();
              const changes = [...current].filter(([id, item]) => baseline.get(id)?.status !== item.status);
              for (const [id, item] of baseline) if (!current.has(id)) changes.push([id, { ...item, status: 'no_longer_listed' }]);
              baseline = current;
              const alerts = [];
              for (const [backgroundId, item] of changes) {
                if (mode === 'attention' && ['running', 'stopping'].includes(item.status)) continue;
                // 观察中止不能传给 waitJob；它的 signal 代表取消业务任务。
                const value = withReport(await conductor.waitJob(item.job_id, 0));
                const closed = ['verified', 'accepted_deviations'].includes(value.verification_status);
                const attention = !closed && (!['running', 'completed', 'cancelled'].includes(value.status) ||
                  (value.status === 'completed' && (value.review_status === 'needs_attention' ||
                    ['needs_changes', 'invalid'].includes(value.verification_status))));
                if (mode === 'all' || attention) alerts.push({ job_id: item.job_id, background_job_id: backgroundId,
                  status: value.status, summary: value.report?.summary ?? value.error ?? summaryLine(value),
                  blocking: value.blocking, verification_status: value.verification_status, next: nextStep(value) });
              }
              if (stopped) break;
              if (alerts.length) return { status: 'completed', detail: `${alerts.length} 个重要状态变化`,
                result: JSON.stringify({ changes: alerts, note: '观察已结束；完整结果用 codex_output，多轮汇总用 codex_summary。' }, null, 2) };
              await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, 1000); });
              wake = undefined;
            }
            return { status: 'killed', detail: '已停止观察，Codex 继续运行', result: '仅停止观察；没有取消任何 Codex 任务。' };
          })();
          return { done, cancel: () => { stopped = true; clearTimeout(timer); wake?.(); } };
        },
      });
      return { status: 'watching', background_job_id: id, mode, note: '无变化不通知；停止该后台观察不会取消 Codex。' };
    },
  });

  registerRuntimeTool({ ctx, conductor, moduleUrl: import.meta.url, loadedIdentity,
    profileFile: cfg.runtimeProfileFile,
    loadedFile: process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor', 'loaded.json') : '',
    activeDispatches: () => dispatching, dispatchGeneration: () => dispatchGeneration });

  // 宿主重开会清空内存任务表；只接回本会话已经登记、但未收到结算的 runner 作业。
  const recoverAgent = (agent) => { void recoverBackground(agent).catch((error) => {
    ctx.logger?.warn?.(`[codex-conductor] 无法接回后台任务：${error?.message ?? error}`);
  }); };
  ctx.on('agent/created', ({ agent }) => recoverAgent(agent));
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) recoverAgent(agent);

  // 防虚报：每个回合最多提醒一次，提醒会让这一回合继续，由它补调用或更正说法
  const nudged = new Set();
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      if (!inWorkspace(agent?.session?.header?.cwd, cfg.roots) || liveBackground(undefined, { agent })) return;
      const key = `${agent.id}:${turn}`;
      if (nudged.has(key)) return;
      const { text, tools } = turnSummary(agent.session.log ?? [], turn);
      if (!DISPATCH_CLAIM.test(text) || tools.some((n) => ['codex_run', 'codex_continue', 'codex_status', 'codex_cancel'].includes(n))) return;
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
  ctx.logger?.info?.(`[codex-conductor] active v${loadedIdentity.version ?? '?'}；护栏工作区 ${cfg.roots.join(', ') || '(未配置)'}`);
  // 桌面宿主日志不落盘，留一个加载标记，便于确认插件是否在运行中的 DSH 里生效
  // 没有 LOCALAPPDATA（Linux 上跑测试）时不写，免得落到当前目录
  if (process.env.LOCALAPPDATA) try {
    const dir = path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'loaded.json'),
      JSON.stringify({ ...loadedIdentity, loadedAt: new Date().toISOString(), pid: process.pid, module: import.meta.url, workspaces: cfg.roots,
        tools: ['codex_run', 'codex_status', 'codex_cancel', 'codex_jobs', 'codex_output', 'codex_continue', 'codex_review', 'codex_summary', 'codex_watch', 'codex_runtime'],
        allowHostAccess: cfg.allowHostAccess === true, defaultHostAccess: cfg.defaultHostAccess === true,
        serviceTier: cfg.serviceTier || null, ...loadedGateway(cfg),
        plannerPromptFile: plannerFile, plannerPromptInjected: plannerInjected }, null, 1));
  } catch {}
}
