# beta.11 内部验证 → beta.12 对外 beta：runtime 启动与升级恢复

2026-10-15 按用户要求：`1.0.0-beta.11` 只用于内部修复、tarball 安装与验证，不创建 release、不发布 npm；下一个对外 beta release 为 `1.0.0-beta.12`。beta.12 须先完成下述验收，不能直接以内部版本测试代替生产项目复测。

## 调整原因与证据

用户报告 Zcode 生产项目从 beta.8 升级到 beta.10：先 stop，再安装新版，再 start，启动提示尚未确认；status 为 running=false，但存在 lease，heartbeatAt 与 startedAt 相同。随后用户确认前台 `ctx runtime serve` 能正常运行，后台 `ctx runtime start` 失败。

用户进一步确认独立 PowerShell 手动 start 也失败，因此不能仅归因于 Zcode 命令工具。当前开发机器没有该生产项目，尚未取得失败子进程的退出原因。前台可运行将调查重点收敛到后台启动、进程存活及环境差异，但不足以认定 Windows Job Object、数据损坏或锁为根因。

本机 Windows / Node v24.6.0 / 全局 beta.10 在隔离临时项目中执行 init --no-start → start → status 成功；启动命令返回后另一次调用观察到心跳继续更新（14:01:07Z 启动，14:01:52Z 心跳），随后 stop 返回 lease=null。本次未复现外部故障，也未验证 beta.8 的生产数据升级路径。

beta.10 代码确认 `src/cognition/runtime.ts` 的 start 使用 detached 子进程并忽略标准流，未向调用者报告子进程的 error/exit；status 只报告 IPC 探活结果。旧版“可能仍在启动”提示无法区分已退出和真正的慢启动。

beta.11 内部修复增加专用后台入口与有界的 `last-startup.json`，记录版本、PID、阶段和错误码；start 观察子进程 error/exit，status 区分 starting、ready、failed、exited、unreachable 和 stopped。PID 探测是辅助信息，不能证明进程身份；`startup` 是最后一次后台启动记录，`outcome=ready` 不表示当前仍在运行，当前状态应看 `diagnostics.state` 与 `running`。原始异常正文不写入诊断，避免复制项目内容或凭据。

同时处理 IPC socket 错误及非法 token/null 请求、短暂发布锁竞争，并要求启动标记清理后才报告启动完成。该批定向回归不等同于外部生产故障根因已确认。

内部验收首次执行 beta.10 tarball → beta.11 候选时，曾实际观察到 observation 阶段 EPERM（保留在隔离项目的启动诊断）。检查同时发现原子写入用 PID + 毫秒时间生成临时文件，会在同进程并发写入时重名；旧版对照可稳定复现 ENOENT。现改为随机唯一临时文件，并对 Windows 短暂 rename/unlink 共享冲突做有界重试，始终保留原目标直到原子替换成功。EPERM 的外部生产触发原因尚未取证，不将内部问题自动等同于生产根因。

## 本版目标与优先级

1. **P0：复现并修复生产启动故障。** 对比同项目、同 Node/ctx 入口下的前台 serve、独立 PowerShell start、Zcode agent start；记录进程存活、退出码、启动阶段及错误。根据复现证据修复，不靠延长等待时间掩盖故障。
2. **P0：可诊断的后台生命周期。** 区分启动中、就绪、失败及停止中；保留有界的启动失败信息，不记录凭据或提示词。子进程已退出时及时报告失败；慢启动不重复拉起，停止与重启不破坏单实例和最终日志写入顺序。
3. **P0：升级恢复闭环。** 覆盖 beta.8 → 候选版、beta.10 → 候选版，以及残留 lease、初始化失败、启动后父进程退出和连续 stop/start。不得通过删除 `.context` 或历史日志完成恢复。
4. **P1：真实宿主复测。** 在受影响 Zcode 生产项目验证修复，确认恢复后的 Hook/MCP 注入可用；Codex 的真实调用与证据采用单独留证。无法现场验收时标记 pending，不以临时项目测试替代。

跨平台完整矩阵、固定任务效果实验和知识排序优化继续保留在正式版路线图，本批优先解决启动可靠性；不据本批结果宣称效率或 token 收益。

## beta.12 发布验收

- 取得原故障的可复现条件与对应回归，受影响项目完成后台启动与升级复测。
- 并发及异常路径满足单实例、可停止、可重启、日志全链验证；失败结果包含可执行诊断信息。
- 最终代码通过全量测试、pack 检查、`npm run install:local` 及安装后 MCP 验收，保留 tarball 哈希和安装回执。
- 区分合成测试、本机真实运行和外部生产验收；P0 未通过继续 beta。npm 发布另行执行，本计划不授权发布。
