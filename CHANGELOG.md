# 更新记录

[English](#english)

`0.9.101` 修正 0.9.100 的护栏回归：MCP 动作名里的 `save`、`update`、`copy`、`append` 只在对象是文件时才拒绝（如 `save_file`、`update_file`），git 写操作只认 `git_` 前缀；`memory_save`、`update_agent`、`push_notification` 这类不写文件的工具恢复为 0.9.99 的判定，不再被拒。

`0.9.100` 修复一轮代码审查发现的问题。Gemini 写作：覆盖已有文件时，Gemini 报成功却没有改写目标也判失败（沿用 0.9.99 的判定），不再把旧内容报成新正文；`frontmatter` 只剥离由键值和列表项组成的首块，以 `---` 分隔线开头的正文不再被删；超时或取消后结束 agy 进程树，5 秒内未关闭则强制收尾；失败回滚会删除本次新建的空父目录；`plannerReads: products` 的受护栏会话里，`sources` 必须落在工作区或 `plannerReadAllow` 内。护栏：词首 `#` 按 bash 注释处理（`$(...)` 内不放行），未引用的 `$'…'` / `$"…"` 和 `${ cmd; }` 不放行；测试运行器（pytest、unittest、`node --test`、npm/pnpm/yarn test、go、cargo、make）只接受固定开关和字面路径，`make` 只接受单独的 `make test` / `make check`；工具名不区分大小写，内置拒绝新增 `apply_patch`、`multi_edit`、`ops_write`、`ops_edit`，MCP 动作名识别 camelCase 和连字符及更多写入、执行动作；shell 工具拒绝 `env` / `stdin` 等会改变执行的参数；赋值前缀新增不放行 `RIPGREP_CONFIG_PATH`、`MAKEFILES`、`MAKEFLAGS`、`RUSTC*`、`RUSTFLAGS`、`CARGO_*`、`GOFLAGS`、`PYTEST_*`、`npm_config_*`；`allowCommands` 命中的命令仍受赋值前缀和参数展开检查；`rg --hostname-bin`、`tree -R` 不放行，超过 32 KB 的命令直接拒绝；读工具的路径别名全部检查；`workspaces: ["*"]` 也覆盖没有工作目录的会话，`\\wsl.localhost\<发行版>\…` 与对应的 `/mnt/<盘符>/…` 视为同一位置。新放行：首行和行尾注释、`[ "$(…)" -eq N ]`、`git merge-base` / `show-ref` / `reflog` / `branch --list <模式>`、`node|python --version`、不含 `print` 的 awk 比较；`gemini_write` 成功后读取目标不明的命令给出单独的拒绝说明。规划端：自动续接的重启提示不再算作用户回复，不能据此代答阻塞问题或接受偏差；`codex_cancel` 不取消其他会话的任务；报告经过 JSON 转义修复时，回执提示以 `last_message.txt` 原文为准；未知配置项写入警告和 `loaded.json` 的 `unknownConfig`。新增配置 `maxRunningJobs`（同时运行或排队的 Codex 任务数上限，留空不限制）和 `codex_runtime` 的 `action="doctor"`（只读自检 WSL 里的 Python、Codex、路由和 bash）。运行时：`loaded.json` 的持有进程若在记录写入之后才启动（PID 被复用），新实例会改写记录；面板的状态轮询 20 秒内复用源码身份，任务、关注数、提示词和设置改为约每 28 秒读取一次（有任务在跑时任务列表仍每 7 秒）；面板可把“Codex 模型”和“执行时的思考程度”清空以沿用 Codex 配置，并原样显示登录和大小超限的错误；规划提示词备份只保留最近 10 份。续接：被同进程热重载打断的自动续接扫描由新实例续完并保留关机名单；正常回合结束时通知仍在 inbox 则保留自动唤醒批次。runner：worker 收尾失败时落 `runner_error` 结果，不再表现为 `worker_died`；写锁排队读其他任务记录遇 IO 错误时继续等待；`maxStorageMb` 清理不删除本次任务的核验对象和续接父任务；模型安全策略拒绝不经重连提示、直接以失败回合返回时，也标记为 `model_refused`（此前归为 `incomplete`）；取消和超时在 Linux 上连同已脱离进程组的 Codex 后代一并结束；新增 `doctor` 子命令。版本说明从 README 移到本文件；`npm test` 在 Windows 上改用可用的 Python。新增“给 Codex 的固定要求”：写在 `executor-prompt.md`（与规划提示词同目录，`loaded.json` 的 `executorPromptFile` 是实际路径）里的内容附在每一单任务书的执行约束后面，不增加权限，与任务、验收或执行约束冲突时以后者为准，保存后下一单生效。面板：两份提示词都显示有效字数、可查看最近 10 份备份并载入到编辑框，规划提示词显示是否已注入；运行状态显示护栏工作区、主机访问状态和未识别的配置项，次要信息收进“更多运行信息”，新增“环境自检”按钮；常用设置新增总超时、空闲超时、重试次数、同时运行任务数上限和重启后自动续接，数字项留空表示恢复默认；最近任务显示会话、目录、耗时、验收条数、失败原因、核验状态和运行阶段，可按任务编号或会话编号搜索，报告区可切换查看任务书与验收、核验记录和错误日志；配置了 Gemini 时显示最近 20 条写作记录（`gemini-history.jsonl`，保留最近 200 条）；“会话操作”可从面板提交发送、续接、改 Goal 请求，走现有的本机请求文件，上一份未处理时拒绝新提交；页面不可见时暂停读取。

`0.9.99` `gemini_write` 在 `overwrite=true` 且 Gemini 没写出任何内容就失败时，不再把目标文件里的旧正文存成“草稿”；此前 `reuse_draft` 会把这份旧正文当作 Gemini 新写的内容报告成功。`0.9.98` 起模型服务 400 拒收标记为 `upstream_rejected`。

`0.9.97` 识别执行模型的安全策略拒绝：拒绝信息夹在重连提示里时立即结束任务并标记为 `model_refused`（不可重试），不再重连到超时、重试三轮；回执明确说明这是模型拒绝而不是连接故障。

`0.9.95` 统一 Gemini 正文的单次可写核对指引，续接拒绝回执首行明确未启动及原因，并增加事件类型统计，仅在正文增量或写文件事件后启用 Gemini 空闲超时，启动与思考阶段保留 1800 秒默认总上限。

`0.9.94` 修复 Windows 后台任务启动时调用方与 worker 并发发布 PID 文件的竞态，并改进测试的条件等待、进程清理和失败诊断。

`0.9.93` Gemini 改用无 stdout 进度超时（默认 600 秒）与共享总上限（默认 1800 秒），回执增加进度统计；成功正文禁止规划端读取/搜索，并从本会话已有回执恢复限制；新增 `reuse_draft`，可跳过 agy 重新校验、提交保留稿，超限仍拒绝。

`0.9.92` 新增重启后自动续接 `autoResume`，并支持通过本机 `goal-request.json` 修改指定会话的当前 Goal 目标和轮数上限。

`0.9.91` `send-request.json` 支持 `"whenRunning":"queue"`：会话正在运行时不再跳过，消息会排进它的下一轮（和界面上会话忙时选择排队发送是同一条路），当前回合不会被打断，原生 Goal 也会先让出这一轮；结果里的 `reason` 为 `message_queued`。不带这个字段时，运行中的会话照旧跳过。

`0.9.90` 新增配置 `gemini.forceEffort`（为 true 时一律使用配置里的推理强度，忽略调用方传入的值）和 `gemini.defaultMaxChars`（正整数）：`gemini_write` 调用没传 `max_chars` 时，就用它作为正文硬上限；显式传了 `max_chars` 仍以传入值为准。这样即使规划端忘了传，章节篇幅也有上限。

`0.9.89` `gemini_write` 成功后的下一步提示，原来是"自己对照素材核对正文"，改成"派一单 Codex 只读核对这一章，同一单挂上目录入口"。`codex_continue` 的 job_id 报错改为提示先用 `codex_jobs` 找回原任务编号再续接，不要另开新单。

`0.9.88` `codex_run` 现在会拒绝 schema 之外的顶层参数：任务正文误填进 `prompt`/`message`/`content` 会直接报错，不再被静默丢弃。`codex_output`、`codex_continue`、`codex_review`、`codex_verify` 在 `job_id` 缺失或非法时，也给出和 `codex_status` 一样的"用 codex_jobs 找回编号"提示。

`0.9.87` Codex 的最终报告如果只是字符串里有原始控制字符，或者有非法的反斜杠转义（多见于证据里引用的 Windows 路径或正则），就修复后再解析，不再把整单判为 `schema_invalid`。修复后的报告仍要通过报告校验，修过的地方记在 `final_message_repaired`；JSON 结构本身损坏的仍判失败。

`0.9.86` 新提交的复核如果所有验收项都是 `met`，又没有阻塞和偏差，就不能记成 `needs_changes`；被审正文的问题写进 notes。已经存下的旧复核不重新检查。

`0.9.85` 复核没有覆盖全部验收时，报错会列出 `acceptance_count`、`out_of_range`、`duplicates`、`missing`，以及每条缺失验收的开头原文。`codex_continue` 碰上已有子任务、直接复用时，回执带 `submitted: false`，并写明这次的 answers/resolution 没有生效。`codex_review`、`codex_run`、`codex_summary` 的工具说明里加上了审计复核、一单一个可验收结果、先看汇总这三条规则。

`0.9.84` `gemini_write` 失败回滚后，回执如实反映磁盘上的结果（`rolled_back`、`target_exists`、`restored_to`，回滚前的字数等统计移到 `before_rollback`）。生成稿另存到 `%LOCALAPPDATA%\dsh-codex-conductor\gemini-drafts`（保留最近 20 份），回执给出 `draft_path`，可以复核后复用，不必整章重写。快照里有、但 CLI 写入事件没记录的变化，单列为 `unattributed_changes`。失败判定规则不变。

`0.9.83` 封住两处守卫绕过：`rg --files` 混用 `--json` 等搜索参数，以及 `printf` 借花括号展开出 `-v` 或用 `%n` 给变量赋值。会话运行中收到的新任务通知，在旧通知处理完后重新获得唤醒次数。worker 退出后它启动的 Codex 若仍存活，继续挡住同目录的写任务；父目录和子目录的写任务改为互斥排队。`codex_output` 分页按块读取，不再整读文件。

`0.9.82` 复核被拒时，报错会列出允许、缺失和多余的偏差索引，规划端一次就能改对，不再反复盲试 `codex_review`。`npm test` 和 CI 补跑 `guard.test.mjs`、`planner.test.mjs`、`verify.test.mjs`。

`0.9.81` 修复 `products` 模式把 Promise 返回宿主同步 `tools.guard`、导致无关工具也报 JSON 序列化错误的问题。guard 始终同步返回放行或拒绝；尚待恢复的产物读取在异步 `tools/execute` 中最多等待 3 秒，确认权限前不执行原工具。新增覆盖两种读取模式、工作区边界和任意工具名的同步契约测试，以及恢复成功、失败和超时的执行前拦截测试。

`0.9.80` 统一派单后留在本轮长等、按需补读报告及一次验收的流程；中止纯观察不取消 Codex，未登记后台的同步派单中止仍取消。完善 `products` 与 Obsidian 读取守卫及产物恢复的有界等待；Gemini 成功输出仅在当前实例登记，跨重载自动恢复未实现，正文须由只读 Codex 任务核对本次输出与素材；保留完成通知及空闲会话唤醒。

`0.9.79` 新增独立的本机 `send-request.json` 入口，以用户身份向已结束的空闲会话提交新任务；原有恢复入口保持不变。

`0.9.78` 修正规划端原料读取被拒时的产物推断文案；自动唤醒完成通知滞留的 blocked 空闲会话，每批最多两次；短时间内重复查询没有实质变化的运行中任务时返回简短成功回执。

`0.9.77` 修复后台任务共享目录写锁时可能插队的问题。

`0.9.76` 修复插件热加载后本会话仍在运行的后台任务首次查状态可能被误拒的问题。

`0.9.75` 在派单返回中给出可直接调用的报告和状态参数：`job_output` 的 `job_id` 填 Harness 的 `background_job_id`，`codex_status` 和 `codex_output` 用 runner `job_id`。

`0.9.74` 让续接请求可以唤醒最后一轮被门禁阻止、且 inbox 仍有待处理输入的空闲会话，由宿主领取原有输入，不新增用户消息或重发推进提示。

`0.9.73` 明确续接参数：新任务省略 `resume`；原任务补答阻塞问题时用 `codex_continue(job_id)`；手动续接只填写工具真实返回的 Codex `thread_id`，不要生成编号或混用 DSH 会话号、任务编号。

`0.9.72` 将尚未生成的报告作为正常等待状态返回，报告随任务结束后的自动刷新打开，自检优先检查已结束任务并记录运行中报告尚未生成，`codex_output` 在报告尚未生成时提示等待任务完成后再补读。

`0.9.70` 为面板状态、任务、关注数和报告读取设置 15 秒整体上限，为任务列表、状态和报告查询及 `codex_jobs`、`codex_status`、`codex_runtime` 的任务统计设置 10 秒查询预算（显式等待另加等待时长），随包 runner 的完整 JSON 到达即返回，查询失败明确报错且不取消 Codex 任务。

`0.9.69` 的等空闲重载同时等待 Codex 活任务和所有 DeepSeek 会话的当前回合结束，显示数量与倒计时，最长等 10 分钟后停止自动重载并保留待生效设置；立即生效可能中止 DeepSeek 当前回合，Codex 后台任务继续并会接回。

`0.9.68` 为 `gemini_write` 增加硬上限与 80% 目标、同一超时预算内的一次自动压缩、失败时目标文件恢复，以及插件生成且不计入字数的可选七字段 YAML frontmatter。

`0.9.65` 随包执行器在一个 WSL 进程内持续回传后台进度和最终报告，不再每 20 秒重新启动查询。

`0.9.64` 加载状态和重载确认会核对 Harness 进程仍在运行，已退出实例的旧标记不会被当成当前加载结果。

`0.9.63` 未筛选的任务历史先按时间分页，再读取当前页的任务和报告。

`0.9.62` 重启后别的插件推进目标被宿主拒绝（回合以 blocked 结束）时，续接请求仍可恢复该目标；这种情况下不会改发用户消息。

`0.9.60` 的逐条验收会显示原验收标准（超过 300 字符可展开，取不到时沿用报告原文），已写入设置不可撤销等状态冲突返回 HTTP 409，内部故障仍返回 500。

`0.9.59` 工作区、会话和续接历史查询在单次查询内复用路径解析结果；未传会话归属时，runner 按指定任务编号查询只返回匹配记录。

`0.9.58` 面板统计最近 24 小时需要关注的任务时，在读取历史前筛选开始时间，一次查询返回总数。

`0.9.57` 控制面板的任务记录可按筛选翻页，每页 20 条，较早的任务也可打开报告。

`0.9.55` 控制面板读取任务历史和关注数量时，只在本次查询内复用同一路径的解析结果，减少重复文件系统访问。

`0.9.53` 控制面板先显示运行状态和设置；任务历史和关注数量独立加载，不阻塞其他内容。

`0.9.52` 修复冷启动时面板服务尚未就绪导致接口或设置入口未注册的问题，随服务出现、撤销和恢复自动注册与清理，缺少服务时不影响其他功能。

`0.9.51` 默认的写入范围预检会先筛选待答范围冲突再分页，避免因无关历史重复查询。开启 `plannerAnswers` 时仍沿用原有行为。

`0.9.49` 恢复默认关闭的 `plannerAnswers` 开启时的完整放宽：规划端可按用户原始目标和已有事实代答阻塞问题，跳过待答范围冲突的写入范围预检，并自行登记包含 `kind: 'scope'` 的 `accepted_deviations`，无需用户回复。

`0.9.48` 放行更多可确认只读的文本、文件核验命令和普通变量赋值，说明危险用法的拒绝原因，并保留其他存活进程的加载记录。

`0.9.46` 查询运行中任务时跳过已有最终结果的任务，避免逐条读取历史报告。

`0.9.43` 新增可选的 `gemini_write`，由 Gemini 写教程与文档正文，插件核对路径、字数和改动范围。

`0.9.42` 在派单前无法连接 WSL 时会说明原因，保留原有写入范围和续接检查。

## English

`0.9.101` fixes a guard regression in 0.9.100: `save`, `update`, `copy` and `append` in an MCP action name are refused only with a file object (`save_file`, `update_file`), and git writes only with the `git_` prefix; tools that write no file, such as `memory_save`, `update_agent` and `push_notification`, are back to their 0.9.99 verdict and no longer refused.

`0.9.100` fixes the findings of a code review. Gemini writing: when overwriting an existing file, a run that reports success without rewriting the target fails too (same check as 0.9.99) instead of reporting the old content as new prose; only a leading block made of key/value and list lines is stripped as model frontmatter, so prose that opens with a `---` rule is kept; a timeout or cancel ends the agy process tree and forces completion if it has not closed within 5 seconds; rollback removes empty parent directories created by the call; in guarded `plannerReads: products` sessions `sources` must be inside the workspace or `plannerReadAllow`. Guard: a word-initial `#` is a bash comment (refused inside `$(...)`), unquoted `$'…'` / `$"…"` and `${ cmd; }` are refused; test runners (pytest, unittest, `node --test`, npm/pnpm/yarn test, go, cargo, make) accept only fixed switches and literal paths, and `make` only a lone `make test` / `make check`; tool names are case-insensitive, `apply_patch`, `multi_edit`, `ops_write` and `ops_edit` are denied, and MCP action names are matched in camelCase and hyphenated forms with more write and execute verbs; shell tools refuse `env` / `stdin` style arguments; assignment prefixes now refuse `RIPGREP_CONFIG_PATH`, `MAKEFILES`, `MAKEFLAGS`, `RUSTC*`, `RUSTFLAGS`, `CARGO_*`, `GOFLAGS`, `PYTEST_*` and `npm_config_*`; commands matched by `allowCommands` still pass the assignment and expansion checks; `rg --hostname-bin` and `tree -R` are refused, commands above 32 KB are refused outright, and every path alias of a read tool is checked; `workspaces: ["*"]` also covers sessions without a working directory, and `\\wsl.localhost\<distro>\…` equals the matching `/mnt/<drive>/…` path. Newly allowed: leading and trailing comments, `[ "$(…)" -eq N ]`, `git merge-base` / `show-ref` / `reflog` / `branch --list <pattern>`, `node|python --version`, and awk comparisons without `print`; after a successful `gemini_write`, commands with unknown read targets get their own refusal text. Planner: the automatic restart notice no longer counts as a user reply, so it cannot unlock answering blockers or accepting deviations; `codex_cancel` leaves other sessions' jobs alone; a report that needed JSON escape repair says so and points to `last_message.txt`; unknown configuration keys are logged and listed as `unknownConfig` in `loaded.json`. New: the `maxRunningJobs` setting (limit on running or queued Codex jobs, empty for unlimited) and `codex_runtime` `action="doctor"` (read-only check of Python, Codex, the router and bash in WSL). Runtime: a `loaded.json` record whose holder started after the record was written (a recycled PID) is replaced; panel status polling reuses the source identity for 20 seconds, and jobs, attention, prompt and settings are read about every 28 seconds (jobs stay at 7 seconds while one is running); the panel can clear the Codex model and effort to fall back to Codex's configuration and shows login and size-limit errors verbatim; only the 10 most recent planner prompt backups are kept. Resume: an auto-resume scan interrupted by a hot reload in the same process is finished by the new instance and keeps the shutdown list; an auto-wake batch is kept when a normal turn ends with the notice still in the inbox. Runner: a failed worker finalisation stores a `runner_error` result instead of surfacing as `worker_died`; the write-lock queue keeps waiting when another job's record cannot be read; `maxStorageMb` cleanup spares the job being verified or continued; a model safety refusal that arrives as a failed turn without a reconnect notice is reported as `model_refused` too (it used to end as `incomplete`); cancel and timeout on Linux also end Codex descendants that left the process group; a `doctor` subcommand is added. Release notes moved from the README to this file; `npm test` now finds a working Python on Windows. New fixed requirements for Codex: the content of `executor-prompt.md` (next to the planner prompt; `executorPromptFile` in `loaded.json` is the actual path) is appended after the execution constraints of every handoff, grants no permission, yields to the task, acceptance criteria and constraints on conflict, and applies from the next dispatch. Panel: both prompts show their effective length and the 10 most recent backups, which can be loaded into the editor, and the planner prompt shows whether it is injected; status shows the guarded workspaces, host access and unknown configuration keys, folds secondary rows into a details block and adds an environment check button; settings add the total and idle timeouts, retries, the running-job limit and auto resume, and an empty number restores the default; recent jobs show the session, directory, duration, criteria counts, error kind, verification status and phase, can be searched by job or session id, and the report view can switch to the task and acceptance, review history and stderr; with Gemini configured the 20 most recent writes are listed (`gemini-history.jsonl`, 200 kept); session operations submit send, resume and goal requests through the existing local request files and refuse a new one while the previous is unprocessed; reads pause while the page is hidden.

`0.9.99` `gemini_write` no longer saves the old text of an existing target as a draft when Gemini fails before writing anything under `overwrite=true`; `reuse_draft` used to report that unchanged text as newly written by Gemini. Since `0.9.98` an upstream 400 is reported as `upstream_rejected`.

`0.9.97` recognises a safety refusal from the execution model: when the refusal arrives inside a reconnect notice the job ends at once as `model_refused` (not retryable) instead of reconnecting until the timeout across three attempts, and the receipt says it is a model refusal rather than a connection failure.

`0.9.95` unifies Gemini prose guidance into one writable check, leads refused continuation receipts with the reason and explicit not-started status, and adds event-type counts while enabling Gemini idle timing only after prose deltas or file-write events, retaining the default 1800-second total deadline during startup and thinking.

`0.9.94` fixes a Windows race where the background-job caller and its worker published the PID file at the same time, and makes the runner tests wait on conditions, stop workers before cleanup and report exit code and stderr on failure.

`0.9.93` adds stdout-idle and total Gemini deadlines with progress receipts, blocks planner reads/searches of successful prose with session-receipt recovery, and accepts `reuse_draft` for validated resubmission without agy.

`0.9.92` adds restart recovery through `autoResume` and a local `goal-request.json` entry to edit a session's current goal objective and round cap.

`0.9.91` lets `send-request.json` take `"whenRunning":"queue"`: a running session then receives the message in its next turn (the same path as the UI's Queue mode) instead of being skipped. The current turn is not cancelled and the native goal yields to the queued message; the result reason is `message_queued`. Without the field, running sessions are still skipped.

`0.9.90` adds `gemini.forceEffort` (when true the configured effort overrides any value the caller passes) and `gemini.defaultMaxChars`: when a `gemini_write` call omits `max_chars`, this positive integer is used as the hard limit (an explicit `max_chars` still wins), so chapter length stays capped even when the planner forgets to pass it.

`0.9.89` changes the hint after a successful `gemini_write` from "check the chapter against its sources yourself" to "dispatch a read-only Codex check that also adds the directory entry", and makes the `codex_continue` job_id error say to recover the id with `codex_jobs` and continue the original job instead of opening a new one.

`0.9.88` makes `codex_run` reject top-level parameters outside its schema, so a task spec misplaced in a `prompt`/`message`/`content` field errors instead of being silently dropped; and gives `codex_output`, `codex_continue`, `codex_review` and `codex_verify` the same "use codex_jobs to recover the id" hint on a missing or invalid `job_id` that `codex_status` already has.

`0.9.87` recovers Codex final reports that fail strict JSON parsing only because of raw control characters or invalid backslash escapes (often Windows paths or regexes quoted in evidence). The repaired report must still pass report validation; the repair is recorded in `final_message_repaired`. Broken structure still fails as `schema_invalid`.

`0.9.86` rejects a new `needs_changes` review whose criteria are all `met` with no blockers and no deviations; defects in the audited content go in notes. Stored reviews are not re-checked.

`0.9.85` makes review coverage errors list `acceptance_count`, `out_of_range`, `duplicates`, `missing` and the start of each missing criterion; marks `codex_continue` calls that reuse an existing child with `submitted: false` and says the new answers or resolution were not applied; and adds the audit-review, one-result-per-job and summary-first rules to the `codex_review`, `codex_run` and `codex_summary` descriptions.

`0.9.84` makes a failed `gemini_write` report what is actually on disk after rollback (`rolled_back`, `target_exists`, `restored_to`, counts moved to `before_rollback`), saves the generated draft under `%LOCALAPPDATA%\dsh-codex-conductor\gemini-drafts` (newest 20) and returns `draft_path` for review and reuse, and lists snapshot changes not explained by CLI write events as `unattributed_changes`. Failure rules are unchanged.

`0.9.83` closes two guard bypasses (`rg --files` mixed with search flags such as `--json`, and `printf` assigning variables through `-v` brace expansion or `%n`), gives a fresh wake budget to task notices that arrive after older notices were consumed, keeps writers out of a directory while a residual Codex from a dead worker is still alive, makes parent and child directories mutually exclusive for writers, and pages `codex_output` without reading whole files.

`0.9.82` review errors now list the allowed, missing and extra deviation indexes, so the planner can fix a rejected `codex_review` in one try instead of guessing. `npm test` and CI now also run `guard.test.mjs`, `planner.test.mjs` and `verify.test.mjs`.

`0.9.81` fixes Promise returns from the synchronous host `tools.guard` in products mode, which caused JSON serialization errors even for unrelated tools. Guards always return synchronously; reads awaiting product recovery wait up to three seconds in asynchronous `tools/execute` middleware before the original tool can run. New contract tests cover both read modes, workspace boundaries and arbitrary tool names, plus interception before dispatch on recovery success, failure and timeout.

`0.9.80` unifies same-turn long waits after dispatch, report reads only when needed, and one review per product version. Aborting observation leaves Codex running; aborting synchronous dispatch without background registration still cancels it. Products-only and Obsidian guards use bounded waits for product recovery; successful Gemini outputs are registered only in the current instance, with automatic recovery across reloads not implemented, and a read-only Codex task must check each new output against its sources. Completion notices and idle-session wakes remain available.

`0.9.79` adds a separate local `send-request.json` entry that submits a new task as a user message to an idle, finished session, while preserving the existing resume entry.

`0.9.78` removes unsupported artifact-identity wording from planner read denials, automatically wakes idle blocked owners with stranded completion notices at most twice per batch, and returns concise successful receipts for repeated unchanged running-job checks.

`0.9.77` prevents later background writers from jumping ahead on a shared directory lock.

`0.9.76` fixes the first status check for a session’s running background job after a plugin reload.

`0.9.75` gives ready-to-use report and status calls: pass the Harness `background_job_id` as `job_output`’s `job_id`, and use the runner `job_id` for `codex_status` and `codex_output`.

`0.9.74` lets resume requests wake idle sessions whose last turn was blocked and whose inbox still has pending input. The host claims the existing input without adding a user message or resending a rejected advancement prompt.

`0.9.73` clarifies continuation IDs: omit `resume` for new tasks, use `codex_continue(job_id)` for blocker answers on existing jobs, and only pass a Codex `thread_id` actually returned by a tool when resuming manually. Do not invent IDs or substitute Harness session IDs or job IDs.

`0.9.72` treats reports awaiting generation as a normal pending state, opens them on the next automatic refresh after task completion, prefers finished tasks in panel self-tests while recording pending reports, and tells `codex_output` readers to wait for task completion before reading a pending report.

`0.9.70` bounds panel status, jobs, attention and report reads to 15 seconds, gives list/status/report queries and the query phase of `codex_jobs`, `codex_status` and `codex_runtime` a 10-second budget (plus any explicit wait), and returns bundled-runner JSON without waiting for pipe closure or cancelling Codex tasks on query failure.

`0.9.69` waits for both active Codex tasks and current turns in all DeepSeek sessions before an idle reload, shows counts and a countdown, and stops automatic reload after 10 minutes while retaining pending settings; immediate reload may abort DeepSeek turns while Codex background tasks continue and reconnect.

`0.9.68` adds a hard limit and 80% target for `gemini_write`, one automatic compression attempt within the shared timeout budget, output restoration on failure, and optional plugin-generated seven-field YAML frontmatter excluded from character counts.

`0.9.65` streams background progress and the final result from one bundled WSL status process.

`0.9.64` checks that the Harness process is still present before reporting synchronization or confirming a reload.

`0.9.63` pages unfiltered history by timestamp before reading the selected jobs and reports.

`0.9.62` lets a resume request still resume a disarmed goal when another plugin's attempt after a restart was rejected (turn ended `blocked`); it never falls back to sending a prompt in that case.

`0.9.60` shows original acceptance criteria in the readable report (expandable after 300 characters, falling back to report labels when unavailable) and returns HTTP 409 for state conflicts such as cancelling already-written settings, while internal failures remain 500.

`0.9.59` reuses path resolution within filtered history queries and limits a runner lookup by job ID to matching records when no owner is supplied.

`0.9.58` filters by start time before reading job history for the panel’s 24-hour attention count.

`0.9.57` adds 20-item pages to the panel task history, keeping filters and access to reports on older tasks.

`0.9.55` reuses path resolution within a single global history query for the panel, reducing repeated filesystem work.

`0.9.53` shows runtime status and settings while task history and the attention count are still loading.

`0.9.52` fixes missing panel routes and settings entries on cold startup by registering, cleaning up, and re-registering them as their services appear, disappear, and return, without affecting other functionality when services are absent.

`0.9.51` filters pending scope conflicts before paging the default write-scope preflight. The opt-in `plannerAnswers` behavior is unchanged.

`0.9.49` restores full opt-in `plannerAnswers`: the planner can answer blockers based on the user's original goal and known facts, skip pending-conflict write-scope preflight, and record `accepted_deviations`, including `kind: 'scope'`, without a user reply.

`0.9.48` permits more demonstrably read-only text and file checks and ordinary assignments, explains dangerous command forms, and preserves another live process's loaded record.

`0.9.43` adds optional `gemini_write` for tutorial and documentation prose, with plugin checks for paths, character counts and changed files.

`0.9.42` identifies a WSL connection failure when it prevents dispatch preflight, preserving the existing scope and continuation checks.
