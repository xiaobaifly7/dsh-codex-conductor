# Conductor Windows 原生切换

适用于本分支（主线 0.9.140 之上的 `runnerMode: native`）。`runnerMode` 不配或配成 `wsl` 时行为与主线相同，不需要任何切换步骤。

## 前置条件

- 官方便携 PowerShell 7.7.0 放在 `C:\Program Files\PowerShell\7`，用完整路径加 `-NoProfile` 返回 `7.7.0`（2026-11-22 复核仍满足）。不要依赖 PATH 上的 Store 版 `pwsh`：Codex 沙箱的受限令牌执行不了 WindowsApps 下的别名。
- Windows 原生 Python 3.11 以上（`C:\Python314\python.exe`）和原生 Codex CLI（`codex.exe` 0.170.0 的 vendor 路径）。
- 三个绝对路径的私有目录 `stateDir`、`runnerHome`、`codexHome`。它们不能等于或位于 `%USERPROFILE%\.codex`、`%USERPROFILE%\.local\state\codex-runner`、`%LOCALAPPDATA%\dsh-codex-conductor`、`%LOCALAPPDATA%\codex-runner` 之下（按大小写、分隔符和 junction 解析后比较），否则插件拒绝加载。在私有 `codexHome` 里把 `config\codex.native.toml` 装成 `config.toml`，Windows 沙箱为 `elevated`。三个目录对 `CodexSandboxUsers`、`Authenticated Users` 和 Codex 能力 SID 都不能有写权限，插件不检查这一点：放在只有 SYSTEM、Administrators 和当前用户可写的位置（如 `D:\software\` 下），或用 `icacls <目录> /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"` 断开继承。否则沙箱里的命令可能改写私有 `config.toml`，影响之后的每个任务。`codexBin` 配成 `codex.exe`；配成 `.cmd`/`.bat` 时任务以 `bad_arguments` 拒绝。
- Harness 宿主进程能提供 `MAGPIE_GATEWAY_KEY`，路由用 Windows 上 Magpie 的 `http://127.0.0.1:3425/v1`，不经 WSL 的 3426 转发。
- 启用 Gemini 时，`gemini.command` 指向 Windows 的 `agy.exe`。原生模式下 agy 仍由随包的 `agy_process.ps1`（系统自带 Windows PowerShell 5.1）启动，它的 Job 嵌套在 runner 的 Job 里。

## 切换

1. 等当前任务全部结束，暂停新派单。把通过回归的运行时部署到新的 `dsh-codex-conductor-runtime-<版本>` 目录。
2. 复制规划端状态：原生模式的 `stateDir` 不能沿用宿主的 `%LOCALAPPDATA%\dsh-codex-conductor`（ASA 下为 `D:\software\DeepSeekHarness-ASA\data\local\dsh-codex-conductor`）。插件未加载时把该目录的内容复制到新的 `stateDir`，至少包括 `planner-prompt.md`、`executor-prompt.md`、`handover*.json(l)` 与 `handovers\`、`auto-handover.json`、`closeout-*.json`、`accept-open-evidence-since.json`、`auto-verify-since.json`、`accepted-open.json`、`owner-decisions.json`、`parked-reviews.json`、`gemini-history.jsonl`、`gemini-drafts\`、`autoresume-*.json`、`history-status.json`。不复制时交接链、结案起算时间、规划要求和面板历史都从空白开始。原目录保留不动。
3. 在 ASA 的 `cordis.patch.yml` 里改现有的 conductor 条目，不要新增第二个条目：
   - `id`、`name` 换成新运行时目录和同一个新 UUID（与平常发版相同）。
   - 删除 `distro`，以及 WSL 的 `codexHome: /home/xiaobai/.codex`、`runnerHome: /home/xiaobai/.local/state/codex-runner`。
   - 新增 `runnerMode: native`、`python: C:/Python314/python.exe`、`codexBin: <原生 codex.exe 绝对路径>`、`pwshDir: C:/Program Files/PowerShell/7`，以及三个私有目录，例如 `stateDir: D:/software/DeepSeekHarness-ASA/data/local/dsh-codex-conductor-native`、`runnerHome: D:/software/DeepSeekHarness-ASA/data/local/codex-runner-native`、`codexHome: D:/software/DeepSeekHarness-ASA/data/local/codex-runner-native/codex-home`。
   - `codexRoute.baseUrl` 改为 `http://127.0.0.1:3425/v1`。
   - 其余键（模型、档位、`serviceTier`、`allowCommands`、`workspaces`、`gemini`、`defaultEngine`、`crossEngineVerify`、`geminiFallback`、交接、`autoResume`、`allowHostAccess`/`defaultHostAccess` 等）保持线上值。
   - `config\cordis.patch.yml` 是测试脚本用的候选，目录都在 `D:\AI-Workspace\win-migration\state` 下，不是线上条目。
