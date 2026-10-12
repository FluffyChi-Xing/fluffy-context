# fluffy-context

**让项目记住 AI 已经做过的工作，让下一次对话接着往下走。**

换一个会话或换一个 AI 编程工具，你往往需要重新解释：任务进行到哪里、为什么这样设计、哪些方法已经试过。fluffy-context 把这些信息保存在项目里，在新任务开始时取出相关内容，交给 agent 使用。

它是 LLM 与项目之间的一层本地记忆：保存工作进度，积累经过验证的项目知识，按当前任务提供有长度预算的上下文。CLI 命令是 `ctx`，也提供 MCP 和 JavaScript / TypeScript API。

> 本文对应 **1.0.0-beta.7**（本地开发，尚未发布 npm），面向 npm **beta** 通道，稳定通道仍为 0.8.0。AI 工具自主调用、上下文智能注入的完善与完整宿主验收列为 **1.0.0 正式版核心特性待办**；当前提供相关基础工具与协议。[升级说明与已知限制](CHANGELOG.md) · [1.0 后续计划](ROADMAP-1.0.md)

**beta.2 新增 `ctx upgrade`**，用于已有项目的数据升级与日志归档；beta.1 不含这个命令。

## 它能帮你做什么

| 你遇到的问题 | fluffy-context 的做法 |
| --- | --- |
| 新对话不知道上次做到哪里 | 保存进度、决策和待办，在下次任务开始时恢复 |
| 不同 agent 重复探索同一个问题 | 将经过核验的结论和失败方案保存在项目中，供不同工具查询 |
| 项目记忆散落在各种文档里 | 扫描已有 memory 和 agent 文档，去重后导入待核验知识 |
| 把所有历史塞进 prompt 太长 | 按任务检索，在给定字符预算内返回相关上下文 |
| 不知道保存的东西有没有用 | 查看知识、显式复用记录、日志体积和上下文成本估算 |

它适合持续维护的项目、跨会话的开发任务，以及多个 AI 工具交替使用的工作流。项目代码仍由 Git 管理；ctx 保存的是工作状态与项目知识。

## 五分钟开始使用

需要 **Node.js 20.19 或更高版本**。在终端安装，然后进入你的项目目录：

```sh
npm install --global fluffy-context@beta
cd your-project
ctx init
```

`init` 会创建本地存储、迁移并校验旧数据、向 `AGENTS.md` 添加使用指引，并启动本地运行时。已有 `.claude` 目录时，还会配置 Claude Code 集成。重复执行会保留已有数据和禁用设置，不需要再逐条运行 migrate、verify、enable、start。

### 1. 开始任务时，取得项目上下文

```sh
ctx inject "修复支付回调重复处理的问题"
```

让 agent 执行这条命令，并读取返回的 `text`。它会包含相关的任务进度、已验证知识、失败方案和工作笔记。默认正文最多 2400 字符，需要时可以调整：

```sh
ctx inject "修复支付回调重复处理的问题" --max-chars 4000
```

beta.3 的默认预算会在任务进度与相关的已验证知识、失败经验之间分配，内容较少的一侧会让出余量。恢复和交接偏重进度，其它场景偏重证据；相关性仍基于关键词匹配，不保证理解所有同义表达。显式指定的 Recipe 保留其排序偏好和预算控制。

场景可通过 `--scenario resume` 等参数指定。需要排查遗漏时，使用 `ctx inject "当前任务" --explain`：`selection.excludedCounts` 区分 `query_no_match`（关键词未命中）、`status_not_verified`（候选或已退役）、适用范围不符及 `budget`（预算不足），同时展示各类内容的用量和截断数量。统计不包含被过滤记录的正文。

新项目还没有记忆，第一次返回内容很少是正常的。ctx 不会仅凭一次初始化就理解整个代码库。

### 同一会话避免重复注入（beta.4）

CLI 默认每次返回完整证据包。持续会话可以显式提供身份：

```sh
ctx inject "修复支付回调" --session-id chat-42 --task-id payment-fix
ctx inject "修复支付回调" --session-id chat-42 --task-id payment-fix --reset-session
```

