# fluffy-context · beta.12

**把任务进度、项目约束和经过验证的经验留在项目中，让下一次 AI 会话接着做。**

fluffy-context 是面向 AI 编程工作的本地上下文工具，命令为 `ctx`。它通过 CLI、MCP 和 JavaScript / TypeScript API，为当前任务提供有预算、可追溯、可按需展开的上下文。代码由 Git 管理；ctx 保存工作状态和项目知识，不是代码备份工具。

当前仓库版本为 **1.0.0-beta.12**，作为下一次对外 beta 的候选；beta.11 仅用于内部修复验证。本文不表示 beta.12 已发布到 npm，安装时请明确选择下方的候选包或已发布的精确版本。

## beta.12 带来了什么

| 能力 | 使用方式 | 需要知道的边界 |
| --- | --- | --- |
| 结构化交接 | 保存目标、硬约束、进度、待办、验证引用和开放问题 | 历史验证记录不代表当前代码已通过测试 |
| 按需展开证据 | `inject` 返回完整 `expandRefs`，直接交给 `expand` | 旧引用失效时重新 inject，不手工修改哈希 |
| 来源变化感知 | 已跟踪导入来源发生变化或消失时，撤回相关旧结论并要求复核 | 历史 verified 状态保留；未知来源不等于最新来源 |
| 会话增量交付 | 同一任务去重、增量发送，必要时替换旧证据 | 调用方必须处理 `replacePrevious`，丢失上下文后 reset |
| 可解释预算与报告 | 正文、引用分别限额，记录展开、复核和替换 | 调用次数和字符数不等于模型采用或真实 token 节省 |
| 后台启动诊断 | 独立 runtime worker、启动阶段记录、退出诊断与 Windows 写入重试 | 公司项目的原 beta.10 启动故障仍待现场复测 |

本地串行回归已通过 200 项测试；Zcode 已回传 CLI/MCP 展开、来源治理以及新会话 MCP resume 接手通过。原指定 Context 的完整 handoff → expand → 只读下一步仍可补充覆盖。详细记录见 [本地验证](docs/BETA12-LOCAL-VALIDATION.md)、[Zcode 验收结果](docs/ZCODE-BETA12-ACCEPTANCE-RESULTS.md)及[迭代方案](docs/BETA12-CONTEXT-ENGINEERING-PLAN.md)。这些链接在源码仓库中查看。

## 从旧 beta 升级到 beta.12

**安装 CLI 包和升级项目数据是两件事：`npm install` 更新程序；`ctx upgrade` 备份并升级当前项目的数据，不会下载新版程序。** 不需要先安装内部 beta.11。

需要 Node.js **20.19.0 或更高版本**。以下以 Windows PowerShell 为例；将示例项目路径与包路径替换为实际值。每一步成功后再执行下一步，失败时保留输出，不要继续覆盖安装或反复 start。

### 1. 确认环境，停止旧版本

先关闭使用该项目的 agent、Hook 和 MCP 会话，避免升级期间自动拉起 runtime 或继续写入。若多个项目共用这份全局安装，应在替换包前逐个停止其 runtime。

```powershell
Set-Location 'D:\your-project'
node --version
npm --version
Get-Command ctx -All
npm root --global
ctx --version
ctx runtime status
ctx runtime stop
ctx runtime status
```

确认停止成功。旧版本只有 `running` 字段时，应为 `false`；存在旧租约或停止报错时先保留现场并排查，不通过删除 `.context` 或租约文件强行继续。特别重要的项目可在停止所有写入后另行复制整个 `.context` 目录作为独立备份。

**nvm 用户先选定后续使用的 Node 版本。** 不同 Node 版本可能有独立全局安装；切换后 `ctx` 消失不表示项目数据丢失。应在切换前停止旧 runtime，并在目标 Node 环境重新安装。若已经切换且找不到 ctx，先切回原 Node 环境停止旧实例，再切回目标环境安装，不要初始化一份新数据来代替旧项目。

### 2. 安装 beta.12：选择一种来源

**候选包试用（尚未发布时使用）：** 获取维护者交付的 `.tgz` 和对应 SHA256，在本机核对后安装。以下路径为示例，不是下载地址。

```powershell
$candidateTarball = 'D:\downloads\fluffy-context-1.0.0-beta.12-<hash>.tgz'
Get-FileHash -Algorithm SHA256 -LiteralPath $candidateTarball
npm install --global "$candidateTarball" --ignore-scripts
```

同一 beta 版本的候选包可能因修订重新打包，**以本次交付的哈希为准**，不要只比较版本号。全局安装会替换当前 Node 环境中的旧包。

