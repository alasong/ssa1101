/**
 * tests/unit/executor.test.ts —— 执行器适配层的单元测试（R06 / R10）。
 *
 * 规格来源是条文，不是实现：
 *  - T06（R06）：一 ticket 一会话一目录 —— 两个 ticket 的 dir / sessionId 必须互不相同。
 *  - R10：工作槽位有上限（满了抛 `Later`，不是普通失败）；人的消息走额外槽，满槽也能投；
 *          槽位只在 stop 时释放。
 *  - 详设 §6 第 6 步：先建目录（`${workRoot}/${ticketId}-${assignmentId}`，assignment 自带 dir 则用它），
 *    再建会话投首条消息。
 *  - preset 默认 `superagent-worker`，可由 deps 覆盖。
 *
 * 全部用假 `SessionFactory` + 注入 `mkdirp`：不 sleep、不碰网络、不真建目录。
 * 断言按条文写；实现不符就如实判红，不放宽。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SlotPool, SessionExecutor } from '../../src/app/executor.ts';
import type { SessionFactory, SessionHandle } from '../../src/app/executor.ts';
import { Later } from '../../src/app/effects.ts';
import type { Assignment, Ticket } from '../../src/core/model.ts';

const MANDATE = {
  policyVersion: 'policy-1',
  scope: 'repo:write',
  strength: 'auto' as const,
  basis: ['k-test'],
};

function makeTicket(id: string, threadKey = `thread-${id}`): Ticket {
  return { id, threadKey, mandate: MANDATE, createdAt: 1_000, state: 'open' };
}

function makeAssignment(id: string, ticketId: string, dir = ''): Assignment {
  return { id, ticketId, state: 'pending', dir, sessionId: '' };
}

interface StartCall {
  ticketId: string;
  agentPreset: string;
  dir: string;
  firstMessage: string;
}

interface DeliverCall {
  sessionId: string;
  text: string;
}

interface StopCall {
  sessionId: string;
  reason: string;
}

/**
 * 假 factory：记录每次 start 的入参，返回**唯一** sessionId；
 * deliver / stop 也留痕，供「真的调到了会话」的断言使用。
 */
function makeFactory() {
  const starts: StartCall[] = [];
  const delivers: DeliverCall[] = [];
  const stops: StopCall[] = [];
  let seq = 0;

  const factory: SessionFactory = {
    async start(o): Promise<SessionHandle> {
      starts.push({ ...o });
      seq += 1;
      return { sessionId: `sess-${seq}`, dir: o.dir };
    },
    async deliver(sessionId: string, text: string): Promise<void> {
      delivers.push({ sessionId, text });
    },
    async stop(sessionId: string, reason: string): Promise<void> {
      stops.push({ sessionId, reason });
    },
  };

  return { factory, starts, delivers, stops };
}

/** 记录型 mkdirp：只收路径，不落盘。 */
function makeMkdirRecorder() {
  const dirs: string[] = [];
  const mkdirp = async (dir: string): Promise<void> => {
    dirs.push(dir);
  };
  return { dirs, mkdirp };
}

/** 断言 fn 抛的是 `Later`（不是普通 Error、不是静默成功）。 */
async function expectLater(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (e) {
    const err = e as Error;
    assert.ok(err instanceof Error, '抛出的必须是 Error 实例');
    assert.equal(err.name, 'Later', `必须抛 Later（调用方据此重试），实际 name=${err.name}`);
    return err;
  }
  assert.fail('期望抛 Later，实际静默成功');
}

/** 构造一个只注入桩的执行器，避免每个用例重复。 */
function makeExecutor(opts: {
  slots?: SlotPool;
  workRoot?: string;
  agentPreset?: string;
}) {
  const fake = makeFactory();
  const mk = makeMkdirRecorder();
  const executor = new SessionExecutor({
    slots: opts.slots ?? new SlotPool({ capacity: 2, humanExtra: 1 }),
    factory: fake.factory,
    workRoot: opts.workRoot ?? '/ws',
    ...(opts.agentPreset === undefined ? {} : { agentPreset: opts.agentPreset }),
    mkdirp: mk.mkdirp,
  });
  return { executor, ...fake, ...mk };
}

// ── 规格 1：T06 隔离 ────────────────────────────────────────────────
test('规格 1 / T06 隔离：两个 ticket 各 start 一次 → dir 与 sessionId 互不相同', async () => {
  const { executor, starts } = makeExecutor({ slots: new SlotPool({ capacity: 2, humanExtra: 1 }) });

  const t1 = makeTicket('t1');
  const t2 = makeTicket('t2');
  const r1 = await executor.start(t1, makeAssignment('a1', 't1'));
  const r2 = await executor.start(t2, makeAssignment('a2', 't2'));

  assert.notEqual(r1.dir, r2.dir, '两个 ticket 的目录必须不同（否则会话互相污染）');
  assert.notEqual(r1.sessionId, r2.sessionId, '两个 ticket 的会话 id 必须不同（不能复用会话）');

  assert.equal(starts.length, 2, 'factory.start 必须各调一次');
  assert.notEqual(starts[0].ticketId, starts[1].ticketId, 'factory 收到的 ticketId 必须不同');
  assert.equal(new Set(starts.map((s) => s.ticketId)).size, 2);
});

