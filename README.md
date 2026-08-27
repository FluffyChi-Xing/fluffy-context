# fluffy-context

本地优先、Agent 无关的 Context 与 Knowledge Runtime，帮助 AI 编程 Agent 保存任务状态、恢复工作上下文、复用已验证共识，并生成有界且可追溯的上下文输入。

**当前版本：0.7.4**

```text
checkpoint → orient → compile → Agent continues
```

`fluffy-context` 保存的是任务认知，不是项目代码备份。Git 仍是代码和文件变更的权威；Issue 系统、项目文档、`CLAUDE.md`、`AGENTS.md`、Skills 和 MCP 仍由各自系统维护。

## 30 秒了解

最常用的四类操作：

- `ctx checkpoint`：保存进度、完成项、待办、决策、风险和关联文件。
- `ctx orient`：只读恢复当前任务，并检索匹配的已验证 Knowledge、Deadend 和 open Note。
- `ctx compile`：生成带预算、来源和排除原因的 provider-neutral Context Manifest。
- `ctx learn` / `ctx deadend`：记录可复用结论和失败方案，之后显式验证再用于普通检索。

## 0.7.4 当前能力与边界

| 能力 | 当前支持 |
| --- | --- |
| Context | 初始化、结构化 checkpoint、baseline/patch Snapshot、resume |
| 检索 | `orient`、已验证 Knowledge/Deadend 检索、当前 Context 的 open Note |
| Compiler | 确定性排序、字符预算、截断信息、provenance、纳入/排除原因 |
| Manifest identity | `level`、`itemHash`、`manifestHash`、estimated token |
| 文件活动 | 可选记录经过过滤的文件 metadata，并编译为 `activity` section |
| Runtime | 本地 v2 Runtime、Git 观察、可选文件观察、自动唤醒和 fail-open 集成 |
| 治理 | Knowledge/Deadend 的 candidate、verify、deprecate/obsolete、reject |
| 集成 | Claude Code Hook、Claude Code 配置集成、MCP `context_orient`、TypeScript Agent API |

以下能力**不属于 0.7.4**：

- 没有 `context_expand`，Compiler 的 `level` 和 `expandable` 目前是稳定契约字段，不代表已有按需展开工具。
- 没有 `ctx clean` 或 `ctx report`。
- 不自动创建 checkpoint、Note、Knowledge 或 Deadend。
- 不自动把 Candidate 提升为 Verified。
- 不提供模型总结、Embedding/向量检索、远程同步、多人协作或 Context merge。

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
npm install --global .
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

初始化会创建本地 `.context/` 存储和 `.contextignored` 规则文件。重复执行是幂等的，不会覆盖已有 Context 或忽略规则。

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

0.7.4 的候选项提供：

```text
level: signal | summary | structured | evidence
itemHash
 tokenEstimate
expandable
```

当前实际生成的候选项默认是 `summary` 层。`itemHash`、`manifestHash` 和 estimated token 可用于缓存、去重、审计和结果校验；token 是按字符估算的 provider-neutral 数值，不是真实 Provider 计费结果。

Compiler 具有以下边界：

- 相同输入得到确定性的排序、截断和 hash；
- `maxChars` 使用 JavaScript UTF-16 字符串长度；
- 不调用模型；
- 不写入 Context 或 journal；
- 普通查询默认只纳入适用且已验证的 Knowledge 和 Deadend；
- 0.7.4 没有 `context_expand` CLI、Agent API 或 MCP 工具。

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

## CLI 能力地图

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

0.7.4 当前只暴露一个工具：

```text
context_orient
```

支持的输入字段：

```text
path
contextId
query
scope
maxChars
knowledgeLimit
deadendLimit
noteLimit
```

结果语义与 CLI/Agent API 的 `contextOrient` 一致：

- `ready`：找到可恢复的 Context；
- `no_context`：项目已初始化但没有可恢复 Context，这是成功结果；
- 输入验证或调用错误：返回单次工具错误，server 继续运行。

MCP 的 stdin/stdout 属于协议通道，不能混入日志或交互文本。当前没有 `context_expand`，也没有其他 `context_*` 工具。

## TypeScript Agent API

使用公开包入口，不要导入内部 `dist/...` 路径，也不要直接读写 `.context`：

```ts
import {
  contextOrient,
  compileContext,
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
saveContext
loadContext
searchContext
recordContextUse
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

以下方向属于后续版本，不是 0.7.4 的当前能力：

| 方向 | 目标 |
| --- | --- |
| Context expansion | 通过 Manifest hash 和 item ID 按需取得更高层级内容 |
| Decision Graph | 将决策变成可治理、可追溯的一等对象 |
| Knowledge Evolution | 支持知识合并、替代、范围演化和 review-needed 信号 |
| Journal maintenance | 提供安全的清理、归档和长期运行维护能力 |
| Usage reporting | 统计估算 token、编译、展开、检索和反馈覆盖情况 |
| 外部协作 | 远程同步、多人协作和团队权限 |

这些方向不会改变当前的边界：Git、项目文档和宿主规则继续由各自系统负责；Candidate 仍需要显式治理；模型调用和远程服务不是核心 Runtime 的隐式依赖。

## License

MIT
