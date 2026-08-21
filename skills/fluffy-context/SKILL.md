---
name: fluffy-context
description: 使用 fluffy-context（ctx）CLI 管理 AI 编程会话的本地上下文。需要初始化项目、保存或恢复工作状态、查看 Context、运行 doctor、记录项目知识或验证死路时使用；也用于排查 ctx 在 Windows、npm 全局安装、.contextignored、Snapshot patch、10 秒限流和 JSON 输出方面的问题。
compatibility: 需要 Node.js >=20.19.0；Git 可选。CLI 通过 npm 全局安装后提供 ctx 命令。
---

# fluffy-context CLI Skill

使用 `ctx` 保存和恢复 AI 编程任务的结构化工作状态。它保存的是 Context、Snapshot、Knowledge 和 Deadend，不是项目代码备份；Git 仍是代码与真实文件变更的权威来源。

## 使用原则

- 先确认当前工作目录是否是目标项目；不确定时显式传入 `--path <project-path>`。
- 开始使用前运行 `ctx init`，不要手工创建 `.context` 文件。
- 下班交接或完成一个阶段时运行 `ctx checkpoint`，不要为了每条消息频繁保存。
- 开发过程中遇到问题、找到解决措施、做出临时决策或发现重要观察时，Agent 应优先使用低成本的 `ctx note add`，不要为了单条记录创建 Snapshot。
- 人类需要了解 Agent 发生了什么时使用 `ctx activity`；它是只读时间线，不要求人类参与 Agent 的高频记录操作。
- 新会话优先运行 `ctx resume --max-chars <预算>`，先看摘要，再按需读取 `details`。
- 普通查询只使用已验证 Knowledge 和 Deadend；需要审查候选项时显式使用 `--all`。
- CLI 业务命令的标准输出是 JSON；错误写入标准错误并返回非零退出码。解析输出时不要把 `--help` 的纯文本当作 JSON。

## 快速工作流

```text
ctx init
  ↓
ctx checkpoint --title ... --progress ...
  ↓
ctx resume --max-chars 4000
  ↓
ctx learn ... / ctx deadend ...
  ↓
ctx knowledge verify ... / ctx deadend verify ...
```

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
ctx learn "订单取消后不能再次进入支付中状态" \
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
ctx deadend \
  --attempt "使用共享可变单例保存订单状态" \
  --reason "并发测试出现跨用例状态泄漏" \
  --scope project \
  --context <context-id> \
  --snapshot <snapshot-id> \
  --evidence "test/order-state.test.ts"
```

查询和确认：

```bash
ctx deadends
ctx deadends --all
ctx deadend verify <deadend-id>
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
npm install --global .
ctx --version
```

如果项目包名已经是 `fluffy-context`，也可以确认：

```bash
npm install --global fluffy-context
```

但这会安装 registry 上的已发布版本；开发当前代码时应使用 `npm install --global .`。

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

`ctx --help` 和 `ctx --version` 是面向终端用户的文本输出；业务命令返回 JSON。脚本应根据命令区分处理：

```bash
ctx --help
ctx --version
ctx status | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)))"
```

### 6. 参数包含空格或中文

在 shell 中将每个带空格的值整体加引号：

```bash
ctx checkpoint --title "支付回调修复" --progress "已定位签名校验失败原因"
ctx learn "订单取消后不能再次进入支付中状态"
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
[ ] resumeSummary 受 --max-chars 限制
[ ] .contextignored 排除敏感和越界路径
[ ] Knowledge candidate → verified
[ ] Deadend candidate → verified
[ ] 不存在的来源被拒绝
[ ] 未知参数返回非零退出码
```

所有命令都应在测试项目或明确指定的 `--path` 下运行，避免把验收数据写入真实项目。
