# Context Runtime

`fluffy-context` 是面向 AI 编程会话的本地 Context Runtime CLI。0.3.1 提供可重复、安全调用的任务定位入口、MCP 工具，以及 Claude Code 的阶段性工作流引导，让 Agent 不必自行拼接恢复、共识发现与短期记录。

它更接近“Context 的 Git”，而不是代码备份工具：Git 仍然负责代码和真实文件变更；Context Runtime 负责 AI 工作状态、已验证共识与交接信息的本地保存和恢复。

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
ctx deadend verify <deadend-id>
ctx status
ctx doctor
```

### `ctx checkpoint` 和 `ctx resume`

第一次 checkpoint 创建 baseline，后续变化创建 patch。相同内容返回 `no_change`；短时间内的变化可能返回 `rate_limited`，应在完成更多阶段工作后再保存。`ctx resume` 返回轻量摘要和按需使用的完整 details，并会保留其既有的 `lastUsedAt` 更新语义。

### `ctx note` 和 `ctx activity`

`ctx note add` 是开发过程中的低成本记录入口，不创建 Snapshot。阶段性 checkpoint 可通过 `--absorb-notes` 吸收当前 Context 的 open Note。`ctx activity` 提供只读的 Note 与 Snapshot 时间线，适合人类查看 Agent 的进度。

### Knowledge 与 Deadend

`ctx learn` 和 `ctx deadend` 默认创建 `candidate` 项。普通发现与 `ctx orient` 只使用已验证项目共识；候选项需要通过 `ctx knowledge verify` 或 `ctx deadend verify` 显式确认，或以 `--all` 审查。

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

0.3.1 聚焦单项目、本地优先的可靠闭环和 Agent 采用路径：有界 Orient、显式 checkpoint、确定性 Knowledge/Deadend discovery、MCP `context_orient` 与可选的 Claude Code Hook 集成。

远程同步、多人协作、复杂语义检索、自动模型总结、自动 checkpoint、Context merge，以及更多状态变更型 MCP 工具不属于当前版本范围。
