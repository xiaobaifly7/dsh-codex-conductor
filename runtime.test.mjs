import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimeIdentity, runtimeStatus, requestRuntimeReload, waitForRuntimeLoad, registerRuntimeTool } from './runtime.mjs';

const runtimeUrl = new URL('./runtime.mjs', import.meta.url).href;
const oldId = 'codex-conductor-runtime-5e86941';
const windowsModule = 'file:///C:/Users/Example%20User/dsh-codex-conductor/index.mjs?v=literal-parameters-5e86941';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-runtime-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'package');
  mkdirSync(directory);
  const pkg = path.join(directory, 'package.json');
  const entry = path.join(directory, 'index.mjs');
  writeFileSync(pkg, JSON.stringify({ type: 'module', version: '1.2.3' }));
  writeFileSync(entry, `import { runtimeIdentity } from ${JSON.stringify(runtimeUrl)};\nexport const loadedIdentity = runtimeIdentity(import.meta.url);\n`);
  return { root, directory, pkg, entry, moduleUrl: pathToFileURL(entry).href + '?v=old',
    profileFile: path.join(root, 'profile.yml'), loadedFile: path.join(root, 'loaded.json') };
}

function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function repository(f) {
  git(f.directory, ['init', '--quiet', '--template=']);
  git(f.directory, ['-c', 'core.autocrlf=false', 'add', '--', 'package.json', 'index.mjs']);
  const tree = git(f.directory, ['write-tree']);
  // Build a fixture object directly: tests never invoke git commit or touch the shared repository's git state.
  const content = Buffer.from(`tree ${tree}\nauthor Runtime Test <test@example.invalid> 1 +0000\ncommitter Runtime Test <test@example.invalid> 1 +0000\n\nfixture\n`);
  const object = Buffer.concat([Buffer.from(`commit ${content.length}\0`), content]);
  const revision = createHash('sha1').update(object).digest('hex');
  const objectDirectory = path.join(f.directory, '.git', 'objects', revision.slice(0, 2));
  mkdirSync(objectDirectory, { recursive: true });
  writeFileSync(path.join(objectDirectory, revision.slice(2)), deflateSync(object));
  mkdirSync(path.join(f.directory, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(path.join(f.directory, '.git', 'HEAD'), 'ref: refs/heads/runtime-test\n');
  writeFileSync(path.join(f.directory, '.git', 'refs', 'heads', 'runtime-test'), revision + '\n');
  return revision;
}

function profile(module, { quote = '', newline = '\n', indent = '  ' } = {}) {
  return ['# unrelated 中文', 'model: unchanged', 'plugins:', `${indent}- id: other-plugin`,
    `${indent}  name: other-package`, `${indent}  config: {keep: true}`, `${indent}- id: ${quote}${oldId}${quote} # own id`,
    `${indent}  name: ${quote}${module}${quote} # own URL`, `${indent}  config:`, `${indent}    allowHostAccess: true`,
    `${indent}    nested: [one, two]`, `${indent}- id: last-plugin`, `${indent}  name: last-package`,
    'settings:', '  token: fixture-only', ''].join(newline);
}

function marker(f, identity = runtimeIdentity(f.moduleUrl)) {
  const record = { ...identity, loadedAt: '2026-01-01T01:02:03.000Z', pid: 12345,
    workspaces: ['*'], allowHostAccess: true, defaultHostAccess: true,
    plannerPromptFile: 'fixture-only.md', plannerPromptInjected: true };
  writeFileSync(f.loadedFile, JSON.stringify(record));
  return record;
}

function status(f, extra = {}) {
  return runtimeStatus({ ...f, activeTasks: 3, ...extra });
}

test('identity reads only fixture package/git; non-git and unavailable values are explicitly null', (t) => {
  const f = fixture(t);
  assert.deepEqual(runtimeIdentity(f.moduleUrl), { module: f.moduleUrl, version: '1.2.3', revision: null, dirty: null });
  writeFileSync(f.pkg, '{broken');
  assert.equal(runtimeIdentity(f.moduleUrl).version, null);
  assert.throws(() => runtimeIdentity('https://example.invalid/index.mjs'), /file URL/);
});

test('loaded identity is captured by the importing entry at module evaluation; source reads remain fresh', async (t) => {
  const f = fixture(t);
  const revision = repository(f);
  const { loadedIdentity } = await import(f.moduleUrl);
  assert.deepEqual(loadedIdentity, { module: f.moduleUrl, version: '1.2.3', revision, dirty: false });
  writeFileSync(f.pkg, JSON.stringify({ type: 'module', version: '1.2.4' }));
  assert.equal(loadedIdentity.version, '1.2.3');
  assert.equal(loadedIdentity.dirty, false);
  assert.deepEqual(runtimeIdentity(f.moduleUrl), { module: f.moduleUrl, version: '1.2.4', revision, dirty: true });
});

test('status uses actual marker with full host flags and distinguishes disk from instance', (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const loadedIdentity = runtimeIdentity(f.moduleUrl);
  const loaded = marker(f, loadedIdentity);
  const clean = status(f, { loadedIdentity });
  assert.deepEqual(Object.keys(clean), ['source', 'instance', 'loaded', 'loaded_error', 'profile_module',
    'profile_error', 'active_tasks', 'state', 'can_reload']);
  assert.equal(clean.state, 'synchronized');
  assert.deepEqual(clean.loaded, loaded);
  assert.deepEqual(clean.instance, loadedIdentity);
  assert.equal(clean.active_tasks, 3);
  assert.equal(clean.can_reload, true); // main owns idle/now policy
  const idle = status(f, { loadedIdentity, activeTasks: 0 });
  assert.equal(idle.active_tasks, 0);
  assert.equal(idle.can_reload, clean.can_reload);
  assert.equal(idle.state, clean.state);
  assert.deepEqual(Object.keys(idle), Object.keys(clean));
  assert.equal(clean.loaded_error, null);
  assert.equal(clean.profile_error, null);
  writeFileSync(f.pkg, JSON.stringify({ version: '1.2.4' }));
  const changed = status(f, { loadedIdentity });
  assert.equal(changed.state, 'pending');
  assert.equal(changed.source.version, '1.2.4');
  assert.equal(changed.loaded.version, '1.2.3');
  assert.equal(changed.instance.version, '1.2.3');
});

test('dirty, unknown and differing identities never claim clean synchronization', (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const identity = runtimeIdentity(f.moduleUrl);
  marker(f, { ...identity, dirty: true });
  assert.equal(status(f).state, 'pending');
  marker(f, { ...identity, dirty: null });
  assert.equal(status(f).state, 'unknown');
  marker(f, { ...identity, revision: null });
  assert.equal(status(f).state, 'unknown');
  marker(f, { ...identity, revision: 'f'.repeat(40) });
  assert.equal(status(f).state, 'pending');
  marker(f, { module: f.moduleUrl });
  assert.equal(status(f).state, 'unknown');
  writeFileSync(path.join(f.directory, 'untracked.txt'), 'fixture');
  marker(f, identity);
  assert.equal(status(f).state, 'pending');
});

test('non-git status is unknown even when version and module match', (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  marker(f);
  assert.equal(status(f).state, 'unknown');
});

test('unavailable or malformed marker stays explicit despite a supplied matching snapshot', (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const loadedIdentity = runtimeIdentity(f.moduleUrl);
  for (const contents of [null, '{partial', '{}']) {
    if (contents !== null) writeFileSync(f.loadedFile, contents);
    const result = status(f, { loadedIdentity });
    assert.equal(result.state, 'unknown');
    assert.equal(result.loaded, null);
    assert.equal(typeof result.loaded_error, 'string');
    assert.deepEqual(result.instance, loadedIdentity);
  }
});

test('a new actual marker supersedes the old instance and pending profile URL is visible', (t) => {
  const f = fixture(t);
  repository(f);
  const stale = { ...runtimeIdentity(f.moduleUrl), version: '0.0.1' };
  const nextModule = f.moduleUrl.replace('?v=old', '?v=new');
  writeFileSync(f.profileFile, profile(nextModule));
  marker(f);
  assert.equal(status(f, { loadedIdentity: stale }).state, 'pending');
  const actual = marker(f, { ...runtimeIdentity(f.moduleUrl), module: nextModule });
  const result = status(f, { loadedIdentity: stale });
  assert.equal(result.state, 'synchronized');
  assert.deepEqual(result.loaded, actual);
  assert.equal(result.instance.version, '0.0.1');
});

function encode(text, encoding, bom) {
  const bytes = Buffer.from(text, encoding === 'utf16be' ? 'utf16le' : encoding);
  if (encoding === 'utf16be') bytes.swap16();
  return Buffer.concat([bom, bytes]);
}

test('reload changes only own id/name bytes, preserving quotes, Windows URLs, encoding and newlines', (t) => {
  const f = fixture(t);
  const formats = [ ['utf8', Buffer.alloc(0)], ['utf8', Buffer.from([0xef, 0xbb, 0xbf])],
    ['utf16le', Buffer.from([0xff, 0xfe])], ['utf16be', Buffer.from([0xfe, 0xff])] ];
  for (const [encoding, bom] of formats) {
    for (const [quote, newline, indent] of [['', '\n', '  '], ["'", '\r\n', '  '], ['"', '\r', '']]) {
      const original = profile(windowsModule, { quote, newline, indent });
      writeFileSync(f.profileFile, encode(original, encoding, bom));
      const result = requestRuntimeReload({ moduleUrl: windowsModule.replace('/C:/Users/', '/c:/users/').replace(/\?.*$/, '?v=ignored'),
        profileFile: f.profileFile });
      assert.deepEqual(Object.keys(result), ['expected_module', 'requested_revision', 'requested_at']);
      const token = new URL(result.expected_module).searchParams.get('v');
      assert.match(token, /^[0-9a-f-]{36}$/);
      assert.equal(result.requested_revision, null);
      assert.ok(Number.isFinite(Date.parse(result.requested_at)));
      const expected = original.replace(oldId, `codex-conductor-runtime-${token}`).replace(windowsModule, result.expected_module);
      assert.deepEqual(readFileSync(f.profileFile), encode(expected, encoding, bom));
      assert.deepEqual(readdirSync(f.root).sort(), ['package', 'profile.yml']);
    }
  }
});

test('reload returns fixture HEAD, preserves URL options, and every request has a fresh URL and ID', (t) => {
  const f = fixture(t);
  const revision = repository(f);
  const module = f.moduleUrl + '&option=kept#fragment';
  writeFileSync(f.profileFile, profile(module));
  const first = requestRuntimeReload(f);
  const second = requestRuntimeReload(f);
  assert.equal(first.requested_revision, revision);
  assert.notEqual(first.expected_module, second.expected_module);
  assert.equal(new URL(second.expected_module).searchParams.get('option'), 'kept');
  assert.equal(new URL(second.expected_module).hash, '#fragment');
  assert.equal(status(f).profile_module, second.expected_module);
});

test('status shows one relocated managed target without allowing the old instance to reload it', (t) => {
  const f = fixture(t);
  marker(f);
  const next = new URL('../next/index.mjs?v=next', f.moduleUrl).href;
  const managedId = 'codex-conductor-runtime-12345678-1234-4234-8234-123456789abc';
  const text = profile(next).replace(oldId, managedId);
  writeFileSync(f.profileFile, text);
  const relocated = status(f);
  assert.equal(relocated.profile_module, next);
  assert.equal(relocated.source.module, f.moduleUrl);
  assert.equal(relocated.state, 'pending');
  assert.equal(relocated.can_reload, false);
  assert.match(relocated.profile_error, /刷新插件/);
  assert.throws(() => requestRuntimeReload(f), /Expected one runtime entry; found 0/);
  assert.equal(readFileSync(f.profileFile, 'utf8'), text);

  const duplicate = 'codex-conductor-runtime-abcdefab-1234-4234-8234-123456789abc';
  const other = f.moduleUrl.replace('/package/', '/other/');
  for (const second of [
    '  - id: ' + duplicate + '\n    name: ' + other + '\n',
    '  - name: ' + other + '\n    id: ' + duplicate + '\n',
    '  -\n    id: ' + duplicate + '\n    name: ' + other + '\n',
    '  - {id: ' + duplicate + ', name: ' + other + '}\n',
  ]) {
    writeFileSync(f.profileFile, text.replace('settings:', second + 'settings:'));
    assert.equal(status(f).profile_module, null);
  }
  writeFileSync(f.profileFile, text.replace('id: other-plugin', 'id: other-plugin # prior ID ' + duplicate));
  assert.equal(status(f).profile_module, next);
  writeFileSync(f.profileFile, profile(next));
  assert.equal(status(f).profile_module, null);
});

test('missing, duplicate and unknown own entries are rejected without any file changes', (t) => {
  const f = fixture(t);
  const invalid = [
    'plugins:\n  - id: other\n    name: other-package\n',
    profile(windowsModule).replace('settings:', `  - id: duplicate\n    name: '${windowsModule.replace('/C:/Users/', '/c:/users/')}'\nsettings:`),
    profile(windowsModule).replace('    name: file:', '    name: &alias file:'),
    profile(windowsModule).replace('    name: file:', '    name: >\n      file:'),
    profile(windowsModule).replace(`  - id: ${oldId} # own id\n    name: ${windowsModule} # own URL`,
      `  - {id: ${oldId}, name: '${windowsModule}'}`),
    profile(windowsModule).replace('    name: file:', '    id: duplicate\n    name: file:'),
    profile(windowsModule) + 'plugins:\n',
    profile(windowsModule).replace('settings:', '  -\n    id: hidden-duplicate\n    name: ' + windowsModule + '\nsettings:'),
    profile(windowsModule).replace('settings:', `  - {id: hidden-duplicate, name: '${windowsModule}'}\nsettings:`),
    profile(windowsModule).replace('settings:', `  - name: '${windowsModule}'\n    id: wrong-order\nsettings:`),
  ];
  for (const text of invalid) {
    const bytes = Buffer.from(text);
    writeFileSync(f.profileFile, bytes);
    assert.throws(() => requestRuntimeReload({ moduleUrl: windowsModule, profileFile: f.profileFile }));
    assert.deepEqual(readFileSync(f.profileFile), bytes);
    const result = runtimeStatus({ moduleUrl: windowsModule, profileFile: f.profileFile, loadedFile: f.loadedFile });
    assert.equal(result.can_reload, false);
    assert.equal(result.profile_module, null);
    assert.equal(typeof result.profile_error, 'string');
  }
  assert.throws(() => requestRuntimeReload({ moduleUrl: windowsModule }), /profileFile/);
  writeFileSync(f.profileFile, Buffer.from([0xff, 0xff, 0xff]));
  assert.throws(() => requestRuntimeReload({ moduleUrl: windowsModule, profileFile: f.profileFile }));
  assert.deepEqual(readFileSync(f.profileFile), Buffer.from([0xff, 0xff, 0xff]));
});

test('wait confirms only the exact new module and returns the actual published record', async (t) => {
  const f = fixture(t);
  const expectedModule = f.moduleUrl.replace('?v=old', '?v=new');
  marker(f);
  const actual = { module: expectedModule, version: '1.2.4', revision: null, dirty: true,
    loadedAt: new Date().toISOString(), pid: 4321, defaultHostAccess: true, workspaces: ['*'] };
  const publication = (async () => {
    await delay(20);
    writeFileSync(f.loadedFile, '{partial');
    await delay(60);
    writeFileSync(f.loadedFile, JSON.stringify(actual));
  })();
  const result = await waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule, timeoutMs: 1500 });
  await publication;
  assert.deepEqual(result, { confirmed: true, timed_out: false, expected_module: expectedModule, loaded: actual, error: null });
  assert.equal(readFileSync(f.loadedFile, 'utf8'), JSON.stringify(actual));
});

