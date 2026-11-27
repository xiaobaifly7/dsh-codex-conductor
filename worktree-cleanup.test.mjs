import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { apply, createConductor } = await import('./index.mjs');
const { openWorktree, closeWorktree, within } = await import('./worktree.mjs');
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-cleanup-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const HOUR = 3_600_000;
let sequence = 0;

async function fixture({ age = 25 * HOUR } = {}) {
  const base = path.join(tmp, String(++sequence));
  const repo = path.join(base, 'repo');
  const stateDir = path.join(base, 'state');
  mkdirSync(repo, { recursive: true });
  mkdirSync(stateDir);
  writeFileSync(path.join(repo, '.gitignore'), '*.bin\n');
  writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const owner = `session-${String(sequence).padStart(8, '0')}-0000`;
  const entry = { status: 'open', repo, ...await openWorktree({ repo, owner }),
    created_at: new Date(Date.now() - age).toISOString(), at: new Date(Date.now() - age).toISOString() };
  const key = `${owner}::${repo.replace(/\\/g, '/').toLowerCase()}`;
  const file = path.join(stateDir, 'session-worktrees.json');
  const save = value => writeFileSync(file, JSON.stringify({ [key]: value }));
  save(entry);
  const current = () => JSON.parse(readFileSync(file, 'utf8'))[key];
  const caller = { agent: { id: owner, session: { header: { cwd: repo }, log: [] } } };
  const oldJob = { job_id: 'old', status: 'completed', cwd: entry.path, context: { owner, write: true },
    verification_status: 'verified', started_at: Date.parse(entry.created_at) / 1000,
    finished_at: (Date.now() - age) / 1000, updated_at: (Date.now() - age) / 1000 };
  function harness({ jobs = [oldJob], listed, activity, starting, initial = true } = {}) {
    const tools = {}, handlers = {}, injections = [], calls = [], starts = [];
    const run = async (_cfg, argv, options = {}) => {
      calls.push(argv);
      if (argv[0] === 'list') {
        if (listed) return listed(argv);
        const owners = argv.flatMap((arg, i) => ['--owner', '--also-owner'].includes(arg) ? [argv[i + 1]] : []);
        const matching = argv.includes('--parent-job') ? [] : jobs.filter(job => !owners.length || owners.includes(job.context?.owner));
        const offset = Number(argv[argv.indexOf('--offset') + 1]);
        const limit = Number(argv[argv.indexOf('--limit') + 1]);
        const next = offset + limit;
        return { status: 'completed', jobs: matching.slice(offset, next), next_offset: next < matching.length ? next : null };
      }
      if (argv[0] === 'worktree-activity') {
        if (activity) return activity(argv);
        return { status: 'completed', worktrees: argv.slice(1).filter((_, i) => i % 2 === 1).map(root => {
          const mine = jobs.filter(job => [job.cwd, ...(job.scope ?? []), ...(job.scope_paths ?? []), ...(job.task_options?.writable_roots ?? [])]
            .some(p => typeof p === 'string' && (within(path.resolve(job.cwd, p), root) || within(root, path.resolve(job.cwd, p)))));
          return { path: root, running: mine.filter(job => ['pending', 'running'].includes(job.status) || job.execution_status === 'running').map(job => job.job_id),
            last_activity_at: Math.max(0, ...mine.flatMap(job => [job.started_at, job.finished_at, job.updated_at].filter(Number.isFinite))) };
        }) };
      }
      if (argv[0] === 'status') return jobs.find(job => job.job_id === argv[1]);
      if (argv[0] === 'review') return { ...jobs.find(job => job.job_id === argv[1]),
        verification_status: JSON.parse(options.stdin).status, verification: { time: Date.now() / 1000 } };
      if (argv[0] === 'products') return { status: 'completed', paths: [] };
      if (argv[0] === 'start') {
        starts.push({ argv, payload: JSON.parse(options.stdin) });
        if (starting) return starting(starts.at(-1));
        return { job_id: `NEW-${starts.length}`, status: 'completed', cwd: argv[argv.indexOf('--cwd') + 1],
          context: starts.at(-1).payload.context, structured: { summary: 'done',
            criteria: [{ criterion: 'a.txt is updated', status: 'met', evidence: 'a.txt' }],
            files_changed: [], deviations: [], unresolved: [], blockers: [] } };
      }
      throw new Error(`Unexpected runner call: ${argv.join(' ')}`);
    };
    apply({ tools: { register(tool) { tools[tool.name] = tool; }, guard() {} },
      on(name, handler) { (handlers[name] ??= []).push(handler); },
      inject(deps, fn) { if (deps.length === 1 && deps[0] === 'appReady') injections.push(fn); },
      get() {}, logger: { warn() {}, info() {} } },
    { stateDir, workspaces: [base], worktree: { repos: [repo] }, autoVerify: 'off', closeoutGuard: false,
      waitSeconds: 0, jobDiff: false, repeatFailureGuard: false, closeoutEvidence: 'off' }, run);
    const emit = async (name, value) => { for (const handler of handlers[name] ?? []) await handler(value); };
    return { tools, calls, starts, emit, load: async () => { if (initial) for (const fn of injections) await fn(); },
      status: () => tools.codex_worktree.execute({ action: 'status' }, caller),
      write: (args = {}) => tools.codex_run.execute({ task: 'Update a.txt.', acceptance: ['a.txt is updated'],
        write: true, ...args }, caller) };
  }
  return { repo, stateDir, owner, entry, key, file, save, current, caller, oldJob, harness };
}

test('load closes an idle, clean and fully merged worktree, preserving its ignored output', async () => {
  const f = await fixture();
  writeFileSync(path.join(f.entry.path, 'output.bin'), 'keep me');
  const h = f.harness();
  await h.load();
  assert.equal(f.current().status, 'closed');
  assert.equal(f.current().last_cleanup.status, 'closed');
  assert.equal(existsSync(f.entry.path), false);
  assert.equal(readFileSync(path.join(f.repo, 'output.bin'), 'utf8'), 'keep me');
  assert.equal((await h.status()).worktrees[0].last_cleanup.status, 'closed');
});

