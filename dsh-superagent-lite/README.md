# dsh-superagent-lite

编排层插件包。**当前只有目录骨架，没有一个代码文件**——按交付要求"先不直接开发落地"，这里只把
`DETAILED-DESIGN.md` §1.1 设计的目录先落到磁盘上，让后面每个任务有确定的落点。

## 这张目录从哪来

- 设计与行数预算：`../DETAILED-DESIGN.md` §1.1（目录树）、§1.3（15 个模块逐行预算，src 合计 1,300）
- 谁写哪个文件：`../TASKS.md` §1 任务总表（K01–K14，每个任务列了产出文件）
- 目录本身受机检约束：`../check-delivery.py` 判据 ⑦ 校验"磁盘上的目录 = §1.1 声明的目录集合"，
  多一个目录或少一个目录都报红；**它只校验目录层，不校验文件**——文件由任务负责建。

## 三条目录纪律（违反即返工）

1. **`src/core/` 零宿主依赖**：禁止 `import @deepseek-ai/*`、`node:fs`、`node:net`、`better-sqlite3`。
   core 必须能脱离 dsh 单测。
2. **跨进程出口只有一个文件**：只许 `src/app/kaa.ts` 出现 `spawn` / `execFile`。
3. **`presets/` 只写差异**：两份 patch 从 `turbo` 派生，只写"少什么"，不复制整份清单。

## 各目录的归属

| 目录 | 放什么 | 谁建 | 约束 |
|---|---|---|---|
| `presets/` | `router.patch.yml`、`worker.patch.yml` | K01 | 只写差异 |
| `src/core/` | 纯函数域：model / stage / engine / ports | K02、K03 | 零宿主依赖、无 I/O |
| `src/app/` | 组合根、存储、副作用、出站、执行器、kaa 出口 | K04–K08 | 除 kaa.ts 外不得起子进程 |
| `src/sources/` | 触发源（goal-tree 轮询、人工） | K09 | 只产出 Trigger，不写库 |
| `src/channel/` | 出站通道（首版本地） | K10 | 幂等靠 outbox |
| `src/tools/` | worker 侧工具（report） | K11 | —— |
| `src/panel/` | 面板数据视图 | K12 | 只读投影 |
| `tests/` | unit / integration / fixtures | K13 | 每条判据至少一个能判红的坏夹具 |
| `scripts/` | `verify.sh`（一条命令跑全部判据） | K13 | 供 `run-all-tests.sh` 调 |
