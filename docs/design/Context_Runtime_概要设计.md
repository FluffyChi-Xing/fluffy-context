# Context Runtime 概要设计

## 1. 文档说明

- **状态**：Draft
- **依据**：[Context Runtime（产品构想）](../overview/Context_Runtime_Product_Proposal.md)
- **目标**：定义 Context Runtime 的 MVP 架构、数据与工作流边界，为后续 CLI、Agent Skill、IDE Extension 的实现提供统一约束。

本文描述的是 AI 工作状态的运行时基础设施；不定义具体数据库、模型供应商或 IDE 插件协议。CLI 的 Node.js 版本、运行时依赖和跨平台边界在第 15 节定义。

------------------------------------------------------------------------

## 2. 背景、目标与非目标

### 2.1 背景：从会话交接到项目共识

AI 编程的核心瓶颈不只是代码生成能力，而是 AI 每次开始工作时都必须重新建立项目上下文。当前信息分散在代码、文档、测试、历史对话和个人经验中，AI 往往需要重复搜索、判断和验证，才能回答两个本应已经明确的问题：

1. 这个项目已经有哪些可复用的业务能力和流程？
2. 当前需求是在新增能力，还是应该复用并扩展已有能力？

Git 保存代码和真实变更，IDE 保存工作区，但它们不能表达 AI 工作过程中的业务结论、设计原因、待办、风险，也不能将已经验证的业务流程沉淀为可检索、可复用的项目共识。单纯保存一次会话的进度，只能解决“昨天做到哪里”，不能解决“今天是否又重复实现已有功能”。

因此，Context Runtime 的定位需要从单纯的 **Working Context** 保存器扩展为 **Project Consensus Runtime**：

- **Context** 保存一次任务的短期工作状态，用于会话交接和恢复。
- **Consensus Knowledge** 保存项目长期有效的业务规则、能力、流程、约束和实现证据。
- **Intent Resolver** 将自然语言需求识别为业务意图，并匹配已有的项目共识，给出复用、扩展、组合或新增的建议。

例如，需求中提到“投保人认证”时，Runtime 应能识别该意图已经对应项目中的认证流程，并明确短信验证码、证件 OCR、第三方人脸识别等步骤可以复用；AI 的任务应转为接入新场景和实现差异，而不是重新开发整套认证流程。

### 2.2 目标

本项目的目标是建立一层平台无关、local-first、可演进为服务的项目共识基础设施，让 AI 基于项目共识开发，而不是每次重新学习项目。

具体目标如下：

- 提供可靠的本地 Context Runtime，通过 `checkpoint`/`resume` 保存和恢复任务级工作状态。
- 将业务知识从代码和文档中提炼为结构化、可检索、带来源、作用域、证据和生命周期的共识资产。
- 逐步支持业务能力、流程、规则、约束、第三方集成和可复用实现之间的结构化关系。
- 在需求开始阶段识别业务意图，匹配已验证的共识知识，并输出复用计划、需要扩展的差异、禁止重复建设的内容和待确认问题。
- 将一次成功的复用、验证和开发结果沉淀回知识库，使共识持续演化，而不是只读的静态文档。
- 通过摘要、分层加载、作用域匹配和按需详情显著减少 Agent 重复阅读项目所消耗的 Token。
- 将失败路径与有效共识隔离，避免历史探索和错误方案污染新的开发上下文。
- 在输入规范化、敏感路径过滤、原子写入、Snapshot 校验和只读诊断方面保持数据安全与可恢复性。
- 让 Human CLI、Agent Skill/SDK、IDE Extension 和未来的远端服务共享同一套 Runtime 协议和治理规则。

### 2.3 非目标

当前 M0/MVP 不承担以下职责：

- 替代 Git、源代码仓库、项目文档、长期用户记忆或通用企业知识库。
- 保存完整源文件副本、完整聊天记录、终端环境变量或敏感凭据。
- 让未验证的模型推断直接成为项目共识，或允许 Agent 绕过来源、证据和治理流程。
- 将所有历史 Context 全量注入 Prompt；默认只返回与当前任务相关的摘要和匹配结果。
- 依赖特定模型供应商、在线服务、向量数据库、Docker、特定 IDE 或特定操作系统才能完成核心保存和恢复。
- 在本地运行时阶段直接解决跨设备同步、多人权限、远端审计、自动冲突合并和组织级知识治理。
- 用隐式清理或自动迁移覆盖历史不可变 Snapshot；历史数据修复必须通过显式、可审计的迁移或 repair 流程完成。

### 2.4 分阶段交付边界

| 阶段 | 核心交付 | 明确不做 |
| --- | --- | --- |
| M0：可靠上下文闭环 | 本地初始化、结构化 checkpoint/resume、baseline/patch、Git 锚定、摘要预算、安全过滤和诊断。 | 自动总结、意图识别、复杂知识检索、远端服务。 |
| MVP：可治理知识闭环 | Knowledge/Deadend 生命周期、来源和证据、作用域匹配、确定性搜索、输入规范化、冲突诊断和复用记录。 | 多人权限、向量检索、自动 Context merge。 |
| Consensus Runtime：共识服务 | Capability/Workflow 等可复用资产、Intent Resolver、发现结果、复用计划、使用反馈和知识演化。 | 核心协议绑定单一模型或单一云平台。 |
| 后续服务化 | stdio/HTTP/MCP 适配、团队共享、远端同步、组织级治理和可选语义检索。 | 将在线服务作为本地 CLI 的运行前置条件。 |

自动总结、意图识别和语义检索都是可插拔的上层能力。Runtime 必须负责输入边界、输出 Schema、来源追踪、预算、持久化和治理；模型或检索适配器可以由 Agent、IDE 或未来的服务端提供。即使总结器或在线服务不可用，显式结构化进度和已确认共识仍必须能够保存和查询。

------------------------------------------------------------------------

## 3. 术语与核心对象

