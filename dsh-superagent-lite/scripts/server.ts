/**
 * scripts/server.ts —— 一个网页：下发任务 + 看后台 worker 路由。零依赖（node:http）。
 *
 *   node scripts/server.ts [--port 7788]
 *   打开 http://127.0.0.1:7788
 *
 * 页面每 1.5 秒拉一次 /api/state；下发走 POST /api/task；取消走 /api/cancel；重跑走 /api/retry。
 *
 * 会话是**真的**：每个 assignment spawn 一个 `dsh --profile <p> --json <任务>`，
 * ndjson 逐行落盘到 assignment 目录（见 src/app/dsh-session.ts）。
 * 想看派给了谁、跑出了什么：GET /api/worker?id=<ticketId>，或页面点工单行展开。
 * 想退回不花钱的假会话：SA_WORKER=fake。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRuntime } from '../src/app/runtime.ts';
import { SessionExecutor, SlotPool } from '../src/app/executor.ts';
import { createDshSessionFactory } from '../src/app/dsh-session.ts';
import type { DshRunRecord } from '../src/app/dsh-session.ts';
import { mkdir } from 'node:fs/promises';
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

const workRoot = join(homedir(), '.dsh', 'superagent-lite', 'work');
const slots = new SlotPool({ capacity: 2, humanExtra: 1 });

/** 运行记录落盘：进程重启后还能从 assignment 目录读回来（不靠内存）。 */
const persistRun = (r: DshRunRecord): void => {
  try {
    mkdirSync(r.dir, { recursive: true });
    const { tail, stderrTail, ...rest } = r;
    void tail;
    void stderrTail;
    writeFileSync(join(r.dir, 'worker.json'), `${JSON.stringify(rest, null, 2)}\n`);
  } catch {
    /* 目录没了就算了 */
  }
};

const fakeFactory = {
  start: async (o: { ticketId: string; dir: string }) => ({
    sessionId: `sess-${o.ticketId}-${Date.now().toString(36)}`,
    dir: o.dir,
  }),
  deliver: async () => {},
  stop: async () => {},
};

// worker 一律带上凭据层：headless 模板把 credentials 关着，不开它就只能是 MISSING_CREDENTIAL
const credPatch = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'credentials.patch.yml');
const dshFactory = createDshSessionFactory({
  extraArgs: ['--patch', credPatch],
  onChange: persistRun,
  onEnd: persistRun,
});
const useFake = process.env.SA_WORKER === 'fake';

const executor = new SessionExecutor({
  slots,
  workRoot,
  factory: useFake ? fakeFactory : dshFactory,
  // 真建目录：之前这里是空实现，assignment 的 dir 从来没被建出来过
  mkdirp: async (d: string) => {
    await mkdir(d, { recursive: true });
  },
});

/** threadKey → 任务正文。executor 只拿得到 threadKey，正文得在这里挂上去。 */
const prompts = new Map<string, string>();

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
        prompt: prompts.get(t.threadKey) ?? t.threadKey,
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

/** 先看内存里的运行记录，再回落到 assignment 目录里的 worker.json（重启后仍可读）。 */
const workerOf = (ticketId: string): DshRunRecord | undefined => {
  const live = dshFactory.snapshot(ticketId);
  if (live !== undefined) return live;
  const t = rt.repo.tickets.get(ticketId);
  const dir = t?.assignment?.dir;
  if (dir === undefined || dir === '') return undefined;
  const file = join(dir, 'worker.json');
  if (!existsSync(file)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(file, 'utf8')) as DshRunRecord;
    // 目录会随 ticket id 复用：记录里的 runId 必须等于这张单当前那个 assignment，
    // 否则就是上一张同名工单留下的旧记录（实测：恢复旧库后 t2 读到了新跑的那次）
    if (t?.assignment?.sessionId !== undefined && rec.runId !== t.assignment.sessionId) return undefined;
    return rec;
  } catch {
    return undefined;
  }
};

/** stage → "为什么需要你"。空串表示不需要人。 */
const WHY: Record<string, string> = {
  'person/delivery': 'worker 说做完了，等你验收',
  'person/answer': 'worker 在等你回答',
  'person/review': 'worker 交了结果，等你审',
  'person/blocked': 'worker 卡住了，等你解除',
};

/** 一次运行的"结论"：答复 > 错误 > 退出码。返回 null 表示还没跑完、什么都还没有。 */
const outcome = (run: DshRunRecord | undefined): string | null => {
  if (run === undefined) return null;
  if ((run.finalText ?? '') !== '') return run.finalText;
  if ((run.error ?? '') !== '') return run.error;
  if (run.exitCode !== null && run.exitCode !== 0) return `退出码 ${run.exitCode}（无 final）`;
  if (run.state === 'done') return '（完成但没有 final 事件）';
  return null;
};

