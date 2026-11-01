/**
 * tests/integration/t01-t15.test.ts —— 详设 §8 的 15 条验收判据（T01–T15）。
 *
 * 纪律：
 *  - 判据按详设 §8 / §4.1 / §5.1 / §6 与 R 条文写，**不从实现反推**；
 *  - 不 mock 时间后声称"5 秒"（T10 量真实 elapsed）；崩溃用真子进程（T08）；
 *  - 实现不符就判红，断言不放宽；口径收窄的条目在报告里逐条说明。
 *
 * 每条把一行 `<status>|<detail>` 写进 $VERIFY_RESULTS/<Txx>.txt，供 scripts/verify.sh
 * 打印固定形状的 `T01 | PASS | ...`。未设该变量时只跑测试（node --test 直跑也可用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { startRuntime } from '../../src/app/runtime.ts';
import { openDb, createRepository } from '../../src/app/store.ts';
import { Engine } from '../../src/core/engine.ts';
import { stageOf } from '../../src/core/stage.ts';
import type { StageInput } from '../../src/core/stage.ts';
import { runDue, Later } from '../../src/app/effects.ts';
import { SlotPool, SessionExecutor } from '../../src/app/executor.ts';
import { Outbox } from '../../src/app/outbox.ts';
import { kaaDone } from '../../src/app/kaa.ts';
import type { Assignment, Event, Mandate, Ticket } from '../../src/core/model.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS = process.env.VERIFY_RESULTS;

const MANDATE: Mandate = {
  policyVersion: 'pv-2026-11',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['rule:auto-low-risk', 'scope:repo'],
};

const allowGate = { check: () => ({ allowed: true as const, mandate: MANDATE }) };

/* ── 结果落盘与用例包装 ─────────────────────────────────────────────────── */

function record(id: string, status: 'PASS' | 'FAIL', detail: string): void {
  if (RESULTS === undefined) return;
  mkdirSync(RESULTS, { recursive: true });
  const safe = detail.replace(/[|\r\n]+/g, ' ').trim().slice(0, 280);
  writeFileSync(join(RESULTS, `${id}.txt`), `${status}|${safe}`);
}

async function tcase(id: string, title: string, body: () => Promise<string> | string): Promise<void> {
  test(`${id} ${title}`, async () => {
    try {
      record(id, 'PASS', await body());
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 300);
      record(id, 'FAIL', msg);
      throw e;
    }
  });
}

/* ── 通用夹具 ──────────────────────────────────────────────────────────── */

