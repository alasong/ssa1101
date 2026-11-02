/**
 * scripts/check-page-render.ts —— 真跑一遍页面脚本（带 DOM/fetch 桩），证明它能把数据画出来、能筛能展开。
 *
 *   node scripts/check-page-render.ts
 *
 * 为什么还要这一步：check-page.ts 只证明"能解析"，解析通过但 render 里有个笔误照样是白屏，
 * 而白屏在浏览器里同样没有报错提示（异常在 refresh 的 catch 里被吃掉，只写进 #err）。
 * 这里给最小 DOM 桩与 fetch 桩，直接调页面自己的渲染函数，断言：
 *   ① 有单时：行里出现任务原文、委托进度里的步骤名、详情/重跑/取消三个入口、原文与结果能「复制」；
 *   ② 需要我处理的排在前面（needsHuman 优先）；
 *   ③ 搜索框按原文过滤：命中留一行，不命中给「没有符合筛选条件」而不是空表；
 *   ④ 已结束里超长结果给「展开」，短结果不给；「重跑全部失败（N）」的 N 是真数；
 *   ⑤ 没单时的占位要写清下一步做什么（不是只说"还没有"）；
 *   ⑥ openWorker 真的去请求 /api/worker?id=…，并把结果写进 #detail。
 *
 * 反例：把 render 里 `tb.innerHTML = ...` 那行注释掉 → ① 立刻判红；
 *       把 `.sort(needsHuman 优先)` 去掉 → ② 判红；把 `matches` 恒返回 true → ③ 判红。
 */
import { page } from './page.ts';

const js = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));

interface FakeEl {
  id: string;
  textContent: string;
  innerHTML: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  title: string;
  handlers: Record<string, (e: unknown) => void>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  getAttribute(): null;
  scrollIntoView(): void;
  focus(): void;
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
      checked: false,
      disabled: false,
      title: '',
      handlers: {},
      addEventListener(type: string, fn: (e: unknown) => void) {
        this.handlers[type] = fn;
      },
      getAttribute() {
        return null;
      },
      scrollIntoView() {},
      focus() {},
    };
    els.set(id, e);
  }
  return e;
};

