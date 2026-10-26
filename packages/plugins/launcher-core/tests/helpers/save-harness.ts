/**
 * 存档测试的小台架：假宿主 + 真任务中心 + 真进程监督 + `SaveManagerImpl`。
 *
 * 刻意**不** mock `TaskCenter` / `ProcessSupervisor`：本批要证的正是「存档编排与这两个服务
 * 的接缝」（任务登记、取消转命令、恢复前停游戏），换成假对象就把要证的东西证掉了。
 */

import type { LauncherInstance, SaveLayoutSpec, SaveRootSpec, ZipContractLimits } from '@kojo/plugin-api';
import { ProcessSupervisorImpl } from '../../src/process-supervisor';
import { SaveManagerImpl } from '../../src/save-manager';
import { TaskCenterImpl } from '../../src/task-center';
import { FakeSaveHost } from './fake-save-host';

/** 一个存档根声明（adapter 侧快照） */
export function saveRoot(id: string, label: string, writableInShared = true): SaveRootSpec {
  return { id, label, relativePath: id, writableInShared };
}

/** 常见布局：只认 `.sav`，显示名去扩展名 */
export function saveLayout(roots: readonly SaveRootSpec[]): SaveLayoutSpec {
  return { roots, listRule: { extensions: ['.sav'], labelFromFileName: true } };
}

export interface SaveHarnessOptions {
  readonly host?: FakeSaveHost;
  readonly instance?: LauncherInstance;
  readonly layout?: SaveLayoutSpec | null;
  readonly keep?: number;
  readonly planTtlMs?: number;
  readonly importLimits?: ZipContractLimits;
}

export interface SaveHarness {
  readonly host: FakeSaveHost;
  readonly manager: SaveManagerImpl;
  readonly tasks: TaskCenterImpl;
  readonly processes: ProcessSupervisorImpl;
  /** 可推进的钟（计划过期 / 任务时间戳都读它） */
  readonly clock: { now: number };
}

export function makeSaveHarness(options: SaveHarnessOptions = {}): SaveHarness {
  const host = options.host ?? new FakeSaveHost();
  const clock = { now: Date.UTC(2026, 9, 26, 0, 0, 0) };
  let seq = 0;
  const tasks = new TaskCenterImpl({
    now: () => clock.now,
    newId: () => `t-${++seq}`,
    throttleMs: 0,
  });
  const processes = new ProcessSupervisorImpl({ host });
  const layout = options.layout ?? null;
  const manager = new SaveManagerImpl({
    host,
    getInstance: async (instanceId) => host.instances.find((item) => item.id === instanceId) ?? null,
    saveLayoutOf: () => layout ?? undefined,
    tasks,
    processes,
    now: () => clock.now,
    ...(options.keep === undefined ? {} : { keep: options.keep }),
    ...(options.planTtlMs === undefined ? {} : { planTtlMs: options.planTtlMs }),
    ...(options.importLimits === undefined ? {} : { importLimits: options.importLimits }),
  });
  // 与装配处同一条接线：宿主推来的任务事件进任务中心，取消转 `launcher_task_cancel`
  host.onTask((event) => {
    tasks.adopt(event.task, { onCancel: () => host.taskCancel(event.task.id) });
  });
  return { host, manager, tasks, processes, clock };
}

/** 让已排队的微任务/定时器跑完（宿主在命令内部先推一条 running 任务事件） */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