let dbSeq = 0;
function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), `t01-t15-${process.pid}-${++dbSeq}-`));
  return { file: join(dir, 'main.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function rows<T = Record<string, unknown>>(file: string, sql: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

function count(file: string, sql: string): number {
  const r = rows<{ n: number }>(file, sql)[0];
  return r === undefined ? -1 : Number(r.n);
}

function closeSafe(rt: { close(): void } | undefined): void {
  try {
    rt?.close();
  } catch {
    /* 已关闭 */
  }
}

function evt(id: string, externalId: string, at = 1_000, threadKey = 'th-1'): Event {
  return { id, source: 'goal-tree', externalId, at, actor: 'agent', text: `事件 ${id}`, threadKey, channel: 'goal-tree' };
}

function ticket(id: string, threadKey = `th-${id}`): Ticket {
  return { id, threadKey, mandate: MANDATE, createdAt: 1_000, state: 'open' };
}

function assignment(id: string, ticketId: string, dir = ''): Assignment {
  return { id, ticketId, state: 'pending', dir, sessionId: '' };
}

function fakeFactory() {
  const starts: { ticketId: string; dir: string; firstMessage: string }[] = [];
  const delivers: { sessionId: string; text: string }[] = [];
  let seq = 0;
  return {
    starts,
    delivers,
    factory: {
      async start(o: { ticketId: string; agentPreset: string; dir: string; firstMessage: string }) {
        starts.push({ ticketId: o.ticketId, dir: o.dir, firstMessage: o.firstMessage });
        seq += 1;
        return { sessionId: `sess-${seq}`, dir: o.dir };
      },
      async deliver(sessionId: string, text: string) {
        delivers.push({ sessionId, text });
      },
      async stop() {},
    },
  };
}

function presetDisabledCount(file: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  const head = lines.findIndex((l) => /^\s*disabledTools:\s*$/.test(l));
  if (head < 0) return 0; // 写成 `disabledTools: []` 或整段删掉 = 0 个禁用项
  let n = 0;
  for (let i = head + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (/^\s+-\s+\S+/.test(line)) {
      n += 1;
      continue;
    }
    break; // 缩进更浅的下一段 key
  }
  return n;
}

/** 预算判据：每个 preset 至少禁用一个下限数量的工具；返回违规项（空 = 通过）。 */
const BUDGET_MIN: Record<string, number> = { 'router.patch.yml': 2, 'worker.patch.yml': 1 };
function budgetViolations(dir: string): string[] {
  const out: string[] = [];
  for (const [name, min] of Object.entries(BUDGET_MIN)) {
    const n = presetDisabledCount(join(dir, name));
    if (n < min) out.push(`${name}: disabledTools=${n} < ${min}`);
  }
  return out;
}

/* ── T01 幂等摄入（R01） ──────────────────────────────────────────────── */

await tcase('T01', '幂等摄入：同 external_id 投两次只 1 行 event / 1 个 ticket', async () => {
  const { file, cleanup } = tempDb();
  const rt = startRuntime({ dbPath: file, gate: allowGate, now: () => 1_000 });
  try {
    const e = evt('e1', 'node:42:rev1');
    assert.equal(rt.engine.intake(e).disposition, 'new', '第一次应为 new');
    assert.equal(rt.engine.intake(e).disposition, 'duplicate', '第二次应为 duplicate');
    const events = count(file, 'SELECT COUNT(*) AS n FROM event');
    const tickets = count(file, 'SELECT COUNT(*) AS n FROM ticket');
    assert.equal(events, 1, `event 期望 1 行，实际 ${events}`);
    assert.equal(tickets, 1, `ticket 期望 1 个，实际 ${tickets}`);
    return `event=${events} ticket=${tickets}`;
  } finally {
    closeSafe(rt);
    cleanup();
  }
});

/* ── T02 串行评估（R02）───────────────────────────────────────────────── */

await tcase('T02', '串行评估：并发 3 条同 thread，tickets 不因并发翻倍且逐条处置', async () => {
  const { file, cleanup } = tempDb();
  const order: string[] = [];
  const gate = {
    check: (c: { event: Event }) => {
      order.push(c.event.id);
      return { allowed: true as const, mandate: MANDATE };
    },
  };
  const rt = startRuntime({ dbPath: file, gate, now: () => 1_000 });
  try {
    ['e1', 'e2', 'e3'].forEach((id, i) => rt.repo.events.put(evt(id, `ext-${id}`, 1_000 + i, 'th-shared')));
    const ticks = await Promise.all([rt.tick(), rt.tick(), rt.tick()]);
    const consumed = ticks.reduce((s, r) => s + r.events, 0);
    const tickets = count(file, 'SELECT COUNT(*) AS n FROM ticket');
    const accepted = count(file, "SELECT COUNT(*) AS n FROM event WHERE disposition = 'accepted'");
    assert.equal(consumed, 3, `三条事件应只被消费 3 次（不重复），实际 ${consumed}`);
    assert.equal(tickets, 3, `ticket 期望 3 个（不翻倍），实际 ${tickets}`);
    assert.equal(accepted, 3, `3 条事件都应处置为 accepted，实际 ${accepted}`);
    assert.deepEqual(order, ['e1', 'e2', 'e3'], `同 thread 应逐条按序判定，实际 ${order.join(',')}`);
    return `events=${consumed} tickets=${tickets} order=${order.join(',')}`;
  } finally {
    closeSafe(rt);
    cleanup();
  }
});

/* ── T03 Gate 四种 via（R03）──────────────────────────────────────────── */

await tcase('T03', 'Gate 四种 via：accept 建单，stop/ignore/unavailable 不建单且原因透传', async () => {
  const repo = createRepository(openDb(':memory:'));
  let decision: { allowed: true; mandate: Mandate } | { allowed: false; reason: string } = {
    allowed: true,
    mandate: MANDATE,
  };
  let seq = 0;
  const engine = new Engine({ repo, gate: { check: () => decision }, now: () => 0, nextId: () => `t${++seq}` });
  const put = (id: string, ext: string) => {
    const e = evt(id, ext, 0, 'th-3');
    repo.events.put(e);
    return engine.handleEvent(e);
  };

  const accepted = put('e-accept', 'ext-accept');
  assert.equal(accepted.disposition, 'new', 'accept 应建单');
  assert.ok(accepted.ticket, 'accept 应返回 ticket');
  assert.deepEqual(repo.tickets.get(accepted.ticket.id)?.mandate, MANDATE, 'accept 必须带 mandate 快照');

  for (const via of ['stop', 'ignore', 'unavailable'] as const) {
    decision = { allowed: false, reason: via };
    const out = put(`e-${via}`, `ext-${via}`);
    assert.equal(out.disposition, 'rejected', `${via} 应拒收`);
    assert.equal(out.reason, via, `${via} 的拒收原因码应原样透传`);
    assert.equal(repo.tickets.open().length, 1, `${via} 不得新建 ticket`);
  }
  assert.equal(repo.events.pending(10).length, 0, '四种 via 的事件都应被处置掉');
  return 'accept=new stop=rejected ignore=rejected unavailable=rejected';
});

/* ── T04 mandate 留档（R04）──────────────────────────────────────────── */

await tcase('T04', 'mandate 留档：ticket 可读回策略版本与依据码（落库视角）', async () => {
  const { file, cleanup } = tempDb();
  const rt = startRuntime({ dbPath: file, gate: allowGate, now: () => 2_000 });
  try {
    rt.repo.events.put(evt('e4', 'ext-4'));
    await rt.tick();
    const open = rt.repo.tickets.open();
    assert.equal(open.length, 1, '应建出 1 张 ticket');
    const t = open[0];
    assert.equal(t.mandate.policyVersion, MANDATE.policyVersion, 'policyVersion 应可读回');
    assert.deepEqual(t.mandate.basis, MANDATE.basis, 'basis 应可读回');
    rt.close();
    const raw = rows<{ mandate: string }>(file, 'SELECT mandate FROM ticket WHERE id = ?', t.id)[0];
    assert.ok(raw, 'ticket 行应仍在库里');
    const parsed = JSON.parse(String(raw.mandate)) as Mandate;
    assert.equal(parsed.policyVersion, MANDATE.policyVersion, '落库的 mandate.policyVersion 应可读回');
    assert.deepEqual(parsed.basis, MANDATE.basis, '落库的 mandate.basis 应可读回');
    return `policyVersion=${parsed.policyVersion} basis=${parsed.basis.length}`;
  } finally {
    closeSafe(rt);
    cleanup();
  }
});

/* ── T05 stage 表 7 行（R05）──────────────────────────────────────────── */

await tcase('T05', 'stage 表 7 行：逐行构造，判定与 §4.1 一致', () => {
  const base: StageInput = { lastDeliveryFailed: false, openQuestions: 0, humanRepliedSinceReport: false };
  const cases: [string, StageInput, string][] = [
    ['row1 投递失败', { ...base, lastDeliveryFailed: true }, 'person/delivery'],
    ['row2 未答问题', { ...base, openQuestions: 1, latestReport: 'ready', assignment: 'running' }, 'person/answer'],
    ['row3 报告 ready', { ...base, latestReport: 'ready', assignment: 'running' }, 'person/review'],
    ['row4 blocked 且无人回话', { ...base, latestReport: 'blocked', assignment: 'running' }, 'person/blocked'],
    ['row5 无 assignment', { ...base, assignment: undefined }, 'working/queued'],
    ['row6 waiting', { ...base, latestReport: 'waiting', assignment: 'running' }, 'idle'],
    ['row7 执行中', { ...base, latestReport: 'progress', assignment: 'running' }, 'working'],
  ];
  for (const [name, input, want] of cases) {
    assert.equal(stageOf(input), want, `${name}：期望 ${want}`);
  }
  return '7/7';
});

/* ── T06 会话与目录隔离（R06）─────────────────────────────────────────── */

await tcase('T06', '会话与目录隔离：两 ticket 的 sessionId / dir 互不相同', async () => {
  const { factory, starts } = fakeFactory();
  const ex = new SessionExecutor({ slots: new SlotPool(), factory, workRoot: '/tmp/t06-work', mkdirp: async () => {} });
  const a1 = assignment('a1', 't1');
  const a2 = assignment('a2', 't2');
  const r1 = await ex.start(ticket('t1'), a1);
  const r2 = await ex.start(ticket('t2'), a2);
  assert.notEqual(r1.dir, r2.dir, `两 ticket 的 dir 必须不同（实际都是 ${r1.dir}）`);
  assert.notEqual(r1.sessionId, r2.sessionId, `两 ticket 的 sessionId 必须不同（实际都是 ${r1.sessionId}）`);
  assert.notEqual(starts[0].dir, starts[1].dir, 'factory.start 收到的 dir 必须不同');
  return `session=${r1.sessionId}/${r2.sessionId} dir=${r1.dir}/${r2.dir}`;
});

/* ── T07 扇出（R07）───────────────────────────────────────────────────── */

await tcase('T07', '扇出：两订阅 ticket 各收 1 条，eval 不新增', async () => {
  const { file, cleanup } = tempDb();
  const rt = startRuntime({ dbPath: file, gate: allowGate, now: () => 3_000 });
  try {
    rt.engine.intake(evt('e1', 'ext-1', 3_000, 'th-fan'));
    rt.engine.intake(evt('e2', 'ext-2', 3_001, 'th-fan'));
    const before = count(file, 'SELECT COUNT(*) AS n FROM ticket');
    assert.equal(before, 2, '前置：同 thread 已有 2 张 ticket');
    // 人在该 thread 上发言：订阅者应各收到 1 条 input，而不是再开一张新单。
    // 口径说明：R07 的扇出场景是"人经此到达的消息不触发评估"，所以这条事件标记为 human；
    // 普通外部事件仍然走 Gate + 建单（T02/T03 判的就是那条路）。
    const human = { ...evt('e3', 'ext-3', 3_002, 'th-fan'), actor: 'human', channel: 'local' };
    rt.engine.intake(human);
    const deliver = count(file, "SELECT COUNT(*) AS n FROM effect WHERE kind = 'deliver'");
    const tickets = count(file, 'SELECT COUNT(*) AS n FROM ticket');
    assert.equal(
      deliver,
      2,
      `扇出：期望两订阅 ticket 各收 1 条 deliver（共 2 条），实际 ${deliver} 条；` +
        `eval 期望不新增（ticket 仍 2），实际 ticket=${tickets}`,
    );
    assert.equal(tickets, 2, `扇出不应新建 ticket：期望 2，实际 ${tickets}`);
    return `deliver=2 tickets=${tickets}`;
  } finally {
    closeSafe(rt);
    cleanup();
  }
});

/* ── T08 崩溃重放（R08）───────────────────────────────────────────────── */

await tcase('T08', '崩溃重放：子进程 enqueue 后 exit(137)，重启执行且外部副作用只 1 次', async () => {
  const { file, cleanup } = tempDb();
  const runtimeUrl = pathToFileURL(join(ROOT, 'src/app/runtime.ts')).href;
  const child = `
import { startRuntime } from ${JSON.stringify(runtimeUrl)};
const gate = { check: () => ({ allowed: true, mandate: ${JSON.stringify(MANDATE)} }) };
const rt = startRuntime({ dbPath: ${JSON.stringify(file)}, gate });
rt.repo.effects.enqueue({ kind: 'deliver', key: 'crash:replay', payload: '{"n":1}', dueAt: 0 });
process.exit(137);
`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 137, `子进程应以 137 退出（模拟崩溃），实际 status=${res.status} stderr=${res.stderr}`);
  assert.equal(count(file, 'SELECT COUNT(*) AS n FROM effect'), 1, '崩溃后 effect 应留在库里');

  // 外部副作用计数写 kv：handler 用独立连接写，父进程/重启后都能读到。
  const bump = () => {
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "INSERT INTO kv(key, value) VALUES('side-effects', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
      );
    } finally {
      db.close();
    }
  };
  let rt: ReturnType<typeof startRuntime> | undefined;
  try {
    rt = startRuntime({ dbPath: file, gate: allowGate, now: () => 10_000, handlers: { deliver: bump } });
    const first = await rt.tick();
    assert.equal(first.effects.settled, 1, `重启后应执行并 settle 1 条，实际 ${JSON.stringify(first.effects)}`);
    const after1 = count(file, "SELECT CAST(value AS INTEGER) AS n FROM kv WHERE key = 'side-effects'");
    assert.equal(after1, 1, `外部副作用应恰好发生 1 次，实际 ${after1}`);
    await rt.tick(); // 再跑一轮：settle 过的不得重放
    const after2 = count(file, "SELECT CAST(value AS INTEGER) AS n FROM kv WHERE key = 'side-effects'");
    assert.equal(after2, 1, `重放只发生一次，第二轮后应仍为 1，实际 ${after2}`);
    assert.equal(count(file, 'SELECT COUNT(*) AS n FROM effect'), 0, 'settle 后 effect 行应被删除');
    return `replayed=1 sideEffects=${after2}`;
  } finally {
    rt?.close();
    cleanup();
  }
});

