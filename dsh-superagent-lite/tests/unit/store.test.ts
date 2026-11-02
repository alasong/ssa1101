/**
 * tests/unit/store.test.ts —— SQLite 仓储（app/store.ts）的规格测试。
 * 规格来源：设计文档 §3（R01 / R08 / R18），不是从实现反推。
 * 每条例独立开关库、自清临时文件；断言按规格写死，不符就红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';

import { DatabaseSync } from 'node:sqlite';

import {
  SCHEMA_VERSION,
  TABLES,
  SchemaTooNewError,
  openDb,
  migrate,
  listTables,
  hasActiveIndex,
} from '../../src/app/store.ts';

const SORTED_TABLES = [...TABLES].sort();

/** /tmp 下的临时库路径；WAL 模式会额外产生 -wal / -shm，一并清理。 */
function tempDbPath(): string {
  return `/tmp/store-test-${randomBytes(8).toString('hex')}.db`;
}

function cleanupDbFiles(file: string): void {
  for (const p of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number };
  return Number(row?.user_version ?? 0);
}

/** 每个用例一个全新的内存库，用例结束关闭（不依赖执行顺序）。 */
function memoryDb(t: { after: (fn: () => void) => void }): DatabaseSync {
  const db = openDb(':memory:');
  t.after(() => db.close());
  return db;
}

// ── 规格 1：6 张表全建，且不多出业务表 ──────────────────────────────
test('规格1 建表：listTables 恰好等于 TABLES（不多不少）', (t) => {
  const db = memoryDb(t);
  assert.deepEqual(listTables(db), SORTED_TABLES, '表集合必须与 TABLES 常量完全一致（含顺序无关）');
  assert.equal(listTables(db).length, 6, '业务表必须恰好 6 张');
});

