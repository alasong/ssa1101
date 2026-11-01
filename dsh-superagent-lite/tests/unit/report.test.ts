/**
 * tests/unit/report.test.ts —— worker 回写口 `report` 工具的规格测试（K11 / R05 / R09）。
 * 规格来源：K11 验收（三态驱动 stage、只有 ready 触发 relay、报告落库、未知类型拒绝、
 * ticket 不存在抛错、reportId 递增），不是从实现反推。
 *
 * 仓储用**真 SQLite 临时库**（openDb + createRepository），不 mock：
 * 「报告是否真的落库」这条规格只有在真库上才有意义。
 * stage 一律由 engine.report → stageOf 决定，本测试不重算，只断言对外可见结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';

import { openDb, createRepository } from '../../src/app/store.ts';
import { Engine } from '../../src/core/engine.ts';
import { createReportTool, REPORT_KINDS } from '../../src/tools/report.ts';
import type { Mandate, Ticket } from '../../src/core/model.ts';

const NOW = 1_700_000_000_000;

const MANDATE: Mandate = {
  policyVersion: 'v1',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['test'],
};

interface Harness {
  file: string;
  repo: ReturnType<typeof createRepository>;
  engine: Engine;
  ticketId: string;
  assignmentId: string;
  tool: ReturnType<typeof createReportTool>;
}

/**
 * 每个用例独立临时库：/tmp/report-test-<uuid>.db，t.after 关库并删 .db/-wal/-shm。
 * `existingTicket: false` 时**不**放 ticket —— 用来验「ticket 不存在」那条。
 */
function setup(t: { after(fn: () => void): void }, opts: { existingTicket?: boolean } = {}): Harness {
  const file = `/tmp/report-test-${randomUUID()}.db`;
  const db = openDb(file);
  const repo = createRepository(db);
  const ticketId = 'tk-1';
  const assignmentId = 'as-1';

  if (opts.existingTicket !== false) {
    const ticket: Ticket = {
      id: ticketId,
      threadKey: 'thread-1',
      mandate: MANDATE,
      createdAt: NOW,
      state: 'open',
      stage: 'working/queued',
    };
    repo.tickets.put(ticket);
  }

  const engine = new Engine({
    repo,
    // report 路径不该碰 Gate：被调用即说明走错了路，直接抛。
    gate: {
      check() {
        throw new Error('report 路径不应调用 gate.check');
      },
    },
    now: () => NOW,
    nextId: () => 'evt-1',
  });

  const tool = createReportTool({ engine, ticketId, assignmentId, now: () => NOW });

  t.after(() => {
    try {
      db.close();
    } catch {
      // 已经关过就忽略
    }
    for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
  });

  return { file, repo, engine, ticketId, assignmentId, tool };
}

// ---------------------------------------------------------------------------
// 规格 1：三态报告驱动 stage（走 engine.report / stageOf，不是工具自己判）
// ---------------------------------------------------------------------------

test('1. 三态报告驱动 stage：ready→person/review、waiting→working/queued、blocked→person/blocked', (t) => {
  // 该 ticket 没有 assignment（setup 只 put 了 ticket，没有 assignment 字段）。
  const { tool, ticketId, repo } = setup(t);

  const ready = tool.call('ready');
  assert.equal(ready.stage, 'person/review');

  const waiting = tool.call('waiting');
  assert.equal(waiting.stage, 'working/queued');

  const blocked = tool.call('blocked');
  assert.equal(blocked.stage, 'person/blocked');

  // 三态之外再钉一条：stage 是派生值，必须真的写回 ticket（工具不能只回显）。
  assert.equal(repo.tickets.get(ticketId)?.stage, 'person/blocked');
});

// ---------------------------------------------------------------------------
// 规格 2：只有 ready 触发 relay
// ---------------------------------------------------------------------------

test('2. 只有 ready 触发 relay：ready 的 relayKey = `<ticketId>:<reportId>`，waiting/progress 为 undefined', (t) => {
  const { tool, ticketId } = setup(t);

  const ready = tool.call('ready');
  assert.equal(ready.relayKey, `${ticketId}:${ready.reportId}`);

  const waiting = tool.call('waiting');
  assert.equal(waiting.relayKey, undefined);

  const progress = tool.call('progress');
  assert.equal(progress.relayKey, undefined);
});

// ---------------------------------------------------------------------------
// 规格 3：报告真的落库（K11 反例面：只返回结果不落库）
// ---------------------------------------------------------------------------

test('3. 报告落库：latest(ticketId) 取得到，且 kind 与传入一致（六种都试）', (t) => {
  const { tool, ticketId, repo } = setup(t);

  assert.equal(repo.reports.latest(ticketId), undefined);

  for (const kind of REPORT_KINDS) {
    const out = tool.call(kind);
    const stored = repo.reports.latest(ticketId);
    assert.notEqual(stored, undefined, `${kind} 报告必须落库`);
    assert.equal(stored?.kind, kind);
    assert.equal(stored?.id, out.reportId);
    assert.equal(stored?.ticketId, ticketId);
  }
});

test('4. 连调两次后 latest 是第二次那条（seq 递增，后者覆盖可见的最新）', (t) => {
  const { tool, ticketId, repo } = setup(t);

  const first = tool.call('progress');
  const second = tool.call('waiting');

  assert.notEqual(second.reportId, first.reportId);

  const latest = repo.reports.latest(ticketId);
  assert.equal(latest?.id, second.reportId);
  assert.equal(latest?.kind, 'waiting');
});

// ---------------------------------------------------------------------------
// 规格 4：未知类型必须拒绝，且不产生报告
// ---------------------------------------------------------------------------

test('5. 未知类型拒绝：抛错，且不产生报告（latest 仍是上一条）', (t) => {
  const { tool, ticketId, repo } = setup(t);

  const before = tool.call('progress');
  assert.throws(() => tool.call('nope' as never), undefined, '未知报告类型必须抛错');

  const latest = repo.reports.latest(ticketId);
  assert.equal(latest?.id, before.reportId, '被拒绝的报告不得落库');
  assert.equal(latest?.kind, 'progress');
});

// ---------------------------------------------------------------------------
// 规格 5：ticket 不存在 → 抛错（不许凭空建 ticket）
// ---------------------------------------------------------------------------

test('6. ticket 不存在：call("ready") 抛错，且不留下任何报告', (t) => {
  const { tool, ticketId, repo } = setup(t, { existingTicket: false });

  assert.throws(() => tool.call('ready'));

  assert.equal(repo.tickets.get(ticketId), undefined, '不许凭空建 ticket');
  assert.equal(repo.reports.latest(ticketId), undefined, '不许留下报告');
});

// ---------------------------------------------------------------------------
// 规格 6：默认 reportId 生成器递减递增（三次互不相同）
// ---------------------------------------------------------------------------

test('7. reportId 递增：连调三次，返回的 reportId 互不相同', (t) => {
  const { tool } = setup(t);

  const ids = [tool.call('progress').reportId, tool.call('waiting').reportId, tool.call('blocked').reportId];

  assert.equal(new Set(ids).size, 3, `三次 reportId 必须互不相同，实际 ${JSON.stringify(ids)}`);
});
