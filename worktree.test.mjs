import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeWorktree, mergeWorktree, openWorktree as openConversationWorktree, pathKey, within, relocate, relocateText, repoFor, worktreeStatus } from './worktree.mjs';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'conductor-worktree-test-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
const commitAll = (dir, message) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', message); };

async function openWorktree(args) {
  const opened = await openConversationWorktree(args);
  if (process.platform !== 'win32' && opened.path) {
    // Direct Git calls in these fixtures need the same link exclusions the WSL runner supplies.
    git(args.repo, 'config', 'extensions.worktreeConfig', 'true');
    const excludes = git(opened.path, 'rev-parse', '--git-path', 'conversation-links.exclude').trim();
    git(opened.path, 'config', '--worktree', 'core.excludesFile', excludes);
  }
  return opened;
}

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

test('task text relocates JSON-quoted Windows paths without changing sibling paths', () => {
  const source = 'D:\\work\\closed';
  const destination = 'D:\\work\\repo';
  const text = JSON.stringify({ task: `Read ${source}\\a.txt`, sibling: `${source}2\\b.txt` });
  assert.deepEqual(JSON.parse(relocateText(text, source, destination)),
    { task: `Read ${destination}\\a.txt`, sibling: `${source}2\\b.txt` });
});

test('a conversation worktree shares ignored material, merges back after a trial merge, and closes without touching the material', async () => {
  const root = repo('flow');
  const first = await openWorktree({ repo: root, owner: 'session-aaaa1111-0000', maxUntracked: 10 });
  assert.equal(first.branch, 'conv/aaaa1111');
  assert.equal(first.base_branch, 'main');
  assert.equal(first.path, path.join(tmp, 'flow', 'conversation-worktrees', 'repo', 'aaaa1111'));
  assert.deepEqual(first.links, ['vm']);
  // The links are listed for git in WSL, which sees a junction as a symlink that vm/ does not ignore.
  const excludes = path.join(root, '.git', 'worktrees', 'aaaa1111', 'conversation-links.exclude');
  assert.equal(readFileSync(excludes, 'utf8'), '/vm\n');
  git(first.path, '-c', `core.excludesFile=${excludes}`, 'check-ignore', '-q', 'vm');
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
  const before = git(root, 'rev-parse', 'HEAD').trim();
  const tip = git(root, 'rev-parse', first.branch).trim();
  const merged = await mergeWorktree({ repo: root, ...first });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.commits, 1);
  // A real merge commit (built from the trial tree, then fast-forwarded to): the old main first, the conversation second.
  assert.equal(git(root, 'rev-parse', 'HEAD').trim(), merged.commit);
  assert.deepEqual(git(root, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ').slice(1),
    [before, tip]);
  assert.equal(git(root, 'log', '-1', '--format=%s').trim(), '合并对话 worktree conv/aaaa1111（1 个提交）');
  assert.equal(git(root, 'status', '--porcelain').trim(), '', 'index and files follow the merge');
  assert.equal(readFileSync(path.join(root, 'src', 'new.txt'), 'utf8'), 'new\n');
  assert.equal(merged.synced, true);
  const mainHead = git(root, 'rev-parse', 'HEAD');
  const mainIndex = readFileSync(path.join(root, '.git', 'index'));
  const conflict = await mergeWorktree({ repo: root, ...second });
  assert.deepEqual([conflict.status, conflict.files], ['conflict', ['src/a.txt']]);
  assert.equal(git(root, 'rev-parse', 'HEAD'), mainHead);
  assert.deepEqual(readFileSync(path.join(root, '.git', 'index')), mainIndex);
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

test('closing moves output only the worktree holds back into the main checkout, and stops rather than overwrite a different copy', async () => {
  const root = repo('keep');
  const opened = await openWorktree({ repo: root, owner: 'session-eeee5555-0', maxUntracked: 10 });
  // git worktree remove deletes ignored files with the worktree; these exist only there.
  writeFileSync(path.join(opened.path, 'src', 'scan.bin'), 'scan output\n');
  mkdirSync(path.join(opened.path, 'src', 'dump'));
  writeFileSync(path.join(opened.path, 'src', 'dump', 'one.bin'), 'dump\n');
  const closed = await closeWorktree({ repo: root, ...opened });
  assert.deepEqual([closed.status, closed.moved_back], ['closed', 2]);
  assert.equal(readFileSync(path.join(root, 'src', 'scan.bin'), 'utf8'), 'scan output\n');
  assert.equal(readFileSync(path.join(root, 'src', 'dump', 'one.bin'), 'utf8'), 'dump\n');
  assert.equal(readFileSync(path.join(root, 'src', 'blob.bin'), 'utf8'), 'ignored file\n', 'the untouched hard link is the same file');

  // A tool that rewrites the hard-linked file by replacing it leaves two different copies: keep both, close nothing.
  const other = await openWorktree({ repo: root, owner: 'session-ffff6666-0', maxUntracked: 10 });
  assert.ok(lstatSync(path.join(other.path, 'src', 'dump')).isSymbolicLink(), 'a directory ignored by a file rule is linked whole');
  rmSync(path.join(other.path, 'src', 'blob.bin'));
  writeFileSync(path.join(other.path, 'src', 'blob.bin'), 'rewritten in the worktree\n');
  const blocked = await closeWorktree({ repo: root, ...other });
  assert.deepEqual([blocked.status, blocked.reason, blocked.files], ['blocked', 'ignored_clash', ['src/blob.bin']]);
  assert.equal(readFileSync(path.join(other.path, 'src', 'blob.bin'), 'utf8'), 'rewritten in the worktree\n');
  assert.equal(readFileSync(path.join(root, 'src', 'blob.bin'), 'utf8'), 'ignored file\n');
  rmSync(path.join(other.path, 'src', 'blob.bin'));
  assert.equal((await closeWorktree({ repo: root, ...other })).status, 'closed');
});

for (const rel of ['vm', 'src/dump']) {
  test(`closing preserves unique files after the shared ${rel} link is replaced by a directory`, async () => {
    const root = repo(`replace-${rel.replace('/', '-')}`);
    const home = path.join(root, rel, 'nested');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'original.bin'), 'original\n');
    const opened = await openWorktree({ repo: root, owner: 'session-11112222-0' });
    const at = path.join(opened.path, rel);
    assert.ok(opened.links.includes(rel));
    assert.ok(lstatSync(at).isSymbolicLink());
    unlinkSync(at);
    mkdirSync(path.join(at, 'nested'), { recursive: true });
    writeFileSync(path.join(at, 'nested', 'unique.bin'), 'unique output\n');

    const closed = await closeWorktree({ repo: root, ...opened });
    assert.equal(closed.status, 'closed');
    assert.equal(existsSync(opened.path), false);
    assert.equal(readFileSync(path.join(home, 'unique.bin'), 'utf8'), 'unique output\n');
    assert.equal(readFileSync(path.join(home, 'original.bin'), 'utf8'), 'original\n');
  });

  test(`closing keeps both copies on a clash after the shared ${rel} link is replaced by a directory`, async () => {
    const root = repo(`replace-clash-${rel.replace('/', '-')}`);
    const home = path.join(root, rel, 'nested');
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'same.bin'), 'original\n');
    const opened = await openWorktree({ repo: root, owner: 'session-33334444-0' });
    const at = path.join(opened.path, rel);
    assert.ok(lstatSync(at).isSymbolicLink());
    unlinkSync(at);
    mkdirSync(path.join(at, 'nested'), { recursive: true });
    writeFileSync(path.join(at, 'nested', 'unique.bin'), 'unique output\n');
    writeFileSync(path.join(at, 'nested', 'same.bin'), 'worktree copy\n');

    const blocked = await closeWorktree({ repo: root, ...opened });
    assert.deepEqual([blocked.status, blocked.reason, blocked.files], ['blocked', 'ignored_clash', [`${rel}/nested/same.bin`]]);
    assert.equal(readFileSync(path.join(home, 'same.bin'), 'utf8'), 'original\n');
    assert.equal(readFileSync(path.join(at, 'nested', 'same.bin'), 'utf8'), 'worktree copy\n');
    assert.equal(readFileSync(path.join(at, 'nested', 'unique.bin'), 'utf8'), 'unique output\n');
    assert.equal(existsSync(path.join(home, 'unique.bin')), false);
  });
}

