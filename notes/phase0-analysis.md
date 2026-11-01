# dsh-superagent 原型分析 → 与本地 26 个 bundle 的架构对齐

**口径**：原型取自 `deepseek-ai/dsh-superagent-prototype@main`（GitHub `pushed_at` 2026-10-31T12:05:51Z，仓库 775 KB）；本机 dsh `0.2.1-rc.5`，profile `desktop`，26 个 bundle。所有引用格式为 `文件:行`，可在克隆体里复核。

---

## 0 结论先行

三句话。

**一、原型的价值不在代码量，在三条硬边界。** `src/core` 不 import 外部模块且不做 I/O；每种状态只有一个写者；任何外部动作先进 `effect` 表、事务提交后才执行。15,205 行 TS 里，真正学得来的就这三条 + 一张 12 行的"拒绝概念"表。

**二、你的 26 个 bundle 已经覆盖了它五层，缺口只有三件。** 面板、记忆、上下文卫生、预设、观测你都有对应物；缺的是三件：**跨会话的工作单元（Ticket，含幂等 Intake）**、**持久副作用队列（Effects）**、**单写者与授权语义（Mandate）**。`goal-tree` 是 Ticket 的雏形，且已经有 HTTP 入口（`goal-tree/lib/index.js:440` 注册 `registerHttp`），但它同步执行、没有授权语义，也没有把外部动作写成可重放的队列。

**三、所以架构不是"把它搬进来"，是把它当内核规范用。** 内核可移植（不依赖 dsh）、执行体可换（你已有三种）、插件按端口归位。如果你不打算要 7×24 常驻代理，第 5 节 "别抄的四样" 比抄什么更重要。

---

## 1 它到底是个什么东西

它不是一个独立应用，是**一个 dsh bundle**：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，后者插入 3 个插件条目和 2 个 agent preset（`cordis.patch.yml:4-12`、`:20-193`）。装进 profile 后，它在 dsh 进程内跑一个常驻编排器。

领域流（mermaid 见 `docs/001-domain.md:9-19`；下面的 Report / 回复 两段来自同一文档 21-37 行的概念表，图中没有）：

```
Source → Trigger → Thread → Eval(Gate + Assessment) → Ticket(+Mandate)
                                                   → Assignment → Executor Session
                                                   → Report → Channel → 回复
```

关键实现事实：

| 面 | 事实 | 证据 |
|---|---|---|
| 数据 | 单 SQLite `<stateDir>/orchestrator.sqlite`，9 张表；`effect` 表即副作用队列 | `docs/007-architecture.md:452-464` |
| 事务 | Engine 所有方法同步；命令改一个聚合一次事务；`evaluateDue` 每个 Eval/Ticket 各一个事务 | `docs/007-architecture.md:48` |
| 队列 | 6 种 effect：`assessment` / `launch` / `delivery` / `relay` / `notice` / `reply`，各自并发上限与退避 | `docs/007-architecture.md:172-179` |
| 角色接口 | Engine 只按角色暴露 `Pick`：Sources / MainSession / People / Settings / Executor | `docs/007-architecture.md:64` |
| 执行体 | 一个 Ticket = 一个 Session（`worker-<id>`）+ 一个目录 | `docs/003-execution.md:25` |
| 模型面 | 主 Session 14 个 `orchestrator_*` 工具，执行器 6 个 | `docs/007-architecture.md:492-530` |
| 规模 | src 15,205 行；tests 14,960 行；docs 1,973 行；19 个 prompt 文件 | `wc -l`（见附录） |

**值得注意的设计纪律**：`tests/model-surface.spec.ts` 给每个角色的可读面设了体积预算（`docs/007-architecture.md:437`）。它不是测试细节，是"工具和提示词会持续膨胀"这件事的制度化回答——你的 profile 现在没有这层护栏。

---

## 2 值得照抄的四样（与代码量无关）

**① 核心不碰外部。** `src/core` 除 Node 哈希外不 import 任何东西，不做 I/O（`docs/007-architecture.md:258`）。你的插件几乎全是反例：策略、副作用、I/O 混在一个 step hook 里，所以任何一处改动都会牵动别处。

