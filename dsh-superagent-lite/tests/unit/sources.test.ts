/**
 * tests/unit/sources.test.ts —— 两个触发源（goal-tree / manual）的规格测试。
 * 规格来源：R01 / R07 与详设 §6 第 1–2 步，不是从实现反推。
 * 只读公开面：readyLeaves / toEvents / GoalTreeSource / manualEvent / ManualSource。
 * fetchTree 一律注入桩函数；不睡眠、不发网络、不读真实时钟。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readyLeaves, toEvents, GoalTreeSource } from '../../src/sources/goal-tree.ts';
import type { GoalNode, TreeResponse } from '../../src/sources/goal-tree.ts';
import { manualEvent, ManualSource } from '../../src/sources/manual.ts';
import { Engine } from '../../src/core/engine.ts';
import type { EffectRow, Event, Mandate, NewEffect, Report, Ticket } from '../../src/core/model.ts';
import type { Repository } from '../../src/core/ports.ts';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function mkNode(id: string, status: GoalNode['status'], extra: Partial<GoalNode> = {}): GoalNode {
  return { id, title: `task ${id}`, status, ...extra };
}

const MANDATE: Mandate = {
  policyVersion: 'pv-2026-11',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['rule:auto-low-risk'],
};

/** 内存假仓储：字段与 `src/core/ports.ts` 的 Repository 对齐；只实现本测试用到的语义。 */
interface FakeRepo extends Repository {
  eventRows: Event[];
  ticketRows: Map<string, Ticket>;
  reportRows: Report[];
  effectRows: NewEffect[];
}

function makeRepo(): FakeRepo {
  const repo: FakeRepo = {
    eventRows: [],
    ticketRows: new Map<string, Ticket>(),
    reportRows: [],
    effectRows: [],

    atomic<T>(f: () => T): T {
      return f();
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
      claimDue(): EffectRow[] {
        return [];
      },
      settle(): void {},
      retry(): void {},
      fail(): void {},
      recoverRunning(): number {
        return 0;
      },
    },
  };
  return repo;
}

function allowGate() {
  return { check: () => ({ allowed: true as const, mandate: MANDATE }) };
}

/** 引擎：now / nextId 全确定性，不读真实时间。 */
function makeEngine(repo: Repository) {
  let idSeq = 0;
  let tick = 0;
  return new Engine({
    repo,
    gate: allowGate(),
    now: () => 1_700_000_000_000 + tick++,
    nextId: () => `t${++idSeq}`,
  });
}

