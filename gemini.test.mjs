import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

// Drafts go under LOCALAPPDATA; never touch the real one.
const localAppData = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-gemini-local-')));
process.env.LOCALAPPDATA = localAppData;
after(() => rmSync(localAppData, { recursive: true, force: true }));
const { geminiWrite, runGemini, leaseAgyAccount } = await import('./gemini.mjs');
const http = await import('node:http');
const { normPath } = await import('./guard.mjs');

const CFG = { command: 'C:\\fixture\\agy.exe', model: 'gemini-test', effort: 'low', timeoutSeconds: 30, idleTimeoutSeconds: 10 };
const WRITING = { prompt: '根据素材写这一章的入门说明，不要编造事实。', sources: ['notes.md'], output: 'chapter.md' };
const conductor = { list: async () => ({ jobs: [], total: 0 }) };
const writeEvent = (child, file) => child.stdout.write(JSON.stringify({ event: 'step_update',
  step_update: { step_type: 'tool', tool_name: 'write_file', tool_info: { parameters: { Path: file } } } }) + '\n');
const done = (child, code = 0, result = { status: 'SUCCESS', response: '已写入' }) => {
  if (result) child.stdout.write(JSON.stringify({ event: 'result', result }) + '\n');
  child.stdout.end();
  child.stderr.end();
  child.emit('close', code);
};

// action({ child, cwd, output }) plays agy; the default writes the chapter and succeeds.
function fixture(t, action, cfg = CFG) {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-gemini-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(path.join(cwd, 'notes.md'), '素材事实：每章只说明一个操作。');
  const spawns = [];
  const launch = (_command, argv, options) => {
    const child = new EventEmitter();
    Object.assign(child, { argv, env: options.env, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { setImmediate(() => this.emit('close', null)); return true; } });
    spawns.push(child);
    child.stdin.resume();
    child.stdin.on('finish', () => setImmediate(() => (action ?? (({ child, output }) => {
      writeFileSync(output, '新写的正文\n');
      writeEvent(child, output);
      done(child);
    }))({ child, cwd: options.cwd, output: path.join(options.cwd, 'chapter.md') })));
    return child;
  };
  return { cwd, spawns, output: path.join(cwd, 'chapter.md'),
    execute: (args = {}, options = {}) => geminiWrite(cfg, { ...WRITING, cwd, ...args }, conductor, options, launch) };
}

