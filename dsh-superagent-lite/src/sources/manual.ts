/**
 * sources/manual.ts —— 人直接下任务（K09 的一半，预算 40 行）。
 * 唯一职责：把"人敲的一句话"变成一个 P1 Event。**不判定、不建单**——
 * 判定在 Gate（K08 的调用面）、建单在 Engine（K03）。这样人下的任务和外部事件
 * 走完全同一条链路，R01 的幂等键也只需要一个规则。
 */
import type { Event } from '../core/model.ts';

export interface ManualInput {
  /** 幂等键的后半段；不传则调用方必须给（测试里要确定性）。 */
  id: string;
  text: string;
  threadKey?: string;
  actor?: string;
  /** 默认 'manual'；面板/ CLI 都能覆盖。 */
  channel?: string;
}

/** 幂等键前缀：`manual:<id>`。同 id 再投一次不会产生第二条 event（R01）。 */
export const MANUAL_PREFIX = 'manual:';

export function manualEvent(input: ManualInput, now: number): Event {
  if (input.id.trim() === '') throw new Error('manualEvent: id 不能为空（它是幂等键）');
  return {
    id: `evt-${MANUAL_PREFIX}${input.id}`,
    source: 'manual',
    externalId: `${MANUAL_PREFIX}${input.id}`,
    at: now,
    actor: input.actor ?? 'human',
    text: input.text,
    threadKey: input.threadKey ?? `manual:${input.id}`,
    channel: input.channel ?? 'local',
  };
}

/** 进程内待投队列：面板"下任务"按钮把输入塞进来，pass 循环每轮取空。 */
export class ManualSource {
  private readonly queue: ManualInput[] = [];

  push(input: ManualInput): void {
    this.queue.push(input);
  }

  /** 取走当前队列并翻译成 Event（取空，重复调用不会重放）。 */
  poll(now: number): Event[] {
    const batch = this.queue.splice(0, this.queue.length);
    return batch.map((i) => manualEvent(i, now));
  }

  get size(): number {
    return this.queue.length;
  }
}
