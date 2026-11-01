/**
 * tests/unit/runtime.test.ts —— 组合根 + SQLite 仓储的集成测试（R12 / 详设 §5.2、§6）。
 *
 * 规格来源是条文，不是实现：
 *  - R12：pass 停掉 = 事件停在 pending 的积压，不是丢事件。所以只手动调 tick()，不起定时器。
 *  - §6：消费即处置（dispose 落库），重复 tick 不重复建单。
 *  - §3：atomic 真回滚（BEGIN IMMEDIATE / COMMIT / ROLLBACK），不是 try/catch 吞掉。
 *  - §5.1：effect 先 claim 后 settle；settle 删行。
 *  - reports 走 kv，latest 取同一 ticket 的最后一版。
 *  - §5.2 第 ① 步：版本守卫在 openDb 里，组合根必须经过它。
 *
 * 用真 `node:sqlite` 落临时文件（每个用例独立），不 mock；时钟注入，不 sleep、不起真实定时器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { startRuntime } from '../../src/app/runtime.ts';
import type { Runtime } from '../../src/app/runtime.ts';
import { openDb, SchemaTooNewError } from '../../src/app/store.ts';
import type { Event, Mandate, Report } from '../../src/core/model.ts';

const MANDATE: Mandate = {
  policyVersion: 'policy-1',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['k-test'],
};

/** 允许一切的 Gate（规格 1/2/4/5 只关心仓储与 pass 循环）。 */
function allowGate() {
  return { check: (): { allowed: true; mandate: Mandate } => ({ allowed: true, mandate: MANDATE }) };
}

function tmpDb(): string {
  return `/tmp/runtime-test-${randomUUID()}.db`;
}

/** 删库文件及其 WAL/SHM 伴生文件。 */
function removeDb(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      unlinkSync(`${file}${suffix}`);
    } catch {
      /* 不存在就算了 */
    }
  }
}

function makeEvent(id: string, externalId: string, at = 1_000): Event {
  return {
    id,
    source: 'goal-tree',
    externalId,
    at,
    actor: 'agent',
    text: `事件 ${id}`,
    threadKey: 'thread-1',
    channel: 'goal-tree',
  };
}

/** 独立连接读原始行——只看仓储公开面验不出 disposition，得看库。 */
function readRow<T>(file: string, sql: string, param: string): T | undefined {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).get(param) as T | undefined;
  } finally {
    db.close();
  }
}

function countRows(file: string, table: 'event' | 'ticket'): number {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 1. R12：pass 停掉 = 积压，不是丢事件
// ---------------------------------------------------------------------------
test('1. R12：不调 tick 时事件停在 pending（积压），调 tick 后才建单', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  rt = startRuntime({ dbPath: file, gate: allowGate(), now: () => 10_000 });
  const e1 = makeEvent('e1', 'ext-1');
  rt.repo.events.put(e1);

  // pass 没跑：事件在库里、待处理；一张单都没有。
  assert.equal(rt.repo.events.pending(10).length, 1, '未 tick 时事件必须留在 pending（积压）');
  assert.equal(rt.repo.tickets.open().length, 0, '未 tick 时不得建单');

  const result = await rt.tick();

  assert.equal(result.events, 1, '本轮应消费 1 条事件');
  assert.equal(rt.repo.events.pending(10).length, 0, 'tick 后该事件不再 pending');
  assert.equal(rt.repo.tickets.open().length, 1, 'tick 后应建出 1 张开放单');
  assert.equal(rt.repo.tickets.open()[0].mandate.scope, MANDATE.scope, '建单要带上 Gate 给的 mandate');
});

// ---------------------------------------------------------------------------
// 2. 消费即处置：disposition 落库，重复 tick 不重复建单
// ---------------------------------------------------------------------------
test('2. 消费即处置：tick 后 disposition 不再是 new，重复 tick 不重复建单', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  rt = startRuntime({ dbPath: file, gate: allowGate(), now: () => 20_000 });
  const e1 = makeEvent('e1', 'ext-1');
  rt.repo.events.put(e1);

  await rt.tick();

  const row = readRow<{ disposition: string }>(file, 'SELECT disposition FROM event WHERE id = ?', e1.id);
  assert.notEqual(row?.disposition, 'new', '消费后 disposition 必须被处置掉');
  assert.equal(row?.disposition, 'accepted', 'Gate 放行的事件应处置为 accepted');
  assert.equal(rt.repo.events.pending(10).length, 0, '已处置的事件不得再出现在 pending');

  // 重复 tick：没有待处理事件，不得再建单。
  const again = await rt.tick();
  assert.equal(again.events, 0, '第二轮没有可消费事件');
  assert.equal(rt.repo.tickets.open().length, 1, '重复 tick 不得重复建单');
});

