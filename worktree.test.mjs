import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeWorktree, mergeWorktree, openWorktree, relocate, relocateText, repoFor, worktreeStatus } from './worktree.mjs';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-worktree-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const commitAll = (dir, message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };

function repo(name) {
  const root = path.join(tmp, name, 'repo');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'vm'), { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), 'vm/\n*.bin\n');
  writeFileSync(path.join(root, 'src', 'a.txt'), 'one\ntwo\n');
  writeFileSync(path.join(root, 'vm', 'disk.vhdx'), 'shared material\n');
  writeFileSync(path.join(root, 'src', 'blob.bin'), 'ignored file\n');
  git(root, 'init', '-q', '-b', 'main');
  commitAll(root, 'base');
  return root;
}

test('paths and task text move from the repository into the worktree, and nothing else does', () => {
  assert.equal(repoFor(['D:\\work\\opsec'], ['d:/WORK/opsec/10-audit']), 'D:\\work\\opsec');
  assert.equal(repoFor(['D:\\work\\opsec'], ['D:\\work\\opsec2', '/mnt/d/work/other']), undefined);
  assert.equal(repoFor(['D:\\work\\opsec'], ['/mnt/d/work/opsec/x']), 'D:\\work\\opsec');
  const text = '改 D:\\work\\opsec\\a.py 和 D:/work/opsec/b.md，读 /mnt/d/work/opsec/c；不碰 D:\\work\\opsec2\\d 与 D:\\work\\opsec。';
  assert.equal(relocateText(text, 'D:\\work\\opsec', 'D:\\work\\worktree-space\\opsec\\abcd1234'),
    '改 D:\\work\\worktree-space\\opsec\\abcd1234\\a.py 和 D:/work/worktree-space/opsec/abcd1234/b.md，读 /mnt/d/work/worktree-space/opsec/abcd1234/c；' +
    '不碰 D:\\work\\opsec2\\d 与 D:\\work\\worktree-space\\opsec\\abcd1234。');
  const root = path.join(tmp, 'r');
  assert.equal(relocate(path.join(root, 'src', 'x.py'), root, path.join(tmp, 'w')), path.join(tmp, 'w', 'src', 'x.py'));
  assert.equal(relocate(path.join(tmp, 'elsewhere'), root, path.join(tmp, 'w')), path.join(tmp, 'elsewhere'));
});

