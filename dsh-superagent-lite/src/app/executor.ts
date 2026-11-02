/**
 * app/executor.ts —— 执行器适配（K07，预算 90 行，实际见记账）。对应 R06 / R10。
 *
 * **spike 结论（决定这个文件长什么样）**：`dsh` 没有暴露可离线调用的 `sessionController` API
 * （`dsh headless --help` 只有 `--json` / `--session-id`；`~/.dsh/plugins` 里也没有宿主 SDK）。
 * 所以这里定义**端口** `SessionFactory`，真接线（spawn `dsh --profile … --json` 并解析 ndjson）
 * 留给 K14；本文件只保证「一 ticket 一会话一目录 + 槽位 + 人的优先」这三条语义可测。
 *
 * 槽位规则（R10）：
 *  - 工作会话受 `capacity` 限制；满了抛 `Later`（K05 会把它退回队列，不计失败次数）；
 *  - 人的消息可用 `humanExtra` 个额外槽，**不受工作槽位限制**（满槽时 5 秒内投达）；
 *  - 槽位在 `stop()` 才释放——turn 结束仍有后台工作时不放槽（R10 的后半句）。
 */
import { mkdir as fsMkdir } from 'node:fs/promises';
import type { Assignment, Ticket } from '../core/model.ts';
import type { Executor } from '../core/ports.ts';
import { Later } from './effects.ts';

export interface SessionHandle {
  sessionId: string;
  dir: string;
}

/** 宿主会话的最小接口。真实现 spawn `dsh`，测试注入桩。 */
export interface SessionFactory {
  start(o: { ticketId: string; agentPreset: string; dir: string; firstMessage: string }): Promise<SessionHandle>;
  deliver(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string, reason: string): Promise<void>;
}

export interface SlotPolicy {
  /** 工作会话并发上限。 */
  capacity: number;
  /** 给人预留的额外槽位数。 */
  humanExtra: number;
}

/** 只做计数与优先级，不碰宿主——所以 R10 可以单测。 */
export class SlotPool {
  private readonly work = new Set<string>();
  private readonly human = new Set<string>();
  readonly capacity: number;
  readonly humanExtra: number;

  constructor(policy: SlotPolicy = { capacity: 2, humanExtra: 1 }) {
    this.capacity = policy.capacity;
    this.humanExtra = policy.humanExtra;
  }

  /** 申请一个槽。人的消息走额外槽；工作占满返回 false（调用方转成 Later）。 */
  acquire(id: string, kind: 'work' | 'human'): boolean {
    if (this.work.has(id) || this.human.has(id)) return true;
    if (kind === 'human') {
      if (this.human.size >= this.humanExtra) return false;
      this.human.add(id);
      return true;
    }
    if (this.work.size >= this.capacity) return false;
    this.work.add(id);
    return true;
  }

  release(id: string): void {
    this.work.delete(id);
    this.human.delete(id);
  }

  get used(): number {
    return this.work.size;
  }
}

export interface ExecutorDeps {
  slots: SlotPool;
  factory: SessionFactory;
  /** 每个 assignment 的目录前缀；实际目录 = `${root}/${ticketId}-${assignmentId}`。 */
  workRoot: string;
  /** 用哪份 preset（K01 的 presets/worker.patch.yml）。 */
  agentPreset?: string;
  mkdirp?: (dir: string) => Promise<void>;
  nextId?: () => string;
}

export class SessionExecutor implements Executor {
  readonly slots: SlotPool;
  readonly factory: SessionFactory;
  readonly workRoot: string;
  readonly agentPreset: string;
  private readonly mkdirp: (dir: string) => Promise<void>;
  private readonly nextId: () => string;
  private readonly handles = new Map<string, SessionHandle>();
  private seq = 0;

  constructor(deps: ExecutorDeps) {
    this.slots = deps.slots;
    this.factory = deps.factory;
    this.workRoot = deps.workRoot;
    this.agentPreset = deps.agentPreset ?? 'superagent-worker';
    this.mkdirp = deps.mkdirp ?? (async (d: string) => {
      await fsMkdir(d, { recursive: true });
    });
    this.nextId = deps.nextId ?? (() => `a${++this.seq}`);
  }

  /**
   * 建目录 + 建会话 + 投首条消息（详设 §6 第 6 步）。
   * 槽位满 → 抛 `Later`（不是失败）：pass 下一轮再试，不消耗重试次数。
   */
  async start(t: Ticket, a: Assignment): Promise<Assignment> {
    if (!this.slots.acquire(a.id, 'work')) throw new Later('槽位已满');
    const dir = a.dir !== '' ? a.dir : `${this.workRoot}/${t.id}-${a.id}`;
    await this.mkdirp(dir);
    const handle = await this.factory.start({
      ticketId: t.id,
      agentPreset: this.agentPreset,
      dir,
      // 有正文就用正文：threadKey 只是线程标识（manual:m-…），当任务投给 worker 等于投了个文件名
      firstMessage: a.prompt ?? t.threadKey,
    });
    this.handles.set(a.id, handle);
    return { ...a, dir: handle.dir, sessionId: handle.sessionId, state: 'running' };
  }

  /** 人插话走额外槽，满槽也能投（R10 的"5 秒内投达"靠这条）。 */
  async deliver(t: Ticket, a: Assignment, text = ''): Promise<void> {
    const handle = this.handles.get(a.id);
    if (handle === undefined) throw new Later('会话还没起来');
    if (!this.slots.acquire(`human:${a.id}`, 'human')) throw new Later('人的额外槽位也满了');
    try {
      await this.factory.deliver(handle.sessionId, text);
    } finally {
      this.slots.release(`human:${a.id}`);
    }
  }

  async stop(t: Ticket, a: Assignment, reason: string): Promise<void> {
    const handle = this.handles.get(a.id);
    if (handle !== undefined) {
      await this.factory.stop(handle.sessionId, reason);
      this.handles.delete(a.id);
    }
    this.slots.release(a.id);
  }

  /** 面板/诊断用：当前在跑的会话数。 */
  get live(): number {
    return this.handles.size;
  }
}