/* ── T09 重试边界（R09）───────────────────────────────────────────────── */

await tcase('T09', '重试边界：断网 3 次判 failed，且 failed 是终态不再执行', async () => {
  const db = openDb(':memory:');
  const repo = createRepository(db);
  repo.effects.enqueue({ kind: 'deliver', key: 'k9', payload: '{}', dueAt: 0 });
  const at: number[] = [];
  const handler = (row: { attempts: number }) => {
    at.push(row.attempts);
    throw new Error('断网');
  };
  // deliver 退避：2s → 4s；第 3 次失败判 failed（§5.1 / BACKOFF maxAttempts=3）
  const r1 = await runDue(repo, 0, { deliver: handler });
  const r2 = await runDue(repo, 2_000, { deliver: handler });
  const r3 = await runDue(repo, 6_000, { deliver: handler });
  assert.equal(r1.retried, 1, `第 1 次失败应重试，实际 ${JSON.stringify(r1)}`);
  assert.equal(r2.retried, 1, `第 2 次失败应重试，实际 ${JSON.stringify(r2)}`);
  assert.equal(r3.failed, 1, `第 3 次失败应判 failed，实际 ${JSON.stringify(r3)}`);
  assert.equal(at.length, 3, `判 failed 前应恰好执行 3 次，实际 ${at.length}`);
  // 终态：failed 之后 claimDue 不应再取到它（ports.ts：fail = 终态失败）。
  // claimDue 的 30s 租约到期后（6000 + 30000）再跑一轮，不得第 4 次执行。
  await runDue(repo, 36_000, { deliver: handler });
  assert.equal(
    at.length,
    3,
    `failed 应终态：第 3 次失败后不应再执行，实际在 now=36000 又执行了一次（执行次数 ${at.length}，attempts=${at.join(',')}）`,
  );
  db.close();
  return `attempts=${at.length} third=failed`;
});

