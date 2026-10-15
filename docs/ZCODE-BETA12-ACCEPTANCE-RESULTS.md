# beta.12 Zcode 真实环境验收结果

## 补充验收：新 Zcode 会话 MCP 恢复（2026-10-16）

用户后续回传：**新会话通过 `context_resume` 接手通过**。以下为用户提供的现场观察，本次复核未重新运行 Zcode，也未取得两次 MCP 原始响应文件。下文原始报告的 PENDING 保留作为当时记录。

- 输入仅项目路径 `D:\client\fluffy-context` 和 Context ID `ctx-mv9s8rre-c629ddf3`；恢复快照 `snap-mv9s8rrk-386228bd`，标题「beta12 Zcode 验收报告复核」。
- 用户确认 objective、进度、2 项已完成、3 项待办、2 条决策、相关文件和空 lastError 均恢复，且与该会话先前 Hook 注入内容一致。
- 两次 resume 返回的 lastUsedAt 从 17:04:17Z 更新到 17:04:41Z，usageCount 均为 1；返回 3 个已验证 deadend ID，knowledge=null。
- `branchOrCommitDrift=false` 表示记录与当前分支/HEAD 相符，不证明未提交文件未变化或当前测试通过。

代码复核纠正两处解释：`src/runtime/runtime.ts` 中 usageCount 在 checkpoint 实际保存新快照时加一，resume 只更新 lastUsedAt，因此不是 inject 交付次数；`src/agent/api.ts` 中未提供 query 时 knowledge 直接为 null，不能据此判断项目没有已验证知识。本次复核的全局 ctx inject 实际返回了已验证知识。

覆盖边界：本次证明另一 Context 的新会话 MCP resume 恢复；原 §3 指定的 `ctx-mv9rj7v8-b55d5d97` 经 inject handoff → 按需展开 → 执行只读下一步的完整路径，未由本次回传逐项证明。Hook 已先注入上下文，因此也不将此记录解释为无 Hook 条件的独立恢复实验。核心新会话恢复记为 PASS，原特定路径保留为可补充覆盖。

剩余事项：修正 sourceReview.states 汇总口径并回归；B12.0 公司 PowerShell runtime 复测继续按用户安排延后。未据此发布 npm 或 release。

执行日期：2026-10-16（本地），输出时间戳为 UTC 2026-10-15T16:38–16:44。
执行清单：`docs/ZCODE-BETA12-ACCEPTANCE.md`（下称"清单"）。
执行者：Zcode 会话（GLM-5.3），CLI 与 fluffy-context MCP 双通道。
结论：除 §3（新会话恢复，需用户开新会话，PENDING）外全部 PASS。B12.0 公司 runtime 故障未复测（清单允许延后）。

原始证据 JSON 均保存于 `.context/builds/beta12-zcode-acceptance-*.json`，隔离测试项目保留于 `C:\Users\FluffyCHi_Xing\AppData\Local\Temp\ctx-beta12-zcode-00401217863`。

## 结果回传格式

