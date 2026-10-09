# fluffy-context

本地优先、Agent 无关的 Context 与 Knowledge Runtime，帮助 AI 编程 Agent 保存任务状态、恢复工作上下文、复用已验证共识，并生成有界且可追溯的上下文输入。

**当前源码版本：1.0.0-dev.2（本地开发包，未发布）；npm 已发布版本：0.8.0**

## 下一大版本：1.0 开发中

源码工作树已加入第一阶段实现，尚未发布。完整范围与验收门槛见 [1.0 计划](ROADMAP-1.0.md)。

后续已完成本地打包安装闭环、旧安装路径迁移和日志存储治理。每批验证后运行 `npm run install:local`：构建并打包为带 SHA-256 标识的 tgz、安装全局 ctx、逐文件比对哈希、初始化真实项目，并保存 `.context/builds/install-*.json` 回执。不会发布到 npm。

日志达到约 1 MiB 后封存为 gzip 段，连续哈希链、事件身份与重放结果保持不变；`ctx init` 会维护达到阈值的历史段。高级维护可用 `ctx journal compact` 预览、`ctx journal compact --apply` 执行。`retentionMaxBytes` 现在限制可选观察事件的入库，超出预算累计拒绝计数，不阻止 checkpoint 等语义写入，因此不是全部历史的硬容量上限。`.log` 和 `.tgz` 默认不参与文件观察。

**格式兼容性**：归档后必须使用 `1.0.0-dev.1` 或更新版本访问认知日志，不能混用 0.8.0。升级磁盘上的全局包不会热更新已连接的 MCP 进程；这类连接需要重新启动。v1 Context/Snapshot 文件保持原样。

`dev.2` 修复知识诊断污染：duplicate/conflict 诊断与命中使用相同的状态、scope、query 过滤，不再把全库候选或仅主题相近的文本作为冲突返回。冲突判断只覆盖明确否定及 reuse/rebuild 对立，最多检查 100 个匹配项、返回 10 组诊断；每条命中的正文与 evidence 共用 `--max-chars` 预算，诊断正文另有同等总预算。JSON 身份等元数据不计入该文本预算。

```bash
ctx init                         # 布局、迁移、校验、项目指引、运行时
ctx inject "修复支付回调错误"      # 按任务选择有界上下文
ctx import                       # 预览项目内已有 memory / agent 文档
ctx import --apply               # 来源可追溯、去重后写入候选知识
ctx report                       # 日志构成、复用、输入输出 token 估算
```

`init` 保留已有策略；CI 可用 `--no-start --no-integrations`。默认不开启高频文件监听；普通使用不再需要手工执行迁移、校验及 runtime enable/start。项目存在 `.claude` 时安装其 Hook/MCP 配置，其余宿主通过 `AGENTS.md` 指引及统一 MCP/API 入口接入。MCP 新增 `context_inject`、`context_import`；API 新增 `injectContext`、`importMemory`、`setupProject`。

`inject` 根据任务词推断场景，复用确定性编译器；`--max-chars` 限制正文字符，不是模型真实 token 或 JSON 包装长度。导入只扫描项目内支持的文本，跳过符号链接、忽略路径、超预算文件及疑似密钥行，不执行任何导入内容。导入记录必须验证后才进入普通知识检索；自动发现冲突、结构化多段知识提取仍属于后续工作。

报告现在计入输入与输出成本，并展示日志字节数、事件类型分布和语义事件占比。`chars / 4` 仍是粗估；提供 window baseline 仅产生估算比较，不证明任务收益，不再推算回本日期。

```text
checkpoint → orient → compile → expand → feedback → Agent continues
```

`compile` 先返回有界的 summary 候选；Agent 只对需要的候选调用 `expand` 获取 structured 或 evidence 层。`feedback` 仍必须由调用方显式记录。

`fluffy-context` 保存的是任务认知，不是项目代码备份。Git 仍是代码和文件变更的权威；Issue 系统、项目文档、`CLAUDE.md`、`AGENTS.md`、Skills 和 MCP 仍由各自系统维护。

## 30 秒了解

最常用的四类操作：

