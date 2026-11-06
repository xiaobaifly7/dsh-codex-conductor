// node --test test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyCommand, splitCommand, decide, normPath, validateRun, composePrompt, createConductor, apply,
  outOfScope, nextStep, withReport, turnSummary, runnerArgv, PS_SYNTAX } from './index.mjs';

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

test('extra allowCommands extend the list', () => {
  assert.equal(readOnlyCommand('./verify.sh --check', [/^\.\/verify\.sh --check$/]), true);
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
  validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest tests/test_login.py 全部通过'] });
  assert.throws(() => validateRun({ task: '修复登录页的空指针异常', acceptance: ['pytest 通过'], scope: [''] }), /scope/);
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

test('report is surfaced and self-reported problems are flagged first', () => {
  const report = { summary: 's', criteria: [{ criterion: 'A', status: 'met', evidence: 'e' },
    { criterion: 'B', status: 'blocked', evidence: '冲突' }], files_changed: ['a'], deviations: ['归档与要求冲突'], unresolved: [] };
  const value = withReport({ status: 'completed', thread_id: 'T', structured: report });
  assert.equal(value.report, report);
  assert.equal(value.structured, undefined);
  const next = nextStep({ ...value, out_of_scope: ['README.md'] }, ['A', 'B']);
  assert.match(next, /1 条未满足或受阻：B（blocked）[\s\S]*偏离计划：归档与要求冲突[\s\S]*超出 scope：README\.md[\s\S]*resume="T"/);
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
const RUN = { task: '在 a.py 里修好 bug', acceptance: ['pytest 通过'], wait_seconds: 0 };

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
  await answer('J3', { status: 'failed', error_kind: 'bridge_error', error: 'wsl gone' });
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
    const { tools, calls } = harness(setup);
    const value = await tools.codex_run.execute({ ...RUN, wait_seconds: 5 }, { agent: agentAt('F:\\work\\项目') });
    assert.equal(value.status, 'running');
    assert.equal(value.background_job_id, undefined);
    assert.match(value.note, /等了 5 秒[\s\S]*codex_status/);
    // 照旧直接等 runner wait_seconds 秒
    assert.deepEqual(calls.slice(1), [['status', 'J1', '--wait', '5']]);
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
  assert.equal(jobs.started[0].spec.label, 'Codex J1');
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
  await assert.rejects(pending, /aborted/);
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
  await assert.rejects(aborted, /aborted/);
  assert.deepEqual(jobs.unawaited, []);

  // 后台监控自己出错时存的只是提示，不原样交回：改查 runner，仍在运行就重新登记
  await tools.codex_run.execute(RUN, exec);
  const relost = tools.codex_status.execute({ job_id: 'J4', wait_seconds: 600 }, exec);
  await answer('J4', { status: 'failed', error_kind: 'bridge_error', error: 'wsl gone' });
  const back = await relost;
  assert.equal(back.status, 'running');
  assert.equal(back.background_job_id, 'bg5');
});

test('a failed cancel does not leave a wait that swallows the later completion notice', async () => {
  const jobs = fakeJobs();
  const { tools, answer } = harness({ jobs, config: { cancelResult: { status: 'failed', error_kind: 'bridge_error', error: 'x' } } });
  const exec = { agent: agentAt('F:\\work\\项目') };
  await tools.codex_run.execute(RUN, exec);
  assert.equal((await tools.codex_cancel.execute({ job_id: 'J1' }, exec)).error_kind, 'bridge_error');
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