test('cleanup uses one activity scan for every job type, owner, pending registration and descendant cwd', async () => {
  for (const context of [{ write: true }, { write: false }, { verification_of: 'source', write: false }]) {
    const f = await fixture();
    const h = f.harness({ jobs: [f.oldJob, { job_id: 'RUN', status: 'pending', cwd: path.join(f.entry.path, 'sub'),
      context: { owner: 'someone-else', ...context } }] });
    await h.load();
    assert.equal(f.current().status, 'open');
    assert.equal(f.current().last_cleanup.reason, 'running');
    assert.equal(h.calls.filter(argv => argv[0] === 'worktree-activity').length, 1);
    assert.equal(h.calls.filter(argv => argv[0] === 'list').length, 0);
    assert.match(JSON.stringify((await h.status()).worktrees[0].last_cleanup), /RUN/);
  }
});

test('cleanup skips dirty, unmerged, merging, missing and recent worktrees and persists why', async () => {
  for (const reason of ['worktree_dirty', 'not_merged', 'merging', 'missing', 'recent']) {
    const f = await fixture({ age: reason === 'recent' ? 24 * HOUR : 25 * HOUR });
    if (reason === 'worktree_dirty') writeFileSync(path.join(f.entry.path, 'a.txt'), 'dirty');
    if (reason === 'not_merged') {
      writeFileSync(path.join(f.entry.path, 'a.txt'), 'committed');
      git(f.entry.path, 'commit', '-am', 'work');
    }
    if (reason === 'merging') writeFileSync(path.join(f.repo, '.git', 'worktrees', path.basename(f.entry.path), 'MERGE_HEAD'), git(f.repo, 'rev-parse', 'HEAD'));
    if (reason === 'missing') git(f.repo, 'worktree', 'remove', f.entry.path);
    const h = f.harness({ jobs: reason === 'recent' ? [{ ...f.oldJob, updated_at: Date.now() / 1000 }] : [f.oldJob] });
    await h.load();
    assert.equal(f.current().status, 'open', reason);
    assert.equal(f.current().last_cleanup.reason, reason);
    assert.equal((await h.status()).worktrees[0].last_cleanup.reason, reason);
  }
});

test('cleanup keeps both same-named ignored copies and exposes the close refusal', async () => {
  const f = await fixture();
  writeFileSync(path.join(f.repo, 'clash.bin'), 'original');
  writeFileSync(path.join(f.entry.path, 'clash.bin'), 'worktree');
  const h = f.harness();
  await h.load();
  assert.equal(f.current().last_cleanup.reason, 'ignored_clash');
  assert.equal(readFileSync(path.join(f.repo, 'clash.bin'), 'utf8'), 'original');
  assert.equal(readFileSync(path.join(f.entry.path, 'clash.bin'), 'utf8'), 'worktree');
});

test('cleanup errors persist, remain visible, and incomplete activity never permits deletion', async () => {
  for (const failure of ['activity', 'incomplete', 'throw', 'git']) {
    const f = await fixture();
    if (failure === 'git') f.save({ ...f.entry, branch: 'missing-branch' });
    const h = f.harness({ activity: failure === 'git' ? undefined : () => {
      if (failure === 'throw') throw new Error('offline');
      return failure === 'incomplete' ? { status: 'completed', worktrees: [] } : { status: 'failed', error: 'activity unavailable' };
    } });
    await h.load();
    assert.equal(f.current().status, 'open');
    assert.equal(f.current().last_cleanup.status, 'error');
    assert.match(f.current().last_cleanup.message, failure === 'git' ? /git rev-list/ : /offline|活动记录|activity unavailable/);
    assert.equal(existsSync(f.entry.path), true);
    assert.equal((await h.status()).worktrees[0].last_cleanup.status, 'error');
  }
});

test('another conversation review sweeps old worktrees with one batched activity query', async () => {
  const f = await fixture();
  const other = await fixture();
  writeFileSync(f.file, JSON.stringify({ [f.key]: f.entry, [other.key]: other.entry }));
  const owner = 'reviewing-another-conversation';
  const source = { ...f.oldJob, cwd: f.repo, context: { owner, write: true, task: 'Update a.txt.', acceptance: ['a.txt is updated'] },
    structured: { summary: 'done', criteria: [{ criterion: 'a.txt is updated', status: 'met', evidence: 'a.txt' }],
      files_changed: [], deviations: [], unresolved: [], blockers: [] } };
  const h = f.harness({ jobs: [source] });
  const receipt = await h.tools.codex_review.execute({ job_id: source.job_id, status: 'verified',
    criteria: [{ index: 1, status: 'met', evidence: 'a.txt was checked' }] }, { ...f.caller, agent: { ...f.caller.agent, id: owner } });
  assert.equal(receipt.verification_status, 'verified');
  assert.equal(f.current().status, 'closed');
  assert.equal(JSON.parse(readFileSync(f.file))[other.key].status, 'closed');
  assert.deepEqual(h.calls.filter(argv => argv[0] === 'worktree-activity'), [['worktree-activity', '--path', f.entry.path, '--path', other.entry.path]]);
  const calls = h.calls.length;
  await h.load();
  assert.equal(h.calls.length, calls, 'closed entries do not query history');
});

test('exactly 24 hours and recent finish, update or dispatch activity prevent cleanup', async t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const field of ['boundary', 'finished_at', 'updated_at', 'last_activity_at']) {
    const f = await fixture({ age: field === 'boundary' ? 24 * HOUR : 25 * HOUR });
    const job = { ...f.oldJob };
    if (field === 'last_activity_at') f.save({ ...f.entry, last_activity_at: new Date(now - HOUR).toISOString() });
    else if (field !== 'boundary') job[field] = (now - HOUR) / 1000;
    await f.harness({ jobs: [job] }).load();
    assert.equal(f.current().last_cleanup.reason, 'recent', field);
  }
  const unknown = await fixture();
  unknown.save({ ...unknown.entry, at: undefined });
  await unknown.harness({ jobs: [] }).load();
  assert.equal(unknown.current().last_cleanup.reason, 'activity_unknown');
});

