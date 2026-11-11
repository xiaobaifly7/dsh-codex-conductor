import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProductReads, plannerReadTargets, readPath, readOnlyCommand, shellReadTargets, wslPath } from './guard.mjs';
import { apply, nextStep } from './index.mjs';
import './guard.test.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const call = (name, args = {}, owner = 'S1', cwd = '/repo') => ({ name, arguments: args, agent: { id: owner, session: { header: { cwd } } } });

test('products blocks file/search readers including MCP aliases and every mixed target', async () => {
  const scope = createProductReads({ plannerReadAllow: [] }, async owner => ({ status: 'completed', owner, paths: [] }));
  scope.add('S1', ['/repo/product.md']);
  for (const [name, args] of [
    ['read', { file_path: '/repo/product.md' }], ['ops_read_files', { paths: ['/repo/product.md'] }],
    ['mcp__context__ops_read_files', { files: [{ path: '/repo/product.md' }] }],
    ['mcp__fs__read_file', { path: '/repo/product.md' }], ['read_image', { file_path: '/repo/product.md' }],
    ['wsl-read', { path: '/repo/product.md' }], ['wsl-grep', { path: '/repo/product.md', pattern: 'fact' }],
    ['ops_grep', { path: '/repo/product.md', pattern: 'fact' }], ['grep', { path: '/repo/product.md', pattern: 'fact' }],
    ['mcp__serena__find_symbol', { relative_path: '/repo/product.md', include_body: true }],
    ['mcp__serena__get_symbols_overview', { relative_path: '/repo/product.md' }],
    ...['ops_inspect_local_file', 'ops_read_pdf', 'ops_read_docx', 'ops_read_table', 'ops_diff'].map(name => [name, { path: '/repo/product.md' }]),
  ]) {
    assert.equal(await scope.check(call(name, args), '/repo'), undefined, name);
    const denied = await scope.check(call(name, { ...args, paths: ['/repo/product.md', '/repo/raw.js'] }), '/repo');
    assert.match(denied, /codex_run.*codex_verify/, name);
    for (const text of ['已拒绝', '原料', '不要换命令、语言或工具入口重试']) assert.ok(denied.includes(text), `${name}: ${text}`);
  }
  assert.match(await scope.check(call('read', { file_path: '/repo/product.md' }, 'S2'), '/repo'), /原料/);
  assert.match(await scope.check(call('ops_grep', { pattern: 'fact' }), '/repo'), /原料/);
  assert.match(await scope.check(call('ops_read_files', {}), '/repo'), /原料/);
  assert.match(await scope.check(call('mcp__serena__find_referencing_symbols', { relative_path: '/repo/product.md' }), '/repo'), /原料/);
  assert.equal(await scope.check(call('ops_read_files', { files: [{ path: 'product.md' }] }), '/different-live-directory'), undefined);
  assert.match(await scope.check(call('ops_read_files', { files: [{ path: 'product.md' }], cwd: '/repo' }, 'S1', '/other'), '/repo'), /原料/);
  assert.match(await scope.check(call('ops_grep', { path: 'product.md', outputMode: 'count' }, 'S1', '/other'), '/repo'), /原料/);
  assert.deepEqual(plannerReadTargets(call('ops_glob', { pattern: '**/*.js' })), []);
});

