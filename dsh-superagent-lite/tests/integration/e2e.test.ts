/**
 * tests/integration/e2e.test.ts —— K14 端到端 + 崩溃恢复集成测试。
 *
 * 纪律：
 *  - 真 `node:sqlite` 临时库，每条用例独立 `/tmp/e2e-<uuid>.db`，用完连 `-wal`/`-shm` 一起删；
 *  - 崩溃用**真子进程**（`spawnSync` + `process.exit(137)`），不是在父进程里假装；
 *  - 不 sleep、不联网；推进一律靠 `await rt.tick()`；
 *  - 实现不符规格就判红，断言不放宽——差值写进断言消息（期望 / 实际 / 缺什么），
 *    绝不在测试里迁就实现（`src/` 一行不改）。
 *
 * 跑法：`node --test tests/integration/e2e.test.ts`
 */
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { startRuntime } from '../../src/app/runtime.ts';
import type { Runtime } from '../../src/app/runtime.ts';
import { openDb, SCHEMA_VERSION } from '../../src/app/store.ts';
import type { Handlers } from '../../src/app/effects.ts';
import { SessionExecutor, SlotPool } from '../../src/app/executor.ts';
import { createReportTool } from '../../src/tools/report.ts';
import { manualEvent } from '../../src/sources/manual.ts';
import { newAssignment } from '../../src/core/engine.ts';
import type { Mandate } from '../../src/core/model.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MANDATE: Mandate = {
  policyVersion: 'pv-2026-11',
  scope: 'repo:write',
  strength: 'auto',
  basis: ['rule:auto-low-risk', 'scope:repo'],
};

const allowGate = { check: () => ({ allowed: true as const, mandate: MANDATE }) };

/* ── 通用夹具 ──────────────────────────────────────────────────────────── */

/** 独立临时库路径；调用方负责在 `t.after` 里先关库再删三件套。 */
function tempDbPath(): string {
  return join(tmpdir(), `e2e-${randomUUID()}.db`);
}

function dropDbFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
}

/** 用独立连接读一个数：不改 runtime 的内部状态。 */
function count(file: string, sql: string, ...params: unknown[]): number {
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare(sql).get(...(params as never[])) as { n?: number } | undefined;
    return row === undefined ? -1 : Number(row.n ?? -1);
  } finally {
    db.close();
  }
}

function closeSafe(rt: Runtime | undefined): void {
  try {
    rt?.close();
  } catch {
    /* 已关闭 */
  }
}

/** 假 SessionFactory：只记录、不碰宿主（K07 的端口就是为这个留的）。 */
function fakeFactory() {
  const starts: { ticketId: string; dir: string; firstMessage: string }[] = [];
  let seq = 0;
  return {
    starts,
    factory: {
      async start(o: { ticketId: string; agentPreset: string; dir: string; firstMessage: string }) {
        starts.push({ ticketId: o.ticketId, dir: o.dir, firstMessage: o.firstMessage });
        seq += 1;
        return { sessionId: `sess-${seq}`, dir: o.dir };
      },
      async deliver() {},
      async stop() {},
    },
  };
}

/* ── K14-1 全链路落库 ───────────────────────────────────────────────────── */

