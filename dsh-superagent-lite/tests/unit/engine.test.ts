/**
 * tests/unit/engine.test.ts —— Engine 三条命令路径（intake / report / close）的规格测试。
 * 规格来源：详设 §6 第 2–9 步 + R01 / R04 / R05 / R08 / P6，不是从实现反推。
 * 内存假仓储手写实现 Repository（无 mock 框架、无第三方依赖）；now / nextId 注入确定性实现。
 * 只读公开面：intake / report / close / stageOfTicket，不碰 Engine 私有字段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../../src/core/engine.ts';
import type { EffectRow, Event, Mandate, NewEffect, Report, Ticket } from '../../src/core/model.ts';
import type { Repository } from '../../src/core/ports.ts';

// ---------------------------------------------------------------------------
// 内存假仓储：四张表 + 事务计数 + 可回滚的 atomic
// ---------------------------------------------------------------------------

interface FakeRepo extends Repository {
  /** atomic 被调用次数（含抛错的那次）。 */
  atomicCalls: number;
  /** 当前嵌套深度；gate 在事务里被调用时应 >= 1。 */
  atomicDepth: number;
  eventRows: Event[];
  ticketRows: Map<string, Ticket>;
  reportRows: Report[];
  effectRows: NewEffect[];
  settleCalls: string[];
  failCalls: Array<{ id: string; error: string }>;
}

/** 事务快照/回滚：真实仓储语义（抛错即全回滚），不是"写一半留在内存里"。 */
function makeRepo(): FakeRepo {
  const repo: FakeRepo = {
    atomicCalls: 0,
    atomicDepth: 0,
    eventRows: [],
    ticketRows: new Map<string, Ticket>(),
    reportRows: [],
    effectRows: [],
    settleCalls: [],
    failCalls: [],

    atomic<T>(f: () => T): T {
      repo.atomicCalls += 1;
      const snap = {
        events: [...repo.eventRows],
        tickets: new Map(repo.ticketRows),
        reports: [...repo.reportRows],
        effects: repo.effectRows.map((e) => ({ ...e })),
      };
      repo.atomicDepth += 1;
      try {
        return f();
      } catch (err) {
        repo.eventRows = snap.events;
        repo.ticketRows = snap.tickets;
        repo.reportRows = snap.reports;
        repo.effectRows = snap.effects;
        throw err;
      } finally {
        repo.atomicDepth -= 1;
      }
    },

    events: {
      put(e: Event): void {
        repo.eventRows.push(e);
      },
      byExternalId(id: string): Event | undefined {
        return repo.eventRows.find((e) => e.externalId === id);
      },
    },

    tickets: {
      put(t: Ticket): void {
        repo.ticketRows.set(t.id, t);
      },
      get(id: string): Ticket | undefined {
        return repo.ticketRows.get(id);
      },
      open(): Ticket[] {
        return [...repo.ticketRows.values()].filter((t) => t.state === 'open');
      },
    },

    reports: {
      append(r: Report): void {
        repo.reportRows.push(r);
      },
      latest(ticketId: string): Report | undefined {
        const hits = repo.reportRows.filter((r) => r.ticketId === ticketId);
        return hits.length === 0 ? undefined : hits[hits.length - 1];
      },
    },

    effects: {
      enqueue(e: NewEffect): void {
        repo.effectRows.push(e);
      },
      /** 供断言：返回全部到期（dueAt <= now）的待执行行。 */
      claimDue(now: number): EffectRow[] {
        return repo.effectRows
          .map((e, i) => ({ row: e, i }))
          .filter(({ row }) => row.dueAt <= now)
          .map(({ row, i }) => ({
            id: `fx${i + 1}`,
            kind: row.kind,
            key: row.key,
            payload: row.payload,
            attempts: 0,
            nextAt: row.dueAt,
            state: 'pending' as const,
          }));
      },
      settle(id: string): void {
        repo.settleCalls.push(id);
      },
      fail(id: string, error: string): void {
        repo.failCalls.push({ id, error });
      },
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// 夹具：确定性 now / nextId、固定 mandate、两种 Gate
// ---------------------------------------------------------------------------

const MANDATE: Mandate = {
  policyVersion: 'pv-2026-11',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['rule:auto-low-risk', 'scope:repo'],
};

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: 'evt-ext-1',
    source: 'node',
    externalId: 'node:42:rev1',
    at: 1_000,
    actor: 'human:alice',
    text: '实现 K03 的 intake',
    threadKey: 'th:42',
    channel: 'gui',
    ...overrides,
  };
}

function makeReport(t: Ticket, overrides: Partial<Report> = {}): Report {
  return { id: 'r1', ticketId: t.id, assignmentId: 'a1', kind: 'ready', at: 2_000, ...overrides };
}

function allowGate(): Repository extends never ? never : { check(): { allowed: true; mandate: Mandate } } {
  return { check: () => ({ allowed: true, mandate: MANDATE }) };
}

function denyGate(reason: string) {
  return { check: () => ({ allowed: false as const, reason }) };
}

/** 引擎工厂：id 与时钟各自递增，绝不读真实时间。 */
function makeEngine(repo: Repository, gate: { check(c: unknown): unknown } = allowGate()) {
  let idSeq = 0;
  let tick = 0;
  const engine = new Engine({
    repo,
    gate: gate as never,
    now: () => 1_700_000_000_000 + tick++,
    nextId: () => `t${++idSeq}`,
  });
  return engine;
}

/** 已接受事件的 ticket（从仓储回读取，不用返回值做断言源）。 */
function intakeOne(engine: Engine, repo: FakeRepo, overrides: Partial<Event> = {}): Ticket {
  const out = engine.intake(makeEvent(overrides));
  assert.equal(out.disposition, 'new', '前置：intake 应接受');
  const t = out.ticket === undefined ? undefined : repo.tickets.get(out.ticket.id);
  assert.ok(t, '前置：ticket 应已落库');
  return t;
}

function effectsOfKind(repo: FakeRepo, kind: string): NewEffect[] {
  return repo.effectRows.filter((e) => String(e.kind) === kind);
}

// ---------------------------------------------------------------------------
// 规格 1：R01 幂等（T01）
// ---------------------------------------------------------------------------

test('R01 同一 external_id 两次 intake 只产 1 个 ticket / 1 条 launch', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const e = makeEvent();

  const first = engine.intake(e);
  assert.equal(first.disposition, 'new');
  assert.equal(repo.ticketRows.size, 1);
  assert.equal(effectsOfKind(repo, 'launch').length, 1, '第一次应入队恰 1 条 launch');

  const second = engine.intake(e);
  assert.equal(second.disposition, 'duplicate');
  assert.equal(second.ticket, undefined, 'duplicate 不应再产出 ticket');

  assert.equal(repo.eventRows.length, 1, 'events 仍应 1 条');
  assert.equal(repo.ticketRows.size, 1, 'tickets 仍应 1 个');
  assert.equal(repo.effectRows.length, 1, 'effects 仍应 1 条（不重放 launch）');
});