test('a conversation worktree shares ignored material, merges back after a trial merge, and closes without touching the material', async () => {
  const root = repo('flow');
  const first = await openWorktree({ repo: root, owner: 'session-aaaa1111-0000', maxUntracked: 10 });
  assert.equal(first.branch, 'conv/aaaa1111');
  assert.equal(first.base_branch, 'main');
  assert.equal(first.path, path.join(tmp, 'flow', 'worktree-space', 'repo', 'aaaa1111'));
  assert.deepEqual(first.links, ['vm']);
  assert.equal(first.hardlinks, 1);
  // Material is shared, not copied: a write through the link lands in the main checkout.
  writeFileSync(path.join(first.path, 'vm', 'out.log'), 'from the worktree\n');
  assert.equal(readFileSync(path.join(root, 'vm', 'out.log'), 'utf8'), 'from the worktree\n');
  writeFileSync(path.join(first.path, 'src', 'a.txt'), 'one\nTWO\n');
  writeFileSync(path.join(first.path, 'src', 'new.txt'), 'new\n');
  commitAll(first.path, 'work');
  assert.deepEqual(git(first.path, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['src/a.txt', 'src/new.txt']);

  // A second conversation edits the same line: the first merges, the second gets the conflict in its own worktree.
  const second = await openWorktree({ repo: root, owner: 'session-bbbb2222-0000', maxUntracked: 10 });
  writeFileSync(path.join(second.path, 'src', 'a.txt'), 'one\nzwei\n');
  commitAll(second.path, 'other work');
  const merged = await mergeWorktree({ repo: root, ...first });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.commits, 1);
  assert.equal(readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'new\n');
  assert.equal(merged.synced, true);
  const conflict = await mergeWorktree({ repo: root, ...second });
  assert.deepEqual([conflict.status, conflict.files], ['conflict', ['src/a.txt']]);
  assert.equal(readFileSync(path.join(root, 'src', 'a.txt'), 'utf8'), 'one\nTWO\n', 'the main checkout is untouched by the conflict');
  assert.match(readFileSync(path.join(second.path, 'src', 'a.txt'), 'utf8'), /^<{7} /m);
  assert.equal((await mergeWorktree({ repo: root, ...second })).pending, true);
  writeFileSync(path.join(second.path, 'src', 'a.txt'), 'one\nTWO zwei\n');
  git(second.path, 'add', '-A');
  git(second.path, 'commit', '-q', '--no-edit');

  // Uncommitted edits in the main checkout that overlap the incoming files block the merge; unrelated ones do not.
  writeFileSync(path.join(root, 'src', 'a.txt'), 'local edit\n');
  const blocked = await mergeWorktree({ repo: root, ...second });
  assert.deepEqual([blocked.status, blocked.reason, blocked.files], ['blocked', 'checkout_dirty_overlap', ['src/a.txt']]);
  git(root, 'checkout', '--', 'src/a.txt');
  writeFileSync(path.join(root, 'notes.md'), 'unrelated, untracked\n');
  const again = await mergeWorktree({ repo: root, ...second });
  assert.equal(again.status, 'merged');
  assert.equal(readFileSync(path.join(root, 'src', 'a.txt'), 'utf8'), 'one\nTWO zwei\n');
  assert.equal(readFileSync(path.join(root, 'notes.md'), 'utf8'), 'unrelated, untracked\n');

  // Nothing left to merge; close drops the links (never the material), the worktree and the merged branch.
  assert.equal((await mergeWorktree({ repo: root, ...first })).status, 'nothing');
  assert.deepEqual((await worktreeStatus({ repo: root, ...first })), { exists: true, dirty: 0, ahead: 0, merging: false });
  const closed = await closeWorktree({ repo: root, ...first });
  assert.deepEqual([closed.status, closed.branch_deleted], ['closed', true]);
  assert.equal(existsSync(first.path), false);
  assert.equal(readFileSync(path.join(root, 'vm', 'disk.vhdx'), 'utf8'), 'shared material\n');
  assert.equal(readFileSync(path.join(root, 'vm', 'out.log'), 'utf8'), 'from the worktree\n');
  assert.ok(lstatSync(path.join(second.path, 'vm')).isSymbolicLink());
});

test('a main checkout full of untracked files, a detached HEAD or another branch keeps the conversation in the main checkout', async () => {
  const root = repo('guards');
  for (let i = 0; i < 3; i++) writeFileSync(path.join(root, `loose-${i}.txt`), 'x\n');
  assert.match((await openWorktree({ repo: root, owner: 'session-cccc3333-0', maxUntracked: 2 })).shared, /3 个文件既没纳入 git/);
  const opened = await openWorktree({ repo: root, owner: 'session-cccc3333-0', maxUntracked: 5 });
  writeFileSync(path.join(opened.path, 'src', 'b.txt'), 'b\n');
  commitAll(opened.path, 'b');
  git(root, 'checkout', '-q', '-b', 'side');
  const elsewhere = await mergeWorktree({ repo: root, ...opened });
  assert.deepEqual([elsewhere.status, elsewhere.reason, elsewhere.current], ['blocked', 'target_not_checked_out', 'side']);
  git(root, 'checkout', '-q', '--detach');
  assert.match((await openWorktree({ repo: root, owner: 'session-dddd4444-0', maxUntracked: 5 })).shared, /分离 HEAD/);
  git(root, 'checkout', '-q', 'main');
  writeFileSync(path.join(opened.path, 'src', 'b.txt'), 'uncommitted\n');
  assert.deepEqual((await mergeWorktree({ repo: root, ...opened })).reason, 'worktree_dirty');
  assert.equal((await closeWorktree({ repo: root, ...opened })).reason, 'worktree_dirty');
});