test(
  'K14-1 全链路落库：manual → event → ticket → 会话 → ready → relay → kaa/treeWrite',
  async (t: TestContext) => {
    const file = tempDbPath();
    const workRoot = mkdtempSync(join(tmpdir(), 'e2e-work-'));
    let rt: Runtime | undefined;
    t.after(() => {
      closeSafe(rt);
      dropDbFiles(file);
      rmSync(workRoot, { recursive: true, force: true });
    });

    const { factory, starts } = fakeFactory();
    const executor = new SessionExecutor({ slots: new SlotPool({ capacity: 2, humanExtra: 1 }), factory, workRoot });

    const runs = { launch: 0, relay: 0, kaaDone: 0, treeWrite: 0 };
    let started: { sessionId: string; dir: string } | undefined;
    const handlers: Handlers = {
      // 第 6 步：launch 真正起会话，并把带 sessionId/dir 的 assignment 写回 ticket。
      launch: async (row) => {
        runs.launch += 1;
        const { ticketId } = JSON.parse(row.payload) as { ticketId: string };
        const ticket = rt!.repo.tickets.get(ticketId);
        assert.ok(ticket !== undefined, `launch: ticket ${ticketId} 应已落库`);
        const a = await executor.start(ticket, newAssignment(ticket, 'a1', '', ''));
        // 注：`Repository.tickets.put` 只能绑定标量，传对象会被 node:sqlite 当成命名参数抛
        // `Unknown named parameter 'id'`；`rowToTicket` 也不 JSON.parse。所以这里按 runtime
        // 期望的形状（对象）序列化后落库，缺口本身由 K14-3 判红记录，不在实现里补。
        rt!.repo.tickets.put({ ...ticket, assignment: JSON.stringify(a) });
        started = { sessionId: a.sessionId, dir: a.dir };
      },
      relay: async () => {
        runs.relay += 1;
      },
      // kaa 桩：返回 ok（不 spawn 真 python）。
      kaaDone: async () => {
        runs.kaaDone += 1;
        return { ok: true } as never;
      },
      treeWrite: async () => {
        runs.treeWrite += 1;
      },
    };

    rt = startRuntime({ dbPath: file, gate: allowGate, handlers });

    // ① 人下任务 → 事件落库 → pass 入口处理
    const event = manualEvent({ id: 'm1', text: '写一个 e2e 用例' }, Date.now());
    rt.repo.events.put(event);
    const outcome = rt.engine.handleEvent(event);
    assert.equal(outcome.disposition, 'new', `期望建新单，实际 disposition=${outcome.disposition}`);
    const ticket = outcome.ticket;
    assert.ok(ticket !== undefined, 'handleEvent 应返回新建的 ticket');
    const ticketId = ticket.id;

    assert.equal(count(file, 'SELECT COUNT(*) AS n FROM event'), 1, 'event 表应恰有 1 行');
    assert.equal(count(file, 'SELECT COUNT(*) AS n FROM ticket WHERE id = ?', ticketId), 1, 'ticket 应落库 1 行');

    // ② tick 跑 launch → 会话起起来（assignment 带 sessionId/dir）
    await rt.tick();
    assert.equal(runs.launch, 1, `期望 launch handler 跑 1 次，实际 ${runs.launch}`);
    assert.equal(starts.length, 1, `期望假 factory 被调用 1 次，实际 ${starts.length}`);
    assert.ok(started !== undefined, 'launch 后应拿到 sessionId/dir 的 assignment');
    assert.equal(started.sessionId, 'sess-1', `期望 sessionId=sess-1，实际 ${started.sessionId}`);
    assert.equal(started.dir, `${workRoot}/${ticketId}-a1`, `期望独占目录 ${workRoot}/${ticketId}-a1，实际 ${started.dir}`);
    const savedRaw = rt.repo.tickets.get(ticketId)?.assignment;
    const saved = JSON.parse(String(savedRaw)) as { sessionId?: string; dir?: string };
    assert.equal(saved.sessionId, 'sess-1', `assignment.sessionId 应落库，实际 ${JSON.stringify(savedRaw)}`);
    assert.equal(saved.dir, `${workRoot}/${ticketId}-a1`, `assignment.dir 应落库，实际 ${JSON.stringify(savedRaw)}`);

    // ③ worker 回写 ready → stage 派生为 person/review，并入队 relay
    const tool = createReportTool({
      engine: rt.engine,
      ticketId,
      assignmentId: 'a1',
      nextId: () => 'r1',
      now: () => Date.now(),
    });
    const reported = tool.call('ready');
    assert.equal(reported.stage, 'person/review', `期望 stage=person/review，实际 ${reported.stage}`);
    assert.equal(
      rt.repo.tickets.get(ticketId)?.stage,
      'person/review',
      `期望落库 stage=person/review，实际 ${rt.repo.tickets.get(ticketId)?.stage}`,
    );
    assert.equal(rt.repo.reports.latest(ticketId)?.kind, 'ready', '期望 reports.latest 读回 ready');
    assert.equal(count(file, `SELECT COUNT(*) AS n FROM effect WHERE kind = 'relay'`), 1, '期望入队 1 条 relay');

    // ④ 人批准 → close 入队 kaaDone + treeWrite → tick 跑 handler
    const beforeClose = rt.repo.tickets.get(ticketId)!;
    rt.engine.close(beforeClose);
    await rt.tick();
    assert.equal(runs.relay, 1, `期望 relay handler 跑 1 次，实际 ${runs.relay}`);
    assert.equal(runs.kaaDone, 1, `期望 kaaDone 桩跑 1 次，实际 ${runs.kaaDone}`);
    assert.equal(runs.treeWrite, 1, `期望 treeWrite 桩跑 1 次，实际 ${runs.treeWrite}`);
    assert.equal(count(file, 'SELECT COUNT(*) AS n FROM effect'), 0, '所有 effect 应 settle 掉，库里不留行');

    console.log(
      `[K14-1] chain=ticket,report,relay,treeWrite launch=${runs.launch} relay=${runs.relay} kaa=${runs.kaaDone} treeWrite=${runs.treeWrite}`,
    );
  },
);

