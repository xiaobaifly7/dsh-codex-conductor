# Conductor Windows 原生切换

## 前置条件

- **已满足**。官方便携 PowerShell 已放在 `C:\Program Files\PowerShell\7`，实测完整路径加 `-NoProfile` 返回 `7.7.0`。候选的 `pwshDir` 与 `pwsh.patch.yml` 均使用该固定位置，原生端到端脚本也从候选读取路径。无需加入 PATH，Windows Store 别名在受限令牌下可能无法执行。
- 准备原生 Python 和 Codex CLI，以及三个绝对私有目录 `stateDir`、`runnerHome`、`codexHome`。在私有 `codexHome` 安装 `codex.native.toml` 为 `config.toml`。Windows 沙箱配置为 `elevated`。
- 在 Harness 宿主进程提供现有的 `MAGPIE_GATEWAY_KEY`，用 Windows Magpie `http://127.0.0.1:3425/v1`。保留旧插件配置、账本和会话，等待当前任务完成后切换。

## 切换

1. 将通过回归的运行时部署到独立目录。按 `cordis.patch.yml` 的候选差异更新 ASA 的 conductor 条目，指定新的入口、`runnerMode: native`、本机可执行文件、私有目录和直连路由。保留生产模型、档位、交接与 autoAnswer 配置。按 ASA 的正式配置流程加载。
2. 先执行 `codex_runtime` 的 `doctor` 动作，确认 `sandbox` 项 `ok: true`、显示 `7.7.0` 且路由可达。再做只读、写入、独立复核、同线程续接、超时和孤儿取消回归。确认本次状态和会话只出现在三个私有目录中，再恢复无人值守派单。

## 回退

1. 暂停新派单，让已启动的原生任务结束。需要取消时，先用原生插件取消并确认回执。
2. 恢复原 ASA conductor 条目和原运行时，恢复 `runnerMode: wsl` 或原先的缺省值，以及原 WSL 路由、路径与状态配置。按 ASA 的正式配置流程加载，执行一次最小只读任务确认回退。原生目录保留供排查。
3. 如果已应用 `pwsh.patch.yml`，先恢复对应的桌面配置。确认其他调用方已停止使用该固定路径，再删除此次解压的 `C:\Program Files\PowerShell\7` 目录即可回退便携 PowerShell。

## 已知限制

- `unelevated` 已通过沙箱外执行验证，网络隔离较弱。无人值守使用候选里的 `elevated`。
- Windows 与 WSL 的会话各自保留。旧 WSL 会话继续由 WSL 路径续接。原生模式拒绝完整用户配置 `use_user_config`。
- 没有 Windows Job 记录的旧任务只能清理可核验的进程树。先前脱离进程树的孤儿无法确认时，取消返回 `process_cleanup_failed`。
- 如果 worker 恰好在解除 Job 自动清理后、发布成功回执前崩溃，仍在运行的后台进程会继续运行。runner 返回不可自动重试的 `process_cleanup_failed`，需人工确认残留（`runner/codex_runner.py:2222`、`runner/codex_runner.py:3315`）。
- 普通 UNC 路径在共享根边界含 `..` 时有工作区护栏缺口。查询 abort 也可能先于解析同一输出块中的最终回执。这两项来自上游基线，本次迁移保留原有行为。
- 同权限的本机进程可额外持有默认 DACL 的命名 Job 句柄，或在私有目录校验后将目录替换为 junction。此处的边界假定同一用户下没有恶意协作进程。
- Windows `doctor` 的 `--version` 检查中，10 秒仅限制首次等待。挂起后，Job 清理、bootstrap 退出和目录清理各有独立的等待上限，因此总耗时有界，但可能超过 10 秒（`runner/codex_runner.py:3462`、`runner/codex_runner.py:232`、`runner/codex_runner.py:295`、`runner/codex_runner.py:3441`）。
- 取消切换前启动、且没有 Job 记录的旧任务时，如果某个子进程因权限拒绝而无法打开，runner 会跳过它的后代并继续清理其他兄弟进程。回执为 `process_cleanup_failed`，需人工确认残留（`runner/codex_runner.py:329`）。
- 测试证据的边界。超时边界断言针对第八轮未改动的函数（`runner/codex_runner.py:797`、`runner/test_codex_runner.py:5086`）。`doctor` 的 10 秒参数断言替换了整个诊断函数（`runner/test_codex_runner.py:5029`、`runner/test_codex_runner.py:5048`）。真实进程版本检查测试未覆盖版本检查自身挂起或通过 `.cmd` shim 启动（`runner/test_codex_runner.py:5171`）。这些证据不足以作为相应行为的运行验收。
