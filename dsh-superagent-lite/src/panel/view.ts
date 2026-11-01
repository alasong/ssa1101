/**
 * panel/view.ts —— 面板数据视图（K12，预算 60 行，对应 R15 / T15 之外的 S33）。
 * 只移植**数据模型**，不移植组件；不新建面板，复用 plugin-console 挂 person/* 视图。
 *
 * 两个渲染口要分开，别混：
 *  - `renderBoard()` 给人看整体状态用，7 个 stage 一个不少（判据要能数出 7 个）；
 *  - `renderPanel()` 是"人现在要处理什么"，**只列 person/\*，空态返回空串**——
 *    R15 的"空态不占位"就靠这个空串，而不是靠 CSS 高度。
 */
import { PERSON_STAGES, STAGES } from '../core/model.ts';
import type { Stage, Ticket } from '../core/model.ts';

export interface StageGroup {
  stage: Stage;
  tickets: Ticket[];
}

/** 按 STAGES 顺序分组；每组都存在（哪怕是空数组），调用方不用自己补洞。 */
export function groupByStage(tickets: readonly Ticket[]): StageGroup[] {
  return STAGES.map((stage) => ({
    stage,
    tickets: tickets.filter((t) => (t.stage ?? 'working/queued') === stage),
  }));
}

/** 整体看板：7 个 stage 全画，空组也画（显示"0"）。 */
export function renderBoard(tickets: readonly Ticket[]): string {
  return groupByStage(tickets)
    .map((g) => `${g.stage}: ${g.tickets.length}`)
    .join('\n');
}

/** 人视角：只列 person/* 且有货的组；一条都没有 → 空串（零高度，不是占位块）。 */
export function renderPanel(tickets: readonly Ticket[]): string {
  const rows = groupByStage(tickets)
    .filter((g) => PERSON_STAGES.includes(g.stage) && g.tickets.length > 0)
    .map((g) => `${g.stage}\n` + g.tickets.map((t) => `  - ${t.id} ${t.threadKey}`).join('\n'));
  return rows.join('\n');
}

/** 空态判定单独导出：视图层的"零高度"判断别散落在组件里。 */
export function isPanelEmpty(tickets: readonly Ticket[]): boolean {
  return renderPanel(tickets) === '';
}

/** 面板要显示的行数（含人视角与总览两种口径，便于面板自检）。 */
export function panelCounts(tickets: readonly Ticket[]): { person: number; total: number } {
  const groups = groupByStage(tickets);
  return {
    person: groups.filter((g) => PERSON_STAGES.includes(g.stage)).reduce((n, g) => n + g.tickets.length, 0),
    total: tickets.length,
  };
}
