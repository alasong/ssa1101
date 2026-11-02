/**
 * tests/unit/dsh-session.test.ts —— 真 worker 的接线（src/app/dsh-session.ts）。
 *
 * 规格来源是"页面上要能看见什么"，不是实现细节：
 *  - 派给谁：runId 立刻有；dsh 的 sessionId 要等 `{"type":"session"}` 事件，没到之前必须是
 *    **null**，不许编一个假 id（编了就分不清"还没起来"和"跑起来了"）。
 *  - 跑了什么：stdout 的 ndjson 逐行落盘到 `<dir>/session.ndjson`，行数是进度；
 *    `{"type":"final","text":…}` 是最终结果，要同时写进 `<dir>/result.md`（产物）。
 *  - 怎么结束的：exit 0 → done；非 0 → failed；人 stop → stopped（不是 done）；
 *    spawn 失败 → failed 且 error 非空。
 *
 * 不给真进程：spawn 注入，喂 ndjson 字符串。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

import { createDshSessionFactory, readLine } from '../../src/app/dsh-session.ts';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill(sig?: string): boolean;
  killed: boolean;
}

function fakeChild(): FakeChild {
  const c = new EventEmitter() as unknown as FakeChild;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    c.emit('close', null);
    return true;
  };
  return c;
}

function tmpDir(): string {
  const d = `/tmp/dsh-session-test-${randomUUID()}`;
  mkdirSync(d, { recursive: true });
  return d;
}

/** 等运行记录离开 running（结束态由 close / error / stop 触发）。 */
async function settle(get: () => { state: string } | undefined): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const r = get();
    if (r !== undefined && r.state !== 'running') return;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('等不到结束态（200 次轮询后仍是 running）');
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 30));

test('1. 成功：session 与 final 都认出来，日志落盘，result.md 是最终答复', async () => {
  const dir = tmpDir();
  const child = fakeChild();
  let spawned: { cmd: string; args: string[]; cwd: string } | undefined;
  const f = createDshSessionFactory({
    spawn: ((cmd: string, args: string[], o: { cwd: string }) => {
      spawned = { cmd, args, cwd: o.cwd };
      return child as never;
    }) as never,
  });

  const h = await f.start({ ticketId: 't1', agentPreset: 'w', dir, firstMessage: '把按钮改成蓝色' });
  assert.equal(h.sessionId.startsWith('w-t1-'), true, 'runId 必须是 w-<ticket>-… 且立刻可用');
  assert.equal(h.dir, dir);

  await tick();
  assert.equal(f.snapshot('t1')?.dshSessionId, null, '还没收到 session 事件时不许编 id');

  child.stdout.write(`${JSON.stringify({ type: 'session', sessionId: 'session-real-1', cwd: dir })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'status', phase: 'turn_start' })}\n`);
  child.stdout.write(`${JSON.stringify({ type: 'final', text: '改好了' })}\n`);
  await tick();
  assert.equal(f.snapshot('t1')?.dshSessionId, 'session-real-1', 'session 事件里的 id 要记下来');

  child.emit('close', 0);
  await settle(() => f.snapshot('t1'));

  const r = f.snapshot('t1');
  assert.equal(r?.state, 'done');
  assert.equal(r?.exitCode, 0);
  assert.equal(r?.lines, 3, 'ndjson 三行都要数到');
  assert.equal(r?.finalText, '改好了');

  await tick();
  const log = readFileSync(`${dir}/session.ndjson`, 'utf8').trimEnd().split('\n');
  assert.equal(log.length, 3, '三行原文都要落盘（不靠内存）');
  assert.match(log[0], /session-real-1/);
  assert.equal(readFileSync(`${dir}/result.md`, 'utf8'), '改好了', '最终答复要成为产物');
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(spawned, undefined);
  assert.deepEqual(
    spawned?.args,
    ['--profile', 'headless', '--json', '把按钮改成蓝色'],
    '命令里要带任务正文，不是 threadKey',
  );
});

test('2. 退出码非 0 → failed；没有 final 时 result.md 说明情况而不是空文件', async () => {
  const dir = tmpDir();
  const child = fakeChild();
  const f = createDshSessionFactory({ spawn: (() => child as never) as never });
  await f.start({ ticketId: 't2', agentPreset: 'w', dir, firstMessage: 'x' });
  child.stdout.write(`${JSON.stringify({ type: 'session', sessionId: 's2' })}\n`);
  await tick();
  child.emit('close', 2);
  await settle(() => f.snapshot('t2'));
  const r = f.snapshot('t2');
  assert.equal(r?.state, 'failed');
  assert.equal(r?.exitCode, 2);
  await tick();
  const md = readFileSync(`${dir}/result.md`, 'utf8');
  assert.match(md, /没有 final 事件/, '失败也要留下可读的产物说明');
  assert.match(md, /exit=2/);
  rmSync(dir, { recursive: true, force: true });
});

