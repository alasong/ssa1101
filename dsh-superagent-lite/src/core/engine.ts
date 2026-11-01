/**
 * core/engine.ts —— **唯一写者**：intake / report / close 三条命令路径（详设 §6 的 2–9 步）。
 * 纪律：这个文件里除了 `await` 之外的宿主调用一律不许出现（R17）；拿事务靠 Repository，
 * 副作用只经 effects 入队（入队在事务内、执行在提交后，详设 §5.1）。
 * 预算 250 行。
 */
import { stageOf } from './stage.ts';
import type { StageInput } from './stage.ts';
import type { Assignment, Event, Mandate, Report, ReportKind, Stage, Ticket } from './model.ts';
import type { Candidate, NewEffect, Repository } from './ports.ts';

/** 判定结果的三种去向（对应对齐原型的 accept / stop / ignore）。 */
export type IntakeDisposition = 'new' | 'duplicate' | 'rejected' | 'delivered';

export interface IntakeOutcome {
  disposition: IntakeDisposition;
  ticket?: Ticket;
  /** 只在 rejected 时给：Gate 的拒收原因码。 */
  reason?: string;
}

export interface EngineDeps {
  repo: Repository;
  /** 只要 check 一个方法，K03 不关心它背后是不是 kaa。 */
  gate: { check(c: Candidate): { allowed: true; mandate: Mandate } | { allowed: false; reason: string } };
  now: () => number;
  /** 事件 id 生成器；测试里注入确定性实现。 */
  nextId: () => string;
}

/** 一次 report 之后的可见结果。 */
export interface ReportOutcome {
  stage: Stage;
  /** ready 时入队的 relay 键；其它情况 undefined。 */
  relayKey?: string;
}

/**
 * Engine 不持有连接、不自己开事务：所有写入都包在 repo.atomic 里，
 * 一个事务一个聚合。这样"唯一写者"这条纪律才可以被测试（同一 repo 只有一个入口）。
 */
export class Engine {
  readonly repo: Repository;
  readonly gate: EngineDeps['gate'];
  readonly now: () => number;
  readonly nextId: () => string;

  constructor(deps: EngineDeps) {
    this.repo = deps.repo;
    this.gate = deps.gate;
    this.now = deps.now;
    this.nextId = deps.nextId;
  }

  /**
   * 第 2–5 步：事件进来 → 幂等 → Gate 判定 → 建 ticket → 入队 launch。
   * 幂等键是 `event.externalId`（R01：同一 external_id 只记一次，重启不重放）。
   */
  intake(e: Event): IntakeOutcome {
    return this.repo.atomic(() => {
      if (this.repo.events.byExternalId(e.externalId) !== undefined) {
        return { disposition: 'duplicate' } as IntakeOutcome;
      }
      this.repo.events.put(e);
      return this.decide(e);
    });
  }

  /**
   * 处理一条**已经落库**的事件（K06 的 pass 循环用这个入口）：
   * sources 先 put（disposition='new'），pass 再调这里，处理完标 dispose。
   * 与 `intake` 的区别只有"事件是谁写进去的"，判定与建单逻辑完全共用。
   */
  handleEvent(e: Event): IntakeOutcome {
    return this.repo.atomic(() => {
      const outcome = this.decide(e);
      this.repo.events.dispose(e.id, outcome.disposition === 'rejected' ? 'rejected' : 'accepted');
      return outcome;
    });
  }

  /** Gate 判定 + 建单 + 入队 launch。调用方负责事务与事件归属。 */
  private decide(e: Event): IntakeOutcome {
    // R07 扇出：**人**在该 thread 上的消息不分发到评估，而是扇出给这个 thread 上所有开着的单
    // （每个订阅者一条 deliver，不新建单、不进 Gate）。判据是"这条是不是人说的"，
    // 不是"thread 上有没有单"——后者会把"每个事件建一张单"整条翻掉（T02/T03 会红）。
    const fromHuman = e.actor === 'human' || e.channel === 'local';
    if (fromHuman) {
      const subscribers = this.repo.tickets.open().filter((t) => t.threadKey === e.threadKey);
      if (subscribers.length > 0) {
        for (const t of subscribers) {
          this.repo.effects.enqueue(this.effect('deliver', `${t.id}:${e.id}`, { ticketId: t.id, eventId: e.id }));
        }
        return { disposition: 'delivered' } as IntakeOutcome;
      }
    }

    const decision = this.gate.check({ kind: 'event', event: e });
    if (!decision.allowed) {
      return { disposition: 'rejected', reason: decision.reason } as IntakeOutcome;
    }
    const ticket: Ticket = {
      id: this.nextId(),
      threadKey: e.threadKey,
      mandate: decision.mandate,
      createdAt: this.now(),
      state: 'open',
      stage: 'working/queued',
    };
    this.repo.effects.enqueue(this.effect('launch', ticket.id, { ticketId: ticket.id }));
    this.repo.tickets.put(ticket);
    return { disposition: 'new', ticket } as IntakeOutcome;
  }