function idsOf(nodes: readonly GoalNode[]): string[] {
  return nodes.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// 规格 1：ready 叶子判定
// ---------------------------------------------------------------------------

test('规格1 readyLeaves 只返回「pending 且无孩子且依赖全 done」的节点', () => {
  const tree: TreeResponse = {
    revision: 7,
    nodes: [
      mkNode('dep-done', 'done'),
      mkNode('leaf-ready', 'pending', { dependsOn: ['dep-done'] }),
      mkNode('leaf-blocked', 'pending', { dependsOn: ['still-pending'] }),
      mkNode('still-pending', 'pending'),
      mkNode('has-child', 'pending'),
      mkNode('child', 'pending', { parentId: 'has-child' }),
      mkNode('done-leaf', 'done'),
    ],
  };

  const got = readyLeaves(tree);
  const ids = idsOf(got);

  assert.ok(ids.includes('leaf-ready'), 'pending 叶子且依赖全 done 必须返回');
  assert.ok(!ids.includes('leaf-blocked'), '依赖未完成的 pending 叶子不得返回');
  assert.ok(!ids.includes('has-child'), '有孩子的 pending 节点不是叶子，不得返回');
  assert.ok(!ids.includes('done-leaf'), 'done 叶子不得返回');

  assert.deepEqual(
    [...new Set(ids)].sort(),
    ['child', 'leaf-ready', 'still-pending'],
    '返回的 id 集合必须恰好是这三个合格叶子',
  );
  assert.equal(ids.length, 3, '不得重复返回同一节点');
});

// ---------------------------------------------------------------------------
// 规格 2：每轮上限
// ---------------------------------------------------------------------------

test('规格2 readyLeaves(tree, 2) 最多 2 个，且顺序取前两个', () => {
  const tree: TreeResponse = {
    revision: 1,
    nodes: [
      mkNode('l1', 'pending'),
      mkNode('l2', 'pending'),
      mkNode('l3', 'pending'),
      mkNode('l4', 'pending'),
      mkNode('l5', 'pending'),
    ],
  };

  assert.equal(readyLeaves(tree).length, 5, '前置：5 个叶子全部合格');
  const capped = readyLeaves(tree, 2);

  assert.equal(capped.length, 2, '上限 2 时最多返回 2 个');
  assert.deepEqual(idsOf(capped), ['l1', 'l2'], '按节点顺序取前两个');
});

// ---------------------------------------------------------------------------
// 规格 3：幂等键格式（R01 的核心）
// ---------------------------------------------------------------------------

test('规格3 toEvents 的 externalId = node:<id>:<revision>，且同 revision 两次调用完全相等', () => {
  const tree: TreeResponse = {
    revision: 42,
    nodes: [mkNode('n1', 'pending'), mkNode('n2', 'pending')],
  };

  const events = toEvents(tree, 1_000);
  assert.equal(events.length, 2, '前置：两个 ready 叶子 → 两条 event');

  for (const e of events) {
    const id = e.externalId.split(':')[1];
    assert.equal(e.externalId, `node:${id}:42`, `externalId 必须形如 node:<id>:42，实际 ${e.externalId}`);
  }
  assert.deepEqual(
    events.map((e) => e.externalId),
    ['node:n1:42', 'node:n2:42'],
    '两条 event 的 externalId 逐条对应节点与 revision',
  );

  // 同一棵树（revision 相同）、不同 now：幂等键必须完全一致 —— 这是「同一 revision
  // 轮询两次只产生 1 个 event」的前提。
  const later = toEvents(tree, 9_999_999);
  assert.deepEqual(
    later.map((e) => e.externalId),
    events.map((e) => e.externalId),
    'now 不同但 revision 相同时，externalId 列表必须完全相等',
  );
});

// ---------------------------------------------------------------------------
// 规格 4：端到端幂等（toEvents → Engine.intake 两次）
// ---------------------------------------------------------------------------

test('规格4 同一 event 投递 Engine.intake 两次：new → duplicate，events 1 行、tickets 1 个', () => {
  const tree: TreeResponse = { revision: 1, nodes: [mkNode('x', 'pending')] };
  const [event] = toEvents(tree, 1_000);
  assert.ok(event, '前置：应产出 1 条 event');

  const repo = makeRepo();
  const engine = makeEngine(repo);

  const first = engine.intake(event);
  assert.equal(first.disposition, 'new', '第一次投递应为 new');

  const second = engine.intake(event);
  assert.equal(second.disposition, 'duplicate', '第二次投递应为 duplicate');
  assert.equal(second.ticket, undefined, 'duplicate 不应再建 ticket');

  assert.equal(repo.eventRows.length, 1, 'events 表只应有 1 行');
  assert.equal(repo.ticketRows.size, 1, 'tickets 只应有 1 个');
});

// ---------------------------------------------------------------------------
// 规格 5：扇出键（R07）
// ---------------------------------------------------------------------------

test('规格5 两个 ready 叶子 → threadKey 分别为 node:<id1> / node:<id2> 且互不相同', () => {
  const tree: TreeResponse = {
    revision: 3,
    nodes: [mkNode('alpha', 'pending'), mkNode('beta', 'pending')],
  };

  const events = toEvents(tree, 1_000);
  assert.equal(events.length, 2, '前置：两条 event');

  assert.deepEqual(
    events.map((e) => e.threadKey),
    ['node:alpha', 'node:beta'],
    'threadKey 必须逐节点独立（扇出到各自订阅者）',
  );
  assert.notEqual(events[0].threadKey, events[1].threadKey, '两条 event 的 threadKey 不得相同');
});

// ---------------------------------------------------------------------------
// 规格 6：轮询间隔写死（不到间隔不 fetch）
// ---------------------------------------------------------------------------

test('规格6 GoalTreeSource(intervalMs=30000)：poll 未到间隔返回 [] 且不再 fetch', async () => {
  const tree: TreeResponse = { revision: 1, nodes: [mkNode('x', 'pending')] };
  let fetchCalls = 0;
  const fetchTree = async (): Promise<TreeResponse> => {
    fetchCalls += 1;
    return tree;
  };

  const source = new GoalTreeSource(fetchTree, { intervalMs: 30_000 });
  assert.equal(source.interval, 30_000, '间隔取自构造参数');
  assert.equal(fetchCalls, 0, '构造时不得 fetch');

  const atZero = await source.poll(0);
  assert.equal(atZero.length, 1, 'poll(0) 到了间隔，应 fetch 并翻译出 1 条');
  assert.equal(fetchCalls, 1, 'poll(0) 调一次 fetch');

  const early = await source.poll(1_000);
  assert.deepEqual(early, [], 'poll(1000) 未到 30000，应返回空数组');
  assert.equal(fetchCalls, 1, '未到间隔时 fetch 仍只被调用 1 次');

  const atInterval = await source.poll(30_000);
  assert.equal(atInterval.length, 1, 'poll(30000) 到了间隔，应再产出 1 条');
  assert.equal(fetchCalls, 2, 'poll(30000) 后累计 fetch 2 次');
});

// ---------------------------------------------------------------------------
// 规格 7：manual
// ---------------------------------------------------------------------------

test('规格7 manualEvent：externalId=manual:m1、source=manual；空 id 抛错', () => {
  const e = manualEvent({ id: 'm1', text: 'x' }, 100);

  assert.equal(e.externalId, 'manual:m1', '幂等键形如 manual:<id>');
  assert.equal(e.source, 'manual', 'source 固定为 manual');
  assert.equal(e.at, 100, 'at 取注入的 now');

  assert.throws(
    () => manualEvent({ id: '', text: 'x' }, 100),
    /不能为空/,
    '空 id 必须抛错（它是幂等键）',
  );
});

test('规格7 ManualSource：推 2 条后 poll 返回 2 条，再 poll 返回 0 条（取空语义）', () => {
  const source = new ManualSource();
  source.push({ id: 'm1', text: 'a' });
  source.push({ id: 'm2', text: 'b' });

  const first = source.poll(100);
  assert.equal(first.length, 2, '第一次 poll 取走 2 条');
  assert.deepEqual(
    first.map((e) => e.externalId),
    ['manual:m1', 'manual:m2'],
    '按入队顺序翻译，幂等键逐条对应',
  );
  assert.equal(source.size, 0, '取走后队列为空');

  const second = source.poll(200);
  assert.deepEqual(second, [], '重复 poll 不得重放');
});