const calls: string[] = [];
const state = {
  tickets: [
    {
      id: 't8',
      text: '把标题字号调大',
      stage: 'working/queued',
      steps: [
        { label: '收到需求', done: true, note: 'manual:m-0' },
        { label: 'Gate 准入', done: true, note: 'auto' },
        { label: '建工单', done: true, note: 't8' },
        { label: '占槽派发', done: true, note: 'running' },
        { label: 'worker 执行', done: true, note: 'session-z · 9 行' },
        { label: '出结果', done: true, note: '已完成' },
        { label: '结束', done: false, note: '未结束' },
      ],
      why: 'worker 跑完了，等你验收：点「详情」看结果，满意就点「结束」收单',
      needsHuman: true,
      worker: 'done',
      workerSession: 'session-z',
      assignment: 'running',
    },
    {
      id: 't10',
      text: '加一个暗色模式开关',
      stage: 'working',
      steps: [
        { label: '收到需求', done: true, note: 'manual:m-2' },
        { label: 'Gate 准入', done: true, note: 'auto' },
        { label: '建工单', done: true, note: 't10' },
        { label: '占槽派发', done: true, note: 'running' },
        { label: 'worker 执行', done: false, note: '—' },
      ],
      why: '',
      needsHuman: false,
      worker: 'running',
      workerSession: 'session-y',
      assignment: 'running',
    },
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
  ended: 2,
  endedRecent: [
    { id: 't1', text: '页面测试：把按钮改成蓝色', worker: 'done', result: '已完成。'.repeat(60) },
    { id: 't2', text: '短结果', worker: 'done', result: '好' },
  ],
  panel: '- t9 · 把按钮改成蓝色 → worker 跑失败了',
  slots: { used: 1, capacity: 2 },
  live: 1,
  pendingEvents: 0,
  dueEffects: 0,
  workerMode: 'dsh',
  flow: { events: 3, tickets: 2, dispatched: 2, running: 1, results: 0, ended: 2 },
  events: ['[08:00:00] launch t9'],
};

const g = globalThis as Record<string, unknown>;
const docHandlers: Record<string, (e: unknown) => void> = {};
g.document = {
  getElementById: el,
  addEventListener(type: string, fn: (e: unknown) => void) {
    docHandlers[type] = fn;
  },
};
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
  if (!rows.includes('加一个暗色模式开关')) problems.push('第二张单没画出来（不只画第一行）');
  if (!rows.includes('委托进度') && !rows.includes('worker 执行')) problems.push('工单行里没有委托进度（步骤链）');
  for (const act of ['data-detail', 'data-retry', 'data-cancel']) {
    if (!rows.includes(act)) problems.push(`工单行里没有 ${act} 操作`);
  }
  if (!rows.includes('data-copy')) problems.push('工单行里没有「复制原文」，选中表格文字很麻烦');
  // 跑完的单必须能「结束」收单：只有「取消」的话，验收完的人只能点取消，语义等于"中途停掉"
  if (!rows.includes('data-close')) problems.push('worker 跑完的单没有「结束」收单入口');
  // ② needsHuman 优先：夹具里 t10（不需要人）排在 t9（需要人）前面，渲染后必须反过来
  if (rows.indexOf('t9') < 0 || rows.indexOf('t9') > rows.indexOf('t10')) {
    problems.push('需要我处理的工单没有排在前面（t9 应在 t10 之前，夹具顺序是 t10 在前）');
  }
  // ③ 搜索过滤
  el('q').value = '暗色';
  win.__render(state);
  const filtered = el('tickets').innerHTML;
  if (!filtered.includes('暗色模式') || filtered.includes('把按钮改成蓝色')) {
    problems.push('搜索框没有按原文过滤（命中「暗色」时不该还显示别的单）');
  }
  el('q').value = '不存在的关键词';
  win.__render(state);
  const noneHit = el('tickets').innerHTML;
  if (!noneHit.includes('没有符合筛选条件')) problems.push('筛选无结果时没有说明，只给了空表');
  el('q').value = '';
  // ④ 批量重跑与展开
  win.__render(state);
  if (!el('rerunFailed').textContent.includes('重跑全部失败（1）')) {
    problems.push(`「重跑全部失败」的计数不对：${el('rerunFailed').textContent}`);
  }
  const endedHtml = el('ended').innerHTML;
  if (!endedHtml.includes('data-expand')) problems.push('已结束里超长结果没有「展开」，只能看到前 160 字');
  if (!endedHtml.includes('data-copy')) problems.push('已结束里没有「复制结果」');
  if (!el('flow').innerHTML.includes('已派 worker')) problems.push('委托链路计数没渲染');
  // ⑤ 空态要指下一步
  win.__render({ ...state, tickets: [], ended: 0, endedRecent: [] });
  const emptyHtml = el('tickets').innerHTML;
  if (!emptyHtml.includes('还没有工单')) problems.push('空态没有「还没有工单」占位');
  if (!emptyHtml.includes('回车即下发')) problems.push('空态没写下一步做什么（输入需求 + 回车下发）');
}

void (async () => {
  if (typeof win.openWorker === 'function') {
    await (win.openWorker as (id: string) => Promise<void>)('t9');
    if (!calls.some((c) => c.startsWith('/api/worker?id=t9'))) problems.push('openWorker 没有请求 /api/worker');
    if (!el('detail').textContent.includes('w-t9-abc')) problems.push('#detail 里没写入 worker 记录');
    if (!el('detail').textContent.includes('AUTH 401')) problems.push('#detail 里没写入失败原因');
  }
  if (!docHandlers.keydown) problems.push('没有注册键盘快捷方式（⌘/Ctrl+Enter、/、Esc）');
  if (problems.length > 0) {
    console.error('页面渲染判红：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('页面渲染 OK：两行都画、需要处理的排前、搜索能筛、复制/展开/批量重跑都在、空态指下一步、详情真取 /api/worker');
})();