/** 一张单在页面上要能看懂的全部信息：批什么、谁在做、做出什么、为什么找你要决定。 */
const describe = (t: { id: string; threadKey: string; stage?: string; assignment?: { state?: string; sessionId?: string; dir?: string } }) => {
  const run = workerOf(t.id);
  const text = rt.repo.events.textByThread(t.threadKey) ?? '（库里找不到这条需求的原文）';
  const failed = run?.state === 'failed';
  // 四种"需要人"的来源，都要说清是哪种；否则页面上只剩一个按钮，人不知道该批什么
  const never = run === undefined && t.assignment?.state !== 'running';
  const why =
    WHY[t.stage ?? ''] ??
    (failed
      ? 'worker 跑失败了：等你决定「结束」还是重新下发'
      : never
        ? '还没跑起来（重启后中断）：可以「结束」它再重新下发'
        : '');
  // 委托的阶段链：每一步都对得上库里的一个事实，不做"预计进度"这种编造
  const steps = [
    { label: '收到需求', done: true, note: t.threadKey },
    { label: 'Gate 准入', done: true, note: 'auto' },
    { label: '建工单', done: true, note: t.id },
    { label: '占槽派发', done: t.assignment?.state === 'running' || run !== undefined, note: t.assignment?.state ?? '未派' },
    { label: 'worker 执行', done: run !== undefined, note: run === undefined ? '还没起' : `${run.dshSessionId ?? '起会话中'} · ${run.lines} 行` },
    { label: '出结果', done: outcome(run) !== null, note: outcome(run) ?? '还没结果' },
    { label: '结束', done: t.state === 'ended', note: t.state === 'ended' ? '已结束' : '未结束' },
  ];
  return {
    id: t.id,
    text,
    stage: t.stage ?? '',
    steps,
    why,
    needsHuman: why !== '',
    thread: t.threadKey,
    assignment: t.assignment?.state ?? '—',
    worker: run?.state ?? '—',
    workerSession: run?.dshSessionId ?? '—',
    dir: t.assignment?.dir ?? run?.dir ?? '—',
    lines: run?.lines ?? 0,
    result: outcome(run),
    exitCode: run?.exitCode ?? null,
  };
};

const state = () => {
  const open = rt.repo.tickets.open();
  const done = rt.repo.tickets.all().filter((t) => t.state === 'ended');
  const rows = open.map(describe);
  const withRun = rows.filter((r) => r.worker !== '—').length;
  return {
    flow: {
      events: rt.repo.events.pending(500).length + rows.length + done.length,
      tickets: rows.length + done.length,
      dispatched: withRun,
      running: rows.filter((r) => r.worker === 'running').length,
      results: rows.concat(done.map(describe)).filter((r) => typeof r.result === 'string' && r.result !== '').length,
      ended: done.length,
    },
    tickets: rows,
    ended: done.length,
    endedRecent: done.slice(-8).reverse().map((t) => {
      const d = describe(t);
      return { id: d.id, text: d.text, worker: d.worker, result: d.result };
    }),
    // 面板只放"需要人"的：带上原文与原因，否则人只看到一堆按钮不知道该批什么
    panel: rows
      .filter((r) => r.needsHuman)
      .map((r) => `- ${r.id} · ${r.text} → ${r.why}`)
      .join('\n'),
    slots: { used: slots.used, capacity: slots.capacity },
    live: executor.live,
    pendingEvents: rt.repo.events.pending(50).length,
    dueEffects: rt.repo.effects.dueCount(Date.now()),
    workerMode: useFake ? 'fake' : 'dsh',
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
    if (req.method === 'GET' && url.pathname === '/api/worker') {
      const id = url.searchParams.get('id') ?? '';
      const run = workerOf(id);
      if (run === undefined) return json(404, { error: '这张工单还没有 worker 记录' });
      return json(200, run);
    }
    if (req.method === 'POST' && url.pathname === '/api/task') {
      const b = await body();
      const text = String(b.text ?? '').trim();
      if (text === '') return json(400, { error: 'text 为空' });
      const ev = manualEvent({ id: `m-${Date.now()}`, text }, Date.now());
      prompts.set(ev.threadKey, text);
      rt.repo.events.put(ev);
      log(`收到需求：${text}`);
      await rt.tick();
      return json(200, state());
    }
    // 取消：停 worker + 结束工单（原来叫「批准」，名不副实）
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const b = await body();
      const t = rt.repo.tickets.get(String(b.id ?? ''));
      if (t === undefined) return json(404, { error: '没有这张工单' });
      // 先停会话释放槽位，再结束工单；否则 approve 之后槽位会一直占着（每批准一个漏一个）
      if (t.assignment !== undefined) await executor.stop(t, t.assignment, 'approved');
      rt.engine.close(t);
      log(`人取消 ${t.id}（会话已停、槽位已释放）`);
      await rt.tick();
      return json(200, state());
    }
    // 重跑：把原任务按原样再下发一次（新 event → 新工单 → 新 worker），旧单先结束
    if (req.method === 'POST' && url.pathname === '/api/retry') {
      const b = await body();
      const t = rt.repo.tickets.get(String(b.id ?? ''));
      if (t === undefined) return json(404, { error: '没有这张工单' });
      const text = prompts.get(t.threadKey) ?? rt.repo.events.textByThread(t.threadKey);
      if (text === undefined || text === '') return json(400, { error: '找不到这张单的任务原文，无法重跑' });
      if (t.assignment !== undefined) await executor.stop(t, t.assignment, 'retry');
      rt.engine.close(t);
      const ev = manualEvent({ id: `m-${Date.now()}`, text }, Date.now());
      prompts.set(ev.threadKey, text);
      rt.repo.events.put(ev);
      log(`重跑 ${t.id}：${text}`);
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