test('wait timeout is bounded and explicitly unconfirmed without rewriting or restarting anything', async (t) => {
  const f = fixture(t);
  const missing = await waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule: f.moduleUrl, timeoutMs: 0 });
  assert.equal(missing.confirmed, false);
  assert.equal(missing.timed_out, true);
  assert.equal(missing.loaded, null);
  assert.equal(typeof missing.error, 'string');
  const loaded = marker(f);
  const bytes = readFileSync(f.loadedFile);
  const started = performance.now();
  const expectedModule = f.moduleUrl + '&new=1';
  const result = await waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule, timeoutMs: 35 });
  assert.ok(performance.now() - started < 1500);
  assert.deepEqual(result, { confirmed: false, timed_out: true, expected_module: expectedModule, loaded, error: null });
  assert.deepEqual(readFileSync(f.loadedFile), bytes);
  assert.deepEqual(readdirSync(f.root).sort(), ['loaded.json', 'package']);
  await assert.rejects(waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule, timeoutMs: Infinity }), RangeError);
});


test('Cordis patch insert groups match our entry while unrelated overrides and multiline names remain byte-identical', (t) => {
  const f = fixture(t);
  const text = [
    '- id: read-tool', '  config:', '    readLimit: 100',
    '- id: disabled-override', '  disabled: true',
    '- id: provider-override', '  config:', '    models:', '      - id: unrelated-model',
    '        name: ' + windowsModule,
    '- insert:', '    - id: unrelated-plugin', '      name: "file:///C:/fixture/long',
    '        -plugin.mjs"', '      config: {keep: true}',
    '- insert:', '    # managed group comment', '    - id: ' + oldId,
    '      name: ' + windowsModule, '      config:', '        workspaces: ["*"]',
    '        allowHostAccess: true', '- id: inject-override', '  inject: [tools]',
    '- insert:', '    - id: following-plugin', '      name: unrelated-package', '',
  ].join('\r\n');
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(f.profileFile, Buffer.concat([bom, Buffer.from(text)]));
  const options = { moduleUrl: windowsModule, profileFile: f.profileFile, loadedFile: f.loadedFile, activeTasks: 0 };
  const initial = runtimeStatus(options);
  assert.equal(initial.profile_error, null);
  assert.equal(initial.profile_module, windowsModule);
  assert.equal(initial.can_reload, true);
  const result = requestRuntimeReload(options);
  const token = new URL(result.expected_module).searchParams.get('v');
  // Only replace the own entry; a nested model's identical URL is unrelated configuration.
  const expected = text.replace(oldId, 'codex-conductor-runtime-' + token)
    .replace('\r\n      name: ' + windowsModule, '\r\n      name: ' + result.expected_module);
  assert.deepEqual(readFileSync(f.profileFile), Buffer.concat([bom, Buffer.from(expected)]));
  assert.equal(runtimeStatus(options).profile_module, result.expected_module);
});

