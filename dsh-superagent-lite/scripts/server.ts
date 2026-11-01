/**
 * scripts/server.ts —— 一个网页：下发任务 + 看后台 worker 路由。零依赖（node:http）。
 *
 *   node scripts/server.ts [--port 7788]
 *   打开 http://127.0.0.1:7788
 *
 * 页面每 1.5 秒拉一次 /api/state；下发任务走 POST /api/task；批准走 POST /api/approve。
 * 会话用的是**假工厂**（只生成 sessionId 与目录），所以这里看到的路由是编排层真实的
 * 派发结果，不是真的 dsh 会话——真接线见 src/app/executor.ts 的 SessionFactory。
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startRuntime } from '../src/app/runtime.ts';
import { SessionExecutor, SlotPool } from '../src/app/executor.ts';
import { manualEvent } from '../src/sources/manual.ts';
import { renderPanel } from '../src/panel/view.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt;
};
const port = Number(arg('--port', '7788'));
const dbPath = process.env.SA_DB ?? join(homedir(), '.dsh', 'superagent-lite', 'sa.db');
mkdirSync(dirname(dbPath), { recursive: true });

const gate = {
  check: () => ({
    allowed: true as const,
    mandate: { policyVersion: 'v1', scope: 'web', strength: 'auto', basis: ['页面提交即准入'] },
  }),
};

const slots = new SlotPool({ capacity: 2, humanExtra: 1 });
const executor = new SessionExecutor({
  slots,
  workRoot: join(homedir(), '.dsh', 'superagent-lite', 'work'),
  factory: {
    start: async (o) => ({ sessionId: `sess-${o.ticketId}-${Date.now().toString(36)}`, dir: o.dir }),
    deliver: async () => {},
    stop: async () => {},
  },
  mkdirp: async () => {},
});

const events: string[] = [];
const log = (m: string) => {
  events.unshift(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  events.splice(30);
};

const rt = startRuntime({
  dbPath,
  gate,
  handlers: {
    launch: async (row) => {
      // handler 收到的是整行 EffectRow（见 effects.ts 的 EffectHandler），不是 payload
      const p = JSON.parse(row.payload) as { ticketId?: string };
      const t = p.ticketId === undefined ? undefined : rt.repo.tickets.get(p.ticketId);
      if (t === undefined) return;
      const a = await executor.start(t, {
        id: `a-${t.id}`,
        ticketId: t.id,
        state: 'pending',
        dir: '',
        sessionId: '',
      });
      rt.repo.tickets.put({ ...t, assignment: a });
      log(`launch ${t.id} → ${a.sessionId}（槽位 ${slots.used}/${slots.capacity}）`);
    },
    relay: async () => log('relay 需要人看'),
    kaaDone: async () => log('kaaDone（桩）'),
    treeWrite: async () => log('treeWrite（桩）'),
    reply: async () => log('reply（桩）'),
    deliver: async () => log('deliver（桩）'),
  },
});

const endedLog: string[] = [];
const endedCount = (): number => endedLog.length;
const endedRecent = (): string[] => endedLog.slice(0, 5);

const state = () => {
  const tickets = rt.repo.tickets.open().map((t) => ({
    id: t.id,
    stage: t.stage ?? '',
    thread: t.threadKey,
    assignment: t.assignment?.state ?? '—',
    session: t.assignment?.sessionId ?? '—',
    dir: t.assignment?.dir ?? '—',
  }));
  const endedRows = rt.repo.atomic(() => 0);
  void endedRows;
  return {
    tickets,
    ended: endedCount(),
    endedRecent: endedRecent(),
    panel: renderPanel(rt.repo.tickets.open()),
    slots: { used: slots.used, capacity: slots.capacity },
    live: executor.live,
    pendingEvents: rt.repo.events.pending(50).length,
    dueEffects: rt.repo.effects.claimDue(0).length,
    events,
  };
};

// 页面单独放在 page.ts：它要能被 scripts/check-page.ts 单独验证（经典脚本不能有顶层 await）
import { page } from './page.ts';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };
  const body = async (): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  void (async () => {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state());
    if (req.method === 'POST' && url.pathname === '/api/task') {
      const b = await body();
      const text = String(b.text ?? '').trim();
      if (text === '') return json(400, { error: 'text 为空' });
      rt.repo.events.put(manualEvent({ id: `m-${Date.now()}`, text }, Date.now()));
      log(`收到需求：${text}`);
      await rt.tick();
      return json(200, state());
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const b = await body();
      const t = rt.repo.tickets.get(String(b.id ?? ''));
      if (t === undefined) return json(404, { error: '没有这张工单' });
      // 先停会话释放槽位，再结束工单；否则 approve 之后槽位会一直占着（每批准一个漏一个）
      if (t.assignment !== undefined) await executor.stop(t, t.assignment, 'approved');
      rt.engine.close(t);
      endedLog.unshift(`${t.id} ${t.threadKey} @${new Date().toISOString().slice(11, 19)}`);
      log(`人批准 ${t.id}（会话已停、槽位已释放）`);
      await rt.tick();
      return json(200, state());
    }
    json(404, { error: 'not found' });
  })().catch((e: unknown) => json(500, { error: String(e) }));
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`控制台: http://127.0.0.1:${port}\n库: ${dbPath}\n`);
  setInterval(() => void rt.tick(), 2000).unref();
});
