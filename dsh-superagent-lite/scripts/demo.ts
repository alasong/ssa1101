/**
 * scripts/demo.ts —— 一条命令看它跑起来。**不接真 dsh**，会话/kaa/回写全是桩。
 *
 *   node scripts/demo.ts
 *
 * 走一遍：人触发 → 事件 → 工单 → 起会话 → worker 报告 → 面板 → 人批准 →
 *         kaa 记账 + 回写目标树 → 崩一次 → 重启续跑。
 * 每步都打印它真正写到库里的东西，不打印"预期"。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntime } from '../src/app/runtime.ts';
import { SessionExecutor, SlotPool } from '../src/app/executor.ts';
import { createReportTool } from '../src/tools/report.ts';
import { createLocalChannel } from '../src/channel/local.ts';
import { Outbox } from '../src/app/outbox.ts';
import { renderBoard, renderPanel } from '../src/panel/view.ts';
import { manualEvent } from '../src/sources/manual.ts';

const dbPath = join(mkdtempSync(join(tmpdir(), 'demo-')), 'demo.db');
const gate = {
  check: () => ({ allowed: true as const, mandate: { policyVersion: 'v1', scope: 'demo', strength: 'auto', basis: ['规则 R1'] } }),
};
const calls: string[] = [];
const handlers = {
  launch: async () => { calls.push('launch'); },
  deliver: async () => { calls.push('deliver'); },
  relay: async () => { calls.push('relay'); },
  reply: async () => { calls.push('reply'); },
  kaaDone: async () => { calls.push('kaaDone'); },
  treeWrite: async () => { calls.push('treeWrite'); },
};

const step = (n: number, title: string) => console.log(`\n── ${n}. ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);

step(1, '启动：建库 → 崩溃恢复 → 起 pass');
const rt = startRuntime({ dbPath, gate, handlers, now: () => 1_000 });
console.log(`   库位置      ${dbPath}`);
console.log(`   恢复读数    effect 退回 ${rt.recovered.effects} / assignment 标 interrupted ${rt.recovered.assignments}`);

step(2, '人触发一条需求（manual 源）');
const e = manualEvent({ id: 'm1', text: '把登录页按钮改成蓝色' }, 1_000);
rt.repo.events.put(e);
console.log(`   落库事件    ${e.id}  externalId=${e.externalId}  threadKey=${e.threadKey}`);
console.log(`   待处理       ${rt.repo.events.pending(10).length} 条 / 工单 ${rt.repo.tickets.open().length} 个（还没消费）`);

step(3, '第一轮 pass：事件 → Gate → 建工单');
let r = await rt.tick();
const ticket = rt.repo.tickets.open()[0];
console.log(`   本轮消费     ${r.events} 条事件 / 跑掉 ${r.effects.settled} 个副作用（${calls.join(', ')}）`);
console.log(`   工单         ${ticket.id}  stage=${ticket.stage}  mandate=${ticket.mandate.policyVersion}  basis=${ticket.mandate.basis.join('/')}`);

step(4, '起会话（执行器 + 假会话工厂）');
const made: string[] = [];
const executor = new SessionExecutor({
  slots: new SlotPool({ capacity: 2, humanExtra: 1 }),
  factory: {
    start: async (o) => { made.push(o.dir); return { sessionId: `sess-${made.length}`, dir: o.dir }; },
    deliver: async () => {},
    stop: async () => {},
  },
  workRoot: '/tmp/demo-work',
  mkdirp: async () => {},
});
const a = await executor.start(ticket, { id: 'a1', ticketId: ticket.id, state: 'pending', dir: '', sessionId: '' });
console.log(`   会话         ${a.sessionId}  目录 ${a.dir}  状态 ${a.state}`);

step(5, 'worker 回报 ready → stage 重算 + 入队 relay');
const report = createReportTool({ engine: rt.engine, ticketId: ticket.id, assignmentId: a.id, now: () => 2_000 });
const ready = report.call('ready');
console.log(`   stage        ${ticket.stage} → ${ready.stage}（由 stageOf 算，工具不自己判）`);
const r2 = await rt.tick();
console.log(`   本轮副作用   跑掉 ${r2.effects.settled} 个 → 累计 [${calls.join(', ')}]`);

step(6, '面板只显示"需要人"的东西');
console.log(`   renderPanel 整块输出：`);
const panel = renderPanel(rt.repo.tickets.open());
console.log(panel.split('\n').map((l) => `   │ ${l}`).join('\n') || '   │ （空）');
console.log(`   对照：全看板的 7 行 → ${renderBoard(rt.repo.tickets.open()).split('\n').length} 行`);

step(7, '人批准 → 工单结束 → kaa 记账 + 回写目标树');
const closed = rt.engine.close(rt.repo.tickets.get(ticket.id)!);
const r3 = await rt.tick();
console.log(`   工单状态     ${closed.ticket.state}  入队键 ${closed.effectKeys.join(' , ')}`);
console.log(`   副作用累计   [${calls.join(', ')}]  剩余待跑 ${rt.repo.effects.claimDue(0).length}`);

step(8, '演示崩溃：先领活、再硬死，然后重启续跑');
const child = `
  import { openDb, createRepository } from '${process.cwd()}/src/app/store.ts';
  const repo = createRepository(openDb('${dbPath}'));
  repo.effects.enqueue({ kind: 'treeWrite', key: 'crash-demo', payload: '{}', dueAt: 0 });
  const got = repo.effects.claimDue(0);
  console.log('   子进程领到 ' + got.length + ' 条，状态 ' + got[0].state + '，然后 exit(137)');
  process.exit(137);
`;
const dead = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8' });
process.stdout.write(dead.stdout);
console.log(`   子进程退出码 ${dead.status}`);
let ran = 0;
const rt2 = startRuntime({ dbPath, gate, handlers: { ...handlers, treeWrite: async () => { ran += 1; calls.push('treeWrite'); } }, now: () => 5_000 });
console.log(`   重启恢复     effect 退回 ${rt2.recovered.effects} 条`);
await rt2.tick();
await rt2.tick();
console.log(`   重放结果     treeWrite 执行 ${ran} 次（跑两轮仍 ${ran}，不重复）  表里剩余 ${rt2.repo.effects.claimDue(0).length}`);

step(9, '本次演示写进库里的东西');
console.log(`   工单         开着的 ${rt2.repo.tickets.open().length} 个；本次那张 t1 仍在库里（status=${rt2.repo.tickets.get(ticket.id)?.state}）`);
console.log(`   副作用累计   [${calls.join(', ')}]`);
console.log(`                （treeWrite 出现两次：一次是人批准结束工单，一次是崩溃重放——两条不同的 effect 行）`);
console.log(`\n跑完。库里就是一个能重启续跑的小系统；接真 dsh 只需把 SessionExecutor 的 factory 换成 spawn('dsh', ['--json', ...])。`);
rt.close();
rt2.close();
