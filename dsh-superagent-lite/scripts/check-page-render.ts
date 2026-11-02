/**
 * scripts/check-page-render.ts —— 真跑一遍页面脚本（带 DOM/fetch 桩），证明它能把数据画出来。
 *
 *   node scripts/check-page-render.ts
 *
 * 为什么还要这一步：check-page.ts 只证明"能解析"，解析通过但 render 里有个笔误照样是白屏，
 * 而白屏在浏览器里同样没有报错提示（异常在 refresh 的 catch 里被吃掉，只写进 #err）。
 * 这里给最小 DOM 桩与 fetch 桩，直接调页面自己的渲染函数，断言：
 *   ① 有单时：行里出现任务原文、委托进度里的步骤名、详情/重跑/取消三个入口；
 *   ② 没单时：显示「还没有工单」，不抛错；
 *   ③ openWorker 真的去请求 /api/worker?id=…，并把结果写进 #detail。
 *
 * 反例：把 render 里 `tb.innerHTML = ...` 那行注释掉 → ① 立刻判红。
 */
import { page } from './page.ts';

const js = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));

interface FakeEl {
  id: string;
  textContent: string;
  innerHTML: string;
  value: string;
  handlers: Record<string, (e: unknown) => void>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  getAttribute(): null;
}

const els = new Map<string, FakeEl>();
const el = (id: string): FakeEl => {
  let e = els.get(id);
  if (e === undefined) {
    e = {
      id,
      textContent: '',
      innerHTML: '',
      value: '',
      handlers: {},
      addEventListener(type: string, fn: (e: unknown) => void) {
        this.handlers[type] = fn;
      },
      getAttribute() {
        return null;
      },
    };
    els.set(id, e);
  }
  return e;
};

const calls: string[] = [];
const state = {
  tickets: [
    {
      id: 't9',
      text: '把按钮改成蓝色',
      stage: 'working/queued',
      steps: [
        { label: '收到需求', done: true, note: 'manual:m-1' },
        { label: 'Gate 准入', done: true, note: 'auto' },
        { label: '建工单', done: true, note: 't9' },
        { label: '占槽派发', done: true, note: 'running' },
        { label: 'worker 执行', done: true, note: 'session-x · 6 行' },
        { label: '出结果', done: false, note: '—' },
        { label: '结束', done: false, note: '未结束' },
      ],
      why: 'worker 跑失败了：等你决定「结束」还是重新下发',
      needsHuman: true,
      worker: 'failed',
      workerSession: 'session-x',
      assignment: 'running',
    },
  ],
  ended: 1,
  endedRecent: [{ id: 't1', text: '页面测试：把按钮改成蓝色', worker: '—', result: null }],
  panel: '- t9 · 把按钮改成蓝色 → worker 跑失败了',
  slots: { used: 1, capacity: 2 },
  live: 1,
  pendingEvents: 0,
  dueEffects: 0,
  workerMode: 'dsh',
  flow: { events: 2, tickets: 2, dispatched: 1, running: 1, results: 0, ended: 1 },
  events: ['[08:00:00] launch t9'],
};

const g = globalThis as Record<string, unknown>;
g.document = { getElementById: el };
g.window = {};
g.setInterval = () => 0;
g.fetch = async (url: string) => {
  calls.push(String(url));
  if (String(url).startsWith('/api/worker')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        runId: 'w-t9-abc',
        dshSessionId: 'session-x',
        state: 'failed',
        exitCode: 1,
        lines: 6,
        cmd: ['dsh', '--json', '把按钮改成蓝色'],
        dir: '/tmp/work/t9',
        logPath: '/tmp/work/t9/session.ndjson',
        error: 'AUTH 401',
        finalText: null,
        tail: ['{"type":"session"}'],
        stderrTail: [],
      }),
    };
  }
  return { ok: true, status: 200, json: async () => state };
};

const problems: string[] = [];
try {
  new Function(js)();
} catch (e) {
  problems.push(`页面脚本执行抛错：${String(e)}`);
}

const win = g.window as Record<string, (...a: unknown[]) => unknown>;
if (typeof win.__render !== 'function') problems.push('页面没把 render 暴露成 window.__render，无法验证渲染');
else {
  try {
    win.__render(state);
  } catch (e) {
    problems.push(`render(有数据) 抛错：${String(e)}`);
  }
  const rows = el('tickets').innerHTML;
  if (!rows.includes('把按钮改成蓝色')) problems.push('工单行里没有任务原文');
  if (!rows.includes('委托进度') && !rows.includes('worker 执行')) problems.push('工单行里没有委托进度（步骤链）');
  for (const act of ['data-detail', 'data-retry', 'data-cancel']) {
    if (!rows.includes(act)) problems.push(`工单行里没有 ${act} 操作`);
  }
  if (!el('ended').innerHTML.includes('页面测试')) problems.push('已结束表里没有历史工单');
  if (!el('flow').innerHTML.includes('已派 worker')) problems.push('委托链路计数没渲染');

  try {
    win.__render({ ...state, tickets: [], ended: 0, endedRecent: [] });
  } catch (e) {
    problems.push(`render(空态) 抛错：${String(e)}`);
  }
  if (!el('tickets').innerHTML.includes('还没有工单')) problems.push('空态没有「还没有工单」占位');
}

void (async () => {
  if (typeof win.openWorker === 'function') {
    await (win.openWorker as (id: string) => Promise<void>)('t9');
    if (!calls.some((c) => c.startsWith('/api/worker?id=t9'))) problems.push('openWorker 没有请求 /api/worker');
    if (!el('detail').textContent.includes('w-t9-abc')) problems.push('#detail 里没写入 worker 记录');
    if (!el('detail').textContent.includes('AUTH 401')) problems.push('#detail 里没写入失败原因');
  }
  if (problems.length > 0) {
    console.error('页面渲染判红：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('页面渲染 OK：工单行含原文/委托进度/三操作，已结束含历史，空态占位，详情真取 /api/worker');
})();
