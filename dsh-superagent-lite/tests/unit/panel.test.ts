/**
 * tests/unit/panel.test.ts —— 面板数据视图：7 stage 全画 / 空态不占位（R15）/ 只列 person\* /
 * 分组 / 计数 / 纯函数。
 * 规格来源：设计 R15 与面板要求，不是从实现反推。断言一律纯字符串/结构比较。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupByStage, renderBoard, renderPanel, isPanelEmpty, panelCounts } from '../../src/panel/view.ts';
import { STAGES, PERSON_STAGES, type Stage, type Ticket } from '../../src/core/model.ts';

/** 自造 ticket：字段形状按任务给定，不依赖 src 里的任何夹具。 */
function ticket(id: string, stage?: Stage): Ticket {
  return {
    id,
    threadKey: `thread-${id}`,
    mandate: { policyVersion: 'v1', scope: 's', strength: 'auto', basis: [] },
    createdAt: 0,
    state: 'open',
    ...(stage === undefined ? {} : { stage }),
  };
}

/** 深冻结：冻结后任何写操作都抛（严格模式下），用来证明纯函数不修改输入。 */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const key of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[key]);
    }
    Object.freeze(v);
  }
  return v;
}

// ---------------------------------------------------------------- 规格 1
test('spec1 空数组：renderBoard 恰好 7 行，行序与 STAGES 一致且以 stage 名开头', () => {
  const board = renderBoard([]);
  const lines = board.split('\n');
  assert.equal(lines.length, 7, `期望 7 行，实际 ${lines.length} 行：${JSON.stringify(board)}`);
  STAGES.forEach((stage, i) => {
    assert.equal(
      lines[i].startsWith(stage),
      true,
      `第 ${i + 1} 行应以 ${stage} 开头，实际 ${JSON.stringify(lines[i])}`,
    );
  });
});

// ---------------------------------------------------------------- 规格 2
test('spec2 空态不占位：renderPanel([]) 为空串且 isPanelEmpty([]) 为 true', () => {
  assert.equal(renderPanel([]), '', '空数组时面板必须是空串（R15 零高度）');
  assert.equal(isPanelEmpty([]), true, '空数组时 isPanelEmpty 必须是 true');
});

test('spec2b 只有 working 类单子时面板仍为空串（人不需要处理的只能是空）', () => {
  const tickets = [
    ticket('t-working', 'working'),
    ticket('t-idle', 'idle'),
    ticket('t-queued', 'working/queued'),
    // stage 缺失 → 默认落 working/queued，同样不是人处理项
    ticket('t-missing'),
  ];
  assert.equal(renderPanel(tickets), '', `只有非 person 单子时必须是空串，实际 ${JSON.stringify(renderPanel(tickets))}`);
  assert.equal(isPanelEmpty(tickets), true, '只有非 person 单子时 isPanelEmpty 必须是 true');
});

// ---------------------------------------------------------------- 规格 3
test('spec3 只显示 person/*：7 个 stage 各 1 张单子时含 4 个 person 名、不含 working/idle/working/queued', () => {
  const tickets = STAGES.map((stage, i) => ticket(`t${i}`, stage));
  const panel = renderPanel(tickets);

  for (const personStage of PERSON_STAGES) {
    assert.equal(panel.includes(personStage), true, `面板应包含 person stage ${personStage}，实际 ${JSON.stringify(panel)}`);
  }
  assert.equal(PERSON_STAGES.length, 4, `person stage 应为 4 个，实际 ${PERSON_STAGES.length}`);

  for (const forbidden of ['working', 'idle', 'working/queued']) {
    assert.equal(panel.includes(forbidden), false, `面板不得包含非 person 词 ${forbidden}，实际 ${JSON.stringify(panel)}`);
  }
});