**② 一个状态一个写者。** 一张表列死了每个状态的唯一写者（`docs/007-architecture.md:261-269`）。你的栈里没有这张表：同一类状态被不同插件各写一份，改一处就要同时改几处。

**③ 外部动作 = 一行 effect + 提交后执行。** `enqueue` 在事务内，执行在提交后；同一个 `(kind, key)` 只有一行，重复入队替换负载（`docs/007-architecture.md:166-170`）。这是"进程被杀也不丢工作"的唯一来源，你的栈里没有任何等价物。

**④ 一份被拒绝的概念表。** `docs/001-domain.md:45-60` 列了 12 条"我们考虑过但不要"的概念。抄它的"不做什么"，比抄"做什么"省得多。

---

## 3 你的 26 个 bundle 归位

按"它挂在哪个端口上"分层，而非按功能名。26 个 bundle 来自 `~/.dsh/profiles/desktop/package.json:30-57`。

| 层 | 你的插件 | 原型的对应物 | 处置 |
|---|---|---|---|
| L1 宿主 | `dsh-base`、`dsh-web-app` | 同 | 不动 |
| **L2 能力面（预置）** | `turbo-preset` | `cordis.patch.yml:20-193` 的 worker / router preset | **最关键的一层**。能力不是代码，是 preset 里的插件清单。见 4.1 |
| L3 工具面 | `websearch`、`modlens`、`at-file`、`mobile`（`dsh-context` 只在 dependencies、不在 bundles，未作为插件加载） | 14 + 6 个 `orchestrator_*` 工具 | 这批工具只进 worker 面；router 面不装 |
| L4 步骤循环策略 | `todo-guard`、`tdd-guard`、`terminology`、`prompt-hygiene`、`compaction-filelist`、`kind-probe` | `prompts/*.md` + `noWait` 守卫 + model-surface 预算 | hook 类只进 worker preset；router 不装 |
| L5 记忆 | `hindsight-coding-agents`（在用）、`hindsight-bridge`（已停用） | `kv` + `notices` + 会话 prompt 版本历史 | 两个角色都要，但全栈只能有一份（双注入的坑已踩过） |
| L6 观测 / 面板 | `plugin-console`、`step-progress`、`session-stats-fix`、`better-sidebar` | `src/client` 27 个文件 + `HealthBoard` | **不要再造面板**，只移植 HealthBoard 的数据模型 |
| L7 编排 | `agent-team`、`ralph`、`cot-translation`（`auto-review` 不在 bundles：它是 host 级权限模式，每次工具调用一次 LLM 授权，不是编排插件） | `Executor` 端口（`src/core/ports.ts:59-69`） | 前两者可作为该端口的实现；`auto-review` 归 L1 权限面 |
| L8 环境门 | `local-first` | `Setup`（`src/app/setup.ts`，探 `gh` / `lark` CLI） | 保留；原型缺"探不到就降级"的通用化 |
| — | `session-stats-fix`、`kind-probe` | 无（原型的 health 只覆盖自己的部分） | 归入 L6 观测 |

一句话读法：**L3 和 L4 是你的成本项，L6 和 L7 是你的资产。** 前者每一步都付 token，后者省步数。原型在 L2/L3 上的取舍（router 连 todo、subagent、goal 都不给）就是它控成本的答案。

---

## 4 建议架构

```
┌──────────────────────────────────────────────────────────┐
│ L0 宿主：dsh 进程（base / web-app / 客户端槽位）            │
├──────────────────────────────────────────────────────────┤
│ L1 部署面：preset 图                                       │
│    human(现在这层) │ router(路由,极简) │ worker(全工具)    │
├──────────────────────────────────────────────────────────┤
│ L2 端口层（接口，不含实现）                                 │
│    Source │ Assessor │ Executor │ Outbox │ Repositories    │
├──────────────────────────────────────────────────────────┤
│ L3 适配器层（每个插件只实现一个端口）                        │
│    github-watch / goal-tree-source / agent-team / ralph …   │
├──────────────────────────────────────────────────────────┤
│ L4 内核（纯函数域，不 import 宿主、不做 I/O）                │
│    Trigger · Thread · Eval · Ticket · Mandate · Assignment  │
│    + Effects 队列 + 单写者表                               │
└──────────────────────────────────────────────────────────┘
```

