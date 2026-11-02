/**
 * core/ports.ts —— 四个端口接口（详设 §2.1）。只有接口、没有实现（预算 40 行）。
 * 纪律：P1/P3/P5 的载荷都是可序列化纯数据，不含闭包、不含宿主对象——它们要落库、要重放。
 */
import type { Assignment, EffectKind, Event, Mandate, OutboundMessage, Report, Ticket } from './model.ts';

/** P4：编排层 → 宿主。只排队，结果经回调回来（回调在 K07 接）。 */
export interface Executor {
  start(t: Ticket, a: Assignment): void;
  /**
   * `text` 可选：不传表示"投递会话当前该投的输入"（P4 的默认载荷）；
   * 传了就是人插话的正文——执行器实现必须让它走**额外槽位**（R10），
   * 否则满槽时人的消息会排在 worker 后面，"5 秒内投达"就守不住。
   */
  deliver(t: Ticket, a: Assignment, text?: string): void;
  stop(t: Ticket, a: Assignment, reason: string): void;
}

/** P2/P3：kaa 规则 + auto-review。只判当次调用，不留档（mandate 快照由编排层自建）。 */
export interface Gate {
  check(c: Candidate): { allowed: true; mandate: Mandate } | { allowed: false; reason: string };
}

/** P6：出站。幂等按 m.id。 */
export interface Outbox {
  send(m: OutboundMessage): void;
  status(id: string): 'pending' | 'sent' | 'dropped' | undefined;
}

/** Gate 的输入：一条候选（目前只有"事件"一种来源）。 */
export interface Candidate {
  kind: 'event';
  event: Event;
}

/** 待入队的 effect（id / attempts / state 由存储层生成）。 */
export interface NewEffect {
  kind: EffectKind;
  key: string;
  payload: string;
  dueAt: number;
}

/**
 * 仓储：Engine 是唯一写者，它只通过这个接口拿事务与表。
 * `atomic` 是同步的——一个事务一个聚合，别在里面 await。
 */
export interface Repository {
  atomic<T>(f: () => T): T;
  events: {
    /** 幂等写：同一 external_id 重复 put 不新增行。 */
    put(e: Event): void;
    byExternalId(id: string): Event | undefined;
    /** 该 thread 最近一条原文（页面显示「在批什么」用）。 */
    textByThread(threadKey: string): string | undefined;
    /** 还没被 pass 处理过的事件（disposition='new'），有界读取。 */
    pending(limit: number): Event[];
    /** 标记处理结果，避免同一行被反复消费。 */
    dispose(id: string, disposition: 'accepted' | 'rejected'): void;
  };
  tickets: {
    put(t: Ticket): void;
    get(id: string): Ticket | undefined;
    open(): Ticket[];
    /** 含已结束。发号要用它：只看 open() 会在重启后撞上已结束的旧 id。 */
    all(): Ticket[];
  };
  reports: {
    append(r: Report): void;
    latest(ticketId: string): Report | undefined;
  };
  effects: {
    enqueue(e: NewEffect): void;
    /** 取出到期行并**同时**把它们标成 running（先 claim 再执行，K05 依赖这点）。 */
    claimDue(now: number): EffectRow[];
    /** 只数不领取（页面轮询用，不能改 state）。 */
    dueCount(now: number): number;
    /** 这条 (kind,key) 还没有未了结的行：页面用它区分「排队中」与「真中断」。 */
    hasPending(kind: EffectKind, key: string): boolean;
    /** 成功才 settle。 */
    settle(id: string): void;
    /** 可重试：写回已失败次数 + 下次到期时间 + 错误。 */
    retry(id: string, attempts: number, nextAt: number, error: string): void;
    /** 终态失败（次数用尽或不可重试）。 */
    fail(id: string, error: string): void;
    /** 崩溃恢复：把上次进程留下的 running 全部退回 pending，返回条数。 */
    recoverRunning(): number;
  };
}

import type { EffectRow } from './model.ts';
