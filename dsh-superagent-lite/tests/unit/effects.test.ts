/**
 * tests/unit/effects.test.ts —— 持久副作用队列的 8 条规格（详设 §5 / R09 / T08）。
 *
 * 规格来源：详设 §5 的语义条文，不是从实现反推；期望值（5000 / 10000 / 300000 /
 * 2000 / 1000）按规格写死，不引用 BACKOFF 里的常量，避免实现错了测试跟着错。
 *
 * 时钟全部注入，不 sleep；仓储用内存假实现，语义忠于 ports.ts 的接口注释：
 * `claimDue` 一面取到期行、一面把它们标成 running（先 claim 再执行）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EffectKind, EffectRow } from '../../src/core/model.ts';
import type { NewEffect, Repository } from '../../src/core/ports.ts';
import { Later, nextDelay, recover, runDue } from '../../src/app/effects.ts';

interface RetryCall {
  id: string;
  attempts: number;
  nextAt: number;
  error: string;
}

interface FakeRepo {
  /** 交给 runDue / recover 的仓储句柄（其余表给空实现）。 */
  repo: Repository;
  rows: Map<string, EffectRow>;
  calls: {
    settle: string[];
    retry: RetryCall[];
    fail: { id: string; error: string }[];
    recoverRunning: number;
  };
  /** 测试直接读存仓里的行（克隆，防止测试拿到 runDue 手里的引用）。 */
  get(id: string): EffectRow | undefined;
  /** 崩溃模拟：把某行改成指定 state（绕过仓储正常路径）。 */
  forceState(id: string, state: EffectRow['state']): void;
}

function makeRepo(): FakeRepo {
  const rows = new Map<string, EffectRow>();
  let seq = 0;
  const calls: FakeRepo['calls'] = { settle: [], retry: [], fail: [], recoverRunning: 0 };

  const effects = {
    enqueue(e: NewEffect): void {
      seq += 1;
      const id = `fx-${seq}`;
      rows.set(id, {
        id,
        kind: e.kind,
        key: e.key,
        payload: e.payload,
        attempts: 0,
        nextAt: e.dueAt,
        state: 'pending',
      });
    },
    /** 取 nextAt <= now 且 pending 的行，并**同时**标成 running（接口注释的硬要求）。 */
    claimDue(now: number): EffectRow[] {
      const due = [...rows.values()].filter((r) => r.nextAt <= now && r.state === 'pending');
      for (const r of due) r.state = 'running';
      return due;
    },
    settle(id: string): void {
      calls.settle.push(id);
      const r = rows.get(id);
      assert.ok(r, `settle 收到未知 id: ${id}`);
      r.state = 'done';
    },
    retry(id: string, attempts: number, nextAt: number, error: string): void {
      calls.retry.push({ id, attempts, nextAt, error });
      const r = rows.get(id);
      assert.ok(r, `retry 收到未知 id: ${id}`);
      r.attempts = attempts;
      r.nextAt = nextAt;
      r.state = 'pending';
    },
    fail(id: string, error: string): void {
      calls.fail.push({ id, error });
      const r = rows.get(id);
      assert.ok(r, `fail 收到未知 id: ${id}`);
      r.state = 'failed';
    },
    recoverRunning(): number {
      let n = 0;
      for (const r of rows.values()) {
        if (r.state === 'running') {
          r.state = 'pending';
          n += 1;
        }
      }
      calls.recoverRunning += 1;
      return n;
    },
  };

  const repo = {
    atomic: <T>(f: () => T): T => f(),
    events: { put: () => {}, byExternalId: () => undefined },
    tickets: { put: () => {}, get: () => undefined, open: () => [] },
    reports: { append: () => {}, latest: () => undefined },
    effects,
  } as unknown as Repository;

  return {
    repo,
    rows,
    calls,
    get(id) {
      const r = rows.get(id);
      return r === undefined ? undefined : { ...r };
    },
    forceState(id, state) {
      const r = rows.get(id);
      assert.ok(r, `forceState 收到未知 id: ${id}`);
      r.state = state;
    },
  };
}

/** 入队一条 effect 并返回 id；attempts 就地覆盖（用来造"已失败过 N 次"的行）。 */
function seed(
  fake: FakeRepo,
  spec: { kind: EffectKind; dueAt: number; key?: string; attempts?: number },
): string {
  fake.repo.effects.enqueue({
    kind: spec.kind,
    key: spec.key ?? `${spec.kind}-key`,
    payload: '{}',
    dueAt: spec.dueAt,
  });
  const id = `fx-${fake.rows.size}`;
  const row = fake.rows.get(id);
  assert.ok(row, 'enqueue 之后应当能取到行');
  if (spec.attempts !== undefined) row.attempts = spec.attempts;
  return id;
}