test('Cordis patch matching stays unique across insert groups and rejects unsupported own entries', (t) => {
  const f = fixture(t);
  const own = '- insert:\n    - id: ' + oldId + '\n      name: ' + windowsModule + '\n';
  const invalid = [
    own + own,
    '- id: root-duplicate\n  name: ' + windowsModule + '\n' + own,
    own + '- insert:\n    - {id: hidden-duplicate, name: "' + windowsModule + '"}\n',
    '- insert:\n    - id: own\n      name: >\n        ' + windowsModule + '\n',
  ];
  for (const text of invalid) {
    writeFileSync(f.profileFile, text);
    assert.throws(() => requestRuntimeReload({ moduleUrl: windowsModule, profileFile: f.profileFile }));
    assert.equal(readFileSync(f.profileFile, 'utf8'), text);
  }
});

function nativeJobs() {
  const started = [];
  return {
    started,
    list(owner) { return started.filter((job) => job.owner === undefined || job.owner === owner); },
    start(spec) {
      const progress = [];
      const job = { id: 'runtime-bg-' + (started.length + 1), owner: spec.owner, kind: spec.kind,
        label: spec.label, status: 'running', progress,
        ...spec.run({ updateProgress: (text) => progress.push(text) }) };
      started.push(job);
      job.done.then((outcome) => { job.status = outcome.status; job.result = outcome.result; });
      return job.id;
    },
  };
}

