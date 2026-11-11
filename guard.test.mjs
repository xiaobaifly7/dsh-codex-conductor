import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductReads, PRODUCT_HINT } from './guard.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const call = (name, args, owner = 'S1') => ({
  name, arguments: args, agent: { id: owner, session: { header: { cwd: '/repo' } } },
});
const denial = `[codex-conductor] ${PRODUCT_HINT}`;

test('product refresh does not label raw binaries or unrelated source as possible artifacts', async () => {
  let complete;
  const owners = [];
  const scope = createProductReads({}, owner => {
    owners.push(owner);
    return new Promise(resolve => { complete = resolve; });
  });
  scope.add('S1', ['/repo/report.md']);
  for (const [name, args] of [
    ['wsl', { command: 'sha256sum /repo/product/drt-lite.exe' }],
    ['wsl', { command: 'grep -n createProductReads /plugins/conductor/index.mjs' }],
    ['read', { file_path: '/repo/raw.js' }],
    ['read', { paths: ['/repo/report.md', '/repo/raw.js'] }],
    ['wsl', { command: 'cat "$FILE"' }],
  ]) assert.equal(scope.check(call(name, args), '/repo'), denial, name);
  assert.equal(scope.check(call('read', { file_path: '/repo/report.md' }), '/repo'), undefined);
  await tick();
  assert.deepEqual(owners, ['S1']);
  complete({ status: 'completed', owner: 'S1', paths: ['/repo/generated.md'] });
  await tick();
  assert.equal(scope.check(call('read', { file_path: '/repo/generated.md' }), '/repo'), undefined);
  assert.equal(scope.check(call('read', { file_path: '/repo/raw.js' }), '/repo'), denial);
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
  assert.equal(read('/repo/raw.js'), denial);
  await tick();
  assert.equal(read('/repo/product/drt-lite.exe'), denial);
  assert.equal(read('/plugins/conductor/index.mjs'), denial);
  assert.equal(read('/repo/report.md'), undefined);
  assert.equal(refreshes, 1);
  time = 25_000;
  assert.equal(read('/repo/raw.js'), denial);
  await tick();
  assert.equal(refreshes, 2);
  assert.equal(read('/repo/raw.js'), denial);
});

test('successful refresh, subsequent refresh and owner mismatch preserve the product boundary', async () => {
  let time = 0;
  const scope = createProductReads({}, async () => ({
    status: 'completed', owner: 'S1', paths: ['/repo/report.md'],
  }), { now: () => time });
  const read = (file, owner = 'S1') => scope.check(call('read', { file_path: file }, owner), '/repo');
  assert.equal(read('/repo/raw.js'), denial);
  await tick();
  assert.equal(read('/repo/report.md'), undefined);
  time = 25_000;
  assert.equal(read('/repo/raw.js'), denial);
  assert.equal(read('/repo/report.md'), undefined);
  assert.equal(read('/repo/report.md', 'S2'), denial);
  await tick();
  assert.equal(read('/repo/report.md', 'S2'), denial);
  assert.equal(read('/repo/raw.js'), denial);
});
