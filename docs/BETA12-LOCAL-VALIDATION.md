# beta.12 本地开发与验证

2026-10-15。本轮按用户要求优先开发 B12.1–B12.4；B12.0 公司内小范围试用延后。版本号为 `1.0.0-beta.12` 本地候选，未发布 npm 或 GitHub release。

## 已实现

- checkpoint 的可选目标、约束、验证引用和开放问题字段，复用 pendingTasks 作为下一步；兼容旧快照读取和新快照补丁。恢复摘要统一累计字符预算，历史快照的漂移检查使用该快照的分支/commit。
- inject 的 handoff 来源描述、缺失/截断标记、可直接调用的 expandRefs；CLI `expand --ref`、MCP 与 Agent API 共用展开契约。原 query、scope、recipe、预算和身份随引用携带；过期引用拒绝展开并提示重新 inject。
- 已跟踪导入来源的有界指纹检查；需复核结论从注入中排除，既有会话收到替换指示，历史 verified 状态不变。keep 审阅与实时来源检查使用同一指纹，修改后重新开启复核；重复 import --apply 不会自动结案。来源收据损坏时保留任务恢复，相关导入知识以 receipt-unavailable 暂缓交付。
- Hook 交付有界引用和恢复描述；explain 提供预算与来源状态；report 记录真实本地交付、引用、展开及替换次数。

## 验证状态

类型检查通过。首轮专项回归 27/27 通过；首轮全量为 197/198，唯一失败是旧版整包额外 500 字符断言，与新增独立引用预算契约不符。已改为分别验证正文、引用、复核条目与外壳上限。最终全量回归、打包、安装与升级矩阵执行后在下方补充实际结果。

首轮新增测试有两处测试代码问题：TypeScript 可选 candidateId 未判空，以及错误假定 knowledge 文件必已创建；已修正并回归通过，没有将失败运行记作通过。

## 证据边界

- 自动测试和隔离升级矩阵是可复现实验，不能替代原公司生产项目试用。
- 独立 MCP 客户端只证明协议与安装能力，不证明 Zcode/Codex UI 自动触发或模型采用。
- 本地交付计数不代表任务正确率、真实 provider token 节省或收益；B12.4 的真实模型配对评估仍待执行。
- 来源检测首批仅覆盖已有导入收据，unknown 不是 fresh；没有来源指纹的手工知识继续按现有可信状态检索。
- beta.12 可读取旧快照；写入新字段后，不应使用旧版二进制继续写这些任务快照。历史快照不被改写。
- 本轮代码尚未提交，候选包以 tarball 哈希和逐文件安装回执识别；工作树基线 commit 不代表本轮改动已提交。


## 已完成的最终候选检查

- 最终专项：17/17，通过新功能、重复导入复核、损坏收据、分支/任务隔离、CLI、报告及旧预算契约扩充检查。日志：`.context/builds/beta12-final-feature-tests.log`。
- `npm run pack:check`：1/1 通过，验证打包后 CLI、Agent API、类型声明和随包 Skill。日志：`.context/builds/beta12-pack-check.log`。
- 隔离 tarball 升级：beta.8、beta.10、内部 beta.11 → beta.12 全部通过；每条路径保留历史事件，验证反复启停、新字段 checkpoint、handoff、直接引用展开及最终日志链。
- 升级回执：`.context/builds/runtime-upgrades-1792078488738.json`。这是本机合成项目矩阵，路径包含空格和中文，不是公司生产项目验收。
- 上述矩阵候选 SHA256：`953f8ee037b42a74b6a4dd8f40868cce99397c6116e617519ae885cdfceb4b59`。


第二轮全量为 197/200：两项旧测试预期“原句不变则无来源复核”，已更新为 beta.12 的文件指纹契约；另一项 Hook 子进程报告 compileContext 导出缺失，发生于独立 pack:check 与全量测试并行重写 dist 的验证流程冲突。停止并行构建后执行串行完整复测；不把这些失败计作通过。


## 最终结果（2026-10-15）

- **干净串行全量：200/200，通过，0 失败、0 跳过**。日志：`.context/builds/beta12-clean-full-tests.log`。验证期间不并行重建 dist。
- `npm run install:local` 完成，全局本地版本为 `1.0.0-beta.12`，**149 个随包文件逐一哈希一致**。回执：`.context/builds/install-953f8ee037b4.json`。
- tarball：`.context/builds/fluffy-context-1.0.0-beta.12-953f8ee037b4.tgz`，SHA256 与三条升级矩阵候选完全一致：`953f8ee037b42a74b6a4dd8f40868cce99397c6116e617519ae885cdfceb4b59`。
- 安装后独立 MCP stdio：29 个工具，handoff 与返回引用直接展开成功；日志 `.context/builds/beta12-installed-mcp.log`。这不代表模型自动采用。
- 当前真实仓库的全局 ctx：checkpoint 新字段 → inject handoff → expand validationRefs 成功，记录为 `.context/builds/beta12-real-checkpoint.json`、`beta12-real-handoff.json`、`beta12-real-expansion.json`。这是本线程显式 CLI 调用证据，不能代替 Zcode/Codex 自动触发或配对收益评估。
- 当前仓库 stop → start 返回 ready，同一 instance 的心跳从 `2026-10-15T15:51:14.460Z` 推进至 `2026-10-15T15:52:14.564Z`；证据 `beta12-real-start.json` 和 `beta12-real-heartbeat.json`。完整日志链检查见 `beta12-real-journal-verify.json`。
- 已更新 README、CHANGELOG、迭代方案、CLI/MCP 帮助及随包 Skill。未提交 Git commit，未发布 npm 或 release。

B12.1–B12.3 最小闭环与 B12.4 本地自动验证完成。剩余：用户明确延后的 B12.0 公司内试用、真实 Zcode/Codex 配对采用评估，以及对外发布决策。本地开发成果不因这些外部验证尚未执行而停留在计划阶段。