- `ctx checkpoint`：保存进度、完成项、待办、决策、风险和关联文件。
- `ctx orient`：只读恢复当前任务，并检索匹配的已验证 Knowledge、Deadend 和 open Note。
- `ctx compile`：生成带预算、来源和排除原因的 provider-neutral Context Manifest。
- `ctx learn` / `ctx deadend`：记录可复用结论和失败方案，之后显式验证再用于普通检索。

## 0.8.0 当前能力与边界

| 能力 | 当前支持 |
| --- | --- |
| Context | 初始化、结构化 checkpoint、baseline/patch Snapshot、resume |
| 检索 | `orient`、已验证 Knowledge/Deadend 检索、当前 Context 的 open Note |
| Compiler | 确定性排序、字符预算、截断信息、provenance、纳入/排除原因、显式 Recipe 与可选图排序 |
| Manifest identity | `level`、`itemHash`、`manifestHash`、estimated token，以及 Recipe/图模式的身份绑定 |
| 演化 | 元数据 Experience、显式候选 Proposal、Skill/Recipe 物化与追加式治理 |
| 文件活动 | 可选记录经过过滤的文件 metadata，并编译为 `activity` section |
| Runtime | 本地 v2 Runtime、Git 观察、可选文件观察、自动唤醒和 fail-open 集成 |
| 集成 | Claude Code Hook、Claude Code 配置集成、23 个 MCP 工具、TypeScript Agent API |
| 观测 | `ctx usage report`：只读统计资产、显式复用、操作趋势和 estimated token 投入 |

0.8.0 仍明确不提供自动 checkpoint、自动候选提取、自动验证/发布、模型总结、Embedding/向量检索、远程同步、多人协作或 Context merge。`context_expand` 仍是无状态、只读操作：只按需取得已选候选的 `structured` 或 `evidence` 层，不读取项目文件内容，也不自动记录 feedback。

## 快速开始

### 1. 安装

要求 Node.js `>=20.19.0`。Git 可选；在 Git 项目中，Runtime 会记录当前 branch、ref 和 commit 等 metadata。

```bash
npm install --global fluffy-context
ctx --version
```

在源码工作树中开发时：

```bash
npm install
npm run build
npm run install:local
```

### 2. 初始化项目

在项目根目录运行：

```bash
ctx init
```

也可以显式指定路径：

```bash
ctx init --path path/to/project
```

初始化会创建本地 `.context/` 存储和 `.contextignored` 规则文件。开发中的 1.0 入口还会迁移并校验认知层、安装项目指引和启动运行时；重复执行保留已有 Context、忽略规则及禁用策略。

### 3. 保存第一个工作状态

```bash
ctx checkpoint \
  --title "支付回调修复" \
  --progress "已定位签名校验失败原因" \
  --completed "复现问题,确认失败边界" \
  --pending "补充回归测试,运行集成测试" \
  --decisions "在回调入口统一执行签名校验" \
  --risks "第三方回调可能重复到达" \
  --files "src/payment/callback.ts,test/payment/callback.test.ts"
```

第一次包含实际结构化内容的 checkpoint 会创建 baseline Snapshot；后续变化会创建 patch Snapshot。

- 内容没有变化时返回 `status: "no_change"`。
- 默认两次实际写入之间至少间隔约 10 秒；变化过快时返回 `status: "rate_limited"` 和 `retryAt`。
- 只有标题、没有实际结构化内容的 checkpoint 不会创建无意义 Snapshot。
- `--last-error ""`、空列表等显式输入可以清理已有字段。

查看当前状态：

```bash
ctx status
ctx resume --max-chars 2000
```

### 4. 在下一次会话开始时恢复

```bash
ctx orient "支付回调签名校验" --max-chars 4000
```

不带查询时只恢复当前任务和 open Note：

```bash
ctx orient
```

## 推荐工作流

```text
Orient → Plan → Implement → Verify → Handoff
```

