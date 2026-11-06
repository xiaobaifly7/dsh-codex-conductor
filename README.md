# dsh-codex-conductor

DeepSeek Harness（DSH）插件：DSH 里的 agent 负责规划和验收，编码任务交给 WSL 里的 Codex CLI 执行。

[English](#english)

## 功能

**派活工具**

| 工具 | 作用 |
| --- | --- |
| `codex_run` | 把任务交给 WSL 里的 Codex 并等待结果。必填 `task` 和 `acceptance`（1–20 条验收标准）；可选 `write`、`scope`、`cwd`、`resume`、`use_user_config`、`effort`、`wait_seconds` |
| `codex_status` | 继续等待或查询后台任务；仍在执行时返回距 Codex 上次活动的秒数和它最近的动作 |
| `codex_cancel` | 取消任务，在 WSL 内结束 Codex 的整个进程树 |

- 交接时自动附加执行约束：不扩大范围；只改 `scope` 里的路径；任务与现状不符或验收标准互相冲突时不自行取舍，标为 `blocked` 并说明；不为通过验收去改验收脚本或判据。
- 要求 Codex 按 [`report.schema.json`](report.schema.json) 逐条回报（met / not_met / blocked、证据、改动文件、偏离计划、未解决）。结果里会标出它自报未满足或受阻的条目、偏离计划的地方，以及超出 `scope` 的改动。
- 可写任务前后对任务目录做快照，列出新增、修改、删除的文件；目录大到 20 秒内扫不完时，改用 Codex 自报的改动，并注明来源。
- 任务在 WSL 后台运行，DSH 这边断开等待不影响任务；重试、超时、断线检测和同目录写锁由随包的 [`runner/codex_runner.py`](runner/codex_runner.py) 处理。

**护栏（按工作区开启）**

会话工作区在 `workspaces` 里时：

- 拒绝直接写文件或执行任意代码的工具：`write`、`edit`、`pwsh`、`run_code`、`subagent_codex`，以及 `wsl-write`、`wsl-edit`、`wsl-term`、`wsl-bootstrap`、`actions_run`、`actions_configure`；MCP 工具按动作名拒绝（`write`、`edit`、`replace`、`insert`、`delete`、`execute` 等）。
- shell 工具（`wsl`、`bash`、`ops_bash`）只放行只读核验命令：`git status/diff/log/show`、`ls`、`cat`、`grep`、`find`、`wc`、`sha256sum`、`pytest`、`npm test`、`pwsh -File tests/*.ps1`、`bash -n` 等；可以用 `|`、`&&`、`for`、`if` 和只读的 `$(...)`；拒绝写重定向（`/dev/null` 除外）、反引号和 heredoc。
- 通过 `tool_call` 间接调用的工具同样受限；子代理会话按它自己的工作区判断。
- 防虚报：回合结束时 agent 声称“已派 Codex”或“Codex 正在做”，但这一轮没有调用 `codex_*`，也没有由 `codex_run` 启动且仍在运行的任务，插件会提醒它一次，让它补上调用或更正说法。

## 要求

- Windows + WSL2，DSH 运行在 Windows 上（插件通过 `wsl.exe` 调用）。
- WSL 里已安装并登录 Codex CLI，并有 `python3`。
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

默认只提供三个工具，不启用护栏，Codex 用它自己的配置。按插件 id 覆盖 `config`：

```yaml
- id: codex-conductor
  config:
    workspaces:
      - 'D:\work\my-project'
    effort: high
    serviceTier: fast
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `workspaces` | `[]` | 启用护栏的工作区（Windows 路径或 `/mnt/...`），子目录同样生效 |
| `distro` | WSL 默认发行版 | 运行 Codex 的发行版 |
| `codexBin` | 自动查找 | WSL 内 codex 的路径；默认先查 PATH（跳过 `/mnt/` 下的 Windows 版），再查 `~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin` |
| `codexHome` | Codex 默认 | 传给 Codex 的 `CODEX_HOME` |
| `runnerHome` | `~/.local/state/codex-runner` | 任务记录和日志目录 |
| `model` | Codex 配置 | 默认模型 |
| `effort` | Codex 配置 | 默认推理强度，`codex_run` 的 `effort` 可单次覆盖 |
| `serviceTier` | Codex 配置 | 例如 `fast`（Codex 的 Fast 模式） |
| `waitSeconds` | `1500` | `codex_run` 默认等待秒数，到时任务转后台 |
| `allowCommands` | `[]` | 额外放行的命令，正则逐段匹配（按 `\|`、`&&`、`;` 切开后的每一段），建议写成锚定正则 |
| `denyTools` | `[]` | 额外拒绝的工具名 |
| `python` | `python3` | WSL 内运行 runner 的解释器 |

建议在项目的 `AGENTS.md` 里写明分工，例如：先写好每个任务的验收标准；用 `codex_run` 派活并尽量给出 `scope`；不把 Codex 的答复当作完成证据，用只读检查逐条核验；不通过就带 `resume` 派回。

## 单独使用 runner

```text
python3 runner/codex_runner.py run    --cwd DIR [--sandbox workspace-write] < prompt.txt
python3 runner/codex_runner.py start  --cwd DIR [--sandbox workspace-write] < prompt.txt
python3 runner/codex_runner.py status JOB_ID [--wait SECONDS]
python3 runner/codex_runner.py cancel JOB_ID
```

每条命令只在 stdout 输出一个 JSON 对象，原始事件写入日志目录。

## 注意

- 护栏是工作流约束，不是安全沙箱：它按工具名和命令文本判断，`pytest`、`npm test`、`tests/*.ps1` 等会执行项目代码。
- 防虚报检查基于文字匹配，可能漏判或误判，每个回合最多提醒一次。
- 插件加载时会写 `%LOCALAPPDATA%\dsh-codex-conductor\loaded.json`（加载时间、进程号、护栏工作区），用于确认插件已生效。

## 测试

```text
node --test test.mjs
python3 runner/test_codex_runner.py
```

runner 的测试使用模拟的 Codex，不消耗模型额度。

## English

A DeepSeek Harness plugin that lets the DSH agent plan and verify while Codex CLI in WSL does the coding.

- `codex_run` / `codex_status` / `codex_cancel` run Codex through the bundled runner (retries, timeouts, idle and reconnect detection, per-directory write lock, resume by thread id). `codex_run` requires acceptance criteria, adds execution constraints to the hand-off, and asks Codex for a per-criterion JSON report; results flag unmet or blocked criteria, deviations, and changes outside `scope`. Writer tasks report changed files from a before/after snapshot.
- In configured `workspaces`, the agent's own file-writing tools are denied and shell tools only run read-only verification commands. A turn that claims Codex was dispatched without calling `codex_*` gets one reminder.
- Requires Windows with WSL2, Codex CLI and `python3` inside WSL, and DSH `>=0.2.1-rc.2 <0.3.0`. Install with `github:xiaobaifly7/dsh-codex-conductor`.

## License

[MIT](LICENSE)