| 术语 | 含义 |
| --- | --- |
| Project | 由 Git 根目录优先确定的 Context Runtime 作用范围。 |
| Context | 可加载、搜索、更新、归档的 AI 工作状态单元。 |
| Checkpoint | 从当前工作状态采集并写入 Context 的一次操作。 |
| Resume | 为当前项目和 Git 状态选择并加载 Context 的操作。 |
| Snapshot | Context 在特定时间点的不可变内容版本；默认由父 Snapshot 与增量变更集重建。 |
| Patch / Change Set | 相对父 Snapshot 的工作状态差异，不是完整项目文件树。 |
| Manifest | `.context/manifest.json` 中保存的项目级格式与初始化元数据。 |
| Effective Ignore Rules | 内置不可覆盖保护规则与项目 `.contextignored` 合并后的有效规则。 |
| Knowledge | 带来源、作用域、证据和置信度的可复用业务事实或规则。 |
| Deadend | 带失败证据、适用条件和状态的不可行路径记录，默认不注入。 |
| Candidate | 尚未经过用户确认或充分证据验证的 Knowledge/Deadend。 |
| Verified | 已经由用户确认或明确证据支持、可进入匹配加载范围的对象状态。 |
| Scope | 对象适用的项目、模块、路径、分支、任务或依赖版本范围。 |
| Handoff Summary | 面向下一次会话的限长交接班摘要，而非完整历史。 |

Context 保存工作进度、决策原因、风险、TODO、讨论结论和关联文件等摘要；不等同于任意 Markdown 文件集合。

------------------------------------------------------------------------

## 4. 总体架构

```text
Human CLI                 Agent Skill / SDK                 IDE Extension
    │                            │                               │
    └────────────────────────────┴───────────────┬───────────────┘
                                                   ▼
                                        Context Runtime Core
                                                   │
       ┌───────────────┬──────────────┬───────────┼───────────────┬──────────────┐
       ▼               ▼              ▼           ▼               ▼              ▼
Project Resolver   Git Adapter  Capture Pipeline  Resume Selector  Lifecycle   Storage
                                               │                    Manager    Adapter
                                               ▼
                                       Ignore Rule Engine
                                               │
                         ┌─────────────────────┴─────────────────────┐
                         ▼                                           ▼
                 Knowledge Extractor                           Deadend Classifier
                         │                                           │
                         └──────────────────┬────────────────────────┘
                                            ▼
                                    Context Composer
```

### 4.1 分层职责

- **入口层**：CLI、Skill/SDK 与 IDE Extension 仅负责交互和调用，不直接操作内部存储文件。
- **Runtime Core**：执行参数校验、生命周期约束、采集与恢复编排、错误处理和审计事件生成。
- **Project Resolver**：确定项目根目录，优先使用 Git root；非 Git 项目是否支持留作后续决策。
- **Git Adapter**：读取 branch、commit、工作区变更与可追溯关系，不修改 Git 状态。
- **Capture Pipeline**：根据规则筛选候选内容，生成去敏后的工作状态摘要。
- **Ignore Rule Engine**：计算有效忽略规则并解释路径被排除的原因。
- **Resume Selector**：按当前环境为 `ctx resume` 选择候选 Context。
- **Lifecycle Manager**：维护 Context 状态转换及归档、恢复、删除约束。
- **Storage Adapter**：保存 Context、Snapshot、Knowledge、Deadend 与可重建索引，提供并发互斥。
- **Knowledge Extractor**：从用户确认内容、结构化决策和工作证据中提炼候选 Knowledge，保留来源、作用域和置信度，不直接晋升为 Verified。
- **Deadend Classifier**：区分普通错误、尚未成功的尝试与有证据的不可行路径，生成 Candidate Deadend 并管理其失效条件。
- **Context Composer**：为 Resume 组合当前工作状态、匹配的 Verified Knowledge 和有限 Deadend 提示，生成 Handoff Summary 与按需详情句柄。

------------------------------------------------------------------------

## 5. Context 数据模型与开放 Schema

### 5.1 元数据

每个 Context 至少包含：

```text
id
schemaVersion
title
branch
commit
createdAt
updatedAt
lastUsedAt
usageCount
status
tags
dependencies
```

其中：

- `id` 在项目范围内唯一。
- `schemaVersion` 用于显式管理数据格式演进。
- `branch`、`commit` 是创建或更新时采集的 Git 锚点，可以为空，但必须标明其缺失原因。
- `status` 只能取生命周期章节定义的状态。
- `dependencies` 只引用同一项目中的 Context ID；无效引用由 `ctx doctor` 报告。

### 5.2 Snapshot 版本模型

Context 采用 Git-like 的版本语义，但不保存代码仓库的完整副本：

```text
Base Snapshot → Patch Snapshot → Patch Snapshot → Rebased Base Snapshot
```

每个 Snapshot 必须记录：

```text
snapshotId
parentSnapshotId
baseSnapshotId
changeSet
contentHash
rebuildHash
createdAt
```

默认保存相对父 Snapshot 的 `Patch / Change Set`。未变化文件不重复写入完整文件树或完整摘要，只保留必要的路径、状态和内容哈希。以下情况才允许写入完整基线：

- Context 的首次 Snapshot。
- 用户显式请求全量基线。
- Patch 超过大小阈值或链长度达到上限，需要压缩重建。
- 父 Snapshot 不可用且必须建立新的可恢复基线。

`changeSet` 中的文件关联至少包含规范化路径、变更状态、父/当前内容哈希、关键代码段摘要、采集时间和 `contentExcluded`。它不保存完整源文件；`sourceSnapshots` 仅表示摘要、有限差异片段或结构化工作状态快照。

任意可 Resume 的 Snapshot 都必须能从基线和 Patch 链重建，并通过 `rebuildHash` 校验。Patch 基线不匹配、应用失败或哈希校验失败时，Snapshot 只能作为诊断 Draft，不能转为 Active。

## 5.3 内容结构

MVP 的 Context 内容使用结构化字段表达，而非只保存自由文本：

```text
progress_summary
last_error
summary
progress
pendingTasks
decisions
risks
todos
discussionConclusions
relatedFiles
relatedModules
sourceSnapshots
```

`progress_summary` 和 `last_error` 是默认 Resume 载荷；其余内容可被 Runtime 按需展开。`relatedFiles` 默认保存路径、变更摘要、状态和哈希，不保存完整文件副本。被排除的文件可以保留路径和 `contentExcluded: true` 标记，但不得保存其原始内容。

