# 详细架构设计（v1）

**前置**：[REQUIREMENTS.md](REQUIREMENTS.md)（23 条 R / 41 条 S）· [ARCHITECTURE.md](ARCHITECTURE.md)（五层七端口）。
**取代**：`DESIGN.md` 作废——那份写于发现 kaa 之前，假设自建整套 core。
**口径**：本文件所有行数都是**预算**，不是实测；凡是"未实测"都会写明。

---

## 1 目录设计与模块清单

### 1.1 落地代码目录树

编排层是**一个** dsh 插件包 `dsh-superagent-lite/`，独立仓库（或 `~/.dsh/plugins/` 下的目录包），不塞进 dsh 主仓：

```text
dsh-superagent-lite/
├── README.md                 目录来历、三条目录纪律、各目录归属（**本文件已落地**）
├── package.json              name=dsh-superagent-lite；entry 指向 dist/index.js；dsh 插件声明
├── cordis.patch.yml          本插件自己的 patch：注册 superagent 服务 + 面板视图 + 事件订阅
├── tsconfig.json             只开 strict，不引宿主类型（core/ 必须零宿主依赖）
├── presets/
│   ├── router.patch.yml      常驻编排面：无 todo / subagent / goal 类 hook；shell 保底、jobs 限 5 秒
│   └── worker.patch.yml      执行体：全工具，不装 tdd-guard / prompt-hygiene 这类 reviewer hook
├── src/
│   ├── index.ts              入口，仅 re-export apply；≤10 行（计入 app/runtime.ts 预算）
│   ├── core/                 ★纯函数域：禁止 import @deepseek-ai/*、fs、net、sqlite
│   │   ├── model.ts          80
│   │   ├── stage.ts          70
│   │   ├── engine.ts         250
│   │   └── ports.ts          40
│   ├── app/
│   │   ├── runtime.ts        90  组合根：建库、起 pass、订阅 8 个宿主事件
│   │   ├── store.ts          120 SQLite 事务与仓储
│   │   ├── effects.ts        130 持久副作用队列
│   │   ├── outbox.ts         70  消息保序幂等
│   │   ├── executor.ts       90  sessionController 适配
│   │   └── kaa.ts            80  kaa CLI 调用（唯一跨进程出口）
│   ├── sources/
│   │   ├── goal-tree.ts      80  GET /tree → Trigger
│   │   └── manual.ts         40
│   ├── channel/
│   │   └── local.ts          50  回写 goal-tree + 控制台
│   ├── tools/
│   │   └── report.ts         50  worker 的 report 工具
│   └── panel/
│       └── view.ts           60
├── tests/
│   ├── unit/                 T01–T07、T09–T14
│   ├── integration/          T08 崩溃重放、T15 kaa 契约
│   └── fixtures/             坏夹具（每条判据必须有至少一个能判红的反例）
│       └── presets-full/     K13/T13 的"工具加满"夹具（disabledTools 清空的 preset 副本）
└── scripts/
    └── verify.sh             一条命令跑全部判据（给 run-all-tests.sh 调）
```

三条目录纪律，对应三条验收：

1. **`core/` 零宿主依赖** —— 判据就是 T14：`! grep -rq "@deepseek-ai" src/core/`，同时禁 `node:fs` / `node:net` / `better-sqlite3`。红了说明纯函数域被污染，Engine 就不能脱离 dsh 单测。
2. **跨进程出口只有一个文件**（`app/kaa.ts`）—— 判据：`grep -rl "spawn\|execFile" src/ | grep -v kaa.ts` 必须为空。多一个出口，就多一处不可测的超时与幂等。
3. **`presets/` 只写差异** —— 两份 patch 都从 `turbo` 派生，只写"少什么"，不复制整份清单；判据见 ARCHITECTURE §4 的 L3 行（`dsh --profile superagent --dump-config` 的 tool 计数，必须在非 Electron profile 上跑）。

