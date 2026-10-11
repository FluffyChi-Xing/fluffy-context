---
name: fluffy-context
description: 使用 fluffy-context（ctx）CLI 管理 AI 编程会话的本地上下文。需要初始化项目、保存或恢复工作状态、查看 Context、运行 doctor、记录项目知识或验证死路时使用；也用于排查 ctx 在 Windows、npm 全局安装、.contextignored、Snapshot patch、10 秒限流和 JSON 输出方面的问题。
compatibility: 需要 Node.js >=20.19.0；Git 可选。CLI 通过 npm 全局安装后提供 ctx 命令。
---

# fluffy-context CLI Skill

使用 `ctx` 保存和恢复 AI 编程任务的结构化工作状态。它保存的是 Context、Snapshot、Knowledge 和 Deadend，不是项目代码备份；Git 仍是代码与真实文件变更的权威来源。

## 使用原则

- 命令入口以 `ctx --help` 的日常流程为准；高级、维护和实验命令在 `ctx --help --all`。知识操作集中到 `ctx knowledge add/list/verify/discover` 和 `ctx knowledge deadend add/list/verify/obsolete/reject`；旧 learn/deadend/deadends 继续兼容，MCP 工具名不变。
- 默认注入在进度和已验证知识/失败经验之间保留预算，空余可互借；恢复/交接偏重进度。可用 `--scenario` 明确场景；`--explain` 的 `selection.excludedCounts` 区分未命中、状态/范围过滤和预算遗漏，不要把未命中当成知识不存在。显式 Recipe 保持其预算控制；升级到 ranking-v3 后须重新 compile 再 expand。

- `1.0.0-beta.2` 新增 `ctx upgrade`，用于已有项目数据升级。先关闭其它 agent/MCP 写入会话；用 `--dry-run` 只读检查，再执行 `ctx upgrade` 自动备份、迁移、压缩和验证。阶段进度在 stderr，stdout 为 JSON，可用 `--no-progress` 关闭进度。备份在 `.context/backups/upgrade-*`；重复执行不重复导入，但会新增备份。已发布 beta.1 不包含此命令。

- 当前源码版本为 1.0.0-beta.6（本批未发布 npm，公开 beta 仍为 beta.2）。每批通过测试后执行 `npm run install:local` 从 tarball 更新全局 ctx，查看 `.context/builds/install-*.json` 哈希核验回执。不要以源码链接安装代替这一验收。
- 持续会话可用 `inject --session-id <id> --task-id <id>`；无变化时正文为空，`delivery.replacePrevious` 要求替换旧证据。压缩、清空或丢失输出后加 `--reset-session`，不要跨宿主/子 agent 共用身份。回执只证明本地调用，不能证明模型采用。
- 用 `doctor --integrations` 诊断项目 Claude Hook/MCP 配置与本地调用；用户级配置、工作区信任及宿主接受需另行验收。生成 Hook 使用兼容 Claude 2.1.12 的 shell 命令格式。
- 用户指定 Zcode 和当前 Codex 为真实接入验收载体，替代 WebStorm CC GUI；暂缓 Claude CLI 模型验收。分别验证可用接入路径、触发与采用，不得将 MCP 协议测试或配置存在宣称为宿主自动触发成功。
- beta.6 用 `knowledge review` 有界审阅候选和已验证知识，`--review-required` 过滤来源复核，`--source` 为精确项目相对路径；按 nextOffset 分页。预算包含条目 JSON 的所有字段但不含响应外壳，条目截断时须补读证据再做决定。
- 批量治理使用 `knowledge batch verify/reject/deprecate/keep --ids ... --reason ...`，默认预览；执行必须保留相同请求并追加 `--apply --expected-token <token>`。verify/keep 必须给出 `--evidence`，核验由操作者负责。keep 仅结案已验证知识的当前来源修订，后续变更重新提醒；partial/unavailable 不能结案。日志同步 pending 时状态已保存，按相同请求及 token 重试，不把 pending 当作完成。MCP 对应 context_knowledge_review/context_knowledge_batch。
- beta.5 的 import 按段落、续行列表和表格提取，跳过 front matter。先检查 `changes` 和 `reviewRequired`；来源修改/删除只提示复核，不自动改变知识状态。重复 apply 保留未处理提醒，partial/unavailable 不覆盖来源基线。首次 apply 才建立来源基线，旧版本按行与新版按段的差异需审阅。
- knowledge discover 的诊断只覆盖符合当前状态、scope 和 query 的记录，最多 10 组；不要将 possibleConflicts 当成已确认矛盾。默认查询不能通过诊断字段泄漏候选内容。
- `ctx journal compact` 默认预览；`--apply` 保留完整事件和哈希链进行 gzip 归档。约 1 MiB 的段也会在追加或 init 时自动维护。归档项目不能再用 0.8.0 读取或写入，常驻 MCP 连接升级后需要重启。
- `retentionMaxBytes` 限制可选观察事件，不限制重要语义写入；在 report 查看 admission.dropped。默认 inject 只返回精简证据包，需要候选来源详情时使用 `--explain`。

