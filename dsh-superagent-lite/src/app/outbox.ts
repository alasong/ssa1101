/**
 * app/outbox.ts —— 对外通道的出站队列（K10，预算 70 行）。对应 R11。
 *
 * 只做两件事，别加第三件：
 *  1. **保序**：同一通道的投递串成一条 promise 链，后一条等前一条结束——
 *     所以"同会话三条按序到达"是结构保证，不是靠数组排序碰巧。
 *  2. **幂等**：按 `message.id` 去重，同一个 id 第二次进来直接判 duplicate、**不投递**。
 *
 * **重试不在这里**：`reply` kind 的 5s→300s 退避写在详设 §5.1、由 K05 的 effects 队列执行。
 * 两处各写一套退避，迟早出现两种节奏；三连败"报问题"由 K05 的 fail 分支负责。
 */
import type { OutboundMessage } from '../core/model.ts';

export interface Channel {
  readonly name: string;
  send(m: OutboundMessage): void | Promise<void>;
}

export type OutboxStatus = 'pending' | 'sent' | 'duplicate' | 'dropped';

export interface SendResult {
  id: string;
  status: OutboxStatus;
  reason?: string;
}

export class Outbox {
  private readonly channels = new Map<string, Channel>();
  private readonly states = new Map<string, OutboxStatus>();
  /** 每通道一条 promise 链：保证 FIFO，同时不阻塞别的通道。 */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(channels: readonly Channel[] = []) {
    for (const c of channels) this.channels.set(c.name, c);
  }

  register(channel: Channel): void {
    this.channels.set(channel.name, channel);
  }

  status(id: string): OutboxStatus | undefined {
    return this.states.get(id);
  }

  /**
   * 投递一条。同 id 第二次 → `duplicate` 且**不调用通道**（这就是 R11 的幂等断言）。
   * 通道不存在 → `dropped`；通道抛错 → `dropped` 并带回 reason（重试交给 effects 的 reply）。
   */
  send(m: OutboundMessage): Promise<SendResult> {
    const seen = this.states.get(m.id);
    if (seen === 'sent' || seen === 'pending' || seen === 'duplicate') {
      return Promise.resolve({ id: m.id, status: 'duplicate' });
    }
    const channel = this.channels.get(m.channel);
    if (channel === undefined) {
      this.states.set(m.id, 'dropped');
      return Promise.resolve({ id: m.id, status: 'dropped', reason: `没有通道 ${m.channel}` });
    }

    this.states.set(m.id, 'pending');
    const prev = this.chains.get(m.channel) ?? Promise.resolve();
    // reason 是"这一条为什么没投出去"，只属于本条；不跨消息共享，
    // 否则一次失败之后每条成功投递都会带 reason，上层按 reason!==undefined 判失败就会误判。
    let reason: string | undefined;
    const next = prev.then(async () => {
      try {
        await channel.send(m);
        this.states.set(m.id, 'sent');
      } catch (e) {
        this.states.set(m.id, 'dropped');
        reason = String((e as Error)?.message ?? e);
        this.lastError = reason;
        // 不阻断后续消息：吃掉错误，交给 effects 的 reply 重试
      }
    });
    this.chains.set(m.channel, next);
    return next.then(() => ({ id: m.id, status: this.states.get(m.id) ?? 'dropped', reason }));
  }

  /**
   * 最近一次通道错误——**只给面板/日志看，不进 SendResult**。
   * 它带的是"最近一次"而不是"这一条的"，所以不能用它判某条成败。
   */
  lastError?: string;

  /** 等所有通道的链排空（测试与优雅退出用）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