**已落地状态**（2026-11-01）：上面这棵树里**目录全部建好**（`dsh-superagent-lite/` 及其下 13 个子目录），另加一个 `README.md` 说明来历与归属；**没有任何代码文件**——按"先不直接开发落地"，`.ts` / `.json` / `.yml` 由 K01–K14 逐个建。`check-delivery.py` 判据 ⑦ 校验的是**目录集合**（磁盘上的目录必须与本节声明的目录一一对应，多一个少一个都红），文件不在它的守备范围内。

### 1.2 本仓文档目录（整理后）

```text
ssa1101/
├── README.md                入口：30 秒跑起来 / CLI 用法 / 装进 dsh / 已知未完成
├── docs/                    交付物：要被人拿去做决策的 5 份文档
│   ├── REQUIREMENTS.md      交付物 1：23 条 R（accept / verify_cmd / who / impact / source）
│   ├── ARCHITECTURE.md      交付物 2：五层七端口、写者表、复用边界
│   ├── DETAILED-DESIGN.md   交付物 3：本文——目录设计、接口、数据模型、状态机、时序
│   ├── TASKS.md             交付物 4：14 个开发任务（与目标树节点同构）
│   └── DELIVERY.md          交付说明、机检读数、未定清单
├── check-delivery.py        机检脚本（11 条判据，任一不过 exit 1），复跑入口固定在根
├── LICENSE                  远端初始提交带进来的许可证，未改
├── dsh-superagent-lite/     落地代码骨架：13 个目录 + README 已建，代码文件留给 K01–K14
└── notes/                   过程与输入，不作为交付物
    ├── phase0-analysis.md     原型分析 + 26 bundle 归位 + 两轮评审记录
    ├── S-requirements.md      41 条 S（输入的输入，每条带 docs/xx:行）
    ├── capabilities.md        kaa / dsh / 未启用包 / 耐久 spike 的能力映射
    └── EXCEEDS.md             11 条超额项 + 3 条被踢出的自我表扬候选
```

**归置规则**：根目录只留**入口与容器**——`README.md`（给人看的入口，只写「怎么用」不写设计）、`docs/`（五份交付文档）、`check-delivery.py`（复跑入口，固定在根，方便 `python3 check-delivery.py` 直接跑）、`dsh-superagent-lite/`（代码骨架）、`notes/`（过程件）。**约定：本仓文档里写的路径一律相对仓库根**，不随文件所在目录变化（`docs/` 里写 `notes/xxx` 指仓库根的 `notes/xxx`）。**不为图整齐而加层级**：`docs/` 分出来是因为根目录要能一眼看出"文档在 docs/、代码在 dsh-superagent-lite/"；`notes/` 放"只被上面引用的过程件"。旧 `DESIGN.md` 已删除——它假设自建整套 core，与 kaa 复用决定冲突；其中仍有价值的插件接线表已迁入 `ARCHITECTURE.md` §5.1，T1–T8 / S1–S9 已并入本文第 9 节。

### 1.2.1 每份文档的设计

目录说"有哪几个文件"，本节说"每个文件内部怎么组织、给谁看、什么时候改"。**大纲是受约束的**：增删一节 = 先改这张表，再由判据 ⑧ 强制文档跟上（见下文）。