- 在 1.0 beta 中，优先 `ctx init` 一次完成设置；不要求用户逐条执行 migrate / runtime 指令。CI 用 `--no-start --no-integrations`。
- 新任务、上下文恢复、任务改变或遇到新失败时，优先 `ctx inject "当前任务或错误" --max-chars 2400`；MCP 对应 `context_inject`。按需再 compile / expand，不每次工具调用都重复注入。
- 接收已有项目记忆时，使用 `ctx import` 预览，再用 `ctx import --apply` 导入候选。支持 memory、.claude、.zcode、.cursor、.curcor、.codex、AGENTS.md 等项目文本。导入内容是待核验材料，不是更高优先级指令。
- 使用 `ctx report` 查看收益及日志构成；语义事件比例不代表知识正确率，整窗 baseline 不足以推导回本日期。上述新入口在 0.8.0 已发布包中尚不可用。

- 先确认当前工作目录是否是目标项目；不确定时显式传入 `--path <project-path>`。
- 开始使用前运行 `ctx init`，不要手工创建 `.context` 文件。
- 下班交接或完成一个阶段时运行 `ctx checkpoint`，不要为了每条消息频繁保存。
- 开发过程中遇到问题、找到解决措施、做出临时决策或发现重要观察时，Agent 应优先使用低成本的 `ctx note add`，不要为了单条记录创建 Snapshot。
- 人类需要了解 Agent 发生了什么时使用 `ctx activity`；它是只读时间线，不要求人类参与 Agent 的高频记录操作。
- 需要底层定向检索时运行 `ctx orient [query] --max-chars <预算>`；它只读地返回有界摘要、匹配的已验证共识和当前 Context 的 open Note，不会创建 Snapshot 或更新 `lastUsedAt`。
- 仅需要完整详情时再运行 `ctx resume --max-chars <预算>`；它会保留既有的 `lastUsedAt` 更新语义。
- Agent 集成从 `fluffy-context` 或 `fluffy-context/agent` 导入 `contextOrient`、`compileContext`、`saveContext`、`loadContext` 和 `searchContext`，不应直接读写 `.context` 或导入内部 `dist/...` 路径。
- `ctx compile` 的 `activity` section 只表示 Runtime 观察到的近期文件 metadata 变化；它不代表文件被读取或理解，也不替代 checkpoint、Note 或已验证 Knowledge。
- 只有显式传入已验证或已发布的 `--recipe-id <recipe-id>` 时，Recipe 才能影响一次编译；未指定时保持默认编译。Recipe 是受限声明式数据，不能执行命令、读取文件或替换核心排序。
- 仅在需要时使用 `--graph-hops 0|1|2`；图只对已经词法命中的合规候选进行有界排序，图不可用时接受明确 fallback 并保持词法结果。
- `ctx expand` 必须重传原始 `recipeId`、`graphHops` 和 compile budget；身份过期、Recipe 状态/内容/适用性变化时重新 compile，不要绕过 hash 校验。
- 0.8.0 的 Compiler Manifest 提供稳定 `identity.manifestHash`、候选 `itemHash`、`tokenEstimate` 和 `level` 契约；默认输出 `summary` 层。
- 只对 selected candidate 使用 `ctx expand --manifest-hash ... --candidate-id ... --level structured|evidence`。必须带上原始 compile 参数和相同的 compile budget；Manifest 过期时应重新 compile，不要绕过 hash 校验。
- `expand` 是无状态、只读的渐进式展开：`complete` 才提供完整 `content`，`partial` 提供有界 `text` 且 `content` 为 null。它不写入 Context/journal、不记录 feedback、不读取项目文件正文、diff、命令输出或敏感数据。Agent API 使用 `contextExpand`，MCP 使用 `context_expand`。
- 新任务先发现已验证共识，再开始实现；候选项只在显式审查时使用。
- 普通查询只使用已验证 Knowledge 和 Deadend；需要审查候选项时显式使用 `--all`。
- CLI 业务命令的标准输出是 JSON；错误写入标准错误并返回非零退出码。解析输出时不要把 `--help` 的纯文本当作 JSON。
- 每周或每月复盘时使用 `ctx report`，不要为每条 prompt 运行；它只读 journal 和 v1 数据，不创建事件或修改项目状态。
- Report 中的 `chars / 4` 是明确标注的 estimated token，不是真实 Provider token；Provider token 和计费金额当前 unavailable。
- 只有显式 `record.used` 才算 Knowledge/Deadend reuse；compile 命中或 orient 返回不等于复用。
- 没有显式 baseline 时，report 不生成 savings、ROI 或 payback 数字；report 不能替代 `doctor`、`journal verify` 或人工治理。

