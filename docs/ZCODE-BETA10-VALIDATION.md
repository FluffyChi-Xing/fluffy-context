# Zcode beta.10 验证清单

这份清单用于在 `D:\client\fluffy-context` 当前项目中做一次真实的 Zcode 验收。当前全局本地构建为 `1.0.0-beta.10`，npm beta 仍是 `1.0.0-beta.8`；beta.10 尚未发布 npm。beta.8 修复提交为 `7da2769`。请把每一项的原始工具调用、返回 JSON、终端输出和最终答复保存到验收记录中。

## 给 Zcode 的完整任务提示

复制下面的任务作为一次新的 Zcode 会话任务。请明确要求它使用当前项目路径，不要扫描或修改其它项目：

```text
请在 D:\client\fluffy-context 做 fluffy-context beta.10 的只读优先验收，并把每一步的工具名、完整参数、关键返回字段和结论记录下来。

约束：
1. 只操作 D:\client\fluffy-context；不要读取用户级配置、认证信息、其它项目或 .claude/worktrees。
2. 不执行 git reset、删除文件、发布 npm、修改 Zcode 配置，不验证或拒绝已有知识。
3. runtime 启停测试允许写入本项目的 runtime/journal 状态；测试结束必须恢复 runtime 为运行状态，并报告是否产生了预期 lifecycle 事件。
4. 每个结论都区分：工具实际返回、合成测试行为、模型最终采用；不能把工具调用成功当作模型采用。
5. 遇到失败不要重试超过 2 次；保留第一次失败的完整错误、时间和操作。

请按 docs/ZCODE-BETA10-VALIDATION.md 的顺序执行，并在最后按“通过 / 失败 / 未验收”逐项汇总。
```

## A. 版本和接入身份

- [ ] 用 `ctx --version` 和 MCP 服务版本确认实际接入的包。记录命令、版本和服务入口；如果仍是开发树入口，标记为“开发树验收”。
- [ ] 调用 `context_host_capabilities` 或执行 `ctx host capabilities --path D:\client\fluffy-context --format json`。记录 capability schema、接口、支持的 triggers 和当前 observations。
- [ ] 确认 capability 检查是只读的，没有新增 journal 事件。

通过条件：Zcode 能明确说明自己连接的入口和版本；不把 capability 声明写成已经发生的宿主触发。

## B. 上下文交付和采用

- [ ] 新会话调用 `context_inject`，显式传入 `path=D:\client\fluffy-context`、`query`、`scenario=verification`、`sessionId`、`taskId` 和 `maxChars=1200`。
- [ ] 记录 `delivery.mode`、正文长度、manifest/hash、来源 ID、排除原因和预算。检查候选知识没有被当作已验证知识。
- [ ] 使用相同 `sessionId`、`taskId` 和 query 再调用一次，确认返回 `unchanged` 或仅包含新证据的 `delta`。
- [ ] 改用新的 task ID，确认任务边界改变后不会沿用旧任务交付。
- [ ] 在最终答复中引用实际返回的一个已验证证据 ID；记录“返回了什么”和“最终答复实际采用了什么”。

通过条件：重复交付可解释，任务切换会重新评估，模型只引用实际返回并且状态为 verified 的证据。

## C. runtime 启动、停止和重新拉起竞态

先记录：

```powershell
ctx runtime status --path D:\client\fluffy-context
```