test('checks are throttled across reloads without turning the check timestamp into activity', async () => {
  const f = await fixture({ age: 23 * HOUR });
  const h = f.harness();
  await h.load();
  const checked = f.current().last_cleanup;
  const reloaded = f.harness();
  await reloaded.load();
  await reloaded.emit('agent/status', { agent: f.caller.agent, status: 'busy' });
  await reloaded.emit('agent/status', { agent: f.caller.agent, status: 'idle' });
  assert.deepEqual(f.current().last_cleanup, checked);
  const activity = f.current().last_activity_at;
  f.save({ ...f.current(), last_activity_at: new Date(Date.now() - 25 * HOUR).toISOString(),
    last_cleanup: { ...checked, at: new Date(Date.now() - 31 * 60_000).toISOString() } });
  const aged = f.harness({ jobs: [{ ...f.oldJob, started_at: (Date.now() - 25 * HOUR) / 1000,
    finished_at: (Date.now() - 25 * HOUR) / 1000, updated_at: (Date.now() - 25 * HOUR) / 1000 }] });
  await aged.emit('agent/status', { agent: f.caller.agent, status: 'idle' });
  assert.equal(f.current().status, 'closed');
  assert.ok(activity, 'activity is retained separately before saveWorktree refreshes at');
});

test('closed conversations reopen for original cwd, old cwd, scope and continuation, including inherited records', async () => {
  for (const via of ['original', 'old', 'scope', 'continue', 'inherited']) {
    const f = await fixture();
    await closeWorktree(f.entry);
    f.save({ ...f.entry, status: 'closed' });
    if (via === 'inherited') {
      writeFileSync(path.join(f.stateDir, 'handover.json'), JSON.stringify({ links: { 'session-successor-0000': { from: f.owner } } }));
      f.caller.agent.id = 'session-successor-0000';
    }
    const source = { ...f.oldJob, job_id: 'OLD', thread_id: 'old-thread', sandbox: 'workspace-write',
      context: { owner: f.owner, write: true, task: 'Update a.txt.', acceptance: ['a.txt is updated'] },
      verification_status: 'unreviewed', structured: { summary: 'work', criteria: [{ criterion: 'a.txt is updated', status: 'not_met', evidence: 'needs rework' }],
        files_changed: [], deviations: [], unresolved: [], blockers: [] }, task_options: {} };
    const h = f.harness({ jobs: [source] });
    const value = via === 'continue' ? await h.tools.codex_continue.execute({ job_id: 'OLD', fresh: false }, f.caller)
      : await h.write(via === 'old' ? { cwd: f.entry.path, required_writes: [path.join(f.entry.path, 'a.txt')] }
        : via === 'scope' ? { cwd: path.dirname(f.repo), scope: [f.entry.path] } : {});
    assert.ok(value);
    assert.equal(h.starts.length, 1, via);
    const start = h.starts[0];
    const cwd = start.argv[start.argv.indexOf('--cwd') + 1];
    assert.notEqual(cwd, f.repo, via);
    assert.equal(existsSync(cwd), true, via);
    assert.equal(start.payload.context.routing.worktree_repo, f.repo, via);
    assert.equal(f.current().status === 'open' || Object.values(JSON.parse(readFileSync(f.file))).some(e => e.status === 'open'), true);
    const reopened = Object.values(JSON.parse(readFileSync(f.file))).find(e => e.status === 'open');
    assert.ok(Date.parse(reopened.created_at) > Date.parse(f.entry.created_at), 'reopening starts a fresh generation');
  }
});

test('reopening failures reject writes instead of silently dispatching in the original checkout', async () => {
  for (const failure of ['detached', 'history', 'busy']) {
    const f = await fixture();
    await closeWorktree(f.entry);
    f.save({ ...f.entry, status: 'closed' });
    if (failure === 'detached') git(f.repo, 'checkout', '-q', '--detach');
    const h = f.harness({ jobs: failure === 'busy' ? [{ ...f.oldJob, cwd: f.repo, status: 'running' }] : [f.oldJob],
      listed: failure === 'history' ? () => ({ error: 'offline' }) : undefined });
    await assert.rejects(h.write(), /worktree/);
    assert.equal(h.starts.length, 0);
  }
});

test('manual close also waits for running verification jobs', async () => {
  const f = await fixture();
  const h = f.harness({ jobs: [{ ...f.oldJob, job_id: 'VERIFY', status: 'completed', execution_status: 'running',
    context: { owner: f.owner, verification_of: 'original', write: false } }] });
  const merge = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
  assert.equal(merge.worktrees[0].status, 'nothing', 'existing merge conditions stay unchanged');
  const receipt = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
  assert.match(receipt.worktrees[0].note, /还有单在跑（VERIFY）/);
  assert.equal(existsSync(f.entry.path), true);
});

test('a write racing load cleanup reserves the worktree under the repository lock', async () => {
  for (const first of ['write', 'cleanup']) {
    const f = await fixture();
    const h = f.harness();
    await Promise.all(first === 'write' ? [h.write(), h.load()] : [h.load(), h.write()]);
    const start = h.starts[0];
    const cwd = start.argv[start.argv.indexOf('--cwd') + 1];
    assert.equal(existsSync(cwd), true);
    assert.notEqual(cwd, f.repo);
    assert.equal(f.current().status, 'open');
  }
});

test('conflict placement failures return an error receipt with the actual merge failure', async () => {
  const f = await fixture({ age: 0 });
  writeFileSync(path.join(f.entry.path, 'a.txt'), 'worktree\n');
  git(f.entry.path, 'commit', '-am', 'worktree edit');
  writeFileSync(path.join(f.repo, 'a.txt'), 'main\n');
  git(f.repo, 'commit', '-am', 'main edit');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  const index = readFileSync(path.join(f.repo, '.git', 'index'));
  writeFileSync(path.join(f.repo, '.git', 'worktrees', path.basename(f.entry.path), 'index.lock'), 'occupied');
  const h = f.harness();
  const result = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
  assert.equal(result.worktrees[0].status, 'error');
  assert.match(result.worktrees[0].note, /合并没有完成：冲突没能放进 worktree：.*index.lock/s);
  assert.equal(result.status, 'ok', 'the tool envelope stays ok; the merge item carries error');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(path.join(f.repo, '.git', 'index')), index);
  assert.equal(readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'main\n');
  assert.equal(f.current().last_merge.status, 'error');
});