1. **Orient**：开始任务时读取当前 Context 和已验证共识。
2. **Plan**：先形成可执行的实现计划。
3. **Implement**：遇到重要观察、阻塞或临时决策时记录 Note。
4. **Verify**：运行适用的测试、构建或其他检查。
5. **Handoff**：阶段结束时显式执行一次 checkpoint，记录完成项、待办、决策和风险。

Hook 只提供有界、只读的阶段提示，不会自动创建 Note 或 checkpoint。Runtime 捕获文件和 Git metadata，也不能替代 Agent 主动记录任务认知。

## 核心命令

### `ctx orient`

`orient` 是新会话和新任务的快速恢复入口：

```bash
ctx orient "身份认证回调" \
  --scope project \
  --max-chars 4000 \
  --knowledge-limit 5 \
  --deadend-limit 5 \
  --note-limit 10
```

它返回：

- 当前 Context 和 Snapshot 的有限 metadata；
- 受字符预算限制的进度、错误、完成项、待办、决策、风险和关联文件；
- 匹配且适用的已验证 Knowledge 和 Deadend；
- 当前 Context 尚未吸收的 open Note；
- v1/v2 选择方式、排除计数和截断说明。

`orient` 是只读操作：不会创建 Snapshot、不会写入 Context、不会更新 `lastUsedAt`，也不会隐式记录 usage feedback。

返回 `status: "no_context"` 表示项目已初始化，但还没有可恢复的有效 Context；这不是系统错误。

### `ctx compile`

`compile` 面向需要结构化输入的 Agent、适配器和集成方，返回 provider-neutral JSON Manifest：

```bash
ctx compile "修复支付回调" --max-chars 4000
ctx compile "验证签名逻辑" --scenario verification --paths src/payment/callback.ts
ctx compile "查看最近修改" --activity-limit 10 --max-chars 4000
```

Manifest 主要包含：

- `intent`：规范化后的任务意图、场景、scope、paths 和预算；
- `selected`：最终纳入的候选项；
- `sections`：按 Context、Snapshot、Note、Knowledge、Deadend、Activity 等来源分组；
- `excluded`：未纳入项目及其原因；
- `provenance`：来源 Context、Snapshot、journal event 和读取状态；
- `budget`：请求、使用、剩余字符和 section 统计；
- `truncation`：预算或候选限制造成的截断说明；
- `identity`：Manifest hash、选中 item hash 和 estimated token；
- `text`：最终有界文本。

0.8.0 的候选项提供：

```text
level: signal | summary | structured | evidence
itemHash
 tokenEstimate
expandable
```

当前实际生成的候选项默认是 `summary` 层。`itemHash`、`manifestHash` 和 estimated token 可用于缓存、去重、审计和结果校验；token 是按字符估算的 provider-neutral 数值，不是真实 Provider 计费结果。

### `ctx expand`

`expand` 只接受本次 `compile` 返回的 selected candidate，并重新使用原始编译参数校验 `manifestHash`。调用方至少提供 `--candidate-id` 或 `--item-hash`，并选择 `--level structured|evidence`：

```bash
ctx compile "修复支付回调" --max-chars 4000 > manifest.json
ctx expand --manifest-hash <manifestHash> --candidate-id <candidateId> \
  --level structured --compile-max-chars 4000 --query "修复支付回调"
```

`--compile-max-chars` 必须与原始 compile 的预算一致；`--max-chars` 是独立的展开输出预算。展开返回 `complete` 时包含完整 structured content，超过预算则返回有界文本、`content: null` 和 `status: partial`。它不缓存 Manifest、不写入 Context/journal/projection、不执行 usage feedback，也不读取文件正文、diff、命令或 stdout/stderr。

Compiler 具有以下边界：

- 相同输入得到确定性的排序、截断和 hash；
- `maxChars` 使用 JavaScript UTF-16 字符串长度；
- 不调用模型；
- 不写入 Context 或 journal；
- 普通查询默认只纳入适用且已验证的 Knowledge 和 Deadend；
- `context_expand` 只读取已选候选的安全 metadata，不读取任意项目文件内容。

#### 显式 Recipe 与证据图

Recipe 仅在调用方明确传入已验证或已发布的 `--recipe-id` 时参与编译：