// dsh-agy-link's lease API on a loopback port, announced in .link-endpoint.json next to pool.json.
// replies[route] queues [status, body] overrides; routes: false answers a plain 404 (a plugin without leases).
async function fakeLink(t, { routes = true, ttlMs = 60_000 } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-link-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pool = path.join(dir, 'pool.json');
  writeFileSync(pool, JSON.stringify({ primaryAccountId: 'acc_primary', accounts: [
    { id: 'acc_primary', dir: '', systemHome: true, enabled: true, proxyUrl: 'http://127.0.0.1:50577' },
    { id: 'acc_a', dir: 'D:\\pool\\a', enabled: true, proxyUrl: 'http://127.0.0.1:7894' }] }));
  const link = { pool, calls: [], replies: {}, leases: new Set(), count: 0 };
  const env = { HOME: 'D:\\pool\\a', USERPROFILE: 'D:\\pool\\a', GEMINI_CLI_HOME: 'D:\\pool\\a', HTTPS_PROXY: 'http://127.0.0.1:7894',
    NO_PROXY: 'localhost', BROWSER: 'none' };
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      const route = request.url.split('/').pop(), body = JSON.parse(text);
      link.calls.push([route, body]);
      let [status, reply] = !routes ? [404, 'Not Found'] : link.replies[route]?.shift() ?? [200, null];
      if (!reply && route === 'acquire') {
        const lease = `lease-${++link.count}`;
        link.leases.add(lease);
        reply = { ok: true, leaseId: lease, ttlMs, expiresAt: 0, slot: false, env,
          account: { id: 'acc_a', email: '', alias: '', primary: false, isolated: true, home: 'D:\\pool\\a', proxyUrl: 'http://127.0.0.1:7894' } };
      } else if (!reply) {
        [status, reply] = link.leases.has(body.leaseId) ? [200, { ok: true, expiresAt: 0 }] : [404, { ok: false, code: 'lease_not_found' }];
        if (route === 'release') link.leases.delete(body.leaseId);
      }
      response.writeHead(status).end(typeof reply === 'string' ? reply : JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  writeFileSync(path.join(dir, '.link-endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/plugins/agy-link`, pid: 1, startedAt: 0 }));
  return { ...link, env, endpoint: path.join(dir, '.link-endpoint.json'), routes: () => link.calls.map(([route]) => route) };
}

// The agy proxy in the environment must not catch the loopback lease calls.
function proxied(t) {
  const saved = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  t.after(() => { if (saved === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = saved; });
}

test('gemini_write leases its account from dsh-agy-link, runs with the lease env and releases with the outcome', async (t) => {
  proxied(t);
  const link = await fakeLink(t);
  const h = fixture(t, undefined, { ...CFG, accountPool: link.pool, proxy: 'http://configured.invalid:3' });
  assert.equal((await h.execute()).status, 'completed');
  const { env } = h.spawns[0];
  for (const [key, value] of Object.entries(link.env)) assert.equal(env[key], value, key);
  assert.deepEqual(link.routes(), ['acquire', 'release']);
  assert.equal(link.calls[0][1].holder, 'dsh-codex-conductor/gemini_write');
  assert.equal(link.calls[0][1].model, CFG.model);
  assert.ok(!('accountDir' in link.calls[0][1]) && !('accountId' in link.calls[0][1]));
  assert.deepEqual(link.calls[1][1], { leaseId: 'lease-1', ok: true, model: CFG.model });

  const failed = fixture(t, ({ child }) => { child.stderr.write('auth failed'); done(child, 1, null); }, { ...CFG, accountPool: link.pool });
  assert.equal((await failed.execute()).status, 'failed');
  const release = link.calls.at(-1);
  assert.equal(release[0], 'release');
  assert.equal(release[1].ok, false);
  assert.match(release[1].error, /auth failed/);
  assert.equal(link.leases.size, 0);

  link.replies.acquire = [[503, { ok: false, code: 'no_account', error: 'every account is cooling down', retryAfterMs: 3600e3 }]];
  const refused = fixture(t, undefined, { ...CFG, accountPool: link.pool });
  const value = await refused.execute();
  assert.equal(value.status, 'failed');
  assert.match(value.error, /no_account：every account is cooling down/);
  assert.equal(refused.spawns.length, 0);
});

test('gemini_write without the lease API runs on the primary only', async (t) => {
  proxied(t);
  for (const setup of ['missing', 'not upgraded']) await t.test(setup, async (t) => {
    const link = await fakeLink(t, { routes: setup !== 'not upgraded' });
    if (setup === 'missing') rmSync(link.endpoint);
    const h = fixture(t, undefined, { ...CFG, accountPool: link.pool, proxy: 'http://configured.invalid:3' });
    const value = await h.execute();
    assert.equal(value.status, 'completed');
    assert.match(value.lease_note, /本次用主账号运行，未租用/);
    const { env } = h.spawns[0];
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.USERPROFILE, process.env.USERPROFILE);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:50577');
  });
});

test('the agy lease is renewed and re-acquired on the same account after DSH forgets it', async (t) => {
  proxied(t);
  const link = await fakeLink(t, { ttlMs: 30 });
  const lease = await leaseAgyAccount(link.pool, { holder: 'test', model: 'm' });
  const until = async (check) => { for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };
  await until(() => link.routes().includes('renew'));
  assert.deepEqual(link.calls.find(([route]) => route === 'renew')[1], { leaseId: 'lease-1', ttlMs: 60_000 });
  link.leases.clear();
  await until(() => link.leases.has('lease-2'));
  assert.equal(link.calls.filter(([route]) => route === 'acquire')[1][1].accountDir, 'D:\\pool\\a');
  await lease.release(true);
  assert.equal(link.calls.at(-1)[1].leaseId, 'lease-2');
  assert.equal(link.leases.size, 0);
});

test('gemini_write passes --effort only when an effort is configured', async (t) => {
  for (const [effort, expected] of [['low', 'low'], ['', undefined]]) await t.test(effort || 'unset', async (t) => {
    const h = fixture(t, undefined, { ...CFG, model: 'gemini-4-carbon-high', effort });
    assert.equal((await h.execute()).status, 'completed');
    const { argv } = h.spawns[0];
    assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-4-carbon-high');
    assert.equal(argv.includes('--effort') ? argv[argv.indexOf('--effort') + 1] : undefined, expected);
  });
});

test('an existing target that agy leaves untouched is neither completed nor saved as a draft', async (t) => {
  for (const [name, action] of [['success without writing', ({ child }) => done(child)],
    ['CLI failure before writing', ({ child }) => { child.stderr.write('auth failed'); done(child, 1, null); }]]) {
    for (const frontmatter of [undefined, { title: '新标题', tags: ['课程'] }]) await t.test(`${name}${frontmatter ? ' with frontmatter' : ''}`, async (t) => {
      const h = fixture(t, action);
      const original = '---\ntitle: 旧标题\n---\n旧正文\n';
      writeFileSync(h.output, original);
      const value = await h.execute({ overwrite: true, frontmatter });
      assert.equal(value.status, 'failed');
      assert.match(value.error, /没有改写 output/);
      assert.equal(Object.hasOwn(value, 'draft_path'), false, 'the old file must not be offered as a failed draft');
      assert.doesNotMatch(value.next, /可用 reuse_draft/);
      assert.equal(value.rolled_back, true);
      assert.equal(value.restored_to, 'original_content');
      assert.equal(readFileSync(h.output, 'utf8'), original);
      assert.equal(existsSync(path.join(localAppData, 'dsh-codex-conductor', 'gemini-drafts')), false);
    });
  }
});

test('a rewritten target completes, and reuse_draft may equal the existing file', async (t) => {
  const h = fixture(t);
  writeFileSync(h.output, '旧正文\n');
  const value = await h.execute({ overwrite: true });
  assert.equal(value.status, 'completed', value.error);
  assert.equal(readFileSync(h.output, 'utf8'), '新写的正文\n');
  const drafts = path.join(localAppData, 'dsh-codex-conductor', 'gemini-drafts');
  mkdirSync(drafts, { recursive: true });
  t.after(() => rmSync(path.join(localAppData, 'dsh-codex-conductor'), { recursive: true, force: true }));
  const draft = path.join(drafts, 'same.md');
  writeFileSync(draft, '新写的正文\n');
  const reused = await h.execute({ overwrite: true, reuse_draft: draft });
  assert.equal(reused.status, 'completed', reused.error);
  assert.equal(reused.reused_draft, true);
  assert.equal(h.spawns.length, 1, 'reuse skips agy');
});

test('only a leading block of YAML keys and list items is removed as model frontmatter', async (t) => {
  const header = /^---\ncreated: [^\n]+\nupdated: [^\n]+\ntitle: "插件标题"\n[^]*?\n---\n/;
  for (const [written, body] of [
    ['---\n# 第一章\n\n第一节正文。\n\n---\n\n第二节。\n', '---\n# 第一章\n\n第一节正文。\n\n---\n\n第二节。\n'],
    ['---\n- 要点一\n- 要点二\n---\n正文\n', '---\n- 要点一\n- 要点二\n---\n正文\n'],
    ['---\n注意: 这不是元数据\n---\n正文\n', '---\n注意: 这不是元数据\n---\n正文\n'],
    ['---\ntitle: wrong\ntags:\n  - a\n  - b\naliases: []\n---\n正文\n', '正文\n'],
    ['\uFEFF---\r\ntags: [wrong]\r\n...\r\n正文\n', '正文\n'],
    ['---\n---\n正文\n', '正文\n'],
  ]) {
    const h = fixture(t, ({ child, output }) => { writeFileSync(output, written); writeEvent(child, output); done(child); });
    const value = await h.execute({ frontmatter: { title: '插件标题', tags: ['课程'] } });
    assert.equal(value.status, 'completed', value.error);
    const content = readFileSync(h.output, 'utf8');
    assert.match(content, header);
    assert.equal(content.replace(header, ''), body, JSON.stringify(written));
    assert.equal(value.chars, [...body].length);
  }
});

test('a child that never closes after kill is settled by the fallback timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let kills = 0, settled;
  const launch = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { kills++; return true; } });
  const pending = runGemini(CFG, 'prompt', { signal: controller.signal }, launch).then((value) => { settled = value; });
  controller.abort();
  assert.equal(kills, 1);
  t.mock.timers.tick(4999);
  await new Promise(setImmediate);
  assert.equal(settled, undefined, 'the close event still has its grace period');
  t.mock.timers.tick(1);
  await pending;
  assert.match(settled.error, /已被中止.*5 秒内未关闭，已强制收尾/);
});