test('manual close preserves a dispatch reserved before runner registration and releases it afterwards', { timeout: 5000 }, async () => {
  for (const outcome of ['success', 'failure', 'abort']) {
    const f = await fixture();
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    let delayed = false;
    const controller = new AbortController();
    const h = f.harness({ listed: async argv => {
      if (argv.includes('--scope-conflicts') && !delayed) { delayed = true; entered(); await gate; }
      return { jobs: [f.oldJob], next_offset: null };
    }, starting: outcome === 'failure' ? () => { throw new Error('start failed'); } : undefined });
    const writing = h.tools.codex_run.execute({ task: 'Update a.txt.', acceptance: ['a.txt is updated'], write: true },
      { ...f.caller, signal: controller.signal });
    const settled = writing.catch(error => error);
    await ready;
    const close = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
    assert.equal(close.worktrees[0].status, 'blocked', outcome);
    assert.equal(close.worktrees[0].reason, 'dispatching', outcome);
    assert.equal(existsSync(f.entry.path), true, outcome);
    if (outcome === 'abort') controller.abort();
    release();
    const result = await settled;
    if (outcome !== 'success') assert.ok(result instanceof Error, outcome);
    const after = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
    assert.equal(after.worktrees[0].status, 'closed', outcome);
  }
});

test('cleanup activity query releases repo lock and rechecks foreign dispatch activity after its snapshot', { timeout: 5000 }, async () => {
  for (const location of ['cwd', 'scope', 'previous']) {
    const f = await fixture();
    const previous = `${f.entry.path}-previous`;
    f.save({ ...f.entry, previous_paths: [previous] });
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const h = f.harness({ listed: async argv => {
      if (!argv.includes('--owner')) { entered(); await gate; }
      return { jobs: [f.oldJob], next_offset: null };
    }, activity: async argv => {
      entered(); await gate;
      return { status: 'completed', worktrees: [{ path: f.entry.path, running: [], last_activity_at: f.oldJob.finished_at }] };
    } });
    const cleanup = h.load();
    await ready;
    const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.repo }, log: [] } } };
    await h.tools.codex_run.execute({ task: location === 'previous' ? `Read ${previous}/a.txt.` : 'Read a.txt.',
      acceptance: ['a.txt read'], write: false,
      cwd: location === 'scope' ? path.dirname(f.repo) : location === 'previous' ? previous : f.entry.path,
      ...(location === 'scope' ? { scope: [path.relative(path.dirname(f.repo), f.entry.path)] } : {}) }, foreign);
    const start = h.starts[0];
    assert.equal(start.argv[start.argv.indexOf('--cwd') + 1], location === 'scope' ? path.dirname(f.repo) : f.entry.path);
    if (location === 'previous') {
      assert.equal(start.payload.context.task, `Read ${f.entry.path}/a.txt.`);
      assert.equal(start.payload.prompt.includes(previous), false);
    }
    release(); await cleanup;
    assert.equal(f.current().status, 'open', location);
    assert.equal(f.current().last_cleanup.reason, 'recent', location);
    assert.equal(existsSync(f.entry.path), true, location);
  }
});

test('cleanup and manual close include foreign in-flight readonly scope reservations', { timeout: 5000 }, async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const h = f.harness({ starting: async () => { entered(); await gate; throw new Error('start failed'); } });
  const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.repo }, log: [] } } };
  const writing = h.tools.codex_run.execute({ task: 'Read a.txt.', acceptance: ['a.txt read'], write: false,
    cwd: path.dirname(f.repo), scope: [path.relative(path.dirname(f.repo), f.entry.path)] }, foreign).catch(error => error);
  await ready;
  await h.load();
  assert.equal(f.current().status, 'open');
  assert.equal(f.current().last_cleanup.reason, 'dispatching');
  const close = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
  assert.equal(close.worktrees[0].reason, 'dispatching');
  release(); assert.match((await writing).message, /start failed/);
});

test('closed readonly dispatch, verification and continuation normalize cwd and original task across handover', { timeout: 5000 }, async () => {
  for (const via of ['read', 'verify', 'continue', 'inherited']) {
    const f = await fixture();
    await closeWorktree(f.entry); f.save({ ...f.entry, status: 'closed' });
    if (via === 'inherited') {
      writeFileSync(path.join(f.stateDir, 'handover.json'), JSON.stringify({ links: { 'session-successor-0000': { from: f.owner } } }));
      f.caller.agent.id = 'session-successor-0000';
    }
    const source = { ...f.oldJob, job_id: 'OLD', thread_id: 'old-thread', sandbox: 'read-only', log_dir: path.join(f.stateDir, 'jobs', 'OLD'),
      context: { owner: f.owner, write: false, task: `Read ${f.entry.path}/a.txt.`, acceptance: ['a.txt is updated'] },
      verification_status: 'unreviewed', task_options: {}, structured: { summary: 'read',
        criteria: [{ criterion: 'a.txt is updated', status: 'not_met', evidence: 'read again' }],
        files_changed: [], deviations: [], unresolved: [], blockers: [] } };
    const h = f.harness({ jobs: [source] });
    if (via === 'verify') await h.tools.codex_verify.execute({ job_id: 'OLD' }, f.caller);
    else if (via === 'continue') await h.tools.codex_continue.execute({ job_id: 'OLD', fresh: false }, f.caller);
    else await h.write({ write: false, cwd: f.entry.path, task: `Read ${f.entry.path}/a.txt.`, scope: ['a.txt'] });
    assert.equal(h.starts[0].argv[h.starts[0].argv.indexOf('--cwd') + 1], f.repo, via);
    const normalize = text => text.replace(/\\+/g, '/');
    assert.ok(normalize(h.starts[0].payload.context.task).includes(`${normalize(f.repo)}/a.txt`), via);
    assert.equal(normalize(h.starts[0].payload.context.task).includes(normalize(f.entry.path)), false, via);
    assert.equal(normalize(h.starts[0].payload.prompt).includes(normalize(f.entry.path)), false, via);
    assert.equal(f.current().status, 'closed', via);
  }
});