```bash
ctx compile "验证签名逻辑" --recipe-id <recipe-id> --max-chars 4000
```

Recipe 是受限的声明式 source/section 偏好与预算，不执行文本、不读取文件、不替换核心排序，也不会被自动选择。未传入 `--recipe-id` 时，编译保持既有默认行为和兼容身份契约。Recipe 状态、内容或适用性改变后，旧的 Recipe Manifest 不能继续用于展开，必须重新 `compile`。

可选 `--graph-hops 0|1|2` 让证据图在已经通过治理和词法检索的候选项之间进行有界排序：

```bash
ctx compile "验证签名逻辑" --graph-hops 1 --max-chars 4000
```

图不会生成图专属候选、不会绕过适用性或隐私过滤，也不会读取项目源文件。图投影不可用、无效或没有种子时，编译会明确说明 fallback 原因并回退到词法排序；`0` 表示不遍历图。展开时必须重传原始 `recipeId`、`graphHops` 与其他 compile 参数，Manifest hash 校验仍然有效。

### `ctx usage report`

`usage report` 适合每周或每月复盘，不需要为每条 prompt 调用。它是只读的，基于 v1 文件和 v2 journal 派生统计，不创建事件、不修改 Context、Snapshot、Note 或 projection：

```bash
ctx usage report --days 30
ctx usage report --month 2026-08 --granularity week
ctx usage report --since 2026-08-01T00:00:00.000Z \
  --until 2026-09-01T00:00:00.000Z \
  --baseline-tokens 12000 --baseline-source manual
ctx usage report --format ascii
```

默认输出稳定 JSON；`--format ascii` 仅输出终端仪表盘。报告展示资产总量和窗口增量、verified Knowledge/Deadend、显式 `record.used` reuse、orient/compile/expand/resume 操作统计、趋势以及上下文输出投入。

报告中的 `chars / 4` 是 `estimated` token，不是真实 Provider token；Provider token 和计费金额当前为 `unavailable`。没有显式 `--baseline-tokens` 时，不会虚构 estimated savings、ROI 或 payback；查询命中、候选选择和编译纳入也不等于 reuse，只有显式 `record.used` 事件才计入复用。报告不替代 `ctx doctor`、`ctx journal verify` 或 Knowledge/Deadend 的人工治理。

## Knowledge、Deadend 和 Note

### Knowledge：记录可复用认知

```bash
ctx learn "支付回调必须验证网关签名" \
  --scope project \
  --evidence "src/payment/callback.ts,回归测试"
```

新记录默认是 `candidate`，不会进入普通检索。确认后才会进入默认发现：

```bash
ctx knowledge verify <knowledge-id>
ctx knowledge discover "支付回调"
```

治理已有记录：

```bash
ctx knowledge deprecate <knowledge-id> --reason "已被新的签名校验流程取代"
ctx knowledge reject <knowledge-id> --reason "证据不足"
```

普通 `orient` 和 `discover` 默认只使用 `verified` 且适用的 Knowledge。需要审查候选或其他状态时，使用 `--all` 或显式 `--status`。

### Deadend：记录已验证不可行方案

```bash
ctx deadend \
  --attempt "绕过回调签名验证" \
  --reason "回归测试失败且会引入安全风险" \
  --scope project \
  --evidence "test/payment/callback.test.ts"
```

确认和治理：

```bash
ctx deadend verify <deadend-id>
ctx deadend obsolete <deadend-id> --reason "当前架构已不再适用"
ctx deadend reject <deadend-id> --reason "失败证据不足"
```

Deadend 默认也是 `candidate`；只有 `verified` Deadend 才会进入普通检索。终态记录会保留治理原因，但不会默认注入。

### Note：低成本记录过程信息

Note 不创建 Snapshot，适合开发过程中记录短期观察、问题、行动和决策：

```bash
ctx note add "测试环境缺少回调凭据" \
  --kind problem \
  --context <context-id>

ctx note add "保留原始请求体后再执行验签" \
  --kind decision \
  --status resolved \
  --context <context-id>
```

查看 Note 和只读 Activity：