/* ── T10 人的优先（R10）───────────────────────────────────────────────── */

await tcase('T10', '人的优先：工作槽位满时人的消息不被阻塞且投递 < 5s', async () => {
  const { factory, delivers } = fakeFactory();
  const slots = new SlotPool({ capacity: 1, humanExtra: 1 });
  const ex = new SessionExecutor({ slots, factory, workRoot: '/tmp/t10-work', mkdirp: async () => {} });
  const t1 = ticket('t1');
  const a1 = assignment('a1', 't1');
  await ex.start(t1, a1);
  await assert.rejects(
    () => ex.start(ticket('t2'), assignment('a2', 't2')),
    (e: unknown) => e instanceof Later,
    '满槽时第二个工作会话应抛 Later（不进退避）',
  );
  const started = Date.now();
  await ex.deliver(t1, a1, '人的插话');
  const elapsed = Date.now() - started;
  assert.equal(delivers.length, 1, '人的消息应真的投到会话');
  assert.equal(delivers[0].text, '人的插话', '投递正文应为人的插话');
  assert.ok(elapsed < 5_000, `人的消息应在 5s 内投达，实际 ${elapsed}ms`);
  assert.equal(slots.used, 1, '人的投递不应占用工作槽位');
  return `human=${elapsed}ms slotBlocked=Later`;
});

