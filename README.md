# fluffy-context

**让项目记住 AI 已经做过的工作，让下一次对话接着往下走。**

换一个会话或换一个 AI 编程工具，你往往需要重新解释：任务进行到哪里、为什么这样设计、哪些方法已经试过。fluffy-context 把这些信息保存在项目里，在新任务开始时取出相关内容，交给 agent 使用。

它是 LLM 与项目之间的一层本地记忆：保存工作进度，积累经过验证的项目知识，按当前任务提供有长度预算的上下文。CLI 命令是 `ctx`，也提供 MCP 和 JavaScript / TypeScript API。

> 本文对应 **1.0.0-beta.1**。稳定通道仍为 0.8.0；以下新工作流需要安装 beta。[升级说明与已知限制](CHANGELOG.md) · [1.0 后续计划](ROADMAP-1.0.md)

当前源码开发包为 **1.0.0-beta.2-dev.0**，新增下述 `ctx upgrade`；已发布的 beta.1 不含这个命令。

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

新项目还没有记忆，第一次返回内容很少是正常的。ctx 不会仅凭一次初始化就理解整个代码库。

### 2. 完成一个阶段后，留下进度

例如，你已经定位问题，但还没写完测试：

```sh
ctx checkpoint --title "支付回调修复" --progress "已定位重复回调导致重复扣款" --completed "复现问题,确认幂等键缺失" --pending "补充幂等处理,运行回归测试" --decisions "使用订单号和事件号作为幂等键"
```

下次换会话或换工具，再执行 `ctx inject "继续支付回调修复"`，agent 就能从保存的状态继续。

这些命令返回 JSON，方便 agent 和脚本读取。你也可以直接在终端使用。

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

先接入三个工具就能形成日常闭环：`context_inject` 取得上下文，`context_checkpoint` 保存进度，`context_import` 导入已有记忆。工具列表和输入参数由 MCP 服务提供。

## 让工作经验变成可复用的知识

进度回答“做到哪里了”，知识回答“下次遇到类似问题应该知道什么”。两者需要分别保存。

例如，你通过代码和测试确认了项目约束，可以记录结论及证据：

```sh
ctx learn "支付回调必须在同一事务中写入幂等记录和更新订单状态" --evidence "src/payment/callback.ts,test/payment/callback.test.ts"
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

导入的内容保持候选状态，核验后才进入普通检索。当前采用有限长度的文本行抽取，复杂多段结构可能需要人工整理。

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