test('products covers shell content commands, redirection, options and uncertain paths', async () => {
  const scope = createProductReads({ plannerReadAllow: [] }, async owner => ({ status: 'completed', owner, paths: [] }));
  scope.add('S1', ['/repo/product']);
  const commands = [
    'cat FILE', 'head -n 4 FILE', 'tail -20 FILE', 'wc -l FILE', "sed -n '1,5p' FILE", "awk '{print $1}' FILE",
    "grep 'fact' FILE", "egrep 'fact' FILE", "fgrep 'fact' FILE", "rg 'fact' FILE", 'nl FILE', 'cut -f 1 FILE',
    'strings FILE', 'hexdump -C FILE', 'od -c FILE', 'dd if=FILE count=1', 'diff FILE /repo/product', 'cmp FILE /repo/product',
    'sha256sum FILE', 'sha1sum FILE', 'md5sum FILE', 'sort FILE', 'uniq FILE', 'paste FILE', 'column FILE',
    "jq '.x' FILE", 'file FILE', 'readelf -h FILE', 'objdump -h FILE', 'nm FILE', 'gzip -t FILE',
    'iconv -f UTF-8 -t UTF-8 FILE', 'base64 -d FILE', 'ssh-keygen -l -f FILE', 'cat < FILE',
  ];
  for (const template of commands) {
    const raw = template.replaceAll('FILE', '/repo/raw');
    assert.match(await scope.check(call('wsl', { command: raw }), '/repo'), /原料/, raw);
    const product = template.replaceAll('FILE', '/repo/product');
    assert.equal(await scope.check(call('wsl', { command: product }), '/repo'), undefined, product);
  }
  for (const command of [
    'cat $FILE', 'FILE=/repo/product; cat "$FILE"', 'cat /repo/*', 'cat /repo/{product,raw}', 'cat $(echo /repo/product)',
    'ls $(cat /repo/raw)', 'cat /repo/product | grep -f /repo/raw', 'cat /repo/product < /repo/raw',
    'grep -f/repo/raw /repo/product', 'diff --from-file=/repo/raw /repo/product', 'hexdump -f /repo/raw /repo/product',
    'grep -nf /repo/raw /repo/product', 'jq -f/repo/raw /repo/product', 'rg --files --ignore-file /repo/raw',
    'grep -ieX /repo/raw', 'grep -veX /repo/raw', 'rg -ieX /repo/raw < /repo/product',
    'grep --fil /repo/raw /repo/product', 'file --files-fr /repo/product',
    `jq -L/repo -n 'import "raw" as $data; $data'`, `jq -n 'include "raw"; .'`,
    'grep -R fact /repo/product', 'rg --follow fact /repo/product', 'rg -nL fact /repo/product',
    'git -C status show HEAD:raw', 'diff -r /repo/product /repo/product',
    'wc --files0-from=/repo/raw', 'sort --files0-from=/repo/raw', 'file -f /repo/raw', 'sha256sum -c /repo/product',
    'find /repo -exec cat {} \\;', 'ls /repo | xargs cat', 'npm test', 'node --check /repo/product',
    'git show HEAD:raw', 'git diff -- /repo/raw', 'cd /repo; cat product',
  ]) assert.match(await scope.check(call('ops_bash', { command }), '/repo'), /原料/, command);
  assert.equal(await scope.check(call('bash', { command: 'cat /repo/product | grep fact | head -5' }), '/repo'), undefined);
  assert.equal(await scope.check(call('bash', { command: 'cat product', workdir: '/repo' }), '/other'), undefined);
  assert.match(await scope.check(call('bash', { command: 'cat product', workdir: '../other' }), '/repo'), /原料/);
  assert.equal(await scope.check(call('bash', { command: "echo 'literal text' | tr a-z A-Z" }), '/repo'), undefined);
});

test('products blocks indirect file inputs and Git content flags; open stays unchanged', async () => {
  const scope = createProductReads({}, async owner => ({ status: 'completed', owner, paths: [] }));
  scope.add('S1', ['/repo/product']);
  for (const command of [
    'git status -v', 'git -C /repo status -vv', 'git status --verbose', 'git status --verb',
    'git ls-files --eol', 'git ls-files --eo',
    'date -uf /repo/raw', 'date --fil=/repo/raw', 'rg --files -nf /repo/raw',
    `awk 'BEGIN { ARGV[1]="/repo/raw"; ARGC=2 } { print }' /repo/product`,
    `awk 'BEGIN { ARGV[ARGC++]="/repo/raw" } 1' /repo/product`,
  ]) {
    assert.equal(readOnlyCommand(command, []), true, command);
    assert.match(await scope.check(call('wsl', { command }), '/repo'), /原料/, command);
  }
});

