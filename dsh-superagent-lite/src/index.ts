/**
 * src/index.ts —— 插件入口（K06）。只把组合根暴露出去，不在这里做业务。
 * cordis 侧的挂载（profile 里那一行）由 K01 的 patch 提供，接线在 K14 验。
 */
export { startRuntime } from './app/runtime.ts';
export type { Runtime, RuntimeDeps, TickResult } from './app/runtime.ts';
export { Engine } from './core/engine.ts';
export { stageOf } from './core/stage.ts';

/** Cordis 插件名：profile 里 `insert: [{id: superagent-lite, name: 'dsh-superagent-lite'}]` 挂的就是它。 */
export const name = 'superagent-lite';

/**
 * 挂载入口。**目前是空实现**：真正的接线（按宿主配置建库、把 SessionExecutor 的
 * factory 换成 spawn dsh、把 Gate 换成 kaa CLI）还没做，先保证"能被加载"。
 * 这一步以前是缺的——profile 里 insert 了但模块没有插件形状，dsh 报 failed to import。
 */
export function apply(ctx: { logger?: { info?: (m: string) => void } } = {}): void {
  ctx.logger?.info?.('superagent-lite mounted（runtime 尚未接线）');
  // 可 grep 的挂载标记：只报「没报错」不算接入，得有执行级证据。
  process.stderr.write('[superagent-lite] mounted\n');
}