### 5.4 Knowledge 数据模型

```text
knowledgeId
kind                  # domain_rule | architecture_rule | workflow | convention | fact
statement
scope                 # project | module | path | branch | task | dependency
confidence
status                # candidate | verified | deprecated | rejected
sourceContextIds
sourceSnapshotIds
supportingEvidence
constraints
createdAt
updatedAt
lastValidatedAt
```

Knowledge 必须带来源、作用域、证据和验证时间。`learn` 默认只创建 `candidate`；用户确认或有明确可审计证据后才能转为 `verified`。与已有 Knowledge 冲突时保留候选并报告冲突，不静默覆盖旧结论。`deprecated` 或作用域不匹配的 Knowledge 不进入默认 Resume。

### 5.5 Deadend 数据模型

```text
deadendId
attempt
reason
observedEvidence
scope
relatedFiles
relatedKnowledgeIds
status                # candidate | verified | obsolete | rejected
sourceContextId
sourceSnapshotId
createdAt
updatedAt
```

`last_error` 只表示当前工作状态的最近错误；Deadend 表示在明确条件下已验证不可行的路径，二者不能互相替代。一次失败或“尚未成功”不能自动成为 `verified` Deadend。环境、依赖或前置条件变化后可能重新可行的路径应标记 `obsolete` 或限制其 Scope。

默认加载策略：

| 对象 | 默认 Resume | 普通搜索 | 详细加载 |
| --- | --- | --- | --- |
| Context | 当前 Active/Stable | 是 | 当前任务或显式请求 |
| Verified Knowledge | 仅加载作用域匹配项 | 是 | 显式请求来源和证据 |
| Candidate Knowledge | 否 | 仅显式查询 | 显式请求 |
| Verified Deadend | 否，仅显示匹配数量或句柄 | 默认不混入 | 相似方案评估或用户明确请求 |
| Candidate/Rejected/Obsolete | 否 | 默认不混入 | 仅治理诊断 |

### 5.6 Schema 原则

- Schema 公开且带版本号，允许不同入口对同一对象读写。
- 内容字段可以扩展，但未知字段必须保留，避免低版本客户端静默丢失数据。
- `progress_summary`、`last_error`、Handoff Summary 和检索索引是可重建的派生字段，不能成为唯一业务数据来源。
- Snapshot 是不可变版本；更新必须创建新 Snapshot，不得原地修改历史版本。
- Context 生命周期状态与 Snapshot 版本历史正交；Knowledge/Deadend 另有独立可信度生命周期。

------------------------------------------------------------------------

## 6. 生命周期与状态机

```text
Draft → Active → Stable → Archived → Deleted
```

| 状态 | 含义 | 默认 Resume 候选 |
| --- | --- | --- |
| Draft | 采集未完成或内容尚未确认完整。 | 否 |
| Active | 当前可继续更新、默认可恢复的工作状态。 | 是 |
| Stable | 已确认可作为可靠基线的工作状态。 | 是 |
| Archived | 保留历史但不参与默认恢复。 | 否 |
| Deleted | 逻辑删除，等待 GC 清理。 | 否 |

### 6.1 Context 状态转换约束

- Checkpoint 创建的 Context 先进入 `Draft`；所有写入成功、内容完整后才能转为 `Active`。
- `Active` 可更新并转为 `Stable`；`Stable` 可以在继续工作时重新转为 `Active`。
- `Active` 与 `Stable` 可以归档为 `Archived`。
- `Archived` 可以通过 `ctx restore` 回到 `Stable`。
- 只有 `Archived` 可以转为 `Deleted`；`ctx gc` 仅物理清理已删除的 Context。
- 非法转换必须返回错误，不能隐式更改状态。

Checkpoint 失败时不得生成可被 Resume 的半成品；若保留诊断快照，必须保持 `Draft` 并由 `ctx doctor` 标记为不完整。

### 6.2 Knowledge 与 Deadend 状态

```text
Knowledge: Candidate → Verified → Deprecated
                         ↘ Rejected

Deadend:  Candidate → Verified → Obsolete
                         ↘ Rejected
```

- `Candidate` 只能进入显式治理流程，不能进入默认 Resume。
- `Verified` 需要用户确认或可追溯的证据；自动总结不得直接晋升。
- `Deprecated` 表示知识不再适用但保留历史来源；`Obsolete` 表示死路的前置条件已变化，不能继续作为当前警告。
- `Rejected` 和 `Obsolete` 不删除来源记录，便于解释为何不再加载。

------------------------------------------------------------------------

## 7. 项目初始化：`ctx init`

### 7.1 命令

```bash
ctx init
ctx init <project-path>
```

执行过程：

1. 解析目标目录并确定 Project Root，优先使用 Git 根目录。
2. 检查 `.context/` 是否已经初始化。
3. 创建运行时目录及初始 Manifest。
4. 在 `.contextignored` 不存在时创建带示例注释的模板。
5. 校验目录布局和忽略规则语法。
6. 输出初始化结果及后续可执行的 `ctx checkpoint` 提示。

### 7.2 初始化产物与物理布局

M0 采用可迁移的 compact JSON 布局，避免把所有历史、索引、知识和配置塞进一个巨大的 JSON：

```text
.context/
├── manifest.json
├── contexts/
│   └── <context-id>/
│       ├── context.json
│       └── snaps/
│           ├── <snapshot-id>.json
│           └── ...
├── index.json
├── locks/
│   └── ...
├── knowledge.json       # 首次 learn 时懒创建
└── deadends.json        # 首次 deadend 时懒创建

.contextignored
```

