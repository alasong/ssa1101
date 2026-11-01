/**
 * scripts/page.ts —— 控制台的 HTML（从 server.ts 拆出来，为的是能被单独验证）。
 *
 * 纪律：页面脚本是**经典脚本**（没有 type=module），所以
 *   ① 不能有顶层 `await`（浏览器直接 SyntaxError，整个脚本不执行 → 按钮全是死的）；
 *   ② 内联 `onclick` 只能调到**全局**函数，所以两个入口显式挂到 window 上。
 * 这两条由 scripts/check-page.ts 机检，改这里的 JS 记得跑它。
 */
export const page = `<!doctype html><html lang="zh"><meta charset="utf-8">
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
 #err{color:#ff7b72;font-size:12.5px;margin-top:8px;white-space:pre-wrap}
</style>
<header><h1>superagent-lite 控制台</h1>
<span class="muted" id="meta">连接中…</span></header>
<main>
 <section>
  <h2>下发任务</h2>
  <div class="row"><input id="text" placeholder="比如：把登录页按钮改成蓝色" autocomplete="off">
  <button id="send">下发</button></div>
  <p class="muted">回车也可提交 · 走 manual 源 → 事件 → Gate → 工单</p>
  <div id="err"></div>
  <h2 style="margin-top:18px">需要人处理</h2>
  <pre id="panel">（空）</pre>
 </section>
 <section>
  <h2>Worker 路由</h2>
  <div class="kpi" id="kpi"></div>
  <table><thead><tr><th>工单</th><th>阶段</th><th>线程</th><th>会话</th><th>状态</th><th></th></tr></thead>
  <tbody id="tickets"><tr><td colspan="6" class="empty">还没有工单</td></tr></tbody></table>
  <h2 style="margin-top:18px">最近事件</h2>
  <pre id="log">—</pre>
 </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  function showErr(e) {
    $('err').textContent = '出错：' + (e && e.message ? e.message : String(e));
  }

  async function api(path, body) {
    var init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined;
    var r = await fetch(path, init);
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; });
  }

  function render(s) {
    $('meta').textContent = '槽位 ' + s.slots.used + '/' + s.slots.capacity + ' · 活跃会话 ' + s.live +
      ' · 待处理事件 ' + s.pendingEvents + ' · 到期副作用 ' + s.dueEffects;
    $('panel').textContent = s.panel || '（空）';
    $('log').textContent = s.events.length ? s.events.join('\\n') : '—';
    var needHuman = s.panel ? s.panel.split('\\n').filter(function (l) { return l.trim().indexOf('- ') === 0; }).length : 0;
    $('kpi').innerHTML = '<span>工单 <b>' + s.tickets.length + '</b></span><span>需要人 <b>' + needHuman + '</b></span>';
    var tb = $('tickets');
    if (!s.tickets.length) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">还没有工单</td></tr>';
      return;
    }
    tb.innerHTML = s.tickets.map(function (t) {
      return '<tr><td><code>' + esc(t.id) + '</code></td><td>' + esc(t.stage) +
        '</td><td><code>' + esc(t.thread) + '</code></td><td><code>' + esc(t.session) +
        '</code></td><td>' + esc(t.assignment) +
        '</td><td><button class="ghost" data-approve="' + esc(t.id) + '">批准</button></td></tr>';
    }).join('');
  }

  async function refresh() {
    try { render(await api('/api/state')); $('err').textContent = ''; }
    catch (e) { showErr(e); }
  }

  async function submitTask() {
    var text = $('text').value.trim();
    if (!text) return;
    try {
      $('text').value = '';
      render(await api('/api/task', { text: text }));
    } catch (e) { showErr(e); }
  }

  async function approve(id) {
    try { render(await api('/api/approve', { id: id })); }
    catch (e) { showErr(e); }
  }

  // 经典脚本没有模块作用域：内联 onclick 与 data-approve 都只能靠 window
  window.submitTask = submitTask;
  window.approve = approve;

  document.getElementById('send').addEventListener('click', submitTask);
  $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitTask(); });
  document.getElementById('tickets').addEventListener('click', function (e) {
    var id = e.target && e.target.getAttribute ? e.target.getAttribute('data-approve') : null;
    if (id) approve(id);
  });

  refresh();
  setInterval(refresh, 1500);
})();
</script></html>`;
