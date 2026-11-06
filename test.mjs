// node --test test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyCommand, splitCommand, decide, normPath, validateRun, composePrompt, createConductor, apply,
  outOfScope, nextStep, withReport, turnSummary, runnerArgv } from './index.mjs';

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
    "PWSH=/mnt/c/tools/pwsh.exe\ntimeout 180 \"$PWSH\" -NoProfile -File 'D:\\x\\proj\\tests\\Verify-Build.ps1' 2>&1 | tail -20",
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
  ]) assert.equal(readOnlyCommand(c), false, c);
});

test('splitCommand keeps quoted operators inside words', () => {
  assert.deepEqual(splitCommand("grep -E 'a|b;c' x | wc -l"), [['grep', '-E', 'a|b;c', 'x'], ['wc', '-l']]);
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
  assert.doesNotMatch(nextStep(withReport({ status: 'completed', thread_id: 'T' }), ['A']), /自报/);
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

test('conductor starts, waits with a bounded status call, and cancels on abort', async () => {
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
  await c.start({ ...args, effort: 'low', write: false, resume: undefined }, 'F:\\proj');
  assert.deepEqual(calls.at(-2).argv, ['start', '--cwd', 'F:\\proj', '--effort', 'low', '--model', 'some-model', '--service-tier', 'fast']);
  assert.match(calls[0].stdin, /pytest 通过/);
  assert.deepEqual(calls[1].argv, ['status', 'J1', '--wait', '30']);
  assert.equal(first.status, 'running');
  assert.equal(first.last_activity, 'ran: pytest (exit 0)');
  assert.match(first.note, /30 秒/);

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
  assert.equal(guards.length, 1);
  assert.match(guards[0](call('edit')), /已拒绝/);
  assert.match(tools[0].output.render({}, { status: 'completed', final_message: '完成', next: '核验' })[0].text,
    /Codex 最终答复[\s\S]*完成[\s\S]*下一步[\s\S]*核验/);
  const reportText = tools[0].output.render({}, { status: 'completed', final_message: '{}',
    report: { summary: '好了', criteria: [{ criterion: 'A', status: 'not_met', evidence: 'e' }], files_changed: [], deviations: [], unresolved: [] } })[0].text;
  assert.match(reportText, /逐条汇报[\s\S]*✗ 1\. A —— e/);
  assert.doesNotMatch(reportText, /Codex 最终答复/);

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
