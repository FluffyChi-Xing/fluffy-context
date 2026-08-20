# Context Runtime

Context Runtime 是一个面向 AI 编程会话的本地上下文运行时 CLI。它把一次任务的进度、决策、待办、风险、知识和已验证死路保存为可恢复的结构化状态，帮助 Agent 在新会话中快速完成交接，而不是重新阅读大量项目内容。

它更接近“Context 的 Git”，而不是代码备份工具：Git 仍然负责代码和真实文件变更，Context Runtime 负责 AI 工作状态的版本化保存与恢复。

## 适用场景

- 下班前保存当前任务状态，第二天继续工作。
- 保存完成项、待办、阻塞、决策和风险。
- 将可复用业务知识独立记录，并在确认后纳入知识库。
- 记录已经验证不可行的方案，避免新会话重复探索。
- 通过摘要预算恢复上下文，减少不必要的 Token 消耗。

## 环境要求

- Node.js `>=20.19.0`
- Git 可选。项目位于 Git 仓库内时，CLI 会记录当前分支和 commit 信息。

## 安装

发布后可以使用 npm 全局安装：

```bash
npm install --global fluffy-context
```

也可以在项目目录中直接运行：

```bash
npx fluffy-context --help
```

## 快速开始

在项目根目录初始化 Context Runtime：

```bash
ctx init
```

这会创建以下本地文件：

```text
.context/
├── manifest.json
├── index.json
├── contexts/
├── locks/
├── knowledge.json    # 首次使用 learn 后创建
└── deadends.json     # 首次使用 deadend 后创建
.contextignored
```

保存一次工作状态：

```bash
ctx checkpoint \
  --title "订单状态机重构" \
  --progress "完成状态流转梳理，正在补充异常路径测试" \
  --completed "梳理状态转移,确认幂等策略" \
  --pending "补充异常路径测试,运行集成测试" \
  --decisions "订单状态由服务端状态机统一维护" \
  --risks "第三方回调可能重复到达" \
  --files "src/order/state-machine.ts,src/order/state-machine.test.ts"
```

第二天恢复：

```bash
ctx resume
```

`resume` 默认返回轻量摘要，同时保留完整详情供按需使用。可以限制摘要字符数：

```bash
ctx resume --max-chars 2000
```

## 常用命令

### `ctx init`

初始化项目的 Context Runtime 存储布局。重复执行是幂等的，不会覆盖已有 Context 或项目忽略规则。

```bash
ctx init
ctx init path/to/project
ctx init --path path/to/project
```

### `ctx checkpoint`

保存结构化工作状态。第一次保存创建 baseline，后续有变化时保存 patch；内容没有变化时返回 `no_change`。

```bash
ctx checkpoint \
  --context <context-id> \
  --title "修复支付回调" \
  --progress "已定位签名校验失败原因" \
  --last-error "测试环境缺少回调凭据" \
  --completed "复现问题,确认签名字段" \
  --pending "补充回归测试" \
  --decisions "保留原始请求体用于验签" \
  --risks "旧版客户端字段格式不同" \
  --files "src/payment/webhook.ts"
```

列表参数使用逗号分隔。`--context` 省略时会创建新的 Context。默认情况下，实际保存之间至少间隔 10 秒；短时间内有变化的保存会返回 `rate_limited`，没有变化则返回 `no_change`。

### `ctx resume`

恢复一个 active 或 stable Context。默认优先选择当前分支上最近更新的 Context，并返回 Git 分支/commit 是否发生漂移。

```bash
ctx resume
ctx resume --context <context-id>
ctx resume --path path/to/project --max-chars 4000
```

### `ctx status`

查看项目是否已初始化以及当前 Context 索引：

```bash
ctx status
```

### `ctx doctor`

检查 Manifest、存储目录、索引、Context 元数据、当前 Snapshot 和索引重建一致性：

```bash
ctx doctor
```

### `ctx learn`

记录一条待确认的项目知识。Knowledge 默认是 `candidate`，不会进入普通的已验证知识列表。

```bash
ctx learn "订单取消后不能再次进入支付中状态" \
  --scope project \
  --context <context-id> \
  --snapshot <snapshot-id> \
  --evidence "src/order/state-machine.ts,订单服务接口约束"
```

查看和确认知识：

```bash
ctx knowledge
ctx knowledge --all
ctx knowledge verify <knowledge-id>
```

不提供 `--context` 时，知识仍可以记录为项目级候选知识；如果提供来源，则对应 Context 和 Snapshot 必须存在。

### `ctx deadend`

记录一条已尝试但不可行的路径。Deadend 默认是 `candidate`，不会默认注入恢复摘要。

```bash
ctx deadend \
  --attempt "使用共享可变单例保存订单状态" \
  --reason "并发测试出现跨用例状态泄漏" \
  --scope project \
  --context <context-id> \
  --evidence "test/order-state.test.ts"
```

查看和确认死路：

```bash
ctx deadends
ctx deadends --all
ctx deadend verify <deadend-id>
```

## `.contextignored`

`ctx init` 会在项目根目录创建 `.contextignored`。它用于配置不应作为上下文关联文件保存的路径，语法接近 `.gitignore`：

```gitignore
# 私有目录
private/

# 本地生成文件
*.generated.ts

# 不纳入上下文的临时记录
notes/draft-*
```

内置保护规则始终优先，包括 `.context/`、`.git/`、依赖目录、构建产物、环境变量文件、密钥和常见凭据文件。项目规则不能通过否定规则覆盖这些保护。

## 存储与安全边界

- Snapshot 按 baseline/patch 保存，不会每次复制整个项目文件树。
- `index.json` 是可重建索引，不是唯一业务数据来源。
- Context、Knowledge、Deadend 使用独立文件保存。
- 写入使用临时文件替换，并通过项目级锁避免并发覆盖。
- 默认只恢复摘要字段；完整结构化内容位于 `details` 中按需读取。
- CLI 不会读取或保存被内置保护规则排除的文件内容。

## 命令输出

CLI 默认向标准输出写入格式化 JSON，适合被脚本、Agent 或 IDE 集成：

```bash
ctx --help
ctx --version
```

错误信息写入标准错误，并以非零退出码结束。

## 开发

安装依赖并运行测试：

```bash
npm install
npm test
```

只构建 TypeScript：

```bash
npm run build
```

本项目核心运行时只依赖 Node.js 内置模块，当前没有运行时第三方依赖。

## 当前范围

当前版本聚焦本地单项目的可靠闭环：

```text
init → checkpoint → resume
```

并提供基础的 Knowledge、Deadend、忽略规则、诊断、Snapshot 增量保存、摘要预算和保存限流能力。远程同步、多人协作、复杂语义检索、自动模型总结和 Context merge 不属于当前版本的已实现能力。
