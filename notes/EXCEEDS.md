# n5 超额技术点清单：哪些地方能超过 superagent

**口径**：只在 `REQUIREMENTS.md` 的 R01–R23 之外找增量——即"superagent 没有、我们手上有、而且能给出判据"的东西。每条必须能被一条命令判红/判绿，否则不算超额，只算说法。

**前提**：超额项不改变任何 R 的定义。它们是把同一件事做得更可核，不是做更大的事。

---

## X01 需求台账与覆盖门

- **superagent 有**：Mandate 记录"这次凭什么做"，Ticket 记录"做到哪"；**没有**"需求条目 → 可跑判据 → 逐条实跑"的闭环。
- **我们怎么做**：kaa `requirement add/audit/verify` + 树覆盖门 `_tree_coverage_block`。每条需求必须有 `accept` 与 `verify_cmd`，`audit` 报未覆盖，`verify` 实跑判据。
- **判据**：`python3 skills/kaa/kaa.py requirement audit` 对本台账输出无红项（实测：该仓库自带的 `REQ`/`R-TEST`/`R-C1` 等历史需求当前仍红，属既有状态，不由本台账引入）；删掉任一条的 `accept` 后该命令必须报红。
- **风险**：判据写成散文就退化成装饰——`[requirements].max_accept_len = 300` 已经在防这个。

## X02 闸门三分类与判者归属

- **superagent 有**：Gate 是确定性的二值判定（准/不准）。
- **我们怎么做**：kaa 把 25 个拒收码按**误判代价**分三档——`fact` 要真跑（退出码/git 改动集）、`form` 只看声明、`semantic` 才交给 LLM 判官（jev）；判者非脚本 ⇔ 可上诉。
- **判据**：`python3 tools/check-gate-classes.py` 三档并集恰好等于 `[contracts]`；把一个 fact 码挪到 semantic 档必须报红。
- **为什么这是超额**：superagent 的 Gate 只能回答"允不允许"，回答不了"谁有资格改判"。

## X03 事件唯一真相 + 投影可重建

- **superagent 有**：SQLite 表即状态，无事件日志。
- **我们怎么做**：kaa `~/.fat/kaa/events.jsonl` append-only，`state.json` 是可重建的投影；`state rebuild --check` 校验。
- **判据**：删掉 `state.json` 后 `kaa state rebuild <slug> --check` 能重建出一致状态。
- **为什么这是超额**：状态出错时能回答"是哪一步写坏的"，而不是只能看到坏结果。

## X04 证据契约

- **superagent 有**：Executor 报告 + 报告正文。
- **我们怎么做**：kaa 要求 `line_refs` 锚点必须落在本次 git 改动集上，`changed_files` 由引擎自算、**传了会被忽略**（防"不传就绕过"）。
- **判据**：`kaa done` 时只给 `keywords` 不给 `line_refs` 必须判红（`evidence_anchor_missing`）。
- **为什么这是超额**：报告可以编，锚点编不了。

## X05 产出物注册表（无消费者即拒）

- **superagent 有**：无。新代码只要被 commit 就算完成。
- **我们怎么做**：kaa `registry add` 要求声明"谁消费它"；`audit` 报"新增顶层符号在产品代码里零引用"。
- **判据**：`kaa registry audit` 在新增一个无人调用的函数后必须报红。
- **为什么这是超额**：这条挡的是"造了没人用"，不是"写错了"。

## X06 崩溃续跑的外部运行时

- **superagent 有**：重启后重排队、给恢复笔记（自建 `effect` 表实现）。
- **我们怎么做**：`experiments/pi-durable-kaa-host` spike 已在**外部耐久运行时**上跑通：`submit` 后 `process.exit(0)` → `resume` 续跑到 `done`，同一 `requestId` 找到同一 submission（README 记录 `same submission=8`），门仍留在 kaa。
- **判据**：`node host.mjs admit …` 后 `node host.mjs resume …`，`kaa status` 该节点为 done；重复 resume 不产生第二个 submission。
- **为什么这是超额**：superagent 的恢复依赖自己实现的队列，崩溃点在其内部；这条把崩溃点交给外部运行时，宿主编排代码可以无状态。

## X07 多层总线与"提问不节流"

- **superagent 有**：`relay`（把报告/追问转进主会话），单一通道。
- **我们怎么做**：kaa `bus post/show/answer/asks`，信封必带 `layer`，`ask` 不节流不合并不降级，兄弟层不可见。
- **判据**：缺 `layer` 的投递被拒；`bus asks` 能列出未答与孤儿。
- **为什么这是超额**：superagent 的多会话之间只有"转达"，没有"分层可见性"。

## X08 方法论按型推荐（每型 ≤3 篇）

- **superagent 有**：把规则全写进 `prompts/*.md`，随节点型无关。
- **我们怎么做**：kaa 49 篇方法论按 phase×mode 推荐，每型 ≤3 篇承重篇，每篇必须有判据行。
- **判据**：`kaa methodology list --phase D --mode implement` 返回 3 条（实测 `tdd, subagent-dev, chesterton-fence`），`--phase P --mode research` 也是 3 条；`--phase P --mode implement` 实测 0 条（该组合没有承重篇，不是超限）。某篇缺判据时 `derive --check` 报红。
- **为什么这是超额**：prompt 是常量成本，按型推荐是条件成本。

## X09 能力缺口台账 + 回归检测

- **superagent 有**：无（缺口散在文档的 Open questions）。
- **我们怎么做**：kaa `gap report/fill/verify`，`uses=0` 判回归。
- **判据**：`kaa gap list` 三段折叠（红/绿/复查）可读；已补齐但零使用的条目被标回归。

## X10 策略三层：值 → 策略 → 判定

- **superagent 有**：settings + policy version，两档。
- **我们怎么做**：kaa 值（spec 单键）→ 策略（profiles 只选真被读的键）→ 判定（只读有效策略；`overridable=false` 禁止覆盖）。
- **判据**：`kaa policy show --profile <p>` 能给出每个值的来源层；覆盖一个出厂锁定键必须被拒。

## X11 静态模型面预算（R19 的加强版）

- **superagent 有**：`tests/model-surface.spec.ts` 按角色设体积预算。
- **我们多做一点**：预算同时覆盖 dsh 的 preset 工具清单——两个 preset 的工具集差异本身就是预算的一部分。
- **判据**：`dsh --profile superagent --dump-config | grep -c 'id: tool-'` 在 router 面与 worker 面必须不同；任一面超阈值时预算测试判红。

---

## 不能算超额的三样（避免自我表扬）

| 候选 | 为什么不算 |
|---|---|
| 「我们有 kaa，原型没有」 | 原型有等价的 Ticket/Mandate/Effect 组合，只是没做成台账。**能力等价，形态不同**，不是超额 |
| 「我们用 SQLite，他们用 SQLite」 | 同构，无增量 |
| 「我们有 26 个插件」 | 数量不是能力；R20 已经把这些插件归到工具面，超标反而是负债 |

**判定口径**：一条超额项必须同时满足 ①superagent 明确没有 ②我们手上有可用实现 ③有一条命令能判红。缺一条就移到「说法」栏，不写进本表。