function runtimeTool(f, { jobs, conductor = { list: async () => ({ jobs: [], total: 0 }) },
  activeDispatches = () => 0, dispatchGeneration = () => 0, profileFile = f.profileFile, loadedIdentity = null } = {}) {
  let tool;
  const ctx = { tools: { register(spec) { tool = spec; return spec; } },
    get(name) { assert.equal(name, 'jobs'); return jobs; } };
  const registered = registerRuntimeTool({ ctx, conductor, moduleUrl: f.moduleUrl, loadedIdentity,
    profileFile, loadedFile: f.loadedFile, activeDispatches, dispatchGeneration });
  assert.equal(registered, tool);
  return tool;
}

async function requestedModule(f) {
  const deadline = performance.now() + 8000;
  while (performance.now() < deadline) {
    const match = /^\s+name: (file:[^\s]+)/m.exec(readFileSync(f.profileFile, 'utf8'));
    if (match && match[1] !== f.moduleUrl) return match[1];
    await delay(10);
  }
  throw new Error('Fixture reload request did not arrive');
}

function forbidCodexMutations(list) {
  return { list, cancel() { assert.fail('Runtime tool must never cancel Codex'); },
    start() { assert.fail('Runtime tool must never start Codex'); } };
}

const runtimeExec = { agent: { id: 'runtime-owner' } };