| 产物 | 权威性 | 职责 |
| --- | --- | --- |
| `.context/manifest.json` | 权威 | 保存格式版本、项目标识、初始化时间、存储布局版本和预算策略版本。 |
| `.context/contexts/<id>/context.json` | 权威 | 保存 Context 元数据、生命周期状态、当前 Snapshot 指针和依赖关系。 |
| `.context/contexts/<id>/snaps/` | 权威 | 保存该 Context 的独立不可变 Snapshot；每个文件包含 baseline 或 Patch/Change Set。 |
| `.context/index.json` | 派生 | 保存所有 Context、Snapshot、Knowledge 和 Deadend 的轻量检索元数据；可删除、可重建，不能替代权威对象。 |
| `.context/knowledge.json` | 权威 | M0/MVP 的 Knowledge 对象集合；首次 `learn` 时懒创建，后续可迁移为分片目录。 |
| `.context/deadends.json` | 权威 | Deadend 对象集合；首次 `deadend` 时懒创建，不能与 Knowledge 混为同一 Schema。 |
| `.context/locks/` | 运行时 | 协调 checkpoint、archive、restore、gc、learn 和 deadend 等互斥操作。 |
| `.contextignored` | 项目配置 | 位于项目根目录，声明项目级上下文采集排除规则。 |

`manifest.json` 管理格式、布局和迁移；`.contextignored` 管理路径采集范围；内置安全规则不可覆盖。默认不创建 `config.json`，避免与 Manifest 和 `.contextignored` 形成职责重叠。若未来需要用户可调策略，`config.json` 只能保存 Token/容量/自动总结/保留策略，不能关闭安全规则或改变 Schema。

`ctx init` 不自动创建空 Context、Knowledge 或 Deadend，也不自动修改 `.gitignore`。`.context/` 是否由团队提交到 Git 是单独的存储策略决策，MVP 不做隐式假设。

### 7.3 幂等和异常处理

重复执行 `ctx init` 必须：

- 不覆盖 `manifest.json`、既有 Context 或用户维护的 `.contextignored`。
- 不重复追加模板或默认规则。
- 已完整初始化时返回成功，并明确提示 `already initialized`。
- 目录存在但布局不完整时返回诊断结果，不自动删除或重建数据。
- Manifest 版本不兼容时要求显式迁移，不隐式升级。

------------------------------------------------------------------------

## 8. `.contextignored`：上下文采集范围配置

### 8.1 位置与用途

MVP 仅支持项目根目录下的 `.contextignored`。它决定哪些**路径**不能被 Checkpoint 采集，可提交到项目仓库以共享团队采集边界。

该文件不替代内容级敏感信息过滤，也不控制 `.context/` 的访问权限。

### 8.2 格式

语法接近 `.gitignore`，采用 UTF-8 纯文本和逐行 glob；MVP 不支持正则表达式。

```text
# 构建产物
dist/
build/
coverage/

# 临时目录与日志
tmp/
.cache/
**/*.log

# 本地配置和凭据
.env
.env.*
secrets/
credentials/

# 重新包含一个被项目规则排除的设计文件
!important-design.md
```

| 写法 | 语义 |
| --- | --- |
| 空行 | 忽略。 |
| `# comment` | 注释。 |
| `dist/` | 排除匹配的目录及子路径。 |
| `/docs/private/` | 仅从项目根目录匹配。 |
| `*.log` | 匹配任意层级的同名模式。 |
| `**/*.log` | 显式匹配任意层级的 `.log` 文件。 |
| `!path` | 取消项目规则造成的排除。 |

路径统一使用 `/`，即使 Runtime 运行在 Windows 上也按相对于 Project Root 的规范化路径匹配。

### 8.3 匹配顺序与优先级

有效规则按以下顺序执行：

```text
内置不可覆盖保护规则
        >
项目 .contextignored 规则（最后一个匹配规则生效）
        >
未来的命令行临时 include/exclude 参数
```

规则要求：

1. 先应用内置保护规则。
2. 再自上而下应用 `.contextignored`，最后一个项目规则生效。
3. `!` 只能重新包含被项目规则排除的路径，不能覆盖内置保护规则。
4. 被排除目录的子树不进入采集枚举；若将来支持重新包含子路径，必须明确定义父目录重新进入语义。
5. `.contextignored` 自身可作为项目配置被读取，但其内容不作为工作上下文采集。

建议提供以下诊断入口：

```bash
ctx doctor --ignore
ctx explain-ignore path/to/file
```

输出必须显示规范化路径、命中的规则来源和排除原因，不得回显任何文件内容。

### 8.4 内置安全保护与默认采集

以下路径始终排除，不能由配置或临时参数重新包含：

```text
.context/
.git/
node_modules/
vendor/
dist/
build/
coverage/
tmp/
.cache/
.env
.env.*
*.pem
*.key
*.p12
*.pfx
credentials*
*credential*
secret*
*token*
```

这是最小基线，不是完备的秘密识别机制。Checkpoint 必须在路径过滤之后、持久化之前执行内容级敏感信息检测：

- 疑似 API Key、Token、密码、私钥等值默认拒绝写入或替换为类型化占位符，例如 `[REDACTED_API_KEY]`。
- 日志、错误信息和诊断输出不得写入原始敏感值。
- 用户不能通过 `.contextignored` 的否定规则或普通命令参数关闭内置保护。
- 已被排除文件如需在摘要中引用，只记录路径和“内容未采集”状态。

MVP 默认记录 Git 锚点、变更路径和摘要，以及 Runtime 生成或用户确认的进度、任务、决策、风险和 TODO；默认不记录完整聊天原文、完整源文件、环境变量和构建产物。

------------------------------------------------------------------------

## 9. Checkpoint 与 Resume 工作流

### 9.1 `ctx checkpoint`

```text
解析 Project Root
  → 读取 Git 状态和当前 Context 的最新 Snapshot
  → 读取并校验 .contextignored
  → 枚举候选文件与变更
  → 应用内置路径保护
  → 应用项目忽略规则
  → 检测并脱敏候选内容
  → 比较基线，计算 Patch / Change Set
  → 提取进度、任务、决策、风险与 TODO
  → 提取结构化 Context
  → 生成 Candidate Knowledge 与 Candidate Deadend
  → 生成限长 Handoff Summary
  → 生成轻量摘要与 Draft Snapshot
  → 原子写入增量版本或压缩基线
  → 更新可重建索引与元数据
  → 转为 Active
```

约束：

