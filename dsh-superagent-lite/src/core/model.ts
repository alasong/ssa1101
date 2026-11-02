/**
 * core/model.ts —— 纯类型 + 常量。无 I/O、无宿主 import（R17 / T14 守这条）。
 * 名词只在这里定义一次，别处只引用；预算 80 行（详设 §1.3）。
 */

/** 7 个 stage，自上而下第一个命中（详设 §4.1）；顺序即优先级，别重排。 */
export type Stage =
  | 'person/delivery'
  | 'person/answer'
  | 'person/review'
  | 'person/blocked'
  | 'working/queued'
  | 'idle'
  | 'working';

/** 顺序 = §4.1 行号；测试按这个顺序逐行断言。 */
export const STAGES: readonly Stage[] = [
  'person/delivery', 'person/answer', 'person/review', 'person/blocked',
  'working/queued', 'idle', 'working',
] as const;

/** 需要人处理的 stage（面板只显示这些，R15 的空态不占位靠它）。 */
export const PERSON_STAGES: readonly Stage[] = [
  'person/delivery', 'person/answer', 'person/review', 'person/blocked',
] as const;

export function isPersonStage(s: Stage): boolean {
  return PERSON_STAGES.includes(s);
}
/** 报告六态（P5 载荷）。`dropped` = worker 主动放弃。 */
export type ReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';

/** 失败类报告：会把人拉进 person/blocked（§4.1 第 4 行）。 */
export const FAILING_REPORTS: readonly ReportKind[] = ['blocked', 'failed'] as const;

/** assignment 状态；`interrupted` 由崩溃重启标（R09）。 */
export type AssignmentState = 'pending' | 'running' | 'done' | 'interrupted';

/** 授权留档（R04）：策略版本 / 范围 / 强度 / 依据码；恢复前复核。 */
export interface Mandate {
  policyVersion: string;          // 与 Gate 判定时不一致即失效（R23）
  scope: string;                  // 如 'repo:write'
  strength: 'auto' | 'confirm';   // 只有 auto 允许 inferred 通过（R03）
  basis: string[];                // Gate 的判定依据码
}
/** 外部事件（P1 载荷，落 event 表）。 */
export interface Event {
  id: string;
  source: string;
  externalId: string;   // 幂等键：node:<id>:<revision> 或渠道消息 id（R01）
  at: number;
  actor: string;
  text: string;
  threadKey: string;
  channel: string;
}
/** 工单。stage 是派生值，判定见 stage.ts。 */
export interface Ticket {
  id: string;
  threadKey: string;
  mandate: Mandate;
  createdAt: number;
  state: 'open' | 'ended';   // §4.3
  stage?: Stage;             // 派生值，由 engine 用 stageOf 算出后写回
  // 下面四个是 stageOf 的输入快照（v1 直接挂 ticket，见 K03 result 的口径说明）
  /** 当前执行（对象）；stage 判定只取它的 state 字段（见 stage.ts 的 StageInput）。 */
  assignment?: Assignment;
  openQuestions?: number;
  lastDeliveryFailed?: boolean;
  humanRepliedSinceReport?: boolean;
}
/** 一次执行（P4 载荷）；一个 ticket 可有多个 assignment。 */
export interface Assignment {
  id: string;
  ticketId: string;
  state: AssignmentState;
  dir: string;         // 每个 assignment 独占目录（R06 / T06）
  sessionId: string;
  /** 投给 worker 的首条消息正文；缺省时回落到 ticket.threadKey（历史行为）。 */
  prompt?: string;
}
/** 一次报告（P5 载荷）。 */
export interface Report {
  id: string;
  ticketId: string;
  assignmentId: string;
  kind: ReportKind;
  at: number;
}
/** 出站消息（P6 载荷）；id 是幂等键（R11）。 */
export interface OutboundMessage {
  id: string;
  channel: string;
  text: string;
  kind: 'reply' | 'notify' | 'question';
}
/** 持久副作用种别，逐字对齐详设 §5.1 的六种；`(kind, key)` 唯一（R08）。 */
export type EffectKind =
  | 'launch' | 'deliver' | 'relay' | 'reply' | 'kaaDone' | 'treeWrite';

export interface EffectRow {
  id: string;
  kind: EffectKind;
  key: string;          // 幂等键
  payload: string;
  attempts: number;
  nextAt: number;
  state: 'pending' | 'running' | 'done' | 'failed';
}