```bash
ctx note list --context <context-id> --open
ctx activity --context <context-id> --open
```

阶段性 checkpoint 可以显式吸收当前 Context 的 open Note：

```bash
ctx checkpoint \
  --context <context-id> \
  --progress "完成阶段排查" \
  --absorb-notes
```

只有真正保存了新 Snapshot 时 Note 才会被标记为已吸收；`no_change` 和 `rate_limited` 不会改变 Note。

## Evolution、Skill 与 Recipe

0.8.0 的 Evolution 是显式、确定性且仅使用已授权 metadata 的工作流：

```text
Experience metadata → explicit proposal → explicit acceptance
                    → Skill / Recipe materialization → governed lifecycle
```

`ctx evolution propose` 只从有界的 journal、Git/workspace metadata 和显式 `record.used` 信号生成候选；不会读取源文件、原始 prompt、Note 内容或 Snapshot 内容。它不自动运行，也不会创建 checkpoint、接受 Proposal、验证/发布 Skill 或 Recipe、调用 Skill，或改变默认编译策略。

```bash
ctx evolution propose --recent-limit 32 --target-kind skill
ctx evolution list
ctx evolution inspect <proposal-id>
ctx evolution accept <proposal-id> --rationale "人工审查来源与边界"
ctx evolution verify <proposal-id> --rationale "确认候选可进入后续物化"
ctx evolution supersede <proposal-id> \
  --rationale "由新提案替代" --supersedes proposal:<predecessor-id>
```

所有 Proposal、候选工件、Skill、Recipe、调用和状态变化都追加到 v2 journal。修订通过 `supersedes` 保留前任与继任谱系，不覆盖或删除历史记录。接受 Proposal 只生成候选工件；Skill 或 Recipe 还必须显式 materialize 并经过各自的生命周期治理。

Skill 生命周期为 `candidate → verified → published → deprecated|superseded`（也可以从 candidate 终止）。只有 `published` Skill 可记录调用；调用只保存调用方 event ID 与输入 hash，不保存原始输入。每次调用恰好允许一个终态 outcome：`success`、`failure`、`partial`、`irrelevant` 或 `unknown`。Skill procedure 是可审查文本，不会由 Runtime、Compiler 或 MCP 自动执行。

Recipe 使用同样的 `candidate → verified → published → deprecated|superseded` 治理。它只在 `ctx recipe materialize` 后存在，并且只有显式 `--recipe-id` 才能影响一次 `compile`；候选、未验证、终态或不适用 Recipe 会被拒绝，不会静默回退到其它 Recipe。


完整参数请使用 `ctx <command> --help`。常用命令按用途分组如下。

### 日常使用

| 命令 | 用途 |
| --- | --- |
| `ctx init` | 初始化 `.context/` |
| `ctx checkpoint` | 保存 Context Snapshot |
| `ctx resume` | 恢复完整 Context 详情 |
| `ctx orient` | 读取有界任务上下文 |
| `ctx compile` | 生成结构化 Context Manifest |
| `ctx note add/list` | 记录和查看 Note |
| `ctx activity` | 查看只读 Note/Snapshot 时间线 |
| `ctx status` | 查看项目和 Context 索引 |
| `ctx doctor` | 检查文件和 Snapshot 完整性 |

### Knowledge 与 Deadend 治理

```text
ctx learn
ctx knowledge
ctx knowledge discover
ctx knowledge verify
ctx knowledge deprecate
ctx knowledge reject
ctx deadend
ctx deadends
ctx deadend verify
ctx deadend obsolete
ctx deadend reject
ctx feedback use
```

`feedback use` 只记录显式的使用信号，用于确定性排序；不会改变 Knowledge/Deadend 的验证状态、confidence、证据或适用性。

### 集成入口

```text
ctx integrate claude inspect
ctx integrate claude install
ctx integrate claude install --apply
ctx hook claude-code session-start
ctx hook claude-code user-prompt
ctx agent serve
```

### 高级维护

```text
ctx migrate v1 --dry-run
ctx migrate v1 --apply
ctx migrate verify
ctx journal verify
ctx runtime enable
ctx runtime disable
ctx runtime start
ctx runtime stop
ctx runtime status
ctx filesystem enable
ctx filesystem disable
ctx filesystem status
```

