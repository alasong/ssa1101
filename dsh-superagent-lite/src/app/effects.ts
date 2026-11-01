/**
 * app/effects.ts —— 持久副作用队列（K05，预算 130 行）。
 *
 * 三条语义，逐条对应详设 §5：
 *  1. **先 claim 再执行**：`claimDue` 一面取到期行、一面把它们标成 running。
 *     执行途中崩溃 → 那些行留在 running，重启时 `recover()` 退回 pending 重放。
 *  2. **成功才 settle**：只有 handler 正常返回才落 done；抛错走退避（`retry`），
 *     次数用尽才 `fail`。所以"执行过但没 settle"一定会被重放——幂等靠 `(kind,key)` 唯一。
 *  3. **入队在事务内、执行在提交后**：入队由 Engine 在自己的 `atomic` 里做（K03），
 *     本文件只负责提交之后的执行段，不自己开事务——否则又变成两个写者。
 *
 * `Later` 表示"现在做不了"（例如槽位满），**不计失败次数**，也不推进退避。
 */
import type { EffectKind, EffectRow } from '../core/model.ts';
import type { Repository } from '../core/ports.ts';

export interface Backoff {
  initialMs: number;
  /** 上限；指数翻倍到这里就不再长。 */
  maxMs: number;
  /** 最多尝试几次（含第一次）。 */
  maxAttempts: number;
}

/** 逐行照抄详设 §5.1 的退避列，不自己发明参数。 */
export const BACKOFF: Record<EffectKind, Backoff> = {
  launch: { initialMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  deliver: { initialMs: 2_000, maxMs: 60_000, maxAttempts: 3 },
  relay: { initialMs: 2_000, maxMs: 60_000, maxAttempts: 3 },
  reply: { initialMs: 5_000, maxMs: 300_000, maxAttempts: 3 },
  kaaDone: { initialMs: 2_000, maxMs: 60_000, maxAttempts: 3 },
  treeWrite: { initialMs: 2_000, maxMs: 60_000, maxAttempts: 3 },
};

/** "现在做不了"的信号：不算失败，原样退回队列前端。 */
export class Later extends Error {
  constructor(reason = 'later') {
    super(reason);
    this.name = 'Later';
  }
}

/** 已失败 `failedAttempts` 次之后该等多久：初始值翻倍，封顶 maxMs。 */
export function nextDelay(kind: EffectKind, failedAttempts: number): number {
  const b = BACKOFF[kind];
  const exp = Math.max(0, failedAttempts - 1);
  return Math.min(b.initialMs * 2 ** exp, b.maxMs);
}

export type EffectHandler = (row: EffectRow) => void | Promise<void>;
export type Handlers = Partial<Record<EffectKind, EffectHandler>>;

export interface RunReport {
  /** 本次 claim 到的条数 */
  claimed: number;
  settled: number;
  retried: number;
  deferred: number;
  failed: number;
  /** 没有对应 handler，原样推后（不算失败） */
  skipped: number;
}

/** 崩溃恢复：把上个进程留下的 running 退回 pending。启动顺序里排在建库之后（§5.2 第 3 步前）。 */
export function recover(repo: Repository): number {
  return repo.effects.recoverRunning();
}

/**
 * 跑一轮到期副作用。
 * @param now 注入的时钟，测试里给确定值
 * @param handlers 按 kind 分派；缺 handler 的行不算失败，推到 maxMs 之后
 */
export async function runDue(
  repo: Repository,
  now: number,
  handlers: Handlers,
  opts: { maxAttempts?: Partial<Record<EffectKind, number>>; deferMs?: number } = {},
): Promise<RunReport> {
  const report: RunReport = { claimed: 0, settled: 0, retried: 0, deferred: 0, failed: 0, skipped: 0 };
  const rows = repo.effects.claimDue(now);
  report.claimed = rows.length;

  for (const row of rows) {
    const handler = handlers[row.kind];
    if (handler === undefined) {
      report.skipped += 1;
      repo.effects.retry(row.id, row.attempts, now + BACKOFF[row.kind].maxMs, 'no handler');
      continue;
    }
    try {
      await handler(row);
      repo.effects.settle(row.id);
      report.settled += 1;
    } catch (e) {
      if (e instanceof Later) {
        // 不消耗次数、不推进退避：只把它放回队列
        report.deferred += 1;
        repo.effects.retry(row.id, row.attempts, now + (opts.deferMs ?? 1_000), String(e.message ?? e));
        continue;
      }
      const attempts = row.attempts + 1;
      const maxAttempts = opts.maxAttempts?.[row.kind] ?? BACKOFF[row.kind].maxAttempts;
      if (attempts >= maxAttempts) {
        repo.effects.fail(row.id, String((e as Error)?.message ?? e));
        report.failed += 1;
      } else {
        repo.effects.retry(row.id, attempts, now + nextDelay(row.kind, attempts), String((e as Error)?.message ?? e));
        report.retried += 1;
      }
    }
  }
  return report;
}