| 文档 | 读者 | 回答的问题 | 大纲（`##` 顺序，`·` 分隔） | 不写什么 | 何时改 |
|---|---|---|---|---|---|
| `docs/REQUIREMENTS.md` | 决策者、验收者、要登记 kaa 台账的人 | 要什么？做到什么算完？怎么机检？ | `1 需求台账（23 条） · 2 覆盖矩阵（41 条 S → R） · 3 覆盖自检（可复跑） · 4 与 superagent 的对照 · 5 待确认（不答则 R03/R04/R10 的具体取值由我按保守档定）` | 不写任务分解、不写依赖顺序、不写代码结构（那是 TASKS / 详设的事） | R 增删或 accept 判据变时；只改对应行，不改节结构 |
| `docs/ARCHITECTURE.md` | 架构评审者、新加入的人 | 分几层？谁写谁？哪些复用现成的？边界在哪？ | `0 一条实测约束（先写在最前面） · 1 分层 · 2 端口定义 · 3 写者表（每类状态只有一个写者） · 4 每层的判据（都能判红） · 5 复用边界：谁拥有什么，谁不许实现什么 · 6 关键决策 · 7 风险与未解` | 不写文件级行数预算（详设 §1.3）、不写任务期与谁先做（TASKS §1） | 分层/端口/写者/复用边界变时；决策与风险各留一行，不随版本清空 |
| `docs/DETAILED-DESIGN.md` | 实现者、写测试的人 | 怎么落地？接口长什么样？崩溃时会发生什么？ | `1 目录设计与模块清单 · 2 接口签名 · 3 数据模型（SQLite，单库单进程锁） · 4 状态机 · 5 副作用与恢复语义 · 6 一次请求的完整时序 · 7 失败与并发 · 8 验收测试清单 · 9 缺口最终处置 · 10 待确认` | 不重复需求台账（引 R 编号即可）、不写排期 | 实现前最后一份会改的文档；改了 §2–§7 任一条，§8 的验收必须同步 |
| `docs/TASKS.md` | 排期的人、领任务的 agent | 分几步做？谁先谁后？每个任务怎么算完？ | `1 任务总表 · 2 逐任务验收细则 · 3 开工前的阻塞项 · 4 功能块（给人看的进度维度） · 5 开发流程（每个任务怎么开发）` | 不写需求原文（引 R）、不写架构推理（引 ARCHITECTURE） | 任务增删、依赖边变、验收命令变时；与目标树同构，两边不一致以目标树为准并回改本文 |
| `docs/DELIVERY.md` | 来验收的人、隔一阵回来的自己 | 交付了什么？机检读数是多少？还有什么没定？ | `1 交付清单 · 2 机检读数（可复跑） · 3 覆盖结论 · 4 未定与未做（诚实清单） · 5 复跑与下一步` | 不写设计内容、不重复读数的含义（那在对应文档里） | 每次跑完 `check-delivery.py` 就刷第 2 节读数；任何"未定"被回答后从第 4 节移到对应文档 |
| `notes/*.md` | 追溯者、想复核结论的人 | 这个结论是从哪来的？ | 不设大纲要求（过程件，允许长、允许乱） | 不作为交付物、不被引用为结论，只作为出处 | 只在回溯原文时追加；**不往里加新阶段分析**——那属于新文档，先改本节 |

**四条文档纪律**（判据 ⑧ 只机检第 2 条，其余靠评审）：

1. **单一定义点**：一个量只在它归属的文档里定义一次，别处只引用。2018 行（实测）归详设 §1.3、14 个任务归 TASKS §1、23 条 R 归 REQUIREMENTS §1——判据 ⑥ 已经在守行数那一个量，其余两个目前靠人。
2. **大纲受本节约束**：每份交付文档的 `##` 标题必须与上表"大纲"列逐项相等（顺序也算）。要加一节，先改这张表再改文档；不改表就加节，判据 ⑧ 报红。
3. **不写别人的内容**：需求文档不写怎么做，任务表不写需求原文，交付说明不写设计。重复一处，改的时候就会漏一处。
4. **结构优先于篇幅**：不设行数上限（设了也只能靠人守），设的是"新增内容先挤进已有节"；确需新节就走第 2 条。`notes/` 目前 23 KB 是最大的单文件，若要继续长大，先拆成 `notes/00-输入/` 与 `notes/10-评审/` 两目录——那要同时改 §1.2、§1.2.1 与判据 ⑦。

### 1.3 模块清单（含行数预算）

