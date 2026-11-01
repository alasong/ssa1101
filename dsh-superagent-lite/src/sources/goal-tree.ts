/**
 * sources/goal-tree.ts —— 轮询 goal-tree，把 ready 叶子翻成 P1 Event（K09 的另一半，预算 80 行）。
 *
 * 两条纪律写在代码里，不是写在注释里：
 *  1. **幂等键 `node:<id>:<revision>`**：同一个节点在同一个 revision 上轮询两次，
 *     产出的是**同一个** external_id，于是 Engine 的 `byExternalId` 去重（R01）生效，
 *     同一个 revision 只会有 1 行 event。翻译层不去重，去重只有一处（Engine）。
 *  2. **有界**：间隔与每轮上限来自配置（`intervalMs` / `maxNodes`），不做无界遍历；
 *     没到间隔就返回空数组，而不是"能跑多快跑多快"。
 *
 * 只读 `GET /dsh-goal-tree/tree`（ARCHITECTURE §5.1：不复用它的 HTTP 写入口，写者已定为 kaa）。
 */
import type { Event } from '../core/model.ts';

export interface GoalNode {
  id: string;
  title: string;
  status: 'pending' | 'done' | 'failed' | 'skipped' | 'dropped';
  parentId?: string | null;
  dependsOn?: readonly string[];
}

export interface TreeResponse {
  /** 树级 revision：external_id 的第二段，revision 变了才算"新的一轮"。 */
  revision: number;
  nodes: readonly GoalNode[];
}

export type FetchTree = () => Promise<TreeResponse>;

export interface TreeSourceOptions {
  /** 轮询间隔下限（写死在这里，不让调用方"顺手快一点"）。 */
  intervalMs?: number;
  /** 每轮最多翻多少个叶子。 */
  maxNodes?: number;
  source?: string;
  channel?: string;
}

export const DEFAULT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_NODES = 20;

/** ready 叶子 = 还没做、没有孩子、依赖都已 done。纯函数，可单测。 */
export function readyLeaves(tree: TreeResponse, maxNodes = DEFAULT_MAX_NODES): GoalNode[] {
  const parents = new Set(tree.nodes.map((n) => n.parentId).filter((x): x is string => !!x));
  const done = new Set(tree.nodes.filter((n) => n.status === 'done').map((n) => n.id));
  const out: GoalNode[] = [];
  for (const n of tree.nodes) {
    if (n.status !== 'pending') continue;
    if (parents.has(n.id)) continue; // 有孩子 → 不是叶子
    if ((n.dependsOn ?? []).some((d) => !done.has(d))) continue; // 依赖没完成
    out.push(n);
    if (out.length >= maxNodes) break;
  }
  return out;
}

/** 纯翻译：ready 叶子 → Event。同一个 (id, revision) 永远得到同一个 external_id。 */
export function toEvents(tree: TreeResponse, now: number, opts: TreeSourceOptions = {}): Event[] {
  return readyLeaves(tree, opts.maxNodes ?? DEFAULT_MAX_NODES).map((n) => ({
    id: `evt-node:${n.id}:${tree.revision}`,
    source: opts.source ?? 'goal-tree',
    externalId: `node:${n.id}:${tree.revision}`,
    at: now,
    actor: 'system',
    text: n.title,
    threadKey: `node:${n.id}`,
    channel: opts.channel ?? 'goal-tree',
  }));
}

export class GoalTreeSource {
  private readonly fetchTree: FetchTree;
  private readonly intervalMs: number;
  private readonly opts: TreeSourceOptions;
  private lastPollAt = Number.NEGATIVE_INFINITY;

  constructor(fetchTree: FetchTree, opts: TreeSourceOptions = {}) {
    this.fetchTree = fetchTree;
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  /** 没到间隔直接返回空（不是抛错、不是等）；到了就 fetch 一次再翻译。 */
  async poll(now: number): Promise<Event[]> {
    if (now - this.lastPollAt < this.intervalMs) return [];
    this.lastPollAt = now;
    const tree = await this.fetchTree();
    return toEvents(tree, now, this.opts);
  }

  get interval(): number {
    return this.intervalMs;
  }
}