test('directory discovery remains unrestricted and wc still reads content', async () => {
  const scope = createProductReads({ plannerReadAllow: [] }, async owner => ({ status: 'completed', owner, paths: [] }));
  for (const command of ['ls -la /other', 'ls /other/*', "find /other -name '*.js' -type f", 'stat /other/raw',
    'du -s /other', 'rg --files /other', 'git status --short', 'pwd']) {
    assert.equal(await scope.check(call('wsl', { command }), '/repo'), undefined, command);
  }
  for (const tool of ['glob', 'ops_glob', 'mcp__fs__list_directory']) assert.equal(await scope.check(call(tool, { path: '/other' }), '/repo'), undefined);
  assert.match(await scope.check(call('wsl', { command: 'wc -l /other/raw' }), '/repo'), /原料/);
});

test('allowlist files/directories and the prompt reuse path normalization and resolve local links', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  mkdirSync(allowed);
  const file = path.join(root, 'file.md'), prompt = path.join(root, 'prompt.md'), raw = path.join(root, 'raw.md');
  for (const p of [file, prompt, raw, path.join(allowed, 'nested.md')]) writeFileSync(p, 'text');
  const scope = createProductReads({ plannerReadAllow: [allowed, file] }, async owner => ({ status: 'completed', owner, paths: [] }), { plannerFile: prompt });
  for (const p of [file, prompt, path.join(allowed, 'nested.md')]) assert.equal(await scope.check(call('read', { file_path: p }, 'S1', root), root), undefined);
  assert.match(await scope.check(call('read', { file_path: raw }, 'S1', root), root), /原料/);
  assert.match(await scope.check(call('read', { file_path: `${file}/child` }, 'S1', root), root), /原料/);
  assert.equal(readPath('C:\\Work\\OUT.md'), readPath('/mnt/c/work/OUT.md'));
  const link = path.join(root, 'link');
  symlinkSync(allowed, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await scope.check(call('read', { file_path: path.join(link, 'nested.md') }, 'S1', root), root), undefined);
  const productScope = createProductReads({ plannerReadAllow: [] }, async owner => ({ status: 'completed', owner, paths: [] }));
  productScope.add('S1', [wslPath(allowed)]);
  assert.match(await productScope.check(call('ops_grep', { path: allowed, pattern: 'text' }, 'S1', root), root), /原料/);
  productScope.add('S1', [path.join(link, 'nested.md')]);
  rmSync(link);
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(await productScope.check(call('read', { file_path: path.join(link, 'raw.md') }, 'S1', root), root), /原料/);
  assert.ok(shellReadTargets(`cat ${quote(file)}`, root).includes(readPath(file)));
});

test('products allows only the current DSH session artifact directory', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const owner of ['S1', 'S2']) {
    mkdirSync(path.join(root, owner));
    writeFileSync(path.join(root, owner, 'progress.md'), 'session work record');
  }
  writeFileSync(path.join(root, 'raw.js'), 'raw source');
  let guard;
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  try {
    apply({ tools: { register() {}, guard(value) { guard = value; } }, on() {},
      get(key) { return key === 'sessionPersistence' ? {
        locate(header) { return { kind: 'jsonl', path: path.join(root, header.id, 'events.v4.jsonl') }; },
      } : undefined; } }, { workspaces: [root], plannerReads: 'products' },
    async (_cfg, args) => ({ status: 'completed', owner: args[2], paths: [] }));
  } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; }
  const read = (owner, file) => {
    const exec = call('read', { file_path: file }, owner, root);
    exec.agent.session.header.id = owner;
    return guard(exec);
  };
  for (const owner of ['S1', 'S2']) {
    assert.equal(await read(owner, path.join(root, owner, 'progress.md')), undefined);
    assert.match(await read(owner, path.join(root, owner === 'S1' ? 'S2' : 'S1', 'progress.md')), /原料/);
    assert.match(await read(owner, path.join(root, 'raw.js')), /原料/);
  }
});