test('runtime tool defaults to status and counts all runner pages by unique ID plus pending starts', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const bytes = readFileSync(f.profileFile);
  const calls = [];
  const controller = new AbortController();
  const conductor = forbidCodexMutations(async (filters, signal) => {
    calls.push(filters);
    assert.equal(signal, controller.signal);
    return { status: 'completed', total: 102, offset: filters.offset, jobs: filters.offset === 0
      ? Array.from({ length: 100 }, (_, i) => ({ job_id: 'J' + i })) : [{ job_id: 'J99' }, { job_id: 'J100' }] };
  });
  const tool = runtimeTool(f, { conductor, activeDispatches: () => 2 });
  assert.equal(tool.name, 'codex_runtime');
  assert.equal(tool.parameters.properties.action.default, 'status');
  assert.equal(tool.parameters.properties.when.default, 'idle');
  const result = await tool.execute(undefined, { ...runtimeExec, signal: controller.signal });
  assert.equal(result.status, 'status');
  assert.equal(result.active_tasks, 103);
  assert.equal(result.profile_module, f.moduleUrl);
  assert.equal(result.loaded, null);
  assert.deepEqual(calls, [{ status: 'running', limit: 100, offset: 0 }, { status: 'running', limit: 100, offset: 100 }]);
  assert.deepEqual(JSON.parse(tool.output.render({}, result)[0].text), result);
  assert.deepEqual(readFileSync(f.profileFile), bytes);
});

