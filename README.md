# ssa1101 / dsh-superagent-lite

一个**独立的轻编排层**：把「人提需求 / 目标树长出新叶子」变成工单，起执行会话、收执行报告、
决定什么时候该找人、结束工单后去 kaa 记账并回写目标树。不重写 kaa，也不重写 dsh。

- 代码：`dsh-superagent-lite/`（src **1,687 行** / 16 个模块，零第三方依赖、零宿主依赖）
- 测试：118 条单测 + 15 条验收（T01–T15）+ 5 条端到端（K14）
- 文档：`docs/` 下 5 份（需求 / 架构 / 详设 / 任务 / 交付）+ 机检脚本 `check-delivery.py`

## 30 秒跑起来

```bash
cd dsh-superagent-lite

node scripts/demo.ts      # 9 步演示：需求 → 工单 → 会话 → 面板 → 批准 → 崩一次 → 重启续跑
bash scripts/verify.sh    # 验收套件：20/20 PASS 才算过
node --test tests/unit/   # 118 条单测
```

`demo.ts` 不需要 dsh、不需要 API key、不联网。

## 怎么用（当成 CLI 小服务）

库默认在 `~/.dsh/superagent-lite/sa.db`（`SA_DB=...` 可换）。所有命令都在 `dsh-superagent-lite/` 下执行：

| 命令 | 作用 |
|---|---|
| `node scripts/cli.ts put "把登录页按钮改成蓝色"` | 投一条需求（人触发） |
| `node scripts/cli.ts tick` | 推进一轮：事件 → 工单 → 跑副作用 |
| `node scripts/cli.ts run` | 常驻，每 2 秒一轮（Ctrl-C 退出） |
| `node scripts/cli.ts tickets` | 列开着的工单 |
| `node scripts/cli.ts panel` | 只显示**需要人**的事（没有就空） |
| `node scripts/cli.ts board` | 全看板（7 个 stage） |
| `node scripts/cli.ts approve t1` | 人批准 → 结束工单（kaa 记账 + 回写） |
| `node scripts/cli.ts pull-tree` | **从目标树拉任务**（ready 叶子 → 事件），不用敲 put |

`put` 之后要 `tick`（或先起 `run`）才会变成工单。

### 任务从哪来（三条入口）

1. **人敲命令**：`put "…"`（最直接）
2. **目标树**：`pull-tree`——读 `~/.dsh/storages/goal_tree.json`，把「pending + 没有孩子 + 依赖都完成」的叶子
   翻成事件；幂等键 `node:<id>:<revision>`，同 revision 重复拉只会被判重复，不会重复建单。
   `--session <id>` 指定哪棵树（默认取最近更新的那棵），`--tree <json>` 指定别的文件。
3. **会话里跟我说**：我替你敲上面任一命令。

没有 HTTP 入口，也不打算有：写者只有 kaa，`src/channel/local.ts` 里连 HTTP 客户端都没有（结构上做不到，不是靠约定）。

## 装进 dsh（bundle 补丁层）

包自己声明是 bundle（`package.json` 的 `dsh.bundle.patch`），装法：

```bash
bash scripts/bootstrap-profile.sh          # 建 profile、link 安装、写进 bundles
dsh --profile superagent --json "hello"    # 起动时会看到 [superagent-lite] mounted
```

只看它有没有真挂上（三个读数缺一不可）：

```bash
python3 -c "import json;print('dsh-superagent-lite' in json.load(open('$HOME/.dsh/profiles/superagent/package.json'))['dsh']['profile']['bundles'])"
dsh --profile superagent --dump-config | grep -c superagent-lite      # ≥1
dsh --profile superagent --json ok 2>&1 | grep -c '\[superagent-lite\] mounted'   # 1
```

> 目前 `apply()` 只打一行挂载日志，**没有做宿主内集成**：不会出现在 GUI 面板里，也没有注册工具。
> 它跑在命令行里（见上一节）。

## 它现在真的做了什么 / 还没做什么

**真的**：事件幂等、Gate 准入、工单七行 stage 派生、effects 队列（退避 + 崩溃重放 + 终态失败）、
出站保序与幂等、执行器槽位（人的消息优先）、面板空态、SQLite 事务与 schema 迁移。

**是桩**：起会话（`SessionExecutor` 的 `SessionFactory` 还没接真 dsh）、kaa 记账（`kaa.ts` 有真实现但没有调用方）、
回写目标树（`treeWrite` 只打印）。

## 目录

```
dsh-superagent-lite/
├── src/core/      model · stage（7 行判定）· engine（唯一写者）· ports（4 个端口）
├── src/app/       store（SQLite）· effects · outbox · executor · kaa · runtime（组合根）
├── src/sources/   goal-tree（每 30s 拉 ready 叶子）· manual
├── src/channel/   local（无 HTTP 客户端，结构上禁止直接 POST 目标树）
├── src/tools/     report（worker 唯一回写口）
├── src/panel/     view（renderBoard / renderPanel / 空态）
├── tests/         unit 11 个文件 · integration 2 个（T01–T15、K14）
└── scripts/       verify.sh · demo.ts · cli.ts · bootstrap-profile.sh · check-enums.sh
```

## 验证

```bash
python3 check-delivery.py     # 11 条交付判据：锚点、目录、大纲、行数一致性、R→K 覆盖
bash dsh-superagent-lite/scripts/verify.sh   # 20/20
```

## 已知未完成（诚实清单）

- Q1–Q4 未答：Trigger 只做了人 + goal-tree；worker 能否 commit/push 未定；blocklist 空
- T10 的「5 秒内投达」只验到「不被槽位阻塞」，没验时钟量
- 崩溃实验用的是子进程 `process.exit(137)`，没发 SIGKILL
- 从未跑过 `tsc --noEmit`（仓库没装 typescript）；类型正确性是推断
- 图形界面里没有入口（见上）