**npm 精确版本（仅在正式发布后使用）：**

```powershell
npm view fluffy-context@1.0.0-beta.12 version
npm install --global fluffy-context@1.0.0-beta.12
```

如果查询返回版本不存在，使用交付的候选包，不要退回 `@beta` 并将它当作 beta.12。`@beta` 是可移动标签，可能仍指向旧版本，也可能已指向后续版本。

安装后确认实际命中的命令与版本：

```powershell
Get-Command ctx -All
npm root --global
ctx --version
```

期望版本为 `1.0.0-beta.12`。若版本不符，先检查 PATH、多个 Node 安装和命令缓存；暂不重连 MCP。

### 3. 用新 CLI 升级每个已有项目的数据

仍在原项目目录执行：

```powershell
ctx upgrade --dry-run
ctx upgrade
ctx doctor
ctx journal verify
ctx status
```

- `--dry-run` 只预览数据、校验与备份大小，不写入、不停止 runtime。
- 正式升级创建 `.context/backups/upgrade-*/`，保存 `data/`、哈希清单 `backup.json` 和成功回执 `upgrade.json`，保留任务、知识状态及事件历史。
- 每次正式升级都会生成独立备份；备份需要额外磁盘空间。重复升级不会重复导入相同数据。
- 校验失败会报错并保留现场，不会自动覆盖还原。不要删除历史目录来消除错误。
- `upgrade` 恢复的是调用它之前的 runtime 运行状态。**第 1 步已手动停止，所以升级完成后仍需按下一步显式启动。** 禁用策略保持不变。

不在项目目录时，为每条命令添加 `--path 'D:\your-project'`。全局包只需安装一次，数据升级与核验需要对每个项目分别进行。

### 4. 启动、确认心跳，再重连宿主

对原本启用 runtime 的项目执行：

```powershell
ctx runtime start
ctx runtime status
Start-Sleep -Seconds 5
ctx runtime status
```

确认运行状态为 ready、`running=true`，同一实例的 `heartbeatAt` 持续更新；只有 PID、端口或 lease 文件存在不算启动成功。若项目原本明确禁用了 runtime，保持禁用；只有决定恢复后台功能时才执行 `ctx runtime enable` 后启动。

随后重启或重连 Zcode/Codex 等宿主的 MCP 服务，并检查 Hook/MCP 配置是否仍指向旧 Node 安装目录。**CLI 升级成功不会自动替换宿主已启动的旧 MCP 进程，也不会自动修改手写的绝对路径。**

```powershell
ctx doctor --integrations
ctx host capabilities
ctx inject '继续当前项目任务'
```

`doctor --integrations` 用于检查受支持的集成；手工配置的 Zcode MCP/Hook 路径仍需在宿主中核对。最后让真实 agent 调用一次 MCP `context_resume` 或 `context_inject`，确认返回的 `projectRoot`、Context 和内容属于目标项目。

### 5. start 未确认或只有冻结 lease 时

先执行 `ctx runtime status`，保存完整结果中的状态和启动诊断。不要连续 start，也不要仅凭 `serve` 成功就认定后台启动已修复。

```powershell
ctx runtime status
ctx doctor
ctx runtime stop
ctx runtime serve
```

`serve` 是前台诊断入口，会占用当前终端；仅在 stop 成功后运行。另一终端可执行 `ctx runtime status`，完成诊断后用 Ctrl+C 结束前台进程。

反馈时附上 Node/ctx 版本、`Get-Command ctx -All`、项目路径、start/status 输出以及前台错误。若前台正常而后台失败，明确记录两条路径的差异。某些宿主会限制后台子进程，但独立 PowerShell 也失败时不能直接归因于宿主。

beta.8、beta.10、内部 beta.11 → beta.12 的本地隔离升级矩阵已通过；不等于所有旧 beta 或公司项目均已现场验证。更早版本也应先预览、备份、校验。beta.12 可读取旧快照，但写入新字段后不要让旧二进制继续写这些数据；降级不能只安装旧 npm 包。0.8.0 与新版压缩日志不可混用，另见 [CHANGELOG](CHANGELOG.md)。

## 首次使用

按上面的“安装 beta.12”选择包来源，然后进入目标项目：

```powershell
Set-Location 'D:\your-project'
ctx init
ctx inject '调查支付回调重复处理的问题'
```

`init` 创建 `.context/`、迁移并校验旧数据、写入项目指引并启动 runtime；已有 `.claude` 目录时还会配置对应集成。重复执行保留已有数据和禁用设置。已有项目升级请使用前述升级流程。