首次 `delivery.mode` 为 `full`；相同任务只有新增证据时返回 `delta`；无变化时为 `unchanged`，正文为空。`replacePrevious: true` 表示应以本包替代之前的项目证据，不能继续沿用已撤回的结论。任务、分支、Context、范围或预算变化，以及证据修改或撤回，会重新发送完整包。未提供 task-id 时使用查询文本识别任务；不同宿主、子 agent 应使用独立会话身份。

上下文压缩、清空、重连但未保留旧上下文时，调用方必须使用 `--reset-session`；task-id 和 reset 都需要 session-id。MCP `context_inject` 和 API 接受对应的 `sessionId`、`taskId`、`resetSession` 参数。`budget.usedChars` 是实际发送正文长度，`compiledChars` 是完整包长度；`--explain` 的选择统计仍描述完整包。

Claude Hook 从 `session_id` 自动取得身份，以完整 prompt 的哈希识别任务；`agent_id` 隔离子 agent。每次 SessionStart（包括 resume / clear / compact）重置。生成配置保留 Claude 2.1.12 支持的 shell command 格式。`ctx doctor --integrations` 检查项目配置、执行路径、禁用/异步/匹配条件及最近本地调用；用户级或托管配置、工作区信任和宿主是否接受输出仍需在 Claude 中检查。

去重为尽力而为：本地回执不等于宿主确认接收，失败或并发调用可能重发；丢失输出后应主动 reset。派生缓存 `.context/injection-cache.json` 只存哈希及时间，最多 32 个会话、每会话 128 条证据，24 小时过期；缓存不可用时回退完整包，不阻塞 Hook。缓存不改变知识可信状态，不纳入升级备份。

### 2. 完成一个阶段后，留下进度

例如，你已经定位问题，但还没写完测试：

```sh
ctx checkpoint --title "支付回调修复" --progress "已定位重复回调导致重复扣款" --completed "复现问题,确认幂等键缺失" --pending "补充幂等处理,运行回归测试" --decisions "使用订单号和事件号作为幂等键"
```

下次换会话或换工具，再执行 `ctx inject "继续支付回调修复"`，agent 就能从保存的状态继续。

这些命令返回 JSON，方便 agent 和脚本读取。你也可以直接在终端使用。

### 命令只需从日常流程开始

`ctx --help` 展示五个日常入口：`init`、`inject`、`checkpoint`、`import`、`report`，以及按需使用的 `knowledge`、`upgrade`、`status`、`doctor`。维护、集成和实验命令在 `ctx --help --all`，每个命令仍可单独使用 `--help`。

知识与失败经验统一在 `knowledge` 下：

| 操作 | 推荐入口 |
| --- | --- |
| 记录知识候选 | `ctx knowledge add "结论" --evidence "文件或测试"` |
| 查看已验证知识 / 审阅全部状态 | `ctx knowledge list` / `ctx knowledge list --all` |
| 有界审阅 / 来源复核队列 | `ctx knowledge review` / `ctx knowledge review --review-required` |
| 预览显式批量治理 | `ctx knowledge batch <verify\|reject\|deprecate\|keep> --ids <ids> --reason "原因"` |
| 核验知识 | `ctx knowledge verify <id>` |
| 记录失败经验候选 | `ctx knowledge deadend add "尝试" --reason "失败原因"` |
| 查看或核验失败经验 | `ctx knowledge deadend list` / `ctx knowledge deadend verify <id>` |

原来的 `learn`、`deadend`、`deadends` 继续兼容，已有脚本和 MCP 工具名不变。新分组和高级帮助需要 beta.3；已发布 beta.2 仍使用旧入口。`verify` 只记录核验决定，不会替代代码审查或执行测试。

## 已有项目怎样升级

使用包含 `upgrade` 的新版 ctx，先关闭这个项目的 agent/MCP 会话，然后在项目目录执行：

```sh
ctx upgrade --dry-run     # 只检查数据和备份大小，不写入、不停运行时
ctx upgrade              # 备份、迁移、归档、验证
```

其它项目可用 `ctx upgrade --path /path/to/project`。终端显示各阶段进度：备份按实际字节、迁移按记录、日志校验和压缩按段计数；百分比表示当前阶段，不是剩余时间预测。脚本可用 `--no-progress` 关闭进度，stdout 始终返回 JSON。

升级保留任务、知识状态和完整事件历史，支持仅有旧 Context 数据的项目，也支持已有认知日志的 0.8.0 项目。运行时升级前会停止，成功后恢复原来的运行状态；禁用策略保持不变。

