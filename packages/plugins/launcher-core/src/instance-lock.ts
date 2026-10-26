/**
 * 每实例写盘单飞锁（规格 §10.1「`applyInstall` 每实例**单飞**；同一实例同时只允许一个
 * 内容 / 插件变更任务」）。
 *
 * ## 为什么是一把，不是两把
 *
 * 内容包（`content-manager.ts`）与插件（`plugin-manager.ts`）的门禁不同，**落点相同**：
 * 都经宿主的 `launcher_content_apply` 往同一棵游戏根写盘、都改写同一份 `ownership.json`。
 * 两边各自持锁时，`content.apply` 与 `plugins.apply` 可以在同一实例上同时跑，ownership
 * 互相踩（后写的一方把先写的一方的归属当成「孤儿」）。规格要的是**每实例一把**，
 * 故锁的真源收口在本文件：谁要写盘，先经 `acquire`；一个实例同时只有一张票。
 *
 * 第二把锁（插件侧那份）已删除，不保留「双保险」——两套判据就会有两套缝隙。
 *
 * ## 边界：进程侧的单实例锁**不并入**
 *
 * `process-supervisor.ts` 的 `start` 单飞回答的是「**能不能起进程**」：判据是状态机
 * （`starting` / `running` / `stopping` 一律 `LAUNCHER_INSTANCE_BUSY`），由宿主进程句柄与
 * `running.lock` 兜底。本锁回答的是「**能不能写盘**」。两者是不同的问题：
 * 游戏完全可以在跑着的时候被安排下一次安装（§10.3 要求的是「写盘前先停」，不是「不许起」），
 * 合并会让「停-装-起」这条正常流程卡死在自己的锁上。故 `LAUNCHER_INSTANCE_BUSY`（进程）
 * 与 `LAUNCHER_TASK_BUSY`（写盘）各管一段，互不代替。
 *
 * ## 与 `TaskCenter` 的关系（不造第二套「进行中」判据）
 *
 * `TaskCenterImpl` 只存任务快照（状态 / 进度 / 取消通道），**没有**「每实例进行中」的判据；
 * 本锁因此是唯一判据，只向任务中心借两件事：
 * - **终态释放**：订阅 `subscribe`，任务一落 `succeeded` / `failed` / `cancelled` 就按
 *   `taskId` 释放（异步任务唯一的收尾出口，宿主事件与命令返回值两条路都汇到同一处）；
 * - 快照落账：`attachTask` 把宿主返回的任务 id 记到票上，拒绝话术里才好说「被哪条任务挡着」。
 *
 * ## 释放的三条路径（都必达）
 *
 * 1. **成功**：宿主同步返回 `succeeded` ⇒ `runTask` 在落票处以 `release(handle)` 收尾；
 *    异步成功 ⇒ 终态订阅按 `taskId` 释放。
 * 2. **失败**：宿主命令抛错 ⇒ `catch` 里 `release`；任务落 `failed` ⇒ 终态订阅释放。
 * 3. **取消**：`cancelHostTask` 把任务落 `cancelled`（`adopt`）⇒ 终态订阅释放。
 *
 * `release` 收**票**（handle）而不是裸 `instanceId`：迟到的终态 / 重复释放不会推到
 * 别人的票（同一实例释放后又被别人拿到，旧 handle 必然 no-op）。
 */

import type { LauncherError, LauncherTask, TaskCenter, Unsubscribe } from '@kojo/plugin-api';
import { launcherError } from './errors';
import { isTerminalTaskState } from './task-center';

/** 谁在写盘。只用于人话（拒绝话术说「内容变更」还是「插件变更」），不参与判据。 */
export type InstanceLockKind = 'content' | 'plugin';

/** 持有者的类别标签（按**持有者**说，不按请求方说：用户要知道「谁在占着」） */
const HOLDER_LABELS: Readonly<Record<InstanceLockKind, string>> = {
  content: '内容变更',
  plugin: '插件变更',
};

export interface InstanceLockRequest {
  /** 正在执行的那份计划（拒绝话术里点名） */
  readonly planId?: string | null;
  /** 已知的任务 id（多数情况落锁时还没有，由 `attachTask` 补上） */
  readonly taskId?: string | null;
  /** 本次请求的人话名（如「插件安装」）；进 detail，让用户分清「谁挡的、挡的是谁」 */
  readonly action?: string | null;
}

/**
 * 一张持有中的票。只含 `instanceId` + 单调 `token`：释放 / 挂任务都要凭它，
 * 裸 `instanceId` 释放会把「释放后又被别人拿到」的那张票误删。
 */
export interface InstanceLockHandle {
  readonly instanceId: string;
  readonly token: number;
}

/** 当前票的只读快照（诊断 / 测试读数） */
export interface InstanceLockSnapshot {
  readonly instanceId: string;
  readonly kind: InstanceLockKind;
  readonly planId: string | null;
  readonly taskId: string | null;
  readonly action: string | null;
}

