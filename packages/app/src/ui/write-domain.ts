import { errorText } from '@kojo/plugin-api';
import type { ProjectErrorAction, ProjectErrorBar } from './project-error-notice';

/**
 * 项目「可写范围」的**宿主半边事实**收口（WRITE-ADMIT-SPLIT 出路①，2026-10-21）。
 *
 * 同一个问题——"这个文件夹眼下能不能写入"——原本有两份答案、且可以不一致：
 * - TS 侧批准记录：内核全局存储里作者批过的那份（早于准入门就批过的目录也在册）；
 * - 宿主准入门：Rust 侧只有**经系统目录对话框 / OS 拖放由宿主亲自交付过**的目录才在册
 *   （2026-10 安全审阅批加的，修的是"接受任意 JS 路径"这个洞）。
 *
 * 两份不同步时就是屏幕上那一格：开项目时登记被准入门拒（写域 fail-closed 退回"仅应用数据
 * 目录可写"），而 UI 只看着 TS 那份批准记录照常解锁编辑、保存按钮照常可点，点下去只回一句
 * 域外拒绝。**准入门是对的**（不许放宽写域），错在"UI 的答复没吃宿主这一份事实"。
 *
 * 本模块因此把两件事收在一处：
 * 1. `isProjectWritableOf` —— 可写态的**唯一判定**：TS 批准记录 ∧ 宿主交付事实，宿主没给就
 *    是 false（状态收敛，UI 不再表演"能编辑"）；
 * 2. `redeliverProjectWriteDomain` —— 被拒后的**唯一出路**：再走一次原生选目录框，作者选回
 *    这个项目文件夹（对话框即授权，铁律 6 的既有形态），随后重新登记一次。前端**不**自己
 *    比对目录（不复制那份判定，免得再长出第三份答案），选了别的目录就照旧被拒、错误条仍在。
 *
 * 零 React、零桥 import：IPC 与对话框全部由调用方注入 ⇒ 单测拿假 invoke 就能钉住全部分支。
 */

/**
 * 宿主是否真的把项目根交付进了可写范围。
 * `not-hosted` = 浏览器开发壳，压根没有这道闸 ⇒ 不参与判定（照旧只看 TS 批准记录）。
 */
export type HostWriteDomainGrant = 'granted' | 'refused' | 'not-hosted';

/** 一次登记 / 重新交付的结果（`registerProjectWriteDomain` 不会返回 `cancelled`） */
export type WriteDomainAttempt = 'granted' | 'refused' | 'cancelled';

export interface WriteDomainOutcome {
  readonly kind: WriteDomainAttempt;
  /** 被拒原因原文（宿主侧那句话，逐字接进错误条尾巴；成功 / 取消为 null） */
  readonly reason: string | null;
}

/** 会话内记住的宿主写域事实：判定、错误文案与出路动作都只从这里取 */
export interface WriteDomainFact {
  readonly dir: string | null;
  readonly grant: HostWriteDomainGrant;
  readonly reason: string | null;
}

export const initialWriteDomainFact: WriteDomainFact = { dir: null, grant: 'not-hosted', reason: null };

/**
 * 出路动作与原生选目录框的标题共用同一个名字：作者按下按钮后，对话框顶上写的就是按钮说的那件事。
 * （守卫用例按"文件 + 逐字片段 + 处数"钉这句话，本文件里只许出现一次。）
 */
export const writeDomainRedeliverLabel = '重新选择这个文件夹';

/** 被拒时给作者的那句话（机制名与宿主路径 API 名都不上屏；原因原文照旧逐字带在冒号后面） */
export function writeDomainRefusedMessage(fact: WriteDomainFact): string {
  return `这个项目文件夹眼下不能写入，只有编辑器自己的文件夹能写（备份、作者工作区、未保存快照都在那里）：${fact.reason ?? '宿主没有说明原因'}`;
}

/** 错误条上那颗出路按钮（形状照 NotificationCenter 的 action：label + run；title 说清点下去会发生什么） */
export function writeDomainFixAction(run: () => void): ProjectErrorAction {
  return {
    label: writeDomainRedeliverLabel,
    title: '在弹出的系统选目录框里选回这个项目文件夹，编辑器才会允许写入',
    run,
  };
}

/**
 * 「这个项目眼下能不能直接编辑」的唯一判定 = TS 批准记录 **且** 宿主真的把写域交了进来。
 * 宿主没给出去时批准记录再多也写不进去 ⇒ 一律 false；这条就是"状态收敛"那半步。
 */
export function isProjectWritableOf(input: {
  readonly hasApprovalRecord: boolean;
  readonly approvalMismatch: boolean;
  readonly hostGrant: HostWriteDomainGrant;
}): boolean {
  if (input.hostGrant === 'refused') return false;
  return input.hasApprovalRecord && !input.approvalMismatch;
}

export interface RegisterWriteDomainDeps {
  readonly dir: string;
  /** `invoke('register_write_domain', { root })`：绑在调用方，这里不 import 桥 */
  readonly register: (root: string) => Promise<void>;
}