// ---------------------------------------------------------------------------
// 1. 成功路径：到期 launch + handler 正常返回 → settle 成 done，handler 只调 1 次
// ---------------------------------------------------------------------------
test('规格1 成功路径：到期 launch 被 settle 成 done 且 handler 只调用一次', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'launch', dueAt: 100 });

  let handlerCalls = 0;
  const report = await runDue(fake.repo, 1_000, {
    launch: () => {
      handlerCalls += 1;
    },
  });

  assert.equal(report.claimed, 1, 'claimed 应为 1');
  assert.equal(report.settled, 1, 'settled 应为 1');
  assert.equal(report.retried, 0);
  assert.equal(report.failed, 0);
  assert.equal(handlerCalls, 1, 'handler 应恰好被调用一次');
  assert.equal(fake.get(id)?.state, 'done', '成功后该行应为 done');
  assert.deepEqual(fake.calls.settle, [id], 'settle 应只对被 claim 的那一行调用一次');
});

// ---------------------------------------------------------------------------
// 2. T08 的一半：handler 执行时该行已经是 running（证明先 claim 再执行）
// ---------------------------------------------------------------------------
test('T08 先 claim 再执行：handler 内部读到的 state 是 running 而非 pending', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'launch', dueAt: 100 });

  let stateInHandler: string | undefined;
  let stateFromRepo: string | undefined;
  await runDue(fake.repo, 1_000, {
    launch: (row) => {
      stateInHandler = row.state;
      stateFromRepo = fake.get(id)?.state;
    },
  });

  assert.equal(stateInHandler, 'running', '传给 handler 的行在执行前就应标成 running');
  assert.notEqual(stateInHandler, 'pending');
  assert.equal(stateFromRepo, 'running', '仓储里存的该行在执行期间也应是 running');
  assert.equal(fake.get(id)?.state, 'done');
});

// ---------------------------------------------------------------------------
// 3. R09：失败走退避 —— kaaDone 抛错 → retried=1、attempts=1、pending、nextAt=now+2000
// ---------------------------------------------------------------------------
test('R09 失败退避：kaaDone 抛错 → attempts=1、pending、nextAt=now+nextDelay(kaaDone,1)=2000', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'kaaDone', dueAt: 100 });
  const now = 1_000;

  const report = await runDue(fake.repo, now, {
    kaaDone: () => {
      throw new Error('boom');
    },
  });

  assert.equal(report.retried, 1, 'retried 应为 1');
  assert.equal(report.settled, 0);
  assert.equal(report.failed, 0);

  const row = fake.get(id);
  assert.ok(row);
  assert.equal(row.attempts, 1, '失败一次后 attempts 应为 1');
  assert.equal(row.state, 'pending', '可重试应退回 pending');
  assert.equal(row.nextAt, now + 2_000, 'nextAt 应为 now + nextDelay(kaaDone,1) = now + 2000');
  assert.equal(nextDelay('kaaDone', 1), 2_000, '规格值：kaaDone 首次退避 2000ms');
  assert.deepEqual(fake.calls.retry.map((c) => c.attempts), [1], 'retry 只应写回 attempts=1');
});

// ---------------------------------------------------------------------------
// 4. 次数用尽 → 终态 failed，且 settle 从未被调用
// ---------------------------------------------------------------------------
test('规格4 次数用尽：deliver 初始 attempts=2 抛错 → failed=1、state=failed、settle 从未调用', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'deliver', dueAt: 100, attempts: 2 });

  const report = await runDue(fake.repo, 1_000, {
    deliver: () => {
      throw new Error('delivery rejected');
    },
  });

  assert.equal(report.failed, 1, 'failed 应为 1');
  assert.equal(report.retried, 0, '次数用尽不应再 retry');
  assert.equal(report.settled, 0);
  assert.equal(fake.get(id)?.state, 'failed', '终态应为 failed');
  assert.deepEqual(fake.calls.settle, [], 'settle 从未被调用');
  assert.equal(fake.calls.fail.length, 1, 'fail 应被调用一次');
});