### 4.1 能力下沉到 preset，不写进代码

原型的 `cordis.patch.yml` 把 worker 与 router 的能力差异**完全表达在 preset 的插件清单里**（`:20-193`）：worker 有 `tool-fs`、`tool-subagent`、`tool-todo`、`tool-web`（关闭 fetch）；router 只有 `tool-fs`（`write:false, edit:false`）、shell、jobs、skill。你现在只有一个 `turbo` preset（`turbo-preset/cordis.patch.yml:21-22` 的 `insert` 与 `preset-turbo`），所有角色共用。

**改法**：以 `turbo` 为模板派生三份清单，差异只写"少什么"：
- `human`（你手敲的会话）：现状即为准。
- `router`（常驻编排）：去掉 todo / subagent / goal / 面板类 hook，保留 shell（超 5 秒转后台）与 jobs（等待上限 5 秒）。
- `worker`（执行体）：全工具，但**不装** L4 的 reviewer 类 hook（`tdd-guard`、`prompt-hygiene`）——它们是给"人看着跑"的会话用的，套在无人值守的 worker 上只会把每一轮变成一次自检。

这条改动的判据是可机检的：`dsh --profile <副本> --dump-config | grep -c 'id: tool-todo'` 在 router 面必须为 0。

### 4.2 三个接缝，不要第四个

**接缝一：preset（最便宜）。** 上面 4.1。无需改任何插件代码。

**接缝二：Executor 端口。** 原型把这个端口定义得极小——只有 `start / deliver / stop` 三个方法，且"每个方法只排队，结果通过 Engine 回调回来"（`src/core/ports.ts:59-69`）。这意味着换执行体是**实现三个方法**，而不是改架构。你已有的 `agent-team`（多成员并发）、`ralph`（新鲜上下文迭代循环）、`subagent`（一次性子代理）正好是这个端口的三种策略：

| 执行体 | 适合的 Ticket 形态 | 落点 |
|---|---|---|
| 单 Session（原型默认） | 一个工单一个会话一个目录 | `sessionController.create`（见 `src/app/sessions.ts:144`） |
| agent-team | 需要多人并行、职责分离的工单 | 团队 task 板 |
| ralph | 目标不变、需要反复试错的工单 | 轮次循环 + 工作区当持久记忆 |

**接缝三：Source。** `SourceKind` 是一个声明式契约（`src/sources/kind.ts:85`；`channel` 在 :100、`threadContext` 在 :102）：配置 schema、表单字段、Policy 参与、Channel 适配、Thread 上下文读取。加一个来源 = 实现这个接口，不碰内核。

对接你现有栈的话，唯一有真实价值的新 Source 是 **`goal-tree` 就绪节点**：把 `goal_tree_view` 里 ready 的叶子节点当成 Trigger 投进 Intake，完成状态当 Report 回写。这样你 AGENTS.md §10 要求的"下任务走目标树"就从"人记忆里的规矩"变成"系统里的入口"。注意：这条 Source 必须做成**轮询型**（原型自己的结论是"需要等待的条件就是普通 Source"，`docs/001-domain.md:50`），而不是让 Eval 自己调度延迟。

### 4.3 面板：只移植规则，不移植组件

原型有 27 个 client 文件（`src/client/*`，4,419 行），而你的 `plugin-console` + `better-sidebar` + `step-progress` 已经占了同样的槽位。真正值得移植的是 **HealthBoard 的规则**：每个健康条目有一个声明了归属的写者、重复认领被拒绝（`docs/007-architecture.md:269`）；不过「三次失败才报错」属于 effect 的 health，不属 HealthBoard 本身——阈值在 `src/app/effects.ts:7`，规则见 `docs/007-architecture.md:181`。这是一个约 40 行的数据结构，可以挂在 `plugin-console` 里当新的数据源。

---

## 5 现在就要定的取舍

