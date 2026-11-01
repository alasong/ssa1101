/**
 * core/stage.ts —— 一条工单此刻该谁看。7 行判定，自上而下第一个命中。
 * 无 I/O、无宿主 import、不读时钟：所有输入都从参数进来，所以逐行可测（R05 / T05）。
 *
 * 真值表见详设 §4.1；本文件的行序 = 表序，改顺序就是改语义。
 * 预算 70 行（详设 §1.3）。
 */
import type { AssignmentState, ReportKind, Stage } from './model.ts';

/** 判定输入。字段全部来自已落库的事实，不现算。 */
export interface StageInput {
  /** 上一次投递失败（outbox 的终态）。 */
  lastDeliveryFailed: boolean;
  /** 未答问题数。 */
  openQuestions: number;
  /** 最新一份报告的类型；没有报告时 undefined。 */
  latestReport?: ReportKind;
  /** 最新报告之后，人有没有回话（自动输入不算，见 §4.1 下方注释）。 */
  humanRepliedSinceReport: boolean;
  /** 当前 assignment 状态；没有 assignment 时 undefined。 */
  assignment?: AssignmentState;
}

/**
 * 判定入口。
 *
 * 离开 person/* 只有两个原因：收到新的真人消息，或收到新报告；
 * 自动输入（CI、bot）不能解除（同原型 docs/003-execution.md:19）——
 * 这条落在 `humanRepliedSinceReport` 这个入参上：调用方只在该条件为真时置 true。
 */
export function stageOf(i: StageInput): Stage {
  // 1 投递失败 — 连消息都送不到人，先修通道
  if (i.lastDeliveryFailed) return 'person/delivery';
  // 2 有未答问题 — 卡在等人回答
  if (i.openQuestions > 0) return 'person/answer';
  // 3 最新报告 ready — 等人审阅
  if (i.latestReport === 'ready') return 'person/review';
  // 4 报告 blocked/failed 且此后无人回话 — 受阻/失败
  if ((i.latestReport === 'blocked' || i.latestReport === 'failed') && !i.humanRepliedSinceReport) {
    return 'person/blocked';
  }
  // 5 无 assignment 或 pending — 排队
  if (i.assignment === undefined || i.assignment === 'pending') return 'working/queued';
  // 6 最新报告 waiting，或 assignment 已结束 — 等触发
  if (i.latestReport === 'waiting' || i.assignment === 'done') return 'idle';
  // 7 其余 — 执行中（running / interrupted）
  return 'working';
}
