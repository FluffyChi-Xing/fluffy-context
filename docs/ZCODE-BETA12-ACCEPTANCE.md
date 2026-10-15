# beta.12 Zcode 真实环境验收清单

日期：2026-10-16。目标版本：`1.0.0-beta.12`。

本文是交给 Zcode 执行的验收任务，不是已经执行的报告。B12.0 公司 runtime 故障复测仍可延后，不阻塞本清单的新功能测试。

## 可以直接复制给 Zcode 的执行要求

请在当前真实项目验收 fluffy-context beta.12，并按本文顺序执行。

1. 先确认当前项目路径、ctx 实际解析路径和版本；每个命令记录退出码、关键 JSON 字段与真实观察。
2. 优先使用你实际具备的 MCP 工具；没有 MCP 时用终端 CLI，并把 MCP 项标为 unavailable，不用 CLI 成功替代 MCP 成功。
3. 真实项目只做有依据的任务调查、checkpoint、上下文读取与展开。故障注入、模拟知识及源文件修改全部放在新建的临时项目。
4. 不修改业务代码，不提交、推送或发布。不要为了测试在真实项目制造错误、删除来源文件、损坏收据或晋升模拟知识。
5. 遇到失败保留原始输出，停止依赖该结果的步骤；其余独立测试可继续。不得用手工改写 `.context`、替换 hash 或不断重试来制造通过结果。
6. 跨会话恢复必须由一个真正的新 Zcode 会话完成。需要用户开新会话时，提供 context ID 和下面的恢复提示词；未执行时标 pending。
7. 最终输出通过/失败/未执行清单，并明确：哪些结论是工具返回，哪些证据由你展开读取，哪些实际影响了你的下一步选择。

## 0. 环境与安装确认

在真实项目 PowerShell 中执行：

```powershell
Get-Location
Get-Command ctx -All | Select-Object CommandType,Source
node --version
ctx --version
ctx status
ctx doctor
ctx host capabilities
```

通过条件：项目路径正确，版本为 `1.0.0-beta.12`，已有 Context 可读取，doctor 无新增数据损坏。若 ctx 找不到或版本不对，先处理安装/终端 PATH，不能跳过版本检查。

beta.12 是本地候选，不能假定 `npm install -g fluffy-context@beta` 会得到它。需要安装时，把候选 tarball 拷贝到当前机器后使用实际文件路径：

```powershell
# 替换为本机收到的 tarball 路径。
$candidateTarball = 'C:\实际目录\fluffy-context-1.0.0-beta.12-953f8ee037b4.tgz'
Get-FileHash -LiteralPath $candidateTarball -Algorithm SHA256
npm install --global $candidateTarball --ignore-scripts
ctx --version
```

期望 SHA256：`953f8ee037b42a74b6a4dd8f40868cce99397c6116e617519ae885cdfceb4b59`。旧 runtime 正在运行时，先在目标项目执行 `ctx runtime stop` 再替换包；重新打开终端/重连 Zcode MCP，使其加载新版本。若原后台启动故障仍在，记录 diagnostics；可先完成不依赖 runtime 的新功能测试，不把后台启动失败算作整个测试通过。

## 1. 真实任务交接：会话 A

选一个真实、可只读调查的任务，例如“定位某页面的登录校验入口，并列出修改前需要满足的约束”。不要编造已经完成的开发或测试。

- [ ] 先执行 `ctx inject "实际任务" --explain`，记录是否有相关证据。
- [ ] 检查实际文件，形成有来源的目标、约束、当前进度、下一步和未解决问题。
- [ ] 使用 `ctx checkpoint` 创建本次调查的 Context，保存返回的 context ID 和 snapshot ID。

可用字段如下；尖括号内容必须替换，未执行测试就省略 validationRefs，或只记录真实只读核查依据：

```text
ctx checkpoint --title "<真实任务标题>" --objective "<实际目标>" --constraints "<约束1>,<约束2>" --progress "<真实调查进度>" --pending "<下一步1>,<下一步2>" --open-questions "<尚未确认的问题>" --files "<实际相关文件>"
```

若已有验证记录，可追加 `--validation-refs "<报告路径或实际命令及结果>"`。列表使用英文逗号分隔；不要把一条带逗号的复杂日志塞入列表。