/* ── T11 消息保序（R11）───────────────────────────────────────────────── */

await tcase('T11', '消息保序：同会话 3 条按入队顺序到达', async () => {
  const delivered: string[] = [];
  const delays = [30, 10, 0];
  let i = 0;
  const channel = {
    name: 'ch',
    send(m: { id: string }) {
      const d = delays[i++] ?? 0;
      return new Promise<void>((done) => {
        setTimeout(() => {
          delivered.push(m.id);
          done();
        }, d);
      });
    },
  };
  const outbox = new Outbox([channel]);
  const msgs = ['m1', 'm2', 'm3'].map((id) => ({ id, channel: 'ch', text: `text-${id}`, kind: 'reply' as const }));
  await Promise.all(msgs.map((m) => outbox.send(m)));
  assert.deepEqual(delivered, ['m1', 'm2', 'm3'], `到达顺序应等于入队顺序，实际 ${delivered.join(',')}`);
  return `order=${delivered.join(',')}`;
});

/* ── T12 暂停（R12）───────────────────────────────────────────────────── */

await tcase('T12', '暂停：不调 tick 时 event 增、ticket 不增', async () => {
  const { file, cleanup } = tempDb();
  const rt = startRuntime({ dbPath: file, gate: allowGate, now: () => 4_000 });
  try {
    rt.repo.events.put(evt('e1', 'ext-1'));
    rt.repo.events.put(evt('e2', 'ext-2'));
    const events = count(file, 'SELECT COUNT(*) AS n FROM event');
    const tickets = count(file, 'SELECT COUNT(*) AS n FROM ticket');
    assert.equal(events, 2, `暂停时 event 仍应记录（期望 2），实际 ${events}`);
    assert.equal(tickets, 0, `暂停时不得建单（期望 0），实际 ${tickets}`);
    assert.equal(rt.running, false, '暂停态：pass 定时器不得在跑');
    return `events=${events} tickets=${tickets}`;
  } finally {
    closeSafe(rt);
    cleanup();
  }
});