test('bridge or pagination failures remain unknown and never trigger a reload', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const bytes = readFileSync(f.profileFile);
  const pages = [undefined, { status: 'failed', jobs: [], total: 0 },
    { error_kind: 'bridge_error', error: 'offline', jobs: [], total: 0 }, { jobs: [], total: 1 },
    { jobs: [{ job_id: 'J1' }] }, { jobs: [{}], total: 1 }, { jobs: [], total: 0, offset: 100 }];
  for (const page of pages) {
    const jobs = nativeJobs();
    const tool = runtimeTool(f, { jobs, conductor: { list: async () => page } });
    const result = await tool.execute({ action: 'reload' }, runtimeExec);
    assert.equal(result.status, 'failed');
    assert.equal(result.active_tasks, null);
    assert.equal(jobs.started.length, 0);
    assert.deepEqual(readFileSync(f.profileFile), bytes);
  }
  for (const list of [async () => { throw new Error('bridge offline'); },
    async ({ offset }) => ({ jobs: [{ job_id: 'J1' }], total: offset === 0 ? 2 : 3 })]) {
    const result = await runtimeTool(f, { conductor: { list } }).execute({}, runtimeExec);
    assert.equal(result.status, 'status');
    assert.equal(result.active_tasks, null);
    assert.equal(result.source.version, '1.2.3');
    assert.equal(typeof result.active_error, 'string');
  }
});

test('a pending start obtaining its ID during listing cannot be mistaken for idle', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  let pending = 1;
  const tool = runtimeTool(f, { activeDispatches: () => pending, conductor: { list: async () => {
    pending = 0;
    return { jobs: [], total: 0 };
  } } });
  const result = await tool.execute({ action: 'reload' }, runtimeExec);
  assert.equal(result.active_tasks, 1);
  assert.equal(result.error_kind, 'native_jobs_unavailable');
  assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
});

test('a start completing during listing or before the idle decision forces a fresh runner count', async (t) => {
  for (const timing of ['listing', 'handoff']) {
    const f = fixture(t);
    writeFileSync(f.profileFile, profile(f.moduleUrl));
    let pending = 0;
    let generation = 0;
    let lists = 0;
    const start = () => { pending++; generation++; pending--; };
    const tool = runtimeTool(f, { activeDispatches: () => pending, dispatchGeneration: () => generation,
      conductor: forbidCodexMutations(async () => {
        if (++lists === 1) {
          if (timing === 'listing') start();
          else queueMicrotask(() => queueMicrotask(start));
          return { jobs: [], total: 0 };
        }
        return { jobs: [{ job_id: 'J1' }], total: 1 };
      }) });
    const result = await tool.execute({ action: 'reload' }, runtimeExec);
    assert.equal(result.active_tasks, 1, timing);
    assert.equal(result.error_kind, 'native_jobs_unavailable', timing);
    assert.equal(lists, 2, timing);
    assert.equal(pending, 0);
    assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
  }
});

test('synchronized global marker is already_current even with a stale instance and busy runners', async (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const actual = marker(f);
  const jobs = nativeJobs();
  const tool = runtimeTool(f, { jobs, loadedIdentity: { ...actual, version: 'old-instance' },
    conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 })) });
  const bytes = readFileSync(f.profileFile);
  for (const when of ['idle', 'now']) {
    const result = await tool.execute({ action: 'reload', when }, runtimeExec);
    assert.equal(result.status, 'already_current');
    assert.equal(result.loaded.version, '1.2.3');
    assert.equal(result.active_tasks, 1);
    assert.deepEqual(readFileSync(f.profileFile), bytes);
  }
  assert.equal(jobs.started.length, 0);
});