- 规则必须在读取可持久化内容前生效，不能先完整写入中间存储再过滤。
- 除首次基线、显式全量操作和自动压缩外，单次 save 不得重复持久化未变化文件的完整树或完整摘要。
- 未发生有效变化时返回 `no_change`，不创建 Snapshot、不增加存储占用，也不增加 `usageCount`。
- 忽略文件可参与数量统计，但原始内容不得进入 Context。
- `.contextignored` 更新只影响后续 Checkpoint，不会静默重写历史 Context。
- Patch 只允许基于指定父 Snapshot 写入；基线不匹配时返回 `base_snapshot_mismatch`。
- 原子写入失败、Patch 应用失败或重建哈希不匹配时保留原有 Active/Stable Context；不完整产物仅可作为诊断 Draft 存在。
- 采集时需持有项目级写锁，避免并发 checkpoint、archive 和 gc 相互破坏。

Checkpoint 还受到 Runtime 级 anti-spam 约束：同一 Project + Context 的实际写入默认至少间隔 10 秒。限流由 Runtime Core/API 强制，不是 CLI 防抖；限流请求返回 `rate_limited`、上次写入时间、下次允许时间和是否存在待合并变更，不能静默丢弃。Agent API 不得绕过该限制；Human 的 `--force` 是否允许仅作为显式待决策略，不得成为默认路径。

### 9.2 自动总结与下班交接

自动总结的输入只能来自已采集、已脱敏且可追溯的来源：Git 变更摘要、工具结果、用户明确结论、当前 Context 字段和显式 `learn`/`deadend` 请求。它必须区分事实、用户决定、模型推断和待确认内容。

输出分为四层：

```text
raw observations       # 不直接进入默认 Resume
structured context     # 当前任务的完成项、待办、阻塞和风险
candidate knowledge    # 待确认的可复用业务规则
candidate deadends     # 待验证的失败路径
handoff summary        # 限长的下班交接摘要
```

显式下班交接命令：

```bash
ctx checkpoint
ctx checkpoint --quick
```

- `ctx checkpoint` 执行完整增量保存、自动总结和候选对象提取。
- `ctx checkpoint --quick` 只保存结构化进度和错误，不执行深度知识提炼。
- 自动触发（如 IDE 关闭）只能调用同一 Runtime Checkpoint API，不能自行绕过锁、脱敏、Patch、预算和限流。
- 自动总结失败时保留原有 Active/Stable Context；候选 Knowledge、Deadend 或 Handoff Summary 失败不能覆盖有效状态。
- 自动总结生成的 Knowledge/Deadend 只能为 `Candidate`，除非用户显式确认或另有可审计的验证流程。

### 9.3 `ctx resume`

Resume Selector 在当前项目内按下列优先级排序：

1. 明确 `pin` 的可加载 Context。
2. Project 匹配。
3. 当前 branch 匹配。
4. 当前 commit 相同，或能被 Git Adapter 证明存在可追溯关系。
5. `Active` 优先于 `Stable`。
6. 最近使用时间和更新时间。

候选唯一时自动加载；多个候选同等匹配时列出候选摘要并要求用户选择，不能静默加载不确定的 Context。已归档、删除和不完整 Draft 不参加默认 Resume。

### 9.4 按需加载与 Token 预算

`ctx resume` 和 `load_context()` 默认只返回或注入以下轻量载荷：

```text
resume_summary:
  context:
    title
    project
    branch
    commit
    snapshot_id
  yesterday:
    completed
    decisions
    changed_areas
  today:
    next_actions
    pending_tasks
    blockers
    risks
  warnings:
    last_error
    branch_or_commit_drift
    unresolved_questions
  reusable_knowledge:
    verified_matches
  deadends:
    count
    details_handle
```

默认不注入完整 Context、文件树、聊天记录、全部历史 Snapshot 或全部 `relatedFiles`。只加载当前作用域匹配的 `Verified Knowledge`；Deadend 默认仅显示数量或按需句柄，不注入全文。详细任务、决策、风险、文件摘要、指定 diff 和历史版本必须通过显式查询按需展开，并受到最大条目数、字符数/token 数和分页限制。Runtime 内置摘要策略，调用方不能通过参数绕过加载预算。

`load_context()` 的返回结构必须区分 `resume_summary` 与 `details`，避免 Agent 将权威存储对象误当作完整 Prompt 直接注入。`progress_summary`、`last_error` 和 Handoff Summary 可从权威 Snapshot 重建，不能只依赖索引。

------------------------------------------------------------------------

## 10. 存储、索引与并发

### 10.1 存储原则

- MVP 使用项目级本地 `.context/` 存储。
- Context、Snapshot、Knowledge 和 Deadend 是权威业务数据；`index.json` 只用于检索加速且必须可重建。
- 存储格式和目录布局通过 Manifest 中的版本字段显式管理；compact JSON 是 M0 物理实现，不限制未来迁移到分片或其他适配器。
- 单个 Snapshot 独立文件化，避免修改一个快照时重写全部历史；Knowledge 和 Deadend 也与 Snapshot 分离保存。
- 历史 Snapshot 以不可变追加方式保存，但默认只追加 Patch，不追加完整项目文件树。
- 对相同内容使用内容哈希去重，避免相同摘要或 Patch 重复占用空间。
- Patch 达到单次大小阈值或链长度上限时生成新的基线 Snapshot，并保留父链和逻辑历史关系。
- Manifest 应记录单 Context、单 Snapshot、单 Patch 和项目总存储预算；超过预算时执行压缩或返回 `storage_quota_exceeded`，不得静默删除历史。
- 加载也受 token/字符预算约束；超过预算返回 `load_budget_exceeded`，要求调用方分页或请求更窄的详情。

### 10.2 并发与恢复

- `checkpoint`、`archive`、`restore`、`gc` 获取项目级写锁，并共享 Project + Context 维度的限流和幂等状态。
- `list`、`status`、`explain`、`history` 使用读操作，不应修改存储。
- 进程异常后由 `ctx doctor` 检测过期锁、不完整 Draft、缺失索引、无效依赖、Patch 链不可重建和摘要索引不一致。
- `ctx gc` 只清理 `Deleted` 数据和可安全重建的派生索引，不清理 Active、Stable 或 Archived Context。
- Knowledge/Deadend 的来源、证据、作用域和状态索引必须可重建；任何索引损坏不得改变其权威对象状态。

------------------------------------------------------------------------

