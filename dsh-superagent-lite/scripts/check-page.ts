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
 *   ⑧ 日常操作要高效：搜索框 / 只看需要我处理 / 批量重跑失败 / 复制原文与结果 / 结果可展开 /
 *      键盘快捷方式（⌘Ctrl+Enter、/、Esc）。这些是"用的人每天要按几十次"的路径，缺一个就退回手点。
 *   ⑨ 轮询不许整表重画：数据没变就不调 render（否则正在选中的文字与滚动位置每 1.5 秒被冲掉）。
 *
 * 反例：把 `refresh();` 改成 `await refresh();` → ① 红；删 `window.openWorker` → ③ 红；
 *       把「取消」改回「批准」 → ⑥ 红；删掉 `data-copy` → ⑧ 红；把 `j !== lastJson` 改成恒真 → ⑨ 红。
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
// 带 `="` 一起查：只查前缀的话，`data-closex=` 也会被判成有（这也是我第一次实测到的假绿）
for (const attr of ['data-cancel=', 'data-retry=', 'data-close=', 'data-copy=', 'data-expand=']) {
  if (!js.includes(attr + '"') && !js.includes(attr + "'")) problems.push(`页面缺少 ${attr}… 操作`);
}
for (const ep of ["'/api/cancel'", "'/api/retry'", "'/api/close'"]) {
  if (!js.includes(ep)) problems.push(`按钮没有接到 ${ep}`);
}
if (!js.includes('window.closeTicket = closeTicket')) problems.push('验收收单没挂到 window（内联/测试都调不到）');

// ⑧ 高效操作的入口必须齐（每个都对应一次真实的手工劳动）
for (const [id, why] of [
  ['q', '搜索框：单子一多，找一条是在表里用眼睛扫'],
  ['onlyNeed', '「只看需要我处理」：把不需要你的先收起来'],
  ['rerunFailed', '「重跑全部失败」：失败一批时要一张张点'],
  ['copyDir', '「复制执行目录」：目录只能靠手抄'],
  ['note', '操作后的回执行：点完按钮必须有反馈'],
]) {
  if (!page.includes('id="' + id + '"')) problems.push(`缺少 #${id}（${why}）`);
}
for (const [needle, why] of [
  ['e.metaKey || e.ctrlKey', '键盘：⌘/Ctrl+Enter 下发'],
  ["e.key === '/'", '键盘：/ 聚焦输入框'],
  ["e.key === 'Escape'", '键盘：Esc 收起详情/清空搜索'],
]) {
  if (!js.includes(needle)) problems.push(`缺少 ${needle}（${why}）`);
}
// ⑨ 数据没变就不重画（整表 + 详情面板 + 选中行三处都要判）
if (!js.includes('j !== lastJson')) problems.push('轮询没有「数据没变就不重画」，每 1.5 秒冲掉选中与滚动位置');
if (!js.includes("$('detail').textContent !== text")) problems.push('详情面板每轮都重写，正在选中的日志会被清掉');
if (!js.includes('var changed = selected !== id')) problems.push('打开详情后每轮都整表重画，选中行高亮把整表刷新了');
if (!js.includes('window.rerunFailed = rerunFailed')) problems.push('批量重跑没挂到 window（内联/测试都调不到）');

if (problems.length > 0) {
  console.error('页面脚本判红：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`页面脚本 OK：${js.length} 字节，经典脚本可解析，入口齐全，无「批准」，委托链路与取消/重跑都在，搜索/筛选/批量重跑/复制/键盘齐全，轮询不整表重画`);
