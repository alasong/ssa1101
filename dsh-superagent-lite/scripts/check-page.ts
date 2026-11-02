/**
 * scripts/check-page.ts —— 机检控制台的页面脚本，判据都是"浏览器里会真的出错/让人看不懂"的形态。
 *
 *   node scripts/check-page.ts
 *
 *   ① 经典脚本可解析：`new Function(js)` 不抛（顶层 await 会在这里抛，浏览器同样抛，
 *      整段脚本不执行、按钮全死，页面上没有任何提示）。
 *   ② 没有 type=module（内联 onclick 只能调全局函数）。
 *   ③ 入口都挂在 window 上：submitTask / openWorker / cancel / retry。
 *   ④ 「下发」绑了 click 与 Enter。
 *   ⑤ worker 详情链完整：data-detail + /api/worker + openWorker。
 *   ⑥ **没有「批准」**：下发即自动准入派发，人只能取消/重跑；按钮名必须等于它真正做的事。
 *   ⑦ 委托链路必须画出来（② 区块 + 每单的委托进度 + data-cancel/data-retry）。
 *
 * 反例：把 `refresh();` 改成 `await refresh();` → ① 红；删 `window.openWorker` → ③ 红；
 *       把「取消」改回「批准」 → ⑥ 红。
 */
import { page } from './page.ts';

const js = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
const problems: string[] = [];

try {
  new Function(js); // 经典脚本；顶层 await 在这里就是 SyntaxError
} catch (e) {
  problems.push(`经典脚本解析失败：${(e as Error).message}`);
}
if (/<script\s+type=["']module/.test(page)) problems.push('页面用了 type=module，内联 onclick 会找不到函数');
for (const fn of ['submitTask', 'openWorker', 'cancel', 'retry']) {
  if (!js.includes(`window.${fn} = ${fn}`)) problems.push(`没把 ${fn} 挂到 window 上（内联调用不到）`);
}
if (!js.includes(`getElementById('send')`) || !js.includes(`addEventListener('click', submitTask)`)) {
  problems.push('「下发」按钮没绑 click');
}
if (!js.includes(`e.key === 'Enter'`)) problems.push('输入框没绑回车提交');

if (!js.includes(`data-detail`)) problems.push('工单行没有「详情」入口，看不到 worker 跑了什么');
if (!js.includes(`/api/worker?id=`)) problems.push('页面没有请求 /api/worker，详情无从取数');

// ⑥ 「批准」这个词在这套模型里是错的：它让人以为要先批准才开始
// 只查"按钮/接口"形态：正文里写"不需要谁批准"是在解释，不是入口，不能一起禁
for (const bad of ['>批准<', 'data-approve', '/api/approve']) {
  if (page.includes(bad)) problems.push(`页面里还有「${bad}」：下发即派发，不该有审批这一步`);
}

// ⑦ 委托链路与可执行操作
for (const needle of ['<th>委托进度</th>', '委托链路', 'dsh worker 会话']) {
  if (!page.includes(needle)) problems.push(`页面缺少「${needle}」，委托流程看不见`);
}
for (const attr of ['data-cancel', 'data-retry']) {
  if (!js.includes(attr)) problems.push(`页面缺少 ${attr} 操作`);
}
if (!js.includes('/api/cancel') || !js.includes('/api/retry')) {
  problems.push('取消/重跑没有接到 /api/cancel、/api/retry');
}

if (problems.length > 0) {
  console.error('页面脚本判红：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`页面脚本 OK：${js.length} 字节，经典脚本可解析，入口齐全，无「批准」，委托链路与取消/重跑都在`);