// ---------------------------------------------------------------------------
// 规格 2：Gate 拒收
// ---------------------------------------------------------------------------

test('Gate 拒收 no-rule：rejected + 无 ticket / 无 launch，但 event 落库占住幂等键', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo, denyGate('no-rule'));

  const out = engine.intake(makeEvent());

  assert.equal(out.disposition, 'rejected');
  assert.equal(out.reason, 'no-rule');
  assert.equal(repo.ticketRows.size, 0, '拒收不产生 ticket');
  assert.equal(effectsOfKind(repo, 'launch').length, 0, '拒收不产生 launch effect');
  assert.equal(repo.effectRows.length, 0, '拒收不产生任何 effect');
  assert.ok(
    repo.events.byExternalId('node:42:rev1') !== undefined,
    'event 必须落库（幂等键要占住）',
  );
});

// ---------------------------------------------------------------------------
// 规格 3：R04 mandate 留档
// ---------------------------------------------------------------------------

test('R04 接受时 mandate 可从 ticket 读回，close 之后仍可读回', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);

  const before = repo.tickets.get(t.id);
  assert.ok(before, '前置：ticket 已落库');
  assert.equal(before.mandate.policyVersion, 'pv-2026-11');
  assert.deepEqual(before.mandate.basis, ['rule:auto-low-risk', 'scope:repo']);

  engine.close(before);

  const after = repo.tickets.get(t.id);
  assert.ok(after, 'close 之后 ticket 仍可读');
  assert.equal(after.mandate.policyVersion, 'pv-2026-11', 'close 后 policyVersion 仍可读回');
  assert.deepEqual(
    after.mandate.basis,
    ['rule:auto-low-risk', 'scope:repo'],
    'close 后 basis 仍可读回',
  );
  assert.equal(after.mandate.scope, 'repo:write');
});

// ---------------------------------------------------------------------------
// 规格 4：R05 stage 由 stageOf 派生（断言只走 stageOfTicket）
// ---------------------------------------------------------------------------

test('R05 report(ready) 后 stageOfTicket = person/review', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);

  const out = engine.report(t, makeReport(t, { kind: 'ready' }));

  assert.equal(out.stage, 'person/review');
  const reread = repo.tickets.get(t.id);
  assert.ok(reread);
  assert.equal(engine.stageOfTicket(reread), 'person/review');
});