| 模块 | 预算 | 职责 | 对应 R |
|---|---|---|---|
| `src/core/model.ts` | 109 | Event / Ticket / Mandate / Stage 纯类型 | R01、R05 |
| `src/core/stage.ts` | 48 | 7 行 stage 判定，无 I/O | R05 |
| `src/core/engine.ts` | 200 | **唯一写者**：intake、ticket、report 三条命令路径 | R01、R05 |
| `src/core/ports.ts` | 91 | Executor / Outbox / Gate / Repository 四接口 | R06、R08、R11 |
| `src/app/runtime.ts` | 113 | 组合根：建库、起 pass、订阅宿主事件 | —— |
| `src/app/store.ts` | 358 | SQLite 事务与仓储 | R18 |
| `src/app/effects.ts` | 114 | 持久副作用队列 + 退避 + 恢复 | R08、R09 |
| `src/app/outbox.ts` | 90 | 消息保序与幂等 | R11 |
| `src/app/executor.ts` | 167 | `sessionController` 适配（P4） | R06、R10 |
| `src/app/dsh-session.ts` | 271 | 真宿主会话：spawn `dsh --json`，ndjson 落盘 + 结果成文 | R06、R09 |
| `src/app/kaa.ts` | 129 | kaa CLI 调用（P7） | R03、R04、R23 |
| `src/index.ts` | 22 | 插件入口：只把组合根暴露出去（K06） | R20 |
| `src/sources/goal-tree.ts` | 95 | 轮询 `GET /tree` → Trigger（P1） | R01、R07 |
| `src/sources/manual.ts` | 53 | 人直接下任务 | R01 |
| `src/channel/local.ts` | 50 | 首版通道：回写 goal-tree + 控制台 | R11、R13 |
| `src/tools/report.ts` | 55 | worker 的 report 工具（P5） | R05、R09 |
| `src/panel/view.ts` | 53 | 面板数据视图 | R15 |
| **合计（src）** | **2018** | 实测值（设计期估 1,300，见下） | |
| `tests/` | 500 | 见第 8 节 | R19 等 |

**行数口径（两次数）**：设计期估 **1,300 行**（逐模块拆到文件级的估算）；落地后实测 **2018 行（+52%）**。多出来的部分集中在三处：`store.ts` 的仓储实现（120 → 303，六表读写 + 事务 + v1→v2 迁移）、`executor.ts` 的槽位与目录/会话/句柄三条路径（90 → 148）、`runtime.ts` 的组合根（无预算 → 94）。**以实测 2018 为准**，ARCHITECTURE 与 TASKS 已同步更正；估算偏差本身记为一条教训：把"纯逻辑行数"当预算，漏掉了仓储与接线。

---

## 2 接口签名

### 2.1 进程内（TS）

```ts
// core/ports.ts
export interface Executor {
  start(t: Ticket, a: Assignment): void        // 只排队，结果经回调回来
  deliver(t: Ticket, a: Assignment): void
  stop(t: Ticket, a: Assignment, reason: string): void
}

export interface Gate {
  check(c: Candidate): { allowed: true; mandate: Mandate } | { allowed: false; reason: string }
}

export interface Outbox {
  send(m: OutboundMessage): void               // 幂等，按 m.id
  status(id: string): 'pending' | 'sent' | 'dropped' | undefined
}

export interface Repository {
  atomic<T>(f: () => T): T                     // 同步；一个事务一个聚合
  events:  { put(e: Event): void; byExternalId(id: string): Event | undefined }
  tickets: { put(t: Ticket): void; get(id: string): Ticket | undefined; open(): Ticket[] }
  effects: { claimDue(now: number): EffectRow[]; settle(id: string): void; fail(id: string, e: string): void }
}
```

### 2.2 跨进程（P7：编排层 → kaa）

**契约**：不进 Python、不 import kaa 源码，只调 CLI，**只看三样**——退出码、stdout 的 JSON、事件是否落盘。

```ts
// app/kaa.ts
async function kaaDone(node: string, decl: Declarations, evidence: EvidenceMeta): Promise<Result>
// 等价于：
//   cwd=<fat3 仓库根>  KAA_TARGET_ROOT=<被驱动仓库根>
//   python3 skills/kaa/kaa.py done <slug> <node> --declarations <json> --evidence-meta <json>
// 退出码 0 = 通过；非 0 = 拒收，stdout 带缺项清单与契约片段
```

