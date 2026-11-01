/**
 * tests/unit/kaa.test.ts —— app/kaa.ts 的单位测试。
 * 规格来源：详设 §2.2 三条纪律（只认退出码 + JSON / 超时按瞬时失败 / argv 契约），
 * 不是从实现反推。全程注入假 runner，不启动真进程、不依赖 kaa 存在。
 * 断言一律 assert.equal / deepEqual；每条规格至少一条 test，名字带规格编号便于归因。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  kaaDone,
  parseJson,
  DEFAULT_TIMEOUT_MS,
  type Runner,
  type RunnerResult,
} from '../../src/app/kaa.ts';

const SLUG = 'repo-x';
const NODE = 'n1';
const DECL = { stage: 'done', by: 'test' };
const EVIDENCE = { report: 'r-1', files: ['a'] };

/** 构造一个只回固定结果的桩 runner，并记录它收到的 argv / opts。 */
function stub(result: RunnerResult) {
  const calls: { argv: string[]; opts: { cwd: string; env: Record<string, string>; timeoutMs: number } }[] = [];
  const run: Runner = async (argv, opts) => {
    calls.push({ argv, opts });
    return result;
  };
  return { run, calls };
}

/** 1 秒兜底：断言调用自己返回，没被挂住。 */
function withDeadline<T>(p: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`调用未在 ${ms}ms 内返回（被挂住了）`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/* ── 纪律 1：只认退出码 + JSON，绝不解析人话 ───────────────────────────── */

test('纪律1 退出码 0 + ok JSON → ok=true 且 json 已解析', async () => {
  const { run } = stub({ code: 0, stdout: '{"ok":true,"node":"n1"}', timedOut: false });
  const r = await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run });

  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal((r.json as { ok?: unknown }).ok, true);
  assert.equal(r.timedOut, false);
});

test('纪律1 拒收时仍解析出缺项 JSON', async () => {
  const { run } = stub({ code: 3, stdout: '{"missing":["evidence"]}', timedOut: false });
  const r = await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run });

  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  // 拒收不是"丢掉结果"：缺项清单必须仍可读。
  assert.deepEqual(r.json, { missing: ['evidence'] });
  assert.equal(r.timedOut, false);
});

test('纪律1 退出码非 0 + 人类可读文本 → json 为 undefined、error 非空', async () => {
  const { run } = stub({ code: 2, stdout: 'Done! node n1 marked.', timedOut: false });
  const r = await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run });

  assert.equal(r.ok, false);
  assert.equal(r.code, 2);
  assert.equal(r.json, undefined, '人话绝不参与判定');
  assert.equal(typeof r.error, 'string');
  assert.notEqual(r.error, '');
});

/* ── 纪律 2：超时按瞬时失败处理，不阻塞 ──────────────────────────────── */

test('纪律2 超时 → ok=false、timedOut=true、error 含超时信息，且调用自己返回', async () => {
  const { run } = stub({ code: null, stdout: '', timedOut: true });
  const r = await withDeadline(kaaDone(SLUG, NODE, DECL, EVIDENCE, { run }));

  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.code, null);
  assert.match(String(r.error), /超时/);
});

test('纪律2 超时用例不真等：假 runner 立即返回，直接走 timedOut 分支', async () => {
  const { run } = stub({ code: null, stdout: '', timedOut: true });
  const started = Date.now();
  const r = await withDeadline(kaaDone(SLUG, NODE, DECL, EVIDENCE, { run }));
  const elapsed = Date.now() - started;

  assert.equal(r.timedOut, true);
  assert.ok(elapsed < 200, `不应真等超时，实际耗时 ${elapsed}ms`);
});

/* ── 纪律 3：argv 契约 ──────────────────────────────────────────────── */

test('纪律3 argv 契约 + cwd 透传 + KAA_TARGET_ROOT 进 env', async () => {
  const { run, calls } = stub({ code: 0, stdout: '{"ok":true}', timedOut: false });
  const cwd = '/fat3-root';
  const targetRoot = '/target-repo';
  await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run, cwd, targetRoot });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.deepEqual(call.argv, [
    'python3',
    'skills/kaa/kaa.py',
    'done',
    SLUG,
    NODE,
    '--declarations',
    JSON.stringify(DECL),
    '--evidence-meta',
    JSON.stringify(EVIDENCE),
  ]);
  assert.equal(call.opts.cwd, cwd);
  assert.equal(call.opts.env.KAA_TARGET_ROOT, targetRoot);
});

/* ── 纪律 4：超时上限 ───────────────────────────────────────────────── */

test('纪律4 不传 timeoutMs → runner 收到 DEFAULT_TIMEOUT_MS（30000）', async () => {
  const { run, calls } = stub({ code: 0, stdout: '{"ok":true}', timedOut: false });
  await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run });

  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  assert.equal(calls[0]!.opts.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('纪律4 传 timeoutMs:50 → runner 收到 50', async () => {
  const { run, calls } = stub({ code: 0, stdout: '{"ok":true}', timedOut: false });
  await kaaDone(SLUG, NODE, DECL, EVIDENCE, { run, timeoutMs: 50 });

  assert.equal(calls[0]!.opts.timeoutMs, 50);
});

/* ── 纪律 5：spawn 抛错不阻塞 ────────────────────────────────────────── */

test('纪律5 runner 抛错 → kaaDone 不抛，返回 ok=false 且 error 含 ENOENT', async () => {
  const run: Runner = async () => {
    throw new Error('ENOENT');
  };
  const r = await withDeadline(kaaDone(SLUG, NODE, DECL, EVIDENCE, { run }));

  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.match(String(r.error), /ENOENT/);
});

/* ── 纪律 6：parseJson 边界 ─────────────────────────────────────────── */

test('纪律6 parseJson 两侧空白 → 解析成功', () => {
  assert.deepEqual(parseJson('  {"a":1}  '), { a: 1 });
});

test('纪律6 parseJson 非 JSON → undefined', () => {
  assert.equal(parseJson('not json'), undefined);
});

test('纪律6 parseJson 空串 → undefined', () => {
  assert.equal(parseJson(''), undefined);
});

test('纪律6 parseJson 尾部有残留 → undefined（整段才算 JSON）', () => {
  assert.equal(parseJson('{"a":1} trailing'), undefined);
});