test('product refresh is session-scoped, coalesced, throttled, fail-closed and bounded', async () => {
  let time = 0;
  const calls = [];
  let finishRefresh;
  let result = () => new Promise(resolve => { finishRefresh = resolve; });
  const scope = createProductReads({ plannerReadAllow: [] }, async owner => { calls.push(owner); return result(owner); }, { now: () => time });
  const read = (file, owner = 'S1') => scope.check(call('read', { file_path: file }, owner), '/repo');
  let settled = false;
  const first = read('/repo/product').then(value => { settled = true; return value; });
  const concurrent = read('/repo/product');
  const raw = read('/repo/raw');
  await tick();
  assert.deepEqual(calls, ['S1']);
  assert.equal(settled, false, 'the first read must wait for product recovery');
  finishRefresh({ status: 'completed', owner: 'S1', paths: ['/repo/product'] });
  assert.equal(await first, undefined);
  assert.equal(await concurrent, undefined);
  assert.match(await raw, /原料/);
  assert.equal(await read('/repo/product'), undefined);
  for (let i = 0; i < 30; i++) assert.match(await read(`/repo/raw${i}`), /原料/);
  time = 24_999;
  assert.match(await read('/repo/raw'), /原料/);
  assert.deepEqual(calls, ['S1']);
  time = 25_000;
  result = () => { throw new Error('runner unavailable'); };
  const failed = await read('/repo/raw');
  assert.match(failed, /产物登记恢复失败.*已拒绝/);
  assert.doesNotMatch(failed, /暂时无法确认/);
  assert.equal(await read('/repo/raw'), failed);
  assert.deepEqual(calls, ['S1', 'S1']);
  assert.equal(await read('/repo/product'), undefined);
  result = owner => ({ status: 'completed', owner, paths: [] });
  assert.match(await read('/repo/product', 'S2'), /原料/);
  assert.deepEqual(calls, ['S1', 'S1', 'S2']);
  time += 25_000;
  result = () => ({ status: 'completed', owner: 'S2', paths: ['/repo/other-session'] });
  const wrongOwner = await read('/repo/other-session');
  assert.match(wrongOwner, /产物登记恢复失败.*已拒绝/);
  assert.doesNotMatch(wrongOwner, /暂时无法确认/);
  assert.equal(await read('/repo/other-session'), wrongOwner);
  result = owner => ({ status: 'completed', owner, paths: [] });
  scope.add('cap', Array.from({ length: 10_001 }, (_, i) => `/repo/file${i}`));
  assert.match(await read('/repo/file0', 'cap'), /原料/);
  assert.equal(await read('/repo/file10000', 'cap'), undefined);
});

