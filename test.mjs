// node --test test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyCommand, splitCommand, decide, normPath, validateRun, composePrompt, createConductor, apply,
  outOfScope, taskCwd, nextStep, withReport, turnSummary, runnerArgv, runProcess, runRunner, PS_SYNTAX } from './index.mjs';

// apply() 会在 %LOCALAPPDATA% 下写加载标记和规划要求模板，测试时改到临时目录
process.env.LOCALAPPDATA = mkdtempSync(path.join(tmpdir(), 'conductor-test-'));

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

test('splitCommand keeps quoted operators inside words', () => {
  assert.deepEqual(splitCommand("grep -E 'a|b;c' x | wc -l"), [['grep', '-E', 'a|b;c', 'x'], ['wc', '-l']]);
  assert.deepEqual(splitCommand('cat "C:\\x\\y" "a\\"b\\\\"'), [['cat', 'C:\\x\\y', 'a"b\\']]);
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
  assert.equal(tools.length, 3);
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

test('codex_run validation requires acceptance criteria', () => {
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常' }), /acceptance/);
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: [] }), /acceptance/);
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
  assert.match(prompt, /单独的结论行）写进 summary 即算满足[\s\S]*不要因此标 blocked/);
});

test('scope check flags changes outside the allowed paths', () => {
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

test('report is surfaced and self-reported problems are flagged first', () => {
  const report = { summary: 's', criteria: [{ criterion: 'A', status: 'met', evidence: 'e' },
    { criterion: 'B', status: 'blocked', evidence: '冲突' }], files_changed: ['a'], deviations: ['归档与要求冲突'], unresolved: [] };
  const value = withReport({ status: 'completed', thread_id: 'T', structured: report });
  assert.equal(value.report, report);
  assert.equal(value.structured, undefined);
  const next = nextStep({ ...value, out_of_scope: ['README.md'] }, ['A', 'B']);
  // 条数和编号对得上时按编号指出：逐条汇报里显示的是验收标准原文
  assert.match(next, /1 条未满足或受阻：第 2 条（blocked）[\s\S]*偏离计划：归档与要求冲突[\s\S]*超出 scope：README\.md[\s\S]*resume="T"/);
  assert.match(next, /其他进程写的文件[\s\S]*不算 Codex 越界，也不用请用户决定/);
  // 只读任务不留会话：自己的 thread_id 不能续跑，续跑过的写任务线程可以
  const ro = { status: 'completed', sandbox: 'read-only', thread_id: 'W' };
  assert.match(nextStep(ro, ['A'], true), /resume="W"/);
  // codex_status 不传 resumed：只读任务带回 thread_id 说明续跑过写任务线程
  assert.match(nextStep(ro, ['A']), /resume="W"/);
  for (const n of [nextStep(ro, ['A'], false), nextStep({ ...ro, thread_id: null }, ['A'])]) {
    assert.doesNotMatch(n, /resume="/);
    assert.match(n, /重新派一个写全背景的完整任务/);
  }
  assert.match(nextStep({ ...ro, status: 'failed', retryable: true }, [], false), /不要带 resume/);
  assert.match(nextStep({ ...ro, status: 'failed', retryable: true }, [], true), /有 thread_id 时带 resume/);
  assert.doesNotMatch(nextStep(withReport({ status: 'completed', thread_id: 'T' }), ['A']), /自报/);
  // 沙箱外的任务续跑也要带 host_access，否则会回到沙箱
  assert.match(nextStep({ status: 'completed', sandbox: 'danger-full-access', thread_id: 'H' }, ['A']), /resume="H" 和 host_access=true/);
  assert.doesNotMatch(next, /host_access/);
  // Codex 没按 JSON 汇报：按完成处理，不当成失败
  const loose = withReport({ status: 'failed', error_kind: 'schema_invalid', error: 'x', retryable: false, final_message: 'done' });
  assert.equal(loose.status, 'completed');
  assert.match(loose.report_note, /JSON/);
});

test('flagged criteria point to write=true in read-only runs and to host_access for blocked Windows programs', () => {
  const rep = (...criteria) => ({ summary: 's', criteria: criteria.map(([criterion, status, evidence]) => ({ criterion, status, evidence })),
    files_changed: [], deviations: [], unresolved: [] });
  const RO = /这是只读任务[^\n]*write=true/;
  const ro = { status: 'completed', sandbox: 'read-only', report: rep(['A', 'blocked', '只读沙箱里不能写备份']) };
  assert.match(nextStep(ro, ['A']), RO);
  assert.match(nextStep({ ...ro, report: rep(['A', 'not_met', '没有写入备份']) }, ['A']), RO);
  assert.doesNotMatch(nextStep({ ...ro, report: rep(['A', 'met', 'e']) }, ['A']), /write=true/);
  // 续跑写任务线程的只读追问也提示，照旧可以 resume
  assert.match(nextStep({ ...ro, thread_id: 'W' }, ['A'], true), /这是只读任务[^\n]*write=true[\s\S]*resume="W"/);
  // host_access=true、write=false 的只读调查沙箱是 danger-full-access，由调用方告知
  const host = { status: 'completed', sandbox: 'danger-full-access', thread_id: 'H', report: rep(['A', 'blocked', '只读调查不能建备份']) };
  assert.match(nextStep(host, ['A'], false, { readOnly: true }), RO);
  assert.doesNotMatch(nextStep(host, ['A']), /write=true/);
  // 沙箱里受阻且提到 Windows 程序：开了 allowHostAccess 提示 host_access=true，否则提示自己跑
  const WIN = /受阻条目提到 Windows 程序[^\n]*host_access=true/;
  const ww = { status: 'completed', sandbox: 'workspace-write', thread_id: 'T' };
  for (const [criterion, evidence] of [['A', '/mnt/c/tools/pwsh.exe 没有任何输出'], ['pwsh.exe -File tests\\Verify.ps1 输出 PASS', '沙箱里无法执行'],
    ['A', 'WSL Interop 被挡住'], ['A', '无法连接 Hyper-V 虚拟机'], ['A', 'Get-VM Cmdlet 不可用'], ['A', '需要启动 Windows 程序'], ['A', 'C:\\Tools\\PWSH.EXE 报错']]) {
    assert.match(nextStep({ ...ww, report: rep([criterion, 'blocked', evidence]) }, ['A'], false, { hostAccess: true }), WIN, `${criterion} ${evidence}`);
  }
  const win = { ...ww, report: rep(['A', 'blocked', '/mnt/c/tools/pwsh.exe 没有任何输出']) };
  assert.match(nextStep(win, ['A']), /受阻条目提到 Windows 程序[^\n]*这类检查你自己跑/);
  assert.match(nextStep({ ...win, sandbox: 'read-only' }, ['A'], false, { hostAccess: true }), WIN);
  assert.doesNotMatch(nextStep({ ...win, sandbox: 'danger-full-access' }, ['A'], false, { hostAccess: true }), /Windows 程序/);
  // not_met 多是结果不对（比如产出 .exe 的编译失败了），met 的条目更不算
  for (const report of [rep(['go build 产出 bin/tool.exe', 'not_met', 'main.go:12: undefined: foo']),
    rep(['构建产物', 'met', 'dist/app.exe 已生成'], ['B', 'not_met', '测试失败']), rep(['A', 'blocked', '目标文件不存在'])]) {
    assert.doesNotMatch(nextStep({ ...ww, report }, report.criteria.map((c) => c.criterion), false, { hostAccess: true }), /Windows 程序|这是只读任务/);
  }
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

test('apply registers three tools, a guard and the false-dispatch check', () => {
  const tools = [];
  const guards = [];
  const handlers = {};
  apply({ tools: { register: (t) => tools.push(t), guard: (g) => guards.push(g) }, on: (ev, fn) => { handlers[ev] = fn; } },
    { workspaces: ['F:\\work\\项目'] });
  assert.deepEqual(tools.map((t) => t.name), ['codex_run', 'codex_status', 'codex_cancel']);
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
test('Test-PsSyntax.ps1 reports parse results and exit codes', { skip: pwshMissing && 'pwsh not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pssyntax-'));
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
function harness({ config = {}, jobs, get = true } = {}) {
  const tools = {};
  const handlers = {};
  const calls = [];
  const waiters = {};
  let n = 0;
  let closed = false;
  // finals：runner 已写下结果的任务，单次 status 查询返回它；cancelResult：cancel 的返回
  const finals = {};
  const { startResult, cancelResult, ...pluginConfig } = config;
  const run = (_cfg, argv) => {
    calls.push(argv);
    // answer() 放弃后让后台循环出错退出，否则进程挂住不结束
    if (closed) return Promise.reject(new Error('harness closed'));
    if (argv[0] === 'start') return Promise.resolve(startResult ?? { job_id: `J${++n}`, status: 'running' });
    if (argv[0] === 'status' && argv[3] === '20') return new Promise((r) => (waiters[argv[1]] ??= []).push(r));
    // 下一轮事件循环才答：后台循环的等待参数若不是 20，也不会只靠微任务空转、饿死 answer()
    if (argv[0] === 'status') return new Promise((r) => setImmediate(r, finals[argv[1]] ?? { job_id: argv[1], status: 'running', seconds_since_last_event: 1 }));
    return Promise.resolve(cancelResult ?? { job_id: argv[1], status: 'cancelled' });
  };
  const ctx = { tools: { register: (t) => { tools[t.name] = t; }, guard: () => {} }, on: (ev, fn) => { handlers[ev] = fn; },
    ...(get ? { get: (key) => (key === 'jobs' ? jobs : undefined) } : {}) };
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
  return { tools, handlers, calls, answer, finals };
}
const tick = () => new Promise((r) => setImmediate(r));
const nudges = [];
const agentAt = (cwd, log = []) => ({ id: 'S1', session: { header: { cwd }, log }, steer: (m) => nudges.push(m) });
const RUN = { task: '在 a.py 里修好 bug', acceptance: ['pytest 通过'], write: false, wait_seconds: 0 };

// 按 DSH 任务表的约定：结算时有 wait() 在等就算已送达，否则记进 unawaited（DSH 会为它另发通知）
function fakeJobs({ fail = false } = {}) {
  return {
    started: [],
    unawaited: [],
    start(spec) {
      if (fail) throw new Error('no job controller');
      const handle = { progress: [], updateProgress(t) { this.progress.push(t); } };
      const job = { spec, handle, id: `bg${this.started.length + 1}`, status: 'running', waiters: new Set(), ...spec.run(handle) };
      job.done.then((outcome) => {
        job.status = outcome.status;
        job.result = outcome.result;
        if (!job.waiters.size) this.unawaited.push(job.id);
        for (const w of job.waiters) w();
      });
      this.started.push(job);
      return job.id;
    },
    view: (j) => ({ id: j.id, kind: j.spec.kind, label: j.spec.label, owner: j.spec.owner, status: j.status, progress: j.handle.progress.at(-1) }),
    list(owner) { return this.started.filter((j) => j.spec.owner === owner).map(this.view); },
    // 和 DSH 一样：结算后的结果只随第一次 read 交出
    read(id) {
      const job = this.started.find((j) => j.id === id);
      const result = job.delivered ? undefined : job.result;
      job.delivered ||= result !== undefined;
      return { chunks: [], ...(result !== undefined ? { result } : {}), job: this.view(job) };
    },
    wait(id, ms, _owner, signal) {
      const job = this.started.find((j) => j.id === id);
      if (job.status !== 'running' && job.status !== 'stopping') return Promise.resolve(this.view(job));
      return new Promise((resolve, reject) => {
        const end = (fn) => () => { clearTimeout(timer); job.waiters.delete(settle); fn(); };
        const settle = end(() => resolve(this.view(job)));
        const timer = setTimeout(end(() => resolve(this.view(job))), ms);
        signal?.addEventListener('abort', end(() => reject(new Error('wait aborted'))), { once: true });
        job.waiters.add(settle);
      });
    },
    kill(id) {
      const job = this.started.find((j) => j.id === id);
      job.status = 'stopping';
      job.cancel();
      return 'requested';
    },
  };
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
  assert.deepEqual(scoped.slice(scoped.indexOf('--scope')), ['--scope', 'src', '--scope', 'tests/']);
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

test('a running job is registered once as a DSH background job and reports back on completion', async () => {
  const jobs = fakeJobs();
  const { tools, handlers, calls, answer } = harness({ jobs });
  const claim = [{ type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: 'Codex 正在做' }] } } }];
  const exec = { agent: agentAt('F:\\work\\项目', claim) };
  const first = await tools.codex_run.execute(RUN, exec);
  assert.equal(first.status, 'running');
  assert.equal(first.background_job_id, 'bg1');
  // DSH 的结束通知只有一行摘要，完整结果要用 job_output 读
  assert.match(first.note, /任务通知[\s\S]*job_output 读取 bg1 的完整结果/);
  assert.match(first.next, /等 DSH 的任务通知，再用 job_output 读取完整结果/);
  // 到点仍在执行：经任务表等，不直接等 runner；runner 只收到后台循环的查询
  assert.deepEqual(calls.slice(1), [['status', 'J1', '--wait', '20']]);
  assert.equal(jobs.started[0].spec.owner, 'S1');
  assert.equal(jobs.started[0].spec.kind, 'codex');
  const again = await tools.codex_status.execute({ job_id: 'J1', wait_seconds: 0 }, exec);
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
  assert.equal(done.detail, 'completed · 2 met / 1 not_met / 1 blocked · 3 files · 148 s');
  assert.equal(done.result.split('\n')[0], 'completed · 2 met / 1 not_met / 1 blocked · 3 files · 148 s  job_id: J1  thread_id: T');
  assert.match(done.result, /逐条汇报[\s\S]*✗ 1\. pytest 通过 —— e[\s\S]*下一步[\s\S]*2 条未满足[\s\S]*resume="T"/);
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
  assert.equal(killed.detail, 'cancelled');

  await tools.codex_run.execute(RUN, exec);
  await answer('J2', { status: 'failed', error_kind: 'timeout', error: 'x', duration_s: 30.2, files_changed: [], files_changed_total: 0 });
  const failed = await jobs.started[1].done;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.detail, 'failed · timeout · 30 s');
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

test('codex_run registers the DSH job at start and returns its stored result when it settles within the wait', async () => {
  const jobs = fakeJobs();
  const { tools, calls, answer } = harness({ jobs });
  const exec = { agent: agentAt('F:\\work\\项目') };
  const pending = tools.codex_run.execute({ ...RUN, scope: ['src'], wait_seconds: 600 }, exec);
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
  const text = tools.codex_run.output.render({}, value)[0].text;
  assert.equal(text, jobs.started[0].result);
  assert.match(text, /^completed · 1 met · 1 files · 12 s {2}job_id: J1 {2}thread_id: T\n[\s\S]*超出 scope：README\.md/);
  // 结算时这次等待在等：算作已被等到，DSH 不另发通知；结果只交出这一次
  assert.deepEqual(jobs.unawaited, []);
  assert.equal(jobs.read('bg1').result, undefined);
  assert.ok(calls.slice(1).every((a) => a.join(' ') === 'status J1 --wait 20'));
});

test('stopping codex_run mid-wait kills the DSH job and waits for it to settle before rethrowing', async () => {
  const jobs = fakeJobs();
  const { tools, calls, answer } = harness({ jobs });
  const stop = new AbortController();
  const pending = tools.codex_run.execute({ ...RUN, wait_seconds: 600 }, { agent: agentAt('F:\\work\\项目'), signal: stop.signal });
  let rejected = false;
  pending.catch(() => { rejected = true; });
  await tick();
  stop.abort();
  await tick();
  assert.equal(jobs.started[0].status, 'stopping');
  assert.deepEqual(calls.at(-1), ['cancel', 'J1']);
  assert.equal(rejected, false);
  await answer('J1', { status: 'cancelled' });
  // 中止抛明确的错误，而不是 jobs.wait 原始拒绝（会渲染成 Error: [object Object]）
  await assert.rejects(pending, /已被中止/);
  assert.equal(jobs.started[0].status, 'killed');
  assert.deepEqual(jobs.unawaited, []);
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
  assert.match(text, /thread_id: T[\s\S]*超出 scope：README\.md[\s\S]*1\. pytest 通过/);
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
  stop.abort();
  await tick();
  assert.equal(jobs.started[2].status, 'stopping');
  assert.deepEqual(calls.at(-1), ['cancel', 'J3']);
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

test('the planner prompt file starts as a template and is injected as a system prompt section, read fresh each time', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'planner-')), 'sub', 'planner-prompt.md');
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

test('a completed codex_run reminds the planner of the requirements only when some are set', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'planner-')), 'planner-prompt.md');
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
  assert.match(text, /\n--- 详细字段 ---\n任务目录：\/mnt\/f\/p\n改动文件（snapshot，共 1 个）：a\.py\(modified\)\n--- 下一步 ---\n/);
  assert.doesNotMatch(text, /input_tokens|forced_exit|truncated|commands_run|attempts|log_dir/);
  // 验收标准原文已在逐条汇报里，下一步按编号指出、不再重复列出
  assert.match(value.next, /第 2 条（blocked）[\s\S]*上面逐条汇报里的验收标准/);
  assert.doesNotMatch(value.next, /甲原文/);
  // 编号对不上（Codex 改了顺序）时显示 Codex 写的条目，下一步照旧列出原文
  const shifted = { ...value, report: { ...report, criteria: [{ ...report.criteria[0], criterion: '2. 甲' }, report.criteria[1]] } };
  shifted.next = nextStep(shifted, shifted.acceptance);
  assert.match(render(shifted), /\n✓ 1\. 2\. 甲 —— /);
  assert.match(shifted.next, /下面的验收标准[\s\S]*\n1\. 甲原文\n2\. 乙原文$/);
  // 失败的结果保留全部字段，便于排查
  assert.match(render({ status: 'failed', error_kind: 'timeout', error: 'boom', log_dir: '/home/u/jobs/K', attempts: 2, retryable: false }),
    /--- 详细字段 ---\n\{[\s\S]*"error": "boom"[\s\S]*"log_dir": "\/home\/u\/jobs\/K"/);
});

test('ignoreChanges reaches the runner as --ignore and tells Codex the matching files change on their own', async () => {
  const calls = [];
  const c = createConductor({ ignoreChanges: [/^logs\//, /\.tmp$/] }, (_cfg, argv, opts) => {
    calls.push({ argv, stdin: opts.stdin });
    return Promise.resolve({ job_id: 'J', status: 'running' });
  });
  // 只读和主机访问任务也带上：其他进程写的文件同样会让 Codex 核验时误判
  for (const args of [{ ...RUN, write: true }, { ...RUN, write: false }, { ...RUN, write: false, host_access: true }]) {
    await c.start(args, 'F:\\proj');
    const { argv, stdin } = calls.at(-1);
    assert.deepEqual(argv.filter((a, i) => argv[i - 1] === '--ignore'), ['^logs\\/', '\\.tmp$']);
    assert.match(stdin, /其他进程持续写入：\^logs\\\/、\\\.tmp\$。[^\n]*不要因此把验收标准标为 blocked；任务或验收标准本身要求查看或修改这些文件时照常处理/);
  }
  assert.doesNotMatch(composePrompt('做事情做事情', ['甲条件成立']), /其他进程持续写入/);
  // 配置里的正则：非法的警告后跳过，其余照常传给 runner
  const warnings = [];
  const tools = {};
  const argvs = [];
  apply({ tools: { register: (t) => { tools[t.name] = t; }, guard: () => {} }, on: () => {}, logger: { warn: (s) => warnings.push(s) } },
    { workspaces: [], ignoreChanges: ['^logs/', '['] }, (_cfg, argv) => { argvs.push(argv); return Promise.resolve({ job_id: 'J', status: 'completed' }); });
  await tools.codex_run.execute({ ...RUN, write: true, cwd: 'F:\\proj' }, {});
  assert.match(warnings[0], /ignoreChanges/);
  assert.deepEqual(argvs[0].filter((a, i) => argvs[0][i - 1] === '--ignore'), ['^logs\\/']);
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

test('count or numbering mismatches show Codex labels and keep the acceptance list', () => {
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
    assert.ok(value.next.endsWith(`\n${acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`), value.next);
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
    assert.match(text, /第 2 条（blocked）[\s\S]*上面逐条汇报里的验收标准/);
  }
});

test('allowHostAccess and a host_access read-only run reach the hints from codex_run and codex_status', async () => {
  const structured = { summary: 's', criteria: [{ criterion: 'Verify.ps1 输出 PASS', status: 'blocked', evidence: '/mnt/c/tools/pwsh.exe 没有任何输出' }],
    files_changed: [], deviations: [], unresolved: [] };
  const done = { job_id: 'J', status: 'completed', thread_id: 'T', sandbox: 'workspace-write', structured };
  for (const allowHostAccess of [true, false]) {
    const expected = allowHostAccess ? /提到 Windows 程序[^\n]*host_access=true/ : /提到 Windows 程序[^\n]*这类检查你自己跑/;
    const r = harness({ config: { allowHostAccess, startResult: done } });
    assert.match((await r.tools.codex_run.execute({ ...RUN, write: true }, { agent: agentAt('F:\\work\\项目') })).next, expected);
    const s = harness({ get: false, config: { allowHostAccess } });
    s.finals.J = done;
    assert.match((await s.tools.codex_status.execute({ job_id: 'J', wait_seconds: 0 }, {})).next, expected);
  }
  // host_access=true、write=false：沙箱是 danger-full-access，codex_run 按参数知道它是只读调查
  const host = harness({ config: { allowHostAccess: true, startResult: { ...done, sandbox: 'danger-full-access',
    structured: { ...structured, criteria: [{ criterion: '建备份', status: 'blocked', evidence: '只读调查不能写文件' }] } } } });
  assert.match((await host.tools.codex_run.execute({ ...RUN, write: false, host_access: true }, { agent: agentAt('F:\\work\\项目') })).next,
    /这是只读任务[^\n]*write=true[\s\S]*resume="T" 和 host_access=true/);
});

test('the slim completed view keeps the schema note, flags a truncated answer and a capped change list', () => {
  const { tools } = harness();
  const render = (v) => tools.codex_run.output.render({}, v)[0].text;
  const loose = render(withReport({ status: 'failed', error_kind: 'schema_invalid', error: 'x', retryable: false,
    final_message: 'done', truncated: true, log_dir: '/j' }));
  assert.match(loose, /--- Codex 最终答复（超过 8000 字已截断，全文见 \/j\/last_message\.txt） ---\ndone\n/);
  assert.match(loose, /--- 详细字段 ---\nCodex 没按 JSON 格式逐条汇报，核验时以 final_message 和实际文件为准。/);
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
  // 启动时就出错（还没有 job_id）照旧按可重试处理
  assert.match(nextStep({ status: 'failed', error_kind: 'bridge_error', retryable: true }), /这次失败可重试/);
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
  assert.match(nextStep(dead('workspace-write')), /可能已改了部分文件且没有改动清单/);
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
  const pending = tools.codex_run.execute({ ...RUN, wait_seconds: 600 }, { agent: agentAt('F:\\work\\项目'), signal: stop.signal });
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
    assert.match(value.next, /超出 scope：other\.txt/);
  }
  const inScope = withReport({ ...done, files_changed: [done.files_changed[0]] });
  assert.deepEqual(inScope.out_of_scope, []);
});