## 11. CLI、Agent API 与管理能力

### 11.1 CLI 指令一览

CLI 是 Runtime 的人类和脚本入口，业务命令默认输出 JSON，帮助命令输出面向用户和 Agent 的纯文本。每个一级指令都支持独立帮助，例如 `ctx init --help`；嵌套治理指令也支持帮助，例如 `ctx knowledge verify --help`。

| 指令 | 当前用途 | 主要输入/选项 | 输出与副作用 |
| --- | --- | --- | --- |
| `ctx --help` | 查看顶层指令提示。 | 无。 | 纯文本；只读。 |
| `ctx --version` | 查看 CLI 版本。 | 无。 | 版本信息。 |
| `ctx init` | 初始化项目的 `.context/` 布局和 `.contextignored` 模板。 | 可选项目路径、`--path`。 | JSON；幂等写入，不覆盖既有数据。 |
| `ctx checkpoint` | 保存结构化工作状态，创建 baseline、patch 或 no-op。 | `--context`、`--title`、`--progress`、`--last-error`、`--completed`、`--pending`、`--decisions`、`--risks`、`--files`、`--path`。 | JSON；受规范化、路径过滤、原子写入和保存限流约束。 |
| `ctx resume` | 选择并恢复 active/stable Context，返回摘要和详情。 | `--context`、`--max-chars`、`--path`。 | JSON；只读加载，报告 Git 漂移。 |
| `ctx status` | 查看初始化状态、项目根目录和 Context 索引。 | `--path`。 | JSON；只读。 |
| `ctx doctor` | 检查 Manifest、Context、Snapshot 链、索引和 hash。 | `--path`。 | JSON；只读诊断，不自动修复历史数据。 |
| `ctx learn` | 记录一条 Candidate Knowledge。 | 语句、`--scope`、`--context`、`--snapshot`、`--evidence`、`--path`。 | JSON；写入候选知识，保留来源和证据。 |
| `ctx knowledge` | 列出已验证 Knowledge。 | `--all`、`--path`。 | JSON；默认隐藏 Candidate。 |
| `ctx knowledge verify` | 将指定 Knowledge 标记为 Verified。 | Knowledge ID、`--path`。 | JSON；显式治理写入。 |
| `ctx deadend` | 记录一条 Candidate Deadend。 | `--attempt`、`--reason`/`-m`、`--scope`、`--context`、`--snapshot`、`--evidence`、`--path`。 | JSON；写入候选失败路径。 |
| `ctx deadend verify` | 将指定 Deadend 标记为 Verified。 | Deadend ID、`--path`。 | JSON；显式治理写入。 |
| `ctx deadends` | 列出已验证 Deadend。 | `--all`、`--path`。 | JSON；默认隐藏 Candidate，Deadend 不进入普通 Resume。 |

当前版本的核心闭环是：

```text
ctx init → ctx checkpoint → ctx resume
                    ├→ ctx learn → ctx knowledge verify
                    └→ ctx deadend → ctx deadend verify
```

后续 Consensus Runtime 将在不破坏上述指令的前提下增加需求发现和共识服务指令，例如 `ctx consensus discover`、`ctx consensus search`、`ctx consensus propose` 和 `ctx consensus record-use`。这些指令属于后续能力，不应在当前版本中伪装成已经实现的功能。

### 11.2 Agent API 与管理能力

| 能力 | Human CLI | Agent Skill / SDK | Runtime 约束 |
| --- | --- | --- | --- |
| 初始化 | `ctx init` | 可选 | 不覆盖已有项目状态。 |
| 保存 | `ctx checkpoint` | `save_context()` | 必经采集、忽略、脱敏、Patch 和限流管线。 |
| 加载 | `ctx resume` | `load_context()` | 使用确定性候选选择和默认摘要预算。 |
| 搜索 | `ctx list` / `ctx explain` | `search_context()` | 返回摘要和元数据，遵守状态过滤。 |
| 管理 | `archive`、`restore`、`gc`、`pin` | MVP 不开放破坏性操作 | 通过生命周期约束和锁保护。 |
| 诊断 | `status`、`doctor`、`history` | 只读诊断 | 不回显秘密或被排除内容。 |
| 学习 | `ctx learn`、`ctx knowledge` | `learn_knowledge()`、`search_knowledge()` | 默认 Candidate；需来源、作用域和证据。 |
| 死路 | `ctx deadend`、`ctx deadends` | `record_deadend()`、`search_deadends()` | 默认不注入普通 Resume；需失败证据和适用条件。 |
| 治理 | `ctx verify`、`ctx deprecate` | `verify_knowledge()`、`verify_deadend()` | 仅显式治理操作可晋升或失效。 |

所有 Agent 操作必须经 Runtime API 执行；Agent 不持有 `.context/` 的直接文件读写契约。

### 11.3 API 返回语义

`save_context()` 的输入应引用 `base_snapshot_id` 和变更摘要，不要求调用方提交完整文件树；返回至少包含：

```text
status: saved | no_change | rate_limited
snapshot_id
parent_snapshot_id
storage_mode: patch | baseline | no-op
changed_count
coalesced_save_count
progress_summary
last_error
```

`load_context()` 默认返回 `resume_summary`、必要元数据和按需查询句柄；`details`、指定 Snapshot、有限 diff 和历史记录必须通过显式请求获取，并遵守加载预算。调用方不能要求 API 绕过内置摘要、容量或安全限制。

MVP 不定义 Context merge。产品提案中的“合并”仅作为未来能力保留；实现时必须另行定义父 Context、冲突检测、人工解决和新 Snapshot 生成规则，不能与 Git merge 混淆。

`search_context()`、`search_knowledge()` 和 `search_deadends()` 必须返回带类型的结果，不能把三类对象混入无类型全文结果。默认搜索规则为：Context 可搜索；Verified Knowledge 可搜索；Candidate Knowledge、Deadend 和历史错误路径只有显式查询或相似方案评估模式才返回。

------------------------------------------------------------------------

## 12. 权限、安全、错误与可观测性

### 12.1 权限边界

MVP 将 Human CLI 视为项目所有者操作入口。Agent 可保存、加载、更新和搜索 Context，但不执行物理删除、GC 或绕过过滤规则的直接文件操作。

