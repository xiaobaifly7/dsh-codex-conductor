# dsh-codex-conductor

DeepSeek Harness（DSH）插件：DSH 里的 agent 负责规划和验收，编码任务交给 WSL 里的 Codex CLI 执行。

[English](#english)

## 功能

**派活工具**

| 工具 | 作用 |
| --- | --- |
| `codex_run` | 把任务交给 WSL 里的 Codex 并等待结果。必填 `task`、`acceptance`（至少 1 条验收标准，条数不限，每条至少 4 个字符）和 `write`（要改文件、做修复或建备份传 `true`，只读调查传 `false`）；可选 `host_access`（需开启 `allowHostAccess`）、`scope`、`writable_roots`、`cwd`、`resume`、`use_user_config`、`effort`、`wait_seconds` |
| `codex_status` | 查询或继续等待任务；仍在执行时返回距 Codex 上次活动的秒数和它最近的动作。已登记为 DSH 后台任务的不必调用 |
| `codex_cancel` | 取消任务，在 WSL 内结束 Codex 的整个进程树；任务已经结束时返回它的结果和下一步 |
| `codex_jobs` | 按工作区、会话、执行状态或待关注状态分页查询任务，找回 runner job ID、Codex thread ID 和 Harness 后台任务编号 |
| `codex_output` | 按 Unicode 字符分页、可重复读取完整原始报告、结果 JSON 或原任务与验收上下文；读取不消费结果，也不启动或恢复任务 |
| `codex_continue` | 回答阻塞问题或提供环境恢复依据后续接原任务；保留原线程、目录、验收、write、scope 和权限，同一父任务不重复派活 |
| `codex_review` | 保存规划端逐条独立核验的证据与结论；通过、待修正、明确接受偏差分别记录，原报告保留 |
| `codex_summary` | 按 Codex 线程汇总多轮结果、涉及文件、未闭环事项、已结束耗时和用量；执行状态与独立核验分别展示，不重复相加线程累计用量 |
| `codex_watch` | 安静观察当前会话的原生 Codex 后台任务，首次重要变化时通知；停止观察不会取消 Codex |
| `codex_runtime` | 查看源码与实际加载版本；明确请求立即重载或等任务空闲后重载，收到真实加载标记才确认生效 |

### 任务生命周期

- 任务目录：传了 `cwd` 就用它；否则会话工作区落在某个带 `cwd` 的 `workspaces` 条目里时，用该条目的 `cwd`（有多条时取路径最长的那条）；再否则用会话工作区。只在 `task` 里写目录不会切换任务目录。

收到需要回答的问题后，规划端先问用户，再调用例如 `codex_continue({"job_id":"J1","answers":[{"id":"choice","answer":"采用已确认的方案"}]})`。环境恢复时用 `resolution` 写实际证据。续接不会修改原验收或增加写权限；历史归属未知、状态未知或已取消的任务不会自动恢复。已存在后续轮次时返回它，后续处理使用最新 `job_id`，避免同一父任务反复派活。续接累计保留原目标、历轮用户决定与本轮补充；没有可续接线程时，另开线程也会带入这些决定，不堆叠历轮报告。

`codex_watch({"mode":"attention"})` 仅在失败、阻塞或报告异常等变化时通知；`mode="all"` 也包含开始和正常结束。它在无变化时只读 Harness 内存任务表，不启动 Codex、不反复唤醒模型。首次符合条件的变化后观察结束，需要继续时再调用。它保留任务原有结束通知，也不默认启用长期监控；取消观察只停止观察。

`codex_runtime({"action":"status"})` 显示磁盘源码版本、实际加载记录、待生效差异和活任务数。`action="reload"` 默认 `when="idle"`，有任务时登记原生后台等待，查询期间又有任务启动时会重新确认空闲；`when="now"` 明确要求立即热重载，旧任务继续运行。先配置 `runtimeProfileFile` 为这个桌面实例实际使用的 `cordis.patch.yml` 的完整 Windows 路径。只更新本插件的 entry id 与模块 URL，不重启宿主、不结束 Codex；未取得新模块加载确认时不会显示“已生效”。
配置已改到另一模块路径时，状态可显示唯一使用本插件生成 ID 的目标，并提示在 Harness 内刷新；旧实例不能改写该条目。

- 任务在 WSL 后台运行，DSH 这边断开等待不影响任务；重试、超时、断线检测和目录写锁由随包的 [`runner/codex_runner.py`](runner/codex_runner.py) 处理。路由不可用时的重试保留尚未发送的任务提示；启动与取消同步，PID 或事件日志写入失败也会结束并回收子进程。即使 Codex 提前关闭标准输出但进程仍存活，超时、空闲和断线预算仍然生效。

- 可写任务锁住任务目录；`workspace-write` 还会锁住本次显式指定的额外可写根。因此，不同 `cwd` 共用同一额外可写根的任务也会互斥。任一所需目录的写锁被占用时，后来的任务自动等待，状态为 `running`、阶段为 `lock_wait`，面板显示“排队等待目录写锁”。获得锁之前不会启动 Codex、检查路由或拍改动快照；取消这个排队任务不会取消持锁任务。继续用原 `job_id` 等待，不要重新派活。多个等待任务不保证严格先来先服务；`--timeout` 仍只限制每次 Codex 尝试，不包含排队时间，不想继续等时用 `codex_cancel`。

- 插件每次调用 `wsl.exe` 都有上限：`start` 和 `cancel` 120 秒，`status` 在它自己的等待秒数之外再留 60 秒。计时按 1 秒一跳，电脑睡眠唤醒不会立刻误判超时。WSL 卡住或起不来时按 `bridge_error` 返回，工具调用不会一直挂着；已知 `job_id` 的任务这时提示先用 `codex_status` 查询，不要直接重派，后台监控也会容忍偶发的一两次 `bridge_error`。

- Harness 重开后，恢复原会话时会接回该会话已登记、未结算的 Codex 作业；热更新时也会检查当前已打开的会话。只接回归属能确认的原作业，不重新派发，结束结果仍走原生后台通知。
- WSL 重启后，runner 按「开机 ID + 本发行版 init 的启动时刻」认出重启前的任务（`wsl --shutdown`、Windows 重启换开机 ID，`wsl --terminate`、发行版自行停止换 init 启动时刻），报 `worker_died`（Codex 已开始会话的可写任务带回 `thread_id`，可以续跑；可写任务另提示退出前可能已改了一半且没有改动清单），状态查询和取消还会核对进程创建时刻，避免把同次启动内复用 PID 的其他进程当成本任务；重试等待期间也不沿用已退出 Codex 的进程记录。升级前未记录创建时刻的旧任务仍按启动批次和存活状态判断。`codex_cancel` 对已经结束的任务直接返回它的结果与对应下一步，不会叫 agent 重派。

- 任务表与结束通知：agent 的 preset 提供 DSH 后台任务（jobs）服务时，`codex_run` 一启动 Codex 就把它登记为一个后台任务（`Codex <job_id>`），DSH 任务表里立刻出现这一行，进度行约每 20 秒刷新一次，显示距 Codex 上次活动的秒数和它最近的动作。`codex_run` 经任务表等到 `wait_seconds`：这之前结束就直接返回结果，不另发通知；到点仍在执行时任务留在后台继续，结果里带 `background_job_id`，Codex 结束后 DSH 发一条只带一行摘要的任务通知，agent 用 `job_output` 读取与工具结果相同的完整文字（含逐条汇报和下一步）后继续，不用轮询。

- 同一个 runner 任务只登记一个后台任务（按 DSH 任务表判断，插件重载后也不重复）；对已登记的任务调用 `codex_status` 或 `codex_cancel` 会经 DSH 任务表等待，结果不会再作为通知重复送一次。等待中途停止工具调用时，插件结束这个后台任务（同时在 WSL 里取消 Codex），等它结算完再返回；取消未确认时保留任务编号并提示用 `codex_status` 查询，任务仍可能在运行。归档会话时，DSH 可能结束其中仍在运行的后台任务，Codex 任务随之取消。后台等待本身出错时送回 `monitor_failed`，提示 Codex 任务可能仍在运行、先用 `codex_status` 查询。没有 jobs 服务、登记失败或没有 agent 时，任务表里没有这一行，`codex_run` 直接等 runner 到 `wait_seconds`，之后照旧用 `codex_status` 轮询。

### 权限

- 交接时自动附加执行约束：不扩大范围；只改 `scope` 里的路径；任务与现状不符或验收标准互相冲突时不自行取舍，标为 `blocked` 并说明；不为通过验收去改验收脚本或判据。`scope` 只接受具体文件或目录，不展开通配符；动态命名的备份须在派活前确定具体文件名并列入。

- 任务明确禁止某些访问或状态变更时，交接提示要求执行端在运行相关脚本前先只读检查其行为；有冲突或无法确认时，不执行对应步骤并标为 `blocked`。

- Codex 的沙箱（只读和 `workspace-write` 都是）挡住了 WSL interop，Codex 在沙箱里启动不了 Windows 程序（`pwsh.exe`、Hyper-V 命令等）。默认情况下需要 Windows 运行时的检查不要写进 `task` / `acceptance`，由 agent 自己跑。

- 主机访问（默认关闭）：配置里开启 `allowHostAccess` 后，`codex_run` 才多出 `host_access` 参数，工具说明改为让 agent 在任务需要 Windows 程序、Hyper-V 或连接 Hyper-V 虚拟机时传 `host_access=true`。这时不管 `write`，Codex 都以 `danger-full-access` 运行：没有沙箱，对整台机器有完全访问权限，可以通过 WSL interop 启动 Windows 程序、使用 Windows 那边的网络。交接提示里多一条约束：只做任务需要的事，任务没点名的虚拟机、文件和网络设置不删除、不停止、不重建、不改配置。`write` 仍决定能不能改动，但 `write=false` 时的只读只靠提示约束（再加一条：只读调查，不改文件，也不改虚拟机、网络或系统状态），没有沙箱拦着。runner 把这类任务都当可写任务：拿同目录写锁、做快照、不用 `--ephemeral`、返回可续跑的 `thread_id`。快照只扫描任务目录，范围外只补入已收到的 Codex 文件事件；Windows 文件、虚拟机内及其他未产生文件事件的改动仍需实际核验。没开启 `allowHostAccess` 时传 `host_access=true` 会直接报错。

- 默认（不传 `use_user_config`）按服务器逐个关掉 Codex 的 MCP：runner 读 `$CODEX_HOME/config.toml`（没设 `CODEX_HOME` 时读 `~/.codex/config.toml`），对 `[mcp_servers]` 下的每一项传 `-c mcp_servers.<名字>.enabled=false`，并关掉 hooks。Codex 插件自带的 MCP 不在 `config.toml` 里，管不到；名字里带 `.` 的服务器也关不掉（Codex 按 `.` 切分 `-c` 的键）。文件不存在或解析不了时不加参数。`use_user_config=true` 时照常加载这些 MCP 和 hooks。

- 只读任务（`write=false`，也没传 `host_access=true`）以 `--ephemeral` 运行、不留会话记录，返回的 `thread_id` 为 `null`，下一步提示改为重新派一个写全背景的完整任务，而不是 `resume`。只读任务若是 `resume` 了某个写任务的线程，则返回那个线程的 id，仍可续跑。

- 沙箱内跨目录写入：`write=true` 时，`writable_roots` 可为本次任务指定额外可写目录，支持 Windows 路径和 `/mnt/...` 路径，首次运行和 `resume` 都生效。例如 `cwd="D:\\work\\project"`、`writable_roots=["E:\\results"]`，可在保留 `workspace-write` 沙箱的同时写入已有的 E 盘结果目录。`scope` 仍须列出全部允许修改的文件或目录（包括复制目的地）；它本身不增加沙箱权限。省略 `writable_roots` 沿用 Codex 原配置，传入时仅为本次调用覆盖额外可写目录列表。快照仍只扫描 `cwd`；额外目录中已收到的 Codex 文件事件会合并到改动清单，shell 写入等未产生文件事件的改动需检查实际文件。需要启动 Windows 程序或检查 Windows ACL 时仍用 `host_access=true`；主机访问模式已经没有沙箱，不需要再传 `writable_roots`。

### 报告

阻塞报告使用 [`report.v2.schema.json`](report.v2.schema.json)：在原五字段上新增 `blockers`。每项有 `id / kind / message / question / resolution`，区分缺用户信息、任务冲突、环境条件和实现待修。`resolution` 是解除条件或已有信息，非空不代表已经解决。不按报错关键词猜类别；旧报告没有分类时先查明原因。旧 [`report.schema.json`](report.schema.json) 保留五字段，供热重载前仍在运行的旧版本使用；新版可读取两种报告。

独立核验使用 `codex_review`：`criteria` 用原验收标准从 1 开始的 `index`，逐项提供 `status` 和实际 `evidence`；结论为 `verified / needs_changes / accepted_deviations`。通过结论要求各项实际通过；有报告偏差或范围外改动时，必须在 `accepted_deviations` 中按 `reported / scope` 与 1 起始编号逐项说明接受依据。历史存入任务目录的 `reviews.json`，原 `result.json` 和 Codex 报告不改写；可用 `codex_output` 的 `artifact="review"` 分页重读。

`codex_summary()` 默认汇总当前会话；传 `cwd` 可汇总一个项目，`thread_id` 可只看一个线程。默认每页 10 组，沿用筛选和 `limit`，用 `next_offset` 作为下次的 `offset` 翻页；总组数和总轮数始终按全部匹配记录计算。没有线程号的任务独立成组。最新轮次的执行状态与独立核验结论分开显示，不能据此宣称整个项目永久无问题。线程累计 token 只取最新可用累计值；混合或未知统计口径会明确标出，耗时只加总已结束轮次。

- 无法查询任务、记录损坏或监控失联时，`execution_status="unknown"` 表示执行结果未确认；`report_status="missing"` 只表示当前未取得结构化报告。取消遇到这些状态或任务仍在运行时会明确提示“取消未确认”，不能据此宣称任务已经结束或直接重派；启动调用未取得任务编号时，也先按相同任务目录查询历史找回 ID。历史范围判断使用已记录的规范化路径，后续文件被替换成符号链接不会改写那次任务的范围结论。

- 执行、报告和验收分别显示：`execution_status` 是执行状态；`report_status` 为 `valid / invalid / missing / pending`；`review_status` 为 `needs_attention / needs_verification / pending`。格式错误、受阻、未满足、有未解决事项、偏离计划或超出范围的任务列为待关注；模型自报全部满足也仅为待核验，不代表已独立验收通过。摘要同步显示“待关注”“待核验”或“报告异常”。

- 进度包含尝试轮次、当前阶段、上次错误分类和下次重试时间；阶段区分检查路由、Codex 执行、等待重试和生成最终结果。进度查询不改变超时或重试策略。

- 原生任务面板会记录进度和最终报告，完成后也可展开。取消请求未确认时持续显示失败原因和任务编号；取消结果保留目录、权限模式和已有可续跑线程信息，仍由用户决定是否恢复，不自动重派，也不将缺少改动清单解释为没有改动。

- 要求 Codex 按 [`report.v2.schema.json`](report.v2.schema.json) 逐条回报（met / not_met / blocked、证据、改动文件、偏离计划、未解决）。结果里会标出它自报未满足或受阻的条目、偏离计划的地方，以及超出 `scope` 的改动。最终答复的版式由插件固定为这份 JSON：`task` / `acceptance` 里对版式的要求（如单独的末行结论行）写进 `summary` 就算满足，Codex 不会因此标 `blocked`；工具说明也让 agent 不要再规定这类版式。

- 已完成的结果保留核验所需信息：汇报条数和编号与验收标准对得上时，逐条显示验收原文，下一步按编号指出未满足项；逐条汇报的每条证据最多显示 800 字，全文在 `log_dir` 下的 `last_message.txt`。详细字段包含任务目录、一行改动清单、执行/报告/自报检查状态、已有的独立核验结论与证据、用量（不是费用），以及核验异常、忽略规则警告等提示。改动超过 300 个时只列前 300 个，并说明超出 `scope` 的检查也只覆盖这些；报告容器不合法时退回原始答复。失败、取消和仍在执行的结果保留诊断字段；完整原始字段在 `runnerHome/jobs/<job_id>/result.json`。阻塞按明确分类处理，续接沿用原 write、scope 和主机权限；需要扩大授权时另行明确派活。

- 一行摘要：任务结束后，任务表那一行和结果的第一行都以一行摘要开头，如 `completed · 12 met / 1 blocked · 3 files · 148 s`（状态、按 met / not_met / blocked 计的验收条数、改动文件数、用时；只读任务没有文件数），失败或取消时是 `failed · timeout · 30 s` 这样的状态、错误类型和用时；结果第一行在摘要后照旧带 `job_id` 和 `thread_id`。结束的行留在任务表里，摘要就在那里看。任务表那一行的标题是 `Codex <job_id> · <任务第一行>`；聊天里 `codex_run` 的卡片进行中显示 `Codex · <任务第一行>`（返工、带 host_access 时会注明），结束后标题换成同一行摘要。被取消的任务不按失败处理：提示先问用户，并提醒可写任务可能已改了一半、没有改动清单。

- 续跑（`resume`）时 Codex 报的用量是整个线程的累计值，结果里在 `usage` 旁加 `usage_scope: "thread_total"`（不换算成本次增量）；只读任务重试时放弃续跑、从头开始，这时的用量只算本次，不加这个标记。

### 存储

- 历史查询默认使用当前工作区；`session_id="current"` 查询当前会话，也可指定会话 ID。新任务将 owner、原任务、原验收标准和写入意图保存在已有任务参数中，长任务不会受 Windows 命令行参数长度影响。旧任务优先关联 Harness 会话 journal 和原生任务表；无法确认归属的保留未知，可按工作区找回。完整上下文用 `codex_output` 的 `artifact="context"` 读取。

- 完整结果读取使用 `job_id`，不是 `background_job_id`：`artifact="report"` 读取原始报告，`result` 读取执行结果，`context` 读取原任务与验收。默认每段 4000 个 Unicode 字符，最多 8000；按返回的 `next_offset` 继续读取，直至 `eof=true`。这也适用于 `job_output` 已消费或被 64 KiB 上限截断的结果。旧任务没有保存上下文时会明确说明。

- 可写任务前后对任务目录做快照，列出新增、修改（包括文件权限变化）、删除的文件（`files_changed_source` 为 `snapshot`）。快照也会记下同时段其他进程写的文件（如定期日志），所以“超出 scope”的清单里可能有它们；提示里会说明：不在 Codex 自报 `files_changed` 里、明显来自其他进程的文件只需一句说明，不算 Codex 越界，也不用请用户决定。完整快照成功时也会合并 `cwd` 外已收到的 Codex 文件事件（`snapshot+codex_events`），目录内以快照为准；权限或 IO 错误导致快照读取失败时退回文件事件，不把不完整扫描当成删除依据。事件只覆盖 Codex 自己的改文件工具，不包含 shell 写入，也不会为补全清单而扫描额外目录。

- 总是由其他进程写的文件可以写进配置 `ignoreChanges`：按 Python `re` 方言验证和匹配，不能使用 JavaScript 专属语法；无效模式跳过，并在任务结果中明确警告。runner 在截取前 300 条之前就去掉匹配的文件，它们不计入改动清单、改动数和超出 `scope` 的检查（`result.json` 里也不再记录）；交接提示里会告诉 Codex 这些文件可能被其他进程改动，不要因此判定现状不符或标 `blocked`，任务本身要求处理它们时照常处理。

- 目录大到 20 秒内扫不完时，7 天内同一目录不再整树扫描：给了 `scope` 就只快照 `scope` 里的路径，`scope` 之外的改动取 Codex 自报的记录（`scope_snapshot+codex_events`）；没给 `scope` 就只用 Codex 自报的改动（`codex_events`）。

- `start` 顺带清理结果已保存超过 30 天的已结束 `jobs` / `runs` 目录；运行中和排队任务会保留，不因目录时间较旧而删除。

- 规划要求：你写给 DeepSeek 自己的固定规划要求（怎么拆任务、写 task 和验收标准时要注意什么），放在 `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md`（DSH 便携版在其数据目录的 `local\dsh-codex-conductor\` 下；`loaded.json` 里的 `plannerPromptFile` 是实际路径）。插件首次加载时放一份只有注释的模板；注释以外的内容作为系统提示词的一段注入，agent 每一步都带着，压缩上下文也不会丢；保存后下一步就生效，不用重载。它不会原样发给 Codex。设了内容时，每次 `codex_run` 完成的下一步提示里也会提醒对照这些要求。宿主没有系统提示词服务时不注入，其余功能照常。

### 工作区护栏

工具始终注册；`workspaces` 只控制护栏。会话工作区在配置范围内时，以下规则生效。Linux 原生路径也受支持，`workspaces: ["/"]` 覆盖原生 Linux 根目录及其子目录，`scope` 也可使用 `/`；Windows 盘符及 `/mnt/<盘符>/...` 仍按 Windows 路径匹配。

- 拒绝直接写文件或执行任意代码的工具：`write`、`edit`、`pwsh`、`run_code`、`subagent_codex`，以及 `wsl-write`、`wsl-edit`、`wsl-term`、`wsl-bootstrap`、`actions_run`、`actions_configure`；MCP 工具按动作名拒绝（`write`、`edit`、`replace`、`insert`、`delete`、`execute` 等）。
- Seep 的 `seep_r2_cmd` 是任意 radare2 命令入口，在受保护工作区交给 Codex 执行；`seep_r2_info`、`seep_status` 等结构化查询仍可用于只读核验。
- shell 工具（`wsl`、`bash`、`ops_bash`）只放行只读核验命令：`git status/diff/log/show`、`ls`、`cat`、`grep`、`find`、`wc`、`sha256sum`、`pytest`、`npm test`、`pwsh -File tests/*.ps1`、`bash -n` 等；可以用 `|`、`&&`、`for`、`if` 和只读的 `$(...)`；拒绝写重定向（`/dev/null` 除外）、反引号、heredoc、`$((...))` 和 `$[...]` 算术；单引号或转义后的算术文本仍可作为字面量。`pwsh` / `powershell` 必须写成字面命令或路径，`$PWSH` 这类变量不放行。
- 支持不带参数、引号或转义的 `:` 和 `continue`；经 `timeout` 包装或作为可执行文件路径调用时仍拒绝。
- 支持直接用 `command -v 名称…` 查询字面命令名；普通 `command` 执行、展开的操作数、包装器和程序路径形式仍拒绝。
- 只读子 shell 的开括号可以贴着命令，例如 `(cd 目录; ls )`；其中每段命令仍接受只读核验，算术和函数定义不放行。
- `>&` 仅支持完整的数字文件描述符（如 `2>&1`）；数字开头的文件目标不放行。
- PowerShell 的 `-Command` 形式（包括只读查询）默认拒绝。需要 Windows 执行与核验时，交给主机访问模式的 Codex，或使用项目 `tests` 目录下的已有验证脚本。
- `gzip` 只放行首参数为字面量 `-t` 或 `--test` 的压缩文件完整性检查；直接压缩、解压文件的形式仍然拒绝。
- 查看本地 gzip 压缩归档内容可用 `env -u TAR_OPTIONS tar -tzvf ./archive.tar.gz`。只接受一个固定本地路径；移除 `TAR_OPTIONS` 后才允许列目录，解包、远程归档和额外选项仍拒绝。
- `sed` 只放行 `sed -n '<地址>p' 文件…`，支持用 `;` 分隔多段打印（如 `1,5p;20,25p`）：地址是行号、`N,M` 或 `/正则/`（可带第二个 `/正则/`），正则里不能有 `\` 和 `$`；后面的参数不能以 `-` 开头（`-i`、`--in-place`、`-e`、`-f` 都不行），也不能含 `$` 或 `{`。取末行用 `tail`。`printf -v` 和含 `$` 的首参数不放行，其余输出参数仍可用变量和只读命令替换。
- 有参数过滤的命令（`git`、`find`、`sort`、`uniq`、`iconv`、`rg`、`tree`、`file`、`date`、`node`、`go`、`cargo`、`make`、`npm/pnpm/yarn`）不接受含 `$` 的参数、未引用的花括号展开或可能展开成选项的未引用 glob（如 `find . -[d]elete`）；带固定路径前缀的匹配（如 `find src/* -type f`、`git diff src/*.mjs`）和引用的字面模式仍可用；`cat $(ls)` 这类读取也不受此限制。输入重定向的目标也接受同样的替换检查；`-v/-R` 和 `read` 的赋值目标必须是安全的字面变量名，`read` 的提示文本仍可使用变量。`git grep -O/--open-files-in-pager`、Go 的 `-exec/-toolexec/-vettool`、`sort --compress-program/--random-source` 不放行。Git 另支持 `config --get/-l/--list`、`remote [-v/--verbose]`、`tag -l/--list` 和 `stash list` 这些只读形式。
- `file` 的 `-C/--compile` 编译模式、`date` 的 `-s/--set` 和直接设时间形式不放行，也覆盖短选项组合及长选项缩写。Git 的 `--ext-diff/--textconv` 及有效缩写（如 `--ext-d`、`--textc`）被拒绝，合法只读选项 `--text` 仍可用。
- `bash -n` / `sh -n` 只接受静态文件参数，禁止 `+n`、变量和未引用的展开；`test` / `[` 只接受静态操作符，文件名和字符串仍可用引用变量。`uniq` 不接受未引用的通配符；`tree` 的 `-o` 及含它的短选项组合均不放行。
- 拒绝时说明原因：命令结构本身不放行时，列出不放行的结构（写到 `/dev/null` 以外的重定向、反引号、heredoc、`$((...))`、`$[...]`、进程替换、`$(...)` 里的非只读命令、未闭合引号）；否则指出第一段不放行的命令（去掉流程关键字和 `timeout N` 前缀后，截取前 200 字）。
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

默认提供十个工具，不启用护栏；Codex 用它自己的模型和登录配置，但默认不加载它配置的 MCP 和 hooks（见上文）。按插件 id 覆盖 `config`：

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
| `workspaces` | `[]` | 启用护栏的工作区，子目录同样生效；`'*'` 匹配所有会话工作区。条目可以是路径字符串（Windows、`/mnt/...` 或原生 Linux 路径，包括 `/`），也可以是 `{path, cwd}`：`path` 用于护栏判断，`cwd` 是会话工作区在 `path` 内时 `codex_run` 的默认任务目录 |
| `distro` | WSL 默认发行版 | 运行 Codex 的发行版 |
| `codexBin` | 自动查找 | WSL 内 codex 的路径；默认先查 PATH（跳过 `/mnt/` 下的 Windows 版），再查 `~/.npm-global/bin`、`~/.local/bin`、`/usr/local/bin` |
| `codexHome` | Codex 默认 | 传给 Codex 的 `CODEX_HOME` |
| `runnerHome` | `~/.local/state/codex-runner` | 任务记录和日志目录 |
| `routerCheckUrl` | 空 | Codex 使用固定本机模型网关时，可填其 HTTP(S) 地址。runner 在 WSL 内先探测该主机和端口；不可达时报 `router_down`，不会先启动 Codex。仅探测，不修改模型配置。 |
| `model` | Codex 配置 | 默认模型 |
| `effort` | Codex 配置 | 默认推理强度，`codex_run` 的 `effort` 可单次覆盖 |
| `readOnlyEffort` | 同 `effort` | 只读任务（`write=false`）的默认推理强度，留空时用 `effort` |
| `serviceTier` | Codex 配置 | 例如 `fast`（Codex 的 Fast 模式） |
| `waitSeconds` | `1500` | `codex_run` 默认等待秒数，到时任务转后台 |
| `allowHostAccess` | `false` | 为 `true` 时 `codex_run` 才提供 `host_access` 参数，允许 Codex 不带沙箱（`danger-full-access`）运行、启动 Windows 程序（见上文） |
| `defaultHostAccess` | `false` | 与 `allowHostAccess=true` 一起使用，省略 `host_access` 的新任务和 `resume` 默认以 `danger-full-access` 运行；显式传 `host_access=false` 可为单次任务恢复沙箱 |
| `plannerPromptFile` | `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` | 规划要求文件（Markdown，HTML 注释不算内容），注入 agent 的系统提示词（见上文） |
| `runtimeProfileFile` | 空 | 当前 Harness 实例实际使用的 `cordis.patch.yml` 完整 Windows 路径；用于版本匹配与明确请求的热重载，留空时不能自动重载 |
| `allowCommands` | `[]` | 额外放行的命令，JavaScript 正则逐段匹配（按 `\|`、`&&`、`;` 切开后的每一段），建议写成锚定正则；非法正则会警告并跳过，护栏和其余条目照常生效 |
| `ignoreChanges` | `[]` | 改动清单里忽略的文件，Python `re` 正则匹配相对任务目录的路径（`/` 分隔），用于其他进程定期写的日志等；runner 在截取改动清单之前过滤，匹配的文件不计入改动数和超出 `scope` 的检查，交接提示里会告诉 Codex 它们可能被其他进程改动。无效模式由 runner 跳过，并在任务结果的 `ignore_warnings` 和展示文字中警告 |
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

每条命令只在 stdout 输出一个 JSON 对象，原始事件写入日志目录。`--scope` 可重复，写相对 `--cwd` 的路径或绝对路径，只在目录太大、无法整树快照时用来缩小快照范围；插件把 `codex_run` 的 `scope` 逐条传入。结果中的 `cwd` 和传入 scope 时的 `scope_paths` 是规范化的真实绝对路径，快照、事件和范围检查共用这个基准，避免目录别名造成重复改动或误报越界。`--writable-root` 也可重复，只在 `workspace-write` 下增加本次调用的可写目录（目录须已存在），不改变只读模式。`--ignore` 也可重复：路径（相对 `--cwd`）匹配这些 Python `re` 正则的改动在截取前 300 条之前就从 `files_changed` 里去掉；插件把 `ignoreChanges` 逐条传入。

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

A DeepSeek Harness plugin: the DSH agent plans and verifies; Codex CLI in WSL codes. All [ten tools](#功能) are always registered; `workspaces` only controls the guard. See the [configuration table](#配置) for defaults and parameters.

### Task lifecycle

`codex_run` requires acceptance criteria and an explicit `write` (`true` for changes, `false` for read-only investigation). Criteria have no item-count limit; dispatch, continuation, reports and independent review preserve their full list and order. Explicit `cwd` wins; otherwise use the most specific matching `{path, cwd}` workspace entry, then the session workspace. Mentioning a directory only in the task does not change it.

`codex_continue` accepts typed blocker answers or environment-recovery evidence, preserving the original thread, directory, acceptance, write, scope and host access. Existing continuations are reused; further work uses the latest child `job_id`. Without a resumable thread, accumulated user decisions accompany the original context into a new thread, without stacking old reports. Unknown ownership/state and cancellation prevent automatic continuation.

The bundled runner handles background execution, retries, timeouts, idle/reconnect detection and thread resumption; disconnecting a wait does not stop it. Unsent prompts survive route retries, and PID/event-log write failures terminate and reap children. Closing stdout while still alive does not bypass the configured timeout, idle or reconnect budget.

Writers lock `cwd`; `workspace-write` also locks explicitly supplied `writable_roots`, so different working directories sharing an extra root serialize. Queued jobs remain `running` with phase `lock_wait`; Codex, route checks and snapshots start after all required locks are obtained. Cancelling a waiter leaves its holder alone. Wait on the original ID; admission is not strictly FIFO, and per-attempt `--timeout` excludes lock waiting.

Each `wsl.exe` call is bounded: `start`/`cancel` 120 seconds, `status` its wait plus 60 seconds. One-second ticks avoid false timeouts after host sleep. Hung WSL returns `bridge_error`; query a known `job_id` before redispatching. Monitoring tolerates occasional transient bridge errors.

After Harness reopens, resuming an existing session reattaches its recorded, unsettled Codex jobs. Hot reload also checks open sessions. Recovery verifies the runner's owner, preserves native completion delivery, and never starts another Codex run.

WSL restarts are recognized by boot ID and distro init start time, including shutdown, termination and auto-stop. Earlier tasks become `worker_died`; writers retain a started thread but may leave partial, unlisted edits. Status/cancellation also check process creation time to avoid same-boot PID reuse; finished Codex identities are not retained during retry waits. Older records without creation times retain boot/liveness checks. Cancellation ends the task's process tree; an already-ended task returns its result and matching next step instead of requesting redispatch.

With DSH background jobs, each `codex_run` immediately registers one row, reused across plugin reloads. Progress refreshes about every 20 seconds with last-activity age and latest action. Finishing within `wait_seconds` returns directly; otherwise `background_job_id` identifies the continuing job. Completion sends a one-line notification; read its full report/next step with `job_output`, without polling or duplicate delivery from status/cancel waits.

Finished rows retain output. Aborting a waiting call cancels Codex; session archival can also cancel it. Unconfirmed cancellation keeps its ID and requires a status check; `monitor_failed` means Codex may still run. Without native jobs/registration, `codex_run` waits directly, then callers poll `codex_status`.

`codex_watch` observes native task changes without model polling or idle WSL calls. `attention` reports failures, blockers and report problems; `all` also includes starts/normal completion. It ends after the first matching change; stopping it only stops observation and preserves normal completion notifications.

`codex_runtime` compares source and loaded versions. Set `runtimeProfileFile` to the actual desktop profile. Reload defaults to `when="idle"`, waiting through native jobs and reconfirming idle if a task starts during listing. `when="now"` explicitly reloads immediately while old tasks continue. Only this plugin's entry ID/module URL change; confirmation requires the new loaded marker, without restarting the host.
When the profile points at a different module path, status can show the single target with a generated conductor ID. The old instance cannot edit that target and asks for a Harness refresh.

### Permissions

The hand-off forbids scope expansion and changing acceptance scripts/criteria to pass. Conflicting requirements produce `blocked`. Scope accepts concrete paths, not globs; determine backup names before dispatch. For prohibited access/state changes, inspect scripts read-only before running and stop when conflicting or uncertain.

Codex's read-only and `workspace-write` sandboxes block WSL interop, including Windows programs and Hyper-V commands; the planning agent runs Windows-only checks by default. With `allowHostAccess: true` (off by default), `host_access=true` uses `danger-full-access`: no sandbox, full machine access and Windows interoperability. Unrelated VMs, files and networking must remain untouched. `write=false` then relies only on prompts; the runner still uses writer locks, snapshots and resumable threads. Passing host access without enabling it is an error.

Unless `use_user_config=true`, MCP servers in `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) are disabled individually with `-c mcp_servers.<name>.enabled=false`, and hooks are off. Codex-plugin servers and names containing `.` are not covered; missing/unparseable configs add no MCP overrides. Read-only tasks use `--ephemeral` and return `thread_id: null`: resend full context instead of resuming, unless they resumed a writer thread. `readOnlyEffort` sets their default effort.

With `write=true`, `writable_roots` grants existing extra directories for this invocation while retaining the workspace sandbox, including Windows drive paths. Fresh/resumed runs use the same override; omission preserves Codex's configured roots. Scope must include intended destinations and grants no permissions itself. Snapshots scan only `cwd`; outside events supplement them, but unreported shell writes need direct verification. Windows interoperability still requires host access, where extra roots are unnecessary. Standalone runner: repeat `--writable-root DIR`.

### Reports

New tasks use [`report.v2.schema.json`](report.v2.schema.json), adding typed `blockers` to the original five fields. User input, task conflicts, environment conditions and implementation gaps require different next steps; nonempty `resolution` is not proof of resolution. Legacy reports remain readable. Do not infer permissions or blocker types from error keywords. Per-criterion reports flag unmet/blocked criteria, deviations, unresolved items and out-of-scope changes. The fixed JSON format satisfies presentation demands, such as a last-line verdict, through `summary`.

Execution, report validity and review state remain separate; all-met self-reports still need independent verification. Unknown/corrupt/disconnected status does not prove termination, nor does a missing report. Progress shows attempt, phase, last error and retry time. Cancellation failures remain visible until confirmed; cancelled writers may have partial, unlisted edits and require the user's decision before resumption.

Completed output uses original acceptance text when count/numbering match; next steps cite criterion numbers. Evidence is clipped to 800 characters, with full text in `last_message.txt` under `log_dir`; malformed report containers fall back to the original reply. Details show directory, one-line changes, execution/report/self-check state, available independent review conclusions/evidence, usage (not cost), and review/ignore warnings. Lists over 300 changes show the first 300 and disclose the same scope-check limit. Failed/cancelled/running results retain diagnostic fields; complete raw fields remain in `result.json`.

Rows/results start with a summary such as `completed · 12 met / 1 blocked · 3 files · 148 s`; read-only tasks omit file counts. Failed/cancelled summaries show status, error kind and duration. Result headers retain job/thread IDs. Rows use `Codex <job_id> · <task first line>`; running chat cards show `Codex · <task first line>` with resume/host-access labels, then the summary once done.

`codex_review` records independent per-criterion evidence in `reviews.json`, preserving original reports/results. Passing conclusions require every criterion to pass and explicit acceptance of reported deviations/out-of-scope changes; use `verified / needs_changes / accepted_deviations`. Re-read with `codex_output artifact="review"`; record gaps before continuing under original permissions.

`codex_summary` groups actual threads, separating unthreaded jobs; default selection is the current session, with `cwd`/`thread_id` filters. It returns 10 groups per page by default; keep the same filters and `limit`, and pass `next_offset` as `offset` to continue. Group and round totals cover all matches. It shows files, open items and finished-round durations while keeping execution and verification separate, without claiming permanent project-wide correctness. Resumed usage is `usage_scope: "thread_total"`: take the latest cumulative value, never sum it repeatedly. Mixed/unknown accounting is marked; read-only retries start fresh and omit that cumulative mark.

### Storage

`codex_jobs` queries workspace/session history by execution or attention state, linking runner/thread/native IDs and session journals. New jobs preserve original task/acceptance, owner and write context without a separate database or Windows command-line length limit. Unknown legacy ownership remains unknown and can be found by workspace. Stored normalized paths preserve historical scope conclusions after later symlink changes.

`codex_output` uses `job_id`, not `background_job_id`, to reread full `report`, `result`, `context` or `review` artifacts without consuming them or restarting tasks. Unicode pages default to 4000 characters, at most 8000; follow `next_offset` until `eof=true`. Full artifacts survive native `job_output` delivery/64 KiB truncation; missing legacy context is explicit.

Snapshots detect additions, modifications (including permissions) and deletions in `cwd` (`snapshot`). Successful full snapshots merge received outside events (`snapshot+codex_events`), retaining snapshot precedence inside. Permission/IO failures fall back to events instead of inferring deletion from incomplete scans. Events cover Codex's file-edit tools, not shell writes; extra directories are not scanned. Unreported host/Windows/VM changes require direct checks.

Snapshots may catch other processes' writes, such as logs. Clearly unrelated files absent from Codex's own list need only an explanation. `ignoreChanges` uses Python `re` on relative `/`-separated paths; `(?P<log>^logs/)` works, JavaScript's `(?<log>^logs/)` does not. Invalid patterns are skipped with explicit `ignore_warnings` in results/output. Matches are removed before the 300-entry cap from lists, counts and scope checks. The hand-off explains that independently changing files are not grounds for `blocked`; explicit task requirements still apply.

Trees exceeding the 20-second snapshot budget are remembered for seven days: snapshot supplied scope paths plus events elsewhere (`scope_snapshot+codex_events`), or events alone without scope (`codex_events`). `start` prunes only finished `jobs`/`runs` with results saved over 30 days ago; running/queued records remain regardless of directory age.

Planner instructions live in `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` (`plannerPromptFile` overrides it; `loaded.json` shows the actual path). A comment-only template is created; text outside HTML comments enters the planner's system prompt every step, survives compaction, applies after saving without reload, and is not sent verbatim to Codex. Completed runs remind the planner to check it when set.

### Workspace guard

Configured `workspaces` deny the agent's file-writing/arbitrary-execution tools. `'*'` covers every workspace; native Linux `/` covers the root and native descendants and also works as scope. Windows drives and `/mnt/<drive>/...` retain Windows-path matching. Seep's arbitrary `seep_r2_cmd` goes to Codex; structured `seep_r2_info`/`seep_status` queries remain available.

Shell verification permits pipelines, conditions, loops and read-only `$(...)`, but refuses non-null write redirection, backticks, heredocs, process substitution and arithmetic `$((...))`/`$[...]`. Single-quoted/escaped arithmetic text stays literal. Argument-filtered commands reject `$`, unquoted braces and unquoted globs capable of generating options (`find . -[d]elete`); fixed paths (`find src/* -type f`, `git diff src/*.mjs`) and quoted patterns remain supported.

`file -C/--compile`, `date -s/--set` and positional time setting are refused, including short-option combinations/long abbreviations. Git `--ext-diff/--textconv` abbreviations (`--ext-d`, `--textc`) are refused; `--text` stays valid. Caller-selected Git pagers, Go execution tools and sort compression/random sources remain denied. Read-only Git config, remote, tag and stash forms remain supported.

`sed` only allows `sed -n '<addr>p[;<addr>p…]' file...`. Redirection targets receive substitution checks; variable-test/read destinations must be literal. `allowCommands` uses JavaScript regexes; invalid patterns warn and are skipped without disabling the guard. Denials identify the structure or first refused segment. PowerShell syntax checks use bundled [`tools/Test-PsSyntax.ps1`](tools/Test-PsSyntax.ps1): `pwsh -NoProfile -File <that script> a.ps1 ...`. Dispatch reminders use this session's live jobs across reloads; other sessions' jobs do not suppress them. The guard is a workflow constraint, not a sandbox; test commands execute project code.

Bare, argument-free `:` and `continue` are supported. Quoted/escaped forms, `timeout` wrappers and executable paths remain refused.
Direct `command -v name …` lookup of literal command names is allowed; execution mode, expanded operands and wrapper/path invocations remain refused.
A read-only subshell can omit the space after its opening parenthesis, for example `(cd directory; ls )`. Arithmetic and function definitions remain refused.
`>&` accepts only a complete numeric file descriptor, such as `2>&1`, and rejects file targets that merely start with digits.
`env -u TAR_OPTIONS tar -tzvf ./archive.tar.gz` lists one literal local gzip archive. Extraction, remote archives, and extra options remain refused.

Requires Windows/WSL2, Codex CLI, Python 3.11+ in WSL, and DSH `>=0.2.1-rc.2 <0.3.0`. Install `github:xiaobaifly7/dsh-codex-conductor`; see [installation](#安装). Tests: `node --test test.mjs workflow.test.mjs runtime.test.mjs` and `python3 runner/test_codex_runner.py`; mocks need no DSH/real Codex. Platform/tool-specific cases skip when unavailable. CI runs both on Ubuntu/Windows with Node 22/Python 3.12.

## License

[MIT](LICENSE)
