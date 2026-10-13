# 发布说明

## 1.0.0-beta.8（本地开发，未发布 npm）

- B8.1：新增版本化宿主 capability 声明与独立 trigger 观察事件；CLI/MCP/Agent API 注入和 Claude Hook 记录接口、触发、交付模式及哈希化会话/任务身份，不保存原始标识。
- 新增只读 `ctx host capabilities`、MCP `context_host_capabilities` 和 Agent API `contextHostCapabilities`；声明与实际触发分开展示，调用回执不代表模型采用。
- `ctx report` 新增按触发、接口、交付模式和失败状态统计的覆盖区，保留原有 operation/interface 输出；不把未触发或未采用推断为模型失败。
- 新增封存日志段的哈希/偏移读取索引与 `ctx journal index --apply`。索引失效或损坏时报告回退全量重放，`ctx journal verify` 始终做全链验证。
- 新增 `ctx evaluation report --input` 的固定任务 paired 评估入口；只接受同仓库版本、模型与验收标准的真实记录，缺少 provider usage 标为 unavailable。
- 记忆导入排除来源目录内部的生成目录；回归覆盖旧 worktree、嵌套仓库、凭据样本文本、候选隔离和重复扫描指纹。
- 合成 CLI、MCP、Agent API、Claude Hook 回归已覆盖；真实 Zcode/Codex 触发与采用、跨平台矩阵和 npm 发布仍待完成。

## 1.0.0-beta.7（本地开发，未发布 npm）

- 修复 runtime 启停的失败误报：启动优先等待初始化，截止时重新以实际存活状态确认；显式启停等待上限为 10 秒，停止仍等到最终写入完成及租约清理。超时提示“尚未确认”并引导 `ctx runtime status`，保留启动标记避免重复拉起。
- 记忆导入一次原子写入候选，批量追加日志只做一次历史校验、一次 Git 状态读取和批量投影更新；批量知识审核复用同一路径。日志哈希链、幂等冲突检查及中断后恢复保持有效；同步 pending 后重复导入可修复，不重复生成知识。
- CLI 与 MCP 在单次调用内复用项目根路径解析，避免内部重复启动 Git；长期服务不会跨请求缓存项目根目录。
- 导入响应新增扫描范围、已扫描文件数和空结果原因。明确 `--path` 是目标项目、用户/系统 `.zcode` 不会被扫描；建议直接 `ctx learn`，不要为满足 import 搬动或创建文件，也不要重复无变化扫描。
- 新增 MCP `context_learn`，直接保存带原始来源证据的候选知识，适用于项目外记忆；不会自动验证。更新 CLI 帮助、README 和随包 Skill。
- 新增 `node scripts/benchmark-import.mjs`，在临时 Git 项目测量 40 条记忆导入、重复导入、检索、录入和注入；不写入真实项目。

2026-10-12 本机 Windows / Node 24.6.0 单次对照（同一脚本，非性能承诺；未启动后台 runtime，已启用 v2 同步）：

| 操作 | beta.6 | beta.7 |
| --- | ---: | ---: |
| 40 条记忆导入（API） | 21,085 ms | 396 ms |
| 重复导入（API） | 189 ms | 106 ms |
| 知识检索（CLI） | 310 ms | 251 ms |
| 单条知识录入（CLI） | 820 ms | 435 ms |
| 上下文注入（CLI） | 1,321 ms | 752 ms |

样本是空 Git 仓库中的 40 条记忆，不代表长期运行、大日志或生产仓库的完整性能。日志完整性校验仍随历史体积增长。

## 1.0.0-beta.6（beta 通道）

包含此前 beta.3–beta.5 的本地开发成果；这些版本未单独发布 npm。AI 工具自主调用、上下文智能注入的完善、宿主自动事件覆盖及效果评估转入 1.0.0 正式版核心特性待办，不作为本次 beta 发布前置条件，详见 `ROADMAP-1.0.md`。