多用户身份认证、角色授权、团队可见性和远端审计不属于 MVP，需在引入共享存储前单独设计。

### 12.2 错误处理

- 对未初始化项目，返回可操作错误并提示执行 `ctx init`。
- 对规则语法错误，拒绝本次 Checkpoint，指出行号和规则本身；不得继续使用不确定的忽略范围。
- 对存储、锁或索引异常，保留权威数据，避免部分写入变成可恢复 Context。
- 对 branch 已删除或 commit 不可达的 Context，保留其历史信息，但标记 Git 锚点过期并降低 Resume 匹配优先级。
- `rate_limited`、`no_change`、`base_snapshot_mismatch`、`patch_too_large`、`storage_quota_exceeded` 和 `load_budget_exceeded` 必须作为结构化状态返回。
- Patch 链不可重建、摘要生成失败或超出存储/加载预算时，不得生成可 Resume 的半成品。

### 12.3 可观测性

`ctx status`、`ctx doctor` 和 `ctx history` 应提供：

- 当前项目是否初始化、Manifest 与 Schema 版本。
- 当前 Git 锚点与匹配到的 Context 概况。
- Context 状态计数、无效依赖、不完整 Draft、过期锁和可重建索引状态。
- 当前基线、Patch 链长度、累计存储大小、最近一次实际写入时间、被合并的 save 次数和最近 `last_error`。
- 忽略规则加载状态、被排除文件数量与原因统计。

这些输出只展示元数据、路径、统计信息和规则来源，不展示敏感值或被排除文件的原始内容。

------------------------------------------------------------------------

## 13. 能力价值、难度与验收指标

| 能力 | 价值 | 设计/实现难度 | 首版验收方向 |
| --- | --- | --- | --- |
| 隔夜上下文断裂 | 核心价值；让第二天从昨日工作状态继续，而不是重新扫描项目。 | 中等；主要难点是摘要质量、Git 漂移和衰减策略。 | Resume 能恢复当前目标、完成项、下一步、阻塞和最近错误；默认载荷受预算限制。 |
| 业务知识散落 | 杀手锏；把订单状态、积分规则、第三方策略等一次性理解转化为可复用资产。 | 高；需要稳定 Schema、来源追踪、作用域、冲突检测和学习/验证流程。 | Verified Knowledge 命中有作用域和来源；Candidate 不自动注入；冲突不静默覆盖。 |
| 上下文污染/死路 | 差异化；避免错误方案随历史重新进入主上下文。 | 中等；难点是区分“暂时失败”和“已验证不可行”。 | 默认 Resume 不注入 Deadend 全文；验证状态、作用域和失效条件可解释。 |
| 文件散落难清理 | 基础价值；统一管理 Context 文件，减少无主、过期和重复数据。 | 低到中等；需要索引、状态、保留策略和安全 GC。 | `doctor` 能发现孤儿/损坏对象，`gc` 只清理安全候选，不影响 Active/Stable/Archived。 |
| Token 消耗大 | 直接优化；用摘要、检索和按需详情替代全文加载。 | 中等；需要分层载荷、Token/字符预算、分页和超预算反馈。 | 默认只加载 Handoff Summary、`progress_summary`、`last_error` 和匹配知识；超预算返回结构化状态。 |

五项能力的验收不能只看“能否保存”，还要分别检查恢复成本、知识命中质量、错误路径注入率、存储增长和默认 Resume 的 Token 规模。

------------------------------------------------------------------------

## 14. M0 与完整 MVP

### 14.1 M0：最小可靠闭环

M0 的目标是：**一个项目中，用户能够可靠地保存一次结构化工作状态，关闭会话后第二天按 Git 锚点恢复，并且不会破坏已有数据。** M0 不依赖模型、在线服务或特定 Agent SDK。

M0 必须包含：

1. `ctx init`：创建 Manifest、compact JSON 最小目录、锁机制和 `.contextignored` 模板；重复执行幂等。
2. `ctx checkpoint`：保存结构化 Context，包括进度、TODO、决策、风险和最近错误。
3. `ctx resume`：按项目、branch、commit 和 Active/Stable 规则选择 Context，并返回轻量摘要。
4. 单 Context 的不可变 Snapshot 链：首次 baseline，后续 Patch 或 no-op，至少支持 parent、hash 和重建校验。
5. 基础 `.contextignored` 路径过滤，以及 `.context/`、`.git/`、凭据的内置保护。
6. 独立 Snapshot 文件、原子写入、基本跨平台锁、旧状态保留和可重建 `index.json`。
7. 基本 `status`/`doctor`，能够发现未初始化、损坏 JSON、缺失索引、锁异常或不完整写入。
8. 无模型运行：调用方可以直接提交结构化字段；总结器缺失或失败不影响显式进度保存。

M0 不包含：

- 自动总结、Handoff Summary 和自动 Knowledge/Deadend 提取。
- Candidate/Verified 治理、复杂搜索、作用域匹配和冲突检测。
- 完整 `archive`、`restore`、`gc`、`pin`、`history` 管理。
- 高级 Token 预算、Patch 压缩、跨 Context 依赖和 IDE 自动触发。

### 14.2 完整 MVP：可用且可治理的第一版

在 M0 之上，完整 MVP 纳入：

- `checkpoint --quick` 与完整自动总结、Handoff Summary。
- Knowledge/Deadend 独立 Schema、来源、Scope、证据和 Candidate/Verified 治理。
- 默认加载隔离、作用域匹配和按需详情。
- Token/字符预算、10 秒写入限流和 no-op 幂等。
- Patch 链压缩、内容 hash 去重、存储配额和安全 GC。
- 生命周期管理、archive/restore/gc/pin/history。
- 内容级敏感信息检测、脱敏、ignore 解释和失败回滚。
- 完整 `doctor`、类型隔离搜索、冲突检测和索引重建。

完整 MVP 仍不包含远端同步、多人权限、向量检索、自动 Context merge 和完整聊天记录保存。

### 14.3 交付判定原则

