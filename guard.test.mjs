import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProductReads, plannerReadTargets, readPath, decide, PRODUCT_HINT, PRODUCT_DENY_HINT } from './guard.mjs';

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
