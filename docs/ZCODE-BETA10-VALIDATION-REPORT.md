# Zcode beta.10 验收测试报告

- 验收日期：2026-10-15（本地时间 UTC+8，journal 内事件为 UTC）
- 验收对象：`fluffy-context@1.0.0-beta.10`（npm 全局安装）
- 入口：`C:\nvm4w\nodejs\ctx` → `C:\Users\FluffyCHi_Xing\AppData\Local\nvm\v24.6.0\node_modules\fluffy-context\dist\src\cli\main.js`
- 验收项目：`D:\client\fluffy-context`（HEAD `c00352e`，工作树干净）
- 执行方：Zcode 会话（本会话同时通过 CLI 与 MCP 两种接口调用）
- 清单依据：`docs/ZCODE-BETA10-VALIDATION.md`
- 约束遵守：未读取用户级配置/其它项目；未执行 git reset/删除文件/npm 发布/知识验证；测试结束 runtime 已恢复运行；失败重试均 ≤2 次；本文所有时间戳与 ID 均来自原始工具输出。

三层区分声明（贯穿全文）：

1. **工具实际返回**——本文引用的 JSON/退出码均来自真实调用输出；
2. **合成测试行为**——C 节的 kill -9 属于人为模拟异常退出，非自然发生；
3. **模型最终采用**——见「证据采用」一节，仅 `know-mv2cu9nv-19665214` 等 inject 实际返回且状态为 verified 的证据被本答复引用；工具调用成功不等同于模型采用。

---

## A. 版本和接入身份 — 通过

| 步骤 | 命令/工具 | 关键返回 |
| --- | --- | --- |
| 版本 | `ctx --version` | `"1.0.0-beta.10"` |
| 全局包 | `npm ls -g fluffy-context --depth=0` | `fluffy-context@1.0.0-beta.10`（`C:\nvm4w\nodejs`） |
| 入口 | `cat /c/nvm4w/nodejs/ctx` | exec `node .../fluffy-context/dist/src/cli/main.js` |
| capability（CLI） | `ctx host capabilities --path D:\client\fluffy-context --format json` | schemaVersion 1；4 个 interface（cli/mcp/agent-api/claude-code hook）；declaredAdapters `["cli/cli","mcp/mcp"]`；observations total 15（cli/manual 12，mcp/tool-call 3，全部 observed、全部 full） |
| capability（MCP） | `mcp__fluffy-context__context_host_capabilities` | 与 CLI 逐字节一致，`journalEventCount: 1223` |

- capability schema 摘要：cli 触发 `manual, context-reset`（delta）；mcp 触发 `tool-call, context-reset`（explicit）；agent 触发 `manual, context-reset`（delta）；hook 触发 `session-start, user-prompt`（delta，session 身份为 host session_id + agent_id hash）。
- **声明 ≠ 已发生**：hook 的 `session-start`/`user-prompt` 只是支持的 trigger 声明，本机 observations 中没有任何 hook 触发记录；未观测的 capability 不计入宿主触发。
- 只读性：capabilities 调用前后 `ctx journal verify` 均为 `verified: true, eventCount: 1223, head evt-mv8f36rs-465e876547f72aee / hash da2eeb73…`（02:03:51 与 02:04 复核一致），确认无新增 journal 事件。
- 限制：MCP 工具返回体不含版本字符串，MCP 服务与 CLI 的一致性由 schema/journalEventCount 逐字节一致佐证；未读取 Zcode 用户级配置（按清单约束）。

## B. 上下文交付和采用 — 通过

参数：`path=D:\client\fluffy-context`、`query="fluffy-context beta.10 ZCode validation: context delivery, runtime lifecycle, journal integrity"`、`scenario=verification`、`sessionId=zcode-beta10-val-20261015`、`taskId=beta10-validation`、`maxChars=1200`。

| 调用 | delivery.mode | reason | replacePrevious | sourceCount | usedChars | manifestHash |
| --- | --- | --- | --- | --- | --- | --- |
| ① 首次（18:04:26Z） | full | first-in-session | false | 14 | 1200/1200 | `97405f0d…a3b432` |
| ② 完全相同重复（18:04:33Z） | unchanged | duplicate | false | 0（omittedSources 14） | 0 | `97405f0d…a3b432`（同 hash） |
| ③ 仅换 taskId=`beta10-validation-section-c-runtime`（18:04:40Z） | full | task-or-scope-changed | true | 14 | 1200/1200 | `97405f0d…a3b432` |

来源与状态（`ctx compile` 同 query，manifestHash `1d8220c5…20e161d`）：