备份保存在 `.context/backups/upgrade-*/`，包含 `data/` 原文件、`backup.json` 哈希清单和成功后的 `upgrade.json` 回执。备份不包含旧备份、开发打包产物、锁和运行时临时凭据。**备份会额外占用磁盘，日志压缩节省量不包含备份体积。**

重复升级不会重复导入相同数据，但每次执行都会创建独立备份。校验失败时会报错并保留现场，不删除历史、不自动覆盖还原；关闭其它写入者后可以重试。压缩后的日志不能与 0.8.0 混用，完成后用新版 ctx 重新连接 agent。

## 怎样接入你的 AI 编程工具

接入后，理想的日常流程是：**任务开始取上下文 → 开发与验证 → 阶段结束存进度**。不需要人每轮对话都操作 ctx，但 agent 是否会触发取决于宿主的接入方式。

### Claude Code

当前实际接入验收载体是 Zcode 和正在使用的 Codex，二者分别验收；暂不以 Claude CLI 模型登录作为使用前提。先确认各载体的实际接入方式和配置入口：支持 MCP 时使用下方通用 MCP 入口，支持项目指引时让 agent 在开始任务时调用 `ctx inject`、阶段结束时调用 `ctx checkpoint`。Hook 仅在宿主确实支持时验收，不能预设沿用 Claude Hook 或由配置文件存在推断自动触发。

本机配置观察、Windows stdio 示例和真实只读会话结果见 [Zcode / Codex 接入验收](HOST-ACCEPTANCE.md)。

接入验收需记录任务开始、上下文恢复、任务切换、错误调查和阶段结束时的实际调用与结果。当前 Codex 会话已通过全局 CLI 执行 `ctx inject` / `ctx checkpoint`，也通过真实 MCP 验证上下文读取、重复交付去重、任务切换和 reset 替换及阶段 checkpoint。Zcode 的 GLM-5.3 已实际调用 MCP 注入与知识审阅，并引用返回 ID；它把候选知识当作发布待办的判断偏差单独记录。Codex 新治理工具的宿主发现、全局安装入口重连及跨会话自动触发覆盖仍需验证。

项目已有 `.claude` 目录时，`ctx init` 会配置项目级 Hook 和 MCP。新项目也可以显式安装：

```sh
ctx integrate claude install --apply
ctx integrate claude inspect
```

随后重启或重新连接 Claude Code。Hook 在会话开始和提交新任务时提供上下文；MCP 工具供 agent 按需查询、记录进度。这是当前提供自动注入的宿主适配器，真实宿主中的触发效果仍需 beta 验证。

### 支持项目指引的 agent

`ctx init` 写入的 `AGENTS.md` 指引会告诉 agent：新任务、上下文恢复或遇到新错误时调用 `ctx inject`，完成重要阶段后调用 `ctx checkpoint`。

宿主需要能读取项目指引并执行本地命令。这种方式依赖 agent 遵循指引，不保证每个工具都会自动触发。

### 其它支持 MCP 的工具

在工具的 MCP 设置中添加一个本地 stdio 服务，命令为 `ctx`，参数为 `agent`、`serve`。例如，支持以下配置格式的客户端可以使用：

```json
{
  "mcpServers": {
    "fluffy-context": {
      "command": "ctx",
      "args": ["agent", "serve"]
    }
  }
}
```

将服务的工作目录设为项目目录，或在调用工具时传入项目的绝对 `path`。如果客户端找不到 `ctx`，使用其支持的绝对可执行路径配置方式。

日常使用 `context_inject` 取得上下文，`context_checkpoint` 保存进度，`context_learn` 记录候选知识；仅在项目中已有记忆文件时按需使用 `context_import`。工具列表和输入参数由 MCP 服务提供。

## 让工作经验变成可复用的知识

beta.6 提供有界审阅和显式批量治理：

```sh
ctx knowledge review --review-required --limit 20 --max-chars 6000
ctx knowledge review --status candidate --source memory/rules.md
ctx knowledge batch verify --ids <id1,id2> --reason "已核对实现与测试" --evidence "src/payment.ts,test/payment.test.ts"
```

