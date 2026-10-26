/**
 * 启动器服务入口（L5 骨架批 + L10 创建流）：把「内核里有没有 `launcher.service`」
 * 与「有没有宿主桥 / 启动面」这三件事收成**有分档的结果**，视图只渲染结果，不自己猜。
 *
 * 三条纪律：
 * 1. **装配走组合根**：`launcher-core` 的装载唯一入口是 `bootstrap.ts::ensureLauncherPlugin`
 *    （字面量动态 import，PS-10 开机图零新增文件）。本模块只调用它，不另开一条装载边。
 * 2. **不吞异常**：装载/初始化抛出的东西原样带出，由 `describeFailure` 转成可渲染读数。
 * 3. **缺席要说清是哪一块**：插件没进表 / 激活报错 / 缺宿主桥各有各的人话
 *    （`describeServiceGap`），不许一句「服务不可用」糊过去。
 *
 * L10 追加的三条读数都不是新能力，只是把已有对象**取出来**：
 * - `resolveLauncherHost`：`kernel.launcherHost`（服务键 `kernel.launcher` 的实现）——
 *   目录对话框与信任确认框都只从这一条路走（对话框即授权，视图拿不到可编程授权入口）；
 * - `resolveLaunchSurfaces`：`game.adapter` 槽位里**带 `launch` 的那些 adapter**——
 *   游戏侧启动知识（哪些程序可启动）全在 adapter，本层只认字段名；
 * - `probeCandidates`：对**已被批准的源根**调 `launch.probe`，把候选展成卡片。
 *   一个 adapter 探测失败不吃掉别的 adapter 的结果（逐条记 failure，人话带出来）。
 */

import type { Kernel } from '@kojo/kernel';
import type {
  GameAdapter,
  GameLaunchAdapter,
  LauncherHostBridge,
  LauncherService,
  PluginStateRecord,
} from '@kojo/plugin-api';
import { KernelServices, WellKnownServices } from '@kojo/plugin-api';
import { ensureLauncherPlugin } from '../bootstrap';
import {
  candidateCards,
  describeFailure,
  describeServiceGap,
  thrownMessage,
  type CandidateCard,
  type FailureView,
  type LauncherPluginGap,
} from './model';

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

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 宿主桥（目录对话框 / 信任确认框的**唯一**入口）
 * ══════════════════════════════════════════════════════════════════════════════ */

/**
 * 取宿主桥。
 *
 * 优先 `kernel.launcherHost`（内核侧同一条透传，类型上恒存在）；拿不到再问服务键
 * `kernel.launcher`。两处都空 = 这个载体连桥都没挂（测试壳 / 极早启动相位），
 * 返回 `null` 让调用点说人话，而不是抛一个不可读的 TypeError。
 *
 * **平台能力缺席不在这里判**：Web 调试宿也挂着同一枚实现，方法一调就抛
 * 「当前平台没有启动器能力」——那句话是给人看的，照原样进错误条（`describeFailure`）。
 */
export function resolveLauncherHost(kernel: Kernel | null): LauncherHostBridge | null {
  if (kernel === null) return null;
  const direct = (kernel as { launcherHost?: LauncherHostBridge }).launcherHost;
  if (direct !== undefined) return direct;
  return kernel.services.tryGet<LauncherHostBridge>(KernelServices.LauncherHost) ?? null;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 启动面（`game.adapter` 槽位里带 `launch` 的那些 adapter）
 * ══════════════════════════════════════════════════════════════════════════════ */

/** 一枚可用的启动面：adapter 身份 + 它的 `GameLaunchAdapter`（只读使用） */
export interface LaunchSurface {
  /**
   * 适配器 id。
   *
   * 口径来自 `launcher-core/src/index.ts::adapterOf`：它用 `activeGameAdapter(…, adapterId)`
   * 找 adapter，而那个判据是 `adapter.gameId === adapterId` ⇒ 契约里的 `adapterId`
   * **就是** adapter 的 `gameId`。两处写同一个值，不另立第二套身份。
   */
  readonly adapterId: string;
  readonly gameId: string;
  /** 游戏显示名（候选卡片的「哪款游戏」列） */
  readonly displayName: string;
  readonly launch: GameLaunchAdapter;
}

/**
 * 取所有提供启动能力的 adapter。
 *
 * 一个都没有 ⇒ 返回 `[]`，视图据此给「没有 adapter 启动面」的分档提示
 * （`NO_LAUNCH_SURFACE_TEXT`）；这不是错误，是契约 §6.1 的缺省语义。
 *
 * `kernel.slots` 在极早相位可能还没就绪 ⇒ 查询抛错按「没有启动面」处理并返回 `[]`
 * （与「插件还没装」同一档；不编造候选）。
 */
export function resolveLaunchSurfaces(kernel: Kernel | null): readonly LaunchSurface[] {
  if (kernel === null) return [];
  let contributions: readonly { readonly adapter: GameAdapter }[];
  try {
    contributions = kernel.slots.query('game.adapter');
  } catch {
    return [];
  }
  const surfaces: LaunchSurface[] = [];
  for (const contribution of contributions) {
    const launch = contribution.adapter.launch;
    if (launch === undefined) continue;
    surfaces.push({
      adapterId: contribution.adapter.gameId,
      gameId: contribution.adapter.gameId,
      displayName: contribution.adapter.displayName,
      launch,
    });
  }
  return surfaces;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * L10 · 探测候选（对**已被批准的源根**调 adapter.probe）
 * ══════════════════════════════════════════════════════════════════════════════ */

export interface ProbeOutcome {
  readonly cards: readonly CandidateCard[];
  /** 探测失败的 adapter（逐条记；一条失败不吃掉另一条的候选） */
  readonly failures: readonly { readonly adapterId: string; readonly message: string }[];
}

/**
 * 对 `sourceRoot` 逐个 adapter 调 `probe`。
 *
 * `sourceRoot` 只能来自 `host.pickSourceRoot` 的回执（对话框即授权）：本函数**不做
 * 任何路径拼装**，也不判断目录是否「像」游戏目录——那是 adapter 的判据。
 *
 * 串行探测而不是并行：候选顺序就是界面顺序（adapter 用「顺序 = 推荐序」表达推荐位），
 * 并行会让多 adapter 的候选交错，顺序不再可复现。探测是一次目录列举，串行代价可以接受。
 */
export async function probeCandidates(
  surfaces: readonly LaunchSurface[],
  sourceRoot: string,
): Promise<ProbeOutcome> {
  const cards: CandidateCard[] = [];
  const failures: { adapterId: string; message: string }[] = [];
  for (const surface of surfaces) {
    try {
      const candidates = await surface.launch.probe(sourceRoot);
      cards.push(
        ...candidateCards(surface.adapterId, surface.gameId, surface.displayName, candidates),
      );
    } catch (error) {
      failures.push({ adapterId: surface.adapterId, message: thrownMessage(error) });
    }
  }
  return { cards, failures };
}