// ---------------------------------------------------------------------------
// 5. Later 不计失败：attempts 保持 0、pending、nextAt = now + 默认 deferMs(1000)
// ---------------------------------------------------------------------------
test('规格5 Later 不计失败：attempts 保持 0、pending、nextAt=now+1000（默认 deferMs）', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'launch', dueAt: 100 });
  const now = 1_000;

  const report = await runDue(fake.repo, now, {
    launch: () => {
      throw new Later();
    },
  });

  assert.equal(report.deferred, 1, 'deferred 应为 1');
  assert.equal(report.retried, 0, 'Later 不算 retried');
  assert.equal(report.failed, 0, 'Later 不算 failed');
  assert.equal(report.settled, 0);

  const row = fake.get(id);
  assert.ok(row);
  assert.equal(row.attempts, 0, 'Later 不应消耗失败次数');
  assert.equal(row.state, 'pending', 'Later 之后应保持 pending');
  assert.equal(row.nextAt, now + 1_000, 'nextAt 应为 now + 默认 deferMs = now + 1000');
});

// ---------------------------------------------------------------------------
// 6. T08 的核心：崩溃重放只一次 —— recover 退回 pending，重放后副作用只发生 1 次
// ---------------------------------------------------------------------------
test('T08 崩溃后 recover 退回 pending 且重放只执行一次（外部副作用计 1 次）', async () => {
  const fake = makeRepo();
  const id = seed(fake, { kind: 'launch', dueAt: 100 });
  let handlerCalls = 0;
  let sideEffects = 0;

  // 第一次执行：handler 抛错（模拟执行途中"崩掉"那一刻之前的失败）
  const first = await runDue(fake.repo, 1_000, {
    launch: () => {
      handlerCalls += 1;
      throw new Error('crash');
    },
  });
  assert.equal(first.retried, 1);
  assert.equal(handlerCalls, 1);
  // launch 首次退避 = 5000：1000 + 5000 = 6000，重放必须等到这个时刻才到期
  const replayAt = fake.get(id)?.nextAt;
  assert.equal(replayAt, 6_000, '失败后 nextAt 应为 now + 5000');

  // 模拟崩溃：进程留下的 running 行（retry 已把它写回 pending，这里手工改成 running）
  fake.forceState(id, 'running');
  assert.equal(fake.get(id)?.state, 'running');

  // 重启：recover 把 running 退回 pending
  const recovered = recover(fake.repo);
  assert.equal(recovered, 1, 'recover 应退回 1 条 running');
  assert.equal(fake.get(id)?.state, 'pending', 'recover 之后应为 pending');
  assert.equal(fake.get(id)?.attempts, 1, 'recover 不改 attempts');

  // 重放：handler 这次成功；只有成功那次才落"外部副作用"
  const second = await runDue(fake.repo, replayAt as number, {
    launch: () => {
      handlerCalls += 1;
      sideEffects += 1;
    },
  });
  assert.equal(second.settled, 1, '重放成功应 settled 1');
  assert.equal(fake.get(id)?.state, 'done', '重放成功后应为 done');
  assert.equal(handlerCalls, 2, 'handler 总共被调用 2 次（一次崩、一次重放）');
  assert.equal(sideEffects, 1, '外部副作用只应发生 1 次（幂等）');
  assert.deepEqual(fake.calls.settle, [id], 'settle 只应发生一次');
});

// ---------------------------------------------------------------------------
// 7. nextDelay 边界：指数翻倍 + 封顶 + 各 kind 的初始值
// ---------------------------------------------------------------------------
test('规格7 nextDelay：launch 5000/10000/封顶 300000，relay 首次 2000', () => {
  assert.equal(nextDelay('launch', 1), 5_000, 'launch 首次退避 5000');
  assert.equal(nextDelay('launch', 2), 10_000, 'launch 第二次退避 10000');
  assert.equal(nextDelay('launch', 9), 300_000, 'launch 退避封顶 300000');
  assert.equal(nextDelay('relay', 1), 2_000, 'relay 首次退避 2000');
});

// ---------------------------------------------------------------------------
// 8. 到期过滤：nextAt=5000 的行在 now=1000 时不被 claim
// ---------------------------------------------------------------------------
test('规格8 到期过滤：runDue(now=1000) 只 claim 到 nextAt=100 的那一条', async () => {
  const fake = makeRepo();
  const dueId = seed(fake, { kind: 'launch', dueAt: 100, key: 'due' });
  const futureId = seed(fake, { kind: 'launch', dueAt: 5_000, key: 'future' });

  let handlerCalls = 0;
  const report = await runDue(fake.repo, 1_000, {
    launch: () => {
      handlerCalls += 1;
    },
  });

  assert.equal(report.claimed, 1, 'claimed 应为 1');
  assert.equal(report.settled, 1);
  assert.equal(handlerCalls, 1, '未到期的那条不应触发 handler');
  assert.equal(fake.get(dueId)?.state, 'done', '到期行应被处理');
  assert.equal(fake.get(futureId)?.state, 'pending', '未到期行应保持 pending');
});