CI 或不需要后台进程、宿主配置时：

```sh
ctx init --no-start --no-integrations
```

新项目尚无记忆时，inject 返回很少内容是正常情况。

## 日常工作：取得上下文、执行任务、保存交接

开始任务或遇到新的错误时：

```sh
ctx inject "修复支付回调重复处理的问题" --max-chars 4000 --explain
```

读取返回的 `text`；需要具体证据时使用 `expandRefs`。默认正文预算为 2400 字符，引用预算为 4096 字符，后者通过 `--max-reference-chars` 调整。预算以字符计，不是提供商 token 数，也不是整包 JSON 长度。

完成一个有意义的阶段后，记录实际工作：

```sh
ctx checkpoint --title "支付回调修复" --objective "实现重复回调幂等处理" --constraints "不得重复扣款,保留既有订单状态约束" --progress "已定位幂等键缺失，尚未修改代码" --completed "复核回调入口" --pending "实现幂等校验,运行回归" --open-questions "历史重复订单如何处理" --files "src/payment.ts"
```

列表参数使用一个逗号分隔值，不重复传入多个 `--files`。执行验证后才记录 `--validation-refs`；没有运行测试时应明确写尚未验证。后续更新同一任务使用返回的 Context ID：`ctx checkpoint --context <id> --progress "实际进展"`。

新会话可以直接恢复：

```sh
ctx resume --context <context-id>
ctx inject --context <context-id> --scenario handoff
```

PowerShell 按需展开引用示例：

```powershell
$packet = ctx inject --scenario handoff | ConvertFrom-Json
if ($packet.expandRefs.Count -gt 0) {
  $reference = $packet.expandRefs[0] | ConvertTo-Json -Depth 20 -Compress
  ctx expand --ref $reference
}
```

MCP 可将 `context_inject` 返回的完整引用对象直接作为 `context_expand` 参数。不要猜测 candidateId、哈希或 compile 参数；过期引用会被拒绝，需重新 inject。预算不足的展开可能返回 partial，不能当作已读完全文。

恢复时还需注意：

- `branchOrCommitDrift=false` 仅说明分支和 HEAD 相符，不证明未提交文件未变化或测试已通过。
- MCP `context_resume` 未传 query 时 `knowledge=null` 表示未执行知识检索，不表示项目没有知识；需要完整快照字段时传 `includeDetails=true`。
- `usageCount` 在 checkpoint 保存新快照时递增，resume 只刷新 `lastUsedAt`，不是模型采用次数。

### 长会话去重与上下文重置

```sh
ctx inject "修复支付回调" --session-id chat-42 --task-id payment-fix
ctx inject "修复支付回调" --session-id chat-42 --task-id payment-fix --reset-session
```

首次返回 full，新增证据可能返回 delta，无变化返回 unchanged 和空正文。`replacePrevious=true` 时必须替换旧项目证据；来源撤回后不能继续使用旧结论。不同宿主、子 agent 使用独立身份；压缩、清空或丢失先前上下文后使用 reset。CLI 不传 session-id 时按无状态方式返回完整包。

## 知识导入、核验和来源复核

先预览已有项目记忆，再决定是否导入：

```sh
ctx import
ctx import --apply
ctx knowledge list --all
```

扫描目标项目中的 memory、agent 文档及支持的工具目录，记录来源并去重。`--path` 指定项目，不是要导入的单个文件；用户级记忆不会自动扫描。没有来源文件时无需新建或搬运文件来满足导入，也无需反复重试。

导入结果保持 candidate；核对真实代码或测试后才 verify。也可以直接记录候选：

```sh
ctx knowledge add "支付回调必须在事务中写入幂等记录" --evidence "src/payment.ts,test/payment.test.ts"
ctx knowledge verify <knowledge-id>
```

`verify` 保存操作者的核验决定，不会自动运行测试。失败经验使用 `ctx knowledge deadend add "尝试" --reason "已复现的失败原因"`；原 `learn`、`deadend` 等入口保持兼容。

beta.12 对已跟踪的导入来源进行有界指纹检查：来源变化或消失时，相关旧知识退出注入正文，并进入复核队列；历史 verified 状态保留。新内容不会自动成为 verified。重复 import 不会清除未解决的复核要求。

```sh
ctx knowledge review --review-required --limit 20 --max-chars 6000
ctx knowledge batch keep --ids <knowledge-id> --reason "已核对当前来源，原规则仍有效" --evidence "src/payment.ts"
```