test('closed worktree lookup resolves relative scope before reopening and rewriting original task', { timeout: 5000 }, async () => {
  const f = await fixture();
  await closeWorktree(f.entry); f.save({ ...f.entry, status: 'closed' });
  const h = f.harness();
  await h.write({ cwd: path.dirname(f.repo), scope: [path.relative(path.dirname(f.repo), f.entry.path)], task: `Update ${f.entry.path}/a.txt.` });
  const start = h.starts[0];
  assert.equal(f.current().status, 'open');
  assert.equal(start.payload.context.routing.worktree_path, f.current().path);
  assert.ok(start.payload.context.task.includes(`${f.current().path}/a.txt`));
  assert.equal(start.argv[start.argv.indexOf('--scope') + 1], f.current().path);
});


test('automatic cleanup preserves unique ignored output and refuses conflicts in replaced shared directories', async () => {
  for (const conflict of [false, true]) {
    const f = await fixture();
    await closeWorktree(f.entry);
    mkdirSync(path.join(f.repo, 'outputs.bin'));
    writeFileSync(path.join(f.repo, 'outputs.bin', 'original'), 'keep original');
    Object.assign(f.entry, await openWorktree({ repo: f.repo, owner: f.owner }));
    f.save(f.entry);
    assert.ok(f.entry.links.includes('outputs.bin'));
    unlinkSync(path.join(f.entry.path, 'outputs.bin'));
    mkdirSync(path.join(f.entry.path, 'outputs.bin'));
    writeFileSync(path.join(f.entry.path, 'outputs.bin', 'only-here'), 'unique output');
    if (conflict) writeFileSync(path.join(f.entry.path, 'outputs.bin', 'original'), 'worktree original');
    await f.harness().load();
    assert.equal(readFileSync(path.join(f.repo, 'outputs.bin', 'original'), 'utf8'), 'keep original');
    if (conflict) {
      assert.equal(f.current().status, 'open');
      assert.equal(f.current().last_cleanup.reason, 'ignored_clash');
      assert.equal(readFileSync(path.join(f.entry.path, 'outputs.bin', 'original'), 'utf8'), 'worktree original');
      assert.equal(readFileSync(path.join(f.entry.path, 'outputs.bin', 'only-here'), 'utf8'), 'unique output');
    } else {
      assert.equal(f.current().status, 'closed');
      assert.equal(readFileSync(path.join(f.repo, 'outputs.bin', 'only-here'), 'utf8'), 'unique output');
    }
  }
});

test('manual close rechecks foreign activity after its asynchronous scan', { timeout: 5000 }, async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const h = f.harness({ activity: async () => {
    entered(); await gate;
    return { status: 'completed', worktrees: [{ path: f.entry.path, running: [], last_activity_at: f.oldJob.finished_at }] };
  } });
  const closing = h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
  await ready;
  await h.tools.codex_run.execute({ task: 'Read a.txt.', acceptance: ['a.txt read'], write: false, cwd: f.entry.path },
    { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.entry.path }, log: [] } } });
  release();
  assert.equal((await closing).worktrees[0].reason, 'recent');
  assert.equal(existsSync(f.entry.path), true);
});

test('manual close refuses failed or incomplete activity results', async () => {
  for (const value of [{ status: 'failed', error: 'invalid registration' }, { status: 'completed', worktrees: [] }]) {
    const f = await fixture();
    const h = f.harness({ activity: () => value });
    const receipt = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
    assert.equal(receipt.worktrees[0].status, 'error');
    assert.equal(f.current().status, 'open');
    assert.equal(existsSync(f.entry.path), true);
  }
});

test('worktreeActivity batches paths through the real runner CLI and includes pending registrations', async () => {
  const state = path.join(tmp, 'activity-cli');
  const root = path.join(state, 'tree');
  const job = path.join(state, 'jobs', 'PENDING');
  mkdirSync(job, { recursive: true });
  writeFileSync(path.join(job, 'args.json'), JSON.stringify({ cwd: root, sandbox: 'read-only' }));
  const runner = fileURLToPath(new URL('./runner/codex_runner.py', import.meta.url));
  const codexHome = path.join(state, 'codex-home');
  mkdirSync(codexHome);
  const conductor = createConductor({}, async (_cfg, argv) => JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', [runner, ...argv],
    { encoding: 'utf8', env: { ...process.env, CODEX_RUNNER_HOME: state, CODEX_HOME: codexHome } })));
  const result = await conductor.worktreeActivity([root, `${root}-unused`]);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.worktrees.map(item => item.path), [root, `${root}-unused`]);
  assert.deepEqual(result.worktrees[0].running, ['PENDING']);
  assert.ok(result.worktrees[0].last_activity_at > 0);
  assert.deepEqual(result.worktrees[1].running, []);
});

test('foreign owner explicit worktree writes keep and reserve the actual worktree', { timeout: 5000 }, async () => {
  const f = await fixture();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const h = f.harness({ starting: async start => {
    entered(); await gate;
    return { ...f.oldJob, job_id: 'FOREIGN', context: start.payload.context };
  } });
  const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.repo }, log: [] } } };
  const writing = h.tools.codex_run.execute({ task: `Update ${f.entry.path}/a.txt.`, acceptance: ['a.txt is updated'], write: true,
    cwd: f.entry.path }, foreign);
  const settled = writing.catch(error => error);
  await ready;
  try {
    assert.equal(h.starts[0].argv[h.starts[0].argv.indexOf('--cwd') + 1], f.entry.path);
    assert.equal(h.starts[0].payload.context.routing.worktree_path, f.entry.path);
    assert.equal(Object.keys(JSON.parse(readFileSync(f.file))).length, 1);
    const closed = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
    assert.equal(closed.worktrees[0].reason, 'dispatching');
    assert.equal(existsSync(f.entry.path), true);
  } finally { release(); await settled; }
});

