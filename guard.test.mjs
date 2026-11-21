import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProductReads, plannerReadTargets, readPath, readOnlyCommand, decide, normPath, inWorkspace, knownTool,
  PRODUCT_HINT, PRODUCT_DENY_HINT, GEMINI_READ_DENY, GEMINI_UNKNOWN_DENY, GEMINI_CHECK_HINT, RUN_CODE_DENY } from './guard.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const call = (name, args, owner = 'S1') => ({
  name, arguments: args, agent: { id: owner, session: { header: { cwd: '/repo' } } },
});
const denial = `[codex-conductor] ${PRODUCT_HINT}`;
const shortDenial = `[codex-conductor] ${PRODUCT_DENY_HINT}`;
const completed = async owner => ({ status: 'completed', owner, paths: [] });
const config = plannerReads => ({ roots: ['/repo'], denyTools: new Set(['custom_tool']), allowCommands: [], plannerReads });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('Gemini prose denial precedes products and allowlists in both planner modes', async (t) => {
  assert.equal(GEMINI_CHECK_HINT, '该正文由 gemini_write 写出，规划端不读取。下一步派一单 codex_run（write=true，scope 只含该正文文件），在同一单里核对事实与可读性、就地修正写法问题和句子级错误，报告问题位置和改动；不要另派只读核对或清理单，也不要换工具、搜索或命令绕读。');
  assert.equal(GEMINI_READ_DENY, `[codex-conductor] ${GEMINI_CHECK_HINT}`);
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-prose-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const body = path.join(root, 'chapter.md');
  writeFileSync(body, '正文');
  for (const plannerReads of ['open', 'products']) {
    const scope = createProductReads({ plannerReads, plannerReadAllow: [root, body] }, completed);
    scope.add('S1', [body]);
    scope.addGemini('S1', [body]);
    for (const [name, args] of [
      ['read', { path: body }], ['read_file', { file_path: body }],
      ['mcp__obsidian__obsidian_read', { path: body }], ['obsidian_frontmatter', { action: 'read', path: body }],
      ['obsidian_search', { path: root, query: '正文' }], ['search_files', { path: root }],
      ['ops_search_for_pattern', { path: body }],
      ['wsl', { command: `cat '${body.replaceAll('\\', '/')}'` }],
      ['wsl', { command: `rg 正文 '${root.replaceAll('\\', '/')}'` }],
      ['obsidian_search', { query: '正文' }],
    ]) {
      assert.equal(scope.checkSync(call(name, args)), GEMINI_READ_DENY, `${plannerReads} ${name}`);
      assert.equal(await scope.check(call(name, args)), GEMINI_READ_DENY);
    }
    for (const [name, args] of [['codex_run', { task: `读取 ${body}`, write: true, scope: [body] }],
      ['obsidian_list', { path: root }], ['wsl', { command: `rg --files '${root.replaceAll('\\', '/')}'` }]]) {
      assert.equal(scope.checkSync(call(name, args)), undefined, name);
    }
    assert.equal(scope.checkSync(call('read', { path: body }, 'S2')), undefined);
  }
});

test('Gemini prose restores only correlated successful receipts and tracks appended log events', () => {
  const scope = createProductReads({ plannerReads: 'open', plannerReadAllow: ['/repo'] }, completed);
  const log = [];
  const exec = call('read', { path: '/repo/chapter.md' });
  exec.agent.session.log = log;
  assert.equal(scope.checkSync(exec), undefined);
  const addReceipt = (id, name, status, output, extra = {}) => {
    log.push({ type: 'tool/call', data: { name, callId: id } });
    log.push({ type: 'tool/result', data: { message: { role: 'tool', toolCallId: id,
      content: [{ type: 'text', text: JSON.stringify({ status, output, ...extra }) }] } } });
  };
  addReceipt('failed', 'gemini_write', 'failed', '/repo/failed.md');
  addReceipt('other', 'codex_run', 'completed', '/repo/codex.md');
  addReceipt('success', 'gemini_write', 'completed', '/repo/chapter.md');
  assert.equal(scope.checkSync(exec), GEMINI_READ_DENY);
  for (const file of ['failed.md', 'codex.md']) {
    assert.equal(scope.checkSync({ ...exec, arguments: { path: `/repo/${file}` } }), undefined);
  }
  addReceipt('reuse', 'gemini_write', 'completed', '/repo/reused.md', { reused_draft: true });
  assert.equal(scope.checkSync({ ...exec, arguments: { path: '/repo/reused.md' } }), GEMINI_READ_DENY);
  const reloaded = createProductReads({ plannerReads: 'open' }, completed);
  assert.equal(reloaded.checkSync(exec), GEMINI_READ_DENY);
  assert.equal(reloaded.checkSync({ ...exec, agent: { ...exec.agent, id: 'S2', session: { log: [] } } }), undefined);
});

test('Gemini receipt paths identify a vault for relative Obsidian reads without granting sources', () => {
  const scope = createProductReads({ plannerReads: 'open' }, completed);
  scope.addGemini('S1', ['E:/obsidian/study/course/chapter.md']);
  assert.equal(scope.checkSync(call('obsidian_read', { path: 'course/chapter.md' })), GEMINI_READ_DENY);
  assert.equal(scope.checkSync(call('obsidian_search', { path: 'course', query: '正文' })), GEMINI_READ_DENY);
  assert.equal(scope.checkSync(call('obsidian_read', { path: 'course/notes.md' })), undefined);
});

test('rg file enumeration stays unrestricted with literal paths and glob options', async () => {
  const scope = createProductReads({}, completed);
  for (const command of [
    'rg --files', 'rg --files /repo', "rg --files -g '*.mjs' /repo",
    "rg --hidden --files --glob='*.mjs' -tjs /repo", 'rg --files -g--json /repo',
    'rg --files -- --json',
  ]) {
    const exec = call('wsl', { command });
    assert.equal(readOnlyCommand(command), true, command);
    assert.deepEqual(plannerReadTargets(exec), [], command);
    assert.equal(await scope.check(exec), undefined, command);
  }
});

test('rg search modes and operand spellings cannot bypass products through --files', async () => {
  const scope = createProductReads({}, completed);
  for (const flag of ['--json', '--count', '--count-matches', '--files-with-matches', '--files-without-match', '-c', '-l', '-nc']) {
    for (const flags of [`--files ${flag}`, `${flag} --files`]) {
      const command = `rg ${flags} fact /repo/raw.js`;
      assert.equal(await scope.check(call('wsl', { command })), denial, command);
    }
  }
  for (const command of [
    'rg -g --files fact /repo/raw.js', 'rg -- fact /repo/raw.js --files',
    'rg --files --ignore-file /repo/raw.js', 'rg --files -nf /repo/raw.js',
  ]) assert.equal(await scope.check(call('wsl', { command })), denial, command);
});

