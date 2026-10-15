# beta.12：可验证的任务上下文工作集

2026-10-15。本文记录下一对外 beta 的开发范围与验收任务。2026-10-15 已进入实现：B12.1–B12.3 最小闭环及 B12.4 本地可解释性/自动回归已开发；最终验证证据见 BETA12-LOCAL-VALIDATION.md，真实宿主采用不由自动测试替代。beta.11 保持内部修复验证版，不发布 npm / release；beta.12 承接其修复，原生产项目复测仍是发布门槛。

## 目标

让新会话或接手的 agent 在有限预算内知道当前任务、有效约束、已经验证的结果、未解决的问题和下一步；需要细节时能直接展开证据，来源变更时能识别并替换旧的交付内容。

本版集中交付三个增量：任务交接包、可操作的按需证据引用、来源变更感知注入。继续使用 init、inject、checkpoint、import、report 作为日常入口；复用 compile/expand 和现有审阅接口。

## 官方概念与采用边界

2026-10-15 读取的官方原文：

1. Anthropic，[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，2025-09-29。上下文工程是在每轮推理中选择、组织和维护有效上下文，覆盖系统指令、工具、外部数据和历史；强调有限注意力预算、just-in-time retrieval、progressive disclosure、compaction、structured note-taking 和 sub-agent architectures。
2. Anthropic，[Managing context on the Claude Developer Platform](https://www.anthropic.com/news/context-management)，2025-09-29。介绍 context editing 与客户端 memory tool。文中发布状态和性能数字属于当时的平台与实验，不能当作本项目实测收益或当前 API 可用性承诺。

Context Engineering 是工程方法论；这两篇已核实文章并非 2026 年 10 月的新发布。本文不主张该术语由 Anthropic 首创，也不将其解释成 Cowork 产品能力。

可吸收的方法：

| 官方论点 | 本项目可落地的方式 | 边界 |
| --- | --- | --- |
| 最小但充分的高价值上下文 | 明确保留任务约束、失败结论和待办；让引用及解释也有预算 | 最短输出不是唯一目标，不能靠丢关键事实降低长度 |
| Just-in-time / progressive disclosure | 首次注入摘要和可调用引用，按需展开已有证据 | 复用现有记录，不引入全仓库代码索引 |
| Structured note-taking | 从 checkpoint、notes、验证引用构建任务交接包 | 任务进度是工作状态；不会自动变成 verified 项目知识 |
| Compaction / context editing | 生成有来源的恢复包，并交付明确替换标记 | CLI/MCP 无法通用地删除宿主历史消息或控制宿主压缩 |
| Context rot | 用无关信息干扰、关键事实保留率和任务正确性测试上下文选择 | 它描述长上下文中的性能退化，不等于某个来源文件过期；来源新鲜度另行治理 |
| Sub-agent architectures | 后续让多个 agent 交换有界任务包与证据引用 | beta.12 不建设调度器或自行启动 agent；此处是产品设计参考 |

## 已有基础与真实缺口

| 已有实现 | 本次核对的代码 | beta.12 增量 |
| --- | --- | --- |
| 场景预算、选择/排除原因、摘要与结构化展开 | `src/compiler/compile.ts`、`types.ts`、`expand.ts` | 把底层能力变成 agent 能直接使用的引用契约 |
| 默认 2400 字符注入、explain、next 提示 | `src/compiler/inject.ts` | 当前默认响应以正文和 manifestHash 为主；截断时 next 是泛化提示，展开仍需 agent 补充调用参数 |
| manifest/item 身份与适用范围校验 | `src/compiler/identity.ts`、`expand.ts` | 保留重校验；当前 expand 仅接受已选候选，不宣称已支持预算遗漏项的懒加载 |
| full/delta/unchanged、任务/分支变化替换 | `src/compiler/session.ts` | 将来源待复核及交接包版本纳入交付失效条件 |
| 来源变更收据与审阅结案 | `src/cognition/import-memory.ts`、`memory-receipts.ts`、`knowledge-review.ts` | 把 reviewRequired 与当前源状态接入日常注入和展开 |
| 时间新鲜度评分 | `src/cognition/retrieval.ts` | 现评分相对投影最新事件计算；不能当作源文件指纹核验 |
| 进度、完成、待办、决策、风险、关联文件 | `src/runtime/types.ts`、`runtime.ts` | 有证据引用和任务边界的稳定恢复视图，补充缺失字段 |
| 交付账本与 paired evaluation report | `src/cognition/usage.ts`、`docs/EFFECTIVENESS.md` | 新增针对本批功能的夹具与真实恢复/展开采用证据，不重复实现统计入口 |

## 迭代任务

### B12.0 / P0：公司内试用（用户要求延后，不阻塞功能开发）

- 受影响生产项目安装内部 tarball，观察独立 PowerShell 与 Zcode 下的 stop/start/status、持续心跳、失败后再次启动及 Hook/MCP。
- 如果仍失败，以 diagnostics 的阶段、错误码、退出码和进程状态继续复现并修复。
- 保留 beta.8/beta.10/beta.11 → beta.12 最终包的升级回归和历史事件一致性验证。
- 完成条件：生产现场通过，或仍明确标记发布阻塞；不得以本仓库 190 项测试或隔离矩阵替代。

### B12.1 / P1：结构化任务交接包

- 优先扩展现有 checkpoint/恢复视图，设计可选字段与旧快照兼容：任务目标、硬约束、最新验证引用、开放问题、下一步动作。已有 completed/pending/decisions/risks 不重复建立第二套持久化模型。
- 交接包包含 context/snapshot ID、分支/commit、证据引用及包版本。显示“某 commit 上有验证记录”，不能自动推断当前改动已测试。
- `inject` 的 resume/handoff 场景优先保留任务连续性；普通新任务注入仍按相关性过滤。
- 采用确定性渲染，不引入后台 LLM 摘要服务。输入没有提供的事实显示缺失，不自动填入成功结论。
- 验收：在固定恢复夹具中，目标、约束、未解决错误和下一步完整保留；新会话能够找到对应证据；旧快照仍可读取，task/branch 切换不会混入另一任务工作状态。
- 主要涉及：runtime types/checkpoint、compiler sources/compile/inject、CLI/MCP schema、Hook 渲染。

### B12.2 / P1：可操作的按需证据引用

- 注入返回有界摘要与 `expandRef` 或等价结构，包含足够的身份/作用域信息，让 agent 可直接调用现有 expand；具体参数形式在实现时锁定。
- 首批保证已选且可展开的证据闭环。预算遗漏项只允许在通过可信状态、相关性和适用范围检查之后提供少量引用；若扩大 expand 契约超过本版范围，则遗漏项仅给出明确的重新编译动作，不能伪装成可展开引用。
- 展开前重校验记录内容、可信状态、任务/分支边界及来源状态；过期引用返回明确的重新注入动作。不能用引用绕过 candidate/deprecated/rejected 排除规则。
- 正文预算和引用/诊断元数据预算分别公开并有上限；保留 maxChars 兼容语义。字符估算不升级为真实 tokenizer 或 provider 账单。
- 验收：无需手工拼 manifest 参数即可完成 inject → expand；大记录首次不整篇注入；来源/状态变化后旧引用不可静默返回旧证据；低预算下引用也不会无限膨胀。
- 主要涉及：compiler inject/types/identity/expand、CLI/MCP/Agent API 与一致性测试。

### B12.3 / P1：来源变更感知注入与替换

- 在时间新鲜度之外增加来源状态：unchanged、changed、missing、unknown（具体名称在 schema 设计时确定），复用来源收据与审阅结案。
- 首批范围限定为已有可追溯来源指纹的导入知识。手工录入且没有可核验来源的知识标记 unknown，不伪称 fresh，也不因此把整个现有知识库排除。
- 对已知 changed/missing 的证据，默认不再作为当前有效结论注入，返回有界复核提示；保留历史 verified 状态，必须由审阅操作决定 keep/deprecate/reject。
- 将来源状态改变纳入交付身份；旧会话中已交付的结论在下一次调用产生 replacement/retraction 指示。宿主是否真正移除旧内容需要单独验收。
- 来源检查遵守忽略规则和读取预算；不做每次全仓扫描。无法完成检查标 unknown；基于部分扫描不得假定未见文件已删除，也不得清除已有待复核事实。
- 验收：修改/删除已知来源后不能继续无提示复用旧结论；keep 只对核验过的指纹生效；再次修改重新提示；不改变 journal 历史，不自动晋升/撤销知识可信状态。
- 主要涉及：memory-receipts、knowledge-review、compiler sources/identity/session、retrieval 和注入回归。

### B12.4 / P1：可解释性与本批效果验收

- 扩展已有 `inject --explain` / report：说明任务状态占用、证据/引用预算、展开次数、来源复核排除与替换原因。默认响应仍保持简洁。
- 使用三组固定任务：跨会话恢复、重复错误调查、来源改变后任务继续。对比 beta.11 与 beta.12，在同仓库 commit、同模型、同预算和同验收条件下运行。
- 自动夹具检查关键事实保留、过期结论误用、无关信息混入、引用失效和预算上限；真实宿主记录返回证据及最终采用。
- Zcode 与 Codex 分别完成至少一条恢复和一条按需展开工作流；宿主不支持的触发列 unsupported，API 脚本成功不当作宿主采用。
- 验收：固定夹具的关键约束不丢失、候选不混入可信结论、已知失效来源不被无提示采用；真实任务无已发现的正确性回退。一次配对只作冒烟，不承诺普遍收益；缺少 provider usage 时标 unavailable。

### B12.5 / P0 发布门槛：最终候选验证与内外版本管理

- 合入 beta.11 修复，锁定 beta.12 schema 和兼容策略，更新帮助、随包 Skill、变更说明。
- 最终代码执行类型检查、全量测试、pack、install:local、安装后 MCP、真实 runtime 启停与上述升级矩阵。
- 记录候选 commit、tarball 哈希、逐文件安装回执和真实宿主证据；具体 npm 发布另行执行。
- 仅声明实测平台。本版以 Windows 为主验收平台，macOS/Linux 完整矩阵保留为正式版门槛。

## 执行顺序与范围控制

用户已明确当前无法进行 B12.0；先开展后续新功能和旧功能扩充，不等待公司试用。锁定 B12.1–B12.3 的共同数据契约和失败夹具；B12.0 留待公司环境可用后补做。实现顺序为 B12.1 → B12.2 → B12.3 → B12.4 → B12.5。这里描述开发依赖，不表示要求启动多个 agent。

beta.12 的必做功能为上述三个增量的最小闭环；新增字段兼容策略、正文/引用预算、失效来源的交付规则须在实现前写入测试。若来源指纹范围或 omitted-reference 扩展超出预算，优先保留已有导入来源及已选证据引用，不扩展到任意外部文件。

本版暂缓：向量数据库/embedding、完整代码图、自动多 agent 调度、后台付费 LLM 压缩、接管宿主消息历史、完整 transcript 导入、通用 memory-tool 适配器与重型可视化面板。它们可另立实验，但不作为 beta.12 的默认依赖。

日历约束服从验收：beta.11 本地通过不代表生产故障已闭环，beta.12 新功能不能抵消 B12.0 未通过；若原定 10 月 24 日计划冲突，调整发布节奏，不降低验收标准。


## beta.12 实现契约

- checkpoint 可选字段：objective 字符串，constraints/validationRefs/openQuestions 字符串数组。省略沿用原值，空字符串/空数组清空；不修改历史快照哈希。下一步复用 pendingTasks。
- handoff 的正文来自现有候选编译；额外描述包含版本、context/snapshot、branch/commit 和 not-recorded/in-text/partial-in-text/omitted-by-budget 标记。默认不隐式跨分支恢复；显式 contextId 可用于有意恢复历史任务。
- expandRefs 是完整 context_expand 参数对象，包含 path 和 compile 参数，默认展开预算 4000 字符。仅支持已选证据；正文默认 2400，引用对象默认 4096、最大 16000，复核条目 2048，explain 来源条目 4096；序列化条目预算不包含响应外壳。重复会话交付无新证据时不重复引用，改变引用预算会重置交付边界。
- 来源检测仅读取已有导入收据关联文件，每次最多 128 文件、2000 路径检查、2 MiB 总读取、单文件 64 KiB。忽略、symlink、嵌套仓库、超预算或不可读结果为 unknown；已有待复核收据保留。不能把 unknown 当作 fresh。
- report 在现有 delivery 下增加 contextEngineering 本地计数。自动测试和协议调用不等于真实模型采用；B12.4 的真实宿主配对评估及 B12.0 均仍待补充。
