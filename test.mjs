// node --test test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOnlyCommand, splitCommand, decide, normPath, validateRun, composePrompt, createConductor, apply,
  outOfScope, taskCwd, nextStep, withReport, reviewState, turnSummary, runnerArgv, runProcess, runRunner, PS_SYNTAX } from './index.mjs';

// apply() 会在 %LOCALAPPDATA% 下写加载标记和规划要求模板，测试时改到临时目录
const localAppData = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));
process.env.LOCALAPPDATA = localAppData;
after(() => rmSync(localAppData, { recursive: true, force: true }));

test('entry reload queries re-evaluate workflow, runtime and guard helpers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-reload-'));
  const traceKey = `conductor-reload-${path.basename(dir)}`;
  globalThis[traceKey] = [];
  try {
    writeFileSync(path.join(dir, 'index.mjs'), readFileSync(new URL('./index.mjs', import.meta.url)));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    for (const version of ['old', 'new']) {
      writeFileSync(path.join(dir, 'workflow.mjs'),
        `globalThis[${JSON.stringify(traceKey)}].push('workflow-${version}');\n` +
        'export const validReport = () => true, blockingState = () => ({}), prepareContinuation = () => ({});\n');
      writeFileSync(path.join(dir, 'runtime.mjs'),
        `globalThis[${JSON.stringify(traceKey)}].push('runtime-${version}');\n` +
        'export const runtimeIdentity = () => ({}), registerRuntimeTool = () => {};\n');
      writeFileSync(path.join(dir, 'guard.mjs'),
        `globalThis[${JSON.stringify(traceKey)}].push('guard-${version}');\n` +
        readFileSync(new URL('./guard.mjs', import.meta.url), 'utf8'));
      const entry = pathToFileURL(path.join(dir, 'index.mjs'));
      entry.search = `?reload=${version}`;
      await import(entry.href);
    }
    assert.deepEqual([...globalThis[traceKey]].sort(), ['guard-new', 'guard-old', 'runtime-new', 'runtime-old', 'workflow-new', 'workflow-old']);
  } finally {
    delete globalThis[traceKey];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assignments and loop lists cannot smuggle flags into allowed commands', () => {
  for (const c of ['X=-delete; find . $X', 'X="a -delete"\nfind . $X', 'for f in -delete; do find . $f; done']) {
    assert.equal(readOnlyCommand(c), false, c);
  }
  for (const c of ['D=/mnt/d/x; ls "$D"', 'for f in a.txt b.txt; do wc -l "$f"; done']) {
    assert.equal(readOnlyCommand(c), true, c);
  }
});

test('wsl.exe argv uses the default distro and Codex config unless configured', () => {
  const base = { distro: '', python: 'python3', runner: '/mnt/c/p/runner/codex_runner.py', codexBin: '', codexHome: '', runnerHome: '' };
  assert.deepEqual(runnerArgv(base, ['status', 'J']), ['-e', 'env', 'python3', '/mnt/c/p/runner/codex_runner.py', 'status', 'J']);
  assert.deepEqual(runnerArgv({ ...base, routerCheckUrl: 'http://127.0.0.1:3425/v1' }, ['start']),
    ['-e', 'env', 'CODEX_RUNNER_ROUTER_URL=http://127.0.0.1:3425', 'python3', '/mnt/c/p/runner/codex_runner.py', 'start']);
  assert.deepEqual(runnerArgv({ ...base, codexRoute: { provider: 'gateway', baseUrl: 'http://127.0.0.1:3426/v1' } }, ['start']),
    ['-e', 'env', 'CODEX_RUNNER_ROUTE_PROVIDER=gateway', 'CODEX_RUNNER_ROUTE_URL=http://127.0.0.1:3426/v1',
      'python3', '/mnt/c/p/runner/codex_runner.py', 'start']);
  assert.deepEqual(runnerArgv({ ...base, distro: 'Ubuntu', codexHome: '/home/u/.codex', codexBin: '/home/u/bin/codex' }, ['cancel', 'J']),
    ['-d', 'Ubuntu', '-e', 'env', 'CODEX_HOME=/home/u/.codex', 'CODEX_RUNNER_CMD=["/home/u/bin/codex"]',
      'python3', '/mnt/c/p/runner/codex_runner.py', 'cancel', 'J']);
});

const cfg = { roots: [normPath('F:\\work\\项目')], denyTools: new Set(), allowCommands: [] };
const call = (name, args = {}, cwd = 'F:\\work\\项目\\sub') =>
  ({ name, arguments: args, agent: { session: { header: { cwd } } } });

test('read-only commands pass', () => {
  for (const c of [
    'git status', 'git --no-pager diff --stat', 'git -C /mnt/f/x log --oneline -5', 'git branch --show-current',
    'cd /mnt/f/x && git diff | head -50', 'ls -la; wc -l a.py', "grep -rn 'a|b' src | sort | uniq -c",
    'cat a.txt 2>/dev/null', 'pytest -q tests 2>&1 | tail -20', "sed -n '10,40p' a.py", 'python3 -m pytest -x',
    'find . -name "*.py" -type f', 'sha256sum out.bin', 'npm test', 'npm run test:unit', 'rg foo src',
    'echo "x > y"', 'cat < a.txt',
    "iconv -f GBK -t UTF-8 /tmp/allv.txt 2>/dev/null | grep -nE '失败|FAIL' | head -40\necho \"=== 头部 ===\"\nexit 0",
    'D=/mnt/d/x/proj\ncd "$D" || exit 1\ngit status',
    'cat $(ls)', 'echo "$(git status --short)"',
    // DSH 会话里 DeepSeek 实际写过的核验脚本
    'cd /mnt/d/x/proj || { echo "CD-FAIL"; exit 1; }\necho "=== 目标文件状态 ==="\n' +
      'for f in a/b.conf c/d.ps1; do\n  if [ -e "$f" ]; then\n    printf \'%-60s EXISTS %s bytes\\n\' "$f" "$(wc -c < "$f")"\n' +
      '  else\n    printf \'%-60s ABSENT\\n\' "$f"\n  fi\ndone\nls -la /home/x/jobs/1/ 2>&1 | head -20\nexit 0',
    'while read -r l; do echo "$l"; done < list.txt',
    // 项目验证脚本、timeout 前缀、语法检查
    "timeout 180 /mnt/c/tools/pwsh.exe -NoProfile -File 'D:\\x\\proj\\tests\\Verify-Build.ps1' 2>&1 | tail -20",
    '/mnt/c/tools/pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tests/Run-AllVerifications.ps1 -Verbose',
    'timeout 30 git status', 'timeout -k 5 60s pytest -q', 'bash -n build.sh', 'sh -n a.sh b.sh',
  ]) assert.equal(readOnlyCommand(c), true, c);
});

test('bare no-op and continue keep the read-only boundary', () => {
  for (const command of [
    ':', 'ls missing 2>/dev/null || :',
    'for f in a.txt b.txt; do [ -f "$f" ] || continue; wc -l "$f"; done',
    'while read -r line; do if [ -z "$line" ]; then continue; fi; printf "%s\\n" "$line"; done < list.txt',
    'if test -f input.txt; then :; else cat input.txt; fi',
  ]) {
    assert.equal(readOnlyCommand(command), true, command);
    assert.equal(decide(call('ops_bash', { command }), cfg), undefined, command);
  }
  for (const command of [
    ': arg', 'continue 2', ': done', 'continue fi',
    "':'", "'continue'", 'con""tinue', 'con\\tinue',
    'timeout 1 :', 'timeout 1 continue', 'timeout 1 timeout 2 continue',
    'env continue', 'command continue', '/tmp/continue', '/tmp/:',
    ': > marker', 'continue > marker', ': $(touch marker)', ':; rm -f marker',
    'for f in a; do continue; done; rm -f marker',
  ]) assert.equal(readOnlyCommand(command), false, command);
});

test('command -v looks up names without permitting command execution', () => {
  for (const command of [
    'command -v grep head tail wc cut sort',
    'if command -v rg >/dev/null; then rg needle src; fi',
  ]) {
    assert.equal(readOnlyCommand(command), true, command);
    assert.equal(decide(call('ops_bash', { command }), cfg), undefined, command);
  }
  for (const command of [
    'command touch marker', 'command -p touch marker', 'command -v', 'command -v -p rg',
    'command "$mode" rg', 'command -v "$name"', 'command -v rg*',
    '/tmp/command -v rg', 'timeout 1 command -v rg',
    'command -v "$(touch marker)"', 'command -v rg > marker', 'command -v rg; touch marker',
  ]) assert.equal(readOnlyCommand(command), false, command);
});

test('tar archive listing clears inherited options and accepts only one local literal file', () => {
  const why = (command) => decide(call('ops_bash', { command }), cfg);
  for (const command of [
    'env -u TAR_OPTIONS tar -tzvf archive.tar.gz',
    "env -u TAR_OPTIONS tar -tzvf '/tmp/local archive.tar.gz' 2>/dev/null",
  ]) assert.equal(why(command), undefined, command);
  assert.match(why('tar -tzvf archive.tar.gz'), /env -u TAR_OPTIONS tar -tzvf/);
  for (const command of [
    'env tar -tzvf archive.tar.gz', 'env -u OTHER tar -tzvf archive.tar.gz',
    'env -u TAR_OPTIONS sh -c echo', 'env -u TAR_OPTIONS tar -xzvf archive.tar.gz',
    'env -u TAR_OPTIONS tar -tzvf host:archive.tar.gz', 'env -u TAR_OPTIONS tar -tzvf -',
    'env -u TAR_OPTIONS tar -tzvf "$archive"', 'env -u TAR_OPTIONS tar -tzvf $(printf archive.tar.gz)',
    'env -u TAR_OPTIONS tar -tzvf *.tar.gz', 'env -u TAR_OPTIONS tar -tzvf {a,b}.tar.gz',
    'HOME=example.invalid:dir; env -u TAR_OPTIONS tar -tzvf ~/archive.tar.gz',
    'env -u TAR_OPTIONS tar -tzvf archive.tar.gz --checkpoint-action=exec=echo',
    'timeout 1 env -u TAR_OPTIONS tar -tzvf archive.tar.gz',
    'env -u TAR_OPTIONS tar -tzvf archive.tar.gz > out.txt',
  ]) assert.ok(why(command), command);
});

test('gzip integrity checks pass without allowing compression or decompression', () => {
  const actual = 'R=/mnt/d/harness; gzip -t $R/logs/harness.log.20261108-041557.gz';
  for (const command of [
    actual, 'gzip -t archive.gz', 'gzip --test "archive file.gz"',
    'gzip -t "$R"/logs/*.gz', 'gzip -t < archive.gz', 'timeout 30 gzip -t archive.gz 2>/dev/null',
  ]) assert.equal(readOnlyCommand(command), true, command);
  assert.equal(decide(call('ops_bash', { command: actual }), cfg), undefined);
  for (const command of [
    'gzip file', 'gzip -f file', 'gzip -d archive.gz', 'gzip -- -t file',
    'gzip -S -t file', 'gzip --suffix=-t file', 'gzip "$flag" archive.gz',
    'gzip -t archive.gz > result', 'gzip -t $(touch marker)', 'gzip -t archive.gz && gzip file',
  ]) assert.equal(readOnlyCommand(command), false, command);
});

test('writing or arbitrary commands are refused', () => {
  for (const c of [
    'echo x > a.txt', 'cat a >> b', 'sed -i s/a/b/ f', 'rm -rf x', 'git commit -am x', 'git checkout .',
    'git -c core.pager=sh log', 'git diff --output=x', 'git branch -D main', 'find . -delete', 'find . -exec rm {} ;',
    'python3 -c "open(1)"', 'python3 script.py', 'cat $(rm x)', 'echo "$(touch a)"', 'ls `pwd`',
    'for f in $(rm -rf x); do echo; done', 'if rm x; then echo; fi', '{ rm x; }', 'for f in a; do cp $f b; done',
    'echo $(cat a > b)', 'echo $((1+2))',
    'pwsh -Command "Remove-Item x"', 'pwsh -File 40-runbook/Set-MasterNftables.ps1', 'pwsh -c ls',
    'pwsh -NoProfile -Command x -File tests/a.ps1', 'timeout 30 rm -rf x', 'timeout 30', 'timeout abc ls',
    'bash a.sh', 'bash -c "ls"', 'bash -n -c x', 'sh -n', 'cat <<EOF\nx\nEOF', 'tee a.txt',
    'cp a b', 'mv a b', 'touch a', 'npm install', 'sort -o out in', 'uniq in out', 'rg --pre sh x',
    'cd x && rm y', 'git status; rm -rf /', 'bash -c "ls"', 'xargs rm', 'FOO=1 ls', "echo 'unterminated",
    "awk '{print > \"f\"}' a", 'diff <(ls) b', 'ls | tee out', '', 'iconv -f a -t b in -o out',
    "D=/mnt/d/x\ncd \"$D\" || exit 1\npython3 - <<'PYEOF'\nopen('a','w')\nPYEOF",
    'PWSH=/mnt/c/tools/pwsh.exe\ntimeout 900 "$PWSH" -NoProfile -File x.ps1 > /tmp/al.txt',
    'GIT_EXTERNAL_DIFF=x git diff',
    // 变量当 pwsh 或脚本路径：可以先被赋值成任意命令，展开后按空白切开执行
    "PWSH='sh -c id'; $PWSH -f tests/a.ps1", 'PWSH=bash; "${PWSH}" -NoProfile -File tests/a.ps1',
    "X='usr/bin/env sh -c id;'; /$X/pwsh.exe -File tests/a.ps1", "X='-Command id #'; pwsh -File $X/tests/a.ps1",
    // GNU sed 在打印地址后面仍会接受 -i / -e / -f，以及借转义斜杠藏进地址的 e 命令
    'sed -n 1p -i f', 'sed -n 1p f -i', 'sed -n 1p --in-place=.bak f', 'sed -n 1p -f s.sed f',
    "sed -n 1p -e 'w out' f", "sed -n '1p' -e '1e touch X' f", "sed -n '/a\\/,/e echo X;: /p' f",
    // sed 脚本或文件参数里的变量、命令替换、花括号展开后可以变成 e/w 命令或开关
    'p=1wW; sed -n $p f', 'sed -n "$p" f', 'sed -n "1,$p" f', "v=x; sed -n \"/$v/p\" f", 'sed -n "/$(printf x)/p" f',
    'sed -n 1p {-i,f}', 'sed -n 1p $(printf -- -i) f', "printf -v p '1e touch X'",
    // 算术求值会递归展开变量值里的 a[$(...)]
    'echo $(( cat ))', "cat='a[$(touch X)]'; echo $(( cat ))", "cat='a[$(touch X)]'; [[ cat -eq 0 ]]",
    "printf -v cat 'a[$(touch X)]'; [[ cat -eq 0 ]]",
  ]) assert.equal(readOnlyCommand(c), false, c);
  assert.equal(readOnlyCommand('D=$(pwd); printf "%s\\n" "$D"'), true);
  assert.equal(readOnlyCommand("sed -n '/start/,/end/p' a.txt b.txt"), true);
});

test('guard denials name the part that was refused', () => {
  const why = (command) => decide(call('wsl', { command }), cfg);
  assert.match(why(`git status && ${'ls a; '.repeat(60)}timeout 30 rm -rf x`), /不放行的是「rm -rf x」/);
  assert.match(why(`${'cat a; '.repeat(60)}echo $((1+2))`), /含不放行的结构：[^。]*\$\(\(\.\.\.\)\) 算术/);
  assert.match(why('cat a > b'), /重定向/);
  assert.match(why(''), /命令为空/);
  assert.match(why('rm x'), /pwsh -NoProfile -File '<\.\.\.\\tests\\xxx\.ps1>'/);
});

test('legacy arithmetic expansion cannot evaluate file input, while quoted and escaped text stays literal', () => {
  for (const command of ['read -r expression < payload.txt; echo $[expression]', 'echo "$[expression]"']) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('wsl', { command }), cfg), /\$\[\.\.\.\]/);
  }
  for (const command of ["echo '$[expression]'", String.raw`echo \$[expression]`, String.raw`echo "\$[expression]"`]) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('splitCommand keeps quoted operators inside words', () => {
  assert.deepEqual(splitCommand("grep -E 'a|b;c' x | wc -l"), [['grep', '-E', 'a|b;c', 'x'], ['wc', '-l']]);
  assert.deepEqual(splitCommand('cat "C:\\x\\y" "a\\"b\\\\"'), [['cat', 'C:\\x\\y', 'a"b\\']]);
});

test('quoted escaped and empty-quote words cannot pose as assignments or control syntax', () => {
  for (const word of ['X=1', 'if', 'fi', 'for']) {
    for (const command of [`'${word}'`, `"${word}"`, `\\${word}`, `${word[0]}''${word.slice(1)}`]) {
      assert.equal(readOnlyCommand(command), false, command);
    }
  }
  for (const command of ["X'='1", "'X'=1", String.raw`X\=1`, 'X""=1',
    "'[[' -f /dev/null ]]", '"[[" -f /dev/null ]]', String.raw`\[\[ -f /dev/null ]]`]) {
    assert.equal(readOnlyCommand(command), false, command);
  }
  assert.match(decide(call('wsl', { command: "'X=1'" }), cfg), /不放行的是「[^」]*X=1[^」]*」/);
  assert.match(decide(call('wsl', { command: "'if'" }), cfg), /不放行的是「[^」]*if[^」]*」/);
});

test('timeout program names cannot pose as shell assignments or control syntax', () => {
  for (const prefix of ['timeout 1', 'timeout 1 timeout 1']) {
    for (const program of ['X=1', "'X=1'", 'if', "'if'", 'fi', 'for', '[[ -f /dev/null ]]']) {
      const command = `${prefix} ${program}`;
      assert.equal(readOnlyCommand(command), false, command);
    }
  }
  assert.match(decide(call('wsl', { command: 'timeout 1 if' }), cfg), /不放行的是「[^」]*if[^」]*」/);
  assert.match(decide(call('wsl', { command: 'timeout 1 timeout 1 X=1' }), cfg), /不放行的是「[^」]*X=1[^」]*」/);
});

test('uniq output operands named fi done or closing brace cannot disappear as shell syntax', () => {
  for (const word of ['fi', 'done', '}']) {
    for (const output of [word, `'${word}'`, `"${word}"`]) {
      const command = `uniq /dev/null ${output}`;
      assert.equal(readOnlyCommand(command), false, command);
    }
  }
  assert.match(decide(call('wsl', { command: 'uniq /dev/null done' }), cfg), /不放行的是「uniq \/dev\/null done」/);
});

