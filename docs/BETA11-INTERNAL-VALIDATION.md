# beta.11 内部修复验证记录

日期：2026-10-15（Asia/Hong_Kong）。环境：Windows，Node v24.6.0。

版本策略：beta.11 仅作内部 tarball 验证和本机全局安装，不发布 npm、不创建 release；下一对外 beta 为 beta.12。

## 外部问题与证据边界

用户报告生产项目 beta.8 → beta.10 后，前台 serve 正常，后台 start 在 Zcode 和独立 PowerShell 均失败，status 有冻结 lease 但 running=false。开发机没有该生产目录，尚未取得外部进程退出原因，因此本记录不能证明原生产故障已修复。

## 已复现与修复

| 情况 | beta.10 对照 | beta.11 定向验证 |
| --- | --- | --- |
| 发布租约时启动锁短暂占用 | 立即抛出 context is busy | 等待锁释放后启动成功 |
| IPC 收到 null 请求 | TypeError 导致子进程退出 | 拒绝非法请求，runtime 仍可探活 |
| IPC 非字符串 token / 连接重置 | 旧代码缺少类型和 socket 错误处理 | 非法请求与重复 TCP reset 后仍运行 |
| 后台在 Node 引导阶段 exit(37) | 旧代码没有子进程退出回执 | start 报告退出码，清理标记后可重试 |
| 后台刚写完 lease 就 exit(41) | 复现“尚未确认，可能仍在启动”提示 | 记录 publish-lease 与退出码，回收租约后重新启动成功 |
| 已能 ping，但首次观察仍未完成 | 旧代码允许超时回退为成功 | start 保留未就绪状态，不把 ping 当作初始化完成 |
| 同进程同毫秒并发原子写入 | 复现临时文件撞名及 rename ENOENT | 32 次并发写入均完成，最终 JSON 完整且无临时残留 |
| Windows 临时文件共享冲突 | 注入一次 EPERM 即失败 | EPERM/EACCES/EBUSY 有界重试成功；永久失败保留原目标 |

旧版对照使用 HEAD 中 beta.10 的 runtime/atomic-write 实现置于隔离副本运行新回归，未替换全局包。原始输出保存在 `.context/builds/beta10-regression-baseline.txt`、`beta10-exit-after-lease-baseline.txt`、`beta10-atomic-baseline.txt`。这些是可复现的合成故障，不是生产现场日志。

## 验证过程中的真实失败

- 第一轮全量测试：185/186 通过。MCP Recipe 用例结束时未先停止后台 runtime，Windows 拒绝删除进程工作目录（EBUSY）；已修改为关闭客户端/服务端后停止 runtime，再删除测试目录。
- 第一轮 tarball 升级矩阵：beta.8 路径通过；beta.10 路径在 observation 阶段实际报告 EPERM。由新诊断保留阶段与错误码，随后补齐原子写入重名防护及 Windows 短暂共享冲突重试。未取得该次 EPERM 的完整 syscall 栈，不将临时文件重名认定为该次 EPERM 的唯一原因。
- 第二轮升级矩阵：beta.8 路径通过；beta.10 路径发现 start 返回旧快照中的 starting。已修正为依据同一份状态快照判断 readiness，避免 marker 在两次读取间消失造成结果矛盾。
- 修正上述状态快照竞争前，原子写入与 runtime 定向回归共 22/22 通过；最终候选仍需下方完整验收。

## 最终候选验收

以下本机验证已通过，未发布 npm 或创建 release：

| 检查 | 实际结果 / 回执（位于 `.context/builds/`） |
| --- | --- |
| 类型检查 | `npm run typecheck` 通过 |
| 完整回归 | 190/190；`beta11-full-tests.log` |
| 最终 runtime / 原子写入专项 | 状态快照修正后的构建 22/22；`beta11-final-runtime-tests.log` |
| 包内消费验收 | `npm run pack:check` 通过；`beta11-pack-check.log` |
| tarball 升级矩阵 | 本地归档 beta.8、beta.10 → beta.11 均通过；`runtime-upgrades-1792075076640.json` |
| 全局安装 | `npm run install:local` 通过，142 个文件哈希一致；`install-28139d71d296.json` |
| 安装后 MCP | stdio 客户端发现 29 个工具，注入返回 full；`installed-mcp-1792075186339.json` |
| 本仓库真实启停 | stop 返回 lease=null，start/status 返回 ready；`beta11-installed-start.json`、`beta11-installed-status.json` |
| 安装后日志链 | 启停完成时 1392 条事件校验通过；后续 checkpoint 会继续追加真实事件 |

全局安装与升级矩阵使用同一产物哈希：

- 文件：`fluffy-context-1.0.0-beta.11-28139d71d296.tgz`
- SHA-256：`28139d71d296715d02dbcce6a558fc0bbe9dc429c2a5e10b1433dcf055709414`
- 全局目录：`C:\nvm4w\nodejs\node_modules\fluffy-context`

升级夹具位于带空格和中文的路径，分别验证旧版 stop → 替换包 → 新版 start，随后执行数据 upgrade 和两轮启停。每个夹具的原有 4 条事件全部保留，最终 10 条事件通过全链校验，checkpoint 标题可恢复。详情及旧包哈希在升级回执中；这是本机隔离 tarball 升级验证，不是生产数据副本。

真实本仓库启动命令退出后，另一个命令仍观察到同一实例 `7ac8e0f0fde78d9d8cafcfec`，PID 42372；startedAt=2026-10-15T14:40:05.215Z，heartbeatAt=2026-10-15T14:40:30.249Z。以上为机器原始 UTC 时间，对应香港时间 22:40:05 → 22:40:30；证明该实例在调用方结束后仍更新心跳。MCP 验证为独立协议客户端，不等同于 Zcode/Codex UI 重连或模型采用。

## beta.12 前仍需完成

- 在受影响生产项目安装内部 tarball，关闭旧常驻连接后验证 stop → start → status 和持续心跳；如失败，保留新版 diagnostics。
- 受影响 Zcode 项目的 Hook/MCP 注入复测；Codex 实际宿主重连与模型采用另行留证。
- 跨平台结果和 provider usage 不在本机 Windows 验证范围内，不据此宣称已通过或有效能收益。