| # | 取舍 | 证据 | 建议 |
|---|---|---|---|
| 1 | 版本漂移 | 原型 `engines.dsh: ^0.2.1-alpha.2`，peer 钉 `@deepseek-ai/cordis 4.0.5-alpha.1`；本机 `0.2.1-rc.5` | 落在范围内但很险。用**独立 profile + 独立 stateDir**，不要让原型和主 profile 共用 `cordis.patch.yml` |
| 2 | 工具前缀税 | 你 `~/.dsh/AGENTS.md` §1 的实测口径：64 个工具定义 ≈ 每步 21K token 固定前缀；原型 router preset（`cordis.patch.yml:125` 起）除 `agent-instructions` / `time-context` / `compaction` 三个基础组外，只有 shell / fs / jobs / skill | 工具进 worker 面，router 面砍到个位数。这是唯一能二次收益的削减 |
| 3 | 单进程锁 | Runtime 先锁 stateDir 再开库（`docs/007-architecture.md:151`） | 一个 stateDir 只能一个实例；桌面端和常驻服务不能共用 |
| 4 | 数据无界增长 | 原型自认"不删除旧记录"：trigger / disposition / decision / outbox / kv 全部只增（`docs/007-architecture.md:484`） | 要接的话先写保留策略，否则半年后库会拖慢每一个 pass |
| 5 | 双面板 | 原型 panel 与 `plugin-console` 功能重叠 | 二选一，不要两套并存 |

**别抄的四样**（如果你不打算做 7×24 常驻）：

1. **Mandate / 授权模型**——它解决的是「陌生人能不能指挥这个代理」。只要 Trigger 全是你自己敲的字，每条都是 explicit，Mandate 就退化成一行日志。但这条前提在 4.2 落地（goal-tree 节点、定时触发）当刻失效，那时 Mandate 必须回来：它取决于触发源是不是只有你一个人，不取决于你想不想要它。
2. **Eval 的 Gate + Assessment 两层**——没有外部请求者，就没有准入判断。
3. **30 分钟后台窗口 / worker slot 并发**——这些是"人不在场"才需要的约束。
4. **Subscription 扇出 / follow-up 归属**——没有多人对话线程，没有归属问题。

反过来说：**Effects 队列、单写者表、幂等 Intake 这三样，无论常驻与否都该有**，因为 `todo-guard` 这类 hook 确实「进程活着才成立」；`goal-tree` 的树虽然落在宿主 `storageDomain`、写时有 revision CAS（`goal-tree/lib/atomic-write.js:15-16`），但它的推进仍靠同步调用，没有可重放的外部动作队列。

---

## 6 落地顺序

**P0（半天，零风险）冻结现状。** 不碰主 profile。建 `~/.dsh/profiles/superagent` 独立 profile，`stateDir` 指到 `~/.dsh/superagent-state`。验收：`dsh --profile superagent --dump-config | grep -cE '^\s+id: dsh-superagent$'` 为 1（不能用 `grep -c 'dsh-superagent'`：原型自带的 `github-watch`、`feishu-watch` 与两个 preset id 都含这个串），主 profile 的 `--dump-config` 输出与改动前逐字相同。

**P1（1–2 天）影子跑通一个来源。** 只启用 GitHub Source，Policy 设成"只记录不执行"（原型有此模式，`docs/000-philosophy.md:11`）。验收：一次真实 Issue 进来后，面板上出现一条 `would accept` 记录，且没有产生任何 Session。

**P2（3–5 天）替换执行体。** 实现 `Executor` 端口的三个方法，接 `agent-team`。验收：一个 Ticket 的 `launch` effect 走完 排队 → 启动 → 报告 → Assignment 结束，四个状态都能在库里读到行，且进程重启后未完成的 `launch` 会被重新拾起。

**P3（1 周）收口。** 把 `goal-tree` 就绪节点做成第二个 Source；把 HealthBoard 规则接进 `plugin-console`；给路由面写一份体积预算检查（对齐 `tests/model-surface.spec.ts` 的做法）。

---

## 附录：证据