test('real assignments continuations control syntax and literal arguments stay read-only', () => {
  for (const command of [
    "D='path'; ls \"$D\"", 'X="value"; echo "$X"',
    'X="a\'b"; echo "$X"', 'X=\'a"b\'; echo "$X"', "X=''1; echo \"$X\"",
    'X=\\\n1; echo "$X"', 'ec\\\nho ok', 'timeout 1 \\\ncat /dev/null',
    'for f in a b; do cat "$f"; done', 'if [ -f a ]; then cat a; else echo absent; fi',
    'while read -r line; do echo "$line"; done < /dev/null', '{ echo ok; cat /dev/null; }',
    'timeout 1 cat /dev/null', 'timeout 1 timeout 1 cat /dev/null',
    'echo "if" \'X=1\'', 'grep -F "if" /dev/null', "grep -F 'X=1' /dev/null",
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('quoted and escaped digits before redirections remain command words and file operands', () => {
  for (const command of ["'2'>/dev/null; ls", String.raw`\2>/dev/null; ls`, "uniq /dev/null '2'>/dev/null"]) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('wsl', { command }), cfg), /不放行的是/);
  }
  for (const command of ['cat 2>/dev/null', "cat '2'>/dev/null", String.raw`cat \2>/dev/null`]) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('subshell parentheses delimit read-only commands without allowing arithmetic or writes', () => {
  const why = (command) => decide(call('ops_bash', { command }), cfg);
  const continued = '\\' + '\n';
  for (const command of [
    '(cd "$dir" && ls -la )', 'if (cd /repo; ls ); then echo ok; fi',
    'echo "$( (cd /repo; ls ) )"', '( (cat /dev/null ) )',
    '(cat input.txt >/dev/null )', "(printf '%s' ')' )",
    '( [[ value =~ ^(value)$ ]] )', '( echo $' + '{value#)} )',
    'echo $' + continued + '(ls)',
  ]) assert.equal(why(command), undefined, command);
  for (const command of [
    '(touch marker)', '(echo x)>out.txt', '(cat <(echo ok))',
    '((cat))', '( ((cat)) )', '(' + continued + '(cat))',
    'echo $(' + continued + '(cat))', 'echo $' + continued + '[cat]',
    'echo $' + continued + '(touch marker)', 'cat <' + continued + '(touch marker)',
    "'(' cd /repo ')'", '\\(cd /repo; ls)',
    'ls () { touch marker; }; ls', '(ls () { touch marker; }; ls )',
  ]) assert.ok(why(command), command);
});

test('file descriptor duplication requires a complete numeric target', () => {
  for (const command of [
    'echo text 2>&1', 'echo text >&12 | head -1',
    'command -v grep >&1; head -1 input.txt',
  ]) assert.equal(readOnlyCommand(command), true, command);
  assert.deepEqual(splitCommand('echo text >&12 | head -1'), [['echo', 'text'], ['head', '-1']]);
  for (const command of [
    'echo text >&1marker', 'command -v grep >&1marker',
    'echo text >&1"marker"', 'echo text >&1#marker',
    'echo text >&1$(printf marker)', 'echo text >&1\r',
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('ops_bash', { command }), cfg), /重定向/);
  }
});

test('redirection targets get the same substitution checks as command arguments', () => {
  for (const command of [
    'cat <$(touch${IFS}/tmp/guard-marker)', 'cat <`touch${IFS}/tmp/guard-marker`',
    'cat <"$(touch /tmp/guard-marker)"', 'cat <${target@P}', 'cat <${a[$target]}',
    'cat <$(cat <$(touch${IFS}/tmp/guard-marker))', 'cat <', 'cat <; ls',
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('wsl', { command }), cfg), /已拒绝|不在只读核验范围/);
  }
  for (const command of [
    'cat < input.txt', 'cat < "input file.txt"', 'cat < "$file"', 'cat < "${file}"',
    'cat <$(printf input.txt)', "cat < '$(literal)'", 'cat < input.txt 2>/dev/null',
    'cat < input.txt > /dev/null', 'cat >"/dev/null" <input.txt',
  ]) assert.equal(readOnlyCommand(command), true, command);
  assert.deepEqual(splitCommand('cat < "input file.txt" 2>/dev/null'), [['cat']]);
});

test('unquoted brace expansion cannot generate filtered flags, but quoted braces stay literal', () => {
  for (const command of [
    'find . -{delete,print}', 'find . {-delete,-print}', 'find . -{de""lete,print}',
    'find . -{delete,{print,ls}}', 'git diff --{output=out,stat}',
    'sort -{o,n} out input', 'iconv -{o,c}out input',
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('wsl', { command }), cfg), /不放行的是/);
  }
  for (const command of [
    "find . -name '{a,b}'", 'find . -name "{a,b}"', String.raw`find . -name \{a,b\}`,
    "rg 'a{2,3}' src", 'rg a{2} src', 'cat src/{a,b}.txt', 'echo {a..z}',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('unquoted globs cannot generate filtered options, while fixed paths and literal patterns stay read-only', () => {
  for (const command of [
    'find . -[d]elete', 'find . [-]delete', 'find . *', 'git diff --ext-*', 'sort -* input',
    'file -[C] -m ./magic', 'date -[s] @0',
  ]) assert.equal(readOnlyCommand(command), false, command);
  for (const command of [
    'find ./-[d]elete -type f', 'find src/* -type f', 'find . -name "-[d]elete"',
    "find . -name '-[d]elete'", String.raw`find . -name -\[d\]elete`,
    'git diff src/*.mjs', 'sort ./-*.txt', 'file ./-[C]',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('file compilation and date setting are refused without treating option values as flags', () => {
  for (const command of [
    'file -C -m ./magic', 'file -bC -m ./magic', 'file --compile -m ./magic', 'file --comp -m ./magic',
    'file -m ./magic -C', 'file "$flag"', 'file -{b,C} -m ./magic',
    'date -s @0', 'date -us@0', 'date --set=@0', 'date --se @0', 'date --s=@0',
    'date "$flag"', 'date -{u,s} @0', 'date 010112002026', 'date -u -- 010112002026',
  ]) assert.equal(readOnlyCommand(command), false, command);
  for (const command of [
    'file -b README.md', 'file --mime-type README.md', 'file -mC README.md', 'file -bmC README.md',
    'file -m -C README.md', 'file --magic-file -C README.md', 'file --magic-f -C README.md', 'file -- -C',
    'date', 'date -u +%s', 'date -Ins', 'date -d @0', 'date -ud@0', 'date --date=@0',
    'date -f -s', 'date --dat -s', 'date --reference -s', 'date --rfc-3339 seconds', 'date -- +%s',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('git external diff and textconv abbreviations are refused while text output stays read-only', () => {
  for (const flag of ['--ext', '--ext-', '--ext-d', '--ext-di', '--ext-dif', '--ext-diff',
    '--textc', '--textco', '--textcon', '--textconv']) {
    for (const command of [`git diff ${flag}`, `git diff --no-index ${flag} a b`]) {
      assert.equal(readOnlyCommand(command), false, command);
    }
  }
  for (const command of ['git diff --text', 'git diff --no-index --text a b',
    'git diff --exit-code', 'git diff --no-ext-diff --no-textconv']) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('iconv rejects attached output paths without rejecting attached encoding arguments', () => {
  for (const command of [
    'iconv -o/tmp/guard-marker input.txt', 'iconv -co/tmp/guard-marker input.txt',
    'iconv -f UTF-8 -t UTF-8 -o/tmp/guard-marker input.txt',
  ]) assert.equal(readOnlyCommand(command), false, command);
  for (const flag of ['--o', '--ou', '--out', '--outp', '--outpu', '--output']) {
    for (const command of [`iconv ${flag}=/dev/null input.txt`, `iconv ${flag} /dev/null input.txt`]) {
      assert.equal(readOnlyCommand(command), false, command);
    }
  }
  for (const command of ['iconv -fUTF-8 -tUTF-16 input.txt', 'iconv -cs -f UTF-8 input.txt', 'iconv -- input.txt']) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('extra allowCommands extend the list', () => {
  assert.equal(readOnlyCommand('./verify.sh --check', [/^\.\/verify\.sh --check$/]), true);
});

test('filtered arguments cannot hide flags in command substitutions', () => {
  for (const c of [
    'find . $(echo -delete)', "find . $(echo -exec) sh -c 'id' \\;",
    'git diff $(echo --output=pwned)', 'sort $(echo -o pwned) f',
    'uniq $(echo input output)', 'iconv $(echo -o out) in', 'rg $(echo --pre=sh) x',
    'tree $(echo -o out)', 'printf $(echo -v) target value',
    'node --check $(echo --eval=code)', 'go test $(echo -exec=sh) ./...',
    'cargo test $(echo --config=runner)', 'make test $(echo --eval=code)',
    'npm test $(echo --script-shell=sh)', 'pnpm test $(echo --script-shell=sh)',
    'yarn test $(echo --use=code)',
  ]) assert.equal(readOnlyCommand(c), false, c);
  for (const c of ['cat $(ls)', 'printf "%s\\n" "$f" "$(wc -c < f)"', 'printf -- "$(echo -v)"']) {
    assert.equal(readOnlyCommand(c), true, c);
  }
});

test('verification commands refuse caller-selected programs and sort sources', () => {
  for (const c of [
    'git grep --open-files-in-pager=vi x', 'git grep -Ovi x', 'git grep -nOvi x',
    'git grep --open-files=vi x', 'git grep --open-files-in=vi x',
    'git grep --no-index -Ovi x /etc/passwd',
    'go test -exec sh ./...', 'go test -exec=sh ./...', 'go test --exec=sh ./...',
    'go test -toolexec=sh ./...', 'go vet -vettool=/bin/sh ./...', 'go vet --vettool /bin/sh ./...',
    'sort --compress-program=sh f', 'sort --compress-program sh f', 'sort --random-source=f f',
    'sort --compress-prog=sh f', 'sort --random-s=f f', 'sort --out=out f',
  ]) assert.equal(readOnlyCommand(c), false, c);
  for (const c of ['git grep -n x', 'git grep -eFOO', 'git grep -neFOO', 'git log -Oorderfile',
    'go test ./...', 'go vet ./...', 'sort -nr f', 'sort -- f', 'sort -']) {
    assert.equal(readOnlyCommand(c), true, c);
  }
});

test('multiple sed print expressions and read-only git forms pass without enabling writes', () => {
  for (const c of [
    "sed -n '1,5p;20,25p' f", "sed -n ' 1p ; /start/,/end/p; ' f",
    "sed -n '/a;b/p' f", "sed -n '/a;b/p;20p' f",
    'git config --get user.name', 'git config -l', 'git config --list',
    'git remote', 'git remote -v', 'git remote --verbose',
    'git tag -l', 'git tag --list v1', 'git stash list',
  ]) assert.equal(readOnlyCommand(c), true, c);
  for (const c of [
    "sed -n '1p;2w out' f", "sed -n '1p;2e id' f", "sed -n '1p;;2p' f",
    'git config user.name changed', 'git config --get user.name --edit', 'git config -l --add user.name x',
    'git remote add other example.com', 'git remote -v add other example.com',
    'git tag new-tag', 'git tag -l -d old-tag', 'git stash drop', 'git stash list --output=out',
  ]) assert.equal(readOnlyCommand(c), false, c);
});

test('arithmetic comparisons in [ ] / [[ ]] / test need literal-integer operands, so a planted value is never evaluated', () => {
  for (const c of [
    // 操作数的运行时值会被算术求值；$(cat f)、read 进来的 $v、循环变量 $f 都可能夹带 $(...)
    '[[ $(cat f.txt) -eq 0 ]]', 'read -r v < f.txt; [[ $v -eq 0 ]]', 'for f in *; do [[ $f -eq 1 ]]; done',
    'test $(cat f) -eq 1', '[ $(grep -c x f) -gt 0 ]', '[[ $x -ne 5 ]]', '[ "$n" -le 10 ]',
    'if [[ $(cat f) -eq 0 ]]; then echo x; fi', '[[ ${arr[0]} -eq 0 ]]',
  ]) assert.equal(readOnlyCommand(c), false, c);
  for (const c of [
    // 字面整数、恒为整数的 $?/$#，以及不触发算术求值的文件测试和字符串比较照常放行
    '[[ 1 -eq 1 ]]', '[ 3 -gt 2 ]', 'test 0 -eq 0', '[ -5 -lt 0 ]', '[ $? -eq 0 ]', '[[ $# -gt 0 ]]',
    'pytest -q && [ $? -eq 0 ]', '[ -f foo ]', '[[ -n "$x" ]]', '[ "$a" = "$b" ]', '[[ "$x" == pat* ]]',
    'test -d src', 'if [ -e a.txt ]; then cat a.txt; fi',
  ]) assert.equal(readOnlyCommand(c), true, c);
});

test('quoted and escaped parameter syntax stays literal during read-only checks', () => {
  for (const command of [
    "printf '%s\\n' '${VALUE' | grep -F -- '${VALUE'",
    "grep -n '^if \\[ \"\\${VALUE' script.sh",
    "grep -F -- '${value@P}' script.sh",
    "grep -F -- \"\\${VALUE\" script.sh",
    "grep -F -- \\${VALUE script.sh",
    "cat < '${VALUE'",
    "echo '${array[$index]}'",
  ]) assert.equal(readOnlyCommand(command), true, command);
  for (const command of [
    "grep -F -- \"${value@P}\" script.sh",
    "grep -F -- \"\\\\${value@P}\" script.sh",
    "grep -F -- \\\\${value@P} script.sh",
    "cat < \"\\\\${value@P}\"",
  ]) assert.equal(readOnlyCommand(command), false, command);
});

test('${...} arithmetic positions (array subscript, substring offset, indirect) cannot evaluate planted values', () => {
  for (const c of [
    // 下标被当算术表达式求值：变量名、$变量、折叠后的 $X（来自 $(cat f)）都可能夹带 $(...)
    'echo "${a[$y]}"', 'echo "${a[y]}"', 'cat "${a[$(cat f)]}"', 'read -r y < f; echo "${a[$y]}"',
    'echo "${z:$y}"', 'echo "${z:0:$y}"', 'echo "${!y}"', 'ls "${arr[$i]}"',
    'echo "${a[${b}]}"', 'v=${a[$y]}', 'for k in "${a[$y]}"; do echo "$k"; done',
  ]) assert.equal(readOnlyCommand(c), false, c);
  for (const c of [
    // 普通展开、默认值、长度、删减、替换、大小写、字面整数下标/偏移、整组 @ / * 照常放行
    'echo "${x}"', 'cat "${f}"', 'grep "${pat}" file', 'echo "${x:-default}" "${y:=d}" "${z:?msg}" "${w:+v}"',
    'echo "${#arr[@]}" "${#s}"', 'printf "%s\\n" "${arr[@]}" "${arr[*]}" "${arr[0]}"', 'echo "${sha:0:8}"',
    'echo "${p##*/}" "${p%/*}" "${name/foo/bar}" "${u^^}"', 'echo "${1}" "${@}" "${*}"', 'echo "${v: -3}"',
  ]) assert.equal(readOnlyCommand(c), true, c);
});

test('the ${var@P} transform and -v array-subscript operands cannot smuggle command substitution past the guard', () => {
  for (const c of [
    // @P 对变量值做提示符展开并执行其中的 $(...)；其余 @ 变换一并 err-closed
    'echo "${x@P}"', 'read -r v < report.txt; echo "${v@P}"', 'printf "%s" "${x@P}"', 'echo "${x@A}"', 'echo "${x@a}"',
    // -v / test 的 name[下标] 操作数会算术求值；单引号挡不住
    "[[ -v 'a[$(touch X)]' ]]", "[ -v 'a[$(touch X)]' ]", "test -v 'a[$(touch X)]'", "[[ -v 'a[$y]' ]]", "[[ -R 'a[$(id)]' ]]",
    // read 把输入赋给 name[下标] 目标，同样算术求值下标
    "read 'a[$(touch X)]'", "read -r 'a[$(touch X)]' < f", "read 'a[$y]'", "echo x | read 'arr[$(id)]'",
  ]) assert.equal(readOnlyCommand(c), false, c);
  for (const c of [
    // 整组/位置参数、字面整数下标、普通 -v 变量名、字面下标文件测试照常放行
    'echo "${@}" "${*}" "${arr[@]}"', '[[ -v arr[0] ]]', '[[ -v name ]]', '[ -v PATH ]', "[ -f 'a[0]' ]", '[[ -n "${x}" ]]',
    // 普通 read；=~ 正则、== 通配、文件测试里的字符类 name[..] 不做算术求值，照常放行（真有 $(...) 由 splitCommand 拦）
    'read -r line', 'read -r a b c', "read 'a[0]'", '[[ $x =~ foo[0-9] ]]', '[[ $f == backup[0-9] ]]', '[ -f a[0-9] ]', '[[ "$line" == "cfg[key]" ]]',
  ]) assert.equal(readOnlyCommand(c), true, c);
});

test('variable tests and read destinations must be literal while read prompts may expand', () => {
  for (const command of [
    'read -r target < report.txt; [[ -v $target ]]', '[[ -R "${target}" ]]',
    'test -v $(cat report.txt)', '[ -v "$target" ]',
    'read -r target < report.txt; echo x | read "$target"',
    'read -r -- "$target"', 'read -a "$target"', 'read -ra"$target"',
  ]) assert.equal(readOnlyCommand(command), false, command);
  for (const command of [
    '[[ -v arr[0] ]]', '[[ -R name ]]', "read -r 'arr[0]'", 'read', 'read -- line',
    'read -r -p "$prompt" line', 'read -rp "$prompt" line', 'read -p"$prompt" line',
    "read -r -p 'name[$x]' line", 'read -d : -n 3 -t 2 -u 0 line',
    'read -e -i "$initial" line', 'read -ra values', 'read -a values line',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('shell syntax checks cannot restore execution with +n or expanded options', () => {
  for (const command of [
    "printf 'printf EXECUTED' | bash -n +n /dev/stdin", 'sh -n +n script.sh',
    'bash -n "+n" script.sh', 'bash -n $(printf -- +n) script.sh',
    'sh -n "$options" script.sh', 'bash -n ${options} script.sh',
    'bash -n {+n,script.sh}', 'bash -n scripts/*.sh',
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
    assert.match(decide(call('wsl', { command }), cfg), /不放行的是/);
  }
  for (const command of [
    'bash -n build.sh', 'sh -n a.sh b.sh', "bash -n 'script with spaces.sh'",
    'timeout 30 bash -n build.sh', "bash -n 'file[0].sh'", String.raw`sh -n file\*.sh`,
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('test and [ need static predicate operators but retain quoted variable operands', () => {
  for (const command of [
    "read 'a[0]' < /etc/hostname; test \"$(printf -- -v)\" 'a[$(printf DYNAMIC_TEST >&2)0]'",
    'test "$op" "$target"', '[ "${op}" "$target" ]', 'test "$a" "$op" "$b"',
    'test ! "$op" "$target"', 'test -n x -a "$op" "$target"',
    "[ -[v] 'a[$(printf DYNAMIC_TEST >&2)0]' ]", 'test -{v,n} name',
    'test -n $value', '[ -f $(cat filename.txt) ]', 'test "$@"', 'test "${values[@]}"',
    'test -f *', '[ -n ? ]',
  ]) assert.equal(readOnlyCommand(command), false, command);
  for (const command of [
    'test -f "$file"', '[ -d "${dir}" ]', '[ -e "$file" ]', 'test -n "$text"',
    '[ "$a" = "$b" ]', '[ "$a" != "$b" ]', 'test "$a" -nt "$b"',
    'test ! -f "$file"', '[ ! -n "$text" ]', 'test -f "$file" -a -r "$file"',
    'test -z "$a" -o -n "$b"', 'test "$text"', '[ ]', 'test',
    'test -v name', "[ -v 'arr[0]' ]", '[ $? -eq 0 ]', '[ $# -gt 0 ]',
    '[ -f "$(printf filename.txt)" ]', '[ -f a[0-9] ]',
    "test '$@'", "test '${values[@]}'", 'test -n "$*"',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('uniq cannot turn expansion or file operands into an output argument', () => {
  for (const command of ['uniq runner/*.py', 'uniq runner/?.py', 'uniq runner/[ct]*.py', 'uniq -c runner/*.py',
    'uniq - output.txt', 'uniq -- -input -output']) {
    assert.equal(readOnlyCommand(command), false, command);
  }
  for (const command of ['uniq input.txt', 'uniq -c input.txt', 'uniq', "uniq 'runner/*.py'",
    'uniq "runner/[ct]*.py"', String.raw`uniq runner/\*.py`, 'uniq /dev/null', 'uniq -', 'uniq -- -input',
    'uniq input.txt -', 'uniq - -', 'uniq -- -input -']) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('tree rejects output options inside short-option clusters', () => {
  for (const command of ['tree -ao /dev/null -L 1 tools', 'tree -nao out.txt tools', 'tree -o out.txt tools']) {
    assert.equal(readOnlyCommand(command), false, command);
  }
  for (const command of ['tree -a -L 2 tools', 'tree --sort=name tools', "tree -P '*.mjs' tools", 'tree -df tools']) {
    assert.equal(readOnlyCommand(command), true, command);
  }
});

test('guard regressions match Bash semantics using only printed markers and /dev/null', (t) => {
  const executable = process.platform === 'win32' ? 'wsl.exe' : 'bash';
  const prefix = process.platform === 'win32' ? ['-e', 'bash'] : [];
  const bash = (script) => spawnSync(executable, [...prefix, '--noprofile', '--norc', '-c', script],
    { encoding: 'utf8', timeout: 10_000 });
  const available = bash('exit 0');
  if (available.error || available.status !== 0) return t.skip('Bash/WSL unavailable');
  const literal = bash("printf '%s\\n' '${VALUE' | grep -F -- '${VALUE'");
  assert.equal(literal.status, 0, literal.stderr);
  assert.equal(literal.stdout, '${VALUE\n');
  const shell = bash("printf 'printf EXECUTED' | bash -n +n /dev/stdin; printf 'printf UNEXPECTED' | bash -n /dev/stdin");
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, 'EXECUTED');
  const dynamic = bash("read 'a[0]' < /etc/hostname; test \"$(printf -- -v)\" 'a[$(printf DYNAMIC_TEST >&2)0]'");
  assert.equal(dynamic.status, 0, dynamic.stderr);
  assert.equal(dynamic.stderr, 'DYNAMIC_TEST');
  const glob = bash("printf '<%s>\\n' runner/*.py; uniq /dev/null /dev/null");
  assert.equal(glob.status, 0, glob.stderr);
  assert.equal(glob.stdout, '<runner/codex_runner.py>\n<runner/test_codex_runner.py>\n');
  const tree = bash('command -v tree >/dev/null || exit 77; tree -ao /dev/null -L 1 tools');
  if (tree.status === 77) t.diagnostic('tree unavailable; classification tests still run');
  else {
    assert.equal(tree.status, 0, tree.stderr);
    assert.equal(tree.stdout, '');
  }
});

test('an invalid allowCommands pattern leaves the tools and guard installed', () => {
  const tools = [];
  const guards = [];
  const warnings = [];
  apply({ tools: { register: (t) => tools.push(t), guard: (g) => guards.push(g) }, on: () => {},
    logger: { warn: (s) => warnings.push(s) } },
  { workspaces: ['F:\\work\\项目'], allowCommands: ['[', '^\\./verify\\.sh --check$'] });
  assert.equal(tools.length, 10);
  assert.equal(guards.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /allowCommands/);
  assert.match(guards[0](call('edit')), /已拒绝/);
  assert.match(guards[0](call('wsl', { command: 'rm x' })), /不放行的是「rm x」/);
  assert.equal(guards[0](call('wsl', { command: './verify.sh --check' })), undefined);
});

test('guard denies writes only inside configured workspaces', () => {
  assert.match(decide(call('write', { path: 'a' }), cfg), /codex_run/);
  assert.match(decide(call('wsl-edit'), cfg), /已拒绝/);
  assert.match(decide(call('mcp__serena__replace_content'), cfg), /已拒绝/);
  assert.match(decide(call('mcp__serena__insert_after_symbol'), cfg), /已拒绝/);
  assert.equal(decide(call('mcp__serena__find_symbol'), cfg), undefined);
  assert.equal(decide(call('read', { path: 'a' }), cfg), undefined);
  assert.equal(decide(call('todo_write'), cfg), undefined);
  assert.equal(decide(call('codex_run', { task: 'x' }), cfg), undefined);
  assert.equal(decide(call('wsl', { command: 'git status' }), cfg), undefined);
  assert.match(decide(call('wsl', { command: 'git status', stdin: 'x' }), cfg), /stdin/);
  assert.equal(decide(call('wsl', { command: 'git status', env: {} }), cfg), undefined);
  assert.match(decide(call('wsl', { command: 'rm a' }), cfg), /只读核验范围/);
  assert.match(decide(call('ops_bash', { command: 'ls', script_path: 'a.sh' }), cfg), /script_path/);
  assert.match(decide(call('pwsh', { command: 'ls' }), cfg), /已拒绝/);
  assert.match(decide(call('subagent_codex', { prompt: 'x' }), cfg), /已拒绝/);
  // 范围外：同一盘符的其他目录、/mnt 形式的范围内路径、没有会话
  assert.equal(decide(call('write', {}, 'F:\\work\\other'), cfg), undefined);
  assert.equal(decide(call('write', {}, 'F:\\work\\项目-old'), cfg), undefined);
  assert.match(decide(call('write', {}, '/mnt/f/work/项目'), cfg), /已拒绝/);
  assert.equal(decide({ name: 'write', arguments: {} }, cfg), undefined);
});

test('guard blocks Seep arbitrary r2 commands while preserving structured queries and workspace boundaries', () => {
  const everywhere = { ...cfg, roots: ['*'] };
  for (const namespace of ['mcp__seep_reverse_lab__', 'mcp__seep-reverse-lab__']) {
    const tool = `${namespace}seep_r2_cmd`;
    for (const command of ['!printf GUARD_MARKER', 'afl']) {
      const args = { binary_path: '/fixture/sample', command };
      assert.match(decide(call(tool, args), cfg), /会改动文件或执行命令，已拒绝/, `${tool}: ${command}`);
      assert.equal(decide(call(tool, args, 'F:\\work\\other'), cfg), undefined);
      assert.match(decide(call(tool, args, 'F:\\work\\other'), everywhere), /已拒绝/, `${tool}: ${command}`);
    }
    for (const query of ['seep_r2_info', 'seep_status']) {
      assert.equal(decide(call(`${namespace}${query}`), cfg), undefined);
      assert.equal(decide(call(`${namespace}${query}`), everywhere), undefined);
    }
  }
});

test('codex_run validation requires acceptance criteria', () => {
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常' }), /acceptance/);
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: [] }), /acceptance/);
  for (const acceptance of ['不是数组', [1], ['太短']]) {
    assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance, write: false }), /acceptance/);
  }
  assert.throws(() => validateRun({ task: 'short', acceptance: ['pytest 全部通过'] }), /task/);
  validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest tests/test_login.py 全部通过'], write: true });
  // write 必须明说：不传或传成字符串都拒绝，免得默认只读白跑一轮
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest tests/test_login.py 全部通过'] }), /write/);
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest tests/test_login.py 全部通过'], write: 'true' }), /write/);
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest 通过'], write: false, scope: [''] }), /scope/);
  const writable = { task: '将结果保存到指定的 E 盘目录', acceptance: ['目标文件写入成功'], write: true };
  assert.throws(() => validateRun({ ...writable, writable_roots: [''] }), /writable_roots/);
  assert.throws(() => validateRun({ ...writable, writable_roots: 'E:\\results' }), /writable_roots/);
  assert.throws(() => validateRun({ ...writable, write: false, writable_roots: ['E:\\results'] }), /write=true/);
  validateRun({ ...writable, writable_roots: ['E:\\results'] });
  const prompt = composePrompt('做事情做事情', ['甲条件成立'], ['src/a.py', 'tests/']);
  assert.match(prompt, /## 验收标准[\s\S]*1\. 甲条件成立[\s\S]*## 执行约束[\s\S]*只允许改动这些路径：src\/a\.py、tests\/[\s\S]*blocked[\s\S]*## 最后汇报[\s\S]*JSON/);
  assert.doesNotMatch(composePrompt('做事情做事情', ['甲条件成立']), /只允许改动/);
  assert.match(prompt, /Windows 路径优先写成 D:\/docs\/log\.txt[\s\S]*反斜杠时按 JSON 转义/);
  assert.match(prompt, /单独的结论行）写进 summary 即算满足[\s\S]*不要因此标 blocked/);
});

test('scope check flags changes outside the allowed paths', () => {
  const crossed = { files_changed: [{ path: '../../../c/tmp/step.ps1' }, { path: '../../../c/tmp/other.ps1' }] };
  assert.deepEqual(outOfScope(crossed, '/mnt/e/lab/project', ['C:/tmp/step.ps1']), ['../../../c/tmp/other.ps1']);
  const value = { files_changed: [{ path: 'src/a.py' }, { path: 'tests/t.py' }, { path: 'README.md' }] };
  assert.deepEqual(outOfScope(value, 'F:\\proj', ['src/a.py', 'F:\\proj\\tests']), ['README.md']);
  assert.deepEqual(outOfScope(value, '/mnt/f/proj', ['src', 'tests/']), ['README.md']);
  assert.equal(outOfScope(value, 'F:\\proj', undefined), undefined);
  assert.equal(outOfScope({}, 'F:\\proj', ['src']), undefined);
});

test('native Linux paths keep case for scope, workspace guards and default task directories', () => {
  const cwd = '/home/user/project';
  assert.notEqual(normPath(`${cwd}/Src`), normPath(`${cwd}/src`));
  assert.equal(normPath(String.raw`C:\Work\Project`), normPath('/mnt/c/work/project'));
  assert.equal(normPath(String.raw`\\SERVER\Share\Project`), normPath(String.raw`\\server\share\project`));
  assert.deepEqual(outOfScope({ files_changed: [{ path: 'src/a.js' }, { path: 'Src/b.js' }] }, cwd, ['Src']), ['src/a.js']);
  assert.deepEqual(outOfScope({ files_changed: [{ path: 'src/a.js' }] }, String.raw`C:\Project`, [String.raw`C:\Project\SRC`]), []);
  const linux = { ...cfg, roots: [normPath('/home/user/Project')] };
  assert.equal(decide(call('write', {}, cwd), linux), undefined);
  assert.match(decide(call('write', {}, '/home/user/Project/sub'), linux), /已拒绝/);
  const workspaces = [{ root: normPath('/home/user/Project'), cwd: '/home/user/other' }];
  assert.equal(taskCwd({}, cwd, workspaces), cwd);
  assert.equal(taskCwd({}, '/home/user/Project/sub', workspaces), '/home/user/other');
});

test('Linux root workspaces and scopes preserve the guard for the root and its descendants', () => {
  for (const root of ['/', '///', '/tmp/..']) assert.equal(normPath(root), '/');
  assert.equal(normPath('C:/'), 'c:');
  const guards = [];
  apply({ tools: { register: () => {}, guard: (g) => guards.push(g) }, on: () => {} }, { workspaces: ['/'] });
  assert.equal(guards.length, 1);
  for (const cwd of ['/', '/tmp/project']) {
    assert.match(guards[0](call('edit', {}, cwd)), /已拒绝/);
    assert.equal(guards[0](call('wsl', { command: 'git status' }, cwd)), undefined);
  }
  assert.equal(guards[0](call('edit', {}, 'C:/project')), undefined);
  assert.equal(guards[0]({ name: 'edit' }), undefined);
  const value = { files_changed: [{ path: 'src/a.js' }, { path: '/etc/config' }, { path: 'C:/outside.txt' }] };
  assert.deepEqual(outOfScope(value, '/tmp/project', ['/']), ['C:/outside.txt']);
  assert.deepEqual(outOfScope(value, '/', ['.']), ['C:/outside.txt']);
});

test('report is surfaced and self-reported problems are flagged first', () => {
  const report = { summary: 's', criteria: [{ criterion: 'A', status: 'met', evidence: 'e' },
    { criterion: 'B', status: 'blocked', evidence: '冲突' }], files_changed: ['a'], deviations: ['归档与要求冲突'], unresolved: [] };
  const value = withReport({ status: 'completed', thread_id: 'T', structured: report });
  assert.equal(value.report, report);
  assert.equal(value.structured, undefined);
  const next = nextStep({ ...value, out_of_scope: ['README.md'] }, ['A', 'B']);
  assert.match(next, /报告或任务状态仍需核对/);
  assert.match(next, /范围外改动待核实：README\.md[\s\S]*其他进程写的文件/);
  assert.doesNotMatch(next, /resume=|write=true|host_access=true/);
  // 缺报告时先检查，不因存在旧线程直接续接。
  const ro = { status: 'completed', sandbox: 'read-only', thread_id: 'W' };
  assert.match(nextStep(ro, ['A'], true), /先读完整报告和实际状态/);
  assert.match(nextStep(ro, ['A']), /先读完整报告和实际状态/);
  for (const n of [nextStep(ro, ['A'], false), nextStep({ ...ro, thread_id: null }, ['A'])]) {
    assert.doesNotMatch(n, /resume="/);
    assert.match(n, /先读完整报告和实际状态/);
  }
  assert.match(nextStep({ ...ro, status: 'failed', retryable: true }, [], false), /不要带 resume/);
  assert.match(nextStep({ ...ro, status: 'failed', retryable: true }, [], true), /有 thread_id 时带 resume/);
  assert.doesNotMatch(nextStep(withReport({ status: 'completed', thread_id: 'T' }), ['A']), /自报/);
  assert.match(nextStep({ status: 'completed', sandbox: 'danger-full-access', thread_id: 'H' }, ['A']), /先读完整报告和实际状态/);
  assert.doesNotMatch(next, /host_access/);
  // Codex 没按 JSON 汇报：按完成处理，不当成失败
  const loose = withReport({ status: 'failed', error_kind: 'schema_invalid', error: 'x', retryable: false, final_message: 'done' });
  assert.equal(loose.status, 'completed');
  assert.match(loose.report_note, /JSON/);
});

test('reports requiring inspection keep original acceptance and tell the planner to record review evidence', () => {
  const acceptance = ['原 CSV 格式仍能解析', '现有数据和文件格式保持不变'];
  const context = { acceptance };
  const invalid = withReport({ status: 'failed', error_kind: 'schema_invalid', final_message: '原始答复', context,
    error: 'Final message is not valid JSON: Invalid \\escape (line 1, column 17)' });
  assert.match(invalid.report_note, /JSON 解析错误：Invalid \\escape \(line 1, column 17\)/);
  assert.equal(invalid.final_message, '原始答复');
  const first = nextStep(invalid);
  assert.match(first, /先读完整报告和实际状态[\s\S]*核验后用 codex_review/);
  assert.match(first, /原验收标准：\n1\. 原 CSV 格式仍能解析\n2\. 现有数据和文件格式保持不变/);

  const structured = { summary: '执行结束',
    criteria: acceptance.map((_, i) => ({ criterion: `${i + 1}. 自报简述`, status: 'met', evidence: '证据' })),
    files_changed: [], deviations: [], unresolved: ['未验证的边界'] };
  const pending = withReport({ status: 'completed', structured, context });
  assert.equal(pending.blocking.next_action, 'inspect_report');
  assert.match(nextStep(pending), /边界说明本身不自动增加补做要求[\s\S]*核验后用 codex_review/);
  assert.doesNotMatch(nextStep(pending), /原验收标准：/);
});

test('mixed blockers tell the planner to gather both answers and environment evidence before continuation', () => {
  const source = workflowSource('task_conflict');
  source.structured.blockers.push({ id: 'service', kind: 'environment', message: '服务未响应',
    question: '', resolution: '健康检查返回 HTTP 200' });
  const value = withReport(source);
  assert.equal(value.blocking.next_action, 'ask_user');
  assert.match(nextStep(value), /取得回答且条件已满足后[\s\S]*codex_continue 同时提交 answers 和 resolution[\s\S]*具体证据[\s\S]*format: 是否保留旧 CSV 格式？/);
});

test('typed blockers drive questions, environment evidence and continuation without expanding permissions', () => {
  const rep = (...criteria) => ({ summary: 's', criteria: criteria.map(([criterion, status, evidence]) => ({ criterion, status, evidence })),
    files_changed: [], deviations: [], unresolved: [] });
  const ro = { status: 'completed', sandbox: 'read-only', report: rep(['A', 'blocked', '只读沙箱里不能写备份']) };
  for (const evidence of ['pwsh.exe 无法执行', 'WSL Interop 被挡住', 'Hyper-V cmdlet 不可用']) {
    const value = { ...ro, report: rep(['A', 'blocked', evidence]) };
    assert.match(nextStep(value, ['A']), /先读完整报告和实际状态/);
    assert.doesNotMatch(nextStep(value, ['A']), /write=true|host_access=true|resume=/);
  }
  for (const kind of ['user_input', 'task_conflict', 'environment', 'implementation']) {
    const blockers = [{ id: 'choice', kind, message: '待处理事项', question: '请确认保留哪个格式？', resolution: '须确认实际条件' }];
    const value = { ...ro, report: { ...ro.report, blockers } };
    const next = nextStep(value, ['A']);
    assert.match(next, /codex_continue/);
    assert.doesNotMatch(next, /write=true|host_access=true|resume=/);
    if (['user_input', 'task_conflict'].includes(kind)) assert.match(next, /answers[\s\S]*choice: 请确认保留哪个格式？/);
    if (kind === 'environment') assert.match(next, /环境条件[\s\S]*resolution[\s\S]*不要原样重试/);
    if (kind === 'implementation') assert.match(next, /保留原目录、验收、write、scope 和主机权限/);
  }
  assert.match(nextStep({ ...ro, report: rep(['A', 'not_met', '解析结果错误']) }, ['A']), /codex_continue/);
  assert.match(nextStep({ ...ro, report: rep(['A', 'met', '测试通过']) }, ['A']), /codex_review/);
});

test('turn summary reads the last reply and the tools of one turn', () => {
  const log = [
    { type: 'tool/call', data: { turn: 4, name: 'codex_run' } },
    { type: 'tool/call', data: { turn: 5, name: 'tool_call', arguments: '{"name":"codex_status"}' } },
    { type: 'assistant/message', data: { turn: 5, message: { content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '已派 Codex 去做' }] } } },
    { type: 'step/end', data: { turn: 5 } },
  ];
  assert.deepEqual(turnSummary(log, 5), { text: '已派 Codex 去做', tools: ['tool_call', 'codex_status'] });
});

test('conductor start only starts; waitJob waits with a bounded status call and cancels on abort', async () => {
  const calls = [];
  const run = (_cfg, argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin });
    if (argv[0] === 'start') return Promise.resolve({ job_id: 'J1', status: 'running' });
    if (argv[0] === 'status' && argv[1] === 'J1') {
      return Promise.resolve({ job_id: 'J1', status: 'running', seconds_since_last_event: 3, last_activity: 'ran: pytest (exit 0)' });
    }
    if (argv[0] === 'status') {
      // 模拟被中止时 wsl.exe 被结束
      return new Promise((r) => opts.signal.addEventListener('abort', () => r({ status: 'failed', error_kind: 'bridge_error' })));
    }
    return Promise.resolve({ job_id: argv[1], status: 'cancelled' });
  };
  const c = createConductor({ waitSeconds: 1, model: 'some-model', effort: 'max', serviceTier: 'fast' }, run);
  const args = { task: '在 a.py 里修好 bug', acceptance: ['pytest 通过'], write: true, resume: 'T9', wait_seconds: 30 };
  const first = await c.start(args, 'F:\\proj');
  assert.deepEqual(calls[0].argv, ['start', '--cwd', 'F:\\proj', '--effort', 'max', '--model', 'some-model',
    '--service-tier', 'fast', '--sandbox', 'workspace-write', '--resume', 'T9']);
  assert.deepEqual(first, { job_id: 'J1', status: 'running' });
  await c.start({ ...args, effort: 'low', write: false, resume: undefined }, 'F:\\proj');
  assert.deepEqual(calls.at(-1).argv, ['start', '--cwd', 'F:\\proj', '--effort', 'low', '--model', 'some-model', '--service-tier', 'fast']);
  assert.match(calls[0].stdin, /pytest 通过/);
  assert.equal(calls.length, 2);
  const waited = await c.waitJob('J1', 30);
  assert.deepEqual(calls.at(-1).argv, ['status', 'J1', '--wait', '30']);
  assert.equal(waited.status, 'running');
  assert.equal(waited.last_activity, 'ran: pytest (exit 0)');
  assert.match(waited.note, /30 秒/);

  const ac = new AbortController();
  const pending = c.waitJob('J2', 600, ac.signal);
  ac.abort();
  await assert.rejects(pending);
  assert.deepEqual(calls.at(-1).argv, ['cancel', 'J2']);
});

test('apply registers ten tools in order, a guard and the false-dispatch check', () => {
  const tools = [];
  const guards = [];
  const handlers = {};
  apply({ tools: { register: (t) => tools.push(t), guard: (g) => guards.push(g) }, on: (ev, fn) => { handlers[ev] = fn; } },
    { workspaces: ['F:\\work\\项目'] });
  assert.deepEqual(tools.map((t) => t.name), ['codex_run', 'codex_status', 'codex_cancel', 'codex_jobs', 'codex_output',
    'codex_continue', 'codex_review', 'codex_summary', 'codex_watch', 'codex_runtime']);
  assert.deepEqual(tools[0].parameters.required, ['task', 'acceptance', 'write']);
  assert.match(tools[0].description, /固定为 JSON[\s\S]*启动不了 Windows 程序/);
  assert.equal(guards.length, 1);
  assert.match(guards[0](call('edit')), /已拒绝/);
  assert.match(tools[0].output.render({}, { status: 'completed', final_message: '完成', next: '核验' })[0].text,
    /Codex 最终答复[\s\S]*完成[\s\S]*下一步[\s\S]*核验/);
  const reportText = tools[0].output.render({}, { status: 'completed', final_message: '{}',
    report: { summary: '好了', criteria: [{ criterion: 'A', status: 'not_met', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] } })[0].text;
  assert.match(reportText, /逐条汇报[\s\S]*✗ 1\. A —— e/);
  assert.doesNotMatch(reportText, /Codex 最终答复/);
  // 验收标准只在下一步里列一次，详细字段里不再重复；只读任务没有改动清单，摘要不报文件数
  const plain = tools[0].output.render({}, { status: 'completed', job_id: 'J', acceptance: ['验收甲条'], next: '1. 验收甲条' })[0].text;
  assert.equal(plain.split('\n')[0], 'completed  job_id: J');
  assert.doesNotMatch(plain.split('--- 下一步 ---')[0], /验收甲条|acceptance/);
  assert.match(plain, /下一步 ---\n1\. 验收甲条/);

  // 回合结束时声称已派出却没调用：提醒一次，同一回合不重复；真调用过或范围外不提醒
  const steered = [];
  const agent = (cwd, log) => ({ id: 'A1', session: { header: { cwd }, log }, steer: (m) => steered.push(m) });
  const claim = [{ type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: '已经派出去了，Codex 正在做盘点' }] } } }];
  const stop = handlers['agent/turn-stopping'];
  stop({ agent: agent('F:\\work\\项目', claim), turn: 9 });
  stop({ agent: agent('F:\\work\\项目', claim), turn: 9 });
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /没有调用 codex_run/);
  assert.equal(steered[0].role, 'user');
  stop({ agent: agent('F:\\work\\项目', [...claim.map((e) => ({ ...e, data: { ...e.data, turn: 10 } })),
    { type: 'tool/call', data: { turn: 10, name: 'codex_run' } }]), turn: 10 });
  stop({ agent: agent('F:\\other', claim), turn: 9 });
  stop({ agent: agent('F:\\work\\项目', [{ type: 'assistant/message', data: { turn: 11, message: { content: [{ type: 'text', text: '下一步计划让 Codex 盘点，需要你确认' }] } } }]), turn: 11 });
  assert.equal(steered.length, 1);
});

const HELPER_WIN = fileURLToPath(new URL('./tools/Test-PsSyntax.ps1', import.meta.url));

test('the bundled PowerShell syntax helper is allowed only via -File with file arguments', () => {
  assert.equal(PS_SYNTAX, HELPER_WIN.replace(/^([A-Za-z]):\\/, (_m, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/'));
  for (const c of [
    `pwsh -NoProfile -File '${PS_SYNTAX}' a.ps1 b.ps1`,
    `/mnt/c/tools/pwsh.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${HELPER_WIN}" 'D:\\x\\a.ps1' 2>&1 | tail -5`,
  ]) assert.equal(readOnlyCommand(c), true, c);
  for (const c of [
    'pwsh -NoProfile -File /mnt/c/evil/tools/Test-PsSyntax.ps1 a.ps1',
    `pwsh -NoProfile -File '${PS_SYNTAX}.bak' a.ps1`,
    `pwsh -NoProfile -File '${PS_SYNTAX}'`,
    `pwsh -NoProfile -File '${PS_SYNTAX}' -Command x`,
    `pwsh -NoProfile -File '${PS_SYNTAX}' a.ps1 -EncodedCommand eA==`,
    `pwsh -NoProfile -Command "& '${PS_SYNTAX}' a.ps1"`,
    `pwsh -NoProfile -Command x -File '${PS_SYNTAX}' a.ps1`,
    "pwsh -c \"[System.Management.Automation.Language.Parser]::ParseFile('a.ps1', [ref]$t, [ref]$e)\"",
  ]) assert.equal(readOnlyCommand(c), false, c);
  const denied = decide(call('wsl', { command: 'pwsh -NoProfile -Command x' }), cfg);
  assert.ok(denied.includes(`-File '${HELPER_WIN}'`) && denied.includes(PS_SYNTAX), denied);
});

const pwshMissing = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status !== 0;
test('Test-PsSyntax.ps1 reports parse results and exit codes', { skip: pwshMissing && 'pwsh not installed' }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pssyntax-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good.ps1');
  const bad = path.join(dir, 'bad.ps1');
  writeFileSync(good, 'Get-Date\n');
  writeFileSync(bad, 'function f {\n  if ($x) {\n');
  const ps = (...files) => spawnSync('pwsh', ['-NoProfile', '-File', HELPER_WIN, ...files], { encoding: 'utf8' });
  const ok = ps(good);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^PARSE-OK .*good\.ps1 tokens=\d+/m);
  const fail = ps(good, bad);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /PARSE-OK [\s\S]*PARSE-FAIL .*bad\.ps1\r?\n\d+: /);
  assert.equal(ps().status, 2);
  assert.equal(ps(path.join(dir, 'missing.ps1')).status, 2);
});

// 用假的 runner 和假的 jobs 服务装上插件；后台循环的 `status --wait 20` 由测试逐个应答
function harness({ config = {}, jobs, agents, get = true } = {}) {
  const tools = {};
  const handlers = {};
  const calls = [];
  const waiters = {};
  const requests = [];
  let n = 0;
  let closed = false;
  // finals：runner 已写下结果的任务，单次 status 查询返回它；cancelResult：cancel 的返回
  const finals = {};
  const { startResult, cancelResult, listResult, outputResult, reviewResult, summaryResult, ...pluginConfig } = config;
  const run = (_cfg, argv, options = {}) => {
    calls.push(argv);
    requests.push({ argv, ...options });
    // answer() 放弃后让后台循环出错退出，否则进程挂住不结束
    if (closed) return Promise.reject(new Error('harness closed'));
    if (argv[0] === 'start') return Promise.resolve(startResult ?? { job_id: `J${++n}`, status: 'running' });
    if (argv[0] === 'list') return Promise.resolve((typeof listResult === 'function' ? listResult(argv) : listResult) ?? { jobs: [], total: 0 });
    if (argv[0] === 'output') return Promise.resolve(outputResult ?? { job_id: argv[1], text: '', eof: true, next_offset: null });
    if (argv[0] === 'review') return Promise.resolve(reviewResult);
    if (argv[0] === 'summary') return Promise.resolve(summaryResult ?? { groups: [], total: 0, total_jobs: 0 });
    if (argv[0] === 'status' && argv[3] === '20') return new Promise((r) => (waiters[argv[1]] ??= []).push(r));
    // 下一轮事件循环才答：后台循环的等待参数若不是 20，也不会只靠微任务空转、饿死 answer()
    if (argv[0] === 'status') return new Promise((r) => setImmediate(r, finals[argv[1]] ?? { job_id: argv[1], status: 'running', seconds_since_last_event: 1 }));
    return Promise.resolve(cancelResult ?? { job_id: argv[1], status: 'cancelled' });
  };
  const ctx = { tools: { register: (t) => { tools[t.name] = t; }, guard: () => {} }, on: (ev, fn) => { handlers[ev] = fn; },
    ...(get ? { get: (key) => ({ jobs, agents })[key] } : {}) };
  apply(ctx, { workspaces: ['F:\\work\\项目'], ...pluginConfig }, run);
  const answer = async (job, value) => {
    for (let i = 0; !waiters[job]?.length; i++) {
      if (i === 1000) {
        closed = true;
        throw new Error(`没有收到 \`status ${job} --wait 20\` 调用`);
      }
      await tick();
    }
    waiters[job].shift()(value);
  };
  return { tools, handlers, calls, requests, answer, finals };
}
const tick = () => new Promise((r) => setImmediate(r));
const nudges = [];
const agentAt = (cwd, log = []) => ({ id: 'S1', session: { header: { cwd }, log }, steer: (m) => nudges.push(m) });
const RUN = { task: '在 a.py 里修好 bug', acceptance: ['pytest 通过'], write: false, wait_seconds: 0 };

function workflowSource(kind = 'user_input') {
  return { job_id: 'PARENT', status: 'completed', thread_id: 'THREAD', cwd: '/work/original', sandbox: 'workspace-write',
    scope: ['src'], scope_paths: ['/work/original/src'],
    context: { owner: 'S1', task: '修复 CSV 解析并保留原有数据和文件格式', acceptance: ['CSV 解析测试通过'], write: true },
    task_options: { writable_roots: ['/work/cache'], effort: 'low', use_user_config: true },
    structured: { summary: '等待确认 CSV 格式', criteria: [{ criterion: 'CSV 解析测试通过', status: 'blocked', evidence: '原格式存在歧义' }],
      files_changed: [], deviations: [], unresolved: [],
      blockers: [{ id: 'format', kind, message: 'CSV 格式待处理',
        question: ['user_input', 'task_conflict'].includes(kind) ? '是否保留旧 CSV 格式？' : '', resolution: '保留原约束' }] } };
}

test('failed execution with typed blockers asks questions or waits for evidence before considering retries', () => {
  for (const kind of ['user_input', 'task_conflict', 'environment']) {
    for (const retryable of [true, false]) {
      for (const blockerSource of ['report', 'review']) {
        const source = { ...workflowSource(kind), status: 'failed', error_kind: 'task_failed', retryable };
        if (blockerSource === 'review') {
          source.verification_status = 'needs_changes';
          source.verification = { status: 'needs_changes', blockers: source.structured.blockers };
          source.structured.blockers = [];
        }
        const value = withReport(source);
        const next = nextStep(value);
        assert.equal(value.status, 'failed');
        assert.equal(value.execution_status, 'failed');
        assert.equal(value.report, source.structured);
        if (kind === 'environment') {
          assert.equal(value.blocking.next_action, 'wait_condition');
          assert.match(next, /环境条件[\s\S]*codex_continue[\s\S]*resolution/);
        } else {
          assert.equal(value.blocking.next_action, 'ask_user');
          assert.match(next, /codex_continue[\s\S]*answers[\s\S]*format: 是否保留旧 CSV 格式？/);
        }
        assert.doesNotMatch(next, /这次失败可重试|这次失败不可重试|再派一次|write=true|host_access=true|resume=/);
      }
    }
  }
});

test('independent verification closes a failed round without rewriting its execution status or report', () => {
  for (const verification_status of ['verified', 'accepted_deviations']) {
    const source = { ...workflowSource(), status: 'failed', error_kind: 'task_failed', retryable: true,
      verification_status, verification: { status: verification_status, blockers: [], notes: '实际产物已逐项核验通过' } };
    const original = structuredClone(source);
    const value = withReport(source);
    const next = nextStep(value);
    assert.match(next, /独立核验已记录[\s\S]*本轮已关闭[\s\S]*artifact=review/);
    assert.doesNotMatch(next, /再派一次|codex_continue|answers|resolution|不可重试/);
    assert.equal(value.blocking.next_action, 'done');
    assert.equal(value.status, 'failed');
    assert.equal(value.execution_status, 'failed');
    assert.equal(value.error_kind, 'task_failed');
    assert.equal(value.report, source.structured);
    assert.deepEqual(source, original);
  }
});

test('codex_run cannot resume a thread whose latest owned task needs a user answer', async () => {
  const source = withReport(workflowSource('task_conflict'));
  const h = harness({ config: { listResult: { jobs: [{ job_id: source.job_id, blocking: source.blocking }] } } });
  const exec = { agent: agentAt('/work/current') };
  await assert.rejects(h.tools.codex_run.execute({ ...RUN, resume: source.thread_id }, exec), /PARENT.*用户回答.*codex_continue/);
  assert.deepEqual(h.calls, [['list', '--limit', '100', '--offset', '0', '--owner', 'S1', '--thread-id', 'THREAD']]);
});

test('a new write task cannot widen an overlapping pending scope before a real user reply', async () => {
  const prior = { ...workflowSource('task_conflict'), scope_paths: ['/work/original/candidate.vhdx'] };
  const row = { job_id: prior.job_id, cwd: prior.cwd, scope_paths: prior.scope_paths, scope: prior.scope,
    status: prior.status, blocking: withReport(prior).blocking, finished_at: 10 };
  const registered = { type: 'job/registered', data: { kind: 'codex', owner: 'S1', jobId: 'bg1', label: 'Codex PARENT · test' } };
  const settled = { type: 'job/settled', data: { jobId: 'bg1' } };
  const human = { type: 'user/message', at: 11_000, data: { source: { kind: 'user' } } };
  const notice = { type: 'user/message', at: 11_000, data: { source: { kind: 'tool-jobs' } } };
  const expansion = ['candidate.vhdx', 'step.ps1'];
  for (const { cwd = prior.cwd, scope, events, denied } of [
    { scope: expansion, events: [registered, settled, notice], denied: true },
    { cwd: '/work/elsewhere/deep', scope: ['../../original', 'out'], events: [registered, settled, notice], denied: true },
    { cwd: '/work', scope: undefined, events: [registered, settled], denied: true },
    { cwd: '/work/elsewhere', scope: undefined, events: [registered, settled], denied: false },
    { scope: undefined, events: [registered, settled], denied: true },
    { scope: ['other.vhdx'], events: [registered, settled], denied: false },
    { scope: ['candidate.vhdx'], events: [registered, settled], denied: false },
    { scope: expansion, events: [registered, settled, human], denied: false },
  ]) {
    const h = harness({ config: { listResult: { jobs: [row] }, startResult: { job_id: 'J', status: 'completed' } } });
    h.finals.PARENT = prior;
    const pending = h.tools.codex_run.execute({ ...RUN, cwd, scope, write: true }, { agent: agentAt(cwd, events) });
    if (denied) await assert.rejects(pending, /PARENT.*范围冲突.*用户回答/);
    else assert.equal((await pending).job_id, 'J');
    assert.equal(h.calls.filter(argv => argv[0] === 'start').length, denied ? 0 : 1);
    assert.ok(!h.calls.find(argv => argv[0] === 'list').includes('--cwd'));
    assert.equal(h.calls.some(argv => argv[0] === 'status' && argv[1] === 'PARENT'), false);
  }
});

test('codex_continue without answers returns the source and pending questions without dispatching', async () => {
  const source = workflowSource();
  const h = harness();
  h.finals.PARENT = source;
  const value = await h.tools.codex_continue.execute({ job_id: 'PARENT' }, { agent: agentAt('/work/current') });
  assert.equal(value.continuation_ready, false);
  assert.equal(value.report, source.structured);
  assert.deepEqual(value.remaining_questions, [{ id: 'format', question: '是否保留旧 CSV 格式？' }]);
  assert.equal(value.blocking.state, 'needs_input');
  assert.equal(h.calls.filter((argv) => argv[0] === 'start').length, 0);
});

const answeredParent = [
  { type: 'job/registered', data: { kind: 'codex', owner: 'S1', jobId: 'bg1', label: 'Codex PARENT' } },
  { type: 'job/settled', data: { jobId: 'bg1' } },
  { type: 'user/message', time: 11_000, data: { source: { kind: 'user' } } },
];

test('both resume paths reject an older unanswered task on the same thread', async () => {
  const parent = withReport(workflowSource('task_conflict'));
  const latest = withReport({ ...workflowSource('implementation'), job_id: 'CHILD' });
  const [registered, settled, human] = answeredParent;
  const notice = { ...human, data: { source: { kind: 'tool-jobs' } } };
  for (const tool of ['codex_run', 'codex_continue']) {
    const listResult = (argv) => {
      if (!argv.includes('--thread-id')) return { jobs: [], total: 0 };
      return argv[argv.indexOf('--offset') + 1] === '0'
        ? { jobs: [latest], next_offset: 1 } : { jobs: [parent] };
    };
    const h = harness({ config: { listResult, startResult: { job_id: 'NEXT', status: 'completed' } } });
    h.finals.CHILD = latest;
    const args = tool === 'codex_run'
      ? { ...RUN, write: true, scope: ['src'], resume: parent.thread_id } : { job_id: 'CHILD', wait_seconds: 0 };
    const invoke = (log) => h.tools[tool].execute(args, { agent: agentAt('/work/current', log) });
    const log = [registered, settled, notice];
    await assert.rejects(invoke(log), /PARENT.*用户回答.*未启动 Codex/);
    assert.equal(h.calls.filter(argv => argv[0] === 'start').length, 0);
    assert.equal((await invoke([...log, human])).job_id, 'NEXT');
    assert.equal(h.calls.filter(argv => argv[0] === 'start').length, 1);
  }
});

test('codex_continue requires a real reply after the report or review raised questions', async () => {
  const [registered, settled, human] = answeredParent;
  const notice = { ...human, time: 12_500, data: { source: { kind: 'tool-jobs' } } };
  for (const fromReview of [false, true]) {
    const source = workflowSource('task_conflict');
    const first = source.structured.blockers[0];
    source.structured.blockers.push({ ...first, id: 'columns', question: '是否保留旧列？' });
    if (fromReview) {
      source.verification_status = 'needs_changes';
      source.verification = { status: 'needs_changes', time: 12, blockers: source.structured.blockers };
      source.structured.blockers = [];
    }
    const h = harness({ config: { startResult: { job_id: 'CHILD', status: 'completed' } } });
    h.finals.PARENT = source;
    const args = { job_id: 'PARENT', answers: [{ id: 'format', answer: '保留旧格式' }, { id: 'columns', answer: '保留旧列' }],
      resolution: '已有补充信息', wait_seconds: 0 };
    const log = fromReview ? [registered, settled, human, notice] : [human, registered, settled, notice];
    const denied = await h.tools.codex_continue.execute(args, { agent: agentAt('/work/current', log) });
    assert.equal(denied.continuation_ready, false);
    assert.deepEqual(denied.remaining_questions.map(q => q.id), ['format', 'columns']);
    assert.equal(h.calls.filter(argv => argv[0] === 'start').length, 0);
    const replied = { agent: agentAt('/work/current', [...log, { ...human, time: 13_000 }]) };
    assert.equal((await h.tools.codex_continue.execute(args, replied)).job_id, 'CHILD');
    assert.equal(h.calls.filter(argv => argv[0] === 'start').length, 1);
  }
});

test('codex_continue dispatches 22 original criteria with original context, permissions and options', async () => {
  for (const sandbox of ['workspace-write', 'danger-full-access', 'read-only']) {
    const source = { ...workflowSource(), finished_at: 10 };
    source.context.acceptance = Array.from({ length: 22 }, (_, i) => `验收 ${i + 1}：保留 "CSV" 原文与数据 😀`);
    source.structured.criteria = source.context.acceptance.map((criterion) =>
      ({ ...source.structured.criteria[0], criterion }));
    source.structured.blockers[0].id = ' format ';
    source.sandbox = sandbox;
    source.context.write = sandbox !== 'read-only';
    source.task_options.use_user_config = sandbox !== 'read-only';
    if (!source.context.write) source.task_options.writable_roots = [];
    source.final_message = 'WHOLE-HISTORY-MUST-NOT-BE-COPIED';
    source.context.continuation = { parent_job_id: 'GRANDPARENT', answers: [], resolution: '历史处理记录' };
    const before = structuredClone(source);
    const h = harness({ config: { allowHostAccess: true, defaultHostAccess: true, effort: 'max',
      startResult: { job_id: 'CHILD', status: 'completed' } } });
    h.finals.PARENT = source;
    const answers = [{ id: ' format ', answer: ' 保留旧 CSV 格式 ' }];
    const resolution = '\n    格式约束保持不变\n';
    const value = await h.tools.codex_continue.execute({ job_id: 'PARENT', answers, resolution, wait_seconds: 0 },
      { agent: agentAt('/work/current', [answeredParent[2]]) });
    assert.equal(value.job_id, 'CHILD');
    const starts = h.requests.filter(({ argv }) => argv[0] === 'start');
    assert.equal(starts.length, 1);
    const { argv, stdin } = starts[0];
    const envelope = JSON.parse(stdin);
    const flag = (name) => argv[argv.indexOf(name) + 1];
    assert.equal(flag('--cwd'), source.cwd);
    assert.equal(flag('--resume'), source.thread_id);
    assert.equal(flag('--effort'), 'low');
    assert.equal(argv.includes('--use-user-config'), source.task_options.use_user_config);
    assert.ok(argv.includes('--context-json'));
    assert.deepEqual(argv.filter((_, i) => argv[i - 1] === '--scope'), source.scope_paths);
    assert.deepEqual(argv.filter((_, i) => argv[i - 1] === '--writable-root'), source.task_options.writable_roots);
    if (sandbox === 'read-only') assert.ok(!argv.includes('--sandbox'));
    else assert.equal(flag('--sandbox'), sandbox);
    assert.deepEqual(envelope.context, { owner: 'S1', task: source.context.task, acceptance: source.context.acceptance,
      write: source.context.write, continuation: { parent_job_id: 'PARENT', answers, resolution } });
    assert.match(envelope.prompt, /保留旧 CSV 格式/);
    assert.ok(envelope.prompt.includes(source.context.acceptance.map((item, i) => `${i + 1}. ${item}`).join('\n')));
    assert.doesNotMatch(envelope.prompt, /WHOLE-HISTORY-MUST-NOT-BE-COPIED|历史处理记录/);
    assert.deepEqual(source, before);
  }
});

test('codex_continue shares concurrent dispatch and reuses an existing child after reload', async () => {
  const exec = { agent: agentAt('/work/current', answeredParent) };
  const args = { job_id: 'PARENT', answers: [{ id: 'format', answer: '保留旧格式' }], wait_seconds: 0 };
  const h = harness({ config: { startResult: { job_id: 'CHILD', status: 'completed' } } });
  h.finals.PARENT = workflowSource();
  const results = await Promise.all([h.tools.codex_continue.execute(args, exec), h.tools.codex_continue.execute(args, exec)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.calls.filter((argv) => argv[0] === 'start').length, 1);
  assert.equal(h.calls.filter((argv) => argv[0] === 'list' && argv.includes('--parent-job')).length, 1);
  assert.equal(h.calls.filter((argv) => argv[0] === 'list' && argv.includes('--thread-id')).length, 1);
  const after = harness({ config: { listResult: { jobs: [{ job_id: 'CHILD' }], total: 1 } } });
  after.finals.PARENT = h.finals.PARENT;
  after.finals.CHILD = { job_id: 'CHILD', status: 'running', context: { ...h.finals.PARENT.context,
    continuation: { parent_job_id: 'PARENT', answers: [], resolution: '' } } };
  const reused = await after.tools.codex_continue.execute(args, { agent: agentAt('/work/current') });
  assert.equal(reused.reused, true);
  assert.equal(reused.job_id, 'CHILD');
  assert.equal(after.calls.filter((argv) => argv[0] === 'start').length, 0);
  const query = after.calls.find((argv) => argv[0] === 'list');
  assert.equal(query[query.indexOf('--parent-job') + 1], 'PARENT');
  assert.equal(query[query.indexOf('--owner') + 1], 'S1');
});

test('codex_continue persists user decisions through two new threads and a plugin reload', async () => {
  const source = workflowSource();
  delete source.thread_id;
  const exec = { agent: agentAt('/work/current', answeredParent) };
  const h = harness({ config: { startResult: { job_id: 'CHILD', status: 'completed' } } });
  h.finals.PARENT = source;
  await h.tools.codex_continue.execute({ job_id: 'PARENT',
    answers: [{ id: 'format', answer: '仅使用 Windows-1252' }], wait_seconds: 0 }, exec);
  const first = JSON.parse(h.requests.find(({ argv }) => argv[0] === 'start').stdin);
  const child = { ...workflowSource('environment'), job_id: 'CHILD', context: first.context };
  delete child.thread_id;
  child.structured.summary = '等待服务恢复';
  child.structured.blockers[0].message = '网络不可用';
  const after = harness({ config: { allowHostAccess: true, defaultHostAccess: true,
    startResult: { job_id: 'GRANDCHILD', status: 'completed' } } });
  after.finals.CHILD = child;
  const value = await after.tools.codex_continue.execute({ job_id: 'CHILD', resolution: '健康检查返回 HTTP 200', wait_seconds: 0 }, exec);
  assert.equal(value.job_id, 'GRANDCHILD');
  const { argv, stdin } = after.requests.find(({ argv }) => argv[0] === 'start');
  const envelope = JSON.parse(stdin);
  assert.match(envelope.prompt, /仅使用 Windows-1252/);
  assert.match(envelope.context.task, /仅使用 Windows-1252/);
  assert.doesNotMatch(envelope.prompt, /等待确认 CSV 格式/);
  assert.doesNotMatch(envelope.context.task, /等待服务恢复|HTTP 200/);
  assert.deepEqual(envelope.context.acceptance, source.context.acceptance);
  assert.equal(envelope.context.write, source.context.write);
  assert.equal(envelope.context.owner, source.context.owner);
  assert.equal(argv[argv.indexOf('--cwd') + 1], source.cwd);
  assert.equal(argv[argv.indexOf('--sandbox') + 1], source.sandbox);
  assert.equal(argv.includes('--resume'), false);
  assert.deepEqual(argv.filter((_, i) => argv[i - 1] === '--scope'), source.scope_paths);
  assert.deepEqual(argv.filter((_, i) => argv[i - 1] === '--writable-root'), source.task_options.writable_roots);
  assert.deepEqual(envelope.context.continuation, { parent_job_id: 'CHILD', answers: [], resolution: '健康检查返回 HTTP 200' });
});

test('codex_review rejects other or unknown owners before recording any review', async () => {
  const h = harness();
  const review = { job_id: 'PARENT', status: 'verified', criteria: [{ index: 1, status: 'met', evidence: '测试通过' }],
    notes: '只读检查完成', accepted_deviations: [] };
  for (const owner of ['another-owner', null, undefined]) {
    const source = workflowSource();
    source.context.owner = owner;
    h.finals.PARENT = source;
    await assert.rejects(h.tools.codex_review.execute(review, { agent: agentAt('/work/current') }), /归属未知或不属于当前会话/);
  }
  assert.ok(h.calls.every((argv) => argv[0] === 'status'));
});

test('codex_review sends every criterion in stdin and returns verification without rewriting the report', async () => {
  const source = workflowSource('implementation');
  source.context.acceptance.push('旧 CSV 文件保持不变');
  source.structured.criteria.push({ criterion: '旧 CSV 文件保持不变', status: 'met', evidence: '前后内容一致' });
  const review = { status: 'needs_changes', criteria: [
    { index: 1, status: 'not_met', evidence: '空列输入仍解析错误' },
    { index: 2, status: 'met', evidence: '只读 diff 确认原文件未改' }], notes: '仅修解析器', accepted_deviations: [],
    blockers: source.structured.blockers };
  const original = structuredClone(source.structured);
  const h = harness({ config: { reviewResult: { ...source, verification_status: 'needs_changes', verification: review } } });
  h.finals.PARENT = source;
  const value = await h.tools.codex_review.execute({ job_id: 'PARENT', ...review }, { agent: agentAt('/work/current') });
  const requests = h.requests.filter(({ argv }) => argv[0] === 'review');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].argv, ['review', 'PARENT', '--reviewer', 'S1']);
  assert.deepEqual(JSON.parse(requests[0].stdin), review);
  assert.deepEqual(value.verification, review);
  assert.equal(value.verification_status, 'needs_changes');
  assert.deepEqual(value.report, original);
  assert.deepEqual(source.structured, original);
  assert.ok(!h.calls.some((argv) => argv[0] === 'start'));
});

test('codex_review accepts a complete review without empty optional fields', async () => {
  const source = workflowSource('implementation');
  const review = { status: 'verified', criteria: [{ index: 1, status: 'met', evidence: '只读测试确认已通过' }] };
  const record = { ...review, notes: '', accepted_deviations: [] };
  const h = harness({ config: { reviewResult: { ...source, verification_status: 'verified', verification: record } } });
  h.finals.PARENT = source;
  const tool = h.tools.codex_review;
  assert.deepEqual(tool.parameters.required, ['job_id', 'status', 'criteria']);
  const value = await tool.execute({ job_id: 'PARENT', ...review }, { agent: agentAt('/work/current') });
  const request = h.requests.find(({ argv }) => argv[0] === 'review');
  assert.deepEqual(JSON.parse(request.stdin), record);
  assert.equal(value.verification_status, 'verified');
  assert.ok(!h.calls.some((argv) => argv[0] === 'start'));
});

test('codex_review distinguishes rejected arguments from a reviewed failed execution', async () => {
  const source = workflowSource();
  const original = structuredClone(source);
  const record = { status: 'needs_changes',
    criteria: [{ index: 1, status: 'not_met', evidence: 'still fails' }], notes: 'checked', accepted_deviations: [] };
  const review = { job_id: 'PARENT', ...record };
  const h = harness({ config: { reviewResult: { status: 'failed', error_kind: 'bad_arguments',
    error: 'Invalid review: invalid deviation index', retryable: false } } });
  h.finals.PARENT = source;
  await assert.rejects(h.tools.codex_review.execute(review, { agent: agentAt('/work/current') }),
    /codex_review:.*复核.*invalid deviation index.*codex_status/);
  assert.deepEqual(h.finals.PARENT, original);
  assert.ok(h.calls.every((argv) => ['status', 'review'].includes(argv[0])));

  const failed = { ...source, status: 'failed', error_kind: 'bad_arguments' };
  const f = harness({ config: { reviewResult: { ...failed, verification_status: 'needs_changes',
    verification: record } } });
  f.finals.PARENT = failed;
  const value = await f.tools.codex_review.execute(review, { agent: agentAt('/work/current') });
  assert.equal(value.execution_status, 'failed');
  assert.equal(value.report_status, 'valid');
  assert.equal(value.verification_status, 'needs_changes');
});

test('existing-job tools reject malformed runner IDs before invoking the runner', async () => {
  const rejected = { status: 'failed', error_kind: 'bad_arguments', error: 'invalid job_id', retryable: false };
  const h = harness({ config: { cancelResult: rejected } });
  const exec = { agent: agentAt('/work/current') };
  const invalid = ['bad id', '../escape', 'J/1', 'bg:J', '-J', 'J1\n', 'J1\r\n', '', ' ', null, 42];
  for (const id of invalid) h.finals[id] = rejected;
  for (const name of ['codex_status', 'codex_cancel', 'codex_output', 'codex_continue', 'codex_review']) {
    for (const id of invalid) {
      const args = { job_id: id };
      if (name === 'codex_status') args.wait_seconds = 0;
      if (name === 'codex_review') Object.assign(args, { status: 'verified',
        criteria: [{ index: 1, status: 'met', evidence: 'checked' }], notes: 'checked', accepted_deviations: [] });
      await assert.rejects(h.tools[name].execute(args, exec), /job_id/);
    }
  }
  assert.equal(h.calls.length, 0);

  const id = 'J-1_2';
  const good = harness({ config: { cancelResult: { job_id: id, status: 'cancelled' } } });
  good.finals[id] = { job_id: id, status: 'completed' };
  assert.equal((await good.tools.codex_status.execute({ job_id: id, wait_seconds: 0 }, {})).execution_status, 'completed');
  assert.equal((await good.tools.codex_cancel.execute({ job_id: id }, {})).status, 'cancelled');
  assert.deepEqual(good.calls, [['status', id, '--wait', '0'], ['cancel', id]]);
});

test('codex_summary defaults to the current owner, passes thread filters and never starts Codex', async () => {
  const summary = { total: 0, total_jobs: 0, groups: [] };
  const h = harness({ config: { summaryResult: summary } });
  const exec = { agent: agentAt('/work/current') };
  assert.deepEqual(await h.tools.codex_summary.execute({}, exec), summary);
  assert.deepEqual(await h.tools.codex_summary.execute({ thread_id: 'THREAD' }, exec), summary);
  assert.deepEqual(await h.tools.codex_summary.execute({ limit: 2, offset: 4 }, exec), summary);
  assert.deepEqual(h.calls, [['summary', '--owner', 'S1'], ['summary', '--owner', 'S1', '--thread-id', 'THREAD'],
    ['summary', '--owner', 'S1', '--limit', '2', '--offset', '4']]);
});

test('codex_summary renders null duration and usage as unknown while retaining genuine zero values', () => {
  const h = harness();
  const group = { thread_id: 'THREAD', total_rounds: 1, latest_job_id: 'PARENT', verification_status: 'unreviewed',
    latest_job: workflowSource(), summary: '原始统计不完整', files_changed: [], open_items: [],
    finished_duration_s: null, usage: null, usage_scope: 'unknown' };
  const render = (item) => h.tools.codex_summary.output.render({}, { total: 3, total_jobs: 5, groups: [item], next_offset: 1 })[0].text;
  const text = render(group);
  assert.match(text, /3 组，5 轮；本页 1 组/);
  assert.match(text, /offset=1 查看下一页/);
  assert.match(text, /执行 completed · 独立核验 unreviewed/);
  assert.match(text, /涉及文件（含历史改动）：无/);
  assert.match(render({ ...group, latest_job: { ...group.latest_job, status: 'running', execution_status: 'running' } }),
    /执行 running · 独立核验 unreviewed/);
  assert.match(text, /已结束轮次耗时合计：未知；用量（unknown）：未知（原始用量不完整）/);
  assert.doesNotMatch(text, /耗时合计：0 秒|用量（unknown）：null/);
  assert.equal(group.finished_duration_s, null);
  assert.equal(group.usage, null);
  assert.match(render({ ...group, finished_duration_s: 0, usage: { input_tokens: 0 }, usage_scope: 'thread_total' }),
    /已结束轮次耗时合计：0 秒；用量（thread_total）：\{"input_tokens":0\}/);
  assert.deepEqual(h.calls, []);
});

test('runtime status shows loaded service tier and sanitized gateway settings', async () => {
  const current = harness({ config: { serviceTier: 'fast', allowHostAccess: true, defaultHostAccess: true,
    codexRoute: { provider: 'magpie', baseUrl: 'http://127.0.0.1:3426/v1?private=route-test' },
    routerCheckUrl: 'http://127.0.0.1:3440/health?private=probe-test' } });
  const { loaded } = await current.tools.codex_runtime.execute({ action: 'status' });
  assert.equal(loaded.serviceTier, 'fast');
  assert.equal(loaded.allowHostAccess, true);
  assert.equal(loaded.defaultHostAccess, true);
  assert.deepEqual(loaded.codexRoute, { provider: 'magpie', origin: 'http://127.0.0.1:3426' });
  assert.deepEqual(loaded.routerCheck, { transport: 'tcp', origin: 'http://127.0.0.1:3440' });
  assert.doesNotMatch(JSON.stringify(loaded), /route-test|probe-test/);

  const inherited = harness({ config: { codexRoute: { provider: 'magpie', baseUrl: 'http://127.0.0.1:3426/v1' } } });
  const fallback = (await inherited.tools.codex_runtime.execute()).loaded;
  assert.equal(fallback.serviceTier, null);
  assert.deepEqual(fallback.routerCheck, { transport: 'http', origin: 'http://127.0.0.1:3426' });
});

test('codex_watch stays quiet without changes and stopping it leaves the business task running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jobs = fakeJobs();
  let finish;
  let businessCancelled = false;
  const business = jobs.start({ owner: 'S1', kind: 'codex', label: 'Codex LIVE · business',
    run: () => ({ done: new Promise((resolve) => { finish = resolve; }), cancel: () => { businessCancelled = true; } }) });
  const h = harness({ jobs });
  const exec = { agent: agentAt('/work/current') };
  const watching = await h.tools.codex_watch.execute({}, exec);
  const again = await h.tools.codex_watch.execute({}, exec);
  assert.equal(again.reused, true);
  assert.equal(again.background_job_id, watching.background_job_id);
  t.mock.timers.tick(1000);
  await tick();
  t.mock.timers.tick(1000);
  await tick();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(jobs.unawaited, []);
  assert.equal(jobs.kill(watching.background_job_id, 'S1'), 'requested');
  const watcher = jobs.started.find((job) => job.id === watching.background_job_id);
  assert.equal((await watcher.done).status, 'killed');
  assert.equal(jobs.get(business, 'S1').status, 'running');
  assert.equal(businessCancelled, false);
  assert.deepEqual(h.calls, []);
  finish({ status: 'completed', result: 'fake business cleanup' });
  await jobs.started[0].done;
});

test('codex_watch ignores ownerless observers and completed ownerless Codex jobs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const jobs = fakeJobs();
  let finishGlobalWatch;
  let finishGlobalTask;
  const globalWatch = jobs.start({ kind: 'codex-watch', label: 'Codex 安静观察 · attention',
    run: () => ({ done: new Promise((resolve) => { finishGlobalWatch = resolve; }),
      cancel() { throw new Error('must not stop the global observer'); } }) });
  const globalTask = jobs.start({ kind: 'codex', label: 'Codex GLOBAL · global task',
    run: () => ({ done: new Promise((resolve) => { finishGlobalTask = resolve; }),
      cancel() { throw new Error('must not cancel the global task'); } }) });
  const h = harness({ jobs });
  h.finals.GLOBAL = { ...workflowSource('environment'), job_id: 'GLOBAL' };
  const watching = await h.tools.codex_watch.execute({}, { agent: agentAt('/work/current') });
  const watcher = jobs.started.find((job) => job.id === watching.background_job_id);
  t.after(async () => {
    if (watcher.spec.owner === 'S1') {
      jobs.kill(watcher.id, 'S1');
      await watcher.done;
    }
    finishGlobalWatch({ status: 'killed', result: 'fake global observer cleanup' });
    finishGlobalTask({ status: 'completed', result: 'fake global task cleanup' });
    await Promise.all([jobs.started[0].done, jobs.started[1].done]);
  });
  assert.ok(jobs.list('S1').some((job) => job.id === globalWatch));
  assert.ok(jobs.list('S1').some((job) => job.id === globalTask));
  assert.notEqual(watching.background_job_id, globalWatch);
  assert.equal(watching.reused, undefined);
  assert.equal(watcher.spec.owner, 'S1');
  finishGlobalTask({ status: 'completed', result: 'global task finished with a blocker' });
  await jobs.started[1].done;
  t.mock.timers.tick(1000);
  await tick();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(jobs.get(globalTask, 'S1').status, 'completed');
  assert.equal(jobs.get(watcher.id, 'S1').status, 'running');
  assert.equal(watcher.result, undefined);
  assert.equal(jobs.unawaited.includes(watcher.id), false);
  assert.deepEqual(h.calls, []);
});

test('codex_watch notifies once for failed or blocked tasks and never cancels the runner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const outcome of ['failed', 'blocked']) {
    const jobs = fakeJobs();
    let finish;
    jobs.start({ owner: 'S1', kind: 'codex', label: 'Codex LIVE · business',
      run: () => ({ done: new Promise((resolve) => { finish = resolve; }), cancel() { throw new Error('must not cancel business'); } }) });
    const h = harness({ jobs });
    const source = workflowSource('environment');
    h.finals.LIVE = outcome === 'failed' ? { job_id: 'LIVE', status: 'failed', error_kind: 'worker_died', error: 'fake failure' }
      : { ...source, job_id: 'LIVE' };
    const watched = await h.tools.codex_watch.execute({}, { agent: agentAt('/work/current') });
    finish({ status: outcome === 'failed' ? 'failed' : 'completed', result: 'fake task result' });
    await jobs.started[0].done;
    t.mock.timers.tick(1000);
    await tick();
    const watcher = jobs.started.find((job) => job.id === watched.background_job_id);
    const result = await watcher.done;
    assert.equal(result.status, 'completed');
    const notice = JSON.parse(result.result);
    assert.equal(notice.changes.length, 1);
    assert.equal(notice.changes[0].job_id, 'LIVE');
    if (outcome === 'blocked') assert.equal(notice.changes[0].blocking.state, 'waiting_environment');
    assert.equal(jobs.unawaited.filter((id) => id === watched.background_job_id).length, 1);
    assert.deepEqual(h.calls, [['status', 'LIVE', '--wait', '0']]);
    t.mock.timers.tick(5000);
    await tick();
    assert.equal(h.calls.length, 1);
    assert.equal(jobs.unawaited.filter((id) => id === watched.background_job_id).length, 1);
  }
});

// 按 DSH 任务表的约定：结算时有 wait() 在等就算已送达，否则记进 unawaited（DSH 会为它另发通知）
function fakeJobs({ fail = false } = {}) {
  const terminal = (job) => !['running', 'stopping'].includes(job.status);
  const trim = (output, cap) => {
    while (output.chunks.length > 1 && output.chunks.reduce((n, c) => n + c.bytes, 0) > cap) output.chunks.shift();
    const only = output.chunks[0];
    if (only?.bytes > cap) {
      const text = utf8Tail(only.text, cap);
      only.at += only.bytes - Buffer.byteLength(text);
      only.text = text;
      only.bytes = Buffer.byteLength(text);
    }
    output.earliest = output.chunks[0]?.at ?? output.total;
  };
  return {
    started: [],
    unawaited: [],
    start(spec) {
      if (fail) throw new Error('no job controller');
      const output = { chunks: [], total: 0, earliest: 0 };
      const handle = { progress: [], updateProgress(t) { this.progress.push(t); },
        append(text, options = {}) {
          const bytes = Buffer.byteLength(text);
          if (!bytes) return;
          output.chunks.push({ at: output.total, text, bytes, ...options });
          output.total += bytes;
          trim(output, 256 * 1024);
        } };
      const job = { spec, handle, output, cursor: 0, id: `bg${this.started.length + 1}`, status: 'running',
        waiters: new Set(), ...spec.run(handle) };
      job.done.then((outcome) => {
        job.status = outcome.status;
        job.detail = outcome.detail;
        job.result = outcome.result;
        trim(output, Math.max(16 * 1024, output.total - job.cursor));
        if (!job.waiters.size) this.unawaited.push(job.id);
        for (const w of job.waiters) w();
      });
      this.started.push(job);
      return job.id;
    },
    view: (j) => ({ id: j.id, kind: j.spec.kind, label: j.spec.label, owner: j.spec.owner, status: j.status,
      ...(!terminal(j) && j.handle.progress.length ? { progress: j.handle.progress.at(-1) } : {}),
      ...(j.detail !== undefined ? { detail: j.detail } : {}), outputLimitBytes: j.spec.outputLimitBytes,
      output: { total: j.output.total, earliest: j.output.earliest } }),
    expect(id, owner) {
      const job = this.started.find((j) => j.id === id);
      if (!job) throw new Error(`unknown job ${id}`);
      if (job.spec.owner !== undefined && job.spec.owner !== owner) throw new Error(`job ${id} belongs to another session`);
      return job;
    },
    list(owner) { return this.started.filter((j) => j.spec.owner === undefined || j.spec.owner === owner).map(this.view); },
    get(id, owner) { return this.view(this.expect(id, owner)); },
    readAt(id, from, owner) {
      const job = this.expect(id, owner);
      return { chunks: job.output.chunks.filter((c) => c.at + c.bytes > from).map(({ bytes, ...c }) => ({ ...c })),
        next: job.output.total, lossy: from < job.output.earliest };
    },
    // 和 DSH 一样：结算后的结果只随第一次 read 交出
    read(id, owner) {
      const job = this.expect(id, owner);
      const output = this.readAt(id, job.cursor, owner);
      job.cursor = job.output.total;
      const result = terminal(job) && !job.delivered ? job.result : undefined;
      job.delivered ||= result !== undefined;
      if (terminal(job)) trim(job.output, 16 * 1024);
      return { ...output, ...(result !== undefined ? { result } : {}), job: this.view(job) };
    },
    wait(id, ms, owner, signal) {
      const job = this.expect(id, owner);
      if (job.status !== 'running' && job.status !== 'stopping') return Promise.resolve(this.view(job));
      return new Promise((resolve, reject) => {
        const end = (fn) => () => { clearTimeout(timer); job.waiters.delete(settle); fn(); };
        const settle = end(() => resolve(this.view(job)));
        const timer = setTimeout(end(() => resolve(this.view(job))), ms);
        signal?.addEventListener('abort', end(() => reject(new Error('wait aborted'))), { once: true });
        job.waiters.add(settle);
      });
    },
    kill(id, owner) {
      const job = this.expect(id, owner);
      if (terminal(job)) return 'already-finished';
      job.cancel();
      job.status = 'stopping';
      return 'requested';
    },
  };
}

function utf8Tail(text, maxBytes) {
  const bytes = Buffer.from(text);
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

// SDK job_output：过滤 log、消费一次 result，超限保留尾部和状态后缀。
function modelJobOutput(jobs, id, owner) {
  const read = jobs.read(id, owner);
  const body = read.chunks.filter((c) => c.channel !== 'log').map((c) => c.text).join('') + (read.result ?? '');
  const suffix = `\n[status: ${read.job.status}]`;
  const max = read.job.outputLimitBytes;
  return max && Buffer.byteLength(body + suffix) > max
    ? utf8Tail(body, max - Buffer.byteLength(`\n[output truncated]${suffix}`)) + `\n[output truncated]${suffix}` : body + suffix;
}

test('task directory defaults to the cwd of the containing workspace entry', async () => {
  const { tools, calls } = harness({ config: { startResult: { job_id: 'J', status: 'completed' },
    workspaces: ['F:\\work\\项目', { path: 'D:\\ops', cwd: '/mnt/d/ops/opsec' }, { path: 'D:\\ops\\deep', cwd: 'D:\\ops\\deep\\x' }] } });
  const cwdOf = async (session, args = {}) => {
    await tools.codex_run.execute({ ...RUN, ...args }, { agent: agentAt(session) });
    return calls.at(-1)[2];
  };
  assert.equal(await cwdOf('D:\\ops\\sub'), '/mnt/d/ops/opsec');
  assert.equal(await cwdOf('D:\\ops\\deep\\y'), 'D:\\ops\\deep\\x');
  assert.equal(await cwdOf('F:\\work\\项目\\a'), 'F:\\work\\项目\\a');
  assert.equal(await cwdOf('E:\\elsewhere'), 'E:\\elsewhere');
  assert.equal(await cwdOf('D:\\ops\\sub', { cwd: '/mnt/d/other' }), '/mnt/d/other');
  // 护栏仍按 path 匹配
  const guards = [];
  apply({ tools: { register: () => {}, guard: (g) => guards.push(g) }, on: () => {} }, { workspaces: [{ path: 'D:\\ops', cwd: '/mnt/d/ops/opsec' }] });
  assert.match(guards[0](call('write', {}, 'D:\\ops\\sub')), /已拒绝/);
  assert.equal(guards[0](call('write', {}, 'D:\\other')), undefined);
});

test("workspaces '*' guards every session workspace", () => {
  const guards = [];
  apply({ tools: { register: () => {}, guard: (g) => guards.push(g) }, on: () => {} }, { workspaces: ['*'] });
  assert.match(guards[0](call('write', {}, 'D:\\other')), /已拒绝/);
  assert.match(guards[0](call('write', {}, '/mnt/e/x')), /已拒绝/);
  assert.equal(guards[0](call('write', {}, '')), undefined);
});

test('read-only tasks use readOnlyEffort, writer tasks use effort; scope entries reach the runner', async () => {
  const { tools, calls } = harness({ config: { startResult: { job_id: 'J', status: 'completed' }, effort: 'max', readOnlyEffort: 'low' } });
  const argv = async (args) => {
    await tools.codex_run.execute({ ...RUN, ...args }, { agent: agentAt('F:\\work\\项目') });
    return calls.at(-1);
  };
  const effort = (a) => a[a.indexOf('--effort') + 1];
  assert.equal(effort(await argv({})), 'low');
  assert.equal(effort(await argv({ write: true })), 'max');
  assert.equal(effort(await argv({ effort: 'medium' })), 'medium');
  const scoped = await argv({ write: true, scope: ['src', 'tests/'] });
  assert.deepEqual(scoped.slice(scoped.indexOf('--scope')), ['--scope', 'src', '--scope', 'tests/', '--context-json']);
  assert.ok(!(await argv({})).includes('--scope'));
  const other = harness({ config: { startResult: { job_id: 'J', status: 'completed' }, effort: 'high' } });
  await other.tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  assert.equal(effort(other.calls.at(-1)), 'high');
  assert.match(other.tools.codex_run.parameters.properties.effort.description, /只读时 high/);
});

test('additional writable roots reach the runner while retaining the workspace sandbox', async () => {
  const { tools, calls } = harness({ config: { startResult: { job_id: 'J', status: 'completed' } } });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await tools.codex_run.execute({ ...RUN, write: true, writable_roots: ['E:\\results', '/mnt/e/other'],
    scope: ['src/a.py', 'E:\\results\\result.json'] }, exec);
  const argv = calls.at(-1);
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'workspace-write');
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--writable-root'), ['E:\\results', '/mnt/e/other']);
  assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--scope'), ['src/a.py', 'E:\\results\\result.json']);
  await tools.codex_run.execute({ ...RUN, write: true }, exec);
  assert.ok(!calls.at(-1).includes('--writable-root'));
});

test('composePrompt adds the host-access lines only with host_access, the read-only line only without write', () => {
  const prompt = (opts) => composePrompt('做事情做事情', ['甲条件成立'], ['src'], opts);
  const base = composePrompt('做事情做事情', ['甲条件成立'], ['src']);
  assert.equal(prompt({ write: true }), base);
  assert.doesNotMatch(base, /沙箱外|只读调查/);
  const rw = prompt({ hostAccess: true, write: true });
  assert.match(rw, /只允许改动[\s\S]*沙箱外运行[\s\S]*pwsh\.exe、ssh\.exe、Hyper-V cmdlet[\s\S]*不要删除、停止、重建或改配置。\n[\s\S]*## 最后汇报/);
  assert.doesNotMatch(rw, /只读调查/);
  assert.match(prompt({ hostAccess: true }), /不要删除、停止、重建或改配置。\n- 这是只读调查：不要修改任何文件，也不要改变虚拟机、网络或系统状态。\n/);
});

test('host_access runs Codex with danger-full-access, and only when allowHostAccess is on', async () => {
  const calls = [];
  const c = createConductor({}, (_cfg, argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin });
    return Promise.resolve({ job_id: 'J', status: 'completed' });
  });
  for (const write of [true, false]) {
    await c.start({ ...RUN, host_access: true, write }, 'F:\\proj');
    const { argv, stdin } = calls.at(-1);
    assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--sandbox'), ['danger-full-access'], argv.join(' '));
    assert.match(stdin, /沙箱外运行/);
    (write ? assert.doesNotMatch : assert.match)(stdin, /只读调查/);
  }

  const done = { startResult: { job_id: 'J', status: 'completed' } };
  const exec = { agent: agentAt('F:\\work\\项目') };
  const off = harness({ config: done });
  await assert.rejects(off.tools.codex_run.execute({ ...RUN, host_access: true }, exec), /allowHostAccess/);
  assert.equal(off.calls.length, 0);
  assert.equal(off.tools.codex_run.parameters.properties.host_access, undefined);
  assert.match(off.tools.codex_run.description, /启动不了 Windows 程序[^。]*这类检查你自己跑/);

  const on = harness({ config: { ...done, allowHostAccess: true } });
  assert.equal(on.tools.codex_run.parameters.properties.host_access.type, 'boolean');
  // write=false 在提示里也禁止改虚拟机状态，参数说明必须告诉 DeepSeek
  assert.match(on.tools.codex_run.parameters.properties.host_access.description, /启动\/停止\/新建虚拟机[^。]*write=true/);
  assert.match(on.tools.codex_run.description, /传 host_access=true；不传时 WSL 里的 Codex 启动不了 Windows 程序/);
  assert.doesNotMatch(on.tools.codex_run.description, /你自己跑/);
  await on.tools.codex_run.execute({ ...RUN, host_access: true }, exec);
  assert.match(on.calls.at(-1).join(' '), /--sandbox danger-full-access/);
  await on.tools.codex_run.execute({ ...RUN, write: true }, exec);
  assert.match(on.calls.at(-1).join(' '), /--sandbox workspace-write/);
});

test('defaultHostAccess covers read, write and resume while explicit false restores the sandbox', async () => {
  const config = { allowHostAccess: true, defaultHostAccess: true, startResult: { job_id: 'J', status: 'completed' } };
  const { tools, calls } = harness({ config });
  const exec = { agent: agentAt('F:\\work\\项目') };
  const starts = [];
  const c = createConductor(config, (_cfg, argv, opts) => {
    starts.push({ argv, stdin: opts?.stdin });
    return Promise.resolve(config.startResult);
  });
  assert.equal(tools.codex_run.parameters.properties.host_access.default, true);
  assert.match(tools.codex_run.description, /默认[^。]*danger-full-access[^。]*省略 host_access/);
  assert.match(tools.codex_run.description, /resume 同样生效/);
  assert.match(tools.codex_run.description, /host_access=false[^。]*恢复沙箱/);

  for (const mode of [{}, { write: true }, { resume: 'T9' }]) {
    for (const access of [{}, { host_access: false }]) {
      const args = { ...RUN, ...mode, ...access };
      const host = args.host_access !== false;
      const sandbox = host ? ['danger-full-access'] : args.write ? ['workspace-write'] : [];
      await c.start(args, 'F:\\proj');
      const { argv, stdin } = starts.at(-1);
      assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--sandbox'), sandbox);
      assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--resume'), args.resume ? ['T9'] : []);
      (host ? assert.match : assert.doesNotMatch)(stdin, /沙箱外运行/);
      (host && !args.write ? assert.match : assert.doesNotMatch)(stdin, /只读调查/);
      if (host) assert.match(stdin, /不要删除、停止、重建或改配置/);

      await tools.codex_run.execute(args, exec);
      assert.deepEqual(calls.at(-1).filter((a, i, all) => all[i - 1] === '--sandbox'), sandbox);
      assert.deepEqual(calls.at(-1).filter((a, i, all) => all[i - 1] === '--resume'), args.resume ? ['T9'] : []);
      const card = tools.codex_run.presentCall(args);
      assert.equal(card.kind, host || args.write ? 'execute' : 'read');
      (host ? assert.match : assert.doesNotMatch)(card.title, /（主机）/);
    }
  }

  const off = harness({ config: { ...config, allowHostAccess: false } });
  await assert.rejects(off.tools.codex_run.execute(RUN, exec), /allowHostAccess/);
  assert.equal(off.calls.length, 0);
});

test('dispatch with a positive wait still returns a DSH background job without waiting', async () => {
  const jobs = fakeJobs();
  const wait = jobs.wait.bind(jobs);
  jobs.wait = (id, ms, ...rest) => {
    assert.equal(ms, 1);
    return wait(id, ms, ...rest);
  };
  const { tools, handlers, calls, answer } = harness({ jobs });
  const claim = [{ type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
  const exec = { agent: agentAt('F:\\work\\项目', claim) };
  const first = await tools.codex_run.execute({ ...RUN, wait_seconds: 600 }, exec);
  assert.equal(first.status, 'running');
  assert.equal(first.background_job_id, 'bg1');
  // DSH 的结束通知只有一行摘要，完整结果要用 job_output 读
  assert.match(first.note, /任务通知[\s\S]*job_output 读取 bg1 的完整结果/);
  assert.match(first.next, /等 DSH 的任务通知，再用 job_output 读取完整结果/);
  // 到点仍在执行：经任务表等，不直接等 runner；runner 只收到后台循环的查询
  assert.deepEqual(calls.slice(1), [['status', 'J1', '--wait', '20']]);
  assert.equal(jobs.started[0].spec.owner, 'S1');
  assert.equal(jobs.started[0].spec.kind, 'codex');
  const again = await tools.codex_status.execute({ job_id: 'J1' }, exec);
  assert.equal(again.background_job_id, 'bg1');
  assert.equal(jobs.started.length, 1);
  // 仍在执行：声称 Codex 在做不提醒
  handlers['agent/turn-stopping']({ agent: exec.agent, turn: 3 });
  assert.equal(nudges.length, 0);

  await answer('J1', { status: 'running', seconds_since_last_event: 7, last_activity: 'ran: pytest' });
  await answer('J1', { status: 'completed', thread_id: 'T', duration_s: 148.4, files_changed: [{ path: 'a.py' }], files_changed_total: 3,
    structured: { summary: 's', criteria: [{ criterion: 'pytest 通过', status: 'not_met', evidence: 'e' }, { criterion: 'A', status: 'met', evidence: 'e' },
      { criterion: 'B', status: 'met', evidence: 'e' }, { criterion: 'C', status: 'blocked', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] } });
  const done = await jobs.started[0].done;
  assert.ok(calls.some((a) => a.join(' ') === 'status J1 --wait 20'));
  assert.match(jobs.started[0].handle.progress[0], /7 秒：ran: pytest/);
  assert.equal(done.status, 'completed');
  // 任务表的 detail 和结果第一行都以一行摘要开头；文件数取 runner 的 files_changed_total
  assert.equal(done.detail, 'completed · 2 met / 1 not_met / 1 blocked · 3 files · 148 s · 待关注 · codex_output {"job_id":"J1","artifact":"report"}');
  assert.equal(done.result.split('\n')[0], 'completed · 2 met / 1 not_met / 1 blocked · 3 files · 148 s · 待关注  job_id: J1  thread_id: T');
  assert.match(done.result, /逐条汇报[\s\S]*✗ 1\. pytest 通过 —— e[\s\S]*下一步[\s\S]*报告或任务状态仍需核对/);
  assert.doesNotMatch(done.result, /resume=/);
  // 结束后不再算在执行中
  handlers['agent/turn-stopping']({ agent: exec.agent, turn: 3 });
  assert.equal(nudges.length, 1);
});

test('background job maps cancel, failure and lost monitoring', async () => {
  const jobs = fakeJobs();
  const { tools, handlers, calls, answer } = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await tools.codex_run.execute(RUN, exec);
  jobs.started[0].cancel();
  assert.deepEqual(calls.at(-1), ['cancel', 'J1']);
  await answer('J1', { status: 'cancelled' });
  const killed = await jobs.started[0].done;
  assert.equal(killed.status, 'killed');
  assert.equal(killed.detail, 'cancelled · codex_output {"job_id":"J1","artifact":"result"}');

  await tools.codex_run.execute(RUN, exec);
  await answer('J2', { status: 'failed', error_kind: 'timeout', error: 'x', duration_s: 30.2, files_changed: [], files_changed_total: 0 });
  const failed = await jobs.started[1].done;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.detail, 'failed · timeout · 30 s · codex_output {"job_id":"J2","artifact":"result"}');
  assert.match(failed.result, /^failed · timeout · 30 s {2}job_id: J2\n/);

  await tools.codex_run.execute(RUN, exec);
  // status 是只读的：连续 3 次 bridge_error 才放弃（电脑睡眠唤醒、发行版重启瞬间的一两次不算）
  for (let i = 0; i < 3; i++) await answer('J3', { status: 'failed', error_kind: 'bridge_error', error: 'wsl gone' });
  const lost = await jobs.started[2].done;
  assert.equal(lost.status, 'failed');
  assert.match(lost.result, /monitor_failed[\s\S]*wsl gone[\s\S]*可能仍在运行/);
  // 监控失败后 J3 不再算在执行中，防虚报提醒恢复（先于 codex_status，它会把 running 的 J3 重新记上）
  const claim = [{ type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
  const before = nudges.length;
  handlers['agent/turn-stopping']({ agent: agentAt('F:\\work\\项目', claim), turn: 4 });
  assert.equal(nudges.length, before + 1);
  // 后台登记已移除：按提示查询仍在运行的 J3 会重新登记
  assert.equal((await tools.codex_status.execute({ job_id: 'J3', wait_seconds: 0 }, exec)).background_job_id, 'bg4');
});

test('without a jobs service, a failing start() or an agent, codex_run keeps polling', async () => {
  for (const setup of [{ jobs: undefined }, { get: false }, { jobs: fakeJobs({ fail: true }) }]) {
    const { tools, calls, handlers } = harness(setup);
    const value = await tools.codex_run.execute({ ...RUN, wait_seconds: 5 }, { agent: agentAt('F:\\work\\项目') });
    assert.equal(value.status, 'running');
    assert.equal(value.background_job_id, undefined);
    assert.match(value.note, /等了 5 秒[\s\S]*codex_status/);
    // 照旧直接等 runner wait_seconds 秒
    assert.deepEqual(calls.slice(1), [['status', 'J1', '--wait', '5']]);
    const before = nudges.length;
    const claim = [{ type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
    handlers['agent/turn-stopping']({ agent: agentAt('F:\\work\\项目', claim), turn: 4 });
    assert.equal(nudges.length, before + 1);
  }
  // 没有 agent 也不登记
  const noAgent = fakeJobs();
  assert.equal((await harness({ jobs: noAgent }).tools.codex_run.execute({ ...RUN, cwd: 'F:\\x' }, {})).background_job_id, undefined);
  assert.equal(noAgent.started.length, 0);
  const jobs = fakeJobs();
  const { tools } = harness({ jobs });
  await tools.codex_status.execute({ job_id: 'J9', wait_seconds: 0 }, {});
  assert.equal(jobs.started.length, 0);
});

test('codex_status with an explicit wait returns the stored DSH result', async () => {
  const jobs = fakeJobs();
  const { tools, calls, answer } = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  const dispatched = await tools.codex_run.execute({ ...RUN, scope: ['src'] }, exec);
  const pending = tools.codex_status.execute({ job_id: dispatched.job_id, wait_seconds: 600 }, exec);
  await tick();
  // 还在等的时候任务表里已经有这一行，进度随后台循环刷新
  assert.equal(jobs.started.length, 1);
  // 任务表那一行带上任务摘要，看得出是哪件事
  assert.equal(jobs.started[0].spec.label, 'Codex J1 · 在 a.py 里修好 bug');
  await answer('J1', { status: 'running', seconds_since_last_event: 2, last_activity: 'ran: ls' });
  await answer('J1', { job_id: 'J1', status: 'completed', thread_id: 'T', duration_s: 12, files_changed: [{ path: 'README.md' }],
    structured: { summary: 's', criteria: [{ criterion: 'pytest 通过', status: 'met', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] } });
  const value = await pending;
  assert.match(jobs.started[0].handle.progress[0], /2 秒：ran: ls/);
  assert.equal(value.status, 'completed');
  assert.equal(value.background_job_id, undefined);
  const text = tools.codex_status.output.render({}, value)[0].text;
  assert.equal(text, jobs.started[0].result);
  assert.match(text, /^completed · 1 met · 1 files · 12 s · 待关注 {2}job_id: J1 {2}thread_id: T\n[\s\S]*超出 scope：README\.md/);
  // 结算时这次等待在等：算作已被等到，DSH 不另发通知；结果只交出这一次
  assert.deepEqual(jobs.unawaited, []);
  assert.equal(jobs.read('bg1', 'S1').result, undefined);
  assert.ok(calls.slice(1).every((a) => a.join(' ') === 'status J1 --wait 20'));
});

test('codex_status and codex_cancel on a background job wait through DSH, so no second notice is sent', async () => {
  const jobs = fakeJobs();
  const { tools, calls, answer } = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  // 交回的是后台任务存下的完整结果：codex_run 那次的 out_of_scope 和验收标准都在，不再查 runner
  await tools.codex_run.execute({ ...RUN, scope: ['src'] }, exec);
  const sent = calls.length;
  const status =tools.codex_status.execute({ job_id: 'J1', wait_seconds: 600 }, exec);
  await answer('J1', { job_id: 'J1', status: 'completed', thread_id: 'T', files_changed: [{ path: 'README.md' }] });
  const value = await status;
  assert.equal(value.status, 'completed');
  const text = tools.codex_status.output.render({}, value)[0].text;
  assert.equal(text, jobs.started[0].result);
  assert.match(text, /thread_id: T[\s\S]*报告或任务状态仍需核对[\s\S]*范围外改动待核实：README\.md/);
  assert.ok(calls.slice(sent).every((a) => a[3] === '20'));
  assert.deepEqual(jobs.unawaited, []);

  // jobs 服务交不出结果时退回 runner 查询
  const plain = fakeJobs();
  plain.read = undefined;
  const h = harness({ jobs: plain });
  await h.tools.codex_run.execute(RUN, exec);
  const fallback = h.tools.codex_status.execute({ job_id: 'J1', wait_seconds: 600 }, exec);
  h.finals.J1 = { job_id: 'J1', status: 'completed', thread_id: 'T' };
  await h.answer('J1', h.finals.J1);
  assert.equal((await fallback).thread_id, 'T');
  assert.ok(!h.calls.some((a) => a.join(' ') === 'status J1 --wait 600'));

  await tools.codex_run.execute(RUN, exec);
  const cancel = tools.codex_cancel.execute({ job_id: 'J2' }, exec);
  await answer('J2', { status: 'cancelled' });
  assert.equal((await cancel).status, 'cancelled');
  assert.deepEqual(jobs.unawaited, []);

  // 中途停止 codex_status：经 DSH 结束后台任务，runner 侧随之取消；等它结算完才抛出
  await tools.codex_run.execute(RUN, exec);
  const stop = new AbortController();
  const aborted = tools.codex_status.execute({ job_id: 'J3', wait_seconds: 600 }, { ...exec, signal: stop.signal });
  let rejected = false;
  aborted.catch(() => { rejected = true; });
  stop.abort();
  await tick();
  assert.equal(jobs.started[2].status, 'stopping');
  assert.deepEqual(calls.at(-1), ['cancel', 'J3']);
  assert.equal(rejected, false);
  await answer('J3', { status: 'cancelled' });
  await assert.rejects(aborted, /已被中止/);
  assert.deepEqual(jobs.unawaited, []);

  // 后台监控自己出错时存的只是提示，不原样交回：改查 runner，仍在运行就重新登记
  await tools.codex_run.execute(RUN, exec);
  const relost = tools.codex_status.execute({ job_id: 'J4', wait_seconds: 600 }, exec);
  for (let i = 0; i < 3; i++) await answer('J4', { status: 'failed', error_kind: 'bridge_error', error: 'wsl gone' });
  const back = await relost;
  assert.equal(back.status, 'running');
  assert.equal(back.background_job_id, 'bg5');
});

test('a failed cancel does not leave a wait that swallows the later completion notice', async () => {
  const jobs = fakeJobs();
  const { tools, answer, handlers } = harness({ jobs, config: { cancelResult: { status: 'failed', error_kind: 'bridge_error', error: 'x' } } });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await tools.codex_run.execute(RUN, exec);
  assert.equal((await tools.codex_cancel.execute({ job_id: 'J1' }, exec)).error_kind, 'bridge_error');
  const before = nudges.length;
  const claim = [{ type: 'assistant/message', data: { turn: 4, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
  handlers['agent/turn-stopping']({ agent: agentAt('F:\\work\\项目', claim), turn: 4 });
  assert.equal(nudges.length, before);
  await answer('J1', { status: 'completed' });
  await jobs.started[0].done;
  assert.deepEqual(jobs.unawaited, ['bg1']);
});

test('after a plugin reload the live background job is reused, not registered again', async () => {
  const jobs = fakeJobs();
  const before = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await before.tools.codex_run.execute(RUN, exec);
  const after = harness({ jobs });
  const value = await after.tools.codex_status.execute({ job_id: 'J1', wait_seconds: 0 }, exec);
  assert.equal(value.background_job_id, 'bg1');
  assert.equal(jobs.started.length, 1);
  await before.answer('J1', { status: 'completed' });
  await jobs.started[0].done;
});

test('reattaches pending owned jobs on reload or agent creation without redispatching', async () => {
  for (const alreadyLive of [true, false]) {
    const jobs = fakeJobs();
    const event = (type, seq, jobId, runnerId, owner = 'S1') => ({ type, seq, data: {
      jobId, owner, kind: 'codex', label: `Codex ${runnerId} · 原任务`,
    } });
    const agent = agentAt('/work/original', [
      event('job/registered', 0, 'native-old', 'OLD'),
      event('job/registered', 1, 'native-done', 'DONE'),
      event('job/settled', 2, 'native-done', 'DONE'),
      event('job/registered', 3, 'native-mismatch', 'MISMATCH'),
      event('job/registered', 4, 'native-other', 'OTHER', 'S2'),
    ]);
    const agents = { get: (id) => id === 'S1' ? agent : undefined, list: () => alreadyLive ? [agent] : [] };
    const report = { ...workflowSource(), job_id: 'OLD' };
    const old = { ...report, status: alreadyLive ? 'completed' : 'running' };
    const mismatch = { ...report, job_id: 'MISMATCH', context: { ...report.context, owner: 'S2' } };
    const h = harness({ jobs, agents, config: { listResult: argv => argv[argv.indexOf('--offset') + 1] === '0'
      ? { jobs: [mismatch, { ...old, status: 'unknown' }, { ...old, job_id: 'UNLINKED' }], next_offset: 1 }
      : { jobs: [old], next_offset: null } } });
    h.finals.OLD = alreadyLive ? report : { ...report, status: 'running', structured: undefined };
    h.finals.MISMATCH = { ...report, job_id: 'MISMATCH', context: { ...report.context, owner: 'S2' } };
    if (!alreadyLive) h.handlers['agent/created']({ agent });
    await h.answer('OLD', report);
    await jobs.started[0].done;
    await tick();
    h.handlers['agent/created']({ agent });
    await tick();
    assert.equal(jobs.started.length, 1);
    assert.equal(jobs.started[0].spec.owner, 'S1');
    assert.equal(jobs.started[0].status, 'completed');
    assert.match(jobs.started[0].result, /等待确认 CSV 格式/);
    assert.deepEqual(jobs.unawaited, ['bg1']);
    assert.ok(h.calls.some(argv => argv[0] === 'list' && argv[argv.indexOf('--offset') + 1] === '1'));
    assert.ok(h.calls.every(argv => argv[0] === 'list' || (argv[0] === 'status' && argv[1] === 'OLD' && argv[3] === '20')));
  }
});

test('terminal connection failures tell the planner to wait for recovery before dispatching again', async () => {
  const { tools, finals } = harness();
  finals.RECONNECT = { job_id: 'RECONNECT', status: 'failed', error_kind: 'reconnect_timeout',
    retryable: true, attempts: 3, sandbox: 'danger-full-access', thread_id: 'THREAD' };
  const timeout = await tools.codex_status.execute({ job_id: 'RECONNECT', wait_seconds: 0 });
  assert.match(timeout.next, /重连超时（已尝试 3 次）[\s\S]*恢复前不要重派[\s\S]*thread_id 填入 resume/);

  finals.ROUTER = { ...finals.RECONNECT, job_id: 'ROUTER', error_kind: 'router_down', thread_id: null };
  const router = await tools.codex_status.execute({ job_id: 'ROUTER', wait_seconds: 0 });
  assert.match(router.next, /本地路由不可达[\s\S]*恢复前不要重派[\s\S]*沿用原任务和授权再派/);
  assert.doesNotMatch(router.next, /resume/);
});

test('native cancellation failures stay visible while stopping and allow another cancellation', async () => {
  for (const cancelResult of [
    { status: 'failed', error_kind: 'bridge_error', error: 'WSL unavailable' },
    { then(_resolve, reject) { reject(new Error('mock cancel exception')); } },
  ]) {
    const jobs = fakeJobs();
    const { tools, calls, answer } = harness({ jobs, config: { cancelResult } });
    const exec = { agent: agentAt('F:\\work\\项目') };
    await tools.codex_run.execute(RUN, exec);
    assert.equal(jobs.kill('bg1', 'S1'), 'requested');
    await tick();
    assert.equal(jobs.get('bg1', 'S1').status, 'stopping');
    assert.match(jobs.get('bg1', 'S1').progress, /取消未确认[\s\S]*J1[\s\S]*(WSL unavailable|mock cancel exception)/);
    await answer('J1', { status: 'running', phase: 'executing', attempt: 1, last_activity: 'ran: pytest' });
    await tick();
    const value = await tools.codex_status.execute({ job_id: 'J1', wait_seconds: 0 }, exec);
    assert.equal(value.status, 'running');
    assert.match(value.last_activity, /取消未确认[\s\S]*J1[\s\S]*codex_status[\s\S]*codex_cancel/);
    assert.equal(jobs.kill('bg1', 'S1'), 'requested');
    await tick();
    assert.equal(calls.filter((a) => a[0] === 'cancel').length, 2);
    await answer('J1', { status: 'cancelled' });
    await jobs.started[0].done;
    assert.equal(jobs.get('bg1', 'S1').status, 'killed');
    assert.equal(jobs.kill('bg1', 'S1'), 'already-finished');
    assert.equal(calls.filter((a) => a[0] === 'cancel').length, 2);
  }
});

test('directory lock queue tells the planner to wait and distinguishes cancellation from partial execution', () => {
  const queued = { job_id: 'J1', status: 'running', phase: 'lock_wait', attempt: 0 };
  assert.match(nextStep(queued), /等待同目录写锁[\s\S]*尚未启动 Codex[\s\S]*codex_status[\s\S]*不要重复派活[\s\S]*codex_cancel/);
  const cancelled = nextStep({ ...queued, status: 'cancelled' });
  assert.match(cancelled, /已取消排队[\s\S]*尚未启动 Codex[\s\S]*没有取消持锁任务/);
  assert.doesNotMatch(cancelled, /可能已改|git status/);
  assert.match(nextStep({ ...queued, status: 'failed', error_kind: 'bridge_error' }), /未取得可信状态[\s\S]*可能仍在运行/);
});

test('directory lock queue is visible in native progress and cancelling it targets only that job', async () => {
  const jobs = fakeJobs();
  const { tools, calls, answer } = harness({ jobs,
    config: { allowHostAccess: true, defaultHostAccess: true, cancelResult: { status: 'cancelled', phase: 'lock_wait', attempt: 0 } } });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await tools.codex_run.execute(RUN, exec);
  await answer('J1', { status: 'running', phase: 'lock_wait', attempt: 0 });
  await tick();
  assert.match(jobs.get('bg1', 'S1').progress, /排队等待目录写锁/);
  assert.doesNotMatch(jobs.get('bg1', 'S1').progress, /第 0 轮|Codex 执行中/);
  const stopping = tools.codex_cancel.execute({ job_id: 'J1' }, exec);
  await answer('J1', { status: 'cancelled', phase: 'lock_wait', attempt: 0 });
  const result = await stopping;
  assert.match(result.next, /已取消排队[\s\S]*尚未启动 Codex/);
  assert.equal(jobs.get('bg1', 'S1').status, 'killed');
  assert.deepEqual(calls.filter((argv) => argv[0] === 'cancel'), [['cancel', 'J1']]);
  assert.equal(calls.filter((argv) => argv[0] === 'start').length, 1);
});

test('native output is observable without consuming or duplicating the final report', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs });
  await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  const reconnect = { job_id: 'J1', status: 'running', phase: 'codex_reconnecting', attempt: 1 };
  await answer('J1', reconnect);
  await tick();
  assert.match(jobs.get('bg1', 'S1').progress, /正在重连模型服务/);
  assert.match(nextStep(reconnect), /正在重连模型服务[\s\S]*不要重复派活/);
  const stage = { status: 'running', phase: 'retry_wait', attempt: 2, last_error_kind: 'transient', retry_at: Math.floor(Date.now() / 1000) + 60,
    execution_status: 'running', report_status: 'pending', review_status: 'pending' };
  await answer('J1', { ...stage, last_activity: 'first command', seconds_since_last_event: 1 });
  await answer('J1', { ...stage, last_activity: 'second command', seconds_since_last_event: 2 });
  await tick();
  assert.match(jobs.get('bg1', 'S1').progress, /等待重试[\s\S]*第 2 轮[\s\S]*transient[\s\S]*秒后重试[\s\S]*second command/);
  assert.equal(jobs.readAt('bg1', 0, 'S1').chunks.filter((c) => c.text.includes('等待重试')).length, 1);
  await answer('J1', { status: 'completed', log_dir: '/tmp/mock-runner/jobs/J1',
    structured: { summary: 'NATIVE-REPORT-ONCE', criteria: [{ criterion: 'rewritten criterion', status: 'met', evidence: 'e' }],
      files_changed: [], deviations: [], unresolved: [] } });
  await jobs.started[0].done;
  const before = jobs.get('bg1', 'S1');
  assert.equal(before.status, 'completed');
  assert.ok(before.output.total > 0);
  const observed = jobs.readAt('bg1', 0, 'S1');
  assert.ok(observed.chunks.every((c) => c.channel === 'log'));
  assert.match(observed.chunks.map((c) => c.text).join(''), /NATIVE-REPORT-ONCE[\s\S]*last_message\.txt[\s\S]*codex_output/);
  assert.deepEqual(jobs.readAt('bg1', 0, 'S1'), observed);
  assert.throws(() => jobs.get('bg1', 'another-session'), /another session/);
  const text = modelJobOutput(jobs, 'bg1', 'S1');
  assert.equal(text.split('NATIVE-REPORT-ONCE').length - 1, 1);
  assert.match(text, /pytest 通过/);
  assert.doesNotMatch(text, /first command|second command/);
  assert.doesNotMatch(modelJobOutput(jobs, 'bg1', 'S1'), /NATIVE-REPORT-ONCE/);
});

test('losing monitoring does not erase an unconfirmed native cancellation', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs,
    config: { cancelResult: { status: 'failed', error_kind: 'bridge_error', error: 'cancel bridge unavailable' } } });
  await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  jobs.kill('bg1', 'S1');
  await tick();
  for (let i = 0; i < 3; i++) await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'status bridge unavailable' });
  const done = await jobs.started[0].done;
  assert.equal(done.status, 'failed');
  assert.equal(done.detail, 'monitor_failed · codex_status {"job_id":"J1"}');
  assert.match(done.result, /^monitor_failed[\s\S]*取消未确认[\s\S]*J1[\s\S]*cancel bridge unavailable[\s\S]*codex_status/);
});

test('a report above the native limit keeps its complete artifact and paging entry after consumption', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-native-report-'));
  try {
    const report = { summary: 'LARGE-REPORT-START', criteria: Array.from({ length: 20 }, (_, i) => ({
      criterion: `${i + 1}. ${'验'.repeat(400)}`, status: 'met', evidence: '据'.repeat(800),
    })), files_changed: [], deviations: [], unresolved: [] };
    const original = JSON.stringify(report);
    writeFileSync(path.join(dir, 'last_message.txt'), original);
    const jobs = fakeJobs();
    const { tools, answer } = harness({ jobs });
    await tools.codex_run.execute({ ...RUN, acceptance: report.criteria.map((c) => c.criterion) }, { agent: agentAt('F:\\work\\项目') });
    await answer('J1', { status: 'completed', log_dir: dir, structured: report });
    await jobs.started[0].done;
    assert.ok(Buffer.byteLength(jobs.started[0].result) > 65536);
    const text = modelJobOutput(jobs, 'bg1', 'S1');
    assert.ok(Buffer.byteLength(text) <= 65536);
    assert.doesNotMatch(text, /LARGE-REPORT-START/);
    assert.match(text, /runner job_id: J1[\s\S]*last_message\.txt[\s\S]*result\.json[\s\S]*codex_output.*"artifact":"report".*"offset":0.*"limit":8000/);
    assert.ok(text.includes(dir));
    assert.doesNotMatch(modelJobOutput(jobs, 'bg1', 'S1'), /LARGE-REPORT-START/);
    // job_output 消费不影响原件；主分支 codex_output 的重复分页使用这份完整原件。
    assert.equal(readFileSync(path.join(dir, 'last_message.txt'), 'utf8'), original);
    assert.equal(readFileSync(path.join(dir, 'last_message.txt'), 'utf8'), original);
    assert.match(jobs.readAt('bg1', 0, 'S1').chunks.map((c) => c.text).join(''), /codex_output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collect preserves a result produced by an old background monitor after reload', async () => {
  const jobs = fakeJobs();
  let finish;
  jobs.start({ owner: 'S1', kind: 'codex', label: 'Codex J-old · old task',
    run: () => ({ done: new Promise((resolve) => { finish = resolve; }), cancel() {} }) });
  const { tools, calls } = harness({ jobs });
  const pending = tools.codex_status.execute({ job_id: 'J-old', wait_seconds: 600 }, { agent: agentAt('F:\\work\\项目') });
  await tick();
  const rendered = 'completed  job_id: J-old\noriginal acceptance and out_of_scope from the old monitor';
  finish({ status: 'completed', result: rendered });
  const value = await pending;
  assert.equal(value.rendered, rendered);
  assert.equal(jobs.started.length, 1);
  assert.deepEqual(calls, []);
  assert.equal(jobs.read('bg1', 'S1').result, undefined);
});

test('codex_* cards show a short title while pending and the one-line summary when done', () => {
  const { tools } = harness({ jobs: fakeJobs() });
  const run = tools.codex_run;
  const call = run.presentCall({ task: '修好登录页的报错\n细节……', acceptance: ['a'], write: true });
  assert.equal(call.card, 'generic');
  assert.equal(call.kind, 'execute');
  assert.equal(call.title, 'Codex · 修好登录页的报错');
  assert.equal(run.presentCall({ task: 'x'.repeat(80), acceptance: ['a'] }).kind, 'read');
  assert.match(run.presentCall({ task: 'x'.repeat(80) }).title, /^Codex · x{60}…$/);
  assert.equal(run.presentCall({ task: '再查一次', resume: 'T', host_access: true }).title, 'Codex 返工（主机） · 再查一次');
  // 重放时可能拿到任意参数，不能抛错
  assert.equal(run.presentCall(undefined).title, 'Codex');
  const done = { isError: false, content: [{ type: 'text', text: 'completed · 2 met / 1 blocked · 3 files · 148 s  job_id: J1  thread_id: T\n--- Codex 逐条汇报 ---' }] };
  assert.equal(run.presentResult({ task: '修好登录页的报错' }, done).title, 'Codex completed · 2 met / 1 blocked · 3 files · 148 s · 修好登录页的报错');
  assert.equal(run.presentResult({}, { isError: true, content: [{ type: 'text', text: 'Error: x' }] }), undefined);
  assert.equal(tools.codex_status.presentCall({ job_id: 'J1' }).title, 'Codex 状态 J1');
  assert.equal(tools.codex_status.presentResult({ job_id: 'J1' }, done).title, 'Codex 状态 J1 · completed · 2 met / 1 blocked · 3 files · 148 s');
  assert.equal(tools.codex_cancel.presentCall({ job_id: 'J1' }).title, '取消 Codex J1');
});

test('a run still starting at the deadline returns no undefined fields (DSH needs lossless JSON)', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs });
  const value = await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  assert.equal(value.status, 'running');
  assert.ok(!('last_activity' in value));
  assert.ok(Object.values(value).every((v) => v !== undefined));
  await answer('J1', { status: 'completed' });
  await jobs.started[0].done;
});

test('an abort before or during start never leaves Codex running unattended', async () => {
  const jobs = fakeJobs();
  const { tools, calls } = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  const early = new AbortController();
  early.abort();
  await assert.rejects(tools.codex_run.execute(RUN, { ...exec, signal: early.signal }));
  assert.equal(calls.length, 0);
  // start 还没返回时中止：拿到 job_id 后取消它，不登记后台任务
  const late = new AbortController();
  const pending = tools.codex_run.execute(RUN, { ...exec, signal: late.signal });
  late.abort();
  await assert.rejects(pending);
  assert.deepEqual(calls.map((a) => a[0]), ['start', 'cancel']);
  assert.equal(jobs.started.length, 0);
});

test('the planner prompt file starts as a template and is injected as a system prompt section, read fresh each time', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sub', 'planner-prompt.md');
  const sections = [];
  const systemPrompt = { section: (s) => sections.push(s) };
  const ctx = { tools: { register: () => {}, guard: () => {} }, on: () => {}, get: (k) => (k === 'systemPrompt' ? systemPrompt : undefined) };
  apply(ctx, { workspaces: [], plannerPromptFile: file });
  // 新建的模板只有注释：不注入任何内容
  assert.match(readFileSync(file, 'utf8'), /^<!--[\s\S]*-->\s*$/);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'codex-conductor:planner');
  assert.equal(sections[0].interpolate, false);
  assert.equal(sections[0].text(), '');
  // 改完文件下一次组装就生效；注释去掉，{{…}} 原样保留
  writeFileSync(file, '<!-- 说明 -->\n先列依赖，一次派一件。\n{{literal}}');
  assert.match(sections[0].text(), /^## 派活给 Codex 前的规划要求（用户设定）\n[\s\S]*\n\n先列依赖，一次派一件。\n\{\{literal\}\}$/);
  // 已有文件不会被模板覆盖；文件被删也不抛错
  apply(ctx, { workspaces: [], plannerPromptFile: file });
  assert.match(readFileSync(file, 'utf8'), /先列依赖/);
  rmSync(file);
  assert.equal(sections[0].text(), '');
  // 宿主没有 systemPrompt 服务、或同名段已登记（登记抛错）时照常加载其余功能
  const tools = {};
  const base = { tools: { register: (t) => { tools[t.name] = t; }, guard: () => {} }, on: () => {} };
  assert.doesNotThrow(() => apply(base, { workspaces: [], plannerPromptFile: file }));
  assert.doesNotThrow(() => apply({ ...base, get: () => ({ section() { throw new Error('already registered'); } }) },
    { workspaces: [], plannerPromptFile: file }));
  assert.ok(tools.codex_run && tools.codex_status && tools.codex_cancel);
});

test('a completed codex_run reminds the planner of the requirements only when some are set', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'planner-prompt.md');
  const run = async (text) => {
    writeFileSync(file, text);
    const { tools } = harness({ config: { startResult: { job_id: 'J', status: 'completed' }, plannerPromptFile: file } });
    return (await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') })).next;
  };
  assert.match(await run('一次派一件。'), /再对照系统提示词里的「派活给 Codex 前的规划要求」/);
  assert.doesNotMatch(await run('<!-- 只有注释 -->'), /规划要求/);
});

test('a cancelled run is not reported as a failure and warns about half-applied edits', () => {
  const next = nextStep({ status: 'cancelled', retryable: false }, ['A']);
  assert.match(next, /已取消[\s\S]*先问用户/);
  assert.match(next, /git status/);
  assert.doesNotMatch(next, /不可重试/);
});

test('a completed result shows the original criteria, clipped evidence and one-line details; other results keep every field', () => {
  const { tools } = harness();
  const render = (v) => tools.codex_run.output.render({}, v)[0].text;
  const report = { summary: 's', criteria: [{ criterion: '1. 改写过的甲', status: 'met', evidence: 'x'.repeat(900) },
    { criterion: '乙（改写）', status: 'blocked', evidence: 'e' }], files_changed: ['a.py'], deviations: [], unresolved: [] };
  const value = { status: 'completed', job_id: 'J', thread_id: 'T', cwd: '/mnt/f/p', log_dir: '/home/u/jobs/J', sandbox: 'workspace-write',
    attempts: 1, usage: { input_tokens: 9 }, forced_exit: false, truncated: true, duration_s: 12, commands_run: 3,
    files_changed: [{ path: 'a.py', change: 'modified' }], files_changed_total: 1, files_changed_source: 'snapshot', report, acceptance: ['甲原文', '乙原文'] };
  value.next = nextStep(value, value.acceptance);
  const text = render(value);
  assert.match(text, /\n✓ 1\. 甲原文 —— x{800}…（已截断，全文见 \/home\/u\/jobs\/J\/last_message\.txt）\n⛔ 2\. 乙原文 —— e\n/);
  assert.match(text, /\n--- 详细字段 ---\n任务目录：\/mnt\/f\/p\n改动文件（snapshot，共 1 个）：a\.py\(modified\)\n用量（统计范围未知，不是费用）：\{"input_tokens":9\}\n--- 下一步 ---\n/);
  assert.doesNotMatch(text, /forced_exit|truncated|commands_run|attempts|log_dir/);
  // 报告仍保留验收原文，旧 blocked 先检查原因。
  assert.match(value.next, /报告或任务状态仍需核对[\s\S]*先读完整报告和实际状态/);
  assert.doesNotMatch(value.next, /甲原文/);
  // 编号对不上时显示 Codex 写的条目，仍先检查旧阻塞。
  const shifted = { ...value, report: { ...report, criteria: [{ ...report.criteria[0], criterion: '2. 甲' }, report.criteria[1]] } };
  shifted.next = nextStep(shifted, shifted.acceptance);
  assert.match(render(shifted), /\n✓ 1\. 2\. 甲 —— /);
  assert.match(shifted.next, /报告或任务状态仍需核对/);
  assert.deepEqual(shifted.acceptance, ['甲原文', '乙原文']);
  // 失败的结果保留全部字段，便于排查
  assert.match(render({ status: 'failed', error_kind: 'timeout', error: 'boom', log_dir: '/home/u/jobs/K', attempts: 2, retryable: false }),
    /--- 详细字段 ---\n\{[\s\S]*"error": "boom"[\s\S]*"log_dir": "\/home\/u\/jobs\/K"/);
});

test('ignoreChanges reaches the runner as --ignore and tells Codex the matching files change on their own', async () => {
  const calls = [];
  const c = createConductor({ ignoreChanges: ['^logs/', '\\.tmp$'] }, (_cfg, argv, opts) => {
    calls.push({ argv, stdin: opts.stdin });
    return Promise.resolve({ job_id: 'J', status: 'running' });
  });
  // 只读和主机访问任务也带上：其他进程写的文件同样会让 Codex 核验时误判
  for (const args of [{ ...RUN, write: true }, { ...RUN, write: false }, { ...RUN, write: false, host_access: true }]) {
    await c.start(args, 'F:\\proj');
    const { argv, stdin } = calls.at(-1);
    assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--ignore'), ['^logs/', '\\.tmp$']);
    assert.match(stdin, /Python re 正则/);
    assert.match(stdin, /其他进程持续写入：\^logs\/、\\\.tmp\$。[^\n]*不要因此把验收标准标为 blocked；任务或验收标准本身要求查看或修改这些文件时照常处理/);
  }
  assert.doesNotMatch(composePrompt('做事情做事情', ['甲条件成立']), /其他进程持续写入/);
});

test('ignoreChanges keeps Python re syntax and displays skipped patterns reported by the runner', async () => {
  const warnings = [];
  const tools = {};
  const guards = [];
  const argvs = [];
  const patterns = ['(?P<log>^logs/)', '(?i)^cache/', '(?<log>^logs/)', '['];
  const ignore_warnings = ["忽略无效的 ignoreChanges Python re 正则 '(?<log>^logs/)'：unknown extension ?<l at position 1",
    "忽略无效的 ignoreChanges Python re 正则 '['：unterminated character set at position 0"];
  apply({ tools: { register: (t) => { tools[t.name] = t; }, guard: (g) => guards.push(g) }, on: () => {}, logger: { warn: (s) => warnings.push(s) } },
    { workspaces: ['F:\\work\\项目'], ignoreChanges: patterns, allowCommands: ['(?<cmd>^custom-check$)'] },
    (_cfg, argv) => { argvs.push(argv); return Promise.resolve({ job_id: 'J', status: 'completed', ignore_warnings }); });
  const value = await tools.codex_run.execute({ ...RUN, write: true, cwd: 'F:\\proj' }, {});
  assert.deepEqual(warnings, []);
  assert.deepEqual(argvs[0].filter((a, i) => argvs[0][i - 1] === '--ignore'), patterns);
  assert.equal(guards[0](call('wsl', { command: 'custom-check' })), undefined);
  assert.deepEqual(value.ignore_warnings, ignore_warnings);
  const text = tools.codex_run.output.render({}, value)[0].text;
  for (const warning of ignore_warnings) assert.ok(text.includes(warning), text);
});

test('running, cancelled and failed results keep every field in the details', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs });
  const render = (v) => tools.codex_run.output.render({}, v)[0].text;
  const bg = await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  assert.match(render(bg), /--- 详细字段 ---\n\{[\s\S]*"background_job_id": "bg1"[\s\S]*"note": "已登记为后台任务 bg1/);
  await answer('J1', { status: 'completed' });
  await jobs.started[0].done;
  const h = harness({ get: false });
  h.finals.J9 = { job_id: 'J9', status: 'running', seconds_since_last_event: 7, last_activity: 'ran: pytest' };
  h.finals.J8 = { job_id: 'J8', status: 'cancelled', retryable: false, log_dir: '/j/J8' };
  assert.match(render(await h.tools.codex_status.execute({ job_id: 'J9', wait_seconds: 0 }, {})),
    /--- 详细字段 ---\n\{[\s\S]*"seconds_since_last_event": 7[\s\S]*"last_activity": "ran: pytest"/);
  assert.match(render(await h.tools.codex_status.execute({ job_id: 'J8', wait_seconds: 0 }, {})), /--- 详细字段 ---\n\{[\s\S]*"log_dir": "\/j\/J8"/);
});

test('count or numbering mismatches retain Codex labels and inspect legacy blockers', () => {
  const { tools } = harness();
  const render = (v) => tools.codex_run.output.render({}, v)[0].text;
  const rep = (labels) => ({ summary: 's', criteria: labels.map((criterion, i) => ({ criterion, status: i ? 'blocked' : 'met', evidence: `e${i + 1}` })),
    files_changed: [], deviations: [], unresolved: [] });
  for (const [labels, acceptance] of [[['甲', '乙', '丙'], ['甲原文', '乙原文']], [['甲和乙', '丙'], ['甲原文', '乙原文', '丙原文']],
    [['2、乙', '1、甲'], ['甲原文', '乙原文']], [['2) 乙', '1) 甲'], ['甲原文', '乙原文']], [[' 2. 乙', ' 1. 甲'], ['甲原文', '乙原文']],
    [['第2条：乙', '第1条：甲'], ['甲原文', '乙原文']], [['２．乙', '１．甲'], ['甲原文', '乙原文']], [['2：乙', '1：甲'], ['甲原文', '乙原文']]]) {
    const value = { status: 'completed', sandbox: 'workspace-write', thread_id: 'T', report: rep(labels), acceptance };
    value.next = nextStep(value, acceptance);
    const text = render(value);
    labels.forEach((l, i) => assert.ok(text.includes(`\n${i ? '⛔' : '✓'} ${i + 1}. ${l} —— e${i + 1}\n`), `${l}\n${text}`));
    assert.match(value.next, /报告或任务状态仍需核对[\s\S]*先读完整报告和实际状态/);
    assert.deepEqual(value.acceptance, acceptance);
  }
  // 编号和位置一致、或者数字后面不是编号标点（3 个测试通过）时照常显示原文
  for (const labels of [['1. 甲', '2. 乙'], ['第1条 甲', '第2条 乙'], ['3 个测试通过', '2024 年数据已归档']]) {
    const value = { status: 'completed', sandbox: 'workspace-write', thread_id: 'T', report: rep(labels), acceptance: ['甲原文', '乙原文'] };
    assert.match(render(value), /\n✓ 1\. 甲原文 —— e1\n⛔ 2\. 乙原文 —— e2\n/, labels.join(' | '));
  }
});

test('codex_run shows the acceptance text when Codex rewrites the labels, right away and from the background', async () => {
  const acceptance = ['pytest tests/test_login.py 全部通过', 'a.py 第 40 行不再抛 NullPointer'];
  const structured = { summary: 's', criteria: [{ criterion: '登录测试通过', status: 'met', evidence: 'e1' },
    { criterion: '空指针修复', status: 'blocked', evidence: 'e2' }], files_changed: [], deviations: [], unresolved: [] };
  const done = { job_id: 'J1', status: 'completed', thread_id: 'T', sandbox: 'workspace-write', structured };
  const args = { ...RUN, acceptance, write: true };
  const exec = { agent: agentAt('F:\\work\\项目') };
  const now = harness({ config: { startResult: done } });
  const value = await now.tools.codex_run.execute(args, exec);
  const jobs = fakeJobs();
  const later = harness({ jobs });
  await later.tools.codex_run.execute(args, exec);
  await later.answer('J1', done);
  for (const text of [now.tools.codex_run.output.render({}, value)[0].text, (await jobs.started[0].done).result]) {
    assert.match(text, /\n✓ 1\. pytest tests\/test_login\.py 全部通过 —— e1\n⛔ 2\. a\.py 第 40 行不再抛 NullPointer —— e2\n/);
    assert.match(text, /下一步[\s\S]*报告或任务状态仍需核对/);
  }
});

test('host access settings do not turn unclassified blockers into permission escalation hints', async () => {
  const structured = { summary: 's', criteria: [{ criterion: 'Verify.ps1 输出 PASS', status: 'blocked', evidence: '/mnt/c/tools/pwsh.exe 没有任何输出' }],
    files_changed: [], deviations: [], unresolved: [] };
  const done = { job_id: 'J', status: 'completed', thread_id: 'T', sandbox: 'workspace-write', structured };
  for (const allowHostAccess of [true, false]) {
    const expected = /报告或任务状态仍需核对[\s\S]*先读完整报告和实际状态/;
    const r = harness({ config: { allowHostAccess, startResult: done } });
    const run = await r.tools.codex_run.execute({ ...RUN, write: true }, { agent: agentAt('F:\\work\\项目') });
    assert.match(run.next, expected);
    assert.doesNotMatch(run.next, /write=true|host_access=true|resume=/);
    const s = harness({ get: false, config: { allowHostAccess } });
    s.finals.J = done;
    const status = await s.tools.codex_status.execute({ job_id: 'J', wait_seconds: 0 }, {});
    assert.match(status.next, expected);
    assert.doesNotMatch(status.next, /write=true|host_access=true|resume=/);
  }
  // host_access=true、write=false：沙箱是 danger-full-access，codex_run 按参数知道它是只读调查
  const host = harness({ config: { allowHostAccess: true, startResult: { ...done, sandbox: 'danger-full-access',
    structured: { ...structured, criteria: [{ criterion: '建备份', status: 'blocked', evidence: '只读调查不能写文件' }] } } } });
  const readOnly = await host.tools.codex_run.execute({ ...RUN, write: false, host_access: true }, { agent: agentAt('F:\\work\\项目') });
  assert.match(readOnly.next, /报告或任务状态仍需核对/);
  assert.doesNotMatch(readOnly.next, /write=true|host_access=true|resume=/);
});

test('the slim completed view keeps the schema note, flags a truncated answer and a capped change list', () => {
  const { tools } = harness();
  const render = (v) => tools.codex_run.output.render({}, v)[0].text;
  const loose = render(withReport({ status: 'failed', error_kind: 'schema_invalid', error: 'x', retryable: false,
    final_message: 'done', truncated: true, log_dir: '/j' }));
  assert.match(loose, /--- Codex 最终答复（超过 8000 字已截断，全文见 \/j\/last_message\.txt） ---\ndone\n/);
  assert.match(loose, /--- 详细字段 ---\n执行：completed；报告：invalid；执行端自报检查：needs_attention\nCodex 没按 JSON 格式逐条汇报，核验时以 final_message 和实际文件为准。/);
  // runner 最多列 300 条：总数照实给，并说明只列了一部分
  const files = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i}.py`, change: 'modified' }));
  const capped = render({ status: 'completed', files_changed_source: 'snapshot', files_changed_total: 500, files_changed: files });
  assert.match(capped, /^completed · 500 files/);
  assert.match(capped, /改动文件（snapshot，共 500 个，只列出前 300 个，超出 scope 的检查也只看这些，其余的到任务目录里核对）：src\/f0\.py\(modified\)/);
});

test('a report that breaks the schema still renders, and clipping never leaves half a surrogate pair', () => {
  const { tools } = harness();
  const render = (report) => tools.codex_run.output.render({}, { status: 'completed', log_dir: '/j', report })[0].text;
  assert.match(render({ criteria: [{ criterion: 'c', status: 'blocked', evidence: null }, { criterion: 'd', status: 'met', evidence: 42 }] }),
    /\n⛔ 1\. c —— \n✓ 2\. d —— 42\n/);
  const text = render({ criteria: [{ criterion: 'c', status: 'met', evidence: `${'a'.repeat(799)}😀尾巴` }] });
  assert.match(text, /—— a{799}…（已截断，全文见 \/j\/last_message\.txt）/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text));
});

test('runProcess returns the last JSON line, passes stdin, and turns a hung or missing command into a bridge error', async () => {
  assert.deepEqual(await runProcess(process.execPath, ['-e', 'console.log("noise"); console.log(JSON.stringify({ status: "running", job_id: "J" }))']),
    { status: 'running', job_id: 'J' });
  assert.deepEqual(await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: '{"echo":1}' }), { echo: 1 });
  const started = Date.now();
  const hung = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 1000 });
  assert.equal(hung.error_kind, 'bridge_error');
  assert.match(hung.error, /超过 1 秒没有返回/);
  assert.ok(Date.now() - started < 10_000);
  assert.equal((await runProcess('dsh-conductor-no-such-command', [])).error_kind, 'bridge_error');
});

test('every runner call has an upper bound: status gets its wait plus slack, start and cancel 120 s', async () => {
  const seen = [];
  const run = (_cfg, argv, opts) => {
    seen.push([argv[0], opts?.timeoutMs]);
    if (argv[0] === 'status' && opts?.signal) {
      return new Promise((r) => opts.signal.addEventListener('abort', () => r({ status: 'failed', error_kind: 'bridge_error' })));
    }
    return Promise.resolve({ job_id: 'J', status: 'running' });
  };
  const c = createConductor({}, run);
  await c.start({ ...RUN, write: true }, 'F:\\proj');
  await c.waitJob('J', 30);
  await c.cancel('J');
  const ac = new AbortController();
  const pending = c.waitJob('J', 600, ac.signal);
  ac.abort();
  await assert.rejects(pending);
  assert.deepEqual(seen, [['start', 120000], ['status', 90000], ['cancel', 120000], ['status', 660000], ['cancel', 120000]]);
});

test('a bridge error on a known job says to query it before sending the task again', () => {
  assert.match(nextStep({ job_id: 'J7', status: 'failed', error_kind: 'bridge_error', retryable: true }),
    /J7 可能仍在运行[^\n]*codex_status[^\n]*不要直接重派/);
  // 未取得 job_id 时也不能断言尚未启动，先从历史找回，避免重复派发。
  assert.match(nextStep({ status: 'failed', error_kind: 'bridge_error', retryable: true }), /codex_jobs[\s\S]*不要直接重派/);
});

test('codex_cancel on a finished job returns its report and next step; a failed cancel says to query first', async () => {
  const structured = { summary: 's', criteria: [{ criterion: 'A', status: 'met', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] };
  const { tools } = harness({ config: { cancelResult: { job_id: 'J', status: 'completed', thread_id: 'T', sandbox: 'workspace-write', structured } } });
  const value = await tools.codex_cancel.execute({ job_id: 'J' }, {});
  assert.equal(value.report, structured);
  assert.equal(value.structured, undefined);
  assert.match(value.next, /逐条核验/);
  assert.match(tools.codex_cancel.output.render({}, value)[0].text, /逐条汇报[\s\S]*✓ 1\. A —— e/);
  const failed = harness({ config: { cancelResult: { status: 'failed', error_kind: 'bridge_error', error: 'x', retryable: true } } });
  assert.match((await failed.tools.codex_cancel.execute({ job_id: 'J2' }, {})).next, /J2 可能仍在运行/);
});

test('a single transient bridge_error does not end background monitoring; the next poll settles the job', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs });
  await tools.codex_run.execute(RUN, { agent: agentAt('F:\work\项目') });
  await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'blip' });
  await answer('J1', { status: 'completed', duration_s: 5 });
  const done = await jobs.started[0].done;
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.result, /monitor_failed/);
});

test('runProcess times out by 1 s ticks (host-sleep safe) and never overflows setTimeout; it forwards env and aborts', async () => {
  // 真正超时：1 秒刻度，很快到点
  const started = Date.now();
  const hung = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 1500 });
  assert.equal(hung.error_kind, 'bridge_error');
  assert.ok(Date.now() - started < 8000, `${Date.now() - started}`);
  // 超大 timeoutMs 不会被 Node 夹成 1ms 立刻触发：子进程 1.2 秒就正常返回
  const ok = await runProcess(process.execPath, ['-e', 'setTimeout(() => console.log(JSON.stringify({ ok: 1 })), 1200)'], { timeoutMs: 2 ** 31 + 10 ** 7 });
  assert.deepEqual(ok, { ok: 1 });
  // env 真的传进去（用独特变量名，避免继承环境里的 WSL_UTF8 混淆）
  assert.deepEqual(await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify({ v: process.env.DSH_CONDUCTOR_PROBE ?? null }))'],
    { env: { ...process.env, DSH_CONDUCTOR_PROBE: 'x' } }), { v: 'x' });
  // 中止：一个 8 秒的子进程被 200ms 后的 abort 结束，远早于自然退出
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const aborted = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { signal: ac.signal });
  assert.equal(aborted.error_kind, 'bridge_error');
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0}`);
});

test('runRunner forwards argv, stdin, signal, timeoutMs and WSL_UTF8 to the executor (not only to the fake run)', () => {
  let seen;
  const ac = new AbortController();
  runRunner({ distro: '', python: 'python3', runner: '/r.py', codexHome: '', codexBin: '', runnerHome: '' },
    ['start', '--cwd', 'F:\p'], { stdin: 'P', signal: ac.signal, timeoutMs: 5 }, (...a) => { seen = a; return { status: 'running' }; });
  assert.equal(seen[0], 'wsl.exe');
  assert.deepEqual(seen[1], ['-e', 'env', 'python3', '/r.py', 'start', '--cwd', 'F:\p']);
  assert.equal(seen[2].stdin, 'P');
  assert.equal(seen[2].signal, ac.signal);
  assert.equal(seen[2].timeoutMs, 5);
  assert.equal(seen[2].env.WSL_UTF8, '1');
});

test('codex_status validates wait_seconds and waitJob clamps it so the timeout cannot overflow', async () => {
  const { tools } = harness({ jobs: fakeJobs() });
  await assert.rejects(tools.codex_status.execute({ job_id: 'J', wait_seconds: -1 }, {}), /wait_seconds/);
  await assert.rejects(tools.codex_status.execute({ job_id: 'J', wait_seconds: 1.5 }, {}), /wait_seconds/);
  let seenMs;
  const c = createConductor({}, (_cfg, argv, opts) => { seenMs = opts?.timeoutMs; return Promise.resolve({ status: 'running' }); });
  await c.waitJob('J', 3_000_000);
  assert.equal(seenMs, 86_400 * 1000 + 60_000);
  assert.ok(seenMs < 2 ** 31 - 1);
});

test('codex_cancel on a job that had already ended does not tell the agent to send it again', async () => {
  const ended = (error_kind) => harness({ config: { cancelResult: { job_id: 'J', status: 'failed', error_kind, retryable: true,
    sandbox: 'workspace-write', thread_id: 'T', error: 'e' } } });
  for (const kind of ['worker_died', 'idle_timeout']) {
    const next = (await ended(kind).tools.codex_cancel.execute({ job_id: 'J' }, {})).next;
    assert.match(next, new RegExp(`在取消前已经结束（${kind}）`), kind);
    assert.doesNotMatch(next, /再派一次|resume=/, kind);
  }
  // 取消没赶上、任务已完成：提示先告知用户，再接完成后的核验下一步
  const doneCfg = { cancelResult: { job_id: 'J', status: 'completed', thread_id: 'T', sandbox: 'workspace-write',
    structured: { summary: 's', criteria: [{ criterion: 'A', status: 'met', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] } } };
  const completed = await harness({ config: doneCfg }).tools.codex_cancel.execute({ job_id: 'J' }, {});
  assert.match(completed.next, /取消没有生效：任务在取消前已经完成[\s\S]*逐条核验/);
  // 正常取消：警告可写任务可能改了一半
  const cancelled = await harness({ config: { cancelResult: { job_id: 'J', status: 'cancelled', retryable: false } } }).tools.codex_cancel.execute({ job_id: 'J' }, {});
  assert.match(cancelled.next, /已按本次调用取消[\s\S]*git status/);
});

test('a dead writer is told its edits may be partial and unlisted; a read-only dead job is not', () => {
  const dead = (sandbox) => ({ status: 'failed', error_kind: 'worker_died', retryable: true, sandbox, thread_id: sandbox === 'read-only' ? null : 'T' });
  const next = nextStep(dead('workspace-write'));
  assert.match(next, /可能已改了部分文件且没有改动清单[\s\S]*先用 codex_output[\s\S]*核对已有产物[\s\S]*只有确认有缺项[\s\S]*resume/);
  assert.doesNotMatch(next, /再派一次/);
  assert.match(nextStep(dead('danger-full-access')), /可能已改了部分文件且没有改动清单/);
  assert.doesNotMatch(nextStep(dead('read-only')), /可能已改了部分文件/);
});

test('a running poll resets the consecutive bridge_error count, so blips spread across activity do not end monitoring', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs });
  await tools.codex_run.execute(RUN, { agent: agentAt('F:\work\项目') });
  // 两次 bridge_error 后来一次 running（计数清零），再两次 bridge_error：从没有连续 3 次，任务照常完成
  await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'blip' });
  await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'blip' });
  await answer('J1', { status: 'running', seconds_since_last_event: 1, last_activity: 'ran: pytest' });
  await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'blip' });
  await answer('J1', { status: 'failed', error_kind: 'bridge_error', error: 'blip' });
  await answer('J1', { status: 'completed', duration_s: 5 });
  const done = await jobs.started[0].done;
  assert.equal(done.status, 'completed');
  assert.doesNotMatch(done.result, /monitor_failed/);
});

test('an aborted start or poll keeps the job id when cancellation fails', async () => {
  for (const phase of ['start', 'status']) {
    const stop = new AbortController();
    const calls = [];
    const run = async (_cfg, argv) => {
      calls.push(argv[0]);
      if (argv[0] === phase) stop.abort();
      return argv[0] === 'cancel'
        ? { status: 'failed', error_kind: 'bridge_error', error: 'WSL unavailable' }
        : { job_id: 'J7', status: 'running' };
    };
    let pending;
    if (phase === 'start') {
      const tools = {};
      apply({ tools: { register: (t) => { tools[t.name] = t; }, guard: () => {} }, on: () => {} }, {}, run);
      pending = tools.codex_run.execute({ ...RUN, cwd: 'F:\\proj' }, { signal: stop.signal });
    } else pending = createConductor({}, run).waitJob('J7', 1, stop.signal);
    await assert.rejects(pending, /J7[^\n]*取消未确认[\s\S]*WSL unavailable[\s\S]*codex_status 查询 J7/);
    assert.deepEqual(calls, [phase, 'cancel']);
  }
});

test('an aborted background wait distinguishes unconfirmed cancellation from a stopped task', async () => {
  const jobs = fakeJobs();
  const wait = jobs.wait.bind(jobs);
  jobs.wait = (id, ms, ...rest) => ms === 30_000 && jobs.started[0].status === 'stopping'
    ? Promise.resolve(jobs.view(jobs.started[0])) : wait(id, ms, ...rest);
  const { tools, answer } = harness({ jobs, config: { cancelResult: { status: 'failed', error_kind: 'bridge_error', error: 'WSL unavailable' } } });
  const stop = new AbortController();
  const exec = { agent: agentAt('F:\\work\\项目') };
  const { job_id } = await tools.codex_run.execute(RUN, exec);
  const pending = tools.codex_status.execute({ job_id, wait_seconds: 600 }, { ...exec, signal: stop.signal });
  const rejected = assert.rejects(pending, /J1[^\n]*已被中止[\s\S]*取消未确认[\s\S]*codex_status 查询 J1/);
  await tick();
  stop.abort();
  await rejected;
  await answer('J1', { status: 'completed' });
  await jobs.started[0].done;
  assert.deepEqual(jobs.unawaited, ['bg1']);
});

test('malformed report containers fall back to the original reply without hiding task status', async () => {
  for (const structured of [{ criteria: {} }, { criteria: [], deviations: 'unexpected' },
    { criteria: [], files_changed: 'a.py' }, { criteria: [null] }, []]) {
    const final_message = JSON.stringify(structured);
    const { tools } = harness({ config: { startResult: { status: 'completed', sandbox: 'read-only', structured, final_message } } });
    const value = await tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
    assert.equal(value.status, 'completed');
    assert.equal(value.report, undefined);
    assert.match(value.report_note, /字段格式不正确/);
    const text = tools.codex_run.output.render({}, value)[0].text;
    assert.ok(text.includes(final_message));
    assert.match(text, /Codex 最终答复[\s\S]*核验/);
  }
  const failed = withReport({ status: 'failed', error_kind: 'timeout', error: 'timed out', structured: { criteria: {} } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_kind, 'timeout');
});

test('dispatch reminders use jobs owned by the agent and survive a plugin reload', async () => {
  const jobs = fakeJobs();
  const before = harness({ jobs });
  const claim = [{ type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
  const owner = agentAt('F:\\work\\项目', claim);
  await before.tools.codex_run.execute(RUN, { agent: owner });
  const count = nudges.length;
  before.handlers['agent/turn-stopping']({ agent: { ...owner, id: 'OTHER' }, turn: 7 });
  assert.equal(nudges.length, count + 1);
  const after = harness({ jobs });
  after.handlers['agent/turn-stopping']({ agent: owner, turn: 7 });
  assert.equal(nudges.length, count + 1);
  await before.answer('J1', { status: 'completed' });
  await jobs.started[0].done;
  after.handlers['agent/turn-stopping']({ agent: owner, turn: 7 });
  assert.equal(nudges.length, count + 2);
});

test('a pre-aborted signal skips execution and status polling but still cancels the known job', async () => {
  const stop = new AbortController();
  stop.abort();
  const value = await runProcess(process.execPath, ['-e', 'console.log(JSON.stringify({ unexpected: true }))'], { signal: stop.signal });
  assert.equal(value.error_kind, 'bridge_error');
  assert.match(value.error, /调用前已被中止/);
  const { tools, calls, finals } = harness({ get: false });
  finals.J9 = { job_id: 'J9', status: 'running' };
  await assert.rejects(tools.codex_status.execute({ job_id: 'J9', wait_seconds: 600 }, { signal: stop.signal }), { name: 'AbortError' });
  assert.deepEqual(calls, [['cancel', 'J9']]);
});

test('canonical runner paths keep alias scopes consistent for run, status and cancel', async () => {
  const done = { status: 'completed', job_id: 'J', thread_id: 'T', sandbox: 'workspace-write',
    cwd: '/home/user/real', scope_paths: ['/home/user/real/src'],
    files_changed: [{ path: 'src/a.py', change: 'modified' }, { path: 'other.txt', change: 'modified' }] };
  const { tools, finals } = harness({ get: false, config: { startResult: done, cancelResult: done } });
  const run = await tools.codex_run.execute({ ...RUN, write: true, cwd: '/home/user/alias', scope: ['/home/user/alias/src'] }, {});
  finals.J = done;
  const status = await tools.codex_status.execute({ job_id: 'J', wait_seconds: 0 }, {});
  const cancel = await tools.codex_cancel.execute({ job_id: 'J' }, {});
  for (const value of [run, status, cancel]) {
    assert.deepEqual(value.out_of_scope, ['other.txt']);
    assert.match(value.next, /范围外改动待核实：other\.txt/);
  }
  const inScope = withReport({ ...done, files_changed: [done.files_changed[0]] });
  assert.deepEqual(inScope.out_of_scope, []);
});

test('execution, report validity and review state stay separate and retain the original context', () => {
  const structured = { summary: 'done', criteria: [{ criterion: '1. 检查', status: 'met', evidence: 'checked' }],
    files_changed: [], deviations: [], unresolved: [] };
  const context = { owner: 'S1', task: '原任务', acceptance: ['原始验收条件'], write: false };
  const value = withReport({ status: 'completed', structured, context });
  assert.equal(value.execution_status, 'completed');
  assert.equal(value.report_status, 'valid');
  assert.equal(value.review_status, 'needs_verification');
  assert.deepEqual(value.criteria_counts, { met: 1, not_met: 0, blocked: 0 });
  assert.deepEqual(value.acceptance, context.acceptance);
  for (const changed of [
    { structured: { ...structured, unresolved: ['missing evidence'] } },
    { structured: { ...structured, deviations: ['scope changed'] } },
    { structured: { ...structured, criteria: [] } },
    { structured: { ...structured, criteria: [{ ...structured.criteria[0], status: 'blocked' }] } },
    { out_of_scope: ['elsewhere.txt'] },
  ]) assert.equal(reviewState({ status: 'completed', structured, context, ...changed }).review_status, 'needs_attention');
  const invalid = withReport({ status: 'failed', error_kind: 'schema_invalid', final_message: 'plain text', context });
  assert.equal(invalid.status, 'completed');
  assert.equal(invalid.execution_status, 'completed');
  assert.equal(invalid.report_status, 'invalid');
  assert.equal(invalid.review_status, 'needs_attention');
  assert.equal(reviewState(invalid).report_status, 'invalid');
  assert.equal(withReport({ status: 'running' }).review_status, 'pending');
  assert.equal(withReport({ status: 'completed', structured: { ...structured, extra: true } }).report_status, 'invalid');
  assert.equal(withReport({ status: 'completed', structured: null }).report_status, 'invalid');
});

test('codex_run dispatches 22 criteria verbatim through stdin and renders every result', async () => {
  const acceptance = Array.from({ length: 22 }, (_, i) => `验收 ${i + 1}：保留 "CSV" 原文与数据 😀`);
  const structured = { summary: '逐条检查完成', criteria: acceptance.map((criterion, i) =>
    ({ criterion, status: i === 21 ? 'not_met' : 'met', evidence: `检查结果 ${i + 1}` })),
    files_changed: [], deviations: [], unresolved: [] };
  const h = harness({ config: { startResult: { job_id: 'J22', status: 'completed', structured } } });
  const args = { ...RUN, acceptance };
  const value = await h.tools.codex_run.execute(args, { agent: agentAt('F:\\work\\项目') });
  const starts = h.requests.filter(({ argv }) => argv[0] === 'start');
  assert.equal(starts.length, 1);
  assert.ok(starts[0].argv.includes('--context-json'));
  const envelope = JSON.parse(starts[0].stdin);
  assert.deepEqual(envelope.context, { owner: 'S1', task: args.task, acceptance, write: false });
  assert.ok(envelope.prompt.includes(acceptance.map((item, i) => `${i + 1}. ${item}`).join('\n')));
  assert.deepEqual(value.acceptance, acceptance);
  assert.deepEqual(value.report, structured);
  assert.deepEqual(value.criteria_counts, { met: 21, not_met: 1, blocked: 0 });
  const text = h.tools.codex_run.output.render({}, value)[0].text;
  assert.deepEqual(text.split('\n').filter((line) => /^[✓✗] \d+\./u.test(line)),
    acceptance.map((item, i) => `${i === 21 ? '✗' : '✓'} ${i + 1}. ${item} —— 检查结果 ${i + 1}`));
});

test('task context travels through stdin while direct library callers keep plain prompts', async () => {
  const seen = [];
  const conductor = createConductor({}, async (_cfg, argv, options) => { seen.push({ argv, ...options }); return { status: 'running', job_id: 'J' }; });
  const args = { ...RUN, task: '原任务含引号"和换行\n'.repeat(4000) };
  const context = { owner: 'S1', task: args.task, acceptance: args.acceptance, write: args.write };
  await conductor.start(args, '/work', undefined, context);
  assert.ok(seen[0].argv.includes('--context-json'));
  assert.deepEqual(JSON.parse(seen[0].stdin).context, context);
  assert.match(JSON.parse(seen[0].stdin).prompt, /验收标准/);
  assert.ok(seen[0].argv.join(' ').length < 1000);
  await conductor.start(RUN, '/work');
  assert.equal(seen[1].argv.includes('--context-json'), false);
  assert.match(seen[1].stdin, /^在 a.py/);
});

test('history filters preserve session links and output reads are bounded, repeatable and never cancel', async () => {
  const jobs = { list: (owner) => owner === 'S1' ? [{ id: 'BG', owner, kind: 'codex', label: 'Codex J · task', status: 'completed' }] : [] };
  const page = { text: '\u0000'.repeat(8000), eof: false, next_offset: 8000, source_path: '/jobs/J/last_message.txt' };
  const h = harness({ jobs, config: { listResult: { jobs: [{ job_id: 'J', thread_id: 'T' }], total: 1 }, outputResult: page } });
  const exec = { agent: agentAt('F:\\work\\项目') };
  const list = await h.tools.codex_jobs.execute({ session_id: 'current', needs_attention: true, limit: 10, offset: 2 }, exec);
  assert.equal(list.jobs[0].background_job_id, 'BG');
  assert.equal(list.jobs[0].owner, 'S1');
  assert.deepEqual(h.calls[0], ['list', '--limit', '10', '--offset', '2', '--owner', 'S1', '--needs-attention', '--job-id', 'J']);
  const request = { job_id: 'J', artifact: 'report', offset: 0, limit: 8000 };
  const first = await h.tools.codex_output.execute(request, exec);
  const second = await h.tools.codex_output.execute(request, exec);
  assert.deepEqual(first, second);
  const rendered = h.tools.codex_output.output.render(request, first)[0].text;
  assert.ok(Buffer.byteLength(rendered, 'utf8') < 65536);
  assert.deepEqual(h.calls.slice(1), Array(2).fill(['output', 'J', '--artifact', 'report', '--offset', '0', '--limit', '8000']));
  await assert.rejects(h.tools.codex_output.execute({ job_id: '../J' }, exec), /job_id/);
  await assert.rejects(h.tools.codex_output.execute({ job_id: 'J', limit: 8001 }, exec), /limit/);
  await assert.rejects(h.tools.codex_jobs.execute({ status: 'accepted' }, exec), /status/);
  await assert.rejects(h.tools.codex_jobs.execute({ offset: -1 }, exec), /offset/);
  assert.equal(h.calls.some((a) => a[0] === 'cancel'), false);
});

test('session journal links recover old jobs after the native task table has been cleared', async () => {
  const h = harness({ config: { listResult: { jobs: [{ job_id: 'OLD', thread_id: 'T' }], total: 1 } } });
  const agent = agentAt('F:\\work\\项目', [{ type: 'job/registered', seq: 0, data: {
    jobId: 'native-old', owner: 'S1', kind: 'codex', label: 'Codex OLD · 原任务',
  } }]);
  const value = await h.tools.codex_jobs.execute({ session_id: 'current' }, { agent });
  assert.equal(value.jobs[0].background_job_id, 'native-old');
  assert.ok(h.calls[0].includes('OLD'));
  assert.equal(h.calls[0].includes('--cwd'), false);
});

test('reading task history or output does not count as dispatching a claimed task', () => {
  const { handlers } = harness();
  for (const [i, name] of ['codex_jobs', 'codex_output'].entries()) {
    const turn = 3000 + i;
    const agent = agentAt('F:\\work\\项目', [
      { type: 'tool/call', data: { turn, name } },
      { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } },
    ]);
    const count = nudges.length;
    handlers['agent/turn-stopping']({ agent, turn });
    assert.equal(nudges.length, count + 1);
  }
});

test('history observes only the requested session, excludes inherited events and releases the snapshot', async () => {
  const tools = {};
  const calls = [];
  let disposed = 0;
  let fail = false;
  const event = (seq, id) => ({ type: 'job/registered', seq, data: { jobId: id, owner: 'S1', kind: 'codex', label: `Codex ${id} · task` } });
  const query = { async observeSession(owner, options) {
    assert.equal(owner, 'S1');
    assert.equal(options.projectionMode, 'none');
    if (fail) throw new Error('journal unavailable');
    return { events: [event(0, 'INHERITED'), event(1, 'OWN')], inheritedEventCount: 1, [Symbol.dispose]() { disposed++; } };
  } };
  apply({ tools: { register: (t) => { tools[t.name] = t; }, guard() {} }, on() {},
    get: (key) => key === 'sessionQuery' ? query : undefined }, { workspaces: ['*'] }, async (_cfg, argv) => {
    calls.push(argv);return { jobs: [{ job_id: 'OWN' }], total: 1 };
  });
  const value = await tools.codex_jobs.execute({ session_id: 'current' }, { agent: agentAt('/work') });
  assert.equal(value.jobs[0].background_job_id, 'OWN');
  assert.ok(calls[0].includes('OWN'));
  assert.equal(calls[0].includes('INHERITED'), false);
  assert.equal(disposed, 1);
  fail = true;
  await assert.rejects(tools.codex_jobs.execute({ session_id: 'current' }, { agent: agentAt('/work') }), /journal unavailable/);
  assert.equal(calls.length, 1);
});

test('plugin and real runner preserve context, full Unicode output and execution metadata', { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-bridge-'));
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const runner = fileURLToPath(new URL('./runner/codex_runner.py', import.meta.url));
  const work = path.join(root, 'work');
  const fake = path.join(root, 'fake.py');
  const reportFile = path.join(root, 'report.json');
  const received = path.join(root, 'received.json');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(work);
  const report = { summary: '跨语言验收🙂', criteria: [{ criterion: '1. self reported', status: 'met', evidence: '中文🙂'.repeat(12000) }],
    files_changed: [], deviations: [], unresolved: [] };
  writeFileSync(reportFile, JSON.stringify(report), 'utf8');
  writeFileSync(fake, `import json, os, sys\nfrom pathlib import Path\nprompt = sys.stdin.buffer.read().decode('utf-8')\n` +
    `Path(os.environ['FAKE_RECEIVED']).write_text(json.dumps({'prompt': prompt, 'argv': sys.argv[1:]}), encoding='utf-8')\n` +
    `report = Path(os.environ['FAKE_REPORT']).read_text(encoding='utf-8')\n` +
    `Path(sys.argv[sys.argv.index('-o') + 1]).write_text(report, encoding='utf-8')\n` +
    `for event in [{'type': 'thread.started', 'thread_id': 'bridge-thread'}, {'type': 'turn.started'}, ` +
    `{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': report}}, {'type': 'turn.completed', 'usage': {'input_tokens': 1}}]:\n` +
    ` print(json.dumps(event), flush=True)\n`, 'utf8');
  const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CODEX_RUNNER_HOME: path.join(root, 'runner'),
    CODEX_RUNNER_CMD: JSON.stringify([python, '-B', fake]), CODEX_RUNNER_ROUTER_URL: '', PYTHONDONTWRITEBYTECODE: '1',
    FAKE_REPORT: reportFile, FAKE_RECEIVED: received };
  const bridge = (_cfg, argv, options = {}) => runProcess(python, ['-I', '-B', runner, ...argv], { ...options, env });
  const tools = {};
  apply({ tools: { register: (t) => { tools[t.name] = t; }, guard() {} }, on() {} },
    { workspaces: ['*'], allowHostAccess: true, defaultHostAccess: true, reportSchema: fileURLToPath(new URL('./report.schema.json', import.meta.url)) }, bridge);
  const exec = { agent: agentAt(work) };
  const args = { task: '原任务与换行\n' + '中文🙂'.repeat(12000), acceptance: ['原始验收条件'], write: false, cwd: work, wait_seconds: 0 };
  let id;
  let ended = false;
  try {
    const started = await tools.codex_run.execute(args, exec);
    id = started.job_id;
    assert.ok(id);
    const done = await tools.codex_status.execute({ job_id: id, wait_seconds: 10 }, exec);
    ended = done.status === 'completed';
    assert.equal(done.status, 'completed');
    assert.equal(done.execution_status, 'completed');
    assert.equal(done.report_status, 'valid');
    assert.equal(done.review_status, 'needs_verification');
    assert.deepEqual(done.acceptance, args.acceptance);
    const sent = JSON.parse(readFileSync(received, 'utf8'));
    assert.ok(sent.prompt.startsWith(args.task));
    assert.ok(sent.argv.includes('sandbox_mode="danger-full-access"'));
    assert.ok(sent.argv.includes('approval_policy="never"'));
    const history = await tools.codex_jobs.execute({ session_id: 'current' }, exec);
    assert.equal(history.total, 1);
    assert.equal(history.jobs[0].thread_id, 'bridge-thread');
    assert.equal(history.jobs[0].review_status, 'needs_verification');
    const read = async (artifact) => {
      let text = '', offset = 0;
      for (;;) {
        const part = await tools.codex_output.execute({ job_id: id, artifact, offset, limit: 8000 }, exec);
        assert.equal(part.status, 'completed');
        text += part.text;
        if (part.eof) return text;
        assert.ok(part.next_offset > offset);
        offset = part.next_offset;
      }
    };
    assert.deepEqual(JSON.parse(await read('report')), report);
    const context = JSON.parse(await read('context'));
    assert.equal(context.task, args.task);
    assert.equal(context.owner, exec.agent.id);
    assert.deepEqual(context.acceptance, args.acceptance);
    const first = await tools.codex_output.execute({ job_id: id, offset: 0, limit: 8000 }, exec);
    assert.deepEqual(await tools.codex_output.execute({ job_id: id, offset: 0, limit: 8000 }, exec), first);
    const unowned = await tools.codex_run.execute({ ...RUN, cwd: work }, {});
    id = unowned.job_id;
    ended = false;
    const unownedDone = await tools.codex_status.execute({ job_id: id, wait_seconds: 10 }, {});
    ended = unownedDone.status === 'completed';
    assert.equal(unownedDone.status, 'completed');
    assert.equal(unownedDone.context.owner, null);
    const workspaceHistory = await tools.codex_jobs.execute({ cwd: work }, {});
    assert.equal(workspaceHistory.total, 2);
  } finally {
    if (id && !ended) await bridge({}, ['cancel', id]);
    rmSync(root, { recursive: true, force: true });
  }
});

const unconfirmedCancels = [
  ...['bridge_error', 'unknown_job', 'invalid_record'].map((error_kind) => ({ status: 'failed', error_kind, error: `mock ${error_kind}` })),
  { status: 'running' }, { status: 'stopping' }, { status: 'unknown' },
];

test('unconfirmed cancel responses release the native wait and never claim that the task ended', async () => {
  for (const cancelResult of unconfirmedCancels) {
    const jobs = fakeJobs();
    const h = harness({ jobs, config: { cancelResult } });
    const exec = { agent: agentAt('/mock/work') };
    await h.tools.codex_run.execute(RUN, exec);
    const pending = h.tools.codex_cancel.execute({ job_id: 'J1' }, exec);
    await tick();
    try {
      assert.equal(jobs.started[0].waiters.size, 0, JSON.stringify(cancelResult));
      const value = await pending;
      assert.equal(value.status, cancelResult.status);
      assert.equal(value.job_id, 'J1');
      assert.match(value.next, /取消未确认[\s\S]*J1[\s\S]*codex_jobs[\s\S]*codex_status[\s\S]*codex_cancel[\s\S]*不要重派/);
      assert.doesNotMatch(value.next, /已经结束|已按本次调用取消|没有结束任何进程|再派一次|resume=/);
    } finally {
      await h.answer('J1', { status: 'completed' });
      await jobs.started[0].done;
      await pending;
    }
    assert.deepEqual(jobs.unawaited, ['bg1']);
  }
});

test('native cancel keeps unknown records and nonterminal replies unconfirmed across progress updates', async () => {
  for (const cancelResult of unconfirmedCancels) {
    const jobs = fakeJobs();
    const h = harness({ jobs, config: { cancelResult } });
    await h.tools.codex_run.execute(RUN, { agent: agentAt('/mock/work') });
    assert.equal(jobs.kill('bg1', 'S1'), 'requested');
    await tick();
    const progress = jobs.get('bg1', 'S1').progress;
    assert.ok(progress.includes(cancelResult.error_kind ?? cancelResult.status));
    assert.match(progress, /取消未确认[\s\S]*J1[\s\S]*codex_jobs[\s\S]*codex_status/);
    await h.answer('J1', { status: 'running', phase: 'codex_running', attempt: 1 });
    await tick();
    assert.equal(jobs.get('bg1', 'S1').status, 'stopping');
    assert.match(jobs.get('bg1', 'S1').progress, /取消未确认[\s\S]*J1/);
    await h.answer('J1', { status: 'cancelled' });
    await jobs.started[0].done;
    assert.equal(jobs.get('bg1', 'S1').status, 'killed');
  }
});

test('an aborted start or poll preserves its job id for every unconfirmed cancel response', async () => {
  for (const cancelResult of unconfirmedCancels) {
    for (const phase of ['start', 'status']) {
      const stop = new AbortController();
      const calls = [];
      const run = async (_cfg, argv) => {
        calls.push(argv[0]);
        if (argv[0] === phase) stop.abort();
        return argv[0] === 'cancel' ? cancelResult : { job_id: 'J-uncertain', status: 'running' };
      };
      let pending;
      if (phase === 'start') {
        const tools = {};
        apply({ tools: { register: (t) => { tools[t.name] = t; }, guard() {} }, on() {} }, {}, run);
        pending = tools.codex_run.execute({ ...RUN, cwd: '/mock/work' }, { signal: stop.signal });
      } else pending = createConductor({}, run).waitJob('J-uncertain', 0, stop.signal);
      await assert.rejects(pending, (error) => {
        assert.match(error.message, /J-uncertain[^\n]*取消未确认[\s\S]*可能仍在运行[\s\S]*codex_jobs[\s\S]*codex_status[\s\S]*不要重派/);
        assert.ok(error.message.includes(cancelResult.error ?? cancelResult.status));
        return true;
      });
      assert.deepEqual(calls, [phase, 'cancel']);
    }
  }
  for (const result of [{ status: 'cancelled' }, { status: 'completed' }, { status: 'failed', error_kind: 'idle_timeout' }]) {
    const stop = new AbortController();
    stop.abort();
    const c = createConductor({}, async () => result);
    assert.equal(await c.cancel('J-confirmed', stop.signal), result);
    await assert.rejects(c.waitJob('J-confirmed', 0, stop.signal), { name: 'AbortError' });
  }
});

test('unknown or invalid runner records end monitoring with unknown execution and retained recovery entries', async () => {
  for (const error_kind of ['unknown_job', 'invalid_record']) {
    const jobs = fakeJobs();
    const h = harness({ jobs, config: { cancelResult: { status: 'failed', error_kind, error: `mock ${error_kind}` } } });
    await h.tools.codex_run.execute(RUN, { agent: agentAt('/mock/work') });
    await h.answer('J1', { status: 'running', log_dir: '/mock/runner/jobs/J1', phase: 'codex_running', attempt: 1 });
    await tick();
    jobs.kill('bg1', 'S1');
    await tick();
    const polls = h.calls.filter((a) => a[0] === 'status').length;
    await h.answer('J1', { status: 'failed', error_kind, error: `mock ${error_kind}` });
    const done = await jobs.started[0].done;
    assert.equal(h.calls.filter((a) => a[0] === 'status').length, polls);
    assert.equal(done.status, 'failed'); // DSH 的监控任务失败，不是 Codex 执行失败。
    assert.match(done.result, /^monitor_failed/);
    assert.match(done.result, /"execution_status": "unknown"[\s\S]*"report_status": "missing"[\s\S]*"review_status": "needs_attention"/);
    assert.match(done.result, /codex_jobs[\s\S]*codex_status[\s\S]*取消未确认[\s\S]*J1[\s\S]*完整结果入口[\s\S]*\/mock\/runner\/jobs\/J1\/result\.json[\s\S]*codex_output/);
    assert.ok(done.result.includes(error_kind));
    assert.doesNotMatch(done.result, /"execution_status": "failed"|在取消前已经结束/);
  }
});

test('unavailable observations mean unknown execution and currently missing report without changing raw status', () => {
  const values = [
    ...['bridge_error', 'unknown_job', 'invalid_record'].map((error_kind) => ({ status: 'failed', error_kind })),
    { status: 'monitor_failed' }, { status: 'unknown' },
  ];
  for (const input of values) {
    const value = withReport({ job_id: 'J-state', retryable: true, ...input });
    assert.equal(value.status, input.status);
    assert.equal(value.execution_status, 'unknown');
    assert.equal(value.report_status, 'missing');
    assert.equal(value.review_status, 'needs_attention');
    assert.match(nextStep(value), /当前未取得可信状态或报告[\s\S]*J-state[\s\S]*可能仍在运行[\s\S]*codex_jobs[\s\S]*codex_status[\s\S]*不要直接重派/);
    assert.doesNotMatch(nextStep(value), /失败可重试|再派一次|已经结束/);
  }
});

test('a start observation failure without a job id directs recovery through history instead of redispatch', async () => {
  const h = harness({ config: { startResult: { status: 'failed', error_kind: 'bridge_error', error: 'bridge timeout', retryable: true } } });
  const value = await h.tools.codex_run.execute(RUN, { agent: agentAt('F:\\work\\项目') });
  assert.equal(value.execution_status, 'unknown');
  assert.match(value.next, /未取得任务编号[\s\S]*codex_jobs[\s\S]*不要直接重派/);
  assert.doesNotMatch(value.next, /同样的参数再派/);
  assert.equal(h.calls.filter((a) => a[0] === 'start').length, 1);
});

test('history accepts and forwards the unknown execution filter', async () => {
  const h = harness({ config: { listResult: { jobs: [], total: 0 } } });
  assert.ok(h.tools.codex_jobs.parameters.properties.status.enum.includes('unknown'));
  await h.tools.codex_jobs.execute({ cwd: '/mock/work', status: 'unknown' }, {});
  assert.deepEqual(h.calls, [['list', '--limit', '20', '--offset', '0', '--cwd', '/mock/work', '--status', 'unknown']]);
});


test('runProcess removes abort listeners on success, error and timeout', async () => {
  for (const [command, argv, timeoutMs] of [
    [process.execPath, ['-e', 'console.log("{}")'], 5000],
    ['dsh-conductor-no-such-command', [], 5000],
    [process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 1],
  ]) {
    const { signal } = new AbortController();
    await runProcess(command, argv, { signal, timeoutMs });
    assert.equal(getEventListeners(signal, 'abort').length, 0, command);
  }
});


test('settings warns and defaults each invalid entry without losing valid configuration', async () => {
  const invalidTypes = { distro: 1, python: false, runner: [], codexBin: {}, codexHome: false, runnerHome: 1,
    routerCheckUrl: [], codexRoute: [], model: true, effort: {}, readOnlyEffort: 3, serviceTier: [],
    waitSeconds: '100', allowHostAccess: 'false', defaultHostAccess: 1, reportSchema: null,
    plannerPromptFile: [], runtimeProfileFile: {}, workspaces: {}, denyTools: 'edit', allowCommands: {}, ignoreChanges: 'logs' };
  for (const invalid of [invalidTypes, { waitSeconds: '', allowHostAccess: '', defaultHostAccess: '',
    workspaces: '', denyTools: '', allowCommands: '', ignoreChanges: '', codexRoute: '' }]) {
    const warnings = [];
    const tools = {};
    let loaded;
    apply({ tools: { register: t => { tools[t.name] = t; }, guard: () => {} }, on: () => {},
      logger: { warn: text => warnings.push(text) } }, invalid, async (cfg) => {
      loaded = cfg;
      return { job_id: 'J', status: 'completed' };
    });
    assert.equal(warnings.length, Object.keys(invalid).length);
    for (const key of Object.keys(invalid)) assert.ok(warnings.some(w => w.includes(key)), key);
    await tools.codex_run.execute({ ...RUN, cwd: '/work' }, {});
    assert.equal(loaded.python, 'python3');
    assert.equal(loaded.waitSeconds, 0);
    assert.equal(loaded.codexRoute, null);
    assert.equal(loaded.allowHostAccess, false);
    assert.equal(loaded.defaultHostAccess, false);
    assert.ok(loaded.runner.endsWith('/runner/codex_runner.py'));
    assert.equal(tools.codex_run.parameters.properties.timeoutSeconds, undefined);
  }
  const valid = harness({ config: { model: 'retained', waitSeconds: 0, codexRoute: null } });
  await valid.tools.codex_run.execute({ ...RUN, cwd: '/work' }, {});
  assert.ok(valid.calls[0].includes('retained'));
  const warnings = [];
  apply({ tools: { register: () => {}, guard: () => {} }, on: () => {},
    logger: { warn: text => warnings.push(text) } },
  { python: '', runner: '', timeoutSeconds: '', idleTimeoutSeconds: '', retries: '' });
  assert.deepEqual(warnings, []);
});

test('optional timeout and retry settings validate numbers and pass only configured runner flags', async () => {
  const keys = { timeoutSeconds: '--timeout', idleTimeoutSeconds: '--idle-timeout', retries: '--retries' };
  for (const config of [{}, { timeoutSeconds: null, idleTimeoutSeconds: undefined, retries: null },
    { timeoutSeconds: '', idleTimeoutSeconds: '', retries: '' },
    { timeoutSeconds: 7200.5, idleTimeoutSeconds: 1200, retries: 0 }]) {
    const h = harness({ config });
    await h.tools.codex_run.execute({ ...RUN, cwd: '/work' }, {});
    const argv = h.calls[0];
    for (const [key, flag] of Object.entries(keys)) {
      assert.equal(argv.includes(flag), config[key] != null && config[key] !== '', key);
      if (config[key] != null && config[key] !== '') assert.equal(argv[argv.indexOf(flag) + 1], String(config[key]));
    }
  }
  for (const [key, flag] of Object.entries(keys)) {
    for (const value of ['100', false, [], {}, NaN, Infinity, -1, ...(key === 'retries' ? [0.5] : [0])]) {
      const warnings = [];
      const tools = {};
      let argv;
      apply({ tools: { register: t => { tools[t.name] = t; }, guard: () => {} }, on: () => {},
        logger: { warn: text => warnings.push(text) } }, { [key]: value, model: 'retained' }, async (_cfg, args) => {
        argv = args;
        return { job_id: 'J', status: 'completed' };
      });
      assert.equal(warnings.length, 1, `${key}=${String(value)}`);
      assert.ok(warnings[0].includes(key));
      await tools.codex_run.execute({ ...RUN, cwd: '/work' }, {});
      assert.equal(argv.includes(flag), false);
      assert.ok(argv.includes('retained'));
    }
  }
});


test('pending scope checks fail closed on unverifiable list records without status queries', async () => {
  const prior = withReport(workflowSource('task_conflict'));
  for (const change of [{ cwd: null }, { scope_paths: undefined, scope: undefined }, { scope_paths: 'src' },
    { scope_paths: [null] }, { status: 'unknown' }, { error_kind: 'invalid_record' }]) {
    const h = harness({ config: { listResult: { jobs: [{ ...prior, ...change }] } } });
    await assert.rejects(h.tools.codex_run.execute({ ...RUN, write: true }, { agent: agentAt('/work/original') }), /无法核对.*写入范围/);
    assert.ok(h.calls.every(argv => argv[0] === 'list'));
  }
  const priorRow = { ...prior, scope_paths: null };
  const h = harness({ config: { listResult: argv => argv[argv.indexOf('--offset') + 1] === '0'
    ? { jobs: [], next_offset: 1 } : { jobs: [priorRow], next_offset: null } } });
  await assert.rejects(h.tools.codex_run.execute({ ...RUN, cwd: '/work/original', scope: ['src', 'other'], write: true },
    { agent: agentAt('/work/original') }), /范围冲突.*用户回答/);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(argv => argv[0] === 'list'));
});


test('codex_output exposes stderr and events as repeatable Unicode log pages', async () => {
  for (const artifact of ['stderr', 'events']) {
    const page = { job_id: 'J', artifact, text: '诊断😀', offset: 7, next_offset: 10, eof: false };
    const h = harness({ config: { outputResult: page } });
    const tool = h.tools.codex_output;
    assert.ok(tool.parameters.properties.artifact.enum.includes(artifact));
    assert.ok(tool.parameters.properties.artifact.description.includes(artifact));
    const args = { job_id: 'J', artifact, offset: 7, limit: 3 };
    assert.deepEqual(await tool.execute(args, {}), page);
    assert.deepEqual(await tool.execute(args, {}), page);
    assert.deepEqual(h.calls, Array(2).fill(['output', 'J', '--artifact', artifact, '--offset', '7', '--limit', '3']));
    const missing = { job_id: 'J', artifact, text: '', eof: true, next_offset: null, note: '没有该内容' };
    const absent = harness({ config: { outputResult: missing } });
    assert.deepEqual(await absent.tools.codex_output.execute({ job_id: 'J', artifact }, {}), missing);
    assert.deepEqual(absent.calls, [['output', 'J', '--artifact', artifact, '--offset', '0', '--limit', '4000']]);
    await assert.rejects(tool.execute({ job_id: 'J', artifact: 'unknown' }, {}), /artifact/);
  }
});


test('codex_summary renders error-kind totals for the full filtered range on every page', async () => {
  const summary = { total: 3, total_jobs: 9, groups: [], offset: 2, next_offset: null,
    error_kinds: { router_down: 4, idle_timeout: 2, schema_invalid: 1 } };
  const h = harness({ config: { summaryResult: summary } });
  const value = await h.tools.codex_summary.execute({ limit: 1, offset: 2 }, { agent: agentAt('/work') });
  assert.deepEqual(value, summary);
  const render = input => h.tools.codex_summary.output.render({}, input)[0].text;
  assert.match(render(value), /错误分类（全部匹配任务）：router_down=4、idle_timeout=2、schema_invalid=1/);
  assert.match(render({ ...summary, error_kinds: {} }), /错误分类（全部匹配任务）：无/);
  assert.match(render({ ...summary, error_kinds: undefined }), /错误分类（全部匹配任务）：未知/);
  assert.deepEqual(h.calls, [['summary', '--owner', 'S1', '--limit', '1', '--offset', '2']]);
});


test('pending tasks with explicitly null scope retain unrestricted dispatch semantics', async () => {
  const prior = { ...withReport(workflowSource('task_conflict')), scope_paths: null, scope: null };
  for (const scope of [undefined, ['src', 'other']]) {
    const h = harness({ config: { listResult: { jobs: [prior] }, startResult: { job_id: 'J', status: 'completed' } } });
    const value = await h.tools.codex_run.execute({ ...RUN, scope, write: true }, { agent: agentAt(prior.cwd) });
    assert.equal(value.job_id, 'J');
    assert.deepEqual(h.calls.map(argv => argv[0]), ['list', 'start']);
  }
});
