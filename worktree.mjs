// 对话 worktree：配置里列出的仓库，新对话的写入单放进本对话专用的 git worktree 执行，核验通过后合并回原分支。
// 合并沿用 dsh-worktree-space 的做法：先试合并，冲突留在 worktree 里解决，原目录有重叠的未提交改动就不合并。
// 被 .gitignore 忽略的资料不进 worktree：忽略的目录用目录联接（junction）接进来，忽略的单个文件用硬链接，都与原目录共用。
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { cp, link, rename, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

const GIT_TIMEOUT_MS = 120_000;

// git -C <dir> ...：返回 { code, stdout, stderr }，不抛错，由调用方判断。
export function gitRun(dir, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: stdout ?? '', stderr: String(stderr || (error && !Number.isInteger(error.code) ? error.message : '')).trim() }));
  });
}

async function git(dir, args, options) {
  const result = await gitRun(dir, args, options);
  if (result.code) throw new Error(`git ${args[0]} 失败：${result.stderr || `退出码 ${result.code}`}`);
  return result.stdout;
}

const entries = (text) => text.split('\0').filter(Boolean);
const inside = (rel, dirs) => dirs.some(dir => rel.startsWith(`${dir}/`));

// 本机没有全局提交身份；仓库自己也没配时，合并提交用一个固定身份，免得 git 拒绝提交。
async function identity(repo) {
  const email = (await gitRun(repo, ['config', 'user.email'])).stdout.trim();
  return email ? [] : ['-c', 'user.name=codex-conductor', '-c', 'user.email=codex-conductor@localhost'];
}

// 统一成 x:/a/b（WSL 的 /mnt/x/a/b 也转过来），只用于比较；大小写在调用处按需忽略。
function normalized(p) {
  let s = String(p).replace(/\\/g, '/');
  const mount = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(s);
  if (mount) s = `${mount[1]}:${mount[2] ?? '/'}`;
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}
export const pathKey = (p) => normalized(p).toLowerCase();
export const within = (p, root) => {
  const a = pathKey(p);
  const r = pathKey(root);
  return a === r || a.startsWith(r.endsWith('/') ? r : `${r}/`);
};

export function repoFor(repos, paths) {
  return repos.find(repo => paths.some(p => typeof p === 'string' && p && within(p, repo)));
}

// 把原仓库下的路径换到 worktree 下，其余路径原样返回。
export function relocate(p, repo, worktree) {
  if (typeof p !== 'string' || !within(p, repo)) return p;
  const rest = normalized(p).slice(normalized(repo).length).split('/').filter(Boolean);
  return path.join(worktree, ...rest);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toMount = (p) => {
  const s = normalized(p);
  return /^[A-Za-z]:/.test(s) ? `/mnt/${s[0].toLowerCase()}${s.slice(2)}` : s;
};

// 任务书里写的原仓库路径（反斜杠、正斜杠、WSL 三种写法）换成 worktree 路径；后面紧跟路径名字符的不算（opsec2 不是 opsec）。
export function relocateText(text, repo, worktree) {
  if (typeof text !== 'string' || !text) return text;
  const forward = normalized(repo);
  const variants = [
    [forward.replace(/\//g, '\\'), normalized(worktree).replace(/\//g, '\\')],
    [forward, normalized(worktree)],
    [toMount(repo), toMount(worktree)],
  ];
  let out = text;
  for (const [from, to] of variants) {
    out = out.replace(new RegExp(`${escape(from)}(?![^\\s\\\\/"'\`)\\]}>,;:。，、；：）】」』])`, 'gi'), to);
  }
  return out;
}

export function ownerTag(owner) {
  const match = /session-([0-9a-f]{8})/i.exec(String(owner));
  return match ? match[1].toLowerCase() : String(owner).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 16).toLowerCase() || 'conversation';
}

// 忽略的目录建联接、忽略的单个文件建硬链接，与原目录共用，不复制。返回建好的联接（相对路径），收尾时据此拆除。
async function linkIgnored(top, worktree) {
  const all = entries(await git(top, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  // 只因文件规则（如 *.bin）被忽略的目录，git 会把目录和里面的文件都列出来；整个目录接成联接，里面的不再单独硬链接。
  const dirs = all.filter(entry => entry.endsWith('/')).map(entry => entry.slice(0, -1));
  const listed = all.filter(entry => !inside(entry.replace(/\/$/, ''), dirs));
  const links = [];
  let hardlinks = 0;
  const skipped = [];
  const todo = listed.map(entry => ({ entry, rel: entry.replace(/\/$/, '') }))
    .map(item => ({ ...item, target: path.join(top, ...item.rel.split('/')), at: path.join(worktree, ...item.rel.split('/')) }))
    .filter(item => !existsSync(item.at));
  for (const dir of new Set(todo.map(item => path.dirname(item.at)))) mkdirSync(dir, { recursive: true });
  // opsec 有 6.4 万个零散的忽略文件；32 路并发建硬链接，1 万个约 0.6 秒（2026-11-25 实测）。
  let next = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < todo.length) {
      const { entry, rel, target, at } = todo[next++];
      try {
        if (entry.endsWith('/')) {
          await symlink(target, at, 'junction');
          links.push(rel);
        } else {
          await link(target, at);
          hardlinks++;
        }
      } catch (error) {
        skipped.push(`${rel}（${error.code ?? error.message}）`);
      }
    }
  }));
  links.sort();
  return { links, hardlinks, skipped: skipped.length, skipped_examples: skipped.slice(0, 5) };
}