test('reload without configured profile is explicitly refused and invalid arguments fail', async (t) => {
  const f = fixture(t);
  const tool = runtimeTool(f, { profileFile: '', conductor: { list() { assert.fail('No listing needed without profile'); } } });
  const result = await tool.execute({ action: 'reload' }, runtimeExec);
  assert.equal(result.status, 'failed');
  assert.equal(result.error_kind, 'profile_not_configured');
  assert.equal(result.active_tasks, null);
  for (const args of [null, [], { action: 'restart' }, { when: 'later' }]) await assert.rejects(tool.execute(args, runtimeExec));
});

test('busy idle reload without native jobs, owner, or successful registration never pretends to wait', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const conductor = forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 }));
  for (const [jobs, exec] of [[undefined, runtimeExec], [nativeJobs(), {}],
    [{ list: () => [], start() { throw new Error('native service offline'); } }, runtimeExec]]) {
    const result = await runtimeTool(f, { conductor, jobs }).execute({ action: 'reload' }, exec);
    assert.equal(result.status, 'failed');
    assert.equal(result.active_tasks, 1);
    assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
  }
});

test('idle reload reuses native running/stopping observers across registrations and reloads only after actual idle', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  let pending = 1;
  const options = { jobs, activeDispatches: () => pending,
    conductor: forbidCodexMutations(async () => ({ jobs: [], total: 0 })) };
  const tool = runtimeTool(f, options);
  const first = await tool.execute({ action: 'reload' }, runtimeExec);
  assert.equal(first.status, 'waiting_for_idle');
  assert.equal(first.reused, false);
  const observer = jobs.started[0];
  t.after(() => observer.cancel());
  assert.equal(observer.owner, runtimeExec.agent.id);
  assert.equal(observer.kind, 'codex-runtime');
  assert.ok(observer.progress.length > 0);
  const otherInstance = runtimeTool(f, options);
  for (const state of ['running', 'stopping']) {
    observer.status = state;
    const reused = await otherInstance.execute({ action: 'reload' }, runtimeExec);
    assert.equal(reused.reused, true);
    assert.equal(reused.background_job_id, first.background_job_id);
  }
  assert.equal(jobs.started.length, 1);
  assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
  pending = 0;
  const expected = await requestedModule(f);
  marker(f, { ...runtimeIdentity(f.moduleUrl), module: expected });
  const outcome = await observer.done;
  assert.equal(outcome.status, 'completed');
  const result = JSON.parse(outcome.result);
  assert.equal(result.status, 'reloaded');
  assert.equal(result.active_tasks, 0);
  assert.equal(result.confirmed, true);
});

test('native cancel stops only the runtime observer and leaves Codex and profile untouched', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  let lists = 0;
  const conductor = forbidCodexMutations(async () => { lists++; return { jobs: [{ job_id: 'J1' }], total: 1 }; });
  await runtimeTool(f, { jobs, conductor }).execute({ action: 'reload' }, runtimeExec);
  const observer = jobs.started[0];
  observer.cancel();
  const outcome = await observer.done;
  assert.equal(outcome.status, 'killed');
  assert.equal(JSON.parse(outcome.result).status, 'cancelled');
  assert.equal(lists, 1);
  assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
});

test('idle observer becomes already_current if another instance loads current source while runners remain busy', async (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  marker(f, { ...runtimeIdentity(f.moduleUrl), version: 'older' });
  const jobs = nativeJobs();
  const tool = runtimeTool(f, { jobs, conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 })) });
  await tool.execute({ action: 'reload' }, runtimeExec);
  const observer = jobs.started[0];
  t.after(() => observer.cancel());
  const newModule = f.moduleUrl.replace('?v=old', '?v=other-instance');
  writeFileSync(f.profileFile, profile(newModule));
  const actual = marker(f, { ...runtimeIdentity(f.moduleUrl), module: newModule });
  const bytes = readFileSync(f.profileFile);
  const outcome = await observer.done;
  assert.equal(outcome.status, 'completed');
  const result = JSON.parse(outcome.result);
  assert.equal(result.status, 'already_current');
  assert.equal(result.active_tasks, 1);
  assert.deepEqual(result.loaded, actual);
  assert.deepEqual(readFileSync(f.profileFile), bytes);
});