test('aborting ends the whole Windows process tree and returns once its pipes close', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const controller = new AbortController();
  let grandchild;
  // The grandchild inherits stdout, so killing only the direct child would leave the pipe open.
  const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    console.log(JSON.stringify({ pid: c.pid })); setInterval(() => {}, 1000);`;
  const launch = (_command, _argv, options) => {
    const child = spawn(process.execPath, ['-e', script], options);
    child.stdout.once('data', (data) => { grandchild = JSON.parse(String(data)).pid; controller.abort(); });
    return child;
  };
  const value = await runGemini(CFG, 'prompt', { signal: controller.signal }, launch);
  assert.match(value.error, /已被中止/);
  assert.doesNotMatch(value.error, /强制收尾/, 'the tree was closed before the fallback');
  assert.equal(Number.isInteger(grandchild), true);
  const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
  for (let n = 0; n < 50 && alive(); n++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, 'the grandchild must not survive');
});

test('sourceRoots rejects sources outside the given roots before launch and is optional', async (t) => {
  const h = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-gemini-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const secret = path.join(outside, 'secret.md');
  writeFileSync(secret, '范围外素材');
  const sourceRoots = [normPath(h.cwd)];
  const denied = await h.execute({ sources: ['notes.md', secret] }, { sourceRoots });
  assert.equal(denied.status, 'failed');
  assert.match(denied.error, /sources 超出本会话允许读取的范围/);
  assert.ok(denied.error.includes(secret));
  assert.equal(denied.error.includes(path.join(h.cwd, 'notes.md')), false, 'only out-of-range sources are listed');
  assert.equal(h.spawns.length, 0);
  assert.equal(existsSync(h.output), false);
  assert.equal((await h.execute({ sources: ['notes.md', secret] }, { sourceRoots: [...sourceRoots, normPath(outside)] })).status, 'completed');
  rmSync(h.output);
  assert.equal((await h.execute({ sources: [secret] })).status, 'completed', 'no roots keeps the previous behaviour');
});

test('rollback removes the parent directories created for this call and keeps ones that hold other files', async (t) => {
  const empty = fixture(t, ({ child, output }) => { writeFileSync(path.join(path.dirname(output), 'new', 'deep', 'chapter.md'), '半截'); done(child, 1, null); });
  const failed = await empty.execute({ output: 'new/deep/chapter.md' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.target_exists, false);
  assert.equal(typeof failed.draft_path, 'string');
  assert.deepEqual(readdirSync(empty.cwd), ['notes.md']);

  const shared = fixture(t, ({ child, cwd }) => {
    writeFileSync(path.join(cwd, 'new', 'deep', 'chapter.md'), '正文');
    writeFileSync(path.join(cwd, 'new', 'other.md'), '范围外文件');
    writeEvent(child, path.join(cwd, 'new', 'other.md'));
    done(child);
  });
  const value = await shared.execute({ output: 'new/deep/chapter.md' });
  assert.equal(value.status, 'failed');
  assert.match(value.error, /output 以外的改动/);
  assert.deepEqual(readdirSync(path.join(shared.cwd, 'new')), ['other.md'], 'out-of-scope files are reported, never deleted');

  const existing = fixture(t, ({ child }) => done(child, 1, null));
  mkdirSync(path.join(existing.cwd, 'kept'));
  assert.equal((await existing.execute({ output: 'kept/chapter.md' })).status, 'failed');
  assert.equal(existsSync(path.join(existing.cwd, 'kept')), true, 'a directory that already existed stays');
});