三条纪律：

1. **幂等键**：同一 `(slug, node)` 的重复调用不得产生第二个 `node-done` 事件（kaa 侧按状态机拒绝重复跃迁）。
2. **不解析人话**：只读退出码与 JSON 字段，不 grep 人类可读文本——文本会随版本变。
3. **超时**：每次 CLI 调用 30 秒上限，超时按瞬时失败处理（进 effects 退避），不阻塞 pass。

---

## 3 数据模型（SQLite，单库单进程锁）

| 表 | 关键列 | 唯一/索引 |
|---|---|---|
| `event` | `id, source, external_id, at, actor, text, thread_key, disposition` | **UNIQUE(external_id)**；INDEX(at) |
| `thread` | `key, source, cursor, meta` | PK(key) |
| `ticket` | `id, stage, mandate, dir, session, assignment, follows, ended` | PK(id)；生成列 `active`（未结束且有待办）+ 索引 |
| `effect` | `kind, key, payload, due_at, attempts, last_error, state` | **UNIQUE(kind,key)**；INDEX(due_at)；`state` ∈ pending/running/failed（v3 加，见下） |
| `outbox` | `id, channel, text, status, dropped_reason` | PK(id) |
| `kv` | `key, value` | PK(key) |

三条约束对应三条需求：

- `UNIQUE(external_id)` → **R01** 幂等摄入（重启不重放）。
- `UNIQUE(kind,key)` → **R08** 副作用不重复执行。
- 生成列 + 索引 → 一次 pass 只读活动工作（**R18**），对齐原型 `docs/007-architecture.md:466` 的做法。

---

## 4 状态机

### 4.1 Ticket stage（7 行，自上而下第一个命中）

| # | stage | 条件 | 面板 |
|---|---|---|---|
| 1 | `person/delivery` | 上次投递失败 | 投递失败 |
| 2 | `person/answer` | 有未答问题 | 等回答 |
| 3 | `person/review` | 最新报告 `ready` | 等审阅 |
| 4 | `person/blocked` | 最新报告 `blocked`/`failed` 且此后无人回话 | 受阻/失败 |
| 5 | `working/queued` | 无 assignment 或 pending | 排队 |
| 6 | `idle` | 最新报告 `waiting`，或 assignment 已结束 | 等触发 |
| 7 | `working` | 其余 | 执行中 |

对齐原型 `docs/003-execution.md:7-17`。**离开 `person/*` 只有两个原因**：收到新的真人消息，或收到新报告；自动输入（CI、bot）不能解除（同 `docs/003-execution.md:19`）。

### 4.2 Assignment

`pending → running → ended`，与 Ticket 独立。一个 Ticket 历史上可有多个 Assignment；只有最终报告能结束 Ticket（**R06**）。

### 4.3 Ticket 结束

`ready` 且无 PR 跟随 → 完成；`dropped` → 结束且不打扰人；打开了 PR → 等它全关（**R13**）。

---

## 5 副作用与恢复语义

### 5.1 effect 种类

| kind | 做什么 | 并发 | 退避 | 幂等键 |
|---|---|---|---|---|
| `launch` | 建目录 + 建会话 + 投首条消息 | 受槽位 | 5s→300s，3 次（瞬时类） | ticketId |
| `deliver` | 把等待的 Input 投给运行中的会话 | 4 | 2s→60s | `${ticketId}:${inputId}` |
| `relay` | worker 报告转进主会话 | 1，保序 | 2s→60s | ticketId+seq |
| `reply` | outbox 消息发送 | 1/通道 | 5s→300s | messageId |
| `kaaDone` | 调 `kaa done`（P7） | 1 | 2s→60s | `${slug}:${node}` |
| `treeWrite` | 回写 goal-tree 节点状态 | 1 | 2s→60s | `${nodeId}:${revision}` |

