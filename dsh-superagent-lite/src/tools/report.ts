/**
 * tools/report.ts —— worker 唯一的回写口（K11，预算 50 行）。对应 R05 / R09。
 *
 * worker 干完/卡住/等人时**只能**调这个工具，不能让 worker 直接写库：
 * 写者是 Engine（K03），这条工具只是把它包成"可被 agent 调用"的形状。
 * stage 的判定一律由 engine.report → stageOf 决定，这里**不做任何状态判断**。
 */
import type { ReportKind, Stage } from '../core/model.ts';
import type { Engine } from '../core/engine.ts';

export interface ReportHandle {
  /** 工具名：worker preset 里注册成 `report`。 */
  readonly name: 'report';
  /** 三态（ready / waiting / blocked）为主，progress / failed / dropped 也放行。 */
  call(kind: ReportKind, note?: string): { stage: Stage; relayKey?: string; reportId: string };
}

export interface ReportToolDeps {
  engine: Engine;
  ticketId: string;
  assignmentId: string;
  /** 报告 id 生成器；默认 `r<n>`。 */
  nextId?: () => string;
  /** 注入时钟，测试要确定性。 */
  now?: () => number;
}

/** 六种报告都接受，但只有 ready 会触发 relay（人该看了）。 */
export const REPORT_KINDS: readonly ReportKind[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'];

export function createReportTool(deps: ReportToolDeps): ReportHandle {
  let seq = 0;
  const nextId = deps.nextId ?? (() => `r${++seq}`);
  const now = deps.now ?? (() => Date.now());

  return {
    name: 'report',
    call(kind, note) {
      if (!REPORT_KINDS.includes(kind)) {
        throw new Error(`report: 未知报告类型 ${kind}`);
      }
      const reportId = nextId();
      const ticket = deps.engine.repo.tickets.get(deps.ticketId);
      if (ticket === undefined) throw new Error(`report: ticket ${deps.ticketId} 不存在`);
      const outcome = deps.engine.report(ticket, {
        id: reportId,
        ticketId: deps.ticketId,
        assignmentId: deps.assignmentId,
        kind,
        at: now(),
      });
      return { ...outcome, reportId, note };
    },
  };
}