/* ── K14-2 崩溃恢复：先 claim 再崩 ───────────────────────────────────────── */

test('K14-2 崩溃恢复：子进程 claim 后 exit(137) → 重启重放 1 次且不重复', async (t: TestContext) => {
  const file = tempDbPath();
  let rt: Runtime | undefined;
  t.after(() => {
    closeSafe(rt);
    dropDbFiles(file);
  });

  // 子进程：打开同一库 → enqueue → claimDue（把行置 running）→ 直接 exit(137)，不 settle/retry。
  const storeUrl = pathToFileURL(join(ROOT, 'src/app/store.ts')).href;
  const childCode = `
import { openDb, createRepository } from ${JSON.stringify(storeUrl)};
const db = openDb(${JSON.stringify(file)});
const repo = createRepository(db);
repo.effects.enqueue({ kind: 'treeWrite', key: 'crash-1', payload: '{}', dueAt: 0 });
const claimed = repo.effects.claimDue(0);
if (claimed.length !== 1) {
  console.error('claimDue 应取到 1 行，实际 ' + claimed.length);
  process.exit(3);
}
process.exit(137);
`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(
    res.status,
    137,
    `子进程必须真以 137 退出（模拟崩溃），实际 status=${res.status} signal=${res.signal} stderr=${res.stderr}`,
  );
  assert.equal(
    count(file, `SELECT COUNT(*) AS n FROM effect WHERE state = 'running'`),
    1,
    '崩溃后该行应停在 running（claim 了没 settle）',
  );

  let runs = 0;
  rt = startRuntime({
    dbPath: file,
    gate: allowGate,
    handlers: {
      treeWrite: async () => {
        runs += 1;
      },
    },
  });

  assert.equal(
    rt.recovered.effects,
    1,
    `期望 recovered.effects=1（recoverRunning 把 running 退回 pending），实际 ${rt.recovered.effects}`,
  );

  await rt.tick();
  assert.equal(runs, 1, `重启后第一轮应重放 1 次，实际 ${runs}`);
  assert.equal(count(file, 'SELECT COUNT(*) AS n FROM effect'), 0, '重放成功后 effect 表应为空');

  await rt.tick();
  assert.equal(runs, 1, `不得重复执行：期望仍为 1 次，实际 ${runs}`);

  console.log(`[K14-2] recovered=${rt.recovered.effects} runs=${runs}`);
});

/* ── K14-3 在跑的 assignment 标 interrupted ────────────────────────────── */

