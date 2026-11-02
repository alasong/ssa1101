/**
 * src/app/dsh-session.ts —— 真的宿主会话（P4 的实现）：spawn `dsh --json` 跑一个 worker。
 *
 * 为什么要有这个文件：executor 只定义了 `SessionFactory` 端口，之前控制台注入的是**假工厂**
 * （只编一个 sessionId），于是"派给了谁"和"执行出了什么"两样都看不见。这里把真进程接上：
 *
 *  - 每个 assignment 起一个 `dsh --profile <p> --json <任务>` 子进程，cwd 就是 assignment 目录；
 *  - stdout 是 ndjson，**逐行原样落盘**到 `<dir>/session.ndjson`（事后能回放，不靠内存）；
 *  - 认两种事件：`{"type":"session","sessionId":…}` 记 worker 的真实会话 id，
 *    `{"type":"final","text":…}` 记最终答复；
 *  - 进程退出后写 `<dir>/result.md`（产物），并把状态记成 done / failed / stopped。
 *
 * `runId` 是我们自己发的号（`w-<ticket>-<时间>`），**立刻可用**；dsh 的 sessionId 要等第一条
 * 事件才有，所以两者都记，页面分别显示——不要用一个冒充另一个。
 *
 * 纪律：spawn 可注入（测试不给真进程），可执行文件与 profile 走环境变量覆盖，超时显式 kill。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { SessionHandle } from './executor.ts';

/** 一次 worker 运行的完整记录（页面与 /api 都用它）。 */
export interface DshRunRecord {
  runId: string;
  ticketId: string;
  /** dsh 自己的会话 id；还没收到 session 事件时为 null（不是假 id）。 */
  dshSessionId: string | null;
  dir: string;
  cmd: string[];
  logPath: string;
  state: 'running' | 'done' | 'failed' | 'stopped';
  exitCode: number | null;
  /** 已收到的 ndjson 行数（进度用；不是 token 数）。 */
  lines: number;
  /** 最近若干行原文，供页面直接看。 */
  tail: string[];
  finalText: string | null;
  stderrTail: string[];
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface SpawnLike {
  (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): ChildProcess;
}

export interface DshSessionDeps {
  /** 默认 $SA_DSH 或 'dsh'。 */
  bin?: string;
  /** 默认 $SA_DSH_PROFILE 或 'headless'。 */
  profile?: string;
  /** 额外参数，插在 profile 之后、任务之前。 */
  extraArgs?: string[];
  /** 默认 300000（5 分钟）到点 SIGTERM。 */
  timeoutMs?: number;
  /** 内存里保留的日志尾部行数，默认 40。 */
  tailLines?: number;
  /** 注入真进程（测试用假的）。 */
  spawn?: SpawnLike;
  /** 每次记录变化时回调（落库/推页面用）。 */
  onChange?: (r: DshRunRecord) => void;
  /** 结束时的回调（只调一次），用于把结果写进库。 */
  onEnd?: (r: DshRunRecord) => void;
}

/** 一行 ndjson → 关心的字段。解析失败不算错：非 JSON 行只落盘、不解释。 */
export function readLine(line: string): { sessionId?: string; finalText?: string; error?: string } {
  const s = line.trim();
  if (s === '' || s[0] !== '{') return {};
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return {};
  }
  if (v === null || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const out: { sessionId?: string; finalText?: string; error?: string } = {};
  if (o.type === 'session' && typeof o.sessionId === 'string') out.sessionId = o.sessionId;
  if (o.type === 'final' && typeof o.text === 'string') out.finalText = o.text;
  // 失败原因来自 `turn_end.reason`（如 `{"kind":"error","error":{"message":"…AUTH 401…"}}`）。
  // 不认这一条时，worker.json 里 error 永远是 null，页面只能显示「退出码 1」，等于没原因。
  const reason = o.reason as { kind?: unknown; error?: { message?: unknown } } | undefined;
  if (o.type === 'status' && reason?.kind === 'error' && typeof reason.error?.message === 'string') {
    out.error = reason.error.message;
  }
  if (o.type === 'error') {
    const direct = (o.error as { message?: unknown } | undefined)?.message ?? o.message;
    if (typeof direct === 'string') out.error = direct;
  }
  return out;
}

/** 把 `dsh --json` 的输出接成 SessionFactory。 */
export function createDshSessionFactory(deps: DshSessionDeps = {}) {
  const bin = deps.bin ?? process.env.SA_DSH ?? 'dsh';
  const profile = deps.profile ?? process.env.SA_DSH_PROFILE ?? 'headless';
  const extraArgs = deps.extraArgs ?? [];
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const tailLines = deps.tailLines ?? 40;
  const doSpawn: SpawnLike = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);

  /** ticketId → 最近一次运行（页面按 ticket 查）。 */
  const byTicket = new Map<string, DshRunRecord>();
  /** runId → { record, child }。 */
  const live = new Map<string, { record: DshRunRecord; child?: ChildProcess; timer?: NodeJS.Timeout }>();

  const touch = (r: DshRunRecord): void => deps.onChange?.(r);

  const pushLine = (r: DshRunRecord, line: string): void => {
    r.lines += 1;
    r.tail.push(line);
    if (r.tail.length > tailLines) r.tail.splice(0, r.tail.length - tailLines);
    const parsed = readLine(line);
    if (parsed.sessionId !== undefined) r.dshSessionId = parsed.sessionId;
    if (parsed.finalText !== undefined) r.finalText = parsed.finalText;
    if (parsed.error !== undefined && r.error === null) r.error = parsed.error;
  };

