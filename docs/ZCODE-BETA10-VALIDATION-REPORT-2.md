# Zcode beta.10 追加验收测试报告（G/H/I 三组）

- 验收日期：2026-10-15（本地 UTC+8；journal 事件时间为 UTC）
- 验收对象与入口：与主报告一致（`fluffy-context@1.0.0-beta.10`，npm 全局，`dist/src/cli/main.js`）
- 范围：G（hook 实触发）／H（delta 交付）／I（隔离项目短 ID 错误分支）
- 主报告：`docs/ZCODE-BETA10-VALIDATION.md` 清单 A–F 的结果见 `docs/ZCODE-BETA10-VALIDATION-REPORT.md`
- 隔离项目：`C:\Users\FluffyCHi_Xing\AppData\Local\Temp\fluffy-beta10-iso`（git 仓库，HEAD 经两次探针提交；journal 38 事件，校验通过；测试后 runtime 已停止，数据保留作证据）
- 三层区分声明贯穿全文：**工具实际返回**（JSON 原文）／**合成测试行为**（人为构造）／**模型最终采用**（本答复引用的结论来源）。

---

## G. hook 实际触发 — 部分通过（合成链路通过；真实宿主触发待下一条用户消息）

### G1. Zcode hook 支持判定：支持（非 unsupported）

依据（zcode-guide 官方文档）：工作区 `<repo>/.zcode/config.json`（或 `zcode.json`）支持 `hooks: { enabled: true, events: { <Event>: [...] } }`，事件含 `SessionStart`、`UserPromptSubmit` 等 7 种；`type: process` 以参数向量直调可执行文件。配置文件 hook 默认禁用，需显式 `enabled: true`。

### G2. 既有 `.claude/settings.json` hooks 未被 Zcode 触发（证据）

`ctx integrate claude inspect` 显示项目已安装 session-start/user-prompt 两个 claude-code hooks（`node main.js hook claude-code …`）。但 18:15（用户提交追加消息）前后主项目 journal 仅出现 `interface=cli, trigger=manual` 与 `interface=mcp, trigger=tool-call` 的观察，**无任何 `interface=hook`**——Zcode 不读取 `.claude/settings.json` hooks（与其文档声明的配置源一致）。

### G3. 合成触发（隔离项目，标注：非宿主触发）

干净 JSON（经文件管道，避免 shell 转义）执行：

```
cat hook-input.json | ctx hook claude-code user-prompt
→ {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Implement → Verify → Handoff\n…"}}
```

隔离项目 journal（18:29:57–58）产生完整三连事件：

1. `host.capability.declared {interface:"hook", adapter:"claude-code", triggers:["session-start","user-prompt"]}`
2. **`host.trigger.observed {interface:"hook", trigger:"user-prompt", status:"observed", sessionId:"33f202a1…"(哈希), taskId:"fa70c182…"(哈希)}`**（evt-mv8g2tp0-082c3e1951bcc463）——用户要求核验的核心断言成立
3. `host.prompt.submitted {intent:"clean stdin pipe test…"(脱敏后), privacy.classification:"redacted-text"}` + `usage.operation.completed`

直调 API（`runClaudeCodeHook`，18:24:46–48）与分步直调（18:24:21/22、18:25:31）同样产生上述事件。sessionId/taskId 写入前经 contentHash 哈希（符合 know-mv2cu9nv 同源的隐私设计）。

### G4. 真实宿主触发：hook 已安装，待用户下一条消息验证

已在主项目写入 `D:\client\fluffy-context\.zcode\config.json`（新增文件，内容如下，`type: process` 规避 shell 转义）：

```json
{ "hooks": { "enabled": true, "events": { "UserPromptSubmit": [ { "hooks": [ { "type": "process", "command": "C:\\nvm4w\\nodejs\\node.exe", "args": ["C:\\Users\\…\\fluffy-context\\dist\\src\\cli\\main.js", "hook", "claude-code", "user-prompt"], "timeoutMs": 20000 } ] } ] } } }
```

`UserPromptSubmit` 只能由用户提交消息触发，本回合内无法自造。安装时刻主项目 journal 中 `interface=hook` 观察数为 0（已核验）。**下一条用户消息后应在主项目 journal 出现 `host.trigger.observed{interface:"hook", trigger:"user-prompt"}`；若未出现，则说明 Zcode 需重启会话才会加载工作区 hook 配置（该限制将如实记录）。验证完成后如不需要可删除该文件。**

### G 组失败记录（首次失败完整保留）