## 快速工作流

```text
ctx init
  ↓
ctx inject "当前任务" / context_inject
  ↓
Plan：先形成实现计划
  ↓
Implement：ctx note add "观察、决策或问题"
  ↓
Verify：执行适用检查并记录重要失败
  ↓
Handoff：ctx checkpoint --title ... --progress ...
  ↓
ctx knowledge add ... / ctx knowledge deadend add ... → 显式 verify
```

`ctx orient` 不带查询时也有效，用于恢复当前任务和 open Note。带查询时只发现已验证的 Knowledge 与 Deadend；不要以候选项驱动普通实现。

### Usage report

在阶段性复盘、周报或月报时运行只读观测报告：

```bash
ctx report --days 30
ctx report --month 2026-08 --granularity week
ctx report --since 2026-08-01T00:00:00.000Z --until 2026-09-01T00:00:00.000Z --baseline-tokens 12000 --baseline-source manual
ctx report --format ascii
```

JSON 是默认输出；`--format ascii` 仅用于终端展示。报告分别统计 v1 文件资产和 v2 journal 事件，展示 Knowledge、Deadend、Note、Context、Snapshot、显式 reuse、操作趋势与 estimated token 投入。`record.used` 是唯一的 reuse 信号，候选项命中、compile 选择和普通检索都不算复用。

`--baseline-tokens` 必须是显式对照输入。未提供 baseline 时 savings、ROI 和 payback 为 `null` 或 `no_baseline`；字符换算不代表 Provider 真实 token，也不提供默认单价。报告失败时应使用 `ctx doctor` 与 `ctx journal verify` 进一步诊断，而不是把 report 当作数据修复工具。

### 初始化

```bash
ctx init
ctx init --path path/to/project
```

初始化会创建 `.context/` 和项目根目录的 `.contextignored`。重复执行是幂等的，不会覆盖已有 Context 或忽略规则。

### 保存 Context

第一次保存创建 baseline，后续变化保存 patch，没有变化返回 `no_change`：

```bash
ctx checkpoint \
  --title "订单状态机重构" \
  --progress "完成状态流转梳理，正在补充异常测试" \
  --completed "梳理状态转移,确认幂等策略" \
  --pending "补充异常测试,运行集成测试" \
  --decisions "服务端统一维护状态" \
  --risks "第三方回调可能重复" \
  --files "src/order.ts,src/order.test.ts"
```

列表参数用逗号分隔。继续更新已有 Context 时传入：

```bash
ctx checkpoint --context <context-id> --progress "完成异常测试"
```

字段未提供时会沿用之前的值；需要清理字段时根据 CLI 当前参数语义显式传入空值或调整运行时输入。

### 恢复 Context

```bash
ctx resume
ctx resume --context <context-id>
ctx resume --path path/to/project --max-chars 2000
```

`resume` 返回：

- `context`：Context 元数据。
- `snapshot`：当前不可变 Snapshot。
- `resumeSummary`：受字符预算限制的轻量摘要。
- `details`：完整结构化 Context，按需使用。

默认保存实际写入之间至少间隔 10 秒：