4. 按 ASA 的正式配置流程加载，看 `stateDir\loaded.json` 的 version/revision。
5. 先执行 `codex_runtime` 的 `doctor`，确认 `sandbox` 项 `ok: true`、显示 `7.7.0`、路由可达。首次 doctor 会初始化私有 home 的 elevated 沙箱。再做只读、写入、独立复核、同线程续接、超时、取消（含孤儿）、Gemini 只读与取消回归，确认状态和会话只出现在三个私有目录里，然后恢复无人值守派单。

## 回退

1. 暂停新派单，让已启动的原生任务结束；要取消时用原生插件取消并确认回执。
2. 把 conductor 条目恢复为原来的 WSL 写法（`distro`、WSL 的 `codexHome`/`runnerHome`、3426 路由，删掉 `runnerMode` 或改为 `wsl`，删掉 `python`/`codexBin`/`pwshDir`/`stateDir`），`id`/`name` 指回原运行时，按正式流程加载，跑一个最小只读任务确认。
3. 原生期间产生的规划端状态只在新的 `stateDir` 里。需要保留时，回退前把要延续的文件（同切换第 2 步的清单）复制回原目录。原生目录保留供排查。
4. 如果应用过 `config\pwsh.patch.yml`，先恢复对应的桌面配置；确认没有其他调用方后，删除 `C:\Program Files\PowerShell\7` 即可回退便携 PowerShell。

## 已知限制

- `unelevated` 沙箱实测可用，但网络隔离较弱；无人值守用 `elevated`。
- 原生模式拒绝完整用户配置 `use_user_config=true`（插件、Python 入口和 `_worker` 三处都在写状态前拒绝）。
- 任务记录不互通：切换前的 WSL 任务留在 WSL 的 `~/.local/state/codex-runner`，原生插件查不到，`codex_status`/`codex_continue`/`codex_review` 对这些 job_id 报未知任务；旧 WSL 线程只能回退到 WSL 后续接。规划端状态要按切换第 2 步复制。
- 线上配置 `defaultHostAccess: true`：原生模式下 `host_access` 任务以 `danger-full-access` 直接在 Windows 上运行，没有 WSL 这一层，等于对整台机器有完全权限。这与原先“经 WSL interop 访问 Windows”的风险面不同，切换前确认是否保留。
- 没有 Job 记录的 Windows 任务（原生分支早期版本启动、且切换后仍在的任务；从 WSL 切过来时不存在）取消时只能清理可核验的进程树；无法排除先前脱离进程树的孤儿时回执为 `process_cleanup_failed`。其中某个子进程因拒绝访问打不开时，它的后代不会被尝试，兄弟进程照常清理（`stop_legacy_windows_children`）。
- 成功收尾时，worker 若恰好在“已解除 Job 自动清理、尚未发布成功回执”之间崩溃，后台进程会存活，任务报为不可自动重试的 `process_cleanup_failed`，需人工确认残留（`write_task_result`、`worker_finalization_failure`）。
- 只有 Codex 任务在成功后保留后台进程；Gemini 任务按主线语义在收尾时确认 agy Job 已停止并终止 runner 的 Job（agy 自己的 Job 带 KILL_ON_JOB_CLOSE，主线 WSL 模式下同样不保留）。
- 同权限的本机进程可额外持有默认 DACL 的命名 Job 句柄，或在私有目录校验后把目录换成 junction。这里假定同一用户下没有恶意协作进程。
- Windows `doctor` 的 `--version` 检查：10 秒只限首次等待；挂起后 Job 清理、bootstrap 退出、目录清理各有独立的上限，总耗时有界但可能超过 10 秒（`doctor`、`run_windows_diagnostic`、`stop_attempt`、`windows_doctor_scratch`）。
- 上游基线已有、移植后仍在：普通 UNC 路径在共享根边界含 `..` 时工作区护栏有缺口（`guard.mjs` 的 `normPath`/`inWorkspace`）；查询 abort 可能先于解析同一输出块中的最终回执（`index.mjs` 的 `runProcess`）。
- 主线已有、与原生无关但会影响原生使用：`--gemini-fallback-check` 把任务目录的每一级父目录下的 `.codex\config.toml` 当成项目配置。任务目录在 `C:\Users\apple` 之下时，用户自己的 `C:\Users\apple\.codex\config.toml`（含 MCP 服务器）会让 `fallback_safe` 恒为 false，Codex 失败后不会自动交给 Gemini。WSL 模式下 `/mnt/c/Users/apple/...` 同样如此。
- 测试证据的边界：超时边界断言针对的函数在原生第八轮后未改动；doctor 的 10 秒参数测试替换了整个诊断函数；真实版本检查测试未覆盖版本检查自身挂起和 `.cmd` shim。`test_follow_status_emits_progress_before_the_final_result` 把等待函数和时钟全部桩化，不能证明 100 ms 轮询；回执延迟测试的 500 ms 单次阈值对系统负载敏感。主线的 Gemini 运行类测试（`uses the native Linux fake agy`）在 Windows 上跳过，原生 Gemini 路径只有桩端到端证据。`runner\bench-live.test.mjs` 依赖 `D:\AI-Workspace\win-migration` 的目录布局，不在 `npm test` 里。
