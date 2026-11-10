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
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runtimeIdentity, runtimeStatus, requestRuntimeReload, waitForRuntimeLoad, registerRuntimeTool,
  saveRuntimeSettings, validatePanelSettings, writeBackedUpFile } from './runtime.mjs';

const runtimeUrl = new URL('./runtime.mjs', import.meta.url).href;
const oldId = 'codex-conductor-runtime-5e86941';
const windowsModule = 'file:///C:/Users/Example%20User/dsh-codex-conductor/index.mjs?v=literal-parameters-5e86941';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-runtime-test-'));
  const cleanups = [];
  t.after(() => { for (const cleanup of cleanups) cleanup(); rmSync(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'package');
  mkdirSync(directory);
  const pkg = path.join(directory, 'package.json');
  const entry = path.join(directory, 'index.mjs');
  writeFileSync(pkg, JSON.stringify({ type: 'module', version: '1.2.3' }));
  writeFileSync(entry, `import { runtimeIdentity } from ${JSON.stringify(runtimeUrl)};\nexport const loadedIdentity = runtimeIdentity(import.meta.url);\n`);
  return { root, directory, pkg, entry, cleanups, moduleUrl: pathToFileURL(entry).href + '?v=old',
    profileFile: path.join(root, 'profile.yml'), loadedFile: path.join(root, 'loaded.json') };
}

function git(directory, args) {
  const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

test('panel settings preserve comments, quotes, nested fields, other entries and original bytes in backup', (t) => {
  const f = fixture(t);
  const original = `# header\r\nplugins:\r\n  - id: ${oldId}\r\n    name: ${f.moduleUrl}\r\n    config:\r\n      model: 'old-model' # keep model note\r\n      effort: medium\r\n      serviceTier: fast\r\n      plannerAnswers: false # keep switch note\r\n      gemini:\r\n        command: 'C:\\agy.exe'\r\n        model: old-gemini # nested note\r\n        effort: low\r\n      unrelated: keep\r\n  - id: other\r\n    name: other\r\n    config:\r\n      model: old-model\r\n`;
  writeFileSync(f.profileFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original)]));
  const before = readFileSync(f.profileFile);
  const result = saveRuntimeSettings({ ...f, changes: { model: 'codex/gpt-6-astra', effort: 'max', serviceTier: 'ultrafast',
    plannerAnswers: true, gemini: { model: 'gemini-4-argon', effort: 'high' } } });
  const expected = original.replace("'old-model'", "'codex/gpt-6-astra'").replace('effort: medium', 'effort: max')
    .replace('serviceTier: fast', 'serviceTier: ultrafast').replace('plannerAnswers: false', 'plannerAnswers: true')
    .replace('model: old-gemini', 'model: gemini-4-argon').replace('effort: low', 'effort: high');
  assert.deepEqual(readFileSync(result.backup), before);
  assert.deepEqual(readFileSync(f.profileFile), Buffer.concat([before.subarray(0, 3), Buffer.from(expected)]));
});

test('panel settings insert absent fields/config using surrounding indentation without touching other scalars', (t) => {
  const f = fixture(t);
  for (const config of ['', '      config:\n        unrelated: keep\n',
    '      config:\n        unrelated: keep\n        gemini:\n          command: agy\n']) {
    const text = `- insert:\n    - id: ${oldId}\n      name: ${f.moduleUrl}\n${config}- id: other\n  config:\n    model: unchanged\n`;
    writeFileSync(f.profileFile, text);
    const changes = { model: 'next', readOnlyEffort: '', lockTimeoutSeconds: 3.5, maxStorageMb: 256,
      ...(config.includes('gemini:') ? { gemini: { model: 'gemini', effort: 'medium' } } : {}) };
    saveRuntimeSettings({ ...f, changes });
    const saved = readFileSync(f.profileFile, 'utf8');
    assert.ok(saved.includes('        model: next\n'));
    assert.ok(saved.includes("        readOnlyEffort: ''\n"));
    assert.ok(saved.includes('        lockTimeoutSeconds: 3.5\n'));
    assert.ok(saved.endsWith('- id: other\n  config:\n    model: unchanged\n'));
    if (config.includes('gemini:')) assert.ok(saved.includes('          model: gemini\n          effort: medium\n'));
  }
});