CLI 业务命令默认输出 JSON；`--help` 是面向终端用户的纯文本；错误写入 stderr 并返回非零退出码；`ctx --version` 输出 JSON 字符串。

## 文件活动与 Runtime

文件观察默认关闭，需要显式开启：

```bash
ctx filesystem enable
ctx filesystem status
ctx filesystem disable
```

观察器只记录经过过滤的项目相对路径和有限 metadata，例如文件类型、大小和修改时间：

- 不记录文件内容、diff、命令或 stdout；
- 使用与 Context 关联文件相同的 `.contextignored` 和内置保护规则；
- `ctx compile` 的 `activity` 只表示“观察到文件发生变化”，不表示文件已被读取、理解或测试；
- `--activity-limit 0` 只关闭单次编译中的 activity 候选，不改变监听策略；
- v1 fallback 没有等价的文件活动来源，因此 activity section 可能为空。

完成 v1 迁移并启用 Runtime 后，Runtime 会服务于当前项目的 v2 journal、Git 观察和可选文件观察。常用控制命令：

```bash
ctx runtime status
ctx runtime enable
ctx runtime start
ctx runtime stop
ctx runtime disable
```

已启用项目的 CLI Orient、MCP 和 Claude Hook 会尽力自动唤醒 Runtime；启动失败不会阻塞基础读取流程。`runtime disable` 会持久化关闭自动启动，直到再次执行 `runtime enable`。

## Claude Code 集成

先检查当前项目：

```bash
ctx integrate claude inspect
```

默认安装命令只输出预览，不写文件：

```bash
ctx integrate claude install
```

确认后显式应用：

```bash
ctx integrate claude install --apply
```

集成会幂等合并项目本地：

- `.claude/settings.json`：`SessionStart` 和 `UserPromptSubmit` Hook；
- `.mcp.json`：名为 `fluffy-context` 的 stdio MCP server。

它会保留无关的 Hook、权限和 MCP server；遇到无效 JSON、无效结构或同名冲突时拒绝覆盖。Hook 是 fail-open 的只读提示，不会自动创建 checkpoint 或 Note。

## MCP 集成

启动 MCP stdio server：

```bash
ctx agent serve
```

0.8.0 当前暴露以下 23 个工具：

```text
context_orient            只读、有界地获取任务上下文
context_expand            只读地展开 selected compiler candidate
context_compile           只读地生成确定性 Manifest
context_resume            恢复 Context（可能更新 lastUsedAt）
context_note_list         只读地列出 Note
context_note_add          显式新增 Note
context_usage_report      只读统计上下文使用情况
recipe_list               只读列出 Recipe
recipe_inspect            只读检查 Recipe
recipe_materialize        从已接受候选显式物化 Recipe
recipe_transition         显式追加 Recipe 生命周期变化
skill_list                只读列出 Skill
skill_inspect             只读检查 Skill
skill_materialize         从已接受候选显式物化 Skill
skill_transition          显式追加 Skill 生命周期变化
skill_record_invocation   为已发布 Skill 记录输入 hash
skill_record_outcome      为调用追加唯一终态 outcome
evolution_propose         从授权 metadata 显式生成候选 Proposal
evolution_list            只读列出 Proposal
evolution_inspect         只读检查 Proposal
evolution_accept          显式接受 Proposal 为候选工件
evolution_transition      显式追加 Proposal 生命周期变化
context_checkpoint        显式保存 Context/Snapshot
```

`context_compile` 和嵌套的 `context_expand.compile` 可接收 `recipeId` 与 `graphHops: 0|1|2`。Evolution、Skill 和 Recipe 的读操作不逻辑创建用户可见认知记录；写操作始终必须显式调用。
输入字段与 CLI/Agent API 对齐：

