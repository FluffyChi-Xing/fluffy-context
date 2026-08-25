# Context Runtime

`fluffy-context` 正在从面向 AI 编程会话的本地 Context Runtime CLI，演进为 **Agent 无关的本地 Knowledge Runtime**。它负责自动捕获开发过程中产生的事件、候选共识、问题、不可达路径和分支工作状态，并向任意 Agent 注入有界、可验证的业务认知。

Git 仍然负责代码和真实文件变更，Issue 系统仍然负责任务，项目文档仍然负责设计；`fluffy-context` 补齐的是持续演进的项目认知层。最终架构是 `project → knowledge runtime → LLM`：CLI、MCP、Claude Hook 和未来 IDE/Agent 集成只是事件入口与信息注入适配器，而不是认知本体。

0.6.0 在 branch-aware 注入闭环上补齐了可治理的确定性检索：迁移并启用 Runtime 后，Orient 从 v2 journal 的可重建索引检索已验证、适用的 Knowledge 与 Deadend，并返回有界的选择、排除与截断说明。v1 的 checkpoint、Note、Knowledge 与 Deadend 写入仍会最佳努力镜像为 v2 事件；Runtime 也会协调检测到的外部 v1 变更。自动产物默认仍仅进入 Candidate，Verified Knowledge 仍需治理确认。

## 版本演进

| 版本 | 主要能力 | 关键特点 |
| --- | --- | --- |
| 0.1.0 | 本地 Context CLI、baseline/patch Snapshot、resume、Note、Candidate Knowledge/Deadend | Git 继续作为代码权威；Context 只保存有界任务状态，不复制项目文件；checkpoint 显式触发且支持 no-op、限流与敏感路径过滤。 |
| 0.2.0 | 确定性 Knowledge Discovery、Agent TypeScript API、可安装 Skill | Candidate 与 Verified 分离；默认只注入已验证共识；不依赖向量库、模型或远端服务。 |
| 0.3.x | MCP `context_orient`、Claude Code Hook 与集成配置生成 | 通过 stdio MCP 和 fail-open Hook 降低 Agent 主动调用成本；集成安装仅在 `--apply` 时写入项目配置。 |
| 0.4.0 | v2 事件 journal、v1 显式迁移、可重建投影、本地 Runtime、Git 观察 | v2 与 v1 并存；NDJSON hash chain 是 v2 权威；Runtime 仅监听 loopback 并记录分支、ref 与 HEAD 元数据。 |
| 0.5.0 | branch-aware Orient、v1 写入镜像、Runtime 协调、宿主事件捕获 | Context 按当前 worktree/ref 选择，避免跨分支任务状态泄漏；稳定宿主 ID 才会写入限长、脱敏后的 session/prompt intent。 |
| 0.6.0 | journal 派生的确定性检索、治理终态、可解释 Orient、显式使用反馈 | 启用 v2 后直接从可重建索引检索已验证且适用的共识；使用反馈只影响稳定排序，绝不自动验证或提升 Candidate。 |

所有版本均保持本地优先、显式治理与 fail-open 集成原则。v1 数据不会在迁移过程中被重写；当 v2 未启用、不可用、损坏或尚未同步时，读取接口会回退到兼容的 v1 行为。

## 适用场景

- 下班前保存当前任务状态，下一次会话继续工作。
- 以有界摘要恢复进行中的任务，降低重复阅读和 Token 消耗。
- 让 Agent 在开始任务时获得已验证 Knowledge、匹配 Deadend 与未吸收 Note。
- 通过 MCP 或 Claude Code Hooks 降低 Agent 主动调用 Context 工具的决策成本。
- 记录完成项、待办、阻塞、决策、风险与已验证不可行的方案。

## 环境要求

- Node.js `>=20.19.0`
- Git 可选。项目在 Git 仓库内时，CLI 会记录分支与 commit。

## 安装

```bash
npm install --global fluffy-context
ctx --help
```

也可以在项目目录中使用：

```bash
npx fluffy-context --help
```

## 快速开始

在项目根目录初始化：

```bash
ctx init
```

这会创建本地 `.context/` 存储和 `.contextignored` 规则文件。保存阶段性工作：

```bash
ctx checkpoint \
  --title "订单状态机重构" \
  --progress "完成状态流转梳理，正在补充异常路径测试" \
  --completed "梳理状态转移,确认幂等策略" \
  --pending "补充异常路径测试,运行集成测试" \
  --decisions "订单状态由服务端状态机统一维护" \
  --risks "第三方回调可能重复到达" \
  --files "src/order/state-machine.ts,src/order-state-machine.test.ts"
```

新会话中，Agent 或宿主优先使用：

```bash
ctx orient "订单状态机异常路径" --max-chars 4000
```

`ctx orient` 只读地聚合当前 Context 摘要、与查询匹配的**已验证** Knowledge 和 Deadend，以及当前 Context 尚未吸收的 Note。它不更新 `lastUsedAt`、不创建 Snapshot，也不会记录 usage 噪声。省略查询时可只恢复当前任务和 open Notes：

```bash
ctx orient
ctx orient --context <context-id> --note-limit 10
```