1. **stdin 管道静默失败**（18:23:2x，重试 2 次后定位）：`printf '{"cwd":"C:\\Users\\…"}' | ctx hook claude-code user-prompt` 返回 `{}`、零 journal 事件。根因：**测试侧问题**——Git Bash 管道将 JSON 中 `\\` 折叠为 `\`，`C:\Users` 的 `\U` 是非法 JSON 转义 → `JSON.parse` 失败 → `parseInput` 返回 null → hook 按设计静默 no-op（hook 不得让宿主失败）。改用文件管道（`cat clean.json | ctx hook …`）后链路完全正常。**fluffy-context 无缺陷**；该行为已作为项目 note 记录（note-mv8g55fa）。
2. 诊断过程中的两次 journal 复核误报（18:24:4x、18:30:0x）：时间过滤边界写错导致漏看已落盘事件（实际 18:24:46、18:29:57 均有事件）——测试方法问题，已修正为尾部 dump。

### G 组附带观察：宿主侧外部活动（未归因）

18:15:16 主项目出现 `ctx compile`（interface=cli, trigger=manual）+ 18:16:25 `ctx checkpoint`（创建 context `ctx-mv8flej4-2347544e`「ZCode beta10 validation results」，pendingTasks 与本次追加任务一致）——**均非本会话的工具调用**，疑似 Zcode 宿主侧按 AGENTS.md 指引执行的 inject/checkpoint。如实记录，不影响 G–I 结论；其创建的 context 后续被 H 组复用。

## H. delta 交付 — 未验收（delta 分支未观测到；根因已定位；unchanged 与替换语义通过）

### H1. 主项目序列（sessionId=zcode-beta10-h-delta, taskId=beta10-h-delta, maxChars=1200, scenario=verification）

| 步骤 | 操作 | 返回 |
| --- | --- | --- |
| 1 | 首次 inject | full(first-in-session)，manifestHash `dd26b402…`，12 来源 |
| 2 | `context_checkpoint`（快照 snap-mv8g4762，patch 模式） | — |
| 3 | 同参数 inject | **full(task-or-scope-changed)**, replacePrevious=true, manifestHash `46c41e52…`（非 delta） |
| 4 | 同参数 inject（无变化） | unchanged(duplicate)，manifestHash 不变 |
| 5 | `ctx note add`（contextId=null，未绑定） | —（note 未进候选：compile.ts:342 要求 note 通过 orient 层且绑定当前 context） |
| 6 | 同参数 inject | unchanged(duplicate)（note 未入选，manifestHash 不变） |
| 7 | `ctx note add --context ctx-mv8flej4…`（note-mv8g6c34，绑定） | —（note 进入交付正文） |
| 8 | 同参数 inject | **full(evidence-changed)**, replacePrevious=true, 来源 11→10（非 delta） |

### H2. 隔离项目受控实验（maxChars=4000，预算余量充足）

| 步骤 | 操作 | 返回 |
| --- | --- | --- |
| 1 | 首次 inject | full(first-in-session)，4 来源，168/4000 字符 |
| 2 | 绑定 note（note-mv8g6wfg） | — |
| 3 | 同参数 inject | **full(evidence-changed)**（纯新增 4→5 仍判变化） |
| 4 | 同参数 inject | unchanged(duplicate) |
| 5 | git commit（新增 marker 文件） | —（journal 出现 git.state.observed + git.head.changed） |
| 6 | 同参数 inject | **full(task-or-scope-changed)**（anchor.head 变化） |

### H3. 根因分析（代码定位）

`session.ts:97-118` 的交付判定：`boundaryHash` 包含 taskId、**context.id、snapshot.snapshotId**、anchor（git HEAD）、scenario、budget；delta 仅当「边界不变 + 仅新增候选 + 既有项 hash 全不变」时触发（`session.ts:118`，reason=new-evidence）。

实测所有证据产生路径都必然破坏该前提：

- **checkpoint** → 新 snapshot → 边界变（task-or-scope-changed）；
- **git commit** → anchor.head 变 → 边界变；
- **绑定 note** → `sources.ts:100 provenanceFor(events, contextId)` 将 note.recorded 选为 context 的新 provenance 事件 → `compile.ts:247` 的 contextSource 变 → 全部 current-context 候选项 `itemHash = contentHash({candidateId, source, content, text})` 变 → evidence-changed。

即：**任何产生证据的动作都会写 journal 事件，要么改边界、要么改 context provenance，delta 分支在当前选择/溯源规则下实际不可达**（防御性代码路径，注释明示"Retractions and edits require a replacement packet, never a silent delta"）。未提交文件的 fs 观察（workspace.paths.changed）理论上是不触碰两者的路径，但隔离项目两次尝试（runtime 在线）均未触发该事件，未再重试（≤2 次约束）。

**H 结论**：用户要求的"再 inject 确认返回 delta"实测返回**带明确 reason 的 full 替换包**（checkpoint→task-or-scope-changed；note→evidence-changed），语义可解释且无静默丢失（replacePrevious=true + 正文含新证据）；`unchanged` 幂等多次验证通过；`delta` 模式未能观测到，按清单规则记**未验收**并给出上述根因。建议后续：若希望 delta 可达，可将 current-context 候选的 itemHash 与 provenance 事件解耦，或把 note.recorded 排除出 context provenance 候选。

## I. 隔离项目短 ID 错误分支 — 通过（含一项 schema 纠正）

隔离项目构造：git 仓库 + `ctx init`（v2，journal 从 0 起）+ 两个 checkpoint context：

- `ctx-mv8fs4fp-ef27546a`（iso context alpha）
- `ctx-mv8fs7l9-24e9c0b1`（iso context beta）

| 用例 | 输入 | 结果 |
| --- | --- | --- |
| 歧义短前缀 | `ctx resume --context ctx --path <iso>` | exit=1，`ambiguous context id ctx; matches: ctx-mv8fs4fp-ef27546a, ctx-mv8fs7l9-24e9c0b1`（列出全部匹配，无静默选择） |
| 主项目复验（24 contexts） | `ctx resume --context ctx --path D:\client\fluffy-context` | exit=1，`ambiguous context id ctx; matches: <24 个 ID 全列>` |
| 唯一前缀仍解析 | `ctx resume --context ctx-mv8fs4fp --path <iso>` | exit=0，解析 alpha |
| **deprecated（用户原话）** | 将 alpha 的 context.json status 改为 `deprecated` 后 resume | exit=1，`context not found: ctx-mv8fs4fp`——**`deprecated` 不是合法 ContextStatus**，loadContext 拒载、rebuildIndex 将其排除出索引（runtime.ts:213-231 的 catch 跳过畸形元数据） |
| **archived（合法非 active 状态）** | status 改为 `archived` 后 resume | exit=1，**`context is not active: ctx-mv8fs4fp-ef27546a`**（runtime.ts:398 分支命中；索引保留该 context，状态 archived） |

**Schema 纠正（重要发现）**：`ContextStatus = 'draft' | 'active' | 'stable' | 'archived' | 'deleted'`（runtime/types.ts:1）——context 生命周期**没有** deprecated/rejected（那是 KnowledgeStatus：candidate/verified/deprecated/rejected）。任务原话中的"deprecated/rejected context"在 beta.10 中应映射为 `archived`（或 draft/deleted）；`context is not active` 分支已用 archived 验证通过。附带行为：写入非法 status 不会报错而是使 context 从索引消失（表现为 not found）——建议后续对非法 status 给出显式诊断（doctor 或 resume 提示）。

歧义分支补充：E 组主报告曾判"歧义不可触发"，本组证伪——共享短前缀 `ctx` 即可触发（所有 ID 均以 `ctx-` 开头，任何 ≥2 context 的项目都天然可触发）；主报告中"段内前缀报 not-found 属规则设计"的结论不变。

## 追加汇总表

| 项目 | 结果 | 原始证据 | 限制或后续动作 |
| --- | --- | --- | --- |
| G-hook：合成链路 | 通过 | 隔离项目 journal evt-mv8g2tp0：`host.trigger.observed{interface:"hook", trigger:"user-prompt", status:"observed"}` + `host.prompt.submitted` + usage 三连（18:29:57） | 合成行为，非宿主触发 |
| G-hook：Zcode 支持 | 支持（非 unsupported） | zcode-guide 文档：工作区 `.zcode/config.json` hooks | — |
| G-hook：真实宿主触发 | **待验证** | `.zcode/config.json` 已安装 UserPromptSubmit hook；安装时主项目 interface=hook 计数=0 | 需用户下一条消息触发；若未触发需评估会话重启加载；验证后可删配置 |
| H-full/unchanged/替换 | 通过 | H1/H2 表格：first-in-session、duplicate、task-or-scope-changed、evidence-changed 四种 reason 均实测且可解释 | — |
| H-delta | **未验收** | 六条路径均未返回 delta；根因定位至 boundaryHash(snap/anchor) 与 provenance→itemHash 联动（session.ts:97-118, sources.ts:100, compile.ts:136/247） | 建议解耦 itemHash 与 context provenance，或评估 delta 触发条件放宽 |
| I-ambiguous | 通过 | 隔离项目 + 主项目双双触发 `ambiguous context id ctx; matches: …`（exit=1） | — |
| I-context is not active | 通过 | archived 状态 → `context is not active: ctx-mv8fs4fp-ef27546a`（exit=1） | deprecated/rejected 非法（见 schema 纠正）；建议非法状态显式诊断 |

## 结束状态与项目变更清单

- 主项目 runtime：运行中（instance `018d553f…`，心跳新鲜 2026-10-14T18:37:16Z）；journal `verified: true`，1277 事件。
- 隔离项目 runtime：已停止（journal 保留，38 事件，verified）。
- 主项目新增状态（全部为本验收的合法工作流记账）：`.zcode/config.json`（hook，待验证后可删）、note-mv8g55fa（hook stdin 发现）、note-mv8g6c34（delta 探针）、checkpoint snap-mv8g4762（追加测试进度）；另有宿主侧外部创建的 ctx-mv8flej4 及其快照（见 G 组附带观察）。
- 临时文件：`%TEMP%\fluffy-beta10-debug*.mjs`、`fluffy-beta10-hook-input.json`（诊断脚本，可删）；隔离项目 `%TEMP%\fluffy-beta10-iso`（证据，可删）。
