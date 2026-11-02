/**
 * scripts/page.ts —— 控制台的 HTML（从 server.ts 拆出来，为的是能被单独验证）。
 *
 * 纪律：
 *   ① 页面脚本是**经典脚本**（没有 type=module），不能有顶层 `await`（浏览器直接 SyntaxError，
 *      整段不执行 → 按钮全死）；校验见 scripts/check-page.ts。
 *   ② 内联入口只能调**全局**函数，所以都显式挂到 window 上。
 *   ③ 按钮名必须等于它真正做的事：这里没有「批准」——下发就自动准入并派给 worker，
 *      人能做的只有「取消」（停 worker + 结束工单）和「重跑」（原任务再走一遍）。
 *   ④ 站在用的人这边（这一版新加）：输入框一屏之内能找单、能筛、能复制、能键盘操作，
 *      并且**数据没变就不重画**——每 1.5 秒整表替换会把正在选中的文字与滚动位置冲掉。
 */
export const page = `<!doctype html><html lang="zh"><meta charset="utf-8">
<title>superagent-lite 控制台</title>
<style>
 body{font:14px/1.6 -apple-system,system-ui,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}
 header{padding:14px 20px;border-bottom:1px solid #262a33;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
 h1{font-size:16px;margin:0;font-weight:600}
 .muted{color:#8b93a1;font-size:12px}
 main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px 20px}
 section{background:#161a21;border:1px solid #262a33;border-radius:8px;padding:14px}
 h2{font-size:13px;margin:0 0 10px;color:#9fb0c8;font-weight:600;letter-spacing:.04em}
 input,button{font:inherit;border-radius:6px;border:1px solid #333a46;background:#0f1115;color:#e6e6e6;padding:8px 10px}
 input{width:100%;box-sizing:border-box}
 button{cursor:pointer;background:#1f6feb;border-color:#1f6feb}
 button:disabled{opacity:.45;cursor:default}
 button.ghost{background:transparent;border-color:#333a46;padding:3px 8px;font-size:12px}
 button.danger{background:transparent;border-color:#6b2b2b;color:#ff9a8a;padding:3px 8px;font-size:12px}
 table{width:100%;border-collapse:collapse;font-size:12.5px}
 th,td{text-align:left;padding:5px 6px;border-bottom:1px solid #222731;vertical-align:top}
 th{color:#8b93a1;font-weight:500}
 tr.sel td{background:#1b2331}
 tr.full td{background:#12161d;color:#b9c4d4}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#9fd0ff}
 pre{white-space:pre-wrap;margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#b9c4d4}
 .kpi{display:flex;gap:14px;margin-bottom:10px;font-size:12.5px;flex-wrap:wrap}
 .kpi b{color:#7ee787}
 .empty{color:#8b93a1;font-size:13px;padding:8px 6px}
 .row{display:flex;gap:8px}
 .row input{flex:1}
 .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
 .tools input{flex:1;min-width:120px;padding:5px 8px;font-size:12.5px}
 .tools label{font-size:12.5px;color:#9fb0c8;display:flex;gap:5px;align-items:center;white-space:nowrap}
 .chain{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 12px;font-size:12px}
 .chain span.node{border:1px solid #333a46;border-radius:999px;padding:2px 9px;color:#9fb0c8}
 .chain span.arrow{color:#4d5563}
 .steps{display:flex;flex-wrap:wrap;gap:4px;font-size:11.5px}
 .steps span{background:#0f1115;border:1px solid #2a3040;border-radius:4px;padding:1px 6px;color:#5f6773}
 .steps span.done{color:#7ee787;border-color:#2b4a33}
 .steps span.now{color:#f0c674;border-color:#5a4a24}
 #err{color:#ff7b72;font-size:12.5px;margin-top:8px;white-space:pre-wrap}
 #note{color:#7ee787;font-size:12.5px;margin-top:8px;white-space:pre-wrap}
 #detail{background:#0f1115;border:1px solid #222731;border-radius:6px;padding:10px;max-height:300px;overflow:auto}
 .kbd{border:1px solid #333a46;border-radius:4px;padding:0 4px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9fb0c8}
 /* 窄屏（手机 / 半屏窗口）：两栏并排会把表格挤成竖条，改成单栏 + 表格可横向滚 */
 @media (max-width: 900px){
  main{grid-template-columns:1fr;padding:12px}
  header{padding:12px}
  section{overflow-x:auto}
  table{min-width:640px}
 }
</style>
<header><h1>superagent-lite 控制台</h1>
<span class="muted" id="meta">连接中…</span></header>
<main>
 <section>
  <h2>① 下发任务</h2>
  <div class="row"><input id="text" placeholder="比如：把登录页按钮改成蓝色" autocomplete="off">
  <button id="send">下发</button></div>
  <p class="muted">回车或 <span class="kbd">⌘/Ctrl+Enter</span> 提交，<span class="kbd">/</span> 聚焦输入框。
  下发即进入委托链路：不需要谁批准。</p>
  <div id="note"></div>
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
  <div class="tools">
   <input id="q" placeholder="搜索：任务原文 / 工单号 / 原因" autocomplete="off">
   <label><input type="checkbox" id="onlyNeed"> 只看需要我处理</label>
   <button class="ghost" id="rerunFailed">重跑全部失败（0）</button>
  </div>
  <div class="kpi" id="kpi"></div>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>委托进度</th><th>为什么找你</th><th>操作</th></tr></thead>
  <tbody id="tickets"><tr><td colspan="5" class="empty">还没有工单。</td></tr></tbody></table>

  <h2 style="margin-top:18px">④ worker 详情</h2>
  <div class="tools"><button class="ghost" id="copyDir">复制执行目录</button>
  <span class="muted">Esc 收起详情 · ↑/↓ 切换单子并直接看它的详情 · 也可以点「详情」</span></div>
  <pre id="detail">（点某张单的「详情」——会显示它的 dsh 会话 id、执行的命令、日志行数与最终结果）</pre>

  <h2 style="margin-top:18px">⑤ 已结束（含结果）</h2>
  <div class="tools">
   <input id="endedQ" placeholder="在已结束里搜：原文 / 工单号 / 结果" autocomplete="off">
   <select id="sortEnded" title="按什么排">
    <option value="new">最新在前</option>
    <option value="old">最旧在前</option>
    <option value="dur">耗时最长</option>
   </select>
   <button class="ghost" id="moreEnded">显示更多</button>
   <span class="muted" id="endedHint"></span></div>
  <table><thead><tr><th>工单</th><th>任务原文</th><th>worker</th><th>耗时</th><th>结果</th><th></th></tr></thead>
  <tbody id="ended"><tr><td colspan="6" class="empty">还没有结束的工单。</td></tr></tbody></table>

  <h2 style="margin-top:18px">⑥ 最近事件</h2>
  <pre id="log">—</pre>
 </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };

  // 每 1.5 秒整表替换会冲掉正在选中的文字与滚动位置；数据没变就不重画
  var lastState = null;
  var lastJson = '';
  var selected = null;
  var expanded = {};
  var visibleIds = [];   // 当前筛选后可见的工单顺序（↑/↓ 按它切换）
  var endedShown = 8;
  var endedQ = '';
  var sortEnded = 'new';
  var detailDir = '';

  // 页面状态存起来：每天打开都是上次的样子，不用每次重设搜索与条数
  var PREF_KEY = 'sa.console.prefs.v1';
  function loadPrefs() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(PREF_KEY);
      if (!raw) return;
      var p = JSON.parse(raw) || {};
      if (typeof p.q === 'string' && $('q')) $('q').value = p.q;
      if (typeof p.onlyNeed === 'boolean' && $('onlyNeed')) $('onlyNeed').checked = p.onlyNeed;
      if (typeof p.endedQ === 'string' && $('endedQ')) $('endedQ').value = p.endedQ;
      if (typeof p.sortEnded === 'string' && $('sortEnded')) $('sortEnded').value = p.sortEnded;
      if (typeof p.endedShown === 'number' && p.endedShown >= 8) endedShown = p.endedShown;
    } catch (e) { /* 存坏了就当没有，不影响使用 */ }
  }
  function savePrefs() {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(PREF_KEY, JSON.stringify({
        q: $('q') ? $('q').value : '',
        onlyNeed: !!($('onlyNeed') && $('onlyNeed').checked),
        endedQ: $('endedQ') ? $('endedQ').value : '',
        sortEnded: $('sortEnded') ? $('sortEnded').value : 'new',
        endedShown: endedShown,
      }));
    } catch (e) { /* 隐私模式存不了就算了 */ }
  }

  function showErr(e) {
    $('err').textContent = '出错：' + (e && e.message ? e.message : String(e));
  }

  function note(msg) {
    $('note').textContent = msg || '';
  }

  async function api(path, body) {
    var init = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined;
    var r = await fetch(path, init);
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  // 属性里放的是任意文本（任务原文可能带引号），所以引号也要转义
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function copyText(text, btn) {
    var done = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { note('复制失败：浏览器不允许（可用「详情」里的文本手动选）'); });
        return;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    note('复制失败：当前浏览器没有剪贴板权限');
  }

  function filterOf() {
    var q = $('q');
    return { q: q && q.value ? String(q.value).trim().toLowerCase() : '', need: !!($('onlyNeed') && $('onlyNeed').checked) };
  }

  function matches(t, f) {
    if (f.need && !t.needsHuman) return false;
    if (f.q === '') return true;
    var hay = [t.id, t.text, t.why || '', t.stage || ''].join(' ').toLowerCase();
    return hay.indexOf(f.q) >= 0;
  }

  // 时间与耗时：都从服务端给的真实时间戳算（worker.json 里就有，重启后仍在），不编
  function fmtTime(ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDur(a, b) {
    if (!a || !b) return '—';
    var sec = Math.max(0, Math.round((b - a) / 1000));
    if (sec < 60) return sec + ' 秒';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + ' 分 ' + (sec % 60) + ' 秒';
    return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
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
    lastState = s;
    var f = filterOf();
    $('meta').textContent = '槽位 ' + s.slots.used + '/' + s.slots.capacity + ' · 活跃会话 ' + s.live +
      ' · 待处理事件 ' + s.pendingEvents + ' · 到期副作用 ' + s.dueEffects;
    $('panel').textContent = s.panel || '（空：现在没有需要你决定的事）';
    $('log').textContent = s.events.length ? s.events.join('\\n') : '—';
    $('mode').textContent = s.workerMode === 'fake'
      ? '当前是假 worker（SA_WORKER=fake）：只会编号会话，不会真跑。'
      : '当前是真 worker：每张单 spawn 一个 dsh 进程，日志与结果落在 work/<工单>-<assignment>/。';

    var flow = s.flow || { events: 0, tickets: 0, dispatched: 0, running: 0, results: 0, ended: 0 };
    $('flow').innerHTML = '<span>收到需求 <b>' + flow.events + '</b></span><span>工单 <b>' + flow.tickets +
      '</b></span><span>已派 worker <b>' + flow.dispatched + '</b></span><span>在跑 <b>' + flow.running +
      '</b></span><span>有结果 <b>' + flow.results + '</b></span><span>已结束 <b>' + flow.ended + '</b></span>';

    // 需要我处理的排前面：一屏之内先看到要动手的
    var all = s.tickets.slice().sort(function (a, b) {
      return (b.needsHuman ? 1 : 0) - (a.needsHuman ? 1 : 0);
    });
    var shown = all.filter(function (t) { return matches(t, f); });
    var needHuman = all.filter(function (t) { return t.needsHuman; }).length;
    var failed = all.filter(function (t) { return t.worker === 'failed'; }).length;
    $('kpi').innerHTML = '<span>进行中 <b>' + all.length + '</b></span><span>等你处理 <b>' + needHuman +
      '</b></span><span>显示 <b>' + shown.length + '</b></span>';

    visibleIds = shown.map(function (t) { return t.id; });
    var rf = $('rerunFailed');
    if (rf) {
      rf.textContent = '重跑全部失败（' + failed + '）';
      rf.title = failed ? '逐个用原任务原文重新下发，旧单先结束。共 ' + failed + ' 张。' : '当前没有失败的工单';
    }

    var tb = $('tickets');
    if (!all.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">还没有工单。在上面的输入框写一条需求（按 <span class="kbd">/</span> 聚焦），回车即下发。</td></tr>';
    } else if (!shown.length) {
      tb.innerHTML = '<tr><td colspan="5" class="empty">没有符合筛选条件的工单（共 ' + all.length + ' 张）。清空搜索框或取消「只看需要我处理」。</td></tr>';
    } else {
      tb.innerHTML = shown.map(function (t) {
        return '<tr data-row="' + esc(t.id) + '"' + (t.id === selected ? ' class="sel"' : '') + '>' +
          '<td><code>' + esc(t.id) + '</code><div class="muted">' + esc(t.stage) +
          (t.startedAt ? ' · 开始 ' + esc(fmtTime(t.startedAt)) : '') + '</div></td>' +
          '<td>' + esc(t.text) + '<div><button class="ghost" data-copy="' + esc(t.text) + '" title="复制任务原文">复制</button></div></td>' +
          '<td>' + stepsHtml(t.steps) + '</td>' +
          '<td>' + (t.why ? esc(t.why) : '<span class="muted">不需要你</span>') + '</td>' +
          '<td><button class="ghost" data-detail="' + esc(t.id) + '">详情</button>' +
          (t.worker === 'done'
            ? '<button class="ghost" data-close="' + esc(t.id) + '" title="验收通过：结束这张单（结果不动）">结束</button>'
            : '') +
          '<button class="ghost" data-retry="' + esc(t.id) + '" title="用同一条任务原文重新下发一次（旧单先结束）">重跑</button>' +
          '<button class="danger" data-cancel="' + esc(t.id) + '" title="停掉它的 worker 并结束这张单">取消</button></td></tr>';
      }).join('');
    }

    var eb = $('ended');
    var allEnded = s.endedRecent || [];
    var total = typeof s.endedTotal === 'number' ? s.endedTotal : allEnded.length;
    // 已结束自己的搜索与排序（与「进行中」分开：找历史与找当前不是一件事）
    var eq = endedQ.toLowerCase();
    var matched = eq === '' ? allEnded.slice() : allEnded.filter(function (e) {
      return [e.id, e.text, e.result || '', e.worker || ''].join(' ').toLowerCase().indexOf(eq) >= 0;
    });
    matched.sort(function (a, b) {
      if (sortEnded === 'old') return (a.startedAt || 0) - (b.startedAt || 0);
      if (sortEnded === 'dur') return ((b.endedAt || 0) - (b.startedAt || 0)) - ((a.endedAt || 0) - (a.startedAt || 0));
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
    var shown = matched.slice(0, endedShown);
    var more = $('moreEnded');
    if (more) {
      var hidden = matched.length - shown.length;
      more.textContent = hidden > 0 ? '显示更多（还有 ' + hidden + ' 条）' : (endedShown > 8 ? '收起' : '显示更多');
      more.disabled = matched.length <= 8;
    }
    var hint = $('endedHint');
    if (hint) {
      hint.textContent = total === 0 ? ''
        : (eq === '' ? '共 ' + total + ' 条，当前显示 ' + shown.length + ' 条（最近的在最上面）'
          : '共 ' + total + ' 条，命中「' + endedQ + '」' + matched.length + ' 条，当前显示 ' + shown.length + ' 条');
    }
    if (eq !== '' && !matched.length) {
      eb.innerHTML = '<tr><td colspan="6" class="empty">已结束里没有匹配「' + esc(endedQ) + '」的工单。清空搜索框看全部 ' + total + ' 条。</td></tr>';
      return;
    }
    if (!allEnded.length) {
      eb.innerHTML = '<tr><td colspan="6" class="empty">还没有结束的工单。取消一张单、或等 worker 跑完，它就会出现在这里（含结果）。</td></tr>';
    } else {
      eb.innerHTML = shown.map(function (e) {
        var full = e.result ? String(e.result) : '';
        var isOpen = !!expanded[e.id];
        var shownText = !full ? '（这一单结束时没有执行记录）' : (isOpen ? full : full.slice(0, 160) + (full.length > 160 ? '…' : ''));
        var head = '<tr data-row="' + esc(e.id) + '"' + (e.id === selected ? ' class="sel"' : '') + '><td><code>' + esc(e.id) +
          '</code></td><td>' + esc(e.text) + '</td><td>' + esc(e.worker) + '</td>' +
          '<td title="' + esc(fmtTime(e.startedAt) + ' → ' + fmtTime(e.endedAt)) + '">' + esc(fmtDur(e.startedAt, e.endedAt)) + '</td>' +
          '<td>' + esc(shownText) + '</td><td>' +
          '<button class="ghost" data-detail="' + esc(e.id) + '">详情</button>';
        if (full.length > 160) {
          head += '<button class="ghost" data-expand="' + esc(e.id) + '" title="展开/收起完整结果">' + (isOpen ? '收起' : '展开') + '</button>';
        }
        if (full) head += '<button class="ghost" data-copy="' + esc(full) + '" title="复制完整结果">复制</button>';
        return head + '</td></tr>';
      }).join('');
    }
  }

  function renderWorker(id, w) {
    if (!w) {
      detailDir = '';
      $('detail').textContent = id + '：还没有 worker 记录（这张单还没派出去，或派发失败）。' +
        '\\n下一步：等它被派发、或点「重跑」用原任务再下发一次。';
      return;
    }
    detailDir = w.dir || '';
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
    // 内容没变就不重写：否则正在 #detail 里选中的日志，每 1.5 秒被清掉一次
    var text = lines.join('\\n');
    if ($('detail').textContent !== text) $('detail').textContent = text;
    var d = $('detail');
    if (d && d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
  }

  function scrollToDetail() {
    var d = $('detail');
    if (d && d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
  }

  async function openWorker(id) {
    var changed = selected !== id;
    selected = id;
    if (changed && lastState) render(lastState); // 只有换了单才重画（高亮行），轮询不打断选中
    try {
      var r = await fetch('/api/worker?id=' + encodeURIComponent(id));
      if (r.status === 404) { renderWorker(id, null); scrollToDetail(); return; }
      var w = await r.json();
      if (!r.ok) throw new Error(w.error || ('HTTP ' + r.status));
      renderWorker(id, w);
      scrollToDetail();
    } catch (e) { showErr(e); }
  }

  async function refresh(force) {
    try {
      var s = await api('/api/state');
      var j = JSON.stringify(s);
      if (force || j !== lastJson) {
        lastJson = j;
        render(s);
      }
      if (selected) { void openWorker(selected); }
      $('err').textContent = '';
    } catch (e) { showErr(e); }
  }

  async function submitTask() {
    var text = $('text').value.trim();
    if (!text) { note('先写一条需求再下发。'); return; }
    try {
      $('text').value = '';
      note('已下发：' + text);
      render(await api('/api/task', { text: text }));
      lastJson = '';
      $('text').focus();
    } catch (e) { showErr(e); }
  }

  async function cancel(id) {
    try { render(await api('/api/cancel', { id: id })); lastJson = ''; note('已取消 ' + id + '，可在「已结束」看结果。'); }
    catch (e) { showErr(e); }
  }

  async function retry(id) {
    try { render(await api('/api/retry', { id: id })); lastJson = ''; note('已重跑 ' + id + '（生成一张新单）。'); }
    catch (e) { showErr(e); }
  }

  // 验收后收单：只结束这张单，不动已跑出来的结果（「取消」是中途停掉 worker）
  async function closeTicket(id) {
    try { render(await api('/api/close', { id: id })); lastJson = ''; note('已收单 ' + id + '，可在「已结束」看结果。'); }
    catch (e) { showErr(e); }
  }

  // 一次批量：失败的工单逐个重跑（服务端就是单张接口，这里串行调，不新增接口）
  async function rerunFailed(btn) {
    var failed = (lastState ? lastState.tickets : []).filter(function (t) { return t.worker === 'failed'; });
    if (!failed.length) { note('当前没有失败的工单。'); return; }
    if (btn) btn.disabled = true;
    var ok = 0;
    for (var i = 0; i < failed.length; i += 1) {
      try { await api('/api/retry', { id: failed[i].id }); ok += 1; } catch (e) { showErr(e); }
    }
    if (btn) btn.disabled = false;
    lastJson = '';
    note('已重跑 ' + ok + '/' + failed.length + ' 张失败工单。');
    await refresh(true);
  }

  // 经典脚本没有模块作用域：入口只能靠 window
  window.submitTask = submitTask;
  window.openWorker = openWorker;
  window.cancel = cancel;
  window.retry = retry;
  window.closeTicket = closeTicket;
  window.rerunFailed = rerunFailed;
  window.__render = render;
  window.__refresh = refresh;

  document.getElementById('send').addEventListener('click', submitTask);
  $('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) submitTask();
  });
  if ($('q')) {
    $('q').addEventListener('input', function () { savePrefs(); if (lastState) render(lastState); });
  }
  if ($('onlyNeed')) {
    $('onlyNeed').addEventListener('change', function () { savePrefs(); if (lastState) render(lastState); });
  }
  if ($('rerunFailed')) {
    $('rerunFailed').addEventListener('click', function () { void rerunFailed($('rerunFailed')); });
  }
  if ($('moreEnded')) {
    $('moreEnded').addEventListener('click', function () {
      var total = lastState && typeof lastState.endedTotal === 'number' ? lastState.endedTotal : (lastState ? lastState.endedRecent.length : 0);
      endedShown = endedShown >= total ? 8 : total;
      savePrefs();
      if (lastState) render(lastState);
    });
  }
  if ($('endedQ')) {
    $('endedQ').addEventListener('input', function () {
      endedQ = String($('endedQ').value || '').trim();
      savePrefs();
      if (lastState) render(lastState);
    });
  }
  if ($('sortEnded')) {
    $('sortEnded').addEventListener('change', function () {
      sortEnded = String($('sortEnded').value || 'new');
      savePrefs();
      if (lastState) render(lastState);
    });
  }
  if ($('copyDir')) {
    $('copyDir').addEventListener('click', function () {
      if (!detailDir) { note('先点某张单的「详情」，才有执行目录可复制。'); return; }
      copyText(detailDir, $('copyDir'));
    });
  }

  // 不用鼠标就能一张张看：↑/↓ 在「进行中」的可见单里切换，并直接打开它的详情
  function moveSelection(delta) {
    if (!visibleIds.length) return;
    var i = visibleIds.indexOf(selected);
    if (i < 0) i = delta > 0 ? -1 : 0;
    var next = (i + delta + visibleIds.length) % visibleIds.length;
    void openWorker(visibleIds[next]);
  }

  // 键盘：⌘/Ctrl+Enter 下发、/ 聚焦输入框、↑/↓ 切单、Esc 收起详情或清空搜索
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : '';
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && tag !== 'input' && tag !== 'textarea') {
      e.preventDefault();
      moveSelection(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submitTask(); return; }
    if (e.key === '/' && tag !== 'input' && tag !== 'textarea') {
      e.preventDefault();
      if ($('text')) $('text').focus();
      return;
    }
    if (e.key === 'Escape') {
      if ($('q') && $('q').value) { $('q').value = ''; if (lastState) render(lastState); return; }
      selected = null;
      detailDir = '';
      $('detail').textContent = '（点某张单的「详情」——会显示它的 dsh 会话 id、执行的命令、日志行数与最终结果）';
      if (lastState) render(lastState);
    }
  });

  function onRowClick(e) {
    var el = e.target;
    if (!el || !el.getAttribute) return;
    var d = el.getAttribute('data-detail');
    if (d) { void openWorker(d); return; }
    var r = el.getAttribute('data-retry');
    if (r) { void retry(r); return; }
    var c = el.getAttribute('data-cancel');
    if (c) { void cancel(c); return; }
    var cl = el.getAttribute('data-close');
    if (cl) { void closeTicket(cl); return; }
    var x = el.getAttribute('data-expand');
    if (x) { expanded[x] = !expanded[x]; if (lastState) render(lastState); return; }
    var cp = el.getAttribute('data-copy');
    if (cp !== null) { copyText(cp, el); }
  }
  document.getElementById('tickets').addEventListener('click', onRowClick);
  document.getElementById('ended').addEventListener('click', onRowClick);

  loadPrefs();
  endedQ = $('endedQ') ? String($('endedQ').value || '').trim() : '';
  sortEnded = $('sortEnded') ? String($('sortEnded').value || 'new') : 'new';
  refresh();
  setInterval(refresh, 1500);
})();
</script></html>`;