- selected 7 项：1 条 journal activity（`evt-mv8e80pt-e3d03fb9a536920c`）、5 条 knowledge 全部 `status=verified`（`know-mv2cu9nv`、`know-mv58f2c8`、`know-mv84b19h`、`know-mv11nhyc`、`know-mv6opnd7`）、1 条 deadend `dead-mv3z2foy`（verified）。
- excluded 59 项，原因分布：`status_not_verified` 17（全部为 `status=candidate` 的知识，如 `know-mtbwr5ed`）、`query_no_match` 5、`budget` 37。
- **候选知识未被当作已验证知识**：17 条 candidate 全部以 `status_not_verified` 排除，选中的 5 条 knowledge 均为 verified。
- 预算分组：task 480 + evidence 720（1200 上限），activity/knowledge/deadend 截断情况与 truncation 字段一致。

任务边界结论：同 session 同 task 重复调用返回 `unchanged`（重复交付可解释）；taskId 变化触发 `task-or-scope-changed` 重新全量评估（reason 明示、replacePrevious=true）。

## C. runtime 启动、停止和重新拉起竞态 — 通过

基线（02:06:01+0800）：running=true，instance `84e9d8ff0ab545994a4a9b7b`，pid 49448，port 57033，startedAt 2026-10-14T18:01:20.384Z。

| # | 操作 | 结果 |
| --- | --- | --- |
| C1 | `stop` → `status` | running=false、lease=null；`.context/v2/runtime/` 仅剩 `v1-sync.json`（lease.json 与 secret 均删除，无 startup marker 残留） |
| C2 | `start` → `status` | 新 instance `f3d4cb096f566bf74902fe18`、pid 43564、port 55043、startedAt=heartbeatAt=18:06:24.728Z |
| C3 | 并发两次 `start` | 双方 exit=0，均复用同一 instance `f3d4cb09…`（pid 43564），无第二实例、无 journal 锁争抢 |
| C4 | stop→start 后 2 秒内立即 stop | 成功停止（lease=null，runtime 目录无 marker）；随后 1 秒内 restart 成功（新 instance `1383fbc1…`、pid 53104） |
| C5 | 两轮 stop→status→start→status | R1：`a7bf0e5a…` pid 62292；R2：`12a2ec50…` pid 55864；journal 中 `runtime.stopped` 严格先于下一个 `runtime.started`（见下方事件链） |
| C6 | 强杀 pid 55864（**合成行为**：PowerShell `Stop-Process -Force`，已先验证该 PID 命令行为 `fluffy-context … runtime serve --path D:\client\fluffy-context`，仅终止本测试创建的实例）+ 等待 20s | status 显示 running=false 但 lease 残留（heartbeat 冻结于 18:07:41.765Z）；`stop` 成功回收（lease→null，exit=0）；`start` 拉起新 instance `57547c1f5804bcb609fb2aeb`、pid 22676、port 64135 |

C 节 journal lifecycle 事件链（UTC，节选自 18:06 起）：`stopped 18:06:18.925` → `started 18:06:24.875` → `stopped 18:06:41.882` → `started 18:06:42.885` → `stopped 18:06:44.187` → `started 18:06:46.447` → `stopped 18:06:56.245` → `started 18:06:58.140` → `stopped 18:07:00.522` → `started 18:07:01.893` →（kill -9：无 stopped 事件，属预期）→ `started 18:08:05.670`。

心跳参数：间隔 5s（`src/cognition/runtime.ts:251`），租约过期阈值 15s（`runtime.ts:116`）。全部启停后 `ctx journal verify` 通过。

观察（非失败）：异常退出（kill -9）的实例在 journal 中留下 started 而无 stopped 事件——死亡进程无法补写 lifecycle 事件，回收依赖 15s 心跳过期 + `stop`/`start` 对 stale lease 的清理，行为与 `know-mv2cu9nv`（见证据采用）描述的顺序设计一致。

## D. journal、锁和报告完整性 — 通过

| 步骤 | 结果 |
| --- | --- |
| `ctx journal verify` | `verified: true, eventCount: 1243`，head `evt-mv8fapeu` / hash `906e5cf7…0508c`；contexts 50 / notes 5 / knowledge 27 / deadends 2 |
| `ctx journal index --apply` | `applied: true, segments: 3, events: 787, headHash 5b56648d…` |
| `ctx report --format json` | 生成成功（02:09:17），关键字段见下 |
| report 幂等 | 再执行一次 report 前后 journal 均为 1243 事件（02:10:04–02:10:05）——report 不追加 journal 事件 |