test('foreign readonly dispatch queued behind close normalizes the freshly closed worktree', { timeout: 5000 }, async () => {
  const f = await fixture();
  let foreignDispatch;
  const dispatched = new Promise((resolve, reject) => { foreignDispatch = { resolve, reject }; });
  const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.repo }, log: [] } } };
  let h, scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(async () => {
      try {
        assert.equal(f.current().status, 'open', 'dispatch sees the entry before close finishes');
        foreignDispatch.resolve(await h.tools.codex_run.execute({ task: `Read ${f.entry.path}/a.txt.`, acceptance: ['a.txt read'],
          write: false, cwd: f.entry.path }, foreign));
      } catch (error) { foreignDispatch.reject(error); }
    });
  };
  h = f.harness({ activity: () => {
    schedule();
    return { status: 'completed', worktrees: [{ path: f.entry.path, running: [], last_activity_at: f.oldJob.finished_at }] };
  } });
  assert.equal((await h.tools.codex_worktree.execute({ action: 'close' }, f.caller)).worktrees[0].status, 'closed');
  await dispatched;
  assert.equal(h.starts[0].argv[h.starts[0].argv.indexOf('--cwd') + 1], f.repo);
  assert.ok(h.starts[0].payload.context.task.includes(`${f.repo}/a.txt`));
  assert.equal(h.starts[0].payload.context.task.includes(f.entry.path), false);
});

for (const field of ['cwd', 'scope', 'writable_roots', 'required_writes']) {
  for (const relation of field === 'cwd' || field === 'scope' ? ['ancestor'] : ['equal', 'inside', 'ancestor']) {
    test(`dispatch reservation covers ${field} ${relation} before registration`, { timeout: 10000 }, async () => {
      const f = await fixture();
      let entered, release;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const h = f.harness({ starting: async () => { entered(); await gate; throw new Error('start failed'); } });
      const location = relation === 'ancestor' ? path.dirname(f.entry.path)
        : relation === 'inside' ? path.join(f.entry.path, 'sub') : f.entry.path;
      if (relation === 'inside') mkdirSync(location);
      const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.repo }, log: [] } } };
      const dispatch = h.tools.codex_run.execute({ task: 'Update a.txt.', acceptance: ['a.txt is updated'], write: true,
        cwd: field === 'cwd' ? location : f.repo,
        ...(field === 'cwd' ? {} : { [field]: [path.relative(f.repo, location)] }) }, foreign).catch(error => error);
      await Promise.race([ready, dispatch.then(result => { throw result instanceof Error ? result : new Error('start not reached'); })]);
      try {
        await h.load();
        assert.equal(f.current().status, 'open');
        assert.equal(f.current().last_cleanup.reason, 'dispatching');
        const close = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
        assert.equal(close.worktrees[0].reason, 'dispatching');
        assert.equal(existsSync(f.entry.path), true);
      } finally { release(); await dispatch; }
      assert.equal((await h.tools.codex_worktree.execute({ action: 'close' }, f.caller)).worktrees[0].status, 'closed');
    });
  }
}

for (const field of ['cwd', 'scope', 'scope_paths', 'task_options.writable_roots', 'context.routing.worktree_path']) {
  for (const [relation, state] of [['equal', 'running'], ['inside', 'unreviewed'], ['ancestor', 'needs_changes']]) {
    test(`global merge gate blocks foreign ${state} via ${field} ${relation}`, async () => {
      const f = await fixture({ age: 0 });
      writeFileSync(path.join(f.entry.path, 'a.txt'), 'foreign edit\n');
      git(f.entry.path, 'commit', '-am', 'foreign edit');
      const head = git(f.repo, 'rev-parse', 'HEAD');
      const location = relation === 'ancestor' ? path.dirname(f.entry.path)
        : relation === 'inside' ? path.join(f.entry.path, 'sub') : f.entry.path;
      const foreign = { ...f.oldJob, job_id: 'B-WRITE', cwd: field === 'cwd' ? location : f.repo,
        status: state === 'running' ? 'running' : 'completed', verification_status: state === 'running' ? 'unreviewed' : state,
        context: { owner: 'session-foreign-0000', write: true,
          ...(field === 'context.routing.worktree_path' ? { routing: { worktree_path: location } } : {}) },
        ...(field === 'cwd' || field === 'context.routing.worktree_path' ? {} : field === 'task_options.writable_roots'
          ? { task_options: { writable_roots: [path.relative(f.repo, location)] } }
          : { [field]: [path.relative(f.repo, location)] }) };
      const h = f.harness({ jobs: [f.oldJob, foreign] });
      const receipt = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
      assert.match(receipt.worktrees[0].note, /B-WRITE/);
      assert.match(receipt.worktrees[0].note, state === 'needs_changes' ? /needs_changes.*codex_continue.*codex_review/s : /codex_/);
      assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
      assert.equal(f.current().status, 'open');
      assert.ok(h.calls.some(argv => argv[0] === 'list' && !argv.includes('--owner')));
      foreign.status = 'completed'; foreign.verification_status = 'verified';
      assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'merged');
    });
  }
}

test('global merge gate scans every page before merging foreign writes', async () => {
  const f = await fixture();
  const jobs = Array.from({ length: 100 }, (_, i) => ({ ...f.oldJob, job_id: `A-${i}` }));
  jobs.push({ ...f.oldJob, job_id: 'B-PAGE-2', verification_status: 'needs_changes', context: { owner: 'foreign', write: true } });
  const h = f.harness({ jobs });
  const receipt = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
  assert.match(receipt.worktrees[0].note, /B-PAGE-2/);
  assert.deepEqual(h.calls.filter(argv => argv[0] === 'list' && !argv.includes('--owner'))
    .map(argv => Number(argv[argv.indexOf('--offset') + 1])), [0, 100]);
});

for (const failure of ['throw', 'missing', 'failed', 'page-two', 'bad-offset', 'missing-next', 'bad-roots', 'bad-scope']) {
  test(`global merge gate keeps blocked on ${failure} query`, async () => {
    const f = await fixture();
    const h = f.harness({ listed: argv => {
      if (argv.includes('--owner')) return { jobs: [f.oldJob], next_offset: null };
      const offset = Number(argv[argv.indexOf('--offset') + 1]);
      if (failure === 'throw') throw new Error('offline');
      if (failure === 'missing') return undefined;
      if (failure === 'failed') return { status: 'failed', jobs: [], next_offset: null, error: 'offline' };
      if (failure === 'page-two') return offset === 0 ? { jobs: [f.oldJob], next_offset: 100 } : { error: 'page unavailable' };
      if (failure === 'bad-offset') return { jobs: [f.oldJob], next_offset: 0 };
      if (failure === 'missing-next') return { jobs: [f.oldJob] };
      return { jobs: [{ ...f.oldJob, ...(failure === 'bad-roots' ? { task_options: { writable_roots: 'invalid' } } : { scope: [7] }) }], next_offset: null };
    } });
    const receipt = await h.tools.codex_worktree.execute({ action: 'close' }, f.caller);
    if (failure === 'bad-roots' || failure === 'bad-scope') assert.match(receipt.worktrees[0].note, /old.*(scope|writable_roots).*codex_status.*codex_worktree/s);
    else assert.match(receipt.worktrees[0].note, /查不到.*派单记录.*暂不合并.*codex_worktree/s);
    assert.equal(f.current().status, 'open');
    assert.equal(existsSync(f.entry.path), true);
  });
}

