import path from 'node:path';
import { fileURLToPath } from 'node:url';

function wslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : p;
}

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
  const m = /^\/mnt\/([a-z])(\/.*)?$/i.exec(s);
  if (m) s = `${m[1]}:${m[2] ?? '/'}`;
  const windows = /^[A-Za-z]:/.test(s) || s.startsWith('//');
  s = path.posix.normalize(s).replace(/\/+$/, '') || '/';
  return windows ? s.toLowerCase() : s;
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
    if (ch === '$' && next === '[') return null;
    if (ch === '$' && next === '(') {
      // $((...)) 是算术：会把变量值当表达式递归求值，值里的 a[$(...)] 就能执行命令
      if (command[i + 2] === '(') return null;
      const end = closingParen(command, i + 2);
      if (end < 0 || !inner(command.slice(i + 2, end))) return null;
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
    if (ch === '>' || ch === '<' || (ch === '&' && next === '>')) {
      if (!redirect && kind === 'literal' && /^\d+$/.test(word)) {
        word = ''; started = false; syntax = ''; parameterWord = '';
      } else endWord();
      if (redirect) return null;
      let j = ch === '&' ? i + 2 : i + 1;
      if (ch === '<' && (command[j] === '<' || command[j] === '(')) return null;
      if (ch === '>' && command[j] === '(') return null;
      if (ch === '>' && command[j] === '>') j++;
      if (ch === '>' && command[j] === '&' && /\d/.test(command[j + 1] ?? '')) { i = j + 1; continue; }
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
    case 'git': return gitAllowed(args);
    case 'gzip': return ['-t', '--test'].includes(args[0]);
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
  return bad ? `不放行的是「${core(bad, expansions.get(bad).kinds).words.join(' ').slice(0, 200)}」` : '命令为空';
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

export { wslPath, under, inWorkspace };