- `context_orient`：`path`、`contextId`、`query`、`scope`、`maxChars` 和各 source limit；
- `context_compile`：编译选项，包括可选 `recipeId` 与 `graphHops: 0|1|2`；
- `context_expand`：`manifestHash`、`candidateId` 或 `itemHash`、`level`、独立 `maxChars` 和原始 `compile` 参数（包含原始 Recipe/图选项）；
- `context_resume`：`contextId`、`maxChars`、`includeDetails`、`query`、`scope`；
- `context_note_list`：`contextId`、`openOnly`、`limit`、`maxChars`；
- `context_note_add`：必填 `message`，以及 Note 的 `kind`、`actor`、关联 Context/Snapshot、`relatedFiles` 和 `status`；
- `context_checkpoint`：Context 输入字段、`absorbNotes` 和可选的 `lastError`；
- `evolution_propose`：可选 `eventIds` 或 `recentLimit`，以及 `targetKind: skill|compiler-recipe`；`evolution_accept` 与 `evolution_transition` 均要求非空 rationale；
- `skill_*` 与 `recipe_*`：只接受受治理的候选与追加式生命周期输入，不执行 Skill procedure 或 Recipe 内容。

成功调用同时返回 JSON `content` 和 `structuredContent`。结果分别对应 CLI/Agent API 的 Manifest、load result、Note 列表、单个 Note 或 checkpoint result。Checkpoint 保留 `saved`、`no_change` 和 `rate_limited` 状态，MCP 不自动重试，也不暴露绕过限流的参数。

读写边界如下：

- `context_orient`、`context_expand`、`context_compile`、`context_note_list`、`context_usage_report`、`evolution_list`、`evolution_inspect`、`skill_list`、`skill_inspect`、`recipe_list` 和 `recipe_inspect` 是逻辑只读操作；
- `context_resume` 使用现有 `loadContext` 语义，可能更新 `lastUsedAt`，但不会创建 Snapshot；
- `context_note_add` 会写入 Note，但不会创建 Snapshot；
- `context_checkpoint` 会创建或更新 Snapshot、Context metadata 和 index，并可显式吸收 Note；
- `evolution_propose`、`evolution_accept`、`evolution_transition`、`skill_*` 写工具和 `recipe_*` 写工具都是显式的追加写入；没有工具会自动接受、验证、发布、物化、调用或执行 Skill/Recipe；
- 任何工具都不会自动创建 Knowledge、Deadend、feedback 或重复 checkpoint。

MCP 的 stdin/stdout 属于协议通道，不能混入日志或交互文本。调用错误（包括输入验证、缺失 Context、空 Note message 和 stale Manifest hash）返回单次工具错误，server 继续运行。`context_expand` 与 CLI/Agent API 使用相同的无状态 Manifest hash 校验和 partial 预算语义。

## TypeScript Agent API

使用公开包入口，不要导入内部 `dist/...` 路径，也不要直接读写 `.context`：

```ts
import {
  contextOrient,
  compileContext,
  contextExpand,
  saveContext,
  loadContext,
  searchContext,
} from 'fluffy-context';

const orientation = await contextOrient(process.cwd(), {
  query: 'payment callback',
  maxChars: 2400,
});

const manifest = await compileContext(process.cwd(), {
  query: 'payment callback',
  maxChars: 4000,
});
```

`fluffy-context/agent` 提供相同的公开入口。当前主要 API 包括：

```text
contextOrient
compileContext
contextExpand
saveContext
loadContext
searchContext
recordContextUse
proposeContextEvolution
listContextEvolutionProposals
inspectContextEvolutionProposal
acceptContextEvolutionCandidate
transitionContextEvolutionProposal
```

Compiler identity 工具也通过公开入口导出：

```text
canonicalJson
contentHash
estimateTokens
rebuildManifestHash
validateManifestIdentity
```

存储布局不是公开兼容性承诺；调用方应根据返回结果处理 `status`、预算、截断和 fallback 信息。

## 安全与隐私边界

### `.contextignored`

`.contextignored` 使用接近 `.gitignore` 的规则排除不应作为关联文件保存的路径：

```gitignore
private/
*.generated.ts
notes/draft-*
```

内置保护规则优先于项目规则，不能通过否定规则绕过。默认排除包括：