// 为一个对话开 worktree。原目录不满足条件时返回 { shared: 原因 }，本对话就留在原目录工作。
export async function openWorktree({ repo, root, owner, maxUntracked = 200 }) {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  // 比较真实路径：Windows 上同一目录可能写成 8.3 短名（C:\Users\RUNNER~1）或长名，字符串对不上。
  const real = (p) => { try { return pathKey(realpathSync.native(p)); } catch { return pathKey(p); } };
  if (real(top) !== real(repo)) return { shared: `${repo} 不是 git 仓库的根目录（根目录是 ${top}）` };
  const branch = (await gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (!branch) return { shared: '原目录处于分离 HEAD，没有当前分支可以合并回去' };
  const untracked = entries(await git(repo, ['ls-files', '-z', '--others', '--exclude-standard'], { timeout: 600_000 }));
  if (untracked.length > maxUntracked) {
    return { shared: `原目录有 ${untracked.length} 个文件既没纳入 git 也没被 .gitignore 忽略，worktree 里看不到它们；` +
      '补全 .gitignore 或提交后，新对话才会用 worktree' };
  }
  const tag = ownerTag(owner);
  // 以下沿用配置里的写法（已确认与根目录是同一处），worktree 路径才和派单里的 cwd、scope 对得上。
  const parent = path.join(root || path.join(path.dirname(repo), 'worktree-space'), path.basename(repo));
  let worktree = path.join(parent, tag);
  let name = `conv/${tag}`;
  for (let n = 2; existsSync(worktree) || (await gitRun(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0; n++) {
    worktree = path.join(parent, `${tag}-${n}`);
    name = `conv/${tag}-${n}`;
  }
  mkdirSync(parent, { recursive: true });
  await git(repo, ['worktree', 'add', '-b', name, worktree, 'HEAD'], { timeout: 600_000 });
  const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  return { path: worktree, branch: name, base_branch: branch, base, ...(await linkIgnored(repo, worktree)) };
}

// 合并回原分支。返回 status：merged | nothing | conflict | blocked | error。
export async function mergeWorktree(entry) {
  const { repo, path: worktree, branch, base_branch: target } = entry;
  if (!existsSync(worktree)) return { status: 'error', message: `worktree ${worktree} 不存在` };
  if ((await gitRun(worktree, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code === 0) {
    const unmerged = entries((await gitRun(worktree, ['diff', '--name-only', '-z', '--diff-filter=U'])).stdout);
    return { status: 'conflict', pending: true, files: unmerged.slice(0, 10), count: unmerged.length };
  }
  const dirty = entries(await git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all']));
  if (dirty.length) return { status: 'blocked', reason: 'worktree_dirty', files: dirty.slice(0, 10).map(e => e.slice(3)), count: dirty.length };
  const current = (await gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (current !== target) return { status: 'blocked', reason: 'target_not_checked_out', current: current || '（分离 HEAD）', target };
  const ahead = Number((await git(repo, ['rev-list', '--count', `${target}..${branch}`])).trim());
  if (!ahead) {
    await gitRun(worktree, ['merge', '--ff-only', '--quiet', target]);
    return { status: 'nothing' };
  }
  // 试合并：不动任何工作区；有冲突就把它放进本对话的 worktree 里解决。
  const trial = await gitRun(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, branch]);
  if (trial.code === 1) {
    const files = trial.stdout.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
    await gitRun(worktree, [...await identity(repo), 'merge', '--no-ff', '--no-commit', target]);
    return { status: 'conflict', files: files.slice(0, 10), count: files.length };
  }
  if (trial.code) return { status: 'error', message: `试合并失败：${trial.stderr}` };
  if ((await gitRun(repo, ['diff', '--cached', '--quiet'])).code) return { status: 'blocked', reason: 'staged_changes' };
  const base = (await git(repo, ['merge-base', target, branch])).trim();
  const incoming = new Set(entries(await git(repo, ['diff', '--name-only', '-z', base, branch])));
  const local = entries(await git(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], { timeout: 600_000 }))
    .map(e => e.slice(3)).filter(p => incoming.has(p));
  if (local.length) return { status: 'blocked', reason: 'checkout_dirty_overlap', files: local.slice(0, 10), count: local.length };
  const merged = await gitRun(repo, [...await identity(repo), 'merge', '--no-ff', '--no-edit', '-m', `合并对话 worktree ${branch}（${ahead} 个提交）`, branch]);
  if (merged.code) {
    if ((await gitRun(repo, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code === 0) await gitRun(repo, ['merge', '--abort']);
    return { status: 'error', message: `合并没有完成，已撤回：${merged.stderr || merged.stdout.trim()}` };
  }
  const commit = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  // 合并后本对话的分支是目标分支的祖先，快进到最新，之后的单也能看到别的对话合并进来的改动。
  const synced = (await gitRun(worktree, ['merge', '--ff-only', '--quiet', target])).code === 0;
  return { status: 'merged', commit, commits: ahead, synced };
}

export async function worktreeStatus(entry) {
  if (!existsSync(entry.path)) return { exists: false };
  const dirty = entries((await gitRun(entry.path, ['status', '--porcelain', '-z', '--untracked-files=all'])).stdout).length;
  const ahead = Number((await gitRun(entry.repo, ['rev-list', '--count', `${entry.base_branch}..${entry.branch}`])).stdout.trim()) || 0;
  const merging = (await gitRun(entry.path, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code === 0;
  return { exists: true, dirty, ahead, merging };
}

// 收尾：先拆联接（rmdir 对联接只删链接本身；对真目录只会删空目录），再 git worktree remove（不加 --force），最后 branch -d。
// 不跑 git worktree prune：在 Windows 上 prune 会把 WSL 那边建的 worktree 登记一起删掉。
// git worktree remove 会把 worktree 里被忽略的文件一起删掉（实测）。对话在 worktree 里新产出的忽略文件（扫描结果、日志等）
// 收尾前移回原目录同一位置；原目录那里已有另一份时不覆盖，整个收尾停下来交给用户。
async function keepIgnored(entry) {
  const listed = entries(await git(entry.path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { timeout: 600_000 }));
  const linked = new Set(entry.links ?? []);
  const moves = [];
  const clashes = [];
  const all = listed.map(item => item.replace(/\/$/, '')).sort();
  const skip = [...linked];
  for (const rel of all) {
    // 联接里的东西本来就在原目录；整个移走的目录，里面的不再单独处理。
    if (linked.has(rel) || inside(rel, skip)) continue;
    const at = path.join(entry.path, ...rel.split('/'));
    const home = path.join(entry.repo, ...rel.split('/'));
    let mine;
    try { mine = lstatSync(at, { bigint: true }); } catch { continue; }
    if (mine.isSymbolicLink()) continue;
    let theirs;
    try { theirs = lstatSync(home, { bigint: true }); } catch { moves.push({ rel, at, home }); skip.push(rel); continue; }
    // 开 worktree 时建的硬链接没被替换过，原目录就是同一份。
    if (mine.isFile() && theirs.isFile() && mine.ino === theirs.ino && mine.dev === theirs.dev) continue;
    // 两边都是目录、git 也列出了里面的文件时，逐个文件处理；没列出里面的就不知道有什么，按冲突处理。
    if (mine.isDirectory() && theirs.isDirectory() && all.some(other => other.startsWith(`${rel}/`))) continue;
    clashes.push(rel);
  }
  if (clashes.length) return { clashes };
  for (const { at, home } of moves) {
    mkdirSync(path.dirname(home), { recursive: true });
    await rename(at, home).catch(async (error) => {
      if (error.code !== 'EXDEV') throw error;
      await cp(at, home, { recursive: true, errorOnExist: true, force: false });
      await rm(at, { recursive: true, force: true });
    });
  }
  return { moved: moves.map(item => item.rel) };
}

export async function closeWorktree(entry) {
  const state = await worktreeStatus(entry);
  if (state.exists && (state.dirty || state.merging)) return { status: 'blocked', reason: 'worktree_dirty', ...state };
  if (state.exists && state.ahead) return { status: 'blocked', reason: 'not_merged', ...state };
  let kept = {};
  if (state.exists) {
    const { clashes, moved } = await keepIgnored(entry);
    if (clashes) {
      return { status: 'blocked', reason: 'ignored_clash', count: clashes.length, files: clashes.slice(0, 20),
        note: '这些被忽略的文件 worktree 里和原目录里各有一份且不是同一份，收尾会删掉 worktree 那份，所以没有收尾；请用户决定留哪份后再 close。' };
    }
    if (moved.length) kept = { moved_back: moved.length, moved_examples: moved.slice(0, 10) };
    for (const rel of entry.links ?? []) {
      const at = path.join(entry.path, ...rel.split('/'));
      let info;
      try { info = lstatSync(at); } catch { continue; }
      if (!info.isSymbolicLink()) continue;
      await unlink(at).catch(() => rmdir(at));
    }
    const removed = await gitRun(entry.repo, ['worktree', 'remove', entry.path]);
    if (removed.code) return { status: 'error', message: `git worktree remove 失败：${removed.stderr}` };
  }
  const deleted = await gitRun(entry.repo, ['branch', '-d', entry.branch]);
  return { status: 'closed', ...kept, branch_deleted: deleted.code === 0, ...(deleted.code ? { branch_note: deleted.stderr } : {}) };
}