/** 登记一次项目根（宿主准入门在另一侧；拒了就是 reject） */
export async function registerProjectWriteDomain(deps: RegisterWriteDomainDeps): Promise<WriteDomainOutcome> {
  try {
    await deps.register(deps.dir);
    return { kind: 'granted', reason: null };
  } catch (e: unknown) {
    return { kind: 'refused', reason: errorText(e) };
  }
}

/** 一次写域交付的完整结论：会话事实 + 该显示的可写态 + 要不要重弹确认 + 错误条（null = 没有错误） */
export interface WriteDomainAdmission {
  readonly fact: WriteDomainFact;
  readonly writable: boolean;
  /** TS 侧没有批准记录（或与新提议不一致）⇒ 调用方该弹可写范围确认 */
  readonly needsApproval: boolean;
  readonly error: ProjectErrorBar | null;
}

function admissionOf(
  fact: WriteDomainFact,
  hasApprovalRecord: boolean,
  approvalMismatch: boolean,
  redeliver: () => void,
): WriteDomainAdmission {
  return {
    fact,
    writable: isProjectWritableOf({
      hasApprovalRecord,
      approvalMismatch,
      hostGrant: fact.grant,
    }),
    needsApproval: !hasApprovalRecord || approvalMismatch,
    error:
      fact.grant === 'refused'
        ? { message: writeDomainRefusedMessage(fact), action: writeDomainFixAction(redeliver) }
        : null,
  };
}

export interface AdmitProjectWriteDomainDeps {
  readonly dir: string;
  /** 桌面壳（有宿主那道准入门）才登记；浏览器开发壳传 false ⇒ 事实记为 `not-hosted` */
  readonly hosted: boolean;
  readonly register: (root: string) => Promise<void>;
  /** 读 TS 侧批准记录在不在（那一份与宿主那份是两码事，这里只读自己这半边） */
  readonly hasApprovalRecord: () => Promise<boolean>;
  /** 批准记录与新提议不一致（内核在 open() 期间同步报的事件） */
  readonly approvalMismatch: boolean;
  /** 出路动作的执行体：调用方绑到最新一份实现，动作挂在屏上多久都叫得响 */
  readonly redeliver: () => void;
}

/**
 * 开项目那一刻的写域交付（原 `register_write_domain` 那一步 + 可写态判定，收成一个可注入结果）。
 * 顺序照旧：先登记、再读批准记录——登记结果作为**独立事实**参与可写判定，
 * 而不是像以前那样被后面那行 `setWritable(approved !== null)` 直接翻回 true。
 */
export async function admitProjectWriteDomain(deps: AdmitProjectWriteDomainDeps): Promise<WriteDomainAdmission> {
  let grant: HostWriteDomainGrant = 'not-hosted';
  let reason: string | null = null;
  if (deps.hosted) {
    const outcome = await registerProjectWriteDomain({ dir: deps.dir, register: deps.register });
    grant = outcome.kind === 'refused' ? 'refused' : 'granted';
    reason = outcome.reason;
  }
  const approved = await deps.hasApprovalRecord();
  return admissionOf({ dir: deps.dir, grant, reason }, approved, deps.approvalMismatch, deps.redeliver);
}

export interface RedeliverProjectWriteDomainDeps {
  readonly dir: string;
  /** 原生目录对话框（**对话框即授权**）：返回 null = 作者取消；选定项由宿主登记为准入根 */
  readonly chooseDirectory: (title: string) => Promise<string | null>;
  readonly register: (root: string) => Promise<void>;
  readonly hasApprovalRecord: () => Promise<boolean>;
  /**
   * 不一致事件只在 `open()` 期间同步发出，重交付这一刻没有新的事件可吃 ⇒ 按无冲突算
   *（要弹确认与否仍由 `needsApproval` 说，不在这里替作者做主）
   */
  readonly approvalMismatch: boolean;
  readonly redeliver: () => void;
}

/**
 * 出路：弹一次系统选目录框 → 作者把这个项目文件夹重新交付给宿主 → 再登记一次。
 * - 取消 ⇒ 返回 null：调用方什么都不改，错误条仍在原地；
 * - 选了别的目录 ⇒ 前端不二次判定，照项目根再登记一次，宿主的准入门自己拒 ⇒ 错误条仍在、
 *   按钮仍在（不复制那份判定，免得又长出第三份答案）。
 */
export async function redeliverProjectWriteDomain(
  deps: RedeliverProjectWriteDomainDeps,
): Promise<WriteDomainAdmission | null> {
  let outcome: WriteDomainOutcome;
  try {
    const picked = await deps.chooseDirectory(writeDomainRedeliverLabel);
    if (picked === null) return null; // 取消：什么都不改，错误条仍在原地
    outcome = await registerProjectWriteDomain({ dir: deps.dir, register: deps.register });
  } catch (e: unknown) {
    // 对话框 / IPC 自己抛错（不是"作者选了别的目录"那种被拒）：按"这一趟仍没交付成功"处理
    outcome = { kind: 'refused', reason: errorText(e) };
  }
  const grant: HostWriteDomainGrant = outcome.kind === 'refused' ? 'refused' : 'granted';
  return admissionOf(
    { dir: deps.dir, grant, reason: outcome.reason },
    await deps.hasApprovalRecord(),
    deps.approvalMismatch,
    deps.redeliver,
  );
}