```text
Zcode beta.12 验收
项目：D:\client\fluffy-context（仓库自身）
OS / PowerShell / Node / ctx 版本：Windows 10.0.26200 x64；命令在 Git Bash(MSYS) 中以相同 CLI 执行（见"偏差记录"）；Node v24.11.0；ctx 1.0.0-beta.12
ctx 实际路径 / tarball SHA256：C:\nvm4w\nodejs\ctx（安装于 C:\nvm4w\nodejs\node_modules\fluffy-context）；tarball .context/builds/fluffy-context-1.0.0-beta.12-953f8ee037b4.tgz；SHA256 953f8ee037b42a74b6a4dd8f40868cce99397c6116e617519ae885cdfceb4b59（与清单期望一致）
Zcode 版本、模型、CLI 或 MCP 接入：ZCode Desktop（版本号会话内不可读取）；模型 GLM-5.3；CLI 与 MCP 双接入，MCP 项均用 MCP 工具实测，未用 CLI 成功替代 MCP 成功

0 环境：PASS
1 真实交接保存：PASS
2 引用展开：PASS
2 Zcode 实际采用：PASS
3 新会话恢复：PENDING
5 候选隔离、会话及预算：PASS
6 来源变化、旧引用、重复导入：PASS
7 keep 与再次变化：PASS
8 删除来源、报告、日志链：PASS

真实 Context ID / snapshot ID：ctx-mv9rj7v8-b55d5d97 / snap-mv9rj7ve-9876d900（验收批次 checkpoint：ctx-mv9rr7lq-78fa09a8 / snap-mv9rr7lv-5a0c44f8）
实际展开的 candidateId：
  CLI complete：summary:current-context:ctx-mv9rj7v8-b55d5d97:objective:objective
  CLI partial（60 字符预算）：同上 candidateId，content=null
  MCP complete：decision:current-context:ctx-mv9rj7v8-b55d5d97:constraints:constraints:1
采用了哪条证据，它如何影响下一步：见"§2 Zcode 实际采用"一节
临时测试项目路径：C:\Users\FluffyCHi_Xing\AppData\Local\Temp\ctx-beta12-zcode-00401217863（保留用于排障）
失败的命令、退出码、关键原始输出：ctx expand --ref <§5 保存的旧引用> 退出码 1，输出 "context expand manifest hash mismatch; run ctx inject again to refresh evidence references"（预期拒绝，按清单计为该项通过）
未执行项及原因：§3 新会话恢复只能由真正的新 Zcode 会话执行（恢复提示词见附录 A）；B12.0 公司 runtime 故障复测延后
B12.0 原 runtime 故障：未复测（本机 MCP 入口自动启动并 ready 不构成公司环境复测）
```

## 0. 环境与安装确认 — PASS

- `Get-Location` 等价：`/d/client/fluffy-context`（D:\client\fluffy-context）。
- 发现问题：`ctx` 最初不在 PATH（`which: no ctx`，退出码 127）。根因是 nvm4w 从 v24.6.0 切到 v24.11.0：此前 beta.12 已于 2026-10-15 安装在 v24.6.0 的全局目录（收据 `.context/builds/install-953f8ee037b4.json`），node 版本切换后各版本独立 node_modules 使其从 PATH 消失。已用 ctx note 记录（note-mv9rr6gu-2f9d84d7）。
- 候选 tarball 在本机：`.context/builds/fluffy-context-1.0.0-beta.12-953f8ee037b4.tgz`，`sha256sum` 实测 `953f8ee037b42a74b6a4dd8f40868cce99397c6116e617519ae885cdfceb4b59`，与清单期望一致；且 `find src skills scripts -newer <tarball>` 无结果（工作树与 tarball 同源）。
- 按清单执行 `npm install --global <candidateTarball> --ignore-scripts`（退出码 0），随后：
  - `which -a ctx` → `/c/nvm4w/nodejs/ctx`；`ctx --version` → `"1.0.0-beta.12"`。
  - 逐文件校验：tarball 全部 149 个成员在仓库工作树与全局安装目录之间 sha256 比对，0 不一致。本次安装收据：`.context/builds/install-953f8ee037b4-node-v24.11.0.json`。
  - 另一处物理安装 `C:\Users\FluffyCHi_Xing\AppData\Local\nvm\v24.6.0\node_modules\fluffy-context` 亦为 1.0.0-beta.12（ZCode hook 配置 `.zcode/config.json` 指向它，本会话 hook 正常返回上下文）。
- `ctx status`：initialized=true，32 个 Context 可读（含 beta12 完成批次 ctx-mv9or5py-f0a1ca4a）。
- `ctx doctor`：healthy=true，7 项检查全部 ok，无新增数据损坏。
- `ctx host capabilities`（CLI 与 MCP 各一次，结构一致）：declaredAdapters=[cli/cli, mcp/mcp, hook/claude-code]，observations total=48（cli 28 / mcp 15 / hook 5）。
- 旧 runtime：替换包时无运行中实例（ctx 本身不可用，无旧进程可停）；安装后由 MCP 使用入口自动启动的新 runtime 见 §8 附注。

## 1. 真实任务交接：会话 A — PASS

任务（真实、只读）：定位 runtime worker 后台启动失败的诊断记录链路，并列出修改前需要满足的约束。

