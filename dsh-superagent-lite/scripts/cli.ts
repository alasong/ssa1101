/**
 * scripts/cli.ts —— 把编排层当成一个**命令行小服务**用（不依赖宿主内集成）。
 *
 *   node scripts/cli.ts put "把登录页按钮改成蓝色"     投一条人工需求
 *   node scripts/cli.ts tick                          推进一轮（事件 → 工单 → 副作用）
 *   node scripts/cli.ts run [--interval 2000]          常驻：每 2 秒 tick 一次
 *   node scripts/cli.ts panel                         只打印「需要人」的
 *   node scripts/cli.ts board                         打印全 7 个 stage
 *   node scripts/cli.ts tickets                       列开着 的工单
 *   node scripts/cli.ts approve <ticketId>             人批准 → 结束工单（kaa 记账 + 回写）
 *   node scripts/cli.ts watch                         读一条 stdin 行就投一条需求（手工灌）
 *
 * 库默认 ~/.dsh/superagent-lite/sa.db，可用 SA_DB 覆盖。
 * kaa / 会话 / 回写在这个壳里都是**桩**（只打印），真接线见 src/app/kaa.ts 与 executor 的 factory。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { startRuntime } from '../src/app/runtime.ts';
import { manualEvent } from '../src/sources/manual.ts';
import { renderBoard, renderPanel } from '../src/panel/view.ts';

const dbPath = process.env.SA_DB ?? join(homedir(), '.dsh', 'superagent-lite', 'sa.db');
mkdirSync(dirname(dbPath), { recursive: true });

const gate = {
  check: () => ({
    allowed: true as const,
    mandate: { policyVersion: 'v1', scope: 'demo', strength: 'auto', basis: ['规则：需求明确即准入'] },
  }),
};

const say = (s: string) => process.stdout.write(s + '\n');
const rt = startRuntime({
  dbPath,
  gate,
  handlers: {
    launch: async () => say('  · launch    起会话（桩）'),
    deliver: async () => say('  · deliver   投给会话（桩）'),
    relay: async () => say('  · relay     推给人看'),
    reply: async () => say('  · reply     回人（桩）'),
    kaaDone: async () => say('  · kaaDone   kaa 记账（桩）'),
    treeWrite: async () => say('  · treeWrite 回写目标树（桩）'),
  },
});

const [cmd, ...rest] = process.argv.slice(2);
const tickOnce = async (label = '') => {
  const r = await rt.tick();
  say(`${label}消费 ${r.events} 条事件 / 跑掉 ${r.effects.settled} 个副作用 / 剩余到期 ${rt.repo.effects.claimDue(0).length}`);
  rt.repo.effects.recoverRunning();
};

try {
  switch (cmd) {
    case 'put': {
      const text = rest.join(' ').trim();
      if (text === '') throw new Error('用法：put "需求文本"');
      const e = manualEvent({ id: `m-${Date.now()}`, text }, Date.now());
      rt.repo.events.put(e);
      say(`已投需求：${text}`);
      say(`  事件 ${e.id}（externalId=${e.externalId}）→ 待处理 ${rt.repo.events.pending(10).length} 条`);
      break;
    }
    case 'tick':
      await tickOnce();
      break;
    case 'run': {
      const i = rest.indexOf('--interval');
      const ms = i >= 0 ? Number(rest[i + 1]) : 2_000;
      say(`常驻：每 ${ms}ms 一轮，库 ${dbPath}（Ctrl-C 退出）`);
      for (;;) {
        await tickOnce(`[${new Date().toISOString().slice(11, 19)}] `);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
    case 'panel': {
      const p = renderPanel(rt.repo.tickets.open());
      say(p === '' ? '（面板空：没有需要人的）' : p);
      break;
    }
    case 'board':
      say(renderBoard(rt.repo.tickets.open()));
      break;
    case 'tickets': {
      const ts = rt.repo.tickets.open();
      if (ts.length === 0) say('（没有开着的工单）');
      for (const t of ts) say(`${t.id}  ${t.stage}  thread=${t.threadKey}  assignment=${t.assignment?.state ?? '无'}`);
      break;
    }
    case 'approve': {
      const id = rest[0];
      if (id === undefined) throw new Error('用法：approve <ticketId>');
      const t = rt.repo.tickets.get(id);
      if (t === undefined) throw new Error(`没有工单 ${id}`);
      const closed = rt.engine.close(t);
      say(`已结束 ${closed.ticket.id}（state=${closed.ticket.state}），入队键 ${closed.effectKeys.join(' , ')}`);
      await tickOnce();
      break;
    }
    case 'watch': {
      say('从 stdin 读需求，一行一条（Ctrl-D 结束）');
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const lines = Buffer.concat(chunks).toString('utf8').split('\n').filter((l) => l.trim() !== '');
      for (const [i, line] of lines.entries()) {
        rt.repo.events.put(manualEvent({ id: `m-${Date.now()}-${i}`, text: line.trim() }, Date.now()));
        say(`  + ${line.trim()}`);
      }
      await tickOnce();
      break;
    }
    default:
      say('用法：put <文本> | tick | run [--interval ms] | panel | board | tickets | approve <id> | watch');
  }
} finally {
  rt.close();
}