- 有变化且距离上次写入不足 10 秒：`status: "rate_limited"`，同时返回 `retryAt`。
- 输入与当前内容相同：`status: "no_change"`。
- 可以保存：`status: "saved"`。

遇到 `rate_limited` 时不要循环重试；完成更多阶段性工作后，在 `retryAt` 之后再保存。

### Evolution、Skill 与 Recipe

Evolution 必须显式发起，并且只基于已授权的 journal、Git/workspace metadata 与 `record.used` 信号：

```text
Experience metadata → Evolution Proposal → accept → materialize → governed lifecycle
```

```bash
ctx evolution propose --recent-limit 32 --target-kind skill
ctx evolution list
ctx evolution inspect <proposal-id>
ctx evolution accept <proposal-id> --rationale "人工审查"
ctx evolution verify <proposal-id> --rationale "确认可物化"
ctx evolution supersede <proposal-id> --rationale "由新提案替换" --supersedes proposal:<predecessor-id>
```

- 不自动运行 `evolution propose`；它不读取项目源文件、原始 prompt、Note/Snapshot 内容，不创建 checkpoint，也不自动接受、验证、发布、物化或调用。
- 接受 Proposal 仅创建候选工件。Skill/Recipe 仍需要显式物化和人工治理；候选从不进入默认 orient/compile/retrieval。
- Skill 和 Recipe 都追加式经历 `candidate → verified → published → deprecated|superseded`；修改时用带 `supersedes` 谱系的新记录，不删除或覆盖旧记录。
- 仅 `published` Skill 可以记录 invocation。调用只存输入 hash 与 caller event ID；每个 invocation 仅能写入一个 `success|failure|partial|irrelevant|unknown` 终态 outcome。不要执行 procedure 文本，也不要把原始输入写入 Note、journal 或命令参数。
- 只有已物化、verified/published 且适用的 Recipe 可以作为 `--recipe-id` 参与 compile；不存在、候选、终态或不适用 Recipe 必须修正治理/选择，而非静默降级。


`ctx agent serve` 提供 MCP stdio server，注册 25 个工具：`context_inject`、`context_import`、`context_orient`、`context_expand`、`context_compile`、`context_resume`、`context_note_list`、`context_note_add`、`context_usage_report`、`recipe_list`、`recipe_inspect`、`recipe_materialize`、`recipe_transition`、`skill_list`、`skill_inspect`、`skill_materialize`、`skill_transition`、`skill_record_invocation`、`skill_record_outcome`、`evolution_propose`、`evolution_list`、`evolution_inspect`、`evolution_accept`、`evolution_transition` 和 `context_checkpoint`。标准输入和输出都是 MCP 协议，不能输出提示、日志或交互文本；调用错误是单次工具错误，不应让 server 退出。

读取工作流通常是 `context_orient → context_compile → context_expand`。`context_compile` 与 `context_expand` 保持有界、确定性且不读取文件正文，且可显式传递 `recipeId` 和 `graphHops: 0|1|2`；`context_resume` 复用 `loadContext`，可能更新 `lastUsedAt`。`context_note_list`、usage、Evolution/Skill/Recipe 的 list/inspect 是逻辑只读操作。`context_note_add`、`context_checkpoint`、Evolution 的 propose/accept/transition，以及 Skill/Recipe 的 materialize/transition/invocation/outcome 都是显式写入；不会自动执行 Skill/Recipe 或自动推进生命周期。

```bash
ctx agent serve
```

Claude Code 项目集成必须显式安装，且默认不修改文件：

```bash
ctx integrate claude inspect
ctx integrate claude install
ctx integrate claude install --apply
```

只有 `--apply` 会合并项目的 `.claude/settings.json` 和 `.mcp.json`。它保留无关配置，遇到无效 JSON、无效结构或同名 `fluffy-context` MCP server 冲突时必须拒绝覆盖。安装后 Hook 使用以下阶段引导：

```text
Orient → Plan → Implement → Verify → Handoff
```

Hook 是 fail-open 的只读提示：输入损坏、项目未初始化或定位失败时不应阻止任务；它不自动保存 Note 或 checkpoint。阶段结束时 Agent 应自行评估后执行一次带完成项、待办、决策和风险的 `ctx checkpoint`。

## Agent 短期记录与 Human 可观测性

`checkpoint` 适合阶段性总结；Agent 在任务进行中遇到突发问题、排查出解决措施、做出决策或发现重要事实时，应使用 `ctx note add` 快速追加记录：

