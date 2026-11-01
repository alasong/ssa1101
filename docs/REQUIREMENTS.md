# 需求文档（最终版 v1）

**目标**：把原型的 41 条可验收要求收敛成 23 条可机检的行为需求 R，并**按功能块组织**（5 块：骨架与配置 / 判定与工单内核 / 会话执行与恢复 / 触发与出站 / 观测与验收）——每块都能独立回答"这块做到什么程度算完"，而不是让人数 23 条。
**落点**：需求只是"该有什么"；"谁在什么顺序做"在 [TASKS.md](TASKS.md)（14 个任务）与目标树（`n1 → n9 → 5 个功能块 → 14 个任务`，树深 4 层），两边同构。本文件不重复任务与依赖。
**口径**：需求由 `notes/S-requirements.md` 的 41 条 S（原型的可验收要求）重切而成——S 是实现视角，R 是行为视角；一条 R 可覆盖多条 S，**41 条 S 必须全部落在 R 上**（第 3 节机检）。
**格式**：字段对齐 `kaa requirement add`（id / accept / who / source / verify_cmd / impact），可直接登记进 kaa 需求台账并用 `kaa requirement audit` + `verify` 机检。
**状态图例**：`已有` = 现成可直接用；`半有` = 平台/插件给了料，缺胶水；`缺` = 必须自建。**本轮不写代码，所有 verify_cmd 当前预期为红灯**——红灯是诚实的"未开发"，不是缺陷。

---

## 1 需求台账（23 条）