// ── 规格 2：UNIQUE(external_id)（R01 幂等） ──────────────────────────
test('R01 UNIQUE(external_id) 拒绝重复事件，且只留 1 行', (t) => {
  const db = memoryDb(t);
  const insert = db.prepare(
    `INSERT INTO event (id, source, external_id, at, actor, text, thread_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('e1', 'mail', 'ext-1', 1000, 'alice', 'hello', 't-1');

  // 幂等语义：同一 external_id 第二次写入必须被唯一约束拒绝。
  assert.throws(
    () => insert.run('e2', 'mail', 'ext-1', 1001, 'alice', 'hello again', 't-1'),
    /UNIQUE|constraint/i,
  );

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
  assert.equal(n, 1, '被拒绝的重复行不得落库');
});

// ── 规格 3：UNIQUE(kind,key)（R08） ────────────────────────────────
test('R08 UNIQUE(kind,key) 拒绝重复 effect', (t) => {
  const db = memoryDb(t);
  const insert = db.prepare(
    `INSERT INTO effect (kind, key, payload, due_at) VALUES (?, ?, ?, ?)`,
  );
  insert.run('send', 'k-1', '{}', 1000);

  assert.throws(
    () => insert.run('send', 'k-1', '{}', 2000),
    /UNIQUE|constraint/i,
  );

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM effect').get() as { n: number };
  assert.equal(n, 1, '重复 (kind,key) 不得落库');
});

test('R08 UNIQUE(kind,key) 允许不同 key 共存', (t) => {
  const db = memoryDb(t);
  const insert = db.prepare(
    `INSERT INTO effect (kind, key, payload, due_at) VALUES (?, ?, ?, ?)`,
  );
  insert.run('send', 'k-1', '{}', 1000);
  insert.run('send', 'k-2', '{}', 2000);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM effect').get() as { n: number };
  assert.equal(n, 2, '不同 key 必须可以共存');
});

// ── 规格 4：active 生成列 + 索引（R18） ────────────────────────────
test('R18 ticket.active 是生成列且 hasActiveIndex 为 true', (t) => {
  const db = memoryDb(t);

  // 注：SQLite 的 `PRAGMA table_info` 不列出生成列，必须用 `PRAGMA table_xinfo`
  // 才能看到带 hidden 标记的生成列（实测 table_info 只返回 id/ended/assignment）。
  const cols = db.prepare('PRAGMA table_xinfo(ticket)').all() as {
    name: string;
    hidden: number;
  }[];
  const active = cols.find((c) => c.name === 'active');
  assert.ok(active, 'ticket 必须有 active 列（table_xinfo）');
  assert.ok(
    active.hidden === 2 || active.hidden === 3,
    `active 必须是生成列（hidden 为 2 或 3），实际 hidden=${active.hidden}`,
  );

  assert.equal(hasActiveIndex(db), true, '活动工作索引 ix_ticket_active 必须存在');
});

test('R18 ticket.active 由 ended/assignment 计算', (t) => {
  const db = memoryDb(t);
  const insert = db.prepare(
    `INSERT INTO ticket (id, stage, mandate, assignment, ended) VALUES (?, ?, ?, ?, ?)`,
  );

  insert.run('tk-active', 'work', 'm-1', 'a1', 0);
  insert.run('tk-ended', 'done', 'm-2', 'a2', 1);

  const rows = db.prepare('SELECT id, active FROM ticket').all() as {
    id: string;
    active: number;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r.active]));
  assert.equal(byId.get('tk-active'), 1, '未结束且有 assignment → active=1');
  assert.equal(byId.get('tk-ended'), 0, 'ended=1 → active=0');
});

// ── 规格 5：版本守卫（R18 核心） ─────────────────────────────────
test('R18 版本守卫：库版本高于代码版本时抛 SchemaTooNewError', (t) => {
  const file = tempDbPath();
  t.after(() => cleanupDbFiles(file));

  const db = openDb(file);
  db.exec('PRAGMA user_version = 99');
  db.close();

  let caught: unknown;
  try {
    openDb(file);
  } catch (e) {
    caught = e;
  }

  assert.ok(caught instanceof SchemaTooNewError, `期望抛 SchemaTooNewError，实际 ${caught}`);
  assert.equal(caught.dbVersion, 99);
  assert.equal(caught.codeVersion, SCHEMA_VERSION);
});

test('R18 版本守卫：同版本 openDb 成功且连开两次不重复建表', (t) => {
  const file = tempDbPath();
  t.after(() => cleanupDbFiles(file));

  const first = openDb(file);
  assert.equal(readUserVersion(first), SCHEMA_VERSION);
  first.close();

  // 第二次打开：版本相等，不得因重复建表而报错。
  const second = openDb(file);
  t.after(() => second.close());

  assert.deepEqual(listTables(second), SORTED_TABLES);
  assert.equal(readUserVersion(second), SCHEMA_VERSION);
});

// ── 规格 6：幂等迁移 ─────────────────────────────────────────────
test('规格6 幂等迁移：同一库文件连续 openDb 两次仍 6 张表且版本不变', (t) => {
  const file = tempDbPath();
  t.after(() => cleanupDbFiles(file));

  const first = openDb(file);
  first.close();

  const second = openDb(file);
  t.after(() => second.close());

  assert.deepEqual(listTables(second), SORTED_TABLES);
  assert.equal(readUserVersion(second), SCHEMA_VERSION);

  // 再显式跑一次 migrate：同一版本应直接返回，不报错、不改版本。
  migrate(second);
  assert.equal(readUserVersion(second), SCHEMA_VERSION);
});

// ── 规格 9：hasPending 只读、不 claim（页面用它区分「排队中」与「真中断」） ──
test('规格 9 / hasPending：pending/running 为真，settle 之后为假，且查询不改 state', async () => {
  const { createRepository } = await import('../../src/app/store.ts');
  const file = tempDbPath();
  const db = openDb(file);
  migrate(db);
  try {
    const repo = createRepository(db);
    repo.effects.enqueue({ kind: 'launch', key: 't1', payload: '{}', dueAt: 0 });

    assert.equal(repo.effects.hasPending('launch', 't1'), true, '排队中的单必须被认为"还会跑"');
    assert.equal(repo.effects.hasPending('launch', 't2'), false, '没有这条就是没有');
    assert.equal(repo.effects.dueCount(10), 1, 'hasPending 不能把行标成 running（那会让它不再到期）');

    const rows = repo.effects.claimDue(10);
    assert.equal(rows.length, 1);
    assert.equal(repo.effects.hasPending('launch', 't1'), true, 'claim 之后仍在跑，算未了结');
    repo.effects.settle(rows[0].id);
    assert.equal(repo.effects.hasPending('launch', 't1'), false, 'settle 之后就不算未了结了');
  } finally {
    db.close();
    cleanupDbFiles(file);
  }
});