787 vs 1243 差异解释（已核实源码，非数据不一致）：索引只缓存**已封存**（gzip）段，`sealed()` 将最后一个未压缩段视为活跃段（`src/cognition/journal-index.ts:42-44`），读取时缓存 + 活跃段 tail 拼接（`journal-index.ts:121`）。段分布：747+2+38（封存）+456（活跃 `00000004.ndjson`）=1243。索引确为可重建缓存。

report 关键字段：

- `delivery.unknownTriggerPairs: []`（unknownTriggerCount 0）；`unobservedSupported` 列出声明支持但从未观测的 `cli/context-reset`、`mcp/context-reset`——正确区分「声明未观测」。
- delivery 模式分布 full 16 / unchanged 1 / replacement 1；按接口 cli 12（全 full）、mcp 6（full 4、unchanged 1、replacement 1）——与 B 节 3 次 inject（full→unchanged→replacement）及此前 3 次 mcp 触发完全对账。
- 失败与不支持独立可辨：`failed: 0 / unsupported: 0`，但 operations 中 `expand: calls 2, successes 1, failures 1`（即本报告「失败记录」中那次真实失败）。
- reuse 口径：`verifiedAssetReuseRate.method = "explicit record.used events only; retrieval and injection do not imply use"`；唯一的 `record.used` 事件（`evt-mv3ys17j`，2026-10-11T15:14:35Z，feedbackId `codex-beta6-sync-review-20261011`，knowledge `know-mv3yawxw`）为历史显式反馈——**本次所有 inject/compile/resume 均未产生 record.used** ✅。
- `dataQuality.journalVerified: false` 语义已核实：索引读取复用已验证封存段（`usage-report.ts:242`），报告 warnings 自带提示 "Indexed read reuses previously verified sealed segments; run ctx journal verify for current full-chain verification"，非校验失败。

## E. 短 context ID 和相关性边界 — 通过（2 个错误分支未验收，见限制）

背景数据：index.json 中 24 个 context，全部 `status=active`。

| 用例 | 输入 | 结果 |
| --- | --- | --- |
| 唯一短前缀 | `ctx resume --context ctx-mv8f36ld` | exit=0，解析为 `ctx-mv8f36ld-b9486ea8`（"local beta10 CLI installed"） |
| 不存在 | `ctx resume --context ctx-zzzzzzz` | exit=1，`context not found: ctx-zzzzzzz` |
| 段内前缀（无 `-` 边界） | `ctx resume --context ctx-mv8` | exit=1，`context not found: ctx-mv8`（5 个 ID 含此子串，但解析规则要求前缀终止于 `-` 边界，故判定为不存在而非歧义——无静默选错） |
| 历史导入 context | `ctx resume --context ctx-mt20sxme` | exit=0，解析 `ctx-mt20sxme-e29cbb1c`（"Agent Gateway 设计完成"，v1 迁移，仍为 active） |

解析规则（`src/runtime/runtime.ts:390-398`）：精确匹配或 `startsWidth("<prefix>-")`；多匹配 → `ambiguous context id …; matches: …`（exit≠0）；非 active/stable → `context is not active: <id>`。两个分支均存在于代码但**当前数据无法触发**（所有 ID 无共享 `-` 边界前缀；无非 active context）。

相关性边界（`ctx inject --explain --max-chars 1200`，无 session，mode=full/stateless）：

| query | task 组 | evidence 组 | sourceCount | usedChars | 排除 |
| --- | --- | --- | --- | --- | --- |
| 无关（"rust clap command line argument parser tutorial"） | 0/0 | 149/150 | 1 | 149 | query_no_match 12、status_not_verified 17 |
| 相关（B 节同 query） | 480/480 | 720/720 | 14 | 1200/1200 | status_not_verified 17、query_no_match 5、budget 10 |

无关任务下当前 context 进度（pendingTasks/progressSummary）**没有**挤占预算；相关 query 下进度与证据正常返回。✅

## 失败记录（首次失败完整保留）

- 时间：2026-10-14T18:05:33.015Z（本地 02:05:33+0800）——journal `usage.operation.completed {operation: expand, interface: mcp, success: false, durationMs: 982}`。
- 操作：`mcp__fluffy-context__context_expand`，参数 `manifestHash=1d8220c5…20e161d`（compile 产物）、`candidateId=knowledge:knowledge:know-mv2cu9nv-19665214:…`、`itemHash=d51f3e4f…`（误取 selectedItemHashes[0]，实为 activity 项的 hash）、`level=structured`。
- 错误文本：`context_expand failed: context expand candidate selectors do not match`。
- 恢复：重试 1 次（第 2 次尝试）改用该 selected 项自带的 `itemHash=6e56af4785478c3ef79d38c9a988868ffb6f047ba0ce0bd91b694b50bb97d32b` 后成功，返回完整 verified 知识对象。未再失败。
- 诊断：失败由调用方传错 itemHash 引起，工具端正确校验了 candidateId↔itemHash 配对；journal 中该失败被如实记账（report operations expand failures=1）。