  /**
   * 第 7–8 步：worker 回写 → 落报告 → 重算 stage → ready 时入队 relay。
   * stage 是**派生值**：不在这里手写判断，一律走 stageOf（R05 只有一处定义点）。
   */
  report(t: Ticket, r: Report): ReportOutcome {
    return this.repo.atomic(() => {
      this.repo.reports.append(r);

      const stage = stageOf(this.stageInput(t, r.kind));
      const next: Ticket = { ...t, stage };
      this.repo.tickets.put(next);

      if (r.kind === 'ready') {
        const key = `${t.id}:${r.id}`;
        this.repo.effects.enqueue(this.effect('relay', key, { ticketId: t.id, reportId: r.id }));
        return { stage, relayKey: key } as ReportOutcome;
      }
      return { stage } as ReportOutcome;
    });
  }

  /**
   * 第 9 步：人批准 → 结束 ticket → 入队 kaaDone + treeWrite（R04：mandate 此时必须可读回）。
   */
  close(t: Ticket): { ticket: Ticket; effectKeys: string[] } {
    return this.repo.atomic(() => {
      const ended: Ticket = { ...t, state: 'ended', stage: stageOf(this.stageInput(t, 'dropped')) };
      this.repo.tickets.put(ended);

      const kaaKey = `${t.mandate.scope}:${t.id}`;
      const treeKey = `${t.id}:${t.createdAt}`;
      this.repo.effects.enqueue(this.effect('kaaDone', kaaKey, { ticketId: t.id, mandate: t.mandate }));
      this.repo.effects.enqueue(this.effect('treeWrite', treeKey, { ticketId: t.id }));
      return { ticket: ended, effectKeys: [kaaKey, treeKey] };
    });
  }

  /** 只读：当前该显示的 stage（面板与 pass 都调这一个，别各算一遍）。 */
  stageOfTicket(t: Ticket): Stage {
    const latest = this.repo.reports.latest(t.id);
    return stageOf(this.stageInput(t, latest?.kind));
  }

  /**
   * 把"已落库的事实"折成 stageOf 的输入。
   * 注：v1 把四个派生标记挂在 ticket 上（assignment / openQuestions / lastDeliveryFailed /
   * humanRepliedSinceReport），而不是各建一张表——详见 K03 result 里的口径说明。
   */
  private stageInput(t: Ticket, latestReport?: ReportKind): StageInput {
    return {
      lastDeliveryFailed: t.lastDeliveryFailed === true,
      openQuestions: t.openQuestions ?? 0,
      latestReport,
      humanRepliedSinceReport: t.humanRepliedSinceReport === true,
      assignment: t.assignment?.state,
    };
  }

  private effect(kind: NewEffect['kind'], key: string, payload: unknown): NewEffect {
    return { kind, key, payload: JSON.stringify(payload), dueAt: this.now() };
  }
}

/** 一张被跟踪的 PR（R13）。`closed` 一旦为真就不会变回假。 */
export interface FollowedPr {
  id: string;
  closed: boolean;
  /** 关闭时的结论/链接；outcome 取"最后一次关闭"的那条。 */
  outcome?: string;
}

/**
 * R13：ticket 在它开的 PR **全关**时才结束，outcome 取最后一次关闭。
 * 纯函数，放在写者里——结束是 ticket 的状态跃迁，不该由面板或通道判。
 */
export function prOutcome(prs: readonly FollowedPr[]): { ended: boolean; outcome?: string } {
  if (prs.length === 0) return { ended: false };
  if (prs.some((p) => !p.closed)) return { ended: false };
  const last = prs[prs.length - 1];
  return { ended: true, outcome: last.outcome };
}

/** 建 assignment 的纯工厂（K07 用；放这里是因为它属于"写者"的聚合内构造）。 */
export function newAssignment(t: Ticket, id: string, dir: string, sessionId: string): Assignment {
  return { id, ticketId: t.id, state: 'pending', dir, sessionId };
}