`review` 默认列出 candidate 和 verified，待复核项优先。`source` 为精确的项目相对路径，分页使用 `--offset <nextOffset>`；默认 20 条、最多 100 条，`maxChars` 限制所有返回条目的 JSON 字符总和（不含响应外壳），默认 6000、最多 50000。条目过长会标记 `truncated` 并省略证据；不足以容纳最小条目时返回提示，增加预算后继续。同一审阅过程修改了记录时应重新开始分页。

`batch` 默认预览，最多 50 个明确 ID，不按筛选条件隐式选择整库。核对 `transitions` 后，使用完全相同的参数加 `--apply --expected-token <预览返回的token>` 执行。预览后知识或相关来源变化会拒绝执行，需重新预览。`verify` 仅接受候选，`reject` 拒绝候选，`deprecate` 退役已验证知识；`keep` 对仍有效的已验证知识结案，保留可信状态。`verify` 和 `keep` 必须显式提供证据；证据由操作者核验，CLI 不会运行测试或自动证明结论。

`keep` 绑定当时的来源指纹，重复导入不再提醒同一来源修订；来源再次变化会重开复核。扫描不完整或来源不可用时不能结案。批量状态在一个原子文件替换中保存，日志同步结果单独返回：`complete` 表示完成，`not-enabled` 表示未启用 v2，`pending` 表示状态已保存但日志同步尚未完成，必须使用相同请求和 token 重试。重复执行不重复改变状态；后续另一次治理会使旧 token 失效。

MCP 对应 `context_knowledge_review` / `context_knowledge_batch`，Agent API 导出 `reviewKnowledge` / `batchKnowledge`。退役知识不再进入普通注入，已有会话收到 `replacePrevious` 时应替换旧证据。

进度回答“做到哪里了”，知识回答“下次遇到类似问题应该知道什么”。两者需要分别保存。

例如，你通过代码和测试确认了项目约束，可以记录结论及证据：

```sh
ctx knowledge add "支付回调必须在同一事务中写入幂等记录和更新订单状态" --evidence "src/payment/callback.ts,test/payment/callback.test.ts"
```

返回结果中会包含 `knowledgeId`。确认结论确实有依据后，将实际 ID 代入：

```sh
ctx knowledge verify <knowledge-id>
```

此后，与支付回调相关的 `ctx inject` 才能把它作为已验证知识检索出来。`verify` 记录的是你或 agent 的核验决定，命令本身不会替你运行测试、证明结论。

“越用越聪明”来自这个循环：**真实工作 → 留下证据 → 核验结论 → 后续任务复用**。当前版本不会自动训练模型，也不会把所有对话自动升级为可信知识。

### 已经有 memory 或 agent 文档？

先预览将导入的内容：

```sh
ctx import
```

检查后再保存：

```sh
ctx import --apply
ctx knowledge --all
```

支持项目内的 `memory/`、`.memory/`、`.claude/`、`.zcode/`、`.cursor/`、`.curcor/`、`.codex/`，以及 `AGENTS.md`、`CLAUDE.md`、`MEMORY.md`、`.cursorrules` 等文本来源。它会记录来源并去重；重复导入相同内容不会创建新知识。

导入的内容保持候选状态，核验后才进入普通检索。beta.5 按段落、列表项（含缩进续行）和完整 Markdown 表格提取，保留 `headings`、`line`、`endLine`、正文指纹与来源文件指纹。开头的 YAML front matter 作为元数据跳过，不推断其中的 scope 或自动验证；代码围栏、生成指引和疑似敏感段落不进入候选。

`import` 只扫描目标项目，`--path` 是项目路径，不是待导入文件。用户目录或系统目录中的 `.zcode` 不会被自动扫描。没有来源文件时会返回 `discovery.status: no-source-files`、扫描范围和下一步指引；这不要求 agent 创建、复制或移动文件，也不应对相同输入反复重试。可把已读取且与本项目相关的结论直接保存为候选：

```sh
ctx learn "与本项目相关的结论" --path "项目目录" --evidence "原始记忆路径或代码证据"
```

MCP 对应 `context_learn`，接收 `path`、`statement`、`evidence` 和可选 `scope`。记录后仍须核验；导入不是必经步骤。

