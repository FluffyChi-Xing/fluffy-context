# beta.6：Zcode 与 Codex 接入验收

更新：2026-10-11。载体分别验收，服务连接、工具调用、上下文采用与自动触发是不同证据。

发布范围调整（2026-10-12）：以下尚未完成的自主调用、智能注入和宿主事件覆盖转入 1.0.0 正式版核心特性待办，不阻塞 beta.6 发布；保留实测记录及限制，不将部分验收改写为全部通过。

## 当前实测

| 载体 | 已观察到 | 尚未验收 |
| --- | --- | --- |
| 当前 Codex 桌面会话 | 全局 CLI 的 inject、learn、checkpoint；真实 MCP context_inject 的 full、unchanged、任务切换替换、reset 替换，以及 context_checkpoint；实际采用返回的已验证知识 | MCP 服务版本未观察，新治理工具尚待重连后核对；跨会话自动触发覆盖 |
| Zcode 3.14.3.7762 | GLM-5.3 在本项目新会话实际调用 context_inject 和 context_knowledge_review；已展开工具原始参数与结果核对，最终答复引用返回的知识 ID；用户级 fluffy-context 服务已连接 | 全局 tarball 入口重连；上下文恢复及任务切换；Hook 输入输出契约与实际触发；发布待办判断准确性 |

Zcode 已有配置的命令为 `C:\nvm4w\nodejs\node.exe`，参数为 `D:\client\fluffy-context\dist\src\cli\main.js agent serve`。这指向开发构建，不是全局 tarball 安装产物。发布验收应改用本机已核验的全局包入口并重连，再记录服务版本；本批没有修改 Zcode 的配置或模型选择。经用户明确授权，已在 fluffy-context 项目创建只读验收会话「只读检查 fluffy-context beta.6 知识治理范围」。先前配置观察时模型显示 GLM-5.3-Flash，实际验收时显示 GLM-5.3。

Zcode 本次原始调用与结果：

- `context_inject`：`path=D:\client\fluffy-context`，query 为 `beta.6 知识治理范围 knowledge governance scope pending acceptance`，`scenario=verification`，`trigger=prompt`；返回 ready、full/stateless、26 个来源、正文 1087/2400 字符，manifestHash 为 `87980067edc1ccb9d22e55c692e49f99553159843972fc2041852b2153140e2b`。
- `context_knowledge_review`：同一 path，`limit=3`、`maxChars=1800`、`statuses=["candidate"]`；返回 total=16、3 条记录、nextOffset=3，正文 1070/1800 字符。三个 ID 为 `know-mtbwr5ed-2f785cb3`、`know-mtbwr60p-5fbb88b7`、`know-mtbwr6nc-20475fdd`。
- 最终答复引用前两个 ID 及其证据文件，未调用治理、导入或 checkpoint 工具。但它把候选知识当作两个发布待验收项；candidate 只表示知识尚未验证，不能据此推断功能未通过测试。因此工具调用与证据引用通过，发布待办判断不计通过。本次是显式提示触发，不能证明 Hook 自动接入。

Zcode 新建钩子表单提供事件、运行方式、匹配器、命令和逐行 argv 参数；默认事件显示 PreToolUse。这只证明 UI 入口存在，不足以确认 Claude Hook 的 additionalContext 契约适用。

Codex 本次 MCP 调用采用 `know-mv3yawxw-fe74728e` 的批量日志同步约束来复核实现，并通过显式 feedback 记录使用；首次正文为 1031 字符（预算 1800），重复调用正文为 0。会话交付回执位于本地 `.context/builds/beta6-codex-host.json`。这些是本会话的真实调用结果，MCP 服务的版本仍未观察，不能据此声称所有新工具或所有宿主事件均已通过。

## 本地 stdio 接入

支持 stdio 的宿主使用 `ctx agent serve`。Windows 宿主若不能启动 npm 的 ctx 包装器，使用真实 Node 可执行路径及全局包的 CLI 文件：

```json
{
  "command": "C:\\nvm4w\\nodejs\\node.exe",
  "args": [
    "C:\\nvm4w\\nodejs\\node_modules\\fluffy-context\\dist\\src\\cli\\main.js",
    "agent",
    "serve"
  ]
}
```

这些路径对应本机；其它机器应从 `node -p process.execPath` 和 `npm root --global` 获取。宿主配置格式与配置入口以其实际界面为准，不假设 Zcode、Codex、Claude 共用配置文件。所有工具调用明确传入项目绝对 `path`，避免用户级服务把其它项目当作当前项目。

安装新 tarball 后重连常驻 MCP，确认工具列表包含 `context_knowledge_review`、`context_knowledge_batch`、`context_inject`、`context_checkpoint`。独立 stdio 客户端测试证明协议可调用，不能替代宿主内验收。

## 可复现的只读验收任务

在目标载体中选择本项目的新验收会话，再提交以下任务；Zcode 已在用户授权后执行，实际结果见上文：

> 只读检查 D:/client/fluffy-context 的 beta.6 知识治理范围。先用可用的 context_inject 工具取得上下文，明确传入项目 path；工具不可用时报告不可用，再用全局 ctx inject。然后调用 context_knowledge_review（limit=3、maxChars=1800），或使用 ctx knowledge review 的等价参数。引用实际返回的来源或知识 ID，列出两个仍待验收的项目。不要验证、拒绝、退役、导入或修改任何记录；不要使用 batch apply。分别报告使用了哪条接入路径、返回了什么证据以及答案采用了哪条证据。

保留工具调用名称、参数、返回模式、实际采用的 ID 和最终答复，避免以模型自述“已接入”代替工具证据。不把其它项目的数据、认证信息或完整用户配置加入记录。

## 后续事件矩阵

- 任务开始：得到相关且有预算的上下文；候选不进入可信区。
- 同会话重复任务：显式传相同 sessionId/taskId 时返回 unchanged 或仅有新证据的 delta；无 sessionId 的调用仍返回 full。
- 上下文恢复：重置会话交付，恢复 full；不能因之前已交付而丢失证据。
- 任务或分支切换：原会话缓存失效，不沿用旧任务的上下文。
- 新错误：查询相关知识或已验证死路，并能指出采用的证据。
- 阶段结束：仅在确实完成工作后 checkpoint，保存真实进度、决策、待办和文件。
- 治理撤回：在隔离测试项目验证 deprecate 后的 replacePrevious，不在真实项目制造测试知识。

全量回归覆盖核心状态和协议行为；上述宿主事件仍需逐项观察。未观察到的行为标记“未验收”，不填估算成功率或 token 节省。