/* ── T13 预算（R19）───────────────────────────────────────────────────── */

await tcase('T13', '预算：preset 至少禁用 N 个工具；disabledTools 清空后同一判据必须红', () => {
  const real = budgetViolations(join(ROOT, 'presets'));
  assert.deepEqual(real, [], `真实 preset 应满足预算下限：${real.join('；')}`);
  const router = presetDisabledCount(join(ROOT, 'presets/router.patch.yml'));
  const worker = presetDisabledCount(join(ROOT, 'presets/worker.patch.yml'));
  assert.ok(router >= 2, `router 至少禁 2 个工具，实际 ${router}`);
  assert.ok(worker >= 1, `worker 至少禁 1 个工具，实际 ${worker}`);

  // 破坏实验：工具"加满"（disabledTools 清空）后，同一判据必须报违规。
  const full = budgetViolations(join(ROOT, 'tests/fixtures/presets-full'));
  assert.equal(full.length, 2, `清空 disabledTools 的坏夹具应两处都违规，实际 ${JSON.stringify(full)}`);
  return `router=${router} worker=${worker} full-red=yes`;
});

/* ── T14 核心纯净（R17）───────────────────────────────────────────────── */

await tcase('T14', '核心纯净：src/core/ 不含宿主依赖（不调 shell，用 Node 读文件）', () => {
  const dir = join(ROOT, 'src/core');
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.ts'))
    .map((d) => d.name);
  const forbidden = ['@deepseek-ai', 'node:fs', 'node:net', 'better-sqlite3'];
  const hits: string[] = [];
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8');
    for (const p of forbidden) if (text.includes(p)) hits.push(`${name}:${p}`);
  }
  assert.deepEqual(hits, [], `src/core/ 不得出现宿主依赖，命中：${hits.join(', ')}`);
  assert.ok(files.length >= 4, `src/core/ 应至少有 model/ports/stage/engine 4 个文件，实际 ${files.length}`);
  return `coreFiles=${files.length} hits=0`;
});

/* ── T15 kaa 契约（R23）───────────────────────────────────────────────── */

await tcase('T15', 'kaa 契约：拒收退出码非 0 且 JSON 可解析；超时进退避', async () => {
  const rejected = await kaaDone('repo-x', 'n1', {}, {}, {
    run: async () => ({ code: 3, stdout: '{"missing":["evidence"]}', timedOut: false }),
  });
  assert.equal(rejected.ok, false, '非 0 退出码应判失败');
  assert.notEqual(rejected.code, 0, '拒收时退出码应非 0');
  assert.deepEqual(rejected.json, { missing: ['evidence'] }, '拒收的 JSON 必须可解析并保留');

  const db = openDb(':memory:');
  const repo = createRepository(db);
  repo.effects.enqueue({ kind: 'kaaDone', key: 'repo-x:n1', payload: '{}', dueAt: 0 });
  let calls = 0;
  const timeoutRun = async () => {
    calls += 1;
    return { code: null, stdout: '', timedOut: true };
  };
  const handler = async () => {
    const r = await kaaDone('repo-x', 'n1', {}, {}, { run: timeoutRun });
    if (!r.ok) throw new Error(r.error ?? 'kaa not ok');
  };
  const r1 = await runDue(repo, 10_000, { kaaDone: handler });
  assert.equal(calls, 1, '超时只应调用 1 次');
  assert.equal(r1.retried, 1, `超时应进退避（retried=1），实际 ${JSON.stringify(r1)}`);
  assert.equal(repo.effects.claimDue(11_999).length, 0, '未到退避时间不得再执行');
  const due = repo.effects.claimDue(12_000);
  assert.equal(due.length, 1, 'kaaDone 退避 2s 后应重新到期');
  assert.equal(due[0].attempts, 1, '重试应记 1 次失败');
  db.close();
  return 'code=3 json=ok timeout=retried@+2000';
});