test('closing preserves the target of an unchanged shared directory link', async () => {
  const root = repo('unchanged-link');
  const opened = await openWorktree({ repo: root, owner: 'session-55556666-0' });
  const target = realpathSync(path.join(opened.path, 'vm'));
  writeFileSync(path.join(opened.path, 'vm', 'unique.bin'), 'shared output\n');
  assert.equal((await closeWorktree({ repo: root, ...opened })).status, 'closed');
  assert.equal(realpathSync(path.join(root, 'vm')), target);
  assert.equal(readFileSync(path.join(target, 'disk.vhdx'), 'utf8'), 'shared material\n');
  assert.equal(readFileSync(path.join(target, 'unique.bin'), 'utf8'), 'shared output\n');
});

test('closing keeps a shared directory link that was redirected elsewhere', async () => {
  const root = repo('redirected-link');
  const opened = await openWorktree({ repo: root, owner: 'session-99990000-0' });
  const elsewhere = path.join(tmp, 'redirected-output');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'unique.bin'), 'external output\n');
  const at = path.join(opened.path, 'vm');
  unlinkSync(at);
  symlinkSync(elsewhere, at, 'junction');

  const blocked = await closeWorktree({ repo: root, ...opened });
  assert.deepEqual([blocked.status, blocked.reason, blocked.files], ['blocked', 'ignored_clash', ['vm']]);
  assert.equal(realpathSync(at), realpathSync(elsewhere));
  assert.equal(readFileSync(path.join(at, 'unique.bin'), 'utf8'), 'external output\n');
  assert.equal(readFileSync(path.join(root, 'vm', 'disk.vhdx'), 'utf8'), 'shared material\n');
});