- `ctx inject "<任务>" --explain`（退出码 0）：返回相关证据——runtime 租约删除顺序、stop 顺序、observe 1 秒 IPC 超时、start ping 行为等 verified knowledge/deadend，delivery.mode=full(reason=stateless)，9 个 expandRefs。证据文件 `beta12-zcode-acceptance-…-s1 不单独存档（正文见会话记录）`。
- 实际文件核查（只读）：`src/cognition/runtime.ts:500-543`（spawn 前写诊断、子进程 error/exit 合并失败码、超时保留 marker）、`src/cognition/runtime-worker.ts`（逐阶段更新诊断、失败写有界错误码、仅清理本次 attempt 标记）、`src/cognition/runtime-diagnostics.ts`（StartupPhase、last-startup.json、runtimeFailureCode 白名单）。
- `ctx checkpoint`：首次使用重复 `--files` 旗标被 usage 拒绝（退出码 1，符合 CLI 语义）；改用逗号分隔列表后保存成功。返回：
  - Context ID `ctx-mv9rj7v8-b55d5d97`，snapshot `snap-mv9rj7ve-9876d900`（baseline，contentHash a6042b4b…）。
- handoff：`ctx inject --context ctx-mv9rj7v8-b55d5d97 --scenario handoff --max-chars 4000 --max-reference-chars 16000`（退出码 0，存档 `beta12-zcode-acceptance-handoff.json`）：
  - 正文 1023 字符，包含 objective、5 条 constraints、3 条 pendingTasks、2 条 openQuestions、progressSummary 与 3 个 relatedFiles。
  - `handoff.contextId/snapshotId` 与保存结果一致；`handoff.fields.validationRefs="not-recorded"`；`handoff.validation="recorded-references-only; current working tree is not verified"`（明确不把快照当测试通过）。16 个 expandRefs，referenceBudget 6773/16000。

## 2. 按需展开与 Zcode 实际采用 — PASS

CLI：

- 取 handoff `expandRefs[0]`（objective）原样传给 `ctx expand --ref`（退出码 0，存档 `beta12-zcode-acceptance-expand-cli.json`）：`status=complete`、candidateId/itemHash 与引用一致、resolvedLevel=evidence、content.field=objective 且有值。
- 小预算复测：同一引用改 `maxChars=60` → `status=partial`、`content=null`、正文 60 字符带截断省略号、`budget.truncated=true`。未声称读取完整证据。

MCP：

- `context_inject`（path+contextId+scenario=handoff）：返回与 CLI 一致的正文与 16 个 expandRefs。
- 将其中 `decision:current-context:ctx-mv9rj7v8-b55d5d97:constraints:constraints:1` 的完整 expandRefs 对象字段原样作为 `context_expand` 参数（未手工补 manifestHash/itemHash/compile）：返回 `complete`、candidateId/itemHash 一致、journalEventCount 有值。

Zcode 实际采用（影响后续选择的证据）：

- 采用 `constraints:1`「停止流程须先写 runtime.stopped 日志再删租约」（源自 §1 注入的 verified knowledge）：它直接决定本次收尾时对真实项目 runtime 不做进程强杀、如需停止只走 `ctx runtime stop` 语义；该约束同时来自任务注入证据并被写入 checkpoint 约束清单。
- 采用 `pendingTasks:1`「复核 waitForRuntime 超时边界与 marker 保留路径」：已只读复核 `src/cognition/runtime.ts:541-543`（超时不清除 startup marker，防竞争实例）与 worker 失败清理路径，确认清单所述行为存在。
- 不采用：handoff 其余引用（title、relatedFiles 等）仅作核对，不构成决策输入；无任何为凑通过结果而引用无关信息的情况。

## 3. 真正的新会话恢复 — PENDING

按清单要求，跨会话恢复必须由真正的新 Zcode 会话完成，本会话无法自证，标记 PENDING。恢复提示词见附录 A。

## 4. 创建隔离测试项目 — PASS

