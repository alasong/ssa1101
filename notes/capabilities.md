# n3 能力盘点：手上到底有什么（映射到 S 类）

**口径**：只记"能直接满足或部分满足哪条 S"，不评价优劣。判「够不够」在 n4。
**四类库存**：kaa skill、dsh 宿主、已装未启用的三个包、pi-durable 宿主 spike。

---

## 1 kaa skill（`/Users/song/1github/fat3/skills/kaa`）

规模：`kaa.py` 约 181 KB、`spec/kaa.toml` 2,038 行、`engine/` 6 个模块（bus / forms / gates / jobs / runtime / state）；派生计数：节点型 18、门 14、拒收码 25、策略 9、档位 2、FSM op 7、状态 6、配置段 96（`skills/kaa/SKILL.md:239-248`）。

| kaa 能力 | 机制要点 | 满足哪条 S |
|---|---|---|
| 需求台账 `kaa requirement add/refine/list/retract/audit/verify/loop` | 每条需求必须带 `accept`（可判判据）、`who`（消费者）、`source`（出处）、`--verify-cmd`（可执行入口）、`impact`（low/high）、`parent`；`audit` 报"无基线/未覆盖/悬空引用"，`verify` **实跑每条判据** | **S05 的"依据可查"、S33 的"只暴露需要人的"、以及覆盖门本身** |
| 树覆盖门 `_tree_coverage_block` | 分解过的树必须已登记需求 + 全部满足 + 每条有可跑判据 | 超出 S（原型无"需求覆盖"概念） |
| 终止条件门 `_tree_closure_block` | 树里必须有 done 的 `evaluate` 且（`reflect`｜`standardize`） | 超出 S |
| 14 道 done 门 / 25 个拒收码，三分类 fact / form / semantic | `fact` 要跑（退出码、git 改动集）、`form` 只看声明、`semantic` 归 jev 判；判者非脚本 ⇔ 可上诉 | **S06 的 Gate 更细**（原型 Gate 只有二值），且超出 |
| 证据契约 | 锚点 `line_refs` / `keywords` 必须落在改动文件上；`changed_files` 引擎自算不可申报 | **S39 的证据侧**，超出 |
| 事件唯一真相 | `~/.fat/kaa/events.jsonl` append-only → `state.json` 投影，可 rebuild / checkpoint | **S36 单写者**、**S29 存储先行** |
| `kaa job submit/wait/collect/cancel/list` | 提交即返回、有界等待、回收不跳验证、租约串行 | **S21**、**S24** |
| `kaa supervise` | 一次性观察：停顿发 ask、超预算 cancel（不做常驻） | **S18**（超时处理） |
| `kaa bus post/show/answer/asks` | 多层信封，缺 `layer` 即拒收；`ask` 不节流不合并不降级 | 超出 S（原型的 Session 间只有 relay） |
| `kaa handoff brief/collect` | 派发协议：只写 brief、校验结果契约，**不做执行器**，spawn 归宿主 | **S08**（Assignment 端口）、**S19** |
| `kaa drive`（只推不跑） | 列出可推进步骤 + 同波就绪 + 机器可读 L3 协议 | **S03**（串行/并行判定） |
| `kaa registry` | 产出物登记 + 消费者声明；无消费者即拒；`depends_on` 只能指向已登记项 | 超出 S |
| `kaa gap report/fill/verify` | 能力缺口台账，`uses=0` 判回归 | 超出 S |
| `kaa methodology` | 49 篇方法论，按 phase×mode 推荐，每型 ≤3 篇 | 超出 S |
| `kaa policy / metrics / evolve` | 三层策略（值→策略→判定）、四项指标口径冻结 | **S09**（版本化策略）、**S41**（配置热改） |
| `kaa doctor` | 判据 C1–C5、规模门、死键、派生一致性、事件闭集 | 超出 S |

## 2 dsh 宿主

| 能力 | 事实 | 满足哪条 S |
|---|---|---|
| `sessionController.create({sessionId, workspaceId, agentPreset})` | 一单元一会话，建时绑 preset | **S19**、**S20** |
| `workspaceRegistry.create(cwd)` | 一单元一目录 | **S19** |
| `permissionPresets.set(session, 'danger-full-access')` | 权限按会话设 | **S34** 的一半 |
| `auto-review`（另装） | 每次工具调用一次 LLM 授权 | **S06**（Gate 的现成实现）、**S13** |
| `ctx.agents` / `ctx.jobs` / `ctx.subagents` | 可查会话、作业、子代理状态 | **S21**（合成"真空闲"的原料） |
| 8 个宿主事件 | `session/event`、`agent/status`、`agent/request`、`agent/inbox/claimed`、`agent/error`、`agent/disposed`、`agent/created`、`system-prompt/assemble` | **S28**（turn 结束/错误）、**S32**（提示词装配） |
| preset 机制 | 一份插件清单 = 一个角色能力面 | **S20**、**S40** |
| `tools` / `systemPrompt` / `skills` | 模型面可编程 | **S40** |
| `spill-policy` / compaction | 大输出截断与压缩 | 部分 **S39**（运行时，不是静态预算） |

## 3 已装未启用（`dependencies` 有、`bundles` 无）

| 包 | 自述 | 满足哪条 S |
|---|---|---|
| `ds-bot` | 「long-lived Bots … Main Bots, Bot-to-Bot messages and group chats」 | **S04**（扇出/多代理）、**S30**（Channel 写出） |
| `@deepseek-ai/dsh-experimental-auto-review` | 「Per-tool LLM authorization review」 | **S06**、**S13** |
| `dsh-context` | 未查证 | 待定 |

## 4 pi-durable 宿主 spike（`experiments/pi-durable-kaa-host`）

README 自述「**结论：可行**」，五条命题全部带证据：

1. 宿主读 kaa 节点 brief 作 worker 指令；
2. worker 在耐久运行时上跑，产物落盘；
3. **崩后续跑**：`submit` 后 `process.exit(0)`，`resume` 重开同一 JSONL storage 续跑至 `done`；
4. **门留在 kaa**：宿主只调 `kaa done`，判定归 kaa；
5. **幂等**：同一 `requestId` 重新 submit 找到同一 submission（`same submission=8`）。

满足：**S28**（重启恢复）、**S37**（幂等的持久执行）、**S29**（存储先行）。

## 5 明确没有的（留给 n4/n5 判）

| 缺 | 影响哪条 S |
|---|---|
| 没有 Source 实现（GitHub / Feishu） | S01、S02、S11 |
| 没有 Thread / Eval 的持久结构 | S03、S06、S16 |
| 没有 Ticket 状态机与 Assignment 生命周期 | S07、S08、S19、S26 |
| 没有持久 effect 表（kaa 的事件不是副作用队列） | S29、S37 |
| 没有 Outbox 保序与退避 | S30 |
| 没有面板（`plugin-console` 只是插件列表） | S33 |
| 没有静态模型面预算 | S39 |
| 没有常驻进程托管 | S34 |

**一句话**：kaa 覆盖了「判定与台账」那一半（还超出），dsh 覆盖了「会话与工具」那一半，**中间那半——事件接入、工单状态、副作用队列——两边都没有**。