```
$ curl -s https://api.github.com/repos/deepseek-ai/dsh-superagent-prototype
  "size": 775, "language": "TypeScript", "pushed_at": "2026-10-31T12:05:51Z"

$ cd /tmp/sap-src && wc -l $(find src -name '*.ts*')
  src:   15205 total
  tests: 14960 total
  docs:   1973 lines
  prompts + prompts/team: 19 files

$ dsh --version
  0.2.1-rc.5

$ python3 -c "import json;d=json.load(open('/Users/song/.dsh/profiles/desktop/package.json'));print(len(d['dsh']['profile']['bundles']))"
  26
```

引用锚点：

- `docs/001-domain.md:9-19` — 领域流 mermaid
- `docs/001-domain.md:45-60` — 被拒绝的概念表（12 条）
- `docs/003-execution.md:25` — 一 Ticket 一会话一目录
- `docs/007-architecture.md:48` — Engine 同步 + 事务边界
- `docs/007-architecture.md:151` — stateDir 锁
- `docs/007-architecture.md:166-179` — Effects 队列与 6 种 kind
- `docs/007-architecture.md:258` — src/core 无外部依赖、无 I/O
- `docs/007-architecture.md:261-269` — 单写者表
- `docs/007-architecture.md:269` — HealthBoard 认领规则
- `docs/007-architecture.md:437` — model-surface 体积预算测试
- `docs/007-architecture.md:484` — 数据只增不删
- `docs/007-architecture.md:492-530` — 工具面清单
- `src/core/ports.ts:59-69` — Executor 端口（start/deliver/stop）
- `src/sources/kind.ts:1-80` — SourceKind 契约
- `src/app/sessions.ts:144` — `sessionController.create` 建执行器会话
- `cordis.patch.yml:4-12` — 3 个插件条目
- `cordis.patch.yml:20-193` — worker / router 两个 preset

---

## 附录 B：评审记录（2026-11-01）

**需求侧**：本版交付前未与提出方确认过任何一条，四条单方假设是——① 交付形态为 Markdown 而非可跑原型；② 范围不含落地代码；③ 「添加的插件」= `~/.dsh/profiles/desktop/package.json` 里 26 个 bundle；④ 用途是决策参考而非施工图。**第 ③ 条若所指不同，第 3 节的整张归位表需重做。**

**评审侧**：本版经一轮 Devil 反证（空白上下文子 agent，只审「事实错 / 过度推断 / 前提可疑 / 自相矛盾」四类）+ 一次 Ledger 机检（正则抽 `path:line`，校验文件存在且行数够）。评审前版本共 15 处站不住的断言，逐条处置如下。

| # | 原断言 | 判定 | 依据 |
|---|---|---|---|
| A1 | 单库 8 张表 | 接受 | 表清单实为 9 张：`docs/007-architecture.md:454-464` |
| A2 | bundle 清单在 `package.json:52-78` | 接受（已改） | 该文件 60 行，数组实际 30-57 |
| A3 | goal-tree 无外部事件入口 | 接受 | `goal-tree/lib/index.js:440` 注册 `registerHttp` |
| A4 | `SourceKind` 标成 `kind.ts` 第 1-80 行 | 接受 | 接口实际在 `src/sources/kind.ts:85`，`channel` 在 :100 |
| A5 | 三次失败规则属 `HealthBoard`（007:269） | 接受 | 阈值在 `src/app/effects.ts:7`；`health.ts` 无计数 |
| A6 | router 面「只有 shell/fs/jobs/skill」 | 接受 | preset 自 `:125` 起，另含 instructions/time-context/compaction |
| A7 | 领域流 = 001:9-19 的 mermaid | 部分接受 | 图里无 Report/回复，已改标注为「图 + 概念表」 |
| A8 | turbo preset 在 `:1-20` | 接受 | 1-21 全是注释，`insert` 在 :21 |
| B1 | agent-team/ralph/auto-review 是同一端口的三个实现 | 接受 | auto-review 是 host 级权限模式，非 Executor 实现 |
| B2 | goal-tree 也「进程活着才成立」 | 部分接受 | 树在宿主 storageDomain 且有 revision CAS；但推进仍同步、无重放队列 |
| C1 | `dsh-context` 在工具面 | 接受 | 只在 dependencies，不在 bundles |
| C2 | `auto-review` 是你的编排插件 | 接受 | 同上，不在 bundles |
| C3 | P0 验收 `grep -c 'dsh-superagent'` 为 1 | 接受 | 原型自带 3 插件 id + 2 preset id 均含该串 |
| C4 | 「Trigger 全是你敲的字，故可砍 Mandate」 | 接受 | 与 4.2 自相矛盾；已改为条件式判断 |
| D1-D3 | 三处自相矛盾 | 接受 | 已统一措辞与清单 |