- `$qaRoot = C:\Users\FluffyCHi_Xing\AppData\Local\Temp\ctx-beta12-zcode-00401217863`（路径记录于 `.context/builds/beta12-zcode-acceptance-qaroot.txt`；每条命令独立进程，均以绝对路径重赋值）。
- `ctx init --path <qaRoot> --no-start --no-integrations`（退出码 0）：runtime.running=false、state=stopped、journal verified、0 事件。
- `sessionId = qa-5f0ff386-762a-48b4-a2ce-ba0558aeefac`（记录于 `beta12-zcode-acceptance-sessionid.txt`）。
- 合成知识写入 `memory\acceptance.md`（内容 `- beta12accept sandbox rule: use identifier A.`），`ctx import --apply` 返回 `know-mv9rlvgb-ef5f2c10`，status=candidate。该知识仅存在于临时项目，未导入真实项目。

## 5. 候选隔离、会话去重和预算 — PASS

| 步骤 | 关键观察 | 判定 |
| --- | --- | --- |
| verify 前 `--explain` 注入 | 正文为空，无 identifier A（candidate 被隔离） | 通过 |
| `ctx knowledge verify know-mv9rlvgb-ef5f2c10` | status=verified，证据含 sha256 指纹 | 通过 |
| first（session+task 注入） | 正文 `beta12accept sandbox rule: use identifier A.`；mode=full(reason=first-in-session)；1 个 expandRef | 通过 |
| same（重复注入） | mode=unchanged(reason=duplicate)，正文长度 0 | 通过 |
| reset（`--reset-session`） | mode=full(reason=reset)，replacePrevious=true，正文重发 identifier A | 通过 |
| tiny（`--max-chars 80 --max-reference-chars 0 --explain`） | text.length=44 ≤ 80；expandRefs=0；referenceBudget.usedChars=0（omitted=1） | 通过 |

预算独立性：`budget.maxChars=80`（正文）与 `referenceBudget.maxChars=0`（引用）互不挤占；未把整包 JSON 长度当作 maxChars。verify 仅验证隔离测试数据的生命周期，不证明任何真实业务规则。

## 6. 来源变化、旧引用失效及重复导入 — PASS

- 旧引用取自 first 的 `expandRefs[0]`（存档 `beta12-zcode-acceptance-s6-oldref.json`）。来源文件追加补充句（原句保留）后：
  - `changed` 注入（`--explain`）：正文为空（旧规则退出正文）、`sourceReview.required=1`（item state=changed，fingerprint 更新）、`delivery.replacePrevious=true`（reason=evidence-changed）。全部符合。
  - 旧引用展开：退出码 1，`context expand manifest hash mismatch; run ctx inject again to refresh evidence references`——正确拒绝并提示重新获取（该项以"正确拒绝"计通过）。
- `ctx knowledge review --review-required`：唯一条目 know-mv9rlvgb-ef5f2c10，status=verified、reviewRequired=true、changes=[memory/acceptance.md changed]。
- 重复 `ctx import --apply`：第 1 行 status=duplicate（历史 knowledge 仍 verified，绑定旧指纹），第 2 行新增 candidate `know-mv9ro6x4-48f442da`；`reviewRequired` 仍含旧 ID——重复导入不消除复核要求。
- 复核后再注入：正文仍为空（unchanged/duplicate），`sourceReview.required=1`。
- `ctx knowledge --all`：rule A=verified（历史状态保留），补充句=candidate。原句虽仍在文件中，但文件指纹变化仍触发复核，与清单一致。
- 观察（如实记录）：`sourceReview.states` 聚合对象在 changed/missing 场景下均显示全 0，而 `items[0].state` 正确为 changed/missing 且 `required>0`；通过条件以 items 实际状态判定。

## 7. keep 只确认当前来源版本 — PASS

- preview（applied=false）返回 token `f8e80e50…36154`；同参数 `--apply --expected-token` 后 applied=true（transition verified→verified，synchronization complete）。
- keep 后注入：正文重新出现 rule A（mode=delta reason=new-evidence），`sourceReview.required=0`——规则 A 恢复交付。
- 来源改为 rule B（覆盖两行）后再注入：正文为空（rule A 不再作为当前结论）、`required=1`（item state=changed 重现复核）。
- `ctx knowledge --all`：仍只有 rule A（verified，历史）与补充句（candidate）；rule B 未被自动创建/核验——未核验的新内容不会自动成为 verified。

