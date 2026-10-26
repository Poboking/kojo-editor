/**
 * 启动器服务入口（L5 骨架批）：把「内核里有没有 `launcher.service`」这一件事
 * 收成**一个有分档的结果**，视图只渲染结果，不自己猜。
 *
 * 三条纪律：
 * 1. **装配走组合根**：`launcher-core` 的装载唯一入口是 `bootstrap.ts::ensureLauncherPlugin`
 *    （字面量动态 import，PS-10 开机图零新增文件）。本模块只调用它，不另开一条装载边。
 * 2. **不吞异常**：装载/初始化抛出的东西原样带出，由 `describeFailure` 转成可渲染读数。
 * 3. **缺席要说清是哪一块**：插件没进表 / 激活报错 / 缺宿主桥各有各的人话
 *    （`describeServiceGap`），不许一句「服务不可用」糊过去。
 */

import type { Kernel } from '@kojo/kernel';
import type { LauncherService, PluginStateRecord } from '@kojo/plugin-api';
import { WellKnownServices } from '@kojo/plugin-api';
import { ensureLauncherPlugin } from '../bootstrap';
import { describeFailure, describeServiceGap, type FailureView, type LauncherPluginGap } from './model';

/** 启动器核心插件的 id（与 `createLauncherPlugin()` 的 `id` 同一字面量） */
export const LAUNCHER_PLUGIN_ID = 'launcher-core';

/** 服务解析结果：要么真的拿到了服务，要么给出**可渲染**的缺席原因 */
export type LauncherResolution =
  | { readonly kind: 'ready'; readonly service: LauncherService }
  | { readonly kind: 'unavailable'; readonly gap: string; readonly failure: FailureView | null };

/** 插件表里的启动器读数（不在表里 = null） */
export function launcherPluginGap(kernel: Kernel): LauncherPluginGap | null {
  const record = kernel.plugins
    .list()
    .find((plugin: PluginStateRecord): boolean => plugin.id === LAUNCHER_PLUGIN_ID);
  if (record === undefined) return null;
  return {
    status: record.status,
    missing: record.missing ?? [],
    error: record.error ?? null,
  };
}

/**
 * 取 `launcher.service`；缺席时先跑一次组合根装配（幂等），再取一次。
 *
 * 为什么不在视图里直接 `import` 插件：那样会绕开 `bootstrap.ts` 这一处装配点，
 * 开机图判据（ps10）也就看不见这条边了。
 */
export async function resolveLauncherService(kernel: Kernel | null): Promise<LauncherResolution> {
  if (kernel === null) {
    return {
      kind: 'unavailable',
      gap: '编辑器内核还没就绪（窗口仍在启动）。等欢迎页可操作后再打开一次。',
      failure: null,
    };
  }

  const existing = kernel.services.tryGet<LauncherService>(WellKnownServices.Launcher);
  if (existing !== undefined) return { kind: 'ready', service: existing };

  let thrown: unknown = null;
  try {
    await ensureLauncherPlugin(kernel);
  } catch (error) {
    thrown = error;
  }

  const service = kernel.services.tryGet<LauncherService>(WellKnownServices.Launcher);
  if (service !== undefined) return { kind: 'ready', service };

  return {
    kind: 'unavailable',
    gap: describeServiceGap(launcherPluginGap(kernel)),
    failure: thrown === null ? null : describeFailure(thrown, 'service'),
  };
}