**未验证**：GitHub API 元数据（775 KB / `pushed_at`）未在评审中复核（评审方未联网）；`docs/002`、`004`、`005`、`006` 未读，本文未引用其结论。

**机检**：改后 31 条 `path:line` 锚点全部命中（脚本见对话记录）。

---

## 附录 C：评审之后的架构调整（2026-11-01，第二轮）

评审推翻的三条事实，直接改了架构的三处判断。**结论：不推翻第 4 节的分层，改三处接线。**

**调整 ①：`goal-tree` 从「要新建的 Source」降为「薄轮询适配层」。**
它已有 HTTP 入口：`GET /dsh-goal-tree/tree`（`goal-tree/lib/http.js:186`）、`POST /dsh-goal-tree/node-action`（`:278`）、`POST /dsh-goal-tree/import`（`:409`）。也就是说外部建树、改节点、读就绪列表都已经存在，缺的只是"把就绪节点翻译成 Trigger、把完成状态翻译成 Report"这一层翻译。这比第 4.2 节原来假设的工作量少一个数量级。

**调整 ②：多出一层「已装未启用」，它改变了"要造几件"的账。**
`package.json` 的 `dependencies` 里有、`bundles` 里没有的三个包：`ds-bot`、`@deepseek-ai/dsh-experimental-auto-review`、`dsh-context`。其中两个正对着原型的端口：

| 包 | 它是什么 | 对应原型的 |
|---|---|---|
| `ds-bot` | 长驻 Bot 团队：主 Bot、Bot 间消息、群聊 | **Channel + 多代理**（`src/sources/*` 的写侧 + `Executor`） |
| `auto-review` | 每次工具调用一次 LLM 授权的权限模式 | **Gate**（`Policy.gate` 的语义） |
| `dsh-context` | 未查，仅确认未加载 | 待定 |

结论：第 0 节说的「缺三件」，实际是**缺一件半**。Channel 与 Gate 不是要造的，是躺在 `node_modules` 里没接进 profile 的。

**调整 ③：「别抄 Mandate」再修一次。**
原文说不抄 Mandate，理由是"Trigger 都是你自己敲的字"。评审指出这条前提会自我推翻。修正后的说法：**Gate 的判断你已经有（`auto-review`）；Mandate 缺的是「记录 + 复核」——把某次授权当时的策略版本、范围、依据存下来，事后能答"它凭什么能做这件事"。** 这一半，`auto-review` 不提供。

**新的风险（本轮实测）**：`goal-tree` 的 HTTP 路由没有任何同源或鉴权检查（`grep -nE "sameOrigin|origin|loopback|auth|token" goal-tree/lib/http.js` 无命中）。一旦把它当外部 Trigger 入口，任何人 POST `/node-action` 就能往目标树里塞任务——这正是原型的 Mandate 要防的那件事。

**能力分界线（三档）**：

| 档 | 形态 | 缺什么 | 今天能不能 |
|---|---|---|---|
| 1 | 有人在场、内部驱动：你下任务 → 目标树推进 → 多执行体跑 | 无（只需把 preset 拆角色） | 能 |
| 2 | 无人值守、内部驱动：定时/事件唤起就干活 | **Effects 队列**（崩了不丢工） | 接上 `ds-bot` 是骨架，还缺这一件 |
| 3 | 无人值守、外部驱动、对外发言 | 常驻进程 + 对外账号身份 + Mandate 记录 | 不能，三样都没有 |

所以：**能支持 superagent 的"工作方式"，不能支持它的"无人值守形态"。** 唯一必须自己写或从原型拿的，是 `src/core` 那套东西——Ticket 状态机 + Effects 队列 + 单写者。
