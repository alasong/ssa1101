# 架构概要设计（v1）

**目标**：在满足 `REQUIREMENTS.md` 的 23 条 R（覆盖 41 条 S）前提下，把自建量压到最小，并**按功能块落地**——骨架与配置 / 判定与工单内核 / 会话执行与恢复 / 触发与出站 / 观测与验收，5 块由 [TASKS.md](TASKS.md) 的 14 个任务认领 **1974 行 src（实测，原估 1,300）+ 500 行测试**，依赖层 8 层（记作 D0–D7，与 §1 的架构分层 L0–L4 无关）。
**核心判断**：**判定与台账归 kaa，会话与工具归 dsh，中间只留一个薄编排层。** 两个现成系统都不重写。
**两个维度不混淆**：树形（父子，4 层）表达"分解成哪几块"；依赖（8 层）表达"什么必须先做什么"。分层判据与每层读数见 §4。

---

## 0 一条实测约束（先写在最前面）

`dsh --profile desktop --dump-config` **跑不了**：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

后果：所有需要看"生效配置"的判据，**必须在一个非 Electron 管理的 profile 上跑**（例如 `superagent`）。这不是建议，是唯一可行路径——上一版 `REQUIREMENTS.md` 里 R20 的 verify_cmd 就踩在这上面。

---

## 1 分层

```
┌──────────────────────────────────────────────────────────────┐
│ L0 需求层    REQUIREMENTS.md  ⇄  kaa requirement 台账          │
│              写者：人 + kaa CLI        判据：覆盖自检脚本        │
├──────────────────────────────────────────────────────────────┤
│ L1 判定层    kaa（14 道门 / 25 个拒收码 / 证据契约 /          │
│              方法论语料 / registry / gap / events.jsonl）       │
│              写者：kaa CLI             判据：kaa doctor         │
├──────────────────────────────────────────────────────────────┤
│ L2 编排层    dsh-superagent-lite（新插件，薄）                  │
│              Source 适配 · intake 幂等 · ticket stage ·         │
│              effects 队列 · outbox · executor 适配             │
│              写者：Engine（单一）      判据：崩溃重放实验        │
├──────────────────────────────────────────────────────────────┤
│ L3 宿主层    dsh（会话 / 工具面 / preset / 权限 / 模型）        │
│              + pi-durable（可选耐久旁路）                       │
│              写者：dsh 自身            判据：两 preset 工具集不同 │
├──────────────────────────────────────────────────────────────┤
│ L4 通道层    ds-bot（群 / 私聊）· goal-tree 回写 · GitHub        │
│              写者：各通道适配器       判据：发送回执 + 幂等键     │
└──────────────────────────────────────────────────────────────┘
```

**为什么是这五层**：把 R01–R23 按"谁最容易对它们负责"归位，而不是按原型的 core/app 目录。原型的 `src/core`（15,205 行的一部分）与本设计 L1+L2 重叠，但 kaa 已经用更严的判据实现了 L1，重写它没有收益。

---

## 2 端口定义

层与层之间只有七个端口。端口是**数据结构 + 一条命令**，不是函数调用。

| 端口 | 方向 | 载荷（最小字段） | 实现方 |
|---|---|---|---|
| P1 Source→Intake | L4→L2 | `{source, external_id, at, actor, text, thread_key, channel}` | 编排层适配器 |
| P2 Intake→Gate | L2→L1 | `{candidate, rules, policy_version}` | kaa `requirement` + `auto-review` |
| P3 Gate→Ticket | L1→L2 | `{decision: accept/stop/ignore/unavailable, mandate}` | 编排层 |
| P4 Ticket→Executor | L2→L3 | `{ticket, assignment, dir, preset}` | `sessionController.create` |
| P5 Executor→Ticket | L3→L2 | `{ticket, assignment, report: progress/waiting/ready/blocked/failed/dropped}` | worker 的 report 工具 |
| P6 Ticket→Outbox→Channel | L2→L4 | `{id, channel, text, kind}` | `ds-bot` / goal-tree 回写 |
| P7 Ticket→kaa | L2→L1 | `{node, declarations, evidence_meta, verify_cmd}` | `kaa done` |

**端口纪律**：P1/P3/P5 的载荷都是**可序列化的纯数据**，不含闭包、不含宿主对象。原因：这些数据要落库、要重放、要跨进程。

---

## 3 写者表（每类状态只有一个写者）

| 状态 | 唯一写者 | 其余人怎么访问 |
|---|---|---|
| `event` / `ticket` / `effect` / `outbox` | 编排层 Engine | 只读查询 |
| 需求台账、门、证据、registry、gap | kaa CLI | 只读 `kaa status/list` |
| **目标树节点** | **kaa CLI（人也可直接改）** | 系统**只能**经 kaa CLI，**禁止**直接 POST `goal-tree/lib/http.js` 的 `/node-action` |
| 会话 / 工具面 / 权限 | dsh 自身 | `sessionController` API |
| 通道消息 | 各通道适配器 | outbox 回执 |

**这一行是本设计对上一版缺口 S1 的处置**：上一版里系统既回写目标树、人又从 UI 改，是双写者。现在定死——**系统的写一律经 kaa**（kaa 有自己的 revision CAS 与事件日志），goal-tree 的 HTTP 入口只留给人。代价是系统的改动会出现在 kaa 的事件流里而不是 goal-tree 的 UI 操作流里；收益是目标树的每次变更都可回溯。

