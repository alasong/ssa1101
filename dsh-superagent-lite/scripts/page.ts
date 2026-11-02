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
 #detail{background:#0f1115;border:1px solid #222731;border-radius:6px;padding:10px;max-height:320px;overflow:auto}
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
  <h2 style="margin-top:18px">需要你处理</h2>
  <pre id="panel">（空）</pre>
 </section>
 <section>
  <h2>进行中（看它是什么、为什么找你）</h2>
  <div class="kpi" id="kpi"></div>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>worker</th><th>为什么找你</th><th></th></tr></thead>
  <tbody id="tickets"><tr><td colspan="5" class="empty">还没有工单</td></tr></tbody></table>
  <h2 style="margin-top:18px">Worker 详情（点「详情」看它跑了什么）</h2>
  <pre id="detail">（还没选工单）</pre>
  <h2 style="margin-top:18px">已结束（含结果）</h2>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>worker</th><th>结果</th><th></th></tr></thead>
  <tbody id="ended"><tr><td colspan="5" class="empty">还没有结束的工单</td></tr></tbody></table>
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
    var needHuman = s.tickets.filter(function (t) { return t.needsHuman; }).length;
    $('kpi').innerHTML = '<span>进行中 <b>' + s.tickets.length + '</b></span><span>等你处理 <b>' + needHuman +
      '</b></span><span>已结束 <b>' + s.ended + '</b></span>' +
      (s.workerMode === 'fake' ? '<span>（假 worker：不会真跑）</span>' : '');
    var tb = $('tickets');
    if (!s.tickets.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">还没有工单</td></tr>';
    } else {
      tb.innerHTML = s.tickets.map(function (t) {
        return '<tr><td><code>' + esc(t.id) + '</code><div class="muted">' + esc(t.stage) + '</div></td>' +
          '<td>' + esc(t.text) + '</td>' +
          '<td>' + esc(t.worker) + '<div class="muted">' + esc(t.workerSession) + '</div></td>' +
          '<td>' + (t.why ? esc(t.why) : '<span class="muted">不需要你</span>') + '</td>' +
          '<td><button class="ghost" data-detail="' + esc(t.id) + '">详情</button>' +
          '<button class="ghost" data-approve="' + esc(t.id) + '" title="结束这张单：停掉它的 worker 并释放槽位。不是「批准它开始」，它已经在跑了">结束</button></td></tr>';
      }).join('');
    }
    var eb = $('ended');
    if (!eb) return;
    if (!s.endedRecent.length) {
      eb.innerHTML = '<tr><td colspan="5" class="empty">还没有结束的工单</td></tr>';
    } else {
      eb.innerHTML = s.endedRecent.map(function (e) {
        var r = e.result ? String(e.result).slice(0, 160) : '（这一单结束时没有执行记录）';
        return '<tr><td><code>' + esc(e.id) + '</code></td><td>' + esc(e.text) + '</td><td>' + esc(e.worker) +
          '</td><td>' + esc(r) + '</td><td><button class="ghost" data-detail="' + esc(e.id) + '">详情</button></td></tr>';
      }).join('');
    }
  }

  var selected = null;

  function renderWorker(id, w) {
    if (!w) {
      $('detail').textContent = id + '：还没有 worker 记录（可能还没走到 launch）';
      return;
    }
    var lines = ['工单 ' + id + ' → worker ' + w.runId,
      'worker 会话：' + (w.dshSessionId || '（还没收到 session 事件）'),
      '状态：' + w.state + ' · 退出码 ' + (w.exitCode === null ? '—' : w.exitCode) + ' · ndjson ' + w.lines + ' 行',
      '命令：' + (w.cmd || []).join(' '),
      '目录：' + w.dir,
      '日志：' + w.logPath];
    if (w.error) lines.push('错误：' + w.error);
    if (w.stderrTail && w.stderrTail.length) lines.push('stderr 尾部：' + w.stderrTail.slice(-5).join(' / '));
    lines.push('', '最终结果：', w.finalText || '（还没有 final 事件）');
    if (w.tail && w.tail.length) lines.push('', '日志尾部（' + w.tail.length + ' 行）：', w.tail.slice(-12).join('\\n'));
    $('detail').textContent = lines.join('\\n');
  }

  async function openWorker(id) {
    selected = id;
    try {
      var r = await fetch('/api/worker?id=' + encodeURIComponent(id));
      if (r.status === 404) { renderWorker(id, null); return; }
      var w = await r.json();
      if (!r.ok) throw new Error(w.error || ('HTTP ' + r.status));
      renderWorker(id, w);
    } catch (e) { showErr(e); }
  }

  window.openWorker = openWorker;

  async function refresh() {
    if (selected) { void openWorker(selected); }
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
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var detailId = el.getAttribute('data-detail');
    if (detailId) { void openWorker(detailId); return; }
    var approveId = el.getAttribute('data-approve');
    if (approveId) void approve(approveId);
  });

  refresh();
  setInterval(refresh, 1500);
})();
</script></html>`;
