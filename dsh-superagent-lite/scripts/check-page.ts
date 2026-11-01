/**
 * scripts/check-page.ts —— 机检控制台的页面脚本能不能在浏览器里跑。
 *
 *   node scripts/check-page.ts
 *
 * 判据（都是“浏览器里会真的出错”的形态）：
 *   ① 经典脚本可解析：`new Function(js)` 不抛——顶层 await 会在这里抛（浏览器同样会抛，
 *      整段脚本不执行，按钮全死，页面上看不出任何提示）。
 *   ② 没有 type=module：内联 onclick 只能调全局函数。
 *   ③ 两个入口挂在 window 上：submitTask / approve 必须能被 `onclick` 找到。
 *   ④ 有 id="send" 按钮且绑了 click / Enter。
 * 反例：把 `refresh();` 改成 `await refresh();` → ① 立刻判红。
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
for (const fn of ['submitTask', 'approve']) {
  if (!js.includes(`window.${fn} = ${fn}`)) problems.push(`没把 ${fn} 挂到 window 上（内联 onclick 调不到）`);
}
if (!js.includes(`getElementById('send')`) || !js.includes(`addEventListener('click', submitTask)`)) {
  problems.push('「下发」按钮没绑 click');
}
if (!js.includes(`e.key === 'Enter'`)) problems.push('输入框没绑回车提交');

if (problems.length > 0) {
  console.error('页面脚本判红：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`页面脚本 OK：${js.length} 字节，经典脚本可解析，两个入口挂在 window 上，「下发」绑了 click 与 Enter`);