test('apply updates products on completion while open mode keeps its guard and guidance', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-apply-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mount = '/repo';
  const create = mode => {
    const tools = {}, guards = [], calls = [];
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      apply({ tools: { register: tool => tools[tool.name] = tool, guard: guard => guards.push(guard) }, on() {} },
        { workspaces: [mount], plannerReads: mode }, async (_cfg, argv) => {
          calls.push(argv);
          if (argv[0] === 'list') return { jobs: [], total: 0 };
          if (argv[0] === 'start') return { job_id: 'J1', status: 'completed', cwd: mount,
            files_changed: [{ path: 'product.md', change: 'added' }], write_paths: ['extra.md'], log_dir: '/jobs/J1' };
          if (argv[0] === 'products') return { status: 'completed', owner: argv[2], paths: [] };
          throw new Error(`Unexpected ${argv[0]}`);
        });
    } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; }
    return { tools, guard: guards[0], calls };
  };
  const h = create('products');
  await h.tools.codex_run.execute({ task: 'Write the requested product.', acceptance: ['Product exists'], write: true }, call('codex_run'));
  for (const file of ['/repo/product.md', '/repo/extra.md', '/jobs/J1/last_message.txt']) assert.equal(await h.guard(call('read', { file_path: file })), undefined);
  assert.match(await h.guard(call('read', { file_path: '/repo/raw.js' })), /原料/);
  assert.match(await h.guard(call('read', { file_path: '/repo/product.md' }, 'S2')), /原料/);
  assert.equal(await h.guard(call('read', { file_path: '/repo/raw.js' }, 'S1', '/outside')), undefined);
  assert.match(await h.guard(call('write', { path: '/repo/product.md' })), /已拒绝/);
  const open = create('open');
  assert.equal(await open.guard(call('read', { file_path: '/repo/raw.js' })), undefined);
  assert.equal(await open.guard(call('wsl', { command: 'cat /repo/raw.js' })), undefined);
  assert.deepEqual(open.calls, []);
  const job = { job_id: 'J', status: 'completed' };
  assert.equal(nextStep(job), nextStep(job, undefined, undefined, { plannerReads: 'open' }));
  assert.doesNotMatch(nextStep(job), /codex_verify/);
  assert.match(nextStep(job, undefined, undefined, { plannerReads: 'products' }), /机械核对.*codex_verify/);
});

test('products keeps runner reports and history within the session and caches artifact ownership', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'planner-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const make = mode => {
    const tools = {}, calls = [];
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      apply({ tools: { register: tool => tools[tool.name] = tool, guard() {} }, on() {} },
        { workspaces: ['/repo'], plannerReads: mode }, async (_cfg, args) => {
          calls.push(args);
          if (args[0] === 'status') return { job_id: args[1], status: 'completed', cwd: '/repo',
            context: { owner: args[1] === 'own' ? 'S1' : 'S2' } };
          if (args[0] === 'output') return { text: 'report', eof: true };
          if (args[0] === 'list') return { jobs: [], total: 0 };
          if (args[0] === 'summary') return { groups: [], total: 0 };
          throw new Error(`Unexpected ${args[0]}`);
        });
    } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; }
    return { tools, calls };
  };
  const exec = call('codex_output');
  const h = make('products');
  for (const tool of ['codex_output', 'codex_status', 'codex_cancel']) {
    await assert.rejects(h.tools[tool].execute({ job_id: 'foreign' }, exec), /无法确认任务属于本会话|任务不属于本会话/);
  }
  await h.tools.codex_output.execute({ job_id: 'own' }, exec);
  await h.tools.codex_output.execute({ job_id: 'own', offset: 1 }, exec);
  assert.equal(h.calls.filter(args => args[0] === 'status' && args[1] === 'own').length, 1);
  assert.equal(h.calls.filter(args => args[0] === 'output').length, 2);
  for (const tool of ['codex_jobs', 'codex_summary']) {
    await assert.rejects(h.tools[tool].execute({ session_id: 'S2' }, exec), /只能读取本会话/);
    await h.tools[tool].execute({}, exec);
    assert.ok(h.calls.at(-1).includes('--owner'));
    assert.equal(h.calls.at(-1)[h.calls.at(-1).indexOf('--owner') + 1], 'S1');
    assert.equal(h.calls.at(-1).includes('--job-id'), false);
  }
  const open = make('open');
  assert.equal((await open.tools.codex_output.execute({ job_id: 'foreign' }, exec)).text, 'report');
  assert.equal(open.calls.length, 1);
  assert.equal((await open.tools.codex_status.execute({ job_id: 'foreign' }, exec)).context.owner, 'S2');
  await open.tools.codex_jobs.execute({ session_id: 'S2' }, exec);
  assert.ok(open.calls.at(-1).includes('S2'));
});