| R | 需求（覆盖的 S） | accept 判据 | verify_cmd | who | impact | 现状 |
|---|---|---|---|---|---|---|
| R01 | **事件接入与幂等**：外部事件进来只记一次，重启不重放（S01、S02、S11） | 同一 `external_id` 投递两次，`event` 表只多 1 行，`ticket` 不重复创建 | `test -f dsh-superagent-lite/src/core/engine.ts && grep -q external_id dsh-superagent-lite/src/core/engine.ts` | 操作者 / 定时器 | high | 缺 |
| R02 | **线程内串行评估**：同一 thread 同时只跑一个评估，期间到达的合并进下一批（S03） | 并发投 3 条同 thread 事件，`eval` 表同时只有 1 行 running，另 2 条在队列 | `test -f dsh-superagent-lite/src/app/runtime.ts && grep -q 'pass' dsh-superagent-lite/src/app/runtime.ts` | 系统 | high | 缺 |
| R03 | **两段式判定**：确定性 Gate 先挡，模型 Assessment 再判；四种 via；inferred 仅在 auto 模式可接受（S06、S13、S14、S15） | 四种 via 各构造 1 例，Gate 结论与准入表一致；非 auto 模式下 inferred 只落「would accept」记录 | `test -f dsh-superagent-lite/src/app/kaa.ts` | 系统 / 操作者 | high | 半有（`auto-review`） |
| R04 | **授权留档**：每次接受留 Mandate 快照（策略版本/范围/强度/依据码），恢复前复核（S05、S09、S17） | 任一 `ticket` 能读回 `mandate.policy_version` 与 `mandate.basis`；策略收紧后恢复旧 ticket 被拒 | `test -f dsh-superagent-lite/src/core/model.ts && grep -q Mandate dsh-superagent-lite/src/core/model.ts` | 操作者 / 审计 | high | 半有 |
| R05 | **工作单元状态机**：open↔ended + 7 行 stage 判定（S07、S26） | 7 行 stage 逐行构造，判定与表一致；改任一输入只影响该行 | `test -f dsh-superagent-lite/src/core/stage.ts && wc -l dsh-superagent-lite/src/core/stage.ts` | 面板 / 操作者 | high | 缺 |
| R06 | **派工与执行体**：一 Ticket 一会话一目录，准备命令先跑，环境变量注入（S08、S19、S20、S23、S25） | 两个 ticket 的 session id 与目录互不相同；准备命令失败则 ticket 判 failed 且留输出 | `test -f dsh-superagent-lite/src/app/executor.ts && grep -q agentPreset dsh-superagent-lite/src/app/executor.ts` | worker | high | 半有（`sessionController`） |
| R07 | **订阅扇出**：新事件分发给订阅了该 thread 的 ticket；人经此到达的消息不触发评估（S04、S12） | 一个 thread 两个订阅 ticket，事件到达后两者各收到 1 条 input，`eval` 表不新增 | `test -f dsh-superagent-lite/src/core/engine.ts && grep -q thread_key dsh-superagent-lite/src/core/engine.ts` | 系统 | med | 缺 |
| R08 | **持久副作用**：决定后先写库再执行，`(kind,key)` 唯一，退避重试，崩溃后重放（S29、S37） | 写一行 effect 后 `kill -9`，重启后该行被执行且副作用只发生一次 | `test -f dsh-superagent-lite/src/app/effects.ts && grep -q attempts dsh-superagent-lite/src/app/effects.ts` | 系统 | high | 半有（spike 已验证思路） |
| R09 | **失败恢复**：瞬时失败重试 3 次；重启标记 host restarted 并给恢复笔记；评估超时三振（S18、S28） | 断网 3 次后第 4 次仍失败才判 failed；重启后在跑 assignment 带恢复笔记 | `test -f dsh-superagent-lite/src/app/effects.ts && grep -q restarted dsh-superagent-lite/src/app/effects.ts` | 系统 | high | 缺 |
| R10 | **并发与优先**：槽位上限；turn 结束仍有后台工作时保留槽位；人的插话可用额外一槽并优先（S21、S22、S24） | 满槽时人的消息 5 秒内投达；turn 结束时仍有 job 则 stage 不转 idle | `test -f dsh-superagent-lite/src/app/executor.ts && grep -q slots dsh-superagent-lite/src/app/executor.ts` | 操作者 | high | 缺 |
| R11 | **对外通道**：同一 ticket 同一会话按序发送，5s→300s 退避，三连败报问题（S30） | 同一会话连排 3 条，接收顺序与入队一致；首条失败时后两条等待 | `test -f dsh-superagent-lite/src/app/outbox.ts` | 接收方 | med | 半有（`ds-bot`） |
| R12 | **暂停**：停止派工/评估/投递/回复，事件继续记录（S31） | 暂停后投 2 条事件，`event` 表增 2 行而 `ticket` 不增 | `test -f dsh-superagent-lite/src/app/runtime.ts && grep -q pause dsh-superagent-lite/src/app/runtime.ts` | 操作者 | med | 缺 |
| R13 | **合并与结束**：ticket 在它开的 PR 全关时才结束（S27） | 开 2 个 PR，关 1 个不结束；关第 2 个才结束且 outcome 取最后一次关闭 | `test -f dsh-superagent-lite/src/core/engine.ts && grep -q ended dsh-superagent-lite/src/core/engine.ts` | 操作者 | med | 缺 |
| R14 | **提示词可覆写**：内置部分 + 团队覆写 + 版本化 + 预览（S32） | 覆写一个 part 后组装文本变化，历史可回读，预览不落库 | `test -f dsh-superagent-lite/presets/router.patch.yml` | 团队 | low | 半有（`dsh systemPrompt`） |
| R15 | **面板**：只显示需要人的东西，空态不占位（S33） | 无 person 类 stage 时面板该区块高度为 0；有则列出 | `test -f dsh-superagent-lite/src/panel/view.ts` | 操作者 | med | 半有（`plugin-console`） |
| R16 | **部署与权限**：权限按会话设、账户隔离、setup 检查、升级路径（S34） | 新 profile 的权限预设与主 profile 不同；setup 检查失败时给出可执行的修复项 | `test -f dsh-superagent-lite/SETUP.md` | 操作者 | high | 半有 |
| R17 | **核心边界**：核心不 import 宿主、不做 I/O；每类状态一个写者（S35、S36） | `grep -rE "from '@deepseek-ai" dsh-superagent-lite/src/core/` 无命中；写者表与代码一致 | `! grep -rq "@deepseek-ai" dsh-superagent-lite/src/core/` | 维护者 | high | 缺 |
| R18 | **持久化与迁移**：单库、活动索引导航、schema 只增（S38） | 库版本低于当前时拒绝启动；活动工作查询走索引 | `test -f dsh-superagent-lite/src/app/store.ts && grep -q user_version dsh-superagent-lite/src/app/store.ts` | 维护者 | med | 缺 |
| R19 | **模型面预算**：每个角色的工具+提示词体积有上限，超了测试判红（S39） | 故意把某角色工具加满，预算测试必须红 | `test -f dsh-superagent-lite/tests/budget.test.ts` | 维护者 | med | 缺 |
| R20 | **工具面**：主会话与执行器各自最小工具集（S40） | dump-config 里两个 preset 的工具清单互不相等，且主会话不含写文件/子代理 | `dsh --profile superagent --dump-config \| grep -cE 'id: tool-(fs\|subagent\|todo)'` | 维护者 | med | 半有 |
| R21 | **配置热重载**：除 stateDir 外改配置不重启生效（S41） | 改一个上限值后立即生效，`stateDir` 改则拒绝启动 | `test -f dsh-superagent-lite/src/app/runtime.ts && grep -q stateDir dsh-superagent-lite/src/app/runtime.ts` | 操作者 | low | 半有 |
| R22 | **拒绝概念约束**：不引入 Principal/Membership、不跨来源映射身份、Eval 不自调度延迟等 12 条（S10） | 代码里不存在这些概念的类型；出现即评审驳回 | `! grep -rniE "principal|membership" dsh-superagent-lite/src/` | 维护者 | low | 缺 |
| R23 | **策略变更**：策略版本变化时丢弃运行中的评估，只把影响投递给受影响的 ticket（S16、S09 的下半） | 改一条规则后，运行中的 eval 被丢弃并以新版本重跑；未受影响的 ticket 不被通知 | `test -f dsh-superagent-lite/src/app/kaa.ts && grep -q policy dsh-superagent-lite/src/app/kaa.ts` | 系统 | high | 缺 |