```bash
ctx note add "第三方人脸识别测试凭据缺失" \
  --kind problem \
  --context <context-id>
ctx note add "保留原始请求体后验签恢复" \
  --kind decision \
  --status resolved \
  --context <context-id>
ctx note list --context <context-id> --open
```

Note 不会创建 Snapshot，原始记录会保留。阶段性总结时可以显式吸收当前 Context 的 Note：

```bash
ctx checkpoint --context <context-id> --progress "完成阶段排查" --absorb-notes
```

只有真正保存了新 Snapshot 时 Note 才会被标记为已吸收；`no_change` 和 `rate_limited` 不会改变 Note。

人类查看 Agent 开发过程中发生了什么时使用只读 Activity 时间线：

```bash
ctx activity --context <context-id> --open --limit 20
ctx activity --since 2026-08-21T00:00:00.000Z
```

`ctx activity` 返回 Note 和已保存 Snapshot 的有限时间线，不会把完整日志或所有历史内容注入上下文。

## Knowledge 与 Deadend

### 记录可复用知识

Knowledge 默认是 `candidate`，不会进入普通查询，也不会自动替代人工确认：

```bash
ctx knowledge add "订单取消后不能再次进入支付中状态" \
  --scope project \
  --context <context-id> \
  --snapshot <snapshot-id> \
  --evidence "src/order/state-machine.ts,接口约束"
```

查询、发现和确认：

```bash
ctx knowledge
ctx knowledge --all
ctx knowledge discover "投保人认证"
ctx knowledge discover "identity verification" --scope project --limit 10 --max-chars 4000
ctx knowledge verify <knowledge-id>
```

`discover` 默认只匹配已验证 Knowledge，并返回命中的字段、规则原因、来源 Context/Snapshot 和 supporting evidence。候选项不会参与普通发现；审查候选或其它状态时使用 `--all` 或显式 `--status candidate,verified`。匹配采用确定性的规范化文本和少量业务别名规则，不依赖模型或向量数据库。

### 记录已验证死路

Deadend 用来阻止后续会话重复尝试明确失败的方案，默认也是 `candidate`：

```bash
ctx knowledge deadend add \
  --attempt "使用共享可变单例保存订单状态" \
  --reason "并发测试出现跨用例状态泄漏" \
  --scope project \
  --context <context-id> \
  --snapshot <snapshot-id> \
  --evidence "test/order-state.test.ts"
```

查询和确认：

```bash
ctx knowledge deadend list
ctx knowledge deadend list --all
ctx knowledge deadend verify <deadend-id>
```

提供 `--context` 或 `--snapshot` 时，来源必须真实存在；不存在的来源会拒绝写入。不要为了让命令成功而删除来源参数，除非该知识确实没有可追溯来源。

## `.contextignored` 与安全边界

`.contextignored` 使用接近 `.gitignore` 的规则配置项目关联文件：

```gitignore
private/
*.generated.ts
notes/draft-*
```

内置保护规则优先于项目规则，不能通过否定规则绕过。以下路径默认不会作为关联文件保存：

- `.context/`、`.git/`
- `node_modules/`、`dist/`、`build/`、`coverage/`
- `.env`、`.env.*`
- `*.pem`、`*.key`、`*.p12`、`*.pfx`
- 常见 credential、secret、token 文件
- 绝对路径和 `..` 越界路径

如果 `relatedFiles` 中缺少某个路径，先检查 `.contextignored` 和内置保护规则，不要直接认为 Snapshot 损坏。

## 诊断流程

出现恢复失败、Context 不见或状态异常时按顺序执行：

```bash
ctx status --path <project-path>
ctx doctor --path <project-path>
```

重点查看：

- `initialized` 是否为 `true`。
- `layoutVersion` 是否为 `compact-json-v1`。
- `doctor.checks` 中的 `manifest`、`index`、`contexts`、`index rebuild`。
- 是否传入了正确的 `--path`。
- Context 是否仍为 `active` 或 `stable`。

不要直接删除 `.context`、Snapshot 或 lock 文件来“修复”问题；先保留现场并运行 doctor。Index 是可重建索引，但 Context metadata 和 Snapshot 才是主要业务数据。

## 常见问题与解决方案

