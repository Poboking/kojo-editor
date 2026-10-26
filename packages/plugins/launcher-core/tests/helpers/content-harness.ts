/**
 * 内容包测试基座：把 `ContentManagerImpl` 接到一台假内容宿主 + 真任务中心 + 真进程监督上。
 *
 * 只做「接线 + 固定时钟」，不伪造业务：断言的点全在 `src/content-manager.ts` 与
 * `tests/helpers/fake-host.ts` 的那台假宿主之间。
 */

import type { LauncherInstance } from '@kojo/plugin-api';
import { ContentManagerImpl } from '../../src/content-manager';
import { ProcessSupervisorImpl } from '../../src/process-supervisor';
import { TaskCenterImpl } from '../../src/task-center';
import {
  FakeContentHost,
  makeContentRoot,
  makeInstance,
  makeStatus,
} from './fake-host';

/** 固定时钟：`2026-10-26T12:00:00Z`（计划默认过期时间远在其后） */
export const NOW = Date.parse('2026-10-26T12:00:00.000Z');

export interface ContentHarness {
  readonly host: FakeContentHost;
  readonly tasks: TaskCenterImpl;
  readonly processes: ProcessSupervisorImpl;
  readonly manager: ContentManagerImpl;
  readonly instance: LauncherInstance;
  /** 把实例的本地进程读数置成运行中 / 已退出（`stop` 是否真发宿主命令靠它） */
  setRunning(running: boolean): void;
  /** 推进时钟（「预检与确认之间放久了」这类用例用它） */
  advance(ms: number): void;
}

export interface ContentHarnessOptions {
  readonly instance?: Partial<LauncherInstance>;
}

export function makeContentHarness(options: ContentHarnessOptions = {}): ContentHarness {
  const instance = makeInstance({
    id: 'i1',
    gameId: 'demo',
    isolation: 'copy',
    contentRoots: [
      makeContentRoot('script'),
      makeContentRoot('data', { kind: 'data', accepts: ['data', 'script'] }),
    ],
    ...options.instance,
  });
  const host = new FakeContentHost();
  host.instances = [instance];
  let clock = NOW;
  const now = (): number => clock;
  const tasks = new TaskCenterImpl({ throttleMs: 0, now });
  const processes = new ProcessSupervisorImpl({ host, now });
  const manager = new ContentManagerImpl({
    host,
    tasks,
    processes,
    getInstance: async (instanceId) =>
      host.instances.find((item) => item.id === instanceId) ?? null,
    now,
  });

  return {
    host,
    tasks,
    processes,
    manager,
    instance,
    setRunning(running: boolean): void {
      processes.applySnapshot([
        makeStatus('i1', {
          state: running ? 'running' : 'idle',
          pid: running ? 4242 : null,
          sessionId: running ? 's1' : null,
          startedAt: running ? '2026-10-26T11:59:00.000Z' : null,
        }),
      ]);
    },
    advance(ms: number): void {
      clock += ms;
    },
  };
}
