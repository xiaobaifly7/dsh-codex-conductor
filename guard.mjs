import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function wslPath(p) {
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
  'uname', 'whoami', 'id', 'paste', 'tasklist', 'netstat']);
// 流程控制关键字本身不执行任何东西，剥掉后检查它带的命令
const LEAD_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(', 'time']);
const CLOSE_KEYWORDS = new Set(['fi', 'done', '}', ')']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame',
  'grep', 'describe', 'shortlog', 'cat-file', 'whatchanged', 'rev-list', 'diff-tree', 'check-ignore']);
const GIT_BRANCH_READ = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--show-current', '--no-color']);
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
const SED_START = new RegExp(String.raw`^\s*(?:${SED_ADDRESS})?([sp])`);
// These names change command lookup, startup code or tool execution options rather than hold task data.
const EXEC_ENV = /^(?:PATH|HOME|XDG_CONFIG_HOME|IFS|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|CDPATH|GLOBIGNORE|BASH_XTRACEFD|PS4|PROMPT_COMMAND|LD_.*|DYLD_.*|GCONV_PATH|GIT_.*|TAR_OPTIONS|NODE_.*|PYTHON.*|AWKPATH|AWKLIBPATH)$/;
const assignmentAllowed = (w) => /^[A-Za-z_][A-Za-z0-9_]*=(?![-(])\S*$/.test(w) &&
  !w.includes('$(') && !EXEC_ENV.test(w.slice(0, w.indexOf('=')));

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

export const under = (p, r) => p === r || p.startsWith(r === '/' ? r : `${r}/`);

export function inWorkspace(cwd, roots) {
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
export function splitCommand(command, inner = () => false, braceSegments = new Set(), expansions = new Map(), variables = new Map()) {
  variables = new Map(variables);
  let preamble = true;
  const segments = [];
  let words = [];
  let kinds = [];
  let parameters = [];
  let patterns = [];
  let dynamicWords = [];
  let inputs = [];
  let dynamic = false;
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
        if (redirect === '<') inputs.push({ path: word, dynamic: dynamic || /[*?{}~]|\[[^\]]+\]/.test(syntax) });
        redirect = null;
      } else {
        words.push(word);
        kinds.push(kind);
        parameters.push(parameterWord);
        const commandPosition = words.slice(0, -1).every((w, j) => kinds[j] === 'assignment' ||
          (kinds[j] === 'literal' && LEAD_KEYWORDS.has(w)));
        if ((commandPosition && (LEAD_KEYWORDS.has(word) || CLOSE_KEYWORDS.has(word) || ['for', 'read'].includes(word))) ||
            (kind === 'assignment' && !preamble)) variables.clear();
        unsafeParameter ||= !braceExpansionsSafe(parameterWord);
        expanded ||= /\{(?:[^{}]*,[^{}]*|(?:-?\d+\.\.-?\d+|[A-Za-z]\.\.[A-Za-z])(?:\.\.-?\d+)?)\}/.test(syntax);
        const pattern = /[*?]|\[[^\]]+\]/.test(syntax);
        patterns.push(pattern);
        dynamicWords.push(dynamic || /^~/.test(syntax) || /\{(?:[^{}]*,[^{}]*|[^{}]*\.\.[^{}]*)\}/.test(syntax));
        glob ||= pattern;
        // test 的额外词可能变成操作符；固定字母/路径前缀的 glob 无法生成 -v、! 等词。
        fieldSplit ||= /\$(?![?#])/.test(syntax) ||
          (pattern && !/^[A-Za-z0-9_./]/.test(word) && !intOperand(word));
      }
    }
    word = ''; kind = 'literal'; started = false; syntax = ''; parameterWord = ''; dynamic = false;
  };
  const endSegment = (separator = '') => {
    endWord();
    if (redirect) valid = false;
    if (words.length) {
      if (expanded) braceSegments.add(words);
      expansions.set(words, { glob, fieldSplit, unsafeParameter, kinds, parameters, patterns, dynamicWords, inputs });
      segments.push(words);
      // Only an unconditional, initial assignment preamble supplies known scalar values.
      if (preamble && words.every((w, i) => kinds[i] === 'assignment' && assignmentAllowed(w)) && [';', '\n'].includes(separator)) {
        for (const w of words) {
          const eq = w.indexOf('=');
          const value = w.slice(eq + 1);
          variables.delete(w.slice(0, eq));
          if (/^[^\s$`*?\[\]{}\\~;|&<>]*$/.test(value)) variables.set(w.slice(0, eq), value);
        }
      } else {
        preamble = false;
        if (kinds.includes('assignment')) variables.clear();
      }
    }
    words = []; kinds = []; parameters = []; patterns = []; dynamicWords = []; inputs = []; expanded = false; glob = false; fieldSplit = false; unsafeParameter = false;
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
    if (ch === '$') {
      if (/^[({A-Za-z0-9_@*#?!-]/.test(next ?? '')) dynamic = true;
      const variable = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(command.slice(i));
      if (variable && variables.has(variable[1] ?? variable[2]) && (kind === 'assignment' ? !words.length : words.length > 0)) {
        const value = variables.get(variable[1] ?? variable[2]);
        word += value; parameterWord += value;
        if (kind === 'literal') kind = 'word';
        started = true; i += variable[0].length - 1;
        continue;
      }
      if (next === '{' && !variable) variables.clear();
    }
    const expansion = ch === '$' ? skipLineContinuations(command, i + 1) : -1;
    if (command[expansion] === '[') return null;
    if (command[expansion] === '(') {
      // $((...)) 是算术：会把变量值当表达式递归求值，值里的 a[$(...)] 就能执行命令
      const start = expansion + 1;
      if (command[skipLineContinuations(command, start)] === '(') return null;
      const end = closingParen(command, start);
      if (end < 0 || !inner(command.slice(start, end), variables)) return null;
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
      endSegment(next === ch ? ch + next : ch);
      if ((ch === '|' || ch === '&') && next === ch) i++;
      continue;
    }
    if (ch === '=' && kind === 'literal' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) &&
        words.every((w, j) => kinds[j] === 'assignment' || (kinds[j] === 'literal' && LEAD_KEYWORDS.has(w)))) kind = 'assignment';
    word += ch;
    parameterWord += ch;
    syntax += ch;
    started = true;
  }
  if (quote) return null;
  endSegment();
  return valid && !redirect ? segments : null;
}

function gitArguments(args) {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-P' || args[i] === '-C') i += args[i] === '-C' ? 2 : 1;
  return args.slice(i);
}

function gitAllowed(args) {
  const [sub, ...rest] = gitArguments(args);
  if (sub === '--version') return rest.length === 0;
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
  const assignments = [];
  while (start < end && kinds[start] === 'assignment') assignments.push(words[start++]);
  let wrapped = false;
  while (words[start] === 'timeout') {
    let i = start + 1;
    while (i < end && words[i].startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(words[i]) ? 2 : 1;
    if (!/^\d+(\.\d+)?[smhd]?$/.test(words[i] ?? '') || end <= i + 1) break;
    start = i + 1;
    wrapped = true;
  }
  return { words: words.slice(start, end), kind: wrapped ? 'command' : kinds[start], start, assignments };
}

// Read one sed field; unfamiliar bracket syntax is refused rather than mistaken for a delimiter.
function sedField(script, start, delimiter, pattern) {
  for (let i = start; i < script.length; i++) {
    if (/\r|\n/.test(script[i])) return -1;
    if (script[i] === '\\') {
      if (!script[i + 1] || /\r|\n/.test(script[++i])) return -1;
    } else if (script[i] === delimiter) return i;
    else if (pattern && script[i] === '[') {
      const cls = /^\[\^?(?:\[:[a-z]+:\]|[^\][\\\r\n])+\]/.exec(script.slice(i));
      if (!cls || cls[0].includes(delimiter)) return -1;
      i += cls[0].length - 1;
    }
  }
  return -1;
}

function sedScriptAllowed(script) {
  if (SED_PRINT.test(script)) return true;
  let rest = script;
  while (rest.trim()) {
    const start = SED_START.exec(rest);
    if (!start) return false;
    let end = start[0].length;
    if (start[1] === 's') {
      const delimiter = rest[end++];
      if (!delimiter || /[A-Za-z0-9\\\s]/.test(delimiter)) return false;
      const pattern = sedField(rest, end, delimiter, true);
      if (pattern < 0) return false;
      const replacement = sedField(rest, pattern + 1, delimiter, false);
      if (replacement < 0) return false;
      end = replacement + 1;
      const flags = /^[gIp0-9]*/.exec(rest.slice(end))[0];
      end += flags.length;
    }
    rest = rest.slice(end).trimStart();
    if (!rest) return true;
    if (rest[0] !== ';') return false;
    rest = rest.slice(1);
  }
  return false;
}

function sedIssue(args, patterns = []) {
  let i = 0;
  while (/^-[nEr]+$/.test(args[i] ?? '') || ['--quiet', '--silent', '--regexp-extended'].includes(args[i])) i++;
  if (args.some((a) => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) return '-i/--in-place 会改写文件';
  if (!args[i] || args[i].startsWith('-')) return '仅支持内联打印或替换脚本，不放行 -e/-f 等脚本选项';
  if (patterns[i]) return '脚本不能由未引用的 glob 展开生成';
  if (!sedScriptAllowed(args[i])) return '脚本仅支持 p/s 输出，不放行 w/e/r 命令及 s 的 w/e 标志';
  if (args.slice(i + 1).some((a) => a.startsWith('-') && a !== '-')) return '脚本后的选项可能改写文件或加载其他脚本';
  return '';
}

function awkIssue(args, patterns = []) {
  let i = 0;
  while (args[i] === '-F' || args[i] === '-v' || /^-F./.test(args[i] ?? '')) {
    const option = args[i++];
    if (option === '-F' || option === '-v') {
      if (args[i] === undefined || (option === '-v' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) return '-F/-v 缺少字面参数';
      i++;
    }
  }
  const script = args[i]?.replace(/\\\r?\n/g, '');
  if (!script || script.startsWith('-')) return '不放行 -f/-e/-i/-l 等文件、附加程序或扩展加载选项';
  if (patterns[i]) return '程序不能由未引用的 glob 展开生成';
  if (/\bsystem\s*\(/.test(script)) return 'system(...) 可以启动进程';
  if (script.replaceAll('||', '').includes('|')) return '管道 | 可以启动进程';
  if (/>(?!=)/.test(script)) return '重定向 > 可以写文件';
  if (/\bgetline\b/.test(script)) return 'getline 可以读取外部文件或管道';
  if (script.includes('@')) return '@include/@load/间接调用可以加载或执行代码';
  if (args.slice(i + 1).some((a) => a.startsWith('-') && a !== '-')) return '程序后的选项可能加载其他程序或扩展';
  return '';
}

function findIssue(args, extra, braceExpansion, expansion) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(?:delete$|fprint|fls$|ok)/.test(a)) return `${a} 会写文件或执行交互命令`;
    if (a !== '-exec' && a !== '-execdir') continue;
    let end = i + 1;
    while (end < args.length && args[end] !== ';' && !(args[end] === '+' && args[end - 1] === '{}')) end++;
    if (end === args.length || end === i + 1) return `${a} 缺少完整的只读命令及 ;/+ 结束符`;
    const nested = args.slice(i + 1, end).map((w) => w.replaceAll('{}', '$X'));
    const parameters = expansion.parameters.slice(i + 1, end).map((w) => w.replaceAll('{}', '$X'));
    const patterns = expansion.patterns?.slice(i + 1, end);
    const cmd = nested[0];
    if (cmd === 'pytest' || (!READERS.has(cmd) && !['sed', 'awk', 'find', 'sort', 'uniq', 'dd', 'base64', 'ssh-keygen'].includes(cmd)) ||
        !segmentAllowed(nested, extra, braceExpansion, { ...expansion, kinds: nested.map(() => 'command'), parameters, patterns })) {
      return `${a} 后的 ${cmd} 不是已放行的只读命令`;
    }
    i = end;
  }
  return '';
}

function ddIssue(args) {
  if (args.some((a) => a.startsWith('of='))) return 'of= 会写入输出文件';
  const bad = args.find((a) => !/^(?:if|bs|skip|count)=.+$/.test(a));
  return bad === undefined ? '' : `不放行 ${bad}，仅支持 if=/bs=/skip=/count= 并输出到 stdout`;
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
  const { words, kind, start, assignments } = core(raw, expansion.kinds);
  if (extra.some((rx) => rx.test(raw.join(' ')) || rx.test(words.join(' ')))) return true;
  // 只检查实际展开；单引号和转义保护的字面文本不参与。
  if (expansion.unsafeParameter) return false;
  if (!assignments.every(assignmentAllowed)) return false;
  if (!words.length) return true;
  // 循环列表里的词会代入后面的命令，不能借它塞进参数（for f in -delete; do find . $f）
  if (words[0] === 'for') return kind === 'literal' && (words.length <= 2 || words[2] === 'in') &&
    words.slice(3).every((w) => !w.startsWith('-'));
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return false;
  if (PWSH.test(words[0])) return pwshTestAllowed(words.slice(1));
  const [cmd, ...args] = words;
  const parameters = expansion.parameters?.slice(start + 1) ?? args;
  const patterns = expansion.patterns?.slice(start + 1);
  // 展开后的词可能变成被过滤的开关，不能把它当成普通文件参数。
  if (/^(git|iconv|icacls|find|sed|awk|dd|base64|ssh-keygen|rg|sort|uniq|tree|file|date|npm|pnpm|yarn|node|go|cargo|make)$/.test(cmd) &&
      (braceExpansion || parameters.some((a) => a.includes('$')) || (expansion.glob && expansion.fieldSplit))) return false;
  switch (cmd) {
    // 只放行直接、无参数的内建控制；timeout 后的同名外部程序仍拒绝。
    case ':': case 'continue': return kind === 'literal' && args.length === 0;
    case 'command': return kind === 'literal' && args[0] === '-v' && args.length > 1 &&
      args.slice(1).every((a) => /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(a));
    case 'git': return gitAllowed(args);
    case 'reg': return args[0] === 'query';
    case 'icacls': return args.length === 1 && !/^[/-]/.test(args[0]);
    case 'xargs': {
      const rest = args[0] === '-r' ? args.slice(1) : args;
      return rest.length === 1 && ['cat', 'sha256sum'].includes(rest[0]);
    }
    case 'gzip': return ['-t', '--test'].includes(args[0]);
    // GNU tar can inherit execution options from TAR_OPTIONS; only list with it removed.
    case 'env': return args.length === 0 || (kind === 'literal' && args.length === 5 && args[0] === '-u' &&
      args[1] === 'TAR_OPTIONS' && args[2] === 'tar' && args[3] === '-tzvf' &&
      !braceExpansion && !expansion.glob && /^(?!-)[^:$~]+$/.test(args[4]));
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
    case 'find': return !findIssue(args, extra, braceExpansion, { ...expansion, parameters, patterns });
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
    case 'sed': return !sedIssue(args, patterns);
    case 'awk': return !awkIssue(args, patterns);
    case 'dd': return !ddIssue(args);
    case 'base64': return args.includes('-d') || args.includes('--decode') ?
      args.every((a) => !a.startsWith('-') || ['-', '-d', '--decode', '-i', '--ignore-garbage'].includes(a)) : false;
    case 'ssh-keygen': return (args.length === 3 && args[0] === '-l' && args[1] === '-f') ||
      (args.length === 2 && args[0] === '-lf');
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

export function readOnlyCommand(command, extra = [], variables = new Map()) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const braceSegments = new Set();
  const expansions = new Map();
  const segments = splitCommand(command, (sub, vars) => readOnlyCommand(sub, extra, vars), braceSegments, expansions, variables);
  return segments !== null && segments.length > 0 && segments.every((w) => segmentAllowed(w, extra, braceSegments.has(w), expansions.get(w)));
}

// 拒绝原因：整条命令截断后看不到真正卡住的地方，所以指出不放行的结构或第一段不放行的命令
function refusedPart(command, extra) {
  const braceSegments = new Set();
  const expansions = new Map();
  const segments = typeof command === 'string' ? splitCommand(command, (sub, vars) => readOnlyCommand(sub, extra, vars), braceSegments, expansions) : [];
  if (segments === null) {
    return '含不放行的结构：写到 /dev/null 以外的重定向、反引号、heredoc、$((...)) 算术、$[...] 算术、进程替换、$(...) 里的非只读命令或未闭合引号';
  }
  const bad = segments.find((w) => !segmentAllowed(w, extra, braceSegments.has(w), expansions.get(w)));
  if (!bad) return '命令为空';
  const { words: commandWords, start, assignments } = core(bad, expansions.get(bad).kinds);
  const words = assignments.every(assignmentAllowed) ? commandWords : bad;
  const args = words.slice(1);
  const expansion = { ...expansions.get(bad), parameters: expansions.get(bad).parameters.slice(start + 1),
    patterns: expansions.get(bad).patterns.slice(start + 1) };
  let hint = '';
  if (words[0] === 'tar' && words[1] === '-tzvf' && words.length === 3) {
    hint = '；列出本地压缩包可用 env -u TAR_OPTIONS tar -tzvf ./archive.tar.gz，换成实际文件路径';
  } else if (['find', 'sed', 'awk', 'dd'].includes(words[0])) {
    const issue = ({ sed: () => sedIssue(args, expansion.patterns), awk: () => awkIssue(args, expansion.patterns), dd: () => ddIssue(args),
      find: () => findIssue(args, extra, braceSegments.has(bad), expansion) })[words[0]]();
    if (issue) hint = `；${issue}`;
  }
  if (!hint && ['find', 'sed'].includes(words[0]) && args.some((a) => a.includes('$'))) {
    hint = '；这类只读核验不接受含 $ 的参数，请直接写出固定路径和查询参数';
  }
  return `不放行的是「${words.join(' ').slice(0, 200)}」${hint}`;
}

const present = (v) => v !== undefined && v !== null && v !== false && v !== '' &&
  !(typeof v === 'object' && Object.keys(v).length === 0);

export const PRODUCT_DENY_HINT = '已拒绝。调查交给 codex_run；核对产物交给核验任务 codex_verify。不要换命令、语言或工具入口重试。';
export const PRODUCT_HINT = `这是原料，规划端不直接读。${PRODUCT_DENY_HINT}`;

// Use the same mount/case normalization as scopes; resolve local links before comparing.
export function readPath(file, cwd = '') {
  if (typeof file !== 'string' || !file.trim()) return '';
  if (/^~|^[A-Za-z]:[^\\/]|^[A-Za-z][A-Za-z0-9+.-]+:/.test(file) && !/^[A-Za-z]:[\\/]/.test(file)) return '';
  const absolute = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(file) ? file : cwd ? `${cwd}/${file}` : '';
  if (!absolute) return '';
  const native = process.platform === 'win32'
    ? absolute.replace(/^\/mnt\/([a-z])(?=\/|$)/i, (_, drive) => `${drive}:`) : absolute;
  try { return normPath(realpathSync(native)); } catch { return normPath(absolute); }
}

const METADATA_COMMANDS = new Set(['pwd', 'ls', 'stat', 'du', 'df', 'basename', 'dirname', 'realpath', 'readlink',
  'which', 'echo', 'printf', 'true', 'test', '[', '[[', 'read', 'exit', ':', 'continue', 'for',
  'ps', 'pgrep', 'uname', 'whoami', 'id', 'tasklist', 'netstat', 'reg', 'icacls', 'tree', 'command']);
const CONTENT_COMMANDS = new Set(['cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk',
  'nl', 'cut', 'strings', 'hexdump', 'od', 'dd', 'diff', 'cmp', 'sha256sum', 'sha1sum', 'md5sum',
  'sort', 'uniq', 'paste', 'column', 'jq', 'file', 'readelf', 'objdump', 'nm', 'gzip', 'iconv', 'base64', 'ssh-keygen']);
const NO_VALUE_OPTIONS = new Set(['--help', '--version', '--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs',
  '--squeeze-blank', '--line-number', '--ignore-case', '--invert-match', '--extended-regexp', '--fixed-strings', '--recursive',
  '--with-filename', '--no-filename', '--only-matching', '--count', '--files-with-matches', '--files-without-match', '--text',
  '--quiet', '--silent', '--no-messages', '--null', '--null-data', '--lines', '--bytes', '--chars', '--words', '--max-line-length',
  '--human-readable', '--unique', '--reverse', '--numeric-sort', '--general-numeric-sort', '--ignore-leading-blanks', '--check',
  '--brief', '--mime', '--mime-type', '--mime-encoding', '--dereference', '--uncompress', '--test', '--decode', '--ignore-garbage',
  '--raw-output', '--compact-output', '--slurp', '--null-input', '--raw-input', '--sort-keys', '--monochrome-output', '--exit-status']);

// Return operand indexes, retaining options that themselves read a file (grep -f, jq --slurpfile, ...).
function fileArguments(args, takes = [], fileOptions = []) {
  const files = [], operands = [];
  let flags = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags && arg === '--') { flags = false; continue; }
    if (flags && arg.startsWith('-') && arg !== '-') {
      const option = arg.split('=')[0];
      const attached = arg.includes('=') || (!arg.startsWith('--') && arg.length > 2);
      const key = arg.startsWith('--') ? option : arg.slice(0, 2);
      if (!arg.startsWith('--') && !takes.includes(key) && !fileOptions.includes(key) &&
          [...takes, ...fileOptions].some(flag => /^-[^-]$/.test(flag) && arg.slice(2).includes(flag[1]))) return null;
      if (fileOptions.includes(key)) {
        if (attached) files.push({ index: i, path: arg.startsWith('--') ? arg.slice(arg.indexOf('=') + 1) : arg.slice(2) });
        else if (args[++i] !== undefined) files.push({ index: i, path: args[i] });
        else return null;
      } else if (takes.includes(key) && !attached) {
        if (args[++i] === undefined) return null;
      } else if (arg.startsWith('--') && !takes.includes(key) && (attached || !NO_VALUE_OPTIONS.has(key))) return null;
      continue;
    }
    operands.push({ index: i, path: arg });
  }
  return { files, operands };
}

export function shellReadTargets(command, cwd) {
  const expansions = new Map(), braces = new Set(), targets = [];
  let unknown = false;
  const segments = splitCommand(command, (sub) => {
    const reads = shellReadTargets(sub, cwd);
    if (reads === null) unknown = true;
    else targets.push(...reads);
    return true;
  }, braces, expansions);
  if (!segments || unknown) return null;
  for (const raw of segments) {
    const expansion = expansions.get(raw);
    const { words, start } = core(raw, expansion.kinds);
    for (const input of expansion.inputs) {
      if (input.dynamic || !readPath(input.path, cwd)) return null;
      targets.push(readPath(input.path, cwd));
    }
    if (!words.length) continue;
    const [cmd, ...args] = words;
    if (cmd === 'cd') { cwd = ''; continue; } // shortcut: relative reads after cd are refused; use workdir until cwd control-flow parsing is needed.
    if (METADATA_COMMANDS.has(cmd)) {
      if (['du', 'tree'].includes(cmd) && (args.some(a => /^--(?:files0-from|fromfile)/.test(a)) || expansion.dynamicWords.some(Boolean))) return null;
      continue;
    }
    if (cmd === 'find') {
      if (args.some(a => ['-exec', '-execdir', '-ok', '-okdir', '-files0-from'].includes(a))) return null;
      continue;
    }
    if (cmd === 'git') {
      const [sub, ...rest] = gitArguments(args);
      if (sub === 'status' && rest.some(a => /^--v|^-[^-]*v/.test(a))) return null;
      if (sub === 'ls-files' && rest.some(a => a.startsWith('--eo'))) return null;
      if (['status', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'branch', 'remote', 'tag', 'check-ignore', '--version'].includes(sub)) continue;
      return null;
    }
    if (cmd === 'date') {
      if (args.some(a => /^--f|^-[^-]*f/.test(a))) return null;
      continue;
    }
    if (cmd === 'tr') continue; // Operates on stdin; any input redirection or upstream reader is checked separately.
    if (!CONTENT_COMMANDS.has(cmd)) return null;
    if (expansion.dynamicWords.slice(start).some(Boolean) || braces.has(raw)) return null;
    // Recursive diff follows directory links, so its reads can escape the supplied roots.
    if (cmd === 'diff' && args.some(a => /^-[^-]*r/.test(a) || a === '--recursive')) return null;
    if (['sha256sum', 'sha1sum', 'md5sum'].includes(cmd) && args.some(a => a === '--check' || /^-[^-]*c/.test(a))) return null;
    if (cmd === 'dd') {
      for (let i = 0; i < args.length; i++) if (args[i].startsWith('if=')) {
        if (expansion.dynamicWords[start + i + 1] || expansion.patterns[start + i + 1]) return null;
        const p = readPath(args[i].slice(3), cwd);
        if (!p) return null;
        targets.push(p);
      }
      continue;
    }
    const search = ['grep', 'egrep', 'fgrep', 'rg'].includes(cmd);
    if (cmd === 'rg' && args.includes('--files')) {
      if (args.some(a => /^(-[^-]*f|--file(?:=|$)|--ignore-file)/.test(a))) return null;
      continue;
    }
    if (search && args.some(a => a === '--follow' || (cmd === 'rg' ? /^-[^-]*L/.test(a) : /^-[^-]*R/.test(a)))) return null;
    const takes = search ? ['-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-g', '--glob', '--iglob', '-t', '-T', '--type', '--type-not', '--include', '--exclude', '-d', '--directories', '--encoding']
      : ({ awk: ['-F', '-v'], head: ['-n', '-c', '--lines', '--bytes'], tail: ['-n', '-c', '--lines', '--bytes', '--pid', '--sleep-interval'],
        nl: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'], cut: ['-b', '-c', '-d', '-f', '--bytes', '--characters', '--delimiter', '--fields'],
        strings: ['-n', '-t', '-e', '-T', '--bytes', '--radix', '--encoding'], hexdump: ['-n', '-s', '-e', '--length', '--skip', '--format'],
        od: ['-A', '-j', '-N', '-t', '-w', '--address-radix', '--skip-bytes', '--read-bytes', '--format', '--width'],
        sort: ['-k', '-t', '-S', '--key', '--field-separator', '--buffer-size'], uniq: ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'],
        paste: ['-d', '--delimiters'], column: ['-s', '-c', '-N', '-O', '--separator'], iconv: ['-f', '-t', '--from-code', '--to-code'],
        file: ['-e', '-F', '-P', '--exclude', '--separator', '--parameter'], diff: ['-I', '-x', '--ignore-matching-lines', '--exclude'] }[cmd] ?? []);
    const fileOptions = search ? ['-f', '--file', '--exclude-from', '--ignore-file']
      : cmd === 'file' ? ['-f', '-m', '--files-from', '--magic-file']
      : cmd === 'hexdump' ? ['-f', '--format-file']
      : cmd === 'diff' ? ['--from-file', '--to-file', '-X', '--exclude-from'] : [];
    // File lists, scripts and jq file bindings can introduce further unbounded reads.
    if ((['wc', 'sort'].includes(cmd) && args.some(a => a.startsWith('--files0-from'))) ||
        (cmd === 'file' && args.some(a => /^(-f|--files-from)/.test(a))) ||
        (cmd === 'jq' && args.some(a => /^--(?:slurpfile|rawfile|from-file|argfile|run-tests|library-path)(?:=|$)|^-[^-]*[fL]/.test(a)))) return null;
    const parsed = fileArguments(args, takes, fileOptions);
    if (!parsed) return null;
    // awk can replace its input paths through ARGV/ARGC.
    if (cmd === 'awk' && /\b(?:ARGV|ARGC)\b/.test(parsed.operands[0]?.path ?? '')) return null;
    if (cmd === 'jq' && /\b(?:import|include)\b/.test(parsed.operands[0]?.path ?? '')) return null;
    const hasPattern = search && args.some(a => /^(-[ef]|--regexp(?:=|$)|--file(?:=|$))/.test(a));
    if ((search && !hasPattern) || ['sed', 'awk', 'jq'].includes(cmd)) parsed.operands.shift();
    if (cmd === 'ssh-keygen') {
      parsed.files.push(...parsed.operands.splice(0));
      const index = args.findIndex(a => a === '-f' || a === '-lf');
      if (index >= 0) parsed.files.push({ index: index + 1, path: args[index + 1] });
    }
    for (const operand of [...parsed.files, ...parsed.operands]) {
      if (operand.path === '-') continue;
      const index = start + operand.index + 1;
      if (expansion.dynamicWords[index] || expansion.patterns[index]) return null;
      const p = readPath(operand.path, cwd);
      if (!p) return null;
      targets.push(p);
    }
    if (!parsed.operands.length && !expansion.inputs.length && (cmd === 'rg' || (search && args.some(a => /^-[^-]*[rR]|^--recursive$/.test(a))))) {
      if (!cwd) return null;
      targets.push(readPath(cwd));
    }
  }
  return targets;
}

const OBSIDIAN_PATH_KEYS = ['path', 'file_path', 'filePath', 'relative_path', 'relativePath', 'file', 'paths', 'files'];

function frontmatterWrite(exec) {
  if (String(exec?.name ?? '').split('__').at(-1) !== 'obsidian_frontmatter') return false;
  const args = exec.arguments ?? {};
  return ['action', 'operation', 'mode'].some(key => args[key] !== undefined && !/^(read|get)$/i.test(args[key])) ||
    ['content', 'frontmatter', 'data', 'updates', 'value', 'values', 'properties'].some(key => args[key] !== undefined);
}

function obsidianVaultRoot(allow) {
  const roots = new Set();
  for (const entry of allow) {
    const file = readPath(entry);
    if (!file) continue;
    let root = '';
    for (let ancestor = file; ancestor && ancestor !== '.'; ancestor = path.posix.dirname(ancestor)) {
      const native = process.platform === 'win32' ? ancestor : ancestor.replace(/^([a-z]):(?=\/|$)/i, '/mnt/$1');
      try { if (statSync(`${native}/.obsidian`).isDirectory()) { root = ancestor; break; } } catch {}
      if (path.posix.dirname(ancestor) === ancestor) break;
    }
    // A configured rule file under obsidian/study also identifies the vault without a local mount.
    root ||= /^(.*\/obsidian\/study)(?:\/|$)/i.exec(file)?.[1] ?? '';
    if (root) roots.add(root);
  }
  return roots.size === 1 ? [...roots][0] : '';
}

export function plannerReadTargets(exec, cwd = exec?.agent?.session?.header?.cwd, plannerReadAllow = []) {
  const name = String(exec?.name ?? '').split('__').at(-1);
  const args = exec.arguments ?? {};
  if (name === 'obsidian_list') return [];
  if (['obsidian_read', 'obsidian_search', 'obsidian_frontmatter'].includes(name)) {
    if (frontmatterWrite(exec)) return null;
    // No host schema is present: check every supplied alias rather than guessing its precedence.
    const values = OBSIDIAN_PATH_KEYS.filter(key => args[key] !== undefined).map(key => args[key]);
    if (!values.length || values.some(value => Array.isArray(value) && !value.length)) return null;
    const inputs = values.flat(); // An unscoped search may read the entire vault.
    const root = obsidianVaultRoot(plannerReadAllow);
    const targets = inputs.flatMap(input => {
      const files = input && typeof input === 'object' && !Array.isArray(input)
        ? OBSIDIAN_PATH_KEYS.filter(key => input[key] !== undefined).map(key => input[key]) : [input];
      if (!files.length) return [''];
      return files.map(file => readPath(file, root));
    });
    return targets.length && targets.every(Boolean) ? targets : null;
  }
  const ops = name.startsWith('ops_');
  if (ops) cwd = exec?.agent?.session?.header?.cwd;
  const directory = ops ? (name === 'ops_bash' ? args.workdir : undefined) : args.workdir ?? args.cwd;
  if (directory !== undefined) cwd = readPath(directory, cwd);
  if (SHELL_TOOLS[name]) return shellReadTargets(args.command, cwd);
  if (name === 'find_referencing_symbols') return null; // Referencing bodies can come from files outside the supplied path.
  const operation = name.replace(/^wsl-/, '');
  const search = /^(?:ops_)?(?:grep|search|search_files|search_for_pattern|find_symbol|get_symbols_overview)$/.test(operation);
  const reader = /^(?:ops_)?(?:read|read_file|read_files|read_many_files|read_multiple_files|read_image|view_image|read_text_file|read_media_file|inspect_local_file|read_pdf|read_docx|read_table|diff)$/.test(operation);
  if (!search && !reader) return [];
  const input = args.paths ?? args.files ?? args.file_path ?? args.filePath ?? args.relative_path ?? args.path ?? (search ? cwd : undefined);
  const paths = Array.isArray(input) ? input : [input];
  if (!paths.length) return null;
  const targets = paths.map(p => readPath(typeof p === 'object' && p ? p.path ?? p.file_path ?? p.filePath : p, cwd));
  return targets.every(Boolean) ? targets : null;
}

export function createProductReads(cfg, refresh, { now = Date.now, plannerFile = '', refreshTimeoutMs = 3_000 } = {}) {
  const sessions = new Map();
  const limit = 10_000;
  const stateFor = (owner) => {
    let state = sessions.get(owner);
    if (!state) {
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      state = { paths: new Set(), refreshed: -Infinity, pending: null, failed: false };
      sessions.set(owner, state);
    }
    return state;
  };
  const add = (owner, paths) => {
    if (!owner) return;
    const state = stateFor(owner);
    for (const file of paths) {
      const key = readPath(file);
      if (!key) continue;
      try { if (statSync(process.platform === 'win32' ? key : file).isDirectory()) continue; } catch {}
      if (state.paths.size >= limit && !state.paths.has(key)) state.paths.delete(state.paths.values().next().value);
      state.paths.add(key);
    }
  };
  const allowed = (file, state, directories) => {
    if (state?.paths.has(file) || (plannerFile && file === readPath(plannerFile))) return true;
    return [...cfg.plannerReadAllow ?? [], ...directories].some(root => {
      const key = readPath(root);
      if (file === key) return true;
      const native = process.platform === 'win32' ? key : root;
      try { return statSync(native).isDirectory() && under(file, key); } catch { return false; }
    });
  };
  return { add, async check(exec, cwd, directories = []) {
    const targets = plannerReadTargets(exec, cwd, cfg.plannerReadAllow);
    if (targets?.length === 0) return undefined;
    const owner = exec?.agent?.id;
    const state = owner ? stateFor(owner) : undefined;
    if (targets && targets.every(file => allowed(file, state, directories))) return undefined;
    if (targets && state && !state.pending && now() - state.refreshed >= 25_000) {
      state.refreshed = now();
      state.pending = Promise.resolve().then(() => refresh(owner)).then(value => {
        if (value?.status !== 'completed' || value.owner !== owner || !Array.isArray(value.paths) || value.paths.some(p => typeof p !== 'string')) throw new Error('无法确认产物');
        add(owner, value.paths);
        state.failed = false;
      }).catch(() => { state.failed = true; }).finally(() => { state.pending = null; });
    }
    if (targets && state?.pending) {
      let timer;
      try {
        await Promise.race([state.pending, new Promise(resolve => { timer = setTimeout(resolve, refreshTimeoutMs); })]);
      } finally { clearTimeout(timer); }
      if (targets.every(file => allowed(file, state, directories))) return undefined;
      if (state.pending) return `[codex-conductor] 暂时无法确认读取权限，仅同一读取可稍后重试一次，再不行交 Codex。${PRODUCT_DENY_HINT}`;
    }
    if (!targets && String(exec?.name ?? '').split('__').at(-1).startsWith('obsidian_')) {
      return `[codex-conductor] 无法确定 vault 读取范围：需要明确的文件路径；相对路径需由 plannerReadAllow 确定唯一 vault 根，内容搜索不得无范围，frontmatter 只可读取。${PRODUCT_DENY_HINT}`;
    }
    if (targets && state?.failed) return `[codex-conductor] 产物登记恢复失败，该路径未获读取授权。${PRODUCT_DENY_HINT}`;
    // A completed recovery does not make an unrelated raw path a possible product.
    return `[codex-conductor] ${PRODUCT_HINT}`;
  } };
}

// 返回拒绝理由（字符串）或 undefined（放行）。
export function decide(exec, cfg) {
  if (!inWorkspace(exec?.agent?.session?.header?.cwd, cfg.roots)) return undefined;
  const tool = String(exec?.name ?? '');
  if (tool === 'gemini_write' && cfg.gemini) return undefined;
  const deny = (reason) => cfg.plannerReads === 'products' ? `[codex-conductor] ${PRODUCT_DENY_HINT}` :
    `[codex-conductor] 本工作区按「你规划 → Codex 执行 → 你验收」运行，${reason}。${HINT}` +
    (cfg.gemini ? '教程/文档正文可用 gemini_write，一章一章做。' : '');
  if (DENY_TOOLS.has(tool) || cfg.denyTools.has(tool)) return deny(`${tool} 会直接改动文件或执行任意代码，已拒绝`);
  if (frontmatterWrite(exec)) return deny(`${tool} 请求修改 frontmatter，已拒绝`);
  if (tool.startsWith('mcp__') && MCP_WRITE.test(tool.slice(tool.lastIndexOf('__') + 2))) {
    return deny(`${tool} 会改动文件或执行命令，已拒绝`);
  }
  const blocked = SHELL_TOOLS[tool];
  if (!blocked) return undefined;
  const args = exec.arguments ?? {};
  const used = blocked.filter((k) => present(args[k]));
  if (used.length) return deny(`${tool} 带了 ${used.join(' / ')} 参数，已拒绝`);
  if (!readOnlyCommand(args.command, cfg.allowCommands)) {
    return cfg.plannerReads === 'products' ? deny() : deny(`这条命令不在只读核验范围内，${refusedPart(args.command, cfg.allowCommands)}`);
  }
  return undefined;
}
