# dsh-codex-conductor

DeepSeek Harness（DSH）插件：DSH 里的 agent 负责规划和验收，编码任务交给 WSL 里的 Codex CLI 执行。

[English](#english)

## 功能

**派活工具**

| 工具 | 作用 |
| --- | --- |
| `codex_run` | 把任务交给 WSL 里的 Codex 并等待结果。必填 `task` 和 `acceptance`（1–20 条验收标准）；可选 `write`、`host_access`（需开启 `allowHostAccess`）、`scope`、`cwd`、`resume`、`use_user_config`、`effort`、`wait_seconds` |
| `codex_status` | 查询或继续等待任务；仍在执行时返回距 Codex 上次活动的秒数和它最近的动作。已登记为 DSH 后台任务的不必调用 |
| `codex_cancel` | 取消任务，在 WSL 内结束 Codex 的整个进程树 |

- 交接时自动附加执行约束：不扩大范围；只改 `scope` 里的路径；任务与现状不符或验收标准互相冲突时不自行取舍，标为 `blocked` 并说明；不为通过验收去改验收脚本或判据。
- 要求 Codex 按 [`report.schema.json`](report.schema.json) 逐条回报（met / not_met / blocked、证据、改动文件、偏离计划、未解决）。结果里会标出它自报未满足或受阻的条目、偏离计划的地方，以及超出 `scope` 的改动。最终答复的版式由插件固定为这份 JSON：`task` / `acceptance` 里对版式的要求（如单独的末行结论行）写进 `summary` 就算满足，Codex 不会因此标 `blocked`；工具说明也让 agent 不要再规定这类版式。
- Codex 的沙箱（只读和 `workspace-write` 都是）挡住了 WSL interop，Codex 在沙箱里启动不了 Windows 程序（`pwsh.exe`、Hyper-V 命令等）。默认情况下需要 Windows 运行时的检查不要写进 `task` / `acceptance`，由 agent 自己跑。
- 主机访问（默认关闭）：配置里开启 `allowHostAccess` 后，`codex_run` 才多出 `host_access` 参数，工具说明改为让 agent 在任务需要 Windows 程序、Hyper-V 或连接 Hyper-V 虚拟机时传 `host_access=true`。这时不管 `write`，Codex 都以 `danger-full-access` 运行：没有沙箱，对整台机器有完全访问权限，可以通过 WSL interop 启动 Windows 程序、使用 Windows 那边的网络。交接提示里多一条约束：只做任务需要的事，任务没点名的虚拟机、文件和网络设置不删除、不停止、不重建、不改配置。`write` 仍决定能不能改动，但 `write` 不为 `true` 时的只读只靠提示约束（再加一条：只读调查，不改文件，也不改虚拟机、网络或系统状态），没有沙箱拦着。runner 把这类任务都当可写任务：拿同目录写锁、做快照、不用 `--ephemeral`、返回可续跑的 `thread_id`。改动快照只覆盖任务目录，Codex 在任务目录以外（其他目录、Windows 文件、虚拟机里）做的改动不会出现在快照结果里。没开启 `allowHostAccess` 时传 `host_access=true` 会直接报错。
- 默认（不传 `use_user_config`）按服务器逐个关掉 Codex 的 MCP：runner 读 `$CODEX_HOME/config.toml`（没设 `CODEX_HOME` 时读 `~/.codex/config.toml`），对 `[mcp_servers]` 下的每一项传 `-c mcp_servers.<名字>.enabled=false`，并关掉 hooks。Codex 插件自带的 MCP 不在 `config.toml` 里，管不到；名字里带 `.` 的服务器也关不掉（Codex 按 `.` 切分 `-c` 的键）。文件不存在或解析不了时不加参数。`use_user_config=true` 时照常加载这些 MCP 和 hooks。
- 只读任务（`write` 不为 `true`，也没传 `host_access=true`）以 `--ephemeral` 运行、不留会话记录，返回的 `thread_id` 为 `null`，下一步提示改为重新派一个写全背景的完整任务，而不是 `resume`。只读任务若是 `resume` 了某个写任务的线程，则返回那个线程的 id，仍可续跑。
- 续跑（`resume`）时 Codex 报的用量是整个线程的累计值，结果里在 `usage` 旁加 `usage_scope: "thread_total"`（不换算成本次增量）；只读任务重试时放弃续跑、从头开始，这时的用量只算本次，不加这个标记。
- 任务目录：传了 `cwd` 就用它；否则会话工作区落在某个带 `cwd` 的 `workspaces` 条目里时，用该条目的 `cwd`（有多条时取路径最长的那条）；再否则用会话工作区。只在 `task` 里写目录不会切换任务目录。
- 可写任务前后对任务目录做快照，列出新增、修改、删除的文件（`files_changed_source` 为 `snapshot`）。快照也会记下同时段其他进程写的文件（如定期日志），所以“超出 scope”的清单里可能有它们；提示里会说明：不在 Codex 自报 `files_changed` 里、明显来自其他进程的文件只需一句说明，不算 Codex 越界，也不用请用户决定。目录大到 20 秒内扫不完时，runner 把它记在 `runnerHome` 的 `snapshot-too-big.json` 里，7 天内同一目录不再整树扫描：给了 `scope` 就只快照 `scope` 里的路径，`scope` 之外的改动取 Codex 自报的记录（`scope_snapshot+codex_events`）；没给 `scope` 就只用 Codex 自报的改动（`codex_events`）。Codex 自报只覆盖它自己的改文件工具，不含 shell 写入。
- 任务在 WSL 后台运行，DSH 这边断开等待不影响任务；重试、超时、断线检测和同目录写锁由随包的 [`runner/codex_runner.py`](runner/codex_runner.py) 处理。
- 任务表与结束通知：agent 的 preset 提供 DSH 后台任务（jobs）服务时，`codex_run` 一启动 Codex 就把它登记为一个后台任务（`Codex <job_id>`），DSH 任务表里立刻出现这一行，进度行约每 20 秒刷新一次，显示距 Codex 上次活动的秒数和它最近的动作。`codex_run` 经任务表等到 `wait_seconds`：这之前结束就直接返回结果，不另发通知；到点仍在执行时任务留在后台继续，结果里带 `background_job_id`，Codex 结束后 DSH 发一条只带一行摘要的任务通知，agent 用 `job_output` 读取与工具结果相同的完整文字（含逐条汇报和下一步）后继续，不用轮询。
- 一行摘要：任务结束后，任务表那一行和结果的第一行都以一行摘要开头，如 `completed · 12 met / 1 blocked · 3 files · 148 s`（状态、按 met / not_met / blocked 计的验收条数、改动文件数、用时；只读任务没有文件数），失败或取消时是 `failed · timeout · 30 s` 这样的状态、错误类型和用时；结果第一行在摘要后照旧带 `job_id` 和 `thread_id`。结束的行留在任务表里，摘要就在那里看。
- 同一个 runner 任务只登记一个后台任务（按 DSH 任务表判断，插件重载后也不重复）；对已登记的任务调用 `codex_status` 或 `codex_cancel` 会经 DSH 任务表等待，结果不会再作为通知重复送一次。等待中途停止工具调用时，插件结束这个后台任务（同时在 WSL 里取消 Codex），等它结算完再返回，之后不会再冒出一条结束通知。归档会话时，DSH 可能结束其中仍在运行的后台任务，Codex 任务随之取消。后台等待本身出错时送回 `monitor_failed`，提示 Codex 任务可能仍在运行、先用 `codex_status` 查询。没有 jobs 服务、登记失败或没有 agent 时，任务表里没有这一行，`codex_run` 直接等 runner 到 `wait_seconds`，之后照旧用 `codex_status` 轮询。

**护栏（按工作区开启）**

会话工作区在 `workspaces` 里时：

- 拒绝直接写文件或执行任意代码的工具：`write`、`edit`、`pwsh`、`run_code`、`subagent_codex`，以及 `wsl-write`、`wsl-edit`、`wsl-term`、`wsl-bootstrap`、`actions_run`、`actions_configure`；MCP 工具按动作名拒绝（`write`、`edit`、`replace`、`insert`、`delete`、`execute` 等）。
- shell 工具（`wsl`、`bash`、`ops_bash`）只放行只读核验命令：`git status/diff/log/show`、`ls`、`cat`、`grep`、`find`、`wc`、`sha256sum`、`pytest`、`npm test`、`pwsh -File tests/*.ps1`、`bash -n` 等；可以用 `|`、`&&`、`for`、`if` 和只读的 `$(...)`；拒绝写重定向（`/dev/null` 除外）、反引号、heredoc 和 `$((...))` 算术。`pwsh` / `powershell` 必须写成字面命令或路径，`$PWSH` 这类变量不放行。
- `sed` 只放行 `sed -n '<地址>p' 文件…`：地址是行号、`N,M` 或 `/正则/`（可带第二个 `/正则/`），正则里不能有 `\` 和 `$`；后面的参数不能以 `-` 开头（`-i`、`--in-place`、`-e`、`-f` 都不行），也不能含 `$` 或 `{`。取末行用 `tail`。`printf -v` 不放行。
- 拒绝时说明原因：命令结构本身不放行时，列出不放行的结构（写到 `/dev/null` 以外的重定向、反引号、heredoc、`$((...))`、进程替换、`$(...)` 里的非只读命令、未闭合引号）；否则指出第一段不放行的命令（去掉流程关键字和 `timeout N` 前缀后，截取前 200 字）。
- PowerShell 语法检查用随包的 [`tools/Test-PsSyntax.ps1`](tools/Test-PsSyntax.ps1)：只用 PowerShell 解析器解析、不执行，逐个输出 `PARSE-OK <文件> tokens=N`，或 `PARSE-FAIL <文件>` 加若干 `行号: 错误`；退出码 0 全部通过，1 有语法错误，2 没给文件或文件不存在。护栏只放行这一种形式：

  ```text
  pwsh.exe -NoProfile -File '<插件目录>\tools\Test-PsSyntax.ps1' 'D:\path\a.ps1' ['D:\path\b.ps1' …]
  ```

  脚本路径必须是插件安装目录里的这一份（Windows 路径或 `/mnt/...` 形式都行）；后面至少跟一个文件，且不能有 `-` 开头的参数；`-File` 之前只允许 `-NoProfile`、`-NonInteractive`、`-NoLogo`、`-ExecutionPolicy <值>`，`-Command`、`-c`、`-EncodedCommand` 都会被拒绝。被拒时的提示里给出本机的完整路径。
- 通过 `tool_call` 间接调用的工具同样受限；子代理会话按它自己的工作区判断。
- 防虚报：回合结束时 agent 声称“已派 Codex”或“Codex 正在做”，但这一轮没有调用 `codex_*`，也没有由 `codex_run` 启动且仍在运行的任务，插件会提醒它一次，让它补上调用或更正说法。

## 要求

- Windows + WSL2，DSH 运行在 Windows 上（插件通过 `wsl.exe` 调用）。
- WSL 里已安装并登录 Codex CLI，并有 `python3`（3.11 及以上，runner 用 `tomllib` 读 Codex 配置）。
- DSH `>=0.2.1-rc.2 <0.3.0`。已在 Windows 11、WSL Ubuntu 24.04、Codex CLI 0.154、DSH 桌面版 0.2.1-rc.2 上使用。

## 安装

在 DSH 的“插件 → 添加插件”里填写：

```text
github:xiaobaifly7/dsh-codex-conductor
```

或用命令行（`<profile>` 换成实际的 profile；桌面版的 profile 请用应用内的插件页安装）：

```text
dsh plugin --profile <profile> add github:xiaobaifly7/dsh-codex-conductor
```

## 配置

默认只提供三个工具，不启用护栏；Codex 用它自己的模型和登录配置，但默认不加载它配置的 MCP 和 hooks（见上文）。按插件 id 覆盖 `config`：

```yaml
- id: codex-conductor
  config:
    workspaces:
      - 'D:\work\my-project'
      - path: 'D:\work\monorepo'
        cwd: 'D:\work\monorepo\app'
    effort: high
    readOnlyEffort: medium
    serviceTier: fast
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `workspaces` | `[]` | 启用护栏的工作区，子目录同样生效。条目可以是路径字符串（Windows 路径或 `/mnt/...`），也可以是 `{path, cwd}`：`path` 用于护栏判断，`cwd` 是会话工作区在 `path` 内时 `codex_run` 的默认任务目录 |
| `distro` | WSL 默认发行版 | 运行 Codex 的发行版 |
| `codexBin` | 自动查找 | WSL 内 codex 的路径；默认先查 PATH（跳过 `/mnt/` 下的 Windows 版），再查 `~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin` |
| `codexHome` | Codex 默认 | 传给 Codex 的 `CODEX_HOME` |
| `runnerHome` | `~/.local/state/codex-runner` | 任务记录和日志目录 |
| `model` | Codex 配置 | 默认模型 |
| `effort` | Codex 配置 | 默认推理强度，`codex_run` 的 `effort` 可单次覆盖 |
| `readOnlyEffort` | 同 `effort` | 只读任务（`write` 不为 `true`）的默认推理强度，留空时用 `effort` |
| `serviceTier` | Codex 配置 | 例如 `fast`（Codex 的 Fast 模式） |
| `waitSeconds` | `1500` | `codex_run` 默认等待秒数，到时任务转后台 |
| `allowHostAccess` | `false` | 为 `true` 时 `codex_run` 才提供 `host_access` 参数，允许 Codex 不带沙箱（`danger-full-access`）运行、启动 Windows 程序（见上文） |
| `allowCommands` | `[]` | 额外放行的命令，正则逐段匹配（按 `\|`、`&&`、`;` 切开后的每一段），建议写成锚定正则 |
| `denyTools` | `[]` | 额外拒绝的工具名 |
| `python` | `python3` | WSL 内运行 runner 的解释器 |

建议在项目的 `AGENTS.md` 里写明分工，例如：先写好每个任务的验收标准；用 `codex_run` 派活并尽量给出 `scope`；不把 Codex 的答复当作完成证据，用只读检查逐条核验；不通过就带 `resume` 派回。

## 单独使用 runner

```text
python3 runner/codex_runner.py run    --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] < prompt.txt
python3 runner/codex_runner.py start  --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] < prompt.txt
python3 runner/codex_runner.py status JOB_ID [--wait SECONDS]
python3 runner/codex_runner.py cancel JOB_ID
```

每条命令只在 stdout 输出一个 JSON 对象，原始事件写入日志目录。`--scope` 可重复，写相对 `--cwd` 的路径或绝对路径，只在目录太大、无法整树快照时用来缩小快照范围；插件把 `codex_run` 的 `scope` 逐条传入。

## 注意

- 护栏是工作流约束，不是安全沙箱：它按工具名和命令文本判断，`pytest`、`npm test`、`tests/*.ps1` 等会执行项目代码。
- `host_access=true` 的任务没有沙箱，Codex 能动整台机器；不越界和只读都只靠提示约束，只在信任的本机环境里开启 `allowHostAccess`。
- 防虚报检查基于文字匹配，可能漏判或误判，每个回合最多提醒一次。
- 插件加载时会写 `%LOCALAPPDATA%\dsh-codex-conductor\loaded.json`（加载时间、进程号、实际加载的模块地址、护栏工作区），用于确认插件已生效。

## 测试

```text
node --test test.mjs
python3 runner/test_codex_runner.py
```

两组测试都不需要 DSH、WSL 或真实的 Codex：runner 的测试使用模拟的 Codex，不消耗模型额度，在 Windows 上用 `python` 运行时只能在 Linux 跑的一项会跳过；`test.mjs` 里检查 `Test-PsSyntax.ps1` 退出码的用例需要 `pwsh`，没有时跳过。

[`.github/workflows/test.yml`](.github/workflows/test.yml) 在 push 和 pull request 时，于 `ubuntu-latest` 与 `windows-latest` 上（Node 22、Python 3.12）运行这两组测试。

## English

A DeepSeek Harness plugin that lets the DSH agent plan and verify while Codex CLI in WSL does the coding.

- `codex_run` / `codex_status` / `codex_cancel` run Codex through the bundled runner (retries, timeouts, idle and reconnect detection, per-directory write lock, resume by thread id). `codex_run` requires acceptance criteria, adds execution constraints to the hand-off, and asks Codex for a per-criterion JSON report; results flag unmet or blocked criteria, deviations, and changes outside `scope`. The report format is fixed, so a format demand in the task (such as a last-line verdict) is met by the `summary` field. The Codex sandbox blocks WSL interop, so by default Codex cannot start Windows programs (`pwsh.exe`, Hyper-V commands) and the agent runs such checks itself. With `allowHostAccess: true` (off by default), `codex_run` gains `host_access`; `host_access=true` runs Codex with `danger-full-access`: no sandbox, full access to the machine, Windows programs and the Hyper-V VMs through WSL interop. `write` still says whether it may modify things, but `write=false` is then enforced only by the prompt, the run is handled as a writer (write lock, snapshot, resumable thread), and the change snapshot covers only `cwd`. Passing `host_access=true` without `allowHostAccess` is an error. Writer tasks report changed files from a before/after snapshot, which can also catch files other processes wrote meanwhile (periodic logs). A tree too big to walk in 20 s is remembered for 7 days; for it only the `scope` paths are snapshotted and Codex's own change events cover the rest (`scope_snapshot+codex_events`).
- Unless `use_user_config` is set, every MCP server under `[mcp_servers]` in `$CODEX_HOME/config.toml` is disabled one by one with `-c mcp_servers.<name>.enabled=false` (servers from Codex plugins and names containing `.` are not covered), and hooks are off. Read-only tasks run `--ephemeral` and return `thread_id: null` (send a new full task instead of resuming), unless they resumed a writer thread. A resumed run marks its usage `usage_scope: "thread_total"`.
- Without `cwd`, Codex runs in the `cwd` of the most specific `workspaces` entry (`{path, cwd}`) that contains the session workspace, else in the session workspace. `readOnlyEffort` sets the default effort for read-only tasks.
- When the agent's preset offers DSH background jobs, every `codex_run` registers one background job as soon as Codex starts, so the run shows up in the DSH task list at once with a progress line (refreshed about every 20 s: seconds since Codex's last event and its latest action). A run that ends within `wait_seconds` returns its result directly; a longer one keeps running in the background; when it ends, DSH posts a one-line job notification and the agent reads the full result (report and next step) with `job_output`. A finished run's task-list row and the first line of its result start with a one-line summary such as `completed · 12 met / 1 blocked · 3 files · 148 s` (failed or cancelled runs: status, error kind, duration). Finished rows stay in the task list; archiving a session can cancel a running Codex job, and aborting the tool call cancels Codex without a later notice. Without a jobs service, poll with `codex_status`.
- In configured `workspaces`, the agent's own file-writing tools are denied and shell tools only run read-only verification commands (`sed` only as `sed -n '<addr>p' file...`; no `$((...))`). A denial names the refused structure or the first refused command segment. PowerShell syntax checks go through the bundled `tools/Test-PsSyntax.ps1` (`pwsh -NoProfile -File <that script> a.ps1 ...`). A turn that claims Codex was dispatched without calling `codex_*` gets one reminder.
- Tests: `node --test test.mjs` and `python3 runner/test_codex_runner.py`; GitHub Actions runs both on Ubuntu and Windows.
- Requires Windows with WSL2, Codex CLI and `python3` (3.11+) inside WSL, and DSH `>=0.2.1-rc.2 <0.3.0`. Install with `github:xiaobaifly7/dsh-codex-conductor`.

## License

[MIT](LICENSE)
