/**
 * tests/unit/stage.test.ts —— stageOf 的 7 行真值表 / 优先级 / 穷举性 / 纯函数性。
 * 规格来源：详设 §4.1（行序即优先级），不是从实现反推。
 * 断言一律 assert.equal；每个 case 一条 test，名字带行号便于归因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stageOf, type StageInput } from '../../src/core/stage.ts';
import { STAGES, isPersonStage } from '../../src/core/model.ts';

/** 全部字段取"不命中任何前置行"的中性值；每个 case 只覆盖自己关心的字段。 */
function input(overrides: Partial<StageInput> = {}): StageInput {
  return {
    lastDeliveryFailed: false,
    openQuestions: 0,
    latestReport: undefined,
    humanRepliedSinceReport: false,
    assignment: undefined,
    ...overrides,
  };
}

/**
 * 统一出口：先断言返回值属于 STAGES（穷举性），再断言等于期望行。
 * 用 assert.equal 而非 assert.ok，失败信息带输入快照。
 */
function assertStage(i: StageInput, expected: string, label: string): void {
  const actual = stageOf(i);
  assert.equal(
    STAGES.includes(actual as (typeof STAGES)[number]),
    true,
    `${label}: 返回值 ${actual} 不在 STAGES 内`,
  );
  assert.equal(actual, expected, `${label}: 期望 ${expected}，实际 ${actual}，输入 ${JSON.stringify(i)}`);
}

// ---------------------------------------------------------------- 行 1-7
test('row1 投递失败 → person/delivery', () => {
  assertStage(input({ lastDeliveryFailed: true, assignment: 'running' }), 'person/delivery', 'row1');
});

test('row2 有未答问题 → person/answer', () => {
  assertStage(input({ openQuestions: 1 }), 'person/answer', 'row2');
});

test('row3 报告 ready → person/review', () => {
  assertStage(input({ openQuestions: 0, latestReport: 'ready' }), 'person/review', 'row3');
});

test('row4 报告 blocked 且此后无真人回复 → person/blocked', () => {
  assertStage(
    input({ latestReport: 'blocked', humanRepliedSinceReport: false, assignment: 'running' }),
    'person/blocked',
    'row4',
  );
});

test('row4 报告 failed 且此后无真人回复 → person/blocked', () => {
  assertStage(
    input({ latestReport: 'failed', humanRepliedSinceReport: false, assignment: 'done' }),
    'person/blocked',
    'row4',
  );
});

test('row5 无 assignment → working/queued', () => {
  assertStage(input({ assignment: undefined }), 'working/queued', 'row5');
});

test('row5 assignment pending → working/queued', () => {
  assertStage(input({ assignment: 'pending' }), 'working/queued', 'row5');
});

test('row6 报告 waiting（assignment running）→ idle', () => {
  assertStage(input({ latestReport: 'waiting', assignment: 'running' }), 'idle', 'row6');
});

test('row6 assignment done → idle', () => {
  assertStage(input({ assignment: 'done' }), 'idle', 'row6');
});

test('row7 assignment running、无报告 → working', () => {
  assertStage(input({ assignment: 'running' }), 'working', 'row7');
});

test('row7 assignment interrupted、无报告 → working', () => {
  assertStage(input({ assignment: 'interrupted' }), 'working', 'row7');
});

// ------------------------------------------------------------- 优先级
test('prio1 投递失败压过未答问题 → person/delivery', () => {
  assertStage(
    input({ lastDeliveryFailed: true, openQuestions: 3, assignment: 'running' }),
    'person/delivery',
    'prio1',
  );
});

test('prio2 未答问题压过 ready 报告 → person/answer', () => {
  assertStage(input({ openQuestions: 2, latestReport: 'ready' }), 'person/answer', 'prio2');
});

test('prio3 ready 报告压过无 assignment（person 类优先）→ person/review', () => {
  assertStage(input({ latestReport: 'ready', assignment: undefined }), 'person/review', 'prio3');
});

test('prio4 blocked 但人已回复、无 assignment → working/queued', () => {
  assertStage(
    input({ latestReport: 'blocked', humanRepliedSinceReport: true, assignment: undefined }),
    'working/queued',
    'prio4',
  );
});

test('prio4 blocked 但人已回复、assignment running → working', () => {
  assertStage(
    input({ latestReport: 'blocked', humanRepliedSinceReport: true, assignment: 'running' }),
    'working',
    'prio4',
  );
});

test('prio4 blocked 但人已回复、assignment done（无 waiting 报告）→ idle', () => {
  assertStage(
    input({ latestReport: 'blocked', humanRepliedSinceReport: true, assignment: 'done' }),
    'idle',
    'prio4',
  );
});

// ------------------------------------------------------------- 穷举性
test('exhaust1 STAGES 长度为 7', () => {
  assert.equal(STAGES.length, 7);
});

test('exhaust2 STAGES 无重复', () => {
  assert.equal(new Set(STAGES).size, STAGES.length);
});

test('exhaust3 STAGES 顺序与真值表行序一致', () => {
  const expected = [
    'person/delivery',
    'person/answer',
    'person/review',
    'person/blocked',
    'working/queued',
    'idle',
    'working',
  ];
  assert.equal(STAGES.join(','), expected.join(','));
});

test('exhaust4 isPersonStage 只对 person/* 四行成立', () => {
  assert.equal(STAGES.slice(0, 4).every(isPersonStage), true);
  assert.equal(STAGES.slice(4).some(isPersonStage), false);
});

// ------------------------------------------------------------- 纯函数性
test('pure1 同一输入连调两次结果相同', () => {
  const i = Object.freeze(input({ openQuestions: 2, latestReport: 'progress', assignment: 'running' }));
  const first = stageOf(i);
  const second = stageOf(i);
  assert.equal(second, first);
});

test('pure2 调用不修改传入对象（冻结输入 + 字段回读）', () => {
  const frozen = Object.freeze(
    input({ lastDeliveryFailed: true, openQuestions: 3, latestReport: 'blocked', assignment: 'pending' }),
  );
  const snapshot = { ...frozen };

  assert.equal(stageOf(frozen), 'person/delivery');

  assert.equal(frozen.lastDeliveryFailed, snapshot.lastDeliveryFailed);
  assert.equal(frozen.openQuestions, snapshot.openQuestions);
  assert.equal(frozen.latestReport, snapshot.latestReport);
  assert.equal(frozen.humanRepliedSinceReport, snapshot.humanRepliedSinceReport);
  assert.equal(frozen.assignment, snapshot.assignment);
});
