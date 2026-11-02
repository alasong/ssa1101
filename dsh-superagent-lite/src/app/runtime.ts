/**
 * app/runtime.ts —— 组合根与 pass 循环（K06，预算 90 行，实际见记账）。
 *
 * 启动顺序照抄详设 §5.2，顺序错了会丢事：
 *   ① openDb（版本守卫在 openDb 里）→ ② createRepository → ③ recover（把上次留下的 running 退回）
 *   → ④ 起 pass 循环（每 2 秒）→ ⑤ 每轮：取 pending event 交给 Engine → 跑到期 effects。
 *
 * pass 的判据（R12）：**停掉 pass，event 停在 pending 不被消费**——
 * 也就是"pass 挂了表现为积压，不表现为丢事件"。所以本文件只从库里取事件，不从内存队列取。
 */
import type { DatabaseSync } from 'node:sqlite';
import { Engine } from '../core/engine.ts';
import type { Handlers } from './effects.ts';
import { recover, runDue } from './effects.ts';
import type { RunReport } from './effects.ts';
import { createRepository, openDb } from './store.ts';
import type { Repository } from '../core/ports.ts';

export interface RuntimeDeps {
  dbPath: string;
  gate: ConstructorParameters<typeof Engine>[0]['gate'];
  handlers?: Handlers;
  /** pass 间隔，默认 2000ms（§5.2 第 4 步）。 */
  intervalMs?: number;
  now?: () => number;
  /** 每轮最多消费多少条待处理事件（有界）。 */
  batch?: number;
}

export interface TickResult {
  /** 本轮消费的事件数 */
  events: number;
  /** 本轮跑掉的副作用 */
  effects: RunReport;
}

export interface Runtime {
  repo: Repository;
  engine: Engine;
  /** 手动推进一轮（测试与"停掉 pass 再点一下"都用它）。 */
  tick(): Promise<TickResult>;
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** 启动时崩溃恢复的读数（effect 退回数 / assignment 标 interrupted 数）。 */
  readonly recovered: { effects: number; assignments: number };
  close(): void;
}

export function startRuntime(deps: RuntimeDeps): Runtime {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? 2_000;
  const batch = deps.batch ?? 20;

  const db: DatabaseSync = openDb(deps.dbPath);
  const repo = createRepository(db);
  // ③ 崩溃恢复（§5.2 第 2–3 步，顺序不能反）：
  //    a. effect 的 running 退回 pending —— 重启后第一轮就重放，不等 30s 租约；
  //    b. 在跑的 assignment 标 interrupted —— 会话已经没了，不能继续显示"在跑"。
  const recoveredEffects = recover(repo);
  let interruptedAssignments = 0;
  for (const t of repo.tickets.open()) {
    const a = t.assignment;
    if (a !== undefined && a.state === 'running') {
      repo.tickets.put({ ...t, assignment: { ...a, state: 'interrupted' } });
      interruptedAssignments += 1;
    }
  }

  // 发号从"库里已有的最大号"续，不能从 0 数：进程重启会让 n 归零，
  // 于是新工单又叫 t1，put() 的 ON CONFLICT DO UPDATE 把已结束的旧 t1 整条覆盖（实测踩过）。
  let n = repo.tickets.all().reduce((max, t) => {
    const m = /^t(\d+)$/.exec(t.id);
    return m === null ? max : Math.max(max, Number(m[1]));
  }, 0);
  const engine = new Engine({ repo, gate: deps.gate, now, nextId: () => `t${++n}` });

  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<TickResult> => {
    const pending = repo.events.pending(batch);
    for (const e of pending) engine.handleEvent(e);
    // 用**处理完之后**的 now 跑 effects：本轮刚入队的行（dueAt = 处理时刻）如果拿本轮开头的
    // 时间戳去比，会差几毫秒而这一轮取不到，"一次 tick 什么都没发生"就是这么来的。
    const effects = await runDue(repo, now(), deps.handlers ?? {});
    return { events: pending.length, effects };
  };

  return {
    repo,
    engine,
    tick,
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        // 一轮失败不能杀掉循环：pass 挂掉要表现为积压（下轮再取），不是进程退出
        void tick().catch(() => undefined);
      }, intervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    get running() {
      return timer !== undefined;
    },
    recovered: { effects: recoveredEffects, assignments: interruptedAssignments },
    close() {
      this.stop();
      db.close();
    },
  };
}