- `.context/`、`.git/`；
- `node_modules/`、`dist/`、`build/`、`coverage/` 等依赖和构建目录；
- `.env`、`.env.*`；
- `*.pem`、`*.key`、`*.p12`、`*.pfx`；
- 常见 credential、secret、token 文件；
- 绝对路径和 `..` 越界路径。

### 持久化边界

- checkpoint、Note、Knowledge 和 Deadend 会保存用户显式提供的结构化任务文本；
- 文件观察只保存过滤后的相对路径和 metadata，不保存内容或 diff；
- Claude Hook 不保存原始 prompt，只在具备稳定标识时保存限长、脱敏后的 intent；
- Runtime 仅绑定 `127.0.0.1`，使用项目本地能力令牌进行 IPC；令牌不会出现在状态输出或事件日志；
- 集成、Runtime 或 v2 读取失败时，支持回退的宿主流程保持 fail-open。

## v1 迁移

已有 v1 `.context/` 数据时，先只读检查，再显式导入：

```bash
ctx migrate v1 --dry-run
ctx migrate v1 --apply
ctx migrate verify
```

- `--dry-run` 只检查，不创建 v2 数据；
- `--apply` 才会追加 v1 provenance 事件；
- 迁移不会重写或修复 v1 文件；
- v1 与 v2 可以并存；
- v2 不可用、损坏或尚未同步时，支持回退的读取接口继续使用 v1 行为；
- `ctx journal verify` 可验证 v2 journal 的 hash chain 和记录完整性。

## 常见问题

### `ctx orient` 返回 `no_context`

项目已初始化，但还没有包含实际内容的有效 checkpoint。运行：

```bash
ctx checkpoint --title "当前任务" --progress "记录当前进度"
```

### checkpoint 返回 `rate_limited`

这是默认写入保护，不是保存损坏。查看返回的 `retryAt`，完成更多阶段工作后再保存，不要循环重试。

### 为什么文件没有进入 Snapshot 的 `relatedFiles`

先检查 `.contextignored` 和内置保护规则。敏感、构建、依赖、绝对路径和越界路径会被排除，即使使用否定规则也不能绕过。

### Context 找不到怎么办

确认当前项目路径和 Context ID，然后运行：

```bash
ctx status --path path/to/project
ctx doctor --path path/to/project
```

Git branch/ref 漂移通常是提示，不等于 Context 被删除。

### 为什么 `--help` 不能用 JSON.parse

输出类型不同：

- `ctx --help`：纯文本；
- `ctx --version`：JSON 字符串；
- 业务命令：格式化 JSON；
- 错误：stderr 和非零退出码。

### Windows 下从 Node 子进程调用 `ctx`

交互式终端通常可以直接运行 `ctx`。从 Node `spawn` 或其他程序调用时，Windows npm 可能需要使用 `ctx.cmd`；不要把未经转义的用户输入拼接进 shell 命令。

## 开发与验证

```bash
npm install
npm run build
npm test
npm run pack:check
npm pack --dry-run --json
```

发布包通过 `fluffy-context` 和 `fluffy-context/agent` 提供公开 Agent API，并包含 CLI、类型声明、README、LICENSE 和 `skills/fluffy-context/SKILL.md`。

## 未来方向

以下方向仍属于后续版本：

| 方向 | 目标 |
| --- | --- |
| Context expansion | 在现有 `context_expand` 基础上继续完善更丰富的分层内容 |
| 证据图深化 | 在当前有界 metadata 图之外评估更丰富、可解释的关联，但不引入不透明推断 |
| Knowledge Evolution | 扩展已存在的候选、谱系和人工治理流程，不引入自动发布 |
| Journal maintenance | 提供安全的清理、归档和长期运行维护能力 |
| Usage reporting | 继续完善估算 token、编译、展开、检索和反馈覆盖情况 |
| 外部协作 | 远程同步、多人协作和团队权限 |

这些方向不会改变当前的边界：Git、项目文档和宿主规则继续由各自系统负责；Candidate 仍需要显式治理；模型调用和远程服务不是核心 Runtime 的隐式依赖。

## License

MIT