  const finish = (r: DshRunRecord, state: DshRunRecord['state'], exitCode: number | null): void => {
    if (r.state !== 'running') return;
    r.state = state;
    r.exitCode = exitCode;
    r.endedAt = Date.now();
    // 产物：最终答复落盘；没有答复时把失败原因写进去——"退出码 1 但不知道为什么"是最难查的一种
    try {
      const missing =
        r.error === null
          ? `（本次运行没有 final 事件）\nexit=${String(exitCode)}\n`
          : `（本次运行没有 final 事件）\n失败原因: ${r.error}\nexit=${String(exitCode)}\n`;
      // 空答复同样算"没产出"：`final` 的 text 是 '' 时 ?? 不会落到说明上，会写出一个空文件
      const answered = r.finalText !== null && r.finalText.trim() !== '';
      writeFileSync(join(r.dir, 'result.md'), answered ? (r.finalText as string) : missing);
    } catch {
      /* 目录没了就算了，不影响状态 */
    }
    touch(r);
    deps.onEnd?.(r);
  };

  return {
    /** SessionFactory.start：立刻返回我们的 runId，dsh 的 sessionId 稍后补上。 */
    async start(o: { ticketId: string; agentPreset: string; dir: string; firstMessage: string }): Promise<SessionHandle> {
      mkdirSync(o.dir, { recursive: true });
      const runId = `w-${o.ticketId}-${Date.now().toString(36)}`;
      const logPath = join(o.dir, 'session.ndjson');
      const cmd = [bin, '--profile', profile, ...extraArgs, '--json', o.firstMessage];
      const r: DshRunRecord = {
        runId,
        ticketId: o.ticketId,
        dshSessionId: null,
        dir: o.dir,
        cmd,
        logPath,
        state: 'running',
        exitCode: null,
        lines: 0,
        tail: [],
        finalText: null,
        stderrTail: [],
        error: null,
        startedAt: Date.now(),
        endedAt: null,
      };
      byTicket.set(o.ticketId, r);

      // 先建文件再 spawn：即便进程立刻崩，日志文件也存在（"没有日志"与"没跑"要能分开）
      closeSync(openSync(logPath, 'a'));
      const logStream = createWriteStream(logPath, { flags: 'a' });
      // 日志写失败（目录被删、磁盘满）不能让控制台崩：记下来，运行状态照常走
      logStream.on('error', (e: Error) => {
        r.error = `日志写入失败: ${String(e)}`;
      });
      const child = doSpawn(cmd[0], cmd.slice(1), { cwd: o.dir, env: process.env });
      const slot = { record: r, child, timer: undefined as NodeJS.Timeout | undefined };
      live.set(runId, slot);

      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buf += chunk;
        let i = buf.indexOf('\n');
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          logStream.write(`${line}\n`);
          pushLine(r, line);
          i = buf.indexOf('\n');
        }
        touch(r);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of String(chunk).split('\n')) {
          if (line.trim() === '') continue;
          r.stderrTail.push(line);
          if (r.stderrTail.length > 20) r.stderrTail.shift();
        }
        touch(r);
      });
      child.on('error', (e: Error) => {
        r.error = String(e);
        logStream.end();
        finish(r, 'failed', null);
        live.delete(runId);
      });
      child.on('close', (code: number | null) => {
        if (buf.trim() !== '') {
          logStream.write(`${buf}\n`);
          pushLine(r, buf);
          buf = '';
        }
        logStream.end();
        if (slot.timer !== undefined) clearTimeout(slot.timer);
        if (r.state === 'running') finish(r, code === 0 ? 'done' : 'failed', code);
        live.delete(runId);
      });

      slot.timer = setTimeout(() => {
        r.error = `超时 ${timeoutMs}ms，已 SIGTERM`;
        try {
          child.kill('SIGTERM');
        } catch {
          /* 已经退了 */
        }
      }, timeoutMs);
      slot.timer.unref?.();

      touch(r);
      return { sessionId: runId, dir: o.dir };
    },

    /** 人插话：headless 一次一答、没有常驻 stdin，所以这里如实说不支持（不假装已投递）。 */
    async deliver(sessionId: string, text: string): Promise<void> {
      const slot = live.get(sessionId);
      if (slot !== undefined) {
        slot.record.stderrTail.push(`[deliver 未支持] ${text.slice(0, 80)}`);
        touch(slot.record);
      }
    },

    /** 停：真 kill，状态记 stopped（不是 done）。 */
    async stop(sessionId: string, reason: string): Promise<void> {
      const slot = live.get(sessionId);
      if (slot === undefined) return;
      slot.record.error = `stop: ${reason}`;
      if (slot.timer !== undefined) clearTimeout(slot.timer);
      // 先落状态再 kill：kill 会同步触发 close，close 里看到还 running 就会把它记成 failed
      finish(slot.record, 'stopped', slot.record.exitCode);
      try {
        slot.child?.kill('SIGTERM');
      } catch {
        /* 已经退了 */
      }
      live.delete(sessionId);
    },

    /** 按 ticket 查最近一次运行（页面/接口用）。 */
    snapshot(ticketId: string): DshRunRecord | undefined {
      return byTicket.get(ticketId);
    },
    /** 所有在跑的 runId。 */
    liveIds(): string[] {
      return [...live.keys()];
    },
  };
}