// ── 规格 2：槽位上限 ────────────────────────────────────────────────
test('规格 2 / 槽位上限：capacity=1 时第二个 start 抛 Later，且不建会话', async () => {
  const { executor, starts } = makeExecutor({ slots: new SlotPool({ capacity: 1, humanExtra: 1 }) });

  const t = makeTicket('t1');
  const r1 = await executor.start(t, makeAssignment('a1', 't1'));
  assert.equal(r1.state, 'running', '第一个 start 必须成功');
  assert.equal(starts.length, 1);

  const err = await expectLater(() => executor.start(t, makeAssignment('a2', 't1')));
  assert.ok(err instanceof Later, '抛出的必须是 Later 类型');
  assert.equal(starts.length, 1, '满槽失败不得真的去建第二个会话（不能静默成功）');
  assert.equal(executor.live, 1, '满槽失败不得增加在跑会话数');
});

// ── 规格 3：人的消息优先（T10 判据面）─────────────────────────────
test('规格 3 / 人的消息优先：满槽状态下 deliver 仍投达，且带着该会话 id', async () => {
  const { executor, delivers } = makeExecutor({ slots: new SlotPool({ capacity: 1, humanExtra: 1 }) });

  const t = makeTicket('t1');
  const started = await executor.start(t, makeAssignment('a1', 't1'));
  // 此时工作槽已满（capacity=1）；人的消息必须走额外槽，不受工作槽限制。
  await assert.doesNotReject(() => executor.deliver(t, started, '人插话'));

  assert.equal(delivers.length, 1, 'factory.deliver 必须被调用一次');
  assert.equal(delivers[0].sessionId, started.sessionId, 'deliver 必须带上该会话的 sessionId');
  assert.equal(delivers[0].text, '人插话');
});

// ── 规格 4：槽位释放 ────────────────────────────────────────────────
test('规格 4 / 槽位释放：stop 之后新的 assignment 能 start，且 factory.stop 被调用', async () => {
  const { executor, starts, stops } = makeExecutor({ slots: new SlotPool({ capacity: 1, humanExtra: 1 }) });

  const t = makeTicket('t1');
  const a1 = await executor.start(t, makeAssignment('a1', 't1'));
  await executor.stop(t, a1, 'done');

  assert.equal(stops.length, 1, 'factory.stop 必须被调用过');
  assert.equal(stops[0].sessionId, a1.sessionId, 'stop 必须停的是那个会话');

  const a2 = await executor.start(t, makeAssignment('a2', 't1'));
  assert.equal(a2.state, 'running', 'stop 之后槽位必须真的释放，新 assignment 要能起来');
  assert.equal(starts.length, 2);
  assert.equal(executor.live, 1);
});

// ── 规格 5：建目录路径 ──────────────────────────────────────────────
test('规格 5a / 建目录路径：默认拼 `${workRoot}/${ticketId}-${assignmentId}`', async () => {
  const { executor, dirs } = makeExecutor({ workRoot: '/tmp/ws' });

  await executor.start(makeTicket('t1'), makeAssignment('a1', 't1'));

  assert.deepEqual(dirs, ['/tmp/ws/t1-a1'], '目录必须带 ticketId 与 assignmentId（否则两个 ticket 撞目录）');
});

test('规格 5b / 建目录路径：assignment 自带 dir 时直接用，不再拼接', async () => {
  const { executor, dirs } = makeExecutor({ workRoot: '/tmp/ws' });

  await executor.start(makeTicket('t1'), makeAssignment('a1', 't1', '/custom/given'));

  assert.deepEqual(dirs, ['/custom/given'], '自带 dir 必须原样使用，不再拼 workRoot/ticketId');
});

// ── 规格 6：preset 透传 ─────────────────────────────────────────────
test('规格 6a / preset 透传：不传 agentPreset 时默认 superagent-worker', async () => {
  const { executor, starts } = makeExecutor({});

  await executor.start(makeTicket('t1'), makeAssignment('a1', 't1'));

  assert.equal(starts[0].agentPreset, 'superagent-worker', '默认 preset 必须是 superagent-worker');
});

test('规格 6b / preset 透传：传 agentPreset 时原样透传给 factory', async () => {
  const { executor, starts } = makeExecutor({ agentPreset: 'x' });

  await executor.start(makeTicket('t1'), makeAssignment('a1', 't1'));

  assert.equal(starts[0].agentPreset, 'x', '配置的 preset 必须透传，不能硬编码');
});

// ── 规格 7：未起会话就 deliver ──────────────────────────────────────
test('规格 7 / 未起会话就 deliver → 抛 Later，且不投递', async () => {
  const { executor, delivers } = makeExecutor({});

  const t = makeTicket('t1');
  const a = makeAssignment('a1', 't1');

  const err = await expectLater(() => executor.deliver(t, a, '还没起来就插话'));
  assert.ok(err instanceof Later, '抛出的必须是 Later（调用方据此重试，不当致命错误）');
  assert.equal(delivers.length, 0, '没有会话时不得真的调用 factory.deliver');
});
