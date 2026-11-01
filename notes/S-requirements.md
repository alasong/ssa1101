# n2 需求基线：superagent 的可验收要求（S 类）

**口径**：只抽取，不做取舍。每条给「陈述 + 出处」，出处一律 `docs/xx:行`，可在 `/tmp/sap-src` 复核。取舍留到 n4。
**来源**：`/tmp/sap-src`（`deepseek-ai/dsh-superagent-prototype@main`）的 000–007 文档。

---

## A 领域模型（001）

| ID | 要求 | 出处 |
|---|---|---|
| S01 | Source = 可复用 kind + 一份实例配置；持有读位置与自身 bot 身份；丢弃自己的消息与不在监听范围的 Trigger；把 Trigger 翻译成 Thread 与 Channel 地址 | `docs/001-domain.md:27` |
| S02 | Trigger 幂等：同一 Trigger 接受两次只建一个 Ticket | `docs/001-domain.md:28` |
| S03 | Thread 串行：一个 Thread 同时最多一个 Eval，期间到达的合并进下一批 | `docs/001-domain.md:29` |
| S04 | Subscription 扇出：匹配的 Trigger 分发给每个在线订阅 Ticket；人的消息经此到达则不进行 Eval | `docs/001-domain.md:37` |
| S05 | Mandate 不可变，含策略版本、范围、强度、匹配规则、发送者在该来源的身份、来源如何收到该 Trigger；只有人的停止撤回，策略不再持有时撤销 | `docs/001-domain.md:34` |
| S06 | Eval 两段：确定性 Gate + 模型 Assessment，输出 Decision，自身无状态 | `docs/001-domain.md:33` |
| S07 | Ticket 只由 Eval 创建；open↔ended；Ticket 自定义状态，不跟随执行器 | `docs/001-domain.md:35` |
| S08 | Assignment = Ticket↔执行器实例的绑定，可多次；pending→running→ended，与 Ticket 独立 | `docs/001-domain.md:36` |
| S09 | Policy 版本化；变更不撤销 Mandate，只投递给受影响的 Assignment | `docs/001-domain.md:32` |
| S10 | 拒绝概念表 12 条（不加 Principal/Membership、不跨来源映射身份、Eval 不自我调度延迟等） | `docs/001-domain.md:45-60` |
| S11 | Correlation 只加上下文，永不路由 | `docs/001-domain.md:30` |

## B 授权（002）

| ID | 要求 | 出处 |
|---|---|---|
| S12 | 两条路径：Eval 决定是否开工；Subscription 继续已有工作 | `docs/002-authorization.md:7` |
| S13 | 强度分 explicit / inferred，二者走不同准入 | `docs/002-authorization.md:46` |
| S14 | 准入依据四种 via：addressed / followup / admission / bot | `docs/007-architecture.md:125-132` |
| S15 | inferred 只在 auto 模式且命中启用规则时可被接受，否则记「would accept」 | `docs/002-authorization.md:91` |
| S16 | 策略版本变更时，运行中的 Eval 必须被丢弃 | `docs/002-authorization.md:107` |
| S17 | 恢复 ended Ticket 前，对当前策略复核 Mandate | `docs/002-authorization.md:131` |
| S18 | Eval 超时：重排两次，第三次记 `unavailable` | `docs/002-authorization.md:147` |

## C 执行（003）

| ID | 要求 | 出处 |
|---|---|---|
| S19 | 一个 Ticket = 一个 Session（`worker-<id>`）+ 一个目录 | `docs/003-execution.md:25` |
| S20 | 角色预设分离：worker / router 各自工具面；前台命令超 5 秒转后台 | `docs/003-execution.md:27-29` |
| S21 | turn 结束但仍有 shell job / subagent 时保留槽位、不报 waiting；30 分钟上限杀 job | `docs/003-execution.md:31-39` |
| S22 | 交接给人立即释放槽位，报告保持 | `docs/003-execution.md:37` |
| S23 | 准备命令：首次派工前跑一次，10 分钟，失败判失败并存输出 | `docs/003-execution.md:51-53` |
| S24 | 并发上限 + 人的插话可用额外一个槽，且优先于新派工 | `docs/003-execution.md:59` |
| S25 | 执行环境变量由执行器与来源注册，不含凭据 | `docs/003-execution.md:65-77` |
| S26 | 7 行阶段表决定当前 stage（person/*，working/queued，idle，working） | `docs/003-execution.md:7-17` |
| S27 | 合并与 PR 跟随：Ticket 在它开的 PR 全关时才结束 | `docs/003-execution.md:82-106` |
| S28 | 失败恢复：瞬时失败重试 3 次退避；重启记 host restarted 并给恢复笔记 | `docs/003-execution.md:120-152` |
| S29 | 存储先行：决定后先写库再执行外部动作 | `docs/003-execution.md:153-161` |
| S30 | Channel 保序：同 Ticket 同会话按序；5s 起翻倍到 300s；三次失败报问题 | `docs/003-execution.md:175-191` |
| S31 | 暂停：停派工/新 Eval/投递/回复，来源继续记录 Trigger | `docs/003-execution.md:192-200` |

## D 提示词 / 面板 / 部署（004-006）

| ID | 要求 | 出处 |
|---|---|---|
| S32 | 提示词可被团队覆写：内置部分 + 覆写 + 版本化 + 预览 | `docs/004-prompts.md:5-91` |
| S33 | 面板只显示需要人的东西；空态不占位 | `docs/005-panel.md:5-50` |
| S34 | 部署要回答：权限与隔离、账户、安装、启停、每小时检查、管理 API、setup 检查、升级 | `docs/006-deployment.md:5-248` |

## E 架构（007）

| ID | 要求 | 出处 |
|---|---|---|
| S35 | 核心不 import 外部模块、不做 I/O | `docs/007-architecture.md:258` |
| S36 | 每类状态只有一个写者（表列死） | `docs/007-architecture.md:261-269` |
| S37 | Effects：6 种 kind；enqueue 在事务内、执行在提交后；`(kind,key)` 唯一；指数退避；`Later` 不计失败 | `docs/007-architecture.md:166-179` |
| S38 | 单 SQLite；生成列 + 索引让一次 pass 只读活动工作；schema 只增 | `docs/007-architecture.md:452-486` |
| S39 | 模型面体积预算：每个角色的工具+提示词有上限，超了测试判红 | `docs/007-architecture.md:437` |
| S40 | 工具面：主 Session 14 个 + 执行器 6 个 | `docs/007-architecture.md:492-530` |
| S41 | 配置除 stateDir 外全部热重载，不需要重启 | `docs/007-architecture.md:604-608` |

---

## 统计

共 **41 条**：领域 11、授权 7、执行 13、提示词/面板/部署 3、架构 7。

**未覆盖到的部分（诚实标注）**：`docs/008-cookbook.md`（新增 Source 的步骤）与 `docs/006` 的运维细节只读了标题，未逐条抽取；若 n4 判定需要，再补为 S42..。