test('ancestor overlap reserves sibling worktrees without claiming foreign routing', { timeout: 10000 }, async () => {
  const f = await fixture();
  const secondOwner = 'session-bbbbbbbb-0000';
  const second = { ...f.entry, ...await openWorktree({ repo: f.repo, owner: secondOwner }) };
  writeFileSync(f.file, JSON.stringify({ [f.key]: f.entry, [`${secondOwner}::${f.repo.replace(/\\/g, '/').toLowerCase()}`]: second }));
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = f.harness({ starting: async () => { entered(); await gate; throw new Error('start failed'); } });
  const cwd = path.dirname(f.repo);
  const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd }, log: [] } } };
  const dispatch = h.tools.codex_run.execute({ task: 'Update parent files.', acceptance: ['parent files updated'], write: true, cwd }, foreign).catch(error => error);
  await ready;
  try {
    assert.equal(h.starts[0].payload.context.routing?.worktree_path, undefined);
    assert.equal(h.starts[0].argv[h.starts[0].argv.indexOf('--cwd') + 1], cwd);
    await h.load();
    for (const entry of Object.values(JSON.parse(readFileSync(f.file)))) {
      assert.equal(entry.status, 'open');
      assert.equal(entry.last_cleanup.reason, 'dispatching');
    }
  } finally { release(); await dispatch; }
});

for (const status of ['failed', 'cancelled']) {
  test(`global merge gate blocks unreviewed foreign ${status} writes`, async () => {
    const f = await fixture();
    const foreign = { ...f.oldJob, job_id: 'B-PARTIAL', status, worktree_commit: 'a'.repeat(40),
      verification_status: 'unreviewed', context: { owner: 'foreign', write: true } };
    const h = f.harness({ jobs: [f.oldJob, foreign] });
    assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /B-PARTIAL.*codex_/);
    foreign.verification_status = 'accepted_deviations';
    assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
  });
}

for (const status of ['failed', 'cancelled']) {
  test(`merge gate ignores unchanged ${status} and refused writes`, async () => {
    const f = await fixture();
    const foreign = { ...f.oldJob, job_id: 'B-NO-CHANGES', status, error_kind: 'model_refused',
      files_changed_total: 0, verification_status: 'unreviewed', context: { owner: 'foreign', write: true } };
    const h = f.harness({ jobs: [f.oldJob, foreign] });
    assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
    writeFileSync(path.join(f.entry.path, 'a.txt'), 'uncommitted failure residue\n');
    foreign.files_changed_total = 1;
    assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].reason, 'worktree_dirty');
  });
}

test('merge gate ignores prior incarnation jobs before validating their paths', async () => {
  const f = await fixture({ age: 0 });
  const before = Date.parse(f.entry.created_at) / 1000 - 1;
  const h = f.harness({ jobs: [f.oldJob,
    { ...f.oldJob, job_id: 'OLD-BROKEN', started_at: before, cwd: null, scope: [7], context: { owner: 'foreign', write: true } },
    { ...f.oldJob, job_id: 'OLD-UNREVIEWED', started_at: before, verification_status: 'needs_changes' }] });
  assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
  const query = h.calls.find(argv => argv[0] === 'list' && !argv.includes('--owner'));
  assert.equal(Number(query[query.indexOf('--started-between') + 1]), Date.parse(f.entry.created_at) / 1000);
});

test('merge gate names current tasks with incomplete paths', async () => {
  for (const broken of [{ cwd: '' }, { scope: [7] }, { scope_paths: [''] }, { started_at: null },
    { task_options: { writable_roots: 'invalid' } }, { context: { owner: 'foreign', write: true, routing: { worktree_path: null } } }]) {
    const f = await fixture();
    const foreign = { ...f.oldJob, job_id: 'B-BAD-PATH', context: { owner: 'foreign', write: true }, ...broken };
    const h = f.harness({ jobs: [foreign] });
    const receipt = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
    assert.match(receipt.worktrees[0].note, /B-BAD-PATH.*(目录|scope|writable_roots|归属|登记时间)/s);
    assert.match(receipt.worktrees[0].note, /codex_status.*codex_worktree/s);
  }
});

test('merge gate names foreign readonly tasks with incomplete paths', async () => {
  const f = await fixture();
  const h = f.harness({ jobs: [{ ...f.oldJob, job_id: 'FOREIGN-READ', cwd: null, scope: [7],
    context: { owner: 'foreign', write: false } }] });
  assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /FOREIGN-READ.*目录/s);
});

for (const alias of ['dot', 'dotdot', 'junction', 'case-and-separators']) {
  test(`cleanup reservation recognizes equivalent cwd via ${alias}`, async () => {
    const f = await fixture();
    let location = alias === 'dot' ? `${path.dirname(f.entry.path)}/./${path.basename(f.entry.path)}`
      : alias === 'dotdot' ? `${f.entry.path}/../${path.basename(f.entry.path)}`
        : f.entry.path.replace(/\\/g, '/').toUpperCase();
    if (alias === 'junction') {
      location = path.join(path.dirname(f.entry.path), 'alias');
      symlinkSync(f.entry.path, location, 'junction');
    }
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const h = f.harness({ starting: async () => { entered(); await gate; throw new Error('start failed'); } });
    const dispatch = h.write({ cwd: location }).catch(error => error);
    await Promise.race([ready, dispatch.then(error => { throw error; })]);
    try {
      await h.load();
      assert.equal(f.current().status, 'open');
      assert.equal(f.current().last_cleanup.reason, 'dispatching');
    } finally { release(); await dispatch; }
  });
}