## Agent 工作流

推荐阶段：

```text
Orient → Plan → Implement → Verify → Handoff
```

1. **Orient**：调用 `ctx orient` 或 MCP `context_orient`，读取有界任务上下文。
2. **Plan**：在广泛改动前先形成可执行计划。
3. **Implement**：用 `ctx note add` 记录有价值的观察、决策、阻塞或行动；不要为每条记录创建 Snapshot。
4. **Verify**：执行适用的构建和测试，并把有意义的失败记录为 Note。
5. **Handoff**：任务阶段结束时显式运行一次 `ctx checkpoint`，记录完成项、待办、决策和风险；Hook 不会自动 checkpoint。

## 常用命令

业务命令默认输出格式化 JSON；帮助输出为纯文本。错误写入标准错误并返回非零退出码。`ctx --version` 输出一个 JSON 字符串。

```bash
ctx init
ctx checkpoint --title "修复支付回调" --progress "已定位签名校验失败原因"
ctx resume --max-chars 2000
ctx orient "支付回调" --knowledge-limit 5 --deadend-limit 3
ctx note add "测试环境缺少回调凭据" --kind problem --context <context-id>
ctx activity --context <context-id> --open
ctx knowledge discover "支付回调"
ctx knowledge verify <knowledge-id>
ctx knowledge deprecate <knowledge-id> --reason "已被新的结论取代"
ctx deadend verify <deadend-id>
ctx deadend obsolete <deadend-id> --reason "当前架构已不再适用"
ctx feedback use knowledge <knowledge-id> --event-id <stable-id>
ctx journal verify
ctx migrate v1 --dry-run
ctx migrate v1 --apply
ctx migrate verify
ctx runtime enable
ctx runtime start
ctx runtime status
ctx runtime stop
ctx status
ctx doctor
```

### v2 迁移与本地 Runtime

v2 与既有 `.context/` 数据并存，迁移绝不会重写或修复 v1 文件。先执行只读检查，再显式导入并验证投影一致性：

```bash
ctx migrate v1 --dry-run
ctx migrate v1 --apply
ctx migrate verify
```

只有完成迁移后才可启用 Runtime：

```bash
ctx runtime enable
ctx runtime start
ctx runtime status
ctx runtime stop
ctx runtime disable
```

Runtime 是单项目、按需启动的本地守护进程。它只绑定 `127.0.0.1` 的动态端口，并要求存储在项目本地 `.context/v2/runtime/secret` 中的能力令牌；令牌不会显示在 CLI 状态输出或写入事件日志。启动后，Runtime 持续观察当前 worktree 的 Git 状态：初始状态会记录 `git.state.observed`，分支/ref 切换记录 `git.branch.changed`，HEAD 更新记录 `git.head.changed`。这些事件会重建 branch workspace 投影，但不会自动创建 checkpoint 或将候选信息提升为已验证共识。

完成迁移并显式 `ctx runtime enable` 后，`ctx orient`、MCP `context_orient` 与 Claude Hook 会优先选择当前 worktree/ref 的 v2 workspace；它不会借用其他分支的 Context。v2 可用时，Knowledge 与 Deadend 由 journal 重放出的确定性倒排索引直接检索，默认仅返回已验证且适用的记录；无匹配 workspace、v2 状态不可用、journal 损坏、v1 尚未同步或 Runtime 已禁用时，接口会安全回退到既有 v1 选择逻辑。Runtime 停止时仍可读取已验证的 v2 状态，但运行中的 Runtime 负责持续 Git 观察和 v1 写入镜像。

Claude Hook 仅在宿主提供稳定的 session 与 event 标识时记录 `host.session.started` 或 `host.prompt.submitted`。提示只保存按 `promptIntentMaxChars` 截断并经过敏感值脱敏后的 intent，绝不保存原始提示；缺少稳定标识时不写入事件。默认 Hook 不启动守护进程；将 v2 policy 的 `allowHookStartup` 设为 `true` 后，SessionStart 才会在严格超时内尽力启动 Runtime，失败仍会 fail open。UserPromptSubmit 不会启动 Runtime。

### `ctx checkpoint` 和 `ctx resume`

第一次 checkpoint 创建 baseline，后续变化创建 patch。相同内容返回 `no_change`；短时间内的变化可能返回 `rate_limited`，应在完成更多阶段工作后再保存。`ctx resume` 返回轻量摘要和按需使用的完整 details，并会保留其既有的 `lastUsedAt` 更新语义。

### `ctx note` 和 `ctx activity`

`ctx note add` 是开发过程中的低成本记录入口，不创建 Snapshot。阶段性 checkpoint 可通过 `--absorb-notes` 吸收当前 Context 的 open Note。`ctx activity` 提供只读的 Note 与 Snapshot 时间线，适合人类查看 Agent 的进度。

### Knowledge 与 Deadend

`ctx learn` 和 `ctx deadend` 默认创建 `candidate` 项。普通发现与 `ctx orient` 只使用已验证项目共识；候选项需要通过 `ctx knowledge verify` 或 `ctx deadend verify` 显式确认，或以 `--all` 审查。验证后的 Knowledge 可用 `ctx knowledge deprecate` 退役，候选项可用 `ctx knowledge reject` 拒绝；验证后的 Deadend 可用 `ctx deadend obsolete` 退役，候选项可用 `ctx deadend reject` 拒绝。终态记录保留证据与治理原因，但不会被默认注入。

