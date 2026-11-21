import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.mjs';

if (process.platform !== 'win32') throw Error('The WSL migration test requires a Windows host');
if (!process.env.MAGPIE_GATEWAY_KEY) throw Error('MAGPIE_GATEWAY_KEY must be available in the Windows test process');

const distro = 'Ubuntu-24.04';
const baseUrl = 'http://127.0.0.1:3426/v1';
const config = readFileSync(new URL('../config/codex.native.toml', import.meta.url), 'utf8')
  .split('[windows]')[0].replace('http://127.0.0.1:3425/v1', baseUrl);
const setup = spawnSync('wsl.exe', ['-d', distro, '-e', 'sh', '-eu', '-c', `
  root=$(mktemp -d /tmp/codex-runner-winmig.XXXXXXXX)
  root=$(realpath "$root")
  for protected in "$HOME/.codex" "$HOME/.local/state/codex-runner"; do
    protected=$(realpath -m "$protected")
    for private in "$root/runner" "$root/codex-home" "$root/work"; do
      case "$private/" in "$protected/"*) exit 1 ;; esac
    done
  done
  printf '%s\\n' "$root"
  mkdir -m 700 "$root/runner" "$root/codex-home" "$root/work"
  cat > "$root/codex-home/config.toml"
`], { env: { ...process.env, WSL_UTF8: '1' }, input: config, encoding: 'utf8', windowsHide: true });
if (setup.status !== 0) throw Error(setup.error?.message ?? (`WSL preparation failed: ${setup.stderr || setup.stdout}`));
const root = setup.stdout.trim();
if (!/^\/tmp\/codex-runner-winmig\.[A-Za-z0-9]+$/.test(root)) throw Error('WSL did not return a private test root');

const work = root + '/work';
const print = (value) => process.stdout.write(JSON.stringify(value) + '\n', 'utf8');
const tools = {};
const ctx = { tools: { register(tool) { tools[tool.name] = tool; }, guard() {} }, on() {} };
const exec = { agent: { id: 'windows-migration-wsl', session: { header: { cwd: work }, log: [] } } };
const stateDir = mkdtempSync(fileURLToPath(new URL('../../state/wsl-conductor-', import.meta.url)));
process.env.WSLENV = [...(process.env.WSLENV ?? '').split(':').filter(
  name => name && name.split('/')[0] !== 'MAGPIE_GATEWAY_KEY'), 'MAGPIE_GATEWAY_KEY/u'].join(':');
apply(ctx, {
  runnerMode: 'wsl', distro, runnerHome: root + '/runner', codexHome: root + '/codex-home', stateDir,
  codexRoute: { provider: 'magpie', baseUrl }, workspaces: [work], model: 'codex/gpt-6.1-sol', readOnlyEffort: 'medium',
  autoResume: { enabled: false }, autoVerify: 'off', closeoutGuard: false, retries: 0, timeoutSeconds: 75,
});
print({ scenario: 'wsl', distro, root, stateDir });
const first = await tools.codex_run.execute({
  task: '只读，不调用工具。在最终报告摘要中逐字回显「回退验证」。',
  acceptance: ['原样回显回退验证'], write: false, wait_seconds: 0,
}, exec);
const result = first.status === 'running'
  ? await tools.codex_status.execute({ job_id: first.job_id, wait_seconds: 95 }, exec)
  : first;
print({ job_id: result.job_id, status: result.status, sandbox: result.sandbox,
  report: result.report, error_kind: result.error_kind, error: result.error });
if (result.status !== 'completed' || result.sandbox !== 'read-only' || !result.report?.summary?.includes('回退验证') ||
    result.report.criteria?.length !== 1 || result.report.criteria[0].status !== 'met') process.exitCode = 1;