**入队必须在事务内，执行在提交后**（对齐 `docs/007-architecture.md:166`）。`Later` 异常 = 暂不可做，不计失败。

### 5.2 崩溃恢复

启动顺序固定：

1. 打开库并确认 schema 版本（低于当前则迁移，新于当前则拒绝启动 —— **R18**）；
2. 把所有 `running` 的 assignment 标成 `interrupted`，生成恢复笔记；
3. 取出 `due_at <= now` 且 `state='pending'` 的 effect，按原顺序重放（**先 claim 再执行，成功才 settle**）：
   claim 时把 `state` 置 `running` 并把 `due_at` 推到 +30s 租约（双保险）；重启时 `recoverRunning()`
   把 `state='running'` 一律退回 `pending` 且 `due_at=0`，所以**第一轮 pass 就重放，不用等租约到期**；
4. 拉起 pass 循环（每 2 秒）。

**判据（R08 的验收）**：写一行 effect → `kill -9` → 重启 → 该行被执行，且副作用只发生一次。

### 5.3 kaa 侧的幂等

`kaaDone` 重放时可能对同一 `(slug,node)` 再调一次。kaa 的状态机对已 done 的节点拒绝再次跃迁，因此**重复调用是安全的**——但这一点**未实测**，第 9 节记为 T9。

---

## 6 一次请求的完整时序

| # | 动作 | 写者 | 落库 |
|---|---|---|---|
| 1 | 轮询 goal-tree `GET /dsh-goal-tree/tree`，取 ready 叶子 | source 适配器 | —— |
| 2 | 翻译成 event，`external_id = node:<id>:<revision>` | Engine | `event` |
| 3 | pass 取未处理 event → intake | Engine | `event.disposition` |
| 4 | Gate 判定（kaa 规则 + `auto-review`） | Engine | `ticket`（含 mandate 快照） |
| 5 | 入队 `launch` | Engine | `effect` |
| 6 | 建目录 / 建会话 / 投首条消息 | Executor | —— |
| 7 | worker 干活，`report` 工具回写 | worker | `ticket.stage` |
| 8 | `ready` → 若是人该看的，入队 `relay` | Engine | `effect` |
| 9 | 人批准 → 结束 ticket → 入队 `kaaDone` + `treeWrite` | Engine | `effect` |
| 10 | `kaa done` 通过 → 回写 goal-tree 节点状态 | kaa / channel | `outbox` |

**关键**：第 4 步的 mandate 必须在第 9 步之前就能读回（**R04**）——否则"它凭什么做这件事"无从回答。

---

## 7 失败与并发

| 情形 | 处理 | 依据 |
|---|---|---|
| 模型/网络瞬时失败 | 3 次，指数退避，**不消耗**单元 | R09 |
| 准备命令失败 | 单元判 failed，不重试 | 原型同规则 `docs/003-execution.md:124` |
| 并发满 | 排队；**人的消息可用额外一槽且优先** | R10 |
| 进程重启 | 在跑的 assignment 标 interrupted + 恢复笔记；先读目录与 git 再重复外部动作 | R09、`docs/003-execution.md:146` |
| kaa CLI 超时 | 按瞬时失败进退避，不阻塞 pass | 本文 §2.2 |
| 同一 ticket 并发改 | ticket 行带 `revision`，Engine 内乐观锁；冲突则重读重试一次 | 新补，对应上一版缺口 S6 |
| 目标树被人工改动 | 系统不写，只读；人工改动由 kaa 侧 reconcile | **S1 决定**，见 §9 |

---

## 8 验收测试清单