// ---------------------------------------------------------------------------
// 3. atomic 真回滚：Gate 抛错 → intake 抛错且库里零残留
// ---------------------------------------------------------------------------
test('3. atomic 真回滚：gate.check 抛错时 intake 抛错，event/ticket 各 0 行', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  let calls = 0;
  const boomGate = {
    check: (): { allowed: true; mandate: Mandate } => {
      calls += 1;
      throw new Error('gate exploded');
    },
  };

  rt = startRuntime({ dbPath: file, gate: boomGate, now: () => 30_000 });
  const e = makeEvent('e-boom', 'ext-boom');

  assert.throws(() => rt!.engine.intake(e), /gate exploded/, 'Gate 抛错必须穿透 intake');

  assert.equal(calls, 1, 'Gate 必须真的被调用一次');
  // 关键：必须走 runtime 自己的那条连接读——另开一条连接读不到未提交的行，
  // 会把"BEGIN 了但没 ROLLBACK"误判成回滚成功（同一连接才看得见残留）。
  assert.equal(rt.repo.events.byExternalId(e.externalId), undefined, '回滚后 event 不得留在库里');
  assert.equal(rt.repo.events.pending(10).length, 0, '回滚后 pending 必须为空');
  assert.equal(rt.repo.tickets.open().length, 0, '回滚后 ticket 表必须是 0 行');
  // 交叉验证：提交/回滚之后，另一条连接看到的也应是 0 行。
  assert.equal(countRows(file, 'event'), 0, '回滚后 event 表必须是 0 行（落盘视角）');
  assert.equal(countRows(file, 'ticket'), 0, '回滚后 ticket 表必须是 0 行（落盘视角）');

  // 回滚没有把连接/事务搞坏：同一条事件随后仍能正常入库建单。
  rt.close();
  rt = undefined;

  const good = startRuntime({ dbPath: file, gate: allowGate(), now: () => 30_000 });
  rt = good;
  good.repo.events.put(e);
  await good.tick();
  assert.equal(good.repo.tickets.open().length, 1, '回滚后连接仍可用，正常路径应建单');
});

// ---------------------------------------------------------------------------
// 4. 效果队列往返：enqueue → claimDue → settle → claimDue
// ---------------------------------------------------------------------------
test('4. 效果队列：enqueue 后 claimDue 取到，settle 后不再取到', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  rt = startRuntime({ dbPath: file, gate: allowGate(), now: () => 40_000 });
  rt.repo.effects.enqueue({ kind: 'launch', key: 'k1', payload: '{}', dueAt: 0 });

  const claimed = rt.repo.effects.claimDue(0);
  assert.equal(claimed.length, 1, '到期的 launch 应被 claim 到 1 条');
  assert.equal(claimed[0].kind, 'launch', '取回的行 kind 应为 launch');
  assert.equal(claimed[0].key, 'k1', '取回的行 key 应为 k1');

  rt.repo.effects.settle(claimed[0].id);
  assert.equal(rt.repo.effects.claimDue(0).length, 0, 'settle 后该行必须已不在队列里');
});

// ---------------------------------------------------------------------------
// 5. 报告往返：latest 取同一 ticket 的最后一条，不串号
// ---------------------------------------------------------------------------
test('5. 报告往返：latest 返回最后 append 的一条，其它 ticket 查不到', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  rt = startRuntime({ dbPath: file, gate: allowGate(), now: () => 50_000 });

  const r1: Report = { id: 'r1', ticketId: 'ticket-A', assignmentId: 'a1', kind: 'progress', at: 1 };
  const r2: Report = { id: 'r2', ticketId: 'ticket-A', assignmentId: 'a1', kind: 'ready', at: 2 };
  rt.repo.reports.append(r1);
  rt.repo.reports.append(r2);

  assert.deepEqual(rt.repo.reports.latest('ticket-A'), r2, 'latest 必须返回最后 append 的那条');
  assert.equal(rt.repo.reports.latest('ticket-B'), undefined, '换一个 ticketId 应查不到');
});

// ---------------------------------------------------------------------------
// 6. 库版本守卫接在组合根上：user_version 比代码新 → startRuntime 抛 SchemaTooNewError
// ---------------------------------------------------------------------------
test('6. 版本守卫：库里 user_version=99 时 startRuntime 抛 SchemaTooNewError', async (t) => {
  const file = tmpDb();
  let rt: Runtime | undefined;
  t.after(() => {
    rt?.close();
    removeDb(file);
  });

  const db = openDb(file);
  db.exec('PRAGMA user_version = 99');
  db.close();

  assert.throws(
    () => {
      rt = startRuntime({ dbPath: file, gate: allowGate() });
    },
    (e: unknown) => e instanceof SchemaTooNewError,
    '组合根必须经过 openDb 的版本守卫并原样抛出 SchemaTooNewError',
  );
  assert.equal(rt, undefined, '守卫抛错时不得返回一个可用的 runtime');
});