- 没有它就无法完成“保存—关闭—重新打开—恢复”的能力，属于 M0。
- 主要提升治理、质量、成本或规模，而不影响最小闭环成立的能力，属于完整 MVP 或后续增强。
- 依赖模型推理的能力不能成为 M0 的前置条件，应通过可选总结器或 Agent/IDE 适配器接入。

------------------------------------------------------------------------

## 15. MVP 范围与待决事项

### 15.1 MVP 包含

- 单项目、本地 `.context/` 初始化和 Manifest。
- 项目根目录 `.contextignored` 及内置安全排除规则。
- 基础内容级敏感信息检测和脱敏。
- Git branch、commit 元数据。
- 不可变 Snapshot、parent/patch/change set、基线压缩、哈希校验和可重建历史。
- 默认只加载 `progress_summary`、`last_error` 和必要元数据，并执行按需详情的 token/字符预算。
- Runtime Core 强制的 10 秒 Project + Context save 限流、无变化幂等和限流可诊断返回。
- Checkpoint、Resume、基本生命周期和可重建索引。
- Context、Knowledge、Deadend 的独立 Schema、Candidate/Verified 治理、作用域和来源追踪。
- `learn`、`knowledge`、`deadend`、`deadends`、`verify` 的 Runtime 契约，以及默认加载隔离。
- 下班自动总结、Handoff Summary、`checkpoint --quick` 和失败回滚边界。
- `init`、`checkpoint`、`resume`、`list`、`status`、`explain`、`archive`、`restore`、`doctor`、`gc`、`history`、`pin` 的 Runtime 契约。

### 15.2 MVP 不包含

- 跨设备同步、远端存储与团队共享。
- 多用户访问控制、加密密钥托管与审计服务。
- IDE Extension 的完整交互和多 Agent 协议兼容。
- 向量检索、自动冲突合并与完整聊天记录保存。
- 用户关闭内置安全保护的能力。

### 15.3 待决事项

- `.context/` 是否默认纳入 Git，以及团队共享 Context 的协作模型。
- 非 Git 项目的 Project Root 解析与 Resume 策略。
- 是否支持用户级 `.contextignored`，以及其与项目规则的优先级。
- 是否支持 `!` 重新包含已排除目录下的子路径。
- 存储格式采用 JSON、Markdown 加元数据，还是嵌入式数据库。
- `Deleted` 的保留期限和物理清理策略。
- Stable 是否需要显式人工确认。
- Agent Skill/SDK 的输入输出 Schema 与人工编辑 Checkpoint 摘要的交互方式。

------------------------------------------------------------------------

## 16. 设计验证清单

- [ ] 与产品提案逐条对照，确认 Runtime 定位、三个入口、生命周期和 checkpoint/resume 体验保持一致。
- [ ] 逐项确认每个 CLI 命令都映射到清晰的 Runtime 能力与状态约束。
- [ ] 演练 `ctx init` 的首次执行、重复执行、目录不完整和版本不兼容场景。
- [ ] 为 `.contextignored` 建立真值表，覆盖文件、目录、根路径、`*`、`?`、`**`、否定规则、最后匹配优先及内置规则不可覆盖。
- [ ] 使用伪造凭据测试路径过滤和内容脱敏，确认原始秘密不会写入 Context、日志或诊断输出。
- [ ] 验证 `.contextignored` 改动仅影响未来 Checkpoint，不会改写历史 Context。
- [ ] 验证非法生命周期转换、Resume 多候选、原子写入失败和锁异常都有明确行为。
- [ ] 验证未验证 Knowledge 不进入默认 Resume，Deadend 默认只返回计数/句柄，Rejected/Obsolete/无关作用域对象不注入。
- [ ] 验证 `learn`、`deadend`、自动总结、`checkpoint --quick` 的幂等、证据追踪、冲突和失败回滚。
- [ ] 验证 Resume 输出包含完成项、下一步、阻塞、风险、匹配 Knowledge、Deadend 提示和 Git 漂移信息，并受预算限制。
- [ ] 验证核心 CLI 无模型 SDK/在线服务也能保存结构化 Context，且 Node engines、依赖分层和跨平台约束可测试。
- [ ] 完成 Markdown 渲染、链接和格式检查，并在进入实现阶段前决策待决事项中影响存储与安全边界的条目。

------------------------------------------------------------------------

## 17. Runtime 与 CLI 实现约束

### 15.1 Node.js 版本

CLI 支持经过 CI 验证的 Node.js Active LTS 与 Maintenance LTS。具体最低版本必须通过 `package.json` 的 `engines.node` 固定，并在发布前确认依赖和平台 API 均支持该版本；不使用含糊的“支持所有 Node 版本”承诺。CI 至少覆盖最低支持版本和当前 Active LTS。

### 15.2 依赖分层

- **核心运行时**：只依赖 Node.js 内置模块和随 CLI 一起发布的代码，优先使用 `fs/promises`、`path`、`crypto`、`readline`、`child_process` 等能力。
- **可选能力**：IDE 集成、远端同步、向量检索和特定模型供应商 SDK 不得成为核心命令的安装或运行前置条件。
- **外部工具**：Git CLI 仅在需要读取 Git branch、commit 和追溯关系时使用；非 Git 基础操作不依赖它。

不为简单的参数解析、glob、哈希、锁和纯文件存储重复引入多个第三方库。新增生产依赖必须说明功能必要性、维护状态、许可证、安装体积、Node 兼容性和替代方案，并与开发/测试依赖分离。核心 CLI 不依赖在线服务、外部数据库、全局安装的 Node 包、模型 SDK、Docker 或特定 shell。

### 15.3 跨平台边界

- 内部路径统一使用 `/`，输入路径先规范化为相对 Project Root 的路径。
- Windows、macOS 和 Linux 的命令、退出码、错误结构和 UTF-8 编码保持一致。
- Git 调用必须使用参数数组和安全的子进程接口，不能拼接 shell 命令字符串。
- 文件锁、原子写入、重命名、异常退出后的锁清理不能假设 Unix `flock` 或 Bash 行为。
- CLI 不依赖 Bash、PowerShell 或 Unix-only 命令完成核心流程。
- Node 版本升级、第三方依赖升级和存储 Schema 升级必须通过跨平台矩阵与历史数据兼容测试。