## 8. 删除来源与报告 — PASS

- `Remove-Item memory\acceptance.md` 后注入：`items[0].state="missing"`、reviewRequired=true、正文为空——旧结论未恢复。
- `ctx report`（存档 `beta12-zcode-acceptance-s8-report.json`）：`delivery.contextEngineering.observations=10`，totals：referenceChars=1602、references=3、sourceReviews=4、replacements=3；interpretation 明确"Local deliveries and expansion calls, not model adoption or provider token savings"。`payback.status="no_baseline"`、`estimatedSavings.value=null`(quality=unavailable)、`estimatedROI=null`；warnings 含 "Provider token usage is unavailable"——无模型采用/提供商用量证据时未报告节省比例。
- `ctx journal verify`：verified=true，eventCount=26，counts knowledge=2。
- 测试 runtime：隔离项目全程未启动 runtime（runtime status: running=false, state=stopped），无需 `ctx runtime stop`（未通过 MCP 入口触碰过该项目）。
- 附注（真实项目）：验收期间真实项目 runtime 经 MCP 使用入口自动启动并达到 ready（pid 34700，heartbeat 正常推进，diagnostics.state=ready）。这是本机观察，不作为 B12.0 公司环境复测结论。

## 偏差记录（如实说明，不影响判定项）

1. 清单示例命令为 PowerShell；本环境 shell 为 Git Bash(MSYS)，以相同 ctx CLI 与参数执行，JSON 解析用 `node -e` 替代 `ConvertFrom-Json`。未发现行为差异。
2. `ctx checkpoint` 列表参数需逗号分隔单值；重复旗标形式会被 usage 拒绝（首次尝试退出码 1，已按 usage 修正）。
3. `memory\acceptance.md` 以 bash printf 写入（UTF-8 无 BOM），清单示例为 `Set-Content -Encoding utf8`；知识导入与指纹链路未受影响。
4. §0 的 `Get-Command ctx -All` 以 `which -a ctx` 等价执行；另通过直接读取确认了 v24.6.0 物理安装（hook 所指路径）亦为 beta.12。

## 附录 A：§3 新会话恢复提示词（待用户执行）

请新建一个 Zcode 会话，仅提供项目路径与以下提示（不要粘贴本报告或会话 A 的总结）：

```text
请接手项目 D:\client\fluffy-context 的 Context ctx-mv9rj7v8-b55d5d97。
先用 ctx inject --context ctx-mv9rj7v8-b55d5d97 --scenario handoff 恢复。
需要细节时直接使用返回的 expandRefs 展开，不猜测之前的工作。
请说明任务目标、硬约束、实际完成项、开放问题和下一步，并指出各自来源。
执行一个不修改代码的下一步调查；说明哪些上下文实际影响了你的选择。
没有验证记录时，明确说尚未验证，不得把历史记录当作当前测试通过。
```

预期核对点：目标为"梳理 runtime 后台启动失败诊断链路"；5 条约束不丢失（尤其租约删除顺序）；开放问题（B12.0 阶段归属、doctor 误报风险）未被改写为已解决；能完成一个有上下文依据的只读下一步。

## 附录 B：证据文件索引（.context/builds/）

- `install-953f8ee037b4-node-v24.11.0.json` — 本次全局安装收据（149 文件校验）
- `beta12-zcode-acceptance-qaroot.txt` / `-sessionid.txt` — 隔离项目路径与会话 ID
- `beta12-zcode-acceptance-handoff.json` / `-expand-cli.json` — §1/§2 交接与 CLI 展开
- `beta12-zcode-acceptance-s5-preverify/-first/-same/-reset/-tiny.json` — §5
- `beta12-zcode-acceptance-s6-oldref/-oldref-expand/-changed/-reimport/-reimported.json` — §6
- `beta12-zcode-acceptance-s7-kept/-changedagain.json` — §7
- `beta12-zcode-acceptance-s8-missing/-report.json` — §8