export interface InstanceLockOptions {
  /** 任务中心（只用终态订阅：任务一落终态即按 `taskId` 释放） */
  readonly tasks: Pick<TaskCenter, 'subscribe'>;
}

interface MutableHold {
  readonly instanceId: string;
  readonly kind: InstanceLockKind;
  readonly token: number;
  readonly planId: string | null;
  readonly action: string | null;
  taskId: string | null;
}

export class InstanceLock {
  private readonly holds = new Map<string, MutableHold>();
  private readonly unsubscribe: Unsubscribe;
  private tokenSeq = 0;

  constructor(options: InstanceLockOptions) {
    // 终态订阅是「异步任务释放」的唯一出口；同步返回终态的那条路由调用方 release。
    this.unsubscribe = options.tasks.subscribe((task: LauncherTask) => {
      if (isTerminalTaskState(task.state)) this.releaseByTask(task.id);
    });
  }

  /**
   * 拿票。已在别人手里 ⇒ 抛 `LAUNCHER_TASK_BUSY`（**不排队**：排队会让 UI 以为
   * 「点了两次就是装两次」）。
   *
   * 码的选择：`LAUNCHER_TASK_BUSY`（「任务正在执行」）。另一个既有码
   * `LAUNCHER_INSTANCE_BUSY` 的话术是「该实例正在启动或停止」，那是进程状态机的事
   * （见文件头边界），拿它说「正在写盘」会把用户引到错误的排障方向。
   */
  acquire(
    instanceId: string,
    kind: InstanceLockKind,
    request: InstanceLockRequest = {},
  ): InstanceLockHandle {
    this.assertFree(instanceId, kind, request);
    const token = ++this.tokenSeq;
    this.holds.set(instanceId, {
      instanceId,
      kind,
      token,
      planId: request.planId ?? null,
      taskId: request.taskId ?? null,
      action: request.action ?? null,
    });
    return { instanceId, token };
  }

  /** 只判不拿（门禁前段先看一眼，失败得快一点；真正落票仍在 `runTask` 的落锁点） */
  assertFree(instanceId: string, _kind: InstanceLockKind, request: InstanceLockRequest = {}): void {
    const hold = this.holds.get(instanceId);
    // 判据只看「有没有人在写盘」；请求方的 kind 不参与判定（同一把锁，两者等价）
    if (!hold) return;
    throw this.busyError(hold, request);
  }

  /** 把宿主返回的任务 id 记到票上（票已释放 / 已被顶替 ⇒ 迟到的任务不复活锁） */
  attachTask(handle: InstanceLockHandle, taskId: string): void {
    const hold = this.owned(handle);
    if (hold) hold.taskId = taskId;
  }

  /** 还票（成功 / 失败 / 抛异常三条路径都走这里；重复释放是 no-op） */
  release(handle: InstanceLockHandle): void {
    if (this.owned(handle)) this.holds.delete(handle.instanceId);
  }

  /** 按任务 id 释放（终态订阅用：取消 / 异步成功 / 异步失败都汇到这一条） */
  releaseByTask(taskId: string): void {
    for (const [instanceId, hold] of [...this.holds]) {
      if (hold.taskId === taskId) this.holds.delete(instanceId);
    }
  }

  /** 该实例当前有没有人在写盘 */
  isBusy(instanceId: string): boolean {
    return this.holds.has(instanceId);
  }

  /** 当前票的只读快照（`null` = 空闲） */
  get(instanceId: string): InstanceLockSnapshot | null {
    const hold = this.holds.get(instanceId);
    if (!hold) return null;
    return {
      instanceId: hold.instanceId,
      kind: hold.kind,
      planId: hold.planId,
      taskId: hold.taskId,
      action: hold.action,
    };
  }

  /** 持有张数（诊断读数；`dispose` 后归零） */
  get size(): number {
    return this.holds.size;
  }

  /** 关订阅并清空锁表（解锁由持有者的 `release` / 终态订阅负责，不靠 dispose 兜） */
  dispose(): void {
    this.unsubscribe();
    this.holds.clear();
  }

  /* ------------------------------ 内部 ------------------------------ */

  private owned(handle: InstanceLockHandle): MutableHold | null {
    const hold = this.holds.get(handle.instanceId);
    if (!hold || hold.token !== handle.token) return null;
    return hold;
  }

  private busyError(hold: MutableHold, request: InstanceLockRequest): LauncherError {
    const holder = hold.planId ? `计划 ${hold.planId}` : HOLDER_LABELS[hold.kind];
    const parts = [
      `实例 ${hold.instanceId} 正在进行${holder}${hold.taskId ? `（任务 ${hold.taskId}）` : ''}`,
    ];
    if (hold.action) parts.push(`当前操作：${hold.action}`);
    if (request.action) parts.push(`本次请求（${request.action}）被拒`);
    return launcherError('LAUNCHER_TASK_BUSY', {
      message: `该实例已有${HOLDER_LABELS[hold.kind]}正在进行中，请等它结束`,
      detail: parts.join(' · '),
    });
  }
}