### 1. `npm install --global context-runtime` 安装的不是当前项目

如果要安装当前工作树，不要使用 registry 包名安装，先在项目根目录执行：

```bash
npm run install:local
ctx --version
```

如果项目包名已经是 `fluffy-context`，也可以确认：

```bash
npm install --global fluffy-context
```

但这会安装 registry 上的已发布版本；开发当前代码时应使用 `npm run install:local`。

### 2. Windows 下 Node 子进程找不到 `ctx`

Windows npm 通常生成 `ctx.cmd` 和 `ctx` 包装器。交互式终端中直接运行 `ctx` 通常可用；从 Node `spawnSync`、测试脚本或其它程序调用时，应使用 `ctx.cmd`，或在明确控制参数转义的前提下使用 shell：

```js
spawnSync('ctx.cmd', args, { encoding: 'utf8', shell: true });
```

不要把未转义的用户输入拼进 shell 命令。普通 CLI 使用优先直接调用 `ctx`，不需要自行构造子进程。

### 3. `checkpoint` 返回 `rate_limited`

这是默认的防刷写机制，不是保存失败。检查返回的 `retryAt`，完成更多阶段性工作后再保存。相同内容的输入应返回 `no_change`，但如果内容相对当前 Snapshot 有变化，限流优先于下一次写入。

### 4. `resume` 找不到 Context

先确认：

```bash
ctx status --path <project-path>
ctx doctor --path <project-path>
```

然后检查：

- 是否在正确的项目根目录运行。
- 是否使用了错误的 `--context` ID。
- Context 是否是 `active` 或 `stable`。
- Context 是否有 `currentSnapshotId`。
- Git 分支变化是否只是漂移提示，而不是 Context 丢失。

### 5. `--help` 不能用 `JSON.parse` 解析

`ctx --help` 是面向终端用户的文本输出；`ctx --version` 输出 JSON 字符串，业务命令返回 JSON。脚本应根据命令区分处理：

```bash
ctx --help
ctx --version
ctx status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)))"
```

### 6. 参数包含空格或中文

在 shell 中将每个带空格的值整体加引号：

```bash
ctx checkpoint --title "支付回调修复" --progress "已定位签名校验失败原因"
ctx knowledge add "订单取消后不能再次进入支付中状态"
```

列表项用逗号分隔，但逗号本身不适合作为单个列表项内容。

### 7. `doctor` 报告索引问题

不要把 `index.json` 当作唯一数据源。先读取 doctor 的逐项结果；如果 Context metadata 和 Snapshot 存在，索引通常可以从权威 Context 数据重建。若报告 Context metadata 或 Snapshot 损坏，先备份 `.context/` 后再处理，不要用空的 index 覆盖现场。

## 验收清单

使用本 Skill 验收一次 CLI 时，至少验证：

```text
[ ] ctx --help / ctx --version
[ ] ctx init
[ ] ctx status
[ ] ctx doctor
[ ] 首次 checkpoint 为 baseline
[ ] 变更 checkpoint 为 patch
[ ] 相同输入为 no_change
[ ] 短时间变更输入为 rate_limited
[ ] ctx orient 的摘要、共识和 Note 受预算限制且不改写 Context
[ ] .contextignored 排除敏感和越界路径
[ ] Knowledge candidate → verified
[ ] Deadend candidate → verified
[ ] Skill/Recipe candidate → verified → published 的显式治理，以及 supersedes 谱系
[ ] 只调用 published Skill，且 invocation 不保存原始输入、每次仅一个 outcome
[ ] MCP 25 个工具可调用，read-only 工具不逻辑创建认知记录，单次错误不会终止 server
[ ] 显式 Recipe 与 graphHops 编译/展开保持 Manifest identity 校验和 lexical fallback
[ ] ctx report 的 JSON/ASCII 输出、baseline 边界和只读性符合预期
[ ] MCP 只读工具不写入 Context；Note add 和 checkpoint 仅在显式调用时写入
[ ] Claude 集成预览不写文件，--apply 幂等且拒绝冲突
[ ] Hook 失败时 fail open，且不会自动 checkpoint
[ ] npm pack 的安装包可运行 ctx 并导入 contextOrient
[ ] 未知参数返回非零退出码
```

所有命令都应在测试项目或明确指定的 `--path` 下运行，避免把验收数据写入真实项目。
