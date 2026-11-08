# dsh-codex-conductor

DeepSeek Harness（DSH）插件：DSH 里的 agent 负责规划和验收，编码任务交给 WSL 里的 Codex CLI 执行。

[English](#english)

## 功能

**派活工具**

| 工具 | 作用 |
| --- | --- |
| `codex_run` | 把任务交给 WSL 里的 Codex 并等待结果。必填 `task`、`acceptance`（1–20 条验收标准）和 `write`（要改文件、做修复或建备份传 `true`，只读调查传 `false`）；可选 `host_access`（需开启 `allowHostAccess`）、`scope`、`writable_roots`、`cwd`、`resume`、`use_user_config`、`effort`、`wait_seconds` |
| `codex_status` | 查询或继续等待任务；仍在执行时返回距 Codex 上次活动的秒数和它最近的动作。已登记为 DSH 后台任务的不必调用 |
| `codex_cancel` | 取消任务，在 WSL 内结束 Codex 的整个进程树；任务已经结束时返回它的结果和下一步 |
| `codex_jobs` | 按工作区、会话、执行状态或待关注状态分页查询任务，找回 runner job ID、Codex thread ID 和 Harness 后台任务编号 |
| `codex_output` | 按 Unicode 字符分页、可重复读取完整原始报告、结果 JSON 或原任务与验收上下文；读取不消费结果，也不启动或恢复任务 |
| `codex_continue` | 回答阻塞问题或提供环境恢复依据后续接原任务；保留原线程、目录、验收、write、scope 和权限，同一父任务不重复派活 |
| `codex_review` | 保存规划端逐条独立核验的证据与结论；通过、待修正、明确接受偏差分别记录，原报告保留 |
| `codex_summary` | 按 Codex 线程汇总多轮结果、涉及文件、未闭环事项、已结束耗时和用量；执行状态与独立核验分别展示，不重复相加线程累计用量 |
| `codex_watch` | 安静观察当前会话的原生 Codex 后台任务，首次重要变化时通知；停止观察不会取消 Codex |
| `codex_runtime` | 查看源码与实际加载版本；明确请求立即重载或等任务空闲后重载，收到真实加载标记才确认生效 |

阻塞报告现在使用 [`report.v2.schema.json`](report.v2.schema.json)：在原五字段上新增 `blockers`。每项有 `id / kind / message / question / resolution`，区分缺用户信息、任务冲突、环境条件和实现待修。`resolution` 是解除条件或已有信息，非空不代表已经解决。不按报错关键词猜类别；旧报告没有分类时先查明原因。旧 [`report.schema.json`](report.schema.json) 保留五字段，供热重载前仍在运行的旧版本使用；新版可读取两种报告。

收到需要回答的问题后，规划端先问用户，再调用例如 `codex_continue({"job_id":"J1","answers":[{"id":"choice","answer":"采用已确认的方案"}]})`。环境恢复时用 `resolution` 写实际证据。续接不会修改原验收或增加写权限；历史归属未知、状态未知或已取消的任务不会自动恢复。已存在后续轮次时返回它，后续处理使用最新 `job_id`，避免同一父任务反复派活。续接记录保留原目标与本轮补充，不在每轮任务里堆叠全部旧报告。

独立核验使用 `codex_review`：`criteria` 用原验收标准从 1 开始的 `index`，逐项提供 `status` 和实际 `evidence`；结论为 `verified / needs_changes / accepted_deviations`。通过结论要求各项实际通过；有报告偏差或范围外改动时，必须在 `accepted_deviations` 中按 `reported / scope` 与 1 起始编号逐项说明接受依据。历史存入任务目录的 `reviews.json`，原 `result.json` 和 Codex 报告不改写；可用 `codex_output` 的 `artifact="review"` 分页重读。

`codex_summary()` 默认汇总当前会话；传 `cwd` 可汇总一个项目，`thread_id` 可只看一个线程。没有线程号的任务独立成组。最新轮次的执行状态与独立核验结论分开显示，不能据此宣称整个项目永久无问题。线程累计 token 只取最新可用累计值；混合或未知统计口径会明确标出，耗时只加总已结束轮次。

`codex_watch({"mode":"attention"})` 仅在失败、阻塞或报告异常等变化时通知；`mode="all"` 也包含开始和正常结束。它在无变化时只读 Harness 内存任务表，不启动 Codex、不反复唤醒模型。首次符合条件的变化后观察结束，需要继续时再调用。它保留任务原有结束通知，也不默认启用长期监控；取消观察只停止观察。

`codex_runtime({"action":"status"})` 显示磁盘源码版本、实际加载记录、待生效差异和活任务数。`action="reload"` 默认 `when="idle"`，有任务时登记原生后台等待；`when="now"` 明确要求立即热重载，旧任务继续运行。先配置 `runtimeProfileFile` 为这个桌面实例实际使用的 `cordis.patch.yml` 的完整 Windows 路径。只更新本插件的 entry id 与模块 URL，不重启宿主、不结束 Codex；未取得新模块加载确认时不会显示“已生效”。

- 无法查询任务、记录损坏或监控失联时，`execution_status="unknown"` 表示执行结果未确认；`report_status="missing"` 只表示当前未取得结构化报告。取消遇到这些状态或任务仍在运行时会明确提示“取消未确认”，不能据此宣称任务已经结束或直接重派；启动调用未取得任务编号时，也先按相同任务目录查询历史找回 ID。历史范围判断使用已记录的规范化路径，后续文件被替换成符号链接不会改写那次任务的范围结论。

- 执行、报告和验收分别显示：`execution_status` 是执行状态；`report_status` 为 `valid / invalid / missing / pending`；`review_status` 为 `needs_attention / needs_verification / pending`。格式错误、受阻、未满足、有未解决事项、偏离计划或超出范围的任务列为待关注；模型自报全部满足也仅为待核验，不代表已独立验收通过。摘要同步显示“待关注”“待核验”或“报告异常”。
- 历史查询默认使用当前工作区；`session_id="current"` 查询当前会话，也可指定会话 ID。新任务将 owner、原任务、原验收标准和写入意图保存在已有任务参数中，经 stdin JSON 传输，长任务不会挤进 Windows 命令行参数。旧任务优先关联 Harness 会话 journal 和原生任务表；无法确认归属的保留未知，可按工作区找回。完整上下文用 `codex_output` 的 `artifact="context"` 读取。
- 完整结果读取使用 `job_id`，不是 `background_job_id`：`artifact="report"` 读取原始报告，`result` 读取执行结果，`context` 读取原任务与验收。默认每段 4000 个 Unicode 字符，最多 8000；按返回的 `next_offset` 继续读取，直至 `eof=true`。这也适用于 `job_output` 已消费或被 64 KiB 上限截断的结果。旧任务没有保存上下文时会明确说明。
- 进度包含尝试轮次、当前阶段、上次错误分类和下次重试时间；阶段区分检查路由、Codex 执行、等待重试和生成最终结果。阶段记录复用现有事件日志，不改变超时或重试策略。
- 原生任务面板会记录进度和最终报告，完成后也可展开。取消请求未确认时持续显示失败原因和任务编号；取消结果保留目录、权限模式和已有可续跑线程信息，仍由用户决定是否恢复，不自动重派，也不将缺少改动清单解释为没有改动。

- 交接时自动附加执行约束：不扩大范围；只改 `scope` 里的路径；任务与现状不符或验收标准互相冲突时不自行取舍，标为 `blocked` 并说明；不为通过验收去改验收脚本或判据。`scope` 只接受具体文件或目录，不展开通配符；动态命名的备份须在派活前确定具体文件名并列入。
- 任务明确禁止某些访问或状态变更时，交接提示要求执行端在运行相关脚本前先只读检查其行为；有冲突或无法确认时，不执行对应步骤并标为 `blocked`。
- 要求 Codex 按 [`report.v2.schema.json`](report.v2.schema.json) 逐条回报（met / not_met / blocked、证据、改动文件、偏离计划、未解决）。结果里会标出它自报未满足或受阻的条目、偏离计划的地方，以及超出 `scope` 的改动。最终答复的版式由插件固定为这份 JSON：`task` / `acceptance` 里对版式的要求（如单独的末行结论行）写进 `summary` 就算满足，Codex 不会因此标 `blocked`；工具说明也让 agent 不要再规定这类版式。
- 已完成的结果只给核验用得上的内容：汇报条数和编号与验收标准对得上时，逐条汇报显示验收标准原文（Codex 几乎总会改写条目），下一步按编号指出未满足的条目、不再重复列出验收标准；每条证据最多显示 800 字，全文在 `log_dir` 下的 `last_message.txt`；详细字段只留任务目录和一行改动清单（改动超过 300 个时只列前 300 个，并注明超出 `scope` 的检查也只覆盖这些）。失败、取消和仍在执行的结果照旧给出全部字段；用量、日志目录等完整字段在 runner 的 `result.json`（`runnerHome/jobs/<job_id>/`）里。阻塞按明确分类处理，续接沿用原 write、scope 和主机权限；需要扩大任务授权时另行明确派活。
- Codex 的沙箱（只读和 `workspace-write` 都是）挡住了 WSL interop，Codex 在沙箱里启动不了 Windows 程序（`pwsh.exe`、Hyper-V 命令等）。默认情况下需要 Windows 运行时的检查不要写进 `task` / `acceptance`，由 agent 自己跑。
- 主机访问（默认关闭）：配置里开启 `allowHostAccess` 后，`codex_run` 才多出 `host_access` 参数，工具说明改为让 agent 在任务需要 Windows 程序、Hyper-V 或连接 Hyper-V 虚拟机时传 `host_access=true`。这时不管 `write`，Codex 都以 `danger-full-access` 运行：没有沙箱，对整台机器有完全访问权限，可以通过 WSL interop 启动 Windows 程序、使用 Windows 那边的网络。交接提示里多一条约束：只做任务需要的事，任务没点名的虚拟机、文件和网络设置不删除、不停止、不重建、不改配置。`write` 仍决定能不能改动，但 `write=false` 时的只读只靠提示约束（再加一条：只读调查，不改文件，也不改虚拟机、网络或系统状态），没有沙箱拦着。runner 把这类任务都当可写任务：拿同目录写锁、做快照、不用 `--ephemeral`、返回可续跑的 `thread_id`。改动快照只覆盖任务目录，Codex 在任务目录以外（其他目录、Windows 文件、虚拟机里）做的改动不会出现在快照结果里。没开启 `allowHostAccess` 时传 `host_access=true` 会直接报错。
- 默认（不传 `use_user_config`）按服务器逐个关掉 Codex 的 MCP：runner 读 `$CODEX_HOME/config.toml`（没设 `CODEX_HOME` 时读 `~/.codex/config.toml`），对 `[mcp_servers]` 下的每一项传 `-c mcp_servers.<名字>.enabled=false`，并关掉 hooks。Codex 插件自带的 MCP 不在 `config.toml` 里，管不到；名字里带 `.` 的服务器也关不掉（Codex 按 `.` 切分 `-c` 的键）。文件不存在或解析不了时不加参数。`use_user_config=true` 时照常加载这些 MCP 和 hooks。
- 只读任务（`write=false`，也没传 `host_access=true`）以 `--ephemeral` 运行、不留会话记录，返回的 `thread_id` 为 `null`，下一步提示改为重新派一个写全背景的完整任务，而不是 `resume`。只读任务若是 `resume` 了某个写任务的线程，则返回那个线程的 id，仍可续跑。
- 续跑（`resume`）时 Codex 报的用量是整个线程的累计值，结果里在 `usage` 旁加 `usage_scope: "thread_total"`（不换算成本次增量）；只读任务重试时放弃续跑、从头开始，这时的用量只算本次，不加这个标记。
- 任务目录：传了 `cwd` 就用它；否则会话工作区落在某个带 `cwd` 的 `workspaces` 条目里时，用该条目的 `cwd`（有多条时取路径最长的那条）；再否则用会话工作区。只在 `task` 里写目录不会切换任务目录。
- 沙箱内跨目录写入：`write=true` 时，`writable_roots` 可为本次任务指定额外可写目录，支持 Windows 路径和 `/mnt/...` 路径，首次运行和 `resume` 都生效。例如 `cwd="D:\\work\\project"`、`writable_roots=["E:\\results"]`，可在保留 `workspace-write` 沙箱的同时写入已有的 E 盘结果目录。`scope` 仍须列出全部允许修改的文件或目录（包括复制目的地）；它本身不增加沙箱权限。省略 `writable_roots` 沿用 Codex 原配置，传入时仅为本次调用覆盖额外可写目录列表。快照仍只覆盖 `cwd`，额外目录中的改动需检查实际文件。需要启动 Windows 程序或检查 Windows ACL 时仍用 `host_access=true`；主机访问模式已经没有沙箱，不需要再传 `writable_roots`。
- 可写任务前后对任务目录做快照，列出新增、修改（包括文件权限变化）、删除的文件（`files_changed_source` 为 `snapshot`）。快照也会记下同时段其他进程写的文件（如定期日志），所以“超出 scope”的清单里可能有它们；提示里会说明：不在 Codex 自报 `files_changed` 里、明显来自其他进程的文件只需一句说明，不算 Codex 越界，也不用请用户决定。总是由其他进程写的文件可以写进配置 `ignoreChanges`：runner 在截取前 300 条之前就去掉匹配的文件，它们不计入改动清单、改动数和超出 `scope` 的检查（`result.json` 里也不再记录）；交接提示里会告诉 Codex 这些文件可能被其他进程改动，不要因此判定现状不符或标 `blocked`，任务本身要求处理它们时照常处理。目录大到 20 秒内扫不完时，runner 把它记在 `runnerHome` 的 `snapshot-too-big.json` 里，7 天内同一目录不再整树扫描：给了 `scope` 就只快照 `scope` 里的路径，`scope` 之外的改动取 Codex 自报的记录（`scope_snapshot+codex_events`）；没给 `scope` 就只用 Codex 自报的改动（`codex_events`）。Codex 自报只覆盖它自己的改文件工具，不含 shell 写入。
- 任务在 WSL 后台运行，DSH 这边断开等待不影响任务；重试、超时、断线检测和同目录写锁由随包的 [`runner/codex_runner.py`](runner/codex_runner.py) 处理。路由不可用时的重试保留尚未发送的任务提示；启动与取消同步，PID 或事件日志写入失败也会结束并回收子进程。
- 同目录写锁被占用时，后来的任务自动等待，状态为 `running`、阶段为 `lock_wait`，面板显示“排队等待目录写锁”。获得锁之前不会启动 Codex、检查路由或拍改动快照；取消这个排队任务不会取消持锁任务。继续用原 `job_id` 等待，不要重新派活。多个等待任务不保证严格先来先服务；`--timeout` 仍只限制每次 Codex 尝试，不包含排队时间，不想继续等时用 `codex_cancel`。
- 插件每次调用 `wsl.exe` 都有上限：`start` 和 `cancel` 120 秒，`status` 在它自己的等待秒数之外再留 60 秒。计时按 1 秒一跳，电脑睡眠唤醒不会立刻误判超时。WSL 卡住或起不来时按 `bridge_error` 返回，工具调用不会一直挂着；已知 `job_id` 的任务这时提示先用 `codex_status` 查询，不要直接重派，后台监控也会容忍偶发的一两次 `bridge_error`。WSL 重启后，runner 按「开机 ID + 本发行版 init 的启动时刻」认出重启前的任务（`wsl --shutdown`、Windows 重启换开机 ID，`wsl --terminate`、发行版自行停止换 init 启动时刻），报 `worker_died`（Codex 已开始会话的可写任务带回 `thread_id`，可以续跑；可写任务另提示退出前可能已改了一半且没有改动清单），取消这类任务时也不会去结束重启后恰好同号的其他进程。`codex_cancel` 对已经结束的任务直接返回它的结果与对应下一步，不会叫 agent 重派。任务记录只增不减会占空间，`start` 时顺带清掉 30 天前已结束的 jobs/runs 目录。
- 任务表与结束通知：agent 的 preset 提供 DSH 后台任务（jobs）服务时，`codex_run` 一启动 Codex 就把它登记为一个后台任务（`Codex <job_id>`），DSH 任务表里立刻出现这一行，进度行约每 20 秒刷新一次，显示距 Codex 上次活动的秒数和它最近的动作。`codex_run` 经任务表等到 `wait_seconds`：这之前结束就直接返回结果，不另发通知；到点仍在执行时任务留在后台继续，结果里带 `background_job_id`，Codex 结束后 DSH 发一条只带一行摘要的任务通知，agent 用 `job_output` 读取与工具结果相同的完整文字（含逐条汇报和下一步）后继续，不用轮询。
- 一行摘要：任务结束后，任务表那一行和结果的第一行都以一行摘要开头，如 `completed · 12 met / 1 blocked · 3 files · 148 s`（状态、按 met / not_met / blocked 计的验收条数、改动文件数、用时；只读任务没有文件数），失败或取消时是 `failed · timeout · 30 s` 这样的状态、错误类型和用时；结果第一行在摘要后照旧带 `job_id` 和 `thread_id`。结束的行留在任务表里，摘要就在那里看。任务表那一行的标题是 `Codex <job_id> · <任务第一行>`；聊天里 `codex_run` 的卡片进行中显示 `Codex · <任务第一行>`（返工、带 host_access 时会注明），结束后标题换成同一行摘要。被取消的任务不按失败处理：提示先问用户，并提醒可写任务可能已改了一半、没有改动清单。
- 规划要求：你写给 DeepSeek 自己的固定规划要求（怎么拆任务、写 task 和验收标准时要注意什么），放在 `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md`（DSH 便携版在其数据目录的 `local\dsh-codex-conductor\` 下；`loaded.json` 里的 `plannerPromptFile` 是实际路径）。插件首次加载时放一份只有注释的模板；注释以外的内容作为系统提示词的一段注入，agent 每一步都带着，压缩上下文也不会丢；保存后下一步就生效，不用重载。它不会原样发给 Codex。设了内容时，每次 `codex_run` 完成的下一步提示里也会提醒对照这些要求。宿主没有系统提示词服务时不注入，其余功能照常。
- 同一个 runner 任务只登记一个后台任务（按 DSH 任务表判断，插件重载后也不重复）；对已登记的任务调用 `codex_status` 或 `codex_cancel` 会经 DSH 任务表等待，结果不会再作为通知重复送一次。等待中途停止工具调用时，插件结束这个后台任务（同时在 WSL 里取消 Codex），等它结算完再返回；取消未确认时保留任务编号并提示用 `codex_status` 查询，任务仍可能在运行。归档会话时，DSH 可能结束其中仍在运行的后台任务，Codex 任务随之取消。后台等待本身出错时送回 `monitor_failed`，提示 Codex 任务可能仍在运行、先用 `codex_status` 查询。没有 jobs 服务、登记失败或没有 agent 时，任务表里没有这一行，`codex_run` 直接等 runner 到 `wait_seconds`，之后照旧用 `codex_status` 轮询。

**护栏（按工作区开启）**

会话工作区在 `workspaces` 里时：

- 拒绝直接写文件或执行任意代码的工具：`write`、`edit`、`pwsh`、`run_code`、`subagent_codex`，以及 `wsl-write`、`wsl-edit`、`wsl-term`、`wsl-bootstrap`、`actions_run`、`actions_configure`；MCP 工具按动作名拒绝（`write`、`edit`、`replace`、`insert`、`delete`、`execute` 等）。
- shell 工具（`wsl`、`bash`、`ops_bash`）只放行只读核验命令：`git status/diff/log/show`、`ls`、`cat`、`grep`、`find`、`wc`、`sha256sum`、`pytest`、`npm test`、`pwsh -File tests/*.ps1`、`bash -n` 等；可以用 `|`、`&&`、`for`、`if` 和只读的 `$(...)`；拒绝写重定向（`/dev/null` 除外）、反引号、heredoc 和 `$((...))` 算术。`pwsh` / `powershell` 必须写成字面命令或路径，`$PWSH` 这类变量不放行。
- `sed` 只放行 `sed -n '<地址>p' 文件…`，支持用 `;` 分隔多段打印（如 `1,5p;20,25p`）：地址是行号、`N,M` 或 `/正则/`（可带第二个 `/正则/`），正则里不能有 `\` 和 `$`；后面的参数不能以 `-` 开头（`-i`、`--in-place`、`-e`、`-f` 都不行），也不能含 `$` 或 `{`。取末行用 `tail`。`printf -v` 和含 `$` 的首参数不放行，其余输出参数仍可用变量和只读命令替换。
- 有参数过滤的命令（`git`、`find`、`sort`、`uniq`、`iconv`、`rg`、`tree`、`node`、`go`、`cargo`、`make`、`npm/pnpm/yarn`）不接受含 `$` 的参数或未引用的花括号展开，防止展开后变成写入或执行开关；`cat $(ls)` 这类读取仍可用。输入重定向的目标也接受同样的替换检查；`-v/-R` 和 `read` 的赋值目标必须是安全的字面变量名，`read` 的提示文本仍可使用变量。`git grep -O/--open-files-in-pager`、Go 的 `-exec/-toolexec/-vettool`、`sort --compress-program/--random-source` 不放行。Git 另支持 `config --get/-l/--list`、`remote [-v/--verbose]`、`tag -l/--list` 和 `stash list` 这些只读形式。
- `bash -n` / `sh -n` 只接受静态文件参数，禁止 `+n`、变量和未引用的展开；`test` / `[` 只接受静态操作符，文件名和字符串仍可用引用变量。`uniq` 不接受未引用的通配符；`tree` 的 `-o` 及含它的短选项组合均不放行。
- 拒绝时说明原因：命令结构本身不放行时，列出不放行的结构（写到 `/dev/null` 以外的重定向、反引号、heredoc、`$((...))`、进程替换、`$(...)` 里的非只读命令、未闭合引号）；否则指出第一段不放行的命令（去掉流程关键字和 `timeout N` 前缀后，截取前 200 字）。
- PowerShell 语法检查用随包的 [`tools/Test-PsSyntax.ps1`](tools/Test-PsSyntax.ps1)：只用 PowerShell 解析器解析、不执行，逐个输出 `PARSE-OK <文件> tokens=N`，或 `PARSE-FAIL <文件>` 加若干 `行号: 错误`；退出码 0 全部通过，1 有语法错误，2 没给文件或文件不存在。护栏只放行这一种形式：

  ```text
  pwsh.exe -NoProfile -File '<插件目录>\tools\Test-PsSyntax.ps1' 'D:\path\a.ps1' ['D:\path\b.ps1' …]
  ```

  脚本路径必须是插件安装目录里的这一份（Windows 路径或 `/mnt/...` 形式都行）；后面至少跟一个文件，且不能有 `-` 开头的参数；`-File` 之前只允许 `-NoProfile`、`-NonInteractive`、`-NoLogo`、`-ExecutionPolicy <值>`，`-Command`、`-c`、`-EncodedCommand` 都会被拒绝。被拒时的提示里给出本机的完整路径。
- 通过 `tool_call` 间接调用的工具同样受限；子代理会话按它自己的工作区判断。
- 防虚报：回合结束时 agent 声称“已派 Codex”或“Codex 正在做”，但这一轮没有调用 `codex_*`，也没有由本插件后台监控确认仍在运行的任务，插件会提醒它一次，让它补上调用或更正说法。没有 jobs 服务时不跨轮缓存轮询状态；取消失败时继续保留后台任务的执行状态。判断按当前会话的 DSH 任务表进行，插件重载后也沿用已有任务，不受其他会话运行任务的影响。

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

以 `file:///.../index.mjs` 直接加载 profile 管理范围外的源码时，升级应同时更新条目 `id` 的版本后缀（如 `codex-conductor-<commit>`）和模块 URL 的 `?v=<commit>`。DSH 0.2.1-rc.2 的 Loader 对已激活的同 ID 条目只改 `name` 不保证重新导入；版本化 ID 会创建新实例，避免文件已经更新、运行代码仍旧的情况。以 `loaded.json` 的模块 URL、加载时间和进程号确认实际生效。已有后台任务继续完成，新实例仍按原生任务表复用，不重复派发。

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
| `workspaces` | `[]` | 启用护栏的工作区，子目录同样生效；`'*'` 匹配所有会话工作区。条目可以是路径字符串（Windows 路径或 `/mnt/...`），也可以是 `{path, cwd}`：`path` 用于护栏判断，`cwd` 是会话工作区在 `path` 内时 `codex_run` 的默认任务目录 |
| `distro` | WSL 默认发行版 | 运行 Codex 的发行版 |
| `codexBin` | 自动查找 | WSL 内 codex 的路径；默认先查 PATH（跳过 `/mnt/` 下的 Windows 版），再查 `~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin` |
| `codexHome` | Codex 默认 | 传给 Codex 的 `CODEX_HOME` |
| `runnerHome` | `~/.local/state/codex-runner` | 任务记录和日志目录 |
| `model` | Codex 配置 | 默认模型 |
| `effort` | Codex 配置 | 默认推理强度，`codex_run` 的 `effort` 可单次覆盖 |
| `readOnlyEffort` | 同 `effort` | 只读任务（`write=false`）的默认推理强度，留空时用 `effort` |
| `serviceTier` | Codex 配置 | 例如 `fast`（Codex 的 Fast 模式） |
| `waitSeconds` | `1500` | `codex_run` 默认等待秒数，到时任务转后台 |
| `allowHostAccess` | `false` | 为 `true` 时 `codex_run` 才提供 `host_access` 参数，允许 Codex 不带沙箱（`danger-full-access`）运行、启动 Windows 程序（见上文） |
| `defaultHostAccess` | `false` | 与 `allowHostAccess=true` 一起使用，省略 `host_access` 的新任务和 `resume` 默认以 `danger-full-access` 运行；显式传 `host_access=false` 可为单次任务恢复沙箱 |
| `plannerPromptFile` | `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` | 规划要求文件（Markdown，HTML 注释不算内容），注入 agent 的系统提示词（见上文） |
| `runtimeProfileFile` | 空 | 当前 Harness 实例实际使用的 `cordis.patch.yml` 完整 Windows 路径；用于版本匹配与明确请求的热重载，留空时不能自动重载 |
| `allowCommands` | `[]` | 额外放行的命令，正则逐段匹配（按 `\|`、`&&`、`;` 切开后的每一段），建议写成锚定正则；非法正则会警告并跳过，护栏和其余条目照常生效 |
| `ignoreChanges` | `[]` | 改动清单里忽略的文件，正则匹配相对任务目录的路径（`/` 分隔），用于其他进程定期写的日志等；runner 在截取改动清单之前过滤，匹配的文件不计入改动数和超出 `scope` 的检查，交接提示里会告诉 Codex 它们可能被其他进程改动。非法正则会警告并跳过 |
| `denyTools` | `[]` | 额外拒绝的工具名 |
| `python` | `python3` | WSL 内运行 runner 的解释器 |

建议在项目的 `AGENTS.md` 里写明分工，例如：先写好每个任务的验收标准；用 `codex_run` 派活并尽量给出 `scope`；不把 Codex 的答复当作完成证据，用只读检查逐条核验；未通过先用 `codex_review` 记录证据，再用 `codex_continue` 沿用原权限修正。

## 单独使用 runner

```text
python3 runner/codex_runner.py run    --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] [--writable-root DIR ...] [--ignore REGEX ...] < prompt.txt
python3 runner/codex_runner.py start  --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] [--writable-root DIR ...] [--ignore REGEX ...] < prompt.txt
python3 runner/codex_runner.py status JOB_ID [--wait SECONDS]
python3 runner/codex_runner.py cancel JOB_ID
python3 runner/codex_runner.py list [--cwd DIR] [--owner SESSION_ID] [--status STATUS] [--needs-attention] [--limit 20] [--offset 0]
python3 runner/codex_runner.py output JOB_ID [--artifact report|result|context|review] [--offset 0] [--limit 4000]
python3 runner/codex_runner.py review JOB_ID --reviewer SESSION_ID < review.json
python3 runner/codex_runner.py summary [--cwd DIR] [--owner SESSION_ID] [--thread-id THREAD_ID] [--round-limit 20]
```

`run` / `start` 可选 `--context-json`，此时 stdin 为 `{"prompt":"完整交接提示","context":{"owner":"会话 ID","task":"原任务","acceptance":["原验收"],"write":true}}`；不传时沿用纯文本提示。`list` 默认最近 20 条、每页最多 100 条；`--status` 按执行状态筛选。`output` 偏移和长度按 Unicode 字符计算，不切断中文或 emoji，可重复读取。CLI 同样保留主机访问权限选项，新增查询不会启动 Codex。

每条命令只在 stdout 输出一个 JSON 对象，原始事件写入日志目录。`--scope` 可重复，写相对 `--cwd` 的路径或绝对路径，只在目录太大、无法整树快照时用来缩小快照范围；插件把 `codex_run` 的 `scope` 逐条传入。结果中的 `cwd` 和传入 scope 时的 `scope_paths` 是规范化的真实绝对路径，快照、事件和范围检查共用这个基准，避免目录别名造成重复改动或误报越界。`--writable-root` 也可重复，只在 `workspace-write` 下增加本次调用的可写目录（目录须已存在），不改变只读模式。`--ignore` 也可重复：路径（相对 `--cwd`）匹配这些正则的改动在截取前 300 条之前就从 `files_changed` 里去掉；插件把 `ignoreChanges` 逐条传入。

## 注意

- 护栏是工作流约束，不是安全沙箱：它按工具名和命令文本判断，`pytest`、`npm test`、`tests/*.ps1` 等会执行项目代码。
- `host_access=true` 的任务没有沙箱，Codex 能动整台机器；不越界和只读都只靠提示约束，只在信任的本机环境里开启 `allowHostAccess`。
- 防虚报检查基于文字匹配，可能漏判或误判，每个回合最多提醒一次。
- 插件加载时会写 `%LOCALAPPDATA%\dsh-codex-conductor\loaded.json`（加载时间、进程号、实际加载的模块地址、护栏工作区），用于确认插件已生效。

## 测试

```text
node --test test.mjs workflow.test.mjs runtime.test.mjs
python3 runner/test_codex_runner.py
```

两组测试都不需要 DSH 或真实的 Codex：runner 的测试使用模拟的 Codex，不消耗模型额度，在 Windows 上用 `python` 运行时，Linux 专用用例会按条件跳过；JS 测试中的 Bash/WSL、`pwsh` 命令探针在对应工具不可用时跳过。

[`.github/workflows/test.yml`](.github/workflows/test.yml) 在 push 和 pull request 时，于 `ubuntu-latest` 与 `windows-latest` 上（Node 22、Python 3.12）运行这两组测试。

## English

A DeepSeek Harness plugin that lets the DSH agent plan and verify while Codex CLI in WSL does the coding.

- `codex_jobs` lists task history by workspace, session, execution status or attention state. It links existing session journal entries with runner jobs and persists original task and acceptance context for new jobs, without a new database.
- `codex_output` reads the full report, result or context repeatedly in Unicode-character pages (4000 by default, at most 8000). It recovers content after native `job_output` delivery or truncation without consuming it or restarting the task.
- Execution status, report validity and review state are separate. A model's all-met report still needs independent verification. Native task output keeps progress and the final report visible, cancellation failures remain visible until confirmed, and runner status exposes attempt, phase, retry reason and retry time.
- `codex_continue` handles typed blocker answers and environment evidence while preserving the original scope, write flag, host access and thread. A parent with an existing continuation is reused. Legacy five-field reports remain readable; new tasks use `report.v2.schema.json` with typed `blockers`.
- `codex_review` stores criterion-by-criterion independent evidence separately in `reviews.json`; passing reviews must explicitly acknowledge reported deviations and out-of-scope changes. `codex_summary` groups actual threads, keeps execution and verification separate, and never sums repeated thread-total token counts.
- `codex_watch` observes native task-state changes without model polling or idle WSL calls. It ends after the first matching change; stopping it only stops observation. `codex_runtime` compares source and loaded versions and can request an immediate or deferred-until-idle reload. Set `runtimeProfileFile` to the actual desktop profile; confirmation requires the new loaded marker, and no business task is cancelled.
- A writer waits for an occupied directory lock instead of failing with `busy`. It remains `running` with phase `lock_wait`, and starts Codex only after obtaining the lock. Cancelling a queued job leaves the holder alone. Waiters are not strictly FIFO; the existing per-attempt `--timeout` excludes lock waiting, which can be cancelled with `codex_cancel`.

- `codex_run` / `codex_status` / `codex_cancel` run Codex through the bundled runner (retries, timeouts, idle and reconnect detection, per-directory write lock, resume by thread id). Every `wsl.exe` call is bounded (`start` and `cancel` 120 s, `status` its wait plus 60 s) by a 1-second-tick timer that does not misfire after a host sleep, so a hung WSL returns a `bridge_error` instead of a stuck tool call (the background monitor tolerates the odd transient one), and for a known `job_id` the next step says to query it with `codex_status` before sending the task again. After a restart the runner recognises jobs from the earlier instance by the kernel boot id plus this distro's init start time (`wsl --shutdown` and Windows reboots change the boot id; `wsl --terminate` or a distro auto-stop changes the init start time), reports them as `worker_died` (a writer whose Codex session had started keeps its `thread_id` and can be resumed, and is warned its edits may be partial and unlisted) and never kills processes that reuse their pids. `codex_cancel` on a job that already ended returns its result and a matching next step instead of telling the agent to dispatch it again. `start` also prunes finished `jobs`/`runs` directories older than 30 days so the runner home does not grow without bound. `codex_run` requires acceptance criteria and an explicit `write` (`true` to change files, `false` for a read-only investigation), adds execution constraints to the hand-off, and asks Codex for a per-criterion JSON report; results flag unmet or blocked criteria, deviations, and changes outside `scope`. A completed result keeps only what verification needs: the original acceptance text on each report line when the count and numbering match (Codex nearly always rewords them, and the next step then cites numbers instead of repeating the list), evidence clipped to 800 characters with the full text in `last_message.txt` under `log_dir`, malformed report containers falling back to the original reply, and the task directory plus a one-line change list (past 300 changes it lists the first 300 and says so); failed, cancelled and running results keep every field, and the full fields (usage, log_dir and the rest) stay in the runner's `result.json`. Typed blockers drive clarification, environment waiting or implementation fixes. Continuation preserves the original permissions instead of changing write or host access from error keywords. The report format is fixed, so a format demand in the task (such as a last-line verdict) is met by the `summary` field. The Codex sandbox blocks WSL interop, so by default Codex cannot start Windows programs (`pwsh.exe`, Hyper-V commands) and the agent runs such checks itself. With `allowHostAccess: true` (off by default), `codex_run` gains `host_access`; `host_access=true` runs Codex with `danger-full-access`: no sandbox, full access to the machine, Windows programs and the Hyper-V VMs through WSL interop. `write` still says whether it may modify things, but `write=false` is then enforced only by the prompt, the run is handled as a writer (write lock, snapshot, resumable thread), and the change snapshot covers only `cwd`. Passing `host_access=true` without `allowHostAccess` is an error. Writer tasks report changed files, including permission changes, from a before/after snapshot, which can also catch files other processes wrote meanwhile (periodic logs); paths matching an `ignoreChanges` regex (relative to the task directory) are dropped by the runner before it caps the list at 300 entries, so the change list, the file count and the `scope` check leave them out, and the hand-off tells Codex they may change on their own and are no reason to mark a criterion blocked. A tree too big to walk in 20 s is remembered for 7 days; for it only the `scope` paths are snapshotted and Codex's own change events cover the rest (`scope_snapshot+codex_events`).
- Unless `use_user_config` is set, every MCP server under `[mcp_servers]` in `$CODEX_HOME/config.toml` is disabled one by one with `-c mcp_servers.<name>.enabled=false` (servers from Codex plugins and names containing `.` are not covered), and hooks are off. Read-only tasks run `--ephemeral` and return `thread_id: null` (send a new full task instead of resuming), unless they resumed a writer thread. A resumed run marks its usage `usage_scope: "thread_total"`.
- Without `cwd`, Codex runs in the `cwd` of the most specific `workspaces` entry (`{path, cwd}`) that contains the session workspace, else in the session workspace. `readOnlyEffort` sets the default effort for read-only tasks.
- With `write=true`, `writable_roots` supplies existing directories outside `cwd` that this invocation may write while retaining the workspace sandbox, including Windows drive paths. The runner maps them to WSL paths and uses the same per-invocation override for fresh and resumed runs. Omission preserves Codex's configured roots. `scope` must still include every intended write target; snapshots still cover only `cwd`. The standalone runner accepts repeated `--writable-root DIR`. Windows executable interoperability still requires `host_access=true`.
- When the agent's preset offers DSH background jobs, every `codex_run` registers one background job as soon as Codex starts, so the run shows up in the DSH task list at once with a progress line (refreshed about every 20 s: seconds since Codex's last event and its latest action). A run that ends within `wait_seconds` returns its result directly; a longer one keeps running in the background; when it ends, DSH posts a one-line job notification and the agent reads the full result (report and next step) with `job_output`. A finished run's task-list row and the first line of its result start with a one-line summary such as `completed · 12 met / 1 blocked · 3 files · 148 s` (failed or cancelled runs: status, error kind, duration). The row is titled `Codex <job_id> · <first line of the task>`; in the chat, the `codex_run` card shows `Codex · <first line of the task>` while running and the summary once done. A cancelled run is not treated as a failure: the next step says to ask the user and warns that a writer may have left partial, unlisted edits. Finished rows stay in the task list; archiving a session can cancel a running Codex job, and aborting the tool call cancels Codex; unconfirmed cancellation keeps the job id and asks the caller to check its status. Without a jobs service, poll with `codex_status`.
- Planner requirements: standing instructions for the agent itself (how to split work and write task and acceptance criteria) live in `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` (config `plannerPromptFile`; `loaded.json` shows the real path). The plugin creates a comment-only template; everything outside HTML comments is injected as a system-prompt section on every step, survives context compaction, takes effect on the next step after saving, and is never sent to Codex verbatim. When it is set, each completed `codex_run` next step also reminds the agent to check it.
- In configured `workspaces` (`'*'` matches every session workspace), the agent's own file-writing tools are denied and shell tools only run read-only verification commands (`sed` only as `sed -n '<addr>p[;<addr>p…]' file...`; no `$((...))`). Argument-filtered commands reject `$` and unquoted brace expansions; redirection targets receive substitution checks, and variable-test/read destinations must be literal; caller-selected Git pagers, Go execution tools and sort compression programs/random sources are refused. Read-only Git config, remote, tag and stash forms are supported. Invalid `allowCommands` regexes are warned about and skipped without disabling the guard. A denial names the refused structure or the first refused command segment. PowerShell syntax checks go through the bundled `tools/Test-PsSyntax.ps1` (`pwsh -NoProfile -File <that script> a.ps1 ...`). Dispatch reminders query the current agent's live DSH jobs, including after plugin reloads; another agent's jobs do not suppress them.
- Tests: `node --test test.mjs workflow.test.mjs runtime.test.mjs` and `python3 runner/test_codex_runner.py`; GitHub Actions runs both on Ubuntu and Windows.
- Requires Windows with WSL2, Codex CLI and `python3` (3.11+) inside WSL, and DSH `>=0.2.1-rc.2 <0.3.0`. Install with `github:xiaobaifly7/dsh-codex-conductor`.

## License

[MIT](LICENSE)