test('K14-3 崩溃重启：在跑的 assignment 标 interrupted', async (t: TestContext) => {
  const file = tempDbPath();
  let rt: Runtime | undefined;
  t.after(() => {
    closeSafe(rt);
    dropDbFiles(file);
  });

  // 直接把「上次进程留下的在跑单」写进库（assignment 是 Assignment 对象）。
  const db = openDb(file);
  try {
    db.prepare(
      `INSERT INTO ticket(id, thread_key, stage, mandate, assignment, ended) VALUES(?,?,?,?,?,0)`,
    ).run(
      't1',
      'th-1',
      'working',
      JSON.stringify(MANDATE),
      JSON.stringify({ id: 'a1', ticketId: 't1', state: 'running', dir: '/tmp/x', sessionId: 's1' }),
    );
  } finally {
    db.close();
  }

  rt = startRuntime({ dbPath: file, gate: allowGate });

  // 两处读数先都取出来再一起判红：否则第一条断言失败会遮住第二条的差值。
  const got = rt.repo.tickets.get('t1');
  const state = (got?.assignment as { state?: string } | undefined)?.state;
  const actualRaw = got?.assignment;
  const problems: string[] = [];
  if (rt.recovered.assignments !== 1) {
    problems.push(`recovered.assignments 期望 1，实际 ${rt.recovered.assignments}`);
  }
  if (state !== 'interrupted') {
    problems.push(
      `ticket.assignment.state 期望 'interrupted'，实际 ${JSON.stringify(actualRaw)}（typeof=${typeof actualRaw}）；` +
        `缺：rowToTicket 未 JSON.parse assignment，runtime 按对象读 a.state，读到的却是 TEXT 原样字符串`,
    );
  }
  assert.ok(got !== undefined, 't1 应能读回');
  assert.deepEqual(problems, [], `\n- ${problems.join('\n- ')}`);

  console.log(`[K14-3] recovered=${rt.recovered.assignments} state=${String(state)}`);
});

/* ── K14-4 外部动作不重复 ──────────────────────────────────────────────── */

test('K14-4 外部动作不重复：同 (kind,key) 入队两次 → 1 行、执行 1 次', async (t: TestContext) => {
  const file = tempDbPath();
  let rt: Runtime | undefined;
  t.after(() => {
    closeSafe(rt);
    dropDbFiles(file);
  });

  let runs = 0;
  rt = startRuntime({
    dbPath: file,
    gate: allowGate,
    handlers: {
      treeWrite: async () => {
        runs += 1;
      },
    },
  });

  for (let i = 0; i < 2; i += 1) {
    rt.repo.effects.enqueue({ kind: 'treeWrite', key: 'dup-1', payload: '{}', dueAt: 0 });
  }
  assert.equal(
    count(file, `SELECT COUNT(*) AS n FROM effect WHERE kind = 'treeWrite' AND key = 'dup-1'`),
    1,
    '同 (kind,key) 第二次入队应被唯一索引吞掉，effect 表只 1 行',
  );

  await rt.tick();
  assert.equal(runs, 1, `期望 handler 只被调用 1 次，实际 ${runs}`);

  console.log(`[K14-4] rows=1 runs=${runs}`);
});

/* ── K14-5 schema 版本 ─────────────────────────────────────────────────── */

test('K14-5 schema：SCHEMA_VERSION=3 且 effect.state 是普通列', async (t: TestContext) => {
  const file = tempDbPath();
  t.after(() => dropDbFiles(file));

  assert.equal(SCHEMA_VERSION, 3, `期望 SCHEMA_VERSION=3，实际 ${SCHEMA_VERSION}`);

  const db = openDb(file);
  try {
    const cols = db.prepare('PRAGMA table_info(effect)').all() as { name: string; type: string }[];
    const names = cols.map((c) => c.name);
    const stateCol = cols.find((c) => c.name === 'state');
    assert.ok(stateCol !== undefined, `期望 effect 表有 state 列，实际列=${names.join(',')}`);

    const ddlRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'effect'`).get() as
      | { sql?: string }
      | undefined;
    const ddl = String(ddlRow?.sql ?? '');
    assert.ok(
      !/state\b[^,]*GENERATED/i.test(ddl),
      `state 不应是生成列（table_info 里出现即普通列），实际 DDL=${ddl}`,
    );

    const ver = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    assert.equal(Number(ver?.user_version), 3, `期望库 user_version=3，实际 ${ver?.user_version}`);
  } finally {
    db.close();
  }

  console.log('[K14-5] SCHEMA_VERSION=3 effect.state=column user_version=3');
});