新记录默认具有 `global` 适用性。需要限制到当前 worktree/ref 时，可使用 `--branch-mode exact`；`--paths` 只保存精确项目相对路径约束，当前版本不会推断目录前缀、Git 祖先关系、依赖关系或语义相似路径。`ctx orient` 的 `explanation` 字段会有界地给出 v2/v1 选择方式、排除计数和各类别截断原因。

`ctx feedback use knowledge|deadend ... --event-id <stable-id>` 只记录一个幂等的 v2 使用信号。它只作为同等词法相关性结果的确定性排序因素，永不改变验证状态、confidence、evidence 或适用性；Orient、MCP 与 Hook 不会隐式写入该信号。

```bash
ctx learn "订单取消后不能再次进入支付中状态" --scope project
ctx deadend --attempt "使用共享可变单例保存订单状态" --reason "并发测试出现跨用例状态泄漏"
ctx knowledge discover "订单取消"
```

## MCP 集成

`ctx agent serve` 启动一个 MCP stdio server，暴露一个工具：`context_orient`。该 server 的标准输入和输出均属于 MCP 协议，不能在交互式终端直接使用或混入日志。

```bash
ctx agent serve
```

`context_orient` 接受可选的 `path`、`contextId`、`query`、`scope`、`maxChars`、`knowledgeLimit`、`deadendLimit` 和 `noteLimit`。它的结果与 `ctx orient` 相同：`ready` 是成功的任务定位结果，初始化但没有可恢复 Context 时返回成功的 `no_context`。输入验证或 Runtime 错误为单次工具错误，不会终止 server。

## Claude Code 集成

先查看项目是否需要安装集成：

```bash
ctx integrate claude inspect
ctx integrate claude install
```

`install` 默认只输出预览，不创建或修改文件。确认后才显式写入：

```bash
ctx integrate claude install --apply
```

安装会以幂等方式合并项目本地配置：

- `.claude/settings.json`：`SessionStart` 与 `UserPromptSubmit` Hook，分别调用 `ctx hook claude-code session-start` 和 `ctx hook claude-code user-prompt`。
- `.mcp.json`：名为 `fluffy-context` 的 stdio MCP server，调用 `ctx agent serve`。

安装会保留无关的 Hook、权限和 MCP server；遇到无效 JSON、无效相关结构或同名冲突配置会拒绝覆盖。Hook 仅注入有界的 Orient/Plan/Implement/Verify/Handoff 指引，输入损坏、项目未初始化或查询失败时会 fail open，不阻塞 Claude Code 任务，也不会自动创建 checkpoint。

## TypeScript Agent API

使用公开包入口，不要导入内部 `dist/...` 文件：

```ts
import { contextOrient, loadContext, saveContext, searchContext } from 'fluffy-context';

const orientation = await contextOrient(process.cwd(), {
  query: 'payment callback',
  maxChars: 2400,
});
```

`fluffy-context/agent` 提供相同的 Agent API。公开类型声明随包发布。Runtime 的存储布局与内部模块不是兼容性承诺。

## `.contextignored` 与安全边界

`.contextignored` 语法接近 `.gitignore`，用于排除不应作为关联文件保存的项目路径：

```gitignore
private/
*.generated.ts
notes/draft-*
```

内置保护规则优先，不能被否定规则绕过：`.context/`、`.git/`、依赖和构建目录、`.env` 文件、密钥、常见 credential/token 文件、绝对路径和 `..` 越界路径都不会被作为 Context 关联文件保存。

## 开发与发布验证

```bash
npm install
npm run build
npm test
npm run pack:check
npm pack --dry-run --json
```

运行时依赖 `@modelcontextprotocol/server` 与 `zod` 以提供 MCP 适配；核心 Context 存储仍然保持本地优先。`prepack` 会重新构建发布产物，`prepublishOnly` 在未来手动发布前运行测试；这些命令不会发布 npm 包。

## 当前范围

0.6.0 聚焦单项目、本地优先、可治理的 branch-aware Knowledge Runtime MVP：有界且可解释的 Orient、显式 checkpoint、journal 派生的确定性 Knowledge/Deadend 检索、终态治理、显式使用反馈、MCP `context_orient`、可选 Claude Code Hook，以及 v1 到 v2 的显式事件日志迁移和 Git-aware 本地 Runtime。完成迁移并启用 Runtime 后，Orient、MCP 与 Hook 使用当前 worktree/ref 的 workspace 选择分支正确的 Context，并在 v2 不可用时保持 v1 回退；Runtime 负责可靠捕获生命周期、Git 元数据与后续 v1 写入镜像。带稳定宿主标识的 Hook 事件仅以脱敏、限长 intent 进入 journal。

远程同步、多人协作、复杂语义检索、自动模型总结、自动 checkpoint、Context merge、自动验证候选共识，以及更多状态变更型 MCP 工具不属于当前版本范围。
