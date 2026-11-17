import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAliases } from './handover.mjs';

const dir = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-handover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('aliases chain predecessors, persist across instances and never touch unrelated sessions', (t) => {
  const root = dir(t);
  const a = createAliases(root);
  assert.deepEqual(a.owners('session-A'), ['session-A']);
  a.link('session-A', 'session-B');
  a.link('session-B', 'session-C');
  // 新实例（模拟热重载或重启）读同一份文件。
  const b = createAliases(root);
  assert.deepEqual(b.owners('session-C'), ['session-C', 'session-B', 'session-A']);
  assert.deepEqual(b.owners('session-B'), ['session-B', 'session-A']);
  assert.deepEqual(b.owners('session-A'), ['session-A']);
  assert.deepEqual(b.owners('session-X'), ['session-X']);
  assert.equal(b.successor('session-A'), 'session-B');
  assert.equal(b.successor('session-C'), undefined);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'handover.json'), 'utf8')).links['session-C'].from, 'session-B');
  // 一个前任只能交给一个后继；不能成环；不能自交。
  assert.throws(() => b.link('session-A', 'session-D'), /already handed over/);
  assert.throws(() => b.link('session-C', 'session-A'), /predecessor/);
  assert.throws(() => b.link('session-D', 'session-D'), /invalid/);
  assert.throws(() => b.link('session-D', 'session-B'), /already took over/);
  b.unlink('session-B', 'session-C');
  assert.deepEqual(b.owners('session-C'), ['session-C']);
  assert.throws(() => b.unlink('session-B', 'session-C'), /did not take over/);
  // 坏文件或没有目录时只按本会话处理。
  assert.deepEqual(createAliases(undefined).owners('session-A'), ['session-A']);
  assert.deepEqual(createAliases(path.join(root, 'missing')).owners('session-C'), ['session-C']);
});
