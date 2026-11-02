/**
 * scripts/page.ts —— 控制台的 HTML（从 server.ts 拆出来，为的是能被单独验证）。
 *
 * 纪律：
 *   ① 页面脚本是**经典脚本**（没有 type=module），不能有顶层 `await`（浏览器直接 SyntaxError，
 *      整段不执行 → 按钮全死）；校验见 scripts/check-page.ts。
 *   ② 内联入口只能调**全局**函数，所以都显式挂到 window 上。
 *   ③ 按钮名必须等于它真正做的事：这里没有「批准」——下发就自动准入并派给 worker，
 *      人能做的只有「取消」（停 worker + 结束工单）和「重跑」（原任务再走一遍）。
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
 button.danger{background:transparent;border-color:#6b2b2b;color:#ff9a8a;padding:3px 8px;font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #222731;vertical-align:top}
 th{color:#8b93a1;font-weight:500}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#9fd0ff}
 pre{white-space:pre-wrap;margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#b9c4d4}
 .kpi{display:flex;gap:14px;margin-bottom:10px;font-size:12.5px;flex-wrap:wrap}
 .kpi b{color:#7ee787}
 .empty{color:#8b93a1;font-size:13px}
 .row{display:flex;gap:8px}
 .row input{flex:1}
 .chain{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 12px;font-size:12px}
 .chain span.node{border:1px solid #333a46;border-radius:999px;padding:2px 9px;color:#9fb0c8}
 .chain span.arrow{color:#4d5563}
 .steps{display:flex;flex-wrap:wrap;gap:4px;font-size:11.5px}
 .steps span{background:#0f1115;border:1px solid #2a3040;border-radius:4px;padding:1px 6px;color:#5f6773}
 .steps span.done{color:#7ee787;border-color:#2b4a33}
 .steps span.now{color:#f0c674;border-color:#5a4a24}
 #err{color:#ff7b72;font-size:12.5px;margin-top:8px;white-space:pre-wrap}
 #detail{background:#0f1115;border:1px solid #222731;border-radius:6px;padding:10px;max-height:300px;overflow:auto}
</style>
<header><h1>superagent-lite 控制台</h1>
<span class="muted" id="meta">连接中…</span></header>
<main>
 <section>
  <h2>① 下发任务</h2>
  <div class="row"><input id="text" placeholder="比如：把登录页按钮改成蓝色" autocomplete="off">
  <button id="send">下发</button></div>
  <p class="muted">回车也可提交。下发即进入委托链路：不需要谁批准。</p>
  <div id="err"></div>

  <h2 style="margin-top:18px">② 委托链路（这就是全部逻辑）</h2>
  <div class="chain" id="chain">
   <span class="node">你写下需求</span><span class="arrow">→</span>
   <span class="node">event 入库</span><span class="arrow">→</span>
   <span class="node">Gate 准入</span><span class="arrow">→</span>
   <span class="node">ticket 工单</span><span class="arrow">→</span>
   <span class="node">槽位</span><span class="arrow">→</span>
   <span class="node">dsh worker 会话</span><span class="arrow">→</span>
   <span class="node">result.md</span><span class="arrow">→</span>
   <span class="node">结束</span>
  </div>
  <div class="kpi" id="flow"></div>
  <p class="muted" id="mode"></p>

  <h2 style="margin-top:18px">需要你处理</h2>
  <pre id="panel">（空）</pre>
 </section>
 <section>
  <h2>③ 进行中（每张单的委托进度）</h2>
  <div class="kpi" id="kpi"></div>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>委托进度</th><th>为什么找你</th><th>操作</th></tr></thead>
  <tbody id="tickets"><tr><td colspan="5" class="empty">还没有工单</td></tr></tbody></table>

  <h2 style="margin-top:18px">④ worker 详情</h2>
  <pre id="detail">（点某张单的「详情」）</pre>

  <h2 style="margin-top:18px">⑤ 已结束（含结果）</h2>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>worker</th><th>结果</th><th></th></tr></thead>
  <tbody id="ended"><tr><td colspan="5" class="empty">还没有结束的工单</td></tr></tbody></table>

  <h2 style="margin-top:18px">⑥ 最近事件</h2>
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

  function stepsHtml(steps) {
    if (!steps || !steps.length) return '<span class="muted">—</span>';
    var now = 0;
    for (var i = 0; i < steps.length; i += 1) { if (steps[i].done) now = i + 1; }
    return '<div class="steps">' + steps.map(function (s, i) {
      var c = s.done ? 'done' : (i === now ? 'now' : '');
      return '<span class="' + c + '" title="' + esc(s.note || '') + '">' + (s.done ? '✓ ' : '○ ') + esc(s.label) + '</span>';
    }).join('') + '</div>';
  }

  function render(s) {
    $('meta').textContent = '槽位 ' + s.slots.used + '/' + s.slots.capacity + ' · 活跃会话 ' + s.live +
      ' · 待处理事件 ' + s.pendingEvents + ' · 到期副作用 ' + s.dueEffects;
    $('panel').textContent = s.panel || '（空）';
    $('log').textContent = s.events.length ? s.events.join('\\n') : '—';
    $('mode').textContent = s.workerMode === 'fake'
      ? '当前是假 worker（SA_WORKER=fake）：只会编号会话，不会真跑。'
      : '当前是真 worker：每张单 spawn 一个 dsh 进程，日志与结果落在 work/<工单>-<assignment>/。';

    var f = s.flow || { events: 0, tickets: 0, dispatched: 0, running: 0, results: 0, ended: 0 };
    $('flow').innerHTML = '<span>收到需求 <b>' + f.events + '</b></span><span>工单 <b>' + f.tickets +
      '</b></span><span>已派 worker <b>' + f.dispatched + '</b></span><span>在跑 <b>' + f.running +
      '</b></span><span>有结果 <b>' + f.results + '</b></span><span>已结束 <b>' + f.ended + '</b></span>';

    var needHuman = s.tickets.filter(function (t) { return t.needsHuman; }).length;
    $('kpi').innerHTML = '<span>进行中 <b>' + s.tickets.length + '</b></span><span>等你处理 <b>' + needHuman + '</b></span>';

    var tb = $('tickets');
    if (!s.tickets.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">还没有工单</td></tr>';
    } else {
      tb.innerHTML = s.tickets.map(function (t) {
        return '<tr><td><code>' + esc(t.id) + '</code><div class="muted">' + esc(t.stage) + '</div></td>' +
          '<td>' + esc(t.text) + '</td>' +
          '<td>' + stepsHtml(t.steps) + '</td>' +
          '<td>' + (t.why ? esc(t.why) : '<span class="muted">不需要你</span>') + '</td>' +
          '<td><button class="ghost" data-detail="' + esc(t.id) + '">详情</button>' +
          '<button class="ghost" data-retry="' + esc(t.id) + '" title="用同一条任务原文重新下发一次（旧单先结束）">重跑</button>' +
          '<button class="danger" data-cancel="' + esc(t.id) + '" title="停掉它的 worker 并结束这张单">取消</button></td></tr>';
      }).join('');
    }

    var eb = $('ended');
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
      $('detail').textContent = id + '：还没有 worker 记录（这张单还没派出去，或派发失败）';
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

  async function refresh() {
    try {
      if (selected) { void openWorker(selected); }
      render(await api('/api/state'));
      $('err').textContent = '';
    } catch (e) { showErr(e); }
  }

  async function submitTask() {
    var text = $('text').value.trim();
    if (!text) return;
    try {
      $('text').value = '';
      render(await api('/api/task', { text: text }));
    } catch (e) { showErr(e); }
  }

  async function cancel(id) {
    try { render(await api('/api/cancel', { id: id })); } catch (e) { showErr(e); }
  }

  async function retry(id) {
    try { render(await api('/api/retry', { id: id })); } catch (e) { showErr(e); }
  }

  // 经典脚本没有模块作用域：入口只能靠 window
  window.submitTask = submitTask;
  window.openWorker = openWorker;
  window.cancel = cancel;
  window.retry = retry;
  window.__render = render;

  document.getElementById('send').addEventListener('click', submitTask);
  $('text').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitTask(); });
  document.getElementById('tickets').addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var d = el.getAttribute('data-detail');
    if (d) { void openWorker(d); return; }
    var r = el.getAttribute('data-retry');
    if (r) { void retry(r); return; }
    var c = el.getAttribute('data-cancel');
    if (c) { void cancel(c); }
  });
  document.getElementById('ended').addEventListener('click', function (e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var d = el.getAttribute('data-detail');
    if (d) { void openWorker(d); }
  });

  refresh();
  setInterval(refresh, 1500);
})();
</script></html>`;