test('printf refuses expanded options and assigning format conversions', () => {
  for (const command of [
    'printf {-v,PATH} %s /usr/bin', 'printf -[v] PATH %s /usr/bin', 'printf * PATH %s /usr/bin',
    'printf "$format" PATH', 'printf %n PATH', 'printf -- %n PATH', "printf '%%%n' PATH",
    "printf '%5n' PATH", "printf '%05.2lln' PATH", "printf '%s%n' text PATH",
    'printf -- "$format" PATH', 'printf -- $(echo %n) PATH',
    'timeout 1s printf {-v,PATH} %s /usr/bin',
    'find . -exec printf {-v,PATH} %s /usr/bin \\;',
  ]) {
    assert.equal(readOnlyCommand(command), false, command);
    for (const mode of ['open', 'products']) assert.equal(typeof decide(call('wsl', { command }), config(mode)), 'string', command);
  }
  for (const command of [
    "printf '%s\\n' hello", "printf '%%n'", "printf '%%%%n'", 'printf -- %s %n',
    'printf %s "$value"', "printf '%s' '{-v,PATH}'", 'printf %s {a,b}',
    "printf '%s' '-[v]'", String.raw`printf \%s hello`, 'printf -- -v',
    'find . -exec printf %s {} \\;',
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test('product refresh waits for recovery without labeling unrelated raw paths as possible artifacts', async () => {
  const recovery = deferred();
  const owners = [];
  const scope = createProductReads({}, owner => {
    owners.push(owner);
    return recovery.promise;
  });
  scope.add('S1', ['/repo/report.md']);
  let settled = false;
  const reading = scope.check(call('read', { path: '/repo/generated.md' }), '/repo').then(value => { settled = true; return value; });
  await tick();
  assert.deepEqual(owners, ['S1']);
  assert.equal(settled, false);
  recovery.resolve({ status: 'completed', owner: 'S1', paths: ['/repo/generated.md'] });
  assert.equal(await reading, undefined);
  for (const [name, args] of [
    ['wsl', { command: 'sha256sum /repo/product/drt-lite.exe' }],
    ['wsl', { command: 'grep -n createProductReads /plugins/conductor/index.mjs' }],
    ['read', { file_path: '/repo/raw.js' }],
    ['read', { paths: ['/repo/report.md', '/repo/raw.js'] }],
    ['wsl', { command: 'cat "$FILE"' }],
  ]) {
    const result = await scope.check(call(name, args), '/repo');
    assert.equal(result, denial, name);
    assert.doesNotMatch(result, /暂时|稍后|可能是产物/);
  }
  assert.equal(await scope.check(call('read', { file_path: '/repo/report.md' }), '/repo'), undefined);
  assert.deepEqual(owners, ['S1']);
  assert.equal(await scope.check(call('read', { file_path: '/repo/generated.md' }), '/repo'), undefined);
  assert.equal(await scope.check(call('read', { file_path: '/repo/raw.js' }), '/repo'), denial);
});

test('failed product refresh keeps raw reads blocked without a path identity claim', async () => {
  let time = 0;
  let refreshes = 0;
  const scope = createProductReads({}, async () => {
    refreshes++;
    throw new Error('runner unavailable');
  }, { now: () => time });
  scope.add('S1', ['/repo/report.md']);
  const read = file => scope.check(call('read', { file_path: file }), '/repo');
  for (const file of ['/repo/raw.js', '/repo/product/drt-lite.exe', '/plugins/conductor/index.mjs']) {
    const result = await read(file);
    assert.match(result, /恢复失败.*未获读取授权/);
    assert.doesNotMatch(result, /暂时|稍后|这是原料/);
  }
  assert.equal(await read('/repo/report.md'), undefined);
  assert.equal(refreshes, 1);
  time = 24_999;
  await read('/repo/raw.js');
  assert.equal(refreshes, 1);
  time = 25_000;
  assert.match(await read('/repo/raw.js'), /恢复失败/);
  assert.equal(refreshes, 2);
  assert.match(await read('/repo/raw.js'), /恢复失败/);
});

test('successful refresh, subsequent refresh and owner mismatch preserve the product boundary', async () => {
  let time = 0;
  const scope = createProductReads({}, async () => ({
    status: 'completed', owner: 'S1', paths: ['/repo/report.md'],
  }), { now: () => time });
  const read = (file, owner = 'S1') => scope.check(call('read', { file_path: file }, owner), '/repo');
  assert.equal(await read('/repo/raw.js'), denial);
  assert.equal(await read('/repo/report.md'), undefined);
  time = 25_000;
  assert.equal(await read('/repo/raw.js'), denial);
  assert.equal(await read('/repo/report.md'), undefined);
  assert.match(await read('/repo/report.md', 'S2'), /恢复失败/);
  assert.match(await read('/repo/report.md', 'S2'), /未获读取授权/);
  assert.equal(await read('/repo/raw.js'), denial);
});

test('concurrent misses share pending recovery; known products and directory lists do not wait', async () => {
  const recovery = deferred();
  let refreshes = 0;
  const scope = createProductReads({}, () => { refreshes++; return recovery.promise; });
  scope.add('S1', ['/repo/known.md']);
  const reads = [scope.check(call('read', { path: '/repo/new.md' }), '/repo'),
    scope.check(call('read', { path: '/repo/raw.js' }), '/repo')];
  await tick();
  assert.equal(refreshes, 1);
  assert.equal(await scope.check(call('read', { path: '/repo/known.md' }), '/repo'), undefined);
  assert.equal(await scope.check(call('obsidian_list', { path: '/' }), '/repo'), undefined);
  recovery.resolve({ status: 'completed', owner: 'S1', paths: ['/repo/new.md'] });
  assert.deepEqual(await Promise.all(reads), [undefined, denial]);
  assert.equal(refreshes, 1);
});

test('timeout is bounded, keeps pending recovery shared, and later reads recheck completion', async () => {
  const recovery = deferred();
  let refreshes = 0;
  let time = 0;
  const scope = createProductReads({}, () => { refreshes++; return recovery.promise; },
    { now: () => time, refreshTimeoutMs: 10 });
  const read = file => scope.check(call('read', { path: file }), '/repo');
  const results = await Promise.all([read('/repo/product.md'), read('/repo/raw.js')]);
  for (const result of results) {
    assert.match(result, /暂时无法确认.*稍后重试一次.*再不行交 Codex/);
    assert.match(result, /仅同一读取.*调查交给 codex_run.*核验任务 codex_verify.*不要换命令、语言或工具入口重试/);
    assert.doesNotMatch(result, /这是原料|git status|pwsh/);
  }
  time = 25_000;
  assert.match(await read('/repo/product.md'), /暂时无法确认/);
  assert.equal(refreshes, 1);
  recovery.resolve({ status: 'completed', owner: 'S1', paths: ['/repo/product.md'] });
  await tick();
  assert.equal(await read('/repo/product.md'), undefined);
  assert.equal(await read('/repo/raw.js'), denial);
});

test('timeout followed by failed recovery stops suggesting a temporary retry', async () => {
  const recovery = deferred();
  const scope = createProductReads({}, () => recovery.promise, { refreshTimeoutMs: 5 });
  const read = () => scope.check(call('read', { path: '/repo/raw.js' }), '/repo');
  assert.match(await read(), /暂时无法确认/);
  recovery.resolve({ status: 'failed' });
  await tick();
  assert.match(await read(), /恢复失败/);
  assert.doesNotMatch(await read(), /暂时|稍后|这是原料/);
});

test('pending recovery and recovered paths stay isolated by owner', async () => {
  const recoveries = { S1: deferred(), S2: deferred() };
  const owners = [];
  const scope = createProductReads({}, owner => { owners.push(owner); return recoveries[owner].promise; });
  const read = owner => scope.check(call('read', { path: '/repo/product.md' }, owner), '/repo');
  const s1 = read('S1'), s2 = read('S2');
  await tick();
  assert.deepEqual(owners, ['S1', 'S2']);
  recoveries.S1.resolve({ status: 'completed', owner: 'S1', paths: ['/repo/product.md'] });
  assert.equal(await s1, undefined);
  recoveries.S2.resolve({ status: 'completed', owner: 'S2', paths: [] });
  assert.equal(await s2, denial);
  assert.equal(await read('S2'), denial);
  assert.equal(await read('S1'), undefined);
});

test('missing owner and malformed completed recovery never grant a path', async () => {
  for (const value of [undefined, { status: 'pending' }, { status: 'completed', owner: 'S1', paths: [42] }]) {
    const scope = createProductReads({}, async () => value);
    assert.match(await scope.check(call('read', { path: '/repo/raw' }), '/repo'), /恢复失败/);
  }
  const scope = createProductReads({}, () => { throw new Error('missing owner must not refresh'); });
  assert.equal(await scope.check(call('read', { path: '/repo/raw' }, null), '/repo'), denial);
});

test('vault read/search/frontmatter names and MCP aliases use the product boundary', async () => {
  const scope = createProductReads({}, completed);
  scope.add('S1', ['/vault/report.md']);
  for (const operation of ['read', 'search', 'frontmatter']) for (const prefix of ['', 'mcp__notes__']) {
    const name = `${prefix}obsidian_${operation}`;
    assert.deepEqual(plannerReadTargets(call(name, { path: '/vault/report.md' })), ['/vault/report.md']);
    assert.equal(await scope.check(call(name, { path: '/vault/report.md' }), '/repo'), undefined, name);
    assert.equal(await scope.check(call(name, { path: '/vault/raw.md' }), '/repo'), denial, name);
    assert.equal(await scope.check(call(name, { paths: ['/vault/report.md', '/vault/raw.md'] }), '/repo'), denial, name);
    assert.equal(await scope.check(call(name, { path: '/vault/report.md' }, 'S2'), '/repo'), denial, name);
  }
});

test('vault common path parameters, arrays and file objects are checked without alias precedence', async () => {
  const scope = createProductReads({}, completed);
  scope.add('S1', ['/vault/report.md']);
  const keys = ['path', 'file_path', 'filePath', 'relative_path', 'relativePath', 'file', 'paths', 'files'];
  for (const operation of ['read', 'search', 'frontmatter']) for (const key of keys) {
    const name = `obsidian_${operation}`;
    for (const value of ['/vault/report.md', ['/vault/report.md']]) {
      assert.equal(await scope.check(call(name, { [key]: value }), '/repo'), undefined, `${name}.${key}`);
    }
    assert.equal(await scope.check(call(name, { files: [{ [key]: '/vault/report.md' }] }), '/repo'), undefined);
    const otherKey = key === 'paths' ? 'path' : 'paths';
    assert.equal(await scope.check(call(name, { [key]: '/vault/raw.md', [otherKey]: '/vault/report.md' }), '/repo'), denial);
  }
  for (const args of [{}, { path: '' }, { paths: [] }, { paths: ['/vault/report.md', {}] },
    { files: [null] }, { path: '/vault/report.md', files: [] }]) {
    assert.equal(plannerReadTargets(call('obsidian_read', args)), null);
    assert.match(await scope.check(call('obsidian_read', args), '/repo'), /无法确定 vault 读取范围/);
  }
});

test('vault relative paths infer configured obsidian/study rather than session cwd or a drive', async () => {
  const allow = ['E:\\obsidian\\study\\rules.md'];
  for (const rootEntry of [...allow, 'E:\\obsidian\\study', '/mnt/e/obsidian/study/08 - 本库指南/字段规范.md']) {
    for (const name of ['obsidian_read', 'obsidian_search', 'obsidian_frontmatter']) {
      assert.deepEqual(plannerReadTargets(call(name, { path: 'rules.md', cwd: 'C:/wrong', workdir: '/wrong' }), '/repo', [rootEntry]),
        ['e:/obsidian/study/rules.md']);
    }
  }
  const scope = createProductReads({ plannerReadAllow: allow }, completed);
  assert.equal(await scope.check(call('obsidian_read', { path: 'rules.md' }), '/other'), undefined);
  for (const file of ['raw.md', '../raw.md', '../../private.md']) {
    assert.equal(await scope.check(call('obsidian_read', { path: file }), '/repo'), denial, file);
  }
});

test('vault relative paths fail closed without one evidenced root', async () => {
  for (const allow of [[], ['E:/'], ['E:/notes/rules.md'], ['E:/obsidian/study/rules.md', 'F:/obsidian/study/rules.md']]) {
    assert.equal(plannerReadTargets(call('obsidian_read', { path: 'report.md' }), '/repo', allow), null);
    const scope = createProductReads({ plannerReadAllow: allow }, completed);
    scope.add('S1', ['/repo/report.md']);
    assert.match(await scope.check(call('obsidian_read', { path: 'report.md' }), '/repo'), /plannerReadAllow.*唯一 vault 根/);
  }
});

test('vault markers infer ancestors and directory search stays within the allowlist', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'guard-vault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.obsidian'));
  const rules = path.join(root, 'rules');
  mkdirSync(rules);
  const rule = path.join(rules, 'rules.md');
  writeFileSync(rule, 'rules');
  const scope = createProductReads({ plannerReadAllow: [rule] }, completed);
  assert.equal(await scope.check(call('obsidian_frontmatter', { relative_path: 'rules/rules.md', action: 'get' }), '/repo'), undefined);
  assert.equal(await scope.check(call('obsidian_search', { path: 'rules', query: 'rules' }), '/repo'), denial);
  const directoryScope = createProductReads({ plannerReadAllow: [rules] }, completed);
  assert.equal(await directoryScope.check(call('obsidian_search', { path: 'rules', query: 'rules' }), '/repo'), undefined);
  assert.equal(await directoryScope.check(call('obsidian_search', { path: '.', query: 'rules' }), '/repo'), denial);
  assert.deepEqual(plannerReadTargets(call('obsidian_read', { path: 'rules/rules.md' }), '/other', [rule]), [readPath(rule)]);
  const vaultScope = createProductReads({ plannerReadAllow: [root] }, completed);
  assert.equal(await vaultScope.check(call('obsidian_read', { path: 'rules/rules.md' }), '/repo'), undefined);
});

test('whole-vault content search needs an explicit bounded scope', async () => {
  const scope = createProductReads({ plannerReadAllow: ['E:/obsidian/study/rules.md'] }, completed);
  scope.add('S1', ['/repo/report.md']);
  for (const args of [{ query: 'fact' }, { query: 'fact', vault: 'study' }, { query: 'fact', paths: [] },
    { query: 'fact', folder: '/' }]) {
    assert.equal(plannerReadTargets(call('obsidian_search', args)), null);
    assert.match(await scope.check(call('obsidian_search', args), '/repo'), /内容搜索不得无范围/);
  }
  assert.equal(await scope.check(call('obsidian_search', { query: 'fact', file_path: 'rules.md' }), '/repo'), undefined);
});

test('vault directory lists stay allowed without recovery or a root', async () => {
  const scope = createProductReads({}, () => { throw new Error('listing must not refresh'); });
  for (const name of ['obsidian_list', 'mcp__notes__obsidian_list']) for (const args of [{}, { path: '/' }, { path: '../other' }]) {
    assert.deepEqual(plannerReadTargets(call(name, args)), []);
    assert.equal(await scope.check(call(name, args), '/repo'), undefined);
    assert.equal(decide(call(name, args), config('products')), undefined);
  }
});

test('frontmatter reads share the boundary and mutation requests cannot use the read entry', async () => {
  const scope = createProductReads({}, completed);
  scope.add('S1', ['/vault/report.md']);
  for (const name of ['obsidian_frontmatter', 'mcp__notes__obsidian_frontmatter']) {
    for (const args of [{}, { action: 'read' }, { operation: 'get' }, { mode: 'READ' }]) {
      const exec = call(name, { path: '/vault/report.md', ...args });
      assert.equal(decide(exec, config('products')), undefined);
      assert.equal(await scope.check(exec, '/repo'), undefined);
    }
    for (const args of [{ action: 'set' }, { operation: 'delete' }, { mode: 'update' },
      { action: 'get', operation: 'write' }, ...['content', 'frontmatter', 'data', 'updates', 'value', 'values', 'properties'].map(key => ({ [key]: {} }))]) {
      const exec = call(name, { path: '/vault/report.md', ...args });
      assert.equal(decide(exec, config('products')), shortDenial);
      assert.equal(plannerReadTargets(exec), null);
      assert.ok(await scope.check(exec, '/repo'));
    }
  }
  for (const name of ['mcp__notes__obsidian_write', 'mcp__notes__obsidian_edit', 'mcp__notes__obsidian_delete']) {
    assert.equal(decide(call(name, { path: '/vault/report.md' }), config('products')), shortDenial);
  }
});

test('every products decide rejection uses short delegation guidance without HINT commands', () => {
  const cfg = { ...config('products'), gemini: true };
  for (const [name, args] of [
    ...['write', 'edit', 'wsl-write', 'wsl-edit', 'wsl-term', 'wsl-bootstrap', 'pwsh', 'actions_run', 'actions_configure', 'run_code', 'subagent_codex', 'custom_tool'].map(name => [name, {}]),
    ['mcp__serena__execute_shell_command', {}], ['mcp__serena__replace_content', {}],
    ['wsl', { command: 'ls', stdin: 'x' }], ['wsl', { command: 'ls', env: { X: '1' } }],
    ['bash', { command: 'cat /repo/report.md', stdin: 'x' }], ['ops_bash', { command: 'ls', script_path: 'a.sh' }],
    ['wsl', { command: 'rm /repo/file' }], ['bash', { command: 'python -c pass' }], ['ops_bash', { command: '' }],
  ]) {
    const result = decide(call(name, args), cfg);
    assert.equal(result, shortDenial, name);
    assert.match(result, /调查交给 codex_run.*核对产物交给核验任务 codex_verify.*不要换命令、语言或工具入口重试/);
    assert.doesNotMatch(result, /这是原料|git status|sha256sum|pytest|npm test|pwsh|gemini_write|不放行的是/);
  }
  assert.equal(decide(call('gemini_write'), cfg), undefined);
  assert.equal(decide(call('codex_run'), cfg), undefined);
  assert.equal(decide(call('read', { path: '/repo/raw.js' }), cfg), undefined);
});

test('open decide keeps existing detailed refusals, shell hints and optional Gemini guidance', () => {
  const cfg = { ...config('open'), gemini: true };
  const write = decide(call('write'), cfg);
  assert.match(write, /write 会直接改动文件或执行任意代码，已拒绝/);
  assert.match(write, /git status\/diff\/log\/show/);
  assert.match(write, /pwsh -NoProfile -File/);
  assert.match(write, /gemini_write，一章一章做/);
  assert.match(decide(call('mcp__serena__replace_content'), cfg), /会改动文件或执行命令，已拒绝/);
  assert.match(decide(call('wsl', { command: 'ls', stdin: 'x' }), cfg), /带了 stdin 参数/);
  assert.match(decide(call('ops_bash', { command: 'rm /repo/raw' }), cfg), /不放行的是「rm \/repo\/raw」/);
  assert.equal(decide(call('obsidian_read', { path: '/vault/raw.md' }), cfg), undefined);
  assert.equal(decide(call('wsl', { command: 'cat /repo/raw' }), cfg), undefined);
  const outside = call('write');
  outside.agent.session.header.cwd = '/outside';
  assert.equal(decide(outside, cfg), undefined);
});

const allowed = (commands, extra) => { for (const c of commands) assert.equal(readOnlyCommand(c, extra), true, c); };
const refused = (commands, extra) => { for (const c of commands) assert.equal(readOnlyCommand(c, extra), false, c); };

test('word-initial # comments end at the newline and cannot hide the next line', () => {
  refused(["ls # '\nrm -rf src # '", 'echo a # \\\nrm -rf src', 'git status # "\ngit checkout -- . # "',
    "echo $(echo a #'\nrm -rf src #'\n)", 'echo "$(echo a # )\nrm -rf src\n)"', '# only a comment']);
  allowed(['# 看一下状态\ngit status', 'git status  # 当前改动', "ls # it's fine\npwd", 'echo a#b', 'echo $#',
    'echo "${x#prefix}"', 'echo "# not a comment"']);
});

test("unquoted $'…' and $\"…\" are refused because their quoting differs from plain quotes", () => {
  refused(["echo $'\\'' ; rm -rf src ; echo \\'", "grep $'\\t' a.txt", 'echo $"hi"', "echo \"$(echo $'x')\""]);
  allowed(["grep 'foo$' a.txt", 'grep "foo$" a.txt', 'grep foo$ a.txt', "echo \"it's $\""]);
});

test('${ without a parameter name is a Bash 5.3 command substitution and is refused', () => {
  refused(['echo "${ rm -rf src; }"', 'cat "${|rm -rf src;}"', '[ -n "${ rm -rf src; }" ]', 'echo ${ rm -rf src; }',
    'echo "${x:-${ rm -rf src; }}"']);
  allowed(['echo "${#}"', 'echo "${#x}"', 'echo "${x:-default}"', "echo '${ literal; }'"]);
});

test('test runners accept only listed switches and literal operands', () => {
  allowed(['pytest', 'pytest -q tests', 'pytest -x -v -s tests/test_a.py::test_b', "pytest -k 'login and not slow' --maxfail=1 --tb=short",
    'python3 -m pytest -x', 'timeout 60 pytest -q', 'python -m unittest', 'python3 -m unittest discover -s tests -p "test_*.py" -v',
    'python3 -m unittest tests.test_login tests/test_a.py', 'node --test', 'node --test guard.test.mjs test.mjs',
    "node --test --test-name-pattern='guard' guard.test.mjs", 'node --check guard.mjs', 'npm test', 'npm run test:unit',
    'npm test -- tests/a.test.js', 'pnpm test', 'yarn test --silent', 'go test ./...', 'go test -v -run TestLogin -count=1 ./pkg/...',
    'go vet ./...', 'cargo test', 'cargo test --release login -- --nocapture', 'cargo check --workspace', 'make test', 'make check',
    'pwsh -NoProfile -File tests/Verify.ps1 -Verbose', 'pwsh -NoProfile -File tests/Verify.ps1 -Configuration Release']);
  refused(["node --test --import 'data:text/javascript,x'", "node --check --import 'data:text/javascript,x' a.mjs",
    'node --test --test-reporter=tap --test-reporter-destination=README.md', 'node --test -r ./x.js',
    "printf 'x' | python3 -m unittest code.interact", 'python3 -m unittest pdb.set_trace', 'python3 -m unittest -s tests --junit x',
    "make test --eval='test:;touch pwned'", 'make test clean', 'make test -f -', 'make test CC=touch', 'make',
    'pytest --junitxml=README.md', 'pytest --basetemp=src', 'pytest -p os', 'pytest -c x.ini', 'pytest @args.txt', 'pytest "$f"',
    'pytest -k --junitxml=x', 'python3 -m pytest --log-file=guard.mjs', 'go test -c -o guard.mjs ./...',
    'go test -coverprofile=main.go ./...', 'go test -run', 'cargo test -- --logfile src/main.rs',
    "cargo check --config \"build.rustc-wrapper='/usr/bin/touch'\"", 'cargo test --target-dir src',
    'npm test -- --json --outputFile=src/index.js', 'npm test --script-shell=/tmp/x.sh', 'yarn test --use=code', 'npm run build',
    'pwsh -NoProfile -File tests/x.ps1 {-Force,x}', 'pwsh -NoProfile -File tests/x.ps1 "$mode"']);
});

test('tool names match case-insensitively and MCP actions in snake, camel or kebab case', () => {
  const cfg = { ...config('open'), gemini: true };
  for (const name of ['Write', 'WRITE', 'Edit', 'apply_patch', 'multi_edit', 'ops_write', 'ops_edit', 'CUSTOM_TOOL',
    'mcp__fs__writeFile', 'mcp__fs__write-file', 'MCP__FS__WRITE_FILE', 'mcp__fs__append_file', 'mcp__fs__save_file',
    'mcp__fs__update_file', 'mcp__fs__copy_file', 'mcp__fs__mkdir', 'mcp__dc__start_process', 'mcp__sh__run_command',
    'mcp__sh__shell', 'mcp__git__git_commit', 'mcp__git__git_reset', 'mcp__git__git_checkout', 'mcp__git__git_push',
    'mcp__paseo__send_terminal_keys', 'mcp__x__executeCommand', 'mcp__x__seep_r2_cmd']) {
    assert.match(decide(call(name, {}), cfg), /已拒绝/, name);
  }
  for (const [name, args] of [['WSL', { command: 'rm x' }], ['ops_bash', { command: 'ls', env: { A: '1' } }],
    ['ops_bash', { command: 'ls', stdin: 'x' }], ['bash', { command: 'ls', script_path: 'a.sh' }], ['Bash', { command: 'ls', asRoot: true }]]) {
    assert.match(decide(call(name, args), cfg), /已拒绝|不放行/, name);
  }
  for (const name of ['read', 'codex_run', 'codex_status', 'gemini_write', 'todo_write', 'mcp__fs__read_file',
    'mcp__gh__getFileContents', 'mcp__fs__list_directory', 'mcp__fs__search_files', 'mcp__git__git_status', 'mcp__git__git_diff',
    'mcp__git__git_log', 'mcp__git__git_show', 'mcp__graph__query_graph', 'mcp__serena__find_symbol', 'mcp__x__seep_r2_info',
    // Not file writes: these keep the verdict they had before the action list grew.
    'mcp__magpie-memory__memory_save', 'mcp__hindsight-codex__save', 'mcp__paseo__update_agent', 'mcp__x__push_notification',
    'mcp__x__copy_text', 'mcp__x__reset_view', 'mcp__x__checkout_status']) {
    assert.equal(decide(call(name, {}), cfg), undefined, name);
  }
  assert.equal(decide(call('WSL', { command: 'git status' }), cfg), undefined);
  assert.equal(decide(call('ops_bash', { command: 'ls', env: {} }), cfg), undefined);
});

test('assignment prefixes cannot redirect rg, make, cargo, npm, node or python to other programs', () => {
  refused(["printf -- '--pre=rm\\n' | RIPGREP_CONFIG_PATH=/dev/stdin rg x src/", 'MAKEFILES=/dev/stdin make test', 'MAKEFLAGS=k make test',
    'RUSTC_WRAPPER=/tmp/x cargo check', 'RUSTFLAGS=x cargo test', 'CARGO_BUILD_RUSTC_WRAPPER=/tmp/x cargo check',
    'npm_config_script_shell=/tmp/x.sh npm test', 'NPM_CONFIG_SCRIPT_SHELL=/tmp/x.sh npm test', 'NODE_OPTIONS=x node --test',
    'PYTHONSTARTUP=x.py python3 -m pytest', 'PYTHONPATH=/tmp python3 -m pytest',
    'rg --hostname-bin=/tmp/x --hyperlink-format=default x']);
  allowed(['CI=1 npm test', 'LC_ALL=C sort a.txt', 'rg --hidden foo src', 'path=/mnt/d/x; cat "$path/a.txt"']);
});

test('allowCommands entries still pass the assignment-prefix and parameter checks', () => {
  const extra = [/^\.\/verify\.sh --check/];
  allowed(['./verify.sh --check', 'CI=1 ./verify.sh --check', 'timeout 60 ./verify.sh --check'], extra);
  refused(["SHELLOPTS=xtrace PS4='$(touch pwned)' ./verify.sh --check", 'BASH_ENV=/tmp/x ./verify.sh --check',
    'PATH=/tmp/evil ./verify.sh --check', './verify.sh --check "${ touch pwned; }"', './verify.sh --check > out'], extra);
});

test('an allowCommands segment is not a raw-material read in products mode; its inputs and substitutions still are', () => {
  const allow = [/^(?:loopx|"?\$\{?LOOPX_BIN\}?"?)\s+(?:quota|todo)(?:\s|$)/];
  const bash = command => call('ops_bash', { command });
  const scope = createProductReads({ ...config('products'), allowCommands: allow }, completed);
  for (const command of ['loopx quota should-run --goal-id g', '"$LOOPX_BIN" todo list --goal-id g',
    "loopx todo add --text 'check a; b && c'", 'loopx quota should-run --goal-id g | head -c 2000', 'loopx quota should-run 2>&1']) {
    assert.equal(scope.checkSync(bash(command)), undefined, command);
  }
  // A known raw path answers null first (product lookup pending), never undefined.
  for (const command of ['loopx quota should-run < /repo/secret.js', 'loopx todo add --text "$(cat /repo/secret.js)"',
    'loopx quota should-run; cat /repo/secret.js']) {
    assert.notEqual(scope.checkSync(bash(command)), undefined, command);
  }
  for (const command of ['loopx update apply', 'python3 -m pytest', 'loopx quota should-run; python3 -m pytest']) {
    assert.equal(scope.checkSync(bash(command)), denial, command);
  }
  // Without the entry the same command stays refused, as before.
  assert.equal(createProductReads(config('products'), completed).checkSync(bash('loopx quota should-run --goal-id g')), denial);
});

test('every supplied path alias of a read tool is a read target', () => {
  const targets = (args) => plannerReadTargets(call('read', args), '/repo');
  assert.deepEqual(targets({ path: '/repo/ok.md' }), ['/repo/ok.md']);
  assert.deepEqual(targets({ paths: ['/repo/ok.md'], path: '/repo/secret.js' }), ['/repo/ok.md', '/repo/secret.js']);
  assert.deepEqual(targets({ file_path: '/repo/ok.md', path: '/repo/secret.js' }), ['/repo/ok.md', '/repo/secret.js']);
  assert.deepEqual(targets({ paths: [{ path: '/repo/ok.md', file_path: '/repo/secret.js' }] }), ['/repo/ok.md', '/repo/secret.js']);
  assert.equal(targets({ paths: [], path: '/repo/ok.md' }), null);
  assert.equal(targets({ paths: [{}], path: '/repo/ok.md' }), null);
  const scope = createProductReads(config('products'), completed);
  scope.add('S1', ['/repo/ok.md']);
  assert.equal(scope.checkSync(call('read', { path: '/repo/ok.md' })), undefined);
  assert.notEqual(scope.checkSync(call('read', { paths: ['/repo/ok.md'], path: '/repo/secret.js' })), undefined);
});

test('tree -R, oversized commands and their refusal reason', () => {
  refused(['tree -H . -R -L 1', 'tree -aR tools', 'echo ' + 'a'.repeat(32_768)]);
  allowed(['tree -a -L 2 tools', 'tree -r tools', 'echo ' + 'a '.repeat(1000)]);
  assert.match(decide(call('wsl', { command: 'echo ' + 'a'.repeat(32_768) }), config('open')), /命令超过 32 KB/);
});

test('safe read-only forms that used to be refused now pass without widening writes', () => {
  allowed(['[ "$(git status --porcelain | wc -l)" -eq 0 ] && echo clean', 'test "$(wc -l < a.txt)" -gt 10',
    'git merge-base HEAD main', 'git show-ref --heads', 'git reflog', 'git reflog -5', 'git reflog show HEAD',
    "git branch --list 'feat/*'", 'git branch -a --list main', 'node --version', 'python3 --version', 'python --version',
    "awk 'NR>5' a.log", "awk '$3 > 5' data.txt"]);
  refused(['[ $(wc -l < a.txt) -gt 10 ]', '[[ "$(cat f)" -eq 0 ]]', '[ "$n" -gt 10 ]', '[ "$(rm x)" -eq 0 ]',
    'git reflog expire --expire=now --all', 'git reflog delete HEAD@{0}', 'git branch feat/x', 'git branch --list -D main',
    'git merge-base --output=x HEAD main', 'node --version --import x', 'python3 --version -c pass',
    "awk '{print > \"f\"}' a", "awk '$3 > 5 {print $1 > \"out\"}' a", "awk 'NR>5 {printf \"%s\", $0 >> \"out\"}' a"]);
});

test('after gemini_write, commands with unknown read targets get their own refusal reason', () => {
  const open = createProductReads(config('open'), completed);
  open.addGemini('S1', ['/repo/docs/ch1.md']);
  for (const command of ['git diff --stat', 'pytest -q', 'cd /repo/src && cat a.js']) {
    assert.equal(open.checkSync(call('wsl', { command })), GEMINI_UNKNOWN_DENY, command);
  }
  assert.match(GEMINI_UNKNOWN_DENY, /读取目标无法确定.*绝对路径/);
  assert.doesNotMatch(GEMINI_UNKNOWN_DENY, /下一步派一单/);
  assert.equal(open.checkSync(call('wsl', { command: 'cat /repo/docs/ch1.md' })), GEMINI_READ_DENY);
  assert.equal(open.checkSync(call('obsidian_search', { query: '正文' })), GEMINI_READ_DENY);
  for (const command of ['git status', 'cat /repo/src/a.js']) assert.equal(open.checkSync(call('wsl', { command })), undefined, command);
  const products = createProductReads(config('products'), completed);
  products.addGemini('S1', ['/repo/docs/ch1.md']);
  assert.equal(products.checkSync(call('wsl', { command: 'git diff --stat' })), denial);
});

test("'*' also guards sessions without a cwd, and WSL UNC paths match their mount or Linux root", () => {
  assert.equal(inWorkspace('D:\\..\\WORK\\project', [normPath('d:/work')]), true);
  assert.equal(inWorkspace('', ['*']), true);
  assert.equal(inWorkspace(undefined, ['*']), true);
  assert.equal(inWorkspace('', ['/repo']), false);
  const everywhere = { ...config('open'), roots: ['*'] };
  assert.match(decide({ name: 'write', arguments: {}, agent: { session: { header: {} } } }, everywhere), /已拒绝/);
  assert.equal(decide({ name: 'write', arguments: {} }, config('open')), undefined);
  assert.equal(normPath('\\\\wsl.localhost\\Ubuntu\\mnt\\d\\Proj'), 'd:/proj');
  assert.equal(normPath('\\\\wsl$\\Ubuntu\\home\\u\\Proj'), '/home/u/Proj');
  assert.equal(normPath('//wsl.localhost/Ubuntu'), '/');
  assert.equal(inWorkspace('\\\\wsl.localhost\\Ubuntu\\mnt\\d\\proj\\sub', ['d:/proj']), true);
  assert.equal(inWorkspace('\\\\wsl$\\Ubuntu\\home\\u\\p', ['/home/u/p']), true);
  assert.equal(inWorkspace('\\\\wsl$\\Ubuntu\\home\\u\\other', ['/home/u/p']), false);
});

test('toolPolicy allowlist refuses tools the guard does not know unless allowTools names them', () => {
  const base = { ...config('open'), gemini: true };
  const cfg = { ...base, toolPolicy: 'allowlist', allowTools: ['todo_write', 'MCP__Docs__*'] };
  for (const name of ['codex_run', 'codex_status', 'gemini_write', 'tool_call', 'read', 'grep', 'glob', 'ops_glob', 'ops_read_files',
    'wsl-read', 'wsl-grep', 'mcp__fs__read_file', 'mcp__serena__find_symbol', 'mcp__serena__find_referencing_symbols',
    'mcp__notes__obsidian_read', 'obsidian_list', 'mcp__seep-reverse-lab__seep_r2_info', 'mcp__seep_reverse_lab__seep_status',
    'todo_write', 'Todo_Write', 'mcp__docs__query']) {
    assert.equal(knownTool(name, cfg), true, name);
    assert.equal(decide(call(name, {}), cfg), undefined, name);
  }
  assert.equal(decide(call('wsl', { command: 'git status' }), cfg), undefined);
  assert.match(decide(call('wsl', { command: 'rm x' }), cfg), /不放行的是「rm x」/);
  for (const name of ['web_search', 'ls', 'todo_writer', 'mcp__git__git_status', 'mcp__doc__query', 'mcp__x__seep_r2_strings']) {
    assert.equal(knownTool(name, cfg), false, name);
    const denied = decide(call(name, {}), cfg);
    assert.match(denied, /白名单模式下未放行，确需使用请把工具名加入插件配置 allowTools/, name);
    assert.ok(denied.includes(name), name);
    assert.match(decide(call(name, {}), { ...cfg, plannerReads: 'products' }), /allowTools/, name);
    // 默认的 denylist 行为不变
    assert.equal(decide(call(name, {}), base), undefined, name);
    assert.equal(decide(call(name, {}), { ...base, toolPolicy: 'denylist', allowTools: [] }), undefined, name);
  }
  // 已有的拒绝规则在前，allowTools 不能把它们放出来
  assert.match(decide(call('write', {}), { ...cfg, allowTools: ['write'] }), /会直接改动文件或执行任意代码/);
  assert.match(decide(call('mcp__docs__write_file', {}), cfg), /会改动文件或执行命令/);
  assert.equal(knownTool('gemini_write', { ...cfg, gemini: false }), false);
  assert.equal(knownTool('anything', { allowTools: ['*'] }), true);
  assert.equal(knownTool('anything'), false);
});

test('mcpWriteAllow applies to direct tools and host-dispatched tool_call children', () => {
  const diagram = 'mcp__drawio__create_new_diagram';
  const other = 'mcp__foo__delete_file';
  const base = config('products');
  const cfg = { ...base, mcpWriteAllow: ['MCP__DrawIO__*'] };
  const strict = { ...cfg, toolPolicy: 'allowlist' };
  const exact = { ...base, mcpWriteAllow: [diagram.toUpperCase()] };
  for (const parent of [undefined, Symbol('tool_call')]) {
    const guard = (name, settings) => {
      // The host guards the wrapper, then dispatches the child with its own name.
      if (parent) {
        const denied = decide(call('tool_call', {}), settings);
        if (denied) return denied;
      }
      return decide({ ...call(name, {}), parent }, settings);
    };
    assert.equal(guard(diagram, base), shortDenial);
    assert.equal(guard(diagram, { ...base, allowTools: [diagram] }), shortDenial);
    assert.equal(guard(diagram, cfg), undefined);
    assert.equal(guard(diagram, strict), undefined);
    assert.equal(guard(diagram, exact), undefined);
    assert.equal(guard('mcp__drawio__delete_diagram', exact), shortDenial);
    assert.equal(guard(other, cfg), shortDenial);
    assert.equal(guard(other, strict), shortDenial);
    assert.match(guard('mcp__foo__query', strict), /白名单模式下未放行/);
  }
});

test('mcpWriteAllow leaves the other denials in force', () => {
  const diagram = 'mcp__drawio__create_new_diagram';
  const cfg = { ...config('products'), mcpWriteAllow: ['mcp__*'], denyTools: new Set([diagram.toUpperCase()]) };
  for (const name of ['write', 'run_code', diagram]) {
    assert.equal(decide(call(name, {}), cfg), shortDenial, name);
  }
  assert.equal(decide(call('mcp__notes__obsidian_frontmatter', { action: 'set' }), cfg), shortDenial);
  assert.equal(decide(call('wsl', { command: 'rm x' }), cfg), shortDenial);
});

test('tools the read boundary does not know stay unchecked in the default policy, with or without path arguments', () => {
  // 线上有带 path 参数的未知工具（Seep 结构化查询读工作区二进制、接口类工具的 path: '/v1/x'）；收紧走白名单模式。
  const calls = [['mcp__seep__seep_r2_strings', { path: '/repo/bin/app' }], ['mcp__api__request', { path: '/v1/x' }],
    ['view', { path: '/repo/secret.js' }], ['glob', { path: '/repo', pattern: '**' }], ['mcp__cbm__get_code_snippet', { qualified_name: 'x' }]];
  for (const plannerReads of ['open', 'products']) {
    const scope = createProductReads(config(plannerReads), completed);
    scope.addGemini('S1', ['/repo/docs/ch1.md']);
    for (const [name, args] of calls) {
      assert.deepEqual(plannerReadTargets(call(name, args), '/repo'), [], name);
      assert.equal(scope.checkSync(call(name, args)), undefined, `${plannerReads} ${name}`);
      assert.equal(decide(call(name, args), config(plannerReads)), undefined, `${plannerReads} ${name}`);
    }
  }
});

test('run_code that tries to reach codex_* or gemini_write gets the preset explanation in both read modes', () => {
  for (const plannerReads of ['open', 'products']) {
    const cfg = { ...config(plannerReads), gemini: true };
    for (const args of [{ code: 'await tools.codex_run({ task: "x" })' }, { source: 'tools["codex_status"]({})' },
      { code: 'tools.gemini_write({ output: "a.md" })' }, 'return tools.codex_jobs()']) {
      const denied = decide(call('run_code', args), cfg);
      assert.equal(denied, RUN_CODE_DENY, JSON.stringify(args));
      assert.match(denied, /不执行规划端代码.*ops-ptc.*切回 standard.*直接调用 codex_run.*不要换别的代码或工具入口重试/);
    }
    // 其他 run_code 调用的拒绝文案不变，也仍然不放行
    for (const args of [{}, { code: 'print(1)' }, { code: 'subagent_codex()' }, { code: 'my_codex_run()' }]) {
      const denied = decide(call('run_code', args), cfg);
      assert.notEqual(denied, RUN_CODE_DENY, JSON.stringify(args));
      assert.equal(denied, plannerReads === 'products' ? shortDenial : denied);
      assert.match(denied, plannerReads === 'products' ? /已拒绝/ : /run_code 会直接改动文件或执行任意代码，已拒绝/);
    }
  }
});

test('awk regex literals and strings may contain | while pipes stay refused', () => {
  allowed(["awk '/foo|bar/ {print $1}' f", "awk '$1 ~ /a|b/ {print}' f", "awk '!/a|b/' f", "awk '/a|b/ || /c|d/' f",
    "awk 'BEGIN{n=0} /a|b/ {n++} END{print n}' f", "awk '{print $1 \"|\" $2}' f", "awk '{ if ($0 ~ /x|y/) print $2 }' f",
    "awk '/a\\/b|c/ {print}' f",
    // 只有 || 没有管道的程序原来就放行，带除法也不能因为新的扫描变成拒绝
    "awk '$1 > 0 || $2 / 2 == 1' f", "awk '/a/ || $2/2 == 1 {print $1}' f"]);
  refused(["awk '{print | \"sh\"}' f", "awk '{print $1 | \"sort\"}' f", "awk '/a|b/ {print | \"sh\"}' f",
    "awk '{ \"date\" | getline d; print d }' f", "awk '{print |& \"sh\"}' f", "awk '{print \"a|b\" | \"sh\"}' f",
    // print 后的 /"/ 是正则：不能把其中的引号当字符串开头，吞掉后面的管道
    "awk '{ print /\"/ ; print | \"sh\" ; print /\"/ }' f", "awk '{ print /a/ | \"sh\" }' f",
    // 除号不是正则的开头：两个 / 之间的管道不能被当成正则吞掉
    "awk '{ print a / 2 | \"sh\"; y = b / 2 }' f", "awk '{ print (a) / 2 | \"sh\"; y = 1 / 2 }' f",
    // gawk 允许 [ ] 里出现 /；拿不准正则在哪里结束时按有管道处理
    "awk '/[/]a,/ { print | \"sh\" } /b/' f", "awk '/[a|b]/' f", "awk '/a|b' f", "awk '{print \"a|b}' f",
    "awk '{ x = 1\n/ 2 | \"sh\" / 1 }' f"]);
});

test('pwsh test scripts with absolute or parent paths must stay inside the session directory', () => {
  const inside = (c, cwd) => readOnlyCommand(c, [], undefined, cwd);
  for (const c of ['pwsh -NoProfile -File tests/a.ps1', "pwsh -NoProfile -File 'D:\\x\\proj\\tests\\a.ps1'",
    'pwsh -NoProfile -File /mnt/d/x/proj/sub/tests/a.ps1 -Configuration Release', 'pwsh -NoProfile -File sub/../tests/a.ps1']) {
    assert.equal(inside(c, '/mnt/d/x/proj'), true, c);
  }
  assert.equal(readOnlyCommand('pwsh -NoProfile -File tests/a.ps1'), true);
  for (const c of ['pwsh -NoProfile -File /tmp/evil/tests/a.ps1', "pwsh -NoProfile -File 'D:\\x\\other\\tests\\a.ps1'",
    "pwsh -NoProfile -File 'D:\\x\\proj-old\\tests\\a.ps1'", 'pwsh -NoProfile -File ../other/tests/a.ps1',
    'pwsh -NoProfile -File /mnt/d/x/proj/../other/tests/a.ps1', 'pwsh -NoProfile -File ~/tests/a.ps1',
    "pwsh -NoProfile -File 'C:tests\\a.ps1'", "pwsh -NoProfile -File '\\\\server\\share\\tests\\a.ps1'"]) {
    assert.equal(inside(c, '/mnt/d/x/proj'), false, c);
  }
  for (const c of ['pwsh -NoProfile -File /mnt/d/x/proj/tests/a.ps1', 'pwsh -NoProfile -File ../tests/a.ps1']) {
    assert.equal(readOnlyCommand(c), false, c);
  }
  assert.equal(decide(call('wsl', { command: 'pwsh -NoProfile -File /repo/tests/a.ps1' }), config('open')), undefined);
  assert.match(decide(call('wsl', { command: 'pwsh -NoProfile -File /other/tests/a.ps1' }), config('open')), /不放行的是「pwsh/);
});