再次执行 `ctx import` 时，`changes` 展示相对上次 apply 的 `new / modified / removed / unchanged / partial / unavailable` 状态；`reviewRequired` 列出来源内容已变化或消失的旧知识 ID。核对代码后再决定是否退役或拒绝旧记录；来源变化不会自动改变已验证知识，旧结论在明确治理前仍可能被注入。新内容只作为候选保存，重复内容返回已有 ID 和状态，不会重新激活 rejected / deprecated 记录。

`--apply` 在 `.context/memory-import.json` 保存来源基线与待复核 ID，不保存文档原文；重复 apply 不清除未处理的复核提醒。该文件是治理记录，会进入升级备份。首次使用 beta.5 建立基线，不追溯之前版本的来源改动；旧版按行导入与新版整段提取的边界不同，首次预览可能出现新候选，需审阅后再 apply。

每次最多 500 个候选、2000 个目录条目、8 层目录、单文件 64 KiB、总正文 2 MiB；每块 20–1500 字符，超长块整体跳过。部分扫描、忽略规则和符号链接不会被当作来源删除，也不会覆盖已有基线。回执限 2000 个来源、10000 个块/待复核引用、4 MiB；损坏回执会报错并保留，不能静默覆盖。

扫描跳过 `.claude/worktrees` 和含 `.git` 边界的嵌套仓库；旧工作树或其它项目的文档不作为当前项目记忆。已有来源若进入这类边界，标为 unavailable，保留旧基线供审阅。

## 查看它是否真的有用

使用易读的终端报告：

```sh
ctx report --format ascii
```

报告展示已验证知识、显式复用记录、上下文输入/输出估算、日志体积和事件构成。需要程序处理时，使用默认返回 JSON 的 `ctx report`。

**检索到不等于采用，字符减少不等于模型账单减少。** 当前 token 使用字符数粗估，尚未接入模型提供商的实际用量；没有对照数据时，报告不能证明任务节省了多少 token 或时间。

## 数据保存在什么地方

- 项目状态和知识保存在本地 `.context/`，核心检索不需要云服务或模型 API key。
- `.contextignored` 用于配置要忽略的项目路径；默认过滤常见敏感文件。导入也会跳过疑似秘密行，但无法保证识别全部敏感内容，应用前应检查预览。
- 初始化可能修改项目的 `AGENTS.md`；Claude 集成会修改 `.claude/settings.json` 和 `.mcp.json`。
- 默认不开启文件监听。日志会分段压缩；可选观察有入库预算，但语义历史没有总容量硬上限。

CI 或不希望启动后台进程、写入宿主配置时，使用：

```sh
ctx init --no-start --no-integrations
```

## 遇到问题

| 情况 | 下一步 |
| --- | --- |
| 新项目没有可注入的内容 | 先保存一个真实 checkpoint，或导入并核验已有记忆 |
| 导入后查询不到知识 | 用 `ctx knowledge --all` 查看候选；核验后再执行 verify |
| agent 没有主动使用 ctx | 检查宿主是否加载项目指引、Hook 或 MCP；重连后确认工具可用 |
| 找不到项目或需要检查存储 | 执行 `ctx status`、`ctx doctor`；在其它目录操作时传入 `--path` |
| checkpoint 返回 `rate_limited` | 两次变化写入默认间隔至少 10 秒；到下一阶段再保存，避免循环重试 |
| 想停止本地运行时 | 临时停止用 `ctx runtime stop`；持续禁用自动启动用 `ctx runtime disable` |

从 0.8.0 升级前，请先阅读[升级步骤](CHANGELOG.md#从-080-升级)：停止旧进程并备份 `.context`。新版压缩日志不能与 0.8.0 混用，升级全局包后也需要重启旧 MCP 连接。

完整参数可通过 `ctx --help`、`ctx <command> --help` 查看。`compile` / `expand` 等高级命令用于需要更多来源详情或自行构建 agent 集成的场景，不是首次使用的必做步骤。

## 在代码中使用与参与开发

自建 agent 可以通过 npm 包调用相同能力：

```js
import { injectContext } from 'fluffy-context';

const context = await injectContext('/absolute/path/to/project', {
  query: '修复支付回调重复处理的问题',
  maxChars: 2400,
});
console.log(context.text);
```

开发本项目：

```sh
npm ci
npm test
npm run pack:check
```

本地全局验收使用 `npm run install:local`：构建 tarball、安装全局 ctx、核对文件哈希并保存安装回执。该命令会更新全局安装并初始化本仓库，不会发布到 npm。