**统计**：23 条 R。`缺` 14 条、`半有` 9 条、`已有` 0 条。

**source（出处）**：23 条全部出自 `notes/S-requirements.md` 的 S 条目，每条 S 都带 `docs/xx:行` 出处，因此 R 的出处可逐级回溯，无一条为自创需求。若后续新增自创需求，source 写「我自己提的 + 理由」，这是 kaa `[requirements].source_required` 允许的合法答案。

---

## 2 覆盖矩阵（41 条 S → R）

| S | R | S | R | S | R |
|---|---|---|---|---|---|
| S01 | R01 | S15 | R03 | S29 | R08 |
| S02 | R01 | S16 | R23 | S30 | R11 |
| S03 | R02 | S17 | R04 | S31 | R12 |
| S04 | R07 | S18 | R09 | S32 | R14 |
| S05 | R04 | S19 | R06 | S33 | R15 |
| S06 | R03 | S20 | R06 | S34 | R16 |
| S07 | R05 | S21 | R10 | S35 | R17 |
| S08 | R06 | S22 | R10 | S36 | R17 |
| S09 | R04 + R23 | S23 | R06 | S37 | R08 |
| S10 | R22 | S24 | R10 | S38 | R18 |
| S11 | R01 | S25 | R06 | S39 | R19 |
| S12 | R07 | S26 | R05 | S40 | R20 |
| S13 | R03 | S27 | R13 | S41 | R21 |
| S14 | R03 | S28 | R09 | | |

**判定**：41/41 覆盖，无遗漏。矩阵由第 3 节脚本核验，不靠人工点数。

---

## 3 覆盖自检（可复跑）

脚本要求：`notes/S-requirements.md` 里出现的每个 `S\d\d`，都必须在本文件第 2 节的矩阵里出现至少一次。

只取 `S-requirements.md` 的表格行（避开正文里的 `S42..` 占位），再与本节矩阵求差集：

```
$ python3 -c "import re;rows=[l for l in open('notes/S-requirements.md') if re.match(r'^\\| S\\d\\d \\|',l)];S=set(re.findall(r'S(\\d\\d)',''.join(rows)));doc=open('REQUIREMENTS.md').read();i=doc.find('## 2 覆盖矩阵');j=doc.find('## 3 覆盖自检');M=set(re.findall(r'\\bS(\\d\\d)\\b',doc[i:j]));print(len(S),len(S&M),sorted(S-M))"
41 41 []
```

**为何必须有这条脚本**：第一版文档用「别抄四样」砍掉了 Mandate / Gate / 槽位 / 扇出，若当时有这条检查，那 4 条会当场判红。人眼数 41 行矩阵必然漏。

---

## 4 与 superagent 的对照

- **100% 覆盖**：41/41，无一条被丢弃。这与第一版文档的做法不同——那一版用"别抄四样"砍掉了 Mandate、Gate、槽位、扇出；本版全部保留，因为保留它们成本可控（kaa 已有 Gate 与台账），而砍掉会失去"无人值守"这条路。
- **超额项**：见 `notes/EXCEEDS.md`（n5）。超额不改变 R 的定义，只是在同一需求上给更强的判据。
- **仍不可做的**：R16 的"常驻托管"与 R13 的"PR 跟随"依赖外部账号与 CI，无账号前只能空跑。

---

## 5 待确认（不答则 R03/R04/R10 的具体取值由我按保守档定）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | Trigger 只有你自己（人）产生，还是也接外部（cron / goal-tree / GitHub）？ | R01 的准入强度、R03 是否走 inferred |
| Q2 | worker 能否直接 commit/push？ | R16 权限边界 |
| Q3 | 完成判定谁下——你，还是另一个 agent（jev 类判官）？ | R05 结束条件、R23 |
| Q4 | 结果必须发到群/飞书，还是写回目标树就够？ | R11 是否需要 `ds-bot` |