test('panel model names that look like YAML values remain strings', (t) => {
  const f = fixture(t);
  for (const model of ['null', 'TRUE', '123', '-', ':', 'vendor:model']) {
    writeFileSync(f.profileFile, profile(f.moduleUrl));
    saveRuntimeSettings({ ...f, changes: { model } });
    assert.ok(readFileSync(f.profileFile, 'utf8').includes('model: ' + JSON.stringify(model)));
  }
});

test('panel settings reject invalid values and unsupported YAML without changing the file', (t) => {
  const f = fixture(t);
  const text = `plugins:\n  - id: ${oldId}\n    name: ${f.moduleUrl}\n    config:\n      model: old\n`;
  for (const changes of [null, [], {}, { unknown: 1 }, { model: '' }, { model: 'a b' }, { model: 'a'.repeat(81) },
    { model: 'a\nother: injected' }, { effort: '' }, { effort: 'ultra' }, { readOnlyEffort: 'ultra' },
    { plannerAnswers: 'true' }, { serviceTier: 'priority' }, { lockTimeoutSeconds: 0 }, { lockTimeoutSeconds: -1 },
    { lockTimeoutSeconds: NaN }, { maxStorageMb: Infinity }, { maxStorageMb: null }, { maxStorageMb: '1' },
    { gemini: { model: 'new' } }]) {
    writeFileSync(f.profileFile, text);
    assert.throws(() => saveRuntimeSettings({ ...f, changes }));
    assert.equal(readFileSync(f.profileFile, 'utf8'), text);
  }
  for (const value of [{ gemini: {} }, { gemini: { command: 'other' } }, { gemini: { effort: 'max' } }]) {
    assert.throws(() => validatePanelSettings(value, true));
  }
  for (const config of ['    config: {}\n', '    config:\n      model: |\n        previous\n',
    '    config:\n      model: old\n      model: duplicate\n']) {
    const original = text.slice(0, text.indexOf('    config:')) + config;
    writeFileSync(f.profileFile, original);
    assert.throws(() => saveRuntimeSettings({ ...f, changes: { model: 'new' } }));
    assert.equal(readFileSync(f.profileFile, 'utf8'), original);
  }
});

