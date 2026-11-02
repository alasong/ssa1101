/**
 * app/store.ts —— SQLite 事务与仓储（K04，预算 120 行）。
 * 单库单进程锁；schema 只增不删（R18）。
 * 三条硬约束直接落到 DDL 上：UNIQUE(external_id)→R01、UNIQUE(kind,key)→R08、生成列 active→R18。
 */
import { DatabaseSync } from 'node:sqlite';
import type { Assignment, EffectKind, Event, Report, Ticket } from '../core/model.ts';
import type { Repository } from '../core/ports.ts';

/** 代码认识的 schema 版本。库里的 `PRAGMA user_version` 比它新 = 拒绝启动。 */
export const SCHEMA_VERSION = 3;

export class SchemaTooNewError extends Error {
  readonly dbVersion: number;
  readonly codeVersion: number;

  constructor(dbVersion: number, codeVersion: number) {
    super(
      `库版本 ${dbVersion} 高于代码版本 ${codeVersion}：这是旧代码遇到新库，拒绝启动（R18）。` +
        `升级代码，或显式迁移——不要"打个日志继续跑"。`,
    );
    this.name = 'SchemaTooNewError';
    this.dbVersion = dbVersion;
    this.codeVersion = codeVersion;
  }
}

/** 建表语句。**只增**：加列用 ALTER TABLE ADD COLUMN，不改不删已发布的列。 */
const DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS event (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     external_id TEXT NOT NULL,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     text TEXT NOT NULL,
     thread_key TEXT NOT NULL,
     disposition TEXT NOT NULL DEFAULT 'new'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_event_external ON event(external_id)`, // R01
  `CREATE INDEX IF NOT EXISTS ix_event_at ON event(at)`,

  `CREATE TABLE IF NOT EXISTS thread (
     key TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     cursor TEXT,
     meta TEXT NOT NULL DEFAULT '{}'
   )`,

  `CREATE TABLE IF NOT EXISTS ticket (
     id TEXT PRIMARY KEY,
     thread_key TEXT NOT NULL DEFAULT '',
     stage TEXT NOT NULL,
     mandate TEXT NOT NULL,
     dir TEXT,
     session TEXT,
     assignment TEXT,
     follows TEXT NOT NULL DEFAULT '[]',
     ended INTEGER NOT NULL DEFAULT 0,
     active INTEGER GENERATED ALWAYS AS (ended = 0 AND assignment IS NOT NULL) VIRTUAL
   )`, // 生成列 active → R18
  `CREATE INDEX IF NOT EXISTS ix_ticket_active ON ticket(active)`,

  `CREATE TABLE IF NOT EXISTS effect (
     kind TEXT NOT NULL,
     key TEXT NOT NULL,
     payload TEXT NOT NULL,
     due_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     state TEXT NOT NULL DEFAULT 'pending'
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_effect_kind_key ON effect(kind, key)`, // R08
  `CREATE INDEX IF NOT EXISTS ix_effect_due ON effect(due_at)`,

  `CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY,
     channel TEXT NOT NULL,
     text TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     dropped_reason TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** 6 张表的名字，给测试与面板核对用（少一张就是 schema 漂了）。 */
export const TABLES = ['event', 'thread', 'ticket', 'effect', 'outbox', 'kv'] as const;

function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * 打开库并迁移。版本比代码新时**抛错**而不是降级——降级会让新库的列被旧代码误写。
 * @param file 库文件路径；':memory:' 给测试用
 */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    const v = readVersion(db);
    if (v > SCHEMA_VERSION) throw new SchemaTooNewError(v, SCHEMA_VERSION);
    migrate(db, v);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

/** 从当前版本迁到 SCHEMA_VERSION。幂等：DDL 全是 IF NOT EXISTS。 */
export function migrate(db: DatabaseSync, from = readVersion(db)): void {
  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from, SCHEMA_VERSION);
  if (from === SCHEMA_VERSION) return;
  db.exec('BEGIN');
  try {
    for (const stmt of DDL) db.exec(stmt);
    // v1 → v2：老库补 thread_key（CREATE TABLE IF NOT EXISTS 不会补列）
    if (from === 1) {
      const cols = db.prepare(`PRAGMA table_info(ticket)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'thread_key')) {
        db.exec(`ALTER TABLE ticket ADD COLUMN thread_key TEXT NOT NULL DEFAULT ''`);
      }
    }
    // v2 → v3：effect 补 state。没有这一列，崩溃恢复分不清"已领取在跑"与"还没到期"，
    // 只能靠 30s 租约干等——K14 的 kill -9 实测就是冲这条去的。
    if (from <= 2) {
      const cols = db.prepare(`PRAGMA table_info(effect)`).all() as { name: string }[];
      if (!cols.some((c) => c.name === 'state')) {
        db.exec(`ALTER TABLE effect ADD COLUMN state TEXT NOT NULL DEFAULT 'pending'`);
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 现存表名（升序）。判据用：TABLES 必须逐项命中。 */
export function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** 是否存在活动工作索引（R18 的"活动工作查询走索引"）。 */
export function hasActiveIndex(db: DatabaseSync): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_ticket_active'`)
    .all() as { name: string }[];
  return rows.length === 1;
}


/* ------------------------------------------------------------------ *
 * Repository 实现（K06 接线用；详设 §3 的"SQLite 事务与仓储"就落在这里）
 * 只做两件事：事务边界 + 六张表的读写。业务判定一律在 core/engine.ts。
 * ------------------------------------------------------------------ */

/** 把一行 ticket 读成 Ticket。v1 只持久化这几个字段（K03 已记账的那四个判定输入不落库）。 */
function rowToTicket(r: any): Ticket {
  return {
    id: String(r.id),
    threadKey: String(r.thread_key ?? ''),
    mandate: JSON.parse(String(r.mandate)),
    createdAt: Number(r.created_at ?? 0),
    state: Number(r.ended) === 1 ? 'ended' : 'open',
    stage: String(r.stage),
    assignment: r.assignment == null ? undefined : (JSON.parse(String(r.assignment)) as Assignment),
  };
}

/**
 * 建仓储。`atomic` 用 BEGIN IMMEDIATE / COMMIT / ROLLBACK —— 这不是可选项：
 * Engine 的 intake 先写 event 再调 Gate，没有回滚就会留下"事件在、单没建"的半成品。
 */
export function createRepository(db: DatabaseSync): Repository {
  let depth = 0;
  const kv = (key: string, value?: string): string | undefined => {
    if (value === undefined) {
      const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    }
    db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    return undefined;
  };

  return {
    atomic<T>(f: () => T): T {
      if (depth > 0) return f(); // 已在事务里：跟随外层，不嵌套 BEGIN
      db.exec('BEGIN IMMEDIATE');
      depth += 1;
      try {
        const out = f();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      } finally {
        depth -= 1;
      }
    },
    events: {
      put(e) {
        db.prepare(
          `INSERT INTO event(id, source, external_id, at, actor, text, thread_key, disposition)
           VALUES(?,?,?,?,?,?,?, 'new') ON CONFLICT(external_id) DO NOTHING`,
        ).run(e.id, e.source, e.externalId, e.at, e.actor, e.text, e.threadKey);
      },
      /** 按 thread 取最近一条原文：页面上「你在批什么」就靠它（重启后仍在）。 */
      textByThread(threadKey) {
        const r = db
          .prepare(`SELECT text FROM event WHERE thread_key = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
          .get(threadKey) as any;
        return r === undefined ? undefined : String(r.text);
      },
      byExternalId(id) {
        const r = db.prepare('SELECT * FROM event WHERE external_id = ?').get(id) as any;
        return r === undefined ? undefined : (rowToEvent(r) as Event);
      },
      pending(limit) {
        const rows = db.prepare(`SELECT * FROM event WHERE disposition = 'new' ORDER BY at, id LIMIT ?`).all(limit) as any[];
        return rows.map(rowToEvent);
      },
      dispose(id, disposition) {
        db.prepare('UPDATE event SET disposition = ? WHERE id = ?').run(disposition, id);
      },
    },
    tickets: {
      put(t) {
        db.prepare(
          `INSERT INTO ticket(id, thread_key, stage, mandate, assignment, ended)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET stage=excluded.stage, mandate=excluded.mandate,
             assignment=excluded.assignment, ended=excluded.ended, thread_key=excluded.thread_key`,
        ).run(
          t.id,
          t.threadKey,
          t.stage ?? 'working/queued',
          JSON.stringify(t.mandate),
          t.assignment === undefined ? null : JSON.stringify(t.assignment),
          t.state === 'ended' ? 1 : 0,
        );
      },
      get(id) {
        const r = db.prepare('SELECT * FROM ticket WHERE id = ?').get(id) as any;
        return r === undefined ? undefined : rowToTicket(r);
      },
      open() {
        return (db.prepare(`SELECT * FROM ticket WHERE ended = 0`).all() as any[]).map(rowToTicket);
      },
      // 全表（含已结束）。id 分配必须看全表：只看 open() 会让重启后重新从 t1 发号，
      // 撞上已结束的同名工单 —— put() 是 ON CONFLICT DO UPDATE，会把旧行整条覆盖掉。
      all() {
        return (db.prepare(`SELECT * FROM ticket`).all() as any[]).map(rowToTicket);
      },
    },
    reports: {
      append(r) {
        const seq = Number(kv(`report-seq:${r.ticketId}`) ?? '0') + 1;
        kv(`report-seq:${r.ticketId}`, String(seq));
        kv(`report:${r.ticketId}:${String(seq).padStart(6, '0')}`, JSON.stringify(r));
      },
      latest(ticketId) {
        const seq = Number(kv(`report-seq:${ticketId}`) ?? '0');
        if (seq === 0) return undefined;
        const raw = kv(`report:${ticketId}:${String(seq).padStart(6, '0')}`);
        return raw === undefined ? undefined : (JSON.parse(raw) as Report);
      },
    },
    effects: {
      enqueue(e) {
        db.prepare(
          `INSERT INTO effect(kind, key, payload, due_at, attempts) VALUES(?,?,?,?,0)
           ON CONFLICT(kind, key) DO NOTHING`,
        ).run(e.kind, e.key, e.payload, e.dueAt);
      },
      /** 只数不动：面板轮询用它。用 claimDue 数会让面板把行标成 running（实测过）。 */
      dueCount(now) {
        const r = db
          .prepare(`SELECT COUNT(*) AS n FROM effect WHERE due_at <= ? AND state = 'pending'`)
          .get(now) as any;
        return Number(r.n);
      },
      claimDue(now) {
        const rows = db
          .prepare(`SELECT rowid AS rid, * FROM effect WHERE due_at <= ? AND state = 'pending' ORDER BY due_at, rowid`)
          .all(now) as any[];
        // 先 claim 再执行：取中就把 state 置 running，并把 due_at 推到租约到期兜底
        // （万一进程没走到 settle/retry 就死了，recoverRunning 会按 state 把它退回来）。
        const lease = now + 30_000;
        for (const r of rows) {
          db.prepare(`UPDATE effect SET state = 'running', due_at = ? WHERE rowid = ?`).run(lease, r.rid);
        }
        return rows.map((r) => ({
          id: String(r.rid),
          kind: r.kind as EffectKind,
          key: String(r.key),
          payload: String(r.payload),
          attempts: Number(r.attempts),
          nextAt: lease,
          state: 'running' as const,
        }));
      },
      settle(id) {
        db.prepare('DELETE FROM effect WHERE rowid = ?').run(Number(id));
      },
      retry(id, attempts, nextAt, error) {
        db.prepare(`UPDATE effect SET attempts = ?, due_at = ?, last_error = ?, state = 'pending' WHERE rowid = ?`)
          .run(attempts, nextAt, error, Number(id));
      },
      fail(id, error) {
        // 终态：把 due_at 推到"永不"（而不是只写 last_error）。只写错误不改 due_at 的话，
        // 30s claim 租约一到期，同一行会被再取出来无限重跑——K13 的 T09 就是这么做红的。
        db.prepare(`UPDATE effect SET last_error = ?, due_at = ?, state = 'failed' WHERE rowid = ?`)
          .run(error, Number.MAX_SAFE_INTEGER, Number(id));
      },
      recoverRunning() {
        // 上个进程 claim 了但没走完 settle/retry 的行：退回 pending 并立刻到期，
        // 所以重启后的第一轮 pass 就会重放，不用等 30s 租约。
        const info = db
          .prepare(`UPDATE effect SET state = 'pending', due_at = 0 WHERE state = 'running'`)
          .run() as { changes?: number };
        return Number(info.changes ?? 0);
      },
    },
  };
}

function rowToEvent(r: any): Event {
  return {
    id: String(r.id),
    source: String(r.source),
    externalId: String(r.external_id),
    at: Number(r.at),
    actor: String(r.actor),
    text: String(r.text),
    threadKey: String(r.thread_key),
    channel: 'goal-tree',
  };
}