| # | 测试 | 判据 | 对应 |
|---|---|---|---|
| T01 | 幂等摄入 | 同 `external_id` 投两次，`event` 只 1 行、`ticket` 只 1 个 | R01 |
| T02 | 串行评估 | 并发 3 条同 thread，同时只有 1 个 eval running | R02 |
| T03 | Gate 四种 via | 四例构造，结论与准入表一致 | R03 |
| T04 | mandate 留档 | 任一 ticket 能读回策略版本与依据码 | R04 |
| T05 | stage 表 7 行 | 逐行构造，判定与表一致 | R05 |
| T06 | 会话与目录隔离 | 两 ticket 的 session id / dir 互不相同 | R06 |
| T07 | 扇出 | 两订阅 ticket 各收 1 条，eval 不新增 | R07 |
| T08 | 崩溃重放 | 写 effect → kill -9 → 重启执行且只一次 | R08 |
| T09 | 重试边界 | 断网 3 次仍失败才判 failed | R09 |
| T10 | 人的优先 | 满槽时人的消息 5 秒内投达 | R10 |
| T11 | 消息保序 | 同会话 3 条按序到达 | R11 |
| T12 | 暂停 | 暂停后 event 增、ticket 不增 | R12 |
| T13 | 预算 | 把某角色工具加满，预算测试必须红 | R19 |
| T14 | 核心纯净 | `! grep -rq "@deepseek-ai" src/core/` | R17 |
| T15 | kaa 契约 | 拒收时退出码非 0 且 JSON 可解析；超时进退避 | R23 |

---

## 9 缺口最终处置

### 9.1 上一版的方案缺口（S1–S9）

| # | 处置 |
|---|---|
| S1 双写者 | **已定**：目标树唯一写者 = kaa CLI；系统禁止直接 POST `/node-action`（`goal-tree/lib/http.js` 只留给人）。见 ARCHITECTURE §3 |
| S2 回写不幂等 | **已定**：`treeWrite` 的 key = `${nodeId}:${revision}` |
| S3 权限无边界 | **已定**：worker 会话设 `danger-full-access` 但配 blocklist，默认禁 `push`（原型同款，`docs/003-execution.md:70`） |
| S4 槽位预留时机 | **已定**：launch 一开始就占槽（含准备阶段），人的消息可占额外一槽（`docs/003-execution.md:57`） |
| S5 完成判定 | **未定**：见第 10 节 Q3 |
| S6 并发竞态 | **已定**：ticket revision 乐观锁 |
| S7 进程托管 | **不做**（R16 最后一公里，明确不在本轮） |
| S8 面板 | 复用 `plugin-console` 加 person/* 视图，不新建 |
| S9 成本估算 | **已给并被实测修正**：src 实测 2018 行（原估 1,300，+51%），测试 500 行 |

### 9.2 技术缺口（T1–T8）与新增

| # | 现状 |
|---|---|
| T1 无持久副作用原语 | 自建 `effects.ts`（130 行预算） |
| T2 turn 结束 ≠ 活干完 | 自建：订阅 `agent/status` + 查 `ctx.jobs` / `ctx.subagents` 合成"真空闲" |
| T3 无跨会话工作单元 | 自建 `ticket` 表 + stage |
| T4 无 cursor 原语 | `thread.cursor` 列 |
| T5 无迁移框架 | 首版只做 v1 + 版本拒绝启动，迁移留到 v2 |
| T6 无授权留档 | `ticket.mandate` 快照 |
| T7 无进程托管 | 不做 |
| T8 无静态预算 | `tests/budget.test.ts` |
| **T9（新）** | kaa 对重复 `kaa done` 是否幂等——**未实测**，见 §5.3 |
| **T10（新）** | desktop profile 被 Electron 独占，`dump-config` 不可用——所有生效配置判据必须跑在非 Electron profile |

---

## 10 待确认

| # | 问题 | 影响 |
|---|---|---|
| Q1 | Trigger 只来自你，还是也接 cron / goal-tree / GitHub？ | R01 的准入强度、R03 是否走 inferred |
| Q2 | worker 能否 commit/push？ | §9.1 S3 的 blocklist 内容 |
| Q3 | 完成判定谁下——你，还是另一个 agent？ | S5、R05 结束条件 |
| Q4 | 结果发群/飞书，还是写回目标树就够？ | R11 是否需要 `ds-bot`（D5 现在默认只做本地通道） |
