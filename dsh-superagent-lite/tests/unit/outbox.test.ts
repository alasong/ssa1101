/**
 * tests/unit/outbox.test.ts —— 出站队列（K10 / R11）与本地通道的 7 条规格。
 *
 * 规格来源是 R11 的条文，不是从实现反推：
 *  - 同通道保序是**结构**保证（每通道一条 promise 链），所以规格 1 的假通道
 *    让第 1 条最慢、第 3 条最快：并发投递会让完成顺序变成 c,b,a，串行才留 a,b,c。
 *  - 幂等按 `message.id`，第二次不碰通道。
 *  - 每通道一条链，所以 A 挂起不能拖住 B。
 *  - 未知通道 → dropped 且 reason 带通道名；通道抛错 → dropped 但链不断。
 *  - local 通道的 log / write 都是注入的，测试不碰真网络、不看日志格式细节。
 *
 * 不用 sleep 等真时间：跨通道阻塞用手动 resolve 的 promise，最长的定时器 12ms。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { OutboundMessage } from '../../src/core/model.ts';
import type { Channel } from '../../src/app/outbox.ts';
import { Outbox } from '../../src/app/outbox.ts';
import { createLocalChannel, treeTargetOf } from '../../src/channel/local.ts';

function msg(id: string, channel = 'ch', extra: Partial<OutboundMessage> = {}): OutboundMessage {
  return { id, channel, text: `text-${id}`, kind: 'reply', ...extra };
}

/** 假通道：同步记录每次 send 收到的消息（按调用顺序）。 */
interface RecordingChannel extends Channel {
  readonly calls: OutboundMessage[];
}

function recordingChannel(name: string): RecordingChannel {
  const calls: OutboundMessage[] = [];
  return {
    name,
    calls,
    send(m: OutboundMessage): void {
      calls.push(m);
    },
  };
}

/**
 * 假通道：send 的完成时间由 delaysMs 逐次给出，**在完成时**才记进 delivered。
 * 串行投递（等前一条结束再发下一条）→ a,b,c；并发投递 → 快的先到，顺序被打乱。
 */
interface StaggeredChannel extends Channel {
  readonly delivered: string[];
}

function staggeredChannel(name: string, delaysMs: readonly number[]): StaggeredChannel {
  const delivered: string[] = [];
  let index = 0;
  return {
    name,
    delivered,
    send(m: OutboundMessage): Promise<void> {
      const delay = delaysMs[index] ?? 0;
      index += 1;
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          delivered.push(m.id);
          resolve();
        }, delay);
      });
    },
  };
}

/** 手动 resolve 的闸门：跨通道测试用它替代 sleep。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test('1 同会话三条按序到达：同通道 a,b,c 顺序不变且都是 sent', async () => {
  const ch = staggeredChannel('ch', [12, 6, 1]);
  const outbox = new Outbox([ch]);

  const results = await Promise.all([outbox.send(msg('a')), outbox.send(msg('b')), outbox.send(msg('c'))]);

  assert.deepEqual(ch.delivered, ['a', 'b', 'c']);
  assert.deepEqual(
    results.map((r) => r.status),
    ['sent', 'sent', 'sent'],
  );
  for (const id of ['a', 'b', 'c']) assert.equal(outbox.status(id), 'sent');
});

test('2 幂等：同 id 第二次返回 duplicate，假通道只被调用一次', async () => {
  const ch = recordingChannel('ch');
  const outbox = new Outbox([ch]);
  const m = msg('dup-1');

  const first = await outbox.send(m);
  const second = await outbox.send({ ...m, text: 'second attempt' });

  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'duplicate');
  assert.equal(ch.calls.length, 1);
  assert.deepEqual(ch.calls.map((c) => c.id), ['dup-1']);
});

test('3 跨通道互不阻塞：A 挂起时 B 先完成（每通道一条链）', async () => {
  const hold = gate();
  const done: string[] = [];
  const aChannel: Channel = {
    name: 'A',
    send(): Promise<void> {
      return hold.promise;
    },
  };
  const bChannel: Channel = {
    name: 'B',
    send(): void {
      /* 立即完成 */
    },
  };
  const outbox = new Outbox([aChannel, bChannel]);

  let aSettled = false;
  const aDone = outbox.send(msg('a-1', 'A')).then((r) => {
    aSettled = true;
    done.push('A');
    return r;
  });
  const bDone = outbox.send(msg('b-1', 'B')).then((r) => {
    done.push('B');
    return r;
  });

  // 有界上限：若实现退化成全局单链，B 会被 A 拖住，这里应判红而不是把测试挂死。
  const guard = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 50);
    void t.unref?.();
  });
  const raced = await Promise.race([bDone, guard]);
  assert.notEqual(raced, 'timeout', 'B 被 A 阻塞：跨通道不是各自一条链');
  const bResult = raced as { status: string };
  assert.equal(bResult.status, 'sent');
  assert.deepEqual(done, ['B'], 'B 必须在 A 之前完成（A 还挂着）');
  assert.equal(aSettled, false);

  hold.open();
  const aResult = await aDone;
  assert.equal(aResult.status, 'sent');
  assert.deepEqual(done, ['B', 'A']);
});

test('4 未知通道：返回 dropped，reason 含通道名，status() 也是 dropped', async () => {
  const outbox = new Outbox();

  const result = await outbox.send(msg('lost-1', 'ghost'));

  assert.equal(result.status, 'dropped');
  assert.ok(typeof result.reason === 'string' && result.reason.includes('ghost'), 'reason 应含通道名');
  assert.equal(outbox.status('lost-1'), 'dropped');
});

test('5 通道抛错：该条 dropped，后续消息仍能投递', async () => {
  const received: string[] = [];
  const flaky: Channel = {
    name: 'flaky',
    send(m: OutboundMessage): void {
      if (m.id === 'boom') throw new Error('boom');
      received.push(m.id);
    },
  };
  const outbox = new Outbox([flaky]);

  const failed = await outbox.send(msg('boom', 'flaky'));
  assert.equal(failed.status, 'dropped');

  const next = await outbox.send(msg('after-boom', 'flaky'));
  assert.equal(next.status, 'sent');
  assert.deepEqual(received, ['after-boom']);
});

test('6a local 通道：log 收到含 m.id 的一行', async () => {
  const lines: string[] = [];
  const channel = createLocalChannel({ log: (line) => lines.push(line) });

  await channel.send(msg('local-7', 'local'));

  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('local-7'), '日志行应含消息 id');
});

test('6b local 通道：传了 write 就调用一次并拿到同一条 message', async () => {
  const written: OutboundMessage[] = [];
  const channel = createLocalChannel({
    log: () => {},
    write: (m) => {
      written.push(m);
    },
  });
  const m = msg('local-w', 'local');

  await channel.send(m);

  assert.equal(written.length, 1);
  assert.equal(written[0], m);
});

test('7 treeTargetOf：notify 的 slug#node 解析，reply 与无 # 文本返回 undefined', () => {
  assert.deepEqual(treeTargetOf(msg('t1', 'local', { kind: 'notify', text: 'slug#node' })), {
    slug: 'slug',
    node: 'node',
  });
  assert.equal(treeTargetOf(msg('t2', 'local', { kind: 'reply', text: 'slug#node' })), undefined);
  assert.equal(treeTargetOf(msg('t3', 'local', { kind: 'notify', text: 'nohash' })), undefined);
});
