/**
 * channel/local.ts —— v1 唯一的通道（K10，预算 50 行）。对应 R11 的落点 + D5 的"只做本地"。
 *
 * 设计约束写在这里，是因为它是**结构**约束不是习惯：
 *  - 回写目标树**只通过注入的 `write`**，K06 会把它接到 `kaa done`（P7）上。
 *    本文件里没有任何 HTTP 客户端，所以"直接 POST goal-tree 的 /node-action"（S1 禁止的那条）
 *    在结构上做不到，而不是靠注释约定。
 *  - 输出到控制台用注入的 `log`，方便测试捕获；默认写 stdout。
 */
import type { OutboundMessage } from '../core/model.ts';
import type { Channel } from '../app/outbox.ts';

export interface LocalChannelDeps {
  /** 真正的回写动作（K06 接 kaa CLI）；返回 Promise 就会被 await。 */
  write?: (m: OutboundMessage) => void | Promise<void>;
  /** 控制台输出；默认 `console.log`。 */
  log?: (line: string) => void;
  name?: string;
}

/** 一行人类可读的落地格式（只有日志用；判据不解析它）。 */
export function formatLine(m: OutboundMessage): string {
  return `[${m.channel}] ${m.kind} ${m.id}: ${m.text}`;
}

export function createLocalChannel(deps: LocalChannelDeps = {}): Channel {
  const log = deps.log ?? ((line: string) => console.log(line));
  const name = deps.name ?? 'local';
  return {
    name,
    async send(m: OutboundMessage): Promise<void> {
      log(formatLine(m));
      if (deps.write !== undefined) await deps.write(m);
    },
  };
}

/** 把消息里的目标树信息翻成 kaa 的入参（K06 用它接 kaaDone）。纯函数，好测。 */
export interface TreeWriteTarget {
  slug: string;
  node: string;
}

export function treeTargetOf(m: OutboundMessage): TreeWriteTarget | undefined {
  // 约定：kind='notify' 且 text 形如 `<slug>#<node>` 的消息才是回写请求
  if (m.kind !== 'notify') return undefined;
  const [slug, node] = m.text.split('#');
  if (!slug || !node) return undefined;
  return { slug, node };
}