test('3. spawn 抛错 → failed 且 error 有原因（不静默）', async () => {
  const dir = tmpDir();
  const child = fakeChild();
  const f = createDshSessionFactory({ spawn: (() => child as never) as never });
  await f.start({ ticketId: 't3', agentPreset: 'w', dir, firstMessage: 'x' });
  child.emit('error', new Error('spawn dsh ENOENT'));
  await settle(() => f.snapshot('t3'));
  const r = f.snapshot('t3');
  assert.equal(r?.state, 'failed');
  assert.match(String(r?.error), /ENOENT/);
  assert.equal(existsSync(`${dir}/session.ndjson`), true, 'spawn 之前就要有日志文件，否则分不清"没跑"与"没日志"');
  rmSync(dir, { recursive: true, force: true });
});

test('4. 人 stop → stopped（不是 done），且真的 kill 了子进程', async () => {
  const dir = tmpDir();
  const child = fakeChild();
  const f = createDshSessionFactory({ spawn: (() => child as never) as never });
  const h = await f.start({ ticketId: 't4', agentPreset: 'w', dir, firstMessage: 'x' });
  await tick();
  await f.stop(h.sessionId, 'approved');
  const r = f.snapshot('t4');
  assert.equal(r?.state, 'stopped');
  assert.equal(child.killed, true, 'stop 必须真的发信号，不能只改状态');
  rmSync(dir, { recursive: true, force: true });
});

test('5. readLine：认 session / final / turn_end 的失败原因，坏 JSON 与其它类型都不抛', () => {
  assert.deepEqual(readLine(JSON.stringify({ type: 'session', sessionId: 'a' })), { sessionId: 'a' });
  assert.deepEqual(readLine(JSON.stringify({ type: 'final', text: '好' })), { finalText: '好' });
  assert.deepEqual(readLine('not json'), {});
  assert.deepEqual(readLine('{broken'), {});
  assert.deepEqual(readLine(JSON.stringify({ type: 'status', phase: 'x' })), {});
  assert.deepEqual(readLine(JSON.stringify({ type: 'session' })), {}, 'sessionId 不是字符串就不认');
  // 失败原因就在这一行：不认它，worker 就只剩一个"退出码 1"，查不出为什么
  assert.deepEqual(
    readLine(JSON.stringify({
      type: 'status',
      phase: 'turn_end',
      reason: { kind: 'error', error: { message: 'AUTH 401: key invalid' } },
    })),
    { error: 'AUTH 401: key invalid' },
  );
  assert.deepEqual(readLine(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } })), {});
});

test('6. turn_end 报错 → 原因进 record、进 worker.json 的 error、也进 result.md', async () => {
  const dir = tmpDir();
  const child = fakeChild();
  const seen: string[] = [];
  const f = createDshSessionFactory({
    spawn: (() => child as never) as never,
    onEnd: (r) => seen.push(String(r.error)),
  });
  await f.start({ ticketId: 't6', agentPreset: 'w', dir, firstMessage: 'x' });
  child.stdout.write(`${JSON.stringify({ type: 'session', sessionId: 's6' })}\n`);
  child.stdout.write(`${JSON.stringify({
    type: 'status',
    phase: 'turn_end',
    reason: { kind: 'error', error: { message: 'AUTH 401: Authentication Fails' } },
  })}\n`);
  await tick();
  child.stdout.write(`${JSON.stringify({ type: 'final', text: '' })}\n`);
  child.emit('close', 1);
  await settle(() => f.snapshot('t6'));
  const r = f.snapshot('t6');
  assert.equal(r?.state, 'failed');
  assert.match(String(r?.error), /AUTH 401/, '失败原因必须被记下来，否则页面只能显示退出码');
  assert.deepEqual(seen, ['AUTH 401: Authentication Fails'], 'onEnd 收到的记录里也要有原因');
  const md = readFileSync(`${dir}/result.md`, 'utf8');
  assert.match(md, /失败原因: AUTH 401/);
  assert.match(md, /exit=1/);
  rmSync(dir, { recursive: true, force: true });
});