test('now reload preserves active tasks and reports success only after the exact new marker', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  const tool = runtimeTool(f, { jobs, conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 })) });
  let settled = false;
  const operation = tool.execute({ action: 'reload', when: 'now' }, runtimeExec).then((result) => { settled = true; return result; });
  const expected = await requestedModule(f);
  marker(f); // the old query does not confirm the new request
  await delay(70);
  assert.equal(settled, false);
  const actual = marker(f, { ...runtimeIdentity(f.moduleUrl), module: expected });
  const result = await operation;
  assert.equal(result.status, 'reloaded');
  assert.equal(result.confirmed, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.active_tasks, 1);
  assert.deepEqual(result.loaded, actual);
  assert.equal(result.expected_module, expected);
  assert.equal(jobs.started.length, 0);
});

test('reload marker timeout stays explicitly unconfirmed', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const result = await runtimeTool(f).execute({ action: 'reload', when: 'now' }, runtimeExec);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.confirmed, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.loaded, null);
  assert.equal(typeof result.error, 'string');
  assert.notEqual(result.expected_module, f.moduleUrl);
});

test('idle observation fails honestly on bridge loss without writing the profile', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  let lists = 0;
  const tool = runtimeTool(f, { jobs, conductor: forbidCodexMutations(async () => {
    if (++lists > 1) return { status: 'failed', error_kind: 'bridge_error', error: 'offline' };
    return { jobs: [{ job_id: 'J1' }], total: 1 };
  }) });
  await tool.execute({ action: 'reload' }, runtimeExec);
  const observer = jobs.started[0];
  t.after(() => observer.cancel());
  const outcome = await observer.done;
  assert.equal(outcome.status, 'failed');
  assert.match(JSON.parse(outcome.result).error, /offline/);
  assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
});

test('marker observation supports cancellation without modifying files', async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const observation = waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule: f.moduleUrl, signal: controller.signal });
  controller.abort();
  await assert.rejects(observation, { name: 'AbortError' });
  assert.deepEqual(readdirSync(f.root), ['package']);
});


test('bridge failure keeps status readable, blocks idle writes, and still allows now with unknown active count', async (t) => {
  for (const list of [async () => ({ status: 'failed', error_kind: 'bridge_error', error: 'WSL offline' }),
    async () => { throw new Error('WSL offline'); }]) {
    const f = fixture(t);
    writeFileSync(f.profileFile, profile(f.moduleUrl));
    const bytes = readFileSync(f.profileFile);
    const jobs = nativeJobs();
    const tool = runtimeTool(f, { jobs, conductor: forbidCodexMutations(list) });
    const status = await tool.execute({}, runtimeExec);
    assert.equal(status.status, 'status');
    assert.equal(status.source.version, '1.2.3');
    assert.equal(status.active_tasks, null);
    assert.match(status.active_error, /WSL offline/);
    const idle = await tool.execute({ action: 'reload', when: 'idle' }, runtimeExec);
    assert.equal(idle.status, 'failed');
    assert.equal(idle.error_kind, 'active_count_unavailable');
    assert.equal(idle.active_tasks, null);
    assert.match(idle.active_error, /WSL offline/);
    assert.deepEqual(readFileSync(f.profileFile), bytes);
    assert.equal(jobs.started.length, 0);
    const operation = tool.execute({ action: 'reload', when: 'now' }, runtimeExec);
    const expected = await requestedModule(f);
    const actual = marker(f, { ...runtimeIdentity(f.moduleUrl), module: expected });
    const now = await operation;
    assert.equal(now.status, 'reloaded');
    assert.equal(now.confirmed, true);
    assert.equal(now.active_tasks, null);
    assert.match(now.active_error, /WSL offline/);
    assert.deepEqual(now.loaded, actual);
    assert.equal(jobs.started.length, 0);
  }
});


test('native job reuse excludes unowned jobs returned by the current SDK list(owner)', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  jobs.started.push({ id: 'unowned', kind: 'codex-runtime', label: 'Codex runtime · 等待空闲后重载', status: 'running' });
  const tool = runtimeTool(f, { jobs,
    conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 })) });
  const result = await tool.execute({ action: 'reload' }, runtimeExec);
  assert.equal(result.status, 'waiting_for_idle');
  assert.equal(result.reused, false);
  assert.notEqual(result.background_job_id, 'unowned');
  const observer = jobs.started[1];
  assert.equal(observer.owner, runtimeExec.agent.id);
  observer.cancel();
  assert.equal((await observer.done).status, 'killed');
  assert.equal(jobs.started[0].status, 'running');
  assert.equal(readFileSync(f.profileFile, 'utf8'), profile(f.moduleUrl));
});