```powershell
$taskContextId = '<保存返回的完整 context ID>'
$handoff = ctx inject --context $taskContextId --scenario handoff --max-chars 4000 --max-reference-chars 16000 | ConvertFrom-Json
$handoff | ConvertTo-Json -Depth 20
```

通过条件：正文包含实际目标、约束和下一步；handoff 的 context/snapshot 与保存结果一致；未记录字段显示 `not-recorded`；不能把 validationRefs 或 snapshot commit 解释为“当前工作树已测试通过”。若返回 `rate_limited`，遵守 retryAt，继续独立检查后再保存，不循环刷写。

## 2. 按需展开与 Zcode 实际采用

CLI：

```powershell
if (-not $handoff.expandRefs.Count) { throw '没有可用展开引用；检查预算和任务内容' }
$expandRef = $handoff.expandRefs[0]
$expanded = ctx expand --ref ($expandRef | ConvertTo-Json -Depth 12 -Compress) | ConvertFrom-Json
$expanded | ConvertTo-Json -Depth 20
```

MCP：调用 `context_inject`，参数包含 `path`、`contextId`、`scenario: "handoff"`；将返回的一个完整 `expandRefs` 对象直接作为 `context_expand` 参数。

- [ ] 无需手工补 manifestHash、itemHash、compile 参数即可展开。
- [ ] 返回 candidateId 与引用一致；`complete` 有 content，`partial` 时正文有界且 content 为 null，不能声称读取了完整证据。
- [ ] Zcode 明确指出“采用了哪个目标/约束/下一步，对应哪个 candidateId”，并说明这如何影响后续调查。
- [ ] 若证据无关，明确不采用；不为获得通过结果强行使用无关信息。

## 3. 真正的新会话恢复：会话 B

请用户新建一个 Zcode 会话，仅给出项目路径、context ID 和以下提示，不粘贴会话 A 的总结：

```text
请接手项目 <项目绝对路径> 的 Context <context ID>。
先用 ctx inject --context <context ID> --scenario handoff 恢复。
需要细节时直接使用返回的 expandRefs 展开，不猜测之前的工作。
请说明任务目标、硬约束、实际完成项、开放问题和下一步，并指出各自来源。
执行一个不修改代码的下一步调查；说明哪些上下文实际影响了你的选择。
没有验证记录时，明确说尚未验证，不得把历史记录当作当前测试通过。
```

通过条件：不依赖旧聊天全文就能恢复正确任务；约束不丢失；开放问题未被改写成已解决；能完成一个有上下文依据的只读下一步。报告必须由会话 B 的实际输出支持。

## 4. 创建隔离测试项目

以下 5–8 项在同一个 PowerShell 会话中执行，变量需保留。若 Zcode 每条命令使用新进程，请记录变量实际值，在下一条命令中重新赋值。

```powershell
$qaRoot = Join-Path ([IO.Path]::GetTempPath()) ('ctx-beta12-zcode-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $qaRoot | Out-Null
ctx init --path $qaRoot --no-start --no-integrations
$sessionId = 'qa-' + [guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Path (Join-Path $qaRoot 'memory') | Out-Null
$sourceFile = Join-Path $qaRoot 'memory\acceptance.md'
'- beta12accept sandbox rule: use identifier A.' | Set-Content -Encoding utf8 -LiteralPath $sourceFile
$imported = ctx import --path $qaRoot --apply | ConvertFrom-Json
$knowledgeId = $imported.results[0].knowledgeId
```

这是一条明确的合成测试知识，不能导入真实项目。

## 5. 候选隔离、会话去重和预算

```powershell
ctx inject beta12accept --path $qaRoot --explain
ctx knowledge verify $knowledgeId --path $qaRoot
$first = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
$same = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
$reset = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept --reset-session | ConvertFrom-Json
$tiny = ctx inject beta12accept --path $qaRoot --max-chars 80 --max-reference-chars 0 --explain | ConvertFrom-Json
```

通过条件：