test('failed atomic profile replacement leaves the original intact and removes the temporary file', (t) => {
  const f = fixture(t);
  const original = `plugins:\n  - id: ${oldId}\n    name: ${f.moduleUrl}\n    config:\n      model: old\n`;
  writeFileSync(f.profileFile, original);
  t.mock.method(fs, 'renameSync', () => { throw new Error('simulated rename failure'); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveRuntimeSettings({ ...f, changes: { model: 'new' } }), /simulated rename failure/);
    assert.equal(readFileSync(f.profileFile, 'utf8'), original);
    assert.equal(readdirSync(f.root).some((file) => file.endsWith('.tmp')), false);
    const backup = readdirSync(f.root).find((file) => file.endsWith('.bak'));
    assert.equal(readFileSync(path.join(f.root, backup), 'utf8'), original);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('concurrent file edits are a conflict and preserve the latest content without a backup', (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, 'edited by another process');
  assert.throws(() => writeBackedUpFile(f.profileFile, Buffer.from('replacement'), Buffer.from('stale content')),
    { status: 409 });
  assert.equal(readFileSync(f.profileFile, 'utf8'), 'edited by another process');
  assert.deepEqual(readdirSync(f.root).sort(), ['package', 'profile.yml']);
});

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
  const record = { ...identity, loadedAt: '2026-01-01T01:02:03.000Z', pid: process.pid,
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

test('an exited process cannot confirm runtime synchronization or a reload', async (t) => {
  const f = fixture(t);
  repository(f);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const record = marker(f);
  const child = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  assert.equal(child.status, 0);
  writeFileSync(f.loadedFile, JSON.stringify({ ...record, pid: child.pid }));

  const result = status(f);
  assert.equal(result.state, 'unknown');
  assert.equal(result.loaded, null);
  assert.match(result.loaded_error, /进程已退出/);
  const confirmation = await waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule: f.moduleUrl, timeoutMs: 0 });
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.loaded, null);
  assert.match(confirmation.error, /进程已退出/);
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

test('status shows one relocated managed target without allowing the old instance to reload it', async (t) => {
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
  assert.equal(relocated.profile_error_status, 409);
  assert.throws(() => requestRuntimeReload(f), { status: 409 });
  const tool = runtimeTool(f);
  for (const changes of [undefined, { model: 'new-model' }]) {
    assert.equal((await tool.execute({ action: 'reload' }, { panel: true }, changes)).error_status, 409);
  }
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
    loadedAt: new Date().toISOString(), pid: process.pid, defaultHostAccess: true, workspaces: ['*'] };
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
  const cleanups = [];
  const ctx = { tools: { register(spec) { tool = spec; return spec; } },
    effect(setup) { cleanups.push(setup()); },
    get(name) { assert.equal(name, 'jobs'); return jobs; } };
  const registered = registerRuntimeTool({ ctx, conductor, moduleUrl: f.moduleUrl, loadedIdentity,
    profileFile, loadedFile: f.loadedFile, activeDispatches, dispatchGeneration });
  assert.equal(registered, tool);
  tool.dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  f.cleanups.push(tool.dispose);
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

test('panel settings and reload token are committed together with a backup and exact load confirmation', async (t) => {
  const f = fixture(t);
  const original = profile(f.moduleUrl);
  writeFileSync(f.profileFile, original);
  const tool = runtimeTool(f);
  const loaded = (async () => {
    const module = await requestedModule(f);
    assert.match(readFileSync(f.profileFile, 'utf8'), /model: new-model/);
    marker(f, { ...runtimeIdentity(f.moduleUrl), module });
  })();
  const result = await tool.execute({ action: 'reload', when: 'idle' }, { panel: true }, { model: 'new-model' });
  await loaded;
  assert.equal(result.saved, true);
  assert.equal(result.status, 'reloaded');
  assert.equal(result.confirmed, true);
  assert.equal(readFileSync(result.backup, 'utf8'), original);
  assert.notEqual(result.expected_module, f.moduleUrl);
});

test('busy panel saves persist, replace and cancel without changing the profile; plain reload can still wait', async (t) => {
  const f = fixture(t);
  const original = profile(f.moduleUrl);
  writeFileSync(f.profileFile, original);
  const jobs = nativeJobs();
  let running = true;
  const tool = runtimeTool(f, { jobs, conductor: { list: async () => ({ jobs: running ? [{ job_id: 'J' }] : [], total: running ? 1 : 0 }) } });
  const pendingFile = path.join(f.root, 'pending-settings.json');
  const saved = await tool.execute({ action: 'reload', when: 'idle' }, { panel: true }, { model: 'new-model' });
  assert.equal(saved.status, 'waiting_for_idle');
  assert.equal(saved.saved, true);
  assert.equal(saved.active_tasks, 1);
  assert.deepEqual(saved.pending_settings.changes, { model: 'new-model' });
  assert.deepEqual(JSON.parse(readFileSync(pendingFile)).changes, { model: 'new-model' });
  const replaced = await tool.execute({ action: 'reload' }, { panel: true }, { effort: 'max' });
  assert.deepEqual(replaced.pending_settings.changes, { effort: 'max' });
  assert.equal((await tool.execute({ action: 'reload' }, { panel: true }, { model: 'invalid model' })).status, 'failed');
  assert.deepEqual(JSON.parse(readFileSync(pendingFile)).changes, { effort: 'max' });
  assert.deepEqual(tool.cancelPending(), { cancelled: true });
  assert.equal(fs.existsSync(pendingFile), false);
  assert.equal((await tool.execute({ action: 'status' })).pending_settings, null);
  assert.equal(readFileSync(f.profileFile, 'utf8'), original);
  const waiting = await tool.execute({ action: 'reload', when: 'idle' }, { panel: true });
  assert.equal(waiting.status, 'waiting_for_idle');
  assert.equal(jobs.started[0].owner, undefined);
  const repeated = await tool.execute({ action: 'reload', when: 'idle' }, { panel: true });
  assert.equal(repeated.reused, true);
  assert.equal(jobs.started.length, 1);
  jobs.started[0].cancel();
  await jobs.started[0].done;
  assert.equal(readFileSync(f.profileFile, 'utf8'), original);
});

test('pending settings survive a fresh runtime registration and automatically apply the latest save at idle', async (t) => {
  const f = fixture(t);
  const original = profile(f.moduleUrl);
  writeFileSync(f.profileFile, original);
  let running = true;
  const options = { conductor: forbidCodexMutations(async () => ({ jobs: running ? [{ job_id: 'J' }] : [], total: running ? 1 : 0 })) };
  const first = runtimeTool(f, options);
  await first.execute({ action: 'reload' }, { panel: true }, { model: 'superseded' });
  await first.execute({ action: 'reload' }, { panel: true }, { model: 'survives-restart', effort: 'max' });
  first.dispose();
  const second = runtimeTool(f, options);
  assert.deepEqual((await second.execute({ action: 'status' })).pending_settings.changes, { model: 'survives-restart', effort: 'max' });
  assert.equal(readFileSync(f.profileFile, 'utf8'), original);
  running = false;
  const expected = await requestedModule(f);
  assert.match(readFileSync(f.profileFile, 'utf8'), /model: survives-restart/);
  assert.match(readFileSync(f.profileFile, 'utf8'), /effort: max/);
  marker(f, { ...runtimeIdentity(f.moduleUrl), module: expected });
  assert.equal((await second.execute({ action: 'status' })).pending_settings, null);
  assert.equal(fs.existsSync(path.join(f.root, 'pending-settings.json')), false);
  assert.equal(readdirSync(f.root).filter((name) => name.endsWith('.bak')).length, 1);
});

test('queued settings are revalidated at idle and keep a visible error if the profile changes', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  let running = true;
  const tool = runtimeTool(f, { conductor: forbidCodexMutations(async () => ({ jobs: running ? [{ job_id: 'J' }] : [], total: running ? 1 : 0 })) });
  await tool.execute({ action: 'reload' }, { panel: true }, { model: 'new-model' });
  const changed = profile(f.moduleUrl).replace('    config:\n', '    config: {}\n');
  writeFileSync(f.profileFile, changed);
  running = false;
  const deadline = performance.now() + 8000;
  let state;
  do {
    await delay(25);
    state = await tool.execute({ action: 'status' });
  } while (!state.pending_settings.error && performance.now() < deadline);
  assert.match(state.pending_settings.error, /设置未能生效/);
  assert.equal(readFileSync(f.profileFile, 'utf8'), changed);
  tool.dispose();
  const restarted = runtimeTool(f);
  assert.match((await restarted.execute({ action: 'status' })).pending_settings.error, /设置未能生效/);
  restarted.cancelPending();
});

test('immediate panel settings preserve running jobs and wait for the exact loaded marker', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const tool = runtimeTool(f, { conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J' }], total: 1 })) });
  let settled = false;
  const operation = tool.execute({ action: 'reload', when: 'now' }, { panel: true }, { model: 'immediate' })
    .then((result) => { settled = true; return result; });
  const expected = await requestedModule(f);
  assert.equal(settled, false);
  assert.match(readFileSync(f.profileFile, 'utf8'), /model: immediate/);
  assert.throws(() => tool.cancelPending(), { status: 409, message: '设置已写入，不能撤销。请等待加载后再保存新的设置。' });
  marker(f, { ...runtimeIdentity(f.moduleUrl), module: expected });
  const result = await operation;
  assert.equal(result.status, 'reloaded');
  assert.equal(result.active_tasks, 1);
  assert.equal(result.pending_settings, null);
});

test('a profile write failure retains pending settings and its reason for the panel', async (t) => {
  const f = fixture(t);
  const original = profile(f.moduleUrl);
  writeFileSync(f.profileFile, original);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.profileFile) throw new Error('fixture profile is locked');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const result = await runtimeTool(f).execute({ action: 'reload' }, { panel: true }, { model: 'new-model' });
    assert.equal(result.status, 'failed');
    assert.equal(result.saved, true);
    assert.equal(result.error_status, 500);
    assert.match(result.pending_settings.error, /fixture profile is locked/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, 'pending-settings.json'))).changes, { model: 'new-model' });
    assert.equal(readFileSync(f.profileFile, 'utf8'), original);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

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
  assert.equal(result.error_status, 409);
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
    assert.equal(result.error_status, jobs?.start && !jobs.started ? 500 : 409);
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

test('rechecking a submitted reload keeps the same target even with active tasks', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const request = requestRuntimeReload({ moduleUrl: f.moduleUrl, profileFile: f.profileFile });
  const submitted = readFileSync(f.profileFile);
  const tool = runtimeTool(f, { conductor: forbidCodexMutations(async () => ({ jobs: [{ job_id: 'J1' }], total: 1 })) });
  for (const when of ['now', 'idle']) {
    marker(f);
    const controller = new AbortController();
    const operation = tool.execute({ action: 'reload', when }, { ...runtimeExec, signal: controller.signal });
    try {
      await delay(65);
      assert.deepEqual(readFileSync(f.profileFile), submitted);
      marker(f, { ...runtimeIdentity(f.moduleUrl), module: request.expected_module });
      const result = await operation;
      assert.equal(result.status, 'reloaded');
      assert.equal(result.reused, true);
      assert.equal(result.expected_module, request.expected_module);
    } finally { controller.abort(); await operation; }
  }
});