test('status and close fail before removal when the branch cannot be queried', async () => {
  const root = repo('query-error');
  const opened = await openWorktree({ repo: root, owner: 'session-77778888-0', maxUntracked: 10 });
  const entry = { repo: root, ...opened, branch: 'missing-branch' };
  await assert.rejects(worktreeStatus(entry), /git rev-list/);
  await assert.rejects(closeWorktree(entry), /git rev-list/);
  assert.equal(existsSync(opened.path), true);
});

test('comparison keys resolve dot segments and directory aliases without losing declared containment', () => {
  const root = repo('canonical-paths');
  const alias = path.join(path.dirname(root), 'alias');
  symlinkSync(root, alias, 'junction');
  const dotted = `${path.dirname(root)}/./${path.basename(root)}`;
  assert.equal(pathKey(dotted), pathKey(root));
  assert.equal(pathKey(`${root}/../repo`), pathKey(root));
  assert.equal(pathKey(alias), pathKey(root));
  if (process.platform === 'win32') assert.equal(pathKey(`/mnt/${path.parse(root).root[0]}`), pathKey(path.parse(root).root));
  assert.equal(pathKey(path.join(alias, 'future', 'result.txt')), pathKey(path.join(root, 'future', 'result.txt')));
  assert.equal(within(alias, root), true);
  assert.equal(relocate(path.join(alias, 'src', 'a.txt'), root, path.join(tmp, 'destination')),
    path.join(tmp, 'destination', 'src', 'a.txt'));
  assert.equal(within(path.join(root, 'vm'), root), true);
});

test('comparison failures propagate instead of silently trusting lexical paths', t => {
  const original = realpathSync.native;
  t.mock.method(realpathSync, 'native', value => {
    if (String(value).includes('unreadable-path')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(value);
  });
  assert.throws(() => pathKey(path.join(tmp, 'unreadable-path')), /denied/);
});

test('comparison keys reject an existing junction with an unreadable target', () => {
  const target = path.join(tmp, 'vanishing-target');
  const alias = path.join(tmp, 'broken-junction');
  mkdirSync(target);
  symlinkSync(target, alias, 'junction');
  rmSync(target, { recursive: true });
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
  assert.throws(() => pathKey(alias), error => error.code === 'ENOENT');
});

test('closing retains detached HEAD commits that the registered branch does not contain', async () => {
  const root = repo('detached-commit');
  const opened = await openWorktree({ repo: root, owner: 'session-11223344-0' });
  git(opened.path, 'checkout', '-q', '--detach');
  writeFileSync(path.join(opened.path, 'src', 'a.txt'), 'detached work\n');
  commitAll(opened.path, 'detached work');
  const head = git(opened.path, 'rev-parse', 'HEAD').trim();
  assert.equal((await closeWorktree({ repo: root, ...opened })).reason, 'not_merged');
  assert.equal(existsSync(opened.path), true);
  assert.equal(git(opened.path, 'rev-parse', 'HEAD').trim(), head);
  git(root, 'merge', '--ff-only', head);
  assert.equal((await closeWorktree({ repo: root, ...opened })).status, 'closed');
});