- [ ] verify 前不注入合成知识；verify 后 first.text 包含 identifier A。
- [ ] first 为 full，same 为 unchanged 且正文为空，reset 为 full 且 replacePrevious 为 true。
- [ ] tiny.text.Length ≤ 80；expandRefs 为空，referenceBudget.usedChars 为 0。
- [ ] 正文、引用和诊断使用独立预算；不要把整包 JSON 长度误当成 maxChars。

这里的 verify 仅用于隔离测试数据生命周期，不证明任何真实业务规则。

## 6. 来源变化、旧引用失效及重复导入

```powershell
$oldReference = $first.expandRefs[0]
@'
- beta12accept sandbox rule: use identifier A.
- beta12accept sandbox supplemental rule: retain currency.
'@ | Set-Content -Encoding utf8 -LiteralPath $sourceFile
$changed = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept --explain | ConvertFrom-Json
ctx expand --ref ($oldReference | ConvertTo-Json -Depth 12 -Compress)
# 上一命令预期失败；记录其退出码和错误后，再继续下列独立检查。
ctx knowledge review --path $qaRoot --review-required
ctx import --path $qaRoot --apply
$reimported = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
ctx knowledge --path $qaRoot --all
```

通过条件：旧规则退出正文；sourceReview.required > 0；changed.delivery.replacePrevious 为 true；旧引用被拒绝并提示重新获取；重复 import --apply 后仍需复核；旧知识的历史 status 仍是 verified，新补充句仍是 candidate。注意原句仍留在文件中，文件指纹变化依然需要复核。

## 7. keep 只确认当前来源版本

```powershell
$reason = 'Sandbox acceptance: inspected retained rule A; acknowledge this source revision only'
$evidence = 'memory/acceptance.md; synthetic acceptance fixture only'
$preview = ctx knowledge batch keep --path $qaRoot --ids $knowledgeId --reason $reason --evidence $evidence | ConvertFrom-Json
ctx knowledge batch keep --path $qaRoot --ids $knowledgeId --reason $reason --evidence $evidence --apply --expected-token $preview.token
$kept = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
'- beta12accept sandbox rule changed again: use identifier B.' | Set-Content -Encoding utf8 -LiteralPath $sourceFile
$changedAgain = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
```

通过条件：keep 后规则 A 可重新交付；再次修改后重新出现复核要求，规则 A 不继续作为当前结论。未核验的新规则 B 不会自动成为 verified。

## 8. 删除来源与报告

```powershell
# 仅删除上面创建的临时测试文件，绝不替换为真实项目来源。
Remove-Item -LiteralPath $sourceFile
$missing = ctx inject beta12accept --path $qaRoot --session-id $sessionId --task-id beta12accept | ConvertFrom-Json
ctx report --path $qaRoot
ctx journal verify --path $qaRoot
```

通过条件：missing.sourceReview 中出现 missing，旧结论未恢复；journal verified 为 true。report 的 delivery.contextEngineering 有实际调用计数；无模型采用或 provider 用量证据时不报告节省比例。

保留 `$qaRoot` 及命令输出用于排障。若通过 MCP 等入口自动启动过测试 runtime，最后 `ctx runtime stop --path $qaRoot`。不要求自动删除测试目录。

## 结果回传格式

```text
Zcode beta.12 验收
项目：<可脱敏>
OS / PowerShell / Node / ctx 版本：
ctx 实际路径 / tarball SHA256：
Zcode 版本、模型、CLI 或 MCP 接入：

0 环境：PASS / FAIL / BLOCKED
1 真实交接保存：
2 引用展开：
2 Zcode 实际采用：
3 新会话恢复：PASS / FAIL / PENDING
5 候选隔离、会话及预算：
6 来源变化、旧引用、重复导入：
7 keep 与再次变化：
8 删除来源、报告、日志链：

真实 Context ID / snapshot ID：
实际展开的 candidateId：
采用了哪条证据，它如何影响下一步：
临时测试项目路径：
失败的命令、退出码、关键原始输出：
未执行项及原因：
B12.0 原 runtime 故障：未复测 / 仍失败 / 已独立复测通过
```

PASS 必须有真实输出；预期被拒绝的旧引用，以正确拒绝作为该项通过。CLI 测试通过不能代替 MCP 测试，新会话尚未执行不能标恢复通过。不发送 token、凭证或不必要的公司业务内容。