test('R05 report(blocked) 且 humanRepliedSinceReport 为假 → stageOfTicket = person/blocked', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);
  // humanRepliedSinceReport 缺省即"未回话"，显式写出来让前提可见。
  repo.tickets.put({ ...t, humanRepliedSinceReport: false });

  engine.report(repo.tickets.get(t.id) as Ticket, makeReport(t, { kind: 'blocked' }));

  const reread = repo.tickets.get(t.id);
  assert.ok(reread);
  assert.equal(reread.humanRepliedSinceReport, false);
  assert.equal(engine.stageOfTicket(reread), 'person/blocked');
});

test('R05 report(waiting) 且 assignment = running → stageOfTicket = idle', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);
  repo.tickets.put({ ...t, assignment: { id: 'a1', ticketId: t.id, state: 'running', dir: '/tmp/a1', sessionId: 's1' } });

  engine.report(repo.tickets.get(t.id) as Ticket, makeReport(t, { kind: 'waiting' }));

  const reread = repo.tickets.get(t.id);
  assert.ok(reread);
  assert.equal(reread.assignment?.state, 'running', '前置：assignment 仍是 running');
  assert.equal(engine.stageOfTicket(reread), 'idle');
});

// ---------------------------------------------------------------------------
// 规格 5：ready → relay 入队（P6 前置）
// ---------------------------------------------------------------------------

test('P6 report(ready) 返回 relayKey = ticketId:reportId 且入队同 key 的 relay', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);
  const r = makeReport(t, { kind: 'ready', id: 'r-42' });

  const out = engine.report(t, r);

  assert.equal(out.relayKey, `${t.id}:r-42`, 'relayKey 形如 <ticketId>:<reportId>');
  const relays = effectsOfKind(repo, 'relay');
  assert.equal(relays.length, 1, '应恰有 1 条 relay effect');
  assert.equal(relays[0].key, out.relayKey, 'relay effect 的 key 与返回值一致');

  // 非 ready 报告不入队 relay。
  const repo2 = makeRepo();
  const engine2 = makeEngine(repo2);
  const t2 = intakeOne(engine2, repo2);
  const out2 = engine2.report(t2, makeReport(t2, { kind: 'progress', id: 'r-9' }));
  assert.equal(out2.relayKey, undefined, 'progress 不产生 relayKey');
  assert.equal(effectsOfKind(repo2, 'relay').length, 0);
});

// ---------------------------------------------------------------------------
// 规格 6：close（第 9 步）
// ---------------------------------------------------------------------------

test('第9步 close：state=ended，入队 kaaDone + treeWrite 各 1 条，effectKeys 与之一致', () => {
  const repo = makeRepo();
  const engine = makeEngine(repo);
  const t = intakeOne(engine, repo);

  const out = engine.close(t);

  const ended = repo.tickets.get(t.id);
  assert.ok(ended);
  assert.equal(ended.state, 'ended');

  const kaa = effectsOfKind(repo, 'kaaDone');
  const tree = effectsOfKind(repo, 'treeWrite');
  assert.equal(kaa.length, 1, 'kaaDone 恰 1 条');
  assert.equal(tree.length, 1, 'treeWrite 恰 1 条');

  const expected = [kaa[0].key, tree[0].key];
  assert.deepEqual(
    [...out.effectKeys].sort(),
    [...expected].sort(),
    '返回的 effectKeys 必须就是这两条 effect 的 key',
  );
});

// ---------------------------------------------------------------------------
// 规格 7：事务纪律
// ---------------------------------------------------------------------------

test('事务纪律：intake 通过 repo.atomic 写入（gate 也在事务内被调用）', () => {
  const repo = makeRepo();
  let depthAtCheck = -1;
  const spyGate = {
    check: () => {
      depthAtCheck = repo.atomicDepth;
      return { allowed: true as const, mandate: MANDATE };
    },
  };
  const engine = makeEngine(repo, spyGate);

  engine.intake(makeEvent());

  assert.ok(repo.atomicCalls >= 1, 'atomic 必须被调用');
  assert.equal(depthAtCheck, 1, 'gate.check 应在事务内被调用');
});

test('事务纪律：gate 抛错时 intake 抛错，且不留下半成品 ticket / effect', () => {
  const repo = makeRepo();
  let depthAtCheck = -1;
  const boomGate = {
    check: () => {
      depthAtCheck = repo.atomicDepth;
      throw new Error('gate boom');
    },
  };
  const engine = makeEngine(repo, boomGate);

  assert.throws(() => engine.intake(makeEvent()), /gate boom/);

  assert.equal(depthAtCheck, 1, '失败路径的 gate 也在事务里');
  assert.equal(repo.ticketRows.size, 0, '抛错后不得留下 ticket');
  assert.equal(repo.effectRows.length, 0, '抛错后不得留下 effect');
  assert.equal(repo.atomicCalls, 1, '失败路径确实走了 atomic');
});