// ---------------------------------------------------------------- 规格 4
test('spec4 分组：7 组、顺序等于 STAGES、组内 ticket.stage 与组 stage 一致', () => {
  const tickets = [
    ticket('t-a', 'person/delivery'),
    ticket('t-b', 'working'),
    ticket('t-c', 'idle'),
    ticket('t-d', 'person/blocked'),
    ticket('t-e', 'working/queued'),
  ];
  const groups = groupByStage(tickets);

  assert.equal(groups.length, 7, `期望 7 组，实际 ${groups.length}`);
  groups.forEach((g, i) => {
    assert.equal(g.stage, STAGES[i], `第 ${i + 1} 组 stage 应为 ${STAGES[i]}，实际 ${g.stage}`);
    for (const t of g.tickets) {
      assert.equal(t.stage, g.stage, `组 ${g.stage} 内出现 stage=${String(t.stage)} 的单子 ${t.id}`);
    }
  });
});

test('spec4b 分组默认值：stage 缺失（undefined）的 ticket 落在 working/queued 组', () => {
  const orphan = ticket('t-orphan'); // 不带 stage
  const groups = groupByStage([orphan]);
  const queued = groups.find((g) => g.stage === 'working/queued');
  assert.notEqual(queued, undefined, '必须存在 working/queued 组');
  assert.equal(queued!.tickets.length, 1, `working/queued 组应含 1 张单子，实际 ${queued!.tickets.length}`);
  assert.equal(queued!.tickets[0].id, 't-orphan', 'undefined stage 的单子应落在 working/queued 组');

  const total = groups.reduce((n, g) => n + g.tickets.length, 0);
  assert.equal(total, 1, `分组不得丢单子，期望总数 1，实际 ${total}`);
});

// ---------------------------------------------------------------- 规格 5
test('spec5 计数：3 张 person + 2 张 working → {person: 3, total: 5}', () => {
  const tickets = [
    ticket('p1', 'person/delivery'),
    ticket('p2', 'person/answer'),
    ticket('p3', 'person/review'),
    ticket('w1', 'working'),
    ticket('w2', 'working/queued'),
  ];
  assert.deepEqual(panelCounts(tickets), { person: 3, total: 5 });
});

test('spec5b 计数：空数组 → {person: 0, total: 0}', () => {
  assert.deepEqual(panelCounts([]), { person: 0, total: 0 });
});

// ---------------------------------------------------------------- 规格 6
test('spec6 纯函数：同一输入连调两次结果相等', () => {
  const tickets = [
    ticket('p1', 'person/delivery'),
    ticket('w1', 'working'),
    ticket('x1'), // undefined stage
  ];

  assert.equal(renderBoard(tickets), renderBoard(tickets), 'renderBoard 两次结果应相等');
  assert.equal(renderPanel(tickets), renderPanel(tickets), 'renderPanel 两次结果应相等');
  assert.equal(isPanelEmpty(tickets), isPanelEmpty(tickets), 'isPanelEmpty 两次结果应相等');
  assert.deepEqual(groupByStage(tickets), groupByStage(tickets), 'groupByStage 两次结果应相等');
  assert.deepEqual(panelCounts(tickets), panelCounts(tickets), 'panelCounts 两次结果应相等');
});

test('spec6b 纯函数：输入数组及其元素被冻结后调用不抛且不改内容', () => {
  const tickets = deepFreeze([
    ticket('p1', 'person/delivery'),
    ticket('w1', 'working'),
    ticket('x1'),
  ]);
  const snapshot = JSON.stringify(tickets);

  assert.doesNotThrow(() => renderBoard(tickets), 'renderBoard 不得修改冻结输入');
  assert.doesNotThrow(() => renderPanel(tickets), 'renderPanel 不得修改冻结输入');
  assert.doesNotThrow(() => isPanelEmpty(tickets), 'isPanelEmpty 不得修改冻结输入');
  assert.doesNotThrow(() => groupByStage(tickets), 'groupByStage 不得修改冻结输入');
  assert.doesNotThrow(() => panelCounts(tickets), 'panelCounts 不得修改冻结输入');

  assert.equal(JSON.stringify(tickets), snapshot, '调用后输入内容不得改变');
  assert.equal(tickets.length, 3, '调用后输入数组长度不得改变');
});