`batch` 默认预览。检查返回的 transitions 后，使用完全相同的参数追加 `--apply --expected-token <token>` 执行。支持 verify、reject、deprecate、keep；verify/keep 必须提供证据。预览后来源变化会拒绝应用，需重新审阅。keep 仅确认当时的来源版本，再次变化仍会要求复核。

来源检查有扫描预算；unknown 不等于 fresh。没有来源指纹的手工知识按现有可信状态检索。导入跳过嵌套 Git 仓库、工作树存储及敏感内容，但仍需检查预览。来源回执保存在 `.context/memory-import.json`，不要为消除复核提示而删除它。

**当前已知诊断问题：**`sourceReview.states` 只统计入选证据，可能在 `items` 存在 changed/missing 时显示零。复核时查看 `required`、`items` 或 `ctx knowledge review --review-required`；这项汇总口径待修正，已有实测确认旧结论仍被撤回。

## 接入 Zcode、Codex 和其它 agent

支持项目指引的宿主可读取 `ctx init` 写入的 AGENTS.md，让 agent 在开始任务时 inject、阶段完成后 checkpoint。是否自动调用取决于宿主与 agent，配置存在不等于已经触发。

支持 MCP stdio 的客户端可使用：

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

将服务工作目录设为项目目录，或每次调用传入绝对 `path`。Windows 客户端若不能直接启动 npm 命令包装器，可使用 **node.exe 的绝对路径**作为 command，以 `npm root --global` 下的 `fluffy-context/dist/src/cli/main.js` 绝对路径、`agent`、`serve` 作为 args。实际格式以宿主配置要求为准；切换 Node 后重新核对这两个路径。

常用工具：`context_inject`、`context_resume`、`context_expand`、`context_checkpoint`、`context_learn`、`context_knowledge_review`、`context_knowledge_batch`。仅在有来源文件需要导入时使用 `context_import`。

Claude Code 适配器可显式安装：

```sh
ctx integrate claude install --apply
ctx integrate claude inspect
```

Hook 仅适用于确实支持该协议的宿主，不将 Zcode 默认当作 Claude Code。更多接入说明见 [HOST-ACCEPTANCE.md](HOST-ACCEPTANCE.md)。

## 诊断与效果报告

```sh
ctx status
ctx doctor
ctx host capabilities
ctx report --format ascii
```

report 统计本地交付、引用、展开、来源复核与替换。缺少提供商真实用量和对照任务结果时，不据此声称节省了 token、时间或费用。配对评估见[效果评估说明](docs/EFFECTIVENESS.md)。

| 情况 | 处理方式 |
| --- | --- |
| 导入后查不到知识 | 检查 candidate 状态、查询匹配、范围及预算，核验后再 verify |
| agent 没有使用 ctx | 检查项目指引、MCP/Hook 实际调用和路径，重连后实测 |
| checkpoint 返回 rate_limited | 实际变化写入默认至少间隔 10 秒；在下一阶段或 retryAt 后保存 |
| 想临时停止 runtime | `ctx runtime stop`；持续禁用自动启动用 `ctx runtime disable` |
| nvm 切换后 ctx 消失 | 检查当前 Node 的全局安装，按升级步骤处理旧实例并重新安装 |
| start 未确认、心跳不动 | 按升级章节保存 status/诊断并用前台 serve 对照，不删除数据 |

CLI 业务命令输出 JSON；`--help` 为文本。常用入口见 `ctx --help`，完整入口见 `ctx --help --all`，具体参数见 `ctx <command> --help`。

## 数据与开发

数据存储在项目 `.context/`，核心检索不需要云服务或模型 API key；`.contextignored` 控制项目关联路径。初始化可能写入 AGENTS.md，Claude 集成会修改对应配置。默认不开启文件监听，语义历史没有总容量硬上限；升级备份也会占用空间。

在代码中使用：

```js
import { injectContext } from 'fluffy-context';

const context = await injectContext('/absolute/path/to/project', {
  query: '修复支付回调重复处理的问题',
  maxChars: 2400,
});
console.log(context.text);
```

开发与本地安装按顺序执行：

```sh
npm ci
npm test
npm run pack:check
npm run install:local
```

不要并行运行会重建 dist 的检查。`install:local` 构建、打包、从 tarball 全局安装、逐文件核对哈希，并在 `.context/builds/` 写入安装回执；它会更新全局 ctx 并初始化本仓库，不会发布 npm。开发者可从回执取得最新候选包路径和 SHA256，交付给试用者。

[变更记录](CHANGELOG.md) · [产品方向](docs/PRODUCT-DIRECTION.md) · [路线图](ROADMAP-1.0.md)