test('default reload confirmation still accepts the exact marker after 24 seconds', async (t) => {
  const f = fixture(t);
  const expectedModule = new URL('?v=target', f.moduleUrl).href;
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const observation = waitForRuntimeLoad({ loadedFile: f.loadedFile, expectedModule });
  now = 24_000;
  await delay(75);
  marker(f, { ...runtimeIdentity(f.moduleUrl), module: expectedModule });
  assert.equal((await observation).confirmed, true);
});

test('reload marker timeout stays explicitly unconfirmed', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  let reads = 0;
  t.mock.method(performance, 'now', () => reads++ ? 30_001 : 0);
  const result = await runtimeTool(f).execute({ action: 'reload', when: 'now' }, runtimeExec);
  assert.match(result.next, /status.*不要重复重载/);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.confirmed, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.loaded, null);
  assert.equal(typeof result.error, 'string');
  assert.notEqual(result.expected_module, f.moduleUrl);
});

test('idle observer reports an unconfirmed request without reporting a load failure', async (t) => {
  const f = fixture(t);
  writeFileSync(f.profileFile, profile(f.moduleUrl));
  const jobs = nativeJobs();
  let pending = 1;
  let reads = 0;
  t.mock.method(performance, 'now', () => reads++ ? 30_001 : 0);
  const tool = runtimeTool(f, { jobs, activeDispatches: () => pending });
  await tool.execute({ action: 'reload' }, runtimeExec);
  const observer = jobs.started[0];
  t.after(() => observer.cancel());
  pending = 0;
  const outcome = await observer.done;
  assert.equal(outcome.status, 'completed');
  assert.match(outcome.detail, /尚未确认加载/);
  const result = JSON.parse(outcome.result);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(result.confirmed, false);
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
    assert.equal(idle.error_status, 502);
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