---

## 4 每层的判据（都能判红）

| 层 | 判据命令 | 期望读数 |
|---|---|---|
| L0 | `REQUIREMENTS.md` 第 3 节脚本 | `41 41 []`（实测） |
| L1 | `python3 skills/kaa/kaa.py doctor` | `gates: 14 项`（实测）；红项只应来自既有历史需求 |
| L2 | 写一行 effect → `kill -9` → 重启 | 该行被执行且副作用只发生一次 |
| L3 | `dsh --profile superagent --dump-config \| grep -c 'id: tool-'` | router 面 ≠ worker 面（**必须在非 Electron profile 上跑**） |
| L4 | 同一 `id` 连发两次 | 接收方只收到 1 条（幂等键） |

---

## 5 复用边界：谁拥有什么，谁不许实现什么

| 能力 | 拥有者 | 明确不做 |
|---|---|---|
| 需求台账、覆盖门、done 门、证据契约 | kaa | 编排层**不实现**任何判定逻辑，只调 `kaa done` 并读退出码 |
| 事件溯源、状态投影、registry、gap | kaa | 编排层**不建**第二套事件日志 |
| 会话生命周期、工具面、权限、模型 | dsh | 编排层**不直接** spawn 进程或管理会话，只调 `sessionController` |
| 崩溃续跑（可选） | pi-durable | 编排层**不实现** WAL / 检查点 |
| 通道发送与重试语义 | ds-bot / 通道适配器 | 编排层只保证入队顺序与幂等键 |
| 工单状态机、副作用队列、幂等摄入 | **编排层自建** | —— |

**自建量**：上一轮实测——原型对应部件 `effects.ts` 161 行 + `background.ts` 165 行 + `migration.ts` 616 行 = **942 行**。本设计把 migration 与 background 的大部分交给 kaa/dsh，初估 600–900 行；逐模块拆到文件级后（`DETAILED-DESIGN.md` §1）估 1,300 行；**落地后实测 1974 行 src（+52%）**，多出的集中在仓储实现、执行器槽位与组合根接线三处（详设 §1.3 有逐项对照）。**以实测 1974 为准**；两次估算都偏低的共同原因：按"纯逻辑行数"估，漏掉仓储与接线。

### 5.1 现有插件的接线位置

（自旧 `DESIGN.md` §5 迁入——那份文件已删除，唯一还有价值的表就是这张。）

| 现有包 | 接到哪 | 动作 |
|---|---|---|
| `goal-tree` | `src/sources/goal-tree.ts` | 只写翻译层（`GET /tree` → Trigger），**不复用其 HTTP 写入口**（写者已定为 kaa） |
| `ds-bot` | `src/channel/ds-bot.ts`（v1 不做） | 进 bundles、配一个 bot 身份；D5 决定 v1 只做本地通道 |
| `auto-review` | Gate 的第二判据 | 进 bundles、开 Auto 权限预设；**只判当次调用，不留档**（故 mandate 快照自建） |
| `plugin-console` / `step-progress` | `src/panel/view.ts` | 加一个 `person/*` 视图，**不新建面板** |
| `turbo-preset` | `presets/router.patch.yml` + `presets/worker.patch.yml` | 从 `turbo` 派生两份清单，差异只写"少什么" |
| `hindsight-*` | 记忆 | 两个角色都要，但全栈只能挂一份（双注入的坑已踩过） |

---

## 6 关键决策

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D1 | 用 kaa 当判定层，不重写原型 core | kaa 的门三分类、证据契约、事件真相都比原型严；重写等于把 15,205 行再写一遍 | 判定要跨进程调 CLI，每次约几十毫秒 |
| D2 | 编排层保持薄（目标 ≤900 行） | 每多一行都是"又一个要维护的判定面" | 某些优化做不了（例如把 gate 内联） |
| D3 | 耐久层（pi-durable）做成**可选旁路** | spike 已证明可行，但主链路没有证据需要它 | 主链路崩溃恢复仍靠 effect 表 + 重启重放 |
| D4 | 目标树写者定为 kaa CLI | 消除 S1 双写者 | goal-tree UI 不显示系统改动 |
| D5 | 通道首版只做 goal-tree 回写 + 控制台 | `ds-bot` 要配账号，账号是外部依赖 | 群聊/飞书要等账号 |
| D6 | 所有"生效配置"判据只在非 Electron profile 上跑 | desktop profile 被独占，实测 `dump-config` 报错 | 需要先建 `superagent` profile |

---

## 7 风险与未解

| # | 风险 | 现状 |
|---|---|---|
| R1 | 跨进程调 kaa 的延迟累积（每条 ticket 至少 2 次调用） | 未实测；需在 P2 阶段量 |
| R2 | kaa 是 Python，编排层是 TS，类型不同步 | 靠 JSON schema + 契约测试；未做 |
| R3 | 人直接改目标树绕过 kaa 时，事件流缺一次记录 | 只能靠"人改后 kaa 侧 reconcile"；未设计 |
| R4 | `ds-bot` 未加载过，能力只读自述 | 未实测 |
| R5 | 常驻托管（R16 的最后一公里）仍无方案 | 明确不做 |