- 新增 `knowledge review`，按状态、精确来源和待复核条件筛选；提供分页、条数限制和跨条目的 JSON 正文预算。
- 新增 `knowledge batch verify/reject/deprecate/keep`：默认预览，显式 ID、原因和预览 token 才能执行；verify/keep 要求证据，过期预览拒绝执行。知识状态一次原子保存，日志同步失败显式返回 pending，可原请求幂等重试。
- `keep` 对仍有效的已验证知识完成来源复核，绑定来源指纹；来源再次改变重新提醒。部分扫描不能结案，候选不会自动验证，退役知识通过会话替换撤回。
- CLI、MCP 与 Agent API 提供同一治理能力；MCP 新增 `context_knowledge_review` / `context_knowledge_batch`。
- 修复显式运行时观察与 ping 共用 1 秒超时导致慢 Git 扫描误报失败的问题：观察等待上限为 10 秒，轻量探活仍为 1 秒；增加延迟观察回归，并补齐 CLI 生命周期测试的退出清理。
- 接入验收载体为 Zcode 和当前 Codex；各宿主实际调用与采用证据单独记录，不以协议测试代替。
- Windows 本地全量回归 154/154 通过。Zcode 的 GLM-5.3 真实调用 MCP 注入与有界知识审阅并引用返回 ID；当前 Codex 真实验证会话交付模式。宿主验收范围和模型判断偏差见 `HOST-ACCEPTANCE.md`。

## 1.0.0-beta.5（开发中，未发布 npm）

- `import` 改为按段落、列表项和完整表格提取，保留标题及起止行号；跳过 YAML front matter、代码围栏和生成指引，含疑似秘密的整个段落不导入。
- `import --apply` 保存来源指纹与知识 ID 对照；`changes` 区分新增、修改、删除、未变、部分扫描和不可用来源，`reviewRequired` 持续提醒待复核旧记录。默认预览仍零写入。
- 来源变化不自动改变知识状态，拒绝/退役记录不被重复导入激活；重复内容返回已有知识 ID。部分扫描和忽略规则不会清空来源基线。
- 真实仓库预览发现旧工作树文档混入候选；现跳过 `.claude/worktrees` 及带 `.git` 边界的嵌套仓库，避免导入其它 checkout 的材料。
- 接入验收目标于 2026-10-11 调整为 Zcode 和当前使用的 Codex，分别验证实际工作流；Claude CLI 模型验收暂缓，通用 MCP 协议测试不宣称等同宿主自动触发。

## 1.0.0-beta.4（开发中，未发布 npm）

- CLI / MCP / API 提供可选 session/task 身份、显式 reset 与 full/delta/unchanged 交付。默认调用保留完整输出；变更或撤回证据时返回替换包，任务/分支/范围变化使缓存失效。
- 哈希回执限制会话数、条目数、读取字节及过期时间；缓存故障回退完整包。派生缓存不进入升级备份，不是宿主确认协议。
- Claude Hook 自动读取会话及子 agent 身份、支持 prompt_id，在 SessionStart 重置；兼容 Claude 2.1.12 的 shell 命令配置。
- `doctor --integrations` 展示项目 Hook/MCP 配置检查、最近本地调用和后续操作，明确区分配置、本地调用与宿主接受。
- 修复 runtime 先删除租约再写停止事件的竞争：现在最终日志写入结束后才报告完全停止，避免立即升级或重启时争抢日志锁。
- 本机 Claude 2.1.12 隔离项目验收已触发 Hook；模型调用因 API key 无效失败，未确认模型接受/采用。未改变登录配置，未产生模型费用。

## 1.0.0-beta.3（开发中，未发布 npm）

- 默认编译先按关键词相关性排序；恢复和交接优先保留进度、待办。正文预算在任务内容和已验证知识/失败经验之间分配，空余预算可借用；显式 Recipe 保留控制权。
- 修复长 checkpoint 挤掉相关知识的问题；无查询的 inject 按恢复场景处理。CLI 支持 `inject --scenario`，`--explain` 增加按原因汇总的遗漏数量、分类用量和截断统计，不返回被过滤内容。
- 默认帮助收敛到五个日常入口及四个按需入口，`ctx --help --all` 提供高级与兼容命令。
- 新增 `knowledge add/list` 和 `knowledge deadend add/list/verify/obsolete/reject` 分组；原 learn、deadend、deadends 和 MCP 工具继续兼容。新项目指引使用分组入口，已有项目指引不被覆盖。
- 编译排序标识更新为 `compiler-ranking-v3`；升级前的 manifest 需重新编译后展开。

