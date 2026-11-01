/**
 * tests/unit/follows.test.ts —— R13 的规格测试：`prOutcome(prs)`。
 * 规格来源：需求 R13「ticket 在它开的 PR 全关时才结束；outcome 取最后一次关闭」。
 * 只读公开面：`prOutcome` 与 `FollowedPr`，不碰 Engine 私有字段。
 * 断言从严：实际与规格不符就判红，不放宽断言迁就实现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prOutcome } from '../../src/core/engine.ts';
import type { FollowedPr } from '../../src/core/engine.ts';

// ---------------------------------------------------------------------------
// 1. 没有 PR：没开 PR 就不该结束
// ---------------------------------------------------------------------------

test('1. 没有 PR → { ended: false }，且不带 outcome', () => {
  const r = prOutcome([]);

  // 会红：空数组判成 ended:true。
  assert.deepStrictEqual(r, { ended: false });
  // 不会红：outcome 字段（此时不应有值）。
  assert.strictEqual('outcome' in r, false, 'ended:false 时不应有 outcome 字段');
});

// ---------------------------------------------------------------------------
// 2. 有未关的 PR：只要还有一个没关就不该结束
// ---------------------------------------------------------------------------

test('2a. 一个已关 + 一个未关 → { ended: false }', () => {
  const prs: FollowedPr[] = [
    { id: 'pr-1', closed: true, outcome: 'merged' },
    { id: 'pr-2', closed: false },
  ];

  // 会红：只要有一个关了就结束。
  const r = prOutcome(prs);
  assert.deepStrictEqual(r, { ended: false });
  assert.strictEqual('outcome' in r, false, '未全关时不应有 outcome 字段');
});

test('2b. 单个未关的 PR → { ended: false }', () => {
  const r = prOutcome([{ id: 'pr-1', closed: false }]);

  assert.deepStrictEqual(r, { ended: false });
  assert.strictEqual('outcome' in r, false, '未关时不应有 outcome 字段');
});

// ---------------------------------------------------------------------------
// 3. 全关：ended:true，outcome 必须等于数组里最后一个元素的 outcome
// ---------------------------------------------------------------------------

test('3a. 全关 [merged, abandoned] → outcome 取最后一个 abandoned', () => {
  const prs: FollowedPr[] = [
    { id: 'pr-1', closed: true, outcome: 'merged' },
    { id: 'pr-2', closed: true, outcome: 'abandoned' },
  ];

  // 会红：outcome 取第一个、或写成固定字符串。
  assert.deepStrictEqual(prOutcome(prs), { ended: true, outcome: 'abandoned' });
});

test('3b. 全关 [abandoned, merged] → outcome 取最后一个 merged', () => {
  const prs: FollowedPr[] = [
    { id: 'pr-1', closed: true, outcome: 'abandoned' },
    { id: 'pr-2', closed: true, outcome: 'merged' },
  ];

  // 反向构造，排除"取第一个 / 取固定字符串 / 取某个特定值"。
  assert.deepStrictEqual(prOutcome(prs), { ended: true, outcome: 'merged' });
});

// ---------------------------------------------------------------------------
// 4. 不修改输入：冻结的数组与冻结的元素调用不抛，调用后各字段不变
// ---------------------------------------------------------------------------

test('4. 冻结的数组与元素调用不抛，且输入不被修改', () => {
  const prs: FollowedPr[] = Object.freeze([
    Object.freeze({ id: 'pr-1', closed: true, outcome: 'merged' }) as FollowedPr,
    Object.freeze({ id: 'pr-2', closed: false }) as FollowedPr,
  ]) as readonly FollowedPr[];

  const snapshot = prs.map((p) => ({ ...p }));

  // 会红：函数里对 prs 排序/改 closed（冻结下会抛 TypeError）。
  assert.doesNotThrow(() => prOutcome(prs));

  // 调用后各字段不变。
  assert.deepStrictEqual(
    prs.map((p) => ({ ...p })),
    snapshot,
  );
  assert.strictEqual(prs[0].closed, true);
  assert.strictEqual(prs[0].outcome, 'merged');
  assert.strictEqual(prs[1].closed, false);
});

// ---------------------------------------------------------------------------
// 5. 纯函数：同一输入连调两次结果 deepEqual
// ---------------------------------------------------------------------------

test('5. 同一输入连调两次，结果 deepEqual', () => {
  const prs: FollowedPr[] = [
    { id: 'pr-1', closed: true, outcome: 'merged' },
    { id: 'pr-2', closed: true, outcome: 'abandoned' },
  ];

  const first = prOutcome(prs);
  const second = prOutcome(prs);

  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(second, { ended: true, outcome: 'abandoned' });
});
