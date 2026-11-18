# dsh-codex-conductor

DeepSeek Harness（DSH）插件：DSH 里的 agent 负责规划和验收，编码任务交给 WSL 里的 Codex CLI 执行。

[English](#english)

各版本的改动说明见 [CHANGELOG.md](CHANGELOG.md)。

### 0.9.66：规划端只读产物与独立核验

默认 `plannerReads: open`，护栏工作区内的 Gemini 成功正文仍禁止规划端读取。改成 `products` 后，受护栏保护的会话只能直接读本会话 Codex 已产出的文件、任务报告、规划提示词，以及明确允许的文件或目录；目录列表仍可查看，源码调查交给 `codex_run`。常用设置里可开关“规划端只读 Codex 的产物，不直接读源码”，沿用保存、待生效和立即生效流程；状态区只显示额外允许路径的条数。

```yaml
- id: codex-conductor
  config:
    workspaces: ['E:\project']
    plannerReads: products
    plannerReadAllow:
      - 'E:\project\RULES.md'
      - '/mnt/e/project/review-inputs'
```

产物路径按会话缓存在当前插件实例内，任务结束拿到结果时更新，每会话最多 10,000 条、最多保留 100 个会话；Gemini 成功正文另行登记为规划端禁读路径，并从本会话已有成功回执恢复，优先于产物和白名单。产物登记尚未恢复完成时，先等待最多 3 秒取得恢复结果；只有恢复仍为 `pending`（包括等待超时但恢复尚未完成）时，才提示“暂时无法确认读取权限”，不据此断言它是原料，也不放行读取。恢复成功后，未命中产物或白名单的读取按原料读取拒绝；恢复已结束但失败时，提示“产物登记恢复失败，该路径未获读取授权”，不将该路径断言为原料。未命中时每会话至多每 25 秒后台查询一次 runner，刷新确认后可重试。允许目录包含子文件，产物文件不会因此放行其所在目录。 产物授权只认 runner 实际记录的 `files_changed` / `write_paths`，Gemini 正文始终优先禁读，不凭只读任务读取过的路径或报告自报的文件列表扩大范围；读取任务报告和历史也限制在当前会话。 会话工作记录目录取自 DSH 现有的 sessionPersistence.locate(header)，只允许该会话日志所在目录；宿主未提供此接口时不猜目录。`cat/head/tail/wc/grep/sed/awk` 等内容读取、内容搜索和输入重定向都检查路径；变量、通配符或命令替换不能确定读取对象时拒绝。Obsidian 的 `obsidian_read`、`obsidian_search` 和 frontmatter 查询也遵循本会话产物与路径白名单，目录和文件列表仍放行。执行项目代码的测试命令也交给 Codex。

`products` 模式下的拒绝提示简短说明原因：调查交给 `codex_run`，产物内容核对交给 Codex 核验任务。被守卫拒绝后，不换语言、命令或工具入口重试。

规划端先机械核对产物是否存在、是否有出处及数字能否对应。内容真实性用 `codex_verify`，例如 `{"job_id":"原任务编号","focus":"统计数字与引用是否准确","samples":8,"wait_seconds":0}`。`samples` 默认 8，范围 1–30；其余等待规则同 `codex_run`。它只接受本会话已结束的任务，在新线程中沿用原目录和主机访问。未启用 modelAB 时沿用原模型，启用时使用配置的默认模型。全程只读核对任务书、验收、产物及原始出处，按现有报告格式逐条写明结论、出处、是否属实及实际情况。关联保存在 `context.verification_of`，可从 `codex_jobs` / `codex_status` 看到；核验完成后用 `codex_review` 记录原任务的验收。同一版本已完成验收、产物未变且没有新证据时，不再追加核验；`codex_review` 只记录验收，不另派调查。Gemini 正文的核对见下文，不能用旧素材任务的 `codex_verify` 替代。主机访问模式的只读约束与原有 `write=false` 相同，由任务书约束；护栏不是操作系统沙箱。

### 0.9.56：设置里的“Codex 指挥”

在 DSH 设置页打开“Codex 指挥”，可以查看加载版本、源码是否一致、当前执行设置和任务数量，修改常用设置，筛选最近 20 个任务、查看报告并确认取消正在跑的任务，也可以编辑规划提示词和请求空闲后重载。Gemini 已配置时才显示其模型和思考程度。运行状态和设置先显示，任务历史和关注数量分别加载。

空闲指没有 Codex 活任务，且宿主所有会话均没有 `status === 'running'` 的回合，包括等待模型回复的回合；无法读取会话状态时拒绝等空闲重载。空闲时保存设置会立即应用；否则默认先保存为待生效设置，等待空闲后自动应用。待生效设置写在本机 `pending-settings.json`（与 `loaded.json` 同目录，通常是 `%LOCALAPPDATA%\dsh-codex-conductor`），重启后会恢复；它绑定当前环境配置的 `runtimeProfileFile`，避免误用到另一个实例。再次保存会覆盖之前的待生效设置，也可以撤销尚未应用的设置。等待期间每 5 秒检查一次是否空闲；面板每 7 秒刷新活任务数、运行中会话数与剩余秒数。最长等待 10 分钟，超时停止自动重载，不强制应用，保留待生效设置和原因；请重新保存、撤销，或明确确认立即生效。实际应用时先备份，再原子改写本插件对应的 profile 字段，保留注释和其他配置；只有确认新版本实际加载后才显示生效。规划提示词保存前也会备份。

需要马上应用时，选择“立即生效”并确认即可热重载。Codex 后台任务继续按启动时的设置执行并会接回，新设置用于后续派发；但宿主重载插件可能中止正在进行的 DeepSeek 回合，即使回合正在等待模型回复、没有调用本插件工具也一样。要保留当前回合，请使用等空闲生效。同一宿主进程内，自动续接默认在热重载后等 20 秒，再复核并续上仍被这次重载打断的回合。加载后会复用仍在任务表中的原任务；当前已打开的会话中，已登记但未结算且归属可确认的任务会自动接回，不重复派发。未打开的会话在恢复时检查；缺少登记记录、归属不明或状态无法核对的任务不会自动接回。主动取消 Codex 任务、归档会话仍可能取消对应任务；未登记后台的派单在同步等待时被中止仍会取消 Codex。中止 `codex_status`、`job_output` 等纯观察只停止观察，不取消 Codex。

任务报告提供易读视图和原文，支持 v2 和旧版格式。易读视图会先读完整份报告再解析，最多读取 256 Ki 字符（262,144 个字符）；超出上限或格式无法解析时，仍可分页查看原文，不把截断内容当成完整报告。面板的“最近 24 小时需要关注”按任务开始时间统计；“待关注”任务列表仍包含更早的历史任务，两者数量可能不同。

面板沿用 DSH 的网页服务，不另开端口；`/dsh-codex-conductor/*` 的每个接口都调用 DSH 自己的登录及 Host/Origin 校验，缺少鉴权服务时拒绝访问。`webServer`、`settings` 或客户端槽位不存在时不影响原有工具。文件 URL 加载也支持前端：升级时保留完整包（包括 `package.json`、`client.js`、`panel.mjs`），仍用 `file:///…/index.mjs?v=…`，更换 entry ID 和 `v` 后由 DSH 热加载，无须重启宿主。`runtimeProfileFile` 须指向这个实例实际使用的 `cordis.patch.yml`；新版本先由用户部署。

### 0.9.61：桌面面板只读自检

在 `%LOCALAPPDATA%\dsh-codex-conductor\panel-selftest-request.json` 写入 `{}` 或 `{"id":"desktop-check-1"}` 即可触发；`id` 可选，最多 128 个 Unicode 字符，省略时自动生成。建议先写同目录临时文件，再改名发布。前端在设置入口登记后检查一次，之后每 60 秒检查一次；没有请求时不渲染面板、不读取业务接口、不写自检文件。

第一个通过 DSH 登录及来源校验的前端会原子认领文件，在不可见、不可聚焦的离屏节点里用页面的 React 和 DSH 基础组件渲染真实面板，读取状态、设置、最近任务、提示词和关注数；优先打开本页最近一条已结束任务的报告，没有已结束任务时打开第一条，运行中报告尚未生成时在 `report.note` 记录“报告尚未生成（任务运行中）”。整次渲染最多等 30 秒，完成或超时后卸载并移除节点。自检只读，不保存设置、不重载、不取消任务、不写提示词；唯一 POST 是提交自检结果。

结果原子替换同目录的 `panel-selftest-result.json`，包含后端的 `id`、`version`、`pid`、`receivedAt`，以及前端的 `settingsRegistered`、四个标题的 `sections`、状态区实际显示值 `status`（`version/model/effort/serviceTier`）、本页 `taskCount`、`report`（`opened/summary/criteria/firstCriterion`，首条验收前 80 个 Unicode 字符）、`http`（读取接口的路径和状态码，无 HTTP 响应时为 `null`）、`errors`、`timedOut`、`userAgent` 和 `origin`。检查 `userAgent` 中的 `Electron/` 才能确认认领者是桌面窗口；Web 页面也可能先认领。无任务时报告布尔值为 `false`，不代表报告渲染失败。

`GET /dsh-codex-conductor/selftest/request` 返回 `{"request":null}` 或 `{"request":{"id":"…","claim":"…"}}`；`POST /dsh-codex-conductor/selftest/result` 接收 `{"id":"…","claim":"…","result":{…}}`，请求体上限 64 KiB，严格校验字段，认领凭据只能成功提交一次。请求文件上限 4 KiB，仅允许 `id`。结果只保留最近一次；非法请求或未完成的认领保留为 `panel-selftest-request.<claim>.processing.json`，不会自动重放。没有结果或结果中有错误时，不能据此宣称桌面验收通过。

部署注意：`@deepseek-ai/dsh-client-hmr` 通过 `/plugins/events` 向已打开窗口推送模块图或重建通知；正常条目的前端 revision 变化才会清缓存并重新执行模块。revision 来自 `client.js` 的修改时间、创建/元数据变更时间和大小，不是 profile token。只换 profile token 不保证前端重载；revision 未变且条目未被移除重建时，需要刷新窗口或重启 DSH。部署新版 `client.js` 并收到变化后的 revision 时，可以在页面内热替换，无须整窗刷新。

### 0.9.79：从本机向空闲会话提交新消息

要让已经正常结束的会话接着做新任务，向 `%LOCALAPPDATA%\dsh-codex-conductor\send-request.json` 写入以下 JSON（与 `loaded.json` 同目录）。建议先写临时文件，再在同目录改名发布，避免读到未写完的 JSON：

```json
{"sessionId":"session-example","message":"请继续处理这个新任务"}
```

两个字段都必填：`sessionId` 只接受单个会话 ID，格式为 `[A-Za-z0-9_-]{1,100}`；`message` 必须是非空、非纯空白字符串，最多 4000 个 Unicode 字符，发送的文本不会裁剪首尾空白。`sessions` 数组不受支持，包含该字段的请求会被拒绝。这个入口会通过 `agent.followup` **以用户身份**（`role: 'user'`、`source: {kind: 'user'}`）向会话发消息，因此只应由本机操作者使用，不应向模型、远程调用者或不可信文件写入者开放。

插件在加载、热重载和目录通知时检查请求，沿用恢复入口的原子认领和串行处理；提交前异步读取会话，再复核 agent 身份及运行状态。运行中的会话默认跳过；请求里加 `"whenRunning":"queue"` 时，运行中的会话也会收到这条消息：它被排进下一轮（`next-turn`），和界面里会话忙时选择排队发送走同一条路，当前回合不会被打断，原生 Goal 也会先让出这一轮；结果中的 `reason` 为 `message_queued`。`whenRunning` 只接受 `"queue"`。与 `resume-request.json` 的区别是：发送入口允许正常结束的空闲会话接收新消息，直接提交用户消息；恢复入口仍只处理 `interrupted` / `blocked` 的恢复情形，正常结束的会话仍跳过。

同目录的 `send-result.json` 包含认领时间 `requestedAt`、完成时间 `completedAt`、`sessionId`、`status`、`reason`，出错时另有 `error`。成功为 `sent / message_submitted`；跳过为 `skipped / running`（正在运行）、`skipped / session_changed`（读取期间 agent 被替换或移除）、`skipped / error`（取不到 agent、宿主接口缺失或提交失败）或 `skipped / invalid_request`（JSON、字段或长度不合法，不提交消息）。无法取得合法会话 ID 时 `sessionId` 为 `null`。结果文件和插件日志不记录消息正文；宿主错误也不引用正文。

结果原子写入后删除已认领的请求，只保留最近一次结果；提交下一份前先核对时间并读取结果。若结果写入失败，认领文件继续留在目录中，重启后不会自动重放；每份请求只尝试一次，`sent` 表示消息已提交，不表示新任务已完成。卸载插件时关闭目录监听。

### 0.9.115 自动代答宿主提问

宿主的 `ask_user_question` 等满 10 分钟后，conductor 会逐题选择有推荐标记的选项，找不到标记时选首项。多选题会选中所有带推荐标记的项，自由文本题使用配置的说明。答案会附上代答说明。热重载保留原提出时间，宿主恢复的待答提问也按原时间计时，已超时的再给用户 30 秒。

题目或任一选项触发高风险正则时，整批由用户回答。排除会话、按设置排除的子代理会话、宿主权限审批和计划审核、conductor 的交接确认都留给用户。宿主提供提问服务时，“Codex 指挥 → 自动代答”会显示待答提问和最近 10 条记录。可以现在按推荐提交，或为某条提问取消代答。宿主能恢复的提问会保留人工接管选择。

本机记录在 `%LOCALAPPDATA%\dsh-codex-conductor\auto-answer-history.jsonl`，保留最近 300 行，仅保存提问和所选标签的短摘要与判断依据。已恢复提问的人工接管标记保存在同目录的 `auto-answer-manual.json`。

默认高风险正则（不区分大小写）为 `删除|清空|不可恢复|不可逆|覆盖|格式化|卸载|重置|drop |truncate|rm -rf|force.?push|付款|支付|购买|转账|充值|密码|密钥|口令|凭据|token|secret|发布到|上线到生产|生产环境|对外发送|发邮件|真实目标|授权范围`。

### 0.9.114：自标未满足的验收项结案要有独立依据

- 结案（`verified` 或 `accepted_deviations`）时，Codex 报告自己标 `blocked` / `not_met` 的验收项若记成 `met`，按 `closeoutEvidence` 的级别要依据。`independent`（默认）：需要至少一项独立依据——晚于这一轮结束、核验本单元的核验任务把这一条判 met（核验任务现在会把每个自标未满足的原验收项单列一条），或同一单元的后续轮次报告这一条 met，或原会话用户在作业结束后有过真实回复（与接受偏差时的用户确认同一判定，但不因 `plannerAnswers` 放宽）。规划端自己写的证据不再够。`planner`：规划端自己写的、不照抄报告原文的证据即可（0.9.103 规则，现在对两种结案结论都适用）。`off`：不查。
- 缺依据时整条被拒，按条列出三条路：`codex_verify` 这单（下一单写入范围不重叠时可在下一单带 `verify_previous`），`codex_continue` 返工，或这一条照实记 `blocked` / `not_met`。
- “未满足但接受”：`accepted_deviations` 里的条目可保留 `blocked` / `not_met` 并写 `accepted`（接受原因）；记录里保留原状态，`codex_summary` 的 `accepted_open` 列出这些条目。它与接受偏差走同一道用户确认（`plannerAnswers` 关闭时要作业结束后的用户回复）。`accepted_deviations` 里保留 `not_met` / `blocked` 却没写 `accepted` 时，插件按“接受未满足”的意图处理：`accepted` 取这一条的 evidence（前缀“（按 evidence 推定）”），结果里说明（`review_fixes`），照样经过同一道用户确认；从不推定 `met`。
- 核验中放行：本会话唯一一个待验收任务正在核验（它的第一次核验在跑，或这次 `codex_run` 带 `verify_previous` 核验它），且没有别的待收尾任务时，收尾护栏放行写入范围与该任务产物和 scope 不重叠的新任务（与 `verify_previous` 同一道重叠检查）。每个任务只放行一次；核验结束后它的验收到期，记下之前新任务照常被拒。靠 `verify_previous` 放行且设了 `maxRunningJobs` 时，要放得下两单。结果带 `closeout_deferred`，`codex_runtime` 计 `deferred_dispatch`。
- 报告行与验收项的对应：条文与某条验收原文一致就按条文；报告行数与验收条数相同时按位置。条数不同时，自标 `blocked` / `not_met` 又对不上任何验收原文的行，按报告行号在 `report_rows`（`{row, status, evidence, accepted?}`）里处理：结案结论必须逐行列出，规则与 `criteria` 相同（记 met 要独立依据，保留未满足要在 `accepted_deviations` 里写 `accepted`）。核验报告只有能这样对上核验项的行才算依据；对不上验收清单的自标未满足行，核验任务单列一条（“原报告第 k 行……”）。核验任务现在一条验收只回报一行，抽查的各条结论写进第 3 条的 evidence。
- 截止：本机第一次加载这一版之后结束的任务才按 `independent` 要求（`closeout-evidence-since.json`），之前结束的任务按 `planner` 规则，不会因升级变难收尾。
- 统计：`closeout-stats.json` 按会话和总数记结案结果（`all_met` 全部满足、`accepted_open` 未满足但接受、`rejected_unsupported` 缺独立依据被拒），`codex_runtime` 显示。任务 context 新增 `routing`（续接方式、原线程、父任务、被接替的线程、`verify_previous`），收尾护栏拒绝时把被点名的任务号记进 `closeout-refusals.jsonl`。

从首次加载本版起结束的任务，成功结案后会把接受的未完成项记入 `accepted-open.json`，保存编号、状态、阻塞与依据类型及时间。最新的成功结案复核会替换该任务的条目。读取台账时，晚于条目记录时间完成、且直接核验该任务的结果，会按验收编号或报告行号销掉判为 `met` 的条目。`codex_runtime` 和 `codex_summary` 显示本会话及交接前任的条目与完成记录。有开放项时，规划端完成目标须传 `update_goal(action=complete, acknowledge_open_items=true)`。关闭 `plannerAnswers` 时还须有晚于最近一项的真实用户回复。

后续轮次的报告和新写入的成功结案复核都将某条验收记为 `met` 时，可销掉同一交接链上十跳内祖先任务在复核前已入账的同编号条目。两份验收清单必须等长，该编号的原文须完全相同且在各自清单中唯一。核对报告依据和台账时，报告行优先按原文匹配，找不到原文时才按位置匹配。最近 500 条销项记录保存在 `cleared`，由 `codex_summary` 展示，销项数记入 `closeout-stats.json` 的 `ledger_cleared_by_later_round`。仍开放但后续报告已标 `met` 的条目会在运行状态、摘要、目标完成拒绝和写任务完成回执中提示。读取台账时，为生成提示最多查询十个任务的状态。可在后续轮次结案时记 `met`，也可用 `codex_review` 重记原任务。

核验还在跑时就可以提交 `codex_review J`，照实保留未满足条目并写 `accepted`。仅当复核为 `accepted_deviations` 或 `verified`、本会话或交接前任有正在核验 J 的任务、用户确认关卡已通过，且修正格式后唯一缺口是保留开放项所需的依据时，才返回 `status: parked`。把自标未满足或 `must_verify` 的条目无依据记成 `met` 仍会被拒，请等核验后再提交。`needs_changes` 照常提交。

状态目录的 `parked-reviews.json` 每单保留一份挂起复核，重新挂起可替换。核验已结束或已被清理时，插件加载、会话补扫或派单前的收尾检查都可触发只读评估。插件核对原任务归属，合并现有依据和挂起时已有的开放项依据。结果为 `ready` 时附含 `job_id` 的单行 JSON，由规划端原样提交 `codex_review`，按正常流程复核和入账。已有更新复核时返回 `superseded`。依据不足时返回 `rejected` 并附骨架，原任务已清理或不再属于交接链时附原因。暂时读不到原任务或依据时留待下次扫描，得出判定后移除挂起条目。

核验在挂起时已经结束的，`codex_review` 直接返回可得的判定，否则判定随核验完成通知送达。挂起期间可尝试派写入范围不重叠的下一单，仍须通过收尾护栏。本会话或前任有挂起复核或正在评估的复核时，`update_goal(complete)` 会点名原任务和核验并拒绝。评估结束后，原任务按已有复核状态走正常的收尾检查。`codex_runtime` 显示本会话含前任的挂起数。

### 0.9.112：codex_run 续接也开新线程、派活时同时核验上一单

- `codex_run` 带 `resume`：原线程上次请求超过 `continueFreshAboveTokens`（默认 100000）时改开新线程，规划端写的任务原文完整保留，前面附上一轮交接内容（上一轮的任务书和验收标准、逐条自报的状态和证据、偏差、未决、阻塞、改动文件、最新验收结论和意见）。“上一轮”是该线程上本会话（含交接前任）最新的任务，新任务以 `parent_job_id` 挂在它下面，所以工作单元、`codex_summary` 分组、收尾护栏的“后续轮次”、交接自检和别名都把它当作这条线程的后续。`fresh: true` / `false` 可逐次指定；线程小、读不到大小时照旧沿用原线程。结果写明开了新线程、原线程、上一轮任务和新任务号，并提示以后对新任务返工、不要再 resume 原线程；之后若仍 resume 已被接替的旧线程，插件自动改接接替它的线程上最新的任务并说明。
- `codex_continue` 带 `answers`（回答阻塞问题）默认仍沿用原线程；传 `fresh: true` 时开新线程，回答写在交接内容里。实测这类续接的原线程多数也超过阈值（11-17 改动后 11 单里 10 单，中位约 15.4 万 token），把默认改成开新线程大约能让续接的输入 token 再省一倍；是否改由所有者决定。
- `verify_previous`：`codex_run` / `codex_continue` 可带一个已结束任务的 job_id，在派这一单的同时只读核验它（与 `codex_verify` 派出的核验完全相同：归属、`verification_of`、只读、不加写锁），结果由完成通知送达。这一单可写、且它的 scope（没写 scope 时为任务目录）与被核验任务的 scope 或产物互相包含时拒绝，提示先核验；`/mnt` 下路径不分大小写。核验因运行数上限等原因没派出时，这一单照常派出，结果里说明，之后再用 `codex_verify`。
- 写任务起步：scope 整体遍历超过 5 秒时，记下最慢的那一项（单项超过 5 秒或用光 20 秒预算的规则不变）。

### 0.9.111：带着运行中的任务交接、重启后的兜底续接、自动生成的交接标题也改名

- **带任务交接**（`autoHandover.withRunningJobs`，默认 `true`）：自动交接、询问后同意的交接和面板按钮发起的交接，在会话没有回合在跑、但名下有运行中的 Codex 任务时照常进行（`turn_running` 仍一律拒绝）；面板询问也不再等任务结束。交接单“待收尾”逐条列出运行中任务的编号、标题和已运行时长，并写明“这些任务随交接转给本会话：用 `codex_status` 等待并验收，不要重派”；自检 `jobs` 覆盖这些任务。宿主的后台任务机制会把任务结束通知发给任务属主（交接前派出的任务属主仍是前任），属主空闲时直接开一个新回合；现在插件在前任这一回合的第一步之前拦下 Codex 任务的结束通知，转给链路末端的继任会话（A→B→C 时转给 C；继任空闲就开新回合，正忙就放进它的下一步），前任这一回合以 `blocked` 结束、不调用模型。撤回后前任不再有继任，通知照常留给它。`false` 时保持旧行为（有任务就放弃，稍后重试）。
- 放弃自动交接后的重试冷却：撞上新回合（`turn_running`）时 2 分钟，其他原因 30 分钟；没交接成的尝试不占“24 小时一次”的名额。
- **重启后的兜底续接**（`autoResume.delaySeconds`，默认 `0` = 原来的立即续接）：大于 0 时，宿主进程启动这么多秒后才扫描（热重载不重新计时，每个宿主进程仍只扫一次），按会话此刻的实际状态重新判断：有回合在跑、宿主启动之后已经开过回合（说明 `dsh-client-auto-continue`、目标循环或用户已经续上）、已交接出去、已归档、用户手动停止、目标被暂停或仍由目标循环驱动的都跳过，其余才发 `autoResume.message`。强杀（没有机会写停机名单）原本就能识别：原始日志里最后一个回合只有 `turn/start` 没有 `turn/end`。宿主没有只读日志尾部的接口，兜底时读一个会话的原始日志最多等 60 秒，超时记 `read_timeout` 跳过。结果写进 `autoresume-result.json`，带 `trigger: "fallback"` 和每个会话的跳过原因。
- **标题修复放宽**：以 `[codex-conductor 交接]` 开头的标题（宿主按首条交接消息自动起的名）都视为“没有标题”，继任会话改名为 `[交接←<原会话短 id>] <原会话标题>`；启动修复用独立的一次性标记 `titleRepaired`，0.9.109 已修过工作区的链接也会补做一次标题。用户自己改过的标题、已经是 `[交接←…]` 的标题不动。

### 0.9.110：续接开新线程、已交接会话的开场说明、写任务起步更快

- 续接开新线程：`codex_continue` 不带 `answers`、且原线程上一次请求超过 `continueFreshAboveTokens`（默认 100000 输入 token，0 表示总是沿用原线程）时，改开新的 Codex 线程，只带上轮交接内容（原任务、验收标准、上轮未满足项和证据、偏差与未决项、独立核验意见、阻塞、上轮改动文件），不再每个请求重发旧线程的整段历史。线程大小由 runner 的只读命令 `thread-size` 从该线程的 rollout 读取；读不到时沿用原线程。`fresh: true` / `false` 可逐次指定；带 `answers` 的续接（回答阻塞问题）始终沿用原线程。新任务仍以 `parent_job_id` 挂在原任务下：收尾护栏、交接自检、`codex_jobs` 的 `parent_job` 和 `codex_summary` 的分组都照旧（summary 把续接放进父任务所在的组，用量按线程分别累加）。`codex_run` 带 `resume` 仍沿用原线程。
- 已交接的会话收到用户消息时，第一步之前插一条说明：本会话已于何时交接给哪个会话、这里的 Codex 工具已停用、请告诉用户到新会话继续；同一条消息只说明一次。被拒的工具调用也写明新会话 ID 和这句说明。
- 写任务起步：在 `/mnt/...` 这类很大的任务目录里，scope 中单独一项遍历超过 5 秒、或用光 20 秒快照预算时，记为太大（与任务目录同样保留 7 天），之后的任务跳过这一项快照、只靠 Codex 的改文件事件；其他 scope 项照常快照。`forget-too-big` 会一并清掉任务目录下的这些记录。
- 验收标准条数：新派活的验收标准超过 `acceptanceWarnAbove`（默认 8，0 关闭）条时，回执提醒下次按共同前置拆单，把偏好写进 task 正文。提醒不拦截，条数累计在状态目录的 `acceptance-stats.json`，`codex_runtime` 会显示。
- 状态目录新增 `handover-pending.json`（每 2 秒刷新，只含会话 ID）：列出有自动交接排队、或交接请求还没处理完的会话，外部看门狗可据此暂不向这些会话发消息。

### 0.9.109：继任会话留在原分组、带来源的标题、目标循环里的自动交接

- **分组**：交接（含认领）建好继任会话后，插件通过宿主的工作区服务（`workspaceRegistry`）把它加进原会话所在的工作区、排在原会话正上方；原会话置顶时继任也置顶（原会话的置顶不动）。原会话未分组时不动。结果记 `steps.workspace`：`attached`（附 `workspaceId`）/ `none` / `unavailable`（宿主没有工作区服务）/ `failed:<原因>`，置顶记 `steps.pin`；工作区 id 和是否由交接置顶记在链接里。撤回时只把继任会话移出交接放进去的那个工作区（用户后来挪到别处的不动），并撤销交接加上的置顶。都不影响交接成败。
- **标题**：新建的继任会话改名为 `[交接←<原会话 id 去掉 session- 后的前 8 位>] <原会话标题前 40 字符>`，原会话没有标题时只有前缀；继任的继任只保留最近一跳的前缀。走宿主的会话改名（与界面改名相同，之后不会被自动标题覆盖），记 `steps.title`。认领已有会话时不改名。
- **自检**多了 `workspace`：原会话在某个工作区时，继任必须在同一个工作区里；原会话未分组记 `skipped`。失败计入 `handed_over_with_issues`，不回滚。
- **旧链接修复**：插件加载、工作区服务可用后，对 `handover.json` 里每条现存链接检查一次：原会话在某个工作区而继任不在任何工作区时，把继任补进原会话的工作区（排在它上方）并把工作区 id 记到链接上；继任标题还是旧的固定标题 `[codex-conductor 交接]` 时按上面的规则改名。继任已在任何工作区时不挪。每条链接只处理一次（打 `repaired` 标记），失败只记日志；做了事的写一条 `handover-history.jsonl`（`action: repair`、`origin: startup`）。
- **目标循环里的自动交接**：宿主的目标循环在会话转为空闲后先落盘、再排下一轮。`auto` 模式在同一个“转为空闲”事件里先同步暂停会话的目标（只限 active 且由循环驱动的目标；用户暂停或改过的不动），再查有没有运行中的 Codex 任务、提交交接；交接用暂停时的目标文字和剩余轮数重建继任目标。查到有任务在跑、会话又开始了新回合、或交接被拒 / 回滚时，把这次暂停的目标恢复（恢复会重新武装，目标循环随之继续），并在 30 分钟内不再尝试。`confirm` 模式询问时不碰目标；用户在面板点“同意交接”（或提醒上的“现在交接”）后，会话此刻停着就立刻、否则在下一个回合边界按同一流程执行。面板上“交接到新会话”按钮仍是直接提交请求，回合在跑时会被拒。
- 交接单“最近的用户指令”改为最多 12 条（每条 600 字符），节首加一句：以下是用户亲手输入的要求，仍然有效，除非与“下一步”或更新的指令冲突。
- 面板的当前交接和最近记录显示继任会话所在工作区的名字（取不到就不显示），自检里显示 `workspace`。

### 0.9.108：面板一键交接、到阈值询问或自动交接

不必再手写请求文件。设置里“Codex 指挥”新增“会话交接”一节：

- **建议交接的会话**：列出消息数超过 `handoverSuggestMessages` 的会话（会话编号、工作目录、消息数），每个旁边有“交接到新会话”；点开可以填一句给新会话的“下一步”（可空），确认后提交。走的仍是 `handover-request.json`，上一份没处理完时拒绝新提交。会话有回合或 Codex 任务在跑时照样能点，插件会拒绝并在“最近结果”里说明，例如“当前有 2 个 Codex 任务在运行，结束后再交接”。
- **需要处理的交接提醒**：按 `autoHandover.mode` 出现。`notify` 起，会话首次被标记时出现一条提醒（“现在交接 / 知道了”），之后消息数每再涨 `remindStepMessages` 条才再提醒一次。`confirm`（默认）在会话空闲、名下没有运行中的 Codex 任务、本身没有交接出去、不在冷却期时改为询问（“同意交接 / 暂不交接”）；同意即提交来源为 `confirm` 的交接，拒绝或放着不理都进入 `cooldownHours` 冷却。`auto` 满足同样条件时直接提交来源为 `auto` 的交接，另加：同一会话 24 小时内最多自动交接 1 次、宿主进程启动后 `startupDelayMinutes` 分钟内不触发；继任会话要从交接时起再涨满一个阈值才会再次触发。插件从不在回合或任务进行中询问或交接，也从不自动带 `force`。插件没有可调用的通知服务，也不借用宿主为工具调用设计的提问服务，提醒和询问只出现在这一节，并写一行插件日志；不会占用会话的模型回合。
- **当前交接**：列出每条交接（原会话 → 继任会话、时间、来源），可“撤回”。继任会话在交接后已有新回合（交接单那一回合不算）或正在运行时，撤回默认被拒（`status: rejected`、`reason: successor_active`，说明“继任会话已有 N 个新回合，撤回会造成两个会话并行”）；面板这时显示原因和“仍然撤回（两个会话会并行）”，再点一次才带 `force` 提交，结果标 `warning: parallel_sessions`。撤回结果的 `sessions` 写明两个会话各自的状态：原会话恢复派活和目标，继任会话目标暂停、它在交接后派出的任务仍归它。
- **最近结果与最近记录**：最近一次交接结果，以及最近 10 条交接、认领、撤回记录。

来源与记录：请求可带 `origin`（`panel` / `auto` / `confirm` / `tool` / `file`，没带时记 `file`）和 `requestedAt`；面板提交自动带 `panel` 和提交时刻。`handover-result.json`、`handover.json` 的链接记录和交接单头部都写入来源和请求时间；状态目录另有只追加的 `handover-history.jsonl`（每次交接、认领、撤回一行：时间、动作、from、to、来源、状态、被拒原因，不含交接单正文），保留最近 200 行。链接记录还记下交接时继任会话的消息数和回合数（`toMessages` / `toTurns`），用于撤回保护和再次触发的判断。目前没有给模型的交接工具，`tool` 只是预留的来源值。

旧会话的自动继续：同机装了 `dsh-client-auto-continue` 时，它的“自动继续”不归本插件管，旧会话仍可能被它推着跑。交接成功后，插件通过宿主设置服务把该插件的 `sessionModes` 里旧会话这一个键设为 `off`（与该插件自己的“设置会话模式”按钮调用同一个 `settings.mutate('auto-continue', …)`，不碰它的其他设置），并把原值记在链接里（原来没有这个键也记下）；撤回时写回原值，原来没有键就删掉。`steps.autoContinue` 记 `disabled`（本次关掉）、`already_off`、`not_installed`（没装该插件）、`failed:<原因>`；宿主设置服务不可写时记 `manual_required`，交接单和面板提示手动关闭。都不影响交接。`autoHandover.disableAutoContinue: false` 完全跳过这一步。

交接单内容：全部由插件从自己的记录和旧会话的内存日志机械提取，不调用模型。依次为：标题区；**下一步**（请求里的 `note` 原文，没有时写“未指定；按目标继续，先完成『待收尾』”）；**目标**（不贴全文，写明已在本会话逐字重建、上限几轮、原会话已用几轮和目标前 200 字符，以 `get_goal` 为准）；**最近的用户指令**（最多 12 条、每条 600 字符、带时间；只收来源为 `user` 的消息，去掉目标续轮、插件和任务通知、没有来源的消息，以及以“继续”开头的自动续接话术、重启续接话术和本插件自己的消息）；**旧会话最后的进展**（最后一个回合的结束原因和时间，最后一个正常结束回合里助手可见回复的前 1500 字符）；**待收尾**和**任务表**（照旧）；**如何回看旧会话**（旧会话 ID；宿主有 `session_read` 工具时写它的用法；另可用 `codex_summary` / `codex_output` 看历史任务报告）；**接手须知**（先核对现状、先收尾、不重派、有下一步就直接推进不为方向提问、不要在旧会话里操作）。各节有字符上限，超出时只留最近的条目并写明“已截断，共 N 条，显示最近 M 条”；整单上限 16000 字符，超出时先把任务表缩成未结束、待验收、需修改和最近 10 单，仍超出就按 接手须知 → 回看 → 任务 → 进展 → 用户指令 → 目标 的顺序整节省略并在标题区注明；“下一步”和“待收尾”从不省略。读日志超过 10 秒就跳过“最近的用户指令”和“旧会话最后的进展”并在标题区注明。

交接后自检：结果的 `checks` 逐项写 `ok` / `failed:<原因>` / `skipped:<原因>`：`goal`（新会话目标存在、与原目标逐字一致（比较哈希）、上限等于剩余轮数）、`settings`（工作目录、预设、模型路由、权限预设、沙箱、审批策略一致，只列不同的项名）、`jobs`（原会话未结束、待验收、需修改的任务在新会话名下按别名实际查得到）、`delivered`、`predecessorFrozen`（原会话目标已暂停、别名已登记、自动继续已关或无需处理）。有失败项时 `status` 为 `handed_over_with_issues`，面板醒目显示，不回滚。只有交接单没送达，或新会话的目标没建起来时，插件自动执行一次不带 `force` 的撤回（交接单那一回合还在跑不算开工），`status` 记 `rolled_back`、`rollback.reason` 写 `delivery_failed` / `successor_goal_failed`；撤回本身被拒时如实记在 `rollback` 里、`status` 为 `handed_over_with_issues`，不再重试。

其他：交接确认和询问里提示“旧会话输入框里还有排队未发的消息的话，请先发出或清空——它们不会跟到新会话”（插件看不到界面的输入队列）。宿主和 `dsh-notify-me` 都没有可供插件调用的通知服务，所以不发系统通知，提醒只在面板里。

### 0.9.106：把长会话交接给新会话

会话历史越长，每一步越慢（整段历史每步都要重发）。交接把目标和 Codex 任务一起转到一个新会话，原会话只读保留。插件状态目录是 DSH 进程的 `%LOCALAPPDATA%\dsh-codex-conductor`（便携版 DSH 一般是 `<DSH 数据目录>\local\dsh-codex-conductor`，即 `loaded.json` 所在目录）。步骤：

1. 等原会话停下来：没有正在进行的回合，也没有运行中的 Codex 任务（否则会被拒绝，见第 5 步）。
2. 在状态目录写 `handover-request.json`，建议先写临时文件再改名：`{"sessionId":"session-原会话","note":"可选，给新会话的一句话"}`。
3. 读 `handover-result.json`：`status` 为 `handed_over` 时，`to` 是新会话 ID，`briefPath` 是交接单文件；`steps` 逐项写明做了什么：`session`（created / adopted）、`alias`（linked）、`predecessorGoal`（paused / unchanged_* / none / failed: …）、`delivered`（prompted / prompt_pending / failed）、`successorGoal`（created / exists / none / failed: …）；`pending` 列出待收尾的任务。`refused` 时看 `reason`：`turn_running`、`jobs_running`（`running` 列出任务）、`already_handed_over`、`jobs_unreadable`、`session_not_found` 等；`rejected` 表示请求格式不对。
4. 在界面打开新会话：首条消息是交接单。确认它能看到原会话的任务：让它调 `codex_jobs`（session_id="current"）或 `codex_summary`，列表里应有原会话的 job_id。原会话此后不能再派活、验收、续接、核验或取消（会提示已交接给新会话），只能查看。
5. 确需在有运行中任务时交接，加 `"force": true`；这些任务的结束通知仍发到原会话，新会话用 `codex_status` 查询结果。
6. 插件建不了会话时（例如宿主接口不可用），先在界面里同一工作目录新建会话，再写 `{"adopt":{"from":"session-原会话","to":"session-新会话"}}`，其余步骤相同。
7. 撤回：写 `{"revert":{"from":"session-原会话","to":"session-新会话"}}`。插件删掉这次交接记录，暂停新会话的目标、恢复原会话被暂停的目标；新会话在交接后派出的任务仍归新会话。

何时交接：会话消息数（用户、助手消息和工具结果）超过 `handoverSuggestMessages`（默认 5000，0 关闭）时，`codex_runtime` 和面板的“建议交接的会话”会提示；规划端在 `codex_run` / `codex_jobs` 的结果里每个回合最多看到一行提示，会转告用户，但不会自己发起交接。插件还把各会话的消息数写进状态目录的 `history-status.json`（只有会话 ID、消息数、是否建议、阈值和时间），供外部看门狗读取。交接单里的任务号（job_id）用于各工具的 job_id 参数，线程号只为需要返工的任务列出、只用于 `codex_run` 的 resume；`codex_status` 和 `codex_output` 误收到本会话的线程号时会解析为该线程上最新的任务并注明。

交接单只用插件和 runner 已有的记录机械生成：目标、轮次、收尾截止时间之后的任务（状态、结论、是否有标记、线程、目录、diff、任务首行）和待收尾清单；不调用模型。交接记录存在状态目录的 `handover.json`（原子写入，可成链 A→B→C，每个会话只能交给一个后继，不能成环）；只有本机请求文件能写它，模型不能。新会话在收尾护栏里也要对原会话已结束的任务收尾，截止时间规则不变；会话的 `maxSessionJobs` / `maxSessionTokens` 仍按各自会话计算。新会话沿用原会话的工作目录和预设，模型用宿主的默认选择，需要时在界面里切换。

### 0.9.92：从本机修改会话 Goal

向同目录的 `goal-request.json` 写入 `{"sessionId":"session-example","objective":"新的目标","maxGoalRounds":20}`，建议先写临时文件再改名发布。`objective` 和 `maxGoalRounds` 至少提供一个：目标须为非空字符串，轮数须为正安全整数。插件加载指定会话，读取当前未完成 Goal（包括 paused / blocked），用其最新 `id` / `revision` 调用宿主 `goals.edit`，保留原 phase 和激活状态；修改会记录在该会话的持久日志中。这个入口与 send / resume 共用目录监视、串行处理、原子认领及 tmp + rename 结果发布；发布成功后消费请求，不自动重放已认领文件。`goal-result.json` 包含 `requestedAt`、`completedAt`、`sessionId`、`status`、`reason`；`reason` 区分 `edited`、`no_active_goal`（无 Goal 或已完成）、`session_not_found`、`invalid_request`、`error`。仅供本机操作者使用。

### 0.9.52：从本机请求续接被中断的会话

向 `%LOCALAPPDATA%\dsh-codex-conductor\resume-request.json` 写入以下 JSON（与 `loaded.json` 同目录）。建议先写临时文件，再在同目录改名发布，避免插件读到未写完的 JSON：

```json
{"sessions":["session-example"],"message":"继续"}
```

`message` 可省略，默认“继续”，最多 2000 个 Unicode 字符。`sessions` 最多 20 项，ID 仅接受 `[A-Za-z0-9_-]{1,100}`，重复 ID 只处理一次。插件加载、热重载和目录文件通知时检查手动请求。请求先原子改名认领，再逐个处理：不存在、正在运行或最后一个回合不是 `interrupted` / `blocked` 的会话跳过；其余优先恢复可恢复的目标。没有可恢复目标时，`interrupted` 沿用提交用户消息的方式；`blocked` 仅在 inbox 有待处理输入时调用宿主现有的 `wakeDriver()` 唤醒，不新增消息、不重发被拒的推进提示，也不自行改写 inbox；没有待处理输入仍以 `not_interrupted` 跳过。宿主缺少 agent、inbox 查询或唤醒接口时记录错误并继续处理其他会话。未在窗口打开的会话也可加载后续接。

同目录的 `resume-result.json` 包含认领时间 `requestedAt`、完成时间 `completedAt`、整批状态 `processed` / `rejected`，以及 `sessions` 数组中的 `sessionId`、`status`（`resumed` / `skipped`）、`reason`、`method`（`goal` / `message` / `inbox` / `null`）；出错时另有 `error`。`pending_inbox_woken` 表示“已请求会话处理还在排队的输入”，只表示唤醒已发起；每份手动请求只尝试一次，也不补回宿主已领取的输入。输入不合法时整批拒绝，不提交任何消息。目录监听不可用时会记警告，仍在加载时检查。结果只保留最近一批；提交下一批前先核对本批时间并读取结果。已认领的请求不在重启后自动重放，避免重复提交。

`autoResume` 默认 `{"enabled":true,"maxAgeHours":12,"message":"Harness 已重启，接着上次中断的地方继续。","exclude":[],"delaySeconds":0,"reloadDelaySeconds":20}`。宿主就绪后每个进程扫描一次主会话，先用持久化文件的修改时间筛掉超龄会话，不读取它们的事件；只对窗口内会话读取尚未补齐收尾的原始日志。空闲会话仅在 Goal 为 active + disarmed 且轮数未用完时恢复原生 Goal 驱动；没有活动 Goal 时，仅原始末回合未写 `turn/end` 或以 `error` 结束才发启动续接消息。paused / blocked 的 Goal 自动模式一律不动；已写入的普通 `interrupted` 不作为启动续接依据，避免重新拉起用户停止的对话。正常完成、正在运行、超时、`exclude` 中的会话和 ID 无 `session-` 前缀的 BTW 旁支均跳过；手工 `resume-request` 行为保持不变。`message` 最多 2000 个 Unicode 字符，`maxAgeHours` 须为正数，`exclude` 为会话 ID 数组；设 `enabled:false` 关闭。`autoresume-state.json` 记录 PID 加进程启动时间标识及已续接会话，扫描开始前即登记该进程，因此同进程热重载不会重复执行启动扫描。`autoresume-result.json` 保留最近一批的时间、整批状态及每个会话的 `sessionId`、`basis`（原始/加载后回合类型、Goal 状态或跳过依据）、`status`、`reason`、`method`；续接成功只表示已提交，不保证新回合完成。

`autoWakeBlockedInbox` 默认 `true`：插件观察到自己登记的 Codex 后台任务完成通知进入 owner 的 inbox 后，如果该会话随后以 `blocked` 结束，通知仍在 pending 且 agent 已空闲，就复用上述 inbox 唤醒入口，无需恢复请求文件。第一次等 1 秒，第二次等 5 秒；同一批仍滞留的通知最多自动唤醒两次，新加入的通知不重置该批预算。仍被拒且通知仍在时，警告日志显示“自动唤醒已用尽”。通知被领取、正常回合结束且通知已不在 inbox、agent 被移除或插件卸载时停止；运行中的会话不唤醒。不新增用户消息、不重发推进提示、不修改 inbox。配置设为 `false` 可关闭，手动恢复不受影响。

正常卸载根宿主时，插件在 Agent 被取消前把仍 running 的会话写入 `autoresume-state.json` 的 `pending` 名单。下次进程启动时，名单内以 `interrupted` 或 `aborted/disposed`、`aborted/parent` 收尾的会话也可续接；已完成、paused / blocked Goal 和显式 `aborted/user` 仍跳过。没有停机名单的 `interrupted` / teardown 收尾会在启动扫描中记为 `interrupted_without_shutdown_marker`；`basis.cancelCause` 保留嵌套取消原因。这依赖关闭流程实际卸载根宿主；直接强杀走原始未闭合回合的判定。

同进程热重载的名单和卸载时间也写入 `autoresume-state.json`。新实例等 `autoResume.reloadDelaySeconds` 秒后，只续接卸载时仍在运行、以 `interrupted` 结束且结束时间落在卸载前后 60 秒内的回合。如果确认是同进程重载但没有卸载记录，就检查本进程最近 10 分钟的末回合。已有新回合、正在运行、已交接、已归档、用户手动停止或排除的会话会跳过。续接沿用现有 Goal 规则和 `autoResume.message`，结果记录为 `trigger: "reload"`。

上述通知唤醒只追踪本次加载后实际观察到的本插件任务通知，不扫描重放历史通知；唤醒不保证门禁放行，宿主已领取且未退回的输入无法补回。目前 `gemini_write` 直接返回前台执行结果，没有独立后台 job 或完成通知，因此不进入这条通知唤醒路径；成功正文的禁读登记从本会话已有回执恢复。

## 功能

**派活工具**

| 工具 | 作用 |
| --- | --- |
| `codex_run` | 把任务交给 WSL 里的 Codex；登记后台任务后直接返回任务号。必填 `task`、`acceptance`（至少 1 条验收标准，条数不限，每条至少 4 个字符）和 `write`（要改文件、做修复或建备份传 `true`，只读调查传 `false`）；可选 `must_verify`、`model`、`host_access`（需开启 `allowHostAccess`）、`scope`、`writable_roots`、`cwd`、`resume`、`use_user_config`、`effort`、`wait_seconds` |
| `codex_verify` | 独立核验本会话一个已结束的任务：新线程、只读，沿用原目录和主机访问，先核对 `must_verify`，再回到出处抽查其余结论；启用 `modelAB` 时用配置默认模型，否则沿用原模型。可选 `focus`、`samples`（默认 8，1–30）、`wait_seconds`；结束后用 `codex_review` 记录原任务的验收 |
| `codex_status` | 派单后留在本轮，用 runner `job_id` 与 `wait_seconds: 3600` 长等，仍在运行就继续等同一任务。120 秒内无实质变化的重复查询保留短回执，并引导长等、不结束本轮 |
| `codex_cancel` | 取消任务，在 WSL 内结束 Codex 的整个进程树；任务已经结束时返回它的结果和下一步 |
| `codex_jobs` | 按工作区、会话、执行状态或待关注状态分页查询任务，找回 runner job ID、Codex thread ID 和 Harness 后台任务编号；显示新任务的派单来源及可查的后台状态 |
| `codex_output` | 按 Unicode 字符分页、可重复读取完整原始报告、结果 JSON、原任务与验收上下文或 stderr / events 日志；读取不消费结果，也不启动或恢复任务 |
| `codex_continue` | 回答阻塞问题或提供环境恢复依据后续接原任务；保留原线程、目录、验收、write、scope 和权限，同一父任务不重复派活 |
| `codex_review` | 保存规划端逐条独立核验的证据与结论；通过、待修正、明确接受偏差分别记录，原报告保留 |
| `codex_summary` | 按 Codex 线程汇总多轮结果、涉及文件、未闭环事项、已结束耗时和用量，并统计筛选范围内的错误类型；执行状态与独立核验分别展示，不重复相加线程累计用量 |
| `codex_watch` | 安静观察当前会话的原生 Codex 后台任务，首次重要变化时通知；停止观察不会取消 Codex |
| `codex_runtime` | 查看源码与实际加载版本；明确请求立即重载或等任务空闲后重载，收到真实加载标记才确认生效；`action="doctor"` 只读自检 WSL 里的 Python、Codex、登录文件、路由和 bash，不启动任务 |
| `gemini_write` | 配置 `gemini` 后才注册；读取素材并交给本机 agy 的 Gemini 写单个教程或文档文件，读回统计字数并列出范围外改动 |

### 任务生命周期

从 `0.9.121` 起，`codex_run` 提示规划端一单只派一个可独立验收的结果，验收超过 8 条先按共同前置拆单。交付文件或启动会落盘的程序须按授权传 `write=true`，`scope` 列全必写路径。沙箱模式下，额外可写目录用 `writable_roots` 指定。真机、网络和宿主能力写入前置条件，按配置和授权设置 `host_access`。每条验收写结果、正常观测入口和预期值，证据须能在本轮取得。哈希、校验和、逐文件枚举、纳秒时间戳、过程进度文件及全程零写入或零外发的证明，只在涉及数据完整性、身份真实性、备份恢复或安全边界时要求，并注明用途。

计划步骤、工具或路径不可用时，Codex 可在原授权内用等价方法验证同一结果，并在 `deviations` 说明替换及等价理由。副作用无法确认、会越权或破坏数据时，停下该步。实测不符记 `not_met`。缺权限、环境、输入或证据无法补采时记 `blocked`，写明缺失的前置。同一前置导致多条未测时，其余条目引用首条。脚本关键观测、清理或恢复失败须以非零状态退出，未运行的步骤不能报通过。

- 任务目录：传了 `cwd` 就用它；否则会话工作区落在某个带 `cwd` 的 `workspaces` 条目里时，用该条目的 `cwd`（有多条时取路径最长的那条）；再否则用会话工作区。只在 `task` 里写目录不会切换任务目录。

默认 `plannerAnswers=false` 时，收到需要回答的问题后，规划端先问用户，等原会话收到实际回复再调用例如 `codex_continue({"job_id":"J1","answers":[{"id":"choice","answer":"采用已确认的方案"}]})`。没有收到该问题产生后的用户回复时，即使传齐 `answers`，也只返回待答问题。环境恢复时用 `resolution` 写实际证据。续接不会修改原验收或增加写权限。同一线程中较早的任务仍未收到用户答复时，`codex_run` 的 `resume` 和 `codex_continue` 都不会启动新作业，较新的任务状态不会覆盖待答问题。最近一轮仍待答时，请先询问用户并用 `codex_continue` 提交回答。同一会话里有待答范围冲突时，新写任务按各自工作目录解析写入路径；如果与原范围重叠并扩大范围，即使换了工作目录也必须先等用户答复。历史归属未知、状态未知或已取消的任务不会自动恢复。已存在后续轮次时返回它，后续处理使用最新 `job_id`，避免同一父任务反复派活。续接累计保留原目标、历轮用户决定与本轮补充；没有可续接线程时，另开线程也会带入这些决定，不堆叠历轮报告。

`codex_watch({"mode":"attention"})` 仅在失败、阻塞或报告异常等变化时通知；`mode="all"` 也包含开始和正常结束。它在无变化时只读 Harness 内存任务表，不启动 Codex、不反复唤醒模型。首次符合条件的变化后观察结束，需要继续时再调用。它保留任务原有结束通知，也不默认启用长期监控；取消观察只停止观察。

`codex_runtime({"action":"status"})` 显示磁盘源码版本、实际加载记录、待生效差异、Codex 活任务数、运行中会话数和 `idle_wait` 等待状态。`loaded` 包含实际加载的默认权限、服务档位和网关设置；`serviceTier: null` 表示沿用 Codex 配置。网关只显示提供方、主机端口和探测方式。`action="reload"` 默认 `when="idle"`，同时等 Codex 活任务和所有 DeepSeek 会话的当前一轮结束，重载前重新确认空闲，无法确认会话状态时拒绝重载；最长等 10 分钟，超时停止自动重载，用 `action="status"` 查看 `idle_wait.status="timed_out"`，可重新请求等空闲。`when="now"` 明确要求立即热重载，Codex 后台任务继续并会接回，但正在进行的 DeepSeek 回合可能被中止。先配置 `runtimeProfileFile` 为这个桌面实例实际使用的 `cordis.patch.yml` 的完整 Windows 路径。只更新本插件的 entry id 与模块 URL，不重启宿主；请求重载后最多等 30 秒确认加载。确认超时返回“尚未确认”，用 `action="status"` 继续查。重复重载会观察已提交的同一请求；只有实际加载标记才证明生效。若 Harness 明确报告加载错误，先修复错误再从 Harness 刷新插件。
配置已改到另一模块路径时，状态可显示唯一使用本插件生成 ID 的目标，并提示在 Harness 内刷新；旧实例不能改写该条目。

- 任务在 WSL 后台运行，DSH 这边断开等待不影响任务；重试、超时、断线检测和目录写锁由随包的 [`runner/codex_runner.py`](runner/codex_runner.py) 处理。路由不可用时的重试保留尚未发送的任务提示；启动与取消同步，PID 或事件日志写入失败也会结束并回收子进程。即使 Codex 提前关闭标准输出但进程仍存活，超时、空闲和断线预算仍然生效。

- `timeoutSeconds`、`idleTimeoutSeconds`、`retries` 可在插件配置中设置；留空时不传对应参数，沿用 runner 的每次尝试总超时 3600 秒、空闲超时 600 秒和最多重试 2 次。超时、重连、退出宽限、查询等待和快照预算使用单调时钟，事件时间、重试时间和显示耗时仍使用墙上时钟。未完成的 `command_execution` 按 item ID 配对，在命令完成前暂停空闲超时，仍受总超时及重连预算限制；命令完成后恢复空闲计时。

- 路由失败不丢弃只读任务已有的 resume 线程。写任务自动重试时，只有本轮收到命令、文件改动或助手消息的实际工作事件，才改用“检查现状并完成原任务”的提示；仅启动线程、开始 turn 或出现配置警告时保留完整提示，避免丢掉用户续接回答。失败分类只读取本轮新增的 stderr，完整日志仍跨尝试保留。

- 可写任务锁住任务目录；`workspace-write` 还会锁住本次显式指定的额外可写根。因此，不同 `cwd` 共用同一额外可写根的任务也会互斥。规范化后相同或存在父子关系的写入根会互斥，互不重叠的目录仍可并发；worker 退出后，经 PID 身份核对仍存活的残留 Codex 会继续占用写入根，直到其退出。任一所需目录的写锁被占用时，后来的任务自动等待，状态为 `running`、阶段为 `lock_wait`，面板显示“排队等待目录写锁”。获得锁之前不会启动 Codex、检查路由或拍改动快照；取消这个排队任务不会取消持锁任务。继续用原 `job_id` 等待，不要重新派活。需要同一写锁的后台任务按提交顺序启动；`--timeout` 仍只限制每次 Codex 尝试，不包含排队时间，不想继续等时用 `codex_cancel`。`lockTimeoutSeconds`（runner 的 `--lock-timeout SECONDS`）可限制排队秒数，留空时无限等待；使用单调时钟，超时以 `lock_timeout` 失败且 `retryable=true`，不启动 Codex、不拍快照，也不影响持锁任务。此时先用 `codex_jobs` 查同目录正在运行的任务，再决定等待还是取消持锁任务，不要直接重派。

- 插件每次调用 `wsl.exe` 都有上限：`start` 和 `cancel` 120 秒，`status` 在它自己的等待秒数之外再留 60 秒。计时按 1 秒一跳，电脑睡眠唤醒不会立刻误判超时。WSL 卡住或起不来时按 `bridge_error` 返回，工具调用不会一直挂着；已知 `job_id` 的任务这时提示先用 `codex_status` 查询，不要直接重派，后台监控也会容忍偶发的一两次 `bridge_error`。

- Harness 重开后，恢复原会话时会接回该会话已登记、未结算的 Codex 作业；热更新时也会检查当前已打开的会话。只接回归属能确认的原作业，不重新派发，结束结果仍走原生后台通知。恢复和待答范围核对复用分页任务记录，不为每项再单独查询状态；无法核对范围时仍拒绝启动。

- worker 启动后自行登记 PID 与进程创建时刻，父进程提前断开也可继续查询和取消。worker 死亡时，若已有 Codex PID 仍通过原有身份核对，结果会带 `residual_codex_pid`、`retryable=false` 和明确说明；须处理残留进程后再重派。状态查询只标记，不主动结束该进程。
- WSL 重启后，runner 按「开机 ID + 本发行版 init 的启动时刻」认出重启前的任务（`wsl --shutdown`、Windows 重启换开机 ID，`wsl --terminate`、发行版自行停止换 init 启动时刻），报 `worker_died`，阶段为 `interrupted`。可写任务先核对原验收和已落盘产物；确认还有缺项时才补做，已开始会话的任务保留原 `thread_id`，状态查询和取消还会核对进程创建时刻，避免把同次启动内复用 PID 的其他进程当成本任务；重试等待期间也不沿用已退出 Codex 的进程记录。升级前未记录创建时刻的旧任务仍按启动批次和存活状态判断。`codex_cancel` 对已经结束的任务直接返回它的结果与对应下一步，不会叫 agent 重派。

- 任务表与结束通知：agent 的 preset 提供 DSH 后台任务（jobs）服务时，Codex 派单会登记为一个后台任务（`Codex <job_id>`），DSH 任务表里立刻出现这一行，进度行约每 20 秒刷新一次，显示距 Codex 上次活动的秒数和它最近的动作。`codex_run`、`codex_continue`、`codex_verify` 派单时传 `wait_seconds: 0`；登记成功后立即返回 `background_job_id`，不等待完成。做完独立的规划工作后，留在本轮，用返回的 runner `job_id` 调 `codex_status({"job_id":"runner-job-id","wait_seconds":3600})`；仍为 `running` 就继续长等同一任务，不零等待轮询、不重复派单。3600 秒是单次状态等待预算，与执行超时、排队和重试预算分开。

- 等待调用已返回报告就直接验收，不再重复取报告。只有摘要、缺内容或截断时，才把 Harness `background_job_id` 填到 `job_output` 的 `job_id` 中补读；该入口不可用或没有后台编号时，用 runner `job_id` 调 `codex_output(artifact="report")`，按 `next_offset` 补齐至 `eof=true`。调用报错或被中止时先确认原任务状态，不据此重派。完成通知及会话空闲唤醒机制保留；通知附可直接调用的 `codex_output` 参数，监控中断时附 `codex_status` 参数，不作为派单后结束本轮的理由。

- 同一任务书连续失败时不要原样重派，先按回执里的失败类别处理。回执显示尝试次数和记录的改动文件数，有改动先核对现状。模型拒绝（`model_refused`）为终态，由用户决定下一步。重连超时、空闲超时、路由不可达或暂时性服务故障在 runner 结束后，先确认故障解除且任务确有缺项，再用 `codex_run` 的 `resume` 与 `fresh: false` 续接可用线程。总超时和上游拒收不自动重试。报告缺失或无效时，按需用 `codex_output(artifact="report")` 补读，用 `codex_verify` 核验已有产物。

- 同一个 runner 任务只登记一个后台任务（按 DSH 任务表判断，插件重载后也不重复）；对已登记任务的状态等待不重复发送同一完成结果。中止 `codex_status`、`job_output`、`codex_watch` 等纯观察，只停止本次观察，不结束后台任务或取消 Codex。显式 `codex_cancel` 和归档会话的取消机制保留；取消未确认时保留任务编号并提示用 `codex_status` 查询，任务仍可能在运行。后台监控本身出错时送回 `monitor_failed`，提示先确认原任务状态。没有 jobs 服务、登记失败或没有 agent 时，`codex_run` / `codex_continue` / `codex_verify` 按 `wait_seconds` 同步等待（默认 `0`）；中止这类未登记后台的派单同步等待仍会取消 Codex。派单返回运行中任务后仍按上述方式在本轮长等。

`codex_status` 每次仍查询实时状态；同一会话、同一工具、同一 job 在上次完整回执后的 120 秒内没有实质变化时，重复查询只返回“仍在执行、无实质变化”的简短成功回执，并引导用同一 runner `job_id` 调 `codex_status(wait_seconds: 3600)` 留在本轮长等；有后台任务时保留自动完成通知，不要求结束本轮。阶段、尝试轮次、错误、实际活动、报告或阻塞信息变化，以及完成、失败或未知状态，均返回完整内容；活动秒数和重试倒计时单独变化不算进展。短回执不延后下一次完整回执的时间，`wait_seconds > 0` 不缩短。

原生 `job_output` 先照常执行归属校验与消费读取；仅对本插件自己的运行中 Codex job，在没有新模型输出且状态不变时应用同样的短回执，`wait: true` 不缩短；短回执同样引导本轮长等，中止读取只停止观察。`codex_jobs` / `job_list` 的列表和 `codex_output` 的产物分页保持完整。去重记录只在当前插件实例内，重载后首次查询返回完整状态；它减少回执内容量，外部推进提示产生的模型回合仍由宿主控制。

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

独立核验使用 `codex_review`：`criteria` 用原验收标准从 1 开始的 `index`，逐项提供 `status` 和实际 `evidence`；结论为 `verified / needs_changes / accepted_deviations`。通过结论要求各项实际通过；默认 `plannerAnswers=false` 时，有报告偏差或范围外改动，接受前必须等作业结束后的原会话用户确认，再在 `accepted_deviations` 中按 `reported / scope` 与 1 起始编号逐项记录依据。历史存入任务目录的 `reviews.json`，原 `result.json` 和 Codex 报告不改写；可用 `codex_output` 的 `artifact="review"` 分页重读。

所有验收项均为 `met`、无活动 blocker 且无报告偏差或范围外改动时，插件拒绝 `needs_changes`，不自动改判；被审正文或产品的缺陷写入 `notes` / 结论，审计任务本身记 `verified`，真实执行缺口须记为 `not_met` / `blocked` 或添加有证据的 blocker。

`codex_summary()` 默认汇总当前会话；传 `cwd` 可汇总一个项目，`thread_id` 可只看一个线程。默认每页 10 组，沿用筛选和 `limit`，用 `next_offset` 作为下次的 `offset` 翻页；总组数和总轮数始终按全部匹配记录计算。没有线程号的任务独立成组。最新轮次的执行状态与独立核验结论分开显示，不能据此宣称整个项目永久无问题。线程累计 token 只取最新可用累计值；混合或未知统计口径会明确标出，耗时只加总已结束轮次。

汇总的 `error_kinds` 按本次筛选范围统计各错误类型的任务数，包括同一线程中的不同轮次；文字结果显示一行错误分类计数。统计覆盖全部匹配任务，不随当前页变化，也不增加筛选参数。

- 无法查询任务、记录损坏或监控失联时，`execution_status="unknown"` 表示执行结果未确认；`report_status="missing"` 只表示当前未取得结构化报告。取消遇到这些状态或任务仍在运行时会明确提示“取消未确认”，不能据此宣称任务已经结束或直接重派；启动调用未取得任务编号时，也先按相同任务目录查询历史找回 ID。历史范围判断使用已记录的规范化路径，后续文件被替换成符号链接不会改写那次任务的范围结论。

- 执行、报告和验收分别显示：`execution_status` 是执行状态；`report_status` 为 `valid / invalid / missing / pending`；`review_status` 为 `needs_attention / needs_verification / pending`。格式错误、受阻、未满足、有未解决事项、偏离计划或超出范围的任务列为待关注；模型自报全部满足也仅为待核验，不代表已独立验收通过。摘要同步显示“待关注”“待核验”或“报告异常”。

- 进度包含尝试轮次、当前阶段、上次错误分类和下次重试时间；阶段区分检查路由、Codex 执行、等待重试和生成最终结果。进度查询不改变超时或重试策略。

- 原生任务面板会记录进度和最终报告，完成后也可展开。取消请求未确认时持续显示失败原因和任务编号；取消结果保留目录、权限模式和已有可续跑线程信息，仍由用户决定是否恢复，不自动重派，也不将缺少改动清单解释为没有改动。

- 要求 Codex 按 [`report.v2.schema.json`](report.v2.schema.json) 逐条回报（met / not_met / blocked、证据、改动文件、偏离计划、未解决）。结果里会标出它自报未满足或受阻的条目、偏离计划的地方，以及超出 `scope` 的改动。最终答复的版式由插件固定为这份 JSON：`task` / `acceptance` 里对版式的要求（如单独的末行结论行）写进 `summary` 就算满足，Codex 不会因此标 `blocked`；工具说明也让 agent 不要再规定这类版式。

- 已完成的结果保留核验所需信息：汇报条数和编号与验收标准对得上时，逐条显示验收原文，下一步按编号指出未满足项；逐条汇报的每条证据最多显示 800 字，全文在 `log_dir` 下的 `last_message.txt`。详细字段包含任务目录、一行改动清单、执行/报告/自报检查状态、已有的独立核验结论与证据、用量（不是费用），以及核验异常、忽略规则警告等提示。改动超过 300 个时只列前 300 个，并说明超出 `scope` 的检查也只覆盖这些；报告容器不合法时退回原始答复。失败、取消和仍在执行的结果保留诊断字段；完整原始字段在 `runnerHome/jobs/<job_id>/result.json`。阻塞按明确分类处理，续接沿用原 write、scope 和主机权限；需要扩大授权时另行明确派活。

- 一行摘要：任务结束后，任务表那一行和结果的第一行都以一行摘要开头，如 `completed · 12 met / 1 blocked · 3 files · 148 s`（状态、按 met / not_met / blocked 计的验收条数、改动文件数、用时；只读任务没有文件数），失败或取消时是 `failed · timeout · 30 s` 这样的状态、错误类型和用时；结果第一行在摘要后照旧带 `job_id` 和 `thread_id`。结束的行留在任务表里，摘要就在那里看。任务表那一行的标题是 `Codex <job_id> · <任务第一行>`；聊天里 `codex_run` 的卡片进行中显示 `Codex · <任务第一行>`（返工、带 host_access 时会注明），结束后标题换成同一行摘要。被取消的任务不按失败处理：提示先问用户，并提醒可写任务可能已改了一半、没有改动清单。

- 续跑（`resume`）时 Codex 报的用量是整个线程的累计值，结果里在 `usage` 旁加 `usage_scope: "thread_total"`（不换算成本次增量）；只读任务实际启动后失败重试时放弃续跑、从头开始，这时的用量只算本次，不加这个标记。路由检查失败时尚未启动 Codex，仍保留原线程。

### 存储

- `maxStorageMb`（runner 的 `run` / `start --max-storage-mb N`）可设置 `jobs` 与 `runs` 的合计大小上限，单位 MiB（1 MiB = 1024² 字节），留空不限制。设置后先执行原有 30 天清理，再按 `result.json` 保存时间从旧到新删除已结束任务，清理发生在本次任务目录创建前。运行中、排队中，以及身份核对后 worker 或 Codex 仍在的目录不删；无法删除或保留任务已超上限时只尽力清理，不报错。该上限在启动时执行，不限制单个日志文件或正在运行任务的增长。

- 历史查询默认使用当前工作区；`session_id="current"` 查询当前会话，也可指定会话 ID。新任务将 owner、原任务、原验收标准和写入意图保存在已有任务参数中，长任务不会受 Windows 命令行参数长度影响。旧任务优先关联 Harness 会话 journal 和原生任务表；无法确认归属的保留未知，可按工作区找回。完整上下文用 `codex_output` 的 `artifact="context"` 读取。

- 完整结果读取使用 `job_id`，不是 `background_job_id`：`artifact="report"` 读取原始报告，`result` 读取执行结果，`context` 读取原任务与验收，`review` 读取独立核验历史，`stderr` / `events` 分别读取 `stderr.log` / `events.jsonl`。默认每段 4000 个 Unicode 字符，最多 8000；按返回的 `next_offset` 继续读取，直至 `eof=true`。日志在任务运行中也可读取；缺失或空文件会明确说明。这也适用于 `job_output` 已消费或被 64 KiB 上限截断的结果。旧任务没有保存上下文时会明确说明。

- 运行阶段原子保存在小文件 `phase.json` 中，状态查询直接读取；旧任务缺少该文件时回退扫描事件日志。历史查询复用已读参数和结果，合并筛选条件；不需要执行状态或待关注筛选时，仅对所选页的已结束记录补齐完整状态；汇总无结果任务的错误时仍核对其实际存活状态。`/mnt/<盘符>` 路径在写锁、快照缓存、历史目录筛选和范围比较中统一忽略大小写，原生 Linux 路径仍区分大小写；历史范围比较不会跟随后来创建的符号链接。

- 可写任务前后对任务目录做快照，列出新增、修改（包括文件权限变化）、删除的文件（`files_changed_source` 为 `snapshot`）。快照也会记下同时段其他进程写的文件（如定期日志），所以“超出 scope”的清单里可能有它们；提示里会说明：不在 Codex 自报 `files_changed` 里、明显来自其他进程的文件只需一句说明，不算 Codex 越界，也不用请用户决定。完整快照成功时也会合并 `cwd` 外已收到的 Codex 文件事件（`snapshot+codex_events`），目录内以快照为准；权限或 IO 错误导致快照读取失败时退回文件事件，不把不完整扫描当成删除依据。事件只覆盖 Codex 自己的改文件工具，不包含 shell 写入，也不会为补全清单而扫描额外目录。

- 总是由其他进程写的文件可以写进配置 `ignoreChanges`：按 Python `re` 方言验证和匹配，不能使用 JavaScript 专属语法；无效模式跳过，并在任务结果中明确警告。runner 在截取前 300 条之前就去掉匹配的文件，它们不计入改动清单、改动数和超出 `scope` 的检查（`result.json` 里也不再记录）；交接提示里会告诉 Codex 这些文件可能被其他进程改动，不要因此判定现状不符或标 `blocked`，任务本身要求处理它们时照常处理。

- 目录大到 20 秒内扫不完时，7 天内同一目录不再整树扫描：给了 `scope` 就只快照 `scope` 里的路径，`scope` 之外的改动取 Codex 自报的记录（`scope_snapshot+codex_events`）；没给 `scope` 就只用 Codex 自报的改动（`codex_events`）。只有实际耗尽预算才记录“大目录”；权限或 IO 错误回退到事件，不写入该记录。

- `start` 顺带清理结果已保存超过 30 天的已结束 `jobs` / `runs` 目录；没有结果的目录只有在 worker 与 Codex 都已不存在、目录及内部最新修改时间均超过 30 天时才清理。运行中和排队任务会保留，不因目录时间较旧而删除。

- 规划要求：你写给 DeepSeek 自己的固定规划要求（怎么拆任务、写 task 和验收标准时要注意什么），放在 `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md`（DSH 便携版在其数据目录的 `local\dsh-codex-conductor\` 下；`loaded.json` 里的 `plannerPromptFile` 是实际路径）。插件首次加载时放一份只有注释的模板；注释以外的内容作为系统提示词的一段注入，agent 每一步都带着，压缩上下文也不会丢；保存后下一步就生效，不用重载。它不会原样发给 Codex。设了内容时，每次 `codex_run` 完成的下一步提示里也会提醒对照这些要求。宿主没有系统提示词服务时不注入，其余功能照常。

### 工作区护栏

十一个 Codex 工具始终注册；`gemini_write` 仅在配置 `gemini` 后注册，并作为受控写入通道在护栏内放行。`workspaces` 只控制护栏。会话工作区在配置范围内时，以下规则生效。Linux 原生路径也受支持，`workspaces: ["/"]` 覆盖原生 Linux 根目录及其子目录，`scope` 也可使用 `/`；Windows 盘符及 `/mnt/<盘符>/...` 仍按 Windows 路径匹配。

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
- `sed` 支持固定的 `p` 打印和 `s` 替换输出（可用 `;` 组合），拒绝 `-i/-f/-e`、`w/e/r` 命令及替换的 `w/e` 标志；打印地址沿用行号、`N,M` 或不含 `\`、`$` 的 `/正则/`，取末行用 `tail`。`awk` 支持固定的 stdout 程序，拒绝 `system`、进程管道、写重定向、`getline` 和扩展加载。`find -exec/-execdir` 只接受完整的已放行只读命令，拒绝删除、文件输出及交互执行动作。`dd` 仅接受 `if=/bs=/skip=/count=` 并输出到 stdout；`paste`、`tr`、`base64 -d`、`ssh-keygen -l -f` 可用于读取核验。
- 普通数据变量可作为只读命令的赋值前缀；会改变命令查找、启动代码或执行选项的环境变量不放行。命令开头用 `;` 或换行分隔的字面路径赋值可用于后续核验及只读命令替换，未知变量和可能生成危险选项的展开仍拒绝；条件、循环或 `read` 会清除已知变量信息。`xargs` 仅支持可选的 `-r` 加固定的 `cat` 或 `sha256sum`。`printf -v` 和含 `$` 的首参数不放行，其余输出参数仍可用变量和只读命令替换。
- 有参数过滤的命令（`git`、`find`、`sed`、`awk`、`dd`、`base64`、`ssh-keygen`、`icacls`、`sort`、`uniq`、`iconv`、`rg`、`tree`、`file`、`date`、`node`、`go`、`cargo`、`make`、`npm/pnpm/yarn`）不接受未确定的变量或命令替换、未引用的花括号展开或可能展开成选项的未引用 glob（如 `find . -[d]elete`）；`sed/awk` 的脚本本身也不能由 glob 生成。带固定路径前缀的文件匹配（如 `find src/* -type f`、`git diff src/*.mjs`）和引用的字面模式仍可用；`cat $(ls)` 这类读取也不受此限制。输入重定向的目标也接受同样的替换检查；`-v/-R` 和 `read` 的赋值目标必须是安全的字面变量名，`read` 的提示文本仍可使用变量。`git grep -O/--open-files-in-pager`、Go 的 `-exec/-toolexec/-vettool`、`sort --compress-program/--random-source` 不放行。Git 另支持 `config --get/-l/--list`、`remote [-v/--verbose]`、`tag -l/--list`、`stash list`、`--version`、`rev-list`、`diff-tree` 和 `check-ignore` 这些只读形式；`tasklist`、`netstat`、裸 `env`、`reg query` 和单路径 `icacls` 查询也可用。
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
- `0.9.100` 起：词首 `#` 按 bash 注释处理，`$(...)` 内不放行注释；未引用的 `$'…'`、`$"…"` 和 `${ cmd; }` 不放行。测试运行器只接受固定开关和字面路径：pytest 接受 `-q -v -x -s -l -k/-m <表达式> --maxfail=N --tb=… --lf --ff --collect-only` 等，`python -m unittest` 的操作数只接受 `discover`、`tests…`、`test_*…` 或 `.py` 路径，`node --test` 接受文件和 `--test-name-pattern=…`，npm/pnpm/yarn 的 `test` 后只接受 `--`、`-s`、`--silent` 和字面操作数，`make` 只接受单独的 `make test` / `make check`；需要其他参数时写进 `allowCommands`，或把这次检查交给 Codex。工具名不区分大小写，`apply_patch`、`multi_edit`、`ops_write`、`ops_edit` 以及 camelCase、连字符形式的 MCP 写入和执行动作同样拒绝；shell 工具不接受 `env`、`stdin` 等会改变执行的参数。超过 32 KB 的命令直接拒绝。`workspaces: ["*"]` 也覆盖没有工作目录的会话。

### 0.9.102：每单 diff、回滚与白名单模式

可写任务的任务目录在 git 工作树内时，结果里的 `diff_status` 为 `captured` 表示本单的改动已记成 patch：用 `codex_output` 的 `artifact="diff"` 分页查看，或在面板的任务报告里切到“改动 diff”。记录只含任务目录子树、遵守 .gitignore，不含被忽略的文件、任务目录之外和 `writable_roots` 里的改动，也不含子模块内部的改动；patch 超过 5 MiB 记 `too_large`，只留统计信息且不可回滚；不是 git 仓库记 `not_git`，超时或 git 出错记 `skipped`，都不影响任务本身。被取消的任务同样有 patch；worker 中断的任务在下次查询时补记，并用 `diff_note` 注明可能含之后的改动。为了不让每单都重新哈希整个目录，runner 在 `runnerHome/diff-index/<目录键>/` 下为每个任务目录缓存一份刷新过的 index 和记录用的对象（上限 256 MiB，超过后整体重建；`forget-too-big` 和 30 天清理会一并清掉）：每个目录的第一单要完整哈希一遍，之后只处理变化的文件。

回滚只能由用户在面板里发起：先“检查能否回滚”，通过后二次确认。它按 patch 反向应用，只撤销这一单在任务目录里的文件改动，不动提交记录和暂存区；相关文件之后又被改过、与 patch 对不上时拒绝并且不改任何文件；同目录有写任务在运行或排队时返回忙，稍后再试；每单只能回滚一次。规划端没有回滚工具。

白名单模式（`toolPolicy: allowlist`）用来堵住“护栏不认识的工具默认放行”这个口子：切换前先看面板里列出的“白名单模式下会被拒绝的工具”，把需要的加进 `allowTools` 再保存。默认的 `denylist` 模式行为不变。

### 0.9.100：面板新增内容

“Codex 指挥”面板新增：“给 Codex 的固定要求”编辑框（保存前备份，保留最近 10 份，上限 1 MiB）；两份提示词的有效字数、历史备份查看与载入，规划提示词是否已注入；运行状态里的护栏工作区、主机访问状态和未识别的配置项，以及点一次查一次的“环境自检”；常用设置里的总超时、空闲超时、重试次数、同时运行任务数上限和重启后自动续接，数字项留空表示恢复默认或不限制；最近任务的会话、目录、耗时、验收条数、失败原因、核验状态和运行阶段，按任务编号或会话编号搜索，报告区切换查看任务书与验收、核验记录、错误日志；配置了 Gemini 时的最近 20 条写作记录；默认折叠的“会话操作”，可提交发送、续接、改 Goal 请求，走上文的本机请求文件，发送和改 Goal 需二次确认，上一份未处理时拒绝新提交。面板的运行状态每 7 秒读取，其余约每 28 秒，页面不可见时暂停；面板自检仍只读原有五个接口，不渲染会话操作。

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

以 `file:///.../index.mjs` 直接加载 profile 管理范围外的源码时，升级应同时更新条目 `id` 的版本后缀（如 `codex-conductor-<commit>`）和模块 URL 的 `?v=<commit>`。DSH 0.2.1-rc.2 的 Loader 对已激活的同 ID 条目只改 `name` 不保证重新导入；版本化 ID 会创建新实例，避免文件已经更新、运行代码仍旧的情况。以 `loaded.json` 的模块 URL、加载时间和进程号确认实际生效。已有 Codex 后台任务继续完成，新实例仍按原生任务表复用，不重复派发；直接改 profile 会立即触发宿主重载，可能中止 DeepSeek 当前回合，应先等所有回合结束。

## 配置

默认提供十一个工具，不启用护栏；Codex 用它自己的模型和登录配置，但默认不加载它配置的 MCP 和 hooks（见上文）。按插件 id 覆盖 `config`：

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
| `runnerAgentsMd` | 留空（沿用） | 未传 `use_user_config` 的任务使用的用户级 AGENTS.md。留空沿用 `CODEX_HOME` 里的文件，`none` 省略它，`bundled` 换成随包附带的 [executor-agents.md](executor-agents.md)，也可填绝对路径。runner 在 WSL 用符号链接替换，`resume` 同样使用替换后的用户级文件并保留原会话。 |
| `maxStorageMb` | 留空（不限制） | `jobs` 与 `runs` 合计大小上限（MiB），须为正有限数字，可含小数；启动时尽力清理最旧的已结束任务，保留活任务和本次任务 |
| `maxSessionJobs` | 留空（不限制） | 每个会话累计可派的 Codex 任务数上限，须为正整数；达到后不启动 Codex 并说明原因 |
| `maxSessionTokens` | 留空（不限制） | 每个会话累计的 Codex 用量上限（token，取 runner 汇总的 `total_tokens`，没有时用输入加输出），须为正整数；用量未知的任务不计入 |
| `jobDiff` | `true` | 可写任务在 git 工作树内时记录本单改动的 `diff.patch`（可在面板查看和回滚）；设为 `false` 关闭 |
| `closeoutGuard` | `true` | 本会话存在有问题却未复核的有效报告，或尚未结案的 `needs_changes` 时，拒绝开新工作的 `codex_run` 和规划端的 `update_goal(action=complete)`。续接、带 `resume` 的返工、核验、查询和界面操作照常。第一次加载 0.9.122 起新记的返工欠账指向最新轮次，后继轮执行完成并复核为 `verified` 或 `accepted_deviations` 才清账。旧欠账仍按有无后继轮判断。规划端完成 Goal 时，报告干净但未复核的写入任务只提醒。首次加载 0.9.103 前开始的任务不计入，记录读取失败时告警并放行。设 `false` 关闭拦截。 |
| `handoverSuggestMessages` | `5000` | 会话消息数超过此值时标记“建议交接”；0 关闭（`autoHandover` 的提醒、询问和自动交接随之关闭）。这也是 `autoHandover` 的触发阈值 |
| `acceptanceWarnAbove` | `8` | 新派活验收标准超过此条数时在回执里提醒（不拦截）；0 关闭 |
| `continueFreshAboveTokens` | `100000` | 不带 answers 的续接，原线程上次请求超过此输入 token 时开新线程；0 总是沿用原线程 |
| `closeoutEvidence` | `independent` | 结案时自标未满足的条目记成满足所需的依据：`independent` 独立依据，`planner` 规划端自己的非照抄证据，`off` 不查 |
| `acceptOpenEvidence` | `strict` | 自标未完成或列为 `must_verify` 的条目以未完成结案时，需有独立核验、后续轮次仍未完成、用户回复，或可确认的待用户处理阻塞。`strict` 对 `not_met` 只接受独立核验和用户回复，`relaxed` 接受以上四类，`off` 关闭检查。原报告标 `met` 的条目免查，且首次加载此版前结束的任务沿用旧规则。 |
| `autoVerify` | `flagged` | 对尚未复核的已完成写任务，报告有效且有自标未完成项或 `must_verify` 时自动派一次只读核验。任务须在 `auto-verify-since.json` 的截止点或之后结束，缺少结束时间时按任务号判断。已有核验或后续轮次的任务跳过，同线程内更晚开始的非核验任务也算后续轮次。补扫覆盖截止点前 7 天起开始的任务。插件加载（含热重载）时后台补派最多两单，每个会话调用 `codex_*` 时补派最多一单（含交接前任，每会话 60 秒内最多扫描一次，热重载沿用计时）。读取旧的已渲染结果时也会检查；核验归最新继任会话，派单受 `maxRunningJobs` 限制。`codex_runtime` 的 `auto_verify_catchup` 计加载及会话扫描补派数。`off` 关闭。 |
| `autoHandover` | 见下 | 标记建议交接之后怎么办，对象，各键可单独省略；无效值告警并回落默认值，未知子键写进 `unknownConfig` |
| `autoHandover.mode` | `confirm` | `off` 只标记并保留面板按钮；`notify` 另加面板提醒；`confirm` 会话空闲且没有运行中的 Codex 任务时在面板询问，同意才交接；`auto` 同样条件下直接交接 |
| `autoHandover.cooldownHours` | `12` | 拒绝、点“知道了”或询问没人理之后多少小时内不再询问或自动交接，非负数 |
| `autoHandover.remindStepMessages` | `2000` | 同一会话再次提醒需要再涨的消息数，正整数 |
| `autoHandover.startupDelayMinutes` | `10` | 宿主进程启动后多少分钟内不自动交接（只约束 `auto`），非负数 |
| `autoHandover.disableAutoContinue` | `true` | 交接后通过宿主设置服务把旧会话在 `dsh-client-auto-continue` 里的模式设为 `off`，撤回时恢复；`false` 不做 |
| `autoHandover.withRunningJobs` | `true` | 会话空闲但名下有运行中的 Codex 任务时也交接：任务随交接转给继任，结束通知转投给继任；`false` 时有任务就放弃、稍后重试 |
| `toolPolicy` | `denylist` | 受护栏会话的工具放行方式：`denylist` 只拒绝已知的写入和执行工具；`allowlist` 只放行本插件工具、shell 工具、护栏认识的读取和搜索类工具以及 `allowTools` 和 `mcpWriteAllow`，其他拒绝规则仍然优先 |
| `allowTools` | `[]` | 白名单模式下额外放行的工具名，不区分大小写，`*` 结尾表示前缀匹配；不能放行 `write`、`run_code` 等已被拒绝的工具 |
| `mcpWriteAllow` | `[]` | 仅豁免 MCP 动作名的写入和执行检查，同时计入白名单模式。每项须以 `mcp__` 开头，不区分大小写，`*` 结尾表示前缀匹配。draw.io 示例 `mcpWriteAllow: ['mcp__drawio__*', 'mcp__drawio-skill__*']` |
| `maxRunningJobs` | 留空（不限制） | 同时运行或排队等写锁的 Codex 任务数上限，须为正整数；达到上限时 `codex_run` / `codex_continue` / `codex_verify` 不启动 Codex 并说明原因，等其中一个结束后再派 |
| `routerCheckUrl` | 空 | Codex 使用固定本机模型网关时，可填其 HTTP(S) 地址。runner 在 WSL 内先探测该主机和端口；不可达时报 `router_down`，不会先启动 Codex。仅探测，不修改模型配置。 |
| `codexRoute` | 空 | `{ provider, baseUrl }`，只给插件启动的 Codex 指定已有的自定义提供方与 HTTP(S) 地址，不改 Codex 配置文件。未设置 `routerCheckUrl` 时，启动前向该地址的主机请求 `HEAD /`，确认网关有响应。环回地址只在该 Codex 进程中绕过代理。 |
| `model` | Codex 配置 | 默认模型 |
| `modelAB` | `{ enabled: false, models: ['codex/gpt-6.1-sol', 'codex/gpt-6.2-sol'], share: 0.5 }` | 开启后按新任务号的确定性哈希分配，`share` 是第一个模型的份额，取值 0–1。续接和返工保留已记录的线程模型。单次 `model` 优先，首次显式指定或临时改用其他模型的任务不计入对照。核验用配置的默认模型。无效值告警并回落默认，未知子键记入 `unknownConfig`。 |
| `effort` | Codex 配置 | 写任务的默认推理强度。 |
| `readOnlyEffort` | 同 `effort` | 只读任务（`write=false`）的默认推理强度，留空时用 `effort` |
| `effortOverride` | `planner` | `codex_run` 单次覆盖规则。`planner` 接受传入的 `effort`，`raise-only-listed` 允许等于或低于默认，提高时须带 `effort_reason`（`concurrency_or_locking`、`cross_session_state`、`security_boundary`、`data_migration`、`prior_rework`），`config` 使用配置的默认强度。默认强度为空时维持原解析规则。`context.routing` 下按需记录 `effort_requested`、`effort_reason` 和 `effort_applied`。`codex_continue` 沿用父任务实际强度。 |
| `serviceTier` | Codex 配置 | 例如 `fast`（Codex 的 Fast 模式） |
| `waitSeconds` | `0` | 无法登记后台任务时，`codex_run` / `codex_continue` / `codex_verify` 默认同步等待的秒数；登记后台后立即返回，随后在本轮用 `codex_status(wait_seconds: 3600)` 等待 |
| `autoWakeBlockedInbox` | `true` | 本插件后台完成通知滞留时，自动唤醒随后被门禁拒绝的空闲会话；同批最多两次（1 秒、5 秒），用尽写警告日志；设为 `false` 关闭 |
| `autoResume` | `{enabled:true,maxAgeHours:12,message:"Harness 已重启，接着上次中断的地方继续。",exclude:[]}` | 每进程执行一次启动续接扫描，并按下项配置处理同进程热重载中断 |
| `autoResume.delaySeconds` | `0` | 大于 0 时宿主启动这么多秒后才续接，只补到那时仍没有新回合的会话（兜底，让 `dsh-client-auto-continue` 先续）；0 为立即续接 |
| `autoResume.reloadDelaySeconds` | `20` | 同一宿主进程内热重载后，等待这么多秒才复核被打断的回合。`0` 关闭热重载续接 |
| `timeoutSeconds` | 留空（runner 为 `3600`） | 每次 Codex 尝试的总超时秒数，须为正有限数字，可含小数；不含等待写锁的时间 |
| `lockTimeoutSeconds` | 留空（无限等待） | 等待目录写锁的超时秒数，须为正有限数字，可含小数；超时不启动 Codex，返回可重试的 `lock_timeout` |
| `idleTimeoutSeconds` | 留空（runner 为 `600`） | 空闲超时秒数，须为正有限数字，可含小数；命令执行期间暂停，命令完成后恢复 |
| `retries` | 留空（runner 为 `2`） | 最多自动重试次数，须为非负整数；`0` 表示不自动重试 |
| `allowHostAccess` | `false` | 为 `true` 时 `codex_run` 才提供 `host_access` 参数，允许 Codex 不带沙箱（`danger-full-access`）运行、启动 Windows 程序（见上文） |
| `defaultHostAccess` | `false` | 与 `allowHostAccess=true` 一起使用，省略 `host_access` 的新任务和 `resume` 默认以 `danger-full-access` 运行；显式传 `host_access=false` 可为单次任务恢复沙箱 |
| `plannerAnswers` | `false` | 为 `true` 时允许规划端按用户原始目标和已有事实回答阻塞问题、自行登记 `accepted_deviations`（含 `kind: 'scope'`），不再做待答范围冲突的写入范围预检；最新任务仍为 `ask_user` 时须用 `codex_continue`，答案仍须覆盖全部问题 id。在给用户的汇报里说明代做的决定；拿不准、涉及删除数据或改动用户没提过的目录时仍先问用户 |
| `autoAnswer.enabled` | `true` | 在宿主提问超时后代答 |
| `autoAnswer.afterMinutes` | `10` | 从提出时间起等待的分钟数，最少 1 分钟 |
| `autoAnswer.freeText` | `用户暂时不在。请按你认为最合适、最稳妥的方案继续，并在回复里说明你替用户做了哪些决定。` | 自由文本题的固定答复 |
| `autoAnswer.riskyPattern` | 见“自动代答宿主提问” | 匹配题目和选项，设为 `''` 关闭正则跳过 |
| `autoAnswer.subagents` | `true` | 也处理宿主允许提问的子代理来源会话。0.2.2-rc.3 会拒绝 `origin: subagent` 的提问和续答 |
| `autoAnswer.excludeSessions` | `[]` | 由用户亲自回答的会话 ID |
| `plannerPromptFile` | `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` | 规划要求文件（Markdown，HTML 注释不算内容），注入 agent 的系统提示词（见上文） |
| `executorPromptFile` | 规划要求文件同目录的 `executor-prompt.md` | 给 Codex 的固定要求（Markdown，HTML 注释不算内容）：附在每一单任务书的执行约束后面，Codex 每单都会看到；不增加权限，与任务、验收或执行约束冲突时以后者为准。保存后下一单生效，也可在设置的“Codex 指挥”面板里编辑 |
| `runtimeProfileFile` | 空 | 当前 Harness 实例实际使用的 `cordis.patch.yml` 完整 Windows 路径；用于版本匹配与明确请求的热重载，留空时不能自动重载 |
| `allowCommands` | `[]` | 额外放行的命令，JavaScript 正则逐段匹配（按 `\|`、`&&`、`;` 切开后的每一段），建议写成锚定正则；非法正则会警告并跳过，护栏和其余条目照常生效 |
| `ignoreChanges` | `[]` | 改动清单里忽略的文件，Python `re` 正则匹配相对任务目录的路径（`/` 分隔），用于其他进程定期写的日志等；runner 在截取改动清单之前过滤，匹配的文件不计入改动数和超出 `scope` 的检查，交接提示里会告诉 Codex 它们可能被其他进程改动。无效模式由 runner 跳过，并在任务结果的 `ignore_warnings` 和展示文字中警告 |
| `denyTools` | `[]` | 额外拒绝的工具名 |
| `python` | `python3` | WSL 内运行 runner 的解释器 |

插件加载时检查配置项类型；类型不对时记录带键名的警告，只将该项恢复默认值，其余设置继续生效。超时/重试与存储上限项的 `null`、空字符串或省略均表示留空，不向 runner 传参；它们只通过插件配置设置，不增加单次工具调用参数。

建议在项目的 `AGENTS.md` 里写明分工，例如：先写好每个任务的验收标准；用 `codex_run` 派活并尽量给出 `scope`；不把 Codex 的答复当作完成证据，用只读检查逐条核验；未通过先用 `codex_review` 记录证据，再用 `codex_continue` 沿用原权限修正。

### Gemini 教程与文档写作（默认关闭）

源码改动、源码调查和素材笔记用 `codex_run`；教程、文档正文用 `gemini_write`，一章一章做。需要本机已安装并登录的官方 Antigravity CLI（`agy.exe`）；写作要求与素材内容会发送给 Google。不配置 `gemini` 就不注册工具。`command` 必须是绝对 Windows 路径，缺失或无效时警告并关闭；DSH 桌面版可能重定向 `LOCALAPPDATA`，不能用它猜测 agy 的安装位置。

```yaml
- id: codex-conductor
  config:
    gemini:
      command: 'C:\Users\apple\AppData\Local\agy\bin\agy.exe'
      proxy: 'http://127.0.0.1:7890'
      model: gemini-4-argon
      effort: medium
      timeoutSeconds: 1800
      idleTimeoutSeconds: 600
```

`model / effort / timeoutSeconds / idleTimeoutSeconds` 的默认值如上，两个超时均须为正有限秒数，`effort` 支持 `low / medium / high`；`proxy` 可省略。agy 是 Go 程序，只读取代理环境变量：配置 `proxy` 后，插件仅为子进程覆盖大小写的 `HTTPS_PROXY / HTTP_PROXY / ALL_PROXY`，其余环境继承 DSH。没有配置代理时，子进程沿用现有环境变量。在本机无法直连 Google、DSH 又没有代理变量时，须显式配置代理。

启动与思考阶段只受 `timeoutSeconds` 总上限约束；收到非空 `agent_response.text_delta` 或 `tool/write_file` 步骤后才启用 `idleTimeoutSeconds`，之后任意 stdout 字节（含不完整 JSON）均续时，stderr 不续时。首稿与压缩共用总预算（默认 1800 秒），CLI 的 `--print-timeout` 同步总上限；超时或取消后等待子进程关闭，再保稿、回滚。回执累计记录 `stdout_bytes / event_count / event_types`，步骤类型以 `step_update:<step_type>` 计数，`last_event_type` 为最后已解析事件的同类标签，不保存事件正文；`last_progress_s` 是最后一次尝试关闭时距最后 stdout 的秒数（无输出则从启动计），`timeout_kind` 为 `idle / total / null`。本机 agy 帮助与内置发布说明确认顶层事件为 `init / step_update / result`；程序的 `DeriveStepType` 区分 `user_input / agent_response / tool / finish / subagent / system_message / checkpoint / error_message / unknown`，`PollPrintmode` 在生成文本增量前调用 `StripThoughts`，因此不能依赖思考心跳。历史 1545 字节、2 个事件的失败回执没有类型记录，无法反推那两个事件的性质。

调用示例：`gemini_write({"prompt":"根据素材写第一章入门说明，事实不得超出素材。","sources":["notes.md"],"output":"chapter-01.md","cwd":"D:/work/course","max_chars":2500})`。`prompt` 至少 10 个字符；`sources` 为 1–20 个已有文件，总大小最多 1 MiB。素材与输出可用绝对路径或相对任务目录的路径，`cwd` 选择规则同 `codex_run`，Windows 下也接受 `/mnt/<盘符>/...`。输出必须在任务目录内、不能与素材相同；已有目标须传 `overwrite=true`。单次可覆盖 `model / effort`。

可选 `frontmatter` 只接受 `created / updated / title / type / status / tags / aliases`，其中非空 `title` 和至少一个非空 `tags` 必填，`type / status / aliases` 缺省为 `resource / draft / []`，两个时间缺省为当前本地 `YYYY-MM-DDTHH:MM`；字符串或数组元素最多 200 个 Unicode 码点且禁止换行、控制字符，仅 `tags / aliases` 可为字符串数组，枚举值见工具参数说明。

同目录有可写 Codex 任务在运行、启动或排队时拒绝，任务查询失败也拒绝；同一插件实例中 Gemini 写作未结束时也拒绝新可写 Codex 派单。调用使用 `accept-edits`，在提示词前后固定要求只写目标、不读写其他文件、不执行命令、只用内联事实、完成后只回复“已写入”。插件读回文件确认非空，`chars` 按 Unicode 码点计数（含标题、Markdown 标记、标点、空白及换行），`cjk_chars` 统计汉字，`over_limit` 按 `max_chars` 核对，不采信模型自报；传 `frontmatter` 时去掉模型自带块，再由插件生成，元数据不计入字数，不传则仍计整个文件。首次超限自动按原稿压缩一次，两次调用共用 `timeoutSeconds`，`attempts / attempt_chars` 返回调用次数和每次字数（启动前校验失败为 0 次，未能读回的字数为 `null`）；仍超限、范围外改动、超时、取消或 CLI/文件错误返回 `status="failed"`，恢复目标原字节，原先不存在则删除目标。`next` 提示派 Codex 核对本次正文（`write=true、scope` 只含该正文）、两次超限后拆章或处理范围外改动，`usage` 透传最后一次 CLI 用量。

`files_changed` 来自目标所在目录及子目录的文件名、大小、mtime 快照，最多检查 1,000 个目录项，不跟随符号链接；达到上限会设置 `snapshot.truncated=true` 并注明未覆盖部分。`write_paths` 保存两次调用 stdout 的 `write_file` 路径旁证；除目标外的快照改动与写入事件列入 `out_of_scope`，需核实是否来自同时段其他进程。清单保留恢复目标前的观察结果。`accept-edits` 不是单文件沙箱；目录之外、快照未覆盖且没有写入事件的操作无法由这份清单证明，范围外改动不会自动回滚。

失败回执若含 `draft_path`，可在下一次 `gemini_write` 传入 `reuse_draft: "<draft_path>"`，并照常提供 `prompt / sources / output / cwd`。只接受插件 `%LOCALAPPDATA%/dsh-codex-conductor/gemini-drafts` 真实目录内的 `.md` 文件，不能与 output/sources 相同；跳过 agy，但仍检查非空、Unicode 字数、frontmatter、改动范围和写任务互斥，失败照常保稿/回滚。复用超 `max_chars` 直接拒绝，不压缩、不放宽上限；回执 `reused_draft=true、attempts=0、usage=null`。这些检查不能证明历史调用没有越界，也不能代替事实核对。

在护栏工作区内，成功生成和成功复用的正文按会话登记；重载时从本会话日志中的 `gemini_write` 成功回执恢复，不另建持久化文件。正文限制优先于产物和 `plannerReadAllow`，在 `open / products` 下均拦截规划端的 Obsidian、普通读取及已识别内容搜索，目录搜索包含正文也拒绝；目录枚举仍可用。Codex 执行端仍可正常读取正文，规划端通过其核对报告验收。

成功与拒读提示统一为：“该正文由 gemini_write 写出，规划端不读取。下一步派一单 codex_run（write=true，scope 只含该正文文件），在同一单里核对事实与可读性、就地修正写法问题和句子级错误，报告问题位置和改动；不要另派只读核对或清理单，也不要换工具、搜索或命令绕读。”任务须对照本次 `output` 与本次 `sources` 及原验收要求。对旧素材任务重跑 `codex_verify` 不能替代本次正文核对；已有核对结果且正文未变、没有新证据时，不再为了核验核对报告另派任务。`gemini_write` 是前台调用，不对它使用 `codex_status`；核对用的 Codex 任务遵循上述本轮长等规则。

向用户用大白话说明完成内容、核对结果和剩余问题；执行结束尚未验收时说“已经做完，正在核对”。无需附任务号、线程号或内部状态名，用户要求排查时再提供。

## 单独使用 runner

```text
python3 runner/codex_runner.py run    --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] [--writable-root DIR ...] [--ignore REGEX ...] < prompt.txt
python3 runner/codex_runner.py start  --cwd DIR [--sandbox workspace-write|danger-full-access] [--scope PATH ...] [--writable-root DIR ...] [--ignore REGEX ...] < prompt.txt
python3 runner/codex_runner.py status JOB_ID [--wait SECONDS]
python3 runner/codex_runner.py cancel JOB_ID
python3 runner/codex_runner.py list [--cwd DIR] [--owner SESSION_ID] [--status STATUS] [--needs-attention] [--scope-conflicts] [--limit 20] [--offset 0]
python3 runner/codex_runner.py output JOB_ID [--artifact report|result|context|review|stderr|events] [--offset 0] [--limit 4000]
python3 runner/codex_runner.py review JOB_ID --reviewer SESSION_ID < review.json
python3 runner/codex_runner.py summary [--cwd DIR] [--owner SESSION_ID] [--thread-id THREAD_ID] [--round-limit 20]
python3 runner/codex_runner.py forget-too-big --cwd DIR
python3 runner/codex_runner.py doctor
python3 runner/codex_runner.py rollback JOB_ID [--check]
```

`run` / `start` 可选 `--context-json`，此时 stdin 为 `{"prompt":"完整交接提示","context":{"owner":"会话 ID","task":"原任务","acceptance":["原验收"],"write":true}}`；不传时沿用纯文本提示。`list` 默认最近 20 条、每页最多 100 条；`--status` 按执行状态筛选。`output` 偏移和长度按 Unicode 字符计算，不切断中文或 emoji，可重复读取。CLI 同样保留主机访问权限选项，新增查询不会启动 Codex。

目录瘦身后可用 `forget-too-big --cwd DIR` 提前移除“目录太大”的记录，返回 `{"status":"completed","removed":true}`；没有记录时 `removed=false`。它复用快照缓存的目录键规范化，不启动 Codex，也不拍快照；下一次可写任务重新尝试整树快照。此命令仅由 CLI 提供。有效记录命中时仍只拍 scope 或使用事件，7 天过期前不主动重试整树。

每条命令只在 stdout 输出一个 JSON 对象，原始事件写入日志目录。`--scope` 可重复，写相对 `--cwd` 的路径或绝对路径，只在目录太大、无法整树快照时用来缩小快照范围；插件把 `codex_run` 的 `scope` 逐条传入。结果中的 `cwd` 和传入 scope 时的 `scope_paths` 是规范化的真实绝对路径，快照、事件和范围检查共用这个基准，避免目录别名造成重复改动或误报越界。`--writable-root` 也可重复，只在 `workspace-write` 下增加本次调用的可写目录（目录须已存在），不改变只读模式。`--ignore` 也可重复：路径（相对 `--cwd`）匹配这些 Python `re` 正则的改动在截取前 300 条之前就从 `files_changed` 里去掉；插件把 `ignoreChanges` 逐条传入。

## 注意

- 护栏是工作流约束，不是安全沙箱：它按工具名和命令文本判断，`pytest`、`npm test`、`tests/*.ps1` 等会执行项目代码。
- `host_access=true` 的任务没有沙箱，Codex 能动整台机器；不越界和只读都只靠提示约束，只在信任的本机环境里开启 `allowHostAccess`。
- 防虚报检查基于文字匹配，可能漏判或误判，每个回合最多提醒一次。
- 插件加载时会写 `%LOCALAPPDATA%\dsh-codex-conductor\loaded.json`（加载时间、进程号、实际加载的模块地址、护栏工作区），用于确认插件已生效；已有有效记录属于其他存活进程时保留，属于本进程、PID 已退出或记录损坏时更新，`codex_runtime` 的 `instance` 仍来自当前进程内存。

## 测试

```text
node --test test.mjs workflow.test.mjs runtime.test.mjs panel.test.mjs client-panel.test.mjs resume.test.mjs planner.test.mjs verify.test.mjs guard.test.mjs gemini.test.mjs safeguards.test.mjs
python3 runner/test_codex_runner.py
```

两组测试都不需要 DSH 或真实的 Codex：runner 的测试使用模拟的 Codex，不消耗模型额度，在 Windows 上用 `python` 运行时，Linux 专用用例会按条件跳过；JS 测试中的 Bash/WSL、`pwsh` 命令探针在对应工具不可用时跳过。

[`.github/workflows/test.yml`](.github/workflows/test.yml) 在 push 和 pull request 时，于 `ubuntu-latest` 与 `windows-latest` 上（Node 22、Python 3.12）运行这两组测试。

`codex_run` 可选 `must_verify: [1, 3]`，编号从 1 起，通常选最关键的 1–3 项。用 `codex_continue` 返工时会保留这些编号。`codex_verify` 先逐条实测或回查原始运行记录，再抽查其余结论。结案将这些项记为 `met` 时，要有对应的独立核验结果。

在 WSL 运行 `python3 tools/model_ab_stats.py --since 20261118 --json` 查看模型对照。可用 `--jobs-dir` 指定 runner 任务目录，默认 `~/.local/state/codex-runner/jobs`。只汇总带 A/B 标记的任务。完成率和复核占比按任务数，自报状态占比按验收条数，最终结局按线程及其续接链。返工轮数按每组首单之后的轮次计，耗时中位数按已记录的耗时计。

## English

`codex_run` accepts optional 1-based `must_verify` indices such as `[1, 3]`. Use it for the one to three most important criteria. `codex_continue` keeps the indices. `codex_verify` checks each marked criterion against actual observations or original run records before sampling other claims. Closing a marked criterion as `met` requires a matching independent verification result.

Run `python3 tools/model_ab_stats.py --since 20261118 --json` in WSL for the model comparison. Override the default `~/.local/state/codex-runner/jobs` with `--jobs-dir`. Only A/B-marked jobs count. Completion and review shares use job totals, self-reported shares use criterion totals, and final outcomes use threads and their continuation chains. Rework counts rounds after the first job in each group. Median duration uses recorded durations.

Per-version release notes are in [CHANGELOG.md](CHANGELOG.md#english).

### 0.9.66: Products-only planner reads and independent verification

`plannerReads: open` is the default; successful Gemini prose remains blocked in guarded workspaces. Set it to `products` to restrict guarded sessions to files produced by their own finished Codex tasks, task reports, the planner prompt, and explicitly allowed files or directories. Directory discovery remains available; delegate source investigation to `codex_run`. The common-settings switch follows the existing save / pending / apply-now flow. Status shows the effective mode and the number of allowlist entries without exposing an allowlist editor.

```yaml
- id: codex-conductor
  config:
    workspaces: ['E:\project']
    plannerReads: products
    plannerReadAllow:
      - 'E:\project\RULES.md'
      - '/mnt/e/project/review-inputs'
```

The current plugin instance caches up to 10,000 product paths per session for at most 100 sessions, updating them when task results arrive. Successful Gemini prose is separately registered as planner-unreadable and restored from existing successful session receipts before product/allowlist checks. If product registration is still being restored, first wait up to 3 seconds for recovery. Only a recovery that remains `pending`, including a wait timeout while recovery is unfinished, means “temporarily unable to confirm read authorization”; it neither proves the file is raw input nor grants access. After successful recovery, reads that match neither a product nor the allowlist are refused as raw-input reads. If recovery has finished with a failure, the response is “Product registration recovery failed; this path is not authorized for reading,” without asserting that the path is raw input. A miss triggers at most one background runner query per session every 25 seconds; retry after refresh confirms access. Directory allowlist entries include descendants; a product file does not grant its parent directory. Product grants use recorded runner `files_changed` / `write_paths`; Gemini prose denial always takes precedence. Paths merely read by a read-only task or self-reported in a report do not expand access. Report and history reads are also limited to the current session. The session work-record directory comes from the existing DSH sessionPersistence.locate(header) API; only that session log’s directory is allowed. Hosts without this API do not receive a guessed directory grant. Content readers, content searches and input redirections check their targets; uncertain shell targets using variables, globs or command substitution are refused. Obsidian `obsidian_read`, `obsidian_search` and frontmatter queries follow the same session-product and path allowlist rules; directory and file listings remain allowed. Commands that execute project tests are delegated to Codex too.

Products-only denials briefly explain the reason: delegate investigation to `codex_run` and product-content checks to a Codex verification task. After a guard denial, do not retry through another language, command or tool entry.

Use `codex_verify` for factual checks after mechanically checking product presence, citations and matching numbers: `{"job_id":"original-job-id","focus":"Check figures and citations","samples":8,"wait_seconds":0}`. Sampling defaults to 8 and accepts 1–30; waiting follows `codex_run`. Only finished jobs owned by the current session qualify. Verification starts a fresh read-only thread with the original directory and host access. It uses the original model unless modelAB is enabled, in which case it uses the configured default. It reads the original task, acceptance criteria, products and cited sources, and reports each checked claim, source, truth status and correction through the existing report schema. `context.verification_of` links the jobs in `codex_jobs` and `codex_status`. Record final acceptance of the original job with `codex_review`. Once review is done for the same product version, do not add verification unless the product changes or new evidence appears; `codex_review` records acceptance without starting another investigation. Gemini prose requires the output check described below; verifying an old source-material job with `codex_verify` is no substitute. As with existing `write=false` tasks, host-access mode enforces read-only work through the task instructions rather than an OS sandbox.

A DeepSeek Harness plugin: the DSH agent plans and verifies; Codex CLI in WSL codes. All [eleven Codex tools](#功能) are always registered; `workspaces` only controls the guard. See the [configuration table](#配置) for defaults and parameters.

### 0.9.56: Codex control panel

Open **Codex 指挥** in DSH Settings to view the loaded/source version, execution settings and task counts, edit common settings, filter the latest 20 tasks, read reports, confirm cancellation, edit the planner prompt, and request an idle reload. Gemini controls appear only when Gemini is already configured. Runtime status and settings appear first; task history and attention counts load separately.

Idle means no active Codex tasks and no session with `status === 'running'`, including turns waiting for a model response; unavailable session status refuses an idle reload. Saving settings while idle applies them immediately; otherwise pending settings are saved and applied once idle. Pending settings are stored locally in `pending-settings.json`, beside `loaded.json` (normally in `%LOCALAPPDATA%\dsh-codex-conductor`), and restored after a restart. They are tied to the current environment's configured `runtimeProfileFile` so they cannot be applied to another instance by mistake. Saving again replaces the pending settings; you can also cancel settings that have not yet been applied. The idle check runs every 5 seconds, and the panel refreshes task counts, running session counts and remaining seconds every 7 seconds. After 10 minutes, automatic reload stops without forcing application, retaining pending settings and the reason; save again, cancel pending settings, or explicitly confirm immediate application. Applying settings backs up and atomically updates this plugin's profile fields, preserving comments and unrelated configuration; only the actual load marker confirms success. Prompt saves also create a backup.

To apply settings now, choose **立即生效** and confirm the hot reload. Codex background tasks continue with their launch settings and reconnect; new settings apply to later dispatches. However, the host's plugin reload may abort an ongoing DeepSeek turn, including a turn waiting for a model response without calling this plugin's tools. Choose idle application to preserve current turns. By default, automatic recovery waits 20 seconds after a same-process reload before rechecking and resuming turns interrupted by it. After loading, the plugin reuses tasks still in the native task table and reconnects registered, unsettled tasks in open sessions when their ownership can be confirmed, without dispatching them again. Closed sessions are checked when restored. Tasks without registration records, with unknown ownership, or with unverifiable status are not automatically reconnected. Explicit cancellation and session archival can still cancel Codex. Aborting synchronous dispatch without background registration also cancels it; aborting pure observation through `codex_status`, `job_output` or similar tools only stops observation.

Reports offer a readable view and the original text for both v2 and legacy formats. The readable view reads the entire report before parsing, up to 256 Ki characters (262,144 characters). Larger reports or reports that cannot be parsed remain available as paginated original text; truncated text is not treated as a complete report. The panel's last-24-hours attention count uses task start time. The attention list still includes older tasks, so its total can differ from that count.

Every `/dsh-codex-conductor/*` endpoint explicitly uses DSH's own login and Host/Origin checks on its existing web server; no extra port is opened, and missing authentication fails closed. Missing optional web/settings/slot services leave the existing tools available. File-URL loading supports the client declaration: deploy the complete package, including `package.json`, `client.js`, and `panel.mjs`, keep `file:///…/index.mjs?v=…`, and change the entry ID and `v` token for a hot load without restarting DSH. Set `runtimeProfileFile` to that instance's real `cordis.patch.yml`; deployment is a separate user action.

### 0.9.61: Read-only desktop panel self-test

Write `{}` or `{"id":"desktop-check-1"}` to `%LOCALAPPDATA%\dsh-codex-conductor\panel-selftest-request.json`. The optional ID accepts up to 128 Unicode characters and is generated if omitted. Prefer publishing a temporary file by renaming it in the same directory. After registering the settings entry, the client checks once and then every 60 seconds. Without a request it does not mount the panel, read business endpoints, or write self-test files.

The first client passing DSH's login and origin checks atomically claims the request. It mounts the real panel with the page's React and DSH primitives in an invisible, unfocusable offscreen node, reads status, settings, recent tasks, the prompt and attention count, and opens the first task's readable report if present. Rendering times out after 30 seconds; completion or timeout unmounts and removes the node. It never saves settings, reloads the plugin, cancels tasks, or writes prompts. Its only POST submits the self-test result.

The atomically replaced `panel-selftest-result.json` in the same directory contains server fields `id`, `version`, `pid`, `receivedAt`; client fields `settingsRegistered`, the four heading flags in `sections`, displayed `status` values (`version/model/effort/serviceTier`), current-page `taskCount`, `report` (`opened/summary/criteria/firstCriterion`, the first 80 Unicode characters), `http` paths/status codes (`null` when no HTTP response arrived), `errors`, `timedOut`, `userAgent`, and `origin`. Look for `Electron/` in `userAgent` to confirm the desktop window claimed it; a Web client can claim first. Report flags remain false when there are no tasks.

`GET /dsh-codex-conductor/selftest/request` returns `{"request":null}` or `{"request":{"id":"…","claim":"…"}}`. `POST /dsh-codex-conductor/selftest/result` accepts `{"id":"…","claim":"…","result":{…}}`, strictly validates fields, limits the body to 64 KiB, and accepts a claim only once. The request file allows only `id` and is limited to 4 KiB. Only the latest result is retained. Invalid or unfinished requests remain as `panel-selftest-request.<claim>.processing.json` and are never replayed automatically. A missing result or a result containing errors is not proof of a successful desktop check.

Deployment: `@deepseek-ai/dsh-client-hmr` pushes graph/rebuild events to open windows through `/plugins/events`. Healthy entries clear their cached code and execute again when their client revision changes. That revision comes from `client.js` mtime, ctime and size, not the profile token. Changing only that token does not guarantee a client reload; if the revision stays unchanged and the entry is not removed/recreated, refresh the window or restart DSH. Deploying an updated `client.js` and receiving its changed revision permits in-page replacement without a whole-window refresh.

### 0.9.79: Submit a new message to an idle session from a local file

To give a normally completed session a new task, write the following JSON to `%LOCALAPPDATA%\dsh-codex-conductor\send-request.json`, alongside `loaded.json`. Write a temporary file first, then rename it in the same directory to avoid a partial request:

```json
{"sessionId":"session-example","message":"Please work on this new task"}
```

Both fields are required. `sessionId` accepts one session ID matching `[A-Za-z0-9_-]{1,100}`. `message` must be a non-empty, non-whitespace string of at most 4000 Unicode characters; its original whitespace is preserved. Requests containing a `sessions` field are rejected. This entry calls `agent.followup` **as the user** (`role: 'user'`, `source: {kind: 'user'}`), so only the local operator should use it. Do not expose it to models, remote callers, or untrusted file writers.

Checks run on load, hot reload and directory notifications, sharing the resume entry's atomic claim and serial processing. After asynchronously reading the session, the plugin rechecks agent identity and running status before submission. Running sessions are skipped. Unlike `resume-request.json`, the send entry accepts normally completed idle sessions and submits a user message directly. The resume entry retains its `interrupted` / `blocked` recovery rules and continues to skip normally completed sessions.

`send-result.json` contains claim time `requestedAt`, completion time `completedAt`, `sessionId`, `status`, `reason`, and `error` on failures. Success is `sent / message_submitted`. Skips are `skipped / running` (busy), `skipped / session_changed` (agent replaced or removed during the read), `skipped / error` (unavailable agent, missing host interface or failed submission), and `skipped / invalid_request` (invalid JSON, fields or length; no submission). `sessionId` is `null` when no valid ID can be obtained. Results and plugin logs omit the message body, including any body quoted by host errors.

After atomically publishing the result, the claimed request is deleted. Only the latest result is retained; check its timestamp and read it before submitting another request. A failed result write preserves the claim, which is never automatically replayed after restart. Each request attempts once; `sent` confirms submission, not completion of the new task. Plugin teardown closes the directory watcher.

### 0.9.115 Automatic answers to Host questions

Unanswered `ask_user_question` calls get a reply after 10 minutes by default. Each item uses the marked recommendation, the first option when no option is marked, or a configured reply for text-only questions. Multi-select items use all marked options when available. The reply identifies the automatic selection. Reloads use the original question time and offer 30 seconds of grace for already overdue questions.

The Codex panel lists pending questions and the ten latest history entries. You can answer a safe question immediately or reserve it for yourself. Questions matching the risk pattern, excluded sessions, configured subagent exclusions, permission approvals, plan reviews, and handover confirmations stay with the user. History lives in `%LOCALAPPDATA%\dsh-codex-conductor\auto-answer-history.jsonl` and keeps 300 entries with short previews. `auto-answer-manual.json` preserves manual choices for questions the Host can restore.

### 0.9.114: Closing a criterion the report marked unmet needs independent support

- When a closing review (`verified` or `accepted_deviations`) records as `met` a criterion that Codex's own report marked `blocked` / `not_met`, `closeoutEvidence` decides what supports it. `independent` (default) needs at least one independent source: a completed verification of the unit, finished after that round, that marks the criterion met (verifications now list each flagged original criterion as its own item); a later round of the unit that reports it met; or a real user reply in the session after the job ended (the same check as the user confirmation for accepted deviations, not relaxed by `plannerAnswers`). The planner's own evidence is no longer enough. `planner` accepts the planner's own, non-copied evidence (the 0.9.103 rule, now for both closing verdicts). `off` does not check.
- Without support the review is rejected, listing per criterion the three ways forward: `codex_verify` the job (or `verify_previous` on the next unit when its writes do not overlap), `codex_continue` it, or record the criterion as `blocked` / `not_met`.
- "Accepted although not met": an `accepted_deviations` entry may keep `blocked` / `not_met` with `accepted` (the reason); the record keeps the status and `codex_summary` lists such criteria in `accepted_open`. It goes through the same user confirmation as accepted deviations (with `plannerAnswers` off, a user reply after the job ended). If an `accepted_deviations` review keeps an entry `not_met` / `blocked` without `accepted`, the plugin takes that as the intent to accept it: it fills `accepted` from the entry's evidence (prefixed "（按 evidence 推定）"), says so in the result (`review_fixes`), and the same user confirmation applies. It never infers `met`.
- Verification in progress: when the session's only unreviewed job is being verified (its first verification is running, or this `codex_run` carries `verify_previous` for it) and nothing else awaits close-out, the close-out guard lets new work through whose writes do not overlap that job's products or scope (the same test as `verify_previous`). Each job gets this once; once its verification has finished, its review is due again and new work is refused until it is recorded. With `verify_previous` as the reason and `maxRunningJobs` set, both jobs must fit. The result carries `closeout_deferred`, and `codex_runtime` counts `deferred_dispatch`.
- Report rows and acceptance items: a report row maps to an acceptance item by identical text, or by position when the report has exactly as many rows as there are items. When the counts differ, a flagged row (`blocked` / `not_met`) that matches no item is addressed by its report row number in `report_rows` (`{row, status, evidence, accepted?}`): a closing review must list every such row, with the same rules as `criteria` (met needs independent support; kept open needs `accepted` under `accepted_deviations`). Verifications count as support only for rows that map to their items this way, and list unmapped flagged rows as their own items ("原报告第 k 行…"). Verification jobs now report exactly one row per item, with the sampled claims inside the evidence of item 3.
- Cut-off: only jobs finished after this version first loaded on the machine (`closeout-evidence-since.json`) are held to `independent`; earlier jobs close under the `planner` rule, so upgrading does not make them harder to close.
- Measurement: `closeout-stats.json` counts closing outcomes per session and overall (`all_met`, `accepted_open`, `rejected_unsupported`), shown by `codex_runtime`. Job contexts gain `routing` (continuation mode, parent thread, parent job, superseded threads, `verify_previous`), and close-out refusals log the named job ids to `closeout-refusals.jsonl`.

Successful closing reviews for jobs finished since first load record accepted open items in `accepted-open.json`. The ledger stores item identifiers, statuses, blocker and support kinds, and timestamps. The latest successful closing review replaces that job's entries. On read, a verification of the same job that finished after an item was recorded clears the item if it marked the matching criterion number or report row `met`. `codex_runtime` and `codex_summary` show items and completions for this session and its handover predecessors. To complete a goal with open items, pass `update_goal(action=complete, acknowledge_open_items=true)`. With `plannerAnswers` off, a real user reply after the latest item is also required.

A later round can clear an older entry when its report and newly appended closing review both mark that criterion `met`. The earlier job must be within ten parent links, share the same handover chain, and have recorded the item before the review. Both acceptance lists must be the same length and contain the same text at that index exactly once. Evidence and ledger checks prefer an exact-text report row and fall back to position when the row counts match. `codex_summary` shows the latest 500 entries archived in `cleared`, and `closeout-stats.json` counts cleared items as `ledger_cleared_by_later_round`. Runtime, summary, goal completion refusals, and write-job completion notices point out open items a later round already reported as met. Each ledger read uses up to ten status lookups for this hint. Record the items as `met` in the later round's closing review or re-review the original job with `codex_review`.

Submit `codex_review J` while J's verification is running and keep unmet items open with `accepted`. A closing review (`accepted_deviations` or `verified`) returns `status: parked` only if a verification of J is running in the session or its handover predecessors, the user-confirmation gate passes, and the sole remaining problems are missing evidence for items kept open. A flagged or `must_verify` item marked `met` without the required evidence is still rejected until the evidence is available. Submit `needs_changes` as usual.

The state directory's `parked-reviews.json` holds one pending review per job. A new parked submission replaces it. Load, session catch-up, and pre-dispatch close-out checks can evaluate finished or pruned verifications. The read-only evaluation checks ownership of the original job and combines current evidence with the open-item support available when the review was parked. A `ready` result includes single-line JSON with `job_id` for the planner to submit unchanged through `codex_review` using the normal review and ledger flow. A newer review yields `superseded`. A `rejected` result includes a review skeleton when evidence is insufficient or a reason when the job is pruned or outside the handover chain. Transient job or evidence lookup failures leave the entry for the next scan. A verdict removes the entry.

If verification has already ended when the review is saved, `codex_review` returns the verdict when available. Otherwise the verification completion notice carries it. While a review is parked, new work with non-overlapping writes remains subject to the close-out guard. `update_goal(complete)` names the job and verification and refuses while a review in the session or its handover predecessors is parked or being evaluated. After evaluation, the normal close-out guard uses the job's existing review status. `codex_runtime` shows the pending count for the session and its predecessors.

### 0.9.112: Fresh threads for codex_run resumes, and verifying the previous job alongside the next one

- `codex_run` with `resume` starts a new thread when the resumed thread's last request exceeded `continueFreshAboveTokens` (default 100000). The planner's task text is kept in full after a brief of the previous round (its task and acceptance list, the per-criterion self-report with evidence, deviations, unresolved items, blockers, changed files, and the latest review verdict and notes). The previous round is the latest job on that thread owned by the session or its hand-over predecessors; the new job links to it through `parent_job_id`, so units of work, `codex_summary` grouping, the close-out guard's follow-up rule, the hand-over self-check and aliases all treat it as that thread's follow-up. `fresh: true` / `false` overrides per call; small or unknown-size threads still resume. The result names the new thread decision, the old thread, the previous job and the new job and says to continue from the new job; a later resume of a superseded thread is redirected to the superseding thread's latest job and says so.
- `codex_continue` with `answers` (answering blocking questions) still resumes by default; `fresh: true` starts a new thread with the answers in the brief. Measured: most of those threads are above the threshold too (10 of 11 after the 2026-11-17 changes, median about 154k tokens), so flipping that default would roughly double the input saved on continuations; the owner decides.
- `verify_previous`: `codex_run` / `codex_continue` can name a finished job to verify alongside the new unit (exactly the verification `codex_verify` starts: owner, `verification_of`, read-only, no write lock), with the result delivered by the completion notice. It is refused when the new unit is writable and its scope (the task directory without a scope) contains or is contained by the verified job's scope or products; paths under `/mnt` compare case-insensitively. If the verification cannot start (for example `maxRunningJobs`), the new unit still runs and the result says to use `codex_verify` later.
- Write-job startup: when a scoped walk takes over 5 s in total, its slowest entry is remembered (the per-entry 5 s and 20 s budget rules are unchanged).

### 0.9.111: Hand over with running jobs, fallback resume after a restart, and retitle auto-generated hand-over titles

- **Hand over with running jobs** (`autoHandover.withRunningJobs`, default `true`): automatic, agreed and panel hand-overs proceed when no turn is running even if Codex jobs are (`turn_running` is still always refused), and the panel question no longer waits for jobs. The brief's close-out section lists each running job with its id, title and elapsed time and tells the successor to wait for and review them with `codex_status`, not to redispatch them; the `jobs` self-check covers them. The host's background-job layer sends a job's completion notice to the job owner (still the predecessor for jobs started before the hand-over) and opens a turn when the owner is idle; the plugin now intercepts Codex job notices before the first step of that turn, forwards them to the last successor in the chain (C for A→B→C; a new turn if it is idle, its next step if busy), and the predecessor's turn ends `blocked` without a model call. After a revert the predecessor has no successor and keeps its notices. `false` keeps the old behaviour (give up while jobs run, retry later).
- Retry after giving up: 2 minutes when a new turn got in the way (`turn_running`), 30 minutes otherwise; failed attempts do not count against the once-a-day limit.
- **Fallback resume after a restart** (`autoResume.delaySeconds`, default `0` = the immediate resume as before): above 0 the scan runs that many seconds after the host process started (hot reloads do not restart the clock; still once per host process) and re-checks each session's actual state: a running turn, a turn started after the host started (`dsh-client-auto-continue`, the goal loop or the user got there first), a hand-over, an archive, a user stop, or a goal that is paused or still driven by the goal loop all skip; only the rest get `autoResume.message`. Forced kills were already recognised: the raw log's last turn has a `turn/start` without a `turn/end`. The host cannot read just a log's tail, so a fallback read waits at most 60 seconds per session and records `read_timeout` otherwise. `autoresume-result.json` carries `trigger: "fallback"` and the skip reason of each session.
- **Wider title repair**: any title starting with `[codex-conductor 交接]` (the host's automatic title from the first hand-over message) counts as no title, and the successor is renamed `[交接←<short predecessor id>] <predecessor title>`; the startup repair uses a separate one-time `titleRepaired` mark, so links already repaired by 0.9.109 get their title fixed once. Titles the user changed, and `[交接←…]` titles, are left alone.

### 0.9.110: Fresh-thread continuations, a notice in handed-over sessions, faster write-job startup

- Fresh continuations: when `codex_continue` carries no `answers` and the parent thread's last request exceeded `continueFreshAboveTokens` (default 100000 input tokens, 0 = always resume), the job starts a new Codex thread with the previous round's brief only (original task, acceptance list, unmet criteria with evidence, deviations and unresolved items, the independent review, blockers, files changed) instead of re-sending the old thread on every request. The runner's read-only `thread-size` reads the size from the thread's rollout; when it is unknown the thread is resumed. `fresh: true` / `false` overrides per call; continuations with `answers` (answering blocking questions) always resume. The new job is still linked by `parent_job_id`, so the close-out guard, the hand-over self-check, `codex_jobs parent_job` and `codex_summary` grouping are unchanged (summary keeps the continuation in its parent's group and sums usage per thread). `codex_run` with `resume` still resumes.
- A handed-over session that receives a user message gets one notice before its first step: when and to which session it was handed over, that Codex tools are disabled there, and that the user should continue in the new session. Refused tool calls name the successor too.
- Write-job startup: in large task directories such as `/mnt/...`, a scope entry whose walk alone takes over 5 s, or that exhausts the 20 s snapshot budget, is remembered as too big (7 days, like the task directory) and skipped by later jobs, which then rely on Codex's file events for it; other scope entries are still snapshotted. `forget-too-big` clears these entries under the task directory.
- A new dispatch with more than `acceptanceWarnAbove` (default 8, 0 = off) items gets a reminder to split future work by shared prerequisites and put preferences in the task text. The reminder never blocks dispatch. Counts accumulate in `acceptance-stats.json` in the state directory and appear in `codex_runtime`.
- New `handover-pending.json` in the state directory (refreshed every 2 s, session ids only): sessions with an auto hand-over pending or an unprocessed hand-over request, so an external watchdog can leave them alone.

### 0.9.109: Successors stay in the predecessor's group, carry a telling title, and auto hand-over works inside goal loops

- **Group**: after creating (or adopting) the successor, the plugin adds it through the host workspace service (`workspaceRegistry`) to the predecessor's workspace, right above the predecessor, and pins it when the predecessor is pinned (the predecessor's pin is untouched). Nothing happens when the predecessor is ungrouped. `steps.workspace` records `attached` (with `workspaceId`) / `none` / `unavailable` / `failed:<reason>`, `steps.pin` the pin; the workspace id and the pin are kept on the link. A revert removes the successor only from that workspace (not if the user moved it elsewhere) and undoes the pin the hand-over added. None of this fails a hand-over.
- **Title**: a created successor is renamed `[交接←<first 8 characters of the predecessor id without session->] <first 40 characters of the predecessor title>`, or just the prefix without a title; a successor of a successor keeps only the latest prefix. The host's rename is used (the same as renaming in the UI, so automatic titles do not overwrite it) and recorded as `steps.title`. Adopted sessions keep their title.
- **Self-check** gains `workspace`: with a grouped predecessor the successor must be in the same workspace; an ungrouped predecessor is `skipped`. A failure means `handed_over_with_issues`, never a rollback.
- **Repair of old links**: once the plugin is loaded and the workspace service is available, every link in `handover.json` is checked once: a successor in no workspace whose predecessor is grouped is added to that workspace above the predecessor, and the workspace id is recorded; a successor still titled `[codex-conductor 交接]` is renamed as above. A successor already in any workspace is left where it is. Each link is handled once (`repaired` mark); failures are only logged; any action writes a `handover-history.jsonl` line (`action: repair`, `origin: startup`).
- **Auto hand-over inside goal loops**: the host goal loop, once a session turns idle, first persists and then queues the next round. In `auto` mode the plugin pauses the session's goal synchronously in that same idle event (only an active goal driven by the loop; goals the user paused or changed are left alone), then checks for running Codex jobs and submits the hand-over; the successor goal is rebuilt from the paused goal's text and remaining rounds. If a job is running, a new turn has started, or the hand-over is refused or rolled back, the paused goal is resumed (which re-arms it, so the loop continues) and no retry happens for 30 minutes. `confirm` mode never touches the goal to ask; once the user agrees in the panel ("同意交接", or "现在交接" on a reminder) the same flow runs at once if the session is idle, otherwise at the next turn boundary. The panel's "交接到新会话" button still submits directly and is refused while a turn runs.
- The brief's recent user instructions now hold up to 12 entries (600 characters each) under a fixed note that they are the user's own requirements and still apply unless the next step or newer instructions conflict.
- The panel shows the successor's workspace name on current links and recent records when known, and the `workspace` self-check.

### 0.9.108: One-click hand-over in the panel, asking at the threshold, or automatic

No more hand-written request files. The "Codex 指挥" settings page has a new "会话交接" (hand-over) section:

- **Suggested sessions**: every session over `handoverSuggestMessages` (id, working directory, message count) with a "交接到新会话" button; it opens an optional one-line "next step" for the new session and submits after a confirmation. It still goes through `handover-request.json` and is refused while the previous request is pending. The button works while a turn or Codex job is running; the plugin refuses and the latest result says why in plain words (for example "2 Codex jobs are running, hand over once they end").
- **Prompts**: driven by `autoHandover.mode`. From `notify` on, a session gets one reminder when it is first flagged and another only after `remindStepMessages` more messages. `confirm` (default) asks instead once the session is idle, has no running Codex job, has not been handed over and is out of its cooldown; agreeing submits a hand-over with origin `confirm`, declining or ignoring it starts a `cooldownHours` cooldown. `auto` submits a hand-over with origin `auto` under the same conditions, at most once per session per 24 hours and never within `startupDelayMinutes` of the host process starting; a successor triggers again only after it has grown by a full threshold since the hand-over. The plugin never asks or hands over while a turn or job runs and never sets `force` itself. There is no notification service to call, and the host question service is built for tool calls, not used here, so reminders and questions appear only in this section (plus one log line) and never take a model turn.
- **Current links**: every link (from → to, time, origin) with a revert button. If the successor has had new turns since the hand-over (the brief's own turn does not count) or is running, a revert is refused by default (`status: rejected`, `reason: successor_active`, "the successor has N new turns; reverting would leave two sessions working in parallel"). The panel then shows the reason and a second button that resubmits with `force`; the result carries `warning: parallel_sessions`. A revert's `sessions` field states what each session now is: the predecessor can dispatch again with its goal resumed; the successor's goal is paused and the jobs it started stay its own.
- **Latest result and recent records**: the last result and the last 10 hand-over, adoption and revert records.

Origin and records: a request may carry `origin` (`panel` / `auto` / `confirm` / `tool` / `file`; `file` when absent) and `requestedAt`; the panel always sends `panel` and the submission time. Both are written to `handover-result.json`, the link in `handover.json` and the brief's header, and `handover-history.jsonl` in the state directory gets one line per hand-over, adoption or revert (time, action, from, to, origin, status, refusal reason; never the brief), keeping the last 200. Links also record the successor's message and turn counts at hand-over time (`toMessages` / `toTurns`) for revert protection and re-triggering. There is no hand-over tool for the model yet; `tool` is a reserved origin.

Auto-continue of the old session: `dsh-client-auto-continue`, when installed, is outside this plugin and could keep pushing the old session. After a successful hand-over the plugin sets that session's key in the plugin's `sessionModes` to `off` through the host settings service (the same `settings.mutate('auto-continue', …)` the plugin's own "session mode" button calls; nothing else in its settings is touched) and keeps the previous value on the link, including "there was no key"; a revert writes it back or removes the key. `steps.autoContinue` records `disabled` (switched off now), `already_off`, `not_installed`, `failed:<reason>`, or `manual_required` when the host settings service is not writable, in which case the brief and the panel ask the operator to switch it off. None of these fail the hand-over. `autoHandover.disableAutoContinue: false` skips the step entirely.

Brief contents, all extracted mechanically from the plugin's records and the old session's in-memory log, never by a model: header; **next step** (the request's `note`, or "unspecified; continue with the goal, close out pending work first"); **goal** (not the full text: rebuilt verbatim in this session, round limit, rounds used, the first 200 characters, `get_goal` is authoritative); **recent user instructions** (up to 12, 600 characters each, with times; only messages with source `user`, excluding goal rounds, plugin and job notices, messages without a source, auto-continue phrases starting with "继续"/"Continue", the restart notice and this plugin's own messages); **last progress** (the last turn's end reason and time, and the first 1500 characters of the visible assistant reply in the last normally completed turn); **close-out** and the **job table** (unchanged); **how to look back** (the old session id, `session_read` usage when the host has that tool, otherwise `codex_summary` / `codex_output`); **hand-over notes** (check the state first, close out first, do not redispatch, follow the next step without asking about direction, do not act in the old session). Each section is capped and keeps its most recent entries with "truncated, N in total, showing the latest M"; the whole brief is capped at 16000 characters: the job table first shrinks to unfinished, pending and needs-changes jobs plus the latest 10, then whole sections are dropped in the order notes → look back → jobs → close-out → progress → instructions → goal, listed in the header; the next step is never dropped. Reading the log for more than 10 seconds skips the instructions and progress sections and says so in the header.

Self-check after a hand-over: `checks` records `ok` / `failed:<reason>` / `skipped:<reason>` for `goal` (exists, identical by hash, limit equals the remaining rounds), `settings` (working directory, preset, model route, permission preset, sandbox and approval policy; only the names of differing items), `jobs` (the old session's unfinished, pending and needs-changes jobs resolve through the alias under the new session), `delivered` and `predecessorFrozen` (old goal paused, alias registered, auto-continue off or not applicable). Any failure sets `status: handed_over_with_issues`, shown prominently in the panel, without rolling back. Only an undelivered brief or a successor goal that could not be created triggers one automatic revert without `force` (the brief's own running turn does not count), recorded as `status: rolled_back` with `rollback.reason` `delivery_failed` / `successor_goal_failed`; a refused rollback is recorded in `rollback`, leaves `status: handed_over_with_issues` and is not retried.

Also: the confirmation and the question remind the operator that messages still queued in the old session's input box will not follow to the new session (the plugin cannot see that queue). Neither the host nor `dsh-notify-me` offers a notification service plugins can call, so no system notification is sent; reminders stay in the panel.

### 0.9.106: Hand a long session over to a fresh one

Every step of a session gets slower as its history grows, because the whole history is resent each step. A hand-over moves the goal and the Codex jobs to a new session and keeps the old one read-only. The plugin's state directory is `%LOCALAPPDATA%\dsh-codex-conductor` of the DSH process (for a portable DSH usually `<DSH data>\local\dsh-codex-conductor`, the directory that holds `loaded.json`). Steps:

1. Let the old session stop: no turn in progress and no running Codex job (otherwise the request is refused, see step 5).
2. Write `handover-request.json` in the state directory, preferably by renaming a temporary file: `{"sessionId":"session-old","note":"optional line for the new session"}`.
3. Read `handover-result.json`. With `status` `handed_over`, `to` is the new session id and `briefPath` the brief file. `steps` lists what was done: `session` (created / adopted), `alias` (linked), `predecessorGoal` (paused / unchanged_* / none / failed: …), `delivered` (prompted / prompt_pending / failed) and `successorGoal` (created / exists / none / failed: …). `pending` lists the jobs awaiting close-out. With `refused`, `reason` says why: `turn_running`, `jobs_running` (with `running`), `already_handed_over`, `jobs_unreadable`, `session_not_found` and so on. `rejected` means the request was malformed.
4. Open the new session in the UI; its first message is the brief. To confirm it sees the old jobs, have it call `codex_jobs` (session_id="current") or `codex_summary`; the old session's job ids must be listed. From now on the old session cannot dispatch, review, continue, verify or cancel (it is told the session was handed over) and can only read.
5. To hand over while jobs are still running, add `"force": true`; their completion notices still go to the old session, and the new session reads their results with `codex_status`.
6. If the plugin cannot create the session (for example because the host interface is unavailable), create one in the UI in the same working directory, then write `{"adopt":{"from":"session-old","to":"session-new"}}`; the rest is the same.
7. Roll back with `{"revert":{"from":"session-old","to":"session-new"}}`. The plugin removes the hand-over record, pauses the new session's goal and resumes the old session's paused goal; jobs the new session dispatched after the hand-over stay with the new session.

When to hand over: once a session's message count (user and assistant messages plus tool results) exceeds `handoverSuggestMessages` (default 5000, 0 = off), `codex_runtime` and the panel's "建议交接的会话" row say so; the planner sees one line per turn at most on `codex_run` / `codex_jobs` results and is told to pass it on to the user, never to start a hand-over itself. The plugin also writes each session's count to `history-status.json` in the state directory (session ids, counts, whether a hand-over is suggested, threshold and time only) for an external watchdog. In the brief, job ids are what the tools' job_id parameter takes; thread ids are listed only for jobs that need rework and only for `resume` on `codex_run`. If `codex_status` or `codex_output` receives one of the session's thread ids, it resolves it to the latest job on that thread and says so.

The brief is built mechanically from the plugin's and the runner's records, with no model call: goal, rounds, the jobs started after the close-out cut-off (status, verdict, flagged or not, thread, directory, diff, first task line) and the close-out list. Hand-overs are stored in `handover.json` in the state directory (written atomically; chains A→B→C are allowed, each session has at most one successor, no cycles); only local request files write it, never the model. The close-out guard makes the new session close out the old session's finished jobs too, with the same cut-off rule; `maxSessionJobs` / `maxSessionTokens` still count per session. The new session keeps the old session's working directory and preset and starts on the host's default model; switch it in the UI if needed.

### 0.9.92: Edit a session's goal from a local file

Write `{"sessionId":"session-example","objective":"New objective","maxGoalRounds":20}` to `goal-request.json` in the same directory, preferably by renaming a temporary file. Supply a non-empty `objective` and/or a positive safe-integer `maxGoalRounds`. The plugin loads the session and edits its current unfinished goal (including paused / blocked), using the latest `id` / `revision` with `goals.edit`; phase and activation stay unchanged, and the host persists the edit in session history. It shares send / resume watching, serial processing, atomic claiming and tmp + rename results; successful publication consumes the claim, and claimed requests are never replayed. `goal-result.json` contains timestamps, `sessionId`, `status` and `reason`: `edited`, `no_active_goal` (absent or complete), `session_not_found`, `invalid_request`, or `error`. This entry is for the local operator only.

### 0.9.52: Resume interrupted sessions from a local file

Write the following JSON to `%LOCALAPPDATA%\dsh-codex-conductor\resume-request.json`, alongside `loaded.json`. Write a temporary file first, then rename it in the same directory so the plugin cannot read a partial request:

```json
{"sessions":["session-example"],"message":"Continue"}
```

`message` is optional, defaults to `继续`, and accepts at most 2000 Unicode characters. Supply at most 20 session IDs matching `[A-Za-z0-9_-]{1,100}`; duplicate IDs are handled once. The plugin checks for manual requests on load, hot reload and directory notifications. It atomically claims the file before processing: missing sessions, running sessions, and sessions whose last turn did not end as `interrupted` or `blocked` are skipped. Eligible sessions resume a resumable goal first. Otherwise, `interrupted` retains the user-message path; `blocked` calls the host's existing `wakeDriver()` only when the inbox has pending input, without adding messages, resending rejected advancement prompts, or editing the inbox. An empty inbox still skips with `not_interrupted`. Missing agents, inbox queries or wake methods record an error without stopping the batch. Sessions do not need to be open in a window.

`resume-result.json` contains claim time `requestedAt`, completion time `completedAt`, batch `status` (`processed` / `rejected`), and a `sessions` array with `sessionId`, `status` (`resumed` / `skipped`), `reason`, and `method` (`goal` / `message` / `inbox` / `null`); failures also include `error`. `pending_inbox_woken` means a wake was requested to process queued input; it does not guarantee admission. Each manual request attempts once and does not restore input already claimed by the host. Invalid input rejects the whole batch without submitting messages. If directory watching is unavailable, a warning is logged and the load-time check remains. Only the latest result is retained; check its timestamp and read it before submitting another batch. Claimed requests are not replayed after a restart, preventing duplicate submissions.

`autoResume` defaults to `{"enabled":true,"maxAgeHours":12,"message":"Harness 已重启，接着上次中断的地方继续。","exclude":[]}`. After host readiness, one scan per process first filters main sessions by persistence-file modification time; old sessions never have their events read. Only recent sessions have their raw, unrepaired history inspected. An idle active/disarmed goal resumes through the native driver while budget remains. Without an active goal, a message is submitted only when the original last turn has no `turn/end` or ended with `error`. Paused/blocked goals are never touched automatically, and a stored `interrupted` ending alone does not resume a user-stopped conversation. Completed, running, old or excluded sessions and BTW forks without a `session-` ID prefix are skipped; manual resume behavior is unchanged. `message` accepts at most 2000 Unicode characters; `maxAgeHours` must be positive and `exclude` contains session IDs. Set `enabled:false` to disable. `autoresume-state.json` records PID plus process start identity and resumed IDs before and during the scan, preventing duplicate scans on hot reload. `autoresume-result.json` retains timestamps, batch status and each session's `sessionId`, `basis` (original and loaded turn endings, goal state or skip evidence), `status`, `reason`, and `method`. Success confirms submission rather than completion.

`autoWakeBlockedInbox` defaults to `true`. After observing a completion notice for its own registered Codex background job enter the owner's inbox, conductor waits for a subsequent blocked turn and an idle agent. If the notice is still pending, it reuses the manual inbox wake path after 1 second, then 5 seconds, with at most two automatic attempts per outstanding batch. New notices do not reset that batch's budget. A still-blocked, still-pending batch logs “自动唤醒已用尽” when exhausted. Running agents, removed agents and plugin teardown suppress wakes. No user message, advancement prompt or inbox edit is made. Set the configuration to `false` to disable it; manual resume remains available.

When the root host starts unloading, the plugin records still-running sessions in `autoresume-state.json` as `pending` before agent cancellation. A later process may also resume listed sessions ending `interrupted`, `aborted/disposed`, or `aborted/parent`. Completed sessions, paused/blocked goals, and explicit `aborted/user` stops still skip. Without this marker, the startup scan skips interrupted/teardown endings with `interrupted_without_shutdown_marker`; `basis.cancelCause` retains the nested cancellation cause. This requires shutdown to unload the root host; a direct kill instead uses the original unterminated-turn test.

For a same-process hot reload, `autoresume-state.json` records running sessions and the unload time. After `autoResume.reloadDelaySeconds`, only a turn ending `interrupted` within 60 seconds of unload qualifies. If the previous instance did not record an unload, a confirmed same-process reload checks for interruptions in the last 10 minutes. Sessions with new or running turns, handed-over or archived sessions, user stops, and excluded sessions are skipped. Recovery follows the existing goal rules and uses `autoResume.message`. Results carry `trigger: "reload"`.

Only notices observed during the current plugin lifetime are tracked; historical notices are not replayed. A wake does not guarantee gate admission or restore already-claimed input. `gemini_write` currently returns a foreground result and creates no background job or completion notice, so it does not enter this notification-wake path; successful prose restrictions are restored from existing receipts in the same session.

`codex_status` still reads live state on every call. Repeated unchanged checks for the same owner, tool and job within 120 seconds of the last full receipt return a brief successful running/unchanged receipt directing the planner to stay in the current turn and wait with the same runner `job_id` via `codex_status(wait_seconds: 3600)`. Background completion notices remain available; the receipt does not ask the planner to end the turn. Phases, attempts, errors, actual activity, reports and blocker changes return full details, as do terminal and unknown states. Activity-age and retry-countdown changes alone are ignored. Brief receipts do not extend the full-receipt interval, and positive `wait_seconds` bypasses dampening.

Native `job_output` retains the original ownership and consuming-read behavior before shortening only unchanged running conductor jobs with no new model output. `wait: true` bypasses dampening; brief receipts also direct same-turn long waits, and aborting the read only stops observation. `codex_jobs` / `job_list` listings and `codex_output` pages stay complete. Query signatures live only in the current plugin instance, so the first check after reload is complete. This reduces receipt content; external advancement prompts can still cause model turns.

### Gemini tutorial and documentation writing (off by default)

Use `codex_run` for source changes, investigation and material notes; use `gemini_write` for tutorial/document prose, one chapter at a time. It requires the official Antigravity CLI (`agy.exe`), already installed and signed in locally. Prompts and inline source content are sent to Google. Without `gemini`, the tool is not registered. A missing/invalid `command` warns and disables it; supply an absolute Windows path because desktop DSH can redirect `LOCALAPPDATA`.

```yaml
- id: codex-conductor
  config:
    gemini:
      command: 'C:\Users\apple\AppData\Local\agy\bin\agy.exe'
      proxy: 'http://127.0.0.1:7890'
      model: gemini-4-argon
      effort: medium
      timeoutSeconds: 1800
      idleTimeoutSeconds: 600
```

The model, effort and two timeout values shown are the defaults; both timeouts accept positive finite seconds, and effort accepts `low / medium / high`. Proxy is optional. The Go CLI uses proxy environment variables: configured `proxy` overrides uppercase/lowercase `HTTPS_PROXY / HTTP_PROXY / ALL_PROXY` only for the child, which otherwise inherits DSH's environment. Configure it explicitly when direct Google access fails and DSH has no proxy variables.

Startup and thinking use only the total `timeoutSeconds` deadline; a nonempty `agent_response.text_delta` or `tool/write_file` step enables `idleTimeoutSeconds`, after which any stdout bytes, including incomplete JSON, renew it; stderr does not. Generation and compression share the total deadline (1800 seconds by default), also passed to CLI `--print-timeout`. Timeout/cancellation waits for child close before draft preservation and rollback. Receipts accumulate `stdout_bytes / event_count / event_types`, labeling steps as `step_update:<step_type>`; `last_event_type` uses the same label for the last parsed event, without saving event bodies. `last_progress_s` measures seconds since the last stdout, or launch if silent, at the last attempt's close; `timeout_kind` is `idle / total / null`. Local agy help and embedded release notes confirm `init / step_update / result` events. Its `DeriveStepType` distinguishes `user_input / agent_response / tool / finish / subagent / system_message / checkpoint / error_message / unknown`, and `PollPrintmode` calls `StripThoughts` before producing text deltas, so thinking heartbeats cannot be assumed. The historical failure receipt with 1545 bytes and two events has no event types, leaving their nature unknown.

`gemini_write` requires a `prompt` of at least 10 characters, 1–20 existing `sources` totaling at most 1 MiB, and one `output`. Source/output paths are absolute or relative to the task directory; `cwd` follows `codex_run` selection and accepts Windows or mounted `/mnt/<drive>/...` paths on Windows. Output must stay inside the task directory, differ from all sources, and requires `overwrite=true` when present. Per-call `model`, `effort` and positive `max_chars` are optional. For example: `gemini_write({"prompt":"Write chapter one using only the supplied facts.","sources":["notes.md"],"output":"chapter-01.md","cwd":"D:/work/course","max_chars":2500})`.

Optional `frontmatter` only accepts `created / updated / title / type / status / tags / aliases`: a nonempty `title` and at least one nonempty `tags` entry are required, `type / status / aliases` default to `resource / draft / []`, both timestamps default to local `YYYY-MM-DDTHH:MM`, and each string or array element is limited to 200 Unicode code points without line breaks or control characters; only `tags / aliases` accept string arrays, with enum values documented in the tool schema.

Running/queued Codex writers or a failed task query block execution; pending local starts are also checked, and the same plugin instance blocks new Codex writers while Gemini is active. Fixed instructions surround the prompt: write only the output, read/write no other files, execute no commands, use only inline facts, and reply only “已写入”. The plugin reads the actual nonempty output, counts Unicode code points including headings, Markdown, whitespace and punctuation (`chars`) and Han characters (`cjk_chars`), and checks `max_chars` (`over_limit`); supplying `frontmatter` replaces model metadata with the plugin-generated header and excludes it from counts, otherwise the whole file still counts. The first excess triggers one compression of the previous draft under the same `timeoutSeconds` budget; `attempts / attempt_chars` report calls and their counts (0 calls for preflight validation failures, `null` for unreadable output). CLI errors, missing output/result, timeout, cancellation, excess length after compression or out-of-scope writes return `failed`, restoring the output's original bytes or deleting a newly created output; `next` requests a Codex check of the current prose (`write=true`, `scope` containing only that prose), chapter splitting after two excesses or scope review, and `usage` passes through the final CLI usage.

`files_changed` compares names/sizes/mtimes under the output's parent directory recursively, without following symlinks, capped at 1,000 entries; `snapshot.truncated` discloses incomplete coverage. `write_paths` retains stdout `write_file` paths from both calls as supporting evidence; extra snapshot changes/events appear in `out_of_scope` and may include concurrent writers. These lists retain observations made before output restoration. The tool remains available inside guarded workspaces. `accept-edits` is not a single-file sandbox: unreported operations outside snapshot coverage cannot be established by this list, and out-of-scope changes are not automatically rolled back.

Pass a failed receipt's `draft_path` as `reuse_draft`, together with the normal `prompt / sources / output / cwd`, to skip agy and resubmit a preserved draft. Only real `.md` files inside the plugin's `%LOCALAPPDATA%/dsh-codex-conductor/gemini-drafts` directory qualify; drafts must differ from output and sources. The same nonempty-body, Unicode, frontmatter, scope, writer-exclusion and rollback checks apply. Excess length is rejected directly without compression or a relaxed limit. Receipts include `reused_draft=true`, `attempts=0`, and `usage=null`. Validation cannot establish the historical call's scope or factual correctness.

In guarded workspaces, successful generated and reused prose is registered by session and restored from that session's existing successful `gemini_write` receipts after reload, without a new persistence file. Prose denial precedes product and `plannerReadAllow` grants in both `open / products`: planner Obsidian reads, ordinary reads and recognized content searches are refused, including directory searches containing the prose. Directory discovery and Codex execution-side access remain available; assess the prose through the Codex checking report.

Success and read-denial guidance both delegate one `codex_run` task with `write=true` and `scope` containing only the prose file; the planner does not read it. In that same task, check this invocation's output against its sources and original acceptance criteria for facts and readability, fix wording and sentence-level errors in place, and report locations and changes. Do not dispatch separate read-only checks or cleanup tasks, or bypass the read guard with other tools, searches or commands. Re-running `codex_verify` on an old material job cannot replace checking the new prose. Once that check exists, do not dispatch another task merely to verify its report unless the prose changes or new evidence appears. `gemini_write` is a foreground call, so do not use `codex_status` for Gemini itself; its Codex checking task follows the same-turn waiting rules below.

Explain completed work, check results and remaining gaps in plain language. If execution has finished but acceptance is pending, say “The work is finished; I am checking it.” Job IDs, thread IDs and internal state names are unnecessary unless the user asks for diagnostics.

### Task lifecycle

From `0.9.121`, `codex_run` asks for one independently verifiable outcome per dispatch. If there are more than eight criteria, split the work by shared prerequisites before dispatching. Set `write=true` with authorization for file deliverables or programs that write on startup. List all required write paths in `scope` and use `writable_roots` for extra writable directories in the sandbox. Record real-machine, network and host requirements as prerequisites, and set `host_access` where needed and authorized. Each criterion specifies the outcome, the normal entry point and the expected value. Require evidence obtainable in the current run. Request hashes, checksums, per-file listings, nanosecond timestamps, progress files, or proof of zero writes or outbound transfers throughout only for data integrity, authenticity, backup and recovery, or a security boundary. State the purpose.

If a planned step, tool or path is unavailable, Codex can verify the same outcome by an equivalent method within the original authorization and explain the substitution in `deviations`. Stop a step if its side effects are uncertain or it would exceed authorization or damage data. Report a measured mismatch as `not_met`. Use `blocked` for missing permissions, environment or inputs, or evidence that cannot be collected after the fact. Name the missing prerequisite once and reference the first criterion from others blocked by it. Scripts must exit nonzero if critical observation, cleanup or recovery fails. Report a step as passed only if it ran.

`codex_run` requires acceptance criteria and an explicit `write` (`true` for changes, `false` for read-only investigation). Criteria have no item-count limit; dispatch, continuation, reports and independent review preserve their full list and order. Explicit `cwd` wins; otherwise use the most specific matching `{path, cwd}` workspace entry, then the session workspace. Mentioning a directory only in the task does not change it.

`codex_continue` accepts typed blocker answers or environment-recovery evidence, preserving the original thread, directory, acceptance, write, scope and host access. With the default `plannerAnswers=false`, pending questions require a user reply in the original session after the questions were raised; tool-provided answers alone do not start a job. Existing continuations are reused; further work uses the latest child `job_id`. Without a resumable thread, accumulated user decisions accompany the original context into a new thread, without stacking old reports. Unknown ownership/state and cancellation prevent automatic continuation. By default, both resume paths check for earlier questions on the same thread that still have no user reply, even after a newer job. If the latest job still needs an answer, use `codex_continue` after asking the user. By default, a fresh write task in the same session cannot widen an overlapping scope with a pending conflict until the user replies, even from a different working directory. Paths are resolved against each task's own directory.

The bundled runner handles background execution, retries, timeouts, idle/reconnect detection and thread resumption; disconnecting a wait does not stop it. Unsent prompts survive route retries, and PID/event-log write failures terminate and reap children. Closing stdout while still alive does not bypass the configured timeout, idle or reconnect budget.

Writers lock `cwd`; `workspace-write` also locks explicitly supplied `writable_roots`, so different working directories sharing an extra root serialize. Equal or ancestor/descendant roots serialize after normalization, while disjoint directories can run concurrently; a residual Codex whose PID identity still matches retains its roots after its worker exits until Codex stops. Queued jobs remain `running` with phase `lock_wait`; Codex, route checks and snapshots start after all required locks are obtained. Cancelling a waiter leaves its holder alone. Wait on the original ID. Background jobs sharing a required lock start in submission order; per-attempt `--timeout` excludes lock waiting. Optional `lockTimeoutSeconds` (runner `--lock-timeout SECONDS`) bounds queue time using a monotonic clock; omission waits indefinitely. Expiry fails with `lock_timeout`, `retryable=true`, without Codex or a snapshot and without affecting the holder. Use `codex_jobs` to inspect running jobs in the same directory before deciding to wait or cancel the holder; do not immediately redispatch.

Each `wsl.exe` call is bounded: `start`/`cancel` 120 seconds, `status` its wait plus 60 seconds. One-second ticks avoid false timeouts after host sleep. Hung WSL returns `bridge_error`; query a known `job_id` before redispatching. Monitoring tolerates occasional transient bridge errors.

Plugin settings `timeoutSeconds`, `idleTimeoutSeconds` and `retries` map to runner `--timeout`, `--idle-timeout` and `--retries`. Omitted, empty or null settings pass no flag and retain runner defaults of 3600 seconds per attempt, 600 idle seconds and two retries. Timeouts accept positive finite numbers, including fractions; retries accepts nonnegative integers (`0` disables retries). These are configuration settings only. Invalid setting types warn with the key and default only that entry. See the [configuration table](#配置).

| Setting | Default | Meaning |
| --- | --- | --- |
| `plannerAnswers` | `false` | Allows planner answers and `accepted_deviations` (including `kind: 'scope'`) based on the user's original goal and known facts, and skips pending-conflict write-scope preflight. The latest `ask_user` task still requires `codex_continue`, with answers covering every question ID. Report decisions made for the user; ask first when uncertain or when answers entail data deletion or changes to directories the user did not mention. |
| `autoAnswer.enabled` | `true` | Enable automatic replies to Host questions |
| `autoAnswer.afterMinutes` | `10` | Wait from the original question time, with a minimum of one minute |
| `autoAnswer.freeText` | `用户暂时不在。请按你认为最合适、最稳妥的方案继续，并在回复里说明你替用户做了哪些决定。` | Reply for text-only questions |
| `autoAnswer.riskyPattern` | See the Chinese section above | Case-insensitive pattern for question and option text. Set to `''` to disable pattern matching |
| `autoAnswer.subagents` | `true` | Include subagent-origin sessions that can ask questions in the Host. Host 0.2.2-rc.3 rejects `origin: subagent` |
| `autoAnswer.excludeSessions` | `[]` | Session IDs reserved for human answers |
| `autoResume.reloadDelaySeconds` | `20` | Seconds after a same-process reload before rechecking interrupted turns. `0` disables recovery after hot reload |
| `modelAB` | `{ enabled: false, models: ['codex/gpt-6.1-sol', 'codex/gpt-6.2-sol'], share: 0.5 }` | When enabled, assign new threads deterministically by job ID. `share` gives the first model's fraction from 0 to 1. Continuations keep the recorded thread model. An explicit `codex_run.model` takes precedence. Explicit initial picks and one-off switches to a different model do not enter the comparison. Verification uses the configured default model. Invalid values warn and fall back to defaults, and unknown sub-keys go to `unknownConfig`. |
| `lockTimeoutSeconds` | Empty (unlimited) | Positive finite seconds waiting for directory write locks; expiry returns retryable `lock_timeout` before Codex starts. Null, empty or omitted passes no flag. |
| `maxSessionJobs` | Empty (unlimited) | Positive integer limit on the Codex jobs one session may dispatch in total |
| `maxSessionTokens` | Empty (unlimited) | Positive integer limit on one session's total Codex usage in tokens (`total_tokens`, or input plus output); jobs with unknown usage are not counted |
| `jobDiff` | `true` | Record each writable job's `diff.patch` when the task directory is inside a git work tree (viewable and reversible from the panel); `false` switches it off |
| `closeoutGuard` | `true` | Refuse new-work `codex_run` and planner `update_goal(action=complete)` while the session has valid flagged reports awaiting review or open `needs_changes` work. Continue, resume, verify, queries and UI actions stay available. For `needs_changes` reviews recorded since 0.9.122 was first loaded, show the latest rework round and keep the debt until a completed successor is reviewed as `verified` or `accepted_deviations`. Earlier rework reviews still need any follow-up. Goal completion warns about clean unreviewed write jobs. Jobs started before the first 0.9.103 load are excluded, and unreadable records fail open with a warning. Set `false` to disable blocking. |
| `handoverSuggestMessages` | `5000` | Flag a session for hand-over once it has more messages than this; 0 switches it off, together with `autoHandover`'s reminders, questions and automatic hand-overs. It is also `autoHandover`'s threshold |
| `acceptanceWarnAbove` | `8` | One reminder line on a new-work dispatch with more acceptance items than this (never blocks); 0 = off |
| `continueFreshAboveTokens` | `100000` | A continuation without answers starts a fresh thread when the parent thread's last request exceeded this many input tokens; 0 = always resume |
| `closeoutEvidence` | `independent` | What supports recording a criterion the report marked unmet as met when closing: `independent` sources, `planner` own non-copied evidence, `off` no check |
| `acceptOpenEvidence` | `strict` | Accepting a flagged or `must_verify` item as open takes a mapped verification, a later round that still reports it open, a real user reply, or an actionable user blocker. `strict` accepts only verification or a user reply for `not_met`. `relaxed` accepts all four kinds and `off` disables the check. Items originally reported `met` are exempt. Jobs finished before first load keep the old rules. |
| `autoVerify` | `flagged` | Automatically dispatch one read-only verification for an unreviewed, completed write job with a valid report and flagged or `must_verify` items. The job must have finished at or after the cutoff in `auto-verify-since.json`. Missing finish times use the job-ID fallback. Jobs with an existing verification or a later round are skipped, including when a non-verification job starts later on the same thread. Catch-up scans include jobs started up to seven days before the cutoff. Load and hot reload start up to two in the background. A `codex_*` call starts up to one for its session or handover predecessors, with at most one scan per session every 60 seconds across hot reloads. Collect also checks stored rendered results. The latest handover successor owns the verification, and starts respect `maxRunningJobs`. `codex_runtime` reports starts from load and session scans as `auto_verify_catchup`. `off` disables it. |
| `effortOverride` | `planner` | `codex_run` per-call effort policy. `planner` accepts overrides. `raise-only-listed` accepts equal or lower effort, and requires an `effort_reason` to raise it: `concurrency_or_locking`, `cross_session_state`, `security_boundary`, `data_migration`, or `prior_rework`. `config` uses the configured default. Writes use `effort`, reads use `readOnlyEffort` or `effort`. An empty default keeps the existing resolution. When available, `context.routing` records `effort_requested`, `effort_reason`, and `effort_applied`. `codex_continue` inherits the parent's applied effort. |
| `autoHandover` | see below | What happens once a session is flagged; an object whose keys may be omitted one by one. Invalid values warn and fall back to the default; unknown sub-keys go to `unknownConfig` |
| `autoHandover.mode` | `confirm` | `off` flags only and keeps the panel button; `notify` adds a panel reminder; `confirm` asks in the panel once the session is idle with no running Codex job and hands over on agreement; `auto` hands over directly under the same conditions |
| `autoHandover.cooldownHours` | `12` | Hours without questions or automatic hand-overs after a decline, a dismissed reminder or an unanswered question; non-negative |
| `autoHandover.remindStepMessages` | `2000` | Further messages before the same session is reminded again; positive integer |
| `autoHandover.startupDelayMinutes` | `10` | Minutes after the host process starts during which `auto` does not hand over; non-negative |
| `autoHandover.disableAutoContinue` | `true` | After a hand-over, set the old session's `dsh-client-auto-continue` mode to `off` through the host settings service and restore it on revert; `false` skips this |
| `autoHandover.withRunningJobs` | `true` | Hand over an idle session even while its Codex jobs run: the jobs move to the successor and their completion notices are forwarded to it; `false` gives up while jobs run and retries later |
| `runnerAgentsMd` | Empty (keep) | User-level AGENTS.md for jobs without `use_user_config`. Empty keeps the file in `CODEX_HOME`, `none` omits it, `bundled` uses the shipped [executor-agents.md](executor-agents.md), and an absolute path uses that file. The runner uses WSL symlinks and applies the same replacement on `resume` while keeping the existing session. |
| `toolPolicy` | `denylist` | `denylist` refuses known write and execute tools; `allowlist` lets a guarded session use only this plugin's tools, shell tools, recognised read and search tools and the two configured allowlists, subject to the other guard rules |
| `allowTools` | `[]` | Extra tool names for allowlist mode, case-insensitive, a trailing `*` is a prefix; cannot allow `write`, `run_code` or other refused tools |
| `mcpWriteAllow` | `[]` | Exempts matching MCP tools from the write and execute action-name check and counts them in allowlist mode. Each entry starts with `mcp__`. Matching ignores case and a trailing `*` matches a prefix. For draw.io use `mcpWriteAllow: ['mcp__drawio__*', 'mcp__drawio-skill__*']` |
| `maxRunningJobs` | Empty (unlimited) | Positive integer limit on Codex jobs that are running or queued for a write lock; at the limit a dispatch is refused with the reason instead of starting Codex |
| `maxStorageMb` | Empty (unlimited) | Positive finite combined `jobs`/`runs` limit in MiB, including fractions; startup best-effort cleanup removes the oldest finished records, preserving active and current tasks. Null, empty or omitted passes no flag. |

Execution, reconnect, exit-grace, status-wait and snapshot budgets use monotonic time; event/retry timestamps and displayed durations retain wall time. Unfinished `command_execution` items are tracked by ID: idle timeout pauses until all matching commands complete, while total timeout and reconnect limits remain active. Read-only resume threads survive route-check failures. Writers retain the full retry prompt until the current attempt reports command, file-change or assistant-message work; thread/turn startup and configuration warnings alone do not prove the user's continuation answer was saved. Failure classification reads only stderr added during the current attempt, while the full log retains all attempts.

After Harness reopens, resuming an existing session reattaches its recorded, unsettled Codex jobs. Hot reload also checks open sessions. Recovery checks ownership and attaches completion delivery to the existing run. Eligible write completions observed during recovery follow the same `autoVerify` policy.

Recovery and pending scope checks reuse paginated task records instead of a separate status process for every job; unverifiable scopes still block dispatch. Workers publish their own PID and creation time on startup, so status/cancel work even if the launching parent disconnects before recording them. If a dead worker's Codex identity still matches a present process, status explicitly reports `residual_codex_pid` and `retryable=false`; stop the residual process before redispatching. The status query only marks it and does not kill it.

WSL restarts are recognized by boot ID and distro init start time, including shutdown, termination and auto-stop. Earlier tasks become `worker_died` with phase `interrupted`. Check existing artifacts against the original acceptance criteria before filling gaps; writers retain a started thread for resumption. Status/cancellation also check process creation time to avoid same-boot PID reuse; finished Codex identities are not retained during retry waits. Older records without creation times retain boot/liveness checks. Cancellation ends the task's process tree; an already-ended task returns its result and matching next step instead of requesting redispatch.

With DSH background jobs, Codex dispatch immediately registers one row, reused across plugin reloads. Progress refreshes about every 20 seconds with last-activity age and latest action. Dispatch `codex_run`, `codex_continue` and `codex_verify` with `wait_seconds: 0`; successful registration returns `background_job_id` immediately. Finish independent planning work, then stay in the current turn and call `codex_status({"job_id":"runner-job-id","wait_seconds":3600})` using the returned runner `job_id`. If it is still `running`, wait again on the same job; do not poll with zero waits or redispatch. The 3600-second status wait is separate from execution, queue and retry budgets.

If the wait already returns the report, review it directly. Only a summary, missing content or truncation calls for `job_output`, using the Harness `background_job_id` as its `job_id`. If that entry is unavailable or there is no background ID, use `codex_output(artifact="report")` with the runner `job_id`, following `next_offset` to `eof=true`. On errors or aborted calls, confirm the original job's status before taking further action. Completion notices and idle-session wakes remain available, with exact `codex_output` calls or `codex_status` calls after interrupted monitoring; they do not justify ending the turn after dispatch. Status waits do not redeliver the same completion result.

When the same task brief fails repeatedly, follow the guidance in the receipt before dispatching again. Do not resend the same brief. The receipt gives the attempt count and the recorded number of changed files. Check any changes first. A model refusal (`model_refused`) is terminal and the user decides the next step. After a reconnect timeout, idle timeout, router outage or transient service failure, confirm recovery and check for unfinished work. Use `codex_run` with `resume` and `fresh: false` when a thread is available. Total timeouts and upstream rejections have no automatic retry. For missing or invalid reports, recover any available output with `codex_output(artifact="report")` and check existing artifacts with `codex_verify`.

Finished rows retain output. Aborting pure observation through `codex_status`, `job_output`, `codex_watch` or similar tools only stops observation and leaves Codex and its background job running. Explicit `codex_cancel` and session-archival cancellation remain available. Unconfirmed cancellation keeps its ID and requires a status check; `monitor_failed` means Codex may still run. Without native job registration (no jobs service, failed registration or no agent), `codex_run` / `codex_continue` / `codex_verify` wait synchronously up to `wait_seconds` (default `0`); aborting that dispatch wait still cancels Codex. If dispatch returns a running job, continue the same-turn long wait described above.

`codex_watch` observes native task changes without model polling or idle WSL calls. `attention` reports failures, blockers and report problems; `all` also includes starts/normal completion. It ends after the first matching change; stopping it only stops observation and preserves normal completion notifications.

`codex_runtime` compares source and loaded versions and reports active Codex tasks, running sessions and `idle_wait`. Its `loaded` record includes the effective default access settings, configured service tier (`null` inherits Codex settings), gateway origin and probe transport. Set `runtimeProfileFile` to the actual desktop profile. Reload defaults to `when="idle"`, waiting for both Codex tasks and current turns in all DeepSeek sessions, reconfirming idle before reload and refusing when session status is unavailable. After 10 minutes it stops without forcing a reload; `action="status"` reports `idle_wait.status="timed_out"`, and you can request idle reload again. `when="now"` explicitly reloads immediately: Codex background tasks continue and reconnect, but ongoing DeepSeek turns may be aborted. Only this plugin's entry ID/module URL change; confirmation requires the new loaded marker, without restarting the host. If the 30-second confirmation window expires, check `action="status"`. A repeated reload observes the existing request instead of rewriting it. If Harness reports a loader error, fix it before refreshing the plugin.
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

`codex_review` records independent per-criterion evidence in `reviews.json`, preserving original reports/results. Passing conclusions require every criterion to pass. With the default `plannerAnswers=false`, recording acceptance of reported deviations or out-of-scope changes requires an explicit user reply in the original session after the job ends. Use `verified / needs_changes / accepted_deviations`. Re-read with `codex_output artifact="review"`; record gaps before continuing under original permissions.

The plugin rejects `needs_changes` when all criteria are `met`, no active blockers remain and there are no reported deviations or out-of-scope changes, without changing the verdict automatically; put defects in the audited prose or product in `notes` / conclusions, record the completed audit as `verified`, and mark real execution gaps as `not_met` / `blocked` or add a blocker with evidence.

`codex_summary` groups actual threads, separating unthreaded jobs; default selection is the current session, with `cwd`/`thread_id` filters. It returns 10 groups per page by default; keep the same filters and `limit`, and pass `next_offset` as `offset` to continue. Group and round totals cover all matches. Top-level `error_kinds` and one rendered line count each error kind across all matching jobs, including separate rounds in the same thread, independent of the displayed page; no new filter is added. It shows files, open items and finished-round durations while keeping execution and verification separate, without claiming permanent project-wide correctness. Resumed usage is `usage_scope: "thread_total"`: take the latest cumulative value, never sum it repeatedly. Mixed/unknown accounting is marked; read-only retries after an actual Codex failure start fresh and omit that cumulative mark, while route-check failures preserve the resumed thread.

### Storage

Optional `maxStorageMb` (runner `run` / `start --max-storage-mb N`) caps combined `jobs` and `runs` storage in MiB (1024² bytes). Omission is unlimited. After the existing 30-day cleanup, finished directories are removed oldest first by `result.json` save time, before creating the current task directory. Running/queued jobs and records whose worker or Codex process identity still matches are retained. Cleanup is best effort: deletion failures or retained tasks exceeding the limit do not fail the new task. This runs at startup and does not cap individual logs or growth of active tasks.

`codex_jobs` queries workspace/session history by execution or attention state, linking runner/thread/native IDs and session journals. New jobs preserve original task/acceptance, owner and write context without a separate database or Windows command-line length limit. New jobs also record `context.dispatcher` (plugin version, revision and process ID). `background_status` is present when the session has a live registry entry. Unknown legacy ownership remains unknown and can be found by workspace. Stored normalized paths preserve historical scope conclusions after later symlink changes.

`codex_output` uses `job_id`, not `background_job_id`, to reread full `report`, `result`, `context`, `review`, `stderr` or `events` artifacts without consuming them or restarting tasks. `stderr` reads `stderr.log`; `events` reads `events.jsonl`, including while the job is running. Missing/empty files are explicit. Unicode pages default to 4000 characters, at most 8000; follow `next_offset` until `eof=true`. Full artifacts survive native `job_output` delivery/64 KiB truncation; missing legacy context is explicit.

Runner phases are atomically saved in the small `phase.json` file for direct status reads; legacy jobs fall back to event scanning. History queries reuse parsed arguments/results and a single set of filter predicates; without execution/attention filtering, finished records receive full status enrichment only on the selected page. Summary error counts still check liveness for unfinished records. Locks, snapshot-cache keys, history directory filters and scope comparisons share case-insensitive `/mnt/<drive>` normalization, while native Linux paths remain case-sensitive. Historical scope comparisons do not follow later symlinks.

Snapshots detect additions, modifications (including permissions) and deletions in `cwd` (`snapshot`). Successful full snapshots merge received outside events (`snapshot+codex_events`), retaining snapshot precedence inside. Permission/IO failures fall back to events instead of inferring deletion from incomplete scans. Events cover Codex's file-edit tools, not shell writes; extra directories are not scanned. Unreported host/Windows/VM changes require direct checks.

Snapshots may catch other processes' writes, such as logs. Clearly unrelated files absent from Codex's own list need only an explanation. `ignoreChanges` uses Python `re` on relative `/`-separated paths; `(?P<log>^logs/)` works, JavaScript's `(?<log>^logs/)` does not. Invalid patterns are skipped with explicit `ignore_warnings` in results/output. Matches are removed before the 300-entry cap from lists, counts and scope checks. The hand-off explains that independently changing files are not grounds for `blocked`; explicit task requirements still apply.

Trees exceeding the 20-second snapshot budget are remembered for seven days: snapshot supplied scope paths plus events elsewhere (`scope_snapshot+codex_events`), or events alone without scope (`codex_events`). Only actual budget exhaustion enters that cache; permission/IO failures fall back to events without marking the tree too large. `start` prunes finished `jobs`/`runs` with results saved over 30 days ago. Unfinished directories are pruned only when neither worker nor Codex remains and their latest internal/directory modification is over 30 days old; running/queued records remain regardless of directory age.

### Standalone runner

After reducing a tree, run `python3 runner/codex_runner.py forget-too-big --cwd DIR`. It removes only that normalized cache key and prints `{"status":"completed","removed":true}`, or `removed=false` if absent. It starts neither Codex nor a snapshot; the next writable task tries a full snapshot again. This is CLI-only. Cached entries continue to skip full snapshots until their seven-day expiry or explicit removal.

Planner instructions live in `%LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md` (`plannerPromptFile` overrides it; `loaded.json` shows the actual path). A comment-only template is created; text outside HTML comments enters the planner's system prompt every step, survives compaction, applies after saving without reload, and is not sent verbatim to Codex. Completed runs remind the planner to check it when set.

### Workspace guard

Configured `workspaces` deny the agent's file-writing/arbitrary-execution tools. `'*'` covers every workspace; native Linux `/` covers the root and native descendants and also works as scope. Windows drives and `/mnt/<drive>/...` retain Windows-path matching. Seep's arbitrary `seep_r2_cmd` goes to Codex; structured `seep_r2_info`/`seep_status` queries remain available.

Shell verification permits pipelines, conditions, loops and read-only `$(...)`, but refuses non-null write redirection, backticks, heredocs, process substitution and arithmetic `$((...))`/`$[...]`. Single-quoted/escaped arithmetic text stays literal. Argument-filtered commands reject unresolved expansions, unquoted braces and unquoted globs capable of generating options (`find . -[d]elete`); fixed paths (`find src/* -type f`, `git diff src/*.mjs`) and quoted patterns remain supported. Ordinary data assignments may prefix read-only commands; environment settings that affect program lookup, startup code or execution options remain denied. Initial literal path assignments separated by semicolons/newlines can supply later checks and read-only substitutions; conditions, loops and `read` clear known values.

`file -C/--compile`, `date -s/--set` and positional time setting are refused, including short-option combinations/long abbreviations. Git `--ext-diff/--textconv` abbreviations (`--ext-d`, `--textc`) are refused; `--text` stays valid. Caller-selected Git pagers, Go execution tools and sort compression/random sources remain denied. Read-only Git config, remote, tag and stash forms remain supported.

`sed` permits static `p` printing and `s` substitution to stdout, including semicolon-separated scripts, while refusing in-place editing, external scripts, `w/e/r` commands and substitution `w/e` flags. `awk` permits static stdout programs without `system`, process pipes, output redirection, `getline` or extension loading. Neither program may come from unquoted glob expansion. `find -exec/-execdir` accepts complete, already-permitted read-only commands; deletion, file output and interactive execution stay denied. `dd` accepts only `if=/bs=/skip=/count=` with stdout output. `paste`, `tr`, `base64 -d` and `ssh-keygen -l -f` are supported. Process and port queries (`tasklist`, `netstat`), bare `env`, `reg query`, single-path `icacls` queries and Git `--version/rev-list/diff-tree/check-ignore` also pass. Redirection targets receive substitution checks; variable-test/read destinations must be literal. `allowCommands` uses JavaScript regexes; invalid patterns warn and are skipped without disabling the guard. Denials identify the structure or first refused segment, with a specific reason for dangerous sed/awk/find/dd forms. PowerShell syntax checks use bundled [`tools/Test-PsSyntax.ps1`](tools/Test-PsSyntax.ps1): `pwsh -NoProfile -File <that script> a.ps1 ...`. Dispatch reminders use this session's live jobs across reloads; other sessions' jobs do not suppress them. The guard is a workflow constraint, not a sandbox; test commands execute project code.

`xargs` accepts only optional `-r` followed by literal `cat` or `sha256sum`.

`loaded.json` is preserved when its valid record belongs to another live PID, and refreshed for this process, a dead PID or a corrupt record; `codex_runtime.instance` always uses the current in-memory identity.

Bare, argument-free `:` and `continue` are supported. Quoted/escaped forms, `timeout` wrappers and executable paths remain refused.
Direct `command -v name …` lookup of literal command names is allowed; execution mode, expanded operands and wrapper/path invocations remain refused.
A read-only subshell can omit the space after its opening parenthesis, for example `(cd directory; ls )`. Arithmetic and function definitions remain refused.
`>&` accepts only a complete numeric file descriptor, such as `2>&1`, and rejects file targets that merely start with digits.
`env -u TAR_OPTIONS tar -tzvf ./archive.tar.gz` lists one literal local gzip archive. Extraction, remote archives, and extra options remain refused.

Since `0.9.100` a word-initial `#` is a bash comment (refused inside `$(...)`), and unquoted `$'…'`, `$"…"` and `${ cmd; }` are refused. Test runners accept only fixed switches and literal paths: pytest takes `-q -v -x -s -l -k/-m <expr> --maxfail=N --tb=… --lf --ff --collect-only` and similar, `python -m unittest` operands must be `discover`, `tests…`, `test_*…` or a `.py` path, `node --test` takes files and `--test-name-pattern=…`, npm/pnpm/yarn `test` accepts only `--`, `-s`, `--silent` and literal operands, and `make` only a lone `make test` / `make check`; put other arguments in `allowCommands` or hand that check to Codex. Tool names are case-insensitive; `apply_patch`, `multi_edit`, `ops_write`, `ops_edit` and camelCase or hyphenated MCP write and execute actions are refused too, and shell tools refuse `env`, `stdin` and similar arguments. Commands above 32 KB are refused. `workspaces: ["*"]` also covers sessions without a working directory.

`executorPromptFile` (default `executor-prompt.md` next to the planner prompt) holds fixed requirements for Codex: its content, minus HTML comments, is appended after the execution constraints of every handoff, grants no permission and yields to the task, acceptance criteria and constraints on conflict. The control panel edits it, shows prompt lengths and backups, guarded workspaces, host access, unknown configuration keys and an environment check, adds timeout, retry, running-job and auto-resume settings, richer job rows with search and extra report artifacts, a Gemini write history, and session operations that go through the local request files.

Requires Windows/WSL2, Codex CLI, Python 3.11+ in WSL, and DSH `>=0.2.1-rc.2 <0.3.0`. Install `github:xiaobaifly7/dsh-codex-conductor`; see [installation](#安装). Tests: `node --test test.mjs workflow.test.mjs runtime.test.mjs panel.test.mjs client-panel.test.mjs resume.test.mjs` and `python3 runner/test_codex_runner.py`; mocks need no DSH/real Codex. Platform/tool-specific cases skip when unavailable. CI runs both on Ubuntu/Windows with Node 22/Python 3.12.

## License

[MIT](LICENSE)