## 1.0.0-beta.2

- 新增 `ctx upgrade`：已有项目数据预检、带 SHA-256 清单的流式备份、v1 导入或状态对齐、完整日志无损归档、投影重建及历史哈希验证。
- `--dry-run` 不写数据；默认向 stderr 输出按实际字节、记录和日志段计数的阶段进度，stdout 保持 JSON；`--no-progress` 可关闭进度。
- 成功后恢复原运行时状态，保留禁用策略；失败保留备份及现场。支持原始数据未改变时恢复缺失回执的中断导入。
- 备份排除旧备份、开发产物、锁及运行时临时凭据；拒绝符号链接，避免向项目外读写。压缩不丢弃事件，也不自动提升知识可信状态。

升级本地命令：`npm install --global fluffy-context@1.0.0-beta.2`。关闭目标项目的 agent/MCP 会话后，运行 `ctx upgrade --dry-run` 预览，再运行 `ctx upgrade` 执行。备份会额外占用磁盘；当前全链校验仍需将事件加载到内存，数十个分支的长期真实项目验收仍待完成。

## 1.0.0-beta.1

这是项目认知层的首个 beta，面向愿意验证新工作流的用户；npm `latest` 保持 0.8.0。本版本不承诺所有 agent 都会自动调用工具，也不将字符估算宣传为真实 token 节省。

### 使用体验

- `ctx init` 完成布局、首次迁移、日志校验、项目指引和运行时启动。保留已有禁用策略；CI 使用 `--no-start --no-integrations`。
- `ctx inject "当前任务"` 返回默认 2400 字符预算的上下文正文，按任务词选择场景，默认排除文件活动噪声。MCP 使用 `context_inject`；API 使用 `injectContext`。
- `ctx import` 预览项目内 memory、.claude、.zcode、.cursor、.curcor、.codex 和 agent 文档；`--apply` 去重后保存带来源的候选。候选经核验后才进入普通检索。
- 已存在 `.claude` 的项目由 init 配置 Hook/MCP，修复旧安装路径与 Hook 输出契约。其它宿主使用项目 AGENTS.md、MCP 或 API。
- `ctx report` 展示存储、语义事件比例、显式复用及输入/输出估算；缺少数据时不虚构收益或回本日期。

### 数据与正确性

- 实体增量同步，避免读取计数变化重复保存整批历史；过滤 log/tgz 文件活动。
- 约 1 MiB 的日志段无损 gzip 归档，保留事件字节和哈希链，校验中断产生的双副本；可选观察达到容量预算后拒绝入库，语义写入继续。
- 修复 UTF-8 尾部恢复、存活进程锁保护、runtime 关闭后定时器残留。
- 知识诊断遵守同一查询、状态和范围，限制正文预算及冲突组数，不再将全库候选泄漏到普通查询。
- 修复没有 checkpoint 时无法注入已验证知识的问题；新项目导入并核验旧记忆后即可检索，无需先创建任务快照。

### 从 0.8.0 升级

1. 停止项目 runtime（`ctx runtime stop`），断开所有使用旧版本的 MCP/agent 会话，并备份项目 `.context` 目录。
2. 安装：`npm install --global fluffy-context@beta`。
3. 在项目根目录执行 `ctx init`，重新连接 MCP/agent，再执行 `ctx inject "当前任务"`。

归档日志要求本 beta 或 1.0.0-dev.1 及更新读取器；不可用 0.8.0 混写或直接降级。若需回滚，应停止新版进程并恢复升级前的完整备份；升级后的新增记录需要单独保留。v1 Context/Snapshot 文件保持原样。

### 验收证据与限制

Windows 本仓库真实记录：一个日志段从 1,050,216 字节降至 189,044 字节，解压与备份一致；同一条知识查询的 JSON 输出从 51,107 降至 1,211 字符。这是具体操作的存储/输出结果，不能外推为模型 token 或任务正确率收益。

正式版仍需跨平台矩阵、真实宿主触发验收、会话增量注入、部分迁移恢复、多段导入、遥测聚合和 provider token 配对实验。导入为保守文本行抽取，敏感行过滤不是完整秘密检测。场景推断及冲突检测是确定性规则。