- [ ] 在 runtime 已运行时执行 `ctx runtime stop --path D:\client\fluffy-context`，等待命令返回，再执行 `ctx runtime status`。确认 `running=false`、没有 lease、没有 startup marker。
- [ ] 执行 `ctx runtime start --path D:\client\fluffy-context`，等待成功后再次查看 status。记录新的 instance ID、PID、端口和 started/heartbeat 时间。
- [ ] 并发执行两次 `ctx runtime start --path D:\client\fluffy-context`。预期只有一个实例成功持有 lease，另一方复用已有 runtime 或得到可解释的 already-running 结果。
- [ ] 启动刚返回或仍有 startup marker 时立即执行 `ctx runtime stop --path D:\client\fluffy-context`。确认最终能停止，不会留下永久 marker，也不会因残留 lease 无法再次启动。
- [ ] 连续执行 stop → status → start → status 两轮。每轮记录 `runtime.stopped` 先于下一次 `runtime.started`，且 journal 校验仍能通过。
- [ ] 如果能安全模拟异常退出，只终止本次测试创建的 runtime PID；等待心跳过期后执行 stop/start，确认 abandoned lease 可回收。不能终止 Zcode 或其它项目进程。
- [ ] 对 Zcode 的 `UserPromptSubmit`，只提供 `session_id` 和 prompt 也应产生一次 `interface=hook` 观察；没有 `event_id/prompt_id` 时，重复相同输入应保持幂等，不应静默丢失 trigger 事件。

通过条件：不存在永久锁、永久 startup marker 或无法 stop/restart 的状态；每次失败都能通过 status 诊断；新实例不会和旧实例同时写 journal。

## D. journal、锁和报告完整性

- [ ] 执行 `ctx journal verify --path D:\client\fluffy-context`，记录事件数量、head hash 和验证结果。
- [ ] 执行 `ctx journal index --path D:\client\fluffy-context --apply`，再执行一次 `ctx report --path D:\client\fluffy-context --format json`。
- [ ] 读取 `ctx journal index --path D:\client\fluffy-context` 的 `sealedEventCount`、`liveEventCount` 和 `eventCountScope`；`sealed-cache-plus-live-tail` 表示完整读取由封存缓存和活动段合并而成。
- [ ] 检查报告中的 `unknownTriggerPairs`、`unobservedSupported`、delivery mode 和 reuse 解释。检索或注入本身不能被算作 `record.used`。
- [ ] 重复执行 report，确认 report 本身不追加 journal 事件。

通过条件：完整性验证通过；索引是可重建缓存；报告能区分未观测、不支持、调用失败和模型采用。

## E. 短 context ID 和相关性边界

- [ ] 从一次 checkpoint 或 context 列表中取一个已有 context ID 的短前缀，调用 `ctx resume <短前缀> --path D:\client\fluffy-context` 或等价 MCP 工具。
- [ ] 验证唯一短 ID 能解析；对不存在、歧义和非 active/stable ID 分别记录明确错误。
- [ ] 如果 context.json 被发现有非法 status，执行 `ctx doctor`，确认错误列出具体 context ID 和允许值 `draft|active|stable|archived|deleted`。
- [ ] 用与当前 context 完全无关的 query 调用 inject `--explain`，确认当前进度不会无条件挤占预算；再用相关 query 确认相关进度仍能返回。

通过条件：短 ID 不会静默选错 context；无关任务不会获得不相关进度，恢复和明确 context ID 仍能读取需要的内容。

## F. 最终记录格式

请让 Zcode 输出以下表格，并附原始证据路径或脱敏后的 JSON：

| 项目 | 结果 | 原始证据 | 限制或后续动作 |
| --- | --- | --- | --- |
| 版本/入口 | 通过/失败/未验收 |  |  |
| capability/trigger | 通过/失败/未验收 |  |  |
| full/delta/unchanged | 通过/失败/未验收 |  |  |
| 证据采用 | 通过/失败/未验收 |  |  |
| stop/start 竞态 | 通过/失败/未验收 |  |  |
| 残留锁/lease 回收 | 通过/失败/未验收 |  |  |
| journal/index/report | 通过/失败/未验收 |  |  |
| 短 context ID | 通过/失败/未验收 |  |  |

任何一项失败都请保留：首次失败时间、完整命令或工具参数、错误文本、`runtime status`、相关 instance ID，以及失败后是否成功恢复。不要用“看起来正常”替代这些证据。