test('cleanup matches canonical activity paths before deciding a worktree is idle', async () => {
  const f = await fixture();
  const h = f.harness({ activity: () => ({ status: 'completed', worktrees: [{
    path: `${path.dirname(f.entry.path)}/./${path.basename(f.entry.path)}`, running: [],
    last_activity_at: f.oldJob.finished_at }] }) });
  await h.load();
  assert.equal(f.current().status, 'closed');
});

test('dispatch reuses a worktree whose persisted repository key uses a junction alias', async () => {
  const f = await fixture();
  const alias = path.join(path.dirname(f.repo), 'repo-alias');
  symlinkSync(f.repo, alias, 'junction');
  const oldKey = `${f.owner}::${alias.replace(/\\/g, '/').toLowerCase()}`;
  writeFileSync(f.file, JSON.stringify({ [oldKey]: { ...f.entry, repo: alias } }));
  const h = f.harness();
  await h.write({ cwd: alias });
  assert.equal(h.starts[0].argv[h.starts[0].argv.indexOf('--cwd') + 1], f.entry.path);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f.file))), [oldKey]);
});

test('automatic cleanup preserves unmerged detached HEAD commits', async () => {
  const f = await fixture();
  git(f.entry.path, 'checkout', '-q', '--detach');
  writeFileSync(path.join(f.entry.path, 'a.txt'), 'detached change\n');
  git(f.entry.path, 'commit', '-am', 'detached change');
  await f.harness().load();
  assert.equal(f.current().status, 'open');
  assert.equal(f.current().last_cleanup.reason, 'not_merged');
});

test('merge gate names invalid records and missing critical fields before owner filtering', async () => {
  for (const broken of [{ error_kind: 'invalid_record', context: null, error: 'broken args.json' },
    { context: null, cwd: null }, { context: { owner: 'foreign' } }, { status: null }, { job_id: '' }]) {
    const f = await fixture();
    const bad = { ...f.oldJob, job_id: 'CORRUPT', ...broken };
    const h = f.harness({ jobs: [bad] });
    assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note,
      /(?:CORRUPT|缺少任务号).*(invalid_record|context|目录|status|任务号).*codex_status/s);
    bad.started_at = Date.parse(f.entry.created_at) / 1000 - 1;
    assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
  }
  const f = await fixture();
  const unrelated = { ...f.oldJob, job_id: 'UNRELATED', error_kind: 'invalid_record', cwd: f.repo,
    scope: [], scope_paths: [], task_options: { writable_roots: [] } };
  const h = f.harness({ jobs: [unrelated] });
  assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
});

test('merge gate uses creation time rather than a later entry update', async () => {
  const f = await fixture();
  f.save({ ...f.entry, at: new Date().toISOString() });
  const h = f.harness({ jobs: [{ ...f.oldJob, verification_status: 'needs_changes' }] });
  assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /needs_changes/);
  const query = h.calls.find(argv => argv[0] === 'list' && !argv.includes('--owner'));
  assert.equal(Number(query[query.indexOf('--started-between') + 1]), Date.parse(f.entry.created_at) / 1000);
});

test('merge gate derives legacy creation time from the Git marker', async () => {
  const f = await fixture();
  const { created_at, ...legacy } = f.entry;
  f.save({ ...legacy, at: new Date(Date.now() + 60_000).toISOString() });
  const h = f.harness({ jobs: [{ ...f.oldJob, job_id: 'CURRENT', started_at: Date.now() / 1000,
    verification_status: 'needs_changes' }] });
  assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /CURRENT/);
  const query = h.calls.find(argv => argv[0] === 'list' && !argv.includes('--owner'));
  assert.ok(query.includes('--started-between'));
  assert.ok(Number(query[query.indexOf('--started-between') + 1]) > Date.parse(created_at) / 1000);
});

test('merge gate blocks unfinished foreign writes even when previously verified', async () => {
  const f = await fixture();
  const foreign = { ...f.oldJob, job_id: 'B-UNFINISHED', context: { owner: 'foreign', write: true } };
  const h = f.harness({ jobs: [f.oldJob, foreign] });
  for (const status of ['unknown', 'pending', 'running', 'execution-running']) {
    foreign.status = status === 'execution-running' ? 'completed' : status;
    foreign.execution_status = status === 'execution-running' ? 'running' : undefined;
    assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /B-UNFINISHED.*codex_status/);
  }
});

test('global merge gate preserves owner readonly and verification contract', async () => {
  const f = await fixture();
  const readonly = { ...f.oldJob, job_id: 'READ', status: 'running', context: { owner: 'foreign', write: false } };
  const h = f.harness({ jobs: [f.oldJob, readonly] });
  assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
  readonly.context.owner = f.owner;
  assert.match((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].note, /还有单在跑（READ）/);
  readonly.context.verification_of = 'old';
  assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'nothing');
});

test('merge waits for a foreign dispatch reservation before runner registration', { timeout: 10000 }, async () => {
  const f = await fixture();
  writeFileSync(path.join(f.entry.path, 'a.txt'), 'partial foreign edit\n');
  git(f.entry.path, 'commit', '-am', 'partial foreign edit');
  const head = git(f.repo, 'rev-parse', 'HEAD');
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = f.harness({ starting: async () => { entered(); await gate; throw new Error('start failed'); } });
  const foreign = { agent: { id: 'session-foreign-0000', session: { header: { cwd: f.entry.path }, log: [] } } };
  const dispatch = h.tools.codex_run.execute({ task: 'Finish partial edit.', acceptance: ['partial edit finished'], write: true }, foreign).catch(error => error);
  await ready;
  try {
    const receipt = await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller);
    assert.equal(receipt.worktrees[0].status, 'blocked');
    assert.equal(receipt.worktrees[0].reason, 'dispatching');
    assert.match(receipt.worktrees[0].note, /派单.*登记.*codex_worktree/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head);
  } finally { release(); await dispatch; }
  assert.equal((await h.tools.codex_worktree.execute({ action: 'merge' }, f.caller)).worktrees[0].status, 'merged');
});