## 证据采用（模型最终采用）

- 实际返回并引用的已验证证据：**`know-mv2cu9nv-19665214`**（fact，confidence 0.8，verified 于 2026-10-10T12:13:09.938Z，journal 事件 `evt-mv2cuuuq-96a409516c51b7e8`，supportingEvidence：`src/cognition/runtime.ts`、`test/upgrade.test.ts`、`batch-session-runtime-fixed.log`）。内容："runtime 的租约删除是 stopRuntime 的完成信号，必须晚于 runtime.stopped 日志写入和凭据清理；否则立即 upgrade 或 restart 会与退出进程争抢 journal 锁。"
- 返回了什么：B 节 inject 正文（1200 字符）包含该条知识的摘要文本；expand 返回其完整结构化对象。
- 实际采用了什么：本报告 C 节结论「stop 顺序、stopped-先于-started 校验、abandoned lease 回收」的解释框架直接采用了该证据；C6 的观察与之一致。
- 未采用的返回内容（如实声明）：inject 返回的另外 4 条 verified knowledge 与 1 条 deadend（`dead-mv3z2foy`，关于 import 边界/hook 协议/runtime observe 超时）未进入本报告结论——它们与验收条目无直接对应关系。

## F. 最终汇总表

| 项目 | 结果 | 原始证据 | 限制或后续动作 |
| --- | --- | --- | --- |
| 版本/入口 | 通过 | `ctx --version` → `"1.0.0-beta.10"`；`npm ls -g` → beta.10；入口 `dist/src/cli/main.js` | MCP 服务返回体无版本字符串，一致性靠逐字节输出比对佐证 |
| capability/trigger | 通过 | CLI 与 MCP `host capabilities` 输出一致；调用前后 journal 1223 事件未变 | hook 接口（session-start/user-prompt）仅有声明、无本机观测，属未接入宿主，非缺陷 |
| full/delta/unchanged | 通过 | ①full(first-in-session) ②unchanged(duplicate, 同 manifestHash) ③full(task-or-scope-changed, replacePrevious) | 无 ②→新证据的 delta 场景（窗口内无新增证据），delta 分支未直接观测 |
| 证据采用 | 通过 | selected 5 knowledge+1 deadend 全 verified；17 candidate 以 status_not_verified 排除；唯一 record.used 为历史显式反馈 | — |
| stop/start 竞态 | 通过 | C1–C5 实录；并发 start 双方复用 `f3d4cb09…`；journal stopped→started 严格交替；两轮后 verify 通过 | — |
| 残留锁/lease 回收 | 通过 | C6：kill 55864 → lease 残留（heartbeat 冻结）→ stop 回收 lease=null → start 新实例 `57547c1f…` | kill -9 为合成行为；异常退出实例无 runtime.stopped 事件（预期），如需 journal 侧闭环可评估后续版本补记 tombstone |
| journal/index/report | 通过 | verify 1243 事件通过；index=封存段缓存（787）+活跃段实时读，源码已核实；report 幂等（1243→1243）；unknownTriggerPairs=[]、unobservedSupported=[cli/mcp 的 context-reset] | 787 vs 1243 数值差异易误读，建议 index 输出中标注 sealed-only 口径 |
| 短 context ID | 通过 | 唯一前缀解析 ✅、不存在 exit=1 明确报错 ✅、无关/相关 query 预算边界 ✅（task 组 0/0 vs 480/480） | 歧义分支（runtime.ts:392）与非 active 分支（runtime.ts:398）无现有数据可触发，标记**未验收（子项）**；段内前缀报 not-found 而非歧义，属规则设计而非缺陷 |

## 结束状态

- runtime：运行中（instance `57547c1f5804bcb609fb2aeb`，pid 22676，port 64135，heartbeat 2026-10-14T18:11:50.848Z）——满足约束 3 的恢复要求。
- journal：`verified: true`，1253 事件，head hash `6dca274c…3806c325`（相比验收前 +30 事件，全部为本验收自身的 usage/host-trigger 记账，无手工写入）。
- 预期 lifecycle 事件：本次测试产生的 `runtime.started`×6 / `runtime.stopped`×5（kill 的实例无 stopped，见 C6 观察）均已逐一列于 C 节。
- 项目文件：除本报告外未修改任何文件。
