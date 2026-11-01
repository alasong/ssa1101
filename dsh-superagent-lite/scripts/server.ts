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

const state = () => {
  const tickets = rt.repo.tickets.open().map((t) => ({
    id: t.id,
    stage: t.stage ?? '',
    thread: t.threadKey,
    assignment: t.assignment?.state ?? '—',
    session: t.assignment?.sessionId ?? '—',
    dir: t.assignment?.dir ?? '—',
  }));
  return {
    tickets,
    panel: renderPanel(rt.repo.tickets.open()),
    slots: { used: slots.used, capacity: slots.capacity },
    live: executor.live,
    pendingEvents: rt.repo.events.pending(50).length,
    dueEffects: rt.repo.effects.claimDue(0).length,
    events,
  };
};

const page = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>superagent-lite 控制台</title>
<style>
 body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
 header{padding:14px 20px;border-bottom:1px solid #262a33;display:flex;gap:16px;align-items:baseline}
 h1{font-size:16px;margin:0;font-weight:600}
 .muted{color:#8b93a1;font-size:12px}
 main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 20px}
 section{background:#161a21;border:1px solid #262a33;border-radius:8px;padding:14px}
 h2{font-size:13px;margin:0 0 10px;color:#9fb0c8;font-weight:600;letter-spacing:.04em}
 input,button{font:inherit;border-radius:6px;border:1px solid #333a46;background:#0f1115;color:#e6e6e6;padding:8px 10px}
 input{width:100%;box-sizing:border-box}
 button{cursor:pointer;background:#1f6feb;border-color:#1f6feb}
 button.ghost{background:transparent;border-color:#333a46;padding:3px 8px;font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #222731;vertical-align:top}
 th{color:#8b93a1;font-weight:500}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#9fd0ff}
 pre{white-space:pre-wrap;margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#b9c4d4}
 .kpi{display:flex;gap:14px;margin-bottom:10px;font-size:12.5px}
 .kpi b{color:#7ee787}
 .empty{color:#8b93a1;font-size:13px}
 .row{display:flex;gap:8px}
 .row input{flex:1}
</style>
<header><h1>superagent-lite 控制台</h1>
<span class="muted" id="meta">连接中…</span></header>
<main>
 <section>
  <h2>下发任务</h2>
  <div class="row"><input id="text" placeholder="比如：把登录页按钮改成蓝色" autocomplete="off">
  <button onclick="submitTask()">下发</button></div>
  <p class="muted">回车也可提交 · 走 manual 源 → 事件 → Gate → 工单</p>
  <h2 style="margin-top:18px">需要人处理</h2>
  <pre id="panel">（空）</pre>
 </section>
 <section>
  <h2>Worker 路由</h2>
  <div class="kpi" id="kpi"></div>
  <table><thead><tr><th>工单</th><th>阶段</th><th>线程</th><th>会话</th><th>槽位</th><th></th></tr></thead>
  <tbody id="tickets"><tr><td colspan="6" class="empty">还没有工单</td></tr></tbody></table>
  <h2 style="margin-top:18px">最近事件</h2>
  <pre id="log">—</pre>
 </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const r = await fetch(path, body ? {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body)} : undefined);
  return r.json();
}
async function submitTask() {
  const text = $('text').value.trim();
  if (!text) return;
  $('text').value = '';
  await api('/api/task', {text});
  render(await api('/api/state'));
}
async function approve(id) { await api('/api/approve', {id}); render(await api('/api/state')); }
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function render(s) {
  $('meta').textContent = '槽位 ' + s.slots.used + '/' + s.slots.capacity + ' · 活跃会话 ' + s.live +
    ' · 待处理事件 ' + s.pendingEvents + ' · 到期副作用 ' + s.dueEffects;
  $('panel').textContent = s.panel || '（空）';
  $('log').textContent = s.events.length ? s.events.join('\\n') : '—';
  $('kpi').innerHTML = '<span>工单 <b>' + s.tickets.length + '</b></span><span>需要人 <b>' +
    (s.panel ? s.panel.split('\\n').filter(l=>l.trim().startsWith('-')).length : 0) + '</b></span>';
  const tb = $('tickets');
  if (!s.tickets.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">还没有工单</td></tr>'; return; }
  tb.innerHTML = s.tickets.map(t => '<tr><td><code>'+esc(t.id)+'</code></td><td>'+esc(t.stage)+
    '</td><td><code>'+esc(t.thread)+'</code></td><td><code>'+esc(t.session)+'</code></td><td>'+esc(t.assignment)+
    '</td><td><button class="ghost" onclick="approve(\\''+esc(t.id)+'\\')">批准</button></td></tr>').join('');
}
$('text').addEventListener('keydown', e => { if (e.key === 'Enter') submitTask(); });
render(await api('/api/state'));
setInterval(async () => render(await api('/api/state')), 1500);
</script></html>`;

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
      rt.engine.close(t);
      log(`人批准 ${t.id}`);
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
